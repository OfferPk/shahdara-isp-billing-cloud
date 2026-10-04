export const CASHFLOW_CATEGORIES = Object.freeze([
  { value: 'worker_salary', label: 'Worker salary', kind: 'operating' },
  { value: 'nayatel_bandwidth', label: 'Nayatel bandwidth', kind: 'operating' },
  { value: 'partner_profit', label: 'Partner profit distribution', kind: 'distribution' },
  { value: 'bill', label: 'Bills (operating costs)', kind: 'operating' },
  { value: 'battery_ups', label: 'Battery / UPS', kind: 'operating' },
  { value: 'fiber_cable', label: 'Fiber cable', kind: 'operating' },
  { value: 'splitter', label: 'Splitter', kind: 'operating' },
  { value: 'yellow_type', label: 'Yellow type', kind: 'operating' },
  { value: 'white_type', label: 'White type', kind: 'operating' },
  { value: 'black_box_fiber_joint_box', label: 'Black box / fiber joint box', kind: 'operating' },
].map((category) => Object.freeze(category)));

const CATEGORY_BY_VALUE = new Map(CASHFLOW_CATEGORIES.map((category) => [category.value, category]));
const SUPPORTED_MONTH_WINDOWS = new Set([1, 3, 6]);

function pad2(value) {
  return String(value).padStart(2, '0');
}

function isValidDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function localDateKey(value = new Date()) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }
  const text = String(value ?? '').trim();
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(text)?.[1];
  if (dateOnly && isValidDateKey(dateOnly)) return dateOnly;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : localDateKey(parsed);
}

function localMonthKey(value = new Date()) {
  const dateKey = localDateKey(value);
  return dateKey ? dateKey.slice(0, 7) : '';
}

function monthDate(monthKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(monthKey ?? ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1 || month < 1 || month > 12) return null;
  return new Date(year, month - 1, 1, 12);
}

function monthKeyFromReceiptDate(value) {
  const dateKey = localDateKey(value);
  return dateKey ? dateKey.slice(0, 7) : '';
}

function monthKeyFromTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : localMonthKey(date);
}

function safePaisa(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) return 0;
  return amount;
}

function addPaisa(total, amount) {
  const next = total + amount;
  if (!Number.isSafeInteger(next)) throw new RangeError('Cashflow total exceeds the safe PKR arithmetic range.');
  return next;
}

function uniqueRecordKey(row) {
  if (!row?.id) return null;
  return `${row.organization_id ?? ''}:${row.id}`;
}

function buildMonthSeries(monthCount, now) {
  if (!SUPPORTED_MONTH_WINDOWS.has(Number(monthCount))) {
    throw new Error('Choose a 1-, 3-, or 6-month cashflow window.');
  }
  const current = monthDate(localMonthKey(now));
  if (!current) throw new Error('The local date is not available.');
  const months = [];
  for (let offset = Number(monthCount) - 1; offset >= 0; offset -= 1) {
    const date = new Date(current.getFullYear(), current.getMonth() - offset, 1, 12);
    const key = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
    months.push({
      month: key,
      label: new Intl.DateTimeFormat('en-PK', { month: 'short', year: '2-digit' }).format(date),
      incomePaisa: 0,
      operatingCostsPaisa: 0,
      partnerDistributionsPaisa: 0,
      operatingProfitPaisa: 0,
      netCashflowPaisa: 0,
    });
  }
  return months;
}

export function getCashflowCategory(value) {
  return CATEGORY_BY_VALUE.get(String(value ?? '')) ?? null;
}

export function summarizeCashflow({ receipts = [], expenses = [], monthCount = 3, now = new Date() } = {}) {
  const months = buildMonthSeries(monthCount, now);
  const monthByKey = new Map(months.map((month) => [month.month, month]));
  const asOfDate = localDateKey(now);
  const seenReceipts = new Set();
  for (const receipt of receipts) {
    const receivedDate = localDateKey(receipt.received_on);
    if (!receivedDate || receivedDate > asOfDate) continue;
    const key = uniqueRecordKey(receipt);
    if (key && seenReceipts.has(key)) continue;
    if (key) seenReceipts.add(key);
    const month = monthByKey.get(monthKeyFromReceiptDate(receivedDate));
    if (!month) continue;
    const amount = safePaisa(receipt.amount_cents);
    month.incomePaisa = addPaisa(month.incomePaisa, amount);
  }

  const seenExpenses = new Set();
  for (const expense of expenses) {
    const key = uniqueRecordKey(expense);
    if (key && seenExpenses.has(key)) continue;
    if (key) seenExpenses.add(key);
    const month = monthByKey.get(monthKeyFromTimestamp(expense.created_at));
    const category = getCashflowCategory(expense.category);
    if (!month || !category) continue;
    const amount = safePaisa(expense.amount_paisa);
    if (category.kind === 'distribution') {
      month.partnerDistributionsPaisa = addPaisa(month.partnerDistributionsPaisa, amount);
    } else {
      month.operatingCostsPaisa = addPaisa(month.operatingCostsPaisa, amount);
    }
  }

  for (const month of months) {
    month.operatingProfitPaisa = month.incomePaisa - month.operatingCostsPaisa;
    month.netCashflowPaisa = month.operatingProfitPaisa - month.partnerDistributionsPaisa;
  }
  const totals = months.reduce((result, month) => ({
    incomePaisa: addPaisa(result.incomePaisa, month.incomePaisa),
    operatingCostsPaisa: addPaisa(result.operatingCostsPaisa, month.operatingCostsPaisa),
    partnerDistributionsPaisa: addPaisa(result.partnerDistributionsPaisa, month.partnerDistributionsPaisa),
    operatingProfitPaisa: result.operatingProfitPaisa + month.operatingProfitPaisa,
    netCashflowPaisa: result.netCashflowPaisa + month.netCashflowPaisa,
  }), {
    incomePaisa: 0,
    operatingCostsPaisa: 0,
    partnerDistributionsPaisa: 0,
    operatingProfitPaisa: 0,
    netCashflowPaisa: 0,
  });
  return { months, totals };
}

export function filterCashflowExpenses(expenses = [], {
  search = '',
  category = 'all',
  fromDate = '',
  throughDate = '',
} = {}) {
  const query = String(search ?? '').trim().toLocaleLowerCase('en-PK');
  const rangeIsValid = !fromDate || !throughDate || fromDate <= throughDate;
  if (!rangeIsValid) return [];
  const matches = expenses
    .filter((expense) => {
      if (category !== 'all' && expense.category !== category) return false;
      const date = localDateKey(expense.created_at);
      if (!date || (fromDate && date < fromDate) || (throughDate && date > throughDate)) return false;
      if (!query) return true;
      const label = getCashflowCategory(expense.category)?.label ?? expense.category ?? '';
      const text = `${label} ${expense.note ?? ''} ${expense.amount_paisa ?? ''}`.toLocaleLowerCase('en-PK');
      return text.includes(query);
    });
  const seen = new Set();
  return matches
    .filter((expense) => {
      const key = uniqueRecordKey(expense);
      if (key && seen.has(key)) return false;
      if (key) seen.add(key);
      return true;
    })
    .sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')));
}

function serviceStart({ connectionDate, createdAt }) {
  const connectionDateKey = localDateKey(connectionDate);
  if (connectionDateKey) return { date: connectionDateKey, source: 'service' };
  const createdDateKey = localDateKey(createdAt);
  if (createdDateKey) return { date: createdDateKey, source: 'created' };
  return { date: '', source: '' };
}

function monthSerial(monthKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  return match ? Number(match[1]) * 12 + Number(match[2]) - 1 : NaN;
}

function effectiveCostForMonth(costHistory, customerId, organizationId, monthKey) {
  const monthStart = `${monthKey}-01`;
  return costHistory
    .filter((entry) => entry.customer_id === customerId
      && (!organizationId || entry.organization_id === organizationId)
      && /^\d{4}-\d{2}-01$/.test(String(entry.effective_on ?? ''))
      && String(entry.effective_on) <= monthStart
      && Number.isSafeInteger(Number(entry.monthly_cost_paisa))
      && Number(entry.monthly_cost_paisa) >= 0)
    .sort((left, right) => String(right.effective_on).localeCompare(String(left.effective_on))
      || String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))[0] ?? null;
}

function completedMonths(startDate, today) {
  const start = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate)?.map(Number);
  const end = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today)?.map(Number);
  if (!start || !end || startDate > today) return null;
  let months = (end[1] - start[1]) * 12 + (end[2] - start[2]);
  if (end[3] < start[3]) months -= 1;
  return Math.max(0, months);
}

export function summarizeCustomerMargin({
  customerId,
  organizationId = '',
  receipts = [],
  costHistory = [],
  connectionDate = '',
  createdAt = '',
  now = new Date(),
} = {}) {
  const currentDate = localDateKey(now);
  const collectedReceipts = new Set();
  let collectedPaisa = 0;
  for (const receipt of receipts) {
    if (receipt.customer_id !== customerId) continue;
    if (organizationId && receipt.organization_id !== organizationId) continue;
    const receivedDate = localDateKey(receipt.received_on);
    if (!receivedDate || receivedDate > currentDate) continue;
    const key = uniqueRecordKey(receipt);
    if (key && collectedReceipts.has(key)) continue;
    if (key) collectedReceipts.add(key);
    collectedPaisa = addPaisa(collectedPaisa, safePaisa(receipt.amount_cents));
  }

  const currentMonth = currentDate.slice(0, 7);
  const start = serviceStart({ connectionDate, createdAt });
  const monthsOfTenure = start.date ? completedMonths(start.date, currentDate) : null;
  const tenureAvailable = monthsOfTenure !== null;
  const coverage = { serviceMonths: monthsOfTenure ?? 0, costMonths: 0, uncoveredMonths: 0 };
  let assignedCostPaisa = 0;
  const startSerial = start.date ? monthSerial(start.date.slice(0, 7)) : NaN;

  if (tenureAvailable && monthsOfTenure > 0) {
    for (let index = 0; index < monthsOfTenure; index += 1) {
      const serial = startSerial + index;
      const year = Math.floor(serial / 12);
      const month = (serial % 12) + 1;
      const monthKey = `${year}-${pad2(month)}`;
      const cost = effectiveCostForMonth(costHistory, customerId, organizationId, monthKey);
      if (!cost) {
        coverage.uncoveredMonths += 1;
        continue;
      }
      coverage.costMonths += 1;
      assignedCostPaisa = addPaisa(assignedCostPaisa, Number(cost.monthly_cost_paisa));
    }
  }

  const currentEffectiveCost = effectiveCostForMonth(costHistory, customerId, organizationId, currentMonth);
  const estimateAvailable = tenureAvailable && coverage.costMonths > 0;
  return {
    collectedPaisa,
    serviceStartDate: start.date,
    serviceStartSource: start.source,
    tenureMonths: monthsOfTenure,
    serviceMonths: coverage.serviceMonths,
    costMonths: coverage.costMonths,
    uncoveredMonths: coverage.uncoveredMonths,
    assignedCostPaisa,
    estimatedContributionPaisa: estimateAvailable ? collectedPaisa - assignedCostPaisa : null,
    currentMonthlyCostPaisa: currentEffectiveCost ? Number(currentEffectiveCost.monthly_cost_paisa) : null,
    currentCostEntryId: currentEffectiveCost?.id ?? null,
  };
}
