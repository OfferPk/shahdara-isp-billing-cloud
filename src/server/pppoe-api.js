import { parseSubscriberComment } from '../admin-subscriber-import.js';
import { createRouterAdapter } from './router-adapters.js';

const SESSION_PATH = '/api/admin/pppoe/sessions';
const HEALTH_PATH = '/api/admin/pppoe/router-health';
const DISCOVER_PATH = '/api/admin/subscribers/discover';
const IMPORT_PATH = '/api/admin/subscribers/import';
const PACKAGE_PRICE_PATH = '/api/admin/billing/packages';
const GENERATE_INVOICES_PATH = '/api/admin/billing/generate';
const CUSTOMER_LIVE_TRAFFIC_PATH = '/api/customer/live-traffic';
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

function isValidIsoDate(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(String(value ?? ''));
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day);
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

async function authorizeCustomerTraffic(request, { env, createClient }) {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match?.[1]?.trim()) return { status: 401, error: 'Sign in to view customer traffic.' };
  const { url, key } = supabaseConfig(env);
  if (!url || !key || typeof createClient !== 'function') {
    return { status: 503, error: 'Customer traffic authorization is not configured.' };
  }

  try {
    const bearerToken = match[1].trim();
    const client = createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${bearerToken}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: userResult, error: userError } = await client.auth.getUser(bearerToken);
    if (userError || !userResult?.user?.id) return { status: 401, error: 'The sign-in session is invalid or expired.' };

    const { data: passwordStates, error: passwordStateError } = await client.rpc('my_customer_portal_password_state');
    if (passwordStateError) return { status: 503, error: 'Customer portal access could not be verified.' };
    const passwordState = passwordStates?.[0]?.state ?? 'none';
    if (!['none', 'active'].includes(passwordState)) return { status: 403, error: 'Active customer portal access is required.' };

    const { data: contexts, error: contextsError } = await client.rpc('my_customer_portal_contexts');
    if (contextsError) return { status: 503, error: 'Customer portal access could not be verified.' };
    if (!Array.isArray(contexts) || contexts.length !== 1) {
      return { status: 403, error: 'A single linked customer account is required.' };
    }
    const context = contexts[0];
    const organizationId = String(context?.organization_id ?? '');
    const customerId = String(context?.customer_id ?? '');
    if (!UUID_PATTERN.test(organizationId) || !customerId || customerId.length > 255) {
      return { status: 403, error: 'The linked customer account could not be verified.' };
    }

    const { data: customer, error: customerError } = await client
      .from('customers')
      .select('id,organization_id,pppoe_username')
      .eq('organization_id', organizationId)
      .eq('id', customerId)
      .maybeSingle();
    if (customerError) return { status: 503, error: 'The linked customer profile could not be verified.' };
    if (!customer
        || String(customer.id) !== customerId
        || String(customer.organization_id).toLowerCase() !== organizationId.toLowerCase()) {
      return { status: 403, error: 'The linked customer profile could not be verified.' };
    }
    const pppoeUsername = typeof customer.pppoe_username === 'string' ? customer.pppoe_username : '';
    if (!pppoeUsername || pppoeUsername.trim() !== pppoeUsername) {
      return { status: 404, error: 'Live traffic is not linked to this customer account.' };
    }
    return { client, user: userResult.user, customer: { id: customerId, organizationId, pppoeUsername } };
  } catch {
    return { status: 503, error: 'Customer portal access could not be verified.' };
  }
}

function createTrafficRateLimiter({
  now = () => Date.now(),
  minUserIntervalMs = 2000,
  maxRequestsPerSecond = 10,
  maxConcurrent = 4,
} = {}) {
  const lastByUser = new Map();
  const recentRequests = [];
  let inFlight = 0;
  return {
    acquire(userId) {
      const currentTime = Number(now());
      while (recentRequests.length && currentTime - recentRequests[0] >= 1000) recentRequests.shift();
      if (minUserIntervalMs > 0) {
        const last = lastByUser.get(userId);
        if (last !== undefined && currentTime - last < minUserIntervalMs) {
          return { allowed: false, retryAfterMs: minUserIntervalMs - (currentTime - last) };
        }
      }
      if (recentRequests.length >= maxRequestsPerSecond) {
        return { allowed: false, retryAfterMs: Math.max(1, 1000 - (currentTime - recentRequests[0])) };
      }
      if (inFlight >= maxConcurrent) return { allowed: false, retryAfterMs: 1000 };
      if (minUserIntervalMs > 0) lastByUser.set(userId, currentTime);
      recentRequests.push(currentTime);
      inFlight += 1;
      let released = false;
      return {
        allowed: true,
        release() {
          if (released) return;
          released = true;
          inFlight = Math.max(0, inFlight - 1);
        },
      };
    },
  };
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
  now = () => Date.now(),
} = {}) {
  const router = adapter ?? adapterFactory({ env });
  const origins = allowedOrigins(env);
  const customerTrafficLimiter = createTrafficRateLimiter({ now });
  const customerTrafficIngressLimiter = createTrafficRateLimiter({
    now,
    minUserIntervalMs: 0,
    maxRequestsPerSecond: 30,
    maxConcurrent: 20,
  });

  return async function handlePppoeApi(request) {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get('origin') ?? '';
    const corsAllowed = !origin || origin === requestUrl.origin || origins.includes(origin);
    if (!corsAllowed) return jsonResponse(403, { error: 'Origin is not allowed.' }, '', false);
    if (request.method === 'OPTIONS') return jsonResponse(204, {}, origin, true);

    const pathname = requestUrl.pathname;
    const knownPaths = [SESSION_PATH, HEALTH_PATH, DISCOVER_PATH, IMPORT_PATH, PACKAGE_PRICE_PATH, GENERATE_INVOICES_PATH, CUSTOMER_LIVE_TRAFFIC_PATH];
    if (!knownPaths.includes(pathname)) return jsonResponse(404, { error: 'Not found.' }, origin, true);
    const allowedMethod = [IMPORT_PATH, PACKAGE_PRICE_PATH, GENERATE_INVOICES_PATH].includes(pathname) ? 'POST' : 'GET';
    if (request.method !== allowedMethod) return jsonResponse(405, { error: 'Method not allowed.' }, origin, true);

    if (pathname === CUSTOMER_LIVE_TRAFFIC_PATH) {
      if (requestUrl.search) return jsonResponse(400, { error: 'This route does not accept customer or organization identifiers.' }, origin, true);
      const ingress = customerTrafficIngressLimiter.acquire('all');
      if (!ingress.allowed) {
        const limited = jsonResponse(429, { error: 'Customer traffic requests are temporarily rate limited.' }, origin, true);
        limited.headers.set('retry-after', String(Math.max(1, Math.ceil(ingress.retryAfterMs / 1000))));
        return limited;
      }
      try {
        const authorization = await authorizeCustomerTraffic(request, { env, createClient });
        if (authorization.error) return jsonResponse(authorization.status, { error: authorization.error }, origin, true);
        const permit = customerTrafficLimiter.acquire(authorization.user.id);
        if (!permit.allowed) {
          const limited = jsonResponse(429, { error: 'Live traffic is temporarily rate limited. Try again in a moment.' }, origin, true);
          limited.headers.set('retry-after', String(Math.max(1, Math.ceil(permit.retryAfterMs / 1000))));
          return limited;
        }
        try {
          if (typeof router.getLiveTrafficForUsername !== 'function') {
            return jsonResponse(503, { error: 'The configured router adapter does not support live traffic.' }, origin, true);
          }
          const sample = await router.getLiveTrafficForUsername(authorization.customer.pppoeUsername);
          if (!Number.isFinite(Number(sample?.downloadBitsPerSecond))
              || Number(sample.downloadBitsPerSecond) < 0
              || !Number.isFinite(Number(sample?.uploadBitsPerSecond))
              || Number(sample.uploadBitsPerSecond) < 0) {
            throw new Error('Router returned an invalid live traffic sample.');
          }
          return jsonResponse(200, {
            downloadBitsPerSecond: Number(sample.downloadBitsPerSecond),
            uploadBitsPerSecond: Number(sample.uploadBitsPerSecond),
            sampledAt: typeof sample.sampledAt === 'string' ? sample.sampledAt : new Date(now()).toISOString(),
            source: sample.source === 'demo' ? 'demo' : 'routeros',
          }, origin, true);
        } catch {
          return jsonResponse(503, { error: 'Live router traffic is temporarily unavailable.' }, origin, true);
        } finally {
          permit.release();
        }
      } finally {
        ingress.release();
      }
    }

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

      if (pathname === PACKAGE_PRICE_PATH) {
        let body;
        try { body = await request.json(); } catch {
          return jsonResponse(400, { error: 'A valid package pricing request is required.' }, origin, true);
        }
        const packageId = String(body?.packageId ?? '').trim();
        const monthlyFeeCents = body?.monthlyFeeCents;
        if (!packageId || packageId.length > 200
            || !Number.isSafeInteger(monthlyFeeCents) || monthlyFeeCents <= 0) {
          return jsonResponse(400, { error: 'Provide a package ID and a positive monthly fee in PKR minor units.' }, origin, true);
        }
        const { data, error } = await authorization.client.rpc('set_package_monthly_fee', {
          p_organization_id: organizationId,
          p_package_id: packageId,
          p_monthly_fee_cents: monthlyFeeCents,
        });
        if (error) throw error;
        if (!data || data.packageId !== packageId) throw new Error('The package pricing update could not be confirmed.');
        return jsonResponse(200, { package: data }, origin, true);
      }

      if (pathname === GENERATE_INVOICES_PATH) {
        let body;
        try { body = await request.json(); } catch {
          return jsonResponse(400, { error: 'A valid monthly invoice request is required.' }, origin, true);
        }
        const billingMonth = String(body?.billingMonth ?? '').trim();
        const issueDate = String(body?.issueDate ?? '').trim();
        const dueDate = String(body?.dueDate ?? '').trim();
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(billingMonth)
            || !isValidIsoDate(issueDate) || !isValidIsoDate(dueDate)) {
          return jsonResponse(400, { error: 'Choose a valid billing month, issue date, and exact due date.' }, origin, true);
        }
        const { data, error } = await authorization.client.rpc('generate_monthly_invoices', {
          p_organization_id: organizationId,
          p_period: `${billingMonth}-01`,
          p_issued_on: issueDate,
          p_due_date: dueDate,
        });
        if (error) throw error;
        if (!data || data.period !== billingMonth || !Number.isSafeInteger(Number(data.generated))) {
          throw new Error('Monthly invoice generation could not be confirmed.');
        }
        return jsonResponse(200, data, origin, true);
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
        : pathname === PACKAGE_PRICE_PATH || pathname === GENERATE_INVOICES_PATH
          ? 'Billing requests are temporarily unavailable. Verify billing configuration and try again.'
          : 'Subscriber discovery or import is temporarily unavailable. Verify API configuration and try again.';
      return jsonResponse(status, { error: message }, origin, true);
    }
  };
}

export const pppoeApiRoutes = Object.freeze({
  sessions: SESSION_PATH,
  health: HEALTH_PATH,
  discover: DISCOVER_PATH,
  import: IMPORT_PATH,
  packagePricing: PACKAGE_PRICE_PATH,
  generateInvoices: GENERATE_INVOICES_PATH,
  customerLiveTraffic: CUSTOMER_LIVE_TRAFFIC_PATH,
});
export const pppoeApiInternals = Object.freeze({ asBigInt, jsonSession, authorizeAdmin, authorizeCustomerTraffic, createTrafficRateLimiter, loadOrganizationCustomers, normalizeDiscoveredSubscribers, markImportStatus, importSubscribers, isMissingPppoeUsernameColumn });
