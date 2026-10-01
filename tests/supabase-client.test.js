import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalClient, getSupabasePublicConfig } from '../src/supabase-client.js';

const syntheticConfig = {
  VITE_SUPABASE_URL: 'https://synthetic-ref.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_test_key',
};

test('public config rejects placeholders, non-HTTPS URLs, and credential-bearing URLs', () => {
  assert.equal(getSupabasePublicConfig({}), null);
  assert.equal(getSupabasePublicConfig({
    VITE_SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'YOUR_PUBLISHABLE_OR_LEGACY_ANON_KEY',
  }), null);
  assert.equal(getSupabasePublicConfig({
    VITE_SUPABASE_URL: 'http://synthetic-ref.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: syntheticConfig.VITE_SUPABASE_PUBLISHABLE_KEY,
  }), null);
  assert.equal(getSupabasePublicConfig({
    VITE_SUPABASE_URL: 'https://user:password@synthetic-ref.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: syntheticConfig.VITE_SUPABASE_PUBLISHABLE_KEY,
  }), null);
});

test('legacy JWT configuration is accepted only when its role claim is anon', () => {
  const legacyKey = (role) => `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
  const configFor = (key) => getSupabasePublicConfig({
    VITE_SUPABASE_URL: syntheticConfig.VITE_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: key,
  });

  assert.ok(configFor(legacyKey('anon')));
  assert.equal(configFor(legacyKey('service_role')), null);
  assert.equal(configFor('unrecognized-synthetic-key'), null);
});

test('client factory receives only project URL, publishable key, and persistent auth settings', () => {
  const calls = [];
  const expectedClient = { marker: 'synthetic-client' };
  const client = createPortalClient(syntheticConfig, (...args) => {
    calls.push(args);
    return expectedClient;
  });

  assert.equal(client, expectedClient);
  assert.deepEqual(calls, [[
    syntheticConfig.VITE_SUPABASE_URL,
    syntheticConfig.VITE_SUPABASE_PUBLISHABLE_KEY,
    { auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true } },
  ]]);
});
