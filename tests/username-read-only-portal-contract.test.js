import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('customer login accepts only username/password while internal aliases stay out of its form', async () => {
  const html = await source('index.html');
  const login = html.match(/<form id="customer-login-form"[\s\S]*?<\/form>/)?.[0] ?? '';
  assert.ok(login, 'the username/password login form exists');
  assert.match(login, /name="username"/);
  assert.match(login, /name="password"/);
  assert.doesNotMatch(login, /type="email"|name="email"|Email/i);
  const authFlows = await source('src/auth-flows.js');
  assert.match(authFlows, /functions\.invoke\('customer-login'/);
  assert.match(authFlows, /if \(mode === 'admin'\) return signInWithUsernamePassword\(auth, username, password\)/);
  assert.doesNotMatch(authFlows, /auth\.setSession|resetPasswordForEmail|updateUser|signUp/);
});

test('customer portal contains no self-service password-change or recovery surface', async () => {
  const [html, main, authFlows, config] = await Promise.all([
    source('index.html'), source('src/main.js'), source('src/auth-flows.js'), source('supabase/config.toml'),
  ]);
  assert.doesNotMatch(html, /password-recovery-form|mandatory-password-change-form|cancel-password-recovery/);
  assert.doesNotMatch(main, /passwordRecoveryForm|mandatory-password-change-form|PASSWORD_RECOVERY|functions\.invoke\('change-customer-password'/);
  assert.match(main, /Customer access unavailable/);
  assert.doesNotMatch(`${main}\n${authFlows}`, /auth\.updateUser\s*\(|auth\.resetPasswordForEmail\s*\(|auth\.signUp\s*\(/);
  assert.doesNotMatch(config, /enable_confirmations\s*=\s*false/i);
});

test('customer telemetry polls one fixed endpoint, verifies opaque token hash, and cannot select customer IDs', async () => {
  const [client, api, main, router] = await Promise.all([
    source('src/pppoe-api-client.js'), source('src/server/pppoe-api.js'), source('src/main.js'), source('src/server/router-adapters.js'),
  ]);
  const customerAuthStart = api.indexOf('async function authorizeCustomerTraffic');
  const limiterStart = api.indexOf('function createTrafficRateLimiter', customerAuthStart);
  const customerAuth = api.slice(customerAuthStart, limiterStart);
  assert.match(client, /\/api\/customer\/live-traffic/);
  assert.doesNotMatch(client.match(/fetchCustomerLiveTraffic\([\s\S]*?\n}/)?.[0] ?? '', /customerId|organizationId/);
  assert.match(api, /resolve_customer_portal_bff_traffic/);
  assert.match(api, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(api, /createHash\('sha256'\)/);
  assert.doesNotMatch(customerAuth, /my_customer_portal_contexts|auth\.getUser/);
  assert.match(api, /Live RouterOS telemetry is not configured/);
  assert.match(api, /maxRequestsPerSecond = 10/);
  assert.match(api, /maxConcurrent = 4/);
  assert.match(api, /minUserIntervalMs = 2000/);
  assert.match(router, /tls\.connect\(/);
  assert.match(router, /rejectUnauthorized:\s*true/);
  assert.match(main, /LIVE_TRAFFIC_POLL_INTERVAL_MS/);
  assert.match(main, /Math\.random\(\) \* 3000/);
  assert.match(main, /const portalToken = pageState\.customerPortalToken/);
  assert.match(main, /fetchCustomerLiveTraffic\(\{ token: portalToken \}\)/);
});
