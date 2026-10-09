import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = () => readFile(new URL('../scripts/provision-customer-bff-accounts.js', import.meta.url), 'utf8');

test('production provisioner defaults to dry-run and pins the approved project and 101-record preflight', async () => {
  const script = await source();
  assert.match(script, /const APPLY = process\.argv\.includes\('--apply'\)/);
  assert.match(script, /const APPROVED_PROJECT_REF = 'pocvrbwcfvtsupgdlouv'/);
  assert.match(script, /CUSTOMER_PORTAL_EXPECTED_COUNT \?\? '101'/);
  assert.match(script, /CUSTOMER_PORTAL_ORGANIZATION_ID/);
  assert.match(script, /REQUIRED_TEST_USERNAMES = \['raja-arif', 'bajwa-house'\]/);
  assert.match(script, /client\.rpc\('list_customer_portal_bff_provisioning_candidates'/);
  assert.match(script, /p_organization_id: organizationId/);
  assert.match(script, /id: row\.customer_id/);
  assert.doesNotMatch(script, /\.from\('customers'\)/);
  assert.match(script, /if \(!APPLY\)[\s\S]*No Auth users or passwords were changed/);
});

test('provisioner creates new users only, never resets existing accounts, and locks failed partials', async () => {
  const script = await source();
  assert.match(script, /auth\.admin\.createUser\(/);
  assert.doesNotMatch(script, /updateUserById|deleteUser|auth\.admin\.updateUser/);
  assert.match(script, /reservation\.data\?\.status === 'already_reserved' && reservation\.data\?\.account_status === 'active'[\s\S]*alreadyActive: true/);
  assert.match(script, /reservations\.some\(\(reservation\) => reservation\.alreadyActive\)/);
  assert.match(script, /for \(const customer of customers\) reservations\.push\(await reserveCustomer[\s\S]*for \(const reservation of reservations\) await createAndLinkAuthUser/);
  assert.match(script, /lock_customer_portal_bff_account/);
  assert.match(script, /CUSTOMER_PORTAL_SHARED_PASSWORD/);
  assert.doesNotMatch(script, /console\.log\([^\n]*(sharedPassword|portal-[0-9a-f]|pppoe_username)/);
});
