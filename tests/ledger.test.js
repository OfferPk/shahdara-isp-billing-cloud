import test from 'node:test';
import assert from 'node:assert/strict';
import { amountToMinorUnits, calculateDashboard } from '../src/ledger.js';

const org = 'synthetic-org';

test('amount parser stores exact minor units and rejects malformed values', () => {
  assert.equal(amountToMinorUnits('1250.50'), 125050);
  assert.equal(amountToMinorUnits('0', { allowZero: true }), 0);
  assert.throws(() => amountToMinorUnits(''), /valid PKR amount/);
  assert.throws(() => amountToMinorUnits('2.555'), /valid PKR amount/);
  assert.throws(() => amountToMinorUnits('0'), /greater than zero/);
});

test('dashboard counts dated receipts once and never adds credit allocations to cash', () => {
  const summary = calculateDashboard({
    month: '2026-02',
    today: '2026-02-15',
    customers: [
      { id: 'customer-1', name: 'Synthetic Customer', service_status: 'active', archived: false },
      { id: 'customer-1', name: 'Duplicate synthetic row', service_status: 'active', archived: false },
    ],
    bills: [
      { organization_id: org, id: 'bill-feb', period: '2026-02-01', amount_due_cents: 10000 },
      { organization_id: org, id: 'bill-feb', period: '2026-02-01', amount_due_cents: 10000 },
      { organization_id: org, id: 'bill-mar', period: '2026-03-01', amount_due_cents: 9000 },
    ],
    receipts: [
      { organization_id: org, id: 'receipt-1', received_on: '2026-01-04', amount_cents: 15000 },
      { organization_id: org, id: 'receipt-2', received_on: '2026-02-07', amount_cents: 2500 },
      { organization_id: org, id: 'receipt-2', received_on: '2026-02-07', amount_cents: 2500 },
    ],
    allocations: [
      { organization_id: org, receipt_id: 'receipt-1', bill_id: 'bill-feb', amount_cents: 10000, allocation_kind: 'carry-forward' },
      { organization_id: org, receipt_id: 'receipt-1', bill_id: 'bill-feb', amount_cents: 10000, allocation_kind: 'carry-forward' },
      { organization_id: org, receipt_id: 'receipt-2', bill_id: 'bill-feb', amount_cents: 2500, allocation_kind: 'same-month' },
    ],
  });

  assert.equal(summary.customerCount, 1);
  assert.equal(summary.activeCustomers, 1);
  assert.equal(summary.billedCents, 10000);
  assert.equal(summary.pricedBillCount, 1);
  assert.equal(summary.unpricedBillCount, 0);
  assert.equal(summary.cashReceivedCents, 2500);
  assert.equal(summary.receiptCount, 1);
  assert.equal(summary.creditAppliedCents, 10000);
  assert.equal(summary.outstandingCents, 0);
});

test('a payment on an unpriced bill is still cash but creates no displayed bill balance', () => {
  const summary = calculateDashboard({
    month: '2026-04',
    today: '2026-04-15',
    bills: [{ organization_id: org, id: 'unpriced', period: '2026-04-01', amount_due_cents: null }],
    receipts: [{ organization_id: org, id: 'cash-unpriced', received_on: '2026-04-02', amount_cents: 7000 }],
    allocations: [],
  });
  assert.equal(summary.billedCents, 0);
  assert.equal(summary.pricedBillCount, 0);
  assert.equal(summary.unpricedBillCount, 1);
  assert.equal(summary.cashReceivedCents, 7000);
  assert.equal(summary.outstandingCents, 0);
});

test('credit allocated to a future month does not count as cash received in that month', () => {
  const summary = calculateDashboard({
    month: '2026-03',
    today: '2026-03-15',
    bills: [{ organization_id: org, id: 'march', period: '2026-03-01', amount_due_cents: 6000 }],
    receipts: [{ organization_id: org, id: 'jan-receipt', received_on: '2026-01-10', amount_cents: 6000 }],
    allocations: [{ organization_id: org, receipt_id: 'jan-receipt', bill_id: 'march', amount_cents: 6000, allocation_kind: 'carry-forward' }],
  });
  assert.equal(summary.cashReceivedCents, 0);
  assert.equal(summary.creditAppliedCents, 6000);
  assert.equal(summary.outstandingCents, 0);
});

test('overdue totals require an explicit past due date and positive priced balance, counting each account once', () => {
  const summary = calculateDashboard({
    month: '2026-02',
    today: '2026-02-15',
    customers: [
      { id: 'customer-a', service_status: 'active', archived: false },
      { id: 'customer-b', service_status: 'active', archived: false },
      { id: 'customer-c', service_status: 'active', archived: false },
      { id: 'customer-d', service_status: 'active', archived: false },
      { id: 'customer-e', service_status: 'active', archived: false },
      { id: 'customer-f', service_status: 'active', archived: false },
    ],
    bills: [
      { organization_id: org, id: 'overdue-open', customer_id: 'customer-a', period: '2026-01-01', amount_due_cents: 10000, due_date: '2026-02-10' },
      { organization_id: org, id: 'overdue-partial', customer_id: 'customer-a', period: '2026-02-01', amount_due_cents: 8000, due_date: '2026-02-14' },
      { organization_id: org, id: 'overdue-other-account', customer_id: 'customer-b', period: '2026-01-01', amount_due_cents: 2000, due_date: '2026-02-01' },
      { organization_id: org, id: 'overdue-paid', customer_id: 'customer-c', period: '2026-01-01', amount_due_cents: 4000, due_date: '2026-02-01' },
      { organization_id: org, id: 'no-explicit-date', customer_id: 'customer-d', period: '2026-01-01', amount_due_cents: 6000, due_date: null },
      { organization_id: org, id: 'due-today', customer_id: 'customer-e', period: '2026-02-01', amount_due_cents: 7000, due_date: '2026-02-15' },
      { organization_id: org, id: 'due-in-future', customer_id: 'customer-f', period: '2026-02-01', amount_due_cents: 9000, due_date: '2026-02-16' },
      { organization_id: org, id: 'unpriced-past-date', customer_id: 'customer-d', period: '2026-01-01', amount_due_cents: null, due_date: '2026-02-01' },
    ],
    allocations: [
      { organization_id: org, receipt_id: 'receipt-partial', bill_id: 'overdue-partial', amount_cents: 3000, allocation_kind: 'same-month' },
      { organization_id: org, receipt_id: 'receipt-paid', bill_id: 'overdue-paid', amount_cents: 4000, allocation_kind: 'same-month' },
    ],
  });

  assert.equal(summary.overdueCents, 17000);
  assert.equal(summary.overdueBillCount, 3);
  assert.equal(summary.overdueAccountCount, 2);
});

test('selected-month unpriced and missing-snapshot counts are scoped and deduplicate customer rows', () => {
  const summary = calculateDashboard({
    month: '2026-02',
    today: '2026-02-15',
    customers: [
      { id: 'customer-has-priced-bill', service_status: 'active', archived: false },
      { id: 'customer-no-bill', service_status: 'active', archived: false },
      { id: 'customer-unpriced-bill', service_status: 'active', archived: false },
      { id: 'customer-no-bill', service_status: 'active', archived: false },
      { id: 'customer-archived', service_status: 'active', archived: true },
      { id: 'customer-offline', service_status: 'offline', archived: false },
    ],
    bills: [
      { organization_id: org, id: 'feb-priced', customer_id: 'customer-has-priced-bill', period: '2026-02-01', amount_due_cents: 5000 },
      { organization_id: org, id: 'feb-unpriced', customer_id: 'customer-unpriced-bill', period: '2026-02-01', amount_due_cents: null },
      { organization_id: org, id: 'feb-unpriced', customer_id: 'customer-unpriced-bill', period: '2026-02-01', amount_due_cents: null },
      { organization_id: org, id: 'jan-unpriced', customer_id: 'customer-no-bill', period: '2026-01-01', amount_due_cents: null },
    ],
  });

  assert.equal(summary.customerCount, 5);
  assert.equal(summary.unpricedBillCount, 1);
  assert.equal(summary.missingActiveBillSnapshotCount, 1);
});

test('cash remains receipt-date based while allocations reduce pending balance separately', () => {
  const summary = calculateDashboard({
    month: '2026-02',
    today: '2026-02-15',
    bills: [
      { organization_id: org, id: 'feb-bill', customer_id: 'customer-a', period: '2026-02-01', amount_due_cents: 10000 },
    ],
    receipts: [
      { organization_id: org, id: 'feb-receipt', received_on: '2026-02-05', amount_cents: 2000 },
      { organization_id: org, id: 'jan-receipt', received_on: '2026-01-31', amount_cents: 3000 },
    ],
    allocations: [
      { organization_id: org, receipt_id: 'feb-receipt', bill_id: 'feb-bill', amount_cents: 2000, allocation_kind: 'same-month' },
      { organization_id: org, receipt_id: 'jan-receipt', bill_id: 'feb-bill', amount_cents: 3000, allocation_kind: 'carry-forward' },
    ],
  });

  assert.equal(summary.cashReceivedCents, 2000);
  assert.equal(summary.receiptCount, 1);
  assert.equal(summary.creditAppliedCents, 3000);
  assert.equal(summary.outstandingCents, 5000);
});

test('dashboard calculation rejects an invalid local date instead of guessing overdue status', () => {
  assert.throws(() => calculateDashboard({ month: '2026-02', today: '2026-02-30' }), /valid local date/);
});
