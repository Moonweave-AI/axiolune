'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const {
  CQ_FUNCTION_VERSION,
  CqContractError,
  buildIndexes,
  executeCq,
} = require('../lib/orders-portfolio-cq.cjs');
const {
  applyMutation,
  loadFixture,
} = require('../lib/strict-fixture-loader.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_ROOT = path.join(ROOT, 'tests', 'm2', 'fixtures', 'orders-portfolio-cq');

function fixture(name) {
  return loadFixture(path.join(FIXTURE_ROOT, name), { rootDirectory: FIXTURE_ROOT });
}

function digest(relativePath) {
  return `sha256:${crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, relativePath)))
    .digest('hex')}`;
}

const graph = fixture('graph.yaml');
const positive = fixture('positive.yaml');
const negative = fixture('negative.yaml');

test('Orders/Portfolio CQ function and graph contract are version locked', () => {
  assert.equal(CQ_FUNCTION_VERSION, 'axiolune-m2-cq-orders-portfolio/v1');
  assert.equal(graph.contract, CQ_FUNCTION_VERSION);
  assert.equal(positive.contract, CQ_FUNCTION_VERSION);
  assert.equal(negative.contract, CQ_FUNCTION_VERSION);
  assert.equal(buildIndexes(graph).byId.size, 68);
  for (const binding of graph.artifactBindings) {
    assert.equal(digest(binding.repositoryPath), binding.artifactDigest);
  }
});

test('Orders and Portfolio CQ cards lock the executable, fixtures, runtime, and synthetic input bytes', () => {
  for (const relativeCard of [
    'docs/ontology/competency-questions/fin-orders-execution-cq.yaml',
    'docs/ontology/competency-questions/fin-portfolio-positions-cq.yaml',
  ]) {
    const card = yaml.load(fs.readFileSync(path.join(ROOT, relativeCard), 'utf8'));
    const execution = card.joinedExecution;
    assert.equal(execution.functionVersion, CQ_FUNCTION_VERSION);
    for (const [refField, digestField] of [
      ['implementation', 'implementationDigest'],
      ['graphFixture', 'graphFixtureDigest'],
      ['positiveFixture', 'positiveFixtureDigest'],
      ['negativeFixture', 'negativeFixtureDigest'],
    ]) {
      assert.equal(digest(execution[refField]), execution[digestField]);
    }
    for (const lock of [...execution.dependencyLocks, ...execution.artifactLocks]) {
      assert.equal(digest(lock.ref), lock.digest);
    }
    assert.equal(execution.runtime.engine, 'node');
    assert.equal(execution.runtime.version, process.version);
    assert.equal(digest(execution.runtime.dependencyLock), execution.runtime.dependencyLockDigest);
  }
});

test('positive Orders/Portfolio CQ cases match exact ordered result rows', async (t) => {
  const expectedIds = new Set([
    'cq-oe2-accepted-external-order',
    'cq-oe2-rejected-is-empty',
    'cq-oe3-exact-quantity-and-vwap',
    'cq-oe3-no-executions-is-empty',
    'cq-oe4-complete-immutable-trace',
    'cq-oe6-valid-occurrence-sequence',
    'cq-oe6-explicit-counterexample-finding',
    'cq-oe7-complete-cost-basis-graph',
    'cq-oe8-before-knowledge-closure',
    'cq-oe8-at-knowledge-and-availability-boundary',
    'cq-oe9-half-open-facility-window',
    'cq-oe9-after-upper-bound-is-empty',
    'cq-oe11-split-one-to-many-lineage',
    'cq-oe11-aggregation-many-to-one-lineage',
    'cq-pp1-foundation-account-types',
    'cq-pp2-pit-management-mandate',
    'cq-s3-membership-three-axis-snapshot',
    'cq-s3-before-membership-valid-time-is-empty',
    'cq-pp5-group-by-source-currency',
    'cq-pp5-explicit-fx-aggregate',
  ]);
  assert.equal(positive.cases.length, expectedIds.size);
  assert.deepEqual(new Set(positive.cases.map((value) => value.id)), expectedIds);
  for (const candidate of positive.cases) {
    await t.test(candidate.id, () => {
      assert.deepEqual(executeCq(candidate.cqId, graph, candidate.query), candidate.expectedRows);
    });
  }
});

test('CQ-PP5 replays exact direct and FX arithmetic for ontology-compatible single-quotation slices', () => {
  const pivot = positive.pivots.noon;
  const directGraph = structuredClone(graph);
  directGraph.positionValuations = directGraph.positionValuations.slice(0, 2);
  directGraph.fxConversions = [];
  directGraph.fxRates = [];
  assert.deepEqual(
    executeCq('CQ-PP5', directGraph, {
      portfolioLogicalIri: 'urn:portfolio:alpha', targetCurrency: 'USD', pivot,
    }),
    [{
      portfolioLogicalIri: 'urn:portfolio:alpha',
      portfolioValuationVersionIri: 'urn:portfolio-valuation:alpha:v0',
      membershipClosureVersionIri: 'urn:membership-closure:alpha:v0',
      byCurrency: [{ currency: 'USD', amount: '1500', lineCount: 2 }],
      targetCurrency: 'USD',
      convertedTotal: '1500',
      lineCount: 2,
      fxConversionVersionIris: [],
    }],
  );

  const fxGraph = structuredClone(graph);
  fxGraph.positionValuations = [fxGraph.positionValuations[2]];
  assert.deepEqual(
    executeCq('CQ-PP5', fxGraph, {
      portfolioLogicalIri: 'urn:portfolio:alpha', targetCurrency: 'USD', pivot,
    }),
    [{
      portfolioLogicalIri: 'urn:portfolio:alpha',
      portfolioValuationVersionIri: 'urn:portfolio-valuation:alpha:v0',
      membershipClosureVersionIri: 'urn:membership-closure:alpha:v0',
      byCurrency: [{ currency: 'EUR', amount: '200', lineCount: 1 }],
      targetCurrency: 'USD',
      convertedTotal: '220',
      lineCount: 1,
      fxConversionVersionIris: ['urn:fx-conversion:bond-eur-usd:v0'],
    }],
  );

  const signedPositionGraph = structuredClone(graph);
  const signedPosition = structuredClone(signedPositionGraph.holdings[0]);
  signedPosition.id = 'urn:position:alpha-aapl-short:v0';
  signedPosition.logicalId = 'urn:position:alpha-aapl-short';
  signedPosition.quantity.value = '-2';
  signedPositionGraph.positions = [signedPosition];
  const signedLine = structuredClone(signedPositionGraph.positionValuations[0]);
  signedLine.id = 'urn:position-valuation:aapl-short:v0';
  signedLine.logicalId = 'urn:position-valuation:aapl-short';
  signedLine.inputSnapshotVersionIri = signedPosition.id;
  signedLine.marketValue.amount = '-200';
  signedPositionGraph.positionValuations = [signedLine];
  signedPositionGraph.fxConversions = [];
  signedPositionGraph.fxRates = [];
  assert.deepEqual(
    executeCq('CQ-PP5', signedPositionGraph, {
      portfolioLogicalIri: 'urn:portfolio:alpha', targetCurrency: 'USD', pivot,
    }),
    [{
      portfolioLogicalIri: 'urn:portfolio:alpha',
      portfolioValuationVersionIri: 'urn:portfolio-valuation:alpha:v0',
      membershipClosureVersionIri: 'urn:membership-closure:alpha:v0',
      byCurrency: [{ currency: 'USD', amount: '-200', lineCount: 1 }],
      targetCurrency: 'USD',
      convertedTotal: '-200',
      lineCount: 1,
      fxConversionVersionIris: [],
    }],
  );
});

test('negative Orders/Portfolio CQ mutations fail closed with exact typed codes', async (t) => {
  assert.equal(negative.cases.length, 58);
  assert.equal(new Set(negative.cases.map((value) => value.id)).size, negative.cases.length);
  for (const candidate of negative.cases) {
    await t.test(candidate.id, () => {
      const mutated = structuredClone(graph);
      for (const mutation of candidate.mutations) applyMutation(mutated, mutation);
      assert.throws(
        () => executeCq(candidate.cqId, mutated, candidate.query),
        (error) => error instanceof CqContractError
          && error.code === candidate.expectedErrorCode,
      );
    });
  }
});

test('CQ execution is deterministic and does not mutate the materialized graph', () => {
  const before = JSON.stringify(graph);
  const query = positive.cases.find((value) => value.id === 'cq-oe3-exact-quantity-and-vwap');
  const first = executeCq(query.cqId, graph, query.query);
  const second = executeCq(query.cqId, graph, query.query);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(graph), before);
});

test('unsupported CQ IDs fail closed', () => {
  assert.throws(
    () => executeCq('CQ-OE999', graph, {}),
    (error) => error instanceof CqContractError && error.code === 'CQ_UNSUPPORTED',
  );
});
