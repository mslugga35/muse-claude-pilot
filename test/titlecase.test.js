import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleCase } from '../src/titlecase.js';

test('AT1 capitalizes each word', () => {
  assert.equal(titleCase('hello world'), 'Hello World');
});

test('AT2 normalizes word casing', () => {
  assert.equal(titleCase('hELLO wORLD'), 'Hello World');
});

test('AT3 trims and collapses whitespace', () => {
  assert.equal(titleCase('  a   b  '), 'A B');
});

test('AT4 non-string throws TypeError', () => {
  assert.throws(() => titleCase(null), TypeError);
});
