'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const inputContract = require('../orders-portfolio-custom-profile/v0.3.0/input-contract.json');
const profile = require('../orders-portfolio-custom-profile/v0.3.0/test-vectors.json');
const {
  decodeCanonicalOrdersPortfolioScenario,
} = require('../lib/orders-portfolio-canonical-record-adapter.cjs');
const {
  sha256Jcs,
  validateConstraint,
} = require('../lib/orders-portfolio-custom-validators.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
} = require('../lib/strict-source-locator.cjs');

const UNBOUND_DIGEST = `sha256:${'9'.repeat(64)}`;

function substituteUnboundRecordEvidence(document) {
  const candidate = structuredClone(document);
  let changed = 0;
  for (const record of candidate.records || []) {
    const hasDigest = Object.hasOwn(record, 'sourceArtifactDigest');
    const hasLocator = Object.hasOwn(record, 'sourceLocator');
    if (!hasDigest && !hasLocator) continue;
    assert.equal(
      hasDigest && hasLocator,
      true,
      `${record.versionIri || record.typeIri}: source digest and locator must be paired`,
    );
    record.sourceArtifactDigest = UNBOUND_DIGEST;
    record.sourceLocator.selectionDigest = UNBOUND_DIGEST;
    changed += 1;
  }
  return { candidate, changed };
}

test('every canonical Orders/Portfolio source claim rejects an unbound digest substitution', () => {
  const failures = [];
  let exercisedVectors = 0;
  let exercisedRecords = 0;

  for (const vector of profile.vectors) {
    const { candidate, changed } = substituteUnboundRecordEvidence(
      vector.accepted.scenario,
    );
    if (changed === 0) continue;
    exercisedVectors += 1;
    exercisedRecords += changed;

    let rejected = false;
    try {
      const scenario = decodeCanonicalOrdersPortfolioScenario(
        candidate,
        vector.validatorId,
        inputContract,
      );
      validateConstraint(vector.constraintIri, vector.validatorId, scenario);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      failures.push(
        `${vector.validatorId}: accepted ${changed} source claim(s) after `
          + 'sourceArtifactDigest and sourceLocator.selectionDigest were replaced '
          + 'by an arbitrary digest with no authenticated selected bytes',
      );
    }
  }

  assert.ok(exercisedVectors > 0, 'the profile did not expose any source-evidenced vector');
  assert.ok(exercisedRecords > 0, 'the profile did not expose any source-evidenced record');
  assert.deepEqual(failures, []);
});

function focus(document) {
  return document.records.find(
    (record) => record.versionIri === document.focusVersionIri,
  );
}

function sourceArtifact(document, record) {
  return document.artifacts.find(
    (row) => row.artifactRef.iri === record.sourceArtifactRef.iri,
  );
}

function profileArtifact(document, record) {
  return document.artifacts.find(
    (row) => row.artifactRef.iri
      === record.sourceLocator.extractorProfileRef.iri,
  );
}

function resealSelection(record, artifact) {
  delete record.sourceLocator.selectionDigest;
  record.sourceLocator.selectionDigest = computeSelectionDigest(
    record.sourceLocator,
    Buffer.from(canonicalJcs(artifact.payload), 'utf8'),
  );
}

function assertCanonicalRejection(document, vector, code) {
  assert.throws(
    () => decodeCanonicalOrdersPortfolioScenario(
      document,
      vector.validatorId,
      inputContract,
    ),
    (cause) => cause?.code === code,
    `expected ${code}`,
  );
}

test('source evidence closure rejects artifact, selector, path, media, and extractor-profile substitutions', () => {
  const vector = profile.vectors.find(
    (row) => row.validatorId === 'OrderIntentContract',
  );
  assert.ok(vector, 'missing OrderIntentContract vector');
  const accepted = vector.accepted.scenario;

  const missingArtifact = structuredClone(accepted);
  const missingRecord = focus(missingArtifact);
  missingArtifact.artifacts = missingArtifact.artifacts.filter(
    (row) => row.artifactRef.iri !== missingRecord.sourceArtifactRef.iri,
  );
  assertCanonicalRejection(
    missingArtifact,
    vector,
    'orders-portfolio-canonical-source-artifact-join',
  );

  const payloadSubstitution = structuredClone(accepted);
  const payloadRecord = focus(payloadSubstitution);
  const payloadArtifact = sourceArtifact(payloadSubstitution, payloadRecord);
  payloadArtifact.payload = { evidence: 'coherently-rebound-but-unselected' };
  payloadArtifact.artifactDigest = sha256Jcs(payloadArtifact.payload);
  payloadRecord.sourceArtifactDigest = payloadArtifact.artifactDigest;
  assertCanonicalRejection(
    payloadSubstitution,
    vector,
    'orders-portfolio-canonical-source-locator',
  );

  const pathTraversal = structuredClone(accepted);
  const pathRecord = focus(pathTraversal);
  const pathArtifact = sourceArtifact(pathTraversal, pathRecord);
  pathRecord.sourceLocator.path = '../canonical-source.json';
  resealSelection(pathRecord, pathArtifact);
  assertCanonicalRejection(
    pathTraversal,
    vector,
    'orders-portfolio-canonical-source-locator',
  );

  const selectorSubstitution = structuredClone(accepted);
  const selectorRecord = focus(selectorSubstitution);
  const selectorArtifact = sourceArtifact(selectorSubstitution, selectorRecord);
  selectorRecord.sourceLocator.kind = 'jsonPointer';
  selectorRecord.sourceLocator.pointer = '/evidence';
  resealSelection(selectorRecord, selectorArtifact);
  assertCanonicalRejection(
    selectorSubstitution,
    vector,
    'orders-portfolio-canonical-source-extractor-profile',
  );

  const profileSubstitution = structuredClone(accepted);
  const profileRecord = focus(profileSubstitution);
  const extractor = profileArtifact(profileSubstitution, profileRecord);
  extractor.payload.profileId = 'attacker-controlled-whole-file-v1';
  extractor.artifactDigest = sha256Jcs(extractor.payload);
  profileRecord.sourceLocator.extractorProfileDigest = extractor.artifactDigest;
  resealSelection(
    profileRecord,
    sourceArtifact(profileSubstitution, profileRecord),
  );
  assertCanonicalRejection(
    profileSubstitution,
    vector,
    'orders-portfolio-canonical-source-extractor-profile',
  );

  const missingSelection = structuredClone(accepted);
  delete focus(missingSelection).sourceLocator.selectionDigest;
  assertCanonicalRejection(
    missingSelection,
    vector,
    'orders-portfolio-canonical-source-locator',
  );

  const mediaSubstitution = structuredClone(accepted);
  const mediaRecord = focus(mediaSubstitution);
  const mediaArtifact = sourceArtifact(mediaSubstitution, mediaRecord);
  mediaRecord.sourceLocator.mediaType = 'text/plain';
  resealSelection(mediaRecord, mediaArtifact);
  assertCanonicalRejection(
    mediaSubstitution,
    vector,
    'orders-portfolio-canonical-source-media-type-join',
  );
});
