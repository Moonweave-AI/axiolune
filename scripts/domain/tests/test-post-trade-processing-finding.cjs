'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const {
  ContractViolation,
  iriSetDigest,
  mutate,
  queryProcessingFindings,
  validateProcessingFinding,
} = require('../lib/post-trade-v03-contract.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SOURCE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'post-trade-processing-finding', 'positive.yaml');
const NEGATIVE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'post-trade-processing-finding', 'negative.yaml');
const CQ_ROOT = path.join(ROOT, 'tests', 'm2', 'fixtures', 'post-trade-processing-finding-cq');
const CARD = path.join(ROOT, 'docs', 'ontology', 'competency-questions', 'fin-post-trade-cq.yaml');

const source = yaml.load(fs.readFileSync(SOURCE, 'utf8')).fixture.instance;
const negative = yaml.load(fs.readFileSync(NEGATIVE, 'utf8'));
const positiveCq = yaml.load(fs.readFileSync(path.join(CQ_ROOT, 'positive.yaml'), 'utf8'));
const negativeCq = yaml.load(fs.readFileSync(path.join(CQ_ROOT, 'negative.yaml'), 'utf8'));
const expectedLedger = JSON.parse(fs.readFileSync(path.join(CQ_ROOT, 'expected-ledger.json'), 'utf8'));
const card = yaml.load(fs.readFileSync(CARD, 'utf8'));

const RELATED_FIELDS = Object.freeze({
  failedAssessmentVersionIri: { multiple: false, type: 'CorporateActionDistributionSizeAssessment' },
  findingRuleConflictVersionIri: { multiple: false, type: 'RuleConflict' },
  relatedAdjustmentVersionIri: { multiple: false, type: 'CorporateActionAdjustment' },
  relatedDueBillClosureVersionIri: { multiple: false, type: 'CorporateActionDueBillTransferFulfillmentClosure' },
  relatedDueBillObligationVersionIri: { multiple: false, type: 'CorporateActionDueBillObligation' },
  relatedDueBillQualificationVersionIri: { multiple: false, type: 'CorporateActionDueBillTradeQualification' },
  relatedDueBillTransferVersionIris: { multiple: true, type: 'CorporateActionDueBillTransfer' },
  relatedEntitlementVersionIri: {
    multiple: false,
    subjectJoinField: 'scheduleResolutionVersionIri',
    type: 'CorporateActionEntitlement',
  },
  relatedElectionResolutionVersionIri: { multiple: false, type: 'CorporateActionElectionResolution' },
  relatedElectionVersionIris: { multiple: true, type: 'CorporateActionElection' },
  relatedSubscriptionClosureVersionIri: { multiple: false, type: 'CorporateActionSubscriptionFulfillmentClosure' },
  relatedSubscriptionObligationVersionIri: { multiple: false, type: 'CorporateActionSubscriptionObligation' },
});

// RFC-001 section 5.19's closed stage/kind matrix.  This list is intentionally
// independent of the implementation table so an omitted or moved kind fails.
const MATRIX_CASES = Object.freeze([
  ['schedule', 'noApplicableRule', {}],
  ['schedule', 'ruleConflict', { findingRuleConflictVersionIri: 1 }],
  ['schedule', 'sizeAssessmentFailure', {}],
  ['entitlement', 'missingElection', {}],
  ['entitlement', 'lateElection', { relatedElectionVersionIris: 1 }],
  ['entitlement', 'overElection', { relatedElectionVersionIris: 1 }],
  ['entitlement', 'unauthorizedElection', { relatedElectionVersionIris: 1 }],
  ['entitlement', 'electionConflict', { relatedElectionVersionIris: 2 }],
  ['entitlement', 'invalidDefaultLapse', { relatedElectionResolutionVersionIri: 1 }],
  ['entitlement', 'electionResolutionFailure', {}],
  ['entitlement', 'subscriptionFulfillmentMismatch', {
    relatedElectionResolutionVersionIri: 1,
    relatedElectionVersionIris: 1,
    relatedSubscriptionClosureVersionIri: 1,
    relatedSubscriptionObligationVersionIri: 1,
  }],
  ['entitlement', 'calculationMismatch', {}],
  ['entitlement', 'adjustmentMismatch', { relatedAdjustmentVersionIri: 1 }],
  ['dueBill', 'missingDueBillEvidence', {}],
  ['dueBill', 'conflictingDueBillEvidence', {
    relatedDueBillObligationVersionIri: 1,
    relatedDueBillQualificationVersionIri: 1,
  }],
  ['dueBill', 'ineligibleTradeQualification', { relatedDueBillQualificationVersionIri: 1 }],
  ['dueBill', 'endpointMismatch', { relatedDueBillQualificationVersionIri: 1 }],
  ['dueBill', 'obligationBenefitMismatch', { relatedDueBillObligationVersionIri: 1 }],
  ['dueBill', 'dueBillTransferMismatch', {
    relatedDueBillObligationVersionIri: 1,
    relatedDueBillTransferVersionIris: 1,
  }],
  ['dueBill', 'duplicateTransfer', { relatedDueBillTransferVersionIris: 2 }],
  ['dueBill', 'overTransfer', {
    relatedDueBillClosureVersionIri: 1,
    relatedDueBillObligationVersionIri: 1,
    relatedDueBillTransferVersionIris: 1,
  }],
]);

function digest(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function sorted(values) {
  return [...values].sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
}

function matrixFixture(stage, kind, relatedCounts) {
  const stem = `${stage}-${kind}`;
  const eventLogicalIri = `https://example.test/fact/corporate-action/event/matrix-${stem}`;
  const eventVersionIri = `${eventLogicalIri}/v1`;
  const subjectType = {
    dueBill: 'CorporateActionScheduleResolution',
    entitlement: 'CorporateActionEntitlement',
    schedule: 'CorporateActionScheduleEvaluationInput',
  }[stage];
  const subjectField = {
    dueBill: 'dueBillSubjectVersionIri',
    entitlement: 'entitlementSubjectVersionIri',
    schedule: 'scheduleSubjectVersionIri',
  }[stage];
  const subjectVersionIri = `https://example.test/fact/corporate-action/subject/${stem}/v1`;
  const records = [
    { type: 'CorporateActionEvent', logicalIri: eventLogicalIri, versionIri: eventVersionIri },
    { type: subjectType, versionIri: subjectVersionIri, eventVersionIri },
  ];
  const related = {};
  const relatedIris = [];
  for (const [field, count] of Object.entries(relatedCounts)) {
    const descriptor = RELATED_FIELDS[field];
    assert(descriptor, `missing test descriptor for ${field}`);
    const iris = [];
    for (let index = 0; index < count; index += 1) {
      const iri = `https://example.test/fact/corporate-action/related/${stem}/${field}/${index + 1}/v1`;
      iris.push(iri);
      relatedIris.push(iri);
      records.push(descriptor.subjectJoinField ? {
        type: descriptor.type,
        versionIri: iri,
        eventVersionIri,
        [descriptor.subjectJoinField]: subjectVersionIri,
      } : { type: descriptor.type, versionIri: iri, subjectVersionIri });
    }
    related[field] = descriptor.multiple ? iris : iris[0];
  }
  const evidenceClosure = sorted([eventVersionIri, subjectVersionIri, ...relatedIris]);
  return {
    findings: [{
      logicalIri: `https://example.test/fact/corporate-action/processing-finding/matrix-${stem}`,
      versionIri: `https://example.test/fact/corporate-action/processing-finding/matrix-${stem}/v1`,
      eventLogicalIri,
      eventVersionIri,
      findingStage: stage,
      processingFindingKind: kind,
      [subjectField]: subjectVersionIri,
      ...related,
      evidenceSetDigest: iriSetDigest(evidenceClosure),
      generatingContextRef: 'https://example.test/run/post-trade-processing-finding/matrix',
      validFrom: '2026-07-15T09:00:00Z',
      knowledgeFrom: '2026-07-15T09:00:01Z',
      availableFrom: '2026-07-15T09:00:02Z',
      revision: 0,
    }],
    records,
  };
}

test('processing-finding canonical fixture and all declared negative mutations execute', () => {
  assert.doesNotThrow(() => validateProcessingFinding(source));
  assert.equal(negative.cases.length, 14);
  for (const candidate of negative.cases) {
    const mutated = candidate.mutations.reduce((value, mutation) => mutate(value, mutation), source);
    assert.throws(
      () => validateProcessingFinding(mutated),
      (error) => error instanceof ContractViolation && error.code === candidate.expectedViolation,
      candidate.id,
    );
  }
});

test('RFC section-5.19 closed stage/kind matrix accepts all 21 kinds and rejects cross-stage roles', () => {
  assert.deepEqual(
    Object.fromEntries(['schedule', 'entitlement', 'dueBill'].map((stage) => [
      stage, MATRIX_CASES.filter((entry) => entry[0] === stage).length,
    ])),
    { schedule: 3, entitlement: 10, dueBill: 8 },
  );
  for (const [stage, kind, relatedCounts] of MATRIX_CASES) {
    assert.doesNotThrow(() => validateProcessingFinding(matrixFixture(stage, kind, relatedCounts)),
      `${stage}/${kind}`);
    if (stage === 'dueBill') {
      assert.doesNotThrow(() => validateProcessingFinding(matrixFixture(stage, kind, {
        ...relatedCounts,
        relatedEntitlementVersionIri: 1,
      })), `${stage}/${kind} with optional related Entitlement`);
    }
  }
  const crossStage = matrixFixture('schedule', 'noApplicableRule', {});
  const finding = crossStage.findings[0];
  const electionIri = 'https://example.test/fact/corporate-action/related/cross-stage-election/v1';
  crossStage.records.push({
    type: 'CorporateActionElection', versionIri: electionIri,
    subjectVersionIri: finding.scheduleSubjectVersionIri,
  });
  finding.relatedElectionVersionIris = [electionIri];
  assert.throws(
    () => validateProcessingFinding(crossStage),
    (error) => error instanceof ContractViolation && error.code === 'processing-finding-presence-matrix',
  );
});

test('standard version chain is single-rooted per logical identity and selects the PIT-visible head', () => {
  const chain = matrixFixture('schedule', 'ruleConflict', { findingRuleConflictVersionIri: 1 });
  const predecessor = chain.findings[0];
  const successor = structuredClone(predecessor);
  successor.versionIri = `${predecessor.logicalIri}/v2`;
  successor.revision = 1;
  successor.supersedesVersionIri = predecessor.versionIri;
  successor.knowledgeFrom = '2026-07-15T10:00:00Z';
  successor.availableFrom = '2026-07-15T10:00:01Z';
  chain.findings.push(successor);
  assert.doesNotThrow(() => validateProcessingFinding(chain));

  const independent = matrixFixture('schedule', 'noApplicableRule', {});
  assert.doesNotThrow(() => validateProcessingFinding({
    findings: [predecessor, independent.findings[0]],
    records: [...chain.records, ...independent.records],
  }));

  const at = (asOfKnowledge, asOfAvailable) => queryProcessingFindings(chain, {
    eventVersionIri: predecessor.eventVersionIri,
    pivot: {
      asOfValid: '2026-07-15T09:30:00Z',
      asOfKnowledge,
      asOfAvailable,
      referenceTime: '2026-07-15T12:00:00Z',
    },
  });
  assert.equal(at('2026-07-15T09:30:00Z', '2026-07-15T09:30:00Z')[0].revision, 0);
  assert.equal(at('2026-07-15T10:30:00Z', '2026-07-15T10:30:00Z')[0].revision, 1);

  const skip = structuredClone(chain);
  skip.findings[1].revision = 2;
  assert.throws(
    () => validateProcessingFinding(skip),
    (error) => error instanceof ContractViolation && error.code === 'processing-finding-supersession',
  );
  const nonMonotonic = structuredClone(chain);
  nonMonotonic.findings[1].knowledgeFrom = predecessor.knowledgeFrom;
  assert.throws(
    () => validateProcessingFinding(nonMonotonic),
    (error) => error instanceof ContractViolation && error.code === 'processing-finding-supersession',
  );
  const branch = structuredClone(chain);
  const competing = structuredClone(branch.findings[1]);
  competing.versionIri = `${predecessor.logicalIri}/v2-competing`;
  competing.knowledgeFrom = '2026-07-15T10:01:00Z';
  competing.availableFrom = '2026-07-15T10:01:01Z';
  branch.findings.push(competing);
  assert.throws(
    () => validateProcessingFinding(branch),
    (error) => error instanceof ContractViolation && error.code === 'processing-finding-supersession',
  );

  const duplicateRoot = structuredClone(chain);
  const competingRoot = structuredClone(predecessor);
  competingRoot.versionIri = `${predecessor.logicalIri}/v1-competing`;
  competingRoot.validFrom = '2026-07-15T11:00:00Z';
  competingRoot.knowledgeFrom = '2026-07-15T11:00:01Z';
  competingRoot.availableFrom = '2026-07-15T11:00:02Z';
  duplicateRoot.findings.push(competingRoot);
  assert.throws(
    () => validateProcessingFinding(duplicateRoot),
    (error) => error instanceof ContractViolation && error.code === 'processing-finding-supersession',
  );
});

test('CQ-PTO3 returns the static three-stage ledger and enforces PIT, future, and digest controls', () => {
  const candidate = positiveCq.cases[0];
  const expected = expectedLedger.cases.find((entry) => entry.caseId === candidate.id);
  const first = queryProcessingFindings(source, candidate.query);
  assert.deepEqual(first, expected.rows);
  assert.deepEqual(queryProcessingFindings(source, candidate.query), first);
  assert.deepEqual(first.map((row) => `${row.findingStage}/${row.processingFindingKind}`), [
    'dueBill/duplicateTransfer', 'entitlement/electionConflict', 'schedule/ruleConflict',
  ]);
  for (const rejection of negativeCq.cases) {
    if (rejection.expectedOutcome === 'empty') {
      assert.deepEqual(queryProcessingFindings(source, rejection.query), [], rejection.id);
      continue;
    }
    const candidateSource = rejection.sourceMutation ? mutate(source, rejection.sourceMutation) : source;
    assert.throws(
      () => queryProcessingFindings(candidateSource, rejection.query),
      (error) => error instanceof ContractViolation && error.code === rejection.expectedErrorCode,
      rejection.id,
    );
  }
});

test('CQ-PTO3 card, fixtures, ledger, validator, module, and projection are byte-locked', () => {
  const cq = card.cqs.find((entry) => entry.id === 'CQ-PTO3');
  assert(cq);
  assert.equal(cq.status, 'active');
  assert.deepEqual(cq.positiveCases, positiveCq.cases.map((entry) => entry.id));
  assert.deepEqual(cq.negativeCases, negativeCq.cases.map((entry) => entry.id));
  assert.equal(cq.execution.functionVersion, positiveCq.contract);
  assert.equal(expectedLedger.derivedByRuntime, false);
  assert.equal(expectedLedger.reviewStatus, 'unapproved');
  for (const [name, lock] of Object.entries(cq.execution.artifactLocks)) {
    assert.equal(digest(path.join(ROOT, lock.path)), lock.digest, `${name} byte lock`);
  }
});

test('Custom runtime discovery binds ProcessingFinding to its dedicated fixture and violation', () => {
  const profile = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'scripts', 'domain', 'post-trade-custom-profile', 'v0.3.0', 'discovery-contract.json'),
    'utf8',
  ));
  const vectors = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'scripts', 'domain', 'post-trade-custom-profile', 'v0.3.0', 'test-vectors.json'),
    'utf8',
  ));
  const discovery = profile.constraints.find((entry) => entry.validatorId === 'CorporateActionProcessingFindingContract');
  const vector = vectors.vectors.find((entry) => entry.validatorId === 'CorporateActionProcessingFindingContract');
  assert.equal(discovery.fixtureContract, 'CorporateActionProcessingFinding');
  assert.equal(discovery.evaluatorId, 'validateCorporateActionProcessingFindingConstraint');
  assert.equal(vector.accepted.fixture.contract, 'CorporateActionProcessingFinding');
  assert.equal(vector.violation.expectedCode, 'processing-finding-evidence-digest');
});
