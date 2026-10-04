import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MOCK_DIAGNOSTIC_FIXTURES,
  MockDiagnosticsProvider,
  RISK_PREVIEW_POLICY,
  SIMULATION_EXAMPLES,
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

test('synthetic fixture provider is deterministic and recognizes English, Roman Urdu, and Urdu names only', () => {
  assert.equal(provider.mode, 'simulation');
  assert.deepEqual(provider.searchSyntheticFixtures('Ali ka internet nahi chal raha').map(({ id }) => id), ['demo-ali-a', 'demo-ali-b']);
  assert.deepEqual(provider.searchSyntheticFixtures("Ahmed's internet is slow").map(({ id }) => id), ['demo-ahmed-a']);
  assert.deepEqual(provider.searchSyntheticFixtures('احمد کی رفتار سست ہے').map(({ id }) => id), ['demo-ahmed-a']);
  assert.deepEqual(provider.searchSyntheticFixtures('فائزہ کا انٹرنیٹ نہیں چل رہا'), []);
  assert.deepEqual(provider.searchSyntheticFixtures(''), []);
  assert.equal(MOCK_DIAGNOSTIC_FIXTURES.length, 3);
});

test('ambiguous matches require an explicit synthetic fixture choice before diagnosis', () => {
  const candidates = provider.searchSyntheticFixtures('Ali Khan has no internet');
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

test('unknown names fail closed and do not reveal or query portal customer records', () => {
  assert.deepEqual(provider.searchSyntheticFixtures('Unknown Person ka net band hai'), []);
  assert.equal(typeof provider.getCustomer, 'undefined');
  assert.equal(typeof provider.lookupCustomer, 'undefined');
  assert.equal(typeof provider.getRouterStatus, 'undefined');
  assert.equal(typeof provider.executeCommand, 'undefined');
});

test('simulated finding cards distinguish mock evidence from unavailable live evidence and never say fixed', () => {
  const result = runSyntheticDiagnostics(provider, 'demo-ahmed-a', "Ahmed's internet is slow");
  assert.equal(result.simulated, true);
  assert.equal(result.source, 'synthetic-local-fixture');
  assert.match(result.diagnosis, /synthetic example/i);
  assert.ok(result.findings.some(({ state }) => state === 'mock'));
  assert.ok(result.findings.some(({ state, value }) => state === 'unavailable' && /no live device/i.test(value)));
  assert.match(result.recommendation, /No fix was applied or verified/);
  assert.doesNotMatch(result.outcome, /fixed|resolved/i);
});

test('complaint input is bounded, fixture selection is validated, and non-mock providers are rejected', () => {
  assert.throws(() => runSyntheticDiagnostics(provider, 'demo-ahmed-a', '  '), /1 to 500/);
  assert.throws(() => runSyntheticDiagnostics(provider, 'demo-ahmed-a', 'x'.repeat(501)), /1 to 500/);
  assert.throws(() => runSyntheticDiagnostics({}, 'demo-ahmed-a', 'Ahmed is slow'), /built-in simulation provider/);
  class ExtendedProvider extends MockDiagnosticsProvider {}
  assert.throws(() => runSyntheticDiagnostics(new ExtendedProvider(), 'demo-ahmed-a', 'Ahmed is slow'), /built-in simulation provider/);
  assert.equal(runSyntheticDiagnostics(provider, 'demo-ahmed-a', '<script>alert(1)</script>').outcome, 'simulated-only', 'complaint text is not interpreted as a command or action');
});

test('result rendering escapes complaint text and keeps technical details collapsed', () => {
  const result = runSyntheticDiagnostics(provider, 'demo-ahmed-a', '<script>alert("x")</script>');
  const markup = renderSyntheticDiagnosticResult(result);
  assert.match(markup, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script|onerror=|onclick=/i);
  assert.match(markup, /<ul class="network-diagnostics__findings"[^>]*><li><article class="network-diagnostics__finding"/);
  assert.match(markup, /<details class="network-diagnostics__technical"><summary>/);
  assert.doesNotMatch(markup, /<details[^>]+\sopen(?:=|\s|>)/i);
  assert.match(markup, /No router or customer change was applied/);
  assert.match(markup, /Changes are disabled/);
  assert.doesNotMatch(markup, /<button|data-action=|Confirm Change/i);
  assert.match(markup, /No shell, command execution, external AI, router API, or database lookup/);
  assert.throws(() => renderSyntheticDiagnosticResult({ ...result, simulated: false }));
});

test('every risk band is preview-only and exposes no action execution capability', () => {
  assert.deepEqual(RISK_PREVIEW_POLICY.map(({ state }) => state), [
    'Unavailable · preview only',
    'Unavailable · preview only',
    'Unavailable · preview only',
  ]);
  assert.ok(RISK_PREVIEW_POLICY.every(({ level }) => /Low|Medium|High/.test(level)));
  assert.doesNotMatch(moduleSource, /function\s+(?:apply|change|update|write|execute|reboot|disconnect|refresh)\w*\s*\(/i);
  assert.doesNotMatch(moduleSource, /fetch\s*\(|XMLHttpRequest|WebSocket|child_process|supabase|routeros|radius|olt/i);
});

test('admin UI gates the lazy-loaded module, shows the live-device boundary, and leaves customer navigation unchanged', () => {
  assert.match(main, /import\('\.\/network-diagnostics\.js'\)/);
  assert.doesNotMatch(main, /import\s+[^;]*network-diagnostics\.js/);
  assert.match(main, /\['#admin-network-diagnostics', 'AI Network Engineer · Simulation'\]/);
  assert.match(main, /context\.kind !== 'admin' \|\| !\['owner', 'admin'\]\.includes\(context\.role\)/);
  assert.match(main, /No live router is connected\./);
  assert.match(main, /does not read portal customer or billing records, query network devices, call an external AI, or apply changes\./);
  assert.match(main, /renderPortalNavigation\('customer'\)/);
  assert.match(main, /This simulator never verifies a real customer issue/);
});

test('diagnostics layout stays keyboard-usable and stacks on mobile in both themes', () => {
  assert.match(moduleSource, /aria-live="polite"/);
  assert.match(moduleSource, /<label for="network-diagnostics-complaint">/);
  assert.match(moduleSource, /<summary>\$\{translated\(t, 'Technical details'\)\}<\/summary>/);
  assert.match(styles, /\.network-diagnostics :is\(button, textarea, summary\):focus-visible/);
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
    'SIMULATION ONLY · NOT LIVE NETWORK DATA', 'Simulated diagnostic result', 'Complaint', 'Synthetic and unavailable diagnostic findings',
    'No router or customer change was applied, and no service restoration was verified.', 'Recommendation', 'Technical details',
    'Evidence source', 'Local synthetic fixture', 'Fixture identifier', 'Live router response',
    'No shell, command execution, external AI, router API, or database lookup is available in this feature.',
    'Changes are disabled', 'This simulator has no router or customer write tools. Nothing is applied, queued, or awaiting confirmation.',
    'Synthetic demo profiles', 'Multiple synthetic demo profiles match. Select one explicitly; no live customer records were searched.',
    'One synthetic demo profile matches. Select it explicitly to see the local example.', 'Select synthetic profile',
    'No synthetic demo profile matched', 'This feature searched only its fictional local fixtures. No live customer lookup was made.',
    'Try a listed example or choose a name included in the synthetic examples.', 'Synthetic complaint examples',
    'Describe a service complaint (English, Roman Urdu, or Urdu)', 'Complaint text is processed locally in this browser and is not saved or sent.',
    'Run simulated check', 'Example added. Submit to run the local simulation.', 'Simulation complete. This is not a live diagnosis.',
    'The local simulation could not produce this example.', 'Enter a complaint between 1 and 500 characters.',
    'No synthetic example matched; live customer lookup was not attempted.', 'Choose a synthetic demo profile to continue.',
    'Low-risk router changes', 'Medium-risk customer or profile changes', 'High-risk network or destructive changes', 'Unavailable · preview only',
    ...SIMULATION_EXAMPLES.map(({ label }) => label),
    ...RISK_PREVIEW_POLICY.flatMap(({ level, state }) => [level, state]),
    ...MOCK_DIAGNOSTIC_FIXTURES.flatMap(({ diagnosis, findings }) => [diagnosis, ...findings.flatMap(({ label, value }) => [label, value])]),
  ];
  for (const copy of translatableCopy) {
    assert.notEqual(translateUi(copy, 'ur-Latn'), copy, `diagnostics copy has Roman Urdu: ${copy}`);
  }
  assert.equal(SIMULATION_EXAMPLES.length, 4);
});
