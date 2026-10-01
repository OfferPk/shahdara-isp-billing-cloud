import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIncidentTimeline,
  filterCustomerBillingData,
  formatBillingMonth,
  getCustomerBillingMonths,
  summarizeCustomerBill,
} from '../src/customer-portal.js';

const customerId = 'synthetic-customer-a';
const otherCustomerId = 'synthetic-customer-b';

test('billing month options and combined month/date filters remain account-scoped and isolated', () => {
  const bills = [
    { id: 'bill-jan', customer_id: customerId, period: '2026-01-01', amount_due_cents: 9000 },
    { id: 'bill-feb', customer_id: customerId, period: '2026-02-01', amount_due_cents: 10000 },
    { id: 'other-feb', customer_id: otherCustomerId, period: '2026-02-01', amount_due_cents: 12000 },
  ];
  const receipts = [
    { id: 'receipt-jan', customer_id: customerId, origin_bill_id: 'bill-jan', received_on: '2026-01-12', amount_cents: 9000 },
    { id: 'receipt-feb-early', customer_id: customerId, origin_bill_id: 'bill-feb', received_on: '2026-02-03', amount_cents: 2000 },
    { id: 'receipt-feb-late', customer_id: customerId, origin_bill_id: 'bill-feb', received_on: '2026-02-18', amount_cents: 3000 },
    { id: 'other-receipt', customer_id: otherCustomerId, origin_bill_id: 'other-feb', received_on: '2026-02-20', amount_cents: 4000 },
  ];
  const allocations = [
    { customer_id: customerId, receipt_id: 'receipt-feb-early', bill_id: 'bill-feb', amount_cents: 2000, allocation_kind: 'same-month' },
    { customer_id: customerId, receipt_id: 'receipt-jan', bill_id: 'bill-feb', amount_cents: 1000, allocation_kind: 'carry-forward' },
    { customer_id: customerId, receipt_id: 'receipt-jan', bill_id: 'bill-jan', amount_cents: 9000, allocation_kind: 'same-month' },
    { customer_id: otherCustomerId, receipt_id: 'other-receipt', bill_id: 'other-feb', amount_cents: 4000, allocation_kind: 'same-month' },
  ];

  assert.deepEqual(getCustomerBillingMonths({ customerId, bills, receipts }), ['2026-02', '2026-01']);
  assert.equal(formatBillingMonth('2026-02'), 'February 2026');
  const result = filterCustomerBillingData({
    customerId,
    bills,
    receipts,
    allocations,
    month: '2026-02',
    fromDate: '2026-02-10',
    throughDate: '2026-02-28',
  });

  assert.deepEqual(result.bills.map((row) => row.id), ['bill-feb']);
  assert.deepEqual(result.receipts.map((row) => row.id), ['receipt-feb-late']);
  assert.deepEqual(result.allocations.map((row) => row.bill_id), ['bill-feb', 'bill-feb']);
  assert.equal(result.totalBills, 2);
  assert.equal(result.totalReceipts, 3);
  assert.equal(result.invalidDateRange, false);
  assert.equal(bills.length, 3, 'filtering does not mutate source bill rows');
  assert.equal(receipts.length, 4, 'filtering does not mutate source receipt rows');
});

test('receipt date filters do not erase complete allocations used for bill balances', () => {
  const result = filterCustomerBillingData({
    customerId,
    bills: [{ id: 'bill-feb', customer_id: customerId, period: '2026-02-01' }],
    receipts: [{ id: 'receipt-feb', customer_id: customerId, received_on: '2026-02-18', origin_bill_id: 'bill-feb', amount_cents: 3000 }],
    allocations: [
      { customer_id: customerId, bill_id: 'bill-feb', amount_cents: 2000, allocation_kind: 'same-month' },
      { customer_id: customerId, bill_id: 'bill-feb', amount_cents: 1000, allocation_kind: 'carry-forward' },
    ],
    fromDate: '2026-02-19',
  });

  assert.deepEqual(result.receipts, []);
  assert.equal(result.allocations.length, 2);
});

test('invalid receipt date ranges are reported and never show a misleading partial result', () => {
  const result = filterCustomerBillingData({
    customerId,
    bills: [{ id: 'bill-feb', customer_id: customerId, period: '2026-02-01' }],
    receipts: [{ id: 'receipt-feb', customer_id: customerId, received_on: '2026-02-18', amount_cents: 3000 }],
    fromDate: '2026-02-25',
    throughDate: '2026-02-10',
  });

  assert.equal(result.invalidDateRange, true);
  assert.equal(result.bills.length, 1);
  assert.deepEqual(result.receipts, []);
});

test('bill detail keeps actual receipt cash and carry-forward credit separate', () => {
  const summary = summarizeCustomerBill(
    { id: 'bill-feb', customer_id: customerId, amount_due_cents: 15000 },
    [
      { customer_id: customerId, origin_bill_id: 'bill-feb', amount_cents: 5000 },
      { customer_id: otherCustomerId, origin_bill_id: 'bill-feb', amount_cents: 9000 },
    ],
    [
      { customer_id: customerId, bill_id: 'bill-feb', amount_cents: 2000, allocation_kind: 'same-month' },
      { customer_id: customerId, bill_id: 'bill-feb', amount_cents: 5000, allocation_kind: 'carry-forward' },
      { customer_id: otherCustomerId, bill_id: 'bill-feb', amount_cents: 9000, allocation_kind: 'same-month' },
    ],
  );

  assert.deepEqual(summary, {
    receiptCashCents: 5000,
    cashAppliedCents: 2000,
    creditAppliedCents: 5000,
    appliedCents: 7000,
    balanceCents: 8000,
    status: 'partial',
  });
});

test('unpriced bill remains not priced, not zero, while separately recorded cash remains visible', () => {
  const summary = summarizeCustomerBill(
    { id: 'unpriced-bill', customer_id: customerId, amount_due_cents: null },
    [{ customer_id: customerId, origin_bill_id: 'unpriced-bill', amount_cents: 7000 }],
    [],
  );

  assert.equal(summary.receiptCashCents, 7000);
  assert.equal(summary.balanceCents, null);
  assert.equal(summary.status, 'not-priced');
});

test('incident timeline uses only recorded milestones and communicates recovery status', () => {
  const open = buildIncidentTimeline({
    status: 'open',
    reported_at: '2026-02-01T10:00:00Z',
    offline_at: '2026-02-01T09:30:00Z',
    restored_at: null,
  });
  assert.equal(open.statusLabel, 'In progress');
  assert.deepEqual(open.events.map((event) => event.label), ['Service went offline', 'Reported']);
  assert.match(open.restorationMessage, /restoration time is not recorded/i);
  assert.equal(open.events.some((event) => event.label === 'Service restored'), false);

  const resolvedWithoutTime = buildIncidentTimeline({
    status: 'resolved',
    reported_at: '2026-02-01T10:00:00Z',
    offline_at: null,
    restored_at: null,
  });
  assert.equal(resolvedWithoutTime.statusLabel, 'Resolved');
  assert.match(resolvedWithoutTime.restorationMessage, /Marked resolved; a restoration time is not recorded/i);

  const restored = buildIncidentTimeline({
    status: 'resolved',
    reported_at: '2026-02-01T10:00:00Z',
    offline_at: '2026-02-01T09:30:00Z',
    restored_at: '2026-02-01T12:00:00Z',
  });
  assert.deepEqual(restored.events.map((event) => event.label), ['Service went offline', 'Reported', 'Service restored']);
  assert.match(restored.restorationMessage, /Restoration recorded/);
});
