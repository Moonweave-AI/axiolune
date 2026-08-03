'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  S5CanonicalMaterializationError,
  TRANSFORMATION_REFS,
  executeCanonicalTransformation,
} = require('../lib/s5-canonical-materialization.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_SOURCE = 'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source';

function bytes(relativePath) {
  return fs.readFileSync(path.join(ROOT, ...relativePath.split('/')));
}

function policyArtifacts() {
  return {
    precisionBytes: bytes(`${FIXTURE_SOURCE}/valuation-precision-policy.json`),
    roundingBytes: bytes(`${FIXTURE_SOURCE}/valuation-rounding-policy.json`),
  };
}

test('executes every canonical S5 transformation through locked value semantics', () => {
  assert.deepEqual(
    executeCanonicalTransformation(TRANSFORMATION_REFS.moneyValue, {
      amount: '42.50',
      currency: 'USD',
      scale: 2,
    }),
    { amount: '42.50', currency: 'USD', scale: 2 },
  );
  assert.deepEqual(
    executeCanonicalTransformation(TRANSFORMATION_REFS.quantityValue, {
      precision: 0,
      rounding: 'half-even',
      unit: 'urn:unit:share',
      value: '10',
    }),
    { precision: 0, rounding: 'half-even', unit: 'urn:unit:share', value: '10' },
  );
  assert.deepEqual(
    executeCanonicalTransformation(
      TRANSFORMATION_REFS.directUnitPriceTimesQuantity,
      {
        precisionPolicyDigest:
          'sha256:6163703b743abe2deed93e9408ea8095dba178f110a85c91208712ce39334e61',
        precisionPolicyRef:
          'urn:axiolune:evidence:slice-a:valuation-precision-policy:v1',
        price: '42.50',
        priceScale: 2,
        quantity: '10',
        quantityPrecision: 0,
        quantityRounding: 'half-even',
        reportingCurrency:
          'https://axiolune.ai/data/finance/foundation/currency/USD',
        roundingPolicyDigest:
          'sha256:100789f6a3d305c866fa81e507ae76d72de6d9216bc4cd1193448c40a535b1bb',
        roundingPolicyRef:
          'urn:axiolune:evidence:slice-a:valuation-rounding-policy:v1',
      },
      { valuationPolicyArtifacts: policyArtifacts() },
    ),
    { amount: '425.00', currency: 'USD', scale: 2 },
  );
});

test('rejects semantically invalid vectors that still satisfy primitive JSON types', () => {
  for (const input of [
    { amount: '042.50', currency: 'USD', scale: 2 },
    { amount: '42.50', currency: 'usd', scale: 2 },
    { amount: '42.50', currency: 'USD', scale: 3 },
  ]) {
    assert.throws(
      () => executeCanonicalTransformation(TRANSFORMATION_REFS.moneyValue, input),
      S5CanonicalMaterializationError,
    );
  }
  assert.throws(
    () => executeCanonicalTransformation(TRANSFORMATION_REFS.quantityValue, {
      precision: -1,
      rounding: 'half-even',
      unit: 'urn:unit:share',
      value: '10',
    }),
    S5CanonicalMaterializationError,
  );
});

test('rejects unknown transformations, open inputs, and substituted policy bytes', () => {
  assert.throws(
    () => executeCanonicalTransformation('urn:axiolune:transformation:unknown', {}),
    S5CanonicalMaterializationError,
  );
  assert.throws(
    () => executeCanonicalTransformation(TRANSFORMATION_REFS.moneyValue, {
      amount: '42.50',
      currency: 'USD',
      extra: true,
      scale: 2,
    }),
    S5CanonicalMaterializationError,
  );
  const input = {
    precisionPolicyDigest:
      'sha256:6163703b743abe2deed93e9408ea8095dba178f110a85c91208712ce39334e61',
    precisionPolicyRef: 'urn:axiolune:evidence:slice-a:valuation-precision-policy:v1',
    price: '42.50',
    priceScale: 2,
    quantity: '10',
    quantityPrecision: 0,
    quantityRounding: 'half-even',
    reportingCurrency: 'https://axiolune.ai/data/finance/foundation/currency/USD',
    roundingPolicyDigest:
      'sha256:100789f6a3d305c866fa81e507ae76d72de6d9216bc4cd1193448c40a535b1bb',
    roundingPolicyRef: 'urn:axiolune:evidence:slice-a:valuation-rounding-policy:v1',
  };
  const substituted = policyArtifacts();
  substituted.roundingBytes = Buffer.from('{}', 'utf8');
  assert.throws(
    () => executeCanonicalTransformation(
      TRANSFORMATION_REFS.directUnitPriceTimesQuantity,
      input,
      { valuationPolicyArtifacts: substituted },
    ),
    S5CanonicalMaterializationError,
  );
});
