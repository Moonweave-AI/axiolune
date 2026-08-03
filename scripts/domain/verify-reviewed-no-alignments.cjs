#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const { verifyReviewedNoAlignments } = require('./lib/reviewed-no-alignment.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT = path.join(
  ROOT,
  'docs',
  'domain',
  'infrastructure',
  'reviewed-no-alignment-evidence.json',
);

function run(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check || argv.some((argument) => !['--write', '--check'].includes(argument))) {
    throw new Error('usage: node scripts/domain/verify-reviewed-no-alignments.cjs (--write|--check)');
  }
  const result = verifyReviewedNoAlignments({ rootDir: ROOT });
  if (!result.ok) throw new Error(result.errors.join('; '));
  const expected = Buffer.from(canonicalJcs(result.evidence), 'utf8');
  if (write) {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, expected);
  } else if (!fs.existsSync(OUTPUT) || !fs.readFileSync(OUTPUT).equals(expected)) {
    throw new Error('reviewed-no-alignment-evidence.json is missing or byte-drifted');
  }
  return {
    mode: write ? 'write' : 'check',
    decisionCount: result.evidence.decisions.length,
    conclusion: result.evidence.conclusion,
    approvalStatus: result.evidence.approvalStatus,
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run()));
  } catch (error) {
    console.error(`FAIL reviewed no-alignment verification: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { OUTPUT, run };
