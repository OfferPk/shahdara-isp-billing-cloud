import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  initializeTheme,
  normalizeTheme,
  readThemePreference,
  writeThemePreference,
} from '../src/theme.js';

const [index, styles, language] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/language.js', import.meta.url), 'utf8'),
]);

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function createControlHarness(storage) {
  const listeners = new Map();
  const label = { textContent: '' };
  const button = {
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { listeners.set(name, callback); },
    querySelector(selector) {
      assert.equal(selector, '[data-theme-label]');
      return label;
    },
    click() { listeners.get('click')?.(); },
  };
  const root = { dataset: {} };
  const announcement = { textContent: '' };
  const themeColorMeta = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const translate = (message) => `localized:${message}`;
  const control = initializeTheme({ root, button, announcement, themeColorMeta, storage, translate });
  return { control, root, button, label, announcement, themeColorMeta };
}

test('theme values are allowlisted and an absent or unknown preference defaults to light', () => {
  assert.equal(DEFAULT_THEME, 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  for (const invalid of [null, '', 'system', 'Light', 'other']) assert.equal(normalizeTheme(invalid), 'light');
  assert.equal(readThemePreference(createStorage()), 'light');
  assert.equal(readThemePreference(createStorage({ [THEME_STORAGE_KEY]: 'system' })), 'light');
});

test('theme preference reads and writes are resilient to unavailable browser storage', () => {
  const storage = createStorage();
  assert.equal(writeThemePreference('dark', storage), 'dark');
  assert.equal(storage.values.get(THEME_STORAGE_KEY), 'dark');
  assert.equal(readThemePreference(storage), 'dark');
  assert.equal(writeThemePreference('unexpected', storage), 'light');
  assert.equal(readThemePreference({ getItem() { throw new Error('storage blocked'); } }), 'light');
  assert.equal(writeThemePreference('dark', { setItem() { throw new Error('storage blocked'); } }), 'dark');
});

test('theme control exposes its state accessibly, persists toggles, and announces changes', () => {
  const storage = createStorage();
  const { control, root, button, label, announcement, themeColorMeta } = createControlHarness(storage);

  assert.equal(control.theme, 'light');
  assert.equal(root.dataset.theme, 'light');
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.equal(button.attributes['aria-label'], 'localized:Switch to dark mode');
  assert.equal(label.textContent, 'localized:Dark mode');
  assert.equal(themeColorMeta.attributes.content, '#123c35');

  button.click();
  assert.equal(control.theme, 'dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(button.attributes['aria-label'], 'localized:Switch to light mode');
  assert.equal(label.textContent, 'localized:Light mode');
  assert.equal(storage.values.get(THEME_STORAGE_KEY), 'dark');
  assert.equal(announcement.textContent, 'localized:Dark mode enabled.');
  assert.equal(themeColorMeta.attributes.content, '#101714');

  button.click();
  assert.equal(root.dataset.theme, 'light');
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.equal(announcement.textContent, 'localized:Light mode enabled.');
});

test('saved dark mode initializes without an announcement and labels can be refreshed after language changes', () => {
  const storage = createStorage({ [THEME_STORAGE_KEY]: 'dark' });
  const { control, root, button, label, announcement } = createControlHarness(storage);
  assert.equal(control.theme, 'dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(label.textContent, 'localized:Light mode');
  assert.equal(announcement.textContent, '');
  control.refreshLabels();
  assert.equal(root.dataset.theme, 'dark');
});

test('theme switch is present before app initialization, accessible, localized, and mobile touch-sized', () => {
  assert.match(index, /id="theme-toggle" class="theme-toggle" type="button" aria-label="Switch to dark mode" aria-pressed="false"/);
  assert.match(index, /<span data-theme-label>Dark mode<\/span>/);
  assert.match(index, /window\.localStorage\.getItem\('shahdara-cloud-ui-theme'\)/);
  assert.match(index, /<meta name="theme-color" content="#123c35"/);
  assert.match(styles, /:root\s*\{\s*color-scheme: light;/);
  assert.match(styles, /\.theme-toggle \{[^\n]*min-height: 44px;/);
  assert.match(styles, /@media \(max-width: 600px\) \{\s+\.header-tools \{ width: 100%; align-items: stretch; flex-direction: column;/);
  assert.match(styles, /:root\[data-theme="dark"\][\s\S]*?\.app-toast/);
  assert.match(styles, /:root\[data-theme="dark"\][\s\S]*?\.profile-card/);
  assert.match(styles, /:root\[data-theme="dark"\][\s\S]*?\.record-card/);
  assert.match(styles, /:root\[data-theme="dark"\][\s\S]*?\.feature-toggle-button/);
  assert.match(language, /'Switch to dark mode': 'Dark mode lagayen'/);
  assert.match(language, /'Dark mode enabled\.': 'Dark mode on hai\.'/);
});
