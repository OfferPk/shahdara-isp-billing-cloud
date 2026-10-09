import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('portal login offers customer and Admin/Staff tabs with one username/password form', async () => {
  const html = await read('../index.html');
  const authPanel = html.match(/<section class="panel auth-panel" id="auth-panel"[\s\S]*?<section class="panel portal-panel"/)?.[0] ?? '';
  const loginForm = authPanel.match(/<form id="customer-login-form"[\s\S]*?<\/form>/)?.[0] ?? '';
  const loginTabs = [...authPanel.matchAll(/<button\b[^>]*role="tab"[^>]*data-login-mode="([^"]+)"[^>]*>/g)];
  const inputs = [...loginForm.matchAll(/<input\b[^>]*>/g)].map(([input]) => input);

  assert.ok(authPanel, 'auth panel exists');
  assert.ok(loginForm, 'the unified username/password login form exists');
  assert.deepEqual(loginTabs.map(([, mode]) => mode), ['customer', 'admin']);
  assert.match(loginTabs[0][0], /👤 Customer Login/);
  assert.match(loginTabs[1][0], /🛡️ Admin \/ Staff Login/);
  assert.match(authPanel, /role="tabpanel" aria-labelledby="login-tab-customer"/);
  assert.match(authPanel, /id="login-mode-description"/);
  assert.equal((authPanel.match(/<form\b/g) ?? []).length, 1);
  assert.equal(inputs.length, 2);
  assert.match(inputs[0], /name="username"[^>]*type="text"/);
  assert.match(inputs[1], /name="password"[^>]*type="password"/);
  assert.match(loginForm, /data-i18n="Username"/);
  assert.match(loginForm, /data-i18n="Password"/);
  assert.doesNotMatch(authPanel, /type="email"|name="email"|email-password-login-form|id="login-form"|sign-in link/i);
  assert.doesNotMatch(loginForm, /required[^>]*email|email[^>]*required/i);
});

test('admin tab uses Auth while customer tab receives an opaque BFF session', async () => {
  const [main, authFlows] = await Promise.all([read('../src/main.js'), read('../src/auth-flows.js')]);

  assert.match(main, /loginModeFromHash\(window\.location\.hash\)/);
  assert.match(main, /loginModeToHash\(nextMode\)/);
  assert.match(main, /authenticatePortalLogin\(\{/);
  assert.match(authFlows, /if \(mode === 'admin'\) return signInWithUsernamePassword\(auth, username, password\)/);
  assert.match(authFlows, /functions\.invoke\('customer-login'/);
  assert.match(authFlows, /if \(isStaffUsername\(username\)\)/);
  assert.match(authFlows, /data\?\.portal_token/);
  assert.doesNotMatch(authFlows, /auth\.setSession\(data\.session\)/);
  assert.match(authFlows, /\$\{normalizedUsername\}@shahdara\.local/);
  assert.match(authFlows, /auth\.signInWithPassword\(\{ email, password \}\)/);
  assert.doesNotMatch(main, /signInWithOtp|signInWithEmailPassword/);
});
