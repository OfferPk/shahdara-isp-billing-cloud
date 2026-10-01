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
    bills: [{ organization_id: org, id: 'march', period: '2026-03-01', amount_due_cents: 6000 }],
    receipts: [{ organization_id: org, id: 'jan-receipt', received_on: '2026-01-10', amount_cents: 6000 }],
    allocations: [{ organization_id: org, receipt_id: 'jan-receipt', bill_id: 'march', amount_cents: 6000, allocation_kind: 'carry-forward' }],
  });
  assert.equal(summary.cashReceivedCents, 0);
  assert.equal(summary.creditAppliedCents, 6000);
  assert.equal(summary.outstandingCents, 0);
});
