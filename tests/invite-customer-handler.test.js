import test from 'node:test';
import assert from 'node:assert/strict';
import { createInviteHandler } from '../supabase/functions/invite-customer/handler.js';

const appOrigin = 'https://offerpk.github.io';
const redirectUrl = 'https://offerpk.github.io/shahdara-isp-billing-cloud/';
const validPayload = {
  organization_id: '10000000-0000-4000-8000-000000000001',
  customer_id: 'synthetic-customer-27',
  email: 'TEST.CUSTOMER@example.test',
};
const invitationId = '20000000-0000-4000-8000-000000000002';
const invitedUserId = '30000000-0000-4000-8000-000000000003';

function makeHarness(options = {}) {
  const config = new Map([
    ['APP_ORIGIN', appOrigin],
    ['APP_REDIRECT_URL', redirectUrl],
    ['SUPABASE_URL', 'https://synthetic-project.supabase.co'],
    ['SUPABASE_PUBLISHABLE_KEY', 'synthetic-publishable-key'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'synthetic-server-only-key'],
  ]);
  const calls = { clientKeys: [], clientOptions: [], queries: [], invitations: [], rpcs: [] };
  const env = { get: (name) => config.get(name) ?? null };
  const state = { status: options.initialState ?? 'new', authUserId: null };
  let finalizeIndex = 0;

  const createClient = (_url, key, clientOptions = {}) => {
    calls.clientKeys.push(key);
    calls.clientOptions.push({ key, options: clientOptions });
    if (key === 'synthetic-publishable-key') {
      return {
        auth: { getUser: async (token) => {
          calls.token = token;
          return options.getUserError
            ? { data: { user: null }, error: options.getUserError }
            : { data: { user: { id: 'synthetic-admin-1' } }, error: null };
        } },
        from(table) {
          const filters = [];
          const query = {
            select(columns) { calls.selects ??= []; calls.selects.push([table, columns]); return query; },
            eq(column, value) { filters.push([column, value]); return query; },
            async maybeSingle() {
              calls.queries.push({ table, filters: [...filters] });
              if (table === 'organization_memberships') {
                return { data: options.membership === undefined ? { role: 'owner' } : options.membership, error: options.membershipError ?? null };
              }
              if (table === 'customers') {
                return { data: options.customer === undefined ? { id: validPayload.customer_id, archived: false } : options.customer, error: options.customerError ?? null };
              }
              throw new Error('Unexpected synthetic table');
            },
          };
          return query;
        },
      };
    }
    return {
      auth: { admin: { inviteUserByEmail: async (email, inviteOptions) => {
        calls.invitations.push({ email, inviteOptions });
        if (options.inviteGate) await options.inviteGate;
        if (options.inviteError) return { data: { user: null }, error: options.inviteError };
        return { data: { user: { id: invitedUserId } }, error: null };
      } } },
      async rpc(name, args) {
        calls.rpcs.push({ name, args });
        if (name === 'reserve_customer_invitation') {
          if (options.reserveError) return { data: null, error: options.reserveError };
          if (options.reserveStatus) return { data: { status: options.reserveStatus, invitation_id: options.reserveInvitationId }, error: null };
          if (state.status === 'new') {
            state.status = 'sending';
            return { data: { status: 'reserved', invitation_id: invitationId }, error: null };
          }
          if (state.status === 'sending') return { data: { status: 'in_progress' }, error: null };
          if (state.status === 'pending_link' || state.status === 'needs_review') {
            return { data: { status: 'recover', invitation_id: invitationId }, error: null };
          }
          if (state.status === 'linked') return { data: { status: 'linked' }, error: null };
          return { data: { status: 'needs_review' }, error: null };
        }
        if (name === 'record_customer_invitation_auth_user') {
          if (options.recordError) return { data: null, error: options.recordError };
          state.status = 'pending_link';
          state.authUserId = args.p_auth_user_id;
          return { data: { status: 'pending_link' }, error: null };
        }
        if (name === 'finalize_customer_invitation') {
          if (options.finalizeError) return { data: null, error: options.finalizeError };
          const configured = options.finalizeStatuses?.[finalizeIndex++];
          const status = configured ?? (state.authUserId || args.p_auth_user_id ? 'linked' : 'needs_review');
          state.status = status;
          if (status === 'linked') state.authUserId = null;
          return { data: { status }, error: null };
        }
        throw new Error(`Unexpected RPC ${name}`);
      },
    };
  };
  return { handler: createInviteHandler({ env, createClient }), calls, config, state };
}

function request({ origin = appOrigin, body = validPayload, authorization = 'Bearer synthetic-admin-token', method = 'POST' } = {}) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (authorization !== undefined) headers.authorization = authorization;
  if (body !== undefined && method !== 'OPTIONS') headers['content-type'] = 'application/json';
  return new Request('https://synthetic-project.supabase.co/functions/v1/invite-customer', {
    method,
    headers,
    ...(body !== undefined && method !== 'OPTIONS' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

async function json(response) {
  return response.status === 204 ? null : response.json();
}

async function emailDigest(email) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

test('wrong Origin is rejected before any Supabase client is created', async () => {
  const { handler, calls } = makeHarness();
  const response = await handler(request({ origin: 'https://evil.example' }));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(calls.clientKeys.length, 0);
});

test('the exact app Origin receives a valid bodyless CORS preflight response', async () => {
  const { handler, calls } = makeHarness();
  const response = await handler(request({ method: 'OPTIONS', body: undefined }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), appOrigin);
  assert.equal(await json(response), null);
  assert.equal(calls.clientKeys.length, 0);
});

test('redirect configuration and caller JWT are checked before privileged client access', async (t) => {
  await t.test('redirect cannot escape the cloud Pages URL', async () => {
    const { handler, calls, config } = makeHarness();
    config.set('APP_REDIRECT_URL', 'https://unapproved.example/');
    const response = await handler(request());
    assert.equal(response.status, 503);
    assert.equal(calls.clientKeys.length, 0);
  });
  await t.test('missing and invalid bearer tokens are denied', async () => {
    const missing = makeHarness();
    assert.equal((await missing.handler(request({ authorization: '' }))).status, 401);
    const invalid = makeHarness({ getUserError: new Error('synthetic auth detail') });
    const response = await invalid.handler(request());
    assert.equal(response.status, 401);
    assert.deepEqual(invalid.calls.clientKeys, ['synthetic-publishable-key']);
    assert.doesNotMatch(JSON.stringify(await json(response)), /synthetic auth detail/);
  });
});

test('only organization owners/admins and non-archived customers in that organization can request an invitation', async (t) => {
  await t.test('non-admin membership is denied', async () => {
    const { handler, calls } = makeHarness({ membership: { role: 'viewer' } });
    const response = await handler(request());
    assert.equal(response.status, 403);
    assert.equal(calls.rpcs.length, 0);
    assert.deepEqual(calls.clientKeys, ['synthetic-publishable-key']);
  });
  await t.test('missing membership is denied', async () => {
    const { handler, calls } = makeHarness({ membership: null });
    assert.equal((await handler(request())).status, 403);
    assert.deepEqual(calls.clientKeys, ['synthetic-publishable-key']);
  });
  await t.test('membership query errors fail closed before privileged client or invite actions', async () => {
    const { handler, calls } = makeHarness({ membershipError: new Error('synthetic permission error') });
    const response = await handler(request());
    assert.equal(response.status, 500);
    assert.deepEqual(await json(response), { error: 'Administrator access could not be checked.' });
    assert.deepEqual(calls.clientKeys, ['synthetic-publishable-key']);
    assert.equal(calls.rpcs.length, 0);
    assert.equal(calls.invitations.length, 0);
  });
  await t.test('unknown or archived customer is rejected before reservation', async () => {
    for (const customer of [null, { id: validPayload.customer_id, archived: true }]) {
      const { handler, calls } = makeHarness({ customer });
      assert.equal((await handler(request()).then((r) => r.status)), 404);
      assert.deepEqual(calls.clientKeys, ['synthetic-publishable-key']);
      assert.equal(calls.rpcs.length, 0);
    }
  });
  await t.test('membership and customer queries are pinned to both supplied IDs', async () => {
    const { handler, calls } = makeHarness();
    await handler(request());
    const membership = calls.queries.find((entry) => entry.table === 'organization_memberships');
    const customer = calls.queries.find((entry) => entry.table === 'customers');
    assert.ok(membership.filters.some(([field, value]) => field === 'organization_id' && value === validPayload.organization_id));
    assert.ok(membership.filters.some(([field, value]) => field === 'user_id' && value === 'synthetic-admin-1'));
    assert.ok(customer.filters.some(([field, value]) => field === 'organization_id' && value === validPayload.organization_id));
    assert.ok(customer.filters.some(([field, value]) => field === 'id' && value === validPayload.customer_id));
    const callerClient = calls.clientOptions.find(({ key }) => key === 'synthetic-publishable-key');
    assert.equal(callerClient.options.global.headers.Authorization, 'Bearer synthetic-admin-token');
  });
});

test('malformed JSON and invalid organization, customer, or email are rejected before reservation', async (t) => {
  const cases = [
    ['malformed JSON', '{not-json'],
    ['null JSON', null],
    ['invalid organization UUID', { ...validPayload, organization_id: '../other-org' }],
    ['empty customer identifier', { ...validPayload, customer_id: '   ' }],
    ['invalid email', { ...validPayload, email: 'not-an-email' }],
  ];
  for (const [label, body] of cases) {
    await t.test(label, async () => {
      const { handler, calls } = makeHarness();
      assert.equal((await handler(request({ body }))).status, 400);
      assert.equal(calls.rpcs.length, 0);
      assert.equal(calls.invitations.length, 0);
    });
  }
});

test('database rate limits are enforced before Auth and return a safe retry hint', async () => {
  const { handler, calls } = makeHarness({ reserveStatus: 'rate_limited' });
  const response = await handler(request());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '3600');
  assert.equal(calls.invitations.length, 0);
});

test('successful synthetic invitation reserves first, hashes email, sets a fixed redirect and links server-side', async () => {
  const { handler, calls } = makeHarness();
  const response = await handler(request());
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.deepEqual(body, {
    invited: true,
    linked: true,
    email_delivery_confirmed: false,
  });
  assert.equal(calls.rpcs[0].name, 'reserve_customer_invitation');
  assert.equal(calls.rpcs[0].args.p_email_hash, await emailDigest('test.customer@example.test'));
  assert.deepEqual(calls.invitations, [{
    email: 'test.customer@example.test',
    inviteOptions: {
      redirectTo: redirectUrl,
      data: { shahdara_cloud_invite_request_id: invitationId },
    },
  }]);
  assert.deepEqual(calls.rpcs.map(({ name }) => name), [
    'reserve_customer_invitation',
    'record_customer_invitation_auth_user',
    'finalize_customer_invitation',
  ]);
  assert.equal(calls.rpcs[2].args.p_auth_user_id, invitedUserId);
  assert.equal(calls.clientKeys.includes('synthetic-server-only-key'), true);
  assert.doesNotMatch(JSON.stringify(body), /test\.customer|synthetic-invited-user/);
});

test('repeated requests after success are idempotent and do not send a second invitation', async () => {
  const { handler, calls } = makeHarness();
  assert.equal((await handler(request())).status, 200);
  const secondResponse = await handler(request());
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(await json(secondResponse), {
    invited: false,
    linked: true,
    email_delivery_confirmed: false,
    recovered: true,
  });
  assert.equal(calls.invitations.length, 1);
});

test('concurrent submissions for one customer allow only one Auth invitation', async () => {
  let releaseInvite;
  const inviteGate = new Promise((resolve) => { releaseInvite = resolve; });
  const { handler, calls } = makeHarness({ inviteGate });
  const firstPromise = handler(request());
  while (calls.invitations.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const secondResponse = await handler(request());
  assert.equal(secondResponse.status, 409);
  assert.equal(calls.invitations.length, 1);
  releaseInvite();
  assert.equal((await firstPromise).status, 200);
  assert.equal(calls.invitations.length, 1);
});

test('a link failure is recoverable by resubmitting the same customer and email without a second invite', async () => {
  const { handler, calls } = makeHarness({ finalizeStatuses: ['needs_review', 'linked'] });
  const first = await handler(request());
  assert.equal(first.status, 409);
  assert.match((await json(first)).error, /same customer and email again/i);
  const retry = await handler(request());
  assert.equal(retry.status, 200);
  assert.deepEqual(await json(retry), {
    invited: false,
    linked: true,
    email_delivery_confirmed: false,
    recovered: true,
  });
  assert.equal(calls.invitations.length, 1);
});

test('a crash before persisting the Auth user ID can recover via the random request marker', async () => {
  const { handler, calls } = makeHarness({
    recordError: new Error('synthetic database outage'),
    finalizeStatuses: ['needs_review', 'linked'],
  });
  assert.equal((await handler(request())).status, 409);
  const recovered = await handler(request());
  assert.equal(recovered.status, 200);
  assert.equal((await json(recovered)).recovered, true);
  assert.equal(calls.invitations.length, 1);
  assert.equal(calls.invitations[0].inviteOptions.data.shahdara_cloud_invite_request_id, invitationId);
});

test('provider and database errors do not disclose email, Auth IDs, or backend details and never trigger an automatic resend', async () => {
  const { handler, calls } = makeHarness({
    inviteError: new Error('sensitive synthetic provider detail for hidden@example.test'),
  });
  const response = await handler(request());
  assert.equal(response.status, 409);
  const body = await json(response);
  assert.doesNotMatch(JSON.stringify(body), /sensitive|hidden@example|test\.customer|30000000-0000/);
  assert.equal(calls.invitations.length, 1);
  const retry = await handler(request());
  assert.equal(retry.status, 409);
  assert.equal(calls.invitations.length, 1);
});
