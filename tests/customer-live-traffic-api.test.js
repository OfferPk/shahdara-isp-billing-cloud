import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPppoeApiHandler, pppoeApiRoutes, pppoeApiInternals } from '../src/server/pppoe-api.js';

const organizationId = '10000000-0000-4000-8000-000000000001';
const customerId = 'customer-safe-id-1';
const userId = '40000000-0000-4000-8000-000000000004';
const token = 'a'.repeat(64);
const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
  ROUTER_DRIVER: 'mikrotik',
};

function makeClientFactory({ resolution = {
  status: 'ok', user_id: userId, organization_id: organizationId,
  customer_id: customerId, pppoe_username: 'subscriber_01',
}, error = null } = {}) {
  const calls = [];
  const factory = (url, key, options) => {
    calls.push({ kind: 'client', url, key, options });
    return {
      async rpc(name, args) {
        calls.push({ kind: 'rpc', name, args });
        if (name === 'resolve_customer_portal_bff_traffic') return { data: resolution, error };
        return { data: null, error: new Error('unexpected RPC') };
      },
    };
  };
  factory.calls = calls;
  return factory;
}

function makeRequest(path = pppoeApiRoutes.customerLiveTraffic, bearerToken = token) {
  const headers = bearerToken ? { authorization: `Bearer ${bearerToken}` } : {};
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

test('customer telemetry resolves only the opaque token to the linked PPPoE username through the server-side resolver', async () => {
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
  const client = clientFactory.calls.find((call) => call.kind === 'client');
  assert.equal(client.key, env.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(client.options.global, undefined);
  const resolver = clientFactory.calls.find((call) => call.kind === 'rpc');
  assert.equal(resolver.name, 'resolve_customer_portal_bff_traffic');
  assert.equal(resolver.args.p_token_hash, createHash('sha256').update(token).digest('hex'));
  assert.notEqual(resolver.args.p_token_hash, token);
  assert.equal(clientFactory.calls.some((call) => call.kind === 'getUser' || call.kind === 'from'), false);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
});

test('customer live route rejects absent/malformed sessions and any client-selected customer ID before router access', async () => {
  const adapter = makeAdapter();
  const factory = makeClientFactory();
  const handler = createPppoeApiHandler({ env, createClient: factory, adapter, now: () => 10_000 });
  assert.equal((await handler(makeRequest(pppoeApiRoutes.customerLiveTraffic, ''))).status, 401);
  assert.equal((await handler(makeRequest(pppoeApiRoutes.customerLiveTraffic, 'not-a-token'))).status, 401);
  assert.equal((await handler(makeRequest(`${pppoeApiRoutes.customerLiveTraffic}?customerId=other`))).status, 400);
  assert.deepEqual(adapter.calls, []);
  assert.equal(factory.calls.length, 0);
});

test('customer live route never returns simulated rates when the backend is configured for a mock driver', async () => {
  const adapter = makeAdapter();
  const handler = createPppoeApiHandler({
    env: { ...env, ROUTER_DRIVER: 'mock' },
    createClient: makeClientFactory(), adapter, now: () => 10_000,
  });
  const response = await handler(makeRequest());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Live RouterOS telemetry is not configured.' });
  assert.deepEqual(adapter.calls, []);
});

test('expired or revoked BFF sessions and resolver errors fail closed before router access', async () => {
  const adapter = makeAdapter();
  const expired = createPppoeApiHandler({
    env,
    createClient: makeClientFactory({ resolution: { status: 'unauthorized' } }),
    adapter,
    now: () => 10_000,
  });
  assert.equal((await expired(makeRequest())).status, 401);
  const databaseError = createPppoeApiHandler({
    env,
    createClient: makeClientFactory({ resolution: null, error: new Error('database') }),
    adapter,
    now: () => 10_000,
  });
  assert.equal((await databaseError(makeRequest())).status, 503);
  const missingServiceKey = createPppoeApiHandler({
    env: { SUPABASE_URL: env.SUPABASE_URL }, createClient: makeClientFactory(), adapter, now: () => 10_000,
  });
  assert.equal((await missingServiceKey(makeRequest())).status, 503);
  assert.deepEqual(adapter.calls, []);
});

test('a token bound to an account without PPPoE username cannot trigger router access', async () => {
  const adapter = makeAdapter();
  const handler = createPppoeApiHandler({
    env,
    createClient: makeClientFactory({ resolution: {
      status: 'ok', user_id: userId, organization_id: organizationId,
      customer_id: customerId, pppoe_username: '',
    } }),
    adapter,
    now: () => 10_000,
  });
  assert.equal((await handler(makeRequest())).status, 404);
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
