import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  READ_ONLY_DEVICE_CAPABILITIES,
  SUPPORTED_DEVICE_TYPES,
  createSyntheticDeviceRegistry,
  resolveSyntheticDeviceAdapter,
} from '../src/network-device-registry.js';

const source = await readFile(new URL('../src/network-device-registry.js', import.meta.url), 'utf8');

function mockDevice(deviceId, vendor, deviceType, overrides = {}) {
  return {
    organizationId: 'org-synthetic-a',
    deviceId,
    vendor,
    deviceType,
    connectionState: 'connected',
    synthetic: true,
    ...overrides,
  };
}

function mockAdapter(adapterId, vendor, deviceTypes, readOnlyCapabilities, overrides = {}) {
  return {
    adapterId,
    vendor,
    deviceTypes,
    readOnlyCapabilities,
    accessMode: 'read-only',
    connectionState: 'connected',
    synthetic: true,
    ...overrides,
  };
}

function target(selectedDeviceId, capability = 'device-health-summary', organizationId = 'org-synthetic-a') {
  return { organizationId, selectedDeviceId, capability };
}

function expectUnavailable(result, reason) {
  assert.deepEqual(result, {
    status: 'unavailable',
    reason,
    message: 'Unavailable · no verified device and read-only adapter are available.',
    organizationId: null,
    deviceId: null,
    vendor: null,
    deviceType: null,
    adapterId: null,
    capability: null,
    accessMode: 'read-only',
    connectionState: 'unavailable',
    synthetic: true,
    liveCheckPerformed: false,
    executionPermitted: false,
    rawVendorResponseIncluded: false,
  });
}

const vendorDeviceCases = [
  {
    label: 'MikroTik router',
    device: mockDevice('dev-router-1', 'mikrotik', 'router'),
    adapter: mockAdapter('mock-mikrotik', 'mikrotik', ['router'], ['device-health-summary', 'subscriber-session-summary']),
    capability: 'subscriber-session-summary',
  },
  {
    label: 'OLT device',
    device: mockDevice('dev-olt-1', 'example-olt-vendor', 'olt'),
    adapter: mockAdapter('mock-olt', 'example-olt-vendor', ['olt'], ['device-health-summary', 'optical-link-summary']),
    capability: 'optical-link-summary',
  },
  {
    label: 'wireless access point',
    device: mockDevice('dev-ap-1', 'example-wireless-vendor', 'wireless-ap'),
    adapter: mockAdapter('mock-wireless', 'example-wireless-vendor', ['wireless-ap'], ['device-health-summary', 'wireless-client-summary']),
    capability: 'wireless-client-summary',
  },
  {
    label: 'other explicitly typed device',
    device: mockDevice('dev-switch-1', 'generic-network', 'switch'),
    adapter: mockAdapter('mock-switch', 'generic-network', ['switch', 'gateway'], ['device-health-summary']),
    capability: 'device-health-summary',
  },
];

test('read-only capabilities are a finite allowlist and exclude action-like capabilities', () => {
  assert.deepEqual(SUPPORTED_DEVICE_TYPES, ['router', 'olt', 'wireless-ap', 'switch', 'gateway']);
  assert.deepEqual(READ_ONLY_DEVICE_CAPABILITIES, [
    'device-health-summary',
    'subscriber-session-summary',
    'interface-status-summary',
    'wireless-client-summary',
    'optical-link-summary',
  ]);
  assert.ok(READ_ONLY_DEVICE_CAPABILITIES.every((capability) => /-summary$/.test(capability)));
});

test('synthetic mock adapter descriptors resolve explicit MikroTik, OLT, wireless, and device types without live checks', () => {
  for (const { label, device, adapter, capability } of vendorDeviceCases) {
    const registry = createSyntheticDeviceRegistry({ devices: [device], adapters: [adapter] });
    const result = resolveSyntheticDeviceAdapter(registry, target(device.deviceId, capability));
    assert.deepEqual(result, {
      status: 'resolved',
      reason: null,
      message: 'Synthetic contract match only · no device check was run.',
      organizationId: device.organizationId,
      deviceId: device.deviceId,
      vendor: device.vendor,
      deviceType: device.deviceType,
      adapterId: adapter.adapterId,
      capability,
      accessMode: 'read-only',
      connectionState: 'synthetic-fixture-only',
      synthetic: true,
      liveCheckPerformed: false,
      executionPermitted: false,
      rawVendorResponseIncluded: false,
    }, label);
  }
});

test('an exact selected device is resolved within the requested organization only', () => {
  const registry = createSyntheticDeviceRegistry({
    devices: [
      mockDevice('router-1', 'mikrotik', 'router'),
      mockDevice('router-1', 'mikrotik', 'router', { organizationId: 'org-synthetic-b' }),
    ],
    adapters: [mockAdapter('mock-router', 'mikrotik', ['router'], ['device-health-summary'])],
  });
  const result = resolveSyntheticDeviceAdapter(registry, target('router-1'));
  assert.equal(result.status, 'resolved');
  assert.equal(result.organizationId, 'org-synthetic-a');
  assert.equal(result.deviceId, 'router-1');
});

test('customer lookup requires one explicit same-organization customer-to-device mapping', () => {
  const registry = createSyntheticDeviceRegistry({
    devices: [mockDevice('router-2', 'mikrotik', 'router')],
    customerMappings: [{
      organizationId: 'org-synthetic-a',
      customerId: 'customer-synthetic-7',
      deviceId: 'router-2',
      mappingSource: 'explicit',
      synthetic: true,
    }],
    adapters: [mockAdapter('mock-router', 'mikrotik', ['router'], ['device-health-summary'])],
  });
  const result = resolveSyntheticDeviceAdapter(registry, {
    organizationId: 'org-synthetic-a',
    customerId: 'customer-synthetic-7',
    capability: 'device-health-summary',
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.deviceId, 'router-2');
  assert.equal(Object.hasOwn(result, 'customerId'), false);
});

test('zero or multiple exact device matches fail closed with the same sanitized unavailable shape', () => {
  const adapter = mockAdapter('mock-router', 'mikrotik', ['router'], ['device-health-summary']);
  const zeroMatches = createSyntheticDeviceRegistry({
    devices: [mockDevice('first-router', 'mikrotik', 'router')],
    adapters: [adapter],
  });
  expectUnavailable(resolveSyntheticDeviceAdapter(zeroMatches, target('missing-router')), 'no-exact-device-match');

  const multipleMatches = createSyntheticDeviceRegistry({
    devices: [
      mockDevice('duplicate-router', 'mikrotik', 'router'),
      mockDevice('duplicate-router', 'mikrotik', 'router'),
    ],
    adapters: [adapter],
  });
  expectUnavailable(resolveSyntheticDeviceAdapter(multipleMatches, target('duplicate-router')), 'ambiguous-device-match');
});

test('missing or ambiguous explicit mappings fail closed and never choose the first router', () => {
  const devices = [
    mockDevice('first-router', 'mikrotik', 'router'),
    mockDevice('second-router', 'mikrotik', 'router'),
  ];
  const adapter = mockAdapter('mock-router', 'mikrotik', ['router'], ['device-health-summary']);
  const missingMapping = createSyntheticDeviceRegistry({ devices, adapters: [adapter] });
  expectUnavailable(resolveSyntheticDeviceAdapter(missingMapping, {
    organizationId: 'org-synthetic-a',
    customerId: 'customer-with-no-mapping',
    capability: 'device-health-summary',
  }), 'no-explicit-customer-mapping');

  const ambiguousMapping = createSyntheticDeviceRegistry({
    devices,
    adapters: [adapter],
    customerMappings: ['first-router', 'second-router'].map((deviceId) => ({
      organizationId: 'org-synthetic-a',
      customerId: 'customer-ambiguous',
      deviceId,
      mappingSource: 'explicit',
      synthetic: true,
    })),
  });
  expectUnavailable(resolveSyntheticDeviceAdapter(ambiguousMapping, {
    organizationId: 'org-synthetic-a',
    customerId: 'customer-ambiguous',
    capability: 'device-health-summary',
  }), 'ambiguous-customer-mapping');
});

test('no implicit default-first-device fallback is possible', () => {
  const registry = createSyntheticDeviceRegistry({
    devices: [mockDevice('first-router', 'mikrotik', 'router')],
    adapters: [mockAdapter('mock-router', 'mikrotik', ['router'], ['device-health-summary'])],
  });
  expectUnavailable(resolveSyntheticDeviceAdapter(registry, {
    organizationId: 'org-synthetic-a',
    capability: 'device-health-summary',
  }), 'invalid-target-selection');
  expectUnavailable(resolveSyntheticDeviceAdapter(registry, target('not-the-first-router')), 'no-exact-device-match');
  expectUnavailable(resolveSyntheticDeviceAdapter(registry, {
    ...target('first-router'),
    customerId: 'customer-synthetic-7',
  }), 'invalid-target-selection');
  expectUnavailable(resolveSyntheticDeviceAdapter(registry, {
    organizationId: 'org-synthetic-a',
    selectedDeviceId: { id: 'first-router' },
    customerId: 'customer-synthetic-7',
    capability: 'device-health-summary',
  }), 'invalid-target-selection');
});

test('disconnected devices and adapters return sanitized unavailable results', () => {
  const disconnectedDeviceRegistry = createSyntheticDeviceRegistry({
    devices: [mockDevice('router-disconnected', 'mikrotik', 'router', { connectionState: 'disconnected' })],
    adapters: [mockAdapter('mock-router', 'mikrotik', ['router'], ['device-health-summary'])],
  });
  expectUnavailable(resolveSyntheticDeviceAdapter(disconnectedDeviceRegistry, target('router-disconnected')), 'device-not-connected');

  const disconnectedAdapterRegistry = createSyntheticDeviceRegistry({
    devices: [mockDevice('router-with-offline-adapter', 'mikrotik', 'router')],
    adapters: [mockAdapter('mock-router', 'mikrotik', ['router'], ['device-health-summary'], { connectionState: 'disconnected' })],
  });
  expectUnavailable(resolveSyntheticDeviceAdapter(disconnectedAdapterRegistry, target('router-with-offline-adapter')), 'adapter-not-connected');
});

test('missing, mismatched, and ambiguous adapter declarations fail closed', () => {
  const device = mockDevice('olt-1', 'example-olt-vendor', 'olt');
  const noAdapter = createSyntheticDeviceRegistry({ devices: [device] });
  expectUnavailable(resolveSyntheticDeviceAdapter(noAdapter, target('olt-1')), 'no-matching-read-only-adapter');

  const noCapability = createSyntheticDeviceRegistry({
    devices: [device],
    adapters: [mockAdapter('mock-olt', 'example-olt-vendor', ['olt'], ['optical-link-summary'])],
  });
  expectUnavailable(resolveSyntheticDeviceAdapter(noCapability, target('olt-1')), 'capability-not-declared-read-only');

  const ambiguousAdapters = createSyntheticDeviceRegistry({
    devices: [device],
    adapters: [
      mockAdapter('mock-olt-a', 'example-olt-vendor', ['olt'], ['device-health-summary']),
      mockAdapter('mock-olt-b', 'example-olt-vendor', ['olt'], ['device-health-summary']),
    ],
  });
  expectUnavailable(resolveSyntheticDeviceAdapter(ambiguousAdapters, target('olt-1')), 'ambiguous-adapter-match');
});

test('write-like capabilities and non-synthetic or non-explicit inventory are rejected at construction', () => {
  assert.throws(() => createSyntheticDeviceRegistry({
    devices: [mockDevice('router-1', 'mikrotik', 'router')],
    adapters: [mockAdapter('mock-router', 'mikrotik', ['router'], ['execute-command'])],
  }), /read-only capabilities must be a non-empty, unique allowlist/);
  assert.throws(() => createSyntheticDeviceRegistry({
    devices: [mockDevice('router-1', 'mikrotik', 'router', { synthetic: false })],
  }), /Device must be marked as a synthetic fixture/);
  assert.throws(() => createSyntheticDeviceRegistry({
    customerMappings: [{
      organizationId: 'org-synthetic-a', customerId: 'customer-1', deviceId: 'router-1',
      mappingSource: 'default-router', synthetic: true,
    }],
  }), /Customer-to-device mappings must be explicit/);
  assert.throws(() => createSyntheticDeviceRegistry({
    devices: [mockDevice('router-1', 'mikrotik', 'router')],
    adapters: [mockAdapter('mock-router', 'mikrotik', ['router'], ['device-health-summary'], { accessMode: 'read-write' })],
  }), /Only explicitly declared read-only adapters are allowed/);
});

test('unavailable responses reveal no supplied identifiers, credentials, or vendor payloads', () => {
  const registry = createSyntheticDeviceRegistry();
  const result = resolveSyntheticDeviceAdapter(registry, {
    organizationId: 'org-private-identifier',
    selectedDeviceId: 'device-private-identifier',
    capability: 'device-health-summary',
    password: 'DO-NOT-RETURN-SECRET',
    rawVendorResponse: { secret: 'DO-NOT-RETURN-RAW-VENDOR-DATA' },
  });
  expectUnavailable(result, 'no-exact-device-match');
  assert.doesNotMatch(JSON.stringify(result), /private-identifier|DO-NOT-RETURN|password/i);
});

test('module is pure contract code with no network, persistence, vendor client, or write path', () => {
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|node:(?:http|https|net)|child_process|supabase|routeros|radius|indexedDB|localStorage|sessionStorage|\.rpc\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(/i);
  assert.doesNotMatch(source, /function\s+(?:apply|change|write|execute|reboot|disconnect|refresh)\w*\s*\(/i);
  assert.match(source, /Synthetic contract match only/);
  assert.match(source, /rawVendorResponseIncluded: false/);
});
