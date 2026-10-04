import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdminBillRows } from '../src/admin-bills.js';
import { buildCustomerListRows } from '../src/customer-list.js';

const ROW_COUNT = 10_000;

function syntheticInputs() {
  const customers = Array.from({ length: ROW_COUNT }, (_, index) => ({
    id: `synthetic-customer-${index}`,
    customer_number: index + 1,
    name: `Synthetic Customer ${index}`,
    plan_name: 'Synthetic Plan',
    service_address: `Synthetic Area ${index % 25}`,
    service_status: 'active',
    archived: false,
  }));
  const bills = customers.map((customer, index) => ({
    id: `synthetic-bill-${index}`,
    customer_id: customer.id,
    period: '2026-10-01',
    amount_due_cents: 10_000 + index,
    issued_on: '2026-10-01',
    due_date: '2026-10-31',
    plan_snapshot: 'Synthetic Plan',
  }));
  const allocations = bills.map((bill, index) => ({
    bill_id: bill.id,
    customer_id: bill.customer_id,
    amount_cents: index % 2 ? 2_500 : 1_250,
    allocation_kind: index % 2 ? 'same-month' : 'carry-forward',
  }));
  const receipts = bills.map((bill, index) => ({
    id: `synthetic-receipt-${index}`,
    origin_bill_id: bill.id,
    customer_id: bill.customer_id,
    received_on: '2026-10-10',
    amount_cents: index % 2 ? 2_500 : 1_250,
    method: 'synthetic',
  }));
  const privateDetails = customers.map((customer) => ({
    customer_id: customer.id,
    phone: '03000000000',
    connection_date: '2026-01-01',
  }));
  return { customers, bills, allocations, receipts, privateDetails };
}

function guardLinearReads(rows, maxPasses = 2) {
  let indexedReads = 0;
  const maximumReads = rows.length * maxPasses;
  const guardedRows = new Proxy(rows, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
        indexedReads += 1;
        if (indexedReads > maximumReads) {
          throw new Error(`source array exceeded its ${maxPasses}-pass read budget`);
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { rows: guardedRows, getIndexedReads: () => indexedReads, maximumReads };
}

function guardedInputs(maxPasses = 2) {
  const source = syntheticInputs();
  const guarded = Object.fromEntries(Object.entries(source).map(([name, rows]) => [
    name,
    guardLinearReads(rows, maxPasses),
  ]));
  return {
    values: Object.fromEntries(Object.entries(guarded).map(([name, guard]) => [name, guard.rows])),
    guards: guarded,
  };
}

test('10k synthetic Admin bill rows are built with a bounded number of source-array reads', () => {
  const { values, guards } = guardedInputs();
  const rows = buildAdminBillRows({ ...values, today: '2026-10-05' });
  assert.equal(rows.length, ROW_COUNT);
  for (const name of ['customers', 'bills', 'allocations', 'receipts', 'privateDetails']) {
    assert.ok(guards[name].getIndexedReads() <= guards[name].maximumReads,
      `${name} must stay within a constant number of source-array passes`);
  }
});

test('10k synthetic customer rows are built with a bounded number of source-array reads', () => {
  const { values, guards } = guardedInputs();
  const rows = buildCustomerListRows({ ...values, currentMonth: '2026-10' });
  assert.equal(rows.length, ROW_COUNT);
  for (const name of ['customers', 'bills', 'allocations', 'receipts', 'privateDetails']) {
    assert.ok(guards[name].getIndexedReads() <= guards[name].maximumReads,
      `${name} must stay within a constant number of source-array passes`);
  }
});
