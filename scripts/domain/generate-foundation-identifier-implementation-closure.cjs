#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  IMPLEMENTATION_CLOSURE_PATH,
  IMPLEMENTATION_CLOSURE_TAG,
  ROOT,
  fileDigest,
  sourceRef,
} = require('./lib/foundation-identifier-capability.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const crypto = require('node:crypto');
const path = require('node:path');

const ARTIFACTS = Object.freeze([
  ['worker', 'scripts/domain/foundation-identifier-worker.cjs'],
  ['wasm', 'scripts/domain/identifier-custom-profile/v0.3.0/foundation-identifier-core.wasm'],
  ['registry', 'scripts/domain/identifier-custom-profile/v0.3.0/scheme-validator-registry.json'],
  ['implementation', 'scripts/domain/lib/foundation-identifier-custom.cjs'],
  ['runtimeDependency', 'scripts/domain/lib/strict-source-locator.cjs'],
]);

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function expectedBytes() {
  const artifacts = ARTIFACTS.map(([role, relativePath]) => ({
    digest: fileDigest(path.join(ROOT, ...relativePath.split('/'))),
    ref: sourceRef(relativePath),
    role,
  })).sort((left, right) => Buffer.compare(Buffer.from(left.ref.path), Buffer.from(right.ref.path)));
  const closure = {
    artifacts,
    closureDigest: sha256(Buffer.concat([
      Buffer.from(IMPLEMENTATION_CLOSURE_TAG, 'utf8'),
      Buffer.from(canonicalJcs(artifacts), 'utf8'),
    ])),
    schemaVersion: '1.0',
  };
  return Buffer.from(canonicalJcs(closure), 'utf8');
}

function main(argv) {
  if (argv.length !== 1 || !['--check', '--write'].includes(argv[0])) {
    throw new Error('usage: generate-foundation-identifier-implementation-closure.cjs --check|--write');
  }
  const expected = expectedBytes();
  if (argv[0] === '--write') fs.writeFileSync(IMPLEMENTATION_CLOSURE_PATH, expected);
  else if (!fs.existsSync(IMPLEMENTATION_CLOSURE_PATH)
      || !fs.readFileSync(IMPLEMENTATION_CLOSURE_PATH).equals(expected)) {
    throw new Error('Foundation identifier implementation closure drift');
  }
  process.stdout.write(`PASS Foundation identifier implementation closure ${argv[0].slice(2)} (artifacts=${ARTIFACTS.length})\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (cause) {
    process.stderr.write(`${cause.stack || cause.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { ARTIFACTS, expectedBytes, main };
