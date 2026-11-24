-- Phase 5: stage-by-stage volume ledger.  The centrifuge meter is explicitly
-- stored as gross throughput; it is never treated as product in Dzidra.

alter table public.packaging_runs
  add column if not exists source_drawn_liters numeric(10,1) check (source_drawn_liters is null or source_drawn_liters >= 0),
  add column if not exists brite_received_liters numeric(10,1) check (brite_received_liters is null or brite_received_liters >= 0),
  add column if not exists packaged_liters numeric(10,1) check (packaged_liters is null or packaged_liters >= 0),
  add column if not exists volume_override_reason text;

create table if not exists public.volume_events (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  batch_id uuid not null references public.batches(id) on delete cascade,
  packaging_run_id uuid references public.packaging_runs(id) on delete cascade,
  stage text not null check (stage in (
    'batch_brewed','kettle_residue_estimate','source_to_centrifuge',
    'centrifuge_gross_throughput','brite_received','packaged_output',
    'fermenter_heel_estimate'
  )),
  liters numeric(10,1) not null check (liters >= 0),
  is_measured boolean not null,
  source_device text,
  note text,
  operator_id uuid references public.operators(id),
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists volume_events_batch_recorded_idx on public.volume_events(batch_id, recorded_at desc);
create index if not exists volume_events_run_idx on public.volume_events(packaging_run_id, recorded_at desc);
alter table public.volume_events enable row level security;
revoke all on public.volume_events from anon, authenticated;
grant select on public.volume_events to authenticated;
drop policy if exists "read own volume events" on public.volume_events;
create policy "read own volume events" on public.volume_events for select to authenticated
  using (brewery_id=public.current_brewery_id());

create or replace function public.record_batch_volume_baseline()
returns trigger language plpgsql security definer set search_path='' as $$
declare op uuid:=nullif(current_setting('app.operator_id',true),'')::uuid;
begin
  insert into public.volume_events(brewery_id,batch_id,stage,liters,is_measured,source_device,note,operator_id,recorded_at)
  values(new.brewery_id,new.id,'batch_brewed',new.volume_tons*1000,true,'batch','Partijas nominālais apjoms',op,new.created_at),
    (new.brewery_id,new.id,'kettle_residue_estimate',ceil(new.volume_tons/2.0)*150,false,'estimate','150 l pēc katriem 2 t vārījuma',op,new.created_at);
  return new;
end $$;
drop trigger if exists batches_volume_baseline on public.batches;
create trigger batches_volume_baseline after insert on public.batches
for each row execute function public.record_batch_volume_baseline();

-- Backfill the two known nominal boundaries without inventing a measurement.
insert into public.volume_events(brewery_id,batch_id,stage,liters,is_measured,source_device,note,recorded_at)
select b.brewery_id,b.id,'batch_brewed',b.volume_tons*1000,true,'batch','Partijas nominālais apjoms',b.created_at
from public.batches b where not exists(select 1 from public.volume_events e where e.batch_id=b.id and e.stage='batch_brewed');
insert into public.volume_events(brewery_id,batch_id,stage,liters,is_measured,source_device,note,recorded_at)
select b.brewery_id,b.id,'kettle_residue_estimate',ceil(b.volume_tons/2.0)*150,false,'estimate','150 l pēc katriem 2 t vārījuma',b.created_at
from public.batches b where not exists(select 1 from public.volume_events e where e.batch_id=b.id and e.stage='kettle_residue_estimate');

-- The current secure sync RPC puts the packaging item in transaction-local
-- context.  A BEFORE trigger copies it into the row, so it remains one update
-- and one optimistic-version increment even when an offline queue is replayed.
create or replace function public.apply_packaging_volume_context()
returns trigger language plpgsql security definer set search_path='' as $$
declare item jsonb:=coalesce(nullif(current_setting('app.packaging_volume_context',true),'')::jsonb,'{}'::jsonb);
  target_batch public.batches%rowtype; other_source numeric:=0; reason text;
begin
  if item='{}'::jsonb then return new; end if;
  new.source_drawn_liters:=nullif(item->>'source_drawn_liters','')::numeric;
  new.brite_received_liters:=nullif(item->>'brite_received_liters','')::numeric;
  new.packaged_liters:=nullif(item->>'packaged_liters','')::numeric;
  new.volume_override_reason:=nullif(trim(item->>'volume_override_reason'),'');
  reason:=new.volume_override_reason;
  select * into target_batch from public.batches where id=new.batch_id for update;
  select coalesce(sum(p.source_drawn_liters),0) into other_source from public.packaging_runs p
    where p.batch_id=new.batch_id and p.id<>new.id and p.deleted_at is null;
  if new.source_drawn_liters is not null and other_source+new.source_drawn_liters > target_batch.volume_tons*1000 and reason is null then
    raise exception 'VOLUME_BOUNDARY_EXCEEDED: uz centrifūgu norādīts vairāk nekā partijas nominālais apjoms; pievieno pamatojumu';
  end if;
  if new.source_drawn_liters is not null and new.brite_received_liters is not null
    and new.brite_received_liters > new.source_drawn_liters and reason is null then
    raise exception 'VOLUME_BOUNDARY_EXCEEDED: Dzidrā saņemts vairāk nekā aizlaists no tvertnes; pievieno pamatojumu';
  end if;
  if new.brite_received_liters is not null and new.packaged_liters is not null
    and new.packaged_liters > new.brite_received_liters and reason is null then
    raise exception 'VOLUME_BOUNDARY_EXCEEDED: sapildīts vairāk nekā Dzidrā saņemts; pievieno pamatojumu';
  end if;
  return new;
end $$;
drop trigger if exists packaging_volume_context on public.packaging_runs;
create trigger packaging_volume_context before insert or update on public.packaging_runs
for each row execute function public.apply_packaging_volume_context();

create or replace function public.record_packaging_volume_events()
returns trigger language plpgsql security definer set search_path='' as $$
declare op uuid:=nullif(current_setting('app.operator_id',true),'')::uuid;
begin
  if tg_op='INSERT' then
    if new.source_drawn_liters is not null then insert into public.volume_events(brewery_id,batch_id,packaging_run_id,stage,liters,is_measured,source_device,operator_id,recorded_at)
      select b.brewery_id,new.batch_id,new.id,'source_to_centrifuge',new.source_drawn_liters,true,'operator',op,coalesce(new.filtered_at,now()) from public.batches b where b.id=new.batch_id; end if;
    if new.centrifuge_liters is not null then insert into public.volume_events(brewery_id,batch_id,packaging_run_id,stage,liters,is_measured,source_device,note,operator_id,recorded_at)
      select b.brewery_id,new.batch_id,new.id,'centrifuge_gross_throughput',new.centrifuge_liters,true,'centrifuge','Bruto skaitītājs; ietver discharge/tīrīšanu',op,coalesce(new.filtered_at,now()) from public.batches b where b.id=new.batch_id; end if;
    if new.brite_received_liters is not null then insert into public.volume_events(brewery_id,batch_id,packaging_run_id,stage,liters,is_measured,source_device,operator_id,recorded_at)
      select b.brewery_id,new.batch_id,new.id,'brite_received',new.brite_received_liters,true,'Dzidra',op,coalesce(new.filtered_at,now()) from public.batches b where b.id=new.batch_id; end if;
  else
    if new.source_drawn_liters is distinct from old.source_drawn_liters and new.source_drawn_liters is not null then insert into public.volume_events(brewery_id,batch_id,packaging_run_id,stage,liters,is_measured,source_device,operator_id,recorded_at)
      select b.brewery_id,new.batch_id,new.id,'source_to_centrifuge',new.source_drawn_liters,true,'operator',op,coalesce(new.filtered_at,now()) from public.batches b where b.id=new.batch_id; end if;
    if new.centrifuge_liters is distinct from old.centrifuge_liters and new.centrifuge_liters is not null then insert into public.volume_events(brewery_id,batch_id,packaging_run_id,stage,liters,is_measured,source_device,note,operator_id,recorded_at)
      select b.brewery_id,new.batch_id,new.id,'centrifuge_gross_throughput',new.centrifuge_liters,true,'centrifuge','Bruto skaitītājs; ietver discharge/tīrīšanu',op,coalesce(new.filtered_at,now()) from public.batches b where b.id=new.batch_id; end if;
    if new.brite_received_liters is distinct from old.brite_received_liters and new.brite_received_liters is not null then insert into public.volume_events(brewery_id,batch_id,packaging_run_id,stage,liters,is_measured,source_device,operator_id,recorded_at)
      select b.brewery_id,new.batch_id,new.id,'brite_received',new.brite_received_liters,true,'Dzidra',op,coalesce(new.filtered_at,now()) from public.batches b where b.id=new.batch_id; end if;
    if new.packaged_liters is distinct from old.packaged_liters and new.packaged_liters is not null then insert into public.volume_events(brewery_id,batch_id,packaging_run_id,stage,liters,is_measured,source_device,operator_id,recorded_at)
      select b.brewery_id,new.batch_id,new.id,'packaged_output',new.packaged_liters,true,'packaging',op,coalesce(new.packaged_at,now()) from public.batches b where b.id=new.batch_id; end if;
  end if;
  return new;
end $$;
drop trigger if exists packaging_volume_events on public.packaging_runs;
create trigger packaging_volume_events after insert or update on public.packaging_runs
for each row execute function public.record_packaging_volume_events();

create or replace function public.record_final_fermenter_heel_estimate()
returns trigger language plpgsql security definer set search_path='' as $$
declare b public.batches%rowtype; completed_cycles integer; expected_cycles integer;
begin
  select * into b from public.batches where id=new.batch_id;
  select count(*) into completed_cycles from public.packaging_runs where batch_id=b.id and status='packaged' and deleted_at is null;
  expected_cycles:=ceil(b.volume_tons/4.0);
  if completed_cycles>=expected_cycles and not exists(select 1 from public.volume_events e where e.batch_id=b.id and e.stage='fermenter_heel_estimate') then
    insert into public.volume_events(brewery_id,batch_id,stage,liters,is_measured,source_device,note,operator_id,recorded_at)
    values(b.brewery_id,b.id,'fermenter_heel_estimate',case when b.volume_tons>4 then 350 else 200 end,false,'estimate',
      case when b.volume_tons>4 then '8 t tvertnes rauga/apaļas atlikuma novērtējums' else '4 t tvertnes rauga/apaļas atlikuma novērtējums' end,
      nullif(current_setting('app.operator_id',true),'')::uuid,coalesce(new.packaged_at,now()));
  end if;
  return new;
end $$;
drop trigger if exists packaging_final_heel_estimate on public.packaging_runs;
create trigger packaging_final_heel_estimate after insert or update of status on public.packaging_runs
for each row execute function public.record_final_fermenter_heel_estimate();

create or replace function public.sync_operator_event_v4(session_token text, expected_operator_id uuid, entity_type text, operation_type text,
  payload jsonb, expected_version integer default 0, change_reason text default null)
returns void language plpgsql security definer set search_path='' as $$
declare item jsonb;
begin
  item:=case when entity_type='packagingCompletion' then payload->'packaging'->'item' when entity_type='packagingRun' then payload->'item' else '{}'::jsonb end;
  perform set_config('app.packaging_volume_context',coalesce(item::text,'{}'),true);
  perform public.sync_operator_event_v3(session_token,expected_operator_id,entity_type,operation_type,payload,expected_version,change_reason);
end $$;

create or replace function public.sync_operator_work_event_v4(session_token text, expected_operator_id uuid, entity_type text, operation_type text,
  payload jsonb, expected_version integer, change_reason text, target_work_item_id uuid, work_item_expected_version integer)
returns void language plpgsql security definer set search_path='' as $$
declare item jsonb;
begin
  item:=case when entity_type='packagingCompletion' then payload->'packaging'->'item' when entity_type='packagingRun' then payload->'item' else '{}'::jsonb end;
  perform set_config('app.packaging_volume_context',coalesce(item::text,'{}'),true);
  perform public.sync_operator_work_event_v3(session_token,expected_operator_id,entity_type,operation_type,payload,expected_version,change_reason,target_work_item_id,work_item_expected_version);
end $$;

revoke all on function public.sync_operator_event_v4(text,uuid,text,text,jsonb,integer,text),
  public.sync_operator_work_event_v4(text,uuid,text,text,jsonb,integer,text,uuid,integer) from public;
revoke all on function public.sync_operator_event_v3(text,uuid,text,text,jsonb,integer,text),
  public.sync_operator_work_event_v3(text,uuid,text,text,jsonb,integer,text,uuid,integer) from authenticated;
grant execute on function public.sync_operator_event_v4(text,uuid,text,text,jsonb,integer,text),
  public.sync_operator_work_event_v4(text,uuid,text,text,jsonb,integer,text,uuid,integer) to authenticated;
