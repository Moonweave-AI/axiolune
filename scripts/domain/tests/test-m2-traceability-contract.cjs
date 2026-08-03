#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compareEdgeTuple,
  semanticNodeId,
  traceabilityExecutionIndexDigest,
  traceabilityManifestDigest,
  validateTraceabilityExecutionIndex,
  validateTraceabilityManifest,
} = require('../lib/m2-traceability-contract.cjs');
const {
  buildTraceabilityExecutionIndex,
} = require('../lib/m2-traceability-execution-index.cjs');
const {
  computeSelectionDigest,
} = require('../lib/strict-source-locator.cjs');

const DIGEST = `sha256:${'1'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'2'.repeat(64)}`;
const BASE = 'https://axiolune.ai/ontology/finance/test/';

function artifactRef(path) {
  return { kind: 'path', root: 'sourceTree', path };
}

function node(value) {
  return { ...value, nodeId: semanticNodeId(value) };
}

function sourceNode(referenceId, path) {
  const locatorWithoutDigest = {
    kind: 'wholeFile',
    path,
    mediaType: 'application/json',
    extractorProfileRef: artifactRef('scripts/domain/source-extractor-profile.json'),
    extractorProfileDigest: DIGEST,
  };
  const locator = {
    ...locatorWithoutDigest,
    selectionDigest: computeSelectionDigest(locatorWithoutDigest, Buffer.from(`source:${path}`, 'utf8')),
  };
  return node({
    nodeKind: 'sourceLocator',
    referenceId,
    artifactRef: artifactRef(path),
    artifactDigest: DIGEST,
    locator,
  });
}

function buildValidManifest() {
  const termSource = sourceNode('term-authority', 'reference/term-authority.json');
  const identitySource = sourceNode('identity-authority', 'reference/identity-authority.json');
  const term = node({
    nodeKind: 'termCard',
    artifactRef: artifactRef('docs/ontology/term-cards/test.json'),
    artifactDigest: DIGEST,
    publicIri: `${BASE}PriceObservation`,
  });
  const symbol = node({
    nodeKind: 'publicSymbol',
    artifactRef: artifactRef('docs/domain/infrastructure/public-symbol-manifest.json'),
    artifactDigest: DIGEST,
    publicIri: `${BASE}PriceObservation`,
  });
  const identityContract = node({
    nodeKind: 'targetIdentityContract',
    identityManifestRef: artifactRef('mappings/finance/materialized-target-identity-manifest.json'),
    identityManifestDigest: DIGEST,
    contractRef: `${BASE}PriceObservationIdentityContract`,
    contractDigest: DIGEST,
    targetType: `${BASE}PriceObservation`,
  });
  const identityMapping = node({
    nodeKind: 'identityMapping',
    identityManifestRef: artifactRef('mappings/finance/materialized-target-identity-manifest.json'),
    identityManifestDigest: DIGEST,
    mappingRef: `${BASE}PriceObservationMapping`,
    mappingDigest: DIGEST,
    targetType: `${BASE}PriceObservation`,
    contractRef: `${BASE}PriceObservationIdentityContract`,
    contractDigest: DIGEST,
  });
  const identityTerm = node({
    nodeKind: 'identityTermContract',
    identityTermRegistryRef: artifactRef('mappings/finance/identity-term-registry.json'),
    identityTermRegistryDigest: DIGEST,
    termContractRef: `${BASE}VenueIdentityTerm`,
    termContractDigest: DIGEST,
  });
  const controlledSet = node({
    nodeKind: 'controlledIriSet',
    identityTermRegistryRef: artifactRef('mappings/finance/identity-term-registry.json'),
    identityTermRegistryDigest: DIGEST,
    controlledSetRef: `${BASE}VenueControlledSet`,
    controlledSetDigest: DIGEST,
  });
  const constraint = node({
    nodeKind: 'constraintInstance',
    artifactRef: artifactRef('scripts/domain/release-profile/v0.3.0/constraint-instance-manifest.json'),
    artifactDigest: DIGEST,
    constraintInstanceId: 'constraint-price-observation',
    targetPublicIri: `${BASE}PriceObservation`,
  });
  const cq = node({
    nodeKind: 'competencyQuestion',
    artifactRef: artifactRef('tests/m2/competency-queries/cq-test.yaml'),
    artifactDigest: DIGEST,
    cqId: 'CQ-TEST',
    executionIdentity: 'cq-test-v1',
  });
  const positive = node({
    nodeKind: 'positiveFixture',
    artifactRef: artifactRef('tests/m2/fixtures/positive/test.yaml'),
    artifactDigest: DIGEST,
    fixtureId: 'positive-test',
  });
  const negative = node({
    nodeKind: 'negativeFixture',
    artifactRef: artifactRef('tests/m2/fixtures/negative/test.yaml'),
    artifactDigest: DIGEST,
    fixtureId: 'negative-test',
  });
  const gate = node({
    nodeKind: 'gateCheckExpectation',
    artifactRef: artifactRef('scripts/domain/release-profile/v0.3.0/gate-checks.json'),
    artifactDigest: DIGEST,
    gateId: 'shacl-execution',
    checkId: 'check-test',
  });

  const nodes = [
    termSource,
    identitySource,
    term,
    symbol,
    identityContract,
    identityMapping,
    identityTerm,
    controlledSet,
    constraint,
    cq,
    positive,
    negative,
    gate,
  ].sort((left, right) => Buffer.compare(
    Buffer.from(left.nodeId, 'utf8'),
    Buffer.from(right.nodeId, 'utf8'),
  ));

  const edge = (from, to, edgeKind) => ({
    fromNodeId: from.nodeId,
    toNodeId: to.nodeId,
    edgeKind,
  });
  const edges = [
    edge(termSource, term, 'supportsTerm'),
    edge(identitySource, identityContract, 'supportsIdentity'),
    edge(identitySource, identityMapping, 'supportsMapping'),
    edge(identitySource, identityTerm, 'supportsIdentityTerm'),
    edge(identitySource, controlledSet, 'supportsControlledSet'),
    edge(term, symbol, 'definesSymbol'),
    edge(symbol, identityContract, 'hasIdentityContract'),
    edge(identityContract, identityMapping, 'boundByMapping'),
    edge(identityContract, identityTerm, 'usesIdentityTerm'),
    edge(identityTerm, controlledSet, 'usesControlledSet'),
    edge(symbol, constraint, 'hasConstraint'),
    edge(symbol, cq, 'hasExercise'),
    edge(constraint, positive, 'hasPositiveCase'),
    edge(constraint, negative, 'hasNegativeCase'),
    edge(cq, positive, 'hasPositiveCase'),
    edge(cq, negative, 'hasNegativeCase'),
    edge(identityContract, gate, 'executedAs'),
    edge(identityMapping, gate, 'executedAs'),
    edge(identityTerm, gate, 'executedAs'),
    edge(controlledSet, gate, 'executedAs'),
    edge(constraint, gate, 'executedAs'),
    edge(cq, gate, 'executedAs'),
    edge(positive, gate, 'executedAs'),
    edge(negative, gate, 'executedAs'),
  ].sort(compareEdgeTuple);

  return {
    schemaVersion: '1.0',
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    nodes,
    edges,
  };
}

function codes(result) {
  return new Set(result.errors.map((error) => error.code));
}

function buildValidExecutionIndex(manifest = buildValidManifest()) {
  const expectations = manifest.nodes
    .filter((value) => value.nodeKind === 'gateCheckExpectation')
    .sort((left, right) => {
      const gate = Buffer.compare(Buffer.from(left.gateId), Buffer.from(right.gateId));
      return gate || Buffer.compare(Buffer.from(left.checkId), Buffer.from(right.checkId));
    });
  return {
    schemaVersion: '1.0',
    build: {
      buildId: DIGEST,
      sourceTreeDigest: OTHER_DIGEST,
      toolLockRef: artifactRef('scripts/domain/release-profile/v0.3.0/tool-lock.json'),
      toolLockDigest: DIGEST,
      buildInputsRef: { kind: 'path', root: 'buildEvidence', path: 'build-inputs.json' },
      buildInputsDigest: OTHER_DIGEST,
      controlRecordSchemaManifestRef: artifactRef('scripts/domain/release-profile/v0.3.0/control-record-schemas.json'),
      controlRecordSchemaManifestDigest: DIGEST,
      controlRecordPlanRef: { kind: 'path', root: 'buildEvidence', path: 'control-record-plan.json' },
      controlRecordPlanDigest: OTHER_DIGEST,
    },
    traceabilityManifestRef: artifactRef('docs/ontology/references/traceability-manifest.json'),
    traceabilityManifestDigest: traceabilityManifestDigest(manifest),
    executions: expectations.map((expectation) => ({
      gateId: expectation.gateId,
      checkId: expectation.checkId,
      reportRef: { kind: 'path', root: 'buildEvidence', path: `reports/${expectation.gateId}/${expectation.checkId}.json` },
      reportDigest: DIGEST,
      outcome: 'passed',
    })),
  };
}

test('strict M2 traceability contract accepts the complete closed node/edge union', () => {
  const manifest = buildValidManifest();
  const result = validateTraceabilityManifest(manifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.nodeCount, 13);
  assert.equal(result.edgeCount, 24);
  assert.match(traceabilityManifestDigest(manifest), /^sha256:[0-9a-f]{64}$/u);
  assert.equal(traceabilityManifestDigest(manifest), traceabilityManifestDigest(structuredClone(manifest)));
});

test('trace node identity excludes evidence digests but includes the exact semantic key', () => {
  const manifest = buildValidManifest();
  const original = manifest.nodes.find((value) => value.nodeKind === 'termCard');
  const digestOnlyChange = { ...original, artifactDigest: OTHER_DIGEST };
  const semanticChange = { ...original, publicIri: `${BASE}Trade` };
  assert.equal(semanticNodeId(original), semanticNodeId(digestOnlyChange));
  assert.notEqual(semanticNodeId(original), semanticNodeId(semanticChange));
});

test('strict M2 traceability contract rejects legacy assertionScope and undeclared node/edge kinds', () => {
  const withArtifactProfile = buildValidManifest();
  withArtifactProfile.profileRef = artifactRef(
    'docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md',
  );
  assert.ok(codes(validateTraceabilityManifest(withArtifactProfile)).has('TRACE_INVALID_IRI'));

  const withScope = buildValidManifest();
  withScope.edges[0] = { ...withScope.edges[0], assertionScope: 'implementation' };
  assert.ok(codes(validateTraceabilityManifest(withScope)).has('TRACE_UNKNOWN_FIELD'));

  const withLegacyNode = buildValidManifest();
  withLegacyNode.nodes.push({
    nodeId: `sha256-${'3'.repeat(64)}`,
    nodeKind: 'alignmentDecision',
    decisionId: 'legacy-alignment',
  });
  withLegacyNode.nodes.sort((left, right) => Buffer.compare(
    Buffer.from(left.nodeId, 'utf8'),
    Buffer.from(right.nodeId, 'utf8'),
  ));
  assert.ok(codes(validateTraceabilityManifest(withLegacyNode)).has('TRACE_INVALID_NODE_KIND'));

  const withLegacyEdge = buildValidManifest();
  withLegacyEdge.edges[0] = { ...withLegacyEdge.edges[0], edgeKind: 'supportsConstraint' };
  withLegacyEdge.edges.sort(compareEdgeTuple);
  assert.ok(codes(validateTraceabilityManifest(withLegacyEdge)).has('TRACE_ILLEGAL_EDGE'));
});

test('strict M2 traceability contract rejects an empty graph, foreign profile, and non-canonical IRI', () => {
  const empty = {
    schemaVersion: '1.0',
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    nodes: [],
    edges: [],
  };
  assert.ok(codes(validateTraceabilityManifest(empty)).has('TRACE_EMPTY_GRAPH'));

  const foreignProfile = buildValidManifest();
  foreignProfile.profileRef = 'https://example.test/conformance/m2/0.3.0';
  assert.ok(codes(validateTraceabilityManifest(foreignProfile)).has('TRACE_PROFILE_MISMATCH'));

  const nonCanonicalIri = buildValidManifest();
  const symbol = nonCanonicalIri.nodes.find((value) => value.nodeKind === 'publicSymbol');
  symbol.publicIri = 'HTTPS://AXIOLUNE.AI/ontology/finance/test/PriceObservation';
  assert.ok(codes(validateTraceabilityManifest(nonCanonicalIri)).has('TRACE_INVALID_IRI'));
});

test('strict M2 traceability contract rejects cross-closure identity evidence and gate drift', () => {
  const manifestDrift = buildValidManifest();
  const mapping = manifestDrift.nodes.find((value) => value.nodeKind === 'identityMapping');
  mapping.identityManifestDigest = OTHER_DIGEST;
  assert.ok(codes(validateTraceabilityManifest(manifestDrift)).has('TRACE_MAPPING_CONTRACT_MISMATCH'));

  const registryDrift = buildValidManifest();
  const controlledSet = registryDrift.nodes.find((value) => value.nodeKind === 'controlledIriSet');
  controlledSet.identityTermRegistryDigest = OTHER_DIGEST;
  assert.ok(codes(validateTraceabilityManifest(registryDrift)).has('TRACE_CONTROLLED_SET_REGISTRY_MISMATCH'));

  const gateDrift = buildValidManifest();
  const positive = gateDrift.nodes.find((value) => value.nodeKind === 'positiveFixture');
  const originalGate = gateDrift.nodes.find((value) => value.nodeKind === 'gateCheckExpectation');
  const alternateGate = node({
    nodeKind: 'gateCheckExpectation',
    artifactRef: artifactRef('scripts/domain/release-profile/v0.3.0/gate-checks.json'),
    artifactDigest: DIGEST,
    gateId: 'cq-coverage-execution',
    checkId: 'different-check',
  });
  gateDrift.nodes.push(alternateGate);
  gateDrift.nodes.sort((left, right) => Buffer.compare(
    Buffer.from(left.nodeId, 'utf8'),
    Buffer.from(right.nodeId, 'utf8'),
  ));
  gateDrift.edges = gateDrift.edges
    .filter((edge) => !(edge.fromNodeId === positive.nodeId
      && edge.toNodeId === originalGate.nodeId
      && edge.edgeKind === 'executedAs'));
  gateDrift.edges.push({
    fromNodeId: positive.nodeId,
    toNodeId: alternateGate.nodeId,
    edgeKind: 'executedAs',
  });
  gateDrift.edges.sort(compareEdgeTuple);
  assert.ok(codes(validateTraceabilityManifest(gateDrift)).has('TRACE_EDGE_GATE_MISMATCH'));
});

test('strict M2 traceability contract rejects ID aliasing, digest-only duplicates, and ordering drift', () => {
  const aliased = buildValidManifest();
  const term = aliased.nodes.find((value) => value.nodeKind === 'termCard');
  term.nodeId = `sha256-${'4'.repeat(64)}`;
  aliased.nodes.sort((left, right) => Buffer.compare(
    Buffer.from(left.nodeId, 'utf8'),
    Buffer.from(right.nodeId, 'utf8'),
  ));
  assert.ok(codes(validateTraceabilityManifest(aliased)).has('TRACE_NODE_ID_MISMATCH'));

  const duplicate = buildValidManifest();
  const original = duplicate.nodes.find((value) => value.nodeKind === 'termCard');
  duplicate.nodes.push({
    ...original,
    artifactDigest: OTHER_DIGEST,
  });
  duplicate.nodes.sort((left, right) => Buffer.compare(
    Buffer.from(left.nodeId, 'utf8'),
    Buffer.from(right.nodeId, 'utf8'),
  ));
  const duplicateCodes = codes(validateTraceabilityManifest(duplicate));
  assert.ok(duplicateCodes.has('TRACE_DUPLICATE_NODE_ID'));
  assert.ok(duplicateCodes.has('TRACE_DUPLICATE_SEMANTIC_KEY'));

  const unsorted = buildValidManifest();
  [unsorted.nodes[0], unsorted.nodes[1]] = [unsorted.nodes[1], unsorted.nodes[0]];
  assert.ok(codes(validateTraceabilityManifest(unsorted)).has('TRACE_UNSORTED_OR_DUPLICATE_NODES'));
});

test('strict M2 traceability contract rejects missing fixtures, gates, and illegal endpoint directions', () => {
  const missingNegative = buildValidManifest();
  const constraint = missingNegative.nodes.find((value) => value.nodeKind === 'constraintInstance');
  missingNegative.edges = missingNegative.edges
    .filter((edge) => !(edge.fromNodeId === constraint.nodeId && edge.edgeKind === 'hasNegativeCase'))
    .sort(compareEdgeTuple);
  assert.ok(codes(validateTraceabilityManifest(missingNegative)).has('TRACE_MISSING_REQUIRED_EDGE'));

  const reversed = buildValidManifest();
  const edgeIndex = reversed.edges.findIndex((value) => value.edgeKind === 'definesSymbol');
  const original = reversed.edges[edgeIndex];
  reversed.edges[edgeIndex] = {
    fromNodeId: original.toNodeId,
    toNodeId: original.fromNodeId,
    edgeKind: original.edgeKind,
  };
  reversed.edges.sort(compareEdgeTuple);
  assert.ok(codes(validateTraceabilityManifest(reversed)).has('TRACE_ILLEGAL_EDGE'));
});

test('traceability execution index accepts exact expectation coverage and tagged digest', () => {
  const manifest = buildValidManifest();
  const index = buildValidExecutionIndex(manifest);
  const result = validateTraceabilityExecutionIndex(index, { traceabilityManifest: manifest });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.executionCount, 1);
  assert.match(traceabilityExecutionIndexDigest(index), /^sha256:[0-9a-f]{64}$/u);
});

test('traceability execution index rejects manifest/report/pair tampering and open fields', () => {
  const manifest = buildValidManifest();

  const invalidManifest = buildValidManifest();
  invalidManifest.profileRef = 'https://example.test/conformance/m2/0.3.0';
  const invalidManifestIndex = buildValidExecutionIndex(invalidManifest);
  assert.ok(codes(validateTraceabilityExecutionIndex(
    invalidManifestIndex,
    { traceabilityManifest: invalidManifest },
  )).has('TRACE_EXECUTION_MANIFEST_INVALID'));

  const manifestTamper = buildValidExecutionIndex(manifest);
  manifestTamper.traceabilityManifestDigest = OTHER_DIGEST;
  assert.ok(codes(validateTraceabilityExecutionIndex(
    manifestTamper,
    { traceabilityManifest: manifest },
  )).has('TRACE_EXECUTION_MANIFEST_DIGEST'));

  const reportTamper = buildValidExecutionIndex(manifest);
  const pair = `${reportTamper.executions[0].gateId}\0${reportTamper.executions[0].checkId}`;
  assert.ok(codes(validateTraceabilityExecutionIndex(reportTamper, {
    traceabilityManifest: manifest,
    reportBytesByPair: new Map([[pair, Buffer.from('changed report')]]),
    requireReportBytes: true,
  })).has('TRACE_EXECUTION_REPORT_DIGEST'));

  const pairTamper = buildValidExecutionIndex(manifest);
  pairTamper.executions[0].checkId = 'different-check';
  assert.ok(codes(validateTraceabilityExecutionIndex(
    pairTamper,
    { traceabilityManifest: manifest },
  )).has('TRACE_EXECUTION_EXPECTATION_SET'));

  const openRow = buildValidExecutionIndex(manifest);
  openRow.executions[0].warning = 'ignored';
  assert.ok(codes(validateTraceabilityExecutionIndex(
    openRow,
    { traceabilityManifest: manifest },
  )).has('TRACE_UNKNOWN_FIELD'));
});

test('execution-index builder closes exact expectation pairs over real report bytes', () => {
  const manifest = buildValidManifest();
  const template = buildValidExecutionIndex(manifest);
  const reports = template.executions.map((execution) => ({
    gateId: execution.gateId,
    checkId: execution.checkId,
    reportRef: execution.reportRef,
    reportBytes: Buffer.from(JSON.stringify({
      gateId: execution.gateId,
      checkId: execution.checkId,
      outcome: 'passed',
    }), 'utf8'),
    outcome: 'passed',
  }));
  const built = buildTraceabilityExecutionIndex({
    build: template.build,
    traceabilityManifest: manifest,
    traceabilityManifestRef: template.traceabilityManifestRef,
    reports,
  });
  assert.equal(built.executionCount, reports.length);
  assert.equal(built.bytes.at(-1), 0x7d);
  assert.equal(
    built.indexDigest,
    traceabilityExecutionIndexDigest(built.index),
  );

  reports[0].outcome = 'failed';
  assert.throws(
    () => buildTraceabilityExecutionIndex({
      build: template.build,
      traceabilityManifest: manifest,
      traceabilityManifestRef: template.traceabilityManifestRef,
      reports,
    }),
    /did not pass/u,
  );
});

module.exports = {
  buildValidExecutionIndex,
  buildValidManifest,
};
