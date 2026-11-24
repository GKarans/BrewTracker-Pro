-- BeerSmith history import: partial historic readings are deliberately nullable.
-- Live forms and their validated RPC path still require complete readings.
alter table public.measurements
  alter column ph drop not null,
  alter column temperature_c drop not null;
alter table public.process_actions
  alter column gravity drop not null,
  alter column ph drop not null,
  alter column temperature_c drop not null;
alter table public.packaging_runs
  alter column gravity drop not null,
  alter column ph drop not null,
  alter column temperature_c drop not null;

alter table public.batches
  add column if not exists historical_imported boolean not null default false,
  add column if not exists completion_inferred boolean not null default false,
  add column if not exists source_notes text;

-- A live Dry Hop profile still supplies a trigger gravity. Historical cards
-- sometimes record that hops were added but omit the gravity, so keep that
-- field nullable rather than inventing a threshold solely to satisfy a check.
do $$
declare existing_constraint text;
begin
  select c.conname into existing_constraint
  from pg_constraint c
  where c.conrelid='public.beer_types'::regclass
    and c.contype='c'
    and pg_get_constraintdef(c.oid) like '%dry_hop_gravity%'
  limit 1;
  if existing_constraint is not null then
    execute format('alter table public.beer_types drop constraint %I', existing_constraint);
  end if;
end $$;
alter table public.beer_types add constraint beer_types_dry_hop_optional_history_check
  check (not has_dry_hop or dry_hop_gravity is null or dry_hop_gravity between 950 and 1200);

create table if not exists public.history_import_runs (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  operator_id uuid not null references public.operators(id),
  source_name text not null,
  imported_count integer not null,
  skipped_count integer not null,
  created_at timestamptz not null default now()
);
alter table public.history_import_runs enable row level security;
revoke all on public.history_import_runs from anon, authenticated;
grant select on public.history_import_runs to authenticated;
drop policy if exists "read own history imports" on public.history_import_runs;
create policy "read own history imports" on public.history_import_runs for select to authenticated
  using (brewery_id=public.current_brewery_id());

-- Historical insertions must never turn old batches into occupied vessels,
-- generate cleaning events, volume estimates, or live-measurement warnings.
drop trigger if exists validate_batch_fermenter_before_write on public.batches;
create trigger validate_batch_fermenter_before_write
before insert or update of fermenter_id, volume_tons on public.batches
for each row when (current_setting('app.historical_import', true) is distinct from 'on')
execute function public.validate_batch_fermenter();
drop trigger if exists batch_marks_vessel_occupied on public.batches;
create trigger batch_marks_vessel_occupied after insert on public.batches
for each row when (current_setting('app.historical_import', true) is distinct from 'on')
execute function public.mark_vessel_occupied_after_batch();
drop trigger if exists measurements_anomaly_validation on public.measurements;
create trigger measurements_anomaly_validation before insert or update on public.measurements
for each row when (current_setting('app.historical_import', true) is distinct from 'on')
execute function public.validate_measurement_anomaly();
drop trigger if exists packaging_updates_vessel_states on public.packaging_runs;
create trigger packaging_updates_vessel_states after insert or update of status on public.packaging_runs
for each row when (current_setting('app.historical_import', true) is distinct from 'on')
execute function public.update_vessels_after_packaging_change();
drop trigger if exists packaging_volume_events on public.packaging_runs;
create trigger packaging_volume_events after insert or update on public.packaging_runs
for each row when (current_setting('app.historical_import', true) is distinct from 'on')
execute function public.record_packaging_volume_events();
drop trigger if exists packaging_final_heel_estimate on public.packaging_runs;
create trigger packaging_final_heel_estimate after insert or update of status on public.packaging_runs
for each row when (current_setting('app.historical_import', true) is distinct from 'on')
execute function public.record_final_fermenter_heel_estimate();

create or replace function public.import_beersmith_history(session_token text, import_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  op uuid := public.validate_operator_session(session_token);
  brewery uuid := public.current_brewery_id();
  item jsonb;
  measurement jsonb;
  action jsonb;
  packaging jsonb;
  vessel public.fermenters;
  beer_id uuid;
  batch_id uuid;
  batch_code text;
  finish_at timestamptz;
  imported_count integer := 0;
  skipped_count integer := 0;
begin
  if op is null then raise exception 'Operator session invalid or expired'; end if;
  if brewery is null then raise exception 'Authentication required'; end if;
  if import_payload->>'schema' <> 'brewtracker-beersmith-history-v1' then
    raise exception 'Nederīgs BeerSmith importa fails';
  end if;
  if jsonb_typeof(import_payload->'batches') <> 'array' then
    raise exception 'Importa failā nav partiju saraksta';
  end if;

  perform set_config('app.operator_id', op::text, true);
  perform set_config('app.historical_import', 'on', true);

  for item in select value from jsonb_array_elements(import_payload->'batches') loop
    batch_code := nullif(trim(item->>'batchNumber'), '');
    if batch_code is null then raise exception 'Partijai trūkst numura'; end if;
    if exists(select 1 from public.batches b where b.brewery_id=brewery and b.batch_number=batch_code) then
      skipped_count := skipped_count + 1;
      continue;
    end if;
    select * into vessel from public.fermenters f
      where f.brewery_id=brewery and f.number=(item->>'fermenterNumber')::smallint and f.vessel_type='fermenter';
    if vessel.id is null then raise exception 'Tvertne % nav atrasta', item->>'fermenterNumber'; end if;

    insert into public.beer_types(brewery_id,name,og_target,fg_target,spund_gravity,has_dry_hop,dry_hop_gravity,cooling_gravity,co2_target)
    values (brewery, nullif(trim(item->>'beerName'),''), (item->>'ogTarget')::smallint,
      (item->>'fgTarget')::smallint, (item->>'spundGravity')::smallint,
      coalesce((item->>'hasDryHop')::boolean,false),
      case when coalesce((item->>'hasDryHop')::boolean,false) then nullif(item->>'dryHopGravity','')::smallint else null end,
      (item->>'coolingGravity')::smallint, coalesce(nullif(item->>'co2Target','')::numeric,2.4))
    on conflict (brewery_id,name) do nothing;
    select id into beer_id from public.beer_types where brewery_id=brewery and name=item->>'beerName';

    select max(value::timestamptz) into finish_at from (
      select nullif(value->>'packagedAt','') as value from jsonb_array_elements(coalesce(item->'packagingRuns','[]'::jsonb))
      union all select nullif(value->>'measuredAt','') from jsonb_array_elements(coalesce(item->'measurements','[]'::jsonb))
      union all select nullif(value->>'performedAt','') from jsonb_array_elements(coalesce(item->'actions','[]'::jsonb))
    ) timestamps where value is not null;
    finish_at := coalesce(finish_at, (item->>'brewDate')::date::timestamptz);

    insert into public.batches(
      brewery_id,beer_type_id,fermenter_id,batch_number,brew_year,sequence_number,volume_tons,brew_date,status,
      og_target,fg_target,spund_gravity,has_dry_hop,dry_hop_gravity,cooling_gravity,co2_target,created_by,
      finished_at,fermenter_released_at,historical_imported,completion_inferred,source_notes
    ) values (
      brewery,beer_id,vessel.id,batch_code,(item->>'year')::smallint,(item->>'sequence')::smallint,
      (item->>'volumeTons')::numeric,(item->>'brewDate')::date,'finished',
      (item->>'ogTarget')::smallint,(item->>'fgTarget')::smallint,(item->>'spundGravity')::smallint,
      coalesce((item->>'hasDryHop')::boolean,false),case when coalesce((item->>'hasDryHop')::boolean,false) then nullif(item->>'dryHopGravity','')::smallint else null end,
      (item->>'coolingGravity')::smallint,coalesce(nullif(item->>'co2Target','')::numeric,2.4),op,
      finish_at,finish_at,true,coalesce((item->'source'->>'completionInference')::boolean,false),item->'source'->>'rawNotes'
    ) returning id into batch_id;

    for measurement in select value from jsonb_array_elements(coalesce(item->'measurements','[]'::jsonb)) loop
      if nullif(measurement->>'gravity','') is not null then
        insert into public.measurements(batch_id,operator_id,measured_at,gravity,ph,temperature_c,pressure_bar,co2_vol,note,client_id)
        values(batch_id,op,(measurement->>'measuredAt')::timestamptz,(measurement->>'gravity')::smallint,
          nullif(measurement->>'ph','')::numeric,nullif(measurement->>'temperature','')::numeric,
          nullif(measurement->>'pressure','')::numeric,nullif(measurement->>'co2Vol','')::numeric,
          nullif(measurement->>'note',''),gen_random_uuid());
      end if;
    end loop;
    for action in select value from jsonb_array_elements(coalesce(item->'actions','[]'::jsonb)) loop
      insert into public.process_actions(batch_id,operator_id,action_type,performed_at,gravity,ph,temperature_c,pressure_bar,note,client_id)
      values(batch_id,op,(action->>'type')::public.process_action_type,(action->>'performedAt')::timestamptz,
        nullif(action->>'gravity','')::smallint,nullif(action->>'ph','')::numeric,nullif(action->>'temperature','')::numeric,
        nullif(action->>'pressure','')::numeric,nullif(action->>'note',''),gen_random_uuid())
      on conflict (batch_id,action_type) do nothing;
    end loop;
    for packaging in select value from jsonb_array_elements(coalesce(item->'packagingRuns','[]'::jsonb)) loop
      insert into public.packaging_runs(batch_id,run_number,volume_tons,status,filtered_at,packaged_at,gravity,ph,temperature_c,pressure_bar,co2_vol,operator_id,client_id)
      values(batch_id,(packaging->>'runNumber')::smallint,(packaging->>'volumeTons')::numeric,'packaged',
        (packaging->>'packagedAt')::timestamptz,(packaging->>'packagedAt')::timestamptz,
        nullif(packaging->>'gravity','')::smallint,nullif(packaging->>'ph','')::numeric,nullif(packaging->>'temperature','')::numeric,
        nullif(packaging->>'pressure','')::numeric,nullif(packaging->>'co2Vol','')::numeric,op,gen_random_uuid());
    end loop;
    imported_count := imported_count + 1;
  end loop;

  insert into public.history_import_runs(brewery_id,operator_id,source_name,imported_count,skipped_count)
  values(brewery,op,'BeerSmith DOCX vēsture',imported_count,skipped_count);
  return jsonb_build_object('imported',imported_count,'skipped',skipped_count);
end $$;

revoke all on function public.import_beersmith_history(text,jsonb) from public;
grant execute on function public.import_beersmith_history(text,jsonb) to authenticated;
