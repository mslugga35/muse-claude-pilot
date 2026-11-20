import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncateWords } from '../src/truncate.js';

test('AT1 truncates with ellipsis', () => {
  assert.equal(truncateWords('one two three four', 2), 'one two…');
});

test('AT2 trims and collapses whitespace', () => {
  assert.equal(truncateWords('  one   two  ', 5), 'one two');
});

test('AT3 exact word count has no ellipsis', () => {
  assert.equal(truncateWords('one two', 2), 'one two');
});

test('AT4 invalid maxWords throws RangeError', () => {
  assert.throws(() => truncateWords('a b', 0), RangeError);
  assert.throws(() => truncateWords('a b', 1.5), RangeError);
});

test('AT5 non-string text throws TypeError', () => {
  assert.throws(() => truncateWords(null, 3), TypeError);
});
