#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { createClient } from '@supabase/supabase-js';

export const ORGANIZATION_NAME = 'Shahdara Fiber Net';
export const EXPECTED_PROJECT_REF = 'pocvrbwcfvtsupgdlouv';
export const PROVISIONER_MARKER = 'shahdara-owner-provisioner-v1';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');
const ENV_FILE = resolve(ROOT, '.env.local');
const AUTH_PAGE_SIZE = 1000;
const AUTH_MAX_PAGES = 100;

export function parseArgs(args) {
  let mode = 'dry-run';
  let modeWasSet = false;
  let confirmEmail = '';

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--dry-run' || argument === '--apply') {
      if (modeWasSet) throw new Error('Choose only one of --dry-run or --apply.');
      mode = argument === '--apply' ? 'apply' : 'dry-run';
      modeWasSet = true;
      continue;
    }
    if (argument === '--confirm-owner-provisioning') {
      confirmEmail = String(args[index + 1] ?? '').trim().toLowerCase();
      if (!confirmEmail || confirmEmail.startsWith('--')) {
        throw new Error('--confirm-owner-provisioning requires the exact owner email.');
      }
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (mode === 'apply' && !confirmEmail) {
    throw new Error('Writes are blocked unless --apply is paired with --confirm-owner-provisioning <owner-email>.');
  }
  if (mode !== 'apply' && confirmEmail) {
    throw new Error('--confirm-owner-provisioning can only be used with --apply.');
  }
  return { help: false, mode, confirmEmail };
}

export function normalizeOwnerEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid owner email address (maximum 254 characters).');
  }
  return email;
}

export function isServiceRoleKey(value) {
  const key = String(value ?? '').trim();
  if (!key || key.startsWith('sb_publishable_')) return false;
  if (key.startsWith('sb_secret_')) return true;
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.role === 'service_role';
  } catch {
    return false;
  }
}

export function deterministicOrganizationId(projectRef = EXPECTED_PROJECT_REF, name = ORGANIZATION_NAME) {
  const namespace = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
  const digest = createHash('sha1')
    .update(namespace)
    .update(`supabase:${projectRef}:organization:${name}`)
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildProvisioningPreview({ email, organization, user, membership }) {
  const alreadyOwner = membership?.role === 'owner';
  return {
    project: EXPECTED_PROJECT_REF,
    organization: {
      name: ORGANIZATION_NAME,
      action: organization ? 'reuse existing exact-name row' : 'create one organization row',
      id: organization?.id ?? deterministicOrganizationId(),
    },
    authUser: {
      email,
      action: user ? (alreadyOwner ? 'already provisioned' : 'resume marked provisioning only') : 'create Auth user',
      email_confirm: true,
      confirmation_email_sent: false,
      password: '[entered securely at apply time; never shown]',
    },
    membership: {
      role: 'owner',
      action: alreadyOwner ? 'already linked' : 'create owner membership if missing',
    },
    otherRows: 'none (no customers, packages, bills, invoices, or receipts)',
  };
}

function readEnvFileValue(filePath, key) {
  if (!existsSync(filePath)) return '';
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] !== key) continue;
    const value = match[2];
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
      return value.slice(1, -1);
    }
    return value;
  }
  return '';
}

function getProjectUrl() {
  const rawUrl = String(process.env.SUPABASE_URL || readEnvFileValue(ENV_FILE, 'VITE_SUPABASE_URL')).trim();
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('SUPABASE_URL was not found or is invalid. The helper can read VITE_SUPABASE_URL from ignored .env.local.');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== `${EXPECTED_PROJECT_REF}.supabase.co` || parsed.username || parsed.password) {
    throw new Error(`Refusing to connect: SUPABASE_URL must target the approved project ${EXPECTED_PROJECT_REF} over HTTPS.`);
  }
  return parsed.origin;
}

async function promptVisible(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Set the required non-secret value in the environment when running without an interactive terminal.');
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(prompt)).trim();
  } finally {
    terminal.close();
  }
}

async function promptSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('A hidden terminal prompt is unavailable. Provide the secret through its environment variable; do not place it in a committed file or command-line argument.');
  }
  return new Promise((resolveSecret, rejectSecret) => {
    const input = process.stdin;
    const decoder = new StringDecoder('utf8');
    let value = '';
    let settled = false;
    const wasRaw = input.isRaw;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      input.off('data', onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      process.stdout.write('\n');
      if (error) rejectSecret(error);
      else resolveSecret(value);
    };
    const onData = (chunk) => {
      const text = decoder.write(chunk);
      for (const character of text) {
        if (character === '\u0003') return finish(new Error('Input cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

async function getInputValue(envName, prompt, hidden = false) {
  const fromEnvironment = String(process.env[envName] ?? '');
  if (fromEnvironment) return fromEnvironment.trim();
  return hidden ? promptSecret(prompt) : promptVisible(prompt);
}

function safeFailure(category, error) {
  const code = String(error?.code ?? error?.status ?? '');
  const suffix = code ? ` (code ${code})` : '';
  return new Error(`${category}${suffix}; the response details were suppressed to avoid exposing account or credential data.`);
}

async function findOrganization(client) {
  const { data, error } = await client
    .from('organizations')
    .select('id, name')
    .eq('name', ORGANIZATION_NAME)
    .limit(2);
  if (error) throw safeFailure('Could not inspect the target organization', error);
  const rows = data ?? [];
  if (rows.length > 1) throw new Error('More than one organization already has the exact target name; stopping without writes for manual review.');
  return rows[0] ?? null;
}

async function findAuthUserByEmail(client, email) {
  for (let page = 1; page <= AUTH_MAX_PAGES; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: AUTH_PAGE_SIZE });
    if (error) throw safeFailure('Could not inspect Supabase Auth users', error);
    const users = data?.users ?? [];
    const matches = users.filter((candidate) => String(candidate.email ?? '').trim().toLowerCase() === email);
    if (matches.length > 1) throw new Error('More than one Auth record matched the owner email; stopping for manual review.');
    if (matches.length === 1) return matches[0];
    if (users.length < AUTH_PAGE_SIZE) return null;
  }
  throw new Error('Auth user lookup reached its safe page limit; no writes were attempted.');
}

async function findMembership(client, organizationId, userId) {
  if (!organizationId || !userId) return null;
  const { data, error } = await client
    .from('organization_memberships')
    .select('organization_id, user_id, role')
    .eq('organization_id', organizationId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw safeFailure('Could not inspect the target membership', error);
  return data ?? null;
}

async function inspectState(client, email) {
  const organization = await findOrganization(client);
  const user = await findAuthUserByEmail(client, email);
  const membership = await findMembership(client, organization?.id, user?.id);
  const markedUser = user?.app_metadata?.owner_provisioner === PROVISIONER_MARKER;

  if (membership && membership.role !== 'owner') {
    throw new Error(`The target Auth user already has the ${membership.role} role in this organization; the helper will not change roles.`);
  }
  if (user && !membership && !markedUser) {
    throw new Error('An Auth user with this email already exists but was not created by this helper; it will not adopt the account or change its password.');
  }
  if (markedUser && !user.email_confirmed_at) {
    throw new Error('A prior helper-marked Auth user is not email-confirmed; stopping for manual review without changing it.');
  }

  return { organization, user, membership };
}

function printPreview(preview, mode) {
  console.log(`Mode: ${mode === 'dry-run' ? 'DRY RUN — no writes' : 'APPLY — explicitly confirmed'}`);
  console.log('Provisioning plan (password and service-role key are never displayed):');
  console.log(JSON.stringify(preview, null, 2));
}

async function createOrReuseOrganization(client, existingOrganization) {
  if (existingOrganization) return existingOrganization;
  const id = deterministicOrganizationId();
  const { data, error } = await client
    .from('organizations')
    .insert({ id, name: ORGANIZATION_NAME })
    .select('id, name')
    .single();
  if (!error) return data;
  if (String(error.code) === '23505') {
    const concurrent = await findOrganization(client);
    if (concurrent) return concurrent;
  }
  throw safeFailure('Organization creation failed', error);
}

async function createOrResumeAuthUser(client, email, password, existingUser) {
  if (existingUser) return existingUser;
  const { data, error } = await client.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { owner_provisioner: PROVISIONER_MARKER },
  });
  if (!error && data?.user) return data.user;
  if (String(error?.code ?? '').toLowerCase().includes('already') || String(error?.message ?? '').toLowerCase().includes('already registered')) {
    const racedUser = await findAuthUserByEmail(client, email);
    if (racedUser?.app_metadata?.owner_provisioner === PROVISIONER_MARKER && racedUser.email_confirmed_at) return racedUser;
  }
  throw safeFailure('Auth user creation failed', error);
}

async function createOwnerMembership(client, organizationId, userId, existingMembership) {
  if (existingMembership?.role === 'owner') return existingMembership;
  const { data, error } = await client
    .from('organization_memberships')
    .insert({ organization_id: organizationId, user_id: userId, role: 'owner' })
    .select('organization_id, user_id, role')
    .single();
  if (!error) return data;
  if (String(error.code) === '23505') {
    const racedMembership = await findMembership(client, organizationId, userId);
    if (racedMembership?.role === 'owner') return racedMembership;
  }
  throw safeFailure('Owner membership creation failed', error);
}

async function applyProvisioning(client, state, email, password) {
  const organization = await createOrReuseOrganization(client, state.organization);
  const user = await createOrResumeAuthUser(client, email, password, state.user);
  const membership = await createOwnerMembership(client, organization.id, user.id, state.membership);

  if (organization.name !== ORGANIZATION_NAME || membership.role !== 'owner' || user.email_confirmed_at == null) {
    throw new Error('Post-write verification did not match the requested state; no rollback was attempted, and rerun the helper only after reviewing the partial state.');
  }
  return { organization, membership };
}

function printHelp() {
  console.log(`Usage: node scripts/provision-owner.js [--dry-run | --apply --confirm-owner-provisioning <email>]

Default mode is a read-only dry-run. It reads the approved project's exact-name
organization and Auth user state, then prints the proposed organization, Auth
identity and owner membership actions. It never creates customer or billing rows.

Inputs are read from environment variables or securely prompted:
  OWNER_EMAIL                  Owner email; never committed by this helper.
  SUPABASE_SERVICE_ROLE_KEY    Server-only Supabase service-role/secret key.
  OWNER_PASSWORD               Required only to create a new Auth user; hidden
                               prompt is available when this variable is absent.
  SUPABASE_URL                 Optional; defaults to VITE_SUPABASE_URL in
                               ignored .env.local and must match the approved project.

Do not put the service-role key or password in the repository, .env.local,
command-line arguments, or frontend configuration. Dry-run requires the owner
email and service-role key to inspect live state; it does not ask for a password.
Apply requires an exact confirmation flag matching OWNER_EMAIL and then verifies
the organization, Auth email-confirmation state, and owner membership.`);
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    printHelp();
    return;
  }

  const email = normalizeOwnerEmail(await getInputValue('OWNER_EMAIL', 'Admin Owner email: '));
  if (options.mode === 'apply' && options.confirmEmail !== email) {
    throw new Error('--confirm-owner-provisioning must exactly match OWNER_EMAIL; no writes were attempted.');
  }
  const serviceRoleKey = (await getInputValue('SUPABASE_SERVICE_ROLE_KEY', 'Supabase service-role key (hidden): ', true)).trim();
  if (!isServiceRoleKey(serviceRoleKey)) {
    throw new Error('A valid Supabase service-role key (or project secret key) is required; publishable/anon keys are not accepted.');
  }

  const url = getProjectUrl();
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const state = await inspectState(client, email);
  const preview = buildProvisioningPreview({ email, ...state });
  printPreview(preview, options.mode);

  if (options.mode === 'dry-run') {
    console.log('Dry-run complete. No Auth user, organization, membership, or other row was created or changed.');
    return;
  }
  if (state.membership?.role === 'owner') {
    console.log('This owner membership is already provisioned; no writes were needed.');
    return;
  }

  let password = '';
  if (!state.user) {
    password = await getInputValue('OWNER_PASSWORD', 'New Admin Owner password (hidden): ', true);
    if (password.length < 8) throw new Error('For this administrator bootstrap, use a password of at least 8 characters.');
  }
  const result = await applyProvisioning(client, state, email, password);
  console.log(`Provisioning verified: ${ORGANIZATION_NAME}; owner membership is active for ${email}.`);
  console.log('No business, customer, package, bill, invoice, or receipt rows were created.');
  console.log(`Organization ID: ${result.organization.id}`);
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`Provisioning stopped: ${error?.message ?? 'unexpected error'}`);
    process.exitCode = 1;
  });
}
