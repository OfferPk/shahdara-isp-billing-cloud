import { createPortalClient, isStagingProjectUrl } from './supabase-client.js';
import { hasPasswordRecoveryMarker, requestPasswordRecovery, setRecoveredPassword, signInWithEmailPassword } from './auth-flows.js';
import { validatePakistanPhone } from './customer-input.js';
import { createCustomer, invokeRpc, loadContexts, loadOrganizationBranding, loadPortalRows, manageServiceIncident, saveCustomerPppoeUsername, saveCustomerPortalTestAccount } from './portal-data.js';
import { getBillingCycleQuickDate, isValidBillingMonth, localDateString, localMonthString } from './bill-dates.js';
import { amountToMinorUnits, calculateDashboard, formatMoney } from './ledger.js';
import { CASHFLOW_CATEGORIES, filterCashflowExpenses, summarizeCashflow } from './cashflow.js';
import { renderDashboardMetrics } from './dashboard-metrics.js';
import {
  buildCustomerListRows,
  filterCustomerRows,
  filterCustomersWithoutBillSnapshot,
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
  filterCollectionBillRows,
  filterAdminBillRows,
  renderAdminBillCards,
  renderPrintableReceiptHtml,
} from './admin-bills.js';
import { parseDashboardDrilldownHash } from './dashboard-drilldown.js';
import { renderAdminIncidentCards, renderIncidentCustomerOptions } from './admin-incidents.js';
import { applyDocumentLanguage, formatUiMessage, getStoredLanguage, normalizeLanguage, setLanguagePreference, translateUi } from './language.js';
import { BRANDING_BUCKET, buildBrandLogoPath, getOrganizationBranding, getPublicBrandLogoUrl, isSafeBrandLogoPath, safeSupportPhoneHref, validateBrandLogoFile } from './organization-branding.js';
import { renderPrintableBillHtml } from './customer-documents.js';
import { renderCustomerUsageDashboard, renderCustomerUsageSkeleton } from './customer-usage.js';
import { prepareSuccessSound } from './success-sound.js';
import { initializeFeatureToggles, refreshFeatureToggleLabels, ALL_FEATURE_SELECTOR } from './feature-toggles.js';
import { initializeTheme } from './theme.js';
import './styles.css';

const app = document.querySelector('#app');
const configMessage = document.querySelector('#configuration-message');
const authPanel = document.querySelector('#auth-panel');
const portalPanel = document.querySelector('#portal-panel');
const appToast = document.querySelector('#app-toast');
const loginForm = document.querySelector('#login-form');
const loginMessage = document.querySelector('#login-message');
const customerLoginForm = document.querySelector('#customer-login-form');
const customerLoginMessage = document.querySelector('#customer-login-message');
const loginOptions = document.querySelector('#login-options');
const emailPasswordLoginForm = document.querySelector('#email-password-login-form');
const emailPasswordLoginMessage = document.querySelector('#email-password-login-message');
const requestPasswordRecoveryButton = document.querySelector('#request-password-recovery');
const passwordRecoveryPanel = document.querySelector('#password-recovery-panel');
const passwordRecoveryForm = document.querySelector('#password-recovery-form');
const passwordRecoveryMessage = document.querySelector('#password-recovery-message');
const cancelPasswordRecoveryButton = document.querySelector('#cancel-password-recovery');
let currentLanguage = getStoredLanguage();
const t = (message) => translateUi(message, currentLanguage);
const themeControl = initializeTheme({
  root: document.documentElement,
  button: document.querySelector('#theme-toggle'),
  announcement: document.querySelector('#app-announcement'),
  themeColorMeta: document.querySelector('meta[name="theme-color"]'),
  translate: t,
});
let recoveryMode = hasPasswordRecoveryMarker(window.location.search, window.location.hash);
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
const formatFeatureToggleMessage = (message, values = {}) => formatUiMessage(message, currentLanguage, values);
initializeFeatureToggles(document, {
  selector: ALL_FEATURE_SELECTOR,
  formatMessage: formatFeatureToggleMessage,
  observe: true,
});
document.querySelector('#language-toggle')?.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-language]') : null;
  if (!button) return;
  const nextLanguage = normalizeLanguage(button.dataset.language);
  if (nextLanguage === currentLanguage) return;
  currentLanguage = setLanguagePreference(nextLanguage).language;
  themeControl.refreshLabels();
  applyStaticTranslations();
  for (const message of document.querySelectorAll('[data-message-source]')) {
    let values = {};
    try { values = JSON.parse(message.dataset.messageValues || '{}'); } catch { /* Ignore invalid optional toast parameters. */ }
    message.textContent = Object.keys(values).length
      ? formatUiMessage(message.dataset.messageSource, currentLanguage, values)
      : t(message.dataset.messageSource);
  }
  rerenderForLanguage();
  refreshFeatureToggleLabels(document, { formatMessage: formatFeatureToggleMessage });
  const announcement = document.querySelector('#app-announcement');
  if (announcement) announcement.textContent = t(currentLanguage === 'ur-Latn' ? 'Language changed to Roman Urdu.' : 'Language changed to English.');
});

const supabase = createPortalClient(import.meta.env);
const portalTestModeAvailable = isStagingProjectUrl(supabase?.supabaseUrl);
const stagingLoginHelp = document.querySelector('#staging-customer-login-help');
if (stagingLoginHelp) stagingLoginHelp.hidden = !portalTestModeAvailable;

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
    cashflowMonthCount: 3,
    cashflowSearch: '',
    cashflowCategory: 'all',
    cashflowFromDate: '',
    cashflowThroughDate: '',
    billSearch: '',
    billStatus: 'all',
    customerBillingMonth: '',
    customerReceiptFrom: '',
    customerReceiptThrough: '',
    dashboardDrilldown: null,
  };
  let pendingReceiptAttempt = null;
  const pendingFinancialAttempts = new Map();

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

  function financialAttemptKey(kind, context, customerId = '') {
    return `${kind}:${pageState.user?.id ?? 'signed-out'}:${context.organizationId}:${customerId}`;
  }

  function financialAttemptStorageKey(kind, context, customerId = '') {
    return `shahdara-${kind}-attempt:${pageState.user?.id ?? 'signed-out'}:${context.organizationId}:${customerId}`;
  }

  function getFinancialAttemptId(kind, context, customerId = '') {
    const attemptKey = financialAttemptKey(kind, context, customerId);
    const current = pendingFinancialAttempts.get(attemptKey);
    if (current) return current.id;
    const storageKey = financialAttemptStorageKey(kind, context, customerId);
    let id = '';
    try { id = sessionStorage.getItem(storageKey) ?? ''; } catch { /* Keep the in-memory ID for this tab. */ }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) id = crypto.randomUUID();
    pendingFinancialAttempts.set(attemptKey, { id, storageKey });
    try { sessionStorage.setItem(storageKey, id); } catch { /* Stable IDs still work until the page closes. */ }
    return id;
  }

  function clearFinancialAttempt(kind, context, customerId = '') {
    const attemptKey = financialAttemptKey(kind, context, customerId);
    const attempt = pendingFinancialAttempts.get(attemptKey);
    const storageKey = attempt?.storageKey ?? financialAttemptStorageKey(kind, context, customerId);
    try { sessionStorage.removeItem(storageKey); } catch { /* Browser storage is optional. */ }
    pendingFinancialAttempts.delete(attemptKey);
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

  let appToastTimeout = null;
  function showAppToast(message) {
    if (!appToast) return;
    window.clearTimeout(appToastTimeout);
    appToast.hidden = false;
    setMessage(appToast, message, false);
    appToastTimeout = window.setTimeout(() => {
      appToast.hidden = true;
      setMessage(appToast, '', false);
    }, 7000);
  }

  function announceApp(message) {
    const announcement = document.querySelector('#app-announcement');
    if (announcement) {
      announcement.dataset.messageSource = message;
      announcement.textContent = t(message);
    }
  }

  function showLogin(message = '', isError = false) {
    recoveryMode = false;
    configMessage.hidden = true;
    portalPanel.hidden = true;
    authPanel.hidden = false;
    loginOptions.hidden = false;
    passwordRecoveryPanel.hidden = true;
    setMessage(loginMessage, message, isError);
    setMessage(customerLoginMessage, '', false);
    setMessage(emailPasswordLoginMessage, '', false);
    setMessage(passwordRecoveryMessage, '', false);
  }

  function showPasswordRecovery() {
    configMessage.hidden = true;
    portalPanel.hidden = true;
    authPanel.hidden = false;
    loginOptions.hidden = true;
    passwordRecoveryPanel.hidden = false;
    setMessage(passwordRecoveryMessage, '', false);
    passwordRecoveryForm?.querySelector('input[name="new_password"]')?.focus();
  }

  function showPortalLoading(includeCustomerUsage = false) {
    configMessage.hidden = true;
    authPanel.hidden = true;
    portalPanel.hidden = false;
    portalPanel.innerHTML = `<div class="panel loading-panel" role="status" aria-live="polite" aria-busy="true"><span class="spinner" aria-hidden="true"></span><p>${escapeHtml(t('Loading records allowed for this account…'))}</p></div>${includeCustomerUsage ? renderCustomerUsageSkeleton(t) : ''}`;
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
    showPortalLoading(context.kind === 'customer');
    try {
      pageState.rows = await loadPortalRows(supabase, context);
      applyDashboardDrilldown(parseDashboardDrilldownHash(window.location.hash));
      renderPortal();
      if (pageState.dashboardDrilldown) focusDashboardDrilldown(pageState.dashboardDrilldown);
      else if (contextChanged) portalPanel.querySelector('h1')?.focus();
      announceApp(context.kind === 'admin' ? 'Administrator portal loaded.' : 'Customer portal loaded.');
    } catch (error) {
      portalPanel.innerHTML = `<div class="panel" role="alert"><p class="eyebrow">${escapeHtml(t('Could not load records'))}</p><h2>${escapeHtml(t('Access was not granted'))}</h2><p class="error-text">${escapeHtml(error.message || t('The request failed.'))}</p><p>${escapeHtml(t('Database row-level policies remain authoritative; contact the ISP administrator if this account should have portal access.'))}</p><button class="button secondary" data-action="sign-out">${escapeHtml(t('Sign out'))}</button></div>`;
      bindSharedActions();
    }
  }

  async function handleSession(session) {
    if (!session) {
      const recoveryLinkWasPresent = recoveryMode;
      pageState.user = null;
      pageState.contexts = [];
      pageState.context = null;
      pageState.rows = null;
      pendingReceiptAttempt = null;
      showLogin(recoveryLinkWasPresent ? 'Recovery link could not be verified or has expired. Request a new one.' : '', recoveryLinkWasPresent);
      return;
    }
    if (recoveryMode) {
      showPasswordRecovery();
      return;
    }
    if (pageState.loadingUserId === session.user.id) return;
    if (pageState.user?.id === session.user.id && pageState.contexts.length) return;
    pageState.loadingUserId = session.user.id;
    pageState.user = session.user;
    showPortalLoading();
    try {
      const { data: passwordStates, error: passwordStateError } = await supabase.rpc('my_customer_portal_password_state');
      if (passwordStateError) throw passwordStateError;
      const passwordState = passwordStates?.[0]?.state ?? 'none';
      if (!['none', 'active'].includes(passwordState)) {
        showCustomerPasswordGate(passwordState);
        return;
      }
      pageState.contexts = await loadContexts(supabase, session.user);
      if (!pageState.contexts.length) {
        portalPanel.innerHTML = `<div class="panel" role="status"><p class="eyebrow">${escapeHtml(t('No portal access'))}</p><h2>${escapeHtml(t('Account access is not available'))}</h2><p>${escapeHtml(t('Ask the ISP administrator to verify this account or issue an invitation.'))}</p><button class="button secondary" data-action="sign-out">${escapeHtml(t('Sign out'))}</button></div>`;
        announceApp('Account access is not available.');
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

  function showCustomerPasswordGate(state) {
    pageState.contexts = [];
    pageState.context = null;
    pageState.rows = null;
    authPanel.hidden = true;
    portalPanel.hidden = false;
    const canChange = state === 'change_required';
    const heading = canChange ? 'Change your temporary password' : state === 'expired'
      ? 'Temporary password expired'
      : 'Customer access is temporarily unavailable';
    const description = canChange
      ? 'Set a new password before portal data is available. The temporary password can be used only once and expires after 24 hours.'
      : state === 'expired'
        ? 'This temporary password expired or was already used. Ask a Shahdara administrator to issue a new one.'
        : 'Customer data is blocked until an administrator reviews or resets this account.';
    portalPanel.innerHTML = `<section class="panel" aria-labelledby="password-gate-title"><p class="eyebrow">${escapeHtml(t('Customer account security'))}</p><h1 id="password-gate-title">${escapeHtml(t(heading))}</h1><p>${escapeHtml(t(description))}</p>${canChange ? `<form id="mandatory-password-change-form" class="stack"><label for="mandatory-new-password">${escapeHtml(t('New password'))}</label><input id="mandatory-new-password" name="new_password" type="password" autocomplete="new-password" required minlength="12" maxlength="72" /><label for="mandatory-confirm-password">${escapeHtml(t('Confirm new password'))}</label><input id="mandatory-confirm-password" name="confirm_password" type="password" autocomplete="new-password" required minlength="12" maxlength="72" /><button class="button primary" type="submit">${escapeHtml(t('Save new password'))}</button></form><p id="password-change-message" class="form-message" role="status"></p>` : ''}<button class="button secondary" data-action="sign-out">${escapeHtml(t('Sign out'))}</button></section>`;
    bindSharedActions();
    const form = portalPanel.querySelector('#mandatory-password-change-form');
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const newPasswordInput = form.elements.new_password;
      const confirmPasswordInput = form.elements.confirm_password;
      let newPassword = String(newPasswordInput.value ?? '');
      const message = portalPanel.querySelector('#password-change-message');
      const submit = form.querySelector('button[type="submit"]');
      if (newPassword !== String(confirmPasswordInput.value ?? '')) {
        setMessage(message, 'The new passwords do not match.', true);
        return;
      }
      const byteLength = new TextEncoder().encode(newPassword).byteLength;
      if (byteLength < 12 || byteLength > 72) {
        setMessage(message, 'Choose a password between 12 and 72 UTF-8 bytes.', true);
        return;
      }
      submit.disabled = true;
      setMessage(message, 'Updating password…');
      try {
        const { data, error } = await supabase.functions.invoke('change-customer-password', {
          body: { new_password: newPassword },
        });
        newPasswordInput.value = '';
        confirmPasswordInput.value = '';
        newPassword = '';
        if (error || data?.ok !== true) {
          setMessage(message, 'Password could not be changed. Try again or contact an administrator.', true);
          return;
        }
        const { data: sessionData } = await supabase.auth.getSession();
        await handleSession(sessionData.session);
      } catch {
        newPasswordInput.value = '';
        confirmPasswordInput.value = '';
        newPassword = '';
        setMessage(message, 'Password could not be changed. Try again or contact an administrator.', true);
      } finally {
        if (submit.isConnected) submit.disabled = false;
      }
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
    applyBrandIdentity();
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

  function currentBranding() {
    return getOrganizationBranding(pageState.rows?.branding, pageState.context?.organizationName);
  }

  function currentBrandLogoUrl() {
    return getPublicBrandLogoUrl(supabase, pageState.context?.organizationId, pageState.rows?.branding?.logo_path);
  }

  function applyBrandIdentity() {
    const branding = currentBranding();
    const brandLink = document.querySelector('.site-header .brand');
    const brandName = brandLink?.querySelector('strong');
    const brandMark = brandLink?.querySelector('.brand-mark');
    if (brandName) brandName.textContent = branding.displayName;
    if (brandLink) brandLink.setAttribute('aria-label', `${branding.displayName} cloud portal home`);
    if (brandMark) {
      brandMark.replaceChildren();
      const logoUrl = currentBrandLogoUrl();
      if (logoUrl) {
        const image = document.createElement('img');
        image.src = logoUrl;
        image.alt = '';
        brandMark.append(image);
      } else {
        brandMark.textContent = branding.displayName.split(/\s+/).filter(Boolean).slice(0, 2)
          .map((part) => Array.from(part)[0]).join('').toUpperCase().slice(0, 2) || 'ISP';
      }
    }
    document.title = `${branding.displayName} · ${t('Cloud billing portal')}`;
  }

  function brandingSettingsHtml() {
    if (pageState.context?.role !== 'owner') return '';
    const branding = currentBranding();
    const logoUrl = currentBrandLogoUrl();
    return `<section id="company-branding" class="panel data-panel brand-settings" aria-labelledby="company-branding-title">
      <div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Brand identity'))}</p><h2 id="company-branding-title">${escapeHtml(t('Company profile'))}</h2></div></div>
      <p class="muted">${escapeHtml(t('Customers see this name, logo, support phone, and address in their portal and print-ready billing documents.'))}</p>
      <p class="muted">${escapeHtml(t('The company support phone is separate from each customer’s private phone record.'))}</p>
      <form id="brand-profile-form" class="brand-settings__form">
        <label>${escapeHtml(t('Company display name'))}<input name="display_name" maxlength="120" required value="${escapeHtml(branding.displayName)}"></label>
        <label>${escapeHtml(t('Support phone'))}<input name="support_phone" type="tel" autocomplete="tel" maxlength="40" value="${escapeHtml(branding.supportPhone)}"></label>
        <label class="brand-settings__address">${escapeHtml(t('Company address'))}<textarea name="address" maxlength="300" rows="3">${escapeHtml(branding.address)}</textarea></label>
        <label class="brand-settings__logo">${escapeHtml(t('Logo image'))}<input id="brand-logo-file" name="logo" type="file" accept="image/png,image/jpeg,image/webp" aria-describedby="brand-logo-help"><small id="brand-logo-help">${escapeHtml(t('Choose a PNG, JPEG, or WebP image. Maximum size: 1 MB.'))}</small></label>
        <div id="brand-logo-preview" class="brand-logo-preview">${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(t('Current company logo'))}">` : `<span>${escapeHtml(t('No logo uploaded'))}</span>`}</div>
        <div class="brand-settings__actions"><button class="button primary" type="submit">${escapeHtml(t('Save company profile'))}</button>${logoUrl ? `<button class="button secondary" type="button" data-action="remove-brand-logo">${escapeHtml(t('Remove logo'))}</button>` : ''}</div>
        <p class="form-message" id="brand-profile-message" role="status" aria-live="polite"></p>
      </form>
    </section>`;
  }

  function customerProviderCardHtml() {
    const branding = currentBranding();
    const logoUrl = currentBrandLogoUrl();
    const phoneHref = safeSupportPhoneHref(branding.supportPhone);
    const supportPhone = branding.supportPhone
      ? phoneHref ? `<a href="${escapeHtml(phoneHref)}">${escapeHtml(branding.supportPhone)}</a>` : escapeHtml(branding.supportPhone)
      : escapeHtml(t('Not recorded'));
    const companyAddress = branding.address ? escapeHtml(branding.address) : escapeHtml(t('Not recorded'));
    return `<section class="provider-card panel" aria-labelledby="provider-card-title">
      ${logoUrl ? `<img class="provider-card__logo" src="${escapeHtml(logoUrl)}" alt="">` : ''}
      <div class="provider-card__identity"><p class="eyebrow">${escapeHtml(t('Your service provider'))}</p><h2 id="provider-card-title">${escapeHtml(branding.displayName)}</h2></div>
      <div class="provider-card__contact"><p><span>${escapeHtml(t('Support phone'))}</span>${supportPhone}</p><p><span>${escapeHtml(t('Company address'))}</span><strong>${companyAddress}</strong></p></div>
    </section>`;
  }

  function shellHeader(label) {
    const accountLabel = pageState.context?.kind === 'admin'
      ? `${t('Signed in as')} ${pageState.user?.email ?? ''}`
      : t('Linked customer account');
    return `<div class="portal-heading"><div><p class="eyebrow">${escapeHtml(label)}</p><h1 tabindex="-1">${escapeHtml(currentBranding().displayName)}</h1><p class="muted">${escapeHtml(accountLabel)}</p></div><div class="header-actions">${contextSelectHtml()}<button class="button secondary small" data-action="sign-out">${escapeHtml(t('Sign out'))}</button></div></div>`;
  }

  function renderPortalNavigation(kind) {
    const links = kind === 'admin'
      ? [['#admin-overview', 'Overview'], ['#customer-list', 'Customers'], ['#admin-bills', 'Bills'], ['#admin-receipts', 'Receipts'], ['#admin-incidents', 'Service incidents'], ...(pageState.context?.role === 'owner' ? [['#company-branding', 'Company profile']] : [])]
      : [['#customer-account', 'My account'], ['#customer-usage', 'Usage dashboard'], ['#customer-expiry', 'Service expiry'], ['#customer-billing', 'Billing history'], ['#customer-incidents', 'Service updates']];
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
    const drilldown = pageState.dashboardDrilldown?.target === 'customer-list' ? pageState.dashboardDrilldown : null;
    const scopedRows = drilldown
      ? filterCustomersWithoutBillSnapshot(listRows, pageState.rows?.bills ?? [], drilldown.period)
      : listRows;
    const filteredRows = filterCustomerRows(scopedRows, {
      search: pageState.customerListSearch,
      status: pageState.customerListStatus,
      area: pageState.customerListArea,
    });
    const grid = portalPanel.querySelector('#customer-card-grid');
    const count = portalPanel.querySelector('#customer-list-count');
    if (count) count.setAttribute('aria-live', drilldown ? 'off' : 'polite');
    if (grid) {
      grid.innerHTML = listRows.length
        ? renderCustomerCards(filteredRows, formatMoney, t)
        : `<p class="customer-list-empty" role="status">${escapeHtml(t('No customer records yet.'))}</p>`;
    }
    if (count) count.textContent = formatUiMessage('Showing {shown} of {total} customers.', currentLanguage, { shown: filteredRows.length, total: scopedRows.length });
    const summary = portalPanel.querySelector('#customer-list-drilldown-summary');
    const summaryMessage = portalPanel.querySelector('#customer-list-drilldown-message');
    if (summary && summaryMessage) {
      summary.hidden = !drilldown;
      summaryMessage.textContent = drilldown
        ? formatUiMessage('Showing active customers without a bill snapshot for {period}. {count} customers match.', currentLanguage, { period: drilldown.period, count: scopedRows.length })
        : '';
    }
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
      customerServiceCosts: pageState.rows.customerServiceCosts,
      organizationId: pageState.context.organizationId,
      formatMoney,
      t,
      locale: currentLanguage === 'ur-Latn' ? 'ur-Latn-PK' : 'en-PK',
      portalTestModeAvailable: pageState.context?.kind === 'admin' && portalTestModeAvailable,
    });
    content.dataset.customerId = customerId;
    content.querySelector('[data-action="close-customer-profile"]')?.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      const oneTimeResult = content.querySelector('#customer-credential-result');
      oneTimeResult?.replaceChildren();
      if (oneTimeResult) oneTimeResult.hidden = true;
    }, { once: true });
    content.querySelector('#customer-portal-test-account')?.addEventListener('change', async (event) => {
      const checkbox = event.currentTarget;
      const enabled = checkbox.checked;
      const message = content.querySelector('#customer-portal-test-account-message');
      checkbox.disabled = true;
      setMessage(message, 'Updating staging test access…');
      try {
        await saveCustomerPortalTestAccount(supabase, {
          organizationId: pageState.context.organizationId,
          customerId,
          enabled,
        });
        row.customer.portal_test_account = enabled;
        setMessage(message, enabled
          ? 'Staging test access is enabled. The initial portal password is 123456; customer data stays blocked until it is changed.'
          : 'Staging test access is disabled. Existing PPPoE test sign-in is blocked; issue a standard credential reset before restoring access.', false);
      } catch (error) {
        checkbox.checked = !enabled;
        const errorMessage = error?.code === '42501'
          ? 'Only organization administrators can update staging test access.'
          : error?.code === '23514'
            ? 'Link a valid existing PPPoE username before enabling staging test access.'
            : 'Staging test access could not be saved. Verify the staging migration and Admin access, then try again.';
        setMessage(message, errorMessage, true);
      } finally {
        checkbox.disabled = false;
      }
    });
    content.querySelector('#customer-credential-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (pageState.context?.kind !== 'admin') return;
      if (!window.confirm(t('This will block customer portal data until a new password is set. Continue?'))) return;
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      const result = content.querySelector('#customer-credential-result');
      const formData = new FormData(form);
      const reason = String(formData.get('reason') ?? '').trim();
      const identityVerified = formData.get('identity_verified') === 'yes';
      if (reason.length < 10 || reason.length > 500 || !identityVerified) {
        result.textContent = t('Complete the identity check and enter a valid reason.');
        result.hidden = false;
        return;
      }
      result.replaceChildren();
      result.textContent = t('Issuing credentials…');
      result.hidden = false;
      button.disabled = true;
      try {
        const { data, error } = await supabase.functions.invoke('manage-customer-credentials', {
          body: {
            organization_id: pageState.context.organizationId,
            customer_id: form.dataset.customerId,
            identity_verified: true,
            reason,
          },
        });
        if (error || data?.ok !== true || !data.username || !data.temporary_password) {
          result.textContent = t('Credential issue or reset could not be completed. Contact an administrator before retrying.');
          return;
        }
        result.replaceChildren();
        const warning = document.createElement('p');
        warning.textContent = data.test_account === true
          ? t('Staging test only: share username and password 123456 with this test customer. Their first sign-in must set a new password before portal data is unlocked.')
          : t('Show this temporary password to the customer through the approved staff handoff. It will not be shown again.');
        const usernameLabel = document.createElement('p');
        usernameLabel.textContent = `${t('Username')}: `;
        const usernameValue = document.createElement('code');
        usernameValue.textContent = data.username;
        usernameLabel.append(usernameValue);
        const passwordLabel = document.createElement('p');
        passwordLabel.textContent = `${t('Temporary password')}: `;
        const passwordValue = document.createElement('code');
        passwordValue.textContent = data.temporary_password;
        passwordLabel.append(passwordValue);
        const expiry = document.createElement('p');
        expiry.textContent = `${t('Expires')}: ${data.expires_at}`;
        result.append(warning, usernameLabel, passwordLabel, expiry);
      } catch {
        result.textContent = t('Credential issue or reset could not be completed. Contact an administrator before retrying.');
      } finally {
        button.disabled = false;
      }
    });
    content.querySelector('#customer-service-cost-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      const message = content.querySelector('#customer-service-cost-message');
      const context = pageState.context;
      if (context?.kind !== 'admin' || !['owner', 'admin'].includes(context.role)) {
        setMessage(message, 'Only same-organization Owners and Admins can record cashflow.', true);
        return;
      }
      const formData = new FormData(form);
      const effectiveMonth = String(formData.get('effective_month') ?? '').trim();
      const note = String(formData.get('note') ?? '').trim();
      try {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(effectiveMonth)) throw new Error(t('Choose a valid effective month.'));
        const monthlyCostPaisa = amountToMinorUnits(formData.get('monthly_cost'), { allowZero: true });
        if (note.length > 500) throw new Error(t('The service cost note is too long.'));
        button.disabled = true;
        setMessage(message, 'Saving effective cost history…');
        const entryId = getFinancialAttemptId('customer-service-cost', context, customerId);
        await invokeRpc(supabase, 'record_customer_service_cost', {
          p_organization_id: context.organizationId,
          p_customer_id: customerId,
          p_entry_id: entryId,
          p_effective_on: `${effectiveMonth}-01`,
          p_monthly_cost_paisa: monthlyCostPaisa,
          p_note: note || null,
        });
        clearFinancialAttempt('customer-service-cost', context, customerId);
        await refreshCurrentContext('Monthly service-cost history updated.');
        openCustomerProfile(customerId);
        setMessage(portalPanel.querySelector('#customer-service-cost-message'), 'Monthly service-cost history updated.');
      } catch (error) {
        const messageText = error?.code === '23505'
          ? 'This request ID was already used for different cost details. Check the history and retry with the original month, amount, and note; no second entry was created.'
          : error?.code === '42501'
            ? 'Only same-organization Owners and Admins can record cashflow.'
            : 'Service cost could not be confirmed. Retry the same customer, effective month, amount, and note to avoid a duplicate.';
        setMessage(content.querySelector('#customer-service-cost-message'), messageText, true);
      } finally {
        if (button?.isConnected) button.disabled = false;
      }
    });
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

  function focusDashboardDrilldown(route) {
    const sectionId = route.target === 'admin-bills' ? 'admin-bills' : 'customer-list';
    const headingId = route.target === 'admin-bills' ? 'admin-bills-title' : 'customer-list-title';
    const section = portalPanel.querySelector(`#${sectionId}`);
    const heading = portalPanel.querySelector(`#${headingId}`);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    section?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    heading?.focus({ preventScroll: true });
  }

  function applyDashboardDrilldown(route, { focus = false } = {}) {
    const nextRoute = pageState.context?.kind === 'admin' && pageState.rows && route ? route : null;
    const current = pageState.dashboardDrilldown;
    if (current?.hash === nextRoute?.hash && current?.card === nextRoute?.card) return;

    pageState.dashboardDrilldown = nextRoute;
    if (nextRoute) {
      pageState.selectedMonth = nextRoute.period;
      pageState.billSearch = '';
      pageState.billStatus = 'all';
      pageState.customerListSearch = '';
      pageState.customerListStatus = 'all';
      pageState.customerListArea = '';
      pageState.customerAreaOpen = false;
      const monthInput = portalPanel.querySelector('#dashboard-month');
      if (monthInput) monthInput.value = nextRoute.period;
      const billSearch = portalPanel.querySelector('#admin-bill-search');
      if (billSearch) billSearch.value = '';
      const customerSearch = portalPanel.querySelector('#customer-search');
      if (customerSearch) customerSearch.value = '';
    }
    updateAdminBillResults();
    updateCustomerListResults();
    if (focus && nextRoute) focusDashboardDrilldown(nextRoute);
    if (!nextRoute && current) announceApp('Dashboard filter cleared.');
  }

  function bindDashboardDrilldowns(context) {
    if (context.kind !== 'admin') return;
    portalPanel.querySelectorAll('[data-dashboard-drilldown]').forEach((link) => link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const route = parseDashboardDrilldownHash(link.getAttribute('href'));
      if (!route || !pageState.rows || context.organizationId !== pageState.context?.organizationId) return;
      event.preventDefault();
      history.pushState({ ...(history.state ?? {}), dashboardDrilldown: route }, '', route.hash);
      applyDashboardDrilldown(route, { focus: true });
    }));
  }

  function clearDashboardDrilldown(target) {
    const sectionId = target === 'admin-bills' ? 'admin-bills' : 'customer-list';
    history.pushState({ ...(history.state ?? {}), dashboardDrilldown: null }, '', `#${sectionId}`);
    applyDashboardDrilldown(null);
    const headingId = sectionId === 'admin-bills' ? 'admin-bills-title' : 'customer-list-title';
    portalPanel.querySelector(`#${headingId}`)?.focus({ preventScroll: true });
  }

  function updateAdminBillResults() {
    const allBillRows = currentAdminBillRows();
    const drilldown = pageState.dashboardDrilldown?.target === 'admin-bills' ? pageState.dashboardDrilldown : null;
    const billRows = filterCollectionBillRows(allBillRows, {
      scope: drilldown?.scope ?? '',
      period: drilldown?.period ?? '',
    });
    const filteredRows = filterAdminBillRows(billRows, { search: pageState.billSearch, status: pageState.billStatus });
    const counts = countAdminBillFilters(billRows, { search: pageState.billSearch });
    const grid = portalPanel.querySelector('#admin-bill-card-grid');
    const count = portalPanel.querySelector('#admin-bill-count');
    if (count) count.setAttribute('aria-live', drilldown ? 'off' : 'polite');
    if (grid) grid.innerHTML = renderAdminBillCards(filteredRows, formatMoney, t);
    if (count) count.textContent = formatUiMessage('Showing {shown} of {matching} matching bills; {total} total records.', currentLanguage, { shown: Math.min(filteredRows.length, 100), matching: filteredRows.length, total: allBillRows.length });
    const summary = portalPanel.querySelector('#admin-bill-drilldown-summary');
    const summaryMessage = portalPanel.querySelector('#admin-bill-drilldown-message');
    if (summary && summaryMessage) {
      summary.hidden = !drilldown;
      const message = drilldown?.scope === 'overdue'
        ? 'Showing overdue bills for {period}. {count} bills match. Past-due means an explicitly recorded due date before today and a positive remaining balance.'
        : 'Showing unpriced bills for {period}. {count} bills match. No bill amount is treated as zero.';
      summaryMessage.textContent = drilldown
        ? formatUiMessage(message, currentLanguage, { period: drilldown.period, count: filteredRows.length })
        : '';
    }
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
      organizationName: currentBranding().displayName,
      branding: { ...currentBranding(), logoUrl: currentBrandLogoUrl() },
      projectUrl: supabase.supabaseUrl,
      formatMoney,
      t,
      language: currentLanguage,
    }));
    printWindow.document.close();
    printWindow.opener = null;
    printWindow.focus();
    window.setTimeout(() => printWindow.print(), 150);
  }

  function printExistingBill(billId) {
    if (pageState.context?.kind !== 'customer') return;
    const bill = pageState.rows?.bills.find((row) => row.id === billId && row.customer_id === pageState.context.customerId);
    const customer = pageState.rows?.customers.find((row) => row.id === pageState.context.customerId);
    if (!bill || !customer) return;
    const summary = summarizeCustomerBill(bill, pageState.rows.receipts, pageState.rows.allocations);
    const printWindow = window.open('', '_blank', 'popup,width=760,height=900');
    if (!printWindow) {
      window.alert(t('Allow the print window to open, then choose Print or Save as PDF.'));
      return;
    }
    printWindow.document.open();
    printWindow.document.write(renderPrintableBillHtml({
      bill,
      customer,
      summary,
      branding: { ...currentBranding(), logoUrl: currentBrandLogoUrl() },
      projectUrl: supabase.supabaseUrl,
      formatMoney,
      t,
      language: currentLanguage,
    }));
    printWindow.document.close();
    printWindow.opener = null;
    printWindow.focus();
    window.setTimeout(() => printWindow.print(), 150);
  }

  function renderCashflowAnalysis() {
    const summary = summarizeCashflow({
      receipts: pageState.rows.receipts,
      expenses: pageState.rows.cashflowExpenses,
      monthCount: pageState.cashflowMonthCount,
      now: new Date(),
    });
    const { totals } = summary;
    const maxValue = Math.max(1, ...summary.months.flatMap((month) => [
      month.incomePaisa,
      month.operatingCostsPaisa,
      month.partnerDistributionsPaisa,
      Math.abs(month.operatingProfitPaisa),
      Math.abs(month.netCashflowPaisa),
    ]));
    const left = 78;
    const right = 876;
    const baseline = 121;
    const amplitude = 82;
    const step = (right - left) / summary.months.length;
    const centers = summary.months.map((month, index) => ({ month, x: left + step * (index + 0.5) }));
    const barSeries = [
      { key: 'incomePaisa', color: 'var(--cashflow-income)', direction: -1, offset: -20 },
      { key: 'operatingCostsPaisa', color: 'var(--cashflow-costs)', direction: 1, offset: -5 },
      { key: 'partnerDistributionsPaisa', color: 'var(--cashflow-distribution)', direction: 1, offset: 10 },
    ];
    const barMarkup = centers.flatMap(({ month, x }) => barSeries.map((series) => {
      const value = month[series.key];
      if (!value) return '';
      const height = Math.max(2, (value / maxValue) * amplitude);
      const y = series.direction < 0 ? baseline - height : baseline;
      return `<rect x="${(x + series.offset - 5).toFixed(2)}" y="${y.toFixed(2)}" width="10" height="${height.toFixed(2)}" rx="3" fill="${series.color}"><title>${escapeHtml(month.label)} · ${escapeHtml(formatMoney(value))}</title></rect>`;
    })).join('');
    const lineMarkup = [
      { key: 'operatingProfitPaisa', color: 'var(--cashflow-profit)', name: t('Operating profit') },
      { key: 'netCashflowPaisa', color: 'var(--cashflow-net)', name: t('Net cashflow after partner distributions') },
    ].map((series) => {
      const points = centers.map(({ month, x }) => `${x.toFixed(2)},${(baseline - (month[series.key] / maxValue) * amplitude).toFixed(2)}`).join(' ');
      const dots = centers.map(({ month, x }) => `<circle cx="${x.toFixed(2)}" cy="${(baseline - (month[series.key] / maxValue) * amplitude).toFixed(2)}" r="3.4" fill="${series.color}"><title>${escapeHtml(series.name)} · ${escapeHtml(month.label)} · ${escapeHtml(formatMoney(month[series.key]))}</title></circle>`).join('');
      return `<polyline points="${points}" fill="none" stroke="${series.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></polyline>${dots}`;
    }).join('');
    const monthLabels = centers.map(({ month, x }) => `<text x="${x.toFixed(2)}" y="232" text-anchor="middle">${escapeHtml(month.label)}</text>`).join('');
    const descriptions = summary.months.map((month) => `${month.label}: ${t('Receipts')} ${formatMoney(month.incomePaisa)}, ${t('Operating costs')} ${formatMoney(month.operatingCostsPaisa)}, ${t('Partner distributions')} ${formatMoney(month.partnerDistributionsPaisa)}, ${t('Operating profit')} ${formatMoney(month.operatingProfitPaisa)}, ${t('Net cashflow after partner distributions')} ${formatMoney(month.netCashflowPaisa)}`).join('; ');
    const metrics = [
      [t('Cash receipts'), totals.incomePaisa, 'cashflow-metric--income'],
      [t('Operating costs'), totals.operatingCostsPaisa, 'cashflow-metric--costs'],
      [t('Operating profit'), totals.operatingProfitPaisa, 'cashflow-metric--profit'],
      [t('Partner distributions'), totals.partnerDistributionsPaisa, 'cashflow-metric--distribution'],
      [t('Net cashflow after partner distributions'), totals.netCashflowPaisa, 'cashflow-metric--net'],
    ].map(([label, amount, modifier]) => `<article class="metric cashflow-metric ${modifier}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(formatMoney(amount))}</strong><small>${escapeHtml(t('PKR · selected period'))}</small></article>`).join('');
    return `<div class="cashflow-analysis-content">
      <div class="cashflow-period-switch" role="group" aria-label="${escapeHtml(t('Cashflow graph period'))}">
        ${[1, 3, 6].map((count) => `<button class="cashflow-period-button ${pageState.cashflowMonthCount === count ? 'is-active' : ''}" type="button" data-cashflow-months="${count}" aria-pressed="${pageState.cashflowMonthCount === count}">${count} ${escapeHtml(t(count === 1 ? 'month' : 'months'))}</button>`).join('')}
      </div>
      <p class="muted">${escapeHtml(t('Income includes posted cash receipts only; issued or unpaid bills and allocations are not income. Operating costs exclude partner distributions.'))}</p>
      <div class="cashflow-summary-grid admin-metrics">${metrics}</div>
      <div class="cashflow-chart-legend" role="list" aria-label="${escapeHtml(t('Cashflow chart legend'))}">
        <span role="listitem"><i class="cashflow-swatch cashflow-swatch--income"></i>${escapeHtml(t('Receipts'))}</span>
        <span role="listitem"><i class="cashflow-swatch cashflow-swatch--costs"></i>${escapeHtml(t('Operating costs'))}</span>
        <span role="listitem"><i class="cashflow-swatch cashflow-swatch--distribution"></i>${escapeHtml(t('Partner distributions'))}</span>
        <span role="listitem"><i class="cashflow-swatch cashflow-swatch--profit"></i>${escapeHtml(t('Operating profit'))}</span>
        <span role="listitem"><i class="cashflow-swatch cashflow-swatch--net"></i>${escapeHtml(t('Net cashflow after partner distributions'))}</span>
      </div>
      <div class="cashflow-chart-wrap"><svg class="cashflow-chart" viewBox="0 0 900 250" role="img" aria-labelledby="cashflow-chart-title cashflow-chart-description">
        <title id="cashflow-chart-title">${escapeHtml(t('Cashflow over selected months'))}</title>
        <desc id="cashflow-chart-description">${escapeHtml(descriptions)}</desc>
        <line x1="58" x2="884" y1="${baseline}" y2="${baseline}" class="cashflow-chart__zero" />
        <text x="4" y="35" class="cashflow-chart__axis">${escapeHtml(formatMoney(maxValue))}</text>
        <text x="4" y="${baseline + 4}" class="cashflow-chart__axis">${escapeHtml(t('Zero'))}</text>
        <text x="4" y="210" class="cashflow-chart__axis">${escapeHtml(formatMoney(-maxValue))}</text>
        ${barMarkup}${lineMarkup}${monthLabels}
      </svg></div>
    </div>`;
  }

  function cashflowExpenseFilterOptions() {
    return {
      search: pageState.cashflowSearch,
      category: pageState.cashflowCategory,
      fromDate: pageState.cashflowFromDate,
      throughDate: pageState.cashflowThroughDate,
    };
  }

  function currentCashflowExpenseRows() {
    return filterCashflowExpenses(pageState.rows?.cashflowExpenses ?? [], cashflowExpenseFilterOptions());
  }

  function renderCashflowExpenseCards(expenses) {
    if (pageState.cashflowFromDate && pageState.cashflowThroughDate && pageState.cashflowFromDate > pageState.cashflowThroughDate) {
      return `<li class="record-card-empty" role="alert">${escapeHtml(t('Choose a start date on or before the end date.'))}</li>`;
    }
    return expenses.slice(0, 100).map((expense) => {
      const category = CASHFLOW_CATEGORIES.find((item) => item.value === expense.category);
      const recordedAt = new Date(expense.created_at);
      const localTime = Number.isNaN(recordedAt.getTime()) ? '' : recordedAt.toLocaleString(currentLanguage === 'ur-Latn' ? 'ur-Latn-PK' : 'en-PK', { dateStyle: 'medium', timeStyle: 'short' });
      const distribution = expense.category === 'partner_profit';
      return `<li><article class="record-card cashflow-expense-card">
        <header class="record-card__top"><div><h3>${escapeHtml(category?.label ?? expense.category)}</h3>${localTime ? `<p class="record-card__subtitle"><time datetime="${escapeHtml(expense.created_at)}">${escapeHtml(localTime)}</time></p>` : ''}</div><span class="status-pill ${distribution ? 'status-pill--partial' : ''}">${escapeHtml(t(distribution ? 'Partner distribution' : 'Operating expense'))}</span></header>
        <dl class="record-card__facts"><div><dt>${escapeHtml(t('Amount (PKR)'))}</dt><dd>${escapeHtml(formatMoney(expense.amount_paisa))}</dd></div>${expense.note ? `<div><dt>${escapeHtml(t('Note'))}</dt><dd>${escapeHtml(expense.note)}</dd></div>` : ''}</dl>
      </article></li>`;
    }).join('') || `<li class="record-card-empty" role="status">${escapeHtml(t('No recorded expenses match these filters.'))}</li>`;
  }

  function cashflowExpenseCountText(rows) {
    if (pageState.cashflowFromDate && pageState.cashflowThroughDate && pageState.cashflowFromDate > pageState.cashflowThroughDate) {
      return t('Expense history is hidden until the date range is corrected.');
    }
    return formatUiMessage('Showing {shown} of {total} matching cash expenses.', currentLanguage, {
      shown: Math.min(rows.length, 100), total: rows.length,
    });
  }

  function updateCashflowExpenseResults(root = portalPanel.querySelector('#admin-cashflow')) {
    if (!root) return;
    const rows = currentCashflowExpenseRows();
    const count = root.querySelector('#cashflow-expense-count');
    const list = root.querySelector('#cashflow-expense-results');
    if (count) count.textContent = cashflowExpenseCountText(rows);
    if (list) list.innerHTML = renderCashflowExpenseCards(rows);
  }

  function renderAdmin() {
    const context = pageState.context;
    const rows = pageState.rows;
    const dashboardToday = localDate();
    const totals = calculateDashboard({
      month: pageState.selectedMonth,
      today: dashboardToday,
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
    const billDrilldown = pageState.dashboardDrilldown?.target === 'admin-bills' ? pageState.dashboardDrilldown : null;
    const scopedAdminBillRows = filterCollectionBillRows(adminBillRows, {
      scope: billDrilldown?.scope ?? '',
      period: billDrilldown?.period ?? '',
    });
    const billCounts = countAdminBillFilters(scopedAdminBillRows, { search: pageState.billSearch });
    const filteredAdminBillRows = filterAdminBillRows(scopedAdminBillRows, { search: pageState.billSearch, status: pageState.billStatus });
    const customerListRows = buildCustomerListRows({
      customers,
      bills: rows.bills,
      allocations: rows.allocations,
      privateDetails: rows.privateCustomerDetails,
      currentMonth: localMonth(),
    });
    const customerSummary = summarizeCustomerRows(customerListRows);
    const customerDrilldown = pageState.dashboardDrilldown?.target === 'customer-list' ? pageState.dashboardDrilldown : null;
    const scopedCustomerListRows = customerDrilldown
      ? filterCustomersWithoutBillSnapshot(customerListRows, rows.bills, customerDrilldown.period)
      : customerListRows;
    const filteredCustomerRows = filterCustomerRows(scopedCustomerListRows, {
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
    const pppoeCustomerOptions = inviteCustomers.map((customer) => `<option value="${escapeHtml(customer.id)}" data-pppoe-username="${escapeHtml(customer.pppoe_username ?? '')}">#${customer.customer_number} · ${escapeHtml(customer.name)}</option>`).join('');
    const initialPppoeUsername = inviteCustomers[0]?.pppoe_username ?? '';
    const pppoeMappingPanel = rows.pppoeMappingAvailable === true
      ? `<section class="panel pppoe-link-panel" aria-labelledby="pppoe-link-title"><p class="eyebrow">${escapeHtml(t('Service username mapping'))}</p><h2 id="pppoe-link-title">${escapeHtml(t('Link existing PPPoE username'))}</h2><p class="muted">${escapeHtml(t('Link an existing PPPoE username to a named cloud customer for usage matching only. This does not create a network account or change Overtake, RADIUS, or RouterOS. Never enter a PPPoE password here.'))}</p><form id="pppoe-link-form" class="stack"><label for="pppoe-link-customer">${escapeHtml(t('Existing customer'))}</label><select id="pppoe-link-customer" name="customer_id" required ${inviteCustomers.length ? '' : 'disabled'}>${pppoeCustomerOptions || `<option value="">${escapeHtml(t('No active customers available'))}</option>`}</select><label for="pppoe-link-username">${escapeHtml(t('Existing PPPoE username'))}</label><input id="pppoe-link-username" name="username" type="text" value="${escapeHtml(initialPppoeUsername)}" maxlength="255" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="pppoe-link-help" required ${inviteCustomers.length ? '' : 'disabled'}><p class="muted" id="pppoe-link-help">${escapeHtml(t('This links the cloud customer record only; the network username and password remain managed by Overtake/RADIUS.'))}</p><div class="form-actions"><button class="button primary" type="submit" ${inviteCustomers.length ? '' : 'disabled'}>${escapeHtml(t('Save PPPoE link'))}</button><button class="button secondary" id="remove-pppoe-link" type="button" ${initialPppoeUsername ? '' : 'disabled'}>${escapeHtml(t('Remove PPPoE link'))}</button></div></form><p class="form-message" id="pppoe-link-message" role="status" aria-live="polite" aria-atomic="true"></p></section>`
      : `<section class="panel pppoe-link-panel" aria-labelledby="pppoe-link-title"><p class="eyebrow">${escapeHtml(t('Service username mapping'))}</p><h2 id="pppoe-link-title">${escapeHtml(t('Link existing PPPoE username'))}</h2><p class="usage-state" role="status">${escapeHtml(t('The customers.pppoe_username field is not available in this project yet. Ask the project administrator to review and apply the existing bandwidth-usage migration before linking usernames. No mapping or network credential was changed.'))}</p></section>`;
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
      ${brandingSettingsHtml()}
      ${renderDashboardMetrics({ month: pageState.selectedMonth, today: dashboardToday, totals, t })}
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
          ${portalTestModeAvailable ? `<p class="muted">${escapeHtml(t('Internal staging test accounts can use their saved PPPoE username without an email invitation. Mark only synthetic test accounts in the customer profile; first sign-in still requires a password change.'))}</p>` : ''}
          <form id="invite-form" class="stack">
            <label for="invite-customer">${escapeHtml(t('Existing customer'))}</label><select id="invite-customer" name="customer_id" required ${inviteCustomers.length ? '' : 'disabled'}>${inviteCustomerOptions || `<option value="">${escapeHtml(t('No active customers available'))}</option>`}</select>
            <label for="invite-email">${escapeHtml(t('Email address'))}</label><input id="invite-email" name="email" type="email" inputmode="email" autocomplete="email" enterkeyhint="go" maxlength="254" required ${inviteCustomers.length ? '' : 'disabled'}>
            <button class="button primary" type="submit" ${inviteCustomers.length ? '' : 'disabled'}>${escapeHtml(t('Request invitation'))}</button>
          </form><p class="form-message" id="invite-message" role="status" aria-live="polite">${inviteCustomers.length ? '' : escapeHtml(t('Add an active customer before requesting an invitation.'))}</p>
          <p class="muted">${escapeHtml(t('Customer-to-account links remain server-managed and cannot be written from the browser. If a result is uncertain, use the same customer and email to recover; unresolved account states stop for administrator review.'))}</p>
        </section>
        ${pppoeMappingPanel}
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
      <section id="admin-cashflow" class="panel data-panel cashflow-panel" data-feature-toggle data-feature-key="admin-cashflow" data-feature-name="${escapeHtml(t('Cashflow and expense tracking'))}" aria-labelledby="admin-cashflow-title">
        <div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Owner / Admin only'))}</p><h2 id="admin-cashflow-title">${escapeHtml(t('Cashflow and expense tracking'))}</h2></div></div>
        <p class="muted">${escapeHtml(t('All amounts are PKR. These cash-basis estimates use posted receipts and recorded cash expenses; they are not formal accrual accounts.'))}</p>
        <div id="cashflow-analysis">${renderCashflowAnalysis()}</div>
        <div class="cashflow-workspace">
          <section class="cashflow-entry-panel" aria-labelledby="cashflow-entry-title">
            <h3 id="cashflow-entry-title">${escapeHtml(t('Record a cash expense'))}</h3>
            <form id="cashflow-expense-form" class="stack">
              <label for="cashflow-expense-category">${escapeHtml(t('Expense category'))}<select id="cashflow-expense-category" name="category" required>${CASHFLOW_CATEGORIES.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(t(item.label))}</option>`).join('')}</select></label>
              <label for="cashflow-expense-amount">${escapeHtml(t('Amount (PKR)'))}<input id="cashflow-expense-amount" name="amount" inputmode="decimal" placeholder="0.00" required></label>
              <label for="cashflow-expense-note">${escapeHtml(t('Optional note'))}<textarea id="cashflow-expense-note" name="note" maxlength="1000" rows="3"></textarea></label>
              <p class="muted">${escapeHtml(t('Server-recorded time is UTC and shown in your local time zone.'))}</p>
              <button class="button primary" type="submit">${escapeHtml(t('Save cash expense'))}</button>
            </form>
            <p id="cashflow-expense-message" class="form-message" role="status" aria-live="polite" aria-atomic="true"></p>
          </section>
          <section class="cashflow-history-panel" aria-labelledby="cashflow-history-title">
            <h3 id="cashflow-history-title">${escapeHtml(t('Searchable expense history'))}</h3>
            <div class="cashflow-history-filters">
              <label for="cashflow-expense-search">${escapeHtml(t('Search category, note, or amount'))}<input id="cashflow-expense-search" type="search" autocomplete="off" value="${escapeHtml(pageState.cashflowSearch)}"></label>
              <label for="cashflow-expense-filter-category">${escapeHtml(t('Category'))}<select id="cashflow-expense-filter-category"><option value="all">${escapeHtml(t('All categories'))}</option>${CASHFLOW_CATEGORIES.map((item) => `<option value="${escapeHtml(item.value)}" ${pageState.cashflowCategory === item.value ? 'selected' : ''}>${escapeHtml(t(item.label))}</option>`).join('')}</select></label>
              <label for="cashflow-expense-from">${escapeHtml(t('From date'))}<input id="cashflow-expense-from" type="date" value="${escapeHtml(pageState.cashflowFromDate)}"></label>
              <label for="cashflow-expense-through">${escapeHtml(t('Through date'))}<input id="cashflow-expense-through" type="date" value="${escapeHtml(pageState.cashflowThroughDate)}"></label>
            </div>
            <p id="cashflow-expense-count" class="customer-history-count" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(cashflowExpenseCountText(currentCashflowExpenseRows()))}</p>
            <ul id="cashflow-expense-results" class="record-card-grid cashflow-expense-list" aria-label="${escapeHtml(t('Cash expense history'))}">${renderCashflowExpenseCards(currentCashflowExpenseRows())}</ul>
          </section>
        </div>
      </section>
      <section id="customer-list" class="panel data-panel customer-list-panel" aria-labelledby="customer-list-title">
        <div class="customer-list-heading"><div><p class="eyebrow">${escapeHtml(t('Customer directory'))}</p><h2 id="customer-list-title" tabindex="-1">${escapeHtml(t('Customers'))}</h2></div>
          <div class="customer-summary" aria-label="${escapeHtml(t('Customer count, active count, and unpaid count'))}"><span><strong>${customerSummary.total}</strong><small>${escapeHtml(t('Total'))}</small></span><span><strong>${customerSummary.active}</strong><small>${escapeHtml(t('Active'))}</small></span><span><strong>${customerSummary.unpaid}</strong><small>${escapeHtml(t('Unpaid'))}</small></span></div>
        </div>
        <div class="customer-list-search"><label class="sr-only" for="customer-search">${escapeHtml(t('Search customers by name, phone, or Account number'))}</label><input id="customer-search" type="search" autocomplete="off" value="${escapeHtml(pageState.customerListSearch)}" placeholder="${escapeHtml(t('Search name, phone, or Account #'))}"><p class="muted">${escapeHtml(t('Customer portal username is separate from the customer number. Area choices use the saved service address.'))}</p></div>
        <div class="customer-list-filters" role="group" aria-label="${escapeHtml(t('Filter customers by payment status or area'))}">
          <button class="customer-filter-pill ${pageState.customerListStatus === 'all' ? 'is-active' : ''}" type="button" data-billing-filter="all" aria-pressed="${pageState.customerListStatus === 'all'}">${escapeHtml(t('All'))}</button>
          <button class="customer-filter-pill ${pageState.customerListStatus === 'paid' ? 'is-active' : ''}" type="button" data-billing-filter="paid" aria-pressed="${pageState.customerListStatus === 'paid'}">${escapeHtml(t('Paid'))}</button>
          <button class="customer-filter-pill ${pageState.customerListStatus === 'unpaid' ? 'is-active' : ''}" type="button" data-billing-filter="unpaid" aria-pressed="${pageState.customerListStatus === 'unpaid'}">${escapeHtml(t('Unpaid'))}</button>
          <button class="customer-filter-pill ${pageState.customerListArea ? 'is-active' : ''}" type="button" data-action="toggle-area-filter" aria-expanded="${pageState.customerAreaOpen}" aria-pressed="${Boolean(pageState.customerListArea)}">${escapeHtml(t('Area'))}</button>
          <label class="sr-only" for="customer-area-filter">${escapeHtml(t('Filter by saved service address'))}</label><select id="customer-area-filter" aria-label="${escapeHtml(t('Filter by saved service address'))}" ${pageState.customerAreaOpen ? '' : 'hidden'}><option value="" disabled ${pageState.customerListArea ? '' : 'selected'}>${escapeHtml(t('Choose an area / address'))}</option>${customerAreaOptions}</select>
        </div>
        <div id="customer-list-drilldown-summary" class="filter-summary" ${customerDrilldown ? '' : 'hidden'}><p id="customer-list-drilldown-message" role="status" aria-live="polite" aria-atomic="true">${customerDrilldown ? formatUiMessage('Showing active customers without a bill snapshot for {period}. {count} customers match.', currentLanguage, { period: customerDrilldown.period, count: scopedCustomerListRows.length }) : ''}</p><button class="button secondary small" type="button" data-action="clear-dashboard-drilldown" data-target="customer-list">${escapeHtml(t('Clear dashboard filter'))}</button></div>
        <p id="customer-list-count" class="customer-list-count" role="status" aria-live="${customerDrilldown ? 'off' : 'polite'}">${formatUiMessage('Showing {shown} of {total} customers.', currentLanguage, { shown: filteredCustomerRows.length, total: scopedCustomerListRows.length })}</p>
        <div id="customer-card-grid" class="customer-card-grid">${customerSummary.total ? renderCustomerCards(filteredCustomerRows, formatMoney, t) : `<p class="customer-list-empty" role="status">${escapeHtml(t('No customer records yet.'))}</p>`}</div>
        <dialog id="customer-profile-dialog" class="edit-dialog customer-profile-dialog" aria-labelledby="customer-profile-title"><div id="customer-profile-content"></div></dialog>
      </section>
      <button class="customer-fab" type="button" data-action="open-add-customer" aria-label="${escapeHtml(t('Add customer'))}" title="${escapeHtml(t('Add customer'))}"><span aria-hidden="true">+</span></button>
      <section id="admin-bills" class="panel data-panel admin-bills-panel" aria-labelledby="admin-bills-title"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Monthly snapshots'))}</p><h2 id="admin-bills-title" tabindex="-1">${escapeHtml(t('Bills'))}</h2></div><span class="muted">${bills.length} ${escapeHtml(t('records'))}</span></div>
        <div class="bill-list-search"><label for="admin-bill-search">${escapeHtml(t('Search bills by customer name or Admin phone'))}</label><input id="admin-bill-search" type="search" autocomplete="off" value="${escapeHtml(pageState.billSearch)}" placeholder="${escapeHtml(t('Search customer name or phone'))}"><p class="muted">${escapeHtml(t('Phone lookup uses only the Admin-authorized private phone record.'))}</p></div>
        <div class="bill-list-filters" role="group" aria-label="${escapeHtml(t('Filter bills by payment status'))}">
          <button class="bill-filter-pill ${pageState.billStatus === 'all' ? 'is-active' : ''}" type="button" data-bill-status="all" aria-pressed="${pageState.billStatus === 'all'}">${escapeHtml(t('All'))} (${billCounts.all})</button>
          <button class="bill-filter-pill ${pageState.billStatus === 'unpaid' ? 'is-active' : ''}" type="button" data-bill-status="unpaid" aria-pressed="${pageState.billStatus === 'unpaid'}">${escapeHtml(t('Unpaid'))} (${billCounts.unpaid})</button>
          <button class="bill-filter-pill ${pageState.billStatus === 'paid' ? 'is-active' : ''}" type="button" data-bill-status="paid" aria-pressed="${pageState.billStatus === 'paid'}">${escapeHtml(t('Paid'))} (${billCounts.paid})</button>
        </div>
        <div id="admin-bill-drilldown-summary" class="filter-summary" ${billDrilldown ? '' : 'hidden'}><p id="admin-bill-drilldown-message" role="status" aria-live="polite" aria-atomic="true">${billDrilldown ? formatUiMessage(billDrilldown.scope === 'overdue' ? 'Showing overdue bills for {period}. {count} bills match. Past-due means an explicitly recorded due date before today and a positive remaining balance.' : 'Showing unpriced bills for {period}. {count} bills match. No bill amount is treated as zero.', currentLanguage, { period: billDrilldown.period, count: filteredAdminBillRows.length }) : ''}</p><button class="button secondary small" type="button" data-action="clear-dashboard-drilldown" data-target="admin-bills">${escapeHtml(t('Clear dashboard filter'))}</button></div>
        <p id="admin-bill-count" class="bill-list-count" role="status" aria-live="${billDrilldown ? 'off' : 'polite'}">${formatUiMessage('Showing {shown} of {matching} matching bills; {total} total records.', currentLanguage, { shown: Math.min(filteredAdminBillRows.length, 100), matching: filteredAdminBillRows.length, total: adminBillRows.length })}</p>
        <div id="admin-bill-card-grid" class="bill-card-grid">${renderAdminBillCards(filteredAdminBillRows, formatMoney, t)}</div>
        <p class="muted">${escapeHtml(t('Summary cards above use the selected dashboard month: billed and pending follow bill periods, while collected follows actual receipt dates. Carry-forward credit reduces pending balances but is never counted as cash. WhatsApp opens a draft only; receipts can be printed only from existing receipt records.'))}</p>
      </section>
      <section id="admin-receipts" class="panel data-panel"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Dated cash entries'))}</p><h2>${escapeHtml(t('Receipts'))}</h2></div><span class="muted">${receipts.length} ${escapeHtml(t('actual receipts'))}</span></div>
        <ul class="record-card-grid admin-receipt-card-grid" aria-label="${escapeHtml(t('Actual receipts'))}">${receipts.slice(0, 100).map((receipt) => {
          const receiptId = escapeHtml(receipt.id);
          const receiptDate = escapeHtml(receipt.received_on);
          const receiptCustomer = escapeHtml(customerName(receipt.customer_id));
          return `<li><article class="record-card receipt-record-card">
            <header class="record-card__top"><div><h3>${receiptCustomer}</h3><p class="record-card__subtitle"><time datetime="${receiptDate}">${receiptDate}</time></p></div></header>
            <dl class="record-card__facts"><div><dt>${escapeHtml(t('Method'))}</dt><dd>${escapeHtml(receipt.method || t('Method not recorded'))}</dd></div><div><dt>${escapeHtml(t('Amount'))}</dt><dd>${escapeHtml(formatMoney(receipt.amount_cents))}</dd></div></dl>
            <div class="record-card__actions" role="group" aria-label="${escapeHtml(t('Actions'))}"><button class="text-button" type="button" data-action="edit-receipt" data-id="${receiptId}" aria-label="${escapeHtml(t('Edit receipt for'))} ${receiptCustomer}, ${escapeHtml(t('dated'))} ${receiptDate}">${escapeHtml(t('Edit'))}</button><button class="text-button danger" type="button" data-action="delete-receipt" data-id="${receiptId}" aria-label="${escapeHtml(t('Delete receipt for'))} ${receiptCustomer}, ${escapeHtml(t('dated'))} ${receiptDate}">${escapeHtml(t('Delete'))}</button></div>
          </article></li>`;
        }).join('') || `<li class="record-card-empty" role="status">${escapeHtml(t('No receipts recorded yet.'))}</li>`}</ul>
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
      if (pageState.dashboardDrilldown) {
        pageState.dashboardDrilldown = null;
        history.replaceState({ ...(history.state ?? {}), dashboardDrilldown: null }, '', '#admin-overview');
      }
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
    bindAdminCashflowActions(context);
    bindPppoeMappingActions(context);
    bindBrandingActions(context);
    bindAdminIncidentForms(context);
    bindAdminActions(context);
    bindAdminBillActions(context);
    bindDashboardDrilldowns(context);
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
        if (typeof payload?.error === 'string' && payload.error.length <= 500) return t(payload.error);
      }
    } catch { /* Use the safe fallback for network and non-JSON errors. */ }
    return 'The invitation result could not be confirmed. Submit the same customer and email again to recover safely; no second invitation will be sent.';
  }

  function bindPppoeMappingActions(context) {
    if (context.kind !== 'admin' || pageState.rows?.pppoeMappingAvailable !== true) return;
    const form = portalPanel.querySelector('#pppoe-link-form');
    if (!form) return;
    const customerSelect = form.elements.customer_id;
    const usernameInput = form.elements.username;
    const saveButton = form.querySelector('button[type="submit"]');
    const removeButton = form.querySelector('#remove-pppoe-link');
    const message = portalPanel.querySelector('#pppoe-link-message');

    customerSelect.addEventListener('change', () => {
      usernameInput.value = customerSelect.selectedOptions[0]?.dataset.pppoeUsername ?? '';
      removeButton.disabled = !usernameInput.value;
      setMessage(message, '', false);
    });

    const saveMapping = async (username) => {
      const customerId = String(customerSelect.value ?? '');
      if (!customerId) return;
      saveButton.disabled = true;
      removeButton.disabled = true;
      setMessage(message, 'Updating PPPoE mapping…');
      try {
        await saveCustomerPppoeUsername(supabase, {
          organizationId: context.organizationId,
          customerId,
          username,
        });
        const announcement = username === null
          ? 'Existing PPPoE username link removed.'
          : 'Existing PPPoE username link saved.';
        await refreshCurrentContext(announcement);
        showAppToast(announcement);
        const refreshedForm = portalPanel.querySelector('#pppoe-link-form');
        if (refreshedForm) {
          refreshedForm.elements.customer_id.value = customerId;
          refreshedForm.elements.username.value = username ?? '';
          const refreshedRemoveButton = refreshedForm.querySelector('#remove-pppoe-link');
          if (refreshedRemoveButton) refreshedRemoveButton.disabled = username === null;
          setMessage(portalPanel.querySelector('#pppoe-link-message'), announcement, false);
        }
      } catch (error) {
        const errorMessage = error?.code === '23505'
          ? 'This PPPoE username is already linked to another customer.'
          : error?.code === '23514' && /Disable staging test access/i.test(String(error?.message ?? ''))
            ? 'Disable staging test access before changing the PPPoE username.'
          : error?.code === '42501'
            ? 'Only organization administrators can update a PPPoE mapping.'
            : 'PPPoE username link could not be saved. Ask the project administrator to verify the mapping schema and your Admin access.';
        setMessage(portalPanel.querySelector('#pppoe-link-message') ?? message, errorMessage, true);
      } finally {
        const currentForm = portalPanel.querySelector('#pppoe-link-form');
        if (currentForm) {
          currentForm.querySelector('button[type="submit"]').disabled = !currentForm.elements.customer_id.value;
          const selected = currentForm.elements.customer_id.selectedOptions[0];
          currentForm.querySelector('#remove-pppoe-link').disabled = !selected?.dataset.pppoeUsername;
        }
      }
    };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const username = String(usernameInput.value ?? '').trim();
      if (!username) {
        setMessage(message, 'Enter an existing PPPoE username or use Remove PPPoE link.', true);
        return;
      }
      await saveMapping(username);
    });

    removeButton.addEventListener('click', async () => {
      if (!customerSelect.selectedOptions[0]?.dataset.pppoeUsername) return;
      if (!window.confirm(t('Remove the PPPoE link for this customer? Usage matching will stop until a new link is saved.'))) return;
      await saveMapping(null);
    });
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

  function bindBrandingActions(context) {
    if (context.role !== 'owner') return;
    const form = portalPanel.querySelector('#brand-profile-form');
    if (!form) return;

    const saveProfile = async ({ displayName, supportPhone, address, file = null, removeLogo = false }) => {
      const previousPath = pageState.rows?.branding?.logo_path ?? null;
      let nextPath = removeLogo ? null : previousPath;
      let uploadedPath = null;
      const cleanup = async (path) => {
        if (!isSafeBrandLogoPath(context.organizationId, path)) return;
        const { error } = await supabase.storage.from(BRANDING_BUCKET).remove([path]);
        if (error) throw error;
      };
      if (file) {
        const image = await validateBrandLogoFile(file);
        uploadedPath = buildBrandLogoPath(context.organizationId, image.type);
        const { error } = await supabase.storage.from(BRANDING_BUCKET).upload(uploadedPath, file, {
          cacheControl: '3600',
          contentType: image.type,
          upsert: false,
        });
        if (error) throw error;
        nextPath = uploadedPath;
      }

      try {
        await invokeRpc(supabase, 'save_organization_branding', {
          p_organization_id: context.organizationId,
          p_display_name: displayName,
          p_logo_path: nextPath,
          p_support_phone: supportPhone,
          p_address: address,
        });
      } catch (error) {
        if (uploadedPath) {
          try { await cleanup(uploadedPath); } catch { /* Keep the database's previous logo reference intact. */ }
        }
        throw error;
      }

      const localBranding = {
        organization_id: context.organizationId,
        display_name: displayName,
        logo_path: nextPath,
        support_phone: supportPhone,
        address,
      };
      let warning = '';
      try {
        pageState.rows.branding = await loadOrganizationBranding(supabase, context.organizationId) ?? localBranding;
      } catch {
        pageState.rows.branding = localBranding;
        warning = 'Company profile saved, but it could not be refreshed from the database.';
      }
      if (previousPath && previousPath !== nextPath) {
        try { await cleanup(previousPath); } catch { warning = 'Company profile saved, but the previous logo could not be removed.'; }
      }
      renderPortal();
      setMessage(portalPanel.querySelector('#brand-profile-message'), warning || (removeLogo ? 'Company logo removed.' : 'Company profile saved.'));
    };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submitButton = form.querySelector('button[type="submit"]');
      const file = form.elements.logo.files?.[0] ?? null;
      const displayName = String(form.elements.display_name.value ?? '').trim();
      const supportPhone = String(form.elements.support_phone.value ?? '').trim();
      const address = String(form.elements.address.value ?? '').trim();
      const message = portalPanel.querySelector('#brand-profile-message');
      if (!displayName || displayName.length > 120 || supportPhone.length > 40 || address.length > 300) {
        setMessage(message, 'Check the company name, support phone, and address lengths.', true);
        return;
      }
      submitButton.disabled = true;
      setMessage(message, 'Saving company profile…');
      try {
        await saveProfile({ displayName, supportPhone, address, file });
      } catch (error) {
        setMessage(portalPanel.querySelector('#brand-profile-message'), error.message || 'Company profile could not be saved.', true);
      } finally {
        submitButton.disabled = false;
      }
    });

    portalPanel.querySelector('[data-action="remove-brand-logo"]')?.addEventListener('click', async () => {
      if (!window.confirm(t('Remove the company logo?'))) return;
      const branding = currentBranding();
      const button = portalPanel.querySelector('[data-action="remove-brand-logo"]');
      button.disabled = true;
      setMessage(portalPanel.querySelector('#brand-profile-message'), 'Saving company profile…');
      try {
        await saveProfile({
          displayName: branding.displayName,
          supportPhone: branding.supportPhone,
          address: branding.address,
          removeLogo: true,
        });
      } catch (error) {
        setMessage(portalPanel.querySelector('#brand-profile-message'), error.message || 'Company profile could not be saved.', true);
        button.disabled = false;
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

  function bindAdminCashflowActions(context) {
    if (context.kind !== 'admin') return;
    const root = portalPanel.querySelector('#admin-cashflow');
    if (!root) return;

    root.addEventListener('input', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.id === 'cashflow-expense-search') {
        pageState.cashflowSearch = target.value;
        updateCashflowExpenseResults(root);
      }
    });
    root.addEventListener('change', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.id === 'cashflow-expense-filter-category') pageState.cashflowCategory = target.value || 'all';
      if (target.id === 'cashflow-expense-from') pageState.cashflowFromDate = target.value;
      if (target.id === 'cashflow-expense-through') pageState.cashflowThroughDate = target.value;
      if (target.id.startsWith('cashflow-expense-')) updateCashflowExpenseResults(root);
    });
    root.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-cashflow-months]') : null;
      if (!target) return;
      const count = Number(target.dataset.cashflowMonths);
      if (![1, 3, 6].includes(count)) return;
      pageState.cashflowMonthCount = count;
      const analysis = root.querySelector('#cashflow-analysis');
      if (analysis) analysis.innerHTML = renderCashflowAnalysis();
    });

    root.querySelector('#cashflow-expense-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submitButton = form.querySelector('button[type="submit"]');
      const message = root.querySelector('#cashflow-expense-message');
      if (context.kind !== 'admin' || !['owner', 'admin'].includes(context.role)) {
        setMessage(message, 'Only same-organization Owners and Admins can record cashflow.', true);
        return;
      }
      const formData = new FormData(form);
      const category = String(formData.get('category') ?? '');
      const note = String(formData.get('note') ?? '').trim();
      try {
        if (!CASHFLOW_CATEGORIES.some((item) => item.value === category)) throw new Error(t('Choose a valid expense category.'));
        const amountPaisa = amountToMinorUnits(formData.get('amount'));
        if (note.length > 1000) throw new Error(t('The expense note is too long.'));
        submitButton.disabled = true;
        setMessage(message, 'Recording cash expense…');
        const entryId = getFinancialAttemptId('cashflow-expense', context);
        await invokeRpc(supabase, 'record_cash_expense', {
          p_organization_id: context.organizationId,
          p_entry_id: entryId,
          p_category: category,
          p_amount_paisa: amountPaisa,
          p_note: note || null,
        });
        clearFinancialAttempt('cashflow-expense', context);
        form.reset();
        await refreshCurrentContext('Cash expense recorded.');
      } catch (error) {
        const messageText = error?.code === '23505'
          ? 'This request ID was already used for different expense details. Check the history and retry with the original category, amount, and note; no second entry was created.'
          : error?.code === '42501'
            ? 'Only same-organization Owners and Admins can record cashflow.'
            : error?.message || 'Cash expense could not be confirmed. Retry the same category, amount, and note to avoid a duplicate.';
        setMessage(root.querySelector('#cashflow-expense-message'), messageText, true);
      } finally {
        if (submitButton?.isConnected) submitButton.disabled = false;
      }
    });
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
      const clearFilter = target.closest('[data-action="clear-dashboard-drilldown"]');
      if (clearFilter) {
        clearDashboardDrilldown(clearFilter.dataset.target);
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
      const clearFilter = target.closest('[data-action="clear-dashboard-drilldown"]');
      if (clearFilter) {
        clearDashboardDrilldown(clearFilter.dataset.target);
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
      const printButton = `<button class="text-button" type="button" data-action="print-bill" data-id="${escapeHtml(bill.id)}" aria-label="${escapeHtml(t('Print or save PDF of this bill'))} ${escapeHtml(String(bill.period ?? '').slice(0, 7))}">${escapeHtml(t('Print bill'))}</button>`;
      return `<li><article class="record-card customer-billing-card">
        <header class="record-card__top"><div><h4>${escapeHtml(formatBillingMonth(String(bill.period ?? '').slice(0, 7), 'en-PK', t))}</h4><p class="record-card__subtitle">${planLabel}</p></div><span class="status-pill status-pill--${escapeHtml(summary.status)}">${escapeHtml(statusLabel)}</span></header>
        <dl class="record-card__facts"><div><dt>${escapeHtml(t('Bill amount'))}</dt><dd>${escapeHtml(formatMoney(bill.amount_due_cents))}${priceNote}</dd></div><div><dt>${escapeHtml(t('Cash receipts linked to bill'))}</dt><dd>${escapeHtml(formatMoney(summary.receiptCashCents))}</dd></div><div><dt>${escapeHtml(t('Credit applied'))}</dt><dd>${escapeHtml(formatMoney(summary.creditAppliedCents))}</dd></div><div><dt>${escapeHtml(t('Balance'))}</dt><dd>${escapeHtml(formatMoney(summary.balanceCents))}</dd></div></dl>
        <div class="record-card__actions" role="group" aria-label="${escapeHtml(t('Actions'))}">${printButton}</div>
      </article></li>`;
    }).join('');
    const receiptRows = view.receipts.map((receipt) => {
      const originPeriod = periodByBillId.get(receipt.origin_bill_id);
      const originMonth = originPeriod
        ? formatBillingMonth(String(originPeriod).slice(0, 7), 'en-PK', t)
        : t('Bill month not available');
      const receiptDate = escapeHtml(receipt.received_on);
      return `<li><article class="record-card customer-billing-card">
        <header class="record-card__top"><div><h4><time datetime="${receiptDate}">${receiptDate}</time></h4></div></header>
        <dl class="record-card__facts"><div><dt>${escapeHtml(t('Method'))}</dt><dd>${escapeHtml(receipt.method || t('Method not recorded'))}</dd></div><div><dt>${escapeHtml(t('Origin bill month'))}</dt><dd>${escapeHtml(originMonth)}</dd></div><div><dt>${escapeHtml(t('Amount received'))}</dt><dd>${escapeHtml(formatMoney(receipt.amount_cents))}</dd></div></dl>
      </article></li>`;
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
        <ul class="record-card-grid customer-billing-card-grid" aria-label="${escapeHtml(t('Bills'))}">${billRows || `<li class="record-card-empty" role="status">${escapeHtml(billEmpty)}</li>`}</ul>
        <p class="muted">${escapeHtml(t('Bill balances use the complete allocation history. Actual receipts are counted once; carry-forward credit is separate. A bill without a recorded price has no calculated balance.'))}</p>
      </section>
      <section class="customer-history-block" aria-labelledby="customer-receipts-title"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(t('Actual cash entries'))}</p><h3 id="customer-receipts-title">${escapeHtml(t('Receipts'))}</h3></div><span class="muted">${view.receipts.length} ${escapeHtml(t('shown'))}</span></div>
        <ul class="record-card-grid customer-billing-card-grid" aria-label="${escapeHtml(t('Receipts'))}">${receiptRows || `<li class="record-card-empty" role="status">${escapeHtml(receiptEmpty)}</li>`}</ul>
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
      ${customerProviderCardHtml()}
      <section id="customer-account" class="profile-card panel" aria-label="${escapeHtml(t('Customer profile'))}">
        <div class="profile-card__identity"><p class="eyebrow">${escapeHtml(t('Your account'))}</p><h2>${escapeHtml(customer.name)}</h2><p class="profile-card__number">${escapeHtml(t('Customer'))} #${escapeHtml(customer.customer_number)}</p></div>
        <div class="profile-card__details"><div class="profile-field"><span>${escapeHtml(t('Plan'))}</span><strong>${escapeHtml(customer.plan_name || t('Plan not set'))}</strong></div><div class="profile-field"><span>${escapeHtml(t('Monthly fee'))}</span><strong>${formatMoney(customer.monthly_fee_cents)}</strong></div><div class="profile-field profile-field--wide"><span>${escapeHtml(t('Service address'))}</span><strong>${escapeHtml(customer.service_address || t('Service address not recorded'))}</strong></div></div>
        <div class="profile-card__status"><span class="status-pill">${escapeHtml(customer.archived ? t('Archived') : ({ active: t('Active'), offline: t('Offline'), 'not-set': t('Not set') }[customer.service_status] ?? customer.service_status ?? t('Not set')))}</span><p>${escapeHtml(t('Service status'))}</p></div>
      </section>
      ${renderCustomerUsageDashboard({ customer, usageRows: rows.customerBandwidthUsage ?? [], error: Boolean(rows.customerBandwidthUsageError), expiryDate: null, t, locale: currentLanguage === 'ur-Latn' ? 'ur-Latn-PK' : 'en-PK' })}
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
    portalPanel.querySelector('#customer-billing-results')?.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-action="print-bill"]') : null;
      if (target) printExistingBill(target.dataset.id);
    });
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
    showPortalLoading(pageState.context.kind === 'customer');
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

  function syncDashboardDrilldownFromHistory() {
    const route = parseDashboardDrilldownHash(window.location.hash);
    const monthChanged = Boolean(route && route.period !== pageState.selectedMonth);
    applyDashboardDrilldown(route);
    if (monthChanged && pageState.context?.kind === 'admin' && pageState.rows) {
      renderPortal();
      if (pageState.dashboardDrilldown) focusDashboardDrilldown(pageState.dashboardDrilldown);
    }
  }

  window.addEventListener('hashchange', syncDashboardDrilldownFromHistory);
  window.addEventListener('popstate', syncDashboardDrilldownFromHistory);

  customerLoginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = customerLoginForm.querySelector('button[type="submit"]');
    const username = String(new FormData(customerLoginForm).get('username') ?? '').trim();
    const passwordInput = customerLoginForm.elements.password;
    const password = String(passwordInput.value ?? '');
    submitButton.disabled = true;
    setMessage(customerLoginMessage, 'Signing in…');
    try {
      const { data, error } = await supabase.functions.invoke('customer-login', {
        body: { username, password },
      });
      if (error || !data?.session?.access_token || !data?.session?.refresh_token) {
        setMessage(customerLoginMessage, 'Username or password is incorrect or unavailable.', true);
        return;
      }
      const { error: sessionError } = await supabase.auth.setSession(data.session);
      if (sessionError) {
        await supabase.auth.signOut();
        setMessage(customerLoginMessage, 'Username or password is incorrect or unavailable.', true);
      }
    } catch {
      setMessage(customerLoginMessage, 'Username or password is incorrect or unavailable.', true);
    } finally {
      passwordInput.value = '';
      submitButton.disabled = false;
    }
  });

  emailPasswordLoginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = emailPasswordLoginForm.querySelector('button[type="submit"]');
    const email = String(new FormData(emailPasswordLoginForm).get('email') ?? '').trim();
    const passwordInput = emailPasswordLoginForm.elements.password;
    const password = String(passwordInput.value ?? '');
    submitButton.disabled = true;
    setMessage(emailPasswordLoginMessage, 'Signing in…');
    try {
      const { error } = await signInWithEmailPassword(supabase.auth, email, password);
      if (error) setMessage(emailPasswordLoginMessage, 'Email or password is incorrect or unavailable.', true);
    } catch {
      setMessage(emailPasswordLoginMessage, 'Email or password is incorrect or unavailable.', true);
    } finally {
      passwordInput.value = '';
      submitButton.disabled = false;
    }
  });

  requestPasswordRecoveryButton?.addEventListener('click', async () => {
    const emailInput = emailPasswordLoginForm.elements.email;
    if (!emailInput.checkValidity()) {
      emailInput.reportValidity();
      return;
    }
    requestPasswordRecoveryButton.disabled = true;
    setMessage(emailPasswordLoginMessage, 'Sending a recovery email…');
    try {
      const email = String(emailInput.value ?? '').trim();
      const redirectTo = window.location.origin + window.location.pathname;
      const { error } = await requestPasswordRecovery(supabase.auth, email, redirectTo);
      if (error) {
        setMessage(emailPasswordLoginMessage, 'Recovery email could not be requested. Try again later.', true);
      } else {
        setMessage(emailPasswordLoginMessage, 'If this email belongs to an invited account, a recovery email has been requested. Email delivery is not confirmed by this page.');
      }
    } catch {
      setMessage(emailPasswordLoginMessage, 'Recovery email could not be requested. Try again later.', true);
    } finally {
      requestPasswordRecoveryButton.disabled = false;
    }
  });

  passwordRecoveryForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = passwordRecoveryForm.querySelector('button[type="submit"]');
    const newPasswordInput = passwordRecoveryForm.elements.new_password;
    const confirmPasswordInput = passwordRecoveryForm.elements.confirm_password;
    let newPassword = String(newPasswordInput.value ?? '');
    if (newPassword !== String(confirmPasswordInput.value ?? '')) {
      setMessage(passwordRecoveryMessage, 'The new passwords do not match.', true);
      return;
    }
    const passwordBytes = new TextEncoder().encode(newPassword).byteLength;
    if (passwordBytes < 12 || passwordBytes > 72) {
      setMessage(passwordRecoveryMessage, 'Choose a password between 12 and 72 UTF-8 bytes.', true);
      return;
    }
    const successSound = prepareSuccessSound(window);
    submitButton.disabled = true;
    setMessage(passwordRecoveryMessage, 'Updating password…');
    let updateResult;
    try {
      updateResult = await setRecoveredPassword(supabase.auth, newPassword);
    } catch {
      updateResult = { error: true };
    } finally {
      newPasswordInput.value = '';
      confirmPasswordInput.value = '';
      newPassword = '';
    }
    if (updateResult?.error || !updateResult?.data?.user?.id) {
      successSound.cancel();
      setMessage(passwordRecoveryMessage, 'Password could not be updated. Check the recovery link and try again.', true);
      submitButton.disabled = false;
      return;
    }

    try {
      recoveryMode = false;
      try { window.history.replaceState(null, document.title, window.location.pathname); } catch { /* Password save already succeeded. */ }
      showAppToast('Your password was updated successfully.');
      successSound.play();
      try {
        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        if (sessionData?.session) await handleSession(sessionData.session);
        else showLogin('Your password was updated. Sign in with your email and new password.');
      } catch {
        showLogin('Your password was updated. Sign in with your email and new password.');
      }
    } catch {
      showLogin('Your password was updated. Sign in with your email and new password.');
    } finally {
      submitButton.disabled = false;
    }
  });

  cancelPasswordRecoveryButton?.addEventListener('click', async () => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      setMessage(passwordRecoveryMessage, 'Could not exit password recovery. Try again.', true);
      return;
    }
    showLogin('Password recovery was canceled.');
  });

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

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      recoveryMode = true;
      showPasswordRecovery();
      return;
    }
    if (recoveryMode) return;
    queueMicrotask(() => { void handleSession(session); });
  });
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session) await handleSession(sessionData.session);
  else await handleSession(null);
}
