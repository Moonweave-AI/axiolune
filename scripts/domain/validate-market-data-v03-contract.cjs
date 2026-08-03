#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  auditModuleContract,
  validateScenario,
} = require('./lib/market-data-v03-contracts.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const MODULE_FILE = path.join(ROOT, 'ontology', 'domain', 'finance', 'market-data', 'module.yaml');

function loadYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

function format(finding) {
  return `${finding.code} @ ${finding.at}: ${finding.message}`;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length > 1) {
    throw new Error('Usage: node validate-market-data-v03-contract.cjs [scenario.yaml]');
  }
  const failures = [];
  const pending = [];
  const passes = [];
  const audit = auditModuleContract(loadYaml(MODULE_FILE));
  if (audit.violations.length === 0) passes.push('typed Market Data v0.3.0 ontology contract');
  else failures.push(...audit.violations.map(format));
  pending.push(...audit.pending.map(format));

  if (argv[0]) {
    const fixtureFile = path.resolve(argv[0]);
    const violations = validateScenario(loadYaml(fixtureFile));
    if (violations.length === 0) passes.push(`scenario accepted: ${path.relative(ROOT, fixtureFile)}`);
    else failures.push(...violations.map(format));
  }

  console.log('=== Market Data v0.3.0 contract validator ===');
  passes.forEach((item) => console.log(`PASS ${item}`));
  failures.forEach((item) => console.log(`FAIL ${item}`));
  pending.forEach((item) => console.log(`PENDING ${item}`));
  console.log(`SUMMARY pass=${passes.length} fail=${failures.length} pending=${pending.length}`);
  if (failures.length > 0) process.exitCode = 1;
  else if (pending.length > 0) process.exitCode = 2;
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
