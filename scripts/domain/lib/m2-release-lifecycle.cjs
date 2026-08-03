'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ELIGIBILITY_SCOPE = 'post-payload-approval-eligibility';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..');

function terminalChildEnvironment() {
  const environment = { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR']);
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toUpperCase()) && typeof value === 'string') {
      environment[key] = value;
    }
  }
  return environment;
}

function verifyExternalTerminalConfig(options) {
  const fields = [
    'externalConfigPath', 'externalRuntimeRoot',
    'expectedApprovalEligibilityReportDigest',
    'expectedRepositoryId', 'expectedAuthoritativeRef', 'expectedOldCommitId',
    'expectedDecisionTrustPolicyDigest', 'expectedVerificationTrustPolicyDigest',
    'expectedTerminalRuntimeClosureDigest',
  ];
  const actual = Object.keys(options).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...fields].sort())) {
    throw new Error('external terminal lifecycle options differ from the closed schema');
  }
  if (typeof options.externalConfigPath !== 'string'
      || options.externalConfigPath.length === 0
      || typeof options.externalRuntimeRoot !== 'string'
      || options.externalRuntimeRoot.length === 0
      || !path.isAbsolute(options.externalRuntimeRoot)
      || typeof options.expectedRepositoryId !== 'string'
      || options.expectedRepositoryId.length === 0
      || typeof options.expectedAuthoritativeRef !== 'string'
      || !options.expectedAuthoritativeRef.startsWith('refs/')
      || typeof options.expectedOldCommitId !== 'string'
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(options.expectedOldCommitId)
      || !DIGEST_RE.test(options.expectedApprovalEligibilityReportDigest || '')
      || !DIGEST_RE.test(options.expectedDecisionTrustPolicyDigest || '')
      || !DIGEST_RE.test(options.expectedVerificationTrustPolicyDigest || '')
      || !DIGEST_RE.test(options.expectedTerminalRuntimeClosureDigest || '')) {
    throw new Error('external terminal lifecycle authority bindings are invalid');
  }
  const runtimeStat = fs.lstatSync(options.externalRuntimeRoot);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
    throw new Error('external terminal runtime root must be a regular non-symlink directory');
  }
  const externalRuntimeRoot = fs.realpathSync.native(options.externalRuntimeRoot);
  const relativeToCandidate = path.relative(SOURCE_ROOT, externalRuntimeRoot);
  if (relativeToCandidate === ''
      || (!path.isAbsolute(relativeToCandidate)
        && relativeToCandidate !== '..'
        && !relativeToCandidate.startsWith(`..${path.sep}`))) {
    throw new Error('terminal verifier runtime must be outside the candidate repository');
  }
  const cli = path.resolve(
    externalRuntimeRoot,
    'scripts',
    'domain',
    'run-m2-adoption-verifier.cjs',
  );
  const relativeCli = path.relative(externalRuntimeRoot, cli);
  if (path.isAbsolute(relativeCli)
      || relativeCli === '..'
      || relativeCli.startsWith(`..${path.sep}`)) {
    throw new Error('external terminal verifier entrypoint escapes its runtime root');
  }
  const cliStat = fs.lstatSync(cli);
  if (!cliStat.isFile() || cliStat.isSymbolicLink()
      || fs.realpathSync.native(cli) !== cli) {
    throw new Error('external terminal verifier entrypoint must be a regular non-symlink file');
  }
  const child = spawnSync(process.execPath, [cli, '--config', options.externalConfigPath], {
    cwd: externalRuntimeRoot,
    encoding: 'utf8',
    env: terminalChildEnvironment(),
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.signal) throw new Error(`terminal verifier was interrupted by ${child.signal}`);
  let terminal;
  try {
    if (typeof child.stdout !== 'string' || !child.stdout.endsWith('\n')
        || child.stdout.slice(0, -1).includes('\n')) {
      throw new Error('terminal verifier emitted anything other than one JSON line');
    }
    terminal = JSON.parse(child.stdout);
  } catch (cause) {
    throw new Error(`terminal verifier output is invalid: ${cause.message}`);
  }
  if (child.status !== 0) {
    const message = terminal?.issues?.[0]?.message || child.stderr || `exit ${child.status}`;
    throw new Error(`external terminal verifier remained pending: ${String(message).trim()}`);
  }
  if (child.stderr !== '') {
    throw new Error('terminal verifier emitted unexpected stderr on a success exit');
  }
  const { canonicalJcs } = require('./m2-terminal-runtime-closure.cjs');
  if (child.stdout !== `${canonicalJcs(terminal)}\n`) {
    throw new Error('terminal verifier success output is not exact canonical JCS plus one LF');
  }
  const successFields = [
    'schemaVersion', 'verifierId', 'verificationScope', 'outcome', 'eligible',
    'approvalStatus', 'adoptionStatus', 'releaseComplete', 'repositoryId',
    'authoritativeRef', 'expectedOldCommitId', 'adoptedCommitId', 'adoptedTreeId',
    'adoptedSourceTreeDigest', 'payloadManifestDigest',
    'approvalEligibilityReportDigest', 'challengeDigest', 'approvalDigest',
    'adoptionReceiptDigest', 'adoptionVerificationReportDigest',
    'adoptionArtifactDependencyManifestDigest', 'attestationPayloadDigest',
    'decisionTrustPolicyDigest', 'verificationTrustPolicyDigest',
    'terminalRuntimeClosureDigest', 'terminalRuntimeFileCount',
    'nodeExecutableRealPath', 'nodeExecutableDigest', 'nodeVersion',
    'gitExecutableRealPath', 'gitExecutableDigest', 'gitVersion',
    'terminalVerifierDigest', 'componentVerifierDigest',
    'authoritativeRefObservation', 'coordinatorStateDigest',
    'coordinatorQuerySequence', 'dependencyRequiredPairCount', 'checkoutFileCount',
  ];
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)
      || JSON.stringify(Object.keys(terminal).sort())
        !== JSON.stringify(successFields.sort())) {
    throw new Error('terminal verifier success result differs from the closed schema');
  }
  if (terminal.schemaVersion !== '1.0'
      || terminal.verifierId !== 'm2-terminal-adoption-verifier'
      || terminal.verificationScope !== 'terminal-adoption'
      || terminal.outcome !== 'adopted'
      || terminal.eligible !== true
      || terminal.approvalStatus !== 'approved'
      || terminal.adoptionStatus !== 'verified'
      || terminal.releaseComplete !== true
      || terminal.approvalEligibilityReportDigest
        !== options.expectedApprovalEligibilityReportDigest
      || terminal.repositoryId !== options.expectedRepositoryId
      || terminal.authoritativeRef !== options.expectedAuthoritativeRef
      || terminal.expectedOldCommitId !== options.expectedOldCommitId
      || terminal.decisionTrustPolicyDigest !== options.expectedDecisionTrustPolicyDigest
      || terminal.verificationTrustPolicyDigest
        !== options.expectedVerificationTrustPolicyDigest
      || terminal.terminalRuntimeClosureDigest
        !== options.expectedTerminalRuntimeClosureDigest
      || !DIGEST_RE.test(terminal.terminalRuntimeClosureDigest || '')
      || !DIGEST_RE.test(terminal.nodeExecutableDigest || '')
      || !DIGEST_RE.test(terminal.gitExecutableDigest || '')) {
    throw new Error('terminal verifier did not establish the expected eligibility-bound adoption');
  }
  return terminal;
}

/**
 * Enforce the RFC-001 boundary between six-criterion eligibility and the
 * terminal draft -> approved adoption transaction.
 *
 * Eligibility alone never creates an `adopted` result.  When terminal options
 * are present this helper invokes the independent terminal verifier itself;
 * it never accepts a caller-authored terminal diagnostic as authority.
 */
function assessM2ReleaseLifecycle(eligibilityDiagnostic, terminalVerificationOptions = null) {
  if (!eligibilityDiagnostic || eligibilityDiagnostic.eligible !== true) {
    return {
      status: 'pending',
      code: 'M2_RELEASE_ELIGIBILITY_REQUIRED',
      detail: 'post-ref adoption cannot begin until component and six-criterion '
        + 'eligibility gates are established',
    };
  }

  if (eligibilityDiagnostic.verificationScope !== ELIGIBILITY_SCOPE
      || eligibilityDiagnostic.approvalStatus !== 'not-approved'
      || eligibilityDiagnostic.adoptionStatus !== 'not-verified'
      || eligibilityDiagnostic.releaseComplete !== false) {
    return {
      status: 'invalid',
      code: 'M2_RELEASE_ELIGIBILITY_SCOPE_ESCALATION',
      detail: 'a post-payload eligibility verifier attempted to claim approval, '
        + 'adoption, release completion, or a broader verification scope',
    };
  }

  if (!terminalVerificationOptions) {
    return {
      status: 'pending',
      code: 'M2_RELEASE_ADOPTION_VERIFIER_REQUIRED',
      detail: 'six-criterion eligibility is non-terminal; RFC-001 requires a separately '
        + 'trusted challenge-bound Ed25519 ApprovalEnvelope, protected CAS receipt, '
        + 'post-ref checkout verification, AdoptionVerificationReport, dependency '
        + 'closure, and signed adopted AdoptionAttestation',
    };
  }

  try {
    // Candidate-owned code cannot serve as its own terminal trust root. The
    // adopted branch is reachable only through a verifier runtime controlled
    // outside this repository and selected by the external authority config.
    const terminal = verifyExternalTerminalConfig(terminalVerificationOptions);
    if (terminal.verificationScope !== 'terminal-adoption'
        || terminal.outcome !== 'adopted'
        || terminal.approvalStatus !== 'approved'
        || terminal.adoptionStatus !== 'verified'
        || terminal.releaseComplete !== true) {
      throw new Error('terminal verifier returned a non-terminal result');
    }
    return {
      ...terminal,
      status: 'adopted',
      code: 'M2_RELEASE_ADOPTION_VERIFIED',
      detail: 'trusted terminal replay verified the exact signed P1 adoption chain, '
        + 'protected coordinator state, authoritative ref, Git tree, and clean checkout',
    };
  } catch (cause) {
    return {
      status: 'pending',
      code: 'M2_RELEASE_ADOPTION_NOT_ESTABLISHED',
      detail: cause && cause.message ? cause.message : String(cause),
    };
  }
}

module.exports = {
  ELIGIBILITY_SCOPE,
  assessM2ReleaseLifecycle,
  terminalChildEnvironment,
  verifyExternalTerminalConfig,
};
