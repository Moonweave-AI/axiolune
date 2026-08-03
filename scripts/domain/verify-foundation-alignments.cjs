#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { verifyAlignmentSemantics } = require('./lib/alignment-semantic-verifier.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE_PATH = path.join(
  ROOT,
  'scripts',
  'domain',
  'alignment-semantic-profile',
  'foundation-v1.json',
);
const LOCK_PATH = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const OUTPUT_PATH = path.join(
  ROOT,
  'docs',
  'domain',
  'infrastructure',
  'foundation-alignment-semantic-review.json',
);
const MIRROR_PATHS = [
  'ontology/domain/finance/foundation/module.owl.ttl',
  'generated/ontology/finance/foundation/foundation.owl.ttl',
];

async function buildReview() {
  const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  const modulePath = path.join(ROOT, profile.modulePath.split('/').join(path.sep));
  const moduleDocument = YAML.parse(fs.readFileSync(modulePath, 'utf8'));
  const referenceLock = YAML.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const mirrorBytesByPath = new Map();
  for (const mirrorPath of MIRROR_PATHS) {
    const absolute = path.join(ROOT, mirrorPath.split('/').join(path.sep));
    if (!fs.existsSync(absolute)) throw new Error(`missing generated OWL mirror ${mirrorPath}`);
    mirrorBytesByPath.set(mirrorPath, fs.readFileSync(absolute));
  }
  return verifyAlignmentSemantics({
    root: ROOT,
    moduleDocument,
    profile,
    referenceLock,
    mirrorBytesByPath,
  });
}

async function run(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check || argv.length !== 1) {
    throw new Error('choose exactly one mode: --write or --check');
  }
  const result = await buildReview();
  if (result.errors.length > 0) {
    console.error(`FAIL foundation alignment semantics: ${result.errors.length} finding(s)`);
    result.errors.forEach((message) => console.error(`  - ${message}`));
    return 1;
  }
  const expectedBytes = Buffer.from(`${JSON.stringify(result.artifact, null, 2)}\n`, 'utf8');
  if (write) {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, expectedBytes);
  } else if (!fs.existsSync(OUTPUT_PATH)
      || !fs.readFileSync(OUTPUT_PATH).equals(expectedBytes)) {
    console.error('FAIL foundation alignment semantics: review artifact is missing or drifted');
    return 1;
  }
  console.log(
    `PASS foundation alignment semantics: ${result.artifact.summary.retainedMachineReviewedCount} retained-machine-reviewed, `
      + `${result.artifact.summary.removedUnverifiableCount} removed-unverifiable, `
      + `${result.artifact.summary.currentAuthoredAlignmentCount} active alignment(s)`,
  );
  return 0;
}

if (require.main === module) {
  run().then((status) => {
    process.exitCode = status;
  }).catch((error) => {
    console.error(`FAIL foundation alignment semantics: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  MIRROR_PATHS,
  OUTPUT_PATH,
  PROFILE_PATH,
  buildReview,
  run,
};
