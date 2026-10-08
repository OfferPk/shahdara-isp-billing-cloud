import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/20261008000000_dual_mode_fup_quota_engine.sql', import.meta.url), 'utf8');
const adminPackages = await readFile(new URL('../src/admin-packages.js', import.meta.url), 'utf8');

function functionDefinition(name) {
  const definition = migration.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, 'i'))?.[0];
  assert.ok(definition, `expected ${name} to be defined in the migration`);
  return definition;
}

test('quota migration is additive, explicitly unapplied, and does not seed organization package rows', () => {
  assert.match(migration, /This migration is not applied automatically or to any database/i);
  assert.match(migration, /add column if not exists quota_type text not null default 'unlimited'/i);
  assert.match(migration, /add column if not exists quota_limit_gb integer/i);
  assert.match(migration, /add column if not exists action_on_exhaust text not null default 'notify'/i);
  assert.match(migration, /quota_type = 'unlimited' and quota_limit_gb is null/i);
  assert.match(migration, /quota_type = 'fup_capped' and quota_limit_gb between 1 and 1000000/i);
  assert.doesNotMatch(migration, /3 Mbps \/ 100 GB|5 Mbps \/ 150 GB|5 Mbps \/ 200 GB|5 Mbps \/ 500 GB|15 Mbps \/ 2000 GB/);
  assert.match(migration, /created only after an authorized organization admin explicitly saves one/i);
  assert.match(adminPackages, /Starter plans are local presets only/);
});

test('package create/edit RPC is organization-admin-only, validates both quota modes, and stores policy without router enforcement', () => {
  const definition = functionDefinition('save_service_package');
  assert.match(definition, /security definer\s+set search_path = ''/i);
  assert.match(definition, /auth\.uid\(\)[\s\S]*public\.is_org_admin\(p_organization_id\)/i);
  assert.match(definition, /p_quota_type is null or p_quota_type not in \('unlimited', 'fup_capped'\)/i);
  assert.match(definition, /p_quota_limit_gb not between 1 and 1000000/i);
  assert.match(definition, /sp\.organization_id = p_organization_id[\s\S]*sp\.id = v_package_id/i);
  assert.match(definition, /quota_type = p_quota_type[\s\S]*quota_limit_gb = p_quota_limit_gb[\s\S]*action_on_exhaust = p_action_on_exhaust/i);
  assert.match(migration, /Throttle\/Suspend policy metadata only; no router-side action is performed/i);
  assert.match(migration, /revoke all on function public\.save_service_package\([\s\S]*?from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.save_service_package\([\s\S]*?to authenticated/i);
});

test('customer package quota RPC returns only the linked account package after ownership verification', () => {
  const definition = functionDefinition('my_customer_package_quota');
  assert.match(definition, /security definer\s+set search_path = ''/i);
  assert.match(definition, /public\.owns_customer\(p_organization_id, p_customer_id\)/i);
  assert.match(definition, /where c\.organization_id = p_organization_id\s+and c\.id = p_customer_id/i);
  assert.match(definition, /left join public\.service_packages sp[\s\S]*sp\.organization_id = c\.organization_id[\s\S]*sp\.id = c\.package_id/i);
  assert.match(migration, /grant execute on function public\.my_customer_package_quota\(uuid, text\)\s+to authenticated/i);
});
