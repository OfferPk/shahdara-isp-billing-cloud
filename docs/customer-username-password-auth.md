# Username-only sign-in and read-only customer portal

## Login contract

The portal exposes one sign-in form with exactly **Username** and **Password** inputs. There is no email field, customer self-service signup, email-link fallback, password-change form, or password-recovery control in the customer portal.

Customer sign-in goes through the protected `customer-login` broker. It resolves the supplied username to a single server-controlled customer/Auth mapping and returns a normal Supabase Auth session. The customer browser does not choose an organization or customer ID. Staff sign-in uses the invisible `${username.trim()}@shahdara.local` Supabase Auth email alias; neither the alias nor an email address is shown to the user.

The alias only supplies Supabase Auth's email-shaped identifier. It does not create an Auth user, prove mailbox ownership, bypass project confirmation/password rules, or change global email-confirmation settings. Self-service signup remains disabled.

## Password boundary

The PPPoE username may identify the customer, but the portal password must be independently provisioned for the customer's Auth identity. RouterOS PPP secret passwords are not imported or recovered as plaintext by this application. Do not assume the existing router/RADIUS password is the portal password, store or log plaintext credentials, or include customer passwords in router/API requests.

The customer-facing UI is read-only: it has no password mutation or recovery action. A customer whose backend credential state is `change_required`, expired, or otherwise inactive is denied portal data and shown an administrator-contact message. This change removes only the customer self-service UI; it does not weaken Supabase Auth, change password policy, or rewrite administrator credential management. An administrator must provision or reset the independent Auth password using the separately authorized credential workflow.

Never use `admin123` as a live default. Owner provisioning is outside this code change and requires a separately approved flow and a unique password collected securely.

## Customer live traffic endpoint

The customer dashboard polls `GET /api/customer/live-traffic` on a two-second target cadence and draws a bounded, 60-sample Canvas history. A missing/unreachable backend is reported as unavailable; mock readings, when used, are explicitly labeled **Demo rates · not live RouterOS**.

For each request the API:

1. verifies the Supabase bearer token;
2. requires an active customer portal credential state and exactly one `my_customer_portal_contexts()` result;
3. fetches the customer using both the context's organization ID and customer ID, then verifies both returned IDs;
4. derives the PPPoE username from that exact customer row, without accepting a customer or organization ID from the browser; and
5. allows only a validated PPPoE interface and a one-shot RouterOS `/interface/monitor-traffic` request.

The adapter parses RouterOS rate fields as bits per second. On a PPPoE interface, RouterOS TX is customer download and RX is customer upload. The read-only allowlist does not permit arbitrary RouterOS commands, custom interface properties, or configuration changes.

### Polling capacity

The API process enforces a two-second per-user minimum, a 10-requests/second RouterOS poll budget, and at most four concurrent router polls. A separate ingress guard is also applied. Browser starts are staggered and rate-limit retries add jitter. These are process-local limits, not a shared multi-instance scheduler.

**Ninety customers polling every two seconds are not viable under these limits:** that client demand is 45 requests/second before retries, over four times the current global poll budget. Do not raise limits blindly; scaling requires a shared backend sampler/cache or push fan-out, load testing against the actual router, and an approved deployment/configuration change.

## Monthly consumption and bills

The live graph is a momentary speed display, not a billing counter. Existing PPP session counters can reset on reconnect and are not a trusted calendar-month total. Until an authoritative monthly accounting source is configured, **Current month consumed** displays `Unavailable` rather than relabeling cumulative counters as monthly usage. The current-month bill status is displayed separately and only comes from recorded billing data.

## Deployment and provisioning status

GitHub Pages serves static assets only; it cannot run the customer traffic API. Real telemetry requires a separately operated HTTPS Node API with the RouterOS and Supabase public-token verification settings configured server-side, an exact CORS origin, and a trusted private network path to the router. The frontend's `VITE_PPPOE_API_BASE_URL` must point to that API. See [`pppoe-api-mini-pc.md`](pppoe-api-mini-pc.md).

This implementation does not create an organization, owner, Auth user, customer, or bill; change user credentials; change global Supabase Auth confirmation settings; apply migrations; or deploy the static site/API. Before any later provisioning, confirm the exact Supabase project and collect a unique owner password through the approved secure process. Customers likewise need independently provisioned portal passwords. Verify the existing email-confirmation policy with that project before account creation; this code does not disable it.
