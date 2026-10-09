# Customer portal BFF rollout — production status

**Owner authorization:** The owner approved the complete strict BFF rollout, including the fixed shared customer password, create-only account provisioning, Pages publication, and the two named login checks. The accepted residual risk is that a customer who obtains both a private synthetic Auth alias and the shared password could potentially sign in directly to Supabase Auth and change that Auth password; the portal itself exposes no password-change or recovery flow.

**Current status:** Production BFF schema and the least-privilege provisioning-candidate RPC are applied. Supabase recorded the latter with ledger version `20261009092355` and migration name `20261009090000_customer_portal_bff_candidates`; the tool accepts a migration name and assigns the execution timestamp as its version. PR #77 remains open and unmerged. No BFF Edge Functions are deployed, and no customer Auth accounts have been provisioned in this rollout.

## Production facts and boundaries

- Production Supabase project: `pocvrbwcfvtsupgdlouv`. The requested PPPoE usernames `raja-arif` and `bajwa-house` exist in `public.customers`; this verifies their mappings only, not that customer passwords already work.
- Subscriber plan assignments are not uniform: 91 customers are on 5 Mbps / 150 GB, 6 on 15 Mbps / 2000 GB, and 4 have legacy plan labels. The portal must show each customer’s actual plan and must not change assignments or claim all 101 are on 5/150.
- October 2026 has 91 recorded bills for 91 customers, due 15 October; ten customers have no October bill. The dashboard uses only recorded amount, due date, and receipt-allocation status. It will not create or alter bills, receipts, or allocations, and will not display Rs 1,500 for accounts without that recorded bill amount.
- Production has no trusted current-month usage feed/poller. Usage and quota progress remain unavailable until a trusted monthly row exists; no sample usage or fabricated progress bar is permitted.
- GitHub Pages is static and there is no configured/reachable Node telemetry API for customer live speed. The live graph remains Telemetry Pending until the separate Node API and secure RouterOS API-SSL/private-network path are available. No RouterOS PPPoE secrets are available or used.
- Approved customer-support WhatsApp destination: `+923155669955`. Customer-private phone/address fields are excluded from the BFF response.

## Applied production schema

The canonical migrations are [`20261009083823_customer_portal_bff_auth.sql`](../supabase/migrations/20261009083823_customer_portal_bff_auth.sql) and [`20261009092355_customer_portal_bff_candidates.sql`](../supabase/migrations/20261009092355_customer_portal_bff_candidates.sql). Production records the first as version `20261009083823` and the candidate-reader migration as version `20261009092355`, name `20261009090000_customer_portal_bff_candidates`.

The original private BFF tables remain RLS-enabled and empty. The candidate-reader RPC is owned by `postgres`, uses `SECURITY DEFINER` with an empty `search_path`, returns only `customer_id`, `organization_id`, and `pppoe_username` for non-archived PPPoE identities in the approved organization, and grants `EXECUTE` only to `service_role`. The `service_role` still has no direct `SELECT` privilege on `public.customers`; no broad table grant was made. The original BFF auth/session/dashboard RPCs and this provisioning reader are unavailable to `anon` and `authenticated`.

The BFF migration source now explicitly drops and recreates the legacy `resolve_customer_portal_login(text)` function before changing its input argument name from `p_login_id` to `p_login_username`; PostgreSQL rejects that rename through `CREATE OR REPLACE`. This is a clean-install/replay compatibility correction only. It was not reapplied to production, where the approved BFF resolver is already installed.

The schema stores private PPPoE-to-Auth account mappings and opaque portal-token hashes; the browser will never receive Supabase Auth access/refresh tokens or synthetic aliases. Login is verified server-side, the temporary Auth session is revoked before a separate eight-hour read-only BFF token is issued, and logout/account locking revoke BFF sessions. The RPC dashboard projection is read-only and customer-scoped.

## Remaining production rollout

1. Configure the Edge Function runtime settings server-side only: `APP_ORIGIN=https://offerpk.github.io` and a newly generated `PORTAL_RATE_LIMIT_HMAC_KEY`. Keep `SUPABASE_SERVICE_ROLE_KEY` on the server; never pass it through a `VITE_*` variable or browser bundle.
2. Deploy `customer-login`, `customer-portal-data`, and `customer-portal-logout` with `verify_jwt=false` because each function enforces the approved origin and its own customer authentication/session contract. Do not deploy customer password-change or recovery endpoints for this flow.
3. The updated provisioner now fetches only the three approved identity fields through the service-role-only RPC. Its default dry-run passed for **101** linked subscriber identities, including both requested usernames; the aggregate count of existing portal mappings is **0**. No Auth users or passwords were changed. Actual provisioning remains create-only, reserves/preflights all mappings before creating users, and stops for any active/conflicting/non-active state; it never resets or deletes existing Auth users.
4. Merge PR #77 to protected `main` only after both required checks (`app-tests` and `disposable-pgtap`) pass on the final pushed commit. The Pages workflow uses the approved public project URL and only the public publishable/anon key; its push-to-main workflow publishes the static site at [the official portal](https://offerpk.github.io/shahdara-isp-billing-cloud/).
5. After functions, accounts, and Pages are live, verify customer login and customer-specific dashboard loading only for `raja-arif` and `bajwa-house`. Confirm logout/expiry and that no Auth tokens, aliases, credentials, addresses, private phones, or invoice rows are logged or returned beyond the owner-scoped dashboard contract.

## Validation and rollback

- After the provisioning reader was integrated, the full local suite passed: **534 tests, 0 failures**. The prior production-configured Pages build succeeded. A local bundle check confirmed the approved project URL and public anon key were present and the server-only service-role key was absent.
- The applied candidate-reader migration and its SQL function body parse locally; security checks confirm the expected owner, `SECURITY DEFINER`, empty `search_path`, service-role-only execute, and absence of a `public.customers` table grant. The local disposable PostgreSQL 16/pgTAP replay passed all three suites after the resolver drop/recreate correction; no production migration was reapplied.
- Vite reports the existing main JavaScript chunk is 506.57 kB raw (135.51 kB gzip), slightly above its advisory 500 kB threshold; this is a warning, not a build failure.
- If a later approved step fails, disable customer login and stop the affected rollout. Do not reinstate direct customer Auth fallback, reset/delete Auth users, drop the private schema, or alter billing. Keep the audit state for owner review and revoke/lock BFF sessions as needed.

## Out of scope

No invoice generation, payment/receipt edits, package/plan changes, RouterOS PPPoE-secret import, trusted usage-feed/poller setup, or live-speed API hosting is included in this rollout.
