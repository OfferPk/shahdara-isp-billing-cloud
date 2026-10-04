import { isValidBillingMonth } from './bill-dates.js';

const DRILLDOWNS = Object.freeze({
  unpaid: Object.freeze({ target: 'admin-bills', scope: 'unpaid' }),
  overdue: Object.freeze({ target: 'admin-bills', scope: 'overdue' }),
  unpriced: Object.freeze({ target: 'admin-bills', scope: 'unpriced' }),
  'missing-snapshot': Object.freeze({ target: 'customer-list', scope: 'missing-snapshot' }),
});

export function createDashboardDrilldown(card, period) {
  const definition = DRILLDOWNS[card];
  if (!definition || !isValidBillingMonth(period)) return null;
  const query = new URLSearchParams({ scope: definition.scope, period });
  return {
    card,
    target: definition.target,
    scope: definition.scope,
    period,
    hash: `#${definition.target}?${query.toString()}`,
  };
}

export function parseDashboardDrilldownHash(hash) {
  const value = String(hash ?? '');
  if (!value.startsWith('#')) return null;
  const [target, queryText, extra] = value.slice(1).split('?');
  if (!target || !queryText || extra !== undefined) return null;

  const query = new URLSearchParams(queryText);
  const scopes = query.getAll('scope');
  const periods = query.getAll('period');
  if (scopes.length !== 1 || periods.length !== 1 || [...query.keys()].some((key) => !['scope', 'period'].includes(key))) return null;

  const entry = Object.entries(DRILLDOWNS).find(([, definition]) =>
    definition.target === target && definition.scope === scopes[0]);
  if (!entry) return null;
  const [card] = entry;
  return createDashboardDrilldown(card, periods[0]);
}
