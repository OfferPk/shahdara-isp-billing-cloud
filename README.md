# Shahdara Fiber Net — Cloud Portal

This repository contains only the isolated Supabase cloud edition of the Shahdara ISP billing portal. It does not contain the original offline-first app, browser storage, backups, or customer records. The offline app and its Pages site remain separate and unchanged. No customer or business billing data has been entered in this project.

## GitHub Pages deployment

The GitHub Actions workflow tests the cloud app, validates its frontend configuration, builds the Vite app, and deploys only `dist/` to GitHub Pages. It uses the approved non-production project URL `https://qkdsuvmlutkatcqoewkh.supabase.co` and the repository Actions variable `VITE_SUPABASE_PUBLISHABLE_KEY`. That publishable/anon key is public frontend configuration and is embedded in the browser bundle. Never place database passwords, service-role keys, or admin API keys in the repository or build configuration.

## Owner access and invitation status

The isolated non-production project has the cloud schema and price-history trigger correction applied. The Shahdara Fiber Net organization and its single owner membership are provisioned. A first-owner invitation has been sent through Supabase Auth, but the owner has not accepted it yet. This site does not confirm email delivery or acceptance, and it does not display the owner's email address.

The owner must accept the invitation first, then use the invited email address on the sign-in page to request a secure email magic link. Self-service sign-up remains disabled. No customer records or other customer/business billing data have been entered. The corrective SQL review patch has already been applied; do not reapply it.

Customer invitations are unavailable until the `invite-customer` Supabase Edge Function is separately deployed. This repository deployment does not deploy that function, create Auth users, send invitations, apply database changes, or change Supabase Auth settings. Do not weaken RLS or use anonymous access as a bootstrap shortcut.

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

`.env.local` is ignored by Git. `npm test` covers synthetic ledger behavior, static security contracts, Supabase client configuration and query adapters, and the price-history trigger correction. It does not run pgTAP; the isolated-project review run is already complete. A local `supabase test db` run requires the Supabase CLI and Docker.

This remains a review edition, not a production-ready replacement or full offline-parity port. It has no offline sync/outbox, conflict workflow, multi-organization chooser, invitation recovery, operational monitoring, rate-limit review, or independent penetration test. Keep the original offline app authoritative until the owner has accepted the invitation and confirmed access, integration review, and a reconciliation rehearsal are complete.
