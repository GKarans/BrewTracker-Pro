-- Phase 2: persisted brewery work, explicit ownership and escalation.

create table if not exists public.work_items (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  batch_id uuid references public.batches(id) on delete cascade,
  occurrence_key text not null,
  work_type text not null,
  label text not null,
  source text not null default 'process',
  due_at timestamptz not null,
  status text not null default 'todo' check (status in ('todo','accepted','completed','postponed','skipped')),
  accepted_by uuid references public.operators(id),
  accepted_at timestamptz,
  completed_by uuid references public.operators(id),
  completed_at timestamptz,
  postponed_by uuid references public.operators(id),
  postponed_at timestamptz,
  postpone_reason text,
  skipped_by uuid references public.operators(id),
  skipped_at timestamptz,
  skip_reason text,
  linked_measurement_id uuid references public.measurements(id),
  linked_action_id uuid references public.process_actions(id),
  linked_packaging_run_id uuid references public.packaging_runs(id),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brewery_id, occurrence_key)
);

alter table public.work_items add column if not exists linked_packaging_run_id uuid references public.packaging_runs(id);

create index if not exists work_items_open_due_idx
  on public.work_items (brewery_id, due_at)
  where status not in ('completed','skipped');

create table if not exists public.work_item_events (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references public.work_items(id) on delete cascade,
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  operator_id uuid references public.operators(id),
  event_type text not null check (event_type in ('created','accepted','completed','postponed','skipped','reopened')),
  previous_status text,
  new_status text not null,
  reason text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists work_item_events_item_idx on public.work_item_events(work_item_id, created_at);

create table if not exists public.work_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null references public.work_items(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  urgency text not null check (urgency in ('today','overdue')),
  notification_date date not null,
  created_at timestamptz not null default now(),
  unique(work_item_id, subscription_id, urgency, notification_date)
);

alter table public.work_items enable row level security;
alter table public.work_item_events enable row level security;
alter table public.work_notification_deliveries enable row level security;
revoke all on public.work_items, public.work_item_events, public.work_notification_deliveries from anon, authenticated;
grant select on public.work_items, public.work_item_events to authenticated;

drop policy if exists "own work items read" on public.work_items;
create policy "own work items read" on public.work_items for select to authenticated
  using (brewery_id = public.current_brewery_id());
drop policy if exists "own work events read" on public.work_item_events;
create policy "own work events read" on public.work_item_events for select to authenticated
  using (brewery_id = public.current_brewery_id());

create or replace function public.bump_work_item_version()
returns trigger language plpgsql set search_path = '' as $$
begin new.version := old.version + 1; new.updated_at := now(); return new; end $$;
drop trigger if exists work_items_version on public.work_items;
create trigger work_items_version before update on public.work_items
  for each row execute function public.bump_work_item_version();

create or replace function public.record_created_work_item()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.work_item_events(work_item_id,brewery_id,operator_id,event_type,new_status,details)
  values(new.id,new.brewery_id,nullif(current_setting('app.operator_id',true),'')::uuid,'created','todo',jsonb_build_object('generated',true));
  return new;
end $$;
drop trigger if exists work_items_created_event on public.work_items;
create trigger work_items_created_event after insert on public.work_items
  for each row execute function public.record_created_work_item();

create or replace function public.upsert_work_items(session_token text, generated_items jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  acting_operator uuid := public.validate_operator_session(session_token);
  target_brewery uuid := public.current_brewery_id();
  item jsonb;
  inserted_id uuid;
begin
  if acting_operator is null then raise exception 'Operator session invalid or expired'; end if;
  perform set_config('app.operator_id',acting_operator::text,true);
  for item in select value from jsonb_array_elements(coalesce(generated_items, '[]'::jsonb)) loop
    if item->>'occurrence_key' is null or item->>'label' is null or item->>'due_at' is null then
      raise exception 'Invalid generated work item';
    end if;
    if nullif(item->>'batch_id','') is not null and not exists (
      select 1 from public.batches b where b.id=(item->>'batch_id')::uuid
        and b.brewery_id=target_brewery and b.deleted_at is null
    ) then raise exception 'Work item batch not found'; end if;
    insert into public.work_items (brewery_id,batch_id,occurrence_key,work_type,label,source,due_at)
    values (target_brewery,nullif(item->>'batch_id','')::uuid,item->>'occurrence_key',item->>'work_type',
      item->>'label',coalesce(item->>'source','process'),(item->>'due_at')::timestamptz)
    on conflict (brewery_id,occurrence_key) do update set
      label=excluded.label,
      due_at=case when public.work_items.status='todo' then excluded.due_at else public.work_items.due_at end,
      source=excluded.source
    where public.work_items.label is distinct from excluded.label
      or public.work_items.source is distinct from excluded.source
      or (public.work_items.status='todo' and public.work_items.due_at is distinct from excluded.due_at)
    returning id into inserted_id;
  end loop;
end $$;

create or replace function public.transition_work_item(
  session_token text, target_work_item_id uuid, transition text,
  expected_version integer, reason text default null, new_due_at timestamptz default null,
  measurement_id uuid default null, action_id uuid default null
) returns void language plpgsql security definer set search_path = '' as $$
declare
  acting_operator uuid := public.validate_operator_session(session_token);
  target_brewery uuid := public.current_brewery_id();
  item public.work_items%rowtype;
  next_status text;
begin
  if acting_operator is null then raise exception 'Operator session invalid or expired'; end if;
  select * into item from public.work_items w where w.id=target_work_item_id and w.brewery_id=target_brewery for update;
  if item.id is null then raise exception 'Darbs nav atrasts'; end if;
  if item.version <> expected_version then raise exception 'VERSION_CONFLICT: task server %, device %',item.version,expected_version; end if;
  if transition='accept' then
    if item.status not in ('todo','postponed') then raise exception 'Darbu vairs nevar pieņemt'; end if;
    next_status := 'accepted';
    update public.work_items set status=next_status,accepted_by=acting_operator,accepted_at=now() where id=item.id;
  elsif transition='complete' then
    if item.status <> 'accepted' then raise exception 'Darbs vispirms jāpieņem'; end if;
    if measurement_id is not null and not exists(select 1 from public.measurements m join public.batches b on b.id=m.batch_id where m.id=measurement_id and b.brewery_id=target_brewery and (item.batch_id is null or b.id=item.batch_id)) then raise exception 'Mērījums neatbilst darbam'; end if;
    if action_id is not null and not exists(select 1 from public.process_actions a join public.batches b on b.id=a.batch_id where a.id=action_id and b.brewery_id=target_brewery and (item.batch_id is null or b.id=item.batch_id)) then raise exception 'Darbība neatbilst darbam'; end if;
    if item.work_type='measure' and measurement_id is null then raise exception 'Mērījuma darbam vajag saglabātu mērījumu'; end if;
    if item.work_type in ('spund','dry_hop','cool') and (measurement_id is null or action_id is null) then raise exception 'Procesa darbam vajag darbību un mērījumu'; end if;
    if item.work_type in ('filter','package') then raise exception 'Filtrēšanas un pildīšanas darbu pabeidz kopā ar procesa ierakstu'; end if;
    next_status := 'completed';
    update public.work_items set status=next_status,completed_by=acting_operator,completed_at=now(),linked_measurement_id=measurement_id,linked_action_id=action_id where id=item.id;
  elsif transition='postpone' then
    if item.status not in ('todo','accepted','postponed') then raise exception 'Darbu vairs nevar atlikt'; end if;
    if nullif(trim(reason),'') is null or new_due_at is null or new_due_at <= now() then raise exception 'Atlikšanai vajag iemeslu un nākotnes datumu'; end if;
    next_status := 'postponed';
    update public.work_items set status=next_status,due_at=new_due_at,postponed_by=acting_operator,postponed_at=now(),postpone_reason=reason where id=item.id;
  elsif transition='skip' then
    if item.status in ('completed','skipped') then raise exception 'Darbs jau ir noslēgts'; end if;
    if nullif(trim(reason),'') is null then raise exception 'Izlaišanai vajag paskaidrojumu'; end if;
    next_status := 'skipped';
    update public.work_items set status=next_status,skipped_by=acting_operator,skipped_at=now(),skip_reason=reason where id=item.id;
  else raise exception 'Neatbalstīta darba pāreja'; end if;
  insert into public.work_item_events(work_item_id,brewery_id,operator_id,event_type,previous_status,new_status,reason,details)
  values(item.id,target_brewery,acting_operator,
    case transition when 'accept' then 'accepted' when 'complete' then 'completed' when 'postpone' then 'postponed' else 'skipped' end,
    item.status,next_status,reason,jsonb_build_object('new_due_at',new_due_at,'measurement_id',measurement_id,'action_id',action_id));
end $$;

create or replace function public.sync_operator_work_event(
  session_token text, expected_operator_id uuid, entity_type text, operation_type text,
  payload jsonb, expected_version integer, change_reason text,
  target_work_item_id uuid, work_item_expected_version integer
) returns void language plpgsql security definer set search_path = '' as $$
declare
  acting_operator uuid := public.validate_operator_session(session_token);
  target_brewery uuid := public.current_brewery_id();
  item public.work_items%rowtype;
  measurement_id uuid;
  action_id uuid;
  packaging_id uuid;
  actual_action_type text;
begin
  if acting_operator is null or acting_operator <> expected_operator_id then raise exception 'Operator session invalid or expired'; end if;
  select * into item from public.work_items w where w.id=target_work_item_id and w.brewery_id=target_brewery for update;
  if item.id is null then raise exception 'Darbs nav atrasts'; end if;
  if item.status <> 'accepted' then raise exception 'Darbs vispirms jāpieņem'; end if;
  if item.version <> work_item_expected_version then raise exception 'VERSION_CONFLICT: task server %, device %',item.version,work_item_expected_version; end if;

  if entity_type='processBundle' then
    measurement_id := nullif(payload->'measurement'->'item'->>'id','')::uuid;
    action_id := nullif(payload->'action'->'item'->>'id','')::uuid;
    actual_action_type := payload->'action'->'item'->>'action_type';
    if item.work_type <> actual_action_type or item.work_type not in ('spund','dry_hop','cool') then raise exception 'Darbības veids neatbilst pieņemtajam darbam'; end if;
  elsif entity_type='measurement' then
    measurement_id := nullif(payload->'item'->>'id','')::uuid;
    if item.work_type <> 'measure' then raise exception 'Mērījums neatbilst pieņemtajam darbam'; end if;
  elsif entity_type='packagingRun' then
    packaging_id := nullif(payload->'item'->>'id','')::uuid;
    if item.work_type not in ('filter','package') then raise exception 'Pildīšanas cikls neatbilst pieņemtajam darbam'; end if;
    if item.work_type='filter' and operation_type <> 'create' then raise exception 'Filtrēšanas darbam vajag jaunu filtrēšanas ierakstu'; end if;
    if item.work_type='package' and operation_type <> 'update' then raise exception 'Pildīšanas darbam vajag pildīšanas ierakstu'; end if;
  elsif entity_type='packagingCompletion' then
    packaging_id := nullif(payload->'packaging'->'item'->>'id','')::uuid;
    action_id := nullif(payload->'action'->'item'->>'id','')::uuid;
    if item.work_type <> 'package' then raise exception 'Pildīšana neatbilst pieņemtajam darbam'; end if;
  else
    raise exception 'Šo izmaiņu nevar sasaistīt ar procesa darbu';
  end if;

  perform public.sync_operator_event_v2(session_token,expected_operator_id,entity_type,operation_type,payload,expected_version,change_reason);
  if measurement_id is not null and not exists(select 1 from public.measurements m where m.id=measurement_id and m.batch_id=item.batch_id and m.deleted_at is null) then raise exception 'Mērījuma pierādījums nav saglabāts'; end if;
  if action_id is not null and not exists(select 1 from public.process_actions a where a.id=action_id and a.batch_id=item.batch_id and a.deleted_at is null) then raise exception 'Darbības pierādījums nav saglabāts'; end if;
  if packaging_id is not null and not exists(select 1 from public.packaging_runs p where p.id=packaging_id and p.batch_id=item.batch_id and p.deleted_at is null) then raise exception 'Pildīšanas pierādījums nav saglabāts'; end if;

  perform set_config('app.operator_id',acting_operator::text,true);
  update public.work_items set status='completed',completed_by=acting_operator,completed_at=now(),
    linked_measurement_id=measurement_id,linked_action_id=action_id,linked_packaging_run_id=packaging_id where id=item.id;
  insert into public.work_item_events(work_item_id,brewery_id,operator_id,event_type,previous_status,new_status,details)
  values(item.id,target_brewery,acting_operator,'completed',item.status,'completed',jsonb_build_object('measurement_id',measurement_id,'action_id',action_id,'packaging_run_id',packaging_id));
end $$;

revoke all on function public.upsert_work_items(text,jsonb), public.transition_work_item(text,uuid,text,integer,text,timestamptz,uuid,uuid) from public;
grant execute on function public.upsert_work_items(text,jsonb), public.transition_work_item(text,uuid,text,integer,text,timestamptz,uuid,uuid) to authenticated;
revoke all on function public.sync_operator_work_event(text,uuid,text,text,jsonb,integer,text,uuid,integer) from public;
grant execute on function public.sync_operator_work_event(text,uuid,text,text,jsonb,integer,text,uuid,integer) to authenticated;
