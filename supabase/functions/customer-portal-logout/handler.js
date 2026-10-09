import { exactOrigin, jsonResponse } from '../_shared/customer-auth.js';
import { createCustomerPortalServiceClient, readCustomerPortalToken, sha256Hex } from '../_shared/customer-portal-bff.js';

export function createCustomerPortalLogoutHandler({ env, createClient }) {
  return async (request) => {
    const origin = exactOrigin(request, env);
    if (!origin) return jsonResponse(403, { error: 'Request is not allowed.' });
    if (request.method === 'OPTIONS') return jsonResponse(204, {}, origin);
    if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, origin);

    const token = readCustomerPortalToken(request);
    if (!token) return jsonResponse(200, { ok: true }, origin);
    const serviceClient = createCustomerPortalServiceClient(env, createClient);
    if (!serviceClient) return jsonResponse(503, { error: 'Logout could not be confirmed.' }, origin);
    try {
      const tokenHash = await sha256Hex(token);
      const { error } = await serviceClient.rpc('revoke_customer_portal_bff_session', {
        p_token_hash: tokenHash,
      });
      if (error) return jsonResponse(503, { error: 'Logout could not be confirmed.' }, origin);
      return jsonResponse(200, { ok: true }, origin);
    } catch {
      return jsonResponse(503, { error: 'Logout could not be confirmed.' }, origin);
    }
  };
}
