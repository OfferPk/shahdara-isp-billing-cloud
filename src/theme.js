export const THEME_STORAGE_KEY = 'shahdara-cloud-ui-theme';
export const DEFAULT_THEME = 'light';

export function normalizeTheme(value) {
  return value === 'dark' ? 'dark' : DEFAULT_THEME;
}

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readThemePreference(storage = browserStorage()) {
  try {
    return normalizeTheme(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function writeThemePreference(theme, storage = browserStorage()) {
  const normalized = normalizeTheme(theme);
  try {
    storage?.setItem(THEME_STORAGE_KEY, normalized);
  } catch {
    // The current page still changes theme when storage is unavailable.
  }
  return normalized;
}

export function initializeTheme(options = {}) {
  const documentRef = options.root?.ownerDocument ?? globalThis.document;
  const root = options.root ?? documentRef?.documentElement;
  const button = options.button ?? documentRef?.querySelector('#theme-toggle');
  const announcement = options.announcement ?? documentRef?.querySelector('#app-announcement');
  const themeColorMeta = options.themeColorMeta ?? documentRef?.querySelector('meta[name="theme-color"]');
  const storage = options.storage ?? browserStorage();
  const translate = options.translate ?? ((message) => message);
  let activeTheme = readThemePreference(storage);

  function apply(theme, { persist = true, announce = false } = {}) {
    activeTheme = normalizeTheme(theme);
    if (persist) writeThemePreference(activeTheme, storage);
    if (root) root.dataset.theme = activeTheme;

    const darkMode = activeTheme === 'dark';
    const actionLabel = translate(darkMode ? 'Switch to light mode' : 'Switch to dark mode');
    const visibleLabel = translate(darkMode ? 'Light mode' : 'Dark mode');
    button?.setAttribute('aria-pressed', String(darkMode));
    button?.setAttribute('aria-label', actionLabel);
    button?.setAttribute('title', actionLabel);
    const label = button?.querySelector('[data-theme-label]');
    if (label) label.textContent = visibleLabel;
    themeColorMeta?.setAttribute('content', darkMode ? '#101714' : '#123c35');

    if (announce && announcement) {
      announcement.textContent = translate(darkMode ? 'Dark mode enabled.' : 'Light mode enabled.');
    }
    return activeTheme;
  }

  apply(activeTheme, { persist: false });
  button?.addEventListener('click', () => {
    apply(activeTheme === 'dark' ? 'light' : 'dark', { announce: true });
  });

  return {
    get theme() { return activeTheme; },
    setTheme(theme) { return apply(theme); },
    refreshLabels() { return apply(activeTheme, { persist: false }); },
  };
}
