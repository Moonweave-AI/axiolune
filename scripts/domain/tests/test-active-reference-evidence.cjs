#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const {
  collectActiveReferenceEvidence,
} = require('../lib/active-reference-evidence.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('active evidence is exact-locator driven and excludes retired implementation mappings', () => {
  const lock = YAML.parse(fs.readFileSync(path.join(
    ROOT,
    'docs/ontology/references/references.lock.yaml',
  ), 'utf8'));
  const active = collectActiveReferenceEvidence(ROOT, lock);
  const references = new Map(lock.references.map((reference) => [reference.id, reference]));

  for (const record of active.locators) {
    const reference = references.get(record.referenceId);
    assert.ok(reference, `${record.referenceId}: active locator must join one lock reference`);
    assert.equal(
      reference.locators.filter(
        (locator) => canonicalJcs(locator) === canonicalJcs(record.locator),
      ).length,
      1,
      `${record.referenceId}: active locator must equal exactly one locked locator`,
    );
  }

  for (const retiredRoot of [
    'reference/ontology-design-reference/FinRegOnt/',
    'reference/project-reference/Lean/',
    'reference/project-reference/qlib/',
    'reference/project-reference/rqalpha/',
    'reference/project-reference/vnpy/',
  ]) {
    assert.ok(
      ![...active.usedPaths].some((repoPath) => repoPath.startsWith(retiredRoot)),
      `${retiredRoot} must not be promoted without a current downstream locator`,
    );
  }

  const fibo = references.get('fibo-local-evidence');
  const activeFiboLocators = active.locators
    .filter((record) => record.referenceId === fibo.id)
    .map((record) => canonicalJcs(record.locator));
  assert.equal(
    new Set(activeFiboLocators).size,
    fibo.locators.length,
    'the generated FIBO lock must contain exactly the active locator union',
  );
  for (const locator of fibo.locators) {
    assert.ok(
      activeFiboLocators.includes(canonicalJcs(locator)),
      `${locator.path}: locked FIBO locator must have an active downstream consumer`,
    );
  }
  for (const expected of [
    'https://spec.edmcouncil.org/fibo/ontology/FBC/ProductsAndServices/ClientsAndAccounts/Account',
    'https://spec.edmcouncil.org/fibo/ontology/FND/Relations/Relations/hasLegalName',
    'https://spec.edmcouncil.org/fibo/ontology/CAE/CorporateEvents/SecurityRelatedCorporateActions/RightsExerciseEvent',
    'https://spec.edmcouncil.org/fibo/ontology/FBC/FunctionalEntities/Markets/MarketLevelClassifier-OPRT',
    'https://spec.edmcouncil.org/fibo/ontology/FBC/FunctionalEntities/Markets/MarketLevelClassifier-SGMT',
  ]) {
    assert.ok(fibo.locators.some((locator) => locator.resourceIri === expected), expected);
  }
  for (const expected of [
    ['FBC/FinancialInstruments/FinancialInstruments.rdf', 268, 315],
    ['FBC/FinancialInstruments/FinancialInstruments.rdf', 465, 481],
    ['FND/OwnershipAndControl/Ownership.rdf', 280, 302],
  ]) {
    assert.ok(fibo.locators.some((locator) => (
      locator.kind === 'textLineRange'
        && locator.path === expected[0]
        && locator.startLine === expected[1]
        && locator.endLine === expected[2]
    )), expected.join(':'));
  }
  const instrumentPricingPath = 'reference/ontology-design-reference/fibo/FBC/FinancialInstruments/InstrumentPricing.rdf';
  assert.ok(
    (active.byPath.get(instrumentPricingPath) || []).some((record) => (
      record.sourceRef.includes('reviewed-no-alignment-decisions-v1.json')
        && record.usage === 'implementation'
    )),
    'the SecurityPrice rejection must remain exact implementation evidence, not a completed alignment',
  );
});
