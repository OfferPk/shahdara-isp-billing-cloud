import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatUiMessage, translateUi } from '../src/language.js';
import { buildAdminBillRows, renderAdminBillCards, renderPrintableReceiptHtml } from '../src/admin-bills.js';
import { formatBillingMonth, formatIncidentTimestamp, buildIncidentTimeline } from '../src/customer-portal.js';
import { renderAdminIncidentCards } from '../src/admin-incidents.js';
import { renderCustomerCards, renderCustomerProfile } from '../src/customer-list.js';
import { formatMoney } from '../src/ledger.js';

const romanUrdu = (message) => translateUi(message, 'ur-Latn');
const INTERNAL_ENUM_VALUES = new Set(['admin', 'customer', 'resolved', 'open', 'not-priced', 'paid', 'unpaid', 'active', 'offline', 'not-set', 'unknown', 'ur-Latn', 'en', 'all']);

function callArguments(source, functionName) {
  const calls = [];
  const pattern = new RegExp(`\\b${functionName}\\s*\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf('(');
    const args = [];
    let start = open + 1;
    let parens = 0;
    let brackets = 0;
    let braces = 0;
    let quote = '';
    for (let i = start; i < source.length; i += 1) {
      const char = source[i];
      if (quote) {
        if (char === '\\') { i += 1; continue; }
        if (char === quote) quote = '';
        continue;
      }
      if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
      if (char === '(') parens += 1;
      else if (char === ')') {
        if (parens === 0 && brackets === 0 && braces === 0) {
          args.push(source.slice(start, i));
          break;
        }
        if (parens > 0) parens -= 1;
      } else if (char === '[') brackets += 1;
      else if (char === ']') brackets = Math.max(0, brackets - 1);
      else if (char === '{') braces += 1;
      else if (char === '}') braces = Math.max(0, braces - 1);
      else if (char === ',' && parens === 0 && brackets === 0 && braces === 0) {
        args.push(source.slice(start, i));
        start = i + 1;
      }
    }
    calls.push(args);
  }
  return calls;
}

function collectStaticCopyKeys(source) {
  const keys = new Set();
  for (const match of source.matchAll(/\bt\(([^()]*)\)/gs)) {
    const args = match[1].trim();
    if (/^['"]/.test(args)) {
      const literal = args.match(/^(['"])(.*?)\1/s);
      if (literal) keys.add(literal[2]);
      continue;
    }
    const conditional = args.indexOf('?');
    if (conditional < 0) continue;
    const branches = args.slice(conditional + 1);
    for (const literal of branches.matchAll(/(['"])(.*?)\1/gs)) keys.add(literal[2]);
  }
  for (const match of source.matchAll(/formatUiMessage\(\s*(['"])(.*?)\1/gs)) keys.add(match[2]);
  for (const match of source.matchAll(/data-i18n(?:-aria-label)?="([^"]+)"/g)) keys.add(match[1]);
  for (const match of source.matchAll(/\breturn\s+(['"])(.*?)\1\s*;/gs)) {
    if (match[2] && !INTERNAL_ENUM_VALUES.has(match[2])) keys.add(match[2]);
  }
  for (const [functionName, argumentIndex] of [['setMessage', 1], ['refreshCurrentContext', 0], ['announceApp', 0]]) {
    for (const args of callArguments(source, functionName)) {
      const expression = args[argumentIndex] ?? '';
      for (const match of expression.matchAll(/(['"])(.*?)\1/gs)) {
        if (match[2] && !INTERNAL_ENUM_VALUES.has(match[2])) keys.add(match[2]);
      }
    }
  }
  return keys;
}

test('scoped hardcoded UI copy is enumerated, Roman Urdu is complete, and no non-Latin Urdu or Hindi appears', async () => {
  const paths = [
    '../index.html',
    '../src/main.js',
    '../src/admin-bills.js',
    '../src/customer-documents.js',
    '../src/customer-portal.js',
    '../src/admin-incidents.js',
    '../src/customer-list.js',
    '../src/dashboard-metrics.js',
    '../src/dashboard-analytics.js',
    '../src/app-install.js',
  ];
  const sources = await Promise.all(paths.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  const keys = new Set(sources.flatMap((source) => [...collectStaticCopyKeys(source)]));
  assert.ok(keys.size >= 320, `expected labels plus fixed announcements, found ${keys.size} static copy keys`);
  const missing = [...keys].filter((key) => romanUrdu(key) === key).sort();
  assert.deepEqual(missing, [], `every app-authored static label/message on the scoped surfaces needs Roman Urdu copy`);
  for (const key of keys) {
    assert.equal(translateUi(key, 'en'), key, `English remains the default copy for ${key}`);
    assert.doesNotMatch(romanUrdu(key), /[\u0900-\u097f\u0600-\u06ff\u0750-\u077f]/u, `${key} must remain Roman-script text`);
  }
  assert.match(sources[0], /data-i18n-aria-label="Shahdara Fiber Net cloud portal home"/);
  assert.match(sources[1], /querySelectorAll\('\[data-i18n-aria-label\]'\)/);
});

test('translated Admin bills and printable receipts keep names, packages, IDs, dates, amounts, and receipt methods as data', () => {
  const [row] = buildAdminBillRows({
    today: '2026-10-02',
    t: romanUrdu,
    customers: [{ id: 'customer-17', customer_number: 17, name: 'Rina & Sons', plan_name: 'Fiber Gold 75 Mbps' }],
    privateDetails: [{ customer_id: 'customer-17', phone: '03001234567' }],
    bills: [{ id: 'bill-77', customer_id: 'customer-17', period: '2026-10-01', amount_due_cents: 100000, issued_on: '2026-09-27', due_date: '2026-10-10', plan_snapshot: 'Fiber Gold 75 Mbps' }],
    receipts: [{ id: 'receipt-88', customer_id: 'customer-17', origin_bill_id: 'bill-77', received_on: '2026-10-01', amount_cents: 20000, method: 'Cash' }],
    allocations: [{ customer_id: 'customer-17', bill_id: 'bill-77', amount_cents: 10000, allocation_kind: 'carry-forward' }],
  });
  assert.equal(row.dueLabel, 'Aakhri tareekh: 2026-10-10');
  const markup = renderAdminBillCards([row], formatMoney, romanUrdu);
  assert.match(markup, /Rina &amp; Sons/);
  assert.match(markup, /Fiber Gold 75 Mbps/);
  assert.match(markup, /2026-10-10/);
  assert.match(markup, /receipt-88/);
  assert.match(markup, /Wasooli karein:/);
  assert.match(markup, /WhatsApp par yaad-dihani/);
  assert.match(markup, /Cash/);
  assert.match(markup, /Credit alag apply hui|Aglay bill mein muntaqil credit/);
  assert.match(markup, /aria-label="Bill ke actions:/);
  assert.doesNotMatch(markup, /Naqd.*PKR 200/);

  const printed = renderPrintableReceiptHtml({
    receipt: { id: 'receipt-88', received_on: '2026-10-01', amount_cents: 20000, method: 'Bank transfer' },
    customer: { name: 'Rina & Sons' },
    bill: { period: '2026-10-01' },
    formatMoney,
    t: romanUrdu,
    language: 'ur-Latn',
  });
  assert.match(printed, /<html lang="ur-Latn" dir="ltr">/);
  assert.match(printed, /<h1>Naqd ki receipt<\/h1>/);
  assert.match(printed, /Receipt ki ID: receipt-88/);
  assert.match(printed, /Rina &amp; Sons/);
  assert.match(printed, /2026-10/);
  assert.match(printed, /Bank transfer/);
  assert.match(printed, /Asal wasool shuda raqam/);
  assert.match(printed, /Payment ka tareeqa/);
  assert.match(printed, /allocations se alag tay hota hai/);
  assert.doesNotMatch(printed, /<script|<img/);
});

test('Roman Urdu reminder drafts translate only fixed copy and preserve customer and billing values', () => {
  const [bill] = buildAdminBillRows({
    today: '2026-10-02',
    customers: [{ id: 'customer-21', customer_number: 21, name: 'Amina Network' }],
    privateDetails: [{ customer_id: 'customer-21', phone: '03001234567' }],
    bills: [{ id: 'bill-21', customer_id: 'customer-21', period: '2026-09-01', amount_due_cents: 90000, due_date: '2026-09-15' }],
    receipts: [],
    allocations: [],
  });
  const card = renderAdminBillCards([bill], formatMoney, romanUrdu);
  const billHref = card.match(/href="(https:\/\/wa\.me\/[^\"]+)"/)?.[1];
  assert.ok(billHref, 'an eligible priced unpaid bill keeps its user-opened reminder link');
  const billDraft = new URL(billHref).searchParams.get('text');
  assert.match(billDraft, /Amina Network/);
  assert.match(billDraft, /2026-09/);
  assert.match(billDraft, /Aakhri tareekh: 2026-09-15/);
  assert.match(billDraft, /baqaya raqam/);
  assert.doesNotMatch(billDraft, /outstanding balance/);

  const customer = {
    customer: { id: 'customer-21', customer_number: 21, name: 'Amina Network', plan_name: 'Fiber Plus' },
    phone: '03001234567',
    area: 'House 9, Block B',
    bill: { id: 'bill-21', period: '2026-09-01', plan_snapshot: 'Fiber Plus' },
    dueBill: { id: 'bill-21', period: '2026-09-01' },
    paymentBill: { id: 'bill-21' },
    billing: { status: 'unpaid', balanceCents: 90000 },
  };
  const customerCards = renderCustomerCards([customer], formatMoney, romanUrdu);
  const customerHref = customerCards.match(/href="(https:\/\/wa\.me\/[^\"]+)"/)?.[1];
  assert.ok(customerHref);
  const customerDraft = new URL(customerHref).searchParams.get('text');
  assert.match(customerDraft, /Amina Network/);
  assert.match(customerDraft, /#21/);
  assert.match(customerDraft, /2026-09/);
  assert.match(customerDraft, /khata #21/);
  assert.doesNotMatch(customerDraft, /unpaid account balance/);

  const profile = renderCustomerProfile(customer, { bills: [], receipts: [], allocations: [], formatMoney, t: romanUrdu });
  assert.match(profile, /House 9, Block B/);
  assert.match(profile, /Fiber Plus/);
  assert.match(profile, /Amina Network/);
  assert.match(profile, /Customer ki profile/);
});

test('Customer Portal and incident fallbacks localize without translating valid dates or user-written incident text', () => {
  assert.equal(formatUiMessage('Due date set to {date}.', 'en', { date: '2026-10-05' }), 'Due date set to 2026-10-05.');
  assert.equal(formatUiMessage('Due date set to {date}.', 'ur-Latn', { date: '2026-10-05' }), '2026-10-05 aakhri tareekh muqarrar kar di gayi.');
  assert.equal(formatBillingMonth('bad-month', 'en-PK', romanUrdu), 'Mahina dastiyab nahin');
  assert.match(formatBillingMonth('2026-10', 'en-PK', romanUrdu), /October 2026/);
  assert.equal(formatIncidentTimestamp('not-a-timestamp', 'en-PK', romanUrdu), 'Waqt dastiyab nahin');

  const timeline = buildIncidentTimeline({
    status: 'open',
    reported_at: '2026-10-01T10:00:00Z',
    offline_at: null,
    restored_at: null,
  }, romanUrdu);
  assert.equal(timeline.statusLabel, 'Jari hai');
  assert.match(timeline.events[0].label, /Report hua/);
  assert.match(timeline.restorationMessage, /waqt record nahin/);

  const userText = '<img src=x onerror=alert(1)> outage near House 9';
  const incidentHtml = renderAdminIncidentCards({
    incidents: [{ id: 'incident-27', customer_id: null, reported_at: '2026-10-01T10:00:00Z', status: 'open', customer_visible_summary: userText }],
    privateDetails: [{ incident_id: 'incident-27', staff_notes: 'technician memo' }],
    customers: [],
    t: romanUrdu,
  });
  assert.match(incidentHtml, /Service masla/);
  assert.match(incidentHtml, /&lt;img src=x onerror=alert\(1\)&gt; outage near House 9/);
  assert.match(incidentHtml, /technician memo/);
  assert.doesNotMatch(incidentHtml, /<img src=x/);
});

test('language control remains keyboard-operable and responsive after copy localization', async () => {
  const [index, main, styles] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(index, /id="language-toggle" class="language-toggle" role="group" aria-label="Language"/);
  assert.match(index, /type="button" data-language="en"[^>]*aria-pressed="true"/);
  assert.match(index, /type="button" data-language="ur-Latn"[^>]*aria-pressed="false"/);
  assert.match(main, /button\.setAttribute\('aria-pressed', String\(selected\)\)/);
  assert.match(main, /setLanguagePreference\(nextLanguage\)/);
  assert.match(styles, /\.language-toggle__option:focus-visible/);
  assert.match(styles, /@media \(max-width: 380px\)/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.customer-card-grid \{ grid-template-columns: 1fr; \}/);
});
