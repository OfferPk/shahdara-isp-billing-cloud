const KNOWLEDGE_SOURCES = Object.freeze({
  pppoe: Object.freeze({
    title: 'MikroTik RouterOS Manual — PPPoE',
    url: 'https://manual.mikrotik.com/docs/virtual-private-networks/pppoe/',
  }),
  pppAaa: Object.freeze({
    title: 'MikroTik RouterOS Manual — PPP AAA',
    url: 'https://manual.mikrotik.com/docs/authentication-authorization-accounting/ppp-aaa/',
  }),
  queues: Object.freeze({
    title: 'MikroTik RouterOS Manual — Queues',
    url: 'https://manual.mikrotik.com/docs/firewall-and-quality-of-service/queues/',
  }),
});

export const NETWORK_KNOWLEDGE_SOURCES = KNOWLEDGE_SOURCES;
export const ALLOWED_NETWORK_KNOWLEDGE_SOURCE_URLS = Object.freeze(
  Object.values(KNOWLEDGE_SOURCES).map(({ url }) => url),
);

const GENERAL_CONCEPT_DISCLAIMER = 'General concept explanation only. It does not confirm the live state of any device or customer.';

export const NETWORK_KNOWLEDGE_CARDS = Object.freeze([
  Object.freeze({
    id: 'pppoe',
    title: 'PPPoE in plain terms',
    explanation: 'PPPoE carries PPP packets inside Ethernet frames and establishes a session between a client and an access concentrator. Authentication and session setup are parts of the protocol model.',
    source: KNOWLEDGE_SOURCES.pppoe,
  }),
  Object.freeze({
    id: 'ppp-profiles-aaa',
    title: 'PPP profiles and AAA',
    explanation: 'A PPP profile supplies default values for access records. RouterOS combines service defaults, a linked user record, and profile values; RADIUS can also provide PPP authentication and accounting. This describes general roles, not a particular subscriber assignment.',
    source: KNOWLEDGE_SOURCES.pppAaa,
  }),
  Object.freeze({
    id: 'queues',
    title: 'Queues and rate control',
    explanation: 'RouterOS queues organize traffic for transmission and can support rate control and prioritization. Simple queues are intended for everyday target-based treatment; queue trees support more advanced hierarchical handling of marked traffic. These concepts do not measure a speed or prove that a limit is active.',
    source: KNOWLEDGE_SOURCES.queues,
  }),
]);

export const NETWORK_KNOWLEDGE_COPY_KEYS = Object.freeze([
  'Network concepts · informational reference',
  'These fixed notes are part of the app and are shown only when requested. They do not accept questions, inspect customer records, or contact a device.',
  'Reference cards',
  'Informational only · not live device or customer state',
  'General concept explanation only. It does not confirm the live state of any device or customer.',
  'Official source',
  'Source URL',
  ...NETWORK_KNOWLEDGE_CARDS.flatMap(({ title, explanation }) => [title, explanation]),
  ...Object.values(KNOWLEDGE_SOURCES).map(({ title }) => title),
]);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function translated(t, message) {
  return escapeHtml(t(message));
}

export function renderNetworkKnowledgePanel(t = (message) => message) {
  const cards = NETWORK_KNOWLEDGE_CARDS.map(({ id, title, explanation, source }) => (
    `<article class="network-knowledge__card" aria-labelledby="network-knowledge-${escapeHtml(id)}-title"><p class="network-knowledge__label">${translated(t, 'Informational only · not live device or customer state')}</p><h4 id="network-knowledge-${escapeHtml(id)}-title">${translated(t, title)}</h4><p>${translated(t, explanation)}</p><p class="network-knowledge__disclaimer" role="note">${translated(t, 'General concept explanation only. It does not confirm the live state of any device or customer.')}</p><div class="network-knowledge__source"><strong>${translated(t, 'Official source')}</strong><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${translated(t, source.title)}<span class="network-knowledge__source-url">${translated(t, 'Source URL')}: ${escapeHtml(source.url)}</span></a></div></article>`
  )).join('');
  return `<section class="network-knowledge__panel" aria-labelledby="network-knowledge-panel-title"><div class="network-knowledge__heading"><h3 id="network-knowledge-panel-title">${translated(t, 'Network concepts · informational reference')}</h3><span class="network-knowledge__badge">${translated(t, 'Informational only · not live device or customer state')}</span></div><p class="network-knowledge__intro">${translated(t, 'These fixed notes are part of the app and are shown only when requested. They do not accept questions, inspect customer records, or contact a device.')}</p><div class="network-knowledge__cards" aria-label="${translated(t, 'Reference cards')}">${cards}</div></section>`;
}

export function mountNetworkKnowledgePanel(root, { t = (message) => message } = {}) {
  if (!root || typeof root !== 'object' || !('innerHTML' in root)) return false;
  root.innerHTML = renderNetworkKnowledgePanel(t);
  return true;
}
