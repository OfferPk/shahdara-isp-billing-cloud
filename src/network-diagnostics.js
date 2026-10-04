import { renderSyntheticIncidentCorrelationDemo } from './network-incident-correlation.js';

const MAX_COMPLAINT_LENGTH = 500;
export const MAX_SYNTHETIC_IDENTIFIER_LENGTH = 120;
export const MAX_RECENT_SIMULATIONS = 10;

export const SYNTHETIC_IDENTIFIER_TYPES = Object.freeze([
  Object.freeze({ value: 'name', label: 'Synthetic display name or alias', placeholder: 'Example: Ali Khan or Ahmed Raza' }),
  Object.freeze({ value: 'username', label: 'Simulated username', placeholder: 'Example: SIM-USER-ALI-A' }),
  Object.freeze({ value: 'pppoeUsername', label: 'Simulated PPPoE username', placeholder: 'Example: SIM.PPPOE.ALI.A' }),
  Object.freeze({ value: 'customerId', label: 'Synthetic customer ID', placeholder: 'Example: DEMO-CUSTOMER-001' }),
  Object.freeze({ value: 'phonePlaceholder', label: 'Fake phone placeholder (not a phone number)', placeholder: 'Example: DEMO-PHONE-001-NOT-DIALABLE' }),
  Object.freeze({ value: 'accountNumber', label: 'Synthetic account number', placeholder: 'Example: DEMO-ACCOUNT-001' }),
]);

export const MOCK_DIAGNOSTIC_FIXTURES = Object.freeze([
  Object.freeze({
    id: 'demo-ali-a',
    displayName: 'Ali Khan · Synthetic profile A',
    aliases: Object.freeze(['ali', 'ali khan', 'علی', 'علی خان']),
    demoIdentifiers: Object.freeze({
      username: 'SIM-USER-ALI-A',
      pppoeUsername: 'SIM.PPPOE.ALI.A',
      customerId: 'DEMO-CUSTOMER-001',
      phonePlaceholder: 'DEMO-PHONE-001-NOT-DIALABLE',
      accountNumber: 'DEMO-ACCOUNT-001',
    }),
    fixtureLabel: 'DEMO-ALI-A',
  }),
  Object.freeze({
    id: 'demo-ali-b',
    displayName: 'Ali Khan · Synthetic profile B',
    aliases: Object.freeze(['ali', 'ali khan', 'علی', 'علی خان']),
    demoIdentifiers: Object.freeze({
      username: 'SIM-USER-ALI-B',
      pppoeUsername: 'SIM.PPPOE.ALI.B',
      customerId: 'DEMO-CUSTOMER-002',
      phonePlaceholder: 'DEMO-PHONE-002-NOT-DIALABLE',
      accountNumber: 'DEMO-ACCOUNT-002',
    }),
    fixtureLabel: 'DEMO-ALI-B',
  }),
  Object.freeze({
    id: 'demo-ahmed-a',
    displayName: 'Ahmed Raza · Synthetic profile',
    aliases: Object.freeze(['ahmed', 'ahmed raza', 'احمد', 'احمد رضا']),
    demoIdentifiers: Object.freeze({
      username: 'SIM-USER-AHMED-A',
      pppoeUsername: 'SIM.PPPOE.AHMED.A',
      customerId: 'DEMO-CUSTOMER-003',
      phonePlaceholder: 'DEMO-PHONE-003-NOT-DIALABLE',
      accountNumber: 'DEMO-ACCOUNT-003',
    }),
    fixtureLabel: 'DEMO-AHMED-A',
  }),
]);

export const SYNTHETIC_SYMPTOM_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'no-internet',
    label: 'No internet / disconnected',
    phrases: Object.freeze([
      'no internet', 'internet is down', 'internet not working', 'internet does not work',
      'cannot connect', 'no connection', 'offline', 'internet nahi chal raha', 'internet nahin chal raha',
      'net nahi chal raha', 'net nahin chal raha', 'internet band hai', 'net band hai',
      'internet nahi aa raha', 'internet nahin aa raha', 'انٹرنیٹ نہیں چل رہا', 'نیٹ نہیں چل رہا',
      'انٹرنیٹ بند ہے', 'نیٹ بند ہے', 'انٹرنیٹ نہیں آ رہا', 'نیٹ نہیں آ رہا',
    ]),
    diagnosis: 'Fictional no-internet scenario: this sample represents a disconnected PPPoE session. It does not identify a real cause or confirm service status.',
    findings: Object.freeze([
      Object.freeze({ label: 'Synthetic session state', value: 'Disconnected · fictional demo scenario', state: 'mock' }),
    ]),
  }),
  Object.freeze({
    id: 'slow-speed-profile-mismatch',
    label: 'Slow speed / profile mismatch',
    phrases: Object.freeze([
      'slow internet', 'internet is slow', 'internet speed is slow', 'slow speed', 'speed is slow',
      'low speed', 'speed below package', 'speed lower than package', 'internet slow hai',
      'net slow hai', 'speed slow hai', 'speed kam hai', 'package se kam speed', 'package say kam speed',
      'انٹرنیٹ سست ہے', 'رفتار سست ہے', 'رفتار کم ہے', 'انٹرنیٹ کی رفتار کم ہے', 'پیکیج سے کم رفتار',
    ]),
    diagnosis: 'Fictional slow-speed/profile-mismatch scenario: the sample package is 20 Mbps and the example profile is 5 Mbps. No throughput test was run.',
    findings: Object.freeze([
      Object.freeze({ label: 'Example package', value: '20 Mbps · fictional demo scenario', state: 'mock' }),
      Object.freeze({ label: 'Example assigned speed profile', value: '5 Mbps · fictional demo scenario', state: 'mock' }),
    ]),
  }),
  Object.freeze({
    id: 'intermittent-disconnect',
    label: 'Intermittent / disconnect',
    phrases: Object.freeze([
      'intermittent internet', 'keeps disconnecting', 'internet keeps disconnecting',
      'connection keeps dropping', 'internet cuts out', 'frequent disconnections', 'disconnects repeatedly',
      'bar bar disconnect hota hai', 'baar baar disconnect hota hai', 'internet ruk ruk kar chalta hai',
      'connection bar bar toot ta hai', 'bar bar band hota hai', 'بار بار منقطع',
      'رابطہ بار بار ٹوٹتا ہے', 'نیٹ رک رک کر چلتا ہے', 'بار بار ڈسکنیکٹ', 'انٹرنیٹ بار بار بند',
    ]),
    diagnosis: 'Fictional intermittent/disconnect scenario: the sample shows repeated connection drops. No live session history was checked.',
    findings: Object.freeze([
      Object.freeze({ label: 'Synthetic session stability', value: 'Intermittent · fictional demo scenario', state: 'mock' }),
    ]),
  }),
]);

export const SYNTHETIC_DIAGNOSTIC_STEPS = Object.freeze([
  Object.freeze({ id: 'profile-fixture', label: 'Synthetic profile fixture' }),
  Object.freeze({ id: 'symptom-classification', label: 'Symptom classification' }),
  Object.freeze({ id: 'scenario-evidence', label: 'Fictional scenario evidence' }),
]);

export const LIVE_ONLY_DIAGNOSTIC_CHECKS = Object.freeze([
  Object.freeze({ id: 'router-status', label: 'Router status', value: 'Unavailable · no live device is connected' }),
  Object.freeze({ id: 'router-management-ip-address', label: 'Router management IP address', value: 'Unavailable · no live device is connected' }),
  Object.freeze({ id: 'subscriber-ip-address', label: 'Subscriber IP address', value: 'Unavailable · no live device is connected' }),
  Object.freeze({ id: 'wan-link-status', label: 'WAN link status', value: 'Unavailable · no live device is connected' }),
  Object.freeze({ id: 'dns-resolution', label: 'DNS resolution', value: 'Unavailable · no live device is connected' }),
  Object.freeze({ id: 'routing-table', label: 'Routing table', value: 'Unavailable · no live device is connected' }),
  Object.freeze({ id: 'live-traffic', label: 'Live traffic', value: 'Unavailable · no live device is connected' }),
  Object.freeze({ id: 'packet-loss', label: 'Packet loss', value: 'Unavailable · no live device is connected' }),
  Object.freeze({ id: 'measured-throughput', label: 'Measured throughput', value: 'Unavailable · no speed test was run' }),
  Object.freeze({ id: 'live-pppoe-session-history', label: 'Live PPPoE session history', value: 'Unavailable · no live device is connected' }),
]);

export const SIMULATION_EXAMPLES = Object.freeze([
  Object.freeze({ id: 'roman-ali', label: 'Roman Urdu: Ali ka internet nahi chal raha', identifierType: 'name', identifier: 'Ali Khan', complaint: 'Ali ka internet nahi chal raha' }),
  Object.freeze({ id: 'english-ahmed', label: "English: Ahmed's internet is slow", identifierType: 'name', identifier: 'Ahmed Raza', complaint: "Ahmed's internet is slow" }),
  Object.freeze({ id: 'urdu-ahmed', label: 'Urdu: احمد کی رفتار سست ہے', identifierType: 'name', identifier: 'احمد رضا', complaint: 'احمد کی رفتار سست ہے' }),
  Object.freeze({ id: 'urdu-intermittent', label: 'Urdu: انٹرنیٹ بار بار بند ہو جاتا ہے', identifierType: 'name', identifier: 'علی خان', complaint: 'انٹرنیٹ بار بار بند ہو جاتا ہے' }),
  Object.freeze({ id: 'unknown', label: 'Unknown synthetic demo name: Zara ka internet band hai', identifierType: 'name', identifier: 'Zara', complaint: 'Zara ka internet band hai' }),
]);

export const NETWORK_ACTION_POLICY = Object.freeze([
  Object.freeze({
    id: 'low-risk-router-changes',
    risk: 'Low',
    label: 'Low-risk router changes',
    requiresAdminEnable: true,
    requiresActionConfirmation: false,
    futureRequirement: 'Future requirement: an Admin must enable this class and an approved adapter must be connected.',
  }),
  Object.freeze({
    id: 'medium-risk-customer-profile-changes',
    risk: 'Medium',
    label: 'Medium-risk customer or profile changes',
    requiresAdminEnable: false,
    requiresActionConfirmation: true,
    futureRequirement: 'Future requirement: require explicit Admin confirmation for this specific action; a connected adapter is also required.',
  }),
  Object.freeze({
    id: 'high-risk-network-destructive-changes',
    risk: 'High',
    label: 'High-risk network or destructive changes',
    requiresAdminEnable: false,
    requiresActionConfirmation: true,
    futureRequirement: 'Future requirement: require explicit confirmation for this specific action; a human must initiate it and it must never run automatically.',
  }),
]);

const CURRENT_ACTION_POLICY_CONTEXT = Object.freeze({
  routerConnected: false,
  adapterConnected: false,
  adminEnabled: false,
});

export function previewNetworkActionPolicy(actionId, context = CURRENT_ACTION_POLICY_CONTEXT) {
  const action = NETWORK_ACTION_POLICY.find(({ id }) => id === actionId);
  if (!action) throw new RangeError('Unknown network action category; no action is available.');
  const options = context && typeof context === 'object' ? context : {};
  const blockers = [];
  if (options.routerConnected !== true) blockers.push('router-not-connected');
  if (options.adapterConnected !== true) blockers.push('adapter-unavailable');
  if (action.requiresAdminEnable && options.adminEnabled !== true) blockers.push('future-admin-enable-required');
  const confirmedForThisAction = options.confirmedActionId === action.id;
  if (action.requiresActionConfirmation && !confirmedForThisAction) blockers.push('explicit-action-confirmation-required');
  if (action.risk === 'High' && options.automaticExecution === true) blockers.push('high-risk-never-automatic');
  const readyForHumanReview = blockers.length === 0;
  return Object.freeze({
    actionId: action.id,
    risk: action.risk,
    label: action.label,
    status: readyForHumanReview ? 'review-ready-simulation-only' : 'unavailable',
    blockers: Object.freeze(blockers),
    requiresActionConfirmation: action.requiresActionConfirmation,
    confirmedForThisAction,
    readyForHumanReview,
    executionPermitted: false,
  });
}

export const RISK_PREVIEW_POLICY = Object.freeze(NETWORK_ACTION_POLICY.map((action) => {
  const preview = previewNetworkActionPolicy(action.id);
  return Object.freeze({
    ...preview,
    level: action.label,
    state: 'Unavailable · preview only',
    futureRequirement: action.futureRequirement,
  });
}));

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[.,!?;:()\[\]{}"“”'’،؟۔؛/\\_-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function phrasePattern(phrase) {
  const escaped = normalizeText(phrase).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'u');
}

const SYMPTOM_SCENARIO_MATCHERS = Object.freeze(SYNTHETIC_SYMPTOM_SCENARIOS.map(({ id, phrases }) => (
  Object.freeze({ id, patterns: Object.freeze(phrases.map(phrasePattern)) })
)));

export function classifySyntheticComplaint(complaint) {
  const normalized = normalizeText(complaint);
  const matchingScenarios = SYMPTOM_SCENARIO_MATCHERS.filter(({ patterns }) => (
    patterns.some((pattern) => pattern.test(normalized))
  ));
  const state = matchingScenarios.length === 1
    ? 'supported'
    : matchingScenarios.length > 1 ? 'ambiguous' : 'not-covered';
  return Object.freeze({
    state,
    scenarioId: state === 'supported' ? matchingScenarios[0].id : null,
    source: 'deterministic-local-phrase-rules',
    liveCheckPerformed: false,
  });
}

function normalizeExactIdentifier(value) {
  if (typeof value !== 'string' || value.length > MAX_SYNTHETIC_IDENTIFIER_LENGTH) return '';
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function selectableCandidate({ id, displayName }) {
  return Object.freeze({ id, displayName });
}

function assertMockDiagnosticsProvider(provider) {
  if (!(provider instanceof MockDiagnosticsProvider)
      || Object.getPrototypeOf(provider) !== MockDiagnosticsProvider.prototype
      || provider.mode !== 'simulation') {
    throw new TypeError('Only the built-in simulation provider is allowed.');
  }
}

export class MockDiagnosticsProvider {
  constructor() {
    this.mode = 'simulation';
    Object.freeze(this);
  }

  searchSyntheticFixturesByIdentifier(identifierType, identifier) {
    const type = SYNTHETIC_IDENTIFIER_TYPES.find(({ value }) => value === identifierType);
    const normalized = normalizeExactIdentifier(identifier);
    if (!type || !normalized) return [];

    if (type.value === 'name') {
      return MOCK_DIAGNOSTIC_FIXTURES.filter((fixture) => [fixture.displayName, ...fixture.aliases]
        .some((name) => normalizeText(name) === normalizeText(normalized)))
        .map(selectableCandidate);
    }

    return MOCK_DIAGNOSTIC_FIXTURES.filter((fixture) => (
      normalizeExactIdentifier(fixture.demoIdentifiers[type.value]) === normalized
    )).map(selectableCandidate);
  }

  getSyntheticEvidence(fixtureId) {
    const fixture = MOCK_DIAGNOSTIC_FIXTURES.find(({ id }) => id === fixtureId);
    if (!fixture) return null;
    return {
      id: fixture.id,
      displayName: fixture.displayName,
      fixtureLabel: fixture.fixtureLabel,
      identitySource: 'fictional-local-profile-fixture',
    };
  }
}

export function runSyntheticDiagnosticSteps(provider, fixtureId, classification, requestedStepIds = SYNTHETIC_DIAGNOSTIC_STEPS.map(({ id }) => id)) {
  assertMockDiagnosticsProvider(provider);
  if (!classification || classification.state !== 'supported'
      || classification.source !== 'deterministic-local-phrase-rules'
      || classification.liveCheckPerformed !== false) {
    throw new TypeError('Diagnostic steps require a locally supported synthetic symptom classification.');
  }
  if (!Array.isArray(requestedStepIds)) {
    throw new TypeError('Synthetic diagnostic steps must be selected from the local allowlist.');
  }
  const allowedStepIds = SYNTHETIC_DIAGNOSTIC_STEPS.map(({ id }) => id);
  if (requestedStepIds.some((id) => !allowedStepIds.includes(id))
      || new Set(requestedStepIds).size !== requestedStepIds.length) {
    throw new RangeError('Unknown synthetic diagnostic step; live network tools are unavailable.');
  }

  const evidence = provider.getSyntheticEvidence(fixtureId);
  if (!evidence) throw new RangeError('Choose a listed synthetic fixture.');
  const scenario = SYNTHETIC_SYMPTOM_SCENARIOS.find(({ id }) => id === classification.scenarioId);
  if (!scenario) throw new RangeError('Choose a supported local symptom scenario.');

  const findingsByStep = {
    'profile-fixture': [
      { label: 'Synthetic profile fixture', value: 'Fictional local profile fixture', state: 'mock', synthetic: true, stepId: 'profile-fixture' },
    ],
    'symptom-classification': [
      { label: 'Symptom classification', value: 'Deterministic local phrase rules', state: 'mock', synthetic: true, stepId: 'symptom-classification' },
    ],
    'scenario-evidence': scenario.findings.map((finding) => ({ ...finding, synthetic: true, stepId: 'scenario-evidence' })),
  };
  const syntheticFindings = requestedStepIds.flatMap((id) => findingsByStep[id]);
  const unavailableFindings = LIVE_ONLY_DIAGNOSTIC_CHECKS.map(({ id, label, value }) => ({
    label, value, state: 'unavailable', synthetic: true, stepId: id,
  }));
  return Object.freeze([...syntheticFindings, ...unavailableFindings].map((finding) => Object.freeze(finding)));
}

export function runSyntheticDiagnostics(provider, fixtureId, complaint) {
  assertMockDiagnosticsProvider(provider);
  const normalizedComplaint = String(complaint ?? '').trim();
  if (!normalizedComplaint || normalizedComplaint.length > MAX_COMPLAINT_LENGTH) {
    throw new RangeError(`Complaint must contain 1 to ${MAX_COMPLAINT_LENGTH} characters.`);
  }
  const classification = classifySyntheticComplaint(normalizedComplaint);
  if (classification.state !== 'supported') {
    throw new RangeError('Complaint is not covered by the demo or is ambiguous; no real check was run.');
  }
  const evidence = provider.getSyntheticEvidence(fixtureId);
  if (!evidence) throw new RangeError('Choose a listed synthetic fixture.');
  const scenario = SYNTHETIC_SYMPTOM_SCENARIOS.find(({ id }) => id === classification.scenarioId);
  const findings = runSyntheticDiagnosticSteps(provider, fixtureId, classification);
  return Object.freeze({
    ...evidence,
    diagnosis: scenario.diagnosis,
    findings,
    complaint: normalizedComplaint,
    symptomScenario: scenario.label,
    symptomScenarioId: scenario.id,
    source: 'fictional-local-symptom-scenario',
    classificationSource: classification.source,
    state: 'simulated-only',
    outcome: 'simulated-only',
    simulated: true,
    fictional: true,
    liveCheckPerformed: false,
    changesApplied: false,
    serviceVerified: false,
    recommendation: 'For a real service issue, inspect it through the approved support process after a device is connected. No fix was applied or verified here.',
  });
}

export function createRecentSimulationHistory() {
  let entries = Object.freeze([]);
  return Object.freeze({
    list() {
      return entries;
    },
    record(result, now = new Date()) {
      const validResult = result && typeof result === 'object'
        && result.simulated === true
        && result.fictional === true
        && result.liveCheckPerformed === false
        && result.changesApplied === false
        && result.serviceVerified === false
        && result.state === 'simulated-only'
        && result.outcome === 'simulated-only'
        && MOCK_DIAGNOSTIC_FIXTURES.some(({ id }) => id === result.id)
        && SYNTHETIC_SYMPTOM_SCENARIOS.some(({ id }) => id === result.symptomScenarioId);
      if (!validResult) throw new TypeError('Only a completed fictional simulation can enter simulation history.');
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new TypeError('Simulation history needs a valid local display timestamp.');
      }

      const entry = Object.freeze({
        fixtureId: result.id,
        scenarioId: result.symptomScenarioId,
        status: result.outcome,
        displayTimestamp: now.toLocaleString(),
      });
      entries = Object.freeze([entry, ...entries].slice(0, MAX_RECENT_SIMULATIONS));
      return entries;
    },
    clear() {
      entries = Object.freeze([]);
      return entries;
    },
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function translated(t, message) {
  return escapeHtml(t(message));
}

export function renderRecentSimulations(entries, t = (message) => message) {
  if (!Array.isArray(entries) || entries.length > MAX_RECENT_SIMULATIONS
      || !entries.every((entry) => entry && typeof entry === 'object'
        && MOCK_DIAGNOSTIC_FIXTURES.some(({ id }) => id === entry.fixtureId)
        && SYNTHETIC_SYMPTOM_SCENARIOS.some(({ id }) => id === entry.scenarioId)
        && entry.status === 'simulated-only'
        && typeof entry.displayTimestamp === 'string')) {
    throw new TypeError('Recent simulations may contain only bounded synthetic result metadata.');
  }
  const rows = entries.map(({ fixtureId, scenarioId, status, displayTimestamp }) => (
    `<li><dl><div><dt>${translated(t, 'Fixture')}</dt><dd>${escapeHtml(fixtureId)}</dd></div><div><dt>${translated(t, 'Scenario')}</dt><dd>${escapeHtml(scenarioId)}</dd></div><div><dt>${translated(t, 'Result')}</dt><dd>${translated(t, 'Simulated only')}</dd></div><div><dt>${translated(t, 'Displayed')}</dt><dd><time>${escapeHtml(displayTimestamp)}</time></dd></div></dl></li>`
  )).join('');
  const emptyState = entries.length ? '' : `<p class="network-diagnostics__history-empty">${translated(t, 'No simulations are in this view yet.')}</p>`;
  return `<section class="network-diagnostics__history-panel" aria-labelledby="network-diagnostics-history-title"><div class="network-diagnostics__history-heading"><h3 id="network-diagnostics-history-title">${translated(t, 'Recent simulations')}</h3><button class="button secondary small" type="button" data-clear-simulation-history="true" aria-label="${translated(t, 'Clear recent simulations')}">${translated(t, 'Clear history')}</button></div><p class="network-diagnostics__history-notice" role="note">${translated(t, 'Simulation history only — no actions or changes occurred')}</p><p class="muted">${translated(t, 'Only this view’s in-memory simulation history is cleared.')}</p><ul class="network-diagnostics__history-list" aria-label="${translated(t, 'Recent simulations')}">${rows}</ul>${emptyState}</section>`;
}

function renderFindings(findings, t) {
  return findings.map(({ label, value, state }) => {
    const safeState = state === 'mock' ? 'mock' : 'unavailable';
    return `<li><article class="network-diagnostics__finding"><h4>${translated(t, label)}</h4><p>${translated(t, value)}</p><span class="network-diagnostics__evidence network-diagnostics__evidence--${safeState}">${translated(t, safeState === 'mock' ? 'Synthetic fixture evidence' : 'Synthetic · unavailable')}</span></article></li>`;
  }).join('');
}

export function renderNetworkActionPolicyPreview(t = (message) => message) {
  const rows = RISK_PREVIEW_POLICY.map(({ level, state, futureRequirement }) => (
    `<li><strong>${translated(t, level)}</strong><span><strong>${translated(t, state)}</strong> ${translated(t, 'Reason: no connected router or approved adapter.') } ${translated(t, futureRequirement)}</span></li>`
  )).join('');
  return `<section class="network-diagnostics__risk" aria-labelledby="network-diagnostics-risk-policy-title"><h3 id="network-diagnostics-risk-policy-title">${translated(t, 'Future action policy · simulation only')}</h3><p>${translated(t, 'No router is connected, no approved adapter is available, and there are no live customers. Every action class is unavailable today.')}</p><p>${translated(t, 'A confirmation shown or tested here is only a simulation; it does not approve, queue, or apply a real action.')}</p><ul>${rows}</ul></section>`;
}

export function renderSyntheticDiagnosticResult(result, t = (message) => message) {
  if (!result || result.simulated !== true || result.fictional !== true || result.outcome !== 'simulated-only'
      || result.liveCheckPerformed !== false || result.changesApplied !== false || result.serviceVerified !== false) {
    throw new TypeError('Only an explicitly simulated diagnostic result can be rendered.');
  }
  if (!Array.isArray(result.findings) || !result.findings.every(({ state, synthetic }) => (
    synthetic === true && ['mock', 'unavailable'].includes(state)
  ))) {
    throw new TypeError('Every rendered finding must be explicitly synthetic and mock or unavailable.');
  }
  const findings = result.findings;
  return `<article class="network-diagnostics__result" aria-labelledby="network-diagnostics-result-title"><p class="network-diagnostics__simulation-tag">${translated(t, 'SIMULATION ONLY · NOT LIVE NETWORK DATA')}</p><h3 id="network-diagnostics-result-title">${translated(t, 'Simulated diagnostic result')}</h3><p class="network-diagnostics__complaint"><strong>${translated(t, 'Complaint')}</strong>: ${escapeHtml(result.complaint)}</p><p><strong>${translated(t, 'Symptom scenario')}</strong>: ${translated(t, result.symptomScenario)}</p><p class="network-diagnostics__diagnosis">${translated(t, result.diagnosis)}</p><ul class="network-diagnostics__findings" aria-label="${translated(t, 'Synthetic and unavailable diagnostic findings')}">${renderFindings(findings, t)}</ul><section class="network-diagnostics__recommendation" aria-labelledby="network-diagnostics-recommendation-title"><h4 id="network-diagnostics-recommendation-title">${translated(t, 'Recommendation')}</h4><p>${translated(t, result.recommendation)}</p></section><p class="network-diagnostics__not-fixed">${translated(t, 'No router or customer change was applied, and no service restoration was verified.')}</p><details class="network-diagnostics__technical"><summary>${translated(t, 'Technical details')}</summary><dl><div><dt>${translated(t, 'Output state')}</dt><dd>${translated(t, result.state)}</dd></div><div><dt>${translated(t, 'Evidence source')}</dt><dd>${translated(t, 'Fictional local symptom scenario')}</dd></div><div><dt>${translated(t, 'Classification source')}</dt><dd>${translated(t, 'Deterministic local phrase rules')}</dd></div><div><dt>${translated(t, 'Synthetic demo profile')}</dt><dd>${escapeHtml(result.displayName)}</dd></div><div><dt>${translated(t, 'Identity source')}</dt><dd>${translated(t, 'Fictional local profile fixture')}</dd></div><div><dt>${translated(t, 'Fixture identifier')}</dt><dd>${escapeHtml(result.fixtureLabel)}</dd></div><div><dt>${translated(t, 'Live router response')}</dt><dd>${translated(t, 'Unavailable · no live device is connected')}</dd></div></dl><p>${translated(t, 'No shell, command execution, external AI, router API, or database lookup is available in this feature.')}</p></details></article>`;
}

function renderCandidateList(candidates, t) {
  const intro = candidates.length > 1
    ? 'Multiple synthetic demo profiles match. Select one explicitly; no live customer records were searched.'
    : 'One synthetic demo profile matches. Select it explicitly to see the local example.';
  return `<section class="network-diagnostics__matches" aria-labelledby="network-diagnostics-matches-title"><h3 id="network-diagnostics-matches-title">${translated(t, 'Synthetic demo profiles')}</h3><p>${translated(t, intro)}</p><ul>${candidates.map(({ id, displayName }) => `<li><button class="button secondary network-diagnostics__match" type="button" data-synthetic-fixture="${escapeHtml(id)}">${translated(t, 'Select synthetic profile')}: ${escapeHtml(displayName)}</button></li>`).join('')}</ul></section>`;
}

function renderUnknownMatch(t) {
  return `<section class="network-diagnostics__unknown" role="status"><h3>${translated(t, 'No synthetic demo profile matched')}</h3><p>${translated(t, 'This feature searched only its fictional local fixtures. No live customer lookup was made.')}</p><p>${translated(t, 'Try a listed example or choose a name included in the synthetic examples.')}</p></section>`;
}

export function renderSyntheticSymptomDecision(classification, t = (message) => message) {
  if (!classification || !['ambiguous', 'not-covered'].includes(classification.state)
      || classification.source !== 'deterministic-local-phrase-rules'
      || classification.liveCheckPerformed !== false) {
    throw new TypeError('Only a locally classified no-check state can be rendered.');
  }
  const { state } = classification;
  const supportedState = state === 'ambiguous' ? 'Ambiguous symptom description' : 'Not covered by the demo';
  const message = state === 'ambiguous'
    ? 'The demo needs one supported symptom group. Clarify the complaint; no real network check was run.'
    : 'This complaint is not covered by the demo; no real network check was run.';
  return `<section class="network-diagnostics__symptom-state" role="status"><h3>${translated(t, supportedState)}</h3><p>${translated(t, message)}</p><dl><div><dt>${translated(t, 'Output state')}</dt><dd>${translated(t, state === 'ambiguous' ? 'Ambiguous · no check run' : 'Not covered · no check run')}</dd></div><div><dt>${translated(t, 'Decision source')}</dt><dd>${translated(t, 'Deterministic local phrase rules')}</dd></div></dl></section>`;
}

function renderExperience(t) {
  const typeOptions = SYNTHETIC_IDENTIFIER_TYPES.map(({ value, label }) => `<option value="${escapeHtml(value)}">${translated(t, label)}</option>`).join('');
  const examples = SIMULATION_EXAMPLES.map(({ id, label }) => `<button class="button secondary network-diagnostics__example" type="button" data-synthetic-example="${escapeHtml(id)}">${translated(t, label)}</button>`).join('');
  return `<div class="network-diagnostics__experience"><div class="network-diagnostics__examples" role="group" aria-label="${translated(t, 'Synthetic complaint examples')}">${examples}</div><form id="network-diagnostics-form" class="network-diagnostics__form"><label for="network-diagnostics-identifier-type">${translated(t, 'Synthetic demo identifier type')}</label><select id="network-diagnostics-identifier-type" name="identifierType" required>${typeOptions}</select><label for="network-diagnostics-identifier">${translated(t, 'Synthetic demo identifier value')}</label><input id="network-diagnostics-identifier" name="identifier" type="text" maxlength="${MAX_SYNTHETIC_IDENTIFIER_LENGTH}" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="network-diagnostics-identifier-help" required><p id="network-diagnostics-identifier-help" class="muted">${translated(t, 'Use fictional demo values only. Never enter a real customer name, login, PPPoE credential, account number, or phone number. Inputs stay local and are not saved or sent.')}</p><label for="network-diagnostics-complaint">${translated(t, 'Describe a synthetic demo complaint (English, Roman Urdu, or Urdu)')}</label><textarea id="network-diagnostics-complaint" name="complaint" maxlength="${MAX_COMPLAINT_LENGTH}" rows="3" aria-describedby="network-diagnostics-help" required></textarea><p id="network-diagnostics-help" class="muted">${translated(t, 'Use a fictional demo complaint only. Complaint text is processed locally in this browser and is not saved or sent.')}</p><button class="button primary" type="submit">${translated(t, 'Run simulated check')}</button></form><p class="network-diagnostics__status" id="network-diagnostics-status" role="status" aria-live="polite" aria-atomic="true"></p><div id="network-diagnostics-results"></div><div id="network-diagnostics-history">${renderRecentSimulations([], t)}</div></div>`;
}

export function mountNetworkDiagnosticsPanel(root, { t = (message) => message } = {}) {
  if (!root || root.id !== 'admin-network-diagnostics') return false;
  const content = root.querySelector('.network-diagnostics__content');
  if (!content) return false;
  content.innerHTML = `${renderNetworkActionPolicyPreview(t)}${renderSyntheticIncidentCorrelationDemo(t)}${renderExperience(t)}`;
  const provider = new MockDiagnosticsProvider();
  const recentSimulationHistory = createRecentSimulationHistory();
  const form = content.querySelector('#network-diagnostics-form');
  const identifierTypeInput = content.querySelector('#network-diagnostics-identifier-type');
  const identifierInput = content.querySelector('#network-diagnostics-identifier');
  const complaintInput = content.querySelector('#network-diagnostics-complaint');
  const status = content.querySelector('#network-diagnostics-status');
  const results = content.querySelector('#network-diagnostics-results');
  const historyRoot = content.querySelector('#network-diagnostics-history');
  let selectableFixtureIds = new Set();
  let latestComplaint = '';

  function clearMatch() {
    selectableFixtureIds = new Set();
    latestComplaint = '';
    results.replaceChildren();
    status.textContent = '';
  }

  function updateIdentifierPlaceholder() {
    const identifierType = SYNTHETIC_IDENTIFIER_TYPES.find(({ value }) => value === identifierTypeInput?.value);
    if (identifierInput && identifierType) identifierInput.placeholder = translated(t, identifierType.placeholder);
  }

  identifierTypeInput?.addEventListener('change', () => {
    updateIdentifierPlaceholder();
    clearMatch();
  });
  for (const input of [identifierInput, complaintInput]) {
    input?.addEventListener('input', clearMatch);
  }
  updateIdentifierPlaceholder();

  content.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;
    if (target.dataset.clearSimulationHistory === 'true') {
      recentSimulationHistory.clear();
      historyRoot.innerHTML = renderRecentSimulations(recentSimulationHistory.list(), t);
      status.textContent = translated(t, 'Simulation history cleared from this view.');
      return;
    }
    const example = SIMULATION_EXAMPLES.find(({ id }) => id === target.dataset.syntheticExample);
    if (example && identifierInput && complaintInput && identifierTypeInput) {
      identifierTypeInput.value = example.identifierType;
      updateIdentifierPlaceholder();
      identifierInput.value = example.identifier;
      complaintInput.value = example.complaint;
      clearMatch();
      status.textContent = translated(t, 'Example added. Submit to run the local simulation.');
      identifierInput.focus();
      return;
    }
    const fixtureId = target.dataset.syntheticFixture;
    if (!fixtureId || !selectableFixtureIds.has(fixtureId)) return;
    try {
      const result = runSyntheticDiagnostics(provider, fixtureId, latestComplaint);
      selectableFixtureIds = new Set();
      results.innerHTML = renderSyntheticDiagnosticResult(result, t);
      recentSimulationHistory.record(result);
      historyRoot.innerHTML = renderRecentSimulations(recentSimulationHistory.list(), t);
      status.textContent = translated(t, 'Simulation complete. This is not a live diagnosis.');
    } catch {
      results.innerHTML = `<p class="network-diagnostics__error" role="alert">${translated(t, 'The local simulation could not produce this example.')}</p>`;
      status.textContent = '';
    }
  });

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const identifierType = String(identifierTypeInput?.value ?? '');
    const identifier = String(identifierInput?.value ?? '').trim();
    const complaint = String(complaintInput?.value ?? '').trim();
    results.replaceChildren();
    selectableFixtureIds = new Set();
    latestComplaint = '';
    if (!identifier || identifier.length > MAX_SYNTHETIC_IDENTIFIER_LENGTH
        || !complaint || complaint.length > MAX_COMPLAINT_LENGTH) {
      status.textContent = translated(t, 'Enter a synthetic demo identifier (1 to 120 characters) and a demo complaint (1 to 500 characters).');
      return;
    }
    const classification = classifySyntheticComplaint(complaint);
    if (classification.state !== 'supported') {
      status.textContent = translated(t, classification.state === 'ambiguous'
        ? 'Ambiguous complaint; no real check was run.'
        : 'Complaint is not covered by the demo; no real check was run.');
      results.innerHTML = renderSyntheticSymptomDecision(classification, t);
      return;
    }
    const candidates = provider.searchSyntheticFixturesByIdentifier(identifierType, identifier);
    if (candidates.length === 0) {
      status.textContent = translated(t, 'No synthetic example matched; live customer lookup was not attempted.');
      results.innerHTML = renderUnknownMatch(t);
      return;
    }
    latestComplaint = complaint;
    selectableFixtureIds = new Set(candidates.map(({ id }) => id));
    status.textContent = translated(t, 'Choose a synthetic demo profile to continue.');
    results.innerHTML = renderCandidateList(candidates, t);
  });
  return true;
}
