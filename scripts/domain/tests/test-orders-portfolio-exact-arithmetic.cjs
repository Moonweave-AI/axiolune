'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_COST_BASIS_PRECISION_POLICY,
  DEFAULT_COST_BASIS_ROUNDING_POLICY,
  DEFAULT_VALUATION_PRECISION_POLICY,
  DEFAULT_VALUATION_ROUNDING_POLICY,
  costBasisDirectUnitValueRaw,
  directUnitValueRaw,
  fxValueRaw,
  isCostBasisPrecisionPolicy,
  isCostBasisRoundingPolicy,
  isValuationPrecisionPolicy,
  isValuationRoundingPolicy,
  quantizeRational,
  remainingBasisRaw,
  safeNumber,
} = require('../lib/orders-portfolio-exact-arithmetic.cjs');

function rounding(mode) {
  return { ...DEFAULT_VALUATION_ROUNDING_POLICY, mode };
}

test('quantizeRational implements signed floor, ceiling, half-up, and half-even exactly', () => {
  assert.equal(quantizeRational(5n, 2n, 'floor'), 2n);
  assert.equal(quantizeRational(5n, 2n, 'ceiling'), 3n);
  assert.equal(quantizeRational(5n, 2n, 'half-up'), 3n);
  assert.equal(quantizeRational(5n, 2n, 'half-even'), 2n);
  assert.equal(quantizeRational(7n, 2n, 'half-even'), 4n);

  assert.equal(quantizeRational(-5n, 2n, 'floor'), -3n);
  assert.equal(quantizeRational(-5n, 2n, 'ceiling'), -2n);
  assert.equal(quantizeRational(-5n, 2n, 'half-up'), -3n);
  assert.equal(quantizeRational(-5n, 2n, 'half-even'), -2n);
  assert.equal(quantizeRational(-7n, 2n, 'half-even'), -4n);
});

test('direct-unit valuation preserves scale and uses an unbounded BigInt intermediate', () => {
  assert.equal(
    directUnitValueRaw(2_000_000, 3_000_000, DEFAULT_VALUATION_PRECISION_POLICY, DEFAULT_VALUATION_ROUNDING_POLICY),
    6_000_000n,
  );
  assert.equal(
    directUnitValueRaw(2, 3, DEFAULT_VALUATION_PRECISION_POLICY, DEFAULT_VALUATION_ROUNDING_POLICY),
    0n,
    'the former 2×3 accepted vector was one million times too large',
  );
  assert.equal(
    directUnitValueRaw(
      3_000_000_001,
      3_000_000_001,
      DEFAULT_VALUATION_PRECISION_POLICY,
      DEFAULT_VALUATION_ROUNDING_POLICY,
    ),
    9_000_000_006_000n,
    'the raw product exceeds Number.MAX_SAFE_INTEGER but the quantized result remains exact',
  );
});

test('direct-unit valuation replays positive and negative half ties under the locked mode', () => {
  assert.equal(directUnitValueRaw(1, 500_000, DEFAULT_VALUATION_PRECISION_POLICY, rounding('half-even')), 0n);
  assert.equal(directUnitValueRaw(1, 500_000, DEFAULT_VALUATION_PRECISION_POLICY, rounding('half-up')), 1n);
  assert.equal(directUnitValueRaw(1, 500_000, DEFAULT_VALUATION_PRECISION_POLICY, rounding('floor')), 0n);
  assert.equal(directUnitValueRaw(1, 500_000, DEFAULT_VALUATION_PRECISION_POLICY, rounding('ceiling')), 1n);

  assert.equal(directUnitValueRaw(-1, 500_000, DEFAULT_VALUATION_PRECISION_POLICY, rounding('half-even')), 0n);
  assert.equal(directUnitValueRaw(-1, 500_000, DEFAULT_VALUATION_PRECISION_POLICY, rounding('half-up')), -1n);
  assert.equal(directUnitValueRaw(-1, 500_000, DEFAULT_VALUATION_PRECISION_POLICY, rounding('floor')), -1n);
  assert.equal(directUnitValueRaw(-1, 500_000, DEFAULT_VALUATION_PRECISION_POLICY, rounding('ceiling')), 0n);
});

test('FX replay is direction-correct and quantizes non-divisible rates with the locked policy', () => {
  assert.equal(
    fxValueRaw(6_000_000, 2_000_000, 'baseToQuote', DEFAULT_VALUATION_PRECISION_POLICY, DEFAULT_VALUATION_ROUNDING_POLICY),
    12_000_000n,
  );
  assert.equal(
    fxValueRaw(6_000_000, 2_000_000, 'quoteToBase', DEFAULT_VALUATION_PRECISION_POLICY, DEFAULT_VALUATION_ROUNDING_POLICY),
    3_000_000n,
  );
  assert.equal(
    fxValueRaw(1, 2_000_000, 'quoteToBase', DEFAULT_VALUATION_PRECISION_POLICY, rounding('half-even')),
    0n,
  );
  assert.equal(
    fxValueRaw(1, 2_000_000, 'quoteToBase', DEFAULT_VALUATION_PRECISION_POLICY, rounding('half-up')),
    1n,
  );
});

test('policy schemas are closed and safe canonical integers cannot hide overflow', () => {
  assert.equal(isValuationPrecisionPolicy(DEFAULT_VALUATION_PRECISION_POLICY), true);
  assert.equal(isValuationRoundingPolicy(DEFAULT_VALUATION_ROUNDING_POLICY), true);
  assert.equal(isValuationPrecisionPolicy({ ...DEFAULT_VALUATION_PRECISION_POLICY, privateScale: 6 }), false);
  assert.equal(isValuationRoundingPolicy({ ...DEFAULT_VALUATION_ROUNDING_POLICY, stages: ['fx-conversion'] }), false);
  assert.throws(() => safeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'result'), /safe canonical/u);
  assert.throws(() => quantizeRational(1n, 0n, 'half-even'), /positive/u);
});

test('cost-basis opening and remaining-basis arithmetic are exact and policy-bound', () => {
  assert.equal(
    costBasisDirectUnitValueRaw(
      2_000_000,
      3_000_000,
      DEFAULT_COST_BASIS_PRECISION_POLICY,
      DEFAULT_COST_BASIS_ROUNDING_POLICY,
    ),
    6_000_000n,
  );
  assert.equal(
    remainingBasisRaw(
      1_000_000,
      3_000_000,
      2_000_000,
      DEFAULT_COST_BASIS_PRECISION_POLICY,
      DEFAULT_COST_BASIS_ROUNDING_POLICY,
    ),
    666_667n,
  );
  assert.equal(isCostBasisPrecisionPolicy(DEFAULT_COST_BASIS_PRECISION_POLICY), true);
  assert.equal(isCostBasisRoundingPolicy(DEFAULT_COST_BASIS_ROUNDING_POLICY), true);
  assert.throws(
    () => remainingBasisRaw(
      1_000_000,
      3_000_000,
      -2_000_000,
      DEFAULT_COST_BASIS_PRECISION_POLICY,
      DEFAULT_COST_BASIS_ROUNDING_POLICY,
    ),
    /preserve sign/u,
  );
});
