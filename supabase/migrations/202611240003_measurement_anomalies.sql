-- Phase 3: server-verified measurement warnings and confirmed overrides.

alter table public.measurements
  add column if not exists co2_vol numeric(3,1) check (co2_vol between 0 and 5),
  add column if not exists warning_codes text[] not null default '{}',
  add column if not exists warning_details jsonb not null default '[]'::jsonb,
  add column if not exists anomaly_confirmed_by uuid references public.operators(id),
  add column if not exists anomaly_confirmed_at timestamptz,
  add column if not exists anomaly_reason text,
  add column if not exists anomaly_baseline_measurement_id uuid references public.measurements(id);

create or replace function public.validate_measurement_anomaly()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  previous_row public.measurements%rowtype;
  latest_row public.measurements%rowtype;
  submitted_codes text[] := array(select jsonb_array_elements_text(
    coalesce(nullif(current_setting('app.anomaly_warning_codes', true), '')::jsonb, '[]'::jsonb)));
  submitted_baseline uuid := nullif(current_setting('app.anomaly_baseline_id', true), '')::uuid;
  confirmed boolean := coalesce(nullif(current_setting('app.anomaly_confirmed', true), '')::boolean, false);
  confirmation_reason text := nullif(trim(current_setting('app.anomaly_reason', true)), '');
  acting_operator uuid := nullif(current_setting('app.operator_id', true), '')::uuid;
  computed_codes text[] := '{}';
  computed_details jsonb := '[]'::jsonb;
  gravity_delta integer;
  temperature_delta numeric;
  duplicate_exists boolean;
  critical_required boolean := false;
  action_type text := nullif(current_setting('app.anomaly_action_type', true), '');
  cooling_expected boolean;
begin
  -- Soft-delete/restore and unrelated maintenance updates must retain the
  -- already verified quality metadata instead of requiring a new override.
  if tg_op='UPDATE' and row(new.batch_id,new.measured_at,new.gravity,new.ph,new.temperature_c,new.pressure_bar,new.co2_vol,new.process_action_id)
    is not distinct from row(old.batch_id,old.measured_at,old.gravity,old.ph,old.temperature_c,old.pressure_bar,old.co2_vol,old.process_action_id) then
    return new;
  end if;
  if new.pressure_bar is not null and new.pressure_bar > 2 then
    raise exception 'Spiediens virs 2 bar nav atļauts';
  end if;

  -- Serialise one batch's measurement stream before selecting baselines.
  perform 1 from public.batches b where b.id=new.batch_id for update;

  select m.* into previous_row from public.measurements m
    where m.batch_id=new.batch_id and m.id<>new.id and m.deleted_at is null
      and m.measured_at<=new.measured_at
    order by m.measured_at desc, m.created_at desc limit 1;

  select m.* into latest_row from public.measurements m
    where m.batch_id=new.batch_id and m.id<>new.id and m.deleted_at is null
    order by m.measured_at desc, m.created_at desc limit 1;

  if previous_row.id is distinct from submitted_baseline then
    raise exception 'ANOMALY_BASELINE_CHANGED: jaunākais mērījums ir mainījies';
  end if;

  if previous_row.id is not null then
    gravity_delta := new.gravity - previous_row.gravity;
    if gravity_delta > 3 then
      computed_codes := array_append(computed_codes, 'gravity_increase');
      computed_details := computed_details || jsonb_build_array(jsonb_build_object(
        'code','gravity_increase','severity',case when gravity_delta>=10 then 'critical' else 'warning' end,
        'previous',previous_row.gravity,'current',new.gravity,'delta',gravity_delta));
      critical_required := critical_required or gravity_delta>=10;
    end if;
    temperature_delta := abs(new.temperature_c - previous_row.temperature_c);
    if temperature_delta >= 5 then
      cooling_expected := action_type='cool' and new.temperature_c<previous_row.temperature_c;
      computed_codes := array_append(computed_codes, 'temperature_jump');
      computed_details := computed_details || jsonb_build_array(jsonb_build_object(
        'code','temperature_jump','severity',case when temperature_delta>=10 and not cooling_expected then 'critical' else 'warning' end,
        'previous',previous_row.temperature_c,'current',new.temperature_c,'delta',temperature_delta));
      critical_required := critical_required or (temperature_delta>=10 and not cooling_expected);
    end if;
  end if;

  if new.ph < 2.5 or new.ph > 6.5 then
    computed_codes := array_append(computed_codes, 'ph_unusual');
    computed_details := computed_details || jsonb_build_array(jsonb_build_object('code','ph_unusual','severity','warning','current',new.ph));
  end if;
  if new.pressure_bar is not null and new.pressure_bar > 1.8 then
    computed_codes := array_append(computed_codes, 'pressure_high');
    computed_details := computed_details || jsonb_build_array(jsonb_build_object('code','pressure_high','severity','warning','current',new.pressure_bar));
  end if;
  if new.measured_at > now() + interval '15 minutes' then
    computed_codes := array_append(computed_codes, 'timestamp_future');
    computed_details := computed_details || jsonb_build_array(jsonb_build_object('code','timestamp_future','severity','critical'));
    critical_required := true;
  end if;
  if latest_row.id is not null and new.measured_at < latest_row.measured_at then
    computed_codes := array_append(computed_codes, 'timestamp_old');
    computed_details := computed_details || jsonb_build_array(jsonb_build_object('code','timestamp_old','severity','warning','latest_at',latest_row.measured_at));
  end if;

  select exists(select 1 from public.measurements m where m.batch_id=new.batch_id and m.id<>new.id
    and m.deleted_at is null and abs(extract(epoch from (m.measured_at-new.measured_at)))<=900
    and m.gravity=new.gravity and m.ph=new.ph and m.temperature_c=new.temperature_c
    and m.pressure_bar is not distinct from new.pressure_bar and m.co2_vol is not distinct from new.co2_vol)
    into duplicate_exists;
  if duplicate_exists then
    computed_codes := array_append(computed_codes, 'duplicate');
    computed_details := computed_details || jsonb_build_array(jsonb_build_object('code','duplicate','severity','critical'));
    critical_required := true;
  end if;

  if not (computed_codes @> submitted_codes and submitted_codes @> computed_codes) then
    raise exception 'ANOMALY_BASELINE_CHANGED: servera brīdinājumi %, ierīces brīdinājumi %', computed_codes, submitted_codes;
  end if;
  if cardinality(computed_codes)>0 and not confirmed then
    raise exception 'MEASUREMENT_WARNINGS_REQUIRED: %', computed_codes;
  end if;
  if critical_required and confirmation_reason is null then
    raise exception 'Kritiskai mērījuma novirzei nepieciešams iemesls';
  end if;

  new.warning_codes := computed_codes;
  new.warning_details := computed_details;
  new.anomaly_baseline_measurement_id := previous_row.id;
  new.anomaly_confirmed_by := case when cardinality(computed_codes)>0 then acting_operator else null end;
  new.anomaly_confirmed_at := case when cardinality(computed_codes)>0 then now() else null end;
  new.anomaly_reason := case when cardinality(computed_codes)>0 then confirmation_reason else null end;
  return new;
end $$;

drop trigger if exists measurements_anomaly_validation on public.measurements;
create trigger measurements_anomaly_validation before insert or update on public.measurements
  for each row execute function public.validate_measurement_anomaly();

create or replace function public.set_measurement_anomaly_context(payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare item jsonb;
begin
  item := case
    when payload->'measurement'->'item' is not null then payload->'measurement'->'item'
    else payload->'item'
  end;
  perform set_config('app.anomaly_warning_codes', coalesce((item->'warning_codes')::text,'[]'), true);
  perform set_config('app.anomaly_confirmed', case when nullif(item->>'anomaly_confirmed_at','') is null then 'false' else 'true' end, true);
  perform set_config('app.anomaly_reason', coalesce(item->>'anomaly_reason',''), true);
  perform set_config('app.anomaly_baseline_id', coalesce(item->>'anomaly_baseline_measurement_id',''), true);
  perform set_config('app.anomaly_action_type', coalesce(item->>'action_type',''), true);
end $$;

create or replace function public.sync_operator_event_v3(
  session_token text, expected_operator_id uuid, entity_type text, operation_type text,
  payload jsonb, expected_version integer default 0, change_reason text default null
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.validate_operator_session(session_token) is null then raise exception 'Operator session invalid or expired'; end if;
  if entity_type in ('measurement','processBundle') then perform public.set_measurement_anomaly_context(payload);
  else perform public.set_measurement_anomaly_context('{}'::jsonb); end if;
  perform public.sync_operator_event_v2(session_token,expected_operator_id,entity_type,operation_type,payload,expected_version,change_reason);
end $$;

create or replace function public.sync_operator_work_event_v3(
  session_token text, expected_operator_id uuid, entity_type text, operation_type text,
  payload jsonb, expected_version integer, change_reason text,
  target_work_item_id uuid, work_item_expected_version integer
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.validate_operator_session(session_token) is null then raise exception 'Operator session invalid or expired'; end if;
  if entity_type in ('measurement','processBundle') then perform public.set_measurement_anomaly_context(payload);
  else perform public.set_measurement_anomaly_context('{}'::jsonb); end if;
  perform public.sync_operator_work_event(session_token,expected_operator_id,entity_type,operation_type,payload,
    expected_version,change_reason,target_work_item_id,work_item_expected_version);
end $$;

revoke all on function public.set_measurement_anomaly_context(jsonb),
  public.sync_operator_event_v3(text,uuid,text,text,jsonb,integer,text),
  public.sync_operator_work_event_v3(text,uuid,text,text,jsonb,integer,text,uuid,integer) from public;
revoke all on function public.sync_operator_event_v2(text,uuid,text,text,jsonb,integer,text),
  public.sync_operator_work_event(text,uuid,text,text,jsonb,integer,text,uuid,integer) from authenticated;
grant execute on function public.sync_operator_event_v3(text,uuid,text,text,jsonb,integer,text),
  public.sync_operator_work_event_v3(text,uuid,text,text,jsonb,integer,text,uuid,integer) to authenticated;
