import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [main, styles] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
]);

test('customer navigation gets a dedicated, horizontally scrollable sticky rail', () => {
  assert.match(main, /portal-nav\$\{customerNavClass\}/);
  assert.match(main, /kind === 'customer' \? ' portal-nav--customer' : ''/);
  assert.match(styles, /\.portal-nav--customer\s*\{[^}]*position:\s*sticky;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/);
  assert.match(styles, /\.portal-nav--customer a\s*\{[^}]*flex:\s*0 0 auto;/);
  assert.match(styles, /#customer-account, #customer-usage, #customer-expiry, #customer-billing, #customer-incidents\s*\{[^}]*scroll-margin-top:\s*86px/);
});

test('provider identity and customer summary cards have clear visual hierarchy', () => {
  assert.match(styles, /\.provider-card__identity\s*\{[^}]*border-inline-start:/);
  assert.match(styles, /\.provider-card__contact p\s*\{[^}]*border-radius:\s*12px/);
  assert.match(styles, /\.customer-metrics \.metric::before\s*\{[^}]*height:\s*4px/);
});

test('dark theme preserves readable customer navigation and provider contact surfaces', () => {
  assert.match(styles, /:root\[data-theme="dark"\] \.portal-nav--customer\s*\{/);
  assert.match(styles, /:root\[data-theme="dark"\] \.provider-card__contact p\s*\{/);
});
