alter table public.fermenters
  add column if not exists capacity_tons numeric(5,2),
  add column if not exists vessel_type text not null default 'fermenter'
    check (vessel_type in ('fermenter', 'brite'));

update public.fermenters
set capacity_tons = case
  when number between 1 and 9 then 4
  when number = 10 then 1
  when number in (11, 12) then 8
  when number = 13 then 4
end,
name = case when number = 13 then 'Dzidra' else 'Tvertne ' || number end,
vessel_type = case when number = 13 then 'brite' else 'fermenter' end;

alter table public.fermenters alter column capacity_tons set not null;

create type public.packaging_run_status as enum ('filtered', 'packaged');

create table public.packaging_runs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  run_number smallint not null check (run_number between 1 and 2),
  volume_tons numeric(5,2) not null check (volume_tons > 0 and volume_tons <= 4),
  status public.packaging_run_status not null default 'filtered',
  filtered_at timestamptz not null default now(),
  packaged_at timestamptz,
  gravity smallint not null check (gravity between 950 and 1200),
  ph numeric(4,2) not null check (ph between 0 and 14),
  temperature_c numeric(4,1) not null check (temperature_c between -5 and 50),
  pressure_bar numeric(4,2) check (pressure_bar between 0 and 5),
  co2_vol numeric(3,1) check (co2_vol between 0 and 5),
  operator_id uuid not null references public.operators(id),
  client_id uuid not null unique,
  created_at timestamptz not null default now(),
  unique (batch_id, run_number)
);

create unique index one_batch_in_brite_tank
  on public.packaging_runs ((status))
  where status = 'filtered';

alter table public.packaging_runs enable row level security;

create policy "own packaging runs"
on public.packaging_runs for all to authenticated
using (
  batch_id in (
    select id from public.batches
    where brewery_id = public.current_brewery_id()
  )
)
with check (
  batch_id in (
    select id from public.batches
    where brewery_id = public.current_brewery_id()
  )
);

create or replace function public.validate_batch_fermenter()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  vessel public.fermenters;
begin
  select * into vessel from public.fermenters where id = new.fermenter_id;
  if vessel.id is null or vessel.vessel_type <> 'fermenter' then
    raise exception 'Batch must use a fermentation vessel';
  end if;
  if new.volume_tons > vessel.capacity_tons then
    raise exception 'Batch volume exceeds vessel capacity';
  end if;
  return new;
end;
$$;

create trigger validate_batch_fermenter_before_write
before insert or update of fermenter_id, volume_tons on public.batches
for each row execute function public.validate_batch_fermenter();

create or replace function public.finish_packaging_run(run_id uuid)
returns public.packaging_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_run public.packaging_runs;
  target_batch public.batches;
  packaged_volume numeric;
begin
  select packaging_run.* into target_run
  from public.packaging_runs packaging_run
  join public.batches batch on batch.id = packaging_run.batch_id
  where packaging_run.id = run_id
    and batch.brewery_id = public.current_brewery_id();

  if target_run.id is null then raise exception 'Packaging run not found'; end if;

  update public.packaging_runs
  set status = 'packaged', packaged_at = now()
  where id = run_id
  returning * into target_run;

  select * into target_batch from public.batches where id = target_run.batch_id;
  select coalesce(sum(volume_tons), 0) into packaged_volume
  from public.packaging_runs
  where batch_id = target_batch.id and status = 'packaged';

  if packaged_volume >= target_batch.volume_tons then
    update public.batches
    set status = 'finished', finished_at = now()
    where id = target_batch.id;
  end if;

  return target_run;
end;
$$;

revoke all on function public.finish_packaging_run(uuid) from public;
grant execute on function public.finish_packaging_run(uuid) to authenticated;
