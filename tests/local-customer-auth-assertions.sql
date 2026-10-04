-- Runs only against the disposable database created by tests/run-local-customer-auth.sh.
\set ON_ERROR_STOP on
begin;

alter table public.customers enable row level security;
alter table public.synthetic_customer_data enable row level security;
grant select on public.customers, public.synthetic_customer_data to authenticated;
grant select on public.organization_memberships to authenticated;
grant update (pppoe_username, portal_test_account) on public.customers to authenticated;
create policy synthetic_customers_owner_read on public.customers
  for select to authenticated
  using (public.owns_customer(organization_id, id));
create policy synthetic_customers_admin_read on public.customers
  for select to authenticated
  using (exists (
    select 1 from public.organization_memberships m
    where m.organization_id = customers.organization_id
      and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  ));
create policy synthetic_customers_admin_update on public.customers
  for update to authenticated
  using (exists (
    select 1 from public.organization_memberships m
    where m.organization_id = customers.organization_id
      and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  ))
  with check (exists (
    select 1 from public.organization_memberships m
    where m.organization_id = customers.organization_id
      and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  ));
create policy synthetic_customer_data_owner_read on public.synthetic_customer_data
  for select to authenticated
  using (public.owns_customer(organization_id, customer_id));

DO $$
begin
  if has_schema_privilege('authenticated', 'private', 'USAGE') then
    raise exception 'authenticated unexpectedly has private schema access';
  end if;
  if has_table_privilege('authenticated', 'private.customer_portal_credentials', 'SELECT') then
    raise exception 'authenticated unexpectedly can select credential mappings';
  end if;
  if has_table_privilege('authenticated', 'private.customer_portal_credential_audit', 'SELECT') then
    raise exception 'authenticated unexpectedly can select credential audit';
  end if;
  if has_function_privilege('authenticated', 'public.resolve_customer_portal_login(text)', 'EXECUTE') then
    raise exception 'authenticated unexpectedly can resolve usernames';
  end if;
  if has_function_privilege('authenticated', 'public.reserve_customer_portal_credential_for_login(uuid,text,uuid,text,text,text,text,boolean)', 'EXECUTE') then
    raise exception 'authenticated unexpectedly can set staging test mode through the server-only RPC';
  end if;
  if not has_function_privilege('service_role', 'public.reserve_customer_portal_credential_for_login(uuid,text,uuid,text,text,text,text,boolean)', 'EXECUTE') then
    raise exception 'service role cannot call the test-aware reservation adapter';
  end if;
  if not has_function_privilege('authenticated', 'public.my_customer_portal_contexts()', 'EXECUTE') then
    raise exception 'authenticated cannot call the safe context RPC';
  end if;
end
$$;

-- A customer can never set the internal test marker themselves.
set local role authenticated;
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000005', true);
update public.customers set portal_test_account = true
where organization_id = '10000000-0000-4000-8000-000000000001'
  and id = 'synthetic-customer-27';
reset role;
DO $$
begin
  if (select portal_test_account from public.customers where id = 'synthetic-customer-27') then
    raise exception 'customer changed the internal test marker';
  end if;
end
$$;

-- The legacy invited-email identity can read before any credential reset exists.
set local role authenticated;
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000005', true);
DO $$
begin
  if (select count(*) from public.customers) <> 1 then raise exception 'legacy customer read should work before issue'; end if;
  if (select count(*) from public.synthetic_customer_data) <> 1 then raise exception 'customer data read should work before issue'; end if;
end
$$;
reset role;

-- Reservation is created before the synthetic Auth user and immediately locks RLS.
DO $$
declare result jsonb;
begin
  result := public.reserve_customer_portal_credential(
    '10000000-0000-4000-8000-000000000001', 'synthetic-customer-27',
    '30000000-0000-4000-8000-000000000003', 'Synthetic identity check completed at ISP office.',
    'sf-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'portal-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@internal.shahdara.net', repeat('c', 64)
  );
  if result ->> 'status' <> 'reserved' or result ->> 'action' <> 'issue' then
    raise exception 'initial reservation did not return reserved issue: %', result;
  end if;
end
$$;
insert into auth.users(id, email, email_confirmed_at)
values ('60000000-0000-4000-8000-000000000006',
        'portal-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@internal.shahdara.net', now());
DO $$
declare result jsonb;
begin
  result := public.complete_customer_portal_credential(
    '10000000-0000-4000-8000-000000000001', 'synthetic-customer-27',
    '30000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000006'
  );
  if result ->> 'status' <> 'ok' or result ->> 'expires_at' is null then
    raise exception 'credential completion did not return an expiry: %', result;
  end if;
  result := public.resolve_customer_portal_login('sf-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  if result ->> 'status' <> 'temporary' then raise exception 'new credential should be temporary: %', result; end if;
  if result ->> 'auth_email_alias' <> 'portal-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@internal.shahdara.net' then
    raise exception 'synthetic Auth alias did not resolve on the private server path';
  end if;
  result := public.claim_customer_portal_temporary_password('60000000-0000-4000-8000-000000000006');
  if result ->> 'status' <> 'ok' then raise exception 'first temporary claim should succeed: %', result; end if;
  result := public.claim_customer_portal_temporary_password('60000000-0000-4000-8000-000000000006');
  if result ->> 'status' <> 'rejected' then raise exception 'second temporary claim must fail: %', result; end if;
end
$$;

-- Pending/claimed state blocks both the temporary account and the older invited-email identity.
set local role authenticated;
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000005', true);
DO $$
begin
  if (select count(*) from public.customers) <> 0 then raise exception 'legacy identity bypassed the reset gate'; end if;
  if (select count(*) from public.synthetic_customer_data) <> 0 then raise exception 'legacy identity read gated customer data'; end if;
end
$$;
select set_config('request.jwt.claim.sub', '60000000-0000-4000-8000-000000000006', true);
DO $$
begin
  if (select count(*) from public.customers) <> 0 then raise exception 'temporary identity read customers before change'; end if;
  if (select count(*) from public.synthetic_customer_data) <> 0 then raise exception 'temporary identity read data before change'; end if;
  if (select count(*) from public.my_customer_portal_contexts()) <> 0 then raise exception 'pending identity received a data context'; end if;
  if (select state from public.my_customer_portal_password_state()) <> 'change_required' then raise exception 'password state RPC did not require change'; end if;
end
$$;
reset role;

DO $$
declare result jsonb;
begin
  result := public.begin_customer_portal_password_change('60000000-0000-4000-8000-000000000006');
  if result ->> 'status' <> 'ok' then raise exception 'password change lease failed: %', result; end if;
end
$$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '60000000-0000-4000-8000-000000000006', true);
DO $$
begin
  if (select count(*) from public.synthetic_customer_data) <> 0 then raise exception 'changing state was not locked'; end if;
end
$$;
reset role;
DO $$
declare result jsonb;
begin
  result := public.complete_customer_portal_password_change('60000000-0000-4000-8000-000000000006');
  if result ->> 'status' <> 'ok' then raise exception 'password change completion failed: %', result; end if;
end
$$;

-- Active state permits both existing linked identities; the safe RPC still returns IDs only.
set local role authenticated;
select set_config('request.jwt.claim.sub', '60000000-0000-4000-8000-000000000006', true);
DO $$
begin
  if (select count(*) from public.customers) <> 1 then raise exception 'active username identity could not read customer'; end if;
  if (select count(*) from public.synthetic_customer_data) <> 1 then raise exception 'active username identity could not read customer data'; end if;
  if (select count(*) from public.my_customer_portal_contexts()) <> 1 then raise exception 'active identity did not receive exactly one context'; end if;
  if (select state from public.my_customer_portal_password_state()) <> 'active' then raise exception 'active state not returned'; end if;
end
$$;
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000005', true);
DO $$
begin
  if (select count(*) from public.synthetic_customer_data) <> 1 then raise exception 'legacy invited identity did not recover after active reset'; end if;
end
$$;
reset role;

-- Admin reset locks every linked identity again; expiry remains locked and cannot claim a session.
DO $$
declare result jsonb;
begin
  result := public.reserve_customer_portal_credential(
    '10000000-0000-4000-8000-000000000001', 'synthetic-customer-27',
    '30000000-0000-4000-8000-000000000003', 'Synthetic in-person reset verification.',
    'sf-cccccccccccccccccccccccccccccccc',
    'portal-dddddddddddddddddddddddddddddddd@internal.shahdara.net', repeat('c', 64)
  );
  if result ->> 'status' <> 'reserved' or result ->> 'action' <> 'reset' then
    raise exception 'reset reservation did not preserve the existing mapping: %', result;
  end if;
  if result ->> 'login_id' <> 'sf-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' then
    raise exception 'reset unexpectedly changed the globally assigned username';
  end if;
  result := public.complete_customer_portal_credential(
    '10000000-0000-4000-8000-000000000001', 'synthetic-customer-27',
    '30000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000006'
  );
  if result ->> 'status' <> 'ok' then raise exception 'reset completion failed: %', result; end if;
  update private.customer_portal_credentials
  set expires_at = clock_timestamp() - interval '1 second'
  where organization_id = '10000000-0000-4000-8000-000000000001'
    and customer_id = 'synthetic-customer-27';
  result := public.resolve_customer_portal_login('sf-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  if result ->> 'status' <> 'expired' then raise exception 'expired password should not resolve: %', result; end if;
end
$$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '60000000-0000-4000-8000-000000000006', true);
DO $$
begin
  if (select count(*) from public.synthetic_customer_data) <> 0 then raise exception 'expired state was not locked'; end if;
  if (select state from public.my_customer_portal_password_state()) <> 'expired' then raise exception 'expired state not reported'; end if;
end
$$;
reset role;

-- Only the organization owner can enable the exact mapped staging test username.
set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000003', true);
update public.customers
set pppoe_username = 'Synthetic.PPPOE.27', portal_test_account = true
where organization_id = '10000000-0000-4000-8000-000000000001'
  and id = 'synthetic-customer-27';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000005', true);
DO $$
begin
  if (select count(*) from public.customers) <> 0 then raise exception 'marked test account still allowed an old invited-email login'; end if;
  if (select count(*) from public.synthetic_customer_data) <> 0 then raise exception 'marked test account exposed customer data through an old email identity'; end if;
end
$$;
reset role;
DO $$
declare result jsonb;
begin
  result := public.reserve_customer_portal_credential_for_login(
    '10000000-0000-4000-8000-000000000001', 'synthetic-customer-27',
    '30000000-0000-4000-8000-000000000003', 'Synthetic staging test account identity approved.',
    'sf-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    'portal-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee@internal.shahdara.net', repeat('c', 64), true
  );
  if result ->> 'status' <> 'reserved' or result ->> 'test_account' <> 'true' then
    raise exception 'staging marker did not reserve a test login: %', result;
  end if;
  if result ->> 'login_id' <> 'Synthetic.PPPOE.27' then
    raise exception 'test login did not use the exact mapped PPPoE username: %', result;
  end if;
  if (select login_kind from private.customer_portal_credentials where customer_id = 'synthetic-customer-27') <> 'pppoe_test' then
    raise exception 'test login kind was not recorded';
  end if;
  if (select must_change_password from private.customer_portal_credentials where customer_id = 'synthetic-customer-27') is not true then
    raise exception 'staging test login did not require first-login password change';
  end if;
  result := public.complete_customer_portal_credential(
    '10000000-0000-4000-8000-000000000001', 'synthetic-customer-27',
    '30000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000006'
  );
  if result ->> 'status' <> 'ok' then raise exception 'staging test credential completion failed: %', result; end if;
  result := public.resolve_customer_portal_login('Synthetic.PPPOE.27');
  if result ->> 'status' <> 'temporary' then raise exception 'test login should require a new password before access: %', result; end if;
  if result ->> 'user_id' <> '60000000-0000-4000-8000-000000000006' then
    raise exception 'exact PPPoE test username did not resolve to the internal Auth user';
  end if;
  result := public.resolve_customer_portal_login('synthetic.pppoe.27');
  if result ->> 'status' <> 'not_found' then raise exception 'test username resolver did not preserve exact case: %', result; end if;
  result := public.claim_customer_portal_temporary_password('60000000-0000-4000-8000-000000000006');
  if result ->> 'status' <> 'ok' then raise exception 'staging test first-login claim failed: %', result; end if;
end
$$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '60000000-0000-4000-8000-000000000006', true);
DO $$
begin
  if (select count(*) from public.customers) <> 0 then raise exception 'test customer read data before changing the shared password'; end if;
  if (select count(*) from public.synthetic_customer_data) <> 0 then raise exception 'test login read customer data before changing the shared password'; end if;
  if (select state from public.my_customer_portal_password_state()) <> 'change_required' then raise exception 'test login omitted mandatory first-login password change'; end if;
end
$$;
reset role;
DO $$
declare result jsonb;
begin
  result := public.begin_customer_portal_password_change('60000000-0000-4000-8000-000000000006');
  if result ->> 'status' <> 'ok' then raise exception 'test login password change lease failed: %', result; end if;
  result := public.complete_customer_portal_password_change('60000000-0000-4000-8000-000000000006');
  if result ->> 'status' <> 'ok' then raise exception 'test login password change completion failed: %', result; end if;
end
$$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '60000000-0000-4000-8000-000000000006', true);
DO $$
begin
  if (select count(*) from public.customers) <> 1 then raise exception 'test customer could not read after changing the password'; end if;
  if (select count(*) from public.synthetic_customer_data) <> 1 then raise exception 'test account did not unlock customer data after first password change'; end if;
end
$$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000003', true);
update public.customers set portal_test_account = false
where organization_id = '10000000-0000-4000-8000-000000000001'
  and id = 'synthetic-customer-27';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '60000000-0000-4000-8000-000000000006', true);
DO $$
begin
  if (select count(*) from public.customers) <> 0 then raise exception 'disabling the test marker did not lock the PPPoE login'; end if;
end
$$;
reset role;
DO $$
declare result jsonb;
begin
  result := public.resolve_customer_portal_login('Synthetic.PPPOE.27');
  if result ->> 'status' <> 'not_found' then raise exception 'disabled test username still resolves: %', result; end if;
end
$$;

-- The per-IP and per-username limiter has fixed windows and does not write an audit row per blocked retry.
DO $$
declare result jsonb; index integer; login_hash text; ip_hash text;
begin
  for index in 1..20 loop
    login_hash := repeat('e', 60) || lpad(to_hex(index), 4, '0');
    result := public.begin_customer_portal_login(repeat('d', 64), login_hash);
    if result ->> 'status' <> 'allowed' then raise exception 'attempt % unexpectedly limited: %', index, result; end if;
  end loop;
  login_hash := repeat('e', 60) || lpad(to_hex(21), 4, '0');
  result := public.begin_customer_portal_login(repeat('d', 64), login_hash);
  if result ->> 'status' <> 'rate_limited' then raise exception '21st attempt should be limited: %', result; end if;
  result := public.begin_customer_portal_login(repeat('d', 64), login_hash);
  if result ->> 'status' <> 'rate_limited' then raise exception 'cooldown should continue: %', result; end if;
  if (select count(*) from private.customer_portal_credential_audit
      where event_type = 'login_throttled' and source_ip_hash = repeat('d', 64)) <> 1 then
    raise exception 'per-IP cooldown start should be audited once, not on every blocked retry';
  end if;

  for index in 1..5 loop
    ip_hash := repeat('f', 60) || lpad(to_hex(index), 4, '0');
    result := public.begin_customer_portal_login(ip_hash, repeat('a', 64));
    if result ->> 'status' <> 'allowed' then raise exception 'username attempt % unexpectedly limited: %', index, result; end if;
  end loop;
  ip_hash := repeat('f', 60) || lpad(to_hex(6), 4, '0');
  result := public.begin_customer_portal_login(ip_hash, repeat('a', 64));
  if result ->> 'status' <> 'rate_limited' then raise exception 'sixth username attempt should be limited: %', result; end if;
  result := public.begin_customer_portal_login(repeat('f', 60) || lpad(to_hex(7), 4, '0'), repeat('a', 64));
  if result ->> 'status' <> 'rate_limited' then raise exception 'username cooldown should continue: %', result; end if;
  if (select count(*) from private.customer_portal_credential_audit
      where event_type = 'login_throttled' and login_key_hash = repeat('a', 64)) <> 1 then
    raise exception 'per-username cooldown start should be audited once, not on every blocked retry';
  end if;
end
$$;

rollback;
\echo 'Local synthetic customer-auth SQL assertions passed; transaction rolled back.'
