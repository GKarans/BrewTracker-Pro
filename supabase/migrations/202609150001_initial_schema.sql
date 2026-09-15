create extension if not exists pgcrypto;

create type public.batch_status as enum ('active', 'dry_hop', 'cooling', 'finished');
create type public.process_action_type as enum ('spund', 'dry_hop', 'cool', 'finish');

create table public.breweries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.operators (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  name text not null,
  pin_hash text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (brewery_id, name)
);

create table public.fermenters (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  number smallint not null check (number between 1 and 13),
  name text,
  created_at timestamptz not null default now(),
  unique (brewery_id, number)
);

create table public.beer_types (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  name text not null,
  og_target smallint not null check (og_target between 950 and 1200),
  fg_target smallint not null check (fg_target between 950 and 1200),
  spund_gravity smallint not null check (spund_gravity between 950 and 1200),
  has_dry_hop boolean not null default false,
  dry_hop_gravity smallint check (dry_hop_gravity between 950 and 1200),
  cooling_gravity smallint not null check (cooling_gravity between 950 and 1200),
  co2_target numeric(3,1) not null check (co2_target between 1 and 4),
  created_at timestamptz not null default now(),
  unique (brewery_id, name),
  check ((has_dry_hop and dry_hop_gravity is not null) or (not has_dry_hop and dry_hop_gravity is null))
);

create table public.batches (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  beer_type_id uuid not null references public.beer_types(id),
  fermenter_id uuid not null references public.fermenters(id),
  batch_number text not null,
  brew_year smallint not null,
  sequence_number smallint not null check (sequence_number between 1 and 999),
  volume_tons numeric(6,2) not null check (volume_tons > 0),
  brew_date date not null,
  status public.batch_status not null default 'active',
  og_target smallint not null,
  fg_target smallint not null,
  spund_gravity smallint not null,
  has_dry_hop boolean not null,
  dry_hop_gravity smallint,
  cooling_gravity smallint not null,
  co2_target numeric(3,1) not null,
  created_by uuid not null references public.operators(id),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (brewery_id, batch_number),
  unique (brewery_id, brew_year, sequence_number)
);

create unique index one_active_batch_per_fermenter
  on public.batches (fermenter_id)
  where status <> 'finished';

create table public.measurements (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  operator_id uuid not null references public.operators(id),
  measured_at timestamptz not null default now(),
  gravity smallint not null check (gravity between 950 and 1200),
  ph numeric(4,2) not null check (ph between 0 and 14),
  temperature_c numeric(4,1) not null check (temperature_c between -5 and 50),
  pressure_bar numeric(4,2) check (pressure_bar between 0 and 5),
  note text,
  client_id uuid not null unique,
  created_at timestamptz not null default now()
);

create table public.process_actions (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.batches(id) on delete cascade,
  operator_id uuid not null references public.operators(id),
  action_type public.process_action_type not null,
  performed_at timestamptz not null default now(),
  gravity smallint not null,
  ph numeric(4,2) not null,
  temperature_c numeric(4,1) not null,
  pressure_bar numeric(4,2),
  note text,
  client_id uuid not null unique,
  created_at timestamptz not null default now(),
  unique (batch_id, action_type)
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  brewery_id uuid not null references public.breweries(id),
  operator_id uuid references public.operators(id),
  table_name text not null,
  row_id uuid not null,
  operation text not null check (operation in ('insert', 'update', 'delete')),
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

alter table public.breweries enable row level security;
alter table public.operators enable row level security;
alter table public.fermenters enable row level security;
alter table public.beer_types enable row level security;
alter table public.batches enable row level security;
alter table public.measurements enable row level security;
alter table public.process_actions enable row level security;
alter table public.audit_log enable row level security;

create or replace function public.current_brewery_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.breweries where auth_user_id = auth.uid() limit 1
$$;

create policy "own brewery" on public.breweries for all to authenticated using (auth_user_id = auth.uid()) with check (auth_user_id = auth.uid());
create policy "own operators" on public.operators for all to authenticated using (brewery_id = public.current_brewery_id()) with check (brewery_id = public.current_brewery_id());
create policy "own fermenters" on public.fermenters for all to authenticated using (brewery_id = public.current_brewery_id()) with check (brewery_id = public.current_brewery_id());
create policy "own beer types" on public.beer_types for all to authenticated using (brewery_id = public.current_brewery_id()) with check (brewery_id = public.current_brewery_id());
create policy "own batches" on public.batches for all to authenticated using (brewery_id = public.current_brewery_id()) with check (brewery_id = public.current_brewery_id());
create policy "own measurements" on public.measurements for all to authenticated using (batch_id in (select id from public.batches where brewery_id = public.current_brewery_id())) with check (batch_id in (select id from public.batches where brewery_id = public.current_brewery_id()));
create policy "own actions" on public.process_actions for all to authenticated using (batch_id in (select id from public.batches where brewery_id = public.current_brewery_id())) with check (batch_id in (select id from public.batches where brewery_id = public.current_brewery_id()));
create policy "read own audit" on public.audit_log for select to authenticated using (brewery_id = public.current_brewery_id());

revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;

