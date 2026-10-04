import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_SYNTHETIC_IDENTIFIER_LENGTH,
  LIVE_ONLY_DIAGNOSTIC_CHECKS,
  MOCK_DIAGNOSTIC_FIXTURES,
  MockDiagnosticsProvider,
  NETWORK_ACTION_POLICY,
  RISK_PREVIEW_POLICY,
  SIMULATION_EXAMPLES,
  SYNTHETIC_DIAGNOSTIC_STEPS,
  SYNTHETIC_IDENTIFIER_TYPES,
  SYNTHETIC_SYMPTOM_SCENARIOS,
  classifySyntheticComplaint,
  previewNetworkActionPolicy,
  renderNetworkActionPolicyPreview,
  renderSyntheticDiagnosticResult,
  renderSyntheticSymptomDecision,
  runSyntheticDiagnosticSteps,
  runSyntheticDiagnostics,
} from '../src/network-diagnostics.js';
import { translateUi } from '../src/language.js';

const [main, styles, moduleSource] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/network-diagnostics.js', import.meta.url), 'utf8'),
]);

const provider = new MockDiagnosticsProvider();

test('the fixed synthetic fixtures and demo examples are fictional and support three symptom scenarios', () => {
  assert.equal(provider.mode, 'simulation');
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'Ali Khan').map(({ id }) => id), ['demo-ali-a', 'demo-ali-b']);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'Ahmed Raza').map(({ id }) => id), ['demo-ahmed-a']);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'احمد رضا').map(({ id }) => id), ['demo-ahmed-a']);
  assert.equal(MOCK_DIAGNOSTIC_FIXTURES.length, 3);
  assert.deepEqual(SYNTHETIC_SYMPTOM_SCENARIOS.map(({ id }) => id), [
    'no-internet', 'slow-speed-profile-mismatch', 'intermittent-disconnect',
  ]);
  assert.equal(SIMULATION_EXAMPLES.length, 5);
  assert.equal(SIMULATION_EXAMPLES.find(({ id }) => id === 'roman-ali').complaint, 'Ali ka internet nahi chal raha');
  assert.equal(SIMULATION_EXAMPLES.find(({ id }) => id === 'english-ahmed').complaint, "Ahmed's internet is slow");
  assert.equal(SIMULATION_EXAMPLES.find(({ id }) => id === 'urdu-ahmed').complaint, 'احمد کی رفتار سست ہے');
  assert.equal(provider.searchSyntheticFixturesByIdentifier('name', 'فائزہ').length, 0);
});

test('every listed supported phrase maps exactly to its own deterministic scenario', () => {
  for (const scenario of SYNTHETIC_SYMPTOM_SCENARIOS) {
    for (const phrase of scenario.phrases) {
      assert.deepEqual(classifySyntheticComplaint(phrase), {
        state: 'supported',
        scenarioId: scenario.id,
        source: 'deterministic-local-phrase-rules',
        liveCheckPerformed: false,
      }, `phrase should route only to ${scenario.id}: ${phrase}`);
    }
  }
});

test('the controlled engine runs only allowlisted synthetic steps and rejects unknown or live tool identifiers', () => {
  const classification = classifySyntheticComplaint('Ahmed internet slow hai');
  const findings = runSyntheticDiagnosticSteps(provider, 'demo-ahmed-a', classification);
  const permittedIds = SYNTHETIC_DIAGNOSTIC_STEPS.map(({ id }) => id);
  const syntheticFindings = findings.filter(({ state }) => state === 'mock');
  assert.deepEqual([...new Set(syntheticFindings.map(({ stepId }) => stepId))], permittedIds);
  assert.ok(syntheticFindings.every(({ state }) => state === 'mock'));
  assert.ok(syntheticFindings.some(({ label }) => label === 'Synthetic profile fixture'));
  assert.ok(syntheticFindings.some(({ label }) => label === 'Symptom classification'));
  assert.ok(syntheticFindings.some(({ label }) => label === 'Example package'));
  const profileOnly = runSyntheticDiagnosticSteps(provider, 'demo-ahmed-a', classification, ['profile-fixture']);
  assert.deepEqual(profileOnly.filter(({ state }) => state === 'mock').map(({ stepId }) => stepId), ['profile-fixture']);
  assert.deepEqual(profileOnly.filter(({ state }) => state === 'unavailable').map(({ stepId }) => stepId), LIVE_ONLY_DIAGNOSTIC_CHECKS.map(({ id }) => id));
  assert.throws(
    () => runSyntheticDiagnosticSteps(provider, 'demo-ahmed-a', classification, ['execute-router-command']),
    /Unknown synthetic diagnostic step; live network tools are unavailable/,
  );
  assert.throws(
    () => runSyntheticDiagnosticSteps(provider, 'demo-ahmed-a', classification, ['router-status']),
    /Unknown synthetic diagnostic step; live network tools are unavailable/,
  );
  assert.throws(
    () => runSyntheticDiagnosticSteps(provider, 'demo-ahmed-a', { ...classification, liveCheckPerformed: true }),
    /locally supported synthetic symptom classification/,
  );
});

test('every live-only diagnostic check is propagated as unavailable in each synthetic result', () => {
  assert.deepEqual(LIVE_ONLY_DIAGNOSTIC_CHECKS.map(({ id }) => id), [
    'router-status', 'router-management-ip-address', 'subscriber-ip-address', 'wan-link-status', 'dns-resolution',
    'routing-table', 'live-traffic', 'packet-loss', 'measured-throughput', 'live-pppoe-session-history',
  ]);
  for (const [fixtureId, complaint] of [
    ['demo-ali-a', 'Ali ka internet nahi chal raha'],
    ['demo-ahmed-a', 'Ahmed internet slow hai'],
    ['demo-ali-b', 'internet ruk ruk kar chalta hai'],
  ]) {
    const result = runSyntheticDiagnostics(provider, fixtureId, complaint);
    const propagated = result.findings.filter(({ stepId }) => LIVE_ONLY_DIAGNOSTIC_CHECKS.some(({ id }) => id === stepId));
    assert.deepEqual(propagated.map(({ stepId }) => stepId), LIVE_ONLY_DIAGNOSTIC_CHECKS.map(({ id }) => id));
    assert.ok(propagated.every(({ state, synthetic, value }) => state === 'unavailable' && synthetic === true && value.startsWith('Unavailable ·')));
    assert.ok(result.findings.every(({ synthetic }) => synthetic === true));
    const markup = renderSyntheticDiagnosticResult(result);
    assert.match(markup, /Synthetic · unavailable/);
    for (const { label } of LIVE_ONLY_DIAGNOSTIC_CHECKS) assert.ok(markup.includes(`<h4>${label}</h4>`), label);
    assert.match(markup, /SIMULATION ONLY · NOT LIVE NETWORK DATA/);
  }
});

test('English, Roman Urdu, and Urdu-script examples route to no-internet, slow-speed, and intermittent scenarios', () => {
  const cases = [
    ['No internet at all', 'no-internet'],
    ['Ali ka internet nahi chal raha', 'no-internet'],
    ['انٹرنیٹ بند ہے', 'no-internet'],
    ["Ahmed's internet is slow", 'slow-speed-profile-mismatch'],
    ['net slow hai', 'slow-speed-profile-mismatch'],
    ['رفتار سست ہے', 'slow-speed-profile-mismatch'],
    ['The internet keeps disconnecting', 'intermittent-disconnect'],
    ['internet ruk ruk kar chalta hai', 'intermittent-disconnect'],
    ['نیٹ رک رک کر چلتا ہے', 'intermittent-disconnect'],
  ];
  for (const [complaint, scenarioId] of cases) {
    const classification = classifySyntheticComplaint(complaint);
    assert.equal(classification.state, 'supported', complaint);
    assert.equal(classification.scenarioId, scenarioId, complaint);
    assert.equal(classification.source, 'deterministic-local-phrase-rules');
    assert.equal(classification.liveCheckPerformed, false);
  }
});

test('unsupported or ambiguous complaints fail closed and explicitly say no real check ran', () => {
  const unsupported = classifySyntheticComplaint('The router lamp is red and web pages time out');
  assert.deepEqual(unsupported, {
    state: 'not-covered', scenarioId: null,
    source: 'deterministic-local-phrase-rules', liveCheckPerformed: false,
  });
  const ambiguous = classifySyntheticComplaint('The internet is slow and keeps disconnecting');
  assert.deepEqual(ambiguous, {
    state: 'ambiguous', scenarioId: null,
    source: 'deterministic-local-phrase-rules', liveCheckPerformed: false,
  });
  assert.match(renderSyntheticSymptomDecision(unsupported), /Not covered by the demo/);
  assert.match(renderSyntheticSymptomDecision(unsupported), /no real network check was run/);
  assert.match(renderSyntheticSymptomDecision(unsupported), /Not covered · no check run/);
  assert.match(renderSyntheticSymptomDecision(ambiguous), /Ambiguous symptom description/);
  assert.match(renderSyntheticSymptomDecision(ambiguous), /Ambiguous · no check run/);
  assert.match(renderSyntheticSymptomDecision(ambiguous), /Deterministic local phrase rules/);
  assert.throws(() => renderSyntheticSymptomDecision({ ...unsupported, liveCheckPerformed: true }), /locally classified no-check state/);
  assert.throws(() => runSyntheticDiagnostics(provider, 'demo-ahmed-a', 'The router lamp is red'), /not covered by the demo or is ambiguous; no real check was run/);
  assert.throws(() => runSyntheticDiagnostics(provider, 'demo-ahmed-a', 'Internet is slow and keeps disconnecting'), /not covered by the demo or is ambiguous; no real check was run/);
});

test('phrase ambiguity is conservative and words embedded in unrelated words do not trigger a match', () => {
  for (const complaint of [
    'Internet is slow, then the connection keeps dropping',
    'No internet; the speed is slow',
    'net band hai aur internet slow hai',
  ]) assert.equal(classifySyntheticComplaint(complaint).state, 'ambiguous', complaint);
  for (const complaint of [
    'The internet is slowish',
    'A disconnecting router lamp is blinking',
    'The network is down but not the internet connection',
  ]) assert.equal(classifySyntheticComplaint(complaint).state, 'not-covered', complaint);
});

test('exact synthetic identity matching preserves explicit multi-match selection', () => {
  assert.deepEqual(SYNTHETIC_IDENTIFIER_TYPES.map(({ value }) => value), [
    'name', 'username', 'pppoeUsername', 'customerId', 'phonePlaceholder', 'accountNumber',
  ]);
  for (const fixture of MOCK_DIAGNOSTIC_FIXTURES) {
    for (const { value: identifierType } of SYNTHETIC_IDENTIFIER_TYPES.filter(({ value }) => value !== 'name')) {
      const identifier = fixture.demoIdentifiers[identifierType];
      assert.deepEqual(provider.searchSyntheticFixturesByIdentifier(identifierType, identifier).map(({ id }) => id), [fixture.id]);
      assert.deepEqual(provider.searchSyntheticFixturesByIdentifier(identifierType, `prefix-${identifier}`), []);
      assert.deepEqual(provider.searchSyntheticFixturesByIdentifier(identifierType, `${identifier}-suffix`), []);
      assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', identifier), []);
    }
  }
  assert.match(MOCK_DIAGNOSTIC_FIXTURES[0].demoIdentifiers.phonePlaceholder, /^DEMO-PHONE-\d+-NOT-DIALABLE$/);
  assert.equal(provider.searchSyntheticFixturesByIdentifier('name', 'Ali Khan').length, 2);
  assert.equal(provider.searchSyntheticFixturesByIdentifier('name', 'Ali').length, 2);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'Ali Khan junior'), []);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('name', 'Not Ali Khan'), []);
  assert.throws(() => runSyntheticDiagnostics(provider, 'not-a-listed-fixture', 'internet is slow'), /Choose a listed synthetic fixture/);
});

test('selected profile identity never chooses the scenario; complaint phrases do', () => {
  const selectedAli = runSyntheticDiagnostics(provider, 'demo-ali-b', 'Ahmed internet slow hai');
  assert.equal(selectedAli.fixtureLabel, 'DEMO-ALI-B');
  assert.equal(selectedAli.symptomScenarioId, 'slow-speed-profile-mismatch');
  assert.match(selectedAli.diagnosis, /Fictional slow-speed\/profile-mismatch scenario/);
  const selectedAhmed = runSyntheticDiagnostics(provider, 'demo-ahmed-a', 'Ali ka internet nahi chal raha');
  assert.equal(selectedAhmed.fixtureLabel, 'DEMO-AHMED-A');
  assert.equal(selectedAhmed.symptomScenarioId, 'no-internet');
  assert.match(selectedAhmed.diagnosis, /Fictional no-internet scenario/);
});

test('all simulation output carries fictional source, state, no-change, and no-verification labels', () => {
  for (const [fixtureId, complaint, scenarioId] of [
    ['demo-ali-a', 'Ali ka internet nahi chal raha', 'no-internet'],
    ['demo-ahmed-a', 'Ahmed internet slow hai', 'slow-speed-profile-mismatch'],
    ['demo-ali-b', 'internet ruk ruk kar chalta hai', 'intermittent-disconnect'],
  ]) {
    const result = runSyntheticDiagnostics(provider, fixtureId, complaint);
    assert.equal(result.state, 'simulated-only');
    assert.equal(result.outcome, 'simulated-only');
    assert.equal(result.symptomScenarioId, scenarioId);
    assert.equal(result.source, 'fictional-local-symptom-scenario');
    assert.equal(result.identitySource, 'fictional-local-profile-fixture');
    assert.equal(result.classificationSource, 'deterministic-local-phrase-rules');
    assert.equal(result.simulated, true);
    assert.equal(result.fictional, true);
    assert.equal(result.liveCheckPerformed, false);
    assert.equal(result.changesApplied, false);
    assert.equal(result.serviceVerified, false);
    assert.ok(result.findings.every(({ synthetic }) => synthetic === true));
    assert.ok(result.findings.every(({ state, value }) => (
      state === 'mock' ? value.length > 0 : state === 'unavailable' && /^Unavailable ·/.test(value)
    )));
    const markup = renderSyntheticDiagnosticResult(result);
    assert.match(markup, /SIMULATION ONLY · NOT LIVE NETWORK DATA/);
    assert.match(markup, /Symptom scenario/);
    assert.match(markup, /Output state/);
    assert.match(markup, /Fictional local symptom scenario/);
    assert.match(markup, /Deterministic local phrase rules/);
    assert.match(markup, /No router or customer change was applied, and no service restoration was verified/);
    assert.doesNotMatch(markup, /<button|data-action=|Confirm Change/i);
  }
  assert.deepEqual(RISK_PREVIEW_POLICY.map(({ state }) => state), [
    'Unavailable · preview only', 'Unavailable · preview only', 'Unavailable · preview only',
  ]);
  assert.ok(RISK_PREVIEW_POLICY.every(({ level }) => /Low|Medium|High/.test(level)));
});

test('every future network action category has an explicit risk classification and unknown actions fail closed', () => {
  assert.deepEqual(NETWORK_ACTION_POLICY.map(({ id, risk, label }) => ({ id, risk, label })), [
    { id: 'low-risk-router-changes', risk: 'Low', label: 'Low-risk router changes' },
    { id: 'medium-risk-customer-profile-changes', risk: 'Medium', label: 'Medium-risk customer or profile changes' },
    { id: 'high-risk-network-destructive-changes', risk: 'High', label: 'High-risk network or destructive changes' },
  ]);
  assert.deepEqual(RISK_PREVIEW_POLICY.map(({ state }) => state), NETWORK_ACTION_POLICY.map(() => 'Unavailable · preview only'));
  for (const { id, risk } of NETWORK_ACTION_POLICY) {
    const preview = previewNetworkActionPolicy(id);
    assert.equal(preview.risk, risk);
    assert.equal(preview.status, 'unavailable');
    assert.equal(preview.readyForHumanReview, false);
    assert.equal(preview.executionPermitted, false);
  }
  assert.throws(() => previewNetworkActionPolicy('execute-router-command'), /Unknown network action category/);
  assert.throws(() => previewNetworkActionPolicy(''), /Unknown network action category/);
});

test('low risk needs future Admin enable; medium and high risk need exact per-action confirmation', () => {
  const connectedFuturePreview = { routerConnected: true, adapterConnected: true, adminEnabled: true };
  const [low, medium, high] = NETWORK_ACTION_POLICY;
  const lowPreview = previewNetworkActionPolicy(low.id, connectedFuturePreview);
  assert.equal(lowPreview.status, 'review-ready-simulation-only');
  assert.equal(lowPreview.requiresActionConfirmation, false);
  assert.equal(lowPreview.executionPermitted, false);

  const lowWithoutAdminEnable = previewNetworkActionPolicy(low.id, { routerConnected: true, adapterConnected: true });
  assert.ok(lowWithoutAdminEnable.blockers.includes('future-admin-enable-required'));
  for (const action of [medium, high]) {
    const unconfirmed = previewNetworkActionPolicy(action.id, connectedFuturePreview);
    assert.equal(unconfirmed.requiresActionConfirmation, true);
    assert.ok(unconfirmed.blockers.includes('explicit-action-confirmation-required'));
    const wrongActionConfirmation = previewNetworkActionPolicy(action.id, {
      ...connectedFuturePreview,
      confirmedActionId: low.id,
    });
    assert.ok(wrongActionConfirmation.blockers.includes('explicit-action-confirmation-required'));
    const confirmed = previewNetworkActionPolicy(action.id, {
      ...connectedFuturePreview,
      confirmedActionId: action.id,
    });
    assert.equal(confirmed.confirmedForThisAction, true);
    assert.equal(confirmed.readyForHumanReview, true);
    assert.equal(confirmed.status, 'review-ready-simulation-only');
    assert.equal(confirmed.executionPermitted, false);
  }
  const highConfirmedButAutomatic = previewNetworkActionPolicy(high.id, {
    ...connectedFuturePreview,
    confirmedActionId: high.id,
    automaticExecution: true,
  });
  assert.ok(highConfirmedButAutomatic.blockers.includes('high-risk-never-automatic'));
  assert.equal(highConfirmedButAutomatic.executionPermitted, false);
});

test('every risk level rejects disconnected routers or a missing approved adapter independently', () => {
  for (const { id } of NETWORK_ACTION_POLICY) {
    const disconnected = previewNetworkActionPolicy(id, {
      routerConnected: false,
      adapterConnected: true,
      adminEnabled: true,
      confirmedActionId: id,
    });
    assert.ok(disconnected.blockers.includes('router-not-connected'), id);
    assert.equal(disconnected.executionPermitted, false);
    const noAdapter = previewNetworkActionPolicy(id, {
      routerConnected: true,
      adapterConnected: false,
      adminEnabled: true,
      confirmedActionId: id,
    });
    assert.ok(noAdapter.blockers.includes('adapter-unavailable'), id);
    assert.equal(noAdapter.executionPermitted, false);
    const current = previewNetworkActionPolicy(id);
    assert.ok(current.blockers.includes('router-not-connected'), id);
    assert.ok(current.blockers.includes('adapter-unavailable'), id);
  }
});

test('Admin risk preview explains current blockers and future confirmations without action controls', () => {
  const markup = renderNetworkActionPolicyPreview();
  assert.match(markup, /Future action policy · simulation only/);
  assert.match(markup, /no approved adapter is available/);
  assert.match(markup, /there are no live customers/);
  assert.match(markup, /does not approve, queue, or apply a real action/);
  assert.match(markup, /Future requirement: an Admin must enable this class and an approved adapter must be connected/);
  assert.match(markup, /explicit Admin confirmation for this specific action/);
  assert.match(markup, /must never run automatically/);
  assert.doesNotMatch(markup, /<button|<form|data-action=/i);
});

test('result rendering escapes input and rejects results without explicit no-change guarantees', () => {
  const result = runSyntheticDiagnostics(provider, 'demo-ahmed-a', '<script>alert("x")</script> Ahmed internet is slow');
  const markup = renderSyntheticDiagnosticResult({ ...result, displayName: '<img src=x onerror=alert(1)>' });
  assert.match(markup, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(markup, /<(?:script|img)\b|<[^>]+\sonerror=/i);
  assert.match(markup, /<ul class="network-diagnostics__findings"[^>]*><li><article class="network-diagnostics__finding"/);
  assert.match(markup, /<details class="network-diagnostics__technical"><summary>/);
  assert.doesNotMatch(markup, /<details[^>]+\sopen(?:=|\s|>)/i);
  assert.throws(() => renderSyntheticDiagnosticResult({ ...result, simulated: false }));
  assert.throws(() => renderSyntheticDiagnosticResult({ ...result, fictional: false }));
  assert.throws(() => renderSyntheticDiagnosticResult({ ...result, changesApplied: true }));
  assert.throws(() => renderSyntheticDiagnosticResult({ ...result, serviceVerified: true }));
  assert.throws(() => renderSyntheticDiagnosticResult({ ...result, findings: result.findings.map((finding, index) => index === 0 ? { ...finding, synthetic: false } : finding) }), /explicitly synthetic/);
});

test('bounds, malformed identities, and provider restrictions remain in force', () => {
  assert.equal(MAX_SYNTHETIC_IDENTIFIER_LENGTH, 120);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('username', 'x'.repeat(121)), []);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('phonePlaceholder', '+923001234567'), []);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('customer', 'DEMO-CUSTOMER-001'), []);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('username', ''), []);
  assert.deepEqual(provider.searchSyntheticFixturesByIdentifier('username', null), []);
  assert.throws(() => runSyntheticDiagnostics(provider, 'demo-ahmed-a', '  '), /1 to 500/);
  assert.throws(() => runSyntheticDiagnostics(provider, 'demo-ahmed-a', 'internet is slow '.repeat(32)), /1 to 500/);
  assert.throws(() => runSyntheticDiagnostics({}, 'demo-ahmed-a', 'internet is slow'), /built-in simulation provider/);
  class ExtendedProvider extends MockDiagnosticsProvider {}
  assert.throws(() => runSyntheticDiagnostics(new ExtendedProvider(), 'demo-ahmed-a', 'internet is slow'), /built-in simulation provider/);
  assert.equal(typeof provider.getCustomer, 'undefined');
  assert.equal(typeof provider.lookupCustomer, 'undefined');
  assert.equal(typeof provider.getRouterStatus, 'undefined');
  assert.equal(typeof provider.executeCommand, 'undefined');
  assert.deepEqual(Object.getOwnPropertyNames(MockDiagnosticsProvider.prototype).sort(), [
    'constructor', 'getSyntheticEvidence', 'searchSyntheticFixturesByIdentifier',
  ]);
});

test('module has no live data, network, persistence, router, provider, AI, or customer-action call path', () => {
  assert.doesNotMatch(moduleSource, /function\s+(?:apply|change|write|execute|reboot|disconnect|refresh)\w*\s*\(/i);
  assert.doesNotMatch(moduleSource, /fetch\s*\(|XMLHttpRequest|WebSocket|child_process|supabase|routeros|radius|olt|indexedDB|localStorage|sessionStorage|\.rpc\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(/i);
  assert.match(moduleSource, /deterministic-local-phrase-rules/);
  assert.match(moduleSource, /fictional-local-symptom-scenario/);
  assert.match(moduleSource, /liveCheckPerformed: false/);
  assert.match(moduleSource, /changesApplied: false/);
  assert.match(moduleSource, /serviceVerified: false/);
  assert.match(moduleSource, /executionPermitted: false/);
  assert.doesNotMatch(moduleSource, /fetch\s*\(|XMLHttpRequest|WebSocket|child_process|supabase|routeros|radius|indexedDB|localStorage|sessionStorage|\.rpc\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(/i);
});

test('Admin UI remains role-gated and the simulator module stays lazy with demo-only input warnings', () => {
  assert.match(main, /import\('\.\/network-diagnostics\.js'\)/);
  assert.doesNotMatch(main, /import\s+[^;]*network-diagnostics\.js/);
  assert.match(main, /\['#admin-network-diagnostics', 'AI Network Engineer · Simulation'\]/);
  assert.match(main, /context\.kind !== 'admin' \|\| !\['owner', 'admin'\]\.includes\(context\.role\)/);
  assert.match(main, /No live router is connected\./);
  assert.match(main, /does not read portal customer or billing records, query network devices, call an external AI, or apply changes\./);
  assert.match(main, /renderPortalNavigation\('customer'\)/);
  assert.match(main, /This simulator never verifies a real customer issue/);
  assert.match(moduleSource, /Synthetic demo identifier type/);
  assert.match(moduleSource, /Never enter a real customer name, login, PPPoE credential, account number, or phone number/);
  assert.match(moduleSource, /Inputs stay local and are not saved or sent/);
  assert.match(moduleSource, /data-synthetic-fixture=/);
  assert.match(moduleSource, /Choose a synthetic demo profile to continue/);
  assert.match(moduleSource, /Complaint is not covered by the demo; no real check was run/);
});

test('diagnostics is keyboard usable, responsive, state-labeled, and translated for Roman Urdu', () => {
  assert.match(moduleSource, /aria-live="polite"/);
  assert.match(moduleSource, /<label for="network-diagnostics-identifier-type">/);
  assert.match(moduleSource, /<label for="network-diagnostics-identifier">/);
  assert.match(moduleSource, /<label for="network-diagnostics-complaint">/);
  assert.match(styles, /\.network-diagnostics :is\(button, input, select, textarea, summary\):focus-visible/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.network-diagnostics__findings \{ grid-template-columns: 1fr;/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.network-diagnostics__examples \{ display: grid; grid-template-columns: 1fr;/);
  assert.match(styles, /:root\[data-theme="dark"\] \.network-diagnostics__notice/);
  assert.match(styles, /\.network-diagnostics__example, \.network-diagnostics__match \{ min-height: 44px;/);
  assert.match(styles, /\.network-diagnostics__symptom-state \{ border-color:/);
  assert.equal(translateUi('No live router is connected.', 'ur-Latn'), 'Koi live router connected nahin hai.');
  assert.equal(translateUi('Run simulated check', 'ur-Latn'), 'Simulated jaanch chalayein');
  assert.equal(translateUi('Future action policy · simulation only', 'ur-Latn'), 'Mustaqbil ke actions ki policy · sirf simulation');
  const translatedCopy = [
    'Symptom scenario', 'No internet / disconnected', 'Slow speed / profile mismatch', 'Intermittent / disconnect',
    'Ambiguous symptom description', 'Not covered by the demo', 'The demo needs one supported symptom group. Clarify the complaint; no real network check was run.',
    'This complaint is not covered by the demo; no real network check was run.', 'Ambiguous complaint; no real check was run.',
    'Complaint is not covered by the demo; no real check was run.', 'Output state', 'Ambiguous · no check run',
    'Not covered · no check run', 'Decision source', 'Deterministic local phrase rules', 'Fictional local symptom scenario',
    'Classification source', 'Identity source', 'Fictional local profile fixture',
    ...SYNTHETIC_DIAGNOSTIC_STEPS.map(({ label }) => label),
    ...LIVE_ONLY_DIAGNOSTIC_CHECKS.flatMap(({ label, value }) => [label, value]), 'Synthetic · unavailable',
    ...SYNTHETIC_SYMPTOM_SCENARIOS.flatMap(({ label, diagnosis, findings }) => [label, diagnosis, ...findings.flatMap(({ label: findingLabel, value }) => [findingLabel, value])]),
    ...SIMULATION_EXAMPLES.map(({ label }) => label),
    'Future action policy · simulation only',
    'No router is connected, no approved adapter is available, and there are no live customers. Every action class is unavailable today.',
    'A confirmation shown or tested here is only a simulation; it does not approve, queue, or apply a real action.',
    ...NETWORK_ACTION_POLICY.map(({ futureRequirement }) => futureRequirement),
  ];
  for (const copy of translatedCopy) assert.notEqual(translateUi(copy, 'ur-Latn'), copy, `diagnostics copy has Roman Urdu: ${copy}`);
});
