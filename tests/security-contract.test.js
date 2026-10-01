import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const migrationPath = resolve(root, 'supabase/migrations/20261001120000_cloud_portal.sql');
const frontendPaths = [
  resolve(root, 'src/main.js'),
  resolve(root, 'src/ledger.js'),
  resolve(root, 'src/supabase-client.js'),
  resolve(root, 'src/portal-data.js'),
  resolve(root, 'index.html'),
  resolve(root, '.env.example'),
];

const migration = await readFile(migrationPath, 'utf8');

test('every public data table has RLS enabled and broad anon/authenticated grants revoked', () => {
  const expectedTables = [
    'organizations', 'organization_memberships', 'customers', 'customer_private_details',
    'customer_portal_accounts', 'price_history', 'bills', 'receipts', 'receipt_allocations',
    'bill_amount_history', 'incidents', 'incident_private_details', 'inventory_items',
    'inventory_movements', 'expenses', 'payroll_date_logs',
  ];
  for (const table of expectedTables) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security;`, 'i'), `${table} RLS`);
    assert.match(migration, new RegExp(`public\\.${table}`, 'i'), `${table} is present in the grant revocation set`);
  }
  assert.match(migration, /revoke all on table[\s\S]*from public, anon, authenticated;/i);
  assert.doesNotMatch(migration, /to anon\s+using\s*\(\s*true\s*\)/i);
});

test('security-definer functions pin an empty search path and qualify public objects', () => {
  const securityDefiners = migration.match(/security definer[\s\S]*?as \$\$/gi) ?? [];
  assert.ok(securityDefiners.length >= 8, 'expected policy helpers, billing functions, and triggers');
  for (const fn of securityDefiners) assert.match(fn, /set search_path\s*=\s*''/i);
  assert.match(migration, /revoke all on function public\.record_cash_receipt[\s\S]*from public, anon;/i);
  assert.match(migration, /grant execute on function public\.record_cash_receipt[\s\S]*to authenticated;/i);
  assert.match(migration, /create view public\.bill_summaries\s+with \(security_invoker = true\)/i);
  assert.match(migration, /revoke all on table public\.bill_summaries from public, anon, authenticated;/i);
});

test('customer receipt writes are RPC-only and allocation rows cannot be directly modified', () => {
  assert.match(migration, /grant select on public\.organizations,[\s\S]*public\.receipts, public\.receipt_allocations/i);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete)[^;]*public\.receipts/i);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete)[^;]*public\.receipt_allocations/i);
  assert.match(migration, /grant insert \(organization_id, id, customer_number, name, plan_name,[\s\S]*on public\.customers to authenticated;/i);
  assert.match(migration, /grant update \(amount_due_cents\) on public\.bills to authenticated;/i);
  assert.doesNotMatch(migration, /grant (?:insert|delete)[^;]*public\.bills/i);
  assert.match(migration, /create or replace function public\.record_cash_receipt/i);
  assert.match(migration, /create or replace function public\.correct_cash_receipt/i);
  assert.match(migration, /create or replace function public\.delete_cash_receipt/i);
});

test('browser files contain no service-role key or server-only secret configuration', async () => {
  const contents = (await Promise.all(frontendPaths.map((path) => readFile(path, 'utf8')))).join('\n');
  assert.doesNotMatch(contents, /SERVICE_ROLE|SECRET_KEY|service_role/i);
  assert.match(contents, /VITE_SUPABASE_URL/);
  assert.match(contents, /VITE_SUPABASE_PUBLISHABLE_KEY/);
  assert.match(contents, /clientFactory\(config\.url, config\.publishableKey/);
});

test('customer-account linking is not writable by authenticated clients', () => {
  assert.match(migration, /grant select on public\.organizations,[\s\S]*public\.customer_portal_accounts/i);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete)[^;]*public\.customer_portal_accounts/i);
  assert.match(migration, /create policy customer_accounts_scoped_read[\s\S]*user_id = \(select auth\.uid\(\)\)/i);
});

test('portal sign-in remains auth-first with self-service sign-up disabled', async () => {
  const main = await readFile(resolve(root, 'src/main.js'), 'utf8');
  assert.match(main, /signInWithOtp/);
  assert.match(main, /shouldCreateUser:\s*false/);
  assert.match(main, /onAuthStateChange/);
  assert.match(main, /getSession\(\)/);
  assert.doesNotMatch(main, /auth\.signUp\s*\(/);
});

test('customer-readable ledger rows contain no staff notes or creator identifiers', () => {
  for (const table of ['bills', 'receipts', 'incidents']) {
    const definition = migration.match(new RegExp(`create table public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i'))?.[1] ?? '';
    assert.ok(definition, `${table} definition is present`);
    assert.doesNotMatch(definition, /\b(note|created_by)\b/i, `${table} has no staff-only fields`);
  }
});

test('admin cross-organization pgTAP assertion runs as authenticated', async () => {
  const pgTap = await readFile(resolve(root, 'supabase/tests/cloud_portal_rls.test.sql'), 'utf8');
  assert.match(pgTap, /reset role;\s*set local role authenticated;\s*select set_config\('request\.jwt\.claim\.sub', '10000000-0000-4000-8000-000000000001', true\);\s*select is\(current_user::text, 'authenticated'[\s\S]*?admin cannot cross into another organization/i);
});

test('customer invitations verify the caller JWT, enforce exact origin, and check organization admin membership', async () => {
  const edgeFunction = await readFile(resolve(root, 'supabase/functions/invite-customer/index.ts'), 'utf8');
  assert.match(edgeFunction, /requestOrigin !== appOrigin/);
  assert.match(edgeFunction, /auth\.getUser\(bearerToken\)/);
  assert.match(edgeFunction, /organization_memberships/);
  assert.match(edgeFunction, /\['owner', 'admin'\]/);
  assert.match(edgeFunction, /customer_portal_accounts/);
  assert.match(edgeFunction, /SUPABASE_SERVICE_ROLE_KEY/);
});
