import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildAdminBillRows,
  buildWhatsappBillShareHref,
  countAdminBillFilters,
  filterCollectionBillRows,
  filterAdminBillRows,
  renderAdminBillCards,
  renderPrintableReceiptHtml,
} from '../src/admin-bills.js';
import { calculateDashboard, formatMoney } from '../src/ledger.js';
import { saveCustomerWhatsappPhone } from '../src/portal-data.js';

function syntheticRows() {
  return buildAdminBillRows({
    today: '2026-04-10',
    customers: [
      { id: 'customer-overdue', name: 'Amina & Sons', customer_number: 4, plan_name: '50 Mbps', pppoe_username: 'amina-50m' },
      { id: 'customer-paid', name: 'Bilal Fiber', customer_number: 5, plan_name: '30 Mbps', pppoe_username: 'bilal-30m' },
      { id: 'customer-no-date', name: 'No Date Account', customer_number: 6, plan_name: '' },
      { id: 'customer-unpriced', name: 'Unpriced Account', customer_number: 7, plan_name: 'Starter' },
    ],
    privateDetails: [
      { customer_id: 'customer-overdue', phone: '0300 1234567' },
      { customer_id: 'customer-paid', phone: '+923111234567' },
      { customer_id: 'customer-no-date', phone: '03005551234' },
    ],
    bills: [
      { id: 'bill-overdue', invoice_number: 'SIF-202601-4', customer_id: 'customer-overdue', period: '2026-01-01', amount_due_cents: 10000, issued_on: '2026-01-02', due_date: '2026-01-15', plan_snapshot: 'Fiber 50' },
      { id: 'bill-paid', customer_id: 'customer-paid', period: '2026-02-01', amount_due_cents: 6000, due_date: '2026-02-10', plan_snapshot: 'Fiber 30' },
      { id: 'bill-no-date', customer_id: 'customer-no-date', period: '2026-03-01', amount_due_cents: 5000, due_date: null, plan_snapshot: '' },
      { id: 'bill-unpriced', customer_id: 'customer-unpriced', period: '2026-04-01', amount_due_cents: null, due_date: null, plan_snapshot: 'Starter' },
    ],
    receipts: [
      { id: 'receipt-overdue', customer_id: 'customer-overdue', origin_bill_id: 'bill-overdue', received_on: '2026-01-20', amount_cents: 2000, method: 'Cash' },
      { id: 'receipt-paid', customer_id: 'customer-paid', origin_bill_id: 'bill-paid', received_on: '2026-02-08', amount_cents: 6000, method: 'Bank transfer' },
    ],
    allocations: [
      { customer_id: 'customer-overdue', bill_id: 'bill-overdue', amount_cents: 2000, allocation_kind: 'same-month' },
      { customer_id: 'customer-overdue', bill_id: 'bill-overdue', amount_cents: 1000, allocation_kind: 'carry-forward' },
      { customer_id: 'customer-paid', bill_id: 'bill-paid', amount_cents: 6000, allocation_kind: 'same-month' },
    ],
  });
}

test('Admin bill rows use only recorded dates, calculate overdue days, and preserve unpriced status', () => {
  const rows = syntheticRows();
  const overdue = rows.find((row) => row.bill.id === 'bill-overdue');
  const paid = rows.find((row) => row.bill.id === 'bill-paid');
  const noDate = rows.find((row) => row.bill.id === 'bill-no-date');
  const unpriced = rows.find((row) => row.bill.id === 'bill-unpriced');

  assert.equal(overdue.status, 'unpaid');
  assert.equal(overdue.isOverdue, true);
  assert.equal(overdue.overdueDays, 85);
  assert.equal(overdue.issuedOn, '2026-01-02');
  assert.equal(overdue.dueLabel, 'Due date: 2026-01-15');
  assert.equal(overdue.balanceCents, 7000);
  assert.equal(overdue.cashReceiptCents, 2000);
  assert.equal(overdue.creditAppliedCents, 1000);
  assert.equal(overdue.packageName, 'Fiber 50');
  assert.equal(paid.status, 'paid');
  assert.equal(paid.isOverdue, false, 'a past due date does not override a zero balance');
  assert.equal(paid.overdueDays, 0);
  assert.equal(noDate.status, 'unpaid');
  assert.equal(noDate.isOverdue, false, 'no due date means no overdue claim');
  assert.equal(noDate.dueLabel, 'Due date not recorded');
  assert.equal(noDate.issuedOn, '');
  assert.equal(unpriced.status, 'not-priced');
  assert.equal(unpriced.balanceCents, null);
  assert.equal(unpriced.dueLabel, 'Due date not recorded');
  assert.equal(unpriced.overdueDays, 0);
});

test('Admin bill row indexes preserve pair-scoped balances, carry-forward credit, receipt sorting, and row order', () => {
  const rows = buildAdminBillRows({
    today: '2026-03-01',
    customers: [
      { id: 'customer-zara', name: 'Zara' },
      { id: 'customer-ayan', name: 'Ayan' },
    ],
    bills: [
      { id: 'shared-bill', customer_id: 'customer-zara', period: '2026-02-01', amount_due_cents: 1000 },
      { id: 'shared-bill', customer_id: 'customer-ayan', period: '2026-02-01', amount_due_cents: 500 },
      { id: 'older-bill', customer_id: 'customer-zara', period: '2026-01-01', amount_due_cents: 300 },
    ],
    allocations: [
      { bill_id: 'shared-bill', customer_id: 'customer-zara', amount_cents: 250, allocation_kind: 'carry-forward' },
      { bill_id: 'shared-bill', customer_id: 'customer-zara', amount_cents: 100, allocation_kind: 'same-month' },
      { bill_id: 'shared-bill', customer_id: 'customer-ayan', amount_cents: 9000, allocation_kind: 'carry-forward' },
      { bill_id: 'older-bill', customer_id: 'customer-zara', amount_cents: 50, allocation_kind: 'same-month' },
    ],
    receipts: [
      { id: 'zara-late', origin_bill_id: 'shared-bill', customer_id: 'customer-zara', received_on: '2026-02-05', amount_cents: 80 },
      { id: 'ayan-only', origin_bill_id: 'shared-bill', customer_id: 'customer-ayan', received_on: '2026-02-03', amount_cents: 40 },
      { id: 'zara-early-1', origin_bill_id: 'shared-bill', customer_id: 'customer-zara', received_on: '2026-02-01', amount_cents: 20 },
      { id: 'zara-early-2', origin_bill_id: 'shared-bill', customer_id: 'customer-zara', received_on: '2026-02-01', amount_cents: 30 },
    ],
  });

  assert.deepEqual(rows.map((row) => [row.bill.id, row.customerName]), [
    ['shared-bill', 'Ayan'],
    ['shared-bill', 'Zara'],
    ['older-bill', 'Zara'],
  ]);
  const zara = rows.find((row) => row.customerName === 'Zara' && row.bill.id === 'shared-bill');
  const ayan = rows.find((row) => row.customerName === 'Ayan');
  assert.deepEqual([zara.appliedCents, zara.balanceCents, zara.creditAppliedCents, zara.cashReceiptCents], [350, 650, 250, 130]);
  assert.deepEqual(zara.receipts.map((receipt) => receipt.id), ['zara-late', 'zara-early-1', 'zara-early-2']);
  assert.deepEqual([ayan.appliedCents, ayan.balanceCents, ayan.creditAppliedCents, ayan.cashReceiptCents], [9000, 0, 9000, 40]);
  assert.deepEqual(ayan.receipts.map((receipt) => receipt.id), ['ayan-only']);
});

test('Admin bill search supports customer name and Admin-only phone, and status counts include overdue as unpaid', () => {
  const rows = syntheticRows();
  assert.deepEqual(filterAdminBillRows(rows, { search: 'AMINA', status: 'all' }).map((row) => row.bill.id), ['bill-overdue']);
  assert.deepEqual(filterAdminBillRows(rows, { search: '0300-123 4567', status: 'unpaid' }).map((row) => row.bill.id), ['bill-overdue']);
  assert.deepEqual(filterAdminBillRows(rows, { search: '+923111234567', status: 'paid' }).map((row) => row.bill.id), ['bill-paid']);
  assert.deepEqual(countAdminBillFilters(rows), { all: 4, unpaid: 2, paid: 1 });
  assert.deepEqual(countAdminBillFilters(rows, { search: 'Amina' }), { all: 1, unpaid: 1, paid: 0 });
});

test('collection drill-down is selected-period-only and excludes due-today, missing-date, paid, and unpriced bills from overdue', () => {
  const rows = buildAdminBillRows({
    today: '2026-04-10',
    customers: [
      { id: 'open-before', name: 'Open Before' },
      { id: 'due-today', name: 'Due Today' },
      { id: 'no-date', name: 'No Date' },
      { id: 'paid', name: 'Paid' },
      { id: 'other-period', name: 'Other Period' },
      { id: 'unpriced', name: 'Unpriced' },
    ],
    bills: [
      { id: 'open-before', customer_id: 'open-before', period: '2026-04-01', amount_due_cents: 10000, due_date: '2026-04-09' },
      { id: 'due-today', customer_id: 'due-today', period: '2026-04-01', amount_due_cents: 5000, due_date: '2026-04-10' },
      { id: 'no-date', customer_id: 'no-date', period: '2026-04-01', amount_due_cents: 5000, due_date: null },
      { id: 'paid', customer_id: 'paid', period: '2026-04-01', amount_due_cents: 5000, due_date: '2026-04-01' },
      { id: 'other-period', customer_id: 'other-period', period: '2026-03-01', amount_due_cents: 9000, due_date: '2026-04-09' },
      { id: 'unpriced', customer_id: 'unpriced', period: '2026-04-01', amount_due_cents: null, due_date: '2026-04-01' },
    ],
    allocations: [{ customer_id: 'paid', bill_id: 'paid', amount_cents: 5000 }],
  });

  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'overdue', period: '2026-04' }).map((row) => row.bill.id), ['open-before']);
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'paid', period: '2026-04' }).map((row) => row.bill.id), ['paid']);
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'all', period: '2026-04' }).map((row) => row.bill.id), ['due-today', 'no-date', 'open-before', 'paid', 'unpriced']);
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'all', period: '2026-03' }).map((row) => row.bill.id), ['other-period']);
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'pending', period: '2026-04' }).map((row) => row.bill.id), ['due-today', 'no-date']);
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'unpriced', period: '2026-04' }).map((row) => row.bill.id), ['unpriced']);
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'overdue', period: '2026-03' }).map((row) => row.bill.id), ['other-period']);
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'overdue', period: '2026-13' }), []);
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'all', period: '2026-13' }), []);
});

test('selected-month unpaid worklist matches Pending and includes positive priced balances without overdue dates', () => {
  const customers = [
    { id: 'past-due' }, { id: 'future-due' }, { id: 'missing-date' },
    { id: 'paid' }, { id: 'unpriced' }, { id: 'older-month' },
  ];
  const bills = [
    { id: 'past-due', customer_id: 'past-due', period: '2026-04-01', amount_due_cents: 10000, due_date: '2026-04-09' },
    { id: 'future-due', customer_id: 'future-due', period: '2026-04-01', amount_due_cents: 5000, due_date: '2026-04-11' },
    { id: 'missing-date', customer_id: 'missing-date', period: '2026-04-01', amount_due_cents: 4000, due_date: null },
    { id: 'paid', customer_id: 'paid', period: '2026-04-01', amount_due_cents: 6000, due_date: '2026-04-01' },
    { id: 'unpriced', customer_id: 'unpriced', period: '2026-04-01', amount_due_cents: null, due_date: '2026-04-01' },
    { id: 'older-month', customer_id: 'older-month', period: '2026-03-01', amount_due_cents: 9000, due_date: '2026-03-05' },
  ];
  const allocations = [
    { customer_id: 'past-due', bill_id: 'past-due', amount_cents: 3000, allocation_kind: 'carry-forward' },
    { customer_id: 'paid', bill_id: 'paid', amount_cents: 6000, allocation_kind: 'same-month' },
  ];
  const rows = buildAdminBillRows({ customers, bills, allocations, today: '2026-04-10' });
  const unpaid = filterCollectionBillRows(rows, { scope: 'unpaid', period: '2026-04' });
  const totals = calculateDashboard({ month: '2026-04', today: '2026-04-10', customers, bills, allocations });

  assert.deepEqual(unpaid.map((row) => row.bill.id).sort(), ['future-due', 'missing-date', 'past-due']);
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'pending', period: '2026-04' }).map((row) => row.bill.id).sort(), ['future-due', 'missing-date']);
  assert.equal(unpaid.reduce((sum, row) => sum + row.balanceCents, 0), totals.outstandingCents);
  assert.equal(totals.outstandingCents, 16000);
  assert.equal(unpaid.find((row) => row.bill.id === 'past-due').isOverdue, true);
  assert.equal(unpaid.find((row) => row.bill.id === 'future-due').isOverdue, false);
  assert.equal(unpaid.find((row) => row.bill.id === 'missing-date').isOverdue, false);
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'unpaid', period: '2026-03' }).map((row) => row.bill.id), ['older-month']);
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'unpaid', period: '2026-13' }), []);
});

test('WhatsApp bill sharing stays active without a saved phone and includes due date and payment methods', () => {
  const rows = syntheticRows();
  const overdue = rows.find((row) => row.bill.id === 'bill-overdue');
  const href = buildWhatsappBillShareHref(overdue);
  assert.match(href, /^https:\/\/api\.whatsapp\.com\/send\?phone=923001234567&text=/);
  const draft = decodeURIComponent(href.split('&text=')[1]);
  assert.match(draft, /\*Shahdara Fiber Net - Bill Reminder\*/);
  assert.match(draft, /Customer: amina-50m \(Account #4\)/);
  assert.match(draft, /Outstanding: Rs 70/);
  assert.match(draft, /Due Date: 2026-01-15/);
  assert.match(draft, /Payment Methods: EasyPaisa \/ Cash/);
  const noDateDraft = decodeURIComponent(buildWhatsappBillShareHref(rows.find((row) => row.bill.id === 'bill-no-date')).split('&text=')[1]);
  assert.match(noDateDraft, /Due Date: Due date not recorded/);
  const noPhoneHref = buildWhatsappBillShareHref({ ...overdue, phone: '' });
  assert.match(noPhoneHref, /^https:\/\/api\.whatsapp\.com\/send\?text=/);
  assert.doesNotMatch(noPhoneHref, /phone=/);
  assert.equal(buildWhatsappBillShareHref(rows.find((row) => row.bill.id === 'bill-unpriced')), '');
});

test('paid bill sharing creates the requested receipt with actual payment details and works without a phone', () => {
  const paid = syntheticRows().find((row) => row.bill.id === 'bill-paid');
  const href = buildWhatsappBillShareHref({ ...paid, phone: '' });
  assert.match(href, /^https:\/\/api\.whatsapp\.com\/send\?text=/);
  const draft = decodeURIComponent(href.slice(href.indexOf('text=') + 5));
  assert.match(draft, /\*Shahdara Fiber Net - Payment Receipt\*/);
  assert.match(draft, /Customer: bilal-30m \(Account #5\)/);
  assert.match(draft, /Bill Month: 2026-02/);
  assert.match(draft, /Amount Paid: Rs 60/);
  assert.match(draft, /Method: Bank transfer/);
  assert.match(draft, /Date: 2026-02-08/);
  assert.match(draft, /Status: PAID \(Clear\)/);
  assert.match(draft, /Shukriya!/);
});

test('bill cards expose Collect only as a prefill, and PDF actions only for actual receipts', () => {
  const rows = syntheticRows();
  const markup = renderAdminBillCards(rows, formatMoney);
  assert.match(markup, /Amina &amp; Sons/);
  assert.match(markup, /Billing Month · 2026-01/);
  assert.match(markup, /Invoice No\. · SIF-202601-4/);
  assert.match(markup, /amina-50m/);
  assert.match(markup, /Issue Date/);
  assert.match(markup, /2026-01-02/);
  assert.match(markup, /Due Date/);
  assert.match(markup, /Overdue by 85 days/);
  assert.match(markup, /data-action="collect-bill" data-id="bill-overdue"/);
  assert.match(markup, /data-action="receive-payment" data-id="bill-overdue"/);
  assert.match(markup, /data-action="view-invoice" data-id="bill-overdue"/);
  assert.match(markup, /data-action="edit-bill" data-id="bill-overdue"/);
  assert.match(markup, /Print \/ Save PDF/);
  assert.match(markup, /data-action="print-receipt" data-id="receipt-overdue"/);
  assert.match(markup, /target="_blank" rel="noopener noreferrer"/);
  assert.match(markup, /class="bill-action bill-action--whatsapp" href="https:\/\/api\.whatsapp\.com\/send\?phone=/);
  assert.match(markup, />Send WhatsApp Bill<\/a>/);
  assert.match(markup, />Share WhatsApp Receipt<\/a>/);
  assert.match(markup, /data-action="edit-customer-phone" data-customer-id="customer-overdue" aria-label="Edit WhatsApp phone for Amina &amp; Sons"/);
  assert.match(markup, /No actual receipt is recorded against this bill/);
  const noPhoneMarkup = renderAdminBillCards([{ ...rows.find((row) => row.bill.id === 'bill-overdue'), phone: '' }], formatMoney);
  assert.match(noPhoneMarkup, /href="https:\/\/api\.whatsapp\.com\/send\?text=/);
  assert.doesNotMatch(noPhoneMarkup, /WhatsApp bill.{0,100}disabled/i);
  const noDateMarkup = renderAdminBillCards([rows.find((row) => row.bill.id === 'bill-no-date')], formatMoney);
  assert.match(noDateMarkup, /Issue date not recorded/);
  assert.match(noDateMarkup, /Due date not recorded/);
  assert.doesNotMatch(noDateMarkup, /Overdue by/);
  assert.match(renderAdminBillCards([rows.find((row) => row.bill.id === 'bill-unpriced')], formatMoney), /class="bill-action bill-action--collect" type="button" disabled/);
  assert.doesNotMatch(renderAdminBillCards([rows.find((row) => row.bill.id === 'bill-no-date')], formatMoney), /data-action="print-receipt"/);
  assert.doesNotMatch(markup, /<script|<img/);
});

test('customer phone saving normalizes Pakistan mobile formats, permits clearing, and rejects invalid numbers before the RPC', async () => {
  const calls = [];
  const supabase = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: args.p_phone, error: null };
    },
  };
  assert.equal(await saveCustomerWhatsappPhone(supabase, {
    organizationId: 'org-1', customerId: 'customer-1', phone: '+92 (311) 123-4567',
  }), '+923111234567');
  assert.deepEqual(calls[0], {
    name: 'set_customer_private_phone',
    args: { p_organization_id: 'org-1', p_customer_id: 'customer-1', p_phone: '+923111234567' },
  });
  assert.equal(await saveCustomerWhatsappPhone(supabase, {
    organizationId: 'org-1', customerId: 'customer-1', phone: '',
  }), '');
  assert.equal(calls.length, 2);
  await assert.rejects(saveCustomerWhatsappPhone(supabase, {
    organizationId: 'org-1', customerId: 'customer-1', phone: '12345',
  }), /Phone must be/);
  assert.equal(calls.length, 2, 'invalid numbers never reach the database');
});

test('printable receipt is built from an existing receipt and never masquerades as a bill balance', () => {
  const html = renderPrintableReceiptHtml({
    receipt: { id: 'receipt-synthetic-1', received_on: '2026-02-08', amount_cents: 6000, method: 'Bank transfer' },
    customer: { name: 'Bilal Fiber' },
    bill: { period: '2026-02-01', amount_due_cents: 6000 },
    organizationName: 'Synthetic ISP',
    formatMoney,
  });
  assert.match(html, /Cash receipt/);
  assert.match(html, /Receipt ID: receipt-synthetic-1/);
  assert.match(html, /Actual amount received/);
  assert.match(html, /Bank transfer/);
  assert.match(html, /balances are determined separately from ledger allocations/);
  assert.doesNotMatch(html, /Outstanding|Paid|Overdue|0300/);
});

test('Collect prefills the existing receipt form only; the saved stable-ID RPC remains the sole cash write', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const collect = main.slice(main.indexOf('function openReceiptFormForBill'), main.indexOf('function openReceiptFormForCustomer'));
  assert.match(collect, /form\.elements\.received_on\.value = localDate\(\)/);
  assert.match(collect, /form\.elements\.amount\.value = \(billRow\.balanceCents \/ 100\)\.toFixed\(2\)/);
  assert.match(collect, /form\.elements\.method\.value = ''/);
  assert.match(collect, /Nothing has been recorded yet/);
  assert.doesNotMatch(collect, /invokeRpc|record_cash_receipt/);

  const receiptSubmit = main.slice(main.indexOf("portalPanel.querySelector('#receipt-form')?.addEventListener"), main.indexOf('function bindAdminActions'));
  assert.match(receiptSubmit, /getReceiptAttempt\(context\)/);
  assert.match(receiptSubmit, /crypto\.randomUUID\(\)/);
  assert.match(receiptSubmit, /invokeRpc\(supabase, 'record_cash_receipt'/);
  assert.match(receiptSubmit, /p_receipt_id: attempt\.id/);
  assert.match(receiptSubmit, /clearReceiptAttempt\(\)/);
});

test('private phone search stays in Admin code and Customer Portal rendering never selects or renders it', async () => {
  const [main, portalData] = await Promise.all([
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/portal-data.js', import.meta.url), 'utf8'),
  ]);
  const customerView = main.slice(main.indexOf('function renderCustomer()'), main.indexOf('async function refreshCurrentContext('));
  assert.match(main, /function currentAdminBillRows\(\)[\s\S]*privateDetails: pageState\.rows\.privateCustomerDetails/);
  assert.match(portalData, /context\.kind === 'admin'[\s\S]*rowsFor\(supabase, 'customer_private_details', 'customer_id, phone, connection_date'/);
  assert.doesNotMatch(customerView, /phone|privateCustomerDetails|WhatsApp/i);
  assert.doesNotMatch(main, /console\.(?:log|info|debug)\([^\n]*(?:phone|reminder)/i);
});
