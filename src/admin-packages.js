import { buildPackagePricingRows } from './billing-engine.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export { buildPackagePricingRows };

export function renderAdminPackageCards(rows, formatMoney, t = (value) => value, { disabled = false } = {}) {
  if (!rows.length) {
    return `<p class="package-list-empty" role="status">${escapeHtml(t('No router packages have been imported yet. Import subscribers from the router to discover their plans.'))}</p>`;
  }
  return `<div class="package-card-grid">${rows.map((row, index) => {
    const label = escapeHtml(row.name);
    const packageId = escapeHtml(row.packageId);
    const inputId = `package-fee-${index}`;
    const value = row.monthlyFeeCents == null ? '' : (Number(row.monthlyFeeCents) / 100).toFixed(2);
    const feeLabel = row.monthlyFeeCents == null ? t('Rate not set') : formatMoney(row.monthlyFeeCents);
    const canSave = Boolean(row.packageId) && !disabled;
    return `<article class="package-card"><div class="package-card__heading"><div><p class="eyebrow">${escapeHtml(t('Router package'))}</p><h3>${label}</h3></div><span class="status-pill ${row.monthlyFeeCents == null ? 'status-pill--not-priced' : 'status-pill--paid'}">${escapeHtml(feeLabel)}</span></div>
      <p class="muted">${escapeHtml(String(row.activeCustomerCount))} ${escapeHtml(t('active customers'))} · ${escapeHtml(String(row.customerCount))} ${escapeHtml(t('linked customers'))}</p>
      <form class="package-price-form" data-package-price-form data-package-id="${packageId}"><label for="${inputId}">${escapeHtml(t('Monthly rate (PKR)'))}<input id="${inputId}" name="monthly_fee" inputmode="decimal" autocomplete="off" value="${escapeHtml(value)}" placeholder="1800.00" required ${canSave ? '' : 'disabled'}></label><button class="button primary small" type="submit" ${canSave ? '' : 'disabled'}>${escapeHtml(t('Save rate'))}</button></form>
      ${!row.packageId ? `<p class="muted">${escapeHtml(t('This plan is not linked to an imported router package and cannot be priced here.'))}</p>` : ''}
      ${row.effectiveOn ? `<small class="package-card__effective">${escapeHtml(t('Effective from'))} ${escapeHtml(row.effectiveOn)}</small>` : ''}</article>`;
  }).join('')}</div>`;
}
