import { formatMoney } from './ledger.js';

const icons = {
  customers: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M16 20v-1.4a3.6 3.6 0 0 0-3.6-3.6H7.6A3.6 3.6 0 0 0 4 18.6V20"/><circle cx="10" cy="8" r="3.2"/><path d="M16.5 4.9a3.2 3.2 0 0 1 0 6.2M20 20v-1.4a3.6 3.6 0 0 0-2.5-3.4"/></svg>',
  billed: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 3.5h7l4 4V20H7z"/><path d="M14 3.5v4h4M10 12h5M10 16h5"/></svg>',
  cash: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6.5 10h.01M17.5 14h.01"/></svg>',
  outstanding: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.2 2"/></svg>',
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

function renderMetric({ tone, label, icon, value, detail }) {
  return `<article class="metric metric--${tone}">
    <div class="metric__top"><h2 class="metric__label">${escapeHtml(label)}</h2><span class="metric__icon" aria-hidden="true">${icons[icon]}</span></div>
    <strong>${escapeHtml(value)}</strong>
    <small>${escapeHtml(detail)}</small>
  </article>`;
}

export function renderDashboardMetrics({ month, totals, t = (value) => value }) {
  const metrics = [
    { tone: 'billed', label: `${t('Total Billed')} · ${month}`, icon: 'billed', value: formatMoney(totals.billedCents), detail: `${totals.pricedBillCount ?? totals.monthBills.length} ${t('priced bills')}; ${totals.unpricedBillCount ?? 0} ${t('unpriced excluded')}` },
    { tone: 'cash', label: `${t('Collected')} · ${month}`, icon: 'cash', value: formatMoney(totals.cashReceivedCents), detail: `${totals.receiptCount} ${t('actual receipts by received date; no credit')}` },
    { tone: 'outstanding', label: `${t('Pending')} · ${month}`, icon: 'outstanding', value: formatMoney(totals.outstandingCents), detail: `${t('Outstanding on')} ${month} ${t('bills')}; ${formatMoney(totals.creditAppliedCents)} ${t('credit applied separately')}` },
  ];

  return `<section id="admin-overview" class="metric-grid admin-metrics" aria-label="${escapeHtml(t('Monthly billing summary'))}">${metrics.map(renderMetric).join('')}</section>`;
}
