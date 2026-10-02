import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [index, main, customerList, adminBills, metrics, styles] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/customer-list.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/admin-bills.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/dashboard-metrics.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
]);

function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test('portal updates use concise live announcements and assertive error messages', () => {
  assert.doesNotMatch(index, /<main id="app"[^>]*aria-live=/);
  assert.match(index, /id="app-announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(main, /node\.setAttribute\('role', isError \? 'alert' : 'status'\)/);
  assert.match(main, /node\.setAttribute\('aria-live', isError \? 'assertive' : 'polite'\)/);
  assert.match(main, /node\.setAttribute\('aria-atomic', 'true'\)/);
  assert.match(main, /aria-live="\$\{view\.invalidDateRange \? 'assertive' : 'polite'\}"/);
});

test('portal route and data refreshes provide a focus destination and announce completion', () => {
  assert.match(main, /<h1 tabindex="-1">/);
  assert.match(main, /if \(contextChanged\) portalPanel\.querySelector\('h1'\)\?\.focus\(\)/);
  assert.match(main, /portalPanel\.querySelector\('h1'\)\?\.focus\(\);\s*announceApp\(announcement\)/);
  for (const phrase of ['Customer saved.', 'Bill snapshot created.', 'Receipt recorded.', 'Receipt correction saved.', 'Receipt deleted.']) {
    assert.ok(main.includes(phrase), `completion announcement includes ${phrase}`);
  }
});

test('all wide billing tables are named, keyboard-scrollable regions with captions and column headers', () => {
  const tableRegions = (source) => [...source.matchAll(/class="table-wrap" role="region" tabindex="0" aria-label="[^"]+"/g)].length;
  assert.equal(tableRegions(main), 4, 'remaining Admin and Customer portal tables have named keyboard-scroll regions');
  assert.equal(tableRegions(customerList), 1, 'Admin customer-profile billing table has a named keyboard-scroll region');
  for (const [name, source] of [['portal', main], ['customer profile', customerList]]) {
    const tables = [...source.matchAll(/<table>([\s\S]*?)<\/table>/g)].map((match) => match[1]);
    assert.ok(tables.length > 0, `${name} has tables to review`);
    for (const table of tables) {
      assert.match(table, /<caption class="sr-only">/);
      assert.match(table, /<th scope="col">/);
    }
  }
  assert.match(adminBills, /aria-label="Correct bill for \$\{customerName\}/);
  assert.match(main, /aria-label="Edit receipt for \$\{escapeHtml\(customerName\(receipt\.customer_id\)\)\}/);
  assert.match(main, /aria-label="Filter bills by payment status"/);
  assert.match(main, /aria-live="polite">Showing \$\{Math\.min\(filteredAdminBillRows\.length, 100\)\}/);
});

test('KPI detail text maintains WCAG AA contrast on the colorful Admin card tints', () => {
  const muted = styles.match(/--muted:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.ok(muted, 'shared muted text color is defined');
  assert.match(styles, /\.metric small \{ color: var\(--muted\);/);
  const cardTints = ['#f2faf5', '#f3f7ff', '#f8f4ff', '#fff9ee'];
  for (const tint of cardTints) {
    assert.ok(styles.includes(tint), `expected KPI tint ${tint}`);
    assert.ok(contrastRatio(muted, tint) >= 4.5, `${muted} on ${tint} must be at least 4.5:1`);
  }
  assert.match(metrics, /class="metric__icon" aria-hidden="true"/);
});

test('keyboard focus, reduced motion and small-phone layout remain explicit', () => {
  assert.match(index, /class="skip-link" href="#app">Skip to main content/);
  assert.match(styles, /\.skip-link:focus \{ transform: translateY\(0\); \}/);
  assert.match(styles, /button:focus-visible, a:focus-visible \{ outline: 3px solid #102e27/);
  assert.match(styles, /\.table-wrap:focus-visible \{ outline: 3px solid #102e27/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(main, /matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(styles, /@media \(max-width: 380px\) \{[\s\S]*?\.site-header \{ flex-wrap: wrap;/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.customer-card-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(styles, /@media \(max-width: 600px\) \{\s+\.customer-billing-filters \{ grid-template-columns: 1fr; \}\s+\.customer-billing-filters label:first-child/);
  assert.match(styles, /\.customer-action \{ display: inline-flex; min-height: 40px;/);
  assert.match(styles, /\.customer-filter-pill \{ min-height: 44px;/);
});

test('billing date pickers are labeled, use native inputs, and provide accessible touch-sized presets', () => {
  assert.match(main, /Billing Cycle Month/);
  assert.match(main, /id="bill-issued-on" name="issued_on" type="date"/);
  assert.match(main, /id="bill-due-date" name="due_date" type="date"/);
  assert.match(main, /id="bill-edit-issued-on" name="issued_on" type="date"/);
  assert.match(main, /id="bill-edit-due-date" name="due_date" type="date"/);
  for (const preset of ['today', 'fifth', 'tenth', 'end']) assert.match(main, new RegExp(`data-due-date-preset="${preset}"`));
  assert.match(main, /role="group" aria-label="Choose an exact due date quickly"/);
  assert.match(styles, /\.due-date-preset \{ min-height: 44px;/);
  assert.match(styles, /\.due-date-preset:focus-visible/);
});
