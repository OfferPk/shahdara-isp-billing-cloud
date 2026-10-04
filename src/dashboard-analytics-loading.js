function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

const SKELETON_CARDS = [
  { wide: true, lines: ['title', 'long', 'medium', 'short'] },
  { lines: ['title', 'long', 'medium'] },
  { lines: ['title', 'medium', 'short'] },
  { lines: ['title', 'long', 'short'] },
];

export function renderDashboardAnalyticsSkeleton(t = (message) => message) {
  const cards = SKELETON_CARDS.map(({ wide, lines }) => `<span class="dashboard-analytics-skeleton__card${wide ? ' dashboard-analytics-skeleton__card--wide' : ''}">${lines.map((line) => `<span class="dashboard-analytics-skeleton__line dashboard-analytics-skeleton__line--${line}"></span>`).join('')}</span>`).join('');
  return `<span class="dashboard-analytics-skeleton" aria-hidden="true">${cards}</span><span class="sr-only">${escapeHtml(t('Loading dashboard analytics.'))}</span>`;
}
