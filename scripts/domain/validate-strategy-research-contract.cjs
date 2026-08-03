#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  validateFixtureDocument,
  validateStrategyResearchModule,
} = require('./lib/strategy-research-contracts.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

function usage() {
  console.error([
    'usage:',
    '  node scripts/domain/validate-strategy-research-contract.cjs --module',
    '  node scripts/domain/validate-strategy-research-contract.cjs --fixtures <file.yaml> [file.yaml ...]',
    '',
    'exit 0 = requested checks passed; exit 1 = contract failure; exit 2 = module structurally valid but release evidence pending',
  ].join('\n'));
}

function printModuleResult(result) {
  console.log('=== Strategy/Research Module Contract ===');
  console.log(`status: ${result.status.toUpperCase()}`);
  console.log(`materialized types checked: ${result.evidence.materializedTypes}`);
  console.log(`reference-mode bindings checked: ${result.evidence.referenceModeBindings}`);
  console.log(`Qlib conflict mappings verified: ${result.evidence.qlibConflictMappings}`);
  console.log(`SemanticMappingDefinitions replayed: ${result.evidence.semanticMappingDefinitions}`);
  console.log(`materialized records replayed: ${result.evidence.materializedRecords}`);
  console.log(`active CQ probes passed: ${result.evidence.cqActivePassed}`);
  console.log(`non-core CQ deferrals verified: ${result.evidence.cqDeferredNonCore}`);
  console.log(`three-axis PIT replays passed: ${result.evidence.pitReplaysPassed}`);
  console.log(`restricted formula vectors passed: ${result.evidence.formulaVectorsPassed}`);
  for (const error of result.errors) console.error(`FAIL: ${error}`);
  for (const item of result.pending) console.log(`PENDING: ${item}`);
}

function validateFixtureFile(file) {
  const absolute = path.resolve(ROOT, file);
  let document;
  try {
    document = YAML.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [{ code: 'FIXTURE_PARSE', at: file, message: error.message }], results: [] };
  }
  const result = validateFixtureDocument(document);
  console.log(`=== ${path.relative(ROOT, absolute).replaceAll('\\', '/')} ===`);
  for (const entry of result.results) {
    const marker = entry.matched ? 'PASS' : 'FAIL';
    const codes = entry.violations.map((violation) => violation.code).join(',') || 'none';
    console.log(`${marker}: ${entry.id} expected=${entry.expected} actual=${entry.actual} violations=${codes}`);
  }
  for (const error of result.errors) console.error(`FAIL: ${error.at}: ${error.code}: ${error.message}`);
  return result;
}

function main(argv) {
  if (argv.length === 1 && argv[0] === '--module') {
    const result = validateStrategyResearchModule({ root: ROOT });
    printModuleResult(result);
    if (result.status === 'pass') return 0;
    if (result.status === 'pending') return 2;
    return 1;
  }
  if (argv[0] === '--fixtures' && argv.length > 1) {
    const results = argv.slice(1).map(validateFixtureFile);
    return results.every((result) => result.ok) ? 0 : 1;
  }
  usage();
  return 1;
}

process.exitCode = main(process.argv.slice(2));
