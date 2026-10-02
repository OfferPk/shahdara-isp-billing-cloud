# Customer username and temporary-password access

## Scope and relationship to email invitations

This is an additive customer sign-in option for the isolated cloud portal. Existing owner/customer email magic-link behavior remains available; self-service sign-up remains disabled. The new flow creates a separate, globally unique customer Auth identity, so it does not change an existing invited email address or claim that the customer controls one. Both identities are linked server-side to the same customer record. An Admin reset temporarily blocks that customer's data through RLS for every linked identity until the new temporary password is changed or the account is reset again.

The database migration is `20261002180000_customer_temporary_password_auth.sql`. The Edge Functions are `customer-login`, `manage-customer-credentials`, and `change-customer-password`. This feature is not deployed or applied by the GitHub Pages workflow. Do not apply the migration or deploy the functions until the isolated staging go/no-go checks below pass.

## Synthetic Auth address exception

Supabase Auth requires an email identifier for password sign-in in this design. The server therefore generates a second, random, opaque Auth-only alias under `internal.shahdara.net`, such as `portal-<random-hex>@internal.shahdara.net`. The alias is independent of the customer username and is never entered by a customer, sent to an email provider, or used as a contact address. The server confirms this synthetic identity when it creates the Auth user so that password login works; that confirmation is an explicit, owner-approved exception and proves **nothing** about inbox existence or ownership. Never substitute a real customer email, describe the alias as verified contact information, or use it for notifications.

The broker resolves the globally unique username only inside a service-role-only database function. It returns a normal Supabase Auth session to the browser, whose signed user claims inherently contain the opaque synthetic Auth identity; the broker does not return an alias lookup field and the application must never display or treat the JWT email claim as contact data.

## Credential lifecycle

1. An owner/Admin opens the customer profile, completes the approved identity check, and enters a short operational reason. The reason must contain no password, verification code, or unnecessary personal information.
2. The Edge Function rechecks the caller's Auth identity and organization role in the database. Per-Admin, per-customer, and per-organization issuance limits apply. A reservation marks the customer as provisioning **before** the Auth Admin API is called, so RLS fails closed during the operation.
3. The server generates a cryptographically random, 32-character temporary password. It is not placed in Auth metadata, a database row, an audit event, or a log. The function returns it once to the authorized Admin in a `Cache-Control: no-store` response. Repeating a request creates/resets a password; it never retrieves a prior one.
4. The temporary credential expires after 24 hours. A successful temporary sign-in can be claimed once. Customer-data RLS remains denied until the customer changes the password. Expired, provisioning, locked, or pending-change states cannot read bills, receipts, incidents, customer details, or organization-linked branding.
5. The customer chooses a 12–72 UTF-8-byte permanent password through the authenticated user's normal Supabase Auth password-update operation. Project password and secure reauthentication requirements are not disabled. Only after Auth succeeds does a service-only database transition mark the account active. A failed/uncertain synchronization keeps data blocked; Admin reset is the recovery path.

## Staff identity check and handoff

Before issuing or resetting credentials, staff must meet the customer in person and compare them with an existing, independently recorded customer record using the ISP's approved identity-verification procedure. A login username, customer number, PPPoE/router identifier, phone number supplied during the request, or knowledge of a bill is not sufficient by itself. Remote, disputed, or weakly documented identity cases stop for an owner/manager review; do not use this flow as a recovery shortcut. The required checkbox is an operator attestation, not technical proof that the check occurred.

Show the one-time password only through the organization's approved staff-to-customer handoff. Do not read it over an unverified phone call, send it by ordinary email/SMS/WhatsApp, paste it into notes or tickets, or take a screenshot. Close the customer profile after handoff; the UI clears the reveal when the dialog closes. If the handoff fails or the password is lost, issue a new reset instead of recovering the old secret.

## Server configuration and security controls

The functions require the platform-provided `SUPABASE_URL`, a publishable/legacy anon key, and `SUPABASE_SERVICE_ROLE_KEY` **only in Edge Function server memory**. Set `APP_ORIGIN` to the exact approved browser origin and provision `PORTAL_RATE_LIMIT_HMAC_KEY` as a random server-only key of at least 32 characters. Never put either secret in the browser bundle, Pages variables, Git, an issue, or a PR. The public login function has gateway JWT verification disabled because it establishes a session; its own HMAC/IP throttles and generic failure behavior are mandatory. Admin and password-change functions retain gateway JWT verification and independently validate the bearer user.

The database stores HMAC/SHA-256 digests for login and source-IP throttle keys, not raw usernames or IP addresses. The login limiter permits 20 attempts per source IP and 5 per username in a 15-minute window before cooldown; issuance is capped at 5 per Admin, 3 per customer, and 20 per organization per hour. Login failures for unknown, wrong, expired, already-used, and locked usernames use the same message. Audit records store event, customer/Auth IDs where known, actor, hashed source IP, outcome, time, and staff reason; they never store passwords. Old throttle rows are removed in bounded batches during requests. Audit retention/rotation still needs an operational policy before production.

The browser cannot select or update the private credential tables. The protected customer-context RPC returns only customer/organization IDs. Existing `owns_customer` and organization-branding access helpers consult the server-controlled credential state; all customer table policies that use `owns_customer` therefore enforce the must-change gate beyond the UI.

## Staging-only go/no-go checks

Before any staging deployment, use only a disposable synthetic customer and confirm all of the following without sending real customer communications:

- Apply the additive migration to a disposable database and run schema/RLS tests; confirm private tables are absent from exposed API schemas and browser roles cannot select or mutate them.
- Configure Edge Function secrets server-side and deploy functions separately; confirm the `service_role` key is never present in `dist/`, the HTML, or network responses.
- Verify the managed gateway's `X-Forwarded-For` behavior: it must overwrite or safely normalize client-supplied values before the function trusts the first value. Supabase's API guide demonstrates reading the first `X-Forwarded-For` address, but that does not by itself prove deployed Edge gateway anti-spoofing behavior. If the header can be spoofed or is absent, stop and redesign IP throttling rather than claim per-IP protection.
- Supabase Auth's own forwarded-IP feature uses `Sb-Forwarded-For` only when project IP forwarding is explicitly enabled and a secret API key is used. This PR does not change project settings. Prove built-in Auth rate limiting behind the broker does not unfairly rate-limit all customers as one Edge egress IP; if it does, obtain separate approval before changing project settings or broker behavior.
- Test wrong-password, unknown username, expired/used temporary password, throttling, duplicate/concurrent issue, reset while an old email-invited identity is signed in, one-time claim races, forced-change failure, and failed Auth/database synchronization. Confirm no customer rows load until the server state is active.
- Test that `auth.updateUser({ password })` succeeds under the project's current password and secure-reauthentication settings. If it requires an additional supported reauthentication factor not supplied by this flow, stop; do not weaken Auth settings.
- Verify the actual GitHub Pages origin and Supabase Edge CORS behavior. Confirm no signup or email is sent by this flow and the separate email magic-link fallback still works.

Official platform references: [Supabase API security and request information](https://supabase.com/docs/guides/api/securing-your-api) and [Supabase Auth rate limits and IP forwarding](https://supabase.com/docs/guides/auth/rate-limits).

## Known limits of this draft

No Supabase project, Auth configuration, database, secrets, customer data, live router, or email/SMS service is accessed by this implementation. The managed-gateway IP trust and built-in Auth forwarded-IP behavior remain unverified; the actual secure-password-change setting is not observable without the prohibited staging check. The staff checkbox is an attestation, not evidence of in-person identity verification. Audit retention/monitoring and a verified secure handoff procedure are operational prerequisites. Keep the pull request in draft until these gates are independently reviewed and tested in isolated staging.
