import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeRpc, loadContexts, loadPortalRows } from '../src/portal-data.js';

function mockClient(results = {}, rpcResult = { data: null, error: null }) {
  const calls = [];
  return {
    calls,
    from(table) {
      const query = { table, filters: [], selects: [], orders: [], ranges: [] };
      calls.push(query);
      const result = results[table] ?? { data: [], error: null };
      const builder = {
        select(columns) { query.selects.push(columns); return builder; },
        eq(column, value) { query.filters.push(['eq', column, value]); return builder; },
        in(column, values) { query.filters.push(['in', column, values]); return builder; },
        order(column, options) { query.orders.push([column, options]); return builder; },
        range(start, end) {
          query.ranges.push([start, end]);
          return Promise.resolve(result);
        },
        maybeSingle() {
          query.single = true;
          return Promise.resolve({ data: result.data?.[0] ?? null, error: result.error ?? null });
        },
        then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
      };
      return builder;
    },
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      return rpcResult;
    },
  };
}

test('admin contexts are selected from the signed-in user membership and organization', async () => {
  const client = mockClient({
    organization_memberships: { data: [{ organization_id: 'synthetic-org', role: 'owner' }], error: null },
    organizations: { data: [{ id: 'synthetic-org', name: 'Synthetic ISP' }], error: null },
  });
  const contexts = await loadContexts(client, { id: 'synthetic-user' });

  assert.deepEqual(contexts, [{
    kind: 'admin', organizationId: 'synthetic-org', organizationName: 'Synthetic ISP', role: 'owner',
  }]);
  assert.deepEqual(client.calls[0].filters, [['eq', 'user_id', 'synthetic-user']]);
  assert.deepEqual(client.calls[1].filters, [['in', 'id', ['synthetic-org']]]);
});

test('customer context reads are tied to the authenticated account link', async () => {
  const client = mockClient({
    organization_memberships: { data: [], error: null },
    customer_portal_accounts: { data: [{ organization_id: 'synthetic-org', customer_id: 'synthetic-customer' }], error: null },
    customers: { data: [{ name: 'Synthetic Customer' }], error: null },
  });
  const contexts = await loadContexts(client, { id: 'synthetic-customer-user' });

  assert.deepEqual(contexts, [{
    kind: 'customer', organizationId: 'synthetic-org', customerId: 'synthetic-customer', customerName: 'Synthetic Customer',
  }]);
  assert.deepEqual(client.calls[2].filters, [
    ['eq', 'organization_id', 'synthetic-org'],
    ['eq', 'id', 'synthetic-customer'],
  ]);
});

test('portal row reads scope customer data and preserve safe paging', async () => {
  const client = mockClient({
    customers: { data: [{ id: 'synthetic-customer' }], error: null },
    bills: { data: [], error: null },
    receipts: { data: [], error: null },
    receipt_allocations: { data: [], error: null },
    incidents: { data: [], error: null },
  });
  const rows = await loadPortalRows(client, {
    kind: 'customer', organizationId: 'synthetic-org', customerId: 'synthetic-customer',
  });

  assert.deepEqual(Object.keys(rows), ['customers', 'bills', 'receipts', 'allocations', 'incidents']);
  for (const query of client.calls) {
    assert.ok(query.filters.some((filter) => filter[0] === 'eq' && filter[1] === 'organization_id' && filter[2] === 'synthetic-org'));
    assert.deepEqual(query.ranges, [[0, 999]]);
  }
  assert.ok(client.calls.find((query) => query.table === 'bills').filters.some((filter) => filter[1] === 'customer_id' && filter[2] === 'synthetic-customer'));
});

test('query and receipt RPC errors are propagated to the UI', async () => {
  const queryError = new Error('synthetic RLS denial');
  const readClient = mockClient({ organization_memberships: { data: null, error: queryError } });
  await assert.rejects(loadContexts(readClient, { id: 'synthetic-user' }), (error) => error === queryError);

  const rpcError = new Error('synthetic receipt RPC rejection');
  const rpcClient = mockClient({}, { data: null, error: rpcError });
  await assert.rejects(invokeRpc(rpcClient, 'record_cash_receipt', {
    p_organization_id: 'synthetic-org',
    p_receipt_id: 'synthetic-stable-receipt-id',
  }), (error) => error === rpcError);
  assert.deepEqual(rpcClient.calls[0], {
    rpc: 'record_cash_receipt',
    args: { p_organization_id: 'synthetic-org', p_receipt_id: 'synthetic-stable-receipt-id' },
  });
});
