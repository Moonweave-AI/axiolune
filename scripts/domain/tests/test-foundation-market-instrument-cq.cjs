'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  CQ_FUNCTION_VERSION,
  CqContractError,
  executeCq,
} = require('../lib/foundation-market-instrument-cq.cjs');
const {
  applyMutation,
  loadFixture,
} = require('../lib/strict-fixture-loader.cjs');
const { validateScenario } = require('../lib/slice-a-market-contracts.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SLICE_ROOT = path.join(ROOT, 'tests', 'm2', 'fixtures', 'slice-a');
const CQ_DIR = path.join(SLICE_ROOT, 'cq-v03');
const GRAPH_FILE = path.join(CQ_DIR, 'foundation-market-instrument-graph.yaml');
const POSITIVE_FILE = path.join(CQ_DIR, 'foundation-market-instrument-positive.yaml');
const NEGATIVE_FILE = path.join(CQ_DIR, 'foundation-market-instrument-negative.yaml');
const CQ_IDS = new Set([
  'CQ-F1', 'CQ-F2', 'CQ-MS1', 'CQ-MS2', 'CQ-MS3', 'CQ-I1', 'CQ-I2', 'CQ-I3',
]);

function load(file) {
  return loadFixture(file, { rootDirectory: SLICE_ROOT });
}

function assembleGraph() {
  const contract = load(GRAPH_FILE);
  assert.equal(contract.functionVersion, CQ_FUNCTION_VERSION);
  assert.equal(typeof contract.baseFixture, 'string');
  const graph = structuredClone(load(path.resolve(CQ_DIR, contract.baseFixture)));
  for (const mutation of contract.baseMutations || []) applyMutation(graph, mutation);
  for (const [collection, additions] of Object.entries(contract.additions || {})) {
    assert.ok(Array.isArray(additions), `${collection} additions must be an array`);
    if (graph[collection] === undefined) graph[collection] = [];
    assert.ok(Array.isArray(graph[collection]), `${collection} target must be an array`);
    graph[collection].push(...structuredClone(additions));
  }
  return graph;
}

function executeCase(baseGraph, specification) {
  const graph = structuredClone(baseGraph);
  for (const mutation of specification.mutations || []) applyMutation(graph, mutation);
  if (specification.expected?.status === 'ok') {
    const rows = executeCq(specification.cqId, graph, specification.query);
    assert.deepEqual(rows, specification.expected.rows, specification.caseId);
    return;
  }
  assert.equal(specification.expected?.status, 'rejected', `${specification.caseId} status`);
  assert.throws(
    () => executeCq(specification.cqId, graph, specification.query),
    (error) => (
      error instanceof CqContractError
      && error.code === specification.expected.code
    ),
    `${specification.caseId} must reject with ${specification.expected.code}`,
  );
}

const graph = assembleGraph();
const positive = load(POSITIVE_FILE);
const negative = load(NEGATIVE_FILE);

test('CQ fixture graph remains accepted by the existing slice-a structural validator', () => {
  assert.deepEqual(validateScenario(graph), []);
});

test('fixture and executor versions are pinned and all eight CQ IDs have positive and negative coverage', () => {
  assert.equal(positive.functionVersion, CQ_FUNCTION_VERSION);
  assert.equal(negative.functionVersion, CQ_FUNCTION_VERSION);
  assert.equal(positive.graphFixture, path.basename(GRAPH_FILE));
  assert.equal(negative.graphFixture, path.basename(GRAPH_FILE));
  const positiveIds = new Set(positive.cases.map((entry) => entry.cqId));
  const negativeIds = new Set(negative.cases.map((entry) => entry.cqId));
  assert.deepEqual(positiveIds, CQ_IDS);
  assert.deepEqual(negativeIds, CQ_IDS);
  for (const specification of positive.cases) {
    assert.equal(specification.expected?.status, 'ok');
    assert.ok(specification.expected.rows.length > 0, `${specification.caseId} needs concrete bindings`);
  }
  for (const specification of negative.cases) {
    if (specification.expected?.status === 'ok') {
      assert.deepEqual(specification.expected.rows, [], `${specification.caseId} must be an exact empty result`);
    } else {
      assert.equal(specification.expected?.status, 'rejected');
      assert.match(specification.expected.code, /^CQ_/u);
    }
  }
});

for (const specification of positive.cases) {
  test(`positive ${specification.caseId}`, () => executeCase(graph, specification));
}

for (const specification of negative.cases) {
  test(`negative ${specification.caseId}`, () => executeCase(graph, specification));
}
