'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const {
  DEPENDENCY_EXTRACTOR_CAPABILITY_TAG,
  IMPLEMENTATION_PATH,
  PHASE_REGISTRY_TAG,
  ROOT_DISCOVERY_CAPABILITY_TAG,
} = require('../lib/m2-payload-independent-replay.cjs');
const {
  artifactId,
  taggedJcsDigest,
  verifyPayloadClosure,
} = require('../lib/m2-payload-closure-replay.cjs');

const ROOT_KINDS = [
  'compatibilityMigration', 'generatedProjection', 'p0Chain',
  'p1BuildAndGateEvidence', 'p1SourceTree', 'prospectiveCommit',
  'referenceClosure', 'releaseGovernanceDocumentation', 'traceability',
];

function rawDigest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function payloadRef(filePath) {
  return { kind: 'path', root: 'payload', path: filePath };
}

function fixture() {
  const artifacts = new Map();
  const sourceArtifacts = new Map();
  const leafRows = [];
  const requiredRoots = [];
  const catalogEntries = [];
  const nodes = [];
  const edges = [];
  for (let index = 0; index < ROOT_KINDS.length; index += 1) {
    const rootKind = ROOT_KINDS[index];
    const leafPath = `artifacts/${rootKind}.txt`;
    const leafBytes = Buffer.from(`evidence:${rootKind}\n`, 'utf8');
    artifacts.set(leafPath, leafBytes);
    const leafDigest = rawDigest(leafBytes);
    const leafRef = payloadRef(leafPath);
    leafRows.push({ path: leafPath, bytes: leafBytes });
    const rootManifest = {
      schemaVersion: '1.0',
      rootKind,
      artifacts: [{ artifactRef: leafRef, artifactDigest: leafDigest }],
    };
    const rootPath = `roots/${rootKind}.json`;
    const rootBytes = Buffer.from(canonicalJcs(rootManifest), 'utf8');
    artifacts.set(rootPath, rootBytes);
    const rootDigest = taggedJcsDigest(
      `axiolune-payload-required-root-${rootKind}-v1\0`,
      rootManifest,
    );
    const rootRef = payloadRef(rootPath);
    requiredRoots.push({
      rootKind,
      rootManifestRef: rootRef,
      rootManifestDigest: rootDigest,
      discoveryCapabilityRef: null,
      discoveryCapabilityDigest: null,
    });
    catalogEntries.push({
      artifactRef: rootRef,
      artifactDigest: rootDigest,
      payloadByteDigest: rawDigest(rootBytes),
      mediaType: 'application/json',
      locator: { kind: 'wholeFile', path: rootPath, byteLength: rootBytes.length },
      digestProfile: {
        kind: 'taggedJcs',
        domainTag: `axiolune-payload-required-root-${rootKind}-v1\0`,
        canonicalization: 'RFC8785-JCS',
      },
    });
    const leafNode = {
      artifactId: '',
      artifactRef: leafRef,
      artifactDigest: leafDigest,
      artifactKind: 'rawEvidence',
      phase: 'static',
      finalizationOrdinal: 0,
    };
    leafNode.artifactId = artifactId(leafNode);
    const rootNode = {
      artifactId: '',
      artifactRef: rootRef,
      artifactDigest: rootDigest,
      artifactKind: `requiredRoot-${rootKind}`,
      phase: 'payload',
      finalizationOrdinal: 10 + index,
    };
    rootNode.artifactId = artifactId(rootNode);
    nodes.push(leafNode, rootNode);
    edges.push({
      prerequisiteArtifactId: leafNode.artifactId,
      dependentArtifactId: rootNode.artifactId,
      locator: { locatorKind: 'manifestMembership', value: 'artifacts' },
    });
  }
  catalogEntries.sort((left, right) => Buffer.compare(
    Buffer.from(`${canonicalJcs(left.artifactRef)}\0${left.artifactDigest}`),
    Buffer.from(`${canonicalJcs(right.artifactRef)}\0${right.artifactDigest}`),
  ));
  const catalog = { schemaVersion: '1.0', targetVersion: '0.3.0', entries: catalogEntries };
  const catalogPath = 'payload-artifact-catalog.json';
  const catalogBytes = Buffer.from(canonicalJcs(catalog), 'utf8');
  artifacts.set(catalogPath, catalogBytes);
  const catalogRef = payloadRef(catalogPath);
  const catalogDigest = taggedJcsDigest('axiolune-payload-artifact-catalog-v1\0', catalog);
  const catalogNode = {
    artifactId: '',
    artifactRef: catalogRef,
    artifactDigest: catalogDigest,
    artifactKind: 'payloadArtifactCatalog',
    phase: 'payload',
    finalizationOrdinal: 100,
  };
  catalogNode.artifactId = artifactId(catalogNode);
  nodes.push(catalogNode);
  nodes.sort((left, right) => Buffer.compare(Buffer.from(left.artifactId), Buffer.from(right.artifactId)));
  edges.sort((left, right) => Buffer.compare(
    Buffer.from(`${left.dependentArtifactId}\0${left.prerequisiteArtifactId}\0${left.locator.locatorKind}\0${left.locator.value}`),
    Buffer.from(`${right.dependentArtifactId}\0${right.prerequisiteArtifactId}\0${right.locator.locatorKind}\0${right.locator.value}`),
  ));
  const rootIds = [
    ...requiredRoots.map((root) => nodes.find((node) => (
      canonicalJcs(node.artifactRef) === canonicalJcs(root.rootManifestRef)
        && node.artifactDigest === root.rootManifestDigest
    )).artifactId),
    catalogNode.artifactId,
  ].sort();
  const implementationBytes = fs.readFileSync(path.resolve(__dirname, '../lib/m2-payload-independent-replay.cjs'));
  sourceArtifacts.set(IMPLEMENTATION_PATH, implementationBytes);
  const implementationRef = { kind: 'path', root: 'sourceTree', path: IMPLEMENTATION_PATH };
  const implementationDigest = rawDigest(implementationBytes);
  for (const root of requiredRoots) {
    const leafPath = `artifacts/${root.rootKind}.txt`;
    const capability = {
      schemaVersion: '1.0',
      capabilityId: `discover-${root.rootKind}`,
      rootKind: root.rootKind,
      implementationRef,
      implementationDigest,
      inputContract: 'reconstructed-p1-source-tree-and-exact-payload-bytes-v1',
      selectors: [{
        selectorId: `select-${root.rootKind}`,
        sourceRoot: 'payload',
        matchKind: 'exactPath',
        path: leafPath,
      }],
    };
    const capabilityPath = `discovery/${root.rootKind}.json`;
    sourceArtifacts.set(capabilityPath, Buffer.from(canonicalJcs(capability), 'utf8'));
    root.discoveryCapabilityRef = { kind: 'path', root: 'sourceTree', path: capabilityPath };
    root.discoveryCapabilityDigest = taggedJcsDigest(ROOT_DISCOVERY_CAPABILITY_TAG, capability);
  }
  const phaseRegistry = {
    schemaVersion: '1.0',
    phases: [
      'static', 'p0Build', 'p0Verification', 'promotionAuthorization',
      'p1TreeCommit', 'p0p1Link', 'p1Build', 'payload',
      'payloadVerification', 'approvalEligibility', 'adoptionAttemptChallenge',
      'releaseApproval', 'adoptionRefUpdate', 'adoptedCheckout', 'adoptionCheck',
      'adoptionFailureEvidence', 'rollbackRefUpdate', 'adoptionVerification',
    ],
    artifactKinds: [
      { artifactKind: 'payloadArtifactCatalog', phase: 'payload', finalizationOrdinal: 100 },
      { artifactKind: 'rawEvidence', phase: 'static', finalizationOrdinal: 0 },
      ...ROOT_KINDS.map((rootKind, index) => ({
        artifactKind: `requiredRoot-${rootKind}`,
        phase: 'payload',
        finalizationOrdinal: 10 + index,
      })),
    ].sort((left, right) => Buffer.compare(Buffer.from(left.artifactKind), Buffer.from(right.artifactKind))),
  };
  const phaseRegistryPath = 'policy/phase-registry.json';
  sourceArtifacts.set(phaseRegistryPath, Buffer.from(canonicalJcs(phaseRegistry), 'utf8'));
  const extractorCapability = {
    schemaVersion: '1.0',
    capabilityId: 'payload-dependency-extractor',
    scope: 'payload',
    implementationRef,
    implementationDigest,
    rootPolicy: 'nine-required-root-manifests-plus-catalog-v1',
    dependencyPolicy: 'recursive-artifact-ref-digest-pairs-v1',
    classificationRules: [{
      ruleId: 'raw-evidence-path',
      match: { kind: 'pathPrefix', root: 'payload', value: 'artifacts/' },
      artifactKind: 'rawEvidence',
    }],
  };
  const extractorPath = 'tools/dependency-extractor.json';
  sourceArtifacts.set(extractorPath, Buffer.from(canonicalJcs(extractorCapability), 'utf8'));
  const dependency = {
    schemaVersion: '1.0',
    scope: 'payload',
    phaseRegistryRef: { kind: 'path', root: 'sourceTree', path: phaseRegistryPath },
    phaseRegistryDigest: taggedJcsDigest(PHASE_REGISTRY_TAG, phaseRegistry),
    extractorCapabilityRef: { kind: 'path', root: 'sourceTree', path: extractorPath },
    extractorCapabilityDigest: taggedJcsDigest(
      DEPENDENCY_EXTRACTOR_CAPABILITY_TAG,
      extractorCapability,
    ),
    roots: rootIds,
    nodes,
    edges,
  };
  const dependencyPath = 'payload-artifact-dependency-manifest.json';
  const dependencyBytes = Buffer.from(canonicalJcs(dependency), 'utf8');
  artifacts.set(dependencyPath, dependencyBytes);
  const p1 = {
    targetVersion: '0.3.0',
    requiredRoots,
    payloadArtifactCatalogRef: catalogRef,
    payloadArtifactCatalogDigest: catalogDigest,
    payloadArtifactDependencyManifestRef: payloadRef(dependencyPath),
    payloadArtifactDependencyManifestDigest: taggedJcsDigest(
      'axiolune-artifact-dependency-manifest-v1\0',
      dependency,
    ),
    entries: [...artifacts]
      .map(([filePath, bytes]) => ({
        path: filePath,
        mediaType: filePath.endsWith('.json') ? 'application/json' : 'text/plain',
        byteLength: bytes.length,
        payloadByteDigest: rawDigest(bytes),
      }))
      .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))),
  };
  function rewriteDependency() {
    dependency.nodes.sort((left, right) => Buffer.compare(Buffer.from(left.artifactId), Buffer.from(right.artifactId)));
    dependency.roots.sort();
    dependency.edges.sort((left, right) => Buffer.compare(
      Buffer.from(`${left.dependentArtifactId}\0${left.prerequisiteArtifactId}\0${left.locator.locatorKind}\0${left.locator.value}`),
      Buffer.from(`${right.dependentArtifactId}\0${right.prerequisiteArtifactId}\0${right.locator.locatorKind}\0${right.locator.value}`),
    ));
    const bytes = Buffer.from(canonicalJcs(dependency), 'utf8');
    artifacts.set(dependencyPath, bytes);
    p1.payloadArtifactDependencyManifestDigest = taggedJcsDigest(
      'axiolune-artifact-dependency-manifest-v1\0',
      dependency,
    );
    const row = p1.entries.find((entry) => entry.path === dependencyPath);
    row.byteLength = bytes.length;
    row.payloadByteDigest = rawDigest(bytes);
  }
  function rewriteCatalog() {
    catalog.entries.sort((left, right) => Buffer.compare(
      Buffer.from(`${canonicalJcs(left.artifactRef)}\0${left.artifactDigest}`),
      Buffer.from(`${canonicalJcs(right.artifactRef)}\0${right.artifactDigest}`),
    ));
    const oldCatalogId = catalogNode.artifactId;
    const bytes = Buffer.from(canonicalJcs(catalog), 'utf8');
    artifacts.set(catalogPath, bytes);
    const semanticDigest = taggedJcsDigest('axiolune-payload-artifact-catalog-v1\0', catalog);
    p1.payloadArtifactCatalogDigest = semanticDigest;
    catalogNode.artifactDigest = semanticDigest;
    catalogNode.artifactId = artifactId(catalogNode);
    dependency.roots = dependency.roots.map((id) => (
      id === oldCatalogId ? catalogNode.artifactId : id
    ));
    for (const edge of dependency.edges) {
      if (edge.prerequisiteArtifactId === oldCatalogId) edge.prerequisiteArtifactId = catalogNode.artifactId;
      if (edge.dependentArtifactId === oldCatalogId) edge.dependentArtifactId = catalogNode.artifactId;
    }
    const row = p1.entries.find((entry) => entry.path === catalogPath);
    row.byteLength = bytes.length;
    row.payloadByteDigest = rawDigest(bytes);
    rewriteDependency();
  }
  const trustedSourceArtifacts = new Map(
    [...sourceArtifacts].map(([filePath, bytes]) => [filePath, Buffer.from(bytes)]),
  );
  return {
    artifacts,
    sourceArtifacts,
    trustedSourceArtifacts,
    p1,
    catalog,
    dependency,
    rewriteCatalog,
    rewriteDependency,
  };
}

test('replays root manifests, catalog digests, DAG, reachability, and payload entry equation', () => {
  const value = fixture();
  const result = verifyPayloadClosure(value);
  assert.equal(result.outcome, 'passed', JSON.stringify(result.issues));
  assert.deepEqual(result.issues, []);
});

test('orphan dependency node is rejected even when the authored manifest digest is updated', () => {
  const value = fixture();
  const orphan = {
    artifactId: '',
    artifactRef: payloadRef('artifacts/orphan.txt'),
    artifactDigest: `sha256:${'c'.repeat(64)}`,
    artifactKind: 'rawEvidence',
    phase: 'static',
    finalizationOrdinal: 99,
  };
  orphan.artifactId = artifactId(orphan);
  value.dependency.nodes.push(orphan);
  value.rewriteDependency();
  const result = verifyPayloadClosure(value);
  assert.ok(result.issues.some((issue) => issue.code === 'M2_PAYLOAD_DEPENDENCY_ORPHAN'));
});

test('backward dependency edge and catalog semantic tamper fail closed', () => {
  let value = fixture();
  const rootNode = value.dependency.nodes.find((node) => node.phase === 'payload'
    && node.artifactKind.startsWith('requiredRoot-'));
  rootNode.phase = 'static';
  rootNode.finalizationOrdinal = 0;
  value.rewriteDependency();
  let result = verifyPayloadClosure(value);
  assert.ok(result.issues.some((issue) => issue.code === 'M2_PAYLOAD_DEPENDENCY_BACK_EDGE'));

  value = fixture();
  const catalogBytes = value.artifacts.get('payload-artifact-catalog.json');
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  catalog.entries[0].artifactDigest = `sha256:${'d'.repeat(64)}`;
  const changed = Buffer.from(canonicalJcs(catalog), 'utf8');
  value.artifacts.set('payload-artifact-catalog.json', changed);
  result = verifyPayloadClosure(value);
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_PAYLOAD_CATALOG_DIGEST'
      || issue.code === 'M2_PAYLOAD_CATALOG_SEMANTIC_DIGEST'
  )));
});

test('extra P1 entry fails the closure-derived entry equation', () => {
  const value = fixture();
  const bytes = Buffer.from('orphan payload file', 'utf8');
  value.artifacts.set('orphan.txt', bytes);
  value.p1.entries.push({
    path: 'orphan.txt',
    mediaType: 'text/plain',
    byteLength: bytes.length,
    payloadByteDigest: rawDigest(bytes),
  });
  value.p1.entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const result = verifyPayloadClosure(value);
  assert.ok(result.issues.some((issue) => issue.code === 'M2_PAYLOAD_ENTRY_EQUATION'));
});

test('self-consistent caller graph rewrite cannot replace independently extracted nodes or edges', () => {
  const value = fixture();
  const leaf = value.dependency.nodes.find((node) => node.artifactKind === 'rawEvidence');
  const oldId = leaf.artifactId;
  leaf.artifactKind = 'callerInventedEvidence';
  leaf.artifactId = artifactId(leaf);
  for (const edge of value.dependency.edges) {
    if (edge.prerequisiteArtifactId === oldId) edge.prerequisiteArtifactId = leaf.artifactId;
    if (edge.dependentArtifactId === oldId) edge.dependentArtifactId = leaf.artifactId;
  }
  value.rewriteDependency();
  const result = verifyPayloadClosure(value);
  assert.equal(result.outcome, 'invalid');
  assert.ok(result.issues.some((issue) => issue.code === 'M2_PAYLOAD_DEPENDENCY_REPLAY_NODES'));
  assert.ok(result.issues.some((issue) => issue.code === 'M2_PAYLOAD_DEPENDENCY_REPLAY_EDGES'));
});

test('root capability is executed: a reviewed selector rewrite cannot hide a root mismatch', () => {
  const value = fixture();
  const root = value.p1.requiredRoots.find((row) => row.rootKind === 'compatibilityMigration');
  const capabilityPath = root.discoveryCapabilityRef.path;
  const capability = JSON.parse(value.sourceArtifacts.get(capabilityPath).toString('utf8'));
  capability.selectors[0].path = 'artifacts/generatedProjection.txt';
  const bytes = Buffer.from(canonicalJcs(capability), 'utf8');
  value.sourceArtifacts.set(capabilityPath, bytes);
  value.trustedSourceArtifacts.set(capabilityPath, Buffer.from(bytes));
  root.discoveryCapabilityDigest = taggedJcsDigest(ROOT_DISCOVERY_CAPABILITY_TAG, capability);
  const result = verifyPayloadClosure(value);
  assert.equal(result.outcome, 'invalid');
  assert.ok(result.issues.some((issue) => issue.code === 'M2_PAYLOAD_ROOT_DISCOVERY_MISMATCH'));
});

test('P1 capability bytes must equal independently trusted implementation bytes', () => {
  const value = fixture();
  const changed = Buffer.concat([
    value.sourceArtifacts.get(IMPLEMENTATION_PATH),
    Buffer.from('\n// candidate-only drift\n', 'utf8'),
  ]);
  value.sourceArtifacts.set(IMPLEMENTATION_PATH, changed);
  const result = verifyPayloadClosure(value);
  assert.equal(result.outcome, 'invalid');
  assert.ok(result.issues.some((issue) => issue.code === 'M2_PAYLOAD_REPLAY_P1_TRUSTED_DRIFT'));
});

test('internally valid authored graph remains unverified without P1/trusted source replay', () => {
  const value = fixture();
  delete value.sourceArtifacts;
  delete value.trustedSourceArtifacts;
  const result = verifyPayloadClosure(value);
  assert.equal(result.outcome, 'incomplete');
  assert.deepEqual(result.issues.map((issue) => issue.code), [
    'M2_RELEASE_DEPENDENCY_EXTRACTION_REPLAY_REQUIRED',
  ]);
});

test('an extra self-authorizing catalog alias is rejected by independently discovered key-set equality', () => {
  const value = fixture();
  const leafPath = 'artifacts/compatibilityMigration.txt';
  const bytes = value.artifacts.get(leafPath);
  value.catalog.entries.push({
    artifactRef: { kind: 'iri', iri: 'https://example.invalid/unreachable-alias' },
    artifactDigest: rawDigest(bytes),
    payloadByteDigest: rawDigest(bytes),
    mediaType: 'text/plain',
    locator: { kind: 'wholeFile', path: leafPath, byteLength: bytes.length },
    digestProfile: { kind: 'rawBytes', algorithm: 'sha256' },
  });
  value.rewriteCatalog();
  const result = verifyPayloadClosure(value);
  assert.equal(result.outcome, 'invalid');
  assert.ok(result.issues.some((issue) => issue.code === 'M2_PAYLOAD_CATALOG_REPLAY_KEY_SET'));
});

test('catalog locator/profile unions are closed before any semantic replay', () => {
  const value = fixture();
  value.catalog.entries[0].digestProfile.unreviewedAlgorithm = 'accept-anything';
  value.rewriteCatalog();
  const result = verifyPayloadClosure(value);
  assert.equal(result.outcome, 'invalid');
  assert.ok(result.issues.some((issue) => issue.code === 'M2_PAYLOAD_CATALOG_DIGEST_PROFILE_SCHEMA'));
});
