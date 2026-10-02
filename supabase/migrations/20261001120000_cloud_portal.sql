-- Shahdara cloud-variant schema. Apply only to an explicitly approved, isolated
-- non-production Supabase project. This migration is not applied by this branch.

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now()
);

create table public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_memberships_user_idx
  on public.organization_memberships (user_id, organization_id);

-- The public customer row contains only the customer's own portal profile and
-- current subscription summary. Staff-only contact and accounting details live
-- in customer_private_details below.
create table public.customers (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null default gen_random_uuid()::text,
  customer_number integer not null check (customer_number > 0),
  name text not null check (length(btrim(name)) between 1 and 100),
  plan_name text not null default '' check (length(plan_name) <= 100),
  service_address text not null default '' check (length(service_address) <= 300),
  service_status text not null default 'not-set'
    check (service_status in ('active', 'offline', 'not-set')),
  monthly_fee_cents bigint check (monthly_fee_cents is null or monthly_fee_cents >= 0),
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, customer_number),
  unique (organization_id, id, customer_number)
);
create index customers_org_status_idx on public.customers (organization_id, archived, service_status);

create table public.customer_private_details (
  organization_id uuid not null,
  customer_id text not null,
  phone text not null default '' check (length(phone) <= 40),
  mohalla text not null default '' check (length(mohalla) <= 100),
  zone text not null default '' check (length(zone) <= 100),
  isp_provider text not null default '' check (length(isp_provider) <= 100),
  monthly_purchase_cost_cents bigint check (monthly_purchase_cost_cents is null or monthly_purchase_cost_cents >= 0),
  connection_date date,
  expiry_date date,
  cancellation_date date,
  staff_notes text not null default '' check (length(staff_notes) <= 4000),
  updated_at timestamptz not null default now(),
  primary key (organization_id, customer_id),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade
);

-- Accounts are linked by the server-side invitation function only. The browser
-- cannot create, update, or delete these links.
create table public.customer_portal_accounts (
  organization_id uuid not null,
  customer_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (organization_id, customer_id),
  unique (organization_id, user_id),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade
);
create index customer_portal_accounts_user_idx
  on public.customer_portal_accounts (user_id, organization_id);

create table public.price_history (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  customer_id text not null,
  effective_on date not null,
  plan_name text not null default '' check (length(plan_name) <= 100),
  monthly_fee_cents bigint check (monthly_fee_cents is null or monthly_fee_cents >= 0),
  recorded_by uuid references auth.users(id) on delete set null,
  recorded_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, customer_id, effective_on),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade
);
create index price_history_effective_idx
  on public.price_history (organization_id, customer_id, effective_on desc);

-- Bills are immutable monthly snapshots by default: one per customer/month.
-- A NULL price is retained as "Not set"; it is not treated as a zero bill.
create table public.bills (
  organization_id uuid not null,
  id text not null default gen_random_uuid()::text,
  customer_id text not null,
  period date not null check (extract(day from period) = 1),
  amount_due_cents bigint check (amount_due_cents is null or amount_due_cents >= 0),
  issued_on date,
  due_date date,
  plan_snapshot text not null default '' check (length(plan_snapshot) <= 100),
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, customer_id, period),
  unique (organization_id, id, customer_id),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade
);
create index bills_customer_period_idx
  on public.bills (organization_id, customer_id, period desc);

-- Receipts are the sole record of cash actually received. Allocations below are
-- derived application of that cash/credit and must never be counted as receipts.
create table public.receipts (
  organization_id uuid not null,
  id text not null,
  customer_id text not null,
  origin_bill_id text not null,
  received_on date not null,
  amount_cents bigint not null check (amount_cents > 0),
  method text not null check (length(btrim(method)) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, id, customer_id),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade,
  foreign key (organization_id, origin_bill_id, customer_id)
    references public.bills(organization_id, id, customer_id) on delete cascade
);
create index receipts_customer_date_idx
  on public.receipts (organization_id, customer_id, received_on desc);
create index receipts_origin_idx
  on public.receipts (organization_id, origin_bill_id);

create table public.receipt_allocations (
  organization_id uuid not null,
  customer_id text not null,
  receipt_id text not null,
  bill_id text not null,
  amount_cents bigint not null check (amount_cents > 0),
  allocation_kind text not null check (allocation_kind in ('same-month', 'carry-forward')),
  created_at timestamptz not null default now(),
  primary key (organization_id, receipt_id, bill_id),
  foreign key (organization_id, receipt_id, customer_id)
    references public.receipts(organization_id, id, customer_id) on delete cascade,
  foreign key (organization_id, bill_id, customer_id)
    references public.bills(organization_id, id, customer_id) on delete cascade
);
create index receipt_allocations_bill_idx
  on public.receipt_allocations (organization_id, bill_id);
create index receipt_allocations_customer_idx
  on public.receipt_allocations (organization_id, customer_id, receipt_id);

create table public.bill_amount_history (
  organization_id uuid not null,
  id uuid not null default gen_random_uuid(),
  bill_id text not null,
  customer_id text not null,
  previous_amount_cents bigint,
  new_amount_cents bigint,
  changed_by uuid references auth.users(id) on delete set null,
  changed_at timestamptz not null default now(),
  primary key (organization_id, id),
  foreign key (organization_id, bill_id, customer_id)
    references public.bills(organization_id, id, customer_id) on delete cascade
);

create table public.incidents (
  organization_id uuid not null,
  id text not null default gen_random_uuid()::text,
  customer_id text,
  customer_visible_summary text not null check (length(btrim(customer_visible_summary)) between 1 and 1000),
  status text not null default 'open' check (status in ('open', 'resolved')),
  reported_at timestamptz not null default now(),
  offline_at timestamptz,
  restored_at timestamptz,
  primary key (organization_id, id),
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade
);
create index incidents_customer_time_idx
  on public.incidents (organization_id, customer_id, reported_at desc);

create table public.incident_private_details (
  organization_id uuid not null,
  incident_id text not null,
  staff_notes text not null default '' check (length(staff_notes) <= 4000),
  updated_at timestamptz not null default now(),
  primary key (organization_id, incident_id),
  foreign key (organization_id, incident_id)
    references public.incidents(organization_id, id) on delete cascade
);

create table public.inventory_items (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null default gen_random_uuid()::text,
  sku text not null default '' check (length(sku) <= 80),
  name text not null check (length(btrim(name)) between 1 and 140),
  unit text not null default 'each' check (length(btrim(unit)) between 1 and 24),
  minimum_quantity numeric(14,3) not null default 0 check (minimum_quantity >= 0),
  unit_cost_cents bigint check (unit_cost_cents is null or unit_cost_cents >= 0),
  notes text not null default '' check (length(notes) <= 1000),
  created_at timestamptz not null default now(),
  primary key (organization_id, id)
);
create unique index inventory_items_sku_unique_idx
  on public.inventory_items (organization_id, lower(sku)) where sku <> '';

create table public.inventory_movements (
  organization_id uuid not null,
  id text not null default gen_random_uuid()::text,
  item_id text not null,
  customer_id text,
  movement_type text not null check (movement_type in ('receive', 'install', 'return', 'damage', 'correction')),
  quantity_delta numeric(14,3) not null check (quantity_delta <> 0),
  occurred_on date not null,
  note text not null default '' check (length(note) <= 1000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  foreign key (organization_id, item_id)
    references public.inventory_items(organization_id, id) on delete cascade,
  foreign key (organization_id, customer_id)
    references public.customers(organization_id, id) on delete cascade
);
create index inventory_movements_item_date_idx
  on public.inventory_movements (organization_id, item_id, occurred_on desc);

create table public.expenses (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null default gen_random_uuid()::text,
  category text not null check (length(btrim(category)) between 1 and 80),
  description text not null default '' check (length(description) <= 500),
  amount_cents bigint not null check (amount_cents > 0),
  paid_on date not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, id)
);
create index expenses_org_paid_date_idx
  on public.expenses (organization_id, paid_on desc);

create table public.payroll_date_logs (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  id text not null default gen_random_uuid()::text,
  staff_name text not null check (length(btrim(staff_name)) between 1 and 100),
  work_date date not null,
  note text not null default '' check (length(note) <= 500),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (organization_id, id),
  unique (organization_id, staff_name, work_date)
);

-- Security-definer policy helpers avoid recursive RLS lookups. Every reference is
-- schema-qualified and the search path is pinned to prevent object shadowing.
create or replace function public.is_org_admin(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.role in ('owner', 'admin')
  );
$$;

create or replace function public.owns_customer(p_organization_id uuid, p_customer_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.customer_portal_accounts a
    where a.organization_id = p_organization_id
      and a.customer_id = p_customer_id
      and a.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_org_admin(uuid) from public, anon;
revoke all on function public.owns_customer(uuid, text) from public, anon;
grant execute on function public.is_org_admin(uuid) to authenticated;
grant execute on function public.owns_customer(uuid, text) to authenticated;

-- Rebuild derived allocations in chronological order. Unpriced bills do not
-- consume or create credit. Only receipt rows represent collected cash.
create or replace function public.rebuild_customer_allocations(
  p_organization_id uuid,
  p_customer_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bill record;
  v_receipt record;
  v_pending_receipts text[] := array[]::text[];
  v_pending_amounts bigint[] := array[]::bigint[];
  v_pending_index integer;
  v_remaining_due bigint;
  v_receipt_remaining bigint;
  v_applied bigint;
  v_excess bigint;
begin
  perform 1
  from public.customers c
  where c.organization_id = p_organization_id and c.id = p_customer_id
  for update;

  delete from public.receipt_allocations a
  where a.organization_id = p_organization_id and a.customer_id = p_customer_id;

  for v_bill in
    select b.id, b.period, b.amount_due_cents
    from public.bills b
    where b.organization_id = p_organization_id and b.customer_id = p_customer_id
    order by b.period, b.id
  loop
    -- Match the offline ledger: receipts against an unpriced bill remain cash,
    -- but they do not create credit until that bill is actually priced.
    if v_bill.amount_due_cents is null then
      continue;
    end if;
    v_remaining_due := v_bill.amount_due_cents;

    if coalesce(array_length(v_pending_receipts, 1), 0) > 0 then
      for v_pending_index in 1..array_length(v_pending_receipts, 1) loop
        exit when v_remaining_due <= 0;
        if v_pending_amounts[v_pending_index] <= 0 then
          continue;
        end if;
        v_applied := least(v_pending_amounts[v_pending_index], v_remaining_due);
        if v_applied > 0 then
          insert into public.receipt_allocations (
            organization_id, customer_id, receipt_id, bill_id, amount_cents, allocation_kind
          ) values (
            p_organization_id, p_customer_id, v_pending_receipts[v_pending_index],
            v_bill.id, v_applied, 'carry-forward'
          );
          v_pending_amounts[v_pending_index] := v_pending_amounts[v_pending_index] - v_applied;
          v_remaining_due := v_remaining_due - v_applied;
        end if;
      end loop;
    end if;

    for v_receipt in
      select r.id, r.amount_cents
      from public.receipts r
      where r.organization_id = p_organization_id
        and r.customer_id = p_customer_id
        and r.origin_bill_id = v_bill.id
      order by r.received_on, r.id
    loop
      v_receipt_remaining := v_receipt.amount_cents;
      v_applied := least(v_receipt_remaining, v_remaining_due);
      if v_applied > 0 then
        insert into public.receipt_allocations (
          organization_id, customer_id, receipt_id, bill_id, amount_cents, allocation_kind
        ) values (
          p_organization_id, p_customer_id, v_receipt.id, v_bill.id,
          v_applied, 'same-month'
        );
        v_remaining_due := v_remaining_due - v_applied;
        v_receipt_remaining := v_receipt_remaining - v_applied;
      end if;
      if v_receipt_remaining > 0 then
        v_pending_receipts := array_append(v_pending_receipts, v_receipt.id);
        v_pending_amounts := array_append(v_pending_amounts, v_receipt_remaining);
      end if;
    end loop;
  end loop;
end;
$$;
revoke all on function public.rebuild_customer_allocations(uuid, text) from public, anon, authenticated;

create or replace function public.rebuild_allocations_after_bill_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform public.rebuild_customer_allocations(old.organization_id, old.customer_id);
    return old;
  elsif tg_op = 'UPDATE' then
    if old.organization_id is distinct from new.organization_id
       or old.customer_id is distinct from new.customer_id then
      perform public.rebuild_customer_allocations(old.organization_id, old.customer_id);
    end if;
    perform public.rebuild_customer_allocations(new.organization_id, new.customer_id);
    return new;
  else
    perform public.rebuild_customer_allocations(new.organization_id, new.customer_id);
    return new;
  end if;
end;
$$;
revoke all on function public.rebuild_allocations_after_bill_change() from public, anon, authenticated;
create trigger bills_rebuild_allocations
  after insert or update of organization_id, customer_id, period, amount_due_cents or delete
  on public.bills
  for each row execute function public.rebuild_allocations_after_bill_change();

create or replace function public.record_bill_amount_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.amount_due_cents is distinct from new.amount_due_cents then
    insert into public.bill_amount_history (
      organization_id, bill_id, customer_id, previous_amount_cents,
      new_amount_cents, changed_by
    ) values (
      new.organization_id, new.id, new.customer_id, old.amount_due_cents,
      new.amount_due_cents, (select auth.uid())
    );
  end if;
  return new;
end;
$$;
revoke all on function public.record_bill_amount_history() from public, anon, authenticated;
create trigger bills_record_amount_history
  after update of amount_due_cents on public.bills
  for each row execute function public.record_bill_amount_history();

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
create trigger customers_record_price_history_after_insert
  after insert on public.customers
  for each row execute function public.record_customer_price_history();
create trigger customers_record_price_history_before_update
  before update of monthly_fee_cents, plan_name on public.customers
  for each row execute function public.record_customer_price_history();

-- A view is explicitly security-invoker: unlike default PostgreSQL views, it does
-- not bypass the underlying tables' RLS policies.
create view public.bill_summaries
with (security_invoker = true)
as
select
  b.organization_id,
  b.id as bill_id,
  b.customer_id,
  b.period,
  b.amount_due_cents,
  b.due_date,
  coalesce(sum(a.amount_cents), 0)::bigint as amount_applied_cents,
  coalesce(sum(a.amount_cents) filter (where a.allocation_kind = 'same-month'), 0)::bigint
    as same_month_applied_cents,
  coalesce(sum(a.amount_cents) filter (where a.allocation_kind = 'carry-forward'), 0)::bigint
    as credit_applied_cents,
  case when b.amount_due_cents is null then null::bigint
    else greatest(b.amount_due_cents - coalesce(sum(a.amount_cents), 0), 0)::bigint
  end as balance_due_cents
from public.bills b
left join public.receipt_allocations a
  on a.organization_id = b.organization_id
 and a.bill_id = b.id
 and a.customer_id = b.customer_id
group by b.organization_id, b.id, b.customer_id, b.period,
  b.amount_due_cents, b.due_date;

-- Every table in the exposed public schema is explicitly RLS-protected. Grants
-- are revoked first because policies do not remove pre-existing role grants.
alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.customers enable row level security;
alter table public.customer_private_details enable row level security;
alter table public.customer_portal_accounts enable row level security;
alter table public.price_history enable row level security;
alter table public.bills enable row level security;
alter table public.receipts enable row level security;
alter table public.receipt_allocations enable row level security;
alter table public.bill_amount_history enable row level security;
alter table public.incidents enable row level security;
alter table public.incident_private_details enable row level security;
alter table public.inventory_items enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.expenses enable row level security;
alter table public.payroll_date_logs enable row level security;

revoke all on table public.organizations, public.organization_memberships,
  public.customers, public.customer_private_details, public.customer_portal_accounts,
  public.price_history, public.bills, public.receipts, public.receipt_allocations,
  public.bill_amount_history, public.incidents, public.incident_private_details,
  public.inventory_items, public.inventory_movements, public.expenses,
  public.payroll_date_logs from public, anon, authenticated;
revoke all on table public.bill_summaries from public, anon, authenticated;

-- Signed-in users need only the operations used by their portal. Customer-owned
-- SELECT is further narrowed by the policies below. No direct client write path
-- exists for account links, receipts, or allocations.
grant select on public.organizations, public.organization_memberships,
  public.customers, public.customer_portal_accounts, public.bills,
  public.receipts, public.receipt_allocations, public.bill_summaries,
  public.incidents to authenticated;
grant insert (organization_id, id, customer_number, name, plan_name,
  monthly_fee_cents, service_address, service_status)
  on public.customers to authenticated;
grant update (amount_due_cents) on public.bills to authenticated;
grant select on public.customer_private_details, public.price_history,
  public.bill_amount_history, public.incident_private_details,
  public.inventory_items, public.inventory_movements, public.expenses,
  public.payroll_date_logs to authenticated;

create policy organizations_member_read
  on public.organizations for select to authenticated
  using ((select public.is_org_admin(id)));

create policy memberships_scoped_read
  on public.organization_memberships for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_org_admin(organization_id)));

create policy customers_portal_read
  on public.customers for select to authenticated
  using (
    (select public.is_org_admin(organization_id))
    or (select public.owns_customer(organization_id, id))
  );
create policy customers_admin_insert
  on public.customers for insert to authenticated
  with check ((select public.is_org_admin(organization_id)));
create policy customers_admin_update
  on public.customers for update to authenticated
  using ((select public.is_org_admin(organization_id)))
  with check ((select public.is_org_admin(organization_id)));
create policy customers_admin_delete
  on public.customers for delete to authenticated
  using ((select public.is_org_admin(organization_id)));

create policy customer_private_admin_only
  on public.customer_private_details for all to authenticated
  using ((select public.is_org_admin(organization_id)))
  with check ((select public.is_org_admin(organization_id)));

create policy customer_accounts_scoped_read
  on public.customer_portal_accounts for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_org_admin(organization_id)));

create policy price_history_admin_only
  on public.price_history for all to authenticated
  using ((select public.is_org_admin(organization_id)))
  with check ((select public.is_org_admin(organization_id)));

create policy bills_portal_read
  on public.bills for select to authenticated
  using (
    (select public.is_org_admin(organization_id))
    or (select public.owns_customer(organization_id, customer_id))
  );
create policy bills_admin_insert
  on public.bills for insert to authenticated
  with check ((select public.is_org_admin(organization_id)));
create policy bills_admin_update
  on public.bills for update to authenticated
  using ((select public.is_org_admin(organization_id)))
  with check ((select public.is_org_admin(organization_id)));
create policy bills_admin_delete
  on public.bills for delete to authenticated
  using ((select public.is_org_admin(organization_id)));

create policy receipts_portal_read
  on public.receipts for select to authenticated
  using (
    (select public.is_org_admin(organization_id))
    or (select public.owns_customer(organization_id, customer_id))
  );
create policy receipt_allocations_portal_read
  on public.receipt_allocations for select to authenticated
  using (
    (select public.is_org_admin(organization_id))
    or (select public.owns_customer(organization_id, customer_id))
  );
create policy bill_amount_history_admin_read
  on public.bill_amount_history for select to authenticated
  using ((select public.is_org_admin(organization_id)));

create policy incidents_portal_read
  on public.incidents for select to authenticated
  using (
    (select public.is_org_admin(organization_id))
    or (customer_id is not null and (select public.owns_customer(organization_id, customer_id)))
  );
create policy incidents_admin_insert
  on public.incidents for insert to authenticated
  with check ((select public.is_org_admin(organization_id)));
create policy incidents_admin_update
  on public.incidents for update to authenticated
  using ((select public.is_org_admin(organization_id)))
  with check ((select public.is_org_admin(organization_id)));
create policy incidents_admin_delete
  on public.incidents for delete to authenticated
  using ((select public.is_org_admin(organization_id)));

create policy incident_private_admin_only
  on public.incident_private_details for all to authenticated
  using ((select public.is_org_admin(organization_id)))
  with check ((select public.is_org_admin(organization_id)));

create policy inventory_items_admin_only
  on public.inventory_items for all to authenticated
  using ((select public.is_org_admin(organization_id)))
  with check ((select public.is_org_admin(organization_id)));
create policy inventory_movements_admin_only
  on public.inventory_movements for all to authenticated
  using ((select public.is_org_admin(organization_id)))
  with check ((select public.is_org_admin(organization_id)));
create policy expenses_admin_only
  on public.expenses for all to authenticated
  using ((select public.is_org_admin(organization_id)))
  with check ((select public.is_org_admin(organization_id)));
create policy payroll_logs_admin_only
  on public.payroll_date_logs for all to authenticated
  using ((select public.is_org_admin(organization_id)))
  with check ((select public.is_org_admin(organization_id)));

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

  select b.id into v_bill_id
  from public.bills b
  where b.organization_id = p_organization_id
    and b.customer_id = p_customer_id and b.period = p_period;
  if found then
    -- A replay returns the existing snapshot without changing price or dates.
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

create or replace function public.record_cash_receipt(
  p_organization_id uuid,
  p_customer_id text,
  p_bill_id text,
  p_receipt_id text,
  p_received_on date,
  p_amount_cents bigint,
  p_method text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.receipts%rowtype;
begin
  if (select auth.uid()) is null or not public.is_org_admin(p_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0
     or p_received_on is null
     or p_receipt_id is null or length(p_receipt_id) = 0 or length(p_receipt_id) > 200
     or p_method is null or length(btrim(p_method)) = 0 or length(p_method) > 40 then
    raise exception 'Invalid receipt details' using errcode = '22023';
  end if;

  perform 1 from public.customers c
  where c.organization_id = p_organization_id and c.id = p_customer_id
  for update;
  if not found then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.bills b
    where b.organization_id = p_organization_id
      and b.customer_id = p_customer_id and b.id = p_bill_id
  ) then
    raise exception 'Bill not found for this customer' using errcode = 'P0002';
  end if;

  select r.* into v_existing
  from public.receipts r
  where r.organization_id = p_organization_id and r.id = p_receipt_id;
  if found then
    if v_existing.customer_id = p_customer_id
      and v_existing.origin_bill_id = p_bill_id
      and v_existing.received_on = p_received_on
      and v_existing.amount_cents = p_amount_cents
      and v_existing.method = btrim(p_method) then
      return jsonb_build_object('id', v_existing.id, 'idempotent_replay', true);
    end if;
    raise exception 'Receipt ID already exists with different details' using errcode = '23505';
  end if;

  insert into public.receipts (
    organization_id, id, customer_id, origin_bill_id, received_on,
    amount_cents, method
  ) values (
    p_organization_id, p_receipt_id, p_customer_id, p_bill_id, p_received_on,
    p_amount_cents, btrim(p_method)
  );
  perform public.rebuild_customer_allocations(p_organization_id, p_customer_id);
  return jsonb_build_object('id', p_receipt_id, 'idempotent_replay', false);
end;
$$;

create or replace function public.correct_cash_receipt(
  p_organization_id uuid,
  p_receipt_id text,
  p_bill_id text,
  p_received_on date,
  p_amount_cents bigint,
  p_method text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt public.receipts%rowtype;
begin
  if (select auth.uid()) is null or not public.is_org_admin(p_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  select r.* into v_receipt from public.receipts r
  where r.organization_id = p_organization_id and r.id = p_receipt_id;
  if not found then
    raise exception 'Receipt not found' using errcode = 'P0002';
  end if;
  perform 1 from public.customers c
  where c.organization_id = p_organization_id and c.id = v_receipt.customer_id
  for update;
  if p_amount_cents is null or p_amount_cents <= 0 or p_received_on is null
     or p_method is null or length(btrim(p_method)) = 0 or length(p_method) > 40 then
    raise exception 'Invalid receipt details' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.bills b
    where b.organization_id = p_organization_id
      and b.customer_id = v_receipt.customer_id and b.id = p_bill_id
  ) then
    raise exception 'Bill not found for this customer' using errcode = 'P0002';
  end if;
  update public.receipts r set
    origin_bill_id = p_bill_id,
    received_on = p_received_on,
    amount_cents = p_amount_cents,
    method = btrim(p_method),
    updated_at = now()
  where r.organization_id = p_organization_id and r.id = p_receipt_id;
  perform public.rebuild_customer_allocations(p_organization_id, v_receipt.customer_id);
  return jsonb_build_object('id', p_receipt_id, 'corrected', true);
end;
$$;

create or replace function public.delete_cash_receipt(
  p_organization_id uuid,
  p_receipt_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt public.receipts%rowtype;
begin
  if (select auth.uid()) is null or not public.is_org_admin(p_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  select r.* into v_receipt from public.receipts r
  where r.organization_id = p_organization_id and r.id = p_receipt_id;
  if not found then
    raise exception 'Receipt not found' using errcode = 'P0002';
  end if;
  perform 1 from public.customers c
  where c.organization_id = p_organization_id and c.id = v_receipt.customer_id
  for update;
  delete from public.receipts r
  where r.organization_id = p_organization_id and r.id = p_receipt_id;
  perform public.rebuild_customer_allocations(p_organization_id, v_receipt.customer_id);
  return jsonb_build_object('id', p_receipt_id, 'deleted', true);
end;
$$;

revoke all on function public.create_monthly_bill(uuid, text, date, text, date, date)
  from public, anon, authenticated;
revoke all on function public.correct_monthly_bill(uuid, text, bigint, date, date)
  from public, anon, authenticated;
revoke all on function public.record_cash_receipt(uuid, text, text, text, date, bigint, text)
  from public, anon;
revoke all on function public.correct_cash_receipt(uuid, text, text, date, bigint, text)
  from public, anon;
revoke all on function public.delete_cash_receipt(uuid, text)
  from public, anon;
grant execute on function public.create_monthly_bill(uuid, text, date, text, date, date) to authenticated;
grant execute on function public.correct_monthly_bill(uuid, text, bigint, date, date) to authenticated;
grant execute on function public.record_cash_receipt(uuid, text, text, text, date, bigint, text) to authenticated;
grant execute on function public.correct_cash_receipt(uuid, text, text, date, bigint, text) to authenticated;
grant execute on function public.delete_cash_receipt(uuid, text) to authenticated;

-- No anon policies are created. Initial organization and first owner membership
-- must be provisioned by a project owner through a separately reviewed process.
