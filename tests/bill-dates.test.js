import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getBillingCycleQuickDate,
  getOverdueDays,
  isValidBillingMonth,
  localDateString,
  localMonthString,
  normalizeIsoDate,
} from '../src/bill-dates.js';

const localOctoberSecond = new Date(2026, 9, 2, 12, 0, 0);

test('billing defaults use the actual local month, year, and date instead of a hardcoded future value', () => {
  assert.equal(localMonthString(localOctoberSecond), '2026-10');
  assert.equal(localDateString(localOctoberSecond), '2026-10-02');
  assert.equal(isValidBillingMonth('2026-10'), true);
  assert.equal(isValidBillingMonth('2029-09'), true, 'a future month remains user-selectable');
  assert.equal(isValidBillingMonth('2026-13'), false);
});

test('due-date quick-selects use today locally and other presets follow the selected cycle', () => {
  assert.equal(getBillingCycleQuickDate('2026-10', 'today', localOctoberSecond), '2026-10-02');
  assert.equal(getBillingCycleQuickDate('2026-10', 'fifth', localOctoberSecond), '2026-10-05');
  assert.equal(getBillingCycleQuickDate('2026-10', 'tenth', localOctoberSecond), '2026-10-10');
  assert.equal(getBillingCycleQuickDate('2026-10', 'end', localOctoberSecond), '2026-10-31');
  assert.equal(getBillingCycleQuickDate('2024-02', 'end', localOctoberSecond), '2024-02-29');
  assert.equal(getBillingCycleQuickDate('2025-02', 'end', localOctoberSecond), '2025-02-28');
  assert.equal(getBillingCycleQuickDate('2026-04', 'end', localOctoberSecond), '2026-04-30');
  assert.equal(getBillingCycleQuickDate('invalid', 'fifth', localOctoberSecond), '');
});

test('date validation and overdue-day math use calendar dates, with no same-day or future overdue state', () => {
  assert.equal(normalizeIsoDate('2024-02-29'), '2024-02-29');
  assert.equal(normalizeIsoDate('2025-02-29'), '');
  assert.equal(getOverdueDays('2026-04-09', '2026-04-10'), 1);
  assert.equal(getOverdueDays('2026-04-10', '2026-04-10'), 0);
  assert.equal(getOverdueDays('2026-04-11', '2026-04-10'), 0);
  assert.equal(getOverdueDays(null, '2026-04-10'), 0);
});
