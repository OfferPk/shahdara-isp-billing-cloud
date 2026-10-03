const MAX_BIGINT = 9_223_372_036_854_775_807n;
const MAX_USERNAME_BYTES = 128;
const MAX_BATCH_ITEMS = 100;
const MAX_BODY_BYTES = 64 * 1024;
const UINT32_MAX = 4_294_967_295n;
const UINT32_BASE = 4_294_967_296n;
const COUNTER_ENCODINGS = new Set(['octets+gigawords', 'expanded-64']);

export class RadiusAdapterFailure extends Error {
  constructor(kind) {
    super(kind);
    this.name = 'RadiusAdapterFailure';
    this.kind = kind;
  }
}

function fail(kind) {
  throw new RadiusAdapterFailure(kind);
}

function strictUsername(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || value.includes('\u0000')
    || Buffer.byteLength(value, 'utf8') > MAX_USERNAME_BYTES) {
    fail('invalid-username');
  }
  return value;
}

function parseUnsignedInteger(value, kind = 'invalid-counter') {
  let decimal;
  if (typeof value === 'bigint' && value >= 0n) {
    decimal = value.toString();
  } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    decimal = String(value);
  } else if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value)) {
    decimal = value;
  } else {
    fail(kind);
  }
  const parsed = BigInt(decimal);
  if (parsed > MAX_BIGINT) fail(kind);
  return parsed;
}

function counterFromRow(octetsValue, gigawordsValue, encoding) {
  const octets = parseUnsignedInteger(octetsValue);
  if (encoding === 'expanded-64') return octets;
  if (encoding !== 'octets+gigawords') fail('unverified-counter-encoding');
  const gigawords = parseUnsignedInteger(gigawordsValue);
  if (octets > UINT32_MAX || gigawords > UINT32_MAX) fail('invalid-counter');
  const counter = gigawords * UINT32_BASE + octets;
  if (counter > MAX_BIGINT) fail('invalid-counter');
  return counter;
}

function instant(value, kind = 'invalid-timestamp') {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    fail(kind);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(kind);
  return new Date(parsed).toISOString();
}

function normalizeInterval(interval) {
  if (!interval || typeof interval !== 'object') fail('invalid-interval');
  const periodStart = instant(interval.periodStart, 'invalid-interval');
  const periodEnd = instant(interval.periodEnd, 'invalid-interval');
  const asOf = instant(interval.asOf, 'invalid-interval');
  if (Date.parse(periodStart) >= Date.parse(periodEnd)) fail('invalid-interval');
  return { periodStart, periodEnd, asOf };
}

function requiredText(value, kind = 'invalid-session-record') {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) fail(kind);
  return value;
}

function normalizeSessionRow(row, { sourceId, counterEncoding }) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('invalid-session-record');
  const username = strictUsername(row.username);
  const acctUniqueId = requiredText(row.acctuniqueid);
  const acctSessionId = requiredText(row.acctsessionid);
  const nasIdentity = requiredText(row.nasipaddress);
  const startedAt = instant(row.acctstarttime);
  const stoppedAt = row.acctstoptime == null ? null : instant(row.acctstoptime);
  const updatedAt = row.acctupdatetime == null ? null : instant(row.acctupdatetime);
  if (stoppedAt && Date.parse(stoppedAt) < Date.parse(startedAt)) fail('invalid-session-time-order');
  if (updatedAt && Date.parse(updatedAt) < Date.parse(startedAt)) fail('invalid-session-time-order');
  return {
    sourceId,
    nasIdentity,
    acctUniqueId,
    acctSessionId,
    username,
    startedAt,
    stoppedAt,
    updatedAt,
    inputBytes: counterFromRow(row.acctinputoctets, row.acctinputgigawords, counterEncoding),
    outputBytes: counterFromRow(row.acctoutputoctets, row.acctoutputgigawords, counterEncoding),
  };
}

function sessionKey(session) {
  return JSON.stringify([session.sourceId, session.nasIdentity, session.acctUniqueId]);
}

function observationTime(session) {
  return Date.parse(session.updatedAt ?? session.stoppedAt ?? session.startedAt);
}

function sameIdentity(left, right) {
  return left.acctSessionId === right.acctSessionId
    && left.username === right.username
    && left.startedAt === right.startedAt;
}

function sameCounters(left, right) {
  return left.inputBytes === right.inputBytes && left.outputBytes === right.outputBytes;
}

/**
 * Pick one cumulative observation per accounting session. This is deliberately
 * not a sum: radacct octet counters are latest session totals, not time deltas.
 */
export function deduplicateRadacctSnapshots(snapshots) {
  if (!Array.isArray(snapshots)) fail('invalid-session-record');
  const bySession = new Map();
  for (const snapshot of snapshots) {
    const key = sessionKey(snapshot);
    const previous = bySession.get(key);
    if (!previous) {
      bySession.set(key, snapshot);
      continue;
    }
    if (!sameIdentity(previous, snapshot)) fail('conflicting-session-identity');

    const previousTime = observationTime(previous);
    const currentTime = observationTime(snapshot);
    if (previous.stoppedAt && !snapshot.stoppedAt && currentTime > previousTime) {
      fail('interim-after-stop');
    }
    if (snapshot.stoppedAt && !previous.stoppedAt && previousTime > currentTime) {
      fail('stop-before-later-interim');
    }
    if (previousTime === currentTime) {
      if (!sameCounters(previous, snapshot)) fail('conflicting-session-observation');
      if (snapshot.stoppedAt && !previous.stoppedAt) bySession.set(key, snapshot);
      continue;
    }
    bySession.set(key, currentTime > previousTime ? snapshot : previous);
  }
  return [...bySession.values()].sort((left, right) => (
    left.username.localeCompare(right.username)
    || left.acctUniqueId.localeCompare(right.acctUniqueId)
  ));
}

function buildSessionSql(counterEncoding, placeholderStyle) {
  if (!COUNTER_ENCODINGS.has(counterEncoding)) fail('unverified-counter-encoding');
  const bind = placeholderStyle === 'numbered'
    ? ['$1', '$2', '$3']
    : placeholderStyle === 'question'
      ? ['?', '?', '?']
      : null;
  if (!bind) fail('unsupported-placeholder-style');
  const gigawordColumns = counterEncoding === 'octets+gigawords'
    ? ',\n  r.acctinputgigawords,\n  r.acctoutputgigawords'
    : '';
  return `SELECT\n  r.acctuniqueid,\n  r.acctsessionid,\n  r.username,\n  r.nasipaddress,\n  r.acctstarttime,\n  r.acctstoptime,\n  r.acctupdatetime,\n  r.acctinputoctets,\n  r.acctoutputoctets${gigawordColumns}\nFROM radacct AS r\nWHERE r.acctstarttime < ${bind[0]}\n  AND r.acctstarttime < ${bind[1]}\n  AND (r.acctstoptime IS NULL OR r.acctstoptime >= ${bind[2]})\nORDER BY r.username, r.acctuniqueid`;
}

function rowsFromDriverResult(result) {
  if (Array.isArray(result)) {
    // mysql2 execute/query commonly returns [rows, fields]. A plain row array is
    // also accepted for small drivers and test doubles.
    if (result.length === 2 && Array.isArray(result[0]) && !Object.hasOwn(result[0], 'username')) {
      return result[0];
    }
    return result;
  }
  if (result && Array.isArray(result.rows)) return result.rows;
  fail('invalid-database-result');
}

/**
 * Read candidate radacct session snapshots using only a SELECT and bound values.
 * The caller must verify the installed schema, read-only principal, driver
 * placeholder style, timezone conversion, and counter encoding before use.
 */
export function createRadacctSqlAdapter({
  sqlClient,
  sourceId,
  counterEncoding,
  placeholderStyle = 'question',
}) {
  if (!sqlClient || (typeof sqlClient.execute !== 'function' && typeof sqlClient.query !== 'function')) {
    throw new TypeError('A SQL client with execute() or query() is required.');
  }
  const normalizedSourceId = requiredText(sourceId, 'invalid-source-id');
  if (!COUNTER_ENCODINGS.has(counterEncoding)) fail('unverified-counter-encoding');
  const sql = buildSessionSql(counterEncoding, placeholderStyle);
  const queryMethod = typeof sqlClient.execute === 'function' ? sqlClient.execute : sqlClient.query;

  return Object.freeze({
    async readSessionSnapshots(intervalInput) {
      const interval = normalizeInterval(intervalInput);
      const parameters = [interval.periodEnd, interval.asOf, interval.periodStart];
      const result = await queryMethod.call(sqlClient, sql, parameters);
      const rows = rowsFromDriverResult(result);
      const normalized = rows.map((row) => normalizeSessionRow(row, {
        sourceId: normalizedSourceId,
        counterEncoding,
      }));
      return deduplicateRadacctSnapshots(normalized);
    },
  });
}

function parsePeriodCounter(value) {
  return parseUnsignedInteger(value, 'invalid-period-counter');
}

/**
 * Aggregate only already-finalized records returned by a separately verified
 * period-accounting source. Stock radacct session snapshots are not accepted.
 * Period rows crossing either half-open billing boundary fail closed.
 */
export function aggregateClosedPeriodUsage(rows, intervalInput) {
  if (!Array.isArray(rows)) fail('invalid-period-record');
  const { periodStart, periodEnd } = normalizeInterval({
    ...intervalInput,
    asOf: intervalInput?.asOf ?? intervalInput?.periodEnd,
  });
  const startMs = Date.parse(periodStart);
  const endMs = Date.parse(periodEnd);
  const totals = new Map();

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('invalid-period-record');
    const username = strictUsername(row.username);
    const rowStart = instant(row.periodStart, 'invalid-period-record');
    if (row.periodEnd == null) {
      if (Date.parse(rowStart) < endMs) fail('open-period-overlaps-request');
      continue;
    }
    const rowEnd = instant(row.periodEnd, 'invalid-period-record');
    const rowStartMs = Date.parse(rowStart);
    const rowEndMs = Date.parse(rowEnd);
    if (rowStartMs >= rowEndMs) fail('invalid-period-record');
    if (rowEndMs <= startMs || rowStartMs >= endMs) continue;
    if (rowStartMs < startMs || rowEndMs > endMs) fail('ambiguous-period-boundary');

    const inputBytes = parsePeriodCounter(row.inputBytes);
    const outputBytes = parsePeriodCounter(row.outputBytes);
    const previous = totals.get(username) ?? { inputBytes: 0n, outputBytes: 0n };
    const nextInput = previous.inputBytes + inputBytes;
    const nextOutput = previous.outputBytes + outputBytes;
    if (nextInput > MAX_BIGINT || nextOutput > MAX_BIGINT) fail('invalid-period-counter');
    totals.set(username, { inputBytes: nextInput, outputBytes: nextOutput });
  }

  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([username, total]) => ({
      username,
      periodStart,
      periodEnd,
      inputBytes: total.inputBytes,
      outputBytes: total.outputBytes,
      semantics: 'closed-period-aggregate',
    }));
}

function normalizeIngestCounter(value) {
  return parseUnsignedInteger(value).toString();
}

/** Map only explicit subscriber-cumulative snapshots to the existing API shape. */
export function mapSubscriberCumulativeToIngestRequest(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || source.counterScope !== 'subscriber_cumulative'
    || !Array.isArray(source.items)
    || source.items.length > MAX_BATCH_ITEMS) {
    fail('cumulative-snapshot-required');
  }
  const sourceKeys = Object.keys(source).sort();
  if (sourceKeys.length !== 2 || sourceKeys[0] !== 'counterScope' || sourceKeys[1] !== 'items') {
    fail('cumulative-snapshot-required');
  }
  const seen = new Set();
  const items = source.items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('invalid-cumulative-snapshot');
    const itemKeys = Object.keys(item).sort();
    if (itemKeys.length !== 4
      || itemKeys[0] !== 'bytes_in'
      || itemKeys[1] !== 'bytes_out'
      || itemKeys[2] !== 'is_online'
      || itemKeys[3] !== 'username') fail('invalid-cumulative-snapshot');
    const username = strictUsername(item.username);
    if (seen.has(username)) fail('duplicate-username');
    if (typeof item.is_online !== 'boolean') fail('invalid-cumulative-snapshot');
    seen.add(username);
    return {
      username,
      bytes_in: normalizeIngestCounter(item.bytes_in),
      bytes_out: normalizeIngestCounter(item.bytes_out),
      is_online: item.is_online,
    };
  });
  const request = { counter_scope: 'subscriber_cumulative', items };
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > MAX_BODY_BYTES) fail('ingest-payload-too-large');
  return request;
}

/**
 * Use the existing narrow client contract for real cumulative snapshots only.
 * The adapter never posts period aggregates or radacct session observations.
 */
export async function postSubscriberCumulativeSnapshots(syncIngestClient, source) {
  if (!syncIngestClient || typeof syncIngestClient.postCumulativeSnapshot !== 'function') {
    throw new TypeError('A sync-ingest client with postCumulativeSnapshot() is required.');
  }
  const request = mapSubscriberCumulativeToIngestRequest(source);
  return syncIngestClient.postCumulativeSnapshot(request);
}


/** Build the local HTTP client with the dedicated ingest bearer, never service_role. */
export function createSyncAgentIngestClient({
  ingestUrl,
  bearerToken,
  fetchImpl = fetch,
  requestTimeoutMs = 10_000,
}) {
  let endpoint;
  try {
    endpoint = new URL(ingestUrl);
  } catch {
    throw new TypeError('A valid HTTPS sync-ingest URL is required.');
  }
  if (endpoint.protocol !== 'https:'
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || endpoint.pathname !== '/functions/v1/sync-agent-ingest') {
    throw new TypeError('A valid HTTPS sync-ingest URL is required.');
  }
  if (typeof bearerToken !== 'string'
    || bearerToken.length < 32
    || bearerToken.length > 256
    || !/^[\x21-\x7e]+$/.test(bearerToken)) {
    throw new TypeError('A valid dedicated sync-ingest bearer token is required.');
  }
  if (typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(requestTimeoutMs)
    || requestTimeoutMs < 100
    || requestTimeoutMs > 60_000) {
    throw new TypeError('Invalid sync-ingest client configuration.');
  }

  return Object.freeze({
    async postCumulativeSnapshot(payload) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        fail('cumulative-snapshot-required');
      }
      const keys = Object.keys(payload).sort();
      if (keys.length !== 2 || keys[0] !== 'counter_scope' || keys[1] !== 'items') {
        fail('cumulative-snapshot-required');
      }
      const normalized = mapSubscriberCumulativeToIngestRequest({
        counterScope: payload.counter_scope,
        items: payload.items,
      });
      let response;
      try {
        response = await fetchImpl(endpoint.toString(), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(normalized),
          redirect: 'manual',
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
      } catch {
        fail('ingest-unavailable');
      }
      if (!response?.ok) fail('ingest-unavailable');
      return { accepted: normalized.items.length };
    },
  });
}
