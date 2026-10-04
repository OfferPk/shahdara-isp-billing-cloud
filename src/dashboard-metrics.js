import { formatMoney } from './ledger.js';
import { createDashboardDrilldown } from './dashboard-drilldown.js';

const icons = {
  billed: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 3.5h7l4 4V20H7z"/><path d="M14 3.5v4h4M10 12h5M10 16h5"/></svg>',
  cash: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 10h.01M17.5 14h.01"/></svg>',
  outstanding: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/></svg>',
  overdue: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2M6 4l-2 2"/></svg>',
  unpriced: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 3.5h7l4 4V20H7z"/><path d="M14 3.5v4h4M10 13h5M10 16h3"/></svg>',
  missingBill: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="9" cy="8" r="3"/><path d="M3.5 19v-1.5A3.5 3.5 0 0 1 7 14h4a3.5 3.5 0 0 1 3.5 3.5V19M17 8h4M19 6v4"/></svg>',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function comparisonText(current, previous, t) {
  if (current === null || current === undefined || previous === null || previous === undefined) return '';
  if (!Number.isFinite(Number(current)) || !Number.isFinite(Number(previous))) return '';
  const currentValue = Number(current);
  const previousValue = Number(previous);
  const difference = currentValue - previousValue;
  if (difference === 0) return t('No change vs previous month');
  if (previousValue === 0) {
    return t('No prior-month amount; current amount is {amount}')
      .replace('{amount}', formatMoney(currentValue));
  }
  const percentage = Math.round(Math.abs((difference / previousValue) * 100) * 10) / 10;
  const signed = `${difference > 0 ? '+' : '−'}${Number.isInteger(percentage) ? percentage : percentage.toFixed(1)}`;
  return t('{change}% vs previous month').replace('{change}', signed);
}

function renderMetricSparkline(points, valueKey, label, t) {
  if (!Array.isArray(points) || points.length < 2) return '';
  const values = points.map((point) => Number(point[valueKey]));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return '';
  if (!values.some((value) => value > 0)) return '';
  const maximum = Math.max(...values, 1);
  const coordinates = values.map((value, index) => {
    const x = 2 + (index * 72) / (values.length - 1);
    const y = 21 - (value / maximum) * 16;
    return { x, y };
  });
  const polyline = coordinates.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const ariaLabel = t('Trend for {metric} across {count} recorded months')
    .replace('{metric}', label)
    .replace('{count}', String(points.length));
  const markers = coordinates.map(({ x, y }, index) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2"><title>${escapeHtml(points[index].fullLabel)} · ${escapeHtml(label)}: ${escapeHtml(formatMoney(values[index]))}</title></circle>`).join('');
  return `<svg class="metric__sparkline" viewBox="0 0 76 24" role="img" aria-label="${escapeHtml(ariaLabel)}" focusable="false"><polyline points="${polyline}"/>${markers}</svg>`;
}

function renderMetric({ tone, label, icon, value, detail, drilldown, comparison, trendPoints, trendKey, trendLabel, t }) {
  const element = drilldown ? 'a' : 'article';
  const attributes = drilldown
    ? ` href="${escapeHtml(drilldown.hash)}" aria-label="${escapeHtml(drilldown.accessibleLabel)}" data-dashboard-drilldown="${escapeHtml(drilldown.card)}"`
    : '';
  const sparkline = trendKey ? renderMetricSparkline(trendPoints, trendKey, t(trendLabel), t) : '';
  return `<${element} class="metric metric--${tone}${drilldown ? ' metric--interactive' : ''}"${attributes}>
    <div class="metric__top"><h2 class="metric__label">${escapeHtml(label)}</h2><span class="metric__icon" aria-hidden="true">${icons[icon]}</span></div>
    <strong>${escapeHtml(value)}</strong>
    <small>${escapeHtml(detail)}</small>
    ${comparison ? `<small class="metric__comparison">${escapeHtml(comparison)}</small>` : ''}
    ${sparkline}
    ${drilldown ? `<span class="metric__action">${escapeHtml(drilldown.actionLabel)}</span>` : ''}
  </${element}>`;
}

export function renderDashboardMetrics({ month, today, totals, previousTotals = null, trendSeries = null, t = (value) => value }) {
  const pricedBillCount = totals.pricedBillCount ?? totals.monthBills.length;
  const receiptDetailKey = totals.receiptCount === 1
    ? 'actual receipt by received date; no credit'
    : 'actual receipts by received date; no credit';
  const pricedBillWord = pricedBillCount === 1 ? 'priced bill' : 'priced bills';
  const overdueAccountWord = totals.overdueAccountCount === 1 ? 'distinct account' : 'distinct accounts';
  const unpricedDetailKey = totals.unpricedBillCount === 1
    ? 'unpriced bill snapshot excluded from billed amount'
    : 'unpriced bill snapshots excluded from billed amount';
  const makeDrilldown = (card, actionLabel, accessibleLabel) => {
    const route = createDashboardDrilldown(card, month);
    return route ? { ...route, actionLabel: t(actionLabel), accessibleLabel } : null;
  };
  const trendPoints = trendSeries?.month === month && trendSeries?.view === 'month' ? trendSeries.points : [];
  const metrics = [
    {
      tone: 'billed',
      label: `${t('Total Billed')} · ${month}`,
      icon: 'billed',
      value: formatMoney(totals.billedCents),
      detail: `${pricedBillCount} ${t(pricedBillWord)}; ${totals.unpricedBillCount ?? 0} ${t(unpricedDetailKey)}`,
      comparison: previousTotals ? comparisonText(totals.billedCents, previousTotals.billedCents, t) : '',
      trendPoints,
      trendKey: 'billedCents',
      trendLabel: 'Billed trend',
      drilldown: makeDrilldown('billed', 'View all bills', `${t('Total Billed')}, ${formatMoney(totals.billedCents)}, ${t('for bill period')} ${month}. ${t('View all bills for')} ${month}.`),
    },
    {
      tone: 'cash',
      label: `${t('Collected')} · ${month}`,
      icon: 'cash',
      value: formatMoney(totals.cashReceivedCents),
      detail: `${totals.receiptCount} ${t(receiptDetailKey)}`,
      comparison: previousTotals ? comparisonText(totals.cashReceivedCents, previousTotals.cashReceivedCents, t) : '',
      trendPoints,
      trendKey: 'collectedCents',
      trendLabel: 'Collection trend',
      drilldown: makeDrilldown('collected', 'View receipts', `${t('Collected')}, ${formatMoney(totals.cashReceivedCents)}. ${t('View receipts received in')} ${month}.`),
    },
    {
      tone: 'outstanding',
      label: `${t('Pending')} · ${month}`,
      icon: 'outstanding',
      value: formatMoney(totals.outstandingCents),
      detail: `${t('Outstanding on')} ${month} ${t('bills')}; ${formatMoney(totals.creditAppliedCents)} ${t('credit applied separately')}`,
      comparison: previousTotals ? comparisonText(totals.outstandingCents, previousTotals.outstandingCents, t) : '',
      trendPoints,
      trendKey: 'pendingCents',
      trendLabel: 'Pending-balance trend',
      drilldown: makeDrilldown('unpaid', 'View unpaid bills', `${t('Pending')}, ${formatMoney(totals.outstandingCents)}, ${t('for bill period')} ${month}. ${t('View unpaid bills for')} ${month}.`),
    },
    {
      tone: 'overdue',
      label: `${t('Overdue outstanding balance')} · ${month} · ${t('as of local date')} ${today}`,
      icon: 'overdue',
      value: formatMoney(totals.overdueCents),
      detail: `${totals.overdueAccountCount} ${t(overdueAccountWord)}; ${t('selected bill period; priced bills with a positive balance and a saved due date before today; missing due dates are excluded')}`,
      comparison: previousTotals ? comparisonText(totals.overdueCents, previousTotals.overdueCents, t) : '',
      drilldown: makeDrilldown('overdue', 'View overdue bills', `${t('Overdue outstanding balance')}, ${formatMoney(totals.overdueCents)}, ${t('for bill period')} ${month}. ${t('View overdue bills for')} ${month}.`),
    },
    {
      tone: 'unpriced',
      label: `${t('Unpriced bills')} · ${month}`,
      icon: 'unpriced',
      value: String(totals.unpricedBillCount),
      detail: t('Count only; no bill amount is recorded or treated as zero.'),
      drilldown: makeDrilldown('unpriced', 'View unpriced bills', `${t('Unpriced bills')} ${month}, ${totals.unpricedBillCount}. ${t('View unpriced bills for')} ${month}.`),
    },
    {
      tone: 'missing-bill',
      label: `${t('Active accounts without a bill snapshot')} · ${month}`,
      icon: 'missingBill',
      value: String(totals.missingActiveBillSnapshotCount),
      detail: t('Active customer accounts with no bill snapshot in this selected month; count only.'),
      drilldown: makeDrilldown('missing-snapshot', 'View matching active customers', `${t('Active accounts without a bill snapshot')} ${month}, ${totals.missingActiveBillSnapshotCount}. ${t('View active customers without a bill snapshot for')} ${month}.`),
    },
  ];

  return `<section id="admin-overview" class="metric-grid admin-metrics" data-feature-key="admin-overview" data-feature-default-expanded="true" aria-label="${escapeHtml(t('Dashboard billing and collection monitoring'))}">${metrics.map((metric) => renderMetric({ ...metric, t })).join('')}</section>`;
}
