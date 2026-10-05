export function togglePasswordVisibility(input, button, translate = (message) => message) {
  if (!input || !button || !['password', 'text'].includes(input.type)) return null;

  const visible = input.type === 'password';
  const textKey = visible ? 'Hide' : 'Show';
  const labelKey = visible ? 'Hide password' : 'Show password';

  input.type = visible ? 'text' : 'password';
  button.dataset.i18n = textKey;
  button.dataset.i18nAriaLabel = labelKey;
  button.textContent = translate(textKey);
  button.setAttribute('aria-label', translate(labelKey));
  button.setAttribute('aria-pressed', String(visible));

  return visible;
}
