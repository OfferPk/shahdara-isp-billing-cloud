import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDashboardDrilldown, parseDashboardDrilldownHash } from '../src/dashboard-drilldown.js';

test('collection cards map to the correct scoped destination and selected billing period', () => {
  const expected = [
    ['billed', 'admin-bills', 'all'],
    ['collected', 'admin-receipts', 'received'],
    ['unpaid', 'admin-bills', 'unpaid'],
    ['paid', 'admin-bills', 'paid'],
    ['pending', 'admin-bills', 'pending'],
    ['overdue', 'admin-bills', 'overdue'],
    ['unpriced', 'admin-bills', 'unpriced'],
    ['missing-snapshot', 'customer-list', 'missing-snapshot'],
  ];

  for (const [card, target, scope] of expected) {
    const route = createDashboardDrilldown(card, '2026-02');
    assert.deepEqual(route, {
      card,
      target,
      scope,
      period: '2026-02',
      hash: `#${target}?scope=${scope}&period=2026-02`,
    });
    assert.deepEqual(parseDashboardDrilldownHash(route.hash), route);
  }
});

test('Admin receipt routes apply selected-month filters and provide clear/focus destinations', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const apply = main.slice(main.indexOf('function applyDashboardDrilldown'), main.indexOf('function bindDashboardDrilldowns'));
  const receiptResults = main.slice(main.indexOf('function updateAdminReceiptResults'), main.indexOf('function openReceiptFormForBill'));
  const focus = main.slice(main.indexOf('function focusDashboardDrilldown'), main.indexOf('function applyDashboardDrilldown'));
  const clear = main.slice(main.indexOf('function clearDashboardDrilldown'), main.indexOf('function updateAdminBillResults'));

  assert.match(apply, /pageState\.receiptSearch = ''/);
  assert.match(apply, /updateAdminReceiptResults\(\)/);
  assert.match(receiptResults, /filterAdminReceiptsByPeriod\(allReceipts, drilldown\?\.period \?\? ''\)/);
  assert.match(receiptResults, /No actual receipts were recorded during \{period\}/);
  assert.match(receiptResults, /data-target="admin-receipts"/);
  assert.match(focus, /route\.target === 'admin-receipts' \? 'admin-receipts'/);
  assert.match(focus, /'admin-receipts-title'/);
  assert.match(clear, /target === 'admin-receipts' \? 'admin-receipts'/);
});

test('invalid periods, mismatched targets, duplicate parameters, and unknown filters cannot create a drill-down', () => {
  assert.equal(createDashboardDrilldown('overdue', '2026-13'), null);
  assert.equal(createDashboardDrilldown('unknown', '2026-02'), null);
  assert.equal(parseDashboardDrilldownHash('#admin-bills?scope=missing-snapshot&period=2026-02'), null);
  assert.equal(parseDashboardDrilldownHash('#admin-bills?scope=overdue&period=2026-02&period=2026-03'), null);
  assert.equal(parseDashboardDrilldownHash('#admin-receipts?scope=all&period=2026-02'), null);
  assert.equal(parseDashboardDrilldownHash('#admin-bills?scope=received&period=2026-02'), null);
});
