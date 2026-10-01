import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from '../src/ledger.js';
import { renderDashboardMetrics } from '../src/dashboard-metrics.js';

function syntheticTotals(overrides = {}) {
  return {
    customerCount: 8,
    activeCustomers: 6,
    billedCents: 1250000,
    cashReceivedCents: 780000,
    outstandingCents: 510000,
    creditAppliedCents: 90000,
    receiptCount: 12,
    monthBills: [{ id: 'synthetic-bill-1' }, { id: 'synthetic-bill-2' }],
    ...overrides,
  };
}

test('Admin KPI cards retain clear cash, credit, billing, and customer labels', () => {
  const markup = renderDashboardMetrics({ month: '2026-02', totals: syntheticTotals() });

  assert.match(markup, /<section class="metric-grid" aria-label="Monthly billing summary">/);
  assert.equal((markup.match(/<article class="metric metric--/g) ?? []).length, 4);
  assert.match(markup, /Customers/);
  assert.match(markup, /2026-02 billed/);
  assert.match(markup, /Cash received/);
  assert.match(markup, /Outstanding/);
  assert.match(markup, /12 receipts by actual date/);
  assert.match(markup, /credit applied · not cash/);
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

  assert.match(markup, /2026-02&lt;img src=x&gt; billed/);
  assert.doesNotMatch(markup, /<img/);
  assert.doesNotMatch(markup, /03XXXXXXXXX|synthetic private address|Synthetic Name/);
});
