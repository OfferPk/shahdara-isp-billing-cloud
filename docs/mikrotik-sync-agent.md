# MikroTik usage sync agent

The standalone agent polls RouterOS active PPP sessions every 60 seconds and submits **session-scoped counter snapshots** to the authenticated ingestion function. A new additive migration, `20261008003000_monthly_quota_poller_delta_aggregation.sql`, stores durable per-session baselines and month-to-date download/upload totals. This migration is intentionally unapplied in this task; neither the database nor the Edge Function has been deployed, and no router has been connected.

## How the monthly delta works

The agent reads only `GET /rest/ppp/active` with `name,bytes,session-id`. RouterOS reports those byte counters for the current connection, not lifetime subscriber totals. The edge function validates the whole batch and invokes one service-role-only SQL RPC. That RPC locks the saved `(username, session_id)` counters, adds only the observed increase to the current Pakistan-local month, and persists the latest counter as the next baseline. A counter reset starts a new counter epoch. Reconnects with a different session ID get a separate baseline, and the database state survives an agent restart.

The monthly totals are **poller estimates, not billing-grade accounting records**. Bytes transferred after the last successful poll and before a session disconnects are not observable in a later active-session snapshot. Before the poller is first enabled, already-ended sessions are not recoverable; an active session first seen mid-month contributes the bytes present in its first snapshot. A poll that crosses the month boundary is assigned to the month in which the database observes it, so boundary attribution can be off by up to the polling interval. Treat the bar as advisory and do not use it for invoice calculations or automatic enforcement.

## Guardrails and activation

- `SYNC_AGENT_DELTA_SOURCE_CONFIRMED` is a separate server-side gate and must remain unset until the new migration and function contract have been reviewed and explicitly deployed. The agent does not carry a Supabase service-role key.
- The old `SYNC_AGENT_COUNTER_SOURCE_CONFIRMED` gate remains only for the legacy, separately verified subscriber-cumulative ingestion contract; the built-in RouterOS active-session poll never uses that contract.
- Monthly totals are read through customer-scoped row-level security. Session baselines have no customer-facing table grants. No RPC or application code disconnects, throttles, or suspends a MikroTik user.
- Package `Throttle` / `Suspend` selections remain policy metadata only. Exceeding a quota renders a **Quota exceeded** advisory badge, with an explicit statement that no router action was taken.
- The FUP package schema migration and the monthly aggregation migration are both unapplied here. They are not applied by a build, test, or preview command.

For an authorized deployment, review and apply the additive migrations through the normal database change process, deploy the Edge Function, set its dedicated bearer secret and source-confirmation gate in the approved secret store, and install the agent on the Mini PC with a read-only RouterOS account. Keep HTTPS certificate verification enabled, restrict the router account to the Mini PC/VPN address, and verify direction and delta/reset behavior against a synthetic lab subscriber before enabling writes. The systemd template runs under a dedicated unprivileged account with a read-only installation tree.

## Mock development display

In Vite development mode only, synthetic usernames matching `shahdara_user_XX` receive a stable `64.5 GB / 100 GB` example. It is visibly marked as demo traffic, is never sent to the ingestion function, and is not used for other usernames or production builds. This keeps the progress bar testable without inventing production telemetry.

## Offline checks

`npm test` covers the read-only poll shape, per-session normalization, fail-closed ingestion gate, atomic RPC payload contract, monthly migration security properties, portal RLS query, simulated progress, and advisory-only quota warning. The checks do not connect to a live RouterOS device or apply database migrations.
