'use strict';

const crypto = require('node:crypto');
const {
  canonicalJcs,
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const NODE_ID_RE = /^sha256-[0-9a-f]{64}$/u;
const ASCII_ID_RE = /^[\x21-\x7e]+$/u;
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const TRACE_NODE_TAG = Buffer.from('axiolune-trace-node-v1\0', 'utf8');
const TRACE_MANIFEST_TAG = Buffer.from('axiolune-traceability-manifest-v1\0', 'utf8');
const TRACE_EXECUTION_INDEX_TAG = Buffer.from(
  'axiolune-traceability-execution-index-v1\0',
  'utf8',
);

const ROOT_FIELDS = Object.freeze(['schemaVersion', 'profileRef', 'nodes', 'edges']);
const NODE_FIELDS = Object.freeze({
  sourceLocator: Object.freeze([
    'nodeId', 'nodeKind', 'referenceId', 'artifactRef', 'artifactDigest', 'locator',
  ]),
  termCard: Object.freeze([
    'nodeId', 'nodeKind', 'artifactRef', 'artifactDigest', 'publicIri',
  ]),
  publicSymbol: Object.freeze([
    'nodeId', 'nodeKind', 'artifactRef', 'artifactDigest', 'publicIri',
  ]),
  targetIdentityContract: Object.freeze([
    'nodeId', 'nodeKind', 'identityManifestRef', 'identityManifestDigest',
    'contractRef', 'contractDigest', 'targetType',
  ]),
  identityMapping: Object.freeze([
    'nodeId', 'nodeKind', 'identityManifestRef', 'identityManifestDigest',
    'mappingRef', 'mappingDigest', 'targetType', 'contractRef', 'contractDigest',
  ]),
  identityTermContract: Object.freeze([
    'nodeId', 'nodeKind', 'identityTermRegistryRef', 'identityTermRegistryDigest',
    'termContractRef', 'termContractDigest',
  ]),
  controlledIriSet: Object.freeze([
    'nodeId', 'nodeKind', 'identityTermRegistryRef', 'identityTermRegistryDigest',
    'controlledSetRef', 'controlledSetDigest',
  ]),
  constraintInstance: Object.freeze([
    'nodeId', 'nodeKind', 'artifactRef', 'artifactDigest',
    'constraintInstanceId', 'targetPublicIri',
  ]),
  competencyQuestion: Object.freeze([
    'nodeId', 'nodeKind', 'artifactRef', 'artifactDigest', 'cqId', 'executionIdentity',
  ]),
  positiveFixture: Object.freeze([
    'nodeId', 'nodeKind', 'artifactRef', 'artifactDigest', 'fixtureId',
  ]),
  negativeFixture: Object.freeze([
    'nodeId', 'nodeKind', 'artifactRef', 'artifactDigest', 'fixtureId',
  ]),
  gateCheckExpectation: Object.freeze([
    'nodeId', 'nodeKind', 'artifactRef', 'artifactDigest', 'gateId', 'checkId',
  ]),
});

const SEMANTIC_KEY_FIELDS = Object.freeze({
  sourceLocator: Object.freeze(['nodeKind', 'referenceId', 'artifactRef', 'locator']),
  termCard: Object.freeze(['nodeKind', 'publicIri']),
  publicSymbol: Object.freeze(['nodeKind', 'publicIri']),
  targetIdentityContract: Object.freeze(['nodeKind', 'contractRef', 'targetType']),
  identityMapping: Object.freeze(['nodeKind', 'mappingRef', 'targetType', 'contractRef']),
  identityTermContract: Object.freeze(['nodeKind', 'termContractRef']),
  controlledIriSet: Object.freeze(['nodeKind', 'controlledSetRef']),
  constraintInstance: Object.freeze(['nodeKind', 'constraintInstanceId']),
  competencyQuestion: Object.freeze(['nodeKind', 'cqId']),
  positiveFixture: Object.freeze(['nodeKind', 'fixtureId', 'artifactRef']),
  negativeFixture: Object.freeze(['nodeKind', 'fixtureId', 'artifactRef']),
  gateCheckExpectation: Object.freeze(['nodeKind', 'gateId', 'checkId']),
});

const EDGE_FIELDS = Object.freeze(['fromNodeId', 'toNodeId', 'edgeKind']);
const EDGE_MATRIX = Object.freeze(new Set([
  'sourceLocator|termCard|supportsTerm',
  'sourceLocator|targetIdentityContract|supportsIdentity',
  'sourceLocator|identityMapping|supportsMapping',
  'sourceLocator|identityTermContract|supportsIdentityTerm',
  'sourceLocator|controlledIriSet|supportsControlledSet',
  'termCard|publicSymbol|definesSymbol',
  'publicSymbol|targetIdentityContract|hasIdentityContract',
  'targetIdentityContract|identityMapping|boundByMapping',
  'targetIdentityContract|identityTermContract|usesIdentityTerm',
  'identityTermContract|controlledIriSet|usesControlledSet',
  'publicSymbol|constraintInstance|hasConstraint',
  'publicSymbol|competencyQuestion|hasExercise',
  'constraintInstance|positiveFixture|hasPositiveCase',
  'competencyQuestion|positiveFixture|hasPositiveCase',
  'constraintInstance|negativeFixture|hasNegativeCase',
  'competencyQuestion|negativeFixture|hasNegativeCase',
  'targetIdentityContract|gateCheckExpectation|executedAs',
  'identityMapping|gateCheckExpectation|executedAs',
  'identityTermContract|gateCheckExpectation|executedAs',
  'controlledIriSet|gateCheckExpectation|executedAs',
  'constraintInstance|gateCheckExpectation|executedAs',
  'competencyQuestion|gateCheckExpectation|executedAs',
  'positiveFixture|gateCheckExpectation|executedAs',
  'negativeFixture|gateCheckExpectation|executedAs',
]));

const SUPPORT_EDGE_KINDS = Object.freeze(new Set([
  'supportsTerm',
  'supportsIdentity',
  'supportsMapping',
  'supportsIdentityTerm',
  'supportsControlledSet',
]));

const BUILD_EVIDENCE_FIELDS = Object.freeze([
  'buildId', 'sourceTreeDigest', 'toolLockRef', 'toolLockDigest',
  'buildInputsRef', 'buildInputsDigest', 'controlRecordSchemaManifestRef',
  'controlRecordSchemaManifestDigest', 'controlRecordPlanRef',
  'controlRecordPlanDigest',
]);
const EXECUTION_INDEX_FIELDS = Object.freeze([
  'schemaVersion', 'build', 'traceabilityManifestRef',
  'traceabilityManifestDigest', 'executions',
]);
const EXECUTION_FIELDS = Object.freeze([
  'gateId', 'checkId', 'reportRef', 'reportDigest', 'outcome',
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function compareEdgeTuple(left, right) {
  for (const field of EDGE_FIELDS) {
    const comparison = compareUtf8(left[field], right[field]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function issue(errors, code, at, message) {
  errors.push({ code, at, message });
}

function validateClosedObject(value, fields, at, errors) {
  if (!isPlainObject(value)) {
    issue(errors, 'TRACE_EXPECTED_OBJECT', at, 'expected a closed object');
    return false;
  }
  const allowed = new Set(fields);
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      issue(errors, 'TRACE_MISSING_FIELD', `${at}.${field}`, 'missing required field');
    }
  }
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      issue(errors, 'TRACE_UNKNOWN_FIELD', `${at}.${field}`, 'unknown field');
    }
  }
  return true;
}

function validateAsciiId(value, at, errors) {
  if (typeof value !== 'string'
      || value !== value.normalize('NFC')
      || !ASCII_ID_RE.test(value)) {
    issue(errors, 'TRACE_INVALID_ASCII_ID', at, 'expected a non-empty visible ASCII identifier');
  }
}

function validateDigest(value, at, errors) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    issue(errors, 'TRACE_INVALID_DIGEST', at, 'expected sha256:<64 lowercase hex>');
  }
}

function validateAbsoluteIri(value, at, errors) {
  if (typeof value !== 'string'
      || value.length === 0
      || value !== value.normalize('NFC')
      || /[\u0000-\u0020\u007f]/u.test(value)) {
    issue(errors, 'TRACE_INVALID_IRI', at, 'expected a normalized absolute IRI');
    return;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || parsed.href !== value) throw new Error('non-canonical absolute IRI');
  } catch {
    issue(errors, 'TRACE_INVALID_IRI', at, 'expected a normalized absolute IRI');
  }
}

function validateRef(value, at, errors) {
  const result = validateArtifactRef(value, at);
  for (const message of result.errors) {
    issue(errors, 'TRACE_INVALID_ARTIFACT_REF', at, message);
  }
}

function semanticKey(node) {
  const fields = SEMANTIC_KEY_FIELDS[node?.nodeKind];
  if (!fields) throw new Error(`unsupported trace node kind ${String(node?.nodeKind)}`);
  return Object.fromEntries(fields.map((field) => [field, node[field]]));
}

function semanticNodeId(node) {
  const hash = crypto.createHash('sha256');
  hash.update(TRACE_NODE_TAG);
  hash.update(Buffer.from(canonicalJcs(semanticKey(node)), 'utf8'));
  return `sha256-${hash.digest('hex')}`;
}

function traceabilityManifestDigest(manifest) {
  const hash = crypto.createHash('sha256');
  hash.update(TRACE_MANIFEST_TAG);
  hash.update(Buffer.from(canonicalJcs(manifest), 'utf8'));
  return `sha256:${hash.digest('hex')}`;
}

function traceabilityExecutionIndexDigest(index) {
  const hash = crypto.createHash('sha256');
  hash.update(TRACE_EXECUTION_INDEX_TAG);
  hash.update(Buffer.from(canonicalJcs(index), 'utf8'));
  return `sha256:${hash.digest('hex')}`;
}

function validateNodeScalars(node, at, errors, selectedBytesByNodeId) {
  if (!NODE_ID_RE.test(node.nodeId || '')) {
    issue(errors, 'TRACE_INVALID_NODE_ID', `${at}.nodeId`, 'expected sha256-<64 lowercase hex>');
  }

  for (const [field, value] of Object.entries(node)) {
    if (field.endsWith('Digest')) validateDigest(value, `${at}.${field}`, errors);
  }
  for (const field of [
    'artifactRef', 'identityManifestRef', 'identityTermRegistryRef',
  ]) {
    if (Object.prototype.hasOwnProperty.call(node, field)) {
      validateRef(node[field], `${at}.${field}`, errors);
    }
  }
  for (const field of [
    'publicIri', 'targetPublicIri', 'targetType', 'contractRef', 'mappingRef',
    'termContractRef', 'controlledSetRef',
  ]) {
    if (Object.prototype.hasOwnProperty.call(node, field)) {
      validateAbsoluteIri(node[field], `${at}.${field}`, errors);
    }
  }
  for (const field of [
    'referenceId', 'constraintInstanceId', 'cqId', 'executionIdentity',
    'fixtureId', 'gateId', 'checkId',
  ]) {
    if (Object.prototype.hasOwnProperty.call(node, field)) {
      validateAsciiId(node[field], `${at}.${field}`, errors);
    }
  }
  if (node.nodeKind === 'sourceLocator') {
    const selectedBytes = selectedBytesByNodeId?.get(node.nodeId);
    const validation = validateSourceLocator(node.locator, {
      at: `${at}.locator`,
      ...(selectedBytes === undefined ? {} : { selectedBytes }),
    });
    for (const message of validation.errors) {
      issue(errors, 'TRACE_INVALID_SOURCE_LOCATOR', `${at}.locator`, message);
    }
  }
}

function hasEdge(outgoing, nodeId, edgeKind) {
  return (outgoing.get(nodeId) || []).some((edge) => edge.edgeKind === edgeKind);
}

function requireEdge(outgoing, node, edgeKind, errors) {
  if (!hasEdge(outgoing, node.nodeId, edgeKind)) {
    issue(
      errors,
      'TRACE_MISSING_REQUIRED_EDGE',
      node.nodeId,
      `${node.nodeKind} requires at least one ${edgeKind} edge`,
    );
  }
}

function edgesOfKind(index, nodeId, edgeKind) {
  return (index.get(nodeId) || []).filter((edge) => edge.edgeKind === edgeKind);
}

function refEquals(left, right) {
  return canonicalJcs(left) === canonicalJcs(right);
}

function gateTargets(outgoing, nodeId) {
  return new Set(edgesOfKind(outgoing, nodeId, 'executedAs').map((edge) => edge.toNodeId));
}

function requireSharedGate(outgoing, fromNode, toNode, edgeKind, errors) {
  const fromGates = gateTargets(outgoing, fromNode.nodeId);
  const toGates = gateTargets(outgoing, toNode.nodeId);
  if (![...fromGates].some((gateNodeId) => toGates.has(gateNodeId))) {
    issue(
      errors,
      'TRACE_EDGE_GATE_MISMATCH',
      `${fromNode.nodeId}/${toNode.nodeId}`,
      `${edgeKind} endpoints do not share an execution expectation`,
    );
  }
}

function requireIncoming(incoming, node, edgeKind, errors, options = {}) {
  const matches = edgesOfKind(incoming, node.nodeId, edgeKind);
  const minimum = options.minimum ?? 1;
  const maximum = options.maximum ?? Number.POSITIVE_INFINITY;
  if (matches.length < minimum || matches.length > maximum) {
    issue(
      errors,
      'TRACE_INCOMING_CARDINALITY',
      node.nodeId,
      `${node.nodeKind} requires ${minimum === maximum ? `exactly ${minimum}` : `${minimum}..${maximum}`} incoming ${edgeKind} edge(s); found ${matches.length}`,
    );
  }
  return matches;
}

function validateStructuralClosure(nodes, incoming, outgoing, errors) {
  const publicRoots = [...nodes.values()]
    .filter((node) => node.nodeKind === 'publicSymbol')
    .map((node) => node.nodeId);
  const reachable = new Set(publicRoots);
  const queue = [...publicRoots];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of outgoing.get(current) || []) {
      if (!reachable.has(edge.toNodeId)) {
        reachable.add(edge.toNodeId);
        queue.push(edge.toNodeId);
      }
    }
  }

  for (const node of nodes.values()) {
    if (node.nodeKind === 'sourceLocator') {
      if (!(outgoing.get(node.nodeId) || []).some((edge) => SUPPORT_EDGE_KINDS.has(edge.edgeKind))) {
        issue(errors, 'TRACE_ORPHAN_SOURCE', node.nodeId, 'source locator supports no semantic node');
      }
      continue;
    }
    if (node.nodeKind === 'termCard') {
      requireIncoming(incoming, node, 'supportsTerm', errors);
      requireEdge(outgoing, node, 'definesSymbol', errors);
      const definitions = edgesOfKind(outgoing, node.nodeId, 'definesSymbol');
      if (definitions.length !== 1) {
        issue(errors, 'TRACE_TERM_SYMBOL_CARDINALITY', node.nodeId, 'term card must define exactly one public symbol');
      } else if (nodes.get(definitions[0].toNodeId)?.publicIri !== node.publicIri) {
        issue(errors, 'TRACE_TERM_SYMBOL_MISMATCH', node.nodeId, 'term card and public symbol IRIs differ');
      }
      continue;
    }
    if (node.nodeKind === 'publicSymbol') {
      requireIncoming(incoming, node, 'definesSymbol', errors, { minimum: 1, maximum: 1 });
      continue;
    }

    if (!reachable.has(node.nodeId) && node.nodeKind !== 'gateCheckExpectation') {
      issue(
        errors,
        'TRACE_NOT_REACHABLE_FROM_PUBLIC_SYMBOL',
        node.nodeId,
        `${node.nodeKind} is not reachable from a public symbol`,
      );
    }

    if (node.nodeKind === 'targetIdentityContract') {
      requireIncoming(incoming, node, 'supportsIdentity', errors);
      const owners = requireIncoming(
        incoming,
        node,
        'hasIdentityContract',
        errors,
        { minimum: 1, maximum: 1 },
      );
      if (owners.length === 1 && nodes.get(owners[0].fromNodeId)?.publicIri !== node.targetType) {
        issue(errors, 'TRACE_IDENTITY_TARGET_MISMATCH', node.nodeId, 'identity contract targetType differs from its public symbol');
      }
      requireEdge(outgoing, node, 'boundByMapping', errors);
      requireEdge(outgoing, node, 'usesIdentityTerm', errors);
      requireEdge(outgoing, node, 'executedAs', errors);
    } else if (node.nodeKind === 'identityMapping') {
      requireIncoming(incoming, node, 'supportsMapping', errors);
      const contracts = requireIncoming(
        incoming,
        node,
        'boundByMapping',
        errors,
        { minimum: 1, maximum: 1 },
      );
      if (contracts.length === 1) {
        const contract = nodes.get(contracts[0].fromNodeId);
        if (contract?.contractRef !== node.contractRef
            || contract?.contractDigest !== node.contractDigest
            || contract?.targetType !== node.targetType
            || !refEquals(contract?.identityManifestRef, node.identityManifestRef)
            || contract?.identityManifestDigest !== node.identityManifestDigest) {
          issue(errors, 'TRACE_MAPPING_CONTRACT_MISMATCH', node.nodeId, 'mapping fields differ from its identity contract');
        }
        if (contract) requireSharedGate(outgoing, contract, node, 'boundByMapping', errors);
      }
      requireEdge(outgoing, node, 'executedAs', errors);
    } else if (node.nodeKind === 'identityTermContract') {
      requireIncoming(incoming, node, 'supportsIdentityTerm', errors);
      requireIncoming(incoming, node, 'usesIdentityTerm', errors);
      requireEdge(outgoing, node, 'executedAs', errors);
    } else if (node.nodeKind === 'controlledIriSet') {
      requireIncoming(incoming, node, 'supportsControlledSet', errors);
      const terms = requireIncoming(incoming, node, 'usesControlledSet', errors);
      for (const edge of terms) {
        const term = nodes.get(edge.fromNodeId);
        if (!term) continue;
        if (!refEquals(term.identityTermRegistryRef, node.identityTermRegistryRef)
            || term.identityTermRegistryDigest !== node.identityTermRegistryDigest) {
          issue(
            errors,
            'TRACE_CONTROLLED_SET_REGISTRY_MISMATCH',
            node.nodeId,
            'controlled set registry binding differs from its identity term contract',
          );
        }
        requireSharedGate(outgoing, term, node, 'usesControlledSet', errors);
      }
      requireEdge(outgoing, node, 'executedAs', errors);
    } else if (node.nodeKind === 'constraintInstance') {
      const targets = requireIncoming(
        incoming,
        node,
        'hasConstraint',
        errors,
        { minimum: 1, maximum: 1 },
      );
      if (targets.length === 1 && nodes.get(targets[0].fromNodeId)?.publicIri !== node.targetPublicIri) {
        issue(errors, 'TRACE_CONSTRAINT_TARGET_MISMATCH', node.nodeId, 'constraint targetPublicIri differs from its public symbol');
      }
      requireEdge(outgoing, node, 'hasPositiveCase', errors);
      requireEdge(outgoing, node, 'hasNegativeCase', errors);
      requireEdge(outgoing, node, 'executedAs', errors);
    } else if (node.nodeKind === 'competencyQuestion') {
      requireIncoming(incoming, node, 'hasExercise', errors);
      requireEdge(outgoing, node, 'hasPositiveCase', errors);
      requireEdge(outgoing, node, 'hasNegativeCase', errors);
      requireEdge(outgoing, node, 'executedAs', errors);
    } else if (node.nodeKind === 'positiveFixture' || node.nodeKind === 'negativeFixture') {
      const expectedKind = node.nodeKind === 'positiveFixture' ? 'hasPositiveCase' : 'hasNegativeCase';
      const subjects = requireIncoming(incoming, node, expectedKind, errors);
      for (const edge of subjects) {
        const subject = nodes.get(edge.fromNodeId);
        if (subject) requireSharedGate(outgoing, subject, node, expectedKind, errors);
      }
      requireEdge(outgoing, node, 'executedAs', errors);
    }
  }

  for (const node of nodes.values()) {
    if (node.nodeKind !== 'targetIdentityContract') continue;
    for (const edgeKind of ['usesIdentityTerm']) {
      for (const edge of edgesOfKind(outgoing, node.nodeId, edgeKind)) {
        const target = nodes.get(edge.toNodeId);
        if (target) requireSharedGate(outgoing, node, target, edgeKind, errors);
      }
    }
  }

  for (const node of nodes.values()) {
    if (node.nodeKind !== 'gateCheckExpectation') continue;
    if (!(incoming.get(node.nodeId) || []).some((edge) => edge.edgeKind === 'executedAs')) {
      issue(errors, 'TRACE_ORPHAN_GATE_EXPECTATION', node.nodeId, 'gate expectation has no semantic subject');
    }
  }
}

function validateBuildEvidenceBinding(value, at, errors) {
  if (!validateClosedObject(value, BUILD_EVIDENCE_FIELDS, at, errors)) return;
  for (const field of BUILD_EVIDENCE_FIELDS) {
    if (field.endsWith('Digest') || field === 'buildId') {
      validateDigest(value[field], `${at}.${field}`, errors);
    }
  }
  for (const field of [
    'toolLockRef', 'buildInputsRef', 'controlRecordSchemaManifestRef',
    'controlRecordPlanRef',
  ]) {
    validateRef(value[field], `${at}.${field}`, errors);
  }
  if (value.toolLockRef?.root !== 'sourceTree') {
    issue(errors, 'TRACE_EXECUTION_REF_ROOT', `${at}.toolLockRef.root`, 'toolLockRef must use sourceTree');
  }
  if (value.buildInputsRef?.root !== 'buildEvidence') {
    issue(errors, 'TRACE_EXECUTION_REF_ROOT', `${at}.buildInputsRef.root`, 'buildInputsRef must use buildEvidence');
  }
  if (value.controlRecordSchemaManifestRef?.root !== 'sourceTree') {
    issue(errors, 'TRACE_EXECUTION_REF_ROOT', `${at}.controlRecordSchemaManifestRef.root`, 'controlRecordSchemaManifestRef must use sourceTree');
  }
  if (!['sourceTree', 'buildEvidence'].includes(value.controlRecordPlanRef?.root)) {
    issue(errors, 'TRACE_EXECUTION_REF_ROOT', `${at}.controlRecordPlanRef.root`, 'controlRecordPlanRef must use sourceTree or buildEvidence');
  }
}

function compareExecutionTuple(left, right) {
  for (const field of ['gateId', 'checkId']) {
    const comparison = compareUtf8(left[field], right[field]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function expectationPairsFromManifest(manifest) {
  return (manifest?.nodes || [])
    .filter((node) => node.nodeKind === 'gateCheckExpectation')
    .map((node) => `${node.gateId}\0${node.checkId}`)
    .sort(compareUtf8);
}

function validateTraceabilityExecutionIndex(index, options = {}) {
  const errors = [];
  if (!validateClosedObject(index, EXECUTION_INDEX_FIELDS, 'traceability-execution-index.json', errors)) {
    return { ok: false, errors };
  }
  if (index.schemaVersion !== '1.0') {
    issue(errors, 'TRACE_EXECUTION_SCHEMA_VERSION', 'traceability-execution-index.json.schemaVersion', 'expected 1.0');
  }
  validateBuildEvidenceBinding(index.build, 'traceability-execution-index.json.build', errors);
  validateRef(index.traceabilityManifestRef, 'traceability-execution-index.json.traceabilityManifestRef', errors);
  validateDigest(
    index.traceabilityManifestDigest,
    'traceability-execution-index.json.traceabilityManifestDigest',
    errors,
  );
  if (options.traceabilityManifest) {
    const manifestValidation = validateTraceabilityManifest(options.traceabilityManifest);
    if (!manifestValidation.ok) {
      const first = manifestValidation.errors[0];
      issue(
        errors,
        'TRACE_EXECUTION_MANIFEST_INVALID',
        'traceability-execution-index.json.traceabilityManifestRef',
        `${first.code} at ${first.at}: ${first.message}`,
      );
    }
    const actual = traceabilityManifestDigest(options.traceabilityManifest);
    if (index.traceabilityManifestDigest !== actual) {
      issue(errors, 'TRACE_EXECUTION_MANIFEST_DIGEST', 'traceability-execution-index.json.traceabilityManifestDigest', `expected ${actual}`);
    }
  }
  if (!Array.isArray(index.executions) || index.executions.length === 0) {
    issue(errors, 'TRACE_EXECUTION_EMPTY', 'traceability-execution-index.json.executions', 'executions must be a non-empty array');
    return { ok: false, errors };
  }
  const actualPairs = [];
  let previous = null;
  for (let position = 0; position < index.executions.length; position += 1) {
    const row = index.executions[position];
    const at = `traceability-execution-index.json.executions[${position}]`;
    if (!validateClosedObject(row, EXECUTION_FIELDS, at, errors)) continue;
    validateAsciiId(row.gateId, `${at}.gateId`, errors);
    validateAsciiId(row.checkId, `${at}.checkId`, errors);
    validateRef(row.reportRef, `${at}.reportRef`, errors);
    validateDigest(row.reportDigest, `${at}.reportDigest`, errors);
    if (row.outcome !== 'passed') {
      issue(errors, 'TRACE_EXECUTION_OUTCOME', `${at}.outcome`, 'expected passed');
    }
    if (previous !== null && compareExecutionTuple(previous, row) >= 0) {
      issue(errors, 'TRACE_EXECUTION_ORDER', at, 'executions are not strictly (gateId,checkId)-sorted');
    }
    previous = row;
    actualPairs.push(`${row.gateId}\0${row.checkId}`);
    const reportBytes = options.reportBytesByPair?.get(`${row.gateId}\0${row.checkId}`);
    if (reportBytes !== undefined) {
      const actualDigest = `sha256:${crypto.createHash('sha256').update(reportBytes).digest('hex')}`;
      if (row.reportDigest !== actualDigest) {
        issue(errors, 'TRACE_EXECUTION_REPORT_DIGEST', `${at}.reportDigest`, `expected ${actualDigest}`);
      }
    } else if (options.requireReportBytes) {
      issue(errors, 'TRACE_EXECUTION_REPORT_MISSING', at, 'same-build report bytes were not supplied');
    }
  }
  const expectedPairs = options.expectedPairs
    ? [...options.expectedPairs].sort(compareUtf8)
    : options.traceabilityManifest
      ? expectationPairsFromManifest(options.traceabilityManifest)
      : null;
  if (expectedPairs && canonicalJcs(actualPairs) !== canonicalJcs(expectedPairs)) {
    issue(errors, 'TRACE_EXECUTION_EXPECTATION_SET', 'traceability-execution-index.json.executions', 'execution pairs differ from traceability expectations');
  }
  return { ok: errors.length === 0, errors, executionCount: actualPairs.length };
}

function assertValidTraceabilityExecutionIndex(index, options = {}) {
  const result = validateTraceabilityExecutionIndex(index, options);
  if (!result.ok) {
    const first = result.errors[0];
    throw new Error(`${first.code} at ${first.at}: ${first.message}`);
  }
  return result;
}

function validateTraceabilityManifest(manifest, options = {}) {
  const errors = [];
  if (!validateClosedObject(manifest, ROOT_FIELDS, 'traceability-manifest.json', errors)) {
    return { ok: false, errors };
  }
  if (manifest.schemaVersion !== '1.0') {
    issue(
      errors,
      'TRACE_INVALID_SCHEMA_VERSION',
      'traceability-manifest.json.schemaVersion',
      'expected 1.0',
    );
  }
  validateAbsoluteIri(manifest.profileRef, 'traceability-manifest.json.profileRef', errors);
  if (manifest.profileRef !== PROFILE_REF) {
    issue(
      errors,
      'TRACE_PROFILE_MISMATCH',
      'traceability-manifest.json.profileRef',
      `expected ${PROFILE_REF}`,
    );
  }
  if (!Array.isArray(manifest.nodes) || !Array.isArray(manifest.edges)) {
    issue(
      errors,
      'TRACE_INVALID_ARRAYS',
      'traceability-manifest.json',
      'nodes and edges must be arrays',
    );
    return { ok: false, errors };
  }
  if (manifest.nodes.length === 0 || manifest.edges.length === 0) {
    issue(
      errors,
      'TRACE_EMPTY_GRAPH',
      'traceability-manifest.json',
      'nodes and edges must both be non-empty',
    );
  }

  const nodes = new Map();
  const semanticKeys = new Map();
  let previousNodeId = null;
  for (let index = 0; index < manifest.nodes.length; index += 1) {
    const node = manifest.nodes[index];
    const at = `traceability-manifest.json.nodes[${index}]`;
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(NODE_FIELDS, node.nodeKind)) {
      issue(errors, 'TRACE_INVALID_NODE_KIND', at, 'nodeKind is missing or unsupported');
      continue;
    }
    validateClosedObject(node, NODE_FIELDS[node.nodeKind], at, errors);
    validateNodeScalars(node, at, errors, options.selectedBytesByNodeId);
    if (previousNodeId !== null && compareUtf8(previousNodeId, node.nodeId) >= 0) {
      issue(errors, 'TRACE_UNSORTED_OR_DUPLICATE_NODES', `${at}.nodeId`, 'nodes are not strictly nodeId-byte sorted');
    }
    previousNodeId = node.nodeId;
    if (nodes.has(node.nodeId)) {
      issue(errors, 'TRACE_DUPLICATE_NODE_ID', `${at}.nodeId`, 'duplicate nodeId');
    }
    nodes.set(node.nodeId, node);
    try {
      const key = canonicalJcs(semanticKey(node));
      const expectedId = semanticNodeId(node);
      if (node.nodeId !== expectedId) {
        issue(errors, 'TRACE_NODE_ID_MISMATCH', `${at}.nodeId`, `expected ${expectedId}`);
      }
      if (semanticKeys.has(key)) {
        issue(
          errors,
          'TRACE_DUPLICATE_SEMANTIC_KEY',
          at,
          `semantic key already represented by ${semanticKeys.get(key)}`,
        );
      }
      semanticKeys.set(key, node.nodeId);
    } catch (error) {
      issue(errors, 'TRACE_INVALID_NODE_JCS', at, error.message);
    }
  }

  const incoming = new Map();
  const outgoing = new Map();
  const edgeKeys = new Set();
  let previousEdge = null;
  for (let index = 0; index < manifest.edges.length; index += 1) {
    const edge = manifest.edges[index];
    const at = `traceability-manifest.json.edges[${index}]`;
    if (!validateClosedObject(edge, EDGE_FIELDS, at, errors)) continue;
    for (const field of EDGE_FIELDS) validateAsciiId(edge[field], `${at}.${field}`, errors);
    if (previousEdge !== null && compareEdgeTuple(previousEdge, edge) >= 0) {
      issue(errors, 'TRACE_UNSORTED_OR_DUPLICATE_EDGES', at, 'edges are not strictly tuple-byte sorted');
    }
    previousEdge = edge;
    const key = canonicalJcs(edge);
    if (edgeKeys.has(key)) issue(errors, 'TRACE_DUPLICATE_EDGE', at, 'duplicate edge');
    edgeKeys.add(key);
    if (edge.fromNodeId === edge.toNodeId) {
      issue(errors, 'TRACE_SELF_EDGE', at, 'self edges are forbidden');
    }
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) {
      issue(errors, 'TRACE_ORPHAN_EDGE_ENDPOINT', at, 'both edge endpoints must exist');
      continue;
    }
    if (!EDGE_MATRIX.has(`${from.nodeKind}|${to.nodeKind}|${edge.edgeKind}`)) {
      issue(
        errors,
        'TRACE_ILLEGAL_EDGE',
        at,
        `${from.nodeKind} -> ${to.nodeKind} cannot use ${edge.edgeKind}`,
      );
    }
    const outgoingRows = outgoing.get(edge.fromNodeId) || [];
    outgoingRows.push(edge);
    outgoing.set(edge.fromNodeId, outgoingRows);
    const incomingRows = incoming.get(edge.toNodeId) || [];
    incomingRows.push(edge);
    incoming.set(edge.toNodeId, incomingRows);
  }

  validateStructuralClosure(nodes, incoming, outgoing, errors);
  return {
    ok: errors.length === 0,
    errors,
    nodeCount: nodes.size,
    edgeCount: edgeKeys.size,
  };
}

function assertValidTraceabilityManifest(manifest, options = {}) {
  const result = validateTraceabilityManifest(manifest, options);
  if (!result.ok) {
    const first = result.errors[0];
    throw new Error(`${first.code} at ${first.at}: ${first.message}`);
  }
  return result;
}

module.exports = {
  BUILD_EVIDENCE_FIELDS,
  EDGE_FIELDS,
  EDGE_MATRIX,
  EXECUTION_FIELDS,
  EXECUTION_INDEX_FIELDS,
  NODE_FIELDS,
  PROFILE_REF,
  ROOT_FIELDS,
  SEMANTIC_KEY_FIELDS,
  assertValidTraceabilityManifest,
  assertValidTraceabilityExecutionIndex,
  compareExecutionTuple,
  compareEdgeTuple,
  semanticKey,
  semanticNodeId,
  traceabilityManifestDigest,
  traceabilityExecutionIndexDigest,
  validateTraceabilityExecutionIndex,
  validateTraceabilityManifest,
};
