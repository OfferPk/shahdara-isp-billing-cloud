import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoCustomerMonthlyUsage, renderCustomerUsageDashboard } from '../src/customer-usage.js';

const fixedNow = new Date('2026-10-08T00:00:00.000Z');

test('mock PPPoE customers get a labeled 64.5 GB development sample and a rendered 100 GB progress meter', () => {
  const demo = buildDemoCustomerMonthlyUsage({ pppoe_username: 'shahdara_user_01' });
  assert.equal(demo.bytes, 64_500_000_000n);
  assert.equal(demo.source, 'demo');
  const html = renderCustomerUsageDashboard({
    customer: { pppoe_username: 'shahdara_user_01' },
    currentMonthUsageBytes: demo.bytes,
    monthlyUsageSource: demo.source,
    quotaPackage: demo.quotaPackage,
    now: fixedNow,
  });
  assert.match(html, /64\.5 GB/);
  assert.match(html, /Used: 64\.5 GB \/ Total: 100 GB \(35\.5 GB Remaining\)/);
  assert.match(html, /aria-valuenow="64\.5"/);
  assert.match(html, /Demo usage sample — not live RouterOS/);
  assert.doesNotMatch(html, /No usage snapshot is available yet/);
  assert.equal(buildDemoCustomerMonthlyUsage({ pppoe_username: 'real-customer-pppoe' }), null);
});

test('quota exhaustion shows an advisory badge and explicitly performs no router-side action', () => {
  const html = renderCustomerUsageDashboard({
    customer: { pppoe_username: 'subscriber-123' },
    quotaPackage: { quota_type: 'fup_capped', quota_limit_gb: 100, action_on_exhaust: 'suspend' },
    currentMonthUsageBytes: '105000000000',
    now: fixedNow,
  });
  assert.match(html, /Quota exceeded/);
  assert.match(html, /usage-fup__warning" role="status"/);
  assert.match(html, /This is an advisory warning only/);
  assert.match(html, /No automatic throttling, suspension, or disconnect is performed/);
});
