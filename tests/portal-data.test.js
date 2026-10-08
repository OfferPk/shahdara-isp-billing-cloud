import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCustomer, invokeRpc, isMissingPortalTestAccountColumn, isMissingPppoeUsernameColumn, loadContexts, loadPortalRows, loadPortalSessionContexts, manageServiceIncident, saveCustomerPppoeUsername, saveCustomerPortalTestAccount } from '../src/portal-data.js';

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
      return typeof rpcResult === 'function' ? rpcResult(name, args) : rpcResult;
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

test('owner/admin session contexts load without calling the customer password-state RPC', async () => {
  const client = mockClient({
    organization_memberships: { data: [{ organization_id: 'synthetic-org', role: 'owner' }], error: null },
    organizations: { data: [{ id: 'synthetic-org', name: 'Synthetic ISP' }], error: null },
  }, { data: null, error: { code: 'PGRST202', message: 'function not found' } });

  const result = await loadPortalSessionContexts(client, { id: 'synthetic-user' });

  assert.deepEqual(result, {
    contexts: [{ kind: 'admin', organizationId: 'synthetic-org', organizationName: 'Synthetic ISP', role: 'owner' }],
    passwordState: null,
  });
  assert.deepEqual(client.calls.map((call) => call.table ?? call.rpc), ['organization_memberships', 'organizations']);
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

test('customer Auth users never receive contexts from legacy password-state or account-link RPCs', async () => {
  const client = mockClient({ organization_memberships: { data: [], error: null } });
  const result = await loadPortalSessionContexts(client, { id: 'synthetic-customer-user' });
  assert.deepEqual(result, { contexts: [], passwordState: null });
  assert.deepEqual(client.calls.map((call) => call.table ?? call.rpc), ['organization_memberships']);
  assert.equal(client.calls.some((call) => call.rpc === 'my_customer_portal_contexts'), false);
  assert.equal(client.calls.some((call) => call.rpc === 'my_customer_portal_password_state'), false);
});

test('customer row reads fail closed before querying Supabase and must use the opaque-session BFF', async () => {
  const client = mockClient();
  await assert.rejects(loadPortalRows(client, {
    kind: 'customer', organizationId: 'synthetic-org', customerId: 'synthetic-customer',
  }), /opaque-session BFF/);
  assert.equal(client.calls.length, 0);
});

test('admin portal row reads remain organization-scoped and preserve bounded paging', async () => {
  const client = mockClient({ customers: { data: [{ id: 'synthetic-customer' }], error: null } });
  const rows = await loadPortalRows(client, { kind: 'admin', organizationId: 'synthetic-org' });
  assert.equal(rows.customers.length, 1);
  const customerQuery = client.calls.find((call) => call.table === 'customers');
  assert.ok(customerQuery.filters.some((filter) => filter[1] === 'organization_id' && filter[2] === 'synthetic-org'));
  assert.deepEqual(customerQuery.ranges, [[0, 999]]);
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
  assert.deepEqual(billQuery.selects, ['id, invoice_number, customer_id, period, amount_due_cents, issued_on, due_date, plan_snapshot, created_at']);
  assert.ok(billQuery.filters.some(([kind, field, value]) => kind === 'eq' && field === 'organization_id' && value === 'synthetic-org'));
});

test('Admin package catalog falls back safely when the dual-mode quota migration is not applied', async () => {
  const client = mockClient({
    service_packages: (query) => query.selects.at(-1).includes('quota_type')
      ? { data: null, error: { code: 'PGRST204', message: "Could not find the 'quota_type' column of 'service_packages' in the schema cache" } }
      : { data: [{ id: 'pkg-legacy', name: 'Legacy Plan', monthly_fee_cents: 100000, effective_on: '2026-10-01', updated_at: '2026-10-01T00:00:00Z' }], error: null },
  });
  const rows = await loadPortalRows(client, { kind: 'admin', organizationId: 'synthetic-org' });
  assert.equal(rows.packageQuotaMetadataAvailable, false);
  assert.deepEqual(rows.packages[0], {
    id: 'pkg-legacy', name: 'Legacy Plan', monthly_fee_cents: 100000,
    effective_on: '2026-10-01', updated_at: '2026-10-01T00:00:00Z',
    quota_type: 'unlimited', quota_limit_gb: null, action_on_exhaust: 'notify',
  });
  assert.equal(client.calls.filter((query) => query.table === 'service_packages').length, 2);
});

test('Admin customer query retains its marker while customer reads remain BFF-only', async () => {
  const admin = mockClient({ customers: { data: [{ id: 'synthetic-customer', portal_test_account: true }], error: null } });
  await loadPortalRows(admin, { kind: 'admin', organizationId: 'synthetic-org' });
  const adminQuery = admin.calls.find((query) => query.table === 'customers');
  assert.match(adminQuery.selects[0], /portal_test_account/);
  const customer = mockClient();
  await assert.rejects(loadPortalRows(customer, { kind: 'customer', organizationId: 'synthetic-org', customerId: 'synthetic-customer' }), /opaque-session BFF/);
  assert.equal(customer.calls.length, 0);
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
    bills: 'id, invoice_number, customer_id, period, amount_due_cents, issued_on, due_date, plan_snapshot, created_at',
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
    'customer_service_cost_history', 'organization_branding', 'service_packages',
  ].sort();
  assert.deepEqual(client.calls.map((query) => query.table).sort(), expectedTables);
  for (const query of client.calls) {
    assert.ok(query.filters.some(([kind, field, value]) => kind === 'eq' && field === 'organization_id' && value === 'synthetic-org'));
  }
  assert.deepEqual(client.calls.find((query) => query.table === 'bills').selects, ['id, invoice_number, customer_id, period, amount_due_cents, issued_on, due_date, plan_snapshot, created_at']);
  assert.deepEqual(client.calls.find((query) => query.table === 'organization_branding').selects, ['organization_id, display_name, logo_path, support_phone, address']);
  assert.deepEqual(client.calls.find((query) => query.table === 'service_packages').selects, [
    'id, name, monthly_fee_cents, effective_on, updated_at, quota_type, quota_limit_gb, action_on_exhaust',
  ]);

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
test('owner dashboard tolerates only the three optional tables missing from production schema', async () => {
  const optionalTables = ['cashflow_expenses', 'customer_service_cost_history', 'organization_branding'];
  const missingTables = Object.fromEntries(optionalTables.map((table) => [table, {
    data: null,
    error: {
      code: 'PGRST205',
      message: `Could not find the table 'public.${table}' in the schema cache`,
    },
  }]));
  const client = mockClient(missingTables);

  const rows = await loadPortalRows(client, { kind: 'admin', organizationId: 'synthetic-org', role: 'owner' });

  assert.deepEqual(rows.cashflowExpenses, []);
  assert.deepEqual(rows.customerServiceCosts, []);
  assert.equal(rows.branding, null);
  assert.deepEqual(rows.customers, []);
  assert.deepEqual(rows.bills, []);
  assert.deepEqual(rows.receipts, []);
  assert.deepEqual(rows.incidents, []);
});

test('optional portal-table fallbacks preserve permission errors and mismatched missing-table errors', async () => {
  const optionalTables = ['cashflow_expenses', 'customer_service_cost_history', 'organization_branding'];
  for (const table of optionalTables) {
    const permissionError = { code: '42501', message: `permission denied for table ${table}` };
    const permissionClient = mockClient({ [table]: { data: null, error: permissionError } });
    await assert.rejects(
      loadPortalRows(permissionClient, { kind: 'admin', organizationId: 'synthetic-org', role: 'owner' }),
      (error) => error === permissionError,
      `${table} authorization failures must remain visible`,
    );
  }

  const unrelatedTableError = {
    code: 'PGRST205',
    message: "Could not find the table 'public.customer_service_cost_history' in the schema cache",
  };
  const mismatchedClient = mockClient({
    cashflow_expenses: { data: null, error: unrelatedTableError },
  });
  await assert.rejects(
    loadPortalRows(mismatchedClient, { kind: 'admin', organizationId: 'synthetic-org', role: 'owner' }),
    (error) => error === unrelatedTableError,
    'a missing different table must not be mistaken for a missing cashflow table',
  );
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
