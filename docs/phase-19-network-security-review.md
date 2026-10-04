# Phase 19 — synthetic network diagnostics security review

**Review date:** 2026-10-05  
**Scope:** local synthetic diagnostics, device-registry and change-plan contracts, fixed network knowledge, lazy-loading/UI guards, and related tests. No live account, customer record, provider, router, RADIUS, OLT, or other device was checked.

## Finding and disposition

The UI and `runSyntheticDiagnostics` limited complaints to 500 characters, but the exported `classifySyntheticComplaint` function did not enforce that bound itself. A direct caller could therefore make the classifier process arbitrarily large strings. This was an input-boundary hardening gap, not a demonstrated remote exploit: the current UI validates complaints and the feature has no external input or live integration. Both exported entry points now require plain strings and enforce the 500-character raw-input limit before trimming or normalizing. The form handler applies the same raw-length check before trimming, and NFKC normalization remains intact for supported English, Roman Urdu, and Urdu-compatible inputs.

## Controls reviewed

Diagnostics and knowledge remain separate dynamic imports, with no static import from the application entry point. Diagnostics require an `admin` context with an `owner`/`admin` role before import and recheck the role before mounting; knowledge loading is separately guarded.

Diagnostics accept only the built-in simulation provider and allowlisted synthetic fixture, complaint scenario, and diagnostic-step identifiers. Device resolution requires a module-created registry, an exact organization/device or explicit same-organization customer mapping, a declared read-only capability, and an unambiguous connected synthetic adapter. Unknown and ambiguous matches fail closed; there is no default-device fallback. User-controlled text is escaped in rendered HTML and attribute contexts, while knowledge links are fixed to the source allowlist. Findings keep synthetic and unavailable states distinct from live status.

Change-plan previews remain blocked and unapplied. Risk labels and confirmation fields are informational only: every plan reports `executionPermitted: false`, no applied change, unavailable post-checks, and an unverified outcome. Simulation history stores only allowlisted fixture/scenario/status/timestamp metadata in memory, excludes complaint and customer fields, is capped at 10 entries, and starts empty for each new panel. Reviewed local modules contain no network, Supabase, browser-storage, database-write, external-AI, vendor-client, command-execution, or device-action path; registry results do not return caller-supplied raw vendor data or credential fields.

## Verification

`node --test tests/network-diagnostics.test.js` — **28 passed**. `npm test` — **392 passed**. `npm run build` — **passed**; Vite emitted diagnostics and knowledge as separate chunks. It also reported the existing main-bundle size warning (>500 kB); this change introduced no chunking regression. `npm run test:db` — **all 3 pgTAP suites passed** (116 assertions) on the repository script's disposable PostgreSQL 16 cluster with Unix-socket-only access.

The Admin check reviewed here controls access to a synthetic UI only; it is not a server-side authorization mechanism for future device access. Any future live integration would require a separate security review and server-side authorization. No live device, customer-data, provider, or deployment behavior is inferred from these code/tests-only checks.
