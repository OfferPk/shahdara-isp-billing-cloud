-- Synthetic-only usage integration tests. Run against a local disposable Supabase
-- stack or an explicitly approved staging transaction; never use real customers.
begin;
select plan(36);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('10000000-0000-4000-8000-000000000101', 'authenticated', 'authenticated', 'usage-admin-a@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('10000000-0000-4000-8000-000000000102', 'authenticated', 'authenticated', 'usage-customer-a@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('10000000-0000-4000-8000-000000000103', 'authenticated', 'authenticated', 'usage-customer-b@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('10000000-0000-4000-8000-000000000104', 'authenticated', 'authenticated', 'usage-admin-b@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.organizations (id, name) values
  ('20000000-0000-4000-8000-000000000101', 'Synthetic Usage ISP A'),
  ('20000000-0000-4000-8000-000000000102', 'Synthetic Usage ISP B');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('20000000-0000-4000-8000-000000000101', '10000000-0000-4000-8000-000000000101', 'admin'),
  ('20000000-0000-4000-8000-000000000102', '10000000-0000-4000-8000-000000000104', 'admin');
insert into public.customers (organization_id, id, customer_number, name, plan_name, monthly_fee_cents, service_status) values
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-a', 71, 'Synthetic Usage A', 'Example 5 Mbps', 10000, 'active'),
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-b', 72, 'Synthetic Usage B', 'Example 5 Mbps', 10000, 'active'),
  ('20000000-0000-4000-8000-000000000102', 'synthetic-usage-c', 71, 'Synthetic Usage C', 'Example 5 Mbps', 10000, 'active');
insert into public.customer_portal_accounts (organization_id, customer_id, user_id) values
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-a', '10000000-0000-4000-8000-000000000102'),
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-b', '10000000-0000-4000-8000-000000000103');

insert into public.pppoe_usage_sites (site_id, organization_id, display_name)
values ('usage-site-a', '20000000-0000-4000-8000-000000000101', 'Synthetic site');
insert into public.pppoe_usage_mappings (
  organization_id, site_id, pppoe_username, customer_id, quota_bytes, speed_download_bps, speed_upload_bps
) values (
  '20000000-0000-4000-8000-000000000101', 'usage-site-a', 'synthetic-pppoe-a',
  'synthetic-usage-a', 100000000000, 5000000, 1000000
);
insert into public.pppoe_usage_customer_months (
  organization_id, customer_id, period_start, quota_bytes, speed_download_bps,
  speed_upload_bps, source_count, fresh_source_count, last_collector_contact_at
) values
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-a', date_trunc('month', now() at time zone 'Asia/Karachi')::date, 100000000000, 5000000, 1000000, 1, 1, now()),
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-b', date_trunc('month', now() at time zone 'Asia/Karachi')::date, 100000000000, 5000000, 1000000, 1, 1, now());
insert into public.pppoe_usage_customer_sources (organization_id, customer_id, period_start, site_id, last_contact_at)
values
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-a', date_trunc('month', now() at time zone 'Asia/Karachi')::date, 'usage-site-a', now()),
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-b', date_trunc('month', now() at time zone 'Asia/Karachi')::date, 'usage-site-a', now());

-- Three synthetic boundary samples for customer B. The half-open window must
-- include the exact start, include the final instant before end, and exclude end.
insert into public.pppoe_usage_customer_deltas (
  organization_id, customer_id, snapshot_id, sampled_at, delta_bytes_in, delta_bytes_out
) values
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-b', '50000000-0000-4000-8000-000000000001', now() - interval '2 hours', 10, 20),
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-b', '50000000-0000-4000-8000-000000000002', now() - interval '1 microsecond', 4, 5),
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-b', '50000000-0000-4000-8000-000000000003', now(), 1000, 1000);

select ok(not has_table_privilege('anon', 'public.pppoe_usage_logs', 'select'), 'anon cannot read raw PPPoE snapshots');
select ok(not has_table_privilege('authenticated', 'public.pppoe_usage_logs', 'select'), 'authenticated cannot read raw PPPoE identities or counters');
select ok(not has_table_privilege('authenticated', 'public.pppoe_usage_customer_deltas', 'insert,update,delete'), 'browser customers cannot write usage deltas');
select ok(not has_table_privilege('anon', 'public.pppoe_usage_current_month', 'select'), 'anon cannot read customer usage views');
select ok(has_function_privilege('service_role', 'public.process_pppoe_usage_snapshot(text,uuid,uuid,timestamptz,text,jsonb)', 'execute'), 'only server-side collector flow needs the snapshot RPC');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.process_pppoe_usage_snapshot(
    'usage-site-a', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
    now() - interval '5 minutes', repeat('a', 64),
    jsonb_build_object('snapshot_id', '30000000-0000-4000-8000-000000000001', 'sampled_at', (now() - interval '5 minutes')::text,
      'sessions', jsonb_build_array(
        jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'router-session-a', 'session_key', '50000000-0000-4000-8000-000000000101', 'uptime_seconds', 100, 'bytes_in', '100', 'bytes_out', '200'),
        jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'router-session-b', 'session_key', '50000000-0000-4000-8000-000000000102', 'uptime_seconds', 100, 'bytes_in', '300', 'bytes_out', '400')
      )
    )
  )->>'accepted')::boolean, true, 'first signed batch accepts multiple sessions for one mapped customer');
select is((select delta_bytes_in from public.pppoe_usage_customer_deltas where customer_id = 'synthetic-usage-a' and snapshot_id = '30000000-0000-4000-8000-000000000001' limit 1), 400::bigint, 'first batch aggregates upload deltas across both sessions');
select is((select delta_bytes_out from public.pppoe_usage_customer_deltas where customer_id = 'synthetic-usage-a' and snapshot_id = '30000000-0000-4000-8000-000000000001' limit 1), 600::bigint, 'first batch aggregates download deltas across both sessions');
select is(
  (public.process_pppoe_usage_snapshot(
    'usage-site-a', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
    now() - interval '5 minutes', repeat('a', 64),
    jsonb_build_object('snapshot_id', '30000000-0000-4000-8000-000000000001', 'sampled_at', (now() - interval '5 minutes')::text,
      'sessions', jsonb_build_array(
        jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'router-session-a', 'session_key', '50000000-0000-4000-8000-000000000101', 'uptime_seconds', 100, 'bytes_in', '100', 'bytes_out', '200'),
        jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'router-session-b', 'session_key', '50000000-0000-4000-8000-000000000102', 'uptime_seconds', 100, 'bytes_in', '300', 'bytes_out', '400')
      )
    )
  )->>'duplicate')::boolean, true, 'same snapshot replay is accepted idempotently');
select is((select count(*)::integer from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000001'), 2, 'duplicate batch does not add raw session snapshots');
select throws_ok(
  $$select public.process_pppoe_usage_snapshot('usage-site-a', '30000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000001', now() - interval '3 minutes', repeat('b', 64), jsonb_build_object('snapshot_id', '30000000-0000-4000-8000-000000000004', 'sampled_at', (now() - interval '3 minutes')::text, 'sessions', '[]'::jsonb))$$,
  '23505', null, 'reused nonce cannot authenticate a different snapshot'
);
select is(
  (public.process_pppoe_usage_snapshot(
    'usage-site-a', '30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002',
    now() - interval '4 minutes', repeat('c', 64),
    jsonb_build_object('snapshot_id', '30000000-0000-4000-8000-000000000002', 'sampled_at', (now() - interval '4 minutes')::text,
      'sessions', jsonb_build_array(
        jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'router-session-a', 'session_key', '50000000-0000-4000-8000-000000000101', 'uptime_seconds', 160, 'bytes_in', '150', 'bytes_out', '250'),
        jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'router-session-b', 'session_key', '50000000-0000-4000-8000-000000000102', 'uptime_seconds', 10, 'bytes_in', '20', 'bytes_out', '30')
      )
    )
  )->>'accepted')::boolean, true, 'second batch accepts monotonic increment plus a counter reset');
select is((select count(*)::integer from public.pppoe_usage_customer_deltas where customer_id = 'synthetic-usage-a'), 2, 'one aggregate delta row is stored per accepted snapshot');
select is((select used_bytes from public.pppoe_usage_current_month where customer_id = 'synthetic-usage-a' limit 1), 1150::bigint, 'monthly usage sums validated increments and reset baselines, not cumulative totals');
select is((select upload_bytes from public.pppoe_usage_current_month where customer_id = 'synthetic-usage-a' limit 1), 470::bigint, 'monthly upload includes all validated per-sample upload deltas');
select is((select download_bytes from public.pppoe_usage_current_month where customer_id = 'synthetic-usage-a' limit 1), 680::bigint, 'monthly download includes all validated per-sample download deltas');
select is((select counter_reset from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000002' and session_id = 'router-session-b' limit 1), true, 'decreased counters and uptime mark a new session segment');
select is((select delta_bytes_in from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000002' and session_id = 'router-session-b' limit 1), 20::bigint, 'reset sample contributes its new upload counter as a nonnegative baseline');
select is((select delta_bytes_out from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000002' and session_id = 'router-session-b' limit 1), 30::bigint, 'reset sample contributes its new download counter as a nonnegative baseline');
select ok((select session_key <> '50000000-0000-4000-8000-000000000102'::uuid from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000002' and session_id = 'router-session-b' limit 1), 'reset rotates stable session identity to a new segment key');
select is(
  (public.process_pppoe_usage_snapshot(
    'usage-site-a', '30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000003',
    now() - interval '6 minutes', repeat('d', 64),
    jsonb_build_object('snapshot_id', '30000000-0000-4000-8000-000000000003', 'sampled_at', (now() - interval '6 minutes')::text,
      'sessions', jsonb_build_array(
        jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'router-session-a', 'session_key', '50000000-0000-4000-8000-000000000101', 'uptime_seconds', 160, 'bytes_in', '180', 'bytes_out', '280')
      )
    )
  )->>'accepted')::boolean, true, 'older out-of-order batch is retained as an observation');
select is((select delta_bytes_in from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000003' and session_id = 'router-session-a' limit 1), 0::bigint, 'out-of-order observation contributes zero delta');
select is((select count(*)::integer from public.pppoe_usage_customer_deltas where customer_id = 'synthetic-usage-a'), 2, 'out-of-order sample does not alter customer usage totals');
reset role;

select is((select used_bytes from public.pppoe_usage_rollup(now() - interval '2 hours', now()) where customer_id = 'synthetic-usage-b' limit 1), 39::bigint, 'half-open rolling window includes exact start and excludes the sample at exact end');

-- Preserve a trusted expected aggregate row for equality checks as customer and Admin.
update public.pppoe_usage_customer_months
set fresh_source_count = 0, last_collector_contact_at = now() - interval '1 hour'
where customer_id = 'synthetic-usage-a';
create temp table expected_usage_summary as
select organization_id, customer_id, period_start, upload_bytes, download_bytes, used_bytes,
       quota_bytes, remaining_bytes, speed_download_bps, speed_upload_bps,
       last_collector_contact_at, is_stale
from public.pppoe_usage_current_month
where customer_id = 'synthetic-usage-a';
grant select on expected_usage_summary to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
select is((select count(*)::integer from public.pppoe_usage_current_month where organization_id = '20000000-0000-4000-8000-000000000101'), 2, 'same-organization Admin sees all mapped customer usage summaries');
select is((select used_bytes from public.pppoe_usage_current_month where customer_id = 'synthetic-usage-a' limit 1), 1150::bigint, 'Admin summary used total equals validated customer aggregate');
select is((select jsonb_build_array(period_start, upload_bytes, download_bytes, used_bytes, quota_bytes, remaining_bytes, speed_download_bps, speed_upload_bps, last_collector_contact_at, is_stale) from public.pppoe_usage_current_month where customer_id = 'synthetic-usage-a' limit 1), (select jsonb_build_array(period_start, upload_bytes, download_bytes, used_bytes, quota_bytes, remaining_bytes, speed_download_bps, speed_upload_bps, last_collector_contact_at, is_stale) from expected_usage_summary limit 1), 'Admin receives the exact customer-card quota, totals, freshness and timestamp');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select is((select count(*)::integer from public.pppoe_usage_current_month where organization_id = '20000000-0000-4000-8000-000000000101'), 0, 'Admin in another organization cannot read customer usage summaries');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000102', true);
select is((select count(*)::integer from public.pppoe_usage_current_month), 1, 'customer sees only its own usage summary');
select is((select used_bytes from public.pppoe_usage_current_month limit 1), 1150::bigint, 'customer usage total uses the same validated aggregation');
select is((select jsonb_build_array(period_start, upload_bytes, download_bytes, used_bytes, quota_bytes, remaining_bytes, speed_download_bps, speed_upload_bps, last_collector_contact_at, is_stale) from public.pppoe_usage_current_month limit 1), (select jsonb_build_array(period_start, upload_bytes, download_bytes, used_bytes, quota_bytes, remaining_bytes, speed_download_bps, speed_upload_bps, last_collector_contact_at, is_stale) from expected_usage_summary limit 1), 'customer receives the exact same quota, totals, freshness and timestamp shown to Admin');
select is((select count(*)::integer from public.pppoe_usage_customer_deltas where customer_id = 'synthetic-usage-a'), 2, 'customer can read its own customer-aggregated delta snapshots');
select is((select count(*)::integer from public.pppoe_usage_customer_deltas where customer_id = 'synthetic-usage-b'), 0, 'customer cannot read another customer usage even in the same organization');
select throws_ok(
  $$select count(*) from public.pppoe_usage_logs$$,
  '42501', null, 'customer cannot read raw PPPoE usernames or counters'
);
select throws_ok(
  $$insert into public.pppoe_usage_customer_deltas (organization_id, customer_id, snapshot_id, sampled_at, delta_bytes_in, delta_bytes_out) values ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-a', '50000000-0000-4000-8000-000000000099', now(), 1, 1)$$,
  '42501', null, 'customer cannot create or alter usage totals'
);
select is((select is_stale from public.pppoe_usage_current_month limit 1), true, 'month view marks a missed collector check-in as stale/incomplete');
reset role;

select * from finish();
rollback;
