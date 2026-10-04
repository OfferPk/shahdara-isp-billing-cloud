import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ALLOWED_NETWORK_KNOWLEDGE_SOURCE_URLS,
  NETWORK_KNOWLEDGE_CARDS,
  NETWORK_KNOWLEDGE_COPY_KEYS,
  NETWORK_KNOWLEDGE_SOURCES,
  mountNetworkKnowledgePanel,
  renderNetworkKnowledgePanel,
} from '../src/network-knowledge.js';
import { translateUi } from '../src/language.js';
import './helpers/load-roman-urdu.js';

const [mainSource, knowledgeSource, stylesSource] = await Promise.all([
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/network-knowledge.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
]);

const romanUrdu = (message) => translateUi(message, 'ur-Latn');
const OFFICIAL_SOURCE_URLS = [
  'https://manual.mikrotik.com/docs/virtual-private-networks/pppoe/',
  'https://manual.mikrotik.com/docs/authentication-authorization-accounting/ppp-aaa/',
  'https://manual.mikrotik.com/docs/firewall-and-quality-of-service/queues/',
];
const NOT_LIVE_DISCLAIMER = 'General concept explanation only. It does not confirm the live state of any device or customer.';

function renderedCards(markup) {
  return markup.match(/<article class="network-knowledge__card"[\s\S]*?<\/article>/g) ?? [];
}

test('the compact knowledge base contains only three fixed concepts and whitelisted official MikroTik sources', () => {
  assert.deepEqual(NETWORK_KNOWLEDGE_CARDS.map(({ id }) => id), ['pppoe', 'ppp-profiles-aaa', 'queues']);
  assert.deepEqual(ALLOWED_NETWORK_KNOWLEDGE_SOURCE_URLS, OFFICIAL_SOURCE_URLS);
  const markup = renderNetworkKnowledgePanel();
  const links = [...markup.matchAll(/<a href="([^"]+)"[^>]*>/g)];
  assert.deepEqual(links.map(([, href]) => href), OFFICIAL_SOURCE_URLS);
  assert.deepEqual(Object.values(NETWORK_KNOWLEDGE_SOURCES).map(({ url }) => url), OFFICIAL_SOURCE_URLS);
  assert.equal(renderedCards(markup).length, 3);
  for (const [index, cardMarkup] of renderedCards(markup).entries()) {
    assert.match(cardMarkup, /MikroTik RouterOS Manual/);
    assert.ok(cardMarkup.includes(OFFICIAL_SOURCE_URLS[index]));
    assert.match(cardMarkup, /target="_blank" rel="noopener noreferrer"/);
    assert.match(cardMarkup, /Source URL:/);
  }
  assert.doesNotMatch(markup, /<pre\b|<code\b|configuration example|run this command/i);
});

test('every individual card labels its explanation informational-only and explicitly not a live device/customer state', () => {
  const cards = renderedCards(renderNetworkKnowledgePanel());
  assert.equal(cards.length, NETWORK_KNOWLEDGE_CARDS.length);
  for (const cardMarkup of cards) {
    assert.match(cardMarkup, /Informational only · not live device or customer state/);
    assert.match(cardMarkup, new RegExp(NOT_LIVE_DISCLAIMER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('fixed references are localized in Roman Urdu without translating vendor URLs or adding non-Latin text', () => {
  const untranslated = NETWORK_KNOWLEDGE_COPY_KEYS.filter((message) => romanUrdu(message) === message);
  assert.deepEqual(untranslated, []);
  for (const message of NETWORK_KNOWLEDGE_COPY_KEYS) {
    assert.doesNotMatch(romanUrdu(message), /[\u0900-\u097f\u0600-\u06ff\u0750-\u077f]/u);
  }
  const markup = renderNetworkKnowledgePanel(romanUrdu);
  for (const url of OFFICIAL_SOURCE_URLS) assert.ok(markup.includes(url));
  assert.match(markup, /Asaan alfaaz mein PPPoE/);
  assert.match(markup, /Sirf aam concept ki wazahat hai/);
});

test('all translated and fixed content is HTML-escaped while hrefs remain the exact source allowlist', () => {
  const maliciousTranslation = () => '<img src=x onerror=alert(1)> & "quoted"';
  const markup = renderNetworkKnowledgePanel(maliciousTranslation);
  assert.doesNotMatch(markup, /<img src=x/);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;quoted&quot;/);
  const hrefs = [...markup.matchAll(/<a href="([^"]+)"[^>]*>/g)].map(([, href]) => href);
  assert.deepEqual(hrefs, OFFICIAL_SOURCE_URLS);
  const target = { innerHTML: '' };
  assert.equal(mountNetworkKnowledgePanel(target), true);
  assert.equal(target.innerHTML, renderNetworkKnowledgePanel());
  assert.equal(mountNetworkKnowledgePanel(null), false);
  assert.equal(mountNetworkKnowledgePanel({}), false);
});

test('the reference module has no runtime network, API, storage, device, database, AI, or tool execution path', () => {
  assert.doesNotMatch(knowledgeSource, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon|node:(?:http|https|net)|child_process|supabase-js|RouterOSClient|RadiusClient|indexedDB|localStorage|sessionStorage|\.rpc\s*\(|\.insert\s*\(|\.update\s*\(|\.delete\s*\(|window\.open|tools?\.call|executeCommand|OpenAI|Anthropic|GoogleGenerativeAI/i);
  assert.doesNotMatch(knowledgeSource, /<form\b|<input\b|<textarea\b|\b(?:ask|query|search|prompt)\s*=\s*["'`]/i);
  assert.match(knowledgeSource, /target="_blank" rel="noopener noreferrer"/);
  assert.match(stylesSource, /\.network-knowledge__content\[hidden\] \{ display: none; \}/);
});

test('only an explicit Admin reference-button click loads the separate knowledge chunk', () => {
  assert.match(mainSource, /let networkKnowledgeModulePromise = null/);
  assert.match(mainSource, /import\('\.\/network-knowledge\.js'\)/);
  assert.doesNotMatch(mainSource, /import\s+[^;]*network-knowledge\.js/);
  assert.match(mainSource, /data-load-network-knowledge aria-controls="network-knowledge-content" aria-expanded="false"/);
  assert.match(mainSource, /addEventListener\('click', requestNetworkKnowledge\)/);
  const requestHandler = mainSource.slice(
    mainSource.indexOf('function requestNetworkKnowledge()'),
    mainSource.indexOf('function bindNetworkDiagnostics(context)'),
  );
  assert.match(requestHandler, /loadNetworkKnowledgeModule\(\)/);
  assert.doesNotMatch(requestHandler, /\bfetch\s*\(|XMLHttpRequest|WebSocket|\.rpc\s*\(|supabase|routeros|radius|customer.*query|execute/i);
  assert.match(mainSource, /Fixed educational notes only; no customer query or device check is used\./);
});
