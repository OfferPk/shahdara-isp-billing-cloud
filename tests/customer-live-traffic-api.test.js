import test from 'node:test';
import assert from 'node:assert/strict';
import { createPppoeApiHandler, pppoeApiRoutes, pppoeApiInternals } from '../src/server/pppoe-api.js';

const organizationId = '10000000-0000-4000-8000-000000000001';
const customerId = 'customer-safe-id-1';
const env = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'public-anon-key',
};

function makeClientFactory({
  authenticated = true,
  states = [{ state: 'active' }],
  contexts = [{ organization_id: organizationId, customer_id: customerId }],
  customer = { id: customerId, organization_id: organizationId, pppoe_username: 'subscriber_01' },
} = {}) {
  const calls = [];
  const factory = () => ({
    auth: {
      async getUser(token) {
        calls.push({ kind: 'getUser', token });
        return authenticated ? { data: { user: { id: 'auth-user-1' } }, error: null } : { data: { user: null }, error: new Error('invalid') };
      },
    },
    async rpc(name) {
      calls.push({ kind: 'rpc', name });
      if (name === 'my_customer_portal_password_state') return { data: states, error: null };
      if (name === 'my_customer_portal_contexts') return { data: contexts, error: null };
      return { data: null, error: new Error('unexpected RPC') };
    },
    from(table) {
      calls.push({ kind: 'from', table });
      const query = {
        select(columns) { calls.push({ kind: 'select', columns }); return query; },
        eq(column, value) { calls.push({ kind: 'eq', column, value }); return query; },
        async maybeSingle() { calls.push({ kind: 'maybeSingle' }); return { data: customer, error: null }; },
      };
      return query;
    },
  });
  factory.calls = calls;
  return factory;
}

function makeRequest(path = pppoeApiRoutes.customerLiveTraffic, token = 'customer-token') {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return new Request(`http://localhost${path}`, { headers });
}

function makeAdapter() {
  const calls = [];
  return {
    calls,
    async getLiveTrafficForUsername(username) {
      calls.push(username);
      return { downloadBitsPerSecond: 4_000_000, uploadBitsPerSecond: 900_000, sampledAt: '2026-10-08T00:00:00.000Z', source: 'routeros' };
    },
  };
}

test('customer telemetry resolves only the signed-in user’s exact customer in the same organization', async () => {
  const clientFactory = makeClientFactory();
  const adapter = makeAdapter();
  const handler = createPppoeApiHandler({ env, createClient: clientFactory, adapter, now: () => 10_000 });
  const response = await handler(makeRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    downloadBitsPerSecond: 4_000_000,
    uploadBitsPerSecond: 900_000,
    sampledAt: '2026-10-08T00:00:00.000Z',
    source: 'routeros',
  });
  assert.deepEqual(adapter.calls, ['subscriber_01']);
  assert.ok(clientFactory.calls.some((call) => call.kind === 'getUser' && call.token === 'customer-token'));
  assert.ok(clientFactory.calls.some((call) => call.kind === 'eq' && call.column === 'organization_id' && call.value === organizationId));
  assert.ok(clientFactory.calls.some((call) => call.kind === 'eq' && call.column === 'id' && call.value === customerId));
  assert.ok(clientFactory.calls.some((call) => call.kind === 'rpc' && call.name === 'my_customer_portal_contexts'));
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
});

test('route rejects missing auth, arbitrary customer IDs, ambiguous contexts, and inactive credentials before router access', async () => {
  const adapter = makeAdapter();
  const factory = makeClientFactory();
  const handler = createPppoeApiHandler({ env, createClient: factory, adapter, now: () => 10_000 });
  assert.equal((await handler(makeRequest(pppoeApiRoutes.customerLiveTraffic, ''))).status, 401);
  assert.equal((await handler(makeRequest(`${pppoeApiRoutes.customerLiveTraffic}?customerId=other`))).status, 400);
  assert.equal((await createPppoeApiHandler({ env, createClient: makeClientFactory({ contexts: [] }), adapter, now: () => 10_000 })(makeRequest())).status, 403);
  assert.equal((await createPppoeApiHandler({ env, createClient: makeClientFactory({ states: [{ state: 'change_required' }] }), adapter, now: () => 10_000 })(makeRequest())).status, 403);
  assert.deepEqual(adapter.calls, []);
});

test('customer query is constrained by both context organization and customer ID', async () => {
  const otherOrganization = '20000000-0000-4000-8000-000000000002';
  const adapter = makeAdapter();
  const handler = createPppoeApiHandler({
    env,
    createClient: makeClientFactory({ customer: { id: customerId, organization_id: otherOrganization, pppoe_username: 'wrong-customer' } }),
    adapter,
    now: () => 10_000,
  });
  assert.equal((await handler(makeRequest())).status, 403);
  assert.deepEqual(adapter.calls, []);
});

test('a customer cannot poll more than once every two seconds through one handler', async () => {
  let now = 10_000;
  const adapter = makeAdapter();
  const handler = createPppoeApiHandler({ env, createClient: makeClientFactory(), adapter, now: () => now });
  assert.equal((await handler(makeRequest())).status, 200);
  now += 1_999;
  const limited = await handler(makeRequest());
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  now += 1;
  assert.equal((await handler(makeRequest())).status, 200);
  assert.deepEqual(adapter.calls, ['subscriber_01', 'subscriber_01']);
});

test('in-memory router limiter caps ten requests per second and four concurrent polls', () => {
  let now = 0;
  const limiter = pppoeApiInternals.createTrafficRateLimiter({ now: () => now, minUserIntervalMs: 0, maxRequestsPerSecond: 10, maxConcurrent: 4 });
  const permits = Array.from({ length: 4 }, (_, index) => limiter.acquire(`user-${index}`));
  assert.ok(permits.every((permit) => permit.allowed));
  assert.equal(limiter.acquire('fifth-in-flight').allowed, false);
  permits.forEach((permit) => permit.release());
  for (let index = 0; index < 6; index += 1) {
    const permit = limiter.acquire(`second-${index}`);
    assert.equal(permit.allowed, true);
    permit.release();
  }
  assert.equal(limiter.acquire('eleventh').allowed, false);
  now = 1_000;
  assert.equal(limiter.acquire('next-second').allowed, true);
});
