-- Synthetic-only tests. The repository runner applies this suite only inside a
-- fresh, local PostgreSQL cluster and rolls the fixture transaction back.
begin;
select plan(39);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('81000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'bandwidth-admin-a@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('81000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'bandwidth-customer-a@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('81000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'bandwidth-customer-b@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('81000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'bandwidth-admin-b@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('81000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'bandwidth-customer-c@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.organizations (id, name) values
  ('82000000-0000-4000-8000-000000000001', 'Synthetic Bandwidth ISP A'),
  ('82000000-0000-4000-8000-000000000002', 'Synthetic Bandwidth ISP B');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'admin'),
  ('82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000004', 'admin');

insert into public.customers (organization_id, id, customer_number, name, pppoe_username) values
  ('82000000-0000-4000-8000-000000000001', 'synthetic-bandwidth-customer-a', 8101, 'Synthetic Bandwidth Customer A', 'synthetic-pppoe-a'),
  ('82000000-0000-4000-8000-000000000001', 'synthetic-bandwidth-customer-b', 8102, 'Synthetic Bandwidth Customer B', 'synthetic-pppoe-b'),
  ('82000000-0000-4000-8000-000000000001', 'synthetic-bandwidth-customer-d', 8103, 'Synthetic Bandwidth Customer D', 'synthetic-pppoe-d'),
  ('82000000-0000-4000-8000-000000000002', 'synthetic-bandwidth-customer-c', 8201, 'Synthetic Bandwidth Customer C', 'synthetic-pppoe-c'),
  ('82000000-0000-4000-8000-000000000002', 'synthetic-bandwidth-customer-e', 8202, 'Synthetic Bandwidth Customer E', 'synthetic-pppoe-e');
insert into public.customer_portal_accounts (organization_id, customer_id, user_id) values
  ('82000000-0000-4000-8000-000000000001', 'synthetic-bandwidth-customer-a', '81000000-0000-4000-8000-000000000002'),
  ('82000000-0000-4000-8000-000000000001', 'synthetic-bandwidth-customer-b', '81000000-0000-4000-8000-000000000003'),
  ('82000000-0000-4000-8000-000000000002', 'synthetic-bandwidth-customer-c', '81000000-0000-4000-8000-000000000005');

insert into public.customer_bandwidth_usage (
  username, total_quota_bytes, bytes_in, bytes_out, is_online, last_ip,
  last_synced_at, created_at
) values
  ('synthetic-pppoe-a', 8192, 1000, 2000, false, '192.0.2.1', '2000-01-01T00:00:00Z', '1999-01-01T00:00:00Z'),
  ('synthetic-pppoe-b', 0, 111, 222, true, '192.0.2.2', '2000-01-01T00:00:00Z', '1999-01-01T00:00:00Z'),
  ('synthetic-pppoe-c', 0, 999, 888, true, '192.0.2.3', '2000-01-01T00:00:00Z', '1999-01-01T00:00:00Z');

select has_table('public', 'customer_bandwidth_usage', 'usage table exists');
select has_column('public', 'customers', 'pppoe_username', 'customer profile has the trusted PPPoE username mapping');
select ok(not has_table_privilege('anon', 'public.customer_bandwidth_usage', 'select'), 'anonymous role cannot select usage rows');
select ok(has_table_privilege('authenticated', 'public.customer_bandwidth_usage', 'select'), 'authenticated role has SELECT subject to RLS');
select ok(has_table_privilege('authenticated', 'public.customer_bandwidth_usage', 'insert,update,delete'), 'authenticated role has write grants subject to admin-only RLS');
select ok(not has_table_privilege('service_role', 'public.customer_bandwidth_usage', 'select,insert,update,delete'), 'service role has no direct usage-table grants');
select ok(has_function_privilege('service_role', 'public.sync_customer_bandwidth_usage(text,bigint,bigint,boolean,text)', 'execute'), 'service role can invoke the server-side sync RPC');
select ok(not has_function_privilege('authenticated', 'public.sync_customer_bandwidth_usage(text,bigint,bigint,boolean,text)', 'execute'), 'authenticated clients cannot invoke the sync RPC');

set local role authenticated;
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000002', true);
select is(current_user::text, 'authenticated'::text, 'customer RLS assertions execute as authenticated');
select is((select count(*)::integer from public.customer_bandwidth_usage), 1, 'customer A sees exactly one linked usage row');
select is((select username from public.customer_bandwidth_usage), 'synthetic-pppoe-a'::text, 'customer A can read their own mapped username');
select is((select count(*)::integer from public.customer_bandwidth_usage where username = 'synthetic-pppoe-b'), 0, 'customer A cannot read customer B in the same organization');
select is((select count(*)::integer from public.customer_bandwidth_usage where username = 'synthetic-pppoe-c'), 0, 'customer A cannot read another organization usage row');
select throws_ok(
  $$insert into public.customer_bandwidth_usage (username, bytes_in, bytes_out) values ('synthetic-pppoe-d', 7, 9)$$,
  '42501', null, 'customer cannot insert usage rows'
);
update public.customer_bandwidth_usage set bytes_in = 7777 where username = 'synthetic-pppoe-a';
select is((select bytes_in from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a'), 1000::bigint, 'customer update attempt leaves counters unchanged');
delete from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a';
select is((select count(*)::integer from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a'), 1, 'customer delete attempt leaves their row intact');
update public.customers set pppoe_username = 'forged-client-username'
where id = 'synthetic-bandwidth-customer-a';
select is((select pppoe_username from public.customers where id = 'synthetic-bandwidth-customer-a'), 'synthetic-pppoe-a'::text, 'customer mapping remains unchanged after the attempted write');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000003', true);
select is((select count(*)::integer from public.customer_bandwidth_usage), 1, 'customer B sees only their own usage row');
select is((select count(*)::integer from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a'), 0, 'customer B cannot read customer A usage');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000001', true);
select is(current_user::text, 'authenticated'::text, 'admin RLS assertions execute as authenticated');
select is((select count(*)::integer from public.customer_bandwidth_usage), 2, 'organization A admin sees all usage rows in their organization');
select is((select count(*)::integer from public.customer_bandwidth_usage where username = 'synthetic-pppoe-c'), 0, 'organization A admin cannot cross into organization B');
update public.customer_bandwidth_usage
set bytes_in = 4321, total_quota_bytes = 16384
where username = 'synthetic-pppoe-a';
select is((select bytes_in from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a'), 4321::bigint, 'admin update is saved');
select is((select total_quota_bytes from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a'), 16384::bigint, 'admin can manage the customer quota');
select lives_ok(
  $$insert into public.customer_bandwidth_usage (username, bytes_in, bytes_out) values ('synthetic-pppoe-d', 10, 20)$$,
  'admin can insert usage for a mapped customer in their organization'
);
select is((select count(*)::integer from public.customer_bandwidth_usage where username = 'synthetic-pppoe-d'), 1, 'admin-inserted usage row is visible');
select throws_ok(
  $$insert into public.customer_bandwidth_usage (username, bytes_in, bytes_out) values ('synthetic-pppoe-e', 1, 1)$$,
  '42501', null, 'admin cannot insert usage for another organization'
);
delete from public.customer_bandwidth_usage where username = 'synthetic-pppoe-d';
select is((select count(*)::integer from public.customer_bandwidth_usage where username = 'synthetic-pppoe-d'), 0, 'admin delete is saved');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000004', true);
select is((select count(*)::integer from public.customer_bandwidth_usage), 1, 'organization B admin sees all usage rows in their organization');
select is((select count(*)::integer from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a'), 0, 'organization B admin cannot read organization A usage');

reset role;
set local role service_role;
select is(current_user::text, 'service_role'::text, 'sync path is exercised using the dedicated server role');
select lives_ok(
  $$select public.sync_customer_bandwidth_usage('synthetic-pppoe-a', 987, 654, true, '192.0.2.9')$$,
  'service role can upsert usage through the narrow server-only RPC'
);
reset role;
select is((select bytes_in from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a'), 987::bigint, 'sync RPC updates download bytes_in');
select is((select bytes_out from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a'), 654::bigint, 'sync RPC updates upload bytes_out');
select is((select is_online from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a'), true, 'sync RPC updates online status');
select is((select last_ip from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a'), '192.0.2.9'::text, 'sync RPC updates last IP');
select is((select total_quota_bytes from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a'), 16384::bigint, 'sync RPC preserves the admin-managed quota');
select ok((select last_synced_at > '2000-01-01T00:00:00Z'::timestamptz from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a'), 'sync RPC advances last_synced_at');
select is((select created_at from public.customer_bandwidth_usage where username = 'synthetic-pppoe-a'), '1999-01-01T00:00:00Z'::timestamptz, 'sync RPC preserves created_at on upsert');

select * from finish();
rollback;
