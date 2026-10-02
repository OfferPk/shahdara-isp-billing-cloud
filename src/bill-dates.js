const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BILLING_MONTH_RE = /^(\d{4})-(\d{2})$/;

function daysInMonth(year, month) {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function normalizeIsoDate(value) {
  const match = ISO_DATE_RE.exec(String(value ?? ''));
  if (!match) return '';
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return '';
  return `${yearText}-${monthText}-${dayText}`;
}

export function isValidBillingMonth(value) {
  const match = BILLING_MONTH_RE.exec(String(value ?? ''));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year >= 1 && month >= 1 && month <= 12;
}

export function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function localMonthString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function getBillingCycleQuickDate(month, preset, today = new Date()) {
  if (preset === 'today') return localDateString(today);
  if (!isValidBillingMonth(month)) return '';

  const [year, numericMonth] = month.split('-').map(Number);
  const day = preset === 'fifth'
    ? 5
    : preset === 'tenth'
      ? 10
      : preset === 'end' ? daysInMonth(year, numericMonth) : 0;
  if (!day) return '';
  return `${month}-${String(day).padStart(2, '0')}`;
}

export function getOverdueDays(dueDate, today) {
  const validDueDate = normalizeIsoDate(dueDate);
  const validToday = normalizeIsoDate(today);
  if (!validDueDate || !validToday || validDueDate >= validToday) return 0;
  const dueTimestamp = Date.parse(`${validDueDate}T00:00:00.000Z`);
  const todayTimestamp = Date.parse(`${validToday}T00:00:00.000Z`);
  return Math.floor((todayTimestamp - dueTimestamp) / 86_400_000);
}
