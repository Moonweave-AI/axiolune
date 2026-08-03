'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Parser: N3Parser } = require('n3');
const { auditM2GovernanceBaseline } = require('./m2-governance-baseline.cjs');
const { verifyPromotionAuthorization } = require('./m2-ed25519.cjs');
const { verifyReleaseGitObjects } = require('./m2-git-replay.cjs');
const { verifyBuildDependencyReplay } = require('./m2-build-dependency-replay.cjs');
const {
  verifyGateArtifactBindingReplay,
} = require('./m2-gate-artifact-binding-replay.cjs');
const { verifyPayloadClosure } = require('./m2-payload-closure-replay.cjs');
const {
  REASONER_GATE_IDS,
  verifyReasonerReplay,
} = require('./m2-reasoner-replay.cjs');
const { verifyToolchainReplay } = require('./m2-toolchain-replay.cjs');
const {
  EXPECTED_COMPONENT_IDS,
  replayP1ComponentGate,
} = require('./m2-component-p1-replay.cjs');
const {
  verifyRequiredGateSemanticReplay,
} = require('./m2-required-gate-semantic-replay.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const TARGET_VERSION = '0.3.0';
const VERIFIER_ID = 'axiolune-m2-release-verifier/v0.3-scaffold-2';
const CRITERION_REFS = Object.freeze(
  Array.from({ length: 6 }, (_, index) => `${PROFILE_REF}/criteria/${index + 1}`),
);
const REPORT_KINDS = Object.freeze([
  'aggregate', 'batch', 'compatibility', 'cq', 'identity', 'import', 'mapping',
  'meta', 'module', 'mutation', 'owl', 'pit', 'projection', 'reference',
  'release', 'replay', 'shacl', 'term',
].sort(compareUtf8));
const REQUIRED_GATE_IDS = Object.freeze([
  'aggregate-pre-manifest',
  'artifact-dependency-dag',
  'compatibility-migration',
  'cq-coverage-execution',
  'm2-compile',
  'm3-import-digest',
  'm3-schema',
  'mapping-materialization',
  'module-import-dag',
  'owl-dl-profile',
  'owl-reasoner-primary',
  'owl-reasoner-secondary',
  'pit-execution',
  'projection-determinism-drift',
  'public-symbol-term-coverage',
  'reference-coverage-traceability',
  'release-bundle-tamper',
  'replay-equivalence',
  'shacl-execution',
  'shacl-meta',
  'source-mutation',
  'target-identity-contract',
].sort(compareUtf8));

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..');
const REPORT_KIND_BY_GATE = Object.freeze({
  'aggregate-pre-manifest': 'aggregate',
  'artifact-dependency-dag': 'release',
  'compatibility-migration': 'compatibility',
  'cq-coverage-execution': 'cq',
  'm2-compile': 'module',
  'm3-import-digest': 'import',
  'm3-schema': 'meta',
  'mapping-materialization': 'mapping',
  'module-import-dag': 'import',
  'owl-dl-profile': 'owl',
  'owl-reasoner-primary': 'owl',
  'owl-reasoner-secondary': 'owl',
  'pit-execution': 'pit',
  'projection-determinism-drift': 'projection',
  'public-symbol-term-coverage': 'term',
  'reference-coverage-traceability': 'reference',
  'release-bundle-tamper': 'release',
  'replay-equivalence': 'replay',
  'shacl-execution': 'shacl',
  'shacl-meta': 'shacl',
  'source-mutation': 'mutation',
  'target-identity-contract': 'identity',
});

const GATES_BY_CRITERION = Object.freeze({
  [CRITERION_REFS[0]]: Object.freeze([
    'aggregate-pre-manifest', 'm2-compile', 'm3-import-digest', 'm3-schema',
    'module-import-dag', 'target-identity-contract',
  ].sort(compareUtf8)),
  [CRITERION_REFS[1]]: Object.freeze([
    'aggregate-pre-manifest', 'public-symbol-term-coverage',
    'reference-coverage-traceability',
  ].sort(compareUtf8)),
  [CRITERION_REFS[2]]: Object.freeze([
    'aggregate-pre-manifest', 'owl-dl-profile', 'owl-reasoner-primary',
    'owl-reasoner-secondary', 'projection-determinism-drift',
    'shacl-execution', 'shacl-meta',
  ].sort(compareUtf8)),
  [CRITERION_REFS[3]]: Object.freeze([
    'aggregate-pre-manifest', 'cq-coverage-execution',
  ].sort(compareUtf8)),
  [CRITERION_REFS[4]]: Object.freeze([
    'aggregate-pre-manifest', 'mapping-materialization', 'pit-execution',
    'replay-equivalence', 'target-identity-contract',
  ].sort(compareUtf8)),
  [CRITERION_REFS[5]]: Object.freeze([
    'aggregate-pre-manifest', 'artifact-dependency-dag',
    'compatibility-migration', 'release-bundle-tamper', 'source-mutation',
  ].sort(compareUtf8)),
});

const RELEASE_CHECK_IDS = Object.freeze({
  p0Verification: Object.freeze([
    'artifact-dependency-dag', 'build-binding', 'control-record-collisions',
    'git-object', 'manifest-inventory', 'manifest-schema',
    'report-ledger-closure', 'required-gates', 'source-tree',
    'tool-policy-locks', 'traceability-index',
  ].sort(compareUtf8)),
  payloadVerification: Object.freeze([
    'artifact-dependency-dag', 'compatibility-migration',
    'control-record-collisions', 'detached-exclusion', 'entry-bytes',
    'exact-payload-closure', 'generated-drift', 'manifest-schema-inventory',
    'p0-chain-signature', 'p0p1-diff-policy', 'p1-build-locks',
    'p1-report-ledger-closure', 'p1-source-tree-git-object',
    'payload-artifact-catalog', 'traceability-closure',
  ].sort(compareUtf8)),
  approvalEligibility: Object.freeze([
    'aggregate-pre-manifest', 'eligibility-result-matrix',
    'payload-verification', 'six-criterion-closure',
  ].sort(compareUtf8)),
  adoptionVerification: Object.freeze([
    'adoption-result-matrix', 'approval-signature-scope',
    'artifact-dependency-dag', 'attempt-challenge-signature-state',
    'authoritative-commit-tree', 'cas-old-new-ref',
    'challenge-time-sequence', 'checkout-cleanliness',
    'checkout-manifest-equality', 'eligibility', 'payload-reverification',
    'ref-update-receipt',
  ].sort(compareUtf8)),
});

const REQUIRED_ROOT_KINDS = Object.freeze([
  'compatibilityMigration', 'generatedProjection', 'p0Chain',
  'p1BuildAndGateEvidence', 'p1SourceTree', 'prospectiveCommit',
  'referenceClosure', 'releaseGovernanceDocumentation', 'traceability',
].sort(compareUtf8));

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ASCII_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MEDIA_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/u;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function taggedJcsDigest(tag, value) {
  return sha256(Buffer.concat([
    Buffer.from(tag, 'utf8'),
    Buffer.from(canonicalJcs(value), 'utf8'),
  ]));
}

function artifactDigest(value) {
  return sha256(Buffer.from(canonicalJcs(value), 'utf8'));
}

function canonicalEqual(left, right) {
  try {
    return canonicalJcs(left) === canonicalJcs(right);
  } catch {
    return false;
  }
}

function childPath(at, key) {
  return at === '' ? `/${String(key).replace(/~/gu, '~0').replace(/\//gu, '~1')}`
    : `${at}/${String(key).replace(/~/gu, '~0').replace(/\//gu, '~1')}`;
}

class IssueCollector {
  constructor() {
    this.issues = [];
  }

  add(code, stage, at, message, kind = 'invalid') {
    this.issues.push({ code, stage, path: at || '', kind, message });
  }

  merge(issues) {
    this.issues.push(...issues);
  }

  sorted() {
    return [...this.issues].sort((left, right) => {
      for (const key of ['stage', 'code', 'path', 'kind', 'message']) {
        const comparison = compareUtf8(left[key], right[key]);
        if (comparison !== 0) return comparison;
      }
      return 0;
    });
  }
}

function closedObject(value, required, allowed, at, collector, stage) {
  if (!isPlainObject(value)) {
    collector.add('M2_RELEASE_EXPECTED_OBJECT', stage, at, 'expected a closed object');
    return false;
  }
  for (const field of required) {
    if (!Object.hasOwn(value, field)) {
      collector.add(
        'M2_RELEASE_REQUIRED_FIELD',
        stage,
        childPath(at, field),
        `missing required field ${field}`,
      );
    }
  }
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      collector.add(
        'M2_RELEASE_UNKNOWN_FIELD',
        stage,
        childPath(at, field),
        `unknown field ${field}`,
      );
    }
  }
  return true;
}

function validateString(value, at, collector, stage, code = 'M2_RELEASE_STRING') {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')) {
    collector.add(code, stage, at, 'expected a non-empty Unicode-NFC string');
    return false;
  }
  return true;
}

function validateAsciiId(value, at, collector, stage) {
  if (typeof value !== 'string' || !ASCII_ID_RE.test(value)) {
    collector.add('M2_RELEASE_ASCII_ID', stage, at, 'expected a non-empty ASCII identifier');
    return false;
  }
  return true;
}

function validateRecordId(value, at, collector, stage) {
  if (typeof value !== 'string' || !RECORD_ID_RE.test(value)) {
    collector.add('M2_RELEASE_RECORD_ID', stage, at, 'expected an RFC-001 RecordId');
    return false;
  }
  return true;
}

function validateDigest(value, at, collector, stage) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    collector.add('M2_RELEASE_DIGEST', stage, at, 'expected sha256:<64 lowercase hex>');
    return false;
  }
  return true;
}

function validateAbsoluteIri(value, at, collector, stage) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')
      || /\s/u.test(value)) {
    collector.add('M2_RELEASE_ABSOLUTE_IRI', stage, at, 'expected an absolute normalized IRI');
    return false;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || parsed.href !== value) throw new Error('non-canonical absolute IRI');
  } catch {
    collector.add('M2_RELEASE_ABSOLUTE_IRI', stage, at, 'expected an absolute normalized IRI');
    return false;
  }
  return true;
}

function validateInstant(value, at, collector, stage) {
  const match = typeof value === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u.exec(value)
    : null;
  if (!match) {
    collector.add('M2_RELEASE_INSTANT', stage, at, 'expected RFC 3339 UTC whole-second instant');
    return false;
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value.replace('Z', '.000Z')) {
    collector.add('M2_RELEASE_INSTANT', stage, at, 'instant is not a real canonical UTC calendar value');
    return false;
  }
  return true;
}

function validatePosixRelativePath(value, at, collector, stage) {
  if (!validateString(value, at, collector, stage, 'M2_RELEASE_POSIX_PATH')) return false;
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)
      || value.includes('\0') || value.split('/').some((segment) => segment === ''
        || segment === '.' || segment === '..')) {
    collector.add(
      'M2_RELEASE_POSIX_PATH',
      stage,
      at,
      'expected a normalized POSIX relative path without traversal',
    );
    return false;
  }
  return true;
}

function validatePathOrAbsoluteIri(value, at, collector, stage) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')) {
    collector.add(
      'M2_VALIDATION_REPORT_VIOLATION_PATH',
      stage,
      at,
      'expected a Unicode-NFC POSIX path or absolute IRI',
    );
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    return validateAbsoluteIri(value, at, collector, stage);
  }
  return validatePosixRelativePath(value, at, collector, stage);
}

function nTriplesTerm(term) {
  if (term.termType === 'NamedNode') return `<${term.value}>`;
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  if (term.termType !== 'Literal') throw new Error(`unsupported RDF term ${term.termType}`);
  const lexical = JSON.stringify(term.value)
    .replace(/\\b/gu, '\\u0008')
    .replace(/\\f/gu, '\\u000c');
  if (term.language) return `${lexical}@${term.language}`;
  return `${lexical}^^<${term.datatype.value}>`;
}

function validateCanonicalNTriplesTerm(value, at, collector, stage) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')) {
    collector.add(
      'M2_VALIDATION_REPORT_FOCUS_NODE',
      stage,
      at,
      'expected one canonical Unicode-NFC N-Triples RDF term',
    );
    return false;
  }
  try {
    const quads = new N3Parser({ format: 'N-Triples' }).parse(
      `<urn:axiolune:validation-report:subject> <urn:axiolune:validation-report:predicate> ${value} .`,
    );
    if (quads.length !== 1 || nTriplesTerm(quads[0].object) !== value) {
      throw new Error('term is not in the canonical project N-Triples form');
    }
  } catch (cause) {
    collector.add(
      'M2_VALIDATION_REPORT_FOCUS_NODE',
      stage,
      at,
      cause?.message || String(cause),
    );
    return false;
  }
  return true;
}

function validateAsciiIdOrAbsoluteIri(value, at, collector, stage) {
  if (typeof value === 'string' && ASCII_ID_RE.test(value)) return true;
  return validateAbsoluteIri(value, at, collector, stage);
}

function validateArtifactRef(value, at, collector, stage, allowedRoots = null) {
  if (!isPlainObject(value)) {
    collector.add('M2_RELEASE_ARTIFACT_REF', stage, at, 'expected an ArtifactRef object');
    return false;
  }
  if (value.kind === 'iri') {
    closedObject(value, ['kind', 'iri'], ['kind', 'iri'], at, collector, stage);
    return validateAbsoluteIri(value.iri, childPath(at, 'iri'), collector, stage);
  }
  if (value.kind === 'path') {
    closedObject(value, ['kind', 'root', 'path'], ['kind', 'root', 'path'], at, collector, stage);
    const roots = ['sourceTree', 'buildEvidence', 'payload', 'adoptionEvidence'];
    if (!roots.includes(value.root)) {
      collector.add('M2_RELEASE_ARTIFACT_ROOT', stage, childPath(at, 'root'), 'unknown ArtifactRef root');
    } else if (allowedRoots && !allowedRoots.includes(value.root)) {
      collector.add(
        'M2_RELEASE_ARTIFACT_PHASE',
        stage,
        childPath(at, 'root'),
        `ArtifactRef root ${value.root} is not legal in this phase`,
      );
    }
    validatePosixRelativePath(value.path, childPath(at, 'path'), collector, stage);
    return true;
  }
  collector.add('M2_RELEASE_ARTIFACT_REF', stage, childPath(at, 'kind'), 'expected kind iri or path');
  return false;
}

function artifactRefSortKey(reference) {
  if (!isPlainObject(reference)) return Buffer.from('invalid\0', 'utf8');
  if (reference.kind === 'iri') return Buffer.from(`iri\0${String(reference.iri)}`, 'utf8');
  if (reference.kind === 'path') {
    return Buffer.from(`path\0${String(reference.root)}\0${String(reference.path)}`, 'utf8');
  }
  return Buffer.from(`invalid\0${canonicalJcs(reference)}`, 'utf8');
}

function compareArtifactPairs(left, right) {
  const refComparison = Buffer.compare(
    artifactRefSortKey(left.artifactRef),
    artifactRefSortKey(right.artifactRef),
  );
  return refComparison || compareUtf8(left.artifactDigest, right.artifactDigest);
}

function ensureSortedUnique(values, comparator, at, collector, stage, code) {
  if (!Array.isArray(values)) {
    collector.add(code, stage, at, 'expected an array');
    return false;
  }
  for (let index = 1; index < values.length; index += 1) {
    const comparison = comparator(values[index - 1], values[index]);
    if (comparison >= 0) {
      collector.add(
        code,
        stage,
        childPath(at, index),
        comparison === 0 ? 'duplicate array member' : 'array is not in canonical order',
      );
    }
  }
  return true;
}

function validateExactStringSet(values, expected, at, collector, stage, code) {
  if (!Array.isArray(values)) {
    collector.add(code, stage, at, 'expected an array');
    return;
  }
  ensureSortedUnique(values, compareUtf8, at, collector, stage, code);
  if (!canonicalEqual(values, expected)) {
    collector.add(code, stage, at, `expected exact inventory ${canonicalJcs(expected)}`);
  }
}

function validateExecutionError(value, at, collector, stage) {
  const required = ['code', 'stage', 'message'];
  const allowed = [...required, 'sourcePath', 'constraintRef', 'causeDigest'];
  if (!closedObject(value, required, allowed, at, collector, stage)) return;
  validateAsciiId(value.code, childPath(at, 'code'), collector, stage);
  validateAsciiId(value.stage, childPath(at, 'stage'), collector, stage);
  validateString(value.message, childPath(at, 'message'), collector, stage);
  if (Object.hasOwn(value, 'sourcePath')) {
    validatePosixRelativePath(value.sourcePath, childPath(at, 'sourcePath'), collector, stage);
  }
  if (Object.hasOwn(value, 'constraintRef')) {
    validateAbsoluteIri(value.constraintRef, childPath(at, 'constraintRef'), collector, stage);
  }
  if (Object.hasOwn(value, 'causeDigest')) {
    validateDigest(value.causeDigest, childPath(at, 'causeDigest'), collector, stage);
  }
}

function executionErrorKey(error) {
  return [
    error?.stage || '', error?.code || '', Object.hasOwn(error || {}, 'sourcePath') ? '1' : '0',
    error?.sourcePath || '', Object.hasOwn(error || {}, 'constraintRef') ? '1' : '0',
    error?.constraintRef || '', Object.hasOwn(error || {}, 'causeDigest') ? '1' : '0',
    error?.causeDigest || '', error?.message || '',
  ].join('\0');
}

function validateExecutionErrors(values, at, collector, stage, options = {}) {
  if (!Array.isArray(values)) {
    collector.add('M2_RELEASE_EXECUTION_ERRORS', stage, at, 'expected an errors array');
    return;
  }
  if (options.nonEmpty && values.length === 0) {
    collector.add('M2_RELEASE_EXECUTION_ERRORS', stage, at, 'errors must be non-empty');
  }
  values.forEach((value, index) => validateExecutionError(value, childPath(at, index), collector, stage));
  ensureSortedUnique(
    values,
    (left, right) => compareUtf8(executionErrorKey(left), executionErrorKey(right)),
    at,
    collector,
    stage,
    'M2_RELEASE_EXECUTION_ERROR_ORDER',
  );
}

function validateBuildEvidenceBinding(value, at, collector, stage) {
  const required = [
    'buildId', 'sourceTreeDigest', 'toolLockRef', 'toolLockDigest',
    'buildInputsRef', 'buildInputsDigest', 'controlRecordSchemaManifestRef',
    'controlRecordSchemaManifestDigest', 'controlRecordPlanRef',
    'controlRecordPlanDigest',
  ];
  if (!closedObject(value, required, required, at, collector, stage)) return;
  for (const field of required.filter((name) => name.endsWith('Digest') || name === 'buildId')) {
    validateDigest(value[field], childPath(at, field), collector, stage);
  }
  validateArtifactRef(value.toolLockRef, childPath(at, 'toolLockRef'), collector, stage, ['sourceTree']);
  validateArtifactRef(value.buildInputsRef, childPath(at, 'buildInputsRef'), collector, stage, ['buildEvidence']);
  validateArtifactRef(
    value.controlRecordSchemaManifestRef,
    childPath(at, 'controlRecordSchemaManifestRef'),
    collector,
    stage,
    ['sourceTree'],
  );
  validateArtifactRef(
    value.controlRecordPlanRef,
    childPath(at, 'controlRecordPlanRef'),
    collector,
    stage,
    ['sourceTree', 'buildEvidence'],
  );
}

function validateArtifactBinding(value, at, collector, stage, allowedRoots = null) {
  const required = ['name', 'artifactRef', 'mediaType', 'artifactDigest'];
  if (!closedObject(value, required, required, at, collector, stage)) return;
  validateAsciiId(value.name, childPath(at, 'name'), collector, stage);
  validateArtifactRef(value.artifactRef, childPath(at, 'artifactRef'), collector, stage, allowedRoots);
  if (typeof value.mediaType !== 'string' || !MEDIA_TYPE_RE.test(value.mediaType)) {
    collector.add('M2_RELEASE_MEDIA_TYPE', stage, childPath(at, 'mediaType'), 'expected an IANA media type');
  }
  validateDigest(value.artifactDigest, childPath(at, 'artifactDigest'), collector, stage);
}

function validateArtifactBindings(values, at, collector, stage, options = {}) {
  if (!Array.isArray(values)) {
    collector.add('M2_RELEASE_ARTIFACT_BINDINGS', stage, at, 'expected an ArtifactBinding array');
    return;
  }
  if (options.nonEmpty && values.length === 0) {
    collector.add('M2_RELEASE_ARTIFACT_BINDINGS', stage, at, 'ArtifactBinding array must be non-empty');
  }
  values.forEach((value, index) => validateArtifactBinding(
    value,
    childPath(at, index),
    collector,
    stage,
    options.allowedRoots || null,
  ));
  ensureSortedUnique(
    values,
    (left, right) => compareUtf8(left?.name, right?.name),
    at,
    collector,
    stage,
    'M2_RELEASE_ARTIFACT_BINDING_ORDER',
  );
  const pairs = new Set();
  for (const binding of values) {
    const key = `${artifactRefSortKey(binding?.artifactRef).toString('hex')}\0${binding?.artifactDigest}`;
    if (pairs.has(key)) {
      collector.add(
        'M2_RELEASE_ARTIFACT_BINDING_DUPLICATE',
        stage,
        at,
        'ArtifactBinding ref/digest pair is duplicated',
      );
    }
    pairs.add(key);
  }
}

function expectedCriterionRefsForGate(gateId) {
  return CRITERION_REFS.filter((criterionRef) => GATES_BY_CRITERION[criterionRef].includes(gateId));
}

function validateRequiredGatesManifestInternal(manifest, collector, stage = 'requiredGates') {
  if (!closedObject(manifest, ['schemaVersion', 'gates'], ['schemaVersion', 'gates'], '', collector, stage)) {
    return;
  }
  if (manifest.schemaVersion !== '1.0') {
    collector.add('M2_REQUIRED_GATES_SCHEMA_VERSION', stage, '/schemaVersion', 'expected schemaVersion 1.0');
  }
  if (!Array.isArray(manifest.gates)) {
    collector.add('M2_REQUIRED_GATES_INVENTORY', stage, '/gates', 'gates must be an array');
    return;
  }
  const actualIds = manifest.gates.map((gate) => gate?.gateId);
  validateExactStringSet(
    actualIds,
    REQUIRED_GATE_IDS,
    '/gates',
    collector,
    stage,
    'M2_REQUIRED_GATES_INVENTORY',
  );
  const required = [
    'gateId', 'reportKind', 'criterionRefs', 'toolId', 'capabilityId',
    'capabilityRef', 'capabilityDigest', 'entrypointRef', 'entrypointDigest',
    'discoveryContractRef', 'discoveryContractDigest', 'evidenceSchemaRef',
    'evidenceSchemaDigest', 'dependsOn',
  ];
  const byId = new Map();
  manifest.gates.forEach((gate, index) => {
    const at = `/gates/${index}`;
    if (!closedObject(gate, required, required, at, collector, stage)) return;
    validateAsciiId(gate.gateId, `${at}/gateId`, collector, stage);
    if (byId.has(gate.gateId)) {
      collector.add('M2_REQUIRED_GATES_DUPLICATE', stage, `${at}/gateId`, `duplicate gateId ${gate.gateId}`);
    }
    byId.set(gate.gateId, gate);
    if (!REPORT_KINDS.includes(gate.reportKind)) {
      collector.add('M2_REQUIRED_GATE_REPORT_KIND', stage, `${at}/reportKind`, 'reportKind is outside the v0.3 profile');
    } else if (REPORT_KIND_BY_GATE[gate.gateId]
      && gate.reportKind !== REPORT_KIND_BY_GATE[gate.gateId]) {
      collector.add(
        'M2_REQUIRED_GATE_REPORT_KIND',
        stage,
        `${at}/reportKind`,
        `${gate.gateId} must use reportKind ${REPORT_KIND_BY_GATE[gate.gateId]}`,
      );
    }
    validateExactStringSet(
      gate.criterionRefs,
      expectedCriterionRefsForGate(gate.gateId),
      `${at}/criterionRefs`,
      collector,
      stage,
      'M2_REQUIRED_GATE_CRITERIA',
    );
    validateAsciiId(gate.toolId, `${at}/toolId`, collector, stage);
    validateAsciiId(gate.capabilityId, `${at}/capabilityId`, collector, stage);
    for (const field of ['capabilityRef', 'entrypointRef', 'discoveryContractRef', 'evidenceSchemaRef']) {
      validateArtifactRef(gate[field], `${at}/${field}`, collector, stage, ['sourceTree', 'buildEvidence']);
    }
    for (const field of ['capabilityDigest', 'entrypointDigest', 'discoveryContractDigest', 'evidenceSchemaDigest']) {
      validateDigest(gate[field], `${at}/${field}`, collector, stage);
    }
    if (!Array.isArray(gate.dependsOn)) {
      collector.add('M2_REQUIRED_GATE_DEPENDENCY', stage, `${at}/dependsOn`, 'dependsOn must be an array');
    } else {
      ensureSortedUnique(
        gate.dependsOn,
        compareUtf8,
        `${at}/dependsOn`,
        collector,
        stage,
        'M2_REQUIRED_GATE_DEPENDENCY',
      );
      if (gate.dependsOn.includes(gate.gateId)) {
        collector.add('M2_REQUIRED_GATE_DEPENDENCY', stage, `${at}/dependsOn`, 'gate depends on itself');
      }
    }
  });

  for (const gate of manifest.gates) {
    if (!Array.isArray(gate?.dependsOn)) continue;
    for (const dependency of gate.dependsOn) {
      if (!byId.has(dependency)) {
        collector.add(
          'M2_REQUIRED_GATE_DEPENDENCY',
          stage,
          `/gates/${actualIds.indexOf(gate.gateId)}/dependsOn`,
          `${gate.gateId} has unknown dependency ${dependency}`,
        );
      }
    }
  }

  const aggregate = byId.get('aggregate-pre-manifest');
  const expectedAggregate = REQUIRED_GATE_IDS.filter((id) => id !== 'aggregate-pre-manifest');
  if (aggregate && !canonicalEqual(aggregate.dependsOn, expectedAggregate)) {
    collector.add(
      'M2_REQUIRED_GATE_AGGREGATE_DEPENDENCIES',
      stage,
      '/gates/aggregate-pre-manifest/dependsOn',
      'aggregate-pre-manifest must depend on every other required gate',
    );
  }
  const artifactDag = byId.get('artifact-dependency-dag');
  const expectedArtifactDag = REQUIRED_GATE_IDS.filter(
    (id) => !['aggregate-pre-manifest', 'artifact-dependency-dag'].includes(id),
  );
  if (artifactDag && !canonicalEqual(artifactDag.dependsOn, expectedArtifactDag)) {
    collector.add(
      'M2_REQUIRED_GATE_ARTIFACT_DAG_DEPENDENCIES',
      stage,
      '/gates/artifact-dependency-dag/dependsOn',
      'artifact-dependency-dag must depend on every ordinary gate except itself and aggregate',
    );
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(gateId, trail) {
    if (visiting.has(gateId)) {
      collector.add(
        'M2_REQUIRED_GATE_CYCLE',
        stage,
        '/gates',
        `dependency cycle ${[...trail, gateId].join(' -> ')}`,
      );
      return;
    }
    if (visited.has(gateId) || !byId.has(gateId)) return;
    visiting.add(gateId);
    for (const dependency of byId.get(gateId).dependsOn || []) visit(dependency, [...trail, gateId]);
    visiting.delete(gateId);
    visited.add(gateId);
  }
  for (const gateId of REQUIRED_GATE_IDS) visit(gateId, []);
}

function validateRequiredGatesManifest(manifest) {
  const collector = new IssueCollector();
  validateRequiredGatesManifestInternal(manifest, collector);
  return collector.sorted();
}

function requiredGatesManifestDigest(manifest) {
  return taggedJcsDigest('axiolune-required-gates-v1\0', manifest);
}

function validateReleaseVerificationChecksManifestInternal(
  manifest,
  collector,
  stage = 'releaseVerificationChecks',
) {
  const rootFields = ['schemaVersion', 'profileRef', 'stages'];
  if (!closedObject(manifest, rootFields, rootFields, '', collector, stage)) return;
  if (manifest.schemaVersion !== '1.0') {
    collector.add('M2_RELEASE_CHECKS_SCHEMA_VERSION', stage, '/schemaVersion', 'expected schemaVersion 1.0');
  }
  if (manifest.profileRef !== PROFILE_REF) {
    collector.add('M2_RELEASE_CHECKS_PROFILE', stage, '/profileRef', `expected ${PROFILE_REF}`);
  }
  if (!Array.isArray(manifest.stages)) {
    collector.add('M2_RELEASE_CHECK_STAGE_INVENTORY', stage, '/stages', 'stages must be an array');
    return;
  }
  const expectedStageIds = Object.keys(RELEASE_CHECK_IDS).sort(compareUtf8);
  validateExactStringSet(
    manifest.stages.map((entry) => entry?.stageId),
    expectedStageIds,
    '/stages',
    collector,
    stage,
    'M2_RELEASE_CHECK_STAGE_INVENTORY',
  );
  const globalPairs = new Set();
  const checkFields = [
    'checkId', 'toolId', 'capabilityId', 'capabilityRef', 'capabilityDigest',
    'entrypointRef', 'entrypointDigest', 'discoveryContractRef',
    'discoveryContractDigest', 'evidenceSchemaRef', 'evidenceSchemaDigest',
    'dependsOn',
  ];
  for (let stageIndex = 0; stageIndex < manifest.stages.length; stageIndex += 1) {
    const entry = manifest.stages[stageIndex];
    const at = `/stages/${stageIndex}`;
    if (!closedObject(entry, ['stageId', 'checks'], ['stageId', 'checks'], at, collector, stage)) continue;
    if (!Array.isArray(entry.checks)) {
      collector.add('M2_RELEASE_CHECK_INVENTORY', stage, `${at}/checks`, 'checks must be an array');
      continue;
    }
    const expectedChecks = RELEASE_CHECK_IDS[entry.stageId] || [];
    validateExactStringSet(
      entry.checks.map((check) => check?.checkId),
      expectedChecks,
      `${at}/checks`,
      collector,
      stage,
      'M2_RELEASE_CHECK_INVENTORY',
    );
    const byId = new Map();
    for (let checkIndex = 0; checkIndex < entry.checks.length; checkIndex += 1) {
      const check = entry.checks[checkIndex];
      const checkAt = `${at}/checks/${checkIndex}`;
      if (!closedObject(check, checkFields, checkFields, checkAt, collector, stage)) continue;
      validateAsciiId(check.checkId, `${checkAt}/checkId`, collector, stage);
      validateAsciiId(check.toolId, `${checkAt}/toolId`, collector, stage);
      validateAsciiId(check.capabilityId, `${checkAt}/capabilityId`, collector, stage);
      const pair = `${entry.stageId}\0${check.checkId}`;
      if (globalPairs.has(pair)) {
        collector.add('M2_RELEASE_CHECK_DUPLICATE', stage, `${checkAt}/checkId`, 'duplicate stage/check pair');
      }
      globalPairs.add(pair);
      byId.set(check.checkId, check);
      for (const field of ['capabilityRef', 'entrypointRef', 'discoveryContractRef', 'evidenceSchemaRef']) {
        validateArtifactRef(check[field], `${checkAt}/${field}`, collector, stage, ['sourceTree', 'buildEvidence']);
      }
      for (const field of ['capabilityDigest', 'entrypointDigest', 'discoveryContractDigest', 'evidenceSchemaDigest']) {
        validateDigest(check[field], `${checkAt}/${field}`, collector, stage);
      }
      if (!Array.isArray(check.dependsOn)) {
        collector.add('M2_RELEASE_CHECK_DEPENDENCY', stage, `${checkAt}/dependsOn`, 'dependsOn must be an array');
      } else {
        ensureSortedUnique(
          check.dependsOn,
          compareUtf8,
          `${checkAt}/dependsOn`,
          collector,
          stage,
          'M2_RELEASE_CHECK_DEPENDENCY',
        );
        if (check.dependsOn.includes(check.checkId)) {
          collector.add('M2_RELEASE_CHECK_DEPENDENCY', stage, `${checkAt}/dependsOn`, 'check depends on itself');
        }
      }
    }
    for (const check of entry.checks) {
      for (const dependency of check.dependsOn || []) {
        if (!byId.has(dependency)) {
          collector.add(
            'M2_RELEASE_CHECK_DEPENDENCY',
            stage,
            `${at}/checks/${entry.checks.indexOf(check)}/dependsOn`,
            `${check.checkId} has unknown or cross-stage dependency ${dependency}`,
          );
        }
      }
    }
    const visiting = new Set();
    const visited = new Set();
    function visit(checkId, trail) {
      if (visiting.has(checkId)) {
        collector.add(
          'M2_RELEASE_CHECK_CYCLE',
          stage,
          `${at}/checks`,
          `dependency cycle ${[...trail, checkId].join(' -> ')}`,
        );
        return;
      }
      if (visited.has(checkId) || !byId.has(checkId)) return;
      visiting.add(checkId);
      for (const dependency of byId.get(checkId).dependsOn || []) visit(dependency, [...trail, checkId]);
      visiting.delete(checkId);
      visited.add(checkId);
    }
    for (const checkId of expectedChecks) visit(checkId, []);
  }
}

function validateReleaseVerificationChecksManifest(manifest) {
  const collector = new IssueCollector();
  validateReleaseVerificationChecksManifestInternal(manifest, collector);
  return collector.sorted();
}

function releaseVerificationChecksManifestDigest(manifest) {
  return taggedJcsDigest('axiolune-release-verification-checks-manifest-v1\0', manifest);
}

function gateCheckKey(check) {
  return `${check?.checkId || ''}\0${check?.subjectId || ''}`;
}

function validateGateCheck(value, at, collector, stage, report) {
  const required = [
    'checkId', 'subjectId', 'subjectRef', 'subjectDigest', 'toolId',
    'capabilityId', 'capabilityRef', 'capabilityDigest', 'entrypointRef',
    'entrypointDigest', 'inputDigests', 'outputDigests', 'evidenceRef',
    'evidenceDigest', 'status',
  ];
  const allowed = [...required, 'diagnosticCode'];
  if (!closedObject(value, required, allowed, at, collector, stage)) return;
  validateAsciiId(value.checkId, `${at}/checkId`, collector, stage);
  validateDigest(value.subjectId, `${at}/subjectId`, collector, stage);
  validateArtifactRef(value.subjectRef, `${at}/subjectRef`, collector, stage);
  validateDigest(value.subjectDigest, `${at}/subjectDigest`, collector, stage);
  validateAsciiId(value.toolId, `${at}/toolId`, collector, stage);
  validateAsciiId(value.capabilityId, `${at}/capabilityId`, collector, stage);
  validateArtifactRef(value.capabilityRef, `${at}/capabilityRef`, collector, stage);
  validateDigest(value.capabilityDigest, `${at}/capabilityDigest`, collector, stage);
  validateArtifactRef(value.entrypointRef, `${at}/entrypointRef`, collector, stage);
  validateDigest(value.entrypointDigest, `${at}/entrypointDigest`, collector, stage);
  for (const field of ['inputDigests', 'outputDigests']) {
    if (!Array.isArray(value[field])) {
      collector.add('M2_VALIDATION_REPORT_DIGEST_SET', stage, `${at}/${field}`, `${field} must be an array`);
    } else {
      value[field].forEach((digest, index) => validateDigest(digest, `${at}/${field}/${index}`, collector, stage));
      ensureSortedUnique(
        value[field], compareUtf8, `${at}/${field}`, collector, stage,
        'M2_VALIDATION_REPORT_DIGEST_SET',
      );
    }
  }
  validateArtifactRef(value.evidenceRef, `${at}/evidenceRef`, collector, stage);
  validateDigest(value.evidenceDigest, `${at}/evidenceDigest`, collector, stage);
  if (!['passed', 'failed'].includes(value.status)) {
    collector.add('M2_VALIDATION_REPORT_CHECK_STATUS', stage, `${at}/status`, 'expected passed or failed');
  }
  if (Object.hasOwn(value, 'diagnosticCode')) {
    validateAsciiId(value.diagnosticCode, `${at}/diagnosticCode`, collector, stage);
  }
  if (report) {
    for (const field of [
      'toolId', 'capabilityId', 'capabilityRef', 'capabilityDigest',
      'entrypointRef', 'entrypointDigest',
    ]) {
      if (!canonicalEqual(value[field], report[field])) {
        collector.add(
          'M2_VALIDATION_REPORT_CHECK_TOOL_TUPLE',
          stage,
          `${at}/${field}`,
          `${field} differs from the enclosing ValidationReport`,
        );
      }
    }
    if (!canonicalEqual(value.evidenceRef, report.kindEvidence?.artifactRef)
        || value.evidenceDigest !== report.kindEvidence?.artifactDigest) {
      collector.add(
        'M2_VALIDATION_REPORT_CHECK_EVIDENCE_BINDING',
        stage,
        `${at}/evidenceRef`,
        'GateCheck evidence ref/digest differs from the enclosing kindEvidence artifact',
      );
    }
  }
}

function gateViolationKey(value) {
  return [
    value?.checkId || '', value?.subjectId || '', value?.diagnosticCode || '',
    artifactRefSortKey(value?.subjectRef).toString('hex'), value?.severity || '',
    Object.hasOwn(value || {}, 'path') ? '1' : '0', value?.path || '',
    Object.hasOwn(value || {}, 'constraintRef') ? '1' : '0', value?.constraintRef || '',
    Object.hasOwn(value || {}, 'focusNode') ? '1' : '0', value?.focusNode || '',
    Object.hasOwn(value || {}, 'component') ? '1' : '0', value?.component || '',
    value?.message || '',
  ].join('\0');
}

function validateGateViolation(value, at, collector, stage) {
  const required = ['checkId', 'subjectId', 'diagnosticCode', 'subjectRef', 'severity', 'message'];
  const allowed = [...required, 'path', 'constraintRef', 'focusNode', 'component'];
  if (!closedObject(value, required, allowed, at, collector, stage)) return;
  validateAsciiId(value.checkId, `${at}/checkId`, collector, stage);
  validateDigest(value.subjectId, `${at}/subjectId`, collector, stage);
  validateAsciiId(value.diagnosticCode, `${at}/diagnosticCode`, collector, stage);
  validateArtifactRef(value.subjectRef, `${at}/subjectRef`, collector, stage);
  if (!['error', 'warning', 'info'].includes(value.severity)) {
    collector.add('M2_VALIDATION_REPORT_VIOLATION_SEVERITY', stage, `${at}/severity`, 'invalid severity');
  }
  validateString(value.message, `${at}/message`, collector, stage);
  if (Object.hasOwn(value, 'path')) {
    validatePathOrAbsoluteIri(value.path, `${at}/path`, collector, stage);
  }
  if (Object.hasOwn(value, 'constraintRef')) {
    validateAbsoluteIri(value.constraintRef, `${at}/constraintRef`, collector, stage);
  }
  if (Object.hasOwn(value, 'focusNode')) {
    validateCanonicalNTriplesTerm(value.focusNode, `${at}/focusNode`, collector, stage);
  }
  if (Object.hasOwn(value, 'component')) {
    validateAsciiIdOrAbsoluteIri(value.component, `${at}/component`, collector, stage);
  }
}

function validateValidationReportResult(result, at, collector, stage, report) {
  const fields = ['outcome', 'checks', 'violations', 'errors'];
  if (!closedObject(result, fields, fields, at, collector, stage)) return;
  if (!Array.isArray(result.checks)) {
    collector.add('M2_VALIDATION_REPORT_CHECKS', stage, `${at}/checks`, 'checks must be an array');
    return;
  }
  result.checks.forEach((check, index) => validateGateCheck(
    check,
    `${at}/checks/${index}`,
    collector,
    stage,
    report,
  ));
  ensureSortedUnique(
    result.checks,
    (left, right) => compareUtf8(gateCheckKey(left), gateCheckKey(right)),
    `${at}/checks`,
    collector,
    stage,
    'M2_VALIDATION_REPORT_CHECK_ORDER',
  );
  if (!Array.isArray(result.violations)) {
    collector.add('M2_VALIDATION_REPORT_VIOLATIONS', stage, `${at}/violations`, 'violations must be an array');
  } else {
    result.violations.forEach((violation, index) => validateGateViolation(
      violation,
      `${at}/violations/${index}`,
      collector,
      stage,
    ));
    ensureSortedUnique(
      result.violations,
      (left, right) => compareUtf8(gateViolationKey(left), gateViolationKey(right)),
      `${at}/violations`,
      collector,
      stage,
      'M2_VALIDATION_REPORT_VIOLATION_ORDER',
    );
  }

  if (result.outcome === 'failed' && Array.isArray(result.violations)) {
    const checksByKey = new Map(result.checks.map((check) => [gateCheckKey(check), check]));
    const violatedCheckKeys = new Set();
    for (let index = 0; index < result.violations.length; index += 1) {
      const violation = result.violations[index];
      const key = gateCheckKey(violation);
      const check = checksByKey.get(key);
      if (!check || check.status !== 'failed'
          || !canonicalEqual(check.subjectRef, violation?.subjectRef)) {
        collector.add(
          'M2_VALIDATION_REPORT_VIOLATION_CHECK_JOIN',
          stage,
          `${at}/violations/${index}`,
          'GateViolation does not join a failed GateCheck with the same check/subject/ref tuple',
        );
        continue;
      }
      if (Object.hasOwn(check, 'diagnosticCode')
          && check.diagnosticCode !== violation.diagnosticCode) {
        collector.add(
          'M2_VALIDATION_REPORT_VIOLATION_DIAGNOSTIC_JOIN',
          stage,
          `${at}/violations/${index}/diagnosticCode`,
          'GateViolation diagnosticCode differs from its failed GateCheck',
        );
      }
      violatedCheckKeys.add(key);
    }
    for (let index = 0; index < result.checks.length; index += 1) {
      const check = result.checks[index];
      if (check?.status === 'failed' && !violatedCheckKeys.has(gateCheckKey(check))) {
        collector.add(
          'M2_VALIDATION_REPORT_FAILED_CHECK_VIOLATION',
          stage,
          `${at}/checks/${index}`,
          'failed GateCheck has no joined GateViolation',
        );
      }
    }
  }
  validateExecutionErrors(
    result.errors,
    `${at}/errors`,
    collector,
    stage,
    { nonEmpty: result.outcome === 'engineFailure' },
  );

  const counts = report?.counts || {};
  const passed = result.checks.filter((check) => check?.status === 'passed').length;
  const failed = result.checks.filter((check) => check?.status === 'failed').length;
  const warningCount = Array.isArray(result.violations)
    ? result.violations.filter((violation) => violation?.severity === 'warning').length
    : 0;
  if (counts.executed !== result.checks.length || counts.passed !== passed
      || counts.failed !== failed || counts.warnings !== warningCount) {
    collector.add(
      'M2_VALIDATION_REPORT_COUNT_MISMATCH',
      stage,
      '/counts',
      'counts do not recompute from checks and violations',
    );
  }

  if (result.outcome === 'passed') {
    if (result.checks.length === 0 || failed !== 0
        || (result.violations || []).length !== 0 || (result.errors || []).length !== 0
        || counts.discovered !== result.checks.length || counts.executed !== counts.discovered
        || counts.passed !== counts.discovered || counts.failed !== 0
        || counts.skipped !== 0 || counts.pending !== 0 || counts.warnings !== 0) {
      collector.add(
        'M2_VALIDATION_REPORT_PASSED_MATRIX',
        stage,
        at,
        'passed requires complete non-empty all-passed execution with zero violations/errors/skips/pending/warnings',
      );
    }
  } else if (result.outcome === 'failed') {
    if (failed === 0 || (result.violations || []).length === 0 || (result.errors || []).length !== 0) {
      collector.add(
        'M2_VALIDATION_REPORT_FAILED_MATRIX',
        stage,
        at,
        'failed requires a failed check, non-empty violations, and zero errors',
      );
    }
  } else if (result.outcome === 'engineFailure') {
    if ((result.violations || []).length !== 0 || (result.errors || []).length === 0) {
      collector.add(
        'M2_VALIDATION_REPORT_ENGINE_FAILURE_MATRIX',
        stage,
        at,
        'engineFailure requires zero violations and non-empty errors',
      );
    }
  } else {
    collector.add('M2_VALIDATION_REPORT_OUTCOME', stage, `${at}/outcome`, 'unknown result outcome');
  }
}

function validateValidationReportInternal(report, gate, collector, stage = 'validationReport') {
  const common = [
    'schemaVersion', 'iri', 'slotId', 'reportId', 'attemptId',
    'plannedInputDigest', 'resolvedInputDigest', 'recordType', 'profileRef',
    'gateId', 'reportKind', 'criterionRefs', 'subjectRef', 'build', 'inputs',
    'toolId', 'capabilityId', 'capabilityRef', 'capabilityDigest',
    'entrypointRef', 'entrypointDigest', 'discoveryContractRef',
    'discoveryContractDigest', 'subjectInventoryRef', 'subjectInventoryDigest',
    'kindEvidence', 'counts', 'result',
  ];
  const pit = [
    'requestRef', 'requestRecordDigest', 'contextRef', 'contextRecordDigest',
    'recomputedTargetDigest', 'asOfValid', 'asOfKnowledge', 'asOfAvailable',
  ];
  const batch = ['memberRunRecordDigests', 'outputDatasetDigest'];
  const extra = report?.reportKind === 'pit' ? pit : report?.reportKind === 'batch' ? batch : [];
  const fields = [...common, ...extra];
  if (!closedObject(report, fields, fields, '', collector, stage)) return;
  if (report.schemaVersion !== '1.0') {
    collector.add('M2_VALIDATION_REPORT_SCHEMA_VERSION', stage, '/schemaVersion', 'expected schemaVersion 1.0');
  }
  validateAbsoluteIri(report.iri, '/iri', collector, stage);
  validateRecordId(report.slotId, '/slotId', collector, stage);
  validateRecordId(report.reportId, '/reportId', collector, stage);
  validateRecordId(report.attemptId, '/attemptId', collector, stage);
  validateDigest(report.plannedInputDigest, '/plannedInputDigest', collector, stage);
  validateDigest(report.resolvedInputDigest, '/resolvedInputDigest', collector, stage);
  if (report.recordType !== 'validationReport') {
    collector.add('M2_VALIDATION_REPORT_RECORD_TYPE', stage, '/recordType', 'expected validationReport');
  }
  if (report.profileRef !== PROFILE_REF) {
    collector.add('M2_VALIDATION_REPORT_PROFILE', stage, '/profileRef', `expected ${PROFILE_REF}`);
  }
  validateAsciiId(report.gateId, '/gateId', collector, stage);
  if (!REPORT_KINDS.includes(report.reportKind)) {
    collector.add('M2_VALIDATION_REPORT_KIND', stage, '/reportKind', 'reportKind is outside the v0.3 profile');
  }
  if (!Array.isArray(report.criterionRefs) || report.criterionRefs.length === 0) {
    collector.add(
      'M2_VALIDATION_REPORT_CRITERIA',
      stage,
      '/criterionRefs',
      'criterionRefs must be a non-empty array',
    );
  } else {
    report.criterionRefs.forEach((criterionRef, index) => validateAbsoluteIri(
      criterionRef,
      `/criterionRefs/${index}`,
      collector,
      stage,
    ));
    ensureSortedUnique(
      report.criterionRefs,
      compareUtf8,
      '/criterionRefs',
      collector,
      stage,
      'M2_VALIDATION_REPORT_CRITERIA',
    );
  }
  if (gate) {
    const tuple = [
      'gateId', 'reportKind', 'criterionRefs', 'toolId', 'capabilityId',
      'capabilityRef', 'capabilityDigest', 'entrypointRef', 'entrypointDigest',
      'discoveryContractRef', 'discoveryContractDigest',
    ];
    for (const field of tuple) {
      if (!canonicalEqual(report[field], gate[field])) {
        collector.add(
          'M2_VALIDATION_REPORT_GATE_TUPLE',
          stage,
          `/${field}`,
          `${field} differs from required-gates-manifest`,
        );
      }
    }
  }
  validateArtifactRef(report.subjectRef, '/subjectRef', collector, stage, ['sourceTree', 'buildEvidence']);
  validateBuildEvidenceBinding(report.build, '/build', collector, stage);
  validateArtifactBindings(report.inputs, '/inputs', collector, stage, {
    nonEmpty: true,
    allowedRoots: ['sourceTree', 'buildEvidence'],
  });
  validateAsciiId(report.toolId, '/toolId', collector, stage);
  validateAsciiId(report.capabilityId, '/capabilityId', collector, stage);
  for (const field of [
    'capabilityRef', 'entrypointRef', 'discoveryContractRef', 'subjectInventoryRef',
  ]) {
    validateArtifactRef(report[field], `/${field}`, collector, stage, ['sourceTree', 'buildEvidence']);
  }
  for (const field of [
    'capabilityDigest', 'entrypointDigest', 'discoveryContractDigest',
    'subjectInventoryDigest',
  ]) {
    validateDigest(report[field], `/${field}`, collector, stage);
  }
  if (isPlainObject(report.kindEvidence)) {
    const fields = ['schemaRef', 'schemaDigest', 'artifactRef', 'artifactDigest'];
    closedObject(report.kindEvidence, fields, fields, '/kindEvidence', collector, stage);
    validateArtifactRef(
      report.kindEvidence.schemaRef,
      '/kindEvidence/schemaRef',
      collector,
      stage,
      ['sourceTree', 'buildEvidence'],
    );
    validateDigest(report.kindEvidence.schemaDigest, '/kindEvidence/schemaDigest', collector, stage);
    validateArtifactRef(report.kindEvidence.artifactRef, '/kindEvidence/artifactRef', collector, stage);
    validateDigest(report.kindEvidence.artifactDigest, '/kindEvidence/artifactDigest', collector, stage);
    if (gate && (!canonicalEqual(report.kindEvidence.schemaRef, gate.evidenceSchemaRef)
      || report.kindEvidence.schemaDigest !== gate.evidenceSchemaDigest)) {
      collector.add(
        'M2_VALIDATION_REPORT_EVIDENCE_SCHEMA',
        stage,
        '/kindEvidence',
        'kindEvidence schema binding differs from required-gates-manifest',
      );
    }
  } else {
    collector.add('M2_RELEASE_EXPECTED_OBJECT', stage, '/kindEvidence', 'kindEvidence must be an object');
  }
  const countFields = ['discovered', 'executed', 'passed', 'failed', 'skipped', 'pending', 'warnings'];
  if (closedObject(report.counts, countFields, countFields, '/counts', collector, stage)) {
    for (const field of countFields) {
      if (!Number.isSafeInteger(report.counts[field]) || report.counts[field] < 0) {
        collector.add('M2_VALIDATION_REPORT_COUNT', stage, `/counts/${field}`, 'expected a non-negative safe integer');
      }
    }
  }
  validateValidationReportResult(report.result, '/result', collector, stage, report);

  if (report.reportKind === 'pit') {
    for (const field of ['requestRef', 'contextRef']) {
      validateArtifactRef(report[field], `/${field}`, collector, stage);
    }
    for (const field of ['requestRecordDigest', 'contextRecordDigest', 'recomputedTargetDigest']) {
      validateDigest(report[field], `/${field}`, collector, stage);
    }
    for (const field of ['asOfValid', 'asOfKnowledge', 'asOfAvailable']) {
      validateInstant(report[field], `/${field}`, collector, stage);
    }
  }
  if (report.reportKind === 'batch') {
    if (!Array.isArray(report.memberRunRecordDigests) || report.memberRunRecordDigests.length === 0) {
      collector.add('M2_VALIDATION_REPORT_BATCH_MEMBERS', stage, '/memberRunRecordDigests', 'expected a non-empty digest list');
    } else {
      report.memberRunRecordDigests.forEach((digest, index) => validateDigest(
        digest,
        `/memberRunRecordDigests/${index}`,
        collector,
        stage,
      ));
      ensureSortedUnique(
        report.memberRunRecordDigests,
        compareUtf8,
        '/memberRunRecordDigests',
        collector,
        stage,
        'M2_VALIDATION_REPORT_BATCH_MEMBERS',
      );
    }
    validateDigest(report.outputDatasetDigest, '/outputDatasetDigest', collector, stage);
  }
}

function validateValidationReport(report, gate = null) {
  const collector = new IssueCollector();
  validateValidationReportInternal(report, gate, collector);
  return collector.sorted();
}

function validatePayloadEntry(value, at, collector, stage) {
  const fields = ['path', 'mediaType', 'byteLength', 'payloadByteDigest'];
  if (!closedObject(value, fields, fields, at, collector, stage)) return;
  validatePosixRelativePath(value.path, `${at}/path`, collector, stage);
  if (typeof value.mediaType !== 'string' || !MEDIA_TYPE_RE.test(value.mediaType)) {
    collector.add('M2_RELEASE_MEDIA_TYPE', stage, `${at}/mediaType`, 'expected an IANA media type');
  }
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0) {
    collector.add('M2_RELEASE_BYTE_LENGTH', stage, `${at}/byteLength`, 'expected a non-negative safe integer');
  }
  validateDigest(value.payloadByteDigest, `${at}/payloadByteDigest`, collector, stage);
}

function validatePayloadEntries(values, at, collector, stage) {
  if (!Array.isArray(values) || values.length === 0) {
    collector.add('M2_RELEASE_PAYLOAD_ENTRIES', stage, at, 'expected a non-empty PayloadEntry array');
    return;
  }
  values.forEach((value, index) => validatePayloadEntry(value, `${at}/${index}`, collector, stage));
  ensureSortedUnique(
    values,
    (left, right) => compareUtf8(left?.path, right?.path),
    at,
    collector,
    stage,
    'M2_RELEASE_PAYLOAD_ENTRY_ORDER',
  );
}

function validateGitObjectId(value, objectFormat, at, collector, stage) {
  const length = objectFormat === 'sha1' ? 40 : objectFormat === 'sha256' ? 64 : -1;
  if (length < 0) {
    collector.add('M2_RELEASE_GIT_OBJECT_FORMAT', stage, at, 'expected git object format sha1 or sha256');
    return false;
  }
  const pattern = new RegExp(`^[0-9a-f]{${length}}$`, 'u');
  if (typeof value !== 'string' || !pattern.test(value) || /^0+$/u.test(value)) {
    collector.add('M2_RELEASE_GIT_OBJECT_ID', stage, at, `expected a non-zero ${length}-hex Git object ID`);
    return false;
  }
  return true;
}

function validateAuthoritativeRef(value, at, collector, stage) {
  if (typeof value !== 'string' || !value.startsWith('refs/')
      || value === 'refs/HEAD' || /[\x00-\x20~^:?*\[\\]/u.test(value)
      || value.includes('..') || value.includes('@{') || value.includes('//')
      || value.endsWith('/') || value.split('/').some((segment) => segment === ''
        || segment.startsWith('.') || segment.endsWith('.') || segment.endsWith('.lock'))) {
    collector.add('M2_RELEASE_AUTHORITATIVE_REF', stage, at, 'expected a normalized full refs/... name');
    return false;
  }
  return true;
}

function validateGateReportRows(values, at, collector, stage) {
  if (!Array.isArray(values)) {
    collector.add('M2_RELEASE_GATE_REPORT_INVENTORY', stage, at, 'gateReports must be an array');
    return;
  }
  validateExactStringSet(
    values.map((value) => value?.gateId),
    REQUIRED_GATE_IDS,
    at,
    collector,
    stage,
    'M2_RELEASE_GATE_REPORT_INVENTORY',
  );
  const fields = ['gateId', 'reportRef', 'reportDigest', 'outcome'];
  values.forEach((value, index) => {
    const rowAt = `${at}/${index}`;
    if (!closedObject(value, fields, fields, rowAt, collector, stage)) return;
    validateAsciiId(value.gateId, `${rowAt}/gateId`, collector, stage);
    validateArtifactRef(value.reportRef, `${rowAt}/reportRef`, collector, stage);
    validateDigest(value.reportDigest, `${rowAt}/reportDigest`, collector, stage);
    if (value.outcome !== 'passed') {
      collector.add(
        'M2_RELEASE_GATE_REPORT_OUTCOME',
        stage,
        `${rowAt}/outcome`,
        'release manifests may index only passed required-gate reports',
      );
    }
  });
}

function verifierCheckKey(value) {
  return value?.checkId || '';
}

function validateVerifierCheck(value, at, collector, stage, manifestRow = null) {
  const fields = [
    'checkId', 'toolId', 'capabilityId', 'capabilityRef', 'capabilityDigest',
    'entrypointRef', 'entrypointDigest', 'discoveryContractRef',
    'discoveryContractDigest', 'evidenceSchemaRef', 'evidenceSchemaDigest',
    'subjectInventoryRef', 'subjectInventoryDigest', 'counts', 'evidenceRef',
    'evidenceDigest', 'status',
  ];
  if (!closedObject(value, fields, fields, at, collector, stage)) return;
  validateAsciiId(value.checkId, `${at}/checkId`, collector, stage);
  validateAsciiId(value.toolId, `${at}/toolId`, collector, stage);
  validateAsciiId(value.capabilityId, `${at}/capabilityId`, collector, stage);
  for (const field of [
    'capabilityRef', 'entrypointRef', 'discoveryContractRef', 'evidenceSchemaRef',
    'subjectInventoryRef', 'evidenceRef',
  ]) {
    validateArtifactRef(value[field], `${at}/${field}`, collector, stage);
  }
  for (const field of [
    'capabilityDigest', 'entrypointDigest', 'discoveryContractDigest',
    'evidenceSchemaDigest', 'subjectInventoryDigest', 'evidenceDigest',
  ]) {
    validateDigest(value[field], `${at}/${field}`, collector, stage);
  }
  const countFields = ['discovered', 'executed', 'passed', 'failed'];
  if (closedObject(value.counts, countFields, countFields, `${at}/counts`, collector, stage)) {
    for (const field of countFields) {
      if (!Number.isSafeInteger(value.counts[field]) || value.counts[field] < 0) {
        collector.add('M2_RELEASE_VERIFIER_CHECK_COUNT', stage, `${at}/counts/${field}`, 'expected a non-negative safe integer');
      }
    }
    if (value.status === 'passed') {
      if (!(value.counts.discovered === value.counts.executed
        && value.counts.executed === value.counts.passed
        && value.counts.passed > 0 && value.counts.failed === 0)) {
        collector.add(
          'M2_RELEASE_VERIFIER_CHECK_PASSED_MATRIX',
          stage,
          `${at}/counts`,
          'passed check requires discovered == executed == passed > 0 and failed == 0',
        );
      }
    } else if (value.status === 'failed') {
      if (!(value.counts.discovered === value.counts.executed
        && value.counts.executed === value.counts.passed + value.counts.failed
        && value.counts.discovered > 0 && value.counts.failed > 0)) {
        collector.add(
          'M2_RELEASE_VERIFIER_CHECK_FAILED_MATRIX',
          stage,
          `${at}/counts`,
          'failed check requires complete execution and at least one failure',
        );
      }
    } else {
      collector.add('M2_RELEASE_VERIFIER_CHECK_STATUS', stage, `${at}/status`, 'expected passed or failed');
    }
  }
  if (manifestRow) {
    for (const field of [
      'checkId', 'toolId', 'capabilityId', 'capabilityRef', 'capabilityDigest',
      'entrypointRef', 'entrypointDigest', 'discoveryContractRef',
      'discoveryContractDigest', 'evidenceSchemaRef', 'evidenceSchemaDigest',
    ]) {
      if (!canonicalEqual(value[field], manifestRow[field])) {
        collector.add(
          'M2_RELEASE_VERIFIER_CHECK_TUPLE',
          stage,
          `${at}/${field}`,
          `${field} differs from release-verification-checks-manifest`,
        );
      }
    }
  }
}

function validateVerifierChecks(values, at, collector, stage, manifestStage, outcome) {
  if (!Array.isArray(values)) {
    collector.add('M2_RELEASE_VERIFIER_CHECK_INVENTORY', stage, at, 'checks must be an array');
    return;
  }
  const expectedRows = manifestStage?.checks || [];
  const expectedIds = expectedRows.map((row) => row.checkId);
  const actualIds = values.map((row) => row?.checkId);
  ensureSortedUnique(
    values,
    (left, right) => compareUtf8(verifierCheckKey(left), verifierCheckKey(right)),
    at,
    collector,
    stage,
    'M2_RELEASE_VERIFIER_CHECK_ORDER',
  );
  if (manifestStage && outcome !== 'engineFailure' && !canonicalEqual(actualIds, expectedIds)) {
    collector.add(
      'M2_RELEASE_VERIFIER_CHECK_INVENTORY',
      stage,
      at,
      'passed/failed verifier report must contain the exact static check inventory',
    );
  }
  if (manifestStage && actualIds.some((checkId) => !expectedIds.includes(checkId))) {
    collector.add(
      'M2_RELEASE_VERIFIER_CHECK_INVENTORY',
      stage,
      at,
      'verifier report contains a check outside the reviewed static inventory',
    );
  }
  const byId = new Map(expectedRows.map((row) => [row.checkId, row]));
  values.forEach((value, index) => validateVerifierCheck(
    value,
    `${at}/${index}`,
    collector,
    stage,
    byId.get(value?.checkId) || null,
  ));
  if (outcome === 'engineFailure' && manifestStage) {
    const present = new Set(actualIds);
    for (const check of values) {
      for (const dependency of byId.get(check?.checkId)?.dependsOn || []) {
        if (!present.has(dependency)) {
          collector.add(
            'M2_RELEASE_VERIFIER_CHECK_DEPENDENCY_CLOSURE',
            stage,
            at,
            `engineFailure subset includes ${check.checkId} without dependency ${dependency}`,
          );
        }
      }
    }
  }
}

function validateVerificationOutcome(outcome, checks, errors, at, collector, stage) {
  const passed = Array.isArray(checks) ? checks.filter((check) => check?.status === 'passed').length : 0;
  const failed = Array.isArray(checks) ? checks.filter((check) => check?.status === 'failed').length : 0;
  if (outcome === 'passed') {
    if (!Array.isArray(checks) || checks.length === 0 || passed !== checks.length
        || !Array.isArray(errors) || errors.length !== 0) {
      collector.add(
        'M2_RELEASE_VERIFICATION_PASSED_MATRIX',
        stage,
        at,
        'passed requires every check passed and errors exactly empty',
      );
    }
  } else if (outcome === 'failed') {
    if (failed === 0 || !Array.isArray(errors) || errors.length !== 0) {
      collector.add(
        'M2_RELEASE_VERIFICATION_FAILED_MATRIX',
        stage,
        at,
        'failed requires at least one failed check and errors exactly empty',
      );
    }
  } else if (outcome === 'engineFailure') {
    if (!Array.isArray(errors) || errors.length === 0) {
      collector.add(
        'M2_RELEASE_VERIFICATION_ENGINE_FAILURE_MATRIX',
        stage,
        at,
        'engineFailure requires non-empty errors',
      );
    }
  } else {
    collector.add('M2_RELEASE_VERIFICATION_OUTCOME', stage, at, 'unknown verification outcome');
  }
}

function releaseCheckStage(manifest, stageId) {
  return manifest?.stages?.find((entry) => entry.stageId === stageId) || null;
}

function validateP0ReviewManifestInternal(manifest, collector, stage = 'p0ReviewManifest') {
  const fields = [
    'schemaVersion', 'phase', 'targetVersion', 'repositoryId', 'authoritativeRef',
    'expectedOldCommitId', 'gitObjectFormat', 'reviewCommitId', 'reviewTreeId',
    'build', 'requiredGatesManifestRef', 'requiredGatesManifestDigest',
    'releaseVerificationChecksManifestRef', 'releaseVerificationChecksManifestDigest',
    'evidenceLedgerRef', 'evidenceLedgerDigest', 'gateReports', 'entries',
  ];
  if (!closedObject(manifest, fields, fields, '', collector, stage)) return;
  if (manifest.schemaVersion !== '1.0') collector.add('M2_P0_SCHEMA_VERSION', stage, '/schemaVersion', 'expected 1.0');
  if (manifest.phase !== 'P0-review') collector.add('M2_P0_PHASE', stage, '/phase', 'expected P0-review');
  if (manifest.targetVersion !== TARGET_VERSION) collector.add('M2_P0_TARGET_VERSION', stage, '/targetVersion', `expected ${TARGET_VERSION}`);
  validateAbsoluteIri(manifest.repositoryId, '/repositoryId', collector, stage);
  validateAuthoritativeRef(manifest.authoritativeRef, '/authoritativeRef', collector, stage);
  if (!['sha1', 'sha256'].includes(manifest.gitObjectFormat)) {
    collector.add('M2_RELEASE_GIT_OBJECT_FORMAT', stage, '/gitObjectFormat', 'expected sha1 or sha256');
  }
  for (const field of ['expectedOldCommitId', 'reviewCommitId', 'reviewTreeId']) {
    validateGitObjectId(manifest[field], manifest.gitObjectFormat, `/${field}`, collector, stage);
  }
  if (manifest.expectedOldCommitId !== manifest.reviewCommitId) {
    collector.add('M2_P0_OLD_COMMIT_BINDING', stage, '/expectedOldCommitId', 'P0 old commit must equal reviewCommitId');
  }
  validateBuildEvidenceBinding(manifest.build, '/build', collector, stage);
  for (const field of [
    'requiredGatesManifestRef', 'releaseVerificationChecksManifestRef', 'evidenceLedgerRef',
  ]) {
    validateArtifactRef(manifest[field], `/${field}`, collector, stage);
  }
  for (const field of [
    'requiredGatesManifestDigest', 'releaseVerificationChecksManifestDigest', 'evidenceLedgerDigest',
  ]) {
    validateDigest(manifest[field], `/${field}`, collector, stage);
  }
  validateGateReportRows(manifest.gateReports, '/gateReports', collector, stage);
  validatePayloadEntries(manifest.entries, '/entries', collector, stage);
}

function validateP0ReviewManifest(manifest) {
  const collector = new IssueCollector();
  validateP0ReviewManifestInternal(manifest, collector);
  return collector.sorted();
}

function validateP0VerificationReportInternal(report, checksManifest, collector, stage = 'p0VerificationReport') {
  const fields = [
    'schemaVersion', 'repositoryId', 'authoritativeRef', 'expectedOldCommitId',
    'gitObjectFormat', 'p0ManifestRef', 'p0ManifestDigest', 'reviewCommitId',
    'reviewTreeId', 'buildId', 'sourceTreeDigest', 'buildInputsDigest',
    'toolLockDigest', 'verifierRef', 'verifierDigest', 'checks', 'outcome', 'errors',
  ];
  if (!closedObject(report, fields, fields, '', collector, stage)) return;
  if (report.schemaVersion !== '1.0') collector.add('M2_P0_VERIFICATION_SCHEMA_VERSION', stage, '/schemaVersion', 'expected 1.0');
  validateAbsoluteIri(report.repositoryId, '/repositoryId', collector, stage);
  validateAuthoritativeRef(report.authoritativeRef, '/authoritativeRef', collector, stage);
  if (!['sha1', 'sha256'].includes(report.gitObjectFormat)) collector.add('M2_RELEASE_GIT_OBJECT_FORMAT', stage, '/gitObjectFormat', 'expected sha1 or sha256');
  for (const field of ['expectedOldCommitId', 'reviewCommitId', 'reviewTreeId']) {
    validateGitObjectId(report[field], report.gitObjectFormat, `/${field}`, collector, stage);
  }
  validateArtifactRef(report.p0ManifestRef, '/p0ManifestRef', collector, stage);
  validateDigest(report.p0ManifestDigest, '/p0ManifestDigest', collector, stage);
  for (const field of ['buildId', 'sourceTreeDigest', 'buildInputsDigest', 'toolLockDigest', 'verifierDigest']) {
    validateDigest(report[field], `/${field}`, collector, stage);
  }
  validateArtifactRef(report.verifierRef, '/verifierRef', collector, stage);
  validateVerifierChecks(
    report.checks,
    '/checks',
    collector,
    stage,
    releaseCheckStage(checksManifest, 'p0Verification'),
    report.outcome,
  );
  validateExecutionErrors(report.errors, '/errors', collector, stage, { nonEmpty: report.outcome === 'engineFailure' });
  validateVerificationOutcome(report.outcome, report.checks, report.errors, '/outcome', collector, stage);
}

function validateP0VerificationReport(report, checksManifest = null) {
  const collector = new IssueCollector();
  validateP0VerificationReportInternal(report, checksManifest, collector);
  return collector.sorted();
}

function validateRequiredRoots(values, at, collector, stage) {
  if (!Array.isArray(values)) {
    collector.add('M2_P1_REQUIRED_ROOTS', stage, at, 'requiredRoots must be an array');
    return;
  }
  validateExactStringSet(
    values.map((value) => value?.rootKind),
    REQUIRED_ROOT_KINDS,
    at,
    collector,
    stage,
    'M2_P1_REQUIRED_ROOTS',
  );
  const fields = [
    'rootKind', 'rootManifestRef', 'rootManifestDigest',
    'discoveryCapabilityRef', 'discoveryCapabilityDigest',
  ];
  values.forEach((value, index) => {
    const rootAt = `${at}/${index}`;
    if (!closedObject(value, fields, fields, rootAt, collector, stage)) return;
    validateAsciiId(value.rootKind, `${rootAt}/rootKind`, collector, stage);
    validateArtifactRef(value.rootManifestRef, `${rootAt}/rootManifestRef`, collector, stage);
    validateDigest(value.rootManifestDigest, `${rootAt}/rootManifestDigest`, collector, stage);
    validateArtifactRef(value.discoveryCapabilityRef, `${rootAt}/discoveryCapabilityRef`, collector, stage);
    validateDigest(value.discoveryCapabilityDigest, `${rootAt}/discoveryCapabilityDigest`, collector, stage);
  });
}

function validateP1PayloadManifestInternal(manifest, collector, stage = 'p1PayloadManifest') {
  const fields = [
    'schemaVersion', 'phase', 'targetVersion', 'repositoryId', 'authoritativeRef',
    'expectedOldCommitId', 'prospectiveCommitId', 'treeId', 'parentCommitId',
    'gitObjectFormat', 'sourceTreeManifestRef', 'sourceTreeManifestDigest',
    'build', 'requiredGatesManifestRef', 'requiredGatesManifestDigest',
    'releaseVerificationChecksManifestRef', 'releaseVerificationChecksManifestDigest',
    'evidenceLedgerRef', 'evidenceLedgerDigest', 'gateReports', 'p0ManifestRef',
    'p0ManifestDigest', 'p0VerificationReportRef', 'p0VerificationReportDigest',
    'promotionAuthorizationRef', 'promotionAuthorizationDigest', 'p0P1LinkRef',
    'p0P1LinkDigest', 'requiredRoots', 'payloadArtifactCatalogRef',
    'payloadArtifactCatalogDigest', 'payloadArtifactDependencyManifestRef',
    'payloadArtifactDependencyManifestDigest', 'entries',
  ];
  if (!closedObject(manifest, fields, fields, '', collector, stage)) return;
  if (manifest.schemaVersion !== '1.0') collector.add('M2_P1_SCHEMA_VERSION', stage, '/schemaVersion', 'expected 1.0');
  if (manifest.phase !== 'P1-release-candidate') collector.add('M2_P1_PHASE', stage, '/phase', 'expected P1-release-candidate');
  if (manifest.targetVersion !== TARGET_VERSION) collector.add('M2_P1_TARGET_VERSION', stage, '/targetVersion', `expected ${TARGET_VERSION}`);
  validateAbsoluteIri(manifest.repositoryId, '/repositoryId', collector, stage);
  validateAuthoritativeRef(manifest.authoritativeRef, '/authoritativeRef', collector, stage);
  if (!['sha1', 'sha256'].includes(manifest.gitObjectFormat)) collector.add('M2_RELEASE_GIT_OBJECT_FORMAT', stage, '/gitObjectFormat', 'expected sha1 or sha256');
  for (const field of ['expectedOldCommitId', 'prospectiveCommitId', 'treeId', 'parentCommitId']) {
    validateGitObjectId(manifest[field], manifest.gitObjectFormat, `/${field}`, collector, stage);
  }
  if (manifest.expectedOldCommitId !== manifest.parentCommitId) {
    collector.add('M2_P1_PARENT_BINDING', stage, '/parentCommitId', 'P1 parentCommitId must equal expectedOldCommitId');
  }
  if (manifest.prospectiveCommitId === manifest.parentCommitId) {
    collector.add('M2_P1_COMMIT_TRANSITION', stage, '/prospectiveCommitId', 'P1 prospective commit must differ from P0 parent');
  }
  validateBuildEvidenceBinding(manifest.build, '/build', collector, stage);
  for (const field of [
    'sourceTreeManifestRef', 'requiredGatesManifestRef',
    'releaseVerificationChecksManifestRef', 'evidenceLedgerRef', 'p0ManifestRef',
    'p0VerificationReportRef', 'promotionAuthorizationRef', 'p0P1LinkRef',
    'payloadArtifactCatalogRef', 'payloadArtifactDependencyManifestRef',
  ]) {
    validateArtifactRef(manifest[field], `/${field}`, collector, stage);
  }
  for (const field of [
    'sourceTreeManifestDigest', 'requiredGatesManifestDigest',
    'releaseVerificationChecksManifestDigest', 'evidenceLedgerDigest',
    'p0ManifestDigest', 'p0VerificationReportDigest', 'promotionAuthorizationDigest',
    'p0P1LinkDigest', 'payloadArtifactCatalogDigest',
    'payloadArtifactDependencyManifestDigest',
  ]) {
    validateDigest(manifest[field], `/${field}`, collector, stage);
  }
  validateGateReportRows(manifest.gateReports, '/gateReports', collector, stage);
  validateRequiredRoots(manifest.requiredRoots, '/requiredRoots', collector, stage);
  validatePayloadEntries(manifest.entries, '/entries', collector, stage);
  if ((manifest.entries || []).some((entry) => entry.path === 'payload-manifest.json')) {
    collector.add('M2_P1_SELF_ENTRY', stage, '/entries', 'P1PayloadManifest must not list itself');
  }
}

function validateP1PayloadManifest(manifest) {
  const collector = new IssueCollector();
  validateP1PayloadManifestInternal(manifest, collector);
  return collector.sorted();
}

function validatePayloadVerificationReportInternal(
  report,
  checksManifest,
  collector,
  stage = 'payloadVerificationReport',
) {
  const fields = [
    'schemaVersion', 'repositoryId', 'authoritativeRef', 'expectedOldCommitId',
    'gitObjectFormat', 'payloadManifestRef', 'payloadManifestDigest',
    'prospectiveCommitId', 'treeId', 'sourceTreeDigest', 'buildId',
    'buildInputsDigest', 'toolLockDigest', 'verifierRef', 'verifierDigest',
    'checks', 'outcome', 'errors',
  ];
  if (!closedObject(report, fields, fields, '', collector, stage)) return;
  if (report.schemaVersion !== '1.0') collector.add('M2_PAYLOAD_VERIFICATION_SCHEMA_VERSION', stage, '/schemaVersion', 'expected 1.0');
  validateAbsoluteIri(report.repositoryId, '/repositoryId', collector, stage);
  validateAuthoritativeRef(report.authoritativeRef, '/authoritativeRef', collector, stage);
  if (!['sha1', 'sha256'].includes(report.gitObjectFormat)) collector.add('M2_RELEASE_GIT_OBJECT_FORMAT', stage, '/gitObjectFormat', 'expected sha1 or sha256');
  for (const field of ['expectedOldCommitId', 'prospectiveCommitId', 'treeId']) {
    validateGitObjectId(report[field], report.gitObjectFormat, `/${field}`, collector, stage);
  }
  validateArtifactRef(report.payloadManifestRef, '/payloadManifestRef', collector, stage);
  validateDigest(report.payloadManifestDigest, '/payloadManifestDigest', collector, stage);
  for (const field of ['sourceTreeDigest', 'buildId', 'buildInputsDigest', 'toolLockDigest', 'verifierDigest']) {
    validateDigest(report[field], `/${field}`, collector, stage);
  }
  validateArtifactRef(report.verifierRef, '/verifierRef', collector, stage);
  validateVerifierChecks(
    report.checks,
    '/checks',
    collector,
    stage,
    releaseCheckStage(checksManifest, 'payloadVerification'),
    report.outcome,
  );
  validateExecutionErrors(report.errors, '/errors', collector, stage, { nonEmpty: report.outcome === 'engineFailure' });
  validateVerificationOutcome(report.outcome, report.checks, report.errors, '/outcome', collector, stage);
}

function validatePayloadVerificationReport(report, checksManifest = null) {
  const collector = new IssueCollector();
  validatePayloadVerificationReportInternal(report, checksManifest, collector);
  return collector.sorted();
}

function validateEvidencePairs(values, at, collector, stage) {
  if (!Array.isArray(values) || values.length === 0) {
    collector.add('M2_ELIGIBILITY_EVIDENCE', stage, at, 'criterion evidence must be a non-empty array');
    return;
  }
  values.forEach((value, index) => {
    const rowAt = `${at}/${index}`;
    if (!closedObject(
      value,
      ['artifactRef', 'artifactDigest'],
      ['artifactRef', 'artifactDigest'],
      rowAt,
      collector,
      stage,
    )) return;
    validateArtifactRef(value.artifactRef, `${rowAt}/artifactRef`, collector, stage);
    validateDigest(value.artifactDigest, `${rowAt}/artifactDigest`, collector, stage);
  });
  ensureSortedUnique(
    values,
    compareArtifactPairs,
    at,
    collector,
    stage,
    'M2_ELIGIBILITY_EVIDENCE_ORDER',
  );
}

function sortedEvidencePairs(values) {
  return [...values].sort(compareArtifactPairs);
}

function expectedEligibilityEvidence(
  criterionRef,
  requiredGatesManifest,
  p1PayloadManifest,
  payloadVerificationReport,
  eligibilityReport,
) {
  const gates = Array.isArray(requiredGatesManifest?.gates)
    ? requiredGatesManifest.gates : [];
  const gateReports = Array.isArray(p1PayloadManifest?.gateReports)
    ? p1PayloadManifest.gateReports : [];
  const gateById = new Map(gates.map((gate) => [gate?.gateId, gate]));
  const reportById = new Map(gateReports.map((row) => [row?.gateId, row]));
  const evidence = [];
  for (const gateId of REQUIRED_GATE_IDS) {
    if (gateById.get(gateId)?.criterionRefs?.includes(criterionRef)) {
      const row = reportById.get(gateId);
      if (row) evidence.push({ artifactRef: row.reportRef, artifactDigest: row.reportDigest });
    }
  }
  if (criterionRef === CRITERION_REFS[5]) {
    evidence.push(
      {
        artifactRef: eligibilityReport?.payloadManifestRef,
        artifactDigest: eligibilityReport?.payloadManifestDigest,
      },
      {
        artifactRef: eligibilityReport?.payloadVerificationReportRef,
        artifactDigest: eligibilityReport?.payloadVerificationReportDigest,
      },
      {
        artifactRef: p1PayloadManifest?.payloadArtifactCatalogRef,
        artifactDigest: p1PayloadManifest?.payloadArtifactCatalogDigest,
      },
      {
        artifactRef: p1PayloadManifest?.payloadArtifactDependencyManifestRef,
        artifactDigest: p1PayloadManifest?.payloadArtifactDependencyManifestDigest,
      },
    );
  }
  return sortedEvidencePairs(evidence);
}

function validateApprovalEligibilityReportInternal(
  report,
  context,
  collector,
  stage = 'approvalEligibilityReport',
) {
  const fields = [
    'schemaVersion', 'profileRef', 'targetVersion', 'build', 'aggregateReportRef',
    'aggregateReportDigest', 'payloadManifestRef', 'payloadManifestDigest',
    'payloadVerificationReportRef', 'payloadVerificationReportDigest',
    'verifierRef', 'verifierDigest', 'checks', 'result',
  ];
  if (!closedObject(report, fields, fields, '', collector, stage)) return;
  if (report.schemaVersion !== '1.0') collector.add('M2_ELIGIBILITY_SCHEMA_VERSION', stage, '/schemaVersion', 'expected 1.0');
  if (report.profileRef !== PROFILE_REF) collector.add('M2_ELIGIBILITY_PROFILE', stage, '/profileRef', `expected ${PROFILE_REF}`);
  if (report.targetVersion !== TARGET_VERSION) collector.add('M2_ELIGIBILITY_TARGET_VERSION', stage, '/targetVersion', `expected ${TARGET_VERSION}`);
  validateBuildEvidenceBinding(report.build, '/build', collector, stage);
  for (const field of [
    'aggregateReportRef', 'payloadManifestRef', 'payloadVerificationReportRef', 'verifierRef',
  ]) {
    validateArtifactRef(report[field], `/${field}`, collector, stage);
  }
  for (const field of [
    'aggregateReportDigest', 'payloadManifestDigest',
    'payloadVerificationReportDigest', 'verifierDigest',
  ]) {
    validateDigest(report[field], `/${field}`, collector, stage);
  }
  const result = report.result;
  const resultFields = ['outcome', 'criteria', 'errors'];
  if (!closedObject(result, resultFields, resultFields, '/result', collector, stage)) return;
  const verificationOutcome = result.outcome === 'eligible' ? 'passed'
    : result.outcome === 'ineligible' ? 'failed' : 'engineFailure';
  validateVerifierChecks(
    report.checks,
    '/checks',
    collector,
    stage,
    releaseCheckStage(context?.checksManifest, 'approvalEligibility'),
    verificationOutcome,
  );
  validateExecutionErrors(
    result.errors,
    '/result/errors',
    collector,
    stage,
    { nonEmpty: result.outcome === 'engineFailure' },
  );
  if (!Array.isArray(result.criteria)) {
    collector.add('M2_ELIGIBILITY_CRITERIA', stage, '/result/criteria', 'criteria must be an array');
    return;
  }
  validateExactStringSet(
    result.criteria.map((row) => row?.criterionRef),
    CRITERION_REFS,
    '/result/criteria',
    collector,
    stage,
    'M2_ELIGIBILITY_CRITERIA',
  );
  for (let index = 0; index < result.criteria.length; index += 1) {
    const row = result.criteria[index];
    const at = `/result/criteria/${index}`;
    const rowFields = ['criterionRef', 'status', 'evidence'];
    if (!closedObject(row, rowFields, rowFields, at, collector, stage)) continue;
    if (!CRITERION_REFS.includes(row.criterionRef)) {
      collector.add('M2_ELIGIBILITY_CRITERIA', stage, `${at}/criterionRef`, 'unknown criterionRef');
    }
    const allowedStatuses = result.outcome === 'engineFailure'
      ? ['satisfied', 'failed', 'notEvaluated'] : ['satisfied', 'failed'];
    if (!allowedStatuses.includes(row.status)) {
      collector.add('M2_ELIGIBILITY_CRITERION_STATUS', stage, `${at}/status`, 'status is illegal for this result branch');
    }
    validateEvidencePairs(row.evidence, `${at}/evidence`, collector, stage);
    if (context?.requiredGatesManifest && context?.p1PayloadManifest
        && context?.payloadVerificationReport) {
      const expected = expectedEligibilityEvidence(
        row.criterionRef,
        context.requiredGatesManifest,
        context.p1PayloadManifest,
        context.payloadVerificationReport,
        report,
      );
      if (!canonicalEqual(row.evidence, expected)) {
        collector.add(
          'M2_ELIGIBILITY_EVIDENCE_CLOSURE',
          stage,
          `${at}/evidence`,
          'criterion evidence differs from the exact required-gate and payload closure',
        );
      }
    }
  }
  const statuses = result.criteria.map((row) => row?.status);
  const passedChecks = Array.isArray(report.checks)
    && report.checks.length > 0
    && report.checks.every((check) => check.status === 'passed');
  const failedChecks = Array.isArray(report.checks)
    && report.checks.some((check) => check.status === 'failed');
  if (result.outcome === 'eligible') {
    if (!statuses.every((status) => status === 'satisfied')
        || !passedChecks || (result.errors || []).length !== 0) {
      collector.add(
        'M2_ELIGIBILITY_ELIGIBLE_MATRIX',
        stage,
        '/result',
        'eligible requires six satisfied criteria, every eligibility check passed, and zero errors',
      );
    }
  } else if (result.outcome === 'ineligible') {
    if (!statuses.includes('failed') || !failedChecks || (result.errors || []).length !== 0) {
      collector.add(
        'M2_ELIGIBILITY_INELIGIBLE_MATRIX',
        stage,
        '/result',
        'ineligible requires all criteria evaluated, at least one failure, a failed check, and zero errors',
      );
    }
  } else if (result.outcome === 'engineFailure') {
    if (!statuses.includes('notEvaluated') || (result.errors || []).length === 0) {
      collector.add(
        'M2_ELIGIBILITY_ENGINE_FAILURE_MATRIX',
        stage,
        '/result',
        'engineFailure requires a notEvaluated criterion and non-empty errors',
      );
    }
  } else {
    collector.add('M2_ELIGIBILITY_OUTCOME', stage, '/result/outcome', 'unknown eligibility outcome');
  }

  const aggregate = context?.p1PayloadManifest?.gateReports?.find(
    (row) => row.gateId === 'aggregate-pre-manifest',
  );
  if (aggregate && (!canonicalEqual(report.aggregateReportRef, aggregate.reportRef)
    || report.aggregateReportDigest !== aggregate.reportDigest)) {
    collector.add(
      'M2_ELIGIBILITY_AGGREGATE_BINDING',
      stage,
      '/aggregateReportRef',
      'aggregate binding differs from the P1 aggregate-pre-manifest report',
    );
  }
  if (context?.p1PayloadManifest && !canonicalEqual(report.build, context.p1PayloadManifest.build)) {
    collector.add('M2_ELIGIBILITY_BUILD_BINDING', stage, '/build', 'eligibility report is not from the P1 build');
  }
}

function validateApprovalEligibilityReport(report, context = {}) {
  const collector = new IssueCollector();
  validateApprovalEligibilityReportInternal(report, context, collector);
  return collector.sorted();
}

function p0ReviewManifestDigest(manifest) {
  return taggedJcsDigest('axiolune-p0-review-manifest-v1\0', manifest);
}

function p0VerificationReportDigest(report) {
  return taggedJcsDigest('axiolune-p0-verification-report-v1\0', report);
}

function p1PayloadManifestDigest(manifest) {
  return taggedJcsDigest('axiolune-p1-payload-manifest-v1\0', manifest);
}

function payloadVerificationReportDigest(report) {
  return taggedJcsDigest('axiolune-payload-verification-report-v1\0', report);
}

function approvalEligibilityReportDigest(report) {
  return taggedJcsDigest('axiolune-approval-eligibility-report-v1\0', report);
}

const CANDIDATE_FILES = Object.freeze({
  requiredGatesManifest: 'required-gates-manifest.json',
  releaseVerificationChecksManifest: 'release-verification-checks-manifest.json',
  p0ReviewManifest: 'evidence/p0-review-manifest.json',
  p0VerificationReport: 'evidence/p0-verification-report.json',
  p1PayloadManifest: 'payload-manifest.json',
  payloadVerificationReport: 'evidence/payload-verification-report.json',
  approvalEligibilityReport: 'evidence/approval-eligibility-report.json',
});

const DETACHED_POST_PAYLOAD_FILES = Object.freeze([
  CANDIDATE_FILES.p1PayloadManifest,
  CANDIDATE_FILES.payloadVerificationReport,
  CANDIDATE_FILES.approvalEligibilityReport,
].sort(compareUtf8));

const MISSING_CODES = Object.freeze({
  requiredGatesManifest: 'M2_REQUIRED_GATES_MANIFEST_MISSING',
  releaseVerificationChecksManifest: 'M2_RELEASE_CHECKS_MANIFEST_MISSING',
  p0ReviewManifest: 'M2_P0_REVIEW_MANIFEST_MISSING',
  p0VerificationReport: 'M2_P0_VERIFICATION_REPORT_MISSING',
  p1PayloadManifest: 'M2_P1_PAYLOAD_MANIFEST_MISSING',
  payloadVerificationReport: 'M2_PAYLOAD_VERIFICATION_REPORT_MISSING',
  approvalEligibilityReport: 'M2_APPROVAL_ELIGIBILITY_REPORT_MISSING',
});

function resolveContainedFile(root, relativePath, collector, stage, issueAt) {
  const candidate = path.resolve(root, ...relativePath.split('/'));
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (!candidate.startsWith(rootPrefix)) {
    collector.add('M2_RELEASE_PATH_ESCAPE', stage, issueAt, `${relativePath} resolves outside the candidate root`);
    return null;
  }
  let rootReal;
  let candidateReal;
  try {
    rootReal = fs.realpathSync(root);
    candidateReal = fs.realpathSync(candidate);
  } catch (cause) {
    collector.add('M2_RELEASE_ARTIFACT_MISSING', stage, issueAt, `${relativePath}: ${cause.code || cause.message}`, 'missing');
    return null;
  }
  if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${path.sep}`)) {
    collector.add('M2_RELEASE_SYMLINK_ESCAPE', stage, issueAt, `${relativePath} escapes through a symlink`);
    return null;
  }
  let cursor = path.resolve(root);
  const segments = relativePath.split('/');
  for (let index = 0; index < segments.length - 1; index += 1) {
    cursor = path.join(cursor, segments[index]);
    const componentStat = fs.lstatSync(cursor);
    if (componentStat.isSymbolicLink()) {
      collector.add(
        'M2_RELEASE_SYMLINK_COMPONENT',
        stage,
        issueAt,
        `${relativePath} has symlink directory component ${segments.slice(0, index + 1).join('/')}`,
      );
      return null;
    }
    if (!componentStat.isDirectory()) {
      collector.add(
        'M2_RELEASE_ARTIFACT_TYPE',
        stage,
        issueAt,
        `${segments.slice(0, index + 1).join('/')} must be a directory`,
      );
      return null;
    }
  }
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    collector.add('M2_RELEASE_ARTIFACT_TYPE', stage, issueAt, `${relativePath} must be a regular non-symlink file`);
    return null;
  }
  return candidate;
}

function verifyManifestEntryBytes(releaseDir, manifest, collector, stage) {
  if (!Array.isArray(manifest?.entries)) return;
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index];
    const at = `/entries/${index}`;
    if (!isPlainObject(entry) || !validatePosixRelativePath(
      entry.path,
      `${at}/path`,
      collector,
      stage,
    )) continue;
    const file = resolveContainedFile(releaseDir, entry.path, collector, stage, `${at}/path`);
    if (!file) continue;
    const bytes = fs.readFileSync(file);
    if (entry.byteLength !== bytes.length) {
      collector.add(
        'M2_RELEASE_PAYLOAD_ENTRY_LENGTH',
        stage,
        `${at}/byteLength`,
        `declared ${String(entry.byteLength)}, recomputed ${bytes.length}`,
      );
    }
    const digest = sha256(bytes);
    if (entry.payloadByteDigest !== digest) {
      collector.add(
        'M2_RELEASE_PAYLOAD_ENTRY_DIGEST',
        stage,
        `${at}/payloadByteDigest`,
        `declared ${String(entry.payloadByteDigest)}, recomputed ${digest}`,
      );
    }
  }
}

function discoverCandidateRegularFiles(releaseDir, collector) {
  const files = [];
  function visit(absoluteDirectory, relativeDirectory) {
    const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(absoluteDirectory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        collector.add(
          'M2_RELEASE_PAYLOAD_SYMLINK',
          'payloadEntryReplay',
          relative,
          'release candidate payload may contain only regular files and directories',
        );
        continue;
      }
      if (stat.isDirectory()) {
        visit(absolute, relative);
      } else if (stat.isFile()) {
        files.push(relative);
      } else {
        collector.add(
          'M2_RELEASE_PAYLOAD_ARTIFACT_TYPE',
          'payloadEntryReplay',
          relative,
          'release candidate payload contains a non-regular artifact',
        );
      }
    }
  }
  visit(releaseDir, '');
  return files.sort(compareUtf8);
}

function verifyP1RawEntryInventory(releaseDir, manifest, collector) {
  if (!Array.isArray(manifest?.entries)) return;
  const declared = manifest.entries
    .map((entry) => entry?.path)
    .filter((value) => typeof value === 'string')
    .sort(compareUtf8);
  const excluded = new Set(DETACHED_POST_PAYLOAD_FILES);
  const discovered = discoverCandidateRegularFiles(releaseDir, collector)
    .filter((relativePath) => !excluded.has(relativePath));
  if (!canonicalEqual(declared, discovered)) {
    const declaredSet = new Set(declared);
    const discoveredSet = new Set(discovered);
    const missing = discovered.filter((relativePath) => !declaredSet.has(relativePath));
    const extra = declared.filter((relativePath) => !discoveredSet.has(relativePath));
    collector.add(
      'M2_RELEASE_PAYLOAD_ENTRY_INVENTORY',
      'payloadEntryReplay',
      '/entries',
      `raw candidate inventory differs: missing=${missing.join(',') || 'none'}; extra=${extra.join(',') || 'none'}`,
    );
  }
}

function readStrictJcsFile(root, relativePath, collector, stage, missingCode) {
  const absolute = path.resolve(root, ...relativePath.split('/'));
  if (!fs.existsSync(absolute)) {
    collector.add(missingCode, stage, relativePath, `missing required candidate artifact ${relativePath}`, 'missing');
    return null;
  }
  const contained = resolveContainedFile(root, relativePath, collector, stage, relativePath);
  if (!contained) return null;
  const bytes = fs.readFileSync(contained);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    collector.add('M2_RELEASE_JSON_PARSE', stage, relativePath, `invalid JSON: ${cause.message}`);
    return null;
  }
  let canonical;
  try {
    canonical = Buffer.from(canonicalJcs(value), 'utf8');
  } catch (cause) {
    collector.add('M2_RELEASE_JCS_PROFILE', stage, relativePath, `outside the JCS profile: ${cause.message}`);
    return null;
  }
  if (!bytes.equals(canonical)) {
    collector.add(
      'M2_RELEASE_NON_CANONICAL_JCS',
      stage,
      relativePath,
      'candidate artifact bytes are not exact UTF-8 RFC 8785 JCS',
    );
  }
  return { value, bytes, relativePath, rawDigest: sha256(bytes) };
}

function compareBinding(actual, expected, collector, stage, at, code, message) {
  if (!canonicalEqual(actual, expected)) collector.add(code, stage, at, message);
}

function payloadPathRef(relativePath) {
  return { kind: 'path', root: 'payload', path: relativePath };
}

function resolvePayloadReport(releaseDir, reference, collector, stage, at) {
  if (!isPlainObject(reference) || reference.kind !== 'path' || reference.root !== 'payload') {
    collector.add(
      'M2_RELEASE_PAYLOAD_CATALOG_RESOLUTION_REQUIRED',
      stage,
      at,
      'non-payload report ref requires independent payload-catalog resolution',
      'unverified',
    );
    return null;
  }
  return readStrictJcsFile(
    releaseDir,
    reference.path,
    collector,
    stage,
    'M2_GATE_VALIDATION_REPORT_MISSING',
  );
}

function readTrustedCanonicalJson(file, collector, stage) {
  if (!file) {
    collector.add(
      'M2_RELEASE_DECISION_TRUST_POLICY_REQUIRED',
      stage,
      '',
      'the DRI public-key trust policy must be supplied independently of candidate bytes',
      'unverified',
    );
    return null;
  }
  const absolute = path.resolve(file);
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      collector.add(
        'M2_RELEASE_DECISION_TRUST_POLICY_TYPE',
        stage,
        absolute,
        'trusted policy must be a non-symlink regular file',
      );
      return null;
    }
    const bytes = fs.readFileSync(absolute);
    const value = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
      collector.add(
        'M2_RELEASE_DECISION_TRUST_POLICY_JCS',
        stage,
        absolute,
        'trusted policy bytes are not exact UTF-8 RFC 8785 JCS',
      );
      return null;
    }
    return { value, bytes, path: absolute };
  } catch (cause) {
    collector.add(
      'M2_RELEASE_DECISION_TRUST_POLICY_READ',
      stage,
      absolute,
      cause && cause.message ? cause.message : String(cause),
      cause?.code === 'ENOENT' ? 'missing' : 'invalid',
    );
    return null;
  }
}

function verifyPromotionAuthorizationReplay(
  releaseDir,
  p0,
  p0Verification,
  p1,
  decisionTrustPolicyPath,
  collector,
) {
  if (!p0 || !p0Verification || !p1) return;
  const policy = readTrustedCanonicalJson(
    decisionTrustPolicyPath,
    collector,
    'p0SignatureReplay',
  );
  if (!policy) return;
  const authorization = resolvePayloadReport(
    releaseDir,
    p1.promotionAuthorizationRef,
    collector,
    'p0SignatureReplay',
    '/promotionAuthorizationRef',
  );
  if (!authorization) return;
  if (artifactDigest(authorization.value) !== p1.promotionAuthorizationDigest) {
    collector.add(
      'M2_RELEASE_PROMOTION_AUTHORIZATION_DIGEST',
      'p0SignatureReplay',
      '/promotionAuthorizationDigest',
      'PromotionAuthorization bytes differ from the P1-bound digest',
    );
  }
  try {
    verifyPromotionAuthorization(authorization.value, policy.value, {
      repositoryId: p0.repositoryId,
      authoritativeRef: p0.authoritativeRef,
      expectedOldCommitId: p0.expectedOldCommitId,
      gitObjectFormat: p0.gitObjectFormat,
      targetVersion: p0.targetVersion,
      p0ManifestRef: p1.p0ManifestRef,
      p0ManifestDigest: p1.p0ManifestDigest,
      p0VerificationReportRef: p1.p0VerificationReportRef,
      p0VerificationReportDigest: p1.p0VerificationReportDigest,
    });
  } catch (cause) {
    collector.add(
      'M2_RELEASE_PROMOTION_AUTHORIZATION_SIGNATURE',
      'p0SignatureReplay',
      p1.promotionAuthorizationRef?.path || '/promotionAuthorizationRef',
      cause && cause.message ? cause.message : String(cause),
    );
  }
}

function verifyGateReportSet(releaseDir, manifest, requiredManifest, collector, stage) {
  if (!manifest || !requiredManifest) return;
  if (!Array.isArray(requiredManifest.gates) || !Array.isArray(manifest.gateReports)) {
    // The closed-schema validators already record the precise shape errors.  Do
    // not let malformed caller-authored JSON turn the independent verifier into
    // an uncaught exception before it can emit those diagnostics.
    return;
  }
  const gateById = new Map(requiredManifest.gates.map((gate) => [gate.gateId, gate]));
  for (const row of manifest.gateReports) {
    const artifact = resolvePayloadReport(
      releaseDir,
      row.reportRef,
      collector,
      stage,
      `/gateReports/${row.gateId}/reportRef`,
    );
    if (!artifact) continue;
    const actualDigest = artifactDigest(artifact.value);
    if (actualDigest !== row.reportDigest) {
      collector.add(
        'M2_GATE_VALIDATION_REPORT_DIGEST',
        stage,
        artifact.relativePath,
        `declared ${row.reportDigest}, recomputed ${actualDigest}`,
      );
    }
    validateValidationReportInternal(
      artifact.value,
      gateById.get(row.gateId) || null,
      collector,
      `${stage}:${row.gateId}`,
    );
    if (!canonicalEqual(artifact.value.build, manifest.build)) {
      collector.add(
        'M2_GATE_VALIDATION_REPORT_BUILD',
        stage,
        artifact.relativePath,
        `${row.gateId} does not bind the enclosing manifest build`,
      );
    }
    if (artifact.value.result?.outcome !== 'passed') {
      collector.add(
        'M2_GATE_VALIDATION_REPORT_NOT_PASSED',
        stage,
        artifact.relativePath,
        `${row.gateId} is not passed release evidence`,
      );
    }
  }
}

function crossValidateCandidate(documents, releaseDir, collector) {
  const required = documents.requiredGatesManifest?.value;
  const checks = documents.releaseVerificationChecksManifest?.value;
  const p0 = documents.p0ReviewManifest?.value;
  const p0Verification = documents.p0VerificationReport?.value;
  const p1 = documents.p1PayloadManifest?.value;
  const payloadVerification = documents.payloadVerificationReport?.value;
  const eligibility = documents.approvalEligibilityReport?.value;

  if (required) validateRequiredGatesManifestInternal(required, collector);
  if (checks) validateReleaseVerificationChecksManifestInternal(checks, collector);
  if (p0) validateP0ReviewManifestInternal(p0, collector);
  if (p0Verification) validateP0VerificationReportInternal(p0Verification, checks, collector);
  if (p1) validateP1PayloadManifestInternal(p1, collector);
  if (payloadVerification) {
    validatePayloadVerificationReportInternal(payloadVerification, checks, collector);
  }
  if (eligibility) {
    validateApprovalEligibilityReportInternal(
      eligibility,
      {
        checksManifest: checks,
        requiredGatesManifest: required,
        p1PayloadManifest: p1,
        payloadVerificationReport: payloadVerification,
      },
      collector,
    );
  }

  if (p0) verifyManifestEntryBytes(releaseDir, p0, collector, 'p0EntryReplay');
  if (p1) {
    verifyManifestEntryBytes(releaseDir, p1, collector, 'p1EntryReplay');
    verifyP1RawEntryInventory(releaseDir, p1, collector);
  }

  if (required) {
    const digest = requiredGatesManifestDigest(required);
    for (const [record, at, label] of [
      [p0, '/requiredGatesManifestDigest', 'P0'],
      [p1, '/requiredGatesManifestDigest', 'P1'],
    ]) {
      if (record && record.requiredGatesManifestDigest !== digest) {
        collector.add('M2_REQUIRED_GATES_DIGEST_BINDING', 'candidateClosure', at, `${label} does not bind recomputed required-gates digest`);
      }
    }
  }
  if (checks) {
    const digest = releaseVerificationChecksManifestDigest(checks);
    for (const [record, at, label] of [
      [p0, '/releaseVerificationChecksManifestDigest', 'P0'],
      [p1, '/releaseVerificationChecksManifestDigest', 'P1'],
    ]) {
      if (record && record.releaseVerificationChecksManifestDigest !== digest) {
        collector.add('M2_RELEASE_CHECKS_DIGEST_BINDING', 'candidateClosure', at, `${label} does not bind recomputed release-checks digest`);
      }
    }
  }
  if (p0 && p0Verification) {
    const digest = p0ReviewManifestDigest(p0);
    if (p0Verification.p0ManifestDigest !== digest) {
      collector.add('M2_P0_MANIFEST_DIGEST_BINDING', 'candidateClosure', '/p0ManifestDigest', 'P0 verification does not bind recomputed P0 manifest');
    }
    for (const field of ['repositoryId', 'authoritativeRef', 'expectedOldCommitId', 'gitObjectFormat', 'reviewCommitId', 'reviewTreeId']) {
      if (!canonicalEqual(p0[field], p0Verification[field])) {
        collector.add('M2_P0_IDENTITY_BINDING', 'candidateClosure', `/${field}`, `${field} differs between P0 manifest and verification`);
      }
    }
    if (p0Verification.buildId !== p0.build?.buildId
        || p0Verification.sourceTreeDigest !== p0.build?.sourceTreeDigest
        || p0Verification.buildInputsDigest !== p0.build?.buildInputsDigest
        || p0Verification.toolLockDigest !== p0.build?.toolLockDigest) {
      collector.add('M2_P0_BUILD_BINDING', 'candidateClosure', '/build', 'P0 verification scalars differ from BuildEvidenceBinding');
    }
    compareBinding(
      p0Verification.p0ManifestRef,
      payloadPathRef(CANDIDATE_FILES.p0ReviewManifest),
      collector,
      'candidateClosure',
      '/p0ManifestRef',
      'M2_P0_MANIFEST_REF_BINDING',
      'P0 verification does not reference the reviewed P0 manifest bytes',
    );
    if (p0Verification.outcome !== 'passed') {
      collector.add('M2_P0_VERIFICATION_NOT_PASSED', 'candidateClosure', '/outcome', 'P0 verification is not passed');
    }
  }
  if (p0 && p0Verification && p1) {
    if (p1.p0ManifestDigest !== p0ReviewManifestDigest(p0)) {
      collector.add('M2_P1_P0_MANIFEST_BINDING', 'candidateClosure', '/p0ManifestDigest', 'P1 does not bind recomputed P0 manifest');
    }
    if (p1.p0VerificationReportDigest !== p0VerificationReportDigest(p0Verification)) {
      collector.add('M2_P1_P0_VERIFICATION_BINDING', 'candidateClosure', '/p0VerificationReportDigest', 'P1 does not bind recomputed P0 verification report');
    }
    for (const field of ['repositoryId', 'authoritativeRef', 'expectedOldCommitId', 'gitObjectFormat']) {
      if (!canonicalEqual(p0[field], p1[field])) {
        collector.add('M2_P0_P1_IDENTITY_BINDING', 'candidateClosure', `/${field}`, `${field} differs between P0 and P1`);
      }
    }
    for (const field of ['requiredGatesManifestRef', 'releaseVerificationChecksManifestRef']) {
      if (!canonicalEqual(p0[field], p1[field])) {
        collector.add('M2_P0_P1_STATIC_REF_BINDING', 'candidateClosure', `/${field}`, `${field} differs between P0 and P1`);
      }
    }
    compareBinding(
      p1.p0ManifestRef,
      p0Verification.p0ManifestRef,
      collector,
      'candidateClosure',
      '/p0ManifestRef',
      'M2_P1_P0_MANIFEST_REF_BINDING',
      'P1 and P0 verification reference different P0 manifest artifacts',
    );
    compareBinding(
      p1.p0VerificationReportRef,
      payloadPathRef(CANDIDATE_FILES.p0VerificationReport),
      collector,
      'candidateClosure',
      '/p0VerificationReportRef',
      'M2_P1_P0_VERIFICATION_REF_BINDING',
      'P1 does not reference the verified P0 verification-report bytes',
    );
  }
  if (p1 && payloadVerification) {
    if (payloadVerification.payloadManifestDigest !== p1PayloadManifestDigest(p1)) {
      collector.add('M2_PAYLOAD_MANIFEST_DIGEST_BINDING', 'candidateClosure', '/payloadManifestDigest', 'payload verification does not bind recomputed P1 payload manifest');
    }
    for (const field of ['repositoryId', 'authoritativeRef', 'expectedOldCommitId', 'gitObjectFormat', 'prospectiveCommitId', 'treeId']) {
      if (!canonicalEqual(p1[field], payloadVerification[field])) {
        collector.add('M2_P1_PAYLOAD_IDENTITY_BINDING', 'candidateClosure', `/${field}`, `${field} differs between P1 manifest and payload verification`);
      }
    }
    if (payloadVerification.buildId !== p1.build?.buildId
        || payloadVerification.sourceTreeDigest !== p1.build?.sourceTreeDigest
        || payloadVerification.buildInputsDigest !== p1.build?.buildInputsDigest
        || payloadVerification.toolLockDigest !== p1.build?.toolLockDigest) {
      collector.add('M2_P1_BUILD_BINDING', 'candidateClosure', '/build', 'payload verification scalars differ from P1 BuildEvidenceBinding');
    }
    if (payloadVerification.outcome !== 'passed') {
      collector.add('M2_PAYLOAD_VERIFICATION_NOT_PASSED', 'candidateClosure', '/outcome', 'payload verification is not passed');
    }
    compareBinding(
      payloadVerification.payloadManifestRef,
      payloadPathRef(CANDIDATE_FILES.p1PayloadManifest),
      collector,
      'candidateClosure',
      '/payloadManifestRef',
      'M2_PAYLOAD_MANIFEST_REF_BINDING',
      'payload verification does not reference the reviewed payload manifest bytes',
    );
  }
  if (p1 && payloadVerification && eligibility) {
    if (eligibility.payloadManifestDigest !== p1PayloadManifestDigest(p1)) {
      collector.add('M2_ELIGIBILITY_PAYLOAD_BINDING', 'candidateClosure', '/payloadManifestDigest', 'eligibility does not bind recomputed P1 payload manifest');
    }
    if (eligibility.payloadVerificationReportDigest
        !== payloadVerificationReportDigest(payloadVerification)) {
      collector.add('M2_ELIGIBILITY_VERIFICATION_BINDING', 'candidateClosure', '/payloadVerificationReportDigest', 'eligibility does not bind recomputed payload verification report');
    }
    if (eligibility.result?.outcome !== 'eligible') {
      collector.add('M2_APPROVAL_ELIGIBILITY_NOT_ELIGIBLE', 'candidateClosure', '/result/outcome', 'post-payload eligibility is not eligible', 'missing');
    }
    compareBinding(
      eligibility.payloadManifestRef,
      payloadVerification.payloadManifestRef,
      collector,
      'candidateClosure',
      '/payloadManifestRef',
      'M2_ELIGIBILITY_PAYLOAD_REF_BINDING',
      'eligibility and payload verification reference different payload manifests',
    );
    compareBinding(
      eligibility.payloadVerificationReportRef,
      payloadPathRef(CANDIDATE_FILES.payloadVerificationReport),
      collector,
      'candidateClosure',
      '/payloadVerificationReportRef',
      'M2_ELIGIBILITY_VERIFICATION_REF_BINDING',
      'eligibility does not reference the reviewed payload-verification bytes',
    );
  }

  if (p0 && required) verifyGateReportSet(releaseDir, p0, required, collector, 'p0GateReports');
  if (p1 && required) verifyGateReportSet(releaseDir, p1, required, collector, 'p1GateReports');
}

function verifyTrustedReleaseScope(options, documents, collector) {
  const expected = {
    repositoryId: typeof options.expectedRepositoryId === 'string'
      ? options.expectedRepositoryId : null,
    authoritativeRef: typeof options.expectedAuthoritativeRef === 'string'
      ? options.expectedAuthoritativeRef : null,
    expectedOldCommitId: typeof options.expectedOldCommitId === 'string'
      ? options.expectedOldCommitId : null,
  };
  const completeCandidate = Object.keys(documents).length === Object.keys(CANDIDATE_FILES).length;
  const missing = Object.entries(expected)
    .filter(([, value]) => value === null)
    .map(([field]) => field);
  if (completeCandidate && missing.length > 0) {
    collector.add(
      'M2_RELEASE_TRUSTED_SCOPE_REQUIRED',
      'trustedScope',
      '',
      `independent out-of-band release scope is missing ${missing.join(', ')}`,
      'unverified',
    );
  }

  let valid = missing.length === 0;
  if (expected.repositoryId !== null) {
    valid = validateAbsoluteIri(
      expected.repositoryId,
      '/repositoryId',
      collector,
      'trustedScope',
    ) && valid;
  }
  if (expected.authoritativeRef !== null) {
    valid = validateAuthoritativeRef(
      expected.authoritativeRef,
      '/authoritativeRef',
      collector,
      'trustedScope',
    ) && valid;
  }
  const objectFormat = documents.p0ReviewManifest?.value?.gitObjectFormat;
  if (expected.expectedOldCommitId !== null) {
    if (!['sha1', 'sha256'].includes(objectFormat)) {
      collector.add(
        'M2_RELEASE_TRUSTED_SCOPE_GIT_FORMAT',
        'trustedScope',
        '/expectedOldCommitId',
        'candidate Git object format is unavailable or invalid',
      );
      valid = false;
    } else {
      valid = validateGitObjectId(
        expected.expectedOldCommitId,
        objectFormat,
        '/expectedOldCommitId',
        collector,
        'trustedScope',
      ) && valid;
    }
  }

  let matched = valid && completeCandidate;
  if (valid && completeCandidate) {
    for (const [key, label] of [
      ['p0ReviewManifest', 'P0 review manifest'],
      ['p1PayloadManifest', 'P1 payload manifest'],
      ['payloadVerificationReport', 'payload verification report'],
    ]) {
      const value = documents[key]?.value;
      for (const field of ['repositoryId', 'authoritativeRef', 'expectedOldCommitId']) {
        if (value?.[field] !== expected[field]) {
          matched = false;
          collector.add(
            'M2_RELEASE_TRUSTED_SCOPE_MISMATCH',
            'trustedScope',
            `/${key}/${field}`,
            `${label} ${field} does not equal the protected out-of-band value`,
          );
        }
      }
    }
  }
  return {
    repositoryId: expected.repositoryId,
    authoritativeRef: expected.authoritativeRef,
    expectedOldCommitId: expected.expectedOldCommitId,
    provided: missing.length === 0,
    matched,
  };
}

function verifiedCriterionResults(documents, eligible) {
  const rows = documents.approvalEligibilityReport?.value?.result?.criteria;
  const byRef = new Map(Array.isArray(rows)
    ? rows.map((row) => [row?.criterionRef, row])
    : []);
  return CRITERION_REFS.map((criterionRef) => {
    const row = byRef.get(criterionRef);
    return {
      criterionRef,
      status: eligible && row?.status === 'satisfied' ? 'satisfied' : 'notEstablished',
      evidence: eligible && Array.isArray(row?.evidence) ? structuredClone(row.evidence) : [],
    };
  });
}

function verifyGateSemanticReplayCoverage(requiredManifest, replayOutcome, collector) {
  if (!Array.isArray(requiredManifest?.gates)) return;
  const rows = Array.isArray(replayOutcome?.gateOutcomes)
    ? replayOutcome.gateOutcomes : [];
  const byId = new Map(rows.map((row) => [row?.gateId, row]));
  const isReleaseGateEvidence = (replay) => (
    isPlainObject(replay)
      && replay.outcome === 'passed'
      && replay.releaseGateEvidenceEstablished === true
      && replay.declaredEntrypointExecuted === true
      && replay.declaredDiscoveryReplayed === true
      && replay.declaredEvidenceSchemaValidated === true
      && replay.kindEvidenceByteEquivalent === true
      && replay.dependencyReportsRecomputed === true
      && replay.fiveVectorCategoriesPassed === true
      && replay.callerEvidenceAccepted === false
  );
  for (const gate of requiredManifest.gates) {
    if (isReleaseGateEvidence(byId.get(gate.gateId))) continue;
    collector.add(
      'M2_GATE_SEMANTIC_REPLAY_REQUIRED',
      'gateSemanticReplay',
      `/gates/${gate.gateId}`,
      `${gate.gateId} has no independent candidate-specific subject discovery, `
        + 'locked entrypoint invocation, five-polarity vector execution, dependency-report '
        + 'recomputation, schema validation, and kindEvidence byte-equivalence replay; broad '
        + 'component prerequisites and generic interface vectors are explicitly non-evidentiary',
      'unverified',
    );
  }
}

function verifyM2Release(options = {}) {
  const collector = new IssueCollector();
  const releaseDir = path.resolve(options.releaseDir || '');
  const documents = {};
  const checkedArtifacts = [];
  const governance = auditM2GovernanceBaseline(SOURCE_ROOT);
  for (const issue of governance.issues) {
    collector.add(
      issue.code,
      'governancePrerequisites',
      issue.path,
      issue.message,
      issue.code.endsWith('_MISSING') ? 'missing' : 'invalid',
    );
  }
  if (!options.releaseDir || !fs.existsSync(releaseDir)) {
    collector.add(
      'M2_RELEASE_DIRECTORY_MISSING',
      'candidateInventory',
      options.releaseDir || '',
      'v0.3 release candidate directory does not exist',
      'missing',
    );
    for (const [key, relativePath] of Object.entries(CANDIDATE_FILES)) {
      collector.add(
        MISSING_CODES[key],
        'candidateInventory',
        relativePath,
        `missing required candidate artifact ${relativePath}`,
        'missing',
      );
    }
  } else {
    const stat = fs.lstatSync(releaseDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      collector.add('M2_RELEASE_DIRECTORY_TYPE', 'candidateInventory', releaseDir, 'candidate root must be a non-symlink directory');
    } else {
      for (const [key, relativePath] of Object.entries(CANDIDATE_FILES)) {
        const artifact = readStrictJcsFile(
          releaseDir,
          relativePath,
          collector,
          key,
          MISSING_CODES[key],
        );
        if (artifact) {
          documents[key] = artifact;
          checkedArtifacts.push({ path: relativePath, byteLength: artifact.bytes.length, artifactDigest: artifact.rawDigest });
        }
      }
      crossValidateCandidate(documents, releaseDir, collector);
    }
  }

  const trustedScope = verifyTrustedReleaseScope(options, documents, collector);

  verifyPromotionAuthorizationReplay(
    releaseDir,
    documents.p0ReviewManifest?.value,
    documents.p0VerificationReport?.value,
    documents.p1PayloadManifest?.value,
    options.decisionTrustPolicyPath,
    collector,
  );

  let gitReplay = null;
  if (documents.p0ReviewManifest && documents.p1PayloadManifest) {
    gitReplay = verifyReleaseGitObjects({
      repositoryRoot: SOURCE_ROOT,
      p0: documents.p0ReviewManifest.value,
      p1: documents.p1PayloadManifest.value,
    });
    for (const issue of gitReplay.issues) {
      collector.add(issue.code, issue.stage, issue.path, issue.message, issue.kind);
    }
    if (gitReplay.p1
        && documents.p1PayloadManifest.value.sourceTreeManifestDigest
          !== gitReplay.p1.sourceTreeManifestDigest) {
      collector.add(
        'M2_RELEASE_P1_SOURCE_TREE_MANIFEST_DIGEST',
        'gitObjectReplay',
        '/sourceTreeManifestDigest',
        'P1 source-tree manifest digest differs from the independently reconstructed Git tree',
      );
    }
  }

  if (documents.requiredGatesManifest && documents.releaseVerificationChecksManifest
      && documents.p0ReviewManifest && documents.p1PayloadManifest) {
    const toolchainReplay = verifyToolchainReplay({
      gitReplay,
      requiredGates: documents.requiredGatesManifest.value,
      releaseChecks: documents.releaseVerificationChecksManifest.value,
      p0: documents.p0ReviewManifest.value,
      p1: documents.p1PayloadManifest.value,
    });
    for (const issue of toolchainReplay.issues) {
      collector.add(
        issue.code,
        'toolchainReplay',
        issue.path,
        issue.message,
        issue.kind || 'invalid',
      );
    }
  }

  let artifactBytes = null;
  if (documents.p1PayloadManifest && fs.existsSync(releaseDir)) {
    artifactBytes = new Map();
    for (const relativePath of discoverCandidateRegularFiles(releaseDir, collector)) {
      const contained = resolveContainedFile(
        releaseDir,
        relativePath,
        collector,
        'payloadClosureReplay',
        relativePath,
      );
      if (contained) artifactBytes.set(relativePath, fs.readFileSync(contained));
    }
  }
  const p1SourceArtifacts = gitReplay?.p1?.files
    ? new Map(gitReplay.p1.files.map((file) => [file.path, file.content]))
    : null;

  let reasonerReplayProof = null;
  if (documents.p1PayloadManifest && documents.requiredGatesManifest && artifactBytes) {
    const reasonerReplay = verifyReasonerReplay({
      gitReplay,
      p1: documents.p1PayloadManifest.value,
      requiredGates: documents.requiredGatesManifest.value,
      artifacts: artifactBytes,
      trustedRoot: SOURCE_ROOT,
    });
    for (const issue of reasonerReplay.issues) {
      collector.add(
        issue.code,
        'reasonerReplay',
        issue.path,
        issue.message,
        issue.kind || 'invalid',
      );
    }
    reasonerReplayProof = reasonerReplay;
  }

  let buildDependencyReplayProof = null;
  if (documents.p1PayloadManifest && documents.requiredGatesManifest
      && artifactBytes && gitReplay?.p1?.files) {
    const buildDependencyReplay = verifyBuildDependencyReplay({
      p1: documents.p1PayloadManifest.value,
      requiredGates: documents.requiredGatesManifest.value,
      artifacts: artifactBytes,
      sourceArtifacts: p1SourceArtifacts,
      trustedRoot: SOURCE_ROOT,
    });
    for (const issue of buildDependencyReplay.issues) {
      collector.add(
        issue.code,
        'buildDependencyReplay',
        issue.path,
        issue.message,
        issue.kind || 'invalid',
      );
    }
    buildDependencyReplayProof = buildDependencyReplay;
  }

  if (documents.p0ReviewManifest && documents.p1PayloadManifest
      && documents.requiredGatesManifest && artifactBytes && p1SourceArtifacts) {
    for (const [scope, manifest] of [
      ['p0', documents.p0ReviewManifest.value],
      ['p1', documents.p1PayloadManifest.value],
    ]) {
      const bindingReplay = verifyGateArtifactBindingReplay({
        p1: documents.p1PayloadManifest.value,
        manifest,
        requiredGates: documents.requiredGatesManifest.value,
        artifacts: artifactBytes,
        sourceArtifacts: p1SourceArtifacts,
        scope,
      });
      for (const issue of bindingReplay.issues) {
        collector.add(
          issue.code,
          `${scope}GateArtifactBindingReplay`,
          issue.path,
          issue.message,
          issue.kind || 'invalid',
        );
      }
    }
  } else {
    collector.add(
      'M2_GATE_ARTIFACT_BINDING_REPLAY_REQUIRED',
      'gateArtifactBindingReplay',
      '',
      'exact P0/P1 ValidationReport, subject-inventory, GateCheck, and kindEvidence byte binding requires the reconstructed P1 source tree and complete payload catalog',
      'unverified',
    );
  }

  let requiredGateSemanticReplayProof = null;
  if (documents.p1PayloadManifest && documents.requiredGatesManifest
      && artifactBytes && p1SourceArtifacts) {
    requiredGateSemanticReplayProof = verifyRequiredGateSemanticReplay({
      p1: documents.p1PayloadManifest.value,
      requiredGates: documents.requiredGatesManifest.value,
      artifacts: artifactBytes,
      sourceArtifacts: p1SourceArtifacts,
      trustedRoot: SOURCE_ROOT,
    });
    for (const issue of requiredGateSemanticReplayProof.issues) {
      collector.add(
        issue.code,
        'requiredGateSemanticReplay',
        issue.path,
        issue.message,
        issue.kind || 'invalid',
      );
    }
  } else {
    collector.add(
      'M2_GATE_SEMANTIC_REPLAY_INPUT_REQUIRED',
      'requiredGateSemanticReplay',
      '',
      'independent required-gate replay requires reconstructed P1 source bytes, payload bytes, and the locked required-gate manifest',
      'unverified',
    );
  }

  if (gitReplay?.outcome === 'passed' && gitReplay.p1
      && documents.requiredGatesManifest && documents.p1PayloadManifest) {
    try {
      const componentReplay = replayP1ComponentGate({ gitReplay });
      for (const issue of componentReplay.issues) {
        collector.add(
          issue.code,
          'p1ComponentReplay',
          issue.path,
          issue.message,
          issue.kind || 'invalid',
        );
      }
      if (componentReplay.outcome !== 'passed'
          || componentReplay.componentCount !== EXPECTED_COMPONENT_IDS.length
          || componentReplay.gateCoverage.length !== REQUIRED_GATE_IDS.length
          || !componentReplay.gateCoverage.every((row) => (
            row.prerequisiteOutcome === 'passed'
              && row.evidenceUse === 'component-prerequisites-only'
              && row.releaseEligibilityEvidence === false
          ))
          || componentReplay.isolatedTemporaryCopy !== true
          || componentReplay.callerEvidenceAccepted !== false) {
        collector.add(
          'M2_COMPONENT_P1_REPLAY_CLOSURE',
          'p1ComponentReplay',
          '',
          'independent reconstructed-P1 component-prerequisite replay did not close exact '
            + `${EXPECTED_COMPONENT_IDS.length}-component/`
            + `${REQUIRED_GATE_IDS.length}-gate prerequisite coverage`,
        );
      }
    } catch (cause) {
      collector.add(
        'M2_COMPONENT_P1_REPLAY_FAILED',
        'p1ComponentReplay',
        '',
        cause && cause.message ? cause.message : String(cause),
      );
    }
  } else {
    collector.add(
      'M2_COMPONENT_P1_REPLAY_REQUIRED',
      'p1ComponentReplay',
      '',
      'independent full component replay requires a successfully reconstructed P1 Git tree and release manifests',
      'unverified',
    );
  }

  if (documents.p1PayloadManifest && artifactBytes) {
    const payloadClosure = verifyPayloadClosure({
      p1: documents.p1PayloadManifest.value,
      artifacts: artifactBytes,
      sourceArtifacts: p1SourceArtifacts,
      trustedRoot: SOURCE_ROOT,
    });
    for (const issue of payloadClosure.issues) {
      collector.add(
        issue.code,
        'payloadClosureReplay',
        issue.path,
        issue.message,
        issue.kind || 'invalid',
      );
    }
  }

  if (documents.requiredGatesManifest) {
    verifyGateSemanticReplayCoverage(
      documents.requiredGatesManifest.value,
      requiredGateSemanticReplayProof,
      collector,
    );
  }

  const issues = collector.sorted();
  const invalid = issues.some((issue) => issue.kind === 'invalid');
  const outcome = invalid ? 'invalid' : issues.length > 0 ? 'incomplete' : 'eligible';
  const eligible = issues.length === 0;
  return {
    schemaVersion: '1.0',
    verifierId: VERIFIER_ID,
    profileRef: PROFILE_REF,
    targetVersion: TARGET_VERSION,
    verificationScope: 'post-payload-approval-eligibility',
    governanceOutcome: governance.outcome,
    trustedScope,
    outcome,
    eligible,
    criterionResults: verifiedCriterionResults(documents, eligible),
    approvalStatus: 'not-approved',
    adoptionStatus: 'not-verified',
    releaseComplete: false,
    releaseDirectory: releaseDir,
    checkedArtifacts: checkedArtifacts.sort((left, right) => compareUtf8(left.path, right.path)),
    issueCounts: {
      invalid: issues.filter((issue) => issue.kind === 'invalid').length,
      missing: issues.filter((issue) => issue.kind === 'missing').length,
      unverified: issues.filter((issue) => issue.kind === 'unverified').length,
    },
    issues,
  };
}

module.exports = {
  CANDIDATE_FILES,
  CRITERION_REFS,
  GATES_BY_CRITERION,
  PROFILE_REF,
  RELEASE_CHECK_IDS,
  REPORT_KIND_BY_GATE,
  REPORT_KINDS,
  REQUIRED_GATE_IDS,
  REQUIRED_ROOT_KINDS,
  TARGET_VERSION,
  VERIFIER_ID,
  approvalEligibilityReportDigest,
  artifactDigest,
  expectedCriterionRefsForGate,
  expectedEligibilityEvidence,
  p0ReviewManifestDigest,
  p0VerificationReportDigest,
  p1PayloadManifestDigest,
  payloadVerificationReportDigest,
  releaseVerificationChecksManifestDigest,
  requiredGatesManifestDigest,
  sha256,
  taggedJcsDigest,
  validateApprovalEligibilityReport,
  validateP0ReviewManifest,
  validateP0VerificationReport,
  validateP1PayloadManifest,
  validatePayloadVerificationReport,
  validateReleaseVerificationChecksManifest,
  validateRequiredGatesManifest,
  validateValidationReport,
  verifyGateSemanticReplayCoverage,
  verifyM2Release,
};
