'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { bucketDigest, loadYaml } = require('../lib/risk-v03-contract.cjs');
const {
  createRiskAdversarialCases,
} = require('../lib/risk-adversarial-cases.cjs');
const {
  authenticateSourceClaims,
} = require('../lib/post-trade-risk-source-artifact-inventory.cjs');
const { TYPES } = require('../lib/risk-canonical-record-adapter.cjs');
const {
  selectRiskEvaluations,
  selectRiskMeasurements,
} = require('../lib/risk-cq.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const document = loadYaml(path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'risk-v03.yaml'));
const scenarios = document.fixtures.map((fixture) => fixture.instance);
const pivot = document.queryPivot;

function recordOf(scenario, typeIri) {
  return scenario.records.find((record) => record.typeIri === typeIri);
}

test('CQ-R1 returns exact value plus model, input snapshot, run, and temporal evidence', () => {
  const rows = selectRiskMeasurements(scenarios, {
    scopeKind: 'portfolio',
    scopeRef: 'https://example.test/portfolio/alpha',
    riskMeasureId: 'variance-covariance-var',
    pivot,
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(
    {
      version: rows[0].measurementVersionIri,
      representation: rows[0].representation,
      amount: rows[0].value.amount,
      currency: rows[0].value.currency,
      method: rows[0].methodRef,
      input: rows[0].inputContextRef,
      run: rows[0].generatingContextRef,
    },
    {
      version: 'https://example.test/risk/measurement/var/version/4',
      representation: 'money',
      amount: '900000.00',
      currency: 'USD',
      method: 'urn:method:variance-covariance-var',
      input: 'urn:materialization:risk-input-shared',
      run: 'urn:materialization:risk-measurement-42',
    },
  );
});

test('CQ-R1 exact scope and half-open PIT boundaries return empty', () => {
  assert.deepEqual(selectRiskMeasurements(scenarios, {
    scopeKind: 'portfolio',
    scopeRef: 'https://example.test/portfolio/not-alpha',
    riskMeasureId: 'variance-covariance-var',
    pivot,
  }), []);

  const beforeAvailability = {
    ...pivot,
    asOfAvailable: '2026-07-31T09:00:01Z',
  };
  assert.deepEqual(selectRiskMeasurements(scenarios, {
    scopeKind: 'portfolio',
    scopeRef: 'https://example.test/portfolio/alpha',
    riskMeasureId: 'variance-covariance-var',
    pivot: beforeAvailability,
  }), []);

  const closed = structuredClone(scenarios);
  recordOf(closed[0], TYPES.measurement).validTo = pivot.asOfValid;
  assert.deepEqual(selectRiskMeasurements(closed, {
    scopeKind: 'portfolio',
    scopeRef: 'https://example.test/portfolio/alpha',
    riskMeasureId: 'variance-covariance-var',
    pivot,
  }), []);

  const atKnowledgeClosure = {
    ...pivot,
    asOfKnowledge: '2026-07-31T11:00:00Z',
  };
  assert.deepEqual(selectRiskMeasurements(scenarios, {
    scopeKind: 'portfolio',
    scopeRef: 'https://example.test/portfolio/alpha',
    riskMeasureId: 'variance-covariance-var',
    pivot: atKnowledgeClosure,
  }), []);
});

test('CQ-R1 rejects future knowledge and availability pivots', () => {
  assert.throws(
    () => selectRiskMeasurements(scenarios, {
      scopeKind: 'portfolio',
      scopeRef: 'https://example.test/portfolio/alpha',
      riskMeasureId: 'variance-covariance-var',
      pivot: {
        ...pivot,
        asOfKnowledge: '2026-07-31T12:00:01Z',
      },
    }),
    (error) => error.code === 'RISK_CQ_FUTURE_PIVOT',
  );
});

test('CQ-R2 emits no breach for withinLimit and one exact chain for breach', () => {
  const within = selectRiskEvaluations(scenarios, {
    measurementVersionIri: 'https://example.test/risk/measurement/var/version/4',
    limitVersionIri: 'https://example.test/risk/limit/var/version/2',
    pivot,
  });
  assert.equal(within.length, 1);
  assert.equal(within[0].result, 'withinLimit');
  assert.equal(within[0].breach, null);

  const breached = selectRiskEvaluations(scenarios, {
    measurementVersionIri: 'https://example.test/risk/measurement/volatility/version/7',
    limitVersionIri: 'https://example.test/risk/limit/volatility/version/5',
    pivot,
  });
  assert.equal(breached.length, 1);
  assert.equal(breached[0].result, 'breach');
  assert.equal(
    breached[0].breach.versionIri,
    'https://example.test/risk/breach/volatility/version/1',
  );
  assert.equal(
    breached[0].breach.evaluationVersionIri,
    'https://example.test/risk/evaluation/volatility/version/1',
  );
  assert.equal(breached[0].breach.provenance.source, 'urn:source:risk-engine');
  assert.equal(breached[0].breach.temporal.effectiveKnowledgeTo, null);
});

test('CQ-R2 rejects a breach result whose exact LimitBreach is absent', () => {
  const invalid = structuredClone(scenarios);
  invalid[1].records = invalid[1].records.filter((record) => record.typeIri !== TYPES.breach);
  assert.throws(
    () => selectRiskEvaluations(invalid, {
      measurementVersionIri: 'https://example.test/risk/measurement/volatility/version/7',
      limitVersionIri: 'https://example.test/risk/limit/volatility/version/5',
      pivot,
    }),
    (error) => error.code === 'RISK_CQ_INVALID_SCENARIO'
      && error.message.includes('missing-limit-breach'),
  );
});

test('CQ-R1 rejects two simultaneously eligible measurements for one exact query', () => {
  const duplicate = structuredClone(scenarios[0]);
  const duplicateMeasurement = recordOf(duplicate, TYPES.measurement);
  const duplicateEvaluation = recordOf(duplicate, TYPES.evaluation);
  duplicateMeasurement.versionIri = 'https://example.test/risk/measurement/var/version/999';
  duplicateEvaluation.evaluatedMeasurement = duplicateMeasurement.versionIri;
  duplicateEvaluation.versionIri = 'https://example.test/risk/evaluation/var/version/999';
  duplicate.temporalClosureRecords = [];
  assert.throws(
    () => selectRiskMeasurements([...scenarios, duplicate], {
      scopeKind: 'portfolio',
      scopeRef: 'https://example.test/portfolio/alpha',
      riskMeasureId: 'variance-covariance-var',
      pivot,
    }),
    (error) => error.code === 'RISK_CQ_AMBIGUOUS_MEASUREMENT',
  );
});

test('CQ-R2 rejects duplicate evaluations for one exact measurement/limit pair', () => {
  const duplicate = structuredClone(scenarios[1]);
  const duplicateEvaluation = recordOf(duplicate, TYPES.evaluation);
  const duplicateBreach = recordOf(duplicate, TYPES.breach);
  duplicateEvaluation.versionIri = 'https://example.test/risk/evaluation/volatility/version/999';
  duplicateBreach.versionIri = 'https://example.test/risk/breach/volatility/version/999';
  duplicateBreach.breachEvaluation = duplicateEvaluation.versionIri;
  assert.throws(
    () => selectRiskEvaluations([...scenarios, duplicate], {
      measurementVersionIri: 'https://example.test/risk/measurement/volatility/version/7',
      limitVersionIri: 'https://example.test/risk/limit/volatility/version/5',
      pivot,
    }),
    (error) => error.code === 'RISK_CQ_DUPLICATE_EVALUATION',
  );
});

const adversarialCases = createRiskAdversarialCases({
  moneyScenario: scenarios[0],
  bucketScenario: scenarios[2],
  bucketDigest,
});

for (const adversarial of adversarialCases) {
  test(`CQ-R1 rejects ${adversarial.id} before returning a row`, () => {
    assert.throws(
      () => selectRiskMeasurements([authenticateSourceClaims(
        adversarial.scenario,
        { namespace: 'risk-source' },
      )], {
        ...adversarial.query,
        pivot,
      }),
      (error) => error.code === 'RISK_CQ_INVALID_SCENARIO'
        && error.message.includes(adversarial.expectedViolation),
    );
  });
}
