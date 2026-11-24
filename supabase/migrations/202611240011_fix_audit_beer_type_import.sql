-- Beer types deliberately do not have soft-delete columns.  The audit
-- trigger must never dereference OLD.deleted_at for that table; PostgreSQL
-- does not guarantee short-circuit evaluation inside the former condition.
create or replace function public.audit_operational_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  before_row jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  after_row jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  row_brewery_id uuid;
  acting_operator_id uuid := nullif(current_setting('app.operator_id', true), '')::uuid;
  audit_operation text := lower(tg_op);
  audit_reason text := nullif(current_setting('app.change_reason', true), '');
begin
  if tg_table_name in ('batches', 'beer_types') then
    row_brewery_id := coalesce(new.brewery_id, old.brewery_id);
  else
    select b.brewery_id into row_brewery_id from public.batches b
      where b.id = coalesce(new.batch_id, old.batch_id);
  end if;

  if tg_table_name <> 'beer_types' and tg_op = 'UPDATE' then
    if old.deleted_at is null and new.deleted_at is not null then
      audit_operation := 'soft_delete';
    elsif old.deleted_at is not null and new.deleted_at is null then
      audit_operation := 'restore';
    end if;
  end if;

  insert into public.audit_log (brewery_id, operator_id, table_name, row_id, operation, old_data, new_data, reason)
  values (row_brewery_id, acting_operator_id, tg_table_name, coalesce(new.id, old.id), audit_operation,
    before_row, after_row, audit_reason);
  return new;
end $$;
