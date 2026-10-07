-- Owner-review migration for the Admin MikroTik subscriber import feature.
-- This file is intentionally not applied automatically or to any database.
-- It depends on the existing customers.pppoe_username mapping migration and
-- public.is_org_admin(uuid) helper being present first.

begin;

create table if not exists public.service_packages (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null default gen_random_uuid()::text,
  name text not null check (length(btrim(name)) between 1 and 100),
  monthly_fee_cents bigint check (monthly_fee_cents is null or monthly_fee_cents >= 0),
  created_at timestamptz not null default now(),
  primary key (organization_id, id)
);

create unique index if not exists service_packages_org_name_unique_idx
  on public.service_packages (organization_id, lower(name));

alter table public.customers
  add column if not exists package_id text;

alter table public.customer_private_details
  add column if not exists assigned_ip text,
  add column if not exists router_comment text not null default '';

alter table public.customer_private_details
  drop constraint if exists customer_private_details_assigned_ip_length,
  add constraint customer_private_details_assigned_ip_length
    check (assigned_ip is null or length(assigned_ip) <= 100),
  drop constraint if exists customer_private_details_router_comment_length,
  add constraint customer_private_details_router_comment_length
    check (length(router_comment) <= 1000);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customers'::regclass
      and conname = 'customers_package_fk'
  ) then
    alter table public.customers
      add constraint customers_package_fk
      foreign key (organization_id, package_id)
      references public.service_packages (organization_id, id);
  end if;
end
$$;

alter table public.service_packages enable row level security;
revoke all on table public.service_packages from public, anon, authenticated;
grant select on table public.service_packages to authenticated;

create policy service_packages_admin_read
  on public.service_packages for select to authenticated
  using ((select public.is_org_admin(organization_id)));

comment on table public.service_packages is
  'Organization-scoped PPP profile/package names discovered from network service configuration.';
comment on column public.customers.package_id is
  'Optional link to the organization-scoped package catalog; plan_name remains the customer-facing snapshot.';
comment on column public.customer_private_details.assigned_ip is
  'Router-assigned subscriber address captured during an authorized import; Admin-only private detail.';
comment on column public.customer_private_details.router_comment is
  'Original router comment captured during an authorized import; Admin-only private detail.';

create or replace function public.import_router_subscriber(
  p_organization_id uuid,
  p_username text,
  p_name text,
  p_profile text,
  p_assigned_ip text,
  p_router_comment text,
  p_service_address text,
  p_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_username text := btrim(coalesce(p_username, ''));
  v_name text := btrim(coalesce(p_name, ''));
  v_profile text := left(btrim(coalesce(p_profile, '')), 100);
  v_assigned_ip text := nullif(btrim(coalesce(p_assigned_ip, '')), '');
  v_comment text := btrim(coalesce(p_router_comment, ''));
  v_service_address text := btrim(coalesce(p_service_address, ''));
  v_phone text := btrim(coalesce(p_phone, ''));
  v_customer_id text;
  v_package_id text;
  v_package_created boolean := false;
  v_customer_number integer;
begin
  if (select auth.uid()) is null or not public.is_org_admin(p_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  if length(v_username) not between 1 and 255 then
    raise exception 'A PPPoE username between 1 and 255 characters is required' using errcode = '22023';
  end if;
  if length(v_name) not between 1 and 100 then
    raise exception 'Customer name must contain 1 to 100 characters' using errcode = '22023';
  end if;
  if length(v_service_address) > 300 then
    raise exception 'Service address must not exceed 300 characters' using errcode = '22023';
  end if;
  if length(coalesce(v_assigned_ip, '')) > 100 then
    raise exception 'Assigned IP must not exceed 100 characters' using errcode = '22023';
  end if;
  if length(v_comment) > 1000 then
    raise exception 'Router comment must not exceed 1000 characters' using errcode = '22023';
  end if;
  if v_phone <> '' and v_phone !~ '^(03[0-9]{9}|[+]923[0-9]{9})$' then
    raise exception 'Phone must be 03XXXXXXXXX or +923XXXXXXXXX' using errcode = '22023';
  end if;

  -- Serialize imports for this organization before allocating the next account number.
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text, 0));

  -- Avoid revealing cross-organization ownership while respecting the globally
  -- unique PPPoE username constraint in the existing mapping migration.
  if exists (
    select 1 from public.customers c
    where c.pppoe_username = v_username
  ) then
    return jsonb_build_object('imported', false, 'reason', 'already-imported');
  end if;

  if v_profile = '' then
    v_profile := 'Unassigned';
  end if;

  insert into public.service_packages (organization_id, name)
  values (p_organization_id, v_profile)
  on conflict do nothing
  returning id into v_package_id;
  v_package_created := v_package_id is not null;

  if v_package_id is null then
    select sp.id into v_package_id
    from public.service_packages sp
    where sp.organization_id = p_organization_id
      and lower(sp.name) = lower(v_profile)
    limit 1;
  end if;

  if v_package_id is null then
    raise exception 'The subscriber package could not be created' using errcode = 'P0001';
  end if;

  select coalesce(max(c.customer_number), 0) + 1
    into v_customer_number
  from public.customers c
  where c.organization_id = p_organization_id;

  insert into public.customers (
    organization_id,
    customer_number,
    name,
    plan_name,
    service_address,
    service_status,
    monthly_fee_cents,
    pppoe_username,
    package_id
  ) values (
    p_organization_id,
    v_customer_number,
    v_name,
    v_profile,
    v_service_address,
    'active',
    null,
    v_username,
    v_package_id
  )
  on conflict on constraint customers_pppoe_username_unique do nothing
  returning id into v_customer_id;

  if v_customer_id is null then
    return jsonb_build_object('imported', false, 'reason', 'already-imported');
  end if;

  insert into public.customer_private_details (
    organization_id, customer_id, phone, assigned_ip, router_comment
  ) values (
    p_organization_id, v_customer_id, v_phone, v_assigned_ip, v_comment
  );

  return jsonb_build_object(
    'imported', true,
    'customerId', v_customer_id,
    'packageId', v_package_id,
    'packageCreated', v_package_created
  );
end;
$$;

revoke all on function public.import_router_subscriber(uuid, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.import_router_subscriber(uuid, text, text, text, text, text, text, text)
  to authenticated;

commit;
