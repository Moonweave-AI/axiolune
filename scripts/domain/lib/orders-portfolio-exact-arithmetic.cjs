'use strict';

const ROUNDING_MODES = Object.freeze(['ceiling', 'floor', 'half-even', 'half-up']);
const VALUATION_STAGES = Object.freeze(['direct-unit-product', 'fx-conversion']);
const COST_BASIS_STAGES = Object.freeze([
  'opening-direct-unit-product',
  'fee-allocation',
  'remaining-basis-proration',
  'fx-conversion',
]);

const DEFAULT_VALUATION_PRECISION_POLICY = Object.freeze({
  amountScale: 6,
  arithmetic: 'exact-rational',
  intermediate: 'unbounded-integer',
  policyId: 'axiolune-direct-unit-valuation-precision-v1',
  quantityScale: 6,
  rateScale: 6,
  schemaVersion: '1.0',
});

const DEFAULT_VALUATION_ROUNDING_POLICY = Object.freeze({
  mode: 'half-even',
  outputScale: 6,
  policyId: 'axiolune-direct-unit-valuation-rounding-v1',
  schemaVersion: '1.0',
  stages: VALUATION_STAGES,
});

const DEFAULT_COST_BASIS_PRECISION_POLICY = Object.freeze({
  amountScale: 6,
  arithmetic: 'exact-rational',
  intermediate: 'unbounded-integer',
  policyId: 'axiolune-cost-basis-precision-v1',
  quantityScale: 6,
  rateScale: 6,
  schemaVersion: '1.0',
});

const DEFAULT_COST_BASIS_ROUNDING_POLICY = Object.freeze({
  mode: 'half-even',
  outputScale: 6,
  policyId: 'axiolune-cost-basis-rounding-v1',
  schemaVersion: '1.0',
  stages: COST_BASIS_STAGES,
});

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function validScale(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 18;
}

function isExactPrecisionPolicy(value, policyId) {
  return hasExactKeys(value, [
    'amountScale',
    'arithmetic',
    'intermediate',
    'policyId',
    'quantityScale',
    'rateScale',
    'schemaVersion',
  ])
    && value.schemaVersion === '1.0'
    && value.policyId === policyId
    && value.arithmetic === 'exact-rational'
    && value.intermediate === 'unbounded-integer'
    && validScale(value.amountScale)
    && validScale(value.quantityScale)
    && validScale(value.rateScale);
}

function isExactRoundingPolicy(value, policyId, stages) {
  return hasExactKeys(value, [
    'mode',
    'outputScale',
    'policyId',
    'schemaVersion',
    'stages',
  ])
    && value.schemaVersion === '1.0'
    && value.policyId === policyId
    && ROUNDING_MODES.includes(value.mode)
    && validScale(value.outputScale)
    && Array.isArray(value.stages)
    && value.stages.length === stages.length
    && value.stages.every((stage, index) => stage === stages[index]);
}

function isValuationPrecisionPolicy(value) {
  return isExactPrecisionPolicy(value, 'axiolune-direct-unit-valuation-precision-v1');
}

function isValuationRoundingPolicy(value) {
  return isExactRoundingPolicy(
    value,
    'axiolune-direct-unit-valuation-rounding-v1',
    VALUATION_STAGES,
  );
}

function isCostBasisPrecisionPolicy(value) {
  return isExactPrecisionPolicy(value, 'axiolune-cost-basis-precision-v1');
}

function isCostBasisRoundingPolicy(value) {
  return isExactRoundingPolicy(
    value,
    'axiolune-cost-basis-rounding-v1',
    COST_BASIS_STAGES,
  );
}

function powerOfTen(exponent) {
  if (!validScale(exponent)) throw new TypeError('scale exponent is outside the exact arithmetic profile');
  return 10n ** BigInt(exponent);
}

function integer(value, label) {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe scaled integer`);
  return BigInt(value);
}

function positiveDenominator(value, label) {
  const result = integer(value, label);
  if (result <= 0n) throw new RangeError(`${label} must be positive`);
  return result;
}

function quantizeRational(numeratorValue, denominatorValue, mode) {
  const numerator = integer(numeratorValue, 'numerator');
  const denominator = positiveDenominator(denominatorValue, 'denominator');
  if (!ROUNDING_MODES.includes(mode)) throw new TypeError(`unsupported rounding mode ${String(mode)}`);
  if (numerator === 0n) return 0n;

  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;
  if (remainder === 0n) return negative ? -quotient : quotient;

  if (mode === 'floor') return negative ? -(quotient + 1n) : quotient;
  if (mode === 'ceiling') return negative ? -quotient : quotient + 1n;

  const doubled = remainder * 2n;
  if (doubled > denominator
      || (doubled === denominator && (mode === 'half-up' || quotient % 2n !== 0n))) {
    quotient += 1n;
  }
  return negative ? -quotient : quotient;
}

function scaledProduct(leftRaw, leftScale, rightRaw, rightScale, outputScale, mode) {
  const numerator = integer(leftRaw, 'leftRaw') * integer(rightRaw, 'rightRaw')
    * powerOfTen(outputScale);
  const denominator = powerOfTen(leftScale) * powerOfTen(rightScale);
  return quantizeRational(numerator, denominator, mode);
}

function directUnitValueRaw(quantityRaw, priceRaw, precisionPolicy, roundingPolicy) {
  if (!isValuationPrecisionPolicy(precisionPolicy)) throw new TypeError('invalid valuation precision policy');
  if (!isValuationRoundingPolicy(roundingPolicy)) throw new TypeError('invalid valuation rounding policy');
  if (roundingPolicy.outputScale !== precisionPolicy.amountScale) {
    throw new TypeError('valuation output scale differs from the amount scale');
  }
  return scaledProduct(
    quantityRaw,
    precisionPolicy.quantityScale,
    priceRaw,
    precisionPolicy.amountScale,
    roundingPolicy.outputScale,
    roundingPolicy.mode,
  );
}

function costBasisDirectUnitValueRaw(quantityRaw, priceRaw, precisionPolicy, roundingPolicy) {
  if (!isCostBasisPrecisionPolicy(precisionPolicy)) throw new TypeError('invalid cost-basis precision policy');
  if (!isCostBasisRoundingPolicy(roundingPolicy)) throw new TypeError('invalid cost-basis rounding policy');
  if (roundingPolicy.outputScale !== precisionPolicy.amountScale) {
    throw new TypeError('cost-basis output scale differs from the amount scale');
  }
  return scaledProduct(
    quantityRaw,
    precisionPolicy.quantityScale,
    priceRaw,
    precisionPolicy.amountScale,
    roundingPolicy.outputScale,
    roundingPolicy.mode,
  );
}

function remainingBasisRaw(openingBasisRaw, originalQuantityRaw, remainingQuantityRaw, precisionPolicy, roundingPolicy) {
  if (!isCostBasisPrecisionPolicy(precisionPolicy)) throw new TypeError('invalid cost-basis precision policy');
  if (!isCostBasisRoundingPolicy(roundingPolicy)) throw new TypeError('invalid cost-basis rounding policy');
  const original = integer(originalQuantityRaw, 'originalQuantityRaw');
  const remaining = integer(remainingQuantityRaw, 'remainingQuantityRaw');
  if (original === 0n) throw new RangeError('original quantity must be non-zero');
  if ((original < 0n) !== (remaining < 0n) || (remaining < 0n ? -remaining : remaining) > (original < 0n ? -original : original)) {
    throw new RangeError('remaining quantity must preserve sign and not exceed original quantity');
  }
  const absoluteOriginal = original < 0n ? -original : original;
  const absoluteRemaining = remaining < 0n ? -remaining : remaining;
  return quantizeRational(
    integer(openingBasisRaw, 'openingBasisRaw') * absoluteRemaining,
    absoluteOriginal,
    roundingPolicy.mode,
  );
}

function fxValueRaw(inputRaw, rateRaw, direction, precisionPolicy, roundingPolicy) {
  const valuationPolicies = isValuationPrecisionPolicy(precisionPolicy)
    && isValuationRoundingPolicy(roundingPolicy);
  const costBasisPolicies = isCostBasisPrecisionPolicy(precisionPolicy)
    && isCostBasisRoundingPolicy(roundingPolicy);
  if (!valuationPolicies && !costBasisPolicies) throw new TypeError('invalid or mismatched FX precision/rounding policies');
  if (roundingPolicy.outputScale !== precisionPolicy.amountScale) {
    throw new TypeError('FX output scale differs from the amount scale');
  }
  const input = integer(inputRaw, 'inputRaw');
  const rate = positiveDenominator(rateRaw, 'rateRaw');
  const outputScaleFactor = powerOfTen(roundingPolicy.outputScale);
  const inputScaleFactor = powerOfTen(precisionPolicy.amountScale);
  const rateScaleFactor = powerOfTen(precisionPolicy.rateScale);
  if (direction === 'baseToQuote') {
    return quantizeRational(
      input * rate * outputScaleFactor,
      inputScaleFactor * rateScaleFactor,
      roundingPolicy.mode,
    );
  }
  if (direction === 'quoteToBase') {
    return quantizeRational(
      input * rateScaleFactor * outputScaleFactor,
      inputScaleFactor * rate,
      roundingPolicy.mode,
    );
  }
  throw new TypeError(`unsupported FX direction ${String(direction)}`);
}

function safeNumber(value, label) {
  const result = integer(value, label);
  if (result < BigInt(Number.MIN_SAFE_INTEGER) || result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} is outside the safe canonical scaled-integer range`);
  }
  return Number(result);
}

module.exports = {
  COST_BASIS_STAGES,
  DEFAULT_COST_BASIS_PRECISION_POLICY,
  DEFAULT_COST_BASIS_ROUNDING_POLICY,
  DEFAULT_VALUATION_PRECISION_POLICY,
  DEFAULT_VALUATION_ROUNDING_POLICY,
  ROUNDING_MODES,
  VALUATION_STAGES,
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
  scaledProduct,
};
