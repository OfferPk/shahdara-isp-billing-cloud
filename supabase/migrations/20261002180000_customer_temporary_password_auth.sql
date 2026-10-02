-- Staff-provisioned username + temporary-password customer access.
-- Apply only to an explicitly approved, isolated non-production Supabase project.
-- This migration is intentionally additive and is never applied by the Pages workflow.
begin;

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

-- No browser role can read or mutate these mappings or state. The synthetic email
-- is an Auth identifier only; it is not an inbox, contact address, or proof of ownership.
create table private.customer_portal_credentials (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_id text not null,
  user_id uuid unique references auth.users(id),
  login_id text not null unique
    check (login_id ~ '^sf-[0-9a-f]{32}$'),
  auth_email_alias text not null unique
    check (auth_email_alias ~ '^portal-[0-9a-f]{32}@internal[.]shahdara[.]net$'),
  status text not null check (status in ('provisioning', 'pending_change', 'changing_password', 'active', 'locked')),
  must_change_password boolean not null default true,
  last_action text not null check (last_action in ('issue', 'reset')),
  issued_at timestamptz,
  expires_at timestamptz,
  first_login_claimed_at timestamptz,
  password_changed_at timestamptz,
  issued_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, customer_id),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade,
  check (
    (status = 'active' and must_change_password = false and user_id is not null)
    or (status in ('provisioning', 'pending_change', 'changing_password', 'locked') and must_change_password = true)
  ),
  check (status <> 'pending_change' or (user_id is not null and issued_at is not null and expires_at is not null))
);
create index customer_portal_credentials_user_idx
  on private.customer_portal_credentials (user_id) where user_id is not null;

create table private.customer_portal_credential_audit (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  customer_id text,
  user_id uuid references auth.users(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in (
    'issue_started', 'reset_started', 'issued', 'reset', 'issue_failed',
    'login_succeeded', 'login_failed', 'login_throttled',
    'temporary_login_claimed', 'temporary_login_rejected', 'password_changed',
    'password_state_sync_failed'
  )),
  outcome text not null check (outcome in ('started', 'success', 'denied', 'failed')),
  reason text check (reason is null or length(reason) <= 500),
  login_key_hash text check (login_key_hash is null or login_key_hash ~ '^[0-9a-f]{64}$'),
  source_ip_hash text check (source_ip_hash is null or source_ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp()
);
create index customer_portal_credential_audit_customer_time_idx
  on private.customer_portal_credential_audit (organization_id, customer_id, created_at desc);
create index customer_portal_credential_audit_event_time_idx
  on private.customer_portal_credential_audit (event_type, created_at desc);

create table private.customer_portal_login_throttles (
  scope text not null check (scope in ('ip', 'username', 'admin', 'customer', 'organization')),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  attempt_count integer not null check (attempt_count >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (scope, key_hash)
);

alter table private.customer_portal_credentials enable row level security;
alter table private.customer_portal_credential_audit enable row level security;
alter table private.customer_portal_login_throttles enable row level security;
revoke all on table private.customer_portal_credentials,
  private.customer_portal_credential_audit,
  private.customer_portal_login_throttles
  from public, anon, authenticated, service_role;

-- Atomic fixed-window limiter with a cooldown. Identifiers are HMAC/SHA-256 digests,
-- not raw usernames or IP addresses. A cooldown is finite and automatically expires.
create or replace function private.consume_customer_portal_limit(
  p_scope text,
  p_key_hash text,
  p_limit integer,
  p_window interval
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row private.customer_portal_login_throttles%rowtype;
  v_attempts integer;
  v_retry integer;
begin
  if p_scope not in ('ip', 'username', 'admin', 'customer', 'organization')
     or p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$'
     or p_limit not between 1 and 100
     or p_window < interval '1 minute' or p_window > interval '1 day' then
    return pg_catalog.jsonb_build_object('allowed', false, 'retry_after_seconds', 900, 'newly_locked', false);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_scope || ':' || p_key_hash, 0)
  );
  insert into private.customer_portal_login_throttles (
    scope, key_hash, window_started_at, attempt_count, updated_at
  ) values (p_scope, p_key_hash, v_now, 0, v_now)
  on conflict (scope, key_hash) do nothing;

  select t.* into v_row
  from private.customer_portal_login_throttles t
  where t.scope = p_scope and t.key_hash = p_key_hash
  for update;

  if v_row.locked_until is not null and v_row.locked_until > v_now then
    v_retry := greatest(1, ceil(extract(epoch from (v_row.locked_until - v_now)))::integer);
    return pg_catalog.jsonb_build_object('allowed', false, 'retry_after_seconds', v_retry, 'newly_locked', false);
  end if;

  if v_row.window_started_at <= v_now - p_window then
    v_attempts := 1;
    update private.customer_portal_login_throttles t
    set window_started_at = v_now, attempt_count = v_attempts,
        locked_until = null, updated_at = v_now
    where t.scope = p_scope and t.key_hash = p_key_hash;
  else
    v_attempts := least(v_row.attempt_count + 1, 2147483647);
    update private.customer_portal_login_throttles t
    set attempt_count = v_attempts,
        locked_until = case when v_attempts > p_limit then v_now + p_window else null end,
        updated_at = v_now
    where t.scope = p_scope and t.key_hash = p_key_hash;
  end if;

  -- Incremental bounded cleanup avoids a scheduled job or an unbounded delete.
  delete from private.customer_portal_login_throttles t
  where t.ctid in (
    select old.ctid
    from private.customer_portal_login_throttles old
    where old.updated_at < v_now - interval '48 hours'
    order by old.updated_at
    limit 100
  );

  if v_attempts > p_limit then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', ceil(extract(epoch from p_window))::integer,
      'newly_locked', true
    );
  end if;
  return pg_catalog.jsonb_build_object('allowed', true, 'retry_after_seconds', 0, 'newly_locked', false);
end;
$$;
revoke all on function private.consume_customer_portal_limit(text, text, integer, interval)
  from public, anon, authenticated, service_role;

-- The existing ownership helper is the authorization boundary for customer rows.
-- A pending, provisioning, expired, or locked temporary credential denies every
-- linked identity for that customer until the server marks the password change complete.
create or replace function public.owns_customer(p_organization_id uuid, p_customer_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and not exists (
      select 1
      from private.customer_portal_credentials c
      where c.organization_id = p_organization_id
        and c.customer_id = p_customer_id
        and (c.status <> 'active' or c.must_change_password)
    )
    and (
      exists (
        select 1
        from public.customer_portal_accounts a
        where a.organization_id = p_organization_id
          and a.customer_id = p_customer_id
          and a.user_id = (select auth.uid())
      )
      or exists (
        select 1
        from private.customer_portal_credentials c
        where c.organization_id = p_organization_id
          and c.customer_id = p_customer_id
          and c.user_id = (select auth.uid())
          and c.status = 'active'
          and c.must_change_password = false
      )
    );
$$;
revoke all on function public.owns_customer(uuid, text) from public, anon;
grant execute on function public.owns_customer(uuid, text) to authenticated;

-- Safe, authenticated-only context RPC: returns only the customer's own IDs, never
-- the login ID, synthetic Auth alias, or private credential state.
create or replace function public.my_customer_portal_contexts()
returns table (organization_id uuid, customer_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct q.organization_id, q.customer_id
  from (
    select a.organization_id, a.customer_id
    from public.customer_portal_accounts a
    where a.user_id = (select auth.uid())
    union all
    select c.organization_id, c.customer_id
    from private.customer_portal_credentials c
    where c.user_id = (select auth.uid())
      and c.status = 'active'
      and c.must_change_password = false
  ) q
  where (select auth.uid()) is not null
    and not exists (
      select 1
      from private.customer_portal_credentials pending
      where pending.organization_id = q.organization_id
        and pending.customer_id = q.customer_id
        and (pending.status <> 'active' or pending.must_change_password)
    );
$$;
revoke all on function public.my_customer_portal_contexts() from public, anon;
grant execute on function public.my_customer_portal_contexts() to authenticated;

-- The browser may ask only for its own coarse state; authorization still lives in
-- owns_customer() and every RLS policy, not in this UI hint.
create or replace function public.my_customer_portal_password_state()
returns table (state text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select case
      when c.user_id is null then 'none'
      when c.status = 'active' and not c.must_change_password then 'active'
      when c.status = 'pending_change' and c.expires_at <= now() then 'expired'
      when c.status in ('pending_change', 'changing_password') then 'change_required'
      else 'locked'
    end,
    c.expires_at
  from (select (select auth.uid()) as user_id) current_user_row
  left join private.customer_portal_credentials c on c.user_id = current_user_row.user_id
  where current_user_row.user_id is not null;
$$;
revoke all on function public.my_customer_portal_password_state() from public, anon;
grant execute on function public.my_customer_portal_password_state() to authenticated;

-- Public Edge Function calls this with HMAC keys; no RPC is executable by browsers.
create or replace function public.begin_customer_portal_login(p_ip_hash text, p_login_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ip jsonb;
  v_login jsonb;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$'
     or p_login_hash is null or p_login_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', 900);
  end if;
  v_ip := private.consume_customer_portal_limit('ip', p_ip_hash, 20, interval '15 minutes');
  v_login := private.consume_customer_portal_limit('username', p_login_hash, 5, interval '15 minutes');
  if coalesce((v_ip ->> 'allowed')::boolean, false) = false
     or coalesce((v_login ->> 'allowed')::boolean, false) = false then
    if coalesce((v_ip ->> 'newly_locked')::boolean, false)
       or coalesce((v_login ->> 'newly_locked')::boolean, false) then
      insert into private.customer_portal_credential_audit (
        event_type, outcome, login_key_hash, source_ip_hash
      ) values ('login_throttled', 'denied', p_login_hash, p_ip_hash);
    end if;
    return pg_catalog.jsonb_build_object(
      'status', 'rate_limited',
      'retry_after_seconds', greatest(
        coalesce((v_ip ->> 'retry_after_seconds')::integer, 900),
        coalesce((v_login ->> 'retry_after_seconds')::integer, 900)
      )
    );
  end if;
  return pg_catalog.jsonb_build_object('status', 'allowed');
end;
$$;
revoke all on function public.begin_customer_portal_login(text, text) from public, anon, authenticated;
grant execute on function public.begin_customer_portal_login(text, text) to service_role;

create or replace function public.resolve_customer_portal_login(p_login_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential private.customer_portal_credentials%rowtype;
  v_state text := 'not_found';
begin
  if p_login_id is null or length(p_login_id) > 64
     or p_login_id !~ '^sf-[0-9a-f]{32}$' then
    return pg_catalog.jsonb_build_object('status', v_state);
  end if;
  select c.* into v_credential
  from private.customer_portal_credentials c
  where c.login_id = p_login_id
  limit 1;
  if not found then
    return pg_catalog.jsonb_build_object('status', v_state);
  end if;

  if v_credential.status = 'active' and not v_credential.must_change_password then
    v_state := 'active';
  elsif v_credential.status = 'pending_change'
        and v_credential.expires_at is not null
        and v_credential.expires_at > clock_timestamp()
        and v_credential.first_login_claimed_at is null then
    v_state := 'temporary';
  elsif v_credential.status = 'pending_change'
        and v_credential.expires_at is not null
        and v_credential.expires_at <= clock_timestamp() then
    v_state := 'expired';
  elsif v_credential.status = 'pending_change'
        and v_credential.first_login_claimed_at is not null then
    v_state := 'used';
  else
    v_state := 'locked';
  end if;

  return pg_catalog.jsonb_build_object(
    'status', v_state,
    'user_id', case when v_state in ('active', 'temporary') then v_credential.user_id else null end,
    'auth_email_alias', case when v_state in ('active', 'temporary') then v_credential.auth_email_alias else null end,
    'organization_id', case when v_state in ('active', 'temporary') then v_credential.organization_id else null end,
    'customer_id', case when v_state in ('active', 'temporary') then v_credential.customer_id else null end
  );
end;
$$;
revoke all on function public.resolve_customer_portal_login(text) from public, anon, authenticated;
grant execute on function public.resolve_customer_portal_login(text) to service_role;

create or replace function public.record_customer_portal_login_event(
  p_event_type text,
  p_outcome text,
  p_login_hash text,
  p_ip_hash text,
  p_organization_id uuid default null,
  p_customer_id text default null,
  p_user_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_event_type not in ('login_succeeded', 'login_failed', 'temporary_login_rejected', 'password_state_sync_failed')
     or p_outcome not in ('success', 'denied', 'failed')
     or p_login_hash is null or p_login_hash !~ '^[0-9a-f]{64}$'
     or p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  insert into private.customer_portal_credential_audit (
    organization_id, customer_id, user_id, event_type, outcome,
    login_key_hash, source_ip_hash
  ) values (
    p_organization_id, p_customer_id, p_user_id, p_event_type, p_outcome,
    p_login_hash, p_ip_hash
  );
end;
$$;
revoke all on function public.record_customer_portal_login_event(text, text, text, text, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.record_customer_portal_login_event(text, text, text, text, uuid, text, uuid)
  to service_role;

-- Staff-only reservation checks the caller's role again in SQL, rate-limits issuance,
-- and locks customer data before any Auth password mutation occurs.
create or replace function public.reserve_customer_portal_credential(
  p_organization_id uuid,
  p_customer_id text,
  p_actor_id uuid,
  p_reason text,
  p_login_id text,
  p_auth_email_alias text,
  p_actor_ip_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential private.customer_portal_credentials%rowtype;
  v_action text;
  v_admin_key text;
  v_customer_key text;
  v_org_key text;
  v_limit jsonb;
begin
  if p_organization_id is null or p_actor_id is null
     or p_customer_id is null or length(btrim(p_customer_id)) not between 1 and 200
     or p_reason is null or length(btrim(p_reason)) not between 10 and 500
     or p_login_id is null or p_login_id !~ '^sf-[0-9a-f]{32}$'
     or p_auth_email_alias is null
     or p_auth_email_alias !~ '^portal-[0-9a-f]{32}@internal[.]shahdara[.]net$'
     or p_actor_ip_hash is null or p_actor_ip_hash !~ '^[0-9a-f]{64}$' then
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

  v_admin_key := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_actor_id::text, 'UTF8'), 'sha256'), 'hex');
  v_customer_key := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_organization_id::text || ':' || p_customer_id, 'UTF8'), 'sha256'), 'hex');
  v_org_key := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_organization_id::text, 'UTF8'), 'sha256'), 'hex');
  v_limit := private.consume_customer_portal_limit('admin', v_admin_key, 5, interval '1 hour');
  if coalesce((v_limit ->> 'allowed')::boolean, false) = false then
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;
  v_limit := private.consume_customer_portal_limit('customer', v_customer_key, 3, interval '1 hour');
  if coalesce((v_limit ->> 'allowed')::boolean, false) = false then
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;
  v_limit := private.consume_customer_portal_limit('organization', v_org_key, 20, interval '1 hour');
  if coalesce((v_limit ->> 'allowed')::boolean, false) = false then
    return pg_catalog.jsonb_build_object('status', 'rate_limited');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_organization_id::text || ':' || p_customer_id, 0)
  );
  select c.* into v_credential
  from private.customer_portal_credentials c
  where c.organization_id = p_organization_id and c.customer_id = p_customer_id
  for update;

  if found then
    if v_credential.status in ('provisioning', 'changing_password')
       and v_credential.updated_at > clock_timestamp() - interval '10 minutes' then
      return pg_catalog.jsonb_build_object('status', 'in_progress');
    end if;
    if v_credential.user_id is null then
      select u.id into v_credential.user_id
      from auth.users u
      where pg_catalog.lower(u.email) = v_credential.auth_email_alias
        and u.email_confirmed_at is not null
      limit 1;
    end if;
    v_action := case when v_credential.user_id is null then 'issue' else 'reset' end;
    update private.customer_portal_credentials c
    set status = 'provisioning', must_change_password = true,
        user_id = v_credential.user_id,
        last_action = v_action, issued_at = null, expires_at = null,
        first_login_claimed_at = null, password_changed_at = null,
        issued_by = p_actor_id, updated_at = clock_timestamp()
    where c.organization_id = p_organization_id and c.customer_id = p_customer_id
    returning c.* into v_credential;
  else
    v_action := 'issue';
    insert into private.customer_portal_credentials (
      organization_id, customer_id, user_id, login_id, auth_email_alias,
      status, must_change_password, last_action, issued_by
    ) values (
      p_organization_id, p_customer_id, null, p_login_id, p_auth_email_alias,
      'provisioning', true, v_action, p_actor_id
    ) returning * into v_credential;
  end if;

  insert into private.customer_portal_credential_audit (
    organization_id, customer_id, user_id, actor_id, event_type, outcome, reason, source_ip_hash
  ) values (
    p_organization_id, p_customer_id, v_credential.user_id, p_actor_id,
    case when v_action = 'issue' then 'issue_started' else 'reset_started' end,
    'started', btrim(p_reason), p_actor_ip_hash
  );

  return pg_catalog.jsonb_build_object(
    'status', 'reserved',
    'action', v_action,
    'login_id', v_credential.login_id,
    'auth_email_alias', v_credential.auth_email_alias,
    'user_id', v_credential.user_id
  );
end;
$$;
revoke all on function public.reserve_customer_portal_credential(uuid, text, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.reserve_customer_portal_credential(uuid, text, uuid, text, text, text, text)
  to service_role;

-- Reconcile a createUser call whose network response was lost by looking up only
-- this customer's previously reserved opaque alias. This is service-role-only and
-- is not the public login-identifier lookup path.
create or replace function public.recover_customer_portal_auth_user(
  p_organization_id uuid,
  p_customer_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential private.customer_portal_credentials%rowtype;
  v_user_id uuid;
begin
  select c.* into v_credential
  from private.customer_portal_credentials c
  where c.organization_id = p_organization_id and c.customer_id = p_customer_id
  for update;
  if not found or v_credential.status not in ('provisioning', 'locked') then
    return pg_catalog.jsonb_build_object('status', 'needs_review');
  end if;
  if v_credential.user_id is not null then
    return pg_catalog.jsonb_build_object('status', 'ok', 'user_id', v_credential.user_id);
  end if;
  select u.id into v_user_id
  from auth.users u
  where pg_catalog.lower(u.email) = v_credential.auth_email_alias
    and u.email_confirmed_at is not null
  limit 1;
  if v_user_id is null then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;
  update private.customer_portal_credentials c
  set user_id = v_user_id, updated_at = clock_timestamp()
  where c.organization_id = p_organization_id and c.customer_id = p_customer_id;
  return pg_catalog.jsonb_build_object('status', 'ok', 'user_id', v_user_id);
end;
$$;
revoke all on function public.recover_customer_portal_auth_user(uuid, text)
  from public, anon, authenticated;
grant execute on function public.recover_customer_portal_auth_user(uuid, text) to service_role;

create or replace function public.complete_customer_portal_credential(
  p_organization_id uuid,
  p_customer_id text,
  p_actor_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential private.customer_portal_credentials%rowtype;
  v_action text;
begin
  if p_organization_id is null or p_actor_id is null or p_user_id is null
     or p_customer_id is null then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = p_actor_id
      and m.role in ('owner', 'admin')
  ) or not exists (
    select 1 from public.customers c
    where c.organization_id = p_organization_id
      and c.id = p_customer_id and c.archived = false
  ) then
    return pg_catalog.jsonb_build_object('status', 'forbidden');
  end if;

  select c.* into v_credential
  from private.customer_portal_credentials c
  where c.organization_id = p_organization_id and c.customer_id = p_customer_id
  for update;
  if not found or v_credential.status not in ('provisioning', 'locked')
     or (v_credential.user_id is not null and v_credential.user_id <> p_user_id)
     or not exists (
       select 1 from auth.users u
       where u.id = p_user_id
         and pg_catalog.lower(u.email) = v_credential.auth_email_alias
         and u.email_confirmed_at is not null
     ) then
    return pg_catalog.jsonb_build_object('status', 'needs_review');
  end if;

  v_action := v_credential.last_action;
  update private.customer_portal_credentials c
  set user_id = p_user_id,
      status = 'pending_change',
      must_change_password = true,
      issued_at = clock_timestamp(),
      expires_at = clock_timestamp() + interval '24 hours',
      first_login_claimed_at = null,
      password_changed_at = null,
      issued_by = p_actor_id,
      updated_at = clock_timestamp()
  where c.organization_id = p_organization_id and c.customer_id = p_customer_id
  returning c.* into v_credential;

  insert into private.customer_portal_credential_audit (
    organization_id, customer_id, user_id, actor_id, event_type, outcome
  ) values (
    p_organization_id, p_customer_id, p_user_id, p_actor_id,
    case when v_action = 'issue' then 'issued' else 'reset' end,
    'success'
  );

  return pg_catalog.jsonb_build_object(
    'status', 'ok', 'expires_at', v_credential.expires_at
  );
end;
$$;
revoke all on function public.complete_customer_portal_credential(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_customer_portal_credential(uuid, text, uuid, uuid)
  to service_role;

-- Fail closed after an uncertain Auth/DB step. A new staff reset can retry; no
-- plaintext credential or recovery copy is retained here.
create or replace function public.fail_customer_portal_credential(
  p_organization_id uuid,
  p_customer_id text,
  p_actor_id uuid,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential private.customer_portal_credentials%rowtype;
begin
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = p_actor_id
      and m.role in ('owner', 'admin')
  ) then
    return pg_catalog.jsonb_build_object('status', 'forbidden');
  end if;
  update private.customer_portal_credentials c
  set status = 'locked', must_change_password = true,
      user_id = coalesce(c.user_id, p_user_id), updated_at = clock_timestamp()
  where c.organization_id = p_organization_id
    and c.customer_id = p_customer_id
    and c.status in ('provisioning', 'locked')
  returning c.* into v_credential;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'needs_review');
  end if;
  insert into private.customer_portal_credential_audit (
    organization_id, customer_id, user_id, actor_id, event_type, outcome
  ) values (
    p_organization_id, p_customer_id, v_credential.user_id, p_actor_id,
    'issue_failed', 'failed'
  );
  return pg_catalog.jsonb_build_object('status', 'locked');
end;
$$;
revoke all on function public.fail_customer_portal_credential(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.fail_customer_portal_credential(uuid, text, uuid, uuid)
  to service_role;

create or replace function public.claim_customer_portal_temporary_password(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential private.customer_portal_credentials%rowtype;
begin
  if p_user_id is null then
    return pg_catalog.jsonb_build_object('status', 'rejected');
  end if;
  select c.* into v_credential
  from private.customer_portal_credentials c
  where c.user_id = p_user_id
  for update;
  if not found or v_credential.status <> 'pending_change'
     or not v_credential.must_change_password
     or v_credential.expires_at is null or v_credential.expires_at <= clock_timestamp()
     or v_credential.first_login_claimed_at is not null then
    if found then
      insert into private.customer_portal_credential_audit (
        organization_id, customer_id, user_id, event_type, outcome
      ) values (
        v_credential.organization_id, v_credential.customer_id, p_user_id,
        'temporary_login_rejected', 'denied'
      );
    end if;
    return pg_catalog.jsonb_build_object('status', 'rejected');
  end if;

  update private.customer_portal_credentials c
  set first_login_claimed_at = clock_timestamp(), updated_at = clock_timestamp()
  where c.organization_id = v_credential.organization_id
    and c.customer_id = v_credential.customer_id
    and c.first_login_claimed_at is null;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'rejected');
  end if;
  insert into private.customer_portal_credential_audit (
    organization_id, customer_id, user_id, event_type, outcome
  ) values (
    v_credential.organization_id, v_credential.customer_id, p_user_id,
    'temporary_login_claimed', 'success'
  );
  return pg_catalog.jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.claim_customer_portal_temporary_password(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_customer_portal_temporary_password(uuid) to service_role;

-- A short server-side lease serializes the Auth update against Admin reset. The
-- database state remains non-active during the external Auth call.
create or replace function public.begin_customer_portal_password_change(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential private.customer_portal_credentials%rowtype;
begin
  if p_user_id is null then
    return pg_catalog.jsonb_build_object('status', 'rejected');
  end if;
  select c.* into v_credential
  from private.customer_portal_credentials c
  where c.user_id = p_user_id
  for update;
  if not found or v_credential.status not in ('pending_change', 'changing_password')
     or not v_credential.must_change_password
     or v_credential.first_login_claimed_at is null
     or v_credential.expires_at is null or v_credential.expires_at <= clock_timestamp() then
    return pg_catalog.jsonb_build_object('status', 'rejected');
  end if;
  if v_credential.status = 'changing_password'
     and v_credential.updated_at > clock_timestamp() - interval '10 minutes' then
    return pg_catalog.jsonb_build_object('status', 'in_progress');
  end if;
  update private.customer_portal_credentials c
  set status = 'changing_password', updated_at = clock_timestamp()
  where c.organization_id = v_credential.organization_id
    and c.customer_id = v_credential.customer_id;
  return pg_catalog.jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.begin_customer_portal_password_change(uuid)
  from public, anon, authenticated;
grant execute on function public.begin_customer_portal_password_change(uuid) to service_role;

create or replace function public.abort_customer_portal_password_change(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential private.customer_portal_credentials%rowtype;
begin
  select c.* into v_credential
  from private.customer_portal_credentials c
  where c.user_id = p_user_id
  for update;
  if not found or v_credential.status <> 'changing_password' then
    return pg_catalog.jsonb_build_object('status', 'rejected');
  end if;
  update private.customer_portal_credentials c
  set status = 'pending_change', updated_at = clock_timestamp()
  where c.organization_id = v_credential.organization_id
    and c.customer_id = v_credential.customer_id;
  insert into private.customer_portal_credential_audit (
    organization_id, customer_id, user_id, event_type, outcome
  ) values (
    v_credential.organization_id, v_credential.customer_id, p_user_id,
    'password_state_sync_failed', 'failed'
  );
  return pg_catalog.jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.abort_customer_portal_password_change(uuid)
  from public, anon, authenticated;
grant execute on function public.abort_customer_portal_password_change(uuid) to service_role;

-- Called only after the server has successfully updated the Auth password for the
-- verified bearer UID. If this write fails, the private state remains locked.
create or replace function public.complete_customer_portal_password_change(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential private.customer_portal_credentials%rowtype;
begin
  if p_user_id is null then
    return pg_catalog.jsonb_build_object('status', 'rejected');
  end if;
  select c.* into v_credential
  from private.customer_portal_credentials c
  where c.user_id = p_user_id
  for update;
  if not found or v_credential.status <> 'changing_password'
     or not v_credential.must_change_password
     or v_credential.first_login_claimed_at is null
     or v_credential.expires_at is null or v_credential.expires_at <= clock_timestamp() then
    return pg_catalog.jsonb_build_object('status', 'rejected');
  end if;

  update private.customer_portal_credentials c
  set status = 'active', must_change_password = false,
      password_changed_at = clock_timestamp(), updated_at = clock_timestamp()
  where c.organization_id = v_credential.organization_id
    and c.customer_id = v_credential.customer_id;
  insert into private.customer_portal_credential_audit (
    organization_id, customer_id, user_id, event_type, outcome
  ) values (
    v_credential.organization_id, v_credential.customer_id, p_user_id,
    'password_changed', 'success'
  );
  return pg_catalog.jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.complete_customer_portal_password_change(uuid)
  from public, anon, authenticated;
grant execute on function public.complete_customer_portal_password_change(uuid) to service_role;

-- Username login uses a server-side mapping and never exposes an alias or account-existence result.
create or replace function public.is_org_customer(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from (
        select a.organization_id, a.customer_id
        from public.customer_portal_accounts a
        where a.organization_id = p_organization_id
          and a.user_id = (select auth.uid())
        union all
        select c.organization_id, c.customer_id
        from private.customer_portal_credentials c
        where c.organization_id = p_organization_id
          and c.user_id = (select auth.uid())
          and c.status = 'active'
          and not c.must_change_password
      ) linked
      where not exists (
        select 1
        from private.customer_portal_credentials pending
        where pending.organization_id = linked.organization_id
          and pending.customer_id = linked.customer_id
          and (pending.status <> 'active' or pending.must_change_password)
      )
    );
$$;
revoke all on function public.is_org_customer(uuid) from public, anon;
grant execute on function public.is_org_customer(uuid) to authenticated;

commit;
