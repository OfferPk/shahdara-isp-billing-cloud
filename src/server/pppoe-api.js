import { parseSubscriberComment } from '../admin-subscriber-import.js';
import { createRouterAdapter } from './router-adapters.js';

const SESSION_PATH = '/api/admin/pppoe/sessions';
const HEALTH_PATH = '/api/admin/pppoe/router-health';
const DISCOVER_PATH = '/api/admin/subscribers/discover';
const IMPORT_PATH = '/api/admin/subscribers/import';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IMPORT_COUNT = 500;
const importQueues = new Map();

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
    headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
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

function isMissingPppoeUsernameColumn(error) {
  return ['42703', 'PGRST204'].includes(String(error?.code ?? ''))
    && /pppoe_username/i.test(String(error?.message ?? ''));
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

async function loadOrganizationCustomers(client, organizationId) {
  const customers = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 50000; offset += pageSize) {
    let query = client.from('customers')
      .select('id, customer_number, pppoe_username')
      .eq('organization_id', organizationId)
      .range(offset, offset + pageSize - 1);
    const { data, error } = await query;
    if (error) {
      if (isMissingPppoeUsernameColumn(error)) {
        throw new Error('Subscriber import requires the existing customers.pppoe_username migration to be applied.');
      }
      throw error;
    }
    const page = data ?? [];
    customers.push(...page);
    if (page.length < pageSize) return customers;
  }
  throw new Error('The organization customer list reached its safe paging limit.');
}

function normalizeDiscoveredSubscribers(rows) {
  const byUsername = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const username = String(row?.username ?? '').trim();
    if (!username || username.length > 255 || byUsername.has(username)) continue;
    byUsername.set(username, {
      username,
      profile: String(row.profile ?? '').trim().slice(0, 100),
      ipAddress: String(row.ipAddress ?? '').trim().slice(0, 100),
      comment: String(row.comment ?? '').trim().slice(0, 1000),
    });
  }
  return [...byUsername.values()];
}

function markImportStatus(subscribers, customers) {
  const importedNames = new Set(customers.map((row) => String(row.pppoe_username ?? '')).filter(Boolean));
  return subscribers.map((subscriber) => ({
    ...subscriber,
    status: importedNames.has(subscriber.username) ? 'Already Imported' : 'New',
  }));
}

async function withOrganizationImportLock(organizationId, operation) {
  const previous = importQueues.get(organizationId) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  importQueues.set(organizationId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (importQueues.get(organizationId) === current) importQueues.delete(organizationId);
  }
}

async function importSubscribers({ client, organizationId, requestedUsernames, router }) {
  const uniqueRequested = [...new Set(requestedUsernames.map((username) => String(username ?? '').trim()).filter(Boolean))];
  if (!uniqueRequested.length) return { imported: 0, skipped: 0, importedUsernames: [] };
  if (uniqueRequested.length > MAX_IMPORT_COUNT) {
    const error = new Error(`Select no more than ${MAX_IMPORT_COUNT} subscribers at a time.`);
    error.status = 400;
    throw error;
  }
  if (typeof router.discoverSubscribers !== 'function') {
    throw new Error('The configured router adapter does not support subscriber discovery.');
  }

  const routerSubscribers = normalizeDiscoveredSubscribers(await router.discoverSubscribers());
  const routerRows = new Map(routerSubscribers.map((row) => [row.username, row]));
  const customers = await loadOrganizationCustomers(client, organizationId);
  const importedNames = new Set(customers.map((row) => String(row.pppoe_username ?? '')).filter(Boolean));
  let imported = 0;
  let skipped = 0;
  const importedUsernames = [];

  for (const username of uniqueRequested) {
    const subscriber = routerRows.get(username);
    if (!subscriber || importedNames.has(username)) {
      skipped += 1;
      continue;
    }
    const parsed = parseSubscriberComment(subscriber.comment, subscriber.username);
    const { data: importResult, error: importError } = await client.rpc('import_router_subscriber', {
      p_organization_id: organizationId,
      p_username: subscriber.username,
      p_name: parsed.name || subscriber.username,
      p_profile: subscriber.profile,
      p_assigned_ip: subscriber.ipAddress || null,
      p_router_comment: subscriber.comment,
      p_service_address: parsed.area,
      p_phone: parsed.phone,
    });
    if (importError) throw importError;
    if (typeof importResult?.imported !== 'boolean') {
      throw new Error('The subscriber import RPC returned an invalid result.');
    }
    if (importResult?.imported !== true) {
      importedNames.add(username);
      skipped += 1;
      continue;
    }

    importedNames.add(username);
    importedUsernames.push(username);
    imported += 1;
  }
  return { imported, skipped, importedUsernames };
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

    const pathname = requestUrl.pathname;
    const knownPaths = [SESSION_PATH, HEALTH_PATH, DISCOVER_PATH, IMPORT_PATH];
    if (!knownPaths.includes(pathname)) return jsonResponse(404, { error: 'Not found.' }, origin, true);
    const allowedMethod = pathname === IMPORT_PATH ? 'POST' : 'GET';
    if (request.method !== allowedMethod) return jsonResponse(405, { error: 'Method not allowed.' }, origin, true);

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
      if (pathname === HEALTH_PATH) {
        return jsonResponse(200, await router.getRouterHealth(), origin, true);
      }
      if (pathname === DISCOVER_PATH) {
        if (typeof router.discoverSubscribers !== 'function') {
          return jsonResponse(503, { error: 'The configured router adapter does not support subscriber discovery.' }, origin, true);
        }
        const [discovered, customers] = await Promise.all([
          router.discoverSubscribers(),
          loadOrganizationCustomers(authorization.client, organizationId),
        ]);
        const subscribers = markImportStatus(normalizeDiscoveredSubscribers(discovered), customers);
        return jsonResponse(200, { discoveredCount: subscribers.length, subscribers }, origin, true);
      }

      let body;
      try { body = await request.json(); } catch {
        return jsonResponse(400, { error: 'A valid JSON import request is required.' }, origin, true);
      }
      const requestedUsernames = body?.usernames;
      if (!Array.isArray(requestedUsernames) || requestedUsernames.some((username) => typeof username !== 'string')) {
        return jsonResponse(400, { error: 'Provide a usernames array to import.' }, origin, true);
      }
      if (requestedUsernames.length > MAX_IMPORT_COUNT
        || requestedUsernames.some((username) => !username.trim() || username.trim().length > 255)) {
        return jsonResponse(400, { error: `Select between 1 and ${MAX_IMPORT_COUNT} valid subscriber usernames.` }, origin, true);
      }

      const result = await withOrganizationImportLock(organizationId, () => importSubscribers({
        client: authorization.client,
        organizationId,
        requestedUsernames,
        router,
      }));
      return jsonResponse(200, result, origin, true);
    } catch (error) {
      const status = Number(error?.status) === 400 ? 400 : 503;
      const rawMessage = String(error?.message ?? '');
      const knownSafeMessages = new Set([
        'The configured router adapter does not support subscriber discovery.',
        'MikroTik router discovery is not configured.',
        'Subscriber import requires the existing customers.pppoe_username migration to be applied.',
      ]);
      const message = status === 400 || knownSafeMessages.has(rawMessage)
        ? rawMessage.slice(0, 300)
        : 'Subscriber discovery or import is temporarily unavailable. Verify API configuration and try again.';
      return jsonResponse(status, { error: message }, origin, true);
    }
  };
}

export const pppoeApiRoutes = Object.freeze({ sessions: SESSION_PATH, health: HEALTH_PATH, discover: DISCOVER_PATH, import: IMPORT_PATH });
export const pppoeApiInternals = Object.freeze({ asBigInt, jsonSession, authorizeAdmin, loadOrganizationCustomers, normalizeDiscoveredSubscribers, markImportStatus, importSubscribers, isMissingPppoeUsernameColumn });
