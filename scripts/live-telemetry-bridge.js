#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadLocalEnvironment,
  localRouterSyncInternals,
  readRouterActiveTelemetry,
  validateSupabaseConfig,
  verifySupabaseAdminAccess,
} from './local-router-sync.js';

const DEFAULT_INTERVAL_MS = 55_000;
const MIN_INTERVAL_MS = 45_000;
const MAX_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_ACTIVE_SESSIONS = 500;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_USERNAME_BYTES = 128;

export class TelemetryBridgeError extends Error {
  constructor(kind, message = kind) {
    super(message);
    this.name = 'TelemetryBridgeError';
    this.kind = kind;
  }
}

function parseBoundedInteger(value, fallback, { minimum, maximum, setting }) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(String(value))) {
    throw new Error(`${setting} must be an integer between ${minimum} and ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${setting} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function normalizeCounter(value) {
  let decimal;
  if (typeof value === 'bigint') {
    if (value < 0n) throw new TelemetryBridgeError('invalid-router-poll', 'RouterOS returned an invalid byte counter.');
    decimal = value.toString();
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TelemetryBridgeError('invalid-router-poll', 'RouterOS returned an invalid byte counter.');
    }
    decimal = String(value);
  } else if (typeof value === 'string' && /^\d{1,19}$/.test(value)) {
    decimal = BigInt(value).toString();
  } else {
    throw new TelemetryBridgeError('invalid-router-poll', 'RouterOS returned an invalid byte counter.');
  }
  if (BigInt(decimal) > MAX_INT64) {
    throw new TelemetryBridgeError('invalid-router-poll', 'RouterOS returned a byte counter outside the supported range.');
  }
  return decimal;
}

function parseTrafficCounters(record) {
  const separateTx = record['tx-byte'] ?? record.txBytes;
  const separateRx = record['rx-byte'] ?? record.rxBytes;
  if (separateTx !== undefined || separateRx !== undefined) {
    if (separateTx === undefined || separateRx === undefined) {
      throw new TelemetryBridgeError('invalid-router-poll', 'RouterOS returned an incomplete traffic counter pair.');
    }
    return [normalizeCounter(separateTx), normalizeCounter(separateRx)];
  }

  const bytes = record.bytes;
  let pair;
  if (Array.isArray(bytes) && bytes.length === 2) {
    pair = bytes;
  } else if (typeof bytes === 'string') {
    const match = /^(\d{1,19})\/(\d{1,19})$/.exec(bytes);
    if (match) pair = [match[1], match[2]];
  }
  if (!pair) throw new TelemetryBridgeError('invalid-router-poll', 'RouterOS returned an invalid traffic counter pair.');
  return [normalizeCounter(pair[0]), normalizeCounter(pair[1])];
}

function normalizeText(value, { field, required = false, maximum }) {
  const text = value === null || value === undefined ? '' : String(value);
  if ((required && !text) || text !== text.trim() || text.includes('\u0000') || Buffer.byteLength(text, 'utf8') > maximum) {
    throw new TelemetryBridgeError('invalid-router-poll', `RouterOS returned an invalid ${field}.`);
  }
  return text;
}

/**
 * RouterOS PPP active stats are tx/rx from the router's perspective. Tx is
 * customer download; Rx is customer upload. Counters are strings so int64
 * values are never rounded by JavaScript.
 */
export function normalizeActiveSession(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TelemetryBridgeError('invalid-router-poll', 'RouterOS returned an invalid active-session record.');
  }
  const username = normalizeText(record.name, { field: 'username', required: true, maximum: MAX_USERNAME_BYTES });
  const sessionId = normalizeText(record['session-id'], { field: 'session ID', required: true, maximum: 128 });
  const uptime = normalizeText(record.uptime, { field: 'uptime', required: true, maximum: 100 });
  const callerId = normalizeText(record['caller-id'], { field: 'caller ID', maximum: 255 });
  const ipAddress = normalizeText(record.address, { field: 'assigned IP address', required: true, maximum: 100 });
  const [txBytes, rxBytes] = parseTrafficCounters(record);
  return {
    username,
    session_id: sessionId,
    uptime,
    caller_id: callerId,
    ip_address: ipAddress,
    tx_bytes: txBytes,
    rx_bytes: rxBytes,
  };
}

export function normalizeActiveSessions(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_ACTIVE_SESSIONS) {
    throw new TelemetryBridgeError('invalid-router-poll', `RouterOS must return an array of at most ${MAX_ACTIVE_SESSIONS} active sessions.`);
  }
  const seen = new Set();
  return rows.map((row) => {
    const session = normalizeActiveSession(row);
    const key = `${session.username}\u0000${session.session_id}`;
    if (seen.has(key)) throw new TelemetryBridgeError('invalid-router-poll', 'RouterOS returned a duplicate active session.');
    seen.add(key);
    return session;
  });
}

export function validateBridgeTiming(env = {}) {
  return {
    intervalMs: parseBoundedInteger(env.LIVE_BRIDGE_INTERVAL_MS, DEFAULT_INTERVAL_MS, {
      minimum: MIN_INTERVAL_MS,
      maximum: MAX_INTERVAL_MS,
      setting: 'LIVE_BRIDGE_INTERVAL_MS',
    }),
    timeoutMs: parseBoundedInteger(env.LIVE_BRIDGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, {
      minimum: 1_000,
      maximum: MAX_TIMEOUT_MS,
      setting: 'LIVE_BRIDGE_TIMEOUT_MS',
    }),
  };
}

export async function pushLiveTelemetry({ supabase, organizationId, items, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const endpoint = new URL('/rest/v1/rpc/sync_live_router_telemetry', supabase.url);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        apikey: supabase.publishableKey,
        authorization: `Bearer ${supabase.adminAccessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ p_organization_id: organizationId, p_items: items }),
    });
  } catch {
    throw new TelemetryBridgeError('supabase-sync', 'Supabase telemetry sync could not be reached.');
  }
  if (!response.ok) {
    throw new TelemetryBridgeError('supabase-sync', `Supabase telemetry RPC failed with HTTP ${response.status}; confirm the reviewed migrations and owner/admin session.`);
  }
  try {
    return await response.json();
  } catch {
    throw new TelemetryBridgeError('supabase-sync', 'Supabase returned an invalid telemetry-sync response.');
  }
}

export async function runBridgeCycle({
  router,
  supabase,
  organizationId,
  fetchImpl = globalThis.fetch,
  readSessions = readRouterActiveTelemetry,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let items;
  try {
    const { address } = await localRouterSyncInternals.resolvePrivateRouterAddress(router.host);
    const rows = await readSessions(router, address);
    items = normalizeActiveSessions(rows);
  } catch (error) {
    if (error instanceof TelemetryBridgeError) throw error;
    if (/private-LAN addresses|private-LAN IP address/i.test(error?.message ?? '')) {
      throw new TelemetryBridgeError('router-address', 'RouterOS access is restricted to private-LAN addresses.');
    }
    throw new TelemetryBridgeError('router-poll', 'The private-LAN RouterOS poll failed or was incomplete.');
  }

  const result = await pushLiveTelemetry({ supabase, organizationId, items, fetchImpl, timeoutMs });
  return { sessions: items.length, result };
}

export function parseCliArgs(argv = []) {
  const args = [...argv];
  const help = args.length === 1 && (args[0] === '--help' || args[0] === '-h');
  if (help) return { help: true };
  if (args.length) throw new Error(`Unknown argument: ${args[0]}`);
  return { help: false };
}

function usage() {
  return [
    'Live RouterOS-to-Supabase telemetry bridge',
    '',
    'Usage:',
    '  npm run live:bridge',
    '',
    'Reads PPP active-session stats from a private-LAN router and syncs a complete snapshot every 55 seconds.',
    'Requires .env.router.local, an owner/admin Supabase user session, and the reviewed telemetry migrations.',
    'The bridge never changes RouterOS configuration or uses a Supabase service-role key.',
  ].join('\n');
}

export async function runLiveTelemetryBridge({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  processEnv = process.env,
  fetchImpl = globalThis.fetch,
  output = console,
  sleepImpl = (milliseconds, options) => sleep(milliseconds, undefined, options),
} = {}) {
  const options = parseCliArgs(argv);
  if (options.help) {
    output.log(usage());
    return { help: true };
  }

  const env = await loadLocalEnvironment({ cwd, processEnv });
  const router = localRouterSyncInternals.validateRouterConfig(env);
  const supabase = validateSupabaseConfig(env);
  const timing = validateBridgeTiming(env);
  await verifySupabaseAdminAccess(supabase, fetchImpl);

  output.log(`Live telemetry bridge started; polling every ${Math.round(timing.intervalMs / 1000)} seconds. Press Ctrl+C to stop.`);
  let stopping = false;
  let sleepController;
  const stop = () => {
    stopping = true;
    sleepController?.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopping) {
      const cycleStartedAt = Date.now();
      try {
        const result = await runBridgeCycle({
          router,
          supabase,
          organizationId: supabase.organizationId,
          fetchImpl,
          timeoutMs: timing.timeoutMs,
        });
        output.log(JSON.stringify({ event: 'telemetry_sync_complete', sessions: result.sessions }));
      } catch (error) {
        const reason = error instanceof TelemetryBridgeError ? error.kind : 'unexpected';
        (output.error ?? output.log).call(output, JSON.stringify({ event: 'telemetry_sync_failed', reason }));
      }
      const waitMs = Math.max(0, timing.intervalMs - (Date.now() - cycleStartedAt));
      if (!stopping && waitMs > 0) {
        sleepController = new AbortController();
        try {
          await sleepImpl(waitMs, { signal: sleepController.signal });
        } catch (error) {
          if (!stopping) throw error;
        } finally {
          sleepController = undefined;
        }
      }
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  return { stopped: true };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runLiveTelemetryBridge().catch((error) => {
    console.error(`Live telemetry bridge stopped: ${error?.message || 'configuration error'}`);
    process.exitCode = 1;
  });
}
