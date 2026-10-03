# Customer usage dashboard and expiry notice (Phase 2)

## Customer data boundary

The customer portal reads `customer_bandwidth_usage` using the authenticated Supabase client and an explicit, read-only column list: `username`, `total_quota_bytes`, `bytes_in`, `bytes_out`, `is_online`, and `last_synced_at`. It does not add a client-supplied username, customer ID, or organization ID filter to that table query; the Phase 1 RLS policy remains the authority for which rows the signed-in customer can read. The selected columns omit `last_ip`. The usage query is not run for Admin contexts and does not issue writes or call the privileged sync RPC.

The customer profile's admin-managed `pppoe_username` is used only to match a returned, RLS-visible snapshot in the browser. It is not used as authorization and does not broaden the query. The profile's existing service status and package/plan stay distinct from the PPPoE connection status in the usage snapshot.

## Display semantics

- `bytes_in` is labeled download, `bytes_out` upload, and their sum total used. Values use decimal KB/MB/GB formatting. The finite-quota card shows consumed bytes versus total quota, remaining bytes and percentage, and an accessible progress meter.
- A `total_quota_bytes` value of `0` is shown as **Unlimited Package** with the aggregate download/upload/total traffic counters. For finite quotas, meter colors are green below 75% consumed, orange from 75% through 90%, and red above 90%. Over-quota data reports zero remaining and the excess without negative values.
- Counters are cumulative snapshots. The UI does not infer a reset, monthly period, rolling window, or calendar-month total because the schema stores no counter history or reset timestamp.
- `last_synced_at` is shown with a relative time and recorded timestamp. A UI heuristic marks a snapshot older than 24 hours as potentially delayed; this is not a promised RouterOS sync SLA. Roman Urdu uses Latin-script relative time.
- The cloud customer/profile schema has no genuine service/package expiry or renewal field. The UI therefore displays an explicit unset state and explains that a bill due date is separate and is not service expiry. It does not infer expiry from `bills.due_date` or show an invented alert date. The expiry component can render upcoming, warning (three days or fewer), and expired states when given a real date, and those branches are unit-tested with synthetic dates; the live portal currently passes no expiry date. A live countdown needs a future canonical service-expiry field/source, which is outside this Phase 2 change.
- Loading skeleton, unlinked-profile, no-snapshot, invalid-data, stale-data, and usage-query error states are distinct. A usage-query error does not hide the rest of the customer's portal.

## Verification fixtures

Tests use deterministic synthetic customer and usage snapshots, including unlimited quota, finite quota thresholds, over-quota, missing snapshot, stale timestamp, an unrelated synthetic username, and upcoming/warning/expired synthetic expiry dates. No real customer data is used.
