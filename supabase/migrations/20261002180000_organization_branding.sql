-- Company branding for the isolated cloud edition. Apply only to the approved
-- non-production project qkdsuvmlutkatcqoewkh. No customer rows are changed.
begin;

create table public.organization_branding (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  logo_path text,
  support_phone text not null default '' check (length(support_phone) <= 40),
  address text not null default '' check (length(address) <= 300),
  updated_at timestamptz not null default now(),
  constraint organization_branding_logo_path_check check (
    logo_path is null or (
      logo_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](png|jpg|jpeg|webp)$'
      and split_part(logo_path, '/', 1) = organization_id::text
    )
  )
);

alter table public.organization_branding enable row level security;
revoke all on table public.organization_branding from public, anon, authenticated;
grant select on table public.organization_branding to authenticated;

create or replace function public.is_org_owner(p_organization_id uuid)
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
      and m.role = 'owner'
  );
$$;

create or replace function public.is_org_customer(p_organization_id uuid)
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
      and a.user_id = (select auth.uid())
  );
$$;

create or replace function public.can_manage_branding_logo(p_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_path is null or p_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](png|jpg|jpeg|webp)$' then
    return false;
  end if;

  return exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = split_part(p_path, '/', 1)::uuid
      and m.user_id = (select auth.uid())
      and m.role = 'owner'
  );
end;
$$;

create or replace function public.save_organization_branding(
  p_organization_id uuid,
  p_display_name text,
  p_logo_path text,
  p_support_phone text,
  p_address text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not public.is_org_owner(p_organization_id) then
    raise exception 'Organization owner access required' using errcode = '42501';
  end if;
  if p_display_name is null or length(btrim(p_display_name)) not between 1 and 120
     or length(coalesce(p_support_phone, '')) > 40
     or length(coalesce(p_address, '')) > 300 then
    raise exception 'Invalid organization branding details' using errcode = '22023';
  end if;
  if p_logo_path is not null and (
    not public.can_manage_branding_logo(p_logo_path)
    or not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'organization-branding' and o.name = p_logo_path
    )
  ) then
    raise exception 'Invalid organization logo path' using errcode = '22023';
  end if;

  insert into public.organization_branding (
    organization_id, display_name, logo_path, support_phone, address, updated_at
  ) values (
    p_organization_id, btrim(p_display_name), p_logo_path,
    btrim(coalesce(p_support_phone, '')), btrim(coalesce(p_address, '')), now()
  )
  on conflict (organization_id) do update set
    display_name = excluded.display_name,
    logo_path = excluded.logo_path,
    support_phone = excluded.support_phone,
    address = excluded.address,
    updated_at = now();
end;
$$;

revoke all on function public.is_org_owner(uuid) from public, anon;
revoke all on function public.is_org_customer(uuid) from public, anon;
revoke all on function public.can_manage_branding_logo(text) from public, anon;
revoke all on function public.save_organization_branding(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.is_org_owner(uuid) to authenticated;
grant execute on function public.is_org_customer(uuid) to authenticated;
grant execute on function public.can_manage_branding_logo(text) to authenticated;
grant execute on function public.save_organization_branding(uuid, text, text, text, text) to authenticated;

create policy organization_branding_read_linked_org
  on public.organization_branding for select to authenticated
  using (
    (select public.is_org_admin(organization_id))
    or (select public.is_org_customer(organization_id))
  );

-- Dedicated customer-facing assets only. No private files or credentials belong
-- in this public bucket. Supabase also enforces MIME type and byte-size limits.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'organization-branding', 'organization-branding', true, 1048576,
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do nothing;

create policy organization_branding_logo_public_read
  on storage.objects for select to anon, authenticated
  using (
    bucket_id = 'organization-branding'
    and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](png|jpg|jpeg|webp)$'
  );

create policy organization_branding_logo_owner_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'organization-branding'
    and metadata ->> 'mimetype' in ('image/png', 'image/jpeg', 'image/webp')
    and case
      when coalesce(metadata ->> 'size', '') ~ '^[0-9]{1,7}$'
        then (metadata ->> 'size')::bigint between 1 and 1048576
      else false
    end
    and (select public.can_manage_branding_logo(name))
  );

create policy organization_branding_logo_owner_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'organization-branding'
    and (select public.can_manage_branding_logo(name))
  );

commit;
