import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [index, main, customerList, adminBills, adminReceipts, metrics, styles, dashboardAnalytics] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/customer-list.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/admin-bills.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/admin-receipts.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/dashboard-metrics.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/dashboard-analytics.js', import.meta.url), 'utf8'),
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

function mixHex(first, second, firstWeight = 0.91) {
  const channels = (color) => [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  const [a, b] = [channels(first), channels(second)];
  return `#${a.map((channel, index) => Math.round(channel * firstWeight + b[index] * (1 - firstWeight))
    .toString(16).padStart(2, '0')).join('')}`;
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

test('billing and receipt collections use named semantic card lists instead of wide tables', () => {
  const tableRegions = (source) => [...source.matchAll(/class="table-wrap" role="region" tabindex="0" aria-label=/g)].length;
  const cardLists = (source) => [...source.matchAll(/<ul class="record-card-grid[^\"]*" aria-label=/g)].length;
  assert.equal(tableRegions(main), 0, 'Admin receipts and Customer billing history no longer need horizontal table scrolling');
  assert.equal(tableRegions(customerList), 0, 'customer-profile history no longer needs horizontal table scrolling');
  assert.equal(cardLists(main), 2, 'Customer bill and receipt history use named lists in the portal');
  assert.equal(cardLists(adminReceipts), 1, 'Admin receipt history uses a named list');
  assert.equal(cardLists(customerList), 3, 'customer-profile bills, receipts, and effective cost history use named lists');
  for (const [name, source] of [['portal', main], ['Admin receipt history', adminReceipts], ['customer profile', customerList]]) {
    assert.match(source, /<li><article class="record-card/ , `${name} records are articles within native lists`);
    assert.match(source, /class="record-card__facts"/, `${name} card fields use definition lists`);
    assert.match(source, /class="record-card-empty" role="status"/, `${name} empty states remain announced`);
  }
  assert.match(adminReceipts, /class="record-card-grid admin-receipt-card-grid" aria-label=/);
  assert.match(adminReceipts, /data-action="edit-receipt"/);
  assert.match(adminReceipts, /data-action="delete-receipt"/);
  assert.match(main, /data-action="print-bill"/);
  assert.match(styles, /\.record-card-grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 760px\) \{\s+\.record-card-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(adminBills, /aria-label="\$\{escapeHtml\(t\('Correct bill for'\)\)\} \$\{customerName\}/);
  assert.match(adminReceipts, /aria-label="\$\{escapeHtml\(t\('Edit receipt for'\)\)\} \$\{receiptCustomer\}, \$\{escapeHtml\(t\('dated'\)\)\} \$\{receiptDate\}/);
  assert.match(main, /aria-label="\$\{escapeHtml\(t\('Filter bills by payment status'\)\)\}"/);
  assert.match(main, /<label for="admin-receipt-search">/);
  assert.match(main, /class="receipt-pagination" aria-label=/);
  assert.match(main, /id="admin-receipt-count" class="admin-receipt-count" role="status" aria-live="polite"/);
  assert.match(main, /id="admin-bill-count" class="bill-list-count" role="status" aria-live="\$\{billDrilldown \? 'off' : 'polite'\}"/);
  assert.match(main, /id="admin-bill-drilldown-message" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(main, /data-action="clear-dashboard-drilldown" data-target="admin-bills"/);
  assert.match(main, /formatUiMessage\('Showing \{shown\} of \{matching\} matching bills; \{total\} total records\.'/);
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
  assert.match(index, /class="skip-link" href="#app" data-i18n="Skip to main content">Skip to main content/);
  assert.match(index, /id="language-toggle" class="language-toggle" role="group" aria-label="Language"/);
  assert.match(index, /data-language="ur-Latn" aria-label="Roman Urdu" aria-pressed="false"/);
  assert.match(main, /button\.setAttribute\('aria-pressed', String\(selected\)\)/);
  assert.match(styles, /\.skip-link:focus \{ transform: translateY\(0\); \}/);
  assert.match(styles, /button:focus-visible, a:focus-visible \{ outline: 3px solid #102e27/);
  assert.match(styles, /\.table-wrap:focus-visible \{ outline: 3px solid #102e27/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(main, /matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(styles, /@media \(max-width: 380px\) \{[\s\S]*?\.site-header \{ flex-wrap: wrap;/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.customer-card-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(styles, /@media \(max-width: 600px\) \{\s+\.customer-billing-filters \{ grid-template-columns: 1fr; \}\s+\.customer-billing-filters label:first-child/);
  assert.match(styles, /\.cashflow-chart-wrap \{ overflow-x: auto; overscroll-behavior-inline: contain; \}/);
  assert.match(styles, /@media \(max-width: 820px\) \{\s+\.cashflow-workspace \{ grid-template-columns: 1fr; \}/);
  assert.match(styles, /@media \(max-width: 600px\) \{\s+\.cashflow-summary-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}\s+\.cashflow-history-filters \{ grid-template-columns: 1fr; \}/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.customer-service-cost-form \{ grid-template-columns: 1fr; \}/);
  assert.match(styles, /\.customer-action \{ display: inline-flex; min-height: 40px;/);
  assert.match(styles, /\.customer-filter-pill \{ min-height: 44px;/);
});

test('tablet header wraps before its controls overflow and keeps labeled touch targets accessible', () => {
  const tabletHeader = styles.match(/@media \(max-width: 960px\) and \(min-width: 601px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(tabletHeader, 'the tablet header breakpoint is present');
  assert.match(tabletHeader, /\.site-header \{[^}]*flex-wrap: wrap;/);
  assert.match(tabletHeader, /\.header-tools \{[^}]*width: 100%;[^}]*flex-wrap: wrap;/);
  assert.match(tabletHeader, /\.environment-tag \{[^}]*margin-left: auto;/);
  assert.match(styles, /@media \(max-width: 600px\) \{\s+\.header-tools \{ width: 100%; align-items: stretch; flex-direction: column;/);
  assert.match(index, /id="install-app-button" class="button secondary" type="button" data-i18n="Install app" aria-describedby="install-app-status"/);
  assert.match(index, /id="language-toggle" class="language-toggle" role="group" aria-label="Language"/);
  assert.match(index, /id="theme-toggle" class="theme-toggle" type="button" aria-label="Switch to dark mode"/);
  assert.match(styles, /\.install-control \.button \{ min-height: 44px;/);
  assert.match(styles, /\.language-toggle__option \{ min-height: 44px;/);
  assert.match(styles, /\.theme-toggle \{ display: inline-flex; min-width: 44px; min-height: 44px;/);
  assert.match(styles, /\.language-toggle__option:focus-visible/);
  assert.match(styles, /\.theme-toggle:focus-visible/);
});

test('sign-in and password-recovery actions keep 44px touch targets', () => {
  const authButtonRule = styles.match(/\.auth-panel \.button\s*\{([^}]*)\}/)?.[1] ?? '';
  const minimumHeight = Number(authButtonRule.match(/min-height:\s*(\d+(?:\.\d+)?)px/)?.[1]);
  assert.ok(minimumHeight >= 44, `auth buttons need at least 44px height; found ${minimumHeight}px`);
  for (const formId of ['customer-login-form', 'email-password-login-form', 'login-form', 'password-recovery-form']) {
    assert.ok(index.includes(`id="${formId}"`), `auth touch target rule covers ${formId}`);
  }
});

test('current-password sign-in fields have paired, localized visibility controls with accessible touch targets', () => {
  const fields = [...index.matchAll(/<div class="password-input-control">([\s\S]*?)<\/div>/g)].map((match) => match[1]);
  assert.equal(fields.length, 2, 'only the two current-password sign-in fields receive visibility controls');
  for (const [field, id] of fields.map((field, index) => [field, ['customer-login-password', 'email-password'][index]])) {
    assert.ok(field.includes(`id="${id}"`), `${id} remains the paired password field`);
    assert.match(field, /type="password"[^>]*autocomplete="current-password"/);
    assert.ok(field.includes(`<button class="password-visibility-toggle" type="button" data-password-visibility="${id}" data-i18n="Show" data-i18n-aria-label="Show password" aria-label="Show password" aria-pressed="false">Show</button>`));
  }
  const toggleRule = styles.match(/\.auth-panel \.password-visibility-toggle\s*\{([^}]*)\}/)?.[1] ?? '';
  const minHeight = Number(toggleRule.match(/min-height:\s*(\d+(?:\.\d+)?)px/)?.[1]);
  const minWidth = Number(toggleRule.match(/min-width:\s*(\d+(?:\.\d+)?)px/)?.[1]);
  assert.ok(minHeight >= 44 && minWidth >= 44, 'visibility controls meet the 44px touch target minimum');
  assert.match(styles, /button:focus-visible, a:focus-visible \{ outline: 3px solid/);
  assert.match(main, /button\.addEventListener\('click', \(\) => togglePasswordVisibility\(input, button, t\)\)/);
});

test('cashflow reconciliation is announced as a note and distinguishes list filters from the selected-period summary', () => {
  assert.match(main, /class="cashflow-reconciliation" role="note"/);
  assert.match(main, /Selected-period cashflow reconciliation: cash receipts \{income\}.*net cashflow \{net\}/);
  for (const key of ['incomePaisa', 'operatingCostsPaisa', 'operatingProfitPaisa', 'partnerDistributionsPaisa', 'netCashflowPaisa']) {
    assert.ok(main.includes(`formatMoney(totals.${key})`), `reconciliation uses the existing ${key} total`);
  }
  assert.match(main, /History search and date filters only narrow this list; they do not change the selected-period cashflow summary above\./);
  assert.match(styles, /\.cashflow-reconciliation \{[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /\.cashflow-filter-scope \{ margin: 0 0 12px;/);
});

test('cashflow reconciliation text keeps WCAG AA contrast in both theme palettes', () => {
  const palettes = [
    {
      name: 'light',
      root: styles.match(/(?:^|\n):root \{([^}]*)\}/)?.[1],
      panel: styles.match(/(?:^|\n)\.cashflow-panel \{([^}]*)\}/)?.[1],
    },
    {
      name: 'dark',
      root: styles.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)?.[1],
      panel: styles.match(/:root\[data-theme="dark"\] \.cashflow-panel \{([^}]*)\}/)?.[1],
    },
  ];
  const cssColor = (block, variable) => block?.match(new RegExp(`${variable}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];

  for (const palette of palettes) {
    const foreground = cssColor(palette.root, '--ink');
    const paper = cssColor(palette.root, '--paper');
    const accent = cssColor(palette.panel, '--cashflow-net');
    assert.ok(foreground && paper && accent, `${palette.name} theme tokens are available`);
    const background = mixHex(paper, accent);
    assert.ok(contrastRatio(foreground, background) >= 4.5,
      `${palette.name} note text contrast against ${background} must meet WCAG AA`);
  }
  assert.match(styles, /\.cashflow-reconciliation \{[^}]*color: var\(--ink\); background: color-mix\(in srgb, var\(--paper\) 91%, var\(--cashflow-net\)\)/);
});

test('customer usage meter is responsive, accessible, color-coded, and keeps status text at WCAG AA contrast', async () => {
  const usageUi = await readFile(new URL('../src/customer-usage.js', import.meta.url), 'utf8');
  assert.match(usageUi, /role="progressbar" aria-label=/);
  assert.match(usageUi, /aria-valuetext=/);
  assert.match(usageUi, /usage-progress--\$\{summary\.quotaTone\}/);
  assert.match(styles, /\.usage-progress--good > span/);
  assert.match(styles, /\.usage-progress--warning > span/);
  assert.match(styles, /\.usage-progress--critical > span/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.usage-metrics \{ grid-template-columns: 1fr; \}/);
  assert.match(main, /expiryDate: null/);
  for (const [foreground, background] of [
    ['#145c3e', '#e9f6ee'],
    ['#744b12', '#fff0cf'],
    ['#7c302b', '#ffe8e4'],
  ]) {
    assert.ok(contrastRatio(foreground, background) >= 4.5, `${foreground} on ${background} must meet WCAG AA`);
  }
});

test('billing date pickers are labeled, use native inputs, and provide accessible touch-sized presets', () => {
  assert.match(main, /Billing Cycle Month/);
  assert.match(main, /id="bill-issued-on" name="issued_on" type="date"/);
  assert.match(main, /id="bill-due-date" name="due_date" type="date"/);
  assert.match(main, /id="bill-edit-issued-on" name="issued_on" type="date"/);
  assert.match(main, /id="bill-edit-due-date" name="due_date" type="date"/);
  for (const preset of ['today', 'fifth', 'tenth', 'end']) assert.match(main, new RegExp(`data-due-date-preset="${preset}"`));
  assert.match(main, /role="group" aria-label="\$\{escapeHtml\(t\('Choose an exact due date quickly'\)\)\}"/);
  assert.match(styles, /\.due-date-preset \{ min-height: 44px;/);
  assert.match(styles, /\.due-date-preset:focus-visible/);
});

test('dashboard trend controls keep accessible state, keyboard focus, and 44px touch targets', () => {
  const buttonStyles = styles.match(/\.dashboard-view-button\s*\{([^}]*)\}/)?.[1] ?? '';
  const minimumHeight = Number(buttonStyles.match(/min-height:\s*(\d+(?:\.\d+)?)px/)?.[1]);
  assert.ok(minimumHeight >= 44, `trend buttons need at least 44px height; found ${minimumHeight}px`);
  assert.match(styles, /\.dashboard-view-button:focus-visible[^}]*outline:\s*3px solid/);
  assert.match(dashboardAnalytics, /role="group" aria-label="\$\{escapeHtml\(t\('Trend time view'\)\)\}"/);
  assert.match(dashboardAnalytics, /\['day', 'Daily'\], \['week', 'Weekly'\], \['month', 'Monthly'\]/);
  assert.match(dashboardAnalytics, /data-dashboard-trend-view="\$\{key\}" aria-pressed="\$\{selectedView === key\}"/);
});

test('Admin incident reporting and updates use labeled fields, explicit statuses, and responsive cards', () => {
  for (const label of [
    'Affected customer (optional)',
    'Customer-visible summary',
    'Status',
    'Service offline at (optional)',
    'Service restored at (optional)',
    'Staff-only note (optional)',
  ]) assert.ok(main.includes(label), `Admin incident form includes ${label}`);
  assert.match(main, /id="incident-create-summary" name="customer_visible_summary" maxlength="1000"/);
  assert.match(main, /id="incident-create-status" name="status" required><option value="open" selected>\$\{escapeHtml\(t\('Open'\)\)\}<\/option><option value="resolved">\$\{escapeHtml\(t\('Resolved'\)\)\}<\/option>/);
  assert.match(main, /name="restored_at" type="datetime-local" step="1"/);
  assert.match(main, /Date-times use this device's local time zone/);
  assert.match(main, /Private to same-organization Admins; stored separately and never copied into the customer-visible summary/);
  assert.match(main, /id="admin-incident-search" type="search"/);
  assert.match(main, /aria-label="\$\{escapeHtml\(t\('Filter service incidents by status'\)\)\}"/);
  for (const status of ['all', 'open', 'resolved']) assert.match(main, new RegExp(`data-incident-status="${status}"[^>]*aria-pressed=`));
  assert.match(main, /id="admin-incident-count" class="bill-list-count" role="status" aria-live="polite"/);
  assert.match(styles, /\.incident-filter-pills \{ display: flex; flex-wrap: wrap;/);
  assert.match(styles, /\.incident-filter-pill \{ min-height: 44px;/);
  assert.match(styles, /\.incident-card-grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 760px\) \{\s+\.incident-card-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(styles, /@media \(max-width: 600px\) \{\s+\.incident-create-form \{ grid-template-columns: 1fr;/);
});

test('password recovery announces confirmed saves and tries sound only after Auth returns a user', () => {
  assert.match(index, /id="app-toast" class="app-toast" role="status" aria-live="polite" aria-atomic="true" hidden/);
  assert.match(styles, /\.app-toast\[hidden\] \{ display: none; \}/);
  assert.match(styles, /safe-area-inset-bottom/);
  const handler = main.match(/passwordRecoveryForm\?\.addEventListener\('submit', async \(event\) => \{([\s\S]*?)\n  \}\);/)?.[1];
  assert.ok(handler, 'password recovery handler exists');
  const confirmation = handler.indexOf('if (updateResult?.error || !updateResult?.data?.user?.id)');
  const toast = handler.indexOf("showAppToast('Your password was updated successfully.')");
  const sound = handler.indexOf('successSound.play()');
  assert.ok(confirmation >= 0 && toast > confirmation, 'the confirmed Auth user check precedes the success toast');
  assert.ok(sound > toast, 'sound follows the visible success confirmation');
  assert.match(handler.slice(confirmation, toast), /successSound\.cancel\(\)/);
  assert.match(handler, /Password could not be updated\. Check the recovery link and try again\./);
});

test('Admin PPPoE controls are schema-gated and explicitly mapping-only', async () => {
  const portalData = await readFile(new URL('../src/portal-data.js', import.meta.url), 'utf8');
  assert.match(main, /context\.kind !== 'admin' \|\| pageState\.rows\?\.pppoeMappingAvailable !== true/);
  assert.match(main, /The customers\.pppoe_username field is not available in this project yet/);
  assert.match(main, /Never enter a PPPoE password here/);
  assert.match(main, /does not create a network account or change Overtake, RADIUS, or RouterOS/);
  assert.match(portalData, /\.update\(\{ pppoe_username: pppoeUsername \}\)/);
  assert.match(portalData, /\.eq\('organization_id', organizationId\)[\s\S]*?\.eq\('id', customerId\)/);
  assert.doesNotMatch(portalData, /service_role|change-password|ppp secret|radius.*write/i);
});


test('feature panels have default-collapsed eye controls without unmounting state or stopping work', async () => {
  const featureToggles = await readFile(new URL('../src/feature-toggles.js', import.meta.url), 'utf8');
  for (const key of ['auth-customer-username', 'auth-email-password', 'auth-email-link', 'auth-password-recovery']) {
    assert.match(index, new RegExp(`data-feature-key="${key}"`));
  }
  assert.match(main, /initializeFeatureToggles\(document,\s*\{[\s\S]*?observe: true/);
  assert.doesNotMatch(main, /from ['"]\.\/dashboard-analytics\.js['"]/);
  assert.match(main, /import\(['"]\.\/dashboard-analytics\.js['"]\)/);
  assert.match(main, /analyticsToggle\?\.parentElement\?\.id === 'admin-dashboard-analytics'/);
  assert.match(featureToggles, /expandedFeatureKeys\.has\(key\)/, 'unknown panels start folded');
  assert.match(featureToggles, /feature\.dataset\.featureDefaultExpanded === 'true'/);
  assert.match(featureToggles, /collapsedFeatureKeys\.has\(key\)/);
  assert.match(featureToggles, /collapsedFeatureKeys\.add\(key\)/);
  assert.match(main, /data-feature-key="admin-month-controls" data-feature-default-expanded="true"/);
  assert.match(featureToggles, /button\.type = 'button'/);
  assert.match(featureToggles, /button\.setAttribute\('aria-controls'/);
  assert.match(featureToggles, /controlledIds\.join\(' '\)/);
  assert.match(featureToggles, /child\.inert = nextExpanded \? originalInertState\.get\(child\) : true/);
  assert.match(featureToggles, /button\.setAttribute\('aria-expanded'/);
  assert.match(featureToggles, /button\.setAttribute\('aria-label'/);
  assert.match(featureToggles, /button\.addEventListener\('click'/);
  assert.match(featureToggles, /trackFeatureRunning/);
  assert.match(featureToggles, /observeInsertedFeatures/);
  assert.doesNotMatch(featureToggles, /\.innerHTML\s*=|replaceChildren\(/, 'folding leaves forms and pending actions mounted');
  assert.match(styles, /\[data-feature-toggle\]\[data-feature-expanded="false"\] > :not\(\.feature-toggle-button\) \{ display: none !important; \}/);
  assert.match(styles, /data-feature-running="true"/);
  assert.match(styles, /linear-gradient\(125deg, #4de5ae 0%, #7ce8f1/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.feature-toggle-button \{ transition: none; \}/);
  assert.match(styles, /\.feature-toggle-button \{ display: flex; width: 100%;[^\n]*min-height: 44px;/);
});
