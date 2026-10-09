const BYTE_UNITS = Object.freeze(['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB']);
const BYTE_BASE = 1000n;
const DAY_MS = 24 * 60 * 60 * 1000;
export const STALE_USAGE_THRESHOLD_MS = DAY_MS;
export const EXPIRY_WARNING_DAYS = 3;

export function buildDemoCustomerMonthlyUsage(customer) {
  if (!/^shahdara_user_\d{2}$/.test(String(customer?.pppoe_username ?? ''))) return null;
  return {
    bytes: 64_500_000_000n,
    source: 'demo',
    quotaPackage: {
      package_name: 'Demo 3 Mbps / 100 GB',
      quota_type: 'fup_capped',
      quota_limit_gb: 100,
      action_on_exhaust: 'notify',
    },
  };
}

function parseNonNegativeBytes(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function formatLocale(locale) {
  return String(locale).toLowerCase().startsWith('ur-latn') ? 'en-PK' : locale;
}

export function formatUsageBytes(value, locale = 'en-PK') {
  const bytes = parseNonNegativeBytes(value);
  if (bytes === null) return '—';
  if (bytes === 0n) return '0 B';

  let unitIndex = 0;
  while (unitIndex < BYTE_UNITS.length - 1 && bytes >= BYTE_BASE ** BigInt(unitIndex + 1)) unitIndex += 1;
  const amount = Number(bytes) / Number(BYTE_BASE ** BigInt(unitIndex));
  const formatted = new Intl.NumberFormat(formatLocale(locale), { maximumFractionDigits: unitIndex ? 1 : 0 }).format(amount);
  return `${formatted} ${BYTE_UNITS[unitIndex]}`;
}

function formatUsageGigabytes(value, locale = 'en-PK') {
  const bytes = parseNonNegativeBytes(value);
  if (bytes === null) return '—';
  const amount = Number(bytes) / Number(BYTE_BASE ** 3n);
  return `${new Intl.NumberFormat(formatLocale(locale), { maximumFractionDigits: 2 }).format(amount)} GB`;
}

function percentageToOneDecimal(numerator, denominator) {
  if (denominator <= 0n) return null;
  return Number((numerator * 1000n + denominator / 2n) / denominator) / 10;
}

export function summarizeCustomerUsage(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const downloadBytes = parseNonNegativeBytes(snapshot.bytes_in);
  const uploadBytes = parseNonNegativeBytes(snapshot.bytes_out);
  const quotaBytes = parseNonNegativeBytes(snapshot.total_quota_bytes);
  if (downloadBytes === null || uploadBytes === null || quotaBytes === null) return null;

  const totalUsedBytes = downloadBytes + uploadBytes;
  const unlimited = quotaBytes === 0n;
  const remainingBytes = unlimited ? null : (quotaBytes > totalUsedBytes ? quotaBytes - totalUsedBytes : 0n);
  const consumedPercent = unlimited ? null : percentageToOneDecimal(totalUsedBytes, quotaBytes);
  const remainingPercent = unlimited ? null : percentageToOneDecimal(remainingBytes, quotaBytes);
  const quotaTone = unlimited
    ? 'unlimited'
    : totalUsedBytes * 100n < quotaBytes * 75n
      ? 'good'
      : totalUsedBytes * 100n <= quotaBytes * 90n
        ? 'warning'
        : 'critical';

  return {
    downloadBytes,
    uploadBytes,
    totalUsedBytes,
    quotaBytes,
    unlimited,
    remainingBytes,
    consumedPercent,
    remainingPercent,
    quotaTone,
    overQuotaBytes: unlimited || totalUsedBytes <= quotaBytes ? 0n : totalUsedBytes - quotaBytes,
  };
}

export function getUsageFreshness(lastSyncedAt, now = new Date()) {
  if (typeof lastSyncedAt !== 'string' || !lastSyncedAt.trim()) return { state: 'unknown', date: null };
  const date = new Date(lastSyncedAt);
  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(currentTime)) return { state: 'unknown', date: null };
  const age = currentTime - date.getTime();
  if (age < -5 * 60 * 1000) return { state: 'unknown', date: null };
  return { state: age > STALE_USAGE_THRESHOLD_MS ? 'stale' : 'recent', date };
}

export function formatRelativeUsageSync(lastSyncedAt, now = new Date(), locale = 'en-PK') {
  const date = new Date(lastSyncedAt);
  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(currentTime)) return '';
  const ageMs = currentTime - date.getTime();
  if (ageMs < -5 * 60 * 1000) return '';
  const age = Math.max(0, ageMs);
  const units = [
    ['second', 1000], ['minute', 60 * 1000], ['hour', 60 * 60 * 1000],
    ['day', DAY_MS], ['month', 30 * DAY_MS], ['year', 365 * DAY_MS],
  ];
  let unit = units[0][0];
  let duration = units[0][1];
  for (const candidate of units) {
    if (age >= candidate[1]) [unit, duration] = candidate;
  }
  const count = Math.max(1, Math.floor(age / duration));

  if (String(locale).toLowerCase().startsWith('ur-latn')) {
    if (age < 10 * 1000) return 'abhi';
    const romanUnit = unit === 'hour' ? (count === 1 ? 'ghanta' : 'ghantay')
      : unit === 'day' ? 'din'
        : unit === 'month' ? 'mahine'
          : unit === 'year' ? 'saal'
            : unit === 'minute' ? 'minute' : 'second';
    return `${count} ${romanUnit} pehle`;
  }

  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-count, unit);
}

function parseLocalDateOnly(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { date, year, month, day };
}

function calendarDayNumber(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function getServiceExpiryStatus(expiryDate, now = new Date()) {
  if (typeof expiryDate !== 'string' || !expiryDate.trim()) {
    return { state: 'unavailable', date: null, isoDate: '', daysRemaining: null };
  }
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) return { state: 'unknown', date: null, isoDate: '', daysRemaining: null };

  const localExpiry = parseLocalDateOnly(expiryDate);
  if (localExpiry) {
    const daysRemaining = calendarDayNumber(localExpiry.year, localExpiry.month, localExpiry.day)
      - calendarDayNumber(current.getFullYear(), current.getMonth() + 1, current.getDate());
    return {
      state: daysRemaining < 0 ? 'expired' : daysRemaining <= EXPIRY_WARNING_DAYS ? 'warning' : 'upcoming',
      date: localExpiry.date,
      isoDate: expiryDate,
      daysRemaining,
    };
  }

  const date = new Date(expiryDate);
  if (!Number.isFinite(date.getTime())) return { state: 'unknown', date: null, isoDate: '', daysRemaining: null };
  const daysRemaining = Math.ceil((date.getTime() - current.getTime()) / DAY_MS);
  return {
    state: date.getTime() <= current.getTime() ? 'expired' : daysRemaining <= EXPIRY_WARNING_DAYS ? 'warning' : 'upcoming',
    date,
    isoDate: date.toISOString(),
    daysRemaining,
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function translateDays(t, key, days) {
  return t(key).replace('{days}', String(days));
}

export function renderServiceExpiryNotice({ expiryDate = null, now = new Date(), t = (value) => value, locale = 'en-PK' } = {}) {
  const status = getServiceExpiryStatus(expiryDate, now);
  const localeForDates = formatLocale(locale);
  const formattedDate = status.date
    ? new Intl.DateTimeFormat(localeForDates, { dateStyle: 'medium' }).format(status.date)
    : '';
  const dateLine = status.date
    ? `<p class="usage-expiry__date">${escapeHtml(t('Renewal date:'))} <time datetime="${escapeHtml(status.isoDate)}">${escapeHtml(formattedDate)}</time></p>`
    : '';

  if (status.state === 'unavailable') {
    return `<aside id="customer-expiry" class="usage-expiry usage-expiry--unknown" aria-labelledby="customer-expiry-title">
      <div class="usage-expiry__heading"><div><p class="eyebrow">${escapeHtml(t('Service expiry'))}</p><h3 id="customer-expiry-title">${escapeHtml(t('Expiry date not recorded'))}</h3></div><span class="status-pill status-pill--unknown">${escapeHtml(t('Not recorded'))}</span></div>
      <p>${escapeHtml(t('No service-expiry date is recorded for this account. A bill due date is separate and is not used as service expiry.'))}</p>
      <p class="muted">${escapeHtml(t('Expiry alerts are unavailable until an actual service-expiry date is recorded.'))}</p>
    </aside>`;
  }

  if (status.state === 'unknown') {
    return `<aside id="customer-expiry" class="usage-expiry usage-expiry--unknown" aria-labelledby="customer-expiry-title"><div class="usage-expiry__heading"><div><p class="eyebrow">${escapeHtml(t('Service expiry'))}</p><h3 id="customer-expiry-title">${escapeHtml(t('Expiry date not available'))}</h3></div><span class="status-pill status-pill--unknown">${escapeHtml(t('Status unavailable'))}</span></div><p role="status">${escapeHtml(t('The recorded service-expiry date could not be read.'))}</p></aside>`;
  }

  if (status.state === 'expired') {
    const daysAgo = Math.max(0, -status.daysRemaining);
    const message = daysAgo === 0 ? t('The renewal date has passed.')
      : daysAgo === 1 ? t('Service expired 1 day ago.')
        : translateDays(t, 'Service expired {days} days ago.', daysAgo);
    return `<aside id="customer-expiry" class="usage-expiry usage-expiry--expired" aria-labelledby="customer-expiry-title"><div class="usage-expiry__heading"><div><p class="eyebrow">${escapeHtml(t('Service expiry'))}</p><h3 id="customer-expiry-title">${escapeHtml(t('Expired'))}</h3></div><span class="status-pill usage-expiry__badge usage-expiry__badge--expired">${escapeHtml(t('Expired'))}</span></div><p role="alert">${escapeHtml(message)}</p>${dateLine}</aside>`;
  }

  if (status.state === 'warning') {
    const message = status.daysRemaining === 0 ? t('Renewal is due today.')
      : status.daysRemaining === 1 ? t('Renewal is due in 1 day.')
        : translateDays(t, 'Renewal is due in {days} days.', status.daysRemaining);
    return `<aside id="customer-expiry" class="usage-expiry usage-expiry--warning" aria-labelledby="customer-expiry-title"><div class="usage-expiry__heading"><div><p class="eyebrow">${escapeHtml(t('Service expiry'))}</p><h3 id="customer-expiry-title">${escapeHtml(t('Expiry warning'))}</h3></div><span class="status-pill usage-expiry__badge usage-expiry__badge--warning">${escapeHtml(t('Expiry warning'))}</span></div><p role="alert">${escapeHtml(message)}</p>${dateLine}</aside>`;
  }

  const upcomingMessage = status.daysRemaining === 1
    ? t('Renewal in 1 day')
    : translateDays(t, 'Renewal in {days} days', status.daysRemaining);
  return `<aside id="customer-expiry" class="usage-expiry usage-expiry--upcoming" aria-labelledby="customer-expiry-title"><div class="usage-expiry__heading"><div><p class="eyebrow">${escapeHtml(t('Service expiry'))}</p><h3 id="customer-expiry-title">${escapeHtml(t('Upcoming renewal'))}</h3></div><span class="status-pill usage-expiry__badge usage-expiry__badge--upcoming">${escapeHtml(t('Upcoming renewal'))}</span></div><p>${escapeHtml(upcomingMessage)}</p>${dateLine}</aside>`;
}

function renderUsageState(message, className = '') {
  return `<div class="usage-state ${className}" role="status"><p>${escapeHtml(message)}</p></div>`;
}

function formatPercent(value, locale) {
  return new Intl.NumberFormat(formatLocale(locale), { maximumFractionDigits: 1 }).format(value);
}

function renderSnapshot(snapshot, { t, locale, now }) {
  const summary = summarizeCustomerUsage(snapshot);
  if (!summary) return renderUsageState(t('Usage values could not be read. Contact your service provider.'), 'usage-state--error');

  const online = snapshot.is_online === true;
  const offline = snapshot.is_online === false;
  const connectionLabel = online ? t('Online') : offline ? t('Offline') : t('Status unavailable');
  const connectionClass = online ? 'usage-status--online' : offline ? 'usage-status--offline' : 'usage-status--unknown';
  const freshness = getUsageFreshness(snapshot.last_synced_at, now);
  const localeForDates = formatLocale(locale);
  const localeDate = freshness.date
    ? new Intl.DateTimeFormat(localeForDates, { dateStyle: 'medium', timeStyle: 'short' }).format(freshness.date)
    : '';
  const relativeTime = freshness.date ? formatRelativeUsageSync(snapshot.last_synced_at, now, locale) : '';

  let quotaContent;
  if (summary.unlimited) {
    quotaContent = `<div class="usage-quota__facts"><div><span>${escapeHtml(t('Quota'))}</span><strong>${escapeHtml(t('Unlimited Package'))}</strong></div><div><span>${escapeHtml(t('Remaining'))}</span><strong>${escapeHtml(t('Unlimited'))}</strong></div></div><p class="usage-note">${escapeHtml(t('A quota of 0 bytes means unlimited usage.'))}</p>`;
  } else {
    const visualPercent = Math.max(0, Math.min(100, summary.consumedPercent));
    const consumed = formatUsageBytes(summary.totalUsedBytes, locale);
    const quota = formatUsageBytes(summary.quotaBytes, locale);
    const remaining = formatUsageBytes(summary.remainingBytes, locale);
    const consumedPercent = formatPercent(summary.consumedPercent, locale);
    const remainingPercent = formatPercent(summary.remainingPercent, locale);
    quotaContent = `<div class="usage-quota__facts"><div><span>${escapeHtml(t('Consumed / total quota'))}</span><strong>${escapeHtml(consumed)} / ${escapeHtml(quota)}</strong></div><div><span>${escapeHtml(t('Remaining'))}</span><strong>${escapeHtml(remaining)}</strong></div></div>
      <div class="usage-progress usage-progress--${summary.quotaTone}" role="progressbar" aria-label="${escapeHtml(t('Quota consumed'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${visualPercent}" aria-valuetext="${consumedPercent}% ${escapeHtml(t('consumed'))}; ${remainingPercent}% ${escapeHtml(t('remaining'))}"><span style="width:${visualPercent}%"></span></div>
      <p class="usage-note">${consumedPercent}% ${escapeHtml(t('consumed'))} · ${remainingPercent}% ${escapeHtml(t('remaining'))} · ${escapeHtml(remaining)} ${escapeHtml(t('available'))}</p>
      ${summary.overQuotaBytes > 0n ? `<p class="usage-over-quota">${escapeHtml(t('Usage is over quota by'))} ${escapeHtml(formatUsageBytes(summary.overQuotaBytes, locale))}.</p>` : ''}`;
  }

  const freshnessContent = freshness.state === 'unknown'
    ? `<p class="usage-sync usage-sync--unknown">${escapeHtml(t('Sync time is not available.'))}</p>`
    : `<p class="usage-sync ${freshness.state === 'stale' ? 'usage-sync--stale' : ''}"><span>${escapeHtml(t('Last synced'))}:</span> <strong>${escapeHtml(relativeTime)}</strong> · <time datetime="${escapeHtml(snapshot.last_synced_at)}">${escapeHtml(localeDate)}</time></p>${freshness.state === 'stale' ? `<p class="usage-stale-note" role="status">${escapeHtml(t('This usage snapshot is over 24 hours old; data may be delayed.'))}</p>` : ''}`;

  return `<div class="usage-snapshot">
    <div class="usage-snapshot__heading"><span class="usage-status ${connectionClass}"><span class="usage-status__dot" aria-hidden="true"></span>${escapeHtml(connectionLabel)}</span><span class="usage-snapshot__label">${escapeHtml(t('Latest cumulative snapshot'))}</span></div>
    <div class="usage-metrics">
      <article class="usage-metric"><span>${escapeHtml(t('Download'))}</span><strong>${escapeHtml(formatUsageBytes(summary.downloadBytes, locale))}</strong></article>
      <article class="usage-metric"><span>${escapeHtml(t('Upload'))}</span><strong>${escapeHtml(formatUsageBytes(summary.uploadBytes, locale))}</strong></article>
      <article class="usage-metric usage-metric--total"><span>${escapeHtml(t('Total used'))}</span><strong>${escapeHtml(formatUsageBytes(summary.totalUsedBytes, locale))}</strong></article>
    </div>
    <p class="usage-note">${escapeHtml(t('Total used is the sum of download and upload.'))}</p>
    <section class="usage-quota" aria-label="${escapeHtml(t('Quota and remaining usage'))}">${quotaContent}</section>
    <div class="usage-footer">${freshnessContent}<p class="usage-note">${escapeHtml(t('Cumulative counters only; no billing-period or calendar-month usage history is available.'))}</p></div>
  </div>`;
}

function renderCustomerFupQuota({ quotaPackage, currentMonthUsageBytes = null, monthlyUsageSource = 'routeros-poller', t, locale }) {
  if (quotaPackage?.quota_type !== 'fup_capped') return '';
  const quotaLimitGb = Number(quotaPackage.quota_limit_gb);
  if (!Number.isSafeInteger(quotaLimitGb) || quotaLimitGb <= 0) {
    return `<section class="usage-fup" aria-labelledby="customer-fup-title"><div class="usage-fup__heading"><div><p class="eyebrow">${escapeHtml(t('Fair usage policy'))}</p><h3 id="customer-fup-title">${escapeHtml(t('FUP quota'))}</h3></div></div><p class="usage-state usage-state--error" role="status">${escapeHtml(t('The package quota limit is not available. Ask your service provider to review this package.'))}</p></section>`;
  }

  const quotaBytes = BigInt(quotaLimitGb) * (BYTE_BASE ** 3n);
  const usedBytes = currentMonthUsageBytes === null || currentMonthUsageBytes === undefined
    ? null
    : parseNonNegativeBytes(currentMonthUsageBytes);
  if (usedBytes === null) {
    return `<section class="usage-fup" aria-labelledby="customer-fup-title"><div class="usage-fup__heading"><div><p class="eyebrow">${escapeHtml(t('Fair usage policy'))}</p><h3 id="customer-fup-title">${escapeHtml(t('FUP quota'))}</h3></div><strong>${escapeHtml(String(quotaLimitGb))} GB ${escapeHtml(t('total'))}</strong></div><p class="usage-state usage-state--empty" role="status">${escapeHtml(t('Monthly usage is unavailable. No quota percentage is shown until a trusted monthly traffic source is configured.'))}</p></section>`;
  }

  const remainingBytes = quotaBytes > usedBytes ? quotaBytes - usedBytes : 0n;
  const consumedPercent = percentageToOneDecimal(usedBytes, quotaBytes) ?? 0;
  const remainingPercent = percentageToOneDecimal(remainingBytes, quotaBytes) ?? 0;
  const visualPercent = Math.max(0, Math.min(100, consumedPercent));
  const quotaTone = usedBytes * 100n < quotaBytes * 75n ? 'good'
    : usedBytes * 100n <= quotaBytes * 90n ? 'warning' : 'critical';
  const usageLine = `${t('Used:')} ${formatUsageGigabytes(usedBytes, locale)} / ${t('Total:')} ${quotaLimitGb} GB (${formatUsageGigabytes(remainingBytes, locale)} ${t('Remaining')})`;
  const demoNote = monthlyUsageSource === 'demo'
    ? `<p class="usage-note">${escapeHtml(t('Demo usage sample — not live RouterOS.'))}</p>`
    : '';
  const advisory = usedBytes >= quotaBytes
    ? `<aside class="usage-fup__warning" role="status"><span class="status-pill status-pill--unpaid">${escapeHtml(t('Quota exceeded'))}</span><p>${escapeHtml(t('This is an advisory warning only. No automatic throttling, suspension, or disconnect is performed.'))}</p></aside>`
    : '';
  return `<section class="usage-fup" aria-labelledby="customer-fup-title"><div class="usage-fup__heading"><div><p class="eyebrow">${escapeHtml(t('Fair usage policy'))}</p><h3 id="customer-fup-title">${escapeHtml(t('FUP quota'))}</h3></div><span>${escapeHtml(String(quotaLimitGb))} GB ${escapeHtml(t('total'))}</span></div><p class="usage-fup__summary">${escapeHtml(usageLine)}</p><div class="usage-progress usage-progress--${quotaTone}" role="progressbar" aria-label="${escapeHtml(t('Monthly FUP quota consumed'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${visualPercent}" aria-valuetext="${escapeHtml(formatPercent(consumedPercent, locale))}% ${escapeHtml(t('consumed'))}; ${escapeHtml(formatPercent(remainingPercent, locale))}% ${escapeHtml(t('remaining'))}"><span style="width:${visualPercent}%"></span></div>${advisory}<p class="usage-note">${escapeHtml(t('Quota usage is based on the configured monthly traffic source.'))}</p>${demoNote}</section>`;
}

function renderCustomerTrafficSummary({ customer, currentMonthUsageBytes = null, monthlyUsageSource = 'routeros-poller', currentMonthBillStatus = 'unavailable', currentMonthLabel = '', monthlyFeeLabel = '', currentMonthBillAmountLabel = '', currentMonthBillDueLabel = '', t, locale }) {
  const parsedMonthBytes = currentMonthUsageBytes === null || currentMonthUsageBytes === undefined
    ? null
    : parseNonNegativeBytes(currentMonthUsageBytes);
  const monthUsage = parsedMonthBytes === null
    ? t('Unavailable')
    : `${new Intl.NumberFormat(formatLocale(locale), { maximumFractionDigits: 2 }).format(Number(parsedMonthBytes) / 1_000_000_000)} GB`;
  const billStatusKeys = {
    paid: 'Paid',
    partial: 'Partially paid',
    unpaid: 'Unpaid',
    'not-priced': 'Price not recorded',
    'not-issued': 'No bill issued',
  };
  const billStatusLabel = t(billStatusKeys[currentMonthBillStatus] ?? 'Status unavailable');
  const billStatusClass = ['paid', 'partial', 'unpaid'].includes(currentMonthBillStatus) ? currentMonthBillStatus : 'unknown';
  const billingMonth = currentMonthLabel || t('Current month');
  const liveTrafficPanel = customer?.pppoe_username
    ? `<section class="live-traffic" aria-labelledby="customer-live-traffic-title">
        <div class="live-traffic__heading"><div><p class="eyebrow">${escapeHtml(t('Customer live traffic'))}</p><h3 id="customer-live-traffic-title">${escapeHtml(t('Real-time internet speed'))}</h3></div><span id="customer-live-traffic-status" class="live-traffic__status" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(t('Telemetry Pending'))}</span></div>
        <div class="live-traffic__rates"><article><span>${escapeHtml(t('Download'))}</span><strong id="customer-live-download">—</strong></article><article><span>${escapeHtml(t('Upload'))}</span><strong id="customer-live-upload">—</strong></article></div>
        <canvas id="customer-live-traffic-graph" width="720" height="220" role="img" aria-label="${escapeHtml(t('Live download and upload speed graph'))}">${escapeHtml(t('Live speed graph requires a browser with Canvas support.'))}</canvas>
        <p class="usage-note">${escapeHtml(t('The signed-in PPPoE interface is sampled every 2 seconds when server limits allow it. On the router interface, TX is customer download and RX is customer upload.'))}</p>
      </section>`
    : `<div class="usage-state usage-state--empty" role="status"><p>${escapeHtml(t('Live speed is unavailable until a PPPoE username is linked to this customer.'))}</p></div>`;

  return `<div class="usage-month-summary" aria-label="${escapeHtml(t('Current month usage and bill status'))}">
    <article class="usage-metric usage-metric--total"><span>${escapeHtml(t('Current month consumed'))} · ${escapeHtml(billingMonth)}</span><strong id="customer-current-month-consumed">${escapeHtml(monthUsage)}</strong><small>${escapeHtml(parsedMonthBytes === null ? t('No trusted calendar-month traffic source is configured; cumulative counters are not a monthly total.') : monthlyUsageSource === 'demo' ? t('Demo sample traffic · not live RouterOS.') : t('Month-to-date data from the configured usage source.'))}</small></article>
    <article class="usage-metric"><span>${escapeHtml(t('Current month bill'))} · ${escapeHtml(billingMonth)}</span><strong id="customer-current-month-bill-status"><span class="status-pill status-pill--${billStatusClass}">${escapeHtml(billStatusLabel)}</span></strong><small>${escapeHtml(t('Bill amount'))}: ${escapeHtml(currentMonthBillAmountLabel || t('Not recorded'))} · ${escapeHtml(t('Due'))}: ${escapeHtml(currentMonthBillDueLabel || t('Not recorded'))}</small></article>
    <article class="usage-metric"><span>${escapeHtml(t('Fixed monthly bill'))}</span><strong id="customer-fixed-monthly-bill">${escapeHtml(monthlyFeeLabel || t('Not recorded'))}</strong></article>
  </div>${liveTrafficPanel}`;
}

export function renderCustomerUsageDashboard({ customer, usageRows = [], error = false, expiryDate = null, now = new Date(), t = (value) => value, locale = 'en-PK', currentMonthUsageBytes = null, monthlyUsageSource = 'routeros-poller', currentMonthBillStatus = 'unavailable', currentMonthLabel = '', monthlyFeeLabel = '', currentMonthBillAmountLabel = '', currentMonthBillDueLabel = '', quotaPackage = null } = {}) {
  let content;
  if (error) {
    content = renderUsageState(t('Usage data could not be loaded. Other account sections are still available.'), 'usage-state--error');
  } else if (!customer?.pppoe_username) {
    content = renderUsageState(t('Usage reporting is not linked to this customer profile yet.'), 'usage-state--empty');
  } else {
    const snapshot = usageRows.find((row) => row?.username === customer.pppoe_username);
    content = snapshot
      ? renderSnapshot(snapshot, { t, locale, now })
      : monthlyUsageSource === 'demo' && currentMonthUsageBytes !== null
        ? ''
      : renderUsageState(t('No usage snapshot is available yet. Check again after usage reporting is configured.'), 'usage-state--empty');
  }

  return `<section id="customer-usage" class="panel data-panel usage-panel" aria-labelledby="customer-usage-title">
    <div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Customer usage'))}</p><h2 id="customer-usage-title">${escapeHtml(t('Usage dashboard'))}</h2></div></div>
    ${content}
    ${renderCustomerFupQuota({ quotaPackage, currentMonthUsageBytes, monthlyUsageSource, t, locale })}
    ${renderCustomerTrafficSummary({ customer, currentMonthUsageBytes, monthlyUsageSource, currentMonthBillStatus, currentMonthLabel, monthlyFeeLabel, currentMonthBillAmountLabel, currentMonthBillDueLabel, t, locale })}
    ${renderServiceExpiryNotice({ expiryDate, now, t, locale })}
  </section>`;
}

export function renderCustomerUsageSkeleton() {
  const skeletonCard = `<div class="usage-skeleton__card"><span></span><span></span><span></span></div>`;
  return `<section class="panel data-panel usage-panel usage-skeleton" aria-hidden="true"><div class="usage-skeleton__heading"><span></span><span></span></div><div class="usage-skeleton__grid">${skeletonCard}${skeletonCard}${skeletonCard}</div><div class="usage-skeleton__quota"><span></span><span></span></div><div class="usage-expiry usage-skeleton__expiry"><span></span><span></span></div></section>`;
}
