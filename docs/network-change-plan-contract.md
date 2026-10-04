# Network change-plan contract: Phases 8–9 readiness

This document records a **synthetic, non-executing contract** for a future change-plan workflow. It does not enable a router integration, collect live state, or perform before/after verification.

## Current contract

`src/network-change-plan.js` builds an in-memory plan from an allowlisted Phase 7 action category and explicitly fictional metadata. The target and any supplied prior state must identify themselves as `synthetic-local-fixture`; non-synthetic targets are rejected, while absent or malformed prior state is treated as not captured. A required prior state is represented explicitly.

Every plan is blocked and preview-only because no router or approved adapter is connected. Every output sets `changeApplied` and `executionPermitted` to `false`. The ordered sequence records the fictional pre-state, proposal, not-applied change, unavailable post-checks, unverified result, and rollback reference. Post-checks identify live-device evidence as their source but remain unavailable; post-change state is not captured. Verification is `unverified` with no live evidence.

A rollback reference is available only when a valid fictional pre-state was supplied. It is a reference for a hypothetical future review, not a stored snapshot, executable rollback, or claim that rollback would succeed. The Phase 7 confirmation requirement is included as informational policy only; the contract provides no confirmation control, queue, action button, or execution path. Unknown action IDs and unknown or mismatched risk values fail closed. High-risk proposals remain blocked.

The contract is pure and ephemeral. It adds no UI because displaying fabricated before/after evidence would not offer genuine operator value and could be mistaken for a real network check. It adds no persistent history, customer/router/database writes, shell, external AI, network request, or provider/device calls.

## Device-access gate

Real Phase 8–9 before/after verification and operational rollback **cannot safely proceed in the current environment**: there is no connected device, approved adapter, or live customer evidence. No connection was attempted. The synthetic contract and tests are the safe readiness work completed here; they must never be described as live verification or a fix.

Any future live phase needs its own separately authorized scope and review, a connected isolated lab device, an approved least-privilege adapter, a documented target identity and pre-state evidence source, independent post-checks, and an independently reviewed rollback design. Until then, all post-state checks remain unavailable and all results unverified.

## Verification

The unit tests assert pre-state requirements and provenance, unavailable post-state provenance, the complete plan sequence, rollback availability only with valid synthetic pre-state, no-action invariants for Low/Medium/High, informational confirmation policy, and absence of live calls. No database schema or pgTAP coverage is changed by this contract.
