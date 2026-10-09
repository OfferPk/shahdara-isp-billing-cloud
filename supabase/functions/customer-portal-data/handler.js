import { exactOrigin, jsonResponse } from '../_shared/customer-auth.js';
import { createCustomerPortalServiceClient, readCustomerPortalToken, sha256Hex } from '../_shared/customer-portal-bff.js';

const UNAUTHORIZED = { error: 'Customer portal session is invalid or expired.' };
const UNAVAILABLE = { error: 'Customer portal data is temporarily unavailable.' };
const DASHBOARD_FIELDS = {
  quota: ['package_id', 'package_name', 'quota_type', 'quota_limit_gb', 'action_on_exhaust'],
  monthly_usage: ['usage_month', 'bytes_in', 'bytes_out', 'last_synced_at'],
  bills: ['id', 'invoice_number', 'customer_id', 'period', 'amount_due_cents', 'issued_on', 'due_date', 'plan_snapshot', 'applied_cents', 'balance_cents', 'status'],
  receipts: ['id', 'customer_id', 'origin_bill_id', 'received_on', 'amount_cents', 'method'],
  allocations: ['receipt_id', 'bill_id', 'customer_id', 'amount_cents', 'allocation_kind'],
  incidents: ['id', 'customer_id', 'customer_visible_summary', 'status', 'reported_at', 'offline_at', 'restored_at'],
};

function pickFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]));
}

function safeDashboard(data) {
  const customer = pickFields(data?.customer, [
    'id', 'customer_number', 'name', 'plan_name', 'monthly_fee_cents', 'service_status', 'has_pppoe_mapping',
  ]);
  if (!customer || typeof customer.id !== 'string' || !customer.id) return null;
  customer.has_pppoe_mapping = customer.has_pppoe_mapping === true;
  const dashboard = {
    status: 'ok',
    organization_id: data.organization_id,
    organization_name: data.organization_name,
    customer,
  };
  for (const [key, fields] of Object.entries(DASHBOARD_FIELDS)) {
    if (key === 'monthly_usage') dashboard[key] = pickFields(data[key], fields);
    else dashboard[key] = Array.isArray(data[key])
      ? data[key].map((row) => pickFields(row, fields)).filter(Boolean)
      : (key === 'quota' ? pickFields(data[key], fields) : []);
  }
  return dashboard;
}

export function createCustomerPortalDataHandler({ env, createClient }) {
  return async (request) => {
    const origin = exactOrigin(request, env);
    if (!origin) return jsonResponse(403, { error: 'Request is not allowed.' });
    if (request.method === 'OPTIONS') return jsonResponse(204, {}, origin);
    if (request.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed.' }, origin);

    const token = readCustomerPortalToken(request);
    if (!token) return jsonResponse(401, UNAUTHORIZED, origin);
    const serviceClient = createCustomerPortalServiceClient(env, createClient);
    if (!serviceClient) return jsonResponse(503, UNAVAILABLE, origin);
    try {
      const tokenHash = await sha256Hex(token);
      const { data, error } = await serviceClient.rpc('read_customer_portal_bff_dashboard', {
        p_token_hash: tokenHash,
      });
      if (error) return jsonResponse(503, UNAVAILABLE, origin);
      if (data?.status !== 'ok') return jsonResponse(401, UNAUTHORIZED, origin);
      const dashboard = safeDashboard(data);
      if (!dashboard) return jsonResponse(503, UNAVAILABLE, origin);
      return jsonResponse(200, { dashboard }, origin);
    } catch {
      return jsonResponse(503, UNAVAILABLE, origin);
    }
  };
}
