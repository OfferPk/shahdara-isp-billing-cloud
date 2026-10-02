import {
  exactOrigin,
  bearerToken,
  jsonResponse,
  readJson,
} from '../_shared/customer-auth.js';

const ALLOWED_AUTH_UPDATE_ERROR_CODES = new Set([
  'over_request_rate_limit',
  'reauthentication_needed',
  'reauthentication_not_valid',
  'same_password',
  'session_not_found',
  'unexpected_failure',
  'validation_failed',
  'weak_password',
]);

function logAuthUpdateFailure(error, logger) {
  try {
    const code = error?.code;
    if (typeof code !== 'string' || !ALLOWED_AUTH_UPDATE_ERROR_CODES.has(code)) return;
    logger.warn(JSON.stringify({
      event: 'customer_password_change_auth_update_failed',
      auth_error_code: code,
    }));
  } catch {
    // Diagnostics must never change the Auth response or lease cleanup behavior.
  }
}

function clientsFor(env, createClient, token) {
  const url = env.get('SUPABASE_URL');
  const publicKey = env.get('SUPABASE_PUBLISHABLE_KEY') ?? env.get('SUPABASE_ANON_KEY');
  const serviceKey = env.get('SUPABASE_SERVICE_ROLE_KEY');
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || !publicKey || !serviceKey || !token) return null;
  const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
  return {
    userClient: createClient(url, publicKey, {
      ...options,
      global: { headers: { Authorization: `Bearer ${token}` } },
    }),
    serverClient: createClient(url, serviceKey, options),
  };
}

async function releaseChangeLease(serverClient, userId) {
  try {
    await serverClient.rpc('abort_customer_portal_password_change', { p_user_id: userId });
  } catch {
    // State stays in changing_password, which blocks customer RLS until lease expiry/Admin reset.
  }
}

export function createChangeCustomerPasswordHandler({ env, createClient, logger = console }) {
  return async (request) => {
    const origin = exactOrigin(request, env);
    if (!origin) return jsonResponse(403, { error: 'Request is not allowed.' });
    if (request.method === 'OPTIONS') return jsonResponse(204, {}, origin);
    if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, origin);

    const token = bearerToken(request);
    if (!token) return jsonResponse(401, { error: 'Sign-in is required.' }, origin);
    const clients = clientsFor(env, createClient, token);
    if (!clients) return jsonResponse(503, { error: 'Password change is temporarily unavailable.' }, origin);

    let userId;
    try {
      const { data, error } = await clients.userClient.auth.getUser(token);
      if (error || !data?.user?.id) return jsonResponse(401, { error: 'Sign-in is required.' }, origin);
      userId = data.user.id;
    } catch {
      return jsonResponse(401, { error: 'Sign-in is required.' }, origin);
    }

    const payload = await readJson(request, 4096);
    const newPassword = typeof payload?.new_password === 'string' ? payload.new_password : '';
    const passwordBytes = new TextEncoder().encode(newPassword).byteLength;
    if (passwordBytes < 12 || passwordBytes > 72) {
      return jsonResponse(400, { error: 'Choose a password between 12 and 72 UTF-8 bytes.' }, origin);
    }

    let started;
    try {
      const { data, error } = await clients.serverClient.rpc(
        'begin_customer_portal_password_change', { p_user_id: userId },
      );
      if (error || !data?.status) return jsonResponse(503, { error: 'Password change is temporarily unavailable.' }, origin);
      started = data.status;
    } catch {
      return jsonResponse(503, { error: 'Password change is temporarily unavailable.' }, origin);
    }
    if (started === 'in_progress') {
      return jsonResponse(409, { error: 'A password change is already being processed. Wait briefly and try again.' }, origin, { 'Retry-After': '30' });
    }
    if (started !== 'ok') return jsonResponse(403, { error: 'This account is not eligible for a temporary-password change.' }, origin);

    try {
      // Use the signed-in user's normal Auth password-update API, not an Admin API
      // password override. Supabase Auth project password/re-auth policies remain active.
      const { error: updateError } = await clients.userClient.auth.updateUser({ password: newPassword });
      if (updateError) {
        await releaseChangeLease(clients.serverClient, userId);
        logAuthUpdateFailure(updateError, logger);
        return jsonResponse(400, { error: 'Password could not be changed. Check the account password policy and try again, or contact an administrator.' }, origin);
      }

      const { data: completed, error: completionError } = await clients.serverClient.rpc(
        'complete_customer_portal_password_change', { p_user_id: userId },
      );
      if (completionError || completed?.status !== 'ok') {
        await releaseChangeLease(clients.serverClient, userId);
        return jsonResponse(503, { error: 'The password update could not be confirmed. Portal data stays blocked until the account state is checked.' }, origin);
      }
      return jsonResponse(200, { ok: true }, origin);
    } catch {
      await releaseChangeLease(clients.serverClient, userId);
      return jsonResponse(503, { error: 'The password update could not be confirmed. Portal data stays blocked until the account state is checked.' }, origin);
    }
  };
}
