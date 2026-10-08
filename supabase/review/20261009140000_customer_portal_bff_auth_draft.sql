-- REVIEW ONLY. Do not move into supabase/migrations/ or apply without owner approval.
-- Strict customer portal BFF: Supabase Auth verifies the private customer identity,
-- while browsers receive only a separate opaque, read-only portal token.
-- This migration contains no customer seeds, Auth-user creation, or password value.
-- It does not modify customers, packages, bills, receipts, allocations, or router data.

begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.customer_portal_bff_accounts (
  organization_id uuid not null,
  customer_id text not null,
  user_id uuid unique references auth.users(id) on delete cascade,
  login_username text not null unique
    check (octet_length(login_username) between 1 and 64 and login_username ~ '^[[:graph:]]{1,64}$'),
  auth_email_alias text not null unique
    check (auth_email_alias ~ '^portal-[0-9a-f]{32}@internal[.]shahdara[.]net$'),
  status text not null default 'provisioning'
    check (status in ('provisioning', 'active', 'locked')),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (organization_id, customer_id),
  unique (organization_id, customer_id, user_id),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade,
  foreign key (login_username)
    references public.customers(pppoe_username) on update cascade on delete cascade,
  check (
    (status = 'active' and user_id is not null)
    or status in ('provisioning', 'locked')
  )
);
create index customer_portal_bff_accounts_user_idx
  on private.customer_portal_bff_accounts (user_id) where user_id is not null;

create table private.customer_portal_bff_sessions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  organization_id uuid not null,
  customer_id text not null,
  user_id uuid not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default pg_catalog.clock_timestamp(),
  revoked_at timestamptz,
  foreign key (organization_id, customer_id, user_id)
    references private.customer_portal_bff_accounts(organization_id, customer_id, user_id)
    on delete cascade,
  check (expires_at > created_at)
);
create index customer_portal_bff_sessions_customer_idx
  on private.customer_portal_bff_sessions (organization_id, customer_id, expires_at desc);
create index customer_portal_bff_sessions_expiry_idx
  on private.customer_portal_bff_sessions (expires_at)
  where revoked_at is null;

create table private.customer_portal_bff_rate_limits (
  scope text not null check (scope in ('ip', 'username')),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  attempt_count integer not null check (attempt_count >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (scope, key_hash)
);

create table private.customer_portal_bff_audit (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organization_id uuid,
  customer_id text,
  user_id uuid,
  event_type text not null check (event_type in (
    'provision_started', 'provisioned', 'provision_failed', 'account_locked',
    'login_succeeded', 'login_failed', 'login_throttled', 'session_revoked'
  )),
  outcome text not null check (outcome in ('started', 'success', 'denied', 'failed')),
  login_key_hash text check (login_key_hash is null or login_key_hash ~ '^[0-9a-f]{64}$'),
  source_ip_hash text check (source_ip_hash is null or source_ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);
create index customer_portal_bff_audit_customer_idx
  on private.customer_portal_bff_audit (organization_id, customer_id, created_at desc);
create index customer_portal_bff_audit_event_idx
  on private.customer_portal_bff_audit (event_type, created_at desc);

alter table private.customer_portal_bff_accounts enable row level security;
alter table private.customer_portal_bff_sessions enable row level security;
alter table private.customer_portal_bff_rate_limits enable row level security;
alter table private.customer_portal_bff_audit enable row level security;
revoke all on table private.customer_portal_bff_accounts,
  private.customer_portal_bff_sessions,
  private.customer_portal_bff_rate_limits,
  private.customer_portal_bff_audit
  from public, anon, authenticated, service_role;

create or replace function private.consume_customer_portal_bff_limit(
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
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_row private.customer_portal_bff_rate_limits%rowtype;
  v_attempts integer;
  v_retry integer;
begin
  if p_scope not in ('ip', 'username')
     or p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$'
     or p_limit not between 1 and 100
     or p_window is null or p_window < interval '1 minute' or p_window > interval '1 day' then
    return pg_catalog.jsonb_build_object('allowed', false, 'retry_after_seconds', 900, 'newly_locked', false);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_scope || ':' || p_key_hash, 0)
  );
  insert into private.customer_portal_bff_rate_limits (
    scope, key_hash, window_started_at, attempt_count, updated_at
  ) values (p_scope, p_key_hash, v_now, 0, v_now)
  on conflict (scope, key_hash) do nothing;

  select t.* into v_row
  from private.customer_portal_bff_rate_limits t
  where t.scope = p_scope and t.key_hash = p_key_hash
  for update;

  if v_row.locked_until is not null and v_row.locked_until > v_now then
    v_retry := greatest(1, ceil(extract(epoch from (v_row.locked_until - v_now)))::integer);
    return pg_catalog.jsonb_build_object('allowed', false, 'retry_after_seconds', v_retry, 'newly_locked', false);
  end if;

  if v_row.window_started_at <= v_now - p_window then
    v_attempts := 1;
    update private.customer_portal_bff_rate_limits t
    set window_started_at = v_now, attempt_count = v_attempts,
        locked_until = null, updated_at = v_now
    where t.scope = p_scope and t.key_hash = p_key_hash;
  else
    v_attempts := least(v_row.attempt_count + 1, 2147483647);
    update private.customer_portal_bff_rate_limits t
    set attempt_count = v_attempts,
        locked_until = case when v_attempts > p_limit then v_now + p_window else null end,
        updated_at = v_now
    where t.scope = p_scope and t.key_hash = p_key_hash;
  end if;

  delete from private.customer_portal_bff_rate_limits t
  where t.ctid in (
    select old.ctid
    from private.customer_portal_bff_rate_limits old
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
revoke all on function private.consume_customer_portal_bff_limit(text, text, integer, interval)
  from public, anon, authenticated, service_role;

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

  v_ip := private.consume_customer_portal_bff_limit('ip', p_ip_hash, 20, interval '15 minutes');
  v_login := private.consume_customer_portal_bff_limit('username', p_login_hash, 5, interval '15 minutes');
  if coalesce((v_ip ->> 'allowed')::boolean, false) = false
     or coalesce((v_login ->> 'allowed')::boolean, false) = false then
    if coalesce((v_ip ->> 'newly_locked')::boolean, false)
       or coalesce((v_login ->> 'newly_locked')::boolean, false) then
      insert into private.customer_portal_bff_audit (
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
revoke all on function public.begin_customer_portal_login(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_customer_portal_login(text, text) to service_role;

create or replace function public.reserve_customer_portal_bff_account(
  p_organization_id uuid,
  p_customer_id text,
  p_login_username text,
  p_auth_email_alias text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing private.customer_portal_bff_accounts%rowtype;
begin
  if p_organization_id is null or p_customer_id is null
     or length(pg_catalog.btrim(p_customer_id)) not between 1 and 200
     or p_login_username is null
     or p_login_username !~ '^[[:graph:]]{1,64}$'
     or p_auth_email_alias is null
     or p_auth_email_alias !~ '^portal-[0-9a-f]{32}@internal[.]shahdara[.]net$' then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  if not exists (
    select 1 from public.customers c
    where c.organization_id = p_organization_id
      and c.id = p_customer_id
      and c.pppoe_username = p_login_username
      and c.archived = false
  ) then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_organization_id::text || ':' || p_customer_id, 0)
  );
  select a.* into v_existing
  from private.customer_portal_bff_accounts a
  where (a.organization_id = p_organization_id and a.customer_id = p_customer_id)
     or a.login_username = p_login_username
     or a.auth_email_alias = p_auth_email_alias
  limit 1
  for update;
  if found then
    if v_existing.organization_id = p_organization_id
       and v_existing.customer_id = p_customer_id
       and v_existing.login_username = p_login_username then
      return pg_catalog.jsonb_build_object(
        'status', 'already_reserved',
        'account_status', v_existing.status,
        'auth_email_alias', v_existing.auth_email_alias,
        'user_id', v_existing.user_id
      );
    end if;
    return pg_catalog.jsonb_build_object('status', 'conflict');
  end if;

  insert into private.customer_portal_bff_accounts (
    organization_id, customer_id, login_username, auth_email_alias, status
  ) values (
    p_organization_id, p_customer_id, p_login_username, p_auth_email_alias, 'provisioning'
  );
  insert into private.customer_portal_bff_audit (
    organization_id, customer_id, event_type, outcome
  ) values (p_organization_id, p_customer_id, 'provision_started', 'started');

  return pg_catalog.jsonb_build_object(
    'status', 'reserved',
    'auth_email_alias', p_auth_email_alias
  );
end;
$$;
revoke all on function public.reserve_customer_portal_bff_account(uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_customer_portal_bff_account(uuid, text, text, text)
  to service_role;

create or replace function public.complete_customer_portal_bff_account(
  p_organization_id uuid,
  p_customer_id text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.customer_portal_bff_accounts%rowtype;
begin
  if p_organization_id is null or p_customer_id is null or p_user_id is null then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;
  select a.* into v_account
  from private.customer_portal_bff_accounts a
  where a.organization_id = p_organization_id and a.customer_id = p_customer_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;
  if v_account.status = 'active' and v_account.user_id = p_user_id then
    return pg_catalog.jsonb_build_object('status', 'ok');
  end if;
  if v_account.status not in ('provisioning', 'locked')
     or (v_account.user_id is not null and v_account.user_id <> p_user_id)
     or not exists (
       select 1 from auth.users u
       where u.id = p_user_id
         and pg_catalog.lower(u.email) = v_account.auth_email_alias
         and u.email_confirmed_at is not null
     ) then
    return pg_catalog.jsonb_build_object('status', 'needs_review');
  end if;

  update private.customer_portal_bff_accounts a
  set user_id = p_user_id, status = 'active', updated_at = pg_catalog.clock_timestamp()
  where a.organization_id = p_organization_id and a.customer_id = p_customer_id;
  insert into private.customer_portal_bff_audit (
    organization_id, customer_id, user_id, event_type, outcome
  ) values (p_organization_id, p_customer_id, p_user_id, 'provisioned', 'success');
  return pg_catalog.jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.complete_customer_portal_bff_account(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_customer_portal_bff_account(uuid, text, uuid)
  to service_role;

create or replace function public.lock_customer_portal_bff_account(
  p_organization_id uuid,
  p_customer_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  update private.customer_portal_bff_accounts a
  set status = 'locked', updated_at = pg_catalog.clock_timestamp()
  where a.organization_id = p_organization_id and a.customer_id = p_customer_id
  returning a.user_id into v_user_id;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;
  update private.customer_portal_bff_sessions s
  set revoked_at = coalesce(s.revoked_at, pg_catalog.clock_timestamp())
  where s.organization_id = p_organization_id and s.customer_id = p_customer_id
    and s.revoked_at is null;
  insert into private.customer_portal_bff_audit (
    organization_id, customer_id, user_id, event_type, outcome
  ) values (p_organization_id, p_customer_id, v_user_id, 'account_locked', 'success');
  return pg_catalog.jsonb_build_object('status', 'locked');
end;
$$;
revoke all on function public.lock_customer_portal_bff_account(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.lock_customer_portal_bff_account(uuid, text)
  to service_role;

create or replace function public.resolve_customer_portal_login(p_login_username text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account private.customer_portal_bff_accounts%rowtype;
begin
  if p_login_username is null or length(p_login_username) > 64
     or p_login_username !~ '^[[:graph:]]{1,64}$' then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;
  select a.* into v_account
  from private.customer_portal_bff_accounts a
  join public.customers c
    on c.organization_id = a.organization_id
   and c.id = a.customer_id
   and c.pppoe_username = a.login_username
  where a.login_username = p_login_username
    and a.status = 'active'
    and a.user_id is not null
    and c.archived = false
  limit 1;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'active',
    'user_id', v_account.user_id,
    'auth_email_alias', v_account.auth_email_alias,
    'organization_id', v_account.organization_id,
    'customer_id', v_account.customer_id
  );
end;
$$;
revoke all on function public.resolve_customer_portal_login(text)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_customer_portal_login(text) to service_role;

create or replace function public.record_customer_portal_bff_login_event(
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
  if p_event_type not in ('login_failed', 'login_throttled')
     or p_outcome not in ('denied', 'failed')
     or p_login_hash is null or p_login_hash !~ '^[0-9a-f]{64}$'
     or p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  insert into private.customer_portal_bff_audit (
    organization_id, customer_id, user_id, event_type, outcome,
    login_key_hash, source_ip_hash
  ) values (
    p_organization_id, p_customer_id, p_user_id, p_event_type, p_outcome,
    p_login_hash, p_ip_hash
  );
end;
$$;
revoke all on function public.record_customer_portal_bff_login_event(text, text, text, text, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.record_customer_portal_bff_login_event(text, text, text, text, uuid, text, uuid)
  to service_role;

create or replace function public.create_customer_portal_bff_session(
  p_user_id uuid,
  p_token_hash text,
  p_login_hash text,
  p_ip_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_customer_id text;
  v_expires_at timestamptz;
begin
  if p_user_id is null
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_login_hash is null or p_login_hash !~ '^[0-9a-f]{64}$'
     or p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  select a.organization_id, a.customer_id
    into v_organization_id, v_customer_id
  from private.customer_portal_bff_accounts a
  join public.customers c
    on c.organization_id = a.organization_id
   and c.id = a.customer_id
   and c.pppoe_username = a.login_username
  where a.user_id = p_user_id
    and a.status = 'active'
    and c.archived = false
  limit 1
  for update of a;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'denied');
  end if;

  v_expires_at := pg_catalog.clock_timestamp() + interval '8 hours';
  insert into private.customer_portal_bff_sessions (
    token_hash, organization_id, customer_id, user_id, expires_at
  ) values (
    p_token_hash, v_organization_id, v_customer_id, p_user_id, v_expires_at
  );
  insert into private.customer_portal_bff_audit (
    organization_id, customer_id, user_id, event_type, outcome,
    login_key_hash, source_ip_hash
  ) values (
    v_organization_id, v_customer_id, p_user_id, 'login_succeeded', 'success',
    p_login_hash, p_ip_hash
  );
  return pg_catalog.jsonb_build_object('status', 'ok', 'expires_at', v_expires_at);
end;
$$;
revoke all on function public.create_customer_portal_bff_session(uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_customer_portal_bff_session(uuid, text, text, text)
  to service_role;

create or replace function public.revoke_customer_portal_bff_session(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_customer_id text;
  v_user_id uuid;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;
  update private.customer_portal_bff_sessions s
  set revoked_at = coalesce(s.revoked_at, pg_catalog.clock_timestamp())
  where s.token_hash = p_token_hash
  returning s.organization_id, s.customer_id, s.user_id
    into v_organization_id, v_customer_id, v_user_id;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;
  insert into private.customer_portal_bff_audit (
    organization_id, customer_id, user_id, event_type, outcome
  ) values (v_organization_id, v_customer_id, v_user_id, 'session_revoked', 'success');
  return pg_catalog.jsonb_build_object('status', 'revoked');
end;
$$;
revoke all on function public.revoke_customer_portal_bff_session(text)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_customer_portal_bff_session(text)
  to service_role;

create or replace function public.read_customer_portal_bff_dashboard(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_customer_id text;
  v_user_id uuid;
  v_login_username text;
  v_month date := pg_catalog.date_trunc(
    'month', pg_catalog.clock_timestamp() at time zone 'Asia/Karachi'
  )::date;
  v_customer jsonb;
  v_quota jsonb;
  v_usage jsonb;
  v_bills jsonb;
  v_receipts jsonb;
  v_allocations jsonb;
  v_incidents jsonb;
  v_organization_name text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('status', 'unauthorized');
  end if;

  select s.organization_id, s.customer_id, s.user_id, a.login_username
    into v_organization_id, v_customer_id, v_user_id, v_login_username
  from private.customer_portal_bff_sessions s
  join private.customer_portal_bff_accounts a
    on a.organization_id = s.organization_id
   and a.customer_id = s.customer_id
   and a.user_id = s.user_id
  join public.customers c
    on c.organization_id = a.organization_id
   and c.id = a.customer_id
   and c.pppoe_username = a.login_username
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.expires_at > pg_catalog.clock_timestamp()
    and a.status = 'active'
    and c.archived = false
  limit 1
  for share of s, a, c;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'unauthorized');
  end if;

  select pg_catalog.jsonb_build_object(
    'id', c.id,
    'customer_number', c.customer_number,
    'name', c.name,
    'plan_name', c.plan_name,
    'monthly_fee_cents', c.monthly_fee_cents,
    'service_status', c.service_status,
    'has_pppoe_mapping', c.pppoe_username is not null
  ) into v_customer
  from public.customers c
  where c.organization_id = v_organization_id and c.id = v_customer_id;

  select pg_catalog.jsonb_build_object(
    'package_id', c.package_id,
    'package_name', sp.name,
    'quota_type', coalesce(sp.quota_type, 'unlimited'),
    'quota_limit_gb', sp.quota_limit_gb,
    'action_on_exhaust', coalesce(sp.action_on_exhaust, 'notify')
  ) into v_quota
  from public.customers c
  left join public.service_packages sp
    on sp.organization_id = c.organization_id and sp.id = c.package_id
  where c.organization_id = v_organization_id and c.id = v_customer_id;

  -- The monthly-usage relation is optional at this stage. No relation or no
  -- current-month row means the client must render usage as unavailable.
  v_usage := null;
  if pg_catalog.to_regclass('public.customer_bandwidth_monthly_usage') is not null then
    execute $usage$
      select pg_catalog.jsonb_build_object(
        'usage_month', u.usage_month,
        'bytes_in', u.bytes_in,
        'bytes_out', u.bytes_out,
        'last_synced_at', u.last_synced_at
      )
      from public.customer_bandwidth_monthly_usage u
      where u.username = $1 and u.usage_month = $2
    $usage$ into v_usage using v_login_username, v_month;
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', b.id,
      'invoice_number', b.invoice_number,
      'customer_id', b.customer_id,
      'period', b.period,
      'amount_due_cents', b.amount_due_cents,
      'issued_on', b.issued_on,
      'due_date', b.due_date,
      'plan_snapshot', b.plan_snapshot,
      'applied_cents', coalesce(a.applied_cents, 0),
      'balance_cents', case when b.amount_due_cents is null then null
        else greatest(b.amount_due_cents - coalesce(a.applied_cents, 0), 0) end,
      'status', case
        when b.amount_due_cents is null then 'not-priced'
        when greatest(b.amount_due_cents - coalesce(a.applied_cents, 0), 0) = 0 then 'paid'
        when coalesce(a.applied_cents, 0) > 0 then 'partial'
        else 'unpaid'
      end
    ) order by b.period desc
  ), '[]'::jsonb) into v_bills
  from public.bills b
  left join lateral (
    select coalesce(sum(ra.amount_cents), 0)::bigint as applied_cents
    from public.receipt_allocations ra
    where ra.organization_id = b.organization_id
      and ra.customer_id = b.customer_id
      and ra.bill_id = b.id
  ) a on true
  where b.organization_id = v_organization_id and b.customer_id = v_customer_id;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', r.id, 'customer_id', r.customer_id,
      'origin_bill_id', r.origin_bill_id, 'received_on', r.received_on,
      'amount_cents', r.amount_cents, 'method', r.method
    ) order by r.received_on desc
  ), '[]'::jsonb) into v_receipts
  from public.receipts r
  where r.organization_id = v_organization_id and r.customer_id = v_customer_id;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'receipt_id', a.receipt_id, 'bill_id', a.bill_id,
      'customer_id', a.customer_id, 'amount_cents', a.amount_cents,
      'allocation_kind', a.allocation_kind
    ) order by a.created_at
  ), '[]'::jsonb) into v_allocations
  from public.receipt_allocations a
  where a.organization_id = v_organization_id and a.customer_id = v_customer_id;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'id', i.id, 'customer_id', i.customer_id,
      'customer_visible_summary', i.customer_visible_summary,
      'status', i.status, 'reported_at', i.reported_at,
      'offline_at', i.offline_at, 'restored_at', i.restored_at
    ) order by i.reported_at desc
  ), '[]'::jsonb) into v_incidents
  from public.incidents i
  where i.organization_id = v_organization_id and i.customer_id = v_customer_id;

  select o.name into v_organization_name
  from public.organizations o where o.id = v_organization_id;

  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'organization_id', v_organization_id,
    'organization_name', v_organization_name,
    'customer', v_customer,
    'quota', v_quota,
    'monthly_usage', v_usage,
    'bills', v_bills,
    'receipts', v_receipts,
    'allocations', v_allocations,
    'incidents', v_incidents
  );
end;
$$;
revoke all on function public.read_customer_portal_bff_dashboard(text)
  from public, anon, authenticated, service_role;
grant execute on function public.read_customer_portal_bff_dashboard(text)
  to service_role;

create or replace function public.fail_customer_portal_bff_account(
  p_organization_id uuid,
  p_customer_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  update private.customer_portal_bff_accounts a
  set status = 'locked', updated_at = pg_catalog.clock_timestamp()
  where a.organization_id = p_organization_id
    and a.customer_id = p_customer_id
    and a.status = 'provisioning'
  returning a.user_id into v_user_id;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'not_provisioning');
  end if;
  update private.customer_portal_bff_sessions s
  set revoked_at = coalesce(s.revoked_at, pg_catalog.clock_timestamp())
  where s.organization_id = p_organization_id and s.customer_id = p_customer_id;
  insert into private.customer_portal_bff_audit (
    organization_id, customer_id, user_id, event_type, outcome
  ) values (
    p_organization_id, p_customer_id, v_user_id, 'provision_failed', 'failed'
  );
  return pg_catalog.jsonb_build_object('status', 'locked');
end;
$$;
revoke all on function public.fail_customer_portal_bff_account(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.fail_customer_portal_bff_account(uuid, text)
  to service_role;

create or replace function public.resolve_customer_portal_bff_traffic(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_customer_id text;
  v_user_id uuid;
  v_login_username text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('status', 'unauthorized');
  end if;
  select s.organization_id, s.customer_id, s.user_id, a.login_username
    into v_organization_id, v_customer_id, v_user_id, v_login_username
  from private.customer_portal_bff_sessions s
  join private.customer_portal_bff_accounts a
    on a.organization_id = s.organization_id
   and a.customer_id = s.customer_id
   and a.user_id = s.user_id
  join public.customers c
    on c.organization_id = a.organization_id
   and c.id = a.customer_id
   and c.pppoe_username = a.login_username
  where s.token_hash = p_token_hash
    and s.revoked_at is null
    and s.expires_at > pg_catalog.clock_timestamp()
    and a.status = 'active'
    and c.archived = false
  limit 1
  for share of s, a, c;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'unauthorized');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'organization_id', v_organization_id,
    'customer_id', v_customer_id,
    'user_id', v_user_id,
    'pppoe_username', v_login_username
  );
end;
$$;
revoke all on function public.resolve_customer_portal_bff_traffic(text)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_customer_portal_bff_traffic(text)
  to service_role;

comment on table private.customer_portal_bff_accounts is
  'Server-only PPPoE username to Supabase Auth user mapping; contains no password and is never browser-readable.';
comment on table private.customer_portal_bff_sessions is
  'Server-only opaque portal sessions; stores token hashes only. Browser never receives Supabase Auth JWTs.';
comment on function public.read_customer_portal_bff_dashboard(text) is
  'Service-role-only, read-only dashboard projection selected exclusively by a valid opaque portal token hash.';
comment on function public.resolve_customer_portal_bff_traffic(text) is
  'Service-role-only PPPoE username resolver for the existing Node live-traffic API; accepts only an opaque portal-token hash.';

commit;
