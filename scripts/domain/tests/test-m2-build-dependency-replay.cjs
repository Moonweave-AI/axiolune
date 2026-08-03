'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const {
  REQUIRED_GATE_IDS,
} = require('../lib/m2-release-capability-definitions.cjs');
const {
  BUILD_GATE_ID,
  BUILD_ROOT_POLICY,
  MANIFEST_TAG,
  PHASES,
  verifyBuildDependencyReplay,
} = require('../lib/m2-build-dependency-replay.cjs');
const {
  DEPENDENCY_EXTRACTOR_CAPABILITY_TAG,
  IMPLEMENTATION_PATH,
  PHASE_REGISTRY_TAG,
  replayDependencyExtraction,
  taggedJcsDigest,
} = require('../lib/m2-payload-independent-replay.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PHASE_REGISTRY_PATH = 'trusted/build-dag-phase-registry.json';
const EXTRACTOR_PATH = 'trusted/build-dag-extractor.json';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function jcsBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function payloadRef(relativePath) {
  return { kind: 'path', root: 'payload', path: relativePath };
}

function sourceRef(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function buildFixture() {
  const artifacts = new Map();
  const sourceArtifacts = new Map();
  const implementationBytes = fs.readFileSync(path.join(ROOT, ...IMPLEMENTATION_PATH.split('/')));
  sourceArtifacts.set(IMPLEMENTATION_PATH, implementationBytes);
  const phaseRegistry = {
    schemaVersion: '1.0',
    phases: [...PHASES],
    artifactKinds: [{
      artifactKind: 'validationReport',
      phase: 'p1Build',
      finalizationOrdinal: 100,
    }],
  };
  const extractor = {
    schemaVersion: '1.0',
    capabilityId: 'build-dependency-extractor-v1',
    scope: 'build',
    implementationRef: sourceRef(IMPLEMENTATION_PATH),
    implementationDigest: sha256(implementationBytes),
    rootPolicy: BUILD_ROOT_POLICY,
    dependencyPolicy: 'recursive-artifact-ref-digest-pairs-v1',
    classificationRules: [{
      ruleId: 'validation-report',
      match: { kind: 'jcsFieldEquals', pointer: '/recordType', value: 'validationReport' },
      artifactKind: 'validationReport',
    }],
  };
  sourceArtifacts.set(PHASE_REGISTRY_PATH, jcsBytes(phaseRegistry));
  sourceArtifacts.set(EXTRACTOR_PATH, jcsBytes(extractor));
  const phaseRegistryDigest = taggedJcsDigest(PHASE_REGISTRY_TAG, phaseRegistry);
  const extractorDigest = taggedJcsDigest(DEPENDENCY_EXTRACTOR_CAPABILITY_TAG, extractor);

  const ordinaryGateIds = REQUIRED_GATE_IDS.filter((gateId) => (
    !['aggregate-pre-manifest', BUILD_GATE_ID].includes(gateId)
  ));
  const reports = new Map();
  for (const gateId of [...ordinaryGateIds, 'aggregate-pre-manifest']) {
    const report = {
      gateId,
      recordType: 'validationReport',
      result: { outcome: 'passed' },
    };
    const bytes = jcsBytes(report);
    const relativePath = `reports/${gateId}.json`;
    artifacts.set(relativePath, bytes);
    reports.set(gateId, {
      report,
      row: {
        gateId,
        reportRef: payloadRef(relativePath),
        reportDigest: sha256(bytes),
        outcome: 'passed',
      },
    });
  }

  const rootPairs = ordinaryGateIds.map((gateId) => ({
    artifactRef: reports.get(gateId).row.reportRef,
    artifactDigest: reports.get(gateId).row.reportDigest,
  }));
  const placeholderManifestPair = {
    artifactRef: { kind: 'path', root: 'buildEvidence', path: 'build/dependency-manifest.json' },
    artifactDigest: sha256(Buffer.from('placeholder')),
  };
  const extracted = replayDependencyExtraction({
    sourceArtifacts,
    trustedSourceArtifacts: new Map(sourceArtifacts),
    payloadArtifacts: artifacts,
    payloadEntries: [...artifacts].map(([relativePath, bytes]) => ({
      path: relativePath,
      payloadByteDigest: sha256(bytes),
    })),
    catalogByPair: new Map(),
    dependencyManifestRef: placeholderManifestPair.artifactRef,
    dependencyManifestDigest: placeholderManifestPair.artifactDigest,
    phaseRegistryRef: sourceRef(PHASE_REGISTRY_PATH),
    phaseRegistryDigest,
    extractorCapabilityRef: sourceRef(EXTRACTOR_PATH),
    extractorCapabilityDigest: extractorDigest,
    phases: PHASES,
    scope: 'build',
    rootPolicy: BUILD_ROOT_POLICY,
    rootPairs,
  });
  const manifest = {
    schemaVersion: '1.0',
    scope: 'build',
    phaseRegistryRef: sourceRef(PHASE_REGISTRY_PATH),
    phaseRegistryDigest,
    extractorCapabilityRef: sourceRef(EXTRACTOR_PATH),
    extractorCapabilityDigest: extractorDigest,
    roots: extracted.roots,
    nodes: extracted.nodes,
    edges: extracted.edges,
  };
  const manifestBytes = jcsBytes(manifest);
  const manifestDigest = taggedJcsDigest(MANIFEST_TAG, manifest);
  const manifestPath = 'evidence/build-dependency-manifest.json';
  artifacts.set(manifestPath, manifestBytes);

  const schemaBytes = jcsBytes({ schemaVersion: '1.0', type: 'build-dependency-manifest' });
  const schemaPath = 'trusted/build-dependency-manifest.schema.json';
  sourceArtifacts.set(schemaPath, schemaBytes);
  const buildReport = {
    gateId: BUILD_GATE_ID,
    recordType: 'validationReport',
    kindEvidence: {
      schemaRef: sourceRef(schemaPath),
      schemaDigest: sha256(schemaBytes),
      artifactRef: placeholderManifestPair.artifactRef,
      artifactDigest: manifestDigest,
    },
    result: { outcome: 'passed' },
  };
  const buildReportBytes = jcsBytes(buildReport);
  const buildReportPath = `reports/${BUILD_GATE_ID}.json`;
  artifacts.set(buildReportPath, buildReportBytes);
  reports.set(BUILD_GATE_ID, {
    report: buildReport,
    row: {
      gateId: BUILD_GATE_ID,
      reportRef: payloadRef(buildReportPath),
      reportDigest: sha256(buildReportBytes),
      outcome: 'passed',
    },
  });

  const catalog = {
    schemaVersion: '1.0',
    targetVersion: '0.3.0',
    entries: [{
      artifactRef: placeholderManifestPair.artifactRef,
      artifactDigest: manifestDigest,
      payloadByteDigest: sha256(manifestBytes),
      mediaType: 'application/json',
      locator: { kind: 'wholeFile', path: manifestPath, byteLength: manifestBytes.length },
      digestProfile: {
        kind: 'taggedJcs',
        domainTag: MANIFEST_TAG,
        canonicalization: 'RFC8785-JCS',
      },
    }],
  };
  const catalogBytes = jcsBytes(catalog);
  const catalogPath = 'payload-artifact-catalog.json';
  artifacts.set(catalogPath, catalogBytes);

  const gateReports = [...reports.values()].map(({ row }) => row)
    .sort((left, right) => compareUtf8(left.gateId, right.gateId));
  const p1 = {
    targetVersion: '0.3.0',
    entries: [...artifacts.entries()].map(([relativePath, bytes]) => ({
      path: relativePath,
      payloadByteDigest: sha256(bytes),
    })).sort((left, right) => compareUtf8(left.path, right.path)),
    gateReports,
    payloadArtifactCatalogRef: payloadRef(catalogPath),
    payloadArtifactCatalogDigest: taggedJcsDigest(
      'axiolune-payload-artifact-catalog-v1\0',
      catalog,
    ),
  };
  const requiredGates = {
    gates: REQUIRED_GATE_IDS.map((gateId) => ({
      gateId,
      dependsOn: gateId === BUILD_GATE_ID ? [...ordinaryGateIds] : [],
    })),
  };
  return {
    p1,
    requiredGates,
    artifacts,
    sourceArtifacts,
    trustedSourceArtifacts: new Map(sourceArtifacts),
    manifest,
    manifestPath,
    catalog,
    catalogPath,
    reports,
  };
}

function refreshArtifact(fixture, relativePath, value) {
  const bytes = jcsBytes(value);
  fixture.artifacts.set(relativePath, bytes);
  const entry = fixture.p1.entries.find((row) => row.path === relativePath);
  entry.payloadByteDigest = sha256(bytes);
  return bytes;
}

function rebindManifest(fixture) {
  const manifestBytes = refreshArtifact(fixture, fixture.manifestPath, fixture.manifest);
  const manifestDigest = taggedJcsDigest(MANIFEST_TAG, fixture.manifest);
  const catalogRow = fixture.catalog.entries[0];
  catalogRow.artifactDigest = manifestDigest;
  catalogRow.payloadByteDigest = sha256(manifestBytes);
  catalogRow.locator.byteLength = manifestBytes.length;
  const build = fixture.reports.get(BUILD_GATE_ID);
  build.report.kindEvidence.artifactDigest = manifestDigest;
  const buildBytes = refreshArtifact(fixture, build.row.reportRef.path, build.report);
  build.row.reportDigest = sha256(buildBytes);
  const p1BuildRow = fixture.p1.gateReports.find((row) => row.gateId === BUILD_GATE_ID);
  p1BuildRow.reportDigest = build.row.reportDigest;
  const catalogBytes = refreshArtifact(fixture, fixture.catalogPath, fixture.catalog);
  fixture.p1.payloadArtifactCatalogDigest = taggedJcsDigest(
    'axiolune-payload-artifact-catalog-v1\0',
    fixture.catalog,
  );
  const catalogEntry = fixture.p1.entries.find((row) => row.path === fixture.catalogPath);
  catalogEntry.payloadByteDigest = sha256(catalogBytes);
}

test('independently reconstructs the exact build-scope report-rooted dependency DAG', () => {
  const fixture = buildFixture();
  const result = verifyBuildDependencyReplay(fixture);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.rootCount, REQUIRED_GATE_IDS.length - 2);
  assert.equal(result.nodeCount, REQUIRED_GATE_IDS.length - 2);
  assert.equal(result.edgeCount, 0);
  assert.equal(result.callerGraphAccepted, false);
  assert.equal(result.releaseGateEvidenceEstablished, false);
  assert.equal(result.declaredEntrypointExecuted, false);
  assert.deepEqual(result.issues, []);
});

test('a self-consistent caller-authored build graph rewrite cannot replace extraction', () => {
  const fixture = buildFixture();
  fixture.manifest.roots = fixture.manifest.roots.slice(1);
  fixture.manifest.nodes = fixture.manifest.nodes.slice(1);
  rebindManifest(fixture);
  const result = verifyBuildDependencyReplay(fixture);
  assert.equal(result.outcome, 'invalid');
  assert.ok(result.issues.some((issue) => issue.code === 'M2_BUILD_DAG_REPLAY_MISMATCH'));
});

test('the fixed root set cannot omit one dependsOn ValidationReport', () => {
  const fixture = buildFixture();
  const omittedGate = fixture.requiredGates.gates
    .find((gate) => gate.gateId === BUILD_GATE_ID).dependsOn[0];
  fixture.p1.gateReports = fixture.p1.gateReports.filter((row) => row.gateId !== omittedGate);
  const result = verifyBuildDependencyReplay(fixture);
  assert.equal(result.outcome, 'incomplete');
  assert.ok(result.issues.some((issue) => issue.code === 'M2_BUILD_DAG_REPORT_ROW'));
});

test('P1 extractor policy cannot differ from independently trusted bytes', () => {
  const fixture = buildFixture();
  fixture.trustedSourceArtifacts.set(EXTRACTOR_PATH, Buffer.from('substituted', 'utf8'));
  const result = verifyBuildDependencyReplay(fixture);
  assert.equal(result.outcome, 'invalid');
  assert.ok(result.issues.some((issue) => issue.code === 'M2_PAYLOAD_REPLAY_P1_TRUSTED_DRIFT'));
});

test('generic component prerequisites do not satisfy a missing build manifest replay', () => {
  const fixture = buildFixture();
  fixture.artifacts.delete(fixture.manifestPath);
  const result = verifyBuildDependencyReplay(fixture);
  assert.equal(result.outcome, 'incomplete');
  assert.ok(result.issues.some((issue) => issue.kind === 'missing'));
});
