import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticatePortalLogin,
  isStaffUsername,
  loginModeFromHash,
  loginModeToHash,
  signInWithUsernamePassword,
  usernameToAuthEmail,
} from '../src/auth-flows.js';

const portalToken = 'a'.repeat(64);

 test('only the trimmed, case-insensitive admin alias is treated as staff login', () => {
  assert.equal(isStaffUsername(' admin '), true);
  assert.equal(isStaffUsername('ADMIN'), true);
  assert.equal(isStaffUsername('admin@example.com'), false);
  assert.equal(isStaffUsername('customer-01'), false);
  assert.equal(isStaffUsername('  '), false);
});

test('username/password helper remains available for admin Auth aliases only', async () => {
  const calls = [];
  const auth = {
    async signInWithPassword(credentials) {
      calls.push(['signInWithPassword', credentials]);
      return { data: { session: { user: { id: 'synthetic-owner' } } }, error: null };
    },
  };

  const result = await signInWithUsernamePassword(auth, ' ADMIN ', 'staff-password');

  assert.deepEqual(calls, [[
    'signInWithPassword',
    { email: 'ADMIN@shahdara.local', password: 'staff-password' },
  ]]);
  assert.equal(usernameToAuthEmail('  customer@isp  '), 'customer@isp@shahdara.local');
  assert.equal(result.error, null);
});

test('empty admin usernames are rejected locally without an Auth request', async () => {
  let called = false;
  const result = await signInWithUsernamePassword({
    async signInWithPassword() { called = true; return { error: null }; },
  }, '  ', 'password');

  assert.equal(called, false);
  assert.ok(result.error instanceof Error);
  assert.equal(usernameToAuthEmail('  '), '');
});

test('login URL anchors choose the corresponding login tab', () => {
  assert.equal(loginModeFromHash('#admin-login'), 'admin');
  assert.equal(loginModeFromHash('#ADMIN-LOGIN'), 'admin');
  assert.equal(loginModeFromHash('#customer-login'), 'customer');
  assert.equal(loginModeFromHash('#admin-overview'), 'customer');
  assert.equal(loginModeToHash('admin'), '#admin-login');
  assert.equal(loginModeToHash('customer'), '#customer-login');
});

test('admin mode authenticates directly against Supabase Auth and never calls the customer broker', async () => {
  const calls = [];
  const auth = {
    async signInWithPassword(credentials) {
      calls.push(['auth', credentials]);
      return { data: { session: { user: { id: 'admin-user' } } }, error: null };
    },
  };
  const functions = { async invoke(...args) { calls.push(['broker', ...args]); return { data: null, error: null }; } };

  const result = await authenticatePortalLogin({ auth, functions, mode: 'admin', username: 'admin', password: 'staff-secret' });

  assert.deepEqual(calls, [['auth', { email: 'admin@shahdara.local', password: 'staff-secret' }]]);
  assert.equal(result.error, null);
});

test('customer mode returns only an opaque portal token and never establishes a Supabase Auth session', async () => {
  const calls = [];
  const auth = {
    async signInWithPassword(...args) { calls.push(['auth-sign-in', ...args]); throw new Error('customer Auth is forbidden'); },
    async setSession(...args) { calls.push(['setSession', ...args]); throw new Error('customer Auth session is forbidden'); },
  };
  const functions = {
    async invoke(...args) {
      calls.push(['broker', ...args]);
      return { data: { portal_token: portalToken, expires_at: '2026-10-09T10:00:00.000Z' }, error: null };
    },
  };

  const result = await authenticatePortalLogin({ auth, functions, mode: 'customer', username: 'raja-arif', password: 'portal-secret' });

  assert.deepEqual(calls, [['broker', 'customer-login', { body: { username: 'raja-arif', password: 'portal-secret' } }]]);
  assert.equal(result.error, null);
  assert.deepEqual(result.data, { portal_token: portalToken, expires_at: '2026-10-09T10:00:00.000Z' });
});

test('customer mode rejects the reserved admin alias without calling Auth or the customer broker', async () => {
  const calls = [];
  const auth = { async signInWithPassword(...args) { calls.push(['auth', ...args]); } };
  const functions = { async invoke(...args) { calls.push(['broker', ...args]); } };

  const result = await authenticatePortalLogin({ auth, functions, mode: 'customer', username: 'ADMIN', password: 'staff-secret' });

  assert.equal(calls.length, 0);
  assert.ok(result.error instanceof Error);
});

test('customer broker authorization failures are returned without a direct Auth fallback', async () => {
  const calls = [];
  const auth = { async signInWithPassword(...args) { calls.push(['auth', ...args]); return { data: null, error: null }; } };
  const functions = { async invoke(...args) { calls.push(['broker', ...args]); return { data: null, error: { context: { status: 401 } } }; } };

  const result = await authenticatePortalLogin({ auth, functions, mode: 'customer', username: 'raja-arif', password: 'wrong' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'broker');
  assert.ok(result.error);
});

test('customer mode fails closed on malformed or expired-shape broker session responses', async () => {
  for (const data of [
    { session: { access_token: 'supabase-auth-jwt' }, expires_at: '2026-10-09T10:00:00.000Z' },
    { portal_token: 'too-short', expires_at: '2026-10-09T10:00:00.000Z' },
    { portal_token: portalToken, expires_at: 'not-a-date' },
  ]) {
    const result = await authenticatePortalLogin({
      auth: {},
      functions: { async invoke() { return { data, error: null }; } },
      mode: 'customer', username: 'bajwa-house', password: 'portal-secret',
    });
    assert.ok(result.error instanceof Error);
    assert.equal(result.data, null);
  }
});
