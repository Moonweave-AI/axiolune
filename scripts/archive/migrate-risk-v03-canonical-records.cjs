#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  encodeCanonicalRiskScenario,
} = require('../domain/lib/risk-canonical-record-adapter.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGET = path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'risk-v03.yaml');

function main(argv) {
  if (argv.length !== 1 || argv[0] !== '--write') {
    throw new Error('Usage: node scripts/archive/migrate-risk-v03-canonical-records.cjs --write');
  }
  const document = YAML.parse(fs.readFileSync(TARGET, 'utf8'));
  for (const fixture of document.fixtures || []) {
    if (fixture.instance?.schemaVersion === '1.0' && Array.isArray(fixture.instance.records)) {
      continue;
    }
    fixture.instance = encodeCanonicalRiskScenario(fixture.instance);
  }
  fs.writeFileSync(TARGET, YAML.stringify(document, { lineWidth: 120 }), 'utf8');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${cause?.stack || cause}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
