import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  NETWORK_ACTION_POLICY,
  previewNetworkActionPolicy,
} from '../src/network-diagnostics.js';
import { createSyntheticChangePlanPreview } from '../src/network-change-plan.js';

const contractSource = await readFile(new URL('../src/network-change-plan.js', import.meta.url), 'utf8');

function syntheticProposal(overrides = {}) {
  return {
    actionId: 'medium-risk-customer-profile-changes',
    risk: 'Medium',
    description: 'Preview a fictional profile adjustment from 5 Mbps to 10 Mbps.',
    target: {
      type: 'synthetic-demo-profile',
      reference: 'DEMO-CUSTOMER-001',
      source: 'synthetic-local-fixture',
      fictional: true,
    },
    priorState: {
      reference: 'DEMO-STATE-PROFILE-5MBPS',
      summary: 'Assigned profile: 5 Mbps · fictional fixture.',
      source: 'synthetic-local-fixture',
      fictional: true,
    },
    ...overrides,
  };
}

test('the contract requires a listed action and exact known risk, failing closed on unknown values', () => {
  assert.throws(
    () => createSyntheticChangePlanPreview(syntheticProposal({ actionId: 'run-router-command' })),
    /Unknown network action/,
  );
  assert.throws(
    () => createSyntheticChangePlanPreview(syntheticProposal({ risk: 'Critical' })),
    /Unknown or mismatched network action risk/,
  );
  assert.throws(
    () => createSyntheticChangePlanPreview(syntheticProposal({ risk: 'Low' })),
    /Unknown or mismatched network action risk/,
  );
  assert.throws(
    () => createSyntheticChangePlanPreview(syntheticProposal({ target: { type: 'router', reference: 'real-router' } })),
    /explicitly fictional synthetic target/,
  );
});

test('required pre-state is explicit and missing state blocks the plan and withholds rollback', () => {
  const plan = createSyntheticChangePlanPreview(syntheticProposal({ priorState: null }));
  assert.equal(plan.preChangeState.required, true);
  assert.equal(plan.preChangeState.captured, false);
  assert.equal(plan.preChangeState.status, 'unavailable');
  assert.equal(plan.preChangeState.provenance, 'none');
  assert.ok(plan.blockers.includes('required-synthetic-pre-state-not-captured'));
  assert.deepEqual(plan.rollback, {
    status: 'unavailable',
    available: false,
    source: 'none',
    reference: null,
    plan: 'Unavailable · a valid synthetic pre-state was not captured.',
  });
});

test('pre-state and post-state provenance remain distinct and every post-check is unavailable', () => {
  const plan = createSyntheticChangePlanPreview(syntheticProposal());
  assert.deepEqual(plan.preChangeState, {
    required: true,
    captured: true,
    status: 'synthetic-fixture-only',
    provenance: 'synthetic-local-fixture',
    fictional: true,
    reference: 'DEMO-STATE-PROFILE-5MBPS',
    summary: 'Assigned profile: 5 Mbps · fictional fixture.',
  });
  assert.deepEqual(plan.postChangeState, {
    captured: false,
    status: 'unavailable',
    provenance: 'no-live-device-evidence',
    liveEvidenceAvailable: false,
  });
  assert.ok(plan.postChecks.length > 0);
  assert.ok(plan.postChecks.every((check) => (
    check.status === 'unavailable'
      && check.available === false
      && check.evidenceSource === 'live-device'
      && check.liveEvidenceAvailable === false
      && check.message.startsWith('Unavailable ·')
  )));
  assert.deepEqual(plan.verification, {
    status: 'unverified',
    result: 'unverified',
    evidenceSource: 'no-live-device-evidence',
    liveEvidenceAvailable: false,
    message: 'Unverified · no live evidence is available.',
  });
});

test('the full before/proposal/no-op/after/verification/rollback sequence is explicit and ordered', () => {
  const plan = createSyntheticChangePlanPreview(syntheticProposal());
  assert.deepEqual(plan.sequence.map(({ stage }) => stage), [
    'pre-change-state', 'proposal', 'change', 'post-checks', 'verification', 'rollback',
  ]);
  assert.deepEqual(plan.sequence.map(({ status }) => status), [
    'synthetic-fixture-only', 'preview-only', 'not-applied', 'unavailable', 'unverified', 'synthetic-preview-only',
  ]);
  assert.equal(plan.proposal.source, 'synthetic-proposal-metadata');
  assert.equal(plan.proposal.target.source, 'synthetic-local-fixture');
  assert.equal(plan.status, 'blocked-preview-only');
});

test('rollback preview is available only for an explicitly fictional synthetic pre-state', () => {
  const withSyntheticState = createSyntheticChangePlanPreview(syntheticProposal());
  assert.equal(withSyntheticState.rollback.available, true);
  assert.equal(withSyntheticState.rollback.status, 'synthetic-preview-only');
  assert.equal(withSyntheticState.rollback.source, 'synthetic-local-fixture');
  assert.equal(withSyntheticState.rollback.reference, 'DEMO-STATE-PROFILE-5MBPS');
  assert.match(withSyntheticState.rollback.plan, /no rollback action is available/);

  for (const priorState of [
    null,
    { reference: 'LIVE-STATE', summary: 'Real state', source: 'router', fictional: false },
    { reference: 'INCOMPLETE', source: 'synthetic-local-fixture', fictional: true },
  ]) {
    const plan = createSyntheticChangePlanPreview(syntheticProposal({ priorState }));
    assert.equal(plan.preChangeState.captured, false);
    assert.equal(plan.rollback.available, false);
    assert.equal(plan.rollback.reference, null);
  }
});

test('low, medium and high risk all remain blocked and no path can apply a change', () => {
  for (const action of NETWORK_ACTION_POLICY) {
    const plan = createSyntheticChangePlanPreview(syntheticProposal({
      actionId: action.id,
      risk: action.risk,
    }));
    assert.equal(plan.environment.routerConnected, false);
    assert.equal(plan.environment.approvedAdapterAvailable, false);
    assert.ok(plan.blockers.includes('router-not-connected'));
    assert.ok(plan.blockers.includes('approved-adapter-unavailable'));
    assert.equal(plan.changeApplied, false);
    assert.equal(plan.change.applied, false);
    assert.equal(plan.change.executionPermitted, false);
    assert.equal(plan.change.status, 'not-applied');
    assert.equal(plan.sequence.find(({ stage }) => stage === 'change').applied, false);
    assert.equal(plan.confirmationPolicy.mode, 'informational-only');
    assert.equal(plan.confirmationPolicy.requiresActionConfirmation, previewNetworkActionPolicy(action.id).requiresActionConfirmation);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.postChecks), true);
    if (action.risk === 'High') assert.ok(plan.blockers.includes('high-risk-change-not-eligible-for-simulation'));
  }
});

test('the change-plan contract has no live-call or persistence path', () => {
  assert.doesNotMatch(contractSource, /\bfetch\s*\(|XMLHttpRequest|WebSocket|child_process|node:net|node:http|node:https|supabase|routeros|radius|olt|indexedDB|localStorage|sessionStorage|\.rpc\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(/i);
  assert.match(contractSource, /routerConnected: false/);
  assert.match(contractSource, /approvedAdapterAvailable: false/);
  assert.match(contractSource, /applied: false/);
  assert.match(contractSource, /status: 'unverified'/);
  assert.match(contractSource, /status: 'unavailable'/);

  const originalFetch = globalThis.fetch;
  let liveCalls = 0;
  globalThis.fetch = () => {
    liveCalls += 1;
    throw new Error('The synthetic change-plan contract must never call fetch.');
  };
  try {
    for (const action of NETWORK_ACTION_POLICY) {
      createSyntheticChangePlanPreview(syntheticProposal({ actionId: action.id, risk: action.risk }));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(liveCalls, 0);
});
