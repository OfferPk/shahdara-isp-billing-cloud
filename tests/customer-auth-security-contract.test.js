import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

test('credential mappings and audit are private, globally unique, and contain no plaintext password field', async () => {
  const migration = await read('supabase/migrations/20261002180000_customer_temporary_password_auth.sql');
  assert.match(migration, /create table private\.customer_portal_credentials[\s\S]*?login_id text not null unique/i);
  assert.match(migration, /auth_email_alias text not null unique[\s\S]*?internal\[\.\]shahdara/i);
  assert.match(migration, /revoke all on table private\.customer_portal_credentials,[\s\S]*?from public, anon, authenticated, service_role/i);
  assert.match(migration, /create table private\.customer_portal_credential_audit[\s\S]*?source_ip_hash text/i);
  const credentialTable = migration.match(/create table private\.customer_portal_credentials\s*\(([\s\S]*?)\n\);/i)?.[1] ?? '';
  const auditTable = migration.match(/create table private\.customer_portal_credential_audit\s*\(([\s\S]*?)\n\);/i)?.[1] ?? '';
  assert.doesNotMatch(credentialTable, /password\s+text/i);
  assert.doesNotMatch(auditTable, /password\s+text/i);
  assert.match(migration, /create or replace function public\.resolve_customer_portal_login[\s\S]*?grant execute[\s\S]*?to service_role/i);
  assert.doesNotMatch(migration, /grant execute on function public\.resolve_customer_portal_login[^;]*to authenticated/i);
});

test('customer RLS is server-gated and portal contexts return only IDs from a safe RPC', async () => {
  const migration = await read('supabase/migrations/20261002180000_customer_temporary_password_auth.sql');
  const portalData = await read('src/portal-data.js');
  const main = await read('src/main.js');
  const ownsStart = migration.indexOf('create or replace function public.owns_customer');
  const ownsEnd = migration.indexOf('create or replace function public.my_customer_portal_contexts');
  const owns = migration.slice(ownsStart, ownsEnd);
  const contextStart = ownsEnd;
  const contextEnd = migration.indexOf('create or replace function public.my_customer_portal_password_state');
  const contexts = migration.slice(contextStart, contextEnd);
  assert.match(owns, /c\.status <> 'active' or c\.must_change_password/i);
  assert.match(contexts, /returns table \(organization_id uuid, customer_id text\)/i);
  assert.doesNotMatch(contexts, /login_id|auth_email_alias|expires_at|temporary_password/i);
  assert.match(portalData, /\.rpc\('my_customer_portal_contexts'\)/);
  assert.doesNotMatch(portalData, /\.from\('customer_portal_accounts'\)/);
  const sessionLoader = portalData.slice(portalData.indexOf('export async function loadPortalSessionContexts'));
  const adminCheck = sessionLoader.indexOf('if (adminContexts.length)');
  const passwordStateCheck = sessionLoader.indexOf("supabase.rpc('my_customer_portal_password_state')");
  const customerContextsLoad = sessionLoader.indexOf('loadContexts(supabase, user, memberships)');
  assert.ok(adminCheck >= 0 && adminCheck < passwordStateCheck && passwordStateCheck < customerContextsLoad, 'admins bypass only the customer gate; customer password state remains checked before customer contexts');
  assert.match(main, /loadPortalSessionContexts\(supabase, session\.user\)/);
  assert.match(main, /showCustomerPasswordGate\(passwordState\)/);
  assert.doesNotMatch(main, /functions\.invoke\('change-customer-password'/);
});

test('username-only login maps internally and customer portal exposes no password mutation UI', async () => {
  const main = await read('src/main.js');
  const authFlows = await read('src/auth-flows.js');
  const html = await read('index.html');
  assert.match(html, /id="customer-login-form"/);
  const login = html.match(/<form id="customer-login-form"[\s\S]*?<\/form>/)?.[0] ?? '';
  assert.match(login, /name="username"/);
  assert.match(login, /name="password"/);
  assert.doesNotMatch(login, /type="email"|name="email"|Email/i);
  assert.doesNotMatch(html, /password-recovery-form|mandatory-password-change-form/);
  assert.match(html, /self-service sign-up is disabled/i);
  assert.match(main, /authenticatePortalLogin\(\{/);
  assert.match(authFlows, /functions\.invoke\('customer-login'/);
  assert.match(authFlows, /if \(mode === 'admin'\) return signInWithUsernamePassword\(auth, username, password\)/);
  assert.match(authFlows, /if \(isStaffUsername\(username\)\)/);
  assert.doesNotMatch(main, /signInWithOtp|PASSWORD_RECOVERY|change-customer-password/);
  assert.match(authFlows, /auth\.signInWithPassword\(/);
  assert.match(authFlows, /\$\{normalizedUsername\}@shahdara\.local/);
  assert.doesNotMatch(authFlows, /resetPasswordForEmail|updateUser|signUp/);
  assert.doesNotMatch(`${main}\n${authFlows}`, /auth\.signUp\s*\(/);
  assert.match(main, /Username or password is incorrect or unavailable\./);
});

test('temporary passwords are cryptographic, short-lived, and password changes stay user-scoped', async () => {
  const common = await read('supabase/functions/_shared/customer-auth.js');
  const manage = await read('supabase/functions/manage-customer-credentials/handler.js');
  const change = await read('supabase/functions/change-customer-password/handler.js');
  const migration = await read('supabase/migrations/20261002180000_customer_temporary_password_auth.sql');
  assert.match(common, /crypto\.getRandomValues\(new Uint32Array\(32\)\)/);
  assert.doesNotMatch(common, /Math\.random/);
  assert.match(manage, /temporaryPassword\(\)/);
  assert.match(manage, /email_confirm:\s*true/);
  assert.match(common, /Cache-Control[\s\S]*no-store/i);
  assert.doesNotMatch(manage, /console\.(log|warn|error)/);
  assert.doesNotMatch(migration, /temporary_password\s+text/i);
  assert.match(migration, /expires_at = clock_timestamp\(\) \+ interval '24 hours'/);
  assert.match(migration, /first_login_claimed_at is null/);
  assert.match(change, /new URL\('\/auth\/v1\/user', parsed\)/);
  assert.match(change, /method: 'PUT'/);
  assert.doesNotMatch(change, /method:\s*'PATCH'/);
  assert.match(change, /apikey: clients\.publicKey/);
  assert.match(change, /Authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(change, /\.auth\.updateUser\(/);
  assert.doesNotMatch(change, /auth\.admin\./);
  assert.match(change, /abort_customer_portal_password_change/);
});

test('edge configuration leaves only the broker public and keeps server secrets out of browser source', async () => {
  const config = await read('supabase/config.toml');
  const frontendFiles = await Promise.all([
    'index.html', 'src/main.js', 'src/portal-data.js', 'src/customer-list.js', 'src/language.js',
  ].map(read));
  assert.match(config, /\[functions\.customer-login\]\s+verify_jwt\s*=\s*false/i);
  assert.match(config, /\[functions\.manage-customer-credentials\]\s+verify_jwt\s*=\s*true/i);
  assert.match(config, /\[functions\.change-customer-password\]\s+verify_jwt\s*=\s*true/i);
  assert.doesNotMatch(frontendFiles.join('\n'), /SUPABASE_SERVICE_ROLE_KEY|PORTAL_RATE_LIMIT_HMAC_KEY|service_role/i);
});
