import { createPortalClient } from './supabase-client.js';
import { validatePakistanPhone } from './customer-input.js';
import { createCustomer, invokeRpc, loadContexts, loadPortalRows, manageServiceIncident } from './portal-data.js';
import { getBillingCycleQuickDate, isValidBillingMonth, localDateString, localMonthString } from './bill-dates.js';
import { amountToMinorUnits, calculateDashboard, formatMoney } from './ledger.js';
import { renderDashboardMetrics } from './dashboard-metrics.js';
import {
  buildCustomerListRows,
  filterCustomerRows,
  getCustomerAreaOptions,
  renderCustomerCards,
  renderCustomerProfile,
  summarizeCustomerRows,
} from './customer-list.js';
import {
  buildIncidentTimeline,
  filterCustomerBillingData,
  formatBillingMonth,
  getCustomerBillingMonths,
  summarizeCustomerBill,
} from './customer-portal.js';
import {
  buildAdminBillRows,
  countAdminBillFilters,
  filterAdminBillRows,
  renderAdminBillCards,
  renderPrintableReceiptHtml,
} from './admin-bills.js';
import { renderAdminIncidentCards, renderIncidentCustomerOptions } from './admin-incidents.js';
import { applyDocumentLanguage, formatUiMessage, getStoredLanguage, normalizeLanguage, setLanguagePreference, translateUi } from './language.js';
import './styles.css';

const app = document.querySelector('#app');
const configMessage = document.querySelector('#configuration-message');
const authPanel = document.querySelector('#auth-panel');
const portalPanel = document.querySelector('#portal-panel');
const loginForm = document.querySelector('#login-form');
const loginMessage = document.querySelector('#login-message');
let currentLanguage = getStoredLanguage();
const t = (message) => translateUi(message, currentLanguage);
let rerenderForLanguage = () => {};

function applyStaticTranslations(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of root.querySelectorAll('[data-i18n-aria-label]')) {
    element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
  }
  const group = document.querySelector('#language-toggle');
  if (group) {
    group.setAttribute('aria-label', t('Language'));
    for (const button of group.querySelectorAll('[data-language]')) {
      const selected = normalizeLanguage(button.dataset.language) === currentLanguage;
      button.setAttribute('aria-pressed', String(selected));
      button.classList.toggle('is-active', selected);
    }
  }
}

applyDocumentLanguage(document, currentLanguage);
applyStaticTranslations();
document.querySelector('#language-toggle')?.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-language]') : null;
  if (!button) return;
  const nextLanguage = normalizeLanguage(button.dataset.language);
  if (nextLanguage === currentLanguage) return;
  currentLanguage = setLanguagePreference(nextLanguage).language;
  applyStaticTranslations();
  for (const message of document.querySelectorAll('[data-message-source]')) {
    let values = {};
    try { values = JSON.parse(message.dataset.messageValues || '{}'); } catch { /* Ignore invalid optional toast parameters. */ }
    message.textContent = Object.keys(values).length
      ? formatUiMessage(message.dataset.messageSource, currentLanguage, values)
      : t(message.dataset.messageSource);
  }
  rerenderForLanguage();
  const announcement = document.querySelector('#app-announcement');
  if (announcement) announcement.textContent = t(currentLanguage === 'ur-Latn' ? 'Language changed to Roman Urdu.' : 'Language changed to English.');
});

const supabase = createPortalClient(import.meta.env);

if (!supabase) {
  configMessage.hidden = false;
} else {
  const pageState = {
    user: null,
    contexts: [],
    context: null,
    rows: null,
    selectedMonth: localMonth(),
    billCycleMonth: localMonth(),
    billIssueDate: localDate(),
    billDueDate: '',
    loadingUserId: null,
    customerListSearch: '',
    customerListStatus: 'all',
    customerListArea: '',
    customerAreaOpen: false,
    billSearch: '',
    billStatus: 'all',
    customerBillingMonth: '',
    customerReceiptFrom: '',
    customerReceiptThrough: '',
  };
  let pendingReceiptAttempt = null;

  function receiptAttemptKey(context) {
    return `shahdara-cloud-receipt-attempt:${pageState.user?.id ?? 'signed-out'}:${context.organizationId}`;
  }

  function getReceiptAttempt(context) {
    const key = receiptAttemptKey(context);
    if (pendingReceiptAttempt?.key === key) return pendingReceiptAttempt;
    try {
      const id = sessionStorage.getItem(key);
      if (!id) return null;
      pendingReceiptAttempt = { key, id };
      return pendingReceiptAttempt;
    } catch {
      return null;
    }
  }

  function saveReceiptAttempt(context, id) {
    const key = receiptAttemptKey(context);
    pendingReceiptAttempt = { key, id };
    try { sessionStorage.setItem(key, id); } catch { /* Keep the in-memory id for this tab. */ }
  }

  function clearReceiptAttempt() {
    if (!pendingReceiptAttempt) return;
    try { sessionStorage.removeItem(pendingReceiptAttempt.key); } catch { /* No browser storage is required for portal access. */ }
    pendingReceiptAttempt = null;
  }

  function localMonth(date = new Date()) {
    return localMonthString(date);
  }

  function localDate(date = new Date()) {
    return localDateString(date);
  }

  function incidentTimestamp(value, label) {
    const localValue = String(value ?? '').trim();
    if (!localValue) return null;
    const parsed = new Date(localValue);
    if (Number.isNaN(parsed.getTime())) throw new Error(formatUiMessage('{field} must be a valid local date and time.', currentLanguage, { field: label }));
    return parsed.toISOString();
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function setMessage(node, message = '', isError = false, values = {}) {
    if (!node) return;
    node.dataset.messageSource = message;
    node.dataset.messageValues = Object.keys(values).length ? JSON.stringify(values) : '';
    node.textContent = Object.keys(values).length ? formatUiMessage(message, currentLanguage, values) : t(message);
    node.setAttribute('role', isError ? 'alert' : 'status');
    node.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    node.setAttribute('aria-atomic', 'true');
    node.classList.toggle('error-text', isError);
    node.classList.toggle('success-text', Boolean(message) && !isError);
  }

  function announceApp(message) {
    const announcement = document.querySelector('#app-announcement');
    if (announcement) {
      announcement.dataset.messageSource = message;
      announcement.textContent = t(message);
    }
  }

  function showLogin(message = '') {
    configMessage.hidden = true;
    portalPanel.hidden = true;
    authPanel.hidden = false;
    setMessage(loginMessage, message, false);
  }

  function showPortalLoading() {
    configMessage.hidden = true;
    authPanel.hidden = true;
    portalPanel.hidden = false;
    portalPanel.innerHTML = `<div class="panel loading-panel" role="status" aria-live="polite" aria-busy="true"><span class="spinner" aria-hidden="true"></span><p>${escapeHtml(t('Loading records allowed for this account…'))}</p></div>`;
  }

  async function selectContext(context) {
    const contextChanged = pageState.context?.organizationId !== context.organizationId
      || pageState.context?.kind !== context.kind
      || pageState.context?.customerId !== context.customerId;
    if (pageState.context?.organizationId !== context.organizationId || pageState.context?.kind !== context.kind) {
      pageState.customerListSearch = '';
      pageState.customerListStatus = 'all';
      pageState.customerListArea = '';
      pageState.customerAreaOpen = false;
      pageState.billSearch = '';
      pageState.billStatus = 'all';
    }
    if (pageState.context?.organizationId !== context.organizationId
      || pageState.context?.kind !== context.kind
      || pageState.context?.customerId !== context.customerId) {
      pageState.customerBillingMonth = '';
      pageState.customerReceiptFrom = '';
      pageState.customerReceiptThrough = '';
    }
    pageState.context = context;
    showPortalLoading();
    try {
      pageState.rows = await loadPortalRows(supabase, context);
      renderPortal();
      if (contextChanged) portalPanel.querySelector('h1')?.focus();
      announceApp(context.kind === 'admin' ? 'Administrator portal loaded.' : 'Customer portal loaded.');
    } catch (error) {
      portalPanel.innerHTML = `<div class="panel" role="alert"><p class="eyebrow">${escapeHtml(t('Could not load records'))}</p><h2>${escapeHtml(t('Access was not granted'))}</h2><p class="error-text">${escapeHtml(error.message || t('The request failed.'))}</p><p>${escapeHtml(t('Database row-level policies remain authoritative; contact the ISP administrator if this account should have portal access.'))}</p><button class="button secondary" data-action="sign-out">${escapeHtml(t('Sign out'))}</button></div>`;
      bindSharedActions();
    }
  }

  async function handleSession(session) {
    if (!session) {
      pageState.user = null;
      pageState.contexts = [];
      pageState.context = null;
      pageState.rows = null;
      pendingReceiptAttempt = null;
      showLogin();
      return;
    }
    if (pageState.loadingUserId === session.user.id) return;
    if (pageState.user?.id === session.user.id && pageState.contexts.length) return;
    pageState.loadingUserId = session.user.id;
    pageState.user = session.user;
    showPortalLoading();
    try {
      pageState.contexts = await loadContexts(supabase, session.user);
      if (!pageState.contexts.length) {
        portalPanel.innerHTML = `<div class="panel" role="status"><p class="eyebrow">${escapeHtml(t('No portal access'))}</p><h2>${escapeHtml(t('This email is not linked to an ISP account'))}</h2><p>${escapeHtml(t('Ask the ISP administrator to assign an Admin role or send a customer invitation.'))}</p><button class="button secondary" data-action="sign-out">${escapeHtml(t('Sign out'))}</button></div>`;
        announceApp('No portal access is linked to this account.');
        bindSharedActions();
        return;
      }
      await selectContext(pageState.contexts[0]);
    } catch (error) {
      portalPanel.innerHTML = `<div class="panel" role="alert"><p class="eyebrow">${escapeHtml(t('Sign-in could not be completed'))}</p><h2>${escapeHtml(t('Account access needs review'))}</h2><p class="error-text">${escapeHtml(error.message || t('The request failed.'))}</p><button class="button secondary" data-action="sign-out">${escapeHtml(t('Sign out'))}</button></div>`;
      bindSharedActions();
    } finally {
      pageState.loadingUserId = null;
    }
  }

  function bindSharedActions() {
    portalPanel.querySelector('[data-action="sign-out"]')?.addEventListener('click', async () => {
      await supabase.auth.signOut();
      showLogin('You have signed out.');
    });
  }

  function allocationTotals(rows, billId) {
    return rows.allocations.filter((row) => row.bill_id === billId)
      .reduce((sum, row) => sum + Number(row.amount_cents || 0), 0);
  }

  function receiptTotalForBill(rows, billId) {
    return rows.receipts.filter((row) => row.origin_bill_id === billId)
      .reduce((sum, row) => sum + Number(row.amount_cents || 0), 0);
  }

  function renderPortal() {
    if (!pageState.context || !pageState.rows) return;
    if (pageState.context.kind === 'admin') renderAdmin();
    else renderCustomer();
  }

  function snapshotPortalUi() {
    if (portalPanel.hidden || !pageState.context || !pageState.rows) return null;
    const controls = [...portalPanel.querySelectorAll('input, select, textarea')];
    const activeElement = document.activeElement;
    return {
      controls: controls.map((control) => ({ value: control.value, checked: control.checked, selectedIndex: control.selectedIndex })),
      focusedId: activeElement?.id || '',
      focusedIndex: controls.indexOf(activeElement),
      dialogs: [...portalPanel.querySelectorAll('dialog[open]')].map((dialog) => ({ id: dialog.id, customerId: dialog.querySelector('#customer-profile-content')?.dataset.customerId || '' })),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
  }

  function restorePortalUi(snapshot) {
    if (!snapshot) return;
    for (const dialog of snapshot.dialogs) {
      if (dialog.id === 'customer-profile-dialog' && dialog.customerId) openCustomerProfile(dialog.customerId);
    }
    const controls = [...portalPanel.querySelectorAll('input, select, textarea')];
    snapshot.controls.forEach((saved, index) => {
      const control = controls[index];
      if (!control) return;
      control.value = saved.value;
      control.checked = saved.checked;
      if (control instanceof HTMLSelectElement) control.selectedIndex = saved.selectedIndex;
    });
    for (const dialog of snapshot.dialogs) {
      if (dialog.id === 'customer-profile-dialog') continue;
      const element = portalPanel.querySelector(`#${CSS.escape(dialog.id)}`);
      if (element instanceof HTMLDialogElement && !element.open) element.showModal();
    }
    const focusTarget = snapshot.focusedId ? portalPanel.querySelector(`#${CSS.escape(snapshot.focusedId)}`) : controls[snapshot.focusedIndex];
    focusTarget?.focus({ preventScroll: true });
    window.scrollTo(snapshot.scrollX, snapshot.scrollY);
  }

  rerenderForLanguage = () => {
    const snapshot = snapshotPortalUi();
    if (!snapshot) return;
    renderPortal();
    restorePortalUi(snapshot);
  };

  function contextSelectHtml() {
    if (pageState.contexts.length < 2) return '';
    return `<label class="context-picker">${escapeHtml(t('Organization/account'))}<select id="context-picker">${pageState.contexts.map((context, index) => {
      const label = context.kind === 'admin'
        ? `${context.organizationName} · ${context.role}`
        : `${context.customerName} · ${t('Customer')}`;
      return `<option value="${index}" ${context === pageState.context ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('')}</select></label>`;
  }

  function shellHeader(label) {
    const accountLabel = pageState.context?.kind === 'admin'
      ? `${t('Signed in as')} ${pageState.user?.email ?? ''}`
      : t('Linked customer account');
    return `<div class="portal-heading"><div><p class="eyebrow">${escapeHtml(label)}</p><h1 tabindex="-1">${escapeHtml(pageState.context.organizationName ?? 'Shahdara Fiber Net')}</h1><p class="muted">${escapeHtml(accountLabel)}</p></div><div class="header-actions">${contextSelectHtml()}<button class="button secondary small" data-action="sign-out">${escapeHtml(t('Sign out'))}</button></div></div>`;
  }

  function renderPortalNavigation(kind) {
    const links = kind === 'admin'
      ? [['#admin-overview', 'Overview'], ['#customer-list', 'Customers'], ['#admin-bills', 'Bills'], ['#admin-receipts', 'Receipts'], ['#admin-incidents', 'Service incidents']]
      : [['#customer-account', 'My account'], ['#customer-billing', 'Billing history'], ['#customer-incidents', 'Service updates']];
    return `<nav class="portal-nav" aria-label="${escapeHtml(t('Portal navigation'))}">${links.map(([href, label]) => `<a href="${href}">${escapeHtml(t(label))}</a>`).join('')}</nav>`;
  }

  function wirePortalBase() {
    bindSharedActions();
    portalPanel.querySelector('#context-picker')?.addEventListener('change', async (event) => {
      const context = pageState.contexts[Number(event.target.value)];
      if (context) await selectContext(context);
    });
  }

  function currentCustomerListRows() {
    const rows = pageState.rows;
    if (!rows || pageState.context?.kind !== 'admin') return [];
    return buildCustomerListRows({
      customers: rows.customers,
      bills: rows.bills,
      allocations: rows.allocations,
      privateDetails: rows.privateCustomerDetails,
      currentMonth: localMonth(),
    });
  }

  function updateCustomerListResults() {
    const listRows = currentCustomerListRows();
    const filteredRows = filterCustomerRows(listRows, {
      search: pageState.customerListSearch,
      status: pageState.customerListStatus,
      area: pageState.customerListArea,
    });
    const grid = portalPanel.querySelector('#customer-card-grid');
    const count = portalPanel.querySelector('#customer-list-count');
    if (grid) {
      grid.innerHTML = listRows.length
        ? renderCustomerCards(filteredRows, formatMoney, t)
        : `<p class="customer-list-empty" role="status">${escapeHtml(t('No customer records yet.'))}</p>`;
    }
    if (count) count.textContent = formatUiMessage('Showing {shown} of {total} customers.', currentLanguage, { shown: filteredRows.length, total: listRows.length });
    for (const button of portalPanel.querySelectorAll('[data-billing-filter]')) {
      const selected = button.dataset.billingFilter === pageState.customerListStatus;
      button.setAttribute('aria-pressed', String(selected));
      button.classList.toggle('is-active', selected);
    }
    const areaToggle = portalPanel.querySelector('[data-action="toggle-area-filter"]');
    const areaSelect = portalPanel.querySelector('#customer-area-filter');
    if (areaToggle) {
      areaToggle.setAttribute('aria-expanded', String(pageState.customerAreaOpen));
      areaToggle.setAttribute('aria-pressed', String(Boolean(pageState.customerListArea)));
      areaToggle.classList.toggle('is-active', Boolean(pageState.customerListArea));
    }
    if (areaSelect) {
      areaSelect.hidden = !pageState.customerAreaOpen;
      areaSelect.value = pageState.customerListArea;
    }
  }

  function openCustomerProfile(customerId) {
    const row = currentCustomerListRows().find((entry) => entry.customer.id === customerId);
    const dialog = portalPanel.querySelector('#customer-profile-dialog');
    const content = portalPanel.querySelector('#customer-profile-content');
    if (!row || !dialog || !content) return;
    content.innerHTML = renderCustomerProfile(row, {
      bills: pageState.rows.bills,
      receipts: pageState.rows.receipts,
      allocations: pageState.rows.allocations,
      formatMoney,
      t,
    });
    content.dataset.customerId = customerId;
    content.querySelector('[data-action="close-customer-profile"]')?.addEventListener('click', () => dialog.close());
    dialog.showModal();
    content.querySelector('[data-action="close-customer-profile"]')?.focus();
  }

  function currentAdminBillRows() {
    if (!pageState.rows || pageState.context?.kind !== 'admin') return [];
    return buildAdminBillRows({
      customers: pageState.rows.customers,
      bills: pageState.rows.bills,
      receipts: pageState.rows.receipts,
      allocations: pageState.rows.allocations,
      privateDetails: pageState.rows.privateCustomerDetails,
      today: localDate(),
      t,
    });
  }

  function updateAdminBillResults() {
    const billRows = currentAdminBillRows();
    const filteredRows = filterAdminBillRows(billRows, { search: pageState.billSearch, status: pageState.billStatus });
    const counts = countAdminBillFilters(billRows, { search: pageState.billSearch });
    const grid = portalPanel.querySelector('#admin-bill-card-grid');
    const count = portalPanel.querySelector('#admin-bill-count');
    if (grid) grid.innerHTML = renderAdminBillCards(filteredRows, formatMoney, t);
    if (count) count.textContent = formatUiMessage('Showing {shown} of {matching} matching bills; {total} total records.', currentLanguage, { shown: Math.min(filteredRows.length, 100), matching: filteredRows.length, total: billRows.length });
    for (const button of portalPanel.querySelectorAll('[data-bill-status]')) {
      const status = button.dataset.billStatus;
      const selected = status === pageState.billStatus;
      const label = status === 'unpaid' ? t('Unpaid') : status === 'paid' ? t('Paid') : t('All');
      button.textContent = `${label} (${counts[status] ?? 0})`;
      button.setAttribute('aria-pressed', String(selected));
      button.classList.toggle('is-active', selected);
    }
  }

  function openReceiptFormForBill(billRow) {
    if (!billRow || billRow.status !== 'unpaid' || billRow.balanceCents == null || billRow.balanceCents <= 0) return false;
    const bill = billRow.bill;
    const form = portalPanel.querySelector('#receipt-form');
    const customerSelect = portalPanel.querySelector('#receipt-customer');
    const billSelect = portalPanel.querySelector('#receipt-bill');
    if (!form || !customerSelect || !billSelect) return false;
    customerSelect.value = bill.customer_id;
    populateReceiptBills(bill.customer_id);
    billSelect.value = bill.id;
    if (billSelect.value !== bill.id) return false;
    form.elements.received_on.value = localDate();
    form.elements.amount.value = (billRow.balanceCents / 100).toFixed(2);
    form.elements.method.value = '';
    setMessage(portalPanel.querySelector('#receipt-message'), 'Review the actual received date and payment method, then submit the receipt. Nothing has been recorded yet.');
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    form.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    form.elements.received_on.focus({ preventScroll: true });
    return true;
  }

  function openReceiptFormForCustomer(row) {
    const bill = row?.paymentBill ?? row?.bill;
    if (!bill || row?.billing?.status !== 'unpaid' || row.billing.balanceCents == null || row.billing.balanceCents <= 0) return;
    const billRow = currentAdminBillRows().find((entry) => entry.bill.id === bill.id);
    openReceiptFormForBill(billRow);
  }

  function printExistingReceipt(receiptId) {
    const receipt = pageState.rows?.receipts.find((row) => row.id === receiptId);
    if (!receipt) return;
    const customer = pageState.rows.customers.find((row) => row.id === receipt.customer_id);
    const bill = pageState.rows.bills.find((row) => row.id === receipt.origin_bill_id && row.customer_id === receipt.customer_id);
    const printWindow = window.open('', '_blank', 'popup,width=760,height=900');
    if (!printWindow) {
      window.alert(t('Allow the print window to open, then choose Print or Save as PDF.'));
      return;
    }
    printWindow.document.open();
    printWindow.document.write(renderPrintableReceiptHtml({
      receipt,
      customer,
      bill,
      organizationName: pageState.context.organizationName,
      formatMoney,
      t,
      language: currentLanguage,
    }));
    printWindow.document.close();
    printWindow.opener = null;
    printWindow.focus();
    window.setTimeout(() => printWindow.print(), 150);
  }

  function renderAdmin() {
    const context = pageState.context;
    const rows = pageState.rows;
    const totals = calculateDashboard({
      month: pageState.selectedMonth,
      customers: rows.customers,
      bills: rows.bills,
      receipts: rows.receipts,
      allocations: rows.allocations,
    });
    const customers = [...rows.customers].sort((a, b) => a.customer_number - b.customer_number);
    const bills = [...rows.bills].sort((a, b) => String(b.period).localeCompare(String(a.period)));
    const receipts = [...rows.receipts].sort((a, b) => String(b.received_on).localeCompare(String(a.received_on)));
    const adminBillRows = buildAdminBillRows({
      customers,
      bills: rows.bills,
      receipts: rows.receipts,
      allocations: rows.allocations,
      privateDetails: rows.privateCustomerDetails,
      today: localDate(),
      t,
    });
    const billCounts = countAdminBillFilters(adminBillRows, { search: pageState.billSearch });
    const filteredAdminBillRows = filterAdminBillRows(adminBillRows, { search: pageState.billSearch, status: pageState.billStatus });
    const customerListRows = buildCustomerListRows({
      customers,
      bills: rows.bills,
      allocations: rows.allocations,
      privateDetails: rows.privateCustomerDetails,
      currentMonth: localMonth(),
    });
    const customerSummary = summarizeCustomerRows(customerListRows);
    const filteredCustomerRows = filterCustomerRows(customerListRows, {
      search: pageState.customerListSearch,
      status: pageState.customerListStatus,
      area: pageState.customerListArea,
    });
    const customerAreaOptions = getCustomerAreaOptions(customerListRows)
      .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
    const customerName = (id) => rows.customers.find((customer) => customer.id === id)?.name ?? t('Customer');
    const monthOptions = customers.map((customer) => `<option value="${escapeHtml(customer.id)}">#${customer.customer_number} · ${escapeHtml(customer.name)}</option>`).join('');
    const billOptions = bills.map((bill) => `<option value="${escapeHtml(bill.id)}">${escapeHtml(customerName(bill.customer_id))} · ${escapeHtml(bill.period.slice(0, 7))} · ${formatMoney(bill.amount_due_cents)}</option>`).join('');
    const inviteCustomers = customers.filter((customer) => !customer.archived);
    const inviteCustomerOptions = inviteCustomers.map((customer) => `<option value="${escapeHtml(customer.id)}">#${customer.customer_number} · ${escapeHtml(customer.name)}</option>`).join('');
    const incidentCustomerOptions = renderIncidentCustomerOptions(customers);
    const incidents = [...rows.incidents].sort((a, b) => String(b.reported_at).localeCompare(String(a.reported_at)));
    const incidentCards = renderAdminIncidentCards({
      incidents,
      privateDetails: rows.privateIncidentDetails,
      customers,
      t,
    });

    portalPanel.innerHTML = `${shellHeader(t('Administrator portal'))}
      ${renderPortalNavigation('admin')}
      ${renderDashboardMetrics({ month: pageState.selectedMonth, totals, t })}
      <section class="panel month-panel"><label for="dashboard-month">${escapeHtml(t('Dashboard month'))}</label><input type="month" id="dashboard-month" value="${escapeHtml(pageState.selectedMonth)}"><p class="muted">${escapeHtml(t('Cash totals follow receipt dates. Credit allocation is shown separately and is never counted as another payment.'))}</p></section>
      <div class="admin-grid">
        <section class="panel"><p class="eyebrow">${escapeHtml(t('Customer records'))}</p><h2>${escapeHtml(t('Add customer'))}</h2>
          <form id="customer-form" class="form-grid">
            <label>${escapeHtml(t('Customer number'))}<input name="customer_number" type="number" min="1" step="1" required></label>
            <label>${escapeHtml(t('Customer name'))}<input name="name" maxlength="100" required></label>
            <label>${escapeHtml(t('Plan / speed'))}<input name="plan_name" maxlength="100"></label>
            <label>${escapeHtml(t('Monthly fee (PKR)'))}<input name="monthly_fee" inputmode="decimal" placeholder="${escapeHtml(t('Leave blank if not set'))}"></label>
            <label>${escapeHtml(t('Service address'))}<input name="service_address" maxlength="300"></label>
            <label>${escapeHtml(t('Phone (private)'))}<input name="phone" type="text" inputmode="tel" autocomplete="tel" maxlength="40" placeholder="${escapeHtml(t('03XXXXXXXXX or +923XXXXXXXXX'))}"></label>
            <label>${escapeHtml(t('Service status'))}<select name="service_status"><option value="not-set">${escapeHtml(t('Not set'))}</option><option value="active">${escapeHtml(t('Active'))}</option><option value="offline">${escapeHtml(t('Offline'))}</option></select></label>
            <button class="button primary" type="submit">${escapeHtml(t('Save customer'))}</button>
          </form><p class="form-message" id="customer-message" role="status"></p>
        </section>
        <section class="panel"><p class="eyebrow">${escapeHtml(t('Monthly billing'))}</p><h2>${escapeHtml(t('Create bill snapshot'))}</h2>
          <form id="bill-form" class="stack">
            <label for="bill-customer">${escapeHtml(t('Customer'))}</label><select id="bill-customer" name="customer_id" required>${monthOptions}</select>
            <label for="bill-month">${escapeHtml(t('Billing Cycle Month'))}</label><input id="bill-month" name="period" type="month" value="${escapeHtml(pageState.billCycleMonth)}" required>
            <label for="bill-issued-on">${escapeHtml(t('Issue Date'))}</label><input id="bill-issued-on" name="issued_on" type="date" value="${escapeHtml(pageState.billIssueDate)}">
            <label for="bill-due-date">${escapeHtml(t('Exact Due Date'))}</label><input id="bill-due-date" name="due_date" type="date" value="${escapeHtml(pageState.billDueDate)}">
            <div class="due-date-presets" role="group" aria-label="${escapeHtml(t('Choose an exact due date quickly'))}">
              <button class="due-date-preset" type="button" data-due-date-preset="today" aria-controls="bill-due-date">${escapeHtml(t('Today'))}</button>
              <button class="due-date-preset" type="button" data-due-date-preset="fifth" aria-controls="bill-due-date">${escapeHtml(t('5th of Month'))}</button>
              <button class="due-date-preset" type="button" data-due-date-preset="tenth" aria-controls="bill-due-date">${escapeHtml(t('10th of Month'))}</button>
              <button class="due-date-preset" type="button" data-due-date-preset="end" aria-controls="bill-due-date">${escapeHtml(t('End of Month'))}</button>
            </div>
            <p class="muted">${escapeHtml(t('The issue date starts at today on this device. Due dates are never assumed; month-based choices follow the selected billing cycle.'))}</p>
            <button class="button primary" type="submit">${escapeHtml(t('Create monthly bill'))}</button>
          </form><p class="form-message" id="bill-message" role="status"></p>
          <hr><p class="muted">${escapeHtml(t('One bill per customer/month. Existing snapshots are returned unchanged. Price corrections are recorded and recalculate derived balances.'))}</p>
        </section>
        <section class="panel"><p class="eyebrow">${escapeHtml(t('Customer access'))}</p><h2>${escapeHtml(t('Invite a customer'))}</h2>
          <p class="muted">${escapeHtml(t('Choose an existing active customer and request a portal invitation. This page cannot confirm email delivery. Repeating the same customer and email safely recovers an earlier request without sending a second invitation.'))}</p>
          <form id="invite-form" class="stack">
            <label for="invite-customer">${escapeHtml(t('Existing customer'))}</label><select id="invite-customer" name="customer_id" required ${inviteCustomers.length ? '' : 'disabled'}>${inviteCustomerOptions || `<option value="">${escapeHtml(t('No active customers available'))}</option>`}</select>
            <label for="invite-email">${escapeHtml(t('Email address'))}</label><input id="invite-email" name="email" type="email" autocomplete="email" maxlength="254" required ${inviteCustomers.length ? '' : 'disabled'}>
            <button class="button primary" type="submit" ${inviteCustomers.length ? '' : 'disabled'}>${escapeHtml(t('Request invitation'))}</button>
          </form><p class="form-message" id="invite-message" role="status" aria-live="polite">${inviteCustomers.length ? '' : escapeHtml(t('Add an active customer before requesting an invitation.'))}</p>
          <p class="muted">${escapeHtml(t('Customer-to-account links remain server-managed and cannot be written from the browser. If a result is uncertain, use the same customer and email to recover; unresolved account states stop for administrator review.'))}</p>
        </section>
        <section class="panel"><p class="eyebrow">${escapeHtml(t('Cash ledger'))}</p><h2>${escapeHtml(t('Record actual receipt'))}</h2>
          <form id="receipt-form" class="form-grid">
            <label>${escapeHtml(t('Customer'))}<select name="customer_id" id="receipt-customer" required>${monthOptions}</select></label>
            <label>${escapeHtml(t('Bill'))}<select name="bill_id" id="receipt-bill" required>${billOptions}</select></label>
            <label>${escapeHtml(t('Received on'))}<input name="received_on" type="date" value="${localDate()}" required></label>
            <label>${escapeHtml(t('Amount received (PKR)'))}<input name="amount" inputmode="decimal" required></label>
            <label>${escapeHtml(t('Method'))}<select name="method" required><option value="" selected disabled>${escapeHtml(t('Select a method'))}</option><option value="Cash">${escapeHtml(t('Cash'))}</option><option value="Easypaisa">Easypaisa</option><option value="JazzCash">JazzCash</option><option value="Bank transfer">${escapeHtml(t('Bank transfer'))}</option><option value="Other">${escapeHtml(t('Other'))}</option></select></label>
            <button class="button primary" type="submit">${escapeHtml(t('Record receipt'))}</button>
          </form><p class="form-message" id="receipt-message" role="status"></p>
        </section>
      </div>
      <section id="customer-list" class="panel data-panel customer-list-panel" aria-labelledby="customer-list-title">
        <div class="customer-list-heading"><div><p class="eyebrow">${escapeHtml(t('Customer directory'))}</p><h2 id="customer-list-title">${escapeHtml(t('Customers'))}</h2></div>
          <div class="customer-summary" aria-label="${escapeHtml(t('Customer count, active count, and unpaid count'))}"><span><strong>${customerSummary.total}</strong><small>${escapeHtml(t('Total'))}</small></span><span><strong>${customerSummary.active}</strong><small>${escapeHtml(t('Active'))}</small></span><span><strong>${customerSummary.unpaid}</strong><small>${escapeHtml(t('Unpaid'))}</small></span></div>
        </div>
        <div class="customer-list-search"><label class="sr-only" for="customer-search">${escapeHtml(t('Search customers by name, phone, or Account number'))}</label><input id="customer-search" type="search" autocomplete="off" value="${escapeHtml(pageState.customerListSearch)}" placeholder="${escapeHtml(t('Search name, phone, or Account #'))}"><p class="muted">${escapeHtml(t('This cloud edition has no username field; use the customer number as Account #. Area choices use the saved service address.'))}</p></div>
        <div class="customer-list-filters" role="group" aria-label="${escapeHtml(t('Filter customers by payment status or area'))}">
          <button class="customer-filter-pill ${pageState.customerListStatus === 'all' ? 'is-active' : ''}" type="button" data-billing-filter="all" aria-pressed="${pageState.customerListStatus === 'all'}">${escapeHtml(t('All'))}</button>
          <button class="customer-filter-pill ${pageState.customerListStatus === 'paid' ? 'is-active' : ''}" type="button" data-billing-filter="paid" aria-pressed="${pageState.customerListStatus === 'paid'}">${escapeHtml(t('Paid'))}</button>
          <button class="customer-filter-pill ${pageState.customerListStatus === 'unpaid' ? 'is-active' : ''}" type="button" data-billing-filter="unpaid" aria-pressed="${pageState.customerListStatus === 'unpaid'}">${escapeHtml(t('Unpaid'))}</button>
          <button class="customer-filter-pill ${pageState.customerListArea ? 'is-active' : ''}" type="button" data-action="toggle-area-filter" aria-expanded="${pageState.customerAreaOpen}" aria-pressed="${Boolean(pageState.customerListArea)}">${escapeHtml(t('Area'))}</button>
          <label class="sr-only" for="customer-area-filter">${escapeHtml(t('Filter by saved service address'))}</label><select id="customer-area-filter" aria-label="${escapeHtml(t('Filter by saved service address'))}" ${pageState.customerAreaOpen ? '' : 'hidden'}><option value="" disabled ${pageState.customerListArea ? '' : 'selected'}>${escapeHtml(t('Choose an area / address'))}</option>${customerAreaOptions}</select>
        </div>
        <p id="customer-list-count" class="customer-list-count" role="status" aria-live="polite">${formatUiMessage('Showing {shown} of {total} customers.', currentLanguage, { shown: filteredCustomerRows.length, total: customerSummary.total })}</p>
        <div id="customer-card-grid" class="customer-card-grid">${customerSummary.total ? renderCustomerCards(filteredCustomerRows, formatMoney, t) : `<p class="customer-list-empty" role="status">${escapeHtml(t('No customer records yet.'))}</p>`}</div>
        <dialog id="customer-profile-dialog" class="edit-dialog customer-profile-dialog" aria-labelledby="customer-profile-title"><div id="customer-profile-content"></div></dialog>
      </section>
      <button class="customer-fab" type="button" data-action="open-add-customer" aria-label="${escapeHtml(t('Add customer'))}" title="${escapeHtml(t('Add customer'))}"><span aria-hidden="true">+</span></button>
      <section id="admin-bills" class="panel data-panel admin-bills-panel" aria-labelledby="admin-bills-title"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Monthly snapshots'))}</p><h2 id="admin-bills-title">${escapeHtml(t('Bills'))}</h2></div><span class="muted">${bills.length} ${escapeHtml(t('records'))}</span></div>
        <div class="bill-list-search"><label for="admin-bill-search">${escapeHtml(t('Search bills by customer name or Admin phone'))}</label><input id="admin-bill-search" type="search" autocomplete="off" value="${escapeHtml(pageState.billSearch)}" placeholder="${escapeHtml(t('Search customer name or phone'))}"><p class="muted">${escapeHtml(t('Phone lookup uses only the Admin-authorized private phone record.'))}</p></div>
        <div class="bill-list-filters" role="group" aria-label="${escapeHtml(t('Filter bills by payment status'))}">
          <button class="bill-filter-pill ${pageState.billStatus === 'all' ? 'is-active' : ''}" type="button" data-bill-status="all" aria-pressed="${pageState.billStatus === 'all'}">${escapeHtml(t('All'))} (${billCounts.all})</button>
          <button class="bill-filter-pill ${pageState.billStatus === 'unpaid' ? 'is-active' : ''}" type="button" data-bill-status="unpaid" aria-pressed="${pageState.billStatus === 'unpaid'}">${escapeHtml(t('Unpaid'))} (${billCounts.unpaid})</button>
          <button class="bill-filter-pill ${pageState.billStatus === 'paid' ? 'is-active' : ''}" type="button" data-bill-status="paid" aria-pressed="${pageState.billStatus === 'paid'}">${escapeHtml(t('Paid'))} (${billCounts.paid})</button>
        </div>
        <p id="admin-bill-count" class="bill-list-count" role="status" aria-live="polite">${formatUiMessage('Showing {shown} of {matching} matching bills; {total} total records.', currentLanguage, { shown: Math.min(filteredAdminBillRows.length, 100), matching: filteredAdminBillRows.length, total: adminBillRows.length })}</p>
        <div id="admin-bill-card-grid" class="bill-card-grid">${renderAdminBillCards(filteredAdminBillRows, formatMoney, t)}</div>
        <p class="muted">${escapeHtml(t('Summary cards above use the selected dashboard month: billed and pending follow bill periods, while collected follows actual receipt dates. Carry-forward credit reduces pending balances but is never counted as cash. WhatsApp opens a draft only; receipts can be printed only from existing receipt records.'))}</p>
      </section>
      <section id="admin-receipts" class="panel data-panel"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Dated cash entries'))}</p><h2>${escapeHtml(t('Receipts'))}</h2></div><span class="muted">${receipts.length} ${escapeHtml(t('actual receipts'))}</span></div>
        <div class="table-wrap" role="region" tabindex="0" aria-label="${escapeHtml(t('Receipts table; scroll horizontally to view all columns'))}"><table><caption class="sr-only">${escapeHtml(t('Actual cash receipts with date, customer, method, amount, and available actions.'))}</caption><thead><tr><th scope="col">${escapeHtml(t('Date'))}</th><th scope="col">${escapeHtml(t('Customer'))}</th><th scope="col">${escapeHtml(t('Method'))}</th><th scope="col">${escapeHtml(t('Amount'))}</th><th scope="col">${escapeHtml(t('Actions'))}</th></tr></thead><tbody>${receipts.slice(0, 100).map((receipt) => `<tr><td>${escapeHtml(receipt.received_on)}</td><td>${escapeHtml(customerName(receipt.customer_id))}</td><td>${escapeHtml(receipt.method)}</td><td>${formatMoney(receipt.amount_cents)}</td><td><button class="text-button" type="button" data-action="edit-receipt" data-id="${escapeHtml(receipt.id)}" aria-label="${escapeHtml(t('Edit receipt for'))} ${escapeHtml(customerName(receipt.customer_id))}, ${escapeHtml(t('dated'))} ${escapeHtml(receipt.received_on)}">${escapeHtml(t('Edit'))}</button><button class="text-button danger" type="button" data-action="delete-receipt" data-id="${escapeHtml(receipt.id)}" aria-label="${escapeHtml(t('Delete receipt for'))} ${escapeHtml(customerName(receipt.customer_id))}, ${escapeHtml(t('dated'))} ${escapeHtml(receipt.received_on)}">${escapeHtml(t('Delete'))}</button></td></tr>`).join('') || `<tr><td colspan="5" class="empty-cell">${escapeHtml(t('No receipts recorded yet.'))}</td></tr>`}</tbody></table></div>
      </section>
      <section id="admin-incidents" class="panel data-panel incident-management" aria-labelledby="admin-incidents-title">
        <div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Service operations'))}</p><h2 id="admin-incidents-title">${escapeHtml(t('Incident management'))}</h2></div><span class="muted">${rows.incidents.length} ${escapeHtml(t('records'))}</span></div>
        <p class="muted incident-time-help">${escapeHtml(t("Date-times use this device's local time zone. Choose Resolved only when service restoration is confirmed; leave a time blank if it was not recorded."))}</p>
        <form id="incident-create-form" class="incident-create-form">
          <label for="incident-create-customer">${escapeHtml(t('Affected customer (optional)'))}<select id="incident-create-customer" name="customer_id"><option value="">${escapeHtml(t('Organization-wide service incident'))}</option>${incidentCustomerOptions}</select></label>
          <label for="incident-create-summary">${escapeHtml(t('Customer-visible summary'))}<textarea id="incident-create-summary" name="customer_visible_summary" maxlength="1000" rows="3" required></textarea></label>
          <label for="incident-create-status">${escapeHtml(t('Status'))}<select id="incident-create-status" name="status" required><option value="open" selected>${escapeHtml(t('Open'))}</option><option value="resolved">${escapeHtml(t('Resolved'))}</option></select></label>
          <label for="incident-create-offline">${escapeHtml(t('Service offline at (optional)'))}<input id="incident-create-offline" name="offline_at" type="datetime-local" step="1"></label>
          <label for="incident-create-restored">${escapeHtml(t('Service restored at (optional)'))}<input id="incident-create-restored" name="restored_at" type="datetime-local" step="1"></label>
          <label for="incident-create-notes">${escapeHtml(t('Staff-only note (optional)'))}<textarea id="incident-create-notes" name="staff_notes" maxlength="4000" rows="3" aria-describedby="incident-create-notes-help"></textarea></label>
          <p class="incident-private-note-help" id="incident-create-notes-help">${escapeHtml(t('Private to same-organization Admins; stored separately and never copied into the customer-visible summary.'))}</p>
          <div class="incident-create-form__actions"><button class="button primary" type="submit">${escapeHtml(t('Report service incident'))}</button></div>
          <p class="form-message" id="incident-create-message" role="status" aria-live="polite" aria-atomic="true"></p>
        </form>
        <div class="section-heading incident-card-heading"><div><p class="eyebrow">${escapeHtml(t('Recorded incidents'))}</p><h3>${escapeHtml(t('Update status and service times'))}</h3></div></div>
        <div class="incident-card-grid">${incidentCards}</div>
      </section>
      <dialog id="receipt-dialog" class="edit-dialog" aria-labelledby="receipt-edit-title"><form id="receipt-edit-form" method="dialog"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Correction'))}</p><h2 id="receipt-edit-title">${escapeHtml(t('Edit receipt'))}</h2></div><button class="icon-button" type="button" data-action="close-dialog" aria-label="${escapeHtml(t('Close'))}">×</button></div><input type="hidden" name="receipt_id"><label>${escapeHtml(t('Original bill'))}<select name="bill_id" required></select></label><label>${escapeHtml(t('Received on'))}<input name="received_on" type="date" required></label><label>${escapeHtml(t('Actual amount (PKR)'))}<input name="amount" inputmode="decimal" required></label><label>${escapeHtml(t('Method'))}<input name="method" maxlength="40" required></label><div class="form-actions"><button class="button secondary" type="button" data-action="close-dialog">${escapeHtml(t('Cancel'))}</button><button class="button primary" type="submit">${escapeHtml(t('Save correction'))}</button></div></form></dialog>`;

    wirePortalBase();
    portalPanel.insertAdjacentHTML('beforeend', `<dialog id="bill-edit-dialog" class="edit-dialog" aria-labelledby="bill-edit-title"><form id="bill-edit-form" class="stack" method="dialog"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Explicit correction'))}</p><h2 id="bill-edit-title">${escapeHtml(t('Correct bill'))}</h2></div><button class="icon-button" type="button" data-action="close-bill-dialog" aria-label="${escapeHtml(t('Close'))}">×</button></div><input type="hidden" name="bill_id"><label for="bill-edit-amount">${escapeHtml(t('Bill amount (PKR)'))}<input id="bill-edit-amount" name="amount" inputmode="decimal" placeholder="${escapeHtml(t('Leave blank if not priced'))}"></label><label for="bill-edit-issued-on">${escapeHtml(t('Issue Date'))}<input id="bill-edit-issued-on" name="issued_on" type="date"></label><label for="bill-edit-due-date">${escapeHtml(t('Exact Due Date'))}<input id="bill-edit-due-date" name="due_date" type="date"></label><p class="muted">${escapeHtml(t('Dates stay blank when they were not explicitly recorded. Saving updates this bill only.'))}</p><div class="form-actions"><button class="button secondary" type="button" data-action="close-bill-dialog">${escapeHtml(t('Cancel'))}</button><button class="button primary" type="submit">${escapeHtml(t('Save bill correction'))}</button></div></form></dialog>`);
    portalPanel.querySelector('#dashboard-month')?.addEventListener('change', (event) => {
      pageState.selectedMonth = event.target.value || localMonth();
      renderPortal();
    });
    const billForm = portalPanel.querySelector('#bill-form');
    billForm?.elements.period.addEventListener('change', (event) => { pageState.billCycleMonth = event.target.value; });
    billForm?.elements.issued_on.addEventListener('change', (event) => { pageState.billIssueDate = event.target.value; });
    billForm?.elements.due_date.addEventListener('change', (event) => { pageState.billDueDate = event.target.value; });
    billForm?.querySelectorAll('[data-due-date-preset]').forEach((button) => button.addEventListener('click', () => {
      const dueDate = getBillingCycleQuickDate(billForm.elements.period.value, button.dataset.dueDatePreset);
      if (!dueDate) return;
      billForm.elements.due_date.value = dueDate;
      pageState.billDueDate = dueDate;
      setMessage(portalPanel.querySelector('#bill-message'), 'Due date set to {date}.', false, { date: dueDate });
    }));
    portalPanel.querySelector('#receipt-customer')?.addEventListener('change', (event) => populateReceiptBills(event.target.value));
    bindAdminForms(context);
    bindAdminIncidentForms(context);
    bindAdminActions(context);
    bindAdminBillActions(context);
    bindCustomerListActions(context);
    populateReceiptBills(portalPanel.querySelector('#receipt-customer')?.value);
  }

  function populateReceiptBills(customerId) {
    const select = portalPanel.querySelector('#receipt-bill');
    if (!select || !pageState.rows) return;
    const customer = pageState.rows.customers.find((item) => item.id === customerId);
    const bills = pageState.rows.bills.filter((bill) => bill.customer_id === customerId);
    select.innerHTML = bills.map((bill) => `<option value="${escapeHtml(bill.id)}">${escapeHtml(bill.period.slice(0, 7))} · ${formatMoney(bill.amount_due_cents)}</option>`).join('');
    select.disabled = bills.length === 0;
    if (!customer || !bills.length) setMessage(portalPanel.querySelector('#receipt-message'), 'Create a bill snapshot before recording a receipt.', true);
  }

  async function invitationErrorMessage(error) {
    try {
      const context = error?.context;
      if (context && typeof context.clone === 'function') {
        const payload = await context.clone().json();
        if (typeof payload?.error === 'string' && payload.error.length <= 300) return payload.error;
      }
    } catch { /* Use the safe fallback for network and non-JSON errors. */ }
    return 'The invitation result could not be confirmed. Submit the same customer and email again to recover safely; no second invitation will be sent.';
  }

  function bindAdminForms(context) {
    portalPanel.querySelector('#customer-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const message = portalPanel.querySelector('#customer-message');
      const formData = new FormData(form);
      try {
        const amountText = String(formData.get('monthly_fee') ?? '').trim();
        const fee = amountText ? amountToMinorUnits(amountText, { allowZero: true }) : null;
        const phone = validatePakistanPhone(String(formData.get('phone') ?? ''));
        await createCustomer(supabase, {
          organizationId: context.organizationId,
          customerNumber: Number(formData.get('customer_number')),
          name: String(formData.get('name') ?? '').trim(),
          planName: String(formData.get('plan_name') ?? '').trim(),
          monthlyFeeCents: fee,
          serviceAddress: String(formData.get('service_address') ?? '').trim(),
          serviceStatus: String(formData.get('service_status') ?? 'not-set'),
          phone,
        });
        form.reset();
        setMessage(message, 'Customer saved.');
        await refreshCurrentContext('Customer saved.');
      } catch (error) {
        setMessage(message, error.message || 'Customer could not be saved.', true);
      }
    });

    portalPanel.querySelector('#bill-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const message = portalPanel.querySelector('#bill-message');
      try {
        const period = String(formData.get('period') ?? '');
        if (!isValidBillingMonth(period)) throw new Error('Choose a valid billing cycle month.');
        const customerId = String(formData.get('customer_id'));
        const existingBill = pageState.rows.bills.find((bill) =>
          bill.customer_id === customerId && String(bill.period).slice(0, 7) === period);
        await invokeRpc(supabase, 'create_monthly_bill', {
          p_organization_id: context.organizationId,
          p_customer_id: customerId,
          p_period: `${period}-01`,
          p_issued_on: String(formData.get('issued_on') ?? '') || null,
          p_due_date: String(formData.get('due_date') ?? '') || null,
        });
        setMessage(message, existingBill
          ? 'Existing monthly snapshot kept unchanged. Use Correct bill to explicitly change its amount or dates.'
          : 'Bill snapshot created. No due date was assumed.');
        await refreshCurrentContext('Bill snapshot saved.');
      } catch (error) {
        setMessage(message, error.message || 'Bill could not be created.', true);
      }
    });

    portalPanel.querySelector('#invite-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submitButton = form.querySelector('button[type="submit"]');
      const formData = new FormData(form);
      const message = portalPanel.querySelector('#invite-message');
      submitButton.disabled = true;
      setMessage(message, 'Requesting an invitation…');
      try {
        const { data, error } = await supabase.functions.invoke('invite-customer', {
          body: {
            organization_id: context.organizationId,
            customer_id: String(formData.get('customer_id')),
            email: String(formData.get('email') ?? '').trim(),
          },
        });
        if (error) throw error;
        if (data?.linked !== true || data?.email_delivery_confirmed !== false
            || (data?.invited !== true && data?.recovered !== true)) {
          throw new Error('The invitation result could not be confirmed. Submit the same customer and email again to recover safely; no second invitation will be sent.');
        }
        form.reset();
        setMessage(message, data.recovered === true
          ? 'The existing invitation state was recovered and linked. No second invitation was sent; email delivery remains unconfirmed.'
          : 'The invitation request was accepted and the account is linked. Email delivery is not confirmed.');
      } catch (error) {
        setMessage(message, await invitationErrorMessage(error), true);
      } finally {
        submitButton.disabled = false;
      }
    });

    portalPanel.querySelector('#receipt-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const formData = new FormData(form);
      const message = portalPanel.querySelector('#receipt-message');
      try {
        const payload = {
          p_organization_id: context.organizationId,
          p_customer_id: String(formData.get('customer_id')),
          p_bill_id: String(formData.get('bill_id')),
          p_received_on: String(formData.get('received_on')),
          p_amount_cents: amountToMinorUnits(formData.get('amount')),
          p_method: String(formData.get('method') ?? '').trim(),
        };
        // Reuse the same ID after a retry, including after a page reload. If a
        // previous call committed, the RPC returns it idempotently for the same
        // details and rejects changed details instead of double-counting cash.
        let attempt = getReceiptAttempt(context);
        if (!attempt) {
          saveReceiptAttempt(context, crypto.randomUUID());
          attempt = pendingReceiptAttempt;
        }
        await invokeRpc(supabase, 'record_cash_receipt', {
          ...payload,
          p_receipt_id: attempt.id,
        });
        clearReceiptAttempt();
        form.elements.amount.value = '';
        form.elements.method.value = '';
        setMessage(message, 'Receipt recorded. Carry-forward credit is shown separately, not as another payment.');
        await refreshCurrentContext('Receipt recorded. Carry-forward credit remains separate.');
      } catch (error) {
        if (error.message) {
          setMessage(message, '{error} Retry the same receipt with its existing request ID; do not start a second cash entry until the first outcome is clear.', true, { error: error.message });
        } else {
          setMessage(message, 'Receipt could not be recorded. Retry the same receipt with its existing request ID; do not start a second cash entry until the first outcome is clear.', true);
        }
      }
    });
  }

  function bindAdminIncidentForms(context) {
    if (context.kind !== 'admin') return;
    const forms = [
      { form: portalPanel.querySelector('#incident-create-form'), isCreate: true },
      ...[...portalPanel.querySelectorAll('[data-incident-update-form]')].map((form) => ({ form, isCreate: false })),
    ].filter((entry) => entry.form);

    for (const { form, isCreate } of forms) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const submitButton = form.querySelector('button[type="submit"]');
        const message = form.querySelector('[data-incident-message]')
          ?? portalPanel.querySelector('#incident-create-message');
        const data = new FormData(form);
        const status = String(data.get('status') ?? '');
        const staffNotes = String(data.get('staff_notes') ?? '');
        if (submitButton) submitButton.disabled = true;
        setMessage(message, 'Saving incident…');
        try {
          await manageServiceIncident(supabase, {
            organizationId: context.organizationId,
            incidentId: isCreate ? null : form.dataset.incidentId,
            customerId: isCreate ? (String(data.get('customer_id') ?? '') || null) : null,
            customerVisibleSummary: String(data.get('customer_visible_summary') ?? '').trim(),
            status,
            offlineAt: incidentTimestamp(data.get('offline_at'), t('Service offline time')),
            restoredAt: incidentTimestamp(data.get('restored_at'), t('Service restored time')),
            staffNotes: isCreate && !staffNotes ? null : staffNotes,
          });
          if (isCreate) form.reset();
          await refreshCurrentContext(isCreate
            ? 'Service incident reported.'
            : status === 'resolved' ? 'Service incident marked resolved.' : 'Service incident updated.');
        } catch (error) {
          setMessage(message, error.message || 'Service incident could not be saved.', true);
        } finally {
          if (submitButton) submitButton.disabled = false;
        }
      });
    }
  }

  function bindAdminActions(context) {
    const billEditDialog = portalPanel.querySelector('#bill-edit-dialog');
    const billEditForm = portalPanel.querySelector('#bill-edit-form');
    portalPanel.querySelectorAll('[data-action="close-bill-dialog"]').forEach((button) => button.addEventListener('click', () => billEditDialog?.close()));
    billEditForm?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      try {
        const amountText = String(formData.get('amount') ?? '').trim();
        await invokeRpc(supabase, 'correct_monthly_bill', {
          p_organization_id: context.organizationId,
          p_bill_id: String(formData.get('bill_id')),
          p_amount_due_cents: amountText ? amountToMinorUnits(amountText, { allowZero: true }) : null,
          p_issued_on: String(formData.get('issued_on') ?? '') || null,
          p_due_date: String(formData.get('due_date') ?? '') || null,
        });
        billEditDialog?.close();
        await refreshCurrentContext('Bill correction saved.');
      } catch (error) {
        window.alert(error.message || t('Bill could not be corrected.'));
      }
    });

    portalPanel.querySelectorAll('[data-action="edit-bill"]').forEach((button) => button.addEventListener('click', () => {
      const bill = pageState.rows.bills.find((row) => row.id === button.dataset.id);
      if (!bill || !billEditForm || !billEditDialog) return;
      billEditForm.elements.bill_id.value = bill.id;
      billEditForm.elements.amount.value = bill.amount_due_cents == null ? '' : (Number(bill.amount_due_cents) / 100).toFixed(2);
      billEditForm.elements.issued_on.value = bill.issued_on ?? '';
      billEditForm.elements.due_date.value = bill.due_date ?? '';
      billEditDialog.showModal();
      billEditForm.elements.issued_on.focus();
    }));

    portalPanel.querySelectorAll('[data-action="edit-receipt"]').forEach((button) => button.addEventListener('click', () => {
      const receipt = pageState.rows.receipts.find((row) => row.id === button.dataset.id);
      if (!receipt) return;
      const dialog = portalPanel.querySelector('#receipt-dialog');
      const form = portalPanel.querySelector('#receipt-edit-form');
      const availableBills = pageState.rows.bills.filter((bill) => bill.customer_id === receipt.customer_id);
      form.elements.receipt_id.value = receipt.id;
      form.elements.bill_id.innerHTML = availableBills.map((bill) => `<option value="${escapeHtml(bill.id)}" ${bill.id === receipt.origin_bill_id ? 'selected' : ''}>${escapeHtml(bill.period.slice(0, 7))}</option>`).join('');
      form.elements.received_on.value = receipt.received_on;
      form.elements.amount.value = (Number(receipt.amount_cents) / 100).toFixed(2);
      form.elements.method.value = receipt.method;
      dialog.showModal();
    }));

    portalPanel.querySelectorAll('[data-action="delete-receipt"]').forEach((button) => button.addEventListener('click', async () => {
      const receipt = pageState.rows.receipts.find((row) => row.id === button.dataset.id);
      if (!receipt || !window.confirm(t('Delete this cash receipt? Its allocations will be recalculated, and this deletion cannot be undone.'))) return;
      try {
        await invokeRpc(supabase, 'delete_cash_receipt', {
          p_organization_id: context.organizationId,
          p_receipt_id: receipt.id,
        });
        await refreshCurrentContext('Receipt deleted. Any dependent allocations were recalculated.');
      } catch (error) {
        window.alert(error.message || t('Receipt could not be deleted.'));
      }
    }));

    portalPanel.querySelectorAll('[data-action="close-dialog"]').forEach((button) => button.addEventListener('click', () => {
      portalPanel.querySelector('#receipt-dialog')?.close();
    }));
    portalPanel.querySelector('#receipt-edit-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      try {
        await invokeRpc(supabase, 'correct_cash_receipt', {
          p_organization_id: context.organizationId,
          p_receipt_id: String(formData.get('receipt_id')),
          p_bill_id: String(formData.get('bill_id')),
          p_received_on: String(formData.get('received_on')),
          p_amount_cents: amountToMinorUnits(formData.get('amount')),
          p_method: String(formData.get('method') ?? '').trim(),
        });
        portalPanel.querySelector('#receipt-dialog')?.close();
        await refreshCurrentContext('Receipt correction saved.');
      } catch (error) {
        window.alert(error.message || t('Receipt correction could not be saved.'));
      }
    });
  }

  function bindAdminBillActions(context) {
    if (context.kind !== 'admin') return;
    const billRoot = portalPanel.querySelector('#admin-bills');
    billRoot?.addEventListener('input', (event) => {
      if (event.target.id !== 'admin-bill-search') return;
      pageState.billSearch = event.target.value;
      updateAdminBillResults();
    });
    billRoot?.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const filterButton = target.closest('[data-bill-status]');
      if (filterButton) {
        pageState.billStatus = filterButton.dataset.billStatus;
        updateAdminBillResults();
        return;
      }
      const action = target.closest('[data-action]');
      if (!action) return;
      if (action.dataset.action === 'collect-bill') {
        const billRow = currentAdminBillRows().find((row) => row.bill.id === action.dataset.id);
        openReceiptFormForBill(billRow);
      } else if (action.dataset.action === 'print-receipt') {
        printExistingReceipt(action.dataset.id);
      }
    });
  }

  function bindCustomerListActions(context) {
    if (context.kind !== 'admin') return;
    const listRoot = portalPanel.querySelector('#customer-list');
    listRoot?.addEventListener('input', (event) => {
      if (event.target.id !== 'customer-search') return;
      pageState.customerListSearch = event.target.value;
      updateCustomerListResults();
    });
    listRoot?.addEventListener('change', (event) => {
      if (event.target.id !== 'customer-area-filter') return;
      pageState.customerListArea = event.target.value;
      pageState.customerListStatus = 'all';
      updateCustomerListResults();
    });
    listRoot?.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const filterButton = target.closest('[data-billing-filter]');
      if (filterButton) {
        pageState.customerListStatus = filterButton.dataset.billingFilter;
        pageState.customerListArea = '';
        pageState.customerAreaOpen = false;
        updateCustomerListResults();
        return;
      }
      const action = target.closest('[data-action]');
      if (!action) return;
      if (action.dataset.action === 'toggle-area-filter') {
        pageState.customerListStatus = 'all';
        pageState.customerAreaOpen = !pageState.customerAreaOpen;
        updateCustomerListResults();
        if (pageState.customerAreaOpen) portalPanel.querySelector('#customer-area-filter')?.focus();
      } else if (action.dataset.action === 'open-customer-profile') {
        openCustomerProfile(action.dataset.customerId);
      } else if (action.dataset.action === 'close-customer-profile') {
        portalPanel.querySelector('#customer-profile-dialog')?.close();
      } else if (action.dataset.action === 'mark-as-paid') {
        const row = currentCustomerListRows().find((entry) => entry.customer.id === action.dataset.customerId);
        openReceiptFormForCustomer(row);
      }
    });
    portalPanel.querySelector('[data-action="open-add-customer"]')?.addEventListener('click', () => {
      const form = portalPanel.querySelector('#customer-form');
      if (!form) return;
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      form.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
      form.elements.customer_number?.focus({ preventScroll: true });
    });
  }

  function renderCustomerBillingResults() {
    const results = portalPanel.querySelector('#customer-billing-results');
    if (!results || !pageState.context || !pageState.rows) return;
    const rows = pageState.rows;
    const customerId = pageState.context.customerId;
    const view = filterCustomerBillingData({
      customerId,
      bills: rows.bills,
      receipts: rows.receipts,
      allocations: rows.allocations,
      month: pageState.customerBillingMonth,
      fromDate: pageState.customerReceiptFrom,
      throughDate: pageState.customerReceiptThrough,
    });
    const periodByBillId = new Map(rows.bills
      .filter((bill) => bill.customer_id === customerId)
      .map((bill) => [bill.id, bill.period]));
    const billRows = view.bills.map((bill) => {
      const summary = summarizeCustomerBill(bill, rows.receipts, view.allocations);
      const statusLabel = {
        'not-priced': t('Not priced'),
        paid: t('Paid'),
        partial: t('Partially paid'),
        unpaid: t('Unpaid'),
      }[summary.status];
      const planLabel = String(bill.plan_snapshot ?? '').trim()
        ? `${escapeHtml(t('Plan snapshot'))}: ${escapeHtml(bill.plan_snapshot)}`
        : t('Plan snapshot not recorded');
      const priceNote = summary.status === 'not-priced'
        ? `<small class="customer-history-note">${escapeHtml(t('Price not recorded; no balance is calculated.'))}</small>`
        : '';
      return `<tr><th scope="row"><strong>${escapeHtml(formatBillingMonth(String(bill.period ?? '').slice(0, 7), 'en-PK', t))}</strong><small>${planLabel}</small></th><td>${formatMoney(bill.amount_due_cents)}${priceNote}</td><td>${formatMoney(summary.receiptCashCents)}</td><td>${formatMoney(summary.creditAppliedCents)}</td><td>${formatMoney(summary.balanceCents)}</td><td><span class="status-pill status-pill--${summary.status}">${statusLabel}</span></td></tr>`;
    }).join('');
    const receiptRows = view.receipts.map((receipt) => {
      const originPeriod = periodByBillId.get(receipt.origin_bill_id);
      const originMonth = originPeriod
        ? formatBillingMonth(String(originPeriod).slice(0, 7), 'en-PK', t)
        : t('Bill month not available');
      return `<tr><td><time datetime="${escapeHtml(receipt.received_on)}">${escapeHtml(receipt.received_on)}</time></td><td>${escapeHtml(receipt.method || t('Method not recorded'))}</td><td>${escapeHtml(originMonth)}</td><td>${formatMoney(receipt.amount_cents)}</td></tr>`;
    }).join('');
    const countMessage = view.invalidDateRange
      ? t('Choose a receipt start date on or before the end date. Receipt entries are hidden until the range is corrected.')
      : formatUiMessage('Showing {billShown} of {billTotal} bills and {receiptShown} of {receiptTotal} actual receipts.', currentLanguage, { billShown: view.bills.length, billTotal: view.totalBills, receiptShown: view.receipts.length, receiptTotal: view.totalReceipts });
    const billEmpty = view.totalBills === 0
      ? t('No bill snapshots have been recorded for this account.')
      : t('No bills match the selected month.');
    const receiptEmpty = view.totalReceipts === 0
      ? t('No cash receipts are recorded for this account.')
      : view.invalidDateRange
        ? t('Receipt entries are hidden until the date range is corrected.')
        : t('No cash receipts match the selected month and receipt dates.');

    results.innerHTML = `<p class="customer-history-count" role="${view.invalidDateRange ? 'alert' : 'status'}" aria-live="${view.invalidDateRange ? 'assertive' : 'polite'}" aria-atomic="true">${escapeHtml(countMessage)}</p>
      <section class="customer-history-block" aria-labelledby="customer-bills-title"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Monthly snapshots'))}</p><h3 id="customer-bills-title">${escapeHtml(t('Bills'))}</h3></div></div>
        <div class="table-wrap" role="region" tabindex="0" aria-label="${escapeHtml(t('Bills table; scroll horizontally to view all columns'))}"><table><caption class="sr-only">${escapeHtml(t('Monthly bill amounts, cash receipts, credit, balance, and status.'))}</caption><thead><tr><th scope="col">${escapeHtml(t('Bill month / plan'))}</th><th scope="col">${escapeHtml(t('Bill amount'))}</th><th scope="col">${escapeHtml(t('Cash receipts linked to bill'))}</th><th scope="col">${escapeHtml(t('Credit applied'))}</th><th scope="col">${escapeHtml(t('Balance'))}</th><th scope="col">${escapeHtml(t('Status'))}</th></tr></thead><tbody>${billRows || `<tr><td colspan="6" class="empty-cell">${escapeHtml(billEmpty)}</td></tr>`}</tbody></table></div>
        <p class="muted">${escapeHtml(t('Bill balances use the complete allocation history. Actual receipts are counted once; carry-forward credit is separate. A bill without a recorded price has no calculated balance.'))}</p>
      </section>
      <section class="customer-history-block" aria-labelledby="customer-receipts-title"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Actual cash entries'))}</p><h3 id="customer-receipts-title">${escapeHtml(t('Receipts'))}</h3></div><span class="muted">${view.receipts.length} ${escapeHtml(t('shown'))}</span></div>
        <div class="table-wrap" role="region" tabindex="0" aria-label="${escapeHtml(t('Receipts table; scroll horizontally to view all columns'))}"><table><caption class="sr-only">${escapeHtml(t('Actual cash receipts with received date, method, origin bill month, and amount.'))}</caption><thead><tr><th scope="col">${escapeHtml(t('Received on'))}</th><th scope="col">${escapeHtml(t('Method'))}</th><th scope="col">${escapeHtml(t('Origin bill month'))}</th><th scope="col">${escapeHtml(t('Amount received'))}</th></tr></thead><tbody>${receiptRows || `<tr><td colspan="4" class="empty-cell">${escapeHtml(receiptEmpty)}</td></tr>`}</tbody></table></div>
        <p class="muted">${escapeHtml(t('Receipt date filters apply only to this actual-cash list; they do not change bill balances or credit totals.'))}</p>
      </section>`;
  }

  function renderCustomer() {
    const rows = pageState.rows;
    const customer = rows.customers[0];
    if (!customer) {
      portalPanel.innerHTML = `${shellHeader(t('Customer portal'))}${renderPortalNavigation('customer')}<section class="panel" role="alert"><h2>${escapeHtml(t('Profile not found'))}</h2><p>${escapeHtml(t('Ask the ISP administrator to review the account link.'))}</p><button class="button secondary" data-action="sign-out">${escapeHtml(t('Sign out'))}</button></section>`;
      wirePortalBase();
      return;
    }
    const customerBills = rows.bills.filter((bill) => bill.customer_id === customer.id)
      .sort((a, b) => String(b.period).localeCompare(String(a.period)));
    const customerReceipts = rows.receipts.filter((receipt) => receipt.customer_id === customer.id)
      .sort((a, b) => String(b.received_on).localeCompare(String(a.received_on)));
    const totalCash = customerReceipts.reduce((sum, receipt) => sum + Number(receipt.amount_cents || 0), 0);
    const billingMonths = getCustomerBillingMonths({ customerId: customer.id, bills: customerBills, receipts: customerReceipts });
    if (!billingMonths.includes(pageState.customerBillingMonth)) pageState.customerBillingMonth = '';
    const monthOptions = billingMonths.map((month) => `<option value="${escapeHtml(month)}" ${month === pageState.customerBillingMonth ? 'selected' : ''}>${escapeHtml(formatBillingMonth(month, 'en-PK', t))}</option>`).join('');
    const incidents = rows.incidents.filter((incident) => incident.customer_id === customer.id)
      .sort((a, b) => String(b.reported_at).localeCompare(String(a.reported_at)));
    portalPanel.innerHTML = `${shellHeader(t('Customer portal'))}
      ${renderPortalNavigation('customer')}
      <section id="customer-account" class="profile-card panel" aria-label="${escapeHtml(t('Customer profile'))}">
        <div class="profile-card__identity"><p class="eyebrow">${escapeHtml(t('Your account'))}</p><h2>${escapeHtml(customer.name)}</h2><p class="profile-card__number">${escapeHtml(t('Customer'))} #${escapeHtml(customer.customer_number)}</p></div>
        <div class="profile-card__details"><div class="profile-field"><span>${escapeHtml(t('Plan'))}</span><strong>${escapeHtml(customer.plan_name || t('Plan not set'))}</strong></div><div class="profile-field"><span>${escapeHtml(t('Monthly fee'))}</span><strong>${formatMoney(customer.monthly_fee_cents)}</strong></div><div class="profile-field profile-field--wide"><span>${escapeHtml(t('Service address'))}</span><strong>${escapeHtml(customer.service_address || t('Service address not recorded'))}</strong></div></div>
        <div class="profile-card__status"><span class="status-pill">${escapeHtml(customer.archived ? t('Archived') : ({ active: t('Active'), offline: t('Offline'), 'not-set': t('Not set') }[customer.service_status] ?? customer.service_status ?? t('Not set')))}</span><p>${escapeHtml(t('Service status'))}</p></div>
      </section>
      <section class="metric-grid customer-metrics"><article class="metric"><span>${escapeHtml(t('Total receipts'))}</span><strong>${formatMoney(totalCash)}</strong><small>${customerReceipts.length} ${escapeHtml(t('actual payments'))}</small></article><article class="metric"><span>${escapeHtml(t('Billing history'))}</span><strong>${customerBills.length}</strong><small>${escapeHtml(t('Monthly snapshots'))}</small></article></section>
      <section id="customer-billing" class="panel data-panel customer-billing-panel" aria-labelledby="customer-billing-title"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Your billing history'))}</p><h2 id="customer-billing-title">${escapeHtml(t('Bills and receipts'))}</h2></div></div>
        <div id="customer-billing-filters" class="customer-billing-filters" aria-describedby="customer-billing-filter-help">
          <label for="customer-billing-month">${escapeHtml(t('Billing / receipt month'))}<select id="customer-billing-month"><option value="">${escapeHtml(t('All months'))}</option>${monthOptions}</select></label>
          <label for="customer-receipt-from">${escapeHtml(t('Receipt dates from'))}<input id="customer-receipt-from" type="date" value="${escapeHtml(pageState.customerReceiptFrom)}"></label>
          <label for="customer-receipt-through">${escapeHtml(t('Receipt dates through'))}<input id="customer-receipt-through" type="date" value="${escapeHtml(pageState.customerReceiptThrough)}"></label>
          <button id="clear-customer-billing-filters" class="button secondary small" type="button">${escapeHtml(t('Clear filters'))}</button>
        </div>
        <p id="customer-billing-filter-help" class="muted">${escapeHtml(t('Month filters both bill period and receipt date. Start/end dates narrow only the actual receipt list.'))}</p>
        <div id="customer-billing-results"></div>
      </section>
      <section id="customer-incidents" class="panel data-panel customer-incidents-panel" aria-labelledby="customer-incidents-title"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Service updates'))}</p><h2 id="customer-incidents-title">${escapeHtml(t('Incident timeline'))}</h2></div><span class="muted">${incidents.length} ${escapeHtml(t('updates'))}</span></div>
        <div class="incident-list">${incidents.map((incident) => {
          const timeline = buildIncidentTimeline(incident, t);
          const statusClass = timeline.status === 'unknown' ? 'unknown' : timeline.status;
          const eventRows = timeline.events.map((item) => `<li class="incident-timeline__event"><span class="incident-timeline__dot" aria-hidden="true"></span><span class="incident-timeline__label">${escapeHtml(item.label)}</span><time datetime="${escapeHtml(item.datetime)}">${escapeHtml(item.displayTime)}</time></li>`).join('');
          return `<article class="incident-item incident-item--${statusClass}"><header class="incident-item__header"><div><p class="eyebrow">${escapeHtml(t('Service update'))}</p><h3>${escapeHtml(t('Incident timeline'))}</h3></div><span class="status-pill incident-status--${statusClass}">${escapeHtml(timeline.statusLabel)}</span></header><p class="incident-item__summary">${escapeHtml(incident.customer_visible_summary)}</p><ol class="incident-timeline" aria-label="${escapeHtml(t('Recorded service milestones'))}">${eventRows || `<li class="incident-timeline__empty">${escapeHtml(t('No milestone times are available.'))}</li>`}</ol><p class="incident-recovery">${escapeHtml(timeline.restorationMessage)}</p></article>`;
        }).join('') || `<p class="incident-empty" role="status">${escapeHtml(t('No customer-visible service updates are recorded for this account.'))}</p>`}</div>
      </section>`;
    wirePortalBase();
    renderCustomerBillingResults();
    portalPanel.querySelector('#customer-billing-filters')?.addEventListener('change', (event) => {
      if (event.target.id === 'customer-billing-month') pageState.customerBillingMonth = event.target.value;
      if (event.target.id === 'customer-receipt-from') pageState.customerReceiptFrom = event.target.value;
      if (event.target.id === 'customer-receipt-through') pageState.customerReceiptThrough = event.target.value;
      renderCustomerBillingResults();
    });
    portalPanel.querySelector('#clear-customer-billing-filters')?.addEventListener('click', () => {
      pageState.customerBillingMonth = '';
      pageState.customerReceiptFrom = '';
      pageState.customerReceiptThrough = '';
      portalPanel.querySelector('#customer-billing-month').value = '';
      portalPanel.querySelector('#customer-receipt-from').value = '';
      portalPanel.querySelector('#customer-receipt-through').value = '';
      renderCustomerBillingResults();
    });
  }

  async function refreshCurrentContext(announcement = 'Portal data updated.') {
    if (!pageState.context) return;
    showPortalLoading();
    try {
      pageState.rows = await loadPortalRows(supabase, pageState.context);
      renderPortal();
      portalPanel.querySelector('h1')?.focus();
      announceApp(announcement);
    } catch (error) {
      portalPanel.innerHTML = `<div class="panel" role="alert"><h2>Refresh failed</h2><p class="error-text">${escapeHtml(error.message || 'The request failed.')}</p><button class="button secondary" data-action="sign-out">Sign out</button></div>`;
      bindSharedActions();
    }
  }

  loginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = loginForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    setMessage(loginMessage, 'Sending a secure sign-in link…');
    try {
      const email = String(new FormData(loginForm).get('email') ?? '').trim();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: window.location.origin + window.location.pathname,
          shouldCreateUser: false,
        },
      });
      if (error) throw error;
      setMessage(loginMessage, 'If this address has an invited account, a sign-in link has been requested. Email delivery is not confirmed by this page.');
    } catch (error) {
      setMessage(loginMessage, error.message || 'Sign-in link could not be sent.', true);
    } finally {
      submitButton.disabled = false;
    }
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    queueMicrotask(() => { void handleSession(session); });
  });
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session) await handleSession(sessionData.session);
  else showLogin();
}
