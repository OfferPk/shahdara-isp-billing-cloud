import { localDateKey, summarizeCustomerMargin } from './cashflow.js';

const NO_AREA_VALUE = '__address_not_recorded__';

const normalizeText = (value) => String(value ?? '').trim().toLocaleLowerCase('en-PK');
const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '');
const periodOf = (bill) => String(bill?.period ?? '').slice(0, 7);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function customerBillState(bill, allocations) {
  if (!bill) return { status: 'no-bill', balanceCents: null, appliedCents: 0 };
  if (bill.amount_due_cents === null || bill.amount_due_cents === undefined
      || !Number.isFinite(Number(bill.amount_due_cents))) {
    return { status: 'not-set', balanceCents: null, appliedCents: 0 };
  }
  const appliedCents = allocations
    .filter((row) => row.bill_id === bill.id && row.customer_id === bill.customer_id)
    .reduce((total, row) => total + Number(row.amount_cents || 0), 0);
  const balanceCents = Math.max(0, Number(bill.amount_due_cents) - appliedCents);
  return {
    status: balanceCents === 0 ? 'paid' : 'unpaid',
    balanceCents,
    appliedCents,
  };
}

function billsForCustomerThroughMonth(customerId, bills, currentMonth) {
  return bills
    .filter((bill) => bill.customer_id === customerId && periodOf(bill) <= currentMonth)
    .sort((left, right) => String(left.period).localeCompare(String(right.period)));
}

function latestBillForCustomer(customerBills) {
  return customerBills.at(-1) ?? null;
}

function customerAccountBillingState(customerBills, allocations) {
  if (!customerBills.length) return { status: 'no-bill', balanceCents: null, appliedCents: 0 };
  const billStates = customerBills.map((bill) => customerBillState(bill, allocations));
  const pricedStates = billStates.filter((state) => state.balanceCents !== null);
  if (!pricedStates.length) return { status: 'not-set', balanceCents: null, appliedCents: 0 };

  const balanceCents = pricedStates.reduce((total, state) => total + state.balanceCents, 0);
  const appliedCents = pricedStates.reduce((total, state) => total + state.appliedCents, 0);
  const status = balanceCents > 0
    ? 'unpaid'
    : (customerBills.at(-1).amount_due_cents == null ? 'not-set' : 'paid');
  return { status, balanceCents, appliedCents };
}

/**
 * Build Admin-list rows from the current public profile and ledger rows. The
 * only private customer field consumed here is phone, supplied by the separate
 * Admin-only RLS-protected query. Location uses the saved service_address.
 */
export function buildCustomerListRows({
  customers = [],
  bills = [],
  allocations = [],
  privateDetails = [],
  currentMonth,
}) {
  const phoneByCustomer = new Map(privateDetails.map((row) => [row.customer_id, row.phone ?? '']));
  const connectionDateByCustomer = new Map(privateDetails.map((row) => [row.customer_id, row.connection_date ?? '']));
  return customers.map((customer) => {
    const customerBills = billsForCustomerThroughMonth(customer.id, bills, currentMonth);
    const bill = latestBillForCustomer(customerBills);
    const oldestOpenBill = customerBills.find((candidate) => customerBillState(candidate, allocations).balanceCents > 0) ?? null;
    return {
      customer,
      phone: phoneByCustomer.get(customer.id) ?? '',
      connectionDate: connectionDateByCustomer.get(customer.id) ?? '',
      area: String(customer.service_address ?? '').trim(),
      bill,
      dueBill: oldestOpenBill ?? bill,
      paymentBill: oldestOpenBill ?? bill,
      billing: customerAccountBillingState(customerBills, allocations),
    };
  });
}

export function getCustomerAreaOptions(rows) {
  const values = new Set(rows.map((row) => row.area).filter(Boolean));
  const options = [...values].sort((left, right) => left.localeCompare(right, 'en-PK'))
    .map((value) => ({ value, label: value }));
  if (rows.some((row) => !row.area)) options.push({ value: NO_AREA_VALUE, label: 'Address not recorded' });
  return options;
}

export function filterCustomerRows(rows, { search = '', status = 'all', area = '' } = {}) {
  const query = normalizeText(search);
  const queryDigits = digitsOnly(search);
  return rows.filter((row) => {
    if (status === 'paid' && row.billing.status !== 'paid') return false;
    if (status === 'unpaid' && row.billing.status !== 'unpaid') return false;
    if (area === NO_AREA_VALUE && row.area) return false;
    if (area && area !== NO_AREA_VALUE && row.area !== area) return false;
    if (!query) return true;
    const number = String(row.customer.customer_number ?? '');
    const textMatch = [row.customer.name, row.phone, number, `#${number}`]
      .some((value) => normalizeText(value).includes(query));
    const phoneMatch = queryDigits.length > 0 && digitsOnly(row.phone).includes(queryDigits);
    return textMatch || phoneMatch;
  });
}

export function filterCustomersWithoutBillSnapshot(rows, bills, period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period))) return [];
  const customersWithSnapshot = new Set(bills
    .filter((bill) => periodOf(bill) === period)
    .map((bill) => bill.customer_id)
    .filter(Boolean));
  const seen = new Set();
  return rows.filter(({ customer }) => {
    if (!customer?.id || seen.has(customer.id)) return false;
    seen.add(customer.id);
    return !customer.archived
      && customer.service_status === 'active'
      && !customersWithSnapshot.has(customer.id);
  });
}

export function summarizeCustomerRows(rows) {
  return {
    total: rows.length,
    active: rows.filter(({ customer }) => !customer.archived && customer.service_status === 'active').length,
    unpaid: rows.filter(({ customer, billing }) => !customer.archived && billing.status === 'unpaid').length,
  };
}

function billingStatusLabel(status, t = (value) => value) {
  if (status === 'paid') return t('Paid');
  if (status === 'unpaid') return t('Unpaid');
  if (status === 'not-set') return t('Not billed');
  return t('No bill yet');
}

export function customerDueLabel(bill, t = (value) => value) {
  if (!bill) return t('No bill yet');
  if (bill.due_date) return `${t('Due')} ${String(bill.due_date).slice(0, 10)}`;
  return `${t('Billing period')} ${periodOf(bill) || t('not recorded')}`;
}

function phoneLinks(phone) {
  const raw = String(phone ?? '').trim();
  const digits = digitsOnly(raw);
  let whatsappDigits = '';
  if (/^03\d{9}$/.test(digits)) whatsappDigits = `92${digits.slice(1)}`;
  else if (/^923\d{9}$/.test(digits)) whatsappDigits = digits;
  const telDigits = /^03\d{9}$/.test(digits) || /^923\d{9}$/.test(digits) ? raw.replace(/[^\d+]/g, '') : '';
  return { tel: telDigits ? `tel:${telDigits}` : '', whatsapp: whatsappDigits };
}

function tenureLabel(months, t) {
  if (months === null || months === undefined) return t('N/A — start date unknown');
  if (months === 0) return t('Less than one month');
  const years = Math.floor(months / 12);
  const remainder = months % 12;
  const pieces = [];
  if (years) pieces.push(`${years} ${t(years === 1 ? 'year' : 'years')}`);
  if (remainder) pieces.push(`${remainder} ${t(remainder === 1 ? 'month' : 'months')}`);
  return pieces.join(', ');
}

function localTimestamp(value, locale = 'en-PK') {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function renderCustomerCards(rows, formatMoney, t = (value) => value) {
  if (!rows.length) return `<p class="customer-list-empty" role="status">${escapeHtml(t('No customers match these filters.'))}</p>`;
  return rows.map(({ customer, phone, bill, dueBill, paymentBill, billing }) => {
    const id = escapeHtml(customer.id);
    const name = escapeHtml(customer.name);
    const accountNumber = escapeHtml(customer.customer_number);
    const serviceStatus = customer.archived ? t('Archived') : ({ active: t('Active'), offline: t('Offline'), 'not-set': t('Not set') }[customer.service_status] ?? customer.service_status ?? t('Not set'));
    const plan = bill?.plan_snapshot || customer.plan_name || t('Package not set');
    const balance = formatMoney(billing.balanceCents);
    const dueLabel = customerDueLabel(dueBill ?? bill, t);
    const statusLabel = billingStatusLabel(billing.status, t);
    const links = phoneLinks(phone);
    const hasUnpaidBill = billing.status === 'unpaid' && billing.balanceCents > 0 && Boolean(paymentBill);
    const oldestOpenPeriod = periodOf(dueBill ?? bill);
    const oldest = oldestOpenPeriod
      ? t(', with the oldest open bill from {period}').replace('{period}', oldestOpenPeriod)
      : '';
    const reminder = t('Assalam-o-Alaikum {name}, Shahdara Fiber Net reminder: account #{number} has an unpaid account balance of {balance}{oldest}. If you have already paid, please disregard this reminder and contact us to confirm.')
      .replace('{name}', customer.name)
      .replace('{number}', String(customer.customer_number))
      .replace('{balance}', balance)
      .replace('{oldest}', oldest);
    const whatsappHref = links.whatsapp && hasUnpaidBill
      ? `https://wa.me/${links.whatsapp}?text=${encodeURIComponent(reminder)}`
      : '';
    const whatsappUnavailableReason = !phone
      ? t('no Admin phone is recorded')
      : (!links.whatsapp ? t('the Admin phone is not a supported Pakistan mobile') : t('the account has no unpaid balance'));
    return `<article class="customer-card">
      <div class="customer-card__top"><button class="customer-card__open" type="button" data-action="open-customer-profile" data-customer-id="${id}" aria-label="${escapeHtml(t('Open profile and billing history for'))} ${name}, ${escapeHtml(t('account'))} ${accountNumber}"><span class="customer-card__name">${name}</span><span class="customer-card__account">${escapeHtml(t('Account'))} #${accountNumber}</span></button><span class="status-pill customer-card__service-status">${escapeHtml(serviceStatus)}</span></div>
      <div class="customer-card__badges"><span class="status-pill customer-card__billing-status customer-card__billing-status--${escapeHtml(billing.status)}">${escapeHtml(statusLabel)}</span><span class="customer-card__due">${escapeHtml(dueLabel)}</span></div>
      <dl class="customer-card__details"><div><dt class="customer-card__label">${escapeHtml(t('Balance'))}</dt><dd>${escapeHtml(balance)}</dd></div><div><dt class="customer-card__label">${escapeHtml(t('Package'))}</dt><dd>${escapeHtml(plan)}</dd></div></dl>
      <div class="customer-card__quick-actions" role="group" aria-label="${escapeHtml(t('Quick actions for'))} ${name}">
        ${links.tel
          ? `<a class="customer-action" href="${escapeHtml(links.tel)}" aria-label="${escapeHtml(t('Call'))} ${name}">${escapeHtml(t('Call'))}</a>`
          : `<button class="customer-action" type="button" disabled aria-label="${escapeHtml(t('Call unavailable; no Admin phone is recorded'))}">${escapeHtml(t('Call'))}</button>`}
        ${whatsappHref
          ? `<a class="customer-action customer-action--whatsapp" href="${escapeHtml(whatsappHref)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(t('Open a prefilled WhatsApp reminder for'))} ${name}">${escapeHtml(t('WhatsApp reminder'))}</a>`
          : `<button class="customer-action" type="button" disabled aria-label="${escapeHtml(t('WhatsApp reminder unavailable;'))} ${escapeHtml(whatsappUnavailableReason)}">${escapeHtml(t('WhatsApp reminder'))}</button>`}
        <button class="customer-action customer-action--paid" type="button" data-action="mark-as-paid" data-customer-id="${id}" aria-label="${escapeHtml(t('Mark as Paid: open the receipt form for'))} ${name}" title="${escapeHtml(t('Opens the real receipt form. Nothing is recorded until you review and submit it.'))}" ${hasUnpaidBill ? '' : 'disabled'}>${escapeHtml(t('Mark as Paid'))}</button>
      </div>
    </article>`;
  }).join('');
}

function billStatus(bill, allocations) {
  return customerBillState(bill, allocations).status;
}

export function renderCustomerProfile(row, {
  bills = [], receipts = [], allocations = [], customerServiceCosts = [], organizationId = '',
  formatMoney, t = (value) => value, portalTestModeAvailable = false, now = new Date(), locale = 'en-PK',
}) {
  const { customer, phone, area, billing } = row;
  const margin = summarizeCustomerMargin({
    customerId: customer.id,
    organizationId,
    receipts,
    costHistory: customerServiceCosts,
    connectionDate: row.connectionDate,
    createdAt: customer.created_at,
    now,
  });
  const name = escapeHtml(customer.name);
  const phoneMarkup = phoneLinks(phone).tel
    ? `<a href="${escapeHtml(phoneLinks(phone).tel)}">${escapeHtml(phone)}</a>`
    : `<span>${escapeHtml(t('Not recorded'))}</span>`;
  const billHistory = bills
    .filter((bill) => bill.customer_id === customer.id)
    .sort((left, right) => String(right.period).localeCompare(String(left.period)))
    .map((bill) => {
      const state = customerBillState(bill, allocations);
      const cash = receipts.filter((receipt) => receipt.origin_bill_id === bill.id && receipt.customer_id === customer.id)
        .reduce((total, receipt) => total + Number(receipt.amount_cents || 0), 0);
      const credit = allocations.filter((allocation) => allocation.bill_id === bill.id
          && allocation.customer_id === customer.id && allocation.allocation_kind === 'carry-forward')
        .reduce((total, allocation) => total + Number(allocation.amount_cents || 0), 0);
      const dueDate = bill.due_date ? String(bill.due_date).slice(0, 10) : '';
      return `<li><article class="record-card customer-history-card">
        <header class="record-card__top"><div><h4>${escapeHtml(periodOf(bill))}</h4>${dueDate ? `<p class="record-card__subtitle">${escapeHtml(t('Due'))} ${escapeHtml(dueDate)}</p>` : ''}</div><span class="status-pill status-pill--${escapeHtml(state.status)}">${escapeHtml(billingStatusLabel(state.status, t))}</span></header>
        <dl class="record-card__facts"><div><dt>${escapeHtml(t('Bill'))}</dt><dd>${escapeHtml(formatMoney(bill.amount_due_cents))}</dd></div><div><dt>${escapeHtml(t('Cash received'))}</dt><dd>${escapeHtml(formatMoney(cash))}</dd></div><div><dt>${escapeHtml(t('Credit applied'))}</dt><dd>${escapeHtml(formatMoney(credit))}</dd></div><div><dt>${escapeHtml(t('Balance'))}</dt><dd>${escapeHtml(formatMoney(state.balanceCents))}</dd></div></dl>
      </article></li>`;
    }).join('');
  const customerReceipts = receipts.filter((receipt) => receipt.customer_id === customer.id)
    .sort((left, right) => String(right.received_on).localeCompare(String(left.received_on)))
    .map((receipt) => `<li><article class="record-card customer-history-card">
      <header class="record-card__top"><div><h4><time datetime="${escapeHtml(receipt.received_on)}">${escapeHtml(receipt.received_on)}</time></h4></div></header>
      <dl class="record-card__facts"><div><dt>${escapeHtml(t('Method'))}</dt><dd>${escapeHtml(receipt.method || t('Method not recorded'))}</dd></div><div><dt>${escapeHtml(t('Amount'))}</dt><dd>${escapeHtml(formatMoney(receipt.amount_cents))}</dd></div></dl>
    </article></li>`)
    .join('');
  const statusLabel = billingStatusLabel(billing.status, t);
  const dueLabel = customerDueLabel(row.dueBill ?? row.bill, t);
  const packageLabel = row.bill?.plan_snapshot || customer.plan_name || t('Package not set');
  const startDateLabel = margin.serviceStartSource === 'service'
    ? t('Service start date')
    : (margin.serviceStartSource === 'created' ? t('Customer record created') : t('Start date not recorded'));
  const startDateValue = margin.serviceStartDate || t('N/A — start date unknown');
  const contributionValue = margin.estimatedContributionPaisa === null
    ? t('Unknown — add a start date and an effective monthly cost first.')
    : formatMoney(margin.estimatedContributionPaisa);
  const coverageValue = margin.estimatedContributionPaisa === null
    ? t('N/A until at least one completed service month has an assigned cost.')
    : `${margin.costMonths} / ${margin.serviceMonths} ${t('completed service months covered')}${margin.uncoveredMonths ? `; ${margin.uncoveredMonths} ${t('months have no recorded cost and are excluded')}` : ''}. ${t('Current incomplete month is excluded; no partial-month proration.')}`;
  const currentMonthlyCost = margin.currentMonthlyCostPaisa === null
    ? t('Not assigned for this month')
    : formatMoney(margin.currentMonthlyCostPaisa);
  const customerCostHistory = customerServiceCosts
    .filter((entry) => entry.customer_id === customer.id && (!organizationId || entry.organization_id === organizationId))
    .sort((left, right) => String(right.effective_on).localeCompare(String(left.effective_on))
      || String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')));
  const latestEntryByEffectiveMonth = new Map();
  for (const entry of customerCostHistory) {
    if (!latestEntryByEffectiveMonth.has(entry.effective_on)) latestEntryByEffectiveMonth.set(entry.effective_on, entry.id);
  }
  const customerCostHistoryMarkup = customerCostHistory.map((entry) => {
    const latest = latestEntryByEffectiveMonth.get(entry.effective_on) === entry.id;
    const recordedAt = localTimestamp(entry.created_at, locale);
    return `<li><article class="record-card customer-cost-record">
      <header class="record-card__top"><div><h4>${escapeHtml(entry.effective_on)}</h4><p class="record-card__subtitle">${escapeHtml(t('Effective month'))}</p></div><span class="status-pill ${latest ? '' : 'status-pill--unknown'}">${escapeHtml(t(latest ? 'Active for this month' : 'Superseded entry'))}</span></header>
      <dl class="record-card__facts"><div><dt>${escapeHtml(t('Monthly package / bandwidth cost'))}</dt><dd>${escapeHtml(formatMoney(entry.monthly_cost_paisa))}</dd></div>${recordedAt ? `<div><dt>${escapeHtml(t('Recorded at (local time)'))}</dt><dd><time datetime="${escapeHtml(entry.created_at)}">${escapeHtml(recordedAt)}</time></dd></div>` : ''}</dl>
      ${entry.note ? `<p class="muted">${escapeHtml(entry.note)}</p>` : ''}
    </article></li>`;
  }).join('');
  const currentLocalMonth = localDateKey(now).slice(0, 7);
  return `<div class="customer-profile-content">
    <div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Customer profile'))}</p><h2 id="customer-profile-title">${name}</h2><p class="muted">${escapeHtml(t('Account'))} #${escapeHtml(customer.customer_number)}</p></div><button class="icon-button" type="button" data-action="close-customer-profile" aria-label="${escapeHtml(t('Close customer profile'))}">×</button></div>
    <div class="customer-profile-grid">
      <div class="profile-field"><span>${escapeHtml(t('Service status'))}</span><strong>${escapeHtml(customer.archived ? t('Archived') : ({ active: t('Active'), offline: t('Offline'), 'not-set': t('Not set') }[customer.service_status] ?? customer.service_status ?? t('Not set')))}</strong></div>
      <div class="profile-field"><span>${escapeHtml(t('Billing status'))}</span><strong>${escapeHtml(statusLabel)} · ${escapeHtml(dueLabel)}</strong></div>
      <div class="profile-field"><span>${escapeHtml(t('Current balance'))}</span><strong>${escapeHtml(formatMoney(billing.balanceCents))}</strong></div>
      <div class="profile-field"><span>${escapeHtml(t('Package'))}</span><strong>${escapeHtml(packageLabel)}</strong></div>
      ${portalTestModeAvailable ? `<div class="profile-field profile-field--wide"><span>${escapeHtml(t('Existing PPPoE username'))}</span><strong>${escapeHtml(customer.pppoe_username || t('Not linked'))}</strong></div>` : ''}
      <div class="profile-field profile-field--wide"><span>${escapeHtml(t('Service address'))}</span><strong>${escapeHtml(area || t('Service address not recorded'))}</strong></div>
      <div class="profile-field profile-field--wide"><span>${escapeHtml(t('Admin-only phone'))}</span><strong>${phoneMarkup}</strong></div>
    </div>
    <section class="customer-profile-history"><h3>${escapeHtml(t('Billing history'))}</h3><ul class="record-card-grid customer-profile-card-grid" aria-label="${escapeHtml(t('Billing history'))}">${billHistory || `<li class="record-card-empty" role="status">${escapeHtml(t('No bills recorded yet.'))}</li>`}</ul><p class="muted">${escapeHtml(t('Cash is counted only from actual receipts; allocations and carry-forward credits reduce balances but are not additional payments.'))}</p></section>
    <section class="customer-profile-history"><h3>${escapeHtml(t('Receipt history'))}</h3><ul class="record-card-grid customer-profile-card-grid" aria-label="${escapeHtml(t('Receipt history'))}">${customerReceipts || `<li class="record-card-empty" role="status">${escapeHtml(t('No receipts recorded yet.'))}</li>`}</ul></section>
    <section class="customer-profile-history customer-margin-history">
      <h3>${escapeHtml(t('Customer cash collected and contribution estimate'))}</h3>
      <dl class="record-card__facts customer-margin-facts">
        <div><dt>${escapeHtml(t('Total cash collected from posted receipts'))}</dt><dd>${escapeHtml(formatMoney(margin.collectedPaisa))}</dd></div>
        <div><dt>${escapeHtml(startDateLabel)}</dt><dd>${escapeHtml(startDateValue)}</dd></div>
        <div><dt>${escapeHtml(t('Customer tenure'))}</dt><dd>${escapeHtml(tenureLabel(margin.tenureMonths, t))}</dd></div>
        <div><dt>${escapeHtml(t('Estimated customer contribution'))}</dt><dd>${escapeHtml(contributionValue)}</dd></div>
        <div><dt>${escapeHtml(t('Cost coverage'))}</dt><dd>${escapeHtml(coverageValue)}</dd></div>
        <div><dt>${escapeHtml(t('Current assigned monthly package / bandwidth cost'))}</dt><dd>${escapeHtml(currentMonthlyCost)}</dd></div>
      </dl>
      <p class="muted">${escapeHtml(t('Estimate only, not audited net profit. Uses actual posted receipts minus assigned monthly costs for completed service months with recorded effective cost history. Cost allocations are not added to global cash expenses; those count actual bills and outflows only.'))}</p>
    </section>
    <section class="customer-profile-history customer-service-cost-history">
      <h3>${escapeHtml(t('Monthly package / bandwidth cost assignment'))}</h3>
      <p class="muted">${escapeHtml(t('A new entry is append-only. If entries share an effective month, the latest recorded entry applies and earlier entries remain in the history.'))}</p>
      <form id="customer-service-cost-form" class="customer-service-cost-form" data-customer-id="${escapeHtml(customer.id)}">
        <label for="customer-service-cost-amount">${escapeHtml(t('Monthly package / bandwidth cost (PKR)'))}<input id="customer-service-cost-amount" name="monthly_cost" inputmode="decimal" min="0" placeholder="1500.00" required></label>
        <label for="customer-service-cost-month">${escapeHtml(t('Effective month'))}<input id="customer-service-cost-month" name="effective_month" type="month" value="${escapeHtml(currentLocalMonth)}" required></label>
        <label for="customer-service-cost-note">${escapeHtml(t('Optional note'))}<input id="customer-service-cost-note" name="note" maxlength="500"></label>
        <button class="button primary" type="submit">${escapeHtml(t('Save effective cost entry'))}</button>
      </form>
      <p id="customer-service-cost-message" class="form-message" role="status" aria-live="polite" aria-atomic="true"></p>
      <h4>${escapeHtml(t('Effective monthly cost history'))}</h4>
      <ul class="record-card-grid customer-profile-card-grid" aria-label="${escapeHtml(t('Effective monthly cost history'))}">${customerCostHistoryMarkup || `<li class="record-card-empty" role="status">${escapeHtml(t('No service cost history recorded yet.'))}</li>`}</ul>
    </section>
    ${portalTestModeAvailable ? `<section class="customer-profile-history customer-test-login-access">
      <h3>${escapeHtml(t('Internal staging test login'))}</h3>
      <p class="muted">${escapeHtml(t('Enable only for an internal test customer. It uses this customer’s existing PPPoE username and the default portal password 123456; the customer must change it before any portal data is released. This does not change Overtake, RouterOS, or RADIUS credentials.'))}</p>
      <label class="checkbox-label customer-test-login-toggle"><input id="customer-portal-test-account" type="checkbox" ${customer.portal_test_account ? 'checked' : ''} ${/^[\x21-\x7e]{1,64}$/.test(String(customer.pppoe_username ?? '')) ? '' : 'disabled'} /> ${escapeHtml(t('Allow PPPoE username sign-in for this staging test account'))}</label>
      <p class="muted">${escapeHtml(/^[\x21-\x7e]{1,64}$/.test(String(customer.pppoe_username ?? '')) ? t('Changing this setting blocks old test sessions when disabled; issue a standard credential reset before changing a test mapping.') : t('Link a valid existing PPPoE username of at most 64 characters before enabling test access.'))}</p>
      <p id="customer-portal-test-account-message" class="form-message" role="status" aria-live="polite" aria-atomic="true"></p>
    </section>` : ''}
    <section class="customer-profile-history customer-credential-access">
      <h3>${escapeHtml(t('Username + temporary password'))}</h3>
      <p class="muted">${escapeHtml(t('Issue or reset a separate customer username and temporary password. Customer data stays blocked until the password is changed. The password is shown once; closing this profile clears it. The internal synthetic address is not an inbox and never proves inbox ownership.'))}</p>
      <form id="customer-credential-form" class="stack" data-customer-id="${escapeHtml(customer.id)}">
        <label for="customer-credential-reason">${escapeHtml(t('Reason for credential issue or reset'))}</label>
        <textarea id="customer-credential-reason" name="reason" maxlength="500" minlength="10" required></textarea>
        <label class="checkbox-label"><input type="checkbox" name="identity_verified" value="yes" required /> ${escapeHtml(t('I verified this customer under the approved staff identity-check process.'))}</label>
        <button class="button secondary" type="submit">${escapeHtml(t('Issue or reset temporary password'))}</button>
      </form>
      <div id="customer-credential-result" class="form-message" role="status" aria-live="polite" hidden></div>
    </section>
  </div>`;
}
