import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const APPROVED_PROJECT_REF = 'pocvrbwcfvtsupgdlouv';
const REQUIRED_TEST_USERNAMES = ['raja-arif', 'bajwa-house'];
const PAGE_SIZE = 1000;
const APPLY = process.argv.includes('--apply');

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Required runtime setting ${name} is missing.`);
  return value;
}

function validateSettings() {
  const url = new URL(requireEnvironment('SUPABASE_URL'));
  if (url.hostname !== `${APPROVED_PROJECT_REF}.supabase.co`) {
    throw new Error('Provisioning is restricted to the approved production Supabase project.');
  }
  const organizationId = requireEnvironment('CUSTOMER_PORTAL_ORGANIZATION_ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) {
    throw new Error('The approved organization identifier is invalid.');
  }
  const expectedCount = Number.parseInt(process.env.CUSTOMER_PORTAL_EXPECTED_COUNT ?? '101', 10);
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 10000) {
    throw new Error('The expected subscriber count must be a positive bounded integer.');
  }
  return { url: url.href.replace(/\/$/, ''), organizationId, expectedCount };
}

async function readLinkedCustomers(client, organizationId) {
  const customers = [];
  for (let offset = 0; offset < 50000; offset += PAGE_SIZE) {
    const { data, error } = await client.from('customers')
      .select('id, organization_id, pppoe_username')
      .eq('organization_id', organizationId)
      .eq('archived', false)
      .not('pppoe_username', 'is', null)
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error('Customer identity preflight could not be completed.');
    const page = data ?? [];
    customers.push(...page);
    if (page.length < PAGE_SIZE) return customers;
  }
  throw new Error('Customer identity preflight exceeded its bounded page limit.');
}

function validateCustomerSet(customers, { organizationId, expectedCount }) {
  if (customers.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} linked subscriber identities; found ${customers.length}. No Auth users were changed.`);
  }
  const usernames = new Set();
  for (const customer of customers) {
    const username = String(customer.pppoe_username ?? '');
    const customerId = String(customer.id ?? '');
    if (String(customer.organization_id ?? '').toLowerCase() !== organizationId.toLowerCase()
        || !customerId || customerId.length > 200
        || !username || username.trim() !== username || username.length > 64
        || !/^[\x21-\x7e]+$/.test(username) || usernames.has(username)) {
      throw new Error('Linked subscriber identity validation failed. No Auth users were changed.');
    }
    usernames.add(username);
  }
  for (const required of REQUIRED_TEST_USERNAMES) {
    if (!usernames.has(required)) throw new Error('A requested test username is missing from the approved organization.');
  }
}

function createAuthAlias() {
  return `portal-${randomBytes(16).toString('hex')}@internal.shahdara.net`;
}

async function reserveCustomer(client, customer, organizationId) {
  const reservation = await client.rpc('reserve_customer_portal_bff_account', {
    p_organization_id: organizationId,
    p_customer_id: String(customer.id),
    p_login_username: String(customer.pppoe_username),
    p_auth_email_alias: createAuthAlias(),
  });
  if (reservation.error) throw new Error('Portal account reservation failed; stop for owner review.');
  if (reservation.data?.status === 'already_reserved' && reservation.data?.account_status === 'active') {
    return { customer, alreadyActive: true, authEmailAlias: null };
  }
  const alias = String(reservation.data?.auth_email_alias ?? '');
  if (reservation.data?.status !== 'reserved' || !/^portal-[0-9a-f]{32}@internal\.shahdara\.net$/.test(alias)) {
    throw new Error('A non-active or conflicting portal-account state requires owner review. No Auth users were reset.');
  }
  return { customer, alreadyActive: false, authEmailAlias: alias };
}

async function lockAccount(client, organizationId, customerId) {
  try {
    const { data, error } = await client.rpc('lock_customer_portal_bff_account', {
      p_organization_id: organizationId,
      p_customer_id: customerId,
    });
    return !error && data?.status === 'locked';
  } catch {
    return false;
  }
}

async function createAndLinkAuthUser(client, reservation, organizationId, sharedPassword) {
  const customerId = String(reservation.customer.id);
  let authResult;
  let authError;
  try {
    ({ data: authResult, error: authError } = await client.auth.admin.createUser({
      email: reservation.authEmailAlias,
      password: sharedPassword,
      email_confirm: true,
    }));
  } catch {
    const locked = await lockAccount(client, organizationId, customerId);
    throw new Error(locked
      ? 'Auth user creation failed; the reserved account was locked for review.'
      : 'Auth user creation failed and account lock could not be confirmed; stop for owner review.');
  }
  if (authError || !authResult?.user?.id) {
    const locked = await lockAccount(client, organizationId, customerId);
    throw new Error(locked
      ? 'Auth user creation failed; the reserved account was locked for review.'
      : 'Auth user creation failed and account lock could not be confirmed; stop for owner review.');
  }

  let completion;
  try {
    completion = await client.rpc('complete_customer_portal_bff_account', {
      p_organization_id: organizationId,
      p_customer_id: customerId,
      p_user_id: authResult.user.id,
    });
  } catch {
    const locked = await lockAccount(client, organizationId, customerId);
    throw new Error(locked
      ? 'Account linking failed; the account was locked for review.'
      : 'Account linking failed and account lock could not be confirmed; stop for owner review.');
  }
  if (completion.error || completion.data?.status !== 'ok') {
    const locked = await lockAccount(client, organizationId, customerId);
    throw new Error(locked
      ? 'Account linking failed; the account was locked for review.'
      : 'Account linking failed and account lock could not be confirmed; stop for owner review.');
  }
}

async function main() {
  const { url, organizationId, expectedCount } = validateSettings();
  const serviceRoleKey = requireEnvironment('SUPABASE_SERVICE_ROLE_KEY');
  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const customers = await readLinkedCustomers(client, organizationId);
  validateCustomerSet(customers, { organizationId, expectedCount });

  if (!APPLY) {
    console.log(`DRY RUN: ${customers.length} linked subscriber identities passed bounded preflight. No Auth users or passwords were changed.`);
    console.log('After explicit owner approval and reviewed schema deployment, rerun with --apply and the approved shared-password runtime secret.');
    return;
  }

  const sharedPassword = requireEnvironment('CUSTOMER_PORTAL_SHARED_PASSWORD');
  const reservations = [];
  for (const customer of customers) reservations.push(await reserveCustomer(client, customer, organizationId));
  if (reservations.some((reservation) => reservation.alreadyActive)) {
    throw new Error('An existing active mapping was left unchanged; no new Auth users were created. Owner review is required before continuing.');
  }

  for (const reservation of reservations) await createAndLinkAuthUser(client, reservation, organizationId, sharedPassword);
  console.log(`Provisioning complete: ${reservations.length} new portal accounts created and linked.`);
}

main().catch(() => {
  console.error('Customer portal provisioning halted safely. No password or customer identity details are included in this output; review non-active states before retrying.');
  process.exitCode = 1;
});
