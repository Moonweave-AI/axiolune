#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildCoverageFromFragments,
  outputBytes,
  validateActiveCoverageBindings,
} = require('../generate-reference-review-coverage.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const COMMIT = 'd'.repeat(40);

function artifactRef(path) {
  return { kind: 'path', root: 'sourceTree', path };
}

function row(rootPath, name, digest) {
  return {
    path: `${rootPath}/${name}`,
    artifactDigest: digest,
    mediaType: 'text/plain',
    disposition: 'reviewedNoBearing',
    reviewMethod: 'fullText',
    rationale: 'fixture has no semantic bearing',
    reviewerRef: 'urn:axiolune:principal:test',
    reviewRecordRef: artifactRef('audit/review.json'),
    reviewRecordDigest: DIGEST_C,
  };
}

function fixture() {
  const rootA = 'reference/project-reference/a';
  const rootB = 'reference/axiolune-design-draft';
  return {
    fragments: [{
      schemaVersion: '1.0',
      projects: [{
        projectId: 'z-project',
        rootPath: rootA,
        releaseOrCommit: COMMIT,
        projectDigest: DIGEST_A,
        files: [row(rootA, 'z.txt', DIGEST_A)],
      }, {
        projectId: 'a-historical',
        rootPath: rootB,
        releaseOrCommit: 'descriptive-not-a-pin',
        projectDigest: DIGEST_B,
        files: [row(rootB, 'a.txt', DIGEST_B)],
      }],
    }],
    inspection: {
      ok: true,
      referenceRootDigest: DIGEST_C,
      fileCount: 2,
      projects: [{
        rootPath: rootA,
        releaseOrCommit: COMMIT,
        projectDigest: DIGEST_A,
        fileCount: 1,
      }, {
        rootPath: rootB,
        projectDigest: DIGEST_B,
        fileCount: 1,
      }],
    },
  };
}

test('aggregate is project-sorted, exact-commit pinned, and strips non-Git descriptions', () => {
  const source = fixture();
  const result = buildCoverageFromFragments(source.fragments, source.inspection);
  assert.deepEqual(result.projects.map((project) => project.projectId), [
    'a-historical',
    'z-project',
  ]);
  assert.equal('releaseOrCommit' in result.projects[0], false);
  assert.equal(result.projects[1].releaseOrCommit, COMMIT);
  assert.equal(outputBytes(result).toString('utf8'), canonicalJcs(result));
});

test('duplicate project roots and IDs fail closed', () => {
  const source = fixture();
  source.fragments[0].projects.push({ ...source.fragments[0].projects[0] });
  assert.throws(
    () => buildCoverageFromFragments(source.fragments, source.inspection),
    /duplicate/u,
  );
});

test('fragment project digest and exact Git commit must equal inventory', () => {
  const source = fixture();
  source.fragments[0].projects[0].projectDigest = DIGEST_B;
  assert.throws(
    () => buildCoverageFromFragments(source.fragments, source.inspection),
    /projectDigest/u,
  );
  const sourceCommit = fixture();
  sourceCommit.fragments[0].projects[0].releaseOrCommit = 'e'.repeat(40);
  assert.throws(
    () => buildCoverageFromFragments(sourceCommit.fragments, sourceCommit.inspection),
    /exact Git commit/u,
  );
});

test('every active evidence path is bound to an aggregate used disposition', () => {
  const source = fixture();
  const coverage = buildCoverageFromFragments(source.fragments, source.inspection);
  const activePath = 'reference/project-reference/a/z.txt';
  const activeEvidence = {
    byPath: new Map([[activePath, [{ usage: 'implementation' }]]]),
  };

  assert.throws(
    () => validateActiveCoverageBindings(coverage, activeEvidence),
    /active evidence requires a used disposition, got reviewedNoBearing/u,
  );

  const rowA = coverage.projects
    .flatMap((project) => project.files)
    .find((row) => row.path === activePath);
  rowA.disposition = 'usedImplementation';
  assert.doesNotThrow(() => validateActiveCoverageBindings(coverage, activeEvidence));

  activeEvidence.byPath.get(activePath).push({ usage: 'normative' });
  assert.doesNotThrow(() => validateActiveCoverageBindings(coverage, activeEvidence));

  rowA.disposition = 'usedNormative';
  activeEvidence.byPath.set(
    'reference/project-reference/missing/file.txt',
    [{ usage: 'implementation' }],
  );
  assert.throws(
    () => validateActiveCoverageBindings(coverage, activeEvidence),
    /active evidence has no aggregate coverage row/u,
  );
});
