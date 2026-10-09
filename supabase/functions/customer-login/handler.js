import {
  APPROVED_APP_ORIGIN,
  exactOrigin,
  forwardedClientIp,
  hmacHex,
  jsonResponse,
  readJson,
  randomHex,
} from '../_shared/customer-auth.js';
import { sha256Hex } from '../_shared/customer-portal-bff.js';

const INVALID_CREDENTIALS = 'Username or password is incorrect or unavailable.';
const SERVICE_UNAVAILABLE = 'Sign-in is temporarily unavailable. Try again later.';
const DUMMY_AUTH_DOMAIN = 'internal.shahdara.net';
const OPAQUE_LOGIN_ID_PATTERN = /^sf-[0-9a-f]{32}$/;
const PPPoE_LOGIN_ID_PATTERN = /^[\x21-\x7e]{1,64}$/;
const SYNTHETIC_ALIAS_PATTERN = /^portal-[0-9a-f]{32}@internal\.shahdara\.net$/;

function functionClients(env, createClient) {
  const url = env.get('SUPABASE_URL');
  const publicKey = env.get('SUPABASE_PUBLISHABLE_KEY') ?? env.get('SUPABASE_ANON_KEY');
  const serviceKey = env.get('SUPABASE_SERVICE_ROLE_KEY');
  const parsed = (() => { try { return new URL(url); } catch { return null; } })();
  if (!parsed || parsed.protocol !== 'https:' || !publicKey || !serviceKey || typeof createClient !== 'function') return null;
  return {
    serverClient: createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    }),
    authClient: createClient(url, publicKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    }),
  };
}

function genericFailure(status = 401, origin = APPROVED_APP_ORIGIN, retrySeconds = null) {
  return jsonResponse(status, { error: status === 401 ? INVALID_CREDENTIALS : SERVICE_UNAVAILABLE }, origin,
    retrySeconds === null ? {} : { 'Retry-After': String(Math.max(1, retrySeconds)) });
}

export function createCustomerLoginHandler({ env, createClient }) {
  return async (request) => {
    const origin = exactOrigin(request, env);
    if (!origin) return jsonResponse(403, { error: 'Request is not allowed.' });
    if (request.method === 'OPTIONS') return jsonResponse(204, {}, origin);
    if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, origin);

    const ipAddress = forwardedClientIp(request);
    if (!ipAddress) return genericFailure(503, origin);
    const payload = await readJson(request, 8192);
    const rawLogin = typeof payload?.username === 'string' ? payload.username.trim() : '';
    const normalizedLogin = rawLogin.toLowerCase();
    const usernameValid = OPAQUE_LOGIN_ID_PATTERN.test(rawLogin) || PPPoE_LOGIN_ID_PATTERN.test(rawLogin);
    const rawPassword = typeof payload?.password === 'string' ? payload.password : '';
    const passwordValid = rawPassword.length > 0 && rawPassword.length <= 512;
    const hmacSecret = env.get('PORTAL_RATE_LIMIT_HMAC_KEY');
    let ipHash;
    let loginHash;
    try {
      ipHash = await hmacHex(hmacSecret, 'ip', ipAddress);
      loginHash = await hmacHex(hmacSecret, 'username', normalizedLogin.slice(0, 128) || '(missing)');
    } catch {
      return genericFailure(503, origin);
    }

    const clients = functionClients(env, createClient);
    if (!clients) return genericFailure(503, origin);

    const recordFailedLogin = async (resolution = null) => {
      try {
        await clients.serverClient.rpc('record_customer_portal_bff_login_event', {
          p_event_type: 'login_failed',
          p_outcome: 'denied',
          p_login_hash: loginHash,
          p_ip_hash: ipHash,
          p_organization_id: typeof resolution?.organization_id === 'string' ? resolution.organization_id : null,
          p_customer_id: typeof resolution?.customer_id === 'string' ? resolution.customer_id : null,
          p_user_id: typeof resolution?.user_id === 'string' ? resolution.user_id : null,
        });
      } catch { /* Login denial remains generic if audit storage is unavailable. */ }
    };

    try {
      const { data: limit, error: limitError } = await clients.serverClient.rpc('begin_customer_portal_login', {
        p_ip_hash: ipHash,
        p_login_hash: loginHash,
      });
      if (limitError || !limit?.status) return genericFailure(503, origin);
      if (limit.status !== 'allowed') {
        return jsonResponse(429, { error: 'Too many sign-in attempts. Wait before trying again.' }, origin, {
          'Retry-After': String(Math.max(1, Number(limit.retry_after_seconds) || 900)),
        });
      }

      const lookupId = usernameValid ? rawLogin : `sf-${loginHash.slice(0, 32)}`;
      const { data: resolution, error: resolveError } = await clients.serverClient.rpc(
        'resolve_customer_portal_login', { p_login_username: lookupId },
      );
      if (resolveError || !resolution?.status) return genericFailure(503, origin);

      const acceptedState = resolution.status === 'active'
        && typeof resolution.auth_email_alias === 'string'
        && SYNTHETIC_ALIAS_PATTERN.test(resolution.auth_email_alias)
        && typeof resolution.user_id === 'string';
      const passwordCanAuthenticate = usernameValid && passwordValid;
      const authEmail = acceptedState && passwordCanAuthenticate
        ? resolution.auth_email_alias
        : `invalid-${loginHash.slice(0, 32)}@${DUMMY_AUTH_DOMAIN}`;
      const authPassword = passwordValid ? rawPassword : 'invalid-placeholder-password';

      // This temporary Auth session stays server-side and is always revoked before issuing a BFF token.
      const { data: signIn, error: signInError } = await clients.authClient.auth.signInWithPassword({
        email: authEmail,
        password: authPassword,
      });
      if (signInError || !signIn?.session?.access_token) {
        await recordFailedLogin(acceptedState ? resolution : null);
        return genericFailure(401, origin);
      }

      const { error: revokeError } = await clients.serverClient.auth.admin.signOut(signIn.session.access_token, 'global');
      if (revokeError) return genericFailure(503, origin);

      if (!acceptedState || !passwordCanAuthenticate || signIn.user?.id !== resolution.user_id) {
        await recordFailedLogin(acceptedState ? resolution : null);
        return genericFailure(401, origin);
      }

      const portalToken = randomHex(32);
      const tokenHash = await sha256Hex(portalToken);
      const { data: createdSession, error: sessionError } = await clients.serverClient.rpc(
        'create_customer_portal_bff_session', {
          p_user_id: resolution.user_id,
          p_token_hash: tokenHash,
          p_login_hash: loginHash,
          p_ip_hash: ipHash,
        },
      );
      if (sessionError || !createdSession?.status) return genericFailure(503, origin);
      if (createdSession.status !== 'ok' || typeof createdSession.expires_at !== 'string') {
        await recordFailedLogin(resolution);
        return genericFailure(401, origin);
      }

      return jsonResponse(200, { portal_token: portalToken, expires_at: createdSession.expires_at }, origin);
    } catch {
      return genericFailure(503, origin);
    }
  };
}
