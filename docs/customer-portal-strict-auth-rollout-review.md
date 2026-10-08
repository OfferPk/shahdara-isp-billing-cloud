# Customer portal BFF rollout — owner review

**Status:** tested implementation is in review-only [PR #77](https://github.com/OfferPk/shahdara-isp-billing-cloud/pull/77), still open and **not merged**. This document is **not** authorization to change production. No production migration was applied, no customer Auth users were created or reset, no bill/receipt/plan rows were changed, and nothing was deployed.

## Verified production facts

- Production project: `pocvrbwcfvtsupgdlouv`. The two requested PPPoE usernames, `raja-arif` and `bajwa-house`, exist in `public.customers`; that confirms the account mappings, **not** that either password currently authenticates.
- Subscriber plan assignments are not uniform: **91** are on `5 Mbps / 150 GB`, **6** on `15 Mbps / 2000 GB`, and **4** have legacy plan labels. The dashboard renders each account’s actual assignment; it must not claim all 101 are on 5/150 or modify plans.
- October 2026 has **91 bills for 91 customers**, all due 15 October. **Ten** customers have no October bill recorded. The dashboard reads existing amount, due date, and allocation-based Paid/Partial/Unpaid status; missing bills remain missing. No bills or receipts will be generated or changed.
- Production has quota metadata but no monthly usage/session-counter relation and no running usage poller. Until a separately approved trusted monthly feed produces a current row, monthly usage and quota percentage remain unavailable—no fabricated progress bar or demo totals.
- GitHub Pages is static. No customer-telemetry Node API base URL is configured. The prior RouterOS adapter could return mock data and used raw TCP. The local change blocks mock output on the customer live route and requires real MikroTik mode plus certificate-validated API-SSL or an explicitly configured private VPN. A separately hosted/reachable Node API and router configuration are still needed before a live speed graph can show real samples.
- The approved support WhatsApp destination is `+923155669955`. Customer-private phone/address fields are not used in the BFF payload.

## Local BFF implementation

Customer passwords are verified by Supabase Auth **server-side** against separately provisioned, random synthetic aliases. The customer browser never receives an Auth access/refresh token or alias. After password verification, the login function revokes the temporary Auth session and returns one CSPRNG-generated 256-bit opaque portal token; only its SHA-256 hash is stored, with an eight-hour expiry. The browser holds the raw token in memory only. Data and logout Edge Functions verify the token hash through service-role-only RPCs; logout and account locking revoke sessions. Customer data cannot be read through the legacy direct Supabase/RLS customer path. Admin login and admin RLS access remain separate.

The customer view renders the account name/number, actual plan and quota cap, a quota bar **only when trusted monthly usage exists**, actual current-month bill amount/due date/status when a bill exists, a WhatsApp button, and the live graph shell. The raw PPPoE username and synthetic Auth alias remain server-side; the dashboard response carries only a boolean mapping-presence flag for the graph gate. The graph stays **Telemetry Pending** until its secure Node API is actually configured. An existing bill without a recorded price/due date is shown as unrecorded rather than as Rs 0 or an invented date.

The owner has accepted the residual limitation: if a customer obtains both the private random synthetic Auth alias and the shared password, they could authenticate directly to Supabase Auth and potentially change that Auth password. The BFF prevents password change/recovery through the customer portal; it is not an Auth-level immutable-password guarantee.

## Exact production changes requiring approval

1. **Database schema:** apply the inert SQL draft at [`supabase/review/20261009140000_customer_portal_bff_auth_draft.sql`](../supabase/review/20261009140000_customer_portal_bff_auth_draft.sql). It adds private customer mapping/session/rate-limit/audit tables and service-role-only reserve/complete/lock, login-resolution, session-create/revoke, dashboard, and telemetry-resolution RPCs. It stores no password, contains no customer/bill/receipt/package writes, and is currently outside `supabase/migrations/` so the migration runner will not discover it.
2. **Edge Functions:** deploy `customer-login`, `customer-portal-data`, and `customer-portal-logout` with exact-origin checks for `https://offerpk.github.io`, `verify_jwt=false` because each validates its own request/session, and server-only runtime secrets (`SUPABASE_SERVICE_ROLE_KEY` and a newly generated `PORTAL_RATE_LIMIT_HMAC_KEY`; `APP_ORIGIN` is the Pages origin). No server secret goes in a `VITE_*` variable or browser bundle. Do not deploy customer password-change/recovery routes for this BFF flow.
3. **Customer identity creation:** after the schema and functions are active, run [`scripts/provision-customer-bff-accounts.js`](../scripts/provision-customer-bff-accounts.js) with the approved organization UUID and saved shared password injected only at runtime. It is pinned to the production project, checks for exactly 101 linked non-archived PPPoE identities and both requested usernames, defaults to dry-run, and requires `--apply` to create. In apply mode it reserves/preflights every mapping **before** creating any Auth user; an existing active mapping is left unchanged and stops the run. It uses `createUser` only, never resets or deletes an existing Auth user, and stops on non-active/conflicting states for owner review.
4. **Application and Pages:** merge the reviewed app/test changes to protected `main`; the existing Pages workflow then publishes the static site at [the official portal](https://offerpk.github.io/shahdara-isp-billing-cloud/). The current workflow already has the required public Supabase URL/publishable-key variables, so no Pages secret/config change is proposed.
5. **Live-speed dependency:** host/configure the Node telemetry API separately, set its Pages API base URL, and configure `ROUTER_DRIVER=mikrotik` plus either `ROUTER_TLS=true` with a trusted/explicit CA on API-SSL or `ROUTER_PRIVATE_VPN=true` only when the API host is actually inside that private network. The service-role key and rotated RouterOS credentials stay on that server. This hosting endpoint does not currently exist, so **live-speed verification is not part of this approval package**; until then the UI must keep telemetry pending/unavailable.
6. **Post-approval verification:** use only `raja-arif` and `bajwa-house` to verify the username/password broker, customer-specific dashboard, expiry/logout, and no Auth token/alias leakage. Verify only aggregate counts plus those two account mappings; do not print names, addresses, private phones, credentials, or invoice rows in logs.

### Explicitly out of scope

- No invoice generation, payment/receipt editing, customer plan updates, RouterOS PPPoE secret import, or monthly-usage migration/poller setup.
- No production login test before the accounts and functions exist.
- No promise that all 101 customer dashboards show `Rs 1,500`; the production dashboard will show each account’s recorded October bill, and ten currently have none.
- No claim of live RouterOS samples until the separate secure Node API is available.

## Local validation and rollback boundary

- The inert SQL draft was reviewed against production schema metadata previously; parse and static checks must pass again before any apply.
- Focused local test group: **79 passed, 0 failed** (BFF login/data/logout, no-reset provisioner contract, dashboard/quota UI, admin/customer data boundary, and secure live-traffic route).
- Local validation completed: full repository tests **534/534 pass**; Pages build succeeds; the SQL draft parses as 57 top-level statements with no customer/billing-table DML; compiled bundle scan found no server-only key names or synthetic alias domain; `git diff --check` is clean. Build warning: the main JS chunk is 506.57 kB raw (135.51 kB gzip), slightly above Vite’s 500 kB advisory threshold.
- If a later approved deployment fails, disable customer login at the Edge Function and stop the affected rollout. Do not reinstate direct customer Auth fallback, reset/delete Auth users, drop the private schema, or alter billing. Revoke/lock BFF sessions and keep audit state for owner review.

## Approval requested

Please review this plan and SQL draft, then approve or revise the **specific production scope**: apply the BFF schema, deploy the three Edge Functions, provision up to 101 customer Auth users with the saved shared fixed password, merge/publish the static app, and run the two named login checks. Live RouterOS hosting, monthly usage collection, invoice creation, and plan changes are **not** included. Approval of the earlier architecture alone is not approval to perform these production steps.
