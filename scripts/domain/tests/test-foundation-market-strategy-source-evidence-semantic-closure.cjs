'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const profile = require('../foundation-market-strategy-custom-profile/v0.3.0/test-vectors.json');
const {
  evaluateSemanticScenario,
} = require('../lib/foundation-market-strategy-custom-validators.cjs');

const UNBOUND_DIGEST = `sha256:${'9'.repeat(64)}`;

function mutateSourceEvidence(value, mutateClaim) {
  const candidate = structuredClone(value);
  let sourceClaimCount = 0;

  function visit(current) {
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (Object.hasOwn(current, 'sourceArtifactDigest')) {
      assert.ok(
        current.sourceLocator && typeof current.sourceLocator === 'object',
        'sourceArtifactDigest must be paired with a structured SourceLocator',
      );
      assert.ok(
        Object.hasOwn(current.sourceLocator, 'selectionDigest'),
        'structured SourceLocator must bind selected bytes',
      );
      mutateClaim(current);
      sourceClaimCount += 1;
    }
    for (const nested of Object.values(current)) visit(nested);
  }

  visit(candidate);
  return { candidate, sourceClaimCount };
}

const MUTATIONS = Object.freeze([
  ['artifact-digest-substitution', (claim) => {
    claim.sourceArtifactDigest = UNBOUND_DIGEST;
  }],
  ['selection-digest-substitution', (claim) => {
    claim.sourceLocator.selectionDigest = UNBOUND_DIGEST;
  }],
  ['extractor-profile-digest-substitution', (claim) => {
    claim.sourceLocator.extractorProfileDigest = UNBOUND_DIGEST;
  }],
  ['source-artifact-path-substitution', (claim) => {
    if (claim.sourceArtifactRef.kind === 'path') {
      claim.sourceArtifactRef.path = claim.sourceLocator.extractorProfileRef.kind === 'path'
        ? claim.sourceLocator.extractorProfileRef.path
        : `${claim.sourceArtifactRef.path}.tampered`;
    } else {
      claim.sourceArtifactRef.iri = `${claim.sourceArtifactRef.iri}/tampered`;
    }
  }],
  ['locator-path-substitution', (claim) => {
    claim.sourceLocator.path = claim.sourceLocator.extractorProfileRef.kind === 'path'
      ? claim.sourceLocator.extractorProfileRef.path
      : `${claim.sourceLocator.path}.tampered`;
  }],
  ['extractor-profile-ref-substitution', (claim) => {
    claim.sourceLocator.extractorProfileRef = structuredClone(claim.sourceArtifactRef);
  }],
  ['selection-digest-omission', (claim) => {
    delete claim.sourceLocator.selectionDigest;
  }],
  ['locator-unknown-field-injection', (claim) => {
    claim.sourceLocator.unreviewedSelector = 'accepted-by-weak-validator';
  }],
]);

test('Foundation/Market/Strategy semantic validators enforce independent source-byte closure without vector dispatch locks', () => {
  const failures = [];
  const exercised = new Map(MUTATIONS.map(([name]) => [name, 0]));

  for (const vector of profile.vectors) {
    const baseline = evaluateSemanticScenario(vector.accepted.scenario);
    assert.deepEqual(
      baseline,
      [],
      `${vector.validatorId} accepted scenario must be semantically valid before mutation`,
    );

    for (const [mutationName, mutateClaim] of MUTATIONS) {
      const mutation = mutateSourceEvidence(vector.accepted.scenario, mutateClaim);
      if (mutation.sourceClaimCount === 0) continue;
      exercised.set(mutationName, exercised.get(mutationName) + 1);

      let findings;
      try {
        findings = evaluateSemanticScenario(mutation.candidate);
      } catch {
        continue;
      }
      if (Array.isArray(findings) && findings.length > 0) continue;
      failures.push(
        `${vector.validatorId}/${mutationName}: accepted ${mutation.sourceClaimCount} `
          + 'source claim(s) after independent evidence tampering',
      );
    }
  }

  for (const [mutationName, count] of exercised) {
    assert.ok(count > 0, `${mutationName} exercised no source-evidenced scenario`);
  }
  assert.deepEqual(failures, []);
});
