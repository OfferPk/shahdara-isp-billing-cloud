import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatMoney } from '../src/ledger.js';
import { renderDashboardMetrics } from '../src/dashboard-metrics.js';

function syntheticTotals(overrides = {}) {
  return {
    customerCount: 8,
    activeCustomers: 6,
    billedCents: 1250000,
    pricedBillCount: 2,
    unpricedBillCount: 0,
    cashReceivedCents: 780000,
    outstandingCents: 510000,
    creditAppliedCents: 90000,
    receiptCount: 12,
    monthBills: [{ id: 'synthetic-bill-1' }, { id: 'synthetic-bill-2' }],
    ...overrides,
  };
}

test('Admin KPI cards show billed, collected, and pending values with clear month and cash/credit definitions', () => {
  const markup = renderDashboardMetrics({ month: '2026-02', totals: syntheticTotals() });

  assert.match(markup, /<section class="metric-grid admin-metrics" aria-label="Monthly billing summary">/);
  assert.equal((markup.match(/<article class="metric metric--/g) ?? []).length, 3);
  assert.match(markup, /Total Billed · 2026-02/);
  assert.match(markup, /Collected · 2026-02/);
  assert.match(markup, /Pending · 2026-02/);
  assert.match(markup, /12 actual receipts by received date; no credit/);
  assert.match(markup, /credit applied separately/);
  assert.match(markup, /2 priced bills; 0 unpriced excluded/);
  assert.doesNotMatch(markup, /Customers|active/);
  assert.match(markup, new RegExp(formatMoney(1250000).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(markup, /aria-hidden="true"/);
});

test('Admin KPI renderer escapes month text and ignores private or unknown properties', () => {
  const markup = renderDashboardMetrics({
    month: '2026-02<img src=x>',
    totals: syntheticTotals({
      phone: '03XXXXXXXXX',
      privateDetails: { address: 'synthetic private address' },
      customerNames: new Map([['synthetic-customer', 'Synthetic Name']]),
    }),
  });

  assert.match(markup, /Total Billed · 2026-02&lt;img src=x&gt;/);
  assert.doesNotMatch(markup, /<img/);
  assert.doesNotMatch(markup, /03XXXXXXXXX|synthetic private address|Synthetic Name/);
});

test('color and spacing refinements are scoped to Admin metrics, preserving customer card styles', async () => {
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.match(styles, /^\.metric \{ display: grid; gap: 8px; min-height: 128px;/m);
  assert.match(styles, /^\.admin-metrics \.metric::before/m);
  assert.match(styles, /^\.admin-metrics \.metric--outstanding/m);
  assert.doesNotMatch(styles, /^\.metric::before/m);
  assert.doesNotMatch(styles, /^\.metric--(?:customers|billed|cash|outstanding)/m);
  assert.doesNotMatch(styles, /^\.metric__(?:icon|label|top)\b/m);
});
