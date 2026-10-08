import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BIGINT = 9_223_372_036_854_775_807n;
const MAX_USERNAME_BYTES = 128;
const DEFAULTS = Object.freeze({
  pollIntervalMs: 60_000,
  requestTimeoutMs: 10_000,
  maxRetries: 3,
  maxBackoffMs: 30_000,
});

export class AgentFailure extends Error {
  constructor(kind) {
    super(kind);
    this.name = 'AgentFailure';
    this.kind = kind;
  }
}

function parseIntegerSetting(value, fallback, { minimum, maximum }) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value))) throw new TypeError('invalid-setting');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError('invalid-setting');
  }
  return parsed;
}

function parseHttpsUrl(value, { rootOnly = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('invalid-url');
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (rootOnly && parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new TypeError('invalid-url');
  }
  return parsed;
}

function isStrongSecret(value) {
  return typeof value === 'string'
    && value.length >= 32
    && value.length <= 256
    && /^[\x21-\x7e]+$/.test(value);
}

export function loadConfig(env = process.env) {
  const routerBaseUrl = parseHttpsUrl(env.ROUTEROS_BASE_URL, { rootOnly: true });
  const ingestUrl = parseHttpsUrl(env.SYNC_INGEST_URL);
  const routerUsername = env.ROUTEROS_USERNAME;
  const routerPassword = env.ROUTEROS_PASSWORD;
  const ingestToken = env.SYNC_AGENT_INGEST_TOKEN;
  if (typeof routerUsername !== 'string' || routerUsername.length === 0 || routerUsername.includes(':')
    || typeof routerPassword !== 'string' || routerPassword.length === 0
    || !isStrongSecret(ingestToken)) {
    throw new TypeError('invalid-credentials');
  }

  return Object.freeze({
    routerBaseUrl: routerBaseUrl.origin,
    routerUsername,
    routerPassword,
    ingestUrl: ingestUrl.toString(),
    ingestToken,
    pollIntervalMs: parseIntegerSetting(env.POLL_INTERVAL_MS, DEFAULTS.pollIntervalMs, {
      minimum: 1_000,
      maximum: 86_400_000,
    }),
    requestTimeoutMs: parseIntegerSetting(env.REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs, {
      minimum: 100,
      maximum: 60_000,
    }),
    maxRetries: parseIntegerSetting(env.MAX_RETRIES, DEFAULTS.maxRetries, {
      minimum: 0,
      maximum: 5,
    }),
    maxBackoffMs: parseIntegerSetting(env.MAX_BACKOFF_MS, DEFAULTS.maxBackoffMs, {
      minimum: 500,
      maximum: 300_000,
    }),
  });
}

function normalizeCounter(value) {
  let decimal;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new AgentFailure('invalid-counter');
    decimal = String(value);
  } else if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value)) {
    decimal = value;
  } else if (typeof value === 'bigint' && value >= 0n) {
    decimal = value.toString();
  } else {
    throw new AgentFailure('invalid-counter');
  }
  try {
    const parsed = BigInt(decimal);
    if (parsed > MAX_BIGINT) throw new AgentFailure('invalid-counter');
    return parsed.toString();
  } catch (error) {
    if (error instanceof AgentFailure) throw error;
    throw new AgentFailure('invalid-counter');
  }
}

function validateUsername(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value.includes('\u0000')
    || Buffer.byteLength(value, 'utf8') > MAX_USERNAME_BYTES) {
    throw new AgentFailure('invalid-username');
  }
  return value;
}

function parseRouterOsBytePair(value) {
  if (Array.isArray(value) && value.length === 2) return value;
  if (typeof value === 'string') {
    const match = /^(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/.exec(value);
    if (match) return [match[1], match[2]];
  }
  throw new AgentFailure('invalid-session-counters');
}

function validateSessionId(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || value.includes('\u0000') || Buffer.byteLength(value, 'utf8') > 128) {
    throw new AgentFailure('invalid-session-record');
  }
  return value;
}

/**
 * RouterOS PPP active byte pairs are directional from the router's point of
 * view: transmitted bytes are subscriber download (RPC bytes_in), received
 * bytes are subscriber upload (RPC bytes_out). These are per-connection values.
 */
export function normalizeRouterOsActiveSession(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new AgentFailure('invalid-session-record');
  }
  const username = validateUsername(record.name);
  const sessionId = validateSessionId(record['session-id']);
  const [routerTransmitted, routerReceived] = parseRouterOsBytePair(record.bytes);
  return {
    username,
    session_id: sessionId,
    bytes_in: normalizeCounter(routerTransmitted),
    bytes_out: normalizeCounter(routerReceived),
  };
}

function normalizeSessionDeltaSnapshot(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new AgentFailure('invalid-session-record');
  }
  return {
    username: validateUsername(record.username),
    session_id: validateSessionId(record.session_id),
    bytes_in: normalizeCounter(record.bytes_in),
    bytes_out: normalizeCounter(record.bytes_out),
  };
}

function emit(logger, level, event, details = {}) {
  const method = logger?.[level];
  if (typeof method === 'function') method.call(logger, JSON.stringify({ event, ...details }));
}

function retryDelay(attempt, maxBackoffMs, random) {
  const cap = Math.min(maxBackoffMs, 1_000 * (2 ** attempt));
  const fraction = Math.max(0, Math.min(1, Number(random())));
  return Math.floor(cap * fraction);
}

export async function fetchWithRetry(url, options, {
  fetchImpl = fetch,
  timeoutMs = DEFAULTS.requestTimeoutMs,
  maxRetries = DEFAULTS.maxRetries,
  maxBackoffMs = DEFAULTS.maxBackoffMs,
  random = Math.random,
  sleepImpl = (milliseconds) => sleep(milliseconds),
} = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const kind = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network';
      if (attempt >= maxRetries) throw new AgentFailure(kind);
      await sleepImpl(retryDelay(attempt, maxBackoffMs, random));
      continue;
    }

    if (response?.ok) return response;
    const status = Number(response?.status);
    const retryable = status === 429 || status >= 500;
    if (!retryable || attempt >= maxRetries) throw new AgentFailure('http');
    await sleepImpl(retryDelay(attempt, maxBackoffMs, random));
  }
  throw new AgentFailure('network');
}

function routerAuthorization(config) {
  return `Basic ${Buffer.from(`${config.routerUsername}:${config.routerPassword}`, 'utf8').toString('base64')}`;
}

export async function pollRouterOsActive({
  config,
  fetchImpl = fetch,
  timeoutMs = config.requestTimeoutMs,
  maxRetries = config.maxRetries,
  maxBackoffMs = config.maxBackoffMs,
  random = Math.random,
  sleepImpl = (milliseconds) => sleep(milliseconds),
} = {}) {
  const url = new URL('/rest/ppp/active', config.routerBaseUrl);
  url.searchParams.set('.proplist', 'name,bytes,session-id');
  const response = await fetchWithRetry(url, {
    method: 'GET',
    headers: {
      Authorization: routerAuthorization(config),
      Accept: 'application/json',
    },
    redirect: 'manual',
  }, { fetchImpl, timeoutMs, maxRetries, maxBackoffMs, random, sleepImpl });

  let records;
  try {
    records = await response.json();
  } catch {
    throw new AgentFailure('invalid-router-response');
  }
  if (!Array.isArray(records)) throw new AgentFailure('invalid-router-response');
  const items = records.map(normalizeRouterOsActiveSession);
  return { complete: true, counterScope: 'routeros-session-delta', items };
}

export async function runSyncCycle({ pollSnapshots, publishSnapshots, logger = console }) {
  const poll = await pollSnapshots();
  if (!poll || poll.complete !== true || !Array.isArray(poll.items)) {
    throw new AgentFailure('incomplete-poll');
  }

  if (poll.items.length === 0) {
    // Empty means a successful poll found no active session. It is not enough
    // to safely publish offline rows because the RPC also requires cumulative bytes.
    emit(logger, 'info', 'sync_poll_complete', { sessions: 0, synced: 0, outcome: 'empty' });
    return { status: 'empty', sessions: 0, synced: 0 };
  }

  if (poll.counterScope !== 'routeros-session-delta') {
    emit(logger, 'warn', 'sync_skipped', {
      sessions: poll.items.length,
      synced: 0,
      reason: 'counter_source_not_routeros_session_delta',
    });
    return { status: 'blocked-counter-semantics', sessions: poll.items.length, synced: 0 };
  }

  const items = poll.items.map(normalizeSessionDeltaSnapshot);
  const sessions = new Set();
  for (const item of items) {
    const key = `${item.username}\u0000${item.session_id}`;
    if (sessions.has(key)) throw new AgentFailure('duplicate-session');
    sessions.add(key);
  }
  if (typeof publishSnapshots !== 'function') throw new AgentFailure('ingest-not-configured');
  await publishSnapshots({ counter_scope: 'routeros-session-delta', items });
  emit(logger, 'info', 'sync_poll_complete', {
    sessions: items.length,
    synced: items.length,
    outcome: 'session_deltas_published',
  });
  return { status: 'published', sessions: items.length, synced: items.length };
}

export function createAgent(config, {
  fetchImpl = fetch,
  pollSnapshots,
  logger = console,
  random = Math.random,
  sleepImpl = (milliseconds) => sleep(milliseconds),
} = {}) {
  const retryOptions = {
    fetchImpl,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    maxBackoffMs: config.maxBackoffMs,
    random,
    sleepImpl,
  };
  const poll = pollSnapshots ?? (() => pollRouterOsActive({ config, ...retryOptions }));
  const publish = async (payload) => {
    const response = await fetchWithRetry(config.ingestUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ingestToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      redirect: 'manual',
    }, retryOptions);
    // Do not read or log the broker response body; it contains no useful detail
    // for this client and should not become an accidental log channel.
    return response.ok;
  };
  return {
    runCycle: () => runSyncCycle({ pollSnapshots: poll, publishSnapshots: publish, logger }),
  };
}

export async function startAgent(config, { logger = console, sleepImpl = (milliseconds) => sleep(milliseconds) } = {}) {
  const agent = createAgent(config, { logger });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (!stopping) {
      try {
        await agent.runCycle();
      } catch (error) {
        emit(logger, 'error', 'sync_cycle_failed', {
          reason: error instanceof AgentFailure ? error.kind : 'unexpected',
        });
      }
      if (!stopping) await sleepImpl(config.pollIntervalMs);
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch {
    console.error(JSON.stringify({ event: 'agent_start_failed', reason: 'invalid_or_missing_configuration' }));
    process.exitCode = 1;
    return;
  }
  await startAgent(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
