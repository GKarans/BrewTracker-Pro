-- Hotfix for installations where the Phase 4 migration stopped while compiling
-- the restore check. Qualify the Brite vessel as a declared record variable.
create or replace function public.validate_batch_restore_vessel()
returns trigger language plpgsql set search_path='' as $$
declare vessel public.fermenters; brite public.fermenters;
begin
  if old.deleted_at is not null and new.deleted_at is null and new.fermenter_released_at is null then
    select * into vessel from public.fermenters where id=new.fermenter_id for update;
    if vessel.cleanliness_status not in ('free_clean','legacy_ready') then
      raise exception 'VESSEL_RESTORE_CONFLICT: sākotnējā tvertne nav tīra un gatava';
    end if;
    if exists(select 1 from public.batches b where b.fermenter_id=new.fermenter_id and b.id<>new.id
      and b.deleted_at is null and b.fermenter_released_at is null) then
      raise exception 'VESSEL_RESTORE_CONFLICT: sākotnējā tvertne jau ir aizņemta';
    end if;
  end if;
  if old.deleted_at is not null and new.deleted_at is null and exists(
    select 1 from public.packaging_runs p where p.batch_id=new.id and p.status='filtered'
  ) then
    select * into brite from public.fermenters where brewery_id=new.brewery_id and number=13 for update;
    if brite.cleanliness_status not in ('free_clean','legacy_ready') then
      raise exception 'VESSEL_RESTORE_CONFLICT: Dzidra nav tīra un gatava';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists batch_restore_checks_vessel on public.batches;
create trigger batch_restore_checks_vessel before update of deleted_at on public.batches
for each row execute function public.validate_batch_restore_vessel();
