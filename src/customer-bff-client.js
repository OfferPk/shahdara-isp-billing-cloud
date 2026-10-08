export const CUSTOMER_SUPPORT_PHONE = '+923155669955';
export const CUSTOMER_SUPPORT_WHATSAPP_URL = 'https://wa.me/923155669955';
const OPAQUE_TOKEN = /^[0-9a-f]{64}$/;

function requireFunctionsClient(functions) {
  if (!functions || typeof functions.invoke !== 'function') {
    throw new Error('Customer portal service is unavailable.');
  }
}

function requireToken(token) {
  const value = String(token ?? '');
  if (!OPAQUE_TOKEN.test(value)) throw new Error('Customer portal session is invalid or expired.');
  return value;
}

export async function fetchCustomerPortalDashboard(functions, token) {
  requireFunctionsClient(functions);
  const portalToken = requireToken(token);
  const { data, error } = await functions.invoke('customer-portal-data', {
    body: {},
    headers: { Authorization: `Bearer ${portalToken}` },
  });
  if (error) throw error;
  if (data?.dashboard?.status !== 'ok') {
    throw new Error('Customer portal data could not be verified.');
  }
  return data.dashboard;
}

export async function revokeCustomerPortalSession(functions, token) {
  requireFunctionsClient(functions);
  const portalToken = requireToken(token);
  const { data, error } = await functions.invoke('customer-portal-logout', {
    body: {},
    headers: { Authorization: `Bearer ${portalToken}` },
  });
  if (error) throw error;
  return data;
}

function safeString(value, maxLength = 500) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

export function customerContextFromDashboard(dashboard) {
  const organizationId = String(dashboard?.organization_id ?? '').trim();
  const customerId = String(dashboard?.customer?.id ?? '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)
      || !customerId || customerId.length > 200) {
    throw new Error('The linked customer account could not be verified.');
  }
  return {
    kind: 'customer',
    organizationId,
    organizationName: safeString(dashboard.organization_name, 200) || 'Shahdara Fiber Net',
    customerId,
    customerName: safeString(dashboard.customer?.name),
  };
}

export function customerPortalRowsFromDashboard(dashboard, { expectedContext = null } = {}) {
  const context = customerContextFromDashboard(dashboard);
  if (expectedContext && (context.organizationId !== expectedContext.organizationId
      || context.customerId !== expectedContext.customerId)) {
    throw new Error('The customer portal response did not match the active account.');
  }
  const sourceCustomer = dashboard.customer ?? {};
  const customer = {
    id: context.customerId,
    organization_id: context.organizationId,
    customer_number: safeString(sourceCustomer.customer_number, 120),
    name: safeString(sourceCustomer.name),
    plan_name: safeString(sourceCustomer.plan_name, 200),
    monthly_fee_cents: sourceCustomer.monthly_fee_cents ?? null,
    service_status: safeString(sourceCustomer.service_status, 40) || 'not-set',
    archived: false,
    service_address: '',
    has_pppoe_mapping: sourceCustomer.has_pppoe_mapping === true,
  };
  const monthlyUsage = dashboard.monthly_usage && typeof dashboard.monthly_usage === 'object'
    ? [{
      usage_month: dashboard.monthly_usage.usage_month,
      bytes_in: String(dashboard.monthly_usage.bytes_in ?? ''),
      bytes_out: String(dashboard.monthly_usage.bytes_out ?? ''),
      last_synced_at: dashboard.monthly_usage.last_synced_at ?? null,
    }]
    : [];
  return {
    customers: [customer],
    pppoeMappingAvailable: customer.has_pppoe_mapping,
    bills: Array.isArray(dashboard.bills) ? dashboard.bills : [],
    receipts: Array.isArray(dashboard.receipts) ? dashboard.receipts : [],
    allocations: Array.isArray(dashboard.allocations) ? dashboard.allocations : [],
    incidents: Array.isArray(dashboard.incidents) ? dashboard.incidents : [],
    privateCustomerDetails: [],
    privateIncidentDetails: [],
    cashflowExpenses: [],
    customerServiceCosts: [],
    branding: {
      organization_id: context.organizationId,
      display_name: context.organizationName,
      support_phone: CUSTOMER_SUPPORT_PHONE,
      address: '',
    },
    customerBandwidthUsage: [],
    customerBandwidthUsageError: false,
    customerMonthlyBandwidthUsage: monthlyUsage,
    customerMonthlyBandwidthUsageError: false,
    customerQuotaPackage: dashboard.quota ?? null,
    customerQuotaPackageError: false,
  };
}
