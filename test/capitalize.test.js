import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capitalize } from '../src/capitalize.js';

test('AT1 uppercases first character', () => {
  assert.equal(capitalize('hello'), 'Hello');
});

test('AT2 empty string returns empty string', () => {
  assert.equal(capitalize(''), '');
});

test('AT3 already capitalized is unchanged', () => {
  assert.equal(capitalize('Hello'), 'Hello');
});

test('AT4 non-strings throw TypeError', () => {
  assert.throws(() => capitalize(null), TypeError);
  assert.throws(() => capitalize(42), TypeError);
});
