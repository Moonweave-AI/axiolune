'use strict';

const crypto = require('node:crypto');
const {
  decodeBase64url,
  sha256,
  taggedJcsDigest,
  validateDecisionTrustPolicy,
  validateVerificationTrustPolicy,
  verifyPureEd25519,
  verifyScopedEd25519Envelope,
} = require('./m2-ed25519.cjs');
const {
  PROFILE_REF,
  RELEASE_CHECK_IDS,
} = require('./m2-release-capability-definitions.cjs');
const {
  artifactId: dependencyArtifactId,
} = require('./m2-payload-independent-replay.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const TARGET_VERSION = '0.3.0';
const CHALLENGE_PAYLOAD_TAG = 'axiolune-adoption-attempt-challenge-payload-v1\0';
const CHALLENGE_ENVELOPE_TAG = 'axiolune-adoption-attempt-challenge-v1\0';
const APPROVAL_PAYLOAD_TAG = 'axiolune-release-decision-payload-v1\0';
const RECEIPT_PAYLOAD_TAG = 'axiolune-ref-update-receipt-payload-v1\0';
const RECEIPT_ENVELOPE_TAG = 'axiolune-ref-update-receipt-v1\0';
const CHECKOUT_MANIFEST_TAG = 'axiolune-adopted-checkout-manifest-v1\0';
const ADOPTION_REPORT_TAG = 'axiolune-adoption-verification-report-v1\0';
const ADOPTION_DEPENDENCY_MANIFEST_TAG = 'axiolune-artifact-dependency-manifest-v1\0';
const ATTESTATION_PAYLOAD_TAG = 'axiolune-adoption-attestation-payload-v1\0';
const COORDINATOR_STATE_TAG = 'axiolune-adoption-attempt-state-v1\0';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const ASCII_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const ADOPTION_PHASES = Object.freeze([
  'static', 'p0Build', 'p0Verification', 'promotionAuthorization',
  'p1TreeCommit', 'p0p1Link', 'p1Build', 'payload',
  'payloadVerification', 'approvalEligibility', 'adoptionAttemptChallenge',
  'releaseApproval', 'adoptionRefUpdate', 'adoptedCheckout', 'adoptionCheck',
  'adoptionFailureEvidence', 'rollbackRefUpdate', 'adoptionVerification',
]);

function exactKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    throw new Error(`${label} fields differ from the closed schema`);
  }
}

function exactEqual(actual, expected, label) {
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    throw new Error(`${label} differs from the independently trusted value`);
  }
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    throw new Error(`${label} must be a canonical sha256 digest`);
  }
}

function artifactDigest(value) {
  return sha256(Buffer.from(canonicalJcs(value), 'utf8'));
}

function assertArtifactRef(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an ArtifactRef`);
  }
  if (value.kind === 'iri') {
    exactKeys(value, ['kind', 'iri'], label);
    if (typeof value.iri !== 'string'
        || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(value.iri)
        || value.iri !== value.iri.normalize('NFC')) {
      throw new Error(`${label} IRI is not absolute and normalized`);
    }
    return;
  }
  if (value.kind === 'path') {
    exactKeys(value, ['kind', 'root', 'path'], label);
    if (!['sourceTree', 'buildEvidence', 'payload', 'adoptionEvidence'].includes(value.root)
        || typeof value.path !== 'string'
        || value.path !== value.path.normalize('NFC')
        || value.path.includes('\\')
        || value.path.startsWith('/')
        || value.path.split('/').some((segment) => (
          segment === '' || segment === '.' || segment === '..'
        ))) {
      throw new Error(`${label} path is not a normalized rooted POSIX path`);
    }
    return;
  }
  throw new Error(`${label} has an unknown ArtifactRef kind`);
}

function assertArtifactPair(reference, digest, label) {
  assertArtifactRef(reference, `${label}Ref`);
  assertDigest(digest, `${label}Digest`);
}

function assertAsciiId(value, label) {
  if (typeof value !== 'string' || !ASCII_ID_RE.test(value)) {
    throw new Error(`${label} must be a non-empty ASCII identifier`);
  }
}

function instant(value, label) {
  if (typeof value !== 'string' || !INSTANT_RE.test(value)) {
    throw new Error(`${label} must be a canonical UTC whole-second instant`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)
      || new Date(epoch).toISOString() !== value.replace('Z', '.000Z')) {
    throw new Error(`${label} must be a real canonical UTC calendar value`);
  }
  return epoch;
}

function assertSafeInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
}

function assertGitObjectId(value, format, label) {
  const length = format === 'sha1' ? 40 : format === 'sha256' ? 64 : 0;
  if (length === 0 || typeof value !== 'string'
      || !new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(value)) {
    throw new Error(`${label} is not a canonical ${format || 'unknown'} Git object ID`);
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function assertExpectedFields(value, expected, fields, label) {
  for (const field of fields) {
    if (Object.hasOwn(expected || {}, field)) {
      exactEqual(value[field], expected[field], `${label}.${field}`);
    }
  }
}

function assertSignatureShape(envelope, label) {
  exactKeys(envelope.signature, ['signedDigest', 'signatureEncoding', 'value'], `${label}.signature`);
  assertDigest(envelope.signature.signedDigest, `${label}.signature.signedDigest`);
  if (envelope.signature.signatureEncoding !== 'base64url-nopad') {
    throw new Error(`${label}.signature has a non-canonical encoding`);
  }
  decodeBase64url(envelope.signature.value, 64, `${label}.signature.value`);
}

function verifyAdoptionAttemptChallenge(options) {
  const { challenge, verificationTrustPolicy, expected = {} } = options;
  exactKeys(
    challenge,
    ['schemaVersion', 'challengePayload', 'challengePayloadDigest', 'signature'],
    'AdoptionAttemptChallenge',
  );
  if (challenge.schemaVersion !== '1.0') {
    throw new Error('AdoptionAttemptChallenge schemaVersion must be 1.0');
  }
  const fields = [
    'challengeType', 'challengeId', 'repositoryId', 'authoritativeRef',
    'gitObjectFormat', 'expectedOldCommitId', 'requestedNewCommitId',
    'payloadManifestRef', 'payloadManifestDigest',
    'approvalEligibilityReportRef', 'approvalEligibilityReportDigest',
    'refEpoch', 'attemptSequence', 'issuedAt', 'expiresAt',
    'verificationTrustPolicyRef', 'verificationTrustPolicyDigest',
    'coordinatorPrincipalRef', 'keyRef', 'publicKeyFingerprint', 'algorithm',
  ];
  exactKeys(challenge.challengePayload, fields, 'AdoptionAttemptChallenge.challengePayload');
  assertSignatureShape(challenge, 'AdoptionAttemptChallenge');
  const payload = challenge.challengePayload;
  if (payload.challengeType !== 'adoptionAttempt' || payload.algorithm !== 'Ed25519') {
    throw new Error('AdoptionAttemptChallenge type or algorithm is invalid');
  }
  decodeBase64url(payload.challengeId, 32, 'AdoptionAttemptChallenge.challengeId');
  if (!/^refs\/[^\s]+$/u.test(payload.authoritativeRef)) {
    throw new Error('AdoptionAttemptChallenge authoritativeRef is not a full refs/... name');
  }
  assertGitObjectId(payload.expectedOldCommitId, payload.gitObjectFormat, 'challenge expectedOldCommitId');
  assertGitObjectId(payload.requestedNewCommitId, payload.gitObjectFormat, 'challenge requestedNewCommitId');
  if (payload.expectedOldCommitId === payload.requestedNewCommitId) {
    throw new Error('AdoptionAttemptChallenge old and new commit IDs must differ');
  }
  assertArtifactPair(payload.payloadManifestRef, payload.payloadManifestDigest, 'challenge payloadManifest');
  assertArtifactPair(
    payload.approvalEligibilityReportRef,
    payload.approvalEligibilityReportDigest,
    'challenge approvalEligibilityReport',
  );
  assertArtifactPair(
    payload.verificationTrustPolicyRef,
    payload.verificationTrustPolicyDigest,
    'challenge verificationTrustPolicy',
  );
  assertSafeInteger(payload.refEpoch, 0, 'challenge refEpoch');
  assertSafeInteger(payload.attemptSequence, 1, 'challenge attemptSequence');
  const issuedAt = instant(payload.issuedAt, 'challenge issuedAt');
  const expiresAt = instant(payload.expiresAt, 'challenge expiresAt');
  if (issuedAt >= expiresAt) {
    throw new Error('AdoptionAttemptChallenge issuedAt must be strictly before expiresAt');
  }
  assertExpectedFields(payload, expected, [
    'repositoryId', 'authoritativeRef', 'gitObjectFormat',
    'expectedOldCommitId', 'requestedNewCommitId',
    'payloadManifestRef', 'payloadManifestDigest',
    'approvalEligibilityReportRef', 'approvalEligibilityReportDigest',
    'verificationTrustPolicyRef', 'verificationTrustPolicyDigest',
  ], 'AdoptionAttemptChallenge');
  const signature = verifyScopedEd25519Envelope({
    envelope: challenge,
    envelopeLabel: 'AdoptionAttemptChallenge',
    payloadField: 'challengePayload',
    payloadDigestField: 'challengePayloadDigest',
    payloadTag: CHALLENGE_PAYLOAD_TAG,
    policy: verificationTrustPolicy,
    expectedPolicyDigest: payload.verificationTrustPolicyDigest,
    scope: 'adoptionAttemptChallenge',
    principalRef: payload.coordinatorPrincipalRef,
    keyRef: payload.keyRef,
    publicKeyFingerprint: payload.publicKeyFingerprint,
    algorithm: payload.algorithm,
    repositoryId: payload.repositoryId,
    authoritativeRef: payload.authoritativeRef,
    signedAt: payload.issuedAt,
  });
  return {
    challengeDigest: taggedJcsDigest(CHALLENGE_ENVELOPE_TAG, challenge),
    expiresAt,
    issuedAt,
    payload,
    payloadDigest: signature.payloadDigest,
    policyDigest: signature.policyDigest,
  };
}

function verifyApprovalEnvelope(options) {
  const {
    approval,
    challengeVerification,
    challengeRef,
    decisionTrustPolicy,
    expectedDecisionTrustPolicyRef,
    expected = {},
  } = options;
  exactKeys(
    approval,
    ['schemaVersion', 'decisionPayload', 'decisionPayloadDigest', 'signature'],
    'ApprovalEnvelope',
  );
  if (approval.schemaVersion !== '1.0') {
    throw new Error('ApprovalEnvelope schemaVersion must be 1.0');
  }
  const fields = [
    'decisionType', 'decision', 'repositoryId', 'authoritativeRef',
    'expectedOldCommitId', 'gitObjectFormat', 'targetVersion',
    'payloadManifestRef', 'payloadManifestDigest',
    'payloadVerificationReportRef', 'payloadVerificationReportDigest',
    'approvalEligibilityReportRef', 'approvalEligibilityReportDigest',
    'adoptionAttemptChallengeRef', 'adoptionAttemptChallengeDigest',
    'challengeId', 'refEpoch', 'attemptSequence',
    'prospectiveCommitId', 'treeId', 'sourceTreeDigest',
    'buildId', 'buildInputsDigest',
    'decisionTrustPolicyRef', 'decisionTrustPolicyDigest',
    'driRef', 'keyRef', 'publicKeyFingerprint', 'algorithm',
    'decisionTime', 'rationale',
  ];
  exactKeys(approval.decisionPayload, fields, 'ApprovalEnvelope.decisionPayload');
  assertSignatureShape(approval, 'ApprovalEnvelope');
  const payload = approval.decisionPayload;
  if (payload.decisionType !== 'releaseApproval'
      || payload.decision !== 'approve'
      || payload.algorithm !== 'Ed25519'
      || payload.targetVersion !== TARGET_VERSION) {
    throw new Error('ApprovalEnvelope is not an approve decision for M2 v0.3.0');
  }
  const challenge = challengeVerification.payload;
  const bindings = {
    repositoryId: challenge.repositoryId,
    authoritativeRef: challenge.authoritativeRef,
    expectedOldCommitId: challenge.expectedOldCommitId,
    gitObjectFormat: challenge.gitObjectFormat,
    payloadManifestRef: challenge.payloadManifestRef,
    payloadManifestDigest: challenge.payloadManifestDigest,
    approvalEligibilityReportRef: challenge.approvalEligibilityReportRef,
    approvalEligibilityReportDigest: challenge.approvalEligibilityReportDigest,
    adoptionAttemptChallengeRef: challengeRef,
    adoptionAttemptChallengeDigest: challengeVerification.challengeDigest,
    challengeId: challenge.challengeId,
    refEpoch: challenge.refEpoch,
    attemptSequence: challenge.attemptSequence,
    prospectiveCommitId: challenge.requestedNewCommitId,
  };
  assertExpectedFields(payload, bindings, Object.keys(bindings), 'ApprovalEnvelope challenge binding');
  assertExpectedFields(payload, expected, [
    'targetVersion', 'payloadVerificationReportRef', 'payloadVerificationReportDigest',
    'treeId', 'sourceTreeDigest', 'buildId', 'buildInputsDigest',
    'decisionTrustPolicyRef', 'decisionTrustPolicyDigest',
  ], 'ApprovalEnvelope');
  assertArtifactPair(
    payload.payloadVerificationReportRef,
    payload.payloadVerificationReportDigest,
    'approval payloadVerificationReport',
  );
  assertArtifactPair(
    payload.decisionTrustPolicyRef,
    payload.decisionTrustPolicyDigest,
    'approval decisionTrustPolicy',
  );
  if (expectedDecisionTrustPolicyRef) {
    exactEqual(
      payload.decisionTrustPolicyRef,
      expectedDecisionTrustPolicyRef,
      'ApprovalEnvelope.decisionTrustPolicyRef',
    );
  }
  assertGitObjectId(payload.treeId, payload.gitObjectFormat, 'approval treeId');
  assertDigest(payload.sourceTreeDigest, 'approval sourceTreeDigest');
  assertDigest(payload.buildInputsDigest, 'approval buildInputsDigest');
  assertAsciiId(payload.buildId, 'approval buildId');
  if (typeof payload.rationale !== 'string' || payload.rationale.length === 0
      || payload.rationale !== payload.rationale.normalize('NFC')) {
    throw new Error('ApprovalEnvelope rationale must be a non-empty normalized string');
  }
  const decisionTime = instant(payload.decisionTime, 'approval decisionTime');
  if (!(challengeVerification.issuedAt < decisionTime
      && decisionTime < challengeVerification.expiresAt)) {
    throw new Error('ApprovalEnvelope decisionTime is outside the strict challenge window');
  }
  const payloadDigest = taggedJcsDigest(APPROVAL_PAYLOAD_TAG, payload);
  if (approval.decisionPayloadDigest !== payloadDigest
      || approval.signature.signedDigest !== payloadDigest) {
    throw new Error('ApprovalEnvelope payload/signed digest binding differs');
  }
  const policyDigest = validateDecisionTrustPolicy(decisionTrustPolicy);
  if (payload.decisionTrustPolicyDigest !== policyDigest) {
    throw new Error('ApprovalEnvelope does not bind the independently trusted decision policy');
  }
  const rows = decisionTrustPolicy.principals.filter((row) => (
    row.driRef === payload.driRef
      && row.keyRef === payload.keyRef
      && row.publicKeyFingerprint === payload.publicKeyFingerprint
      && row.algorithm === payload.algorithm
  ));
  if (rows.length !== 1) {
    throw new Error('ApprovalEnvelope signer tuple has no unique decision-policy row');
  }
  const row = rows[0];
  const notBefore = instant(row.notBefore, 'approval policy notBefore');
  const notAfter = row.notAfter ? instant(row.notAfter, 'approval policy notAfter') : null;
  if (row.status !== 'active' || decisionTime < notBefore
      || (notAfter !== null && decisionTime >= notAfter)) {
    throw new Error('ApprovalEnvelope signer is revoked or outside its validity interval');
  }
  verifyPureEd25519({
    publicKey: row.publicKey,
    signature: approval.signature.value,
    messageDigest: payloadDigest,
  });
  return {
    approvalDigest: artifactDigest(approval),
    decisionTime,
    payload,
    payloadDigest,
    policyDigest,
  };
}

function verifyAdoptionReceipt(options) {
  const {
    receipt,
    receiptRef,
    approvalVerification,
    approvalRef,
    challengeVerification,
    challengeRef,
    verificationTrustPolicy,
    expectedUpdater = {},
  } = options;
  exactKeys(
    receipt,
    ['schemaVersion', 'receiptPayload', 'receiptPayloadDigest', 'signature'],
    'RefUpdateReceipt',
  );
  if (receipt.schemaVersion !== '1.0') {
    throw new Error('RefUpdateReceipt schemaVersion must be 1.0');
  }
  const fields = [
    'receiptType', 'operationId', 'operationKind',
    'repositoryId', 'authoritativeRef', 'gitObjectFormat',
    'approvalEnvelopeRef', 'approvalEnvelopeDigest',
    'adoptionAttemptChallengeRef', 'adoptionAttemptChallengeDigest',
    'challengeId', 'refEpoch', 'attemptSequence',
    'expectedOldCommitId', 'requestedNewCommitId', 'expectedRefEpoch',
    'updaterToolId', 'updaterCapabilityId',
    'updaterCapabilityRef', 'updaterCapabilityDigest',
    'updaterEntrypointRef', 'updaterEntrypointDigest',
    'verificationTrustPolicyRef', 'verificationTrustPolicyDigest',
    'updaterPrincipalRef', 'keyRef', 'publicKeyFingerprint', 'algorithm',
    'operationTime', 'result',
  ];
  exactKeys(receipt.receiptPayload, fields, 'RefUpdateReceipt.receiptPayload');
  assertSignatureShape(receipt, 'RefUpdateReceipt');
  const payload = receipt.receiptPayload;
  if (payload.receiptType !== 'refUpdate'
      || payload.operationKind !== 'adoption'
      || payload.algorithm !== 'Ed25519') {
    throw new Error('RefUpdateReceipt is not a pure-Ed25519 adoption receipt');
  }
  assertAsciiId(payload.operationId, 'receipt operationId');
  assertAsciiId(payload.updaterToolId, 'receipt updaterToolId');
  assertAsciiId(payload.updaterCapabilityId, 'receipt updaterCapabilityId');
  const approval = approvalVerification.payload;
  const challenge = challengeVerification.payload;
  const bindings = {
    repositoryId: approval.repositoryId,
    authoritativeRef: approval.authoritativeRef,
    gitObjectFormat: approval.gitObjectFormat,
    approvalEnvelopeRef: approvalRef,
    approvalEnvelopeDigest: approvalVerification.approvalDigest,
    adoptionAttemptChallengeRef: challengeRef,
    adoptionAttemptChallengeDigest: challengeVerification.challengeDigest,
    challengeId: challenge.challengeId,
    refEpoch: challenge.refEpoch,
    attemptSequence: challenge.attemptSequence,
    expectedOldCommitId: approval.expectedOldCommitId,
    requestedNewCommitId: approval.prospectiveCommitId,
    expectedRefEpoch: challenge.refEpoch,
    verificationTrustPolicyRef: challenge.verificationTrustPolicyRef,
    verificationTrustPolicyDigest: challenge.verificationTrustPolicyDigest,
  };
  assertExpectedFields(payload, bindings, Object.keys(bindings), 'RefUpdateReceipt chain binding');
  assertExpectedFields(payload, expectedUpdater, [
    'updaterToolId', 'updaterCapabilityId',
    'updaterCapabilityRef', 'updaterCapabilityDigest',
    'updaterEntrypointRef', 'updaterEntrypointDigest',
  ], 'RefUpdateReceipt updater');
  assertArtifactPair(
    payload.updaterCapabilityRef,
    payload.updaterCapabilityDigest,
    'receipt updaterCapability',
  );
  assertArtifactPair(
    payload.updaterEntrypointRef,
    payload.updaterEntrypointDigest,
    'receipt updaterEntrypoint',
  );
  exactKeys(
    payload.result,
    [
      'outcome', 'observedBeforeCommitId', 'observedAfterCommitId',
      'observedRefEpochBefore', 'observedRefEpochAfter', 'errors',
    ],
    'RefUpdateReceipt.result',
  );
  if (payload.result.outcome !== 'updated'
      || !Array.isArray(payload.result.errors)
      || payload.result.errors.length !== 0
      || payload.result.observedBeforeCommitId !== payload.expectedOldCommitId
      || payload.result.observedAfterCommitId !== payload.requestedNewCommitId
      || payload.result.observedRefEpochBefore !== payload.expectedRefEpoch
      || payload.result.observedRefEpochAfter !== payload.expectedRefEpoch + 1) {
    throw new Error('RefUpdateReceipt updated result does not prove the exact old/new commit and epoch transition');
  }
  assertSafeInteger(payload.result.observedRefEpochBefore, 0, 'receipt observedRefEpochBefore');
  assertSafeInteger(payload.result.observedRefEpochAfter, 1, 'receipt observedRefEpochAfter');
  const operationTime = instant(payload.operationTime, 'receipt operationTime');
  if (!(approvalVerification.decisionTime < operationTime
      && operationTime < challengeVerification.expiresAt)) {
    throw new Error('RefUpdateReceipt operationTime is outside the strict signed stage order');
  }
  const signature = verifyScopedEd25519Envelope({
    envelope: receipt,
    envelopeLabel: 'RefUpdateReceipt',
    payloadField: 'receiptPayload',
    payloadDigestField: 'receiptPayloadDigest',
    payloadTag: RECEIPT_PAYLOAD_TAG,
    policy: verificationTrustPolicy,
    expectedPolicyDigest: payload.verificationTrustPolicyDigest,
    scope: 'refUpdateReceipt',
    principalRef: payload.updaterPrincipalRef,
    keyRef: payload.keyRef,
    publicKeyFingerprint: payload.publicKeyFingerprint,
    algorithm: payload.algorithm,
    repositoryId: payload.repositoryId,
    authoritativeRef: payload.authoritativeRef,
    signedAt: payload.operationTime,
  });
  assertArtifactRef(receiptRef, 'adoptionReceiptRef');
  return {
    operationTime,
    payload,
    payloadDigest: signature.payloadDigest,
    receiptDigest: taggedJcsDigest(RECEIPT_ENVELOPE_TAG, receipt),
    receiptRef,
  };
}

function validateCheckoutManifest(options) {
  const {
    manifest,
    manifestRef,
    approvalVerification,
    approvalRef,
    expectedSourceTreeFiles,
    expectedP1SourceTreeManifestRef,
    expectedP1SourceTreeManifestDigest,
  } = options;
  exactKeys(manifest, [
    'schemaVersion', 'repositoryId', 'authoritativeRef', 'gitObjectFormat',
    'commitId', 'treeId', 'sourceTreeDigest',
    'p1SourceTreeManifestRef', 'p1SourceTreeManifestDigest',
    'approvalEnvelopeRef', 'approvalEnvelopeDigest',
    'files', 'excludedAdministrativeRoot', 'untrackedPaths', 'extraEntryCount',
  ], 'AdoptedCheckoutManifest');
  if (manifest.schemaVersion !== '1.0'
      || manifest.excludedAdministrativeRoot !== '.git'
      || !Array.isArray(manifest.untrackedPaths)
      || manifest.untrackedPaths.length !== 0
      || manifest.extraEntryCount !== 0) {
    throw new Error('AdoptedCheckoutManifest administrative/extra-entry closure is invalid');
  }
  const approval = approvalVerification.payload;
  assertExpectedFields(manifest, {
    repositoryId: approval.repositoryId,
    authoritativeRef: approval.authoritativeRef,
    gitObjectFormat: approval.gitObjectFormat,
    commitId: approval.prospectiveCommitId,
    treeId: approval.treeId,
    sourceTreeDigest: approval.sourceTreeDigest,
    p1SourceTreeManifestRef: expectedP1SourceTreeManifestRef,
    p1SourceTreeManifestDigest: expectedP1SourceTreeManifestDigest,
    approvalEnvelopeRef: approvalRef,
    approvalEnvelopeDigest: approvalVerification.approvalDigest,
  }, [
    'repositoryId', 'authoritativeRef', 'gitObjectFormat',
    'commitId', 'treeId', 'sourceTreeDigest',
    'p1SourceTreeManifestRef', 'p1SourceTreeManifestDigest',
    'approvalEnvelopeRef', 'approvalEnvelopeDigest',
  ], 'AdoptedCheckoutManifest');
  assertArtifactPair(
    manifest.p1SourceTreeManifestRef,
    manifest.p1SourceTreeManifestDigest,
    'checkout p1SourceTreeManifest',
  );
  assertArtifactPair(
    manifest.approvalEnvelopeRef,
    manifest.approvalEnvelopeDigest,
    'checkout approvalEnvelope',
  );
  if (!Array.isArray(expectedSourceTreeFiles) || expectedSourceTreeFiles.length === 0) {
    throw new Error('AdoptedCheckoutManifest requires an independently reconstructed non-empty source-tree inventory');
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error('AdoptedCheckoutManifest.files must be an array');
  }
  let previousPath = null;
  for (let index = 0; index < manifest.files.length; index += 1) {
    const row = manifest.files[index];
    exactKeys(row, ['mode', 'path', 'byteLength', 'artifactDigest'], `checkout files/${index}`);
    if (!['100644', '100755'].includes(row.mode)
        || typeof row.path !== 'string'
        || row.path !== row.path.normalize('NFC')
        || row.path.includes('\\')
        || row.path.startsWith('/')
        || row.path.split('/').some((segment) => (
          segment === '' || segment === '.' || segment === '..'
        ))
        || !Number.isSafeInteger(row.byteLength) || row.byteLength < 0) {
      throw new Error(`AdoptedCheckoutManifest file row ${index} is invalid`);
    }
    assertDigest(row.artifactDigest, `checkout files/${index}/artifactDigest`);
    if (previousPath !== null && compareUtf8(previousPath, row.path) >= 0) {
      throw new Error('AdoptedCheckoutManifest files are not strictly path-sorted and unique');
    }
    previousPath = row.path;
  }
  exactEqual(manifest.files, expectedSourceTreeFiles, 'AdoptedCheckoutManifest.files');
  assertArtifactRef(manifestRef, 'adoptedCheckoutManifestRef');
  return {
    manifest,
    manifestDigest: taggedJcsDigest(CHECKOUT_MANIFEST_TAG, manifest),
    manifestRef,
  };
}

function validateVerifierCheck(check, expectedBinding, verifiedCheck, index) {
  exactKeys(check, [
    'checkId', 'toolId', 'capabilityId',
    'capabilityRef', 'capabilityDigest',
    'entrypointRef', 'entrypointDigest',
    'discoveryContractRef', 'discoveryContractDigest',
    'evidenceSchemaRef', 'evidenceSchemaDigest',
    'subjectInventoryRef', 'subjectInventoryDigest',
    'counts', 'evidenceRef', 'evidenceDigest', 'status',
  ], `AdoptionVerificationReport.checks/${index}`);
  for (const field of ['checkId', 'toolId', 'capabilityId']) {
    assertAsciiId(check[field], `adoption check ${index}.${field}`);
  }
  for (const name of [
    'capability', 'entrypoint', 'discoveryContract', 'evidenceSchema',
    'subjectInventory', 'evidence',
  ]) {
    assertArtifactPair(check[`${name}Ref`], check[`${name}Digest`], `adoption check ${index}.${name}`);
  }
  exactKeys(check.counts, ['discovered', 'executed', 'passed', 'failed'], `adoption check ${index}.counts`);
  for (const field of ['discovered', 'executed', 'passed', 'failed']) {
    assertSafeInteger(check.counts[field], 0, `adoption check ${index}.counts.${field}`);
  }
  if (check.status !== 'passed'
      || check.counts.discovered <= 0
      || check.counts.discovered !== check.counts.executed
      || check.counts.executed !== check.counts.passed
      || check.counts.failed !== 0) {
    throw new Error(`adoption check ${check.checkId} does not prove non-empty passed execution`);
  }
  const bindingFields = [
    'checkId', 'toolId', 'capabilityId',
    'capabilityRef', 'capabilityDigest',
    'entrypointRef', 'entrypointDigest',
    'discoveryContractRef', 'discoveryContractDigest',
    'evidenceSchemaRef', 'evidenceSchemaDigest',
  ];
  if (!expectedBinding) {
    throw new Error(`adoption check ${check.checkId} has no independently locked manifest binding`);
  }
  assertExpectedFields(check, expectedBinding, bindingFields, `adoption check ${check.checkId} manifest binding`);
  if (!verifiedCheck) {
    throw new Error(`adoption check ${check.checkId} has no independently replayed evidence`);
  }
  exactEqual(check, verifiedCheck, `adoption check ${check.checkId} replay`);
}

function validateCoordinatorConsumedState(options) {
  const {
    state,
    challengeVerification,
    approvalVerification,
    receiptVerification,
  } = options;
  exactKeys(state, [
    'schemaVersion', 'repositoryId', 'authoritativeRef',
    'challengeId', 'challengeDigest', 'attemptSequence',
    'initialRefEpoch', 'currentRefEpoch', 'currentCommitId',
    'state', 'preparedOperation', 'consumedAdoptionReceiptDigest',
    'querySequence',
  ], 'ProtectedCoordinatorState');
  if (state.schemaVersion !== '1.0' || state.state !== 'consumed') {
    throw new Error('ProtectedCoordinatorState is not the closed consumed projection');
  }
  exactKeys(state.preparedOperation, [
    'operationKind', 'approvalEnvelopeDigest',
    'expectedOldCommitId', 'requestedNewCommitId', 'expectedRefEpoch',
  ], 'ProtectedCoordinatorState.preparedOperation');
  const challenge = challengeVerification.payload;
  const approval = approvalVerification.payload;
  const receipt = receiptVerification.payload;
  assertExpectedFields(state, {
    repositoryId: challenge.repositoryId,
    authoritativeRef: challenge.authoritativeRef,
    challengeId: challenge.challengeId,
    challengeDigest: challengeVerification.challengeDigest,
    attemptSequence: challenge.attemptSequence,
    initialRefEpoch: challenge.refEpoch,
    currentRefEpoch: receipt.result.observedRefEpochAfter,
    currentCommitId: approval.prospectiveCommitId,
    consumedAdoptionReceiptDigest: receiptVerification.receiptDigest,
  }, [
    'repositoryId', 'authoritativeRef', 'challengeId', 'challengeDigest',
    'attemptSequence', 'initialRefEpoch', 'currentRefEpoch', 'currentCommitId',
    'consumedAdoptionReceiptDigest',
  ], 'ProtectedCoordinatorState');
  assertExpectedFields(state.preparedOperation, {
    operationKind: 'adoption',
    approvalEnvelopeDigest: approvalVerification.approvalDigest,
    expectedOldCommitId: receipt.expectedOldCommitId,
    requestedNewCommitId: receipt.requestedNewCommitId,
    expectedRefEpoch: receipt.expectedRefEpoch,
  }, [
    'operationKind', 'approvalEnvelopeDigest', 'expectedOldCommitId',
    'requestedNewCommitId', 'expectedRefEpoch',
  ], 'ProtectedCoordinatorState.preparedOperation');
  assertSafeInteger(state.initialRefEpoch, 0, 'coordinator initialRefEpoch');
  assertSafeInteger(state.currentRefEpoch, 1, 'coordinator currentRefEpoch');
  assertSafeInteger(state.querySequence, 1, 'coordinator querySequence');
  return {
    state,
    stateDigest: taggedJcsDigest(COORDINATOR_STATE_TAG, state),
  };
}

function verifyAdoptionReport(options) {
  const {
    report,
    reportRef,
    approvalVerification,
    approvalRef,
    challengeVerification,
    challengeRef,
    receiptVerification,
    receiptRef,
    checkoutVerification,
    eligibility,
    coordinatorVerification,
    expectedVerifier,
    expectedCheckBindings,
    verifiedChecks,
  } = options;
  exactKeys(report, [
    'schemaVersion', 'profileRef', 'targetVersion',
    'approvalEnvelopeRef', 'approvalEnvelopeDigest',
    'approvalEligibilityReportRef', 'approvalEligibilityReportDigest',
    'adoptionAttemptChallengeRef', 'adoptionAttemptChallengeDigest',
    'challengeId', 'refEpoch', 'attemptSequence',
    'repositoryId', 'authoritativeRef', 'gitObjectFormat',
    'expectedOldCommitId', 'expectedCommitId', 'expectedTreeId',
    'expectedSourceTreeDigest', 'adoptionReceiptRef', 'adoptionReceiptDigest',
    'verifierRef', 'verifierDigest', 'coordinatorStateDigest',
    'observedRefEpoch', 'reportTime', 'result',
  ], 'AdoptionVerificationReport');
  if (report.schemaVersion !== '1.0'
      || report.profileRef !== PROFILE_REF
      || report.targetVersion !== TARGET_VERSION) {
    throw new Error('AdoptionVerificationReport profile identity is invalid');
  }
  const approval = approvalVerification.payload;
  const challenge = challengeVerification.payload;
  const receipt = receiptVerification.payload;
  assertExpectedFields(report, {
    approvalEnvelopeRef: approvalRef,
    approvalEnvelopeDigest: approvalVerification.approvalDigest,
    approvalEligibilityReportRef: challenge.approvalEligibilityReportRef,
    approvalEligibilityReportDigest: challenge.approvalEligibilityReportDigest,
    adoptionAttemptChallengeRef: challengeRef,
    adoptionAttemptChallengeDigest: challengeVerification.challengeDigest,
    challengeId: challenge.challengeId,
    refEpoch: challenge.refEpoch,
    attemptSequence: challenge.attemptSequence,
    repositoryId: approval.repositoryId,
    authoritativeRef: approval.authoritativeRef,
    gitObjectFormat: approval.gitObjectFormat,
    expectedOldCommitId: approval.expectedOldCommitId,
    expectedCommitId: approval.prospectiveCommitId,
    expectedTreeId: approval.treeId,
    expectedSourceTreeDigest: approval.sourceTreeDigest,
    adoptionReceiptRef: receiptRef,
    adoptionReceiptDigest: receiptVerification.receiptDigest,
    verifierRef: expectedVerifier?.verifierRef,
    verifierDigest: expectedVerifier?.verifierDigest,
    coordinatorStateDigest: coordinatorVerification.stateDigest,
    observedRefEpoch: coordinatorVerification.state.currentRefEpoch,
  }, [
    'approvalEnvelopeRef', 'approvalEnvelopeDigest',
    'approvalEligibilityReportRef', 'approvalEligibilityReportDigest',
    'adoptionAttemptChallengeRef', 'adoptionAttemptChallengeDigest',
    'challengeId', 'refEpoch', 'attemptSequence',
    'repositoryId', 'authoritativeRef', 'gitObjectFormat',
    'expectedOldCommitId', 'expectedCommitId', 'expectedTreeId',
    'expectedSourceTreeDigest', 'adoptionReceiptRef', 'adoptionReceiptDigest',
    'verifierRef', 'verifierDigest', 'coordinatorStateDigest', 'observedRefEpoch',
  ], 'AdoptionVerificationReport');
  if (!eligibility || eligibility.eligible !== true
      || canonicalJcs(eligibility.reportRef) !== canonicalJcs(report.approvalEligibilityReportRef)
      || eligibility.reportDigest !== report.approvalEligibilityReportDigest) {
    throw new Error('AdoptionVerificationReport does not bind an independently reverified eligible report');
  }
  assertArtifactPair(report.verifierRef, report.verifierDigest, 'adoption report verifier');
  assertArtifactRef(reportRef, 'adoptionVerificationReportRef');
  exactKeys(report.result, [
    'outcome', 'observedCommitId', 'observedTreeId', 'observedSourceTreeDigest',
    'adoptedCheckoutManifestRef', 'adoptedCheckoutManifestDigest',
    'checks', 'errors',
  ], 'AdoptionVerificationReport.result');
  if (report.result.outcome !== 'adopted'
      || report.result.observedCommitId !== report.expectedCommitId
      || report.result.observedTreeId !== report.expectedTreeId
      || report.result.observedSourceTreeDigest !== report.expectedSourceTreeDigest
      || canonicalJcs(report.result.adoptedCheckoutManifestRef)
        !== canonicalJcs(checkoutVerification.manifestRef)
      || report.result.adoptedCheckoutManifestDigest !== checkoutVerification.manifestDigest
      || !Array.isArray(report.result.errors) || report.result.errors.length !== 0) {
    throw new Error('AdoptionVerificationReport adopted branch does not close Git/source/checkout identities');
  }
  const requiredCheckIds = RELEASE_CHECK_IDS.adoptionVerification;
  if (!Array.isArray(report.result.checks)
      || report.result.checks.length !== requiredCheckIds.length
      || canonicalJcs(report.result.checks.map((row) => row?.checkId))
        !== canonicalJcs(requiredCheckIds)) {
    throw new Error('AdoptionVerificationReport does not contain the exact adoption check inventory');
  }
  const expectedById = new Map((expectedCheckBindings || []).map((row) => [row.checkId, row]));
  const verifiedById = verifiedChecks instanceof Map
    ? verifiedChecks : new Map((verifiedChecks || []).map((row) => [row.checkId, row]));
  report.result.checks.forEach((check, index) => validateVerifierCheck(
    check,
    expectedById.get(check.checkId),
    verifiedById.get(check.checkId),
    index,
  ));
  const reportTime = instant(report.reportTime, 'adoption reportTime');
  if (!(receiptVerification.operationTime < reportTime
      && reportTime < challengeVerification.expiresAt)) {
    throw new Error('AdoptionVerificationReport reportTime is outside the strict signed stage order');
  }
  return {
    payload: report,
    reportDigest: taggedJcsDigest(ADOPTION_REPORT_TAG, report),
    reportRef,
    reportTime,
  };
}

function artifactPairKey(reference, digest) {
  return `${canonicalJcs(reference)}\0${digest}`;
}

function validateAdoptionDependencyGraph(manifest) {
  if (!Array.isArray(manifest.roots) || manifest.roots.length !== 1
      || !Array.isArray(manifest.nodes) || manifest.nodes.length === 0
      || !Array.isArray(manifest.edges)) {
    throw new Error('AdoptionArtifactDependencyManifest root/node/edge closure is invalid');
  }
  assertDigest(manifest.roots[0], 'adoption dependency root');

  const nodesById = new Map();
  const refDigests = new Map();
  let previousNodeId = null;
  for (let index = 0; index < manifest.nodes.length; index += 1) {
    const node = manifest.nodes[index];
    exactKeys(node, [
      'artifactId', 'artifactRef', 'artifactDigest', 'artifactKind',
      'phase', 'finalizationOrdinal',
    ], `AdoptionArtifactDependencyManifest.nodes/${index}`);
    assertDigest(node.artifactId, `adoption dependency node ${index}.artifactId`);
    assertArtifactPair(
      node.artifactRef,
      node.artifactDigest,
      `adoption dependency node ${index}.artifact`,
    );
    assertAsciiId(node.artifactKind, `adoption dependency node ${index}.artifactKind`);
    if (!ADOPTION_PHASES.includes(node.phase)) {
      throw new Error(`adoption dependency node ${index} has an unknown phase`);
    }
    assertSafeInteger(
      node.finalizationOrdinal,
      0,
      `adoption dependency node ${index}.finalizationOrdinal`,
    );
    if (dependencyArtifactId(node) !== node.artifactId) {
      throw new Error(`adoption dependency node ${index} artifactId does not recompute`);
    }
    if (previousNodeId !== null && compareUtf8(previousNodeId, node.artifactId) >= 0) {
      throw new Error('AdoptionArtifactDependencyManifest nodes are not strictly artifactId-sorted and unique');
    }
    previousNodeId = node.artifactId;
    nodesById.set(node.artifactId, node);
    const refKey = canonicalJcs(node.artifactRef);
    const priorDigest = refDigests.get(refKey);
    if (priorDigest && priorDigest !== node.artifactDigest) {
      throw new Error('AdoptionArtifactDependencyManifest resolves one ArtifactRef to conflicting digests');
    }
    refDigests.set(refKey, node.artifactDigest);
  }
  if (!nodesById.has(manifest.roots[0])) {
    throw new Error('AdoptionArtifactDependencyManifest root has no node');
  }

  const prerequisitesByDependent = new Map(
    [...nodesById.keys()].map((artifactIdValue) => [artifactIdValue, []]),
  );
  let previousEdgeKey = null;
  for (let index = 0; index < manifest.edges.length; index += 1) {
    const edge = manifest.edges[index];
    exactKeys(
      edge,
      ['prerequisiteArtifactId', 'dependentArtifactId', 'locator'],
      `AdoptionArtifactDependencyManifest.edges/${index}`,
    );
    assertDigest(
      edge.prerequisiteArtifactId,
      `adoption dependency edge ${index}.prerequisiteArtifactId`,
    );
    assertDigest(
      edge.dependentArtifactId,
      `adoption dependency edge ${index}.dependentArtifactId`,
    );
    exactKeys(
      edge.locator,
      ['locatorKind', 'value'],
      `AdoptionArtifactDependencyManifest.edges/${index}.locator`,
    );
    if (!['jsonPointer', 'rdfPredicate', 'manifestMembership', 'derivedInput']
      .includes(edge.locator.locatorKind)
        || typeof edge.locator.value !== 'string'
        || edge.locator.value.length === 0
        || edge.locator.value !== edge.locator.value.normalize('NFC')) {
      throw new Error(`adoption dependency edge ${index} has an invalid locator`);
    }
    if (edge.locator.locatorKind === 'jsonPointer'
        && (!edge.locator.value.startsWith('/') || edge.locator.value === '/')) {
      throw new Error(`adoption dependency edge ${index} has a non-canonical JSON Pointer`);
    }
    if (edge.locator.locatorKind === 'rdfPredicate'
        && !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(edge.locator.value)) {
      throw new Error(`adoption dependency edge ${index} has a non-absolute RDF predicate`);
    }
    const prerequisite = nodesById.get(edge.prerequisiteArtifactId);
    const dependent = nodesById.get(edge.dependentArtifactId);
    if (!prerequisite || !dependent) {
      throw new Error(`adoption dependency edge ${index} has an unresolved endpoint`);
    }
    if (prerequisite.artifactId === dependent.artifactId) {
      throw new Error(`adoption dependency edge ${index} is a direct self-edge`);
    }
    const prerequisitePhase = ADOPTION_PHASES.indexOf(prerequisite.phase);
    const dependentPhase = ADOPTION_PHASES.indexOf(dependent.phase);
    if (dependentPhase < prerequisitePhase
        || (dependentPhase === prerequisitePhase
          && dependent.finalizationOrdinal <= prerequisite.finalizationOrdinal)) {
      throw new Error(`adoption dependency edge ${index} violates phase/finalization ordering`);
    }
    const edgeKey = [
      edge.dependentArtifactId,
      edge.prerequisiteArtifactId,
      edge.locator.locatorKind,
      edge.locator.value,
    ].join('\0');
    if (previousEdgeKey !== null && compareUtf8(previousEdgeKey, edgeKey) >= 0) {
      throw new Error('AdoptionArtifactDependencyManifest edges are not strictly sorted and unique');
    }
    previousEdgeKey = edgeKey;
    prerequisitesByDependent.get(edge.dependentArtifactId)
      .push(edge.prerequisiteArtifactId);
  }

  const reachable = new Set();
  const queue = [...manifest.roots];
  while (queue.length > 0) {
    const current = queue.pop();
    if (reachable.has(current)) continue;
    reachable.add(current);
    queue.push(...prerequisitesByDependent.get(current));
  }
  if (reachable.size !== manifest.nodes.length) {
    throw new Error('AdoptionArtifactDependencyManifest contains unreachable/orphan nodes');
  }
}

function verifyAdoptionDependencyManifest(options) {
  const {
    manifest,
    manifestRef,
    reportVerification,
    challengeVerification,
    challengeRef,
    recomputedManifest,
    requiredArtifactPairs,
  } = options;
  exactKeys(manifest, [
    'schemaVersion', 'scope',
    'phaseRegistryRef', 'phaseRegistryDigest',
    'extractorCapabilityRef', 'extractorCapabilityDigest',
    'adoptionAttemptChallengeRef', 'adoptionAttemptChallengeDigest',
    'challengeId', 'refEpoch', 'attemptSequence',
    'roots', 'nodes', 'edges',
  ], 'AdoptionArtifactDependencyManifest');
  if (manifest.schemaVersion !== '1.0' || manifest.scope !== 'adoption') {
    throw new Error('AdoptionArtifactDependencyManifest scope/schema is invalid');
  }
  for (const name of ['phaseRegistry', 'extractorCapability']) {
    assertArtifactPair(manifest[`${name}Ref`], manifest[`${name}Digest`], `adoption dependency ${name}`);
  }
  const challenge = challengeVerification.payload;
  assertExpectedFields(manifest, {
    adoptionAttemptChallengeRef: challengeRef,
    adoptionAttemptChallengeDigest: challengeVerification.challengeDigest,
    challengeId: challenge.challengeId,
    refEpoch: challenge.refEpoch,
    attemptSequence: challenge.attemptSequence,
  }, [
    'adoptionAttemptChallengeRef', 'adoptionAttemptChallengeDigest',
    'challengeId', 'refEpoch', 'attemptSequence',
  ], 'AdoptionArtifactDependencyManifest');
  if (!recomputedManifest) {
    throw new Error('AdoptionArtifactDependencyManifest requires independent extractor replay');
  }
  exactEqual(manifest, recomputedManifest, 'AdoptionArtifactDependencyManifest replay');
  validateAdoptionDependencyGraph(manifest);
  const reportNode = manifest.nodes.filter((node) => (
    node?.artifactKind === 'adoptionVerification'
      && canonicalJcs(node.artifactRef) === canonicalJcs(reportVerification.reportRef)
      && node.artifactDigest === reportVerification.reportDigest
  ));
  if (reportNode.length !== 1
      || manifest.roots[0] !== reportNode[0].artifactId) {
    throw new Error('AdoptionArtifactDependencyManifest root is not the exact final adoption report');
  }
  const nodePairs = new Set(manifest.nodes.map((node) => (
    artifactPairKey(node.artifactRef, node.artifactDigest)
  )));
  for (const pair of requiredArtifactPairs || []) {
    if (!nodePairs.has(artifactPairKey(pair.artifactRef, pair.artifactDigest))) {
      throw new Error(`AdoptionArtifactDependencyManifest omits required artifact ${pair.label || pair.artifactDigest}`);
    }
  }
  assertArtifactRef(manifestRef, 'adoptionArtifactDependencyManifestRef');
  return {
    manifest,
    manifestDigest: taggedJcsDigest(ADOPTION_DEPENDENCY_MANIFEST_TAG, manifest),
    manifestRef,
  };
}

function verifyAdoptionAttestation(options) {
  const {
    attestation,
    reportVerification,
    dependencyVerification,
    challengeVerification,
    challengeRef,
    receiptVerification,
    receiptRef,
    verificationTrustPolicy,
    expectedVerificationTrustPolicyRef,
    coordinatorVerification,
    authoritativeRefObservation,
  } = options;
  exactKeys(
    attestation,
    ['schemaVersion', 'attestationPayload', 'attestationPayloadDigest', 'signature'],
    'AdoptionAttestation',
  );
  if (attestation.schemaVersion !== '1.0') {
    throw new Error('AdoptionAttestation schemaVersion must be 1.0');
  }
  const fields = [
    'attestationType', 'result',
    'repositoryId', 'authoritativeRef', 'gitObjectFormat', 'targetVersion',
    'expectedOldCommitId', 'expectedCommitId', 'expectedTreeId',
    'expectedSourceTreeDigest',
    'adoptionAttemptChallengeRef', 'adoptionAttemptChallengeDigest',
    'challengeId', 'refEpoch', 'attemptSequence',
    'attestedRefCommitId', 'adoptionReceiptRef', 'adoptionReceiptDigest',
    'adoptionVerificationReportRef', 'adoptionVerificationReportDigest',
    'adoptionArtifactDependencyManifestRef',
    'adoptionArtifactDependencyManifestDigest',
    'coordinatorStateDigest', 'observedRefEpoch',
    'verificationTrustPolicyRef', 'verificationTrustPolicyDigest',
    'verifierPrincipalRef', 'keyRef', 'publicKeyFingerprint', 'algorithm',
    'attestationTime',
  ];
  exactKeys(attestation.attestationPayload, fields, 'AdoptionAttestation.attestationPayload');
  assertSignatureShape(attestation, 'AdoptionAttestation');
  const payload = attestation.attestationPayload;
  const report = reportVerification.payload;
  const challenge = challengeVerification.payload;
  if (payload.attestationType !== 'adoptionVerification'
      || payload.result !== 'adopted'
      || payload.algorithm !== 'Ed25519'
      || payload.targetVersion !== TARGET_VERSION) {
    throw new Error('AdoptionAttestation is not an adopted M2 v0.3.0 attestation');
  }
  assertExpectedFields(payload, {
    repositoryId: report.repositoryId,
    authoritativeRef: report.authoritativeRef,
    gitObjectFormat: report.gitObjectFormat,
    targetVersion: report.targetVersion,
    expectedOldCommitId: report.expectedOldCommitId,
    expectedCommitId: report.expectedCommitId,
    expectedTreeId: report.expectedTreeId,
    expectedSourceTreeDigest: report.expectedSourceTreeDigest,
    adoptionAttemptChallengeRef: challengeRef,
    adoptionAttemptChallengeDigest: challengeVerification.challengeDigest,
    challengeId: challenge.challengeId,
    refEpoch: challenge.refEpoch,
    attemptSequence: challenge.attemptSequence,
    attestedRefCommitId: report.expectedCommitId,
    adoptionReceiptRef: receiptRef,
    adoptionReceiptDigest: receiptVerification.receiptDigest,
    adoptionVerificationReportRef: reportVerification.reportRef,
    adoptionVerificationReportDigest: reportVerification.reportDigest,
    adoptionArtifactDependencyManifestRef: dependencyVerification.manifestRef,
    adoptionArtifactDependencyManifestDigest: dependencyVerification.manifestDigest,
    coordinatorStateDigest: coordinatorVerification.stateDigest,
    observedRefEpoch: coordinatorVerification.state.currentRefEpoch,
    verificationTrustPolicyRef: challenge.verificationTrustPolicyRef,
    verificationTrustPolicyDigest: challenge.verificationTrustPolicyDigest,
  }, [
    'repositoryId', 'authoritativeRef', 'gitObjectFormat', 'targetVersion',
    'expectedOldCommitId', 'expectedCommitId', 'expectedTreeId',
    'expectedSourceTreeDigest',
    'adoptionAttemptChallengeRef', 'adoptionAttemptChallengeDigest',
    'challengeId', 'refEpoch', 'attemptSequence', 'attestedRefCommitId',
    'adoptionReceiptRef', 'adoptionReceiptDigest',
    'adoptionVerificationReportRef', 'adoptionVerificationReportDigest',
    'adoptionArtifactDependencyManifestRef',
    'adoptionArtifactDependencyManifestDigest',
    'coordinatorStateDigest', 'observedRefEpoch',
    'verificationTrustPolicyRef', 'verificationTrustPolicyDigest',
  ], 'AdoptionAttestation');
  if (expectedVerificationTrustPolicyRef) {
    exactEqual(
      payload.verificationTrustPolicyRef,
      expectedVerificationTrustPolicyRef,
      'AdoptionAttestation.verificationTrustPolicyRef',
    );
  }
  if (authoritativeRefObservation !== payload.expectedCommitId) {
    throw new Error('AdoptionAttestation adjacent authoritative-ref observation is not P1');
  }
  const attestationTime = instant(payload.attestationTime, 'attestationTime');
  if (!(reportVerification.reportTime < attestationTime
      && attestationTime < challengeVerification.expiresAt)) {
    throw new Error('AdoptionAttestation attestationTime is outside the strict signed stage order');
  }
  const signature = verifyScopedEd25519Envelope({
    envelope: attestation,
    envelopeLabel: 'AdoptionAttestation',
    payloadField: 'attestationPayload',
    payloadDigestField: 'attestationPayloadDigest',
    payloadTag: ATTESTATION_PAYLOAD_TAG,
    policy: verificationTrustPolicy,
    expectedPolicyDigest: payload.verificationTrustPolicyDigest,
    scope: 'adoptionAttestation',
    principalRef: payload.verifierPrincipalRef,
    keyRef: payload.keyRef,
    publicKeyFingerprint: payload.publicKeyFingerprint,
    algorithm: payload.algorithm,
    repositoryId: payload.repositoryId,
    authoritativeRef: payload.authoritativeRef,
    signedAt: payload.attestationTime,
  });
  return {
    componentVerified: true,
    attestationPayloadDigest: signature.payloadDigest,
    attestationTime,
    terminallyVerified: false,
    releaseComplete: false,
  };
}

function verifyAdoptedEvidenceChain(options) {
  validateVerificationTrustPolicy(options.verificationTrustPolicy);
  const challengeVerification = verifyAdoptionAttemptChallenge({
    challenge: options.challenge,
    verificationTrustPolicy: options.verificationTrustPolicy,
    expected: options.expected,
  });
  const approvalVerification = verifyApprovalEnvelope({
    approval: options.approval,
    challengeVerification,
    challengeRef: options.refs.challenge,
    decisionTrustPolicy: options.decisionTrustPolicy,
    expectedDecisionTrustPolicyRef: options.expected.decisionTrustPolicyRef,
    expected: options.expected,
  });
  const receiptVerification = verifyAdoptionReceipt({
    receipt: options.adoptionReceipt,
    receiptRef: options.refs.adoptionReceipt,
    approvalVerification,
    approvalRef: options.refs.approval,
    challengeVerification,
    challengeRef: options.refs.challenge,
    verificationTrustPolicy: options.verificationTrustPolicy,
    expectedUpdater: options.expected.updater,
  });
  const checkoutVerification = validateCheckoutManifest({
    manifest: options.checkoutManifest,
    manifestRef: options.refs.checkoutManifest,
    approvalVerification,
    approvalRef: options.refs.approval,
    expectedSourceTreeFiles: options.expected.sourceTreeFiles,
    expectedP1SourceTreeManifestRef: options.expected.p1SourceTreeManifestRef,
    expectedP1SourceTreeManifestDigest: options.expected.p1SourceTreeManifestDigest,
  });
  const coordinatorVerification = validateCoordinatorConsumedState({
    state: options.coordinatorState,
    challengeVerification,
    approvalVerification,
    receiptVerification,
  });
  const reportVerification = verifyAdoptionReport({
    report: options.adoptionReport,
    reportRef: options.refs.adoptionReport,
    approvalVerification,
    approvalRef: options.refs.approval,
    challengeVerification,
    challengeRef: options.refs.challenge,
    receiptVerification,
    receiptRef: options.refs.adoptionReceipt,
    checkoutVerification,
    eligibility: options.eligibility,
    coordinatorVerification,
    expectedVerifier: options.expected.verifier,
    expectedCheckBindings: options.expected.checkBindings,
    verifiedChecks: options.verifiedChecks,
  });
  const requiredArtifactPairs = [
    {
      label: 'challenge',
      artifactRef: options.refs.challenge,
      artifactDigest: challengeVerification.challengeDigest,
    },
    {
      label: 'approval',
      artifactRef: options.refs.approval,
      artifactDigest: approvalVerification.approvalDigest,
    },
    {
      label: 'adoption receipt',
      artifactRef: options.refs.adoptionReceipt,
      artifactDigest: receiptVerification.receiptDigest,
    },
    {
      label: 'checkout manifest',
      artifactRef: options.refs.checkoutManifest,
      artifactDigest: checkoutVerification.manifestDigest,
    },
    {
      label: 'adoption report',
      artifactRef: options.refs.adoptionReport,
      artifactDigest: reportVerification.reportDigest,
    },
  ];
  const dependencyVerification = verifyAdoptionDependencyManifest({
    manifest: options.adoptionDependencyManifest,
    manifestRef: options.refs.adoptionDependencyManifest,
    reportVerification,
    challengeVerification,
    challengeRef: options.refs.challenge,
    recomputedManifest: options.recomputedAdoptionDependencyManifest,
    requiredArtifactPairs,
  });
  const attestationVerification = verifyAdoptionAttestation({
    attestation: options.attestation,
    reportVerification,
    dependencyVerification,
    challengeVerification,
    challengeRef: options.refs.challenge,
    receiptVerification,
    receiptRef: options.refs.adoptionReceipt,
    verificationTrustPolicy: options.verificationTrustPolicy,
    expectedVerificationTrustPolicyRef: options.expected.verificationTrustPolicyRef,
    coordinatorVerification,
    authoritativeRefObservation: options.authoritativeRefObservation,
  });
  return {
    schemaVersion: '1.0',
    verificationScope: 'adoption-evidence-chain-component',
    outcome: 'component-verified',
    eligible: true,
    approvalStatus: 'not-approved',
    adoptionStatus: 'not-terminally-verified',
    releaseComplete: false,
    terminalVerificationRequired: true,
    challengeDigest: challengeVerification.challengeDigest,
    approvalDigest: approvalVerification.approvalDigest,
    adoptionReceiptDigest: receiptVerification.receiptDigest,
    adoptionVerificationReportDigest: reportVerification.reportDigest,
    adoptionArtifactDependencyManifestDigest: dependencyVerification.manifestDigest,
    attestationPayloadDigest: attestationVerification.attestationPayloadDigest,
  };
}

module.exports = {
  ADOPTION_DEPENDENCY_MANIFEST_TAG,
  ADOPTION_REPORT_TAG,
  APPROVAL_PAYLOAD_TAG,
  ATTESTATION_PAYLOAD_TAG,
  CHALLENGE_ENVELOPE_TAG,
  CHALLENGE_PAYLOAD_TAG,
  CHECKOUT_MANIFEST_TAG,
  COORDINATOR_STATE_TAG,
  RECEIPT_ENVELOPE_TAG,
  RECEIPT_PAYLOAD_TAG,
  TARGET_VERSION,
  artifactDigest,
  validateCheckoutManifest,
  validateCoordinatorConsumedState,
  verifyAdoptedEvidenceChain,
  verifyAdoptionAttemptChallenge,
  verifyAdoptionDependencyManifest,
  verifyAdoptionReceipt,
  verifyAdoptionReport,
  verifyApprovalEnvelope,
};
