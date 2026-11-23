alter table public.breweries
  add column if not exists data_version bigint not null default 1;

create or replace function public.reset_brewing_data(confirmation_text text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_brewery_id uuid;
  new_version bigint;
begin
  if confirmation_text <> 'DZĒST VISU' then
    raise exception 'Invalid confirmation text';
  end if;

  select id into target_brewery_id
  from public.breweries
  where auth_user_id = auth.uid();

  if target_brewery_id is null then
    raise exception 'Brewery not found';
  end if;

  delete from public.batches
  where brewery_id = target_brewery_id;

  delete from public.beer_types
  where brewery_id = target_brewery_id;

  update public.breweries
  set data_version = data_version + 1
  where id = target_brewery_id
  returning data_version into new_version;

  return new_version;
end;
$$;

revoke all on function public.reset_brewing_data(text) from public;
grant execute on function public.reset_brewing_data(text) to authenticated;
