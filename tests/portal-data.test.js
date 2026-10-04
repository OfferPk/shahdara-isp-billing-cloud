import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCustomer, invokeRpc, isMissingPortalTestAccountColumn, isMissingPppoeUsernameColumn, loadContexts, loadPortalRows, manageServiceIncident, saveCustomerPppoeUsername, saveCustomerPortalTestAccount } from '../src/portal-data.js';

function mockClient(results = {}, rpcResult = { data: null, error: null }) {
  const calls = [];
  return {
    calls,
    from(table) {
      const query = { table, filters: [], selects: [], orders: [], ranges: [] };
      calls.push(query);
      query.updates = [];
      const configuredResult = results[table] ?? { data: [], error: null };
      const result = () => typeof configuredResult === 'function' ? configuredResult(query) : configuredResult;
      const builder = {
        select(columns) { query.selects.push(columns); return builder; },
        update(values) { query.updates.push(values); return builder; },
        eq(column, value) { query.filters.push(['eq', column, value]); return builder; },
        in(column, values) { query.filters.push(['in', column, values]); return builder; },
        order(column, options) { query.orders.push([column, options]); return builder; },
        range(start, end) {
          query.ranges.push([start, end]);
          return Promise.resolve(result());
        },
        maybeSingle() {
          query.single = true;
          const current = result();
          return Promise.resolve({ data: current.data?.[0] ?? null, error: current.error ?? null });
        },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
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

test('only owner and admin memberships receive administrator portal contexts', async () => {
  const client = mockClient({
    organization_memberships: { data: [
      { organization_id: 'synthetic-owner-org', role: 'owner' },
      { organization_id: 'synthetic-admin-org', role: 'admin' },
      { organization_id: 'synthetic-operator-org', role: 'operator' },
    ], error: null },
    organizations: { data: [
      { id: 'synthetic-owner-org', name: 'Synthetic Owner ISP' },
      { id: 'synthetic-admin-org', name: 'Synthetic Admin ISP' },
      { id: 'synthetic-operator-org', name: 'Synthetic Operator ISP' },
    ], error: null },
  });
  const contexts = await loadContexts(client, { id: 'synthetic-user' });

  assert.deepEqual(contexts.map(({ organizationId, role }) => [organizationId, role]), [
    ['synthetic-owner-org', 'owner'],
    ['synthetic-admin-org', 'admin'],
  ]);
  assert.ok(contexts.every(({ role }) => ['owner', 'admin'].includes(role)));
});

test('customer contexts come only from the authenticated safe account-link RPC', async () => {
  const client = mockClient({
    organization_memberships: { data: [], error: null },
    customers: { data: [{ name: 'Synthetic Customer' }], error: null },
  }, { data: [{ organization_id: 'synthetic-org', customer_id: 'synthetic-customer' }], error: null });
  const contexts = await loadContexts(client, { id: 'synthetic-customer-user' });

  assert.deepEqual(contexts, [{
    kind: 'customer', organizationId: 'synthetic-org', customerId: 'synthetic-customer', customerName: 'Synthetic Customer',
  }]);
  assert.deepEqual(client.calls[1], { rpc: 'my_customer_portal_contexts', args: undefined });
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

  assert.deepEqual(Object.keys(rows), ['customers', 'pppoeMappingAvailable', 'bills', 'receipts', 'allocations', 'incidents', 'privateCustomerDetails', 'privateIncidentDetails', 'cashflowExpenses', 'customerServiceCosts', 'branding', 'customerBandwidthUsage', 'customerBandwidthUsageError']);
  assert.equal(rows.pppoeMappingAvailable, true);
  assert.equal(rows.branding, null);
  assert.deepEqual(rows.privateCustomerDetails, []);
  assert.equal(client.calls.some((query) => query.table === 'customer_private_details'), false);
  assert.deepEqual(rows.privateIncidentDetails, []);
  assert.equal(client.calls.some((query) => query.table === 'incident_private_details'), false);
  assert.deepEqual(rows.cashflowExpenses, []);
  assert.deepEqual(rows.customerServiceCosts, []);
  assert.equal(client.calls.some((query) => ['cashflow_expenses', 'customer_service_cost_history'].includes(query.table)), false,
    'customer context never issues an Admin financial query');
  for (const query of client.calls) {
    if (query.table === 'customer_bandwidth_usage') {
      assert.deepEqual(query.filters, [], 'RLS, not a client-supplied identity filter, controls usage rows');
      assert.deepEqual(query.ranges, [[0, 999]]);
      continue;
    }
    assert.ok(query.filters.some((filter) => filter[0] === 'eq' && filter[1] === 'organization_id' && filter[2] === 'synthetic-org'));
    if (query.table !== 'organization_branding') assert.deepEqual(query.ranges, [[0, 999]]);
  }
  const brandingQuery = client.calls.find((query) => query.table === 'organization_branding');
  assert.deepEqual(brandingQuery.selects, ['organization_id, display_name, logo_path, support_phone, address']);
  assert.deepEqual(brandingQuery.ranges, []);
  assert.ok(brandingQuery.single);
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
  assert.deepEqual(profileQuery.selects, ['id, customer_number, name, plan_name, service_address, service_status, monthly_fee_cents, archived, pppoe_username']);
  assert.doesNotMatch(profileQuery.selects.join(' '), /phone|staff_notes|created_by|recorded_by|email/i);
  assert.ok(profileQuery.filters.some((filter) => filter[1] === 'id' && filter[2] === 'synthetic-customer'));
});

test('customer bandwidth usage selects only safe fields and relies on RLS without customer-supplied filters', async () => {
  const fixture = {
    username: 'synthetic-pppoe', total_quota_bytes: '9000', bytes_in: '3000', bytes_out: '1000',
    is_online: true, last_synced_at: '2026-10-03T10:00:00Z',
  };
  const client = mockClient({
    customers: { data: [{ id: 'synthetic-customer', pppoe_username: 'synthetic-pppoe' }], error: null },
    customer_bandwidth_usage: { data: [fixture], error: null },
    bills: { data: [], error: null }, receipts: { data: [], error: null },
    receipt_allocations: { data: [], error: null }, incidents: { data: [], error: null },
  });
  const rows = await loadPortalRows(client, {
    kind: 'customer', organizationId: 'synthetic-org', customerId: 'synthetic-customer',
  });
  const query = client.calls.find((entry) => entry.table === 'customer_bandwidth_usage');

  assert.deepEqual(query.selects, ['username, total_quota_bytes, bytes_in, bytes_out, is_online, last_synced_at']);
  assert.deepEqual(query.filters, [], 'the client does not send a username, customer ID, or organization ID to the usage query');
  assert.deepEqual(rows.customerBandwidthUsage, [fixture]);
  assert.equal(rows.customerBandwidthUsageError, null);
  assert.doesNotMatch(query.selects.join(' '), /last_ip|service_role|secret/i);

  const failedClient = mockClient({
    customers: { data: [{ id: 'synthetic-customer', pppoe_username: 'synthetic-pppoe' }], error: null },
    customer_bandwidth_usage: { data: null, error: new Error('synthetic RLS/table denial') },
    bills: { data: [], error: null }, receipts: { data: [], error: null },
    receipt_allocations: { data: [], error: null }, incidents: { data: [], error: null },
  });
  const failedRows = await loadPortalRows(failedClient, {
    kind: 'customer', organizationId: 'synthetic-org', customerId: 'synthetic-customer',
  });
  assert.deepEqual(failedRows.customerBandwidthUsage, []);
  assert.match(failedRows.customerBandwidthUsageError.message, /synthetic RLS\/table denial/);
  assert.equal(failedRows.customers.length, 1, 'a usage-only query error does not hide the rest of the customer portal');
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
  assert.equal(client.calls.some((query) => query.table === 'cashflow_expenses'), false);
  assert.equal(client.calls.some((query) => query.table === 'customer_service_cost_history'), false);
});

test('Admin phone and service-start query selects only the private profile fields and is scoped to the Admin organization', async () => {
  const client = mockClient({
    customers: { data: [], error: null },
    bills: { data: [], error: null },
    receipts: { data: [], error: null },
    receipt_allocations: { data: [], error: null },
    incidents: { data: [], error: null },
    customer_private_details: { data: [{ customer_id: 'synthetic-customer', phone: '03001234567', connection_date: '2025-10-15' }], error: null },
    incident_private_details: { data: [{ incident_id: 'synthetic-incident', staff_notes: 'Synthetic Admin-only note' }], error: null },
  });
  const rows = await loadPortalRows(client, { kind: 'admin', organizationId: 'synthetic-org' });

  const query = client.calls.find((entry) => entry.table === 'customer_private_details');
  assert.deepEqual(query.selects, ['customer_id, phone, connection_date']);
  assert.ok(query.filters.some(([kind, field, value]) => kind === 'eq' && field === 'organization_id' && value === 'synthetic-org'));
  assert.deepEqual(rows.privateCustomerDetails, [{ customer_id: 'synthetic-customer', phone: '03001234567', connection_date: '2025-10-15' }]);
  const incidentNotesQuery = client.calls.find((entry) => entry.table === 'incident_private_details');
  assert.deepEqual(incidentNotesQuery.selects, ['incident_id, staff_notes']);
  assert.ok(incidentNotesQuery.filters.some(([kind, field, value]) => kind === 'eq' && field === 'organization_id' && value === 'synthetic-org'));
  assert.deepEqual(rows.privateIncidentDetails, [{ incident_id: 'synthetic-incident', staff_notes: 'Synthetic Admin-only note' }]);
  const billQuery = client.calls.find((entry) => entry.table === 'bills');
  assert.deepEqual(billQuery.selects, ['id, customer_id, period, amount_due_cents, issued_on, due_date, plan_snapshot, created_at']);
  assert.ok(billQuery.filters.some(([kind, field, value]) => kind === 'eq' && field === 'organization_id' && value === 'synthetic-org'));
});

test('Admin customer query selects the test marker but customer query never requests it', async () => {
  const admin = mockClient({ customers: { data: [{ id: 'synthetic-customer', portal_test_account: true }], error: null } });
  await loadPortalRows(admin, { kind: 'admin', organizationId: 'synthetic-org' });
  const adminQuery = admin.calls.find((query) => query.table === 'customers');
  assert.match(adminQuery.selects[0], /pppoe_username, portal_test_account$/);

  const customer = mockClient({ customers: { data: [{ id: 'synthetic-customer', pppoe_username: 'synthetic-pppoe' }], error: null } });
  await loadPortalRows(customer, { kind: 'customer', organizationId: 'synthetic-org', customerId: 'synthetic-customer' });
  const customerQuery = customer.calls.find((query) => query.table === 'customers');
  assert.doesNotMatch(customerQuery.selects[0], /portal_test_account/);
});

test('Admin query falls back safely when the staging marker migration is not yet applied', async () => {
  const client = mockClient({
    customers: (query) => query.selects.at(-1).includes('portal_test_account')
      ? { data: null, error: { code: 'PGRST204', message: "Could not find the 'portal_test_account' column of 'customers' in the schema cache" } }
      : { data: [{ id: 'synthetic-customer', pppoe_username: 'synthetic-pppoe' }], error: null },
  });
  const rows = await loadPortalRows(client, { kind: 'admin', organizationId: 'synthetic-org' });
  const customerQueries = client.calls.filter((query) => query.table === 'customers');
  assert.equal(customerQueries.length, 2);
  assert.match(customerQueries[0].selects[0], /portal_test_account/);
  assert.doesNotMatch(customerQueries[1].selects[0], /portal_test_account/);
  assert.equal(rows.customers[0].portal_test_account, false);
  assert.equal(rows.customers[0].pppoe_username, 'synthetic-pppoe');
});

test('collection and cashflow monitoring use only approved organization-scoped financial fields', async () => {
  const client = mockClient({
    customers: { data: [], error: null },
    bills: { data: [], error: null },
    receipts: { data: [], error: null },
    receipt_allocations: { data: [], error: null },
    incidents: { data: [], error: null },
  });
  await loadPortalRows(client, { kind: 'admin', organizationId: 'synthetic-org' });

  const expectedColumns = {
    customers: 'id, customer_number, name, plan_name, service_address, service_status, monthly_fee_cents, archived, created_at, pppoe_username, portal_test_account',
    bills: 'id, customer_id, period, amount_due_cents, issued_on, due_date, plan_snapshot, created_at',
    receipts: 'organization_id, id, customer_id, origin_bill_id, received_on, amount_cents, method, created_at',
    receipt_allocations: 'receipt_id, bill_id, customer_id, amount_cents, allocation_kind',
    cashflow_expenses: 'organization_id, id, category, amount_paisa, note, created_at',
    customer_service_cost_history: 'organization_id, customer_id, id, effective_on, monthly_cost_paisa, note, created_at',
  };
  const dashboardQueries = Object.entries(expectedColumns).map(([table, columns]) => {
    const query = client.calls.find((entry) => entry.table === table);
    assert.deepEqual(query.selects, [columns], `${table} metric input columns`);
    assert.ok(query.filters.some(([kind, field, value]) => kind === 'eq' && field === 'organization_id' && value === 'synthetic-org'));
    return query;
  });

  assert.doesNotMatch(dashboardQueries.flatMap((query) => query.selects).join(' '), /phone|staff_notes|portal_email|user_id|private_details|created_by|recorded_by/i);
  const metricSources = await Promise.all([
    readFile(new URL('../src/ledger.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/dashboard-metrics.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(metricSources.join('\n'), /phone|staff_notes|customer_private_details|incident_private_details|portal_email|user_id/i);
});

test('collection drill-down reuses current RLS-scoped rows and adds no query or client field access', async () => {
  const client = mockClient({
    customers: { data: [], error: null },
    bills: { data: [], error: null },
    receipts: { data: [], error: null },
    receipt_allocations: { data: [], error: null },
    incidents: { data: [], error: null },
    customer_private_details: { data: [], error: null },
    incident_private_details: { data: [], error: null },
  });
  await loadPortalRows(client, { kind: 'admin', organizationId: 'synthetic-org' });
  const expectedTables = [
    'customers', 'bills', 'receipts', 'receipt_allocations', 'incidents',
    'customer_private_details', 'incident_private_details', 'cashflow_expenses',
    'customer_service_cost_history', 'organization_branding',
  ].sort();
  assert.deepEqual(client.calls.map((query) => query.table).sort(), expectedTables);
  for (const query of client.calls) {
    assert.ok(query.filters.some(([kind, field, value]) => kind === 'eq' && field === 'organization_id' && value === 'synthetic-org'));
  }
  assert.deepEqual(client.calls.find((query) => query.table === 'bills').selects, ['id, customer_id, period, amount_due_cents, issued_on, due_date, plan_snapshot, created_at']);
  assert.deepEqual(client.calls.find((query) => query.table === 'organization_branding').selects, ['organization_id, display_name, logo_path, support_phone, address']);

  const [main, routes] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/dashboard-drilldown.js', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /filterCollectionBillRows\(allBillRows/);
  assert.match(main, /filterCustomersWithoutBillSnapshot\(listRows, pageState\.rows\?\.bills/);
  assert.match(main, /context\.organizationId !== pageState\.context\?\.organizationId/);
  assert.doesNotMatch(routes, /supabase|\.from\(|\.rpc\(|fetch\(/i);
  assert.doesNotMatch(routes, /phone|staff_notes|private_details|portal_email/i);
});

test('portal data loading throws at the paging cap rather than exposing partial rows', async () => {
  const fullPage = Array.from({ length: 1000 }, (_, index) => ({ id: `synthetic-bill-${index}` }));
  const client = mockClient({
    customers: { data: [], error: null },
    bills: { data: fullPage, error: null },
    receipts: { data: [], error: null },
    receipt_allocations: { data: [], error: null },
    incidents: { data: [], error: null },
  });

  await assert.rejects(loadPortalRows(client, { kind: 'admin', organizationId: 'synthetic-org' }), /safe paging limit/);
  assert.equal(client.calls.filter((query) => query.table === 'bills').length, 50);
});

test('incident management uses its dedicated RPC with public and private fields kept distinct', async () => {
  const client = mockClient({}, { data: 'synthetic-incident-id', error: null });
  const result = await manageServiceIncident(client, {
    organizationId: 'synthetic-org',
    incidentId: null,
    customerId: 'synthetic-customer',
    customerVisibleSummary: 'Synthetic public service update',
    status: 'open',
    offlineAt: null,
    restoredAt: null,
    staffNotes: 'Synthetic private note',
  });

  assert.equal(result, 'synthetic-incident-id');
  assert.deepEqual(client.calls, [{
    rpc: 'manage_service_incident',
    args: {
      p_organization_id: 'synthetic-org',
      p_incident_id: null,
      p_customer_id: 'synthetic-customer',
      p_customer_visible_summary: 'Synthetic public service update',
      p_status: 'open',
      p_offline_at: null,
      p_restored_at: null,
      p_staff_notes: 'Synthetic private note',
    },
  }]);
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

test('missing PPPoE schema falls back to customer records without breaking portal loading', async () => {
  const client = mockClient({
    customers: (query) => query.selects.at(-1).includes('pppoe_username')
      ? { data: null, error: { code: 'PGRST204', message: "Could not find the 'pppoe_username' column of 'customers' in the schema cache" } }
      : { data: [{ id: 'synthetic-customer', name: 'Synthetic Customer' }], error: null },
    bills: { data: [], error: null }, receipts: { data: [], error: null },
    receipt_allocations: { data: [], error: null }, incidents: { data: [], error: null },
  });
  const rows = await loadPortalRows(client, { kind: 'admin', organizationId: 'synthetic-org' });
  assert.equal(rows.pppoeMappingAvailable, false);
  assert.deepEqual(rows.customers, [{ id: 'synthetic-customer', name: 'Synthetic Customer', pppoe_username: null, portal_test_account: false }]);
  const customerQueries = client.calls.filter((query) => query.table === 'customers');
  assert.equal(customerQueries.length, 2);
  assert.match(customerQueries[0].selects[0], /pppoe_username/);
  assert.doesNotMatch(customerQueries[1].selects[0], /pppoe_username/);
  assert.ok(customerQueries.every((query) => query.filters.some(([kind, field, value]) => kind === 'eq' && field === 'organization_id' && value === 'synthetic-org')));
});

test('PPPoE mapping writes only the existing customer username and scopes by organization and customer', async () => {
  const client = mockClient({ customers: { data: [{ id: 'synthetic-customer', pppoe_username: 'azeembajwa1' }], error: null } });
  const result = await saveCustomerPppoeUsername(client, {
    organizationId: 'synthetic-org', customerId: 'synthetic-customer', username: '  azeembajwa1  ',
  });
  assert.deepEqual(result, { id: 'synthetic-customer', pppoe_username: 'azeembajwa1' });
  const query = client.calls.find((entry) => entry.table === 'customers');
  assert.deepEqual(query.updates, [{ pppoe_username: 'azeembajwa1' }]);
  assert.deepEqual(query.filters, [
    ['eq', 'organization_id', 'synthetic-org'],
    ['eq', 'id', 'synthetic-customer'],
  ]);
  assert.deepEqual(query.selects, ['id, pppoe_username']);
  assert.equal(client.calls.some((entry) => entry.rpc), false);
});

test('test marker writes are exact-staging-only and remain organization/customer scoped', async () => {
  const client = mockClient({ customers: { data: [{ id: 'synthetic-customer', portal_test_account: true }], error: null } });
  client.supabaseUrl = 'https://qkdsuvmlutkatcqoewkh.supabase.co';
  const result = await saveCustomerPortalTestAccount(client, {
    organizationId: 'synthetic-org', customerId: 'synthetic-customer', enabled: true,
  });
  assert.deepEqual(result, { id: 'synthetic-customer', portal_test_account: true });
  const query = client.calls.find((entry) => entry.table === 'customers');
  assert.deepEqual(query.updates, [{ portal_test_account: true }]);
  assert.deepEqual(query.filters, [
    ['eq', 'organization_id', 'synthetic-org'],
    ['eq', 'id', 'synthetic-customer'],
  ]);
  assert.deepEqual(query.selects, ['id, portal_test_account']);

  const production = mockClient();
  production.supabaseUrl = 'https://pocvrbwcfvtsupgdlouv.supabase.co';
  await assert.rejects(saveCustomerPortalTestAccount(production, {
    organizationId: 'synthetic-org', customerId: 'synthetic-customer', enabled: true,
  }), /unavailable for this project/);
  assert.equal(production.calls.length, 0);
});

test('PPPoE clearing is explicit, and an unconfirmed update is never treated as success', async () => {
  const clearedClient = mockClient({ customers: { data: [{ id: 'synthetic-customer', pppoe_username: null }], error: null } });
  await saveCustomerPppoeUsername(clearedClient, {
    organizationId: 'synthetic-org', customerId: 'synthetic-customer', username: null,
  });
  assert.deepEqual(clearedClient.calls.find((entry) => entry.table === 'customers').updates, [{ pppoe_username: null }]);

  const absentClient = mockClient({ customers: { data: [], error: null } });
  await assert.rejects(saveCustomerPppoeUsername(absentClient, {
    organizationId: 'synthetic-org', customerId: 'synthetic-customer', username: 'azeembajwa1',
  }), /could not be confirmed/i);
  assert.equal(isMissingPppoeUsernameColumn({ code: 'PGRST204', message: "Could not find 'pppoe_username' column" }), true);
  assert.equal(isMissingPppoeUsernameColumn({ code: '42501', message: 'permission denied' }), false);
  assert.equal(isMissingPortalTestAccountColumn({ code: 'PGRST204', message: "Could not find 'portal_test_account' column" }), true);
  assert.equal(isMissingPortalTestAccountColumn({ code: '42501', message: 'permission denied' }), false);
});
test('Admin financial reads select exact rows and remain filtered to the selected organization', async () => {
  const client = mockClient({
    customers: { data: [{ id: 'synthetic-customer', created_at: '2020-01-01T00:00:00.000Z' }], error: null },
    cashflow_expenses: { data: [{ organization_id: 'synthetic-org', id: 'expense', category: 'bill', amount_paisa: 200, note: '', created_at: '2026-10-04T12:00:00Z' }], error: null },
    customer_service_cost_history: { data: [{ organization_id: 'synthetic-org', customer_id: 'synthetic-customer', id: 'cost', effective_on: '2026-10-01', monthly_cost_paisa: 150000, note: '', created_at: '2026-10-01T12:00:00Z' }], error: null },
  });
  const rows = await loadPortalRows(client, { kind: 'admin', organizationId: 'synthetic-org', role: 'admin' });

  const expenseQuery = client.calls.find((query) => query.table === 'cashflow_expenses');
  const costQuery = client.calls.find((query) => query.table === 'customer_service_cost_history');
  assert.deepEqual(expenseQuery.selects, ['organization_id, id, category, amount_paisa, note, created_at']);
  assert.deepEqual(costQuery.selects, ['organization_id, customer_id, id, effective_on, monthly_cost_paisa, note, created_at']);
  for (const query of [expenseQuery, costQuery]) {
    assert.ok(query.filters.some(([kind, field, value]) => kind === 'eq' && field === 'organization_id' && value === 'synthetic-org'));
    assert.deepEqual(query.ranges, [[0, 999]]);
    assert.doesNotMatch(query.selects.join(' '), /created_by|user_id|email|private/i);
  }
  assert.equal(rows.cashflowExpenses.length, 1);
  assert.equal(rows.customerServiceCosts.length, 1);
});
