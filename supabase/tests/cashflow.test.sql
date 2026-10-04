-- Synthetic-only tests for the additive cashflow migration; never run against staging or production.
begin;
select plan(42);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('11000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cash-owner@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('11000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'cash-admin@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('11000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'cash-other-admin@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('11000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'cash-customer@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.organizations (id, name) values
  ('21000000-0000-4000-8000-000000000001', 'Synthetic Cashflow ISP A'),
  ('21000000-0000-4000-8000-000000000002', 'Synthetic Cashflow ISP B');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000001', 'owner'),
  ('21000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002', 'admin'),
  ('21000000-0000-4000-8000-000000000002', '11000000-0000-4000-8000-000000000003', 'admin');
insert into public.customers (organization_id, id, customer_number, name, plan_name, service_status)
values
  ('21000000-0000-4000-8000-000000000001', 'cash-customer-a', 1, 'Cashflow Customer A', 'Starter', 'active'),
  ('21000000-0000-4000-8000-000000000002', 'cash-customer-b', 1, 'Cashflow Customer B', 'Starter', 'active');
insert into public.customer_portal_accounts (organization_id, customer_id, user_id)
values ('21000000-0000-4000-8000-000000000001', 'cash-customer-a', '11000000-0000-4000-8000-000000000004');

select ok(not has_table_privilege('anon', 'public.cashflow_expenses', 'select'), 'anon cannot read cash expenses');
select ok(not has_table_privilege('authenticated', 'public.cashflow_expenses', 'insert,update,delete'), 'browser clients cannot directly write cash expenses');
select ok(not has_table_privilege('authenticated', 'public.customer_service_cost_history', 'insert,update,delete'), 'browser clients cannot directly write customer cost history');

set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000001', true);
select is(public.record_cashflow_expense(
  '21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001',
  'worker_salary', 125000, 'synthetic worker salary'
), '31000000-0000-4000-8000-000000000001'::uuid, 'same-organization Owner records an exact PKR expense');
select is(public.record_cashflow_expense(
  '21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001',
  'worker_salary', 125000, 'synthetic worker salary'
), '31000000-0000-4000-8000-000000000001'::uuid, 'repeating an identical expense request is idempotent');
select is((select count(*)::integer from public.cashflow_expenses where id = '31000000-0000-4000-8000-000000000001'), 1, 'idempotent retry does not double-count the expense');
select is((select jsonb_build_array(category, amount_paisa, note, created_by) from public.cashflow_expenses where id = '31000000-0000-4000-8000-000000000001'),
  jsonb_build_array('worker_salary'::text, 125000::bigint, 'synthetic worker salary'::text, '11000000-0000-4000-8000-000000000001'::uuid), 'stored category, exact paisa, note, and actor are retained');
select ok((select created_at >= transaction_timestamp() from public.cashflow_expenses where id = '31000000-0000-4000-8000-000000000001'), 'cash expense timestamp is captured by the database server');
select is(public.record_cashflow_expense(
  '21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000002',
  'partner_profit', 50000, null
), '31000000-0000-4000-8000-000000000002'::uuid, 'partner profit is recorded as a separate distribution category');
select is((select count(*)::integer from public.cashflow_expenses where category = 'partner_profit'), 1, 'partner distribution remains separately classifiable');
select throws_ok(
  $$select public.record_cashflow_expense('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000003', 'unapproved', 10, null)$$,
  '23514', null, 'unsupported cashflow categories are rejected');
select throws_ok(
  $$select public.record_cashflow_expense('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000004', 'bill', 0, null)$$,
  '23514', null, 'zero cash expenses are rejected');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000003', true);
select throws_ok(
  $$select public.record_cashflow_expense('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000005', 'bill', 100, null)$$,
  '42501', null, 'an Admin from another organization cannot write cash expenses');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000004', true);
select throws_ok(
  $$select public.record_cashflow_expense('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000006', 'bill', 100, null)$$,
  '42501', null, 'a customer cannot write cash expenses');
select throws_ok(
  $$insert into public.cashflow_expenses (organization_id, id, category, amount_paisa, created_by) values ('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000007', 'bill', 100, '11000000-0000-4000-8000-000000000004')$$,
  '42501', null, 'a customer cannot directly insert a cash expense');
reset role;
select ok((select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.cashflow_expenses'::regclass), 'cash expense table has RLS enabled');
select ok((select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.customer_service_cost_history'::regclass), 'customer cost history has RLS enabled');
select is((select pg_catalog.format_type(a.atttypid, a.atttypmod) from pg_catalog.pg_attribute a where a.attrelid = 'public.cashflow_expenses'::regclass and a.attname = 'created_at'), 'timestamp with time zone', 'cash expense timestamps are stored as timestamptz instants');
select is((select pg_catalog.format_type(a.atttypid, a.atttypmod) from pg_catalog.pg_attribute a where a.attrelid = 'public.customer_service_cost_history'::regclass and a.attname = 'created_at'), 'timestamp with time zone', 'customer cost timestamps are stored as timestamptz instants');

set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000002', true);
select is((select count(*)::integer from public.cashflow_expenses), 2, 'same-organization Admin reads the two cash entries');
select is((select count(*)::integer from public.cashflow_expenses where organization_id = '21000000-0000-4000-8000-000000000002'), 0, 'Admin cannot read another organization cash entries');
select is(public.record_customer_service_cost(
  '21000000-0000-4000-8000-000000000001', 'cash-customer-a', '41000000-0000-4000-8000-000000000001',
  '2025-10-01', 150000, 'synthetic assigned service cost'
), '41000000-0000-4000-8000-000000000001'::uuid, 'same-organization Admin records an effective-dated service cost');
select is(public.record_customer_service_cost(
  '21000000-0000-4000-8000-000000000001', 'cash-customer-a', '41000000-0000-4000-8000-000000000001',
  '2025-10-01', 150000, 'synthetic assigned service cost'
), '41000000-0000-4000-8000-000000000001'::uuid, 'repeating the same cost request is idempotent');
select is((select count(*)::integer from public.customer_service_cost_history where id = '41000000-0000-4000-8000-000000000001'), 1, 'idempotent retry does not double-count a service cost');
select is((select jsonb_build_array(effective_on, monthly_cost_paisa, created_by) from public.customer_service_cost_history where id = '41000000-0000-4000-8000-000000000001'),
  jsonb_build_array('2025-10-01'::date, 150000::bigint, '11000000-0000-4000-8000-000000000002'::uuid), 'effective month, exact paisa, and Admin actor are retained');
select ok((select created_at >= transaction_timestamp() from public.customer_service_cost_history where id = '41000000-0000-4000-8000-000000000001'), 'service cost record time is captured by the database server');
select throws_ok(
  $$select public.record_customer_service_cost('21000000-0000-4000-8000-000000000001', 'cash-customer-a', '41000000-0000-4000-8000-000000000002', '2025-10-02', 150000, null)$$,
  '23514', null, 'service cost effective dates must be the first day of a month');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000003', true);
select throws_ok(
  $$select public.record_customer_service_cost('21000000-0000-4000-8000-000000000001', 'cash-customer-a', '41000000-0000-4000-8000-000000000003', '2025-10-01', 150000, null)$$,
  '42501', null, 'an Admin from another organization cannot assign a customer cost');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000004', true);
select throws_ok(
  $$select public.record_customer_service_cost('21000000-0000-4000-8000-000000000001', 'cash-customer-a', '41000000-0000-4000-8000-000000000004', '2025-10-01', 150000, null)$$,
  '42501', null, 'a customer cannot assign service costs');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000002', true);
select is(public.record_customer_service_cost(
  '21000000-0000-4000-8000-000000000001', 'cash-customer-a', '41000000-0000-4000-8000-000000000005',
  '2025-10-01', 160000, 'synthetic audited same-month correction'
), '41000000-0000-4000-8000-000000000005'::uuid, 'a cost correction is a new immutable history entry');
select is((select count(*)::integer from public.customer_service_cost_history where customer_id = 'cash-customer-a' and effective_on = '2025-10-01'), 2, 'same-month cost corrections preserve both audit entries');
select is((select monthly_cost_paisa from public.customer_service_cost_history where customer_id = 'cash-customer-a' and effective_on = '2025-10-01' order by created_at desc, id desc limit 1), 160000::bigint, 'latest recorded entry determines the effective monthly cost');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000003', true);
select is((select count(*)::integer from public.cashflow_expenses), 0, 'other organization Admin cannot read cash expenses');
select is((select count(*)::integer from public.customer_service_cost_history), 0, 'other organization Admin cannot read customer costs');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11000000-0000-4000-8000-000000000004', true);
select is((select count(*)::integer from public.cashflow_expenses), 0, 'customer account cannot read cash expenses');
select is((select count(*)::integer from public.customer_service_cost_history), 0, 'customer account cannot read customer cost history');
select throws_ok(
  $$insert into public.customer_service_cost_history (organization_id, customer_id, id, effective_on, monthly_cost_paisa, created_by) values ('21000000-0000-4000-8000-000000000001', 'cash-customer-a', '41000000-0000-4000-8000-000000000006', '2025-10-01', 150000, '11000000-0000-4000-8000-000000000004')$$,
  '42501', null, 'customer cannot directly insert customer service cost history');
reset role;
select throws_ok(
  $$update public.cashflow_expenses set note = 'changed' where id = '31000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'cash expense rows reject mutation even for a table owner');
select throws_ok(
  $$delete from public.cashflow_expenses where id = '31000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'cash expense rows reject deletion even for a table owner');
select throws_ok(
  $$update public.customer_service_cost_history set monthly_cost_paisa = 1 where id = '41000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'customer cost history rejects mutation even for a table owner');
select throws_ok(
  $$delete from public.customer_service_cost_history where id = '41000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'customer cost history rejects deletion even for a table owner');
select is((select count(*)::integer from public.cashflow_expenses), 2, 'rejected mutations leave the financial records intact');

select * from finish();
rollback;
