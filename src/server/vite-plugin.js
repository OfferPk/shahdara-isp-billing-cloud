import { createClient } from '@supabase/supabase-js';
import { createPppoeApiHandler } from './pppoe-api.js';

function matchesPppoeApi(requestUrl) {
  try {
    return new URL(requestUrl ?? '/', 'http://vite.local').pathname.startsWith('/api/admin/pppoe/');
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
    const webRequest = new Request(url, { method: request.method || 'GET', headers: request.headers });
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
