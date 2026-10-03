import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasPasswordRecoveryMarker,
  requestPasswordRecovery,
  setRecoveredPassword,
  signInWithEmailPassword,
} from '../src/auth-flows.js';

test('email/password login uses Supabase password sign-in and never creates an account', async () => {
  const calls = [];
  const auth = {
    async signInWithPassword(credentials) {
      calls.push(['signInWithPassword', credentials]);
      return { data: { session: { user: { id: 'synthetic-owner' } } }, error: null };
    },
  };

  const result = await signInWithEmailPassword(auth, ' owner@example.test ', 'synthetic-user-password');

  assert.deepEqual(calls, [[
    'signInWithPassword',
    { email: 'owner@example.test', password: 'synthetic-user-password' },
  ]]);
  assert.equal(result.error, null);
  assert.equal('signUp' in auth, false);
});

test('password recovery requests a redirect to the app without creating an account', async () => {
  const calls = [];
  const auth = {
    async resetPasswordForEmail(email, options) {
      calls.push(['resetPasswordForEmail', email, options]);
      return { data: {}, error: null };
    },
  };

  await requestPasswordRecovery(auth, ' owner@example.test ', 'https://portal.example.test/');

  assert.deepEqual(calls, [[
    'resetPasswordForEmail',
    'owner@example.test',
    { redirectTo: 'https://portal.example.test/' },
  ]]);
  assert.equal('signUp' in auth, false);
});

test('recovery completion changes only the authenticated user password', async () => {
  const calls = [];
  const auth = {
    async updateUser(attributes) {
      calls.push(['updateUser', attributes]);
      return { data: { user: { id: 'synthetic-owner' } }, error: null };
    },
  };

  await setRecoveredPassword(auth, 'synthetic-user-password');

  assert.deepEqual(calls, [['updateUser', { password: 'synthetic-user-password' }]]);
  assert.equal('signUp' in auth, false);
});

test('only recovery callbacks enter the password recovery flow', () => {
  assert.equal(hasPasswordRecoveryMarker('?type=recovery&code=synthetic'), true);
  assert.equal(hasPasswordRecoveryMarker('', '#access_token=synthetic&type=recovery'), true);
  assert.equal(hasPasswordRecoveryMarker('?type=magiclink'), false);
  assert.equal(hasPasswordRecoveryMarker('', '#type=invite'), false);
});
