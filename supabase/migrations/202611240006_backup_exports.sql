-- Phase 7: the archive itself stays in the operator's explicit browser download.
-- Supabase stores only tamper-evident export/restore-drill metadata, never a copy
-- of PINs, operator sessions, auth tokens, or Push endpoints.

create table if not exists public.backup_exports (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  operator_id uuid not null references public.operators(id),
  schema_version integer not null,
  payload_checksum text not null check (payload_checksum ~ '^[0-9a-f]{64}$'),
  row_counts jsonb not null default '{}'::jsonb,
  exported_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists backup_exports_brewery_exported_idx on public.backup_exports(brewery_id, exported_at desc);

create table if not exists public.backup_restore_drills (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  operator_id uuid not null references public.operators(id),
  payload_checksum text not null check (payload_checksum ~ '^[0-9a-f]{64}$'),
  source_brewery_id uuid,
  schema_version integer not null,
  row_counts jsonb not null default '{}'::jsonb,
  status text not null check (status in ('validated','blocked')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists backup_restore_drills_brewery_created_idx on public.backup_restore_drills(brewery_id, created_at desc);

alter table public.backup_exports enable row level security;
alter table public.backup_restore_drills enable row level security;
revoke all on public.backup_exports, public.backup_restore_drills from anon, authenticated;
grant select on public.backup_exports, public.backup_restore_drills to authenticated;
drop policy if exists "read own backup exports" on public.backup_exports;
create policy "read own backup exports" on public.backup_exports for select to authenticated using (brewery_id=public.current_brewery_id());
drop policy if exists "read own backup restore drills" on public.backup_restore_drills;
create policy "read own backup restore drills" on public.backup_restore_drills for select to authenticated using (brewery_id=public.current_brewery_id());

create or replace function public.record_backup_export(
  session_token text, archive_schema_version integer, checksum text, counts jsonb
) returns public.backup_exports language plpgsql security definer set search_path='' as $$
declare op uuid:=public.validate_operator_session(session_token); brewery uuid:=public.current_brewery_id(); result public.backup_exports;
begin
  if op is null then raise exception 'Operatora sesija nav derīga'; end if;
  if archive_schema_version<>1 then raise exception 'Neatbalstīta rezerves kopijas versija'; end if;
  if checksum !~ '^[0-9a-f]{64}$' then raise exception 'Nederīga SHA-256 pārbaudes summa'; end if;
  insert into public.backup_exports(brewery_id,operator_id,schema_version,payload_checksum,row_counts)
  values(brewery,op,archive_schema_version,checksum,coalesce(counts,'{}'::jsonb)) returning * into result;
  return result;
end $$;

create or replace function public.record_backup_restore_dry_run(
  session_token text, archive_schema_version integer, checksum text, source_brewery uuid, counts jsonb, is_valid boolean, drill_details jsonb default '{}'::jsonb
) returns public.backup_restore_drills language plpgsql security definer set search_path='' as $$
declare op uuid:=public.validate_operator_session(session_token); brewery uuid:=public.current_brewery_id(); result public.backup_restore_drills;
begin
  if op is null then raise exception 'Operatora sesija nav derīga'; end if;
  if checksum !~ '^[0-9a-f]{64}$' then raise exception 'Nederīga SHA-256 pārbaudes summa'; end if;
  insert into public.backup_restore_drills(brewery_id,operator_id,payload_checksum,source_brewery_id,schema_version,row_counts,status,details)
  values(brewery,op,checksum,source_brewery,archive_schema_version,coalesce(counts,'{}'::jsonb),case when is_valid then 'validated' else 'blocked' end,coalesce(drill_details,'{}'::jsonb)) returning * into result;
  return result;
end $$;

revoke all on function public.record_backup_export(text,integer,text,jsonb), public.record_backup_restore_dry_run(text,integer,text,uuid,jsonb,boolean,jsonb) from public;
grant execute on function public.record_backup_export(text,integer,text,jsonb), public.record_backup_restore_dry_run(text,integer,text,uuid,jsonb,boolean,jsonb) to authenticated;
