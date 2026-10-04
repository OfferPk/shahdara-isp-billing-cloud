import {
  exactOrigin,
  forwardedClientIp,
  hmacHex,
  isUuid,
  jsonResponse,
  readJson,
  customerLoginId,
  syntheticAuthAlias,
  temporaryPassword,
} from '../_shared/customer-auth.js';

const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const STAGING_SUPABASE_ORIGIN = 'https://qkdsuvmlutkatcqoewkh.supabase.co';

function isApprovedStagingProject(value) {
  try {
    const parsed = new URL(String(value ?? '').trim());
    return parsed.origin === STAGING_SUPABASE_ORIGIN
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function isPasswordPolicyError(error) {
  const detail = `${String(error?.code ?? '')} ${String(error?.message ?? '')}`;
  return /weak_password|password.{0,40}(too short|at least|minimum|policy|compromised|weak)/i.test(detail);
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

async function setFailureState(serverClient, organizationId, customerId, actorId, userId = null) {
  try {
    await serverClient.rpc('fail_customer_portal_credential', {
      p_organization_id: organizationId,
      p_customer_id: customerId,
      p_actor_id: actorId,
      p_user_id: userId,
    });
  } catch {
    // The reservation remains non-active; RLS denies customer reads if this write fails.
  }
}

export function createManageCustomerCredentialsHandler({ env, createClient }) {
  return async (request) => {
    const origin = exactOrigin(request, env);
    if (!origin) return jsonResponse(403, { error: 'Request is not allowed.' });
    if (request.method === 'OPTIONS') return jsonResponse(204, {}, origin);
    if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, origin);

    const token = request.headers.get('authorization')?.startsWith('Bearer ')
      ? request.headers.get('authorization').slice(7).trim()
      : '';
    if (!token) return jsonResponse(401, { error: 'Administrator sign-in is required.' }, origin);
    const clients = clientsFor(env, createClient, token);
    if (!clients) return jsonResponse(503, { error: 'Credential management is temporarily unavailable.' }, origin);

    let actorId;
    try {
      const { data: authData, error: authError } = await clients.userClient.auth.getUser(token);
      if (authError || !authData?.user?.id) return jsonResponse(401, { error: 'Administrator sign-in is required.' }, origin);
      actorId = authData.user.id;
    } catch {
      return jsonResponse(401, { error: 'Administrator sign-in is required.' }, origin);
    }

    const payload = await readJson(request);
    const organizationId = typeof payload?.organization_id === 'string' ? payload.organization_id : '';
    const customerId = typeof payload?.customer_id === 'string' ? payload.customer_id.trim() : '';
    const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : '';
    if (!isUuid(organizationId) || !CUSTOMER_ID_PATTERN.test(customerId)
        || reason.length < 10 || reason.length > 500 || payload?.identity_verified !== true) {
      return jsonResponse(400, { error: 'Complete the identity check and enter a valid reason.' }, origin);
    }

    const ipAddress = forwardedClientIp(request);
    if (!ipAddress) return jsonResponse(503, { error: 'Credential management is temporarily unavailable.' }, origin);
    let actorIpHash;
    try {
      actorIpHash = await hmacHex(env.get('PORTAL_RATE_LIMIT_HMAC_KEY'), 'ip', ipAddress);
    } catch {
      return jsonResponse(503, { error: 'Credential management is temporarily unavailable.' }, origin);
    }

    let reserved;
    const isStagingProject = isApprovedStagingProject(env.get('SUPABASE_URL'));
    try {
      const { data, error } = await clients.serverClient.rpc('reserve_customer_portal_credential_for_login', {
        p_organization_id: organizationId,
        p_customer_id: customerId,
        p_actor_id: actorId,
        p_reason: reason,
        p_login_id: customerLoginId(),
        p_auth_email_alias: syntheticAuthAlias(),
        p_actor_ip_hash: actorIpHash,
        p_is_staging_project: isStagingProject,
      });
      if (error || !data?.status) return jsonResponse(503, { error: 'Credential management is temporarily unavailable.' }, origin);
      reserved = data;
    } catch {
      return jsonResponse(503, { error: 'Credential management is temporarily unavailable.' }, origin);
    }

    if (reserved.status === 'forbidden') return jsonResponse(403, { error: 'Administrator access is required.' }, origin);
    if (reserved.status === 'not_found') return jsonResponse(404, { error: 'The active customer record was not found.' }, origin);
    if (reserved.status === 'rate_limited') return jsonResponse(429, { error: 'Credential changes are temporarily limited. Try again later.' }, origin, { 'Retry-After': '3600' });
    if (reserved.status === 'in_progress') return jsonResponse(409, { error: 'A credential change is already in progress. Wait a few minutes and check again.' }, origin, { 'Retry-After': '600' });
    if (reserved.status === 'invalid_test_mapping') return jsonResponse(409, { error: 'Link a valid existing PPPoE username of at most 64 characters before issuing a staging test login.' }, origin);
    if (reserved.status === 'username_conflict') return jsonResponse(409, { error: 'This PPPoE username is already assigned to another customer login. Ask an administrator to review the mapping.' }, origin);
    if (reserved.status !== 'reserved' || !reserved.login_id || !reserved.auth_email_alias) {
      return jsonResponse(400, { error: 'Credential request could not be accepted.' }, origin);
    }

    let password;
    const isTestAccount = isStagingProject && reserved.test_account === true;
    let authUserId = typeof reserved.user_id === 'string' ? reserved.user_id : null;
    try {
      password = isTestAccount ? '123456' : temporaryPassword();
      if (authUserId) {
        const { data: updated, error: updateError } = await clients.serverClient.auth.admin.updateUserById(
          authUserId, { password },
        );
        if (updateError) {
          if (isTestAccount && isPasswordPolicyError(updateError)) {
            await setFailureState(clients.serverClient, organizationId, customerId, actorId, authUserId);
            return jsonResponse(503, { error: 'The staging Auth password policy rejected the default test password. The account remains locked; an administrator must review the staging Auth password rules.' }, origin);
          }
          throw new Error('auth update failed');
        }
        if (!updated?.user?.id) throw new Error('auth update failed');
      } else {
        const { data: created, error: createError } = await clients.serverClient.auth.admin.createUser({
          email: reserved.auth_email_alias,
          password,
          // The owner-approved internal synthetic address is deliberately auto-confirmed.
          // It is not an inbox, customer email, or evidence of inbox ownership.
          email_confirm: true,
        });
        if (!createError && created?.user?.id) {
          authUserId = created.user.id;
        } else {
          if (isTestAccount && isPasswordPolicyError(createError)) {
            await setFailureState(clients.serverClient, organizationId, customerId, actorId);
            return jsonResponse(503, { error: 'The staging Auth password policy rejected the default test password. The account remains locked; an administrator must review the staging Auth password rules.' }, origin);
          }
          const { data: recovered, error: recoveryError } = await clients.serverClient.rpc(
            'recover_customer_portal_auth_user', {
              p_organization_id: organizationId,
              p_customer_id: customerId,
            },
          );
          if (recoveryError || recovered?.status !== 'ok' || !recovered.user_id) {
            await setFailureState(clients.serverClient, organizationId, customerId, actorId);
            return jsonResponse(503, { error: 'Credential setup failed. Contact an administrator before retrying.' }, origin);
          }
          authUserId = recovered.user_id;
          const { data: updated, error: updateError } = await clients.serverClient.auth.admin.updateUserById(
            authUserId, { password },
          );
          if (updateError || !updated?.user?.id) throw new Error('auth recovery update failed');
        }
      }

      const { data: completed, error: completionError } = await clients.serverClient.rpc(
        'complete_customer_portal_credential', {
          p_organization_id: organizationId,
          p_customer_id: customerId,
          p_actor_id: actorId,
          p_user_id: authUserId,
        },
      );
      if (completionError || completed?.status !== 'ok' || !completed.expires_at) {
        await setFailureState(clients.serverClient, organizationId, customerId, actorId, authUserId);
        return jsonResponse(503, { error: 'Credential setup could not be confirmed. The account remains locked; contact an administrator.' }, origin);
      }

      // The temporary password exists only in this handler's memory and this
      // no-store response. It is never written to Auth metadata, DB, audit, or logs.
      return jsonResponse(200, {
        ok: true,
        action: reserved.action,
        username: reserved.login_id,
        temporary_password: password,
        test_account: isTestAccount,
        expires_at: completed.expires_at,
      }, origin);
    } catch {
      await setFailureState(clients.serverClient, organizationId, customerId, actorId, authUserId);
      return jsonResponse(503, { error: 'Credential setup failed. The account remains locked; contact an administrator.' }, origin);
    }
  };
}
