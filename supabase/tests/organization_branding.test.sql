-- Synthetic-only test for organization branding. Run only in a disposable/local
-- Supabase stack or inside a transaction that is rolled back after review.
begin;
select plan(35) limit 1;

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('30000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'brand-owner-a@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('30000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'brand-admin-a@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('30000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'brand-customer-a@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('30000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'brand-owner-b@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('30000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'brand-unlinked@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.organizations (id, name) values
  ('50000000-0000-4000-8000-000000000001', 'Synthetic Canonical ISP A'),
  ('50000000-0000-4000-8000-000000000002', 'Synthetic Canonical ISP B');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('50000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'owner'),
  ('50000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', 'admin'),
  ('50000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000004', 'owner');
insert into public.customers (organization_id, id, customer_number, name) values
  ('50000000-0000-4000-8000-000000000001', 'synthetic-brand-customer-a', 1, 'Synthetic Branding Customer A'),
  ('50000000-0000-4000-8000-000000000002', 'synthetic-brand-customer-b', 1, 'Synthetic Branding Customer B');
insert into public.customer_private_details (organization_id, customer_id, phone, staff_notes) values
  ('50000000-0000-4000-8000-000000000001', 'synthetic-brand-customer-a', '03000000000', 'Synthetic private customer note');
insert into public.incidents (organization_id, id, customer_id, customer_visible_summary) values
  ('50000000-0000-4000-8000-000000000001', 'synthetic-brand-incident', 'synthetic-brand-customer-a', 'Synthetic customer-visible service update');
insert into public.incident_private_details (organization_id, incident_id, staff_notes) values
  ('50000000-0000-4000-8000-000000000001', 'synthetic-brand-incident', 'Synthetic private incident note');
insert into public.customer_portal_accounts (organization_id, customer_id, user_id) values
  ('50000000-0000-4000-8000-000000000001', 'synthetic-brand-customer-a', '30000000-0000-4000-8000-000000000003');
insert into public.organization_branding (organization_id, display_name, support_phone, address) values
  ('50000000-0000-4000-8000-000000000001', 'Synthetic Brand A', '+92 300 0000000', 'Synthetic Address A'),
  ('50000000-0000-4000-8000-000000000002', 'Synthetic Brand B', '+92 301 0000000', 'Synthetic Address B');

select ok(not has_table_privilege('anon', 'public.organization_branding', 'select'), 'anonymous role cannot select branding rows') limit 1;
select ok(has_table_privilege('authenticated', 'public.organization_branding', 'select'), 'authenticated role has read access subject to RLS') limit 1;
select ok(not has_table_privilege('authenticated', 'public.organization_branding', 'insert,update,delete'), 'authenticated clients have no direct branding writes') limit 1;
select ok(has_function_privilege('authenticated', 'public.save_organization_branding(uuid,text,text,text,text)', 'execute'), 'authenticated role can invoke the guarded owner RPC') limit 1;
select is((select file_size_limit from storage.buckets where id = 'organization-branding' limit 1), 1048576::bigint, 'branding bucket caps files at one MiB') limit 1;
select ok((select public and cardinality(allowed_mime_types) = 3 and allowed_mime_types @> array['image/png','image/jpeg','image/webp']::text[] from storage.buckets where id = 'organization-branding' limit 1), 'public logo bucket allows only PNG, JPEG, and WebP') limit 1;
select ok(exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'organization_branding_logo_owner_insert' and with_check like '%mimetype%' and with_check like '%can_manage_branding_logo%' limit 1), 'storage insert policy checks image MIME metadata and owner-scoped paths') limit 1;

set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000001', true) limit 1;
select is(current_user::text, 'authenticated', 'branding owner RLS tests execute as authenticated') limit 1;
select is((select count(*)::integer from public.organization_branding where organization_id = '50000000-0000-4000-8000-000000000001'), 1, 'owner can read own organization branding') limit 1;
select is((select count(*)::integer from public.organization_branding where organization_id = '50000000-0000-4000-8000-000000000002'), 0, 'owner cannot read another organization branding') limit 1;
select lives_ok($$select public.save_organization_branding('50000000-0000-4000-8000-000000000001', 'Globe Expert', null, '+92 300 5550101', 'Synthetic Owner Address')$$, 'same-organization owner can update display name and support contact') limit 1;
select is((select display_name from public.organization_branding where organization_id = '50000000-0000-4000-8000-000000000001' limit 1), 'Globe Expert'::text, 'owner display name update is saved') limit 1;
select is((select support_phone from public.organization_branding where organization_id = '50000000-0000-4000-8000-000000000001' limit 1), '+92 300 5550101'::text, 'brand support phone stays in its separate public branding field') limit 1;
select is((select address from public.organization_branding where organization_id = '50000000-0000-4000-8000-000000000001' limit 1), 'Synthetic Owner Address'::text, 'company address update is saved') limit 1;
select throws_ok($$update public.organization_branding set display_name = 'Direct update' where organization_id = '50000000-0000-4000-8000-000000000001'$$, '42501', null, 'owner cannot bypass the narrow RPC with a table update') limit 1;
select ok(public.can_manage_branding_logo('50000000-0000-4000-8000-000000000001/60000000-0000-4000-8000-000000000001.png'), 'owner path helper accepts a generated same-organization PNG path') limit 1;
select ok(not public.can_manage_branding_logo('50000000-0000-4000-8000-000000000001/60000000-0000-4000-8000-000000000001.svg'), 'owner path helper rejects SVG paths') limit 1;
select ok(not public.can_manage_branding_logo('https://example.invalid/logo.png'), 'owner path helper rejects remote URL paths') limit 1;
select ok(not public.can_manage_branding_logo('50000000-0000-4000-8000-000000000002/60000000-0000-4000-8000-000000000001.png'), 'owner path helper rejects another organization path') limit 1;
select throws_ok($$select public.save_organization_branding('50000000-0000-4000-8000-000000000002', 'Forged cross-org brand', null, '', '')$$, '42501', null, 'owner cannot update another organization branding') limit 1;
select lives_ok($$insert into storage.objects (bucket_id, name, metadata) values ('organization-branding', '50000000-0000-4000-8000-000000000001/70000000-0000-4000-8000-000000000001.png', '{"mimetype":"image/png","size":10}'::jsonb)$$, 'owner can upload a same-organization raster logo under one MiB') limit 1;
select throws_ok($$insert into storage.objects (bucket_id, name, metadata) values ('organization-branding', '50000000-0000-4000-8000-000000000001/70000000-0000-4000-8000-000000000002.svg', '{"mimetype":"image/svg+xml","size":10}'::jsonb)$$, '42501', null, 'owner cannot upload SVG logo content') limit 1;
select throws_ok($$insert into storage.objects (bucket_id, name, metadata) values ('organization-branding', '50000000-0000-4000-8000-000000000001/70000000-0000-4000-8000-000000000003.png', '{"mimetype":"image/png","size":1048577}'::jsonb)$$, '42501', null, 'owner cannot upload a logo larger than one MiB') limit 1;
select throws_ok($$insert into storage.objects (bucket_id, name, metadata) values ('organization-branding', '50000000-0000-4000-8000-000000000002/70000000-0000-4000-8000-000000000004.png', '{"mimetype":"image/png","size":10}'::jsonb)$$, '42501', null, 'owner cannot upload into another organization logo folder') limit 1;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000003', true) limit 1;
select is((select count(*)::integer from public.organization_branding where organization_id = '50000000-0000-4000-8000-000000000001'), 1, 'linked customer can read own organization branding') limit 1;
select is((select count(*)::integer from public.organization_branding where organization_id = '50000000-0000-4000-8000-000000000002'), 0, 'linked customer cannot read another organization branding') limit 1;
select is((select count(*)::integer from public.customer_private_details), 0, 'branding access does not expose customer-private phone or notes') limit 1;
select is((select count(*)::integer from public.incident_private_details), 0, 'branding access does not expose private incident staff notes') limit 1;
select throws_ok($$update public.organization_branding set display_name = 'Customer forgery' where organization_id = '50000000-0000-4000-8000-000000000001'$$, '42501', null, 'customer cannot directly write organization branding') limit 1;
select throws_ok($$select public.save_organization_branding('50000000-0000-4000-8000-000000000001', 'Customer forgery', null, '', '')$$, '42501', null, 'customer cannot invoke the owner-only branding RPC') limit 1;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000002', true) limit 1;
select throws_ok($$select public.save_organization_branding('50000000-0000-4000-8000-000000000001', 'Admin cannot change', null, '', '')$$, '42501', null, 'same-organization admin cannot change owner-only branding') limit 1;
select ok(not public.is_org_owner('50000000-0000-4000-8000-000000000001'), 'admin role is not treated as organization owner') limit 1;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000004', true) limit 1;
select is((select count(*)::integer from public.organization_branding where organization_id = '50000000-0000-4000-8000-000000000002'), 1, 'second owner can read only their own organization branding') limit 1;
select is((select count(*)::integer from public.organization_branding where organization_id = '50000000-0000-4000-8000-000000000001'), 0, 'second owner cannot read the first organization branding') limit 1;

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000005', true) limit 1;
select is((select count(*)::integer from public.organization_branding), 0, 'unlinked user cannot read any organization branding') limit 1;

reset role;
select report from extensions.finish(true) as result(report) limit 100;
rollback;
