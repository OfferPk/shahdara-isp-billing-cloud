# Customer bandwidth usage (Phase 1)

The `customer_bandwidth_usage` table stores one globally unique row per PPPoE username. `bytes_in` is download traffic; `bytes_out` is upload traffic. A `total_quota_bytes` value of `0` means unlimited. Counters and quota are constrained to non-negative values.

## Trusted profile mapping

The cloud schema did not previously contain a trusted RouterOS/PPPoE username-to-customer mapping. Portal login identifiers in `private.customer_portal_credentials` are opaque, server-managed Auth identifiers and are not treated as network usernames.

The standalone migration `20261003200536_add_customer_pppoe_username_mapping.sql` adds nullable, globally unique `customers.pppoe_username` and grants authenticated users column-level UPDATE privilege; the existing `customers_admin_update` RLS policy remains the authorization boundary. It does not create the usage table or change any RLS policy. The full migration `20261003170000_customer_bandwidth_usage.sql` creates the separate usage table and server sync RPC; its repeated mapping-column DDL is idempotent so it can run after the standalone mapping migration when an environment has that migration recorded first. `customer_bandwidth_usage.username` references the mapping, so usage rows cannot be created for an unlinked username. The mapping is the sole bridge to the existing organization/customer ownership model; no tenant-supplied request parameter or JWT claim is trusted for row access.

## Access and sync

- `authenticated` users may select only a row belonging to their linked customer (`owns_customer`) or an organization in which they are an owner/admin (`is_org_admin`).
- Organization owners/admins may insert, update, and delete usage rows only for mapped customers in organizations they administer. Customer roles have no write policies.
- `service_role` has no direct table grants. A trusted server-side component may call `public.sync_customer_bandwidth_usage`; execute permission is granted only to `service_role`. Never put a service-role key in browser code or a frontend response.
- The sync RPC updates counters, online status, last IP, and sync time. It initializes new-row quota to unlimited (`0`) and preserves quota configured by an admin on subsequent syncs.

The Admin portal now provides a mapping-only form for linking an existing PPPoE username to an existing customer record. It uses the signed-in client, scopes updates by organization and customer ID, and changes only `customers.pppoe_username`; the existing Admin RLS policy and unique constraint remain authoritative. It does not create a network login or change Overtake, RADIUS, RouterOS, or any password. Customer reads continue to rely on the existing ownership policies.

The form appears only when the application can read the mapping column. If the project schema does not contain it, portal loading falls back to the core customer fields and the Admin sees an explicit setup notice rather than a broken portal or a failed write. Only the standalone mapping migration is required to use this form; the application never applies schema changes automatically. Applying the separate full bandwidth migration also creates its usage table, policies, and sync RPC and must follow its own approved database-change process.

This phase does not connect directly to RouterOS or deploy a sync Edge Function. The app continues to display only server-synchronized usage snapshots from `customer_bandwidth_usage`.

## Local verification

`npm run test:db` runs the branding and bandwidth pgTAP suites against a fresh local PostgreSQL 16 cluster and removes that cluster on exit. The suite uses synthetic fixtures and rolls each test transaction back; it does not connect to Supabase.
