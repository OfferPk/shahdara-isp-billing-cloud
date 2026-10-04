-- PPPoE username login with the shared default password is permitted only for
-- explicitly marked test customers and only when the Edge Function verifies
-- this exact non-production project. No RouterOS/RADIUS credential is read or written.
begin;

alter table public.customers
  add column if not exists portal_test_account boolean not null default false;

grant update (portal_test_account) on public.customers to authenticated;
comment on column public.customers.portal_test_account is
  'Internal staging-only customer portal test marker. Edge Functions additionally require the exact staging project URL before using PPPoE username / default-password mode.';

alter table public.customers
  drop constraint if exists customers_portal_test_account_requires_pppoe_username;
alter table public.customers
  add constraint customers_portal_test_account_requires_pppoe_username
  check (
    not portal_test_account
    or (
      pppoe_username is not null
      and length(btrim(pppoe_username)) between 1 and 64
      and pppoe_username ~ '^[[:graph:]]{1,64}$'
    )
  );

alter table private.customer_portal_credentials
  add column if not exists login_kind text not null default 'opaque';
alter table private.customer_portal_credentials
  drop constraint if exists customer_portal_credentials_login_id_check;
alter table private.customer_portal_credentials
  add constraint customer_portal_credentials_login_kind_check
  check (login_kind in ('opaque', 'pppoe_test'));
alter table private.customer_portal_credentials
  add constraint customer_portal_credentials_login_id_check
  check (
    (login_kind = 'opaque' and login_id ~ '^sf-[0-9a-f]{32}$')
    or (login_kind = 'pppoe_test' and login_id ~ '^[[:graph:]]{1,64}$')
  );

-- A mapped test username must remain stable while test credentials are active.
-- An Admin can first disable the test marker, which immediately blocks a PPPoE
-- test login; then a normal credential reset can restore the opaque username.
create or replace function private.guard_customer_portal_test_mapping()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.portal_test_account
     and new.portal_test_account
     and new.pppoe_username is distinct from old.pppoe_username then
    raise exception 'Disable staging test access before changing the PPPoE username.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_customer_portal_test_mapping() from public, anon, authenticated, service_role;
drop trigger if exists customers_guard_portal_test_mapping on public.customers;
create trigger customers_guard_portal_test_mapping
  before update of pppoe_username, portal_test_account on public.customers
  for each row execute function private.guard_customer_portal_test_mapping();

-- Replace the access helpers so disabling or changing a PPPoE test mapping also
-- blocks already-issued sessions, including any older invited-email identity.
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
        and (
          c.status <> 'active'
          or c.must_change_password
          or (
            c.login_kind = 'pppoe_test'
            and not exists (
              select 1 from public.customers mapped
              where mapped.organization_id = c.organization_id
                and mapped.id = c.customer_id
                and mapped.portal_test_account
                and mapped.pppoe_username = c.login_id
            )
          )
        )
    )
    and (
      exists (
        select 1
        from public.customer_portal_accounts a
        where a.organization_id = p_organization_id
          and a.customer_id = p_customer_id
          and a.user_id = (select auth.uid())
          and not exists (
            select 1 from public.customers marked
            where marked.organization_id = a.organization_id
              and marked.id = a.customer_id
              and marked.portal_test_account
          )
      )
      or exists (
        select 1
        from private.customer_portal_credentials c
        where c.organization_id = p_organization_id
          and c.customer_id = p_customer_id
          and c.user_id = (select auth.uid())
          and c.status = 'active'
          and c.must_change_password = false
          and (
            c.login_kind = 'opaque'
            or exists (
              select 1 from public.customers mapped
              where mapped.organization_id = c.organization_id
                and mapped.id = c.customer_id
                and mapped.portal_test_account
                and mapped.pppoe_username = c.login_id
            )
          )
      )
    );
$$;
revoke all on function public.owns_customer(uuid, text) from public, anon;
grant execute on function public.owns_customer(uuid, text) to authenticated;

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
      and not exists (
        select 1 from public.customers marked
        where marked.organization_id = a.organization_id
          and marked.id = a.customer_id
          and marked.portal_test_account
      )
    union all
    select c.organization_id, c.customer_id
    from private.customer_portal_credentials c
    where c.user_id = (select auth.uid())
      and c.status = 'active'
      and c.must_change_password = false
      and (
        c.login_kind = 'opaque'
        or exists (
          select 1 from public.customers mapped
          where mapped.organization_id = c.organization_id
            and mapped.id = c.customer_id
            and mapped.portal_test_account
            and mapped.pppoe_username = c.login_id
        )
      )
  ) q
  where (select auth.uid()) is not null
    and not exists (
      select 1
      from private.customer_portal_credentials pending
      where pending.organization_id = q.organization_id
        and pending.customer_id = q.customer_id
        and (
          pending.status <> 'active'
          or pending.must_change_password
          or (
            pending.login_kind = 'pppoe_test'
            and not exists (
              select 1 from public.customers mapped
              where mapped.organization_id = pending.organization_id
                and mapped.id = pending.customer_id
                and mapped.portal_test_account
                and mapped.pppoe_username = pending.login_id
            )
          )
        )
    );
$$;
revoke all on function public.my_customer_portal_contexts() from public, anon;
grant execute on function public.my_customer_portal_contexts() to authenticated;

create or replace function public.my_customer_portal_password_state()
returns table (state text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select case
      when c.user_id is null then 'none'
      when c.login_kind = 'pppoe_test' and not exists (
        select 1 from public.customers mapped
        where mapped.organization_id = c.organization_id
          and mapped.id = c.customer_id
          and mapped.portal_test_account
          and mapped.pppoe_username = c.login_id
      ) then 'locked'
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

-- The service-only resolver accepts exact PPPoE casing only for active staging
-- test mappings; ordinary issued credentials keep their opaque sf-* identifier.
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
     or p_login_id !~ '^[[:graph:]]{1,64}$' then
    return pg_catalog.jsonb_build_object('status', v_state);
  end if;
  select c.* into v_credential
  from private.customer_portal_credentials c
  where c.login_id = p_login_id
    and (
      c.login_kind = 'opaque'
      or exists (
        select 1 from public.customers mapped
        where mapped.organization_id = c.organization_id
          and mapped.id = c.customer_id
          and mapped.portal_test_account
          and mapped.pppoe_username = c.login_id
      )
    )
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

-- Keep the existing owner/admin authorization, issuance quotas, locks and audit
-- behavior by wrapping the established reservation RPC. The exact project gate is
-- computed by manage-customer-credentials, never accepted from the browser.
create or replace function public.reserve_customer_portal_credential_for_login(
  p_organization_id uuid,
  p_customer_id text,
  p_actor_id uuid,
  p_reason text,
  p_login_id text,
  p_auth_email_alias text,
  p_actor_ip_hash text,
  p_is_staging_project boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer public.customers%rowtype;
  v_reservation jsonb;
  v_test_login boolean;
  v_current_kind text;
begin
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = p_actor_id
      and m.role in ('owner', 'admin')
  ) then
    return pg_catalog.jsonb_build_object('status', 'forbidden');
  end if;
  select c.* into v_customer
  from public.customers c
  where c.organization_id = p_organization_id
    and c.id = p_customer_id
    and c.archived = false
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;

  v_test_login := coalesce(p_is_staging_project, false) and v_customer.portal_test_account;
  if v_test_login and (
    v_customer.pppoe_username is null
    or length(btrim(v_customer.pppoe_username)) not between 1 and 64
    or v_customer.pppoe_username !~ '^[[:graph:]]{1,64}$'
  ) then
    return pg_catalog.jsonb_build_object('status', 'invalid_test_mapping');
  end if;
  if v_test_login and exists (
    select 1 from private.customer_portal_credentials other
    where other.login_id = v_customer.pppoe_username
      and (other.organization_id, other.customer_id) <> (p_organization_id, p_customer_id)
  ) then
    return pg_catalog.jsonb_build_object('status', 'username_conflict');
  end if;

  v_reservation := public.reserve_customer_portal_credential(
    p_organization_id, p_customer_id, p_actor_id, p_reason,
    p_login_id, p_auth_email_alias, p_actor_ip_hash
  );
  if v_reservation ->> 'status' <> 'reserved' then
    return v_reservation;
  end if;

  if v_test_login then
    update private.customer_portal_credentials c
    set login_id = v_customer.pppoe_username,
        login_kind = 'pppoe_test',
        updated_at = clock_timestamp()
    where c.organization_id = p_organization_id and c.customer_id = p_customer_id;
    return v_reservation || pg_catalog.jsonb_build_object(
      'login_id', v_customer.pppoe_username,
      'test_account', true
    );
  end if;

  select c.login_kind into v_current_kind
  from private.customer_portal_credentials c
  where c.organization_id = p_organization_id and c.customer_id = p_customer_id
  for update;
  if v_current_kind = 'pppoe_test' then
    update private.customer_portal_credentials c
    set login_id = p_login_id,
        login_kind = 'opaque',
        updated_at = clock_timestamp()
    where c.organization_id = p_organization_id and c.customer_id = p_customer_id;
    v_reservation := v_reservation || pg_catalog.jsonb_build_object('login_id', p_login_id);
  end if;
  return v_reservation || pg_catalog.jsonb_build_object('test_account', false);
end;
$$;
revoke all on function public.reserve_customer_portal_credential_for_login(uuid, text, uuid, text, text, text, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_customer_portal_credential_for_login(uuid, text, uuid, text, text, text, text, boolean)
  to service_role;

comment on function public.reserve_customer_portal_credential_for_login(uuid, text, uuid, text, text, text, text, boolean) is
  'Server-only credential reservation adapter; PPPoE username login is available only when the exact staging project and the customer test marker are both verified.';

commit;
