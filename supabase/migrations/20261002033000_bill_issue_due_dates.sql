begin;

-- Preserve every existing bill unchanged: there is deliberately no default or backfill.
alter table public.bills
  add column if not exists issued_on date;

-- Remove the old signature so calls with omitted optional arguments are unambiguous.
drop function if exists public.create_monthly_bill(uuid, text, date, text);

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

  -- One bill per customer/month. A replay returns the existing ID without
  -- changing the amount snapshot, issue date, or due date.
  select b.id into v_bill_id
  from public.bills b
  where b.organization_id = p_organization_id
    and b.customer_id = p_customer_id and b.period = p_period;
  if found then
    return v_bill_id;
  end if;

  select h.monthly_fee_cents, h.plan_name into v_amount, v_plan
  from public.price_history h
  where h.organization_id = p_organization_id
    and h.customer_id = p_customer_id and h.effective_on <= p_period
  order by h.effective_on desc, h.recorded_at desc
  limit 1;
  if not found then
    v_amount := v_customer.monthly_fee_cents;
    v_plan := v_customer.plan_name;
  end if;

  v_bill_id := coalesce(p_bill_id, gen_random_uuid()::text);
  insert into public.bills (
    organization_id, id, customer_id, period, amount_due_cents,
    issued_on, due_date, plan_snapshot
  ) values (
    p_organization_id, v_bill_id, p_customer_id, p_period, v_amount,
    p_issued_on, p_due_date, coalesce(v_plan, '')
  );
  return v_bill_id;
end;
$$;

create or replace function public.correct_monthly_bill(
  p_organization_id uuid,
  p_bill_id text,
  p_amount_due_cents bigint,
  p_issued_on date,
  p_due_date date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not public.is_org_admin(p_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_bill_id is null or length(p_bill_id) = 0 or length(p_bill_id) > 200 then
    raise exception 'Invalid bill ID' using errcode = '22023';
  end if;

  -- Amount history and allocations continue to use the existing bill triggers;
  -- dates and price are corrected together in one authorized transaction.
  update public.bills
  set amount_due_cents = p_amount_due_cents,
      issued_on = p_issued_on,
      due_date = p_due_date
  where organization_id = p_organization_id and id = p_bill_id;
  if not found then
    raise exception 'Bill not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.create_monthly_bill(uuid, text, date, text, date, date)
  from public, anon, authenticated;
grant execute on function public.create_monthly_bill(uuid, text, date, text, date, date)
  to authenticated;
revoke all on function public.correct_monthly_bill(uuid, text, bigint, date, date)
  from public, anon, authenticated;
grant execute on function public.correct_monthly_bill(uuid, text, bigint, date, date)
  to authenticated;

commit;
