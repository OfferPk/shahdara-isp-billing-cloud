function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeLogoUrl(value, projectUrl) {
  try {
    const expectedOrigin = new URL(projectUrl).origin;
    const parsed = new URL(value);
    const assetPath = /^\/storage\/v1\/object\/public\/organization-branding\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|jpeg|webp)$/i;
    if (parsed.protocol !== 'https:' || parsed.origin !== expectedOrigin
        || !assetPath.test(parsed.pathname) || parsed.search || parsed.hash) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function brandingMarkup(branding = {}, projectUrl = '', t = (value) => value) {
  const displayName = escapeHtml(branding.displayName || 'Shahdara Fiber Net');
  const logoUrl = safeLogoUrl(branding.logoUrl, projectUrl);
  const supportPhone = String(branding.supportPhone ?? '').trim();
  const address = String(branding.address ?? '').trim();
  const phone = supportPhone
    ? `<p><strong>${escapeHtml(t('Support phone'))}:</strong> ${escapeHtml(supportPhone)}</p>`
    : '';
  const location = address
    ? `<p><strong>${escapeHtml(t('Company address'))}:</strong> ${escapeHtml(address)}</p>`
    : '';
  const logo = logoUrl ? `<img class="document-logo" src="${escapeHtml(logoUrl)}" alt="">` : '';
  return `<div class="document-brand">${logo}<div><h1>${displayName}</h1>${phone}${location}</div></div>`;
}

export function renderPrintableBillHtml({ bill, customer, summary, branding, projectUrl, formatMoney, t = (value) => value, language = 'en' }) {
  if (!bill?.id || !customer?.name || typeof formatMoney !== 'function') {
    throw new Error('An existing bill, its customer, and a money formatter are required.');
  }
  const billId = escapeHtml(bill.invoice_number || bill.id);
  const customerName = escapeHtml(customer.name);
  const pppoeUsername = escapeHtml(String(customer.pppoe_username ?? '').trim() || t('Not recorded'));
  const accountNumber = customer.customer_number != null && String(customer.customer_number).trim() !== ''
    && Number.isInteger(Number(customer.customer_number))
    ? escapeHtml(customer.customer_number)
    : escapeHtml(t('Not recorded'));
  const period = escapeHtml(String(bill.period ?? '').slice(0, 7) || t('Period not available'));
  const dueDate = escapeHtml(String(bill.due_date ?? '').trim() || t('Due date not recorded'));
  const plan = escapeHtml(String(bill.plan_snapshot ?? '').trim() || t('Plan snapshot not recorded'));
  const amount = escapeHtml(formatMoney(bill.amount_due_cents));
  const cash = escapeHtml(formatMoney(summary?.receiptCashCents ?? 0));
  const credit = escapeHtml(formatMoney(summary?.creditAppliedCents ?? 0));
  const balance = escapeHtml(formatMoney(summary?.balanceCents ?? null));
  const status = escapeHtml(t({
    'not-priced': 'Not priced', paid: 'Paid', partial: 'Partially paid', unpaid: 'Unpaid',
  }[summary?.status] ?? 'Status not available'));
  const brand = brandingMarkup(branding, projectUrl, t);
  const title = escapeHtml(t('Bill'));

  return `<!doctype html><html lang="${escapeHtml(language)}" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} ${billId}</title><style>
    :root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#17342f}*{box-sizing:border-box}body{margin:0;padding:32px;background:#eef3f0}.document{max-width:760px;margin:0 auto;padding:38px;border:1px solid #d7e3dc;border-radius:14px;background:#fff}.document__head{padding-bottom:20px;border-bottom:2px solid #177b59}.document-brand{display:flex;align-items:center;gap:16px;margin-bottom:24px}.document-brand h1{margin:0 0 8px;color:#177b59;font-size:24px;overflow-wrap:anywhere}.document-brand p{margin:3px 0;color:#536b61;font-size:12px;overflow-wrap:anywhere}.document-logo{width:68px;height:68px;object-fit:contain;border:1px solid #e2ebe6;border-radius:12px;padding:5px}.document h2{margin:0 0 10px;font-size:28px}.document__id{color:#536b61;font-size:12px;overflow-wrap:anywhere}.document dl{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:24px 0}.document dl div{padding:12px;border:1px solid #e2ebe6;border-radius:10px}.document dt{margin-bottom:6px;color:#61756d;font-size:11px;font-weight:700;text-transform:uppercase}.document dd{margin:0;font-size:15px;font-weight:700;overflow-wrap:anywhere}.document__balance dd{font-size:22px;color:#0f5a43}.document__footer{margin-top:26px;color:#708078;font-size:11px}@media print{body{padding:0;background:#fff}.document{max-width:none;border:0;border-radius:0;box-shadow:none;padding:0}}@media(max-width:520px){body{padding:12px}.document{padding:22px}.document dl{grid-template-columns:1fr}}
  </style></head><body><main class="document"><header class="document__head">${brand}<h2>${title}</h2><p class="document__id">${escapeHtml(t('Invoice No.'))} ${billId}</p></header><dl><div><dt>${escapeHtml(t('Customer'))}</dt><dd>${customerName}</dd></div><div><dt>${escapeHtml(t('Account'))}</dt><dd>#${accountNumber}</dd></div><div><dt>${escapeHtml(t('PPPoE Username'))}</dt><dd>${pppoeUsername}</dd></div><div><dt>${escapeHtml(t('Billing period'))}</dt><dd>${period}</dd></div><div><dt>${escapeHtml(t('Due Date'))}</dt><dd>${dueDate}</dd></div><div><dt>${escapeHtml(t('Plan'))}</dt><dd>${plan}</dd></div><div><dt>${escapeHtml(t('Total Amount'))}</dt><dd>${amount}</dd></div><div><dt>${escapeHtml(t('Actual receipts'))}</dt><dd>${cash}</dd></div><div><dt>${escapeHtml(t('Credit applied'))}</dt><dd>${credit}</dd></div><div class="document__balance"><dt>${escapeHtml(t('Balance'))}</dt><dd>${balance}</dd></div><div><dt>${escapeHtml(t('Status'))}</dt><dd>${status}</dd></div></dl><footer class="document__footer">${escapeHtml(t('This print-ready document reflects the saved bill snapshot and currently recorded receipts and credit.'))}</footer></main></body></html>`;
}
