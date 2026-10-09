import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

test('BFF migration keeps customer mapping and sessions private, hashed, and password-free', async () => {
  const sql = await read('supabase/migrations/20261009083823_customer_portal_bff_auth.sql');
  assert.match(sql, /create table private\.customer_portal_bff_accounts[\s\S]*?login_username text not null unique/i);
  assert.match(sql, /create table private\.customer_portal_bff_sessions[\s\S]*?token_hash text not null unique/i);
  assert.match(sql, /revoke all on table private\.customer_portal_bff_accounts[\s\S]*?from public, anon, authenticated, service_role/i);
  assert.match(sql, /grant execute on function public\.read_customer_portal_bff_dashboard\(text\)[\s\S]*?to service_role/i);
  assert.match(sql, /resolve_customer_portal_bff_traffic\(p_token_hash text\)/i);
  assert.doesNotMatch(sql, /password\s+text/i);
  assert.doesNotMatch(sql, /alter table public\.(customers|bills|receipts)\s+(?:add|update|delete)/i);
});

test('customer context and dashboard reads are BFF-only while admin RLS access remains separate', async () => {
  const portalData = await read('src/portal-data.js');
  const main = await read('src/main.js');
  const bffClient = await read('src/customer-bff-client.js');
  const dataHandler = await read('supabase/functions/customer-portal-data/handler.js');
  assert.match(portalData, /if \(context\?\.kind !== 'admin'\)[\s\S]*opaque-session BFF/);
  assert.doesNotMatch(portalData, /\.rpc\('my_customer_portal_contexts'\)/);
  assert.match(main, /fetchCustomerPortalDashboard\(supabase\.functions, pageState\.customerPortalToken\)/);
  assert.match(main, /pageState\.customerPortalToken = portalToken/);
  assert.doesNotMatch(bffClient, /localStorage|sessionStorage/);
  assert.match(dataHandler, /read_customer_portal_bff_dashboard/);
  assert.match(dataHandler, /p_token_hash/);
  assert.doesNotMatch(dataHandler, /request\.json\s*\(|request\.body/i);
});

test('customer username/password login returns an opaque token only; admin authentication stays unchanged', async () => {
  const [html, main, authFlows, loginHandler] = await Promise.all([
    read('index.html'), read('src/main.js'), read('src/auth-flows.js'), read('supabase/functions/customer-login/handler.js'),
  ]);
  const login = html.match(/<form id="customer-login-form"[\s\S]*?<\/form>/)?.[0] ?? '';
  assert.match(login, /name="username"/);
  assert.match(login, /name="password"/);
  assert.doesNotMatch(login, /type="email"|name="email"|Email/i);
  assert.match(authFlows, /if \(mode === 'admin'\) return signInWithUsernamePassword\(auth, username, password\)/);
  assert.match(authFlows, /functions\.invoke\('customer-login'/);
  assert.match(authFlows, /data\?\.portal_token/);
  assert.doesNotMatch(authFlows, /auth\.setSession|auth\.signInWithPassword\(\{ email:.*customer/i);
  assert.match(loginHandler, /auth\.admin\.signOut/);
  assert.match(loginHandler, /create_customer_portal_bff_session/);
  assert.doesNotMatch(loginHandler, /access_token\s*:/);
  assert.doesNotMatch(main, /functions\.invoke\('change-customer-password'|password-recovery-form|PASSWORD_RECOVERY/);
  assert.doesNotMatch(`${main}\n${authFlows}`, /auth\.updateUser\s*\(|auth\.resetPasswordForEmail\s*\(|auth\.signUp\s*\(/);
});

test('BFF dashboard excludes private customer contact/address fields and uses the approved support line', async () => {
  const sql = await read('supabase/migrations/20261009083823_customer_portal_bff_auth.sql');
  const bffClient = await read('src/customer-bff-client.js');
  const main = await read('src/main.js');
  assert.match(sql, /'customer_number', c\.customer_number/);
  assert.match(sql, /'name', c\.name/);
  const customerProjection = sql.slice(sql.indexOf("'customer_number', c.customer_number"), sql.indexOf("'package_id', c.package_id"));
  assert.match(customerProjection, /'has_pppoe_mapping', c\.pppoe_username is not null/);
  assert.doesNotMatch(customerProjection, /phone|service_address|staff_notes|['"]pppoe_username['"]\s*,/i);
  assert.match(bffClient, /service_address: ''/);
  assert.match(bffClient, /CUSTOMER_SUPPORT_PHONE = '\+923155669955'/);
  assert.match(main, /CUSTOMER_SUPPORT_WHATSAPP_URL/);
});

test('bill status uses recorded bill/allocation rows and never generates invoices from customer login', async () => {
  const sql = await read('supabase/migrations/20261009083823_customer_portal_bff_auth.sql');
  const main = await read('src/main.js');
  const usage = await read('src/customer-usage.js');
  assert.match(sql, /'due_date', b\.due_date/);
  assert.match(sql, /from public\.bills b[\s\S]*?from public\.receipt_allocations ra/);
  assert.match(main, /summarizeCustomerBill\(currentMonthBill, rows\.receipts, rows\.allocations\)/);
  assert.match(usage, /Bill amount/);
  assert.match(usage, /Due/);
  assert.doesNotMatch(main.slice(main.indexOf('function renderCustomer()'), main.indexOf('function renderAdmin')), /generate.*invoice|insert.*bill/i);
});

test('live telemetry accepts BFF token hashes only, blocks mock output, and requires verified secure transport', async () => {
  const api = await read('src/server/pppoe-api.js');
  const router = await read('src/server/router-adapters.js');
  const client = await read('src/pppoe-api-client.js');
  const customerAuthStart = api.indexOf('async function authorizeCustomerTraffic');
  const limiterStart = api.indexOf('function createTrafficRateLimiter', customerAuthStart);
  const customerAuth = api.slice(customerAuthStart, limiterStart);
  assert.match(api, /resolve_customer_portal_bff_traffic/);
  assert.match(api, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(api, /createHash\('sha256'\)/);
  assert.doesNotMatch(customerAuth, /my_customer_portal_contexts|auth\.getUser/);
  assert.match(api, /Live RouterOS telemetry is not configured/);
  assert.match(router, /tls\.connect\(/);
  assert.match(router, /rejectUnauthorized:\s*true/);
  assert.match(router, /certificate-validated API-SSL or an explicitly configured private VPN/);
  assert.match(client, /\/api\/customer\/live-traffic/);
});

test('Edge Function configuration marks only manually validated public BFF routes as JWT-free', async () => {
  const config = await read('supabase/config.toml');
  const browserFiles = await Promise.all([
    'index.html', 'src/main.js', 'src/portal-data.js', 'src/customer-bff-client.js', 'src/customer-list.js',
  ].map(read));
  for (const name of ['customer-login', 'customer-portal-data', 'customer-portal-logout']) {
    assert.match(config, new RegExp(`\\[functions\\.${name}\\]\\s+verify_jwt\\s*=\\s*false`, 'i'));
  }
  assert.match(config, /\[functions\.manage-customer-credentials\]\s+verify_jwt\s*=\s*true/i);
  assert.match(config, /\[functions\.change-customer-password\]\s+verify_jwt\s*=\s*true/i);
  assert.doesNotMatch(browserFiles.join('\n'), /SUPABASE_SERVICE_ROLE_KEY|PORTAL_RATE_LIMIT_HMAC_KEY|service_role/i);
});
