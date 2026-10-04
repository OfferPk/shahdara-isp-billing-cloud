import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countAdminIncidentFilters,
  filterAdminIncidentRows,
  renderAdminIncidentCards,
  renderIncidentCustomerOptions,
  toLocalDateTimeInput,
} from '../src/admin-incidents.js';

const sampleIncident = {
  id: 'synthetic-incident-1',
  customer_id: 'synthetic-customer-1',
  customer_visible_summary: 'Synthetic <outage> update',
  status: 'open',
  reported_at: '2026-03-01T10:00:00.000Z',
  offline_at: '2026-03-01T09:45:00.000Z',
  restored_at: null,
};

test('Admin incident filters search customer names and dates while keeping unknown statuses only in All', () => {
  const incidents = [
    { ...sampleIncident, id: 'open-a', customer_id: 'customer-a', status: 'open', reported_at: '2026-04-12T09:00:00.000Z' },
    { ...sampleIncident, id: 'resolved-b', customer_id: 'customer-b', status: 'resolved', reported_at: '2026-04-15T12:30:00.000Z' },
    { ...sampleIncident, id: 'legacy-a', customer_id: 'customer-a', status: 'legacy', reported_at: '2026-04-16T08:00:00.000Z' },
    { ...sampleIncident, id: 'organization-wide', customer_id: null, status: null, reported_at: null },
  ];
  const customers = [
    { id: 'customer-a', customer_number: 7, name: 'Aisha Example' },
    { id: 'customer-b', customer_number: 8, name: 'Bashir Example' },
  ];

  assert.deepEqual(filterAdminIncidentRows(incidents, { customers }).map((row) => row.id), ['open-a', 'resolved-b', 'legacy-a', 'organization-wide']);
  assert.deepEqual(filterAdminIncidentRows(incidents, { customers, status: 'open' }).map((row) => row.id), ['open-a']);
  assert.deepEqual(filterAdminIncidentRows(incidents, { customers, status: 'resolved' }).map((row) => row.id), ['resolved-b']);
  assert.deepEqual(filterAdminIncidentRows(incidents, { customers, search: 'aIsHa' }).map((row) => row.id), ['open-a', 'legacy-a']);
  assert.deepEqual(filterAdminIncidentRows(incidents, { customers, status: 'resolved', search: '2026-04-15' }).map((row) => row.id), ['resolved-b']);
  assert.deepEqual(filterAdminIncidentRows(incidents, { customers, search: 'organization-wide' }).map((row) => row.id), ['organization-wide']);
  assert.deepEqual(filterAdminIncidentRows(incidents, { customers, search: 'router outage' }), [], 'customer-visible summaries and private notes are not search fields');
  assert.equal(countAdminIncidentFilters(incidents, { customers, search: 'aisha' }).all, 2);
  assert.equal(countAdminIncidentFilters(incidents, { customers, search: 'aisha' }).open, 1);
  assert.equal(countAdminIncidentFilters(incidents, { customers, search: 'aisha' }).resolved, 0);
});

test('incident cards keep public summaries and private notes in separate labeled fields', () => {
  const html = renderAdminIncidentCards({
    incidents: [sampleIncident],
    privateDetails: [{ incident_id: sampleIncident.id, staff_notes: 'Synthetic staff-only note' }],
    customers: [{ id: 'synthetic-customer-1', customer_number: 5, name: 'Synthetic Customer' }],
  });

  assert.match(html, /Synthetic &lt;outage&gt; update/);
  assert.match(html, /name="customer_visible_summary"/);
  assert.match(html, /name="staff_notes"/);
  assert.match(html, /Private to same-organization Admins; stored separately/);
  assert.match(html, /Synthetic staff-only note/);
  assert.match(html, /name="status" required><option value="open" selected>Open<\/option><option value="resolved"/);
  assert.doesNotMatch(html, /customer_visible_summary[^<]*Synthetic staff-only note/);
});

test('filtered incident cards preserve only in-memory drafts and show a distinct no-match message', () => {
  const draftsByIncidentId = new Map([[sampleIncident.id, {
    customer_visible_summary: 'Synthetic local draft',
    status: 'resolved',
    offline_at: '2026-03-01T09:30',
    restored_at: '',
    staff_notes: 'Synthetic private draft',
  }]]);
  const html = renderAdminIncidentCards({ incidents: [sampleIncident], draftsByIncidentId });
  assert.match(html, /Synthetic local draft/);
  assert.match(html, /option value="resolved" selected/);
  assert.match(html, /Synthetic private draft/);
  assert.match(renderAdminIncidentCards({ incidents: [], emptyMessage: 'No incidents match these filters.' }), /No incidents match these filters\./);
});

test('incident form status values match the existing schema and invalid values are not silently rewritten', () => {
  const html = renderAdminIncidentCards({ incidents: [{ ...sampleIncident, status: 'unexpected' }] });
  assert.match(html, /Unrecognized \(unexpected\)/);
  assert.match(html, /editing is disabled/);
  assert.doesNotMatch(html, /name="status"/);
  assert.doesNotMatch(html, /<option value="closed"/);
});

test('incident customer options escape values and sort by customer number', () => {
  const html = renderIncidentCustomerOptions([
    { id: 'b', customer_number: 7, name: 'Second' },
    { id: 'a', customer_number: 2, name: 'First & <Safe>' },
  ]);
  assert.ok(html.indexOf('#2') < html.indexOf('#7'));
  assert.match(html, /First &amp; &lt;Safe&gt;/);
  assert.doesNotMatch(html, /<Safe>/);
});

test('date-time inputs preserve a timestamp as a local minute value without inventing one', () => {
  assert.equal(toLocalDateTimeInput(null), '');
  assert.equal(toLocalDateTimeInput('not-a-time'), '');
  const date = new Date('2026-03-01T10:00:00.000Z');
  const pad = (value) => String(value).padStart(2, '0');
  assert.equal(toLocalDateTimeInput(date.toISOString()), `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`);
});
