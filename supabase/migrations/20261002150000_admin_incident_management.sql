-- Cloud-only incident workflow. Apply only to the approved non-production project.
-- Browser roles receive no direct incident or private-note write grants.
begin;

create or replace function public.manage_service_incident(
  p_organization_id uuid,
  p_incident_id text,
  p_customer_id text,
  p_customer_visible_summary text,
  p_status text,
  p_offline_at timestamptz,
  p_restored_at timestamptz,
  p_staff_notes text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_incident_id text;
begin
  if (select auth.uid()) is null or not public.is_org_admin(p_organization_id) then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
  if p_customer_visible_summary is null
     or length(btrim(p_customer_visible_summary)) not between 1 and 1000
     or p_status is null or p_status not in ('open', 'resolved')
     or (p_staff_notes is not null and length(p_staff_notes) > 4000) then
    raise exception 'Invalid incident details' using errcode = '22023';
  end if;

  if p_incident_id is null then
    if p_customer_id is not null and not exists (
      select 1 from public.customers c
      where c.organization_id = p_organization_id and c.id = p_customer_id
    ) then
      raise exception 'Customer not found in this organization' using errcode = 'P0002';
    end if;

    insert into public.incidents (
      organization_id, customer_id, customer_visible_summary, status,
      offline_at, restored_at
    ) values (
      p_organization_id, p_customer_id, btrim(p_customer_visible_summary), p_status,
      p_offline_at, p_restored_at
    ) returning id into v_incident_id;
  else
    if length(btrim(p_incident_id)) = 0 or length(p_incident_id) > 200
       or p_customer_id is not null then
      raise exception 'Invalid incident identifier or update payload' using errcode = '22023';
    end if;

    update public.incidents
    set customer_visible_summary = btrim(p_customer_visible_summary),
        status = p_status,
        offline_at = p_offline_at,
        restored_at = p_restored_at
    where organization_id = p_organization_id and id = p_incident_id
    returning id into v_incident_id;
    if not found then
      raise exception 'Incident not found in this organization' using errcode = 'P0002';
    end if;
  end if;

  -- This parameter is always stored only in the separately RLS-protected table.
  -- NULL on create means no note was provided; an empty string on update clears it.
  if p_staff_notes is not null then
    insert into public.incident_private_details (
      organization_id, incident_id, staff_notes, updated_at
    ) values (
      p_organization_id, v_incident_id, p_staff_notes, now()
    )
    on conflict (organization_id, incident_id) do update
      set staff_notes = excluded.staff_notes,
          updated_at = now();
  end if;

  return v_incident_id;
end;
$$;

revoke all on function public.manage_service_incident(uuid, text, text, text, text, timestamptz, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.manage_service_incident(uuid, text, text, text, text, timestamptz, timestamptz, text)
  to authenticated;

commit;
