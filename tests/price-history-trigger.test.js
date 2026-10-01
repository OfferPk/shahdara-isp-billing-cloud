import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const migration = await readFile(resolve(root, 'supabase/migrations/20261001120000_cloud_portal.sql'), 'utf8');
const patch = await readFile(resolve(root, 'supabase/review/20261001130000_customer_price_history_trigger_fix.sql'), 'utf8');

test('migration and review patch record inserts only after the customer row exists', () => {
  for (const sql of [migration, patch]) {
    assert.match(sql, /create trigger customers_record_price_history_after_insert\s+after insert on public\.customers/i);
    assert.match(sql, /create trigger customers_record_price_history_before_update\s+before update of monthly_fee_cents, plan_name on public\.customers/i);
    assert.match(sql, /on conflict \(organization_id, customer_id, effective_on\)/i);
    assert.match(sql, /new\.monthly_fee_cents is distinct from old\.monthly_fee_cents[\s\S]*new\.plan_name is distinct from old\.plan_name/i);
  }
});

test('corrective patch does not weaken RLS or drop application data', () => {
  assert.match(patch, /revoke all on function public\.record_customer_price_history\(\) from public, anon, authenticated/i);
  assert.doesNotMatch(patch, /\b(drop table|delete from|truncate)\b/i);
  assert.doesNotMatch(patch, /create policy|grant .* to anon/i);
  assert.match(patch, /begin;[\s\S]*commit;/i);
});
