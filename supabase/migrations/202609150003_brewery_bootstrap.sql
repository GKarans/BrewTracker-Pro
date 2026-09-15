create or replace function public.bootstrap_brewery(
  brewery_name text,
  operator_name text,
  operator_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_brewery public.breweries;
  new_operator public.operators;
  fermenter_number integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if exists (select 1 from public.breweries where auth_user_id = auth.uid()) then
    raise exception 'Brewery already exists for this account';
  end if;
  if length(trim(brewery_name)) < 2 then
    raise exception 'Brewery name is too short';
  end if;
  if length(trim(operator_name)) < 2 then
    raise exception 'Operator name is too short';
  end if;
  if length(operator_pin) < 4 or length(operator_pin) > 8 or operator_pin !~ '^[0-9]+$' then
    raise exception 'PIN must contain 4 to 8 digits';
  end if;

  insert into public.breweries (name, auth_user_id)
  values (trim(brewery_name), auth.uid())
  returning * into new_brewery;

  for fermenter_number in 1..13 loop
    insert into public.fermenters (brewery_id, number, name)
    values (new_brewery.id, fermenter_number, 'Tvertne ' || fermenter_number);
  end loop;

  insert into public.operators (brewery_id, name, pin_hash)
  values (
    new_brewery.id,
    trim(operator_name),
    extensions.crypt(operator_pin, extensions.gen_salt('bf'))
  )
  returning * into new_operator;

  return jsonb_build_object(
    'brewery_id', new_brewery.id,
    'brewery_name', new_brewery.name,
    'operator_id', new_operator.id,
    'operator_name', new_operator.name
  );
end;
$$;

revoke all on function public.bootstrap_brewery(text, text, text) from public;
grant execute on function public.bootstrap_brewery(text, text, text) to authenticated;

revoke select on public.operators from authenticated;
grant select (id, brewery_id, name, is_active, created_at) on public.operators to authenticated;
