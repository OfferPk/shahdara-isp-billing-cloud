import { createClient } from '@supabase/supabase-js';
import { Readable } from 'node:stream';
import { createPppoeApiHandler } from './pppoe-api.js';

function matchesPppoeApi(requestUrl) {
  try {
    const pathname = new URL(requestUrl ?? '/', 'http://vite.local').pathname;
    return pathname.startsWith('/api/admin/pppoe/') || pathname.startsWith('/api/admin/subscribers/');
  } catch {
    return false;
  }
}

export function pppoeApiPlugin(env = process.env) {
  const handle = createPppoeApiHandler({ env, createClient });
  const middleware = (request, response, next) => {
    if (!matchesPppoeApi(request.url)) return next();
    const host = request.headers.host || 'localhost';
    const url = new URL(request.url || '/', `http://${host}`);
    const method = request.method || 'GET';
    const requestInit = { method, headers: request.headers };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      requestInit.body = Readable.toWeb(request);
      requestInit.duplex = 'half';
    }
    const webRequest = new Request(url, requestInit);
    handle(webRequest).then(async (webResponse) => {
      response.statusCode = webResponse.status;
      for (const [name, value] of webResponse.headers) response.setHeader(name, value);
      const body = await webResponse.arrayBuffer();
      response.end(body.byteLength ? Buffer.from(body) : undefined);
    }).catch(() => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.setHeader('cache-control', 'no-store');
      response.end(JSON.stringify({ error: 'Router telemetry request failed.' }));
    });
  };
  return {
    name: 'shahdara-pppoe-read-only-api',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
