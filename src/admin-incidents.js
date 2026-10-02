function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

export function toLocalDateTimeInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function renderIncidentCustomerOptions(customers) {
  return [...customers]
    .sort((a, b) => Number(a.customer_number) - Number(b.customer_number))
    .map((customer) => `<option value="${escapeHtml(customer.id)}">#${escapeHtml(customer.customer_number)} · ${escapeHtml(customer.name)}</option>`)
    .join('');
}

export function renderAdminIncidentCards({ incidents = [], privateDetails = [], customers = [] } = {}) {
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));
  const noteByIncidentId = new Map(privateDetails.map((detail) => [detail.incident_id, detail.staff_notes ?? '']));
  if (!incidents.length) return '<p class="incident-card-empty" role="status">No service incidents are recorded yet.</p>';

  return incidents.slice(0, 100).map((incident, index) => {
    const customer = incident.customer_id ? customerById.get(incident.customer_id) : null;
    const customerLabel = incident.customer_id
      ? (customer ? `#${customer.customer_number} · ${customer.name}` : 'Customer')
      : 'Organization-wide';
    const reportedAt = String(incident.reported_at ?? '');
    const reportedLabel = reportedAt ? reportedAt.replace('T', ' ').slice(0, 19) : 'Report time not recorded';
    const isEditableStatus = ['open', 'resolved'].includes(incident.status);
    const statusLabel = isEditableStatus ? incident.status : `Unrecognized (${String(incident.status ?? 'missing')})`;
    const cardClass = incident.status === 'open' || incident.status === 'resolved' ? incident.status : 'unknown';
    const summary = escapeHtml(incident.customer_visible_summary);
    const id = escapeHtml(incident.id);

    if (!isEditableStatus) {
      return `<article class="incident-card incident-card--unknown" aria-labelledby="incident-title-${index}">
        <header class="incident-card__top"><div><p class="eyebrow">${escapeHtml(customerLabel)}</p><h3 id="incident-title-${index}">Service incident</h3></div><span class="status-pill incident-status--unknown">${escapeHtml(statusLabel)}</span></header>
        <p class="incident-card__reported"><time datetime="${escapeHtml(reportedAt)}">Reported ${escapeHtml(reportedLabel)}</time></p>
        <p class="incident-card__summary">${summary}</p>
        <p class="incident-card__warning" role="status">This stored status is outside the supported schema values, so editing is disabled to avoid changing it incorrectly.</p>
      </article>`;
    }

    const offlineAt = toLocalDateTimeInput(incident.offline_at);
    const restoredAt = toLocalDateTimeInput(incident.restored_at);
    const staffNotes = escapeHtml(noteByIncidentId.get(incident.id) ?? '');
    return `<article class="incident-card incident-card--${cardClass}" aria-labelledby="incident-title-${index}">
      <header class="incident-card__top"><div><p class="eyebrow">${escapeHtml(customerLabel)}</p><h3 id="incident-title-${index}">Service incident</h3></div><span class="status-pill incident-status--${cardClass}">${escapeHtml(statusLabel)}</span></header>
      <p class="incident-card__reported"><time datetime="${escapeHtml(reportedAt)}">Reported ${escapeHtml(reportedLabel)}</time></p>
      <form class="incident-card__form stack" data-incident-update-form data-incident-id="${id}">
        <label for="incident-summary-${index}">Customer-visible summary<textarea id="incident-summary-${index}" name="customer_visible_summary" maxlength="1000" rows="3" required>${summary}</textarea></label>
        <label for="incident-status-${index}">Status<select id="incident-status-${index}" name="status" required><option value="open" ${incident.status === 'open' ? 'selected' : ''}>Open</option><option value="resolved" ${incident.status === 'resolved' ? 'selected' : ''}>Resolved</option></select></label>
        <label for="incident-offline-${index}">Service offline at (optional)<input id="incident-offline-${index}" name="offline_at" type="datetime-local" step="60" value="${escapeHtml(offlineAt)}"></label>
        <label for="incident-restored-${index}">Service restored at (optional)<input id="incident-restored-${index}" name="restored_at" type="datetime-local" step="60" value="${escapeHtml(restoredAt)}"></label>
        <label for="incident-notes-${index}">Staff-only note (optional)<textarea id="incident-notes-${index}" name="staff_notes" maxlength="4000" rows="3" aria-describedby="incident-notes-help-${index}">${staffNotes}</textarea></label>
        <p class="incident-private-note-help" id="incident-notes-help-${index}">Private to same-organization Admins; stored separately and never copied into the customer-visible summary.</p>
        <div class="incident-card__actions"><button class="button primary" type="submit">Save incident update</button></div>
        <p class="form-message" data-incident-message role="status" aria-live="polite" aria-atomic="true"></p>
      </form>
    </article>`;
  }).join('');
}
