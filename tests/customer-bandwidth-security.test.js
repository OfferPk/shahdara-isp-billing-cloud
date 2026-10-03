import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(
  new URL('../supabase/migrations/20261003170000_customer_bandwidth_usage.sql', import.meta.url),
  'utf8',
);
const [portalData, main, usageUi] = await Promise.all([
  readFile(new URL('../src/portal-data.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/customer-usage.js', import.meta.url), 'utf8'),
]);

 test('bandwidth rows retain the requested globally unique schema and trusted profile mapping', () => {
  assert.match(migration, /alter table public\.customers[\s\S]*add column pppoe_username text[\s\S]*unique \(pppoe_username\)/i);
  assert.match(migration, /create table public\.customer_bandwidth_usage\s*\([\s\S]*id uuid primary key default gen_random_uuid\(\)[\s\S]*username text not null unique[\s\S]*total_quota_bytes bigint not null default 0[\s\S]*bytes_in bigint not null default 0[\s\S]*bytes_out bigint not null default 0[\s\S]*is_online boolean not null default false[\s\S]*last_ip text[\s\S]*last_synced_at timestamptz not null default now\(\)[\s\S]*created_at timestamptz not null default now\(\)/i);
  assert.match(migration, /foreign key \(username\)\s*references public\.customers \(pppoe_username\)/i);
  assert.match(migration, /grant update \(pppoe_username\) on public\.customers to authenticated/i);
});

test('authenticated row access is mediated by existing tenant and customer ownership helpers', () => {
  assert.match(migration, /alter table public\.customer_bandwidth_usage enable row level security/i);
  assert.match(migration, /customer_bandwidth_usage_select[\s\S]*public\.is_org_admin\(c\.organization_id\)[\s\S]*public\.owns_customer\(c\.organization_id, c\.id\)/i);
  assert.match(migration, /customer_bandwidth_usage_admin_insert[\s\S]*public\.is_org_admin\(c\.organization_id\)/i);
  assert.match(migration, /customer_bandwidth_usage_admin_update[\s\S]*using[\s\S]*public\.is_org_admin\(c\.organization_id\)[\s\S]*with check[\s\S]*public\.is_org_admin\(c\.organization_id\)/i);
  assert.match(migration, /customer_bandwidth_usage_admin_delete[\s\S]*public\.is_org_admin\(c\.organization_id\)/i);
  assert.match(migration, /revoke all on table public\.customer_bandwidth_usage\s*from public, anon, authenticated, service_role/i);
});

test('the server sync path is a service-role-only security-definer upsert and preserves admin quota', () => {
  assert.match(migration, /create or replace function public\.sync_customer_bandwidth_usage[\s\S]*security definer\s*set search_path = ''/i);
  assert.match(migration, /on conflict \(username\) do update[\s\S]*bytes_in = excluded\.bytes_in[\s\S]*bytes_out = excluded\.bytes_out[\s\S]*last_synced_at = excluded\.last_synced_at/i);
  assert.match(migration, /revoke all on function public\.sync_customer_bandwidth_usage\(text, bigint, bigint, boolean, text\)\s*from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant execute on function public\.sync_customer_bandwidth_usage\(text, bigint, bigint, boolean, text\)\s*to service_role/i);
  assert.doesNotMatch(migration, /grant\s+(?:select|insert|update|delete|all)[^;]*customer_bandwidth_usage[^;]*to service_role/i);
});

test('customer browser usage reads rely on RLS and never request last IP or perform privileged writes', () => {
  assert.match(portalData, /rowsFor\(supabase, 'customer_bandwidth_usage', 'username, total_quota_bytes, bytes_in, bytes_out, is_online, last_synced_at',[\s\S]*?\(query\) => query/);
  assert.match(portalData, /context\.kind === 'customer'[\s\S]*?customerBandwidthUsageQuery/);
  assert.doesNotMatch(portalData, /customer_bandwidth_usage[^;]{0,500}(?:last_ip|\.insert\(|\.update\(|\.upsert\(|\.delete\()/i);
  assert.doesNotMatch(`${main}\n${usageUi}`, /last_ip|sync_customer_bandwidth_usage|service_role|SUPABASE_SERVICE_ROLE_KEY/i);
  assert.doesNotMatch(`${main}\n${portalData}`, /customer_bandwidth_usage[^;]{0,500}\.(?:insert|update|upsert|delete)\(/i);
});
