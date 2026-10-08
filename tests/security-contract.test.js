import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const migrationPath = resolve(root, 'supabase/migrations/20261001120000_cloud_portal.sql');
const billDateMigrationPath = resolve(root, 'supabase/migrations/20261002033000_bill_issue_due_dates.sql');
const customerPhoneMigrationPath = resolve(root, 'supabase/migrations/20261002000000_create_customer_with_private_phone.sql');
const incidentMigrationPath = resolve(root, 'supabase/migrations/20261002150000_admin_incident_management.sql');
const frontendPaths = [
  resolve(root, 'src/main.js'),
  resolve(root, 'src/customer-input.js'),
  resolve(root, 'src/ledger.js'),
  resolve(root, 'src/supabase-client.js'),
  resolve(root, 'src/portal-data.js'),
  resolve(root, 'src/customer-portal.js'),
  resolve(root, 'src/admin-incidents.js'),
  resolve(root, 'index.html'),
  resolve(root, '.env.example'),
];

const migration = await readFile(migrationPath, 'utf8');
const billDateMigration = await readFile(billDateMigrationPath, 'utf8');

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

test('portal sign-in uses username/password aliases and has no customer password mutation path', async () => {
  const main = await readFile(resolve(root, 'src/main.js'), 'utf8');
  const authFlows = await readFile(resolve(root, 'src/auth-flows.js'), 'utf8');
  assert.match(main, /authenticatePortalLogin\(\{/);
  assert.match(authFlows, /functions\.invoke\('customer-login'/);
  assert.match(authFlows, /if \(mode === 'admin'\) return signInWithUsernamePassword\(auth, username, password\)/);
  assert.doesNotMatch(main, /signInWithOtp|signInWithEmailPassword/);
  assert.match(main, /onAuthStateChange/);
  assert.match(main, /getSession\(\)/);
  assert.doesNotMatch(main, /PASSWORD_RECOVERY|passwordRecoveryForm|change-customer-password/);
  assert.match(authFlows, /auth\.signInWithPassword\(/);
  assert.match(authFlows, /\$\{normalizedUsername\}@shahdara\.local/);
  assert.doesNotMatch(authFlows, /updateUser|resetPasswordForEmail|signUp/);
  assert.doesNotMatch(`${main}\n${authFlows}`, /auth\.signUp\s*\(/);
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
  const edgeFunction = await readFile(resolve(root, 'supabase/functions/invite-customer/handler.js'), 'utf8');
  const invitationMigration = await readFile(resolve(root, 'supabase/migrations/20261002120000_customer_invitation_lifecycle.sql'), 'utf8');
  const entrypoint = await readFile(resolve(root, 'supabase/functions/invite-customer/index.ts'), 'utf8');
  const functionConfig = await readFile(resolve(root, 'supabase/config.toml'), 'utf8');
  const membershipQuery = edgeFunction.indexOf(".from('organization_memberships')");
  const customerQuery = edgeFunction.indexOf(".from('customers')");
  const privilegedClient = edgeFunction.indexOf('const adminClient = createClient(supabaseUrl, serverSecret');
  const inviteCall = edgeFunction.indexOf('adminClient.auth.admin.inviteUserByEmail');
  assert.match(edgeFunction, /requestOrigin !== appOrigin/);
  assert.match(edgeFunction, /APP_ORIGIN/);
  assert.match(edgeFunction, /APP_REDIRECT_URL/);
  assert.match(edgeFunction, /auth\.getUser\(bearerToken\)/);
  assert.ok(edgeFunction.includes("global: { headers: { Authorization: `Bearer ${bearerToken}` } }"));
  assert.match(edgeFunction, /organization_memberships/);
  assert.match(edgeFunction, /await userClient\s*\.from\('organization_memberships'\)/);
  assert.match(edgeFunction, /await userClient\s*\.from\('customers'\)/);
  assert.match(edgeFunction, /\['owner', 'admin'\]/);
  assert.match(edgeFunction, /finalize_customer_invitation/);
  assert.ok(membershipQuery >= 0 && membershipQuery < customerQuery && customerQuery < privilegedClient && privilegedClient < inviteCall);
  assert.match(invitationMigration, /insert into public\.customer_portal_accounts/);
  assert.match(invitationMigration, /grant execute on function public\.finalize_customer_invitation[^;]*to service_role/i);
  assert.match(edgeFunction, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(edgeFunction, /redirectTo: appRedirectUrl/);
  assert.match(entrypoint, /Deno\.serve\(createInviteHandler/);
  assert.match(functionConfig, /\[functions\.invite-customer\]\s+verify_jwt\s*=\s*true/i);
});

test('customer phone creation is atomic, server-authorized, and writes only to private details', async () => {
  const migration = await readFile(customerPhoneMigrationPath, 'utf8');
  const schema = await readFile(migrationPath, 'utf8');
  assert.match(schema, /create table public\.customer_private_details\s*\([\s\S]*?phone text not null/i);
  assert.match(schema, /create policy customer_private_admin_only[\s\S]*?on public\.customer_private_details for all to authenticated[\s\S]*?using \(\(select public\.is_org_admin\(organization_id\)\)\)[\s\S]*?with check \(\(select public\.is_org_admin\(organization_id\)\)\)/i);
  assert.match(migration, /if \(select auth\.uid\(\)\) is null or not public\.is_org_admin\(p_organization_id\)/i);
  assert.match(migration, /create or replace function public\.create_customer[\s\S]*?security definer\s+set search_path = ''/i);
  assert.match(migration, /insert into public\.customers\s*\([\s\S]*?\) values \([\s\S]*?returning id into v_customer_id/i);
  assert.match(migration, /insert into public\.customer_private_details\s*\(organization_id, customer_id, phone\)\s*values \(p_organization_id, v_customer_id, v_phone\)/i);
  assert.match(migration, /v_phone !~ '\^\(03\[0-9\]\{9\}\|\[\+\]923\[0-9\]\{9\}\)\$'/i);
  assert.match(migration, /revoke insert \([\s\S]*?\) on public\.customers from authenticated/i);
  assert.match(migration, /revoke all on function public\.create_customer\([\s\S]*?from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.create_customer\([\s\S]*?to authenticated/i);
  assert.match(migration, /begin;[\s\S]*commit;/i);
});

test('customer portal queries and rendering never select or expose customer phone data', async () => {
  const portalData = await readFile(resolve(root, 'src/portal-data.js'), 'utf8');
  const main = await readFile(resolve(root, 'src/main.js'), 'utf8');
  const customerSelection = portalData.match(/const coreColumns = '([^']+)'/i);
  const customerPortal = main.slice(main.indexOf('function renderCustomer()'), main.indexOf('async function refreshCurrentContext('));

  assert.ok(customerSelection, 'customer portal selection is explicit');
  assert.doesNotMatch(customerSelection[1], /phone/i);
  assert.match(portalData, /const testMarkerColumn = context\.kind === 'admin' \? ', portal_test_account' : ''/i, 'only Admin context requests the staging-only test marker');
  assert.match(portalData, /const profileColumns = context\.kind === 'admin'/i, 'only Admin profile context requests the private account creation date');
  assert.match(portalData, /`\$\{profileColumns\}, pppoe_username\$\{testMarkerColumn\}`/i, 'customer and Admin profiles request their approved mapping columns');
  assert.match(portalData, /rows: rows\.map\(\(customer\) => \(\{ \.\.\.customer, pppoe_username: null, portal_test_account: false \}\)\)/);
  assert.match(portalData, /context\.kind === 'admin'[\s\S]*rowsFor\(supabase, 'customer_private_details', 'customer_id, phone, connection_date'/i);
  assert.match(portalData, /: Promise\.resolve\(\[\]\)/);
  assert.doesNotMatch(customerPortal, /phone|email|staff_notes|created_by|recorded_by/i);
});

test('customer history enhancement uses only recorded customer-visible fields and preserves ledger definitions', async () => {
  const portalData = await readFile(resolve(root, 'src/portal-data.js'), 'utf8');
  const main = await readFile(resolve(root, 'src/main.js'), 'utf8');
  const customerPortalModule = await readFile(resolve(root, 'src/customer-portal.js'), 'utf8');
  const customerPortal = main.slice(main.indexOf('function renderCustomerBillingResults()'), main.indexOf('async function refreshCurrentContext('));
  const customerFacingCode = `${customerPortal}\n${customerPortalModule}`;

  assert.match(portalData, /const billColumns = context\.kind === 'admin'[\s\S]*?issued_on, due_date, plan_snapshot, created_at/);
  assert.match(portalData, /: 'id, customer_id, period, amount_due_cents, plan_snapshot'/);
  assert.match(portalData, /rowsFor\(supabase, 'bills', billColumns/);
  assert.match(portalData, /const receiptColumns = context\.kind === 'admin'[\s\S]*?organization_id, id, customer_id, origin_bill_id, received_on, amount_cents, method, created_at'[\s\S]*?: 'id, customer_id, origin_bill_id, received_on, amount_cents, method'/);
  assert.match(portalData, /'receipt_allocations', 'receipt_id, bill_id, customer_id, amount_cents, allocation_kind'/);
  assert.match(portalData, /'incidents', 'id, customer_id, customer_visible_summary, status, reported_at, offline_at, restored_at'/);
  assert.match(customerPortal, /customerReceipts\.reduce/);
  assert.match(customerPortal, /summary\.receiptCashCents/);
  assert.match(customerPortal, /summary\.creditAppliedCents/);
  assert.match(customerPortal, /customer_visible_summary/);
  assert.doesNotMatch(customerFacingCode, /phone|email|staff_notes|created_by|recorded_by|private_details/i);
  assert.doesNotMatch(customerPortal, /username|due_date/i);
});

test('bill dates are nullable, never inferred, and changed only by same-org Admin RPCs', async () => {
  const createStart = billDateMigration.indexOf('create or replace function public.create_monthly_bill');
  const correctStart = billDateMigration.indexOf('create or replace function public.correct_monthly_bill');
  const grantsStart = billDateMigration.indexOf('revoke all on function public.create_monthly_bill');
  const createFunction = billDateMigration.slice(createStart, correctStart);
  const correctFunction = billDateMigration.slice(correctStart, grantsStart);
  const pgTap = await readFile(resolve(root, 'supabase/tests/cloud_portal_rls.test.sql'), 'utf8');

  assert.match(billDateMigration, /alter table public\.bills\s+add column if not exists issued_on date/i);
  assert.doesNotMatch(billDateMigration, /issued_on\s*=\s*created_at/i);
  assert.match(createFunction, /auth\.uid\(\)[\s\S]*?public\.is_org_admin\(p_organization_id\)/i);
  assert.match(createFunction, /if found then\s+return v_bill_id;/i);
  assert.match(createFunction, /issued_on, due_date, plan_snapshot[\s\S]*?p_issued_on, p_due_date/i);
  assert.doesNotMatch(createFunction, /p_period\s*\+\s*interval/i);
  assert.match(correctFunction, /auth\.uid\(\)[\s\S]*?public\.is_org_admin\(p_organization_id\)/i);
  assert.match(correctFunction, /set amount_due_cents = p_amount_due_cents,[\s\S]*issued_on = p_issued_on,[\s\S]*due_date = p_due_date/i);
  assert.match(billDateMigration, /revoke all on function public\.correct_monthly_bill[\s\S]*from public, anon, authenticated/i);
  assert.match(billDateMigration, /grant execute on function public\.correct_monthly_bill[\s\S]*to authenticated/i);
  assert.doesNotMatch(billDateMigration, /grant update\s*\([^)]*(?:issued_on|due_date)/i);
  assert.match(pgTap, /create_monthly_bill[\s\S]*existing monthly snapshots remain unchanged/i);
  assert.match(pgTap, /correct_monthly_bill[\s\S]*admin cannot correct a bill across organizations/i);
});

test('customer billing controls and incident timeline retain accessible states and responsive layouts', async () => {
  const main = await readFile(resolve(root, 'src/main.js'), 'utf8');
  const styles = await readFile(resolve(root, 'src/styles.css'), 'utf8');

  assert.match(main, /role="status" aria-live="polite" aria-busy="true"/);
  assert.match(main, /id="customer-billing-month"/);
  assert.match(main, /id="customer-receipt-from" type="date"/);
  assert.match(main, /id="customer-receipt-through" type="date"/);
  assert.match(main, /id="clear-customer-billing-filters"/);
  assert.match(main, /No bills match the selected month/);
  assert.match(main, /No cash receipts match the selected month and receipt dates/);
  assert.match(main, /No customer-visible service updates are recorded for this account/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*?\.customer-billing-filters \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(styles, /@media \(max-width: 600px\) \{[\s\S]*?\.customer-billing-filters \{ grid-template-columns: 1fr;/);
  assert.match(styles, /\.customer-history-block/);
  assert.match(styles, /\.incident-timeline__event/);
});

test('incident writes use a same-organization Admin RPC and never grant browser table writes', async () => {
  const incidentMigration = await readFile(incidentMigrationPath, 'utf8');
  const portalData = await readFile(resolve(root, 'src/portal-data.js'), 'utf8');
  const adminIncidents = await readFile(resolve(root, 'src/admin-incidents.js'), 'utf8');
  const pgTap = await readFile(resolve(root, 'supabase/tests/incidents_management.test.sql'), 'utf8');

  assert.match(incidentMigration, /create or replace function public\.manage_service_incident\([\s\S]*?security definer\s+set search_path = ''/i);
  assert.match(incidentMigration, /auth\.uid\(\)[\s\S]*?public\.is_org_admin\(p_organization_id\)/i);
  assert.match(incidentMigration, /where organization_id = p_organization_id and id = p_incident_id/i);
  assert.match(incidentMigration, /insert into public\.incident_private_details[\s\S]*?staff_notes[\s\S]*?on conflict/i);
  assert.match(incidentMigration, /revoke all on function public\.manage_service_incident[\s\S]*?from public, anon, authenticated/i);
  assert.match(incidentMigration, /grant execute on function public\.manage_service_incident[\s\S]*?to authenticated/i);
  assert.doesNotMatch(incidentMigration, /grant\s+(?:insert|update|delete)[^;]*public\.(?:incidents|incident_private_details)/i);
  assert.match(portalData, /context\.kind === 'admin'[\s\S]*rowsFor\(supabase, 'incident_private_details', 'incident_id, staff_notes'/i);
  assert.match(portalData, /const packageCatalogQuery = context\.kind === 'admin'[\s\S]*loadServicePackages/);
  assert.match(portalData, /'incidents', 'id, customer_id, customer_visible_summary, status, reported_at, offline_at, restored_at'/);
  assert.match(adminIncidents, /Private to same-organization Admins; stored separately and never copied into the customer-visible summary/);
  assert.match(pgTap, /customer cannot read private incident notes/);
  assert.match(pgTap, /non-admin customer cannot create an incident/);
  assert.match(pgTap, /Admin from another organization cannot update the incident/);
  assert.match(pgTap, /customer cannot directly create private notes/);
});
