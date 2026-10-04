const MINIMUM_GROUP_SIZE = 3;
const SAMPLE_WINDOW_MINUTES = 10;
const SYNTHETIC_RECORD_ID = /^SIM-COMPLAINT-[0-9]{3}$/;
const SYNTHETIC_DEPENDENCY_ID = /^SIM-[A-Z0-9][A-Z0-9-]*$/;
const SYNTHETIC_SYMPTOM_CODE = /^DEMO-[A-Z0-9][A-Z0-9-]*$/;

export const SYNTHETIC_NETWORK_COMPLAINTS = Object.freeze([
  Object.freeze({
    id: 'SIM-COMPLAINT-001',
    deviceId: 'SIM-DEVICE-DEMO-A',
    interfaceId: 'SIM-IFACE-DEMO-UPLINK-A',
    symptomCode: 'DEMO-INTERMITTENT-DROPS',
    sampleOffsetMinutes: 0,
    complaint: 'The internet keeps disconnecting.',
    language: 'en',
    direction: 'ltr',
    synthetic: true,
  }),
  Object.freeze({
    id: 'SIM-COMPLAINT-002',
    deviceId: 'SIM-DEVICE-DEMO-A',
    interfaceId: 'SIM-IFACE-DEMO-UPLINK-A',
    symptomCode: 'DEMO-INTERMITTENT-DROPS',
    sampleOffsetMinutes: 4,
    complaint: 'Internet baar baar disconnect hota hai.',
    language: 'ur-Latn',
    direction: 'ltr',
    synthetic: true,
  }),
  Object.freeze({
    id: 'SIM-COMPLAINT-003',
    deviceId: 'SIM-DEVICE-DEMO-A',
    interfaceId: 'SIM-IFACE-DEMO-UPLINK-A',
    symptomCode: 'DEMO-INTERMITTENT-DROPS',
    sampleOffsetMinutes: 8,
    complaint: 'انٹرنیٹ بار بار بند ہو جاتا ہے۔',
    language: 'ur',
    direction: 'rtl',
    synthetic: true,
  }),
  Object.freeze({
    id: 'SIM-COMPLAINT-004',
    deviceId: 'SIM-DEVICE-DEMO-B',
    interfaceId: 'SIM-IFACE-DEMO-ACCESS-B',
    symptomCode: 'DEMO-SLOW-SPEED',
    sampleOffsetMinutes: 5,
    complaint: 'رفتار سست ہے۔',
    language: 'ur',
    direction: 'rtl',
    synthetic: true,
  }),
]);

function isSyntheticRecord(record) {
  return Boolean(record && typeof record === 'object'
    && record.synthetic === true
    && SYNTHETIC_RECORD_ID.test(String(record.id ?? ''))
    && Number.isFinite(record.sampleOffsetMinutes)
    && record.sampleOffsetMinutes >= 0);
}

function hasCompleteSharedEvidence(record) {
  return SYNTHETIC_DEPENDENCY_ID.test(String(record.deviceId ?? ''))
    && SYNTHETIC_DEPENDENCY_ID.test(String(record.interfaceId ?? ''))
    && SYNTHETIC_SYMPTOM_CODE.test(String(record.symptomCode ?? ''));
}

export function groupSyntheticComplaintRecords(records, {
  minimumGroupSize = MINIMUM_GROUP_SIZE,
  windowMinutes = SAMPLE_WINDOW_MINUTES,
} = {}) {
  if (!Array.isArray(records)) throw new TypeError('Synthetic complaint records must be an array.');
  if (!Number.isSafeInteger(minimumGroupSize) || minimumGroupSize < 2
      || !Number.isFinite(windowMinutes) || windowMinutes < 0) {
    throw new RangeError('Synthetic grouping needs a valid threshold and sample window.');
  }

  const seenIds = new Set();
  const syntheticRecords = records.filter((record) => {
    if (!isSyntheticRecord(record) || seenIds.has(record.id)) return false;
    seenIds.add(record.id);
    return true;
  });
  const buckets = new Map();
  for (const record of syntheticRecords) {
    if (!hasCompleteSharedEvidence(record)) continue;
    const dependencyKey = JSON.stringify([record.deviceId, record.interfaceId, record.symptomCode]);
    const bucket = buckets.get(dependencyKey) ?? [];
    bucket.push(record);
    buckets.set(dependencyKey, bucket);
  }

  const groups = [];
  const groupedIds = new Set();
  for (const bucket of buckets.values()) {
    const ordered = [...bucket].sort((left, right) => (
      left.sampleOffsetMinutes - right.sampleOffsetMinutes || left.id.localeCompare(right.id)
    ));
    let start = 0;
    while (start < ordered.length) {
      let end = start + 1;
      while (end < ordered.length
        && ordered[end].sampleOffsetMinutes - ordered[start].sampleOffsetMinutes <= windowMinutes) end += 1;
      const matching = ordered.slice(start, end);
      if (matching.length >= minimumGroupSize) {
        const first = matching[0];
        const complaintIds = Object.freeze(matching.map(({ id }) => id));
        for (const id of complaintIds) groupedIds.add(id);
        groups.push(Object.freeze({
          groupId: `SIM-GROUP-${String(groups.length + 1).padStart(3, '0')}`,
          deviceId: first.deviceId,
          interfaceId: first.interfaceId,
          symptomCode: first.symptomCode,
          complaintIds,
          recordCount: matching.length,
          sampleSpanMinutes: matching.at(-1).sampleOffsetMinutes - first.sampleOffsetMinutes,
          simulationOnly: true,
          liveDataChecked: false,
          liveCallsMade: false,
          recordsPersisted: false,
        }));
        start = end;
      } else {
        start += 1;
      }
    }
  }

  return Object.freeze({
    groups: Object.freeze(groups),
    ungroupedComplaintIds: Object.freeze(syntheticRecords
      .filter(({ id }) => !groupedIds.has(id))
      .map(({ id }) => id)),
    simulationOnly: true,
    liveDataChecked: false,
    liveCallsMade: false,
    recordsPersisted: false,
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

function renderSample(record, t) {
  const titleId = `network-correlation-${record.id.toLowerCase()}`;
  return `<li><article class="network-diagnostics__correlation-record" aria-labelledby="${titleId}"><h5 id="${titleId}">${translated(t, 'Synthetic sample record')} · ${escapeHtml(record.id)}</h5><q lang="${escapeHtml(record.language)}" dir="${escapeHtml(record.direction)}">${escapeHtml(record.complaint)}</q><dl><div><dt>${translated(t, 'Fake device')}</dt><dd>${escapeHtml(record.deviceId)}</dd></div><div><dt>${translated(t, 'Fake interface')}</dt><dd>${escapeHtml(record.interfaceId)}</dd></div><div><dt>${translated(t, 'Sample symptom code')}</dt><dd>${escapeHtml(record.symptomCode)}</dd></div><div><dt>${translated(t, 'Sample minute offset')}</dt><dd>${escapeHtml(record.sampleOffsetMinutes)} ${translated(t, 'minutes into this fixed demo')}</dd></div></dl></article></li>`;
}

function renderGroup(group, t) {
  return `<li><article class="network-diagnostics__correlation-group"><h4>${translated(t, 'Possible shared-dependency pattern · demo only')} · ${escapeHtml(group.groupId)}</h4><p><strong>${escapeHtml(group.recordCount)} ${translated(t, 'fictional sample records')}</strong> ${translated(t, 'share the same fake device, interface, and symptom code within ten sample minutes.')}</p><dl><div><dt>${translated(t, 'Shared fake device')}</dt><dd>${escapeHtml(group.deviceId)}</dd></div><div><dt>${translated(t, 'Shared fake interface')}</dt><dd>${escapeHtml(group.interfaceId)}</dd></div><div><dt>${translated(t, 'Shared sample symptom')}</dt><dd>${escapeHtml(group.symptomCode)}</dd></div><div><dt>${translated(t, 'Sample record IDs')}</dt><dd>${group.complaintIds.map(escapeHtml).join(', ')}</dd></div></dl><p>${translated(t, 'This illustrates a possible common-cause incident grouping, not a confirmed cause or a real incident.')}</p></article></li>`;
}

function renderUnavailableFindings(t) {
  const checks = ['Router', 'WAN', 'DNS', 'OLT'];
  return `<section class="network-diagnostics__correlation-unavailable" aria-labelledby="network-correlation-unavailable-title"><h4 id="network-correlation-unavailable-title">${translated(t, 'Live network findings · unavailable')}</h4><ul aria-label="${translated(t, 'Unavailable live network checks')}">${checks.map((name) => `<li><strong>${translated(t, `${name} finding`)}</strong><span>${translated(t, 'Unavailable · no live network data was checked')}</span></li>`).join('')}</ul></section>`;
}

export function renderSyntheticIncidentCorrelationDemo(t = (message) => message) {
  const result = groupSyntheticComplaintRecords(SYNTHETIC_NETWORK_COMPLAINTS);
  const sampleRecords = SYNTHETIC_NETWORK_COMPLAINTS;
  const unmatched = result.ungroupedComplaintIds.map((id) => sampleRecords.find((record) => record.id === id)).filter(Boolean);
  const groupedMarkup = result.groups.length
    ? `<ul class="network-diagnostics__correlation-groups" aria-label="${translated(t, 'Synthetic incident groups')}">${result.groups.map((group) => renderGroup(group, t)).join('')}</ul>`
    : `<p class="network-diagnostics__correlation-empty" role="status">${translated(t, 'No synthetic group met the minimum shared-evidence rule.')}</p>`;
  const ungroupedMarkup = unmatched.map((record) => (
    `<article class="network-diagnostics__correlation-unrelated"><h4>${translated(t, 'Unrelated sample · not grouped')} · ${escapeHtml(record.id)}</h4><q lang="${escapeHtml(record.language)}" dir="${escapeHtml(record.direction)}">${escapeHtml(record.complaint)}</q><p>${translated(t, 'Its fake dependency and symptom do not match the shared demo group; it is not included.')}</p></article>`
  )).join('');
  return `<section class="network-diagnostics__correlation" aria-labelledby="network-correlation-demo-title"><p class="network-diagnostics__correlation-notice" role="note"><strong>${translated(t, 'Simulation only · no live network/customer data checked')}</strong> ${translated(t, 'This fixed demo is not an automatic watcher and does not load real complaints.')}</p><h3 id="network-correlation-demo-title">${translated(t, 'Network-wide complaint grouping · synthetic demo')}</h3><p>${translated(t, 'This illustration groups only fictional sample records with the same fake device, interface, and pre-labeled symptom code inside a ten-minute sample window. A shared pattern does not prove a cause.')}</p><p class="network-diagnostics__correlation-status" role="status" aria-live="polite" aria-atomic="true">${result.groups.length ? translated(t, 'Three synthetic complaint samples meet this demo grouping rule; one unrelated synthetic sample stays separate.') : translated(t, 'No synthetic group met the minimum shared-evidence rule.')}</p><h4>${translated(t, 'Fixed multilingual sample records')}</h4><ol class="network-diagnostics__correlation-records" aria-label="${translated(t, 'Fictional sample complaints in English, Roman Urdu, and Urdu')}">${sampleRecords.map((record) => renderSample(record, t)).join('')}</ol><h4>${translated(t, 'Possible incident grouping')}</h4>${groupedMarkup}${ungroupedMarkup}${renderUnavailableFindings(t)}<p class="network-diagnostics__correlation-footer">${translated(t, 'No incident was created, nothing was saved, and no remediation or network action is offered.')}</p></section>`;
}
