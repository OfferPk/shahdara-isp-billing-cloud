function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-PK');
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/[^\p{L}\p{N}]/gu, '');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function filterAdminReceiptRows(receipts, {
  search = '',
  customerNameForReceipt = () => '',
  formatMoney = (amount) => String(amount ?? ''),
} = {}) {
  const query = normalizeSearchText(search);
  if (!query) return receipts;
  const compactQuery = compactSearchText(query);

  return receipts.filter((receipt) => {
    const amountInRupees = Number(receipt.amount_cents) / 100;
    const searchableValues = [
      customerNameForReceipt(receipt),
      receipt.received_on,
      receipt.method,
      formatMoney(receipt.amount_cents),
      Number.isFinite(amountInRupees) ? amountInRupees.toFixed(2) : '',
    ];
    return searchableValues.some((value) => {
      const normalizedValue = normalizeSearchText(value);
      return normalizedValue.includes(query)
        || (compactQuery && compactSearchText(normalizedValue).includes(compactQuery));
    });
  });
}

export function paginateAdminReceiptRows(receipts, { page = 1, pageSize = 10 } = {}) {
  const safePageSize = Number.isSafeInteger(Number(pageSize)) && Number(pageSize) > 0
    ? Math.floor(Number(pageSize))
    : 10;
  const pageCount = Math.max(1, Math.ceil(receipts.length / safePageSize));
  const requestedPage = Number.isSafeInteger(Number(page)) ? Number(page) : 1;
  const currentPage = Math.min(pageCount, Math.max(1, requestedPage));
  const startIndex = (currentPage - 1) * safePageSize;
  const endIndex = Math.min(receipts.length, startIndex + safePageSize);

  return {
    items: receipts.slice(startIndex, endIndex),
    page: currentPage,
    pageSize: safePageSize,
    pageCount,
    total: receipts.length,
    start: receipts.length ? startIndex + 1 : 0,
    end: endIndex,
  };
}

export function renderAdminReceiptCards(receipts, {
  customerNameForReceipt = () => '',
  formatMoney = (amount) => String(amount ?? ''),
  t = (value) => value,
  emptyMessage = t('No receipts recorded yet.'),
} = {}) {
  const cards = receipts.map((receipt) => {
    const receiptId = escapeHtml(receipt.id);
    const receiptDate = escapeHtml(receipt.received_on);
    const receiptCustomer = escapeHtml(customerNameForReceipt(receipt) || t('Customer'));
    return `<li><article class="record-card receipt-record-card">
      <header class="record-card__top"><div><h3>${receiptCustomer}</h3><p class="record-card__subtitle"><time datetime="${receiptDate}">${receiptDate}</time></p></div></header>
      <dl class="record-card__facts"><div><dt>${escapeHtml(t('Method'))}</dt><dd>${escapeHtml(receipt.method || t('Method not recorded'))}</dd></div><div><dt>${escapeHtml(t('Amount'))}</dt><dd>${escapeHtml(formatMoney(receipt.amount_cents))}</dd></div></dl>
      <div class="record-card__actions" role="group" aria-label="${escapeHtml(t('Actions'))}"><button class="text-button" type="button" data-action="edit-receipt" data-id="${receiptId}" aria-label="${escapeHtml(t('Edit receipt for'))} ${receiptCustomer}, ${escapeHtml(t('dated'))} ${receiptDate}">${escapeHtml(t('Edit'))}</button><button class="text-button danger" type="button" data-action="delete-receipt" data-id="${receiptId}" aria-label="${escapeHtml(t('Delete receipt for'))} ${receiptCustomer}, ${escapeHtml(t('dated'))} ${receiptDate}">${escapeHtml(t('Delete'))}</button></div>
    </article></li>`;
  }).join('') || `<li class="record-card-empty" role="status">${escapeHtml(emptyMessage)}</li>`;
  return `<ul class="record-card-grid admin-receipt-card-grid" aria-label="${escapeHtml(t('Actual receipts'))}">${cards}</ul>`;
}
