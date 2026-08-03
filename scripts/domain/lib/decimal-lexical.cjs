'use strict';

const DECIMAL_LEXICAL_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

function isDecimalLexical(value) {
  if (typeof value !== 'string' || !DECIMAL_LEXICAL_RE.test(value)) return false;
  return !/^-0(?:\.0+)?$/u.test(value);
}

function parseDecimalLexical(value) {
  if (!isDecimalLexical(value)) {
    throw new TypeError(`invalid explicit decimal lexical value ${String(value)}`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${integer}${fraction}`);
  return {
    coefficient: negative ? -coefficient : coefficient,
    scale: fraction.length,
  };
}

function powerOfTen(exponent) {
  if (!Number.isSafeInteger(exponent) || exponent < 0) {
    throw new TypeError('decimal scale must be a non-negative safe integer');
  }
  return 10n ** BigInt(exponent);
}

function align(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.coefficient * powerOfTen(scale - left.scale),
    right: right.coefficient * powerOfTen(scale - right.scale),
  };
}

function compareDecimalLexical(leftValue, rightValue) {
  const { left, right } = align(
    parseDecimalLexical(leftValue),
    parseDecimalLexical(rightValue),
  );
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function decimalProductWithin(leftValue, rightValue, targetValue, toleranceValue) {
  const left = parseDecimalLexical(leftValue);
  const right = parseDecimalLexical(rightValue);
  const product = {
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  };
  const target = parseDecimalLexical(targetValue);
  const tolerance = parseDecimalLexical(toleranceValue);
  if (tolerance.coefficient < 0n) throw new TypeError('decimal tolerance must be non-negative');
  const scale = Math.max(product.scale, target.scale, tolerance.scale);
  const scaledProduct = product.coefficient * powerOfTen(scale - product.scale);
  const scaledTarget = target.coefficient * powerOfTen(scale - target.scale);
  const difference = scaledProduct >= scaledTarget
    ? scaledProduct - scaledTarget
    : scaledTarget - scaledProduct;
  const scaledTolerance = tolerance.coefficient
    * powerOfTen(scale - tolerance.scale);
  return difference <= scaledTolerance;
}

module.exports = {
  compareDecimalLexical,
  decimalProductWithin,
  isDecimalLexical,
  parseDecimalLexical,
};
