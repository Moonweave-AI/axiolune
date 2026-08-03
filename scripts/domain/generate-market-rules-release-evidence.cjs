#!/usr/bin/env node
'use strict';

const {
  verifyAllMarketRulesReleaseEvidence,
  writeAllMarketRulesReleaseEvidence,
} = require('./lib/market-rules-release-evidence.cjs');

const args = new Set(process.argv.slice(2));
const allowed = new Set(['--write']);
for (const arg of args) {
  if (!allowed.has(arg)) {
    console.error(`unknown argument: ${arg}`);
    process.exit(64);
  }
}

try {
  if (args.has('--write')) writeAllMarketRulesReleaseEvidence();
  const result = verifyAllMarketRulesReleaseEvidence();
  for (const check of result.checks) {
    console.log(`PASS ${check.id}: executable immutable M2 test evidence replayed`);
  }
  for (const check of result.tamperChecks) {
    console.log(`PASS TAMPER/${check.caseId}: rejected with ${check.rejectionCode}`);
  }
  console.log(
    `PASS CLASSIFICATION: ${result.ledgerCount} ledgers are synthetic M2 conformance evidence, non-production, and claim no external authority`,
  );
  console.log(`PASS ARTIFACT_MANIFEST: ${result.manifestDigest}`);
  console.log(
    `market-rules runtime evidence: ${result.checks.length + result.tamperChecks.length + 2} passed, 0 failed`,
  );
} catch (error) {
  console.error(`FAIL ${error.code || 'UNCAUGHT'}: ${error.stack || error.message}`);
  process.exit(1);
}
