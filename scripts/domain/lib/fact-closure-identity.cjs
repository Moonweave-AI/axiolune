'use strict';

const {
  identityKeyDigest,
} = require('./identity-contract-compiler.cjs');
const {
  parseUtcInstantNanoseconds,
} = require('./instant-lexical.cjs');

const CLOSURE_IDENTITY_BASE = 'https://axiolune.ai/data/fact-closure-assertion';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NANOSECONDS_PER_SECOND = 1_000_000_000n;

function floorDivide(dividend, divisor) {
  let quotient = dividend / divisor;
  if (dividend % divisor < 0n) quotient -= 1n;
  return quotient;
}

function canonicalUtcInstantLexical(value) {
  const nanoseconds = parseUtcInstantNanoseconds(value);
  const wholeSeconds = floorDivide(nanoseconds, NANOSECONDS_PER_SECOND);
  const fraction = nanoseconds - wholeSeconds * NANOSECONDS_PER_SECOND;
  const milliseconds = wholeSeconds * 1_000n;
  if (milliseconds < BigInt(Number.MIN_SAFE_INTEGER)
      || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError('UTC instant lies outside the safe ECMAScript Date range');
  }
  const base = new Date(Number(milliseconds)).toISOString().replace('.000Z', '');
  if (fraction === 0n) return `${base}Z`;
  return `${base}.${fraction.toString().padStart(9, '0').replace(/0+$/u, '')}Z`;
}

function iriTerm(value) {
  return `<${value}>`;
}

function typedLiteral(value, datatype) {
  return `${JSON.stringify(String(value))}^^<${XSD}${datatype}>`;
}

function buildFactClosureAssertionIri(closure) {
  const names = [
    'targetVersion', 'axis', 'closedAt', 'causeKind', 'causeVersionPresent',
  ];
  const terms = {
    targetVersion: iriTerm(closure.targetVersionIri),
    axis: typedLiteral(closure.axis, 'string'),
    closedAt: typedLiteral(canonicalUtcInstantLexical(closure.closedAt), 'dateTimeStamp'),
    causeKind: typedLiteral(closure.causeKind, 'string'),
    causeVersionPresent: typedLiteral(
      closure.causeKind === 'successor' ? 'true' : 'false',
      'boolean',
    ),
  };
  if (closure.causeKind === 'successor') {
    names.push('causeVersion');
    terms.causeVersion = iriTerm(closure.causeVersionIri);
  }
  names.push('evidenceRef', 'generatingContextRef');
  terms.evidenceRef = iriTerm(closure.evidenceRef);
  terms.generatingContextRef = iriTerm(closure.generatingContextRef);
  const digest = identityKeyDigest(
    names.map((name) => ({ name })),
    terms,
  ).toString('hex');
  return `${CLOSURE_IDENTITY_BASE}/sha256-${digest}`;
}

module.exports = {
  buildFactClosureAssertionIri,
  canonicalUtcInstantLexical,
};
