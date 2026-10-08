import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticatePortalLogin,
  isCustomerLoginFallbackError,
  isStaffUsername,
  loginModeFromHash,
  loginModeToHash,
  signInWithUsernamePassword,
  usernameToAuthEmail,
} from '../src/auth-flows.js';

test('only the trimmed, case-insensitive admin alias is treated as staff login', () => {
  assert.equal(isStaffUsername(' admin '), true);
  assert.equal(isStaffUsername('ADMIN'), true);
  assert.equal(isStaffUsername('admin@example.com'), false);
  assert.equal(isStaffUsername('customer-01'), false);
  assert.equal(isStaffUsername('  '), false);
});

test('username/password login maps trimmed username to the invisible Supabase Auth alias', async () => {
  const calls = [];
  const auth = {
    async signInWithPassword(credentials) {
      calls.push(['signInWithPassword', credentials]);
      return { data: { session: { user: { id: 'synthetic-owner' } } }, error: null };
    },
  };

  const result = await signInWithUsernamePassword(auth, ' ADMIN ', 'synthetic-user-password');

  assert.deepEqual(calls, [[
    'signInWithPassword',
    { email: 'ADMIN@shahdara.local', password: 'synthetic-user-password' },
  ]]);
  assert.equal(usernameToAuthEmail('  customer@isp  '), 'customer@isp@shahdara.local');
  assert.equal(result.error, null);
  assert.equal('signUp' in auth, false);
  assert.equal('updateUser' in auth, false);
});

test('empty usernames are rejected locally without email-format validation or an Auth request', async () => {
  let called = false;
  const result = await signInWithUsernamePassword({
    async signInWithPassword() { called = true; return { error: null }; },
  }, '  ', 'synthetic-password');

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

test('customer mode uses its broker and establishes only the returned portal session', async () => {
  const calls = [];
  const session = { access_token: 'access-token', refresh_token: 'refresh-token' };
  const auth = {
    async setSession(value) { calls.push(['setSession', value]); return { error: null }; },
    async signOut() { calls.push(['signOut']); },
  };
  const functions = {
    async invoke(...args) { calls.push(['broker', ...args]); return { data: { session }, error: null }; },
  };

  const result = await authenticatePortalLogin({ auth, functions, mode: 'customer', username: 'subscriber-01', password: 'portal-secret' });

  assert.equal(calls[0][0], 'broker');
  assert.deepEqual(calls[0].slice(1), ['customer-login', { body: { username: 'subscriber-01', password: 'portal-secret' } }]);
  assert.deepEqual(calls[1], ['setSession', session]);
  assert.equal(result.error, null);
});

test('customer mode cannot use the reserved admin alias through broker fallback', async () => {
  const calls = [];
  const auth = { async signInWithPassword(credentials) { calls.push(['auth', credentials]); return { data: null, error: null }; } };
  const functions = { async invoke(...args) { calls.push(['broker', ...args]); return { data: null, error: { context: { status: 401 } } }; } };

  const result = await authenticatePortalLogin({ auth, functions, mode: 'customer', username: 'ADMIN', password: 'staff-secret' });

  assert.equal(calls.length, 0);
  assert.ok(result.error instanceof Error);
});

test('only customer-broker unauthorized responses permit customer username fallback', () => {
  assert.equal(isCustomerLoginFallbackError({ context: { status: 401 } }), true);
  assert.equal(isCustomerLoginFallbackError({ context: { status: 429 } }), false);
  assert.equal(isCustomerLoginFallbackError({ context: { status: 503 } }), false);
  assert.equal(isCustomerLoginFallbackError(new Error('network unavailable')), false);
});
