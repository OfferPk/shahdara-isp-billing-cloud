-- Synthetic-only tests. The repository runner applies this suite only inside a
-- fresh local PostgreSQL cluster and rolls the fixture transaction back.
begin;
select plan(34);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('91000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'telemetry-admin-a@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('91000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'telemetry-customer-a@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('91000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'telemetry-admin-b@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.organizations (id, name) values
  ('92000000-0000-4000-8000-000000000001', 'Synthetic Telemetry ISP A'),
  ('92000000-0000-4000-8000-000000000002', 'Synthetic Telemetry ISP B');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'owner'),
  ('92000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000003', 'admin');

insert into public.customers (organization_id, id, customer_number, name, service_status, pppoe_username) values
  ('92000000-0000-4000-8000-000000000001', 'synthetic-telemetry-customer-a', 9201, 'Synthetic Telemetry Customer A', 'offline', 'synthetic-telemetry-user-a');
insert into public.customer_private_details (organization_id, customer_id, assigned_ip) values
  ('92000000-0000-4000-8000-000000000001', 'synthetic-telemetry-customer-a', '10.0.0.99');
insert into public.customer_portal_accounts (organization_id, customer_id, user_id) values
  ('92000000-0000-4000-8000-000000000001', 'synthetic-telemetry-customer-a', '91000000-0000-4000-8000-000000000002');

select has_table('public', 'active_sessions', 'active session table exists');
select has_column('public', 'customer_private_details', 'last_seen', 'private customer details stores last_seen');
select ok(not has_table_privilege('anon', 'public.active_sessions', 'select'), 'anonymous role cannot select active sessions');
select ok(has_table_privilege('authenticated', 'public.active_sessions', 'select'), 'authenticated role has SELECT subject to admin-only RLS');
select ok(not has_table_privilege('authenticated', 'public.active_sessions', 'insert,update,delete'), 'authenticated clients have no direct active-session writes');
select ok(not has_table_privilege('service_role', 'public.active_sessions', 'select,insert,update,delete'), 'service role has no direct active-session table grants');
select ok(has_function_privilege('authenticated', 'public.sync_live_router_telemetry(uuid,jsonb)', 'execute'), 'authenticated users may reach the authorization-checked telemetry RPC');
select ok(not has_function_privilege('service_role', 'public.sync_live_router_telemetry(uuid,jsonb)', 'execute'), 'service role cannot invoke the local owner/admin telemetry RPC');

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select lives_ok(
  $$select public.sync_live_router_telemetry(
    '92000000-0000-4000-8000-000000000001',
    '[{"username":"synthetic-telemetry-user-a","session_id":"*S1","uptime":"2h","caller_id":"AA:BB:CC:DD:EE:FF","ip_address":"10.20.30.41","tx_bytes":"100","rx_bytes":"25"}]'::jsonb
  )$$,
  'same-organization owner syncs a valid live PPP session'
);
reset role;

select is((select count(*)::integer from public.active_sessions where organization_id = '92000000-0000-4000-8000-000000000001'), 1, 'live session is persisted');
select is((select status from public.active_sessions where username = 'synthetic-telemetry-user-a'), 'online'::text, 'active session status is online');
select is((select caller_id from public.active_sessions where username = 'synthetic-telemetry-user-a'), 'AA:BB:CC:DD:EE:FF'::text, 'RouterOS caller ID is stored for admins');
select is((select tx_bytes from public.active_sessions where username = 'synthetic-telemetry-user-a'), 100::bigint, 'RouterOS Tx is retained as customer download');
select is((select rx_bytes from public.active_sessions where username = 'synthetic-telemetry-user-a'), 25::bigint, 'RouterOS Rx is retained as customer upload');
select is((select service_status from public.customers where id = 'synthetic-telemetry-customer-a'), 'active'::text, 'mapped customer becomes active');
select is((select assigned_ip from public.customer_private_details where customer_id = 'synthetic-telemetry-customer-a'), '10.20.30.41'::text, 'live assigned IP is refreshed in private details');
select ok((select last_seen > '2000-01-01T00:00:00Z'::timestamptz from public.customer_private_details where customer_id = 'synthetic-telemetry-customer-a'), 'private last_seen advances on an online poll');
select is((select bytes_in from public.customer_bandwidth_monthly_usage where username = 'synthetic-telemetry-user-a'), 100::bigint, 'first RouterOS Tx counter is counted as monthly download');
select is((select bytes_out from public.customer_bandwidth_monthly_usage where username = 'synthetic-telemetry-user-a'), 25::bigint, 'first RouterOS Rx counter is counted as monthly upload');
select set_config('test.live_bridge_last_seen', (select last_seen::text from public.customer_private_details where customer_id = 'synthetic-telemetry-customer-a'), true);

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select lives_ok(
  $$select public.sync_live_router_telemetry(
    '92000000-0000-4000-8000-000000000001',
    '[{"username":"synthetic-telemetry-user-a","session_id":"*S1","uptime":"2h10m","caller_id":"AA:BB:CC:DD:EE:FF","ip_address":"10.20.30.42","tx_bytes":"150","rx_bytes":"40"}]'::jsonb
  )$$,
  'repeat snapshot updates the same active session'
);
reset role;
select is((select bytes_in from public.customer_bandwidth_monthly_usage where username = 'synthetic-telemetry-user-a'), 150::bigint, 'monthly download adds only the new Tx delta');
select is((select bytes_out from public.customer_bandwidth_monthly_usage where username = 'synthetic-telemetry-user-a'), 40::bigint, 'monthly upload adds only the new Rx delta');
select is((select assigned_ip from public.customer_private_details where customer_id = 'synthetic-telemetry-customer-a'), '10.20.30.42'::text, 'a newer poll refreshes the assigned IP');
select set_config('test.live_bridge_last_seen', (select last_seen::text from public.customer_private_details where customer_id = 'synthetic-telemetry-customer-a'), true);

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select lives_ok(
  $$select public.sync_live_router_telemetry('92000000-0000-4000-8000-000000000001', '[]'::jsonb)$$,
  'a complete empty poll is accepted as an authoritative offline snapshot'
);
reset role;
select is((select status from public.active_sessions where username = 'synthetic-telemetry-user-a'), 'offline'::text, 'missing PPP session is marked offline');
select is((select service_status from public.customers where id = 'synthetic-telemetry-customer-a'), 'offline'::text, 'mapped customer becomes offline');
select is((select assigned_ip from public.customer_private_details where customer_id = 'synthetic-telemetry-customer-a'), null::text, 'offline snapshot clears the stale assigned IP');
select is((select last_seen::text from public.customer_private_details where customer_id = 'synthetic-telemetry-customer-a'), current_setting('test.live_bridge_last_seen'), 'offline snapshot retains last online timestamp');

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000002', true);
select is((select count(*)::integer from public.customer_bandwidth_monthly_usage), 1, 'customer can read their own monthly usage row');
select is((select count(*)::integer from public.active_sessions), 0, 'customer cannot read staff-only session rows');
select throws_ok(
  $$select public.sync_live_router_telemetry('92000000-0000-4000-8000-000000000001', '[]'::jsonb)$$,
  '42501', null, 'customer cannot invoke admin telemetry sync'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000003', true);
select throws_ok(
  $$select public.sync_live_router_telemetry('92000000-0000-4000-8000-000000000001', '[]'::jsonb)$$,
  '42501', null, 'another organization admin cannot sync this organization'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select is(
  (public.sync_live_router_telemetry(
    '92000000-0000-4000-8000-000000000001',
    '[{"username":"unmapped-synthetic-user","session_id":"*S9","uptime":"1m","caller_id":"","ip_address":"10.20.30.99","tx_bytes":"1","rx_bytes":"2"}]'::jsonb
  ) ->> 'unmatched_sessions'),
  '1'::text,
  'unmapped router usernames are safely skipped'
);
reset role;
select is((select count(*)::integer from public.active_sessions where username = 'unmapped-synthetic-user'), 0, 'unmapped username creates no session row');

select * from finish();
rollback;
