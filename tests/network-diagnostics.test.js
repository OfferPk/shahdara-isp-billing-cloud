import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_RECENT_SIMULATIONS,
  MAX_SYNTHETIC_IDENTIFIER_LENGTH,
  LIVE_ONLY_DIAGNOSTIC_CHECKS,
  LIVE_NETWORK_CAPABILITIES,
  MOCK_DIAGNOSTIC_FIXTURES,
  MockDiagnosticsProvider,
  NETWORK_ACTION_POLICY,
  RISK_PREVIEW_POLICY,
  SIMULATION_EXAMPLES,
  SYNTHETIC_DIAGNOSTIC_STEPS,
  SYNTHETIC_IDENTIFIER_TYPES,
  SYNTHETIC_SYMPTOM_SCENARIOS,
  classifySyntheticComplaint,
  createRecentSimulationHistory,
  previewNetworkActionPolicy,
  renderNetworkCapabilityOverview,
  renderNetworkActionPolicyPreview,
  renderRecentSimulations,
  renderSyntheticDiagnosticResult,
  renderSyntheticSymptomDecision,
  runSyntheticDiagnosticSteps,
  runSyntheticDiagnostics,
} from '../src/network-diagnostics.js';
import {
  SYNTHETIC_NETWORK_COMPLAINTS,
  groupSyntheticComplaintRecords,
  renderSyntheticIncidentCorrelationDemo,
} from '../src/network-incident-correlation.js';
import { translateUi } from '../src/language.js';

const [main, styles, moduleSource] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/network-diagnostics.js', import.meta.url), 'utf8'),
]);
const correlationSource = await readFile(new URL('../src/network-incident-correlation.js', import.meta.url), 'utf8');

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

test('capability overview separates unavailable live state from the synthetic-only simulator without invented metrics', () => {
  assert.deepEqual(LIVE_NETWORK_CAPABILITIES.map(({ id, label, value }) => ({ id, label, value })), [
    { id: 'device-connection', label: 'Device connection', value: 'Not connected' },
    { id: 'network-health', label: 'Live network health', value: 'Unavailable' },
    { id: 'active-pppoe-sessions', label: 'Active PPPoE sessions', value: 'Unavailable' },
    { id: 'current-issues', label: 'Live issues', value: 'Unavailable' },
    { id: 'resolved-today', label: 'Resolved today', value: 'Unavailable' },
    { id: 'admin-attention', label: 'Admin attention', value: 'Unavailable' },
    { id: 'alerts', label: 'Alerts', value: 'Unavailable' },
    { id: 'network-actions', label: 'Network actions', value: 'Unavailable' },
  ]);
  const markup = renderNetworkCapabilityOverview();
  const romanUrdu = renderNetworkCapabilityOverview((copy) => translateUi(copy, 'ur-Latn'));
  assert.match(markup, /aria-labelledby="network-diagnostics-capabilities-title"/);
  assert.match(markup, /data-state-source="live" aria-labelledby="network-diagnostics-live-state-title"/);
  assert.match(markup, /data-state-source="synthetic" aria-labelledby="network-diagnostics-synthetic-state-title"/);
  for (const { label, value } of LIVE_NETWORK_CAPABILITIES) {
    assert.ok(markup.includes(`<dt>${label}</dt><dd>${value}</dd>`), `${label} reports ${value}`);
  }
  assert.match(markup, /<dt>Simulator<\/dt><dd>Available · synthetic only<\/dd>/);
  assert.match(markup, /no live customer base for diagnostics/);
  assert.match(markup, /No live monitoring or AI automation is running/);
  assert.match(markup, /never stands in for live network status/);
  const visibleText = markup.replace(/<[^>]*>/g, '');
  assert.doesNotMatch(visibleText, /\d|last updated|last checked|last synced|Ali Khan|Ahmed Raza|SIM-DEVICE|demo-/i);
  assert.doesNotMatch(markup, /<button\b|<form\b|data-action=/i);
  assert.match(main, /import\('\.\/network-diagnostics\.js'\)/);
  assert.doesNotMatch(main, /network-diagnostics__capabilities/);
  assert.match(styles, /\.network-diagnostics__capability-group dd \{[^}]*overflow-wrap: anywhere;/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.network-diagnostics__capability-groups \{ grid-template-columns: 1fr;/);
  assert.match(styles, /@media \(max-width: 460px\)[\s\S]*?\.network-diagnostics__capability-group dl \{ grid-template-columns: 1fr;/);
  for (const copy of [
    'Network capability overview', 'No network device is connected and there is no live customer base for diagnostics. Live statuses are unavailable, not measured counts. No live monitoring or AI automation is running.',
    'Live network state', 'Device connection', 'Not connected', 'Live network health', 'Active PPPoE sessions',
    'Live issues', 'Resolved today', 'Admin attention', 'Alerts', 'Network actions',
    'Synthetic demo state · separate from live network', 'Simulator', 'Available · synthetic only',
    'The local simulator uses fictional examples only. Its state never stands in for live network status.',
  ]) assert.notEqual(translateUi(copy, 'ur-Latn'), copy, `capability overview copy has Roman Urdu: ${copy}`);
  assert.match(romanUrdu, /Khayali demo ki halat · live network se alag/);
  assert.match(romanUrdu, /Device ka rabta/);
  assert.match(romanUrdu, /Dastiyab · sirf khayali/);
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

test('the exported complaint classifier rejects oversized raw input before trimming and preserves Unicode normalization', () => {
  const exactLimitComplaint = `internet is slow${' '.repeat(500 - 'internet is slow'.length)}`;
  assert.equal(exactLimitComplaint.length, 500);
  assert.equal(classifySyntheticComplaint(exactLimitComplaint).state, 'supported');
  assert.equal(classifySyntheticComplaint('ｉｎｔｅｒｎｅｔ　ｉｓ　ｓｌｏｗ').scenarioId, 'slow-speed-profile-mismatch');
  assert.throws(() => classifySyntheticComplaint(`${' '.repeat(501)}internet is slow`), /1 to 500/);
  assert.throws(() => classifySyntheticComplaint({ toString: () => 'internet is slow' }), /plain text/);
  assert.throws(() => runSyntheticDiagnostics(provider, 'demo-ahmed-a', null), /plain text/);
  assert.match(moduleSource, /rawComplaint\.length <= MAX_COMPLAINT_LENGTH[\s\S]*?rawComplaint\.trim\(\)/);
});

test('recent simulation history retains only allowlisted metadata, never complaint or customer identifiers', () => {
  const result = runSyntheticDiagnostics(provider, 'demo-ahmed-a', 'Ahmed internet slow hai');
  const timestamp = new Date(2026, 9, 5, 14, 32, 0);
  const history = createRecentSimulationHistory();
  const [entry] = history.record({
    ...result,
    complaint: 'PRIVATE-COMPLAINT-MUST-NOT-BE-STORED',
    phone: 'PRIVATE-PHONE-MUST-NOT-BE-STORED',
    pppoeUsername: 'PRIVATE-PPPOE-MUST-NOT-BE-STORED',
    accountNumber: 'PRIVATE-ACCOUNT-MUST-NOT-BE-STORED',
    customerId: 'PRIVATE-CUSTOMER-ID-MUST-NOT-BE-STORED',
    customerData: { name: 'PRIVATE-CUSTOMER-MUST-NOT-BE-STORED' },
  }, timestamp);
  assert.deepEqual(Object.keys(entry), ['fixtureId', 'scenarioId', 'status', 'displayTimestamp']);
  assert.deepEqual(entry, {
    fixtureId: 'demo-ahmed-a',
    scenarioId: 'slow-speed-profile-mismatch',
    status: 'simulated-only',
    displayTimestamp: timestamp.toLocaleString(),
  });
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(Object.isFrozen(history.list()), true);
  assert.doesNotMatch(JSON.stringify(entry), /PRIVATE-|Ahmed internet slow hai|Ahmed Raza|SIM\.PPPOE|DEMO-CUSTOMER/);
  assert.throws(() => history.record({ ...result, changesApplied: true }, timestamp), /completed fictional simulation/);
  assert.throws(() => history.record(result, 'not-a-date'), /valid local display timestamp/);
});

test('recent simulation history is capped at 10, clear affects only local memory, and a new mount starts empty', () => {
  assert.equal(MAX_RECENT_SIMULATIONS, 10);
  const result = runSyntheticDiagnostics(provider, 'demo-ali-a', 'Ali ka internet nahi chal raha');
  const history = createRecentSimulationHistory();
  const timestamps = Array.from({ length: 11 }, (_, index) => new Date(2026, 9, 5, 14, index));
  for (const timestamp of timestamps) history.record(result, timestamp);
  assert.equal(history.list().length, 10);
  assert.equal(history.list()[0].displayTimestamp, timestamps[10].toLocaleString());
  assert.equal(history.list()[9].displayTimestamp, timestamps[1].toLocaleString());
  assert.deepEqual(history.clear(), []);
  assert.deepEqual(history.list(), []);
  assert.deepEqual(createRecentSimulationHistory().list(), [], 'a fresh panel instance has no persisted history');
});

test('recent simulations are explicitly not an action log and expose a local clear control with safe accessible status', () => {
  const result = runSyntheticDiagnostics(provider, 'demo-ahmed-a', 'Ahmed internet slow hai');
  const history = createRecentSimulationHistory();
  const markup = renderRecentSimulations(history.record(result, new Date(2026, 9, 5, 14, 32, 0)));
  assert.match(markup, /Recent simulations/);
  assert.match(markup, /Simulation history only — no actions or changes occurred/);
  assert.match(markup, /data-clear-simulation-history="true"/);
  assert.match(markup, /Clear history/);
  assert.match(markup, /demo-ahmed-a/);
  assert.match(markup, /slow-speed-profile-mismatch/);
  assert.match(markup, /<dt>Result<\/dt><dd>Simulated only<\/dd>/);
  assert.doesNotMatch(markup, /action log|attempted|succeeded|customer|phone|pppoe|account/i);
  assert.match(moduleSource, /const recentSimulationHistory = createRecentSimulationHistory\(\)/);
  assert.match(moduleSource, /historyRoot\.innerHTML = renderRecentSimulations\(recentSimulationHistory\.list\(\), t\)/);
  assert.match(moduleSource, /recentSimulationHistory\.clear\(\)/);
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
  const requestStart = main.indexOf('function requestNetworkDiagnostics()');
  const requestEnd = main.indexOf('\n  function requestNetworkKnowledge()', requestStart);
  const request = main.slice(requestStart, requestEnd);
  assert.ok(requestStart >= 0 && requestEnd > requestStart, 'diagnostic request handler is present');
  const preLoadGuard = request.indexOf("context?.kind !== 'admin' || !['owner', 'admin'].includes(context.role)");
  const lazyImport = request.indexOf('loadNetworkDiagnosticsModule()');
  const postLoadGuard = request.indexOf("pageState.context?.kind !== 'admin' || !['owner', 'admin'].includes(pageState.context.role)");
  const mount = request.indexOf('mountNetworkDiagnosticsPanel(section, { t })');
  assert.ok(preLoadGuard >= 0 && preLoadGuard < lazyImport, 'Admin/owner guard precedes the dynamic import');
  assert.ok(postLoadGuard > lazyImport && postLoadGuard < mount, 'role is rechecked after import and before mount');
  const bindStart = main.indexOf('function bindNetworkDiagnostics(context)');
  const bindEnd = main.indexOf('\n  function requestDashboardAnalytics()', bindStart);
  const binding = main.slice(bindStart, bindEnd);
  assert.match(binding, /context\.kind !== 'admin' \|\| !\['owner', 'admin'\]\.includes\(context\.role\)/);
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
  assert.match(moduleSource, /import \{ renderSyntheticIncidentCorrelationDemo \} from '\.\/network-incident-correlation\.js'/);
  assert.match(moduleSource, /renderNetworkActionPolicyPreview\(t\)\}\$\{renderSyntheticIncidentCorrelationDemo\(t\)\}/);
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
    'Recent simulations', 'Simulation history only — no actions or changes occurred',
    'Only this view’s in-memory simulation history is cleared.', 'No simulations are in this view yet.',
    'Clear history', 'Clear recent simulations', 'Simulation history cleared from this view.',
    'Fixture', 'Scenario', 'Result', 'Displayed', 'Simulated only',
    'Simulation only · no live network/customer data checked',
    'This fixed demo is not an automatic watcher and does not load real complaints.',
    'Network-wide complaint grouping · synthetic demo',
    'This illustration groups only fictional sample records with the same fake device, interface, and pre-labeled symptom code inside a ten-minute sample window. A shared pattern does not prove a cause.',
    'Three synthetic complaint samples meet this demo grouping rule; one unrelated synthetic sample stays separate.',
    'Fixed multilingual sample records', 'Fictional sample complaints in English, Roman Urdu, and Urdu',
    'Synthetic sample record', 'Fake device', 'Fake interface', 'Sample symptom code', 'Sample minute offset',
    'minutes into this fixed demo', 'Possible incident grouping', 'Possible shared-dependency pattern · demo only',
    'fictional sample records', 'share the same fake device, interface, and symptom code within ten sample minutes.',
    'Shared fake device', 'Shared fake interface', 'Shared sample symptom', 'Sample record IDs',
    'This illustrates a possible common-cause incident grouping, not a confirmed cause or a real incident.',
    'Live network findings · unavailable', 'Unavailable live network checks', 'Router finding', 'WAN finding',
    'DNS finding', 'OLT finding', 'Unavailable · no live network data was checked',
    'No synthetic group met the minimum shared-evidence rule.', 'Unrelated sample · not grouped',
    'Its fake dependency and symptom do not match the shared demo group; it is not included.',
    'Synthetic incident groups', 'No incident was created, nothing was saved, and no remediation or network action is offered.',
    ...NETWORK_ACTION_POLICY.map(({ futureRequirement }) => futureRequirement),
    'Network capability overview', 'No network device is connected and there is no live customer base for diagnostics. Live statuses are unavailable, not measured counts. No live monitoring or AI automation is running.',
    'Live network state', 'Device connection', 'Not connected', 'Live network health', 'Active PPPoE sessions',
    'Live issues', 'Resolved today', 'Admin attention', 'Alerts', 'Network actions',
    'Synthetic demo state · separate from live network', 'Simulator', 'Available · synthetic only',
    'The local simulator uses fictional examples only. Its state never stands in for live network status.',
  ];
  for (const copy of translatedCopy) assert.notEqual(translateUi(copy, 'ur-Latn'), copy, `diagnostics copy has Roman Urdu: ${copy}`);
});

test('synthetic incident grouping requires three records with the same fake device, interface, and symptom inside the sample window', () => {
  const result = groupSyntheticComplaintRecords(SYNTHETIC_NETWORK_COMPLAINTS);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].groupId, 'SIM-GROUP-001');
  assert.deepEqual(result.groups[0].complaintIds, ['SIM-COMPLAINT-001', 'SIM-COMPLAINT-002', 'SIM-COMPLAINT-003']);
  assert.equal(result.groups[0].deviceId, 'SIM-DEVICE-DEMO-A');
  assert.equal(result.groups[0].interfaceId, 'SIM-IFACE-DEMO-UPLINK-A');
  assert.equal(result.groups[0].symptomCode, 'DEMO-INTERMITTENT-DROPS');
  assert.equal(result.groups[0].sampleSpanMinutes, 8);
  assert.deepEqual(result.ungroupedComplaintIds, ['SIM-COMPLAINT-004']);
  assert.equal(groupSyntheticComplaintRecords(SYNTHETIC_NETWORK_COMPLAINTS.slice(0, 2)).groups.length, 0, 'two similar reports remain below the three-record threshold');
});

test('unrelated, missing-dependency, different-symptom, and out-of-window demo records do not group', () => {
  const shared = SYNTHETIC_NETWORK_COMPLAINTS.slice(0, 3);
  const otherDevice = shared.map((record, index) => ({ ...record, id: `SIM-COMPLAINT-10${index}`, deviceId: `SIM-DEVICE-OTHER-${index}` }));
  const otherInterface = shared.map((record, index) => ({ ...record, id: `SIM-COMPLAINT-20${index}`, interfaceId: `SIM-IFACE-OTHER-${index}` }));
  const otherSymptoms = shared.map((record, index) => ({ ...record, id: `SIM-COMPLAINT-30${index}`, symptomCode: `DEMO-OTHER-SYMPTOM-${index}` }));
  const noInterface = shared.map((record, index) => ({ ...record, id: `SIM-COMPLAINT-40${index}`, interfaceId: '' }));
  const outsideWindow = shared.map((record, index) => ({ ...record, id: `SIM-COMPLAINT-50${index}`, sampleOffsetMinutes: index * 11 }));
  for (const records of [otherDevice, otherInterface, otherSymptoms, noInterface, outsideWindow]) {
    assert.deepEqual(groupSyntheticComplaintRecords(records).groups, [], 'missing or unrelated evidence fails closed');
  }
  assert.deepEqual(groupSyntheticComplaintRecords([{ ...shared[0], synthetic: false }, ...shared.slice(1)]).groups, []);
  assert.deepEqual(groupSyntheticComplaintRecords([shared[0], shared[0], shared[0], shared[1]]).groups, [], 'duplicate synthetic IDs do not inflate the threshold');
  assert.throws(() => groupSyntheticComplaintRecords({}), /must be an array/);
  assert.throws(() => groupSyntheticComplaintRecords(shared, { minimumGroupSize: 1 }), /valid threshold/);
  assert.throws(() => groupSyntheticComplaintRecords(shared, { windowMinutes: -1 }), /valid threshold/);
});

test('the visible incident demo is explicitly synthetic, unavailable for live checks, and offers no actions or writes', () => {
  const result = groupSyntheticComplaintRecords(SYNTHETIC_NETWORK_COMPLAINTS);
  assert.equal(result.simulationOnly, true);
  assert.equal(result.liveDataChecked, false);
  assert.equal(result.liveCallsMade, false);
  assert.equal(result.recordsPersisted, false);
  assert.ok(result.groups.every((group) => group.simulationOnly && !group.liveDataChecked && !group.liveCallsMade && !group.recordsPersisted));
  const markup = renderSyntheticIncidentCorrelationDemo();
  assert.match(markup, /Simulation only · no live network\/customer data checked/);
  assert.match(markup, /not an automatic watcher/);
  for (const networkPart of ['Router', 'WAN', 'DNS', 'OLT']) assert.match(markup, new RegExp(`${networkPart} finding`));
  assert.match(markup, /Unavailable · no live network data was checked/);
  assert.match(markup, /No incident was created, nothing was saved/);
  assert.doesNotMatch(markup, /<button\b|<form\b|data-action=|fetch\s*\(/i);
  assert.doesNotMatch(correlationSource, /fetch\s*\(|XMLHttpRequest|WebSocket|child_process|supabase|routeros|radius|indexedDB|localStorage|sessionStorage|\.rpc\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(/i);
});

test('incident demo exposes accessible English and Roman Urdu labels plus correctly tagged Urdu complaint samples', () => {
  const english = renderSyntheticIncidentCorrelationDemo();
  const romanUrdu = renderSyntheticIncidentCorrelationDemo((copy) => translateUi(copy, 'ur-Latn'));
  assert.match(english, /aria-labelledby="network-correlation-demo-title"/);
  assert.match(english, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(english, /aria-label="Fictional sample complaints in English, Roman Urdu, and Urdu"/);
  assert.match(english, /<q lang="en" dir="ltr">/);
  assert.match(english, /<q lang="ur-Latn" dir="ltr">/);
  assert.match(english, /<q lang="ur" dir="rtl">انٹرنیٹ بار بار بند ہو جاتا ہے۔<\/q>/);
  assert.match(romanUrdu, /Sirf simulation · live network ya customer data check nahin kiya gaya/);
  assert.match(romanUrdu, /Network bhar ki shikayaton ki grouping · khayali demo/);
  assert.match(romanUrdu, /is muqarrar demo mein minute/);
  assert.match(romanUrdu, /Dastiyab nahin · live network data check nahin hua/);
  assert.match(romanUrdu, /lang="ur" dir="rtl"/);
});
