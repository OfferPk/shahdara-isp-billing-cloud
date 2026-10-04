import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterAdminReceiptRows,
  paginateAdminReceiptRows,
  renderAdminReceiptCards,
} from '../src/admin-receipts.js';
import { formatUiMessage, translateUi } from '../src/language.js';

const receipts = [
  { id: 'receipt-1', customer_id: 'customer-1', received_on: '2026-08-13', amount_cents: 150000, method: 'Bank transfer' },
  { id: 'receipt-2', customer_id: 'customer-2', received_on: '2026-08-12', amount_cents: 80000, method: 'Cash' },
  { id: 'receipt-3', customer_id: 'customer-3', received_on: '2026-08-11', amount_cents: 25000, method: 'Easypaisa' },
];

const customerNameForReceipt = (receipt) => ({
  'customer-1': 'Amina & Sons',
  'customer-2': 'Bilal Fiber',
  'customer-3': 'Shahdara Link',
})[receipt.customer_id];

test('receipt search matches customer, date, method, and visible PKR amounts case-insensitively', () => {
  const search = (query) => filterAdminReceiptRows(receipts, {
    search: query,
    customerNameForReceipt,
    formatMoney: (amount) => `PKR ${(amount / 100).toLocaleString('en-PK')}`,
  }).map((receipt) => receipt.id);

  assert.deepEqual(search('AMINA'), ['receipt-1']);
  assert.deepEqual(search('2026-08-12'), ['receipt-2']);
  assert.deepEqual(search('easypaisa'), ['receipt-3']);
  assert.deepEqual(search('1,500'), ['receipt-1']);
  assert.deepEqual(search('1500'), ['receipt-1']);
  assert.deepEqual(search('   '), receipts.map((receipt) => receipt.id));
  assert.deepEqual(search('not found'), []);
});

test('receipt pagination returns stable slices and safely clamps invalid page requests', () => {
  const manyReceipts = Array.from({ length: 23 }, (_entry, index) => ({ id: `receipt-${index + 1}` }));
  const second = paginateAdminReceiptRows(manyReceipts, { page: 2 });
  assert.deepEqual(second.items.map((receipt) => receipt.id), Array.from({ length: 10 }, (_entry, index) => `receipt-${index + 11}`));
  assert.deepEqual({ page: second.page, pageCount: second.pageCount, total: second.total, start: second.start, end: second.end }, {
    page: 2, pageCount: 3, total: 23, start: 11, end: 20,
  });

  const last = paginateAdminReceiptRows(manyReceipts, { page: 99 });
  assert.equal(last.page, 3);
  assert.deepEqual(last.items.map((receipt) => receipt.id), ['receipt-21', 'receipt-22', 'receipt-23']);
  assert.equal(paginateAdminReceiptRows(manyReceipts, { page: -3 }).page, 1);
  assert.deepEqual(paginateAdminReceiptRows([]), {
    items: [], page: 1, pageSize: 10, pageCount: 1, total: 0, start: 0, end: 0,
  });
});

test('receipt cards escape untrusted values and announce an empty filtered result', () => {
  const markup = renderAdminReceiptCards([{
    id: 'receipt-<unsafe>',
    customer_id: 'customer-1',
    received_on: '2026-08-13',
    amount_cents: 150000,
    method: '<script>alert(1)</script>',
  }], {
    customerNameForReceipt: () => '<img src=x onerror=alert(1)>',
    formatMoney: () => 'PKR 1,500',
  });
  assert.match(markup, /aria-label="Actual receipts"/);
  assert.match(markup, /data-id="receipt-&lt;unsafe&gt;"/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>alert|<img src=x/);
  assert.match(renderAdminReceiptCards([], { emptyMessage: 'No receipts match this search.' }), /class="record-card-empty" role="status">No receipts match this search\./);
});

test('receipt search count and pager labels have Roman Urdu translations', () => {
  assert.equal(
    formatUiMessage('Showing {shownStart}–{shownEnd} of {matching} matching receipts; {total} total records.', 'ur-Latn', {
      shownStart: 1, shownEnd: 10, matching: 12, total: 12,
    }),
    'Kul 12 records mein se 12 mutabiq receipts mein 1–10 dikhayi ja rahi hain.',
  );
  assert.equal(translateUi('Previous page', 'ur-Latn'), 'Pichla safha');
  assert.equal(translateUi('Next page', 'ur-Latn'), 'Agla safha');
});
