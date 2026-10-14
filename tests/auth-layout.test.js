import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [index, styles] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
]);

test('sign-in hero illustration is decorative and cannot add untranslated content', () => {
  assert.match(index, /<div class="auth-panel__visual" aria-hidden="true">[\s\S]*?<svg class="auth-panel__network"[^>]*focusable="false"/);
  assert.match(index, /<span class="auth-panel__visual-mark">SF<\/span>/);
});

test('sign-in panel becomes a split layout only when visible and stacks on mobile', () => {
  assert.match(styles, /\.auth-panel:not\(\[hidden\]\)\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(245px,\s*\.86fr\)\s+minmax\(0,\s*1\.14fr\)/);
  assert.match(styles, /\.auth-panel:not\(\[hidden\]\)\s*\{[^}]*row-gap:\s*12px;[^}]*align-content:\s*start;/);
  assert.match(styles, /@media \(max-width: 760px\)\s*\{\s+\.auth-panel:not\(\[hidden\]\)\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(styles, /\.auth-panel__visual\s*\{[^}]*grid-row:\s*1 \/ span 6;[^}]*min-height:\s*530px/);
  assert.match(styles, /\.auth-panel__visual\s*\{[^}]*grid-row:\s*auto;[^}]*min-height:\s*172px/);
});

test('sign-in fields and actions retain comfortable touch sizes', () => {
  assert.match(styles, /\.auth-panel input\s*\{[^}]*min-height:\s*49px/);
  assert.match(styles, /\.auth-panel \.button\s*\{[^}]*min-height:\s*48px/);
});
