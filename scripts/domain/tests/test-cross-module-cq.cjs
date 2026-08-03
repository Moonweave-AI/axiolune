'use strict';

const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');
const { isDeepStrictEqual } = require('node:util');

const {
  CQ_FUNCTION_VERSION,
  CrossModuleCqError,
  executeCq,
  executeS5,
} = require('../lib/cross-module-cq.cjs');
const {
  applyMutation,
  loadFixture,
} = require('../lib/strict-fixture-loader.cjs');

const ROOT = path.join(__dirname, '..', '..', '..');
const FIXTURE_DIR = path.join(
  ROOT,
  'tests',
  'm2',
  'fixtures',
  'slice-a',
  'cq-v03',
);

function assembleGraph() {
  const contract = loadFixture(
    path.join(FIXTURE_DIR, 'foundation-market-instrument-graph.yaml'),
    { rootDirectory: FIXTURE_DIR },
  );
  const baseFile = path.resolve(FIXTURE_DIR, contract.baseFixture);
  const graph = structuredClone(loadFixture(baseFile, {
    rootDirectory: path.dirname(baseFile),
  }));
  for (const mutation of contract.baseMutations || []) applyMutation(graph, mutation);
  for (const [collection, additions] of Object.entries(contract.additions || {})) {
    if (graph[collection] === undefined) graph[collection] = [];
    graph[collection].push(...structuredClone(additions));
  }
  return graph;
}

function executeCase(graph, specification, polarity) {
  const candidate = structuredClone(graph);
  for (const mutation of specification.mutations || []) applyMutation(candidate, mutation);
  if (specification.expected.status === 'ok') {
    const rows = executeCq(specification.cqId, candidate, specification.query);
    assert.ok(isDeepStrictEqual(rows, specification.expected.rows), specification.caseId);
    if (polarity === 'positive') assert.ok(rows.length > 0);
    if (polarity === 'negative') assert.equal(rows.length, 0);
    return;
  }
  assert.equal(polarity, 'negative');
  assert.throws(
    () => executeCq(specification.cqId, candidate, specification.query),
    (error) => (
      error instanceof CrossModuleCqError
      && error.code === specification.expected.code
    ),
  );
}

for (const [polarity, name] of [
  ['positive', 'cross-module-positive.yaml'],
  ['negative', 'cross-module-negative.yaml'],
]) {
  const document = loadFixture(path.join(FIXTURE_DIR, name), {
    rootDirectory: FIXTURE_DIR,
  });
  test(`${name} locks the cross-module function version`, () => {
    assert.equal(document.functionVersion, CQ_FUNCTION_VERSION);
  });
  for (const specification of document.cases) {
    test(`${specification.caseId} executes the exact cross-module contract`, () => {
      executeCase(assembleGraph(), specification, polarity);
    });
  }
}

test('CQ-S5 replays different bytes to one exact RDFC-1.0 batch dataset', () => {
  const contract = loadFixture(
    path.join(FIXTURE_DIR, 'cross-module-s5-contract.yaml'),
    { rootDirectory: FIXTURE_DIR },
  );
  const rows = executeS5(contract, { rootDirectory: ROOT });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    resolution: 'identicalCanonicalDataset',
    canonicalization: 'RDFC-1.0',
    targetDataset: 'urn:axiolune:dataset:slice-a:v1',
    batchDefinitionIri: 'urn:axiolune:batch-definition:slice-a:v1',
    batchRunIri: 'urn:axiolune:materialization-batch-run:slice-a:v1',
    sourceSnapshotRootDigest:
      'sha256:6c4f61c804e12a5249bcdea0df0718c42bece652d211e7526d30313cd4d11f7d',
    mappingClosureDigest:
      'sha256:b3425560ead39cb1bc8e254e0606f8295ef11f455c97dfb6a005dffcd1fb02f6',
    outputDatasetDigest:
      'sha256:e63bff56a4bf5689ac4241a726b7fbc9ecf8f35143a8da6872103cc6fceabd29',
    memberGraphDigests: [
      {
        graphIri: 'urn:axiolune:graph:slice-a:identity:v1',
        outputGraphDigest:
          'sha256:02a38f9875367e1232d6351481aaf6bc65a34b99c00ab642475921c29bf51826',
      },
      {
        graphIri: 'urn:axiolune:graph:slice-a:market-data:v1',
        outputGraphDigest:
          'sha256:1808699a30a358de24d4318c6e5cb542fc4658d4d743bc88bbd60b7121ee137b',
      },
    ],
    quadCount: 24,
  });
});

{
  const negativeDocument = loadFixture(
    path.join(FIXTURE_DIR, 'cross-module-s5-negative.yaml'),
    { rootDirectory: FIXTURE_DIR },
  );
  for (const specification of negativeDocument.cases) {
    test(`${specification.caseId} fails closed with its exact diagnostic`, () => {
      const contract = structuredClone(loadFixture(
        path.join(FIXTURE_DIR, negativeDocument.baseContract),
        { rootDirectory: FIXTURE_DIR },
      ));
      for (const mutation of specification.mutations || []) applyMutation(contract, mutation);
      assert.throws(
        () => executeS5(contract, { rootDirectory: ROOT }),
        (error) => (
          error instanceof CrossModuleCqError
          && error.code === specification.expectedCode
        ),
      );
    });
  }
}
