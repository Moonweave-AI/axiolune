'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const {
  CATALOG_TAG,
  INVENTORY_TAG,
  sha256,
  taggedJcsDigest,
  verifyGateArtifactBindingReplay,
} = require('../lib/m2-gate-artifact-binding-replay.cjs');

function bytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function sourceRef(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function buildRef(relativePath) {
  return { kind: 'path', root: 'buildEvidence', path: relativePath };
}

function payloadRef(relativePath) {
  return { kind: 'path', root: 'payload', path: relativePath };
}

function pairKey(row) {
  return `${canonicalJcs(row.artifactRef)}\0${row.artifactDigest}`;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function buildFixture() {
  const artifacts = new Map();
  const sourceArtifacts = new Map();
  const capabilityRef = sourceRef('release/capability.json');
  const entrypointRef = sourceRef('release/entrypoint.cjs');
  const discoveryRef = sourceRef('release/discovery.json');
  const schemaRef = sourceRef('release/evidence.schema.json');
  const inputRef = sourceRef('ontology/domain/finance/foundation/module.yaml');
  const subjectRef = sourceRef('ontology/domain/finance/foundation/module.yaml');
  const sourceValues = [
    [capabilityRef, bytes({ schemaVersion: '1.0', capabilityId: 'gate.m2-compile' })],
    [entrypointRef, Buffer.from("'use strict';\n", 'utf8')],
    [discoveryRef, bytes({ schemaVersion: '1.0', kind: 'module-discovery' })],
    [schemaRef, bytes({ $schema: 'https://json-schema.org/draft/2020-12/schema' })],
    [inputRef, Buffer.from('module: foundation\n', 'utf8')],
  ];
  for (const [reference, content] of sourceValues) sourceArtifacts.set(reference.path, content);

  const gate = {
    gateId: 'm2-compile',
    reportKind: 'module',
    criterionRefs: ['https://axiolune.ai/conformance/m2/0.3.0/criteria/1'],
    toolId: 'axiolune-m2-compiler',
    capabilityId: 'gate.m2-compile',
    capabilityRef,
    capabilityDigest: sha256(sourceArtifacts.get(capabilityRef.path)),
    entrypointRef,
    entrypointDigest: sha256(sourceArtifacts.get(entrypointRef.path)),
    discoveryContractRef: discoveryRef,
    discoveryContractDigest: sha256(sourceArtifacts.get(discoveryRef.path)),
    evidenceSchemaRef: schemaRef,
    evidenceSchemaDigest: sha256(sourceArtifacts.get(schemaRef.path)),
    dependsOn: [],
  };

  const inventoryRef = buildRef('gate/m2-compile.subject-inventory.json');
  const subjectDigest = sha256(sourceArtifacts.get(subjectRef.path));
  const subjectId = taggedJcsDigest('axiolune-gate-subject-v1\0', {
    gateId: gate.gateId,
    subjectRef,
    subjectDigest,
  });
  const inventory = {
    schemaVersion: '1.0',
    gateId: gate.gateId,
    discoveryContractRef: gate.discoveryContractRef,
    discoveryContractDigest: gate.discoveryContractDigest,
    subjects: [{
      subjectId,
      subjectRef,
      subjectDigest,
      classifier: 'module',
    }],
  };
  const inventoryBytes = bytes(inventory);
  const inventoryDigest = taggedJcsDigest(INVENTORY_TAG, inventory);
  const inventoryPayloadPath = 'artifacts/m2-compile.subject-inventory.json';
  artifacts.set(inventoryPayloadPath, inventoryBytes);

  const evidenceRef = buildRef('gate/m2-compile.evidence.json');
  const evidence = { schemaVersion: '1.0', outcome: 'passed', compiledModules: 1 };
  const evidenceBytes = bytes(evidence);
  const evidenceDigest = sha256(evidenceBytes);
  const evidencePayloadPath = 'artifacts/m2-compile.evidence.json';
  artifacts.set(evidencePayloadPath, evidenceBytes);

  const reportRef = payloadRef('evidence/gates/m2-compile.json');
  const report = {
    recordType: 'validationReport',
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    gateId: gate.gateId,
    reportKind: gate.reportKind,
    criterionRefs: gate.criterionRefs,
    inputs: [{
      name: 'module',
      artifactRef: inputRef,
      mediaType: 'application/yaml',
      artifactDigest: sha256(sourceArtifacts.get(inputRef.path)),
    }],
    toolId: gate.toolId,
    capabilityId: gate.capabilityId,
    capabilityRef: gate.capabilityRef,
    capabilityDigest: gate.capabilityDigest,
    entrypointRef: gate.entrypointRef,
    entrypointDigest: gate.entrypointDigest,
    discoveryContractRef: gate.discoveryContractRef,
    discoveryContractDigest: gate.discoveryContractDigest,
    subjectInventoryRef: inventoryRef,
    subjectInventoryDigest: inventoryDigest,
    kindEvidence: {
      schemaRef: gate.evidenceSchemaRef,
      schemaDigest: gate.evidenceSchemaDigest,
      artifactRef: evidenceRef,
      artifactDigest: evidenceDigest,
    },
    counts: {
      discovered: 1,
      executed: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      pending: 0,
      warnings: 0,
    },
    result: {
      outcome: 'passed',
      checks: [{
        checkId: 'compile-module',
        subjectId,
        subjectRef,
        subjectDigest,
        toolId: gate.toolId,
        capabilityId: gate.capabilityId,
        capabilityRef: gate.capabilityRef,
        capabilityDigest: gate.capabilityDigest,
        entrypointRef: gate.entrypointRef,
        entrypointDigest: gate.entrypointDigest,
        inputDigests: [sha256(sourceArtifacts.get(inputRef.path))],
        outputDigests: [evidenceDigest],
        evidenceRef,
        evidenceDigest,
        status: 'passed',
      }],
      violations: [],
      errors: [],
    },
  };
  const reportBytes = bytes(report);
  artifacts.set(reportRef.path, reportBytes);
  const reportRow = {
    gateId: gate.gateId,
    reportRef,
    reportDigest: sha256(reportBytes),
    outcome: 'passed',
  };

  const catalog = {
    schemaVersion: '1.0',
    targetVersion: '0.3.0',
    entries: [
      {
        artifactRef: inventoryRef,
        artifactDigest: inventoryDigest,
        payloadByteDigest: sha256(inventoryBytes),
        mediaType: 'application/json',
        locator: {
          kind: 'wholeFile',
          path: inventoryPayloadPath,
          byteLength: inventoryBytes.length,
        },
        digestProfile: {
          kind: 'taggedJcs',
          domainTag: INVENTORY_TAG,
          canonicalization: 'RFC8785-JCS',
        },
      },
      {
        artifactRef: evidenceRef,
        artifactDigest: evidenceDigest,
        payloadByteDigest: sha256(evidenceBytes),
        mediaType: 'application/json',
        locator: {
          kind: 'wholeFile',
          path: evidencePayloadPath,
          byteLength: evidenceBytes.length,
        },
        digestProfile: { kind: 'rawBytes', algorithm: 'sha256' },
      },
    ].sort((left, right) => compareUtf8(pairKey(left), pairKey(right))),
  };
  const catalogPath = 'payload-artifact-catalog.json';
  const catalogBytes = bytes(catalog);
  artifacts.set(catalogPath, catalogBytes);
  const entries = [...artifacts.entries()].map(([relativePath, content]) => ({
    path: relativePath,
    mediaType: 'application/json',
    byteLength: content.length,
    payloadByteDigest: sha256(content),
  })).sort((left, right) => compareUtf8(left.path, right.path));
  const p1 = {
    targetVersion: '0.3.0',
    entries,
    payloadArtifactCatalogRef: payloadRef(catalogPath),
    payloadArtifactCatalogDigest: taggedJcsDigest(CATALOG_TAG, catalog),
  };
  return {
    p1,
    manifest: { gateReports: [reportRow] },
    requiredGates: { gates: [gate] },
    artifacts,
    sourceArtifacts,
    gate,
    report,
    reportRow,
    reportRef,
    catalog,
    catalogPath,
    evidenceRef,
    evidencePayloadPath,
  };
}

function refreshPayloadEntry(fixture, relativePath, content) {
  fixture.artifacts.set(relativePath, content);
  const row = fixture.p1.entries.find((entry) => entry.path === relativePath);
  row.byteLength = content.length;
  row.payloadByteDigest = sha256(content);
}

function refreshReport(fixture) {
  const content = bytes(fixture.report);
  refreshPayloadEntry(fixture, fixture.reportRef.path, content);
  fixture.reportRow.reportDigest = sha256(content);
}

function refreshCatalog(fixture) {
  fixture.catalog.entries.sort((left, right) => compareUtf8(pairKey(left), pairKey(right)));
  const content = bytes(fixture.catalog);
  refreshPayloadEntry(fixture, fixture.catalogPath, content);
  fixture.p1.payloadArtifactCatalogDigest = taggedJcsDigest(CATALOG_TAG, fixture.catalog);
}

test('closes exact report/artifact/inventory/check bindings without claiming semantic release evidence', () => {
  const fixture = buildFixture();
  const result = verifyGateArtifactBindingReplay(fixture);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.artifactBindingsEstablished, true);
  assert.equal(result.reportCount, 1);
  assert.equal(result.subjectCount, 1);
  assert.equal(result.checkCount, 1);
  assert.equal(result.releaseGateEvidenceEstablished, false);
  assert.equal(result.declaredEntrypointExecuted, false);
  assert.equal(result.declaredDiscoveryReplayed, false);
  assert.equal(result.declaredEvidenceSchemaValidated, false);
  assert.equal(result.callerEvidenceAccepted, false);
  assert.deepEqual(result.issues, []);
});

test('rejects a GateCheck subject tuple substituted after inventory materialization', () => {
  const fixture = buildFixture();
  fixture.report.result.checks[0].subjectDigest = sha256(Buffer.from('substituted', 'utf8'));
  refreshReport(fixture);
  const result = verifyGateArtifactBindingReplay(fixture);
  assert.equal(result.outcome, 'invalid');
  assert.ok(result.issues.some((issue) => issue.code === 'M2_GATE_BINDING_CHECK_SUBJECT'));
});

test('fails incomplete when a catalog-bound evidence artifact is missing', () => {
  const fixture = buildFixture();
  fixture.artifacts.delete(fixture.evidencePayloadPath);
  const result = verifyGateArtifactBindingReplay(fixture);
  assert.equal(result.outcome, 'incomplete');
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_GATE_BINDING_ARTIFACT_MISSING' && issue.kind === 'missing'
  )));
});

test('a self-consistent caller evidence rewrite remains explicitly non-evidentiary', () => {
  const fixture = buildFixture();
  const changedBytes = bytes({ schemaVersion: '1.0', fabricated: true });
  const changedDigest = sha256(changedBytes);
  refreshPayloadEntry(fixture, fixture.evidencePayloadPath, changedBytes);
  const catalogRow = fixture.catalog.entries.find((row) => (
    canonicalJcs(row.artifactRef) === canonicalJcs(fixture.evidenceRef)
  ));
  catalogRow.artifactDigest = changedDigest;
  catalogRow.payloadByteDigest = changedDigest;
  catalogRow.locator.byteLength = changedBytes.length;
  fixture.report.kindEvidence.artifactDigest = changedDigest;
  fixture.report.result.checks[0].evidenceDigest = changedDigest;
  fixture.report.result.checks[0].outputDigests = [changedDigest];
  refreshReport(fixture);
  refreshCatalog(fixture);
  const result = verifyGateArtifactBindingReplay(fixture);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.artifactBindingsEstablished, true);
  assert.equal(result.releaseGateEvidenceEstablished, false);
  assert.equal(result.declaredEvidenceSchemaValidated, false);
  assert.equal(result.callerEvidenceAccepted, false);
});

