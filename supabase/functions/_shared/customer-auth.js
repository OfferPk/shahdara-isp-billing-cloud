export const APPROVED_APP_ORIGIN = 'https://offerpk.github.io';
export const SYNTHETIC_AUTH_DOMAIN = 'internal.shahdara.net';

export function jsonResponse(status, body, origin = null, extraHeaders = {}) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    Vary: 'Origin',
  });
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

export function exactOrigin(request, env) {
  const configured = env.get('APP_ORIGIN');
  const requestOrigin = request.headers.get('origin') ?? '';
  return configured === APPROVED_APP_ORIGIN && requestOrigin === APPROVED_APP_ORIGIN
    ? APPROVED_APP_ORIGIN
    : null;
}

export function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function readJson(request, maxChars = 8192) {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > maxChars) return null;
  let text;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > maxChars) return null;
  try {
    const payload = JSON.parse(text);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function bearerToken(request) {
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return '';
  return authorization.slice('Bearer '.length).trim();
}

function canonicalIp(value) {
  const input = String(value ?? '').trim();
  if (!input || input.length > 64 || /[%\s,"']/u.test(input)) return '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(input)) {
    const octets = input.split('.').map(Number);
    if (octets.some((part) => part < 0 || part > 255)) return '';
    return octets.join('.');
  }
  if (!/^[0-9a-f:.]+$/i.test(input) || !input.includes(':')) return '';
  try {
    const parsed = new URL(`http://[${input}]/`);
    const host = parsed.hostname.toLowerCase();
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : '';
  } catch {
    return '';
  }
}

// Supabase's API security docs use the first X-Forwarded-For item as the client IP.
// Managed-gateway trust/stripping behavior must still be verified in isolated staging.
export function forwardedClientIp(request) {
  const header = request.headers.get('x-forwarded-for') ?? '';
  if (!header || header.length > 512) return '';
  const first = header.split(',', 1)[0];
  return canonicalIp(first);
}

export async function hmacHex(secret, scope, value) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('HMAC key unavailable');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${scope}:${value}`),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomHex(byteCount = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function temporaryPassword() {
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!@#$%_-';
  const all = `${lower}${upper}${digits}${symbols}`;
  const bytes = crypto.getRandomValues(new Uint32Array(32));
  const pick = (alphabet, index) => alphabet[index % alphabet.length];
  const output = [
    pick(lower, bytes[0]), pick(upper, bytes[1]),
    pick(digits, bytes[2]), pick(symbols, bytes[3]),
  ];
  for (let index = 4; index < bytes.length; index += 1) output.push(pick(all, bytes[index]));
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = bytes[index] % (index + 1);
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output.join('');
}

export function customerLoginId() {
  return `sf-${randomHex(16)}`;
}

export function syntheticAuthAlias() {
  return `portal-${randomHex(16)}@${SYNTHETIC_AUTH_DOMAIN}`;
}
