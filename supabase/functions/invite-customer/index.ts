import { createClient } from 'npm:@supabase/supabase-js@2';

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };

function response(status: number, body: Record<string, unknown>, origin?: string) {
  const headers = new Headers(jsonHeaders);
  headers.set('Vary', 'Origin');
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  return new Response(JSON.stringify(body), { status, headers });
}

Deno.serve(async (request: Request) => {
  const appOrigin = Deno.env.get('APP_ORIGIN');
  const requestOrigin = request.headers.get('origin') ?? '';
  if (!appOrigin || requestOrigin !== appOrigin) {
    return response(403, { error: 'Origin is not allowed.' });
  }
  if (request.method === 'OPTIONS') return response(204, {}, appOrigin);
  if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' }, appOrigin);

  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) {
    return response(401, { error: 'Sign in with an administrator account.' }, appOrigin);
  }
  const bearerToken = authorization.slice('Bearer '.length).trim();
  if (!bearerToken) return response(401, { error: 'Sign in with an administrator account.' }, appOrigin);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const publicKey = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');
  const serverSecret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !publicKey || !serverSecret) {
    return response(503, { error: 'Server invitation configuration is incomplete.' }, appOrigin);
  }

  const userClient = createClient(supabaseUrl, publicKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userResult, error: userError } = await userClient.auth.getUser(bearerToken);
  if (userError || !userResult.user) {
    return response(401, { error: 'The sign-in session is invalid or expired.' }, appOrigin);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return response(400, { error: 'A valid JSON request is required.' }, appOrigin);
  }

  const organizationId = typeof payload.organization_id === 'string' ? payload.organization_id : '';
  const customerId = typeof payload.customer_id === 'string' ? payload.customer_id : '';
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)
      || !customerId || customerId.length > 200
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
    .select('id')
    .eq('organization_id', organizationId)
    .eq('id', customerId)
    .maybeSingle();
  if (customerError || !customer) {
    return response(404, { error: 'Customer record not found.' }, appOrigin);
  }
  const { data: existingLink, error: linkCheckError } = await adminClient
    .from('customer_portal_accounts')
    .select('user_id')
    .eq('organization_id', organizationId)
    .eq('customer_id', customerId)
    .maybeSingle();
  if (linkCheckError) {
    return response(500, { error: 'Customer account status could not be checked.' }, appOrigin);
  }
  if (existingLink) {
    return response(409, { error: 'This customer already has a portal account.' }, appOrigin);
  }

  const { data: inviteResult, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${appOrigin}/`,
  });
  if (inviteError || !inviteResult.user) {
    return response(400, { error: 'The invitation could not be sent. Verify the address and account status.' }, appOrigin);
  }

  const { error: insertLinkError } = await adminClient
    .from('customer_portal_accounts')
    .insert({
      organization_id: organizationId,
      customer_id: customerId,
      user_id: inviteResult.user.id,
    });
  if (insertLinkError) {
    // Do not expose backend error details or any account/customer data. The
    // administrator should inspect the invitation state before retrying.
    return response(409, { error: 'The invitation was sent, but the account link needs administrator review.' }, appOrigin);
  }

  return response(200, { invited: true });
});
