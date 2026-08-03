#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  loadYaml,
  mutate,
  validateFoundation,
  validateMarketRules,
  validateInstance,
} = require('./lib/foundation-market-rules-contract.cjs');
const {
  buildCodeListAuthorityIndex,
  buildReferenceEvidenceIndex,
} = require('./lib/source-evidence-reference.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const FOUNDATION_FILE = path.join(
  ROOT, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
);
const RULES_FILE = path.join(
  ROOT, 'ontology', 'domain', 'finance', 'market-rules', 'module.yaml',
);
const POSITIVE_FILE = path.join(
  ROOT, 'tests', 'm2', 'fixtures', 'positive', 'foundation-market-rules-contract.yaml',
);
const NEGATIVE_FILE = path.join(
  ROOT, 'tests', 'm2', 'fixtures', 'negative', 'foundation-market-rules-contract.yaml',
);
const REFERENCE_LOCK_FILE = path.join(
  ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml',
);
const CODE_LIST_AUTHORITY_FILE = path.join(
  ROOT,
  'reference',
  'ontology-design-reference',
  'axiolune-controlled-vocabularies',
  'm2-v0.3-code-lists.json',
);

let passed = 0;
let failed = 0;
let pending = 0;

function pass(id, detail) {
  passed += 1;
  console.log(`PASS ${id}: ${detail}`);
}

function fail(id, detail) {
  failed += 1;
  console.error(`FAIL ${id}: ${detail}`);
}

function pend(id, detail) {
  pending += 1;
  console.log(`PENDING ${id}: ${detail}`);
}

try {
  const referenceState = buildReferenceEvidenceIndex(loadYaml(REFERENCE_LOCK_FILE));
  for (const error of referenceState.errors) fail('EVIDENCE/reference-lock', error);
  const codeListAuthorityState = buildCodeListAuthorityIndex(
    JSON.parse(fs.readFileSync(CODE_LIST_AUTHORITY_FILE, 'utf8')),
    referenceState.entries,
  );
  for (const error of codeListAuthorityState.errors) fail('EVIDENCE/code-list-authority', error);
  const authorityOptions = { codeListAuthorityState };

  const foundation = validateFoundation(loadYaml(FOUNDATION_FILE), authorityOptions);
  if (foundation.errors.length === 0) pass('MODULE/foundation', 'RFC-001 5.5/5.8/5.11 typed contract');
  else for (const error of foundation.errors) fail('MODULE/foundation', error);
  for (const item of foundation.pending) pend('EVIDENCE/foundation', item);

  const rules = validateMarketRules(loadYaml(RULES_FILE), authorityOptions);
  if (rules.errors.length === 0) pass('MODULE/market-rules', 'RFC-001 5.8/5.10.1/5.13 typed contract');
  else for (const error of rules.errors) fail('MODULE/market-rules', error);
  for (const item of rules.evidence || []) {
    pass(`EVIDENCE/market-rules/${item}`, 'strict schema/JCS/digest replay and tamper controls passed');
  }
  for (const item of rules.pending) pend('EVIDENCE/market-rules', item);

  const positive = loadYaml(POSITIVE_FILE);
  const byId = new Map((positive.fixtures || []).map((fixture) => [fixture.id, fixture]));
  for (const fixture of positive.fixtures || []) {
    const violation = validateInstance(fixture.instance);
    if (fixture.expectedResult === 'accepted' && violation === null) {
      pass(`FIXTURE+/${fixture.id}`, 'accepted');
    } else {
      fail(`FIXTURE+/${fixture.id}`, `unexpected ${violation || 'acceptance'}`);
    }
  }

  const negative = loadYaml(NEGATIVE_FILE);
  for (const testCase of negative.cases || []) {
    const base = byId.get(testCase.baseFixtureId);
    if (!base) {
      fail(`FIXTURE-/${testCase.id}`, `unknown base fixture ${testCase.baseFixtureId}`);
      continue;
    }
    const violation = validateInstance(mutate(base.instance, testCase.mutation));
    if (violation === testCase.expectedViolation) {
      pass(`FIXTURE-/${testCase.id}`, `rejected with ${violation}`);
    } else {
      fail(
        `FIXTURE-/${testCase.id}`,
        `expected ${testCase.expectedViolation}, got ${violation || 'accepted'}`,
      );
    }
  }
} catch (error) {
  fail('UNCAUGHT', error.stack || error.message);
}

console.log(
  `\nfoundation + market-rules contract: ${passed} passed, ${failed} failed, ${pending} pending`,
);
if (failed > 0) process.exit(1);
if (pending > 0) process.exit(2);
process.exit(0);
