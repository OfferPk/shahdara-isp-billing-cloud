import test from 'node:test';
import assert from 'node:assert/strict';
import { translateUi } from '../src/language.js';
import { togglePasswordVisibility } from '../src/password-visibility.js';
import './helpers/load-roman-urdu.js';

const romanUrdu = (message) => translateUi(message, 'ur-Latn');

function makeButton() {
  const attributes = new Map();
  return {
    dataset: { i18n: 'Show', i18nAriaLabel: 'Show password' },
    textContent: 'Show',
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
  };
}

test('password visibility toggles only the paired input and updates Roman Urdu accessible state', () => {
  const input = { type: 'password', value: 'synthetic-password-value' };
  const button = makeButton();

  assert.equal(togglePasswordVisibility(input, button, romanUrdu), true);
  assert.equal(input.type, 'text');
  assert.equal(input.value, 'synthetic-password-value');
  assert.equal(button.dataset.i18n, 'Hide');
  assert.equal(button.dataset.i18nAriaLabel, 'Hide password');
  assert.equal(button.textContent, 'Chhupayein');
  assert.equal(button.getAttribute('aria-label'), 'Password chhupayein');
  assert.equal(button.getAttribute('aria-pressed'), 'true');

  assert.equal(togglePasswordVisibility(input, button, romanUrdu), false);
  assert.equal(input.type, 'password');
  assert.equal(input.value, 'synthetic-password-value');
  assert.equal(button.dataset.i18n, 'Show');
  assert.equal(button.dataset.i18nAriaLabel, 'Show password');
  assert.equal(button.textContent, 'Dikhayein');
  assert.equal(button.getAttribute('aria-label'), 'Password dikhayein');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
});

test('password visibility helper ignores unsupported input types', () => {
  const input = { type: 'email', value: 'synthetic@example.test' };
  const button = makeButton();

  assert.equal(togglePasswordVisibility(input, button, romanUrdu), null);
  assert.equal(input.type, 'email');
  assert.equal(input.value, 'synthetic@example.test');
  assert.equal(button.getAttribute('aria-pressed'), undefined);
});
