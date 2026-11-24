-- Trusted operator sessions. Idempotent because existing projects run this in SQL Editor.
create table if not exists public.operator_sessions (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  operator_id uuid not null references public.operators(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.operator_auth_attempts (
  id bigint generated always as identity primary key,
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  operator_id uuid not null references public.operators(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  succeeded boolean not null default false
);
drop index if exists public.operator_sessions_active_lookup_idx;
create index if not exists operator_sessions_active_lookup_idx on public.operator_sessions (brewery_id, expires_at) where revoked_at is null;
create index if not exists operator_auth_attempts_rate_idx on public.operator_auth_attempts (brewery_id, operator_id, attempted_at desc);
alter table public.operator_sessions enable row level security;
alter table public.operator_auth_attempts enable row level security;
revoke all on public.operator_sessions from anon, authenticated;
revoke all on public.operator_auth_attempts from anon, authenticated;

create or replace function public.create_operator_session(target_operator_id uuid, operator_pin text)
returns table (session_token text, operator_id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  target_brewery_id uuid := public.current_brewery_id();
  target_operator public.operators;
  recent_failures integer;
  raw_token text;
  token_expires_at timestamptz := now() + interval '12 hours';
begin
  if target_brewery_id is null then raise exception 'Authentication required'; end if;
  perform pg_advisory_xact_lock(hashtext(target_brewery_id::text || target_operator_id::text));
  select * into target_operator from public.operators
  where id = target_operator_id and brewery_id = target_brewery_id and is_active;
  select count(*) into recent_failures from public.operator_auth_attempts
  where brewery_id = target_brewery_id and operator_id = target_operator_id
    and not succeeded and attempted_at > now() - interval '15 minutes';
  if recent_failures >= 5 then raise exception 'PIN temporarily locked. Try again in 15 minutes.'; end if;
  if target_operator.id is null or target_operator.pin_hash <> extensions.crypt(operator_pin, target_operator.pin_hash) then
    if target_operator.id is not null then
      insert into public.operator_auth_attempts (brewery_id, operator_id, succeeded)
      values (target_brewery_id, target_operator_id, false);
    end if;
    return;
  end if;
  insert into public.operator_auth_attempts (brewery_id, operator_id, succeeded)
  values (target_brewery_id, target_operator_id, true);
  delete from public.operator_auth_attempts where brewery_id = target_brewery_id
    and operator_id = target_operator_id and not succeeded;
  delete from public.operator_auth_attempts where brewery_id = target_brewery_id
    and operator_id = target_operator_id and attempted_at < now() - interval '24 hours';
  update public.operator_sessions set revoked_at = now()
  where brewery_id = target_brewery_id and operator_id = target_operator_id
    and revoked_at is null and expires_at > now();
  delete from public.operator_sessions where brewery_id = target_brewery_id
    and (expires_at <= now() or revoked_at is not null) and created_at < now() - interval '24 hours';
  raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.operator_sessions (brewery_id, operator_id, token_hash, expires_at)
  values (target_brewery_id, target_operator_id, encode(extensions.digest(raw_token, 'sha256'), 'hex'), token_expires_at);
  return query select raw_token, target_operator_id, token_expires_at;
end; $$;

create or replace function public.validate_operator_session(session_token text)
returns uuid language sql stable security definer set search_path = '' as $$
  select s.operator_id from public.operator_sessions s
  join public.operators o on o.id = s.operator_id and o.brewery_id = s.brewery_id
  where s.brewery_id = public.current_brewery_id()
    and s.token_hash = encode(extensions.digest(session_token, 'sha256'), 'hex')
    and s.revoked_at is null and s.expires_at > now() and o.is_active limit 1
$$;

create or replace function public.revoke_operator_session(session_token text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.operator_sessions set revoked_at = now()
  where brewery_id = public.current_brewery_id()
    and token_hash = encode(extensions.digest(session_token, 'sha256'), 'hex') and revoked_at is null;
  return found;
end; $$;

create or replace function public.change_operator_pin_with_session(session_token text, current_pin text, new_pin text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare target_operator_id uuid; target_operator public.operators; target_brewery_id uuid := public.current_brewery_id(); recent_failures integer;
begin
  target_operator_id := public.validate_operator_session(session_token);
  if target_operator_id is null then raise exception 'Operator session invalid or expired'; end if;
  perform pg_advisory_xact_lock(hashtext(target_brewery_id::text || target_operator_id::text));
  select * into target_operator from public.operators where id = target_operator_id for update;
  select count(*) into recent_failures from public.operator_auth_attempts
  where brewery_id = target_brewery_id and operator_id = target_operator_id
    and not succeeded and attempted_at > now() - interval '15 minutes';
  if recent_failures >= 5 then raise exception 'PIN temporarily locked. Try again in 15 minutes.'; end if;
  if target_operator.pin_hash <> extensions.crypt(current_pin, target_operator.pin_hash) then
    insert into public.operator_auth_attempts (brewery_id, operator_id, succeeded)
    values (target_brewery_id, target_operator_id, false);
    return false;
  end if;
  if length(new_pin) < 4 or length(new_pin) > 8 or new_pin !~ '^[0-9]+$' then raise exception 'New PIN must contain 4 to 8 digits'; end if;
  update public.operators set pin_hash = extensions.crypt(new_pin, extensions.gen_salt('bf')) where id = target_operator_id;
  delete from public.operator_auth_attempts where brewery_id = target_brewery_id
    and operator_id = target_operator_id and not succeeded;
  update public.operator_sessions set revoked_at = now() where operator_id = target_operator_id
    and brewery_id = public.current_brewery_id() and revoked_at is null;
  return true;
end; $$;

create or replace function public.set_operator_active_with_session(session_token text, target_operator_id uuid, active boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare acting_operator_id uuid;
begin
  acting_operator_id := public.validate_operator_session(session_token);
  if acting_operator_id is null then raise exception 'Operator session invalid or expired'; end if;
  if not active and (select count(*) from public.operators where brewery_id = public.current_brewery_id() and is_active) <= 1 then
    raise exception 'The last active operator cannot be deactivated';
  end if;
  update public.operators set is_active = active where id = target_operator_id and brewery_id = public.current_brewery_id();
  if not found then return false; end if;
  if not active then update public.operator_sessions set revoked_at = now()
    where operator_id = target_operator_id and brewery_id = public.current_brewery_id() and revoked_at is null; end if;
  return true;
end; $$;

create or replace function public.create_operator_with_session(session_token text, operator_name text, operator_pin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare acting_operator_id uuid; created_operator public.operators;
begin
  acting_operator_id := public.validate_operator_session(session_token);
  if acting_operator_id is null then raise exception 'Operator session invalid or expired'; end if;
  if length(operator_pin) < 4 or length(operator_pin) > 8 or operator_pin !~ '^[0-9]+$' then raise exception 'PIN must contain 4 to 8 digits'; end if;
  insert into public.operators (brewery_id,name,pin_hash)
  values (public.current_brewery_id(),trim(operator_name),extensions.crypt(operator_pin,extensions.gen_salt('bf')))
  returning * into created_operator;
  return jsonb_build_object(
    'id', created_operator.id,
    'brewery_id', created_operator.brewery_id,
    'name', created_operator.name,
    'is_active', created_operator.is_active,
    'created_at', created_operator.created_at
  );
end; $$;

create or replace function public.reset_brewing_data_with_session(session_token text, confirmation_text text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare acting_operator_id uuid;
begin
  acting_operator_id := public.validate_operator_session(session_token);
  if acting_operator_id is null then raise exception 'Operator session invalid or expired'; end if;
  return public.reset_brewing_data(confirmation_text);
end; $$;

-- The browser sends data, but the operator identity always comes from the session.
create or replace function public.sync_operator_event(session_token text, expected_operator_id uuid, entity_type text, operation_type text, payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  acting_operator_id uuid := public.validate_operator_session(session_token);
  target_brewery_id uuid := public.current_brewery_id();
  b jsonb := payload->'batch'; beer jsonb := payload->'beer'; item jsonb := payload->'item';
  resolved_action_id uuid;
  affected_rows integer;
  target_fermenter_number smallint;
begin
  if acting_operator_id is null or acting_operator_id <> expected_operator_id then
    raise exception 'Operator session invalid, expired, or does not match offline event';
  end if;
  if entity_type = 'batch' and operation_type = 'delete' then
    delete from public.batches where id = (payload->>'entity_id')::uuid and brewery_id = target_brewery_id; return;
  end if;
  if entity_type = 'batch' then
    if (b->>'beer_type_id')::uuid <> (beer->>'id')::uuid then
      raise exception 'Batch beer type does not match synchronized beer';
    end if;
    if exists(select 1 from public.beer_types bt where bt.id=(beer->>'id')::uuid and bt.brewery_id<>target_brewery_id) then
      raise exception 'Beer type belongs to another brewery';
    end if;
    select f.number into target_fermenter_number from public.fermenters f
      where f.id=(b->>'fermenter_id')::uuid and f.brewery_id=target_brewery_id;
    if target_fermenter_number is null then
      raise exception 'Fermenter not found in this brewery';
    end if;
    if (b->>'brew_year')::integer < 2000 or (b->>'brew_year')::integer > 9999
      or (b->>'sequence_number')::integer < 1 or (b->>'sequence_number')::integer > 999 then
      raise exception 'Invalid batch year or sequence';
    end if;
    if b->>'batch_number' <> right(b->>'brew_year', 2)
      || lpad(b->>'sequence_number', 2, '0') || target_fermenter_number::text then
      raise exception 'Batch number does not match year, sequence, and fermenter';
    end if;
    if exists(select 1 from public.batches bx where bx.id=(b->>'id')::uuid and bx.brewery_id<>target_brewery_id) then
      raise exception 'Batch belongs to another brewery';
    end if;
    insert into public.beer_types (id,brewery_id,name,og_target,fg_target,spund_gravity,has_dry_hop,dry_hop_gravity,cooling_gravity,co2_target)
    values ((beer->>'id')::uuid,target_brewery_id,beer->>'name',(beer->>'og_target')::smallint,(beer->>'fg_target')::smallint,
      (beer->>'spund_gravity')::smallint,(beer->>'has_dry_hop')::boolean,nullif(beer->>'dry_hop_gravity','')::smallint,
      (beer->>'cooling_gravity')::smallint,(beer->>'co2_target')::numeric)
    on conflict (id) do update set name=excluded.name,og_target=excluded.og_target,fg_target=excluded.fg_target,
      spund_gravity=excluded.spund_gravity,has_dry_hop=excluded.has_dry_hop,dry_hop_gravity=excluded.dry_hop_gravity,
      cooling_gravity=excluded.cooling_gravity,co2_target=excluded.co2_target where public.beer_types.brewery_id=target_brewery_id;
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then raise exception 'Beer type synchronization rejected'; end if;
    insert into public.batches (id,brewery_id,beer_type_id,fermenter_id,batch_number,brew_year,sequence_number,volume_tons,brew_date,status,
      og_target,fg_target,spund_gravity,has_dry_hop,dry_hop_gravity,cooling_gravity,co2_target,created_by,finished_at)
    values ((b->>'id')::uuid,target_brewery_id,(b->>'beer_type_id')::uuid,(b->>'fermenter_id')::uuid,b->>'batch_number',
      (b->>'brew_year')::smallint,(b->>'sequence_number')::smallint,(b->>'volume_tons')::numeric,(b->>'brew_date')::date,
      (b->>'status')::public.batch_status,(b->>'og_target')::smallint,(b->>'fg_target')::smallint,(b->>'spund_gravity')::smallint,
      (b->>'has_dry_hop')::boolean,nullif(b->>'dry_hop_gravity','')::smallint,(b->>'cooling_gravity')::smallint,
      (b->>'co2_target')::numeric,acting_operator_id,nullif(b->>'finished_at','')::timestamptz)
    on conflict (id) do update set beer_type_id=excluded.beer_type_id,fermenter_id=excluded.fermenter_id,batch_number=excluded.batch_number,
      brew_year=excluded.brew_year,sequence_number=excluded.sequence_number,volume_tons=excluded.volume_tons,brew_date=excluded.brew_date,
      status=excluded.status,og_target=excluded.og_target,fg_target=excluded.fg_target,spund_gravity=excluded.spund_gravity,
      has_dry_hop=excluded.has_dry_hop,dry_hop_gravity=excluded.dry_hop_gravity,cooling_gravity=excluded.cooling_gravity,
      co2_target=excluded.co2_target,finished_at=excluded.finished_at where public.batches.brewery_id=target_brewery_id;
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then raise exception 'Batch synchronization rejected'; end if;
    return;
  end if;
  if not exists(select 1 from public.batches x where x.id=(item->>'batch_id')::uuid and x.brewery_id=target_brewery_id) then raise exception 'Batch not found'; end if;
  if entity_type = 'measurement' then
    if exists(select 1 from public.measurements m
      where m.id=(item->>'id')::uuid and m.batch_id<>(item->>'batch_id')::uuid) then
      raise exception 'Measurement belongs to another batch';
    end if;
    resolved_action_id := nullif(item->>'process_action_id','')::uuid;
    if resolved_action_id is not null and not exists(
      select 1 from public.process_actions pa where pa.id=resolved_action_id and pa.batch_id=(item->>'batch_id')::uuid
    ) then
      resolved_action_id := null;
      if nullif(item->>'action_type','') is not null then
        select pa.id into resolved_action_id from public.process_actions pa
        where pa.batch_id=(item->>'batch_id')::uuid
          and pa.action_type=(item->>'action_type')::public.process_action_type limit 1;
      end if;
      if resolved_action_id is null then raise exception 'Linked process action not found in this batch'; end if;
    end if;
    insert into public.measurements (id,client_id,batch_id,operator_id,measured_at,gravity,ph,temperature_c,pressure_bar,note,process_action_id)
    values ((item->>'id')::uuid,(item->>'client_id')::uuid,(item->>'batch_id')::uuid,acting_operator_id,(item->>'measured_at')::timestamptz,
      (item->>'gravity')::smallint,(item->>'ph')::numeric,(item->>'temperature_c')::numeric,nullif(item->>'pressure_bar','')::numeric,
      nullif(item->>'note',''),resolved_action_id)
    on conflict (id) do update set measured_at=excluded.measured_at,gravity=excluded.gravity,ph=excluded.ph,temperature_c=excluded.temperature_c,
      pressure_bar=excluded.pressure_bar,note=excluded.note,process_action_id=excluded.process_action_id,operator_id=acting_operator_id
      where public.measurements.batch_id=excluded.batch_id
        and exists(select 1 from public.batches owned where owned.id=public.measurements.batch_id and owned.brewery_id=target_brewery_id);
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then raise exception 'Measurement synchronization rejected'; end if;
  elsif entity_type = 'action' then
    if exists(select 1 from public.process_actions pa join public.batches ab on ab.id=pa.batch_id
      where pa.id=(item->>'id')::uuid and ab.brewery_id<>target_brewery_id) then
      raise exception 'Process action belongs to another brewery';
    end if;
    insert into public.process_actions (id,client_id,batch_id,operator_id,action_type,performed_at,gravity,ph,temperature_c,pressure_bar,note)
    values ((item->>'id')::uuid,(item->>'client_id')::uuid,(item->>'batch_id')::uuid,acting_operator_id,(item->>'action_type')::public.process_action_type,
      (item->>'performed_at')::timestamptz,(item->>'gravity')::smallint,(item->>'ph')::numeric,(item->>'temperature_c')::numeric,
      nullif(item->>'pressure_bar','')::numeric,nullif(item->>'note',''))
    on conflict (batch_id,action_type) do update set performed_at=excluded.performed_at,gravity=excluded.gravity,ph=excluded.ph,
      temperature_c=excluded.temperature_c,pressure_bar=excluded.pressure_bar,note=excluded.note,operator_id=acting_operator_id;
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then raise exception 'Process action synchronization rejected'; end if;
  elsif entity_type = 'packagingRun' then
    if exists(select 1 from public.packaging_runs pr
      where pr.id=(item->>'id')::uuid and pr.batch_id<>(item->>'batch_id')::uuid) then
      raise exception 'Packaging run belongs to another batch';
    end if;
    insert into public.packaging_runs (id,client_id,batch_id,run_number,volume_tons,centrifuge_liters,status,filtered_at,packaged_at,gravity,ph,
      temperature_c,pressure_bar,co2_vol,operator_id)
    values ((item->>'id')::uuid,(item->>'client_id')::uuid,(item->>'batch_id')::uuid,(item->>'run_number')::smallint,
      (item->>'volume_tons')::numeric,nullif(item->>'centrifuge_liters','')::numeric,(item->>'status')::public.packaging_run_status,
      (item->>'filtered_at')::timestamptz,nullif(item->>'packaged_at','')::timestamptz,(item->>'gravity')::smallint,(item->>'ph')::numeric,
      (item->>'temperature_c')::numeric,nullif(item->>'pressure_bar','')::numeric,nullif(item->>'co2_vol','')::numeric,acting_operator_id)
    on conflict (id) do update set status=excluded.status,packaged_at=excluded.packaged_at,gravity=excluded.gravity,ph=excluded.ph,
      temperature_c=excluded.temperature_c,pressure_bar=excluded.pressure_bar,co2_vol=excluded.co2_vol,operator_id=acting_operator_id
      where public.packaging_runs.batch_id=excluded.batch_id
        and exists(select 1 from public.batches owned where owned.id=public.packaging_runs.batch_id and owned.brewery_id=target_brewery_id);
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then raise exception 'Packaging run synchronization rejected'; end if;
  else raise exception 'Unsupported synchronization entity'; end if;
end; $$;

-- Existing RLS still controls reads. Direct REST writes are forbidden; hardened RPCs write as definer.
revoke insert, update, delete on public.breweries, public.fermenters, public.operators, public.beer_types, public.batches, public.measurements, public.process_actions, public.packaging_runs from authenticated;
revoke all on function public.change_operator_pin(uuid,text,text) from public, authenticated;
revoke all on function public.create_operator(text,text) from public, authenticated;
revoke all on function public.verify_operator(uuid,text) from public, authenticated;
revoke all on function public.reset_brewing_data(text) from public, authenticated;
revoke all on function public.finish_packaging_run(uuid) from public, authenticated;
revoke all on function public.create_operator_session(uuid,text), public.validate_operator_session(text), public.revoke_operator_session(text),
  public.change_operator_pin_with_session(text,text,text), public.set_operator_active_with_session(text,uuid,boolean),
  public.create_operator_with_session(text,text,text), public.reset_brewing_data_with_session(text,text),
  public.sync_operator_event(text,uuid,text,text,jsonb) from public;
grant execute on function public.create_operator_session(uuid,text), public.validate_operator_session(text), public.revoke_operator_session(text),
  public.change_operator_pin_with_session(text,text,text), public.set_operator_active_with_session(text,uuid,boolean),
  public.create_operator_with_session(text,text,text), public.reset_brewing_data_with_session(text,text),
  public.sync_operator_event(text,uuid,text,text,jsonb) to authenticated;
