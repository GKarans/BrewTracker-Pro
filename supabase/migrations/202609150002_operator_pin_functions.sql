create or replace function public.create_operator(operator_name text, operator_pin text)
returns public.operators
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_brewery_id uuid;
  created_operator public.operators;
begin
  select id into target_brewery_id
  from public.breweries
  where auth_user_id = auth.uid();

  if target_brewery_id is null then
    raise exception 'Brewery not found';
  end if;
  if length(operator_pin) < 4 or length(operator_pin) > 8 or operator_pin !~ '^[0-9]+$' then
    raise exception 'PIN must contain 4 to 8 digits';
  end if;

  insert into public.operators (brewery_id, name, pin_hash)
  values (target_brewery_id, trim(operator_name), extensions.crypt(operator_pin, extensions.gen_salt('bf')))
  returning * into created_operator;
  return created_operator;
end;
$$;

create or replace function public.verify_operator(operator_id uuid, operator_pin text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.operators operator_record
    where operator_record.id = operator_id
      and operator_record.brewery_id = public.current_brewery_id()
      and operator_record.is_active
      and operator_record.pin_hash = extensions.crypt(operator_pin, operator_record.pin_hash)
  )
$$;

revoke all on function public.create_operator(text, text) from public;
revoke all on function public.verify_operator(uuid, text) from public;
grant execute on function public.create_operator(text, text) to authenticated;
grant execute on function public.verify_operator(uuid, text) to authenticated;

revoke select (pin_hash) on public.operators from authenticated;
