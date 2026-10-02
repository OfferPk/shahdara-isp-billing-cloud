# Shahdara Fiber Net — Cloud Portal

This repository contains only the isolated Supabase cloud edition of the Shahdara ISP billing portal. It does not contain the original offline-first app, browser storage, backups, or customer records. The offline app and its Pages site remain separate and unchanged. No customer or business billing data has been entered in this project.

## GitHub Pages deployment

The GitHub Actions workflow tests the cloud app, validates its frontend configuration, builds the Vite app, and deploys only `dist/` to GitHub Pages. It uses the approved non-production project URL `https://qkdsuvmlutkatcqoewkh.supabase.co` and the repository Actions variable `VITE_SUPABASE_PUBLISHABLE_KEY`. That publishable/anon key is public frontend configuration and is embedded in the browser bundle. Never place database passwords, service-role keys, or admin API keys in the repository or build configuration.

## Owner access and invitation status

The isolated non-production project has the cloud schema and price-history trigger correction applied. The Shahdara Fiber Net organization and its single owner membership are provisioned. A first-owner invitation has been sent through Supabase Auth, but the owner has not accepted it yet. This site does not confirm email delivery or acceptance, and it does not display the owner's email address.

The owner must accept the invitation first, then use the invited email address on the sign-in page to request a secure email magic link. Self-service sign-up remains disabled. No customer records or other customer/business billing data have been entered. The corrective SQL review patch has already been applied; do not reapply it.

## Company branding

An authenticated organization **owner** can edit the public company display name, support phone, address, and logo from the Admin **Company profile** section. This display profile is separate from the canonical organization row used for membership and RLS. Customers see only the branding row for the organization linked to their own portal account, along with the provider contact card. Provider contact details do not come from or overwrite `customer_private_details.phone`. Existing customer receipts and the customer’s own existing bills can be printed with the public company identity; printing does not record a payment.

Logos are uploaded to the dedicated public `organization-branding` bucket, limited to PNG/JPEG/WebP and 1 MiB. The browser checks file signatures and decoded dimensions (maximum 4096×4096); storage policies independently check raster MIME metadata, size, and the authenticated owner’s organization folder. SVG and arbitrary remote logo URLs are not accepted. The additive `20261002162113_organization_branding` migration was applied only to the approved non-production project `qkdsuvmlutkatcqoewkh`; it does not alter customer rows. The Pages workflow does not apply database migrations.

Customer invitations are handled by the separately deployed `invite-customer` Edge Function in the approved non-production project. Gateway JWT verification is enabled; the function also validates the exact browser Origin, verifies the caller, checks owner/admin membership in the requested organization, and validates that the customer belongs to that organization. A server-only reservation serializes duplicate and concurrent requests before Auth is called. New requests are limited to 5 per administrator/hour, 3 per email digest/hour, and 20 per organization/hour. The workflow stores only a SHA-256 email digest in its unresolved request row and clears it after linking; rate-limit digest buckets expire within 24 hours. A random request marker plus the same email digest can recover an Auth invite if the link step fails or the function stops between Auth and database updates. Repeating the same customer/email is idempotent and never sends a second invitation; unresolved or conflicting state stops for administrator review. Account linking is performed only by service-role-only database functions, not by browser writes. Errors and responses do not expose the email address or Auth user ID, and the function does not log request PII.

`APP_ORIGIN` and `APP_REDIRECT_URL` are server-only URL settings; the function uses Supabase's hosted server-side `SUPABASE_SERVICE_ROLE_KEY` and does not store that key in this repository, the browser, or Actions. A successful response means the Auth invitation request was accepted (or an earlier request was recovered) and the account link was created; it does not confirm email delivery. No customer invitation email or Auth magic link is sent by the test suite or deployment. The Pages workflow builds and deploys only the browser `dist/` artifact; it does not deploy the Edge Function, create Auth users, send invitations, or apply database changes. Apply `20261002120000_customer_invitation_lifecycle.sql` to the approved staging project and deploy `invite-customer` separately. Do not weaken RLS or use anonymous access as a bootstrap shortcut.

## Local development and tests

Requires Node.js 20.19+ or 22.12+ and npm.

```sh
cp .env.example .env.local
# Set only the approved project URL and publishable/legacy anon key in .env.local.
npm ci
npm test
npm run build
npm run dev
```

`.env.local` is ignored by Git. `npm test` covers synthetic ledger behavior, invitation authorization/CORS/validation/linking behavior using mocked clients, branding validation/printing and static security contracts, Supabase client configuration and query adapters, and the price-history trigger correction. It does not run pgTAP locally; the 35-assertion company-branding pgTAP suite runs with synthetic fixtures inside a transaction that is rolled back on the approved staging database. A local `supabase test db` run requires the Supabase CLI and Docker.

This remains a review edition, not a production-ready replacement or full offline-parity port. It has no offline sync/outbox, conflict workflow, multi-organization chooser, operational monitoring/alerting, backup-restore rehearsal, or independent penetration test. The staging invitation lifecycle has unit/contract coverage, but email delivery and customer sign-in still require a designated synthetic test inbox. Keep the original offline app authoritative until the owner has accepted the invitation and confirmed access, integration review, and a reconciliation rehearsal are complete.
