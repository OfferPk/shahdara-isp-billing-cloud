import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createPppoeApiHandler } from './pppoe-api.js';
import { loadEnvironment } from './environment.js';

export function createPppoeApiServer({ env = process.env, createClient: clientFactory = createClient, adapter, handler } = {}) {
  const handle = handler ?? createPppoeApiHandler({ env, createClient: clientFactory, adapter });
  return createServer(async (request, response) => {
    try {
      const scheme = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const host = request.headers.host || 'localhost';
      const webRequest = new Request(new URL(request.url || '/', `${scheme}://${host}`), {
        method: request.method || 'GET',
        headers: request.headers,
      });
      const webResponse = await handle(webRequest);
      response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
      const body = await webResponse.arrayBuffer();
      response.end(body.byteLength ? Buffer.from(body) : undefined);
    } catch {
      response.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(JSON.stringify({ error: 'Router telemetry request failed.' }));
    }
  });
}

async function start() {
  const env = await loadEnvironment();
  const server = createPppoeApiServer({ env });
  const port = Number.parseInt(env.PORT ?? '4173', 10) || 4173;
  const host = env.HOST || '0.0.0.0';
  server.listen(port, host, () => {
    console.log(`Shahdara read-only PPPoE API listening on http://${host}:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error('Unable to start the PPPoE API service.', error);
    process.exitCode = 1;
  });
}
