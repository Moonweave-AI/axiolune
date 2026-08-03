'use strict';

const crypto = require('node:crypto');
const {
  canonicalJcs,
} = require('./strict-source-locator.cjs');
const {
  TYPES,
} = require('./risk-canonical-record-adapter.cjs');

const CONSTRAINT_BASE = 'https://axiolune.ai/ontology/finance/risk';

function recordOf(scenario, typeIri) {
  return scenario.records.find((record) => record.typeIri === typeIri);
}

function sha256Canonical(value) {
  return `sha256:${crypto.createHash('sha256')
    .update(Buffer.from(canonicalJcs(value), 'utf8'))
    .digest('hex')}`;
}

function createRiskAdversarialCases({ moneyScenario, bucketScenario, bucketDigest }) {
  if (typeof bucketDigest !== 'function') throw new TypeError('bucketDigest is required');
  const cases = [];

  const forgedMethodDigest = structuredClone(moneyScenario);
  const arbitraryMethodDigest = `sha256:${'a'.repeat(64)}`;
  recordOf(forgedMethodDigest, TYPES.definition).methodDigest = arbitraryMethodDigest;
  forgedMethodDigest.artifactRecords.find(
    (record) => record.artifactRole === 'method',
  ).artifactDigest = arbitraryMethodDigest;
  cases.push({
    id: 'forged-method-digest',
    constraintIri: `${CONSTRAINT_BASE}/RiskMeasureDefinitionContract`,
    expectedViolation: 'definition-artifact-evidence',
    query: {
      scopeKind: 'portfolio',
      scopeRef: 'https://example.test/portfolio/alpha',
      riskMeasureId: 'variance-covariance-var',
    },
    scenario: forgedMethodDigest,
  });

  const ghostMarketDataStream = structuredClone(moneyScenario);
  const ghostStreamVersionIri = 'https://example.test/market-data/stream/ghost/version/1';
  recordOf(ghostMarketDataStream, TYPES.measurement).measurementMarketDataStream =
    ghostStreamVersionIri;
  ghostMarketDataStream.referenceRecords[0].versionIri = ghostStreamVersionIri;
  ghostMarketDataStream.referenceRecords[0].recordDigest = sha256Canonical(
    Object.fromEntries(Object.entries(ghostMarketDataStream.referenceRecords[0]).filter(
      ([field]) => !['recordDigest', 'recordPath', 'recordSelector'].includes(field),
    )),
  );
  cases.push({
    id: 'ghost-exact-market-data-stream',
    constraintIri: `${CONSTRAINT_BASE}/RiskMeasurementContract`,
    expectedViolation: 'measurement-market-data-stream',
    query: {
      scopeKind: 'portfolio',
      scopeRef: 'https://example.test/portfolio/alpha',
      riskMeasureId: 'variance-covariance-var',
    },
    scenario: ghostMarketDataStream,
  });

  const ghostInputContext = structuredClone(moneyScenario);
  const ghostContextRef = 'urn:materialization:risk-input-ghost';
  const ghostContextDigest = `sha256:${'b'.repeat(64)}`;
  const measurement = recordOf(ghostInputContext, TYPES.measurement);
  measurement.inputContextRef = ghostContextRef;
  measurement.inputContextRecordDigest = ghostContextDigest;
  ghostInputContext.inputContextRecords[0].contextRef = ghostContextRef;
  ghostInputContext.inputContextRecords[0].recordDigest = ghostContextDigest;
  cases.push({
    id: 'caller-forged-input-context',
    constraintIri: `${CONSTRAINT_BASE}/RiskMeasurementContract`,
    expectedViolation: 'measurement-input-context',
    query: {
      scopeKind: 'portfolio',
      scopeRef: 'https://example.test/portfolio/alpha',
      riskMeasureId: 'variance-covariance-var',
    },
    scenario: ghostInputContext,
  });

  const identityDrift = structuredClone(moneyScenario);
  const mutatedRiskMeasureId = 'variance-covariance-var-mutated';
  recordOf(identityDrift, TYPES.definition).riskMeasureId = mutatedRiskMeasureId;
  identityDrift.identityRecords[0].riskMeasureId = mutatedRiskMeasureId;
  identityDrift.identityRecords[0].identityDigest = sha256Canonical({
    logicalIri: identityDrift.identityRecords[0].logicalIri,
    riskMeasureId: identityDrift.identityRecords[0].riskMeasureId,
    versionIri: identityDrift.identityRecords[0].versionIri,
    versionOf: identityDrift.identityRecords[0].versionOf,
  });
  cases.push({
    id: 'risk-measure-id-version-identity-drift',
    constraintIri: `${CONSTRAINT_BASE}/RiskMeasureDefinitionContract`,
    expectedViolation: 'definition-identity-closure',
    query: {
      scopeKind: 'portfolio',
      scopeRef: 'https://example.test/portfolio/alpha',
      riskMeasureId: 'variance-covariance-var-mutated',
    },
    scenario: identityDrift,
  });

  const callerSubsetClosure = structuredClone(bucketScenario);
  callerSubsetClosure.records = callerSubsetClosure.records.filter((record) => (
    record.typeIri !== TYPES.bucketValue || !record.versionIri.includes('/gamma/')
  ));
  for (const bucketSet of callerSubsetClosure.records.filter(
    (record) => record.typeIri === TYPES.bucketSet,
  )) {
    const values = callerSubsetClosure.records.filter((record) => (
      record.typeIri === TYPES.bucketValue && record.bucketValueSet === bucketSet.versionIri
    ));
    bucketSet.bucketValueCount = values.length;
    bucketSet.bucketValueSetDigest = bucketDigest(values);
    const probe = callerSubsetClosure.probeRecords.find(
      (record) => record.bucketSetVersionIri === bucketSet.versionIri,
    );
    probe.subjectVersionIris = values.map((value) => value.versionIri).sort();
    probe.subjectSetDigest = bucketSet.bucketValueSetDigest;
    const forgedProbePayload = Object.fromEntries(Object.entries(probe).filter(
      ([field]) => !['probeDigest', 'probePath', 'probeSelector'].includes(field),
    ));
    probe.probeDigest = sha256Canonical(forgedProbePayload);
    bucketSet.closureProbeDigest = probe.probeDigest;
  }
  cases.push({
    id: 'caller-subset-bucket-closure',
    constraintIri: `${CONSTRAINT_BASE}/RiskBucketSetClosureContract`,
    expectedViolation: 'measurement-bucket-closure-probe',
    query: {
      scopeKind: 'position',
      scopeRef: 'https://example.test/position/option-1/version/9',
      riskMeasureId: 'option-greeks',
    },
    scenario: callerSubsetClosure,
  });

  return cases;
}

module.exports = {
  createRiskAdversarialCases,
};
