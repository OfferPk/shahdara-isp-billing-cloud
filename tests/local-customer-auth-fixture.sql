-- Synthetic schema prerequisites for tests/run-local-customer-auth.sh only.
-- This is not a production or Supabase project bootstrap script.
\set ON_ERROR_STOP on
create schema extensions;
create extension pgcrypto with schema extensions;
create schema auth;
create table auth.users (
  id uuid primary key,
  email text unique,
  email_confirmed_at timestamptz
);
create function auth.uid()
returns uuid
language sql
stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table public.organizations (
  id uuid primary key,
  name text not null
);
create table public.organization_memberships (
  organization_id uuid not null references public.organizations(id),
  user_id uuid not null references auth.users(id),
  role text not null,
  primary key (organization_id, user_id)
);
create table public.customers (
  organization_id uuid not null references public.organizations(id),
  id text not null,
  name text not null,
  archived boolean not null default false,
  primary key (organization_id, id)
);
create table public.customer_portal_accounts (
  organization_id uuid not null,
  customer_id text not null,
  user_id uuid not null references auth.users(id),
  primary key (organization_id, customer_id, user_id),
  foreign key (organization_id, customer_id) references public.customers(organization_id, id)
);
create table public.synthetic_customer_data (
  organization_id uuid not null,
  customer_id text not null,
  private_value text not null,
  foreign key (organization_id, customer_id) references public.customers(organization_id, id)
);
DO $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;
insert into public.organizations(id, name)
values ('10000000-0000-4000-8000-000000000001', 'Synthetic ISP');
insert into auth.users(id, email, email_confirmed_at) values
  ('30000000-0000-4000-8000-000000000003', 'synthetic-admin@example.test', now()),
  ('50000000-0000-4000-8000-000000000005', 'synthetic-customer@example.test', now());
insert into public.organization_memberships(organization_id, user_id, role)
values ('10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'owner');
insert into public.customers(organization_id, id, name)
values ('10000000-0000-4000-8000-000000000001', 'synthetic-customer-27', 'Synthetic Customer');
insert into public.customer_portal_accounts(organization_id, customer_id, user_id)
values ('10000000-0000-4000-8000-000000000001', 'synthetic-customer-27', '50000000-0000-4000-8000-000000000005');
insert into public.synthetic_customer_data(organization_id, customer_id, private_value)
values ('10000000-0000-4000-8000-000000000001', 'synthetic-customer-27', 'synthetic-test-only');
