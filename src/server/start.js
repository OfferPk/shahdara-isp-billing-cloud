import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createPppoeApiHandler } from './pppoe-api.js';
import { loadEnvironment } from './environment.js';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const distRoot = resolve(projectRoot, 'dist');
const env = await loadEnvironment({ cwd: projectRoot });
const api = createPppoeApiHandler({ env, createClient });
const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

async function serveFile(request, response) {
  if (!['GET', 'HEAD'].includes(request.method || '')) {
    response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }).end();
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname); } catch {
    response.writeHead(400, { 'cache-control': 'no-store' }).end('Bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  let filePath = resolve(distRoot, `.${pathname}`);
  if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${sep}`)) {
    response.writeHead(403, { 'cache-control': 'no-store' }).end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = resolve(filePath, 'index.html');
    const data = await readFile(filePath);
    response.writeHead(200, {
      'content-type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': data.length,
      'x-content-type-options': 'nosniff',
      'cache-control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (error?.code === 'ENOENT' && !extname(pathname)) {
      try {
        const data = await readFile(resolve(distRoot, 'index.html'));
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        response.end(data);
        return;
      } catch { /* Report the missing build below. */ }
    }
    response.writeHead(error?.code === 'ENOENT' ? 404 : 500, { 'cache-control': 'no-store' }).end('Not found');
  }
}

const server = createServer(async (request, response) => {
  const pathname = (() => {
    try { return new URL(request.url || '/', 'http://localhost').pathname; } catch { return ''; }
  })();
  if (pathname.startsWith('/api/admin/pppoe/')) {
    try {
      const origin = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const host = request.headers.host || 'localhost';
      const webRequest = new Request(new URL(request.url || '/', `${origin}://${host}`), {
        method: request.method || 'GET',
        headers: request.headers,
      });
      const webResponse = await api(webRequest);
      response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
      const body = await webResponse.arrayBuffer();
      response.end(body.byteLength ? Buffer.from(body) : undefined);
    } catch {
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: 'Router telemetry request failed.' }));
    }
    return;
  }
  await serveFile(request, response);
});

const port = Number.parseInt(env.PORT ?? '4173', 10) || 4173;
const host = env.HOST || '0.0.0.0';
server.listen(port, host, () => {
  console.log(`Shahdara portal and read-only PPPoE API listening on http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
