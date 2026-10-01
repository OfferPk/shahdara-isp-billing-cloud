-- Owner-review migration prepared for manual review only.
-- Do not apply automatically or to a live database as part of this change.
begin;

-- Browser clients must create the customer and its protected private details
-- together through the authorization-checked RPC below.
revoke insert on public.customers from public, anon, authenticated;
revoke insert (
  organization_id, id, customer_number, name, plan_name,
  monthly_fee_cents, service_address, service_status
) on public.customers from authenticated;

create or replace function public.create_customer(
  p_organization_id uuid,
  p_customer_number integer,
  p_name text,
  p_plan_name text,
  p_monthly_fee_cents bigint,
  p_service_address text,
  p_service_status text,
  p_phone text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_customer_id text;
  v_phone text;
  v_service_status text;
begin
  if (select auth.uid()) is null or not public.is_org_admin(p_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;

  if p_customer_number is null or p_customer_number <= 0 then
    raise exception 'Customer number must be a positive integer' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 100 then
    raise exception 'Customer name must contain 1 to 100 characters' using errcode = '22023';
  end if;
  if p_monthly_fee_cents is not null and p_monthly_fee_cents < 0 then
    raise exception 'Monthly fee cannot be negative' using errcode = '22023';
  end if;

  v_phone := btrim(coalesce(p_phone, ''));
  if v_phone <> '' and v_phone !~ '^(03[0-9]{9}|[+]923[0-9]{9})$' then
    raise exception 'Phone must be 03XXXXXXXXX or +923XXXXXXXXX' using errcode = '22023';
  end if;
  v_service_status := coalesce(p_service_status, 'not-set');
  if v_service_status not in ('active', 'offline', 'not-set') then
    raise exception 'Invalid service status' using errcode = '22023';
  end if;

  insert into public.customers (
    organization_id, customer_number, name, plan_name, monthly_fee_cents,
    service_address, service_status
  ) values (
    p_organization_id,
    p_customer_number,
    btrim(p_name),
    coalesce(btrim(p_plan_name), ''),
    p_monthly_fee_cents,
    coalesce(btrim(p_service_address), ''),
    v_service_status
  )
  returning id into v_customer_id;

  insert into public.customer_private_details (organization_id, customer_id, phone)
  values (p_organization_id, v_customer_id, v_phone);

  return v_customer_id;
end;
$$;

revoke all on function public.create_customer(uuid, integer, text, text, bigint, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_customer(uuid, integer, text, text, bigint, text, text, text)
  to authenticated;

commit;
