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
    .from('customer_portal_accounts')
    .select('organization_id, customer_id');
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
  const [customers, bills, receipts, allocations, incidents, privateCustomerDetails, privateIncidentDetails, branding] = await Promise.all([
    rowsFor(supabase, 'customers', 'id, customer_number, name, plan_name, service_address, service_status, monthly_fee_cents, archived',
      context.kind === 'admin' ? byOrganization : customerTableOnly, { column: 'customer_number' }),
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
  ]);
  return { customers, bills, receipts, allocations, incidents, privateCustomerDetails, privateIncidentDetails, branding };
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

const PPPoE_USAGE_COLUMNS = 'organization_id,customer_id,period_start,upload_bytes,download_bytes,used_bytes,quota_bytes,remaining_bytes,over_quota_bytes,speed_download_bps,speed_upload_bps,last_collector_contact_at,is_stale';

export async function loadCustomerPppoeUsage(supabase, context) {
  const names = {
    currentMonth: 'pppoe_usage_current_month',
    last_1_hour: 'pppoe_usage_last_1_hour',
    last_2_hours: 'pppoe_usage_last_2_hours',
    last_24_hours: 'pppoe_usage_last_24_hours',
    last_30_days: 'pppoe_usage_last_30_days',
  };
  const entries = await Promise.all(Object.entries(names).map(async ([key, view]) => {
    const { data, error } = await supabase.from(view).select(PPPoE_USAGE_COLUMNS)
      .eq('organization_id', context.organizationId).eq('customer_id', context.customerId).maybeSingle();
    if (error) throw error;
    return [key, data ?? null];
  }));
  return Object.fromEntries(entries);
}

export async function loadPppoeUsageAdmin(supabase, organizationId) {
  const { data, error } = await supabase.functions.invoke('pppoe-usage-admin', {
    body: { action: 'list', organization_id: organizationId },
  });
  if (error) throw error;
  return data ?? { mappings: [], sites: [] };
}

export async function savePppoeUsageMapping(supabase, organizationId, mapping) {
  const { data, error } = await supabase.functions.invoke('pppoe-usage-admin', {
    body: { action: 'save_mapping', organization_id: organizationId, ...mapping },
  });
  if (error) throw error;
  if (!data?.saved) throw new Error(data?.error || 'The mapping could not be saved.');
  return data;
}

export async function requestPppoeCollectorToken(supabase, organizationId, siteId) {
  const { data, error } = await supabase.functions.invoke('pppoe-usage-admin', {
    body: { action: 'collector_key', organization_id: organizationId, site_id: siteId },
  });
  if (error) throw error;
  if (typeof data?.collector_token !== 'string') throw new Error(data?.error || 'Collector token could not be issued.');
  return data.collector_token;
}

const PPPoE_USAGE_ADMIN_COLUMNS = 'organization_id,customer_id,period_start,upload_bytes,download_bytes,used_bytes,quota_bytes,remaining_bytes,over_quota_bytes,speed_download_bps,speed_upload_bps,last_collector_contact_at,is_stale';

export async function loadAdminPppoeUsage(supabase, organizationId) {
  const names = {
    currentMonth: 'pppoe_usage_current_month',
    last_1_hour: 'pppoe_usage_last_1_hour',
    last_2_hours: 'pppoe_usage_last_2_hours',
    last_24_hours: 'pppoe_usage_last_24_hours',
    last_30_days: 'pppoe_usage_last_30_days',
  };
  const entries = await Promise.all(Object.entries(names).map(async ([key, view]) => {
    const rows = await rowsFor(supabase, view, PPPoE_USAGE_ADMIN_COLUMNS,
      (query) => query.eq('organization_id', organizationId), { column: 'customer_id' });
    return [key, rows];
  }));
  return Object.fromEntries(entries);
}
