-- Phase 7 restore drill.  This is deliberately an import into an EMPTY
-- brewery only.  It is for a separate Supabase test project, never for
-- replacing a live brewery.  The archive remains an operator download.

-- This is deliberately a server-side flag.  A reset production brewery is
-- still production and must never become an import target simply because it
-- happens to be empty.  Set this only in a separate test project/brewery:
--   update public.breweries set is_restore_test_target=true where id='<test brewery uuid>';
alter table public.breweries
  add column if not exists is_restore_test_target boolean not null default false;

create table if not exists public.backup_restore_imports (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  operator_id uuid not null references public.operators(id),
  source_brewery_id uuid,
  payload_checksum text not null check (payload_checksum ~ '^[0-9a-f]{64}$'),
  schema_version integer not null,
  row_counts jsonb not null default '{}'::jsonb,
  imported_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);
create index if not exists backup_restore_imports_brewery_idx on public.backup_restore_imports(brewery_id, imported_at desc);
alter table public.backup_restore_imports enable row level security;
revoke all on public.backup_restore_imports from anon, authenticated;
grant select on public.backup_restore_imports to authenticated;
drop policy if exists "read own backup restore imports" on public.backup_restore_imports;
create policy "read own backup restore imports" on public.backup_restore_imports
  for select to authenticated using (brewery_id=public.current_brewery_id());

-- A restore is a single transaction, but historical finished batches must not
-- replay their old physical "occupied" transitions one by one.  The local
-- transaction setting is only set by the SECURITY DEFINER restore RPC below;
-- regular production inserts retain the normal readiness checks and events.
create or replace function public.validate_batch_fermenter()
returns trigger language plpgsql set search_path='' as $$
declare vessel public.fermenters;
begin
  if current_setting('app.restore_import',true)='on' then return new; end if;
  select * into vessel from public.fermenters where id=new.fermenter_id for update;
  if vessel.id is null or vessel.vessel_type<>'fermenter' then raise exception 'Batch must use a fermentation vessel'; end if;
  if new.volume_tons>vessel.capacity_tons then raise exception 'Batch volume exceeds vessel capacity'; end if;
  if tg_op='INSERT' or new.fermenter_id is distinct from old.fermenter_id then
    if vessel.cleanliness_status not in ('free_clean','legacy_ready') then raise exception 'VESSEL_NOT_READY: tvertne ir netīra vai nav gatava'; end if;
  end if;
  return new;
end $$;

create or replace function public.mark_vessel_occupied_after_batch()
returns trigger language plpgsql security definer set search_path='' as $$
declare op uuid:=nullif(current_setting('app.operator_id',true),'')::uuid; brewery uuid;
begin
  if current_setting('app.restore_import',true)='on' then return new; end if;
  select brewery_id into brewery from public.fermenters where id=new.fermenter_id;
  update public.fermenters set cleanliness_status='occupied',cleaning_version=cleaning_version+1 where id=new.fermenter_id;
  insert into public.vessel_cleaning_events(brewery_id,fermenter_id,related_batch_id,operator_id,event_type)
  values(brewery,new.fermenter_id,new.id,op,'occupied');
  return new;
end $$;

create or replace function public.update_vessels_after_packaging_change()
returns trigger language plpgsql security definer set search_path='' as $$
declare b public.batches; source_vessel public.fermenters; brite public.fermenters; op uuid:=nullif(current_setting('app.operator_id',true),'')::uuid; filtered_cycles integer; expected_cycles integer;
begin
  -- The archive contains a final physical-vessel snapshot, applied by the
  -- restore RPC after all history has been inserted.  Replaying old packaging
  -- rows must not make Dzidra/source vessels appear occupied midway through
  -- that history.
  if current_setting('app.restore_import',true)='on' then return new; end if;
  select * into b from public.batches where id=new.batch_id for update;
  select * into source_vessel from public.fermenters where id=b.fermenter_id for update;
  select * into brite from public.fermenters where brewery_id=b.brewery_id and number=13 for update;
  if tg_op='INSERT' then
    if brite.id is null or brite.cleanliness_status not in ('free_clean','legacy_ready') then
      raise exception 'VESSEL_NOT_READY: Dzidra ir netīra vai nav gatava';
    end if;
    update public.fermenters set cleanliness_status='occupied',cleaning_version=cleaning_version+1 where id=brite.id;
    insert into public.vessel_cleaning_events(brewery_id,fermenter_id,related_batch_id,operator_id,event_type)
      values(b.brewery_id,brite.id,b.id,op,'occupied');
    select count(*) into filtered_cycles from public.packaging_runs where batch_id=b.id and deleted_at is null;
    expected_cycles:=ceil(b.volume_tons/4.0);
    if filtered_cycles>=expected_cycles and b.fermenter_released_at is null then
      update public.batches set fermenter_released_at=new.filtered_at where id=b.id;
      update public.fermenters set cleanliness_status='free_dirty',cleaning_version=cleaning_version+1 where id=source_vessel.id;
      insert into public.vessel_cleaning_events(brewery_id,fermenter_id,related_batch_id,operator_id,event_type,details)
        values(b.brewery_id,source_vessel.id,b.id,op,'released_dirty',jsonb_build_object(
          'completed_filter_cycles',filtered_cycles,'expected_filter_cycles',expected_cycles,
          'estimated_heel_liters',case when b.volume_tons>4 then 350 else 200 end));
    end if;
  elsif old.status='filtered' and new.status='packaged' then
    update public.fermenters set cleanliness_status='free_dirty',cleaning_version=cleaning_version+1 where id=brite.id;
    insert into public.vessel_cleaning_events(brewery_id,fermenter_id,related_batch_id,operator_id,event_type)
      values(b.brewery_id,brite.id,b.id,op,'released_dirty');
  end if;
  return new;
end $$;

-- Import a canonical JSON payload only when the current brewery contains no
-- operational records.  Existing vessel definitions and the currently signed
-- in operator are allowed: they are mapped by vessel number/operator name.
create or replace function public.restore_backup_to_empty_test_brewery(
  session_token text,
  confirmation text,
  canonical_payload text,
  expected_checksum text
) returns public.backup_restore_imports
language plpgsql security definer set search_path='' as $$
declare
  op uuid:=public.validate_operator_session(session_token);
  brewery uuid:=public.current_brewery_id();
  payload jsonb;
  entities jsonb;
  source_brewery uuid;
  table_name text;
  archive_count integer;
  target_count integer;
  row jsonb;
  result public.backup_restore_imports;
  target_operator uuid;
  target_fermenter uuid;
  target_is_test boolean;
begin
  if op is null then raise exception 'Operatora sesija nav derīga'; end if;
  if confirmation <> 'ATJAUNOT TESTĀ' then raise exception 'Nepareizs atjaunošanas apstiprinājums'; end if;
  if expected_checksum !~ '^[0-9a-f]{64}$' then raise exception 'Nederīga SHA-256 pārbaudes summa'; end if;
  if encode(extensions.digest(convert_to(canonical_payload,'UTF8'),'sha256'),'hex') <> expected_checksum then
    raise exception 'SHA-256 pārbaude neizdevās';
  end if;
  payload:=canonical_payload::jsonb;
  if payload->>'format' <> 'brewtracker-pro-backup' or (payload->>'schemaVersion')::integer <> 1 then
    raise exception 'Neatbalstīta rezerves kopijas versija';
  end if;
  entities:=payload->'entities';
  if entities is null or jsonb_typeof(entities) <> 'object' then raise exception 'Rezerves kopijā nav datu sadaļas'; end if;
  foreach table_name in array array['beer_types','fermenters','operators','batches','measurements','process_actions','packaging_runs','work_items','work_item_events','vessel_cleaning_cycles','vessel_cleaning_events','volume_events','batch_carbonation_advisories','audit_log'] loop
    if jsonb_typeof(entities->table_name) <> 'array' then raise exception 'Trūkst tabulas: %', table_name; end if;
  end loop;
  source_brewery:=nullif(payload->'brewery'->>'id','')::uuid;
  if source_brewery is null then raise exception 'Rezerves kopijai trūkst darītavas identifikatora'; end if;
  if source_brewery=brewery then raise exception 'Šo importu drīkst veikt tikai atsevišķā testa darītavā'; end if;
  select is_restore_test_target into target_is_test from public.breweries where id=brewery for update;
  if coalesce(target_is_test,false) is not true then
    raise exception 'ATJAUNOŠANA_BLOĶĒTA: mērķa darītava nav atzīmēta kā testa vide';
  end if;

  -- The target must be clean.  This protects production from an accidental merge.
  if exists(select 1 from public.batches where brewery_id=brewery)
     or exists(select 1 from public.beer_types where brewery_id=brewery)
     or exists(select 1 from public.work_items where brewery_id=brewery)
     or exists(select 1 from public.volume_events where brewery_id=brewery)
     or exists(select 1 from public.vessel_cleaning_cycles c join public.fermenters f on f.id=c.fermenter_id where f.brewery_id=brewery) then
    raise exception 'ATJAUNOŠANA_BLOĶĒTA: mērķa darītava nav tukša';
  end if;
  if exists(select 1 from public.backup_restore_imports where brewery_id=brewery) then
    raise exception 'ATJAUNOŠANA_BLOĶĒTA: šajā testa darītavā imports jau ir veikts';
  end if;

  create temporary table restore_operator_map(source_id uuid primary key,target_id uuid not null) on commit drop;
  create temporary table restore_fermenter_map(source_id uuid primary key,target_id uuid not null) on commit drop;
  -- The current test-project operator remains usable.  Other historical names
  -- are restored as inactive PIN-less profiles; no credential is imported.
  for row in select value from jsonb_array_elements(entities->'operators') loop
    select id into target_operator from public.operators where brewery_id=brewery and name=row->>'name' limit 1;
    if target_operator is null then
      insert into public.operators(brewery_id,name,pin_hash,is_active,created_at)
      values(brewery,coalesce(nullif(row->>'name',''),'Atjaunots operators'),
        extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),false,
        coalesce(nullif(row->>'created_at','')::timestamptz,now())) returning id into target_operator;
    end if;
    insert into restore_operator_map values((row->>'id')::uuid,target_operator);
  end loop;
  -- Map physical vessels by number.  A standard test project already has them;
  -- if it does not, recreate the exported vessel definition.
  for row in select value from jsonb_array_elements(entities->'fermenters') loop
    select id into target_fermenter from public.fermenters where brewery_id=brewery and number=(row->>'number')::smallint limit 1;
    if target_fermenter is null then
      insert into public.fermenters(brewery_id,number,name,capacity_tons,vessel_type)
      values(brewery,(row->>'number')::smallint,row->>'name',coalesce((row->>'capacity_tons')::numeric,4),coalesce(row->>'vessel_type','fermenter')) returning id into target_fermenter;
    end if;
    insert into restore_fermenter_map values((row->>'id')::uuid,target_fermenter);
  end loop;
  perform set_config('app.operator_id',op::text,true);
  perform set_config('app.change_reason','Atjaunots tukšā testa darītavā',true);
  perform set_config('app.restore_import','on',true);

  for row in select value from jsonb_array_elements(entities->'beer_types') loop
    insert into public.beer_types(id,brewery_id,name,og_target,fg_target,spund_gravity,has_dry_hop,dry_hop_gravity,cooling_gravity,co2_target,created_at,version)
    values((row->>'id')::uuid,brewery,row->>'name',(row->>'og_target')::smallint,(row->>'fg_target')::smallint,(row->>'spund_gravity')::smallint,
      coalesce((row->>'has_dry_hop')::boolean,false),nullif(row->>'dry_hop_gravity','')::smallint,(row->>'cooling_gravity')::smallint,(row->>'co2_target')::numeric,
      coalesce(nullif(row->>'created_at','')::timestamptz,now()),coalesce((row->>'version')::integer,1));
  end loop;
  for row in select value from jsonb_array_elements(entities->'batches') loop
    insert into public.batches(id,brewery_id,beer_type_id,fermenter_id,batch_number,brew_year,sequence_number,volume_tons,brew_date,status,og_target,fg_target,spund_gravity,has_dry_hop,dry_hop_gravity,cooling_gravity,co2_target,created_by,created_at,finished_at,version,deleted_at,deleted_by,delete_reason,fermenter_released_at)
    select (row->>'id')::uuid,brewery,(row->>'beer_type_id')::uuid,m.target_id,row->>'batch_number',(row->>'brew_year')::smallint,(row->>'sequence_number')::smallint,(row->>'volume_tons')::numeric,(row->>'brew_date')::date,(row->>'status')::public.batch_status,
      (row->>'og_target')::smallint,(row->>'fg_target')::smallint,(row->>'spund_gravity')::smallint,coalesce((row->>'has_dry_hop')::boolean,false),nullif(row->>'dry_hop_gravity','')::smallint,(row->>'cooling_gravity')::smallint,(row->>'co2_target')::numeric,o.target_id,
      coalesce(nullif(row->>'created_at','')::timestamptz,now()),nullif(row->>'finished_at','')::timestamptz,coalesce((row->>'version')::integer,1),nullif(row->>'deleted_at','')::timestamptz,od.target_id,row->>'delete_reason',nullif(row->>'fermenter_released_at','')::timestamptz
    from restore_fermenter_map m join restore_operator_map o on o.source_id=(row->>'created_by')::uuid left join restore_operator_map od on od.source_id=nullif(row->>'deleted_by','')::uuid where m.source_id=(row->>'fermenter_id')::uuid;
    if not found then raise exception 'Neizdevās sasaistīt partijas tvertni vai operatoru'; end if;
  end loop;
  -- Actions precede measurements because a measurement can reference its action.
  for row in select value from jsonb_array_elements(entities->'process_actions') loop
    insert into public.process_actions(id,batch_id,operator_id,action_type,performed_at,gravity,ph,temperature_c,pressure_bar,note,client_id,created_at,version,deleted_at,deleted_by,delete_reason)
    select (row->>'id')::uuid,(row->>'batch_id')::uuid,o.target_id,(row->>'action_type')::public.process_action_type,coalesce(nullif(row->>'performed_at','')::timestamptz,now()),(row->>'gravity')::smallint,(row->>'ph')::numeric,(row->>'temperature_c')::numeric,nullif(row->>'pressure_bar','')::numeric,row->>'note',coalesce(nullif(row->>'client_id','')::uuid,gen_random_uuid()),coalesce(nullif(row->>'created_at','')::timestamptz,now()),coalesce((row->>'version')::integer,1),nullif(row->>'deleted_at','')::timestamptz,od.target_id,row->>'delete_reason'
    from restore_operator_map o left join restore_operator_map od on od.source_id=nullif(row->>'deleted_by','')::uuid where o.source_id=(row->>'operator_id')::uuid;
  end loop;
  for row in select value from jsonb_array_elements(entities->'measurements') loop
    insert into public.measurements(id,batch_id,operator_id,measured_at,gravity,ph,temperature_c,pressure_bar,note,client_id,created_at,process_action_id,version,deleted_at,deleted_by,delete_reason,co2_vol,co2_measurement_method,warning_codes,warning_details,anomaly_confirmed_at,anomaly_reason,anomaly_baseline_measurement_id)
    select (row->>'id')::uuid,(row->>'batch_id')::uuid,o.target_id,coalesce(nullif(row->>'measured_at','')::timestamptz,now()),(row->>'gravity')::smallint,(row->>'ph')::numeric,(row->>'temperature_c')::numeric,nullif(row->>'pressure_bar','')::numeric,row->>'note',coalesce(nullif(row->>'client_id','')::uuid,gen_random_uuid()),coalesce(nullif(row->>'created_at','')::timestamptz,now()),nullif(row->>'process_action_id','')::uuid,coalesce((row->>'version')::integer,1),nullif(row->>'deleted_at','')::timestamptz,od.target_id,row->>'delete_reason',nullif(row->>'co2_vol','')::numeric,row->>'co2_measurement_method',coalesce(row->'warning_codes','[]'::jsonb),coalesce(row->'warning_details','[]'::jsonb),nullif(row->>'anomaly_confirmed_at','')::timestamptz,row->>'anomaly_reason',nullif(row->>'anomaly_baseline_measurement_id','')::uuid
    from restore_operator_map o left join restore_operator_map od on od.source_id=nullif(row->>'deleted_by','')::uuid where o.source_id=(row->>'operator_id')::uuid;
  end loop;
  for row in select value from jsonb_array_elements(entities->'packaging_runs') loop
    insert into public.packaging_runs(id,batch_id,run_number,volume_tons,status,filtered_at,packaged_at,gravity,ph,temperature_c,pressure_bar,co2_vol,operator_id,client_id,created_at,centrifuge_liters,source_drawn_liters,brite_received_liters,packaged_liters,volume_override_reason,version,deleted_at,deleted_by,delete_reason)
    select (row->>'id')::uuid,(row->>'batch_id')::uuid,(row->>'run_number')::smallint,(row->>'volume_tons')::numeric,(row->>'status')::public.packaging_run_status,coalesce(nullif(row->>'filtered_at','')::timestamptz,now()),nullif(row->>'packaged_at','')::timestamptz,(row->>'gravity')::smallint,(row->>'ph')::numeric,(row->>'temperature_c')::numeric,nullif(row->>'pressure_bar','')::numeric,nullif(row->>'co2_vol','')::numeric,o.target_id,coalesce(nullif(row->>'client_id','')::uuid,gen_random_uuid()),coalesce(nullif(row->>'created_at','')::timestamptz,now()),nullif(row->>'centrifuge_liters','')::numeric,nullif(row->>'source_drawn_liters','')::numeric,nullif(row->>'brite_received_liters','')::numeric,nullif(row->>'packaged_liters','')::numeric,row->>'volume_override_reason',coalesce((row->>'version')::integer,1),nullif(row->>'deleted_at','')::timestamptz,od.target_id,row->>'delete_reason'
    from restore_operator_map o left join restore_operator_map od on od.source_id=nullif(row->>'deleted_by','')::uuid where o.source_id=(row->>'operator_id')::uuid;
  end loop;
  -- Auxiliary history is restored after its parent rows.  Existing audit
  -- triggers may add additional restore-import events; that is intentional.
  for row in select value from jsonb_array_elements(entities->'volume_events') loop
    insert into public.volume_events(id,brewery_id,batch_id,packaging_run_id,stage,liters,is_measured,source_device,note,operator_id,recorded_at,created_at)
    select (row->>'id')::uuid,brewery,(row->>'batch_id')::uuid,nullif(row->>'packaging_run_id','')::uuid,row->>'stage',(row->>'liters')::numeric,coalesce((row->>'is_measured')::boolean,false),row->>'source_device',row->>'note',o.target_id,coalesce(nullif(row->>'recorded_at','')::timestamptz,now()),coalesce(nullif(row->>'created_at','')::timestamptz,now()) from restore_operator_map o where o.source_id=nullif(row->>'operator_id','')::uuid;
  end loop;
  for row in select value from jsonb_array_elements(entities->'batch_carbonation_advisories') loop
    insert into public.batch_carbonation_advisories(batch_id,brewery_id,confirmed_terminal_gravity,beer_volume_liters,headspace_liters,hardware_max_bar,prv_limit_bar,device_limit_bar,co2_measurement_method,pressure_basis,altitude_meters,hop_creep_acknowledged,updated_by,updated_at)
    select (row->>'batch_id')::uuid,brewery,nullif(row->>'confirmed_terminal_gravity','')::integer,nullif(row->>'beer_volume_liters','')::numeric,nullif(row->>'headspace_liters','')::numeric,nullif(row->>'hardware_max_bar','')::numeric,nullif(row->>'prv_limit_bar','')::numeric,nullif(row->>'device_limit_bar','')::numeric,row->>'co2_measurement_method',row->>'pressure_basis',nullif(row->>'altitude_meters','')::numeric,coalesce((row->>'hop_creep_acknowledged')::boolean,false),o.target_id,coalesce(nullif(row->>'updated_at','')::timestamptz,now()) from restore_operator_map o where o.source_id=nullif(row->>'updated_by','')::uuid;
  end loop;
  -- Work and cleaning records are optional to older archives.  Version 1
  -- archives always contain the arrays, and these inserts retain chronology.
  for row in select value from jsonb_array_elements(entities->'work_items') loop
    insert into public.work_items(id,brewery_id,batch_id,occurrence_key,work_type,label,source,due_at,status,accepted_by,accepted_at,completed_by,completed_at,postponed_by,postponed_at,postpone_reason,skipped_by,skipped_at,skip_reason,linked_measurement_id,linked_action_id,linked_packaging_run_id,version,created_at,updated_at)
    select (row->>'id')::uuid,brewery,nullif(row->>'batch_id','')::uuid,row->>'occurrence_key',row->>'work_type',row->>'label',row->>'source',coalesce(nullif(row->>'due_at','')::timestamptz,now()),row->>'status',a.target_id,nullif(row->>'accepted_at','')::timestamptz,c.target_id,nullif(row->>'completed_at','')::timestamptz,p.target_id,nullif(row->>'postponed_at','')::timestamptz,row->>'postpone_reason',s.target_id,nullif(row->>'skipped_at','')::timestamptz,row->>'skip_reason',nullif(row->>'linked_measurement_id','')::uuid,nullif(row->>'linked_action_id','')::uuid,nullif(row->>'linked_packaging_run_id','')::uuid,coalesce((row->>'version')::integer,1),coalesce(nullif(row->>'created_at','')::timestamptz,now()),coalesce(nullif(row->>'updated_at','')::timestamptz,now())
    from restore_operator_map a left join restore_operator_map c on c.source_id=nullif(row->>'completed_by','')::uuid left join restore_operator_map p on p.source_id=nullif(row->>'postponed_by','')::uuid left join restore_operator_map s on s.source_id=nullif(row->>'skipped_by','')::uuid where a.source_id is not null or row->>'accepted_by' is null;
  end loop;
  for row in select value from jsonb_array_elements(entities->'work_item_events') loop
    insert into public.work_item_events(id,work_item_id,brewery_id,operator_id,event_type,previous_status,new_status,reason,details,created_at)
    select (row->>'id')::uuid,(row->>'work_item_id')::uuid,brewery,o.target_id,row->>'event_type',row->>'previous_status',row->>'new_status',row->>'reason',coalesce(row->'details','{}'::jsonb),coalesce(nullif(row->>'created_at','')::timestamptz,now())
    from (select 1) x left join restore_operator_map o on o.source_id=nullif(row->>'operator_id','')::uuid;
  end loop;
  for row in select value from jsonb_array_elements(entities->'vessel_cleaning_cycles') loop
    insert into public.vessel_cleaning_cycles(id,brewery_id,fermenter_id,related_batch_id,started_at,started_by,completed_at,completed_by,used_alkali,used_acid,used_disinfectant,program,note,status,created_at)
    select (row->>'id')::uuid,brewery,f.target_id,nullif(row->>'related_batch_id','')::uuid,coalesce(nullif(row->>'started_at','')::timestamptz,now()),a.target_id,coalesce(nullif(row->>'completed_at','')::timestamptz,now()),c.target_id,coalesce((row->>'used_alkali')::boolean,false),coalesce((row->>'used_acid')::boolean,false),coalesce((row->>'used_disinfectant')::boolean,false),row->>'program',row->>'note',coalesce(row->>'status','completed'),coalesce(nullif(row->>'created_at','')::timestamptz,now())
    from restore_fermenter_map f join restore_operator_map a on a.source_id=(row->>'started_by')::uuid join restore_operator_map c on c.source_id=(row->>'completed_by')::uuid where f.source_id=(row->>'fermenter_id')::uuid;
  end loop;
  for row in select value from jsonb_array_elements(entities->'vessel_cleaning_events') loop
    insert into public.vessel_cleaning_events(id,brewery_id,fermenter_id,cleaning_cycle_id,related_batch_id,operator_id,event_type,details,created_at)
    select (row->>'id')::uuid,brewery,f.target_id,nullif(row->>'cleaning_cycle_id','')::uuid,nullif(row->>'related_batch_id','')::uuid,o.target_id,row->>'event_type',coalesce(row->'details','{}'::jsonb),coalesce(nullif(row->>'created_at','')::timestamptz,now())
    from restore_fermenter_map f left join restore_operator_map o on o.source_id=nullif(row->>'operator_id','')::uuid where f.source_id=(row->>'fermenter_id')::uuid;
  end loop;
  -- Keep source audit history as evidence. Row IDs in JSON retain their source
  -- identifiers; the import's own trigger-generated events have target IDs.
  for row in select value from jsonb_array_elements(entities->'audit_log') loop
    insert into public.audit_log(brewery_id,operator_id,table_name,row_id,operation,old_data,new_data,reason,created_at)
    select brewery,o.target_id,row->>'table_name',(row->>'row_id')::uuid,
      case when row->>'operation' in ('insert','update','soft_delete','restore') then row->>'operation' else 'update' end,
      row->'old_data',row->'new_data',row->>'reason',coalesce(nullif(row->>'created_at','')::timestamptz,now())
    from (select 1) x left join restore_operator_map o on o.source_id=nullif(row->>'operator_id','')::uuid;
  end loop;
  -- Restore the displayed physical readiness snapshot after historical cycles;
  -- active batches still remain the final authority for occupied vessels.
  for row in select value from jsonb_array_elements(entities->'fermenters') loop
    update public.fermenters f set cleanliness_status=coalesce(row->>'cleanliness_status','legacy_ready'),
      cleaned_at=nullif(row->>'cleaned_at','')::timestamptz,
      cleaned_by=o.target_id, cleaning_version=coalesce((row->>'cleaning_version')::integer,1),
      consecutive_acid_skips=coalesce((row->>'consecutive_acid_skips')::smallint,0),
      last_cleaning_chemicals=coalesce(array(select jsonb_array_elements_text(coalesce(row->'last_cleaning_chemicals','[]'::jsonb))),'{}'::text[])
    from restore_fermenter_map m left join restore_operator_map o on o.source_id=nullif(row->>'cleaned_by','')::uuid
    where f.id=m.target_id and m.source_id=(row->>'id')::uuid;
  end loop;
  -- The exported snapshot is authoritative for historical free vessels.  Any
  -- genuinely live source batch or filtered beer in Dzidra wins over it.
  update public.fermenters f set cleanliness_status='occupied',cleaning_version=cleaning_version+1
  where f.brewery_id=brewery and exists(
    select 1 from public.batches b where b.fermenter_id=f.id and b.deleted_at is null
      and b.fermenter_released_at is null and b.status<>'finished'
  );
  update public.fermenters f set cleanliness_status='occupied',cleaning_version=cleaning_version+1
  where f.brewery_id=brewery and f.number=13 and exists(
    select 1 from public.packaging_runs p join public.batches b on b.id=p.batch_id
    where b.brewery_id=brewery and b.deleted_at is null and p.deleted_at is null and p.status='filtered'
  );
  -- A provenance record is the authoritative result of the drill.
  insert into public.backup_restore_imports(brewery_id,operator_id,source_brewery_id,payload_checksum,schema_version,row_counts,details)
  values(brewery,op,source_brewery,expected_checksum,1,jsonb_build_object(
    'beer_types',jsonb_array_length(entities->'beer_types'),'batches',jsonb_array_length(entities->'batches'),
    'measurements',jsonb_array_length(entities->'measurements'),'mode','empty_test_brewery_only')) returning * into result;
  return result;
exception when others then
  raise;
end $$;

revoke all on function public.restore_backup_to_empty_test_brewery(text,text,text,text) from public;
grant execute on function public.restore_backup_to_empty_test_brewery(text,text,text,text) to authenticated;
