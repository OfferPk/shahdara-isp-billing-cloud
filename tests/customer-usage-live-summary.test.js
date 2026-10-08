import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCustomerUsageDashboard } from '../src/customer-usage.js';

const customer = { pppoe_username: 'synthetic-user' };

test('customer dashboard shows recorded bill status, amount and due date but never fabricates calendar-month usage', () => {
  const html = renderCustomerUsageDashboard({
    customer,
    currentMonthBillStatus: 'partial',
    currentMonthLabel: 'October 2026',
    currentMonthBillAmountLabel: 'Rs 1,500',
    currentMonthBillDueLabel: '15 Oct',
  });
  assert.match(html, /Current month consumed[^<]*· October 2026/);
  assert.match(html, /id="customer-current-month-consumed">Unavailable/);
  assert.match(html, /No trusted calendar-month traffic source is configured/);
  assert.match(html, /Current month bill[^<]*· October 2026/);
  assert.match(html, /id="customer-current-month-bill-status"[\s\S]*?Partially paid/);
  assert.match(html, /Bill amount: Rs 1,500/);
  assert.match(html, /Due: 15 Oct/);
});

test('monthly quota shows the configured cap but no progress bar until trusted monthly usage arrives', () => {
  const html = renderCustomerUsageDashboard({
    customer,
    quotaPackage: { package_name: '5 Mbps / 150 GB', quota_type: 'fup_capped', quota_limit_gb: 150 },
  });
  assert.match(html, /150 GB total/);
  assert.match(html, /Monthly usage is unavailable/);
  assert.doesNotMatch(html, /aria-label="Monthly FUP quota consumed"/);
});

test('live speed graph remains visible for linked PPPoE accounts but clearly stays pending without verified telemetry', () => {
  const linked = renderCustomerUsageDashboard({ customer });
  assert.match(linked, /id="customer-live-traffic-graph"/);
  assert.match(linked, /id="customer-live-traffic-status"[^>]*>Telemetry Pending/);
  assert.match(linked, /TX is customer download and RX is customer upload/);
  assert.match(linked, /sampled every 2 seconds/);
  const unlinked = renderCustomerUsageDashboard({ customer: {} });
  assert.doesNotMatch(unlinked, /customer-live-traffic-graph/);
  assert.match(unlinked, /Live speed is unavailable until a PPPoE username is linked/);
});
