-- Review fixes for the isolated cloud PPPoE feature. This migration is local/source-only
-- in this task; it is not applied to staging or any hosted database.
begin;

alter table public.pppoe_usage_sites
  add column if not exists quarantined_batch_count integer not null default 0
    check (quarantined_batch_count >= 0),
  add column if not exists last_quarantined_at timestamptz;

alter table public.pppoe_usage_customer_months
  add column if not exists coverage_since timestamptz,
  add column if not exists coverage_incomplete boolean not null default true,
  add column if not exists quarantined_source_count integer not null default 0
    check (quarantined_source_count >= 0);

-- Quota and configured speed are authoritative per PPPoE account. The customer
-- month row remains the username-free aggregate that both Customer and Admin read.
create table public.pppoe_usage_account_months (
  organization_id uuid not null,
  customer_id text not null,
  site_id text not null,
  pppoe_username text not null,
  period_start date not null check (extract(day from period_start) = 1),
  quota_bytes bigint not null check (quota_bytes > 0),
  speed_download_bps bigint not null check (speed_download_bps > 0),
  speed_upload_bps bigint not null check (speed_upload_bps > 0),
  coverage_since timestamptz,
  coverage_incomplete boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, site_id, pppoe_username, period_start),
  foreign key (organization_id, site_id, pppoe_username)
    references public.pppoe_usage_mappings(organization_id, site_id, pppoe_username) on delete cascade,
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade
);
create index pppoe_usage_account_months_customer_idx
  on public.pppoe_usage_account_months (organization_id, customer_id, period_start desc);
alter table public.pppoe_usage_account_months enable row level security;
revoke all on table public.pppoe_usage_account_months from public, anon, authenticated;
grant all on table public.pppoe_usage_account_months to service_role;

-- Rebuild the customer-level plan snapshot as sums of its assigned accounts.
-- Quota and configured rates are explicitly aggregate display values; the Admin
-- account report below retains each account's individual values.
create or replace function public.refresh_pppoe_usage_customer_month_plan(
  p_organization_id uuid,
  p_period_start date
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.pppoe_usage_customer_months m
  set quota_bytes = a.quota_bytes,
      speed_download_bps = a.speed_download_bps,
      speed_upload_bps = a.speed_upload_bps,
      coverage_since = a.coverage_since,
      coverage_incomplete = a.coverage_incomplete,
      updated_at = now()
  from (
    select am.organization_id, am.customer_id, am.period_start,
      sum(am.quota_bytes)::bigint as quota_bytes,
      sum(am.speed_download_bps)::bigint as speed_download_bps,
      sum(am.speed_upload_bps)::bigint as speed_upload_bps,
      min(am.coverage_since) as coverage_since,
      bool_or(am.coverage_incomplete) as coverage_incomplete
    from public.pppoe_usage_account_months am
    where am.organization_id = p_organization_id and am.period_start = p_period_start
    group by am.organization_id, am.customer_id, am.period_start
  ) a
  where m.organization_id = a.organization_id and m.customer_id = a.customer_id
    and m.period_start = a.period_start
$$;

create or replace function public.sync_pppoe_usage_account_month_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_start date := date_trunc('month', now() at time zone 'Asia/Karachi')::date;
begin
  insert into public.pppoe_usage_account_months (
    organization_id, customer_id, site_id, pppoe_username, period_start,
    quota_bytes, speed_download_bps, speed_upload_bps
  ) values (
    new.organization_id, new.customer_id, new.site_id, new.pppoe_username, v_period_start,
    new.quota_bytes, new.speed_download_bps, new.speed_upload_bps
  )
  on conflict (organization_id, site_id, pppoe_username, period_start) do update
    set customer_id = excluded.customer_id,
        quota_bytes = excluded.quota_bytes,
        speed_download_bps = excluded.speed_download_bps,
        speed_upload_bps = excluded.speed_upload_bps,
        updated_at = now();

  insert into public.pppoe_usage_customer_months (
    organization_id, customer_id, period_start, quota_bytes,
    speed_download_bps, speed_upload_bps
  ) values (
    new.organization_id, new.customer_id, v_period_start, new.quota_bytes,
    new.speed_download_bps, new.speed_upload_bps
  ) on conflict (organization_id, customer_id, period_start) do nothing;

  perform public.refresh_pppoe_usage_customer_month_plan(new.organization_id, v_period_start);
  return new;
end;
$$;
create trigger pppoe_usage_mapping_sync_account_plan
  after insert or update on public.pppoe_usage_mappings
  for each row execute function public.sync_pppoe_usage_account_month_plan();

create or replace function public.record_pppoe_usage_account_coverage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_start date := date_trunc('month', now() at time zone 'Asia/Karachi')::date;
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Karachi') at time zone 'Asia/Karachi';
  v_observed_at timestamptz := clock_timestamp();
begin
  update public.pppoe_usage_account_months am
  set coverage_since = coalesce(am.coverage_since, v_observed_at),
      coverage_incomplete = coalesce(am.coverage_since, v_observed_at) > v_month_start,
      updated_at = now()
  where am.organization_id = new.organization_id
    and am.customer_id = new.customer_id
    and am.site_id = new.site_id
    and am.pppoe_username = new.pppoe_username
    and am.period_start = v_period_start;

  if found then
    perform public.refresh_pppoe_usage_customer_month_plan(new.organization_id, v_period_start);
  end if;
  return new;
end;
$$;
create trigger pppoe_usage_log_record_account_coverage
  after insert on public.pppoe_usage_logs
  for each row execute function public.record_pppoe_usage_account_coverage();

create or replace function public.refresh_pppoe_usage_quarantine_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_start date := date_trunc('month', now() at time zone 'Asia/Karachi')::date;
begin
  update public.pppoe_usage_customer_months cm
  set quarantined_source_count = q.quarantined_source_count,
      updated_at = now()
  from (
    select cs.organization_id, cs.customer_id, cs.period_start,
      count(*) filter (where s.quarantined_batch_count > 0)::integer as quarantined_source_count
    from public.pppoe_usage_customer_sources cs
    join public.pppoe_usage_sites s
      on s.organization_id = cs.organization_id and s.site_id = cs.site_id
    where cs.organization_id = new.organization_id
      and cs.period_start = v_period_start
    group by cs.organization_id, cs.customer_id, cs.period_start
  ) q
  where cm.organization_id = q.organization_id and cm.customer_id = q.customer_id
    and cm.period_start = q.period_start;
  return new;
end;
$$;
create trigger pppoe_usage_site_refresh_quarantine_status
  after update of quarantined_batch_count on public.pppoe_usage_sites
  for each row execute function public.refresh_pppoe_usage_quarantine_status();

-- Preserve current-month per-account plans for mappings created before this
-- additive migration, then rebuild their username-free customer aggregates.
insert into public.pppoe_usage_account_months (
  organization_id, customer_id, site_id, pppoe_username, period_start,
  quota_bytes, speed_download_bps, speed_upload_bps
)
select m.organization_id, m.customer_id, m.site_id, m.pppoe_username,
  date_trunc('month', now() at time zone 'Asia/Karachi')::date,
  m.quota_bytes, m.speed_download_bps, m.speed_upload_bps
from public.pppoe_usage_mappings m
on conflict (organization_id, site_id, pppoe_username, period_start) do nothing;

insert into public.pppoe_usage_customer_months (
  organization_id, customer_id, period_start, quota_bytes,
  speed_download_bps, speed_upload_bps, coverage_since, coverage_incomplete
)
select am.organization_id, am.customer_id, am.period_start,
  sum(am.quota_bytes)::bigint, sum(am.speed_download_bps)::bigint,
  sum(am.speed_upload_bps)::bigint, min(am.coverage_since), bool_or(am.coverage_incomplete)
from public.pppoe_usage_account_months am
where am.period_start = date_trunc('month', now() at time zone 'Asia/Karachi')::date
group by am.organization_id, am.customer_id, am.period_start
on conflict (organization_id, customer_id, period_start) do update
  set quota_bytes = excluded.quota_bytes,
      speed_download_bps = excluded.speed_download_bps,
      speed_upload_bps = excluded.speed_upload_bps,
      coverage_since = excluded.coverage_since,
      coverage_incomplete = excluded.coverage_incomplete,
      updated_at = now();

revoke all on function public.refresh_pppoe_usage_customer_month_plan(uuid, date)
  from public, anon, authenticated;
revoke all on function public.sync_pppoe_usage_account_month_plan()
  from public, anon, authenticated;
revoke all on function public.record_pppoe_usage_account_coverage()
  from public, anon, authenticated;
revoke all on function public.refresh_pppoe_usage_quarantine_status()
  from public, anon, authenticated;
grant execute on function public.refresh_pppoe_usage_customer_month_plan(uuid, date)
  to service_role;
grant execute on function public.sync_pppoe_usage_account_month_plan()
  to service_role;
grant execute on function public.record_pppoe_usage_account_coverage()
  to service_role;
grant execute on function public.refresh_pppoe_usage_quarantine_status()
  to service_role;

-- The customer summary remains username-free and parity-safe for Admin. Coverage
-- and quarantine are explicit so a valid recent heartbeat cannot imply complete data.
drop view public.pppoe_usage_last_1_hour;
drop view public.pppoe_usage_last_2_hours;
drop view public.pppoe_usage_last_24_hours;
drop view public.pppoe_usage_last_30_days;
drop view public.pppoe_usage_current_month;
drop function public.pppoe_usage_rollup(timestamptz, timestamptz);
drop function public.pppoe_usage_month_to_date();

create function public.pppoe_usage_rollup(p_window_start timestamptz, p_window_end timestamptz)
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
  is_stale boolean,
  coverage_since timestamptz,
  coverage_incomplete boolean,
  quarantined_source_count integer
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
      or m.last_collector_contact_at < now() - interval '15 minutes'
      or m.quarantined_source_count > 0) as is_stale,
    m.coverage_since, m.coverage_incomplete, m.quarantined_source_count
  from public.pppoe_usage_customer_months m
  left join public.pppoe_usage_customer_deltas d
    on d.organization_id = m.organization_id and d.customer_id = m.customer_id
    and p_window_start is not null and p_window_end is not null
    and p_window_start < p_window_end
    and d.sampled_at >= p_window_start and d.sampled_at < p_window_end
  where m.period_start = date_trunc('month', now() at time zone 'Asia/Karachi')::date
  group by m.organization_id, m.customer_id, m.period_start, m.quota_bytes,
    m.speed_download_bps, m.speed_upload_bps, m.last_collector_contact_at,
    m.source_count, m.fresh_source_count, m.coverage_since,
    m.coverage_incomplete, m.quarantined_source_count
$$;

create function public.pppoe_usage_month_to_date()
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
  is_stale boolean,
  coverage_since timestamptz,
  coverage_incomplete boolean,
  quarantined_source_count integer
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
      or m.last_collector_contact_at < now() - interval '15 minutes'
      or m.quarantined_source_count > 0) as is_stale,
    m.coverage_since, m.coverage_incomplete, m.quarantined_source_count
  from public.pppoe_usage_customer_months m
  left join public.pppoe_usage_customer_deltas d
    on d.organization_id = m.organization_id and d.customer_id = m.customer_id
    and d.sampled_at >= (m.period_start::timestamp at time zone 'Asia/Karachi')
    and d.sampled_at < ((m.period_start + interval '1 month')::date::timestamp at time zone 'Asia/Karachi')
  where m.period_start = date_trunc('month', now() at time zone 'Asia/Karachi')::date
  group by m.organization_id, m.customer_id, m.period_start, m.quota_bytes,
    m.speed_download_bps, m.speed_upload_bps, m.last_collector_contact_at,
    m.source_count, m.fresh_source_count, m.coverage_since,
    m.coverage_incomplete, m.quarantined_source_count
$$;

create view public.pppoe_usage_last_1_hour with (security_invoker = true) as
  select * from public.pppoe_usage_rollup(now() - interval '1 hour', now());
create view public.pppoe_usage_last_2_hours with (security_invoker = true) as
  select * from public.pppoe_usage_rollup(now() - interval '2 hours', now());
create view public.pppoe_usage_last_24_hours with (security_invoker = true) as
  select * from public.pppoe_usage_rollup(now() - interval '24 hours', now());
create view public.pppoe_usage_last_30_days with (security_invoker = true) as
  select * from public.pppoe_usage_rollup(now() - interval '30 days', now());
create view public.pppoe_usage_current_month with (security_invoker = true) as
  select * from public.pppoe_usage_month_to_date();

revoke all on function public.pppoe_usage_rollup(timestamptz, timestamptz) from public, anon;
revoke all on function public.pppoe_usage_month_to_date() from public, anon;
grant execute on function public.pppoe_usage_rollup(timestamptz, timestamptz) to authenticated, service_role;
grant execute on function public.pppoe_usage_month_to_date() to authenticated, service_role;
revoke all on table public.pppoe_usage_last_1_hour, public.pppoe_usage_last_2_hours,
  public.pppoe_usage_last_24_hours, public.pppoe_usage_last_30_days,
  public.pppoe_usage_current_month from public, anon, authenticated;
grant select on table public.pppoe_usage_last_1_hour, public.pppoe_usage_last_2_hours,
  public.pppoe_usage_last_24_hours, public.pppoe_usage_last_30_days,
  public.pppoe_usage_current_month to authenticated, service_role;

-- Server-only Admin account report includes usernames and per-account plan values.
create view public.pppoe_usage_admin_account_month_current with (security_invoker = true) as
  select am.organization_id, am.customer_id, am.period_start, am.site_id,
    am.pppoe_username, am.quota_bytes, am.speed_download_bps, am.speed_upload_bps,
    coalesce(sum(l.delta_bytes_in), 0)::bigint as upload_bytes,
    coalesce(sum(l.delta_bytes_out), 0)::bigint as download_bytes,
    (coalesce(sum(l.delta_bytes_in), 0) + coalesce(sum(l.delta_bytes_out), 0))::bigint as used_bytes,
    am.coverage_since, am.coverage_incomplete
  from public.pppoe_usage_account_months am
  left join public.pppoe_usage_logs l
    on l.organization_id = am.organization_id and l.customer_id = am.customer_id
    and l.site_id = am.site_id and l.pppoe_username = am.pppoe_username
    and l.sampled_at >= (am.period_start::timestamp at time zone 'Asia/Karachi')
    and l.sampled_at < ((am.period_start + interval '1 month')::date::timestamp at time zone 'Asia/Karachi')
  where am.period_start = date_trunc('month', now() at time zone 'Asia/Karachi')::date
  group by am.organization_id, am.customer_id, am.period_start, am.site_id,
    am.pppoe_username, am.quota_bytes, am.speed_download_bps, am.speed_upload_bps,
    am.coverage_since, am.coverage_incomplete;
revoke all on table public.pppoe_usage_admin_account_month_current from public, anon, authenticated;
grant select on table public.pppoe_usage_admin_account_month_current to service_role;

comment on table public.pppoe_usage_account_months is
  'Server-only per-PPPoE-account monthly quota, configured speeds, and usage coverage baseline.';
comment on view public.pppoe_usage_admin_account_month_current is
  'Service-role-only Admin account breakdown; PPPoE usernames never enter customer-readable views.';
comment on view public.pppoe_usage_current_month is
  'Customer-readable username-free calendar-month summary with coverage and quarantine status.';

commit;
