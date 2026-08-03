'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const { loadFixture } = require('./strict-fixture-loader.cjs');
const { validateScenario } = require('./market-data-v03-contracts.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_ROOT = path.join(ROOT, 'tests', 'm2', 'fixtures', 'market-data-v03');
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const MATRIX_ID = 'axiolune-market-data-date-decimal-rounding-pit-mutations-v1';

const MUTATION_CASES = Object.freeze([
  Object.freeze({
    category: 'date',
    expectedCodes: ['FACT_THREE_AXIS'],
    fixture: 'negative-invalid-calendar-date.yaml',
    id: 'date-invalid-calendar-day',
  }),
  Object.freeze({
    category: 'date',
    expectedCodes: ['OBSERVATION_ORDER_FIELDS'],
    fixture: 'negative-timezone-offset.yaml',
    id: 'date-non-utc-offset',
  }),
  Object.freeze({
    category: 'date',
    expectedCodes: ['OBSERVATION_ORDER_FIELDS'],
    fixture: 'negative-fractional-second-overprecision.yaml',
    id: 'date-over-nine-fractional-digits',
  }),
  Object.freeze({
    category: 'date',
    expectedCodes: ['OBSERVATION_ORDER_FIELDS'],
    fixture: 'negative-leap-second.yaml',
    id: 'date-unsupported-leap-second',
  }),
  Object.freeze({
    category: 'decimal',
    expectedCodes: ['MONEY_VALUE'],
    fixture: 'negative-money-number.yaml',
    id: 'decimal-money-binary64-number',
  }),
  Object.freeze({
    category: 'decimal',
    expectedCodes: ['MONEY_VALUE'],
    fixture: 'negative-money-boolean.yaml',
    id: 'decimal-money-boolean',
  }),
  Object.freeze({
    category: 'decimal',
    expectedCodes: ['MONEY_VALUE'],
    fixture: 'negative-decimal-exponent.yaml',
    id: 'decimal-money-exponent-lexical',
  }),
  Object.freeze({
    category: 'decimal',
    expectedCodes: ['MONEY_VALUE'],
    fixture: 'negative-decimal-leading-zero.yaml',
    id: 'decimal-money-leading-zero',
  }),
  Object.freeze({
    category: 'decimal',
    expectedCodes: ['MONEY_VALUE'],
    fixture: 'negative-decimal-negative-zero.yaml',
    id: 'decimal-money-negative-zero',
  }),
  Object.freeze({
    category: 'decimal',
    expectedCodes: ['QUANTITY_VALUE'],
    fixture: 'negative-quantity-number.yaml',
    id: 'decimal-quantity-binary64-number',
  }),
  Object.freeze({
    category: 'decimal',
    expectedCodes: ['QUANTITY_VALUE'],
    fixture: 'negative-quantity-boolean.yaml',
    id: 'decimal-quantity-boolean',
  }),
  Object.freeze({
    category: 'decimal',
    expectedCodes: ['QUANTITY_VALUE'],
    fixture: 'negative-quantity-exponent.yaml',
    id: 'decimal-quantity-exponent-lexical',
  }),
  Object.freeze({
    category: 'decimal',
    expectedCodes: ['OBSERVATION_ORDER_FIELDS'],
    fixture: 'negative-source-order-unsafe-integer.yaml',
    id: 'decimal-source-order-unsafe-integer',
  }),
  Object.freeze({
    category: 'decimal',
    expectedCodes: ['OBSERVATION_ORDER_FIELDS'],
    fixture: 'negative-source-order-fractional.yaml',
    id: 'decimal-source-order-fractional',
  }),
  Object.freeze({
    category: 'rounding',
    expectedCodes: ['QUANTITY_VALUE'],
    fixture: 'negative-quantity-rounding.yaml',
    id: 'rounding-unsupported-quantity-mode',
  }),
  Object.freeze({
    category: 'rounding',
    expectedCodes: ['FX_INVERSE_DERIVATION', 'FX_RECIPROCAL_POLICY'],
    fixture: 'negative-fx-reciprocal-rounding-mode.yaml',
    id: 'rounding-fx-mode-drift',
  }),
  Object.freeze({
    category: 'rounding',
    expectedCodes: ['FX_INVERSE_DERIVATION', 'FX_RECIPROCAL_POLICY'],
    fixture: 'negative-fx-reciprocal-extra-digit.yaml',
    id: 'rounding-fx-extra-digit',
  }),
  Object.freeze({
    category: 'rounding',
    expectedCodes: ['FX_INVERSE_DERIVATION', 'FX_RECIPROCAL_POLICY'],
    fixture: 'negative-fx-reciprocal-scale-drift.yaml',
    id: 'rounding-fx-scale-drift',
  }),
  Object.freeze({
    category: 'rounding',
    expectedCodes: ['CALCULATION_POLICY'],
    fixture: 'negative-calculation-invalid-policy.yaml',
    id: 'rounding-calculation-policy-drift',
  }),
  Object.freeze({
    category: 'rounding',
    expectedCodes: ['CALCULATION_OUTPUT'],
    fixture: 'negative-calculation-output-replay.yaml',
    id: 'rounding-calculation-output-replay',
  }),
  Object.freeze({
    category: 'rounding',
    expectedCodes: ['FX_INVERSE_DERIVATION'],
    fixture: 'negative-fx-inverse.yaml',
    id: 'rounding-fx-reciprocal-value-drift',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['PIT_FUTURE'],
    fixture: 'negative-future-availability.yaml',
    id: 'pit-future-availability',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['PIT_FUTURE'],
    fixture: 'negative-nanosecond-pit-future.yaml',
    id: 'pit-nanosecond-future-availability',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['PIT_OUTSIDE_INTERVAL'],
    fixture: 'negative-pit-interval-end.yaml',
    id: 'pit-half-open-end-exclusion',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['PIT_REFERENCE_TIME'],
    fixture: 'negative-reference-time.yaml',
    id: 'pit-reference-time-bound',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['CALCULATION_INPUT_FUTURE'],
    fixture: 'negative-calculation-future-input.yaml',
    id: 'pit-calculation-future-input',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['CALCULATION_CLOSURE_SET', 'CALCULATION_INPUT_SET'],
    fixture: 'negative-calculation-closure-set-drift.yaml',
    id: 'pit-calculation-closure-set-drift',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['CALCULATION_WINDOW'],
    fixture: 'negative-calculation-window-drift.yaml',
    id: 'pit-calculation-window-drift',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['FACT_MUTABLE_CLOSURE'],
    fixture: 'negative-mutable-closure.yaml',
    id: 'pit-inline-mutable-closure',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['REVISION_CLOSURE'],
    fixture: 'negative-revision-closure.yaml',
    id: 'pit-revision-closure-omission',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['FACT_DUPLICATE_VERSION_IRI'],
    fixture: 'negative-finding-duplicate-version-iri.yaml',
    id: 'pit-quality-finding-global-version-iri-uniqueness',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['PIT_OVERLAPPING_VERSIONS'],
    fixture: 'negative-finding-pit-overlap.yaml',
    id: 'pit-quality-finding-overlapping-logical-versions',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['OBSERVATION_LOGICAL_IDENTITY'],
    fixture: 'negative-observation-logical-key-drift.yaml',
    id: 'pit-source-collision-logical-key-bijection',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['CLOSURE_IDENTITY'],
    fixture: 'negative-closure-identity.yaml',
    id: 'pit-closure-canonical-identity',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['CLOSURE_EVIDENCE', 'CLOSURE_IDENTITY'],
    fixture: 'negative-closure-evidence-unresolved.yaml',
    id: 'pit-closure-evidence-resolution',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['CLOSURE_CAUSE_VERSION', 'REVISION_CLOSURE'],
    fixture: 'negative-closure-successor-axis-drift.yaml',
    id: 'pit-successor-closure-axis-boundary',
  }),
  Object.freeze({
    category: 'pit',
    expectedCodes: ['PIT_OVERLAPPING_VERSIONS', 'QUALITY_FINDING_REQUIRED_DUPLICATE'],
    fixture: 'negative-closed-duplicate-finding-suppression.yaml',
    id: 'pit-closed-finding-cannot-suppress-overlap',
  }),
]);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function relativeDigest(relativePath) {
  return {
    artifactDigest: sha256(fs.readFileSync(path.join(ROOT, ...relativePath.split('/')))),
    artifactRef: {
      kind: 'path',
      path: relativePath,
      root: 'sourceTree',
    },
  };
}

function buildMarketDataMutationEvidence() {
  const definitions = MUTATION_CASES.map((entry) => ({
    category: entry.category,
    expectedCodes: [...entry.expectedCodes],
    fixture: entry.fixture,
    id: entry.id,
  }));
  const cases = definitions.map((definition) => {
    const fixturePath = path.join(FIXTURE_ROOT, definition.fixture);
    const fixtureBytes = fs.readFileSync(fixturePath);
    let scenario;
    let observedCodes = [];
    let engineError = null;
    try {
      scenario = loadFixture(fixturePath, { rootDirectory: FIXTURE_ROOT });
      observedCodes = [...new Set(validateScenario(scenario).map((finding) => finding.code))]
        .sort(compareUtf8);
    } catch (cause) {
      engineError = cause.stack || cause.message;
    }
    const declaredCodes = Array.isArray(scenario?.expected?.codes)
      ? [...scenario.expected.codes]
      : [];
    const missingCodes = definition.expectedCodes
      .filter((code) => !observedCodes.includes(code));
    const declaredContractMatches = scenario?.expected?.valid === false
      && canonicalJcs(declaredCodes) === canonicalJcs(definition.expectedCodes);
    const passed = engineError === null
      && declaredContractMatches
      && missingCodes.length === 0;
    const result = {
      ...definition,
      declaredContractMatches,
      fixtureDigest: sha256(fixtureBytes),
      missingCodes,
      observedCodes,
      outcome: passed ? 'passed' : 'failed',
    };
    if (engineError !== null) result.engineError = engineError;
    return result;
  });
  const categories = Object.fromEntries(['date', 'decimal', 'rounding', 'pit'].map((category) => {
    const selected = cases.filter((entry) => entry.category === category);
    return [category, {
      caseCount: selected.length,
      failedCount: selected.filter((entry) => entry.outcome === 'failed').length,
      passedCount: selected.filter((entry) => entry.outcome === 'passed').length,
    }];
  }));
  const failedCount = cases.filter((entry) => entry.outcome === 'failed').length;
  const implementationClosure = [
    'scripts/domain/lib/decimal-lexical.cjs',
    'scripts/domain/lib/fact-closure-identity.cjs',
    'scripts/domain/lib/instant-lexical.cjs',
    'scripts/domain/lib/market-data-release-evidence.cjs',
    'scripts/domain/lib/market-data-v03-contracts.cjs',
    'scripts/domain/lib/strict-fixture-loader.cjs',
    'scripts/domain/lib/strict-source-locator.cjs',
    'scripts/domain/lib/market-data-mutation-matrix.cjs',
    'scripts/domain/test-market-data-mutation-matrix.cjs',
  ].sort(compareUtf8).map(relativeDigest);
  return {
    cases,
    implementationClosure,
    matrixDefinitionDigest: sha256(Buffer.from(canonicalJcs(definitions), 'utf8')),
    matrixId: MATRIX_ID,
    outcome: failedCount === 0 ? 'passed' : 'failed',
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
    summary: {
      caseCount: cases.length,
      categories,
      failedCount,
      passedCount: cases.length - failedCount,
    },
  };
}

module.exports = {
  MATRIX_ID,
  MUTATION_CASES,
  buildMarketDataMutationEvidence,
};
