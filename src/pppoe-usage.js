const WINDOW_LABELS = Object.freeze([
  ['last_1_hour', 'Last 1 hour'],
  ['last_2_hours', 'Last 2 hours'],
  ['last_24_hours', 'Last 24 hours (rolling)'],
  ['last_30_days', 'Last 30 days (rolling)'],
]);

export function formatUsageBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let amount = bytes;
  let unit = 'B';
  for (const candidate of units) {
    amount /= 1000;
    unit = candidate;
    if (amount < 1000 || candidate === 'PB') break;
  }
  return `${new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(amount)} ${unit}`;
}

function timestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function speedMbps(value) {
  const amount = Number(value) / 1_000_000;
  if (!Number.isFinite(amount) || amount <= 0) return '—';
  return `${new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(amount)} Mbps`;
}

export function renderCustomerUsageCard({ currentMonth, windows = {}, t = (value) => value, escapeHtml = (value) => String(value ?? '') }) {
  const e = (value) => escapeHtml(value);
  if (!currentMonth) {
    return `<section id="customer-usage" class="panel data-panel usage-panel" aria-labelledby="customer-usage-title"><div class="section-heading"><div><p class="eyebrow">${e(t('Internet usage'))}</p><h2 id="customer-usage-title">${e(t('Data usage'))}</h2></div></div><p class="muted" role="status">${e(t('Usage tracking is not configured for this account yet.'))}</p><p class="usage-disclaimer">${e(t('Usage is informational only and does not change your service speed or block access.'))}</p></section>`;
  }
  const used = Number(currentMonth.used_bytes ?? 0);
  const quota = Number(currentMonth.quota_bytes ?? 0);
  const remaining = Number(currentMonth.remaining_bytes ?? Math.max(0, quota - used));
  const percent = quota > 0 ? Math.min(100, Math.max(0, (used / quota) * 100)) : 0;
  const stale = Boolean(currentMonth.is_stale);
  const contact = timestamp(currentMonth.last_collector_contact_at);
  const windowCards = WINDOW_LABELS.map(([key, label]) => {
    const row = windows[key] ?? {};
    return `<article class="usage-window"><h3>${e(t(label))}</h3><strong>${e(formatUsageBytes(row.used_bytes ?? 0))}</strong><p>${e(t('Upload'))}: ${e(formatUsageBytes(row.upload_bytes ?? 0))} · ${e(t('Download'))}: ${e(formatUsageBytes(row.download_bytes ?? 0))}</p></article>`;
  }).join('');
  return `<section id="customer-usage" class="panel data-panel usage-panel" aria-labelledby="customer-usage-title">
    <div class="section-heading"><div><p class="eyebrow">${e(t('Internet usage'))}</p><h2 id="customer-usage-title">${e(t('Data usage'))}</h2></div><span class="status-pill ${stale ? 'usage-status--stale' : 'usage-status--fresh'}">${e(t(stale ? 'Updates delayed or not yet confirmed' : 'Collector reporting'))}</span></div>
    <div class="usage-month"><div class="usage-month__top"><div><span>${e(t('Current billing month'))}</span><strong>${e(formatUsageBytes(used))} / ${e(formatUsageBytes(quota))}</strong></div><div><span>${e(t('Recorded data remaining'))}</span><strong>${e(formatUsageBytes(remaining))}</strong></div></div><progress max="100" value="${percent.toFixed(2)}" aria-label="${e(t('Current-month data quota used'))}"></progress><p>${e(t('Plan speed'))}: ${e(speedMbps(currentMonth.speed_download_bps))} ${e(t('download'))} / ${e(speedMbps(currentMonth.speed_upload_bps))} ${e(t('upload'))}</p></div>
    <div class="usage-window-grid">${windowCards}</div>
    <p class="usage-freshness" role="status">${e(stale ? t('Usage can be incomplete because the collector is delayed or has not checked in.') : t('Figures are collected periodically and may omit traffic since the last poll.'))}${contact ? ` ${e(t('Last collector contact'))}: <time datetime="${e(currentMonth.last_collector_contact_at)}">${e(contact)}</time>.` : ''}</p>
    <p class="usage-disclaimer">${e(t('The 24-hour window is rolling, not a calendar day. Upload and download both count toward quota. Usage does not replace bill balance, receipts, or credits, and it does not change service speed or block access.'))}</p>
  </section>`;
}

export function renderPppoeAdminSection({ customers = [], t = (value) => value, escapeHtml = (value) => String(value ?? '') }) {
  const active = [...customers].filter((customer) => !customer.archived)
    .sort((a, b) => Number(a.customer_number) - Number(b.customer_number));
  const options = active.map((customer) => `<option value="${escapeHtml(customer.id)}">#${escapeHtml(customer.customer_number)} · ${escapeHtml(customer.name)}</option>`).join('');
  return `<section id="admin-pppoe-usage" class="panel data-panel pppoe-admin-panel" aria-labelledby="admin-pppoe-usage-title">
    <div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Read-only RouterOS polling'))}</p><h2 id="admin-pppoe-usage-title">${escapeHtml(t('PPPoE usage configuration'))}</h2></div></div>
    <p class="muted">${escapeHtml(t('Map an existing PPPoE username to one active customer and set the example plan quota and speeds. This cloud feature only reads counters; it does not change RouterOS users or enforce a speed/quota.'))}</p>
    <form id="pppoe-mapping-form" class="pppoe-mapping-form">
      <label>${escapeHtml(t('Collection site ID'))}<input name="site_id" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,63}" placeholder="site-router-1" required></label>
      <label>${escapeHtml(t('Site display name'))}<input name="site_label" maxlength="100" placeholder="Main router" required></label>
      <label>${escapeHtml(t('Existing active customer'))}<select name="customer_id" required ${active.length ? '' : 'disabled'}><option value="" selected disabled>${escapeHtml(t('Select an active customer'))}</option>${options}</select></label>
      <label>${escapeHtml(t('PPPoE username'))}<input name="pppoe_username" maxlength="255" autocomplete="off" required></label>
      <label>${escapeHtml(t('Quota (decimal GB per month)'))}<input name="quota_gb" type="number" min="0.001" max="9000000" step="0.001" value="100" required></label>
      <label>${escapeHtml(t('Download speed (Mbps)'))}<input name="download_mbps" type="number" min="0.001" max="9000000" step="0.001" value="5" required></label>
      <label>${escapeHtml(t('Upload speed (Mbps)'))}<input name="upload_mbps" type="number" min="0.001" max="9000000" step="0.001" value="5" required></label>
      <button class="button primary" type="submit" ${active.length ? '' : 'disabled'}>${escapeHtml(t('Save PPPoE mapping'))}</button>
    </form>
    <p class="form-message" id="pppoe-mapping-message" role="status" aria-live="polite"></p>
    <div id="pppoe-collector-token" class="pppoe-token-box" hidden><label for="pppoe-token-value">${escapeHtml(t('Per-site collector token'))}<input id="pppoe-token-value" type="text" readonly autocomplete="off" spellcheck="false"></label><div class="pppoe-token-actions"><button class="button secondary small" type="button" data-usage-action="copy-token">${escapeHtml(t('Copy token'))}</button><button class="button secondary small" type="button" data-usage-action="hide-token">${escapeHtml(t('Hide token'))}</button></div><p class="muted">${escapeHtml(t('Store this token only on the private site-side collector. It is not saved in this browser.'))}</p></div>
    <p class="pppoe-admin-help">${escapeHtml(t('The collector must run on the private LAN, use HTTPS with certificate validation, and reach the router only over its private address. Never expose RouterOS management to the public internet.'))}</p>
    <div id="pppoe-mapping-list" class="pppoe-mapping-list" role="region" aria-label="${escapeHtml(t('Configured PPPoE mappings'))}" aria-live="polite"><p class="muted">${escapeHtml(t('Loading PPPoE mappings…'))}</p></div>
    <div class="pppoe-usage-report"><h3>${escapeHtml(t('Customer usage totals for dispute review'))}</h3><div id="pppoe-usage-report" class="pppoe-usage-report__body" role="region" aria-live="polite"><p class="muted">${escapeHtml(t('Loading usage summaries…'))}</p></div></div>
  </section>`;
}

export function renderPppoeMappingList({ mappings = [], sites = [], customers = [], t = (value) => value, escapeHtml = (value) => String(value ?? '') }) {
  if (!mappings.length) return `<p class="muted" role="status">${escapeHtml(t('No PPPoE usage mappings are configured yet.'))}</p>`;
  const siteById = new Map(sites.map((site) => [site.site_id, site]));
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));
  const cards = mappings.map((mapping) => {
    const site = siteById.get(mapping.site_id) ?? {};
    const customer = customerById.get(mapping.customer_id) ?? {};
    const lastSeen = timestamp(site.last_contact_at);
    const status = !site.enabled ? t('Disabled') : (lastSeen ? `${t('Last contact')}: ${lastSeen}` : t('Waiting for collector'));
    return `<article class="pppoe-mapping-card"><div><p class="eyebrow">${escapeHtml(site.display_name || mapping.site_id)}</p><h3>${escapeHtml(customer.name || t('Customer'))}</h3><p><strong>${escapeHtml(t('PPPoE username'))}:</strong> <code>${escapeHtml(mapping.pppoe_username)}</code></p><p>${escapeHtml(formatUsageBytes(mapping.quota_bytes))} ${escapeHtml(t('monthly quota'))} · ${escapeHtml(speedMbps(mapping.speed_download_bps))} ${escapeHtml(t('download'))} / ${escapeHtml(speedMbps(mapping.speed_upload_bps))} ${escapeHtml(t('upload'))}</p><p class="muted">${escapeHtml(status)}</p></div><button class="button secondary small" type="button" data-usage-action="show-token" data-site-id="${escapeHtml(mapping.site_id)}" ${site.enabled ? '' : 'disabled'}>${escapeHtml(t('Get collector token'))}</button></article>`;
  }).join('');
  return `<div class="pppoe-mapping-grid">${cards}</div>`;
}


export function renderPppoeAdminUsageReport({ customers = [], mappings = [], views = {}, t = (value) => value, escapeHtml = (value) => String(value ?? '') }) {
  const monthByCustomer = new Map((views.currentMonth ?? []).map((row) => [row.customer_id, row]));
  const windowNames = [
    ['last_1_hour', 'Last 1 hour'],
    ['last_2_hours', 'Last 2 hours'],
    ['last_24_hours', 'Last 24 hours (rolling)'],
    ['last_30_days', 'Last 30 days (rolling)'],
  ];
  const byWindow = Object.fromEntries(windowNames.map(([key]) => [key, new Map((views[key] ?? []).map((row) => [row.customer_id, row]))]));
  const mappedIds = new Set(mappings.map((mapping) => mapping.customer_id));
  const rows = [...mappedIds].map((customerId) => {
    const customer = customers.find((item) => item.id === customerId) ?? {};
    const month = monthByCustomer.get(customerId);
    const names = [...new Set(mappings.filter((mapping) => mapping.customer_id === customerId).map((mapping) => mapping.pppoe_username))];
    const usernameLabel = names.join(', ');
    const periodUsed = month ? formatUsageBytes(month.used_bytes) : '—';
    const quota = month ? formatUsageBytes(month.quota_bytes) : '—';
    const remaining = month ? formatUsageBytes(month.remaining_bytes) : '—';
    const status = !month ? t('Waiting for first usage record') : (month.is_stale ? t('Stale or incomplete') : t('Reporting'));
    const contact = month?.last_collector_contact_at;
    const contactText = timestamp(contact) || t('No collector contact yet');
    const windowCells = windowNames.map(([key]) => {
      const value = byWindow[key].get(customerId);
      return `<td>${escapeHtml(value ? formatUsageBytes(value.used_bytes) : '0 B')}<small>${escapeHtml(t('Upload'))}: ${escapeHtml(formatUsageBytes(value?.upload_bytes ?? 0))} / ${escapeHtml(t('Download'))}: ${escapeHtml(formatUsageBytes(value?.download_bytes ?? 0))}</small></td>`;
    }).join('');
    return `<tr><th scope="row">${escapeHtml(customer.name || customerId)}<small>${escapeHtml(t('PPPoE username'))}: ${escapeHtml(usernameLabel)}</small></th><td>${escapeHtml(speedMbps(month?.speed_download_bps ?? mappings.find((item) => item.customer_id === customerId)?.speed_download_bps))} / ${escapeHtml(speedMbps(month?.speed_upload_bps ?? mappings.find((item) => item.customer_id === customerId)?.speed_upload_bps))}</td><td>${escapeHtml(periodUsed)} / ${escapeHtml(quota)}<small>${escapeHtml(t('Remaining'))}: ${escapeHtml(remaining)}</small></td>${windowCells}<td><span class="status-pill ${month?.is_stale ? 'usage-status--stale' : ''}">${escapeHtml(status)}</span><small>${escapeHtml(contactText)}</small></td></tr>`;
  }).join('');
  if (!rows) return `<p class="muted" role="status">${escapeHtml(t('No mapped PPPoE customers have usage summaries yet.'))}</p>`;
  return `<div class="table-wrap" role="region" tabindex="0" aria-label="${escapeHtml(t('Admin PPPoE usage totals; scroll horizontally to compare customer windows'))}"><table class="pppoe-usage-table"><caption class="sr-only">${escapeHtml(t('Customer-scoped totals from the exact same usage views shown to customers.'))}</caption><thead><tr><th scope="col">${escapeHtml(t('Customer / PPPoE username'))}</th><th scope="col">${escapeHtml(t('Speed (Mbps)'))}</th><th scope="col">${escapeHtml(t('Current month used / quota'))}</th>${windowNames.map(([, label]) => `<th scope="col">${escapeHtml(t(label))}</th>`).join('')}<th scope="col">${escapeHtml(t('Freshness / last contact'))}</th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted">${escapeHtml(t('These totals come from the same RLS-protected database views as the customer card; billing balances, receipts and credits are separate.'))}</p>`;
}
