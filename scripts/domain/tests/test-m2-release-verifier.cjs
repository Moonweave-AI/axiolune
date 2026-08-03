'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const { REASONER_GATE_IDS } = require('../lib/m2-reasoner-replay.cjs');
const {
  CRITERION_REFS,
  PROFILE_REF,
  RELEASE_CHECK_IDS,
  REPORT_KIND_BY_GATE,
  REQUIRED_GATE_IDS,
  REQUIRED_ROOT_KINDS,
  TARGET_VERSION,
  artifactDigest,
  expectedCriterionRefsForGate,
  expectedEligibilityEvidence,
  p0ReviewManifestDigest,
  p0VerificationReportDigest,
  p1PayloadManifestDigest,
  payloadVerificationReportDigest,
  releaseVerificationChecksManifestDigest,
  requiredGatesManifestDigest,
  sha256,
  validateApprovalEligibilityReport,
  validateP0ReviewManifest,
  validateP0VerificationReport,
  validateP1PayloadManifest,
  validatePayloadVerificationReport,
  validateReleaseVerificationChecksManifest,
  validateRequiredGatesManifest,
  validateValidationReport,
  verifyGateSemanticReplayCoverage,
  verifyM2Release,
} = require('../lib/m2-release-verifier.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'scripts', 'domain', 'verify-m2-release.cjs');
const REQUIRED_GATES_SCHEMA = path.join(
  ROOT,
  'scripts',
  'domain',
  'release-profile',
  'v0.3.0',
  'required-gates-manifest.schema.json',
);

function digest(label) {
  return sha256(Buffer.from(`release-verifier-test\0${label}`, 'utf8'));
}

function gitId(label) {
  return crypto.createHash('sha1').update(`git-object\0${label}`).digest('hex');
}

function artifactRef(label, root = 'sourceTree') {
  return { kind: 'path', root, path: `release-contract/${label}.json` };
}

function deepClone(value) {
  return structuredClone(value);
}

function issueCodes(issues) {
  return issues.map((issue) => issue.code);
}

function gateRow(gateId) {
  const dependencyIds = gateId === 'aggregate-pre-manifest'
    ? REQUIRED_GATE_IDS.filter((id) => id !== 'aggregate-pre-manifest')
    : gateId === 'artifact-dependency-dag'
      ? REQUIRED_GATE_IDS.filter(
        (id) => !['aggregate-pre-manifest', 'artifact-dependency-dag'].includes(id),
      )
      : [];
  const row = {
    gateId,
    reportKind: REPORT_KIND_BY_GATE[gateId],
    criterionRefs: expectedCriterionRefsForGate(gateId),
    toolId: `tool-${gateId}`,
    capabilityId: `capability-${gateId}`,
    capabilityRef: artifactRef(`capability-${gateId}`),
    capabilityDigest: digest(`capability-${gateId}`),
    entrypointRef: artifactRef(`entrypoint-${gateId}`),
    entrypointDigest: digest(`entrypoint-${gateId}`),
    discoveryContractRef: artifactRef(`discovery-${gateId}`),
    discoveryContractDigest: digest(`discovery-${gateId}`),
    evidenceSchemaRef: artifactRef(`evidence-schema-${gateId}`),
    evidenceSchemaDigest: digest(`evidence-schema-${gateId}`),
    dependsOn: dependencyIds,
  };
  return row;
}

function requiredGatesManifest() {
  return {
    schemaVersion: '1.0',
    gates: REQUIRED_GATE_IDS.map(gateRow),
  };
}

function releaseCheckRow(stageId, checkId) {
  const suffix = `${stageId}-${checkId}`;
  return {
    checkId,
    toolId: `tool-${suffix}`,
    capabilityId: `capability-${suffix}`,
    capabilityRef: artifactRef(`capability-${suffix}`),
    capabilityDigest: digest(`capability-${suffix}`),
    entrypointRef: artifactRef(`entrypoint-${suffix}`),
    entrypointDigest: digest(`entrypoint-${suffix}`),
    discoveryContractRef: artifactRef(`discovery-${suffix}`),
    discoveryContractDigest: digest(`discovery-${suffix}`),
    evidenceSchemaRef: artifactRef(`evidence-schema-${suffix}`),
    evidenceSchemaDigest: digest(`evidence-schema-${suffix}`),
    dependsOn: [],
  };
}

function releaseChecksManifest() {
  return {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    stages: Object.keys(RELEASE_CHECK_IDS).sort().map((stageId) => ({
      stageId,
      checks: RELEASE_CHECK_IDS[stageId].map((checkId) => releaseCheckRow(stageId, checkId)),
    })),
  };
}

function buildBinding(label = 'p1') {
  return {
    buildId: digest(`${label}-build-id`),
    sourceTreeDigest: digest(`${label}-source-tree`),
    toolLockRef: artifactRef('toolchain-lock'),
    toolLockDigest: digest('toolchain-lock'),
    buildInputsRef: artifactRef(`${label}-build-inputs`, 'buildEvidence'),
    buildInputsDigest: digest(`${label}-build-inputs`),
    controlRecordSchemaManifestRef: artifactRef('control-record-schema-manifest'),
    controlRecordSchemaManifestDigest: digest('control-record-schema-manifest'),
    controlRecordPlanRef: artifactRef(`${label}-control-record-plan`, 'buildEvidence'),
    controlRecordPlanDigest: digest(`${label}-control-record-plan`),
  };
}

function gateCheck(gate, suffix = 'subject') {
  return {
    checkId: `check-${suffix}`,
    subjectId: digest(`subject-id-${suffix}`),
    subjectRef: artifactRef(`subject-${suffix}`),
    subjectDigest: digest(`subject-${suffix}`),
    toolId: gate.toolId,
    capabilityId: gate.capabilityId,
    capabilityRef: gate.capabilityRef,
    capabilityDigest: gate.capabilityDigest,
    entrypointRef: gate.entrypointRef,
    entrypointDigest: gate.entrypointDigest,
    inputDigests: [digest(`input-${suffix}`)],
    outputDigests: [digest(`output-${suffix}`)],
    evidenceRef: artifactRef(`evidence-${suffix}`, 'buildEvidence'),
    evidenceDigest: digest(`evidence-${suffix}`),
    status: 'passed',
  };
}

function validationReport(gate, build = buildBinding('p1')) {
  const check = gateCheck(gate);
  const kindEvidenceRef = artifactRef(`kind-evidence-${gate.gateId}`, 'buildEvidence');
  const kindEvidenceDigest = digest(`kind-evidence-${gate.gateId}`);
  check.evidenceRef = kindEvidenceRef;
  check.evidenceDigest = kindEvidenceDigest;
  const report = {
    schemaVersion: '1.0',
    iri: `urn:axiolune:control:validationReport:${gate.gateId}`,
    slotId: `slot-${gate.gateId}`,
    reportId: `report-${gate.gateId}`,
    attemptId: 'attempt-1',
    plannedInputDigest: digest(`planned-${gate.gateId}`),
    resolvedInputDigest: digest(`resolved-${gate.gateId}`),
    recordType: 'validationReport',
    profileRef: PROFILE_REF,
    gateId: gate.gateId,
    reportKind: gate.reportKind,
    criterionRefs: gate.criterionRefs,
    subjectRef: artifactRef(`gate-subject-${gate.gateId}`),
    build,
    inputs: [{
      name: 'primary-input',
      artifactRef: artifactRef(`gate-input-${gate.gateId}`),
      mediaType: 'application/json',
      artifactDigest: digest(`gate-input-${gate.gateId}`),
    }],
    toolId: gate.toolId,
    capabilityId: gate.capabilityId,
    capabilityRef: gate.capabilityRef,
    capabilityDigest: gate.capabilityDigest,
    entrypointRef: gate.entrypointRef,
    entrypointDigest: gate.entrypointDigest,
    discoveryContractRef: gate.discoveryContractRef,
    discoveryContractDigest: gate.discoveryContractDigest,
    subjectInventoryRef: artifactRef(`subject-inventory-${gate.gateId}`, 'buildEvidence'),
    subjectInventoryDigest: digest(`subject-inventory-${gate.gateId}`),
    kindEvidence: {
      schemaRef: gate.evidenceSchemaRef,
      schemaDigest: gate.evidenceSchemaDigest,
      artifactRef: kindEvidenceRef,
      artifactDigest: kindEvidenceDigest,
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
      checks: [check],
      violations: [],
      errors: [],
    },
  };
  if (gate.reportKind === 'pit') {
    Object.assign(report, {
      requestRef: artifactRef(`pit-request-${gate.gateId}`, 'buildEvidence'),
      requestRecordDigest: digest(`pit-request-${gate.gateId}`),
      contextRef: artifactRef(`pit-context-${gate.gateId}`, 'buildEvidence'),
      contextRecordDigest: digest(`pit-context-${gate.gateId}`),
      recomputedTargetDigest: digest(`pit-target-${gate.gateId}`),
      asOfValid: '2026-07-31T00:00:00Z',
      asOfKnowledge: '2026-07-31T00:00:00Z',
      asOfAvailable: '2026-07-31T00:00:00Z',
    });
  }
  if (gate.reportKind === 'batch') {
    Object.assign(report, {
      memberRunRecordDigests: [digest(`batch-member-${gate.gateId}`)],
      outputDatasetDigest: digest(`batch-output-${gate.gateId}`),
    });
  }
  return report;
}

function gateReportRows() {
  return REQUIRED_GATE_IDS.map((gateId) => ({
    gateId,
    reportRef: { kind: 'path', root: 'payload', path: `evidence/gates/${gateId}.json` },
    reportDigest: digest(`gate-report-${gateId}`),
    outcome: 'passed',
  }));
}

function payloadEntries() {
  return [{
    path: 'artifacts/release-input.json',
    mediaType: 'application/json',
    byteLength: 17,
    payloadByteDigest: digest('release-input-bytes'),
  }];
}

function verifierCheck(row, status = 'passed') {
  const passed = status === 'passed';
  return {
    checkId: row.checkId,
    toolId: row.toolId,
    capabilityId: row.capabilityId,
    capabilityRef: row.capabilityRef,
    capabilityDigest: row.capabilityDigest,
    entrypointRef: row.entrypointRef,
    entrypointDigest: row.entrypointDigest,
    discoveryContractRef: row.discoveryContractRef,
    discoveryContractDigest: row.discoveryContractDigest,
    evidenceSchemaRef: row.evidenceSchemaRef,
    evidenceSchemaDigest: row.evidenceSchemaDigest,
    subjectInventoryRef: artifactRef(`inventory-${row.checkId}`, 'buildEvidence'),
    subjectInventoryDigest: digest(`inventory-${row.checkId}`),
    counts: {
      discovered: 1,
      executed: 1,
      passed: passed ? 1 : 0,
      failed: passed ? 0 : 1,
    },
    evidenceRef: artifactRef(`check-evidence-${row.checkId}`, 'buildEvidence'),
    evidenceDigest: digest(`check-evidence-${row.checkId}`),
    status,
  };
}

function stageChecks(manifest, stageId, status = 'passed') {
  return manifest.stages.find((stage) => stage.stageId === stageId).checks
    .map((row) => verifierCheck(row, status));
}

function p0ReviewManifest(required, checks, build = buildBinding('p0')) {
  const reviewCommitId = gitId('p0-review-commit');
  return {
    schemaVersion: '1.0',
    phase: 'P0-review',
    targetVersion: TARGET_VERSION,
    repositoryId: 'urn:axiolune:repository:m2',
    authoritativeRef: 'refs/heads/release/m2-v0.3.0',
    expectedOldCommitId: reviewCommitId,
    gitObjectFormat: 'sha1',
    reviewCommitId,
    reviewTreeId: gitId('p0-review-tree'),
    build,
    requiredGatesManifestRef: artifactRef('required-gates-manifest'),
    requiredGatesManifestDigest: requiredGatesManifestDigest(required),
    releaseVerificationChecksManifestRef: artifactRef('release-verification-checks-manifest'),
    releaseVerificationChecksManifestDigest: releaseVerificationChecksManifestDigest(checks),
    evidenceLedgerRef: artifactRef('p0-evidence-ledger', 'buildEvidence'),
    evidenceLedgerDigest: digest('p0-evidence-ledger'),
    gateReports: gateReportRows(),
    entries: payloadEntries(),
  };
}

function p0VerificationReport(p0, checks) {
  return {
    schemaVersion: '1.0',
    repositoryId: p0.repositoryId,
    authoritativeRef: p0.authoritativeRef,
    expectedOldCommitId: p0.expectedOldCommitId,
    gitObjectFormat: p0.gitObjectFormat,
    p0ManifestRef: { kind: 'path', root: 'payload', path: 'evidence/p0-review-manifest.json' },
    p0ManifestDigest: p0ReviewManifestDigest(p0),
    reviewCommitId: p0.reviewCommitId,
    reviewTreeId: p0.reviewTreeId,
    buildId: p0.build.buildId,
    sourceTreeDigest: p0.build.sourceTreeDigest,
    buildInputsDigest: p0.build.buildInputsDigest,
    toolLockDigest: p0.build.toolLockDigest,
    verifierRef: artifactRef('release-verifier'),
    verifierDigest: digest('release-verifier'),
    checks: stageChecks(checks, 'p0Verification'),
    outcome: 'passed',
    errors: [],
  };
}

function p1PayloadManifest(required, checks, p0, p0Verification, build = buildBinding('p1')) {
  return {
    schemaVersion: '1.0',
    phase: 'P1-release-candidate',
    targetVersion: TARGET_VERSION,
    repositoryId: p0.repositoryId,
    authoritativeRef: p0.authoritativeRef,
    expectedOldCommitId: p0.expectedOldCommitId,
    prospectiveCommitId: gitId('p1-prospective-commit'),
    treeId: gitId('p1-tree'),
    parentCommitId: p0.reviewCommitId,
    gitObjectFormat: 'sha1',
    sourceTreeManifestRef: artifactRef('p1-source-tree-manifest', 'buildEvidence'),
    sourceTreeManifestDigest: digest('p1-source-tree-manifest'),
    build,
    requiredGatesManifestRef: artifactRef('required-gates-manifest'),
    requiredGatesManifestDigest: requiredGatesManifestDigest(required),
    releaseVerificationChecksManifestRef: artifactRef('release-verification-checks-manifest'),
    releaseVerificationChecksManifestDigest: releaseVerificationChecksManifestDigest(checks),
    evidenceLedgerRef: artifactRef('p1-evidence-ledger', 'buildEvidence'),
    evidenceLedgerDigest: digest('p1-evidence-ledger'),
    gateReports: gateReportRows(),
    p0ManifestRef: { kind: 'path', root: 'payload', path: 'evidence/p0-review-manifest.json' },
    p0ManifestDigest: p0ReviewManifestDigest(p0),
    p0VerificationReportRef: { kind: 'path', root: 'payload', path: 'evidence/p0-verification-report.json' },
    p0VerificationReportDigest: p0VerificationReportDigest(p0Verification),
    promotionAuthorizationRef: { kind: 'path', root: 'payload', path: 'evidence/promotion-authorization.json' },
    promotionAuthorizationDigest: digest('promotion-authorization'),
    p0P1LinkRef: { kind: 'path', root: 'payload', path: 'evidence/p0-p1-link.json' },
    p0P1LinkDigest: digest('p0-p1-link'),
    requiredRoots: REQUIRED_ROOT_KINDS.map((rootKind) => ({
      rootKind,
      rootManifestRef: { kind: 'path', root: 'payload', path: `roots/${rootKind}.json` },
      rootManifestDigest: digest(`root-${rootKind}`),
      discoveryCapabilityRef: artifactRef(`root-discovery-${rootKind}`),
      discoveryCapabilityDigest: digest(`root-discovery-${rootKind}`),
    })),
    payloadArtifactCatalogRef: { kind: 'path', root: 'payload', path: 'payload-artifact-catalog.json' },
    payloadArtifactCatalogDigest: digest('payload-artifact-catalog'),
    payloadArtifactDependencyManifestRef: { kind: 'path', root: 'payload', path: 'payload-artifact-dependency-manifest.json' },
    payloadArtifactDependencyManifestDigest: digest('payload-artifact-dependency-manifest'),
    entries: payloadEntries(),
  };
}

function payloadVerificationReport(p1, checks) {
  return {
    schemaVersion: '1.0',
    repositoryId: p1.repositoryId,
    authoritativeRef: p1.authoritativeRef,
    expectedOldCommitId: p1.expectedOldCommitId,
    gitObjectFormat: p1.gitObjectFormat,
    payloadManifestRef: { kind: 'path', root: 'payload', path: 'payload-manifest.json' },
    payloadManifestDigest: p1PayloadManifestDigest(p1),
    prospectiveCommitId: p1.prospectiveCommitId,
    treeId: p1.treeId,
    sourceTreeDigest: p1.build.sourceTreeDigest,
    buildId: p1.build.buildId,
    buildInputsDigest: p1.build.buildInputsDigest,
    toolLockDigest: p1.build.toolLockDigest,
    verifierRef: artifactRef('release-verifier'),
    verifierDigest: digest('release-verifier'),
    checks: stageChecks(checks, 'payloadVerification'),
    outcome: 'passed',
    errors: [],
  };
}

function eligibilityReport(required, checks, p1, payloadVerification) {
  const report = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    targetVersion: TARGET_VERSION,
    build: p1.build,
    aggregateReportRef: p1.gateReports[0].reportRef,
    aggregateReportDigest: p1.gateReports[0].reportDigest,
    payloadManifestRef: payloadVerification.payloadManifestRef,
    payloadManifestDigest: payloadVerification.payloadManifestDigest,
    payloadVerificationReportRef: {
      kind: 'path', root: 'payload', path: 'evidence/payload-verification-report.json',
    },
    payloadVerificationReportDigest: digest('payload-verification-report-placeholder'),
    verifierRef: artifactRef('release-verifier'),
    verifierDigest: digest('release-verifier'),
    checks: stageChecks(checks, 'approvalEligibility'),
    result: {
      outcome: 'eligible',
      criteria: [],
      errors: [],
    },
  };
  report.result.criteria = CRITERION_REFS.map((criterionRef) => ({
    criterionRef,
    status: 'satisfied',
    evidence: expectedEligibilityEvidence(
      criterionRef,
      required,
      p1,
      payloadVerification,
      report,
    ),
  }));
  return report;
}

function materializedGateReports(required, build, prefix) {
  const artifacts = [];
  const rows = required.gates.map((gate) => {
    const report = validationReport(gate, build);
    const relativePath = `evidence/${prefix}-gates/${gate.gateId}.json`;
    artifacts.push({ relativePath, value: report });
    return {
      gateId: gate.gateId,
      reportRef: { kind: 'path', root: 'payload', path: relativePath },
      reportDigest: artifactDigest(report),
      outcome: 'passed',
    };
  });
  return { artifacts, rows };
}

function writeJcs(root, relativePath, value) {
  const destination = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(canonicalJcs(value), 'utf8'));
}

function materializeStaticCandidate(root) {
  const required = requiredGatesManifest();
  const checks = releaseChecksManifest();
  const p0Build = buildBinding('p0');
  const p1Build = buildBinding('p1');
  const p0Gates = materializedGateReports(required, p0Build, 'p0');
  const p0 = p0ReviewManifest(required, checks, p0Build);
  p0.gateReports = p0Gates.rows;
  const p0Verification = p0VerificationReport(p0, checks);
  const p1Gates = materializedGateReports(required, p1Build, 'p1');
  const p1 = p1PayloadManifest(required, checks, p0, p0Verification, p1Build);
  p1.gateReports = p1Gates.rows;
  const payloadVerification = payloadVerificationReport(p1, checks);
  const eligibility = eligibilityReport(required, checks, p1, payloadVerification);
  eligibility.payloadVerificationReportDigest = payloadVerificationReportDigest(payloadVerification);
  eligibility.result.criteria = CRITERION_REFS.map((criterionRef) => ({
    criterionRef,
    status: 'satisfied',
    evidence: expectedEligibilityEvidence(
      criterionRef,
      required,
      p1,
      payloadVerification,
      eligibility,
    ),
  }));

  const documents = {
    'required-gates-manifest.json': required,
    'release-verification-checks-manifest.json': checks,
    'evidence/p0-review-manifest.json': p0,
    'evidence/p0-verification-report.json': p0Verification,
    'payload-manifest.json': p1,
    'evidence/payload-verification-report.json': payloadVerification,
    'evidence/approval-eligibility-report.json': eligibility,
  };
  for (const { relativePath, value } of [...p0Gates.artifacts, ...p1Gates.artifacts]) {
    documents[relativePath] = value;
  }
  for (const [relativePath, value] of Object.entries(documents)) writeJcs(root, relativePath, value);
  return documents;
}

test('required-gates JSON Schema is closed and names every RFC field', () => {
  const schema = JSON.parse(fs.readFileSync(REQUIRED_GATES_SCHEMA, 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['schemaVersion', 'gates']);
  assert.equal(schema.$defs.gate.additionalProperties, false);
  assert.deepEqual(
    schema.$defs.gate.required,
    [
      'gateId', 'reportKind', 'criterionRefs', 'toolId', 'capabilityId',
      'capabilityRef', 'capabilityDigest', 'entrypointRef', 'entrypointDigest',
      'discoveryContractRef', 'discoveryContractDigest', 'evidenceSchemaRef',
      'evidenceSchemaDigest', 'dependsOn',
    ],
  );
});

test('required-gates manifest closes exact inventory, criteria, dependencies, and digest domain', () => {
  const manifest = requiredGatesManifest();
  assert.deepEqual(validateRequiredGatesManifest(manifest), []);
  assert.match(requiredGatesManifestDigest(manifest), /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(requiredGatesManifestDigest(manifest), digest(canonicalJcs(manifest)));
});

const requiredGateMutations = [
  ['removed gate', (value) => value.gates.pop(), 'M2_REQUIRED_GATES_INVENTORY'],
  ['deprecated aggregate-release ID', (value) => { value.gates[0].gateId = 'aggregate-release'; }, 'M2_REQUIRED_GATES_INVENTORY'],
  ['wrong criterion mapping', (value) => { value.gates[0].criterionRefs = [CRITERION_REFS[0]]; }, 'M2_REQUIRED_GATE_CRITERIA'],
  ['wrong report kind', (value) => { value.gates[0].reportKind = 'release'; }, 'M2_REQUIRED_GATE_REPORT_KIND'],
  ['missing aggregate dependency', (value) => { value.gates[0].dependsOn.pop(); }, 'M2_REQUIRED_GATE_AGGREGATE_DEPENDENCIES'],
  ['wrong artifact DAG dependency', (value) => { value.gates[1].dependsOn = []; }, 'M2_REQUIRED_GATE_ARTIFACT_DAG_DEPENDENCIES'],
  ['dependency cycle', (value) => { value.gates.find((row) => row.gateId === 'm3-schema').dependsOn = ['aggregate-pre-manifest']; }, 'M2_REQUIRED_GATE_CYCLE'],
  ['payload-phase capability ref', (value) => { value.gates[0].capabilityRef.root = 'payload'; }, 'M2_RELEASE_ARTIFACT_PHASE'],
  ['unknown field', (value) => { value.gates[0].claimedPass = true; }, 'M2_RELEASE_UNKNOWN_FIELD'],
  ['format-valid but substituted digest', (value) => { value.gates[0].capabilityDigest = digest('substituted'); }, null],
];

for (const [label, mutate, expectedCode] of requiredGateMutations) {
  test(`required-gates tamper: ${label}`, () => {
    const manifest = requiredGatesManifest();
    const before = requiredGatesManifestDigest(manifest);
    mutate(manifest);
    if (expectedCode) assert.ok(issueCodes(validateRequiredGatesManifest(manifest)).includes(expectedCode));
    else {
      assert.deepEqual(validateRequiredGatesManifest(manifest), []);
      assert.notEqual(requiredGatesManifestDigest(manifest), before);
    }
  });
}

test('release-verification checks manifest closes all four RFC stage inventories', () => {
  const manifest = releaseChecksManifest();
  assert.deepEqual(validateReleaseVerificationChecksManifest(manifest), []);
  const changed = deepClone(manifest);
  changed.stages[0].checks.pop();
  assert.ok(issueCodes(validateReleaseVerificationChecksManifest(changed)).includes('M2_RELEASE_CHECK_INVENTORY'));
});

test('ValidationReport is closed and exactly joined to its required-gate tuple', () => {
  const gate = gateRow('source-mutation');
  const report = validationReport(gate);
  assert.deepEqual(validateValidationReport(report, gate), []);
});

const validationReportMutations = [
  ['capability substitution', (value) => { value.capabilityDigest = digest('substituted-capability'); }, 'M2_VALIDATION_REPORT_GATE_TUPLE'],
  ['kind schema substitution', (value) => { value.kindEvidence.schemaDigest = digest('substituted-schema'); }, 'M2_VALIDATION_REPORT_EVIDENCE_SCHEMA'],
  ['GateCheck evidence substitution', (value) => { value.result.checks[0].evidenceDigest = digest('substituted-check-evidence'); }, 'M2_VALIDATION_REPORT_CHECK_EVIDENCE_BINDING'],
  ['pending passed report', (value) => { value.counts.pending = 1; }, 'M2_VALIDATION_REPORT_PASSED_MATRIX'],
  ['duplicated check', (value) => { value.result.checks.push(deepClone(value.result.checks[0])); value.counts.discovered = 2; value.counts.executed = 2; value.counts.passed = 2; }, 'M2_VALIDATION_REPORT_CHECK_ORDER'],
  ['unknown report field', (value) => { value.approved = true; }, 'M2_RELEASE_UNKNOWN_FIELD'],
  ['engineFailure without errors', (value) => { value.result.outcome = 'engineFailure'; }, 'M2_VALIDATION_REPORT_ENGINE_FAILURE_MATRIX'],
  ['empty criterion list', (value) => { value.criterionRefs = []; }, 'M2_VALIDATION_REPORT_CRITERIA'],
];

for (const [label, mutate, expectedCode] of validationReportMutations) {
  test(`ValidationReport tamper: ${label}`, () => {
    const gate = gateRow('source-mutation');
    const report = validationReport(gate);
    mutate(report);
    assert.ok(issueCodes(validateValidationReport(report, gate)).includes(expectedCode));
  });
}

test('GateViolation enforces POSIX/IRI paths and canonical N-Triples focus terms', () => {
  const gate = gateRow('shacl-execution');
  const base = validationReport(gate);
  const check = base.result.checks[0];
  check.status = 'failed';
  check.diagnosticCode = 'synthetic-violation';
  base.counts.passed = 0;
  base.counts.failed = 1;
  base.result.outcome = 'failed';
  base.result.violations = [{
    checkId: check.checkId,
    subjectId: check.subjectId,
    diagnosticCode: check.diagnosticCode,
    subjectRef: check.subjectRef,
    severity: 'error',
    message: 'synthetic deterministic violation',
    path: 'ontology/domain/finance/foundation/module.yaml',
    focusNode: '<urn:axiolune:test:focus>',
    component: 'https://www.w3.org/ns/shacl#MinCountConstraintComponent',
  }];
  assert.deepEqual(validateValidationReport(base, gate), []);

  const traversal = deepClone(base);
  traversal.result.violations[0].path = '../outside';
  assert.ok(issueCodes(validateValidationReport(traversal, gate)).includes('M2_RELEASE_POSIX_PATH'));

  const injectedTerm = deepClone(base);
  injectedTerm.result.violations[0].focusNode = '<urn:focus> . <urn:x> <urn:y> <urn:z>';
  assert.ok(
    issueCodes(validateValidationReport(injectedTerm, gate))
      .includes('M2_VALIDATION_REPORT_FOCUS_NODE'),
  );

  const nonCanonicalLiteral = deepClone(base);
  nonCanonicalLiteral.result.violations[0].focusNode = '"literal"';
  assert.ok(
    issueCodes(validateValidationReport(nonCanonicalLiteral, gate))
      .includes('M2_VALIDATION_REPORT_FOCUS_NODE'),
  );

  const unrelatedViolation = deepClone(base);
  unrelatedViolation.result.violations[0].subjectId = digest('unrelated-subject');
  assert.ok(
    issueCodes(validateValidationReport(unrelatedViolation, gate))
      .includes('M2_VALIDATION_REPORT_VIOLATION_CHECK_JOIN'),
  );

  const substitutedDiagnostic = deepClone(base);
  substitutedDiagnostic.result.violations[0].diagnosticCode = 'other-diagnostic';
  assert.ok(
    issueCodes(validateValidationReport(substitutedDiagnostic, gate))
      .includes('M2_VALIDATION_REPORT_VIOLATION_DIAGNOSTIC_JOIN'),
  );
});

test('PIT ValidationReport rejects an impossible calendar pivot', () => {
  const gate = gateRow('pit-execution');
  const report = validationReport(gate);
  report.asOfAvailable = '2026-02-30T00:00:00Z';
  assert.ok(issueCodes(validateValidationReport(report, gate)).includes('M2_RELEASE_INSTANT'));
});

test('P0, P1, payload verification, and eligibility shapes pass static closed-schema review', () => {
  const required = requiredGatesManifest();
  const checks = releaseChecksManifest();
  const p0 = p0ReviewManifest(required, checks);
  const p0Verification = p0VerificationReport(p0, checks);
  const p1 = p1PayloadManifest(required, checks, p0, p0Verification);
  const payloadVerification = payloadVerificationReport(p1, checks);
  const eligibility = eligibilityReport(required, checks, p1, payloadVerification);
  assert.deepEqual(validateP0ReviewManifest(p0), []);
  assert.deepEqual(validateP0VerificationReport(p0Verification, checks), []);
  assert.deepEqual(validateP1PayloadManifest(p1), []);
  assert.deepEqual(validatePayloadVerificationReport(payloadVerification, checks), []);
  assert.deepEqual(validateApprovalEligibilityReport(eligibility, {
    checksManifest: checks,
    requiredGatesManifest: required,
    p1PayloadManifest: p1,
    payloadVerificationReport: payloadVerification,
  }), []);
});

test('P0/P1/report inventories reject omissions and branch-matrix tampering', () => {
  const required = requiredGatesManifest();
  const checks = releaseChecksManifest();
  const p0 = p0ReviewManifest(required, checks);
  const p0Verification = p0VerificationReport(p0, checks);
  const p1 = p1PayloadManifest(required, checks, p0, p0Verification);
  const payloadVerification = payloadVerificationReport(p1, checks);

  p0.gateReports.pop();
  assert.ok(issueCodes(validateP0ReviewManifest(p0)).includes('M2_RELEASE_GATE_REPORT_INVENTORY'));
  p0Verification.checks.pop();
  assert.ok(issueCodes(validateP0VerificationReport(p0Verification, checks)).includes('M2_RELEASE_VERIFIER_CHECK_INVENTORY'));
  p1.requiredRoots.pop();
  assert.ok(issueCodes(validateP1PayloadManifest(p1)).includes('M2_P1_REQUIRED_ROOTS'));
  payloadVerification.checks[0].status = 'failed';
  payloadVerification.checks[0].counts = { discovered: 1, executed: 1, passed: 0, failed: 1 };
  assert.ok(issueCodes(validatePayloadVerificationReport(payloadVerification, checks)).includes('M2_RELEASE_VERIFICATION_PASSED_MATRIX'));
});

test('engine-failure verifier reports cannot inject an unreviewed check ID', () => {
  const required = requiredGatesManifest();
  const checks = releaseChecksManifest();
  const p0 = p0ReviewManifest(required, checks);
  const report = p0VerificationReport(p0, checks);
  report.outcome = 'engineFailure';
  report.errors = [{
    code: 'tool-crash',
    stage: 'execution',
    message: 'synthetic engine failure',
  }];
  report.checks = [deepClone(report.checks[0])];
  report.checks[0].checkId = 'unreviewed-check';
  assert.ok(
    issueCodes(validateP0VerificationReport(report, checks))
      .includes('M2_RELEASE_VERIFIER_CHECK_INVENTORY'),
  );
});

test('post-payload eligibility rejects caller-selected evidence and false eligible matrices', () => {
  const required = requiredGatesManifest();
  const checks = releaseChecksManifest();
  const p0 = p0ReviewManifest(required, checks);
  const p0Verification = p0VerificationReport(p0, checks);
  const p1 = p1PayloadManifest(required, checks, p0, p0Verification);
  const payloadVerification = payloadVerificationReport(p1, checks);
  const eligibility = eligibilityReport(required, checks, p1, payloadVerification);
  eligibility.result.criteria[0].evidence.push({
    artifactRef: { kind: 'path', root: 'payload', path: 'zz-extra-evidence.json' },
    artifactDigest: digest('extra-evidence'),
  });
  assert.ok(issueCodes(validateApprovalEligibilityReport(eligibility, {
    checksManifest: checks,
    requiredGatesManifest: required,
    p1PayloadManifest: p1,
    payloadVerificationReport: payloadVerification,
  })).includes('M2_ELIGIBILITY_EVIDENCE_CLOSURE'));

  const falseEligible = eligibilityReport(required, checks, p1, payloadVerification);
  falseEligible.result.criteria[0].status = 'failed';
  assert.ok(issueCodes(validateApprovalEligibilityReport(falseEligible, {
    checksManifest: checks,
    requiredGatesManifest: required,
    p1PayloadManifest: p1,
    payloadVerificationReport: payloadVerification,
  })).includes('M2_ELIGIBILITY_ELIGIBLE_MATRIX'));
});

test('caller-authored static PASS records cannot bypass governance, raw payload, trust, or replay gates', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-static-candidate-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  materializeStaticCandidate(temporaryRoot);
  const result = verifyM2Release({ releaseDir: temporaryRoot });
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.eligible, false);
  assert.equal(result.approvalStatus, 'not-approved');
  assert.equal(result.adoptionStatus, 'not-verified');
  assert.equal(result.releaseComplete, false);
  assert.equal(result.governanceOutcome, 'failed');
  assert.ok(result.criterionResults.every((row) => (
    row.status === 'notEstablished' && row.evidence.length === 0
  )));
  const codes = issueCodes(result.issues);
  assert.ok(codes.includes('M2_GOV_RFC001_NOT_ACCEPTED'));
  assert.ok(codes.includes('M2_GOV_META_ADR013_MISSING'));
  assert.ok(codes.includes('M2_RELEASE_PAYLOAD_ENTRY_INVENTORY'));
  assert.ok(codes.includes('M2_RELEASE_TRUSTED_SCOPE_REQUIRED'));
  assert.ok(codes.includes('M2_RELEASE_TOOLCHAIN_SOURCE_TREE_REQUIRED'));
  assert.ok(codes.includes('M2_RELEASE_GIT_OBJECT_RECONSTRUCTION'));
  assert.ok(codes.includes('M2_COMPONENT_P1_REPLAY_REQUIRED'));
  assert.ok(codes.includes('M2_REQUIRED_ROOT_MANIFEST_JCS_MISSING'));
  assert.ok(codes.includes('M2_RELEASE_DECISION_TRUST_POLICY_REQUIRED'));
  assert.ok(codes.includes('M2_RELEASE_REASONER_P1_TREE_REQUIRED'));
});

test('malformed gate inventories return closed diagnostics instead of crashing the verifier', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-malformed-gates-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const documents = materializeStaticCandidate(temporaryRoot);
  documents['required-gates-manifest.json'].gates = { substituted: true };
  writeJcs(
    temporaryRoot,
    'required-gates-manifest.json',
    documents['required-gates-manifest.json'],
  );
  assert.doesNotThrow(() => verifyM2Release({ releaseDir: temporaryRoot }));
  const result = verifyM2Release({ releaseDir: temporaryRoot });
  assert.equal(result.eligible, false);
  assert.equal(result.releaseComplete, false);
  assert.ok(issueCodes(result.issues).includes('M2_REQUIRED_GATES_INVENTORY'));
});

test('raw payload entry replay rejects a missing artifact and changed bytes', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-entry-replay-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  materializeStaticCandidate(temporaryRoot);
  const before = verifyM2Release({ releaseDir: temporaryRoot });
  assert.ok(issueCodes(before.issues).includes('M2_RELEASE_ARTIFACT_MISSING'));

  const artifact = path.join(temporaryRoot, 'artifacts', 'release-input.json');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, 'changed raw bytes');
  const after = verifyM2Release({ releaseDir: temporaryRoot });
  assert.ok(issueCodes(after.issues).includes('M2_RELEASE_PAYLOAD_ENTRY_DIGEST'));
});

test('candidate identity must equal independently supplied repository/ref/old-commit scope', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-trusted-scope-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  materializeStaticCandidate(temporaryRoot);
  const matching = verifyM2Release({
    releaseDir: temporaryRoot,
    expectedRepositoryId: 'urn:axiolune:repository:m2',
    expectedAuthoritativeRef: 'refs/heads/release/m2-v0.3.0',
    expectedOldCommitId: gitId('p0-review-commit'),
  });
  assert.equal(matching.trustedScope.provided, true);
  assert.equal(matching.trustedScope.matched, true);
  assert.ok(!issueCodes(matching.issues).includes('M2_RELEASE_TRUSTED_SCOPE_REQUIRED'));

  const mismatch = verifyM2Release({
    releaseDir: temporaryRoot,
    expectedRepositoryId: 'urn:axiolune:repository:other',
    expectedAuthoritativeRef: 'refs/heads/release/m2-v0.3.0',
    expectedOldCommitId: gitId('p0-review-commit'),
  });
  assert.equal(mismatch.trustedScope.matched, false);
  assert.ok(issueCodes(mismatch.issues).includes('M2_RELEASE_TRUSTED_SCOPE_MISMATCH'));
});

test('full static candidate rejects one changed gate-report byte even when JSON remains canonical', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-static-tamper-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const documents = materializeStaticCandidate(temporaryRoot);
  const relativePath = 'evidence/p1-gates/source-mutation.json';
  documents[relativePath].kindEvidence.artifactDigest = digest('tampered-kind-evidence');
  writeJcs(temporaryRoot, relativePath, documents[relativePath]);
  const result = verifyM2Release({ releaseDir: temporaryRoot });
  assert.equal(result.outcome, 'invalid');
  assert.ok(issueCodes(result.issues).includes('M2_GATE_VALIDATION_REPORT_DIGEST'));
});

test('full static candidate rejects a same-digest ref substitution across post-payload records', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-static-ref-tamper-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const documents = materializeStaticCandidate(temporaryRoot);
  const eligibilityPath = 'evidence/approval-eligibility-report.json';
  documents[eligibilityPath].payloadManifestRef = {
    kind: 'path', root: 'payload', path: 'alias/payload-manifest.json',
  };
  writeJcs(temporaryRoot, eligibilityPath, documents[eligibilityPath]);
  const result = verifyM2Release({ releaseDir: temporaryRoot });
  assert.equal(result.outcome, 'invalid');
  assert.ok(issueCodes(result.issues).includes('M2_ELIGIBILITY_PAYLOAD_REF_BINDING'));
});

test('full verifier reports every absent candidate boundary and never claims approved', () => {
  const missing = path.join(os.tmpdir(), `axiolune-missing-release-${process.pid}-${Date.now()}`);
  const result = verifyM2Release({ releaseDir: missing });
  assert.equal(result.outcome, 'invalid');
  assert.equal(result.eligible, false);
  assert.equal(result.approvalStatus, 'not-approved');
  assert.equal(result.releaseComplete, false);
  assert.ok(result.criterionResults.every((row) => row.status === 'notEstablished'));
  const codes = issueCodes(result.issues);
  assert.ok(codes.includes('M2_RELEASE_DIRECTORY_MISSING'));
  assert.ok(codes.includes('M2_REQUIRED_GATES_MANIFEST_MISSING'));
  assert.ok(codes.includes('M2_P0_REVIEW_MANIFEST_MISSING'));
  assert.ok(codes.includes('M2_P1_PAYLOAD_MANIFEST_MISSING'));
  assert.ok(codes.includes('M2_PAYLOAD_VERIFICATION_REPORT_MISSING'));
  assert.ok(codes.includes('M2_APPROVAL_ELIGIBILITY_REPORT_MISSING'));
});

test('component prerequisites cannot substitute for candidate-specific gate semantic replay', () => {
  const issues = [];
  const collector = {
    add(code, stage, at, message, kind = 'invalid') {
      issues.push({ code, stage, path: at, message, kind });
    },
  };
  verifyGateSemanticReplayCoverage(
    requiredGatesManifest(),
    { reasoner: { outcome: 'passed' } },
    collector,
  );
  const unresolved = issues.filter((issue) => issue.code === 'M2_GATE_SEMANTIC_REPLAY_REQUIRED');
  assert.equal(unresolved.length, REQUIRED_GATE_IDS.length);
  assert.ok(unresolved.every((issue) => issue.kind === 'unverified'));
  assert.ok(REASONER_GATE_IDS.every((gateId) => (
    unresolved.some((issue) => issue.path.endsWith(`/${gateId}`))
  )));
});

test('only per-gate declared-contract execution closes semantic coverage', () => {
  const issues = [];
  const releaseProof = {
    outcome: 'passed',
    releaseGateEvidenceEstablished: true,
    declaredEntrypointExecuted: true,
    declaredDiscoveryReplayed: true,
    declaredEvidenceSchemaValidated: true,
    kindEvidenceByteEquivalent: true,
    dependencyReportsRecomputed: true,
    fiveVectorCategoriesPassed: true,
    callerEvidenceAccepted: false,
  };
  const replayedGateIds = [...REASONER_GATE_IDS, 'artifact-dependency-dag'];
  verifyGateSemanticReplayCoverage(
    requiredGatesManifest(),
    {
      gateOutcomes: replayedGateIds.map((gateId) => ({ gateId, ...releaseProof })),
    },
    { add(code, stage, at, message, kind = 'invalid') {
      issues.push({ code, stage, path: at, message, kind });
    } },
  );
  const unresolvedIds = issues.map((issue) => issue.path.split('/').at(-1));
  assert.equal(issues.length, REQUIRED_GATE_IDS.length - 4);
  assert.ok(!unresolvedIds.includes('artifact-dependency-dag'));
});

test('CLI emits detached machine-readable diagnostics and rejects incomplete candidate', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-release-verifier-test-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const candidate = path.join(temporaryRoot, 'candidate');
  const output = path.join(temporaryRoot, 'diagnostics');
  fs.mkdirSync(candidate, { recursive: true });
  const manifest = requiredGatesManifest();
  fs.writeFileSync(
    path.join(candidate, 'required-gates-manifest.json'),
    Buffer.from(canonicalJcs(manifest), 'utf8'),
  );
  const execution = spawnSync(process.execPath, [
    CLI,
    '--release-dir', candidate,
    '--output-dir', output,
  ], { cwd: ROOT, encoding: 'utf8', shell: false });
  assert.equal(execution.status, 1);
  const diagnosticFile = path.join(output, 'release-verification-diagnostic.json');
  assert.equal(fs.existsSync(diagnosticFile), true);
  const diagnostic = JSON.parse(fs.readFileSync(diagnosticFile, 'utf8'));
  assert.equal(diagnostic.eligible, false);
  assert.equal(diagnostic.approvalStatus, 'not-approved');
  assert.equal(diagnostic.releaseComplete, false);
  assert.equal(diagnostic.criterionResults.length, 6);
  assert.ok(issueCodes(diagnostic.issues).includes('M2_RELEASE_CHECKS_MANIFEST_MISSING'));
  assert.ok(issueCodes(diagnostic.issues).includes('M2_APPROVAL_ELIGIBILITY_REPORT_MISSING'));
});

test('CLI refuses a detached-output symlink and never writes through it into the candidate', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-release-output-link-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const candidate = path.join(temporaryRoot, 'candidate');
  const outputLink = path.join(temporaryRoot, 'diagnostics-link');
  fs.mkdirSync(candidate, { recursive: true });
  try {
    fs.symlinkSync(candidate, outputLink, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (cause) {
    t.skip(`directory symlink unavailable: ${cause.code || cause.message}`);
    return;
  }
  const execution = spawnSync(process.execPath, [
    CLI,
    '--release-dir', candidate,
    '--output-dir', outputLink,
  ], { cwd: ROOT, encoding: 'utf8', shell: false });
  assert.equal(execution.status, 2);
  assert.match(execution.stderr, /non-symlink|symlink|reviewed candidate/u);
  assert.equal(fs.existsSync(path.join(candidate, 'release-verification-diagnostic.json')), false);
});

test('CLI binds all three independently supplied trusted-scope values into diagnostics', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-release-trust-cli-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const candidate = path.join(temporaryRoot, 'candidate');
  const output = path.join(temporaryRoot, 'output');
  fs.mkdirSync(candidate, { recursive: true });
  const expectedOldCommitId = gitId('trusted-cli');
  const execution = spawnSync(process.execPath, [
    CLI,
    '--release-dir', candidate,
    '--output-dir', output,
    '--expected-repository-id', 'urn:axiolune:repository:m2',
    '--expected-authoritative-ref', 'refs/heads/release/m2-v0.3.0',
    '--expected-old-commit-id', expectedOldCommitId,
  ], { cwd: ROOT, encoding: 'utf8', shell: false });
  assert.equal(execution.status, 1);
  const diagnostic = JSON.parse(fs.readFileSync(
    path.join(output, 'release-verification-diagnostic.json'),
    'utf8',
  ));
  assert.equal(diagnostic.trustedScope.repositoryId, 'urn:axiolune:repository:m2');
  assert.equal(diagnostic.trustedScope.authoritativeRef, 'refs/heads/release/m2-v0.3.0');
  assert.equal(diagnostic.trustedScope.expectedOldCommitId, expectedOldCommitId);
  assert.equal(diagnostic.trustedScope.provided, true);
  assert.equal(diagnostic.trustedScope.matched, false);
});

test('CLI detects non-canonical candidate JSON bytes as tamper', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-release-jcs-test-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const candidate = path.join(temporaryRoot, 'candidate');
  fs.mkdirSync(candidate, { recursive: true });
  fs.writeFileSync(
    path.join(candidate, 'required-gates-manifest.json'),
    `${JSON.stringify(requiredGatesManifest(), null, 2)}\n`,
  );
  const result = verifyM2Release({ releaseDir: candidate });
  assert.equal(result.outcome, 'invalid');
  assert.ok(issueCodes(result.issues).includes('M2_RELEASE_NON_CANONICAL_JCS'));
});
