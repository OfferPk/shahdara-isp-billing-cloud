-- Customer invitation lifecycle: staging-safe rate limits, one-in-flight reservations,
-- idempotent linking, and a recoverable post-Auth/pre-link state.
-- Apply only to the explicitly approved non-production cloud project.
begin;

create extension if not exists pgcrypto with schema extensions;

create table public.customer_invitation_requests (
  invitation_id uuid not null default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id text not null,
  requested_by uuid references auth.users(id) on delete set null,
  email_hash text,
  status text not null check (status in ('sending', 'pending_link', 'linked', 'needs_review')),
  auth_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, customer_id),
  unique (invitation_id),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade,
  check (email_hash is null or email_hash ~ '^[0-9a-f]{64}$'),
  check ((status = 'linked' and email_hash is null) or (status <> 'linked' and email_hash is not null))
);

create unique index customer_invitation_active_email_unique_idx
  on public.customer_invitation_requests (organization_id, email_hash)
  where status <> 'linked';
create index customer_invitation_recovery_idx
  on public.customer_invitation_requests (status, updated_at)
  where status in ('sending', 'pending_link', 'needs_review');

-- Fixed UTC-hour buckets: at most 5 new requests/admin, 3/email, and 20/org.
-- Raw email is never stored; request digests clear after linking and rate digests expire within 24 hours.
create table public.customer_invitation_rate_limit_buckets (
  scope text not null check (scope in ('admin', 'email', 'organization')),
  scope_key text not null check (length(scope_key) between 1 and 80),
  window_start timestamptz not null,
  attempt_count integer not null check (attempt_count > 0),
  primary key (scope, scope_key, window_start)
);

alter table public.customer_invitation_requests enable row level security;
alter table public.customer_invitation_rate_limit_buckets enable row level security;
revoke all on table public.customer_invitation_requests from public, anon, authenticated, service_role;
revoke all on table public.customer_invitation_rate_limit_buckets from public, anon, authenticated, service_role;

create or replace function public.reserve_customer_invitation(
  p_organization_id uuid,
  p_customer_id text,
  p_actor_id uuid,
  p_email_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.customer_invitation_requests%rowtype;
  v_window_start timestamptz;
  v_admin_attempts integer;
  v_email_attempts integer;
  v_org_attempts integer;
begin
  if p_organization_id is null or p_actor_id is null or p_customer_id is null
     or length(p_customer_id) not between 1 and 200
     or p_email_hash is null or p_email_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = p_actor_id
      and m.role in ('owner', 'admin')
  ) then
    return pg_catalog.jsonb_build_object('status', 'forbidden');
  end if;
  if not exists (
    select 1 from public.customers c
    where c.organization_id = p_organization_id
      and c.id = p_customer_id
      and c.archived = false
  ) then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;

  -- Serialize all reservations for one customer, including the first insert.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_organization_id::text || ':' || p_customer_id, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('email:' || p_organization_id::text || ':' || p_email_hash, 0)
  );

  if exists (
    select 1 from public.customer_portal_accounts a
    where a.organization_id = p_organization_id and a.customer_id = p_customer_id
  ) then
    update public.customer_invitation_requests r
    set status = 'linked', email_hash = null, auth_user_id = null,
        updated_at = pg_catalog.clock_timestamp()
    where r.organization_id = p_organization_id and r.customer_id = p_customer_id;
    return pg_catalog.jsonb_build_object('status', 'linked');
  end if;

  select r.* into v_request
  from public.customer_invitation_requests r
  where r.organization_id = p_organization_id and r.customer_id = p_customer_id
  for update;

  if found then
    if v_request.status = 'linked' then
      return pg_catalog.jsonb_build_object('status', 'needs_review');
    end if;
    if v_request.email_hash is distinct from p_email_hash then
      return pg_catalog.jsonb_build_object('status', 'email_mismatch');
    end if;
    if v_request.status = 'sending'
       and v_request.updated_at > pg_catalog.clock_timestamp() - interval '2 minutes' then
      return pg_catalog.jsonb_build_object('status', 'in_progress');
    end if;
    if v_request.status = 'sending' then
      update public.customer_invitation_requests r
      set status = 'needs_review', updated_at = pg_catalog.clock_timestamp()
      where r.organization_id = p_organization_id and r.customer_id = p_customer_id;
    end if;
    return pg_catalog.jsonb_build_object(
      'status', 'recover', 'invitation_id', v_request.invitation_id
    );
  end if;

  if exists (
    select 1 from public.customer_invitation_requests r
    where r.organization_id = p_organization_id
      and r.email_hash = p_email_hash
      and r.customer_id <> p_customer_id
      and r.status <> 'linked'
  ) then
    return pg_catalog.jsonb_build_object('status', 'email_in_progress');
  end if;

  v_window_start := pg_catalog.date_trunc(
    'hour', pg_catalog.clock_timestamp() at time zone 'UTC'
  ) at time zone 'UTC';
  delete from public.customer_invitation_rate_limit_buckets b
  where b.window_start < v_window_start - interval '24 hours';

  insert into public.customer_invitation_rate_limit_buckets (scope, scope_key, window_start, attempt_count)
  values ('admin', p_actor_id::text, v_window_start, 1)
  on conflict (scope, scope_key, window_start) do update
    set attempt_count = least(public.customer_invitation_rate_limit_buckets.attempt_count + 1, 2147483647)
  returning attempt_count into v_admin_attempts;
  if v_admin_attempts > 5 then
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;

  insert into public.customer_invitation_rate_limit_buckets (scope, scope_key, window_start, attempt_count)
  values ('email', p_email_hash, v_window_start, 1)
  on conflict (scope, scope_key, window_start) do update
    set attempt_count = least(public.customer_invitation_rate_limit_buckets.attempt_count + 1, 2147483647)
  returning attempt_count into v_email_attempts;
  if v_email_attempts > 3 then
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;

  insert into public.customer_invitation_rate_limit_buckets (scope, scope_key, window_start, attempt_count)
  values ('organization', p_organization_id::text, v_window_start, 1)
  on conflict (scope, scope_key, window_start) do update
    set attempt_count = least(public.customer_invitation_rate_limit_buckets.attempt_count + 1, 2147483647)
  returning attempt_count into v_org_attempts;
  if v_org_attempts > 20 then
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;

  insert into public.customer_invitation_requests (
    organization_id, customer_id, requested_by, email_hash, status
  ) values (
    p_organization_id, p_customer_id, p_actor_id, p_email_hash, 'sending'
  ) returning invitation_id into v_request.invitation_id;

  return pg_catalog.jsonb_build_object('status', 'reserved', 'invitation_id', v_request.invitation_id);
end;
$$;

create or replace function public.record_customer_invitation_auth_user(
  p_organization_id uuid,
  p_customer_id text,
  p_actor_id uuid,
  p_email_hash text,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.customer_invitation_requests%rowtype;
begin
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = p_actor_id
      and m.role in ('owner', 'admin')
  ) then
    return pg_catalog.jsonb_build_object('status', 'forbidden');
  end if;

  select r.* into v_request
  from public.customer_invitation_requests r
  where r.organization_id = p_organization_id and r.customer_id = p_customer_id
  for update;
  if not found or v_request.email_hash is distinct from p_email_hash
     or v_request.status = 'linked'
     or (v_request.auth_user_id is not null and v_request.auth_user_id <> p_auth_user_id) then
    return pg_catalog.jsonb_build_object('status', 'needs_review');
  end if;

  if not exists (
    select 1 from auth.users u
    where u.id = p_auth_user_id
      and pg_catalog.encode(extensions.digest(pg_catalog.convert_to(pg_catalog.lower(u.email), 'UTF8'), 'sha256'), 'hex') = p_email_hash
      and u.raw_user_meta_data ->> 'shahdara_cloud_invite_request_id' = v_request.invitation_id::text
  ) then
    update public.customer_invitation_requests r
    set status = 'needs_review', updated_at = pg_catalog.clock_timestamp()
    where r.organization_id = p_organization_id and r.customer_id = p_customer_id;
    return pg_catalog.jsonb_build_object('status', 'needs_review');
  end if;

  update public.customer_invitation_requests r
  set auth_user_id = p_auth_user_id, status = 'pending_link', updated_at = pg_catalog.clock_timestamp()
  where r.organization_id = p_organization_id and r.customer_id = p_customer_id;
  return pg_catalog.jsonb_build_object('status', 'pending_link');
end;
$$;

create or replace function public.finalize_customer_invitation(
  p_organization_id uuid,
  p_customer_id text,
  p_actor_id uuid,
  p_email_hash text,
  p_auth_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.customer_invitation_requests%rowtype;
  v_user_id uuid;
  v_existing_user uuid;
begin
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = p_actor_id
      and m.role in ('owner', 'admin')
  ) then
    return pg_catalog.jsonb_build_object('status', 'forbidden');
  end if;
  if not exists (
    select 1 from public.customers c
    where c.organization_id = p_organization_id
      and c.id = p_customer_id
      and c.archived = false
  ) then
    return pg_catalog.jsonb_build_object('status', 'needs_review');
  end if;

  select r.* into v_request
  from public.customer_invitation_requests r
  where r.organization_id = p_organization_id and r.customer_id = p_customer_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'needs_review');
  end if;
  if v_request.status = 'linked' then
    if exists (
      select 1 from public.customer_portal_accounts a
      where a.organization_id = p_organization_id and a.customer_id = p_customer_id
    ) then
      return pg_catalog.jsonb_build_object('status', 'linked');
    end if;
    return pg_catalog.jsonb_build_object('status', 'needs_review');
  end if;
  if v_request.email_hash is distinct from p_email_hash then
    return pg_catalog.jsonb_build_object('status', 'email_mismatch');
  end if;

  v_user_id := coalesce(p_auth_user_id, v_request.auth_user_id);
  if v_user_id is not null then
    if not exists (
      select 1 from auth.users u
      where u.id = v_user_id
        and pg_catalog.encode(extensions.digest(pg_catalog.convert_to(pg_catalog.lower(u.email), 'UTF8'), 'sha256'), 'hex') = v_request.email_hash
        and u.raw_user_meta_data ->> 'shahdara_cloud_invite_request_id' = v_request.invitation_id::text
    ) then
      update public.customer_invitation_requests r
      set status = 'needs_review', updated_at = pg_catalog.clock_timestamp()
      where r.organization_id = p_organization_id and r.customer_id = p_customer_id;
      return pg_catalog.jsonb_build_object('status', 'needs_review');
    end if;
  else
    -- The marker is a random, non-secret invitation UUID attached as Auth user
    -- metadata. It closes the crash window after Auth accepted the invite but
    -- before the Edge Function could persist the returned user ID.
    select u.id into v_user_id
    from auth.users u
    where u.raw_user_meta_data ->> 'shahdara_cloud_invite_request_id' = v_request.invitation_id::text
      and pg_catalog.encode(extensions.digest(pg_catalog.convert_to(pg_catalog.lower(u.email), 'UTF8'), 'sha256'), 'hex') = v_request.email_hash
    limit 1;
  end if;

  if v_user_id is null then
    update public.customer_invitation_requests r
    set status = 'needs_review', updated_at = pg_catalog.clock_timestamp()
    where r.organization_id = p_organization_id and r.customer_id = p_customer_id;
    return pg_catalog.jsonb_build_object('status', 'needs_review');
  end if;

  select a.user_id into v_existing_user
  from public.customer_portal_accounts a
  where a.organization_id = p_organization_id and a.customer_id = p_customer_id
  for update;
  if found then
    if v_existing_user = v_user_id then
      update public.customer_invitation_requests r
      set status = 'linked', email_hash = null, auth_user_id = null,
          updated_at = pg_catalog.clock_timestamp()
      where r.organization_id = p_organization_id and r.customer_id = p_customer_id;
      return pg_catalog.jsonb_build_object('status', 'linked');
    end if;
    update public.customer_invitation_requests r
    set status = 'needs_review', updated_at = pg_catalog.clock_timestamp()
    where r.organization_id = p_organization_id and r.customer_id = p_customer_id;
    return pg_catalog.jsonb_build_object('status', 'needs_review');
  end if;

  if exists (
    select 1 from public.customer_portal_accounts a
    where a.organization_id = p_organization_id and a.user_id = v_user_id
  ) then
    update public.customer_invitation_requests r
    set status = 'needs_review', updated_at = pg_catalog.clock_timestamp()
    where r.organization_id = p_organization_id and r.customer_id = p_customer_id;
    return pg_catalog.jsonb_build_object('status', 'needs_review');
  end if;

  begin
    insert into public.customer_portal_accounts (organization_id, customer_id, user_id)
    values (p_organization_id, p_customer_id, v_user_id);
  exception when unique_violation then
    update public.customer_invitation_requests r
    set status = 'needs_review', updated_at = pg_catalog.clock_timestamp()
    where r.organization_id = p_organization_id and r.customer_id = p_customer_id;
    return pg_catalog.jsonb_build_object('status', 'needs_review');
  end;

  update public.customer_invitation_requests r
  set status = 'linked', email_hash = null, auth_user_id = null,
      updated_at = pg_catalog.clock_timestamp()
  where r.organization_id = p_organization_id and r.customer_id = p_customer_id;
  return pg_catalog.jsonb_build_object('status', 'linked');
end;
$$;

revoke all on function public.reserve_customer_invitation(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.record_customer_invitation_auth_user(uuid, text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.finalize_customer_invitation(uuid, text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.reserve_customer_invitation(uuid, text, uuid, text) to service_role;
grant execute on function public.record_customer_invitation_auth_user(uuid, text, uuid, text, uuid) to service_role;
grant execute on function public.finalize_customer_invitation(uuid, text, uuid, text, uuid) to service_role;

comment on table public.customer_invitation_requests is
  'Server-only customer invitation workflow state. Stores an email digest only until linking; never stores the email address.';
comment on table public.customer_invitation_rate_limit_buckets is
  'Server-only fixed-hour invitation rate counters: 5/admin, 3/email digest, 20/organization.';

commit;
