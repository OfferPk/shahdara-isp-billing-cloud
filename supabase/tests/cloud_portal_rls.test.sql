-- Synthetic-only database tests. Run with `supabase test db` against a local,
-- disposable Supabase stack; never run these fixtures against production.
begin;
select plan(26);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'admin@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'customer@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'other@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.organizations (id, name) values
  ('20000000-0000-4000-8000-000000000001', 'Synthetic ISP A'),
  ('20000000-0000-4000-8000-000000000002', 'Synthetic ISP B');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'admin'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', 'admin');
insert into public.customers (organization_id, id, customer_number, name, plan_name, monthly_fee_cents, service_status) values
  ('20000000-0000-4000-8000-000000000001', 'synthetic-customer-a', 1, 'Synthetic Customer A', 'Starter', 10000, 'active'),
  ('20000000-0000-4000-8000-000000000001', 'synthetic-customer-b', 2, 'Synthetic Customer B', 'Starter', 10000, 'active'),
  ('20000000-0000-4000-8000-000000000002', 'synthetic-customer-c', 1, 'Synthetic Customer C', 'Starter', 10000, 'active');
select is((select count(*)::integer from public.price_history where customer_id = 'synthetic-customer-a'), 1,
  'new customer price history is recorded after the customer row exists');
insert into public.customer_portal_accounts (organization_id, customer_id, user_id) values
  ('20000000-0000-4000-8000-000000000001', 'synthetic-customer-a', '10000000-0000-4000-8000-000000000002');
insert into public.bills (organization_id, id, customer_id, period, amount_due_cents, due_date) values
  ('20000000-0000-4000-8000-000000000001', 'synthetic-bill-jan', 'synthetic-customer-a', '2026-01-01', 10000, '2026-01-05'),
  ('20000000-0000-4000-8000-000000000001', 'synthetic-bill-feb', 'synthetic-customer-a', '2026-02-01', 10000, '2026-02-05');
select is((select issued_on from public.bills where id = 'synthetic-bill-jan'), null::date,
  'existing bill issue dates remain null rather than inferred from created_at');
select throws_ok(
  $$select public.create_monthly_bill('20000000-0000-4000-8000-000000000001', 'synthetic-customer-a', '2026-03-01', 'unauthenticated-bill', '2026-03-02', '2026-03-10')$$,
  '42501', null, 'bill creation requires an authenticated same-organization Admin'
);

select ok(not has_table_privilege('anon', 'public.customers', 'select'), 'anon has no customer select grant');
select ok(not has_table_privilege('authenticated', 'public.receipts', 'insert,update,delete'), 'browser clients have no direct receipt write grants');
select ok(not has_table_privilege('authenticated', 'public.bills', 'delete'), 'browser clients cannot delete bills and orphan allocations');

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
select is((select count(*)::integer from public.customers), 1, 'customer sees only the linked customer profile');
select is((select count(*)::integer from public.bills), 2, 'customer sees only the linked bills');
select is((select count(*)::integer from public.organizations), 0, 'customer cannot read admin organization rows');
select is((select count(*)::integer from public.expenses), 0, 'customer cannot read expenses');
select throws_ok(
  $$insert into public.receipts (organization_id, id, customer_id, origin_bill_id, received_on, amount_cents, method)
    values ('20000000-0000-4000-8000-000000000001', 'forged-receipt', 'synthetic-customer-a', 'synthetic-bill-jan', '2026-01-03', 10000, 'cash')$$,
  '42501', null, 'customer cannot directly insert a cash receipt'
);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select is(current_user::text, 'authenticated', 'administrator RLS checks execute as authenticated');
select is((select count(*)::integer from public.customers where organization_id = '20000000-0000-4000-8000-000000000001'), 2, 'admin sees customers in the authorized organization');
select is((select count(*)::integer from public.customers where organization_id = '20000000-0000-4000-8000-000000000002'), 0, 'admin cannot cross into another organization');
select is(public.create_monthly_bill('20000000-0000-4000-8000-000000000001', 'synthetic-customer-a', '2026-03-01', 'synthetic-bill-mar', '2026-03-02', '2026-03-10'), 'synthetic-bill-mar'::text,
  'same-organization Admin creates a bill with explicit issue and due dates');
select is(public.create_monthly_bill('20000000-0000-4000-8000-000000000001', 'synthetic-customer-a', '2026-03-01', 'ignored-retry-id', '2026-03-04', '2026-03-30'), 'synthetic-bill-mar'::text,
  'repeating a monthly bill request returns the existing bill ID');
select is((select jsonb_build_array(amount_due_cents, issued_on, due_date) from public.bills where id = 'synthetic-bill-mar'),
  jsonb_build_array(10000, '2026-03-02'::date, '2026-03-10'::date),
  'existing monthly snapshots remain unchanged when replayed with different dates');
select public.correct_monthly_bill('20000000-0000-4000-8000-000000000001', 'synthetic-bill-mar', 12000, '2026-03-03', '2026-03-31');
select is((select jsonb_build_array(amount_due_cents, issued_on, due_date) from public.bills where id = 'synthetic-bill-mar'),
  jsonb_build_array(12000, '2026-03-03'::date, '2026-03-31'::date),
  'same-organization Admin correction writes amount and both dates atomically');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
select throws_ok(
  $$select public.correct_monthly_bill('20000000-0000-4000-8000-000000000001', 'synthetic-bill-mar', 9000, '2026-03-04', '2026-03-20')$$,
  '42501', null, 'admin cannot correct a bill across organizations'
);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
select throws_ok(
  $$select public.correct_monthly_bill('20000000-0000-4000-8000-000000000001', 'synthetic-bill-mar', 9000, '2026-03-04', '2026-03-20')$$,
  '42501', null, 'customer cannot correct bill amounts or dates'
);
reset role;
select is((select jsonb_build_array(amount_due_cents, issued_on, due_date) from public.bills where id = 'synthetic-bill-mar'),
  jsonb_build_array(12000, '2026-03-03'::date, '2026-03-31'::date),
  'rejected cross-organization and customer corrections leave the bill unchanged');
update public.customers set monthly_fee_cents = 12500, plan_name = 'Plus'
where organization_id = '20000000-0000-4000-8000-000000000001' and id = 'synthetic-customer-a';
select is((select monthly_fee_cents from public.price_history
  where customer_id = 'synthetic-customer-a' and effective_on = current_date), 12500::bigint,
  'subsequent price updates are preserved in price history');
select is((select plan_name from public.price_history
  where customer_id = 'synthetic-customer-a' and effective_on = current_date), 'Plus'::text,
  'subsequent plan updates are preserved in price history');

select public.record_cash_receipt(
  '20000000-0000-4000-8000-000000000001', 'synthetic-customer-a',
  'synthetic-bill-jan', 'synthetic-receipt-1', '2026-01-03', 15000, 'cash'
);
select public.record_cash_receipt(
  '20000000-0000-4000-8000-000000000001', 'synthetic-customer-a',
  'synthetic-bill-jan', 'synthetic-receipt-1', '2026-01-03', 15000, 'cash'
);
select is((select count(*)::integer from public.receipts where id = 'synthetic-receipt-1'), 1, 'replaying the same stable receipt ID does not double-count cash');
select is((select amount_applied_cents from public.bill_summaries where bill_id = 'synthetic-bill-feb'), 5000::bigint, 'unused receipt amount becomes non-cash credit on the next bill');
select is((select sum(amount_cents)::bigint from public.receipts where customer_id = 'synthetic-customer-a'), 15000::bigint, 'cash total remains the original receipt amount, not cash plus credit');

select * from finish();
rollback;
