'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const {
  CanonicalRiskRecordError,
  TYPES,
  canonicalRiskInputContract,
  decodeCanonicalRiskScenario,
} = require('../lib/risk-canonical-record-adapter.cjs');
const {
  validateScenario,
} = require('../lib/risk-v03-contract.cjs');
const {
  canonicalJcs,
} = require('../lib/strict-source-locator.cjs');
const {
  collectPlaceholderFindings,
  validateNegativeDocument,
} = require('../sync-risk-source-fixtures.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'risk-v03.yaml');
const NEGATIVE_FIXTURE = path.join(
  ROOT,
  'tests',
  'm2',
  'fixtures',
  'negative',
  'risk-v03.yaml',
);
const INPUT_CONTRACT = path.join(
  ROOT,
  'scripts',
  'domain',
  'risk-custom-profile',
  'v0.3.0',
  'input-contract.json',
);
const document = YAML.parse(fs.readFileSync(FIXTURE, 'utf8'));

test('Risk raw authoring fixtures are placeholder-free closed canonical ontology records', () => {
  const privateFields = new Set([
    'account',
    'bucketSet',
    'currency',
    'definitionVersionIri',
    'limitVersionIri',
    'measurementVersionIri',
    'money',
    'ownerRef',
    'quantity',
    'representation',
    'scopes',
  ]);
  assert.deepEqual(collectPlaceholderFindings(document), []);
  assert.equal(Object.hasOwn(document, 'templates'), false);
  assert.doesNotThrow(() => validateNegativeDocument(
    YAML.parse(fs.readFileSync(NEGATIVE_FIXTURE, 'utf8')),
  ));
  for (const fixture of document.fixtures) {
    const instance = fixture.instance;
    assert.equal(instance.schemaVersion, '1.0', fixture.id);
    assert(Array.isArray(instance.records), fixture.id);
    for (const record of instance.records) {
      assert.match(record.typeIri, /^https:\/\/axiolune\.ai\/ontology\/finance\/risk\//u);
      assert.equal(
        Object.keys(record).some((field) => privateFields.has(field)),
        false,
        `${fixture.id}/${record.typeIri}`,
      );
    }
    assert.doesNotThrow(() => decodeCanonicalRiskScenario(instance), fixture.id);
    assert.doesNotThrow(() => validateScenario(instance), fixture.id);
  }
});

test('Risk canonical adapter rejects private and wrong ontology slots before evaluation', () => {
  assert.throws(
    () => validateScenario({
      definition: {},
      evaluation: {},
      limit: {},
      measurement: {},
    }),
    (error) => error instanceof CanonicalRiskRecordError
      && error.code === 'risk-canonical-required-field',
  );

  const seed = structuredClone(document.fixtures[0].instance);
  const measurement = seed.records.find((record) => record.typeIri === TYPES.measurement);
  measurement.scopes = [{ kind: 'portfolio', ref: measurement.measurementPortfolio }];
  assert.throws(
    () => decodeCanonicalRiskScenario(seed),
    (error) => error instanceof CanonicalRiskRecordError
      && error.code === 'risk-canonical-unknown-field',
  );

  const wrongSlot = structuredClone(document.fixtures[0].instance);
  const wrongMeasurement = wrongSlot.records.find((record) => record.typeIri === TYPES.measurement);
  wrongMeasurement.money = wrongMeasurement.measuredMoney;
  delete wrongMeasurement.measuredMoney;
  assert.throws(
    () => decodeCanonicalRiskScenario(wrongSlot),
    (error) => error.code === 'risk-canonical-unknown-field',
  );
});

test('Risk canonical adapter fails closed on missing required pattern fields and duplicate versions', () => {
  const missing = structuredClone(document.fixtures[0].instance);
  delete missing.records.find((record) => record.typeIri === TYPES.measurement).source;
  assert.throws(
    () => decodeCanonicalRiskScenario(missing),
    (error) => error.code === 'risk-canonical-required-field',
  );

  const duplicate = structuredClone(document.fixtures[2].instance);
  const values = duplicate.records.filter((record) => record.typeIri === TYPES.bucketValue);
  values[1].versionIri = values[0].versionIri;
  assert.throws(
    () => decodeCanonicalRiskScenario(duplicate),
    (error) => error.code === 'risk-canonical-duplicate-version',
  );
});

test('Risk canonical adapter closes every auxiliary evidence/context/closure record', () => {
  const unknownContextField = structuredClone(document.fixtures[0].instance);
  unknownContextField.inputContextRecords[0].privateRuntimeState = 'accepted';
  assert.throws(
    () => decodeCanonicalRiskScenario(unknownContextField),
    (error) => error.code === 'risk-canonical-unknown-field',
  );

  const missingEvidenceDigest = structuredClone(document.fixtures[0].instance);
  delete missingEvidenceDigest.evidenceRecords[0].artifactDigest;
  assert.throws(
    () => decodeCanonicalRiskScenario(missingEvidenceDigest),
    (error) => error.code === 'risk-canonical-required-field',
  );

  const closureFixture = document.fixtures.find(
    (fixture) => fixture.instance.temporalClosureRecords.length > 0,
  );
  assert(closureFixture);
  const shadowClosureField = structuredClone(closureFixture.instance);
  assert(shadowClosureField.temporalClosureRecords.length > 0);
  shadowClosureField.temporalClosureRecords[0].knowledgeTo = '2026-08-01T00:00:00Z';
  assert.throws(
    () => decodeCanonicalRiskScenario(shadowClosureField),
    (error) => error.code === 'risk-canonical-unknown-field',
  );
});

test('Risk input contract is the exact generated closed-record contract', () => {
  assert.equal(
    fs.readFileSync(INPUT_CONTRACT, 'utf8'),
    canonicalJcs(canonicalRiskInputContract()),
  );
});
