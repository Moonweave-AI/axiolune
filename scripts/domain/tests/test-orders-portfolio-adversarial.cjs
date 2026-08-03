'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const {validateFixture} = require('../test-orders-portfolio-v03-contracts.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function fixture(file, id) {
  const document = yaml.load(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  return structuredClone(document.fixtures.find((candidate) => candidate.id === id));
}

test('JCS duplicate evidence rejects non-I-JSON unpaired surrogates', () => {
  const candidate = fixture(
    'tests/m2/fixtures/positive/orders-execution-v03.yaml',
    'OE-POS-001-required-classified',
  );
  candidate.instance.sourceRecord.note = '\ud800';
  assert.throws(
    () => validateFixture(candidate),
    /unpaired high surrogate and is not valid I-JSON/,
  );
});

test('typed decimal slots reject exponent lexical shortcuts', () => {
  const candidate = fixture(
    'tests/m2/fixtures/positive/orders-execution-v03.yaml',
    'OE-POS-006-listed-execution',
  );
  candidate.instance.quantity.value = '1e1';
  assert.throws(
    () => validateFixture(candidate),
    /quantity\.value must be a finite decimal lexical value/,
  );
});

test('temporal contract rejects implicit offset normalization in fixtures', () => {
  const candidate = fixture(
    'tests/m2/fixtures/positive/orders-execution-v03.yaml',
    'OE-POS-009-reviewed-status-mapping',
  );
  candidate.instance.validFrom = '2026-01-01T08:00:00+08:00';
  assert.throws(
    () => validateFixture(candidate),
    /must be an explicit UTC dateTimeStamp/,
  );
});

test('member-account closure rejects duplicate logical IRIs', () => {
  const candidate = fixture(
    'tests/m2/fixtures/positive/portfolio-positions-v03.yaml',
    'PP-POS-003-same-currency-valuation',
  );
  candidate.instance.header.memberAccounts.push(candidate.instance.header.memberAccounts[0]);
  assert.throws(
    () => validateFixture(candidate),
    /member-account closure must be a unique logical-IRI set/,
  );
});

test('allocation closure rejects a count that disagrees with the exact set', () => {
  const candidate = fixture(
    'tests/m2/fixtures/positive/portfolio-positions-v03.yaml',
    'PP-POS-005-allocation-fee-basis-closure',
  );
  candidate.instance.closure.allocationCount += 1;
  assert.throws(
    () => validateFixture(candidate),
    /allocation exact-version set count does not match the exact set/,
  );
});

test('allocation closure rejects a non-RFC-5.8 exact-set digest', () => {
  const candidate = fixture(
    'tests/m2/fixtures/positive/portfolio-positions-v03.yaml',
    'PP-POS-005-allocation-fee-basis-closure',
  );
  candidate.instance.closure.allocationVersionSetDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () => validateFixture(candidate),
    /allocation exact-version set digest does not match RFC section 5\.8/,
  );
});

test('cross-currency opening gross requires an exact conversion version', () => {
  const candidate = fixture(
    'tests/m2/fixtures/positive/portfolio-positions-v03.yaml',
    'PP-POS-011-cross-currency-opening-gross-and-fee',
  );
  delete candidate.instance.lots[0].openingGrossFxConversion.versionIri;
  assert.throws(
    () => validateFixture(candidate),
    /opening gross\.fxConversion\.versionIri must be an exact version IRI/,
  );
});

test('lot-state closure rejects an allocation-set digest mismatch', () => {
  const candidate = fixture(
    'tests/m2/fixtures/positive/portfolio-positions-v03.yaml',
    'PP-POS-006-partial-consumption-and-pnl',
  );
  candidate.instance.closure.stateAllocationVersionSetDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () => validateFixture(candidate),
    /state-allocation exact-version set digest does not match RFC section 5\.8/,
  );
});

test('PnL cannot substitute independent lot-state closure digests', () => {
  const candidate = fixture(
    'tests/m2/fixtures/positive/portfolio-positions-v03.yaml',
    'PP-POS-006-partial-consumption-and-pnl',
  );
  candidate.instance.pnl.openLotVersionSetDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () => validateFixture(candidate),
    /PnL does not reuse the exact lot-state closure digests/,
  );
});

test('order finding rejects an affected-key digest not bound to its JCS subject', () => {
  const candidate = fixture(
    'tests/m2/fixtures/positive/orders-execution-v03.yaml',
    'OE-POS-005-explicit-sequence-gap',
  );
  candidate.instance.findings[0].affectedKeyDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () => validateFixture(candidate),
    /affectedKeyDigest does not match its strict JCS subject/,
  );
});

test('order finding rejects a related-version set digest mismatch', () => {
  const candidate = fixture(
    'tests/m2/fixtures/positive/orders-execution-v03.yaml',
    'OE-POS-010-duplicate-out-of-order-late-fill-findings',
  );
  candidate.instance.findings[2].relatedVersionSetDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () => validateFixture(candidate),
    /order finding related-version set digest does not match RFC section 5\.8/,
  );
});

test('order finding rejects the legacy flattened subject representation', () => {
  const candidate = fixture(
    'tests/m2/fixtures/positive/orders-execution-v03.yaml',
    'OE-POS-005-explicit-sequence-gap',
  );
  candidate.instance.findings[0].subject = '2-3';
  assert.throws(
    () => validateFixture(candidate),
    /legacy flattened order finding subject is forbidden/,
  );
});

function orderLineageCandidate() {
  return fixture(
    'tests/m2/fixtures/positive/orders-execution-v03.yaml',
    'OE-POS-020-immutable-split-and-aggregation-lineage',
  );
}

test('order-intent lineage rejects a directed split/aggregation cycle', () => {
  const candidate = orderLineageCandidate();
  candidate.instance.lineages.push({
    versionIri: 'https://axiolune.ai/orders/lineages/aggregate-bc-a/version/v1',
    kind: 'aggregation',
    sourceIntentVersionIris: [
      'https://axiolune.ai/orders/intents/lineage-b/version/v1',
      'https://axiolune.ai/orders/intents/lineage-c/version/v1',
    ],
    sourceIntentCount: 2,
    sourceIntentVersionSetDigest: 'sha256:948a17873ba073ca3f73edf4e8ae7d363917f91c9afa97b5d2ba855f6dcaf439',
    resultIntentVersionIris: ['https://axiolune.ai/orders/intents/lineage-a/version/v1'],
    resultIntentCount: 1,
    resultIntentVersionSetDigest: 'sha256:938d7707de78dc377f56e33ac73adc3d6ad1feff25a694bcdcf9dbfbf87e0152',
    orderLineageKeyDigest: 'sha256:dc243ce287c109d00cec3f93c27611c6138cf4579d3cca5164617c9cd62919e2',
    validFrom: '2026-01-01T00:00:03Z',
    knowledgeFrom: '2026-01-01T00:00:10Z',
    availableFrom: '2026-01-01T00:00:10Z',
    sourceArtifactRef: 'https://evidence.axiolune.ai/orders/router/adversarial-cycle',
    sourceArtifactDigest: `sha256:${'9'.repeat(64)}`,
    sourceLocator: '$.routingTransformations[2]',
  });
  assert.throws(() => validateFixture(candidate), /directed cycle/);
});

test('order-intent lineage rejects orphan and wrong-type exact-version endpoints', () => {
  const orphan = orderLineageCandidate();
  orphan.instance.intents = orphan.instance.intents.filter(
    (intent) => !intent.versionIri.includes('/lineage-c/'),
  );
  assert.throws(() => validateFixture(orphan), /endpoint is orphaned/);

  const wrongType = orderLineageCandidate();
  wrongType.instance.intents.find((intent) => intent.versionIri.includes('/lineage-c/')).type = 'ExternalOrder';
  assert.throws(() => validateFixture(wrongType), /endpoint has the wrong type/);
});

test('order-intent lineage rejects duplicate transformations and directed edges', () => {
  const candidate = orderLineageCandidate();
  const duplicate = structuredClone(candidate.instance.lineages[0]);
  duplicate.versionIri = 'https://axiolune.ai/orders/lineages/split-a-bc/version/v2';
  candidate.instance.lineages.push(duplicate);
  assert.throws(() => validateFixture(candidate), /duplicate transformation key/);

  const repeatedEdge = orderLineageCandidate();
  repeatedEdge.instance.lineages.push({
    versionIri: 'https://axiolune.ai/orders/lineages/split-a-be/version/v1',
    kind: 'split',
    sourceIntentVersionIris: ['https://axiolune.ai/orders/intents/lineage-a/version/v1'],
    sourceIntentCount: 1,
    sourceIntentVersionSetDigest: 'sha256:938d7707de78dc377f56e33ac73adc3d6ad1feff25a694bcdcf9dbfbf87e0152',
    resultIntentVersionIris: [
      'https://axiolune.ai/orders/intents/lineage-b/version/v1',
      'https://axiolune.ai/orders/intents/lineage-e/version/v1',
    ],
    resultIntentCount: 2,
    resultIntentVersionSetDigest: 'sha256:89a215a87550e1422136a88947136cbb120b9dc4312f2909904f7272a30ae8e5',
    orderLineageKeyDigest: 'sha256:6560fab594e1528964ce95fbb2fac47f56e7d2a69096cfaa4c8e5e179f67b2ec',
    validFrom: '2026-01-01T00:00:06Z',
    knowledgeFrom: '2026-01-01T00:00:10Z',
    availableFrom: '2026-01-01T00:00:10Z',
    sourceArtifactRef: 'https://evidence.axiolune.ai/orders/router/adversarial-edge',
    sourceArtifactDigest: `sha256:${'6'.repeat(64)}`,
    sourceLocator: '$.routingTransformations[2]',
  });
  assert.throws(() => validateFixture(repeatedEdge), /duplicate directed edge/);
});

test('order-intent lineage rejects exact-quantity loss and PIT-ineligible endpoints', () => {
  const lostQuantity = orderLineageCandidate();
  lostQuantity.instance.intents.find((intent) => intent.versionIri.includes('/lineage-c/')).quantity.value = '59';
  assert.throws(() => validateFixture(lostQuantity), /does not conserve exact Quantity/);

  const futureEndpoint = orderLineageCandidate();
  futureEndpoint.instance.intents.find((intent) => intent.versionIri.includes('/lineage-c/')).availableFrom = '2026-01-01T00:00:06.000000001Z';
  assert.throws(() => validateFixture(futureEndpoint), /is not PIT-eligible/);
});

test('order-intent lineage rejects non-canonical endpoint order and runtime reservations', () => {
  const unsorted = orderLineageCandidate();
  unsorted.instance.lineages[1].sourceIntentVersionIris.reverse();
  assert.throws(() => validateFixture(unsorted), /must be UTF-8 sorted/);

  const reservation = orderLineageCandidate();
  reservation.instance.lineages[0].reservationId = 'runtime-reservation-1';
  assert.throws(() => validateFixture(reservation), /runtime reservation state is forbidden/);
});
