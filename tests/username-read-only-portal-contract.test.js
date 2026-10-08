import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('login form exposes only username and password and uses hidden internal email aliases', async () => {
  const html = await source('index.html');
  const login = html.match(/<form id="customer-login-form"[\s\S]*?<\/form>/)?.[0] ?? '';
  assert.ok(login, 'the username/password login form exists');
  assert.match(login, /name="username"/);
  assert.match(login, /name="password"/);
  assert.doesNotMatch(login, /type="email"|name="email"|Email/i);
  const authFlows = await source('src/auth-flows.js');
  assert.match(authFlows, /\$\{normalizedUsername\}@shahdara\.local/);
  assert.match(authFlows, /auth\.signInWithPassword\(/);
  assert.doesNotMatch(authFlows, /updateUser|resetPasswordForEmail|signUp/);
});

test('customer portal contains no self-service change-password or recovery surface, without altering Auth settings', async () => {
  const [html, main, authFlows, config] = await Promise.all([
    source('index.html'), source('src/main.js'), source('src/auth-flows.js'), source('supabase/config.toml'),
  ]);
  assert.doesNotMatch(html, /password-recovery-form|mandatory-password-change-form|cancel-password-recovery/);
  assert.doesNotMatch(main, /passwordRecoveryForm|mandatory-password-change-form|PASSWORD_RECOVERY|functions\.invoke\('change-customer-password'/);
  assert.match(main, /Customer access unavailable/);
  assert.doesNotMatch(`${main}\n${authFlows}`, /auth\.updateUser\s*\(|auth\.resetPasswordForEmail\s*\(|auth\.signUp\s*\(/);
  assert.doesNotMatch(config, /enable_confirmations\s*=\s*false/i);
});

test('customer telemetry polls only the fixed endpoint and never accepts client-selected customer IDs', async () => {
  const [client, api, main] = await Promise.all([
    source('src/pppoe-api-client.js'), source('src/server/pppoe-api.js'), source('src/main.js'),
  ]);
  assert.match(client, /\/api\/customer\/live-traffic/);
  assert.doesNotMatch(client.match(/fetchCustomerLiveTraffic\([\s\S]*?\n}/)?.[0] ?? '', /customerId|organizationId/);
  assert.match(api, /my_customer_portal_contexts/);
  assert.match(api, /\.eq\('organization_id', organizationId\)[\s\S]*?\.eq\('id', customerId\)/);
  assert.match(api, /maxRequestsPerSecond = 10/);
  assert.match(api, /maxConcurrent = 4/);
  assert.match(api, /maxConcurrent = 4/);
  assert.match(api, /minUserIntervalMs = 2000/);
  assert.match(main, /LIVE_TRAFFIC_POLL_INTERVAL_MS/);
  assert.match(main, /Math\.random\(\) \* 3000/);
});
