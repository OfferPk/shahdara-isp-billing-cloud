import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderDashboardAnalyticsSkeleton } from '../src/dashboard-analytics-loading.js';
import { translateUi } from '../src/language.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('analytics loading keeps an accessible announcement alongside decorative skeleton cards', () => {
  const markup = renderDashboardAnalyticsSkeleton((message) => `Translated: ${message}`);

  assert.match(markup, /class="dashboard-analytics-skeleton" aria-hidden="true"/);
  assert.equal((markup.match(/dashboard-analytics-skeleton__card/g) ?? []).length, 5);
  assert.match(markup, /class="sr-only">Translated: Loading dashboard analytics\.<\/span>/);
  assert.doesNotMatch(markup, /<script|onerror=/i);
  assert.equal(translateUi('Loading dashboard analytics.', 'ur-Latn'), 'Dashboard analytics load ho rahi hain.');
});

test('the skeleton appears before the lazy analytics import and remains a live loading status', () => {
  const skeletonInsertion = main.indexOf("loadingMessage.innerHTML = renderDashboardAnalyticsSkeleton(t)");
  const moduleLoad = main.indexOf('loadDashboardAnalyticsModule().then');

  assert.notEqual(skeletonInsertion, -1);
  assert.notEqual(moduleLoad, -1);
  assert.ok(skeletonInsertion < moduleLoad);
  assert.match(main, /section\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(main, /class="dashboard-analytics-loading" role="status"/);
});

test('deferred analytics loading compares against the generation captured by renderAdmin', () => {
  const renderAdminStart = main.indexOf('function renderAdmin() {');
  const renderAdminEnd = main.indexOf('\n  function populateReceiptBills', renderAdminStart);
  assert.notEqual(renderAdminStart, -1);
  assert.notEqual(renderAdminEnd, -1);

  const renderAdmin = main.slice(renderAdminStart, renderAdminEnd);
  assert.match(renderAdmin, /const renderGeneration = \+\+dashboardAnalyticsRenderGeneration;/);
  assert.match(renderAdmin, /if \(renderGeneration === pageState\.dashboardAnalyticsRenderGeneration && section\?\.dataset\.featureExpanded === 'true'\)/);
  assert.doesNotMatch(renderAdmin, /if \(generation === pageState\.dashboardAnalyticsRenderGeneration/);

  const callbackBody = renderAdmin.match(/window\.setTimeout\(\(\) => \{([\s\S]*?)\n    \}, 0\);/)?.[1];
  assert.ok(callbackBody, 'the deferred analytics callback should remain scheduled after rendering');
  const runCallback = new Function('renderGeneration', 'pageState', 'portalPanel', 'requestDashboardAnalytics', callbackBody);
  const expandedPortalPanel = { querySelector: () => ({ dataset: { featureExpanded: 'true' } }) };
  let requestCount = 0;

  runCallback(7, { dashboardAnalyticsRenderGeneration: 7 }, expandedPortalPanel, () => { requestCount += 1; });
  assert.equal(requestCount, 1, 'expanded analytics should load for the current render');
  runCallback(7, { dashboardAnalyticsRenderGeneration: 8 }, expandedPortalPanel, () => { requestCount += 1; });
  assert.equal(requestCount, 1, 'stale render callbacks should not load analytics');
});

test('skeleton layout stacks on phones and disables shimmer for reduced-motion users', () => {
  assert.match(styles, /\.dashboard-analytics-skeleton\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.dashboard-analytics-skeleton\s*\{\s*grid-template-columns:\s*1fr;/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.dashboard-analytics-skeleton__line\s*\{\s*animation:\s*none;/);
  assert.match(styles, /@keyframes dashboard-analytics-shimmer/);
});
