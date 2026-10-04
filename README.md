# Shahdara Fiber Net — Cloud Portal

This repository contains only the isolated Supabase cloud edition of the Shahdara ISP billing portal. It does not contain the original offline-first app, browser storage, backups, or customer records. The offline app and its Pages site remain separate and unchanged. No customer or business billing data has been entered in this project.

## GitHub Pages deployment

The GitHub Actions workflow tests the cloud app, validates its frontend configuration, builds the Vite app, and deploys only `dist/` to GitHub Pages. It uses the approved non-production project URL `https://qkdsuvmlutkatcqoewkh.supabase.co` and the repository Actions variable `VITE_SUPABASE_PUBLISHABLE_KEY`. That publishable/anon key is public frontend configuration and is embedded in the browser bundle. Never place database passwords, service-role keys, or admin API keys in the repository or build configuration.

## Web app installation

The header's **Install app** button opens the browser's native PWA install prompt when that browser offers `beforeinstallprompt`; otherwise it displays instructions for the current platform. On Android, open this Pages site in Chrome if it was opened inside Cue. On iPhone or iPad, use the browser's **Share → Add to Home Screen** option (Safari is the fallback if the option is absent). This is a browser-managed web app or home-screen shortcut, not an APK download. The manifest and icons use paths relative to the GitHub Pages project subpath. No service worker or offline cache is configured, so installing the portal does not make it available offline.

## Owner access and sign-in

The isolated non-production project has the cloud schema and price-history trigger correction applied. The Shahdara Fiber Net organization and its existing owner membership are provisioned. This frontend change does not create a user, change a role, or modify Supabase Auth or database settings.

An invited account can sign in with its email and password or keep using the email magic-link option. To choose an initial password, enter the invited address and request a password-recovery email once, then follow the link back to this app and set a password. Repeated sign-ins use Supabase Auth directly and do not send email. Supabase Auth's redirect URL allow-list must include the deployed Pages URL (the same callback used by the existing magic-link flow); this repository does not change that setting. Self-service sign-up remains disabled. No customer records or other customer/business billing data have been entered. The corrective SQL review patch has already been applied; do not reapply it.

## Company branding

An authenticated organization **owner** can edit the public company display name, support phone, address, and logo from the Admin **Company profile** section. This display profile is separate from the canonical organization row used for membership and RLS. Customers see only the branding row for the organization linked to their own portal account, along with the provider contact card. Provider contact details do not come from or overwrite `customer_private_details.phone`. Existing customer receipts and the customer’s own existing bills can be printed with the public company identity; printing does not record a payment.

Logos are uploaded to the dedicated public `organization-branding` bucket, limited to PNG/JPEG/WebP and 1 MiB. The browser checks file signatures and decoded dimensions (maximum 4096×4096); storage policies independently check raster MIME metadata, size, and the authenticated owner’s organization folder. SVG and arbitrary remote logo URLs are not accepted. The additive `20261002162113_organization_branding` migration was applied only to the approved non-production project `qkdsuvmlutkatcqoewkh`; it does not alter customer rows. The Pages workflow does not apply database migrations.

Customer invitations are handled by the separately deployed `invite-customer` Edge Function in the approved non-production project. Gateway JWT verification is enabled; the function also validates the exact browser Origin, verifies the caller, checks owner/admin membership in the requested organization, and validates that the customer belongs to that organization. A server-only reservation serializes duplicate and concurrent requests before Auth is called. New requests are limited to 5 per administrator/hour, 3 per email digest/hour, and 20 per organization/hour. The workflow stores only a SHA-256 email digest in its unresolved request row and clears it after linking; rate-limit digest buckets expire within 24 hours. A random request marker plus the same email digest can recover an Auth invite if the link step fails or the function stops between Auth and database updates. Repeating the same customer/email is idempotent and never sends a second invitation; unresolved or conflicting state stops for administrator review. Account linking is performed only by service-role-only database functions, not by browser writes. Errors and responses do not expose the email address or Auth user ID, and the function does not log request PII.

`APP_ORIGIN` and `APP_REDIRECT_URL` are server-only URL settings; the function uses Supabase's hosted server-side `SUPABASE_SERVICE_ROLE_KEY` and does not store that key in this repository, the browser, or Actions. A successful response means the Auth invitation request was accepted (or an earlier request was recovered) and the account link was created; it does not confirm email delivery. No customer invitation email or Auth magic link is sent by the test suite or deployment. The Pages workflow builds and deploys only the browser `dist/` artifact; it does not deploy the Edge Function, create Auth users, send invitations, or apply database changes. Apply `20261002120000_customer_invitation_lifecycle.sql` to the approved staging project and deploy `invite-customer` separately. Do not weaken RLS or use anonymous access as a bootstrap shortcut.

## Username and temporary-password customer sign-in (draft-only)

This branch adds a staff-issued username/password option while retaining the existing invited-email magic-link fallback and disabled self-service signup. It creates a separate synthetic Auth identity, uses a one-time 24-hour temporary password, and denies customer data in RLS until the latest temporary password is changed and the server marks the account active. The server-generated synthetic `internal.shahdara.net` address is an Auth-only alias, not an inbox or proof of inbox ownership; the user-approved exception and staff identity-check/handoff policy are documented in [`docs/customer-username-password-auth.md`](docs/customer-username-password-auth.md).

The additive migration and three Edge Functions are not applied or deployed by this PR or the Pages workflow. No project settings, database, users, secrets, or customer communications are changed. Keep the PR draft until the documented isolated-staging checks verify managed-gateway IP trust, Supabase Auth rate-limit behavior behind the broker, password-change/secure-reauthentication behavior, CORS, RLS, and one-time credential failure recovery. Never put `SUPABASE_SERVICE_ROLE_KEY` or `PORTAL_RATE_LIMIT_HMAC_KEY` in the frontend or repository.

## Local development and tests

Requires Node.js 20.19+ or 22.12+ and npm.

```sh
cp .env.example .env.local
# Set only the approved project URL and publishable/legacy anon key in .env.local.
npm ci
npm test
npm run build
tests/run-local-customer-auth.sh
npm run test:db
npm run dev
```

`.env.local` is ignored by Git. `npm test` covers synthetic ledger behavior, invitation and username/password Edge Function handlers with mocked clients, branding validation/printing, auth/RLS static security contracts, Supabase client configuration and query adapters, the price-history trigger correction, and the bandwidth-usage security contract. `tests/run-local-customer-auth.sh` initializes a separate ephemeral PostgreSQL 16 cluster, applies the auth migration to synthetic fixtures, tests RLS gates, one-time lifecycle, and throttling, then stops and removes only that cluster; it never connects to Supabase or the existing local PostgreSQL cluster. `npm run test:db` creates a separate disposable PostgreSQL 16 cluster, applies repository migrations locally, runs the organization-branding and customer-bandwidth pgTAP suites with synthetic fixtures, and removes the database and cluster on exit. Neither local runner connects to staging or production. A separate `supabase test db` run requires the Supabase CLI and Docker.

The Phase 1 bandwidth mapping, row policies, and server-only sync contract are described in [`docs/customer-bandwidth-usage.md`](docs/customer-bandwidth-usage.md).

## MikroTik sync agent (draft-only)

This branch adds a narrowly scoped `sync-agent-ingest` Edge Function and a standalone, read-only Node.js daemon with a systemd template. The function calls only the existing per-customer bandwidth RPC and keeps `SUPABASE_SERVICE_ROLE_KEY` server-side. The agent polls RouterOS REST over verified HTTPS and never writes router configuration. **RouterOS `/ppp/active` byte counters are per connection, not documented subscriber-lifetime totals; the daemon deliberately refuses to publish them.** No cumulative accounting source or reset/reconnect reconciliation is currently approved, so keep the server-side `SYNC_AGENT_COUNTER_SOURCE_CONFIRMED` gate unset and do not deploy/enable the service until that semantics gap is resolved in an isolated lab. See [`docs/mikrotik-sync-agent.md`](docs/mikrotik-sync-agent.md) for the contract, least-privilege setup, and exact blocker. This work does not deploy the Edge Function, apply database changes, connect to a live router, or change production secrets.

This remains a review edition, not a production-ready replacement or full offline-parity port. It has no offline sync/outbox, conflict workflow, multi-organization chooser, operational monitoring/alerting, backup-restore rehearsal, or independent penetration test. The retained email-magic-link fallback needs a designated synthetic test inbox; the staff-issued username/password flow needs the isolated gateway, Auth, and RLS checks described above. Keep the original offline app authoritative until the owner has confirmed access, integration review, and a reconciliation rehearsal are complete.
