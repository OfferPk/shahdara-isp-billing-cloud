# Shahdara Fiber Net — Cloud Portal

This repository contains only the isolated Supabase cloud edition of the Shahdara ISP billing portal. It does not contain the original offline-first app, browser storage, backups, or customer records. The offline app and its Pages site remain separate and unchanged. No customer data is imported here.

## GitHub Pages deployment

The GitHub Actions workflow tests the cloud app, validates its frontend configuration, builds the Vite app, and deploys only `dist/` to GitHub Pages. It uses the approved non-production project URL `https://qkdsuvmlutkatcqoewkh.supabase.co` and the repository Actions variable `VITE_SUPABASE_PUBLISHABLE_KEY`. That publishable/anon key is public frontend configuration and is embedded in the browser bundle. Never place database passwords, service-role keys, or admin API keys in the repository or build configuration.

## Supabase status and sign-in limitation

The isolated non-production project already has the cloud schema and price-history trigger correction applied. Its 17-assertion synthetic pgTAP review passed, and read-only checks found the 16 public tables and `auth.users` empty. The corrective review SQL must not be reapplied.

The first administrator Auth user, organization, and owner membership have not been provisioned. Self-service sign-up is disabled, so the public page can load but portal access is not available until the owner provisions the initial administrator through an owner-controlled process. This deployment does not create Auth users, send invitations, apply database changes, or change Supabase Auth settings. Do not weaken RLS or use anonymous access as a bootstrap shortcut.

The customer invitation Edge Function remains source-only and is not deployed; customer invitations require a separately approved server-function setup.

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

`.env.local` is ignored by Git. `npm test` covers synthetic ledger behavior, static security contracts, Supabase client configuration and query adapters, and the price-history trigger correction. It does not run pgTAP; the isolated-project run described above is already complete. A local `supabase test db` run requires the Supabase CLI and Docker.

This remains a review edition, not a production-ready replacement or full offline-parity port. It has no offline sync/outbox, conflict workflow, multi-organization chooser, invitation recovery, operational monitoring, rate-limit review, or independent penetration test. Keep the original offline app authoritative until owner provisioning, integration review, reconciliation rehearsal, and separate production approval are complete.
