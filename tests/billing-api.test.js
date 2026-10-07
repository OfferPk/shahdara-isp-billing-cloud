import test from 'node:test';
import assert from 'node:assert/strict';
import { createPppoeApiHandler } from '../src/server/pppoe-api.js';

const organizationId = '10000000-0000-4000-8000-000000000001';
const packageId = 'package-10m';
const env = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'public-anon-key',
};

function createClientFactory({ role = 'admin', authenticated = true, rpcResult = null, rpcError = null } = {}) {
  const calls = [];
  const factory = () => ({
    auth: {
      async getUser(token) {
        calls.push({ type: 'getUser', token });
        return authenticated
          ? { data: { user: { id: 'user-1' } }, error: null }
          : { data: { user: null }, error: new Error('invalid token') };
      },
    },
    from(table) {
      calls.push({ type: 'from', table });
      return {
        select(columns) { calls.push({ type: 'select', columns }); return this; },
        eq(column, value) { calls.push({ type: 'eq', column, value }); return this; },
        async maybeSingle() { return { data: role ? { role } : null, error: null }; },
      };
    },
    async rpc(name, args) {
      calls.push({ type: 'rpc', name, args });
      return { data: rpcResult, error: rpcError };
    },
  });
  factory.calls = calls;
  return factory;
}

function request(path, { method = 'POST', token = 'valid-token', body, origin } = {}) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (origin) headers.set('origin', origin);
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('package pricing endpoint accepts an admin request and calls the scoped tariff RPC in cents', async () => {
  const clientFactory = createClientFactory({
    rpcResult: { packageId, name: '10M', monthlyFeeCents: 180000, effectiveOn: '2026-10-01', updatedCustomers: 3 },
  });
  const handler = createPppoeApiHandler({ env, createClient: clientFactory });
  const response = await handler(request(`/api/admin/billing/packages?organizationId=${organizationId}`, {
    body: { packageId, monthlyFeeCents: 180000 },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    package: { packageId, name: '10M', monthlyFeeCents: 180000, effectiveOn: '2026-10-01', updatedCustomers: 3 },
  });
  const rpc = clientFactory.calls.find((call) => call.type === 'rpc');
  assert.equal(rpc.name, 'set_package_monthly_fee');
  assert.deepEqual(rpc.args, {
    p_organization_id: organizationId,
    p_package_id: packageId,
    p_monthly_fee_cents: 180000,
  });
});

test('monthly invoice generation validates the selected month and exact dates before the RPC', async () => {
  const clientFactory = createClientFactory({
    rpcResult: { period: '2026-10', generated: 2, existing: 4, unpriced: 1, total: 6 },
  });
  const handler = createPppoeApiHandler({ env, createClient: clientFactory });
  const response = await handler(request(`/api/admin/billing/generate?organizationId=${organizationId}`, {
    body: { billingMonth: '2026-10', issueDate: '2026-10-07', dueDate: '2026-10-15' },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    period: '2026-10', generated: 2, existing: 4, unpriced: 1, total: 6,
  });
  const rpc = clientFactory.calls.find((call) => call.type === 'rpc');
  assert.equal(rpc.name, 'generate_monthly_invoices');
  assert.deepEqual(rpc.args, {
    p_organization_id: organizationId,
    p_period: '2026-10-01',
    p_issued_on: '2026-10-07',
    p_due_date: '2026-10-15',
  });
});

test('billing endpoints reject malformed inputs, cross-organization access, and non-admins', async () => {
  const handler = createPppoeApiHandler({ env, createClient: createClientFactory({ role: 'customer' }) });
  const badFee = await handler(request(`/api/admin/billing/packages?organizationId=${organizationId}`, {
    body: { packageId, monthlyFeeCents: 0 },
  }));
  assert.equal(badFee.status, 403, 'authorization is checked before processing a mutation');
  const forbidden = await handler(request(`/api/admin/billing/packages?organizationId=${organizationId}`, {
    token: '', body: { packageId, monthlyFeeCents: 180000 },
  }));
  assert.equal(forbidden.status, 401);

  const adminHandler = createPppoeApiHandler({ env, createClient: createClientFactory() });
  const invalidAmount = await adminHandler(request(`/api/admin/billing/packages?organizationId=${organizationId}`, {
    body: { packageId, monthlyFeeCents: 1800.5 },
  }));
  assert.equal(invalidAmount.status, 400);
  const invalidDate = await adminHandler(request(`/api/admin/billing/generate?organizationId=${organizationId}`, {
    body: { billingMonth: '2026-02', issueDate: '2026-02-30', dueDate: '2026-03-01' },
  }));
  assert.equal(invalidDate.status, 400);
  const wrongMethod = await adminHandler(request(`/api/admin/billing/generate?organizationId=${organizationId}`, { method: 'GET' }));
  assert.equal(wrongMethod.status, 405);
  const badOrganization = await adminHandler(request('/api/admin/billing/generate?organizationId=nope', {
    body: { billingMonth: '2026-10', issueDate: '2026-10-01', dueDate: '2026-10-15' },
  }));
  assert.equal(badOrganization.status, 400);
});

test('billing RPC failures expose generic billing copy, never raw database details', async () => {
  const clientFactory = createClientFactory({ rpcError: new Error('secret SQL detail: missing relation') });
  const handler = createPppoeApiHandler({ env, createClient: clientFactory });
  const response = await handler(request(`/api/admin/billing/packages?organizationId=${organizationId}`, {
    body: { packageId, monthlyFeeCents: 180000 },
  }));
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.match(payload.error, /Billing requests are temporarily unavailable/);
  assert.doesNotMatch(payload.error, /secret SQL detail|Subscriber discovery/);
});
