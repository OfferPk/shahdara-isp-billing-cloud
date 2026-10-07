import { MockRouterAdapter } from './pppoe-mock-adapter.js';

const browserMockAdapter = new MockRouterAdapter();

export function resolvePppoeApiBase({
  config = globalThis.window?.__CONFIG__,
  envBase = import.meta.env?.VITE_PPPOE_API_BASE_URL,
} = {}) {
  return String(config?.API_URL || envBase || '').trim().replace(/\/+$/, '');
}

export function isGithubPagesStaticHost({ apiBaseUrl = '', hostname = globalThis.window?.location?.hostname ?? '' } = {}) {
  const host = String(hostname).trim().toLowerCase();
  return !String(apiBaseUrl).trim() && (host === 'github.io' || host.endsWith('.github.io'));
}

export class PppoeApiUnavailableError extends Error {
  constructor(message = 'The PPPoE API service is unavailable.') {
    super(message);
    this.name = 'PppoeApiUnavailableError';
  }
}

async function readApiJson(fetchImpl, url, token, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
    });
  } catch {
    throw new PppoeApiUnavailableError();
  }

  if (response.status === 404) throw new PppoeApiUnavailableError();
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The PPPoE API returned an invalid response.');
  }
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Live router data could not be loaded.');
  }
  return payload;
}

export async function discoverRouterSubscribers({
  organizationId,
  token,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = resolvePppoeApiBase(),
} = {}) {
  if (!token) throw new Error('Sign in again to import router subscribers.');
  if (typeof fetchImpl !== 'function') throw new Error('This browser does not support API requests.');
  const base = String(apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  const suffix = `?organizationId=${encodeURIComponent(organizationId ?? '')}`;
  return readApiJson(fetchImpl, `${base}/api/admin/subscribers/discover${suffix}`, token);
}

export async function importRouterSubscribers({
  organizationId,
  token,
  usernames,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = resolvePppoeApiBase(),
} = {}) {
  if (!token) throw new Error('Sign in again to import router subscribers.');
  if (typeof fetchImpl !== 'function') throw new Error('This browser does not support API requests.');
  const base = String(apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  const suffix = `?organizationId=${encodeURIComponent(organizationId ?? '')}`;
  return readApiJson(fetchImpl, `${base}/api/admin/subscribers/import${suffix}`, token, {
    method: 'POST',
    body: { usernames: Array.isArray(usernames) ? usernames : [] },
  });
}

export async function fetchCustomerLiveTraffic({
  token,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = resolvePppoeApiBase(),
} = {}) {
  if (!token) throw new Error('Sign in again to view your live traffic.');
  if (typeof fetchImpl !== 'function') throw new Error('This browser does not support API requests.');
  const base = String(apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  return readApiJson(fetchImpl, `${base}/api/customer/live-traffic`, token);
}

function sumOnlineTraffic(sessions) {
  return sessions.reduce((totals, session) => {
    if (session.status !== 'Online') return totals;
    try { totals.bytesIn += BigInt(String(session.bytesIn ?? 0)); } catch { /* Ignore malformed synthetic counters. */ }
    try { totals.bytesOut += BigInt(String(session.bytesOut ?? 0)); } catch { /* Ignore malformed synthetic counters. */ }
    return totals;
  }, { bytesIn: 0n, bytesOut: 0n });
}

async function readMockTelemetry(adapter) {
  const [sessions, health] = await Promise.all([
    adapter.getActiveSessions(),
    adapter.getRouterHealth(),
  ]);
  const activeSessions = sessions.filter((session) => session.status === 'Online');
  const traffic = sumOnlineTraffic(activeSessions);
  return {
    sessions,
    totalActiveUsers: activeSessions.length,
    totalTraffic: { bytesIn: traffic.bytesIn.toString(), bytesOut: traffic.bytesOut.toString() },
    health,
  };
}

/**
 * Fetches both protected routes. Only a missing/unreachable API falls back to
 * synthetic in-browser data; HTTP authorization and service errors stay visible.
 */
export async function fetchPppoeTelemetry({
  organizationId,
  token,
  fetchImpl = globalThis.fetch,
  apiBaseUrl = resolvePppoeApiBase(),
  hostname = globalThis.window?.location?.hostname ?? '',
  mockAdapter = browserMockAdapter,
  staticPages = isGithubPagesStaticHost({ apiBaseUrl, hostname }),
} = {}) {
  if (!token) throw new Error('Sign in again to view live router data.');
  if (typeof fetchImpl !== 'function') throw new Error('This browser does not support API requests.');

  if (staticPages) {
    return { ...(await readMockTelemetry(mockAdapter)), source: 'mock', fallbackReason: 'static-host' };
  }

  const suffix = `?organizationId=${encodeURIComponent(organizationId ?? '')}`;
  const base = String(apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  const results = await Promise.allSettled([
    readApiJson(fetchImpl, `${base}/api/admin/pppoe/sessions${suffix}`, token),
    readApiJson(fetchImpl, `${base}/api/admin/pppoe/router-health${suffix}`, token),
  ]);
  const failures = results.filter((result) => result.status === 'rejected');
  const hardFailure = failures.find((result) => !(result.reason instanceof PppoeApiUnavailableError));
  if (hardFailure) throw hardFailure.reason;
  if (failures.length) {
    return { ...(await readMockTelemetry(mockAdapter)), source: 'mock', fallbackReason: 'api-unavailable' };
  }

  const [sessionData, healthData] = results.map((result) => result.value);
  return {
    sessions: Array.isArray(sessionData.sessions) ? sessionData.sessions : [],
    totalActiveUsers: Number(sessionData.totalActiveUsers) || 0,
    totalTraffic: sessionData.totalTraffic ?? { bytesIn: '0', bytesOut: '0' },
    health: healthData,
    source: 'api',
  };
}
