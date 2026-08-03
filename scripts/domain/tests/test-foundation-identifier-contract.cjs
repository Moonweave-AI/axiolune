#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const {
  IDENTIFIER_PROFILES,
  ISIN_DEFINITION,
  ISIN_ISSUING_AUTHORITY,
  LEI_DEFINITION,
  LEI_ISSUING_AUTHORITY,
  LEI_STANDARD,
  MIC_DEFINITION,
  MIC_ISSUING_AUTHORITY,
  validateFoundationIdentifierContract,
} = require('../lib/foundation-identifier-contract.cjs');
const {
  validateIsin,
} = require('../lib/foundation-market-instrument-cq.cjs');
const {
  normalizeElement,
} = require('../migrate-to-v0.3-typed.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FOUNDATION = path.join(ROOT, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml');
const MIGRATION = path.join(ROOT, 'scripts', 'domain', 'migrate-to-v0.3-typed.cjs');
const LOCK_GENERATOR = path.join(ROOT, 'scripts', 'domain', 'update-references-lock.cjs');

function canonicalDocument() {
  return yaml.load(fs.readFileSync(FOUNDATION, 'utf8'));
}

function findingCodes(document) {
  return validateFoundationIdentifierContract(document).map((finding) => finding.code);
}

test('canonical Foundation identifier definitions and issuing authorities are exact', () => {
  const document = canonicalDocument();
  assert.deepEqual(validateFoundationIdentifierContract(document), []);
  assert.equal(document.domain.identifierTypes.ISIN.definition, ISIN_DEFINITION);
  assert.equal(document.domain.identifierTypes.LEI.definition, LEI_DEFINITION);
  assert.equal(document.domain.identifierTypes.MIC.definition, MIC_DEFINITION);
  assert.equal(IDENTIFIER_PROFILES.ISIN.authority, ISIN_ISSUING_AUTHORITY);
  assert.equal(IDENTIFIER_PROFILES.LEI.standard, LEI_STANDARD);
  assert.equal(IDENTIFIER_PROFILES.LEI.authority, LEI_ISSUING_AUTHORITY);
  assert.equal(IDENTIFIER_PROFILES.MIC.authority, MIC_ISSUING_AUTHORITY);
});

test('all four identifier validators have one exact Mandatory ConstraintBinding', () => {
  const document = canonicalDocument();
  for (const identifierName of ['ISIN', 'LEI', 'MIC', 'LocalIdentifier']) {
    const identifier = document.domain.identifierTypes[identifierName];
    const matches = document.domain.constraintBindings.filter((binding) => (
      binding.constraintRef === identifier.validatorRef
    ));
    assert.deepEqual(matches, [{
      constraintRef: identifier.validatorRef,
      targetElement: identifier.iri,
      enforcementLevel: 'Mandatory',
    }]);
  }
});

test('missing, mis-targeted, or non-Mandatory identifier bindings fail closed', () => {
  for (const mutation of [
    (document, validatorRef) => {
      document.domain.constraintBindings = document.domain.constraintBindings.filter((binding) => (
        binding.constraintRef !== validatorRef
      ));
    },
    (document, validatorRef) => {
      document.domain.constraintBindings.find((binding) => (
        binding.constraintRef === validatorRef
      )).targetElement = document.domain.identifierTypes.LEI.iri;
    },
    (document, validatorRef) => {
      document.domain.constraintBindings.find((binding) => (
        binding.constraintRef === validatorRef
      )).enforcementLevel = 'Advisory';
    },
  ]) {
    const document = canonicalDocument();
    mutation(document, document.domain.identifierTypes.ISIN.validatorRef);
    assert.ok(findingCodes(document).includes('FOUNDATION_IDENTIFIER_VALIDATOR_BINDING_MISSING'));
  }
});

test('legacy LEI standard is rejected', () => {
  const document = canonicalDocument();
  document.domain.identifierTypes.LEI.standard = ['ISO 17442', '2020'].join(':');
  assert.ok(findingCodes(document).includes('FOUNDATION_LEI_STANDARD_MISMATCH'));
});

test('GLEIF itself cannot be recorded as the LEI issuing authority', () => {
  const document = canonicalDocument();
  document.domain.identifierTypes.LEI.issuingAuthority = [
    'Global Legal Entity Identifier',
    'Foundation',
  ].join(' ');
  assert.ok(findingCodes(document).includes('FOUNDATION_LEI_ISSUER_MISMATCH'));
});

test('LEI definition preserves the 4 + 14 + 2 structure', () => {
  const document = canonicalDocument();
  document.domain.identifierTypes.LEI.definition = document.domain.identifierTypes.LEI.definition
    .replace('14-character entity-specific section', '12-character entity-specific identifier');
  assert.ok(findingCodes(document).includes('FOUNDATION_LEI_DEFINITION_INCOMPLETE'));
});

test('ISIN and MIC issuing-authority scope cannot drift back to generic labels', () => {
  const isinDocument = canonicalDocument();
  isinDocument.domain.identifierTypes.ISIN.issuingAuthority = 'ANNA';
  assert.ok(findingCodes(isinDocument).includes('FOUNDATION_ISIN_ISSUER_MISMATCH'));

  const micDocument = canonicalDocument();
  micDocument.domain.identifierTypes.MIC.issuingAuthority = 'ISO 10383 Registration Authority';
  assert.ok(findingCodes(micDocument).includes('FOUNDATION_MIC_ISSUER_MISMATCH'));
});

test('MIC definition rejects the legacy concatenated 4+4 lexical model', () => {
  const document = canonicalDocument();
  document.domain.identifierTypes.MIC.definition = [
    'market code comprising a 4-character operating-level code',
    'or a 4 + 4 character segment-level code',
  ].join(' ');
  const codes = findingCodes(document);
  assert.ok(codes.includes('FOUNDATION_MIC_DEFINITION_INCOMPLETE'));
  assert.ok(codes.includes('FOUNDATION_MIC_EIGHT_CHARACTER_CONCATENATION'));
});

test('ISIN definition uses prefix/basic-number terminology and rejects country-only narrowing', () => {
  const document = canonicalDocument();
  document.domain.identifierTypes.ISIN.definition = [
    '12-character code consisting of a 2-character ISO 3166-1 country',
    'code,',
    'a 9-character national securities identifying number, and a Luhn check digit',
  ].join(' ');
  const codes = findingCodes(document);
  assert.ok(codes.includes('FOUNDATION_ISIN_COUNTRY_ONLY_PREFIX'));
  assert.ok(codes.includes('FOUNDATION_ISIN_DEFINITION_INCOMPLETE'));
});

test('XA/XB/XC/XD Registration Authority substitute-prefix ISINs remain lexically valid', () => {
  for (const isin of [
    'XA0000000009',
    'XB0000000008',
    'XC0000000007',
    'XD0000000006',
  ]) {
    assert.doesNotThrow(() => validateIsin(isin, 'substitute-prefix fixture'));
  }
  assert.throws(
    () => validateIsin('XA0000000000', 'bad-check-digit fixture'),
    /invalid ISIN check digit/u,
  );
});

test('migration and reference-lock generators consume the shared LEI contract', () => {
  const migrationSource = fs.readFileSync(MIGRATION, 'utf8');
  const lockGeneratorSource = fs.readFileSync(LOCK_GENERATOR, 'utf8');
  assert.match(migrationSource, /IDENTIFIER_PROFILES/);
  assert.match(lockGeneratorSource, /LEI_STANDARD/);
  const legacyLeiStandard = new RegExp(['ISO 17442', '2020'].join(':'));
  const legacyLeiIssuer = new RegExp([
    'Global Legal Entity Identifier',
    'Foundation',
  ].join(' '));
  for (const source of [migrationSource, lockGeneratorSource]) {
    assert.doesNotMatch(source, legacyLeiStandard);
    assert.doesNotMatch(source, legacyLeiIssuer);
  }
});

test('legacy-to-v0.3 migration emits the exact LEI standard and issuer', () => {
  const generatedConstraints = {};
  const migrated = normalizeElement(
    'identifierTypes',
    {
      iri: 'https://axiolune.ai/ontology/finance/foundation/LEI',
      namespace: 'fin-foundation',
      localName: 'LEI',
      label: 'Legal Entity Identifier',
      definition: 'legacy LEI fixture',
      pattern: '^[0-9A-Z]{18}[0-9]{2}$',
      length: 20,
      checkAlgorithm: 'ISO7064-Mod97-10',
    },
    'foundation',
    new Map(),
    generatedConstraints,
  );
  assert.equal(migrated.standard, LEI_STANDARD);
  assert.equal(migrated.issuingAuthority, LEI_ISSUING_AUTHORITY);
  assert.equal(migrated.definition, LEI_DEFINITION);
  assert.equal(migrated.validatorRef, 'https://axiolune.ai/ontology/finance/foundation/LEIValidation');
  assert.ok(generatedConstraints.LEIValidation);
});

test('legacy-to-v0.3 migration cannot restore a country-only ISIN definition', () => {
  const legacyCountryOnlyDefinition = [
    '12-character code consisting of a 2-character ISO 3166-1 country',
    'code, a 9-character NSIN, and a check digit',
  ].join(' ');
  const migrated = normalizeElement(
    'identifierTypes',
    {
      iri: 'https://axiolune.ai/ontology/finance/foundation/ISIN',
      namespace: 'fin-foundation',
      localName: 'ISIN',
      label: 'International Securities Identification Number',
      definition: legacyCountryOnlyDefinition,
      pattern: '^[A-Z]{2}[A-Z0-9]{9}[0-9]$',
      length: 12,
      checkAlgorithm: 'Luhn',
    },
    'foundation',
    new Map(),
    {},
  );
  assert.equal(migrated.definition, ISIN_DEFINITION);
  assert.equal(migrated.issuingAuthority, ISIN_ISSUING_AUTHORITY);
  assert.notEqual(migrated.definition, legacyCountryOnlyDefinition);
});

test('legacy-to-v0.3 migration emits the exact MIC semantics and Registration Authority', () => {
  const migrated = normalizeElement(
    'identifierTypes',
    {
      iri: 'https://axiolune.ai/ontology/finance/foundation/MIC',
      namespace: 'fin-foundation',
      localName: 'MIC',
      label: 'Market Identifier Code',
      definition: 'legacy 4 + 4 MIC fixture',
      pattern: '^[A-Z0-9]{4}$',
      length: 4,
    },
    'foundation',
    new Map(),
    {},
  );
  assert.equal(migrated.definition, MIC_DEFINITION);
  assert.equal(migrated.issuingAuthority, MIC_ISSUING_AUTHORITY);
});
