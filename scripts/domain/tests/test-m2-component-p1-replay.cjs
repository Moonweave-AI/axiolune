'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  CRITERION_REFS,
  PROFILE_REF,
  RELEASE_CAPABILITY_EVIDENCE_USE,
  REQUIRED_GATE_IDS,
  releaseCapabilityDefinitions,
} = require('../lib/m2-release-capability-definitions.cjs');
const {
  TOOL_DESCRIPTOR_REL,
  REGISTRY_REL,
  RELEASE_CHECKS_REL,
  REQUIRED_GATES_REL,
  generate: generateReleaseCapabilityProfile,
  vectorInput,
} = require('../generate-release-capability-profile.cjs');
const {
  evaluateReleaseCapability,
} = require('../lib/m2-release-capability-runtime.cjs');
const {
  validateReleaseCapabilityRegistry,
} = require('../lib/m2-release-capability-registry.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const {
  EXPECTED_COMPONENT_IDS,
  GATE_COMPONENT_BINDINGS,
  SUMMARY_PREFIX,
  gateReplayCoverage,
  parseSummary,
  safePath,
  validateComponentReplaySummary,
  verifySourceInventory,
} = require('../lib/m2-component-p1-replay.cjs');

function digest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function summary() {
  return {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    runMode: 'component-only',
    outcome: 'passed',
    componentCount: EXPECTED_COMPONENT_IDS.length,
    components: EXPECTED_COMPONENT_IDS.map((id) => ({ id, status: 'passed' })),
    acceptanceStatuses: CRITERION_REFS.map((criterionRef) => ({
      criterionRef,
      status: 'pending',
    })),
    lifecycleStatus: 'pending',
    callerEvidenceAccepted: false,
  };
}

test('P1 component replay closes prerequisites without claiming gate evidence', () => {
  const value = summary();
  assert.deepEqual(validateComponentReplaySummary(value), []);
  const coverage = gateReplayCoverage(value);
  assert.deepEqual(coverage.map((row) => row.gateId), REQUIRED_GATE_IDS);
  assert.equal(coverage.length, 22);
  assert.ok(coverage.every((row) => (
    row.prerequisiteOutcome === 'passed'
      && row.evidenceUse === 'component-prerequisites-only'
      && row.releaseEligibilityEvidence === false
  )));
  assert.deepEqual(Object.keys(GATE_COMPONENT_BINDINGS).sort(), [...REQUIRED_GATE_IDS]);
});

test('mixed release capability runtime keeps the generic path explicitly non-evidentiary', () => {
  const outputs = generateReleaseCapabilityProfile();
  const descriptor = JSON.parse(outputs.get(TOOL_DESCRIPTOR_REL).toString('utf8'));
  assert.ok(descriptor.evidenceUses.includes(RELEASE_CAPABILITY_EVIDENCE_USE));
  assert.ok(descriptor.evidenceUses.includes('required-gate-release-eligibility-evidence'));
  const capabilities = [...outputs]
    .filter(([relativePath]) => relativePath.endsWith('/capability.json'))
    .map(([, bytes]) => JSON.parse(bytes.toString('utf8')));
  assert.equal(capabilities.length, 64);
  assert.equal(capabilities.filter((row) => (
    row.implementationMode === RELEASE_CAPABILITY_EVIDENCE_USE
  )).length, 62);
  assert.deepEqual(capabilities.filter((row) => (
    row.implementationMode === 'required-gate-semantic-replay-v1'
  )).map((row) => row.subjectId).sort(), [
    'm3-import-digest', 'm3-schema', 'module-import-dag',
  ]);
  const definition = releaseCapabilityDefinitions().find((row) => (
    row.implementationMode === RELEASE_CAPABILITY_EVIDENCE_USE
  ));
  const result = evaluateReleaseCapability(vectorInput(definition, 'positive'));
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.evidenceUse, RELEASE_CAPABILITY_EVIDENCE_USE);
  assert.equal(result.releaseEligibilityEvidence, false);

  const files = new Map(outputs);
  const scanRefs = (value) => {
    if (Array.isArray(value)) {
      value.forEach(scanRefs);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.kind === 'path' && value.root === 'sourceTree'
        && typeof value.path === 'string' && !files.has(value.path)) {
      files.set(value.path, fs.readFileSync(path.join(
        process.cwd(), ...value.path.split('/'),
      )));
    }
    Object.values(value).forEach(scanRefs);
  };
  for (const bytes of outputs.values()) {
    try { scanRefs(JSON.parse(bytes.toString('utf8'))); } catch { /* non-JSON source */ }
  }
  const issues = [];
  const closure = validateReleaseCapabilityRegistry({
    registry: JSON.parse(outputs.get(REGISTRY_REL).toString('utf8')),
    files,
    requiredGates: JSON.parse(outputs.get(REQUIRED_GATES_REL).toString('utf8')),
    releaseChecks: JSON.parse(outputs.get(RELEASE_CHECKS_REL).toString('utf8')),
    issues,
  });
  assert.deepEqual(issues, []);
  assert.equal(closure.entries.length, 64);
});

for (const [label, mutate, code] of [
  [
    'failed component',
    (value) => { value.components[0].status = 'failed'; value.outcome = 'failed'; },
    'M2_COMPONENT_P1_RESULT',
  ],
  [
    'missing component',
    (value) => { value.components.pop(); value.componentCount -= 1; },
    'M2_COMPONENT_P1_INVENTORY',
  ],
  [
    'release acceptance claim',
    (value) => { value.acceptanceStatuses[0].status = 'satisfied'; },
    'M2_COMPONENT_P1_ACCEPTANCE_BOUNDARY',
  ],
  [
    'caller evidence accepted',
    (value) => { value.callerEvidenceAccepted = true; },
    'M2_COMPONENT_P1_SUMMARY_OUTCOME',
  ],
  [
    'additional field',
    (value) => { value.claimedApproved = true; },
    'M2_COMPONENT_P1_SUMMARY_SCHEMA',
  ],
]) {
  test(`P1 component replay rejects ${label}`, () => {
    const value = summary();
    mutate(value);
    assert.ok(validateComponentReplaySummary(value).some((issue) => issue.code === code));
  });
}

test('gate coverage fails when one bound component is not passed', () => {
  const value = summary();
  const component = value.components.find((row) => row.id === 'cq-coverage-execution');
  component.status = 'failed';
  const coverage = gateReplayCoverage(value);
  const cq = coverage.find((row) => row.gateId === 'cq-coverage-execution');
  const aggregate = coverage.find((row) => row.gateId === 'aggregate-pre-manifest');
  assert.equal(cq.prerequisiteOutcome, 'failed');
  assert.deepEqual(cq.missingComponentIds, ['cq-coverage-execution']);
  assert.equal(aggregate.prerequisiteOutcome, 'failed');
});

test('machine summary parser requires exactly one canonical JCS summary', () => {
  const value = summary();
  const line = `${SUMMARY_PREFIX}${canonicalJcs(value)}\n`;
  assert.deepEqual(parseSummary(Buffer.from(line)).value, value);
  assert.throws(() => parseSummary(Buffer.from(`${line}${line}`)), /emitted 2 machine summaries/u);
  assert.throws(
    () => parseSummary(Buffer.from(`${SUMMARY_PREFIX}${JSON.stringify(value)}\n`)),
    /not exact RFC 8785 JCS/u,
  );
});

test('source inventory is byte-closed and traversal fails closed', () => {
  const bytes = Buffer.from('locked-source', 'utf8');
  const files = new Map([[
    'scripts/domain/example.cjs',
    {
      mode: '100644',
      path: 'scripts/domain/example.cjs',
      byteLength: bytes.length,
      artifactDigest: digest(bytes),
      content: bytes,
    },
  ]]);
  assert.equal(verifySourceInventory(files), bytes.length);
  files.get('scripts/domain/example.cjs').artifactDigest = digest(Buffer.from('substituted'));
  assert.throws(() => verifySourceInventory(files), /not byte-closed/u);
  assert.throws(() => safePath('C:\\safe-root', '../escape'), /unsafe reconstructed-P1 path/u);
});
