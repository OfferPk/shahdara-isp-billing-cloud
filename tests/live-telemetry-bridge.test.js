import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  TelemetryBridgeError,
  normalizeActiveSession,
  normalizeActiveSessions,
  parseCliArgs,
  pushLiveTelemetry,
  runBridgeCycle,
  validateBridgeTiming,
} from '../scripts/live-telemetry-bridge.js';
import { localRouterSyncInternals } from '../scripts/local-router-sync.js';

const router = { host: '192.168.88.1', port: 8728, username: 'synthetic-router-user', password: 'synthetic-router-password' };
const supabase = {
  url: 'https://synthetic-project.supabase.co',
  publishableKey: 'sb_publishable_synthetic',
  adminAccessToken: 'synthetic.owner.jwt',
};
const organizationId = '10000000-0000-4000-8000-000000000001';
const sampleSession = {
  name: 'fixture-user',
  uptime: '2h15m',
  'caller-id': 'AA:BB:CC:DD:EE:FF',
  address: '10.20.30.41',
  'session-id': '*A1',
  bytes: '9007199254740993/184467440737095516',
};

const okJson = (value) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

test('RouterOS PPP active stats map Tx to customer download and Rx to upload without numeric rounding', () => {
  assert.deepEqual(normalizeActiveSession(sampleSession), {
    username: 'fixture-user',
    session_id: '*A1',
    uptime: '2h15m',
    caller_id: 'AA:BB:CC:DD:EE:FF',
    ip_address: '10.20.30.41',
    tx_bytes: '9007199254740993',
    rx_bytes: '184467440737095516',
  });
  assert.deepEqual(normalizeActiveSession({
    ...sampleSession,
    bytes: undefined,
    'tx-byte': '12',
    'rx-byte': '34',
  }).tx_bytes, '12');
  assert.deepEqual(normalizeActiveSession({
    ...sampleSession,
    bytes: ['56', '78'],
  }).rx_bytes, '78');
});

test('invalid or duplicate RouterOS snapshots fail closed before any Supabase write', () => {
  for (const bad of [
    { ...sampleSession, bytes: '1/nope' },
    { ...sampleSession, address: '' },
    { ...sampleSession, name: ' fixture-user' },
    { ...sampleSession, 'session-id': '' },
    { ...sampleSession, bytes: '9223372036854775808/1' },
  ]) {
    assert.throws(() => normalizeActiveSession(bad), TelemetryBridgeError);
  }
  assert.throws(() => normalizeActiveSessions([sampleSession, sampleSession]), /duplicate active session/i);
  assert.throws(() => normalizeActiveSessions(Array(501).fill(sampleSession)), /at most 500/i);
});

test('only complete private-LAN active snapshots are pushed; successful empty snapshots are still synced', async () => {
  let calls = 0;
  let observedAddress;
  const result = await runBridgeCycle({
    router,
    supabase,
    organizationId,
    readSessions: async (_config, address) => {
      observedAddress = address;
      return [sampleSession];
    },
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(new URL(url).pathname, '/rest/v1/rpc/sync_live_router_telemetry');
      assert.equal(init.method, 'POST');
      return okJson({ processed_sessions: 1 });
    },
  });
  assert.equal(observedAddress, '192.168.88.1');
  assert.equal(result.sessions, 1);
  assert.equal(calls, 1);

  const empty = await runBridgeCycle({
    router,
    supabase,
    organizationId,
    readSessions: async () => [],
    fetchImpl: async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body).p_items, []);
      return okJson({ processed_sessions: 0 });
    },
  });
  assert.equal(empty.sessions, 0);
});

test('router failures, invalid poll data, and public router addresses never trigger a Supabase write', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return okJson({}); };
  await assert.rejects(runBridgeCycle({
    router, supabase, organizationId, fetchImpl,
    readSessions: async () => { throw new Error('synthetic router timeout'); },
  }), (error) => error instanceof TelemetryBridgeError && error.kind === 'router-poll');
  await assert.rejects(runBridgeCycle({
    router: { ...router, host: '8.8.8.8' }, supabase, organizationId, fetchImpl,
    readSessions: async () => { throw new Error('should not be reached'); },
  }), /private-LAN addresses/);
  await assert.rejects(runBridgeCycle({
    router, supabase, organizationId, fetchImpl,
    readSessions: async () => [{ ...sampleSession, bytes: 'incomplete' }],
  }), TelemetryBridgeError);
  assert.equal(calls, 0);
});

test('Supabase writes use only the publishable key plus signed-in owner/admin JWT', async () => {
  let call;
  const items = [normalizeActiveSession(sampleSession)];
  await pushLiveTelemetry({
    supabase,
    organizationId,
    items,
    fetchImpl: async (url, init) => {
      call = { url: String(url), init };
      return okJson({ processed_sessions: 1 });
    },
  });
  assert.equal(call.url, 'https://synthetic-project.supabase.co/rest/v1/rpc/sync_live_router_telemetry');
  assert.equal(call.init.headers.apikey, supabase.publishableKey);
  assert.equal(call.init.headers.authorization, `Bearer ${supabase.adminAccessToken}`);
  assert.equal(JSON.stringify(call.init.headers).toLowerCase().includes('service_role'), false);
  assert.deepEqual(JSON.parse(call.init.body), { p_organization_id: organizationId, p_items: items });
  await assert.rejects(pushLiveTelemetry({
    supabase, organizationId, items,
    fetchImpl: async () => new Response(null, { status: 404 }),
  }), /HTTP 404/);
});

test('bridge interval defaults to 55 seconds and cannot be set outside the 45–60 second window', () => {
  assert.deepEqual(validateBridgeTiming({}), { intervalMs: 55_000, timeoutMs: 15_000 });
  assert.equal(validateBridgeTiming({ LIVE_BRIDGE_INTERVAL_MS: '45000' }).intervalMs, 45_000);
  assert.equal(validateBridgeTiming({ LIVE_BRIDGE_INTERVAL_MS: '60000' }).intervalMs, 60_000);
  assert.throws(() => validateBridgeTiming({ LIVE_BRIDGE_INTERVAL_MS: '44000' }), /between 45000 and 60000/);
  assert.throws(() => validateBridgeTiming({ LIVE_BRIDGE_INTERVAL_MS: '60001' }), /between 45000 and 60000/);
  assert.deepEqual(parseCliArgs(['--help']), { help: true });
  assert.throws(() => parseCliArgs(['--apply']), /Unknown argument/);
});

test('RouterOS helper sends the exact read-only PPP active stats allowlist and honors local plaintext opt-in', () => {
  assert.deepEqual(localRouterSyncInternals.ROUTEROS_TELEMETRY_COMMAND, [
    '/ppp/active/print',
    '=stats=',
    '=.proplist=name,uptime,caller-id,address,session-id,bytes',
  ]);
  assert.throws(() => localRouterSyncInternals.validateRouterConfig({
    ...router,
    ROUTER_HOST: router.host,
    ROUTER_PORT: '8728',
    ROUTER_USER: router.username,
    ROUTER_PASSWORD: router.password,
  }), /ROUTER_ALLOW_INSECURE_LOCAL=true/);
  assert.equal(localRouterSyncInternals.validateRouterConfig({
    ROUTER_HOST: router.host,
    ROUTER_PORT: '8728',
    ROUTER_ALLOW_INSECURE_LOCAL: 'true',
    ROUTER_USER: router.username,
    ROUTER_PASSWORD: router.password,
  }).port, 8728);
});

test('additive database migration enforces owner/admin RPC, keeps session rows admin-only, and reuses monthly deltas', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20261008010000_live_telemetry_bridge.sql', import.meta.url), 'utf8');
  assert.match(migration, /intentionally unapplied/i);
  assert.match(migration, /create table public\.active_sessions/i);
  assert.match(migration, /alter table public\.customer_private_details\s+add column if not exists last_seen/i);
  assert.match(migration, /if \(select auth\.uid\(\)\) is null[\s\S]*not public\.is_org_admin\(p_organization_id\)/i);
  assert.match(migration, /grant execute on function public\.sync_live_router_telemetry\(uuid, jsonb\)\s+to authenticated/i);
  assert.match(migration, /perform public\.sync_customer_bandwidth_session_deltas\(v_chunk\)/i);
  assert.match(migration, /bytes_in', v_tx_text[\s\S]*bytes_out', v_rx_text/i);
  assert.match(migration, /service_status = case[\s\S]*then 'active' else 'offline' end/i);
  assert.match(migration, /assigned_ip = null/i);
  assert.match(migration, /from public, anon, authenticated, service_role/i);
  assert.doesNotMatch(migration, /\/ppp\/active\/remove|\/ppp\/secret\/set|\/ppp\/active\/disable/i);
});
