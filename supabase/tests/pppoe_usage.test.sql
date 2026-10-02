-- Synthetic-only PPPoE transaction/RLS integration tests.
-- Execute only in the disposable local/CI harness; never against staging or production.
begin;
select no_plan();

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

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.save_pppoe_usage_mapping(
  '10000000-0000-4000-8000-000000000101', '20000000-0000-4000-8000-000000000101',
  'usage-site-a', 'Synthetic site', 'synthetic-pppoe-a', 'synthetic-usage-a',
  100000000000, 5000000, 1000000
);
-- This account is intentionally mapped after the current month has begun.
select public.save_pppoe_usage_mapping(
  '10000000-0000-4000-8000-000000000101', '20000000-0000-4000-8000-000000000101',
  'usage-site-a', 'Synthetic site', 'synthetic-pppoe-b', 'synthetic-usage-a',
  50000000000, 2000000, 512000
);
reset role;

insert into public.pppoe_usage_customer_months (
  organization_id, customer_id, period_start, quota_bytes, speed_download_bps,
  speed_upload_bps, source_count, fresh_source_count, last_collector_contact_at
) values (
  '20000000-0000-4000-8000-000000000101', 'synthetic-usage-b',
  date_trunc('month', now() at time zone 'Asia/Karachi')::date,
  100000000000, 5000000, 1000000, 1, 1, now()
);
insert into public.pppoe_usage_customer_sources (organization_id, customer_id, period_start, site_id, last_contact_at)
values ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-b',
  date_trunc('month', now() at time zone 'Asia/Karachi')::date, 'usage-site-a', now());

-- Synthetic boundary samples: exact start and final instant are included; exact end is excluded.
insert into public.pppoe_usage_customer_deltas (
  organization_id, customer_id, snapshot_id, sampled_at, delta_bytes_in, delta_bytes_out
) values
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-b', '50000000-0000-4000-8000-000000000001', now() - interval '2 hours', 10, 20),
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-b', '50000000-0000-4000-8000-000000000002', now() - interval '1 microsecond', 4, 5),
  ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-b', '50000000-0000-4000-8000-000000000003', now(), 1000, 1000);

select ok(not has_table_privilege('anon', 'public.pppoe_usage_logs', 'select'), 'anon cannot read raw PPPoE snapshots');
select ok(not has_table_privilege('authenticated', 'public.pppoe_usage_logs', 'select'), 'browser customers cannot read raw PPPoE identities or counters');
select ok(not has_table_privilege('authenticated', 'public.pppoe_usage_account_months', 'select'), 'browser clients cannot read per-account plan/username rows');
select ok(not has_table_privilege('authenticated', 'public.pppoe_usage_admin_account_month_current', 'select'), 'browser clients cannot read the Admin-only account report');
select ok(not has_table_privilege('authenticated', 'public.pppoe_usage_customer_deltas', 'insert,update,delete'), 'browser customers cannot write usage deltas');
select ok(not has_table_privilege('authenticated', 'public.pppoe_usage_customer_months', 'insert,update,delete'), 'browser customers cannot write monthly usage or plans');
select ok(not has_table_privilege('anon', 'public.pppoe_usage_current_month', 'select'), 'anon cannot read customer usage views');
select ok(has_function_privilege('service_role', 'public.process_pppoe_usage_snapshot(text,uuid,uuid,timestamptz,text,jsonb)', 'execute'), 'collector RPC is executable by the server role');
select is((select quota_bytes from public.pppoe_usage_customer_months where customer_id = 'synthetic-usage-a'), 150000000000::bigint, 'customer plan quota aggregates independent account quotas');
select is((select speed_download_bps from public.pppoe_usage_customer_months where customer_id = 'synthetic-usage-a'), 7000000::bigint, 'customer download plan speed aggregates account speeds');
select is((select speed_upload_bps from public.pppoe_usage_customer_months where customer_id = 'synthetic-usage-a'), 1512000::bigint, 'customer upload plan speed aggregates account speeds');
select is((select count(*)::integer from public.pppoe_usage_account_months where customer_id = 'synthetic-usage-a'), 2, 'each mapped PPPoE account receives its own monthly plan snapshot');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.process_pppoe_usage_snapshot(
    'usage-site-a', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
    now() - interval '5 minutes', repeat('a', 64),
    jsonb_build_object('snapshot_id', '30000000-0000-4000-8000-000000000001', 'sampled_at', (now() - interval '5 minutes')::text,
      'quarantined_batch_count', 0,
      'sessions', jsonb_build_array(
        jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'preexisting-session-a', 'session_key', '50000000-0000-4000-8000-000000000101', 'uptime_seconds', 100000, 'bytes_in', '2000000000', 'bytes_out', '3000000000'),
        jsonb_build_object('username', 'synthetic-pppoe-b', 'session_id', 'preexisting-new-mapping-session', 'session_key', '50000000-0000-4000-8000-000000000102', 'uptime_seconds', 100000, 'bytes_in', '4000000000', 'bytes_out', '5000000000'),
        jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'reset-session-c', 'session_key', '50000000-0000-4000-8000-000000000103', 'uptime_seconds', 100, 'bytes_in', '300', 'bytes_out', '400')
      )
    )
  )->>'accepted')::boolean, true, 'first signed batch accepts synthetic pre-existing sessions and a mid-month new mapping');
select is((select delta_bytes_in from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000001' and session_id = 'preexisting-session-a'), 0::bigint, 'first-seen pre-existing session cumulative upload is a zero-delta baseline');
select is((select delta_bytes_out from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000001' and session_id = 'preexisting-session-a'), 0::bigint, 'first-seen pre-existing session cumulative download is not charged');
select is((select bytes_in from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000001' and session_id = 'preexisting-session-a'), 2000000000::bigint, 'raw cumulative counter remains server-only for audit');
select is((select delta_bytes_in from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000001' and session_id = 'preexisting-new-mapping-session'), 0::bigint, 'a new mapping first observed mid-month has zero usage before its baseline');
select ok((select coverage_incomplete and coverage_since is not null from public.pppoe_usage_account_months where pppoe_username = 'synthetic-pppoe-b'), 'new mid-month mapping exposes its coverage start and incomplete status');
select is(
  (public.process_pppoe_usage_snapshot(
    'usage-site-a', '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
    now() - interval '5 minutes', repeat('a', 64),
    jsonb_build_object('snapshot_id', '30000000-0000-4000-8000-000000000001', 'sampled_at', (now() - interval '5 minutes')::text,
      'quarantined_batch_count', 0,
      'sessions', jsonb_build_array(
        jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'preexisting-session-a', 'session_key', '50000000-0000-4000-8000-000000000101', 'uptime_seconds', 100000, 'bytes_in', '2000000000', 'bytes_out', '3000000000'),
        jsonb_build_object('username', 'synthetic-pppoe-b', 'session_id', 'preexisting-new-mapping-session', 'session_key', '50000000-0000-4000-8000-000000000102', 'uptime_seconds', 100000, 'bytes_in', '4000000000', 'bytes_out', '5000000000'),
        jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'reset-session-c', 'session_key', '50000000-0000-4000-8000-000000000103', 'uptime_seconds', 100, 'bytes_in', '300', 'bytes_out', '400')
      )
    )
  )->>'duplicate')::boolean, true, 'same snapshot replay is idempotent');
select is((select count(*)::integer from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000001'), 3, 'duplicate batch does not add raw session snapshots');
select throws_ok(
  $$select public.process_pppoe_usage_snapshot('usage-site-a', '30000000-0000-4000-8000-000000000004', '40000000-0000-4000-8000-000000000001', now() - interval '3 minutes', repeat('b', 64), jsonb_build_object('snapshot_id', '30000000-0000-4000-8000-000000000004', 'sampled_at', (now() - interval '3 minutes')::text, 'sessions', '[]'::jsonb))$$,
  '23505', null, 'a replayed nonce cannot authenticate a different snapshot'
);
select is(
  (public.process_pppoe_usage_snapshot(
    'usage-site-a', '30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002',
    now() - interval '4 minutes', repeat('c', 64),
    jsonb_build_object('snapshot_id', '30000000-0000-4000-8000-000000000002', 'sampled_at', (now() - interval '4 minutes')::text,
      'quarantined_batch_count', 0,
      'sessions', jsonb_build_array(
        jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'preexisting-session-a', 'session_key', '50000000-0000-4000-8000-000000000101', 'uptime_seconds', 100060, 'bytes_in', '2000000050', 'bytes_out', '3000000050'),
        jsonb_build_object('username', 'synthetic-pppoe-b', 'session_id', 'preexisting-new-mapping-session', 'session_key', '50000000-0000-4000-8000-000000000102', 'uptime_seconds', 100060, 'bytes_in', '4000000100', 'bytes_out', '5000000200'),
        jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'reset-session-c', 'session_key', '50000000-0000-4000-8000-000000000103', 'uptime_seconds', 10, 'bytes_in', '20', 'bytes_out', '30')
      )
    )
  )->>'accepted')::boolean, true, 'later batch accepts monotonic increments and a counter-reset segment');
select is((select used_bytes from public.pppoe_usage_current_month where customer_id = 'synthetic-usage-a'), 450::bigint, 'monthly total contains only post-baseline increments and reset-segment deltas');
select is((select upload_bytes from public.pppoe_usage_current_month where customer_id = 'synthetic-usage-a'), 170::bigint, 'customer upload aggregates all account increments without old cumulative counters');
select is((select download_bytes from public.pppoe_usage_current_month where customer_id = 'synthetic-usage-a'), 280::bigint, 'customer download aggregates all account increments without old cumulative counters');
select is((select used_bytes from public.pppoe_usage_admin_account_month_current where pppoe_username = 'synthetic-pppoe-a'), 150::bigint, 'Admin account report keeps account A usage separate');
select is((select used_bytes from public.pppoe_usage_admin_account_month_current where pppoe_username = 'synthetic-pppoe-b'), 300::bigint, 'Admin account report keeps account B usage separate');
select is((select quota_bytes from public.pppoe_usage_account_months where pppoe_username = 'synthetic-pppoe-b'), 50000000000::bigint, 'account B retains its own quota rather than overwriting account A');
select is((select delta_bytes_in from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000002' and session_id = 'reset-session-c'), 20::bigint, 'counter reset segment contributes its new nonnegative upload baseline');
select is((select delta_bytes_out from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000002' and session_id = 'reset-session-c'), 30::bigint, 'counter reset segment contributes its new nonnegative download baseline');
select is(
  (public.process_pppoe_usage_snapshot(
    'usage-site-a', '30000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000003',
    now() - interval '6 minutes', repeat('d', 64),
    jsonb_build_object('snapshot_id', '30000000-0000-4000-8000-000000000003', 'sampled_at', (now() - interval '6 minutes')::text,
      'quarantined_batch_count', 0,
      'sessions', jsonb_build_array(jsonb_build_object('username', 'synthetic-pppoe-a', 'session_id', 'preexisting-session-a', 'session_key', '50000000-0000-4000-8000-000000000101', 'uptime_seconds', 100060, 'bytes_in', '2000000180', 'bytes_out', '3000000280'))
    )
  )->>'accepted')::boolean, true, 'out-of-order observation is retained without changing totals');
select is((select delta_bytes_in from public.pppoe_usage_logs where snapshot_id = '30000000-0000-4000-8000-000000000003' and session_id = 'preexisting-session-a'), 0::bigint, 'out-of-order snapshot contributes no customer usage delta');
select is((select count(*)::integer from public.pppoe_usage_customer_deltas where customer_id = 'synthetic-usage-a'), 1, 'only the monotonic post-baseline snapshot creates a customer delta');

-- A permanently rejected client batch is reported on the next accepted heartbeat.
select is(
  (public.process_pppoe_usage_snapshot(
    'usage-site-a', '30000000-0000-4000-8000-000000000005', '40000000-0000-4000-8000-000000000005',
    now(), repeat('e', 64),
    jsonb_build_object('snapshot_id', '30000000-0000-4000-8000-000000000005', 'sampled_at', now()::text,
      'quarantined_batch_count', 1, 'sessions', '[]'::jsonb)
  )->>'accepted')::boolean, true, 'next valid heartbeat reports unresolved local quarantine');
select is((select quarantined_batch_count from public.pppoe_usage_sites where site_id = 'usage-site-a'), 1, 'server retains prominent collector quarantine count');
select is((select quarantined_source_count from public.pppoe_usage_customer_months where customer_id = 'synthetic-usage-a'), 1, 'customer summary records a quarantined source');
select is((select is_stale from public.pppoe_usage_current_month where customer_id = 'synthetic-usage-a'), true, 'quarantine forces stale/incomplete customer and Admin status');
reset role;

select is((select used_bytes from public.pppoe_usage_rollup(now() - interval '2 hours', now()) where customer_id = 'synthetic-usage-b'), 39::bigint, 'half-open rolling window includes exact start and excludes exact end');
select ok(not exists (
  select 1 from public.pppoe_usage_current_month m
  where m.customer_id = 'synthetic-usage-a' and to_jsonb(m) ? 'pppoe_username'
), 'customer summary rows do not contain PPPoE usernames');

-- Capture exactly the customer-facing summary before checking Admin parity.
update public.pppoe_usage_customer_months
set fresh_source_count = 0, last_collector_contact_at = now() - interval '1 hour'
where customer_id = 'synthetic-usage-a';
create temp table expected_usage_summary as
select organization_id, customer_id, period_start, upload_bytes, download_bytes, used_bytes,
       quota_bytes, remaining_bytes, speed_download_bps, speed_upload_bps,
       last_collector_contact_at, is_stale, coverage_since, coverage_incomplete, quarantined_source_count
from public.pppoe_usage_current_month
where customer_id = 'synthetic-usage-a';
grant select on expected_usage_summary to authenticated;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is((select count(*)::integer from public.pppoe_usage_current_month where organization_id = '20000000-0000-4000-8000-000000000101'), 2, 'same-organization Admin sees all customer summaries');
select is((select used_bytes from public.pppoe_usage_current_month where customer_id = 'synthetic-usage-a'), 450::bigint, 'Admin sees the same validated usage total as the customer');
select is((select jsonb_build_array(period_start, upload_bytes, download_bytes, used_bytes, quota_bytes, remaining_bytes, speed_download_bps, speed_upload_bps, last_collector_contact_at, is_stale, coverage_since, coverage_incomplete, quarantined_source_count) from public.pppoe_usage_current_month where customer_id = 'synthetic-usage-a'), (select jsonb_build_array(period_start, upload_bytes, download_bytes, used_bytes, quota_bytes, remaining_bytes, speed_download_bps, speed_upload_bps, last_collector_contact_at, is_stale, coverage_since, coverage_incomplete, quarantined_source_count) from expected_usage_summary), 'Admin receives exact customer quota, aggregate plan, coverage and quarantine status');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is((select count(*)::integer from public.pppoe_usage_current_month where organization_id = '20000000-0000-4000-8000-000000000101'), 0, 'foreign-organization Admin cannot read customer usage');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000102', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is((select count(*)::integer from public.pppoe_usage_current_month), 1, 'customer sees only its own username-free usage summary');
select is((select used_bytes from public.pppoe_usage_current_month limit 1), 450::bigint, 'customer usage total uses the same validated aggregation');
select is((select jsonb_build_array(period_start, upload_bytes, download_bytes, used_bytes, quota_bytes, remaining_bytes, speed_download_bps, speed_upload_bps, last_collector_contact_at, is_stale, coverage_since, coverage_incomplete, quarantined_source_count) from public.pppoe_usage_current_month limit 1), (select jsonb_build_array(period_start, upload_bytes, download_bytes, used_bytes, quota_bytes, remaining_bytes, speed_download_bps, speed_upload_bps, last_collector_contact_at, is_stale, coverage_since, coverage_incomplete, quarantined_source_count) from expected_usage_summary), 'customer receives the exact same quota, aggregate plan, coverage and quarantine status as Admin');
select is((select count(*)::integer from public.pppoe_usage_customer_deltas where customer_id = 'synthetic-usage-a'), 1, 'customer can read only its own customer-aggregated deltas');
select is((select count(*)::integer from public.pppoe_usage_customer_deltas where customer_id = 'synthetic-usage-b'), 0, 'customer cannot read another customer usage in the same organization');
select throws_ok($$select count(*) from public.pppoe_usage_logs$$, '42501', null, 'customer cannot read raw PPPoE usernames or counters');
select throws_ok($$select count(*) from public.pppoe_usage_admin_account_month_current$$, '42501', null, 'customer cannot read Admin-only per-account username breakdown');
select throws_ok(
  $$insert into public.pppoe_usage_customer_deltas (organization_id, customer_id, snapshot_id, sampled_at, delta_bytes_in, delta_bytes_out) values ('20000000-0000-4000-8000-000000000101', 'synthetic-usage-a', '50000000-0000-4000-8000-000000000099', now(), 1, 1)$$,
  '42501', null, 'customer cannot create or alter usage totals'
);
select is((select is_stale from public.pppoe_usage_current_month limit 1), true, 'customer sees stale status when a source has unresolved quarantine');
reset role;

select * from finish();
rollback;
