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
  customers = [], bills = [], receipts = [], allocations = [], privateDetails = [], today = '',
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
      customerName: customer?.name ?? 'Customer',
      customerNumber: customer?.customer_number ?? null,
      phone,
      period,
      packageName: String(bill.plan_snapshot ?? '').trim() || String(customer?.plan_name ?? '').trim() || 'Package not recorded',
      amountDueCents: isPriced ? Number(bill.amount_due_cents) : null,
      appliedCents,
      balanceCents,
      creditAppliedCents: sumCents(billAllocations.filter((allocation) => allocation.allocation_kind === 'carry-forward')),
      cashReceiptCents: sumCents(billReceipts),
      issuedOn,
      dueDate,
      overdueDays,
      dueLabel: dueDate ? `Due date: ${dueDate}` : 'Due date not recorded',
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

export function buildWhatsappReminderHref(row, formatMoney) {
  if (row?.status !== 'unpaid' || row.balanceCents == null || row.balanceCents <= 0) return '';
  const number = whatsappDigits(row.phone);
  if (!number) return '';
  const dateText = row.dueDate ? ` Due date: ${row.dueDate}.` : '';
  const message = `Assalam-o-Alaikum ${row.customerName}. Shahdara Fiber Net ki ${row.period || 'recorded period'} ki bill ke hawale se yaad-dihani: outstanding balance ${formatMoney(row.balanceCents)} hai.${dateText} Agar aap payment kar chuke hain to meherbani karke is paigham ko nazar-andaz karein aur humein tasdeeq ke liye rabta karein. Shukriya.`;
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

export function renderAdminBillCards(rows, formatMoney) {
  if (!rows.length) return '<p class="bill-card-empty" role="status">No bills match this search and status filter.</p>';
  return rows.slice(0, 100).map((row) => {
    const billId = escapeHtml(row.bill.id);
    const customerName = escapeHtml(row.customerName);
    const period = escapeHtml(row.period || 'Period not recorded');
    const badge = row.isOverdue ? `Overdue by ${row.overdueDays} days` : row.status === 'paid' ? 'Paid' : row.status === 'unpaid' ? 'Unpaid' : 'Not priced';
    const badgeClass = row.isOverdue ? 'status-pill--overdue' : row.status === 'paid' ? 'status-pill--paid' : row.status === 'unpaid' ? 'status-pill--unpaid' : 'status-pill--not-priced';
    const reminderHref = buildWhatsappReminderHref(row, formatMoney);
    const packageName = escapeHtml(row.packageName);
    const phone = row.phone ? escapeHtml(row.phone) : 'Not recorded';
    const collect = row.status === 'unpaid' && row.balanceCents > 0
      ? `<button class="bill-action bill-action--collect" type="button" data-action="collect-bill" data-id="${billId}" aria-label="Collect for ${customerName}, ${period}; opens the receipt form without recording payment">Collect</button>`
      : `<button class="bill-action bill-action--collect" type="button" disabled title="${row.status === 'not-priced' ? 'Record a bill price before pre-filling an outstanding amount.' : 'No outstanding balance is recorded.'}">Collect</button>`;
    const reminder = reminderHref
      ? `<a class="bill-action bill-action--whatsapp" href="${escapeHtml(reminderHref)}" target="_blank" rel="noopener noreferrer" aria-label="Open a prefilled WhatsApp reminder for ${customerName}">WhatsApp reminder</a>`
      : `<button class="bill-action" type="button" disabled title="A valid Admin phone and an outstanding priced bill are required.">WhatsApp reminder</button>`;
    const correct = `<button class="bill-action" type="button" data-action="edit-bill" data-id="${billId}" aria-label="Correct bill for ${customerName}, ${period}">Correct bill</button>`;
    const receipts = row.receipts.length
      ? `<ul class="bill-receipt-list">${row.receipts.map((receipt) => {
        const receiptId = escapeHtml(receipt.id);
        const receivedOn = escapeHtml(receipt.received_on);
        const method = escapeHtml(receipt.method || 'Method not recorded');
        const amount = escapeHtml(formatMoney(receipt.amount_cents));
        return `<li><span>${receivedOn} · ${method} · ${amount}</span><button class="bill-receipt-print" type="button" data-action="print-receipt" data-id="${receiptId}" aria-label="Print or save PDF of the actual receipt for ${customerName}, ${receivedOn}, ${amount}">Print / Save PDF</button></li>`;
      }).join('')}</ul>`
      : '<p class="bill-card__no-receipts">No actual receipt is recorded against this bill.</p>';
    return `<article class="bill-card">
      <div class="bill-card__top"><div><p class="bill-card__period">Billing Month · ${period}</p><h3>${customerName}</h3>${row.customerNumber !== null ? `<p class="bill-card__account">Account #${escapeHtml(row.customerNumber)}</p>` : ''}</div><span class="status-pill ${badgeClass}">${badge}</span></div>
      <dl class="bill-card__facts"><div><dt>Issue Date</dt><dd>${escapeHtml(row.issuedOn || 'Issue date not recorded')}</dd></div><div><dt>Due Date</dt><dd>${escapeHtml(row.dueDate || 'Due date not recorded')}</dd></div><div><dt>Bill amount</dt><dd>${escapeHtml(formatMoney(row.amountDueCents))}</dd></div><div><dt>Outstanding</dt><dd>${escapeHtml(formatMoney(row.balanceCents))}</dd></div><div><dt>Package</dt><dd>${packageName}</dd></div><div><dt>Admin phone</dt><dd>${phone}</dd></div><div><dt>Actual receipts linked</dt><dd>${escapeHtml(formatMoney(row.cashReceiptCents))}</dd></div><div><dt>Carry-forward credit</dt><dd>${escapeHtml(formatMoney(row.creditAppliedCents))}</dd></div></dl>
      <div class="bill-card__actions" role="group" aria-label="Bill actions for ${customerName}">${collect}${reminder}${correct}</div>
      <div class="bill-card__receipts"><h4>Actual receipt records</h4>${receipts}</div>
    </article>`;
  }).join('');
}

export function renderPrintableReceiptHtml({ receipt, customer, bill, organizationName = 'Shahdara Fiber Net', formatMoney }) {
  if (!receipt?.id || typeof formatMoney !== 'function') throw new Error('An existing receipt and money formatter are required.');
  const receiptId = escapeHtml(receipt.id);
  const customerName = escapeHtml(customer?.name ?? 'Customer');
  const period = escapeHtml(String(bill?.period ?? '').slice(0, 7) || 'Period not available');
  const orgName = escapeHtml(organizationName);
  const receivedOn = escapeHtml(receipt.received_on ?? 'Date not recorded');
  const method = escapeHtml(receipt.method ?? 'Method not recorded');
  const amount = escapeHtml(formatMoney(receipt.amount_cents));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cash receipt ${receiptId}</title><style>
    :root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#17342f}*{box-sizing:border-box}body{margin:0;padding:32px;background:#eef3f0}.receipt{max-width:680px;margin:0 auto;padding:38px;border:1px solid #d7e3dc;border-radius:14px;background:#fff}.receipt__head{padding-bottom:20px;border-bottom:2px solid #177b59}.receipt__brand{margin:0 0 6px;color:#177b59;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.receipt h1{margin:0 0 12px;font-size:30px}.receipt__id{color:#536b61;font-size:12px;overflow-wrap:anywhere}.receipt dl{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:24px 0}.receipt dl div{padding:12px;border:1px solid #e2ebe6;border-radius:10px}.receipt dt{margin-bottom:6px;color:#61756d;font-size:11px;font-weight:700;text-transform:uppercase}.receipt dd{margin:0;font-size:16px;font-weight:700;overflow-wrap:anywhere}.receipt__amount dd{font-size:24px;color:#0f5a43}.receipt__note{padding:13px;border-radius:10px;background:#f2f7f4;color:#496259;font-size:12px;line-height:1.6}.receipt__footer{margin-top:26px;color:#708078;font-size:11px}@media print{body{padding:0;background:#fff}.receipt{max-width:none;border:0;border-radius:0;box-shadow:none;padding:0}.receipt__note{break-inside:avoid}}@media(max-width:520px){body{padding:12px}.receipt{padding:22px}.receipt dl{grid-template-columns:1fr}}
  </style></head><body><main class="receipt"><header class="receipt__head"><p class="receipt__brand">${orgName}</p><h1>Cash receipt</h1><p class="receipt__id">Receipt ID: ${receiptId}</p></header><dl><div><dt>Customer</dt><dd>${customerName}</dd></div><div><dt>Billing period linked to receipt</dt><dd>${period}</dd></div><div class="receipt__amount"><dt>Actual amount received</dt><dd>${amount}</dd></div><div><dt>Received on</dt><dd>${receivedOn}</dd></div><div><dt>Payment method</dt><dd>${method}</dd></div></dl><p class="receipt__note">This print-ready document reflects an existing cash receipt entry. It does not create a payment or state the remaining bill balance; balances are determined separately from ledger allocations.</p><footer class="receipt__footer">Keep the Receipt ID with your records.</footer></main></body></html>`;
}
