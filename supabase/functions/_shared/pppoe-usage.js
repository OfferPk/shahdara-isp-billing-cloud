export const APPROVED_APP_ORIGIN = 'https://offerpk.github.io';
const SITE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_32_RE = /^[0-9a-f]{64}$/i;
const MAX_BODY_BYTES = 1_000_000;
const MAX_SESSIONS = 500;

function json(status, body, origin = '', extra = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' });
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

const encoder = new TextEncoder();
function hex(bytes) { return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function fromHex(value) { return new Uint8Array(value.match(/.{2}/g).map((pair) => Number.parseInt(pair, 16))); }
function constantTimeEqualHex(left, right) {
  if (!HEX_32_RE.test(left) || !HEX_32_RE.test(right)) return false;
  const a = fromHex(left.toLowerCase());
  const b = fromHex(right.toLowerCase());
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function hmacHex(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}
async function sha256Hex(message) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(message)));
}
function siteMasterKey(env) {
  const value = env.get('PPPOE_USAGE_MASTER_KEY') ?? '';
  if (!HEX_32_RE.test(value)) return null;
  return fromHex(value);
}
async function deriveSiteKey(master, siteId) {
  return fromHex(await hmacHex(master, `shahdara-pppoe-usage-site-v1:${siteId}`));
}
function isCounter(value) { return typeof value === 'string' && /^\d{1,19}$/.test(value); }
function validPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (Object.keys(payload).sort().join(',') !== 'sampled_at,sessions,snapshot_id') return false;
  if (!UUID_RE.test(payload.snapshot_id ?? '') || typeof payload.sampled_at !== 'string'
      || Number.isNaN(Date.parse(payload.sampled_at)) || !Array.isArray(payload.sessions)
      || payload.sessions.length > MAX_SESSIONS) return false;
  return payload.sessions.every((session) => session && typeof session === 'object' && !Array.isArray(session)
    && Object.keys(session).sort().join(',') === 'bytes_in,bytes_out,session_id,session_key,uptime_seconds,username'
    && typeof session.username === 'string' && session.username.trim().length > 0 && session.username.length <= 255
    && typeof session.session_id === 'string' && session.session_id.length > 0 && session.session_id.length <= 200
    && UUID_RE.test(session.session_key ?? '')
    && Number.isSafeInteger(session.uptime_seconds) && session.uptime_seconds >= 0
    && isCounter(session.bytes_in) && isCounter(session.bytes_out));
}

export function createPppoeIngestHandler({ env, createClient }) {
  return async (request) => {
    if (request.headers.has('origin')) return json(403, { error: 'Browser-origin requests are not accepted.' });
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
    try {
      const siteId = request.headers.get('x-usage-site') ?? '';
      const timestampText = request.headers.get('x-usage-timestamp') ?? '';
      const nonce = request.headers.get('x-usage-nonce') ?? '';
      const signature = request.headers.get('x-usage-signature') ?? '';
      const publishableKey = env.get('SUPABASE_PUBLISHABLE_KEY') ?? env.get('SUPABASE_ANON_KEY') ?? '';
      const suppliedApiKey = request.headers.get('apikey') ?? '';
      const supabaseUrl = env.get('SUPABASE_URL');
      const serviceRoleKey = env.get('SUPABASE_SERVICE_ROLE_KEY');
      const master = siteMasterKey(env);
      if (!SITE_ID_RE.test(siteId) || !/^\d{10}$/.test(timestampText) || !UUID_RE.test(nonce)
          || !HEX_32_RE.test(signature) || !publishableKey || suppliedApiKey !== publishableKey
          || !supabaseUrl || !serviceRoleKey || !master) {
        return json(401, { error: 'Signed collector authentication failed.' });
      }
      const requestSeconds = Number(timestampText);
      if (!Number.isSafeInteger(requestSeconds) || Math.abs(Date.now() / 1000 - requestSeconds) > 300) {
        return json(401, { error: 'Signed collector timestamp is outside the allowed window.' });
      }
      const declaredLength = Number(request.headers.get('content-length') ?? 0);
      if (declaredLength > MAX_BODY_BYTES) return json(413, { error: 'Usage snapshot is too large.' });
      const rawBody = await request.text();
      if (encoder.encode(rawBody).length > MAX_BODY_BYTES) return json(413, { error: 'Usage snapshot is too large.' });
      let payload;
      try { payload = JSON.parse(rawBody); } catch { return json(400, { error: 'A valid JSON usage snapshot is required.' }); }
      if (!validPayload(payload)) return json(400, { error: 'Usage snapshot fields are invalid.' });

      const siteKey = await deriveSiteKey(master, siteId);
      const expected = await hmacHex(siteKey, `${timestampText}\n${nonce}\n${rawBody}`);
      if (!constantTimeEqualHex(signature, expected)) return json(401, { error: 'Signed collector authentication failed.' });

      const client = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
      const { data, error } = await client.rpc('process_pppoe_usage_snapshot', {
        p_site_id: siteId,
        p_snapshot_id: payload.snapshot_id,
        p_nonce: nonce,
        p_sampled_at: new Date(payload.sampled_at).toISOString(),
        p_body_sha256: await sha256Hex(rawBody),
        p_payload: payload,
      });
      if (error) return json(409, { error: 'Snapshot was rejected by the server-side usage validator.' });
      return json(200, { accepted: true, duplicate: Boolean(data?.duplicate), unmapped_sessions: Number(data?.unmapped_sessions ?? 0) });
    } catch {
      return json(500, { error: 'Usage snapshot could not be processed.' });
    }
  };
}

export function createPppoeAdminHandler({ env, createClient }) {
  return async (request) => {
    const appOrigin = env.get('APP_ORIGIN') ?? '';
    const requestOrigin = request.headers.get('origin') ?? '';
    if (appOrigin !== APPROVED_APP_ORIGIN || requestOrigin !== appOrigin) return json(403, { error: 'Origin is not allowed.' });
    if (request.method === 'OPTIONS') return json(204, {}, appOrigin);
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' }, appOrigin);
    try {
      const authorization = request.headers.get('authorization') ?? '';
      if (!authorization.startsWith('Bearer ')) return json(401, { error: 'Sign in with an administrator account.' }, appOrigin);
      const bearer = authorization.slice(7).trim();
      const supabaseUrl = env.get('SUPABASE_URL');
      const publicKey = env.get('SUPABASE_PUBLISHABLE_KEY') ?? env.get('SUPABASE_ANON_KEY');
      const serviceRoleKey = env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (!bearer || !supabaseUrl || !publicKey || !serviceRoleKey) return json(503, { error: 'Server usage configuration is incomplete.' }, appOrigin);
      const userClient = createClient(supabaseUrl, publicKey, { global: { headers: { Authorization: `Bearer ${bearer}` } }, auth: { autoRefreshToken: false, persistSession: false } });
      const { data: userResult, error: authError } = await userClient.auth.getUser(bearer);
      if (authError || !userResult?.user?.id) return json(401, { error: 'The sign-in session is invalid or expired.' }, appOrigin);
      let payload;
      try { payload = await request.json(); } catch { return json(400, { error: 'A valid JSON request is required.' }, appOrigin); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(400, { error: 'A valid JSON request is required.' }, appOrigin);
      const organizationId = payload.organization_id;
      const action = payload.action;
      if (!UUID_RE.test(organizationId ?? '') || !['list', 'save_mapping', 'collector_key'].includes(action)) return json(400, { error: 'A valid usage action and organization are required.' }, appOrigin);
      const { data: membership, error: membershipError } = await userClient.from('organization_memberships')
        .select('role').eq('organization_id', organizationId).eq('user_id', userResult.user.id).maybeSingle();
      if (membershipError) return json(503, { error: 'Administrator access could not be checked.' }, appOrigin);
      if (!membership || !['owner', 'admin'].includes(membership.role)) return json(403, { error: 'Organization administrator access is required.' }, appOrigin);
      const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

      if (action === 'list') {
        const [{ data: mappings, error: mappingError }, { data: sites, error: siteError }] = await Promise.all([
          adminClient.from('pppoe_usage_mappings').select('organization_id,site_id,pppoe_username,customer_id,quota_bytes,speed_download_bps,speed_upload_bps').eq('organization_id', organizationId).order('site_id').order('pppoe_username'),
          adminClient.from('pppoe_usage_sites').select('site_id,display_name,enabled,last_contact_at').eq('organization_id', organizationId).order('site_id'),
        ]);
        if (mappingError || siteError) return json(503, { error: 'Usage configuration could not be loaded.' }, appOrigin);
        return json(200, { mappings: mappings ?? [], sites: sites ?? [] }, appOrigin);
      }
      if (action === 'save_mapping') {
        const { site_id: siteId, site_label: siteLabel, pppoe_username: username, customer_id: customerId } = payload;
        const quotaBytes = payload.quota_bytes;
        const speedDownloadBps = payload.speed_download_bps;
        const speedUploadBps = payload.speed_upload_bps;
        if (!SITE_ID_RE.test(siteId ?? '') || typeof siteLabel !== 'string' || siteLabel.length > 100
            || typeof username !== 'string' || username.trim().length < 1 || username.length > 255
            || typeof customerId !== 'string' || !customerId || !Number.isSafeInteger(quotaBytes) || quotaBytes < 1
            || !Number.isSafeInteger(speedDownloadBps) || speedDownloadBps < 1
            || !Number.isSafeInteger(speedUploadBps) || speedUploadBps < 1) return json(400, { error: 'Enter valid collection-site, customer, username, quota, and speed values.' }, appOrigin);
        const { data, error } = await adminClient.rpc('save_pppoe_usage_mapping', {
          p_actor_id: userResult.user.id, p_organization_id: organizationId,
          p_site_id: siteId, p_site_label: siteLabel.trim(), p_pppoe_username: username,
          p_customer_id: customerId, p_quota_bytes: quotaBytes,
          p_speed_download_bps: speedDownloadBps, p_speed_upload_bps: speedUploadBps,
        });
        if (error) return json(409, { error: 'The mapping could not be saved. Check the selected active customer and whether this PPPoE identity is already assigned.' }, appOrigin);
        return json(200, { saved: true, mapping: data }, appOrigin);
      }

      const master = siteMasterKey(env);
      const siteId = payload.site_id;
      if (!master || !SITE_ID_RE.test(siteId ?? '')) return json(503, { error: 'Collector-key configuration is incomplete.' }, appOrigin);
      const { data: site, error: siteError } = await adminClient.from('pppoe_usage_sites')
        .select('site_id,enabled').eq('organization_id', organizationId).eq('site_id', siteId).maybeSingle();
      if (siteError || !site || !site.enabled) return json(404, { error: 'Enabled collection site not found.' }, appOrigin);
      const siteKey = await deriveSiteKey(master, siteId);
      return json(200, { site_id: siteId, collector_token: hex(siteKey) }, appOrigin, { 'Cache-Control': 'no-store, private' });
    } catch {
      return json(500, { error: 'Usage administration request could not be completed.' }, appOrigin);
    }
  };
}

export const pppoeUsageInternals = Object.freeze({ validPayload, deriveSiteKey, hmacHex, sha256Hex });
