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

`CORS_ORIGIN` must be the exact browser origin (scheme and hostname, no path). Use a comma-separated list only for multiple explicitly approved frontend origins. Do not use `*`. The API verifies the Supabase bearer token and an `owner` or `admin` membership in the requested organization on every route, independently of CORS.

Start the backend-only service with:

```sh
npm run start:api
```

For PM2, run it from the repository directory:

```sh
pm2 start npm --name shahdara-pppoe-api -- run start:api
pm2 save
```

The service listens on `0.0.0.0:4173` by default and exposes only the two read-only GET endpoints plus their CORS preflight handling. It does not write to Supabase or modify router configuration. For an initial mock-data response, leave `ROUTER_DRIVER=mock`; live RouterOS polling is enabled only by explicitly setting `ROUTER_DRIVER=mikrotik` and the RouterOS variables.

## Connect the static frontend

Set the GitHub repository Actions variable `VITE_PPPOE_API_BASE_URL` to the public HTTPS base URL of this service, rebuild the Pages site, and set the matching exact Pages origin in the API server's `CORS_ORIGIN`. Alternatively, provide `window.__CONFIG__ = { API_URL: 'https://YOUR_API_HOST' }` before the Vite module loads. GitHub Pages is HTTPS: a plain-HTTP Mini PC URL is blocked by browsers as mixed content, so terminate TLS at a trusted reverse proxy or use an HTTPS VPN endpoint. Restrict access to that endpoint and firewall RouterOS API port 8728 to the backend host or trusted management network.
