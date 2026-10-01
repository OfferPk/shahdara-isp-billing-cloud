-- Manual review patch for the isolated non-production cloud project only.
-- Do not run automatically or against production. This changes trigger timing
-- only; it creates no tables, drops no data, and preserves RLS and grants.
begin;

create or replace function public.record_customer_price_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed boolean;
begin
  if tg_op = 'INSERT' then
    v_changed := new.monthly_fee_cents is not null;
  else
    v_changed := new.monthly_fee_cents is distinct from old.monthly_fee_cents
      or new.plan_name is distinct from old.plan_name;
  end if;

  if v_changed then
    insert into public.price_history (
      organization_id, customer_id, effective_on, plan_name,
      monthly_fee_cents, recorded_by
    ) values (
      new.organization_id, new.id, current_date, new.plan_name,
      new.monthly_fee_cents, (select auth.uid())
    )
    on conflict (organization_id, customer_id, effective_on)
    do update set plan_name = excluded.plan_name,
      monthly_fee_cents = excluded.monthly_fee_cents,
      recorded_by = excluded.recorded_by,
      recorded_at = now();
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;
revoke all on function public.record_customer_price_history() from public, anon, authenticated;

drop trigger if exists customers_record_price_history on public.customers;
drop trigger if exists customers_record_price_history_after_insert on public.customers;
drop trigger if exists customers_record_price_history_before_update on public.customers;

-- AFTER INSERT ensures the customer row exists before price_history's FK check.
create trigger customers_record_price_history_after_insert
  after insert on public.customers
  for each row execute function public.record_customer_price_history();

-- Keep updates in a BEFORE trigger so updated_at remains part of the row update.
create trigger customers_record_price_history_before_update
  before update of monthly_fee_cents, plan_name on public.customers
  for each row execute function public.record_customer_price_history();

commit;

-- Rollback note: if necessary, restore the former BEFORE INSERT OR UPDATE trigger
-- from the original migration only after fixing its FK-ordering defect. Reverting
-- to that trigger will reintroduce the failed insert behavior; no data rollback is
-- needed because this patch does not change existing table data.
