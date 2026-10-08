# Standalone PPPoE API on a Mini PC

The API-only Node service runs independently from GitHub Pages and does not serve or require the Vite `dist/` directory.

## Configure and run

1. Install Node.js 20.19+ or 22.12+ and copy the repository to the Mini PC.
2. Run `npm ci`.
3. Create a server-only `.env` with the settings below. Keep the file private and do not commit it.

```dotenv
HOST=0.0.0.0
PORT=4173
CORS_ORIGIN=https://YOUR_OWNER.github.io
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_OR_ANON_KEY
ROUTER_DRIVER=mikrotik
ROUTER_HOST=YOUR_ROUTER_MANAGEMENT_IP
ROUTER_PORT=8728
ROUTER_USER=pppoe-readonly
ROUTER_PASSWORD=SET_A_LONG_UNIQUE_PASSWORD
ROUTER_TIMEOUT_MS=5000
```

`CORS_ORIGIN` must be the exact browser origin (scheme and hostname, no path). Use a comma-separated list only for multiple explicitly approved frontend origins. Do not use `*`. Admin routes verify the Supabase bearer token and an `owner` or `admin` membership in the requested organization. The customer live-traffic route instead resolves the signed-in user to exactly one linked customer context, verifies the customer inside that same organization, and accepts no customer or organization ID from the browser. Both checks are performed independently of CORS.

Start the backend-only service with:

```sh
npm run start:api
```

For PM2, run it from the repository directory:

```sh
pm2 start npm --name shahdara-pppoe-api -- run start:api
pm2 save
```

The service listens on `0.0.0.0:4173` by default. It provides read-only RouterOS session, health, subscriber-discovery, and customer live-traffic GET routes, plus existing scoped Supabase billing/package/import API routes and CORS preflight handling. RouterOS access remains read-only: no router configuration command is permitted. Scoped Supabase writes, where present, are performed through their existing authenticated RPCs. For mock data, leave `ROUTER_DRIVER=mock`; live RouterOS polling is enabled only by explicitly setting `ROUTER_DRIVER=mikrotik` and the RouterOS variables.

## Customer speed graph and capacity

The portal targets `GET /api/customer/live-traffic` every two seconds. The endpoint derives the PPPoE username only after verifying the customer's Supabase bearer session and a single same-organization customer mapping. It calls the exact one-shot RouterOS command `/interface/monitor-traffic` against the validated PPPoE interface; it accepts no arbitrary command or interface properties. RouterOS TX is displayed as customer download and RX as upload. Keep the router API reachable only from the private API host/network, and use a dedicated read-only RouterOS account.

Per API process, the endpoint limits each user to one request per two seconds, at most 10 RouterOS requests per second, and at most four concurrent RouterOS polls. The browser staggers starts and retries rate-limited samples with jitter. **Ninety simultaneous customers would demand 45 requests/second, so two-second polling for all 90 is not viable under the current limits.** Do not increase limits without router load testing. Scaling needs a shared server-side sampler/cache or push fan-out and an approved deployment/configuration change; in-memory limits alone do not coordinate multiple API instances.

The graph measures instantaneous speed, not monthly data. It does not turn PPP session counters into an authoritative monthly total. Until a trusted calendar-month accounting source is configured, the customer portal reports month-to-date consumption as unavailable while displaying recorded bill status separately.

## Connect the static frontend

The current GitHub Pages hosted preview is intentionally pinned to `VITE_ROUTER_DRIVER=mock` and does not inject an API base URL, so do not configure that preview to reach this live RouterOS service. The private API can still be operated separately for an explicitly approved, privately hosted client; keep it behind a trusted HTTPS reverse proxy/VPN, set an exact CORS origin, and restrict access to trusted administrators. A plain-HTTP Mini PC URL is blocked by HTTPS browsers as mixed content. Firewall RouterOS API access to the backend host/trusted management LAN and prefer verified API-SSL. For a one-time local subscriber import without a hosted RouterOS connection, use [`local-router-sync.md`](./local-router-sync.md).
