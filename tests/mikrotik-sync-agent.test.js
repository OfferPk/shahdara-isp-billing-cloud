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
    bytes_in: '9007199254740993',
    bytes_out: '184467440737095516',
    is_online: true,
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

test('RouterOS active-session counters are never posted as subscriber-lifetime counters', async () => {
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

  assert.deepEqual(await agent.runCycle(), {
    status: 'blocked-counter-semantics',
    sessions: 1,
    synced: 0,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(logger.messages.some((message) => message.includes('subscriber-private-name')), false);
  assert.match(logger.messages[0], /counter_source_not_subscriber_cumulative/);
});

test('timeout is bounded and no fallback or broker request is attempted', async () => {
  let requestCount = 0;
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    requestCount += 1;
    const rejectOnAbort = () => reject(signal.reason);
    if (signal.aborted) rejectOnAbort();
    else signal.addEventListener('abort', rejectOnAbort, { once: true });
  });

  await assert.rejects(
    pollRouterOsActive({ config: { ...config, requestTimeoutMs: 10 }, fetchImpl }),
    (error) => error instanceof AgentFailure && error.kind === 'timeout',
  );
  assert.equal(requestCount, 1);
});

test('happy path posts only an explicitly cumulative snapshot over HTTPS', async () => {
  const calls = [];
  const logger = makeLogger();
  const agent = createAgent(config, {
    logger,
    pollSnapshots: async () => ({
      complete: true,
      counterScope: 'subscriber-cumulative',
      items: [
        { username: 'subscriber-approved', bytes_in: '9007199254740993', bytes_out: '12', is_online: true },
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
    counter_scope: 'subscriber_cumulative',
    items: [{ username: 'subscriber-approved', bytes_in: '9007199254740993', bytes_out: '12', is_online: true }],
  });
  assert.equal(logger.messages.some((message) => message.includes('subscriber-approved')), false);
});

test('a partial or failed poll never reaches the broker', async () => {
  let postCount = 0;
  const agent = createAgent(config, {
    pollSnapshots: async () => ({ complete: false, counterScope: 'subscriber-cumulative', items: [] }),
    fetchImpl: async () => {
      postCount += 1;
      return new Response(null, { status: 200 });
    },
  });
  await assert.rejects(agent.runCycle(), (error) => error instanceof AgentFailure && error.kind === 'incomplete-poll');
  assert.equal(postCount, 0);
});
