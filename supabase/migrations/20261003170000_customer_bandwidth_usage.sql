-- Customer bandwidth statistics are keyed to an admin-managed PPPoE username.
-- The profile mapping binds globally unique RouterOS usernames back to the
-- existing organization/customer and authenticated customer ownership model.
begin;

alter table public.customers
  add column pppoe_username text,
  add constraint customers_pppoe_username_unique unique (pppoe_username),
  add constraint customers_pppoe_username_nonempty
    check (pppoe_username is null or length(btrim(pppoe_username)) > 0);

-- Only the existing organization-admin RLS policy may change this ownership
-- mapping. Customers can read their profile but cannot set or replace its username.
grant update (pppoe_username) on public.customers to authenticated;

create table public.customer_bandwidth_usage (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  total_quota_bytes bigint not null default 0 check (total_quota_bytes >= 0),
  bytes_in bigint not null default 0 check (bytes_in >= 0),
  bytes_out bigint not null default 0 check (bytes_out >= 0),
  is_online boolean not null default false,
  last_ip text,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint customer_bandwidth_usage_customer_username_fkey
    foreign key (username)
    references public.customers (pppoe_username)
    on update cascade
    on delete cascade
);

alter table public.customer_bandwidth_usage enable row level security;
revoke all on table public.customer_bandwidth_usage
  from public, anon, authenticated, service_role;

-- RLS resolves the row's tenant through the trusted customer-profile mapping.
-- is_org_admin includes the existing owner/admin membership roles; owns_customer
-- enforces the existing active customer-to-Auth identity link.
grant select, insert, update, delete
  on table public.customer_bandwidth_usage to authenticated;

create policy customer_bandwidth_usage_select
  on public.customer_bandwidth_usage for select to authenticated
  using (
    exists (
      select 1
      from public.customers c
      where c.pppoe_username = customer_bandwidth_usage.username
        and (
          (select public.is_org_admin(c.organization_id))
          or (select public.owns_customer(c.organization_id, c.id))
        )
    )
  );

create policy customer_bandwidth_usage_admin_insert
  on public.customer_bandwidth_usage for insert to authenticated
  with check (
    exists (
      select 1
      from public.customers c
      where c.pppoe_username = customer_bandwidth_usage.username
        and (select public.is_org_admin(c.organization_id))
    )
  );

create policy customer_bandwidth_usage_admin_update
  on public.customer_bandwidth_usage for update to authenticated
  using (
    exists (
      select 1
      from public.customers c
      where c.pppoe_username = customer_bandwidth_usage.username
        and (select public.is_org_admin(c.organization_id))
    )
  )
  with check (
    exists (
      select 1
      from public.customers c
      where c.pppoe_username = customer_bandwidth_usage.username
        and (select public.is_org_admin(c.organization_id))
    )
  );

create policy customer_bandwidth_usage_admin_delete
  on public.customer_bandwidth_usage for delete to authenticated
  using (
    exists (
      select 1
      from public.customers c
      where c.pppoe_username = customer_bandwidth_usage.username
        and (select public.is_org_admin(c.organization_id))
    )
  );

-- Trusted server-side sync path. The service_role has no direct table grants;
-- only this narrow RPC may create/update counters, online state, IP and sync time.
-- Quota remains admin-managed: new rows default to unlimited (0), and later syncs
-- preserve the quota configured by an administrator.
create or replace function public.sync_customer_bandwidth_usage(
  p_username text,
  p_bytes_in bigint,
  p_bytes_out bigint,
  p_is_online boolean,
  p_last_ip text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_username is null or p_username = '' or p_username <> pg_catalog.btrim(p_username)
     or p_bytes_in is null or p_bytes_in < 0
     or p_bytes_out is null or p_bytes_out < 0
     or p_is_online is null then
    raise exception 'Invalid customer bandwidth usage values' using errcode = '22023';
  end if;

  insert into public.customer_bandwidth_usage (
    username, bytes_in, bytes_out, is_online, last_ip, last_synced_at
  ) values (
    p_username, p_bytes_in, p_bytes_out, p_is_online, p_last_ip,
    pg_catalog.clock_timestamp()
  )
  on conflict (username) do update
  set bytes_in = excluded.bytes_in,
      bytes_out = excluded.bytes_out,
      is_online = excluded.is_online,
      last_ip = excluded.last_ip,
      last_synced_at = excluded.last_synced_at
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.sync_customer_bandwidth_usage(text, bigint, bigint, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.sync_customer_bandwidth_usage(text, bigint, bigint, boolean, text)
  to service_role;

commit;
