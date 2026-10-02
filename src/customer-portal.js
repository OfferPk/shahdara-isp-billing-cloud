function monthKey(value) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-|$)/.exec(String(value ?? ''));
  return match ? `${match[1]}-${match[2]}` : '';
}

function sumCents(rows) {
  return rows.reduce((sum, row) => sum + Number(row.amount_cents || 0), 0);
}

export function formatBillingMonth(month, locale = 'en-PK') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month ?? ''))) return 'Month not available';
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month}-01T00:00:00.000Z`));
}

export function getCustomerBillingMonths({ customerId, bills = [], receipts = [] } = {}) {
  return [...new Set([
    ...bills.filter((bill) => bill.customer_id === customerId).map((bill) => monthKey(bill.period)),
    ...receipts.filter((receipt) => receipt.customer_id === customerId).map((receipt) => monthKey(receipt.received_on)),
  ].filter(Boolean))].sort((a, b) => b.localeCompare(a));
}

/**
 * Keep the history view inside one already-RLS-scoped customer account. The
 * month filter applies to bill period and receipt date; the date range narrows
 * only the actual receipt list, never the bill's complete ledger balance.
 */
export function filterCustomerBillingData({
  customerId,
  bills = [],
  receipts = [],
  allocations = [],
  month = '',
  fromDate = '',
  throughDate = '',
} = {}) {
  const customerBills = bills.filter((bill) => bill.customer_id === customerId);
  const customerReceipts = receipts.filter((receipt) => receipt.customer_id === customerId);
  const invalidDateRange = Boolean(fromDate && throughDate && fromDate > throughDate);
  const visibleBills = customerBills.filter((bill) => !month || monthKey(bill.period) === month);
  const visibleReceipts = customerReceipts.filter((receipt) => {
    const receivedOn = String(receipt.received_on ?? '');
    if (invalidDateRange || (month && monthKey(receivedOn) !== month)) return false;
    if (fromDate && receivedOn < fromDate) return false;
    if (throughDate && receivedOn > throughDate) return false;
    return true;
  });
  const visibleBillIds = new Set(visibleBills.map((bill) => bill.id));
  const visibleAllocations = allocations.filter((allocation) =>
    allocation.customer_id === customerId && visibleBillIds.has(allocation.bill_id));

  return {
    bills: visibleBills,
    receipts: visibleReceipts,
    allocations: visibleAllocations,
    totalBills: customerBills.length,
    totalReceipts: customerReceipts.length,
    invalidDateRange,
  };
}

/** Actual receipts are cash; allocations (especially carry-forward credit) are separate. */
export function summarizeCustomerBill(bill, receipts = [], allocations = []) {
  const billReceipts = receipts.filter((receipt) =>
    receipt.customer_id === bill.customer_id && receipt.origin_bill_id === bill.id);
  const billAllocations = allocations.filter((allocation) =>
    allocation.customer_id === bill.customer_id && allocation.bill_id === bill.id);
  const cashAppliedCents = billAllocations
    .filter((allocation) => allocation.allocation_kind === 'same-month')
    .reduce((sum, allocation) => sum + Number(allocation.amount_cents || 0), 0);
  const creditAppliedCents = billAllocations
    .filter((allocation) => allocation.allocation_kind === 'carry-forward')
    .reduce((sum, allocation) => sum + Number(allocation.amount_cents || 0), 0);
  const appliedCents = cashAppliedCents + creditAppliedCents;
  const isPriced = bill.amount_due_cents !== null && bill.amount_due_cents !== undefined;
  const balanceCents = isPriced
    ? Math.max(0, Number(bill.amount_due_cents) - appliedCents)
    : null;

  return {
    receiptCashCents: sumCents(billReceipts),
    cashAppliedCents,
    creditAppliedCents,
    appliedCents,
    balanceCents,
    status: !isPriced ? 'not-priced' : balanceCents === 0 ? 'paid' : appliedCents > 0 ? 'partial' : 'unpaid',
  };
}

function isValidTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function formatIncidentTimestamp(value, locale = 'en-PK') {
  if (!isValidTimestamp(value)) return 'Time not available';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function buildIncidentTimeline(incident, t = (value) => value) {
  const status = incident.status === 'open' || incident.status === 'resolved' ? incident.status : 'unknown';
  const statusLabel = status === 'open' ? t('In progress') : status === 'resolved' ? t('Resolved') : t('Status not available');
  const eventDefinitions = [
    ['reported_at', t('Reported')],
    ['offline_at', t('Service went offline')],
    ['restored_at', t('Service restored')],
  ];
  const events = eventDefinitions
    .filter(([field]) => isValidTimestamp(incident[field]))
    .map(([field, label], index) => ({ label, datetime: incident[field], index }))
    .sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime) || a.index - b.index)
    .map(({ label, datetime }) => ({ label, datetime, displayTime: formatIncidentTimestamp(datetime) }));
  const restorationMessage = isValidTimestamp(incident.restored_at)
    ? `${t('Restoration recorded')} ${formatIncidentTimestamp(incident.restored_at)}.`
    : status === 'resolved'
      ? t('Marked resolved; a restoration time is not recorded.')
      : status === 'open'
        ? t('Service is marked in progress; a restoration time is not recorded.')
        : t('A restoration time is not recorded.');

  return { status, statusLabel, events, restorationMessage };
}
