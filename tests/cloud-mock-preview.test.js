import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  discoverRouterSubscribers,
  fetchPppoeTelemetry,
  importRouterSubscribers,
} from '../src/pppoe-api-client.js';

test('forced mock mode drives telemetry and subscriber discovery without network access', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error('mock preview must not fetch a live API');
  };
  const telemetry = await fetchPppoeTelemetry({
    organizationId: 'synthetic-org',
    token: 'synthetic-session-token',
    fetchImpl,
    apiBaseUrl: 'https://live-api.invalid',
    hostname: 'preview.example.invalid',
    staticPages: false,
    routerDriver: 'mock',
  });
  assert.equal(telemetry.source, 'mock');
  assert.equal(telemetry.fallbackReason, 'forced-mock');
  assert.equal(telemetry.totalActiveUsers, 20);

  const discovery = await discoverRouterSubscribers({
    organizationId: 'synthetic-org',
    token: 'synthetic-session-token',
    fetchImpl,
    apiBaseUrl: 'https://live-api.invalid',
    routerDriver: 'mock',
  });
  assert.equal(discovery.source, 'mock');
  assert.equal(discovery.discoveredCount, 20);
  assert.equal(discovery.subscribers[0].status, 'New');

  const importResult = await importRouterSubscribers({
    organizationId: 'synthetic-org',
    token: 'synthetic-session-token',
    usernames: [discovery.subscribers[0].username],
    fetchImpl,
    apiBaseUrl: 'https://live-api.invalid',
    routerDriver: 'mock',
  });
  assert.equal(importResult.source, 'mock');
  assert.equal(importResult.imported, 1);
  assert.equal(fetchCalls, 0);
});

test('GitHub Pages build pins both router selectors to mock and injects no API endpoint or router secret', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.match(workflow, /VITE_ROUTER_DRIVER:\s*mock/);
  assert.match(workflow, /ROUTER_DRIVER:\s*mock/);
  assert.doesNotMatch(workflow, /VITE_PPPOE_API_BASE_URL/);
  assert.doesNotMatch(workflow, /ROUTER_(?:HOST|USER|PASSWORD|PORT)\s*:/);
});
