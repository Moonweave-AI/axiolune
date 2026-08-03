'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertRegistryMatchesLock,
  collectPayloadClosure,
  executeCustomPayload,
  spawnStdinWorker,
} = require('../lib/custom-release-payload-replay.cjs');
const { buildReleaseToolchainLock } = require('../lib/m2-toolchain-lock-builder.cjs');
const { verifyCustomConstraintClosure } = require('../lib/m2-toolchain-replay.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '../../..');
const REGISTRY_PATH =
  'scripts/domain/release-profile/v0.3.0/custom-capability-bindings.json';

function digest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function sourceBytes(relativePath) {
  return fs.readFileSync(path.join(ROOT, ...relativePath.split('/')));
}

function addRef(files, tuple) {
  if (!tuple?.ref?.path || files.has(tuple.ref.path)) return;
  files.set(tuple.ref.path, sourceBytes(tuple.ref.path));
}

function loadLiveFixture() {
  const built = buildReleaseToolchainLock({ sourceRoot: ROOT });
  assert.equal(built.outcome, 'built', JSON.stringify(built.issues));
  const lock = built.lock;
  const registry = JSON.parse(sourceBytes(REGISTRY_PATH).toString('utf8'));
  const files = new Map([[REGISTRY_PATH, sourceBytes(REGISTRY_PATH)]]);
  for (const entry of fs.readdirSync(path.join(ROOT, 'ontology/domain/finance'), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const relativePath = `ontology/domain/finance/${entry.name}/module.yaml`;
    const absolute = path.join(ROOT, ...relativePath.split('/'));
    if (fs.existsSync(absolute)) files.set(relativePath, fs.readFileSync(absolute));
  }
  for (const tool of lock.tools) {
    addRef(files, { ref: tool.artifactRef, digest: tool.artifactDigest });
    addRef(files, { ref: tool.runtimeRef, digest: tool.runtimeDigest });
    const descriptor = JSON.parse(files.get(tool.artifactRef.path).toString('utf8'));
    const runtime = JSON.parse(files.get(tool.runtimeRef.path).toString('utf8'));
    addRef(files, descriptor.componentDiscovery);
    for (const implementation of descriptor.implementationArtifacts) addRef(files, implementation);
    addRef(files, runtime.dependencyLock);
    for (const capability of tool.capabilities) {
      for (const prefix of [
        'capability', 'entrypoint', 'inputContract', 'outputContract',
        'discoveryContract', 'evidenceSchema', 'testVectors',
      ]) {
        addRef(files, {
          ref: capability[`${prefix}Ref`],
          digest: capability[`${prefix}Digest`],
        });
      }
      const vectors = JSON.parse(files.get(capability.testVectorsRef.path).toString('utf8'));
      for (const rows of Object.values(vectors.categories)) {
        for (const row of rows) addRef(files, { ref: row.inputRef, digest: row.inputDigest });
      }
    }
  }
  return {
    files,
    lock,
    registry,
    expectedConstraintIris: built.customConstraintIris,
    expectedContextCount: built.customContextCount,
  };
}

function cloneFixture(base) {
  return {
    files: new Map([...base.files].map(([key, bytes]) => [key, Buffer.from(bytes)])),
    lock: structuredClone(base.lock),
    registry: structuredClone(base.registry),
    expectedConstraintIris: [...base.expectedConstraintIris],
    expectedContextCount: base.expectedContextCount,
  };
}

function registryEntry(registry, capabilityId) {
  const entry = registry.entries.find((row) => row.constraintIri === capabilityId);
  assert.ok(entry, capabilityId);
  return entry;
}

function capabilitiesFromRegistry(registry) {
  return new Map(registry.entries.map((entry) => [entry.constraintIri, {
    toolId: entry.toolId,
    toolVersion: entry.toolVersion,
    runtimeRef: entry.runtimeRef,
    runtimeDigest: entry.runtimeDigest,
    capabilityId: entry.constraintIri,
    capabilityRef: entry.capabilityRef,
    capabilityDigest: entry.capabilityDigest,
    entrypointRef: entry.entrypointRef,
    entrypointDigest: entry.entrypointDigest,
    inputContractRef: entry.inputContractRef,
    inputContractDigest: entry.inputContractDigest,
    outputContractRef: entry.outputContractRef,
    outputContractDigest: entry.outputContractDigest,
    discoveryContractRef: entry.discoveryContractRef,
    discoveryContractDigest: entry.discoveryContractDigest,
    evidenceSchemaRef: entry.evidenceSchemaRef,
    evidenceSchemaDigest: entry.evidenceSchemaDigest,
    testVectorsRef: entry.testVectorsRef,
    testVectorsDigest: entry.testVectorsDigest,
  }]));
}

const base = loadLiveFixture();

test('P1 Custom registry exactly equals the ontology inventory including OrderIntentLineageContract', () => {
  const expected = assertRegistryMatchesLock(
    base.registry,
    base.lock,
    base.expectedConstraintIris,
  );
  assert.equal(expected.length, base.expectedConstraintIris.length);
  assert.ok(base.expectedConstraintIris.includes(
    'https://axiolune.ai/ontology/finance/orders-execution/OrderIntentLineageContract',
  ));
});

test('registry deletion, addition, and reordering are independently fatal', () => {
  const deleted = structuredClone(base.registry);
  deleted.entries.pop();
  assert.throws(
    () => assertRegistryMatchesLock(deleted, base.lock, base.expectedConstraintIris),
    /authoritative ontology Custom IRI inventory/u,
  );

  const added = structuredClone(base.registry);
  added.entries.push(structuredClone(added.entries.at(-1)));
  assert.throws(
    () => assertRegistryMatchesLock(added, base.lock, base.expectedConstraintIris),
    /reordered or duplicated/u,
  );

  const reordered = structuredClone(base.registry);
  [reordered.entries[0], reordered.entries[1]] = [reordered.entries[1], reordered.entries[0]];
  assert.throws(
    () => assertRegistryMatchesLock(reordered, base.lock, base.expectedConstraintIris),
    /reordered/u,
  );
});

test('coherent OrderIntentLineageContract deletion from registry and lock is still fatal', () => {
  const lineageIri =
    'https://axiolune.ai/ontology/finance/orders-execution/OrderIntentLineageContract';
  const registry = structuredClone(base.registry);
  registry.entries = registry.entries.filter((entry) => entry.constraintIri !== lineageIri);
  const lock = structuredClone(base.lock);
  for (const tool of lock.tools) {
    tool.capabilities = tool.capabilities.filter((entry) => entry.capabilityId !== lineageIri);
  }
  assert.throws(
    () => assertRegistryMatchesLock(registry, lock, base.expectedConstraintIris),
    /authoritative ontology Custom IRI inventory/u,
  );
});

test('missing and duplicate Custom contexts invalidate the exact ontology context inventory', () => {
  let value = cloneFixture(base);
  let entry = value.registry.entries.find((row) => {
    const discovery = JSON.parse(value.files.get(row.discoveryContractRef.path).toString('utf8'));
    return discovery.subjects?.[0]?.contexts?.length > 0;
  });
  let discovery = JSON.parse(value.files.get(entry.discoveryContractRef.path).toString('utf8'));
  discovery.subjects[0].contexts.pop();
  discovery.subjects[0].contextCount = discovery.subjects[0].contexts.length;
  let bytes = Buffer.from(canonicalJcs(discovery), 'utf8');
  value.files.set(entry.discoveryContractRef.path, bytes);
  capabilitiesFromRegistry(value.registry).get(entry.constraintIri).discoveryContractDigest = digest(bytes);
  let capabilities = capabilitiesFromRegistry(value.registry);
  capabilities.get(entry.constraintIri).discoveryContractDigest = digest(bytes);
  let issues = [];
  verifyCustomConstraintClosure(value.files, capabilities, issues);
  assert.ok(issues.some((issue) => issue.code === 'M2_CUSTOM_CONSTRAINT_CONTEXT_INVENTORY'));

  value = cloneFixture(base);
  entry = value.registry.entries.find((row) => {
    const candidate = JSON.parse(value.files.get(row.discoveryContractRef.path).toString('utf8'));
    return candidate.subjects?.[0]?.contexts?.length > 0;
  });
  discovery = JSON.parse(value.files.get(entry.discoveryContractRef.path).toString('utf8'));
  discovery.subjects[0].contexts.push(structuredClone(discovery.subjects[0].contexts[0]));
  discovery.subjects[0].contextCount = discovery.subjects[0].contexts.length;
  bytes = Buffer.from(canonicalJcs(discovery), 'utf8');
  value.files.set(entry.discoveryContractRef.path, bytes);
  capabilities = capabilitiesFromRegistry(value.registry);
  capabilities.get(entry.constraintIri).discoveryContractDigest = digest(bytes);
  issues = [];
  verifyCustomConstraintClosure(value.files, capabilities, issues);
  assert.ok(issues.some((issue) => issue.code === 'M2_CUSTOM_CONSTRAINT_CONTEXT_CLOSURE'));
  assert.ok(issues.some((issue) => issue.code === 'M2_CUSTOM_CONSTRAINT_CONTEXT_INVENTORY'));
});

test('worker and evidence bytes cannot differ from their P1 digests', () => {
  let value = cloneFixture(base);
  const workerPath = value.lock.tools[0].capabilities[0].entrypointRef.path;
  value.files.set(workerPath, Buffer.concat([value.files.get(workerPath), Buffer.from('\n// tamper\n')]));
  assert.throws(
    () => collectPayloadClosure(
      value.files, value.lock, value.registry, value.expectedConstraintIris,
    ),
    /digest differs from reconstructed P1 bytes/u,
  );

  value = cloneFixture(base);
  const schemaPath = value.lock.tools[0].capabilities[0].evidenceSchemaRef.path;
  value.files.set(schemaPath, Buffer.from('{}', 'utf8'));
  assert.throws(
    () => collectPayloadClosure(
      value.files, value.lock, value.registry, value.expectedConstraintIris,
    ),
    /digest differs from reconstructed P1 bytes/u,
  );
});

test('a consistently re-digested permission downgrade is still rejected', () => {
  const value = cloneFixture(base);
  const runtimePath = value.lock.tools[0].runtimeRef.path;
  const runtime = JSON.parse(value.files.get(runtimePath).toString('utf8'));
  runtime.networkPolicy = 'allow';
  const bytes = Buffer.from(canonicalJcs(runtime), 'utf8');
  const runtimeDigest = digest(bytes);
  value.files.set(runtimePath, bytes);
  for (const tool of value.lock.tools) {
    if (tool.runtimeRef.path === runtimePath) tool.runtimeDigest = runtimeDigest;
  }
  for (const entry of value.registry.entries) {
    if (entry.runtimeRef.path === runtimePath) entry.runtimeDigest = runtimeDigest;
  }
  assert.throws(
    () => collectPayloadClosure(
      value.files, value.lock, value.registry, value.expectedConstraintIris,
    ),
    /runtime permission\/version declaration is invalid/u,
  );
});

test('a lock-and-registry-consistent facade entrypoint substitution is rejected', () => {
  const value = cloneFixture(base);
  const tool = value.lock.tools.find((row) => row.capabilities.length > 1);
  const capability = tool.capabilities.at(-1);
  const facadePath = 'scripts/domain/tests/fixtures/custom-facade.cjs';
  const facadeBytes = Buffer.from("'use strict';\nprocess.stdout.write('{}');\n", 'utf8');
  value.files.set(facadePath, facadeBytes);
  capability.entrypointRef = { kind: 'path', root: 'sourceTree', path: facadePath };
  capability.entrypointDigest = digest(facadeBytes);
  const entry = registryEntry(value.registry, capability.capabilityId);
  entry.entrypointRef = structuredClone(capability.entrypointRef);
  entry.entrypointDigest = capability.entrypointDigest;
  assert.throws(
    () => collectPayloadClosure(
      value.files, value.lock, value.registry, value.expectedConstraintIris,
    ),
    /substitutes a facade/u,
  );
});

test('sandbox process enforces timeout and output byte caps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-replay-limits-'));
  try {
    const timeoutWorker = path.join(root, 'timeout.cjs');
    fs.writeFileSync(timeoutWorker, "'use strict';\nwhile (true) {}\n", { flag: 'wx' });
    const timeout = spawnStdinWorker({
      root,
      entrypoint: timeoutWorker,
      inputBytes: Buffer.from('{}'),
      readPaths: [timeoutWorker],
      timeoutMs: 100,
      maxOutputBytes: 1024,
    });
    assert.equal(timeout.code, 'TIME_LIMIT');

    const outputWorker = path.join(root, 'output.cjs');
    fs.writeFileSync(outputWorker, "'use strict';\nprocess.stdout.write('x'.repeat(65536));\n", { flag: 'wx' });
    const output = spawnStdinWorker({
      root,
      entrypoint: outputWorker,
      inputBytes: Buffer.from('{}'),
      readPaths: [outputWorker],
      timeoutMs: 1000,
      maxOutputBytes: 1024,
    });
    assert.equal(output.code, 'OUTPUT_LIMIT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('forged caller evidence is ignored and cannot mask changed P1 input bytes', () => {
  const value = cloneFixture(base);
  const sourceTool = value.lock.tools.find((row) => (
    row.toolId === 'axiolune-foundation-market-strategy-custom-runtime-v1'
  ));
  const capability = sourceTool.capabilities[0];
  const tool = { ...structuredClone(sourceTool), capabilities: [structuredClone(capability)] };
  const lock = { schemaVersion: '1.0', tools: [tool] };
  const registry = {
    schemaVersion: '1.0',
    profileRef: value.registry.profileRef,
    entries: [structuredClone(registryEntry(value.registry, capability.capabilityId))],
  };
  const result = executeCustomPayload({
    files: value.files,
    lock,
    registry,
    expectedConstraintIris: [capability.capabilityId],
    hostDependencyRoot: ROOT,
    callerEvidence: { outcome: 'passed', caseCount: 5 },
  });
  assert.equal(result.caseCount, 5);
  assert.equal(result.callerEvidenceAccepted, false);

  const vectors = JSON.parse(value.files.get(capability.testVectorsRef.path).toString('utf8'));
  const inputPath = vectors.categories.positive[0].inputRef.path;
  value.files.set(inputPath, Buffer.from('{}', 'utf8'));
  assert.throws(() => executeCustomPayload({
    files: value.files,
    lock,
    registry,
    expectedConstraintIris: [capability.capabilityId],
    hostDependencyRoot: ROOT,
    callerEvidence: { outcome: 'passed', caseCount: 5 },
  }), /digest differs from reconstructed P1 bytes/u);
});
