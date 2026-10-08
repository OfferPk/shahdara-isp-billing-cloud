async function billingRpc(supabase, functionName, args, isConfirmed, confirmationError) {
  if (typeof supabase?.rpc !== 'function') {
    throw new Error('This browser cannot connect to the billing database.');
  }
  const { data, error } = await supabase.rpc(functionName, args);
  if (error) throw error;
  if (!isConfirmed(data)) throw new Error(confirmationError);
  return data;
}

export async function updatePackageMonthlyFee({ supabase, organizationId, packageId, monthlyFeeCents } = {}) {
  const normalizedPackageId = String(packageId ?? '').trim();
  if (!normalizedPackageId || !Number.isSafeInteger(monthlyFeeCents) || monthlyFeeCents <= 0) {
    throw new Error('Provide a package ID and a positive monthly fee in PKR minor units.');
  }
  const pkg = await billingRpc(supabase, 'set_package_monthly_fee', {
    p_organization_id: organizationId,
    p_package_id: normalizedPackageId,
    p_monthly_fee_cents: monthlyFeeCents,
  }, (data) => data?.packageId === normalizedPackageId,
  'The package pricing update could not be confirmed.');
  return { package: pkg };
}

export async function generateMonthlyInvoices({ supabase, organizationId, billingMonth, issueDate, dueDate } = {}) {
  const month = String(billingMonth ?? '').trim();
  const result = await billingRpc(supabase, 'generate_monthly_invoices', {
    p_organization_id: organizationId,
    p_period: `${month}-01`,
    p_issued_on: issueDate,
    p_due_date: dueDate,
  }, (data) => data?.period === month && Number.isSafeInteger(Number(data.generated)),
  'Monthly invoice generation could not be confirmed.');
  return result;
}
