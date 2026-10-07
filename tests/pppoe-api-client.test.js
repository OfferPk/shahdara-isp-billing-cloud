import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPppoeTelemetry,
  isGithubPagesStaticHost,
  resolvePppoeApiBase,
} from '../src/pppoe-api-client.js';
import { MockRouterAdapter } from '../src/pppoe-mock-adapter.js';

const organizationId = '10000000-0000-4000-8000-000000000001';
const token = 'signed-in-admin-token';
const fixedNow = () => new Date('2026-10-07T16:00:00.000Z');

test('API URL resolves runtime config before the public Vite build setting', () => {
  assert.equal(resolvePppoeApiBase({ config: { API_URL: ' https://mini-pc.example/api/// ' }, envBase: 'https://build.example' }), 'https://mini-pc.example/api');
  assert.equal(resolvePppoeApiBase({ config: { API_URL: '' }, envBase: 'https://build.example/' }), 'https://build.example');
  assert.equal(resolvePppoeApiBase({ config: {}, envBase: '' }), '');
});

test('GitHub Pages host selects the browser mock only when no separate API is configured', () => {
  assert.equal(isGithubPagesStaticHost({ hostname: 'shahdara-portal.github.io' }), true);
  assert.equal(isGithubPagesStaticHost({ hostname: 'github.io' }), true);
  assert.equal(isGithubPagesStaticHost({ hostname: 'portal.example.com' }), false);
  assert.equal(isGithubPagesStaticHost({ hostname: 'shahdara-portal.github.io', apiBaseUrl: 'https://mini-pc.example' }), false);
});

test('static GitHub Pages renders 20 synthetic sessions entirely in the browser', async () => {
  let networkCalls = 0;
  const result = await fetchPppoeTelemetry({
    organizationId,
    token,
    hostname: 'shahdara-portal.github.io',
    fetchImpl: async () => { networkCalls += 1; throw new Error('should not call the API'); },
    mockAdapter: new MockRouterAdapter({ now: fixedNow }),
  });
  assert.equal(networkCalls, 0);
  assert.equal(result.source, 'mock');
  assert.equal(result.fallbackReason, 'static-host');
  assert.equal(result.sessions.length, 20);
  assert.equal(result.totalActiveUsers, 20);
  assert.equal(result.sessions[0].username, 'shahdara_user_01');
  assert.equal(result.health.routerHost, '10.10.20.1');
});

test('unreachable backend and absent static endpoint fall back without surfacing a fetch error', async () => {
  const adapter = new MockRouterAdapter({ now: fixedNow });
  for (const fetchImpl of [
    async () => { throw new TypeError('Failed to fetch'); },
    async () => new Response('Not found', { status: 404 }),
  ]) {
    const result = await fetchPppoeTelemetry({ organizationId, token, fetchImpl, mockAdapter: adapter });
    assert.equal(result.source, 'mock');
    assert.equal(result.fallbackReason, 'api-unavailable');
    assert.equal(result.sessions.length, 20);
  }
});

test('valid API responses are used as live data and include the admin bearer token', async () => {
  const seen = [];
  const sessions = [{ username: 'live-admin-view', status: 'Online', bytesIn: '100', bytesOut: '50' }];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    const body = String(url).includes('/sessions')
      ? { sessions, totalActiveUsers: 1, totalTraffic: { bytesIn: '100', bytesOut: '50' } }
      : { connected: true, routerHost: '192.0.2.40', latencyMs: 9 };
    return Response.json(body);
  };
  const result = await fetchPppoeTelemetry({ organizationId, token, apiBaseUrl: 'https://mini-pc.example/', fetchImpl });
  assert.equal(result.source, 'api');
  assert.deepEqual(result.sessions, sessions);
  assert.equal(result.health.routerHost, '192.0.2.40');
  assert.equal(seen.length, 2);
  assert.ok(seen.every(({ url }) => String(url).startsWith('https://mini-pc.example/api/admin/pppoe/')));
  assert.ok(seen.every(({ options }) => options.headers.authorization === `Bearer ${token}`));
  assert.ok(seen.every(({ options }) => options.method === 'GET'));
});

test('authentication, authorization, and backend errors do not get hidden by mock data', async () => {
  for (const [status, error] of [[401, 'Sign in again.'], [403, 'Organization administrator access is required.'], [503, 'Router API is down.']]) {
    await assert.rejects(
      fetchPppoeTelemetry({
        organizationId,
        token,
        fetchImpl: async () => Response.json({ error }, { status }),
        mockAdapter: { async getActiveSessions() { assert.fail('auth/server errors must not load mock data'); }, async getRouterHealth() { return {}; } },
      }),
      new RegExp(error.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  }
});

test('missing bearer token never triggers the browser mock fallback', async () => {
  await assert.rejects(fetchPppoeTelemetry({ organizationId, token: '', hostname: 'portal.github.io' }), /Sign in again/);
});


test('the shared mock adapter module stays browser-safe and preserves the server fixture contract', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../src/pppoe-mock-adapter.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]node:|from\s+['"]node\//);
  const [session] = await new MockRouterAdapter({ now: fixedNow }).getActiveSessions();
  assert.equal(session.status, 'Online');
  assert.equal(session.lastPolledAt, '2026-10-07T16:00:00.000Z');
});
