-- Add-only bookkeeping for the isolated Shahdara staging portal.
-- This migration does not backfill legacy expenses, infer service costs, or insert financial rows.
-- Cash expenses and customer-cost history are immutable; corrections are new, auditable entries.

begin;

create table public.cashflow_expenses (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  id uuid not null default gen_random_uuid(),
  category text not null check (category in (
    'worker_salary',
    'nayatel_bandwidth',
    'partner_profit',
    'bill',
    'battery_ups',
    'fiber_cable',
    'splitter',
    'yellow_type',
    'white_type',
    'black_box_fiber_joint_box'
  )),
  amount_paisa bigint not null check (amount_paisa > 0 and amount_paisa <= 9007199254740991),
  note text not null default '' check (length(note) <= 1000),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, id)
);
create index cashflow_expenses_org_created_idx
  on public.cashflow_expenses (organization_id, created_at desc);
create index cashflow_expenses_org_category_created_idx
  on public.cashflow_expenses (organization_id, category, created_at desc);

alter table public.cashflow_expenses enable row level security;
revoke all on table public.cashflow_expenses from public, anon, authenticated;
grant select on public.cashflow_expenses to authenticated;
create policy cashflow_expenses_admin_read
  on public.cashflow_expenses for select to authenticated
  using ((select public.is_org_admin(organization_id)));

create or replace function public.prevent_cashflow_expense_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Cashflow entries are append-only.' using errcode = '42501';
end;
$$;
revoke all on function public.prevent_cashflow_expense_mutation() from public, anon, authenticated;
create trigger cashflow_expenses_append_only
  before update or delete on public.cashflow_expenses
  for each row execute function public.prevent_cashflow_expense_mutation();

create or replace function public.record_cashflow_expense(
  p_organization_id uuid,
  p_entry_id uuid,
  p_category text,
  p_amount_paisa bigint,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_existing public.cashflow_expenses%rowtype;
  v_inserted_id uuid;
begin
  if v_user_id is null or not public.is_org_admin(p_organization_id) then
    raise exception 'Only a same-organization Owner or Admin may record cash expenses.' using errcode = '42501';
  end if;
  if p_entry_id is null then
    raise exception 'A stable cash expense request ID is required.' using errcode = '22023';
  end if;
  if p_category not in (
    'worker_salary', 'nayatel_bandwidth', 'partner_profit', 'bill', 'battery_ups',
    'fiber_cable', 'splitter', 'yellow_type', 'white_type', 'black_box_fiber_joint_box'
  ) then
    raise exception 'Choose a supported cash expense category.' using errcode = '23514';
  end if;
  if p_amount_paisa is null or p_amount_paisa <= 0 or p_amount_paisa > 9007199254740991 then
    raise exception 'Cash expense must be a positive exact PKR amount.' using errcode = '23514';
  end if;
  if pg_catalog.length(coalesce(p_note, '')) > 1000 then
    raise exception 'Cash expense note is too long.' using errcode = '23514';
  end if;

  insert into public.cashflow_expenses (
    organization_id, id, category, amount_paisa, note, created_by, created_at
  ) values (
    p_organization_id, p_entry_id, p_category, p_amount_paisa, coalesce(v_note, ''), v_user_id, pg_catalog.clock_timestamp()
  ) on conflict (organization_id, id) do nothing
  returning id into v_inserted_id;

  if v_inserted_id is null then
    select * into v_existing
    from public.cashflow_expenses e
    where e.organization_id = p_organization_id and e.id = p_entry_id;
    if v_existing.created_by <> v_user_id
      or v_existing.category <> p_category
      or v_existing.amount_paisa <> p_amount_paisa
      or v_existing.note <> coalesce(v_note, '') then
      raise exception 'This request ID already belongs to a different cash expense.' using errcode = '23505';
    end if;
    return v_existing.id;
  end if;
  return v_inserted_id;
end;
$$;
revoke all on function public.record_cashflow_expense(uuid, uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.record_cashflow_expense(uuid, uuid, text, bigint, text) to authenticated;

create table public.customer_service_cost_history (
  organization_id uuid not null,
  customer_id text not null,
  id uuid not null default gen_random_uuid(),
  effective_on date not null check (extract(day from effective_on) = 1),
  monthly_cost_paisa bigint not null check (monthly_cost_paisa >= 0 and monthly_cost_paisa <= 9007199254740991),
  note text not null default '' check (length(note) <= 500),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (organization_id, id),
  foreign key (organization_id, customer_id)
    references public.customers (organization_id, id) on delete restrict
);
create index customer_service_cost_history_effective_idx
  on public.customer_service_cost_history (organization_id, customer_id, effective_on desc, created_at desc);

alter table public.customer_service_cost_history enable row level security;
revoke all on table public.customer_service_cost_history from public, anon, authenticated;
grant select on public.customer_service_cost_history to authenticated;
create policy customer_service_cost_history_admin_read
  on public.customer_service_cost_history for select to authenticated
  using ((select public.is_org_admin(organization_id)));

create or replace function public.prevent_customer_service_cost_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Customer service cost history is append-only.' using errcode = '42501';
end;
$$;
revoke all on function public.prevent_customer_service_cost_mutation() from public, anon, authenticated;
create trigger customer_service_cost_history_append_only
  before update or delete on public.customer_service_cost_history
  for each row execute function public.prevent_customer_service_cost_mutation();

create or replace function public.record_customer_service_cost(
  p_organization_id uuid,
  p_customer_id text,
  p_entry_id uuid,
  p_effective_on date,
  p_monthly_cost_paisa bigint,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_existing public.customer_service_cost_history%rowtype;
  v_inserted_id uuid;
begin
  if v_user_id is null or not public.is_org_admin(p_organization_id) then
    raise exception 'Only a same-organization Owner or Admin may record customer service costs.' using errcode = '42501';
  end if;
  if p_entry_id is null then
    raise exception 'A stable service cost request ID is required.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.customers c
    where c.organization_id = p_organization_id and c.id = p_customer_id
  ) then
    raise exception 'Choose a customer in the authorized organization.' using errcode = '42501';
  end if;
  if p_effective_on is null or extract(day from p_effective_on) <> 1 then
    raise exception 'The effective date must be the first day of a month.' using errcode = '23514';
  end if;
  if p_monthly_cost_paisa is null or p_monthly_cost_paisa < 0 or p_monthly_cost_paisa > 9007199254740991 then
    raise exception 'Enter a valid non-negative exact PKR monthly cost.' using errcode = '23514';
  end if;
  if pg_catalog.length(coalesce(p_note, '')) > 500 then
    raise exception 'Service cost note is too long.' using errcode = '23514';
  end if;

  insert into public.customer_service_cost_history (
    organization_id, customer_id, id, effective_on, monthly_cost_paisa, note, created_by, created_at
  ) values (
    p_organization_id, p_customer_id, p_entry_id, p_effective_on, p_monthly_cost_paisa,
    coalesce(v_note, ''), v_user_id, pg_catalog.clock_timestamp()
  ) on conflict (organization_id, id) do nothing
  returning id into v_inserted_id;

  if v_inserted_id is null then
    select * into v_existing
    from public.customer_service_cost_history h
    where h.organization_id = p_organization_id and h.id = p_entry_id;
    if v_existing.created_by <> v_user_id
      or v_existing.customer_id <> p_customer_id
      or v_existing.effective_on <> p_effective_on
      or v_existing.monthly_cost_paisa <> p_monthly_cost_paisa
      or v_existing.note <> coalesce(v_note, '') then
      raise exception 'This request ID already belongs to a different customer service cost.' using errcode = '23505';
    end if;
    return v_existing.id;
  end if;
  return v_inserted_id;
end;
$$;
revoke all on function public.record_customer_service_cost(uuid, text, uuid, date, bigint, text) from public, anon, authenticated;
grant execute on function public.record_customer_service_cost(uuid, text, uuid, date, bigint, text) to authenticated;

comment on table public.cashflow_expenses is
  'Append-only organization-scoped cash outflows in PKR paisa. partner_profit is a separate partner distribution, not an operating expense.';
comment on column public.cashflow_expenses.created_at is
  'Server-generated UTC instant; never accepted from the browser.';
comment on table public.customer_service_cost_history is
  'Append-only organization/customer-scoped monthly service cost assumptions for estimated customer contribution only; never included in global cashflow expenses.';
comment on column public.customer_service_cost_history.effective_on is
  'First day of the month from which this monthly cost applies; for duplicate effective months the latest created_at entry wins.';
comment on column public.customer_service_cost_history.created_at is
  'Server-generated UTC instant; never accepted from the browser.';

commit;
