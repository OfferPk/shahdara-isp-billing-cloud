-- Poll RouterOS active PPP sessions every minute and aggregate monotonic
-- per-session counter deltas into customer/month totals. This migration is
-- intentionally unapplied; it does not enable a poller or alter router policy.
begin;

create table public.customer_bandwidth_monthly_usage (
  username text not null references public.customers (pppoe_username)
    on update cascade on delete cascade,
  usage_month date not null check (
    usage_month = pg_catalog.date_trunc('month', usage_month::timestamp)::date
  ),
  bytes_in bigint not null default 0 check (bytes_in >= 0),
  bytes_out bigint not null default 0 check (bytes_out >= 0),
  last_synced_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (username, usage_month)
);

create table public.customer_bandwidth_session_counters (
  username text not null references public.customers (pppoe_username)
    on update cascade on delete cascade,
  session_id text not null check (pg_catalog.length(session_id) between 1 and 128),
  bytes_in bigint not null default 0 check (bytes_in >= 0),
  bytes_out bigint not null default 0 check (bytes_out >= 0),
  last_seen_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (username, session_id)
);

alter table public.customer_bandwidth_monthly_usage enable row level security;
alter table public.customer_bandwidth_session_counters enable row level security;
revoke all on table public.customer_bandwidth_monthly_usage
  from public, anon, authenticated, service_role;
revoke all on table public.customer_bandwidth_session_counters
  from public, anon, authenticated, service_role;
grant select on table public.customer_bandwidth_monthly_usage to authenticated;

create policy customer_bandwidth_monthly_usage_select
  on public.customer_bandwidth_monthly_usage for select to authenticated
  using (
    exists (
      select 1
      from public.customers c
      where c.pppoe_username = customer_bandwidth_monthly_usage.username
        and (
          (select public.is_org_admin(c.organization_id))
          or (select public.owns_customer(c.organization_id, c.id))
        )
    )
  );

-- One atomic, server-only batch call persists the last observed counter for
-- each PPPoE session and adds only the increase to the current Pakistan-local
-- calendar month. A counter reset is treated as a new counter epoch.
create or replace function public.sync_customer_bandwidth_session_deltas(p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_username text;
  v_session_id text;
  v_key text;
  v_seen_keys text[] := array[]::text[];
  v_bytes_in bigint;
  v_bytes_out bigint;
  v_previous_in bigint;
  v_previous_out bigint;
  v_delta_in bigint;
  v_delta_out bigint;
  v_month_in bigint;
  v_month_out bigint;
  v_usage_month date := pg_catalog.date_trunc(
    'month', pg_catalog.clock_timestamp() at time zone 'Asia/Karachi'
  )::date;
  v_synced_at timestamptz := pg_catalog.clock_timestamp();
  v_processed integer := 0;
  v_item_count integer;
begin
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception 'Invalid session delta batch' using errcode = '22023';
  end if;
  v_item_count := pg_catalog.jsonb_array_length(p_items);
  if v_item_count > 100 then
    raise exception 'Invalid session delta batch' using errcode = '22023';
  end if;

  for v_item in
    select entry.value
    from pg_catalog.jsonb_array_elements(p_items) as entry(value)
    order by entry.value ->> 'username', entry.value ->> 'session_id'
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object'
       or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_item)) <> 4
       or not (v_item ? 'username') or not (v_item ? 'session_id')
       or not (v_item ? 'bytes_in') or not (v_item ? 'bytes_out') then
      raise exception 'Invalid session delta item' using errcode = '22023';
    end if;

    v_username := v_item ->> 'username';
    v_session_id := v_item ->> 'session_id';
    if v_username is null or v_username = '' or v_username <> pg_catalog.btrim(v_username)
       or pg_catalog.octet_length(v_username) > 128
       or v_session_id is null or v_session_id = '' or v_session_id <> pg_catalog.btrim(v_session_id)
       or pg_catalog.length(v_session_id) > 128
       or pg_catalog.jsonb_typeof(v_item -> 'bytes_in') is null
       or pg_catalog.jsonb_typeof(v_item -> 'bytes_out') is null
       or pg_catalog.jsonb_typeof(v_item -> 'bytes_in') not in ('number', 'string')
       or pg_catalog.jsonb_typeof(v_item -> 'bytes_out') not in ('number', 'string')
       or (v_item ->> 'bytes_in') !~ '^(0|[1-9][0-9]{0,18})$'
       or (v_item ->> 'bytes_out') !~ '^(0|[1-9][0-9]{0,18})$' then
      raise exception 'Invalid session delta values' using errcode = '22023';
    end if;

    v_bytes_in := (v_item ->> 'bytes_in')::bigint;
    v_bytes_out := (v_item ->> 'bytes_out')::bigint;
    v_key := pg_catalog.jsonb_build_array(v_username, v_session_id)::text;
    if v_key = any(v_seen_keys) then
      raise exception 'Duplicate session delta item' using errcode = '22023';
    end if;
    v_seen_keys := pg_catalog.array_append(v_seen_keys, v_key);

    insert into public.customer_bandwidth_session_counters (
      username, session_id, bytes_in, bytes_out, last_seen_at
    ) values (v_username, v_session_id, 0, 0, v_synced_at)
    on conflict (username, session_id) do nothing;

    select counters.bytes_in, counters.bytes_out
      into v_previous_in, v_previous_out
    from public.customer_bandwidth_session_counters counters
    where counters.username = v_username and counters.session_id = v_session_id
    for update;

    -- First sighting counts the RouterOS session counters observed so far.
    -- A lower counter is a router/session reset, so start a fresh epoch.
    v_delta_in := case when v_bytes_in >= v_previous_in then v_bytes_in - v_previous_in else v_bytes_in end;
    v_delta_out := case when v_bytes_out >= v_previous_out then v_bytes_out - v_previous_out else v_bytes_out end;

    update public.customer_bandwidth_session_counters
    set bytes_in = v_bytes_in, bytes_out = v_bytes_out, last_seen_at = v_synced_at
    where username = v_username and session_id = v_session_id;

    insert into public.customer_bandwidth_monthly_usage (
      username, usage_month, bytes_in, bytes_out, last_synced_at
    ) values (v_username, v_usage_month, 0, 0, v_synced_at)
    on conflict (username, usage_month) do nothing;

    select monthly.bytes_in, monthly.bytes_out
      into v_month_in, v_month_out
    from public.customer_bandwidth_monthly_usage monthly
    where monthly.username = v_username and monthly.usage_month = v_usage_month
    for update;

    if v_delta_in > 9223372036854775807 - v_month_in
       or v_delta_out > 9223372036854775807 - v_month_out then
      raise exception 'Monthly usage counter overflow' using errcode = '22003';
    end if;

    update public.customer_bandwidth_monthly_usage
    set bytes_in = v_month_in + v_delta_in,
        bytes_out = v_month_out + v_delta_out,
        last_synced_at = v_synced_at
    where username = v_username and usage_month = v_usage_month;
    v_processed := v_processed + 1;
  end loop;

  return v_processed;
end;
$$;

revoke all on function public.sync_customer_bandwidth_session_deltas(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.sync_customer_bandwidth_session_deltas(jsonb)
  to service_role;

comment on table public.customer_bandwidth_monthly_usage is
  'RouterOS poller-derived month totals. Active-session polling may miss bytes transferred between the last poll and a disconnect; values are usage estimates, not billing-grade accounting.';
comment on table public.customer_bandwidth_session_counters is
  'Last observed per-session RouterOS cumulative byte counters used as durable delta baselines; never customer-readable.';
comment on function public.sync_customer_bandwidth_session_deltas(jsonb) is
  'Service-role-only atomic poll ingestion; records advisory usage totals and never changes RouterOS session, throttle, or suspension state.';

commit;
