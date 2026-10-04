import { isStagingProjectUrl } from './supabase-client.js';

async function rowsFor(supabase, table, columns, applyFilters, orderBy) {
  const allRows = [];
  const pageSize = 1000;
  for (let offset = 0; offset < 50000; offset += pageSize) {
    let query = supabase.from(table).select(columns);
    query = applyFilters(query);
    query = query.order(orderBy.column, { ascending: orderBy.ascending ?? true });
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) throw error;
    allRows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) return allRows;
  }
  throw new Error('The current screen reached its safe paging limit. Narrow the date range and try again.');
}

export function isMissingPppoeUsernameColumn(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  return ['42703', 'PGRST204'].includes(code) && /pppoe_username/i.test(message);
}

export function isMissingPortalTestAccountColumn(error) {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  return ['42703', 'PGRST204'].includes(code) && /portal_test_account/i.test(message);
}

async function loadCustomerRows(supabase, context, applyFilters) {
  const coreColumns = 'id, customer_number, name, plan_name, service_address, service_status, monthly_fee_cents, archived';
  const testMarkerColumn = context.kind === 'admin' ? ', portal_test_account' : '';
  try {
    const rows = await rowsFor(supabase, 'customers', `${coreColumns}, pppoe_username${testMarkerColumn}`, applyFilters, { column: 'customer_number' });
    return { rows, pppoeMappingAvailable: true };
  } catch (error) {
    if (context.kind === 'admin' && isMissingPortalTestAccountColumn(error)) {
      try {
        const rows = await rowsFor(supabase, 'customers', `${coreColumns}, pppoe_username`, applyFilters, { column: 'customer_number' });
        return { rows: rows.map((customer) => ({ ...customer, portal_test_account: false })), pppoeMappingAvailable: true };
      } catch (mappingError) {
        if (!isMissingPppoeUsernameColumn(mappingError)) throw mappingError;
      }
    } else if (!isMissingPppoeUsernameColumn(error)) {
      throw error;
    }
    const rows = await rowsFor(supabase, 'customers', coreColumns, applyFilters, { column: 'customer_number' });
    return {
      rows: rows.map((customer) => ({ ...customer, pppoe_username: null, portal_test_account: false })),
      pppoeMappingAvailable: false,
    };
  }
}

export async function loadContexts(supabase, user) {
  const { data: memberships, error: membershipError } = await supabase
    .from('organization_memberships')
    .select('organization_id, role')
    .eq('user_id', user.id);
  if (membershipError) throw membershipError;

  if ((memberships ?? []).length) {
    const organizationIds = [...new Set(memberships.map((entry) => entry.organization_id))];
    const { data: organizations, error: organizationError } = await supabase
      .from('organizations')
      .select('id, name')
      .in('id', organizationIds);
    if (organizationError) throw organizationError;
    const nameById = new Map((organizations ?? []).map((organization) => [organization.id, organization.name]));
    return memberships
      .filter((entry) => ['owner', 'admin'].includes(entry.role))
      .map((entry) => ({
        kind: 'admin',
        organizationId: entry.organization_id,
        organizationName: nameById.get(entry.organization_id) ?? 'ISP organization',
        role: entry.role,
      }));
  }

  const { data: accounts, error: accountError } = await supabase
    .rpc('my_customer_portal_contexts');
  if (accountError) throw accountError;
  const contexts = [];
  for (const account of accounts ?? []) {
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('name')
      .eq('organization_id', account.organization_id)
      .eq('id', account.customer_id)
      .maybeSingle();
    if (customerError) throw customerError;
    if (customer) contexts.push({
      kind: 'customer',
      organizationId: account.organization_id,
      customerId: account.customer_id,
      customerName: customer.name,
    });
  }
  return contexts;
}

export async function loadOrganizationBranding(supabase, organizationId) {
  const { data, error } = await supabase
    .from('organization_branding')
    .select('organization_id, display_name, logo_path, support_phone, address')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function loadPortalRows(supabase, context) {
  const byOrganization = (query) => query.eq('organization_id', context.organizationId);
  const customerOnly = (query) => byOrganization(query).eq('customer_id', context.customerId);
  const customerTableOnly = (query) => byOrganization(query).eq('id', context.customerId);
  const privateCustomerDetailsQuery = context.kind === 'admin'
    ? rowsFor(supabase, 'customer_private_details', 'customer_id, phone', byOrganization, { column: 'customer_id' })
    : Promise.resolve([]);
  const privateIncidentDetailsQuery = context.kind === 'admin'
    ? rowsFor(supabase, 'incident_private_details', 'incident_id, staff_notes', byOrganization, { column: 'incident_id' })
    : Promise.resolve([]);
  const billColumns = context.kind === 'admin'
    ? 'id, customer_id, period, amount_due_cents, issued_on, due_date, plan_snapshot'
    : 'id, customer_id, period, amount_due_cents, plan_snapshot';
  const customerQuery = loadCustomerRows(
    supabase,
    context,
    context.kind === 'admin' ? byOrganization : customerTableOnly,
  );
  const customerBandwidthUsageQuery = context.kind === 'customer'
    ? rowsFor(supabase, 'customer_bandwidth_usage', 'username, total_quota_bytes, bytes_in, bytes_out, is_online, last_synced_at',
      (query) => query, { column: 'username' })
      .then((data) => ({ data, error: null }))
      .catch((error) => ({ data: [], error }))
    : Promise.resolve({ data: [], error: null });
  const [customerResult, bills, receipts, allocations, incidents, privateCustomerDetails, privateIncidentDetails, branding, customerBandwidthUsage] = await Promise.all([
    customerQuery,
    rowsFor(supabase, 'bills', billColumns,
      context.kind === 'admin' ? byOrganization : customerOnly, { column: 'period', ascending: false }),
    rowsFor(supabase, 'receipts', 'id, customer_id, origin_bill_id, received_on, amount_cents, method',
      context.kind === 'admin' ? byOrganization : customerOnly, { column: 'received_on', ascending: false }),
    rowsFor(supabase, 'receipt_allocations', 'receipt_id, bill_id, customer_id, amount_cents, allocation_kind',
      context.kind === 'admin' ? byOrganization : customerOnly, { column: 'created_at', ascending: true }),
    rowsFor(supabase, 'incidents', 'id, customer_id, customer_visible_summary, status, reported_at, offline_at, restored_at',
      context.kind === 'admin' ? byOrganization : customerOnly, { column: 'reported_at', ascending: false }),
    privateCustomerDetailsQuery,
    privateIncidentDetailsQuery,
    loadOrganizationBranding(supabase, context.organizationId),
    customerBandwidthUsageQuery,
  ]);
  return {
    customers: customerResult.rows,
    pppoeMappingAvailable: customerResult.pppoeMappingAvailable,
    bills, receipts, allocations, incidents, privateCustomerDetails, privateIncidentDetails, branding,
    customerBandwidthUsage: customerBandwidthUsage.data,
    customerBandwidthUsageError: customerBandwidthUsage.error,
  };
}

export async function saveCustomerPppoeUsername(supabase, { organizationId, customerId, username }) {
  if (!organizationId || !customerId) throw new Error('An organization and customer are required.');
  const pppoeUsername = username === null ? null : String(username ?? '').trim();
  if (username !== null && !pppoeUsername) {
    throw new Error('Enter an existing PPPoE username or explicitly remove the link.');
  }

  const { data, error } = await supabase
    .from('customers')
    .update({ pppoe_username: pppoeUsername })
    .eq('organization_id', organizationId)
    .eq('id', customerId)
    .select('id, pppoe_username')
    .maybeSingle();
  if (error) throw error;
  if (!data || data.id !== customerId || (data.pppoe_username ?? null) !== pppoeUsername) {
    throw new Error('The customer PPPoE mapping could not be confirmed.');
  }
  return data;
}

export async function saveCustomerPortalTestAccount(supabase, { organizationId, customerId, enabled }) {
  if (!isStagingProjectUrl(supabase?.supabaseUrl)) {
    throw new Error('Internal staging test access is unavailable for this project.');
  }
  if (!organizationId || !customerId || typeof enabled !== 'boolean') {
    throw new Error('A valid organization, customer, and test-access choice are required.');
  }

  const { data, error } = await supabase
    .from('customers')
    .update({ portal_test_account: enabled })
    .eq('organization_id', organizationId)
    .eq('id', customerId)
    .select('id, portal_test_account')
    .maybeSingle();
  if (error) throw error;
  if (!data || data.id !== customerId || data.portal_test_account !== enabled) {
    throw new Error('The staging test-access choice could not be confirmed.');
  }
  return data;
}

export async function createCustomer(supabase, customer) {
  return invokeRpc(supabase, 'create_customer', {
    p_organization_id: customer.organizationId,
    p_customer_number: customer.customerNumber,
    p_name: customer.name,
    p_plan_name: customer.planName,
    p_monthly_fee_cents: customer.monthlyFeeCents,
    p_service_address: customer.serviceAddress,
    p_service_status: customer.serviceStatus,
    p_phone: customer.phone,
  });
}

export async function manageServiceIncident(supabase, incident) {
  return invokeRpc(supabase, 'manage_service_incident', {
    p_organization_id: incident.organizationId,
    p_incident_id: incident.incidentId ?? null,
    p_customer_id: incident.customerId ?? null,
    p_customer_visible_summary: incident.customerVisibleSummary,
    p_status: incident.status,
    p_offline_at: incident.offlineAt ?? null,
    p_restored_at: incident.restoredAt ?? null,
    p_staff_notes: incident.staffNotes ?? null,
  });
}

export async function invokeRpc(supabase, functionName, args) {
  const { data, error } = await supabase.rpc(functionName, args);
  if (error) throw error;
  return data;
}
