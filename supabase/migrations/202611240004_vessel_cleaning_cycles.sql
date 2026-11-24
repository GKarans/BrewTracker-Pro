-- Phase 4: vessel readiness and auditable S/A/D cleaning cycles.

alter table public.fermenters
  add column if not exists cleanliness_status text not null default 'legacy_ready'
    check (cleanliness_status in ('legacy_ready','occupied','free_dirty','cleaning','free_clean')),
  add column if not exists cleaned_at timestamptz,
  add column if not exists cleaned_by uuid references public.operators(id),
  add column if not exists cleaning_version integer not null default 1,
  add column if not exists consecutive_acid_skips smallint not null default 0
    check (consecutive_acid_skips between 0 and 2),
  add column if not exists last_cleaning_chemicals text[] not null default '{}';

alter table public.batches
  add column if not exists fermenter_released_at timestamptz;

create table if not exists public.vessel_cleaning_cycles (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  fermenter_id uuid not null references public.fermenters(id) on delete cascade,
  -- Immutable historical snapshot. Deliberately no FK: a full brewing-data
  -- reset must not mutate append-only cleaning history.
  related_batch_id uuid,
  started_at timestamptz not null default now(),
  started_by uuid not null references public.operators(id),
  completed_at timestamptz not null default now(),
  completed_by uuid not null references public.operators(id),
  used_alkali boolean not null,
  used_acid boolean not null,
  used_disinfectant boolean not null,
  program text,
  note text,
  status text not null default 'completed' check (status in ('completed')),
  created_at timestamptz not null default now()
);

create table if not exists public.vessel_cleaning_events (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  fermenter_id uuid not null references public.fermenters(id) on delete cascade,
  cleaning_cycle_id uuid references public.vessel_cleaning_cycles(id) on delete restrict,
  -- Immutable historical snapshot; see vessel_cleaning_cycles above.
  related_batch_id uuid,
  operator_id uuid references public.operators(id),
  event_type text not null check (event_type in ('occupied','released_dirty','manual_dirty','cleaned_ready','legacy_ready')),
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists vessel_cleaning_cycles_vessel_completed_idx
  on public.vessel_cleaning_cycles (fermenter_id, completed_at desc);
create index if not exists vessel_cleaning_events_vessel_created_idx
  on public.vessel_cleaning_events (fermenter_id, created_at desc);

alter table public.vessel_cleaning_cycles enable row level security;
alter table public.vessel_cleaning_events enable row level security;
drop policy if exists "read own vessel cleanings" on public.vessel_cleaning_cycles;
create policy "read own vessel cleanings" on public.vessel_cleaning_cycles for select to authenticated
  using (brewery_id=public.current_brewery_id());
drop policy if exists "read own vessel cleaning events" on public.vessel_cleaning_events;
create policy "read own vessel cleaning events" on public.vessel_cleaning_events for select to authenticated
  using (brewery_id=public.current_brewery_id());
revoke insert,update,delete on public.vessel_cleaning_cycles,public.vessel_cleaning_events from authenticated;

-- Existing empty vessels remain selectable without inventing a historical wash.
-- They are explicitly labelled legacy_ready until their first recorded cleaning.
update public.fermenters f set cleanliness_status=case
  when f.number=13 and exists(select 1 from public.packaging_runs p where p.status='filtered' and p.deleted_at is null) then 'occupied'
  when f.number<>13 and exists(select 1 from public.batches b where b.fermenter_id=f.id and b.deleted_at is null and b.fermenter_released_at is null and b.status<>'finished') then 'occupied'
  else 'legacy_ready' end;

-- Backfill historical assignments before replacing the old status-based
-- uniqueness rule. Finished batches no longer occupy their source vessel.
update public.batches set fermenter_released_at=coalesce(finished_at,created_at)
where status='finished' and fermenter_released_at is null;
update public.batches b set fermenter_released_at=coalesce((select max(p.filtered_at) from public.packaging_runs p where p.batch_id=b.id),now())
where b.fermenter_released_at is null and b.deleted_at is null
  and (select count(*) from public.packaging_runs p where p.batch_id=b.id and p.deleted_at is null)>=ceil(b.volume_tons/4.0);
update public.fermenters f set cleanliness_status=case
  when f.number=13 and exists(select 1 from public.packaging_runs p where p.status='filtered' and p.deleted_at is null) then 'occupied'
  when f.number<>13 and exists(select 1 from public.batches b where b.fermenter_id=f.id and b.deleted_at is null and b.fermenter_released_at is null and b.status<>'finished') then 'occupied'
  else 'legacy_ready' end;

drop index if exists public.one_active_batch_per_fermenter;
create unique index one_unreleased_batch_per_fermenter
  on public.batches (fermenter_id)
  where fermenter_released_at is null and deleted_at is null;

create or replace function public.reject_cleaning_history_mutation()
returns trigger language plpgsql set search_path='' as $$ begin
  raise exception 'Cleaning history is append-only';
end $$;
drop trigger if exists vessel_cleaning_cycles_append_only on public.vessel_cleaning_cycles;
create trigger vessel_cleaning_cycles_append_only before update or delete on public.vessel_cleaning_cycles
for each row execute function public.reject_cleaning_history_mutation();
drop trigger if exists vessel_cleaning_events_append_only on public.vessel_cleaning_events;
create trigger vessel_cleaning_events_append_only before update or delete on public.vessel_cleaning_events
for each row execute function public.reject_cleaning_history_mutation();

create or replace function public.validate_batch_fermenter()
returns trigger language plpgsql set search_path='' as $$
declare vessel public.fermenters; brite public.fermenters;
begin
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
  select brewery_id into brewery from public.fermenters where id=new.fermenter_id;
  update public.fermenters set cleanliness_status='occupied',cleaning_version=cleaning_version+1 where id=new.fermenter_id;
  insert into public.vessel_cleaning_events(brewery_id,fermenter_id,related_batch_id,operator_id,event_type)
  values(brewery,new.fermenter_id,new.id,op,'occupied');
  return new;
end $$;
drop trigger if exists batch_marks_vessel_occupied on public.batches;
create trigger batch_marks_vessel_occupied after insert on public.batches
for each row execute function public.mark_vessel_occupied_after_batch();

-- Soft-deleting an unreleased batch physically frees its source vessel, but
-- that vessel is dirty. Restoring is allowed only if the same vessel is still
-- ready and no other active batch has claimed it.
create or replace function public.validate_batch_restore_vessel()
returns trigger language plpgsql set search_path='' as $$
declare vessel public.fermenters;
begin
  if old.deleted_at is not null and new.deleted_at is null and new.fermenter_released_at is null then
    select * into vessel from public.fermenters where id=new.fermenter_id for update;
    if vessel.cleanliness_status not in ('free_clean','legacy_ready') then
      raise exception 'VESSEL_RESTORE_CONFLICT: sākotnējā tvertne nav tīra un gatava';
    end if;
    if exists(select 1 from public.batches b where b.fermenter_id=new.fermenter_id and b.id<>new.id
      and b.deleted_at is null and b.fermenter_released_at is null) then
      raise exception 'VESSEL_RESTORE_CONFLICT: sākotnējā tvertne jau ir aizņemta';
    end if;
  end if;
  if old.deleted_at is not null and new.deleted_at is null and exists(
    select 1 from public.packaging_runs p where p.batch_id=new.id and p.status='filtered'
  ) then
    select * into brite from public.fermenters where brewery_id=new.brewery_id and number=13 for update;
    if brite.cleanliness_status not in ('free_clean','legacy_ready') then
      raise exception 'VESSEL_RESTORE_CONFLICT: Dzidra nav tīra un gatava';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists batch_restore_checks_vessel on public.batches;
create trigger batch_restore_checks_vessel before update of deleted_at on public.batches
for each row execute function public.validate_batch_restore_vessel();

create or replace function public.sync_vessel_after_batch_soft_delete()
returns trigger language plpgsql security definer set search_path='' as $$
declare op uuid:=nullif(current_setting('app.operator_id',true),'')::uuid; brewery uuid; brite_id uuid;
begin
  if old.deleted_at is null and new.deleted_at is not null and old.fermenter_released_at is null then
    select brewery_id into brewery from public.fermenters where id=new.fermenter_id;
    update public.fermenters set cleanliness_status='free_dirty',cleaning_version=cleaning_version+1
      where id=new.fermenter_id and cleanliness_status='occupied';
    insert into public.vessel_cleaning_events(brewery_id,fermenter_id,related_batch_id,operator_id,event_type,details)
      values(brewery,new.fermenter_id,new.id,op,'released_dirty',jsonb_build_object('reason','batch_soft_delete'));
  elsif old.deleted_at is not null and new.deleted_at is null and new.fermenter_released_at is null then
    select brewery_id into brewery from public.fermenters where id=new.fermenter_id;
    update public.fermenters set cleanliness_status='occupied',cleaning_version=cleaning_version+1
      where id=new.fermenter_id;
    insert into public.vessel_cleaning_events(brewery_id,fermenter_id,related_batch_id,operator_id,event_type,details)
      values(brewery,new.fermenter_id,new.id,op,'occupied',jsonb_build_object('reason','batch_restore'));
  end if;
  if exists(select 1 from public.packaging_runs p where p.batch_id=new.id and p.status='filtered') then
    select id into brite_id from public.fermenters where brewery_id=new.brewery_id and number=13;
    if old.deleted_at is null and new.deleted_at is not null then
      update public.fermenters set cleanliness_status='free_dirty',cleaning_version=cleaning_version+1 where id=brite_id;
      insert into public.vessel_cleaning_events(brewery_id,fermenter_id,related_batch_id,operator_id,event_type,details)
        values(new.brewery_id,brite_id,new.id,op,'released_dirty',jsonb_build_object('reason','batch_soft_delete'));
    elsif old.deleted_at is not null and new.deleted_at is null then
      update public.fermenters set cleanliness_status='occupied',cleaning_version=cleaning_version+1 where id=brite_id;
      insert into public.vessel_cleaning_events(brewery_id,fermenter_id,related_batch_id,operator_id,event_type,details)
        values(new.brewery_id,brite_id,new.id,op,'occupied',jsonb_build_object('reason','batch_restore'));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists batch_soft_delete_updates_vessel on public.batches;
create trigger batch_soft_delete_updates_vessel after update of deleted_at on public.batches
for each row execute function public.sync_vessel_after_batch_soft_delete();

create or replace function public.update_vessels_after_packaging_change()
returns trigger language plpgsql security definer set search_path='' as $$
declare b public.batches; source_vessel public.fermenters; brite public.fermenters; op uuid:=nullif(current_setting('app.operator_id',true),'')::uuid; filtered_cycles integer; expected_cycles integer;
begin
  select * into b from public.batches where id=new.batch_id for update;
  select * into source_vessel from public.fermenters where id=b.fermenter_id for update;
  select * into brite from public.fermenters where brewery_id=b.brewery_id and number=13 for update;
  if tg_op='INSERT' then
    -- An AFTER trigger may still reject the insert; PostgreSQL rolls the whole
    -- statement back. This avoids blocking ON CONFLICT updates used at packing.
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
drop trigger if exists packaging_updates_vessel_states on public.packaging_runs;
create trigger packaging_updates_vessel_states after insert or update of status on public.packaging_runs
for each row execute function public.update_vessels_after_packaging_change();

create or replace function public.complete_vessel_cleaning(session_token text,target_fermenter_id uuid,expected_version integer,
  used_alkali boolean,used_acid boolean,used_disinfectant boolean,cleaning_program text default null,cleaning_note text default null)
returns public.fermenters language plpgsql security definer set search_path='' as $$
declare op uuid:=public.validate_operator_session(session_token); vessel public.fermenters; cycle_id uuid; chemicals text[]:='{}';
begin
  if op is null then raise exception 'Operator session invalid or expired'; end if;
  select * into vessel from public.fermenters where id=target_fermenter_id and brewery_id=public.current_brewery_id() for update;
  if vessel.id is null then raise exception 'Tvertne nav atrasta'; end if;
  if vessel.cleaning_version<>expected_version then raise exception 'VERSION_CONFLICT: tvertnes stāvoklis ir mainījies'; end if;
  if vessel.cleanliness_status='occupied' then raise exception 'Aizņemtu tvertni nevar atzīmēt kā tīru'; end if;
  if not used_alkali or not used_disinfectant then raise exception 'Gatavībai obligāti vajag S un D'; end if;
  if vessel.consecutive_acid_skips>=2 and not used_acid then raise exception 'Trešajā mazgāšanā obligāti vajag S, A un D'; end if;
  if used_alkali then chemicals:=array_append(chemicals,'S'); end if;
  if used_acid then chemicals:=array_append(chemicals,'A'); end if;
  if used_disinfectant then chemicals:=array_append(chemicals,'D'); end if;
  insert into public.vessel_cleaning_cycles(brewery_id,fermenter_id,started_by,completed_by,used_alkali,used_acid,used_disinfectant,program,note)
    values(vessel.brewery_id,vessel.id,op,op,used_alkali,used_acid,used_disinfectant,nullif(trim(cleaning_program),''),nullif(trim(cleaning_note),'')) returning id into cycle_id;
  update public.fermenters set cleanliness_status='free_clean',cleaned_at=now(),cleaned_by=op,
    cleaning_version=cleaning_version+1,last_cleaning_chemicals=chemicals,
    consecutive_acid_skips=case when used_acid then 0 else consecutive_acid_skips+1 end where id=vessel.id returning * into vessel;
  insert into public.vessel_cleaning_events(brewery_id,fermenter_id,cleaning_cycle_id,operator_id,event_type,details)
    values(vessel.brewery_id,vessel.id,cycle_id,op,'cleaned_ready',jsonb_build_object('chemicals',chemicals,'program',cleaning_program,'note',cleaning_note));
  return vessel;
end $$;

create or replace function public.mark_vessel_dirty(session_token text,target_fermenter_id uuid,expected_version integer,dirty_note text default null)
returns public.fermenters language plpgsql security definer set search_path='' as $$
declare op uuid:=public.validate_operator_session(session_token); vessel public.fermenters;
begin
  if op is null then raise exception 'Operator session invalid or expired'; end if;
  select * into vessel from public.fermenters where id=target_fermenter_id and brewery_id=public.current_brewery_id() for update;
  if vessel.id is null then raise exception 'Tvertne nav atrasta'; end if;
  if vessel.cleaning_version<>expected_version then raise exception 'VERSION_CONFLICT: tvertnes stāvoklis ir mainījies'; end if;
  if vessel.cleanliness_status='occupied' then raise exception 'Aizņemtu tvertni nevar pārslēgt'; end if;
  update public.fermenters set cleanliness_status='free_dirty',cleaning_version=cleaning_version+1 where id=vessel.id returning * into vessel;
  insert into public.vessel_cleaning_events(brewery_id,fermenter_id,operator_id,event_type,details)
    values(vessel.brewery_id,vessel.id,op,'manual_dirty',jsonb_build_object('note',dirty_note));
  return vessel;
end $$;

revoke all on function public.complete_vessel_cleaning(text,uuid,integer,boolean,boolean,boolean,text,text),
  public.mark_vessel_dirty(text,uuid,integer,text) from public;
grant execute on function public.complete_vessel_cleaning(text,uuid,integer,boolean,boolean,boolean,text,text),
  public.mark_vessel_dirty(text,uuid,integer,text) to authenticated;

-- A full brewing-data reset keeps the physical vessels and cleaning history,
-- but fails safe: every vessel must be cleaned again before use.
create or replace function public.reset_brewing_data(confirmation_text text)
returns bigint language plpgsql security definer set search_path='' as $$
declare target_brewery_id uuid; new_version bigint; op uuid:=nullif(current_setting('app.operator_id',true),'')::uuid;
begin
  if confirmation_text<>'DZĒST VISU' then raise exception 'Invalid confirmation text'; end if;
  select id into target_brewery_id from public.breweries where auth_user_id=auth.uid();
  if target_brewery_id is null then raise exception 'Brewery not found'; end if;
  delete from public.batches where brewery_id=target_brewery_id;
  delete from public.beer_types where brewery_id=target_brewery_id;
  update public.fermenters set cleanliness_status='free_dirty',cleaning_version=cleaning_version+1
    where brewery_id=target_brewery_id;
  insert into public.vessel_cleaning_events(brewery_id,fermenter_id,operator_id,event_type,details)
    select target_brewery_id,id,op,'manual_dirty',jsonb_build_object('reason','brew_data_reset')
    from public.fermenters where brewery_id=target_brewery_id;
  update public.breweries set data_version=data_version+1 where id=target_brewery_id returning data_version into new_version;
  return new_version;
end $$;

create or replace function public.reset_brewing_data_with_session(session_token text,confirmation_text text)
returns bigint language plpgsql security definer set search_path='' as $$
declare op uuid:=public.validate_operator_session(session_token);
begin
  if op is null then raise exception 'Operator session invalid or expired'; end if;
  perform set_config('app.operator_id',op::text,true);
  return public.reset_brewing_data(confirmation_text);
end $$;
