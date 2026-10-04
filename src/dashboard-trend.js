import { calculateDashboard } from './ledger.js';
import { localDateKey } from './cashflow.js';

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

function validMonth(value) {
  return MONTH_PATTERN.test(String(value ?? ''));
}

export function safeCents(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

export function addCents(target, property, amount) {
  const next = target[property] + safeCents(amount);
  if (Number.isSafeInteger(next)) target[property] = next;
}

export function uniqueBy(rows, keyFor) {
  const seen = new Set();
  return (rows ?? []).filter((row) => {
    const key = keyFor(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function rowKey(row, idField = 'id') {
  const id = row?.[idField];
  return id ? `${row.organization_id ?? ''}:${id}` : '';
}

export function monthSequence(endMonth, count = 6) {
  const match = MONTH_PATTERN.exec(String(endMonth ?? ''));
  if (!match) return [];
  const end = new Date(Number(match[1]), Number(match[2]) - 1, 1, 12);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(end.getFullYear(), end.getMonth() - (count - index - 1), 1, 12);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  });
}

export function monthLabel(month) {
  const [year, numericMonth] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-PK', { month: 'short', year: '2-digit' })
    .format(new Date(year, numericMonth - 1, 1, 12));
}

function observedMonths(months, bills, receipts) {
  return months.filter((month) => bills.some((bill) => String(bill.period ?? '').slice(0, 7) === month)
    || receipts.some((receipt) => localDateKey(receipt.received_on).slice(0, 7) === month));
}

function buildCalendarBuckets(month, view) {
  const match = MONTH_PATTERN.exec(String(month ?? ''));
  if (!match) return [];
  const year = Number(match[1]);
  const numericMonth = Number(match[2]);
  const dayCount = new Date(year, numericMonth, 0, 12).getDate();
  if (view === 'day') {
    return Array.from({ length: dayCount }, (_, index) => {
      const day = index + 1;
      const date = `${month}-${String(day).padStart(2, '0')}`;
      return { key: date, label: String(day), fullLabel: new Intl.DateTimeFormat('en-PK', { month: 'short', day: 'numeric' }).format(new Date(year, numericMonth - 1, day, 12)), billedCents: 0, collectedCents: 0, pendingCents: 0 };
    });
  }
  const buckets = [];
  for (let start = 1; start <= dayCount; start += 7) {
    const end = Math.min(start + 6, dayCount);
    const week = buckets.length + 1;
    buckets.push({
      key: `${month}-week-${week}`,
      label: `${start}–${end}`,
      fullLabel: `${monthLabel(month)} ${start}–${end}`,
      startDate: `${month}-${String(start).padStart(2, '0')}`,
      endDate: `${month}-${String(end).padStart(2, '0')}`,
      billedCents: 0,
      collectedCents: 0,
      pendingCents: 0,
    });
  }
  return buckets;
}

function bucketForDate(points, view, dateValue, month) {
  const date = localDateKey(dateValue);
  if (!date || !date.startsWith(`${month}-`)) return null;
  if (view === 'day') return points.find((point) => point.key === date) ?? null;
  const day = Number(date.slice(-2));
  return points[Math.floor((day - 1) / 7)] ?? null;
}

/**
 * Monthly points reuse the canonical billing engine. Daily and weekly views use
 * recorded bill-snapshot creation dates, actual receipt dates, and current open
 * balances grouped by recorded due date; they are explicitly date-based activity
 * views, not a reconstruction of historical invoice-settlement balances.
 */
export function buildDashboardTrendSeries({
  month,
  today,
  bills = [],
  receipts = [],
  allocations = [],
  billRows = [],
  view = 'month',
} = {}) {
  if (!validMonth(month) || !['month', 'week', 'day'].includes(view)) {
    return { view: 'month', month: '', points: [], hasRecords: false, needsMoreMonths: false };
  }

  const safeBills = uniqueBy(bills, (row) => rowKey(row));
  const safeReceipts = uniqueBy(receipts, (row) => rowKey(row));
  if (view === 'month') {
    const observed = observedMonths(monthSequence(month), safeBills, safeReceipts);
    const points = observed.map((period) => {
      const totals = calculateDashboard({ month: period, today, bills: safeBills, receipts: safeReceipts, allocations });
      return {
        key: period,
        label: monthLabel(period),
        fullLabel: period,
        billedCents: totals.billedCents,
        collectedCents: totals.cashReceivedCents,
        pendingCents: totals.outstandingCents,
      };
    });
    return { view, month, points, hasRecords: points.length > 0, needsMoreMonths: points.length < 2 };
  }

  const points = buildCalendarBuckets(month, view);
  if (!points.length) return { view, month, points, hasRecords: false, needsMoreMonths: false };
  let datedRecordCount = 0;
  for (const bill of safeBills) {
    const point = bucketForDate(points, view, bill.created_at, month);
    if (!point) continue;
    datedRecordCount += 1;
    if (bill.amount_due_cents !== null && bill.amount_due_cents !== undefined) {
      addCents(point, 'billedCents', bill.amount_due_cents);
    }
  }
  for (const receipt of safeReceipts) {
    const point = bucketForDate(points, view, receipt.received_on, month);
    if (!point) continue;
    datedRecordCount += 1;
    addCents(point, 'collectedCents', receipt.amount_cents);
  }
  for (const row of uniqueBy(billRows, (entry) => rowKey(entry?.bill ?? entry))) {
    if (!Number.isSafeInteger(Number(row.balanceCents)) || Number(row.balanceCents) <= 0 || !row.dueDate) continue;
    const point = bucketForDate(points, view, row.dueDate, month);
    if (!point) continue;
    datedRecordCount += 1;
    addCents(point, 'pendingCents', row.balanceCents);
  }
  return { view, month, points, hasRecords: datedRecordCount > 0, needsMoreMonths: false };
}
