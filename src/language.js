export const LANGUAGE_STORAGE_KEY = 'shahdara-cloud-ui-language';

let romanUrduTranslations = null;
let romanUrduLoadPromise = null;

export async function loadLanguageResources(language, importRomanUrdu = () => import('./roman-urdu.js')) {
  if (normalizeLanguage(language) !== 'ur-Latn') return true;
  if (romanUrduTranslations) return true;
  if (!romanUrduLoadPromise) {
    romanUrduLoadPromise = Promise.resolve()
      .then(importRomanUrdu)
      .then((module) => {
        const dictionary = module?.default;
        if (!dictionary || typeof dictionary !== 'object') throw new Error('Roman Urdu resources are unavailable.');
        romanUrduTranslations = dictionary;
        return true;
      })
      .catch(() => {
        romanUrduLoadPromise = null;
        return false;
      });
  }
  return romanUrduLoadPromise;
}


export function normalizeLanguage(value) {
  return value === 'ur-Latn' ? 'ur-Latn' : 'en';
}

export function getStoredLanguage(storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    return normalizeLanguage(target?.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return 'en';
  }
}

export function storeLanguage(language, storage) {
  const normalized = normalizeLanguage(language);
  try {
    const target = storage ?? globalThis.localStorage;
    target?.setItem(LANGUAGE_STORAGE_KEY, normalized);
    return Boolean(target);
  } catch {
    return false;
  }
}

export function setLanguagePreference(language, storage, documentObject) {
  const normalized = normalizeLanguage(language);
  const persisted = storeLanguage(normalized, storage);
  applyDocumentLanguage(documentObject, normalized);
  return { language: normalized, persisted };
}

export function applyDocumentLanguage(documentObject, language) {
  const target = documentObject ?? globalThis.document;
  if (!target?.documentElement) return;
  const normalized = normalizeLanguage(language);
  target.documentElement.lang = normalized;
  target.documentElement.dir = 'ltr';
}

export function translateUi(message, language = 'en') {
  if (normalizeLanguage(language) !== 'ur-Latn') return String(message ?? '');
  const text = String(message ?? '');
  return romanUrduTranslations?.[text] ?? text;
}

export function formatUiMessage(message, language = 'en', values = {}) {
  return translateUi(message, language).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_match, name) => String(values[name] ?? ''));
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
