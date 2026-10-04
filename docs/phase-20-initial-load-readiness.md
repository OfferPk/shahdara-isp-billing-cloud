# Phase 20 — initial-load and mobile readiness

This phase defers the Roman Urdu translation dictionary until a visitor selects Roman Urdu or has that preference saved. English remains the default, and a missing locale file falls back to English without blocking the setup/sign-in shell. The existing dashboard-analytics, network-diagnostics, and network-knowledge lazy imports remain unchanged; no vendor-only split or warning-threshold change was made.

## Initial load measured

The comparison uses the unchanged `de313fb` tree as the baseline and the candidate production build. In a fresh, unconfigured Chromium profile, before sign-in or any click, the browser loaded the document, the entry JavaScript, the existing `dashboard-trend` JavaScript chunk, the stylesheet, and the app icon. The default-English load did **not** request the Roman Urdu chunk, and the local-only browser guard recorded no off-origin requests.

Vite reported the entry JavaScript decreasing from **532.14 kB raw / 144.21 kB gzip** to **437.00 kB raw / 116.06 kB gzip**. Including the unchanged `dashboard-trend` chunk, initial JavaScript fell from **546.55 / 149.22 kB** to **451.41 / 121.07 kB**, a reduction of **95.14 kB raw (17.41%)** and **28.15 kB gzip (18.86%)**. The full initial HTML, CSS, entry, and trend assets decreased from **654.07 kB raw / 169.43 kB gzip** to **558.94 / 141.28 kB**; these gzip values are Vite's build estimates. The deferred locale is a separate **95.86 kB raw / 27.42 kB gzip** asset.

The production build completed without the previous 500 kB chunk advisory. This is a real reduction in the default-English entry path: the translation map is no longer parsed or fetched before the visitor needs that language.

## Mobile and offline checks

A fresh unauthenticated profile was checked at **320, 360, 390, 430, 768, and 1280 px**. At every width the document and body widths equaled the viewport, with no horizontal overflow. The first pass found the language controls were 38 px tall and the brand link was 42 px; the header controls now have 44 px minimum tap heights. The final pass found **no visible target below 44 px** at any checked width.

Chromium also confirmed that a new Roman Urdu selection fetches and applies the locale, switching back to English works, and a saved Roman Urdu preference loads before localized setup copy appears. When the browser is taken offline before a first locale request—or a saved locale request is deliberately failed—the page remains usable in English and announces the fallback. No sign-in was attempted, no customer records were queried, and no external host was contacted.

The existing synthetic-network checks continue to fail closed: live-only diagnostics remain unavailable, unknown diagnostic steps are rejected, and the risk-policy preview keeps `executionPermitted: false`. No router, RADIUS, or OLT connection was made. `npm test` passed **393/393** tests; `npm run build` passed; and `npm run test:db` passed all three suites in its disposable local PostgreSQL cluster (**35 + 39 + 42 = 116 pgTAP assertions**).

## Remaining readiness

The checked-in roadmap docs, [all 63 existing pull requests](https://github.com/OfferPk/shahdara-isp-billing-cloud/pulls), and [the issue tracker](https://github.com/OfferPk/shahdara-isp-billing-cloud/issues) contain no prior formal Phase 20–23 work items; this change records Phase 20, while Phases 21–23 have no tracked definitions or coverage to claim. No live router is connected and no live customers exist. Router identity/mapping, an approved read-only device path, and real connectivity/telemetry validation still await a device and their own authorization; the simulation-only policy cannot execute actions.

The change was squash-merged through [PR #64](https://github.com/OfferPk/shahdara-isp-billing-cloud/pull/64) as `ccd115aa` after the required `app-tests` and `disposable-pgtap` checks passed. The [Pages workflow run](https://github.com/OfferPk/shahdara-isp-billing-cloud/actions/runs/37243113094) and [post-merge test workflow](https://github.com/OfferPk/shahdara-isp-billing-cloud/actions/runs/37243113005) both succeeded. The published [internal staging portal](https://offerpk.github.io/shahdara-isp-billing-cloud/) returned HTTP 200 for the HTML, its initial assets, and the deferred locale, diagnostics, network-knowledge, and analytics chunks. One immediate asset fetch briefly returned 404; every asset returned 200 on subsequent checks. Verification fetched static files only; it did not execute the site JavaScript or contact Supabase/Auth/customer data or a router.
