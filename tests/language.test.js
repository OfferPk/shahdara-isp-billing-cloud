import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDocumentLanguage, escapeHtml, formatUiMessage, getStoredLanguage, LANGUAGE_STORAGE_KEY, normalizeLanguage, setLanguagePreference, storeLanguage, translateUi } from '../src/language.js';
import { renderCustomerCards } from '../src/customer-list.js';
import { renderAdminIncidentCards } from '../src/admin-incidents.js';

const romanUrdu = (text) => translateUi(text, 'ur-Latn');

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('language preference defaults to English, validates stored values, and persists locally', () => {
  const storage = memoryStorage();
  assert.equal(getStoredLanguage(storage), 'en');
  assert.equal(normalizeLanguage('hi'), 'en');
  assert.equal(normalizeLanguage('ur'), 'en');
  assert.equal(storeLanguage('ur-Latn', storage), true);
  assert.equal(storage.getItem(LANGUAGE_STORAGE_KEY), 'ur-Latn');
  assert.equal(getStoredLanguage(storage), 'ur-Latn');
  assert.equal(storeLanguage('anything-else', storage), true);
  assert.equal(getStoredLanguage(storage), 'en');
});

test('the toggle preference helper persists either selection and applies accessible language metadata', () => {
  const storage = memoryStorage();
  const documentObject = { documentElement: {} };
  assert.deepEqual(setLanguagePreference('ur-Latn', storage, documentObject), { language: 'ur-Latn', persisted: true });
  assert.equal(storage.getItem(LANGUAGE_STORAGE_KEY), 'ur-Latn');
  assert.deepEqual(documentObject.documentElement, { lang: 'ur-Latn', dir: 'ltr' });
  assert.deepEqual(setLanguagePreference('en', storage, documentObject), { language: 'en', persisted: true });
  assert.equal(storage.getItem(LANGUAGE_STORAGE_KEY), 'en');
  assert.deepEqual(documentObject.documentElement, { lang: 'en', dir: 'ltr' });
});

test('storage failures fall back safely and Roman Urdu document semantics remain left-to-right', () => {
  const brokenStorage = {
    getItem() { throw new Error('storage blocked'); },
    setItem() { throw new Error('storage blocked'); },
  };
  assert.equal(getStoredLanguage(brokenStorage), 'en');
  assert.equal(storeLanguage('ur-Latn', brokenStorage), false);
  const documentObject = { documentElement: {} };
  applyDocumentLanguage(documentObject, 'ur-Latn');
  assert.equal(documentObject.documentElement.lang, 'ur-Latn');
  assert.equal(documentObject.documentElement.dir, 'ltr');
  applyDocumentLanguage(documentObject, 'en');
  assert.equal(documentObject.documentElement.lang, 'en');
  assert.equal(documentObject.documentElement.dir, 'ltr');
});

test('core labels translate to Roman Urdu while technical identifiers and data strings remain unchanged', () => {
  assert.equal(translateUi('Sign in to your account', 'en'), 'Sign in to your account');
  assert.equal(romanUrdu('Sign in to your account'), 'Apne account mein sign in karein');
  assert.equal(romanUrdu('Save incident update'), 'Service maslay ki tabdeeli save karein');
  assert.equal(romanUrdu('public.correct_monthly_bill'), 'public.correct_monthly_bill');
  assert.equal(romanUrdu('2026-10-02'), '2026-10-02');
  assert.equal(romanUrdu('Customer-provided plan name'), 'Customer-provided plan name');
  assert.equal(formatUiMessage('Showing {shown} of {total} customers.', 'ur-Latn', { shown: 3, total: 8 }), 'Kul 8 customers mein se 3 dikhaye ja rahe hain.');
  const translated = [romanUrdu('Sign in to your account'), romanUrdu('Save incident update'), romanUrdu('Service maslay ka intizam')].join(' ');
  assert.doesNotMatch(translated, /[\u0900-\u097f\u0600-\u06ff\u0750-\u077f]/u);
});

test('escaping remains safe in translated cards and does not translate customer-provided names or summaries', () => {
  const injectedName = '<img src=x onerror=alert(1)>&"';
  assert.equal(escapeHtml(injectedName), '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;');
  const card = renderCustomerCards([{
    customer: { id: 'synthetic-customer', customer_number: 17, name: injectedName, archived: false, service_status: 'active', plan_name: 'Fiber <50Mbps>' },
    phone: '',
    bill: null,
    dueBill: null,
    paymentBill: null,
    billing: { status: 'no-bill', balanceCents: null },
  }], () => 'PKR 0', romanUrdu);
  assert.match(card, /Baqaya/);
  assert.match(card, /&lt;img src=x onerror=alert\(1\)&gt;&amp;&quot;/);
  assert.match(card, /Fiber &lt;50Mbps&gt;/);
  assert.doesNotMatch(card, /<img src=x/);

  const summary = '<script>alert("x")</script> outage details';
  const note = '<b>staff-only</b>';
  const incident = renderAdminIncidentCards({
    incidents: [{ id: 'incident-1', customer_id: null, reported_at: '2026-10-01T10:00:00Z', status: 'open', customer_visible_summary: summary }],
    privateDetails: [{ incident_id: 'incident-1', staff_notes: note }],
    customers: [],
    t: romanUrdu,
  });
  assert.match(incident, /Service masla/);
  assert.match(incident, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; outage details/);
  assert.match(incident, /&lt;b&gt;staff-only&lt;\/b&gt;/);
  assert.doesNotMatch(incident, /<script>alert/);
  assert.doesNotMatch(incident, /<b>staff-only/);
});
