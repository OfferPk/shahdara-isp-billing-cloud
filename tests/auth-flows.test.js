import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCustomerLoginFallbackError,
  signInWithUsernamePassword,
  usernameToAuthEmail,
} from '../src/auth-flows.js';

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

test('only customer-broker unauthorized responses permit staff username fallback', () => {
  assert.equal(isCustomerLoginFallbackError({ context: { status: 401 } }), true);
  assert.equal(isCustomerLoginFallbackError({ context: { status: 429 } }), false);
  assert.equal(isCustomerLoginFallbackError({ context: { status: 503 } }), false);
  assert.equal(isCustomerLoginFallbackError(new Error('network unavailable')), false);
});
