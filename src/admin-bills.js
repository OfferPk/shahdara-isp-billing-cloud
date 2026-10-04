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

export function buildAdminBillRows({
  customers = [], bills = [], receipts = [], allocations = [], privateDetails = [], today = '', t = (value) => value,
} = {}) {
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));
  const phoneByCustomer = new Map(privateDetails.map((detail) => [detail.customer_id, String(detail.phone ?? '')]));
  const todayKey = validIsoDate(today);

  return bills.map((bill) => {
    const customer = customerById.get(bill.customer_id) ?? null;
    const billAllocations = allocations.filter((allocation) =>
      allocation.bill_id === bill.id && allocation.customer_id === bill.customer_id);
    const billReceipts = receipts.filter((receipt) =>
      receipt.origin_bill_id === bill.id && receipt.customer_id === bill.customer_id);
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

export function paginateAdminBillRows(rows, { page = 1, pageSize = 10 } = {}) {
  const safePageSize = Number.isSafeInteger(Number(pageSize)) && Number(pageSize) > 0
    ? Math.floor(Number(pageSize))
    : 10;
  const pageCount = Math.max(1, Math.ceil(rows.length / safePageSize));
  const requestedPage = Number.isSafeInteger(Number(page)) ? Number(page) : 1;
  const currentPage = Math.min(pageCount, Math.max(1, requestedPage));
  const startIndex = (currentPage - 1) * safePageSize;
  const endIndex = Math.min(rows.length, startIndex + safePageSize);

  return {
    items: rows.slice(startIndex, endIndex),
    page: currentPage,
    pageSize: safePageSize,
    pageCount,
    total: rows.length,
    start: rows.length ? startIndex + 1 : 0,
    end: endIndex,
  };
}

function whatsappDigits(phone) {
  const digits = digitsOnly(phone);
  if (/^03\d{9}$/.test(digits)) return `92${digits.slice(1)}`;
  if (/^923\d{9}$/.test(digits)) return digits;
  return '';
}

function interpolate(template, values) {
  return String(template).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_match, name) => String(values[name] ?? ''));
}

export function buildWhatsappReminderHref(row, formatMoney, t = (value) => value) {
  if (row?.status !== 'unpaid' || row.balanceCents == null || row.balanceCents <= 0) return '';
  const number = whatsappDigits(row.phone);
  if (!number) return '';
  const dateText = row.dueDate ? ` ${t('Due date:')} ${row.dueDate}.` : '';
  const message = interpolate(t('Assalam-o-Alaikum {name}. Shahdara Fiber Net ki {period} ki bill ke hawale se yaad-dihani: outstanding balance {balance} hai.{dueDate} Agar aap payment kar chuke hain to meherbani karke is paigham ko nazar-andaz karein aur humein tasdeeq ke liye rabta karein. Shukriya.'), {
    name: row.customerName,
    period: row.period || t('recorded period'),
    balance: formatMoney(row.balanceCents),
    dueDate: dateText,
  });
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

export function renderAdminBillCards(rows, formatMoney, t = (value) => value) {
  if (!rows.length) return `<p class="bill-card-empty" role="status">${escapeHtml(t('No bills match this search and status filter.'))}</p>`;
  return rows.map((row) => {
    const billId = escapeHtml(row.bill.id);
    const customerName = escapeHtml(row.customerName || t('Customer'));
    const period = escapeHtml(row.period || t('Period not recorded'));
    const badge = row.isOverdue ? `${t('Overdue by')} ${row.overdueDays} ${t('days')}` : row.status === 'paid' ? t('Paid') : row.status === 'unpaid' ? t('Unpaid') : t('Not priced');
    const badgeClass = row.isOverdue ? 'status-pill--overdue' : row.status === 'paid' ? 'status-pill--paid' : row.status === 'unpaid' ? 'status-pill--unpaid' : 'status-pill--not-priced';
    const reminderHref = buildWhatsappReminderHref(row, formatMoney, t);
    const packageName = escapeHtml(row.packageName || t('Package not recorded'));
    const phone = row.phone ? escapeHtml(row.phone) : escapeHtml(t('Not recorded'));
    const collect = row.status === 'unpaid' && row.balanceCents > 0
      ? `<button class="bill-action bill-action--collect" type="button" data-action="collect-bill" data-id="${billId}" aria-label="${escapeHtml(t('Collect for'))} ${customerName}, ${period}; ${escapeHtml(t('opens the receipt form without recording payment'))}">${escapeHtml(t('Collect'))}</button>`
      : `<button class="bill-action bill-action--collect" type="button" disabled title="${escapeHtml(t(row.status === 'not-priced' ? 'Record a bill price before pre-filling an outstanding amount.' : 'No outstanding balance is recorded.'))}">${escapeHtml(t('Collect'))}</button>`;
    const reminder = reminderHref
      ? `<a class="bill-action bill-action--whatsapp" href="${escapeHtml(reminderHref)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(t('Open a prefilled WhatsApp reminder for'))} ${customerName}">${escapeHtml(t('WhatsApp reminder'))}</a>`
      : `<button class="bill-action" type="button" disabled title="${escapeHtml(t('A valid Admin phone and an outstanding priced bill are required.'))}">${escapeHtml(t('WhatsApp reminder'))}</button>`;
    const correct = `<button class="bill-action" type="button" data-action="edit-bill" data-id="${billId}" aria-label="${escapeHtml(t('Correct bill for'))} ${customerName}, ${period}">${escapeHtml(t('Correct bill'))}</button>`;
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
      <div class="bill-card__top"><div><p class="bill-card__period">${escapeHtml(t('Billing Month'))} · ${period}</p><h3>${customerName}</h3>${row.customerNumber !== null ? `<p class="bill-card__account">${escapeHtml(t('Account'))} #${escapeHtml(row.customerNumber)}</p>` : ''}</div><span class="status-pill ${badgeClass}">${escapeHtml(badge)}</span></div>
      <dl class="bill-card__facts"><div><dt>${escapeHtml(t('Issue Date'))}</dt><dd>${escapeHtml(row.issuedOn || t('Issue date not recorded'))}</dd></div><div><dt>${escapeHtml(t('Due Date'))}</dt><dd>${escapeHtml(row.dueDate || t('Due date not recorded'))}</dd></div><div><dt>${escapeHtml(t('Bill amount'))}</dt><dd>${escapeHtml(formatMoney(row.amountDueCents))}</dd></div><div><dt>${escapeHtml(t('Outstanding'))}</dt><dd>${escapeHtml(formatMoney(row.balanceCents))}</dd></div><div><dt>${escapeHtml(t('Package'))}</dt><dd>${packageName}</dd></div><div><dt>${escapeHtml(t('Admin phone'))}</dt><dd>${phone}</dd></div><div><dt>${escapeHtml(t('Actual receipts linked'))}</dt><dd>${escapeHtml(formatMoney(row.cashReceiptCents))}</dd></div><div><dt>${escapeHtml(t('Carry-forward credit'))}</dt><dd>${escapeHtml(formatMoney(row.creditAppliedCents))}</dd></div></dl>
      <div class="bill-card__actions" role="group" aria-label="${escapeHtml(t('Bill actions for'))} ${customerName}">${collect}${reminder}${correct}</div>
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
