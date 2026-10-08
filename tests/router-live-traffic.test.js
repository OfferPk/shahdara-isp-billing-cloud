import test from 'node:test';
import assert from 'node:assert/strict';
import { MikroTikRouterAdapter, routerAdapterInternals } from '../src/server/router-adapters.js';

test('RouterOS live traffic is a single strictly scoped PPPoE monitor-traffic request', async () => {
  const calls = [];
  const adapter = new MikroTikRouterAdapter({
    env: { ROUTER_HOST: '192.0.2.10', ROUTER_USER: 'readonly', ROUTER_PASSWORD: 'synthetic-secret' },
    now: () => new Date('2026-10-08T00:00:00.000Z'),
    request: async (_config, command, properties) => {
      calls.push({ command, properties });
      return { rows: [{ name: '<pppoe-subscriber_01>', 'tx-bits-per-second': '6.5Mbps', 'rx-bits-per-second': '425kbps' }] };
    },
  });
  const sample = await adapter.getLiveTrafficForUsername('subscriber_01');
  assert.deepEqual(calls, [{
    command: '/interface/monitor-traffic',
    properties: ['=interface=<pppoe-subscriber_01>', '=once='],
  }]);
  assert.deepEqual(sample, {
    downloadBitsPerSecond: 6_500_000,
    uploadBitsPerSecond: 425_000,
    sampledAt: '2026-10-08T00:00:00.000Z',
    source: 'routeros',
  });
});

test('monitor-traffic rejects invalid usernames and any non-once or arbitrary interface properties', async () => {
  const adapter = new MikroTikRouterAdapter({
    env: { ROUTER_HOST: '192.0.2.10', ROUTER_USER: 'readonly', ROUTER_PASSWORD: 'synthetic-secret' },
    request: async () => { assert.fail('invalid PPPoE username must not contact router'); },
  });
  await assert.rejects(adapter.getLiveTrafficForUsername('bad/interface'), /valid linked PPPoE username/);
  assert.equal(routerAdapterInternals.isAllowedRouterRequest('/system/reboot', []), false);
  assert.equal(routerAdapterInternals.isAllowedRouterRequest('/interface/monitor-traffic', ['=interface=<pppoe-a>', '=once=']), true);
  assert.equal(routerAdapterInternals.isAllowedRouterRequest('/interface/monitor-traffic', ['=interface=<pppoe-a>', '=once=', '=duration=2']), false);
  assert.equal(routerAdapterInternals.isAllowedRouterRequest('/interface/monitor-traffic', ['=interface=<pppoe-a>/..', '=once=']), false);
  assert.equal(routerAdapterInternals.isAllowedRouterRequest('/interface/monitor-traffic', ['=interface=<pppoe-a>', '=numbers=all']), false);
});
