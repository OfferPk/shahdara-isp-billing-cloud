import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/20261008003000_monthly_quota_poller_delta_aggregation.sql', import.meta.url), 'utf8');
const agent = await readFile(new URL('../agent/mikrotik-sync-agent.js', import.meta.url), 'utf8');
const handler = await readFile(new URL('../supabase/functions/sync-agent-ingest/handler.js', import.meta.url), 'utf8');

test('monthly aggregation is an additive unapplied migration with durable per-session and per-month counters', () => {
  assert.match(migration, /create table public\.customer_bandwidth_monthly_usage/i);
  assert.match(migration, /create table public\.customer_bandwidth_session_counters/i);
  assert.match(migration, /primary key \(username, usage_month\)/i);
  assert.match(migration, /primary key \(username, session_id\)/i);
  assert.match(migration, /v_bytes_in >= v_previous_in then v_bytes_in - v_previous_in else v_bytes_in/i);
  assert.match(migration, /date_trunc\([\s\S]*'Asia\/Karachi'/i);
  assert.match(migration, /intentionally unapplied/i);
});

test('session baselines are not directly table-readable; only the service role can execute the batch RPC', () => {
  assert.match(migration, /alter table public\.customer_bandwidth_monthly_usage enable row level security/i);
  assert.match(migration, /create policy customer_bandwidth_monthly_usage_select/i);
  assert.match(migration, /revoke all on table public\.customer_bandwidth_session_counters\s+from public, anon, authenticated, service_role/i);
  assert.match(migration, /revoke all on function public\.sync_customer_bandwidth_session_deltas\(jsonb\)\s+from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant execute on function public\.sync_customer_bandwidth_session_deltas\(jsonb\)\s+to service_role/i);
});

test('poller and ingestion preserve session identity and require a separate fail-closed delta gate', () => {
  assert.match(agent, /pollIntervalMs: 60_000/);
  assert.match(agent, /counterScope: 'routeros-session-delta'/);
  assert.match(agent, /counter_scope: 'routeros-session-delta'/);
  assert.match(handler, /SYNC_AGENT_DELTA_SOURCE_CONFIRMED/);
  assert.match(handler, /sync_customer_bandwidth_session_deltas/);
});

test('monthly deltas are explicitly estimates and the SQL contains no router enforcement path', () => {
  assert.match(migration, /may miss bytes transferred between the last poll and a disconnect/i);
  assert.match(migration, /never changes RouterOS session, throttle, or suspension state/i);
  assert.doesNotMatch(migration, /\/ppp\/active\/remove|\/ppp\/secret\/set|\/ppp\/active\/disable/i);
});
