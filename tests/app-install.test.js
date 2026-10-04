import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initializeAppInstall } from '../src/app-install.js';

class FakeElement extends EventTarget {
  textContent = '';
  disabled = false;

  click() {
    this.dispatchEvent(new Event('click'));
  }
}

class FakeWindow extends EventTarget {
  constructor({ userAgent = 'Mozilla/5.0 Chrome/130.0.0.0', platform = 'Linux', maxTouchPoints = 0, installed = false } = {}) {
    super();
    this.navigator = { userAgent, platform, maxTouchPoints };
    this.matchMedia = (query) => ({ matches: query === '(display-mode: standalone)' && installed });
  }
}

class FakeInstallPrompt extends Event {
  constructor(outcome = 'accepted', promptError = null) {
    super('beforeinstallprompt', { cancelable: true });
    this.outcome = outcome;
    this.promptError = promptError;
    this.promptCalls = 0;
    this.prompt = async () => {
      this.promptCalls += 1;
      if (this.promptError) throw this.promptError;
    };
    this.userChoice = Promise.resolve({ outcome });
  }
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
function createController(options = {}) {
  const windowObject = new FakeWindow(options);
  const button = new FakeElement();
  const status = new FakeElement();
  const controller = initializeAppInstall({ windowObject, button, status, translate: (message) => message });
  return { windowObject, button, status, controller };
}

test('captures the browser event and invokes its one-use prompt only after the user activates the button', async () => {
  const { windowObject, button, status, controller } = createController();
  const promptEvent = new FakeInstallPrompt('accepted');
  windowObject.dispatchEvent(promptEvent);

  assert.equal(promptEvent.defaultPrevented, true);
  assert.equal(promptEvent.promptCalls, 0);
  button.click();
  await nextTurn();

  assert.equal(promptEvent.promptCalls, 1);
  assert.equal(status.textContent, 'The browser accepted the install request. Follow any remaining browser steps to finish.');
  assert.equal(controller.isInstalled, false, 'accepting a prompt alone is not reported as an installed app');

  windowObject.dispatchEvent(new Event('appinstalled'));
  assert.equal(controller.isInstalled, true);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'App installed');
  assert.equal(status.textContent, 'This portal is open as an installed app.');
});

test('reports a dismissed native prompt and handles a prompt failure without claiming installation', async () => {
  const dismissed = createController();
  dismissed.windowObject.dispatchEvent(new FakeInstallPrompt('dismissed'));
  dismissed.button.click();
  await nextTurn();
  assert.equal(dismissed.status.textContent, 'Installation was canceled. You can try again from the browser menu.');
  assert.equal(dismissed.button.disabled, false);

  const failed = createController();
  failed.windowObject.dispatchEvent(new FakeInstallPrompt('accepted', new Error('prompt failed')));
  failed.button.click();
  await nextTurn();
  assert.equal(failed.status.textContent, 'The browser could not start installation. Check its menu and try again.');
  assert.equal(failed.controller.isInstalled, false);
});

test('detects an already-installed standalone PWA and the iOS standalone signal accessibly', () => {
  for (const options of [
    { installed: true },
    { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', installed: false, standalone: true },
  ]) {
    const windowObject = new FakeWindow(options);
    if (options.standalone) windowObject.navigator.standalone = true;
    const button = new FakeElement();
    const status = new FakeElement();
    const controller = initializeAppInstall({ windowObject, button, status });
    assert.equal(controller.isInstalled, true);
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, 'App installed');
    assert.equal(status.textContent, 'This portal is open as an installed app.');
  }
});

test('gives specific Android/Cue, iPhone/iPad, desktop Chromium, and unsupported-browser guidance', () => {
  const cases = [
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/130.0.0.0', platform: 'Linux' }, 'If you opened it in Cue, open it in Chrome first.'],
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone' }, 'tap Share in your browser and choose Add to Home Screen.'],
    [{ userAgent: 'Mozilla/5.0 Chrome/130.0.0.0', platform: 'Linux' }, 'Check its menu for Install app or Add to Home screen if available.'],
    [{ userAgent: 'Mozilla/5.0 Firefox/130.0', platform: 'Linux' }, 'App installation is not available in this browser.'],
  ];
  for (const [options, expected] of cases) {
    const { button, status } = createController(options);
    button.click();
    assert.ok(status.textContent.includes(expected), status.textContent);
    assert.equal(button.disabled, false);
  }
});

test('refreshes both button and live status using the current language', () => {
  const windowObject = new FakeWindow({ userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/130.0.0.0' });
  const button = new FakeElement();
  const status = new FakeElement();
  let language = 'en';
  const controller = initializeAppInstall({
    windowObject,
    button,
    status,
    translate: (message) => language === 'ur-Latn' ? `UR: ${message}` : message,
  });
  button.click();
  assert.ok(status.textContent.includes('If you opened it in Cue'));

  language = 'ur-Latn';
  controller.refresh();
  assert.equal(button.textContent, 'UR: Install app');
  assert.ok(status.textContent.startsWith('UR: On Android'));
});

test('provides accessible install UI and a subpath-safe manifest with real icon assets', async () => {
  const [index, styles, manifestText] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.match(index, /<link rel="manifest" href="\.\/manifest\.webmanifest"\s*\/>/);
  assert.match(index, /id="install-app-button" class="button secondary" type="button" data-i18n="Install app" aria-describedby="install-app-status"/);
  assert.match(index, /id="install-app-status" class="install-app-status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(styles, /\.install-control \.button:disabled \{[^}]*cursor: default;/);
  assert.match(styles, /@media \(max-width: 600px\) \{[\s\S]*?\.install-control \.button \{ width: 100%; \}/);
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.name, 'Shahdara Fiber Net Portal');
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));

  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith('./'), `${icon.src} must resolve under the GitHub Pages subpath`);
    const asset = await readFile(new URL(`../public/${icon.src.slice(2)}`, import.meta.url));
    assert.equal(asset.toString('hex', 0, 8), '89504e470d0a1a0a', `${icon.src} must be a real PNG file`);
    assert.equal(asset.readUInt32BE(16), Number.parseInt(icon.sizes.split('x')[0], 10));
    assert.equal(asset.readUInt32BE(20), Number.parseInt(icon.sizes.split('x')[1], 10));
  }
});
