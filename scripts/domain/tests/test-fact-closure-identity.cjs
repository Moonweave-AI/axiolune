#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildFactClosureAssertionIri,
  canonicalUtcInstantLexical,
} = require('../lib/fact-closure-identity.cjs');

function successorClosure(overrides = {}) {
  return {
    targetVersionIri: 'urn:fact:price:v0',
    axis: 'knowledge',
    closedAt: '2026-07-31T10:30:00Z',
    causeKind: 'successor',
    causeVersionIri: 'urn:fact:price:v1',
    evidenceRef: 'urn:evidence:price-correction-r1',
    generatingContextRef: 'urn:run:market-data-v1',
    ...overrides,
  };
}

test('canonical UTC instant removes semantically redundant fractional zeroes', () => {
  assert.equal(
    canonicalUtcInstantLexical('2026-07-31T10:30:00.100000000Z'),
    '2026-07-31T10:30:00.1Z',
  );
  assert.equal(
    canonicalUtcInstantLexical('2026-07-31T10:30:00.000000000Z'),
    '2026-07-31T10:30:00Z',
  );
});

test('equivalent dateTimeStamp lexicals produce one closure IRI', () => {
  assert.equal(
    buildFactClosureAssertionIri(successorClosure({
      closedAt: '2026-07-31T10:30:00.100000000Z',
    })),
    buildFactClosureAssertionIri(successorClosure({
      closedAt: '2026-07-31T10:30:00.1Z',
    })),
  );
});

test('each identity-frame component changes the closure IRI', () => {
  const baseline = buildFactClosureAssertionIri(successorClosure());
  for (const [field, value] of [
    ['targetVersionIri', 'urn:fact:other:v0'],
    ['axis', 'availability'],
    ['closedAt', '2026-07-31T10:30:01Z'],
    ['causeKind', 'retraction'],
    ['causeVersionIri', 'urn:fact:price:v2'],
    ['evidenceRef', 'urn:evidence:other'],
    ['generatingContextRef', 'urn:run:other'],
  ]) {
    assert.notEqual(buildFactClosureAssertionIri(successorClosure({ [field]: value })), baseline);
  }
});

test('invalid calendar instants and missing successor versions fail closed', () => {
  assert.throws(
    () => buildFactClosureAssertionIri(successorClosure({
      closedAt: '2026-02-30T10:30:00Z',
    })),
    /invalid UTC instant lexical value/u,
  );
  assert.throws(
    () => buildFactClosureAssertionIri(successorClosure({
      causeVersionIri: undefined,
    })),
    /INVALID_CANONICAL_RDF_TERM/u,
  );
});
