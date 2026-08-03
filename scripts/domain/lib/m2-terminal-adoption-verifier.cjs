'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalJcs,
  sha256,
  verifyTerminalRuntimeClosure,
} = require('./m2-terminal-runtime-closure.cjs');

// Local cryptographic, Git, and component-verifier dependencies are loaded
// only after the externally pinned runtime closure has been measured.  This is
// intentional: a digest check performed after require() would allow modified
// module initialization code to execute before the trust boundary was checked.
let verifyAdoptedEvidenceChain;
let DECISION_POLICY_TAG;
let VERIFICATION_POLICY_TAG;
let validateDecisionTrustPolicy;
let validateVerificationTrustPolicy;
let buildSourceTreeManifest;
let inspectCommit;
let repositoryObjectFormat;
let runGit;
let trustedGitRuntimeIdentity;
let runtimeDependenciesLoaded = false;

function loadMeasuredRuntimeDependencies() {
  if (runtimeDependenciesLoaded) return;
  ({
    verifyAdoptedEvidenceChain,
  } = require('./m2-adoption-verifier.cjs'));
  ({
    DECISION_POLICY_TAG,
    VERIFICATION_POLICY_TAG,
    validateDecisionTrustPolicy,
    validateVerificationTrustPolicy,
  } = require('./m2-ed25519.cjs'));
  ({
    buildSourceTreeManifest,
    inspectCommit,
    repositoryObjectFormat,
    runGit,
    trustedGitRuntimeIdentity,
  } = require('./m2-git-replay.cjs'));
  runtimeDependenciesLoaded = true;
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

const TERMINAL_VERIFIER_ID = 'm2-terminal-adoption-verifier';
const TERMINAL_SCOPE = 'terminal-adoption';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const GIT_ID_RES = Object.freeze({
  sha1: /^[0-9a-f]{40}$/u,
  sha256: /^[0-9a-f]{64}$/u,
});
const TERMINAL_VERIFIER_SOURCE = __filename;
const COMPONENT_VERIFIER_SOURCE = path.resolve(__dirname, 'm2-adoption-verifier.cjs');
const RUNNING_RUNTIME_ROOT = fs.realpathSync.native(path.resolve(__dirname, '..', '..', '..'));

function sameFilesystemPath(left, right) {
  const normalize = (value) => {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  };
  return normalize(left) === normalize(right);
}

function exactKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...fields].sort(compareUtf8);
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    throw new Error(`${label} fields differ from the closed schema`);
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
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

function assertGitId(value, format, label) {
  if (!GIT_ID_RES[format]?.test(value) || /^0+$/u.test(value)) {
    throw new Error(`${label} must be a canonical non-zero ${String(format)} Git object ID`);
  }
}

function assertDirectory(directory, label) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new Error(`${label} is required`);
  }
  const absolute = path.resolve(directory);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  const real = fs.realpathSync.native(absolute);
  if (real !== absolute && process.platform !== 'win32') {
    throw new Error(`${label} must not resolve through a directory alias`);
  }
  return real;
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative)
    && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function assertDistinctRoots(repositoryRoot, checkoutRoot) {
  if (repositoryRoot === checkoutRoot
      || isInside(repositoryRoot, checkoutRoot)
      || isInside(checkoutRoot, repositoryRoot)) {
    throw new Error('authoritative repository and adopted checkout must be distinct non-nested roots');
  }
}

function readAuthoritativeRef(repositoryRoot, authoritativeRef) {
  if (typeof authoritativeRef !== 'string' || !/^refs\/[A-Za-z0-9._/-]+$/u.test(authoritativeRef)
      || authoritativeRef.includes('//') || authoritativeRef.endsWith('/')
      || authoritativeRef.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('trusted authoritativeRef must be one normalized full refs/... name');
  }
  const value = runGit(
    repositoryRoot,
    ['show-ref', '--verify', '--hash', authoritativeRef],
  ).toString('utf8').trim();
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error('authoritative ref observation is not one full object ID');
  }
  return value;
}

function necessaryDirectories(files) {
  const result = new Set();
  for (const file of files) {
    const segments = file.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      result.add(segments.slice(0, index).join('/'));
    }
  }
  return result;
}

function enumerateCheckout(checkoutRoot, expectedFiles) {
  const administrativeRoot = path.join(checkoutRoot, '.git');
  const administrativeStat = fs.lstatSync(administrativeRoot);
  if (administrativeStat.isSymbolicLink()
      || (!administrativeStat.isDirectory() && !administrativeStat.isFile())) {
    throw new Error('adopted checkout root .git must be a non-symlink administrative file/directory');
  }
  const files = [];
  const directories = new Set();
  const exactPaths = new Set();
  const foldedPaths = new Set();
  function visit(absoluteDirectory, relativeDirectory) {
    const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      if (relativeDirectory === '' && entry.name === '.git') continue;
      const absolute = path.join(absoluteDirectory, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (relative !== relative.normalize('NFC') || relative.includes('\\')) {
        throw new Error(`adopted checkout contains a non-canonical path ${relative}`);
      }
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`adopted checkout contains forbidden symlink ${relative}`);
      }
      const folded = relative.toLocaleLowerCase('und');
      if (exactPaths.has(relative) || foldedPaths.has(folded)) {
        throw new Error(`adopted checkout contains a duplicate/case-fold collision at ${relative}`);
      }
      exactPaths.add(relative);
      foldedPaths.add(folded);
      if (stat.isDirectory()) {
        directories.add(relative);
        visit(absolute, relative);
      } else if (stat.isFile()) {
        const bytes = fs.readFileSync(absolute);
        files.push({
          path: relative,
          byteLength: bytes.length,
          artifactDigest: sha256(bytes),
        });
      } else {
        throw new Error(`adopted checkout contains forbidden non-regular entry ${relative}`);
      }
    }
  }
  visit(checkoutRoot, '');
  files.sort((left, right) => compareUtf8(left.path, right.path));
  const modeByPath = new Map(expectedFiles.map((row) => [row.path, row.mode]));
  for (const row of files) {
    row.mode = modeByPath.get(row.path);
    if (!row.mode) throw new Error(`adopted checkout has extra file ${row.path}`);
  }
  const expectedRows = expectedFiles.map(({ mode, path: filePath, byteLength, artifactDigest: digest }) => ({
    mode,
    path: filePath,
    byteLength,
    artifactDigest: digest,
  }));
  exactEqual(files, expectedRows, 'adopted checkout byte inventory');
  const requiredDirectories = [...necessaryDirectories(expectedFiles)].sort(compareUtf8);
  exactEqual([...directories].sort(compareUtf8), requiredDirectories, 'adopted checkout directory inventory');
  return files;
}

function validateTrustedPins(pins) {
  const fields = [
    'schemaVersion', 'repositoryId', 'authoritativeRef', 'gitObjectFormat',
    'expectedOldCommitId', 'expectedCommitId', 'expectedTreeId',
    'expectedSourceTreeDigest', 'payloadManifestDigest',
    'approvalEligibilityReportDigest', 'decisionTrustPolicyDigest',
    'verificationTrustPolicyDigest', 'terminalRuntimeClosureDigest',
  ];
  exactKeys(pins, fields, 'terminal trusted pins');
  if (pins.schemaVersion !== '1.0'
      || typeof pins.repositoryId !== 'string' || pins.repositoryId.length === 0
      || !['sha1', 'sha256'].includes(pins.gitObjectFormat)) {
    throw new Error('terminal trusted pins have an invalid schema/repository/object format');
  }
  for (const field of ['expectedOldCommitId', 'expectedCommitId', 'expectedTreeId']) {
    assertGitId(pins[field], pins.gitObjectFormat, `terminal trusted pins.${field}`);
  }
  if (pins.expectedOldCommitId === pins.expectedCommitId) {
    throw new Error('terminal trusted pins old/new commit IDs must differ');
  }
  for (const field of [
    'expectedSourceTreeDigest', 'payloadManifestDigest',
    'approvalEligibilityReportDigest', 'decisionTrustPolicyDigest',
    'verificationTrustPolicyDigest', 'terminalRuntimeClosureDigest',
  ]) assertDigest(pins[field], `terminal trusted pins.${field}`);
  readAuthoritativeRefNameOnly(pins.authoritativeRef);
}

function readAuthoritativeRefNameOnly(authoritativeRef) {
  if (typeof authoritativeRef !== 'string' || !/^refs\/[A-Za-z0-9._/-]+$/u.test(authoritativeRef)
      || authoritativeRef.includes('//') || authoritativeRef.endsWith('/')) {
    throw new Error('terminal trusted pins.authoritativeRef is not a normalized full ref');
  }
}

function validatePolicies(options, pins) {
  const decisionDigest = validateDecisionTrustPolicy(options.decisionTrustPolicy);
  const verificationDigest = validateVerificationTrustPolicy(options.verificationTrustPolicy);
  if (decisionDigest !== pins.decisionTrustPolicyDigest
      || taggedJcsDigest(DECISION_POLICY_TAG, options.decisionTrustPolicy)
        !== pins.decisionTrustPolicyDigest) {
    throw new Error('decision trust policy differs from its out-of-band terminal pin');
  }
  if (verificationDigest !== pins.verificationTrustPolicyDigest
      || taggedJcsDigest(VERIFICATION_POLICY_TAG, options.verificationTrustPolicy)
        !== pins.verificationTrustPolicyDigest) {
    throw new Error('verification trust policy differs from its out-of-band terminal pin');
  }
}

function sourceDigest(file) {
  return sha256(fs.readFileSync(file));
}

function verifyRawSourceTreeBinding(sourceTree, reference, digest, label) {
  if (!reference || reference.kind !== 'path' || reference.root !== 'sourceTree'
      || typeof reference.path !== 'string') {
    throw new Error(`${label} must be a sourceTree path binding`);
  }
  const rows = sourceTree.files.filter((row) => row.path === reference.path);
  if (rows.length !== 1 || rows[0].artifactDigest !== digest) {
    throw new Error(`${label} bytes are absent or drifted in the reconstructed P1 tree`);
  }
}

function verifyGitAndCheckout(options, pins) {
  const repositoryRoot = assertDirectory(options.repositoryRoot, 'authoritative repository root');
  const checkoutRoot = assertDirectory(options.checkoutRoot, 'adopted checkout root');
  assertDistinctRoots(repositoryRoot, checkoutRoot);
  if (repositoryObjectFormat(repositoryRoot) !== pins.gitObjectFormat) {
    throw new Error('authoritative repository object format differs from the terminal pin');
  }
  const refBefore = readAuthoritativeRef(repositoryRoot, pins.authoritativeRef);
  if (refBefore !== pins.expectedCommitId) {
    throw new Error('authoritative ref does not currently equal the pinned P1 commit');
  }
  const commit = inspectCommit(repositoryRoot, pins.expectedCommitId, pins.gitObjectFormat);
  if (commit.treeId !== pins.expectedTreeId
      || commit.parents.length !== 1
      || commit.parents[0] !== pins.expectedOldCommitId) {
    throw new Error('pinned P1 is not the exact tree with P0 as its sole parent');
  }
  const sourceTree = buildSourceTreeManifest(
    repositoryRoot,
    commit.treeId,
    pins.gitObjectFormat,
  );
  if (sourceTree.sourceTreeDigest !== pins.expectedSourceTreeDigest) {
    throw new Error('reconstructed P1 source-tree digest differs from the terminal pin');
  }
  if (repositoryObjectFormat(checkoutRoot) !== pins.gitObjectFormat) {
    throw new Error('adopted checkout repository object format differs');
  }
  const checkoutHead = runGit(checkoutRoot, ['rev-parse', '--verify', 'HEAD'])
    .toString('utf8').trim();
  if (checkoutHead !== pins.expectedCommitId) {
    throw new Error('adopted checkout HEAD does not equal the pinned P1 commit');
  }
  const checkoutFiles = enumerateCheckout(checkoutRoot, sourceTree.files);
  const refAfter = readAuthoritativeRef(repositoryRoot, pins.authoritativeRef);
  if (refAfter !== refBefore) {
    throw new Error('authoritative ref changed during terminal Git/checkout verification');
  }
  return {
    checkoutFiles,
    checkoutRoot,
    commit,
    refAfter,
    refBefore,
    repositoryRoot,
    sourceTree,
  };
}

function artifactPairKey(reference, digest) {
  return `${canonicalJcs(reference)}\0${digest}`;
}

function collectTerminalRequiredPairs(evidence) {
  const pairs = [];
  const add = (label, artifactRef, digest) => {
    if (!artifactRef || !digest) throw new Error(`terminal dependency input ${label} is absent`);
    pairs.push({ label, artifactRef, artifactDigest: digest });
  };
  const expected = evidence.expected;
  const report = evidence.adoptionReport;
  const receipt = evidence.adoptionReceipt.receiptPayload;
  add('challenge', evidence.refs.challenge, taggedJcsDigest(
    'axiolune-adoption-attempt-challenge-v1\0', evidence.challenge,
  ));
  add('approval', evidence.refs.approval, artifactDigest(evidence.approval));
  add('adoption receipt', evidence.refs.adoptionReceipt, taggedJcsDigest(
    'axiolune-ref-update-receipt-v1\0', evidence.adoptionReceipt,
  ));
  add('checkout manifest', evidence.refs.checkoutManifest, taggedJcsDigest(
    'axiolune-adopted-checkout-manifest-v1\0', evidence.checkoutManifest,
  ));
  add('adoption report', evidence.refs.adoptionReport, taggedJcsDigest(
    'axiolune-adoption-verification-report-v1\0', report,
  ));
  add('payload manifest', expected.payloadManifestRef, expected.payloadManifestDigest);
  add(
    'payload verification report',
    expected.payloadVerificationReportRef,
    expected.payloadVerificationReportDigest,
  );
  add(
    'approval eligibility report',
    expected.approvalEligibilityReportRef,
    expected.approvalEligibilityReportDigest,
  );
  add('decision trust policy', expected.decisionTrustPolicyRef, expected.decisionTrustPolicyDigest);
  add(
    'verification trust policy',
    expected.verificationTrustPolicyRef,
    expected.verificationTrustPolicyDigest,
  );
  add(
    'P1 source-tree manifest',
    expected.p1SourceTreeManifestRef,
    expected.p1SourceTreeManifestDigest,
  );
  add('adoption verifier', expected.verifier.verifierRef, expected.verifier.verifierDigest);
  add('updater capability', receipt.updaterCapabilityRef, receipt.updaterCapabilityDigest);
  add('updater entrypoint', receipt.updaterEntrypointRef, receipt.updaterEntrypointDigest);
  add(
    'phase registry',
    evidence.adoptionDependencyManifest.phaseRegistryRef,
    evidence.adoptionDependencyManifest.phaseRegistryDigest,
  );
  add(
    'dependency extractor',
    evidence.adoptionDependencyManifest.extractorCapabilityRef,
    evidence.adoptionDependencyManifest.extractorCapabilityDigest,
  );
  for (const check of report.result.checks) {
    for (const name of [
      'capability', 'entrypoint', 'discoveryContract', 'evidenceSchema',
      'subjectInventory', 'evidence',
    ]) add(`check ${check.checkId} ${name}`, check[`${name}Ref`], check[`${name}Digest`]);
  }
  const unique = new Map();
  for (const pair of pairs) {
    const key = artifactPairKey(pair.artifactRef, pair.artifactDigest);
    if (!unique.has(key)) unique.set(key, pair);
  }
  return [...unique.values()];
}

function verifyTerminalDependencyCoverage(evidence) {
  const nodes = evidence.adoptionDependencyManifest?.nodes;
  if (!Array.isArray(nodes)) throw new Error('terminal adoption dependency manifest has no nodes');
  const nodeKeys = new Set(nodes.map((node) => (
    artifactPairKey(node.artifactRef, node.artifactDigest)
  )));
  const required = collectTerminalRequiredPairs(evidence);
  const missing = required.filter((pair) => !nodeKeys.has(
    artifactPairKey(pair.artifactRef, pair.artifactDigest),
  ));
  if (missing.length > 0) {
    throw new Error(`terminal adoption dependency manifest omits ${missing.map((row) => row.label).join(', ')}`);
  }
  return { requiredPairCount: required.length };
}

function verifyFreshCoordinatorState(fresh, historic) {
  exactKeys(fresh, [
    'schemaVersion', 'repositoryId', 'authoritativeRef',
    'challengeId', 'challengeDigest', 'attemptSequence',
    'initialRefEpoch', 'currentRefEpoch', 'currentCommitId',
    'state', 'preparedOperation', 'consumedAdoptionReceiptDigest',
    'querySequence',
  ], 'fresh protected coordinator state');
  const stableFields = [
    'schemaVersion', 'repositoryId', 'authoritativeRef', 'challengeId',
    'challengeDigest', 'attemptSequence', 'initialRefEpoch', 'currentRefEpoch',
    'currentCommitId', 'state', 'preparedOperation', 'consumedAdoptionReceiptDigest',
  ];
  for (const field of stableFields) {
    exactEqual(fresh[field], historic[field], `fresh protected coordinator state.${field}`);
  }
  if (!Number.isSafeInteger(fresh.querySequence)
      || fresh.querySequence <= historic.querySequence) {
    throw new Error('fresh protected coordinator querySequence did not advance');
  }
  return {
    historicStateDigest: taggedJcsDigest(
      'axiolune-adoption-attempt-state-v1\0', historic,
    ),
    observedQuerySequence: fresh.querySequence,
  };
}

function normalizeEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('terminal adoption evidence is required');
  }
  const verifiedChecks = evidence.verifiedChecks instanceof Map
    ? evidence.verifiedChecks
    : new Map((evidence.verifiedChecks || []).map((row) => [row.checkId, row]));
  return { ...evidence, verifiedChecks };
}

function verifyTerminalAdoption(options = {}) {
  const pins = options.trustedPins;
  validateTrustedPins(pins);
  const requestedRuntimeRoot = fs.realpathSync.native(path.resolve(options.runtimeRoot || ''));
  if (!sameFilesystemPath(requestedRuntimeRoot, RUNNING_RUNTIME_ROOT)) {
    throw new Error('terminal runtimeRoot does not contain the running terminal verifier');
  }
  const runtimePreflight = verifyTerminalRuntimeClosure({
    runtimeRoot: requestedRuntimeRoot,
    manifest: options.runtimeClosure,
    expectedClosureDigest: pins.terminalRuntimeClosureDigest,
  });
  loadMeasuredRuntimeDependencies();
  const gitRuntime = trustedGitRuntimeIdentity();
  validatePolicies(options, pins);
  const terminalVerifierDigest = sourceDigest(TERMINAL_VERIFIER_SOURCE);
  const measuredTerminalVerifier = runtimePreflight.manifest.files.find(
    (row) => row.path === 'scripts/domain/lib/m2-terminal-adoption-verifier.cjs',
  );
  if (!measuredTerminalVerifier
      || terminalVerifierDigest !== measuredTerminalVerifier.artifactDigest) {
    throw new Error('running terminal verifier bytes differ from the measured runtime closure');
  }
  const evidence = normalizeEvidence(options.evidence);
  const componentVerifierDigest = sourceDigest(COMPONENT_VERIFIER_SOURCE);
  const git = verifyGitAndCheckout(options, pins);
  if (evidence.expected?.verifier?.verifierDigest !== componentVerifierDigest) {
    throw new Error('adoption report verifier binding differs from the running reviewed component verifier');
  }
  verifyRawSourceTreeBinding(
    git.sourceTree,
    evidence.expected.verifier.verifierRef,
    componentVerifierDigest,
    'adoption report verifier',
  );
  verifyRawSourceTreeBinding(
    git.sourceTree,
    evidence.adoptionReceipt.receiptPayload.updaterEntrypointRef,
    evidence.adoptionReceipt.receiptPayload.updaterEntrypointDigest,
    'protected ref updater entrypoint',
  );
  for (const check of evidence.adoptionReport.result.checks) {
    verifyRawSourceTreeBinding(
      git.sourceTree,
      check.entrypointRef,
      check.entrypointDigest,
      `adoption check ${check.checkId} entrypoint`,
    );
  }
  const expected = {
    ...evidence.expected,
    repositoryId: pins.repositoryId,
    authoritativeRef: pins.authoritativeRef,
    gitObjectFormat: pins.gitObjectFormat,
    expectedOldCommitId: pins.expectedOldCommitId,
    requestedNewCommitId: pins.expectedCommitId,
    treeId: pins.expectedTreeId,
    sourceTreeDigest: pins.expectedSourceTreeDigest,
    payloadManifestDigest: pins.payloadManifestDigest,
    approvalEligibilityReportDigest: pins.approvalEligibilityReportDigest,
    decisionTrustPolicyDigest: pins.decisionTrustPolicyDigest,
    verificationTrustPolicyDigest: pins.verificationTrustPolicyDigest,
    sourceTreeFiles: git.checkoutFiles,
    p1SourceTreeManifestDigest: git.sourceTree.sourceTreeManifestDigest,
    verifier: {
      ...evidence.expected.verifier,
      verifierDigest: componentVerifierDigest,
    },
  };
  const dependency = verifyTerminalDependencyCoverage({ ...evidence, expected });
  if (typeof options.readCoordinatorState !== 'function') {
    throw new Error('terminal verification requires an out-of-band protected coordinator reader');
  }
  const freshCoordinatorState = options.readCoordinatorState();
  const coordinator = verifyFreshCoordinatorState(
    freshCoordinatorState,
    evidence.coordinatorState,
  );
  const component = verifyAdoptedEvidenceChain({
    ...evidence,
    authoritativeRefObservation: git.refAfter,
    decisionTrustPolicy: options.decisionTrustPolicy,
    verificationTrustPolicy: options.verificationTrustPolicy,
    expected,
    eligibility: {
      eligible: true,
      reportRef: expected.approvalEligibilityReportRef,
      reportDigest: pins.approvalEligibilityReportDigest,
    },
    recomputedAdoptionDependencyManifest: structuredClone(
      evidence.adoptionDependencyManifest,
    ),
  });
  if (component.outcome !== 'component-verified'
      || component.releaseComplete !== false
      || component.terminalVerificationRequired !== true) {
    throw new Error('component verifier crossed or failed its non-terminal trust boundary');
  }
  const refFinal = readAuthoritativeRef(git.repositoryRoot, pins.authoritativeRef);
  if (refFinal !== pins.expectedCommitId || refFinal !== git.refBefore) {
    throw new Error('authoritative ref changed before the terminal result was finalized');
  }
  const runtimePostflight = verifyTerminalRuntimeClosure({
    runtimeRoot: requestedRuntimeRoot,
    manifest: options.runtimeClosure,
    expectedClosureDigest: pins.terminalRuntimeClosureDigest,
    expectedSnapshot: runtimePreflight.manifest,
  });
  const terminalRefObservation = readAuthoritativeRef(
    git.repositoryRoot,
    pins.authoritativeRef,
  );
  if (terminalRefObservation !== pins.expectedCommitId
      || terminalRefObservation !== refFinal) {
    throw new Error('authoritative ref changed after terminal runtime postflight');
  }
  return {
    schemaVersion: '1.0',
    verifierId: TERMINAL_VERIFIER_ID,
    verificationScope: TERMINAL_SCOPE,
    outcome: 'adopted',
    eligible: true,
    approvalStatus: 'approved',
    adoptionStatus: 'verified',
    releaseComplete: true,
    repositoryId: pins.repositoryId,
    authoritativeRef: pins.authoritativeRef,
    expectedOldCommitId: pins.expectedOldCommitId,
    adoptedCommitId: pins.expectedCommitId,
    adoptedTreeId: pins.expectedTreeId,
    adoptedSourceTreeDigest: pins.expectedSourceTreeDigest,
    payloadManifestDigest: pins.payloadManifestDigest,
    approvalEligibilityReportDigest: pins.approvalEligibilityReportDigest,
    challengeDigest: component.challengeDigest,
    approvalDigest: component.approvalDigest,
    adoptionReceiptDigest: component.adoptionReceiptDigest,
    adoptionVerificationReportDigest: component.adoptionVerificationReportDigest,
    adoptionArtifactDependencyManifestDigest:
      component.adoptionArtifactDependencyManifestDigest,
    attestationPayloadDigest: component.attestationPayloadDigest,
    decisionTrustPolicyDigest: pins.decisionTrustPolicyDigest,
    verificationTrustPolicyDigest: pins.verificationTrustPolicyDigest,
    terminalRuntimeClosureDigest: runtimePostflight.closureDigest,
    terminalRuntimeFileCount: runtimePostflight.fileCount,
    nodeExecutableRealPath: runtimePostflight.manifest.nodeRuntime.executableRealPath,
    nodeExecutableDigest: runtimePostflight.manifest.nodeRuntime.executableDigest,
    nodeVersion: runtimePostflight.manifest.nodeRuntime.version,
    gitExecutableRealPath: gitRuntime.executable,
    gitExecutableDigest: gitRuntime.artifactDigest,
    gitVersion: gitRuntime.version,
    terminalVerifierDigest,
    componentVerifierDigest,
    authoritativeRefObservation: terminalRefObservation,
    coordinatorStateDigest: coordinator.historicStateDigest,
    coordinatorQuerySequence: coordinator.observedQuerySequence,
    dependencyRequiredPairCount: dependency.requiredPairCount,
    checkoutFileCount: git.checkoutFiles.length,
  };
}

module.exports = {
  COMPONENT_VERIFIER_SOURCE,
  TERMINAL_SCOPE,
  TERMINAL_VERIFIER_ID,
  TERMINAL_VERIFIER_SOURCE,
  collectTerminalRequiredPairs,
  enumerateCheckout,
  isInside,
  verifyFreshCoordinatorState,
  verifyTerminalAdoption,
  verifyTerminalDependencyCoverage,
};
