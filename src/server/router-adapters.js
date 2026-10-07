import { createHash } from 'node:crypto';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { MockRouterAdapter } from '../pppoe-mock-adapter.js';
export { MockRouterAdapter };

const DEFAULT_ROUTER_HOST = '10.10.20.1';
const DEFAULT_ROUTER_PORT = 8728;
const API_TIMEOUT_MS = 5000;
const READ_COMMANDS = new Set(['/ppp/active/print', '/system/resource/print']);

function formatUptime(seconds) {
  let remaining = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return `${days}d ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
}

function parseRouterUptime(value) {
  const text = String(value ?? '');
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(w|d|h|m|s|ms)/g)];
  if (!parts.length) return 0;
  const multipliers = { w: 604800, d: 86400, h: 3600, m: 60, s: 1, ms: 0.001 };
  return Math.floor(parts.reduce((total, [, amount, unit]) => total + Number(amount) * multipliers[unit], 0));
}

function safeBigInt(value) {
  try {
    if (typeof value === 'bigint') return value < 0n ? 0n : value;
    const digits = String(value ?? '0').trim();
    return /^\d+$/.test(digits) ? BigInt(digits) : 0n;
  } catch {
    return 0n;
  }
}

function parseByteCounters(row) {
  const combined = String(row.bytes ?? '').split('/');
  return {
    bytesIn: safeBigInt(row['bytes-in'] ?? row['rx-byte'] ?? row['rx-bytes'] ?? combined[0]),
    bytesOut: safeBigInt(row['bytes-out'] ?? row['tx-byte'] ?? row['tx-bytes'] ?? combined[1]),
  };
}

function apiWordLength(length) {
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
  const frames = [];
  for (const word of words) {
    const data = Buffer.from(String(word), 'utf8');
    frames.push(apiWordLength(data.length), data);
  }
  frames.push(Buffer.from([0]));
  return Buffer.concat(frames);
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

function parseSentence(sentence) {
  const [kind = '', ...words] = sentence;
  const attributes = {};
  for (const word of words) {
    if (!word.startsWith('=')) continue;
    const secondEquals = word.indexOf('=', 1);
    if (secondEquals < 0) continue;
    attributes[word.slice(1, secondEquals)] = word.slice(secondEquals + 1);
  }
  return { kind, attributes };
}

function routerTrapError(sentence) {
  const parsed = parseSentence(sentence);
  if (parsed.kind === '!trap' || parsed.kind === '!fatal') {
    return new Error(parsed.attributes.message || parsed.attributes.category || 'RouterOS API rejected a read request.');
  }
  return null;
}

class RouterOsConnection {
  constructor({ host, port, username, password, timeoutMs }) {
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.socket = net.createConnection({ host, port });
    this.pending = [];
    this.waiters = [];
    this.packet = Buffer.alloc(0);
    this.sentence = [];
    this.failure = null;
    this.closed = false;
    this.socket.setTimeout(timeoutMs, () => this.fail(new Error('RouterOS API request timed out.')));
    this.socket.on('data', (chunk) => this.consume(chunk));
    this.socket.on('error', (error) => this.fail(error));
    this.socket.on('close', () => {
      this.closed = true;
      if (this.waiters.length) this.fail(new Error('Router closed the API connection.'));
    });
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const onConnect = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const cleanup = () => {
        this.socket.off('connect', onConnect);
        this.socket.off('error', onError);
      };
      this.socket.once('connect', onConnect);
      this.socket.once('error', onError);
    });
    await this.login();
  }

  consume(chunk) {
    this.packet = Buffer.concat([this.packet, chunk]);
    let offset = 0;
    while (offset < this.packet.length) {
      const decoded = decodeWordLength(this.packet, offset);
      if (!decoded) break;
      offset += decoded.bytes;
      if (offset + decoded.length > this.packet.length) {
        offset -= decoded.bytes;
        break;
      }
      if (decoded.length === 0) {
        this.deliver(this.sentence);
        this.sentence = [];
      } else {
        this.sentence.push(this.packet.toString('utf8', offset, offset + decoded.length));
        offset += decoded.length;
      }
    }
    this.packet = this.packet.subarray(offset);
  }

  deliver(sentence) {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(sentence);
    } else {
      this.pending.push(sentence);
    }
  }

  readSentence() {
    if (this.pending.length) return Promise.resolve(this.pending.shift());
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('Router closed the API connection.'));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
          reject(new Error('RouterOS API request timed out.'));
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
      const error = routerTrapError(sentence);
      if (error) throw error;
      const parsed = parseSentence(sentence);
      if (parsed.kind === '!re') rows.push(parsed.attributes);
      if (parsed.kind === '!done') return { rows, attributes: parsed.attributes };
    }
  }

  async login() {
    this.write(['/login', `=name=${this.username}`, `=password=${this.password}`]);
    let reply = await this.readUntilDone();
    const challenge = reply.attributes.ret;
    if (challenge) {
      const digest = createHash('md5')
        .update(Buffer.concat([Buffer.from([0]), Buffer.from(this.password), Buffer.from(challenge, 'hex')]))
        .digest('hex');
      this.write(['/login', `=name=${this.username}`, `=response=00${digest}`]);
      reply = await this.readUntilDone();
    }
    return reply;
  }

  async command(command, properties = []) {
    if (!READ_COMMANDS.has(command)) throw new Error('Only the configured RouterOS read commands are allowed.');
    const words = [command, ...properties];
    const startedAt = performance.now();
    this.write(words);
    const response = await this.readUntilDone();
    return { ...response, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)) };
  }

  close() {
    this.socket.destroy();
  }
}

async function routerRequest(config, command, properties = []) {
  if (!READ_COMMANDS.has(command)) throw new Error('Only the configured RouterOS read commands are allowed.');
  const connection = new RouterOsConnection(config);
  const connectedAt = performance.now();
  try {
    await connection.connect();
    const response = await connection.command(command, properties);
    return { ...response, elapsedMs: Math.max(response.elapsedMs, Math.round(performance.now() - connectedAt)) };
  } finally {
    connection.close();
  }
}

function routerConfig(env) {
  const timeout = Number.parseInt(env.ROUTER_TIMEOUT_MS ?? '', 10);
  return {
    host: String(env.ROUTER_HOST ?? '').trim(),
    port: Number.parseInt(env.ROUTER_PORT ?? String(DEFAULT_ROUTER_PORT), 10) || DEFAULT_ROUTER_PORT,
    username: String(env.ROUTER_USER ?? ''),
    password: String(env.ROUTER_PASSWORD ?? ''),
    timeoutMs: Number.isInteger(timeout) && timeout > 0 ? Math.min(timeout, 30000) : API_TIMEOUT_MS,
  };
}

export class MikroTikRouterAdapter {
  constructor({ env = process.env, now = () => new Date(), request = routerRequest } = {}) {
    this.env = env;
    this.now = now;
    this.request = request;
    this.lastHealth = null;
  }

  config() {
    return routerConfig(this.env);
  }

  async getActiveSessions() {
    const config = this.config();
    if (!config.host || !config.username || !config.password) return [];
    try {
      const response = await this.request(config, '/ppp/active/print', [
        '=.proplist=.id,name,caller-id,address,uptime,bytes,packets,session-id,limit-bytes-in,limit-bytes-out',
        '=stats=',
      ]);
      const polledAt = this.now().toISOString();
      return response.rows.map((row) => {
        const username = String(row.name ?? '');
        const uptimeSeconds = parseRouterUptime(row.uptime);
        const counters = parseByteCounters(row);
        return {
          sessionId: String(row['.id'] ?? row['session-id'] ?? username),
          username,
          callerId: String(row['caller-id'] ?? ''),
          ipAddress: String(row.address ?? ''),
          interfaceName: `<pppoe-${username}>`,
          uptime: formatUptime(uptimeSeconds),
          uptimeSeconds,
          ...counters,
          rateLimit: row['rate-limit'] ? String(row['rate-limit']) : undefined,
          status: 'Online',
          lastPolledAt: polledAt,
        };
      }).filter((row) => row.username);
    } catch {
      return [];
    }
  }

  async getRouterHealth() {
    const config = this.config();
    if (!config.host || !config.username || !config.password) {
      const disconnected = {
        connected: false,
        routerHost: config.host || DEFAULT_ROUTER_HOST,
        latencyMs: 0,
        lastCheckedAt: this.now().toISOString(),
      };
      this.lastHealth = disconnected;
      return disconnected;
    }
    try {
      const response = await this.request(config, '/system/resource/print', [
        '=.proplist=version,cpu-load,free-memory,total-memory',
      ]);
      const resource = response.rows[0] ?? {};
      const freeBytes = safeBigInt(resource['free-memory']);
      const health = {
        connected: true,
        routerHost: config.host,
        ...(resource.version ? { routerOsVersion: String(resource.version) } : {}),
        ...(Number.isFinite(Number(resource['cpu-load'])) ? { cpuLoadPercent: Number(resource['cpu-load']) } : {}),
        ...(freeBytes > 0n ? { freeMemoryMb: Number(freeBytes / 1048576n) } : {}),
        latencyMs: response.elapsedMs,
        lastCheckedAt: this.now().toISOString(),
      };
      this.lastHealth = health;
      return health;
    } catch {
      const disconnected = {
        connected: false,
        routerHost: config.host,
        latencyMs: 0,
        lastCheckedAt: this.now().toISOString(),
      };
      this.lastHealth = disconnected;
      return disconnected;
    }
  }
}

export function createRouterAdapter({ env = process.env, ...options } = {}) {
  const driver = String(env.ROUTER_DRIVER ?? '').trim().toLowerCase();
  if (driver === 'mikrotik') return new MikroTikRouterAdapter({ env, ...options });
  return new MockRouterAdapter({ host: env.MOCK_ROUTER_HOST || DEFAULT_ROUTER_HOST, ...options });
}

export const routerAdapterInternals = Object.freeze({
  encodeSentence,
  decodeWordLength,
  formatUptime,
  parseRouterUptime,
  parseByteCounters,
  apiRequest: routerRequest,
});
