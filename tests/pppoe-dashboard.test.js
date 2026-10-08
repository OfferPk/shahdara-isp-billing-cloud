import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterPppoeSessions,
  formatTraffic,
  renderPppoeSessionRows,
  renderPppoeSessionsDashboard,
} from '../src/admin-pppoe-sessions.js';

const sessions = [
  { sessionId: '*1', username: 'shahdara_user_01', callerId: '48:8F:5A:12:34:56', ipAddress: '10.10.20.101', interfaceName: '<pppoe-user01>', uptime: '1d 02h 03m 04s', uptimeSeconds: 93784, bytesIn: '10485760', bytesOut: '2097152', status: 'Online', lastPolledAt: '2026-10-07T16:00:00.000Z' },
  { sessionId: '*2', username: 'offline-lab', callerId: 'A4:2B:B0:01:02:03', ipAddress: '10.10.20.102', interfaceName: '<pppoe-user02>', uptime: '0d 00h 00m 00s', uptimeSeconds: 0, bytesIn: '0', bytesOut: '0', status: 'Offline', lastPolledAt: '2026-10-07T16:00:00.000Z' },
];

test('traffic formatter displays byte counts as readable MB and GB values', () => {
  assert.equal(formatTraffic('10485760'), '10.0 MB');
  assert.equal(formatTraffic((2n * 1024n ** 3n).toString()), '2.00 GB');
  assert.equal(formatTraffic('invalid'), '0 KB');
});

test('search filters username, IP or MAC case-insensitively and status filters online/offline', () => {
  assert.deepEqual(filterPppoeSessions(sessions, { search: 'SHAHDARA_USER_01' }).map((row) => row.username), ['shahdara_user_01']);
  assert.deepEqual(filterPppoeSessions(sessions, { search: '10.10.20.102' }).map((row) => row.username), ['offline-lab']);
  assert.deepEqual(filterPppoeSessions(sessions, { search: 'a4:2b:b0' }).map((row) => row.username), ['offline-lab']);
  assert.deepEqual(filterPppoeSessions(sessions, { status: 'online' }).map((row) => row.username), ['shahdara_user_01']);
  assert.deepEqual(filterPppoeSessions(sessions, { status: 'offline' }).map((row) => row.username), ['offline-lab']);
});

test('session table renders all nine required columns, online/offline badges and escaped values', () => {
  const headings = renderPppoeSessionsDashboard();
  assert.equal((headings.match(/<th>/g) ?? []).length, 9);
  const rendered = renderPppoeSessionRows(sessions);
  assert.match(rendered, /shahdara_user_01/);
  assert.match(rendered, /pppoe-status--online/);
  assert.match(rendered, /pppoe-status--offline/);
  assert.match(rendered, /data-session-details="0"/);
  assert.match(renderPppoeSessionRows([{ ...sessions[0], username: '<img src=x onerror=alert(1)>' }]), /&lt;img/);
  assert.doesNotMatch(renderPppoeSessionRows([{ ...sessions[0], username: '<img src=x onerror=alert(1)>' }]), /<img/);
});

test('dashboard includes live summaries, status/search controls, auto-refresh choices and technical detail dialog', () => {
  const markup = renderPppoeSessionsDashboard();
  for (const selector of [
    'Total Active Users', 'Total Live Traffic', 'Router Status', 'Download · Rx', 'Upload · Tx',
    'Search sessions', 'Username, IP address, or MAC', 'pppoe-session-status', 'Refresh Now',
    'data-auto-refresh="0"', 'data-auto-refresh="10000"', 'data-auto-refresh="30000"',
    'TECHNICAL SESSION DETAILS', 'pppoe-session-dialog',
  ]) assert.ok(markup.includes(selector), `missing ${selector}`);
  assert.match(renderPppoeSessionRows(sessions), /View Details/);
});
