import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatMoney } from '../src/ledger.js';
import { renderDashboardMetrics } from '../src/dashboard-metrics.js';
import { translateUi } from '../src/language.js';

function syntheticTotals(overrides = {}) {
  return {
    customerCount: 8,
    activeCustomers: 6,
    billedCents: 1250000,
    pricedBillCount: 2,
    unpricedBillCount: 1,
    cashReceivedCents: 780000,
    outstandingCents: 510000,
    creditAppliedCents: 90000,
    overdueCents: 225000,
    overdueBillCount: 3,
    overdueAccountCount: 2,
    missingActiveBillSnapshotCount: 4,
    receiptCount: 12,
    monthBills: [{ id: 'synthetic-bill-1' }, { id: 'synthetic-bill-2' }],
    ...overrides,
  };
}

test('Admin monitoring cards show billing, actual cash, pending, overdue, unpriced, and missing-snapshot scopes', () => {
  const markup = renderDashboardMetrics({ month: '2026-02', today: '2026-02-15', totals: syntheticTotals() });

  assert.match(markup, /<section id="admin-overview" class="metric-grid admin-metrics" data-feature-key="admin-overview" data-feature-default-expanded="true" aria-label="Dashboard billing and collection monitoring">/);
  assert.match(markup, /id="admin-overview" class="metric-grid admin-metrics" data-feature-key="admin-overview" data-feature-default-expanded="true"/);
  assert.equal((markup.match(/<(?:article|a) class="metric metric--/g) ?? []).length, 6);
  assert.match(markup, /Total Billed · 2026-02/);
  assert.match(markup, /Collected · 2026-02/);
  assert.match(markup, /href="#admin-bills\?scope=all&amp;period=2026-02" aria-label="Total Billed,/);
  assert.match(markup, /href="#admin-receipts\?scope=received&amp;period=2026-02" aria-label="Collected,/);
  assert.match(markup, /data-dashboard-drilldown="billed"/);
  assert.match(markup, /data-dashboard-drilldown="collected"/);
  assert.match(markup, /Pending · 2026-02/);
  assert.match(markup, /href="#admin-bills\?scope=unpaid&amp;period=2026-02" aria-label="Pending,/);
  assert.match(markup, /data-dashboard-drilldown="unpaid"/);
  assert.match(markup, /Overdue outstanding balance · 2026-02 · as of local date 2026-02-15/);
  assert.match(markup, /2 distinct accounts/);
  assert.match(markup, /selected bill period; priced bills with a positive balance and a saved due date before today; missing due dates are excluded/);
  assert.match(markup, /Unpriced bills · 2026-02/);
  assert.match(markup, /Count only; no bill amount is recorded or treated as zero\./);
  assert.match(markup, /Active accounts without a bill snapshot · 2026-02/);
  assert.match(markup, /Active customer accounts with no bill snapshot in this selected month; count only\./);
  assert.match(markup, /12 actual receipts by received date; no credit/);
  assert.match(markup, /credit applied separately/);
  assert.match(markup, /2 priced bills; 1 unpriced bill snapshot excluded from billed amount/);
  assert.match(markup, new RegExp(formatMoney(1250000).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(markup, /aria-hidden="true"/);
  assert.match(markup, /href="#admin-bills\?scope=overdue&amp;period=2026-02" aria-label="Overdue outstanding balance/);
  assert.match(markup, /data-dashboard-drilldown="unpriced"/);
  assert.match(markup, /href="#customer-list\?scope=missing-snapshot&amp;period=2026-02" aria-label="Active accounts without a bill snapshot/);
  assert.match(markup, /View overdue bills/);
  assert.match(markup, /View all bills/);
  assert.match(markup, /View receipts/);
  assert.match(markup, /View unpaid bills/);
  assert.match(markup, /View unpriced bills/);
  assert.match(markup, /View matching active customers/);
  assert.doesNotMatch(markup, /metric__comparison/);
  assert.doesNotMatch(markup, /metric__sparkline/);
});

test('month-over-month KPI comparisons use prior values and suppress missing per-card baselines', () => {
  const current = syntheticTotals();
  const previous = syntheticTotals({ billedCents: 1000000, cashReceivedCents: 600000, outstandingCents: 550000, overdueCents: 250000 });
  const markup = renderDashboardMetrics({
    month: '2026-10', today: '2026-10-15', totals: current, previousTotals: previous,
  });

  assert.match(markup, /\+25% vs previous month/);
  assert.match(markup, /\+30% vs previous month/);
  assert.match(markup, /−7\.3% vs previous month/);
  assert.match(markup, /−10% vs previous month/);
  assert.equal((markup.match(/metric__comparison/g) ?? []).length, 4);
});

test('KPI mini-trends use exact recorded monthly points and hide when fewer than two months exist', () => {
  const points = [
    { fullLabel: 'September 2026', billedCents: 8000, collectedCents: 2000, pendingCents: 7000 },
    { fullLabel: 'October 2026', billedCents: 15000, collectedCents: 3000, pendingCents: 10000 },
  ];
  const withTrend = renderDashboardMetrics({
    month: '2026-10', today: '2026-10-15', totals: syntheticTotals(),
    trendSeries: { month: '2026-10', view: 'month', points },
  });
  assert.equal((withTrend.match(/class="metric__sparkline"/g) ?? []).length, 3);
  assert.match(withTrend, /Trend for Billed trend across 2 recorded months/);
  assert.match(withTrend, /September 2026 · Billed trend: Rs\s?80/);
  assert.match(withTrend, /October 2026 · Pending-balance trend: Rs\s?100/);
  assert.doesNotMatch(withTrend.slice(withTrend.indexOf('metric--overdue'), withTrend.indexOf('metric--unpriced')), /metric__sparkline/);

  const oneMonth = renderDashboardMetrics({
    month: '2026-10', today: '2026-10-15', totals: syntheticTotals(),
    trendSeries: { month: '2026-10', view: 'month', points: points.slice(1) },
  });
  assert.doesNotMatch(oneMonth, /metric__sparkline/);
});

test('Admin KPI renderer escapes dates and ignores private or unknown properties', () => {
  const markup = renderDashboardMetrics({
    month: '2026-02<img src=x>',
    today: '2026-02-15"<img src=x>',
    totals: syntheticTotals({
      phone: '03XXXXXXXXX',
      staff_notes: 'synthetic internal note',
      privateDetails: { address: 'synthetic private address' },
      customerNames: new Map([['synthetic-customer', 'Synthetic Name']]),
    }),
  });

  assert.match(markup, /Total Billed · 2026-02&lt;img src=x&gt;/);
  assert.match(markup, /2026-02-15&quot;&lt;img src=x&gt;/);
  assert.doesNotMatch(markup, /<img/);
  assert.doesNotMatch(markup, /03XXXXXXXXX|synthetic internal note|synthetic private address|Synthetic Name/);
});

test('collection cards update in English and Roman Urdu when the language preference changes', () => {
  const totals = syntheticTotals();
  const english = renderDashboardMetrics({ month: '2026-02', today: '2026-02-15', totals, t: (value) => translateUi(value, 'en') });
  const romanUrdu = renderDashboardMetrics({ month: '2026-02', today: '2026-02-15', totals, t: (value) => translateUi(value, 'ur-Latn') });

  assert.match(english, /Overdue outstanding balance/);
  assert.match(english, /Unpriced bills/);
  assert.match(english, /Active accounts without a bill snapshot/);
  assert.match(romanUrdu, /Muddat guzar chuka baqaya/);
  assert.match(romanUrdu, /Baghair price ke bills/);
  assert.match(romanUrdu, /Bill snapshot ke baghair active accounts/);
  assert.match(romanUrdu, /alag accounts/);
  assert.match(romanUrdu, /baghair price wala bill snapshot billed amount mein shamil nahin/);
  assert.match(romanUrdu, /chuna gaya bill period/);
  assert.match(romanUrdu, /2026-02-15/);
  assert.match(romanUrdu, /Overdue bills dekhein/);
  assert.match(romanUrdu, /Baqaya bills dekhein/);
  assert.match(romanUrdu, /Baghair price ke bills dekhein/);
  assert.match(romanUrdu, /Mutabiq active customers dekhein/);
  assert.match(romanUrdu, /Tamam bills dekhein/);
  assert.match(romanUrdu, /Receipts dekhein/);

  const oneReceipt = renderDashboardMetrics({
    month: '2026-02',
    today: '2026-02-15',
    totals: syntheticTotals({ pricedBillCount: 1, receiptCount: 1, overdueAccountCount: 1 }),
    t: (value) => translateUi(value, 'ur-Latn'),
  });
  assert.match(oneReceipt, /1 price wala bill/);
  assert.match(oneReceipt, /1 asal receipt wasooli ki tareekh ke mutabiq; credit shamil nahin/);
  assert.match(oneReceipt, /1 alag account/);
});

test('Admin metric tones and mobile breakpoints keep all cards readable on narrow screens', async () => {
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

  assert.match(styles, /^\.metric \{ display: grid; gap: 8px; min-height: 128px;/m);
  assert.match(styles, /^\.admin-metrics a\.metric:focus-visible/m);
  assert.match(styles, /^\.admin-metrics \.metric::before/m);
  for (const tone of ['billed', 'cash', 'outstanding', 'overdue', 'unpriced', 'missing-bill']) {
    assert.match(styles, new RegExp(`^\\.admin-metrics \\.metric--${tone}`, 'm'));
  }
  assert.match(styles, /^\.admin-metrics \.metric__sparkline polyline \{/m);
  assert.match(styles, /\.customer-fab-options \{[^}]*max-height: min\(68vh, 480px\);[^}]*overflow-y: auto;/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.admin-metrics \{ grid-template-columns: 1fr; \}/);
  assert.doesNotMatch(styles, /^\.metric::before/m);
  assert.doesNotMatch(styles, /^\.metric__(?:icon|label|top)\b/m);
});
