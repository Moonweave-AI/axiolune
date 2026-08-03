#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const {
  FACT_IDENTITY,
  FACT_VERSION,
  VERSION_OF,
  compileReferenceBindingIndex,
  createReferenceIdentityMaterializer,
} = require('../lib/reference-identity-materializer.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FINANCE = path.join(ROOT, 'ontology', 'domain', 'finance');
const YAML_SCHEMA = yaml.CORE_SCHEMA.withTags(yaml.mergeTag);
const MODULES = [
  ['orders-execution', 39, 26, 13],
  ['portfolio-positions', 74, 52, 22],
  ['market-structure', 19, 11, 8],
  ['market-data', 42, 39, 3],
  ['strategy-research', 32, 28, 4],
  ['market-rules', 23, 23, 0],
];

function loadModule(moduleName) {
  return yaml.load(
    fs.readFileSync(path.join(FINANCE, moduleName, 'module.yaml'), 'utf8'),
    { schema: YAML_SCHEMA },
  );
}

function graphHarness(bindingIndex) {
  const types = new Map();
  const edges = new Map();
  const triples = new Set();

  function values(subject, predicate) {
    return edges.get(subject)?.get(predicate) || new Set();
  }

  function emitIriTriple(subject, predicate, object) {
    if (!edges.has(subject)) edges.set(subject, new Map());
    if (!edges.get(subject).has(predicate)) edges.get(subject).set(predicate, new Set());
    edges.get(subject).get(predicate).add(object);
    triples.add(`${subject}\0${predicate}\0${object}`);
  }

  function emitType(subject, type) {
    if (!types.has(subject)) types.set(subject, new Set());
    types.get(subject).add(type);
    emitIriTriple(subject, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', type);
  }

  return {
    types,
    values,
    triples,
    emitIriTriple,
    emitType,
    materializer: createReferenceIdentityMaterializer({
      bindingIndex,
      emitIriTriple,
      emitType,
      typesOf: (node) => types.get(node) || [],
      iriObjects: values,
    }),
  };
}

test('all six SHACL-runner module binding indexes compile every reference mode from canonical sources', () => {
  for (const [moduleName, total, exact, logical] of MODULES) {
    const index = compileReferenceBindingIndex(loadModule(moduleName), moduleName);
    assert.equal(index.rows.length, total, moduleName);
    assert.equal(index.rows.filter((row) => row.mode === 'exact').length, exact, moduleName);
    assert.equal(index.rows.filter((row) => row.mode === 'logical').length, logical, moduleName);
    assert.equal(new Set(index.rows.map((row) => `${row.subjectType}\0${row.path}`)).size, total);
  }
});

test('materializer emits the complete exact and logical identity closures', () => {
  const index = compileReferenceBindingIndex(loadModule('orders-execution'), 'orders-execution');
  const graph = graphHarness(index);
  const execution = 'https://axiolune.ai/ontology/finance/orders-execution/Execution';
  const streamType = 'https://axiolune.ai/ontology/finance/orders-execution/OrderEventStream';
  const accountType = 'https://axiolune.ai/ontology/finance/foundation/FinancialAccount';
  const streamPath = `${execution}/role/executionStream`;
  const accountPath = `${execution}/role/executionAccount`;
  const owner = 'urn:test:execution:1';
  const stream = 'urn:test:stream:version:1';
  const streamIdentity = `${stream}/logical-identity`;
  const account = 'urn:test:account:logical';

  graph.materializer.emit({
    subject: owner,
    subjectType: execution,
    path: streamPath,
    value: stream,
    expectedType: streamType,
  });
  graph.materializer.emit({
    subject: owner,
    subjectType: execution,
    path: accountPath,
    value: account,
    expectedType: accountType,
  });
  // Reusing the same exact node through the same contract is idempotent at RDF graph level.
  graph.materializer.emit({
    subject: owner,
    subjectType: execution,
    path: streamPath,
    value: stream,
    expectedType: streamType,
  });

  assert.deepEqual(graph.values(stream, VERSION_OF), new Set([streamIdentity]));
  assert.ok(graph.types.get(stream).has(streamType));
  assert.ok(graph.types.get(stream).has(FACT_VERSION));
  assert.ok(graph.types.get(streamIdentity).has(`${streamType}/LogicalIdentity`));
  assert.ok(graph.types.get(streamIdentity).has(FACT_IDENTITY));
  assert.equal(graph.types.get(streamIdentity).has(FACT_VERSION), false);
  assert.equal(graph.values(streamIdentity, VERSION_OF).size, 0);

  assert.ok(graph.types.get(account).has(`${accountType}/LogicalIdentity`));
  assert.ok(graph.types.get(account).has(FACT_IDENTITY));
  assert.equal(graph.types.get(account).has(accountType), false);
  assert.equal(graph.types.get(account).has(FACT_VERSION), false);
  assert.equal(graph.values(account, VERSION_OF).size, 0);
});

test('exact abstract ranges reuse one concrete logical companion without fabricating an abstract companion', () => {
  const index = compileReferenceBindingIndex(loadModule('strategy-research'), 'strategy-research');
  const graph = graphHarness(index);
  const signalGenerator = 'https://axiolune.ai/ontology/finance/strategy-research/SignalGenerator';
  const strategyDefinition = 'https://axiolune.ai/ontology/finance/strategy-research/StrategyDefinition';
  const abstractBinding = index.rows.find((row) => (
    row.mode === 'exact' && row.expectedType === signalGenerator
  ));
  const concreteBinding = index.rows.find((row) => (
    row.mode === 'exact' && row.expectedType === strategyDefinition
  ));
  assert.ok(abstractBinding);
  assert.ok(concreteBinding);
  const version = 'urn:test:strategy:version:1';

  for (const [binding, owner] of [
    [abstractBinding, 'urn:test:abstract-owner'],
    [concreteBinding, 'urn:test:concrete-owner'],
  ]) {
    graph.materializer.emit({
      subject: owner,
      subjectType: binding.subjectType,
      path: binding.path,
      value: version,
      expectedType: binding.expectedType,
      concreteType: strategyDefinition,
    });
  }

  const identity = `${version}/logical-identity`;
  assert.ok(graph.types.get(version).has(signalGenerator));
  assert.ok(graph.types.get(version).has(strategyDefinition));
  assert.ok(graph.types.get(version).has(FACT_VERSION));
  assert.deepEqual(graph.values(version, VERSION_OF), new Set([identity]));
  assert.ok(graph.types.get(identity).has(`${strategyDefinition}/LogicalIdentity`));
  assert.equal(graph.types.get(identity).has(`${signalGenerator}/LogicalIdentity`), false);
  assert.ok(graph.types.get(identity).has(FACT_IDENTITY));

  assert.throws(() => graph.materializer.materializeExactNode({
    node: 'urn:test:abstract-signal-generator',
    expectedType: signalGenerator,
  }), /requires a concrete compatible type/u);
  assert.throws(() => graph.materializer.materializeExactNode({
    node: 'urn:test:unrelated-signal-generator',
    expectedType: signalGenerator,
    concreteType: 'https://axiolune.ai/ontology/finance/strategy-research/BacktestRun',
  }), /requires a concrete compatible type/u);
});

test('binding compilation and materialization fail closed on missing, duplicate, wrong-range, or mixed-mode input', () => {
  const original = loadModule('orders-execution');
  const execution = 'https://axiolune.ai/ontology/finance/orders-execution/Execution';
  const streamType = 'https://axiolune.ai/ontology/finance/orders-execution/OrderEventStream';
  const streamPath = `${execution}/role/executionStream`;
  const accountPath = `${execution}/role/executionAccount`;

  const missing = structuredClone(original);
  missing.domain.constraintBindings = missing.domain.constraintBindings.filter(
    (binding) => binding.targetElement !== streamPath,
  );
  assert.throws(
    () => compileReferenceBindingIndex(missing, 'missing'),
    /exactly one ExactVersionReference\/LogicalReference binding; found 0/u,
  );

  const duplicate = structuredClone(original);
  duplicate.domain.constraintBindings.push(structuredClone(
    duplicate.domain.constraintBindings.find((binding) => binding.targetElement === streamPath),
  ));
  assert.throws(
    () => compileReferenceBindingIndex(duplicate, 'duplicate'),
    /exactly one ExactVersionReference\/LogicalReference binding; found 2/u,
  );

  const index = compileReferenceBindingIndex(original, 'orders-execution');
  const wrongRange = graphHarness(index);
  assert.throws(() => wrongRange.materializer.emit({
    subject: 'urn:test:execution:wrong-range',
    subjectType: execution,
    path: streamPath,
    value: 'urn:test:stream:wrong-range',
    expectedType: 'https://axiolune.ai/ontology/finance/foundation/Party',
  }), /expected range is .*OrderEventStream, not .*Party/u);

  const mixed = graphHarness(index);
  const shared = 'urn:test:shared-reference';
  mixed.materializer.emit({
    subject: 'urn:test:execution:mixed',
    subjectType: execution,
    path: streamPath,
    value: shared,
    expectedType: streamType,
  });
  assert.throws(() => mixed.materializer.emit({
    subject: 'urn:test:execution:mixed',
    subjectType: execution,
    path: accountPath,
    value: shared,
    expectedType: 'https://axiolune.ai/ontology/finance/foundation/FinancialAccount',
  }), /cannot be materialized as logical/u);

  const twoTargets = graphHarness(index);
  twoTargets.emitIriTriple('urn:test:stream:two-targets', VERSION_OF, 'urn:test:identity:1');
  twoTargets.emitIriTriple('urn:test:stream:two-targets', VERSION_OF, 'urn:test:identity:2');
  assert.throws(() => twoTargets.materializer.emit({
    subject: 'urn:test:execution:two-targets',
    subjectType: execution,
    path: streamPath,
    value: 'urn:test:stream:two-targets',
    expectedType: streamType,
  }), /must have exactly one versionOf target/u);

  const authoredLogical = graphHarness(index);
  authoredLogical.emitType('urn:test:logical-with-authored-type', streamType);
  assert.throws(() => authoredLogical.materializer.emit({
    subject: 'urn:test:execution:logical-authored',
    subjectType: execution,
    path: accountPath,
    value: 'urn:test:logical-with-authored-type',
    expectedType: 'https://axiolune.ai/ontology/finance/foundation/FinancialAccount',
  }), /must not carry FactVersion or authored\/non-identity RDF types/u);
});

test('binding index can use a complete cross-module type system without load-order loss', () => {
  const moduleDocument = loadModule('strategy-research');
  const signalGenerator =
    'https://axiolune.ai/ontology/finance/strategy-research/SignalGenerator';
  const factorDefinition =
    'https://axiolune.ai/ontology/finance/strategy-research/FactorDefinition';
  const externalConcrete = 'https://example.test/ontology/ImportedFactorDefinition';
  const closures = new Map([
    [externalConcrete, new Set([factorDefinition, signalGenerator])],
  ]);
  const index = compileReferenceBindingIndex(
    moduleDocument,
    'strategy-research',
    {
      isAbstractType: (typeIri) => typeIri === signalGenerator,
      isTypeCompatible: (concreteType, expectedType) => (
        concreteType === expectedType
          || (closures.get(concreteType) || new Set()).has(expectedType)
      ),
    },
  );
  assert.equal(index.isAbstractType(signalGenerator), true);
  assert.equal(index.isTypeCompatible(externalConcrete, signalGenerator), true);
  assert.throws(
    () => compileReferenceBindingIndex(moduleDocument, 'strategy-research', {}),
    /typeSystem must provide/u,
  );
});
