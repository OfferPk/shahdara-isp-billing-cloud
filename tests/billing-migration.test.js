import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/20261007224500_package_pricing_monthly_invoicing.sql', import.meta.url), 'utf8');

function functionDefinition(name) {
  const definition = migration.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, 'i'))?.[0];
  assert.ok(definition, `expected ${name} to be defined in the migration`);
  return definition;
}

test('billing migration is additive, explicitly unapplied, and assigns organization-scoped invoice numbers', () => {
  assert.match(migration, /This migration is not applied automatically or to any database\./i);
  assert.match(migration, /alter table public\.service_packages\s+add column if not exists effective_on date/i);
  assert.match(migration, /alter table public\.bills add column if not exists invoice_number text/i);
  assert.match(migration, /update public\.bills[\s\S]*set invoice_number = 'SIF-'/i);
  assert.match(migration, /unique index if not exists bills_org_invoice_number_unique_idx\s+on public\.bills \(organization_id, invoice_number\)/i);
});

test('package tariff RPC requires a same-organization administrator and applies a positive effective-month rate', () => {
  const definition = functionDefinition('set_package_monthly_fee');
  assert.match(definition, /security definer\s+set search_path = ''/i);
  assert.match(definition, /auth\.uid\(\)[\s\S]*public\.is_org_admin\(p_organization_id\)/i);
  assert.match(definition, /p_monthly_fee_cents is null or p_monthly_fee_cents <= 0/i);
  assert.match(definition, /sp\.organization_id = p_organization_id[\s\S]*sp\.id = btrim\(p_package_id\)/i);
  assert.match(definition, /effective_on = v_effective_on/i);
  assert.match(definition, /update public\.customers c[\s\S]*set monthly_fee_cents = p_monthly_fee_cents[\s\S]*c\.package_id = v_package\.id/i);
});

test('monthly invoice RPC processes active non-archived customers, skips unpriced accounts, and is retry-safe', () => {
  const definition = functionDefinition('generate_monthly_invoices');
  assert.match(definition, /security definer\s+set search_path = ''/i);
  assert.match(definition, /auth\.uid\(\)[\s\S]*public\.is_org_admin\(p_organization_id\)/i);
  assert.match(definition, /c\.organization_id = p_organization_id[\s\S]*c\.archived = false[\s\S]*c\.service_status = 'active'/i);
  assert.match(definition, /order by c\.customer_number, c\.id\s+for update/i);
  assert.match(definition, /sp\.effective_on <= p_period/i);
  assert.match(definition, /if v_rate is null then\s+v_unpriced := v_unpriced \+ 1;\s+continue;/i);
  assert.match(definition, /b\.customer_id = v_customer\.id and b\.period = p_period[\s\S]*v_existing := v_existing \+ 1/i);
  assert.match(definition, /p_due_date\s*\n\s*\);/i);
});

test('generated bill snapshots keep invoice IDs stable and RPC execution is authenticated-only', () => {
  const definition = functionDefinition('create_monthly_bill');
  assert.match(definition, /security definer\s+set search_path = ''/i);
  assert.match(definition, /'SIF-' \|\| to_char\(p_period, 'YYYYMM'\)/i);
  assert.match(definition, /invoice_number\s*\)[\s\S]*v_invoice_number/i);
  assert.match(definition, /on conflict \(organization_id, customer_id, period\) do nothing/i);
  assert.match(migration, /revoke all on function public\.set_package_monthly_fee\([\s\S]*?from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.set_package_monthly_fee\([\s\S]*?to authenticated/i);
  assert.match(migration, /revoke all on function public\.generate_monthly_invoices\([\s\S]*?from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.generate_monthly_invoices\([\s\S]*?to authenticated/i);
});
