import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildAdminBillRows,
  buildWhatsappReminderHref,
  countAdminBillFilters,
  filterCollectionBillRows,
  filterAdminBillRows,
  paginateAdminBillRows,
  renderAdminBillCards,
  renderPrintableReceiptHtml,
} from '../src/admin-bills.js';
import { formatMoney } from '../src/ledger.js';
import { formatUiMessage, translateUi } from '../src/language.js';

function syntheticRows() {
  return buildAdminBillRows({
    today: '2026-04-10',
    customers: [
      { id: 'customer-overdue', name: 'Amina & Sons', customer_number: 4, plan_name: '50 Mbps' },
      { id: 'customer-paid', name: 'Bilal Fiber', customer_number: 5, plan_name: '30 Mbps' },
      { id: 'customer-no-date', name: 'No Date Account', customer_number: 6, plan_name: '' },
      { id: 'customer-unpriced', name: 'Unpriced Account', customer_number: 7, plan_name: 'Starter' },
    ],
    privateDetails: [
      { customer_id: 'customer-overdue', phone: '0300 1234567' },
      { customer_id: 'customer-paid', phone: '+923111234567' },
      { customer_id: 'customer-no-date', phone: '03005551234' },
    ],
    bills: [
      { id: 'bill-overdue', customer_id: 'customer-overdue', period: '2026-01-01', amount_due_cents: 10000, issued_on: '2026-01-02', due_date: '2026-01-15', plan_snapshot: 'Fiber 50' },
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

test('Admin bill search supports customer name and Admin-only phone, and status counts include overdue as unpaid', () => {
  const rows = syntheticRows();
  assert.deepEqual(filterAdminBillRows(rows, { search: 'AMINA', status: 'all' }).map((row) => row.bill.id), ['bill-overdue']);
  assert.deepEqual(filterAdminBillRows(rows, { search: '0300-123 4567', status: 'unpaid' }).map((row) => row.bill.id), ['bill-overdue']);
  assert.deepEqual(filterAdminBillRows(rows, { search: '+923111234567', status: 'paid' }).map((row) => row.bill.id), ['bill-paid']);
  assert.deepEqual(countAdminBillFilters(rows), { all: 4, unpaid: 2, paid: 1 });
  assert.deepEqual(countAdminBillFilters(rows, { search: 'Amina' }), { all: 1, unpaid: 1, paid: 0 });
});

test('Admin bill pagination returns stable pages, clamps requests, and keeps every record reachable', () => {
  const bills = Array.from({ length: 23 }, (_entry, index) => ({ id: `bill-${index + 1}` }));
  const second = paginateAdminBillRows(bills, { page: 2 });
  assert.deepEqual(second.items.map((bill) => bill.id), Array.from({ length: 10 }, (_entry, index) => `bill-${index + 11}`));
  assert.deepEqual({ page: second.page, pageCount: second.pageCount, total: second.total, start: second.start, end: second.end }, {
    page: 2, pageCount: 3, total: 23, start: 11, end: 20,
  });
  const last = paginateAdminBillRows(bills, { page: 99 });
  assert.equal(last.page, 3);
  assert.deepEqual(last.items.map((bill) => bill.id), ['bill-21', 'bill-22', 'bill-23']);
  assert.equal(paginateAdminBillRows(bills, { page: -3 }).page, 1);
  assert.deepEqual(paginateAdminBillRows([]), {
    items: [], page: 1, pageSize: 10, pageCount: 1, total: 0, start: 0, end: 0,
  });

  const row = syntheticRows()[0];
  const moreThanOneHundred = Array.from({ length: 101 }, (_entry, index) => ({
    ...row,
    bill: { ...row.bill, id: `bill-${index + 1}` },
    receipts: [],
  }));
  assert.equal((renderAdminBillCards(moreThanOneHundred, formatMoney).match(/<article class="bill-card">/g) ?? []).length, 101);
});

test('bill visible-range and page labels have Roman Urdu translations', () => {
  assert.equal(
    formatUiMessage('Showing {shownStart}–{shownEnd} of {matching} matching bills; {total} total records.', 'ur-Latn', {
      shownStart: 11, shownEnd: 20, matching: 23, total: 145,
    }),
    'Kul 145 records mein se 23 mutabiq bills mein 11–20 dikhaye ja rahe hain.',
  );
  assert.equal(translateUi('Bill list pages', 'ur-Latn'), 'Bill list ke safhay');
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
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'unpriced', period: '2026-04' }).map((row) => row.bill.id), ['unpriced']);
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'overdue', period: '2026-03' }).map((row) => row.bill.id), ['other-period']);
  assert.deepEqual(filterCollectionBillRows(rows, { scope: 'overdue', period: '2026-13' }), []);
});

test('WhatsApp creates only a user-opened prefilled Roman Urdu draft for a priced unpaid bill', () => {
  const rows = syntheticRows();
  const overdue = rows.find((row) => row.bill.id === 'bill-overdue');
  const href = buildWhatsappReminderHref(overdue, formatMoney);
  assert.match(href, /^https:\/\/wa\.me\/923001234567\?text=/);
  const draft = decodeURIComponent(href.split('?text=')[1]);
  assert.match(draft, /Assalam-o-Alaikum Amina & Sons/);
  assert.match(draft, /outstanding balance/);
  assert.match(draft, /Due date: 2026-01-15/);
  const noDateDraft = decodeURIComponent(buildWhatsappReminderHref(rows.find((row) => row.bill.id === 'bill-no-date'), formatMoney).split('?text=')[1]);
  assert.doesNotMatch(noDateDraft, /Due date:/);
  assert.equal(buildWhatsappReminderHref(rows.find((row) => row.bill.id === 'bill-paid'), formatMoney), '');
  assert.equal(buildWhatsappReminderHref(rows.find((row) => row.bill.id === 'bill-unpriced'), formatMoney), '');
});

test('bill cards expose Collect only as a prefill, and PDF actions only for actual receipts', () => {
  const rows = syntheticRows();
  const markup = renderAdminBillCards(rows, formatMoney);
  assert.match(markup, /Amina &amp; Sons/);
  assert.match(markup, /Billing Month · 2026-01/);
  assert.match(markup, /Issue Date/);
  assert.match(markup, /2026-01-02/);
  assert.match(markup, /Due Date/);
  assert.match(markup, /Overdue by 85 days/);
  assert.match(markup, /data-action="collect-bill" data-id="bill-overdue"/);
  assert.match(markup, /data-action="edit-bill" data-id="bill-overdue"/);
  assert.match(markup, /Print \/ Save PDF/);
  assert.match(markup, /data-action="print-receipt" data-id="receipt-overdue"/);
  assert.match(markup, /target="_blank" rel="noopener noreferrer"/);
  assert.match(markup, /No actual receipt is recorded against this bill/);
  const noDateMarkup = renderAdminBillCards([rows.find((row) => row.bill.id === 'bill-no-date')], formatMoney);
  assert.match(noDateMarkup, /Issue date not recorded/);
  assert.match(noDateMarkup, /Due date not recorded/);
  assert.doesNotMatch(noDateMarkup, /Overdue by/);
  assert.match(renderAdminBillCards([rows.find((row) => row.bill.id === 'bill-unpriced')], formatMoney), /class="bill-action bill-action--collect" type="button" disabled/);
  assert.doesNotMatch(renderAdminBillCards([rows.find((row) => row.bill.id === 'bill-no-date')], formatMoney), /data-action="print-receipt"/);
  assert.doesNotMatch(markup, /<script|<img/);
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
