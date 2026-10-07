# FreeRADIUS accounting adapter (offline, read-only)

This phase adds a local Node.js adapter and offline tests. It does not connect to a RADIUS database, alter a database, enable the sync function, deploy code, or publish usage. No FreeRADIUS deployment schema has been inspected as part of this work.

## Two distinct data shapes

1. **`radacct` session snapshots** — `agent/radius-sql-adapter.js` can read candidate rows with a `SELECT`, bind all interval values, normalize configured counters with `BigInt`, and retain one latest observation per `(sourceId, NAS identity, acctuniqueid)`. A Stop observation supersedes an earlier Interim observation; repeated Interim counters are never summed. A missing Stop is kept as an open candidate session and is not treated as proof of a subscriber's online state.
2. **Closed period aggregates** — `aggregateClosedPeriodUsage()` accepts only already-finalized, normalized rows supplied by a separately verified period-accounting source. It sums integer `inputBytes`/`outputBytes` for closed rows wholly inside `[periodStart, periodEnd)`. It rejects rows straddling either boundary and open rows overlapping the requested interval. It does not query or assume the presence/schema of FreeRADIUS's optional `data_usage_by_period` extension, and it does not prove the input source has complete, gap-free coverage.

The first shape cannot be converted into the second. Standard `radacct` counters are cumulative since each session began; a final Stop count does not reveal how many bytes occurred on either side of a billing boundary. Reading the same session in two adjacent monthly queries may return the same cumulative count in both. The adapter therefore deliberately has no `radacct`-to-monthly aggregation function.

## Schema and source prerequisites

The adapter's query uses the common `radacct` names `acctuniqueid`, `acctsessionid`, `username`, `nasipaddress`, `acctstarttime`, `acctstoptime`, `acctupdatetime`, `acctinputoctets`, and `acctoutputoctets`. These are a candidate mapping, **not a claim that the installed database has this schema**. The `octets+gigawords` mode also selects `acctinputgigawords` and `acctoutputgigawords`; select it only after confirming both columns and their write semantics. `expanded-64` is an explicit alternative only if the installed database column already stores the complete counter. There is no implicit low-word-only fallback.

Before using the reader, an operator must verify the actual server/schema/version, selected columns, counter representation and high-word preservation, SQL driver and placeholder style, read-only grants, timestamp column types/timezone conversion, source/NAS identity, username mapping, retention/deletion behavior, Interim-Update interval and loss behavior, and the billing timezone/cycle. The adapter accepts only timezone-qualified timestamp strings or `Date` values already interpreted by the configured driver; it does not guess a timezone for naive database values. Its `asOf` parameter restricts candidate session starts but cannot reconstruct an earlier `radacct` value after an in-place row update.

`createRadacctSqlAdapter()` accepts a `sqlClient` with `execute(sql, values)` or `query(sql, values)`, an explicitly configured source identity and counter encoding, and either `question` (`?`) or `numbered` (`$1`, `$2`, `$3`) parameter placeholders. Use a dedicated database principal restricted to `SELECT` on the verified accounting source. Do not pass authentication tables, passwords, secret attributes, or unrelated data to the adapter.

## Period aggregation and billing semantics

Use only a separately established period-accounting source whose actual installation, schema, update process, finalized period rows, timezone, interval alignment, coverage, and direction are verified. The helper is pure: its input is normalized period rows (`username`, timezone-qualified `periodStart`, nullable `periodEnd`, `inputBytes`, and `outputBytes`); it performs no SQL and calls no maintenance/update procedure. Open/carry-forward rows are not counted. Missing rows are not interpreted as zero usage. Period boundaries must align with the half-open requested billing interval; a row spanning a boundary is rejected rather than split or guessed.

The helper labels outputs `closed-period-aggregate` and preserves RADIUS input/output direction. There is no approved mapping from those directions to the portal's `bytes_in` (download) and `bytes_out` (upload); verify the installed NAS/server mapping and known traffic in a controlled lab before any use.

If the documented FreeRADIUS period extension is unavailable or incompatible, a durable per-session delta accumulator is a separate design requirement. It needs atomic durable checkpoints, an outbox, recovery/retention semantics, duplicate and late-update handling, and an explicit boundary-allocation convention. The current adapter does not provide that accumulator. Sparse/lost Interim-Updates leave uncertainty that a final session total cannot eliminate.

## Ingestion contracts: cumulative and session-delta modes

The legacy `subscriber_cumulative` contract still calls `sync_customer_bandwidth_usage`, which replaces the latest snapshot and preserves admin-managed quota; it does not represent a monthly ledger. `mapSubscriberCumulativeToIngestRequest()` and `postSubscriberCumulativeSnapshots()` deliberately remain strict legacy adapters and do **not** relabel `radacct` observations as cumulative totals.

The same authenticated `sync-agent-ingest` function also recognizes a separate `routeros-session-delta` scope. That path validates keyed session counters and calls the new service-role-only `sync_customer_bandwidth_session_deltas` RPC from `20261008003000_monthly_quota_poller_delta_aggregation.sql`. The migration is prepared but unapplied. Its separate `SYNC_AGENT_DELTA_SOURCE_CONFIRMED` server gate remains closed until reviewed and deployed. The migration stores durable per-session baselines and Pakistan-local monthly totals. This is a poller estimate, not billing-grade accounting: final bytes between the last poll and disconnect, missing intervals, and sessions that ended before polling began are not recoverable. The customer progress bar is advisory only.

The RADIUS adapter remains unconnected to either path: its direction mapping and counter encoding still require controlled-lab verification. `createSyncAgentIngestClient()` sends only the narrow dedicated bearer credential over HTTPS, never a Supabase service-role key or API key. Unknown usernames remain errors/quarantine candidates; no adapter creates or guesses mappings. Online/offline state must come from a complete, current inventory across authoritative NAS sources, not from a single `radacct` row.

## Offline checks

- `npm test` includes the synthetic RADIUS adapter tests. They use in-memory fixtures and mock SQL/API clients only.
- `npm run build` verifies the existing portal bundle remains buildable.
- `npm run test:db` creates a disposable local PostgreSQL cluster and runs repository pgTAP suites when PostgreSQL 16, pgTAP/contrib, and the required local OS permissions are installed. It is not needed by the Node-only adapter, which does not change the application database schema.

No test in this phase reads a real router, Mini PC, RADIUS database, Supabase project, or production secret. The current ingest endpoint remains latest-snapshot behavior; no monthly portal history or period-aware API is introduced.
