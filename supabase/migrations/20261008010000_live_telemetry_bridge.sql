-- Owner-reviewed additive migration for the local live RouterOS telemetry bridge.
-- Intentionally unapplied: depends on the existing PPPoE/IP mapping and the
-- 20261008003000 monthly session-delta tables/function. The bridge uses an
-- authenticated owner/admin RPC; it never requires a service-role key.
begin;

alter table public.customer_private_details
  add column if not exists last_seen timestamptz;

create table public.active_sessions (
  organization_id uuid not null,
  customer_id text not null,
  username text not null check (length(username) between 1 and 255),
  session_id text not null check (length(session_id) between 1 and 128),
  uptime text not null check (length(uptime) between 1 and 100),
  caller_id text not null default '' check (length(caller_id) <= 255),
  assigned_ip text check (assigned_ip is null or length(assigned_ip) <= 100),
  tx_bytes bigint not null check (tx_bytes >= 0),
  rx_bytes bigint not null check (rx_bytes >= 0),
  status text not null check (status in ('online', 'offline')),
  last_seen timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (organization_id, username, session_id),
  foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) on delete cascade
);

create index active_sessions_org_status_last_seen_idx
  on public.active_sessions (organization_id, status, last_seen desc);

alter table public.active_sessions enable row level security;
revoke all on table public.active_sessions
  from public, anon, authenticated, service_role;
grant select on table public.active_sessions to authenticated;

create policy active_sessions_admin_read
  on public.active_sessions for select to authenticated
  using ((select public.is_org_admin(organization_id)));

-- A single complete router snapshot updates the current-session view and the
-- existing monthly-delta ledger in one transaction. Unknown/unlinked usernames
-- are ignored; mapped customers absent from a successful snapshot go offline.
create or replace function public.sync_live_router_telemetry(
  p_organization_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_username text;
  v_session_id text;
  v_uptime text;
  v_caller_id text;
  v_ip_address text;
  v_tx_text text;
  v_rx_text text;
  v_tx_bytes bigint;
  v_rx_bytes bigint;
  v_customer_id text;
  v_key text;
  v_seen_keys text[] := array[]::text[];
  v_live_items jsonb := '[]'::jsonb;
  v_delta_items jsonb := '[]'::jsonb;
  v_chunk jsonb;
  v_item_count integer;
  v_offset integer;
  v_processed integer := 0;
  v_unmatched integer := 0;
  v_offline_sessions integer := 0;
  v_synced_at timestamptz := pg_catalog.clock_timestamp();
begin
  if (select auth.uid()) is null or p_organization_id is null
     or not public.is_org_admin(p_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception 'Invalid telemetry snapshot' using errcode = '22023';
  end if;
  v_item_count := pg_catalog.jsonb_array_length(p_items);
  if v_item_count > 500 then
    raise exception 'Invalid telemetry snapshot' using errcode = '22023';
  end if;

  -- Serialize overlapping polls for an organization. A timed-out prior write is
  -- safe to retry because session baselines aggregate only monotonic deltas.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_organization_id::text || ':live-telemetry', 0)
  );

  for v_item in
    select entry.value
    from pg_catalog.jsonb_array_elements(p_items) as entry(value)
    order by entry.value ->> 'username', entry.value ->> 'session_id'
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object'
       or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_item)) <> 7
       or not (v_item ?& array[
         'username', 'session_id', 'uptime', 'caller_id', 'ip_address', 'tx_bytes', 'rx_bytes'
       ]) then
      raise exception 'Invalid telemetry item' using errcode = '22023';
    end if;

    v_username := v_item ->> 'username';
    v_session_id := v_item ->> 'session_id';
    v_uptime := v_item ->> 'uptime';
    v_caller_id := v_item ->> 'caller_id';
    v_ip_address := v_item ->> 'ip_address';
    v_tx_text := v_item ->> 'tx_bytes';
    v_rx_text := v_item ->> 'rx_bytes';

    if pg_catalog.jsonb_typeof(v_item -> 'username') <> 'string'
       or v_username is null or v_username = '' or v_username <> pg_catalog.btrim(v_username)
       or pg_catalog.octet_length(v_username) > 128
       or v_session_id is null or v_session_id = '' or v_session_id <> pg_catalog.btrim(v_session_id)
       or pg_catalog.length(v_session_id) > 128
       or v_uptime is null or v_uptime = '' or v_uptime <> pg_catalog.btrim(v_uptime)
       or pg_catalog.length(v_uptime) > 100
       or pg_catalog.jsonb_typeof(v_item -> 'caller_id') <> 'string'
       or v_caller_id is null or v_caller_id <> pg_catalog.btrim(v_caller_id)
       or pg_catalog.length(v_caller_id) > 255
       or pg_catalog.jsonb_typeof(v_item -> 'ip_address') <> 'string'
       or v_ip_address is null or v_ip_address = '' or v_ip_address <> pg_catalog.btrim(v_ip_address)
       or pg_catalog.length(v_ip_address) > 100
       or pg_catalog.jsonb_typeof(v_item -> 'tx_bytes') <> 'string'
       or pg_catalog.jsonb_typeof(v_item -> 'rx_bytes') <> 'string'
       or pg_catalog.length(v_tx_text) not between 1 and 19
       or pg_catalog.length(v_rx_text) not between 1 and 19
       or v_tx_text !~ '^(0|[1-9][0-9]{0,18})$'
       or v_rx_text !~ '^(0|[1-9][0-9]{0,18})$'
       or v_tx_text::numeric > 9223372036854775807
       or v_rx_text::numeric > 9223372036854775807 then
      raise exception 'Invalid telemetry values' using errcode = '22023';
    end if;

    v_key := pg_catalog.jsonb_build_array(v_username, v_session_id)::text;
    if v_key = any(v_seen_keys) then
      raise exception 'Duplicate telemetry session' using errcode = '22023';
    end if;
    v_seen_keys := pg_catalog.array_append(v_seen_keys, v_key);
    v_tx_bytes := v_tx_text::bigint;
    v_rx_bytes := v_rx_text::bigint;

    select c.id into v_customer_id
    from public.customers c
    where c.organization_id = p_organization_id
      and c.pppoe_username = v_username
      and not c.archived
    limit 1;

    if v_customer_id is null then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;

    insert into public.active_sessions (
      organization_id, customer_id, username, session_id, uptime, caller_id,
      assigned_ip, tx_bytes, rx_bytes, status, last_seen, updated_at
    ) values (
      p_organization_id, v_customer_id, v_username, v_session_id, v_uptime,
      v_caller_id, v_ip_address, v_tx_bytes, v_rx_bytes, 'online', v_synced_at, v_synced_at
    )
    on conflict (organization_id, username, session_id) do update
    set customer_id = excluded.customer_id,
        uptime = excluded.uptime,
        caller_id = excluded.caller_id,
        assigned_ip = excluded.assigned_ip,
        tx_bytes = excluded.tx_bytes,
        rx_bytes = excluded.rx_bytes,
        status = 'online',
        last_seen = excluded.last_seen,
        updated_at = excluded.updated_at;

    v_live_items := v_live_items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'username', v_username,
      'session_id', v_session_id,
      'ip_address', v_ip_address
    ));
    v_delta_items := v_delta_items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'username', v_username,
      'session_id', v_session_id,
      'bytes_in', v_tx_text,
      'bytes_out', v_rx_text
    ));
    v_processed := v_processed + 1;
  end loop;

  -- Keep the existing durable monthly delta ledger as the single source for
  -- Pakistan-local month totals. Its RPC accepts 100 items per atomic batch.
  v_item_count := pg_catalog.jsonb_array_length(v_delta_items);
  if v_item_count > 0 then
    for v_offset in 0..(v_item_count - 1) by 100 loop
      select coalesce(pg_catalog.jsonb_agg(entry.value order by entry.ordinality), '[]'::jsonb)
        into v_chunk
      from pg_catalog.jsonb_array_elements(v_delta_items) with ordinality as entry(value, ordinality)
      where entry.ordinality > v_offset and entry.ordinality <= v_offset + 100;
      perform public.sync_customer_bandwidth_session_deltas(v_chunk);
    end loop;
  end if;

  update public.active_sessions s
  set status = 'offline', updated_at = v_synced_at
  where s.organization_id = p_organization_id
    and s.status = 'online'
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_live_items) as active_item(value)
      where active_item.value ->> 'username' = s.username
        and active_item.value ->> 'session_id' = s.session_id
    );
  get diagnostics v_offline_sessions = row_count;

  update public.customers c
  set service_status = case when exists (
        select 1 from pg_catalog.jsonb_array_elements(v_live_items) as active_item(value)
        where active_item.value ->> 'username' = c.pppoe_username
      ) then 'active' else 'offline' end,
      updated_at = v_synced_at
  where c.organization_id = p_organization_id
    and not c.archived
    and c.pppoe_username is not null
    and c.service_status is distinct from case when exists (
      select 1 from pg_catalog.jsonb_array_elements(v_live_items) as active_item(value)
      where active_item.value ->> 'username' = c.pppoe_username
    ) then 'active' else 'offline' end;

  -- Keep one deterministic live IP in the staff-only private profile if a
  -- customer has multiple concurrent PPP sessions; every session stays in the
  -- separate active_sessions table.
  insert into public.customer_private_details (
    organization_id, customer_id, assigned_ip, last_seen, updated_at
  )
  select c.organization_id, c.id, live.ip_address, v_synced_at, v_synced_at
  from public.customers c
  cross join lateral (
    select nullif(active_item.value ->> 'ip_address', '') as ip_address
    from pg_catalog.jsonb_array_elements(v_live_items) as active_item(value)
    where active_item.value ->> 'username' = c.pppoe_username
    order by active_item.value ->> 'session_id'
    limit 1
  ) live
  where c.organization_id = p_organization_id
    and not c.archived
    and c.pppoe_username is not null
  on conflict (organization_id, customer_id) do update
  set assigned_ip = excluded.assigned_ip,
      last_seen = excluded.last_seen,
      updated_at = excluded.updated_at;

  update public.customer_private_details d
  set assigned_ip = null
  from public.customers c
  where c.organization_id = p_organization_id
    and c.organization_id = d.organization_id
    and c.id = d.customer_id
    and not c.archived
    and c.pppoe_username is not null
    and d.assigned_ip is not null
    and not exists (
      select 1 from pg_catalog.jsonb_array_elements(v_live_items) as active_item(value)
      where active_item.value ->> 'username' = c.pppoe_username
    );

  return pg_catalog.jsonb_build_object(
    'processed_sessions', v_processed,
    'unmatched_sessions', v_unmatched,
    'offline_sessions', v_offline_sessions
  );
end;
$$;

revoke all on function public.sync_live_router_telemetry(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.sync_live_router_telemetry(uuid, jsonb)
  to authenticated;

comment on table public.active_sessions is
  'Latest authenticated RouterOS active PPP session snapshots. Caller IDs are staff-only. Session byte counters are not lifetime totals.';
comment on column public.customer_private_details.last_seen is
  'Last successful local RouterOS snapshot that observed this mapped customer online.';
comment on function public.sync_live_router_telemetry(uuid, jsonb) is
  'Owner/admin-only complete snapshot RPC. Updates current session presence and assigned IP, and forwards per-session Tx/download and Rx/upload counters to the monthly delta ledger. It never changes router configuration.';

commit;
