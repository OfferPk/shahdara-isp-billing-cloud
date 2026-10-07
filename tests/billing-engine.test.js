import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoiceShareText, buildMonthlyInvoiceRequest, buildPackagePricingRows, normalizePackageName } from '../src/billing-engine.js';
import { renderAdminPackageCards } from '../src/admin-packages.js';
import { formatMoney } from '../src/ledger.js';

const customers = [
  { id: 'c1', package_id: 'pkg-10', plan_name: '10M', monthly_fee_cents: null, service_status: 'active', archived: false },
  { id: 'c2', package_id: 'pkg-10', plan_name: '10M', monthly_fee_cents: null, service_status: 'active', archived: false },
  { id: 'c3', package_id: 'pkg-15', plan_name: '15M', monthly_fee_cents: 220000, service_status: 'offline', archived: false },
  { id: 'c4', package_id: 'pkg-old', plan_name: 'Legacy', monthly_fee_cents: 50000, service_status: 'active', archived: true },
];

test('package rows merge imported router tariffs with active customer counts and safe legacy fees', () => {
  const rows = buildPackagePricingRows(customers, [
    { id: 'pkg-10', name: '10M', monthly_fee_cents: 180000, effective_on: '2026-10-01' },
    { id: 'pkg-15', name: '15M', monthly_fee_cents: null },
  ]);
  assert.deepEqual(rows.map((row) => [row.name, row.monthlyFeeCents, row.activeCustomerCount, row.customerCount]), [
    ['10M', 180000, 2, 2],
    ['15M', 220000, 0, 1],
    ['Legacy', 50000, 0, 1],
  ]);
  assert.equal(rows[0].effectiveOn, '2026-10-01');
});

test('package rows retain router-imported profiles when the saved tariff table is empty', () => {
  const rows = buildPackagePricingRows(customers, []);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((row) => row.name === '10M').packageId, 'pkg-10');
  assert.equal(rows.find((row) => row.name === '10M').monthlyFeeCents, null);
});

test('package name and package card rendering escape router-sourced labels', () => {
  assert.equal(normalizePackageName(' 10M '), '10M');
  assert.throws(() => normalizePackageName(''), /1 to 100/);
  assert.throws(() => normalizePackageName('X\u0000Y'), /printable/);
  const rows = buildPackagePricingRows([{ id: 'x', package_id: 'x', plan_name: '<b>10M</b>', service_status: 'active' }]);
  const html = renderAdminPackageCards(rows, formatMoney);
  assert.match(html, /&lt;b&gt;10M&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>10M/);
});

test('monthly invoice request requires real month and exact valid dates', () => {
  assert.deepEqual(buildMonthlyInvoiceRequest({
    billingMonth: '2026-10', issueDate: '2026-10-07', dueDate: '2026-10-15',
  }), { billingMonth: '2026-10', issueDate: '2026-10-07', dueDate: '2026-10-15' });
  assert.throws(() => buildMonthlyInvoiceRequest({ billingMonth: '2026-13', issueDate: '2026-10-07', dueDate: '2026-10-15' }), /billing month/);
  assert.throws(() => buildMonthlyInvoiceRequest({ billingMonth: '2026-10', issueDate: '2026-02-30', dueDate: '2026-10-15' }), /issue date/);
  assert.throws(() => buildMonthlyInvoiceRequest({ billingMonth: '2026-10', issueDate: '2026-10-07' }), /exact due date/);
});

test('invoice share text contains the invoice details and uses the current outstanding total source field', () => {
  const text = buildInvoiceShareText({
    bill: {
      id: 'bill-123', invoice_number: 'SIF-202610-12', period: '2026-10-01',
      due_date: '2026-10-15', plan_snapshot: '10M', amount_due_cents: 180000,
    },
    customer: { name: 'Amina Fiber', pppoe_username: 'amina-10m' },
    formatMoney,
  });
  assert.match(text, /Invoice: SIF-202610-12/);
  assert.match(text, /Customer: Amina Fiber/);
  assert.match(text, /PPPoE Username: amina-10m/);
  assert.match(text, /Package: 10M/);
  assert.match(text, /Billing Month: 2026-10/);
  assert.match(text, /Due Date: 2026-10-15/);
  assert.match(text, /Total Amount: /);
});

test('invoice share text falls back to a legacy customer plan when a saved snapshot has no plan label', () => {
  const text = buildInvoiceShareText({
    bill: { id: 'legacy-bill', period: '2026-09-01', due_date: '2026-09-15', plan_snapshot: '', amount_due_cents: 180000 },
    customer: { name: 'Amina Fiber', plan_name: '10M' },
    formatMoney,
  });
  assert.match(text, /Package: 10M/);
});
