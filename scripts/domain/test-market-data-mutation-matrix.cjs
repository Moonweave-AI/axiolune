#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  buildMarketDataMutationEvidence,
} = require('./lib/market-data-mutation-matrix.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT = path.join(
  ROOT,
  'docs',
  'domain',
  'infrastructure',
  'market-data-mutation-evidence.json',
);

function main(argv = process.argv.slice(2)) {
  const write = argv.length === 1 && argv[0] === '--write';
  if (argv.length > (write ? 1 : 0)) {
    throw new Error('usage: node scripts/domain/test-market-data-mutation-matrix.cjs [--write]');
  }
  const evidence = buildMarketDataMutationEvidence();
  const bytes = Buffer.from(`${canonicalJcs(evidence)}\n`, 'utf8');
  if (write) {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, bytes);
  } else if (!fs.existsSync(OUTPUT) || !fs.readFileSync(OUTPUT).equals(bytes)) {
    throw new Error(
      'market-data mutation evidence is missing or drifted; regenerate it with --write',
    );
  }
  if (evidence.outcome !== 'passed') {
    const failures = evidence.cases
      .filter((entry) => entry.outcome !== 'passed')
      .map((entry) => `${entry.id}: missing=${entry.missingCodes.join(',')}`);
    throw new Error(`market-data mutation matrix failed: ${failures.join('; ')}`);
  }
  const { categories } = evidence.summary;
  process.stdout.write(
    `PASS market-data mutation matrix cases=${evidence.summary.caseCount} `
      + `date=${categories.date.passedCount} decimal=${categories.decimal.passedCount} `
      + `rounding=${categories.rounding.passedCount} pit=${categories.pit.passedCount}\n`,
  );
}

try {
  main();
} catch (cause) {
  process.stderr.write(`${cause.stack || cause.message}\n`);
  process.exitCode = 1;
}

module.exports = { main };
