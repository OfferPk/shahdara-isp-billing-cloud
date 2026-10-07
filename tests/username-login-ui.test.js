import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('portal login presents exactly Username and Password, with no email field or validation', async () => {
  const html = await read('../index.html');
  const authPanel = html.match(/<section class="panel auth-panel" id="auth-panel"[\s\S]*?<section class="panel portal-panel"/)?.[0] ?? '';
  const loginForm = authPanel.match(/<form id="customer-login-form"[\s\S]*?<\/form>/)?.[0] ?? '';
  const inputs = [...loginForm.matchAll(/<input\b[^>]*>/g)].map(([input]) => input);

  assert.ok(authPanel, 'auth panel exists');
  assert.ok(loginForm, 'the unified username/password form exists');
  assert.equal((authPanel.match(/<form\b/g) ?? []).length, 1);
  assert.equal(inputs.length, 2);
  assert.match(inputs[0], /name="username"[^>]*type="text"/);
  assert.match(inputs[1], /name="password"[^>]*type="password"/);
  assert.match(loginForm, /data-i18n="Username"/);
  assert.match(loginForm, /data-i18n="Password"/);
  assert.doesNotMatch(authPanel, /type="email"|name="email"|email-password-login-form|id="login-form"|sign-in link/i);
  assert.doesNotMatch(loginForm, /required[^>]*email|email[^>]*required/i);
});

test('username auth maps staff to an internal alias while PPPoE customers use the server broker', async () => {
  const [main, authFlows] = await Promise.all([read('../src/main.js'), read('../src/auth-flows.js')]);

  assert.match(main, /functions\.invoke\('customer-login'/);
  assert.match(main, /isCustomerLoginFallbackError\(error\)/);
  assert.match(main, /signInWithUsernamePassword\(supabase\.auth, username, password\)/);
  assert.match(authFlows, /\$\{normalizedUsername\}@shahdara\.local/);
  assert.match(authFlows, /auth\.signInWithPassword\(\{ email, password \}\)/);
  assert.doesNotMatch(main, /signInWithOtp|signInWithEmailPassword/);
});
