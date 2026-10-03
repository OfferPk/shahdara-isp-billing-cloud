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

## Existing ingestion contract: cumulative only

The existing `sync-agent-ingest` endpoint accepts exactly a `subscriber_cumulative` snapshot and calls the existing per-customer `sync_customer_bandwidth_usage` RPC. That RPC replaces the latest `bytes_in`/`bytes_out` values and preserves admin-managed quota; it does not store a billing period or monthly ledger. A month-to-date value sent there would overwrite the latest cumulative snapshot and be mislabeled.

`mapSubscriberCumulativeToIngestRequest()` and `postSubscriberCumulativeSnapshots()` therefore accept only explicitly marked subscriber-cumulative source data and emit the existing exact item shape. They do **not** accept `radacct` session snapshots or closed-period results. `createSyncAgentIngestClient()` accepts the existing dedicated bearer token, requires the HTTPS `sync-agent-ingest` endpoint, and sends no service-role key or Supabase API key. The local adapter must never receive or store the service-role key. The Edge Function's authentication and source-confirmation gate remain unchanged.

Until a period-aware contract and storage/read/UI behavior are approved and implemented, monthly aggregates may be computed locally from a verified period source for controlled testing, but they must not be posted to the current endpoint. Unknown usernames remain errors/quarantine candidates; the adapter never auto-creates or guesses username mappings. Online/offline state must come from a complete, current inventory across all authoritative NAS sources, not from a single `radacct` row.

## Offline checks

- `npm test` includes the synthetic RADIUS adapter tests. They use in-memory fixtures and mock SQL/API clients only.
- `npm run build` verifies the existing portal bundle remains buildable.
- `npm run test:db` creates a disposable local PostgreSQL cluster and runs repository pgTAP suites when PostgreSQL 16, pgTAP/contrib, and the required local OS permissions are installed. It is not needed by the Node-only adapter, which does not change the application database schema.

No test in this phase reads a real router, Mini PC, RADIUS database, Supabase project, or production secret. The current ingest endpoint remains latest-snapshot behavior; no monthly portal history or period-aware API is introduced.
