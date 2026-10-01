import { createPortalClient } from './supabase-client.js';
import { validatePakistanPhone } from './customer-input.js';
import { createCustomer, invokeRpc, loadContexts, loadPortalRows } from './portal-data.js';
import { amountToMinorUnits, calculateDashboard, formatMoney } from './ledger.js';
import { renderDashboardMetrics } from './dashboard-metrics.js';
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
    loadingUserId: null,
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
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function localDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function setMessage(node, message = '', isError = false) {
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('error-text', isError);
    node.classList.toggle('success-text', Boolean(message) && !isError);
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
    portalPanel.innerHTML = '<div class="panel loading-panel"><span class="spinner" aria-hidden="true"></span><p>Loading records allowed for this account…</p></div>';
  }

  async function selectContext(context) {
    pageState.context = context;
    showPortalLoading();
    try {
      pageState.rows = await loadPortalRows(supabase, context);
      renderPortal();
    } catch (error) {
      portalPanel.innerHTML = `<div class="panel"><p class="eyebrow">Could not load records</p><h2>Access was not granted</h2><p class="error-text">${escapeHtml(error.message || 'The request failed.')}</p><p>Database row-level policies remain authoritative; contact the ISP administrator if this account should have portal access.</p><button class="button secondary" data-action="sign-out">Sign out</button></div>`;
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
        portalPanel.innerHTML = '<div class="panel"><p class="eyebrow">No portal access</p><h2>This email is not linked to an ISP account</h2><p>Ask the ISP administrator to assign an Admin role or send a customer invitation.</p><button class="button secondary" data-action="sign-out">Sign out</button></div>';
        bindSharedActions();
        return;
      }
      await selectContext(pageState.contexts[0]);
    } catch (error) {
      portalPanel.innerHTML = `<div class="panel"><p class="eyebrow">Sign-in could not be completed</p><h2>Account access needs review</h2><p class="error-text">${escapeHtml(error.message || 'The request failed.')}</p><button class="button secondary" data-action="sign-out">Sign out</button></div>`;
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
    return `<div class="portal-heading"><div><p class="eyebrow">${escapeHtml(label)}</p><h1>${escapeHtml(pageState.context.organizationName ?? 'Shahdara Fiber Net')}</h1><p class="muted">${escapeHtml(accountLabel)}</p></div><div class="header-actions">${contextSelectHtml()}<button class="button secondary small" data-action="sign-out">Sign out</button></div></div>`;
  }

  function wirePortalBase() {
    bindSharedActions();
    portalPanel.querySelector('#context-picker')?.addEventListener('change', async (event) => {
      const context = pageState.contexts[Number(event.target.value)];
      if (context) await selectContext(context);
    });
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
    const customerName = (id) => rows.customers.find((customer) => customer.id === id)?.name ?? 'Customer';
    const monthOptions = customers.map((customer) => `<option value="${escapeHtml(customer.id)}">#${customer.customer_number} · ${escapeHtml(customer.name)}</option>`).join('');
    const billOptions = bills.map((bill) => `<option value="${escapeHtml(bill.id)}">${escapeHtml(customerName(bill.customer_id))} · ${escapeHtml(bill.period.slice(0, 7))} · ${formatMoney(bill.amount_due_cents)}</option>`).join('');
    const inviteCustomers = customers.filter((customer) => !customer.archived);
    const inviteCustomerOptions = inviteCustomers.map((customer) => `<option value="${escapeHtml(customer.id)}">#${customer.customer_number} · ${escapeHtml(customer.name)}</option>`).join('');

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
            <label for="bill-month">Billing month</label><input id="bill-month" name="period" type="month" value="${escapeHtml(pageState.selectedMonth)}" required>
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
            <label>Method<select name="method"><option>Cash</option><option>Easypaisa</option><option>JazzCash</option><option>Bank transfer</option><option>Other</option></select></label>
            <button class="button primary" type="submit">Record receipt</button>
          </form><p class="form-message" id="receipt-message" role="status"></p>
        </section>
      </div>
      <section class="panel data-panel"><div class="section-heading"><div><p class="eyebrow">Current customer list</p><h2>Customers</h2></div><span class="muted">${customers.length} records</span></div>
        <div class="table-wrap"><table><thead><tr><th>No.</th><th>Name</th><th>Plan</th><th>Monthly fee</th><th>Status</th></tr></thead><tbody>${customers.map((customer) => `<tr><td>${customer.customer_number}</td><td>${escapeHtml(customer.name)}</td><td>${escapeHtml(customer.plan_name || '—')}</td><td>${formatMoney(customer.monthly_fee_cents)}</td><td>${escapeHtml(customer.archived ? 'Archived' : customer.service_status)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-cell">No customer records yet.</td></tr>'}</tbody></table></div>
      </section>
      <section class="panel data-panel"><div class="section-heading"><div><p class="eyebrow">Monthly snapshots</p><h2>Bills</h2></div><span class="muted">${bills.length} records</span></div>
        <div class="table-wrap"><table><thead><tr><th>Month</th><th>Customer</th><th>Bill</th><th>Receipts</th><th>Credit applied</th><th>Balance</th><th>Status</th><th></th></tr></thead><tbody>${bills.slice(0, 100).map((bill) => {
          const applied = allocationTotals(rows, bill.id);
          const balance = bill.amount_due_cents == null ? null : Math.max(0, Number(bill.amount_due_cents) - applied);
          const status = bill.amount_due_cents == null ? 'Not set' : balance === 0 ? 'Paid' : applied > 0 ? 'Partial' : 'Pending';
          const credit = rows.allocations.filter((row) => row.bill_id === bill.id && row.allocation_kind === 'carry-forward').reduce((sum, row) => sum + Number(row.amount_cents || 0), 0);
          return `<tr><td>${escapeHtml(bill.period.slice(0, 7))}</td><td>${escapeHtml(customerName(bill.customer_id))}</td><td>${formatMoney(bill.amount_due_cents)}</td><td>${formatMoney(receiptTotalForBill(rows, bill.id))}</td><td>${formatMoney(credit)}</td><td>${formatMoney(balance)}</td><td><span class="status-pill">${status}</span></td><td><button class="text-button" data-action="edit-bill" data-id="${escapeHtml(bill.id)}">Correct</button></td></tr>`;
        }).join('') || '<tr><td colspan="8" class="empty-cell">No bills recorded yet.</td></tr>'}</tbody></table></div>
      </section>
      <section class="panel data-panel"><div class="section-heading"><div><p class="eyebrow">Dated cash entries</p><h2>Receipts</h2></div><span class="muted">${receipts.length} actual receipts</span></div>
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Customer</th><th>Method</th><th>Amount</th><th>Actions</th></tr></thead><tbody>${receipts.slice(0, 100).map((receipt) => `<tr><td>${escapeHtml(receipt.received_on)}</td><td>${escapeHtml(customerName(receipt.customer_id))}</td><td>${escapeHtml(receipt.method)}</td><td>${formatMoney(receipt.amount_cents)}</td><td><button class="text-button" data-action="edit-receipt" data-id="${escapeHtml(receipt.id)}">Edit</button><button class="text-button danger" data-action="delete-receipt" data-id="${escapeHtml(receipt.id)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty-cell">No receipts recorded yet.</td></tr>'}</tbody></table></div>
      </section>
      <section class="panel data-panel"><div class="section-heading"><div><p class="eyebrow">Customer-visible summaries</p><h2>Incidents</h2></div><span class="muted">${rows.incidents.length} records</span></div>
        <div class="table-wrap"><table><thead><tr><th>Reported</th><th>Customer</th><th>Summary</th><th>Status</th></tr></thead><tbody>${rows.incidents.slice(0, 100).map((incident) => `<tr><td>${escapeHtml(String(incident.reported_at).slice(0, 10))}</td><td>${escapeHtml(incident.customer_id ? customerName(incident.customer_id) : 'Organization')}</td><td>${escapeHtml(incident.customer_visible_summary)}</td><td>${escapeHtml(incident.status)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty-cell">No incident records yet.</td></tr>'}</tbody></table></div>
        <p class="muted">Staff-only notes are stored in a separate RLS-protected table and are not sent to customer accounts.</p>
      </section>
      <dialog id="receipt-dialog" class="edit-dialog"><form id="receipt-edit-form" method="dialog"><div class="section-heading"><div><p class="eyebrow">Correction</p><h2>Edit receipt</h2></div><button class="icon-button" type="button" data-action="close-dialog" aria-label="Close">×</button></div><input type="hidden" name="receipt_id"><label>Original bill<select name="bill_id" required></select></label><label>Received on<input name="received_on" type="date" required></label><label>Actual amount (PKR)<input name="amount" inputmode="decimal" required></label><label>Method<input name="method" maxlength="40" required></label><div class="form-actions"><button class="button secondary" type="button" data-action="close-dialog">Cancel</button><button class="button primary" type="submit">Save correction</button></div></form></dialog>`;

    wirePortalBase();
    portalPanel.querySelector('#dashboard-month')?.addEventListener('change', (event) => {
      pageState.selectedMonth = event.target.value || localMonth();
      renderPortal();
    });
    portalPanel.querySelector('#receipt-customer')?.addEventListener('change', (event) => populateReceiptBills(event.target.value));
    bindAdminForms(context);
    bindAdminActions(context);
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
        await refreshCurrentContext();
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
        if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('Choose a valid billing month.');
        await invokeRpc(supabase, 'create_monthly_bill', {
          p_organization_id: context.organizationId,
          p_customer_id: String(formData.get('customer_id')),
          p_period: `${period}-01`,
        });
        setMessage(message, 'Bill snapshot saved. Existing monthly snapshots are not overwritten.');
        await refreshCurrentContext();
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
        setMessage(message, 'Receipt recorded. Carry-forward credit is shown separately, not as another payment.');
        await refreshCurrentContext();
      } catch (error) {
        setMessage(message, `${error.message || 'Receipt could not be recorded.'} Retry the same receipt with its existing request ID; do not start a second cash entry until the first outcome is clear.`, true);
      }
    });
  }

  function bindAdminActions(context) {
    portalPanel.querySelectorAll('[data-action="edit-bill"]').forEach((button) => button.addEventListener('click', async () => {
      const bill = pageState.rows.bills.find((row) => row.id === button.dataset.id);
      if (!bill) return;
      const current = bill.amount_due_cents == null ? '' : (Number(bill.amount_due_cents) / 100).toFixed(2);
      const value = window.prompt(`Bill amount in PKR for ${bill.period.slice(0, 7)} (leave blank for Not set):`, current);
      if (value === null) return;
      try {
        const amount = value.trim() === '' ? null : amountToMinorUnits(value, { allowZero: true });
        const { error } = await supabase.from('bills').update({ amount_due_cents: amount })
          .eq('organization_id', context.organizationId).eq('id', bill.id);
        if (error) throw error;
        await refreshCurrentContext();
      } catch (error) {
        window.alert(error.message || 'Bill could not be corrected.');
      }
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
        await refreshCurrentContext();
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
        await refreshCurrentContext();
      } catch (error) {
        window.alert(error.message || 'Receipt correction could not be saved.');
      }
    });
  }

  function renderCustomer() {
    const rows = pageState.rows;
    const customer = rows.customers[0];
    if (!customer) {
      portalPanel.innerHTML = `${shellHeader('Customer portal')}<section class="panel"><h2>Profile not found</h2><p>Ask the ISP administrator to review the account link.</p><button class="button secondary" data-action="sign-out">Sign out</button></section>`;
      wirePortalBase();
      return;
    }
    const bills = [...rows.bills].sort((a, b) => String(b.period).localeCompare(String(a.period)));
    const receipts = [...rows.receipts].sort((a, b) => String(b.received_on).localeCompare(String(a.received_on)));
    const totalCash = receipts.reduce((sum, receipt) => sum + Number(receipt.amount_cents || 0), 0);
    const balance = (bill) => bill.amount_due_cents == null ? null : Math.max(0, Number(bill.amount_due_cents) - allocationTotals(rows, bill.id));
    const incidents = [...rows.incidents].sort((a, b) => String(b.reported_at).localeCompare(String(a.reported_at)));
    portalPanel.innerHTML = `${shellHeader('Customer portal')}
      <section class="profile-card panel" aria-label="Customer profile">
        <div class="profile-card__identity"><p class="eyebrow">Your account</p><h2>${escapeHtml(customer.name)}</h2><p class="profile-card__number">Customer #${customer.customer_number}</p></div>
        <div class="profile-card__details"><div class="profile-field"><span>Plan</span><strong>${escapeHtml(customer.plan_name || 'Plan not set')}</strong></div><div class="profile-field"><span>Monthly fee</span><strong>${formatMoney(customer.monthly_fee_cents)}</strong></div><div class="profile-field profile-field--wide"><span>Service address</span><strong>${escapeHtml(customer.service_address || 'Service address not recorded')}</strong></div></div>
        <div class="profile-card__status"><span class="status-pill">${escapeHtml(customer.archived ? 'Archived' : customer.service_status)}</span><p>Service status</p></div>
      </section>
      <section class="metric-grid customer-metrics"><article class="metric"><span>Total receipts</span><strong>${formatMoney(totalCash)}</strong><small>${receipts.length} actual payments</small></article><article class="metric"><span>Billing history</span><strong>${bills.length}</strong><small>Monthly snapshots</small></article></section>
      <section class="panel data-panel"><div class="section-heading"><div><p class="eyebrow">Your billing history</p><h2>Bills and credits</h2></div></div><div class="table-wrap"><table><thead><tr><th>Month</th><th>Bill</th><th>Receipt cash</th><th>Credit applied</th><th>Balance</th><th>Status</th></tr></thead><tbody>${bills.map((bill) => {
        const applied = allocationTotals(rows, bill.id);
        const billBalance = balance(bill);
        const credit = rows.allocations.filter((row) => row.bill_id === bill.id && row.allocation_kind === 'carry-forward').reduce((sum, row) => sum + Number(row.amount_cents || 0), 0);
        const actualReceipts = receiptTotalForBill(rows, bill.id);
        const status = billBalance == null ? 'Not set' : billBalance === 0 ? 'Paid' : applied > 0 ? 'Partial' : 'Pending';
        return `<tr><td>${escapeHtml(bill.period.slice(0, 7))}</td><td>${formatMoney(bill.amount_due_cents)}</td><td>${formatMoney(actualReceipts)}</td><td>${formatMoney(credit)}</td><td>${formatMoney(billBalance)}</td><td><span class="status-pill">${status}</span></td></tr>`;
      }).join('') || '<tr><td colspan="6" class="empty-cell">No bills are available yet.</td></tr>'}</tbody></table></div><p class="muted">Receipt cash is shown once on its original receipt. Credit applied to later bills is separate and is not another payment.</p></section>
      <section class="panel data-panel"><div class="section-heading"><div><p class="eyebrow">Dated receipts</p><h2>Payment history</h2></div></div><div class="table-wrap"><table><thead><tr><th>Received on</th><th>Method</th><th>Amount</th></tr></thead><tbody>${receipts.map((receipt) => `<tr><td>${escapeHtml(receipt.received_on)}</td><td>${escapeHtml(receipt.method)}</td><td>${formatMoney(receipt.amount_cents)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-cell">No receipts are available yet.</td></tr>'}</tbody></table></div></section>
      <section class="panel data-panel"><div class="section-heading"><div><p class="eyebrow">Service updates</p><h2>Incidents</h2></div></div><div class="incident-list">${incidents.map((incident) => `<article class="incident-item"><div><strong>${escapeHtml(String(incident.reported_at).slice(0, 10))}</strong><span class="status-pill">${escapeHtml(incident.status)}</span></div><p>${escapeHtml(incident.customer_visible_summary)}</p>${incident.restored_at ? `<small class="muted">Restored ${escapeHtml(String(incident.restored_at).slice(0, 10))}</small>` : ''}</article>`).join('') || '<p class="empty-cell">No customer-visible service updates.</p>'}</div></section>`;
    wirePortalBase();
  }

  async function refreshCurrentContext() {
    if (!pageState.context) return;
    showPortalLoading();
    try {
      pageState.rows = await loadPortalRows(supabase, pageState.context);
      renderPortal();
    } catch (error) {
      portalPanel.innerHTML = `<div class="panel"><h2>Refresh failed</h2><p class="error-text">${escapeHtml(error.message || 'The request failed.')}</p><button class="button secondary" data-action="sign-out">Sign out</button></div>`;
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
