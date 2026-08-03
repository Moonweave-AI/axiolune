#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  ROOT,
} = require('./lib/custom-release-capability.cjs');
const {
  customReleaseExitCode,
  verifyCustomReleaseCapabilities,
  writeEvidence,
} = require('./lib/custom-release-capability-executor.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--output-dir') {
    throw new Error('usage: verify-custom-release-capabilities.cjs --output-dir <directory>');
  }
  const outputDirectory = path.resolve(ROOT, argv[1]);
  const result = await verifyCustomReleaseCapabilities({
    onProgress(completed, total) {
      process.stderr.write(`Custom release capability execution: ${completed}/${total}\n`);
    },
  });
  const exitCode = customReleaseExitCode(result.evidence);
  const manifest = writeEvidence(outputDirectory, result);
  process.stdout.write(`${canonicalJcs({
    componentEligible: result.evidence.componentEligible,
    outcome: result.evidence.outcome,
    definitionCount: result.evidence.definitionCount,
    contextCount: result.evidence.contextCount,
    caseCount: result.evidence.caseCount,
    passedCaseCount: result.evidence.passedCaseCount,
    pendingCaseCount: result.evidence.pendingCaseCount,
    evidenceDigest: manifest.evidenceDigest,
    evidenceRef: manifest.evidenceRef,
  })}\n`);
  if (exitCode !== 0) {
    process.stderr.write(
      `Custom release capability execution: PENDING `
        + `(cases=${result.evidence.caseCount}, pending=${result.evidence.pendingCaseCount})\n`,
    );
    process.exitCode = exitCode;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((cause) => {
    process.stderr.write(`${cause.stack || cause.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
