#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  PAYWALLED_SENTINEL,
  fileDigest,
} = require('./lib/reference-closure.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCK_PATH = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const COVERAGE_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'reference-review-coverage.json',
);
const OUTPUT_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'reference-closure-manifest.json',
);

function artifactRef(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function buildClosureManifest(lock, coverage, lockDigest) {
  if (!lock || !Array.isArray(lock.references) || lock.references.length === 0) {
    throw new Error('reference lock has no entries');
  }
  if (!coverage || !coverage.referenceRootDigest) {
    throw new Error('coverage has no exact referenceRootDigest');
  }
  const entries = lock.references.map((reference) => {
    const common = {
      referenceId: reference.id,
      availability: reference.artifactDigest === PAYWALLED_SENTINEL
        ? 'unavailablePaywalled'
        : 'localLocked',
      releaseOrCommit: reference.releaseOrCommit,
      sourceUrl: reference.artifactUrl,
      license: reference.license,
      maturity: reference.maturity,
      usageScope: reference.usageScope,
      locators: reference.locators,
    };
    if (common.availability === 'unavailablePaywalled') return common;
    return {
      ...common,
      artifactRef: artifactRef(reference.localPath),
      artifactDigest: reference.artifactDigest,
    };
  }).sort((left, right) => utf8Compare(left.referenceId, right.referenceId));
  return {
    schemaVersion: '1.0',
    lockSourceRef: artifactRef('docs/ontology/references/references.lock.yaml'),
    lockSourceDigest: lockDigest,
    referenceBundleRef: artifactRef('reference'),
    referenceBundleDigest: coverage.referenceRootDigest,
    entries,
  };
}

function outputBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function run(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check) throw new Error('choose exactly one mode: --write or --check');
  const lock = YAML.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const coverage = JSON.parse(fs.readFileSync(COVERAGE_PATH, 'utf8'));
  const closure = buildClosureManifest(lock, coverage, fileDigest(LOCK_PATH));
  const expected = outputBytes(closure);
  if (write) {
    fs.writeFileSync(OUTPUT_PATH, expected);
  } else if (!fs.existsSync(OUTPUT_PATH) || !fs.readFileSync(OUTPUT_PATH).equals(expected)) {
    throw new Error('reference-closure-manifest.json is missing or byte-drifted');
  }
  return {
    mode: write ? 'write' : 'check',
    referenceBundleDigest: closure.referenceBundleDigest,
    entryCount: closure.entries.length,
    locatorCount: closure.entries.reduce((total, entry) => total + entry.locators.length, 0),
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run()));
  } catch (error) {
    console.error(`FAIL reference closure manifest: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildClosureManifest,
  outputBytes,
  run,
};
