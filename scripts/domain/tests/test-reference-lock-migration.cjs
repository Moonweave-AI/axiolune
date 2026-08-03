#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildReferenceLock,
  refreshInternalCandidate,
} = require('../migrate-reference-lock-v0.3.cjs');
const {
  canonicalJcs,
} = require('../lib/strict-source-locator.cjs');

const VALID_DIGEST = `sha256:${'1'.repeat(64)}`;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const REVIEWED_DECISION = Object.freeze({
  decisionTime: '2026-08-01T00:00:00Z',
  rationale: 'Review the exact authority candidate bytes and source boundaries.',
  reviewBasisRefs: ['urn:axiolune:review:m2-authority'],
  reviewerRef: 'urn:axiolune:principal:test-reviewer',
  status: 'reviewed',
});
const INTERNAL_AUTHORITY_FIXTURES = Object.freeze([
  {
    id: 'axiolune-m2-controlled-quantity-units',
    localPath: 'reference/ontology-design-reference/axiolune-controlled-quantity-units',
    fileName: 'm2-v0.3-quantity-units.json',
    finalLf: true,
  },
  {
    id: 'axiolune-m2-controlled-terminology',
    localPath: 'reference/ontology-design-reference/axiolune-controlled-terminology',
    fileName: 'm2-v0.3-terms.json',
    finalLf: false,
  },
  {
    id: 'axiolune-m2-controlled-vocabularies',
    localPath: 'reference/ontology-design-reference/axiolune-controlled-vocabularies',
    fileName: 'm2-v0.3-code-lists.json',
    finalLf: false,
  },
]);

function authorityReference() {
  return {
    id: 'unknown-authority-snapshot',
    authority: 'Fixture Authority',
    releaseOrCommit: 'fixture-snapshot',
    artifactUrl: 'https://authority.example.test/snapshot.xml',
    license: 'fixture-only',
    retrievalDate: '2026-08-01',
    maturity: 'official-current-snapshot',
    usageScope: 'restrictedNormativeEvidence',
    note: 'Mutation sentinel: the aggregate review deliberately has no row.',
    localPath: 'reference/authority-reference/fixture/2026-08-01/snapshot',
    artifactDigest: VALID_DIGEST,
    locators: [{
      kind: 'xmlElement',
      path: 'snapshot.xml',
      mediaType: 'application/xml',
      extractorProfileRef: {
        kind: 'path',
        root: 'sourceTree',
        path: 'scripts/domain/reference-extractors/xml-element-v1.json',
      },
      extractorProfileDigest: VALID_DIGEST,
      selectionDigest: VALID_DIGEST,
      elementId: 'Registry',
    }],
  };
}

test('an unknown authority lock survives absent aggregate coverage byte-for-byte by value', () => {
  const source = authorityReference();
  const authoring = { references: [source] };
  const coverage = { schemaVersion: '1.0', projects: [] };
  const result = buildReferenceLock(authoring, coverage, VALID_DIGEST, VALID_DIGEST);

  assert.equal(result.references.length, 1);
  assert.deepEqual(result.references[0], source);
  assert.deepEqual(authoring.references[0], source, 'migration must not mutate its authoring input');
});

test('a manually locked authority locator inventory is canonically sorted without mutating input', () => {
  const source = authorityReference();
  source.locators.unshift({
    kind: 'xmlElement',
    path: 'second.xml',
    mediaType: 'application/xml',
    extractorProfileRef: {
      kind: 'path',
      root: 'sourceTree',
      path: 'scripts/domain/reference-extractors/xml-element-v1.json',
    },
    extractorProfileDigest: VALID_DIGEST,
    selectionDigest: VALID_DIGEST,
    elementId: 'Second',
  });
  source.locators.push({
    kind: 'wholeFile',
    path: 'snapshot.xml',
    mediaType: 'application/xml',
    extractorProfileRef: {
      kind: 'path',
      root: 'sourceTree',
      path: 'scripts/domain/reference-extractors/whole-file-v1.json',
    },
    extractorProfileDigest: VALID_DIGEST,
    selectionDigest: VALID_DIGEST,
  });
  const before = structuredClone(source);
  const result = buildReferenceLock(
    { references: [source] },
    { schemaVersion: '1.0', projects: [] },
    VALID_DIGEST,
    VALID_DIGEST,
  );

  assert.deepEqual(
    result.references[0].locators.map((locator) => `${locator.kind}:${locator.path}`),
    [
      'xmlElement:snapshot.xml',
      'xmlElement:second.xml',
      'wholeFile:snapshot.xml',
    ],
  );
  assert.deepEqual(source, before, 'sorting must not mutate the authoring reference');
});

test('an uncovered non-authority implementation snapshot remains outside the semantic lock', () => {
  const source = {
    ...authorityReference(),
    id: 'unused-implementation-snapshot',
    localPath: 'reference/project-reference/unused-implementation',
  };
  const result = buildReferenceLock(
    { references: [source] },
    { schemaVersion: '1.0', projects: [] },
    VALID_DIGEST,
    VALID_DIGEST,
  );

  assert.deepEqual(result.references, []);
});

test('a reviewed context-only project retains its exact provenance pin without semantic locators', () => {
  const source = {
    ...authorityReference(),
    id: 'reviewed-context-snapshot',
    localPath: 'reference/ontology-design-reference/reviewed-context',
    maturity: 'official-legacy-snapshot',
    usageScope: 'implementationEvidence',
    note: 'Exact bytes are retained only to reproduce reviewed rejections.',
  };
  const coverage = {
    schemaVersion: '1.0',
    projects: [{
      projectId: 'reviewed-context',
      rootPath: source.localPath,
      releaseOrCommit: 'fixture-context-release',
      projectDigest: VALID_DIGEST,
      files: [{
        path: `${source.localPath}/context.txt`,
        disposition: 'reviewedRejected',
        mediaType: 'text/plain',
      }],
    }],
  };
  const result = buildReferenceLock(
    { references: [source] },
    coverage,
    VALID_DIGEST,
    VALID_DIGEST,
    [],
  );

  assert.equal(result.references.length, 1);
  assert.equal(result.references[0].releaseOrCommit, 'fixture-context-release');
  assert.equal(result.references[0].artifactDigest, VALID_DIGEST);
  assert.equal(result.references[0].usageScope, 'reviewedContextOnly');
  assert.deepEqual(result.references[0].locators, []);
});

test('production migration preserves an exact active selector without widening it to wholeFile', () => {
  const source = {
    ...authorityReference(),
    id: 'exact-selector-fixture',
    localPath: 'reference/project-reference/exact-selector-fixture',
  };
  const locator = {
    kind: 'rdfResource',
    path: 'evidence.rdf',
    mediaType: 'application/rdf+xml',
    extractorProfileRef: {
      kind: 'path',
      root: 'sourceTree',
      path: 'scripts/domain/reference-extractors/rdf-resource-rdfxml-v1.json',
    },
    extractorProfileDigest: VALID_DIGEST,
    selectionDigest: VALID_DIGEST,
    resourceIri: 'https://example.test/ExactResource',
  };
  const coverage = {
    schemaVersion: '1.0',
    projects: [{
      projectId: 'exact-selector-fixture',
      rootPath: source.localPath,
      projectDigest: VALID_DIGEST,
      releaseOrCommit: 'fixture-commit',
      files: [{
        path: `${source.localPath}/${locator.path}`,
        disposition: 'usedNormative',
        mediaType: locator.mediaType,
      }],
    }],
  };
  const result = buildReferenceLock(
    { references: [source] },
    coverage,
    VALID_DIGEST,
    VALID_DIGEST,
    [{ referenceId: source.id, locator }],
  );

  assert.equal(result.references.length, 1);
  assert.deepEqual(result.references[0].locators, [locator]);
  assert.equal(result.references[0].locators.some((entry) => entry.kind === 'wholeFile'), false);
});

for (const fixture of INTERNAL_AUTHORITY_FIXTURES) {
  const { localPath } = fixture;
  test(`the exact internal candidate ${localPath} is refreshed from canonical candidate bytes`, () => {
    const source = {
      ...authorityReference(),
      id: fixture.id,
      localPath,
      maturity: 'internal-authority-candidate',
      note: 'decision.status=pending; locked candidate bytes are not DRI adoption.',
    };
    const result = buildReferenceLock(
      { references: [source] },
      { schemaVersion: '1.0', projects: [] },
      VALID_DIGEST,
      VALID_DIGEST,
    );

    assert.equal(result.references.length, 1);
    const refreshed = result.references[0];
    assert.equal(refreshed.id, source.id);
    assert.equal(refreshed.localPath, source.localPath);
    assert.match(refreshed.releaseOrCommit, / candidate sha256:[0-9a-f]{64}$/u);
    assert.match(refreshed.artifactDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.notEqual(refreshed.artifactDigest, VALID_DIGEST);
    assert.equal(refreshed.locators.length, 1);
    assert.equal(refreshed.locators[0].kind, 'wholeFile');
    assert.equal(
      refreshed.locators[0].path,
      fixture.fileName,
    );
    assert.match(refreshed.locators[0].selectionDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(
      source.locators[0],
      authorityReference().locators[0],
      'migration must not mutate the authoring candidate fixture',
    );
  });
}

test('all three reviewed internal authorities refresh stale locks and malformed review fails closed', (t) => {
  const temporaryParent = path.join(ROOT, '.tmp');
  fs.mkdirSync(temporaryParent, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, 'axiolune-authority-unit-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  for (const fixture of INTERNAL_AUTHORITY_FIXTURES) {
    const sourceFile = path.join(ROOT, ...fixture.localPath.split('/'), fixture.fileName);
    const targetDirectory = path.join(temporaryRoot, ...fixture.localPath.split('/'));
    const targetFile = path.join(targetDirectory, fixture.fileName);
    fs.mkdirSync(targetDirectory, { recursive: true });
    const candidate = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    candidate.decision = {
      ...structuredClone(REVIEWED_DECISION),
      candidateDigest: candidate.candidateDigest,
    };
    const reviewedBytes = Buffer.from(
      `${canonicalJcs(candidate)}${fixture.finalLf ? '\n' : ''}`,
      'utf8',
    );
    fs.writeFileSync(targetFile, reviewedBytes);

    const staleSource = {
      ...authorityReference(),
      id: fixture.id,
      localPath: fixture.localPath,
      artifactDigest: VALID_DIGEST,
    };
    const refreshed = refreshInternalCandidate(staleSource, VALID_DIGEST, temporaryRoot);
    assert.equal(refreshed.id, fixture.id);
    assert.notEqual(refreshed.artifactDigest, VALID_DIGEST);
    assert.notEqual(refreshed.locators[0].selectionDigest, VALID_DIGEST);
    assert.equal(refreshed.locators[0].path, fixture.fileName);

    const missingField = structuredClone(candidate);
    delete missingField.decision.reviewBasisRefs;
    fs.writeFileSync(
      targetFile,
      Buffer.from(`${canonicalJcs(missingField)}${fixture.finalLf ? '\n' : ''}`, 'utf8'),
    );
    assert.throws(
      () => refreshInternalCandidate(staleSource, VALID_DIGEST, temporaryRoot),
      /reviewed fields/u,
    );

    const digestTamper = structuredClone(candidate);
    digestTamper.candidateDigest = `sha256:${'0'.repeat(64)}`;
    fs.writeFileSync(
      targetFile,
      Buffer.from(`${canonicalJcs(digestTamper)}${fixture.finalLf ? '\n' : ''}`, 'utf8'),
    );
    assert.throws(
      () => refreshInternalCandidate(staleSource, VALID_DIGEST, temporaryRoot),
      /candidate digest/u,
    );
  }
});

test('a similarly named uncovered ontology project is not preserved by prefix', () => {
  const source = {
    ...authorityReference(),
    id: 'lookalike-candidate',
    localPath: 'reference/ontology-design-reference/axiolune-controlled-vocabularies-copy',
  };
  const result = buildReferenceLock(
    { references: [source] },
    { schemaVersion: '1.0', projects: [] },
    VALID_DIGEST,
    VALID_DIGEST,
  );

  assert.deepEqual(result.references, []);
});
