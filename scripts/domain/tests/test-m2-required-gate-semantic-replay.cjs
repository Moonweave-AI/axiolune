'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PROFILE_REF,
  REPORT_KIND_BY_GATE,
  REQUIRED_GATE_IDS,
  compareUtf8,
  expectedCriterionRefsForGate,
  gateDependencies,
} = require('../lib/m2-release-capability-definitions.cjs');
const {
  INVENTORY_TAG,
  taggedJcsDigest,
} = require('../lib/m2-gate-artifact-binding-replay.cjs');
const {
  MAX_OUTPUT_BYTES,
  SEMANTIC_EVIDENCE_USE,
  SEMANTIC_IMPLEMENTATION_MODE,
  VECTOR_CATEGORIES,
  VECTOR_EVIDENCE_USE,
  applyDependencyOutcomeClosure,
  discoverSubjects,
  expectedInventory,
  verifyRequiredGateSemanticReplay,
} = require('../lib/m2-required-gate-semantic-replay.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');

const TEST_GATE = 'm3-schema';
const TOOL_ID = 'fixture-required-gate-semantic-runtime';
const ENTRYPOINT_PATH = 'scripts/domain/fixture-semantic-entrypoint.cjs';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function jcsBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function sourceRef(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function payloadRef(relativePath) {
  return { kind: 'path', root: 'payload', path: relativePath };
}

function tuple(relativePath, bytes) {
  return { ref: sourceRef(relativePath), digest: sha256(bytes) };
}

function stableDigest(value) {
  return sha256(Buffer.from(canonicalJcs(value), 'utf8'));
}

function semanticOutput(request) {
  if (request.vectorCategory !== null) {
    const table = {
      positive: ['completed', 'accepted', null, 0],
      violation: ['completed', 'violation', 'FIXTURE_VIOLATION', 0],
      tamper: ['engineFailure', 'engineFailure', 'FIXTURE_TAMPER', 2],
      emptySubject: ['engineFailure', 'engineFailure', 'FIXTURE_EMPTY', 2],
      engineFailure: ['engineFailure', 'engineFailure', 'FIXTURE_ENGINE', 2],
    };
    const [status, outcome, code, exitStatus] = table[request.vectorCategory];
    return {
      value: {
        schemaVersion: '1.0', profileRef: PROFILE_REF,
        capabilityId: `gate.${TEST_GATE}`, gateId: TEST_GATE,
        status, outcome, code, evidenceUse: VECTOR_EVIDENCE_USE,
        releaseEligibilityEvidence: false, callerEvidenceAccepted: false,
        subjectInventoryDigest: null, dependencyReportDigests: [],
        semanticDigest: stableDigest(request),
      },
      exitStatus,
    };
  }
  return {
    value: {
      schemaVersion: '1.0', profileRef: PROFILE_REF,
      capabilityId: `gate.${TEST_GATE}`, gateId: TEST_GATE,
      status: 'completed', outcome: 'passed', code: null,
      evidenceUse: SEMANTIC_EVIDENCE_USE,
      releaseEligibilityEvidence: true, callerEvidenceAccepted: false,
      subjectInventoryDigest: request.subjectInventoryDigest,
      dependencyReportDigests: request.dependencyReports
        .map((row) => row.reportDigest).sort(compareUtf8),
      semanticDigest: stableDigest(request.subjectInventory),
    },
    exitStatus: 0,
  };
}

const ENTRYPOINT_SOURCE = String.raw`'use strict';
const crypto = require('node:crypto');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  const stable = (value) => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  };
  const digest = (value) => 'sha256:' + crypto.createHash('sha256').update(Buffer.from(stable(value), 'utf8')).digest('hex');
  let status; let outcome; let code; let exitStatus;
  if (request.vectorCategory !== null) {
    const table = {
      positive: ['completed', 'accepted', null, 0],
      violation: ['completed', 'violation', 'FIXTURE_VIOLATION', 0],
      tamper: ['engineFailure', 'engineFailure', 'FIXTURE_TAMPER', 2],
      emptySubject: ['engineFailure', 'engineFailure', 'FIXTURE_EMPTY', 2],
      engineFailure: ['engineFailure', 'engineFailure', 'FIXTURE_ENGINE', 2],
    };
    [status, outcome, code, exitStatus] = table[request.vectorCategory];
  } else {
    status = 'completed'; outcome = 'passed'; code = null; exitStatus = 0;
  }
  const value = {
    schemaVersion: '1.0', profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    capabilityId: 'gate.m3-schema', gateId: 'm3-schema', status, outcome, code,
    evidenceUse: request.vectorCategory === null
      ? 'required-gate-release-eligibility-evidence'
      : 'required-gate-semantic-test-vector-only',
    releaseEligibilityEvidence: request.vectorCategory === null,
    callerEvidenceAccepted: false,
    subjectInventoryDigest: request.vectorCategory === null ? request.subjectInventoryDigest : null,
    dependencyReportDigests: request.vectorCategory === null
      ? request.dependencyReports.map((row) => row.reportDigest).sort() : [],
    semanticDigest: digest(request.vectorCategory === null ? request.subjectInventory : request),
  };
  process.stdout.write(stable(value));
  process.exitCode = exitStatus;
});
`;

function evidenceSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object', additionalProperties: false,
    required: [
      'schemaVersion', 'profileRef', 'capabilityId', 'gateId', 'status', 'outcome',
      'code', 'evidenceUse', 'releaseEligibilityEvidence', 'callerEvidenceAccepted',
      'subjectInventoryDigest', 'dependencyReportDigests', 'semanticDigest',
    ],
    properties: {
      schemaVersion: { const: '1.0' }, profileRef: { const: PROFILE_REF },
      capabilityId: { const: `gate.${TEST_GATE}` }, gateId: { const: TEST_GATE },
      status: { enum: ['completed', 'engineFailure'] },
      outcome: { enum: ['accepted', 'engineFailure', 'passed', 'violation'] },
      code: { type: ['string', 'null'] },
      evidenceUse: { enum: [SEMANTIC_EVIDENCE_USE, VECTOR_EVIDENCE_USE] },
      releaseEligibilityEvidence: { type: 'boolean' },
      callerEvidenceAccepted: { const: false },
      subjectInventoryDigest: { type: ['string', 'null'] },
      dependencyReportDigests: {
        type: 'array', uniqueItems: true,
        items: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
      },
      semanticDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    },
  };
}

function writeTrustedFile(root, relativePath, bytes) {
  const absolute = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes);
}

function buildFixture(t) {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-semantic-trusted-'));
  t.after(() => fs.rmSync(trustedRoot, { recursive: true, force: true }));
  const sourceArtifacts = new Map();
  const putSource = (relativePath, value) => {
    const bytes = Buffer.isBuffer(value) ? value : jcsBytes(value);
    sourceArtifacts.set(relativePath, bytes);
    writeTrustedFile(trustedRoot, relativePath, bytes);
    return tuple(relativePath, bytes);
  };

  const entrypoint = putSource(ENTRYPOINT_PATH, Buffer.from(ENTRYPOINT_SOURCE, 'utf8'));
  putSource('candidate/meta.json', { schemaVersion: '1.0', valid: true });

  const gates = [];
  let semantic = null;
  for (const gateId of REQUIRED_GATE_IDS) {
    const capabilityPath = `profile/gates/${gateId}/capability.json`;
    if (gateId !== TEST_GATE) {
      const capability = putSource(capabilityPath, {
        schemaVersion: '1.0', profileRef: PROFILE_REF,
        capabilityId: `gate.${gateId}`, bindingKind: 'requiredGate', stageId: null,
        subjectId: gateId,
        implementationMode: 'interface-conformance-only-not-release-eligibility-evidence',
      });
      gates.push({
        gateId, reportKind: REPORT_KIND_BY_GATE[gateId],
        criterionRefs: expectedCriterionRefsForGate(gateId),
        toolId: TOOL_ID, capabilityId: `gate.${gateId}`,
        capabilityRef: capability.ref, capabilityDigest: capability.digest,
        entrypointRef: entrypoint.ref, entrypointDigest: entrypoint.digest,
        discoveryContractRef: sourceRef(`unsupported/${gateId}/discovery.json`),
        discoveryContractDigest: `sha256:${'0'.repeat(64)}`,
        evidenceSchemaRef: sourceRef(`unsupported/${gateId}/evidence.json`),
        evidenceSchemaDigest: `sha256:${'0'.repeat(64)}`,
        dependsOn: gateDependencies(gateId),
      });
      continue;
    }

    const discovery = putSource(`profile/gates/${gateId}/discovery-contract.json`, {
      schemaVersion: '1.0', profileRef: PROFILE_REF, capabilityId: `gate.${gateId}`,
      bindingKind: 'requiredGate', stageId: null,
      strategy: {
        kind: 'sourceTreePathSet-v1',
        rules: [{ classifier: 'metaSource', pathPrefix: 'candidate/', pathSuffix: '.json' }],
      },
    });
    const schemaValue = evidenceSchema();
    const schema = putSource(`profile/gates/${gateId}/evidence.schema.json`, schemaValue);
    const vectorRows = {};
    for (const category of VECTOR_CATEGORIES) {
      const input = putSource(`profile/gates/${gateId}/vectors/${category}.json`, {
        schemaVersion: '1.0', profileRef: PROFILE_REF,
        operation: 'semanticVector', capabilityId: `gate.${gateId}`, gateId,
        vectorCategory: category, subject: category === 'emptySubject' ? null : { ok: true },
        subjectDigest: category === 'tamper' ? `sha256:${'0'.repeat(64)}` : null,
        fault: category === 'engineFailure' ? 'forced' : null,
      });
      const expected = semanticOutput({ vectorCategory: category });
      vectorRows[category] = [{
        caseId: `${gateId}.${category}`, category,
        inputRef: input.ref, inputDigest: input.digest,
        expected: {
          status: expected.value.status, outcome: expected.value.outcome,
          code: expected.value.code, exitStatus: expected.exitStatus,
          releaseEligibilityEvidence: false,
        },
      }];
    }
    const vectorsValue = {
      schemaVersion: '1.0', profileRef: PROFILE_REF,
      capabilityId: `gate.${gateId}`, categories: vectorRows,
    };
    const vectors = putSource(`profile/gates/${gateId}/test-vectors.json`, vectorsValue);
    const inputValue = {
      schemaVersion: '1.0', profileRef: PROFILE_REF, capabilityId: `gate.${gateId}`,
      operation: 'replayRequiredGate', protocol: 'stdin-jcs-v1',
      invocation: {
        argv: ['--required-gate-semantic'],
        environmentPolicy: 'offline-minimal-node-permission-v1',
        maxOutputBytes: MAX_OUTPUT_BYTES, successExitCode: 0,
        timeoutMs: 60_000,
      },
      subjectDiscoveryComponent: discovery,
      evidenceResultComponent: schema,
      testVectors: vectors,
      runtimeDependencies: [],
      permissions: { childProcess: false, fsWriteTemp: true },
    };
    const input = putSource(`profile/gates/${gateId}/input-contract.json`, inputValue);
    const outputValue = {
      schemaVersion: '1.0', profileRef: PROFILE_REF,
      capabilityId: `gate.${gateId}`, protocol: 'stdout-jcs-v1',
      canonicalization: 'RFC8785-JCS', maxOutputBytes: MAX_OUTPUT_BYTES,
      successExitCode: 0,
      subjectDiscoveryComponent: discovery,
      evidenceResultComponent: schema,
    };
    const output = putSource(`profile/gates/${gateId}/output-contract.json`, outputValue);
    const capabilityValue = {
      schemaVersion: '1.0', profileRef: PROFILE_REF,
      capabilityId: `gate.${gateId}`, bindingKind: 'requiredGate', stageId: null,
      subjectId: gateId, implementationMode: SEMANTIC_IMPLEMENTATION_MODE,
      entrypoint, inputContract: input, outputContract: output,
      subjectDiscoveryComponent: discovery, evidenceResultComponent: schema,
      testVectors: vectors, semanticImplementationArtifacts: [entrypoint],
    };
    const capability = putSource(capabilityPath, capabilityValue);
    const gate = {
      gateId, reportKind: REPORT_KIND_BY_GATE[gateId],
      criterionRefs: expectedCriterionRefsForGate(gateId),
      toolId: TOOL_ID, capabilityId: `gate.${gateId}`,
      capabilityRef: capability.ref, capabilityDigest: capability.digest,
      entrypointRef: entrypoint.ref, entrypointDigest: entrypoint.digest,
      discoveryContractRef: discovery.ref, discoveryContractDigest: discovery.digest,
      evidenceSchemaRef: schema.ref, evidenceSchemaDigest: schema.digest,
      dependsOn: gateDependencies(gateId),
    };
    gates.push(gate);
    semantic = {
      gate, discoveryValue: JSON.parse(sourceArtifacts.get(discovery.ref.path).toString('utf8')),
      capabilityValue, capabilityPath, inputValue, outputValue, schemaValue, vectorsValue,
    };
  }
  gates.sort((left, right) => compareUtf8(left.gateId, right.gateId));

  const subjects = discoverSubjects(semantic.gate, semantic.discoveryValue, sourceArtifacts);
  const inventoryValue = expectedInventory(semantic.gate, subjects);
  const inventoryDigest = taggedJcsDigest(INVENTORY_TAG, inventoryValue);
  const inventoryRef = { kind: 'path', root: 'buildEvidence', path: 'inventories/m3-schema' };
  const dependencyReports = [];
  const candidateRequest = {
    schemaVersion: '1.0', profileRef: PROFILE_REF, operation: 'replayRequiredGate',
    capabilityId: `gate.${TEST_GATE}`, gateId: TEST_GATE,
    subjectInventory: inventoryValue, subjectInventoryDigest: inventoryDigest,
    dependencyReports, vectorCategory: null, fault: null,
  };
  const evidenceValue = semanticOutput(candidateRequest).value;

  const artifacts = new Map();
  const putPayload = (relativePath, value) => {
    const bytes = Buffer.isBuffer(value) ? value : jcsBytes(value);
    artifacts.set(relativePath, bytes);
    return { ref: payloadRef(relativePath), digest: sha256(bytes), bytes };
  };
  const inventoryPayload = putPayload('evidence/m3-schema-inventory.json', inventoryValue);
  const evidencePayload = putPayload('evidence/m3-schema-evidence.json', evidenceValue);
  const build = {
    phase: 'P1ReleaseBuild',
    buildId: `sha256:${'1'.repeat(64)}`,
  };
  const reportValue = {
    schemaVersion: '1.0', profileRef: PROFILE_REF, build,
    gateId: TEST_GATE, reportKind: semantic.gate.reportKind,
    criterionRefs: semantic.gate.criterionRefs, toolId: TOOL_ID,
    capabilityId: semantic.gate.capabilityId,
    capabilityRef: semantic.gate.capabilityRef,
    capabilityDigest: semantic.gate.capabilityDigest,
    entrypointRef: semantic.gate.entrypointRef,
    entrypointDigest: semantic.gate.entrypointDigest,
    discoveryContractRef: semantic.gate.discoveryContractRef,
    discoveryContractDigest: semantic.gate.discoveryContractDigest,
    subjectInventoryRef: inventoryRef, subjectInventoryDigest: inventoryDigest,
    kindEvidence: {
      schemaRef: semantic.gate.evidenceSchemaRef,
      schemaDigest: semantic.gate.evidenceSchemaDigest,
      artifactRef: evidencePayload.ref,
      artifactDigest: evidencePayload.digest,
    },
    recordType: 'validationReport', result: { outcome: 'passed' },
  };
  const reportPayload = putPayload('evidence/m3-schema-report.json', reportValue);

  const catalogValue = {
    schemaVersion: '1.0', targetVersion: '0.3.0',
    entries: [{
      artifactRef: inventoryRef, artifactDigest: inventoryDigest,
      payloadByteDigest: inventoryPayload.digest, mediaType: 'application/json',
      locator: {
        kind: 'wholeFile', path: inventoryPayload.ref.path,
        byteLength: inventoryPayload.bytes.length,
      },
      digestProfile: {
        kind: 'taggedJcs', domainTag: INVENTORY_TAG,
        canonicalization: 'RFC8785-JCS',
      },
    }],
  };
  const catalogPayload = putPayload('payload-artifact-catalog.json', catalogValue);
  const entries = [...artifacts].map(([relativePath, bytes]) => ({
    path: relativePath, mediaType: 'application/json', byteLength: bytes.length,
    payloadByteDigest: sha256(bytes),
  })).sort((left, right) => compareUtf8(left.path, right.path));
  const p1 = {
    targetVersion: '0.3.0', build, entries,
    gateReports: [{
      gateId: TEST_GATE, reportRef: reportPayload.ref,
      reportDigest: reportPayload.digest, outcome: 'passed',
    }],
    payloadArtifactCatalogRef: catalogPayload.ref,
    payloadArtifactCatalogDigest: taggedJcsDigest(
      'axiolune-payload-artifact-catalog-v1\0',
      catalogValue,
    ),
  };
  return {
    trustedRoot, sourceArtifacts, artifacts, p1,
    requiredGates: { schemaVersion: '1.0', gates },
    semantic, reportValue, reportPayload, evidenceValue,
    evidencePath: evidencePayload.ref.path,
  };
}

function replay(fixture) {
  return verifyRequiredGateSemanticReplay({
    p1: fixture.p1, requiredGates: fixture.requiredGates,
    artifacts: fixture.artifacts, sourceArtifacts: fixture.sourceArtifacts,
    trustedRoot: fixture.trustedRoot, timeoutMs: 10_000,
  });
}

function refreshPayloadEntry(fixture, relativePath) {
  const bytes = fixture.artifacts.get(relativePath);
  const entry = fixture.p1.entries.find((row) => row.path === relativePath);
  entry.byteLength = bytes.length;
  entry.payloadByteDigest = sha256(bytes);
}

function replaceTrustedSource(fixture, relativePath, value) {
  const bytes = Buffer.isBuffer(value) ? value : jcsBytes(value);
  fixture.sourceArtifacts.set(relativePath, bytes);
  writeTrustedFile(fixture.trustedRoot, relativePath, bytes);
  return sha256(bytes);
}

function refreshSemanticReport(fixture) {
  fixture.reportValue.capabilityDigest = fixture.semantic.gate.capabilityDigest;
  fixture.reportValue.entrypointDigest = fixture.semantic.gate.entrypointDigest;
  fixture.reportValue.kindEvidence.schemaDigest = fixture.semantic.gate.evidenceSchemaDigest;
  const reportBytes = jcsBytes(fixture.reportValue);
  fixture.artifacts.set(fixture.reportPayload.ref.path, reportBytes);
  refreshPayloadEntry(fixture, fixture.reportPayload.ref.path);
  fixture.p1.gateReports[0].reportDigest = sha256(reportBytes);
}

function resealCapability(fixture) {
  const digest = replaceTrustedSource(
    fixture,
    fixture.semantic.capabilityPath,
    fixture.semantic.capabilityValue,
  );
  fixture.semantic.gate.capabilityDigest = digest;
  refreshSemanticReport(fixture);
}

function resealInputContract(fixture) {
  const tupleValue = fixture.semantic.capabilityValue.inputContract;
  tupleValue.digest = replaceTrustedSource(
    fixture,
    tupleValue.ref.path,
    fixture.semantic.inputValue,
  );
  resealCapability(fixture);
}

function resealEntrypoint(fixture, source) {
  const digest = replaceTrustedSource(
    fixture,
    ENTRYPOINT_PATH,
    Buffer.from(source, 'utf8'),
  );
  fixture.semantic.gate.entrypointDigest = digest;
  fixture.semantic.capabilityValue.entrypoint.digest = digest;
  fixture.semantic.capabilityValue.semanticImplementationArtifacts[0].digest = digest;
  resealCapability(fixture);
}

test('one reviewed semantic adapter can establish only its own gate in the exact 22-gate map', (t) => {
  const fixture = buildFixture(t);
  const result = replay(fixture);
  assert.equal(result.gateOutcomes.length, 22);
  const passed = result.gateOutcomes.filter((row) => row.releaseGateEvidenceEstablished);
  assert.deepEqual(
    passed.map((row) => row.gateId),
    [TEST_GATE],
    JSON.stringify(result.issues),
  );
  assert.equal(passed[0].declaredEntrypointExecuted, true);
  assert.equal(passed[0].declaredDiscoveryReplayed, true);
  assert.equal(passed[0].declaredEvidenceSchemaValidated, true);
  assert.equal(passed[0].kindEvidenceByteEquivalent, true);
  assert.equal(passed[0].dependencyReportsRecomputed, true);
  assert.equal(passed[0].fiveVectorCategoriesPassed, true);
  assert.equal(passed[0].callerEvidenceAccepted, false);
  assert.equal(passed[0].vectorCaseCount, 5);
  assert.equal(result.releaseGateEvidenceEstablished, false);
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_GATE_SEMANTIC_CAPABILITY_MODE'
  )));
});

test('a no-op entrypoint byte substitution is rejected before invocation', (t) => {
  const fixture = buildFixture(t);
  fixture.sourceArtifacts.set(
    ENTRYPOINT_PATH,
    Buffer.from("process.stdout.write('{}');\n", 'utf8'),
  );
  const result = replay(fixture);
  const row = result.gateOutcomes.find((item) => item.gateId === TEST_GATE);
  assert.equal(row.releaseGateEvidenceEstablished, false);
  assert.equal(row.declaredEntrypointExecuted, false);
  assert.ok(result.issues.some((issue) => (
    issue.gateId === TEST_GATE && issue.code === 'M2_GATE_SEMANTIC_CONTROL_DIGEST'
  )));
});

test('declared stdout must be exact JCS evidence bytes with no framing drift', (t) => {
  const fixture = buildFixture(t);
  resealEntrypoint(
    fixture,
    ENTRYPOINT_SOURCE.replace(
      'process.stdout.write(stable(value));',
      "process.stdout.write(stable(value) + '\\n');",
    ),
  );
  const result = replay(fixture);
  const row = result.gateOutcomes.find((item) => item.gateId === TEST_GATE);
  assert.equal(row.releaseGateEvidenceEstablished, false);
  assert.ok(result.issues.some((issue) => (
    issue.gateId === TEST_GATE && issue.code === 'M2_GATE_SEMANTIC_ENTRYPOINT_OUTPUT'
  )));
});

test('a coherently resealed capability/entrypoint tuple cannot replace trusted controls', (t) => {
  const fixture = buildFixture(t);
  const noOp = Buffer.from("process.stdout.write('{}');\n", 'utf8');
  fixture.sourceArtifacts.set(ENTRYPOINT_PATH, noOp);
  const entrypointDigest = sha256(noOp);
  const gate = fixture.requiredGates.gates.find((row) => row.gateId === TEST_GATE);
  gate.entrypointDigest = entrypointDigest;
  fixture.semantic.capabilityValue.entrypoint.digest = entrypointDigest;
  fixture.semantic.capabilityValue.semanticImplementationArtifacts[0].digest = entrypointDigest;
  const capabilityBytes = jcsBytes(fixture.semantic.capabilityValue);
  fixture.sourceArtifacts.set(fixture.semantic.capabilityPath, capabilityBytes);
  gate.capabilityDigest = sha256(capabilityBytes);
  const result = replay(fixture);
  const row = result.gateOutcomes.find((item) => item.gateId === TEST_GATE);
  assert.equal(row.releaseGateEvidenceEstablished, false);
  assert.ok(result.issues.some((issue) => (
    issue.gateId === TEST_GATE && issue.code === 'M2_GATE_SEMANTIC_CONTROL_SUBSTITUTION'
  )));
});

test('coherently resealed caller kindEvidence still loses byte-equivalence replay', (t) => {
  const fixture = buildFixture(t);
  const authored = structuredClone(fixture.evidenceValue);
  authored.semanticDigest = `sha256:${'f'.repeat(64)}`;
  const evidenceBytes = jcsBytes(authored);
  fixture.artifacts.set(fixture.evidencePath, evidenceBytes);
  refreshPayloadEntry(fixture, fixture.evidencePath);
  fixture.reportValue.kindEvidence.artifactDigest = sha256(evidenceBytes);
  const reportBytes = jcsBytes(fixture.reportValue);
  fixture.artifacts.set(fixture.reportPayload.ref.path, reportBytes);
  refreshPayloadEntry(fixture, fixture.reportPayload.ref.path);
  fixture.p1.gateReports[0].reportDigest = sha256(reportBytes);
  const result = replay(fixture);
  const row = result.gateOutcomes.find((item) => item.gateId === TEST_GATE);
  assert.equal(row.releaseGateEvidenceEstablished, false);
  assert.equal(row.kindEvidenceByteEquivalent, false);
  assert.ok(result.issues.some((issue) => (
    issue.gateId === TEST_GATE && issue.code === 'M2_GATE_SEMANTIC_EVIDENCE_MISMATCH'
  )));
});

test('caller inventory cannot hide a subject independently discovered from P1 bytes', (t) => {
  const fixture = buildFixture(t);
  fixture.sourceArtifacts.set('candidate/second.json', jcsBytes({ schemaVersion: '1.0' }));
  const result = replay(fixture);
  const row = result.gateOutcomes.find((item) => item.gateId === TEST_GATE);
  assert.equal(row.releaseGateEvidenceEstablished, false);
  assert.equal(row.declaredEntrypointExecuted, false);
  assert.ok(result.issues.some((issue) => (
    issue.gateId === TEST_GATE && issue.code === 'M2_GATE_SEMANTIC_DISCOVERY_MISMATCH'
  )));
});

test('required-gate dependencies cannot be narrowed by a coherently authored manifest row', (t) => {
  const fixture = buildFixture(t);
  fixture.semantic.gate.dependsOn = ['m2-compile'];
  const result = replay(fixture);
  assert.equal(result.releaseGateEvidenceEstablished, false);
  assert.ok(result.issues.some((issue) => issue.code === 'M2_GATE_SEMANTIC_REQUIRED_ROW'));
});

test('a trusted schema with an unsupported keyword is rejected instead of partially applied', (t) => {
  const fixture = buildFixture(t);
  fixture.semantic.schemaValue.allOf = [{ required: ['semanticDigest'] }];
  const schemaTuple = fixture.semantic.capabilityValue.evidenceResultComponent;
  schemaTuple.digest = replaceTrustedSource(
    fixture,
    schemaTuple.ref.path,
    fixture.semantic.schemaValue,
  );
  fixture.semantic.gate.evidenceSchemaDigest = schemaTuple.digest;
  fixture.semantic.inputValue.evidenceResultComponent.digest = schemaTuple.digest;
  resealInputContract(fixture);
  const result = replay(fixture);
  const row = result.gateOutcomes.find((item) => item.gateId === TEST_GATE);
  assert.equal(row.releaseGateEvidenceEstablished, false);
  assert.ok(result.issues.some((issue) => (
    issue.gateId === TEST_GATE && issue.code === 'M2_GATE_SEMANTIC_SCHEMA_KEYWORD'
  )));
});

test('an incomplete output contract cannot establish release evidence', (t) => {
  const fixture = buildFixture(t);
  delete fixture.semantic.outputValue.canonicalization;
  const outputTuple = fixture.semantic.capabilityValue.outputContract;
  outputTuple.digest = replaceTrustedSource(
    fixture,
    outputTuple.ref.path,
    fixture.semantic.outputValue,
  );
  resealCapability(fixture);
  const result = replay(fixture);
  const row = result.gateOutcomes.find((item) => item.gateId === TEST_GATE);
  assert.equal(row.releaseGateEvidenceEstablished, false);
  assert.ok(result.issues.some((issue) => (
    issue.gateId === TEST_GATE && issue.code === 'M2_GATE_SEMANTIC_OUTPUT_CONTRACT'
  )));
});

test('semantic adapters cannot opt into unrestricted child processes', (t) => {
  const fixture = buildFixture(t);
  fixture.semantic.inputValue.permissions.childProcess = true;
  resealInputContract(fixture);
  const result = replay(fixture);
  const row = result.gateOutcomes.find((item) => item.gateId === TEST_GATE);
  assert.equal(row.releaseGateEvidenceEstablished, false);
  assert.ok(result.issues.some((issue) => (
    issue.gateId === TEST_GATE && issue.code === 'M2_GATE_SEMANTIC_INPUT_CONTRACT'
  )));
});

test('isolated runtime denies host files, TCP, native bindings, child processes, and workers', (t) => {
  const fixture = buildFixture(t);
  const outside = path.join(fixture.trustedRoot, 'candidate', 'meta.json');
  const probe = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const runtimePath = require('node:path');
const childProcess = require('node:child_process');
const { Worker } = require('node:worker_threads');
const denied = { fs: false, write: false, symlink: false, net: false, binding: false, child: false, worker: false };
try { fs.readFileSync(${JSON.stringify(outside)}); } catch (error) { denied.fs = error.code === 'ERR_ACCESS_DENIED'; }
try { fs.writeFileSync(runtimePath.join(process.cwd(), 'escape.txt'), 'x'); } catch (error) { denied.write = error.code === 'ERR_ACCESS_DENIED'; }
try { fs.symlinkSync(${JSON.stringify(outside)}, runtimePath.join(process.cwd(), 'escape-link')); } catch (error) { denied.symlink = error.code === 'ERR_ACCESS_DENIED'; }
try { net.connect(9, '127.0.0.1'); } catch (error) { denied.net = error.code === 'M2_NETWORK_DENIED'; }
try { process.binding('tcp_wrap'); } catch (error) { denied.binding = error.code === 'M2_NETWORK_DENIED'; }
try { childProcess.spawnSync(process.execPath, ['-e', '0']); } catch (error) { denied.child = error.code === 'ERR_ACCESS_DENIED'; }
try { new Worker('0', { eval: true }); } catch (error) { denied.worker = error.code === 'ERR_ACCESS_DENIED'; }
if (!Object.values(denied).every(Boolean)) throw new Error('isolation probe failed ' + JSON.stringify(denied));
`;
  resealEntrypoint(
    fixture,
    ENTRYPOINT_SOURCE.replace("const crypto = require('node:crypto');", (
      `const crypto = require('node:crypto');${probe}`
    )),
  );
  const result = replay(fixture);
  const row = result.gateOutcomes.find((item) => item.gateId === TEST_GATE);
  assert.equal(
    row.releaseGateEvidenceEstablished,
    true,
    JSON.stringify(result.issues.filter((issue) => issue.gateId === TEST_GATE)),
  );
});

test('all five vector categories are mandatory even for an otherwise coherent profile', (t) => {
  const fixture = buildFixture(t);
  delete fixture.semantic.vectorsValue.categories.tamper;
  const vectorsTuple = fixture.semantic.capabilityValue.testVectors;
  vectorsTuple.digest = replaceTrustedSource(
    fixture,
    vectorsTuple.ref.path,
    fixture.semantic.vectorsValue,
  );
  fixture.semantic.inputValue.testVectors.digest = vectorsTuple.digest;
  resealInputContract(fixture);
  const result = replay(fixture);
  const row = result.gateOutcomes.find((item) => item.gateId === TEST_GATE);
  assert.equal(row.releaseGateEvidenceEstablished, false);
  assert.ok(result.issues.some((issue) => (
    issue.gateId === TEST_GATE && issue.code === 'M2_GATE_SEMANTIC_VECTOR_MANIFEST'
  )));
});

test('dependency semantic failure cascades through artifact DAG and aggregate gates', () => {
  const required = {
    gates: REQUIRED_GATE_IDS.map((gateId) => ({ gateId, dependsOn: gateDependencies(gateId) })),
  };
  const outcomes = REQUIRED_GATE_IDS.map((gateId) => ({
    gateId,
    outcome: 'passed',
    releaseGateEvidenceEstablished: gateId !== TEST_GATE,
    dependencyReportsRecomputed: true,
    issueCode: null,
  }));
  const issues = [];
  applyDependencyOutcomeClosure(required, outcomes, issues);
  for (const gateId of ['artifact-dependency-dag', 'aggregate-pre-manifest']) {
    const row = outcomes.find((item) => item.gateId === gateId);
    assert.equal(row.releaseGateEvidenceEstablished, false);
    assert.equal(row.dependencyReportsRecomputed, false);
    assert.equal(row.issueCode, 'M2_GATE_SEMANTIC_DEPENDENCY_OUTCOME');
  }
  assert.equal(issues.length, 2);
});
