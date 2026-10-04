import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardDrilldown, parseDashboardDrilldownHash } from '../src/dashboard-drilldown.js';

test('collection cards map to the correct scoped destination and selected billing period', () => {
  const expected = [
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

test('invalid periods, mismatched targets, duplicate parameters, and unknown filters cannot create a drill-down', () => {
  assert.equal(createDashboardDrilldown('overdue', '2026-13'), null);
  assert.equal(createDashboardDrilldown('unknown', '2026-02'), null);
  assert.equal(parseDashboardDrilldownHash('#admin-bills?scope=missing-snapshot&period=2026-02'), null);
  assert.equal(parseDashboardDrilldownHash('#admin-bills?scope=overdue&period=2026-02&period=2026-03'), null);
  assert.equal(parseDashboardDrilldownHash('#admin-bills?scope=all&period=2026-02'), null);
});
