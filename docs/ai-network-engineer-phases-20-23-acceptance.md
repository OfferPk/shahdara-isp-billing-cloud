# AI Network Engineer — Phases 20–23 acceptance matrix

**Baseline:** PR #64 merge `ccd115aa` on `origin/main`. **Work branch:** `feat/network-engineer-phases-20-23-acceptance`. “Verified” below means local source/tests only; synthetic evidence is not live customer or router evidence. No phase is claimed fully complete.

## Phase 20 — Fail-safe

| Acceptance point | Verified locally | Blocked or unverified |
|---|---|---|
| Uncertain, unsupported, or ambiguous symptom | Deterministic local classification returns no diagnosis. Regression tests assert zero evidence lookups, zero `fetch`/network calls, and no success result. | No live diagnostic tool exists to test against a real device. |
| Provider/tool failure and success claims | A synthetic evidence-provider exception propagates without a result; the renderer rejects any result whose state is not `simulated-only`, or that claims live checks, changes, or restoration. | Real tool timeout, retry, and verification behavior cannot be tested because there is no connected provider. |

Evidence: `src/network-diagnostics.js`; `tests/network-diagnostics.test.js` (“unsupported and ambiguous complaints stop before evidence lookup…”, “synthetic evidence-provider failure…”, result rendering checks). All simulated outputs remain fictional, unapplied, and unverified.

## Phase 21 — Existing System Protection

| Acceptance point | Verified locally | Blocked or unverified |
|---|---|---|
| Billing, authentication, and customer behavior | The change touches the diagnostics module, its tests, and documentation only; it changes no billing/auth/customer implementation, Supabase function, migration, or existing schema. Full existing tests and local disposable pgTAP suites pass. | Passing local tests is not a new live-data or production behavior check. |
| Existing performance/mobile behavior | PR #64’s separate initial-load/mobile record is preserved under `docs/initial-load-mobile-readiness.md`; diagnostic, analytics, and knowledge lazy imports remain split in the build. | No new browser session against Supabase or deployed Pages was used for this work. |

Relevant regression suites include `tests/admin-bills.test.js`, `tests/auth-flows.test.js`, `tests/customer-list.test.js`, `tests/customer-portal.test.js`, `tests/customer-usage.test.js`, `tests/portal-data.test.js`, and the full repository suite. `npm run test:db` applies repository migrations only to its disposable local PostgreSQL cluster; no Supabase or production migration was run.

## Phase 22 — Testing

| Case | Actual offline coverage | Boundary / status |
|---|---|---|
| Synthetic customer selection, wrong and multiple matches | `network-diagnostics.test.js` checks exact fixture identifiers, wrong-prefix/suffix and unknown matches, duplicate-name candidates, and explicit selection data. UI code requires a listed synthetic fixture. | Synthetic fixture search only; actual customer lookup and browser click-flow are not verified here. |
| Synthetic device/router lookup | `network-device-registry.test.js` covers exact same-organization resolution, explicit customer mapping, zero/duplicate/ambiguous matches, no default-device fallback, and disconnected device/adapter states. | Registry resolution is metadata-only. No router is connected or queried. |
| PPPoE, package, bandwidth | Synthetic fixtures include PPPoE identifiers; the slow-profile scenario contrasts a fictional 20 Mbps package with a fictional 5 Mbps profile. Live PPPoE session history and measured throughput are explicitly unavailable. | Real customer PPPoE status, package assignment, bandwidth allocation, and speed tests are not implemented or tested. |
| Diagnosis and uncertain symptoms | Deterministic English, Roman Urdu, and Urdu phrase tests cover no-internet, slow-profile, and intermittent scenarios; unsupported/multi-symptom cases fail closed. | No external AI diagnosis or live root-cause determination. |
| Low, medium, high risk | `network-diagnostics.test.js` and `network-change-plan.test.js` cover all risk classes, wrong/unknown risk, confirmation preview rules, and no execution. | Every change remains blocked and `executionPermitted: false`. |
| Disconnected device | Device and adapter disconnection return sanitized `unavailable` results in `network-device-registry.test.js`. | No real connection state was read. |
| Before/after, verification, rollback | `network-change-plan.test.js` covers fictional pre-state provenance, unavailable post-checks, unverified outcome, and rollback reference only for valid synthetic pre-state. | No real before/after evidence or executable rollback exists; these are not implemented or tested. |
| Action/session log | `network-diagnostics.test.js` proves recent simulations retain allowlisted in-memory metadata and explicitly are **not** an action log. | No real network action or action/session audit log is implemented; there are no real actions to audit. |
| Authentication/authorization | Tests check owner/admin UI gating before and after the diagnostics lazy import; existing auth/security and pgTAP suites pass locally. | This UI gate is not server-side authorization for future device operations. No action broker exists. |
| Mocks and failure handling | Diagnostics, device registry, and change-plan contracts use synthetic fixtures; tests reject unsupported tools and verify local provider failure makes no success claim or network call. | No connected customer, router, RADIUS, OLT, or provider mock/live integration was contacted. |

## Phase 23 — Implementation Style

Safe, reversible offline work was carried through autonomously without repeated routine permission requests. This records an execution principle, not a new runtime executor: it does not authorize invented live data, external calls, or actions against a router/customer. Real operations, verification, and rollback remain unavailable and unverified.

## Exact local verification and release state

- `node --test tests/network-diagnostics.test.js`: **30 passed, 0 failed**.
- `npm test`: **395 passed, 0 failed**.
- `npm run build`: **passed**; the build kept diagnostics, knowledge, analytics/trend, and Roman Urdu in separate chunks.
- `npm run test:db`: **3 disposable-local pgTAP suites passed; 116 assertions** (35 + 39 + 42). The script used a temporary PostgreSQL 16 cluster with Unix-socket-only access and cleaned it up.
- No live queries/writes, production or Supabase access, secrets, external AI, RouterOS, RADIUS, OLT, or customer/provider access were used. Repository migrations ran only against the disposable local pgTAP cluster; none were applied to Supabase or production.
- This branch has **not** been pushed; no new PR, GitHub CI run, merge, or Pages release occurred. The GitHub connector is disabled in this session, and the CLI rejected access; it was not enabled. The PR #64 merge and Pages release remain historical baseline state, not deployment of this branch.
