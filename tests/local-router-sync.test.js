import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isPrivateLanAddress,
  localRouterSyncInternals,
  mapSubscriberToRpcArgs,
  normalizeRouterRows,
  parseCliArgs,
  parseLocalEnvText,
  validateSupabaseConfig,
  verifySupabaseAdminAccess,
} from '../scripts/local-router-sync.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/local-router-sync.json', import.meta.url), 'utf8'));
const organizationId = '10000000-0000-4000-8000-000000000001';

function makeJwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('RouterOS secret parser keeps only safe fields, drops duplicates and ignores password attributes', () => {
  const subscribers = normalizeRouterRows(fixture.secrets, 'remote-address');
  assert.deepEqual(subscribers, [
    {
      username: 'fixture-alice',
      profile: '15M',
      ipAddress: '10.20.30.41',
      comment: 'Alice Fixture - 03001234567 - Shahdara - Block 2',
    },
    {
      username: 'fixture-no-comment',
      profile: '10M',
      ipAddress: '',
      comment: '',
    },
  ]);
  assert.equal(JSON.stringify(subscribers).includes('synthetic-only-do-not-import'), false);
  assert.doesNotMatch(localRouterSyncInternals.ROUTEROS_DISCOVERY_COMMANDS.secrets.join(' '), /password/i);
});

test('active-session fallback maps address but still excludes fields beyond the allowlist', () => {
  const subscribers = normalizeRouterRows(fixture.active, 'address');
  assert.deepEqual(subscribers, [{
    username: 'fixture-active',
    profile: '8M',
    ipAddress: '10.20.30.42',
    comment: 'Active Fixture - 03001234568 - Lahore Road',
  }]);
  assert.doesNotMatch(localRouterSyncInternals.ROUTEROS_DISCOVERY_COMMANDS.active.join(' '), /password/i);
});

test('subscriber mapper matches the guarded atomic import RPC fields and normalizes contact metadata', () => {
  assert.deepEqual(mapSubscriberToRpcArgs(organizationId, {
    username: 'fixture-alice',
    profile: '15M',
    ipAddress: '10.20.30.41',
    comment: 'Alice Fixture - +92 300 1234567 - Shahdara - Block 2',
  }), {
    p_organization_id: organizationId,
    p_username: 'fixture-alice',
    p_name: 'Alice Fixture',
    p_profile: '15M',
    p_assigned_ip: '10.20.30.41',
    p_router_comment: 'Alice Fixture - +92 300 1234567 - Shahdara - Block 2',
    p_service_address: 'Shahdara - Block 2',
    p_phone: '+923001234567',
  });
});

test('CLI is dry-run by default; apply must be explicit and cannot be combined with dry-run', () => {
  assert.deepEqual(parseCliArgs([]), { apply: false, help: false, usernames: [] });
  assert.deepEqual(parseCliArgs(['--dry-run', '--username', 'fixture-alice']), {
    apply: false, help: false, usernames: ['fixture-alice'],
  });
  assert.equal(parseCliArgs(['--apply']).apply, true);
  assert.throws(() => parseCliArgs(['--apply', '--dry-run']), /Choose either/);
  assert.throws(() => parseCliArgs(['--username']), /requires an exact/);
  assert.throws(() => parseCliArgs(['--migrate']), /Unknown argument/);
});

test('local config parser handles comments and quoted tokens without expanding values', () => {
  assert.deepEqual(parseLocalEnvText([
    '# comment',
    'export ROUTER_HOST = 192.168.88.1',
    'ROUTER_PASSWORD="local # password"',
    "SUPABASE_ADMIN_ACCESS_TOKEN='one.two.three'",
    'IGNORED_LINE',
  ].join('\n')), {
    ROUTER_HOST: '192.168.88.1',
    ROUTER_PASSWORD: 'local # password',
    SUPABASE_ADMIN_ACCESS_TOKEN: 'one.two.three',
  });
});

test('private LAN validation allows only private addresses and trusted user JWT/public Supabase keys', () => {
  assert.equal(isPrivateLanAddress('192.168.1.10'), true);
  assert.equal(isPrivateLanAddress('10.0.0.1'), true);
  assert.equal(isPrivateLanAddress('172.31.0.1'), true);
  assert.equal(isPrivateLanAddress('fc00::1'), true);
  assert.equal(isPrivateLanAddress('8.8.8.8'), false);
  assert.equal(isPrivateLanAddress('172.32.0.1'), false);
  assert.equal(isPrivateLanAddress('127.0.0.1'), false);

  const config = validateSupabaseConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    SUPABASE_ORGANIZATION_ID: organizationId,
    SUPABASE_ADMIN_ACCESS_TOKEN: makeJwt({ role: 'authenticated', sub: 'user-1' }),
  });
  assert.equal(config.organizationId, organizationId);
  assert.throws(() => validateSupabaseConfig({}), /SUPABASE_URL/);
  assert.throws(() => validateSupabaseConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: makeJwt({ role: 'service_role' }),
    SUPABASE_ORGANIZATION_ID: organizationId,
    SUPABASE_ADMIN_ACCESS_TOKEN: makeJwt({ role: 'authenticated', sub: 'user-1' }),
  }), /publishable\/anon/);
  assert.throws(() => validateSupabaseConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    SUPABASE_ORGANIZATION_ID: organizationId,
    SUPABASE_ADMIN_ACCESS_TOKEN: makeJwt({ role: 'service_role', sub: 'user-1' }),
  }), /signed-in owner\/admin/);
});

test('router resolution refuses public addresses and plaintext API requires an explicit local-only opt-in', async () => {
  const resolvePrivate = localRouterSyncInternals.resolvePrivateRouterAddress;
  assert.deepEqual(await resolvePrivate('router.lan', async () => [{ address: '192.168.88.1', family: 4 }]), {
    address: '192.168.88.1', family: 4,
  });
  await assert.rejects(
    resolvePrivate('router.example', async () => [{ address: '203.0.113.8', family: 4 }]),
    /private-LAN addresses/,
  );
  assert.throws(() => localRouterSyncInternals.validateRouterConfig({
    ROUTER_HOST: '192.168.88.1', ROUTER_PORT: '8728', ROUTER_USER: 'readonly', ROUTER_PASSWORD: 'synthetic',
  }), /ROUTER_ALLOW_INSECURE_LOCAL=true/);
  assert.equal(localRouterSyncInternals.validateRouterConfig({
    ROUTER_HOST: '192.168.88.1', ROUTER_PORT: '8728', ROUTER_ALLOW_INSECURE_LOCAL: 'true',
    ROUTER_USER: 'readonly', ROUTER_PASSWORD: 'synthetic',
  }).port, 8728);
});

test('apply preflight validates the user session and same-organization admin role before router discovery', async () => {
  const supabase = validateSupabaseConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
    SUPABASE_ORGANIZATION_ID: organizationId,
    SUPABASE_ADMIN_ACCESS_TOKEN: makeJwt({ role: 'authenticated', sub: 'user-1' }),
  });
  const calls = [];
  const verified = await verifySupabaseAdminAccess(supabase, async (input, options) => {
    calls.push({ url: new URL(input), options });
    if (new URL(input).pathname === '/auth/v1/user') {
      return { ok: true, async json() { return { id: 'user-1' }; } };
    }
    return { ok: true, async json() { return [{ role: 'admin' }]; } };
  });
  assert.deepEqual(verified, { userId: 'user-1' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, '/auth/v1/user');
  assert.equal(calls[1].url.pathname, '/rest/v1/organization_memberships');
  assert.equal(calls[1].url.searchParams.get('organization_id'), `eq.${organizationId}`);
  assert.equal(calls[1].options.method, 'GET');

  await assert.rejects(verifySupabaseAdminAccess(supabase, async (input) => (
    new URL(input).pathname === '/auth/v1/user'
      ? { ok: true, async json() { return { id: 'user-1' }; } }
      : { ok: true, async json() { return [{ role: 'customer' }]; } }
  )), /not an owner\/admin/);
});
