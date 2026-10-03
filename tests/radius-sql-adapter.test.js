import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateClosedPeriodUsage,
  createRadacctSqlAdapter,
  createSyncAgentIngestClient,
  mapSubscriberCumulativeToIngestRequest,
  postSubscriberCumulativeSnapshots,
  RadiusAdapterFailure,
} from '../agent/radius-sql-adapter.js';

const JANUARY = Object.freeze({
  periodStart: '2026-01-01T00:00:00Z',
  periodEnd: '2026-02-01T00:00:00Z',
  asOf: '2026-02-01T00:05:00Z',
});
const FEBRUARY = Object.freeze({
  periodStart: '2026-02-01T00:00:00Z',
  periodEnd: '2026-03-01T00:00:00Z',
  asOf: '2026-03-01T00:05:00Z',
});

function radacctRow(overrides = {}) {
  return {
    acctuniqueid: 'unique-1',
    acctsessionid: 'session-1',
    username: 'subscriber-1',
    nasipaddress: '192.0.2.10',
    acctstarttime: '2026-01-31T23:00:00Z',
    acctstoptime: null,
    acctupdatetime: '2026-01-31T23:30:00Z',
    acctinputoctets: '100',
    acctoutputoctets: '200',
    acctinputgigawords: '0',
    acctoutputgigawords: '0',
    ...overrides,
  };
}

function makeAdapter(rows, options = {}) {
  const calls = [];
  const sqlClient = {
    async execute(sql, parameters) {
      calls.push({ sql, parameters });
      return [rows, []];
    },
  };
  return {
    calls,
    adapter: createRadacctSqlAdapter({
      sqlClient,
      sourceId: 'lab-radius-a',
      counterEncoding: 'octets+gigawords',
      ...options,
    }),
  };
}

function periodRow(username, periodStart, periodEnd, inputBytes, outputBytes) {
  return { username, periodStart, periodEnd, inputBytes, outputBytes };
}

test('read-only radacct query binds the half-open interval values and selects only accounting facts', async () => {
  const { adapter, calls } = makeAdapter([]);
  await adapter.readSessionSnapshots(JANUARY);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /^SELECT\n/);
  assert.match(calls[0].sql, /FROM radacct AS r/);
  assert.match(calls[0].sql, /acctstarttime < \?/);
  assert.match(calls[0].sql, /acctstoptime IS NULL OR r\.acctstoptime >= \?/);
  assert.doesNotMatch(calls[0].sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i);
  assert.deepEqual(calls[0].parameters, [
    '2026-02-01T00:00:00.000Z',
    '2026-02-01T00:05:00.000Z',
    '2026-01-01T00:00:00.000Z',
  ]);
  assert.equal(calls[0].sql.includes(JANUARY.periodStart), false);
  assert.equal(calls[0].sql.includes(JANUARY.periodEnd), false);
});

test('normalizes octets plus gigawords with exact integer arithmetic and preserves signed-bigint bounds', async () => {
  const row = radacctRow({
    acctinputoctets: '4000000000',
    acctinputgigawords: '3',
    acctoutputoctets: '7',
    acctoutputgigawords: '2',
  });
  const { adapter } = makeAdapter([row]);
  const [snapshot] = await adapter.readSessionSnapshots(JANUARY);

  assert.equal(snapshot.inputBytes, 3n * 4_294_967_296n + 4_000_000_000n);
  assert.equal(snapshot.outputBytes, 2n * 4_294_967_296n + 7n);
  assert.equal(typeof snapshot.inputBytes, 'bigint');

  const overflow = radacctRow({ acctinputoctets: '0', acctinputgigawords: '2147483648' });
  const overflowingAdapter = makeAdapter([overflow]).adapter;
  await assert.rejects(
    overflowingAdapter.readSessionSnapshots(JANUARY),
    (error) => error instanceof RadiusAdapterFailure && error.kind === 'invalid-counter',
  );
});

test('requires an explicitly verified counter encoding and rejects missing or malformed high words', async (t) => {
  await t.test('no implicit low-word-only fallback', async () => {
    assert.throws(
      () => createRadacctSqlAdapter({
        sqlClient: { execute: async () => [[], []] },
        sourceId: 'lab-radius-a',
      }),
      (error) => error instanceof RadiusAdapterFailure && error.kind === 'unverified-counter-encoding',
    );
  });

  await t.test('missing high-word values fail closed', async () => {
    const { adapter } = makeAdapter([radacctRow({ acctinputgigawords: undefined })]);
    await assert.rejects(
      adapter.readSessionSnapshots(JANUARY),
      (error) => error instanceof RadiusAdapterFailure && error.kind === 'invalid-counter',
    );
  });

  await t.test('expanded 64-bit database counters omit optional gigaword columns', async () => {
    const row = radacctRow({ acctinputoctets: '9007199254740993', acctoutputoctets: '8' });
    delete row.acctinputgigawords;
    delete row.acctoutputgigawords;
    const { adapter, calls } = makeAdapter([row], { counterEncoding: 'expanded-64' });
    const [snapshot] = await adapter.readSessionSnapshots(JANUARY);
    assert.equal(snapshot.inputBytes, 9_007_199_254_740_993n);
    assert.doesNotMatch(calls[0].sql, /gigawords/i);
  });
});

test('de-duplicates repeated interim observations by session and keeps only the latest cumulative value', async () => {
  const { adapter } = makeAdapter([
    radacctRow({ acctupdatetime: '2026-01-31T23:10:00Z', acctinputoctets: '100', acctoutputoctets: '200' }),
    radacctRow({ acctupdatetime: '2026-01-31T23:20:00Z', acctinputoctets: '150', acctoutputoctets: '250' }),
  ]);
  const snapshots = await adapter.readSessionSnapshots(JANUARY);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].inputBytes, 150n);
  assert.equal(snapshots[0].outputBytes, 250n);
});

test('a final Stop observation supersedes its earlier Interim snapshot without summing counters', async () => {
  const { adapter } = makeAdapter([
    radacctRow({ acctupdatetime: '2026-01-31T23:10:00Z', acctinputoctets: '100', acctoutputoctets: '200' }),
    radacctRow({
      acctstoptime: '2026-01-31T23:40:00Z',
      acctupdatetime: '2026-01-31T23:40:00Z',
      acctinputoctets: '175',
      acctoutputoctets: '275',
    }),
  ]);
  const [snapshot] = await adapter.readSessionSnapshots(JANUARY);
  assert.equal(snapshot.stoppedAt, '2026-01-31T23:40:00.000Z');
  assert.equal(snapshot.inputBytes, 175n);
  assert.equal(snapshot.outputBytes, 275n);
});

test('a delayed Interim after a Stop is treated as a reconciliation error', async () => {
  const { adapter } = makeAdapter([
    radacctRow({
      acctstoptime: '2026-01-31T23:30:00Z',
      acctupdatetime: '2026-01-31T23:30:00Z',
      acctinputoctets: '175',
    }),
    radacctRow({ acctupdatetime: '2026-01-31T23:40:00Z', acctinputoctets: '180' }),
  ]);
  await assert.rejects(
    adapter.readSessionSnapshots(JANUARY),
    (error) => error instanceof RadiusAdapterFailure && error.kind === 'interim-after-stop',
  );
});

test('active sessions with acctstoptime NULL remain candidate sessions, not an offline decision', async () => {
  const { adapter } = makeAdapter([radacctRow({ acctstoptime: null })]);
  const [snapshot] = await adapter.readSessionSnapshots(JANUARY);
  assert.equal(snapshot.stoppedAt, null);
  assert.equal(Object.hasOwn(snapshot, 'is_online'), false);
});

test('separate reconnects with the same username remain separate sessions', async () => {
  const { adapter } = makeAdapter([
    radacctRow({ acctuniqueid: 'unique-old', acctsessionid: 'session-old', acctinputoctets: '100' }),
    radacctRow({ acctuniqueid: 'unique-new', acctsessionid: 'session-new', acctinputoctets: '7' }),
  ]);
  const snapshots = await adapter.readSessionSnapshots(JANUARY);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots.map(({ inputBytes }) => inputBytes), [7n, 100n]);
});

test('closed period rows aggregate exactly over [start, end), including values beyond JS safe integers', () => {
  const totals = aggregateClosedPeriodUsage([
    periodRow('subscriber-1', JANUARY.periodStart, '2026-01-15T00:00:00Z', '9007199254740993', '4'),
    periodRow('subscriber-1', '2026-01-15T00:00:00Z', JANUARY.periodEnd, '7', '6'),
    periodRow('subscriber-1', '2025-12-31T00:00:00Z', JANUARY.periodStart, '1000', '1000'),
    periodRow('subscriber-1', JANUARY.periodEnd, '2026-02-02T00:00:00Z', '2000', '2000'),
  ], JANUARY);

  assert.deepEqual(totals, [{
    username: 'subscriber-1',
    periodStart: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-02-01T00:00:00.000Z',
    inputBytes: 9_007_199_254_740_993n + 7n,
    outputBytes: 10n,
    semantics: 'closed-period-aggregate',
  }]);
});

test('period rows that straddle billing boundaries or remain open fail closed', async (t) => {
  await t.test('prior row straddles period start', () => {
    assert.throws(
      () => aggregateClosedPeriodUsage([
        periodRow('subscriber-1', '2025-12-31T23:00:00Z', '2026-01-02T00:00:00Z', '1', '1'),
      ], JANUARY),
      (error) => error instanceof RadiusAdapterFailure && error.kind === 'ambiguous-period-boundary',
    );
  });

  await t.test('row after requested end straddles period end', () => {
    assert.throws(
      () => aggregateClosedPeriodUsage([
        periodRow('subscriber-1', '2026-01-31T23:00:00Z', '2026-02-02T00:00:00Z', '1', '1'),
      ], JANUARY),
      (error) => error instanceof RadiusAdapterFailure && error.kind === 'ambiguous-period-boundary',
    );
  });

  await t.test('open period overlapping request is not counted', () => {
    assert.throws(
      () => aggregateClosedPeriodUsage([{
        username: 'subscriber-1',
        periodStart: '2026-01-20T00:00:00Z',
        periodEnd: null,
        inputBytes: '-5',
        outputBytes: '-5',
      }], JANUARY),
      (error) => error instanceof RadiusAdapterFailure && error.kind === 'open-period-overlaps-request',
    );
  });
});

test('cross-month radacct spillover is visible as one session snapshot, not split into monthly usage', async () => {
  const spillover = radacctRow({
    acctstarttime: '2026-01-31T23:00:00Z',
    acctstoptime: '2026-02-01T01:00:00Z',
    acctupdatetime: '2026-02-01T01:00:00Z',
    acctinputoctets: '1000000000',
    acctoutputoctets: '2000000000',
    acctinputgigawords: '2',
    acctoutputgigawords: '4',
  });
  const january = makeAdapter([spillover]).adapter;
  const february = makeAdapter([spillover]).adapter;
  const [januarySession] = await january.readSessionSnapshots(JANUARY);
  const [februarySession] = await february.readSessionSnapshots(FEBRUARY);
  assert.equal(januarySession.acctUniqueId, februarySession.acctUniqueId);
  assert.equal(januarySession.inputBytes, februarySession.inputBytes);
  assert.equal(januarySession.outputBytes, februarySession.outputBytes);
  assert.throws(
    () => aggregateClosedPeriodUsage([januarySession], JANUARY),
    (error) => error instanceof RadiusAdapterFailure && error.kind === 'invalid-period-record',
  );
});

test('only strict subscriber-cumulative snapshots map to the existing ingest contract', async (t) => {
  const source = {
    counterScope: 'subscriber_cumulative',
    items: [{ username: 'subscriber-approved', bytes_in: 9_007_199_254_740_993n, bytes_out: '14', is_online: true }],
  };
  const request = mapSubscriberCumulativeToIngestRequest(source);
  assert.deepEqual(request, {
    counter_scope: 'subscriber_cumulative',
    items: [{ username: 'subscriber-approved', bytes_in: '9007199254740993', bytes_out: '14', is_online: true }],
  });

  const calls = [];
  const result = await postSubscriberCumulativeSnapshots({
    async postCumulativeSnapshot(payload) {
      calls.push(payload);
      return { accepted: payload.items.length };
    },
  }, source);
  assert.deepEqual(result, { accepted: 1 });
  assert.deepEqual(calls, [request]);

  await t.test('monthly aggregate is rejected, not relabeled', () => {
    assert.throws(
      () => mapSubscriberCumulativeToIngestRequest({
        periodUsage: [{ username: 'subscriber-1', periodStart: JANUARY.periodStart, inputBytes: 10n }],
      }),
      (error) => error instanceof RadiusAdapterFailure && error.kind === 'cumulative-snapshot-required',
    );
  });

  await t.test('strict username mapping rejects whitespace and duplicate usernames', () => {
    assert.throws(
      () => mapSubscriberCumulativeToIngestRequest({
        counterScope: 'subscriber_cumulative',
        items: [{ username: ' subscriber-1', bytes_in: '1', bytes_out: '2', is_online: false }],
      }),
      (error) => error instanceof RadiusAdapterFailure && error.kind === 'invalid-username',
    );
    assert.throws(
      () => mapSubscriberCumulativeToIngestRequest({
        counterScope: 'subscriber_cumulative',
        items: [
          { username: 'subscriber-1', bytes_in: '1', bytes_out: '2', is_online: false },
          { username: 'subscriber-1', bytes_in: '3', bytes_out: '4', is_online: true },
        ],
      }),
      (error) => error instanceof RadiusAdapterFailure && error.kind === 'duplicate-username',
    );
  });
});


test('concrete sync-ingest client sends only the narrow bearer and exact cumulative payload over HTTPS', async () => {
  const token = 'synthetic-narrow-ingest-token-'.padEnd(40, 'x');
  const calls = [];
  const client = createSyncAgentIngestClient({
    ingestUrl: 'https://synthetic-project.supabase.co/functions/v1/sync-agent-ingest',
    bearerToken: token,
    requestTimeoutMs: 2_000,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: 200 });
    },
  });
  const result = await postSubscriberCumulativeSnapshots(client, {
    counterScope: 'subscriber_cumulative',
    items: [{ username: 'subscriber-approved', bytes_in: '10', bytes_out: '20', is_online: false }],
  });

  assert.deepEqual(result, { accepted: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://synthetic-project.supabase.co/functions/v1/sync-agent-ingest');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(Object.hasOwn(calls[0].options.headers, 'apikey'), false);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    counter_scope: 'subscriber_cumulative',
    items: [{ username: 'subscriber-approved', bytes_in: '10', bytes_out: '20', is_online: false }],
  });
});

test('concrete sync-ingest client rejects unsafe endpoint, malformed auth, monthly scope, and HTTP failure', async (t) => {
  const token = 'synthetic-narrow-ingest-token-'.padEnd(40, 'x');
  await t.test('endpoint must be the HTTPS ingest function', () => {
    for (const ingestUrl of [
      'http://synthetic-project.supabase.co/functions/v1/sync-agent-ingest',
      'https://user:pass@synthetic-project.supabase.co/functions/v1/sync-agent-ingest',
      'https://synthetic-project.supabase.co/functions/v1/sync-agent-ingest?debug=1',
      'https://synthetic-project.supabase.co/functions/v1/other',
    ]) {
      assert.throws(() => createSyncAgentIngestClient({ ingestUrl, bearerToken: token }), TypeError);
    }
  });

  await t.test('weak bearer is rejected at construction', () => {
    assert.throws(() => createSyncAgentIngestClient({
      ingestUrl: 'https://synthetic-project.supabase.co/functions/v1/sync-agent-ingest',
      bearerToken: 'short',
    }), TypeError);
  });

  await t.test('non-cumulative scope is rejected before HTTP', async () => {
    let calls = 0;
    const client = createSyncAgentIngestClient({
      ingestUrl: 'https://synthetic-project.supabase.co/functions/v1/sync-agent-ingest',
      bearerToken: token,
      fetchImpl: async () => { calls += 1; return new Response(null, { status: 200 }); },
    });
    await assert.rejects(
      client.postCumulativeSnapshot({ counter_scope: 'monthly_period', items: [] }),
      (error) => error instanceof RadiusAdapterFailure && error.kind === 'cumulative-snapshot-required',
    );
    assert.equal(calls, 0);
  });

  await t.test('HTTP errors stay generic and do not leak response details', async () => {
    const client = createSyncAgentIngestClient({
      ingestUrl: 'https://synthetic-project.supabase.co/functions/v1/sync-agent-ingest',
      bearerToken: token,
      fetchImpl: async () => new Response('synthetic internal credential detail', { status: 503 }),
    });
    await assert.rejects(
      client.postCumulativeSnapshot({ counter_scope: 'subscriber_cumulative', items: [] }),
      (error) => error instanceof RadiusAdapterFailure && error.kind === 'ingest-unavailable',
    );
  });
});
