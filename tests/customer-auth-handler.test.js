import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerLoginHandler } from '../supabase/functions/customer-login/handler.js';
import { createManageCustomerCredentialsHandler } from '../supabase/functions/manage-customer-credentials/handler.js';
import { createChangeCustomerPasswordHandler } from '../supabase/functions/change-customer-password/handler.js';
import { customerLoginId, syntheticAuthAlias, temporaryPassword } from '../supabase/functions/_shared/customer-auth.js';

const origin = 'https://offerpk.github.io';
const adminId = '30000000-0000-4000-8000-000000000003';
const organizationId = '10000000-0000-4000-8000-000000000001';
const customerId = 'synthetic-customer-27';
const userId = '40000000-0000-4000-8000-000000000004';
const username = 'sf-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const alias = 'portal-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@internal.shahdara.net';
const session = {
  access_token: 'synthetic-access-token',
  refresh_token: 'synthetic-refresh-token',
  expires_in: 3600,
  token_type: 'bearer',
  user: { id: userId, email: alias },
};

function makeEnv() {
  const values = new Map([
    ['APP_ORIGIN', origin],
    ['SUPABASE_URL', 'https://synthetic-project.supabase.co'],
    ['SUPABASE_PUBLISHABLE_KEY', 'synthetic-publishable-key'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-only-key'],
    ['PORTAL_RATE_LIMIT_HMAC_KEY', 'synthetic-test-hmac-secret-long-enough-0123456789'],
  ]);
  return { get: (key) => values.get(key) ?? null };
}

function request(path, { method = 'POST', originValue = origin, body = {}, ip = '198.51.100.28', authorization = '' } = {}) {
  const headers = {};
  if (originValue !== null) headers.origin = originValue;
  if (ip !== null) headers['x-forwarded-for'] = ip;
  if (authorization) headers.authorization = authorization;
  if (method !== 'OPTIONS') headers['content-type'] = 'application/json';
  return new Request(`https://synthetic-project.supabase.co/functions/v1/${path}`, {
    method,
    headers,
    ...(method === 'OPTIONS' ? {} : { body: JSON.stringify(body) }),
  });
}

function loginHarness(options = {}) {
  const calls = { keys: [], rpcs: [], signIns: [], revoked: [] };
  const env = makeEnv();
  const resolution = options.resolution ?? {
    status: 'active', user_id: userId, auth_email_alias: alias,
    organization_id: organizationId, customer_id: customerId,
  };
  const createClient = (_url, key) => {
    calls.keys.push(key);
    if (key === 'synthetic-service-only-key') {
      return {
        async rpc(name, args) {
          calls.rpcs.push({ name, args });
          if (name === 'begin_customer_portal_login') return options.limitError
            ? { data: null, error: options.limitError }
            : { data: options.limit ?? { status: 'allowed' }, error: null };
          if (name === 'resolve_customer_portal_login') return { data: resolution, error: options.resolveError ?? null };
          if (name === 'claim_customer_portal_temporary_password') return { data: options.claim ?? { status: 'ok' }, error: options.claimError ?? null };
          if (name === 'record_customer_portal_login_event') return { data: null, error: options.auditError ?? null };
          throw new Error(`Unexpected RPC ${name}`);
        },
        auth: { admin: { async signOut(token, scope) { calls.revoked.push({ token, scope }); return { error: null }; } } },
      };
    }
    return {
      auth: {
        async signInWithPassword(credentials) {
          calls.signIns.push(credentials);
          if (options.signInError || credentials.email.startsWith('invalid-')) {
            return { data: { session: null, user: null }, error: options.signInError ?? new Error('synthetic auth denial') };
          }
          return { data: { session, user: { id: userId, email: alias } }, error: null };
        },
      },
    };
  };
  return { handler: createCustomerLoginHandler({ env, createClient }), calls };
}

function credentialsHarness(options = {}) {
  const calls = { keys: [], clientOptions: [], rpcs: [], created: [], updated: [], deleted: [] };
  const env = makeEnv();
  const createClient = (_url, key, clientOptions = {}) => {
    calls.keys.push(key);
    calls.clientOptions.push({ key, options: clientOptions });
    if (key === 'synthetic-publishable-key') {
      return { auth: { async getUser(token) {
        calls.userToken = token;
        return options.authError
          ? { data: { user: null }, error: options.authError }
          : { data: { user: { id: adminId } }, error: null };
      } } };
    }
    return {
      async rpc(name, args) {
        calls.rpcs.push({ name, args });
        if (name === 'reserve_customer_portal_credential') {
          return options.reserveError
            ? { data: null, error: options.reserveError }
            : { data: options.reserve ?? {
              status: 'reserved', action: 'issue', login_id: username,
              auth_email_alias: alias, user_id: null,
            }, error: null };
        }
        if (name === 'recover_customer_portal_auth_user') return options.recovery ?? {
          data: { status: 'ok', user_id: userId }, error: null,
        };
        if (name === 'complete_customer_portal_credential') return options.complete ?? {
          data: { status: 'ok', expires_at: '2026-10-03T23:00:00Z' }, error: null,
        };
        if (name === 'fail_customer_portal_credential') return { data: { status: 'locked' }, error: null };
        throw new Error(`Unexpected RPC ${name}`);
      },
      auth: { admin: {
        async createUser(input) {
          calls.created.push(input);
          return options.createError
            ? { data: { user: null }, error: options.createError }
            : { data: { user: { id: userId } }, error: null };
        },
        async updateUserById(id, input) {
          calls.updated.push({ id, input });
          return options.updateError
            ? { data: { user: null }, error: options.updateError }
            : { data: { user: { id } }, error: null };
        },
        async deleteUser(id) { calls.deleted.push(id); return { error: null }; },
      } },
    };
  };
  return { handler: createManageCustomerCredentialsHandler({ env, createClient }), calls };
}

function passwordChangeHarness(options = {}) {
  const calls = { keys: [], options: [], rpcs: [], sdkUpdateUserCalls: [], authRequests: [], authResponseBodyReads: 0 };
  const env = makeEnv();
  const createClient = (_url, key, clientOptions = {}) => {
    calls.keys.push(key);
    calls.options.push({ key, options: clientOptions });
    if (key === 'synthetic-publishable-key') {
      return { auth: {
        async getUser(token) {
          calls.userToken = token;
          return options.authError
            ? { data: { user: null }, error: options.authError }
            : { data: { user: { id: userId } }, error: null };
        },
        async updateUser(input) {
          calls.sdkUpdateUserCalls.push(input);
          throw options.sdkUpdateError ?? Object.assign(new Error('session_not_found'), { code: 'session_not_found' });
        },
      } };
    }
    return { async rpc(name, args) {
      calls.rpcs.push({ name, args });
      if (name === 'begin_customer_portal_password_change') return { data: options.begin ?? { status: 'ok' }, error: options.beginError ?? null };
      if (name === 'complete_customer_portal_password_change') return { data: options.complete ?? { status: 'ok' }, error: options.completeError ?? null };
      if (name === 'abort_customer_portal_password_change') return { data: { status: 'ok' }, error: null };
      throw new Error(`Unexpected RPC ${name}`);
    } };
  };
  const fetchImpl = async (url, init) => {
    calls.authRequests.push({ url: String(url), init });
    if (options.authUpdateThrows) throw options.authUpdateThrows;
    return options.authResponse ?? { ok: true, status: 200 };
  };
  return { handler: createChangeCustomerPasswordHandler({ env, createClient, fetchImpl }), calls };
}

async function responseJson(response) {
  return response.status === 204 ? null : response.json();
}

test('broker maps an active username server-side and returns only the normal no-store Auth session', async () => {
  const { handler, calls } = loginHarness();
  const response = await handler(request('customer-login', { body: { username, password: 'synthetic-permanent-password' } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  const body = await responseJson(response);
  assert.equal(body.session.access_token, session.access_token);
  assert.equal(body.auth_email_alias, undefined);
  assert.equal(calls.signIns.length, 1);
  assert.deepEqual(calls.signIns[0], { email: alias, password: 'synthetic-permanent-password' });
  assert.deepEqual(calls.rpcs.map(({ name }) => name), [
    'begin_customer_portal_login', 'resolve_customer_portal_login', 'record_customer_portal_login_event',
  ]);
  assert.doesNotMatch(JSON.stringify(calls.rpcs), /synthetic-permanent-password/);
});

test('wrong, unknown, and expired credentials use the same generic response and never return a session', async () => {
  for (const resolution of [
    { status: 'not_found' },
    { status: 'expired' },
    { status: 'used' },
    { status: 'locked' },
  ]) {
    const { handler } = loginHarness({ resolution });
    const response = await handler(request('customer-login', { body: { username, password: 'synthetic-password' } }));
    assert.equal(response.status, 401);
    assert.deepEqual(await responseJson(response), { error: 'Username or password is incorrect or unavailable.' });
  }
  const wrong = loginHarness({ signInError: new Error('synthetic auth detail') });
  const response = await wrong.handler(request('customer-login', { body: { username, password: 'wrong-password' } }));
  assert.equal(response.status, 401);
  assert.doesNotMatch(JSON.stringify(await responseJson(response)), /synthetic auth detail/);
});

test('temporary sign-in is claimed once before a session is returned; a rejected claim is revoked', async () => {
  const { handler, calls } = loginHarness({ resolution: {
    status: 'temporary', user_id: userId, auth_email_alias: alias,
    organization_id: organizationId, customer_id: customerId,
  } });
  const success = await handler(request('customer-login', { body: { username, password: 'synthetic-temp-password' } }));
  assert.equal(success.status, 200);
  assert.ok(calls.rpcs.some(({ name }) => name === 'claim_customer_portal_temporary_password'));
  const rejected = loginHarness({
    resolution: { status: 'temporary', user_id: userId, auth_email_alias: alias, organization_id: organizationId, customer_id: customerId },
    claim: { status: 'rejected' },
  });
  const denied = await rejected.handler(request('customer-login', { body: { username, password: 'synthetic-temp-password' } }));
  assert.equal(denied.status, 401);
  assert.equal((await responseJson(denied)).error, 'Username or password is incorrect or unavailable.');
  assert.deepEqual(rejected.calls.revoked, [{ token: session.access_token, scope: 'global' }]);
});

test('broker rejects untrusted origin, missing forwarded IP, and enforces keyed DB throttles before Auth', async () => {
  const originFailure = loginHarness();
  assert.equal((await originFailure.handler(request('customer-login', { originValue: 'https://evil.example' }))).status, 403);
  assert.equal(originFailure.calls.keys.length, 0);

  const missingIp = loginHarness();
  assert.equal((await missingIp.handler(request('customer-login', { ip: null }))).status, 503);
  assert.equal(missingIp.calls.keys.length, 0);

  const limited = loginHarness({ limit: { status: 'rate_limited', retry_after_seconds: 300 } });
  const response = await limited.handler(request('customer-login', { body: { username, password: 'synthetic-password' } }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '300');
  assert.equal(limited.calls.signIns.length, 0);
});

test('random identifiers and server-generated temporary passwords use cryptographic, non-customer aliases', () => {
  assert.match(customerLoginId(), /^sf-[0-9a-f]{32}$/);
  assert.match(syntheticAuthAlias(), /^portal-[0-9a-f]{32}@internal\.shahdara\.net$/);
  const password = temporaryPassword();
  assert.equal(password.length, 32);
  assert.match(password, /[a-z]/);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[2-9]/);
  assert.match(password, /[!@#$%_-]/);
  assert.notEqual(password, temporaryPassword());
});

test('Admin issue stores no password in RPCs and returns the one-time secret without synthetic email exposure', async () => {
  const { handler, calls } = credentialsHarness();
  const response = await handler(request('manage-customer-credentials', {
    body: { organization_id: organizationId, customer_id: customerId, identity_verified: true, reason: 'Verified in person against ISP record.' },
    authorization: 'Bearer synthetic-admin-jwt',
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  const body = await responseJson(response);
  assert.deepEqual(Object.keys(body).sort(), ['action', 'expires_at', 'ok', 'temporary_password', 'username']);
  assert.equal(body.action, 'issue');
  assert.equal(body.username, username);
  assert.equal(body.temporary_password.length, 32);
  assert.doesNotMatch(JSON.stringify(body), /internal\.shahdara\.net|portal-/);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].email, alias);
  assert.equal(calls.created[0].email_confirm, true);
  assert.equal(calls.created[0].password, body.temporary_password);
  assert.equal(calls.rpcs[0].name, 'reserve_customer_portal_credential');
  assert.equal(calls.rpcs.at(-1).name, 'complete_customer_portal_credential');
  assert.doesNotMatch(JSON.stringify(calls.rpcs), new RegExp(body.temporary_password));
  assert.equal(calls.deleted.length, 0);
  assert.equal(calls.clientOptions.find(({ key }) => key === 'synthetic-service-only-key').options.auth.persistSession, false);
});

test('Admin reset updates only the mapped synthetic Auth user and concurrency/rate limits fail closed', async () => {
  const reset = credentialsHarness({ reserve: {
    status: 'reserved', action: 'reset', login_id: username,
    auth_email_alias: alias, user_id: userId,
  } });
  const response = await reset.handler(request('manage-customer-credentials', {
    body: { organization_id: organizationId, customer_id: customerId, identity_verified: true, reason: 'Customer attended ISP office for reset.' },
    authorization: 'Bearer synthetic-admin-jwt',
  }));
  assert.equal(response.status, 200);
  assert.equal(reset.calls.created.length, 0);
  assert.equal(reset.calls.updated.length, 1);
  assert.equal(reset.calls.updated[0].id, userId);
  assert.equal(reset.calls.updated[0].input.password, (await responseJson(response)).temporary_password);

  for (const [status, expected] of [['in_progress', 409], ['rate_limited', 429], ['forbidden', 403]]) {
    const harness = credentialsHarness({ reserve: { status } });
    const denied = await harness.handler(request('manage-customer-credentials', {
      body: { organization_id: organizationId, customer_id: customerId, identity_verified: true, reason: 'Verified in person for reset.' },
      authorization: 'Bearer synthetic-admin-jwt',
    }));
    assert.equal(denied.status, expected);
    assert.equal(harness.calls.created.length + harness.calls.updated.length, 0);
  }
});

test('Admin credentials require exact origin, verified session, completed identity attestation, reason, and forwarded IP', async () => {
  const missingCheck = credentialsHarness();
  const invalid = await missingCheck.handler(request('manage-customer-credentials', {
    body: { organization_id: organizationId, customer_id: customerId, identity_verified: false, reason: 'too short' },
    authorization: 'Bearer synthetic-admin-jwt',
  }));
  assert.equal(invalid.status, 400);
  assert.equal(missingCheck.calls.rpcs.length, 0);

  const noIp = credentialsHarness();
  const response = await noIp.handler(request('manage-customer-credentials', {
    body: { organization_id: organizationId, customer_id: customerId, identity_verified: true, reason: 'Verified in person at office.' },
    authorization: 'Bearer synthetic-admin-jwt', ip: null,
  }));
  assert.equal(response.status, 503);
  assert.equal(noIp.calls.rpcs.length, 0);

  const badOrigin = credentialsHarness();
  assert.equal((await badOrigin.handler(request('manage-customer-credentials', {
    originValue: 'https://evil.example', authorization: 'Bearer synthetic-admin-jwt',
  }))).status, 403);
  assert.equal(badOrigin.calls.keys.length, 0);
});

test('password change works without an SDK session by PUTting Auth as the verified bearer user', async () => {
  const password = 'Synthetic-permanent-Password-2026!';
  const harness = passwordChangeHarness({
    sdkUpdateError: Object.assign(new Error('synthetic missing SDK session'), { code: 'session_not_found' }),
  });
  const response = await harness.handler(request('change-customer-password', {
    body: { new_password: password },
    authorization: 'Bearer synthetic-customer-jwt',
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await responseJson(response), { ok: true });
  assert.equal(harness.calls.userToken, 'synthetic-customer-jwt');
  assert.equal(harness.calls.sdkUpdateUserCalls.length, 0);
  assert.equal(harness.calls.authRequests.length, 1);
  const [{ url, init }] = harness.calls.authRequests;
  assert.equal(url, 'https://synthetic-project.supabase.co/auth/v1/user');
  assert.equal(init.method, 'PUT');
  assert.deepEqual(harness.calls.authRequests.map(({ init: authInit }) => authInit.method), ['PUT']);
  assert.equal(harness.calls.authRequests.some(({ url: authUrl, init: authInit }) =>
    new URL(authUrl).pathname === '/auth/v1/user' && authInit.method === 'PATCH'), false);
  assert.equal(init.headers.apikey, 'synthetic-publishable-key');
  assert.equal(init.headers.Authorization, 'Bearer synthetic-customer-jwt');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(Object.keys(init.headers).sort(), ['Authorization', 'Content-Type', 'apikey'].sort());
  assert.deepEqual(JSON.parse(init.body), { password });
  assert.equal(init.redirect, 'manual');
  assert.deepEqual(harness.calls.rpcs[0], {
    name: 'begin_customer_portal_password_change', args: { p_user_id: userId },
  });
  assert.deepEqual(harness.calls.rpcs.map(({ name }) => name), [
    'begin_customer_portal_password_change', 'complete_customer_portal_password_change',
  ]);
  assert.equal(harness.calls.rpcs.filter(({ name }) => name === 'complete_customer_portal_password_change').length, 1);
  assert.deepEqual(harness.calls.rpcs.at(-1).args, { p_user_id: userId });
  assert.doesNotMatch(JSON.stringify(harness.calls.rpcs), /Synthetic-permanent-Password/);
});

test('password change rejects a non-exact Origin before Auth or lease operations', async () => {
  const harness = passwordChangeHarness();
  const response = await harness.handler(request('change-customer-password', {
    originValue: 'https://evil.example',
    body: { new_password: 'Synthetic-permanent-Password-2026!' },
    authorization: 'Bearer synthetic-customer-jwt',
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(harness.calls.keys, []);
  assert.deepEqual(harness.calls.authRequests, []);
  assert.deepEqual(harness.calls.rpcs, []);
});

test('Auth rejection releases the lease, skips completion, and never exposes or reads raw Auth errors', async () => {
  const rawAuthError = 'synthetic raw Auth error with password and bearer JWT';
  const harness = passwordChangeHarness({
    authResponse: {
      ok: false,
      status: 422,
      async text() { harness.calls.authResponseBodyReads += 1; return rawAuthError; },
      async json() { harness.calls.authResponseBodyReads += 1; return { message: rawAuthError }; },
    },
  });
  const response = await harness.handler(request('change-customer-password', {
    body: { new_password: 'Synthetic-permanent-Password-2026!' },
    authorization: 'Bearer synthetic-customer-jwt',
  }));
  assert.equal(response.status, 400);
  const body = await responseJson(response);
  assert.deepEqual(body, {
    error: 'Password could not be changed. Check the account password policy and try again, or contact an administrator.',
  });
  assert.doesNotMatch(JSON.stringify(body), /synthetic raw Auth error|password and bearer JWT/i);
  assert.equal(harness.calls.authResponseBodyReads, 0);
  assert.equal(harness.calls.sdkUpdateUserCalls.length, 0);
  assert.deepEqual(harness.calls.rpcs.map(({ name }) => name), [
    'begin_customer_portal_password_change', 'abort_customer_portal_password_change',
  ]);
});

test('password change network failure releases the lease and skips completion', async () => {
  const harness = passwordChangeHarness({ authUpdateThrows: new Error('synthetic Auth transport failure') });
  const response = await harness.handler(request('change-customer-password', {
    body: { new_password: 'Synthetic-permanent-Password-2026!' },
    authorization: 'Bearer synthetic-customer-jwt',
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(harness.calls.rpcs.map(({ name }) => name), [
    'begin_customer_portal_password_change', 'abort_customer_portal_password_change',
  ]);
  assert.equal(harness.calls.sdkUpdateUserCalls.length, 0);
});

test('password-change endpoint validates UTF-8 size, Auth session, and serialization status', async () => {
  const short = passwordChangeHarness();
  assert.equal((await short.handler(request('change-customer-password', {
    body: { new_password: 'short' }, authorization: 'Bearer synthetic-customer-jwt',
  }))).status, 400);
  assert.equal(short.calls.rpcs.length, 0);

  const unauthorized = passwordChangeHarness({ authError: new Error('not signed in') });
  assert.equal((await unauthorized.handler(request('change-customer-password', {
    body: { new_password: 'Synthetic-permanent-Password-2026!' }, authorization: 'Bearer synthetic-jwt',
  }))).status, 401);
  assert.equal(unauthorized.calls.rpcs.length, 0);

  const inProgress = passwordChangeHarness({ begin: { status: 'in_progress' } });
  const response = await inProgress.handler(request('change-customer-password', {
    body: { new_password: 'Synthetic-permanent-Password-2026!' }, authorization: 'Bearer synthetic-customer-jwt',
  }));
  assert.equal(response.status, 409);
  assert.equal(inProgress.calls.authRequests.length, 0);
  assert.equal(inProgress.calls.sdkUpdateUserCalls.length, 0);
});
