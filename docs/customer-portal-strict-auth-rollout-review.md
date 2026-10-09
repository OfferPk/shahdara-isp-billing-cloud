# Customer portal BFF rollout — production status

**Owner authorization:** The owner approved the complete strict BFF rollout, including the fixed shared customer password, create-only account provisioning, Pages publication, and the two named login checks. The accepted residual risk is that a customer who obtains both a private synthetic Auth alias and the shared password could potentially sign in directly to Supabase Auth and change that Auth password; the portal itself exposes no password-change or recovery flow.

**Current status:** The production BFF schema is applied and versioned below. PR #77 remains open and unmerged. Its code and local test/build checks are ready, but required GitHub checks must pass on the final commit. No BFF Edge Functions are deployed and no customer Auth accounts have been provisioned in this rollout.

## Production facts and boundaries

- Production Supabase project: `pocvrbwcfvtsupgdlouv`. The requested PPPoE usernames `raja-arif` and `bajwa-house` exist in `public.customers`; this verifies their mappings only, not that customer passwords already work.
- Subscriber plan assignments are not uniform: 91 customers are on 5 Mbps / 150 GB, 6 on 15 Mbps / 2000 GB, and 4 have legacy plan labels. The portal must show each customer’s actual plan and must not change assignments or claim all 101 are on 5/150.
- October 2026 has 91 recorded bills for 91 customers, due 15 October; ten customers have no October bill. The dashboard uses only recorded amount, due date, and receipt-allocation status. It will not create or alter bills, receipts, or allocations, and will not display Rs 1,500 for accounts without that recorded bill amount.
- Production has no trusted current-month usage feed/poller. Usage and quota progress remain unavailable until a trusted monthly row exists; no sample usage or fabricated progress bar is permitted.
- GitHub Pages is static and there is no configured/reachable Node telemetry API for customer live speed. The live graph remains Telemetry Pending until the separate Node API and secure RouterOS API-SSL/private-network path are available. No RouterOS PPPoE secrets are available or used.
- Approved customer-support WhatsApp destination: `+923155669955`. Customer-private phone/address fields are excluded from the BFF response.

## Applied production schema

The canonical migration is [`20261009083823_customer_portal_bff_auth.sql`](../supabase/migrations/20261009083823_customer_portal_bff_auth.sql), matching production’s recorded migration version `20261009083823` (`customer_portal_bff_auth`). Supabase MCP confirmed four private BFF tables are present, RLS-enabled, and empty; the eleven BFF RPCs grant execution only to `service_role` (not `anon` or `authenticated`). No customer rows, package assignments, bills, receipts, RouterOS data, Auth users, or BFF account mappings were modified or created by the migration.

The schema stores private PPPoE-to-Auth account mappings and opaque portal-token hashes; the browser will never receive Supabase Auth access/refresh tokens or synthetic aliases. Login is verified server-side, the temporary Auth session is revoked before a separate eight-hour read-only BFF token is issued, and logout/account locking revoke BFF sessions. The RPC dashboard projection is read-only and customer-scoped.

## Remaining production rollout

1. Configure the Edge Function runtime settings server-side only: `APP_ORIGIN=https://offerpk.github.io` and a newly generated `PORTAL_RATE_LIMIT_HMAC_KEY`. Keep `SUPABASE_SERVICE_ROLE_KEY` on the server; never pass it through a `VITE_*` variable or browser bundle.
2. Deploy `customer-login`, `customer-portal-data`, and `customer-portal-logout` with `verify_jwt=false` because each function enforces the approved origin and its own customer authentication/session contract. Do not deploy customer password-change or recovery endpoints for this flow.
3. Run [`scripts/provision-customer-bff-accounts.js`](../scripts/provision-customer-bff-accounts.js) in dry-run mode first, then apply only if all 101 non-archived PPPoE identities and both requested usernames pass. Provisioning reserves/preflights every mapping before creating Auth users; it creates new users only, never resets/deletes an existing Auth user, and stops on existing, conflicting, or non-active states for owner review.
4. Merge PR #77 to protected `main` only after both required checks (`app-tests` and `disposable-pgtap`) pass. The Pages workflow uses the approved public project URL and only the public publishable/anon key; its push-to-main workflow publishes the static site at [the official portal](https://offerpk.github.io/shahdara-isp-billing-cloud/).
5. After functions, accounts, and Pages are live, verify customer login and customer-specific dashboard loading only for `raja-arif` and `bajwa-house`. Confirm logout/expiry and that no Auth tokens, aliases, credentials, addresses, private phones, or invoice rows are logged or returned beyond the owner-scoped dashboard contract.

## Validation and rollback

- After the login RPC parameter was aligned with the production signature, the full local suite passed: **534 tests, 0 failures**. The production-configured Pages build succeeded. A local bundle check confirmed the approved project URL and public anon key were present and the server-only service-role key was absent.
- Vite reports the existing main JavaScript chunk is 506.57 kB raw (135.51 kB gzip), slightly above its advisory 500 kB threshold; this is a warning, not a build failure.
- If a later approved step fails, disable customer login and stop the affected rollout. Do not reinstate direct customer Auth fallback, reset/delete Auth users, drop the private schema, or alter billing. Keep the audit state for owner review and revoke/lock BFF sessions as needed.

## Out of scope

No invoice generation, payment/receipt edits, package/plan changes, RouterOS PPPoE-secret import, trusted usage-feed/poller setup, or live-speed API hosting is included in this rollout.
