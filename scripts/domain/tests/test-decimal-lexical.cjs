'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compareDecimalLexical,
  decimalProductWithin,
  isDecimalLexical,
  parseDecimalLexical,
} = require('../lib/decimal-lexical.cjs');

test('accepts explicit finite base-10 lexical values without binary coercion', () => {
  for (const value of ['0', '0.00', '100', '100.25', '-1', '-0.25']) {
    assert.equal(isDecimalLexical(value), true, value);
  }
  for (const value of [0, 1.2, true, '01', '+1', '1.', '.1', '1e2', '-0', '-0.0']) {
    assert.equal(isDecimalLexical(value), false, String(value));
  }
});

test('compares decimals exactly across different lexical scales', () => {
  assert.equal(compareDecimalLexical('0.10', '0.100'), 0);
  assert.equal(compareDecimalLexical('100.20', '100.3'), -1);
  assert.equal(compareDecimalLexical('-0.01', '0'), -1);
  assert.equal(compareDecimalLexical('9007199254740993.00', '9007199254740992.99'), 1);
});

test('parses coefficients and scales without IEEE-754 precision loss', () => {
  assert.deepEqual(
    parseDecimalLexical('9007199254740993.0010'),
    { coefficient: 90071992547409930010n, scale: 4 },
  );
});

test('checks rounded reciprocal products using exact integer arithmetic', () => {
  assert.equal(
    decimalProductWithin('0.8770391159445711', '1.1402', '1', '0.0000000000000001'),
    true,
  );
  assert.equal(
    decimalProductWithin('0.9000', '1.1402', '1', '0.0000000000000001'),
    false,
  );
});
