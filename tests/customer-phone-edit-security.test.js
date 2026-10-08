import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

test('customer WhatsApp phone updates are scoped to same-organization Admins and stay private', async () => {
  const migration = await read('supabase/migrations/20261008205921_admin_edit_customer_whatsapp_phone.sql');
  const portalData = await read('src/portal-data.js');
  const main = await read('src/main.js');
  const billCards = await read('src/admin-bills.js');

  assert.match(migration, /create or replace function public\.set_customer_private_phone/i);
  assert.match(migration, /security definer\s+set search_path = ''/i);
  assert.match(migration, /not public\.is_org_admin\(p_organization_id\)/i);
  assert.match(migration, /from public\.customers c[\s\S]*?c\.organization_id = p_organization_id[\s\S]*?c\.id = p_customer_id/i);
  assert.match(migration, /insert into public\.customer_private_details \(organization_id, customer_id, phone\)[\s\S]*?on conflict \(organization_id, customer_id\)[\s\S]*?do update set phone = excluded\.phone/i);
  assert.match(migration, /revoke all on function public\.set_customer_private_phone\(uuid, text, text\)[\s\S]*?from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.set_customer_private_phone\(uuid, text, text\)[\s\S]*?to authenticated/i);
  assert.match(portalData, /supabase\.rpc\('set_customer_private_phone'/);
  assert.match(main, /id="customer-phone-dialog"/);
  assert.match(billCards, /data-action="edit-customer-phone"/);
  assert.match(main, /saveCustomerWhatsappPhone\(supabase/);
  assert.match(main, /pageState\.rows\.privateCustomerDetails\.find/);
});
