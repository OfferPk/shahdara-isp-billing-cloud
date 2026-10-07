import { resolvePppoeApiBase } from './pppoe-api-client.js';

async function billingRequest(path, { organizationId, token, body, fetchImpl = globalThis.fetch, apiBaseUrl = resolvePppoeApiBase() } = {}) {
  if (!token) throw new Error('Sign in again to manage package pricing or invoices.');
  if (typeof fetchImpl !== 'function') throw new Error('This browser does not support API requests.');
  const base = String(apiBaseUrl ?? '').trim().replace(/\/+$/, '');
  const url = `${base}${path}?organizationId=${encodeURIComponent(organizationId ?? '')}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new Error('The billing API service is unavailable.');
  }
  let payload;
  try { payload = await response.json(); } catch {
    throw new Error('The billing API returned an invalid response.');
  }
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'The billing request could not be completed.');
  }
  return payload;
}

export function updatePackageMonthlyFee({ organizationId, packageId, monthlyFeeCents, token, fetchImpl, apiBaseUrl } = {}) {
  return billingRequest('/api/admin/billing/packages', {
    organizationId, token, fetchImpl, apiBaseUrl,
    body: { packageId, monthlyFeeCents },
  });
}

export function generateMonthlyInvoices({ organizationId, billingMonth, issueDate, dueDate, token, fetchImpl, apiBaseUrl } = {}) {
  return billingRequest('/api/admin/billing/generate', {
    organizationId, token, fetchImpl, apiBaseUrl,
    body: { billingMonth, issueDate, dueDate },
  });
}
