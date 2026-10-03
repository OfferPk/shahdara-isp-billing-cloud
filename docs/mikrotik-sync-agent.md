# MikroTik usage sync agent (draft implementation)

This change adds a narrowly scoped Supabase Edge Function and a read-only Node.js daemon. It does **not** deploy the Edge Function, configure a router, apply a database migration, or enable production writes. The existing RPC is `public.sync_customer_bandwidth_usage(p_username text, p_bytes_in bigint, p_bytes_out bigint, p_is_online boolean, p_last_ip text)`; this implementation does not change it or write the usage table directly.

## Safety status: cumulative source not yet approved

The current agent polls RouterOS `/rest/ppp/active` for live sessions. MikroTik's current [PPP AAA documentation](https://manual.mikrotik.com/docs/authentication-authorization-accounting/ppp-aaa/) defines the `bytes` field as bytes transferred through **that connection** and says `/ppp/active` lists currently connected users. It does not document those counters as subscriber-lifetime totals across reconnects. Its first byte figure is traffic transmitted from the router's point of view (subscriber download); the second is traffic received by the router (subscriber upload).

The repository's bandwidth RPC stores a latest subscriber snapshot, with `bytes_in` representing download and `bytes_out` upload. A live-session counter therefore cannot safely replace the stored cumulative value after a reconnect, and an empty list cannot establish cumulative counters for offline subscribers. Poll gaps could also miss the final usage in a disconnected session. No durable, exactly reconciled accumulator or authoritative cumulative RouterOS/RADIUS source is established by this repository or task.

**Accordingly, the daemon will not publish RouterOS active-session counters.** It reports an aggregate `sync_skipped` outcome when sessions exist. An empty successful poll is a no-op; it never marks previous subscribers offline. The handler also requires the request scope `subscriber_cumulative` and the server-only environment gate `SYNC_AGENT_COUNTER_SOURCE_CONFIRMED=true`. Keep that gate unset until an owner has selected and lab-verified an authoritative cumulative source, reset/reconnect behavior, direction, and mapping. The happy-path offline test uses a mocked cumulative source solely to verify the transport contract; it does not certify the current RouterOS active-session source.

## Server-side function contract

- Path: `supabase/functions/sync-agent-ingest/` (`verify_jwt = false` because the daemon token is not a Supabase Auth JWT; the handler enforces its own bearer authentication).
- Authentication: `Authorization: Bearer <SYNC_AGENT_INGEST_TOKEN>`, a dedicated random secret at least 32 printable bytes. Do not use a publishable key or expose `SUPABASE_SERVICE_ROLE_KEY` to the Mini PC.
- Additional fail-closed gate: `SYNC_AGENT_COUNTER_SOURCE_CONFIRMED=true` is required before request processing can write.
- Payload: `{"counter_scope":"subscriber_cumulative","items":[{"username":"...","bytes_in":"...","bytes_out":"...","is_online":true}]}`.
- Maximum body: 64 KiB; maximum batch: 100 items. Empty `items` is an accepted no-op.
- The whole batch is validated before any RPC call. Usernames must be trimmed, nonempty, at most 128 UTF-8 bytes, unique within the batch, and already mapped by an administrator. Counters accept nonnegative safe integer JSON numbers or canonical decimal strings no greater than PostgreSQL signed `bigint`; booleans must be actual JSON booleans. Unknown fields are rejected.
- The handler calls only the existing RPC sequentially per item, converts counters to decimal strings, and always passes `p_last_ip: null`. It returns generic errors and does not return RPC internals or credentials. Partial RPC failure may leave earlier per-item writes committed; the agent serializes requests and must not retry an older snapshot after a newer one.

The service-role key is read only by the Edge Function from its server environment. It is never a daemon setting and never enters the browser bundle.

## Agent and RouterOS access

The standalone daemon is `agent/mikrotik-sync-agent.js` and uses Node.js built-ins. It polls `GET /rest/ppp/active` only, requests the minimum properties `name,bytes,session-id`, and never sends RouterOS write commands. It sends to the configured HTTPS ingestion URL only if its injected snapshot source is explicitly marked `subscriber-cumulative`; the built-in active-session poll is marked `routeros-active-session` and is blocked from publication.

TLS verification is left at Node's secure default. Configure a trusted CA bundle using `NODE_EXTRA_CA_CERTS` if the router certificate is issued by a private CA; do not use insecure TLS options or HTTP. MikroTik documents [REST over HTTPS and HTTP Basic authentication](https://manual.mikrotik.com/docs/developer-guides/rest-api/), and recommends a custom least-privilege user/group for a read-only REST client with `read`, `api`, and `rest-api` policies. Restrict the account to the Mini PC's LAN/VPN address, use firewall/service restrictions, and disable plain HTTP REST. Do not grant `write`, `test`, `sensitive`, `reboot`, or unrelated policies. The daemon does not change RouterOS settings.

All required variables and safe defaults are listed in `.env.example`. Put live values in a root-owned local environment file such as `/etc/mikrotik-sync-agent.env` with restrictive permissions; do not use `.env.local` or commit secrets. The Mini PC stores only the RouterOS credential and the dedicated ingestion token, never the Supabase service-role key. Agent logs contain aggregate counts/reason codes only, not usernames, IPs, credentials, payloads, or response bodies. Requests use finite timeouts, bounded exponential backoff with jitter, and no redirect following. Cycles are serial; a failed or incomplete poll is never converted to offline state.

The systemd template is `agent/mikrotik-sync.service`. It runs as a dedicated unprivileged `mikrotik-sync` user, treats the installation tree as read-only, and enables systemd process/filesystem hardening. Review and adjust the absolute install path in the unit if installing somewhere other than `/opt/shahdara-isp-billing-cloud`.

## Before any deployment or router connection

1. Select and document the actual cumulative source (for example, an approved accounting source), its reset/reconnect and outage/reconciliation semantics, and whether one router is authoritative for each globally unique PPPoE username.
2. Validate counter units and download/upload direction against the exact RouterOS model/version and a synthetic lab subscriber.
3. Implement and test the selected cumulative-source adapter; do not merely relabel `/ppp/active` counters. Keep the server gate unset until this verification succeeds.
4. Confirm administrator-managed `customers.pppoe_username` mappings exist; this integration never auto-creates a mapping.
5. Set the dedicated edge bearer secret and server-side service role only in the approved secret store. Never copy the service-role key to the Mini PC.
6. Deploy and canary separately in an approved non-production environment. This PR and the Pages workflow do not deploy the Edge Function, alter database state, or enable a router.

The separate read-only RADIUS adapter, closed-period aggregation constraints, and reasons standard `radacct` snapshots cannot supply monthly billing totals are documented in [FreeRADIUS accounting adapter](radius-accounting-adapter.md). That adapter does not change this guide's cumulative-only ingest contract.

## Offline checks

`npm test` includes the handler and daemon mock tests. They cover authenticated RPC invocation, prevalidation before writes, auth/size/scope guards, empty polls, timeout, normalization, no logging of subscriber identifiers, and rejection of session-scoped counters. No test contacts a real router or Supabase project.
