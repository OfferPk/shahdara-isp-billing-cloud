import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildCustomerListRows,
  customerDueLabel,
  filterCustomerRows,
  getCustomerAreaOptions,
  renderCustomerCards,
  renderCustomerProfile,
  summarizeCustomerRows,
} from '../src/customer-list.js';

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
  assert.match(markup, /<td>4000<\/td><td>6000<\/td><td>0<\/td>/);
  assert.match(markup, /Admin-only phone/);
  assert.match(markup, /href="tel:03001234567"/);
  assert.doesNotMatch(markup, /staff_notes|recorded_by|email/);
});

test('list controls and mobile CSS provide labelled, keyboard-operable status and area filters', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(main, /id="customer-search" type="search"/);
  assert.match(main, /role="group" aria-label="\$\{escapeHtml\(t\('Filter customers by payment status or area'\)\)\}"/);
  assert.match(main, /aria-pressed="\$\{pageState\.customerListStatus === 'paid'\}"/);
  assert.match(main, /id="customer-list-count" class="customer-list-count" role="status" aria-live="polite"/);
  assert.match(main, /<dialog id="customer-profile-dialog"/);
  assert.match(styles, /\.customer-card-grid\s*\{[^}]*display: grid/s);
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
