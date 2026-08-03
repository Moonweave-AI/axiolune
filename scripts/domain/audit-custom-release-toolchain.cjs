#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const FINANCE = path.join(ROOT, 'ontology', 'domain', 'finance');
const DEFAULT_RELEASE_LOCK = path.join(ROOT, 'releases', 'v0.3.0', 'toolchain.lock.json');

function posix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function discoverConstraints() {
  const rows = [];
  for (const moduleName of fs.readdirSync(FINANCE).sort()) {
    const file = path.join(FINANCE, moduleName, 'module.yaml');
    if (!fs.existsSync(file)) continue;
    const document = yaml.load(fs.readFileSync(file, 'utf8'), {
      schema: yaml.CORE_SCHEMA.withTags(yaml.mergeTag),
    });
    for (const constraint of Object.values(document?.domain?.constraints || {})) {
      if (constraint?.expression?.language === 'Custom') {
        rows.push({
          constraintIri: constraint.iri,
          moduleName,
          sourcePath: posix(path.relative(ROOT, file)),
        });
      }
    }
  }
  rows.sort((left, right) => Buffer.compare(
    Buffer.from(left.constraintIri),
    Buffer.from(right.constraintIri),
  ));
  return rows;
}

function discoverExistingLocks(directory, rows = []) {
  if (!fs.existsSync(directory)) return rows;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) discoverExistingLocks(absolute, rows);
    else if (entry.isFile() && entry.name === 'toolchain.lock.json') {
      rows.push(posix(path.relative(ROOT, absolute)));
    }
  }
  return rows.sort();
}

function audit(lockFile = DEFAULT_RELEASE_LOCK) {
  const constraints = discoverConstraints();
  const existingLocks = discoverExistingLocks(path.join(ROOT, 'scripts', 'domain'));
  let lock = null;
  let lockError = null;
  if (fs.existsSync(lockFile)) {
    try {
      const bytes = fs.readFileSync(lockFile);
      lock = JSON.parse(bytes.toString('utf8'));
      if (!bytes.equals(Buffer.from(canonicalJcs(lock), 'utf8'))) {
        throw new Error('release toolchain lock is not exact RFC 8785 JCS');
      }
    } catch (cause) {
      lockError = cause.message;
    }
  }
  const capabilities = new Map();
  for (const tool of Array.isArray(lock?.tools) ? lock.tools : []) {
    for (const capability of Array.isArray(tool?.capabilities) ? tool.capabilities : []) {
      if (typeof capability.capabilityId === 'string') {
        capabilities.set(capability.capabilityId, {
          toolId: tool.toolId,
          toolVersion: tool.version,
          capability,
        });
      }
    }
  }
  const missing = constraints
    .filter((row) => !capabilities.has(row.constraintIri))
    .map((row) => row.constraintIri);
  const invalidBindings = [];
  const requiredCapabilityFields = [
    'capabilityId', 'capabilityRef', 'capabilityDigest', 'entrypointRef',
    'entrypointDigest', 'inputContractRef', 'inputContractDigest',
    'outputContractRef', 'outputContractDigest', 'discoveryContractRef',
    'discoveryContractDigest', 'evidenceSchemaRef', 'evidenceSchemaDigest',
    'testVectorsRef', 'testVectorsDigest',
  ];
  for (const row of constraints) {
    const binding = capabilities.get(row.constraintIri);
    if (!binding) continue;
    const actual = Object.keys(binding.capability).sort();
    if (canonicalJcs(actual) !== canonicalJcs([...requiredCapabilityFields].sort())
        || typeof binding.toolVersion !== 'string' || binding.toolVersion.length === 0) {
      invalidBindings.push(row.constraintIri);
    }
  }
  const releaseLockPath = posix(path.relative(ROOT, lockFile));
  const moduleCount = new Set(constraints.map((row) => row.moduleName)).size;
  const seen = new Set();
  const duplicateConstraintIris = [];
  for (const row of constraints) {
    if (seen.has(row.constraintIri)) duplicateConstraintIris.push(row.constraintIri);
    seen.add(row.constraintIri);
  }
  const eligible = moduleCount === 10 && constraints.length > 0
    && duplicateConstraintIris.length === 0
    && Boolean(lock) && !lockError && missing.length === 0 && invalidBindings.length === 0;
  return {
    schemaVersion: '1.0',
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    outcome: eligible ? 'passed' : 'blocked',
    releaseLockPath,
    releaseLockExists: fs.existsSync(lockFile),
    releaseLockError: lockError,
    existingComponentLockPaths: existingLocks,
    moduleCount,
    customConstraintCount: constraints.length,
    duplicateConstraintIris,
    requiredBindingCount: constraints.length,
    boundConstraintCount: constraints.length - missing.length,
    missingCapabilityIris: missing,
    invalidCapabilityIris: invalidBindings,
    requiredVectorSchemaRef:
      'scripts/domain/release-profile/v0.3.0/custom-constraint-test-vectors.schema.json',
    componentLocksCountAsReleaseLock: false,
  };
}

function main() {
  const requested = argument('--toolchain-lock');
  const result = audit(requested ? path.resolve(ROOT, requested) : DEFAULT_RELEASE_LOCK);
  process.stdout.write(`${canonicalJcs(result)}\n`);
  process.exitCode = result.outcome === 'passed' ? 0 : 1;
}

if (require.main === module) main();

module.exports = { audit, discoverConstraints, discoverExistingLocks };
