'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const yaml = require('js-yaml');

const {
  CQ_FUNCTION_VERSION,
  GRAPH_CONTRACT,
  PostTradeCqError,
  buildIndexes,
  executeCq,
  executeFixtureCq,
  iriSetDigest,
  queryDigest,
  resultDigest,
} = require('../lib/post-trade-cq.cjs');
const {
  applyMutation,
  loadFixture,
  materializeYamlMerges,
} = require('../lib/strict-fixture-loader.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_ROOT = path.join(ROOT, 'tests', 'm2', 'fixtures', 'post-trade-cq');
const CARD_FILE = path.join(ROOT, 'docs', 'ontology', 'competency-questions', 'fin-post-trade-cq.yaml');
const CANONICAL_SOURCE_FILE = path.join(
  ROOT,
  'tests', 'm2', 'fixtures', 'positive',
  'post-trade-closure-reconciliation.yaml',
);

function fixture(name) {
  return loadFixture(path.join(FIXTURE_ROOT, name), { rootDirectory: FIXTURE_ROOT });
}

function jsonFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, name), 'utf8'));
}

function digest(relativePath) {
  return `sha256:${crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(ROOT, relativePath)))
    .digest('hex')}`;
}

function sorted(values) {
  return [...values].sort(
    (left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
  );
}

function assertExactIds(actual, expected, label) {
  assert.equal(actual.length, new Set(actual).size, `${label}: duplicate ID`);
  assert.equal(expected.length, new Set(expected).size, `${label}: duplicate expected ID`);
  assert.deepEqual(sorted(actual), sorted(expected), label);
}

const graph = fixture('graph.yaml');
const positive = fixture('positive.yaml');
const negative = fixture('negative.yaml');
const materializationRun = jsonFixture('materialization-run.json');
const pitLedger = jsonFixture('pit-ledger.json');
const probeLedger = jsonFixture('probe-ledger.json');
const expectedLedger = jsonFixture('expected-ledger.json');
const canonicalSource = yaml.load(fs.readFileSync(CANONICAL_SOURCE_FILE, 'utf8'));
const card = materializeYamlMerges(yaml.load(fs.readFileSync(CARD_FILE, 'utf8')));
const positiveById = new Map(positive.cases.map((entry) => [entry.id, entry]));
const expectedById = new Map(expectedLedger.cases.map((entry) => [entry.caseId, entry]));

function queryFor(candidate) {
  return candidate.query || positiveById.get(candidate.baseCaseId)?.query;
}

test('PTO CQ is byte-locked to canonical module, closure, projections, validators, and real control artifacts', () => {
  assert.equal(CQ_FUNCTION_VERSION, 'axiolune-m2-cq-post-trade/v2');
  assert.equal(graph.contract, GRAPH_CONTRACT);
  assert.equal(graph.referenceTime, '2026-07-31T00:00:00Z');
  assert.equal(positive.contract, CQ_FUNCTION_VERSION);
  assert.equal(negative.contract, CQ_FUNCTION_VERSION);
  assert.equal(buildIndexes(canonicalSource).scenarioCount, 8);
  assert.equal(card.moduleStatus, 'draft');
  assert.equal(card.approvalStatus, 'not-approved');
  assert.equal(card.joinedExecution.functionVersion, CQ_FUNCTION_VERSION);

  for (const name of [
    'module', 'registry', 'owl', 'shacl', 'semanticValidator', 'coreValidator',
    'pitValidator', 'canonicalSource', 'implementation', 'oracleGenerator', 'materializationRun',
    'pitLedger', 'probeLedger', 'expectedLedger',
  ]) {
    assert.equal(digest(graph[name].path), graph[name].digest, `${name} byte lock`);
  }
  assert.equal(materializationRun.status, 'completed');
  assert.equal(materializationRun.result, 'success');
  assert.equal(materializationRun.referenceTime, graph.referenceTime);
  assert.equal(materializationRun.completedAt, graph.referenceTime);
  for (const name of [
    'module', 'registry', 'owl', 'shacl', 'semanticValidator', 'coreValidator',
    'pitValidator', 'canonicalSource', 'implementation', 'oracleGenerator',
  ]) assert.deepEqual(materializationRun.inputs[name], graph[name]);
  assert.deepEqual(pitLedger.materializationRun, graph.materializationRun);
  assert.deepEqual(probeLedger.materializationRun, graph.materializationRun);
  assert.deepEqual(probeLedger.pitLedger, graph.pitLedger);
  assert.deepEqual(probeLedger.canonicalSource, graph.canonicalSource);
  assert.equal(expectedLedger.derivedByRuntime, false);
  assert.equal(expectedLedger.reviewStatus, 'unapproved');
});

test('the independent expected ledger generator is deterministic and does not import the CQ runtime', () => {
  const generator = path.join(FIXTURE_ROOT, 'generate-expected-ledger.cjs');
  const source = fs.readFileSync(generator, 'utf8');
  assert.equal(source.includes('post-trade-cq.cjs'), false);
  const before = fs.readFileSync(path.join(FIXTURE_ROOT, 'expected-ledger.json'));
  const result = spawnSync(process.execPath, [generator], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const after = fs.readFileSync(path.join(FIXTURE_ROOT, 'expected-ledger.json'));
  assert.deepEqual(after, before);
});

test('card, fixtures, PIT ledger, probe ledger, and expected ledger have exact case-ID multisets', () => {
  const allFixtureIds = [...positive.cases, ...negative.cases].map((entry) => entry.id);
  assertExactIds(
    pitLedger.cases.map((entry) => entry.caseId),
    allFixtureIds,
    'PIT ledger cases',
  );
  const resultCaseIds = [
    ...positive.cases.map((entry) => entry.id),
    ...negative.cases.filter((entry) => entry.expectedOutcome === 'empty').map((entry) => entry.id),
  ];
  assertExactIds(probeLedger.cases.map((entry) => entry.caseId), resultCaseIds, 'probe ledger cases');
  assertExactIds(expectedLedger.cases.map((entry) => entry.caseId), resultCaseIds, 'expected ledger cases');

  assert.equal(card.cqs.length, 3);
  for (const cq of card.cqs.filter((entry) => ['CQ-PTO1', 'CQ-PTO2'].includes(entry.id))) {
    assert.equal(cq.status, 'active');
    assert.equal(cq.execution.functionVersion, CQ_FUNCTION_VERSION);
    assertExactIds(
      cq.positiveCases,
      positive.cases.filter((entry) => entry.cqId === cq.id).map((entry) => entry.id),
      `${cq.id} positive cases`,
    );
    assertExactIds(
      cq.negativeCases,
      negative.cases.filter((entry) => entry.cqId === cq.id).map((entry) => entry.id),
      `${cq.id} negative cases`,
    );
  }
});

test('positive CQ-PTO1/PTO2 cases execute canonical contracts and match independent rows exactly', async (t) => {
  assert.equal(positive.cases.length, 5);
  for (const candidate of positive.cases) {
    await t.test(candidate.id, () => {
      const expected = expectedById.get(candidate.id);
      assert(expected, `missing expected row for ${candidate.id}`);
      const rows = executeCq(candidate.cqId, graph, candidate.query, { caseId: candidate.id });
      assert.deepEqual(rows, expected.rows);
      assert.equal(
        resultDigest(candidate.cqId, rows),
        probeLedger.cases.find((entry) => entry.caseId === candidate.id).resultDigest,
      );
    });
  }
});

test('semantic mutation matrix kills transfer, rights, DVP, allocation, PIT, and reconciliation defects at the declared locus', async (t) => {
  assert.equal(negative.cases.length, 14);
  for (const candidate of negative.cases) {
    await t.test(candidate.id, () => {
      const query = queryFor(candidate);
      assert(query, `missing query for ${candidate.id}`);
      assert.equal(
        pitLedger.cases.find((entry) => entry.caseId === candidate.id).queryDigest,
        queryDigest(candidate.cqId, query),
      );
      if (candidate.expectedOutcome === 'empty') {
        assert.deepEqual(
          executeCq(candidate.cqId, graph, query, { caseId: candidate.id }),
          [],
        );
        return;
      }
      const mutated = structuredClone(canonicalSource);
      for (const mutation of candidate.sourceMutations) applyMutation(mutated, mutation);
      assert.throws(
        () => executeFixtureCq(candidate.cqId, graph, query, mutated, { caseId: candidate.id }),
        (error) => error instanceof PostTradeCqError
          && error.code === candidate.expectedErrorCode
          && (candidate.expectedCauseCode === undefined
            || error.causeCode === candidate.expectedCauseCode),
      );
    });
  }
});

test('PTO1 recomputes completed-current transfer closure and resolves the rights precedence chain', () => {
  const due = positiveById.get('cq-pto1-stock-split-due-bill-correction-closure');
  const [dueRow] = executeCq(due.cqId, graph, due.query, { caseId: due.id });
  assert.deepEqual(
    dueRow.transferClosures.map((entry) => ({
      obligationVersionIri: entry.obligationVersionIri,
      transfers: entry.transferVersionIris,
      fulfilled: entry.fulfilledAmount,
      remaining: entry.remainingAmount,
      result: entry.result,
    })),
    [
      {
        obligationVersionIri: 'https://example.test/fact/obligation/1/v1',
        transfers: [
          'https://example.test/fact/transfer/1/v2',
          'https://example.test/fact/transfer/2/v1',
        ],
        fulfilled: '10', remaining: '0', result: 'fullyFulfilled',
      },
      {
        obligationVersionIri: 'https://example.test/fact/obligation/2/v1',
        transfers: [
          'https://example.test/fact/transfer/3/v1',
          'https://example.test/fact/transfer/4/v1',
        ],
        fulfilled: '3', remaining: '5', result: 'partiallyFulfilled',
      },
      {
        obligationVersionIri: 'https://example.test/fact/obligation/3/v1',
        transfers: [], fulfilled: '0', remaining: '5', result: 'unfulfilled',
      },
    ],
  );

  const rights = positiveById.get('cq-pto1-rights-election-subscription-adjustment');
  const [rightsRow] = executeCq(rights.cqId, graph, rights.query, { caseId: rights.id });
  assert.equal(rightsRow.resolution.result, 'selectedExercise');
  assert.equal(rightsRow.resolution.selectedElectionVersionIri,
    'https://example.test/fact/election/1/v1');
  assert.equal(rightsRow.fulfillmentClosure.result, 'fullyFulfilled');
  assert.equal(rightsRow.adjustment.cashDelta, '-20');
  assert.equal(rightsRow.adjustment.quantityDelta, '10');
});

test('PTO2 exposes canonical settled, reciprocal DVP, Execution/Quantity/Money, and recomputed reconciliation values', () => {
  const candidate = positiveById.get('cq-pto2-dvp-omnibus-economic-reconciliation');
  const [row] = executeCq(candidate.cqId, graph, candidate.query, { caseId: candidate.id });
  assert.ok(row.settlementStatusHistory.some((entry) => entry.state === 'settled'));
  assert.ok(row.allocations.every((entry) => entry.execution.versionIri));
  assert.ok(row.allocations.every((entry) => entry.execution.quantity.value
    && entry.execution.quantity.unit));
  const security = row.legs.find((entry) => entry.asset.kind === 'security');
  const cash = row.legs.find((entry) => entry.asset.kind === 'money');
  assert.equal(cash.fromParty, security.toParty);
  assert.equal(cash.toParty, security.fromParty);
  assert.equal(cash.asset.currency, 'USD');
  assert.ok(row.reconciliation.internalProjections.every((entry) => entry.value.amount));
  assert.ok(row.reconciliation.externalStatementLines.every((entry) => entry.value.amount));
  assert.deepEqual(
    row.reconciliation.findings.map((entry) => entry.kind),
    ['matched', 'valueMismatch', 'missingSide', 'missingSide', 'duplicate',
      'duplicate', 'duplicate', 'duplicate', 'duplicate'],
  );
});

test('execution is deterministic, immutable, fail-closed, and bound to MaterializationRun referenceTime', () => {
  const candidate = positiveById.get('cq-pto2-fop-direct-settlement-account-reconciliation');
  const before = JSON.stringify(canonicalSource);
  const first = executeCq(candidate.cqId, graph, candidate.query, { caseId: candidate.id });
  const second = executeCq(candidate.cqId, graph, candidate.query, { caseId: candidate.id });
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(canonicalSource), before);

  const future = structuredClone(candidate.query);
  future.pivot.asOfAvailable = '2026-08-01T00:00:00Z';
  assert.throws(
    () => executeCq(candidate.cqId, graph, future, { caseId: candidate.id }),
    (error) => error instanceof PostTradeCqError && error.code === 'PTO_CQ_FUTURE_PIVOT',
  );
  const impossibleCalendarDate = structuredClone(candidate.query);
  impossibleCalendarDate.pivot.asOfValid = '2026-02-30T00:00:00Z';
  assert.throws(
    () => executeCq(candidate.cqId, graph, impossibleCalendarDate, { caseId: candidate.id }),
    (error) => error instanceof PostTradeCqError && error.code === 'PTO_CQ_PIVOT',
  );
  assert.throws(
    () => executeCq('CQ-PTO999', graph, candidate.query, { caseId: candidate.id }),
    (error) => error instanceof PostTradeCqError && error.code === 'PTO_CQ_UNSUPPORTED',
  );
  const unlocked = structuredClone(graph);
  unlocked.canonicalSource.digest = `sha256:${'f'.repeat(64)}`;
  assert.throws(
    () => executeCq(candidate.cqId, unlocked, candidate.query, { caseId: candidate.id }),
    (error) => error instanceof PostTradeCqError && error.code === 'PTO_CQ_ARTIFACT_LOCK',
  );
});

test('RFC section-5.8 empty-set digest remains byte-framed', () => {
  assert.equal(
    iriSetDigest([]),
    'sha256:719c6702560132c7c314018468acd925ae83063b73747a542080c843b6b905e1',
  );
});
