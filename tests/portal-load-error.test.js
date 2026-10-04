import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderPortalLoadError, safePortalErrorDetails } from '../src/portal-load-error.js';
import { translateUi } from '../src/language.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('portal load errors use escaped user-facing copy with retry and sign-out actions', () => {
  const markup = renderPortalLoadError({
    eyebrow: 'Could not load records',
    title: 'Portal data is temporarily unavailable.',
    description: 'Check your connection and retry.',
    retryLabel: 'Retry',
    signOutLabel: 'Sign out',
    retryKind: 'session',
  });

  assert.match(markup, /role="alert"/);
  assert.match(markup, /data-action="retry-portal-load" data-retry-kind="session">Retry<\/button>/);
  assert.match(markup, /data-action="sign-out">Sign out<\/button>/);
  assert.equal(translateUi('Retry', 'ur-Latn'), 'Dobara koshish karein');
  assert.doesNotMatch(renderPortalLoadError({
    eyebrow: '<img onerror=alert(1)>', title: '<script>bad</script>', description: 'x&y', retryLabel: 'Retry', signOutLabel: 'Sign out',
  }), /<script>|<img|x&y/);
});

test('developer diagnostics keep only bounded error code and HTTP status', () => {
  assert.deepEqual(safePortalErrorDetails({
    code: 'PGRST503', status: 503, message: 'customer name and database details', details: 'private payload',
  }), { code: 'PGRST503', status: 503 });
  assert.deepEqual(safePortalErrorDetails({ code: 'bad code with customer data', status: 999, message: 'sensitive' }), {
    code: 'unknown', status: null,
  });
});

test('portal request failures render the shared retry state instead of backend messages', () => {
  assert.match(main, /function showPortalLoadError\(\{ error, scope, eyebrow, title, description, retryKind \}\)/);
  assert.match(main, /console\.warn\('Portal data load failed\.', \{ scope, \.\.\.safePortalErrorDetails\(error\) \}\)/);
  assert.match(main, /data-action="retry-portal-load"/);
  assert.match(main, /target\.dataset\.retryKind === 'context' && pageState\.context\) await selectContext\(pageState\.context\)/);
  assert.match(main, /target\.dataset\.retryKind === 'session' && pageState\.user\) await handleSession\(\{ user: pageState\.user \}\)/);
  assert.match(main, /if \(pageState\.user\?\.id !== session\.user\.id\) \{\s+pageState\.contexts = \[\];\s+pageState\.context = null;\s+pageState\.rows = null;/);
  assert.doesNotMatch(main, /Could not load records<\\\/p><h2>.*error\.message/s);
});
