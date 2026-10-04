let generatedId = 0;
const expandedFeatureKeys = new Set();
const collapsedFeatureKeys = new Set();
const activityDocuments = new WeakSet();
const observedDocuments = new WeakSet();

export const ALL_FEATURE_SELECTOR = [
  '[data-feature-toggle]',
  '.panel:not(.loading-panel):not(.usage-skeleton):not(.auth-panel):not(.config-panel):not(#portal-panel)',
  '.metric-grid',
  '.usage-expiry',
  '.customer-profile-history',
  '.customer-history-block',
].join(',');

function getFeatureTitle(feature) {
  const explicit = String(feature.dataset.featureName ?? '').trim();
  if (explicit) return explicit;
  const label = feature.getAttribute('aria-label')?.replace(/\s+/g, ' ').trim();
  if (label) return label;
  const heading = feature.querySelector('h1, h2, h3, h4, legend');
  const headingText = heading?.textContent?.replace(/\s+/g, ' ').trim();
  if (headingText) return headingText;
  const firstMetricLabel = feature.querySelector('.metric > span, .usage-metric > span')?.textContent?.replace(/\s+/g, ' ').trim();
  if (firstMetricLabel) return firstMetricLabel;
  const formId = feature.querySelector('form[id]')?.id;
  if (formId) return formId.replace(/[-_]+/g, ' ');
  return feature.id.replace(/[-_]+/g, ' ') || 'feature';
}

function getFeatureKey(feature, title) {
  return feature.dataset.featureKey
    || feature.id
    || feature.querySelector('form[id]')?.id
    || `${feature.tagName.toLowerCase()}:${[...feature.classList].join('.')}:${title}`;
}

function trackFeatureRunning(feature, controls) {
  let busyWasObserved = false;
  let timeoutId = null;
  let observer;
  const stop = () => {
    delete feature.dataset.featureRunning;
    observer?.disconnect();
    window.clearTimeout(timeoutId);
  };
  const isBusy = () => controls.some((control) => control.disabled)
    || feature.getAttribute('aria-busy') === 'true';
  const check = () => {
    if (!feature.isConnected) {
      stop();
      return;
    }
    if (isBusy()) {
      busyWasObserved = true;
      feature.dataset.featureRunning = 'true';
    } else if (busyWasObserved) {
      stop();
    }
  };
  observer = new MutationObserver(check);
  observer.observe(feature, { subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-busy'] });
  timeoutId = window.setTimeout(stop, 10 * 60 * 1000);
  queueMicrotask(() => {
    check();
    if (!busyWasObserved) {
      observer.disconnect();
      window.clearTimeout(timeoutId);
    }
  });
}

function installActivityTracking(documentObject) {
  if (!documentObject || activityDocuments.has(documentObject)) return;
  activityDocuments.add(documentObject);
  documentObject.addEventListener('submit', (event) => {
    const FormElement = documentObject.defaultView?.HTMLFormElement;
    const form = FormElement && event.target instanceof FormElement ? event.target : null;
    const feature = form?.closest('[data-feature-toggle]');
    if (!form || !feature) return;
    const controls = [...form.querySelectorAll('button[type="submit"], input[type="submit"]')];
    if (!controls.length) return;
    trackFeatureRunning(feature, controls);
  });
  documentObject.addEventListener('change', (event) => {
    const HtmlElement = documentObject.defaultView?.HTMLElement;
    const control = HtmlElement && event.target instanceof HtmlElement ? event.target : null;
    const feature = control?.closest('[data-feature-toggle]');
    if (!control || !feature) return;
    trackFeatureRunning(feature, [control]);
  });
}

function observeInsertedFeatures(documentObject, selector, formatMessage) {
  if (observedDocuments.has(documentObject)) return;
  observedDocuments.add(documentObject);
  const Observer = documentObject.defaultView?.MutationObserver;
  if (!Observer) return;
  const observer = new Observer((records) => {
    const addedFeatures = new Set();
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(selector)) addedFeatures.add(node);
        for (const descendant of node.querySelectorAll(selector)) addedFeatures.add(descendant);
      }
    }
    for (const feature of addedFeatures) decorateFeature(feature, documentObject, formatMessage);
  });
  observer.observe(documentObject.documentElement, { childList: true, subtree: true });
}

function buildEyeIcon(documentObject) {
  const svg = documentObject.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('feature-toggle__icon');

  const openEye = documentObject.createElementNS('http://www.w3.org/2000/svg', 'g');
  openEye.classList.add('feature-toggle__eye-open');
  const openPath = documentObject.createElementNS('http://www.w3.org/2000/svg', 'path');
  openPath.setAttribute('d', 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z');
  const pupil = documentObject.createElementNS('http://www.w3.org/2000/svg', 'circle');
  pupil.setAttribute('cx', '12');
  pupil.setAttribute('cy', '12');
  pupil.setAttribute('r', '2.6');
  openEye.append(openPath, pupil);

  const closedEye = documentObject.createElementNS('http://www.w3.org/2000/svg', 'g');
  closedEye.classList.add('feature-toggle__eye-closed');
  const closedPath = documentObject.createElementNS('http://www.w3.org/2000/svg', 'path');
  closedPath.setAttribute('d', 'M3 12s3.5-6 9-6c2.2 0 4.1.8 5.7 1.9M21 12s-3.5 6-9 6c-2.2 0-4.1-.8-5.7-1.9M4 4l16 16');
  closedEye.append(closedPath);
  svg.append(openEye, closedEye);
  return svg;
}

function decorateFeature(feature, documentObject, formatMessage) {
  if (feature.dataset.featureToggleReady === 'true') return;
  feature.dataset.featureToggleReady = 'true';
  feature.dataset.featureToggle = 'true';
  const title = getFeatureTitle(feature);
  feature.dataset.featureToggleName = title;
  const key = getFeatureKey(feature, title);
  const expanded = expandedFeatureKeys.has(key)
    || (!collapsedFeatureKeys.has(key) && feature.dataset.featureDefaultExpanded === 'true');
  if (!feature.id) feature.id = `feature-toggle-panel-${++generatedId}`;

  const button = documentObject.createElement('button');
  button.type = 'button';
  button.className = 'feature-toggle-button';
  button.dataset.featureToggleButton = 'true';
  const controlledChildren = [...feature.children];
  const originalInertState = new Map(controlledChildren.map((child) => [child, child.inert]));
  const controlledIds = controlledChildren.map((child) => {
    if (!child.id) child.id = `feature-content-${++generatedId}`;
    return child.id;
  });
  button.setAttribute('aria-controls', controlledIds.join(' '));
  button.setAttribute('aria-expanded', String(expanded));
  button.append(buildEyeIcon(documentObject));
  const text = documentObject.createElement('span');
  text.className = 'feature-toggle__label';
  button.append(text);

  const setExpanded = (nextExpanded) => {
    for (const child of controlledChildren) {
      child.inert = nextExpanded ? originalInertState.get(child) : true;
    }
    button.setAttribute('aria-expanded', String(nextExpanded));
    feature.dataset.featureExpanded = String(nextExpanded);
    text.textContent = formatMessage(nextExpanded ? 'Hide {feature}' : 'Show {feature}', { feature: title });
    button.setAttribute('aria-label', formatMessage(nextExpanded ? 'Hide {feature}' : 'Show {feature}', { feature: title }));
    if (nextExpanded) {
      expandedFeatureKeys.add(key);
      collapsedFeatureKeys.delete(key);
    } else {
      expandedFeatureKeys.delete(key);
      if (feature.dataset.featureDefaultExpanded === 'true') collapsedFeatureKeys.add(key);
      else collapsedFeatureKeys.delete(key);
    }
  };

  button.addEventListener('click', () => setExpanded(button.getAttribute('aria-expanded') !== 'true'));
  feature.insertBefore(button, feature.firstChild);
  setExpanded(expanded);
}

export function initializeFeatureToggles(root, {
  selector = '[data-feature-toggle]',
  formatMessage = (message, values = {}) => message.replace('{feature}', values.feature ?? ''),
  observe = false,
} = {}) {
  const documentObject = root?.nodeType === 9 ? root : root?.ownerDocument;
  if (!documentObject || !root?.querySelectorAll) return 0;
  installActivityTracking(documentObject);
  if (observe) observeInsertedFeatures(documentObject, selector, formatMessage);
  const features = [...root.querySelectorAll(selector)];
  for (const feature of features) decorateFeature(feature, documentObject, formatMessage);
  return features.length;
}

export function refreshFeatureToggleLabels(root, {
  formatMessage = (message, values = {}) => message.replace('{feature}', values.feature ?? ''),
} = {}) {
  for (const button of root?.querySelectorAll?.('[data-feature-toggle-button]') ?? []) {
    const feature = button.parentElement;
    const title = feature?.dataset.featureToggleName ?? getFeatureTitle(feature);
    const expanded = button.getAttribute('aria-expanded') === 'true';
    const label = formatMessage(expanded ? 'Hide {feature}' : 'Show {feature}', { feature: title });
    button.setAttribute('aria-label', label);
    const text = button.querySelector('.feature-toggle__label');
    if (text) text.textContent = label;
  }
}
