# Local RouterOS subscriber sync

`scripts/local-router-sync.js` runs on the local laptop that can reach the MikroTik router. It talks directly to RouterOS from that machine; it does not relay RouterOS credentials through the hosted preview or send them to Supabase. The hosted preview remains on synthetic mock data. A Supabase connection is made only when the script is explicitly started with `--apply`.

## Prepare a local config

Use Node.js 20.19+ or 22.12+. Copy `.env.router.local.example` to `.env.router.local` in the repository root and fill it in on the local laptop. `.env.router.local` is ignored by Git. Do not copy router secrets into `.env`, `.env.local`, a browser build setting, or the repository. Keep the local file private and never paste its contents into logs or chat.

Configure `ROUTER_HOST`, `ROUTER_USER`, and `ROUTER_PASSWORD` with a dedicated RouterOS account that can read PPP secrets/active sessions but cannot change router configuration. API-SSL on port `8729` is the default and TLS certificate verification is mandatory. For a self-signed router certificate, install/trust its issuing CA locally; this script never disables certificate verification.

Plaintext API port `8728` is disabled unless `ROUTER_ALLOW_INSECURE_LOCAL=true` is explicitly set. That opt-in is accepted only for an address that resolves exclusively to private-LAN ranges (RFC1918/ULA/link-local); public IP addresses and names resolving to public addresses are refused. Port 8728 exposes credentials and traffic in plaintext on that LAN, so use API-SSL whenever possible. No public router address is supported.

## Dry-run first, then explicit apply

```sh
node scripts/local-router-sync.js                 # dry-run is the default
node scripts/local-router-sync.js --dry-run        # explicit dry-run
node scripts/local-router-sync.js --dry-run --username subscriber01
node scripts/local-router-sync.js --apply --username subscriber01
```

You may repeat `--username USER` to limit a run. Without filters, `--apply` selects every discovered subscriber, up to 500 records. The script prints only the username and profile for local review. Dry-run connects to the private router for read-only discovery but makes **no Supabase request** and performs no write. The only RouterOS discovery commands are `/ppp/secret/print` with the allowlisted `name,profile,remote-address,comment` fields and, when secrets cannot be read or no secrets are returned, `/ppp/active/print` with `name,profile,address,comment`. It never asks for the `password` property or performs a RouterOS write.

On `--apply`, the script first validates the user JWT with Supabase Auth and confirms that same user has an `owner` or `admin` membership in the configured organization; this happens before it connects to RouterOS. Subscriber metadata (username, customer name parsed from the comment or username fallback, package/profile, assigned IP, original comment, service address, and valid Pakistan phone number parsed from the comment) is then sent to the configured Supabase project. The RouterOS username/password and RouterOS API credentials are not sent. Each subscriber is imported through the existing `public.import_router_subscriber` RPC using the publishable/anon key plus the signed-in owner's/admin's user access JWT. Database authorization remains the RPC's `auth.uid()` and `is_org_admin(organization_id)` check; the script does not use or accept a service-role key. The RPC skips already-imported PPPoE usernames. If an apply run stops partway through, earlier subscriber RPCs may already have committed; rerun is safe for duplicates, which the RPC reports as skipped.

## Apply prerequisites

Before `--apply`, set all four Supabase values in `.env.router.local`:

- `SUPABASE_URL`: the approved Supabase project HTTPS origin.
- `SUPABASE_PUBLISHABLE_KEY`: the project's publishable key or legacy anon key. A service-role key is rejected.
- `SUPABASE_ORGANIZATION_ID`: the existing organization UUID the administrator belongs to.
- `SUPABASE_ADMIN_ACCESS_TOKEN`: a current JWT from an authenticated Supabase `owner` or `admin` user in that organization (`role: authenticated`). It is a user-scoped access token, not a service-role credential; keep it local and refresh it when it expires.

This repository currently has no provisioned owner organization, admin Auth user, customer, bill, or package rows, so those must be prepared through the project's approved setup before a real import can succeed. Also ensure the existing PPPoE-username mapping/customer schema and `20261007223600_router_subscriber_import.sql` migration (which defines the RPC and package fields) have been reviewed and applied by the database owner. This script does not inspect migration history or apply migrations; it fails on missing/unauthorized RPC calls and does not bypass RLS or RPC checks. The separate FUP quota schema/usage migrations are not needed for this import and remain untouched.

RouterOS PPP secret passwords cannot be retrieved in plaintext by this read-only discovery flow. A customer's portal/Auth password is separate and must be provisioned through the existing approved Auth flow; this importer never creates Auth users or passwords.
