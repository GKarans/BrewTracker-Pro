create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  brewery_id uuid not null references public.breweries(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  user_agent text,
  is_active boolean not null default true,
  last_notified_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index push_subscriptions_brewery_active_idx
  on public.push_subscriptions (brewery_id, is_active);

alter table public.push_subscriptions enable row level security;

revoke all on public.push_subscriptions from anon, authenticated;

create or replace function public.register_push_subscription(
  subscription_endpoint text,
  subscription_p256dh text,
  subscription_auth text,
  subscription_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_brewery_id uuid;
begin
  target_brewery_id := public.current_brewery_id();
  if target_brewery_id is null then
    raise exception 'Authentication required';
  end if;

  insert into public.push_subscriptions (
    brewery_id, endpoint, p256dh, auth_key, user_agent, is_active, updated_at
  ) values (
    target_brewery_id, subscription_endpoint, subscription_p256dh,
    subscription_auth, subscription_user_agent, true, now()
  )
  on conflict (endpoint) do update set
    brewery_id = excluded.brewery_id,
    p256dh = excluded.p256dh,
    auth_key = excluded.auth_key,
    user_agent = excluded.user_agent,
    is_active = true,
    updated_at = now();
end;
$$;

revoke all on function public.register_push_subscription(text, text, text, text) from public;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;

