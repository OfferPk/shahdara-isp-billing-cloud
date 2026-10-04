import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CASHFLOW_CATEGORIES,
  filterCashflowExpenses,
  getCashflowCategory,
  localDateKey,
  summarizeCashflow,
  summarizeCustomerMargin,
} from '../src/cashflow.js';

const now = new Date(2026, 9, 15, 12, 0, 0);

const receipts = [
  { organization_id: 'org-a', id: 'receipt-oct', customer_id: 'cust-a', received_on: '2026-10-05', amount_cents: 300000 },
  { organization_id: 'org-a', id: 'receipt-aug', customer_id: 'cust-a', received_on: '2026-08-08', amount_cents: 500000 },
  { organization_id: 'org-a', id: 'receipt-mar', customer_id: 'cust-a', received_on: '2026-03-02', amount_cents: 700000 },
  { organization_id: 'org-a', id: 'receipt-oct', customer_id: 'cust-a', received_on: '2026-10-05', amount_cents: 300000 },
  { organization_id: 'org-a', id: 'receipt-future', customer_id: 'cust-a', received_on: '2026-10-16', amount_cents: 900000 },
];

const expenses = [
  { organization_id: 'org-a', id: 'salary-oct', category: 'worker_salary', amount_paisa: 100000, note: 'October wages', created_at: '2026-10-10T12:00:00.000Z' },
  { organization_id: 'org-a', id: 'distribution-oct', category: 'partner_profit', amount_paisa: 50000, note: '', created_at: '2026-10-11T12:00:00.000Z' },
  { organization_id: 'org-a', id: 'fiber-aug', category: 'fiber_cable', amount_paisa: 200000, note: 'repair cable', created_at: '2026-08-07T12:00:00.000Z' },
  { organization_id: 'org-a', id: 'salary-oct', category: 'worker_salary', amount_paisa: 100000, note: 'duplicate page row', created_at: '2026-10-10T12:00:00.000Z' },
  { organization_id: 'org-a', id: 'outside', category: 'bill', amount_paisa: 900000, note: '', created_at: '2026-03-01T12:00:00.000Z' },
];

test('cashflow offers the exact requested PKR expense categories with partner profit separate', () => {
  assert.deepEqual(CASHFLOW_CATEGORIES.map(({ value }) => value), [
    'worker_salary', 'nayatel_bandwidth', 'partner_profit', 'bill', 'battery_ups',
    'fiber_cable', 'splitter', 'yellow_type', 'white_type', 'black_box_fiber_joint_box',
  ]);
  assert.equal(getCashflowCategory('partner_profit').kind, 'distribution');
  assert.equal(getCashflowCategory('nayatel_bandwidth').kind, 'operating');
  assert.equal(getCashflowCategory('not-a-category'), null);
});

test('one-month totals count actual receipt rows and separate partner distributions from operating costs', () => {
  const result = summarizeCashflow({ receipts, expenses, monthCount: 1, now });
  assert.deepEqual(result.months.map(({ month }) => month), ['2026-10']);
  assert.deepEqual(result.totals, {
    incomePaisa: 300000,
    operatingCostsPaisa: 100000,
    partnerDistributionsPaisa: 50000,
    operatingProfitPaisa: 200000,
    netCashflowPaisa: 150000,
  });
});

test('three- and six-month windows use calendar months and exclude older activity', () => {
  const three = summarizeCashflow({ receipts, expenses, monthCount: 3, now });
  const six = summarizeCashflow({ receipts, expenses, monthCount: 6, now });
  assert.deepEqual(three.months.map(({ month }) => month), ['2026-08', '2026-09', '2026-10']);
  assert.equal(three.totals.incomePaisa, 800000);
  assert.equal(three.totals.operatingCostsPaisa, 300000);
  assert.equal(three.totals.partnerDistributionsPaisa, 50000);
  assert.equal(three.totals.operatingProfitPaisa, 500000);
  assert.equal(three.totals.netCashflowPaisa, 450000);
  assert.deepEqual(six.months.map(({ month }) => month), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.equal(six.totals.incomePaisa, 800000, 'the March receipt is outside the six calendar-month window');
  assert.equal(summarizeCashflow({ receipts, expenses, monthCount: 1, now }).months[0].incomePaisa, 300000,
    'unpaid bills and allocation rows are not inputs to cash income');
  assert.throws(() => summarizeCashflow({ monthCount: 2, now }), /1-, 3-, or 6-month/);
});

test('duplicate receipt and expense rows do not double-count after page overlap or retries', () => {
  const result = summarizeCashflow({ receipts, expenses, monthCount: 3, now });
  assert.equal(result.totals.incomePaisa, 800000);
  assert.equal(result.totals.operatingCostsPaisa, 300000);
});

test('expense history search, category, and local-date filters can be combined', () => {
  assert.deepEqual(filterCashflowExpenses(expenses, { search: 'repair', category: 'fiber_cable' }).map(({ id }) => id), ['fiber-aug']);
  assert.deepEqual(filterCashflowExpenses(expenses, { category: 'worker_salary' }).map(({ id }) => id), ['salary-oct']);
  assert.deepEqual(filterCashflowExpenses(expenses, { fromDate: '2026-10-01', throughDate: '2026-10-31' }).map(({ id }) => id), ['distribution-oct', 'salary-oct']);
  assert.deepEqual(filterCashflowExpenses(expenses, { fromDate: '2026-10-31', throughDate: '2026-10-01' }), []);
  assert.equal(localDateKey('not a timestamp'), '');
});

test('customer margin is receipt-based, deduplicated, tenant/customer scoped, and not dependent on bills or allocations', () => {
  const customerReceipts = Array.from({ length: 12 }, (_, index) => ({
    organization_id: 'org-a', id: `monthly-${index}`, customer_id: 'cust-a',
    received_on: `2025-${String(index + 10 > 12 ? index + 10 - 12 : index + 10).padStart(2, '0')}-10`, amount_cents: 300000,
  }));
  const scopedReceipts = [
    ...customerReceipts,
    { ...customerReceipts[0] },
    { ...customerReceipts[0], organization_id: 'org-b', id: 'other-org', amount_cents: 999999 },
    { ...customerReceipts[0], customer_id: 'cust-b', id: 'other-customer', amount_cents: 999999 },
  ];
  const result = summarizeCustomerMargin({
    organizationId: 'org-a', customerId: 'cust-a', receipts: scopedReceipts,
    costHistory: [{ organization_id: 'org-a', customer_id: 'cust-a', id: 'cost-1', effective_on: '2025-10-01', monthly_cost_paisa: 150000, created_at: '2025-10-01T00:00:00Z' }],
    connectionDate: '2025-10-15', now,
  });
  assert.equal(result.collectedPaisa, 3600000);
  assert.equal(result.serviceStartDate, '2025-10-15');
  assert.equal(result.serviceStartSource, 'service');
  assert.equal(result.tenureMonths, 12);
  assert.equal(result.costMonths, 12);
  assert.equal(result.assignedCostPaisa, 1800000);
  assert.equal(result.estimatedContributionPaisa, 1800000);
});

test('effective-dated cost history changes only following service months and same-month corrections use the latest record', () => {
  const result = summarizeCustomerMargin({
    organizationId: 'org-a', customerId: 'cust-a', receipts: [], connectionDate: '2025-10-15', now,
    costHistory: [
      { organization_id: 'org-a', customer_id: 'cust-a', id: 'old-oct', effective_on: '2025-10-01', monthly_cost_paisa: 160000, created_at: '2025-09-01T00:00:00Z' },
      { organization_id: 'org-a', customer_id: 'cust-a', id: 'correction-oct', effective_on: '2025-10-01', monthly_cost_paisa: 150000, created_at: '2025-09-02T00:00:00Z' },
      { organization_id: 'org-a', customer_id: 'cust-a', id: 'spring-rate', effective_on: '2026-04-01', monthly_cost_paisa: 180000, created_at: '2026-03-01T00:00:00Z' },
      { organization_id: 'org-b', customer_id: 'cust-a', id: 'other-org', effective_on: '2025-10-01', monthly_cost_paisa: 1, created_at: '2025-09-01T00:00:00Z' },
    ],
  });
  assert.equal(result.tenureMonths, 12);
  assert.equal(result.costMonths, 12);
  assert.equal(result.assignedCostPaisa, 1980000, 'six months at 1500 and six months at 1800 are applied once each');
  assert.equal(result.estimatedContributionPaisa, -1980000);
});

test('unknown start or missing effective cost coverage produces N/A instead of assuming zero cost', () => {
  const noStart = summarizeCustomerMargin({
    organizationId: 'org-a', customerId: 'cust-a', receipts: [{ organization_id: 'org-a', id: 'r', customer_id: 'cust-a', received_on: '2026-10-01', amount_cents: 2000 }], now,
  });
  assert.equal(noStart.collectedPaisa, 2000);
  assert.equal(noStart.tenureMonths, null);
  assert.equal(noStart.estimatedContributionPaisa, null);

  const noCost = summarizeCustomerMargin({
    organizationId: 'org-a', customerId: 'cust-a', connectionDate: '2025-10-15', now,
    costHistory: [{ organization_id: 'org-a', customer_id: 'cust-a', effective_on: '2026-12-01', monthly_cost_paisa: 150000, created_at: '2026-11-01T00:00:00Z' }],
  });
  assert.equal(noCost.serviceMonths, 12);
  assert.equal(noCost.costMonths, 0);
  assert.equal(noCost.uncoveredMonths, 12);
  assert.equal(noCost.estimatedContributionPaisa, null);

  const futureReceipt = summarizeCustomerMargin({
    organizationId: 'org-a', customerId: 'cust-a', now,
    receipts: [{ organization_id: 'org-a', id: 'future', customer_id: 'cust-a', received_on: '2026-10-16', amount_cents: 999999 }],
  });
  assert.equal(futureReceipt.collectedPaisa, 0, 'a future-dated receipt is not treated as cash collected to date');
});

test('account creation is a clearly identifiable fallback start date; current incomplete service month is excluded from monthly cost estimate', () => {
  const result = summarizeCustomerMargin({
    customerId: 'cust-a', createdAt: '2026-09-15T20:00:00.000Z', now: new Date(2026, 9, 14, 12),
    receipts: [], costHistory: [{ customer_id: 'cust-a', id: 'cost', effective_on: '2026-09-01', monthly_cost_paisa: 150000, created_at: '2026-09-01T00:00:00Z' }],
  });
  assert.equal(result.serviceStartSource, 'created');
  assert.equal(result.serviceStartDate, '2026-09-15');
  assert.equal(result.tenureMonths, 0);
  assert.equal(result.costMonths, 0);
  assert.equal(result.estimatedContributionPaisa, null);
});
