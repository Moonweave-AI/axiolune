#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  loadYaml,
  mutate,
  validateRiskModule,
  validateScenario,
} = require('../../../scripts/domain/lib/risk-v03-contract.cjs');
const {
  authenticateSourceClaims,
} = require('../../../scripts/domain/lib/post-trade-risk-source-artifact-inventory.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RISK_FILE = path.join(ROOT, 'ontology', 'domain', 'finance', 'risk', 'module.yaml');
const POSITIVE_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'risk-v03.yaml');
const NEGATIVE_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'negative', 'risk-v03.yaml');

test('Risk typed ontology satisfies the executable RFC-001 section 5.18 contract', () => {
  const result = validateRiskModule(loadYaml(RISK_FILE));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.pending, []);
});

test('all positive Risk CQ fixtures are accepted', () => {
  const positive = loadYaml(POSITIVE_FILE);
  for (const fixture of positive.fixtures) {
    assert.doesNotThrow(
      () => validateScenario(fixture.instance),
      fixture.id,
    );
  }
});

test('every negative Risk fixture fails with its exact semantic violation', () => {
  const positive = loadYaml(POSITIVE_FILE);
  const byId = new Map(positive.fixtures.map((fixture) => [fixture.id, fixture]));
  const negative = loadYaml(NEGATIVE_FILE);
  for (const testCase of negative.cases) {
    let instance = byId.get(testCase.baseFixtureId).instance;
    for (const mutation of testCase.mutations) instance = mutate(instance, mutation);
    if (!(testCase.mutations || []).some((mutation) => (
      /(?:^|\.)(?:sourceArtifactRef|sourceArtifactDigest|sourceLocator)(?:\.|$)/u
        .test(mutation.path)
    ))) {
      instance = authenticateSourceClaims(instance, { namespace: 'risk-source' });
    }
    const expectedCode = testCase.expectedBoundaryViolation || testCase.expectedViolation;
    assert.throws(
      () => validateScenario(instance),
      (error) => error.code === expectedCode,
      testCase.id,
    );
  }
});
