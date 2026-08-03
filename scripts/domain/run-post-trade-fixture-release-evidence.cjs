#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalJcs,
} = require('./lib/strict-source-locator.cjs');
const {
  createPostTradeFixtureReleaseEvidence,
} = require('./lib/post-trade-fixture-release-evidence.cjs');

const EVIDENCE_NAME = 'post-trade-fixture-release-evidence.json';

function parseArgs(argv) {
  if (argv.length === 2 && argv[0] === '--output-dir') return path.resolve(argv[1]);
  throw new Error('Usage: node scripts/domain/run-post-trade-fixture-release-evidence.cjs --output-dir <directory>');
}

async function main(argv) {
  const outputDirectory = parseArgs(argv);
  const evidence = await createPostTradeFixtureReleaseEvidence();
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(outputDirectory, EVIDENCE_NAME),
    Buffer.from(canonicalJcs(evidence), 'utf8'),
  );
  process.stdout.write(
    'Post-trade fixture release evidence: PASS '
      + `(Custom=${evidence.canonicalRuntime.customRuntimeEvidence.discoveredConstraints.length}, `
      + `fixtures=${evidence.canonicalRuntime.positiveFixtureCount}/${evidence.canonicalRuntime.negativeFixtureCount}`
      + `+${evidence.canonicalRuntime.processingFindingPositiveFixtureCount}`
      + `/${evidence.canonicalRuntime.processingFindingNegativeFixtureCount}, `
      + `SHACL=${evidence.shacl.constraintCount}, `
      + `findingEntitySHACL=${evidence.shacl.processingFindingEntityResultCount}, `
      + `entitlementRoleSHACL=${evidence.shacl.relatedEntitlementRoleResultCount}, `
      + `diagnosticDerivations=${evidence.diagnosticTypedAdapter.derivationCount})\n`,
  );
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((cause) => {
    process.stderr.write(`${cause?.stack || cause}\n`);
    process.exitCode = 1;
  });
}

module.exports = { EVIDENCE_NAME, main };
