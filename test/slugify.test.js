import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.js';

test('lowercases and hyphenates words', () => {
  assert.equal(slugify('Add Health Check'), 'add-health-check');
});

test('collapses punctuation and whitespace runs', () => {
  assert.equal(slugify('  Fix: CI -- flaky   test!! '), 'fix-ci-flaky-test');
});

test('strips accents', () => {
  assert.equal(slugify('Café Résumé'), 'cafe-resume');
});

test('caps length at 40 without a trailing hyphen', () => {
  const out = slugify('word '.repeat(20));
  assert.ok(out.length <= 40);
  assert.ok(!out.endsWith('-'));
});

test('returns empty string when nothing is slug-safe', () => {
  assert.equal(slugify('!!!'), '');
});

test('rejects non-strings', () => {
  assert.throws(() => slugify(42), TypeError);
});
