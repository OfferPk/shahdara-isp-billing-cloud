import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/20261002180000_organization_branding.sql', import.meta.url);
const [migration, portalData, clientBranding, main, receiptRenderer, billRenderer, databaseTests] = await Promise.all([
  readFile(migrationUrl, 'utf8'),
  readFile(new URL('../src/portal-data.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/organization-branding.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/admin-bills.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/customer-documents.js', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/tests/organization_branding.test.sql', import.meta.url), 'utf8'),
]);

test('branding schema is additive, public-field-only, RLS protected, and writable only through an owner RPC', () => {
  assert.match(migration, /create table public\.organization_branding\s*\([\s\S]*organization_id uuid primary key references public\.organizations\(id\)[\s\S]*display_name text not null[\s\S]*logo_path text[\s\S]*support_phone text not null[\s\S]*address text not null/i);
  assert.match(migration, /alter table public\.organization_branding enable row level security/i);
  assert.match(migration, /revoke all on table public\.organization_branding from public, anon, authenticated/i);
  assert.match(migration, /grant select on table public\.organization_branding to authenticated/i);
  assert.match(migration, /create policy organization_branding_read_linked_org[\s\S]*is_org_admin\(organization_id\)[\s\S]*is_org_customer\(organization_id\)/i);
  assert.match(migration, /create or replace function public\.is_org_customer\(p_organization_id uuid\)[\s\S]*from public\.customer_portal_accounts[\s\S]*auth\.uid\(\)/i);
  assert.match(migration, /create or replace function public\.save_organization_branding[\s\S]*security definer[\s\S]*set search_path = ''[\s\S]*public\.is_org_owner\(p_organization_id\)[\s\S]*'42501'/i);
  assert.match(migration, /revoke all on function public\.save_organization_branding\(uuid, text, text, text, text\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.save_organization_branding\(uuid, text, text, text, text\) to authenticated/i);
  assert.doesNotMatch(migration, /update public\.(customers|customer_private_details|bills|receipts|incidents)\b/i);
  assert.doesNotMatch(migration, /grant\s+[^;]*\b(?:insert|update|delete)\b[^;]*organization_branding[^;]*to\s+(?:public|anon|authenticated)/i);
});

test('public logo storage is dedicated, raster-only, size limited, same-organization owner-write, and not replaceable by arbitrary URL', () => {
  assert.match(migration, /'organization-branding', 'organization-branding', true, 1048576/i);
  assert.match(migration, /array\['image\/png', 'image\/jpeg', 'image\/webp'\]/i);
  assert.match(migration, /create policy organization_branding_logo_public_read[\s\S]*for select to anon, authenticated[\s\S]*name ~\*/i);
  assert.match(migration, /create policy organization_branding_logo_owner_insert[\s\S]*for insert to authenticated[\s\S]*metadata ->> 'mimetype'[\s\S]*can_manage_branding_logo\(name\)/i);
  assert.match(migration, /metadata ->> 'size'[\s\S]*1048576/);
  assert.match(migration, /create policy organization_branding_logo_owner_delete[\s\S]*for delete to authenticated[\s\S]*can_manage_branding_logo\(name\)/i);
  assert.doesNotMatch(migration, /create policy[^;]*for update/i);
  assert.match(clientBranding, /MAX_BRAND_LOGO_BYTES = 1_048_576/);
  assert.match(clientBranding, /isValidImageSignature/);
  assert.match(clientBranding, /4096/);
  assert.match(clientBranding, /buildBrandLogoPath/);
  assert.match(clientBranding, /parsed\.origin !== expectedOrigin/);
  assert.doesNotMatch(clientBranding, /image\/svg\+xml/);
  assert.match(main, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(main, /upsert: false/);
});

test('browser reads only the linked organization branding row and keeps private customer reads gated', () => {
  assert.match(portalData, /select\('organization_id, display_name, logo_path, support_phone, address'\)/);
  assert.match(portalData, /\.eq\('organization_id', organizationId\)\s*\.maybeSingle\(\)/);
  assert.match(portalData, /context\.kind === 'admin'[\s\S]*customer_private_details/);
  assert.match(portalData, /context\.kind === 'admin'[\s\S]*incident_private_details/);
  assert.match(main, /function brandingSettingsHtml\(\)[\s\S]*pageState\.context\?\.role !== 'owner'/);
  assert.match(main, /if \(context\.role !== 'owner'\) return;/);
  assert.match(main, /invokeRpc\(supabase, 'save_organization_branding'/);
  assert.match(main, /row\.id === billId && row\.customer_id === pageState\.context\.customerId/);
  assert.doesNotMatch(main, /from\('organization_branding'\)\s*\.update\(/);
});

test('print renderers escape provider identity/contact and use same-project storage logos', () => {
  assert.match(receiptRenderer, /function safeBrandingLogoUrl/);
  assert.match(receiptRenderer, /parsed\.origin !== expectedOrigin/);
  assert.match(receiptRenderer, /escapeHtml\(supportPhone\)/);
  assert.match(receiptRenderer, /escapeHtml\(companyAddress\)/);
  assert.match(billRenderer, /function safeLogoUrl/);
  assert.match(billRenderer, /parsed\.origin !== expectedOrigin/);
  assert.match(billRenderer, /escapeHtml\(address\)/);
  assert.match(billRenderer, /customer\.name/);
  assert.doesNotMatch(billRenderer, /customer_private_details|staff_notes|customer\.phone/);
});

test('synthetic pgTAP coverage exercises anon/no-write/cross-org/storage/owner/customer and private-data isolation', () => {
  assert.match(databaseTests, /select plan\(35\)/);
  for (const expression of [
    /anonymous role cannot select branding rows/,
    /authenticated clients have no direct branding writes/,
    /owner cannot read another organization branding/,
    /owner cannot update another organization branding/,
    /same-organization admin cannot change owner-only branding/,
    /linked customer can read own organization branding/,
    /linked customer cannot read another organization branding/,
    /unlinked user cannot read any organization branding/,
    /PNG, JPEG, and WebP/,
    /one MiB/,
    /owner can upload a same-organization raster logo under one MiB/,
    /owner cannot upload SVG logo content/,
    /owner cannot upload a logo larger than one MiB/,
    /owner cannot upload into another organization logo folder/,
    /does not expose customer-private phone or notes/,
    /does not expose private incident staff notes/,
  ]) assert.match(databaseTests, expression);
});
