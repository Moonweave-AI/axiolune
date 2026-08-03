#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const YAML = require('yaml');
const {
  canonicalJcs,
  computeSelectionDigest,
} = require('../../../scripts/domain/lib/strict-source-locator.cjs');
const {
  extractTextLineRangeBytes,
} = require('../../../scripts/domain/lib/text-line-range-source-extractor.cjs');
const {
  BUNDLE_TAG,
  computeWholeFileSelectionDigest,
  fileDigest,
  inspectReferenceBundle,
  semanticNodeId,
  u64be,
  validateReferenceClosure,
} = require('../../../scripts/domain/lib/reference-closure.cjs');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPOSITORY_ROOT, 'scripts', 'domain', 'validate-reference-closure.cjs');

function writeFile(root, relative, bytes) {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

function writeJcs(root, relative, value) {
  return writeFile(root, relative, canonicalJcs(value));
}

function writeYaml(root, relative, value) {
  return writeFile(root, relative, YAML.stringify(value));
}

function bundleDigest(root, relativeFiles) {
  const hash = crypto.createHash('sha256');
  hash.update(BUNDLE_TAG);
  hash.update(u64be(relativeFiles.length));
  for (const relative of [...relativeFiles].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const bytes = fs.readFileSync(path.join(root, ...relative.split('/')));
    const pathBytes = Buffer.from(relative, 'utf8');
    hash.update(u64be(pathBytes.length));
    hash.update(pathBytes);
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function artifactRef(relative) {
  return { kind: 'path', root: 'sourceTree', path: relative };
}

function runGit(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function buildFixture({
  git = false,
  standalone = false,
  category = 'project-reference',
  boundToolchain = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-reference-closure-'));
  const projectRel = standalone ? 'reference/axiolune-design-draft' : `reference/${category}/demo`;
  const projectAbs = path.join(root, ...projectRel.split('/'));
  const evidenceRel = `${projectRel}/evidence.txt`;
  const evidenceAbs = writeFile(root, evidenceRel, 'exact evidence bytes\n');
  const profileRel = 'toolchain/extractors/whole-file-v1.json';
  const implementationRel = 'toolchain/extractors/whole-file-v1.cjs';
  const dependencyRel = 'toolchain/lib/framing.cjs';
  const implementationAbs = boundToolchain
    ? writeFile(root, implementationRel, 'module.exports = (bytes) => bytes;\n')
    : null;
  const dependencyAbs = boundToolchain
    ? writeFile(root, dependencyRel, 'module.exports = { framing: "u64be" };\n')
    : null;
  const profile = {
    algorithm: 'return-exact-input-bytes',
    ...(boundToolchain ? {
      dependencies: [{
        dependencyDigest: fileDigest(dependencyAbs),
        dependencyRef: artifactRef(dependencyRel),
        role: 'selection-framing',
      }],
      implementationDigest: fileDigest(implementationAbs),
      implementationRef: artifactRef(implementationRel),
    } : {}),
    domainTag: 'axiolune-source-selection-v1\0',
    networkAccess: false,
    schemaVersion: '1.0',
    selectionCardinality: 'exactly-one-non-empty',
  };
  const profileAbs = writeJcs(root, profileRel, profile);
  const reviewRel = 'audit/demo-review.json';
  const reviewAbs = writeFile(root, reviewRel, '{"reviewed":true}');
  const termCardRel = 'ontology/domain/term-cards/demo.json';
  const termCardAbs = writeFile(root, termCardRel, '{"term":"Demo"}');

  let releaseOrCommit = 'fixture-v1';
  if (git) {
    runGit(projectAbs, ['init']);
    runGit(projectAbs, ['config', 'user.email', 'fixture@example.test']);
    runGit(projectAbs, ['config', 'user.name', 'Fixture']);
    runGit(projectAbs, ['add', 'evidence.txt']);
    runGit(projectAbs, ['commit', '-m', 'fixture']);
    releaseOrCommit = runGit(projectAbs, ['rev-parse', 'HEAD']);
  }

  const locator = {
    kind: 'wholeFile',
    path: 'evidence.txt',
    mediaType: 'text/plain',
    extractorProfileRef: artifactRef(profileRel),
    extractorProfileDigest: fileDigest(profileAbs),
    selectionDigest: `sha256:${'0'.repeat(64)}`,
  };
  locator.selectionDigest = computeWholeFileSelectionDigest(locator, evidenceAbs);

  const projectDigest = bundleDigest(projectAbs, ['evidence.txt']);
  const referenceDigest = bundleDigest(
    path.join(root, 'reference'),
    [`${projectRel.slice('reference/'.length)}/evidence.txt`],
  );
  const lock = {
    lockVersion: '0.3.0',
    references: [
      {
        id: 'demo',
        authority: 'Fixture Authority',
        releaseOrCommit,
        artifactUrl: 'https://example.test/demo',
        artifactDigest: projectDigest,
        license: 'MIT',
        maturity: 'fixture',
        usageScope: 'implementationEvidence',
        localPath: projectRel,
        locators: [locator],
      },
      {
        id: 'iso-paywalled',
        authority: 'ISO',
        releaseOrCommit: 'ISO fixture edition',
        artifactUrl: 'https://example.test/paywalled',
        artifactDigest: 'sha256:unavailable-paywalled',
        license: 'ISO Copyright (paywalled)',
        maturity: 'external-standard',
        usageScope: 'unavailableNormativeReference',
        locators: [],
      },
    ],
  };
  const lockRel = 'docs/ontology/references/references.lock.yaml';
  const lockAbs = writeYaml(root, lockRel, lock);

  const closure = {
    schemaVersion: '1.0',
    lockSourceRef: artifactRef(lockRel),
    lockSourceDigest: fileDigest(lockAbs),
    referenceBundleRef: artifactRef('reference'),
    referenceBundleDigest: referenceDigest,
    entries: [
      {
        referenceId: 'demo',
        availability: 'localLocked',
        releaseOrCommit,
        sourceUrl: 'https://example.test/demo',
        artifactRef: artifactRef(projectRel),
        artifactDigest: projectDigest,
        license: 'MIT',
        maturity: 'fixture',
        usageScope: 'implementationEvidence',
        locators: [locator],
      },
      {
        referenceId: 'iso-paywalled',
        availability: 'unavailablePaywalled',
        releaseOrCommit: 'ISO fixture edition',
        sourceUrl: 'https://example.test/paywalled',
        license: 'ISO Copyright (paywalled)',
        maturity: 'external-standard',
        usageScope: 'unavailableNormativeReference',
        locators: [],
      },
    ],
  };
  const closureRel = 'docs/ontology/references/reference-closure-manifest.json';
  writeJcs(root, closureRel, closure);

  const coverage = {
    schemaVersion: '1.0',
    referenceRootDigest: referenceDigest,
    projects: [{
      projectId: 'demo',
      rootPath: projectRel,
      ...(git ? { releaseOrCommit } : {}),
      projectDigest,
      files: [{
        path: evidenceRel,
        artifactDigest: fileDigest(evidenceAbs),
        mediaType: 'text/plain',
        disposition: 'usedImplementation',
        reviewMethod: 'fullText',
        rationale: 'implementation evidence fixture',
        reviewerRef: 'urn:axiolune:principal:fixture-reviewer',
        reviewRecordRef: artifactRef(reviewRel),
        reviewRecordDigest: fileDigest(reviewAbs),
      }],
    }],
  };
  const coverageRel = 'docs/ontology/references/reference-review-coverage.json';
  writeJcs(root, coverageRel, coverage);

  const sourceNode = {
    nodeId: '',
    nodeKind: 'sourceLocator',
    referenceId: 'demo',
    artifactRef: artifactRef(evidenceRel),
    artifactDigest: fileDigest(evidenceAbs),
    locator,
  };
  sourceNode.nodeId = semanticNodeId(sourceNode);
  const termNode = {
    nodeId: '',
    nodeKind: 'termCard',
    artifactRef: artifactRef(termCardRel),
    artifactDigest: fileDigest(termCardAbs),
    publicIri: 'https://example.test/ontology/Demo',
  };
  termNode.nodeId = semanticNodeId(termNode);
  const nodes = [sourceNode, termNode].sort((a, b) => Buffer.compare(Buffer.from(a.nodeId), Buffer.from(b.nodeId)));
  const trace = {
    schemaVersion: '1.0',
    artifactKind: 'referenceSupportDiagnostics',
    releaseEvidenceEligible: false,
    profileRef: artifactRef(profileRel),
    nodes,
    edges: [{
      fromNodeId: sourceNode.nodeId,
      toNodeId: termNode.nodeId,
      edgeKind: 'supportsTerm',
      assertionScope: 'implementation',
    }],
  };
  const traceRel = 'docs/domain/infrastructure/reference-support-diagnostics.json';
  writeJcs(root, traceRel, trace);

  return {
    root,
    projectAbs,
    evidenceAbs,
    implementationAbs,
    dependencyAbs,
    paths: {
      lock: path.join(root, ...lockRel.split('/')),
      closure: path.join(root, ...closureRel.split('/')),
      coverage: path.join(root, ...coverageRel.split('/')),
      trace: path.join(root, ...traceRel.split('/')),
    },
  };
}

function validate(fixture) {
  return validateReferenceClosure({ rootDir: fixture.root });
}

function errorCodes(result) {
  return new Set(result.errors.map((error) => error.code));
}

function mutateYaml(file, mutate) {
  const value = YAML.parse(fs.readFileSync(file, 'utf8'));
  mutate(value);
  fs.writeFileSync(file, YAML.stringify(value));
}

function mutateJson(file, mutate) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(value);
  fs.writeFileSync(file, canonicalJcs(value));
}

test('exact file/project/root byte closure and honest paywall state pass', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = validate(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.deepEqual(result.paywalledReferences, ['iso-paywalled']);
  assert.equal(result.stats.fileCount, 1);
  assert.equal(result.stats.coverageFileCount, 1);
});

test('trace edges reject missing or unknown assertion scope', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  mutateJson(fixture.paths.trace, (trace) => {
    trace.edges[0].assertionScope = 'claimedEquivalent';
  });
  const invalid = validate(fixture);
  assert.equal(invalid.ok, false);
  assert.ok(errorCodes(invalid).has('INVALID_TRACE_ASSERTION_SCOPE'));

  mutateJson(fixture.paths.trace, (trace) => {
    delete trace.edges[0].assertionScope;
  });
  const missing = validate(fixture);
  assert.equal(missing.ok, false);
  assert.ok(errorCodes(missing).has('MISSING_FIELD'));
});

test('extractor implementation and transitive dependency bytes are enforced', (t) => {
  const implementationFixture = buildFixture({ boundToolchain: true });
  const dependencyFixture = buildFixture({ boundToolchain: true });
  t.after(() => fs.rmSync(implementationFixture.root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(dependencyFixture.root, { recursive: true, force: true }));

  assert.equal(validate(implementationFixture).ok, true);
  fs.appendFileSync(implementationFixture.implementationAbs, '// drift\n');
  assert.ok(
    errorCodes(validate(implementationFixture)).has('EXTRACTOR_IMPLEMENTATION_DIGEST_MISMATCH'),
  );

  assert.equal(validate(dependencyFixture).ok, true);
  fs.appendFileSync(dependencyFixture.dependencyAbs, '// drift\n');
  assert.ok(
    errorCodes(validate(dependencyFixture)).has('EXTRACTOR_DEPENDENCY_DIGEST_MISMATCH'),
  );
});

test('locked textLineRange selectors execute and detect selected-byte tampering', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const profileRel = 'toolchain/extractors/whole-file-v1.json';
  const implementationRel = 'toolchain/extractors/text-line-range-v1.cjs';
  const implementationAbs = writeFile(
    fixture.root,
    implementationRel,
    'module.exports = require("text-line-range-source-extractor");\n',
  );
  const profileAbs = writeJcs(fixture.root, profileRel, {
    algorithm: 'utf8-line-range-framing-v1',
    domainTag: 'axiolune-source-selection-v1\0',
    extractorStatus: 'executable',
    implementationDigest: fileDigest(implementationAbs),
    implementationRef: artifactRef(implementationRel),
    networkAccess: false,
    schemaVersion: '1.0',
  });
  const locator = {
    kind: 'textLineRange',
    path: 'evidence.txt',
    mediaType: 'text/plain',
    extractorProfileRef: artifactRef(profileRel),
    extractorProfileDigest: fileDigest(profileAbs),
    selectionDigest: `sha256:${'0'.repeat(64)}`,
    startLine: 1,
    endLine: 1,
  };
  locator.selectionDigest = computeSelectionDigest(
    locator,
    extractTextLineRangeBytes(fs.readFileSync(fixture.evidenceAbs), 1, 1),
  );

  mutateYaml(fixture.paths.lock, (lock) => {
    lock.references[0].locators = [locator];
  });
  mutateJson(fixture.paths.closure, (closure) => {
    closure.lockSourceDigest = fileDigest(fixture.paths.lock);
    closure.entries[0].locators = [locator];
  });
  mutateJson(fixture.paths.trace, (trace) => {
    const source = trace.nodes.find((node) => node.nodeKind === 'sourceLocator');
    source.locator = locator;
    const priorId = source.nodeId;
    source.nodeId = semanticNodeId(source);
    trace.nodes.sort((a, b) => Buffer.compare(Buffer.from(a.nodeId), Buffer.from(b.nodeId)));
    trace.edges[0].fromNodeId = source.nodeId;
    assert.notEqual(source.nodeId, priorId);
  });
  assert.equal(validate(fixture).ok, true, JSON.stringify(validate(fixture).errors, null, 2));

  const tampered = { ...locator, selectionDigest: `sha256:${'a'.repeat(64)}` };
  mutateYaml(fixture.paths.lock, (lock) => {
    lock.references[0].locators = [tampered];
  });
  mutateJson(fixture.paths.closure, (closure) => {
    closure.lockSourceDigest = fileDigest(fixture.paths.lock);
    closure.entries[0].locators = [tampered];
  });
  mutateJson(fixture.paths.trace, (trace) => {
    const source = trace.nodes.find((node) => node.nodeKind === 'sourceLocator');
    source.locator = tampered;
    source.nodeId = semanticNodeId(source);
    trace.nodes.sort((a, b) => Buffer.compare(Buffer.from(a.nodeId), Buffer.from(b.nodeId)));
    trace.edges[0].fromNodeId = source.nodeId;
  });
  assert.ok(errorCodes(validate(fixture)).has('SOURCE_SELECTION_DIGEST_MISMATCH'));
});

test('read-only bundle inspection exposes the same root, project, and Git framing', (t) => {
  const fixture = buildFixture({ git: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const validation = validate(fixture);
  const inspection = inspectReferenceBundle({ rootDir: fixture.root });
  assert.equal(inspection.ok, true, JSON.stringify(inspection.errors, null, 2));
  assert.equal(inspection.referenceRootDigest, validation.stats.rootDigest);
  assert.equal(inspection.fileCount, 1);
  assert.equal(inspection.projects.length, 1);
  assert.equal(inspection.projects[0].releaseOrCommit.length, 40);
});

test('the audited historical project is accepted only at its exact standalone path', (t) => {
  const fixture = buildFixture({ standalone: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = validate(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));

  writeFile(fixture.root, 'reference/unreviewed-standalone/rogue.txt', 'rogue\n');
  const rejected = validate(fixture);
  assert.equal(rejected.ok, false);
  assert.ok(errorCodes(rejected).has('UNEXPECTED_REFERENCE_ROOT_ENTRY'));
  assert.ok(rejected.errors.some((error) => error.at === 'reference/unreviewed-standalone'));
});

test('official authority snapshots are accepted only below the authority-reference category', (t) => {
  const fixture = buildFixture({ category: 'authority-reference' });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = validate(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.equal(result.stats.projectCount, 1);
});

test('CLI exits zero only for the exact closed fixture', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [CLI, '--root', fixture.root, '--json'], {
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test('an extra real file is reported as uncovered by exact path', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  writeFile(fixture.root, 'reference/project-reference/rogue/unlisted.bin', Buffer.from([0, 1, 2, 3]));
  const result = validate(fixture);
  const codes = errorCodes(result);
  assert.equal(result.ok, false);
  assert.ok(codes.has('UNCOVERED_REFERENCE_FILE'));
  assert.ok(result.errors.some((error) => error.at.endsWith('reference/project-reference/rogue/unlisted.bin')));
});

test('fully reviewed no-bearing bytes need coverage but no semantic lock', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const reviewedRel = 'reference/project-reference/reviewed-only/readme.txt';
  const reviewedAbs = writeFile(fixture.root, reviewedRel, 'reviewed and not used\n');
  const reviewRel = 'audit/demo-review.json';
  const reviewAbs = path.join(fixture.root, ...reviewRel.split('/'));
  const projectDigest = bundleDigest(
    path.join(fixture.root, 'reference', 'project-reference', 'reviewed-only'),
    ['readme.txt'],
  );
  const rootDigest = bundleDigest(path.join(fixture.root, 'reference'), [
    'project-reference/demo/evidence.txt',
    'project-reference/reviewed-only/readme.txt',
  ]);

  mutateJson(fixture.paths.coverage, (coverage) => {
    coverage.referenceRootDigest = rootDigest;
    coverage.projects.push({
      projectId: 'reviewed-only',
      rootPath: 'reference/project-reference/reviewed-only',
      projectDigest,
      files: [{
        path: reviewedRel,
        artifactDigest: fileDigest(reviewedAbs),
        mediaType: 'text/plain',
        disposition: 'reviewedNoBearing',
        reviewMethod: 'fullText',
        rationale: 'reviewed and intentionally excluded from semantic evidence',
        reviewerRef: 'urn:axiolune:principal:fixture-reviewer',
        reviewRecordRef: artifactRef(reviewRel),
        reviewRecordDigest: fileDigest(reviewAbs),
      }],
    });
  });
  mutateJson(fixture.paths.closure, (closure) => {
    closure.referenceBundleDigest = rootDigest;
  });
  assert.equal(validate(fixture).ok, true);

  mutateJson(fixture.paths.coverage, (coverage) => {
    coverage.projects[1].files[0].disposition = 'usedImplementation';
  });
  const rejected = validate(fixture);
  assert.equal(rejected.ok, false);
  assert.ok(errorCodes(rejected).has('USED_REFERENCE_FILE_NOT_LOCKED'));
});

test('reviewedContextOnly preserves exact local provenance without semantic locators', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  mutateYaml(fixture.paths.lock, (lock) => {
    lock.references[0].usageScope = 'reviewedContextOnly';
    lock.references[0].locators = [];
  });
  mutateJson(fixture.paths.closure, (closure) => {
    closure.lockSourceDigest = fileDigest(fixture.paths.lock);
    closure.entries[0].usageScope = 'reviewedContextOnly';
    closure.entries[0].locators = [];
  });
  mutateJson(fixture.paths.coverage, (coverage) => {
    coverage.projects[0].files[0].disposition = 'reviewedRejected';
  });
  mutateJson(fixture.paths.trace, (trace) => {
    trace.nodes = trace.nodes.filter((node) => node.nodeKind !== 'sourceLocator');
    trace.edges = [];
  });

  const result = validate(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));

  mutateJson(fixture.paths.coverage, (coverage) => {
    coverage.projects[0].files[0].disposition = 'usedImplementation';
  });
  const used = validate(fixture);
  assert.equal(used.ok, false);
  assert.ok(errorCodes(used).has('USED_REFERENCE_FILE_CONTEXT_ONLY_LOCK'));
});

test('reviewedContextOnly cannot retain a semantic locator', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  mutateYaml(fixture.paths.lock, (lock) => {
    lock.references[0].usageScope = 'reviewedContextOnly';
  });
  const result = validate(fixture);
  assert.equal(result.ok, false);
  assert.ok(errorCodes(result).has('CONTEXT_ONLY_REFERENCE_HAS_LOCATORS'));
});

test('dirty Git checkout and non-exact lock commit both fail closed', (t) => {
  const fixture = buildFixture({ git: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.appendFileSync(fixture.evidenceAbs, 'dirty\n');
  mutateYaml(fixture.paths.lock, (lock) => {
    lock.references[0].releaseOrCommit = 'local-checkout';
  });
  const result = validate(fixture);
  const codes = errorCodes(result);
  assert.ok(codes.has('DIRTY_REFERENCE_GIT_CHECKOUT'));
  assert.ok(codes.has('REFERENCE_GIT_COMMIT_MISMATCH'));
});

test('legacy plain-string evidence and locator forms are rejected', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  mutateYaml(fixture.paths.lock, (lock) => {
    lock.references[0].evidenceFiles = ['reference/project-reference/demo/evidence.txt'];
    lock.references[0].locators = ['evidence.txt'];
  });
  const result = validate(fixture);
  assert.ok(errorCodes(result).has('PLAIN_STRING_LOCATOR'));
});

test('missing SourceLocator discriminant and selectionDigest are fatal', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  mutateYaml(fixture.paths.lock, (lock) => {
    delete lock.references[0].locators[0].kind;
    delete lock.references[0].locators[0].selectionDigest;
  });
  const result = validate(fixture);
  assert.ok(errorCodes(result).has('INVALID_SOURCE_LOCATOR'));
  assert.ok(result.errors.some((error) => /selectionDigest|branch/u.test(error.message)));
});

test('a structurally valid PDF page locator remains fail-closed without a portable runtime lock', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const narrow = (locator) => {
    locator.kind = 'pdfPageRange';
    locator.mediaType = 'application/pdf';
    locator.startPage = 1;
    locator.endPage = 1;
  };
  mutateYaml(fixture.paths.lock, (lock) => narrow(lock.references[0].locators[0]));
  mutateJson(fixture.paths.closure, (closure) => narrow(closure.entries[0].locators[0]));
  mutateJson(fixture.paths.coverage, (coverage) => {
    coverage.projects[0].files[0].mediaType = 'application/pdf';
  });
  mutateJson(fixture.paths.trace, (trace) => {
    const source = trace.nodes.find((node) => node.nodeKind === 'sourceLocator');
    narrow(source.locator);
    source.nodeId = semanticNodeId(source);
    trace.nodes.sort((a, b) => Buffer.compare(Buffer.from(a.nodeId), Buffer.from(b.nodeId)));
    trace.edges[0].fromNodeId = source.nodeId;
  });
  const result = validate(fixture);
  assert.equal(result.ok, false);
  assert.ok(errorCodes(result).has('SOURCE_EXTRACTOR_EXECUTION_UNAVAILABLE'));
  assert.equal(errorCodes(result).has('SOURCE_SELECTION_DIGEST_MISMATCH'), false);
});

test('trace locator not byte-identical to lock and closure is orphaned', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  mutateJson(fixture.paths.trace, (trace) => {
    const source = trace.nodes.find((node) => node.nodeKind === 'sourceLocator');
    source.locator.selectionDigest = `sha256:${'a'.repeat(64)}`;
    source.nodeId = semanticNodeId(source);
    trace.nodes.sort((a, b) => Buffer.compare(Buffer.from(a.nodeId), Buffer.from(b.nodeId)));
    trace.edges[0].fromNodeId = source.nodeId;
  });
  const result = validate(fixture);
  assert.ok(errorCodes(result).has('ORPHAN_TRACE_SOURCE_LOCATOR'));
});

test('coverage artifact digest tampering is recomputed from real bytes', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  mutateJson(fixture.paths.coverage, (coverage) => {
    coverage.projects[0].files[0].artifactDigest = `sha256:${'b'.repeat(64)}`;
  });
  const result = validate(fixture);
  assert.ok(errorCodes(result).has('REFERENCE_FILE_DIGEST_MISMATCH'));
});

test('all-zero and ad-hoc paywall placeholders are rejected', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  mutateYaml(fixture.paths.lock, (lock) => {
    lock.references[1].artifactDigest = `sha256:${'0'.repeat(64)}`;
  });
  const result = validate(fixture);
  const codes = errorCodes(result);
  assert.ok(codes.has('REFERENCE_LOCK_PLACEHOLDER_DIGEST'));
  assert.ok(codes.has('REMOTE_SNAPSHOT_BYTES_UNAVAILABLE'));
});

test('missing coverage and traceability artifacts enumerate real file blockers', (t) => {
  const fixture = buildFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.rmSync(fixture.paths.coverage);
  fs.rmSync(fixture.paths.trace);
  const result = validate(fixture);
  const codes = errorCodes(result);
  assert.ok(codes.has('MISSING_REFERENCE_REVIEW_COVERAGE'));
  assert.ok(codes.has('UNCOVERED_REFERENCE_FILE'));
  assert.ok(codes.has('MISSING_TRACEABILITY_MANIFEST'));
  assert.ok(codes.has('LOCK_LOCATOR_MISSING_FROM_TRACEABILITY'));
});
