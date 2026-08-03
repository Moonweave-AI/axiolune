#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  SOURCE_COMPILATION_REF,
  SOURCE_REGISTRY_REF,
  buildPortfolioObservationIdentitySource,
} = require('./lib/portfolio-observation-identity-source.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_MANIFEST_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'mappings/finance/v0.3.0/portfolio-positions/identity/portfolio-observation-identity-manifest.json',
});

function bytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function absolute(ref) {
  return path.resolve(ROOT, ...ref.path.split('/'));
}

function outputs(result) {
  return [
    [SOURCE_COMPILATION_REF, bytes(result.compilation)],
    [SOURCE_REGISTRY_REF, bytes(result.registry)],
    [SOURCE_MANIFEST_REF, bytes(result.manifest)],
  ];
}

function run(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check || argv.some((argument) => !['--write', '--check'].includes(argument))) {
    throw new Error('usage: node scripts/domain/generate-portfolio-observation-identity-source.cjs (--write|--check)');
  }
  const result = buildPortfolioObservationIdentitySource(ROOT);
  const drift = [];
  for (const [ref, content] of outputs(result)) {
    const target = absolute(ref);
    if (write) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    } else if (!fs.existsSync(target) || !fs.statSync(target).isFile()
        || !fs.readFileSync(target).equals(content)) {
      drift.push(ref.path);
    }
  }
  if (drift.length > 0) {
    throw new Error(`Portfolio observation identity source is missing or byte-drifted: ${drift.join(', ')}`);
  }
  return {
    contractCount: result.compilation.contracts.length,
    mappingCount: result.compilation.mappings.length,
    mode: write ? 'write' : 'check',
    targetCount: result.compilation.concreteTargetTypes.length,
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run()));
  } catch (error) {
    console.error(`FAIL Portfolio observation identity source: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { outputs, run };
