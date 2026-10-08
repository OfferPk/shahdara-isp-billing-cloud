-- Additive Step 4 billing engine migration.
-- Depends on the cloud portal schema and the reviewed router subscriber import
-- migration that creates service_packages and customers.package_id.
-- This migration is not applied automatically or to any database.

begin;

alter table public.service_packages
  add column if not exists effective_on date not null default (date_trunc('month', current_date)::date),
  add column if not exists updated_at timestamptz not null default now();

alter table public.bills add column if not exists invoice_number text;

update public.bills b
set invoice_number = 'SIF-' || to_char(b.period, 'YYYYMM') || '-' || c.customer_number::text
from public.customers c
where c.organization_id = b.organization_id
  and c.id = b.customer_id
  and b.invoice_number is null;

alter table public.bills
  alter column invoice_number set not null;

create unique index if not exists bills_org_invoice_number_unique_idx
  on public.bills (organization_id, invoice_number);

create or replace function public.set_package_monthly_fee(
  p_organization_id uuid,
  p_package_id text,
  p_monthly_fee_cents bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_package public.service_packages%rowtype;
  v_effective_on date := date_trunc('month', current_date)::date;
  v_updated_customers integer := 0;
begin
  if (select auth.uid()) is null or not public.is_org_admin(p_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_package_id is null or length(btrim(p_package_id)) not between 1 and 200
     or p_monthly_fee_cents is null or p_monthly_fee_cents <= 0 then
    raise exception 'A package and a positive monthly PKR fee are required' using errcode = '22023';
  end if;

  update public.service_packages sp
  set monthly_fee_cents = p_monthly_fee_cents,
      effective_on = v_effective_on,
      updated_at = now()
  where sp.organization_id = p_organization_id
    and sp.id = btrim(p_package_id)
  returning sp.* into v_package;
  if not found then
    raise exception 'Package not found for this organization' using errcode = 'P0002';
  end if;

  update public.customers c
  set monthly_fee_cents = p_monthly_fee_cents
  where c.organization_id = p_organization_id
    and c.package_id = v_package.id
    and c.monthly_fee_cents is distinct from p_monthly_fee_cents;
  get diagnostics v_updated_customers = row_count;

  return jsonb_build_object(
    'packageId', v_package.id,
    'name', v_package.name,
    'monthlyFeeCents', v_package.monthly_fee_cents,
    'effectiveOn', v_package.effective_on,
    'updatedCustomers', v_updated_customers
  );
end;
$$;

create or replace function public.create_monthly_bill(
  p_organization_id uuid,
  p_customer_id text,
  p_period date,
  p_bill_id text default null,
  p_issued_on date default null,
  p_due_date date default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer public.customers%rowtype;
  v_bill_id text;
  v_amount bigint;
  v_plan text;
  v_invoice_number text;
begin
  if (select auth.uid()) is null or not public.is_org_admin(p_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_period is null or extract(day from p_period) <> 1 then
    raise exception 'Billing period must be the first day of a month' using errcode = '22023';
  end if;
  if p_bill_id is not null and (length(p_bill_id) = 0 or length(p_bill_id) > 200) then
    raise exception 'Invalid bill ID' using errcode = '22023';
  end if;

  select c.* into v_customer
  from public.customers c
  where c.organization_id = p_organization_id and c.id = p_customer_id
  for update;
  if not found then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if v_customer.archived then
    raise exception 'Archived customers do not receive new bills' using errcode = '22023';
  end if;

  select b.id into v_bill_id
  from public.bills b
  where b.organization_id = p_organization_id
    and b.customer_id = p_customer_id and b.period = p_period;
  if found then
    return v_bill_id;
  end if;

  select sp.monthly_fee_cents, sp.name into v_amount, v_plan
  from public.service_packages sp
  where sp.organization_id = p_organization_id
    and sp.id = v_customer.package_id
    and sp.monthly_fee_cents is not null
    and sp.effective_on <= p_period;
  if not found then
    select h.monthly_fee_cents, h.plan_name into v_amount, v_plan
    from public.price_history h
    where h.organization_id = p_organization_id
      and h.customer_id = p_customer_id and h.effective_on <= p_period
    order by h.effective_on desc, h.recorded_at desc
    limit 1;
    if not found then
      v_amount := v_customer.monthly_fee_cents;
      v_plan := v_customer.plan_name;
      if exists (
        select 1 from public.service_packages sp
        where sp.organization_id = p_organization_id
          and sp.id = v_customer.package_id
          and sp.monthly_fee_cents is not null
          and sp.effective_on > p_period
      ) then
        v_amount := null;
      end if;
    end if;
  end if;

  v_bill_id := coalesce(p_bill_id, gen_random_uuid()::text);
  v_invoice_number := 'SIF-' || to_char(p_period, 'YYYYMM') || '-' || v_customer.customer_number::text;
  insert into public.bills (
    organization_id, id, customer_id, period, amount_due_cents,
    issued_on, due_date, plan_snapshot, invoice_number
  ) values (
    p_organization_id, v_bill_id, p_customer_id, p_period, v_amount,
    p_issued_on, p_due_date, coalesce(v_plan, ''), v_invoice_number
  )
  on conflict (organization_id, customer_id, period) do nothing
  returning id into v_bill_id;

  if v_bill_id is null then
    select b.id into v_bill_id
    from public.bills b
    where b.organization_id = p_organization_id
      and b.customer_id = p_customer_id and b.period = p_period;
  end if;
  return v_bill_id;
end;
$$;

create or replace function public.generate_monthly_invoices(
  p_organization_id uuid,
  p_period date,
  p_issued_on date,
  p_due_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer record;
  v_rate bigint;
  v_existing_id text;
  v_created integer := 0;
  v_existing integer := 0;
  v_unpriced integer := 0;
begin
  if (select auth.uid()) is null or not public.is_org_admin(p_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_period is null or extract(day from p_period) <> 1 then
    raise exception 'Billing period must be the first day of a month' using errcode = '22023';
  end if;
  if p_issued_on is null or p_due_date is null then
    raise exception 'Issue date and an exact due date are required' using errcode = '22023';
  end if;

  for v_customer in
    select c.id, c.package_id, c.monthly_fee_cents, c.plan_name, c.customer_number
    from public.customers c
    where c.organization_id = p_organization_id
      and c.archived = false
      and c.service_status = 'active'
    order by c.customer_number, c.id
    for update
  loop
    select b.id into v_existing_id
    from public.bills b
    where b.organization_id = p_organization_id
      and b.customer_id = v_customer.id and b.period = p_period;
    if found then
      v_existing := v_existing + 1;
      continue;
    end if;

    select sp.monthly_fee_cents into v_rate
    from public.service_packages sp
    where sp.organization_id = p_organization_id
      and sp.id = v_customer.package_id
      and sp.monthly_fee_cents is not null
      and sp.effective_on <= p_period;
    if not found then
      select h.monthly_fee_cents into v_rate
      from public.price_history h
      where h.organization_id = p_organization_id
        and h.customer_id = v_customer.id and h.effective_on <= p_period
      order by h.effective_on desc, h.recorded_at desc
      limit 1;
      if not found then
        v_rate := v_customer.monthly_fee_cents;
        if exists (
          select 1 from public.service_packages sp
          where sp.organization_id = p_organization_id
            and sp.id = v_customer.package_id
            and sp.monthly_fee_cents is not null
            and sp.effective_on > p_period
        ) then
          v_rate := null;
        end if;
      end if;
    end if;

    if v_rate is null then
      v_unpriced := v_unpriced + 1;
      continue;
    end if;

    perform public.create_monthly_bill(
      p_organization_id,
      v_customer.id,
      p_period,
      null,
      p_issued_on,
      p_due_date
    );
    v_created := v_created + 1;
  end loop;

  return jsonb_build_object(
    'period', to_char(p_period, 'YYYY-MM'),
    'generated', v_created,
    'existing', v_existing,
    'unpriced', v_unpriced,
    'total', v_created + v_existing
  );
end;
$$;

revoke all on function public.set_package_monthly_fee(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.create_monthly_bill(uuid, text, date, text, date, date) from public, anon, authenticated;
revoke all on function public.generate_monthly_invoices(uuid, date, date, date) from public, anon, authenticated;
grant execute on function public.set_package_monthly_fee(uuid, text, bigint) to authenticated;
grant execute on function public.create_monthly_bill(uuid, text, date, text, date, date) to authenticated;
grant execute on function public.generate_monthly_invoices(uuid, date, date, date) to authenticated;

comment on column public.service_packages.effective_on is
  'First day of the month from which this package tariff applies to newly generated bill snapshots.';
comment on column public.bills.invoice_number is
  'Organization-scoped printable invoice reference, stable for the customer and billing month.';

commit;
