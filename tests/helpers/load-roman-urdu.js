import { loadLanguageResources } from '../../src/language.js';

if (!(await loadLanguageResources('ur-Latn'))) {
  throw new Error('Roman Urdu test resources could not be loaded.');
}
