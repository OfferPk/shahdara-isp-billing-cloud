import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRelativeUsageSync,
  formatUsageBytes,
  getServiceExpiryStatus,
  getUsageFreshness,
  renderCustomerUsageDashboard,
  renderCustomerUsageSkeleton,
  renderServiceExpiryNotice,
  summarizeCustomerUsage,
} from '../src/customer-usage.js';

const fixture = Object.freeze({
  username: 'synthetic-pppoe-a',
  total_quota_bytes: '10000000000',
  bytes_in: '5000000000',
  bytes_out: '2000000000',
  is_online: true,
  last_ip: '192.0.2.44',
  last_synced_at: '2026-10-03T10:00:00.000Z',
});
const customer = Object.freeze({ pppoe_username: 'synthetic-pppoe-a' });
const fixedNow = new Date('2026-10-03T12:00:00.000Z');

test('usage math maps bytes_in to download and bytes_out to upload and computes total and remainder', () => {
  const summary = summarizeCustomerUsage(fixture);
  assert.equal(summary.downloadBytes, 5000000000n);
  assert.equal(summary.uploadBytes, 2000000000n);
  assert.equal(summary.totalUsedBytes, 7000000000n);
  assert.equal(summary.quotaBytes, 10000000000n);
  assert.equal(summary.remainingBytes, 3000000000n);
  assert.equal(summary.consumedPercent, 70);
  assert.equal(summary.remainingPercent, 30);
  assert.equal(summary.quotaTone, 'good');
});

test('byte formatting uses readable decimal KB, MB, and GB units with bounded precision', () => {
  assert.equal(formatUsageBytes('0'), '0 B');
  assert.equal(formatUsageBytes('950'), '950 B');
  assert.equal(formatUsageBytes('1500'), '1.5 KB');
  assert.equal(formatUsageBytes('5000000'), '5 MB');
  assert.equal(formatUsageBytes('7000000000'), '7 GB');
  assert.equal(formatUsageBytes('-1'), '—');
  assert.equal(formatUsageBytes('not-bytes'), '—');
});

test('zero quota renders Unlimited Package and retains aggregate traffic counters', () => {
  const html = renderCustomerUsageDashboard({ customer, usageRows: [{ ...fixture, total_quota_bytes: '0' }], now: fixedNow });
  const summary = summarizeCustomerUsage({ ...fixture, total_quota_bytes: '0' });
  assert.equal(summary.unlimited, true);
  assert.equal(summary.remainingBytes, null);
  assert.equal(summary.remainingPercent, null);
  assert.equal(summary.totalUsedBytes, 7000000000n);
  assert.match(html, /Unlimited Package/);
  assert.match(html, /0 bytes means unlimited usage/);
  assert.match(html, /Download[\s\S]*5 GB/);
  assert.match(html, /Upload[\s\S]*2 GB/);
  assert.match(html, /Total used[\s\S]*7 GB/);
  assert.doesNotMatch(html, /role="progressbar"/);
});

test('quota meter changes color at 75 and 90 percent consumed thresholds', () => {
  const getMeterClass = (usedBytes) => {
    const html = renderCustomerUsageDashboard({
      customer,
      usageRows: [{ ...fixture, total_quota_bytes: '1000', bytes_in: String(usedBytes), bytes_out: '0' }],
      now: fixedNow,
    });
    return html.match(/usage-progress usage-progress--([a-z]+)/)?.[1];
  };
  assert.equal(getMeterClass(749), 'good', 'below 75% is green');
  assert.equal(getMeterClass(750), 'warning', '75% begins the orange warning');
  assert.equal(getMeterClass(900), 'warning', '90% remains orange');
  assert.equal(getMeterClass(901), 'critical', 'above 90% is red');
  assert.equal(getMeterClass(1000), 'critical');
});

test('FUP package without trusted calendar-month usage shows its limit but no invented progress bar', () => {
  const html = renderCustomerUsageDashboard({
    customer,
    quotaPackage: { package_name: '3 Mbps / 100 GB', quota_type: 'fup_capped', quota_limit_gb: 100 },
    now: fixedNow,
  });
  assert.match(html, /FUP quota/);
  assert.match(html, /100 GB total/);
  assert.match(html, /Monthly usage is unavailable/);
  assert.match(html, /No quota percentage is shown until a trusted monthly traffic source is configured/);
  assert.doesNotMatch(html, /aria-label="Monthly FUP quota consumed"/);
});

test('FUP progress uses trusted monthly usage, shows used and remaining GB, and follows green/orange/red thresholds', () => {
  const renderTone = (used) => renderCustomerUsageDashboard({
    customer,
    quotaPackage: { package_name: '5 Mbps / 100 GB', quota_type: 'fup_capped', quota_limit_gb: 100 },
    currentMonthUsageBytes: String(used * 1_000_000_000),
    monthlyFeeLabel: 'Rs. 1,000',
    now: fixedNow,
  });
  const green = renderTone(74);
  const exactlySeventyFive = renderTone(75);
  const orange = renderTone(80);
  const exactlyNinety = renderTone(90);
  const red = renderTone(91);
  assert.match(green, /usage-progress usage-progress--good/);
  assert.match(exactlySeventyFive, /usage-progress usage-progress--warning/);
  assert.match(orange, /usage-progress usage-progress--warning/);
  assert.match(exactlyNinety, /usage-progress usage-progress--warning/);
  assert.match(red, /usage-progress usage-progress--critical/);
  assert.match(green, /Used: 74 GB \/ Total: 100 GB \(26 GB Remaining\)/);
  assert.match(green, /customer-fixed-monthly-bill[\s\S]*Rs\. 1,000/);
});

test('usage above quota reports zero remaining and a bounded accessible meter', () => {
  const overQuota = { ...fixture, total_quota_bytes: '1000', bytes_in: '1200', bytes_out: '100' };
  const summary = summarizeCustomerUsage(overQuota);
  assert.equal(summary.remainingBytes, 0n);
  assert.equal(summary.remainingPercent, 0);
  assert.equal(summary.overQuotaBytes, 300n);
  assert.equal(summary.quotaTone, 'critical');
  const html = renderCustomerUsageDashboard({ customer, usageRows: [overQuota], now: fixedNow });
  assert.match(html, /aria-valuenow="100"/);
  assert.match(html, /Usage is over quota by/);
});

test('relative sync time stays readable in English and Roman Urdu without Urdu script', () => {
  const syncedAt = '2026-10-03T10:00:00.000Z';
  assert.equal(formatRelativeUsageSync(syncedAt, fixedNow, 'en-PK'), '2 hours ago');
  const roman = formatRelativeUsageSync(syncedAt, fixedNow, 'ur-Latn-PK');
  assert.equal(roman, '2 ghantay pehle');
  assert.doesNotMatch(roman, /[\u0600-\u06FF]/);
  const html = renderCustomerUsageDashboard({ customer, usageRows: [fixture], now: fixedNow, locale: 'en-PK' });
  assert.match(html, /Last synced:<\/span> <strong>2 hours ago/);
});

test('freshness distinguishes recent, stale, missing, invalid, and implausibly future timestamps', () => {
  assert.equal(getUsageFreshness('2026-10-03T10:00:00.000Z', fixedNow).state, 'recent');
  assert.equal(getUsageFreshness('2026-10-01T10:00:00.000Z', fixedNow).state, 'stale');
  assert.equal(getUsageFreshness('', fixedNow).state, 'unknown');
  assert.equal(getUsageFreshness('not-a-date', fixedNow).state, 'unknown');
  assert.equal(getUsageFreshness('2026-10-04T10:00:00.000Z', fixedNow).state, 'unknown');
  assert.equal(summarizeCustomerUsage({ ...fixture, bytes_in: 'not-bytes' }), null);
});

test('expiry conditions distinguish no source, upcoming renewal, the three-day warning, and expired state', () => {
  assert.equal(getServiceExpiryStatus(null, fixedNow).state, 'unavailable');
  assert.deepEqual(
    { state: getServiceExpiryStatus('2026-10-10', fixedNow).state, days: getServiceExpiryStatus('2026-10-10', fixedNow).daysRemaining },
    { state: 'upcoming', days: 7 },
  );
  assert.deepEqual(
    { state: getServiceExpiryStatus('2026-10-06', fixedNow).state, days: getServiceExpiryStatus('2026-10-06', fixedNow).daysRemaining },
    { state: 'warning', days: 3 },
  );
  assert.deepEqual(
    { state: getServiceExpiryStatus('2026-10-04', fixedNow).state, days: getServiceExpiryStatus('2026-10-04', fixedNow).daysRemaining },
    { state: 'warning', days: 1 },
  );
  assert.deepEqual(
    { state: getServiceExpiryStatus('2026-10-03', fixedNow).state, days: getServiceExpiryStatus('2026-10-03', fixedNow).daysRemaining },
    { state: 'warning', days: 0 },
  );
  assert.deepEqual(
    { state: getServiceExpiryStatus('2026-10-02', fixedNow).state, days: getServiceExpiryStatus('2026-10-02', fixedNow).daysRemaining },
    { state: 'expired', days: -1 },
  );
  assert.equal(getServiceExpiryStatus('not-a-date', fixedNow).state, 'unknown');
});

test('optional expiry UI renders upcoming, warning, and expired states from synthetic dates only', () => {
  const upcoming = renderServiceExpiryNotice({ expiryDate: '2026-10-10', now: fixedNow });
  const warning = renderServiceExpiryNotice({ expiryDate: '2026-10-06', now: fixedNow });
  const expired = renderServiceExpiryNotice({ expiryDate: '2026-10-02', now: fixedNow });
  assert.match(upcoming, /Upcoming renewal/);
  assert.match(upcoming, /Renewal in 7 days/);
  assert.match(warning, /usage-expiry--warning/);
  assert.match(warning, /role="alert"/);
  assert.match(warning, /Renewal is due in 3 days/);
  assert.match(expired, /usage-expiry--expired/);
  assert.match(expired, /Service expired 1 day ago/);
  assert.match(expired, /role="alert"/);
});

test('dashboard shows online state, relative freshness, cumulative-only disclaimer, and omits IP data', () => {
  const otherAccount = { ...fixture, username: 'synthetic-pppoe-b', bytes_in: '999999999999' };
  const html = renderCustomerUsageDashboard({ customer, usageRows: [otherAccount, fixture], now: fixedNow });
  const offlineHtml = renderCustomerUsageDashboard({ customer, usageRows: [{ ...fixture, is_online: false }], now: fixedNow });
  assert.match(html, /Online/);
  assert.match(offlineHtml, /Offline/);
  assert.match(html, /Last synced/);
  assert.match(html, /Cumulative counters only/);
  assert.doesNotMatch(html, /192\.0\.2\.44|last_ip|synthetic-pppoe-[ab]/);
  assert.match(html, /7 GB/);
});

test('stale snapshots are visibly called out without inventing a usage period', () => {
  const html = renderCustomerUsageDashboard({
    customer,
    usageRows: [{ ...fixture, last_synced_at: '2026-10-01T10:00:00.000Z' }],
    now: fixedNow,
  });
  assert.match(html, /usage-sync--stale/);
  assert.match(html, /over 24 hours old/);
  assert.doesNotMatch(html, /calendar month|rolling 30|this month/i);
});

test('live expiry stays unset and never substitutes a bill due date', () => {
  const html = renderCustomerUsageDashboard({ customer, usageRows: [fixture], now: fixedNow, expiryDate: null });
  const expiryHtml = html.match(/<aside id="customer-expiry"[\s\S]*?<\/aside>/)?.[0] ?? '';
  assert.match(expiryHtml, /Expiry date not recorded/);
  assert.match(expiryHtml, /A bill due date is separate and is not used as service expiry/);
  assert.match(expiryHtml, /Expiry alerts are unavailable until an actual service-expiry date is recorded/);
  assert.doesNotMatch(expiryHtml, /due_date|2026-10-\d\d/);
});

test('unlinked, empty, invalid, and fetch-error states remain distinct and customer-readable', () => {
  assert.match(renderCustomerUsageDashboard({ customer: {}, now: fixedNow }), /not linked to this customer profile/);
  assert.match(renderCustomerUsageDashboard({ customer, usageRows: [], now: fixedNow }), /No usage snapshot is available yet/);
  assert.match(renderCustomerUsageDashboard({ customer, usageRows: [{ ...fixture, bytes_in: 'invalid' }], now: fixedNow }), /Usage values could not be read/);
  assert.match(renderCustomerUsageDashboard({ customer, usageRows: [fixture], error: true, now: fixedNow }), /could not be loaded/);
});

test('loading state includes non-interactive usage and expiry skeleton surfaces', () => {
  const html = renderCustomerUsageSkeleton();
  assert.match(html, /usage-skeleton/);
  assert.match(html, /usage-skeleton__expiry/);
  assert.match(html, /aria-hidden="true"/);
});
