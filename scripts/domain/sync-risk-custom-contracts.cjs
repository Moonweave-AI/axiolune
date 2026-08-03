#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalJcs,
} = require('./lib/strict-source-locator.cjs');
const {
  canonicalRiskInputContract,
} = require('./lib/risk-canonical-record-adapter.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE = path.join(ROOT, 'scripts', 'domain', 'risk-custom-profile', 'v0.3.0');
const CONTRACTS = Object.freeze({
  'input-contract.json': canonicalRiskInputContract(),
  'output-contract.json': {
    canonicalEncoding: 'RFC8785-JCS',
    contractId: 'axiolune-risk-custom-result-v1',
    fields: [
      'assurance',
      'constraintIri',
      'dispatchDigest',
      'evaluatorId',
      'outcome',
      'schemaVersion',
      'violation',
    ],
    outcomeValues: ['accepted', 'notApplicable', 'rejected'],
    schemaVersion: '1.0',
    unknownFields: 'fatal',
  },
});

function main(argv) {
  const write = argv.length === 1 && argv[0] === '--write';
  const check = argv.length === 1 && argv[0] === '--check';
  if (!write && !check) {
    throw new Error('Usage: node scripts/domain/sync-risk-custom-contracts.cjs (--check|--write)');
  }
  const drift = [];
  for (const [name, document] of Object.entries(CONTRACTS)) {
    const file = path.join(PROFILE, name);
    const expected = Buffer.from(canonicalJcs(document), 'utf8');
    const actual = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (!actual?.equals(expected)) {
      drift.push(name);
      if (write) fs.writeFileSync(file, expected);
    }
  }
  if (drift.length > 0 && check) {
    throw new Error(`risk Custom contract drift: ${drift.join(', ')}`);
  }
  process.stdout.write(
    `Risk Custom contracts: ${drift.length === 0 ? 'PASS' : 'WROTE'} (${Object.keys(CONTRACTS).length})\n`,
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${cause?.stack || cause}\n`);
    process.exitCode = 1;
  }
}

module.exports = { CONTRACTS, main };
