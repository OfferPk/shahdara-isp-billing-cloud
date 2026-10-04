import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/20261004133849_admin_cashflow_customer_costs.sql', import.meta.url), 'utf8');
const portalData = await readFile(new URL('../src/portal-data.js', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const profile = await readFile(new URL('../src/customer-list.js', import.meta.url), 'utf8');

test('cashflow migration is additive, unseeded, tenant-scoped, and append-only', () => {
  assert.match(migration, /create table public\.cashflow_expenses/);
  assert.match(migration, /create table public\.customer_service_cost_history/);
  assert.match(migration, /alter table public\.cashflow_expenses enable row level security/i);
  assert.match(migration, /alter table public\.customer_service_cost_history enable row level security/i);
  assert.match(migration, /using \(\(select public\.is_org_admin\(organization_id\)\)\)/i);
  assert.match(migration, /revoke all on table public\.cashflow_expenses from public, anon, authenticated/i);
  assert.match(migration, /revoke all on table public\.customer_service_cost_history from public, anon, authenticated/i);
  assert.match(migration, /grant select on public\.cashflow_expenses to authenticated/i);
  assert.match(migration, /grant select on public\.customer_service_cost_history to authenticated/i);
  assert.match(migration, /before update or delete on public\.cashflow_expenses/i);
  assert.match(migration, /before update or delete on public\.customer_service_cost_history/i);
  assert.match(migration, /created_at timestamptz not null default clock_timestamp\(\)/i);
  assert.match(migration, /record_cashflow_expense[\s\S]*?security definer\s+set search_path = ''/i);
  assert.match(migration, /record_customer_service_cost[\s\S]*?security definer\s+set search_path = ''/i);
  assert.doesNotMatch(migration, /insert into public\.(?:expenses|customer_service_cost_history)\s*\([^)]*\)\s*values\s*\([^)]*(?:seed|backfill)/i);
  assert.doesNotMatch(migration, /update public\.(?:expenses|customer_private_details|customers|receipts|bills)\b/i);
});

test('cashflow reads and profile cost histories are issued only for same-organization Admin contexts', () => {
  assert.match(portalData, /cashflowExpensesQuery = context\.kind === 'admin'[\s\S]*?cashflow_expenses[\s\S]*?: Promise\.resolve\(\[\]\)/);
  assert.match(portalData, /customerServiceCostsQuery = context\.kind === 'admin'[\s\S]*?customer_service_cost_history[\s\S]*?: Promise\.resolve\(\[\]\)/);
  assert.match(portalData, /\.eq\('organization_id', context\.organizationId\)/);
  assert.match(portalData, /organization_id, customer_id, id, effective_on, monthly_cost_paisa, note, created_at/);
  assert.match(main, /\['owner', 'admin'\]\.includes\(context\.role\)/);
  assert.match(main, /Only same-organization Owners and Admins can record cashflow/);
  assert.match(main, /Server-recorded time is UTC and shown in your local time zone/);
  assert.match(profile, /Total cash collected from posted receipts/);
  assert.match(profile, /Estimated customer contribution/);
  assert.match(profile, /Customer record created/);
});

test('global cashflow uses actual receipts and cash expense rows only, never allocated customer costs or invoice amounts', () => {
  assert.match(main, /summarizeCashflow\(\{\s*receipts: pageState\.rows\.receipts,\s*expenses: pageState\.rows\.cashflowExpenses/);
  assert.match(main, /Operating profit/);
  assert.match(main, /Net cashflow after partner distributions/);
  assert.match(main, /issued or unpaid bills and allocations are not income/i);
  assert.doesNotMatch(main.slice(main.indexOf('function renderCashflowAnalysis'), main.indexOf('function renderAdmin()')), /customerServiceCosts|customer_service_cost_history/);
});
