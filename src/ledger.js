import { normalizeIsoDate } from './bill-dates.js';

export function amountToMinorUnits(value, { allowZero = false } = {}) {
  const text = String(value ?? '').trim();
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(text)) {
    throw new Error('Enter a valid PKR amount with up to two decimal places.');
  }
  const amount = Number(text);
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || cents < 0 || (!allowZero && cents === 0)) {
    throw new Error(allowZero ? 'Amount is out of range.' : 'Amount must be greater than zero.');
  }
  return cents;
}

export function formatMoney(minorUnits, locale = 'en-PK') {
  if (minorUnits === null || minorUnits === undefined) return 'Not set';
  const amount = Number(minorUnits);
  if (!Number.isFinite(amount)) return 'Not set';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'PKR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amount / 100);
}

function uniqueRows(rows, keyFor) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = keyFor(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Summarize one organization/month. Receipts alone contribute to collected cash;
 * bill allocations reduce balances but never create a second receipt. Overdue
 * totals use the selected bill period and require an explicit past due date.
 */
export function calculateDashboard({ month, today, customers = [], bills = [], receipts = [], allocations = [] }) {
  if (!/^\d{4}-\d{2}$/.test(month ?? '')) throw new Error('Choose a valid billing month.');
  const todayKey = normalizeIsoDate(today);
  if (!todayKey) throw new Error('Choose a valid local date.');

  const safeCustomers = uniqueRows(customers, (row) => row.id);
  const safeBills = uniqueRows(bills, (row) => `${row.organization_id ?? ''}:${row.id}`);
  const safeReceipts = uniqueRows(receipts, (row) => `${row.organization_id ?? ''}:${row.id}`);
  const safeAllocations = uniqueRows(allocations, (row) =>
    `${row.organization_id ?? ''}:${row.receipt_id}:${row.bill_id}`);
  const customerNames = new Map(safeCustomers.map((row) => [row.id, row.name]));
  const monthBills = safeBills.filter((row) => String(row.period ?? '').slice(0, 7) === month);
  const monthBillIds = new Set(monthBills.map((row) => `${row.organization_id ?? ''}:${row.id}`));
  const monthBillCustomerIds = new Set(monthBills.map((row) => row.customer_id).filter(Boolean));
  const appliedByBill = new Map();
  let creditAppliedCents = 0;

  for (const allocation of safeAllocations) {
    const key = `${allocation.organization_id ?? ''}:${allocation.bill_id}`;
    appliedByBill.set(key, (appliedByBill.get(key) ?? 0) + Number(allocation.amount_cents || 0));
    if (monthBillIds.has(key) && allocation.allocation_kind === 'carry-forward') {
      creditAppliedCents += Number(allocation.amount_cents || 0);
    }
  }

  const pricedBills = monthBills.filter((row) => row.amount_due_cents !== null && row.amount_due_cents !== undefined);
  const unpricedBillCount = monthBills.length - pricedBills.length;
  const billedCents = pricedBills.reduce((sum, row) => sum + Number(row.amount_due_cents || 0), 0);
  const outstandingForBill = (bill) => {
    const key = `${bill.organization_id ?? ''}:${bill.id}`;
    const amount = Number(bill.amount_due_cents || 0);
    return Math.max(0, amount - (appliedByBill.get(key) ?? 0));
  };
  const outstandingCents = pricedBills.reduce((sum, bill) => sum + outstandingForBill(bill), 0);
  const overdueBills = monthBills.filter((bill) => {
    if (bill.amount_due_cents === null || bill.amount_due_cents === undefined) return false;
    const dueDate = normalizeIsoDate(bill.due_date);
    return Boolean(dueDate && dueDate < todayKey && outstandingForBill(bill) > 0);
  });
  const overdueCents = overdueBills.reduce((sum, bill) => sum + outstandingForBill(bill), 0);
  const overdueAccountCount = new Set(overdueBills.map((bill) => bill.customer_id).filter(Boolean)).size;
  const activeCustomers = safeCustomers.filter((row) => !row.archived && row.service_status === 'active');
  const cashReceivedCents = safeReceipts
    .filter((row) => String(row.received_on ?? '').slice(0, 7) === month)
    .reduce((sum, row) => sum + Number(row.amount_cents || 0), 0);

  return {
    activeCustomers: activeCustomers.length,
    customerCount: safeCustomers.length,
    billedCents,
    pricedBillCount: pricedBills.length,
    unpricedBillCount,
    cashReceivedCents,
    outstandingCents,
    creditAppliedCents,
    overdueCents,
    overdueBillCount: overdueBills.length,
    overdueAccountCount,
    missingActiveBillSnapshotCount: activeCustomers.filter((customer) => !monthBillCustomerIds.has(customer.id)).length,
    receiptCount: safeReceipts.filter((row) => String(row.received_on ?? '').slice(0, 7) === month).length,
    monthBills,
    customerNames,
    appliedByBill,
  };
}
