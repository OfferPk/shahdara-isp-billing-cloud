-- Standalone PPPoE-to-customer profile mapping, recorded in staging as
-- 20261003200536 / add_customer_pppoe_username_mapping.
-- Keep this migration limited to the nullable username field, its integrity
-- constraints, and its authenticated column UPDATE grant. Existing customers
-- RLS policies remain the authorization boundary.
begin;

alter table public.customers
  add column if not exists pppoe_username text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customers'::regclass
      and conname = 'customers_pppoe_username_unique'
  ) then
    alter table public.customers
      add constraint customers_pppoe_username_unique unique (pppoe_username);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customers'::regclass
      and conname = 'customers_pppoe_username_nonempty'
  ) then
    alter table public.customers
      add constraint customers_pppoe_username_nonempty
        check (pppoe_username is null or length(btrim(pppoe_username)) > 0);
  end if;
end
$$;

grant update (pppoe_username) on public.customers to authenticated;

commit;
