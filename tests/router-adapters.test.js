import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MockRouterAdapter,
  MikroTikRouterAdapter,
  createRouterAdapter,
  routerAdapterInternals,
} from '../src/server/router-adapters.js';

const fixedNow = () => new Date('2026-10-07T16:00:00.000Z');

 test('mock adapter generates 20 realistic Shahdara PPPoE sessions in the DTO shape', async () => {
  const adapter = new MockRouterAdapter({ now: fixedNow });
  const sessions = await adapter.getActiveSessions();
  assert.equal(sessions.length, 20);
  assert.equal(sessions[0].username, 'shahdara_user_01');
  assert.equal(sessions[19].username, 'shahdara_user_20');
  assert.match(sessions[0].ipAddress, /^10\.10\.20\.\d+$/);
  assert.match(sessions[0].callerId, /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/);
  assert.match(sessions[0].uptime, /^\d+d \d{2}h \d{2}m \d{2}s$/);
  assert.equal(typeof sessions[0].bytesIn, 'bigint');
  assert.equal(typeof sessions[0].bytesOut, 'bigint');
  assert.equal(sessions[0].status, 'Online');
  assert.equal(sessions[0].lastPolledAt, '2026-10-07T16:00:00.000Z');
});

test('mock traffic counters increase at every poll and mock health matches the requested fixture', async () => {
  const adapter = new MockRouterAdapter({ now: fixedNow });
  const first = await adapter.getActiveSessions();
  const second = await adapter.getActiveSessions();
  assert.ok(second[0].bytesIn > first[0].bytesIn);
  assert.ok(second[0].bytesOut > first[0].bytesOut);
  const health = await adapter.getRouterHealth();
  assert.deepEqual({ connected: health.connected, latencyMs: health.latencyMs, cpuLoadPercent: health.cpuLoadPercent }, {
    connected: true, latencyMs: 5, cpuLoadPercent: 12,
  });
  assert.equal(health.routerHost, '10.10.20.1');
});

test('adapter selector chooses RouterOS only for the explicit mikrotik driver', () => {
  assert.ok(createRouterAdapter({ env: { ROUTER_DRIVER: 'mikrotik' } }) instanceof MikroTikRouterAdapter);
  assert.ok(createRouterAdapter({ env: { ROUTER_DRIVER: 'MIKROTIK' } }) instanceof MikroTikRouterAdapter);
  assert.ok(createRouterAdapter({ env: { ROUTER_DRIVER: 'other' } }) instanceof MockRouterAdapter);
  assert.ok(createRouterAdapter({ env: {} }) instanceof MockRouterAdapter);
});

test('MikroTik rows map live counters and resource output into the shared contract shape', async () => {
  const calls = [];
  const request = async (config, command, properties) => {
    calls.push({ host: config.host, port: config.port, command, properties });
    if (command === '/ppp/active/print') return {
      rows: [{ '.id': '*5', name: 'shahdara_user_05', 'caller-id': '48:8F:5A:12:34:56', address: '10.10.20.105', uptime: '2d4h15m32s', 'bytes-in': '9007199254740993', 'bytes-out': '2048' }],
      elapsedMs: 7,
    };
    return { rows: [{ version: '7.16.2', 'cpu-load': '12', 'free-memory': '268435456' }], elapsedMs: 6 };
  };
  const adapter = new MikroTikRouterAdapter({
    env: { ROUTER_HOST: '192.0.2.10', ROUTER_PORT: '8729', ROUTER_USER: 'readonly', ROUTER_PASSWORD: 'test' },
    now: fixedNow,
    request,
  });
  const [session] = await adapter.getActiveSessions();
  assert.equal(session.sessionId, '*5');
  assert.equal(session.username, 'shahdara_user_05');
  assert.equal(session.ipAddress, '10.10.20.105');
  assert.equal(session.uptime, '2d 04h 15m 32s');
  assert.equal(session.uptimeSeconds, 188132);
  assert.equal(session.bytesIn, 9007199254740993n);
  assert.equal(session.bytesOut, 2048n);
  const health = await adapter.getRouterHealth();
  assert.equal(health.connected, true);
  assert.equal(health.routerOsVersion, '7.16.2');
  assert.equal(health.cpuLoadPercent, 12);
  assert.equal(health.freeMemoryMb, 256);
  assert.deepEqual(calls.map(({ command }) => command), ['/ppp/active/print', '/system/resource/print']);
  assert.ok(calls[0].properties.includes('=stats='));
  assert.match(calls[0].properties[0], /(?:^|,)bytes(?:,|$)/);
  assert.ok(calls.every(({ host, port }) => host === '192.0.2.10' && port === 8729));
});

test('missing or unreachable MikroTik settings return disconnected health and an empty session list without throwing', async () => {
  const noSettings = new MikroTikRouterAdapter({ env: {}, now: fixedNow });
  assert.deepEqual(await noSettings.getActiveSessions(), []);
  assert.equal((await noSettings.getRouterHealth()).connected, false);

  const unreachable = new MikroTikRouterAdapter({
    env: { ROUTER_HOST: '192.0.2.99', ROUTER_PORT: '8728', ROUTER_USER: 'readonly', ROUTER_PASSWORD: 'test' },
    now: fixedNow,
    request: async () => { throw new Error('synthetic connection refused'); },
  });
  assert.deepEqual(await unreachable.getActiveSessions(), []);
  const health = await unreachable.getRouterHealth();
  assert.equal(health.connected, false);
  assert.equal(health.routerHost, '192.0.2.99');
});

test('RouterOS API request helper allowlists only the two requested read commands', async () => {
  assert.equal(routerAdapterInternals.parseRouterUptime('1w2d3h4m5s'), 788645);
  await assert.rejects(routerAdapterInternals.apiRequest({ host: '127.0.0.1' }, '/ppp/secret/remove'), /read commands/);
});

test('mock adapter discovers 15–20 synthetic subscriber records with profile and parsed comment fields', async () => {
  const adapter = new MockRouterAdapter({ now: fixedNow, subscriberCount: 17 });
  const subscribers = await adapter.discoverSubscribers();
  assert.equal(subscribers.length, 17);
  assert.deepEqual(Object.keys(subscribers[0]), ['username', 'profile', 'ipAddress', 'comment']);
  assert.equal(subscribers[0].username, 'shahdara_user_01');
  assert.match(subscribers[0].profile, /^(10M|15M)$/);
  assert.match(subscribers[0].ipAddress, /^10\.10\.20\.\d+$/);
  assert.match(subscribers[0].comment, /^.+ - 03\d{9} - .+$/);
});

test('MikroTik subscriber discovery reads only public secret fields and prefers PPP secrets', async () => {
  const calls = [];
  const adapter = new MikroTikRouterAdapter({
    env: { ROUTER_HOST: '192.0.2.10', ROUTER_USER: 'readonly', ROUTER_PASSWORD: 'test' },
    request: async (config, command, properties) => {
      calls.push({ command, properties });
      return { rows: [{ name: 'user-90', profile: '15M', 'remote-address': '10.10.20.190', comment: 'Customer - 03001234567 - Area' }] };
    },
  });
  assert.deepEqual(await adapter.discoverSubscribers(), [{ username: 'user-90', profile: '15M', ipAddress: '10.10.20.190', comment: 'Customer - 03001234567 - Area' }]);
  assert.deepEqual(calls.map((call) => call.command), ['/ppp/secret/print']);
  assert.match(calls[0].properties[0], /name,profile,remote-address,comment/);
  assert.doesNotMatch(calls[0].properties.join(' '), /password/i);
});

test('MikroTik subscriber discovery falls back to active sessions when PPP secrets fail or are empty', async () => {
  for (const secretResponse of [new Error('permission denied'), { rows: [] }]) {
    const calls = [];
    const adapter = new MikroTikRouterAdapter({
      env: { ROUTER_HOST: '192.0.2.10', ROUTER_USER: 'readonly', ROUTER_PASSWORD: 'test' },
      request: async (config, command) => {
        calls.push(command);
        if (command === '/ppp/secret/print') {
          if (secretResponse instanceof Error) throw secretResponse;
          return secretResponse;
        }
        return { rows: [{ name: 'active-user', profile: '10M', address: '10.10.20.101', comment: 'Active - 03001234567 - Area' }] };
      },
    });
    const [subscriber] = await adapter.discoverSubscribers();
    assert.equal(subscriber.username, 'active-user');
    assert.equal(subscriber.ipAddress, '10.10.20.101');
    assert.deepEqual(calls, ['/ppp/secret/print', '/ppp/active/print']);
  }
});
