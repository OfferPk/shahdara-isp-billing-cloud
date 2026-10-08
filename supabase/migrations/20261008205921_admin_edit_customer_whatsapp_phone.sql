-- Allow same-organization Owners and Admins to save a customer's private WhatsApp phone.
-- Phone data remains in customer_private_details and is never exposed to customer sessions.
begin;

create or replace function public.set_customer_private_phone(
  p_organization_id uuid,
  p_customer_id text,
  p_phone text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text;
begin
  if (select auth.uid()) is null
     or p_organization_id is null
     or not public.is_org_admin(p_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_customer_id is null or pg_catalog.btrim(p_customer_id) = '' then
    raise exception 'A customer is required' using errcode = '22023';
  end if;

  v_phone := pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_phone, '')), '[[:space:]()-]', '', 'g');
  if v_phone <> '' and v_phone !~ '^(03[0-9]{9}|[+]923[0-9]{9})$' then
    raise exception 'Phone must be 03XXXXXXXXX or +923XXXXXXXXX' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.customers c
    where c.organization_id = p_organization_id
      and c.id = p_customer_id
  ) then
    raise exception 'Customer record not found' using errcode = '22023';
  end if;

  insert into public.customer_private_details (organization_id, customer_id, phone)
  values (p_organization_id, p_customer_id, v_phone)
  on conflict (organization_id, customer_id)
  do update set phone = excluded.phone, updated_at = pg_catalog.clock_timestamp();

  return v_phone;
end;
$$;

revoke all on function public.set_customer_private_phone(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.set_customer_private_phone(uuid, text, text)
  to authenticated;

commit;
