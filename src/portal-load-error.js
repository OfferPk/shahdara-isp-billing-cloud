function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function renderPortalLoadError({ eyebrow, title, description, retryLabel, signOutLabel, retryKind }) {
  const safeRetryKind = retryKind === 'session' ? 'session' : 'context';
  return `<div class="panel portal-load-error" role="alert">
    <p class="eyebrow">${escapeHtml(eyebrow)}</p>
    <h2>${escapeHtml(title)}</h2>
    <p class="error-text">${escapeHtml(description)}</p>
    <div class="form-actions">
      <button class="button secondary" type="button" data-action="retry-portal-load" data-retry-kind="${safeRetryKind}">${escapeHtml(retryLabel)}</button>
      <button class="button secondary" type="button" data-action="sign-out">${escapeHtml(signOutLabel)}</button>
    </div>
  </div>`;
}

export function safePortalErrorDetails(error) {
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = /^[A-Za-z0-9_-]{1,32}$/.test(rawCode) ? rawCode : 'unknown';
  const numericStatus = Number(error?.status);
  const status = Number.isSafeInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599
    ? numericStatus
    : null;
  return { code, status };
}
