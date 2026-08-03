#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertAuthorityRootCoverage,
  compile,
} = require('../generate-authority-reference-review.cjs');
const {
  validateAuthorityDecision,
  validateSemanticReviewDecision,
} = require('../lib/authority-decision.cjs');

test('authority review covers exact external authority files and pending internal candidates', () => {
  const result = compile();
  assert.equal(result.fragment.projects.length, 13);
  assert.equal(
    result.fragment.projects.reduce((sum, project) => sum + project.files.length, 0),
    27,
  );
  const candidateRecords = result.records.filter((record) => (
    record.reviewRecord.reviewId.includes('candidate')
  ));
  assert.equal(candidateRecords.length, 3);
  for (const record of candidateRecords) {
    assert.equal(record.reviewRecord.files.length, 1);
    assert.equal(record.reviewRecord.files[0].disposition, 'usedImplementation');
    assert.equal(record.reviewRecord.files[0].inspection.decisionStatus, 'pending');
    assert.match(record.reviewRecord.decisionBoundary, /semantic-review decision remains pending/u);
  }
  const authorityFiles = result.records
    .filter((record) => !record.reviewRecord.reviewId.includes('candidate'))
    .flatMap((record) => record.reviewRecord.files);
  assert.equal(authorityFiles.length, 24);
  assert.ok(authorityFiles.every((file) => (
    file.disposition === 'usedNormative' || file.disposition === 'usedImplementation'
  )));
  const bipm = authorityFiles.find((file) => file.path.endsWith('SI-Brochure-9-EN-v4.01.pdf'));
  assert.equal(bipm.disposition, 'usedImplementation');
  assert.match(bipm.rationale, /do not define share as an SI unit/u);
  const webCaptureFiles = authorityFiles.filter(
    (file) => file.inspection.sourceLockKind === 'webPageCapture',
  );
  assert.equal(webCaptureFiles.length, 3);
  for (const file of webCaptureFiles) {
    assert.equal(file.disposition, 'usedImplementation');
    assert.equal(file.inspection.capturedAt, '2026-07-31T20:00:00Z');
    assert.equal(file.inspection.boundArtifactCount, 2);
    assert.match(file.inspection.authorityPageUrl, /^https:\/\/(?:www\.)?(?:finra\.org|investor\.gov)\//u);
  }
  const ruleText = authorityFiles.find((file) => (
    file.path.endsWith('rule-11140/content.txt')
  ));
  assert.equal(ruleText.disposition, 'usedNormative');
  assert.equal(ruleText.inspection.textLineSelections.length, 5);
  for (const explanatoryText of authorityFiles.filter((file) => (
    file.path.endsWith('notice-00-54/content.txt')
      || file.path.endsWith('ex-dividend/content.txt')
  ))) {
    assert.equal(explanatoryText.disposition, 'usedImplementation');
    assert.equal(explanatoryText.inspection.textLineSelections.length, 1);
  }
  const quantity = candidateRecords.find((record) => (
    record.reviewRecord.reviewId === 'axiolune-m2-controlled-quantity-units-candidate'
  ));
  assert.equal(
    quantity.reviewRecord.files[0].inspection.candidateDigest,
    'sha256:1b6779cecac557ce5bca4b20e4a8723d34b40a29435a545d51f28e26182087c3',
  );
  assert.equal(
    quantity.reviewRecord.files[0].inspection.semanticCandidateDigest,
    'sha256:a0e313f0eee878e539d5424998e6d46f8abcb9a392c2dba05ca98530768fb2d4',
  );
  assert.equal(quantity.reviewRecord.files[0].inspection.completeSiRegistry, false);
});

test('authority review refuses an inventory root without an explicit review boundary', () => {
  assert.throws(
    () => assertAuthorityRootCoverage(
      [{ rootPath: 'reference/authority-reference/new-authority' }],
      [{ rootPath: 'reference/authority-reference/anna' }],
    ),
    /unreviewed authority reference roots: reference\/authority-reference\/new-authority/u,
  );
});

test('authority review accepts pending and rejects repository-only adopted envelopes', () => {
  const adopted = {
    decisionTime: '2026-08-01T00:00:00Z',
    driRef: 'https://axiolune.ai/principals/test-dri',
    rationale: 'Adopt the exact reviewed candidate bytes.',
    reviewBasisRefs: ['https://axiolune.ai/reviews/m2-authority'],
    status: 'adopted',
  };
  assert.equal(validateAuthorityDecision({ status: 'pending' }), 'pending');
  assert.throws(
    () => validateAuthorityDecision(adopted),
    /terminal authority adoption is unavailable|repository-edited adopted JSON/u,
  );
  const candidateDigest = `sha256:${'a'.repeat(64)}`;
  assert.throws(
    () => validateAuthorityDecision(
      { ...adopted, candidateDigest },
      'digest-bound authority decision',
      candidateDigest,
    ),
    /terminal authority adoption is unavailable|repository-edited adopted JSON/u,
  );
  assert.throws(
    () => validateAuthorityDecision(adopted, 'unbound authority decision', candidateDigest),
    /adopted fields/u,
  );
  assert.throws(
    () => validateAuthorityDecision(
      { ...adopted, candidateDigest: `sha256:${'b'.repeat(64)}` },
      'stale authority decision',
      candidateDigest,
    ),
    /candidateDigest must equal/u,
  );
  assert.throws(
    () => validateAuthorityDecision({ ...adopted, decisionTime: '2026-08-01T00:00:00.000Z' }),
    /whole-second UTC/u,
  );
  assert.throws(
    () => validateAuthorityDecision({
      ...adopted,
      reviewBasisRefs: [
        'https://axiolune.ai/reviews/z',
        'https://axiolune.ai/reviews/a',
      ],
    }),
    /UTF-8 sorted/u,
  );
  assert.throws(
    () => validateAuthorityDecision({ status: 'pending', driRef: adopted.driRef }),
    /pending fields/u,
  );
  assert.throws(
    () => validateAuthorityDecision({ ...adopted, driRef: 'HTTPS://EXAMPLE.COM/dri' }),
    /canonical IRI/u,
  );
  assert.throws(
    () => validateAuthorityDecision({ ...adopted, decisionTime: '0000-01-01T00:00:00Z' }),
    /whole-second UTC/u,
  );
  assert.throws(
    () => validateAuthorityDecision({ ...adopted, rationale: 'invalid\ud800text' }),
    /valid-Unicode/u,
  );
});

test('semantic review is digest-bound but cannot masquerade as terminal adoption', () => {
  const candidateDigest = `sha256:${'a'.repeat(64)}`;
  const reviewed = {
    candidateDigest,
    decisionTime: '2026-08-01T00:00:00Z',
    rationale: 'Reviewed every candidate entry against the recorded source and scope evidence.',
    reviewBasisRefs: ['https://axiolune.ai/reviews/m2-authority-semantic-review'],
    reviewerRef: 'https://axiolune.ai/principals/test-reviewer',
    status: 'reviewed',
  };
  assert.equal(
    validateSemanticReviewDecision(
      reviewed,
      'digest-bound semantic review',
      candidateDigest,
    ),
    'reviewed',
  );
  assert.throws(
    () => validateSemanticReviewDecision(
      { ...reviewed, candidateDigest: `sha256:${'b'.repeat(64)}` },
      'stale semantic review',
      candidateDigest,
    ),
    /candidateDigest must equal/u,
  );
  assert.throws(
    () => validateSemanticReviewDecision(
      { ...reviewed, driRef: reviewed.reviewerRef },
      'field-smuggling semantic review',
      candidateDigest,
    ),
    /reviewed fields/u,
  );
  assert.throws(
    () => validateSemanticReviewDecision({
      ...reviewed,
      status: 'adopted',
      driRef: reviewed.reviewerRef,
    }),
    /adopted fields|terminal authority adoption is unavailable/u,
  );
});
