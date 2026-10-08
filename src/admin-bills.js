import { getOverdueDays, normalizeIsoDate } from './bill-dates.js';

const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '');
const normalizeText = (value) => String(value ?? '').trim().toLocaleLowerCase('en-PK');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function validIsoDate(value) {
  return normalizeIsoDate(value);
}

function sumCents(rows) {
  return rows.reduce((total, row) => total + Number(row.amount_cents || 0), 0);
}

function indexRowsByBillAndCustomer(rows, billIdField) {
  const byBill = new Map();
  rows.forEach((row) => {
    let byCustomer = byBill.get(row[billIdField]);
    if (!byCustomer) {
      byCustomer = new Map();
      byBill.set(row[billIdField], byCustomer);
    }
    let matches = byCustomer.get(row.customer_id);
    if (!matches) {
      matches = [];
      byCustomer.set(row.customer_id, matches);
    }
    matches.push(row);
  });
  return byBill;
}

function rowsForBillAndCustomer(index, billId, customerId) {
  return index.get(billId)?.get(customerId) ?? [];
}

export function buildAdminBillRows({
  customers = [], bills = [], receipts = [], allocations = [], privateDetails = [], today = '', t = (value) => value,
} = {}) {
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));
  const phoneByCustomer = new Map(privateDetails.map((detail) => [detail.customer_id, String(detail.phone ?? '')]));
  const allocationsByBill = indexRowsByBillAndCustomer(allocations, 'bill_id');
  const receiptsByBill = indexRowsByBillAndCustomer(receipts, 'origin_bill_id');
  const todayKey = validIsoDate(today);

  return bills.map((bill) => {
    const customer = customerById.get(bill.customer_id) ?? null;
    const billAllocations = rowsForBillAndCustomer(allocationsByBill, bill.id, bill.customer_id);
    const billReceipts = rowsForBillAndCustomer(receiptsByBill, bill.id, bill.customer_id);
    const isPriced = bill.amount_due_cents !== null && bill.amount_due_cents !== undefined
      && Number.isFinite(Number(bill.amount_due_cents));
    const appliedCents = sumCents(billAllocations);
    const balanceCents = isPriced ? Math.max(0, Number(bill.amount_due_cents) - appliedCents) : null;
    const issuedOn = validIsoDate(bill.issued_on);
    const dueDate = validIsoDate(bill.due_date);
    const overdueDays = balanceCents > 0 ? getOverdueDays(dueDate, todayKey) : 0;
    const isOverdue = overdueDays > 0;
    const status = !isPriced ? 'not-priced' : balanceCents === 0 ? 'paid' : 'unpaid';
    const period = String(bill.period ?? '').slice(0, 7);
    const phone = phoneByCustomer.get(bill.customer_id) ?? '';

    return {
      bill,
      customerName: customer?.name ?? '',
      customerNumber: customer?.customer_number ?? null,
      invoiceNumber: String(bill.invoice_number ?? '').trim() || String(bill.id),
      pppoeUsername: String(customer?.pppoe_username ?? '').trim(),
      phone,
      period,
      packageName: String(bill.plan_snapshot ?? '').trim() || String(customer?.plan_name ?? '').trim(),
      amountDueCents: isPriced ? Number(bill.amount_due_cents) : null,
      appliedCents,
      balanceCents,
      creditAppliedCents: sumCents(billAllocations.filter((allocation) => allocation.allocation_kind === 'carry-forward')),
      cashReceiptCents: sumCents(billReceipts),
      issuedOn,
      dueDate,
      dueLabel: dueDate ? `${t('Due date:')} ${dueDate}` : t('Due date not recorded'),
      overdueDays,
      status,
      isOverdue,
      receipts: [...billReceipts].sort((left, right) => String(right.received_on).localeCompare(String(left.received_on))),
    };
  }).sort((left, right) => right.period.localeCompare(left.period)
    || left.customerName.localeCompare(right.customerName, 'en-PK')
    || String(left.bill.id).localeCompare(String(right.bill.id)));
}

export function filterAdminBillRows(rows, { search = '', status = 'all' } = {}) {
  const query = normalizeText(search);
  const queryDigits = digitsOnly(search);
  return rows.filter((row) => {
    if (status === 'paid' && row.status !== 'paid') return false;
    if (status === 'unpaid' && row.status !== 'unpaid') return false;
    if (!query) return true;
    const nameMatch = normalizeText(row.customerName).includes(query);
    const phoneTextMatch = normalizeText(row.phone).includes(query);
    const phoneDigitMatch = queryDigits.length > 0 && digitsOnly(row.phone).includes(queryDigits);
    return nameMatch || phoneTextMatch || phoneDigitMatch;
  });
}

export function filterCollectionBillRows(rows, { scope = '', period = '' } = {}) {
  if (!scope) return rows;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period))) return [];
  return rows.filter((row) => {
    if (row.period !== period) return false;
    if (scope === 'all') return true;
    if (scope === 'paid') return row.status === 'paid';
    if (scope === 'pending') {
      return row.status === 'unpaid'
        && row.amountDueCents !== null
        && Number.isFinite(Number(row.amountDueCents))
        && row.balanceCents > 0
        && row.isOverdue !== true;
    }
    if (scope === 'unpaid') {
      return row.status === 'unpaid'
        && row.amountDueCents !== null
        && Number.isFinite(Number(row.amountDueCents))
        && row.balanceCents > 0;
    }
    if (scope === 'overdue') {
      return row.status === 'unpaid'
        && row.amountDueCents !== null
        && Number.isFinite(Number(row.amountDueCents))
        && row.balanceCents > 0
        && Boolean(validIsoDate(row.dueDate))
        && row.isOverdue === true;
    }
    if (scope === 'unpriced') return row.status === 'not-priced' && row.amountDueCents === null;
    return false;
  });
}

export function countAdminBillFilters(rows, { search = '' } = {}) {
  const searchRows = filterAdminBillRows(rows, { search, status: 'all' });
  return {
    all: searchRows.length,
    unpaid: searchRows.filter((row) => row.status === 'unpaid').length,
    paid: searchRows.filter((row) => row.status === 'paid').length,
  };
}

function whatsappDigits(phone) {
  const digits = digitsOnly(phone);
  if (/^03\d{9}$/.test(digits)) return `92${digits.slice(1)}`;
  if (/^923\d{9}$/.test(digits)) return digits;
  return '';
}

function formatShareAmount(cents) {
  const amount = Number(cents);
  return new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2 })
    .format((Number.isFinite(amount) ? amount : 0) / 100);
}

export function buildWhatsappBillShareHref(row, t = (value) => value) {
  const isPaid = row?.status === 'paid' && Number(row.balanceCents) === 0;
  const isUnpaid = row?.status === 'unpaid' && Number(row.balanceCents) > 0;
  if (!isPaid && !isUnpaid) return '';

  const customer = String(row.pppoeUsername || row.customerName || t('Customer')).trim();
  const accountNumber = row.customerNumber === null || row.customerNumber === undefined
    ? t('Not recorded')
    : String(row.customerNumber);
  const period = String(row.period || t('Period not recorded'));
  let message;

  if (isPaid) {
    const amountDue = Math.max(0, Number(row.amountDueCents) || 0);
    const amountApplied = Math.max(0, Number(row.appliedCents) || 0);
    const amountPaid = Math.min(amountDue, amountApplied);
    const methods = new Set((row.receipts ?? []).map((receipt) => String(receipt.method ?? '').trim()).filter(Boolean));
    if (Number(row.creditAppliedCents) > 0) methods.add(t('Carry-forward credit'));
    const latestReceipt = [...(row.receipts ?? [])]
      .sort((left, right) => String(right.received_on ?? '').localeCompare(String(left.received_on ?? '')))[0];
    message = [
      '*Shahdara Fiber Net - Payment Receipt*',
      `Customer: ${customer} (Account #${accountNumber})`,
      `Bill Month: ${period}`,
      `Amount Paid: Rs ${formatShareAmount(amountPaid)}`,
      `Method: ${[...methods].join(', ') || t('Method not recorded')}`,
      `Date: ${latestReceipt?.received_on || t('Date not recorded')}`,
      'Status: PAID (Clear)',
      'Shukriya!',
    ].join('\n');
  } else {
    message = [
      '*Shahdara Fiber Net - Bill Reminder*',
      `Customer: ${customer} (Account #${accountNumber})`,
      `Bill Month: ${period}`,
      `Outstanding: Rs ${formatShareAmount(row.balanceCents)}`,
      `Due Date: ${row.dueDate || t('Due date not recorded')}`,
      'Payment Methods: EasyPaisa / Cash',
      'If you have already paid, please ignore this message and contact us for confirmation. Shukriya!',
    ].join('\n');
  }

  const number = whatsappDigits(row.phone);
  return `https://api.whatsapp.com/send?${number ? `phone=${number}&` : ''}text=${encodeURIComponent(message)}`;
}

export function renderAdminBillCards(rows, formatMoney, t = (value) => value) {
  if (!rows.length) return `<p class="bill-card-empty" role="status">${escapeHtml(t('No bills match this search and status filter.'))}</p>`;
  return rows.slice(0, 100).map((row) => {
    const billId = escapeHtml(row.bill.id);
    const customerName = escapeHtml(row.customerName || t('Customer'));
    const period = escapeHtml(row.period || t('Period not recorded'));
    const badge = row.isOverdue ? `${t('Overdue by')} ${row.overdueDays} ${t('days')}` : row.status === 'paid' ? t('Paid') : row.status === 'unpaid' ? t('Unpaid') : t('Not priced');
    const badgeClass = row.isOverdue ? 'status-pill--overdue' : row.status === 'paid' ? 'status-pill--paid' : row.status === 'unpaid' ? 'status-pill--unpaid' : 'status-pill--not-priced';
    const shareHref = buildWhatsappBillShareHref(row, t);
    const shareLabel = row.status === 'paid' ? 'Share WhatsApp Receipt' : 'Send WhatsApp Bill';
    const packageName = escapeHtml(row.packageName || t('Package not recorded'));
    const phone = row.phone ? escapeHtml(row.phone) : escapeHtml(t('Not recorded'));
    const customerId = escapeHtml(row.bill.customer_id ?? '');
    const collect = row.status === 'unpaid' && row.balanceCents > 0
      ? `<button class="bill-action bill-action--collect" type="button" data-action="collect-bill" data-id="${billId}" aria-label="${escapeHtml(t('Collect for'))} ${customerName}, ${period}; ${escapeHtml(t('opens the receipt form without recording payment'))}">${escapeHtml(t('Collect'))}</button>`
      : `<button class="bill-action bill-action--collect" type="button" disabled title="${escapeHtml(t(row.status === 'not-priced' ? 'Record a bill price before pre-filling an outstanding amount.' : 'No outstanding balance is recorded.'))}">${escapeHtml(t('Collect'))}</button>`;
    const whatsappShare = shareHref
      ? `<a class="bill-action bill-action--whatsapp" href="${escapeHtml(shareHref)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(t('Open a prefilled WhatsApp message for'))} ${customerName}">${escapeHtml(t(shareLabel))}</a>`
      : `<button class="bill-action" type="button" disabled title="${escapeHtml(t('Set a price before sharing a WhatsApp bill.'))}">${escapeHtml(t(shareLabel))}</button>`;
    const correct = `<button class="bill-action" type="button" data-action="edit-bill" data-id="${billId}" aria-label="${escapeHtml(t('Correct bill for'))} ${customerName}, ${period}">${escapeHtml(t('Correct bill'))}</button>`;
    const receivePayment = row.status === 'unpaid' && row.balanceCents > 0
      ? `<button class="bill-action bill-action--paid" type="button" data-action="receive-payment" data-id="${billId}" aria-label="${escapeHtml(t('Receive payment for'))} ${customerName}, ${period}">${escapeHtml(t('Receive Payment'))}</button>`
      : '';
    const viewInvoice = row.amountDueCents !== null
      ? `<button class="bill-action" type="button" data-action="view-invoice" data-id="${billId}" aria-label="${escapeHtml(t('View or print invoice for'))} ${customerName}, ${period}">${escapeHtml(t('Print / Copy Invoice'))}</button>`
      : `<button class="bill-action" type="button" disabled title="${escapeHtml(t('Set a price before printing an invoice.'))}">${escapeHtml(t('Print / Copy Invoice'))}</button>`;
    const receipts = row.receipts.length
      ? `<ul class="bill-receipt-list">${row.receipts.map((receipt) => {
        const receiptId = escapeHtml(receipt.id);
        const receivedOn = escapeHtml(receipt.received_on);
        const method = escapeHtml(receipt.method || t('Method not recorded'));
        const amount = escapeHtml(formatMoney(receipt.amount_cents));
        return `<li><span>${receivedOn} · ${method} · ${amount}</span><button class="bill-receipt-print" type="button" data-action="print-receipt" data-id="${receiptId}" aria-label="${escapeHtml(t('Print or save PDF of the actual receipt for'))} ${customerName}, ${receivedOn}, ${amount}">${escapeHtml(t('Print / Save PDF'))}</button></li>`;
      }).join('')}</ul>`
      : `<p class="bill-card__no-receipts">${escapeHtml(t('No actual receipt is recorded against this bill.'))}</p>`;
    return `<article class="bill-card">
      <div class="bill-card__top"><div><p class="bill-card__period">${escapeHtml(t('Invoice No.'))} · ${escapeHtml(row.invoiceNumber)}</p><p class="bill-card__period">${escapeHtml(t('Billing Month'))} · ${period}</p><h3>${customerName}</h3>${row.customerNumber !== null ? `<p class="bill-card__account">${escapeHtml(t('Account'))} #${escapeHtml(row.customerNumber)}</p>` : ''}</div><span class="status-pill ${badgeClass}">${escapeHtml(badge)}</span></div>
      <dl class="bill-card__facts"><div><dt>${escapeHtml(t('PPPoE Username'))}</dt><dd>${escapeHtml(row.pppoeUsername || t('Not recorded'))}</dd></div><div><dt>${escapeHtml(t('Issue Date'))}</dt><dd>${escapeHtml(row.issuedOn || t('Issue date not recorded'))}</dd></div><div><dt>${escapeHtml(t('Due Date'))}</dt><dd>${escapeHtml(row.dueDate || t('Due date not recorded'))}</dd></div><div><dt>${escapeHtml(t('Bill amount'))}</dt><dd>${escapeHtml(formatMoney(row.amountDueCents))}</dd></div><div><dt>${escapeHtml(t('Outstanding'))}</dt><dd>${escapeHtml(formatMoney(row.balanceCents))}</dd></div><div><dt>${escapeHtml(t('Package'))}</dt><dd>${packageName}</dd></div><div><dt>${escapeHtml(t('Admin phone'))}</dt><dd class="bill-card__phone">${phone}<button class="bill-phone-edit" type="button" data-action="edit-customer-phone" data-customer-id="${customerId}" aria-label="${escapeHtml(t('Edit WhatsApp phone for'))} ${customerName}"><span aria-hidden="true">✎</span></button></dd></div><div><dt>${escapeHtml(t('Actual receipts linked'))}</dt><dd>${escapeHtml(formatMoney(row.cashReceiptCents))}</dd></div><div><dt>${escapeHtml(t('Carry-forward credit'))}</dt><dd>${escapeHtml(formatMoney(row.creditAppliedCents))}</dd></div></dl>
      <div class="bill-card__actions" role="group" aria-label="${escapeHtml(t('Bill actions for'))} ${customerName}">${viewInvoice}${receivePayment}${collect}${whatsappShare}${correct}</div>
      <div class="bill-card__receipts"><h4>${escapeHtml(t('Actual receipt records'))}</h4>${receipts}</div>
    </article>`;
  }).join('');
}

function safeBrandingLogoUrl(value, projectUrl) {
  try {
    const expectedOrigin = new URL(projectUrl).origin;
    const parsed = new URL(value);
    const assetPath = /^\/storage\/v1\/object\/public\/organization-branding\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$/i;
    if (parsed.protocol !== 'https:' || parsed.origin !== expectedOrigin || !assetPath.test(parsed.pathname) || parsed.search || parsed.hash) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

export function renderPrintableReceiptHtml({ receipt, customer, bill, organizationName = 'Shahdara Fiber Net', branding = {}, projectUrl = '', formatMoney, t = (value) => value, language = 'en' }) {
  if (!receipt?.id || typeof formatMoney !== 'function') throw new Error('An existing receipt and money formatter are required.');
  const receiptId = escapeHtml(receipt.id);
  const customerName = escapeHtml(customer?.name ?? t('Customer'));
  const period = escapeHtml(String(bill?.period ?? '').slice(0, 7) || t('Period not available'));
  const orgName = escapeHtml(branding.displayName || organizationName);
  const logoUrl = safeBrandingLogoUrl(branding.logoUrl, projectUrl);
  const logo = logoUrl ? `<img class="receipt__logo" src="${escapeHtml(logoUrl)}" alt="">` : '';
  const supportPhone = String(branding.supportPhone ?? '').trim();
  const companyAddress = String(branding.address ?? '').trim();
  const contactDetails = `${supportPhone ? `<p><strong>${escapeHtml(t('Support phone'))}:</strong> ${escapeHtml(supportPhone)}</p>` : ''}${companyAddress ? `<p><strong>${escapeHtml(t('Company address'))}:</strong> ${escapeHtml(companyAddress)}</p>` : ''}`;
  const receivedOn = escapeHtml(receipt.received_on || t('Date not recorded'));
  const method = escapeHtml(receipt.method ?? t('Method not recorded'));
  const amount = escapeHtml(formatMoney(receipt.amount_cents));
  return `<!doctype html><html lang="${escapeHtml(language)}" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(t('Cash receipt'))} ${receiptId}</title><style>
    :root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#17342f}*{box-sizing:border-box}body{margin:0;padding:32px;background:#eef3f0}.receipt{max-width:680px;margin:0 auto;padding:38px;border:1px solid #d7e3dc;border-radius:14px;background:#fff}.receipt__head{padding-bottom:20px;border-bottom:2px solid #177b59}.receipt__provider{display:flex;align-items:center;gap:14px;margin-bottom:18px}.receipt__logo{width:58px;height:58px;object-fit:contain;border:1px solid #e2ebe6;border-radius:10px;padding:4px}.receipt__brand{margin:0 0 6px;color:#177b59;font-size:17px;font-weight:800;overflow-wrap:anywhere}.receipt__provider p:not(.receipt__brand){margin:3px 0;color:#536b61;font-size:11px;overflow-wrap:anywhere}.receipt h1{margin:0 0 12px;font-size:30px}.receipt__id{color:#536b61;font-size:12px;overflow-wrap:anywhere}.receipt dl{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:24px 0}.receipt dl div{padding:12px;border:1px solid #e2ebe6;border-radius:10px}.receipt dt{margin-bottom:6px;color:#61756d;font-size:11px;font-weight:700;text-transform:uppercase}.receipt dd{margin:0;font-size:16px;font-weight:700;overflow-wrap:anywhere}.receipt__amount dd{font-size:24px;color:#0f5a43}.receipt__note{padding:13px;border-radius:10px;background:#f2f7f4;color:#496259;font-size:12px;line-height:1.6}.receipt__footer{margin-top:26px;color:#708078;font-size:11px}@media print{body{padding:0;background:#fff}.receipt{max-width:none;border:0;border-radius:0;box-shadow:none;padding:0}.receipt__note{break-inside:avoid}}@media(max-width:520px){body{padding:12px}.receipt{padding:22px}.receipt dl{grid-template-columns:1fr}}
  </style></head><body><main class="receipt"><header class="receipt__head"><div class="receipt__provider">${logo}<div><p class="receipt__brand">${orgName}</p>${contactDetails}</div></div><h1>${escapeHtml(t('Cash receipt'))}</h1><p class="receipt__id">${escapeHtml(t('Receipt ID:'))} ${receiptId}</p></header><dl><div><dt>${escapeHtml(t('Customer'))}</dt><dd>${customerName}</dd></div><div><dt>${escapeHtml(t('Billing period linked to receipt'))}</dt><dd>${period}</dd></div><div class="receipt__amount"><dt>${escapeHtml(t('Actual amount received'))}</dt><dd>${amount}</dd></div><div><dt>${escapeHtml(t('Received on'))}</dt><dd>${receivedOn}</dd></div><div><dt>${escapeHtml(t('Payment method'))}</dt><dd>${method}</dd></div></dl><p class="receipt__note">${escapeHtml(t('This print-ready document reflects an existing cash receipt entry. It does not create a payment or state the remaining bill balance; balances are determined separately from ledger allocations.'))}</p><footer class="receipt__footer">${escapeHtml(t('Keep the Receipt ID with your records.'))}</footer></main></body></html>`;
}
