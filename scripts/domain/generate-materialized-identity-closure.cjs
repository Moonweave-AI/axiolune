#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  GLOBAL_COMPILATION_REF,
  GLOBAL_MANIFEST_REF,
  GLOBAL_REGISTRY_REF,
  SOURCE_MANIFEST_REF,
  compileMaterializedIdentityClosure,
} = require('./lib/m2-materialized-identity-closure.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

function resolveRef(ref) {
  return path.resolve(ROOT, ...ref.path.split('/'));
}

function bytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function outputs(result) {
  return [
    [GLOBAL_REGISTRY_REF, bytes(result.registry)],
    [GLOBAL_COMPILATION_REF, bytes(result.compilation)],
    [GLOBAL_MANIFEST_REF, bytes(result.manifest)],
    [SOURCE_MANIFEST_REF, bytes(result.sourceManifest)],
  ];
}

function run(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check || argv.some((argument) => !['--write', '--check'].includes(argument))) {
    throw new Error('usage: node scripts/domain/generate-materialized-identity-closure.cjs (--write|--check)');
  }
  const result = compileMaterializedIdentityClosure(ROOT);
  const drift = [];
  for (const [ref, content] of outputs(result)) {
    const target = resolveRef(ref);
    if (write) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    } else if (!fs.existsSync(target) || !fs.statSync(target).isFile()
        || !fs.readFileSync(target).equals(content)) {
      drift.push(ref.path);
    }
  }
  if (drift.length > 0) throw new Error(`materialized identity closure is missing or byte-drifted: ${drift.join(', ')}`);
  return {
    mode: write ? 'write' : 'check',
    ...result.stats,
    registryDigest: result.registryDigest,
    manifestDigest: result.manifestDigest,
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run()));
  } catch (error) {
    console.error(`FAIL materialized identity closure: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { outputs, run };
