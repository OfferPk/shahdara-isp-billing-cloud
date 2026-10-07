import { createRouterAdapter } from './router-adapters.js';

const SESSION_PATH = '/api/admin/pppoe/sessions';
const HEALTH_PATH = '/api/admin/pppoe/router-health';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonResponse(status, body, origin, allowOrigin = false) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    vary: 'Origin',
  });
  if (allowOrigin && origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-headers', 'authorization, apikey, content-type, x-client-info');
    headers.set('access-control-allow-methods', 'GET, OPTIONS');
    headers.set('access-control-max-age', '600');
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

function allowedOrigins(env) {
  return String(env.CORS_ORIGIN ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

function asBigInt(value) {
  try {
    if (typeof value === 'bigint') return value < 0n ? 0n : value;
    const normalized = String(value ?? '0').trim();
    return /^\d+$/.test(normalized) ? BigInt(normalized) : 0n;
  } catch {
    return 0n;
  }
}

function jsonSession(session) {
  return {
    ...session,
    bytesIn: asBigInt(session.bytesIn).toString(),
    bytesOut: asBigInt(session.bytesOut).toString(),
  };
}

function supabaseConfig(env) {
  return {
    url: String(env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? '').trim(),
    key: String(env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '').trim(),
  };
}

async function authorizeAdmin(request, organizationId, { env, createClient }) {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match?.[1]?.trim()) return { status: 401, error: 'Sign in with an administrator account.' };

  const { url, key } = supabaseConfig(env);
  if (!url || !key || typeof createClient !== 'function') {
    return { status: 503, error: 'Administrator access verification is not configured.' };
  }

  try {
    const bearerToken = match[1].trim();
    const client = createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${bearerToken}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userResult, error: userError } = await client.auth.getUser(bearerToken);
    if (userError || !userResult?.user?.id) return { status: 401, error: 'The sign-in session is invalid or expired.' };
    const { data: membership, error: membershipError } = await client
      .from('organization_memberships')
      .select('role')
      .eq('organization_id', organizationId)
      .eq('user_id', userResult.user.id)
      .maybeSingle();
    if (membershipError) return { status: 503, error: 'Administrator access could not be verified.' };
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return { status: 403, error: 'Organization administrator access is required.' };
    }
    return { client, user: userResult.user, membership };
  } catch {
    return { status: 503, error: 'Administrator access could not be verified.' };
  }
}

export function createPppoeApiHandler({
  env = process.env,
  createClient,
  adapterFactory = createRouterAdapter,
  adapter,
} = {}) {
  const router = adapter ?? adapterFactory({ env });
  const origins = allowedOrigins(env);

  return async function handlePppoeApi(request) {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get('origin') ?? '';
    const corsAllowed = !origin || origin === requestUrl.origin || origins.includes(origin);
    if (!corsAllowed) return jsonResponse(403, { error: 'Origin is not allowed.' }, '', false);
    if (request.method === 'OPTIONS') return jsonResponse(204, {}, origin, true);
    if (request.method !== 'GET') return jsonResponse(405, { error: 'Method not allowed.' }, origin, true);

    const pathname = requestUrl.pathname;
    if (![SESSION_PATH, HEALTH_PATH].includes(pathname)) return jsonResponse(404, { error: 'Not found.' }, origin, true);
    const organizationId = String(requestUrl.searchParams.get('organizationId') ?? '').trim();
    if (!UUID_PATTERN.test(organizationId)) return jsonResponse(400, { error: 'A valid organizationId is required.' }, origin, true);

    const authorization = await authorizeAdmin(request, organizationId, { env, createClient });
    if (authorization.error) return jsonResponse(authorization.status, { error: authorization.error }, origin, true);

    try {
      if (pathname === SESSION_PATH) {
        const sessions = await router.getActiveSessions();
        const activeSessions = sessions.filter((session) => session.status === 'Online');
        const bytesIn = activeSessions.reduce((total, session) => total + asBigInt(session.bytesIn), 0n);
        const bytesOut = activeSessions.reduce((total, session) => total + asBigInt(session.bytesOut), 0n);
        return jsonResponse(200, {
          totalActiveUsers: activeSessions.length,
          totalTraffic: { bytesIn: bytesIn.toString(), bytesOut: bytesOut.toString() },
          sessions: sessions.map(jsonSession),
          lastPolledAt: new Date().toISOString(),
        }, origin, true);
      }
      const health = await router.getRouterHealth();
      return jsonResponse(200, health, origin, true);
    } catch {
      return jsonResponse(503, { error: 'Router telemetry is temporarily unavailable.' }, origin, true);
    }
  };
}

export const pppoeApiRoutes = Object.freeze({ sessions: SESSION_PATH, health: HEALTH_PATH });
export const pppoeApiInternals = Object.freeze({ asBigInt, jsonSession, authorizeAdmin });
