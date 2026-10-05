import { localDateKey } from './cashflow.js';
import { createDashboardDrilldown } from './dashboard-drilldown.js';
import { addCents, buildDashboardTrendSeries, monthLabel, monthSequence, rowKey, safeCents, uniqueBy } from './dashboard-trend.js';

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function validMonth(value) {
  return MONTH_PATTERN.test(String(value ?? ''));
}

export function buildCollectionRate(totals = {}) {
  const billedCents = safeCents(totals.billedCents);
  const collectedCents = safeCents(totals.cashReceivedCents);
  if (billedCents === 0) return null;
  const percentage = (collectedCents / billedCents) * 100;
  if (!Number.isFinite(percentage)) return null;
  return {
    billedCents,
    collectedCents,
    outstandingCents: safeCents(totals.outstandingCents),
    percentage,
    visualPercentage: Math.min(100, Math.max(0, percentage)),
  };
}

export function buildBillingBreakdown(rows = [], month) {
  const uniqueRows = uniqueBy(rows, (row) => rowKey(row?.bill ?? row));
  const summary = {
    paid: { count: 0, balanceCents: 0 },
    pending: { count: 0, balanceCents: 0 },
    overdue: { count: 0, balanceCents: 0 },
    unpriced: { count: 0, balanceCents: 0 },
  };
  for (const row of uniqueRows) {
    if (row.period !== month) continue;
    let category = '';
    if (row.status === 'paid') category = 'paid';
    else if (row.status === 'not-priced') category = 'unpriced';
    else if (row.status === 'unpaid' && Number(row.balanceCents) > 0) category = row.isOverdue ? 'overdue' : 'pending';
    if (!category) continue;
    summary[category].count += 1;
    if (category === 'pending' || category === 'overdue') addCents(summary[category], 'balanceCents', row.balanceCents);
  }
  return summary;
}

export function summarizeDashboardCustomers({ customers = [], customerRows = [], month, overdueCustomerCount = 0 } = {}) {
  const uniqueCustomers = uniqueBy(customers, (customer) => customer.id);
  const active = uniqueCustomers.filter((customer) => !customer.archived && customer.service_status === 'active').length;
  const statusCounts = {
    active,
    offline: uniqueCustomers.filter((customer) => !customer.archived && customer.service_status === 'offline').length,
    'not-set': uniqueCustomers.filter((customer) => !customer.archived && !['active', 'offline'].includes(customer.service_status)).length,
    archived: uniqueCustomers.filter((customer) => customer.archived).length,
  };
  const newThisMonth = uniqueCustomers.filter((customer) => {
    const created = localDateKey(customer.created_at);
    return created && created.slice(0, 7) === month;
  }).length;
  const withBalance = uniqueBy(customerRows, (row) => row.customer?.id)
    .filter((row) => !row.customer?.archived && Number(row.billing?.balanceCents) > 0).length;
  return {
    total: uniqueCustomers.length,
    active,
    notActive: uniqueCustomers.length - active,
    offline: statusCounts.offline,
    notSet: statusCounts['not-set'],
    archived: statusCounts.archived,
    newThisMonth,
    withBalance,
    overdue: Number.isSafeInteger(Number(overdueCustomerCount)) && Number(overdueCustomerCount) >= 0 ? Number(overdueCustomerCount) : 0,
    statusCounts,
  };
}

export function buildCustomerGrowthSeries(customers = [], month) {
  if (!validMonth(month)) return [];
  const points = new Map(monthSequence(month).map((key) => [key, 0]));
  for (const customer of uniqueBy(customers, (row) => row.id)) {
    const created = localDateKey(customer.created_at);
    const period = created.slice(0, 7);
    if (points.has(period)) points.set(period, points.get(period) + 1);
  }
  return [...points.entries()]
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, label: monthLabel(key), count }));
}

function customerServiceStatusLabel(customer = {}) {
  if (customer.archived === true) return 'Archived';
  if (customer.service_status === 'active') return 'Active';
  if (customer.service_status === 'offline') return 'Offline';
  return 'Not set';
}

export function buildTopDebtors(customerRows = [], limit = 3) {
  return uniqueBy(customerRows, (row) => row.customer?.id)
    .filter((row) => !row.customer?.archived && Number.isSafeInteger(Number(row.billing?.balanceCents)) && Number(row.billing.balanceCents) > 0)
    .sort((left, right) => Number(right.billing.balanceCents) - Number(left.billing.balanceCents))
    .slice(0, Math.max(0, limit))
    .map((row) => ({
      customerId: row.customer.id,
      customerName: row.customer.name,
      packageName: row.bill?.plan_snapshot || row.customer.plan_name || '',
      serviceStatus: customerServiceStatusLabel(row.customer),
      balanceCents: Number(row.billing.balanceCents),
    }));
}

export function buildTopCollectors({ customers = [], receipts = [], month, limit = 3 } = {}) {
  if (!validMonth(month)) return [];
  const nameById = new Map(uniqueBy(customers, (row) => row.id).map((customer) => [customer.id, customer]));
  const totals = new Map();
  for (const receipt of uniqueBy(receipts, (row) => rowKey(row))) {
    if (localDateKey(receipt.received_on).slice(0, 7) !== month || !receipt.customer_id) continue;
    const existing = totals.get(receipt.customer_id) ?? { amountCents: 0, receiptCount: 0 };
    addCents(existing, 'amountCents', receipt.amount_cents);
    existing.receiptCount += 1;
    totals.set(receipt.customer_id, existing);
  }
  return [...totals.entries()]
    .map(([customerId, totalsForCustomer]) => ({
      customerId,
      customerName: nameById.get(customerId)?.name ?? '',
      packageName: nameById.get(customerId)?.plan_name ?? '',
      serviceStatus: customerServiceStatusLabel(nameById.get(customerId)),
      ...totalsForCustomer,
    }))
    .sort((left, right) => right.amountCents - left.amountCents || left.customerName.localeCompare(right.customerName, 'en-PK'))
    .slice(0, Math.max(0, limit));
}

export function buildRecentlyPaidCustomers({ customers = [], receipts = [], month, today, limit = 3 } = {}) {
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(0, limit) : 3;
  if (!validMonth(month) || safeLimit === 0) return [];
  const cutoffDate = /^\d{4}-\d{2}-\d{2}$/.test(String(today ?? '')) ? String(today) : '';
  const customerById = new Map(uniqueBy(customers, (row) => row.id).map((customer) => [customer.id, customer]));
  const ordered = uniqueBy(receipts, (row) => rowKey(row))
    .filter((receipt) => receipt.customer_id
      && customerById.has(receipt.customer_id)
      && localDateKey(receipt.received_on).slice(0, 7) === month
      && (!cutoffDate || localDateKey(receipt.received_on) <= cutoffDate)
      && Number.isSafeInteger(Number(receipt.amount_cents))
      && Number(receipt.amount_cents) > 0)
    .sort((left, right) => String(right.received_on).localeCompare(String(left.received_on))
      || String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')));
  const seenCustomers = new Set();
  const latest = [];
  for (const receipt of ordered) {
    if (seenCustomers.has(receipt.customer_id)) continue;
    seenCustomers.add(receipt.customer_id);
    const customer = customerById.get(receipt.customer_id);
    latest.push({
      customerId: customer.id,
      customerName: customer.name ?? '',
      packageName: customer.plan_name ?? '',
      serviceStatus: customerServiceStatusLabel(customer),
      receivedOn: localDateKey(receipt.received_on),
      amountCents: Number(receipt.amount_cents),
    });
    if (latest.length >= safeLimit) break;
  }
  return latest;
}

export function buildRecentActivity({ customers = [], bills = [], receipts = [], incidents = [], now = new Date(), limit = 6 } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  if (!Number.isFinite(nowMs)) return [];
  const nameById = new Map(uniqueBy(customers, (row) => row.id).map((customer) => [customer.id, customer.name]));
  const events = [];
  const addEvent = (key, atValue, title, detail) => {
    const at = new Date(atValue);
    if (!Number.isFinite(at.getTime()) || at.getTime() > nowMs) return;
    events.push({ key, at, title, detail });
  };

  for (const customer of uniqueBy(customers, (row) => row.id)) {
    if (customer.created_at) addEvent(`customer:${customer.id}`, customer.created_at, 'Customer record added', `#${customer.customer_number ?? ''} · ${customer.name ?? ''}`);
  }
  for (const bill of uniqueBy(bills, (row) => rowKey(row))) {
    if (!bill.created_at) continue;
    const detail = bill.amount_due_cents === null || bill.amount_due_cents === undefined
      ? `${String(bill.period ?? '').slice(0, 7)} · unpriced`
      : `${String(bill.period ?? '').slice(0, 7)} · ${bill.amount_due_cents}`;
    addEvent(`bill:${rowKey(bill)}`, bill.created_at, 'Bill snapshot created', `${nameById.get(bill.customer_id) ?? 'Customer'} · ${detail}`);
  }
  for (const receipt of uniqueBy(receipts, (row) => rowKey(row))) {
    if (!receipt.created_at) continue;
    addEvent(`receipt:${rowKey(receipt)}`, receipt.created_at, 'Receipt recorded', `${nameById.get(receipt.customer_id) ?? 'Customer'} · ${receipt.received_on ?? ''} · ${receipt.amount_cents ?? 0}`);
  }
  for (const incident of uniqueBy(incidents, (row) => rowKey(row))) {
    if (!incident.reported_at) continue;
    const customer = incident.customer_id ? nameById.get(incident.customer_id) : '';
    addEvent(`incident:${rowKey(incident)}`, incident.reported_at, 'Service incident reported', customer || 'Organization-wide service incident');
  }
  return events.sort((left, right) => right.at - left.at).slice(0, Math.max(0, limit));
}

function compactMoney(cents) {
  const numericCents = Number(cents);
  const amount = Number.isFinite(numericCents) && numericCents >= 0 ? numericCents / 100 : 0;
  if (amount >= 1_000_000) return `Rs ${new Intl.NumberFormat('en-PK', { notation: 'compact', maximumFractionDigits: 1 }).format(amount)}`;
  if (amount >= 100_000) return `Rs ${new Intl.NumberFormat('en-PK', { notation: 'compact', maximumFractionDigits: 1 }).format(amount)}`;
  return `Rs ${new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 }).format(amount)}`;
}

function chartCoordinate(pointIndex, pointCount) {
  const left = 66;
  const right = 620;
  return pointCount <= 1 ? (left + right) / 2 : left + ((right - left) * pointIndex) / (pointCount - 1);
}

function renderTrendChart(series, t, formatMoney) {
  if (!series.hasRecords) {
    return `<p class="dashboard-empty-state" role="status">${escapeHtml(t('No dated billing, receipt, or due-date records are available for this view.'))}</p>`;
  }
  if (series.view === 'month' && series.needsMoreMonths) {
    return `<p class="dashboard-empty-state" role="status">${escapeHtml(t('A monthly trend needs recorded bill or receipt data in at least two months.'))}</p>`;
  }
  if (!series.points.some((point) => point.billedCents || point.collectedCents || point.pendingCents)) {
    return `<p class="dashboard-empty-state" role="status">${escapeHtml(t('No priced bill, receipt, or outstanding balance amounts are available for this view.'))}</p>`;
  }

  const maxValue = Math.max(1, ...series.points.flatMap((point) => [point.billedCents, point.collectedCents, point.pendingCents]));
  const top = 20;
  const bottom = 177;
  const y = (value) => bottom - (Math.max(0, safeCents(value)) / maxValue) * (bottom - top);
  const grid = [0, .5, 1].map((fraction) => {
    const position = bottom - fraction * (bottom - top);
    return `<g><line class="dashboard-chart__grid" x1="62" x2="622" y1="${position.toFixed(1)}" y2="${position.toFixed(1)}"/><text class="dashboard-chart__axis" x="4" y="${(position + 4).toFixed(1)}">${escapeHtml(compactMoney(maxValue * fraction))}</text></g>`;
  }).join('');
  const seriesDefs = [
    { key: 'billedCents', className: 'billed', label: t('Billed') },
    { key: 'collectedCents', className: 'collected', label: t('Collected') },
    { key: 'pendingCents', className: 'pending', label: t('Pending') },
  ];
  const lines = seriesDefs.map((definition) => {
    const coordinates = series.points.map((point, index) => `${chartCoordinate(index, series.points.length).toFixed(1)},${y(point[definition.key]).toFixed(1)}`);
    const path = coordinates.length > 1 ? `M ${coordinates.join(' L ')}` : '';
    const line = path ? `<path class="dashboard-chart__line dashboard-chart__line--${definition.className}" d="${path}"/>` : '';
    const markers = series.points.map((point, index) => {
      const x = chartCoordinate(index, series.points.length);
      const pointY = y(point[definition.key]);
      return `<circle class="dashboard-chart__marker dashboard-chart__marker--${definition.className}" cx="${x.toFixed(1)}" cy="${pointY.toFixed(1)}" r="3.1"><title>${escapeHtml(point.fullLabel)} · ${escapeHtml(definition.label)}: ${escapeHtml(formatMoney(point[definition.key]))}</title></circle>`;
    }).join('');
    return `${line}${markers}`;
  }).join('');
  const labelIndexes = series.view === 'day'
    ? new Set([0, Math.floor((series.points.length - 1) / 2), series.points.length - 1])
    : new Set(series.points.map((_point, index) => index));
  const labels = series.points.map((point, index) => labelIndexes.has(index)
    ? `<text class="dashboard-chart__axis dashboard-chart__x-label" x="${chartCoordinate(index, series.points.length).toFixed(1)}" y="205" text-anchor="middle">${escapeHtml(point.label)}</text>`
    : '').join('');
  const legend = seriesDefs.map((definition) => `<span><i class="dashboard-chart__swatch dashboard-chart__swatch--${definition.className}" aria-hidden="true"></i>${escapeHtml(definition.label)}</span>`).join('');
  const valueRows = series.points.map((point) => `<li><strong>${escapeHtml(point.fullLabel)}</strong><span>${escapeHtml(t('Billed'))}: ${escapeHtml(formatMoney(point.billedCents))}</span><span>${escapeHtml(t('Collected'))}: ${escapeHtml(formatMoney(point.collectedCents))}</span><span>${escapeHtml(t('Pending'))}: ${escapeHtml(formatMoney(point.pendingCents))}</span></li>`).join('');
  const chartDescription = series.view === 'month'
    ? t('Bills and pending balances follow bill periods; collected cash follows receipt dates. Pending is the current balance after allocations.')
    : series.view === 'week'
      ? `${t('Weekly points group calendar days 1–7, 8–14, and so on.')} ${t('Bills without recorded creation dates and pending balances without recorded due dates are omitted from date-based views.')}`
      : `${t('Daily points represent local calendar dates.')} ${t('Bills without recorded creation dates and pending balances without recorded due dates are omitted from date-based views.')}`;
  return `<div class="dashboard-chart-wrap" role="region" tabindex="0" aria-label="${escapeHtml(t('Billing and collection trend chart'))}"><svg class="dashboard-chart" viewBox="0 0 640 218" role="img" aria-label="${escapeHtml(t('Billing and collection trend'))}" preserveAspectRatio="xMidYMid meet"><title>${escapeHtml(t('Billing and collection trend'))}</title><desc>${escapeHtml(chartDescription)}</desc>${grid}${lines}${labels}</svg></div><p class="dashboard-chart-scroll-hint">${escapeHtml(t('On small screens, scroll the chart horizontally to view all data.'))}</p><div class="dashboard-chart__legend" aria-label="${escapeHtml(t('Chart legend'))}">${legend}</div><p class="dashboard-chart__basis">${escapeHtml(chartDescription)}</p><details class="dashboard-chart-values"><summary>${escapeHtml(t('View exact chart values'))}</summary><ul>${valueRows}</ul></details>`;
}

function renderCollectionPanel(totals, t, formatMoney) {
  const rate = buildCollectionRate(totals);
  const actualCollected = safeCents(totals.cashReceivedCents);
  const outstanding = safeCents(totals.outstandingCents);
  if (!rate) {
    return `<article class="dashboard-analytics-card dashboard-collection-card"><h3>${escapeHtml(t('Collection rate'))}</h3><p class="dashboard-empty-state" role="status">${escapeHtml(t('Collection rate is unavailable until the selected month has a priced bill.'))}</p><dl class="dashboard-rate-facts"><div><dt>${escapeHtml(t('Actual receipts'))}</dt><dd>${escapeHtml(formatMoney(actualCollected))}</dd></div><div><dt>${escapeHtml(t('Outstanding on selected-month bills'))}</dt><dd>${escapeHtml(formatMoney(outstanding))}</dd></div></dl></article>`;
  }
  const percent = Math.round(rate.percentage * 10) / 10;
  const label = Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(1)}%`;
  return `<article class="dashboard-analytics-card dashboard-collection-card"><h3>${escapeHtml(t('Collection rate'))}</h3><div class="dashboard-rate-content"><div class="dashboard-rate-ring" style="--rate-progress:${rate.visualPercentage}%" role="img" aria-label="${escapeHtml(t('Collection-to-billing ratio'))}: ${label}"><span>${label}</span></div><dl class="dashboard-rate-facts"><div><dt>${escapeHtml(t('Total billed'))}</dt><dd>${escapeHtml(formatMoney(rate.billedCents))}</dd></div><div><dt>${escapeHtml(t('Actual receipts'))}</dt><dd>${escapeHtml(formatMoney(rate.collectedCents))}</dd></div><div><dt>${escapeHtml(t('Outstanding on selected-month bills'))}</dt><dd>${escapeHtml(formatMoney(rate.outstandingCents))}</dd></div></dl></div><p class="dashboard-chart__basis">${escapeHtml(t('This month ratio divides actual receipts by bill-period billed amounts; payments may settle earlier or later. Outstanding is calculated separately after allocations.'))}</p>${rate.percentage > 100 ? `<p class="dashboard-chart__basis">${escapeHtml(t('The ring is capped at 100%; the displayed ratio can exceed it when receipts outpace this month’s bill-period total.'))}</p>` : ''}</article>`;
}

function renderBillingBreakdown(rows, month, t, formatMoney) {
  const summary = buildBillingBreakdown(rows, month);
  const items = [
    ['paid', 'Paid bills', 'dashboard-breakdown__item--paid'],
    ['pending', 'Pending (not overdue)', 'dashboard-breakdown__item--pending'],
    ['overdue', 'Overdue', 'dashboard-breakdown__item--overdue'],
    ['unpriced', 'Unpriced', 'dashboard-breakdown__item--unpriced'],
  ];
  const total = items.reduce((sum, [key]) => sum + summary[key].count, 0);
  if (!total) return `<article class="dashboard-analytics-card"><h3>${escapeHtml(t('Billing status'))}</h3><p class="dashboard-empty-state" role="status">${escapeHtml(t('No bill snapshots are recorded for the selected month.'))}</p></article>`;
  return `<article class="dashboard-analytics-card"><h3>${escapeHtml(t('Billing status'))}</h3><p class="dashboard-analytics-note">${escapeHtml(t('Counts use non-overlapping bill states for the selected bill period.'))}</p><div class="dashboard-breakdown-list">${items.map(([key, label, className]) => {
    const count = summary[key].count;
    const href = createDashboardDrilldown(key, month)?.hash ?? '#admin-bills';
    const width = Math.round((count / total) * 100);
    const amount = key === 'pending' || key === 'overdue' ? `<small>${escapeHtml(formatMoney(summary[key].balanceCents))}</small>` : '';
    return `<a class="dashboard-breakdown ${className}" href="${escapeHtml(href)}" data-dashboard-drilldown="${key}"><span class="dashboard-breakdown__label">${escapeHtml(t(label))}</span><strong>${count}</strong>${amount}<span class="dashboard-breakdown__track" aria-hidden="true"><i style="--bar-width:${width}%"></i></span></a>`;
  }).join('')}</div></article>`;
}

function renderCustomerGrowth(customers, month, t) {
  const series = buildCustomerGrowthSeries(customers, month);
  if (series.length < 2) return '';
  const max = Math.max(...series.map((point) => point.count), 1);
  return `<div class="dashboard-growth"><h4>${escapeHtml(t('Customer record additions by month'))}</h4><ol>${series.map((point) => `<li><span>${escapeHtml(point.label)}</span><i style="--bar-width:${Math.round((point.count / max) * 100)}%" aria-hidden="true"></i><strong>${point.count}</strong></li>`).join('')}</ol></div>`;
}

function renderCustomerPanel(summary, customers, month, t) {
  const categories = [
    ['active', 'Active'], ['offline', 'Offline'], ['not-set', 'Not set'], ['archived', 'Archived'],
  ];
  const statusList = categories.map(([key, label]) => {
    const count = summary.statusCounts[key];
    const percentage = summary.total ? Math.round((count / summary.total) * 100) : 0;
    return `<li><button class="dashboard-status-button dashboard-status-button--${key}" type="button" data-dashboard-service-status="${key}" aria-label="${escapeHtml(t('Filter customer directory by'))} ${escapeHtml(t(label))}"><span>${escapeHtml(t(label))}</span><strong>${count}</strong><i style="--bar-width:${percentage}%" aria-hidden="true"></i></button></li>`;
  }).join('');
  return `<article class="dashboard-analytics-card dashboard-customer-card"><h3>${escapeHtml(t('Customer overview'))}</h3><dl class="dashboard-customer-stats"><div><dt>${escapeHtml(t('Total customers'))}</dt><dd>${summary.total}</dd></div><div><dt>${escapeHtml(t('Customer records added this month'))}</dt><dd>${summary.newThisMonth}</dd></div><div><dt>${escapeHtml(t('Customers with balance'))}</dt><dd>${summary.withBalance}</dd></div><div><dt>${escapeHtml(t('Overdue customers'))}</dt><dd>${summary.overdue}</dd></div></dl><h4>${escapeHtml(t('Customer service status'))}</h4><ul class="dashboard-status-list">${statusList}</ul>${renderCustomerGrowth(customers, month, t)}<p class="dashboard-analytics-note">${escapeHtml(t('Status options reflect the current database model; archived accounts are shown separately.'))}</p><p class="dashboard-analytics-note">${escapeHtml(t('These counts use customer-record creation dates; service activation dates are not recorded.'))}</p></article>`;
}

function renderCustomerLeaders({ debtors, collectors, recentlyPaid, t, formatMoney }) {
  const list = (rows, kind) => {
    if (!rows.length) return `<p class="dashboard-empty-state" role="status">${escapeHtml(t(kind === 'debtors' ? 'No outstanding customer balances are recorded.' : 'No actual receipts are recorded for this month.'))}</p>`;
    return `<ol class="dashboard-leader-list">${rows.map((row) => {
      const value = kind === 'debtors' ? row.balanceCents : row.amountCents;
      const subtitle = row.packageName ? `${row.packageName} · ` : '';
      const detail = kind === 'debtors' ? `${subtitle}${t('Outstanding balance')}`
        : kind === 'collectors' ? `${subtitle}${row.receiptCount} ${t(row.receiptCount === 1 ? 'actual receipt' : 'actual receipts')}`
          : `${subtitle}${t('Most recent receipt')}: ${row.receivedOn}`;
      return `<li><button type="button" data-dashboard-customer-id="${escapeHtml(row.customerId)}" aria-label="${escapeHtml(t('Open customer profile for'))} ${escapeHtml(row.customerName)}"><span><strong>${escapeHtml(row.customerName || t('Customer'))}</strong><small>${escapeHtml(detail)}</small><small class="dashboard-leader-status">${escapeHtml(t(row.serviceStatus))}</small></span><b>${escapeHtml(formatMoney(value))}</b></button></li>`;
    }).join('')}</ol>`;
  };
  return `<article class="dashboard-analytics-card"><h3>${escapeHtml(t('Customer collections and balances'))}</h3><div class="dashboard-leader-columns"><section><h4>${escapeHtml(t('Largest recorded balances'))}</h4>${list(debtors, 'debtors')}</section><section><h4>${escapeHtml(t('Most collected this month'))}</h4>${list(collectors, 'collectors')}</section><section><h4>${escapeHtml(t('Recently paid customers'))}</h4>${list(recentlyPaid, 'recently-paid')}</section></div><p class="dashboard-analytics-note">${escapeHtml(t('Balances follow the customer directory’s recorded bill periods; collected amounts use actual receipt dates and exclude credit allocations.'))}</p></article>`;
}

function relativeTime(value, now, t) {
  const elapsed = Math.max(0, now.getTime() - value.getTime());
  if (elapsed < 60_000) return t('Just now');
  const units = [
    [86_400_000, 'day'], [3_600_000, 'hour'], [60_000, 'minute'],
  ];
  const [duration, unit] = units.find(([size]) => elapsed >= size) ?? units.at(-1);
  const count = Math.max(1, Math.floor(elapsed / duration));
  const key = count === 1 ? `{count} ${unit} ago` : `{count} ${unit}s ago`;
  return t(key).replace('{count}', String(count));
}

function renderActivity({ customers, bills, receipts, incidents, now, t, formatMoney }) {
  const events = buildRecentActivity({ customers, bills, receipts, incidents, now });
  if (!events.length) return `<article class="dashboard-analytics-card"><h3>${escapeHtml(t('Recent recorded activity'))}</h3><p class="dashboard-empty-state" role="status">${escapeHtml(t('No recent recorded activity is available.'))}</p></article>`;
  const absoluteDate = (date) => new Intl.DateTimeFormat('en-PK', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  const markup = events.map((event) => {
    const detail = event.title === 'Bill snapshot created'
      ? event.detail.replace(/ · (\d+)$/, (_match, amount) => ` · ${formatMoney(Number(amount))}`)
      : event.title === 'Receipt recorded'
        ? event.detail.replace(/ · (\d+)$/, (_match, amount) => ` · ${formatMoney(Number(amount))}`)
        : event.detail;
    return `<li><span class="dashboard-activity__dot" aria-hidden="true"></span><div><strong>${escapeHtml(t(event.title))}</strong><small>${escapeHtml(detail)}</small></div><time datetime="${event.at.toISOString()}" title="${escapeHtml(absoluteDate(event.at))}">${escapeHtml(relativeTime(event.at, now, t))}</time></li>`;
  }).join('');
  return `<article class="dashboard-analytics-card dashboard-activity-card"><h3>${escapeHtml(t('Recent recorded activity'))}</h3><ul class="dashboard-activity-list">${markup}</ul><p class="dashboard-analytics-note">${escapeHtml(t('Shows record creation dates available in the current data model; historical status-change events are not recorded.'))}</p></article>`;
}

export function renderDashboardAnalytics({
  month,
  today,
  now = new Date(),
  totals = {},
  customers = [],
  bills = [],
  receipts = [],
  allocations = [],
  billRows = [],
  customerRows = [],
  incidents = [],
  trendView = 'month',
  trendSeries = null,
  t = (value) => value,
  formatMoney = (value) => String(value),
} = {}) {
  const selectedView = ['month', 'week', 'day'].includes(trendView) ? trendView : 'month';
  const trend = trendSeries?.month === month && trendSeries?.view === selectedView
    ? trendSeries
    : buildDashboardTrendSeries({ month, today, bills, receipts, allocations, billRows, view: selectedView });
  const summary = summarizeDashboardCustomers({ customers, customerRows, month, overdueCustomerCount: totals.overdueAccountCount });
  const debtors = buildTopDebtors(customerRows);
  const collectors = buildTopCollectors({ customers, receipts, month });
  const recentlyPaid = buildRecentlyPaidCustomers({ customers, receipts, month, today });
  const viewButtons = [
    ['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'],
  ].map(([key, label]) => `<button class="dashboard-view-button ${selectedView === key ? 'is-active' : ''}" type="button" data-dashboard-trend-view="${key}" aria-pressed="${selectedView === key}">${escapeHtml(t(label))}</button>`).join('');
  const chartCard = `<article class="dashboard-analytics-card dashboard-trend-card"><div class="dashboard-analytics-card__heading"><div><h3>${escapeHtml(t('Billing vs collection trend'))}</h3><p>${escapeHtml(t('Actual records only; choose a time view.'))}</p></div><div class="dashboard-view-switch" role="group" aria-label="${escapeHtml(t('Trend time view'))}">${viewButtons}</div></div>${renderTrendChart(trend, t, formatMoney)}</article>`;
  return `<section id="admin-dashboard-analytics" class="panel data-panel dashboard-analytics" aria-labelledby="admin-dashboard-analytics-title"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Analytics'))}</p><h2 id="admin-dashboard-analytics-title">${escapeHtml(t('Billing and customer insights'))}</h2></div></div><div class="dashboard-analytics-grid">${chartCard}${renderCollectionPanel(totals, t, formatMoney)}${renderBillingBreakdown(billRows, month, t, formatMoney)}${renderCustomerPanel(summary, customers, month, t)}${renderCustomerLeaders({ debtors, collectors, recentlyPaid, t, formatMoney })}${renderActivity({ customers, bills, receipts, incidents, now: now instanceof Date ? now : new Date(now), t, formatMoney })}</div></section>`;
}
