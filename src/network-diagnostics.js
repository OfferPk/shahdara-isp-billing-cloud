const MAX_COMPLAINT_LENGTH = 500;
export const MAX_SYNTHETIC_IDENTIFIER_LENGTH = 120;

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
    diagnosis: 'In this synthetic example, the PPPoE session is shown as disconnected. The fixture does not establish why.',
    findings: Object.freeze([
      Object.freeze({ label: 'Portal service status', value: 'Active · synthetic fixture', state: 'mock' }),
      Object.freeze({ label: 'Example package', value: '20 Mbps · synthetic fixture', state: 'mock' }),
      Object.freeze({ label: 'PPPoE session', value: 'Disconnected · synthetic fixture', state: 'mock' }),
      Object.freeze({ label: 'Assigned IP address', value: 'Unavailable · no live device is connected', state: 'unavailable' }),
      Object.freeze({ label: 'Router, WAN, DNS and wider network', value: 'Unavailable · no live device is connected', state: 'unavailable' }),
    ]),
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
    diagnosis: 'This synthetic profile shows a connected session and matching example speeds; the reported experience cannot be verified without live evidence.',
    findings: Object.freeze([
      Object.freeze({ label: 'Portal service status', value: 'Active · synthetic fixture', state: 'mock' }),
      Object.freeze({ label: 'Example package', value: '10 Mbps · synthetic fixture', state: 'mock' }),
      Object.freeze({ label: 'PPPoE session', value: 'Connected · synthetic fixture', state: 'mock' }),
      Object.freeze({ label: 'Assigned IP address', value: 'Example address assigned · synthetic fixture', state: 'mock' }),
      Object.freeze({ label: 'Router, WAN, DNS and wider network', value: 'Unavailable · no live device is connected', state: 'unavailable' }),
    ]),
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
    diagnosis: 'In this synthetic example, the package is 20 Mbps while the example assigned speed profile is 5 Mbps. This is a fixture mismatch, not a finding about any real customer.',
    findings: Object.freeze([
      Object.freeze({ label: 'Portal service status', value: 'Active · synthetic fixture', state: 'mock' }),
      Object.freeze({ label: 'Example package', value: '20 Mbps · synthetic fixture', state: 'mock' }),
      Object.freeze({ label: 'PPPoE session', value: 'Connected · synthetic fixture', state: 'mock' }),
      Object.freeze({ label: 'Assigned IP address', value: 'Example address assigned · synthetic fixture', state: 'mock' }),
      Object.freeze({ label: 'Example assigned speed profile', value: '5 Mbps · synthetic fixture', state: 'mock' }),
      Object.freeze({ label: 'Router, WAN, DNS and wider network', value: 'Unavailable · no live device is connected', state: 'unavailable' }),
    ]),
  }),
]);

export const SIMULATION_EXAMPLES = Object.freeze([
  Object.freeze({ id: 'roman-ali', label: 'Roman Urdu: Ali ka internet nahi chal raha', identifierType: 'name', identifier: 'Ali Khan', complaint: 'Ali ka internet nahi chal raha' }),
  Object.freeze({ id: 'english-ahmed', label: "English: Ahmed's internet is slow", identifierType: 'name', identifier: 'Ahmed Raza', complaint: "Ahmed's internet is slow" }),
  Object.freeze({ id: 'urdu-ahmed', label: 'Urdu: احمد کی رفتار سست ہے', identifierType: 'name', identifier: 'احمد رضا', complaint: 'احمد کی رفتار سست ہے' }),
  Object.freeze({ id: 'unknown', label: 'Unknown synthetic demo name: Zara ka internet band hai', identifierType: 'name', identifier: 'Zara', complaint: 'Zara ka internet band hai' }),
]);

export const RISK_PREVIEW_POLICY = Object.freeze([
  Object.freeze({ level: 'Low-risk router changes', state: 'Unavailable · preview only' }),
  Object.freeze({ level: 'Medium-risk customer or profile changes', state: 'Unavailable · preview only' }),
  Object.freeze({ level: 'High-risk network or destructive changes', state: 'Unavailable · preview only' }),
]);

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[.,!?;:()\[\]{}"“”'’]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeExactIdentifier(value) {
  if (typeof value !== 'string' || value.length > MAX_SYNTHETIC_IDENTIFIER_LENGTH) return '';
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function selectableCandidate({ id, displayName }) {
  return Object.freeze({ id, displayName });
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
      diagnosis: fixture.diagnosis,
      findings: fixture.findings.map((finding) => ({ ...finding })),
      source: 'synthetic-local-fixture',
      simulated: true,
    };
  }
}

export function runSyntheticDiagnostics(provider, fixtureId, complaint) {
  if (!(provider instanceof MockDiagnosticsProvider)
      || Object.getPrototypeOf(provider) !== MockDiagnosticsProvider.prototype
      || provider.mode !== 'simulation') {
    throw new TypeError('Only the built-in simulation provider is allowed.');
  }
  const normalizedComplaint = String(complaint ?? '').trim();
  if (!normalizedComplaint || normalizedComplaint.length > MAX_COMPLAINT_LENGTH) {
    throw new RangeError(`Complaint must contain 1 to ${MAX_COMPLAINT_LENGTH} characters.`);
  }
  const evidence = provider.getSyntheticEvidence(fixtureId);
  if (!evidence) throw new RangeError('Choose a listed synthetic fixture.');
  return Object.freeze({
    ...evidence,
    complaint: normalizedComplaint,
    outcome: 'simulated-only',
    recommendation: 'For a real service issue, inspect it through the approved support process after a device is connected. No fix was applied or verified here.',
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

function renderFindings(findings, t) {
  return findings.map(({ label, value, state }) => {
    const safeState = state === 'mock' ? 'mock' : 'unavailable';
    return `<li><article class="network-diagnostics__finding"><h4>${translated(t, label)}</h4><p>${translated(t, value)}</p><span class="network-diagnostics__evidence network-diagnostics__evidence--${safeState}">${translated(t, safeState === 'mock' ? 'Synthetic fixture evidence' : 'Unavailable')}</span></article></li>`;
  }).join('');
}

function renderRiskPreview(t) {
  return `<section class="network-diagnostics__risk" aria-labelledby="network-diagnostics-risk-title"><h3 id="network-diagnostics-risk-title">${translated(t, 'Changes are disabled')}</h3><p>${translated(t, 'This simulator has no router or customer write tools. Nothing is applied, queued, or awaiting confirmation.')}</p><ul>${RISK_PREVIEW_POLICY.map(({ level, state }) => `<li><strong>${translated(t, level)}</strong><span>${translated(t, state)}</span></li>`).join('')}</ul></section>`;
}

export function renderSyntheticDiagnosticResult(result, t = (message) => message) {
  if (!result || result.simulated !== true || result.outcome !== 'simulated-only') {
    throw new TypeError('Only an explicitly simulated diagnostic result can be rendered.');
  }
  const findings = Array.isArray(result.findings) ? result.findings : [];
  return `<article class="network-diagnostics__result" aria-labelledby="network-diagnostics-result-title"><p class="network-diagnostics__simulation-tag">${translated(t, 'SIMULATION ONLY · NOT LIVE NETWORK DATA')}</p><h3 id="network-diagnostics-result-title">${translated(t, 'Simulated diagnostic result')}</h3><p class="network-diagnostics__complaint"><strong>${translated(t, 'Complaint')}</strong>: ${escapeHtml(result.complaint)}</p><p class="network-diagnostics__diagnosis">${translated(t, result.diagnosis)}</p><ul class="network-diagnostics__findings" aria-label="${translated(t, 'Synthetic and unavailable diagnostic findings')}">${renderFindings(findings, t)}</ul><section class="network-diagnostics__recommendation" aria-labelledby="network-diagnostics-recommendation-title"><h4 id="network-diagnostics-recommendation-title">${translated(t, 'Recommendation')}</h4><p>${translated(t, result.recommendation)}</p></section><p class="network-diagnostics__not-fixed">${translated(t, 'No router or customer change was applied, and no service restoration was verified.')}</p><details class="network-diagnostics__technical"><summary>${translated(t, 'Technical details')}</summary><dl><div><dt>${translated(t, 'Synthetic demo profile')}</dt><dd>${escapeHtml(result.displayName)}</dd></div><div><dt>${translated(t, 'Evidence source')}</dt><dd>${translated(t, 'Local synthetic fixture')}</dd></div><div><dt>${translated(t, 'Fixture identifier')}</dt><dd>${escapeHtml(result.fixtureLabel)}</dd></div><div><dt>${translated(t, 'Live router response')}</dt><dd>${translated(t, 'Unavailable · no live device is connected')}</dd></div></dl><p>${translated(t, 'No shell, command execution, external AI, router API, or database lookup is available in this feature.')}</p></details>${renderRiskPreview(t)}</article>`;
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

function renderExperience(t) {
  const typeOptions = SYNTHETIC_IDENTIFIER_TYPES.map(({ value, label }) => `<option value="${escapeHtml(value)}">${translated(t, label)}</option>`).join('');
  const examples = SIMULATION_EXAMPLES.map(({ id, label }) => `<button class="button secondary network-diagnostics__example" type="button" data-synthetic-example="${escapeHtml(id)}">${translated(t, label)}</button>`).join('');
  return `<div class="network-diagnostics__experience"><div class="network-diagnostics__examples" role="group" aria-label="${translated(t, 'Synthetic complaint examples')}">${examples}</div><form id="network-diagnostics-form" class="network-diagnostics__form"><label for="network-diagnostics-identifier-type">${translated(t, 'Synthetic demo identifier type')}</label><select id="network-diagnostics-identifier-type" name="identifierType" required>${typeOptions}</select><label for="network-diagnostics-identifier">${translated(t, 'Synthetic demo identifier value')}</label><input id="network-diagnostics-identifier" name="identifier" type="text" maxlength="${MAX_SYNTHETIC_IDENTIFIER_LENGTH}" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="network-diagnostics-identifier-help" required><p id="network-diagnostics-identifier-help" class="muted">${translated(t, 'Use fictional demo values only. Never enter a real customer name, login, PPPoE credential, account number, or phone number. Inputs stay local and are not saved or sent.')}</p><label for="network-diagnostics-complaint">${translated(t, 'Describe a synthetic demo complaint (English, Roman Urdu, or Urdu)')}</label><textarea id="network-diagnostics-complaint" name="complaint" maxlength="${MAX_COMPLAINT_LENGTH}" rows="3" aria-describedby="network-diagnostics-help" required></textarea><p id="network-diagnostics-help" class="muted">${translated(t, 'Use a fictional demo complaint only. Complaint text is processed locally in this browser and is not saved or sent.')}</p><button class="button primary" type="submit">${translated(t, 'Run simulated check')}</button></form><p class="network-diagnostics__status" id="network-diagnostics-status" role="status" aria-live="polite" aria-atomic="true"></p><div id="network-diagnostics-results"></div></div>`;
}

export function mountNetworkDiagnosticsPanel(root, { t = (message) => message } = {}) {
  if (!root || root.id !== 'admin-network-diagnostics') return false;
  const content = root.querySelector('.network-diagnostics__content');
  if (!content) return false;
  content.innerHTML = renderExperience(t);
  const provider = new MockDiagnosticsProvider();
  const form = content.querySelector('#network-diagnostics-form');
  const identifierTypeInput = content.querySelector('#network-diagnostics-identifier-type');
  const identifierInput = content.querySelector('#network-diagnostics-identifier');
  const complaintInput = content.querySelector('#network-diagnostics-complaint');
  const status = content.querySelector('#network-diagnostics-status');
  const results = content.querySelector('#network-diagnostics-results');
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
