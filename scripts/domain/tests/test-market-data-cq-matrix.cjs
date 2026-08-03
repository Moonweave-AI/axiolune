'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  SUPPORTED_CQS,
  loadMarketDataCqMatrix,
} = require('../lib/market-data-cq-matrix.cjs');

test('Market Data CQ matrix executes exact positive and negative discoveries', () => {
  const matrix = loadMarketDataCqMatrix();
  assert.equal(matrix.positiveCount, 7);
  assert.equal(matrix.negativeCount, 44);
  assert.equal(matrix.cases.size, 51);
  assert.equal(matrix.outcomes.size, 51);
  for (const outcome of matrix.outcomes.values()) assert.equal(outcome.ok, true);
  for (const cqId of SUPPORTED_CQS) {
    const cases = [...matrix.cases.values()].filter((entry) => entry.cqId === cqId);
    assert.ok(cases.some((entry) => entry.polarity === 'positive'), cqId);
    assert.ok(cases.some((entry) => entry.polarity === 'negative'), cqId);
  }
});
