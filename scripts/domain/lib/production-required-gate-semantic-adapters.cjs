'use strict';

const path = require('node:path');
const {
  PROFILE_REF,
  compareUtf8,
} = require('./m2-release-capability-definitions.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const MODULE_GATE_ID = 'module-import-dag';
const M3_GATE_IDS = Object.freeze(['m3-import-digest', 'm3-schema']);
const PRODUCTION_GATE_IDS = Object.freeze([
  ...M3_GATE_IDS,
  MODULE_GATE_ID,
].sort(compareUtf8));

function m3Adapter() {
  return require('./m3-required-gate-semantic-adapter.cjs');
}

function moduleAdapter() {
  return require('./module-import-dag-required-gate-semantic-adapter.cjs');
}

function assertGateId(gateId) {
  if (!PRODUCTION_GATE_IDS.includes(gateId)) {
    throw new Error(`unsupported production required gate ${String(gateId)}`);
  }
}

function productionDiscoveryRules(gateId) {
  assertGateId(gateId);
  return M3_GATE_IDS.includes(gateId)
    ? m3Adapter().discoveryRules(gateId)
    : moduleAdapter().discoveryRules(gateId);
}

function productionRuntimePolicy(gateId) {
  assertGateId(gateId);
  return M3_GATE_IDS.includes(gateId)
    ? m3Adapter().RUNTIME_POLICY
    : moduleAdapter().RUNTIME_POLICY;
}

function productionAdapterVersion(gateId) {
  assertGateId(gateId);
  return M3_GATE_IDS.includes(gateId)
    ? m3Adapter().ADAPTER_VERSION
    : moduleAdapter().ADAPTER_VERSION;
}

function productionVectorSubjectTag(gateId) {
  assertGateId(gateId);
  return M3_GATE_IDS.includes(gateId)
    ? m3Adapter().VECTOR_SUBJECT_TAG
    : moduleAdapter().VECTOR_SUBJECT_TAG;
}

function productionVectorBaseline(root, gateId) {
  assertGateId(gateId);
  if (M3_GATE_IDS.includes(gateId)) {
    const adapter = m3Adapter();
    return adapter.captureValidatedProductionCorpus(path.resolve(root), gateId);
  }
  const adapter = moduleAdapter();
  const snapshot = adapter.discoverSnapshot(path.resolve(root));
  const validation = adapter.validateCapturedCorpus(path.resolve(root), snapshot.files);
  if (!validation.ok) {
    const codes = [...new Set(validation.findings.map((row) => row.code))]
      .sort(compareUtf8);
    throw new Error(
      `production ${MODULE_GATE_ID} vector baseline is invalid: ${codes.join(', ') || 'unknown finding'}`,
    );
  }
  return new Map([...snapshot.files].map(([relativePath, bytes]) => [
    relativePath,
    Buffer.from(bytes),
  ]));
}

function vectorFileRows(files, sha256) {
  return [...files].sort((left, right) => compareUtf8(left[0], right[0]))
    .map(([relativePath, bytes]) => ({
      path: relativePath,
      byteLength: bytes.length,
      digest: sha256(bytes),
      contentBase64: bytes.toString('base64'),
    }));
}

function productionVectorSubject(root, gateId, category) {
  assertGateId(gateId);
  if (!['positive', 'violation'].includes(category)) {
    throw new Error(`unsupported production vector corpus category ${String(category)}`);
  }
  const baseline = productionVectorBaseline(root, gateId);
  const adapter = M3_GATE_IDS.includes(gateId) ? m3Adapter() : moduleAdapter();
  const mutation = category === 'violation'
    ? adapter.applyMutation(gateId, baseline)
    : { files: baseline, descriptor: null };
  return {
    schemaVersion: '1.0',
    gateId,
    baselineFiles: vectorFileRows(baseline, adapter.sha256 || require('./module-import-dag-validator.cjs').sha256),
    candidateFiles: vectorFileRows(
      mutation.files,
      adapter.sha256 || require('./module-import-dag-validator.cjs').sha256,
    ),
    mutation: mutation.descriptor,
  };
}

function productionTaggedVectorDigest(gateId, subject) {
  assertGateId(gateId);
  const adapter = M3_GATE_IDS.includes(gateId) ? m3Adapter() : moduleAdapter();
  return adapter.taggedDigest(productionVectorSubjectTag(gateId), subject);
}

function productionVectorIdentity(gateId, category) {
  assertGateId(gateId);
  const m3Violation = gateId === 'm3-schema'
    ? 'M3_SCHEMA_SEMANTIC_VIOLATION'
    : 'M3_IMPORT_DIGEST_SEMANTIC_VIOLATION';
  const moduleCodes = moduleAdapter().VECTOR_CODES;
  const table = M3_GATE_IDS.includes(gateId) ? {
    positive: ['completed', 'accepted', null, 0],
    violation: ['completed', 'violation', m3Violation, 0],
    tamper: ['engineFailure', 'engineFailure', 'M3_GATE_VECTOR_SUBJECT_DIGEST', 2],
    emptySubject: ['engineFailure', 'engineFailure', 'M3_GATE_VECTOR_EMPTY_SUBJECT', 2],
    engineFailure: ['engineFailure', 'engineFailure', 'M3_GATE_VECTOR_ENGINE_FAILURE', 2],
  } : {
    positive: ['completed', 'accepted', null, 0],
    violation: ['completed', 'violation', moduleCodes.violation, 0],
    tamper: ['engineFailure', 'engineFailure', moduleCodes.tamper, 2],
    emptySubject: ['engineFailure', 'engineFailure', moduleCodes.emptySubject, 2],
    engineFailure: ['engineFailure', 'engineFailure', moduleCodes.engineFailure, 2],
  };
  const row = table[category];
  if (!row) throw new Error(`unsupported semantic vector category ${String(category)}`);
  return {
    status: row[0],
    outcome: row[1],
    code: row[2],
    exitStatus: row[3],
    releaseEligibilityEvidence: false,
  };
}

function evaluateProductionRequiredGate(request, options = {}) {
  assertGateId(request?.gateId);
  if (request.profileRef !== PROFILE_REF) {
    throw new Error('production required-gate request selects the wrong profile');
  }
  return M3_GATE_IDS.includes(request.gateId)
    ? m3Adapter().evaluateM3RequiredGate(request, options)
    : moduleAdapter().evaluateModuleImportDagRequiredGate(request, options);
}

function productionVectorConfig(gateId) {
  assertGateId(gateId);
  return {
    adapterVersion: productionAdapterVersion(gateId),
    runtimePolicy: productionRuntimePolicy(gateId),
    discoveryRules: productionDiscoveryRules(gateId)
      .sort((left, right) => compareUtf8(canonicalJcs(left), canonicalJcs(right))),
    vectorSubjectTag: productionVectorSubjectTag(gateId),
  };
}

module.exports = {
  M3_GATE_IDS,
  MODULE_GATE_ID,
  PRODUCTION_GATE_IDS,
  evaluateProductionRequiredGate,
  productionAdapterVersion,
  productionDiscoveryRules,
  productionRuntimePolicy,
  productionTaggedVectorDigest,
  productionVectorBaseline,
  productionVectorConfig,
  productionVectorIdentity,
  productionVectorSubject,
  productionVectorSubjectTag,
};
