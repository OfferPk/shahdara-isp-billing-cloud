const identity = (value) => String(value);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
import { fetchPppoeTelemetry, isGithubPagesStaticHost, resolvePppoeApiBase } from './pppoe-api-client.js';

export function formatTraffic(bytes) {
  let amount;
  try { amount = typeof bytes === 'bigint' ? bytes : BigInt(String(bytes ?? 0)); } catch { amount = 0n; }
  if (amount < 0n) amount = 0n;
  const megabyte = 1024 ** 2;
  const gigabyte = 1024 ** 3;
  const numeric = Number(amount);
  if (amount >= 1024n ** 3n) return `${(numeric / gigabyte).toFixed(2)} GB`;
  if (amount >= 1024n ** 2n) return `${(numeric / megabyte).toFixed(1)} MB`;
  return `${(numeric / 1024).toFixed(0)} KB`;
}

export function filterPppoeSessions(sessions, { search = '', status = 'all' } = {}) {
  const needle = String(search).trim().toLocaleLowerCase();
  const normalizedStatus = String(status).toLowerCase();
  return (Array.isArray(sessions) ? sessions : []).filter((session) => {
    const state = String(session.status ?? 'Unknown').toLowerCase();
    if (normalizedStatus !== 'all' && state !== normalizedStatus) return false;
    if (!needle) return true;
    return [session.username, session.ipAddress, session.callerId]
      .some((value) => String(value ?? '').toLocaleLowerCase().includes(needle));
  });
}

export function renderPppoeSessionRows(sessions, { t = identity } = {}) {
  if (!sessions.length) return `<tr><td class="empty-cell" colspan="9">${escapeHtml(t('No sessions match these filters.'))}</td></tr>`;
  return sessions.map((session, index) => {
    const online = session.status === 'Online';
    return `<tr>
      <td><strong>${escapeHtml(session.username)}</strong></td>
      <td><code>${escapeHtml(session.ipAddress || '—')}</code></td>
      <td><code>${escapeHtml(session.callerId || '—')}</code></td>
      <td>${escapeHtml(session.interfaceName || '—')}</td>
      <td>${escapeHtml(session.uptime || '—')}</td>
      <td>${escapeHtml(formatTraffic(session.bytesIn))}</td>
      <td>${escapeHtml(formatTraffic(session.bytesOut))}</td>
      <td><span class="pppoe-status ${online ? 'pppoe-status--online' : 'pppoe-status--offline'}"><span aria-hidden="true"></span>${escapeHtml(t(session.status || 'Unknown'))}</span></td>
      <td><button class="button secondary small" type="button" data-session-details="${index}">${escapeHtml(t('View Details'))}</button></td>
    </tr>`;
  }).join('');
}

export function renderPppoeSessionsDashboard({ t = identity } = {}) {
  return `<div class="pppoe-dashboard">
    <div class="section-heading pppoe-dashboard__heading">
      <div><p class="eyebrow">${escapeHtml(t('LIVE NETWORK TELEMETRY'))}</p><h2 id="pppoe-sessions-title" tabindex="-1">${escapeHtml(t('Admin Active Sessions'))}</h2><p class="muted">${escapeHtml(t('Read-only live view of current PPPoE connections.'))}</p></div>
      <p class="pppoe-last-updated" id="pppoe-last-updated" role="status" aria-live="polite">${escapeHtml(t('Waiting for first update…'))}</p>
    </div>
    <div class="pppoe-summary-grid" aria-label="${escapeHtml(t('Active session summary'))}">
      <article class="pppoe-summary-card pppoe-summary-card--users">
        <div class="pppoe-summary-card__top"><span>${escapeHtml(t('Total Active Users'))}</span><span class="pppoe-live-indicator"><i aria-hidden="true"></i>${escapeHtml(t('LIVE'))}</span></div>
        <strong id="pppoe-total-active">—</strong><small>${escapeHtml(t('Online PPPoE sessions'))}</small>
      </article>
      <article class="pppoe-summary-card pppoe-summary-card--traffic">
        <div class="pppoe-summary-card__top"><span>${escapeHtml(t('Total Live Traffic'))}</span><span aria-hidden="true">↕</span></div>
        <div class="pppoe-traffic-values"><p><small>${escapeHtml(t('Download · Rx'))}</small><strong id="pppoe-total-download">—</strong></p><p><small>${escapeHtml(t('Upload · Tx'))}</small><strong id="pppoe-total-upload">—</strong></p></div>
      </article>
      <article class="pppoe-summary-card pppoe-summary-card--router">
        <div class="pppoe-summary-card__top"><span>${escapeHtml(t('Router Status'))}</span><span id="pppoe-router-badge" class="pppoe-router-badge pppoe-router-badge--unknown">${escapeHtml(t('Checking'))}</span></div>
        <strong id="pppoe-router-host">—</strong><small><span id="pppoe-router-latency">—</span> ${escapeHtml(t('latency'))} · CPU <span id="pppoe-router-cpu">—</span></small>
      </article>
    </div>
    <div class="pppoe-toolbar" aria-label="${escapeHtml(t('Session controls'))}">
      <label class="pppoe-search" for="pppoe-session-search"><span>${escapeHtml(t('Search sessions'))}</span><input id="pppoe-session-search" type="search" autocomplete="off" placeholder="${escapeHtml(t('Username, IP address, or MAC'))}"></label>
      <label class="pppoe-status-filter" for="pppoe-session-status"><span>${escapeHtml(t('Status'))}</span><select id="pppoe-session-status"><option value="all">${escapeHtml(t('All'))}</option><option value="online">${escapeHtml(t('Online'))}</option><option value="offline">${escapeHtml(t('Offline'))}</option></select></label>
      <button id="pppoe-refresh-now" class="button primary" type="button">${escapeHtml(t('Refresh Now'))}</button>
      <div class="pppoe-auto-refresh" role="group" aria-label="${escapeHtml(t('Auto-refresh interval'))}"><span>${escapeHtml(t('Auto-refresh'))}</span><button type="button" data-auto-refresh="0" aria-pressed="true">${escapeHtml(t('Off'))}</button><button type="button" data-auto-refresh="10000" aria-pressed="false">10s</button><button type="button" data-auto-refresh="30000" aria-pressed="false">30s</button></div>
    </div>
    <p id="pppoe-data-mode" class="pppoe-data-mode" role="status" aria-live="polite" hidden></p>
    <p id="pppoe-api-error" class="pppoe-api-error" role="alert" hidden></p>
    <p id="pppoe-session-count" class="pppoe-session-count" role="status" aria-live="polite">${escapeHtml(t('Loading sessions…'))}</p>
    <div class="table-wrap pppoe-table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(t('Active PPPoE sessions table'))}">
      <table class="pppoe-table"><thead><tr><th>${escapeHtml(t('Username'))}</th><th>${escapeHtml(t('IP Address'))}</th><th>${escapeHtml(t('Caller-ID / MAC'))}</th><th>${escapeHtml(t('Interface'))}</th><th>${escapeHtml(t('Uptime'))}</th><th>${escapeHtml(t('Download'))}</th><th>${escapeHtml(t('Upload'))}</th><th>${escapeHtml(t('Status'))}</th><th>${escapeHtml(t('Actions'))}</th></tr></thead><tbody id="pppoe-session-rows"><tr><td class="empty-cell" colspan="9">${escapeHtml(t('Loading live sessions…'))}</td></tr></tbody></table>
    </div>
    <dialog id="pppoe-session-dialog" class="pppoe-session-dialog" aria-labelledby="pppoe-session-dialog-title"><div class="pppoe-session-dialog__header"><div><p class="eyebrow">${escapeHtml(t('TECHNICAL SESSION DETAILS'))}</p><h3 id="pppoe-session-dialog-title">${escapeHtml(t('Session details'))}</h3></div><button class="button secondary small" type="button" data-close-session-details aria-label="${escapeHtml(t('Close details'))}">×</button></div><div id="pppoe-session-detail-body"></div></dialog>
  </div>`;
}

function sessionDetailsMarkup(session, t) {
  const fields = [
    ['Session ID', session.sessionId], ['Username', session.username], ['Caller-ID / MAC', session.callerId],
    ['IP Address', session.ipAddress], ['Interface', session.interfaceName], ['Status', session.status],
    ['Uptime', session.uptime], ['Uptime (seconds)', session.uptimeSeconds], ['Download bytes · Rx', session.bytesIn],
    ['Upload bytes · Tx', session.bytesOut], ['Rate limit', session.rateLimit], ['Last polled', session.lastPolledAt],
  ];
  return `<dl class="pppoe-detail-grid">${fields.map(([label, value]) => `<div><dt>${escapeHtml(t(label))}</dt><dd>${escapeHtml(value ?? '—')}</dd></div>`).join('')}</dl>`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function mountPppoeSessionsDashboard(root, {
  organizationId,
  getAccessToken,
  t = identity,
  fetchImpl = globalThis.fetch,
  apiBaseUrl: apiBaseUrlOverride,
  interval = 0,
} = {}) {
  if (!root || typeof fetchImpl !== 'function') return () => {};
  root.innerHTML = renderPppoeSessionsDashboard({ t });
  const state = { sessions: [], health: null, totalActiveUsers: 0, totalTraffic: { bytesIn: '0', bytesOut: '0' }, search: '', status: 'all', interval, timer: null, loading: false, destroyed: false };
  const find = (selector) => root.querySelector(selector);
  const rows = find('#pppoe-session-rows');
  const dialog = find('#pppoe-session-dialog');

  function renderRows() {
    const filtered = filterPppoeSessions(state.sessions, { search: state.search, status: state.status });
    rows.innerHTML = renderPppoeSessionRows(filtered, { t });
    const count = find('#pppoe-session-count');
    count.textContent = `${filtered.length} ${t('of')} ${state.sessions.length} ${t('sessions shown')}`;
  }

  function renderSummary() {
    find('#pppoe-total-active').textContent = String(state.totalActiveUsers);
    find('#pppoe-total-download').textContent = formatTraffic(state.totalTraffic.bytesIn);
    find('#pppoe-total-upload').textContent = formatTraffic(state.totalTraffic.bytesOut);
    const health = state.health;
    const badge = find('#pppoe-router-badge');
    if (health?.connected) {
      badge.className = 'pppoe-router-badge pppoe-router-badge--connected';
      badge.textContent = t('Connected');
    } else {
      badge.className = 'pppoe-router-badge pppoe-router-badge--disconnected';
      badge.textContent = t('Disconnected');
    }
    find('#pppoe-router-host').textContent = health?.routerHost || '—';
    find('#pppoe-router-latency').textContent = health?.connected ? `${Number(health.latencyMs) || 0} ms` : '—';
    find('#pppoe-router-cpu').textContent = Number.isFinite(Number(health?.cpuLoadPercent)) ? `${Number(health.cpuLoadPercent)}%` : '—';
    find('#pppoe-last-updated').textContent = health?.lastCheckedAt ? `${t('Updated')} ${formatTimestamp(health.lastCheckedAt)}` : t('Waiting for first update…');
  }

  async function refresh() {
    if (state.loading || state.destroyed) return;
    state.loading = true;
    const refreshButton = find('#pppoe-refresh-now');
    refreshButton.disabled = true;
    refreshButton.setAttribute('aria-busy', 'true');
    const errorPanel = find('#pppoe-api-error');
    const dataMode = find('#pppoe-data-mode');
    errorPanel.hidden = true;
    try {
      const token = await getAccessToken?.();
      const apiBaseUrl = apiBaseUrlOverride ?? resolvePppoeApiBase();
      const telemetry = await fetchPppoeTelemetry({
        organizationId,
        token,
        fetchImpl,
        apiBaseUrl,
        staticPages: isGithubPagesStaticHost({ apiBaseUrl }),
      });
      if (state.destroyed) return;
      state.sessions = telemetry.sessions;
      state.totalActiveUsers = telemetry.totalActiveUsers;
      state.totalTraffic = telemetry.totalTraffic;
      state.health = telemetry.health;
      dataMode.hidden = false;
      dataMode.dataset.mode = telemetry.source === 'mock' ? 'demo' : 'live';
      dataMode.textContent = telemetry.source === 'mock'
        ? (telemetry.fallbackReason === 'static-host'
          ? t('Demo mode · GitHub Pages uses sample router data.')
          : t('Demo mode · API is unavailable; showing sample router data.'))
        : t('Live data · connected to the PPPoE API.');
      renderSummary();
      renderRows();
    } catch (error) {
      if (state.destroyed) return;
      dataMode.hidden = true;
      errorPanel.textContent = error?.message || t('Live router data could not be loaded.');
      errorPanel.hidden = false;
      if (!state.health) {
        state.health = { connected: false, routerHost: '', latencyMs: 0 };
        renderSummary();
      }
      renderRows();
    } finally {
      state.loading = false;
      if (!state.destroyed && refreshButton.isConnected) {
        refreshButton.disabled = false;
        refreshButton.removeAttribute('aria-busy');
      }
    }
  }

  function setIntervalMs(milliseconds) {
    state.interval = [0, 10000, 30000].includes(milliseconds) ? milliseconds : 0;
    if (state.timer) clearInterval(state.timer);
    state.timer = state.interval ? setInterval(() => { void refresh(); }, state.interval) : null;
    for (const button of root.querySelectorAll('[data-auto-refresh]')) {
      button.setAttribute('aria-pressed', String(Number(button.dataset.autoRefresh) === state.interval));
    }
  }

  root.addEventListener('input', (event) => {
    if (event.target?.id === 'pppoe-session-search') {
      state.search = event.target.value;
      renderRows();
    }
  });
  root.addEventListener('change', (event) => {
    if (event.target?.id === 'pppoe-session-status') {
      state.status = event.target.value;
      renderRows();
    }
  });
  root.addEventListener('click', (event) => {
    const refreshButton = event.target.closest?.('#pppoe-refresh-now');
    if (refreshButton) { void refresh(); return; }
    const intervalButton = event.target.closest?.('[data-auto-refresh]');
    if (intervalButton) { setIntervalMs(Number(intervalButton.dataset.autoRefresh)); return; }
    const detailButton = event.target.closest?.('[data-session-details]');
    if (detailButton) {
      const session = filterPppoeSessions(state.sessions, { search: state.search, status: state.status })[Number(detailButton.dataset.sessionDetails)];
      if (!session) return;
      find('#pppoe-session-detail-body').innerHTML = sessionDetailsMarkup(session, t);
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      find('[data-close-session-details]')?.focus();
      return;
    }
    if (event.target.closest?.('[data-close-session-details]')) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog && typeof dialog.close === 'function') dialog.close();
  });
  setIntervalMs(state.interval);
  void refresh();

  return () => {
    state.destroyed = true;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  };
}

export const pppoeDashboardInternals = Object.freeze({ escapeHtml, sessionDetailsMarkup });
