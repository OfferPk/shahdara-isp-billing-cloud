import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProvisioningPreview,
  deterministicOrganizationId,
  isServiceRoleKey,
  normalizeOwnerEmail,
  parseArgs,
  ORGANIZATION_NAME,
  EXPECTED_PROJECT_REF,
} from '../scripts/provision-owner.js';

const makeJwt = (role) => `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;

test('provisioning helper defaults to a non-mutating dry-run and requires an explicit email-bound apply gate', () => {
  assert.deepEqual(parseArgs([]), { help: false, mode: 'dry-run', confirmEmail: '' });
  assert.deepEqual(parseArgs(['--dry-run']), { help: false, mode: 'dry-run', confirmEmail: '' });
  assert.throws(() => parseArgs(['--apply']), /unless --apply is paired/i);
  assert.throws(() => parseArgs(['--apply', '--confirm-owner-provisioning', '']), /requires the exact owner email/i);
  assert.deepEqual(parseArgs(['--apply', '--confirm-owner-provisioning', 'admin@example.com']), {
    help: false,
    mode: 'apply',
    confirmEmail: 'admin@example.com',
  });
  assert.throws(() => parseArgs(['--dry-run', '--confirm-owner-provisioning', 'admin@example.com']), /only be used with --apply/i);
  assert.throws(() => parseArgs(['--apply', '--dry-run']), /only one/i);
});

test('owner email is normalized and malformed addresses are rejected', () => {
  assert.equal(normalizeOwnerEmail('  ADMIN@Example.COM  '), 'admin@example.com');
  assert.throws(() => normalizeOwnerEmail('not-an-email'), /valid owner email/i);
  assert.throws(() => normalizeOwnerEmail('a'.repeat(250) + '@example.com'), /valid owner email/i);
});

test('service-role validation rejects publishable and anon keys', () => {
  assert.equal(isServiceRoleKey('sb_publishable_example-key'), false);
  assert.equal(isServiceRoleKey(makeJwt('anon')), false);
  assert.equal(isServiceRoleKey('not-a-key'), false);
  assert.equal(isServiceRoleKey(makeJwt('service_role')), true);
  assert.equal(isServiceRoleKey('sb_secret_example-key'), true);
});

test('organization identifier is stable, project-scoped, and a valid UUID', () => {
  const id = deterministicOrganizationId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, deterministicOrganizationId(EXPECTED_PROJECT_REF, ORGANIZATION_NAME));
  assert.notEqual(id, deterministicOrganizationId('another-project-ref', ORGANIZATION_NAME));
});

test('preview contains only the requested organization, confirmed Auth identity, and owner role', () => {
  const preview = buildProvisioningPreview({ email: 'admin@example.com', organization: null, user: null, membership: null });
  assert.equal(preview.project, EXPECTED_PROJECT_REF);
  assert.deepEqual(preview.organization, {
    name: ORGANIZATION_NAME,
    action: 'create one organization row',
    id: deterministicOrganizationId(),
  });
  assert.equal(preview.authUser.email, 'admin@example.com');
  assert.equal(preview.authUser.action, 'create Auth user');
  assert.equal(preview.authUser.email_confirm, true);
  assert.equal(preview.authUser.confirmation_email_sent, false);
  assert.equal(preview.membership.role, 'owner');
  assert.equal(preview.otherRows, 'none (no customers, packages, bills, invoices, or receipts)');
  assert.doesNotMatch(JSON.stringify(preview), /password-value|service-role-key/i);
});

test('preview reports a completed owner link without proposing a role change', () => {
  const preview = buildProvisioningPreview({
    email: 'admin@example.com',
    organization: { id: '4e0f8259-a842-5270-970b-8ce5063b7d95', name: ORGANIZATION_NAME },
    user: { id: 'auth-user', email: 'admin@example.com' },
    membership: { role: 'owner' },
  });
  assert.equal(preview.organization.action, 'reuse existing exact-name row');
  assert.equal(preview.authUser.action, 'already provisioned');
  assert.equal(preview.membership.action, 'already linked');
});
