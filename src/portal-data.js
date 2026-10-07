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

function isMissingInvoiceNumberColumn(error) {
  return ['42703', 'PGRST204'].includes(String(error?.code ?? ''))
    && /invoice_number/i.test(String(error?.message ?? ''));
}

async function loadCustomerRows(supabase, context, applyFilters) {
  const coreColumns = 'id, customer_number, name, plan_name, service_address, service_status, monthly_fee_cents, archived';
  const profileColumns = context.kind === 'admin' ? `${coreColumns}, created_at` : coreColumns;
  const testMarkerColumn = context.kind === 'admin' ? ', portal_test_account' : '';
  try {
    const rows = await rowsFor(supabase, 'customers', `${profileColumns}, pppoe_username${testMarkerColumn}`, applyFilters, { column: 'customer_number' });
    return { rows, pppoeMappingAvailable: true };
  } catch (error) {
    if (context.kind === 'admin' && isMissingPortalTestAccountColumn(error)) {
      try {
        const rows = await rowsFor(supabase, 'customers', `${profileColumns}, pppoe_username`, applyFilters, { column: 'customer_number' });
        return { rows: rows.map((customer) => ({ ...customer, portal_test_account: false })), pppoeMappingAvailable: true };
      } catch (mappingError) {
        if (!isMissingPppoeUsernameColumn(mappingError)) throw mappingError;
      }
    } else if (!isMissingPppoeUsernameColumn(error)) {
      throw error;
    }
    const rows = await rowsFor(supabase, 'customers', profileColumns, applyFilters, { column: 'customer_number' });
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
  const linkedAccounts = accounts ?? [];
  if (!linkedAccounts.length) return [];
  const customerIdsByOrganization = new Map();
  for (const account of linkedAccounts) {
    if (!account.organization_id || !account.customer_id) continue;
    if (!customerIdsByOrganization.has(account.organization_id)) customerIdsByOrganization.set(account.organization_id, new Set());
    customerIdsByOrganization.get(account.organization_id).add(account.customer_id);
  }
  if (!customerIdsByOrganization.size) return [];
  const customerRows = await Promise.all([...customerIdsByOrganization].map(async ([organizationId, customerIds]) => {
    const { data: customers, error: customerError } = await supabase
      .from('customers')
      .select('organization_id, id, name')
      .eq('organization_id', organizationId)
      .in('id', [...customerIds]);
    if (customerError) throw customerError;
    return customers ?? [];
  }));
  const customerByAccount = new Map(customerRows.flat().map((customer) => [
    JSON.stringify([customer.organization_id, customer.id]), customer,
  ]));
  return linkedAccounts.flatMap((account) => {
    const customer = customerByAccount.get(JSON.stringify([account.organization_id, account.customer_id]));
    return customer ? [{
      kind: 'customer',
      organizationId: account.organization_id,
      customerId: account.customer_id,
      customerName: customer.name,
    }] : [];
  });
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

async function loadBillRows(supabase, context, applyFilters) {
  const billColumns = context.kind === 'admin'
    ? 'id, invoice_number, customer_id, period, amount_due_cents, issued_on, due_date, plan_snapshot, created_at'
    : 'id, invoice_number, customer_id, period, amount_due_cents, plan_snapshot';
  const fallbackBillColumns = context.kind === 'admin'
    ? 'id, customer_id, period, amount_due_cents, issued_on, due_date, plan_snapshot, created_at'
    : 'id, customer_id, period, amount_due_cents, plan_snapshot';
  try {
    const rows = await rowsFor(supabase, 'bills', billColumns,
      applyFilters, { column: 'period', ascending: false });
    return { rows, invoiceNumberAvailable: true };
  } catch (error) {
    if (!isMissingInvoiceNumberColumn(error)) throw error;
    const rows = await rowsFor(supabase, 'bills', fallbackBillColumns,
      applyFilters, { column: 'period', ascending: false });
    return { rows: rows.map((bill) => ({ ...bill, invoice_number: null })), invoiceNumberAvailable: false };
  }
}

async function loadServicePackages(supabase, applyFilters) {
  try {
    const rows = await rowsFor(supabase, 'service_packages', 'id, name, monthly_fee_cents, effective_on, updated_at',
      applyFilters, { column: 'name' });
    return { data: rows, error: null };
  } catch (error) {
    if (!['42703', 'PGRST204'].includes(String(error?.code ?? ''))
        || !/(effective_on|updated_at)/i.test(String(error?.message ?? ''))) {
      return { data: [], error };
    }
    try {
      const rows = await rowsFor(supabase, 'service_packages', 'id, name, monthly_fee_cents',
        applyFilters, { column: 'name' });
      return { data: rows, error: null };
    } catch (fallbackError) {
      return { data: [], error: fallbackError };
    }
  }
}

export async function loadPortalRows(supabase, context) {
  const byOrganization = (query) => query.eq('organization_id', context.organizationId);
  const customerOnly = (query) => byOrganization(query).eq('customer_id', context.customerId);
  const customerTableOnly = (query) => byOrganization(query).eq('id', context.customerId);
  const privateCustomerDetailsQuery = context.kind === 'admin'
    ? rowsFor(supabase, 'customer_private_details', 'customer_id, phone, connection_date', byOrganization, { column: 'customer_id' })
    : Promise.resolve([]);
  const privateIncidentDetailsQuery = context.kind === 'admin'
    ? rowsFor(supabase, 'incident_private_details', 'incident_id, staff_notes', byOrganization, { column: 'incident_id' })
    : Promise.resolve([]);
  const cashflowExpensesQuery = context.kind === 'admin'
    ? rowsFor(supabase, 'cashflow_expenses', 'organization_id, id, category, amount_paisa, note, created_at', byOrganization, { column: 'created_at', ascending: false })
    : Promise.resolve([]);
  const customerServiceCostsQuery = context.kind === 'admin'
    ? rowsFor(supabase, 'customer_service_cost_history', 'organization_id, customer_id, id, effective_on, monthly_cost_paisa, note, created_at', byOrganization, { column: 'effective_on', ascending: false })
    : Promise.resolve([]);
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
  const packageCatalogQuery = context.kind === 'admin'
    ? loadServicePackages(supabase, byOrganization)
    : Promise.resolve({ data: [], error: null });
  const receiptColumns = context.kind === 'admin'
    ? 'organization_id, id, customer_id, origin_bill_id, received_on, amount_cents, method, created_at'
    : 'id, customer_id, origin_bill_id, received_on, amount_cents, method';
  const [customerResult, billResult, receipts, allocations, incidents, privateCustomerDetails, privateIncidentDetails, cashflowExpenses, customerServiceCosts, branding, customerBandwidthUsage, packageCatalog] = await Promise.all([
    customerQuery,
    loadBillRows(supabase, context, context.kind === 'admin' ? byOrganization : customerOnly),
    rowsFor(supabase, 'receipts', receiptColumns,
      context.kind === 'admin' ? byOrganization : customerOnly, { column: 'received_on', ascending: false }),
    rowsFor(supabase, 'receipt_allocations', 'receipt_id, bill_id, customer_id, amount_cents, allocation_kind',
      context.kind === 'admin' ? byOrganization : customerOnly, { column: 'created_at', ascending: true }),
    rowsFor(supabase, 'incidents', 'id, customer_id, customer_visible_summary, status, reported_at, offline_at, restored_at',
      context.kind === 'admin' ? byOrganization : customerOnly, { column: 'reported_at', ascending: false }),
    privateCustomerDetailsQuery,
    privateIncidentDetailsQuery,
    cashflowExpensesQuery,
    customerServiceCostsQuery,
    loadOrganizationBranding(supabase, context.organizationId),
    customerBandwidthUsageQuery,
    packageCatalogQuery,
  ]);
  const adminBillingRows = context.kind === 'admin' ? {
    invoiceNumberAvailable: billResult.invoiceNumberAvailable,
    packages: packageCatalog.data,
    packagesError: packageCatalog.error,
  } : {};
  return {
    customers: customerResult.rows,
    pppoeMappingAvailable: customerResult.pppoeMappingAvailable,
    bills: billResult.rows,
    ...adminBillingRows,
    receipts, allocations, incidents, privateCustomerDetails, privateIncidentDetails,
    cashflowExpenses, customerServiceCosts, branding,
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
