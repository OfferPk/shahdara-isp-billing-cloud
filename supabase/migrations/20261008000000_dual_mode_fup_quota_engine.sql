-- Additive dual-mode package quota metadata and scoped portal access.
-- This migration is not applied automatically or to any database.
-- The five starter plans live only as client-side presets; package rows are
-- created only after an authorized organization admin explicitly saves one.

begin;

alter table public.service_packages
  add column if not exists quota_type text not null default 'unlimited',
  add column if not exists quota_limit_gb integer,
  add column if not exists action_on_exhaust text not null default 'notify';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.service_packages'::regclass
      and conname = 'service_packages_quota_type_valid'
  ) then
    alter table public.service_packages
      add constraint service_packages_quota_type_valid
      check (quota_type in ('unlimited', 'fup_capped'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.service_packages'::regclass
      and conname = 'service_packages_quota_limit_consistent'
  ) then
    alter table public.service_packages
      add constraint service_packages_quota_limit_consistent
      check (
        (quota_type = 'unlimited' and quota_limit_gb is null)
        or (quota_type = 'fup_capped' and quota_limit_gb between 1 and 1000000)
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.service_packages'::regclass
      and conname = 'service_packages_action_on_exhaust_valid'
  ) then
    alter table public.service_packages
      add constraint service_packages_action_on_exhaust_valid
      check (action_on_exhaust in ('notify', 'throttle', 'suspend'));
  end if;
end
$$;

create or replace function public.save_service_package(
  p_organization_id uuid,
  p_package_id text,
  p_name text,
  p_monthly_fee_cents bigint,
  p_quota_type text,
  p_quota_limit_gb integer,
  p_action_on_exhaust text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_package public.service_packages%rowtype;
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
  v_package_id text := nullif(pg_catalog.btrim(coalesce(p_package_id, '')), '');
  v_effective_on date := pg_catalog.date_trunc('month', current_date)::date;
  v_updated_customers integer := 0;
begin
  if (select auth.uid()) is null or not public.is_org_admin(p_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if pg_catalog.length(v_name) not between 1 and 100
     or v_name ~ '[[:cntrl:]]'
     or p_monthly_fee_cents is null or p_monthly_fee_cents <= 0
     or (v_package_id is not null and pg_catalog.length(v_package_id) > 200) then
    raise exception 'A package name and positive monthly PKR fee are required' using errcode = '22023';
  end if;
  if p_quota_type is null or p_quota_type not in ('unlimited', 'fup_capped')
     or p_action_on_exhaust is null or p_action_on_exhaust not in ('notify', 'throttle', 'suspend')
     or (p_quota_type = 'unlimited' and p_quota_limit_gb is not null)
     or (p_quota_type = 'fup_capped' and (p_quota_limit_gb is null or p_quota_limit_gb not between 1 and 1000000)) then
    raise exception 'Choose a valid quota type, limit, and exhaustion policy' using errcode = '22023';
  end if;

  if v_package_id is null then
    insert into public.service_packages (
      organization_id, name, monthly_fee_cents, effective_on, updated_at,
      quota_type, quota_limit_gb, action_on_exhaust
    ) values (
      p_organization_id, v_name, p_monthly_fee_cents, v_effective_on, now(),
      p_quota_type, p_quota_limit_gb, p_action_on_exhaust
    )
    returning * into v_package;
  else
    update public.service_packages sp
    set name = v_name,
        monthly_fee_cents = p_monthly_fee_cents,
        effective_on = v_effective_on,
        updated_at = now(),
        quota_type = p_quota_type,
        quota_limit_gb = p_quota_limit_gb,
        action_on_exhaust = p_action_on_exhaust
    where sp.organization_id = p_organization_id
      and sp.id = v_package_id
    returning sp.* into v_package;
    if not found then
      raise exception 'Package not found for this organization' using errcode = 'P0002';
    end if;
  end if;

  update public.customers c
  set plan_name = v_package.name,
      monthly_fee_cents = v_package.monthly_fee_cents
  where c.organization_id = p_organization_id
    and c.package_id = v_package.id
    and (c.plan_name is distinct from v_package.name
      or c.monthly_fee_cents is distinct from v_package.monthly_fee_cents);
  get diagnostics v_updated_customers = row_count;

  return jsonb_build_object(
    'packageId', v_package.id,
    'name', v_package.name,
    'monthlyFeeCents', v_package.monthly_fee_cents,
    'quotaType', v_package.quota_type,
    'quotaLimitGb', v_package.quota_limit_gb,
    'actionOnExhaust', v_package.action_on_exhaust,
    'effectiveOn', v_package.effective_on,
    'updatedCustomers', v_updated_customers
  );
end;
$$;

create or replace function public.my_customer_package_quota(
  p_organization_id uuid,
  p_customer_id text
)
returns table (
  package_id text,
  package_name text,
  quota_type text,
  quota_limit_gb integer,
  action_on_exhaust text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null
     or not public.owns_customer(p_organization_id, p_customer_id) then
    raise exception 'Customer portal access required' using errcode = '42501';
  end if;

  return query
  select c.package_id,
         sp.name,
         coalesce(sp.quota_type, 'unlimited'),
         sp.quota_limit_gb,
         coalesce(sp.action_on_exhaust, 'notify')
  from public.customers c
  left join public.service_packages sp
    on sp.organization_id = c.organization_id
   and sp.id = c.package_id
  where c.organization_id = p_organization_id
    and c.id = p_customer_id;
end;
$$;

revoke all on function public.save_service_package(uuid, text, text, bigint, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.save_service_package(uuid, text, text, bigint, text, integer, text)
  to authenticated;
revoke all on function public.my_customer_package_quota(uuid, text)
  from public, anon, authenticated;
grant execute on function public.my_customer_package_quota(uuid, text)
  to authenticated;

comment on column public.service_packages.quota_type is
  'Package quota mode: unlimited or fup_capped. Stored policy metadata only; no router enforcement is performed.';
comment on column public.service_packages.quota_limit_gb is
  'Monthly FUP allowance in decimal GB when quota_type is fup_capped; NULL for unlimited packages.';
comment on column public.service_packages.action_on_exhaust is
  'Configured Notify/Throttle/Suspend policy metadata only; no router-side action is performed.';

commit;
