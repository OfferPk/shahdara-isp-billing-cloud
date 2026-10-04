import { NETWORK_ACTION_POLICY, previewNetworkActionPolicy } from './network-diagnostics.js';

const SYNTHETIC_SOURCE = 'synthetic-local-fixture';
const POST_CHECK_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'device-post-state', label: 'Device post-state' }),
  Object.freeze({ id: 'service-restoration', label: 'Service restoration' }),
  Object.freeze({ id: 'target-profile-state', label: 'Target profile state' }),
]);
const NO_DEVICE_BLOCKER = 'router-not-connected';
const NO_ADAPTER_BLOCKER = 'approved-adapter-unavailable';
const HIGH_RISK_BLOCKER = 'high-risk-change-not-eligible-for-simulation';

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freezeDeep(nested);
  return Object.freeze(value);
}

function requireText(value, field, maxLength = 240) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function normalizeSyntheticTarget(target) {
  if (!target || typeof target !== 'object'
      || target.type !== 'synthetic-demo-profile'
      || target.source !== SYNTHETIC_SOURCE
      || target.fictional !== true) {
    throw new TypeError('A change-plan preview requires an explicitly fictional synthetic target.');
  }
  return {
    type: 'synthetic-demo-profile',
    reference: requireText(target.reference, 'target.reference', 120),
    source: SYNTHETIC_SOURCE,
    fictional: true,
  };
}

function normalizeSyntheticPriorState(priorState) {
  if (!priorState || typeof priorState !== 'object'
      || priorState.source !== SYNTHETIC_SOURCE
      || priorState.fictional !== true) return null;

  try {
    return {
      reference: requireText(priorState.reference, 'priorState.reference', 120),
      summary: requireText(priorState.summary, 'priorState.summary', 240),
      source: SYNTHETIC_SOURCE,
      fictional: true,
    };
  } catch {
    return null;
  }
}

/**
 * Build a local-only preview contract. This function has no device, adapter,
 * persistence, or execution capability; every returned plan is unapplied.
 */
export function createSyntheticChangePlanPreview(proposal) {
  const actionId = proposal?.actionId;
  const action = NETWORK_ACTION_POLICY.find(({ id }) => id === actionId);
  if (!action) throw new RangeError('Unknown network action; no change-plan preview is available.');
  if (proposal?.risk !== action.risk) {
    throw new RangeError('Unknown or mismatched network action risk; no change-plan preview is available.');
  }

  const description = requireText(proposal.description, 'description');
  const target = normalizeSyntheticTarget(proposal.target);
  const priorState = normalizeSyntheticPriorState(proposal.priorState);
  const policyPreview = previewNetworkActionPolicy(action.id);
  const blockers = [NO_DEVICE_BLOCKER, NO_ADAPTER_BLOCKER];
  if (!priorState) blockers.push('required-synthetic-pre-state-not-captured');
  if (action.risk === 'High') blockers.push(HIGH_RISK_BLOCKER);

  const postChecks = POST_CHECK_DEFINITIONS.map(({ id, label }) => ({
    id,
    label,
    status: 'unavailable',
    available: false,
    evidenceSource: 'live-device',
    liveEvidenceAvailable: false,
    message: 'Unavailable · no live device is connected.',
  }));
  const rollback = priorState
    ? {
      status: 'synthetic-preview-only',
      available: true,
      source: SYNTHETIC_SOURCE,
      reference: priorState.reference,
      plan: 'The fictional prior state is a rollback reference only; no rollback action is available.',
    }
    : {
      status: 'unavailable',
      available: false,
      source: 'none',
      reference: null,
      plan: 'Unavailable · a valid synthetic pre-state was not captured.',
    };

  return freezeDeep({
    schemaVersion: 1,
    source: 'synthetic-change-plan-contract',
    status: 'blocked-preview-only',
    environment: {
      routerConnected: false,
      approvedAdapterAvailable: false,
      liveCustomerAvailable: false,
    },
    proposal: {
      actionId: action.id,
      risk: action.risk,
      actionLabel: action.label,
      description,
      target,
      source: 'synthetic-proposal-metadata',
    },
    preChangeState: {
      required: true,
      captured: priorState !== null,
      status: priorState ? 'synthetic-fixture-only' : 'unavailable',
      provenance: priorState ? SYNTHETIC_SOURCE : 'none',
      fictional: priorState !== null,
      reference: priorState?.reference ?? null,
      summary: priorState?.summary ?? null,
    },
    confirmationPolicy: {
      mode: 'informational-only',
      requiresActionConfirmation: policyPreview.requiresActionConfirmation,
      futureRequirement: action.futureRequirement,
      message: 'Phase 7 confirmation policy is informational here; this preview cannot approve or initiate an action.',
    },
    blockers,
    change: {
      status: 'not-applied',
      applied: false,
      executionPermitted: false,
      message: 'No change was applied; this contract has no execution capability.',
    },
    changeApplied: false,
    postChangeState: {
      captured: false,
      status: 'unavailable',
      provenance: 'no-live-device-evidence',
      liveEvidenceAvailable: false,
    },
    postChecks,
    verification: {
      status: 'unverified',
      result: 'unverified',
      evidenceSource: 'no-live-device-evidence',
      liveEvidenceAvailable: false,
      message: 'Unverified · no live evidence is available.',
    },
    rollback,
    sequence: [
      {
        stage: 'pre-change-state',
        status: priorState ? 'synthetic-fixture-only' : 'unavailable',
        provenance: priorState ? SYNTHETIC_SOURCE : 'none',
      },
      { stage: 'proposal', status: 'preview-only' },
      { stage: 'change', status: 'not-applied', applied: false },
      { stage: 'post-checks', status: 'unavailable', provenance: 'no-live-device-evidence' },
      { stage: 'verification', status: 'unverified', provenance: 'no-live-device-evidence' },
      { stage: 'rollback', status: rollback.status, provenance: rollback.source },
    ],
  });
}
