-- Synthetic-only incident authorization tests for a local disposable Supabase stack.
-- Never run this fixture file against the approved staging project or production.
begin;
select plan(18);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('30000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'incident-admin@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('30000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'incident-customer@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('30000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'incident-other-admin@example.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.organizations (id, name) values
  ('40000000-0000-4000-8000-000000000001', 'Synthetic Incident ISP A'),
  ('40000000-0000-4000-8000-000000000002', 'Synthetic Incident ISP B');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'admin'),
  ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', 'admin');
insert into public.customers (organization_id, id, customer_number, name, plan_name, service_status) values
  ('40000000-0000-4000-8000-000000000001', 'synthetic-incident-customer-a', 1, 'Synthetic Incident Customer A', 'Starter', 'active'),
  ('40000000-0000-4000-8000-000000000002', 'synthetic-incident-customer-b', 1, 'Synthetic Incident Customer B', 'Starter', 'active');
insert into public.customer_portal_accounts (organization_id, customer_id, user_id) values
  ('40000000-0000-4000-8000-000000000001', 'synthetic-incident-customer-a', '30000000-0000-4000-8000-000000000002');

select ok(not has_table_privilege('authenticated', 'public.incidents', 'insert,update,delete'),
  'authenticated clients have no direct incident write grants');
select ok(not has_table_privilege('authenticated', 'public.incident_private_details', 'insert,update,delete'),
  'authenticated clients have no direct private-note write grants');

set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000001', true);
with created as materialized (
  select public.manage_service_incident(
    '40000000-0000-4000-8000-000000000001', null, 'synthetic-incident-customer-a',
    'Synthetic customer-visible outage update', 'open', '2026-03-01 09:00:00+00', null,
    'Synthetic staff-only diagnostic note'
  ) as id
)
select ok(exists (select 1 from public.incidents i, created c
  where i.organization_id = '40000000-0000-4000-8000-000000000001'
    and i.id = c.id and i.customer_visible_summary = 'Synthetic customer-visible outage update'),
  'same-organization Admin creates an incident and receives its scoped row ID');
select is((select count(*)::integer from public.incident_private_details d join public.incidents i
  on i.organization_id = d.organization_id and i.id = d.incident_id
  where i.customer_visible_summary = 'Synthetic customer-visible outage update'
    and d.staff_notes = 'Synthetic staff-only diagnostic note'), 1,
  'staff notes are written only to the separate private table');
with updated as materialized (
  select public.manage_service_incident(
    '40000000-0000-4000-8000-000000000001',
    (select id from public.incidents where organization_id = '40000000-0000-4000-8000-000000000001' and customer_visible_summary = 'Synthetic customer-visible outage update'),
    null, 'Synthetic restored-service summary', 'resolved', '2026-03-01 09:00:00+00', '2026-03-01 10:30:00+00',
    'Synthetic staff-only follow-up note'
  ) as id
)
select ok(exists (select 1 from public.incidents i, updated u
  where i.organization_id = '40000000-0000-4000-8000-000000000001'
    and i.id = u.id and i.customer_visible_summary = 'Synthetic restored-service summary'
    and i.status = 'resolved' and i.restored_at = '2026-03-01 10:30:00+00'::timestamptz),
  'same-organization Admin updates the public summary, existing resolved status, and restoration time');
select is((select d.staff_notes from public.incident_private_details d join public.incidents i
  on i.organization_id = d.organization_id and i.id = d.incident_id
  where i.customer_visible_summary = 'Synthetic restored-service summary'),
  'Synthetic staff-only follow-up note'::text,
  'Admin updates the private note without combining it with the public summary');
select ok(not exists (select 1 from public.incidents where customer_visible_summary like '%staff-only%'),
  'private staff note text never appears in customer-visible summary');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000002', true);
select is((select count(*)::integer from public.incidents where organization_id = '40000000-0000-4000-8000-000000000001'), 1,
  'customer sees only the incident attached to the linked customer');
select is((select customer_visible_summary from public.incidents where organization_id = '40000000-0000-4000-8000-000000000001'),
  'Synthetic restored-service summary'::text,
  'customer can read the permitted customer-visible summary');
select is((select count(*)::integer from public.incident_private_details), 0,
  'customer cannot read private incident notes');
select throws_ok(
  $$select public.manage_service_incident('40000000-0000-4000-8000-000000000001', null, 'synthetic-incident-customer-a', 'Forged customer update', 'open', null, null, 'Forged private note')$$,
  '42501', null, 'non-admin customer cannot create an incident or private note');
select throws_ok(
  $$select public.manage_service_incident('40000000-0000-4000-8000-000000000001', (select id from public.incidents where customer_visible_summary = 'Synthetic restored-service summary'), null, 'Forged customer update', 'open', null, null, 'Forged private note')$$,
  '42501', null, 'non-admin customer cannot update an incident or private note');
select throws_ok(
  $$insert into public.incident_private_details (organization_id, incident_id, staff_notes) values ('40000000-0000-4000-8000-000000000001', 'synthetic-forged-incident', 'forged')$$,
  '42501', null, 'customer cannot directly create private notes');
select throws_ok(
  $$update public.incident_private_details set staff_notes = 'forged' where organization_id = '40000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'customer cannot directly update private notes');
select throws_ok(
  $$insert into public.incidents (organization_id, customer_id, customer_visible_summary) values ('40000000-0000-4000-8000-000000000001', 'synthetic-incident-customer-a', 'Forged incident')$$,
  '42501', null, 'customer cannot directly create incidents');
select throws_ok(
  $$update public.incidents set customer_visible_summary = 'Forged incident' where organization_id = '40000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'customer cannot directly update incidents');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000003', true);
select throws_ok(
  $$select public.manage_service_incident('40000000-0000-4000-8000-000000000001', (select id from public.incidents where customer_visible_summary = 'Synthetic restored-service summary'), null, 'Cross-organization forgery', 'resolved', null, null, 'Cross-organization note')$$,
  '42501', null, 'Admin from another organization cannot update the incident or private note');
reset role;
select is((select customer_visible_summary from public.incidents where organization_id = '40000000-0000-4000-8000-000000000001'),
  'Synthetic restored-service summary'::text,
  'denied customer and cross-organization changes leave the public summary unchanged');

select * from finish();
rollback;
