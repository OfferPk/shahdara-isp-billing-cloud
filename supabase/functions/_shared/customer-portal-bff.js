const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function readCustomerPortalToken(request) {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const token = match?.[1]?.trim() ?? '';
  return TOKEN_PATTERN.test(token) ? token : '';
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createCustomerPortalServiceClient(env, createClient) {
  const url = env.get('SUPABASE_URL');
  const serviceKey = env.get('SUPABASE_SERVICE_ROLE_KEY');
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || !serviceKey || typeof createClient !== 'function') return null;
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}
