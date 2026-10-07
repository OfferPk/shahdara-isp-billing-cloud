import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyncAgentIngestHandler } from '../supabase/functions/sync-agent-ingest/handler.js';

const token = 'test-agent-token-'.padEnd(40, 'x');
const serviceRoleKey = 'synthetic-server-only-service-role-key';
const validItems = [
  { username: 'subscriber-a', bytes_in: '9007199254740993', bytes_out: '22', is_online: true },
  { username: 'subscriber-b', bytes_in: 0, bytes_out: '9223372036854775807', is_online: false },
];

function makeHarness(options = {}) {
  const settings = new Map([
    ['SYNC_AGENT_INGEST_TOKEN', options.token ?? token],
    ['SYNC_AGENT_COUNTER_SOURCE_CONFIRMED', options.confirmed ?? 'true'],
    ['SYNC_AGENT_DELTA_SOURCE_CONFIRMED', options.deltaConfirmed ?? 'true'],
    ['SUPABASE_URL', options.url ?? 'https://synthetic-project.supabase.co'],
    ['SUPABASE_SERVICE_ROLE_KEY', options.serviceRoleKey ?? serviceRoleKey],
  ]);
  const calls = [];
  const env = { get: (name) => settings.get(name) ?? null };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init: structuredClone(init) });
    if (options.fetchError) throw options.fetchError;
    return new Response(null, { status: options.rpcStatus ?? 200 });
  };
  const handler = createSyncAgentIngestHandler({ env, fetchImpl });
  return { handler, calls, settings };
}

function makeRequest(options = {}) {
  const { body, method = 'POST', headers = {} } = options;
  const authorization = Object.hasOwn(options, 'authorization')
    ? options.authorization
    : `Bearer ${token}`;
  const requestHeaders = new Headers({
    'Content-Type': 'application/json',
    ...headers,
  });
  if (authorization !== undefined) requestHeaders.set('Authorization', authorization);
  return new Request('https://synthetic-project.supabase.co/functions/v1/sync-agent-ingest', {
    method,
    headers: requestHeaders,
    ...(method !== 'GET' && method !== 'HEAD' && body !== undefined
      ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
      : {}),
  });
}

const validPayload = { counter_scope: 'subscriber_cumulative', items: validItems };

async function bodyOf(response) {
  return response.status === 204 ? null : response.json();
}

test('happy path validates the batch and invokes only the existing RPC sequentially', async () => {
  const { handler, calls } = makeHarness();
  const response = await handler(makeRequest({ body: validPayload }));

  assert.equal(response.status, 200);
  const responseBody = await bodyOf(response);
  assert.deepEqual(responseBody, { accepted: 2 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ init }) => JSON.parse(init.body)), [
    {
      p_username: 'subscriber-a',
      p_bytes_in: '9007199254740993',
      p_bytes_out: '22',
      p_is_online: true,
      p_last_ip: null,
    },
    {
      p_username: 'subscriber-b',
      p_bytes_in: '0',
      p_bytes_out: '9223372036854775807',
      p_is_online: false,
      p_last_ip: null,
    },
  ]);
  assert.ok(calls.every(({ url }) => url === 'https://synthetic-project.supabase.co/rest/v1/rpc/sync_customer_bandwidth_usage'));
  assert.ok(calls.every(({ init }) => init.method === 'POST' && init.redirect === 'manual'));
  assert.ok(calls.every(({ init }) => init.headers.apikey === serviceRoleKey));
  assert.ok(calls.every(({ init }) => init.headers.Authorization === `Bearer ${serviceRoleKey}`));
  assert.doesNotMatch(JSON.stringify(responseBody), /service-role|subscriber-a|subscriber-b/);
});

test('an empty completed batch is a successful no-op', async () => {
  const { handler, calls } = makeHarness();
  const response = await handler(makeRequest({ body: { counter_scope: 'subscriber_cumulative', items: [] } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { accepted: 0 });
  assert.equal(calls.length, 0);
});

test('missing, malformed, and incorrect dedicated bearer credentials are rejected before RPC access', async (t) => {
  for (const [label, authorization] of [
    ['missing', undefined],
    ['wrong scheme', 'Basic abc'],
    ['incorrect', 'Bearer wrong-agent-token'],
  ]) {
    await t.test(label, async () => {
      const { handler, calls } = makeHarness();
      const response = await handler(makeRequest({ body: validPayload, authorization }));
      assert.equal(response.status, 401);
      assert.deepEqual(await bodyOf(response), { error: 'Not authorized.' });
      assert.equal(calls.length, 0);
    });
  }
});

test('short secrets, an unconfirmed source, and non-HTTPS Supabase URLs fail closed', async (t) => {
  await t.test('short bearer secret is a configuration error', async () => {
    const { handler, calls } = makeHarness({ token: 'short' });
    assert.equal((await handler(makeRequest({ body: validPayload }))).status, 503);
    assert.equal(calls.length, 0);
  });
  await t.test('server-side cumulative-source confirmation is required', async () => {
    const { handler, calls } = makeHarness({ confirmed: '' });
    assert.equal((await handler(makeRequest({ body: validPayload }))).status, 503);
    assert.equal(calls.length, 0);
  });
  await t.test('non-HTTPS Supabase URL is rejected', async () => {
    const { handler, calls } = makeHarness({ url: 'http://synthetic-project.example' });
    assert.equal((await handler(makeRequest({ body: validPayload }))).status, 503);
    assert.equal(calls.length, 0);
  });
});

test('the entire batch is validated before any write', async (t) => {
  const cases = [
    ['per-session scope', { ...validPayload, counter_scope: 'routeros_active_session' }],
    ['untrimmed username', { ...validPayload, items: [{ ...validItems[0], username: ' subscriber-a' }] }],
    ['fractional numeric counter', { ...validPayload, items: [{ ...validItems[0], bytes_in: 1.5 }] }],
    ['unsafe JavaScript integer', { ...validPayload, items: [{ ...validItems[0], bytes_in: Number.MAX_SAFE_INTEGER + 1 }] }],
    ['bigint overflow', { ...validPayload, items: [{ ...validItems[0], bytes_out: '9223372036854775808' }] }],
    ['negative counter', { ...validPayload, items: [{ ...validItems[0], bytes_out: '-1' }] }],
    ['non-boolean online state', { ...validPayload, items: [{ ...validItems[0], is_online: 'true' }] }],
    ['extra item field', { ...validPayload, items: [{ ...validItems[0], last_ip: '192.0.2.8' }] }],
    ['duplicate username', { ...validPayload, items: [validItems[0], { ...validItems[1], username: validItems[0].username }] }],
    ['invalid second item', { ...validPayload, items: [validItems[0], { ...validItems[1], bytes_out: null }] }],
  ];
  for (const [label, body] of cases) {
    await t.test(label, async () => {
      const { handler, calls } = makeHarness();
      const response = await handler(makeRequest({ body }));
      assert.equal(response.status, 400);
      assert.deepEqual(await bodyOf(response), { error: 'Invalid request.' });
      assert.equal(calls.length, 0);
    });
  }
});

test('request size and batch bounds are enforced', async (t) => {
  await t.test('oversized request body gets 413', async () => {
    const { handler, calls } = makeHarness();
    const response = await handler(makeRequest({ body: ' '.repeat(65_537) }));
    assert.equal(response.status, 413);
    assert.equal(calls.length, 0);
  });
  await t.test('more than 100 items gets 400', async () => {
    const { handler, calls } = makeHarness();
    const items = Array.from({ length: 101 }, (_, i) => ({
      username: `subscriber-${i}`,
      bytes_in: '0',
      bytes_out: '0',
      is_online: true,
    }));
    assert.equal((await handler(makeRequest({ body: { counter_scope: 'subscriber_cumulative', items } }))).status, 400);
    assert.equal(calls.length, 0);
  });
});

test('RPC failures return a generic error and never expose internal details', async (t) => {
  for (const options of [
    { rpcStatus: 500 },
    { fetchError: new Error('synthetic database and credential detail') },
  ]) {
    await t.test(options.rpcStatus ? 'non-success response' : 'network exception', async () => {
      const { handler } = makeHarness(options);
      const response = await handler(makeRequest({ body: { counter_scope: 'subscriber_cumulative', items: [validItems[0]] } }));
      assert.equal(response.status, 503);
      const body = await bodyOf(response);
      assert.deepEqual(body, { error: 'Sync ingestion is temporarily unavailable.' });
      assert.doesNotMatch(JSON.stringify(body), /synthetic|service.role|credential/i);
    });
  }
});

test('non-POST methods are rejected without contacting Supabase', async () => {
  const { handler, calls } = makeHarness();
  const response = await handler(makeRequest({ method: 'GET', body: undefined }));
  assert.equal(response.status, 405);
  assert.equal(calls.length, 0);
});

test('RouterOS session deltas are validated and sent in one atomic monthly-aggregation RPC call', async () => {
  const { handler, calls } = makeHarness();
  const items = [
    { username: 'subscriber-a', session_id: '*A1', bytes_in: '6000', bytes_out: '3000' },
    { username: 'subscriber-a', session_id: '*A2', bytes_in: '500', bytes_out: '250' },
  ];
  const response = await handler(makeRequest({ body: { counter_scope: 'routeros-session-delta', items } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { accepted: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://synthetic-project.supabase.co/rest/v1/rpc/sync_customer_bandwidth_session_deltas');
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_items: items });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.apikey, serviceRoleKey);
});

test('delta source remains disabled until its separate server-side gate is confirmed', async () => {
  const { handler, calls } = makeHarness({ deltaConfirmed: '' });
  const response = await handler(makeRequest({ body: {
    counter_scope: 'routeros-session-delta',
    items: [{ username: 'subscriber-a', session_id: '*A1', bytes_in: '1', bytes_out: '2' }],
  } }));
  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
});

test('delta batches reject malformed counters, session identifiers, extra fields, and duplicate session pairs before writes', async (t) => {
  const item = { username: 'subscriber-a', session_id: '*A1', bytes_in: '10', bytes_out: '20' };
  const cases = [
    ['invalid counter', [{ ...item, bytes_in: '-1' }]],
    ['blank session', [{ ...item, session_id: ' ' }]],
    ['extra field', [{ ...item, is_online: true }]],
    ['duplicate username and session', [item, { ...item, bytes_in: '30' }]],
  ];
  for (const [label, items] of cases) {
    await t.test(label, async () => {
      const { handler, calls } = makeHarness();
      const response = await handler(makeRequest({ body: { counter_scope: 'routeros-session-delta', items } }));
      assert.equal(response.status, 400);
      assert.equal(calls.length, 0);
    });
  }
});

test('empty completed delta poll is an accepted no-op and does not call Supabase', async () => {
  const { handler, calls } = makeHarness();
  const response = await handler(makeRequest({ body: { counter_scope: 'routeros-session-delta', items: [] } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await bodyOf(response), { accepted: 0 });
  assert.equal(calls.length, 0);
});
