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
  return customers.map((customer) => {
    const customerBills = billsForCustomerThroughMonth(customer.id, bills, currentMonth);
    const bill = latestBillForCustomer(customerBills);
    const oldestOpenBill = customerBills.find((candidate) => customerBillState(candidate, allocations).balanceCents > 0) ?? null;
    return {
      customer,
      phone: phoneByCustomer.get(customer.id) ?? '',
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

export function renderCustomerProfile(row, { bills = [], receipts = [], allocations = [], formatMoney, t = (value) => value }) {
  const { customer, phone, area, billing } = row;
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
      return `<tr><td>${escapeHtml(periodOf(bill))}${bill.due_date ? `<small>${escapeHtml(t('Due'))} ${escapeHtml(String(bill.due_date).slice(0, 10))}</small>` : ''}</td><td>${escapeHtml(formatMoney(bill.amount_due_cents))}</td><td>${escapeHtml(formatMoney(cash))}</td><td>${escapeHtml(formatMoney(credit))}</td><td>${escapeHtml(formatMoney(state.balanceCents))}</td><td><span class="status-pill">${escapeHtml(billingStatusLabel(state.status, t))}</span></td></tr>`;
    }).join('');
  const customerReceipts = receipts.filter((receipt) => receipt.customer_id === customer.id)
    .sort((left, right) => String(right.received_on).localeCompare(String(left.received_on)))
    .map((receipt) => `<li><time datetime="${escapeHtml(receipt.received_on)}">${escapeHtml(receipt.received_on)}</time><span>${escapeHtml(receipt.method)}</span><strong>${escapeHtml(formatMoney(receipt.amount_cents))}</strong></li>`)
    .join('');
  const statusLabel = billingStatusLabel(billing.status, t);
  const dueLabel = customerDueLabel(row.dueBill ?? row.bill, t);
  const packageLabel = row.bill?.plan_snapshot || customer.plan_name || t('Package not set');
  return `<div class="customer-profile-content">
    <div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Customer profile'))}</p><h2 id="customer-profile-title">${name}</h2><p class="muted">${escapeHtml(t('Account'))} #${escapeHtml(customer.customer_number)}</p></div><button class="icon-button" type="button" data-action="close-customer-profile" aria-label="${escapeHtml(t('Close customer profile'))}">×</button></div>
    <div class="customer-profile-grid">
      <div class="profile-field"><span>${escapeHtml(t('Service status'))}</span><strong>${escapeHtml(customer.archived ? t('Archived') : ({ active: t('Active'), offline: t('Offline'), 'not-set': t('Not set') }[customer.service_status] ?? customer.service_status ?? t('Not set')))}</strong></div>
      <div class="profile-field"><span>${escapeHtml(t('Billing status'))}</span><strong>${escapeHtml(statusLabel)} · ${escapeHtml(dueLabel)}</strong></div>
      <div class="profile-field"><span>${escapeHtml(t('Current balance'))}</span><strong>${escapeHtml(formatMoney(billing.balanceCents))}</strong></div>
      <div class="profile-field"><span>${escapeHtml(t('Package'))}</span><strong>${escapeHtml(packageLabel)}</strong></div>
      <div class="profile-field profile-field--wide"><span>${escapeHtml(t('Service address'))}</span><strong>${escapeHtml(area || t('Service address not recorded'))}</strong></div>
      <div class="profile-field profile-field--wide"><span>${escapeHtml(t('Admin-only phone'))}</span><strong>${phoneMarkup}</strong></div>
    </div>
    <section class="customer-profile-history"><h3>${escapeHtml(t('Billing history'))}</h3><div class="table-wrap" role="region" tabindex="0" aria-label="${escapeHtml(t('Customer billing history table; scroll horizontally to view all columns'))}"><table><caption class="sr-only">${escapeHtml(t('Monthly bills and their cash receipts, credit, balance, and status.'))}</caption><thead><tr><th scope="col">${escapeHtml(t('Period / due'))}</th><th scope="col">${escapeHtml(t('Bill'))}</th><th scope="col">${escapeHtml(t('Cash received'))}</th><th scope="col">${escapeHtml(t('Credit applied'))}</th><th scope="col">${escapeHtml(t('Balance'))}</th><th scope="col">${escapeHtml(t('Status'))}</th></tr></thead><tbody>${billHistory || `<tr><td colspan="6" class="empty-cell">${escapeHtml(t('No bills recorded yet.'))}</td></tr>`}</tbody></table></div><p class="muted">${escapeHtml(t('Cash is counted only from actual receipts; allocations and carry-forward credits reduce balances but are not additional payments.'))}</p></section>
    <section class="customer-profile-history"><h3>${escapeHtml(t('Receipt history'))}</h3><ul class="customer-receipt-list">${customerReceipts || `<li class="customer-receipt-list__empty">${escapeHtml(t('No receipts recorded yet.'))}</li>`}</ul></section>
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
