import test from 'node:test';
import assert from 'node:assert/strict';
import { createPppoeApiHandler } from '../src/server/pppoe-api.js';
import {
  parseSubscriberComment,
  renderSubscriberImportContent,
  setSelectedSubscriberUsernames,
} from '../src/admin-subscriber-import.js';

const organizationId = '10000000-0000-4000-8000-000000000001';
const env = { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'public-anon-key' };
const routerSubscribers = [
  { username: 'new-user', profile: '15M', ipAddress: '10.10.20.190', comment: 'Jane Doe - 03001234567 - Shahdara - Block 2' },
  { username: 'known-user', profile: '10M', ipAddress: '10.10.20.191', comment: 'Known Customer - +923001234568 - Lahore Road' },
];

function createClientFactory({ role = 'admin', customers = [], missingMapping = false } = {}) {
  const database = {
    customers: structuredClone(customers),
    packages: [],
    rpcCalls: [],
  };
  let nextId = 1;
  const client = {
    auth: {
      async getUser(token) {
        return token === 'valid-token'
          ? { data: { user: { id: 'admin-user' } }, error: null }
          : { data: { user: null }, error: new Error('invalid token') };
      },
    },
    from(table) {
      const builder = { table, filters: {}, updateValues: null };
      builder.select = function select(columns) { this.columns = columns; return this; };
      builder.eq = function eq(column, value) { this.filters[column] = value; return this; };
      builder.range = async function range(start, end) {
        if (missingMapping && this.columns.includes('pppoe_username')) {
          return { data: null, error: { code: '42703', message: 'column customers.pppoe_username does not exist' } };
        }
        const rows = database.customers.filter((row) => row.organization_id === this.filters.organization_id);
        return { data: rows.slice(start, end + 1), error: null };
      };
      builder.update = function update(values) { this.updateValues = values; return this; };
      builder.maybeSingle = async function maybeSingle() {
        if (this.table === 'organization_memberships') {
          return { data: role ? { role } : null, error: null };
        }
        const customer = database.customers.find((row) => row.organization_id === this.filters.organization_id
          && row.id === this.filters.id);
        if (!customer) return { data: null, error: null };
        Object.assign(customer, this.updateValues);
        return { data: { id: customer.id, pppoe_username: customer.pppoe_username }, error: null };
      };
      return builder;
    },
    async rpc(functionName, args) {
      assert.equal(functionName, 'import_router_subscriber');
      database.rpcCalls.push({ functionName, args });
      if (database.customers.some((row) => row.pppoe_username === args.p_username)) {
        return { data: { imported: false, reason: 'already-imported' }, error: null };
      }
      const profile = String(args.p_profile ?? '').trim() || 'Unassigned';
      let servicePackage = database.packages.find((row) => row.organization_id === args.p_organization_id
        && row.name.toLocaleLowerCase() === profile.toLocaleLowerCase());
      const packageCreated = !servicePackage;
      if (!servicePackage) {
        servicePackage = { id: `package-${database.packages.length + 1}`, organization_id: args.p_organization_id, name: profile };
        database.packages.push(servicePackage);
      }
      const id = `customer-${nextId++}`;
      database.customers.push({
        organization_id: args.p_organization_id,
        id,
        customer_number: Math.max(0, ...database.customers.map((row) => Number(row.customer_number) || 0)) + 1,
        pppoe_username: args.p_username,
        name: args.p_name,
        plan_name: profile,
        package_id: servicePackage.id,
        service_address: args.p_service_address,
        service_status: 'active',
        assigned_ip: args.p_assigned_ip,
        router_comment: args.p_router_comment,
      });
      return { data: { imported: true, customerId: id, packageId: servicePackage.id, packageCreated }, error: null };
    },
  };
  const factory = () => client;
  factory.database = database;
  return factory;
}

function apiRequest(path, { method = 'GET', token = 'valid-token', body, origin } = {}) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (origin) headers.set('origin', origin);
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('subscriber discovery marks existing usernames and returns only the safe preview fields', async () => {
  const clientFactory = createClientFactory({ customers: [
    { organization_id: organizationId, id: 'existing-id', customer_number: 12, pppoe_username: 'known-user' },
  ] });
  const handler = createPppoeApiHandler({
    env,
    createClient: clientFactory,
    adapter: { async discoverSubscribers() { return routerSubscribers; } },
  });
  const response = await handler(apiRequest(`/api/admin/subscribers/discover?organizationId=${organizationId}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  const result = await response.json();
  assert.equal(result.discoveredCount, 2);
  assert.deepEqual(result.subscribers.map(({ username, status }) => ({ username, status })), [
    { username: 'new-user', status: 'New' },
    { username: 'known-user', status: 'Already Imported' },
  ]);
  assert.equal('password' in result.subscribers[0], false);
});

test('selected subscriber import stores contact, profile, assigned IP and original comment while safely skipping duplicates', async () => {
  const clientFactory = createClientFactory({ customers: [
    { organization_id: organizationId, id: 'existing-id', customer_number: 12, pppoe_username: 'known-user' },
  ] });
  const handler = createPppoeApiHandler({
    env,
    createClient: clientFactory,
    adapter: { async discoverSubscribers() { return routerSubscribers; } },
  });
  const url = `/api/admin/subscribers/import?organizationId=${organizationId}`;
  const response = await handler(apiRequest(url, { method: 'POST', body: { usernames: ['new-user', 'new-user', 'known-user', 'not-on-router'] } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imported: 1, skipped: 2, importedUsernames: ['new-user'] });
  assert.equal(clientFactory.database.customers.length, 2);
  assert.deepEqual(clientFactory.database.rpcCalls[0].args, {
    p_organization_id: organizationId,
    p_username: 'new-user',
    p_name: 'Jane Doe',
    p_profile: '15M',
    p_assigned_ip: '10.10.20.190',
    p_router_comment: 'Jane Doe - 03001234567 - Shahdara - Block 2',
    p_service_address: 'Shahdara - Block 2',
    p_phone: '03001234567',
  });
  assert.equal(clientFactory.database.customers[1].pppoe_username, 'new-user');
  assert.equal(clientFactory.database.customers[1].assigned_ip, '10.10.20.190');
  assert.equal(clientFactory.database.customers[1].router_comment, 'Jane Doe - 03001234567 - Shahdara - Block 2');
  assert.equal(clientFactory.database.packages[0].name, '15M');
  assert.equal(clientFactory.database.customers[1].package_id, clientFactory.database.packages[0].id);

  const repeated = await handler(apiRequest(url, { method: 'POST', body: { usernames: ['new-user'] } }));
  assert.deepEqual(await repeated.json(), { imported: 0, skipped: 1, importedUsernames: [] });
  assert.equal(clientFactory.database.customers.length, 2);
});

test('subscriber import routes remain restricted to signed-in same-organization administrators', async () => {
  const clientFactory = createClientFactory({ role: 'customer' });
  let routerCalls = 0;
  const handler = createPppoeApiHandler({
    env,
    createClient: clientFactory,
    adapter: { async discoverSubscribers() { routerCalls += 1; return routerSubscribers; } },
  });
  const response = await handler(apiRequest(`/api/admin/subscribers/discover?organizationId=${organizationId}`));
  assert.equal(response.status, 403);
  assert.equal(routerCalls, 0);
});

test('import rejects malformed payloads and explains when the existing PPPoE mapping schema is missing', async () => {
  const url = `/api/admin/subscribers/import?organizationId=${organizationId}`;
  const handler = createPppoeApiHandler({
    env,
    createClient: createClientFactory(),
    adapter: { async discoverSubscribers() { return routerSubscribers; } },
  });
  assert.equal((await handler(apiRequest(url, { method: 'POST', body: { usernames: 'new-user' } }))).status, 400);

  const missingSchemaHandler = createPppoeApiHandler({
    env,
    createClient: createClientFactory({ missingMapping: true }),
    adapter: { async discoverSubscribers() { return routerSubscribers; } },
  });
  const response = await missingSchemaHandler(apiRequest(`/api/admin/subscribers/discover?organizationId=${organizationId}`));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /customers\.pppoe_username migration/);
});

test('comment parser preserves area text, normalizes Pakistan mobile formats, and ignores invalid phones', () => {
  assert.deepEqual(parseSubscriberComment('Jane Doe - +92 300 1234567 - Shahdara - Block 2'), {
    name: 'Jane Doe', phone: '+923001234567', area: 'Shahdara - Block 2',
  });
  assert.deepEqual(parseSubscriberComment('Only a name', 'fallback-user'), {
    name: 'Only a name', phone: '', area: '',
  });
  assert.equal(parseSubscriberComment('Name - 12345 - Area').phone, '');
});

test('import preview escapes router-provided text and selection helper accepts only new usernames', () => {
  const html = renderSubscriberImportContent({
    subscribers: [{ username: '<script>', profile: '10M', comment: '<img>', ipAddress: '10.0.0.1', status: 'New' }],
    selectedUsernames: ['<script>'],
  });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Already Exists|New/);
  const state = {
    subscribers: [
      { username: 'new-one', status: 'New' },
      { username: 'old-one', status: 'Already Imported' },
    ],
    selectedUsernames: [],
  };
  assert.deepEqual(setSelectedSubscriberUsernames(state, ['new-one', 'old-one', 'new-one']), ['new-one']);
});

test('standalone API server forwards POST JSON bodies to the protected import route', async (context) => {
  const { createPppoeApiServer } = await import('../src/server/api-only.js');
  const clientFactory = createClientFactory();
  const server = createPppoeApiServer({
    env,
    createClient: clientFactory,
    adapter: { async discoverSubscribers() { return routerSubscribers; } },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/subscribers/import?organizationId=${organizationId}`, {
    method: 'POST',
    headers: { authorization: 'Bearer valid-token', 'content-type': 'application/json' },
    body: JSON.stringify({ usernames: ['new-user'] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { imported: 1, skipped: 0, importedUsernames: ['new-user'] });
});

test('separate migration defines an admin-only atomic package/subscriber import RPC without broad write grants', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../supabase/migrations/20261007223600_router_subscriber_import.sql', import.meta.url), 'utf8');
  assert.match(sql, /^--[\s\S]*?begin;/i);
  assert.match(sql, /create table if not exists public\.service_packages/i);
  assert.match(sql, /add column if not exists package_id text/i);
  assert.match(sql, /add column if not exists assigned_ip text/i);
  assert.match(sql, /add column if not exists router_comment text/i);
  assert.match(sql, /create or replace function public\.import_router_subscriber/i);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /public\.is_org_admin\(p_organization_id\)/i);
  assert.match(sql, /on conflict on constraint customers_pppoe_username_unique do nothing/i);
  assert.match(sql, /grant execute on function public\.import_router_subscriber[\s\S]*to authenticated/i);
  assert.match(sql, /revoke all on function public\.import_router_subscriber[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /commit;\s*$/i);
});
