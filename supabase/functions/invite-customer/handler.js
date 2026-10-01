const APPROVED_APP_ORIGIN = 'https://offerpk.github.io';
const APPROVED_APP_REDIRECT_URL = 'https://offerpk.github.io/shahdara-isp-billing-cloud/';
const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
const INVITE_MARKER = 'shahdara_cloud_invite_request_id';

function response(status, body, origin, extraHeaders = {}) {
  const headers = new Headers(jsonHeaders);
  headers.set('Vary', 'Origin');
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const genericRecoveryError = 'The invitation result is uncertain. Submit the same customer and email again to recover safely; the server will not send a second invitation. If recovery cannot be confirmed, an administrator must review the account state.';

export function createInviteHandler({ env, createClient }) {
  return async (request) => {
    const appOrigin = env.get('APP_ORIGIN');
    const requestOrigin = request.headers.get('origin') ?? '';
    if (appOrigin !== APPROVED_APP_ORIGIN || requestOrigin !== appOrigin) {
      return response(403, { error: 'Origin is not allowed.' });
    }
    if (request.method === 'OPTIONS') return response(204, {}, appOrigin);
    if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' }, appOrigin);

    try {
      const appRedirectUrl = env.get('APP_REDIRECT_URL');
      if (appRedirectUrl !== APPROVED_APP_REDIRECT_URL) {
        return response(503, { error: 'Server invitation configuration is incomplete.' }, appOrigin);
      }

      const authorization = request.headers.get('authorization') ?? '';
      if (!authorization.startsWith('Bearer ')) {
        return response(401, { error: 'Sign in with an administrator account.' }, appOrigin);
      }
      const bearerToken = authorization.slice('Bearer '.length).trim();
      if (!bearerToken) return response(401, { error: 'Sign in with an administrator account.' }, appOrigin);

      const supabaseUrl = env.get('SUPABASE_URL');
      const publicKey = env.get('SUPABASE_PUBLISHABLE_KEY') ?? env.get('SUPABASE_ANON_KEY');
      const serverSecret = env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (!supabaseUrl || !publicKey || !serverSecret) {
        return response(503, { error: 'Server invitation configuration is incomplete.' }, appOrigin);
      }

      const userClient = createClient(supabaseUrl, publicKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: userResult, error: userError } = await userClient.auth.getUser(bearerToken);
      if (userError || !userResult?.user?.id) {
        return response(401, { error: 'The sign-in session is invalid or expired.' }, appOrigin);
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return response(400, { error: 'A valid JSON request is required.' }, appOrigin);
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return response(400, { error: 'A valid JSON request is required.' }, appOrigin);
      }

      const organizationId = typeof payload.organization_id === 'string' ? payload.organization_id.trim() : '';
      const customerId = typeof payload.customer_id === 'string' ? payload.customer_id.trim() : '';
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
      if (!isUuid(organizationId) || !customerId || customerId.length > 200
          || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return response(400, { error: 'Enter a valid customer and email address.' }, appOrigin);
      }

      const adminClient = createClient(supabaseUrl, serverSecret, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: membership, error: membershipError } = await adminClient
        .from('organization_memberships')
        .select('role')
        .eq('organization_id', organizationId)
        .eq('user_id', userResult.user.id)
        .maybeSingle();
      if (membershipError) {
        return response(500, { error: 'Administrator access could not be checked.' }, appOrigin);
      }
      if (!membership || !['owner', 'admin'].includes(membership.role)) {
        return response(403, { error: 'Organization administrator access is required.' }, appOrigin);
      }

      const { data: customer, error: customerError } = await adminClient
        .from('customers')
        .select('id, archived')
        .eq('organization_id', organizationId)
        .eq('id', customerId)
        .maybeSingle();
      if (customerError || !customer || customer.archived) {
        return response(404, { error: 'Customer record not found.' }, appOrigin);
      }

      const emailHash = await sha256Hex(email);
      const rpcArgs = {
        p_organization_id: organizationId,
        p_customer_id: customerId,
        p_actor_id: userResult.user.id,
        p_email_hash: emailHash,
      };
      const { data: reservation, error: reserveError } = await adminClient.rpc('reserve_customer_invitation', rpcArgs);
      if (reserveError || !reservation?.status) {
        return response(503, { error: 'The invitation status could not be reserved safely. Do not retry until the administrator checks the request state.' }, appOrigin);
      }

      const finishLink = async (authUserId = null) => {
        const { data, error } = await adminClient.rpc('finalize_customer_invitation', {
          ...rpcArgs,
          p_auth_user_id: authUserId,
        });
        return error ? null : data;
      };
      const linkedResponse = (recovered) => response(200, {
        invited: !recovered,
        linked: true,
        email_delivery_confirmed: false,
        ...(recovered ? { recovered: true } : {}),
      }, appOrigin);
      const recoveryRequired = () => response(409, { error: genericRecoveryError }, appOrigin);

      if (reservation.status === 'linked') return linkedResponse(true);
      if (reservation.status === 'recover') {
        const result = await finishLink();
        if (result?.status === 'linked') return linkedResponse(true);
        if (result?.status === 'forbidden') return response(403, { error: 'Organization administrator access is required.' }, appOrigin);
        return recoveryRequired();
      }
      if (reservation.status === 'rate_limited') {
        return response(429, { error: 'Invitation rate limit reached. Try again after the current rate window.' }, appOrigin, { 'Retry-After': '3600' });
      }
      if (reservation.status === 'in_progress') {
        return response(409, { error: 'An invitation request is already in progress. Wait briefly, then submit the same customer and email to recover safely.' }, appOrigin);
      }
      if (reservation.status === 'forbidden') {
        return response(403, { error: 'Organization administrator access is required.' }, appOrigin);
      }
      if (reservation.status === 'not_found') {
        return response(404, { error: 'Customer record not found.' }, appOrigin);
      }
      if (reservation.status === 'email_mismatch' || reservation.status === 'email_in_progress') {
        return response(409, { error: 'An invitation request for this customer or address needs review. No new invitation was sent.' }, appOrigin);
      }
      if (reservation.status === 'needs_review') return recoveryRequired();
      if (reservation.status !== 'reserved' || !isUuid(reservation.invitation_id)) {
        return response(503, { error: 'The invitation request could not be started safely.' }, appOrigin);
      }

      const { data: inviteResult, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
        redirectTo: appRedirectUrl,
        data: { [INVITE_MARKER]: reservation.invitation_id },
      });
      if (inviteError || !isUuid(inviteResult?.user?.id)) {
        // The Auth API can fail after creating an invited user. Resolve by the
        // random request marker if present; otherwise leave the request locked
        // for review rather than risking a duplicate email on a retry.
        const result = await finishLink();
        if (result?.status === 'linked') return linkedResponse(true);
        return recoveryRequired();
      }

      const { data: recordedUser, error: recordError } = await adminClient.rpc('record_customer_invitation_auth_user', {
        ...rpcArgs,
        p_auth_user_id: inviteResult.user.id,
      });
      if (recordError || recordedUser?.status !== 'pending_link') {
        const result = await finishLink();
        if (result?.status === 'linked') return linkedResponse(false);
        return recoveryRequired();
      }

      const linkResult = await finishLink(inviteResult.user.id);
      if (linkResult?.status === 'linked') return linkedResponse(false);
      if (linkResult?.status === 'forbidden') return response(403, { error: 'Organization administrator access is required.' }, appOrigin);
      return recoveryRequired();
    } catch {
      return response(500, { error: genericRecoveryError }, appOrigin);
    }
  };
}
