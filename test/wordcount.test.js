import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordCount } from '../src/wordcount.js';

test('AT1 counts words', () => {
  assert.equal(wordCount('one two three'), 3);
});

test('AT2 ignores extra and surrounding whitespace', () => {
  assert.equal(wordCount('  one   two  '), 2);
});

test('AT3 empty and whitespace-only return 0', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('   '), 0);
});

test('AT4 non-string throws TypeError', () => {
  assert.throws(() => wordCount(null), TypeError);
  assert.throws(() => wordCount(42), TypeError);
});
