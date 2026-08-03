'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const {
  latestCloseBefore,
  provenanceForObservation,
  selectCompleteQuotes,
  selectLogicalVersion,
  selectPrices,
  selectTrades,
  selectValidBars,
} = require('../lib/market-data-cq.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const scenario = yaml.load(fs.readFileSync(
  path.join(ROOT, 'tests', 'm2', 'fixtures', 'market-data-v03', 'positive-complete.yaml'),
  'utf8',
));
const noonPivot = {
  asOfValid: '2026-07-31T12:00:00Z',
  asOfKnowledge: '2026-07-31T12:00:00Z',
  asOfAvailable: '2026-07-31T12:00:00Z',
};
const listedQuery = {
  listingVersionIri: 'urn:listing:aapl:xnas:v1',
  instrumentVersionIri: 'urn:instrument:aapl:v1',
  facilityLogicalIri: 'urn:facility:xnas',
};
const jsonPointerExtractorProfileRef = {
  kind: 'path',
  root: 'sourceTree',
  path: 'scripts/domain/reference-extractors/json-pointer-jcs-v1.json',
};
const wholeFileExtractorProfileRef = {
  kind: 'path',
  root: 'sourceTree',
  path: 'tests/m2/fixtures/market-data-v03/evidence/whole-file-raw-v1.json',
};
const observationIdFieldLocator = {
  kind: 'jsonPointer',
  path: 'tests/m2/fixtures/market-data-v03/evidence/record-envelope-schema-v1.json',
  mediaType: 'application/json',
  extractorProfileRef: jsonPointerExtractorProfileRef,
  extractorProfileDigest: 'sha256:83b1c7bfe40503516274b2593bc92888b5677e1a017f9841222c0b25fcb848ef',
  selectionDigest: 'sha256:fa31eb09ea27b3e1577080dba5d0f6c3a9fdb964bacea7c100385d1b63bfe198',
  pointer: '/properties/id',
};
const sourceRevisionFieldLocator = {
  kind: 'jsonPointer',
  path: 'tests/m2/fixtures/market-data-v03/evidence/record-envelope-schema-v1.json',
  mediaType: 'application/json',
  extractorProfileRef: jsonPointerExtractorProfileRef,
  extractorProfileDigest: 'sha256:83b1c7bfe40503516274b2593bc92888b5677e1a017f9841222c0b25fcb848ef',
  selectionDigest: 'sha256:3d5e2c5dfd9d780d37aa20ce7f019c8c15d5f23f5713bdf01db0f70ba58e2709',
  pointer: '/properties/revisionToken',
};
const sourceArtifactRef = {
  kind: 'path',
  root: 'sourceTree',
  path: 'tests/m2/fixtures/market-data-v03/evidence/market-data-source-snapshot-v1.json',
};
const sourceLocator = {
  kind: 'wholeFile',
  path: 'tests/m2/fixtures/market-data-v03/evidence/market-data-source-snapshot-v1.json',
  mediaType: 'application/json',
  extractorProfileRef: wholeFileExtractorProfileRef,
  extractorProfileDigest: 'sha256:dd1f703e804ab47cf6f5c4e102a08f6bcabec865c3fb8fd8ba8447ae045e85d8',
  selectionDigest: 'sha256:23036264c421aceeddc5529178767c26a3b19bf80749403d14e258190e4a62e8',
};

assert.deepEqual(
  selectPrices(scenario, { ...listedQuery, priceKind: 'last', pivot: noonPivot })
    .map((row) => row.versionIri),
  ['urn:observation:price-001:v0'],
);
assert.deepEqual(
  selectPrices(scenario, {
    ...listedQuery,
    priceKind: 'last',
    pivot: { ...noonPivot, asOfAvailable: '2026-07-31T10:00:01Z' },
  }),
  [],
);

const nanosecondAvailability = structuredClone(scenario);
nanosecondAvailability.observations
  .find((row) => row.id === 'price-001-v0')
  .axes.availableFrom = '2026-07-31T10:00:02.000000001Z';
assert.deepEqual(
  selectPrices(nanosecondAvailability, {
    ...listedQuery,
    priceKind: 'last',
    pivot: { ...noonPivot, asOfAvailable: '2026-07-31T10:00:02Z' },
  }),
  [],
  'one nanosecond before availableFrom must remain ineligible',
);
assert.deepEqual(
  selectPrices(nanosecondAvailability, {
    ...listedQuery,
    priceKind: 'last',
    pivot: { ...noonPivot, asOfAvailable: '2026-07-31T10:00:02.000000001Z' },
  }).map((row) => row.versionIri),
  ['urn:observation:price-001:v0'],
  'availableFrom boundary is inclusive at exact nanosecond precision',
);
assert.throws(
  () => selectPrices(scenario, {
    ...listedQuery,
    priceKind: 'last',
    pivot: { ...noonPivot, asOfValid: '2026-02-29T00:00:00Z' },
  }),
  /calendar-valid canonical UTC instant/u,
);
assert.throws(
  () => selectPrices(scenario, {
    ...listedQuery,
    priceKind: 'last',
    pivot: { ...noonPivot, asOfValid: '2026-07-31T12:00:00+00:00' },
  }),
  /calendar-valid canonical UTC instant/u,
);

assert.deepEqual(
  selectTrades(scenario, {
    from: '2026-07-31T10:00:03Z',
    to: '2026-07-31T10:00:05Z',
    pivot: noonPivot,
  }),
  [
    {
      versionIri: 'urn:observation:trade-001:v0',
      observedAt: '2026-07-31T10:00:03Z',
      streamLogicalIri: 'urn:stream:trade:immutable',
      sourceOrderKey: 1,
      sourceTradeId: 'TRADE-001',
    },
    {
      versionIri: 'urn:observation:trade-002:v0',
      observedAt: '2026-07-31T10:00:04Z',
      streamLogicalIri: 'urn:stream:trade:immutable',
      sourceOrderKey: 2,
      sourceTradeId: 'TRADE-002',
    },
  ],
);
assert.deepEqual(
  selectTrades(scenario, {
    from: '2026-07-31T11:00:00Z',
    to: '2026-07-31T12:00:00Z',
    pivot: noonPivot,
  }),
  [],
);

assert.equal(
  selectLogicalVersion(scenario, 'urn:observation:corrected-close', {
    asOfValid: '2026-07-31T10:00:00Z',
    asOfKnowledge: '2026-07-31T10:00:00Z',
    asOfAvailable: '2026-07-31T10:00:00Z',
  }).versionIri,
  'urn:observation:corrected-close:v0',
);
assert.equal(
  selectLogicalVersion(scenario, 'urn:observation:corrected-close', {
    asOfValid: '2026-07-31T11:00:00Z',
    asOfKnowledge: '2026-07-31T11:00:00Z',
    asOfAvailable: '2026-07-31T11:00:00Z',
  }).versionIri,
  'urn:observation:corrected-close:v1',
);
assert.equal(
  selectLogicalVersion(scenario, 'urn:observation:corrected-close', {
    asOfValid: '2026-07-31T10:30:00Z',
    asOfKnowledge: '2026-07-31T10:30:00Z',
    asOfAvailable: '2026-07-31T10:30:01Z',
  }).versionIri,
  'urn:observation:corrected-close:v1',
  'knowledge closure is half-open at the successor boundary',
);

assert.deepEqual(
  selectCompleteQuotes(scenario, noonPivot).map((row) => row.versionIri),
  ['urn:observation:quote-001:v0'],
);
assert.deepEqual(
  selectValidBars(scenario, noonPivot).map((row) => row.versionIri),
  ['urn:observation:trade-bar-001:v0', 'urn:observation:quote-bar-001:v0'],
);

assert.deepEqual(
  provenanceForObservation(scenario, 'urn:observation:corrected-close:v1'),
  {
    observationVersionIri: 'urn:observation:corrected-close:v1',
    streamVersionIri: 'urn:stream:price:revisioned:v1',
    streamLogicalIri: 'urn:stream:price:revisioned',
    revisionMode: 'revisionedRecord',
    observationIdFieldLocator,
    sourceRevisionFieldLocator,
    providerObservationId: 'CORRECTED-CLOSE',
    sourceRevisionToken: 'r1',
    sourceRevisionOrder: 1,
    predecessorVersionIri: 'urn:observation:corrected-close:v0',
    predecessorClosedAt: '2026-07-31T10:30:00Z',
    sourceArtifactRef,
    sourceArtifactDigest: 'sha256:6ebf05e270a7eea658c0fe65ef454c5c9c91d88b242a0a988d7b0d94d31abb5d',
    sourceLocator,
  },
);

assert.equal(
  latestCloseBefore(scenario, {
    ...listedQuery,
    before: '2026-07-31T10:00:00Z',
    pivot: noonPivot,
  }).versionIri,
  'urn:observation:close-002:v0',
);
assert.equal(
  latestCloseBefore(scenario, {
    ...listedQuery,
    before: '2026-07-31T09:00:00Z',
    pivot: noonPivot,
  }),
  null,
);
assert.throws(
  () => selectPrices(scenario, {
    ...listedQuery,
    priceKind: 'last',
    pivot: {
      asOfValid: '2026-07-31T12:00:01Z',
      asOfKnowledge: '2026-07-31T12:00:00Z',
      asOfAvailable: '2026-07-31T12:00:00Z',
    },
  }),
  /exceeds referenceTime/u,
);

const missingOrder = structuredClone(scenario);
delete missingOrder.observations.find((row) => row.id === 'trade-001-v0').sourceOrderKey;
assert.throws(
  () => selectTrades(missingOrder, {
    from: '2026-07-31T10:00:03Z',
    to: '2026-07-31T10:00:05Z',
    pivot: noonPivot,
  }),
  /safe-integer sourceOrderKey/u,
);

const numericMoney = structuredClone(scenario);
numericMoney.observations.find((row) => row.id === 'price-001-v0').price.amount = 100.25;
assert.throws(
  () => selectPrices(numericMoney, { ...listedQuery, priceKind: 'last', pivot: noonPivot }),
  /explicit decimal lexical value/u,
);

const booleanQuantity = structuredClone(scenario);
booleanQuantity.observations.find((row) => row.id === 'quote-001-v0').bidSize.value = true;
assert.throws(
  () => selectCompleteQuotes(booleanQuantity, noonPivot),
  /explicit decimal lexical value/u,
);

const overlap = structuredClone(scenario);
const successor = overlap.observations.find((row) => row.id === 'corrected-close-v1');
successor.axes.knowledgeFrom = '2026-07-31T09:59:00Z';
successor.axes.availableFrom = '2026-07-31T09:59:00Z';
assert.throws(
  () => selectLogicalVersion(overlap, 'urn:observation:corrected-close', {
    asOfValid: '2026-07-31T10:00:00Z',
    asOfKnowledge: '2026-07-31T10:00:00Z',
    asOfAvailable: '2026-07-31T10:00:00Z',
  }),
  /2 PIT-eligible versions/u,
);

const inlineClosure = structuredClone(scenario);
inlineClosure.observations.find((row) => row.id === 'price-001-v0').axes.knowledgeTo =
  '2026-07-31T11:00:00Z';
assert.throws(
  () => selectPrices(inlineClosure, { ...listedQuery, priceKind: 'last', pivot: noonPivot }),
  /forbids inline knowledgeTo\/availableTo/u,
);

console.log('market-data-cq: PASS (query, nanosecond/calendar, PIT, ordering, decimal, and provenance branches)');
