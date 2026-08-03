'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  assessM2ReleaseLifecycle,
  terminalChildEnvironment,
} = require('../lib/m2-release-lifecycle.cjs');

function eligibleDiagnostic() {
  return {
    verificationScope: 'post-payload-approval-eligibility',
    eligible: true,
    approvalStatus: 'not-approved',
    adoptionStatus: 'not-verified',
    releaseComplete: false,
  };
}

test('six-criterion eligibility remains non-terminal without trusted adoption proof', () => {
  const result = assessM2ReleaseLifecycle(eligibleDiagnostic());
  assert.equal(result.status, 'pending');
  assert.equal(result.code, 'M2_RELEASE_ADOPTION_VERIFIER_REQUIRED');
  assert.match(result.detail, /AdoptionAttestation/u);
});

test('an eligibility diagnostic cannot smuggle an approved lifecycle result', () => {
  for (const mutation of [
    { approvalStatus: 'approved' },
    { adoptionStatus: 'verified' },
    { releaseComplete: true },
    { verificationScope: 'full-release-and-adoption' },
  ]) {
    const result = assessM2ReleaseLifecycle({ ...eligibleDiagnostic(), ...mutation });
    assert.equal(result.status, 'invalid');
    assert.equal(result.code, 'M2_RELEASE_ELIGIBILITY_SCOPE_ESCALATION');
  }
});

test('incomplete eligibility stays pending before any adoption attempt', () => {
  const result = assessM2ReleaseLifecycle({ eligible: false });
  assert.equal(result.status, 'pending');
  assert.equal(result.code, 'M2_RELEASE_ELIGIBILITY_REQUIRED');
});

test('terminal child bootstrap does not inherit Node preload/search-path authority', () => {
  const environment = terminalChildEnvironment();
  for (const key of Object.keys(environment)) {
    assert.notEqual(key.toUpperCase(), 'NODE_OPTIONS');
    assert.notEqual(key.toUpperCase(), 'NODE_PATH');
    assert.notEqual(key.toUpperCase(), 'GIT_EXEC_PATH');
  }
});

test('candidate repository cannot nominate itself as the terminal verifier runtime', () => {
  const candidateRoot = path.resolve(__dirname, '..', '..', '..');
  const result = assessM2ReleaseLifecycle(eligibleDiagnostic(), {
    externalConfigPath: path.join(candidateRoot, 'not-an-authority.json'),
    externalRuntimeRoot: candidateRoot,
    expectedApprovalEligibilityReportDigest: `sha256:${'1'.repeat(64)}`,
    expectedRepositoryId: 'urn:axiolune:test',
    expectedAuthoritativeRef: 'refs/heads/test',
    expectedOldCommitId: '2'.repeat(40),
    expectedDecisionTrustPolicyDigest: `sha256:${'3'.repeat(64)}`,
    expectedVerificationTrustPolicyDigest: `sha256:${'4'.repeat(64)}`,
    expectedTerminalRuntimeClosureDigest: `sha256:${'5'.repeat(64)}`,
  });
  assert.equal(result.status, 'pending');
  assert.equal(result.code, 'M2_RELEASE_ADOPTION_NOT_ESTABLISHED');
  assert.match(result.detail, /outside the candidate repository/u);
});
