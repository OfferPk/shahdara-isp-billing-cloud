const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function packageKey(value) {
  return String(value ?? '').trim().toLocaleLowerCase('en-PK');
}

function centsValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const cents = Number(value);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

export function isValidIsoDate(value) {
  const match = DATE_PATTERN.exec(String(value ?? ''));
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day);
}

export function normalizePackageName(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('Package name must contain 1 to 100 printable characters.');
  }
  return name;
}

/** Merge imported router profiles with tariffs, keeping unpriced profiles visible. */
export function buildPackagePricingRows(customers = [], packages = []) {
  const rowsByKey = new Map();
  for (const record of packages) {
    const name = String(record?.name ?? '').trim();
    const key = packageKey(name);
    if (!key) continue;
    rowsByKey.set(key, {
      packageId: String(record.id ?? ''),
      name,
      monthlyFeeCents: centsValue(record.monthly_fee_cents),
      effectiveOn: String(record.effective_on ?? ''),
      quotaType: record.quota_type === 'fup_capped' ? 'fup_capped' : 'unlimited',
      quotaLimitGb: Number.isSafeInteger(Number(record.quota_limit_gb)) && Number(record.quota_limit_gb) > 0
        ? Number(record.quota_limit_gb) : null,
      actionOnExhaust: ['notify', 'throttle', 'suspend'].includes(record.action_on_exhaust) ? record.action_on_exhaust : 'notify',
      activeCustomerCount: 0,
      customerCount: 0,
    });
  }

  const legacyFees = new Map();
  for (const customer of customers) {
    const name = String(customer?.plan_name ?? '').trim();
    const key = packageKey(name);
    if (!key) continue;
    let row = rowsByKey.get(key);
    if (!row) {
      row = {
        packageId: String(customer.package_id ?? ''),
        name,
        monthlyFeeCents: null,
        effectiveOn: '',
        quotaType: 'unlimited',
        quotaLimitGb: null,
        actionOnExhaust: 'notify',
        activeCustomerCount: 0,
        customerCount: 0,
      };
      rowsByKey.set(key, row);
    }
    row.customerCount += 1;
    if (!customer.archived && customer.service_status === 'active') row.activeCustomerCount += 1;
    const fee = centsValue(customer.monthly_fee_cents);
    if (fee !== null) {
      if (!legacyFees.has(key)) legacyFees.set(key, new Set());
      legacyFees.get(key).add(fee);
    }
  }

  for (const [key, row] of rowsByKey) {
    if (row.monthlyFeeCents === null) {
      const fees = legacyFees.get(key);
      if (fees?.size === 1) row.monthlyFeeCents = [...fees][0];
    }
  }
  return [...rowsByKey.values()].sort((left, right) => left.name.localeCompare(right.name, 'en-PK'));
}

export function buildMonthlyInvoiceRequest({ billingMonth, issueDate, dueDate } = {}) {
  const month = String(billingMonth ?? '').trim();
  if (!MONTH_PATTERN.test(month)) throw new Error('Choose a valid billing month.');
  const issued = String(issueDate ?? '').trim();
  const due = String(dueDate ?? '').trim();
  if (!isValidIsoDate(issued)) throw new Error('Enter a valid issue date.');
  if (!isValidIsoDate(due)) throw new Error('Choose an exact due date before generating invoices.');
  return { billingMonth: month, issueDate: issued, dueDate: due };
}

export function buildInvoiceShareText({ bill, customer, formatMoney, t = (value) => value } = {}) {
  if (!bill?.id || !customer?.name || typeof formatMoney !== 'function') {
    throw new Error('A saved invoice, its customer, and a money formatter are required.');
  }
  const invoiceNumber = String(bill.invoice_number ?? '').trim() || String(bill.id);
  const username = String(customer.pppoe_username ?? '').trim() || t('Not recorded');
  const plan = String(bill.plan_snapshot ?? '').trim() || String(customer.plan_name ?? '').trim() || t('Package not recorded');
  return [
    `${t('Invoice')}: ${invoiceNumber}`,
    `${t('Customer')}: ${customer.name}`,
    `${t('PPPoE Username')}: ${username}`,
    `${t('Package')}: ${plan}`,
    `${t('Billing Month')}: ${String(bill.period ?? '').slice(0, 7) || t('Not recorded')}`,
    `${t('Due Date')}: ${String(bill.due_date ?? '').trim() || t('Not recorded')}`,
    `${t('Total Amount')}: ${formatMoney(bill.amount_due_cents)}`,
  ].join('\n');
}
