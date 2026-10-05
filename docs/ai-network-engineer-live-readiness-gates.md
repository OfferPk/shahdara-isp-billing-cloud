# AI Network Engineer — remaining live-readiness gates

## Decision

The supplied roadmap ends at **Phase 23**; it defines no Phase 24. The Phase 20–23 review has local/synthetic evidence, not live acceptance. The earliest remaining numbered gate is **Phase 20 — Fail-safe**, whose behavior with an actual diagnostic provider is unverified; Phase 22’s live end-to-end test matrix is also blocked by the same missing non-production customer/device environment. Existing synthetic coverage is useful and should not be reimplemented. No new runtime feature can be safely accepted until the required provider and test environment exist.

The current code intentionally remains simulation-only:

- `src/network-diagnostics.js` accepts only the built-in synthetic provider; live-only checks are unavailable, and uncertain or unsupported symptoms fail closed.
- `src/network-device-registry.js` resolves synthetic metadata only; it does not connect to or query a device.
- `src/network-change-plan.js` returns unapplied previews, unavailable post-checks, and unverified outcomes; execution is always disabled.
- The tests in `tests/network-diagnostics.test.js`, `tests/network-device-registry.test.js`, and `tests/network-change-plan.test.js` exercise those local contracts and failure cases. See the [Phases 20–23 acceptance matrix](ai-network-engineer-phases-20-23-acceptance.md) for the existing detailed coverage record.

This is not a claim that the real AI Network Engineer or live service restoration is complete. The final target experience remains gated.

## Remaining acceptance gates

| Roadmap area | What is still unverified or unavailable | Gate needed to proceed |
|---|---|---|
| Phase 20 — Fail-safe | Timeouts, failures, and verification from a real diagnostic provider cannot be observed; current provider failures are synthetic. | An approved read-only staging adapter and defined timeout/error behavior. |
| Phase 21 — Existing-system protection | Live integration behavior cannot be regression-tested against real app records or connected services. | A non-production app environment with authorized test data and a rollback/restore plan. |
| Phase 22 — Testing | Real customer identification, device mapping, PPPoE/package/bandwidth status, disconnected-provider behavior, before/after evidence, service verification, rollback, audit records, and server-side authorization are not end-to-end tested. | A staging tenant, an explicitly mapped test subscriber, and a lab device with a restricted read-only connection. |
| Phase 23 — Implementation style | This is an execution principle, not a remaining runtime feature. | No additional implementation is needed for this phase. |
| Final product objective | External-AI diagnosis and any live changes are absent. Real customer data, provider access, and device access have not been approved or connected for this work. | Separate decisions on provider/privacy, data access, and action permissions, followed by scoped implementation and review. |

The roadmap's descriptive phases for real diagnostics, action verification, rollback, and audit behavior likewise cannot be marked live-accepted from synthetic fixtures. No production, customer, device, or external-provider behavior should be inferred from the local tests.

## Operator setup checklist for a future staging phase

1. **Prepare an isolated staging environment.** Designate a non-production app/Supabase project and test organization. Use generated or explicitly approved, minimized test data; do not connect production customer records for initial validation.
2. **Provide one lab device.** Identify the vendor/model and software version, place it on a controlled management network, and use a dedicated restricted **read-only** account. Record the explicit device allowlist and secure network path. Do not start with a production router or write-capable credentials.
3. **Approve the identity mapping.** Create one explicit staging subscriber-to-device mapping and a test PPPoE identity. Confirm tenant/organization boundaries, and include wrong, missing, and duplicate mapping cases in tests.
4. **Specify the diagnostic contract.** List each permitted read-only check, its evidence source, timeout, unavailable/error result, and expected test outcome. Define what counts as verified service restoration; do not equate a connected session or a displayed profile with working internet.
5. **Decide the AI and privacy boundary.** If external AI is later selected, choose the provider/model and approve what subscriber text or identifiers may be sent, masking, retention, and language behavior. Keep provider credentials server-side in an approved secret store; never expose them to browser code or prompts.
6. **Keep changes disabled until separately reviewed.** Before any write action, define exact allowed operations, risk classes, per-action confirmation, before/after evidence, audit fields, and a safe rollback procedure. High-risk/destructive actions must remain human-initiated. This checklist does not authorize any router or customer write.
7. **Run staged acceptance before release.** Exercise successful, unavailable, timeout, ambiguous-identity, wrong-device, and failed-verification cases against the lab setup; review authorization and audit evidence; then use the protected feature-PR and deployment checks. Production access and operations require separate scope and authorization.

Until these gates are met, retain the current truthful status: **simulation available; live network/device/customer checks unavailable; no actions applied**.
