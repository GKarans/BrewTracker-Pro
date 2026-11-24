-- Run after migrations in a disposable/staging Supabase project.
-- Catalog-level security regression checks; raises an exception on failure.
do $$
begin
  if has_table_privilege('authenticated', 'public.operator_sessions', 'SELECT')
     or has_table_privilege('authenticated', 'public.operator_sessions', 'INSERT') then
    raise exception 'authenticated must not access operator_sessions directly';
  end if;

  if has_table_privilege('authenticated', 'public.measurements', 'INSERT')
     or has_table_privilege('authenticated', 'public.process_actions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.batches', 'DELETE')
     or has_table_privilege('authenticated', 'public.breweries', 'UPDATE')
     or has_table_privilege('authenticated', 'public.fermenters', 'UPDATE') then
    raise exception 'brewing writes must be RPC-only';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.sync_operator_event(text,uuid,text,text,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'authenticated cannot call sync_operator_event';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.change_operator_pin(uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'legacy PIN function remains callable';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'operator_sessions_active_lookup_idx'
      and indexdef like '%(brewery_id, expires_at)%'
  ) then
    raise exception 'operator session cleanup index is missing or has wrong columns';
  end if;
end $$;

-- Behavioral cases require disposable auth users and are intentionally not
-- faked here. Run this file plus an authenticated two-brewery fixture in local
-- Supabase before deployment. Required cases: wrong PIN and five-attempt
-- lockout, success resetting the failure streak, expiry, revocation, forged
-- expected_operator_id, foreign beer/fermenter IDs, foreign conflicting row
-- UUIDs, and a process_action_id from another batch. Never run destructive
-- fixtures against production.
