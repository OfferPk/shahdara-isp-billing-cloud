const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VENDOR_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const SUPPORTED_DEVICE_TYPES = Object.freeze([
  'router',
  'olt',
  'wireless-ap',
  'switch',
  'gateway',
]);

export const READ_ONLY_DEVICE_CAPABILITIES = Object.freeze([
  'device-health-summary',
  'subscriber-session-summary',
  'interface-status-summary',
  'wireless-client-summary',
  'optical-link-summary',
]);

const CONNECTION_STATES = new Set(['connected', 'disconnected']);
const CAPABILITIES = new Set(READ_ONLY_DEVICE_CAPABILITIES);
const TYPES = new Set(SUPPORTED_DEVICE_TYPES);
const REGISTRIES = new WeakSet();
const UNAVAILABLE_MESSAGE = 'Unavailable · no verified device and read-only adapter are available.';
const UNAVAILABLE_REASONS = new Set([
  'no-connected-device-or-approved-adapter',
  'invalid-target-selection',
  'no-exact-device-match',
  'ambiguous-device-match',
  'no-explicit-customer-mapping',
  'ambiguous-customer-mapping',
  'mapped-device-not-found',
  'ambiguous-mapped-device-match',
  'device-not-connected',
  'no-matching-read-only-adapter',
  'capability-not-declared-read-only',
  'ambiguous-adapter-match',
  'adapter-not-connected',
]);

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${label} must be an exact, non-empty identifier.`);
  }
  return value;
}

function assertVendor(value) {
  if (typeof value !== 'string' || !VENDOR_PATTERN.test(value)) {
    throw new TypeError('Vendor must be an explicit lowercase identifier.');
  }
  return value;
}

function assertSynthetic(value, label) {
  if (value.synthetic !== true) {
    throw new TypeError(`${label} must be marked as a synthetic fixture.`);
  }
}

function assertConnectionState(value) {
  if (!CONNECTION_STATES.has(value)) {
    throw new TypeError('Connection state must be explicitly connected or disconnected.');
  }
  return value;
}

function assertUniqueValues(values, allowed, label) {
  if (!Array.isArray(values) || values.length === 0
      || values.some((value) => !allowed.has(value))
      || new Set(values).size !== values.length) {
    throw new TypeError(`${label} must be a non-empty, unique allowlist.`);
  }
  return Object.freeze([...values]);
}

function normalizeDevice(device) {
  if (!isRecord(device)) throw new TypeError('Device entries must be plain records.');
  assertSynthetic(device, 'Device');
  const deviceType = device.deviceType;
  if (!TYPES.has(deviceType)) throw new TypeError('Device type is not in the local allowlist.');
  return Object.freeze({
    organizationId: assertIdentifier(device.organizationId, 'Organization ID'),
    deviceId: assertIdentifier(device.deviceId, 'Device ID'),
    vendor: assertVendor(device.vendor),
    deviceType,
    connectionState: assertConnectionState(device.connectionState),
    synthetic: true,
  });
}

function normalizeCustomerMapping(mapping) {
  if (!isRecord(mapping)) throw new TypeError('Customer mappings must be plain records.');
  assertSynthetic(mapping, 'Customer mapping');
  if (mapping.mappingSource !== 'explicit') {
    throw new TypeError('Customer-to-device mappings must be explicit.');
  }
  return Object.freeze({
    organizationId: assertIdentifier(mapping.organizationId, 'Organization ID'),
    customerId: assertIdentifier(mapping.customerId, 'Customer ID'),
    deviceId: assertIdentifier(mapping.deviceId, 'Device ID'),
    mappingSource: 'explicit',
    synthetic: true,
  });
}

function normalizeAdapter(adapter) {
  if (!isRecord(adapter)) throw new TypeError('Adapter entries must be plain records.');
  assertSynthetic(adapter, 'Adapter');
  if (adapter.accessMode !== 'read-only') {
    throw new TypeError('Only explicitly declared read-only adapters are allowed.');
  }
  return Object.freeze({
    adapterId: assertIdentifier(adapter.adapterId, 'Adapter ID'),
    vendor: assertVendor(adapter.vendor),
    deviceTypes: assertUniqueValues(adapter.deviceTypes, TYPES, 'Adapter device types'),
    readOnlyCapabilities: assertUniqueValues(adapter.readOnlyCapabilities, CAPABILITIES, 'Adapter read-only capabilities'),
    accessMode: 'read-only',
    connectionState: assertConnectionState(adapter.connectionState),
    synthetic: true,
  });
}

function unavailable(reason = 'no-connected-device-or-approved-adapter') {
  const safeReason = UNAVAILABLE_REASONS.has(reason)
    ? reason
    : 'no-connected-device-or-approved-adapter';
  return Object.freeze({
    status: 'unavailable',
    reason: safeReason,
    message: UNAVAILABLE_MESSAGE,
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

/**
 * Creates an immutable in-memory registry for synthetic contract tests only.
 * It does not discover devices, connect adapters, or perform read operations.
 */
export function createSyntheticDeviceRegistry({ devices = [], customerMappings = [], adapters = [] } = {}) {
  if (!Array.isArray(devices) || !Array.isArray(customerMappings) || !Array.isArray(adapters)) {
    throw new TypeError('Registry collections must be arrays.');
  }
  const registry = Object.freeze({
    devices: Object.freeze(devices.map(normalizeDevice)),
    customerMappings: Object.freeze(customerMappings.map(normalizeCustomerMapping)),
    adapters: Object.freeze(adapters.map(normalizeAdapter)),
    syntheticOnly: true,
  });
  REGISTRIES.add(registry);
  return registry;
}

/**
 * Resolves metadata only. Exactly one of selectedDeviceId or customerId is
 * required; customer lookup follows one explicit, same-organization mapping.
 * No adapter method is invoked and no vendor response is accepted or returned.
 */
export function resolveSyntheticDeviceAdapter(registry, target) {
  if (!REGISTRIES.has(registry) || !isRecord(target)) return unavailable('invalid-target-selection');

  const { organizationId, selectedDeviceId, customerId, capability } = target;
  const hasSelectedDevice = selectedDeviceId !== undefined && selectedDeviceId !== null && selectedDeviceId !== '';
  const hasCustomer = customerId !== undefined && customerId !== null && customerId !== '';
  if (typeof organizationId !== 'string' || !IDENTIFIER_PATTERN.test(organizationId)
      || hasSelectedDevice === hasCustomer
      || (hasSelectedDevice && (typeof selectedDeviceId !== 'string' || !IDENTIFIER_PATTERN.test(selectedDeviceId)))
      || (hasCustomer && (typeof customerId !== 'string' || !IDENTIFIER_PATTERN.test(customerId)))) {
    return unavailable('invalid-target-selection');
  }
  if (typeof capability !== 'string' || !CAPABILITIES.has(capability)) {
    return unavailable('capability-not-declared-read-only');
  }

  let devices;
  if (hasSelectedDevice) {
    devices = registry.devices.filter((device) => (
      device.organizationId === organizationId && device.deviceId === selectedDeviceId
    ));
    if (devices.length === 0) return unavailable('no-exact-device-match');
    if (devices.length > 1) return unavailable('ambiguous-device-match');
  } else {
    const mappings = registry.customerMappings.filter((mapping) => (
      mapping.organizationId === organizationId && mapping.customerId === customerId
    ));
    if (mappings.length === 0) return unavailable('no-explicit-customer-mapping');
    if (mappings.length > 1) return unavailable('ambiguous-customer-mapping');
    devices = registry.devices.filter((device) => (
      device.organizationId === organizationId && device.deviceId === mappings[0].deviceId
    ));
    if (devices.length === 0) return unavailable('mapped-device-not-found');
    if (devices.length > 1) return unavailable('ambiguous-mapped-device-match');
  }

  const [device] = devices;
  if (device.connectionState !== 'connected') return unavailable('device-not-connected');

  const sameTypeAdapters = registry.adapters.filter((adapter) => (
    adapter.vendor === device.vendor && adapter.deviceTypes.includes(device.deviceType)
  ));
  if (sameTypeAdapters.length === 0) return unavailable('no-matching-read-only-adapter');
  const capableAdapters = sameTypeAdapters.filter((adapter) => (
    adapter.readOnlyCapabilities.includes(capability)
  ));
  if (capableAdapters.length === 0) return unavailable('capability-not-declared-read-only');
  if (capableAdapters.length > 1) return unavailable('ambiguous-adapter-match');

  const [adapter] = capableAdapters;
  if (adapter.connectionState !== 'connected') return unavailable('adapter-not-connected');

  return Object.freeze({
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
  });
}
