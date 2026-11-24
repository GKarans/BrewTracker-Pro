-- Phase 6: configuration for a fail-closed carbonation advisory.
-- It stores inputs and acknowledgements only; it never controls a valve or
-- calculates/sends a pressure setpoint on its own.

-- The device/method belongs to the concrete CO2 observation.  A batch-level
-- configuration would make historical CO2 values look more certain than they are.
alter table public.measurements
  add column if not exists co2_measurement_method text;

create or replace function public.capture_measurement_co2_method()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.co2_vol is null then
    new.co2_measurement_method := null;
  else
    new.co2_measurement_method := nullif(trim(current_setting('app.co2_measurement_method', true)), '');
  end if;
  return new;
end $$;

drop trigger if exists measurements_capture_co2_method on public.measurements;
create trigger measurements_capture_co2_method
  before insert or update of co2_vol, co2_measurement_method on public.measurements
  for each row execute function public.capture_measurement_co2_method();

-- sync_operator_event_v3 calls this context setter before each measurement
-- write.  Preserve the anomaly context and add the method for the same
-- transaction, so the browser cannot attach a method to a different row.
create or replace function public.set_measurement_anomaly_context(payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare item jsonb;
begin
  item := case when payload->'measurement'->'item' is not null then payload->'measurement'->'item' else payload->'item' end;
  perform set_config('app.anomaly_warning_codes', coalesce((item->'warning_codes')::text,'[]'), true);
  perform set_config('app.anomaly_confirmed', case when nullif(item->>'anomaly_confirmed_at','') is null then 'false' else 'true' end, true);
  perform set_config('app.anomaly_reason', coalesce(item->>'anomaly_reason',''), true);
  perform set_config('app.anomaly_baseline_id', coalesce(item->>'anomaly_baseline_measurement_id',''), true);
  perform set_config('app.anomaly_action_type', coalesce(item->>'action_type',''), true);
  perform set_config('app.co2_measurement_method', coalesce(item->>'co2_measurement_method',''), true);
end $$;

create table if not exists public.batch_carbonation_advisories (
  batch_id uuid primary key references public.batches(id) on delete cascade,
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  confirmed_terminal_gravity integer,
  beer_volume_liters numeric,
  headspace_liters numeric,
  hardware_max_bar numeric,
  prv_limit_bar numeric,
  device_limit_bar numeric,
  co2_measurement_method text,
  pressure_basis text check (pressure_basis in ('gauge')),
  altitude_meters numeric,
  hop_creep_acknowledged boolean not null default false,
  updated_by uuid references public.operators(id),
  updated_at timestamptz not null default now(),
  check (confirmed_terminal_gravity is null or confirmed_terminal_gravity between 1000 and 1200),
  check (beer_volume_liters is null or beer_volume_liters > 0),
  check (headspace_liters is null or headspace_liters > 0),
  check (hardware_max_bar is null or hardware_max_bar > 0),
  check (prv_limit_bar is null or prv_limit_bar > 0),
  check (device_limit_bar is null or device_limit_bar > 0),
  check (altitude_meters is null or altitude_meters between -500 and 9000)
);

alter table public.batch_carbonation_advisories enable row level security;
revoke all on public.batch_carbonation_advisories from anon, authenticated;
grant select on public.batch_carbonation_advisories to authenticated;
drop policy if exists "read own carbonation advisory" on public.batch_carbonation_advisories;
create policy "read own carbonation advisory" on public.batch_carbonation_advisories
  for select to authenticated using (brewery_id=public.current_brewery_id());

create or replace function public.upsert_batch_carbonation_advisory(
  session_token text,
  target_batch_id uuid,
  terminal_gravity integer,
  beer_liters numeric,
  headspace numeric,
  hardware_limit numeric,
  prv_limit numeric,
  device_limit numeric,
  co2_method text,
  basis text,
  altitude numeric,
  acknowledge_hop_creep boolean default false
)
returns public.batch_carbonation_advisories
language plpgsql security definer set search_path='' as $$
declare
  op uuid:=public.validate_operator_session(session_token);
  target_brewery uuid:=public.current_brewery_id();
  result public.batch_carbonation_advisories;
begin
  if op is null then raise exception 'Operator session invalid or expired'; end if;
  if not exists(select 1 from public.batches where id=target_batch_id and brewery_id=target_brewery and deleted_at is null) then
    raise exception 'Partija nav atrasta';
  end if;
  if basis is not null and basis <> 'gauge' then raise exception 'Spiediena pamatam jābūt manometra (gauge) spiedienam'; end if;
  -- 2 bar is an operational ceiling, never a certified vessel rating.
  if hardware_limit is not null and hardware_limit > 2 then raise exception 'Ievadi faktiskās iekārtas robežas; padomdevējs nekad nelietos virs 2 bar'; end if;
  if prv_limit is not null and prv_limit > 2 then raise exception 'Ievadi faktiskās iekārtas robežas; padomdevējs nekad nelietos virs 2 bar'; end if;
  if device_limit is not null and device_limit > 2 then raise exception 'Ievadi faktiskās iekārtas robežas; padomdevējs nekad nelietos virs 2 bar'; end if;
  insert into public.batch_carbonation_advisories(
    batch_id,brewery_id,confirmed_terminal_gravity,beer_volume_liters,headspace_liters,
    hardware_max_bar,prv_limit_bar,device_limit_bar,co2_measurement_method,pressure_basis,altitude_meters,
    hop_creep_acknowledged,updated_by,updated_at
  ) values (
    target_batch_id,target_brewery,terminal_gravity,beer_liters,headspace,
    hardware_limit,prv_limit,device_limit,nullif(trim(co2_method),''),basis,altitude,coalesce(acknowledge_hop_creep,false),op,now()
  ) on conflict(batch_id) do update set
    confirmed_terminal_gravity=excluded.confirmed_terminal_gravity,
    beer_volume_liters=excluded.beer_volume_liters,
    headspace_liters=excluded.headspace_liters,
    hardware_max_bar=excluded.hardware_max_bar,
    prv_limit_bar=excluded.prv_limit_bar,
    device_limit_bar=excluded.device_limit_bar,
    co2_measurement_method=excluded.co2_measurement_method,
    pressure_basis=excluded.pressure_basis,
    altitude_meters=excluded.altitude_meters,
    hop_creep_acknowledged=excluded.hop_creep_acknowledged,
    updated_by=excluded.updated_by,updated_at=now()
  returning * into result;
  return result;
end $$;

revoke all on function public.upsert_batch_carbonation_advisory(text,uuid,integer,numeric,numeric,numeric,numeric,numeric,text,text,numeric,boolean) from public;
grant execute on function public.upsert_batch_carbonation_advisory(text,uuid,integer,numeric,numeric,numeric,numeric,numeric,text,text,numeric,boolean) to authenticated;
