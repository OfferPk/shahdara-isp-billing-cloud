import test from 'node:test';
import assert from 'node:assert/strict';
import { createPppoeApiHandler } from '../src/server/pppoe-api.js';

const organizationId = '10000000-0000-4000-8000-000000000001';
const env = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'public-anon-key',
};

function createClientFactory({ role = 'owner', authenticated = true } = {}) {
  const calls = [];
  const factory = (url, key, options) => {
    calls.push({ kind: 'createClient', url, key, options });
    return {
      auth: {
        async getUser(token) {
          calls.push({ kind: 'getUser', token });
          return authenticated
            ? { data: { user: { id: 'user-1' } }, error: null }
            : { data: { user: null }, error: new Error('invalid token') };
        },
      },
      from(table) {
        calls.push({ kind: 'from', table });
        return {
          select(columns) {
            calls.push({ kind: 'select', columns });
            return this;
          },
          eq(column, value) {
            calls.push({ kind: 'eq', column, value });
            return this;
          },
          async maybeSingle() {
            calls.push({ kind: 'maybeSingle' });
            return { data: role ? { role } : null, error: null };
          },
        };
      },
    };
  };
  factory.calls = calls;
  return factory;
}

function request(path, { method = 'GET', token = 'valid-token', origin } = {}) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (origin) headers.set('origin', origin);
  return new Request(`http://localhost${path}`, { method, headers });
}

const sessions = [
  { sessionId: '*1', username: 'shahdara_user_01', callerId: '48:8F:5A:12:34:56', ipAddress: '10.10.20.101', interfaceName: '<pppoe-user01>', uptime: '1d 01h 02m 03s', uptimeSeconds: 90123, bytesIn: 9007199254740993n, bytesOut: 1000n, status: 'Online', lastPolledAt: '2026-10-07T16:00:00.000Z' },
  { sessionId: '*2', username: 'shahdara_user_02', callerId: 'A4:2B:B0:01:02:03', ipAddress: '10.10.20.102', interfaceName: '<pppoe-user02>', uptime: '0d 02h 00m 00s', uptimeSeconds: 7200, bytesIn: 7n, bytesOut: 20n, status: 'Online', lastPolledAt: '2026-10-07T16:00:00.000Z' },
  { sessionId: '*3', username: 'offline-test', callerId: '', ipAddress: '', interfaceName: '', uptime: '', uptimeSeconds: 0, bytesIn: 99n, bytesOut: 88n, status: 'Offline', lastPolledAt: '2026-10-07T16:00:00.000Z' },
];

 test('sessions endpoint is admin-authorized and returns lossless JSON traffic totals and active rows', async () => {
  const clientFactory = createClientFactory({ role: 'admin' });
  const adapterCalls = [];
  const adapter = {
    async getActiveSessions() { adapterCalls.push('getActiveSessions'); return sessions; },
    async getRouterHealth() { adapterCalls.push('getRouterHealth'); return { connected: true, routerHost: '10.10.20.1', latencyMs: 5, cpuLoadPercent: 12, lastCheckedAt: '2026-10-07T16:00:00.000Z' }; },
  };
  const handler = createPppoeApiHandler({ env, createClient: clientFactory, adapter });
  const response = await handler(request(`/api/admin/pppoe/sessions?organizationId=${organizationId}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  const data = await response.json();
  assert.equal(data.totalActiveUsers, 2);
  assert.deepEqual(data.totalTraffic, { bytesIn: '9007199254741000', bytesOut: '1020' });
  assert.equal(data.sessions.length, 3);
  assert.equal(data.sessions[0].bytesIn, '9007199254740993');
  assert.deepEqual(adapterCalls, ['getActiveSessions']);
  assert.ok(clientFactory.calls.some((call) => call.kind === 'getUser' && call.token === 'valid-token'));
  assert.ok(clientFactory.calls.some((call) => call.kind === 'eq' && call.column === 'organization_id' && call.value === organizationId));
  assert.ok(clientFactory.calls.some((call) => call.kind === 'eq' && call.column === 'user_id' && call.value === 'user-1'));
});

test('router-health endpoint returns health only and verifies the same organization admin role', async () => {
  const adapter = {
    async getActiveSessions() { assert.fail('health route must not query sessions'); },
    async getRouterHealth() { return { connected: true, routerHost: '10.10.20.1', latencyMs: 5, cpuLoadPercent: 12, lastCheckedAt: '2026-10-07T16:00:00.000Z' }; },
  };
  const handler = createPppoeApiHandler({ env, createClient: createClientFactory({ role: 'owner' }), adapter });
  const response = await handler(request(`/api/admin/pppoe/router-health?organizationId=${organizationId}`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { connected: true, routerHost: '10.10.20.1', latencyMs: 5, cpuLoadPercent: 12, lastCheckedAt: '2026-10-07T16:00:00.000Z' });
});

test('unauthenticated or non-admin requests are rejected before router access', async () => {
  let routerCalls = 0;
  const adapter = {
    async getActiveSessions() { routerCalls += 1; return []; },
    async getRouterHealth() { routerCalls += 1; return { connected: false }; },
  };
  const unauthorized = createPppoeApiHandler({ env, createClient: createClientFactory({ authenticated: false }), adapter });
  assert.equal((await unauthorized(request(`/api/admin/pppoe/sessions?organizationId=${organizationId}`))).status, 401);
  const forbidden = createPppoeApiHandler({ env, createClient: createClientFactory({ role: 'customer' }), adapter });
  assert.equal((await forbidden(request(`/api/admin/pppoe/router-health?organizationId=${organizationId}`))).status, 403);
  assert.equal(routerCalls, 0);
});

test('API routes reject invalid organizations, non-GET methods, and unapproved cross-origin requests', async () => {
  let routerCalls = 0;
  const handler = createPppoeApiHandler({
    env: { ...env, CORS_ORIGIN: 'https://portal.example' },
    createClient: createClientFactory(),
    adapter: { async getActiveSessions() { routerCalls += 1; return []; }, async getRouterHealth() { routerCalls += 1; return {}; } },
  });
  assert.equal((await handler(request('/api/admin/pppoe/sessions?organizationId=bad'))).status, 400);
  assert.equal((await handler(request(`/api/admin/pppoe/sessions?organizationId=${organizationId}`, { method: 'POST' }))).status, 405);
  assert.equal((await handler(request(`/api/admin/pppoe/sessions?organizationId=${organizationId}`, { origin: 'https://attacker.example' }))).status, 403);
  assert.equal((await handler(request('/api/admin/pppoe/unknown'))).status, 404);
  assert.equal(routerCalls, 0);
});

test('CORS preflight permits only configured origins and exposes the supported methods', async () => {
  const handler = createPppoeApiHandler({
    env: { ...env, CORS_ORIGIN: 'https://portal.example' },
    createClient: createClientFactory(),
    adapter: { async getActiveSessions() { return []; }, async getRouterHealth() { return {}; } },
  });
  const response = await handler(request('/api/admin/pppoe/sessions', { method: 'OPTIONS', token: '', origin: 'https://portal.example' }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://portal.example');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
});

test('same-origin GET remains available without a separate CORS allowlist', async () => {
  const handler = createPppoeApiHandler({
    env,
    createClient: createClientFactory(),
    adapter: { async getActiveSessions() { return []; }, async getRouterHealth() { return { connected: false }; } },
  });
  const sameOriginRequest = new Request(`http://localhost/api/admin/pppoe/router-health?organizationId=${organizationId}`, {
    headers: { authorization: 'Bearer valid-token', origin: 'http://localhost' },
  });
  assert.equal((await handler(sameOriginRequest)).status, 200);
});

test('standalone API server serves only protected API routes and keeps CORS and admin membership checks', async (context) => {
  const { createPppoeApiServer } = await import('../src/server/api-only.js');
  const server = createPppoeApiServer({
    env: { ...env, CORS_ORIGIN: 'https://portal.example' },
    createClient: createClientFactory({ role: 'admin' }),
    adapter: {
      async getActiveSessions() { return []; },
      async getRouterHealth() { return { connected: true, routerHost: 'router.test', latencyMs: 8 }; },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const route = `/api/admin/pppoe/router-health?organizationId=${organizationId}`;

  const preflight = await fetch(`${baseUrl}${route}`, {
    method: 'OPTIONS',
    headers: { origin: 'https://portal.example', 'access-control-request-method': 'GET' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://portal.example');

  const live = await fetch(`${baseUrl}${route}`, {
    headers: { origin: 'https://portal.example', authorization: 'Bearer valid-token' },
  });
  assert.equal(live.status, 200);
  assert.equal(live.headers.get('cache-control'), 'no-store, max-age=0');
  assert.deepEqual(await live.json(), { connected: true, routerHost: 'router.test', latencyMs: 8 });

  const denied = await fetch(`${baseUrl}${route}`, { headers: { origin: 'https://attacker.example', authorization: 'Bearer valid-token' } });
  assert.equal(denied.status, 403);
  const staticPath = await fetch(`${baseUrl}/`);
  assert.equal(staticPath.status, 404);
});
