import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function extractBlock(source, openingIndex) {
  const braceIndex = source.indexOf('{', openingIndex);
  if (braceIndex < 0) return '';
  let depth = 0;
  for (let index = braceIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(braceIndex + 1, index);
  }
  return '';
}

test('collection-rate facts wrap inside the card at narrow phone widths', () => {
  const mediaIndex = styles.lastIndexOf('@media (max-width: 380px)');
  assert.notEqual(mediaIndex, -1, 'narrow-phone breakpoint should be present');
  const narrowRules = extractBlock(styles, mediaIndex);

  assert.match(narrowRules, /\.dashboard-rate-content\s*\{[^}]*flex-wrap:\s*wrap\s*;/);
  assert.match(narrowRules, /\.dashboard-rate-facts\s*\{[^}]*flex-basis:\s*100%\s*;[^}]*min-width:\s*0\s*;/);
  assert.match(narrowRules, /\.dashboard-rate-facts\s*>\s*div\s*\{[^}]*flex-wrap:\s*wrap\s*;/);
});
