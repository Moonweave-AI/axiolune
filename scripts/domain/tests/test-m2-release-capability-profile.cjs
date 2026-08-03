'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  REGISTRY_PATH,
  RELEASE_CHECKS_PATH,
  REQUIRED_GATES_PATH,
  parseRegistryBytes,
  validateReleaseCapabilityRegistry,
} = require('../lib/m2-release-capability-registry.cjs');
const {
  assertReleaseRegistryMatchesLock,
  executeReleaseCapabilityPayload,
} = require('../lib/m2-release-capability-replay.cjs');
const {
  buildReleaseToolchainLock,
} = require('../lib/m2-toolchain-lock-builder.cjs');
const {
  check,
  generate,
  requiredGateImplementationInventory,
} = require('../generate-release-capability-profile.cjs');
const {
  RELEASE_CAPABILITY_EVIDENCE_USE,
  REQUIRED_GATE_IDS,
} = require('../lib/m2-release-capability-definitions.cjs');
const { sourceFileMap } = require('../replay-release-capability-payload.cjs');

const ROOT = require('node:path').resolve(__dirname, '..', '..', '..');

function fixture() {
  const files = sourceFileMap(ROOT);
  const registry = parseRegistryBytes(files.get(REGISTRY_PATH));
  const requiredGates = JSON.parse(files.get(REQUIRED_GATES_PATH).toString('utf8'));
  const releaseChecks = JSON.parse(files.get(RELEASE_CHECKS_PATH).toString('utf8'));
  const build = buildReleaseToolchainLock({ sourceRoot: ROOT });
  assert.equal(build.outcome, 'built');
  return { files, registry, requiredGates, releaseChecks, lock: build.lock, build };
}

test('generated release capability profile has exact non-drifted 22/42/64 closure', () => {
  const outputs = generate();
  assert.deepEqual(check(outputs), []);
  const value = fixture();
  const issues = [];
  const closure = validateReleaseCapabilityRegistry({ ...value, issues });
  assert.deepEqual(issues, []);
  assert.equal(closure.entries.length, 64);
  assert.equal(closure.requiredGateCount, 22);
  assert.equal(closure.releaseCheckCount, 42);
  assert.equal(
    value.lock.tools.reduce((total, tool) => total + tool.capabilities.length, 0),
    value.build.customConstraintCount + closure.entries.length,
  );
  assert.ok(value.build.customConstraintIris.includes(
    'https://axiolune.ai/ontology/finance/orders-execution/OrderIntentLineageContract',
  ));
  assert.equal(
    value.lock.tools.find((tool) => (
      tool.toolId === 'axiolune-release-capability-runtime-v1'
    )).capabilities.length,
    64,
  );
  const mappingEntry = value.registry.entries.find((entry) => (
    entry.capabilityId === 'gate.mapping-materialization'
  ));
  const mappingCapability = JSON.parse(
    value.files.get(mappingEntry.capabilityRef.path).toString('utf8'),
  );
  assert.deepEqual(
    mappingCapability.semanticImplementationArtifacts.map((entry) => entry.ref.path),
    [
      'scripts/domain/lib/m2-component-p1-replay.cjs',
      'scripts/domain/lib/m2-gate-artifact-binding-replay.cjs',
      'scripts/domain/lib/m2-required-gate-semantic-replay.cjs',
    ],
  );
  assert.equal(value.files.has('scripts/domain/run-slice-a.cjs'), false);
  assert.ok(mappingCapability.semanticImplementationArtifacts.every((entry) => (
    value.files.has(entry.ref.path)
  )));
});

test('required-gate profile reports the exact honest production semantic-adapter count', () => {
  const outputs = generate();
  assert.deepEqual(requiredGateImplementationInventory(outputs), {
    productionRequiredGateCount: 3,
    productionGateIds: ['m3-import-digest', 'm3-schema', 'module-import-dag'],
    interfaceOnlyRequiredGateCount: 19,
    interfaceOnlyGateIds: REQUIRED_GATE_IDS.filter((gateId) => (
      !['m3-import-digest', 'm3-schema', 'module-import-dag'].includes(gateId)
    )),
    unknownRequiredGateCount: 0,
    unknownGateIds: [],
  });
  const rows = REQUIRED_GATE_IDS.map((gateId) => JSON.parse(outputs.get(
    `scripts/domain/release-capability-profile/v0.3.0/gates/${gateId}/capability.json`,
  ).toString('utf8')));
  const production = rows.filter((row) => (
    row.implementationMode === 'required-gate-semantic-replay-v1'
  ));
  const interfaceOnly = rows.filter((row) => (
    row.implementationMode === RELEASE_CAPABILITY_EVIDENCE_USE
  ));
  assert.equal(production.length, 3);
  assert.equal(interfaceOnly.length, 19);
  assert.deepEqual(
    production.map((row) => row.entrypoint.ref.path),
    [
      'scripts/domain/run-production-required-gate.cjs',
      'scripts/domain/run-production-required-gate.cjs',
      'scripts/domain/run-production-required-gate.cjs',
    ],
  );
  for (const row of production) {
    const paths = row.semanticImplementationArtifacts.map((artifact) => artifact.ref.path);
    assert.ok(paths.includes(
      'scripts/domain/lib/production-required-gate-semantic-adapters.cjs',
    ));
    if (row.subjectId === 'module-import-dag') {
      assert.ok(paths.includes(
        'scripts/domain/lib/module-import-dag-required-gate-semantic-adapter.cjs',
      ));
      assert.ok(paths.includes('scripts/domain/lib/module-import-dag-validator.cjs'));
      assert.ok(paths.includes('scripts/domain/lib/canonical-finance-dag.cjs'));
      assert.ok(paths.includes('scripts/domain/lib/public-symbol-compiler.cjs'));
      assert.ok(!paths.some((artifactPath) => artifactPath.startsWith('scripts/meta/')));
    } else {
      assert.ok(paths.includes('scripts/meta/validate-structure.js'));
      assert.ok(paths.includes('scripts/meta/verify-meta-model.js'));
      assert.ok(paths.includes('scripts/meta/lib/structure-negative-corpus.js'));
      assert.ok(paths.includes('scripts/domain/lib/m3-required-gate-semantic-adapter.cjs'));
    }
  }
  for (const row of interfaceOnly) {
    assert.ok(!row.semanticImplementationArtifacts.some((artifact) => (
      artifact.ref.path.startsWith('scripts/meta/')
        || artifact.ref.path === 'scripts/domain/lib/m3-required-gate-semantic-adapter.cjs'
        || artifact.ref.path
          === 'scripts/domain/lib/module-import-dag-required-gate-semantic-adapter.cjs'
    )));
  }
});

test('one missing gate/check capability is fatal to registry and lock closure', () => {
  const value = fixture();
  value.registry.entries.splice(17, 1);
  const issues = [];
  validateReleaseCapabilityRegistry({ ...value, issues });
  assert.ok(issues.some((issue) => (
    issue.code === 'M2_RELEASE_CAPABILITY_REGISTRY_INVENTORY'
  )));
  assert.throws(
    () => assertReleaseRegistryMatchesLock(value.registry, value.lock),
    /exactly 64 capabilities/u,
  );
});

test('missing production M3 adapter bytes fail closed without source fallback', () => {
  const value = fixture();
  value.files.delete('scripts/domain/lib/m3-required-gate-semantic-adapter.cjs');
  const issues = [];
  validateReleaseCapabilityRegistry({ ...value, issues });
  assert.ok(issues.some((issue) => (
      issue.code === 'M2_RELEASE_CAPABILITY_ARTIFACT_MISSING'
      && issue.path === 'scripts/domain/lib/m3-required-gate-semantic-adapter.cjs'
  )));
});

test('missing invoked M3 validator bytes fail closed without adapter fallback', () => {
  const value = fixture();
  value.files.delete('scripts/meta/validate-structure.js');
  const issues = [];
  validateReleaseCapabilityRegistry({ ...value, issues });
  assert.ok(issues.some((issue) => (
      issue.code === 'M2_RELEASE_CAPABILITY_ARTIFACT_MISSING'
      && issue.path === 'scripts/meta/validate-structure.js'
  )));
});

test('manifest tuple substitution cannot borrow a real locked capability', () => {
  const value = fixture();
  value.requiredGates.gates[0].capabilityDigest = `sha256:${'0'.repeat(64)}`;
  const issues = [];
  validateReleaseCapabilityRegistry({ ...value, issues });
  assert.ok(issues.some((issue) => (
    issue.code === 'M2_RELEASE_CAPABILITY_MANIFEST_REGISTRY_JOIN'
  )));
});

test('capability descriptor alias is rejected even when both source artifacts exist', () => {
  const value = fixture();
  value.registry.entries[1].capabilityRef =
    structuredClone(value.registry.entries[0].capabilityRef);
  value.registry.entries[1].capabilityDigest = value.registry.entries[0].capabilityDigest;
  const issues = [];
  validateReleaseCapabilityRegistry({ ...value, issues });
  assert.ok(issues.some((issue) => (
    issue.code === 'M2_RELEASE_CAPABILITY_REGISTRY_ALIAS'
  )));
});

test('an unexecuted release capability blocks replay instead of becoming a skip', () => {
  const value = fixture();
  assert.throws(
    () => executeReleaseCapabilityPayload({
      ...value,
      skipCapabilityIds: value.registry.entries.map((entry) => entry.capabilityId),
    }),
    /requires exact 64\/320 execution; found 0\/0/u,
  );
});

test('all 64 declared entrypoint capabilities execute all five polarities in isolation', {
  timeout: 120000,
}, () => {
  const value = fixture();
  const result = executeReleaseCapabilityPayload(value);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.capabilityCount, 64);
  assert.equal(result.requiredGateCapabilityCount, 22);
  assert.equal(result.releaseCheckCapabilityCount, 42);
  assert.equal(result.caseCount, 320);
  assert.equal(result.isolatedTemporaryCopy, true);
  assert.equal(result.callerEvidenceAccepted, false);
  assert.deepEqual(
    [...new Set(result.rows.map((row) => row.category))].sort(),
    ['emptySubject', 'engineFailure', 'positive', 'tamper', 'violation'],
  );
});
