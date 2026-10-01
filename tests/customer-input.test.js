import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePakistanPhone } from '../src/customer-input.js';

test('optional Pakistan phone input stays text and preserves local or +92 formatting', () => {
  assert.equal(validatePakistanPhone(''), '');
  assert.equal(validatePakistanPhone(' 03001234567 '), '03001234567');
  assert.equal(validatePakistanPhone('+923001234567'), '+923001234567');
});

test('Pakistan phone validation rejects malformed values without numeric coercion', () => {
  for (const value of ['3001234567', '0300123456', '+9203001234567', '0300-1234567']) {
    assert.throws(() => validatePakistanPhone(value), /Pakistan mobile number/);
  }
  assert.throws(() => validatePakistanPhone(3001234567), /entered as text/);
});
