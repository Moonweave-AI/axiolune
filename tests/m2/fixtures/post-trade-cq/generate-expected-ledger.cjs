'use strict';

// Independent oracle: this file deliberately does not import the CQ runtime.
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SOURCE = path.join(
  ROOT,
  'tests', 'm2', 'fixtures', 'positive',
  'post-trade-closure-reconciliation.yaml',
);
const OUTPUT = path.join(__dirname, 'expected-ledger.json');
const source = yaml.load(fs.readFileSync(SOURCE, 'utf8'));
const byId = new Map(source.fixtures.map((entry) => [entry.id, entry.instance]));
const clone = (value) => structuredClone(value);
const utf8Sort = (values) => [...values].sort(
  (left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')),
);

function assessmentRows(instance) {
  return [{
    eventVersionIri: instance.event.versionIri,
    corporateActionKind: instance.event.kind,
    assessment: {
      evaluationInputVersionIri: instance.assessment.evaluationInputVersionIri,
      applicabilityVersionIri: instance.assessment.applicabilityVersionIri,
      scheduleRuleVersionIri: instance.assessment.scheduleRuleVersionIri,
      methodVersionIri: instance.assessment.methodVersionIri,
      inputKind: instance.assessment.inputKind,
      assessmentPercentage: instance.assessment.assessmentPercentage,
      priceKind: instance.assessment.priceKind,
      valuationPivot: instance.assessment.valuationPivot,
      priceObservation: clone(instance.assessment.priceObservation),
      inputVersionIris: clone(instance.assessment.inputVersionIris),
      inputVersionCount: instance.assessment.inputVersionCount,
      inputVersionSetDigest: instance.assessment.inputVersionSetDigest,
    },
  }];
}

function dueBillRows(instance) {
  return [{
    eventVersionIri: instance.event.versionIri,
    corporateActionKind: instance.event.kind,
    resolutionVersionIri: instance.resolution.versionIri,
    transferPitRequest: clone(instance.transferPitRequest),
    qualificationExecutionVersionIris: utf8Sort(
      instance.qualifications.map((entry) => entry.execution.versionIri),
    ),
    entitlements: instance.entitlements.map((entry) => ({
      account: entry.account,
      recordPosition: clone(entry.recordPosition),
      obligationVersionIris: clone(entry.obligationVersionIris),
      obligationCount: entry.obligationCount,
      obligationSetDigest: entry.obligationSetDigest,
      closureProbe: clone(entry.closureProbe),
      eligibleQuantity: entry.eligibleQuantity,
    })),
    obligations: instance.obligations.map((entry) => ({
      versionIri: entry.versionIri,
      liableAccount: entry.liableAccount,
      beneficiaryAccount: entry.beneficiaryAccount,
      liableParty: entry.liableParty,
      beneficiaryParty: entry.beneficiaryParty,
      sourceKind: entry.sourceKind,
      tradeQualificationVersionIri: entry.tradeQualificationVersionIri || null,
      externalClaimId: entry.externalClaimId || null,
      quantity: entry.quantity,
      benefit: clone(entry.benefit),
    })),
    transferClosures: instance.transferClosures.map((entry) => ({
      versionIri: entry.versionIri,
      obligationVersionIri: entry.obligationVersionIri,
      transferVersionIris: clone(entry.transferVersionIris),
      transferCount: entry.transferCount,
      transferSetDigest: entry.transferSetDigest,
      closureProbe: clone(entry.closureProbe),
      fulfilledAmount: entry.fulfilledAmount,
      remainingAmount: entry.remainingAmount,
      result: entry.result,
    })),
  }];
}

function rightsRows(instance) {
  return [{
    eventVersionIri: instance.event.versionIri,
    corporateActionKind: instance.event.kind,
    entitlement: clone(instance.entitlement),
    electionPitRequest: clone(instance.electionPitRequest),
    providerPolicyVersionIri: instance.providerPolicy.versionIri,
    providerMemberVersionIris: utf8Sort(
      instance.providerPolicy.providerMembers.map((entry) => entry.versionIri),
    ),
    precedenceEdgeVersionIris: utf8Sort(
      instance.providerPolicy.precedenceEdges.map((entry) => entry.versionIri),
    ),
    candidates: instance.electionCandidates.map((entry) => ({
      versionIri: entry.versionIri,
      providerLogicalIri: entry.providerLogicalIri,
      decision: entry.decision,
      electedQuantity: entry.electedQuantity || null,
    })),
    candidateVersionIris: clone(instance.candidateVersionIris),
    candidateCount: instance.candidateCount,
    candidateSetDigest: instance.candidateSetDigest,
    candidateClosureProbe: clone(instance.candidateClosureProbe),
    resolution: clone(instance.resolution),
    subscriptionObligation: clone(instance.subscriptionObligation),
    fulfillmentPitRequest: clone(instance.fulfillmentPitRequest),
    fulfillments: instance.fulfillments.map((entry) => ({
      versionIri: entry.versionIri,
      state: entry.state,
      assetKind: entry.assetKind,
      amount: entry.amount,
      currency: entry.currency || null,
      instrumentIri: entry.instrumentIri || null,
      unit: entry.unit || null,
      fromAccount: entry.fromAccount,
      toAccount: entry.toAccount,
      occurrenceTime: entry.occurrenceTime,
      movementEvidenceIri: entry.movementEvidenceIri,
      movementEvidenceDigest: entry.movementEvidenceDigest,
    })),
    fulfillmentClosure: clone(instance.fulfillmentClosure),
    adjustment: clone(instance.adjustment),
  }];
}

function finding(entry) {
  return {
    versionIri: entry.versionIri,
    keyId: entry.keyId,
    kind: entry.kind,
    internalProjectionVersionIris: clone(entry.internalProjectionVersionIris),
    externalStatementLineVersionIris: clone(entry.externalStatementLineVersionIris),
    internalCount: entry.internalCount,
    externalCount: entry.externalCount,
    missingSideAssertionVersionIri: entry.missingSideAssertionVersionIri || null,
    duplicateSide: entry.duplicateSide || null,
    internalDuplicateValueRelation: entry.internalDuplicateValueRelation || null,
    externalDuplicateValueRelation: entry.externalDuplicateValueRelation || null,
    crossSideValueRelation: entry.crossSideValueRelation || null,
    mismatchDimensions: clone(entry.mismatchDimensions || []),
    comparisonKeyDigest: entry.comparisonKeyDigest,
    evidenceSetDigest: entry.evidenceSetDigest,
    findingSubjectDigest: entry.findingSubjectDigest,
  };
}

function reconciliation(instance) {
  return {
    caseVersionIri: instance.case.versionIri,
    internalProjectionMode: instance.case.internalProjectionMode,
    focalAccount: instance.case.focalAccount,
    currentStatus: instance.case.currentStatus,
    pivots: {
      asOfValid: instance.case.reconciliationAsOfValid,
      asOfKnowledge: instance.case.reconciliationAsOfKnowledge,
      asOfAvailable: instance.case.reconciliationAsOfAvailable,
    },
    comparator: {
      versionIri: instance.comparator.versionIri,
      numericTolerance: instance.comparator.numericTolerance,
      implementationDigest: instance.comparator.implementationDigest,
      runtimeDigest: instance.comparator.runtimeDigest,
      inputContractDigest: instance.comparator.inputContractDigest,
      outputContractDigest: instance.comparator.outputContractDigest,
    },
    externalStatementVersionIri: instance.externalStatement.versionIri,
    comparisonKeys: instance.comparisonKeys.map((entry) => clone(entry)),
    internalProjections: instance.internalProjections.map((entry) => ({
      versionIri: entry.versionIri,
      keyId: entry.keyId,
      mode: entry.mode,
      legVersionIri: entry.legVersionIri,
      direction: entry.direction,
      allocationVersionIris: clone(entry.allocationVersionIris || []),
      bridgeVersionIris: clone(entry.bridgeVersionIris || []),
      internalSourceVersionSetDigest: entry.internalSourceVersionSetDigest,
      value: clone(entry.value),
    })),
    externalStatementLines: instance.externalStatementLines.map((entry) => ({
      versionIri: entry.versionIri,
      keyId: entry.keyId,
      authorityScopedId: entry.authorityScopedId,
      comparisonKeyDigest: entry.comparisonKeyDigest,
      value: clone(entry.value),
    })),
    missingSideAssertions: instance.missingSideAssertions.map((entry) => ({
      versionIri: entry.versionIri,
      keyId: entry.keyId,
      expectedSide: entry.expectedSide,
      comparisonKeyDigest: entry.comparisonKeyDigest,
      absenceProbeRef: entry.absenceProbeRef,
      absenceProbeDigest: entry.absenceProbeDigest,
    })),
    findings: instance.findings.map(finding),
    statusHistory: instance.statusEvents.map((entry) => ({
      versionIri: entry.versionIri,
      providerEventId: entry.providerEventId,
      sourceOrderKey: entry.sourceOrderKey,
      state: entry.state,
      observedAt: entry.observedAt,
      sourceArtifactRef: entry.sourceArtifactRef,
      sourceArtifactDigest: entry.sourceArtifactDigest,
    })),
  };
}

function settlementRows(settlement, reconciliationInstance, instructionVersionIri) {
  const instruction = settlement.instructions.find(
    (entry) => entry.versionIri === instructionVersionIri,
  );
  const allocations = settlement.allocations.filter(
    (entry) => entry.instructionVersionIri === instructionVersionIri,
  );
  return [{
    instructionVersionIri: instruction.versionIri,
    deliveryMode: instruction.method,
    atomicGroupId: instruction.atomicGroupId,
    system: instruction.system,
    location: instruction.location,
    legs: instruction.legs.map((entry) => clone(entry)),
    allocations: allocations.map((entry) => ({
      versionIri: entry.versionIri,
      securityLegVersionIri: entry.securityLegVersionIri,
      execution: {
        versionIri: entry.execution.versionIri,
        side: entry.execution.side,
        account: entry.execution.account,
        instrumentIri: entry.execution.instrumentIri,
        quantity: { value: entry.execution.quantity, unit: entry.quantity.unit },
      },
      quantity: clone(entry.quantity),
      fromEconomicAccount: entry.fromEconomicAccount,
      toEconomicAccount: entry.toEconomicAccount,
      fromMode: entry.fromMode,
      toMode: entry.toMode,
      fromBridgeVersionIri: entry.fromBridgeVersionIri || null,
      toBridgeVersionIri: entry.toBridgeVersionIri || null,
    })),
    settlementStatusHistory: instruction.statusEvents.map((entry) => clone(entry)),
    reconciliation: reconciliation(reconciliationInstance),
  }];
}

const settlement = byId.get('settlement-dvp-fop-direct-omnibus-allocation');
const ledger = {
  contract: 'axiolune-independent-post-trade-ledger/v1',
  derivedByRuntime: false,
  oracleMethod: 'independent static field selector over the canonical v0.3 contract fixture',
  authoringAuthority: 'codex-remediation-agent',
  reviewStatus: 'unapproved',
  cases: [
    {
      caseId: 'cq-pto1-cash-assessment-price-pit',
      cqId: 'CQ-PTO1',
      rows: assessmentRows(byId.get('distribution-assessment-price-kind-and-input-identity')),
    },
    {
      caseId: 'cq-pto1-stock-split-due-bill-correction-closure',
      cqId: 'CQ-PTO1',
      rows: dueBillRows(byId.get('due-bill-bilateral-empty-correction-partial-full')),
    },
    {
      caseId: 'cq-pto1-rights-election-subscription-adjustment',
      cqId: 'CQ-PTO1',
      rows: rightsRows(byId.get('rights-election-subscription-adjustment-chain')),
    },
    {
      caseId: 'cq-pto2-dvp-omnibus-economic-reconciliation',
      cqId: 'CQ-PTO2',
      rows: settlementRows(
        settlement,
        byId.get('economic-allocation-projection-and-closed-finding-matrix'),
        'https://example.test/fact/instruction/dvp/v1',
      ),
    },
    {
      caseId: 'cq-pto2-fop-direct-settlement-account-reconciliation',
      cqId: 'CQ-PTO2',
      rows: settlementRows(
        settlement,
        byId.get('settlement-account-security-cash-projection-and-status-history'),
        'https://example.test/fact/instruction/fop/v1',
      ),
    },
    {
      caseId: 'cq-pto1-before-assessment-availability-is-empty',
      cqId: 'CQ-PTO1',
      rows: [],
    },
    {
      caseId: 'cq-pto1-absent-event-version-is-empty',
      cqId: 'CQ-PTO1',
      rows: [],
    },
    {
      caseId: 'cq-pto2-before-case-availability-is-empty',
      cqId: 'CQ-PTO2',
      rows: [],
    },
  ],
};

fs.writeFileSync(OUTPUT, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
console.log(`generated ${path.relative(ROOT, OUTPUT).replaceAll('\\', '/')}`);
