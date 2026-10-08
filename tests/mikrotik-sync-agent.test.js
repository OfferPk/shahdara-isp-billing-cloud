import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentFailure,
  createAgent,
  normalizeRouterOsActiveSession,
  pollRouterOsActive,
} from '../agent/mikrotik-sync-agent.js';

const token = 'synthetic-agent-token-'.padEnd(40, 'x');
const config = {
  routerBaseUrl: 'https://router.example.test',
  routerUsername: 'read-only-poller',
  routerPassword: 'synthetic-router-password',
  ingestUrl: 'https://synthetic-project.supabase.co/functions/v1/sync-agent-ingest',
  ingestToken: token,
  requestTimeoutMs: 50,
  maxRetries: 0,
  maxBackoffMs: 500,
  pollIntervalMs: 300_000,
};

function makeLogger() {
  const messages = [];
  return {
    messages,
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
    error: (message) => messages.push(message),
  };
}

test('normalization maps router-transmitted bytes to download and router-received bytes to upload', () => {
  assert.deepEqual(normalizeRouterOsActiveSession({
    name: 'subscriber-1',
    'session-id': '*A1',
    bytes: '9007199254740993/184467440737095516',
  }), {
    username: 'subscriber-1',
    session_id: '*A1',
    bytes_in: '9007199254740993',
    bytes_out: '184467440737095516',
  });
  assert.deepEqual(normalizeRouterOsActiveSession({
    name: 'subscriber-2',
    'session-id': '*A2',
    bytes: ['12', '34'],
  }).bytes_out, '34');
});

test('malformed, negative, unsafe numeric, and out-of-range counters are rejected', () => {
  const base = { name: 'subscriber-1', 'session-id': '*A1', bytes: '1/2' };
  for (const bytes of ['1/-2', '1.5/2', '9223372036854775808/2', 42, ['1', '-2']]) {
    assert.throws(
      () => normalizeRouterOsActiveSession({ ...base, bytes }),
      (error) => error instanceof AgentFailure,
    );
  }
  assert.throws(() => normalizeRouterOsActiveSession({ ...base, name: ' subscriber-1' }), AgentFailure);
});

test('empty session response is a successful poll and never posts or marks subscribers offline', async () => {
  const calls = [];
  const logger = makeLogger();
  const agent = createAgent(config, {
    logger,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      assert.equal(init.method, 'GET');
      return Response.json([]);
    },
  });

  assert.deepEqual(await agent.runCycle(), { status: 'empty', sessions: 0, synced: 0 });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/rest/ppp/active');
  assert.equal(new URL(calls[0].url).searchParams.get('.proplist'), 'name,bytes,session-id');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.Authorization.startsWith('Basic '), true);
  assert.match(logger.messages[0], /"outcome":"empty"/);
});

test('RouterOS active-session counters are posted only as keyed session deltas', async () => {
  const calls = [];
  const logger = makeLogger();
  const agent = createAgent(config, {
    logger,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json([{
        name: 'subscriber-private-name',
        'session-id': '*A9',
        bytes: '100/200',
      }]);
    },
  });

  assert.deepEqual(await agent.runCycle(), { status: 'published', sessions: 1, synced: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[1].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    counter_scope: 'routeros-session-delta',
    items: [{ username: 'subscriber-private-name', session_id: '*A9', bytes_in: '100', bytes_out: '200' }],
  });
  assert.equal(logger.messages.some((message) => message.includes('subscriber-private-name')), false);
  assert.match(logger.messages[0], /session_deltas_published/);
});

test('timeout is bounded and no fallback or broker request is attempted', async () => {
  let requestCount = 0;
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    requestCount += 1;
    // Node 22 may unref AbortSignal.timeout's timer; keep this mock request
    // pending in the event loop until the abort event is observed.
    const keepAlive = setTimeout(() => {}, 1_000);
    const rejectOnAbort = () => reject(signal.reason);
    const finishOnAbort = () => {
      clearTimeout(keepAlive);
      rejectOnAbort();
    };
    if (signal.aborted) finishOnAbort();
    else signal.addEventListener('abort', finishOnAbort, { once: true });
  });

  await assert.rejects(
    pollRouterOsActive({ config: { ...config, requestTimeoutMs: 10 }, fetchImpl }),
    (error) => error instanceof AgentFailure && error.kind === 'timeout',
  );
  assert.equal(requestCount, 1);
});

test('happy path posts only an explicitly session-scoped delta snapshot over HTTPS', async () => {
  const calls = [];
  const logger = makeLogger();
  const agent = createAgent(config, {
    logger,
    pollSnapshots: async () => ({
      complete: true,
      counterScope: 'routeros-session-delta',
      items: [
        { username: 'subscriber-approved', session_id: '*A77', bytes_in: '9007199254740993', bytes_out: '12' },
      ],
    }),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 200 });
    },
  });

  assert.deepEqual(await agent.runCycle(), { status: 'published', sessions: 1, synced: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, config.ingestUrl);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    counter_scope: 'routeros-session-delta',
    items: [{ username: 'subscriber-approved', session_id: '*A77', bytes_in: '9007199254740993', bytes_out: '12' }],
  });
  assert.equal(logger.messages.some((message) => message.includes('subscriber-approved')), false);
});

test('a partial or failed poll never reaches the broker', async () => {
  let postCount = 0;
  const agent = createAgent(config, {
    pollSnapshots: async () => ({ complete: false, counterScope: 'routeros-session-delta', items: [] }),
    fetchImpl: async () => {
      postCount += 1;
      return new Response(null, { status: 200 });
    },
  });
  await assert.rejects(agent.runCycle(), (error) => error instanceof AgentFailure && error.kind === 'incomplete-poll');
  assert.equal(postCount, 0);
});
