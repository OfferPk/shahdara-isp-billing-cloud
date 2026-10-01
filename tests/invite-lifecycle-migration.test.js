import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const migration = await readFile(resolve(root, 'supabase/migrations/20261002120000_customer_invitation_lifecycle.sql'), 'utf8');
const handler = await readFile(resolve(root, 'supabase/functions/invite-customer/handler.js'), 'utf8');
const config = await readFile(resolve(root, 'supabase/config.toml'), 'utf8');

test('invitation state and rate buckets are RLS-protected and not directly available to clients', () => {
  for (const table of ['customer_invitation_requests', 'customer_invitation_rate_limit_buckets']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(migration, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated, service_role`, 'i'));
  }
  assert.match(migration, /revoke all on function public\.reserve_customer_invitation[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /revoke all on function public\.record_customer_invitation_auth_user[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /revoke all on function public\.finalize_customer_invitation[\s\S]*from public, anon, authenticated/i);
  assert.equal((migration.match(/grant execute on function public\.(?:reserve_customer_invitation|record_customer_invitation_auth_user|finalize_customer_invitation)[^;]* to service_role;/gi) ?? []).length, 3);
});

test('new requests are rate-limited per Admin, email digest, and organization', () => {
  assert.match(migration, /values \('admin', p_actor_id::text, v_window_start, 1\)[\s\S]*v_admin_attempts > 5/i);
  assert.match(migration, /values \('email', p_email_hash, v_window_start, 1\)[\s\S]*v_email_attempts > 3/i);
  assert.match(migration, /values \('organization', p_organization_id::text, v_window_start, 1\)[\s\S]*v_org_attempts > 20/i);
  assert.match(migration, /date_trunc\(\s*'hour'/i);
  assert.match(migration, /window_start < v_window_start - interval '24 hours'/i);
});

test('customer reservations serialize concurrent calls and prevent a second active invitation for the same customer/email', () => {
  assert.match(migration, /pg_advisory_xact_lock[\s\S]*p_organization_id::text \|\| ':' \|\| p_customer_id/i);
  assert.match(migration, /primary key \(organization_id, customer_id\)/i);
  assert.match(migration, /create unique index customer_invitation_active_email_unique_idx[\s\S]*where status <> 'linked'/i);
  assert.match(migration, /status = 'sending'[\s\S]*interval '2 minutes'[\s\S]*'in_progress'/i);
  assert.match(handler, /reserve_customer_invitation/);
  assert.match(handler, /inviteUserByEmail/);
  assert.ok(handler.indexOf('reserve_customer_invitation') < handler.indexOf('inviteUserByEmail'));
});

test('recovery stores no raw email and ties Auth users to an opaque request marker', () => {
  const stateTable = migration.match(/create table public\.customer_invitation_requests \(([\s\S]*?)\n\);/i)?.[1] ?? '';
  assert.ok(stateTable, 'state table exists');
  assert.match(stateTable, /email_hash text/i);
  assert.doesNotMatch(stateTable, /\bemail\s+text\b/i);
  assert.match(handler, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(handler, /shahdara_cloud_invite_request_id/);
  assert.match(migration, /raw_user_meta_data ->> 'shahdara_cloud_invite_request_id'/);
  assert.match(migration, /set status = 'linked', email_hash = null, auth_user_id = null/i);
  assert.match(migration, /insert into public\.customer_portal_accounts/i);
  assert.match(handler, /same customer and email again to recover safely/i);
  assert.doesNotMatch(handler, /console\.(?:log|error|warn)/i);
});

test('the Edge Function keeps gateway JWT verification, exact-origin checks, and server-only linking', () => {
  assert.match(config, /\[functions\.invite-customer\]\s+verify_jwt\s*=\s*true/i);
  assert.match(handler, /requestOrigin !== appOrigin/);
  assert.match(handler, /APP_ORIGIN/);
  assert.match(handler, /auth\.getUser\(bearerToken\)/);
  assert.match(handler, /\['owner', 'admin'\]/);
  assert.match(handler, /organization_memberships/);
  assert.match(handler, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(migration, /insert into public\.customer_portal_accounts/);
  assert.match(migration, /grant execute on function public\.finalize_customer_invitation[^;]*to service_role/i);
  assert.match(handler, /p_organization_id: organizationId[\s\S]*p_customer_id: customerId/);
});

test('same-email races serialize and recovery confirms the Auth email digest without storing the address', () => {
  assert.match(migration, /hashtextextended\('email:' \|\| p_organization_id::text \|\| ':' \|\| p_email_hash/i);
  const identityChecks = migration.match(/extensions\.digest\(pg_catalog\.convert_to\(pg_catalog\.lower\(u\.email\), 'UTF8'\), 'sha256'\)/gi) ?? [];
  assert.ok(identityChecks.length >= 3, 'record, direct-link, and crash-recovery paths bind to the same email digest');
  assert.match(migration, /email_hash text[\s\S]*email_hash is null or email_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
});
