-- Hotfix: RETURNS TABLE exposes operator_id as a PL/pgSQL variable, so every
-- table reference must be qualified to avoid an ambiguous-column error.
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
  select * into target_operator from public.operators o
  where o.id = target_operator_id and o.brewery_id = target_brewery_id and o.is_active;
  select count(*) into recent_failures from public.operator_auth_attempts a
  where a.brewery_id = target_brewery_id and a.operator_id = target_operator_id
    and not a.succeeded and a.attempted_at > now() - interval '15 minutes';
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
  delete from public.operator_auth_attempts a where a.brewery_id = target_brewery_id
    and a.operator_id = target_operator_id and not a.succeeded;
  delete from public.operator_auth_attempts a where a.brewery_id = target_brewery_id
    and a.operator_id = target_operator_id and a.attempted_at < now() - interval '24 hours';
  update public.operator_sessions s set revoked_at = now()
  where s.brewery_id = target_brewery_id and s.operator_id = target_operator_id
    and s.revoked_at is null and s.expires_at > now();
  delete from public.operator_sessions s where s.brewery_id = target_brewery_id
    and (s.expires_at <= now() or s.revoked_at is not null) and s.created_at < now() - interval '24 hours';
  raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.operator_sessions (brewery_id, operator_id, token_hash, expires_at)
  values (target_brewery_id, target_operator_id, encode(extensions.digest(raw_token, 'sha256'), 'hex'), token_expires_at);
  return query select raw_token, target_operator_id, token_expires_at;
end; $$;

revoke all on function public.create_operator_session(uuid, text) from public;
grant execute on function public.create_operator_session(uuid, text) to authenticated;
