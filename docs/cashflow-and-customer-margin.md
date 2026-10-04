# Cashflow and customer contribution

## Global cashflow

The Owner/Admin cashflow view is cash-basis reporting in PKR. Income is the sum of posted rows in `receipts`, grouped by their recorded receipt date; issued bills, unpaid bills, receipt allocations, and carry-forward credit are not income. Operating costs are the recorded cash outflows in `cashflow_expenses`, excluding `partner_profit`. Partner profit is shown separately as a partner distribution and is included in net cashflow.

- **Operating profit** = actual receipts − recorded operating cash expenses.
- **Net cashflow** = operating profit − recorded partner distributions.

Expenses capture a server-generated `timestamptz` instant in UTC. The app displays that instant using the viewer's local time zone. Expenses and cost history are append-only; a correction is a new entry, and duplicate request IDs are idempotent.

## Per-customer contribution estimate

Admins can add effective-dated monthly service-cost assumptions in `customer_service_cost_history`. These values are used only in the customer's Admin profile to estimate contribution from posted cash receipts. A service-cost amount is not another payment or cash outflow and is never included in global operating expenses; this avoids counting a per-customer allocation in addition to the actual provider/bandwidth bill.

The estimate subtracts recorded monthly cost for completed service months with effective cost history from actual posted receipts to date. Month periods without a recorded cost are called out as uncovered and are not treated as zero cost. The current incomplete service month is excluded; there is no partial-month proration. A connection date is preferred for tenure, with the server-created customer record date as the clearly labeled fallback. If no start date or no applicable cost history exists, contribution is shown as unknown.

Neither view is an accrual ledger or audited set of accounts. Results are estimates based on cash receipts and expenses actually recorded in this portal, and do not include unrecorded transactions, taxes, receivables, inventory valuation, or other accounting adjustments.

## Database change

Migration `20261004133849_admin_cashflow_customer_costs.sql` creates two new RLS-protected, same-organization Owner/Admin-only ledgers and recorder RPCs. It does not backfill the legacy `expenses` table or interpret the pre-existing private `monthly_purchase_cost_cents` field, because that field has no effective-date history. It inserts no financial rows and does not modify customer, RouterOS, RADIUS, authentication, invitation, or production data.
