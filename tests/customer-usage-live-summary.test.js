import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCustomerUsageDashboard } from '../src/customer-usage.js';

const customer = { pppoe_username: 'synthetic-user' };

test('customer dashboard shows bill status but never fabricates calendar-month usage from cumulative counters', () => {
  const html = renderCustomerUsageDashboard({
    customer,
    currentMonthBillStatus: 'partial',
    currentMonthLabel: 'October 2026',
  });
  assert.match(html, /Current month consumed[^<]*· October 2026/);
  assert.match(html, /id="customer-current-month-consumed">Unavailable/);
  assert.match(html, /No trusted calendar-month traffic source is configured/);
  assert.match(html, /Current month bill status[^<]*· October 2026/);
  assert.match(html, /id="customer-current-month-bill-status">Partially paid/);
});

test('live speed canvas is shown only when a PPPoE username is linked, with RouterOS direction explained', () => {
  const linked = renderCustomerUsageDashboard({ customer });
  assert.match(linked, /id="customer-live-traffic-graph"/);
  assert.match(linked, /TX is customer download and RX is customer upload/);
  assert.match(linked, /sampled every 2 seconds/);
  const unlinked = renderCustomerUsageDashboard({ customer: {} });
  assert.doesNotMatch(unlinked, /customer-live-traffic-graph/);
  assert.match(unlinked, /Live speed is unavailable until a PPPoE username is linked/);
});
