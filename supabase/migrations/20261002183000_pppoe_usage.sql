-- Additive PPPoE usage MVP for the isolated cloud edition only.
-- Raw RouterOS identities and counters remain server-only. Customers can read
-- only same-customer validated deltas and invoker-secured aggregate views.

begin;

create table if not exists public.pppoe_usage_sites (
  site_id text primary key check (site_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$'),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 100),
  enabled boolean not null default true,
  last_contact_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, site_id)
);

create table if not exists public.pppoe_usage_mappings (
  organization_id uuid not null,
  site_id text not null,
  pppoe_username text not null check (length(btrim(pppoe_username)) between 1 and 255),
  customer_id text not null,
  quota_bytes bigint not null check (quota_bytes > 0),
  speed_download_bps bigint not null check (speed_download_bps > 0),
  speed_upload_bps bigint not null check (speed_upload_bps > 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, site_id, pppoe_username),
  foreign key (organization_id, site_id)
    references public.pppoe_usage_sites(organization_id, site_id) on delete cascade,
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade
);
create index if not exists pppoe_usage_mappings_customer_idx
  on public.pppoe_usage_mappings (organization_id, customer_id, site_id);

-- One customer-readable row per Karachi calendar month, containing only package
-- values and collector freshness. No router or PPPoE identity is stored here.
create table if not exists public.pppoe_usage_customer_months (
  organization_id uuid not null,
  customer_id text not null,
  period_start date not null check (extract(day from period_start) = 1),
  quota_bytes bigint not null check (quota_bytes > 0),
  speed_download_bps bigint not null check (speed_download_bps > 0),
  speed_upload_bps bigint not null check (speed_upload_bps > 0),
  source_count integer not null default 0 check (source_count >= 0),
  fresh_source_count integer not null default 0 check (fresh_source_count >= 0),
  last_collector_contact_at timestamptz,
  last_session_sample_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, customer_id, period_start),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade,
  check (fresh_source_count <= source_count)
);
create index if not exists pppoe_usage_customer_months_period_idx
  on public.pppoe_usage_customer_months (organization_id, period_start desc, customer_id);

-- Private per-site heartbeat state allows a summary to become stale if any
-- configured collection site for that customer stops contacting the cloud.
create table if not exists public.pppoe_usage_customer_sources (
  organization_id uuid not null,
  customer_id text not null,
  period_start date not null,
  site_id text not null,
  last_contact_at timestamptz,
  primary key (organization_id, customer_id, period_start, site_id),
  foreign key (organization_id, customer_id, period_start)
    references public.pppoe_usage_customer_months(organization_id, customer_id, period_start) on delete cascade,
  foreign key (organization_id, site_id)
    references public.pppoe_usage_sites(organization_id, site_id) on delete cascade
);

-- Server-only replay/idempotency ledger for accepted signed collector batches.
create table if not exists public.pppoe_usage_batches (
  site_id text not null references public.pppoe_usage_sites(site_id) on delete cascade,
  snapshot_id uuid not null,
  sampled_at timestamptz not null,
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now(),
  unmapped_session_count integer not null default 0 check (unmapped_session_count >= 0),
  primary key (site_id, snapshot_id)
);
create index if not exists pppoe_usage_batches_received_idx
  on public.pppoe_usage_batches (site_id, received_at desc);

create table if not exists public.pppoe_usage_nonces (
  site_id text not null references public.pppoe_usage_sites(site_id) on delete cascade,
  nonce uuid not null,
  snapshot_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (site_id, nonce)
);

-- Highest accepted cumulative counters per active RouterOS session. A reset or
-- counter decrease begins a new server-generated session segment.
create table if not exists public.pppoe_usage_session_state (
  site_id text not null references public.pppoe_usage_sites(site_id) on delete cascade,
  session_id text not null check (length(session_id) between 1 and 200),
  session_key uuid not null,
  organization_id uuid not null,
  customer_id text not null,
  pppoe_username text not null,
  bytes_in bigint not null check (bytes_in >= 0),
  bytes_out bigint not null check (bytes_out >= 0),
  uptime_seconds bigint not null check (uptime_seconds >= 0),
  sampled_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (site_id, session_id),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade
);

-- Required raw snapshot log: bytes_in/out are RouterOS cumulative counters at
-- sampled_at. RouterOS bytes[0] (sent by router) maps to bytes_out/download;
-- bytes[1] (received by router) maps to bytes_in/upload.
create table if not exists public.pppoe_usage_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id text not null,
  site_id text not null references public.pppoe_usage_sites(site_id) on delete cascade,
  pppoe_username text not null,
  session_id text not null,
  session_key uuid not null,
  snapshot_id uuid not null,
  sampled_at timestamptz not null,
  bytes_in bigint not null check (bytes_in >= 0),
  bytes_out bigint not null check (bytes_out >= 0),
  delta_bytes_in bigint not null check (delta_bytes_in >= 0),
  delta_bytes_out bigint not null check (delta_bytes_out >= 0),
  counter_reset boolean not null default false,
  accepted_at timestamptz not null default now(),
  unique (site_id, snapshot_id, session_key),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade
);
create index if not exists pppoe_usage_logs_customer_time_idx
  on public.pppoe_usage_logs (organization_id, customer_id, sampled_at desc);
create index if not exists pppoe_usage_logs_session_time_idx
  on public.pppoe_usage_logs (site_id, session_id, sampled_at desc);

-- Customer-visible samples contain validated, aggregated deltas only. They do
-- not contain a PPPoE username, site/router id, raw counter, or session identity.
create table if not exists public.pppoe_usage_customer_deltas (
  organization_id uuid not null,
  customer_id text not null,
  snapshot_id uuid not null,
  sampled_at timestamptz not null,
  delta_bytes_in bigint not null check (delta_bytes_in >= 0),
  delta_bytes_out bigint not null check (delta_bytes_out >= 0),
  primary key (organization_id, customer_id, snapshot_id),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade
);
create index if not exists pppoe_usage_customer_deltas_sampled_idx
  on public.pppoe_usage_customer_deltas (organization_id, customer_id, sampled_at desc);

alter table public.pppoe_usage_sites enable row level security;
alter table public.pppoe_usage_mappings enable row level security;
alter table public.pppoe_usage_customer_months enable row level security;
alter table public.pppoe_usage_customer_sources enable row level security;
alter table public.pppoe_usage_batches enable row level security;
alter table public.pppoe_usage_nonces enable row level security;
alter table public.pppoe_usage_session_state enable row level security;
alter table public.pppoe_usage_logs enable row level security;
alter table public.pppoe_usage_customer_deltas enable row level security;

-- Policies are created idempotently. Raw identities/state have no browser policy.
do $policy$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pppoe_usage_customer_months' and policyname = 'pppoe_usage_months_scoped_read') then
    create policy pppoe_usage_months_scoped_read on public.pppoe_usage_customer_months
      for select to authenticated
      using ((select public.is_org_admin(organization_id)) or (select public.owns_customer(organization_id, customer_id)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pppoe_usage_customer_deltas' and policyname = 'pppoe_usage_deltas_scoped_read') then
    create policy pppoe_usage_deltas_scoped_read on public.pppoe_usage_customer_deltas
      for select to authenticated
      using ((select public.is_org_admin(organization_id)) or (select public.owns_customer(organization_id, customer_id)));
  end if;
end
$policy$;

revoke all on table public.pppoe_usage_sites, public.pppoe_usage_mappings,
  public.pppoe_usage_customer_sources, public.pppoe_usage_batches,
  public.pppoe_usage_nonces, public.pppoe_usage_session_state,
  public.pppoe_usage_logs from public, anon, authenticated;
revoke insert, update, delete, truncate on table
  public.pppoe_usage_customer_months, public.pppoe_usage_customer_deltas
  from public, anon, authenticated;
grant select on table public.pppoe_usage_customer_months,
  public.pppoe_usage_customer_deltas to authenticated;
grant all on table public.pppoe_usage_sites, public.pppoe_usage_mappings,
  public.pppoe_usage_customer_months, public.pppoe_usage_customer_sources,
  public.pppoe_usage_batches, public.pppoe_usage_nonces,
  public.pppoe_usage_session_state, public.pppoe_usage_logs,
  public.pppoe_usage_customer_deltas to service_role;

create or replace function public.save_pppoe_usage_mapping(
  p_actor_id uuid,
  p_organization_id uuid,
  p_site_id text,
  p_site_label text,
  p_pppoe_username text,
  p_customer_id text,
  p_quota_bytes bigint,
  p_speed_download_bps bigint,
  p_speed_upload_bps bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_start date;
begin
  if p_actor_id is null or not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id and m.user_id = p_actor_id
      and m.role in ('owner', 'admin')
  ) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_site_id is null or p_site_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$'
     or p_site_label is null or length(p_site_label) > 100
     or p_pppoe_username is null or length(btrim(p_pppoe_username)) not between 1 and 255
     or p_customer_id is null
     or p_quota_bytes is null or p_quota_bytes <= 0
     or p_speed_download_bps is null or p_speed_download_bps <= 0
     or p_speed_upload_bps is null or p_speed_upload_bps <= 0 then
    raise exception 'Invalid PPPoE mapping or plan values' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.customers c
    where c.organization_id = p_organization_id and c.id = p_customer_id and not c.archived
  ) then
    raise exception 'Active customer not found in this organization' using errcode = 'P0002';
  end if;

  insert into public.pppoe_usage_sites (site_id, organization_id, display_name)
  values (p_site_id, p_organization_id, btrim(p_site_label))
  on conflict (site_id) do update
    set display_name = excluded.display_name, updated_at = now()
    where public.pppoe_usage_sites.organization_id = excluded.organization_id
  returning site_id into p_site_id;
  if not found then
    raise exception 'Collection site id belongs to another organization' using errcode = '23505';
  end if;

  insert into public.pppoe_usage_mappings (
    organization_id, site_id, pppoe_username, customer_id,
    quota_bytes, speed_download_bps, speed_upload_bps
  ) values (
    p_organization_id, p_site_id, p_pppoe_username, p_customer_id,
    p_quota_bytes, p_speed_download_bps, p_speed_upload_bps
  )
  on conflict (organization_id, site_id, pppoe_username) do update
    set quota_bytes = excluded.quota_bytes,
        speed_download_bps = excluded.speed_download_bps,
        speed_upload_bps = excluded.speed_upload_bps,
        updated_at = now()
    where public.pppoe_usage_mappings.customer_id = excluded.customer_id;
  if not found then
    raise exception 'A PPPoE identity cannot be reassigned while its prior session may be active' using errcode = '23505';
  end if;

  v_period_start := date_trunc('month', now() at time zone 'Asia/Karachi')::date;
  insert into public.pppoe_usage_customer_months (
    organization_id, customer_id, period_start, quota_bytes,
    speed_download_bps, speed_upload_bps
  ) values (
    p_organization_id, p_customer_id, v_period_start, p_quota_bytes,
    p_speed_download_bps, p_speed_upload_bps
  )
  on conflict (organization_id, customer_id, period_start) do update
    set quota_bytes = excluded.quota_bytes,
        speed_download_bps = excluded.speed_download_bps,
        speed_upload_bps = excluded.speed_upload_bps,
        updated_at = now();

  insert into public.pppoe_usage_customer_sources (
    organization_id, customer_id, period_start, site_id
  ) values (p_organization_id, p_customer_id, v_period_start, p_site_id)
  on conflict (organization_id, customer_id, period_start, site_id) do nothing;

  update public.pppoe_usage_customer_months m
  set source_count = coalesce(s.source_count, 0),
      fresh_source_count = coalesce(s.fresh_source_count, 0),
      last_collector_contact_at = s.last_collector_contact_at,
      updated_at = now()
  from (
    select cs.organization_id, cs.customer_id, cs.period_start,
      count(*)::integer as source_count,
      count(*) filter (where cs.last_contact_at >= now() - interval '15 minutes')::integer as fresh_source_count,
      case when bool_and(cs.last_contact_at is not null) then min(cs.last_contact_at) else null end as last_collector_contact_at
    from public.pppoe_usage_customer_sources cs
    where cs.organization_id = p_organization_id and cs.customer_id = p_customer_id
      and cs.period_start = v_period_start
    group by cs.organization_id, cs.customer_id, cs.period_start
  ) s
  where m.organization_id = s.organization_id and m.customer_id = s.customer_id
    and m.period_start = s.period_start;

  return jsonb_build_object('site_id', p_site_id, 'customer_id', p_customer_id, 'period_start', v_period_start);
end;
$$;

-- Atomically authenticate the service-role caller, dedupe the signed snapshot,
-- map each username server-side, advance per-session high-water counters, write
-- raw snapshot logs, and publish customer-only nonnegative deltas.
create or replace function public.process_pppoe_usage_snapshot(
  p_site_id text,
  p_snapshot_id uuid,
  p_nonce uuid,
  p_sampled_at timestamptz,
  p_body_sha256 text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_received_at timestamptz := clock_timestamp();
  v_period_start date := date_trunc('month', now() at time zone 'Asia/Karachi')::date;
  v_previous_nonce_snapshot uuid;
  v_previous_hash text;
  v_item jsonb;
  v_site record;
  v_mapping record;
  v_state public.pppoe_usage_session_state%rowtype;
  v_session_id text;
  v_username text;
  v_input_session_key uuid;
  v_session_key uuid;
  v_uptime bigint;
  v_bytes_in bigint;
  v_bytes_out bigint;
  v_delta_in bigint;
  v_delta_out bigint;
  v_reset boolean;
  v_out_of_order boolean;
  v_unmapped integer := 0;
  v_key text;
  v_current_in bigint;
  v_current_out bigint;
  v_current_entry jsonb;
  v_customer_deltas jsonb := '{}'::jsonb;
  v_delta_entry jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Server-to-server access required' using errcode = '42501';
  end if;
  if p_site_id is null or p_snapshot_id is null or p_nonce is null
     or p_sampled_at is null or p_body_sha256 is null
     or p_body_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_payload) <> 'object'
     or p_payload->>'snapshot_id' <> p_snapshot_id::text
     or p_payload->>'sampled_at' is null
     or jsonb_typeof(p_payload->'sessions') <> 'array'
     or jsonb_array_length(p_payload->'sessions') > 500
     or p_sampled_at > now() + interval '5 minutes'
     or p_sampled_at < now() - interval '90 days' then
    raise exception 'Invalid or out-of-range PPPoE usage snapshot' using errcode = '22023';
  end if;
  if abs(extract(epoch from ((p_payload->>'sampled_at')::timestamptz - p_sampled_at))) > 1 then
    raise exception 'Snapshot timestamp mismatch' using errcode = '22023';
  end if;

  select s.organization_id into v_organization_id
  from public.pppoe_usage_sites s
  where s.site_id = p_site_id and s.enabled;
  if not found then
    raise exception 'Collection site is not registered or is disabled' using errcode = 'P0002';
  end if;

  insert into public.pppoe_usage_nonces (site_id, nonce, snapshot_id)
  values (p_site_id, p_nonce, p_snapshot_id)
  on conflict (site_id, nonce) do nothing;
  if not found then
    select n.snapshot_id into v_previous_nonce_snapshot
    from public.pppoe_usage_nonces n where n.site_id = p_site_id and n.nonce = p_nonce;
    if v_previous_nonce_snapshot is distinct from p_snapshot_id then
      raise exception 'Signed request nonce was replayed for a different snapshot' using errcode = '23505';
    end if;
  end if;

  select b.body_sha256 into v_previous_hash
  from public.pppoe_usage_batches b
  where b.site_id = p_site_id and b.snapshot_id = p_snapshot_id;
  if found then
    if v_previous_hash <> p_body_sha256 then
      raise exception 'Snapshot id was reused with different content' using errcode = '23505';
    end if;
    return jsonb_build_object('accepted', true, 'duplicate', true, 'unmapped_sessions', 0);
  end if;

  insert into public.pppoe_usage_batches (site_id, snapshot_id, sampled_at, body_sha256)
  values (p_site_id, p_snapshot_id, p_sampled_at, p_body_sha256);

  for v_item in select value from jsonb_array_elements(p_payload->'sessions') loop
    v_session_id := v_item->>'session_id';
    v_username := v_item->>'username';
    if v_session_id is null or length(v_session_id) not between 1 and 200
       or v_username is null or length(btrim(v_username)) not between 1 and 255
       or coalesce(v_item->>'uptime_seconds', '') !~ '^\d{1,12}$'
       or coalesce(v_item->>'bytes_in', '') !~ '^\d{1,19}$'
       or coalesce(v_item->>'bytes_out', '') !~ '^\d{1,19}$'
       or coalesce(v_item->>'session_key', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'Invalid PPPoE session snapshot fields' using errcode = '22023';
    end if;
    v_uptime := (v_item->>'uptime_seconds')::bigint;
    v_bytes_in := (v_item->>'bytes_in')::bigint;
    v_bytes_out := (v_item->>'bytes_out')::bigint;
    v_input_session_key := (v_item->>'session_key')::uuid;
    if v_bytes_in < 0 or v_bytes_out < 0 or v_uptime < 0 then
      raise exception 'Negative RouterOS counters are invalid' using errcode = '22023';
    end if;

    select m.organization_id, m.customer_id, m.pppoe_username
      into v_mapping
    from public.pppoe_usage_mappings m
    where m.organization_id = v_organization_id and m.site_id = p_site_id
      and m.pppoe_username = v_username;
    if not found then
      v_unmapped := v_unmapped + 1;
      continue;
    end if;

    select st.* into v_state
    from public.pppoe_usage_session_state st
    where st.site_id = p_site_id and st.session_id = v_session_id
    for update;
    v_reset := false;
    v_out_of_order := false;
    v_delta_in := 0;
    v_delta_out := 0;
    if found then
      v_out_of_order := p_sampled_at < v_state.sampled_at;
      if not v_out_of_order then
        v_reset := v_username <> v_state.pppoe_username
          or v_bytes_in < v_state.bytes_in
          or v_bytes_out < v_state.bytes_out
          or v_uptime + 5 < v_state.uptime_seconds;
        if (v_state.organization_id <> v_mapping.organization_id
            or v_state.customer_id <> v_mapping.customer_id) and not v_reset then
          raise exception 'Customer mapping changed during an active PPPoE session; wait for a reconnect' using errcode = '23514';
        end if;
        if v_reset then
          v_session_key := case when v_input_session_key = v_state.session_key then gen_random_uuid() else v_input_session_key end;
          v_delta_in := v_bytes_in;
          v_delta_out := v_bytes_out;
        else
          v_session_key := v_state.session_key;
          v_delta_in := v_bytes_in - v_state.bytes_in;
          v_delta_out := v_bytes_out - v_state.bytes_out;
        end if;
      else
        v_session_key := v_state.session_key;
      end if;
    else
      v_session_key := v_input_session_key;
      v_delta_in := v_bytes_in;
      v_delta_out := v_bytes_out;
    end if;

    insert into public.pppoe_usage_logs (
      organization_id, customer_id, site_id, pppoe_username, session_id,
      session_key, snapshot_id, sampled_at, bytes_in, bytes_out,
      delta_bytes_in, delta_bytes_out, counter_reset
    ) values (
      v_mapping.organization_id, v_mapping.customer_id, p_site_id, v_username, v_session_id,
      v_session_key, p_snapshot_id, p_sampled_at, v_bytes_in, v_bytes_out,
      v_delta_in, v_delta_out, v_reset
    );

    if not v_out_of_order then
      insert into public.pppoe_usage_session_state (
        site_id, session_id, session_key, organization_id, customer_id,
        pppoe_username, bytes_in, bytes_out, uptime_seconds, sampled_at, updated_at
      ) values (
        p_site_id, v_session_id, v_session_key, v_mapping.organization_id,
        v_mapping.customer_id, v_username, v_bytes_in, v_bytes_out,
        v_uptime, p_sampled_at, v_received_at
      )
      on conflict (site_id, session_id) do update set
        session_key = excluded.session_key,
        organization_id = excluded.organization_id,
        customer_id = excluded.customer_id,
        pppoe_username = excluded.pppoe_username,
        bytes_in = excluded.bytes_in,
        bytes_out = excluded.bytes_out,
        uptime_seconds = excluded.uptime_seconds,
        sampled_at = excluded.sampled_at,
        updated_at = excluded.updated_at;

      v_key := v_mapping.organization_id::text || '/' || v_mapping.customer_id;
      v_current_entry := coalesce(v_customer_deltas->v_key, '{}'::jsonb);
      v_current_in := coalesce((v_current_entry->>'delta_bytes_in')::bigint, 0);
      v_current_out := coalesce((v_current_entry->>'delta_bytes_out')::bigint, 0);
      v_customer_deltas := jsonb_set(v_customer_deltas, array[v_key], jsonb_build_object(
        'organization_id', v_mapping.organization_id,
        'customer_id', v_mapping.customer_id,
        'delta_bytes_in', v_current_in + v_delta_in,
        'delta_bytes_out', v_current_out + v_delta_out
      ), true);
    end if;
  end loop;

  for v_delta_entry in select value from jsonb_each(v_customer_deltas) loop
    v_key := (v_delta_entry->>'organization_id') || '/' || (v_delta_entry->>'customer_id');
    if (v_delta_entry->>'delta_bytes_in')::bigint > 0 or (v_delta_entry->>'delta_bytes_out')::bigint > 0 then
      insert into public.pppoe_usage_customer_deltas (
        organization_id, customer_id, snapshot_id, sampled_at,
        delta_bytes_in, delta_bytes_out
      ) values (
        (v_delta_entry->>'organization_id')::uuid,
        v_delta_entry->>'customer_id', p_snapshot_id, p_sampled_at,
        (v_delta_entry->>'delta_bytes_in')::bigint,
        (v_delta_entry->>'delta_bytes_out')::bigint
      );
    end if;
  end loop;

  -- Any accepted heartbeat updates each configured customer/site source, even
  -- when no PPPoE sessions are active. Snapshot data times remain separate.
  insert into public.pppoe_usage_customer_sources (
    organization_id, customer_id, period_start, site_id, last_contact_at
  )
  select distinct m.organization_id, m.customer_id, v_period_start, p_site_id, v_received_at
  from public.pppoe_usage_mappings m
  where m.organization_id = v_organization_id and m.site_id = p_site_id
  on conflict (organization_id, customer_id, period_start, site_id) do update
    set last_contact_at = greatest(coalesce(public.pppoe_usage_customer_sources.last_contact_at, excluded.last_contact_at), excluded.last_contact_at);

  insert into public.pppoe_usage_customer_months (
    organization_id, customer_id, period_start, quota_bytes,
    speed_download_bps, speed_upload_bps
  )
  select distinct m.organization_id, m.customer_id, v_period_start,
    m.quota_bytes, m.speed_download_bps, m.speed_upload_bps
  from public.pppoe_usage_mappings m
  where m.organization_id = v_organization_id and m.site_id = p_site_id
  on conflict (organization_id, customer_id, period_start) do nothing;

  update public.pppoe_usage_customer_months m
  set source_count = coalesce(s.source_count, 0),
      fresh_source_count = coalesce(s.fresh_source_count, 0),
      last_collector_contact_at = s.last_collector_contact_at,
      last_session_sample_at = case
        when p_sampled_at >= (v_period_start::timestamp at time zone 'Asia/Karachi')
         and p_sampled_at < ((v_period_start + interval '1 month')::date::timestamp at time zone 'Asia/Karachi')
        then greatest(coalesce(m.last_session_sample_at, p_sampled_at), p_sampled_at)
        else m.last_session_sample_at end,
      updated_at = v_received_at
  from (
    select cs.organization_id, cs.customer_id, cs.period_start,
      count(*)::integer as source_count,
      count(*) filter (where cs.last_contact_at >= v_received_at - interval '15 minutes')::integer as fresh_source_count,
      case when bool_and(cs.last_contact_at is not null) then min(cs.last_contact_at) else null end as last_collector_contact_at
    from public.pppoe_usage_customer_sources cs
    where cs.organization_id = v_organization_id and cs.period_start = v_period_start
    group by cs.organization_id, cs.customer_id, cs.period_start
  ) s
  where m.organization_id = s.organization_id and m.customer_id = s.customer_id
    and m.period_start = s.period_start;

  update public.pppoe_usage_sites
  set last_contact_at = greatest(coalesce(last_contact_at, v_received_at), v_received_at), updated_at = v_received_at
  where site_id = p_site_id;
  update public.pppoe_usage_batches
  set unmapped_session_count = v_unmapped
  where site_id = p_site_id and snapshot_id = p_snapshot_id;

  return jsonb_build_object('accepted', true, 'duplicate', false, 'unmapped_sessions', v_unmapped);
end;
$$;

-- Explicit invoker-secured aggregation helper. Window is half-open [start,end),
-- and sums only the customer-readable per-sample deltas, never raw counters.
create or replace function public.pppoe_usage_rollup(
  p_window_start timestamptz,
  p_window_end timestamptz
)
returns table (
  organization_id uuid,
  customer_id text,
  period_start date,
  upload_bytes bigint,
  download_bytes bigint,
  used_bytes bigint,
  quota_bytes bigint,
  speed_download_bps bigint,
  speed_upload_bps bigint,
  last_collector_contact_at timestamptz,
  is_stale boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.organization_id, m.customer_id, m.period_start,
    coalesce(sum(d.delta_bytes_in), 0)::bigint as upload_bytes,
    coalesce(sum(d.delta_bytes_out), 0)::bigint as download_bytes,
    (coalesce(sum(d.delta_bytes_in), 0) + coalesce(sum(d.delta_bytes_out), 0))::bigint as used_bytes,
    m.quota_bytes, m.speed_download_bps, m.speed_upload_bps,
    m.last_collector_contact_at,
    (m.source_count = 0 or m.fresh_source_count < m.source_count
      or m.last_collector_contact_at is null
      or m.last_collector_contact_at < now() - interval '15 minutes') as is_stale
  from public.pppoe_usage_customer_months m
  left join public.pppoe_usage_customer_deltas d
    on d.organization_id = m.organization_id and d.customer_id = m.customer_id
    and p_window_start is not null and p_window_end is not null
    and p_window_start < p_window_end
    and d.sampled_at >= p_window_start and d.sampled_at < p_window_end
  where m.period_start = date_trunc('month', now() at time zone 'Asia/Karachi')::date
  group by m.organization_id, m.customer_id, m.period_start, m.quota_bytes,
    m.speed_download_bps, m.speed_upload_bps, m.last_collector_contact_at,
    m.source_count, m.fresh_source_count
$$;

create or replace function public.pppoe_usage_month_to_date()
returns table (
  organization_id uuid,
  customer_id text,
  period_start date,
  upload_bytes bigint,
  download_bytes bigint,
  used_bytes bigint,
  quota_bytes bigint,
  remaining_bytes bigint,
  over_quota_bytes bigint,
  speed_download_bps bigint,
  speed_upload_bps bigint,
  last_collector_contact_at timestamptz,
  is_stale boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.organization_id, m.customer_id, m.period_start,
    coalesce(sum(d.delta_bytes_in), 0)::bigint as upload_bytes,
    coalesce(sum(d.delta_bytes_out), 0)::bigint as download_bytes,
    (coalesce(sum(d.delta_bytes_in), 0) + coalesce(sum(d.delta_bytes_out), 0))::bigint as used_bytes,
    m.quota_bytes,
    greatest(m.quota_bytes - coalesce(sum(d.delta_bytes_in), 0) - coalesce(sum(d.delta_bytes_out), 0), 0)::bigint as remaining_bytes,
    greatest(coalesce(sum(d.delta_bytes_in), 0) + coalesce(sum(d.delta_bytes_out), 0) - m.quota_bytes, 0)::bigint as over_quota_bytes,
    m.speed_download_bps, m.speed_upload_bps,
    m.last_collector_contact_at,
    (m.source_count = 0 or m.fresh_source_count < m.source_count
      or m.last_collector_contact_at is null
      or m.last_collector_contact_at < now() - interval '15 minutes') as is_stale
  from public.pppoe_usage_customer_months m
  left join public.pppoe_usage_customer_deltas d
    on d.organization_id = m.organization_id and d.customer_id = m.customer_id
    and d.sampled_at >= (m.period_start::timestamp at time zone 'Asia/Karachi')
    and d.sampled_at < ((m.period_start + interval '1 month')::date::timestamp at time zone 'Asia/Karachi')
  where m.period_start = date_trunc('month', now() at time zone 'Asia/Karachi')::date
  group by m.organization_id, m.customer_id, m.period_start, m.quota_bytes,
    m.speed_download_bps, m.speed_upload_bps, m.last_collector_contact_at,
    m.source_count, m.fresh_source_count
$$;

create or replace view public.pppoe_usage_last_1_hour with (security_invoker = true) as
  select * from public.pppoe_usage_rollup(now() - interval '1 hour', now());
create or replace view public.pppoe_usage_last_2_hours with (security_invoker = true) as
  select * from public.pppoe_usage_rollup(now() - interval '2 hours', now());
create or replace view public.pppoe_usage_last_24_hours with (security_invoker = true) as
  select * from public.pppoe_usage_rollup(now() - interval '24 hours', now());
create or replace view public.pppoe_usage_last_30_days with (security_invoker = true) as
  select * from public.pppoe_usage_rollup(now() - interval '30 days', now());
create or replace view public.pppoe_usage_current_month with (security_invoker = true) as
  select * from public.pppoe_usage_month_to_date();

revoke all on function public.save_pppoe_usage_mapping(uuid, uuid, text, text, text, text, bigint, bigint, bigint)
  from public, anon, authenticated;
revoke all on function public.process_pppoe_usage_snapshot(text, uuid, uuid, timestamptz, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.pppoe_usage_rollup(timestamptz, timestamptz)
  from public, anon;
revoke all on function public.pppoe_usage_month_to_date()
  from public, anon;
grant execute on function public.save_pppoe_usage_mapping(uuid, uuid, text, text, text, text, bigint, bigint, bigint)
  to service_role;
grant execute on function public.process_pppoe_usage_snapshot(text, uuid, uuid, timestamptz, text, jsonb)
  to service_role;
grant execute on function public.pppoe_usage_rollup(timestamptz, timestamptz)
  to authenticated, service_role;
grant execute on function public.pppoe_usage_month_to_date()
  to authenticated, service_role;

revoke all on table public.pppoe_usage_last_1_hour, public.pppoe_usage_last_2_hours,
  public.pppoe_usage_last_24_hours, public.pppoe_usage_last_30_days,
  public.pppoe_usage_current_month from public, anon, authenticated;
grant select on table public.pppoe_usage_last_1_hour, public.pppoe_usage_last_2_hours,
  public.pppoe_usage_last_24_hours, public.pppoe_usage_last_30_days,
  public.pppoe_usage_current_month to authenticated;

comment on table public.pppoe_usage_logs is
  'Server-only RouterOS cumulative PPPoE counter snapshots with validated nonnegative per-sample deltas; do not grant browser access.';
comment on table public.pppoe_usage_customer_deltas is
  'RLS-scoped customer-level per-snapshot upload/download deltas; contains no router, PPPoE username, raw counter, or session identity.';
comment on view public.pppoe_usage_last_24_hours is
  'Rolling usage includes the half-open interval [now() - 24 hours, now()), not a calendar day.';
comment on view public.pppoe_usage_last_1_hour is
  'Rolling usage includes the half-open interval [now() - 1 hour, now()).';
comment on view public.pppoe_usage_last_2_hours is
  'Rolling usage includes the half-open interval [now() - 2 hours, now()).';
comment on view public.pppoe_usage_last_30_days is
  'Rolling usage includes the half-open interval [now() - 30 days, now()).';
comment on view public.pppoe_usage_current_month is
  'Calendar-month usage follows Asia/Karachi and sums validated per-sample deltas.';

commit;
