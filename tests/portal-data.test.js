import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomer, invokeRpc, loadContexts, loadPortalRows } from '../src/portal-data.js';

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

  assert.deepEqual(Object.keys(rows), ['customers', 'bills', 'receipts', 'allocations', 'incidents', 'privateCustomerDetails']);
  assert.deepEqual(rows.privateCustomerDetails, []);
  assert.equal(client.calls.some((query) => query.table === 'customer_private_details'), false);
  for (const query of client.calls) {
    assert.ok(query.filters.some((filter) => filter[0] === 'eq' && filter[1] === 'organization_id' && filter[2] === 'synthetic-org'));
    assert.deepEqual(query.ranges, [[0, 999]]);
  }
  assert.ok(client.calls.find((query) => query.table === 'bills').filters.some((filter) => filter[1] === 'customer_id' && filter[2] === 'synthetic-customer'));
});

test('customer profile query selects only approved public profile fields', async () => {
  const client = mockClient({
    customers: { data: [{ id: 'synthetic-customer' }], error: null },
    bills: { data: [], error: null },
    receipts: { data: [], error: null },
    receipt_allocations: { data: [], error: null },
    incidents: { data: [], error: null },
  });
  await loadPortalRows(client, {
    kind: 'customer', organizationId: 'synthetic-org', customerId: 'synthetic-customer',
  });

  const profileQuery = client.calls.find((query) => query.table === 'customers');
  assert.deepEqual(profileQuery.selects, ['id, customer_number, name, plan_name, service_address, service_status, monthly_fee_cents, archived']);
  assert.doesNotMatch(profileQuery.selects.join(' '), /phone|staff_notes|created_by|recorded_by|email/i);
  assert.ok(profileQuery.filters.some((filter) => filter[1] === 'id' && filter[2] === 'synthetic-customer'));
});

test('customer billing and incident reads are limited to approved fields and the linked account', async () => {
  const client = mockClient({
    customers: { data: [], error: null },
    bills: { data: [], error: null },
    receipts: { data: [], error: null },
    receipt_allocations: { data: [], error: null },
    incidents: { data: [], error: null },
  });
  await loadPortalRows(client, {
    kind: 'customer', organizationId: 'synthetic-org', customerId: 'synthetic-customer',
  });
  const expectedColumns = {
    bills: 'id, customer_id, period, amount_due_cents, plan_snapshot',
    receipts: 'id, customer_id, origin_bill_id, received_on, amount_cents, method',
    receipt_allocations: 'receipt_id, bill_id, customer_id, amount_cents, allocation_kind',
    incidents: 'id, customer_id, customer_visible_summary, status, reported_at, offline_at, restored_at',
  };

  for (const [table, columns] of Object.entries(expectedColumns)) {
    const query = client.calls.find((entry) => entry.table === table);
    assert.deepEqual(query.selects, [columns], `${table} selected columns`);
    assert.ok(query.filters.some(([kind, field, value]) => kind === 'eq' && field === 'organization_id' && value === 'synthetic-org'));
    assert.ok(query.filters.some(([kind, field, value]) => kind === 'eq' && field === 'customer_id' && value === 'synthetic-customer'));
    assert.doesNotMatch(query.selects.join(' '), /phone|staff_notes|created_by|recorded_by|creator|email/i);
  }
  assert.equal(client.calls.some((query) => query.table === 'incident_private_details'), false);
});

test('Admin phone query uses only the private phone column and is scoped to the Admin organization', async () => {
  const client = mockClient({
    customers: { data: [], error: null },
    bills: { data: [], error: null },
    receipts: { data: [], error: null },
    receipt_allocations: { data: [], error: null },
    incidents: { data: [], error: null },
    customer_private_details: { data: [{ customer_id: 'synthetic-customer', phone: '03001234567' }], error: null },
  });
  const rows = await loadPortalRows(client, { kind: 'admin', organizationId: 'synthetic-org' });

  const query = client.calls.find((entry) => entry.table === 'customer_private_details');
  assert.deepEqual(query.selects, ['customer_id, phone']);
  assert.ok(query.filters.some(([kind, field, value]) => kind === 'eq' && field === 'organization_id' && value === 'synthetic-org'));
  assert.deepEqual(rows.privateCustomerDetails, [{ customer_id: 'synthetic-customer', phone: '03001234567' }]);
  const billQuery = client.calls.find((entry) => entry.table === 'bills');
  assert.deepEqual(billQuery.selects, ['id, customer_id, period, amount_due_cents, issued_on, due_date, plan_snapshot']);
  assert.ok(billQuery.filters.some(([kind, field, value]) => kind === 'eq' && field === 'organization_id' && value === 'synthetic-org'));
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

test('customer creation sends the private phone as text through a single RPC', async () => {
  const client = mockClient({}, { data: 'synthetic-customer-id', error: null });
  const customer = {
    organizationId: 'synthetic-org',
    customerNumber: 27,
    name: 'Synthetic Customer',
    planName: 'Synthetic Plan',
    monthlyFeeCents: 12500,
    serviceAddress: 'Synthetic address',
    serviceStatus: 'active',
    phone: '03001234567',
  };

  assert.equal(await createCustomer(client, customer), 'synthetic-customer-id');
  assert.deepEqual(client.calls, [{
    rpc: 'create_customer',
    args: {
      p_organization_id: 'synthetic-org',
      p_customer_number: 27,
      p_name: 'Synthetic Customer',
      p_plan_name: 'Synthetic Plan',
      p_monthly_fee_cents: 12500,
      p_service_address: 'Synthetic address',
      p_service_status: 'active',
      p_phone: '03001234567',
    },
  }]);
});
