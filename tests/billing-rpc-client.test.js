import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMonthlyInvoices, updatePackageMonthlyFee } from '../src/billing-rpc-client.js';

function createSupabase(result) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      return result;
    },
  };
}

test('package fee updates use the authenticated database RPC and preserve response shape', async () => {
  const packageRow = { packageId: 'pkg-10', monthlyFeeCents: 180000, effectiveOn: '2026-10-01', updatedCustomers: 3 };
  const supabase = createSupabase({ data: packageRow, error: null });
  const result = await updatePackageMonthlyFee({
    supabase,
    organizationId: 'org-1',
    packageId: 'pkg-10',
    monthlyFeeCents: 180000,
  });

  assert.deepEqual(supabase.calls, [{
    name: 'set_package_monthly_fee',
    args: { p_organization_id: 'org-1', p_package_id: 'pkg-10', p_monthly_fee_cents: 180000 },
  }]);
  assert.deepEqual(result, { package: packageRow });
});

test('monthly invoice generation calls the organization-scoped RPC with an ISO month start', async () => {
  const response = { period: '2026-10', generated: 2, existing: 4, unpriced: 1, total: 6 };
  const supabase = createSupabase({ data: response, error: null });
  const result = await generateMonthlyInvoices({
    supabase,
    organizationId: 'org-1',
    billingMonth: '2026-10',
    issueDate: '2026-10-07',
    dueDate: '2026-10-15',
  });

  assert.deepEqual(supabase.calls, [{
    name: 'generate_monthly_invoices',
    args: { p_organization_id: 'org-1', p_period: '2026-10-01', p_issued_on: '2026-10-07', p_due_date: '2026-10-15' },
  }]);
  assert.deepEqual(result, response);
});

test('billing RPC errors and unconfirmed results are not reported as successful', async () => {
  const databaseError = new Error('Administrator access required');
  await assert.rejects(
    updatePackageMonthlyFee({
      supabase: createSupabase({ data: null, error: databaseError }),
      organizationId: 'org-1', packageId: 'pkg-10', monthlyFeeCents: 180000,
    }),
    (error) => error === databaseError,
  );

  await assert.rejects(
    updatePackageMonthlyFee({
      supabase: createSupabase({ data: { packageId: 'different' }, error: null }),
      organizationId: 'org-1', packageId: 'pkg-10', monthlyFeeCents: 180000,
    }),
    /could not be confirmed/,
  );

  await assert.rejects(
    generateMonthlyInvoices({
      supabase: createSupabase({ data: { period: '2026-09', generated: 1 }, error: null }),
      organizationId: 'org-1', billingMonth: '2026-10', issueDate: '2026-10-07', dueDate: '2026-10-15',
    }),
    /could not be confirmed/,
  );
});
