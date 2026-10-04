import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildCustomerListRows,
  customerDueLabel,
  filterCustomerRows,
  filterCustomersWithoutBillSnapshot,
  getCustomerAreaOptions,
  paginateCustomerRows,
  renderCustomerCards,
  renderCustomerProfile,
  sortCustomerRows,
  summarizeCustomerRows,
} from '../src/customer-list.js';
import { formatUiMessage, translateUi } from '../src/language.js';

const customers = [
  {
    id: 'synthetic-a', customer_number: 7, name: 'Aisha Khan', plan_name: 'Fiber 30',
    service_address: 'Sector 1, Street 2', service_status: 'active', archived: false,
  },
  {
    id: 'synthetic-b', customer_number: 18, name: 'Bilal Ahmed', plan_name: 'Fiber 15',
    service_address: 'Sector 2, Street 3', service_status: 'offline', archived: false,
  },
  {
    id: 'synthetic-c', customer_number: 33, name: 'Archived Customer', plan_name: '',
    service_address: '', service_status: 'active', archived: true,
  },
];

const bills = [
  { id: 'bill-a', customer_id: 'synthetic-a', period: '2026-10-01', amount_due_cents: 10000, due_date: '2026-10-20', plan_snapshot: 'Fiber 30 snapshot' },
  { id: 'bill-b-old', customer_id: 'synthetic-b', period: '2026-09-01', amount_due_cents: 8000, due_date: null, plan_snapshot: 'Fiber 15 snapshot' },
  { id: 'bill-b-future', customer_id: 'synthetic-b', period: '2026-12-01', amount_due_cents: 12000, due_date: '2026-12-20', plan_snapshot: 'Future plan' },
  { id: 'bill-c', customer_id: 'synthetic-c', period: '2026-10-01', amount_due_cents: null, due_date: null, plan_snapshot: '' },
];

const allocations = [
  { customer_id: 'synthetic-a', bill_id: 'bill-a', amount_cents: 4000, allocation_kind: 'same-month' },
  { customer_id: 'synthetic-a', bill_id: 'bill-a', amount_cents: 6000, allocation_kind: 'carry-forward' },
  { customer_id: 'synthetic-b', bill_id: 'bill-b-old', amount_cents: 3000, allocation_kind: 'same-month' },
];

function rowsForTests(overrides = {}) {
  return buildCustomerListRows({
    customers,
    bills,
    allocations,
    privateDetails: [
      { customer_id: 'synthetic-a', phone: '0300 123 4567' },
      { customer_id: 'synthetic-b', phone: '+923011112222' },
      // Other private fields are deliberately ignored by the customer-list model.
      { customer_id: 'synthetic-c', phone: '', mohalla: 'Private Mohalla', zone: 'Private Zone' },
    ],
    currentMonth: '2026-10',
    ...overrides,
  });
}

test('billing state uses the current bill or latest non-future bill and sums allocations once', () => {
  const rows = rowsForTests();
  const aisha = rows.find((row) => row.customer.id === 'synthetic-a');
  const bilal = rows.find((row) => row.customer.id === 'synthetic-b');
  const archived = rows.find((row) => row.customer.id === 'synthetic-c');

  assert.equal(aisha.bill.id, 'bill-a');
  assert.equal(aisha.billing.status, 'paid');
  assert.equal(aisha.billing.balanceCents, 0);
  assert.equal(bilal.bill.id, 'bill-b-old', 'a future-dated bill is not treated as the current/latest bill');
  assert.equal(bilal.billing.status, 'unpaid');
  assert.equal(bilal.billing.balanceCents, 5000);
  assert.equal(archived.billing.status, 'not-set');
  assert.equal(archived.billing.balanceCents, null);
});

test('a receipt without a matching allocation does not fabricate a paid status', () => {
  const rows = buildCustomerListRows({
    customers: [customers[1]],
    bills: [bills[1]],
    allocations: [],
    currentMonth: '2026-10',
  });
  assert.equal(rows[0].billing.status, 'unpaid');
  assert.equal(rows[0].billing.balanceCents, 8000);
});

test('account status includes older unpaid bills when the newest bill is paid', () => {
  const olderBill = { id: 'older-unpaid', customer_id: 'synthetic-a', period: '2026-07-01', amount_due_cents: 4000, due_date: '2026-07-05', plan_snapshot: 'Older plan' };
  const newestBill = { id: 'newest-paid', customer_id: 'synthetic-a', period: '2026-10-01', amount_due_cents: 10000, due_date: '2026-10-05', plan_snapshot: 'Current plan' };
  const [row] = buildCustomerListRows({
    customers: [customers[0]],
    bills: [newestBill, olderBill],
    allocations: [{ customer_id: 'synthetic-a', bill_id: 'newest-paid', amount_cents: 10000 }],
    currentMonth: '2026-10',
  });
  assert.equal(row.bill.id, 'newest-paid');
  assert.equal(row.billing.status, 'unpaid');
  assert.equal(row.billing.balanceCents, 4000);
  assert.equal(row.paymentBill.id, 'older-unpaid');
  assert.equal(customerDueLabel(row.dueBill), 'Due 2026-07-05');
  const markup = renderCustomerCards([row], (cents) => String(cents));
  assert.match(markup, />Mark as Paid<\/button>/);
  assert.doesNotMatch(markup, /data-action="mark-as-paid"[^>]*disabled/);
});

test('account balance sums multiple open bill balances and points to the oldest one', () => {
  const olderBill = { id: 'older-open', customer_id: 'synthetic-a', period: '2026-07-01', amount_due_cents: 4000, due_date: '2026-07-05', plan_snapshot: 'Older plan' };
  const newerBill = { id: 'newer-open', customer_id: 'synthetic-a', period: '2026-10-01', amount_due_cents: 10000, due_date: '2026-10-05', plan_snapshot: 'Current plan' };
  const [row] = buildCustomerListRows({
    customers: [customers[0]],
    bills: [newerBill, olderBill],
    allocations: [{ customer_id: 'synthetic-a', bill_id: 'newer-open', amount_cents: 3000 }],
    currentMonth: '2026-10',
  });
  assert.equal(row.billing.status, 'unpaid');
  assert.equal(row.billing.balanceCents, 11000);
  assert.equal(row.paymentBill.id, 'older-open');
});

test('search matches name, Admin phone digits, and the account number replacing a missing username field', () => {
  const rows = rowsForTests();
  assert.deepEqual(filterCustomerRows(rows, { search: 'AISHA' }).map((row) => row.customer.id), ['synthetic-a']);
  assert.deepEqual(filterCustomerRows(rows, { search: '0300-123' }).map((row) => row.customer.id), ['synthetic-a']);
  assert.deepEqual(filterCustomerRows(rows, { search: '#18' }).map((row) => row.customer.id), ['synthetic-b']);
});

test('Paid and Unpaid filters follow allocated balance and Area filters use only saved service address', () => {
  const rows = rowsForTests();
  assert.deepEqual(filterCustomerRows(rows, { status: 'paid' }).map((row) => row.customer.id), ['synthetic-a']);
  assert.deepEqual(filterCustomerRows(rows, { status: 'unpaid' }).map((row) => row.customer.id), ['synthetic-b']);
  assert.deepEqual(filterCustomerRows(rows, { area: 'Sector 2, Street 3' }).map((row) => row.customer.id), ['synthetic-b']);
  assert.deepEqual(getCustomerAreaOptions(rows), [
    { value: 'Sector 1, Street 2', label: 'Sector 1, Street 2' },
    { value: 'Sector 2, Street 3', label: 'Sector 2, Street 3' },
    { value: '__address_not_recorded__', label: 'Address not recorded' },
  ]);
  assert.doesNotMatch(JSON.stringify(getCustomerAreaOptions(rows)), /Private Mohalla|Private Zone/);
});

test('customer sorting is deterministic, keeps unknown balances last, and applies after filters', () => {
  const rows = rowsForTests();
  assert.deepEqual(sortCustomerRows(rows, 'account-number').map((row) => row.customer.id), [
    'synthetic-a', 'synthetic-b', 'synthetic-c',
  ]);
  assert.deepEqual(sortCustomerRows(rows, 'name').map((row) => row.customer.id), [
    'synthetic-a', 'synthetic-c', 'synthetic-b',
  ]);
  assert.deepEqual(sortCustomerRows(rows, 'balance').map((row) => row.customer.id), [
    'synthetic-b', 'synthetic-a', 'synthetic-c',
  ]);
  const filtered = filterCustomerRows(rows, { area: 'Sector 2, Street 3' });
  const [selected] = sortCustomerRows(filtered, 'name');
  assert.equal(selected.customer.id, 'synthetic-b');
  assert.match(renderCustomerCards([selected], () => 'PKR 0'), /data-customer-id="synthetic-b"/);
});

test('customer pagination returns every row once, clamps requests, and handles an empty result', () => {
  const rows = Array.from({ length: 23 }, (_, index) => ({
    customer: { id: `synthetic-${index + 1}`, customer_number: index + 1 },
  }));
  const second = paginateCustomerRows(rows, { page: 2 });
  assert.deepEqual(second.items.map((row) => row.customer.id), Array.from({ length: 10 }, (_, index) => `synthetic-${index + 11}`));
  assert.equal(second.start, 11);
  assert.equal(second.end, 20);
  assert.equal(second.pageCount, 3);
  const last = paginateCustomerRows(rows, { page: 99 });
  assert.equal(last.page, 3);
  assert.equal(last.items.length, 3);
  assert.equal(paginateCustomerRows(rows, { page: -4 }).page, 1);
  assert.deepEqual(paginateCustomerRows([]), {
    items: [], page: 1, pageSize: 10, pageCount: 1, start: 0, end: 0, total: 0,
  });
});

test('customer directory sort, visible-range count, and page labels are Roman Urdu', () => {
  assert.equal(translateUi('Sort customers', 'ur-Latn'), 'Customers ki tartib chunein');
  assert.equal(translateUi('Name (A to Z)', 'ur-Latn'), 'Naam (A se Z)');
  assert.equal(translateUi('Customer directory pages', 'ur-Latn'), 'Customers ki fehrist ke safhay');
  assert.equal(formatUiMessage(
    'Showing {shownStart}–{shownEnd} of {matching} matching customers; {total} total customers.',
    'ur-Latn',
    { shownStart: 11, shownEnd: 20, matching: 23, total: 41 },
  ), 'Kul 41 customers mein se 23 mutabiq customer entries 11–20 dikhayi ja rahi hain.');
});

test('missing-snapshot drill-down returns only active non-archived customers missing the exact selected month', () => {
  const candidates = [
    { id: 'active-missing', customer_number: 40, name: 'Active Missing', service_status: 'active', archived: false },
    { id: 'active-has-snapshot', customer_number: 41, name: 'Active Has Snapshot', service_status: 'active', archived: false },
    { id: 'active-archived', customer_number: 42, name: 'Archived', service_status: 'active', archived: true },
    { id: 'offline-missing', customer_number: 43, name: 'Offline', service_status: 'offline', archived: false },
  ];
  const rows = buildCustomerListRows({
    customers: candidates,
    bills: [
      { id: 'old-snapshot', customer_id: 'active-missing', period: '2026-01-01', amount_due_cents: 5000 },
      { id: 'month-snapshot', customer_id: 'active-has-snapshot', period: '2026-02-01', amount_due_cents: null },
    ],
    allocations: [],
    currentMonth: '2026-02',
  });

  assert.deepEqual(filterCustomersWithoutBillSnapshot(rows, [
    { id: 'old-snapshot', customer_id: 'active-missing', period: '2026-01-01' },
    { id: 'month-snapshot', customer_id: 'active-has-snapshot', period: '2026-02-01' },
  ], '2026-02').map((row) => row.customer.id), ['active-missing']);
  assert.deepEqual(filterCustomersWithoutBillSnapshot(rows, [], '2026-13'), []);
});

test('header summary counts active non-archived customers and unpaid non-archived accounts', () => {
  assert.deepEqual(summarizeCustomerRows(rowsForTests()), { total: 3, active: 1, unpaid: 1 });
});

test('due-date display uses an actual due_date or falls back to its saved billing period', () => {
  assert.equal(customerDueLabel(bills[0]), 'Due 2026-10-20');
  assert.equal(customerDueLabel(bills[1]), 'Billing period 2026-09');
  assert.equal(customerDueLabel(null), 'No bill yet');
});

test('cards expose accessible profile and quick-action controls without sending WhatsApp messages', () => {
  const rows = rowsForTests();
  const markup = renderCustomerCards(rows, (cents) => String(cents ?? 'Not set'));
  assert.match(markup, /type="button" data-action="open-customer-profile"/);
  assert.match(markup, /aria-label="Open profile and billing history for Aisha Khan, account 7"/);
  assert.match(markup, /href="tel:03001234567"/);
  assert.match(markup, /https:\/\/wa\.me\/923011112222\?text=/);
  assert.match(markup, /target="_blank" rel="noopener noreferrer"/);
  assert.match(markup, /WhatsApp reminder unavailable; the account has no unpaid balance/);
  assert.match(markup, />Mark as Paid<\/button>/);
  assert.match(markup, /title="Opens the real receipt form\. Nothing is recorded until you review and submit it\."/);
  assert.doesNotMatch(markup, /window\.open|sendMessage|messages\.send/i);
});

test('customer card rendering escapes untrusted profile values and disables receipt actions when no unpaid bill exists', () => {
  const injected = rowsForTests({
    customers: [{ ...customers[0], name: '<img src=x onerror=alert(1)>' }],
    privateDetails: [],
  });
  const markup = renderCustomerCards(injected, () => 'PKR 0');
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /aria-label="Call unavailable; no Admin phone is recorded"/);
  assert.match(markup, /data-action="mark-as-paid"[^>]*disabled/);
});

test('customer card profile button does not mask visible status, balance, and package details', () => {
  const row = rowsForTests().find((entry) => entry.customer.id === 'synthetic-a');
  const markup = renderCustomerCards([row], (cents) => `PKR ${cents}`);
  const profileButton = markup.match(/<button class="customer-card__open"[\s\S]*?<\/button>/)?.[0] ?? '';

  assert.match(profileButton, /Open profile and billing history for Aisha Khan, account 7/);
  assert.doesNotMatch(profileButton, /Paid|Balance|PKR|Fiber 30/);
  assert.match(markup, /customer-card__billing-status[^>]*>Paid<\/span>/);
  assert.match(markup, /<dl class="customer-card__details"><div><dt class="customer-card__label">Balance<\/dt><dd>PKR 0<\/dd>/);
  assert.match(markup, /<dt class="customer-card__label">Package<\/dt><dd>Fiber 30 snapshot<\/dd>/);
});

test('profile history keeps bill balance, cash receipts, and carry-forward credit separate', () => {
  const row = rowsForTests().find((entry) => entry.customer.id === 'synthetic-a');
  const markup = renderCustomerProfile(row, {
    bills,
    receipts: [{ customer_id: 'synthetic-a', origin_bill_id: 'bill-a', received_on: '2026-10-10', amount_cents: 4000, method: 'Cash' }],
    allocations,
    formatMoney: (cents) => String(cents ?? 'Not set'),
  });
  assert.match(markup, /Billing history/);
  assert.match(markup, /Receipt history/);
  assert.match(markup, /Due 2026-10-20/);
  assert.match(markup, /<dt>Cash received<\/dt><dd>4000<\/dd>/);
  assert.match(markup, /<dt>Credit applied<\/dt><dd>6000<\/dd>/);
  assert.match(markup, /<dt>Balance<\/dt><dd>0<\/dd>/);
  assert.match(markup, /class="record-card-grid customer-profile-card-grid"/);
  assert.match(markup, /Admin-only phone/);
  assert.match(markup, /href="tel:03001234567"/);
  assert.doesNotMatch(markup, /staff_notes|recorded_by|email/);
});

test('Admin profile shows same-tenant posted cash, labelled service tenure, effective cost history, and estimated contribution', () => {
  const baseRow = rowsForTests().find((entry) => entry.customer.id === 'synthetic-a');
  const row = {
    ...baseRow,
    connectionDate: '2025-10-15',
    customer: { ...baseRow.customer, created_at: '2020-01-01T00:00:00.000Z' },
  };
  const customerReceipts = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(2025, 9 + index, 15, 12);
    const receivedOn = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-15`;
    return {
      organization_id: 'org-a', id: `cash-${index}`, customer_id: 'synthetic-a',
      origin_bill_id: 'bill-a', received_on: receivedOn, amount_cents: 300000, method: 'Cash',
    };
  });
  customerReceipts.push(
    { ...customerReceipts[0], organization_id: 'org-b', id: 'other-tenant', amount_cents: 999999 },
    { ...customerReceipts[0], customer_id: 'synthetic-b', id: 'other-customer', amount_cents: 999999 },
    { ...customerReceipts[0], id: 'future-cash', received_on: '2026-10-16', amount_cents: 999999 },
  );
  const customerServiceCosts = [
    { organization_id: 'org-a', customer_id: 'synthetic-a', id: 'cost-old', effective_on: '2025-10-01', monthly_cost_paisa: 160000, created_at: '2025-09-01T00:00:00.000Z', note: 'superseded' },
    { organization_id: 'org-a', customer_id: 'synthetic-a', id: 'cost-current', effective_on: '2025-10-01', monthly_cost_paisa: 150000, created_at: '2025-09-02T00:00:00.000Z', note: 'approved monthly package cost' },
    { organization_id: 'org-b', customer_id: 'synthetic-a', id: 'other-cost', effective_on: '2025-10-01', monthly_cost_paisa: 999999, created_at: '2025-09-03T00:00:00.000Z', note: 'other tenant' },
  ];
  const markup = renderCustomerProfile(row, {
    bills: [...bills, { id: 'unpaid-future', customer_id: 'synthetic-a', period: '2026-11-01', amount_due_cents: 999999, due_date: null, plan_snapshot: 'unpaid invoice' }],
    receipts: customerReceipts,
    allocations,
    customerServiceCosts,
    organizationId: 'org-a',
    now: new Date(2026, 9, 15, 12),
    formatMoney: (paisa) => String(paisa),
  });

  assert.match(markup, /Total cash collected from posted receipts<\/dt><dd>3600000<\/dd>/);
  assert.match(markup, /Service start date<\/dt><dd>2025-10-15<\/dd>/);
  assert.match(markup, /Customer tenure<\/dt><dd>1 year<\/dd>/);
  assert.match(markup, /Estimated customer contribution<\/dt><dd>1800000<\/dd>/);
  assert.match(markup, /Current assigned monthly package \/ bandwidth cost<\/dt><dd>150000<\/dd>/);
  assert.match(markup, /Active for this month/);
  assert.match(markup, /Superseded entry/);
  assert.match(markup, /approved monthly package cost/);
  assert.match(markup, /not audited net profit/i);
  assert.match(markup, /Cost allocations are not added to global cash expenses/i);
});

test('Admin profile reports N/A rather than treating unknown tenure or cost history as zero contribution', () => {
  const row = rowsForTests().find((entry) => entry.customer.id === 'synthetic-a');
  const markup = renderCustomerProfile(row, {
    bills, receipts: [], allocations, organizationId: 'org-a',
    formatMoney: (paisa) => `PKR ${paisa}`, now: new Date(2026, 9, 15, 12),
  });
  assert.match(markup, /Start date not recorded<\/dt><dd>N\/A — start date unknown<\/dd>/);
  assert.match(markup, /Customer tenure<\/dt><dd>N\/A — start date unknown<\/dd>/);
  assert.match(markup, /Estimated customer contribution<\/dt><dd>Unknown — add a start date and an effective monthly cost first\.<\/dd>/);
  assert.match(markup, /No service cost history recorded yet/);
});

test('test login control is absent from default profiles and appears only when explicitly enabled for Admin staging', () => {
  const original = rowsForTests().find((entry) => entry.customer.id === 'synthetic-a');
  const row = { ...original, customer: { ...original.customer } };
  const ordinaryMarkup = renderCustomerProfile(row, { bills, receipts: [], allocations, formatMoney: (cents) => String(cents) });
  assert.doesNotMatch(ordinaryMarkup, /customer-portal-test-account|Internal staging test login/);

  row.customer.pppoe_username = 'synthetic_pppoe_7';
  row.customer.portal_test_account = true;
  const stagingMarkup = renderCustomerProfile(row, {
    bills, receipts: [], allocations, formatMoney: (cents) => String(cents), portalTestModeAvailable: true,
  });
  assert.match(stagingMarkup, /id="customer-portal-test-account" type="checkbox" checked/);
  assert.match(stagingMarkup, /Existing PPPoE username/);
  assert.match(stagingMarkup, /default portal password 123456/);
  assert.match(stagingMarkup, /before any portal data is released/);
  assert.match(stagingMarkup, /does not change Overtake, RouterOS, or RADIUS credentials/);
});

test('list controls and mobile CSS provide labelled, keyboard-operable status and area filters', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(main, /id="customer-search" type="search"/);
  assert.match(main, /id="customer-list-sort"/);
  assert.match(main, /data-customer-page="-1"/);
  assert.match(main, /aria-label="\$\{escapeHtml\(t\('Customer directory pages'\)\)\}"/);
  assert.match(main, /role="group" aria-label="\$\{escapeHtml\(t\('Filter customers by payment status or area'\)\)\}"/);
  assert.match(main, /aria-pressed="\$\{pageState\.customerListStatus === 'paid'\}"/);
  assert.match(main, /id="customer-list-count" class="customer-list-count" role="status" aria-live="\$\{customerDrilldown \? 'off' : 'polite'\}"/);
  assert.match(main, /id="customer-list-drilldown-message" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(main, /data-action="clear-dashboard-drilldown" data-target="customer-list"/);
  assert.match(main, /<dialog id="customer-profile-dialog"/);
  assert.match(styles, /\.customer-card-grid\s*\{[^}]*display: grid/s);
  assert.match(styles, /\.customer-list-sort select \{[^}]*min-height: 44px;/);
  assert.match(styles, /\.customer-list-pagination button \{[^}]*min-height: 44px;/);
  assert.match(styles, /@media \(max-width: 600px\) \{\s+\.customer-list-panel \.customer-list-pagination \{ gap: 6px; \}/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.customer-card-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(styles, /\.customer-fab:focus-visible/);
});

test('Mark as Paid only opens the existing receipt form and never writes a status directly', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const handler = main.slice(main.indexOf('function openReceiptFormForCustomer'), main.indexOf('function renderAdmin()'));
  const prefill = main.slice(main.indexOf('function openReceiptFormForBill'), main.indexOf('function openReceiptFormForCustomer'));
  const actionBinder = main.slice(main.indexOf('function bindCustomerListActions'), main.indexOf('function renderCustomer()'));
  assert.match(prefill, /form\.elements\.amount\.value/);
  assert.match(prefill, /form\.elements\.received_on\.value/);
  assert.match(prefill, /form\.elements\.method\.value = ''/);
  assert.match(prefill, /Nothing has been recorded yet/);
  assert.match(handler, /const bill = row\?\.paymentBill \?\? row\?\.bill/);
  assert.doesNotMatch(handler, /record_cash_receipt|\.rpc\(|\.update\(/);
  assert.doesNotMatch(prefill, /record_cash_receipt|\.rpc\(|\.update\(/);
  assert.match(handler, /openReceiptFormForBill\(billRow\)/);
  assert.match(actionBinder, /openReceiptFormForCustomer\(row\)/);
  assert.match(main, /invokeRpc\(supabase,\s*'record_cash_receipt'/);
  assert.match(main, /data-action="open-add-customer"[\s\S]*?Add customer/);
});
