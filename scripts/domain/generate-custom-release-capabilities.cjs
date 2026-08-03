#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  PROFILE_ROOT,
  REGISTRY_PATH,
  ROOT,
  absolute,
  buildCustomReleaseArtifacts,
  byteCompare,
  sha256,
} = require('./lib/custom-release-capability.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

function existingGeneratedPaths() {
  const root = absolute(PROFILE_ROOT);
  if (!fs.existsSync(root)) return [];
  const result = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`generated profile contains symlink ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) result.push(path.relative(ROOT, file).replaceAll(path.sep, '/'));
    }
  }
  visit(root);
  return result.sort(byteCompare);
}

function writeArtifacts(generated) {
  for (const [relativePath, bytes] of [...generated.artifacts].sort((left, right) => (
    byteCompare(left[0], right[0])
  ))) {
    const file = absolute(relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  const expected = [...generated.artifacts.keys()]
    .filter((relativePath) => relativePath.startsWith(`${PROFILE_ROOT}/`))
    .sort(byteCompare);
  const actual = existingGeneratedPaths();
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    throw new Error(`generated profile contains stale or missing files: expected=${expected.length}, actual=${actual.length}`);
  }
}

function auditArtifacts(generated) {
  const mismatches = [];
  for (const [relativePath, expected] of generated.artifacts) {
    const file = absolute(relativePath);
    if (!fs.existsSync(file)) mismatches.push({ path: relativePath, reason: 'missing' });
    else if (!fs.readFileSync(file).equals(expected)) mismatches.push({ path: relativePath, reason: 'drift' });
  }
  const expected = [...generated.artifacts.keys()]
    .filter((relativePath) => relativePath.startsWith(`${PROFILE_ROOT}/`))
    .sort(byteCompare);
  const actual = existingGeneratedPaths();
  for (const extra of actual.filter((relativePath) => !expected.includes(relativePath))) {
    mismatches.push({ path: extra, reason: 'extra' });
  }
  return mismatches.sort((left, right) => byteCompare(left.path, right.path));
}

async function main() {
  const write = process.argv.slice(2).includes('--write');
  if (process.argv.length > (write ? 3 : 2)) throw new Error('usage: generate-custom-release-capabilities.cjs [--write]');
  const generated = await buildCustomReleaseArtifacts();
  if (write) writeArtifacts(generated);
  const mismatches = auditArtifacts(generated);
  const result = {
    schemaVersion: '1.0',
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    outcome: mismatches.length === 0 ? 'passed' : 'drift',
    mode: write ? 'write-and-audit' : 'audit',
    definitionCount: generated.definitionCount,
    contextCount: generated.contextCount,
    artifactCount: generated.artifacts.size,
    registryPath: REGISTRY_PATH,
    registryDigest: generated.registryDigest,
    mismatchCount: mismatches.length,
    mismatches,
    generatedSetDigest: sha256(Buffer.from(canonicalJcs(
      [...generated.artifacts].map(([relativePath, bytes]) => ({
        path: relativePath,
        digest: sha256(bytes),
        byteLength: bytes.length,
      })).sort((left, right) => byteCompare(left.path, right.path)),
    ), 'utf8')),
  };
  process.stdout.write(`${canonicalJcs(result)}\n`);
  process.exitCode = result.outcome === 'passed' ? 0 : 1;
}

if (require.main === module) {
  main().catch((cause) => {
    process.stderr.write(`${cause.stack || cause.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { auditArtifacts, existingGeneratedPaths, writeArtifacts };
