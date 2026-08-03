#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  executeCustomPayload,
  TOOL_PROFILES,
} = require('./lib/custom-release-payload-replay.cjs');
const {
  REGISTRY_PATH,
  RELEASE_LOCK_PATH,
  buildReleaseToolchainLock,
  parseRegistryBytes,
} = require('./lib/m2-toolchain-lock-builder.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME_SANDBOX_PATHS = Object.freeze([
  'scripts/domain/strategy-research-v03-profile/quantity-unit-registry.json',
  'scripts/domain/lib/strategy-research-quantity-units.cjs',
  'tests/m2/fixtures/risk-bucket-key-contract-v1.json',
  'tests/m2/fixtures/risk-evidence-v1.json',
  'tests/m2/fixtures/risk-measurement-retraction-v1.json',
  'scripts/domain/reference-extractors/json-pointer-jcs-v1.json',
  'scripts/domain/reference-extractors/whole-file-v1.json',
]);

function absolute(relativePath) {
  const resolved = path.resolve(ROOT, ...relativePath.split('/'));
  if (!resolved.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error(`source path escapes repository root: ${relativePath}`);
  }
  return resolved;
}

function read(relativePath) {
  const filePath = absolute(relativePath);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`source artifact is not a regular non-symlink file: ${relativePath}`);
  }
  return fs.readFileSync(filePath);
}

function add(files, reference) {
  if (!reference?.path || files.has(reference.path)) return;
  files.set(reference.path, read(reference.path));
}

function addHostPath(files, relativePath) {
  if (files.has(relativePath)) return;
  files.set(relativePath, read(relativePath));
}

function walkSourceTreeRefs(value, refs) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkSourceTreeRefs(item, refs);
    return;
  }
  if (value.kind === 'path' && value.root === 'sourceTree' && typeof value.path === 'string') {
    refs.add(value.path);
  }
  for (const nested of Object.values(value)) walkSourceTreeRefs(nested, refs);
}

function expandScenarioInputClosure(files, lock) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const tool of lock.tools.filter((row) => Object.hasOwn(TOOL_PROFILES, row.toolId))) {
      for (const capability of tool.capabilities) {
        if (!files.has(capability.testVectorsRef.path)) continue;
        const vectors = JSON.parse(files.get(capability.testVectorsRef.path).toString('utf8'));
        for (const rows of Object.values(vectors.categories || {})) {
          for (const row of rows) {
            if (!files.has(row.inputRef.path)) {
              addHostPath(files, row.inputRef.path);
              changed = true;
            }
            const input = JSON.parse(files.get(row.inputRef.path).toString('utf8'));
            const refs = new Set();
            walkSourceTreeRefs(input.scenario ?? input, refs);
            for (const refPath of refs) {
              if (!files.has(refPath)) {
                addHostPath(files, refPath);
                changed = true;
              }
            }
          }
        }
      }
    }
  }
}

function currentPayload(lock, registryBytes) {
  const files = new Map([[REGISTRY_PATH, registryBytes]]);
  for (const tool of lock.tools.filter((row) => Object.hasOwn(TOOL_PROFILES, row.toolId))) {
    add(files, tool.artifactRef);
    add(files, tool.runtimeRef);
    const descriptor = JSON.parse(files.get(tool.artifactRef.path).toString('utf8'));
    const runtime = JSON.parse(files.get(tool.runtimeRef.path).toString('utf8'));
    add(files, descriptor.componentDiscovery.ref);
    for (const implementation of descriptor.implementationArtifacts) add(files, implementation.ref);
    add(files, runtime.dependencyLock.ref);
    for (const capability of tool.capabilities) {
      for (const prefix of [
        'capability', 'entrypoint', 'inputContract', 'outputContract',
        'discoveryContract', 'evidenceSchema', 'testVectors',
      ]) add(files, capability[`${prefix}Ref`]);
      const vectors = JSON.parse(files.get(capability.testVectorsRef.path).toString('utf8'));
      for (const rows of Object.values(vectors.categories)) {
        for (const row of rows) add(files, row.inputRef);
      }
    }
  }
  expandScenarioInputClosure(files, lock);
  for (const relativePath of RUNTIME_SANDBOX_PATHS) addHostPath(files, relativePath);
  return files;
}

function main() {
  const registryBytes = read(REGISTRY_PATH);
  const registry = parseRegistryBytes(registryBytes);
  const built = buildReleaseToolchainLock({ sourceRoot: ROOT, registry });
  if (built.outcome !== 'built') {
    throw new Error(`toolchain build failed: ${canonicalJcs(built.issues)}`);
  }
  // Tracked toolchain byte-lock verification removed.
  const result = executeCustomPayload({
    files: currentPayload(built.lock, registryBytes),
    lock: built.lock,
    registry,
    expectedConstraintIris: built.customConstraintIris,
    expectedContextCount: built.customContextCount,
    hostDependencyRoot: ROOT,
    onProgress(completed, total) {
      process.stderr.write(`isolated Custom payload replay: ${completed}/${total}\n`);
    },
  });
  process.stdout.write(`${canonicalJcs({
    outcome: result.outcome,
    definitionCount: result.definitionCount,
    contextCount: result.contextCount,
    caseCount: result.caseCount,
    isolatedTemporaryCopy: result.isolatedTemporaryCopy,
    callerEvidenceAccepted: result.callerEvidenceAccepted,
  })}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (cause) {
    process.stderr.write(`${cause.stack || cause.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { currentPayload, main };
