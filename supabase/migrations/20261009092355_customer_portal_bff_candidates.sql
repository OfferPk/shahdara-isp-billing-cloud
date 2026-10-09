-- Applied to production on 2026-10-09 via Supabase MCP migration record 20261009092355.
-- Submitted migration name: 20261009090000_customer_portal_bff_candidates.
-- Read-only, service_role-only RPC; returns only the approved identity fields.

begin;

create function public.list_customer_portal_bff_provisioning_candidates(
  p_organization_id uuid
)
returns table (
  customer_id text,
  organization_id uuid,
  pppoe_username text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    c.id,
    c.organization_id,
    c.pppoe_username
  from public.customers as c
  where p_organization_id = 'f4b32224-c598-40fc-9995-9de2046a5364'::uuid
    and c.organization_id = p_organization_id
    and c.archived is false
    and c.pppoe_username is not null
  order by c.id;
$function$;

alter function public.list_customer_portal_bff_provisioning_candidates(uuid)
  owner to postgres;

revoke all on function public.list_customer_portal_bff_provisioning_candidates(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.list_customer_portal_bff_provisioning_candidates(uuid)
  to service_role;

commit;
