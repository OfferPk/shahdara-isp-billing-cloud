import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPppoeAdminHandler, createPppoeIngestHandler, pppoeUsageInternals } from '../supabase/functions/_shared/pppoe-usage.js';
import { formatUsageBytes, renderCustomerUsageCard, renderPppoeAdminUsageReport } from '../src/pppoe-usage.js';

const root = resolve(import.meta.dirname, '..');

function envFrom(values) { return { get: (name) => values[name] }; }
function fixturePayload() {
  return {
    snapshot_id: '123e4567-e89b-42d3-a456-426614174000',
    sampled_at: '2026-10-02T00:00:00Z',
    sessions: [{
      username: 'synthetic-user', session_id: 'session-1',
      session_key: '123e4567-e89b-42d3-a456-426614174001',
      uptime_seconds: 10, bytes_in: '300', bytes_out: '700',
    }],
  };
}

async function signedRequest({ payload = fixturePayload(), siteId = 'site-router-1', masterHex = 'ab'.repeat(32), signatureOverride, origin } = {}) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = '123e4567-e89b-42d3-a456-426614174002';
  const siteKey = await pppoeUsageInternals.deriveSiteKey(Buffer.from(masterHex, 'hex'), siteId);
  const signature = signatureOverride ?? await pppoeUsageInternals.hmacHex(siteKey, `${timestamp}\n${nonce}\n${rawBody}`);
  const headers = {
    'content-type': 'application/json', apikey: 'publishable-test-key',
    'x-usage-site': siteId, 'x-usage-timestamp': timestamp,
    'x-usage-nonce': nonce, 'x-usage-signature': signature,
  };
  if (origin) headers.origin = origin;
  return new Request('https://project.invalid/functions/v1/pppoe-usage-ingest', { method: 'POST', headers, body: rawBody });
}

function ingestEnv() {
  return envFrom({
    SUPABASE_URL: 'https://qkdsuvmlutkatcqoewkh.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key',
    SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key',
    PPPOE_USAGE_MASTER_KEY: 'ab'.repeat(32),
  });
}

test('decimal byte formatting treats 1 GB as 1,000,000,000 bytes', () => {
  assert.equal(formatUsageBytes(1_000_000_000), '1 GB');
  assert.equal(formatUsageBytes(1_500_000_000), '1.5 GB');
  assert.equal(formatUsageBytes(-1), '—');
});

test('customer usage card explains all rolling windows, Karachi quota, staleness, and informational-only semantics', () => {
  const markup = renderCustomerUsageCard({
    currentMonth: {
      used_bytes: 10_000_000_000, quota_bytes: 100_000_000_000, remaining_bytes: 90_000_000_000,
      speed_download_bps: 3_000_000, speed_upload_bps: 1_000_000,
      is_stale: true, last_collector_contact_at: '2026-10-02T00:00:00Z',
      coverage_since: '2026-10-02T00:00:00Z', coverage_incomplete: true, quarantined_source_count: 1,
    },
    windows: {
      last_1_hour: { used_bytes: 1, upload_bytes: 1, download_bytes: 0 },
      last_2_hours: { used_bytes: 2, upload_bytes: 1, download_bytes: 1 },
      last_24_hours: { used_bytes: 3, upload_bytes: 2, download_bytes: 1 },
      last_30_days: { used_bytes: 4, upload_bytes: 2, download_bytes: 2 },
    },
  });
  for (const label of ['Current billing month', 'Last 1 hour', 'Last 2 hours', 'Last 24 hours (rolling)', 'Last 30 days (rolling)']) assert.match(markup, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(markup, /Upload and download both count toward quota/);
  assert.match(markup, /does not change service speed or block access/);
  assert.match(markup, /Updates delayed or not yet confirmed/);
  assert.match(markup, /Coverage is incomplete/);
  assert.match(markup, /Coverage since/);
  assert.match(markup, /Usage collection needs review/);
  assert.match(markup, /90 GB/);
});

test('Admin dispute report matches customer aggregate values and reveals PPPoE identity only in the Admin view', () => {
  const month = {
    customer_id: 'customer-a', used_bytes: 10_000_000_000, quota_bytes: 100_000_000_000,
    remaining_bytes: 90_000_000_000, speed_download_bps: 5_000_000, speed_upload_bps: 1_000_000,
    is_stale: true, last_collector_contact_at: '2026-10-02T00:00:00Z',
    coverage_since: '2026-10-02T00:00:00Z', coverage_incomplete: true, quarantined_source_count: 1,
  };
  const view = {
    currentMonth: [month],
    last_1_hour: [{ ...month, used_bytes: 1_000_000 }],
    last_2_hours: [{ ...month, used_bytes: 2_000_000 }],
    last_24_hours: [{ ...month, used_bytes: 3_000_000 }],
    last_30_days: [{ ...month, used_bytes: 4_000_000 }],
  };
  const customerCard = renderCustomerUsageCard({ currentMonth: month, windows: Object.fromEntries(Object.entries(view).filter(([key]) => key !== 'currentMonth').map(([key, rows]) => [key, rows[0]])) });
  const adminTable = renderPppoeAdminUsageReport({
    customers: [{ id: 'customer-a', name: 'Synthetic Customer' }],
    mappings: [{ customer_id: 'customer-a', pppoe_username: 'synthetic-private-identity', speed_download_bps: 5_000_000, speed_upload_bps: 1_000_000 }],
    accounts: [{ customer_id: 'customer-a', site_id: 'site-router-1', pppoe_username: 'synthetic-private-account', quota_bytes: 100_000_000_000, speed_download_bps: 5_000_000, speed_upload_bps: 1_000_000, used_bytes: 10_000_000_000, upload_bytes: 4_000_000_000, download_bytes: 6_000_000_000, coverage_since: '2026-10-02T00:00:00Z', coverage_incomplete: true }],
    views: view,
  });
  for (const value of ['10 GB', '90 GB', '1 MB', '2 MB', '3 MB', '4 MB', 'Updates delayed or not yet confirmed', 'Coverage since', 'Usage collection needs review']) assert.ok(customerCard.includes(value), `Customer card should include ${value}`);
  for (const value of ['10 GB / 100 GB', 'Remaining: 90 GB', '1 MB', '2 MB', '3 MB', '4 MB', 'synthetic-private-identity', 'synthetic-private-account', 'Stale or incomplete', 'Account quota', '5 Mbps / 1 Mbps']) assert.ok(adminTable.includes(value), `Admin report should include ${value}`);
  assert.ok(!customerCard.includes('synthetic-private-identity'));
  assert.ok(!customerCard.includes('synthetic-private-account'));
  assert.match(adminTable, /Admin-only per-account usage/);
  assert.match(adminTable, /role="region" tabindex="0" aria-label="Admin account breakdown/);
  assert.match(adminTable, /<caption class="sr-only">/);
});

test('usage card coexists with the existing receipt and bill-history metrics', async () => {
  const main = await readFile(resolve(root, 'src/main.js'), 'utf8');
  assert.match(main, /Total receipts/);
  assert.match(main, /customer-billing/);
  assert.match(main, /customer-usage/);
  assert.match(main, /renderCustomerUsageCard/);
  assert.match(main, /renderCustomerBillingResults\(\)/);
});

test('ingest verifies a signed synthetic payload and delegates dedupe/mapping to the atomic server RPC', async () => {
  let rpcCall;
  const handler = createPppoeIngestHandler({
    env: ingestEnv(),
    createClient: () => ({ rpc: async (name, args) => { rpcCall = { name, args }; return { data: { accepted: true, duplicate: false, unmapped_sessions: 0 }, error: null }; } }),
  });
  const response = await handler(await signedRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true, duplicate: false, unmapped_sessions: 0 });
  assert.equal(rpcCall.name, 'process_pppoe_usage_snapshot');
  assert.equal(rpcCall.args.p_site_id, 'site-router-1');
  assert.equal(rpcCall.args.p_payload.sessions[0].username, 'synthetic-user');
  assert.equal(rpcCall.args.p_payload.sessions[0].bytes_out, '700');
  assert.match(rpcCall.args.p_body_sha256, /^[0-9a-f]{64}$/);
});

test('ingest rejects forged signatures, browser Origin calls, oversized session lists and altered counter shapes before RPC', async () => {
  let rpcCount = 0;
  const handler = createPppoeIngestHandler({ env: ingestEnv(), createClient: () => ({ rpc: async () => { rpcCount += 1; return { data: {}, error: null }; } }) });
  const forged = await handler(await signedRequest({ signatureOverride: '00'.repeat(32) }));
  assert.equal(forged.status, 401);
  const browser = await handler(await signedRequest({ origin: 'https://evil.example' }));
  assert.equal(browser.status, 403);
  const malformed = await handler(await signedRequest({ payload: { ...fixturePayload(), extra: 'unexpected' } }));
  assert.equal(malformed.status, 400);
  const malformedQuarantine = await handler(await signedRequest({ payload: { ...fixturePayload(), quarantined_batch_count: '2' } }));
  assert.equal(malformedQuarantine.status, 400);
  assert.equal(rpcCount, 0);
});

test('signed collector quarantine count is validated and forwarded as status metadata', async () => {
  let rpcPayload;
  const handler = createPppoeIngestHandler({
    env: ingestEnv(),
    createClient: () => ({ rpc: async (_name, args) => { rpcPayload = args.p_payload; return { data: { accepted: true }, error: null }; } }),
  });
  const response = await handler(await signedRequest({ payload: { ...fixturePayload(), quarantined_batch_count: 2 } }));
  assert.equal(response.status, 200);
  assert.equal(rpcPayload.quarantined_batch_count, 2);
});

test('Admin usage endpoint denies non-admin and foreign-origin requests before server-role queries', async () => {
  let serviceClientCreated = false;
  const handler = createPppoeAdminHandler({
    env: envFrom({ APP_ORIGIN: 'https://offerpk.github.io', SUPABASE_URL: 'https://qkdsuvmlutkatcqoewkh.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'server-only' }),
    createClient: (_url, key) => {
      if (key === 'server-only') serviceClientCreated = true;
      return {
        auth: { getUser: async () => ({ data: { user: { id: '10000000-0000-4000-8000-000000000001' } }, error: null }) },
        from: () => ({ select: () => ({ eq() { return this; }, maybeSingle: async () => ({ data: { role: 'customer' }, error: null }) }) }),
      };
    },
  });
  const unauthorized = await handler(new Request('https://project.invalid', { method: 'POST', headers: { origin: 'https://offerpk.github.io', authorization: 'Bearer test', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'list', organization_id: '20000000-0000-4000-8000-000000000001' }) }));
  assert.equal(unauthorized.status, 403);
  assert.equal(serviceClientCreated, false);
  const foreign = await handler(new Request('https://project.invalid', { method: 'POST', headers: { origin: 'https://evil.example', authorization: 'Bearer test' }, body: '{}' }));
  assert.equal(foreign.status, 403);
});

test('SQL migration keeps raw snapshot grants private and declares invoker-safe half-open rolling views', async () => {
  const migration = await readFile(resolve(root, 'supabase/migrations/20261002183000_pppoe_usage.sql'), 'utf8');
  const reviewFixes = await readFile(resolve(root, 'supabase/migrations/20261002190000_pppoe_usage_review_fixes.sql'), 'utf8');
  assert.match(migration, /create table if not exists public\.pppoe_usage_logs[\s\S]*?bytes_in bigint[\s\S]*?bytes_out bigint[\s\S]*?sampled_at timestamptz/i);
  assert.match(migration, /revoke all on table public\.pppoe_usage_sites[\s\S]*?public\.pppoe_usage_logs from public, anon, authenticated/i);
  assert.match(migration, /security_invoker = true/i);
  assert.match(migration, /p_window_start < p_window_end/i);
  assert.match(migration, /d\.sampled_at >= p_window_start and d\.sampled_at < p_window_end/i);
  assert.match(migration, /date_trunc\('month', now\(\) at time zone 'Asia\/Karachi'\)/i);
  assert.match(migration, /First observation is a cumulative-counter baseline[\s\S]*?v_delta_in := 0;[\s\S]*?v_delta_out := 0;/i);
  assert.match(reviewFixes, /create table public\.pppoe_usage_account_months/i);
  assert.match(reviewFixes, /sum\(am\.quota_bytes\)[\s\S]*?sum\(am\.speed_download_bps\)[\s\S]*?sum\(am\.speed_upload_bps\)/i);
  assert.match(reviewFixes, /coverage_since timestamptz[\s\S]*?coverage_incomplete boolean/i);
  assert.match(reviewFixes, /v_observed_at timestamptz := clock_timestamp\(\)/i);
  assert.match(reviewFixes, /coverage_since = coalesce\(am\.coverage_since, v_observed_at\)/i);
  assert.match(reviewFixes, /insert into public\.pppoe_usage_account_months[\s\S]*?from public\.pppoe_usage_mappings/i);
  assert.match(reviewFixes, /quarantined_source_count > 0/i);
  assert.match(reviewFixes, /create view public\.pppoe_usage_admin_account_month_current[\s\S]*?pppoe_username/i);
  assert.match(reviewFixes, /revoke all on table public\.pppoe_usage_admin_account_month_current from public, anon, authenticated/i);
  assert.match(reviewFixes, /grant select on table public\.pppoe_usage_admin_account_month_current to service_role/i);
  assert.match(reviewFixes, /alter table public\.pppoe_usage_account_months enable row level security/i);
  for (const view of ['last_1_hour', 'last_2_hours', 'last_24_hours', 'last_30_days', 'current_month']) assert.match(migration, new RegExp(`pppoe_usage_${view}`));
});

test('320px and 390px usage surfaces keep narrow layout and keyboard-scrollable Admin account tables', async () => {
  const styles = await readFile(resolve(root, 'src/styles.css'), 'utf8');
  const usage = await readFile(resolve(root, 'src/pppoe-usage.js'), 'utf8');
  assert.match(styles, /body \{[^}]*min-width: 320px/);
  assert.match(styles, /@media \(max-width: 600px\) \{\s+\.usage-month__top \{ grid-template-columns: 1fr; \}\s+\.usage-window-grid, \.pppoe-mapping-form, \.pppoe-mapping-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(styles, /\.pppoe-account-report \.table-wrap \{ max-width: 100%; overflow-x: auto/);
  for (const width of [320, 390]) assert.ok(width >= 320 && width <= 600, `${width}px uses the narrow usage layout`);
  assert.match(usage, /role="region" tabindex="0" aria-label="\$\{escapeHtml\(t\('Admin account breakdown/);
  assert.match(usage, /<caption class="sr-only">/);
});
