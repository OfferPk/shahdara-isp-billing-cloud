import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdminBillRows } from '../src/admin-bills.js';
import {
  buildBillingBreakdown,
  buildCollectionRate,
  buildCustomerGrowthSeries,
  buildRecentActivity,
  buildRecentlyPaidCustomers,
  buildTopCollectors,
  buildTopDebtors,
  renderDashboardAnalytics,
  summarizeDashboardCustomers,
} from '../src/dashboard-analytics.js';
import { buildDashboardTrendSeries } from '../src/dashboard-trend.js';
import { calculateDashboard } from '../src/ledger.js';
import { translateUi } from '../src/language.js';
import './helpers/load-roman-urdu.js';

const organizationId = 'synthetic-org';
const customers = [
  { id: 'c1', organization_id: organizationId, customer_number: 1, name: 'Aisha <script>bad</script>', plan_name: 'Fiber 30', service_status: 'active', archived: false, created_at: '2026-10-02T08:00:00Z' },
  { id: 'c2', organization_id: organizationId, customer_number: 2, name: 'Bilal', plan_name: 'Fiber 15', service_status: 'offline', archived: false, created_at: '2026-09-03T08:00:00Z' },
  { id: 'c3', organization_id: organizationId, customer_number: 3, name: 'Sara', plan_name: '', service_status: 'not-set', archived: false, created_at: '2026-10-04T08:00:00Z' },
  { id: 'c4', organization_id: organizationId, customer_number: 4, name: 'Archived', plan_name: '', service_status: 'active', archived: true, created_at: '2026-10-05T08:00:00Z' },
];
const bills = [
  { organization_id: organizationId, id: 'b-sep', customer_id: 'c1', period: '2026-09-01', amount_due_cents: 8000, issued_on: null, due_date: '2026-09-20', plan_snapshot: 'Fiber 30', created_at: '2026-09-01T09:00:00Z' },
  { organization_id: organizationId, id: 'b-oct-1', customer_id: 'c1', period: '2026-10-01', amount_due_cents: 10000, issued_on: null, due_date: '2026-10-20', plan_snapshot: 'Fiber 30', created_at: '2026-10-01T09:00:00Z' },
  { organization_id: organizationId, id: 'b-oct-2', customer_id: 'c2', period: '2026-10-01', amount_due_cents: 5000, issued_on: null, due_date: '2026-10-10', plan_snapshot: 'Fiber 15', created_at: '2026-10-08T09:00:00Z' },
];
const receipts = [
  { organization_id: organizationId, id: 'r-oct', customer_id: 'c1', origin_bill_id: 'b-oct-1', received_on: '2026-10-03', amount_cents: 3000, method: 'Cash', created_at: '2026-10-03T10:00:00Z' },
  { organization_id: organizationId, id: 'r-sep', customer_id: 'c1', origin_bill_id: 'b-sep', received_on: '2026-09-15', amount_cents: 2000, method: 'Cash', created_at: '2026-09-15T10:00:00Z' },
];
const allocations = [
  { organization_id: organizationId, receipt_id: 'r-oct', bill_id: 'b-oct-1', customer_id: 'c1', amount_cents: 3000, allocation_kind: 'same-month' },
  { organization_id: organizationId, receipt_id: 'r-sep', bill_id: 'b-oct-2', customer_id: 'c2', amount_cents: 2000, allocation_kind: 'carry-forward' },
];
const today = '2026-10-15';
const billRows = buildAdminBillRows({ customers, bills, receipts, allocations, today });
const formatMoney = (cents) => cents == null ? 'Not priced' : `PKR ${cents}`;

function totalsFor(month) {
  return calculateDashboard({ month, today, customers, bills, receipts, allocations });
}

function directoryRows() {
  return [
    { customer: customers[0], billing: { balanceCents: 1000 }, bill: bills[1] },
    { customer: customers[1], billing: { balanceCents: 2000 }, bill: bills[2] },
    { customer: customers[2], billing: { balanceCents: 0 }, bill: null },
    { customer: customers[3], billing: { balanceCents: 9000 }, bill: bills[1] },
  ];
}

test('monthly series reuses canonical billing semantics and omits unobserved months', () => {
  const series = buildDashboardTrendSeries({ month: '2026-10', today, bills, receipts, allocations, billRows, view: 'month' });

  assert.deepEqual(series.points.map(({ key }) => key), ['2026-09', '2026-10']);
  assert.deepEqual(series.points.map(({ billedCents, collectedCents, pendingCents }) => ({ billedCents, collectedCents, pendingCents })), [
    { billedCents: 8000, collectedCents: 2000, pendingCents: 8000 },
    { billedCents: 15000, collectedCents: 3000, pendingCents: 10000 },
  ]);
  assert.equal(series.needsMoreMonths, false);
  assert.equal(series.hasRecords, true);
  assert.equal(series.points[1].collectedCents, totalsFor('2026-10').cashReceivedCents);
  assert.notEqual(series.points[1].collectedCents, totalsFor('2026-10').creditAppliedCents);
});

test('monthly chart reports insufficient history rather than inventing a zero previous month', () => {
  const singlePeriod = buildDashboardTrendSeries({
    month: '2026-10', today, bills: bills.filter((bill) => bill.period.startsWith('2026-10')),
    receipts: receipts.filter((receipt) => receipt.received_on.startsWith('2026-10')),
    allocations, billRows, view: 'month',
  });
  assert.equal(singlePeriod.points.length, 1);
  assert.equal(singlePeriod.needsMoreMonths, true);
  assert.equal(singlePeriod.points.some((point) => point.key === '2026-09'), false);
  const markup = renderDashboardAnalytics({
    month: '2026-10', today, totals: totalsFor('2026-10'), customers, bills, receipts, allocations,
    billRows, customerRows: directoryRows(), trendSeries: singlePeriod, formatMoney, t: (message) => message,
  });
  assert.match(markup, /role="status">A monthly trend needs recorded bill or receipt data in at least two months\./);
});

test('daily and weekly views use creation, actual-receipt, and recorded due dates separately', () => {
  const daily = buildDashboardTrendSeries({ month: '2026-10', today, bills, receipts, allocations, billRows, view: 'day' });
  assert.equal(daily.points.length, 31);
  assert.equal(daily.points[0].billedCents, 10000, 'bill value follows snapshot created_at when issue date is absent');
  assert.equal(daily.points[2].collectedCents, 3000, 'collection follows received_on, not the allocation date');
  assert.equal(daily.points[9].pendingCents, 3000, 'current pending balance follows the saved due date');
  assert.equal(daily.points[19].pendingCents, 7000);

  const weekly = buildDashboardTrendSeries({ month: '2026-10', today, bills, receipts, allocations, billRows, view: 'week' });
  assert.equal(weekly.points[0].billedCents, 10000);
  assert.equal(weekly.points[1].billedCents, 5000);
  assert.equal(weekly.points[1].pendingCents, 3000);
  assert.equal(weekly.points[2].pendingCents, 7000);
  assert.equal(weekly.points[0].collectedCents, 3000);
});

test('collection rate hides a zero denominator and caps only the ring, not the displayed ratio', () => {
  assert.equal(buildCollectionRate({ billedCents: 0, cashReceivedCents: 500 }), null);
  assert.deepEqual(buildCollectionRate({ billedCents: 10000, cashReceivedCents: 12500, outstandingCents: 2500 }), {
    billedCents: 10000,
    collectedCents: 12500,
    outstandingCents: 2500,
    percentage: 125,
    visualPercentage: 100,
  });
});

test('billing breakdown categories are disjoint, period-scoped, and retain actual balances', () => {
  const breakdownRows = [
    { bill: { organization_id: organizationId, id: 'paid' }, period: '2026-10', status: 'paid', amountDueCents: 3000, balanceCents: 0 },
    { bill: { organization_id: organizationId, id: 'pending' }, period: '2026-10', status: 'unpaid', amountDueCents: 4000, balanceCents: 4000, isOverdue: false },
    { bill: { organization_id: organizationId, id: 'overdue' }, period: '2026-10', status: 'unpaid', amountDueCents: 5000, balanceCents: 3000, isOverdue: true },
    { bill: { organization_id: organizationId, id: 'unpriced' }, period: '2026-10', status: 'not-priced', amountDueCents: null, balanceCents: null },
    { bill: { organization_id: organizationId, id: 'paid' }, period: '2026-10', status: 'paid', amountDueCents: 3000, balanceCents: 0 },
    { bill: { organization_id: organizationId, id: 'old' }, period: '2026-09', status: 'unpaid', amountDueCents: 6000, balanceCents: 6000, isOverdue: true },
  ];
  assert.deepEqual(buildBillingBreakdown(breakdownRows, '2026-10'), {
    paid: { count: 1, balanceCents: 0 },
    pending: { count: 1, balanceCents: 4000 },
    overdue: { count: 1, balanceCents: 3000 },
    unpriced: { count: 1, balanceCents: 0 },
  });
});

test('customer summary and leaders use only stored statuses, actual receipt dates, and non-archived balances', () => {
  const summary = summarizeDashboardCustomers({ customers, customerRows: directoryRows(), month: '2026-10', overdueCustomerCount: 2 });
  assert.deepEqual(summary.statusCounts, { active: 1, offline: 1, 'not-set': 1, archived: 1 });
  assert.equal(summary.total, 4);
  assert.equal(summary.newThisMonth, 3);
  assert.equal(summary.withBalance, 2);
  assert.equal(summary.overdue, 2);
  assert.deepEqual(buildCustomerGrowthSeries(customers, '2026-10').map((point) => [point.key, point.count]), [['2026-09', 1], ['2026-10', 3]]);

  assert.deepEqual(buildTopDebtors(directoryRows()).map((row) => [row.customerId, row.balanceCents]), [['c2', 2000], ['c1', 1000]]);
  const collectors = buildTopCollectors({ customers, receipts: [...receipts, receipts[0]], month: '2026-10' });
  assert.deepEqual(collectors.map((row) => [row.customerId, row.amountCents, row.receiptCount]), [['c1', 3000, 1]]);
});

test('recently paid list uses the latest past receipt per customer and excludes future receipts', () => {
  const recent = buildRecentlyPaidCustomers({
    customers,
    receipts: [
      ...receipts,
      { organization_id: organizationId, id: 'r-oct-old-c1', customer_id: 'c1', received_on: '2026-10-02', amount_cents: 1000 },
      { organization_id: organizationId, id: 'r-oct-c2', customer_id: 'c2', received_on: '2026-10-10', amount_cents: 1500 },
      { organization_id: organizationId, id: 'r-oct-future', customer_id: 'c3', received_on: '2026-10-20', amount_cents: 2500 },
    ],
    month: '2026-10',
    today,
  });
  assert.deepEqual(recent.map(({ customerId, receivedOn, amountCents, serviceStatus }) => [customerId, receivedOn, amountCents, serviceStatus]), [
    ['c2', '2026-10-10', 1500, 'Offline'],
    ['c1', '2026-10-03', 3000, 'Active'],
  ]);
  assert.deepEqual(buildRecentlyPaidCustomers({ customers, receipts, month: '2026-10', today, limit: 0 }), []);
});

test('recent activity shows only supported, non-future record timestamps', () => {
  const events = buildRecentActivity({
    customers: [...customers, { id: 'no-date', name: 'No date' }],
    bills,
    receipts,
    incidents: [{ organization_id: organizationId, id: 'incident-1', customer_id: 'c1', reported_at: '2026-10-04T09:00:00Z' }],
    now: new Date('2026-10-15T12:00:00Z'),
    limit: 20,
  });
  assert.equal(events.some((event) => event.key === 'customer:no-date'), false);
  assert.equal(events.find((event) => event.key === `customer:${customers[0].id}`)?.title, 'Customer record added');
  assert.equal(events.some((event) => event.key === 'incident:synthetic-org:incident-1'), true);
  assert.deepEqual(events, [...events].sort((left, right) => right.at - left.at));
  assert.equal(events.some((event) => event.at.getTime() > Date.parse('2026-10-15T12:00:00Z')), false);
});

test('analytics renderer exposes exact accessible values, clickable categories, and escaped customer names', () => {
  const totals = totalsFor('2026-10');
  const markup = renderDashboardAnalytics({
    month: '2026-10', today, now: new Date('2026-10-15T12:00:00Z'), totals,
    customers, bills, receipts, allocations, billRows, customerRows: directoryRows(),
    incidents: [], formatMoney, t: (message) => translateUi(message, 'en'),
  });

  assert.match(markup, /role="img" aria-label="Billing and collection trend"/);
  assert.match(markup, /Customer records added this month/);
  assert.match(markup, /Customer record additions by month/);
  assert.match(markup, /service activation dates are not recorded/);
  assert.match(markup, /data-dashboard-trend-view="week"/);
  assert.match(markup, /scope=paid&amp;period=2026-10/);
  assert.match(markup, /scope=pending&amp;period=2026-10/);
  assert.match(markup, /data-dashboard-service-status="active"/);
  assert.match(markup, /data-dashboard-customer-id="c1"/);
  assert.match(markup, /Recently paid customers/);
  assert.match(markup, /Most recent receipt: 2026-10-03/);
  assert.match(markup, /dashboard-leader-status">Active/);
  assert.match(markup, /Collection rate/);
  assert.match(markup, /bill periods; collected cash follows receipt dates/);
  assert.match(markup, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /status-change events are not recorded/);
});

test('empty dashboard analytics use explicit accessible states rather than fabricated trends or records', () => {
  const totals = calculateDashboard({ month: '2026-10', today, customers: [], bills: [], receipts: [], allocations: [] });
  const markup = renderDashboardAnalytics({
    month: '2026-10', today, now: new Date('2026-10-15T12:00:00Z'), totals,
    customers: [], bills: [], receipts: [], allocations: [], billRows: [], customerRows: [], incidents: [],
    formatMoney, t: (message) => translateUi(message, 'en'),
  });

  for (const message of [
    'No dated billing, receipt, or due-date records are available for this view.',
    'Collection rate is unavailable until the selected month has a priced bill.',
    'No bill snapshots are recorded for the selected month.',
    'No outstanding customer balances are recorded.',
    'No actual receipts are recorded for this month.',
    'No recent recorded activity is available.',
  ]) {
    assert.ok(markup.includes(`role="status">${message}</p>`), `expected accessible empty state: ${message}`);
  }
  assert.doesNotMatch(markup, /role="img" aria-label="Billing and collection trend"/, 'an empty data set must not render a fabricated chart');
});

test('new analytics controls and summaries have Roman Urdu labels', () => {
  assert.equal(translateUi('Billing vs collection trend', 'ur-Latn'), 'Billing aur wasooli ka rujhan');
  assert.equal(translateUi('Customer overview', 'ur-Latn'), 'Customers ka jaiza');
  assert.equal(translateUi('Quick actions', 'ur-Latn'), 'Fori kaam');
  assert.match(translateUi('{change}% vs previous month', 'ur-Latn'), /pichlay mahine ke muqablay mein/);
});
