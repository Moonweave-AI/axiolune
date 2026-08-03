#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  REGISTRY_PATH,
  RELEASE_CHECKS_PATH,
  REQUIRED_GATES_PATH,
  parseRegistryBytes,
} = require('./lib/m2-release-capability-registry.cjs');
const { executeReleaseCapabilityPayload } = require('./lib/m2-release-capability-replay.cjs');
const { buildReleaseToolchainLock } = require('./lib/m2-toolchain-lock-builder.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function collectRegularFiles(root, directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      collectRegularFiles(root, absolute, files);
    } else if (entry.isFile() && !entry.isSymbolicLink()) {
      files.set(toPosix(path.relative(root, absolute)), fs.readFileSync(absolute));
    } else {
      throw new Error(`release capability source contains non-regular entry ${absolute}`);
    }
  }
}

function readClosedSourceFile(root, reference, label) {
  if (!reference || reference.kind !== 'path' || reference.root !== 'sourceTree'
      || typeof reference.path !== 'string' || reference.path.length === 0
      || reference.path.includes('\\') || reference.path.startsWith('/')
      || /^[A-Za-z]:/u.test(reference.path)
      || reference.path.split('/').some((segment) => (
        segment === '' || segment === '.' || segment === '..'
      ))) {
    throw new Error(`${label} is not a closed sourceTree path reference`);
  }
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(resolvedRoot, ...reference.path.split('/'));
  const relative = path.relative(resolvedRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the source root`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular non-symlink source file`);
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const realFile = fs.realpathSync(absolute);
  const realRelative = path.relative(realRoot, realFile);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error(`${label} resolves outside the source root`);
  }
  return fs.readFileSync(realFile);
}

function parseExactJcs(bytes, label) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${label} is not exact UTF-8 RFC 8785 JCS`);
  }
  return value;
}

function addReferencedSourceFile(root, files, reference, label) {
  const bytes = readClosedSourceFile(root, reference, label);
  files.set(reference.path, bytes);
  return bytes;
}

function sourceFileMap(root = ROOT) {
  const files = new Map();
  collectRegularFiles(
    root,
    path.join(root, 'scripts', 'domain', 'release-capability-profile', 'v0.3.0'),
    files,
  );
  for (const relativePath of [
    REGISTRY_PATH,
    REQUIRED_GATES_PATH,
    RELEASE_CHECKS_PATH,
    'scripts/domain/run-release-capability.cjs',
    'scripts/domain/lib/m2-release-capability-definitions.cjs',
    'scripts/domain/lib/m2-release-capability-runtime.cjs',
    'scripts/domain/lib/strict-source-locator.cjs',
    'package-lock.json',
  ]) {
    files.set(relativePath, fs.readFileSync(path.join(root, ...relativePath.split('/'))));
  }
  const registry = parseRegistryBytes(files.get(REGISTRY_PATH));
  if (!Array.isArray(registry.entries) || registry.entries.length === 0) {
    throw new Error('release capability registry has no entries');
  }
  for (const [index, entry] of registry.entries.entries()) {
    const capabilityBytes = files.get(entry.capabilityRef?.path);
    if (!capabilityBytes) {
      throw new Error(`registry.entries[${index}].capabilityRef bytes are absent`);
    }
    const capability = parseExactJcs(
      capabilityBytes,
      `registry.entries[${index}].capabilityRef`,
    );
    if (!Array.isArray(capability.semanticImplementationArtifacts)
        || capability.semanticImplementationArtifacts.length === 0) {
      throw new Error(`registry.entries[${index}] has no semantic implementation closure`);
    }
    for (const [implementationIndex, implementation] of (
      capability.semanticImplementationArtifacts.entries()
    )) {
      addReferencedSourceFile(
        root,
        files,
        implementation?.ref,
        `registry.entries[${index}].semanticImplementationArtifacts[${implementationIndex}]`,
      );
    }
  }
  const descriptorRef = registry.entries[0].toolArtifactRef;
  const descriptorBytes = files.get(descriptorRef?.path);
  if (!descriptorBytes) throw new Error('release tool descriptor bytes are absent');
  const descriptor = parseExactJcs(descriptorBytes, 'release tool descriptor');
  if (!Array.isArray(descriptor.implementationArtifacts)
      || descriptor.implementationArtifacts.length === 0) {
    throw new Error('release tool descriptor has no implementation closure');
  }
  for (const [index, implementation] of descriptor.implementationArtifacts.entries()) {
    addReferencedSourceFile(
      root,
      files,
      implementation?.ref,
      `release tool descriptor implementationArtifacts[${index}]`,
    );
  }
  return files;
}

function main() {
  const build = buildReleaseToolchainLock({ sourceRoot: ROOT });
  if (build.outcome !== 'built') {
    throw new Error(`release toolchain is not buildable: ${build.issues[0]?.message || 'unknown'}`);
  }
  const files = sourceFileMap(ROOT);
  const registry = parseRegistryBytes(files.get(REGISTRY_PATH));
  const result = executeReleaseCapabilityPayload({
    files,
    lock: build.lock,
    registry,
    requiredGates: JSON.parse(files.get(REQUIRED_GATES_PATH).toString('utf8')),
    releaseChecks: JSON.parse(files.get(RELEASE_CHECKS_PATH).toString('utf8')),
  });
  const summary = {
    schemaVersion: '1.0',
    outcome: result.outcome,
    capabilityCount: result.capabilityCount,
    requiredGateCapabilityCount: result.requiredGateCapabilityCount,
    releaseCheckCapabilityCount: result.releaseCheckCapabilityCount,
    caseCount: result.caseCount,
    isolatedTemporaryCopy: result.isolatedTemporaryCopy,
    callerEvidenceAccepted: result.callerEvidenceAccepted,
  };
  process.stdout.write(`${canonicalJcs(summary)}\n`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (cause) {
    process.stderr.write(`${cause.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, sourceFileMap };
