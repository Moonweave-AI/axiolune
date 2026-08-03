'use strict';

const crypto = require('node:crypto');

const {
  canonicalJcs,
} = require('./strict-source-locator.cjs');
const {
  decodeCanonicalOrdersPortfolioScenario,
  encodeCanonicalOrdersPortfolioScenario,
} = require('./orders-portfolio-canonical-record-adapter.cjs');
const {
  PORTFOLIO_GRAPH_IRI,
} = require('./s5-canonical-materialization.cjs');
const {
  isVerifiedMaterializationContext,
  verifiedMaterializationContextSourceArtifactBytes,
} = require('./s5-control-record-chain.cjs');

const PRODUCER_INPUT_REF = Object.freeze({
  kind: 'path',
  path:
    'scripts/domain/orders-portfolio-custom-profile/v0.3.0/portfolio-reconciliation-producer-inputs.json',
  root: 'sourceTree',
});
const INPUT_CONTRACT_REF = Object.freeze({
  kind: 'path',
  path:
    'scripts/domain/orders-portfolio-custom-profile/v0.3.0/input-contract.json',
  root: 'sourceTree',
});
const VERIFIED_PROJECTIONS = new WeakSet();
const VERIFIED_PROJECTION_METADATA = new WeakMap();

class PortfolioReconciliationEvidenceError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'PortfolioReconciliationEvidenceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PortfolioReconciliationEvidenceError(code, message);
}

function sha256Jcs(value) {
  return `sha256:${crypto.createHash('sha256')
    .update(Buffer.from(canonicalJcs(value), 'utf8')).digest('hex')}`;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('RECONCILIATION_PROJECTION_SOURCE_SCHEMA', `${label} must be a closed object`);
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (canonicalJcs(actual) !== canonicalJcs(wanted)) {
    fail(
      'RECONCILIATION_PROJECTION_SOURCE_SCHEMA',
      `${label} fields are incomplete or open`,
    );
  }
}

function parseExactJcs(artifact, label) {
  if (!artifact || !Buffer.isBuffer(artifact.bytes)) {
    fail('RECONCILIATION_PROJECTION_SOURCE_BYTES', `${label} bytes are absent`);
  }
  let value;
  try {
    value = JSON.parse(artifact.bytes.toString('utf8'));
  } catch (cause) {
    fail('RECONCILIATION_PROJECTION_SOURCE_BYTES', `${label} is not JSON: ${cause.message}`);
  }
  if (!artifact.bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    fail(
      'RECONCILIATION_PROJECTION_SOURCE_BYTES',
      `${label} is not exact RFC 8785 JCS UTF-8`,
    );
  }
  return value;
}

function rejectDownstreamOutput(value, label, depth = 0) {
  if (depth > 64) {
    fail('RECONCILIATION_PROJECTION_SOURCE_SCHEMA', `${label} exceeds bounded depth`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectDownstreamOutput(
      entry,
      `${label}[${index}]`,
      depth + 1,
    ));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if ([
      'artifacts',
      'candidateRecords',
      'canonicalScenario',
      'focusVersionIri',
      'outputRecord',
      'records',
    ].includes(key)) {
      fail(
        'RECONCILIATION_PROJECTION_SOURCE_SCHEMA',
        `${label}.${key} attempts to provide a downstream producer output`,
      );
    }
    rejectDownstreamOutput(child, `${label}.${key}`, depth + 1);
  }
}

function loadProducerCases(context) {
  const sourceArtifact = verifiedMaterializationContextSourceArtifactBytes(
    context,
    PRODUCER_INPUT_REF,
  );
  const document = parseExactJcs(sourceArtifact, 'portfolio reconciliation producer input');
  exactKeys(
    document,
    ['cases', 'producerContract', 'schemaVersion'],
    'producer input',
  );
  if (document.schemaVersion !== '1.0'
      || document.producerContract
        !== 'orders-portfolio-reconciliation-canonical-record-producer-v1'
      || !Array.isArray(document.cases)
      || document.cases.length === 0) {
    fail(
      'RECONCILIATION_PROJECTION_SOURCE_SCHEMA',
      'producer input identity or case inventory is invalid',
    );
  }
  const cases = new Map();
  let previous = null;
  for (const [index, row] of document.cases.entries()) {
    exactKeys(
      row,
      ['caseId', 'legacyInput', 'validatorId'],
      `producer input cases[${index}]`,
    );
    if (typeof row.caseId !== 'string' || row.caseId.length === 0
        || row.validatorId
          !== 'PortfolioPositionReconciliationFindingContract'
        || (previous !== null && compareUtf8(previous, row.caseId) >= 0)) {
      fail(
        'RECONCILIATION_PROJECTION_SOURCE_SCHEMA',
        'producer cases must be byte-sorted, unique, and exactly bound to the reconciliation validator',
      );
    }
    rejectDownstreamOutput(row.legacyInput, `producer input cases[${index}].legacyInput`);
    previous = row.caseId;
    cases.set(row.caseId, row);
  }
  return { cases, sourceArtifact };
}

function verifyPortfolioReconciliationProjection(context, caseId = 'baseline') {
  if (!isVerifiedMaterializationContext(context)
      || context.outcome !== 'completed'
      || context.targetGraph !== PORTFOLIO_GRAPH_IRI) {
    fail(
      'RECONCILIATION_PROJECTION_UNVERIFIED_CONTEXT',
      'projection replay requires an in-process S5 verifier-branded completed Portfolio materialization context',
    );
  }
  if (typeof caseId !== 'string' || caseId.length === 0) {
    fail('RECONCILIATION_PROJECTION_SOURCE_SCHEMA', 'caseId is invalid');
  }
  const { cases, sourceArtifact } = loadProducerCases(context);
  const row = cases.get(caseId);
  if (!row) {
    fail(
      'RECONCILIATION_PROJECTION_CASE',
      `producer input has no exact case ${caseId}`,
    );
  }
  const inputContractArtifact = verifiedMaterializationContextSourceArtifactBytes(
    context,
    INPUT_CONTRACT_REF,
  );
  const inputContract = parseExactJcs(
    inputContractArtifact,
    'orders/portfolio canonical input contract',
  );

  // The accepted projection is reconstructed exclusively from an S5-bound
  // upstream legacy input. No caller candidate row, manifest, graph digest,
  // finding record, or outputRecord enters this replay.
  let canonicalScenario;
  let normalizedScenario;
  try {
    canonicalScenario = encodeCanonicalOrdersPortfolioScenario(
      row.validatorId,
      structuredClone(row.legacyInput),
    );
    normalizedScenario = decodeCanonicalOrdersPortfolioScenario(
      canonicalScenario,
      row.validatorId,
      inputContract,
    );
  } catch (cause) {
    fail(
      'RECONCILIATION_PROJECTION_REPLAY',
      `verifier-owned canonical producer replay failed: ${cause.code || cause.message}`,
    );
  }
  const projectionDigest = sha256Jcs(normalizedScenario);
  const projection = Object.freeze({
    caseId,
    contextRef: context.recordRef,
    producerInputDigest: sourceArtifact.digest,
    projectionDigest,
    verificationKind: 'verifiedPortfolioReconciliationProjection',
  });
  VERIFIED_PROJECTIONS.add(projection);
  VERIFIED_PROJECTION_METADATA.set(projection, Object.freeze({
    caseId,
    canonicalScenarioDigest: sha256Jcs(canonicalScenario),
    inputContractDigest: inputContractArtifact.digest,
    producerInputDigest: sourceArtifact.digest,
    projectionDigest,
  }));
  return projection;
}

function isVerifiedPortfolioReconciliationProjection(value) {
  return Boolean(value) && VERIFIED_PROJECTIONS.has(value);
}

function assertVerifiedPortfolioReconciliationProjection(value, scenario) {
  if (!isVerifiedPortfolioReconciliationProjection(value)) {
    fail(
      'RECONCILIATION_PROJECTION_UNVERIFIED',
      'runtime evidence is not an in-process verifier-owned Portfolio reconciliation projection',
    );
  }
  const metadata = VERIFIED_PROJECTION_METADATA.get(value);
  let actualDigest;
  try {
    actualDigest = sha256Jcs(scenario);
  } catch (cause) {
    fail(
      'RECONCILIATION_PROJECTION_MISMATCH',
      `candidate projection is not canonicalizable: ${cause.message}`,
    );
  }
  if (actualDigest !== metadata.projectionDigest) {
    fail(
      'RECONCILIATION_PROJECTION_MISMATCH',
      'caller candidate rows, manifests, graph, request, or finding differ from verifier-owned producer replay',
    );
  }
  return metadata;
}

module.exports = {
  INPUT_CONTRACT_REF,
  PRODUCER_INPUT_REF,
  PortfolioReconciliationEvidenceError,
  assertVerifiedPortfolioReconciliationProjection,
  isVerifiedPortfolioReconciliationProjection,
  verifyPortfolioReconciliationProjection,
};
