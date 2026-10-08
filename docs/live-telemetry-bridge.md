# Live RouterOS-to-Supabase telemetry bridge

The local bridge reads complete PPP active-session snapshots from a MikroTik router on the same private LAN and sends them to one narrowly scoped Supabase RPC. It runs only on the operator's laptop; it is not part of the GitHub Pages build, and no router or database migration runs automatically.

## Before the first run

1. Install Node.js 20.19+ or 22.12+ and install the repository dependencies once with `npm ci`.
2. Review and apply the required database changes through the approved database-owner migration process. **This code change does not apply them.** The bridge migration `supabase/migrations/20261008010000_live_telemetry_bridge.sql` depends on the existing PPPoE username / assigned-IP mapping and on `supabase/migrations/20261008003000_monthly_quota_poller_delta_aggregation.sql`. The monthly ledger migration must be applied first. Until both are approved and applied, the bridge's RPC will fail closed and will not sync or mark customers offline.
3. On the laptop connected to the router's private LAN, copy `.env.router.local.example` to `.env.router.local` and enter the router's private IP/hostname and the existing local credentials. Keep this file private; it is ignored by Git.
4. For the requested legacy RouterOS API port, use `ROUTER_PORT=8728` and `ROUTER_ALLOW_INSECURE_LOCAL=true`. The bridge accepts this only when the resolved router address is private-LAN. Port 8728 carries credentials and telemetry without transport encryption, so use it only on a trusted private LAN. No certificate, API service, user, or router configuration is changed by the bridge; its only router operation is `/ppp/active/print` with the `stats` flag and an explicit read allowlist.
5. In the same private config file set the approved `SUPABASE_URL`, publishable/anon `SUPABASE_PUBLISHABLE_KEY`, existing `SUPABASE_ORGANIZATION_ID`, and a current `SUPABASE_ADMIN_ACCESS_TOKEN` from a signed-in owner/admin account. The bridge verifies that user and organization membership before polling. It never accepts or sends a service-role key; RouterOS credentials remain local.

## Start and stop

From the repository root, the exact start command is:

```sh
npm run live:bridge
```

It polls immediately and then every 55 seconds (configurable only between 45 and 60 seconds with `LIVE_BRIDGE_INTERVAL_MS`). Stop it with `Ctrl+C`. A router failure, malformed/partial snapshot, expired Supabase session, or RPC error is logged without customer usernames and **does not** trigger an offline update. A successfully received empty active-session list is a complete snapshot and marks mapped, non-archived PPPoE customers offline.

## What each successful poll syncs

- `active_sessions`: one row per mapped PPP session, including username, session ID, uptime, caller ID, assigned IP, current session counters, online/offline state, and last-seen timestamp. This table is readable only by organization owners/admins.
- `customers.service_status`: `active` for mapped customers with a current session, otherwise `offline` for mapped, non-archived customers.
- `customer_private_details.assigned_ip` and `last_seen`: current assigned IP and poll time for online customers; assigned IP is cleared after an authoritative offline snapshot, while the last online timestamp is retained.
- `customer_bandwidth_monthly_usage`: per-session deltas from RouterOS Tx/Rx counters are forwarded to the existing Pakistan-local month ledger. Router Tx maps to customer download (`bytes_in`); router Rx maps to customer upload (`bytes_out`).

The monthly total is a **poller estimate, not billing-grade accounting**: data sent after a customer's last successful poll and before disconnect cannot be recovered. On first observation, the session's current counters are counted; reconnects use a new RouterOS session ID. The portal's quota/usage display remains advisory and must not be used for invoices, automatic throttling, or suspension.

The bridge never imports PPPoE passwords, creates customer/Auth accounts, changes router configuration, or applies SQL migrations. See also [`docs/mikrotik-sync-agent.md`](mikrotik-sync-agent.md) for the existing service-side ingestion design and its independent deployment gates.
