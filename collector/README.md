# Site-side PPPoE usage collector

This standard-library Python collector polls **only** the RouterOS active PPP session list and uploads signed snapshots to the approved isolated cloud project. It has no RouterOS write operations: it never creates, disables, removes, renews, or edits a subscriber or package. It does not open a RouterOS connection to the public internet.

## Security model

- Run this process on a trusted site computer on the same private LAN as the router.
- `ROUTEROS_URL` must be `https://` with a literal private LAN IP; hostnames, public IPs, HTTP and embedded credentials are rejected.
- HTTPS certificate verification is always enabled. For a private CA, configure `ROUTEROS_CA_CERT` to its installed PEM trust file. There is deliberately no `verify=false` mode.
- RouterOS REST credentials are read only from the collector host’s protected environment file. The username should be a dedicated read-only RouterOS identity permitted only to inspect PPP active sessions; restrict the RouterOS HTTPS management service/firewall to the collector’s private address.
- The collector stores session IDs, PPPoE usernames, counters and a durable outbox in a local SQLite database. Keep its directory private and preserve the database across restarts so pending snapshots and counter high-water state survive.
- `COLLECTOR_SITE_TOKEN` is a derived, per-site HMAC key. It is shown to an authorized cloud Admin only when requested. It is not written by this program to disk, logged, or sent to RouterOS.
- `SUPABASE_PUBLISHABLE_KEY` is a public project key; the service-role key is never used by the collector. Cloud writes are authenticated by the per-site HMAC over the timestamp, nonce and exact request body. Requests outside a five-minute clock window, nonce replays, duplicate snapshot IDs with changed content, and invalid mappings are rejected server-side.
- Logs contain only site ID and counts. They do not log PPPoE usernames, RouterOS credentials, HMACs, tokens, request bodies or raw counters.

## Install on a private site host

1. After the cloud migration and both Edge Functions are deployed, set a 32-byte hex `PPPOE_USAGE_MASTER_KEY` as a server-side Supabase secret. Set `APP_ORIGIN=https://offerpk.github.io` for the Admin function if it is not already configured. Never place either secret in this repository, Vite variables, GitHub Actions, or the collector.
2. Sign in to the **approved staging cloud Admin** and add a collection site plus one or more mappings from PPPoE username to an active customer. The form defaults to an example 100 decimal-GB quota and 5 Mbps symmetric speed; confirm the real plan values before any future pilot. Those fields are display/accounting settings only.
3. Use **Get collector token** for the site and copy the token directly into the site host’s protected environment file. Do not put it in browser local storage, a ticket, Git, or logs.
4. Install Python 3.11+ on a trusted Debian/Ubuntu host, copy this directory to `/opt/shahdara-pppoe-collector`, and create a dedicated system user plus state directory:

   ```sh
   sudo useradd --system --home /var/lib/shahdara-pppoe-collector --create-home --shell /usr/sbin/nologin pppoe-collector
   sudo install -d -o pppoe-collector -g pppoe-collector -m 0700 /var/lib/shahdara-pppoe-collector
   sudo install -d -o root -g root -m 0755 /opt/shahdara-pppoe-collector
   ```

5. Create `/etc/shahdara-pppoe-collector.env` with owner root and mode `0600`. Add the following keys with actual values only on the site host (never in this repo):

   ```ini
   ROUTEROS_URL=https://192.168.88.1
   ROUTEROS_USERNAME=read-only-collector
   ROUTEROS_PASSWORD=SET_ON_SITE_HOST
   ROUTEROS_CA_CERT=/etc/ssl/certs/routeros-site-ca.pem
   SUPABASE_PROJECT_URL=https://qkdsuvmlutkatcqoewkh.supabase.co
   SUPABASE_PUBLISHABLE_KEY=SET_PUBLIC_PROJECT_KEY
   COLLECTOR_SITE_ID=site-router-1
   COLLECTOR_SITE_TOKEN=SET_DERIVED_SITE_TOKEN
   POLL_SECONDS=300
   STATE_DB=/var/lib/shahdara-pppoe-collector/state.sqlite3
   ```

   `ROUTEROS_CA_CERT` may be omitted only if the router certificate chains to a CA already trusted by the host. Never disable certificate validation to work around a certificate error.

6. Confirm the certificate and a **synthetic/test RouterOS response** on the site host before enabling a service. The exact active-PPP JSON field names and `bytes` pair representation still require validation against the owner’s supported RouterOS model/version. This implementation accepts the documented `name`/`username`, `session-id`/`session_id`, `uptime`, and paired `bytes` forms. No live router was inspected or connected during this implementation.
7. Run a one-shot local test by invoking `python3 /opt/shahdara-pppoe-collector/pppoe_collector.py` under a controlled test configuration. Only enable unattended polling after the local TLS certificate, read-only role, field mapping, site token, and cloud response are independently confirmed.

The supplied systemd example is `shahdara-pppoe-collector.service`. Review its paths, user and environment-file permissions for the site host before installing it. Do not expose the service to the network; it is a local process with outbound HTTPS only.

## Data semantics and known limits

- RouterOS’s first active-PPP byte counter is traffic transmitted by the router (subscriber download); its second is received by the router (subscriber upload). The database uses `bytes_out` for the first and `bytes_in` for the second, documented in the migration.
- Database views sum only server-validated, nonnegative per-sample deltas. They never sum cumulative counters. A decrease, username change, uptime reset or reconnect starts a new session segment; an older/out-of-order observation contributes zero. Replayed snapshots are idempotent.
- Windows are half-open rolling intervals `[now - window, now)`: last 1 hour, 2 hours, 24 hours and 30 days. The separate quota total is the Asia/Karachi calendar month. Collection timestamps are quantized to one second; boundary accuracy is therefore limited by polling cadence.
- A customer’s configured collection sites all need a recent heartbeat for the summary to be fresh. No check-in, or a check-in older than 15 minutes, is displayed as stale/incomplete. The cloud also returns the number of currently unmapped sessions without exposing their usernames to customers; unmapped sessions are excluded from customer totals.
- This is informational usage display, not quota enforcement, packet shaping, billing, payment, or cash/credit accounting. A disconnect or network outage can leave final bytes unsampled. Usage never changes a bill, receipt, allocation, credit, balance, speed, or subscriber state.
- SQLite contains the durable outbox and high-water values. Do not delete or recreate it during operation. A lost state file or missed collection interval can make historical usage incomplete; no process can recover bytes it never observed.
- The backend accepts sample timestamps at most 90 days old to permit a bounded offline outbox. Preserve time synchronization on the collector and RouterOS host.

## Local synthetic tests

From the repository root:

```sh
python3 -m unittest discover -s collector/tests -v
```

The tests use synthetic sessions and local SQLite fixtures. They make no RouterOS, customer-data, or Supabase request.
