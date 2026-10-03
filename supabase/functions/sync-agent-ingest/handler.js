const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH_ITEMS = 100;
const MAX_USERNAME_BYTES = 128;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const utf8 = new TextEncoder();

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
    },
  });
}

function constantTimeEqual(leftValue, rightValue) {
  const left = utf8.encode(leftValue);
  const right = utf8.encode(rightValue);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function isStrongBearerSecret(value) {
  return typeof value === 'string'
    && value.length >= 32
    && value.length <= 256
    && /^[\x21-\x7e]+$/.test(value);
}

function bearerToken(request) {
  const value = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([\x21-\x7e]{1,256})$/.exec(value);
  return match?.[1] ?? '';
}

async function readBoundedJson(request) {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) return { ok: false, status: 400 };
    if (Number(declaredLength) > MAX_BODY_BYTES) return { ok: false, status: 413 };
  }
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) {
    return { ok: false, status: 415 };
  }
  if (!request.body) return { ok: false, status: 400 };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
}

function normalizeBigint(value) {
  let decimal;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    decimal = String(value);
  } else if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value)) {
    decimal = value;
  } else {
    return null;
  }

  try {
    const parsed = BigInt(decimal);
    return parsed <= MAX_BIGINT ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function normalizePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const topKeys = Object.keys(value).sort();
  if (topKeys.length !== 2 || topKeys[0] !== 'counter_scope' || topKeys[1] !== 'items') return null;
  if (value.counter_scope !== 'subscriber_cumulative') return null;
  if (!Array.isArray(value.items) || value.items.length > MAX_BATCH_ITEMS) return null;

  const seen = new Set();
  const items = [];
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const keys = Object.keys(item).sort();
    if (keys.length !== 4
      || keys[0] !== 'bytes_in'
      || keys[1] !== 'bytes_out'
      || keys[2] !== 'is_online'
      || keys[3] !== 'username') return null;

    const username = item.username;
    if (typeof username !== 'string'
      || username.length === 0
      || username !== username.trim()
      || username.includes('\u0000')
      || utf8.encode(username).byteLength > MAX_USERNAME_BYTES
      || seen.has(username)) return null;
    if (typeof item.is_online !== 'boolean') return null;

    const bytesIn = normalizeBigint(item.bytes_in);
    const bytesOut = normalizeBigint(item.bytes_out);
    if (bytesIn === null || bytesOut === null) return null;

    seen.add(username);
    items.push({
      p_username: username,
      p_bytes_in: bytesIn,
      p_bytes_out: bytesOut,
      p_is_online: item.is_online,
      // RouterOS IPs are intentionally not retained by this integration.
      p_last_ip: null,
    });
  }
  return items;
}

function supabaseRpcUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')) return null;
  return new URL('/rest/v1/rpc/sync_customer_bandwidth_usage', parsed).toString();
}

export function createSyncAgentIngestHandler({ env, fetchImpl = fetch }) {
  if (!env || typeof env.get !== 'function') throw new TypeError('An environment reader is required.');

  return async (request) => {
    if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' });

    const ingestToken = env.get('SYNC_AGENT_INGEST_TOKEN');
    if (!isStrongBearerSecret(ingestToken)) {
      return jsonResponse(503, { error: 'Sync ingestion is not configured.' });
    }
    const suppliedToken = bearerToken(request);
    if (!suppliedToken || !constantTimeEqual(suppliedToken, ingestToken)) {
      return jsonResponse(401, { error: 'Not authorized.' });
    }

    // This second, server-side gate remains off until the exact upstream counter
    // semantics have been verified. It prevents an accidental deployment from
    // treating active-session counters as subscriber-lifetime totals.
    if (env.get('SYNC_AGENT_COUNTER_SOURCE_CONFIRMED') !== 'true') {
      return jsonResponse(503, { error: 'Sync ingestion is not enabled for a confirmed cumulative source.' });
    }

    const readResult = await readBoundedJson(request);
    if (!readResult.ok) return jsonResponse(readResult.status, { error: 'Invalid request.' });
    const rpcArgs = normalizePayload(readResult.value);
    if (!rpcArgs) return jsonResponse(400, { error: 'Invalid request.' });

    const rpcUrl = supabaseRpcUrl(env.get('SUPABASE_URL'));
    const serviceRoleKey = env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!rpcUrl || typeof serviceRoleKey !== 'string' || serviceRoleKey.length === 0) {
      return jsonResponse(503, { error: 'Sync ingestion is not configured.' });
    }

    // The full batch is validated before the first write. RPC calls are
    // deliberately sequential, matching the existing per-customer contract.
    for (const args of rpcArgs) {
      let response;
      try {
        response = await fetchImpl(rpcUrl, {
          method: 'POST',
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(args),
          redirect: 'manual',
        });
      } catch {
        return jsonResponse(503, { error: 'Sync ingestion is temporarily unavailable.' });
      }
      if (!response?.ok) {
        return jsonResponse(503, { error: 'Sync ingestion is temporarily unavailable.' });
      }
    }

    return jsonResponse(200, { accepted: rpcArgs.length });
  };
}
