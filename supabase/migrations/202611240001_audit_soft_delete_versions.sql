-- Phase 1B: audited, reversible history and optimistic conflict detection.

alter table public.audit_log drop constraint if exists audit_log_operation_check;
alter table public.audit_log
  add column if not exists reason text,
  add constraint audit_log_operation_check
    check (operation in ('insert', 'update', 'soft_delete', 'restore'));

alter table public.batches
  add column if not exists version integer not null default 1,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.operators(id),
  add column if not exists delete_reason text;
alter table public.beer_types
  add column if not exists version integer not null default 1;
alter table public.measurements
  add column if not exists version integer not null default 1,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.operators(id),
  add column if not exists delete_reason text;
alter table public.process_actions
  add column if not exists version integer not null default 1,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.operators(id),
  add column if not exists delete_reason text;
alter table public.packaging_runs
  add column if not exists version integer not null default 1,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.operators(id),
  add column if not exists delete_reason text;

drop index if exists public.one_active_batch_per_fermenter;
create unique index one_active_batch_per_fermenter
  on public.batches (fermenter_id)
  where status <> 'finished' and deleted_at is null;
alter table public.batches drop constraint if exists batches_brewery_id_batch_number_key;
alter table public.batches drop constraint if exists batches_brewery_id_brew_year_sequence_number_key;
create unique index if not exists batches_active_number_key
  on public.batches (brewery_id,batch_number) where deleted_at is null;
create unique index if not exists batches_active_year_sequence_key
  on public.batches (brewery_id,brew_year,sequence_number) where deleted_at is null;

create or replace function public.audit_operational_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  before_row jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  after_row jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  row_brewery_id uuid;
  acting_operator_id uuid := nullif(current_setting('app.operator_id', true), '')::uuid;
  audit_operation text := lower(tg_op);
  audit_reason text := nullif(current_setting('app.change_reason', true), '');
begin
  if tg_table_name in ('batches', 'beer_types') then
    row_brewery_id := coalesce(new.brewery_id, old.brewery_id);
  else
    select b.brewery_id into row_brewery_id from public.batches b
      where b.id = coalesce(new.batch_id, old.batch_id);
  end if;
  if tg_table_name <> 'beer_types' and tg_op = 'UPDATE' and old.deleted_at is null and new.deleted_at is not null then
    audit_operation := 'soft_delete';
  elsif tg_table_name <> 'beer_types' and tg_op = 'UPDATE' and old.deleted_at is not null and new.deleted_at is null then
    audit_operation := 'restore';
  end if;
  insert into public.audit_log (brewery_id, operator_id, table_name, row_id, operation, old_data, new_data, reason)
  values (row_brewery_id, acting_operator_id, tg_table_name, coalesce(new.id, old.id), audit_operation,
    before_row, after_row, audit_reason);
  return new;
end; $$;

create or replace function public.increment_operational_version()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.version := old.version + 1;
  return new;
end; $$;

do $$
declare table_name text;
begin
  foreach table_name in array array['beer_types','batches','measurements','process_actions','packaging_runs'] loop
    execute format('drop trigger if exists %I_version on public.%I', table_name, table_name);
    execute format('create trigger %I_version before update on public.%I for each row execute function public.increment_operational_version()', table_name, table_name);
    execute format('drop trigger if exists %I_audit on public.%I', table_name, table_name);
    execute format('create trigger %I_audit after insert or update on public.%I for each row execute function public.audit_operational_change()', table_name, table_name);
  end loop;
end $$;

create or replace function public.sync_operator_event_v2(
  session_token text, expected_operator_id uuid, entity_type text, operation_type text,
  payload jsonb, expected_version integer default 0, change_reason text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  acting_operator_id uuid := public.validate_operator_session(session_token);
  target_brewery_id uuid := public.current_brewery_id();
  entity_id uuid := coalesce(nullif(payload->>'entity_id','')::uuid, nullif(payload->'item'->>'id','')::uuid,
    nullif(payload->'batch'->>'id','')::uuid);
  current_version integer;
  beer_current_version integer;
  beer_id uuid;
  beer_expected_version integer;
begin
  if acting_operator_id is null or acting_operator_id <> expected_operator_id then
    raise exception 'Operator session invalid, expired, or does not match offline event';
  end if;
  perform set_config('app.operator_id', acting_operator_id::text, true);
  perform set_config('app.change_reason', coalesce(change_reason, ''), true);

  -- Composite process events deliberately recurse through the same checked writer.
  -- PostgreSQL functions share the caller transaction, so a failure in any child
  -- rolls the whole operator action back instead of leaving a partial process.
  if entity_type = 'processBundle' then
    if operation_type <> 'apply' or payload->'action' is null or payload->'measurement' is null or payload->'batch' is null then
      raise exception 'Invalid process bundle';
    end if;
    perform public.sync_operator_event_v2(session_token, expected_operator_id, 'action', payload->'action'->>'operation',
      jsonb_build_object('item', payload->'action'->'item'), (payload->'action'->>'expected_version')::integer, change_reason);
    perform public.sync_operator_event_v2(session_token, expected_operator_id, 'measurement', 'create',
      jsonb_build_object('item', payload->'measurement'->'item'), (payload->'measurement'->>'expected_version')::integer, change_reason);
    perform public.sync_operator_event_v2(session_token, expected_operator_id, 'batch', 'update',
      jsonb_build_object('beer', payload->'batch'->'beer', 'batch', payload->'batch'->'item'),
      (payload->'batch'->>'expected_version')::integer, change_reason);
    return;
  elsif entity_type = 'packagingCompletion' then
    if operation_type <> 'apply' or payload->'packaging' is null or payload->'action' is null or payload->'batch' is null then
      raise exception 'Invalid packaging completion bundle';
    end if;
    perform public.sync_operator_event_v2(session_token, expected_operator_id, 'packagingRun', 'update',
      jsonb_build_object('item', payload->'packaging'->'item'), (payload->'packaging'->>'expected_version')::integer, change_reason);
    perform public.sync_operator_event_v2(session_token, expected_operator_id, 'action', payload->'action'->>'operation',
      jsonb_build_object('item', payload->'action'->'item'), (payload->'action'->>'expected_version')::integer, change_reason);
    perform public.sync_operator_event_v2(session_token, expected_operator_id, 'batch', 'update',
      jsonb_build_object('beer', payload->'batch'->'beer', 'batch', payload->'batch'->'item'),
      (payload->'batch'->>'expected_version')::integer, change_reason);
    return;
  end if;

  if entity_type = 'batch' then
    select b.version into current_version from public.batches b
      where b.id = entity_id and b.brewery_id = target_brewery_id for update;
  elsif entity_type = 'measurement' then
    select m.version into current_version from public.measurements m join public.batches b on b.id=m.batch_id
      where m.id=entity_id and b.brewery_id=target_brewery_id for update of m;
  elsif entity_type = 'action' then
    select a.version into current_version from public.process_actions a join public.batches b on b.id=a.batch_id
      where a.id=entity_id and b.brewery_id=target_brewery_id for update of a;
  elsif entity_type = 'packagingRun' then
    select p.version into current_version from public.packaging_runs p join public.batches b on b.id=p.batch_id
      where p.id=entity_id and b.brewery_id=target_brewery_id for update of p;
  else
    raise exception 'Unsupported synchronization entity';
  end if;

  if operation_type = 'delete' then
    if entity_type <> 'batch' or current_version is null then raise exception 'Batch not found'; end if;
    if current_version <> expected_version then raise exception 'VERSION_CONFLICT: server %, device %', current_version, expected_version; end if;
    if nullif(trim(change_reason), '') is null then raise exception 'Delete reason is required'; end if;
    update public.measurements set deleted_at=now(),deleted_by=acting_operator_id,delete_reason=change_reason
      where batch_id=entity_id and deleted_at is null;
    update public.process_actions set deleted_at=now(),deleted_by=acting_operator_id,delete_reason=change_reason
      where batch_id=entity_id and deleted_at is null;
    update public.packaging_runs set deleted_at=now(),deleted_by=acting_operator_id,delete_reason=change_reason
      where batch_id=entity_id and deleted_at is null;
    update public.batches set deleted_at=now(),deleted_by=acting_operator_id,delete_reason=change_reason
      where id=entity_id and brewery_id=target_brewery_id and deleted_at is null;
    return;
  elsif operation_type = 'restore' then
    if entity_type <> 'batch' or current_version is null then raise exception 'Batch not found'; end if;
    if current_version <> expected_version then raise exception 'VERSION_CONFLICT: server %, device %', current_version, expected_version; end if;
    update public.batches set deleted_at=null,deleted_by=null,delete_reason=null
      where id=entity_id and brewery_id=target_brewery_id and deleted_at is not null;
    update public.measurements set deleted_at=null,deleted_by=null,delete_reason=null where batch_id=entity_id and deleted_at is not null;
    update public.process_actions set deleted_at=null,deleted_by=null,delete_reason=null where batch_id=entity_id and deleted_at is not null;
    update public.packaging_runs set deleted_at=null,deleted_by=null,delete_reason=null where batch_id=entity_id and deleted_at is not null;
    return;
  end if;

  if entity_type = 'batch' and operation_type in ('create', 'update') then
    beer_id := nullif(payload->'beer'->>'id', '')::uuid;
    beer_expected_version := coalesce((payload->'beer'->>'expected_version')::integer, 0);
    select bt.version into beer_current_version from public.beer_types bt
      where bt.id=beer_id and bt.brewery_id=target_brewery_id for update;
    if beer_current_version is null then
      if beer_expected_version <> 0 then raise exception 'VERSION_CONFLICT: beer profile no longer exists'; end if;
    elsif beer_current_version <> beer_expected_version then
      raise exception 'VERSION_CONFLICT: beer profile server %, device %', beer_current_version, beer_expected_version;
    end if;
  end if;

  if current_version is null then
    if expected_version <> 0 then raise exception 'VERSION_CONFLICT: record no longer exists'; end if;
  elsif current_version <> expected_version then
    raise exception 'VERSION_CONFLICT: server %, device %', current_version, expected_version;
  end if;
  perform public.sync_operator_event(session_token, expected_operator_id, entity_type, operation_type, payload);
end; $$;

create or replace function public.list_deleted_batches(session_token text)
returns table (id uuid, batch_number text, brew_date date, beer_name text, version integer,
  deleted_at timestamptz, delete_reason text, deleted_by_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if public.validate_operator_session(session_token) is null then raise exception 'Operator session invalid or expired'; end if;
  return query select b.id,b.batch_number,b.brew_date,bt.name,b.version,b.deleted_at,b.delete_reason,o.name
    from public.batches b join public.beer_types bt on bt.id=b.beer_type_id
    left join public.operators o on o.id=b.deleted_by
    where b.brewery_id=public.current_brewery_id() and b.deleted_at is not null order by b.deleted_at desc;
end; $$;

revoke all on function public.sync_operator_event_v2(text,uuid,text,text,jsonb,integer,text),
  public.list_deleted_batches(text) from public;
revoke all on function public.sync_operator_event(text,uuid,text,text,jsonb) from authenticated;
grant execute on function public.sync_operator_event_v2(text,uuid,text,text,jsonb,integer,text),
  public.list_deleted_batches(text) to authenticated;
