'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  GATE_IMPLEMENTATION_PATHS,
  PROFILE_REF,
} = require('../lib/m2-release-capability-definitions.cjs');
const {
  STABLE_GATE_IDS,
  VECTOR_SEMANTICS_UNIMPLEMENTED,
  discoverGateSubjects,
  evaluateStableRequiredGate,
  runCandidateValidation,
} = require('../lib/m2-stable-required-gate-adapters.cjs');
const {
  INVENTORY_TAG,
  sha256,
  taggedJcsDigest,
} = require('../lib/m2-gate-artifact-binding-replay.cjs');
const {
  validateRequest,
} = require('../run-stable-required-gate.cjs');
const termCoverage = require('../lib/public-symbol-term-coverage-validator.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function candidateRequest(gateId) {
  const discoveryPath = [
    'scripts/domain/release-capability-profile/v0.3.0/gates',
    gateId,
    'discovery-contract.json',
  ].join('/');
  const inventory = {
    schemaVersion: '1.0',
    gateId,
    discoveryContractRef: {
      kind: 'path', root: 'sourceTree', path: discoveryPath,
    },
    discoveryContractDigest: sha256(fs.readFileSync(path.join(
      ROOT, ...discoveryPath.split('/'),
    ))),
    subjects: discoverGateSubjects(ROOT, gateId),
  };
  return {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    operation: 'replayRequiredGate',
    capabilityId: `gate.${gateId}`,
    gateId,
    vectorCategory: null,
    fault: null,
    subjectInventory: inventory,
    subjectInventoryDigest: taggedJcsDigest(INVENTORY_TAG, inventory),
    dependencyReports: [],
  };
}

function vectorRequest(gateId, vectorCategory) {
  return {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    operation: 'semanticVector',
    capabilityId: `gate.${gateId}`,
    gateId,
    vectorCategory,
    subject: vectorCategory === 'emptySubject'
      ? null : { fixtureVersion: '1.0', gateId, valid: true },
    subjectDigest: vectorCategory === 'emptySubject'
      ? null : `sha256:${'0'.repeat(64)}`,
    fault: vectorCategory === 'engineFailure' ? 'forced-engine-failure' : null,
  };
}

test('candidate adapters cannot be promoted by generic flag-only semantic vectors', async () => {
  for (const gateId of STABLE_GATE_IDS) {
    for (const category of [
      'emptySubject', 'engineFailure', 'positive', 'tamper', 'violation',
    ]) {
      const result = await evaluateStableRequiredGate(vectorRequest(gateId, category), {
        root: ROOT,
      });
      assert.equal(result.exitStatus, 2, `${gateId}/${category}`);
      assert.equal(result.value.status, 'engineFailure', `${gateId}/${category}`);
      assert.equal(result.value.outcome, 'engineFailure', `${gateId}/${category}`);
      assert.equal(result.value.code, VECTOR_SEMANTICS_UNIMPLEMENTED, `${gateId}/${category}`);
      assert.equal(result.value.releaseEligibilityEvidence, false, `${gateId}/${category}`);
      assert.equal(result.value.callerEvidenceAccepted, false, `${gateId}/${category}`);
    }
  }
});

test('semantic-vector request validation rejects the replay null sentinel', () => {
  const request = vectorRequest('m3-schema', 'positive');
  request.vectorCategory = null;
  assert.throws(
    () => validateRequest(request),
    /semantic vector request is not the closed v1 contract/u,
  );
});

test('interface-only capabilities do not claim uninvoked gate validator sources', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const [gateId, candidatePaths] of Object.entries(GATE_IMPLEMENTATION_PATHS)) {
    const capability = JSON.parse(fs.readFileSync(path.join(
      ROOT,
      'scripts',
      'domain',
      'release-capability-profile',
      'v0.3.0',
      'gates',
      gateId,
      'capability.json',
    ), 'utf8'));
    if (capability.implementationMode
        !== 'interface-conformance-only-not-release-eligibility-evidence') continue;
    const declared = new Set(
      capability.semanticImplementationArtifacts.map((entry) => entry.ref.path),
    );
    for (const candidatePath of candidatePaths) {
      assert.equal(
        declared.has(candidatePath),
        false,
        `${gateId} claims uninvoked candidate source ${candidatePath}`,
      );
    }
  }
});

test('candidate M3 adapters execute the production validators against current source bytes', async () => {
  for (const gateId of ['m3-import-digest', 'm3-schema']) {
    const result = await runCandidateValidation(ROOT, gateId);
    assert.equal(result.ok, true, `${gateId}: ${JSON.stringify(result.findings.slice(0, 3))}`);
    assert.deepEqual(result.failedAssertions, [], gateId);
    assert.ok(result.checkedArtifactCount > 0, gateId);
  }
});

test('a diagnostic candidate pass remains ineligible for release evidence', async () => {
  const request = candidateRequest('m3-schema');
  validateRequest(request);
  const result = await evaluateStableRequiredGate(request, { root: ROOT });
  assert.equal(result.exitStatus, 0);
  assert.equal(result.value.status, 'completed');
  assert.equal(result.value.outcome, 'passed');
  assert.equal(result.value.releaseEligibilityEvidence, false);
  assert.equal(result.value.callerEvidenceAccepted, false);
});

test('candidate replay rejects a mismatched subject-inventory digest', async () => {
  const request = candidateRequest('m3-schema');
  request.subjectInventoryDigest = `sha256:${'0'.repeat(64)}`;
  const result = await evaluateStableRequiredGate(request, { root: ROOT });
  assert.equal(result.value.outcome, 'failed');
  assert.equal(result.value.releaseEligibilityEvidence, false);
  assert.ok(result.value.kindEvidence.findings.some(
    (finding) => finding.code === 'SUBJECT_INVENTORY_MISMATCH',
  ));
});

test('candidate replay rejects an open or altered inventory envelope even when re-digested', async () => {
  const request = candidateRequest('m3-schema');
  request.subjectInventory.discoveryContractRef.unreviewed = true;
  request.subjectInventoryDigest = taggedJcsDigest(
    INVENTORY_TAG, request.subjectInventory,
  );
  assert.throws(
    () => validateRequest(request),
    /candidate replay request is not the closed v1 contract/u,
  );
  const result = await evaluateStableRequiredGate(request, { root: ROOT });
  assert.equal(result.value.outcome, 'failed');
  assert.equal(result.value.releaseEligibilityEvidence, false);
  assert.ok(result.value.kindEvidence.findings.some(
    (finding) => finding.code === 'SUBJECT_INVENTORY_MISMATCH',
  ));
});

test('candidate request validation rejects a non-v1 inventory schema', () => {
  const request = candidateRequest('m3-schema');
  request.subjectInventory.schemaVersion = '0.9';
  request.subjectInventoryDigest = taggedJcsDigest(
    INVENTORY_TAG, request.subjectInventory,
  );
  assert.throws(
    () => validateRequest(request),
    /candidate replay request is not the closed v1 contract/u,
  );
});

test('independent stable gates reject caller-supplied dependency evidence', async () => {
  const request = candidateRequest('m3-schema');
  request.dependencyReports = [{ reportDigest: `sha256:${'1'.repeat(64)}` }];
  assert.throws(
    () => validateRequest(request),
    /candidate replay request is not the closed v1 contract/u,
  );
  const result = await evaluateStableRequiredGate(request, { root: ROOT });
  assert.equal(result.value.outcome, 'failed');
  assert.equal(result.value.releaseEligibilityEvidence, false);
  assert.ok(result.value.kindEvidence.findings.some(
    (finding) => finding.code === 'SUBJECT_INVENTORY_MISMATCH',
  ));
});

test('term corpus capture failure is an engine failure, never a semantic completion', async () => {
  const request = candidateRequest('public-symbol-term-coverage');
  const original = termCoverage.captureAndValidate;
  termCoverage.captureAndValidate = () => {
    throw new Error('forced immutable-capture failure');
  };
  try {
    await assert.rejects(
      runCandidateValidation(ROOT, 'public-symbol-term-coverage'),
      /forced immutable-capture failure/u,
    );
    const result = await evaluateStableRequiredGate(request, { root: ROOT });
    assert.equal(result.exitStatus, 2);
    assert.equal(result.value.status, 'engineFailure');
    assert.equal(result.value.outcome, 'engineFailure');
    assert.equal(result.value.code, 'TERM_CORPUS_CAPTURE_FAILED');
    assert.equal(result.value.releaseEligibilityEvidence, false);
    assert.ok(result.value.kindEvidence.findings.some(
      (finding) => finding.code === 'TERM_CORPUS_CAPTURE_FAILED',
    ));
  } finally {
    termCoverage.captureAndValidate = original;
  }
});

test('discovery-contract capture failure is an engine failure', async () => {
  const request = candidateRequest('public-symbol-term-coverage');
  const original = termCoverage.readStableRegularFile;
  termCoverage.readStableRegularFile = () => {
    throw new Error('forced discovery-contract capture failure');
  };
  try {
    const result = await evaluateStableRequiredGate(request, { root: ROOT });
    assert.equal(result.exitStatus, 2);
    assert.equal(result.value.status, 'engineFailure');
    assert.equal(result.value.outcome, 'engineFailure');
    assert.equal(result.value.code, 'DISCOVERY_CONTRACT_CAPTURE_FAILED');
    assert.equal(result.value.releaseEligibilityEvidence, false);
  } finally {
    termCoverage.readStableRegularFile = original;
  }
});
