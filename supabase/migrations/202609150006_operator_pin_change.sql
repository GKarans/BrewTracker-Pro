create or replace function public.change_operator_pin(
  operator_id uuid,
  current_pin text,
  new_pin text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_operator public.operators;
begin
  select * into target_operator
  from public.operators
  where id = operator_id
    and brewery_id = public.current_brewery_id()
    and is_active;

  if target_operator.id is null then return false; end if;
  if target_operator.pin_hash <> extensions.crypt(current_pin, target_operator.pin_hash) then
    return false;
  end if;
  if length(new_pin) < 4 or length(new_pin) > 8 or new_pin !~ '^[0-9]+$' then
    raise exception 'New PIN must contain 4 to 8 digits';
  end if;

  update public.operators
  set pin_hash = extensions.crypt(new_pin, extensions.gen_salt('bf'))
  where id = operator_id;

  return true;
end;
$$;

revoke all on function public.change_operator_pin(uuid, text, text) from public;
grant execute on function public.change_operator_pin(uuid, text, text) to authenticated;
