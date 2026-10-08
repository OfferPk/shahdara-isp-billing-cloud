import { buildPackagePricingRows } from './billing-engine.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export { buildPackagePricingRows };

export const DEFAULT_PACKAGE_PRESETS = Object.freeze([
  Object.freeze({ name: '3 Mbps / 100 GB', monthlyFeeCents: 100000, quotaType: 'fup_capped', quotaLimitGb: 100, actionOnExhaust: 'notify' }),
  Object.freeze({ name: '5 Mbps / 150 GB', monthlyFeeCents: 150000, quotaType: 'fup_capped', quotaLimitGb: 150, actionOnExhaust: 'notify' }),
  Object.freeze({ name: '5 Mbps / 200 GB', monthlyFeeCents: 200000, quotaType: 'fup_capped', quotaLimitGb: 200, actionOnExhaust: 'notify' }),
  Object.freeze({ name: '5 Mbps / 500 GB', monthlyFeeCents: 250000, quotaType: 'fup_capped', quotaLimitGb: 500, actionOnExhaust: 'notify' }),
  Object.freeze({ name: '15 Mbps / 2000 GB', monthlyFeeCents: 300000, quotaType: 'fup_capped', quotaLimitGb: 2000, actionOnExhaust: 'notify' }),
]);

function renderQuotaFields({ inputId, quotaType, quotaLimitGb, actionOnExhaust, disabled, t }) {
  const isCapped = quotaType === 'fup_capped';
  return `<div class="package-form__quota-fields" data-quota-fields ${isCapped ? '' : 'hidden'}>
    <label for="${inputId}-limit">${escapeHtml(t('Quota limit (GB)'))}<input id="${inputId}-limit" name="quota_limit_gb" type="number" min="1" max="1000000" step="1" inputmode="numeric" value="${escapeHtml(quotaLimitGb ?? '')}" ${isCapped ? 'required' : ''} ${disabled ? 'disabled' : ''}></label>
    <label for="${inputId}-action">${escapeHtml(t('Action on exhaustion'))}<select id="${inputId}-action" name="action_on_exhaust" ${disabled ? 'disabled' : ''}>
      <option value="notify" ${actionOnExhaust === 'notify' ? 'selected' : ''}>${escapeHtml(t('Notify'))}</option>
      <option value="throttle" ${actionOnExhaust === 'throttle' ? 'selected' : ''}>${escapeHtml(t('Throttle'))}</option>
      <option value="suspend" ${actionOnExhaust === 'suspend' ? 'selected' : ''}>${escapeHtml(t('Suspend'))}</option>
    </select></label>
  </div>`;
}

function renderPackageEditor(row, index, t, disabled = false, { create = false } = {}) {
  const packageId = String(row?.packageId ?? '');
  const inputId = `package-editor-${index}`;
  const quotaType = row?.quotaType === 'fup_capped' ? 'fup_capped' : 'unlimited';
  const actionOnExhaust = ['notify', 'throttle', 'suspend'].includes(row?.actionOnExhaust) ? row.actionOnExhaust : 'notify';
  const feeValue = row?.monthlyFeeCents == null ? '' : (Number(row.monthlyFeeCents) / 100).toFixed(2);
  const formDisabled = disabled || (!packageId && !create);
  return `<form ${create ? 'id="package-create-form"' : ''} class="package-editor-form" data-package-form data-package-id="${escapeHtml(packageId)}">
    <div class="package-editor-form__grid">
      <label for="${inputId}-name">${escapeHtml(t('Package name'))}<input id="${inputId}-name" name="package_name" maxlength="100" value="${escapeHtml(row?.name ?? '')}" required ${formDisabled ? 'disabled' : ''}></label>
      <label for="${inputId}-fee">${escapeHtml(t('Monthly rate (PKR)'))}<input id="${inputId}-fee" name="monthly_fee" inputmode="decimal" autocomplete="off" value="${escapeHtml(feeValue)}" placeholder="1800.00" required ${formDisabled ? 'disabled' : ''}></label>
      <label for="${inputId}-type">${escapeHtml(t('Quota type'))}<select id="${inputId}-type" name="quota_type" data-quota-type-select ${formDisabled ? 'disabled' : ''}>
        <option value="unlimited" ${quotaType === 'unlimited' ? 'selected' : ''}>${escapeHtml(t('Unlimited'))}</option>
        <option value="fup_capped" ${quotaType === 'fup_capped' ? 'selected' : ''}>${escapeHtml(t('FUP Capped'))}</option>
      </select></label>
      ${renderQuotaFields({ inputId, quotaType, quotaLimitGb: row?.quotaLimitGb, actionOnExhaust, disabled: formDisabled, t })}
    </div>
    <button class="button primary small" type="submit" ${formDisabled ? 'disabled' : ''}>${escapeHtml(t('Save package'))}</button>
  </form>`;
}

export function renderAdminPackageCreationForm(t = (value) => value, { disabled = false } = {}) {
  const inputId = 'package-create';
  const presets = DEFAULT_PACKAGE_PRESETS.map((preset, index) => `<button class="button secondary small" type="button" data-package-preset="${index}" ${disabled ? 'disabled' : ''}>${escapeHtml(preset.name)} · ${escapeHtml(t('Rs.'))} ${escapeHtml((preset.monthlyFeeCents / 100).toLocaleString('en-PK'))}</button>`).join('');
  const draft = { name: '', monthlyFeeCents: null, quotaType: 'unlimited', quotaLimitGb: null, actionOnExhaust: 'notify' };
  return `<section class="package-create" aria-labelledby="package-create-title">
    <div class="package-create__heading"><div><p class="eyebrow">${escapeHtml(t('Package management'))}</p><h3 id="package-create-title">${escapeHtml(t('Create package'))}</h3></div><a class="button primary small" href="#package-create-form">${escapeHtml(t('Add package'))}</a></div>
    <p class="muted">${escapeHtml(t('Starter plans are local presets only. Choose one to fill this form, then save it to this organization.'))}</p>
    ${disabled ? `<p class="package-create__disabled" role="note">${escapeHtml(t('The form is locked until the required package migration is installed. Starter presets are not saved until you submit this form.'))}</p>` : ''}
    <div class="package-presets" aria-label="${escapeHtml(t('Default package presets'))}">${presets}</div>
    ${renderPackageEditor(draft, 'new', t, disabled, { create: true }).replace('data-package-id=""', 'data-package-id="" data-package-create')}
    <p class="package-policy-note">${escapeHtml(t('Throttle and Suspend are saved as policy metadata only; no router-side action is applied.'))}</p>
  </section>`;
}

export function renderAdminPackageCards(rows, formatMoney, t = (value) => value, { disabled = false, quotaMetadataAvailable = true } = {}) {
  if (!rows.length) {
    return `<p class="package-list-empty" role="status">${escapeHtml(t('No saved packages yet. Use a starter preset above or create a package from scratch.'))}</p>`;
  }
  return `<div class="package-card-grid">${rows.map((row, index) => {
    const label = escapeHtml(row.name);
    const feeLabel = row.monthlyFeeCents == null ? t('Rate not set') : formatMoney(row.monthlyFeeCents);
    const canManage = Boolean(row.packageId) && quotaMetadataAvailable && !disabled;
    const quotaLabel = row.quotaType === 'fup_capped'
      ? `${t('FUP Capped')} · ${row.quotaLimitGb ?? '—'} GB`
      : t('Unlimited');
    const actionLabel = ({ notify: t('Notify'), throttle: t('Throttle'), suspend: t('Suspend') })[row.actionOnExhaust] ?? t('Notify');
    const legacyRateForm = `<form class="package-price-form" data-package-price-form data-package-id="${escapeHtml(row.packageId)}"><label for="package-fee-${index}">${escapeHtml(t('Monthly rate (PKR)'))}<input id="package-fee-${index}" name="monthly_fee" inputmode="decimal" autocomplete="off" value="${row.monthlyFeeCents == null ? '' : escapeHtml((Number(row.monthlyFeeCents) / 100).toFixed(2))}" placeholder="1800.00" required ${row.packageId && !disabled ? '' : 'disabled'}></label><button class="button primary small" type="submit" ${row.packageId && !disabled ? '' : 'disabled'}>${escapeHtml(t('Save rate'))}</button></form>`;
    return `<article class="package-card"><div class="package-card__heading"><div><p class="eyebrow">${escapeHtml(t('Service package'))}</p><h3>${label}</h3></div><span class="status-pill ${row.monthlyFeeCents == null ? 'status-pill--not-priced' : 'status-pill--paid'}">${escapeHtml(feeLabel)}</span></div>
      <p class="muted">${escapeHtml(String(row.activeCustomerCount))} ${escapeHtml(t('active customers'))} · ${escapeHtml(String(row.customerCount))} ${escapeHtml(t('linked customers'))}</p>
      ${quotaMetadataAvailable ? renderPackageEditor(row, index, t, !canManage) : legacyRateForm}
      <p class="package-card__policy">${escapeHtml(quotaLabel)} · ${escapeHtml(t('On exhaustion:'))} ${escapeHtml(actionLabel)}</p>
      ${!row.packageId ? `<p class="muted">${escapeHtml(t('This legacy plan is not linked to an editable service package.'))}</p>` : ''}
      ${row.effectiveOn ? `<small class="package-card__effective">${escapeHtml(t('Effective from'))} ${escapeHtml(row.effectiveOn)}</small>` : ''}</article>`;
  }).join('')}</div>`;
}
