import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [index, styles] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
]);

test('sign-in content keeps its semantic heading and login controls in an accessible split layout', () => {
  assert.match(index, /<div class="auth-intro">[\s\S]*?<h1 data-i18n="Sign in to your account">/);
  assert.match(index, /<div class="auth-content">[\s\S]*?id="login-mode-tabs"[\s\S]*?id="login-options"/);
  assert.match(index, /<svg class="auth-art"[^>]*aria-hidden="true"/);
  assert.match(index, /id="customer-login-form"/);
  assert.match(index, /id="login-tab-admin"/);
});

test('sign-in styling collapses for narrow screens and retains a dark-theme surface', () => {
  assert.match(styles, /\.auth-panel\s*\{[^}]*display:\s*grid/);
  assert.match(styles, /@media \(max-width: 680px\)\s*\{[^}]*\.auth-panel\s*\{\s*grid-template-columns:\s*1fr;/);
  assert.match(styles, /:root\[data-theme="dark"\] \.auth-content\s*\{\s*background:\s*var\(--paper\);/);
  assert.match(styles, /\.auth-content input\s*\{\s*min-height:\s*48px/);
});
