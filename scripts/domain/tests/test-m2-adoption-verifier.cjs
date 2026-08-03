'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
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
  artifactDigest,
  validateCoordinatorConsumedState,
  verifyAdoptedEvidenceChain,
  verifyAdoptionAttemptChallenge,
  verifyAdoptionDependencyManifest,
  verifyAdoptionReceipt,
  verifyAdoptionReport,
  verifyApprovalEnvelope,
} = require('../lib/m2-adoption-verifier.cjs');
const {
  VERIFICATION_POLICY_TAG,
  sha256,
  taggedJcsDigest,
} = require('../lib/m2-ed25519.cjs');
const {
  PROFILE_REF,
  RELEASE_CHECK_IDS,
} = require('../lib/m2-release-capability-definitions.cjs');
const {
  artifactId,
} = require('../lib/m2-payload-independent-replay.cjs');
const {
  buildSourceTreeManifest,
  inspectCommit,
} = require('../lib/m2-git-replay.cjs');
const {
  collectTerminalRequiredPairs,
  verifyTerminalAdoption,
} = require('../lib/m2-terminal-adoption-verifier.cjs');
const {
  REQUIRED_RUNTIME_PATHS,
  buildTerminalRuntimeClosureManifest,
  canonicalJcs,
  terminalRuntimeClosureDigest,
} = require('../lib/m2-terminal-runtime-closure.cjs');
const {
  assessM2ReleaseLifecycle,
} = require('../lib/m2-release-lifecycle.cjs');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..');
let cachedRuntimeClosure;

function currentRuntimeClosure() {
  if (!cachedRuntimeClosure) {
    const manifest = buildTerminalRuntimeClosureManifest(WORKSPACE_ROOT);
    cachedRuntimeClosure = {
      manifest,
      digest: terminalRuntimeClosureDigest(manifest),
    };
  }
  return cachedRuntimeClosure;
}

function writeCanonicalJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, canonicalJcs(value));
}

function detachedBundle(evidence) {
  return {
    schemaVersion: '1.0',
    refs: structuredClone(evidence.refs),
    challenge: structuredClone(evidence.challenge),
    approval: structuredClone(evidence.approval),
    adoptionReceipt: structuredClone(evidence.adoptionReceipt),
    checkoutManifest: structuredClone(evidence.checkoutManifest),
    coordinatorState: structuredClone(evidence.coordinatorState),
    adoptionReport: structuredClone(evidence.adoptionReport),
    adoptionDependencyManifest: structuredClone(evidence.adoptionDependencyManifest),
    attestation: structuredClone(evidence.attestation),
    expected: structuredClone(evidence.expected),
    verifiedChecks: [...evidence.verifiedChecks.values()].map((row) => structuredClone(row)),
  };
}

function externalTerminalConfig(t, fixture) {
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-terminal-authority-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-terminal-runtime-'));
  t.after(() => {
    fs.rmSync(externalRoot, { recursive: true, force: true });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });
  for (const relativePath of REQUIRED_RUNTIME_PATHS) {
    const destination = path.join(runtimeRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(WORKSPACE_ROOT, ...relativePath.split('/')), destination);
  }
  const runtimeClosure = buildTerminalRuntimeClosureManifest(runtimeRoot);
  fixture.options.runtimeRoot = runtimeRoot;
  fixture.options.runtimeClosure = structuredClone(runtimeClosure);
  fixture.options.trustedPins.terminalRuntimeClosureDigest
    = terminalRuntimeClosureDigest(runtimeClosure);
  const runtimeClosurePath = path.join(externalRoot, 'runtime-closure.json');
  const bundlePath = path.join(externalRoot, 'bundle.json');
  const coordinatorStatePath = path.join(externalRoot, 'coordinator-state.json');
  const decisionTrustPolicyPath = path.join(externalRoot, 'decision-policy.json');
  const verificationTrustPolicyPath = path.join(externalRoot, 'verification-policy.json');
  const configPath = path.join(externalRoot, 'terminal-config.json');
  writeCanonicalJson(runtimeClosurePath, fixture.options.runtimeClosure);
  writeCanonicalJson(bundlePath, detachedBundle(fixture.evidence));
  writeCanonicalJson(coordinatorStatePath, fixture.freshCoordinatorState);
  writeCanonicalJson(decisionTrustPolicyPath, fixture.evidence.decisionTrustPolicy);
  writeCanonicalJson(verificationTrustPolicyPath, fixture.evidence.verificationTrustPolicy);
  writeCanonicalJson(configPath, {
    schemaVersion: '1.0',
    runtimeRoot: fixture.options.runtimeRoot,
    runtimeClosurePath,
    bundlePath,
    repositoryRoot: fixture.gitFixture.repositoryRoot,
    checkoutRoot: fixture.gitFixture.checkoutRoot,
    coordinatorStatePath,
    decisionTrustPolicyPath,
    verificationTrustPolicyPath,
    trustedPins: fixture.options.trustedPins,
  });
  return { configPath, runtimeRoot };
}

function pathRef(path, root = 'adoptionEvidence') {
  return { kind: 'path', root, path };
}

function digest(label) {
  return sha256(Buffer.from(label, 'utf8'));
}

function makeSigner(label) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    label,
    privateKey: pair.privateKey,
    publicKey: publicKey.toString('base64url'),
    publicKeyFingerprint: sha256(publicKey),
  };
}

function signedEnvelope(payload, payloadTag, payloadField, digestField, privateKey) {
  const payloadDigest = taggedJcsDigest(payloadTag, payload);
  return {
    schemaVersion: '1.0',
    [payloadField]: payload,
    [digestField]: payloadDigest,
    signature: {
      signedDigest: payloadDigest,
      signatureEncoding: 'base64url-nopad',
      value: crypto.sign(
        null,
        Buffer.from(payloadDigest.slice(7), 'hex'),
        privateKey,
      ).toString('base64url'),
    },
  };
}

function verificationPolicy(signers, repositoryId, authoritativeRef) {
  const scopeOrder = [
    'adoptionAttemptChallenge',
    'adoptionAttestation',
    'refUpdateReceipt',
  ];
  return {
    schemaVersion: '1.0',
    policyId: 'm2-adoption-verification-policy',
    principals: scopeOrder.map((scope) => {
      const signer = signers[scope];
      return {
        principalRef: `https://axiolune.ai/principals/${scope}`,
        keyRef: `https://axiolune.ai/keys/${scope}-2026`,
        scope,
        repositoryId,
        authoritativeRef,
        algorithm: 'Ed25519',
        publicKeyEncoding: 'base64url-nopad',
        publicKey: signer.publicKey,
        publicKeyFingerprint: signer.publicKeyFingerprint,
        notBefore: '2026-07-01T00:00:00Z',
        notAfter: '2027-01-01T00:00:00Z',
        status: 'active',
      };
    }),
  };
}

function makeCheck(checkId, index) {
  const stem = `checks/${String(index).padStart(2, '0')}-${checkId}`;
  return {
    checkId,
    toolId: 'm2-adoption-verifier',
    capabilityId: `check.${checkId}`,
    capabilityRef: pathRef(`${stem}/capability.json`, 'sourceTree'),
    capabilityDigest: digest(`${checkId}:capability`),
    entrypointRef: pathRef('scripts/domain/run-m2-adoption-verifier.cjs', 'sourceTree'),
    entrypointDigest: sha256(fs.readFileSync(path.resolve(
      __dirname,
      '..',
      'run-m2-adoption-verifier.cjs',
    ))),
    discoveryContractRef: pathRef(`${stem}/discovery.json`, 'sourceTree'),
    discoveryContractDigest: digest(`${checkId}:discovery`),
    evidenceSchemaRef: pathRef(`${stem}/evidence.schema.json`, 'sourceTree'),
    evidenceSchemaDigest: digest(`${checkId}:evidence-schema`),
    subjectInventoryRef: pathRef(`${stem}/subject-inventory.json`),
    subjectInventoryDigest: digest(`${checkId}:subject-inventory`),
    counts: { discovered: 1, executed: 1, passed: 1, failed: 0 },
    evidenceRef: pathRef(`${stem}/evidence.json`),
    evidenceDigest: digest(`${checkId}:evidence`),
    status: 'passed',
  };
}

function checkBinding(check) {
  const fields = [
    'checkId', 'toolId', 'capabilityId',
    'capabilityRef', 'capabilityDigest',
    'entrypointRef', 'entrypointDigest',
    'discoveryContractRef', 'discoveryContractDigest',
    'evidenceSchemaRef', 'evidenceSchemaDigest',
  ];
  return Object.fromEntries(fields.map((field) => [field, structuredClone(check[field])]));
}

function makeNode(artifactRef, artifactDigestValue, artifactKind, phase, ordinal) {
  const node = {
    artifactId: '',
    artifactRef,
    artifactDigest: artifactDigestValue,
    artifactKind,
    phase,
    finalizationOrdinal: ordinal,
  };
  node.artifactId = artifactId(node);
  return node;
}

function buildFixture(overrides = {}) {
  const repositoryId = 'urn:axiolune:repository:m2';
  const authoritativeRef = 'refs/heads/release/m2-v0.3.0';
  const p0 = overrides.p0 || '1'.repeat(40);
  const p1 = overrides.p1 || '2'.repeat(40);
  const treeId = overrides.treeId || '3'.repeat(40);
  const sourceTreeDigest = overrides.sourceTreeDigest || digest('source-tree');
  const buildInputsDigest = digest('build-inputs');
  const refs = {
    challenge: pathRef('challenge.json'),
    approval: pathRef('approval.json'),
    adoptionReceipt: pathRef('adoption-receipt.json'),
    checkoutManifest: pathRef('adopted-checkout-manifest.json'),
    adoptionReport: pathRef('adoption-verification-report.json'),
    adoptionDependencyManifest: pathRef('adoption-artifact-dependency-manifest.json'),
  };
  const staticRefs = {
    payloadManifest: pathRef('payload-manifest.json', 'payload'),
    payloadVerificationReport: pathRef('payload-verification-report.json', 'payload'),
    eligibility: pathRef('approval-eligibility-report.json', 'payload'),
    verificationPolicy: pathRef('policies/verification-trust-policy.json', 'sourceTree'),
    decisionPolicy: pathRef('policies/decision-trust-policy.json', 'sourceTree'),
    p1SourceTreeManifest: pathRef('p1-source-tree-manifest.json', 'payload'),
    verifier: pathRef('scripts/domain/lib/m2-adoption-verifier.cjs', 'sourceTree'),
  };
  const signers = {
    adoptionAttemptChallenge: makeSigner('challenge'),
    adoptionAttestation: makeSigner('attestation'),
    refUpdateReceipt: makeSigner('receipt'),
    decision: makeSigner('decision'),
  };
  const verifyPolicy = verificationPolicy(signers, repositoryId, authoritativeRef);
  const verifyPolicyDigest = taggedJcsDigest(VERIFICATION_POLICY_TAG, verifyPolicy);
  const decisionPolicy = {
    schemaVersion: '1.0',
    policyId: 'm2-dri-policy',
    principals: [{
      driRef: 'https://axiolune.ai/principals/dri',
      keyRef: 'https://axiolune.ai/keys/dri-2026',
      algorithm: 'Ed25519',
      publicKeyEncoding: 'base64url-nopad',
      publicKey: signers.decision.publicKey,
      publicKeyFingerprint: signers.decision.publicKeyFingerprint,
      notBefore: '2026-07-01T00:00:00Z',
      notAfter: '2027-01-01T00:00:00Z',
      status: 'active',
    }],
  };
  const decisionPolicyDigest = taggedJcsDigest(
    'axiolune-decision-trust-policy-v1\0',
    decisionPolicy,
  );
  const challengeSigner = verifyPolicy.principals.find((row) => (
    row.scope === 'adoptionAttemptChallenge'
  ));
  const challengePayload = {
    challengeType: 'adoptionAttempt',
    challengeId: crypto.randomBytes(32).toString('base64url'),
    repositoryId,
    authoritativeRef,
    gitObjectFormat: 'sha1',
    expectedOldCommitId: p0,
    requestedNewCommitId: p1,
    payloadManifestRef: staticRefs.payloadManifest,
    payloadManifestDigest: digest('payload-manifest'),
    approvalEligibilityReportRef: staticRefs.eligibility,
    approvalEligibilityReportDigest: digest('approval-eligibility-report'),
    refEpoch: 7,
    attemptSequence: 11,
    issuedAt: '2026-08-01T00:00:00Z',
    expiresAt: '2026-08-01T00:10:00Z',
    verificationTrustPolicyRef: staticRefs.verificationPolicy,
    verificationTrustPolicyDigest: verifyPolicyDigest,
    coordinatorPrincipalRef: challengeSigner.principalRef,
    keyRef: challengeSigner.keyRef,
    publicKeyFingerprint: challengeSigner.publicKeyFingerprint,
    algorithm: 'Ed25519',
  };
  const challenge = signedEnvelope(
    challengePayload,
    CHALLENGE_PAYLOAD_TAG,
    'challengePayload',
    'challengePayloadDigest',
    signers.adoptionAttemptChallenge.privateKey,
  );
  const challengeDigest = taggedJcsDigest(CHALLENGE_ENVELOPE_TAG, challenge);

  const decisionRow = decisionPolicy.principals[0];
  const approvalPayload = {
    decisionType: 'releaseApproval',
    decision: 'approve',
    repositoryId,
    authoritativeRef,
    expectedOldCommitId: p0,
    gitObjectFormat: 'sha1',
    targetVersion: '0.3.0',
    payloadManifestRef: staticRefs.payloadManifest,
    payloadManifestDigest: challengePayload.payloadManifestDigest,
    payloadVerificationReportRef: staticRefs.payloadVerificationReport,
    payloadVerificationReportDigest: digest('payload-verification-report'),
    approvalEligibilityReportRef: staticRefs.eligibility,
    approvalEligibilityReportDigest: challengePayload.approvalEligibilityReportDigest,
    adoptionAttemptChallengeRef: refs.challenge,
    adoptionAttemptChallengeDigest: challengeDigest,
    challengeId: challengePayload.challengeId,
    refEpoch: challengePayload.refEpoch,
    attemptSequence: challengePayload.attemptSequence,
    prospectiveCommitId: p1,
    treeId,
    sourceTreeDigest,
    buildId: 'm2-build-20260801',
    buildInputsDigest,
    decisionTrustPolicyRef: staticRefs.decisionPolicy,
    decisionTrustPolicyDigest: decisionPolicyDigest,
    driRef: decisionRow.driRef,
    keyRef: decisionRow.keyRef,
    publicKeyFingerprint: decisionRow.publicKeyFingerprint,
    algorithm: 'Ed25519',
    decisionTime: '2026-08-01T00:01:00Z',
    rationale: 'Approve only the exact eligible P1 payload bound to this one attempt.',
  };
  const approval = signedEnvelope(
    approvalPayload,
    APPROVAL_PAYLOAD_TAG,
    'decisionPayload',
    'decisionPayloadDigest',
    signers.decision.privateKey,
  );
  const approvalDigest = artifactDigest(approval);

  const receiptSigner = verifyPolicy.principals.find((row) => (
    row.scope === 'refUpdateReceipt'
  ));
  const updater = {
    updaterToolId: 'm2-protected-ref-updater',
    updaterCapabilityId: 'performAuthorizedRefUpdate',
    updaterCapabilityRef: pathRef('capabilities/ref-updater.json', 'sourceTree'),
    updaterCapabilityDigest: digest('ref-updater-capability'),
    updaterEntrypointRef: pathRef('scripts/domain/run-protected-ref-updater.cjs', 'sourceTree'),
    updaterEntrypointDigest: digest('ref-updater-entrypoint'),
  };
  const receiptPayload = {
    receiptType: 'refUpdate',
    operationId: 'adoption-attempt-11',
    operationKind: 'adoption',
    repositoryId,
    authoritativeRef,
    gitObjectFormat: 'sha1',
    approvalEnvelopeRef: refs.approval,
    approvalEnvelopeDigest: approvalDigest,
    adoptionAttemptChallengeRef: refs.challenge,
    adoptionAttemptChallengeDigest: challengeDigest,
    challengeId: challengePayload.challengeId,
    refEpoch: challengePayload.refEpoch,
    attemptSequence: challengePayload.attemptSequence,
    expectedOldCommitId: p0,
    requestedNewCommitId: p1,
    expectedRefEpoch: challengePayload.refEpoch,
    ...updater,
    verificationTrustPolicyRef: staticRefs.verificationPolicy,
    verificationTrustPolicyDigest: verifyPolicyDigest,
    updaterPrincipalRef: receiptSigner.principalRef,
    keyRef: receiptSigner.keyRef,
    publicKeyFingerprint: receiptSigner.publicKeyFingerprint,
    algorithm: 'Ed25519',
    operationTime: '2026-08-01T00:02:00Z',
    result: {
      outcome: 'updated',
      observedBeforeCommitId: p0,
      observedAfterCommitId: p1,
      observedRefEpochBefore: 7,
      observedRefEpochAfter: 8,
      errors: [],
    },
  };
  const adoptionReceipt = signedEnvelope(
    receiptPayload,
    RECEIPT_PAYLOAD_TAG,
    'receiptPayload',
    'receiptPayloadDigest',
    signers.refUpdateReceipt.privateKey,
  );
  const receiptDigest = taggedJcsDigest(RECEIPT_ENVELOPE_TAG, adoptionReceipt);

  const sourceTreeFiles = overrides.sourceTreeFiles || [{
    mode: '100644',
    path: 'ontology/domain/finance/foundation/module.yaml',
    byteLength: 1234,
    artifactDigest: digest('foundation-module-bytes'),
  }];
  const checkoutManifest = {
    schemaVersion: '1.0',
    repositoryId,
    authoritativeRef,
    gitObjectFormat: 'sha1',
    commitId: p1,
    treeId,
    sourceTreeDigest,
    p1SourceTreeManifestRef: staticRefs.p1SourceTreeManifest,
    p1SourceTreeManifestDigest: overrides.p1SourceTreeManifestDigest
      || digest('p1-source-tree-manifest'),
    approvalEnvelopeRef: refs.approval,
    approvalEnvelopeDigest: approvalDigest,
    files: sourceTreeFiles,
    excludedAdministrativeRoot: '.git',
    untrackedPaths: [],
    extraEntryCount: 0,
  };
  const checkoutDigest = taggedJcsDigest(CHECKOUT_MANIFEST_TAG, checkoutManifest);

  const coordinatorState = {
    schemaVersion: '1.0',
    repositoryId,
    authoritativeRef,
    challengeId: challengePayload.challengeId,
    challengeDigest,
    attemptSequence: challengePayload.attemptSequence,
    initialRefEpoch: challengePayload.refEpoch,
    currentRefEpoch: receiptPayload.result.observedRefEpochAfter,
    currentCommitId: p1,
    state: 'consumed',
    preparedOperation: {
      operationKind: 'adoption',
      approvalEnvelopeDigest: approvalDigest,
      expectedOldCommitId: p0,
      requestedNewCommitId: p1,
      expectedRefEpoch: challengePayload.refEpoch,
    },
    consumedAdoptionReceiptDigest: receiptDigest,
    querySequence: 23,
  };
  const coordinatorStateDigest = taggedJcsDigest(COORDINATOR_STATE_TAG, coordinatorState);
  const checks = RELEASE_CHECK_IDS.adoptionVerification.map(makeCheck);
  const checkBindings = checks.map(checkBinding);
  const verifier = {
    verifierRef: staticRefs.verifier,
    verifierDigest: sha256(fs.readFileSync(path.resolve(
      __dirname,
      '..',
      'lib',
      'm2-adoption-verifier.cjs',
    ))),
  };
  const adoptionReport = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    targetVersion: '0.3.0',
    approvalEnvelopeRef: refs.approval,
    approvalEnvelopeDigest: approvalDigest,
    approvalEligibilityReportRef: staticRefs.eligibility,
    approvalEligibilityReportDigest: challengePayload.approvalEligibilityReportDigest,
    adoptionAttemptChallengeRef: refs.challenge,
    adoptionAttemptChallengeDigest: challengeDigest,
    challengeId: challengePayload.challengeId,
    refEpoch: challengePayload.refEpoch,
    attemptSequence: challengePayload.attemptSequence,
    repositoryId,
    authoritativeRef,
    gitObjectFormat: 'sha1',
    expectedOldCommitId: p0,
    expectedCommitId: p1,
    expectedTreeId: treeId,
    expectedSourceTreeDigest: sourceTreeDigest,
    adoptionReceiptRef: refs.adoptionReceipt,
    adoptionReceiptDigest: receiptDigest,
    ...verifier,
    coordinatorStateDigest,
    observedRefEpoch: coordinatorState.currentRefEpoch,
    reportTime: '2026-08-01T00:03:00Z',
    result: {
      outcome: 'adopted',
      observedCommitId: p1,
      observedTreeId: treeId,
      observedSourceTreeDigest: sourceTreeDigest,
      adoptedCheckoutManifestRef: refs.checkoutManifest,
      adoptedCheckoutManifestDigest: checkoutDigest,
      checks,
      errors: [],
    },
  };
  const reportDigest = taggedJcsDigest(ADOPTION_REPORT_TAG, adoptionReport);
  const nodes = [
    makeNode(refs.challenge, challengeDigest, 'adoptionAttemptChallenge', 'adoptionAttemptChallenge', 0),
    makeNode(refs.approval, approvalDigest, 'releaseApproval', 'releaseApproval', 0),
    makeNode(refs.adoptionReceipt, receiptDigest, 'adoptionRefUpdateReceipt', 'adoptionRefUpdate', 0),
    makeNode(refs.checkoutManifest, checkoutDigest, 'adoptedCheckoutManifest', 'adoptedCheckout', 0),
    makeNode(refs.adoptionReport, reportDigest, 'adoptionVerification', 'adoptionVerification', 0),
  ].sort((left, right) => Buffer.compare(
    Buffer.from(left.artifactId, 'utf8'),
    Buffer.from(right.artifactId, 'utf8'),
  ));
  const reportNode = nodes.find((row) => row.artifactKind === 'adoptionVerification');
  const nodeByKind = new Map(nodes.map((row) => [row.artifactKind, row]));
  const dependencyEdges = [
    ['adoptionAttemptChallenge', 'releaseApproval', 'signed-challenge'],
    ['releaseApproval', 'adoptionRefUpdateReceipt', 'signed-approval'],
    ['adoptionRefUpdateReceipt', 'adoptedCheckoutManifest', 'adoption-receipt'],
    ['adoptedCheckoutManifest', 'adoptionVerification', 'verified-checkout'],
  ].map(([prerequisiteKind, dependentKind, value]) => ({
    prerequisiteArtifactId: nodeByKind.get(prerequisiteKind).artifactId,
    dependentArtifactId: nodeByKind.get(dependentKind).artifactId,
    locator: { locatorKind: 'derivedInput', value },
  })).sort((left, right) => Buffer.compare(
    Buffer.from([
      left.dependentArtifactId,
      left.prerequisiteArtifactId,
      left.locator.locatorKind,
      left.locator.value,
    ].join('\0'), 'utf8'),
    Buffer.from([
      right.dependentArtifactId,
      right.prerequisiteArtifactId,
      right.locator.locatorKind,
      right.locator.value,
    ].join('\0'), 'utf8'),
  ));
  const adoptionDependencyManifest = {
    schemaVersion: '1.0',
    scope: 'adoption',
    phaseRegistryRef: pathRef('policies/artifact-phase-registry.json', 'sourceTree'),
    phaseRegistryDigest: digest('phase-registry'),
    extractorCapabilityRef: pathRef('capabilities/adoption-dependency-extractor.json', 'sourceTree'),
    extractorCapabilityDigest: digest('adoption-dependency-extractor'),
    adoptionAttemptChallengeRef: refs.challenge,
    adoptionAttemptChallengeDigest: challengeDigest,
    challengeId: challengePayload.challengeId,
    refEpoch: challengePayload.refEpoch,
    attemptSequence: challengePayload.attemptSequence,
    roots: [reportNode.artifactId],
    nodes,
    edges: dependencyEdges,
  };
  const dependencyDigest = taggedJcsDigest(
    ADOPTION_DEPENDENCY_MANIFEST_TAG,
    adoptionDependencyManifest,
  );

  const attestationSigner = verifyPolicy.principals.find((row) => (
    row.scope === 'adoptionAttestation'
  ));
  const attestationPayload = {
    attestationType: 'adoptionVerification',
    result: 'adopted',
    repositoryId,
    authoritativeRef,
    gitObjectFormat: 'sha1',
    targetVersion: '0.3.0',
    expectedOldCommitId: p0,
    expectedCommitId: p1,
    expectedTreeId: treeId,
    expectedSourceTreeDigest: sourceTreeDigest,
    adoptionAttemptChallengeRef: refs.challenge,
    adoptionAttemptChallengeDigest: challengeDigest,
    challengeId: challengePayload.challengeId,
    refEpoch: challengePayload.refEpoch,
    attemptSequence: challengePayload.attemptSequence,
    attestedRefCommitId: p1,
    adoptionReceiptRef: refs.adoptionReceipt,
    adoptionReceiptDigest: receiptDigest,
    adoptionVerificationReportRef: refs.adoptionReport,
    adoptionVerificationReportDigest: reportDigest,
    adoptionArtifactDependencyManifestRef: refs.adoptionDependencyManifest,
    adoptionArtifactDependencyManifestDigest: dependencyDigest,
    coordinatorStateDigest,
    observedRefEpoch: coordinatorState.currentRefEpoch,
    verificationTrustPolicyRef: staticRefs.verificationPolicy,
    verificationTrustPolicyDigest: verifyPolicyDigest,
    verifierPrincipalRef: attestationSigner.principalRef,
    keyRef: attestationSigner.keyRef,
    publicKeyFingerprint: attestationSigner.publicKeyFingerprint,
    algorithm: 'Ed25519',
    attestationTime: '2026-08-01T00:04:00Z',
  };
  const attestation = signedEnvelope(
    attestationPayload,
    ATTESTATION_PAYLOAD_TAG,
    'attestationPayload',
    'attestationPayloadDigest',
    signers.adoptionAttestation.privateKey,
  );
  const expected = {
    repositoryId,
    authoritativeRef,
    gitObjectFormat: 'sha1',
    expectedOldCommitId: p0,
    requestedNewCommitId: p1,
    payloadManifestRef: staticRefs.payloadManifest,
    payloadManifestDigest: challengePayload.payloadManifestDigest,
    approvalEligibilityReportRef: staticRefs.eligibility,
    approvalEligibilityReportDigest: challengePayload.approvalEligibilityReportDigest,
    verificationTrustPolicyRef: staticRefs.verificationPolicy,
    verificationTrustPolicyDigest: verifyPolicyDigest,
    targetVersion: '0.3.0',
    payloadVerificationReportRef: staticRefs.payloadVerificationReport,
    payloadVerificationReportDigest: approvalPayload.payloadVerificationReportDigest,
    treeId,
    sourceTreeDigest,
    buildId: approvalPayload.buildId,
    buildInputsDigest,
    decisionTrustPolicyRef: staticRefs.decisionPolicy,
    decisionTrustPolicyDigest: decisionPolicyDigest,
    updater,
    sourceTreeFiles,
    p1SourceTreeManifestRef: staticRefs.p1SourceTreeManifest,
    p1SourceTreeManifestDigest: checkoutManifest.p1SourceTreeManifestDigest,
    verifier,
    checkBindings,
  };
  return {
    adoptionDependencyManifest,
    adoptionReceipt,
    adoptionReport,
    approval,
    attestation,
    authoritativeRefObservation: p1,
    challenge,
    checkoutManifest,
    coordinatorState,
    decisionPolicy,
    decisionTrustPolicy: decisionPolicy,
    eligibility: {
      eligible: true,
      reportRef: staticRefs.eligibility,
      reportDigest: challengePayload.approvalEligibilityReportDigest,
    },
    expected,
    refs,
    recomputedAdoptionDependencyManifest: structuredClone(adoptionDependencyManifest),
    signers,
    verificationTrustPolicy: verifyPolicy,
    verifiedChecks: new Map(checks.map((row) => [row.checkId, structuredClone(row)])),
  };
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function terminalGitFixture(t) {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-terminal-repo-'));
  const checkoutParent = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-terminal-checkout-'));
  const checkoutRoot = path.join(checkoutParent, 'checkout');
  t.after(() => {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
    fs.rmSync(checkoutParent, { recursive: true, force: true });
  });
  git(repositoryRoot, ['init', '--object-format=sha1']);
  git(repositoryRoot, ['config', 'user.name', 'Terminal Adoption Test']);
  git(repositoryRoot, ['config', 'user.email', 'terminal-adoption@example.invalid']);
  git(repositoryRoot, ['config', 'core.autocrlf', 'false']);
  const modulePath = path.join(
    repositoryRoot,
    'ontology',
    'domain',
    'finance',
    'foundation',
    'module.yaml',
  );
  const componentPath = path.join(
    repositoryRoot,
    'scripts',
    'domain',
    'lib',
    'm2-adoption-verifier.cjs',
  );
  const adoptionEntrypointPath = path.join(
    repositoryRoot,
    'scripts',
    'domain',
    'run-m2-adoption-verifier.cjs',
  );
  const updaterEntrypointPath = path.join(
    repositoryRoot,
    'scripts',
    'domain',
    'run-protected-ref-updater.cjs',
  );
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.mkdirSync(path.dirname(componentPath), { recursive: true });
  fs.writeFileSync(modulePath, 'status: review\n');
  fs.copyFileSync(path.resolve(__dirname, '..', 'lib', 'm2-adoption-verifier.cjs'), componentPath);
  fs.copyFileSync(
    path.resolve(__dirname, '..', 'run-m2-adoption-verifier.cjs'),
    adoptionEntrypointPath,
  );
  fs.writeFileSync(updaterEntrypointPath, 'ref-updater-entrypoint');
  git(repositoryRoot, ['add', '.']);
  git(repositoryRoot, ['commit', '-m', 'P0 review']);
  const p0 = git(repositoryRoot, ['rev-parse', 'HEAD']);
  fs.writeFileSync(modulePath, 'status: approved\n');
  git(repositoryRoot, ['add', '.']);
  git(repositoryRoot, ['commit', '-m', 'P1 approved candidate']);
  const p1 = git(repositoryRoot, ['rev-parse', 'HEAD']);
  const commit = inspectCommit(repositoryRoot, p1, 'sha1');
  const sourceTree = buildSourceTreeManifest(repositoryRoot, commit.treeId, 'sha1');
  const authoritativeRef = 'refs/heads/release/m2-v0.3.0';
  git(repositoryRoot, ['update-ref', authoritativeRef, p1]);
  const clone = spawnSync('git', [
    '-c', 'core.autocrlf=false',
    'clone', '--no-local', repositoryRoot, checkoutRoot,
  ], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(clone.status, 0, clone.stderr || clone.error?.message);
  git(checkoutRoot, ['config', 'core.autocrlf', 'false']);
  git(checkoutRoot, ['checkout', '--detach', p1]);
  git(checkoutRoot, ['reset', '--hard', p1]);
  return {
    authoritativeRef,
    checkoutRoot,
    p0,
    p1,
    repositoryRoot,
    sourceTree,
    treeId: commit.treeId,
  };
}

function dependencyPhase(label) {
  if (label === 'payload manifest') return ['payloadManifest', 'payload'];
  if (label === 'payload verification report') {
    return ['payloadVerificationReport', 'payloadVerification'];
  }
  if (label === 'approval eligibility report') {
    return ['approvalEligibilityReport', 'approvalEligibility'];
  }
  if (label === 'P1 source-tree manifest') return ['p1SourceTreeManifest', 'p1Build'];
  if (label.startsWith('check ') && (label.endsWith(' evidence')
      || label.endsWith(' subjectInventory'))) {
    return ['adoptionCheckEvidence', 'adoptionCheck'];
  }
  return ['staticArtifact', 'static'];
}

function closeTerminalDependencyFixture(fixture) {
  const manifest = structuredClone(fixture.adoptionDependencyManifest);
  const nodeByPair = new Map(manifest.nodes.map((node) => [
    `${JSON.stringify(node.artifactRef)}\0${node.artifactDigest}`,
    node,
  ]));
  const reportNode = manifest.nodes.find((node) => node.artifactKind === 'adoptionVerification');
  let added = 0;
  for (const pair of collectTerminalRequiredPairs(fixture)) {
    const key = `${JSON.stringify(pair.artifactRef)}\0${pair.artifactDigest}`;
    if (nodeByPair.has(key)) continue;
    const [artifactKind, phase] = dependencyPhase(pair.label);
    const node = makeNode(pair.artifactRef, pair.artifactDigest, artifactKind, phase, 0);
    manifest.nodes.push(node);
    nodeByPair.set(key, node);
    manifest.edges.push({
      prerequisiteArtifactId: node.artifactId,
      dependentArtifactId: reportNode.artifactId,
      locator: { locatorKind: 'derivedInput', value: `terminal-required-${added}` },
    });
    added += 1;
  }
  manifest.nodes.sort((left, right) => Buffer.compare(
    Buffer.from(left.artifactId, 'utf8'),
    Buffer.from(right.artifactId, 'utf8'),
  ));
  manifest.edges.sort((left, right) => Buffer.compare(
    Buffer.from([
      left.dependentArtifactId,
      left.prerequisiteArtifactId,
      left.locator.locatorKind,
      left.locator.value,
    ].join('\0'), 'utf8'),
    Buffer.from([
      right.dependentArtifactId,
      right.prerequisiteArtifactId,
      right.locator.locatorKind,
      right.locator.value,
    ].join('\0'), 'utf8'),
  ));
  fixture.adoptionDependencyManifest = manifest;
  fixture.recomputedAdoptionDependencyManifest = structuredClone(manifest);
  fixture.attestation.attestationPayload.adoptionArtifactDependencyManifestDigest
    = taggedJcsDigest(ADOPTION_DEPENDENCY_MANIFEST_TAG, manifest);
  fixture.attestation = signedEnvelope(
    fixture.attestation.attestationPayload,
    ATTESTATION_PAYLOAD_TAG,
    'attestationPayload',
    'attestationPayloadDigest',
    fixture.signers.adoptionAttestation.privateKey,
  );
  return fixture;
}

function terminalFixture(t, options = {}) {
  const gitFixture = terminalGitFixture(t);
  const sourceTreeFiles = gitFixture.sourceTree.files.map((row) => ({
    mode: row.mode,
    path: row.path,
    byteLength: row.byteLength,
    artifactDigest: row.artifactDigest,
  }));
  const evidence = buildFixture({
    p0: gitFixture.p0,
    p1: gitFixture.p1,
    treeId: gitFixture.treeId,
    sourceTreeDigest: gitFixture.sourceTree.sourceTreeDigest,
    sourceTreeFiles,
    p1SourceTreeManifestDigest: gitFixture.sourceTree.sourceTreeManifestDigest,
  });
  if (options.closeDependency !== false) closeTerminalDependencyFixture(evidence);
  const freshCoordinatorState = structuredClone(evidence.coordinatorState);
  freshCoordinatorState.querySequence += 1;
  const runtimeClosure = currentRuntimeClosure();
  return {
    evidence,
    gitFixture,
    freshCoordinatorState,
    options: {
      runtimeRoot: WORKSPACE_ROOT,
      runtimeClosure: structuredClone(runtimeClosure.manifest),
      repositoryRoot: gitFixture.repositoryRoot,
      checkoutRoot: gitFixture.checkoutRoot,
      evidence,
      decisionTrustPolicy: evidence.decisionTrustPolicy,
      verificationTrustPolicy: evidence.verificationTrustPolicy,
      readCoordinatorState: () => structuredClone(freshCoordinatorState),
      trustedPins: {
        schemaVersion: '1.0',
        repositoryId: evidence.expected.repositoryId,
        authoritativeRef: evidence.expected.authoritativeRef,
        gitObjectFormat: 'sha1',
        expectedOldCommitId: gitFixture.p0,
        expectedCommitId: gitFixture.p1,
        expectedTreeId: gitFixture.treeId,
        expectedSourceTreeDigest: gitFixture.sourceTree.sourceTreeDigest,
        payloadManifestDigest: evidence.expected.payloadManifestDigest,
        approvalEligibilityReportDigest:
          evidence.expected.approvalEligibilityReportDigest,
        decisionTrustPolicyDigest: evidence.expected.decisionTrustPolicyDigest,
        verificationTrustPolicyDigest:
          evidence.expected.verificationTrustPolicyDigest,
        terminalRuntimeClosureDigest: runtimeClosure.digest,
      },
    },
  };
}

test('verifies chain components without escalating caller-supplied state to terminal approval', () => {
  const fixture = buildFixture();
  const result = verifyAdoptedEvidenceChain(fixture);
  assert.equal(result.outcome, 'component-verified');
  assert.equal(result.approvalStatus, 'not-approved');
  assert.equal(result.adoptionStatus, 'not-terminally-verified');
  assert.equal(result.releaseComplete, false);
  assert.equal(result.terminalVerificationRequired, true);
});

test('challenge schema, digest, randomness width, and scoped signer are fail-closed', () => {
  const fixture = buildFixture();
  const unknown = structuredClone(fixture.challenge);
  unknown.challengePayload.callerSelectedDigest = digest('forged');
  assert.throws(
    () => verifyAdoptionAttemptChallenge({
      challenge: unknown,
      verificationTrustPolicy: fixture.verificationTrustPolicy,
      expected: fixture.expected,
    }),
    /closed schema/u,
  );

  const shortId = structuredClone(fixture.challenge);
  shortId.challengePayload.challengeId = Buffer.alloc(16).toString('base64url');
  assert.throws(
    () => verifyAdoptionAttemptChallenge({
      challenge: shortId,
      verificationTrustPolicy: fixture.verificationTrustPolicy,
      expected: fixture.expected,
    }),
    /exactly 32 bytes/u,
  );
});

test('re-signed approval outside the challenge window is rejected semantically', () => {
  const fixture = buildFixture();
  const challengeVerification = verifyAdoptionAttemptChallenge({
    challenge: fixture.challenge,
    verificationTrustPolicy: fixture.verificationTrustPolicy,
    expected: fixture.expected,
  });
  const changedPayload = structuredClone(fixture.approval.decisionPayload);
  changedPayload.decisionTime = fixture.challenge.challengePayload.expiresAt;
  const resigned = signedEnvelope(
    changedPayload,
    APPROVAL_PAYLOAD_TAG,
    'decisionPayload',
    'decisionPayloadDigest',
    fixture.signers.decision.privateKey,
  );
  assert.throws(
    () => verifyApprovalEnvelope({
      approval: resigned,
      challengeVerification,
      challengeRef: fixture.refs.challenge,
      decisionTrustPolicy: fixture.decisionPolicy,
      expectedDecisionTrustPolicyRef: fixture.expected.decisionTrustPolicyRef,
      expected: fixture.expected,
    }),
    /strict challenge window/u,
  );
});

test('re-signed receipt cannot fake the protected epoch transition', () => {
  const fixture = buildFixture();
  const challengeVerification = verifyAdoptionAttemptChallenge({
    challenge: fixture.challenge,
    verificationTrustPolicy: fixture.verificationTrustPolicy,
    expected: fixture.expected,
  });
  const approvalVerification = verifyApprovalEnvelope({
    approval: fixture.approval,
    challengeVerification,
    challengeRef: fixture.refs.challenge,
    decisionTrustPolicy: fixture.decisionPolicy,
    expectedDecisionTrustPolicyRef: fixture.expected.decisionTrustPolicyRef,
    expected: fixture.expected,
  });
  const changedPayload = structuredClone(fixture.adoptionReceipt.receiptPayload);
  changedPayload.result.observedRefEpochAfter += 2;
  const resigned = signedEnvelope(
    changedPayload,
    RECEIPT_PAYLOAD_TAG,
    'receiptPayload',
    'receiptPayloadDigest',
    fixture.signers.refUpdateReceipt.privateKey,
  );
  assert.throws(
    () => verifyAdoptionReceipt({
      receipt: resigned,
      receiptRef: fixture.refs.adoptionReceipt,
      approvalVerification,
      approvalRef: fixture.refs.approval,
      challengeVerification,
      challengeRef: fixture.refs.challenge,
      verificationTrustPolicy: fixture.verificationTrustPolicy,
      expectedUpdater: fixture.expected.updater,
    }),
    /exact old\/new commit and epoch transition/u,
  );
});

test('coordinator receipt substitution, missing checks, and dependency replay drift are rejected', () => {
  const fixture = buildFixture();
  const challengeVerification = verifyAdoptionAttemptChallenge({
    challenge: fixture.challenge,
    verificationTrustPolicy: fixture.verificationTrustPolicy,
    expected: fixture.expected,
  });
  const approvalVerification = verifyApprovalEnvelope({
    approval: fixture.approval,
    challengeVerification,
    challengeRef: fixture.refs.challenge,
    decisionTrustPolicy: fixture.decisionPolicy,
    expectedDecisionTrustPolicyRef: fixture.expected.decisionTrustPolicyRef,
    expected: fixture.expected,
  });
  const receiptVerification = verifyAdoptionReceipt({
    receipt: fixture.adoptionReceipt,
    receiptRef: fixture.refs.adoptionReceipt,
    approvalVerification,
    approvalRef: fixture.refs.approval,
    challengeVerification,
    challengeRef: fixture.refs.challenge,
    verificationTrustPolicy: fixture.verificationTrustPolicy,
    expectedUpdater: fixture.expected.updater,
  });
  const substituted = structuredClone(fixture.coordinatorState);
  substituted.consumedAdoptionReceiptDigest = digest('other-receipt');
  assert.throws(
    () => validateCoordinatorConsumedState({
      state: substituted,
      challengeVerification,
      approvalVerification,
      receiptVerification,
    }),
    /consumedAdoptionReceiptDigest/u,
  );

  const missingCheck = buildFixture();
  missingCheck.adoptionReport.result.checks.pop();
  assert.throws(
    () => verifyAdoptedEvidenceChain(missingCheck),
    /exact adoption check inventory/u,
  );

  const dependencyDrift = structuredClone(fixture.adoptionDependencyManifest);
  dependencyDrift.edges.push({
    prerequisiteArtifactId: dependencyDrift.nodes[0].artifactId,
    dependentArtifactId: dependencyDrift.nodes.at(-1).artifactId,
    locator: { locatorKind: 'derivedInput', value: 'caller-injected' },
  });
  assert.throws(
    () => verifyAdoptionDependencyManifest({
      manifest: dependencyDrift,
      manifestRef: fixture.refs.adoptionDependencyManifest,
      reportVerification: {
        reportRef: fixture.refs.adoptionReport,
        reportDigest: taggedJcsDigest(ADOPTION_REPORT_TAG, fixture.adoptionReport),
      },
      challengeVerification,
      challengeRef: fixture.refs.challenge,
      recomputedManifest: fixture.recomputedAdoptionDependencyManifest,
      requiredArtifactPairs: [],
    }),
    /replay/u,
  );

  const invalidNodeId = structuredClone(fixture.adoptionDependencyManifest);
  invalidNodeId.nodes[0].artifactDigest = digest('node-digest-substitution');
  assert.throws(
    () => verifyAdoptionDependencyManifest({
      manifest: invalidNodeId,
      manifestRef: fixture.refs.adoptionDependencyManifest,
      reportVerification: {
        reportRef: fixture.refs.adoptionReport,
        reportDigest: taggedJcsDigest(ADOPTION_REPORT_TAG, fixture.adoptionReport),
      },
      challengeVerification,
      challengeRef: fixture.refs.challenge,
      recomputedManifest: structuredClone(invalidNodeId),
      requiredArtifactPairs: [],
    }),
    /artifactId does not recompute/u,
  );

  const orphaned = structuredClone(fixture.adoptionDependencyManifest);
  orphaned.nodes.push(makeNode(
    pathRef('orphan.json'),
    digest('orphan'),
    'orphanEvidence',
    'static',
    0,
  ));
  orphaned.nodes.sort((left, right) => Buffer.compare(
    Buffer.from(left.artifactId, 'utf8'),
    Buffer.from(right.artifactId, 'utf8'),
  ));
  assert.throws(
    () => verifyAdoptionDependencyManifest({
      manifest: orphaned,
      manifestRef: fixture.refs.adoptionDependencyManifest,
      reportVerification: {
        reportRef: fixture.refs.adoptionReport,
        reportDigest: taggedJcsDigest(ADOPTION_REPORT_TAG, fixture.adoptionReport),
      },
      challengeVerification,
      challengeRef: fixture.refs.challenge,
      recomputedManifest: structuredClone(orphaned),
      requiredArtifactPairs: [],
    }),
    /unreachable\/orphan/u,
  );
});

test('terminal attestation requires the adjacent protected ref observation', () => {
  const fixture = buildFixture();
  assert.throws(
    () => verifyAdoptedEvidenceChain({
      ...fixture,
      authoritativeRefObservation: fixture.expected.expectedOldCommitId,
    }),
    /adjacent authoritative-ref observation/u,
  );
});

test('terminal bootstrap rejects coherent dependency tampering before modified code executes', async (t) => {
  const targets = [
    'scripts/domain/lib/m2-adoption-verifier.cjs',
    'scripts/domain/lib/m2-ed25519.cjs',
    'scripts/domain/lib/m2-git-replay.cjs',
  ];
  for (const target of targets) {
    await t.test(target, (subtest) => {
      const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-terminal-tcb-'));
      const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-terminal-tcb-authority-'));
      const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-terminal-tcb-repo-'));
      const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-terminal-tcb-checkout-'));
      subtest.after(() => {
        for (const root of [runtimeRoot, externalRoot, repositoryRoot, checkoutRoot]) {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
      for (const relativePath of REQUIRED_RUNTIME_PATHS) {
        const destination = path.join(runtimeRoot, ...relativePath.split('/'));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(WORKSPACE_ROOT, ...relativePath.split('/')), destination);
      }
      const manifest = buildTerminalRuntimeClosureManifest(runtimeRoot);
      const closurePath = path.join(externalRoot, 'runtime-closure.json');
      writeCanonicalJson(closurePath, manifest);
      const marker = path.join(externalRoot, 'modified-module-executed.txt');
      const targetPath = path.join(runtimeRoot, ...target.split('/'));
      const original = fs.readFileSync(targetPath, 'utf8');
      fs.writeFileSync(
        targetPath,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n${original}`,
      );
      const configPath = path.join(externalRoot, 'config.json');
      writeCanonicalJson(configPath, {
        schemaVersion: '1.0',
        runtimeRoot,
        runtimeClosurePath: closurePath,
        bundlePath: path.join(externalRoot, 'absent-bundle.json'),
        repositoryRoot,
        checkoutRoot,
        coordinatorStatePath: path.join(externalRoot, 'absent-state.json'),
        decisionTrustPolicyPath: path.join(externalRoot, 'absent-decision.json'),
        verificationTrustPolicyPath: path.join(externalRoot, 'absent-verification.json'),
        trustedPins: {
          terminalRuntimeClosureDigest: terminalRuntimeClosureDigest(manifest),
        },
      });
      const cli = path.join(
        runtimeRoot,
        'scripts',
        'domain',
        'run-m2-adoption-verifier.cjs',
      );
      const result = spawnSync(process.execPath, [cli, '--config', configPath], {
        cwd: runtimeRoot,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      });
      assert.equal(result.status, 1, result.stderr || result.error?.message);
      assert.equal(fs.existsSync(marker), false, `${target} executed before its digest check`);
      const diagnostic = JSON.parse(result.stdout);
      assert.match(diagnostic.issues[0].message, /runtime or Node executable bytes differ/u);
    });
  }
});

test('terminal verifier reconstructs P1 Git/tree/checkout and closes the signed authority chain', (t) => {
  const fixture = terminalFixture(t);
  const result = verifyTerminalAdoption(fixture.options);
  assert.equal(result.verificationScope, 'terminal-adoption');
  assert.equal(result.outcome, 'adopted');
  assert.equal(result.approvalStatus, 'approved');
  assert.equal(result.adoptionStatus, 'verified');
  assert.equal(result.releaseComplete, true);
  assert.equal(result.adoptedCommitId, fixture.gitFixture.p1);
  assert.equal(result.authoritativeRefObservation, fixture.gitFixture.p1);
  assert.equal(result.checkoutFileCount, fixture.gitFixture.sourceTree.files.length);
  assert.ok(result.dependencyRequiredPairCount > 20);
});

test('terminal verifier rejects a moved authoritative ref and a dirty isolated checkout', (t) => {
  const moved = terminalFixture(t);
  git(moved.gitFixture.repositoryRoot, [
    'update-ref',
    moved.gitFixture.authoritativeRef,
    moved.gitFixture.p0,
  ]);
  assert.throws(
    () => verifyTerminalAdoption(moved.options),
    /authoritative ref does not currently equal/u,
  );

  const dirty = terminalFixture(t);
  fs.writeFileSync(path.join(dirty.gitFixture.checkoutRoot, 'untracked.txt'), 'not adopted\n');
  assert.throws(
    () => verifyTerminalAdoption(dirty.options),
    /extra file|byte inventory/u,
  );
});

test('terminal verifier rejects stale coordinator authority and out-of-band pin substitution', (t) => {
  const coordinator = terminalFixture(t);
  coordinator.freshCoordinatorState.currentRefEpoch += 1;
  assert.throws(
    () => verifyTerminalAdoption(coordinator.options),
    /fresh protected coordinator state.currentRefEpoch/u,
  );

  const notFresh = terminalFixture(t);
  notFresh.freshCoordinatorState.querySequence
    = notFresh.evidence.coordinatorState.querySequence;
  assert.throws(
    () => verifyTerminalAdoption(notFresh.options),
    /querySequence did not advance/u,
  );

  const pin = terminalFixture(t);
  pin.options.trustedPins.payloadManifestDigest = digest('substituted-payload');
  assert.throws(
    () => verifyTerminalAdoption(pin.options),
    /payload manifest|independently trusted value/u,
  );

  const nodeRuntime = terminalFixture(t);
  nodeRuntime.options.runtimeClosure.nodeRuntime.version = 'v0.0.0-tampered';
  nodeRuntime.options.trustedPins.terminalRuntimeClosureDigest
    = terminalRuntimeClosureDigest(nodeRuntime.options.runtimeClosure);
  assert.throws(
    () => verifyTerminalAdoption(nodeRuntime.options),
    /runtime or Node executable bytes differ/u,
  );
});

test('terminal verifier refuses a signed but dependency-incomplete adoption graph', (t) => {
  const fixture = terminalFixture(t, { closeDependency: false });
  assert.throws(
    () => verifyTerminalAdoption(fixture.options),
    /dependency manifest omits/u,
  );
});

test('release lifecycle reaches approved only through an external terminal runtime', (t) => {
  const fixture = terminalFixture(t);
  const eligibility = {
    verificationScope: 'post-payload-approval-eligibility',
    eligible: true,
    approvalStatus: 'not-approved',
    adoptionStatus: 'not-verified',
    releaseComplete: false,
  };
  const candidateOwned = assessM2ReleaseLifecycle(eligibility, fixture.options);
  assert.equal(candidateOwned.status, 'pending');
  assert.equal(candidateOwned.code, 'M2_RELEASE_ADOPTION_NOT_ESTABLISHED');
  const external = externalTerminalConfig(t, fixture);
  const externalResult = assessM2ReleaseLifecycle(eligibility, {
    externalConfigPath: external.configPath,
    externalRuntimeRoot: external.runtimeRoot,
    expectedApprovalEligibilityReportDigest:
      fixture.options.trustedPins.approvalEligibilityReportDigest,
    expectedRepositoryId: fixture.options.trustedPins.repositoryId,
    expectedAuthoritativeRef: fixture.options.trustedPins.authoritativeRef,
    expectedOldCommitId: fixture.options.trustedPins.expectedOldCommitId,
    expectedDecisionTrustPolicyDigest:
      fixture.options.trustedPins.decisionTrustPolicyDigest,
    expectedVerificationTrustPolicyDigest:
      fixture.options.trustedPins.verificationTrustPolicyDigest,
    expectedTerminalRuntimeClosureDigest:
      fixture.options.trustedPins.terminalRuntimeClosureDigest,
  });
  assert.equal(externalResult.status, 'adopted');
  assert.equal(externalResult.terminalRuntimeClosureDigest,
    fixture.options.trustedPins.terminalRuntimeClosureDigest);

  const forgedDiagnostic = assessM2ReleaseLifecycle(eligibility, {
    verificationScope: 'terminal-adoption',
    outcome: 'adopted',
    approvalStatus: 'approved',
    adoptionStatus: 'verified',
    releaseComplete: true,
  });
  assert.equal(forgedDiagnostic.status, 'pending');
  assert.equal(forgedDiagnostic.code, 'M2_RELEASE_ADOPTION_NOT_ESTABLISHED');
});
