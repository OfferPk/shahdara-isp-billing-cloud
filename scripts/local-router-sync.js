#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSubscriberComment } from '../src/admin-subscriber-import.js';

const DEFAULT_ROUTER_PORT = 8729;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_IMPORT_COUNT = 500;
const ORGANIZATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROUTEROS_DISCOVERY_COMMANDS = Object.freeze({
  secrets: Object.freeze(['/ppp/secret/print', '=.proplist=name,profile,remote-address,comment']),
  active: Object.freeze(['/ppp/active/print', '=.proplist=name,profile,address,comment']),
});
const ROUTEROS_TELEMETRY_COMMAND = Object.freeze([
  '/ppp/active/print',
  '=stats=',
  '=.proplist=name,uptime,caller-id,address,session-id,bytes',
]);

export function parseLocalEnvText(text) {
  const values = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

export async function loadLocalEnvironment({ cwd = process.cwd(), processEnv = process.env } = {}) {
  let fileValues = {};
  try {
    fileValues = parseLocalEnvText(await readFile(resolve(cwd, '.env.router.local'), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('The local router config file could not be read.');
  }
  return { ...fileValues, ...processEnv };
}

export function parseCliArgs(argv = []) {
  let apply = false;
  let dryRun = false;
  let help = false;
  const usernames = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') apply = true;
    else if (argument === '--dry-run') dryRun = true;
    else if (argument === '--help' || argument === '-h') help = true;
    else if (argument === '--username') {
      const username = String(argv[index + 1] ?? '').trim();
      if (!username || username.startsWith('--')) throw new Error('--username requires an exact PPPoE username.');
      usernames.push(username);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (apply && dryRun) throw new Error('Choose either --dry-run or --apply, not both.');
  if (new Set(usernames).size !== usernames.length) throw new Error('Do not repeat the same --username value.');
  return { apply, help, usernames };
}

function parseJwtPayload(token) {
  const segments = String(token ?? '').split('.');
  if (segments.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function isPublishableSupabaseKey(value) {
  const key = String(value ?? '').trim();
  if (key.startsWith('sb_publishable_')) return true;
  const payload = parseJwtPayload(key);
  return payload?.role === 'anon';
}

export function validateSupabaseConfig(env = {}) {
  const url = String(env.SUPABASE_URL ?? '').trim();
  const publishableKey = String(env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY ?? '').trim();
  const organizationId = String(env.SUPABASE_ORGANIZATION_ID ?? '').trim();
  const adminAccessToken = String(env.SUPABASE_ADMIN_ACCESS_TOKEN ?? '').trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('For --apply, set SUPABASE_URL to the approved HTTPS Supabase project URL in .env.router.local.');
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || parsedUrl.pathname !== '/') {
    throw new Error('SUPABASE_URL must be the HTTPS origin of the approved Supabase project.');
  }
  if (parsedUrl.hostname !== 'supabase.co' && !parsedUrl.hostname.endsWith('.supabase.co')) {
    throw new Error('SUPABASE_URL must point to a managed Supabase project host.');
  }
  if (!publishableKey || !isPublishableSupabaseKey(publishableKey)) {
    throw new Error('For --apply, set SUPABASE_PUBLISHABLE_KEY to a publishable/anon key, never a service-role key.');
  }
  if (!ORGANIZATION_ID_PATTERN.test(organizationId)) {
    throw new Error('For --apply, set SUPABASE_ORGANIZATION_ID to the existing organization UUID.');
  }
  const tokenPayload = parseJwtPayload(adminAccessToken);
  if (!tokenPayload || tokenPayload.role !== 'authenticated' || !tokenPayload.sub) {
    throw new Error('For --apply, set SUPABASE_ADMIN_ACCESS_TOKEN to a current signed-in owner/admin user JWT (not a service-role key).');
  }
  return { url: parsedUrl.origin, publishableKey, organizationId, adminAccessToken };
}

export async function verifySupabaseAdminAccess(supabase, fetchImpl = globalThis.fetch) {
  const headers = {
    apikey: supabase.publishableKey,
    authorization: `Bearer ${supabase.adminAccessToken}`,
    accept: 'application/json',
  };
  let userResponse;
  try {
    userResponse = await fetchImpl(new URL('/auth/v1/user', supabase.url), { method: 'GET', redirect: 'error', headers });
  } catch {
    throw new Error('Could not verify the signed-in administrator with the configured Supabase project.');
  }
  if (!userResponse.ok) throw new Error('The Supabase admin access token is invalid or expired.');
  let user;
  try {
    user = await userResponse.json();
  } catch {
    throw new Error('Supabase returned an invalid user-session response.');
  }
  const tokenPayload = parseJwtPayload(supabase.adminAccessToken);
  if (!user?.id || user.id !== tokenPayload?.sub) throw new Error('The Supabase session user did not match the supplied user token.');

  const membershipUrl = new URL('/rest/v1/organization_memberships', supabase.url);
  membershipUrl.searchParams.set('select', 'role');
  membershipUrl.searchParams.set('organization_id', `eq.${supabase.organizationId}`);
  membershipUrl.searchParams.set('user_id', `eq.${user.id}`);
  let membershipResponse;
  try {
    membershipResponse = await fetchImpl(membershipUrl, { method: 'GET', redirect: 'error', headers });
  } catch {
    throw new Error('Could not verify owner/admin membership for the configured organization.');
  }
  if (!membershipResponse.ok) throw new Error('Could not verify owner/admin membership for the configured organization.');
  let memberships;
  try {
    memberships = await membershipResponse.json();
  } catch {
    throw new Error('Supabase returned an invalid organization-membership response.');
  }
  if (!Array.isArray(memberships) || !memberships.some((membership) => ['owner', 'admin'].includes(membership?.role))) {
    throw new Error('The signed-in user is not an owner/admin of SUPABASE_ORGANIZATION_ID.');
  }
  return { userId: user.id };
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254);
}

export function isPrivateLanAddress(address) {
  const value = String(address ?? '').trim().toLowerCase();
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4[1]);
  const family = net.isIP(value);
  if (family === 4) return isPrivateIpv4(value);
  if (family !== 6) return false;
  return value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value);
}

async function resolvePrivateRouterAddress(host, lookup = dnsLookup) {
  const normalizedHost = String(host ?? '').trim();
  if (!normalizedHost || normalizedHost.includes('/') || normalizedHost.includes('@') || normalizedHost.startsWith('[')) {
    throw new Error('ROUTER_HOST must be a private-LAN IP address or hostname.');
  }
  let addresses;
  if (net.isIP(normalizedHost)) {
    addresses = [{ address: normalizedHost, family: net.isIP(normalizedHost) }];
  } else {
    try {
      addresses = await lookup(normalizedHost, { all: true, verbatim: true });
    } catch {
      throw new Error('ROUTER_HOST did not resolve on the local network.');
    }
  }
  if (!addresses.length || addresses.some(({ address }) => !isPrivateLanAddress(address))) {
    throw new Error('Router access is restricted to private-LAN addresses; public router IPs/hosts are refused.');
  }
  return addresses[0];
}

export function normalizeRouterRows(rows, addressField = 'remote-address') {
  const seen = new Set();
  const subscribers = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const username = String(row?.name ?? '').trim();
    if (!username || username.length > 255 || seen.has(username)) continue;
    seen.add(username);
    subscribers.push({
      username,
      profile: String(row?.profile ?? '').trim().slice(0, 100),
      ipAddress: String(row?.[addressField] ?? '').trim().slice(0, 100),
      comment: String(row?.comment ?? '').trim().slice(0, 1000),
    });
  }
  return subscribers;
}

export function mapSubscriberToRpcArgs(organizationId, subscriber) {
  const parsed = parseSubscriberComment(subscriber.comment, subscriber.username);
  return {
    p_organization_id: organizationId,
    p_username: subscriber.username,
    p_name: (parsed.name || subscriber.username).slice(0, 100),
    p_profile: subscriber.profile,
    p_assigned_ip: subscriber.ipAddress || null,
    p_router_comment: subscriber.comment,
    p_service_address: parsed.area,
    p_phone: parsed.phone,
  };
}

function encodeWordLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000) return Buffer.from([(length >> 8) | 0x80, length & 0xff]);
  if (length < 0x200000) return Buffer.from([(length >> 16) | 0xc0, (length >> 8) & 0xff, length & 0xff]);
  if (length < 0x10000000) return Buffer.from([(length >> 24) | 0xe0, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
  if (length <= 0xffffffff) {
    const prefix = Buffer.from([0xf0]);
    const size = Buffer.allocUnsafe(4);
    size.writeUInt32BE(length);
    return Buffer.concat([prefix, size]);
  }
  throw new RangeError('RouterOS API word exceeds the protocol limit.');
}

function encodeSentence(words) {
  const parts = [];
  for (const word of words) {
    const data = Buffer.from(String(word), 'utf8');
    parts.push(encodeWordLength(data.length), data);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function decodeWordLength(buffer, offset) {
  if (offset >= buffer.length) return null;
  const first = buffer[offset];
  if ((first & 0x80) === 0) return { length: first, bytes: 1 };
  if ((first & 0xc0) === 0x80) {
    if (offset + 2 > buffer.length) return null;
    return { length: ((first & 0x3f) << 8) + buffer[offset + 1], bytes: 2 };
  }
  if ((first & 0xe0) === 0xc0) {
    if (offset + 3 > buffer.length) return null;
    return { length: ((first & 0x1f) << 16) + (buffer[offset + 1] << 8) + buffer[offset + 2], bytes: 3 };
  }
  if ((first & 0xf0) === 0xe0) {
    if (offset + 4 > buffer.length) return null;
    return { length: ((first & 0x0f) << 24) + (buffer[offset + 1] << 16) + (buffer[offset + 2] << 8) + buffer[offset + 3], bytes: 4 };
  }
  if (offset + 5 > buffer.length) return null;
  return { length: buffer.readUInt32BE(offset + 1), bytes: 5 };
}

function parseSentence(words) {
  const [kind = '', ...fields] = words;
  const attributes = {};
  for (const field of fields) {
    if (!field.startsWith('=')) continue;
    const separator = field.indexOf('=', 1);
    if (separator > 1) attributes[field.slice(1, separator)] = field.slice(separator + 1);
  }
  return { kind, attributes };
}

class LocalRouterConnection {
  constructor({ host, address, port, username, password, timeoutMs }) {
    this.timeoutMs = timeoutMs;
    const secure = port === 8729;
    const socketOptions = {
      host: address,
      port,
      ...(secure ? {
        rejectUnauthorized: true,
        ...(net.isIP(host) ? {} : { servername: host }),
      } : {}),
    };
    this.socket = secure ? tls.connect(socketOptions) : net.createConnection(socketOptions);
    this.username = username;
    this.password = password;
    this.buffer = Buffer.alloc(0);
    this.sentence = [];
    this.pending = [];
    this.waiters = [];
    this.failure = null;
    this.closed = false;
    this.socket.setTimeout(timeoutMs, () => this.fail(new Error('RouterOS API request timed out.')));
    this.socket.on('data', (chunk) => this.consume(chunk));
    this.socket.on('error', () => this.fail(new Error('RouterOS API connection failed.')));
    this.socket.on('close', () => {
      this.closed = true;
      if (this.waiters.length) this.fail(new Error('RouterOS closed the API connection.'));
    });
  }

  async connect() {
    const eventName = this.socket instanceof tls.TLSSocket ? 'secureConnect' : 'connect';
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        cleanup();
        this.socket.destroy();
        rejectPromise(new Error('RouterOS API connection timed out.'));
      }, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off(eventName, onConnect);
        this.socket.off('error', onError);
      };
      const onConnect = () => { cleanup(); resolvePromise(); };
      const onError = () => { cleanup(); rejectPromise(new Error('RouterOS API connection failed; verify API-SSL and the router certificate.')); };
      this.socket.once(eventName, onConnect);
      this.socket.once('error', onError);
    });
    await this.login();
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let offset = 0;
    while (offset < this.buffer.length) {
      const decoded = decodeWordLength(this.buffer, offset);
      if (!decoded) break;
      offset += decoded.bytes;
      if (offset + decoded.length > this.buffer.length) {
        offset -= decoded.bytes;
        break;
      }
      if (decoded.length === 0) {
        const waiter = this.waiters.shift();
        if (waiter) {
          clearTimeout(waiter.timer);
          waiter.resolve(this.sentence);
        } else {
          this.pending.push(this.sentence);
        }
        this.sentence = [];
      } else {
        this.sentence.push(this.buffer.toString('utf8', offset, offset + decoded.length));
        offset += decoded.length;
      }
    }
    this.buffer = this.buffer.subarray(offset);
  }

  readSentence() {
    if (this.pending.length) return Promise.resolve(this.pending.shift());
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('RouterOS closed the API connection.'));
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        resolve: resolvePromise,
        reject: rejectPromise,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((item) => item !== waiter);
          rejectPromise(new Error('RouterOS API response timed out.'));
        }, this.timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  fail(error) {
    if (!this.failure) this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
    }
  }

  write(words) {
    if (this.failure) throw this.failure;
    this.socket.write(encodeSentence(words));
  }

  async readUntilDone() {
    const rows = [];
    while (true) {
      const sentence = await this.readSentence();
      const { kind, attributes } = parseSentence(sentence);
      if (kind === '!trap' || kind === '!fatal') {
        throw new Error(attributes.message || attributes.category || 'RouterOS rejected a read-only request.');
      }
      if (kind === '!re') rows.push(attributes);
      if (kind === '!done') return { rows, attributes };
    }
  }

  async login() {
    this.write(['/login', `=name=${this.username}`, `=password=${this.password}`]);
    let result = await this.readUntilDone();
    if (result.attributes.ret) {
      const digest = createHash('md5')
        .update(Buffer.concat([Buffer.from([0]), Buffer.from(this.password), Buffer.from(result.attributes.ret, 'hex')]))
        .digest('hex');
      this.write(['/login', `=name=${this.username}`, `=response=00${digest}`]);
      result = await this.readUntilDone();
    }
    return result;
  }

  async read(commandWords) {
    this.write(commandWords);
    return this.readUntilDone();
  }

  close() {
    this.socket.destroy();
  }
}

function validateRouterConfig(env = {}) {
  const host = String(env.ROUTER_HOST ?? '').trim();
  const username = String(env.ROUTER_USER ?? '');
  const password = String(env.ROUTER_PASSWORD ?? '');
  const portValue = String(env.ROUTER_PORT ?? DEFAULT_ROUTER_PORT).trim();
  const port = /^(8728|8729)$/.test(portValue) ? Number(portValue) : NaN;
  const timeoutValue = Number.parseInt(String(env.ROUTER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS), 10);
  const allowInsecure = String(env.ROUTER_ALLOW_INSECURE_LOCAL ?? '').trim().toLowerCase() === 'true';
  if (!host || !username || !password) {
    throw new Error('Set ROUTER_HOST, ROUTER_USER, and ROUTER_PASSWORD in the local .env.router.local file.');
  }
  if (![8728, 8729].includes(port)) throw new Error('Only RouterOS API-SSL 8729 or explicitly opted-in local API 8728 is supported.');
  if (port === 8728 && !allowInsecure) {
    throw new Error('Plaintext RouterOS API on port 8728 is disabled; set ROUTER_ALLOW_INSECURE_LOCAL=true only for a private-LAN router.');
  }
  if (port === 8729 && allowInsecure) throw new Error('Remove ROUTER_ALLOW_INSECURE_LOCAL for API-SSL on port 8729.');
  const timeoutMs = Number.isInteger(timeoutValue) && timeoutValue > 0 ? Math.min(timeoutValue, 30000) : DEFAULT_TIMEOUT_MS;
  return { host, port, username, password, timeoutMs };
}

async function readRouterSubscribers(config, address) {
  const connection = new LocalRouterConnection({ ...config, address });
  try {
    await connection.connect();
    try {
      const secretReply = await connection.read(ROUTEROS_DISCOVERY_COMMANDS.secrets);
      const secretSubscribers = normalizeRouterRows(secretReply.rows, 'remote-address');
      if (secretSubscribers.length) return secretSubscribers;
    } catch {
      // An explicitly read-only account may not have permission to list secrets.
      // Fall back to current active sessions, still requesting only safe fields.
    }
    const activeReply = await connection.read(ROUTEROS_DISCOVERY_COMMANDS.active);
    return normalizeRouterRows(activeReply.rows, 'address');
  } finally {
    connection.close();
  }
}

export async function readRouterActiveTelemetry(config, address) {
  const connection = new LocalRouterConnection({ ...config, address });
  try {
    await connection.connect();
    const reply = await connection.read(ROUTEROS_TELEMETRY_COMMAND);
    return reply.rows;
  } finally {
    connection.close();
  }
}

async function importSubscriber({ supabase, args, fetchImpl = globalThis.fetch }) {
  const endpoint = `${supabase.url}/rest/v1/rpc/import_router_subscriber`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        apikey: supabase.publishableKey,
        authorization: `Bearer ${supabase.adminAccessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error('Could not reach the configured Supabase project. No service-role credentials are supported by this script.');
  }
  if (!response.ok) {
    throw new Error(`Supabase import RPC failed with HTTP ${response.status}; verify the admin session, organization membership, and reviewed import RPC migration.`);
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('Supabase returned an invalid import RPC response.');
  }
  if (Array.isArray(result)) [result] = result;
  if (typeof result?.imported !== 'boolean') throw new Error('The import RPC returned an unexpected response.');
  return result;
}

function usage() {
  return [
    'Local RouterOS subscriber sync',
    '',
    'Usage:',
    '  node scripts/local-router-sync.js [--dry-run] [--username USER ...]',
    '  node scripts/local-router-sync.js --apply [--username USER ...]',
    '',
    'Dry-run is the default and never contacts Supabase. --apply is required for writes.',
    'Router discovery is read-only. RouterOS PPPoE passwords are never requested or imported.',
  ].join('\n');
}

export async function runLocalRouterSync({ argv = process.argv.slice(2), cwd = process.cwd(), processEnv = process.env, fetchImpl = globalThis.fetch, output = console } = {}) {
  const options = parseCliArgs(argv);
  if (options.help) {
    output.log(usage());
    return { help: true };
  }
  const env = await loadLocalEnvironment({ cwd, processEnv });
  const router = validateRouterConfig(env);
  const supabase = options.apply ? validateSupabaseConfig(env) : null;
  if (options.usernames.length > MAX_IMPORT_COUNT) throw new Error(`At most ${MAX_IMPORT_COUNT} --username values may be supplied.`);
  if (options.apply) await verifySupabaseAdminAccess(supabase, fetchImpl);

  const { address } = await resolvePrivateRouterAddress(router.host);
  const subscribers = await readRouterSubscribers(router, address);
  const discoveredNames = new Set(subscribers.map((subscriber) => subscriber.username));
  const missingNames = options.usernames.filter((username) => !discoveredNames.has(username));
  if (missingNames.length) throw new Error('At least one requested --username was not discovered on the local router; no import was attempted.');
  const selected = options.usernames.length
    ? subscribers.filter((subscriber) => options.usernames.includes(subscriber.username))
    : subscribers;
  if (selected.length > MAX_IMPORT_COUNT) throw new Error(`Found ${selected.length} selected subscribers; limit is ${MAX_IMPORT_COUNT}. Use repeated --username filters to select a smaller set.`);

  output.log(`Router discovery complete: ${subscribers.length} subscriber record(s); ${selected.length} selected.`);
  for (const subscriber of selected) output.log(`  ${subscriber.username}  ${subscriber.profile || '(no profile)'}`);
  if (!options.apply) {
    output.log('DRY RUN: no subscriber data was sent to Supabase and no database writes were made.');
    output.log('Review the list, then rerun with --apply to send these selected subscriber records.');
    return { apply: false, discovered: subscribers.length, selected: selected.length };
  }

  output.log('APPLY MODE: selected subscriber metadata will be sent to the configured Supabase project; RouterOS credentials stay local.');
  let imported = 0;
  let skipped = 0;
  for (const subscriber of selected) {
    const result = await importSubscriber({
      supabase,
      args: mapSubscriberToRpcArgs(supabase.organizationId, subscriber),
      fetchImpl,
    });
    if (result.imported) {
      imported += 1;
      output.log(`Imported ${subscriber.username}.`);
    } else {
      skipped += 1;
      output.log(`Skipped ${subscriber.username} (already imported).`);
    }
  }
  output.log(`Sync finished: ${imported} imported, ${skipped} skipped.`);
  return { apply: true, discovered: subscribers.length, selected: selected.length, imported, skipped };
}

export const localRouterSyncInternals = Object.freeze({
  DEFAULT_ROUTER_PORT,
  ROUTEROS_DISCOVERY_COMMANDS,
  ROUTEROS_TELEMETRY_COMMAND,
  isPublishableSupabaseKey,
  parseJwtPayload,
  resolvePrivateRouterAddress,
  validateRouterConfig,
});

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runLocalRouterSync().catch((error) => {
    console.error(`Local router sync stopped: ${error?.message || 'unexpected error'}`);
    process.exitCode = 1;
  });
}
