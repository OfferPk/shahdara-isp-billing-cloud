const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const identity = (value) => value;

export function parseSubscriberComment(comment, fallbackName = '') {
  const parts = String(comment ?? '').split(/\s+-\s+/).map((part) => part.trim());
  const name = String(parts[0] || fallbackName).trim().slice(0, 100);
  const rawPhone = String(parts[1] ?? '').trim();
  const phoneDigits = rawPhone.replace(/\D/g, '');
  const phone = /^03\d{9}$/.test(phoneDigits)
    ? phoneDigits
    : (/^923\d{9}$/.test(phoneDigits) ? `+${phoneDigits}` : '');
  const area = parts.slice(2).join(' - ').slice(0, 300);
  return { name, phone, area };
}

export function renderSubscriberImportContent({
  subscribers = [],
  selectedUsernames = [],
  loading = false,
  busy = false,
  error = '',
  t = identity,
} = {}) {
  const selected = new Set(selectedUsernames);
  const newCount = subscribers.filter((row) => row.status === 'New').length;
  const countLabel = `${subscribers.length} ${t('Subscribers Discovered on MikroTik Router')}`;
  const rows = loading
    ? `<tr><td class="empty-cell" colspan="6">${escapeHtml(t('Discovering router subscribers…'))}</td></tr>`
    : error
      ? `<tr><td class="empty-cell error-text" colspan="6">${escapeHtml(error)}</td></tr>`
      : subscribers.length
        ? subscribers.map((subscriber) => {
          const isNew = subscriber.status === 'New';
          const username = String(subscriber.username ?? '');
          const checked = isNew && selected.has(username);
          return `<tr>
            <td><input type="checkbox" data-import-subscriber="${escapeHtml(username)}" aria-label="${escapeHtml(t('Select subscriber'))} ${escapeHtml(username)}" ${checked ? 'checked' : ''} ${!isNew || busy ? 'disabled' : ''}></td>
            <td><strong>${escapeHtml(username)}</strong></td>
            <td>${escapeHtml(subscriber.profile || '—')}</td>
            <td class="subscriber-import-comment">${escapeHtml(subscriber.comment || '—')}</td>
            <td><code>${escapeHtml(subscriber.ipAddress || '—')}</code></td>
            <td><span class="subscriber-import-status ${isNew ? 'subscriber-import-status--new' : 'subscriber-import-status--existing'}">${escapeHtml(t(isNew ? 'New' : 'Already Exists'))}</span></td>
          </tr>`;
        }).join('')
        : `<tr><td class="empty-cell" colspan="6">${escapeHtml(t('No router subscribers were discovered.'))}</td></tr>`;
  const selectedCount = subscribers.filter((row) => row.status === 'New' && selected.has(row.username)).length;
  const importLabel = selectedCount === subscribers.length && selectedCount > 0
    ? `${t('Import')} ${selectedCount} ${t('Subscribers')}`
    : `${t('Import')} ${selectedCount} ${t('Selected Subscribers')}`;

  return `<div class="subscriber-import__header">
      <div><p class="eyebrow">${escapeHtml(t('Router import preview'))}</p><h3 id="subscriber-import-title">${escapeHtml(t('Import subscribers from router'))}</h3></div>
      <button class="icon-button" type="button" data-action="close-subscriber-import" aria-label="${escapeHtml(t('Close'))}" ${busy ? 'disabled' : ''}>×</button>
    </div>
    <p class="subscriber-import__stat" role="status" aria-live="polite">${escapeHtml(countLabel)}</p>
    <p class="muted">${escapeHtml(t('Review the discovered users. Existing PPPoE usernames are skipped; router passwords are never imported.'))}</p>
    <div class="subscriber-import__toolbar">
      <button class="button secondary small" type="button" data-action="select-all-new-subscribers" ${loading || busy || newCount === 0 ? 'disabled' : ''}>${escapeHtml(t('Select All New'))}</button>
      <span class="muted">${escapeHtml(`${selectedCount} ${t('selected')}`)}</span>
    </div>
    <div class="table-wrap subscriber-import__table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(t('Router subscriber import preview'))}">
      <table class="subscriber-import__table"><thead><tr><th>${escapeHtml(t('Select'))}</th><th>${escapeHtml(t('Username'))}</th><th>${escapeHtml(t('Profile / Package'))}</th><th>${escapeHtml(t('Comment (Name / Phone / Area)'))}</th><th>${escapeHtml(t('Assigned IP'))}</th><th>${escapeHtml(t('Status'))}</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
    <p class="subscriber-import__error" role="alert" ${error ? '' : 'hidden'}>${escapeHtml(error)}</p>
    <div class="subscriber-import__actions"><button class="button secondary" type="button" data-action="close-subscriber-import" ${busy ? 'disabled' : ''}>${escapeHtml(t('Cancel'))}</button><button class="button primary" type="button" data-action="import-selected-subscribers" ${loading || busy || selectedCount === 0 ? 'disabled' : ''}>${escapeHtml(busy ? t('Importing…') : importLabel)}</button></div>`;
}

export function renderSubscriberImportDialog(state = {}, t = identity) {
  return `<dialog id="subscriber-import-dialog" class="edit-dialog subscriber-import-dialog" aria-labelledby="subscriber-import-title"><div id="subscriber-import-content">${renderSubscriberImportContent({ ...state, t })}</div></dialog>`;
}

export function setSelectedSubscriberUsernames(state, usernames) {
  const eligible = new Set((state.subscribers ?? []).filter((row) => row.status === 'New').map((row) => row.username));
  state.selectedUsernames = [...new Set((usernames ?? []).filter((username) => eligible.has(username)))];
  return state.selectedUsernames;
}

export const subscriberImportInternals = Object.freeze({ escapeHtml });
