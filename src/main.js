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
import './styles.css';

const app = document.querySelector('#app');
const configMessage = document.querySelector('#configuration-message');
const authPanel = document.querySelector('#auth-panel');
const portalPanel = document.querySelector('#portal-panel');
const loginForm = document.querySelector('#login-form');
const loginMessage = document.querySelector('#login-message');

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
    if (Number.isNaN(parsed.getTime())) throw new Error(`${label} must be a valid local date and time.`);
    return parsed.toISOString();
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function setMessage(node, message = '', isError = false) {
    if (!node) return;
    node.textContent = message;
    node.setAttribute('role', isError ? 'alert' : 'status');
    node.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    node.setAttribute('aria-atomic', 'true');
    node.classList.toggle('error-text', isError);
    node.classList.toggle('success-text', Boolean(message) && !isError);
  }

  function announceApp(message) {
    const announcement = document.querySelector('#app-announcement');
    if (announcement) announcement.textContent = message;
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
    portalPanel.innerHTML = '<div class="panel loading-panel" role="status" aria-live="polite" aria-busy="true"><span class="spinner" aria-hidden="true"></span><p>Loading records allowed for this account…</p></div>';
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
      announceApp(context.kind === 'admin' ? 'Administrator portal loaded.' : `Customer portal loaded for ${context.customerName}.`);
    } catch (error) {
      portalPanel.innerHTML = `<div class="panel" role="alert"><p class="eyebrow">Could not load records</p><h2>Access was not granted</h2><p class="error-text">${escapeHtml(error.message || 'The request failed.')}</p><p>Database row-level policies remain authoritative; contact the ISP administrator if this account should have portal access.</p><button class="button secondary" data-action="sign-out">Sign out</button></div>`;
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
        portalPanel.innerHTML = '<div class="panel" role="status"><p class="eyebrow">No portal access</p><h2>This email is not linked to an ISP account</h2><p>Ask the ISP administrator to assign an Admin role or send a customer invitation.</p><button class="button secondary" data-action="sign-out">Sign out</button></div>';
        announceApp('No portal access is linked to this account.');
        bindSharedActions();
        return;
      }
      await selectContext(pageState.contexts[0]);
    } catch (error) {
      portalPanel.innerHTML = `<div class="panel" role="alert"><p class="eyebrow">Sign-in could not be completed</p><h2>Account access needs review</h2><p class="error-text">${escapeHtml(error.message || 'The request failed.')}</p><button class="button secondary" data-action="sign-out">Sign out</button></div>`;
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

  function contextSelectHtml() {
    if (pageState.contexts.length < 2) return '';
    return `<label class="context-picker">Organization/account<select id="context-picker">${pageState.contexts.map((context, index) => {
      const label = context.kind === 'admin'
        ? `${context.organizationName} · ${context.role}`
        : `${context.customerName} · Customer`;
      return `<option value="${index}" ${context === pageState.context ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('')}</select></label>`;
  }

  function shellHeader(label) {
    const accountLabel = pageState.context?.kind === 'admin'
      ? `Signed in as ${pageState.user?.email ?? ''}`
      : 'Linked customer account';
    return `<div class="portal-heading"><div><p class="eyebrow">${escapeHtml(label)}</p><h1 tabindex="-1">${escapeHtml(pageState.context.organizationName ?? 'Shahdara Fiber Net')}</h1><p class="muted">${escapeHtml(accountLabel)}</p></div><div class="header-actions">${contextSelectHtml()}<button class="button secondary small" data-action="sign-out">Sign out</button></div></div>`;
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
        ? renderCustomerCards(filteredRows, formatMoney)
        : '<p class="customer-list-empty" role="status">No customer records yet.</p>';
    }
    if (count) count.textContent = `Showing ${filteredRows.length} of ${listRows.length} customers.`;
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
    });
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
    });
  }

  function updateAdminBillResults() {
    const billRows = currentAdminBillRows();
    const filteredRows = filterAdminBillRows(billRows, { search: pageState.billSearch, status: pageState.billStatus });
    const counts = countAdminBillFilters(billRows, { search: pageState.billSearch });
    const grid = portalPanel.querySelector('#admin-bill-card-grid');
    const count = portalPanel.querySelector('#admin-bill-count');
    if (grid) grid.innerHTML = renderAdminBillCards(filteredRows, formatMoney);
    if (count) count.textContent = `Showing ${Math.min(filteredRows.length, 100)} of ${filteredRows.length} matching bills; ${billRows.length} total records.`;
    for (const button of portalPanel.querySelectorAll('[data-bill-status]')) {
      const status = button.dataset.billStatus;
      const selected = status === pageState.billStatus;
      const label = status === 'unpaid' ? 'Unpaid' : status === 'paid' ? 'Paid' : 'All';
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
      window.alert('Allow the print window to open, then choose Print or Save as PDF.');
      return;
    }
    printWindow.document.open();
    printWindow.document.write(renderPrintableReceiptHtml({
      receipt,
      customer,
      bill,
      organizationName: pageState.context.organizationName,
      formatMoney,
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
    const customerName = (id) => rows.customers.find((customer) => customer.id === id)?.name ?? 'Customer';
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
    });

    portalPanel.innerHTML = `${shellHeader('Administrator portal')}
      ${renderDashboardMetrics({ month: pageState.selectedMonth, totals })}
      <section class="panel month-panel"><label for="dashboard-month">Dashboard month</label><input type="month" id="dashboard-month" value="${escapeHtml(pageState.selectedMonth)}"><p class="muted">Cash totals follow receipt dates. Credit allocation is shown separately and is never counted as another payment.</p></section>
      <div class="admin-grid">
        <section class="panel"><p class="eyebrow">Customer records</p><h2>Add customer</h2>
          <form id="customer-form" class="form-grid">
            <label>Customer number<input name="customer_number" type="number" min="1" step="1" required></label>
            <label>Customer name<input name="name" maxlength="100" required></label>
            <label>Plan / speed<input name="plan_name" maxlength="100"></label>
            <label>Monthly fee (PKR)<input name="monthly_fee" inputmode="decimal" placeholder="Leave blank if not set"></label>
            <label>Service address<input name="service_address" maxlength="300"></label>
            <label>Phone (private)<input name="phone" type="text" inputmode="tel" autocomplete="tel" maxlength="40" placeholder="03XXXXXXXXX or +923XXXXXXXXX"></label>
            <label>Service status<select name="service_status"><option value="not-set">Not set</option><option value="active">Active</option><option value="offline">Offline</option></select></label>
            <button class="button primary" type="submit">Save customer</button>
          </form><p class="form-message" id="customer-message" role="status"></p>
        </section>
        <section class="panel"><p class="eyebrow">Monthly billing</p><h2>Create bill snapshot</h2>
          <form id="bill-form" class="stack">
            <label for="bill-customer">Customer</label><select id="bill-customer" name="customer_id" required>${monthOptions}</select>
            <label for="bill-month">Billing Cycle Month</label><input id="bill-month" name="period" type="month" value="${escapeHtml(pageState.billCycleMonth)}" required>
            <label for="bill-issued-on">Issue Date</label><input id="bill-issued-on" name="issued_on" type="date" value="${escapeHtml(pageState.billIssueDate)}">
            <label for="bill-due-date">Exact Due Date</label><input id="bill-due-date" name="due_date" type="date" value="${escapeHtml(pageState.billDueDate)}">
            <div class="due-date-presets" role="group" aria-label="Choose an exact due date quickly">
              <button class="due-date-preset" type="button" data-due-date-preset="today" aria-controls="bill-due-date">Today</button>
              <button class="due-date-preset" type="button" data-due-date-preset="fifth" aria-controls="bill-due-date">5th of Month</button>
              <button class="due-date-preset" type="button" data-due-date-preset="tenth" aria-controls="bill-due-date">10th of Month</button>
              <button class="due-date-preset" type="button" data-due-date-preset="end" aria-controls="bill-due-date">End of Month</button>
            </div>
            <p class="muted">The issue date starts at today on this device. Due dates are never assumed; month-based choices follow the selected billing cycle.</p>
            <button class="button primary" type="submit">Create monthly bill</button>
          </form><p class="form-message" id="bill-message" role="status"></p>
          <hr><p class="muted">One bill per customer/month. Existing snapshots are returned unchanged. Price corrections are recorded and recalculate derived balances.</p>
        </section>
        <section class="panel"><p class="eyebrow">Customer access</p><h2>Invite a customer</h2>
          <p class="muted">Choose an existing active customer and request a portal invitation. This page cannot confirm email delivery. Repeating the same customer and email safely recovers an earlier request without sending a second invitation.</p>
          <form id="invite-form" class="stack">
            <label for="invite-customer">Existing customer</label><select id="invite-customer" name="customer_id" required ${inviteCustomers.length ? '' : 'disabled'}>${inviteCustomerOptions || '<option value="">No active customers available</option>'}</select>
            <label for="invite-email">Email address</label><input id="invite-email" name="email" type="email" autocomplete="email" maxlength="254" required ${inviteCustomers.length ? '' : 'disabled'}>
            <button class="button primary" type="submit" ${inviteCustomers.length ? '' : 'disabled'}>Request invitation</button>
          </form><p class="form-message" id="invite-message" role="status" aria-live="polite">${inviteCustomers.length ? '' : 'Add an active customer before requesting an invitation.'}</p>
          <p class="muted">Customer-to-account links remain server-managed and cannot be written from the browser. If a result is uncertain, use the same customer and email to recover; unresolved account states stop for administrator review.</p>
        </section>
        <section class="panel"><p class="eyebrow">Cash ledger</p><h2>Record actual receipt</h2>
          <form id="receipt-form" class="form-grid">
            <label>Customer<select name="customer_id" id="receipt-customer" required>${monthOptions}</select></label>
            <label>Bill<select name="bill_id" id="receipt-bill" required>${billOptions}</select></label>
            <label>Received on<input name="received_on" type="date" value="${localDate()}" required></label>
            <label>Amount received (PKR)<input name="amount" inputmode="decimal" required></label>
            <label>Method<select name="method" required><option value="" selected disabled>Select a method</option><option>Cash</option><option>Easypaisa</option><option>JazzCash</option><option>Bank transfer</option><option>Other</option></select></label>
            <button class="button primary" type="submit">Record receipt</button>
          </form><p class="form-message" id="receipt-message" role="status"></p>
        </section>
      </div>
      <section id="customer-list" class="panel data-panel customer-list-panel" aria-labelledby="customer-list-title">
        <div class="customer-list-heading"><div><p class="eyebrow">Customer directory</p><h2 id="customer-list-title">Customers</h2></div>
          <div class="customer-summary" aria-label="Customer count, active count, and unpaid count"><span><strong>${customerSummary.total}</strong><small>Total</small></span><span><strong>${customerSummary.active}</strong><small>Active</small></span><span><strong>${customerSummary.unpaid}</strong><small>Unpaid</small></span></div>
        </div>
        <div class="customer-list-search"><label class="sr-only" for="customer-search">Search customers by name, phone, or Account number</label><input id="customer-search" type="search" autocomplete="off" value="${escapeHtml(pageState.customerListSearch)}" placeholder="Search name, phone, or Account #"><p class="muted">This cloud edition has no username field; use the customer number as Account #. Area choices use the saved service address.</p></div>
        <div class="customer-list-filters" role="group" aria-label="Filter customers by payment status or area">
          <button class="customer-filter-pill ${pageState.customerListStatus === 'all' ? 'is-active' : ''}" type="button" data-billing-filter="all" aria-pressed="${pageState.customerListStatus === 'all'}">All</button>
          <button class="customer-filter-pill ${pageState.customerListStatus === 'paid' ? 'is-active' : ''}" type="button" data-billing-filter="paid" aria-pressed="${pageState.customerListStatus === 'paid'}">Paid</button>
          <button class="customer-filter-pill ${pageState.customerListStatus === 'unpaid' ? 'is-active' : ''}" type="button" data-billing-filter="unpaid" aria-pressed="${pageState.customerListStatus === 'unpaid'}">Unpaid</button>
          <button class="customer-filter-pill ${pageState.customerListArea ? 'is-active' : ''}" type="button" data-action="toggle-area-filter" aria-expanded="${pageState.customerAreaOpen}" aria-pressed="${Boolean(pageState.customerListArea)}">Area</button>
          <label class="sr-only" for="customer-area-filter">Filter by saved service address</label><select id="customer-area-filter" aria-label="Filter by saved service address" ${pageState.customerAreaOpen ? '' : 'hidden'}><option value="" disabled ${pageState.customerListArea ? '' : 'selected'}>Choose an area / address</option>${customerAreaOptions}</select>
        </div>
        <p id="customer-list-count" class="customer-list-count" role="status" aria-live="polite">Showing ${filteredCustomerRows.length} of ${customerSummary.total} customers.</p>
        <div id="customer-card-grid" class="customer-card-grid">${customerSummary.total ? renderCustomerCards(filteredCustomerRows, formatMoney) : '<p class="customer-list-empty" role="status">No customer records yet.</p>'}</div>
        <dialog id="customer-profile-dialog" class="edit-dialog customer-profile-dialog" aria-labelledby="customer-profile-title"><div id="customer-profile-content"></div></dialog>
      </section>
      <button class="customer-fab" type="button" data-action="open-add-customer" aria-label="Add customer" title="Add customer"><span aria-hidden="true">+</span></button>
      <section id="admin-bills" class="panel data-panel admin-bills-panel" aria-labelledby="admin-bills-title"><div class="section-heading"><div><p class="eyebrow">Monthly snapshots</p><h2 id="admin-bills-title">Bills</h2></div><span class="muted">${bills.length} records</span></div>
        <div class="bill-list-search"><label for="admin-bill-search">Search bills by customer name or Admin phone</label><input id="admin-bill-search" type="search" autocomplete="off" value="${escapeHtml(pageState.billSearch)}" placeholder="Search customer name or phone"><p class="muted">Phone lookup uses only the Admin-authorized private phone record.</p></div>
        <div class="bill-list-filters" role="group" aria-label="Filter bills by payment status">
          <button class="bill-filter-pill ${pageState.billStatus === 'all' ? 'is-active' : ''}" type="button" data-bill-status="all" aria-pressed="${pageState.billStatus === 'all'}">All (${billCounts.all})</button>
          <button class="bill-filter-pill ${pageState.billStatus === 'unpaid' ? 'is-active' : ''}" type="button" data-bill-status="unpaid" aria-pressed="${pageState.billStatus === 'unpaid'}">Unpaid (${billCounts.unpaid})</button>
          <button class="bill-filter-pill ${pageState.billStatus === 'paid' ? 'is-active' : ''}" type="button" data-bill-status="paid" aria-pressed="${pageState.billStatus === 'paid'}">Paid (${billCounts.paid})</button>
        </div>
        <p id="admin-bill-count" class="bill-list-count" role="status" aria-live="polite">Showing ${Math.min(filteredAdminBillRows.length, 100)} of ${filteredAdminBillRows.length} matching bills; ${adminBillRows.length} total records.</p>
        <div id="admin-bill-card-grid" class="bill-card-grid">${renderAdminBillCards(filteredAdminBillRows, formatMoney)}</div>
        <p class="muted">Summary cards above use the selected dashboard month: billed and pending follow bill periods, while collected follows actual receipt dates. Carry-forward credit reduces pending balances but is never counted as cash. WhatsApp opens a draft only; receipts can be printed only from existing receipt records.</p>
      </section>
      <section class="panel data-panel"><div class="section-heading"><div><p class="eyebrow">Dated cash entries</p><h2>Receipts</h2></div><span class="muted">${receipts.length} actual receipts</span></div>
        <div class="table-wrap" role="region" tabindex="0" aria-label="Receipts table; scroll horizontally to view all columns"><table><caption class="sr-only">Actual cash receipts with date, customer, method, amount, and available actions.</caption><thead><tr><th scope="col">Date</th><th scope="col">Customer</th><th scope="col">Method</th><th scope="col">Amount</th><th scope="col">Actions</th></tr></thead><tbody>${receipts.slice(0, 100).map((receipt) => `<tr><td>${escapeHtml(receipt.received_on)}</td><td>${escapeHtml(customerName(receipt.customer_id))}</td><td>${escapeHtml(receipt.method)}</td><td>${formatMoney(receipt.amount_cents)}</td><td><button class="text-button" type="button" data-action="edit-receipt" data-id="${escapeHtml(receipt.id)}" aria-label="Edit receipt for ${escapeHtml(customerName(receipt.customer_id))}, dated ${escapeHtml(receipt.received_on)}">Edit</button><button class="text-button danger" type="button" data-action="delete-receipt" data-id="${escapeHtml(receipt.id)}" aria-label="Delete receipt for ${escapeHtml(customerName(receipt.customer_id))}, dated ${escapeHtml(receipt.received_on)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty-cell">No receipts recorded yet.</td></tr>'}</tbody></table></div>
      </section>
      <section id="admin-incidents" class="panel data-panel incident-management" aria-labelledby="admin-incidents-title">
        <div class="section-heading"><div><p class="eyebrow">Service operations</p><h2 id="admin-incidents-title">Incident management</h2></div><span class="muted">${rows.incidents.length} records</span></div>
        <p class="muted incident-time-help">Date-times use this device's local time zone. Choose Resolved only when service restoration is confirmed; leave a time blank if it was not recorded.</p>
        <form id="incident-create-form" class="incident-create-form">
          <label for="incident-create-customer">Affected customer (optional)<select id="incident-create-customer" name="customer_id"><option value="">Organization-wide service incident</option>${incidentCustomerOptions}</select></label>
          <label for="incident-create-summary">Customer-visible summary<textarea id="incident-create-summary" name="customer_visible_summary" maxlength="1000" rows="3" required></textarea></label>
          <label for="incident-create-status">Status<select id="incident-create-status" name="status" required><option value="open" selected>Open</option><option value="resolved">Resolved</option></select></label>
          <label for="incident-create-offline">Service offline at (optional)<input id="incident-create-offline" name="offline_at" type="datetime-local" step="1"></label>
          <label for="incident-create-restored">Service restored at (optional)<input id="incident-create-restored" name="restored_at" type="datetime-local" step="1"></label>
          <label for="incident-create-notes">Staff-only note (optional)<textarea id="incident-create-notes" name="staff_notes" maxlength="4000" rows="3" aria-describedby="incident-create-notes-help"></textarea></label>
          <p class="incident-private-note-help" id="incident-create-notes-help">Private to same-organization Admins; stored separately and never copied into the customer-visible summary.</p>
          <div class="incident-create-form__actions"><button class="button primary" type="submit">Report service incident</button></div>
          <p class="form-message" id="incident-create-message" role="status" aria-live="polite" aria-atomic="true"></p>
        </form>
        <div class="section-heading incident-card-heading"><div><p class="eyebrow">Recorded incidents</p><h3>Update status and service times</h3></div></div>
        <div class="incident-card-grid">${incidentCards}</div>
      </section>
      <dialog id="receipt-dialog" class="edit-dialog"><form id="receipt-edit-form" method="dialog"><div class="section-heading"><div><p class="eyebrow">Correction</p><h2>Edit receipt</h2></div><button class="icon-button" type="button" data-action="close-dialog" aria-label="Close">×</button></div><input type="hidden" name="receipt_id"><label>Original bill<select name="bill_id" required></select></label><label>Received on<input name="received_on" type="date" required></label><label>Actual amount (PKR)<input name="amount" inputmode="decimal" required></label><label>Method<input name="method" maxlength="40" required></label><div class="form-actions"><button class="button secondary" type="button" data-action="close-dialog">Cancel</button><button class="button primary" type="submit">Save correction</button></div></form></dialog>`;

    wirePortalBase();
    portalPanel.insertAdjacentHTML('beforeend', `<dialog id="bill-edit-dialog" class="edit-dialog" aria-labelledby="bill-edit-title"><form id="bill-edit-form" class="stack" method="dialog"><div class="section-heading"><div><p class="eyebrow">Explicit correction</p><h2 id="bill-edit-title">Correct bill</h2></div><button class="icon-button" type="button" data-action="close-bill-dialog" aria-label="Close">×</button></div><input type="hidden" name="bill_id"><label for="bill-edit-amount">Bill amount (PKR)<input id="bill-edit-amount" name="amount" inputmode="decimal" placeholder="Leave blank if not priced"></label><label for="bill-edit-issued-on">Issue Date<input id="bill-edit-issued-on" name="issued_on" type="date"></label><label for="bill-edit-due-date">Exact Due Date<input id="bill-edit-due-date" name="due_date" type="date"></label><p class="muted">Dates stay blank when they were not explicitly recorded. Saving updates this bill only.</p><div class="form-actions"><button class="button secondary" type="button" data-action="close-bill-dialog">Cancel</button><button class="button primary" type="submit">Save bill correction</button></div></form></dialog>`);
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
      setMessage(portalPanel.querySelector('#bill-message'), `Due date set to ${dueDate}.`);
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
        setMessage(message, `${error.message || 'Receipt could not be recorded.'} Retry the same receipt with its existing request ID; do not start a second cash entry until the first outcome is clear.`, true);
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
            offlineAt: incidentTimestamp(data.get('offline_at'), 'Service offline time'),
            restoredAt: incidentTimestamp(data.get('restored_at'), 'Service restored time'),
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
        window.alert(error.message || 'Bill could not be corrected.');
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
      if (!receipt || !window.confirm('Delete this cash receipt? Its allocations will be recalculated, and this deletion cannot be undone.')) return;
      try {
        await invokeRpc(supabase, 'delete_cash_receipt', {
          p_organization_id: context.organizationId,
          p_receipt_id: receipt.id,
        });
        await refreshCurrentContext('Receipt deleted. Any dependent allocations were recalculated.');
      } catch (error) {
        window.alert(error.message || 'Receipt could not be deleted.');
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
        window.alert(error.message || 'Receipt correction could not be saved.');
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
        'not-priced': 'Not priced',
        paid: 'Paid',
        partial: 'Partially paid',
        unpaid: 'Unpaid',
      }[summary.status];
      const planLabel = String(bill.plan_snapshot ?? '').trim()
        ? `Plan snapshot: ${escapeHtml(bill.plan_snapshot)}`
        : 'Plan snapshot not recorded';
      const priceNote = summary.status === 'not-priced'
        ? '<small class="customer-history-note">Price not recorded; no balance is calculated.</small>'
        : '';
      return `<tr><th scope="row"><strong>${escapeHtml(formatBillingMonth(String(bill.period ?? '').slice(0, 7)))}</strong><small>${planLabel}</small></th><td>${formatMoney(bill.amount_due_cents)}${priceNote}</td><td>${formatMoney(summary.receiptCashCents)}</td><td>${formatMoney(summary.creditAppliedCents)}</td><td>${formatMoney(summary.balanceCents)}</td><td><span class="status-pill status-pill--${summary.status}">${statusLabel}</span></td></tr>`;
    }).join('');
    const receiptRows = view.receipts.map((receipt) => {
      const originPeriod = periodByBillId.get(receipt.origin_bill_id);
      const originMonth = originPeriod
        ? formatBillingMonth(String(originPeriod).slice(0, 7))
        : 'Bill month not available';
      return `<tr><td><time datetime="${escapeHtml(receipt.received_on)}">${escapeHtml(receipt.received_on)}</time></td><td>${escapeHtml(receipt.method || 'Method not recorded')}</td><td>${escapeHtml(originMonth)}</td><td>${formatMoney(receipt.amount_cents)}</td></tr>`;
    }).join('');
    const countMessage = view.invalidDateRange
      ? 'Choose a receipt start date on or before the end date. Receipt entries are hidden until the range is corrected.'
      : `Showing ${view.bills.length} of ${view.totalBills} bills and ${view.receipts.length} of ${view.totalReceipts} actual receipts.`;
    const billEmpty = view.totalBills === 0
      ? 'No bill snapshots have been recorded for this account.'
      : 'No bills match the selected month.';
    const receiptEmpty = view.totalReceipts === 0
      ? 'No cash receipts are recorded for this account.'
      : view.invalidDateRange
        ? 'Receipt entries are hidden until the date range is corrected.'
        : 'No cash receipts match the selected month and receipt dates.';

    results.innerHTML = `<p class="customer-history-count" role="${view.invalidDateRange ? 'alert' : 'status'}" aria-live="${view.invalidDateRange ? 'assertive' : 'polite'}" aria-atomic="true">${countMessage}</p>
      <section class="customer-history-block" aria-labelledby="customer-bills-title"><div class="section-heading"><div><p class="eyebrow">Monthly snapshots</p><h3 id="customer-bills-title">Bills</h3></div></div>
        <div class="table-wrap" role="region" tabindex="0" aria-label="Bills table; scroll horizontally to view all columns"><table><caption class="sr-only">Monthly bill amounts, cash receipts, credit, balance, and status.</caption><thead><tr><th scope="col">Bill month / plan</th><th scope="col">Bill amount</th><th scope="col">Cash receipts linked to bill</th><th scope="col">Credit applied</th><th scope="col">Balance</th><th scope="col">Status</th></tr></thead><tbody>${billRows || `<tr><td colspan="6" class="empty-cell">${billEmpty}</td></tr>`}</tbody></table></div>
        <p class="muted">Bill balances use the complete allocation history. Actual receipts are counted once; carry-forward credit is separate. A bill without a recorded price has no calculated balance.</p>
      </section>
      <section class="customer-history-block" aria-labelledby="customer-receipts-title"><div class="section-heading"><div><p class="eyebrow">Actual cash entries</p><h3 id="customer-receipts-title">Receipts</h3></div><span class="muted">${view.receipts.length} shown</span></div>
        <div class="table-wrap" role="region" tabindex="0" aria-label="Receipts table; scroll horizontally to view all columns"><table><caption class="sr-only">Actual cash receipts with received date, method, origin bill month, and amount.</caption><thead><tr><th scope="col">Received on</th><th scope="col">Method</th><th scope="col">Origin bill month</th><th scope="col">Amount received</th></tr></thead><tbody>${receiptRows || `<tr><td colspan="4" class="empty-cell">${receiptEmpty}</td></tr>`}</tbody></table></div>
        <p class="muted">Receipt date filters apply only to this actual-cash list; they do not change bill balances or credit totals.</p>
      </section>`;
  }

  function renderCustomer() {
    const rows = pageState.rows;
    const customer = rows.customers[0];
    if (!customer) {
      portalPanel.innerHTML = `${shellHeader('Customer portal')}<section class="panel" role="alert"><h2>Profile not found</h2><p>Ask the ISP administrator to review the account link.</p><button class="button secondary" data-action="sign-out">Sign out</button></section>`;
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
    const monthOptions = billingMonths.map((month) => `<option value="${escapeHtml(month)}" ${month === pageState.customerBillingMonth ? 'selected' : ''}>${escapeHtml(formatBillingMonth(month))}</option>`).join('');
    const incidents = rows.incidents.filter((incident) => incident.customer_id === customer.id)
      .sort((a, b) => String(b.reported_at).localeCompare(String(a.reported_at)));
    portalPanel.innerHTML = `${shellHeader('Customer portal')}
      <section class="profile-card panel" aria-label="Customer profile">
        <div class="profile-card__identity"><p class="eyebrow">Your account</p><h2>${escapeHtml(customer.name)}</h2><p class="profile-card__number">Customer #${customer.customer_number}</p></div>
        <div class="profile-card__details"><div class="profile-field"><span>Plan</span><strong>${escapeHtml(customer.plan_name || 'Plan not set')}</strong></div><div class="profile-field"><span>Monthly fee</span><strong>${formatMoney(customer.monthly_fee_cents)}</strong></div><div class="profile-field profile-field--wide"><span>Service address</span><strong>${escapeHtml(customer.service_address || 'Service address not recorded')}</strong></div></div>
        <div class="profile-card__status"><span class="status-pill">${escapeHtml(customer.archived ? 'Archived' : customer.service_status)}</span><p>Service status</p></div>
      </section>
      <section class="metric-grid customer-metrics"><article class="metric"><span>Total receipts</span><strong>${formatMoney(totalCash)}</strong><small>${customerReceipts.length} actual payments</small></article><article class="metric"><span>Billing history</span><strong>${customerBills.length}</strong><small>Monthly snapshots</small></article></section>
      <section class="panel data-panel customer-billing-panel" aria-labelledby="customer-billing-title"><div class="section-heading"><div><p class="eyebrow">Your billing history</p><h2 id="customer-billing-title">Bills and receipts</h2></div></div>
        <div id="customer-billing-filters" class="customer-billing-filters" aria-describedby="customer-billing-filter-help">
          <label for="customer-billing-month">Billing / receipt month<select id="customer-billing-month"><option value="">All months</option>${monthOptions}</select></label>
          <label for="customer-receipt-from">Receipt dates from<input id="customer-receipt-from" type="date" value="${escapeHtml(pageState.customerReceiptFrom)}"></label>
          <label for="customer-receipt-through">Receipt dates through<input id="customer-receipt-through" type="date" value="${escapeHtml(pageState.customerReceiptThrough)}"></label>
          <button id="clear-customer-billing-filters" class="button secondary small" type="button">Clear filters</button>
        </div>
        <p id="customer-billing-filter-help" class="muted">Month filters both bill period and receipt date. Start/end dates narrow only the actual receipt list.</p>
        <div id="customer-billing-results"></div>
      </section>
      <section class="panel data-panel customer-incidents-panel" aria-labelledby="customer-incidents-title"><div class="section-heading"><div><p class="eyebrow">Service updates</p><h2 id="customer-incidents-title">Incident timeline</h2></div><span class="muted">${incidents.length} updates</span></div>
        <div class="incident-list">${incidents.map((incident) => {
          const timeline = buildIncidentTimeline(incident);
          const statusClass = timeline.status === 'unknown' ? 'unknown' : timeline.status;
          const eventRows = timeline.events.map((item) => `<li class="incident-timeline__event"><span class="incident-timeline__dot" aria-hidden="true"></span><span class="incident-timeline__label">${escapeHtml(item.label)}</span><time datetime="${escapeHtml(item.datetime)}">${escapeHtml(item.displayTime)}</time></li>`).join('');
          return `<article class="incident-item incident-item--${statusClass}"><header class="incident-item__header"><div><p class="eyebrow">Service update</p><h3>Incident timeline</h3></div><span class="status-pill incident-status--${statusClass}">${escapeHtml(timeline.statusLabel)}</span></header><p class="incident-item__summary">${escapeHtml(incident.customer_visible_summary)}</p><ol class="incident-timeline" aria-label="Recorded service milestones">${eventRows || '<li class="incident-timeline__empty">No milestone times are available.</li>'}</ol><p class="incident-recovery">${escapeHtml(timeline.restorationMessage)}</p></article>`;
        }).join('') || '<p class="incident-empty" role="status">No customer-visible service updates are recorded for this account.</p>'}</div>
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
