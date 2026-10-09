import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCustomerPortalDataHandler } from '../supabase/functions/customer-portal-data/handler.js';
import { createCustomerPortalLogoutHandler } from '../supabase/functions/customer-portal-logout/handler.js';
import {
  CUSTOMER_SUPPORT_PHONE,
  CUSTOMER_SUPPORT_WHATSAPP_URL,
  customerContextFromDashboard,
  customerPortalRowsFromDashboard,
  fetchCustomerPortalDashboard,
} from '../src/customer-bff-client.js';

const origin = 'https://offerpk.github.io';
const token = 'a'.repeat(64);
const organizationId = '10000000-0000-4000-8000-000000000001';
const customerId = 'customer-safe-id-1';
const dashboard = {
  status: 'ok',
  organization_id: organizationId,
  organization_name: 'Shahdara Fiber Net',
  customer: { id: customerId, customer_number: 'SF-0001', name: 'Synthetic Customer', plan_name: '5 Mbps / 150 GB', monthly_fee_cents: 150000, service_status: 'active', has_pppoe_mapping: true, pppoe_username: 'raja-arif', auth_email_alias: 'internal-alias' },
  quota: { package_name: '5 Mbps / 150 GB', quota_type: 'fup_capped', quota_limit_gb: 150 },
  monthly_usage: null,
  bills: [{ id: 'bill-1', customer_id: customerId, period: '2026-10-01', amount_due_cents: 150000, due_date: '2026-10-15' }],
  receipts: [],
  allocations: [],
  incidents: [],
  login_username: 'raja-arif',
  user_id: 'internal-auth-user-id',
  token_hash: 'internal-session-hash',
};
const safeDashboard = {
  status: 'ok',
  organization_id: organizationId,
  organization_name: 'Shahdara Fiber Net',
  customer: {
    id: customerId, customer_number: 'SF-0001', name: 'Synthetic Customer',
    plan_name: '5 Mbps / 150 GB', monthly_fee_cents: 150000,
    service_status: 'active', has_pppoe_mapping: true,
  },
  quota: dashboard.quota,
  monthly_usage: null,
  bills: dashboard.bills,
  receipts: [],
  allocations: [],
  incidents: [],
};

function env() {
  const values = new Map([
    ['APP_ORIGIN', origin],
    ['SUPABASE_URL', 'https://synthetic-project.supabase.co'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'server-only-test-key'],
  ]);
  return { get: (key) => values.get(key) ?? null };
}

function makeRequest(path, { method = 'POST', requestOrigin = origin, authorization = `Bearer ${token}` } = {}) {
  const headers = {};
  if (requestOrigin) headers.origin = requestOrigin;
  if (authorization) headers.authorization = authorization;
  headers['content-type'] = 'application/json';
  return new Request(`https://synthetic-project.supabase.co/functions/v1/${path}`, {
    method, headers, body: method === 'OPTIONS' ? undefined : '{}',
  });
}

function clientFactory({ result = dashboard, error = null } = {}) {
  const calls = [];
  const factory = (url, key, options) => {
    calls.push({ url, key, options });
    return {
      async rpc(name, args) { calls.push({ name, args }); return { data: result, error }; },
    };
  };
  factory.calls = calls;
  return factory;
}

test('customer portal data endpoint accepts only an opaque token and sends only its SHA-256 hash to the service RPC', async () => {
  const createClient = clientFactory();
  const handler = createCustomerPortalDataHandler({ env: env(), createClient });
  const response = await handler(makeRequest('customer-portal-data'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  const responseBody = await response.json();
  assert.deepEqual(responseBody, { dashboard: safeDashboard });
  assert.doesNotMatch(JSON.stringify(responseBody), /raja-arif|internal-alias|internal-auth-user-id|internal-session-hash/);
  const rpc = createClient.calls.find((call) => call.name === 'read_customer_portal_bff_dashboard');
  const expectedHash = createHash('sha256').update(token).digest('hex');
  assert.deepEqual(rpc.args, { p_token_hash: expectedHash });
  assert.notEqual(rpc.args.p_token_hash, token);
  assert.equal(createClient.calls[0].key, 'server-only-test-key');
});

test('customer portal data endpoint rejects bad origin/token and treats expired or revoked tokens as unauthorized', async () => {
  const createClient = clientFactory({ result: { status: 'unauthorized' } });
  const handler = createCustomerPortalDataHandler({ env: env(), createClient });
  assert.equal((await handler(makeRequest('customer-portal-data', { requestOrigin: 'https://evil.example' }))).status, 403);
  assert.equal((await handler(makeRequest('customer-portal-data', { authorization: 'Bearer not-a-token' }))).status, 401);
  const expired = await handler(makeRequest('customer-portal-data'));
  assert.equal(expired.status, 401);
  assert.deepEqual(await expired.json(), { error: 'Customer portal session is invalid or expired.' });
});

test('customer portal data endpoint fails closed when server database access fails', async () => {
  const createClient = clientFactory({ result: null, error: new Error('database unavailable') });
  const handler = createCustomerPortalDataHandler({ env: env(), createClient });
  const response = await handler(makeRequest('customer-portal-data'));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Customer portal data is temporarily unavailable.' });
});

test('logout revokes a token hash server-side and returns no Auth identifiers', async () => {
  const calls = [];
  const createClient = () => ({ async rpc(name, args) { calls.push({ name, args }); return { data: { status: 'revoked' }, error: null }; } });
  const handler = createCustomerPortalLogoutHandler({ env: env(), createClient });
  const response = await handler(makeRequest('customer-portal-logout'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(calls, [{
    name: 'revoke_customer_portal_bff_session',
    args: { p_token_hash: createHash('sha256').update(token).digest('hex') },
  }]);
});

test('dashboard mapper provides customer-scoped rows without PPPoE/Auth identifiers or private address', () => {
  const context = customerContextFromDashboard(dashboard);
  const rows = customerPortalRowsFromDashboard(dashboard, { expectedContext: context });
  assert.equal(context.kind, 'customer');
  assert.equal(context.customerId, customerId);
  assert.equal(rows.customers[0].customer_number, 'SF-0001');
  assert.equal(rows.customers[0].service_address, '');
  assert.equal(rows.customers[0].has_pppoe_mapping, true);
  assert.equal(rows.pppoeMappingAvailable, true);
  assert.equal(Object.hasOwn(rows.customers[0], 'pppoe_username'), false);
  assert.equal(Object.hasOwn(rows.customers[0], 'auth_email_alias'), false);
  assert.equal(rows.bills[0].amount_due_cents, 150000);
  assert.equal(rows.bills[0].due_date, '2026-10-15');
  assert.deepEqual(rows.customerMonthlyBandwidthUsage, []);
  assert.equal(rows.customerQuotaPackage.quota_limit_gb, 150);
  assert.equal(rows.branding.support_phone, CUSTOMER_SUPPORT_PHONE);
  assert.equal(CUSTOMER_SUPPORT_WHATSAPP_URL, 'https://wa.me/923155669955');
  assert.throws(() => customerPortalRowsFromDashboard(dashboard, {
    expectedContext: { ...context, customerId: 'another-customer' },
  }), /did not match/);
});

test('customer dashboard client sends no token to storage and rejects Auth-session-shaped responses', async () => {
  const calls = [];
  const functions = { async invoke(...args) { calls.push(args); return { data: { dashboard }, error: null }; } };
  await fetchCustomerPortalDashboard(functions, token);
  assert.deepEqual(calls[0], ['customer-portal-data', {
    body: {}, headers: { Authorization: `Bearer ${token}` },
  }]);
  const privateDashboard = { ...dashboard, customer: { ...dashboard.customer, service_address: 'private address' } };
  assert.equal(customerPortalRowsFromDashboard(privateDashboard).customers[0].service_address, '');
});
