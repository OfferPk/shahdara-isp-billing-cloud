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

function makeHarness(options = {}) {
  const config = new Map([
    ['APP_ORIGIN', appOrigin],
    ['APP_REDIRECT_URL', redirectUrl],
    ['SUPABASE_URL', 'https://synthetic-project.supabase.co'],
    ['SUPABASE_PUBLISHABLE_KEY', 'synthetic-publishable-key'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'synthetic-server-only-key'],
  ]);
  const calls = { clientKeys: [], queries: [], invitations: [], links: [] };
  const env = { get: (name) => config.get(name) ?? null };
  const createClient = (_url, key) => {
    calls.clientKeys.push(key);
    if (key === 'synthetic-publishable-key') {
      return { auth: { getUser: async (token) => {
        calls.token = token;
        return options.getUserError
          ? { data: { user: null }, error: options.getUserError }
          : { data: { user: { id: 'synthetic-user-1' } }, error: null };
      } } };
    }
    return {
      auth: { admin: { inviteUserByEmail: async (email, inviteOptions) => {
        calls.invitations.push({ email, inviteOptions });
        return options.inviteError
          ? { data: { user: null }, error: options.inviteError }
          : { data: { user: { id: 'synthetic-invited-user-1' } }, error: null };
      } } },
      from(table) {
        const filters = [];
        const query = {
          select(columns) { calls.selects ??= []; calls.selects.push([table, columns]); return query; },
          eq(column, value) { filters.push([column, value]); return query; },
          async maybeSingle() {
            calls.queries.push({ table, filters: [...filters] });
            if (table === 'organization_memberships') return { data: options.membership === undefined ? { role: 'owner' } : options.membership, error: options.membershipError ?? null };
            if (table === 'customers') return { data: options.customer === undefined ? { id: validPayload.customer_id } : options.customer, error: options.customerError ?? null };
            if (table === 'customer_portal_accounts') return { data: options.existingLink ?? null, error: options.linkCheckError ?? null };
            throw new Error('Unexpected synthetic table');
          },
          async insert(row) {
            calls.links.push(row);
            return { error: options.insertLinkError ?? null };
          },
        };
        return query;
      },
    };
  };
  return { handler: createInviteHandler({ env, createClient }), calls, config };
}

function request({ origin = appOrigin, body = validPayload, authorization = 'Bearer synthetic-user-token', method = 'POST' } = {}) {
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

test('server URL settings must use the approved origin-only and redirect values', async (t) => {
  await t.test('APP_ORIGIN cannot contain a Pages path', async () => {
    const { handler, calls, config } = makeHarness();
    config.set('APP_ORIGIN', `${appOrigin}/shahdara-isp-billing-cloud/`);
    const response = await handler(request());
    assert.equal(response.status, 403);
    assert.equal(calls.clientKeys.length, 0);
  });
  await t.test('APP_REDIRECT_URL must match the approved Pages destination', async () => {
    const { handler, calls, config } = makeHarness();
    config.set('APP_REDIRECT_URL', 'https://unapproved.example/');
    const response = await handler(request());
    assert.equal(response.status, 503);
    assert.equal(calls.clientKeys.length, 0);
  });
});

test('unauthenticated and invalid-token callers are denied before elevated access', async (t) => {
  await t.test('missing bearer token', async () => {
    const { handler, calls } = makeHarness();
    const response = await handler(request({ authorization: '' }));
    assert.equal(response.status, 401);
    assert.equal(calls.clientKeys.length, 0);
  });
  await t.test('invalid bearer token', async () => {
    const { handler, calls } = makeHarness({ getUserError: new Error('synthetic auth detail') });
    const response = await handler(request());
    assert.equal(response.status, 401);
    assert.deepEqual(calls.clientKeys, ['synthetic-publishable-key']);
    assert.doesNotMatch(JSON.stringify(await json(response)), /synthetic auth detail/);
  });
});

test('non-admin membership and a cross-organization membership miss are denied', async (t) => {
  await t.test('non-admin role', async () => {
    const { handler, calls } = makeHarness({ membership: { role: 'viewer' } });
    const response = await handler(request());
    assert.equal(response.status, 403);
    assert.equal(calls.invitations.length, 0);
  });
  await t.test('no membership in the requested organization', async () => {
    const { handler, calls } = makeHarness({ membership: null });
    const response = await handler(request());
    assert.equal(response.status, 403);
    const membershipQuery = calls.queries.find((query) => query.table === 'organization_memberships');
    assert.ok(membershipQuery.filters.some(([column, value]) => column === 'organization_id' && value === validPayload.organization_id));
    assert.equal(calls.invitations.length, 0);
  });
});

test('malformed JSON and invalid organization, customer, or email inputs are rejected', async (t) => {
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
      const response = await handler(request({ body }));
      assert.equal(response.status, 400);
      assert.equal(calls.invitations.length, 0);
      assert.equal(calls.links.length, 0);
    });
  }
});

test('nonexistent customers and existing account links are rejected before email invitation', async (t) => {
  await t.test('customer is not in the selected organization', async () => {
    const { handler, calls } = makeHarness({ customer: null });
    const response = await handler(request());
    assert.equal(response.status, 404);
    assert.equal(calls.invitations.length, 0);
  });
  await t.test('customer already has a portal account', async () => {
    const { handler, calls } = makeHarness({ existingLink: { user_id: 'synthetic-existing-user' } });
    const response = await handler(request());
    assert.equal(response.status, 409);
    assert.equal(calls.invitations.length, 0);
  });
});

test('successful synthetic invitation uses the fixed Pages redirect and confirms no email delivery', async () => {
  const { handler, calls } = makeHarness();
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), {
    invited: true,
    linked: true,
    email_delivery_confirmed: false,
  });
  assert.deepEqual(calls.invitations, [{
    email: 'test.customer@example.test',
    inviteOptions: { redirectTo: redirectUrl },
  }]);
  assert.deepEqual(calls.links, [{
    organization_id: validPayload.organization_id,
    customer_id: validPayload.customer_id,
    user_id: 'synthetic-invited-user-1',
  }]);
  assert.equal(calls.clientKeys.includes('synthetic-server-only-key'), true);
});

test('link failure after accepted invite is safe and tells the administrator not to retry', async () => {
  const { handler, calls } = makeHarness({ insertLinkError: new Error('sensitive synthetic database detail') });
  const response = await handler(request());
  const body = await json(response);
  assert.equal(response.status, 409);
  assert.match(body.error, /Do not retry/i);
  assert.doesNotMatch(JSON.stringify(body), /sensitive synthetic database detail/);
  assert.equal(calls.invitations.length, 1);
});

test('Auth invitation failures never expose provider details', async () => {
  const { handler, calls } = makeHarness({ inviteError: new Error('sensitive synthetic provider detail') });
  const response = await handler(request());
  assert.equal(response.status, 400);
  assert.doesNotMatch(JSON.stringify(await json(response)), /sensitive synthetic provider detail/);
  assert.equal(calls.links.length, 0);
});
