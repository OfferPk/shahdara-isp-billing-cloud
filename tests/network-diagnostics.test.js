import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_SYNTHETIC_IDENTIFIER_LENGTH,
  MOCK_DIAGNOSTIC_FIXTURES,
  MockDiagnosticsProvider,
  RISK_PREVIEW_POLICY,
  SIMULATION_EXAMPLES,
  SYNTHETIC_IDENTIFIER_TYPES,
  renderSyntheticDiagnosticResult,
  runSyntheticDiagnostics,
} from '../src/network-diagnostics.js';
import { translateUi } from '../src/language.js';

const [main, styles, moduleSource] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/network-diagnostics.js', import.meta.url), 'utf8'),
]);

const provider = new MockDiagnosticsProvider();

test('the fixed synthetic fixture catalog supports English, Roman Urdu, and Urdu examples', () => {
  assert.equal(provider.mode, 'simulation');
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'Ali Khan').map(({ id }) => id), ['demo-ali-a', 'demo-ali-b']);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'Ahmed Raza').map(({ id }) => id), ['demo-ahmed-a']);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'احمد رضا').map(({ id }) => id), ['demo-ahmed-a']);
  assert.equal(SIMULATION_EXAMPLES.find(({ id }) => id === 'roman-ali').complaint, 'Ali ka internet nahi chal raha');
  assert.equal(SIMULATION_EXAMPLES.find(({ id }) => id === 'english-ahmed').complaint, "Ahmed's internet is slow");
  assert.equal(SIMULATION_EXAMPLES.find(({ id }) => id === 'urdu-ahmed').complaint, 'احمد کی رفتار سست ہے');
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'فائزہ'), []);
  assert.equal(MOCK_DIAGNOSTIC_FIXTURES.length, 3);
});

test('every supported identifier type resolves only its exact synthetic fixture', () => {
  assert.deepEqual(SYNTHETIC_IDENTIFIER_TYPES.map(({ value }) => value), [
    'name', 'username', 'pppoeUsername', 'customerId', 'phonePlaceholder', 'accountNumber',
  ]);
  for (const fixture of MOCK_DIAGNOSTIC_FIXTURES) {
    for (const { value: identifierType } of SYNTHETIC_IDENTIFIER_TYPES.filter(({ value }) => value !== 'name')) {
      const identifier = fixture.demoIdentifiers[identifierType];
      assert.deepEqual(
        provider.searchSyntheticFixturesByIdentifier(identifierType, identifier).map(({ id }) => id),
        [fixture.id],
        `${identifierType} should select only ${fixture.id}`,
      );
      assert.deepEqual(provider.searchSyntheticFixturesByIdentifier(identifierType, `prefix-${identifier}`), [], `${identifierType} must not substring-match`);
      assert.deepEqual(provider.searchSyntheticFixturesByIdentifier(identifierType, `${identifier}-suffix`), [], `${identifierType} must not accept an appended value`);
      assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', identifier), [], `${identifier} is not a name or alias`);
    }
  }
  assert.match(MOCK_DIAGNOSTIC_FIXTURES[0].demoIdentifiers.phonePlaceholder, /^DEMO-PHONE-\d+-NOT-DIALABLE$/);
  assert.equal(MOCK_DIAGNOSTIC_FIXTURES[0].demoIdentifiers.username, 'SIM-USER-ALI-A');
  assert.equal(MOCK_DIAGNOSTIC_FIXTURES[0].demoIdentifiers.pppoeUsername, 'SIM.PPPOE.ALI.A');
});

test('fictional display names and aliases match exactly; duplicate Ali aliases stay ambiguous', () => {
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'Ali Khan').map(({ id }) => id), ['demo-ali-a', 'demo-ali-b']);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'Ali').map(({ id }) => id), ['demo-ali-a', 'demo-ali-b']);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'Ahmed Raza').map(({ id }) => id), ['demo-ahmed-a']);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'Ahmed Raza · Synthetic profile').map(({ id }) => id), ['demo-ahmed-a']);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'Ali Khan junior'), []);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'Not Ali Khan'), []);

  const candidates = provider.searchSyntheticFixturesByIdentifier('name', 'Ali Khan');
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map(({ displayName }) => displayName), [
    'Ali Khan · Synthetic profile A',
    'Ali Khan · Synthetic profile B',
  ]);
  assert.throws(() => runSyntheticDiagnostics(provider, 'not-a-listed-fixture', 'Ali has no internet'), /Choose a listed synthetic fixture/);
  const selected = runSyntheticDiagnostics(provider, candidates[0].id, 'Ali ka internet nahi chal raha');
  assert.equal(selected.fixtureLabel, 'DEMO-ALI-A');
  assert.equal(selected.outcome, 'simulated-only');
});

test('Urdu-script synthetic display-name aliases resolve their fictional fixture', () => {
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'احمد رضا').map(({ id }) => id), ['demo-ahmed-a']);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'علی خان').map(({ id }) => id), ['demo-ali-a', 'demo-ali-b']);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'احمد رضا کے ساتھ اضافی متن'), []);
});

test('unknown, malformed, and cross-type identifiers fail closed without customer or router APIs', () => {
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'Unknown Person'), []);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('username', 'REAL-CUSTOMER-LOGIN'), []);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('phonePlaceholder', '+923001234567'), []);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('accountNumber', 'DEMO-CUSTOMER-001'), []);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('customer', 'DEMO-CUSTOMER-001'), []);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('username', ''), []);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('username', null), []);
  assert.equal(typeof provider.getCustomer, 'undefined');
  assert.equal(typeof provider.lookupCustomer, 'undefined');
  assert.equal(typeof provider.getRouterStatus, 'undefined');
  assert.equal(typeof provider.executeCommand, 'undefined');
  assert.deepEqual(Object.getOwnPropertyNames(MockDiagnosticsProvider.prototype).sort(), [
    'constructor', 'getSyntheticEvidence', 'searchSyntheticFixturesByIdentifier',
  ]);
});

test('identifier and complaint inputs are bounded; invalid providers and fixture IDs are rejected', () => {
  assert.equal(MAX_SYNTHETIC_IDENTIFIER_LENGTH, 120);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('username', 'x'.repeat(MAX_SYNTHETIC_IDENTIFIER_LENGTH + 1)), []);
  assert.throws(() => runSyntheticDiagnostics(provider, 'demo-ahmed-a', '  '), /1 to 500/);
  assert.throws(() => runSyntheticDiagnostics(provider, 'demo-ahmed-a', 'x'.repeat(501)), /1 to 500/);
  assert.throws(() => runSyntheticDiagnostics({}, 'demo-ahmed-a', 'Ahmed is slow'), /built-in simulation provider/);
  class ExtendedProvider extends MockDiagnosticsProvider {}
  assert.throws(() => runSyntheticDiagnostics(new ExtendedProvider(), 'demo-ahmed-a', 'Ahmed is slow'), /built-in simulation provider/);
  assert.equal(runSyntheticDiagnostics(provider, 'demo-ahmed-a', '<script>alert(1)</script>').outcome, 'simulated-only', 'complaint text is not interpreted as a command or action');
});

test('result rendering escapes untrusted text, exposes only demo metadata, and keeps technical details collapsed', () => {
  const result = runSyntheticDiagnostics(provider, 'demo-ahmed-a', '<script>alert("x")</script>');
  const markup = renderSyntheticDiagnosticResult({ ...result, displayName: '<img src=x onerror=alert(1)>' });
  assert.match(markup, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(markup, /<(?:script|img)\b|<[^>]+\sonerror=/i);
  assert.match(markup, /<ul class="network-diagnostics__findings"[^>]*><li><article class="network-diagnostics__finding"/);
  assert.match(markup, /<details class="network-diagnostics__technical"><summary>/);
  assert.doesNotMatch(markup, /<details[^>]+\sopen(?:=|\s|>)/i);
  assert.match(markup, /Synthetic demo profile/);
  assert.match(markup, /No router or customer change was applied/);
  assert.match(markup, /Changes are disabled/);
  assert.doesNotMatch(markup, /<button|data-action=|Confirm Change/i);
  assert.match(markup, /No shell, command execution, external AI, router API, or database lookup/);
  assert.throws(() => renderSyntheticDiagnosticResult({ ...result, simulated: false }));
});

test('simulation evidence is truthful and every risk band remains preview-only', () => {
  const result = runSyntheticDiagnostics(provider, 'demo-ahmed-a', "Ahmed's internet is slow");
  assert.equal(result.simulated, true);
  assert.equal(result.source, 'synthetic-local-fixture');
  assert.match(result.diagnosis, /synthetic example/i);
  assert.ok(result.findings.some(({ state }) => state === 'mock'));
  assert.ok(result.findings.some(({ state, value }) => state === 'unavailable' && /no live device/i.test(value)));
  assert.match(result.recommendation, /No fix was applied or verified/);
  assert.doesNotMatch(result.outcome, /fixed|resolved/i);
  assert.deepEqual(RISK_PREVIEW_POLICY.map(({ state }) => state), [
    'Unavailable · preview only',
    'Unavailable · preview only',
    'Unavailable · preview only',
  ]);
  assert.ok(RISK_PREVIEW_POLICY.every(({ level }) => /Low|Medium|High/.test(level)));
});

test('the module contains no live lookup, persistence, router, or customer-action call path', () => {
  assert.doesNotMatch(moduleSource, /function\s+(?:apply|change|write|execute|reboot|disconnect|refresh)\w*\s*\(/i);
  assert.doesNotMatch(moduleSource, /fetch\s*\(|XMLHttpRequest|WebSocket|child_process|supabase|routeros|radius|olt|indexedDB|localStorage|sessionStorage|\.rpc\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(/i);
});

test('Admin UI gates the lazy-loaded module and clearly instructs use of demo identifiers only', () => {
  assert.match(main, /import\('\.\/network-diagnostics\.js'\)/);
  assert.doesNotMatch(main, /import\s+[^;]*network-diagnostics\.js/);
  assert.match(main, /\['#admin-network-diagnostics', 'AI Network Engineer · Simulation'\]/);
  assert.match(main, /context\.kind !== 'admin' \|\| !\['owner', 'admin'\]\.includes\(context\.role\)/);
  assert.match(main, /No live router is connected\./);
  assert.match(main, /does not read portal customer or billing records, query network devices, call an external AI, or apply changes\./);
  assert.match(main, /renderPortalNavigation\('customer'\)/);
  assert.match(main, /This simulator never verifies a real customer issue/);
  assert.match(moduleSource, /Synthetic demo identifier type/);
  assert.match(moduleSource, /Fake phone placeholder \(not a phone number\)/);
  assert.match(moduleSource, /Never enter a real customer name, login, PPPoE credential, account number, or phone number/);
  assert.match(moduleSource, /Inputs stay local and are not saved or sent/);
  assert.match(moduleSource, /data-synthetic-fixture=/);
  assert.match(moduleSource, /Choose a synthetic demo profile to continue/);
});

test('diagnostics layout is keyboard usable, responsive, and translated for Roman Urdu', () => {
  assert.match(moduleSource, /aria-live="polite"/);
  assert.match(moduleSource, /<label for="network-diagnostics-identifier-type">/);
  assert.match(moduleSource, /<label for="network-diagnostics-identifier">/);
  assert.match(moduleSource, /<label for="network-diagnostics-complaint">/);
  assert.match(styles, /\.network-diagnostics :is\(button, input, select, textarea, summary\):focus-visible/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.network-diagnostics__findings \{ grid-template-columns: 1fr;/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.network-diagnostics__examples \{ display: grid; grid-template-columns: 1fr;/);
  assert.match(styles, /:root\[data-theme="dark"\] \.network-diagnostics__notice/);
  assert.match(styles, /\.network-diagnostics__example, \.network-diagnostics__match \{ min-height: 44px;/);
  assert.equal(translateUi('No live router is connected.', 'ur-Latn'), 'Koi live router connected nahin hai.');
  assert.equal(translateUi('Run simulated check', 'ur-Latn'), 'Simulated jaanch chalayein');
  const translatableCopy = [
    'AI Network Engineer · Simulation', 'AI Network Engineer', 'SIMULATION ONLY', 'Fictional examples',
    'No live router is connected.', 'This deterministic local demo uses fictional fixtures only. It does not read portal customer or billing records, query network devices, call an external AI, or apply changes.',
    'This simulator never verifies a real customer issue. All router changes and customer or profile changes are unavailable.',
    'Open this section to load the local simulation.', 'Loading local simulation…', 'Could not load the local simulation. No network integration was attempted.',
    'SIMULATION ONLY · NOT LIVE NETWORK DATA', 'Simulated diagnostic result', 'Complaint', 'Synthetic demo profile', 'Synthetic and unavailable diagnostic findings',
    'No router or customer change was applied, and no service restoration was verified.', 'Recommendation', 'Technical details',
    'Evidence source', 'Local synthetic fixture', 'Fixture identifier', 'Live router response',
    'No shell, command execution, external AI, router API, or database lookup is available in this feature.',
    'Changes are disabled', 'This simulator has no router or customer write tools. Nothing is applied, queued, or awaiting confirmation.',
    'Synthetic demo identifier type', 'Synthetic demo identifier value',
    'Use fictional demo values only. Never enter a real customer name, login, PPPoE credential, account number, or phone number. Inputs stay local and are not saved or sent.',
    'Use a fictional demo complaint only. Complaint text is processed locally in this browser and is not saved or sent.',
    'Describe a synthetic demo complaint (English, Roman Urdu, or Urdu)', 'Synthetic demo profiles',
    'Multiple synthetic demo profiles match. Select one explicitly; no live customer records were searched.',
    'One synthetic demo profile matches. Select it explicitly to see the local example.', 'Select synthetic profile',
    'No synthetic demo profile matched', 'This feature searched only its fictional local fixtures. No live customer lookup was made.',
    'Try a listed example or choose a name included in the synthetic examples.', 'Synthetic complaint examples',
    'Example added. Submit to run the local simulation.', 'Simulation complete. This is not a live diagnosis.',
    'The local simulation could not produce this example.', 'Enter a synthetic demo identifier (1 to 120 characters) and a demo complaint (1 to 500 characters).',
    'No synthetic example matched; live customer lookup was not attempted.', 'Choose a synthetic demo profile to continue.',
    'Synthetic display name or alias', 'Simulated username', 'Simulated PPPoE username', 'Synthetic customer ID',
    'Fake phone placeholder (not a phone number)', 'Synthetic account number',
    ...SYNTHETIC_IDENTIFIER_TYPES.map(({ placeholder }) => placeholder),
    'Roman Urdu: Ali ka internet nahi chal raha', "English: Ahmed's internet is slow", 'Urdu: احمد کی رفتار سست ہے',
    'Unknown synthetic demo name: Zara ka internet band hai',
    'Low-risk router changes', 'Medium-risk customer or profile changes', 'High-risk network or destructive changes', 'Unavailable · preview only',
    'Enter a complaint between 1 and 500 characters.',
    ...RISK_PREVIEW_POLICY.flatMap(({ level, state }) => [level, state]),
    ...MOCK_DIAGNOSTIC_FIXTURES.flatMap(({ diagnosis, findings }) => [diagnosis, ...findings.flatMap(({ label, value }) => [label, value])]),
  ];
  for (const copy of translatableCopy) {
    assert.notEqual(translateUi(copy, 'ur-Latn'), copy, `diagnostics copy has Roman Urdu: ${copy}`);
  }
  assert.equal(SIMULATION_EXAMPLES.length, 4);
});
