function isInstalled(windowObject) {
  const standaloneDisplay = windowObject.matchMedia?.('(display-mode: standalone)')?.matches ?? false;
  return standaloneDisplay || windowObject.navigator?.standalone === true;
}

function getFallbackMessage(windowObject, t) {
  const userAgent = windowObject.navigator?.userAgent ?? '';
  const platform = windowObject.navigator?.platform ?? '';
  const touchPoints = windowObject.navigator?.maxTouchPoints ?? 0;
  const isIOS = /iPad|iPhone|iPod/i.test(userAgent) || (platform === 'MacIntel' && touchPoints > 1);

  if (/Android/i.test(userAgent)) {
    return t('On Android, open this page in Chrome and choose Install app or Add to Home screen. If you opened it in Cue, open it in Chrome first.');
  }
  if (isIOS) {
    return t('On iPhone or iPad, tap Share in your browser and choose Add to Home Screen. If it is not offered, open the page in Safari.');
  }
  if (/Mac/i.test(platform || userAgent) && /Safari/i.test(userAgent) && !/(Chrome|CriOS|Edg)/i.test(userAgent)) {
    return t('On macOS Safari 17 or later, use File > Add to Dock. In Chrome or Edge, use the browser menu to install the app.');
  }
  if (/(Chrome|Chromium|Edg|OPR)/i.test(userAgent)) {
    return t('This browser has not offered an install prompt. Check its menu for Install app or Add to Home screen if available.');
  }
  return t('App installation is not available in this browser. You can keep using the portal online.');
}

export function initializeAppInstall({ windowObject, button, status, translate = (message) => message }) {
  if (!windowObject || !button || !status) return { refresh() {} };

  const t = translate;
  let installed = isInstalled(windowObject);
  let deferredPrompt = null;
  let statusMessage = installed ? 'This portal is open as an installed app.' : '';

  function refresh() {
    button.textContent = t(installed ? 'App installed' : 'Install app');
    button.disabled = installed;
    status.textContent = statusMessage ? t(statusMessage) : '';
  }

  function setStatus(message) {
    statusMessage = message;
    refresh();
  }

  function setInstalled() {
    installed = true;
    deferredPrompt = null;
    setStatus('This portal is open as an installed app.');
  }

  async function requestInstall() {
    if (installed) return;
    if (!deferredPrompt) {
      setStatus(getFallbackMessage(windowObject, t));
      return;
    }

    const promptEvent = deferredPrompt;
    deferredPrompt = null;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') {
        setStatus('The browser accepted the install request. Follow any remaining browser steps to finish.');
      } else if (choice?.outcome === 'dismissed') {
        setStatus('Installation was canceled. You can try again from the browser menu.');
      } else {
        setStatus('The browser could not start installation. Check its menu and try again.');
      }
    } catch {
      setStatus('The browser could not start installation. Check its menu and try again.');
    }
  }

  windowObject.addEventListener('beforeinstallprompt', (event) => {
    if (installed || typeof event?.prompt !== 'function') return;
    event.preventDefault?.();
    deferredPrompt = event;
  });
  windowObject.addEventListener('appinstalled', setInstalled);
  button.addEventListener('click', () => { void requestInstall(); });

  refresh();
  return {
    refresh,
    get isInstalled() { return installed; },
  };
}
