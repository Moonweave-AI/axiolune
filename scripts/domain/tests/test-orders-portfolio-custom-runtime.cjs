'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  EVIDENCE_NAME,
  createEvidence,
  executeRequest,
  readStrictJcs,
  validateProfile,
  validateVectors,
  verifyClosure,
} = require('../run-orders-portfolio-custom-runtime.cjs');
const {
  PATHS,
  PENDING_VALIDATOR_EXECUTION,
  ROOT,
} = require('../lib/orders-portfolio-custom-profile.cjs');
const {
  encodeCanonicalOrdersPortfolioScenario,
} = require('../lib/orders-portfolio-canonical-record-adapter.cjs');
const {
  buildVerifierOwnedPitIngress,
  canonicalJcs,
  iriSetDigest,
  sha256DomainJcs,
  sha256Jcs,
} = require('../lib/orders-portfolio-custom-validators.cjs');

function clone(value) {
  return structuredClone(value);
}

test('runtime JCS uses RFC 8785 UTF-16 key ordering and strict I-JSON strings', () => {
  const astral = '\u{10000}';
  const bmpPrivateUse = '\uE000';
  assert.equal(
    canonicalJcs({ [bmpPrivateUse]: 1, [astral]: 2 }),
    `{"${astral}":2,"${bmpPrivateUse}":1}`,
  );
  assert.throws(() => canonicalJcs({ broken: '\uD800' }), /unpaired Unicode surrogate/u);
  assert.throws(() => canonicalJcs({ text: 'e\u0301' }), /Unicode NFC/u);
});

test('verifier-owned PIT ingress rejects incomplete or tampered closure evidence', () => {
  const vectors = readStrictJcs(PATHS.vectors).value;
  const executeTamper = (
    validatorId,
    artifactKind,
    mutate,
    predicate = () => true,
  ) => {
    const vector = vectors.vectors.find((row) => row.validatorId === validatorId);
    assert.ok(vector, `${validatorId} vector must exist`);
    const scenario = clone(vector.accepted.scenario);
    const proof = scenario.artifacts.find(
      (row) => row.payload?.artifactKind === artifactKind && predicate(row.payload),
    );
    assert.ok(proof, `${validatorId} must carry ${artifactKind}`);
    mutate(proof.payload);
    proof.artifactDigest = sha256Jcs(proof.payload);
    return executeRequest({
      constraintIri: vector.constraintIri,
      scenario,
      schemaVersion: '1.0',
      validatorId,
    }, { timeoutMs: 5_000 });
  };

  const missingSelectedVersion = executeTamper(
    'PortfolioAccountMembershipClosureContract',
    'SelectedFactVersionInventory',
    (payload) => {
      payload.selectedFactVersionIris.pop();
      payload.selectedFactVersionCount = payload.selectedFactVersionIris.length;
      payload.selectedFactVersionSetDigest = iriSetDigest(
        payload.selectedFactVersionIris,
      );
    },
  );
  assert.equal(missingSelectedVersion.status, 'completed');
  assert.equal(missingSelectedVersion.response.outcome, 'violation');
  assert.equal(
    missingSelectedVersion.response.violation,
    'MEMBERSHIP_CLOSURE_PIT_INVENTORY',
  );

  const tamperedSetDigest = executeTamper(
    'ExecutionLotAllocationClosureContract',
    'SelectedFactVersionInventory',
    (payload) => {
      payload.selectedFactVersionSetDigest = `sha256:${'0'.repeat(64)}`;
    },
  );
  assert.equal(tamperedSetDigest.status, 'completed');
  assert.equal(tamperedSetDigest.response.outcome, 'violation');
  assert.equal(
    tamperedSetDigest.response.violation,
    'EXECUTION_CLOSURE_PIT_INVENTORY',
  );

  const unfinishedRun = executeTamper(
    'PositionLotStateClosureContract',
    'MaterializationRunCompletion',
    (payload) => {
      payload.result.outcome = 'incomplete';
      payload.status = 'running';
    },
  );
  assert.equal(unfinishedRun.status, 'completed');
  assert.equal(unfinishedRun.response.outcome, 'violation');
  assert.equal(unfinishedRun.response.violation, 'LOT_STATE_PIT_RUN');

  const failedReport = executeTamper(
    'ExecutionLotAllocationClosureContract',
    'ValidationReport',
    (payload) => {
      payload.conforms = false;
      payload.status = 'failed';
    },
  );
  assert.equal(failedReport.status, 'completed');
  assert.equal(failedReport.response.outcome, 'violation');
  assert.equal(failedReport.response.violation, 'EXECUTION_CLOSURE_PIT_REPORT');

  const missingLedgerEntry = executeTamper(
    'PortfolioAccountMembershipClosureContract',
    'EvidenceLedger',
    (payload) => {
      payload.entries = payload.entries.filter(
        (row) => row.role !== 'validationReport',
      );
    },
  );
  assert.equal(missingLedgerEntry.status, 'completed');
  assert.equal(missingLedgerEntry.response.outcome, 'violation');
  assert.equal(
    missingLedgerEntry.response.violation,
    'MEMBERSHIP_CLOSURE_PIT_LEDGER',
  );

  const valuationOutputSubstitution = executeTamper(
    'PortfolioValuationContract',
    'MaterializedFactOutput',
    (payload) => {
      payload.outputRecord.valuationRunId = 'substituted-run';
      payload.outputRecordDigest = sha256Jcs(payload.outputRecord);
    },
  );
  assert.equal(valuationOutputSubstitution.status, 'completed');
  assert.equal(valuationOutputSubstitution.response.outcome, 'violation');
  assert.equal(
    valuationOutputSubstitution.response.violation,
    'PORTFOLIO_VALUATION_PIT_OUTPUT',
  );

  const valuationSelectionRequestSubstitution = executeTamper(
    'PortfolioValuationContract',
    'FactVersionSelectionRequest',
    (payload) => {
      payload.selectionBindings[0].factVersionIris[0] =
        'https://axiolune.ai/data/membership-closure/substituted/version/0';
      payload.selectionContractDigest = sha256DomainJcs(
        'axiolune-fact-version-selection-contract-v1',
        {
          outputFactTypeIri: payload.outputFactTypeIri,
          selectionBindings: payload.selectionBindings,
        },
      );
    },
  );
  assert.equal(valuationSelectionRequestSubstitution.status, 'completed');
  assert.equal(valuationSelectionRequestSubstitution.response.outcome, 'violation');
  assert.equal(
    valuationSelectionRequestSubstitution.response.violation,
    'PORTFOLIO_VALUATION_PIT_SELECTION_REQUEST',
  );

  const pnlSelectionSubstitution = executeTamper(
    'UnrealizedPnLObservationContract',
    'SelectedFactVersionInventory',
    (payload) => {
      payload.selectedFactVersionIris.pop();
      payload.selectedFactVersionCount = payload.selectedFactVersionIris.length;
      payload.selectedFactVersionSetDigest = iriSetDigest(
        payload.selectedFactVersionIris,
      );
    },
    (payload) => payload.pitRequestRef.endsWith('/pnl/valuation'),
  );
  assert.equal(pnlSelectionSubstitution.status, 'completed');
  assert.equal(pnlSelectionSubstitution.response.outcome, 'violation');
  assert.equal(
    pnlSelectionSubstitution.response.violation,
    'PNL_VALUATION_CONTEXT_INVENTORY',
  );

  const valuationRunSubstitution = executeTamper(
    'PortfolioValuationContract',
    'MaterializationRunCompletion',
    (payload) => {
      payload.result.outputRecordDigest = `sha256:${'0'.repeat(64)}`;
    },
    (payload) => payload.materializedOutputRef !== undefined,
  );
  assert.equal(valuationRunSubstitution.status, 'completed');
  assert.equal(valuationRunSubstitution.response.outcome, 'violation');
  assert.equal(
    valuationRunSubstitution.response.violation,
    'PORTFOLIO_VALUATION_PIT_RUN',
  );

  const pnlReportSubstitution = executeTamper(
    'UnrealizedPnLObservationContract',
    'ValidationReport',
    (payload) => {
      payload.materializedOutputDigest = `sha256:${'0'.repeat(64)}`;
    },
    (payload) => payload.materializedOutputRef !== undefined,
  );
  assert.equal(pnlReportSubstitution.status, 'completed');
  assert.equal(pnlReportSubstitution.response.outcome, 'violation');
  assert.equal(
    pnlReportSubstitution.response.violation,
    'PNL_VALUATION_CONTEXT_REPORT',
  );

  const pnlLedgerSubstitution = executeTamper(
    'UnrealizedPnLObservationContract',
    'EvidenceLedger',
    (payload) => {
      payload.entries = payload.entries.filter(
        (row) => row.role !== 'materializedFactOutput',
      );
    },
    (payload) => payload.entries.some((row) => row.role === 'materializedFactOutput'),
  );
  assert.equal(pnlLedgerSubstitution.status, 'completed');
  assert.equal(pnlLedgerSubstitution.response.outcome, 'violation');
  assert.equal(
    pnlLedgerSubstitution.response.violation,
    'PNL_VALUATION_CONTEXT_LEDGER',
  );

  const membershipVector = vectors.vectors.find(
    (row) => row.validatorId === 'PortfolioAccountMembershipClosureContract',
  );
  const missingIngressScenario = clone(membershipVector.accepted.scenario);
  const proofKinds = new Set([
    'EvidenceLedger',
    'MaterializationRunCompletion',
    'SelectedFactVersionInventory',
    'ValidationReport',
  ]);
  missingIngressScenario.artifacts = missingIngressScenario.artifacts.filter(
    (row) => !proofKinds.has(row.payload?.artifactKind),
  );
  const missingIngress = executeRequest({
    constraintIri: membershipVector.constraintIri,
    scenario: missingIngressScenario,
    schemaVersion: '1.0',
    validatorId: membershipVector.validatorId,
  });
  assert.equal(missingIngress.status, 'completed');
  assert.equal(missingIngress.response.outcome, 'violation');
  assert.equal(missingIngress.response.violation, 'MEMBERSHIP_CLOSURE_PIT_INGRESS');
});

test('valuation producers bind exact request, selected FactVersions, output, run, report, and ledger', () => {
  const vectors = readStrictJcs(PATHS.vectors).value;
  const expectedRoleTypes = {
    PortfolioValuationContract: {
      memberAccountClosure: 'PortfolioAccountMembershipClosure',
      memberMembership: 'PortfolioAccountMembership',
      valuationDefinition: 'ValuationCalculationDefinition',
      valuationQuotationContract: 'DirectUnitPriceQuotationContract',
    },
    UnrealizedPnLObservationContract: {
      costBasisDefinition: 'CostBasisCalculationDefinition',
      pnlLotStateClosure: 'PositionLotStateClosure',
      pnlValuation: 'PositionValuation',
      quotationContract: 'DirectUnitPriceQuotationContract',
      stateSnapshot: 'PositionSnapshot',
      valuationDefinition: 'ValuationCalculationDefinition',
      valuationHeader: 'PortfolioValuation',
      valuationPrice: 'PriceObservation',
      valuationQuotationContract: 'DirectUnitPriceQuotationContract',
    },
  };
  for (const validatorId of [
    'PortfolioValuationContract',
    'UnrealizedPnLObservationContract',
  ]) {
    const vector = vectors.vectors.find((row) => row.validatorId === validatorId);
    assert.ok(vector, `${validatorId} vector must exist`);
    const scenario = vector.accepted.scenario;
    const focus = scenario.records.find(
      (row) => row.versionIri === scenario.focusVersionIri,
    );
    const selectionRequest = scenario.artifacts.find(
      (row) => row.payload?.artifactKind === 'FactVersionSelectionRequest',
    );
    const inventory = scenario.artifacts.find(
      (row) => row.payload?.artifactKind === 'SelectedFactVersionInventory'
        && row.payload.selectionRequestRef === selectionRequest?.artifactRef.iri,
    );
    const output = scenario.artifacts.find(
      (row) => row.payload?.artifactKind === 'MaterializedFactOutput',
    );
    const run = scenario.artifacts.find(
      (row) => row.payload?.artifactKind === 'MaterializationRunCompletion'
        && row.payload.materializedOutputRef === output?.artifactRef.iri,
    );
    const report = scenario.artifacts.find(
      (row) => row.payload?.artifactKind === 'ValidationReport'
        && row.payload.materializedOutputRef === output?.artifactRef.iri,
    );
    const ledger = scenario.artifacts.find(
      (row) => row.payload?.artifactKind === 'EvidenceLedger'
        && row.payload.entries?.some((entry) => (
          entry.role === 'materializedFactOutput'
            && entry.artifactRef === output?.artifactRef.iri
        )),
    );
    assert.ok(
      inventory && selectionRequest && output && run && report && ledger,
      `${validatorId} PIT closure`,
    );
    assert.ok(inventory.payload.selectedFactVersionIris.length > 0);
    assert.deepEqual(
      inventory.payload.selectedFactVersionIris,
      [...inventory.payload.selectedFactVersionIris].sort(
        (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    );
    assert.equal(
      inventory.payload.selectedFactVersionSetDigest,
      iriSetDigest(inventory.payload.selectedFactVersionIris),
    );
    const boundVersions = [...new Set(
      selectionRequest.payload.selectionBindings.flatMap(
        (binding) => binding.factVersionIris,
      ),
    )].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    assert.deepEqual(boundVersions, inventory.payload.selectedFactVersionIris);
    assert.equal(
      selectionRequest.payload.selectionContractDigest,
      sha256DomainJcs(
        'axiolune-fact-version-selection-contract-v1',
        {
          outputFactTypeIri: selectionRequest.payload.outputFactTypeIri,
          selectionBindings: selectionRequest.payload.selectionBindings,
        },
      ),
    );
    assert.equal(
      inventory.payload.selectionRequestDigest,
      selectionRequest.artifactDigest,
    );
    assert.equal(
      inventory.payload.selectionRequestRef,
      selectionRequest.artifactRef.iri,
    );
    assert.deepEqual(
      selectionRequest.payload.selectionBindings.map((binding) => binding.role),
      Object.keys(expectedRoleTypes[validatorId]).sort(),
      `${validatorId} selection roles must exactly cover its producer dependencies`,
    );
    for (const binding of selectionRequest.payload.selectionBindings) {
      for (const versionIri of binding.factVersionIris) {
        const selectedRecord = scenario.records.find(
          (record) => record.versionIri === versionIri,
        );
        assert.ok(selectedRecord, `${binding.role} ${versionIri} must resolve`);
        assert.ok(
          selectedRecord.typeIri.endsWith(`/${expectedRoleTypes[validatorId][binding.role]}`),
          `${binding.role} must select ${expectedRoleTypes[validatorId][binding.role]}`,
        );
      }
    }
    assert.equal(
      selectionRequest.payload.asOfAvailable,
      scenario.artifacts.find(
        (row) => row.artifactRef.iri === selectionRequest.payload.pitRequestRef,
      ).payload.availableAt,
    );
    assert.ok(
      Date.parse(run.payload.completedAt) < Date.parse(focus.availableFrom),
      `${validatorId} producer completion must precede output availability`,
    );
    assert.deepEqual(output.payload.outputRecord, focus);
    assert.equal(output.payload.outputRecordDigest, sha256Jcs(focus));
    assert.equal(run.payload.status, 'completed');
    assert.equal(run.payload.materializedOutputDigest, output.artifactDigest);
    assert.equal(report.payload.status, 'passed');
    assert.equal(report.payload.conforms, true);
    assert.equal(report.payload.materializationRunDigest, run.artifactDigest);
    assert.equal(
      ledger.payload.entries.find((entry) => entry.role === 'validationReport')
        ?.artifactDigest,
      report.artifactDigest,
    );
  }

  const pnlVector = vectors.vectors.find(
    (row) => row.validatorId === 'UnrealizedPnLObservationContract',
  );
  const outputSubstitution = clone(pnlVector.accepted.scenario);
  const outputFocus = outputSubstitution.records.find(
    (row) => row.versionIri === outputSubstitution.focusVersionIri,
  );
  outputFocus.unrealizedPnl.amount = '0.000399';
  const outputResult = executeRequest({
    constraintIri: pnlVector.constraintIri,
    scenario: outputSubstitution,
    schemaVersion: '1.0',
    validatorId: pnlVector.validatorId,
  });
  assert.equal(outputResult.status, 'completed');
  assert.equal(outputResult.response.outcome, 'violation');
  assert.equal(
    outputResult.response.violation,
    'PNL_VALUATION_CONTEXT_OUTPUT',
  );

  const coherentlyResealed = clone(pnlVector.accepted.scenario);
  const resealedFocus = coherentlyResealed.records.find(
    (row) => row.versionIri === coherentlyResealed.focusVersionIri,
  );
  resealedFocus.unrealizedPnl.amount = '0.000399';
  const resealedSelection = coherentlyResealed.artifacts.find(
    (row) => row.payload?.artifactKind === 'FactVersionSelectionRequest'
      && row.payload.outputFactTypeIri.endsWith('/UnrealizedPnLObservation'),
  );
  const resealedInventory = coherentlyResealed.artifacts.find(
    (row) => row.payload?.artifactKind === 'SelectedFactVersionInventory'
      && row.payload.selectionRequestRef === resealedSelection.artifactRef.iri,
  );
  const resealedPitArtifact = coherentlyResealed.artifacts.find(
    (row) => row.artifactRef.iri === resealedSelection.payload.pitRequestRef,
  );
  const rebuilt = buildVerifierOwnedPitIngress(
    {
      digest: resealedPitArtifact.artifactDigest,
      payload: clone(resealedPitArtifact.payload),
      ref: resealedPitArtifact.artifactRef.iri,
    },
    clone(resealedInventory.payload.selectedFactVersionIris),
    {
      outputFactTypeIri: resealedFocus.typeIri,
      outputFactVersionIri: resealedFocus.versionIri,
      outputRecord: clone(resealedFocus),
      selectionBindings: clone(resealedSelection.payload.selectionBindings),
    },
  );
  const rebuiltByRef = new Map([
    rebuilt.selectionRequest,
    rebuilt.selectedFactVersionInventory,
    rebuilt.materializedOutput,
    rebuilt.materializationRun,
    rebuilt.validationReport,
    rebuilt.evidenceLedger,
  ].map((proof) => [proof.ref, proof]));
  for (const artifactRow of coherentlyResealed.artifacts) {
    const proof = rebuiltByRef.get(artifactRow.artifactRef.iri);
    if (!proof) continue;
    artifactRow.artifactDigest = proof.digest;
    artifactRow.payload = clone(proof.payload);
  }
  const coherentlyResealedResult = executeRequest({
    constraintIri: pnlVector.constraintIri,
    scenario: coherentlyResealed,
    schemaVersion: '1.0',
    validatorId: pnlVector.validatorId,
  });
  assert.equal(coherentlyResealedResult.status, 'completed');
  assert.equal(coherentlyResealedResult.response.outcome, 'violation');
  assert.equal(coherentlyResealedResult.response.violation, 'PNL_EQUATION');

  const roleResealed = clone(pnlVector.accepted.scenario);
  const roleFocus = roleResealed.records.find(
    (row) => row.versionIri === roleResealed.focusVersionIri,
  );
  const roleSelection = roleResealed.artifacts.find(
    (row) => row.payload?.artifactKind === 'FactVersionSelectionRequest'
      && row.payload.outputFactTypeIri.endsWith('/UnrealizedPnLObservation'),
  );
  const roleInventory = roleResealed.artifacts.find(
    (row) => row.payload?.artifactKind === 'SelectedFactVersionInventory'
      && row.payload.selectionRequestRef === roleSelection.artifactRef.iri,
  );
  const forgedBindings = clone(roleSelection.payload.selectionBindings);
  const valuationPriceBinding = forgedBindings.find(
    (binding) => binding.role === 'valuationPrice',
  );
  const quotationBinding = forgedBindings.find(
    (binding) => binding.role === 'quotationContract',
  );
  quotationBinding.factVersionIris.push(...valuationPriceBinding.factVersionIris);
  quotationBinding.factVersionIris.sort(
    (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  forgedBindings.splice(forgedBindings.indexOf(valuationPriceBinding), 1);
  const rolePitArtifact = roleResealed.artifacts.find(
    (row) => row.artifactRef.iri === roleSelection.payload.pitRequestRef,
  );
  const roleRebuilt = buildVerifierOwnedPitIngress(
    {
      digest: rolePitArtifact.artifactDigest,
      payload: clone(rolePitArtifact.payload),
      ref: rolePitArtifact.artifactRef.iri,
    },
    clone(roleInventory.payload.selectedFactVersionIris),
    {
      outputFactTypeIri: roleFocus.typeIri,
      outputFactVersionIri: roleFocus.versionIri,
      outputRecord: clone(roleFocus),
      selectionBindings: forgedBindings,
    },
  );
  const roleProofByRef = new Map([
    roleRebuilt.selectionRequest,
    roleRebuilt.selectedFactVersionInventory,
    roleRebuilt.materializedOutput,
    roleRebuilt.materializationRun,
    roleRebuilt.validationReport,
    roleRebuilt.evidenceLedger,
  ].map((proof) => [proof.ref, proof]));
  for (const artifactRow of roleResealed.artifacts) {
    const proof = roleProofByRef.get(artifactRow.artifactRef.iri);
    if (!proof) continue;
    artifactRow.artifactDigest = proof.digest;
    artifactRow.payload = clone(proof.payload);
  }
  const roleResealedResult = executeRequest({
    constraintIri: pnlVector.constraintIri,
    scenario: roleResealed,
    schemaVersion: '1.0',
    validatorId: pnlVector.validatorId,
  });
  assert.equal(roleResealedResult.status, 'completed');
  assert.equal(roleResealedResult.response.outcome, 'violation');
  assert.equal(
    roleResealedResult.response.violation,
    'PNL_VALUATION_CONTEXT_INVENTORY',
  );

  const requestSubstitution = clone(pnlVector.accepted.scenario);
  const valuationHeader = requestSubstitution.records.find(
    (row) => row.typeIri.endsWith('/PortfolioValuation'),
  );
  const requestArtifact = requestSubstitution.artifacts.find(
    (row) => row.artifactRef.iri === valuationHeader.pitRequestRef,
  );
  requestArtifact.payload.requestId = 'substituted-request';
  requestArtifact.artifactDigest = sha256Jcs(requestArtifact.payload);
  valuationHeader.pitRequestRecordDigest = requestArtifact.artifactDigest;
  const requestResult = executeRequest({
    constraintIri: pnlVector.constraintIri,
    scenario: requestSubstitution,
    schemaVersion: '1.0',
    validatorId: pnlVector.validatorId,
  });
  assert.equal(requestResult.status, 'completed');
  assert.equal(requestResult.response.outcome, 'violation');
  assert.equal(
    requestResult.response.violation,
    'PNL_VALUATION_CONTEXT_INVENTORY',
  );

  const missingOutput = clone(pnlVector.accepted.scenario);
  missingOutput.artifacts = missingOutput.artifacts.filter(
    (row) => row.payload?.artifactKind !== 'MaterializedFactOutput',
  );
  const missingOutputResult = executeRequest({
    constraintIri: pnlVector.constraintIri,
    scenario: missingOutput,
    schemaVersion: '1.0',
    validatorId: pnlVector.validatorId,
  });
  assert.equal(missingOutputResult.status, 'completed');
  assert.equal(missingOutputResult.response.outcome, 'violation');
  assert.equal(
    missingOutputResult.response.violation,
    'PNL_VALUATION_CONTEXT_INGRESS',
  );

  const valuationVector = vectors.vectors.find(
    (row) => row.validatorId === 'PortfolioValuationContract',
  );
  const lateValuationInput = clone(valuationVector.accepted.scenario);
  const lateValuationSelection = lateValuationInput.artifacts.find(
    (row) => row.payload?.artifactKind === 'FactVersionSelectionRequest'
      && row.payload.outputFactTypeIri.endsWith('/PortfolioValuation'),
  );
  const lateQuotationVersion = lateValuationSelection.payload.selectionBindings.find(
    (binding) => binding.role === 'valuationQuotationContract',
  ).factVersionIris[0];
  lateValuationInput.records.find(
    (record) => record.versionIri === lateQuotationVersion,
  ).availableFrom = '2025-01-01T00:00:02.500000000Z';
  const lateValuationResult = executeRequest({
    constraintIri: valuationVector.constraintIri,
    scenario: lateValuationInput,
    schemaVersion: '1.0',
    validatorId: valuationVector.validatorId,
  });
  assert.equal(lateValuationResult.status, 'completed');
  assert.equal(lateValuationResult.response.outcome, 'violation');
  assert.equal(
    lateValuationResult.response.violation,
    'PORTFOLIO_VALUATION_PIT_ELIGIBILITY',
  );

  const latePnlInput = clone(pnlVector.accepted.scenario);
  const latePnlSelection = latePnlInput.artifacts.find(
    (row) => row.payload?.artifactKind === 'FactVersionSelectionRequest'
      && row.payload.outputFactTypeIri.endsWith('/UnrealizedPnLObservation'),
  );
  const lateSnapshotVersion = latePnlSelection.payload.selectionBindings.find(
    (binding) => binding.role === 'stateSnapshot',
  ).factVersionIris[0];
  latePnlInput.records.find(
    (record) => record.versionIri === lateSnapshotVersion,
  ).availableFrom = '2025-01-01T00:00:02.500000000Z';
  const latePnlResult = executeRequest({
    constraintIri: pnlVector.constraintIri,
    scenario: latePnlInput,
    schemaVersion: '1.0',
    validatorId: pnlVector.validatorId,
  });
  assert.equal(latePnlResult.status, 'completed');
  assert.equal(latePnlResult.response.outcome, 'violation');
  assert.equal(
    latePnlResult.response.violation,
    'PNL_VALUATION_CONTEXT_ELIGIBILITY',
  );
});

test('valuation producer derives outputs from selected records instead of caller output claims', () => {
  const inputTemporal = {
    availableFrom: '2025-01-01T00:00:02Z',
    knowledgeFrom: '2025-01-01T00:00:01Z',
    revision: 0,
    validFrom: '2025-01-01T00:00:00Z',
  };
  const outputTemporal = {
    availableFrom: '2025-01-01T00:00:03Z',
    knowledgeFrom: '2025-01-01T00:00:02Z',
    revision: 0,
    validFrom: '2025-01-01T00:00:00Z',
  };
  assert.throws(
    () => encodeCanonicalOrdersPortfolioScenario('PortfolioValuationContract', {
      inputTemporal,
      memberClosurePortfolioIri: 'https://axiolune.ai/data/portfolio/other',
      reportingCurrency: 'USD',
      temporal: outputTemporal,
      valuationDefinition: {
        versionIri: 'https://axiolune.ai/data/valuation-definition/1/version/0',
      },
      valuationRunId: 'valuation-run-1',
      valuedPortfolio: {
        logicalIri: 'https://axiolune.ai/data/portfolio/1',
        referenceMode: 'logical',
      },
    }),
    (error) => error?.code === 'orders-portfolio-pit-producer-join',
  );

  const callerClaim = encodeCanonicalOrdersPortfolioScenario(
    'UnrealizedPnLObservationContract',
    {
      closedSnapshotVersionIri: 'https://axiolune.ai/data/position/1/version/0',
      currency: 'USD',
      inputTemporal,
      lotState: {
        logicalIri: 'https://axiolune.ai/data/lot-state/1',
        referenceMode: 'version',
        versionIri: 'https://axiolune.ai/data/lot-state/1/version/0',
      },
      marketValueCurrency: 'USD',
      marketValueMicros: 1_000,
      remainingCostBasisCurrency: 'USD',
      remainingCostBasisMicros: 600,
      temporal: outputTemporal,
      unrealizedPnlMicros: 399,
      valuation: {
        logicalIri: 'https://axiolune.ai/data/valuation/1',
        referenceMode: 'version',
        versionIri: 'https://axiolune.ai/data/valuation/1/version/0',
      },
      valuationSnapshotVersionIri: 'https://axiolune.ai/data/position/1/version/0',
    },
  );
  const callerFocus = callerClaim.records.find(
    (record) => record.versionIri === callerClaim.focusVersionIri,
  );
  const producerOutput = callerClaim.artifacts.find(
    (row) => row.payload?.artifactKind === 'MaterializedFactOutput'
      && row.payload.outputFactTypeIri.endsWith('/UnrealizedPnLObservation'),
  );
  assert.equal(callerFocus.unrealizedPnl.amount, '0.000399');
  assert.equal(producerOutput.payload.outputRecord.unrealizedPnl.amount, '0.000400');
  assert.equal(
    producerOutput.payload.outputRecordDigest,
    sha256Jcs(producerOutput.payload.outputRecord),
  );
});

test('restricted runtime passes all executable vectors including verifier-owned reconciliation projection', (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-op-custom-test-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [PATHS.runner, '--output-dir', output], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
    timeout: 180000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /PASS \(constraints=35, vectors=262\)/u);
  const bytes = fs.readFileSync(path.join(output, EVIDENCE_NAME));
  const evidence = JSON.parse(bytes.toString('utf8'));
  assert.ok(bytes.equals(Buffer.from(canonicalJcs(evidence), 'utf8')));
  assert.equal(evidence.outcome, 'passed');
  assert.equal(evidence.componentEligible, true);
  assert.deepEqual(evidence.pending, {
    codes: [],
    constraintIris: [],
    requirements: [],
    resultCount: 0,
  });
  assert.equal(evidence.discoveredConstraints.length, 35);
  assert.equal(evidence.vectorResults.length, 262);
  assert.equal(evidence.vectorResults.filter((row) => row.status === 'pending').length, 0);
  assert.equal(evidence.vectorResults.filter((row) => row.status === 'passed').length, 262);
  assert.ok(evidence.vectorResults.every((row) => row.status === 'passed'));
  assert.equal(
    evidence.vectorResults.filter(
      (row) => row.validatorId
        === 'PortfolioPositionReconciliationFindingContract',
    ).length,
    42,
  );
  for (const row of evidence.discoveredConstraints) {
    const vectors = evidence.vectorResults.filter((vector) => (
      vector.constraintIri === row.constraintIri && ['accepted', 'violation'].includes(vector.category)
    ));
    assert.deepEqual(new Set(vectors.map((vector) => vector.category)), new Set(['accepted', 'violation']));
    assert.equal(typeof row.targetElement, 'string');
    assert.match(row.expressionDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.match(row.dispatchDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.match(row.implementationDigest, /^sha256:[0-9a-f]{64}$/u);
  }
  assert.deepEqual(
    new Map(evidence.vectorResults.filter((row) => row.category === 'engineFailure').map((row) => [row.caseId, row.actual])),
    new Map([
      ['timeout', 'TIME_LIMIT'], ['oversize-input', 'INPUT_LIMIT'], ['oversize-output-cap', 'OUTPUT_LIMIT'],
    ]),
  );
  assert.deepEqual(
    new Map(evidence.vectorResults.filter((row) => row.category === 'dispatchAttribution').map((row) => [row.caseId, row.actual])),
    new Map([['unbound-constraint', 'WORKER_EXIT'], ['binding-tamper', 'WORKER_EXIT']]),
  );
  assert.deepEqual(
    new Map(evidence.vectorResults.filter((row) => row.category === 'inputContract').map((row) => [row.caseId, row.actual])),
    new Map([
      ['legacy-private-scenario', 'WORKER_EXIT'],
      ['unknown-private-field', 'WORKER_EXIT'],
      ['missing-official-required-field', 'WORKER_EXIT'],
      ['wrong-reference-mode', 'WORKER_EXIT'],
      ['wrong-role-target-type', 'WORKER_EXIT'],
      ['malformed-structured-value', 'WORKER_EXIT'],
      ['invalid-calendar-instant', 'WORKER_EXIT'],
    ]),
  );
  assert.deepEqual(
    new Map(evidence.vectorResults.filter((row) => row.category === 'semanticBoundary').map((row) => [row.caseId, row.actual])),
    new Map([
      ['sub-micro-half-even', 'accepted'],
      ['former-million-times-result', 'POSITION_VALUATION_ARITHMETIC'],
      ['bigint-high-intermediate', 'accepted'],
      ['half-even-tie', 'accepted'],
      ['half-up-policy-replay', 'POSITION_VALUATION_ARITHMETIC'],
      ['fx-base-to-quote', 'accepted'],
      ['fx-quote-to-base', 'accepted'],
      ['fx-input-substitution', 'POSITION_VALUATION_FX'],
      ['fx-rate-substitution', 'POSITION_VALUATION_ARITHMETIC'],
      ['fx-rate-unit-substitution', 'POSITION_VALUATION_FX'],
      ['fx-reverse-link', 'POSITION_VALUATION_FX'],
      ['fx-future-rate', 'POSITION_VALUATION_FX'],
      ['fx-nanosecond-future-rate', 'POSITION_VALUATION_FX'],
      ['fx-nanosecond-prior-rate', 'accepted'],
      ['fx-late-input-context', 'POSITION_VALUATION_FX'],
      ['fx-nanosecond-late-input-context', 'POSITION_VALUATION_FX'],
      ['definition-quotation-plural-second-member', 'accepted'],
      ['definition-quotation-substitution', 'POSITION_VALUATION_DEFINITION'],
      ['policy-payload-digest-tamper', 'WORKER_EXIT'],
      ['valuation-quotation-instrument-substitution', 'POSITION_VALUATION_JOIN'],
      ['valuation-listing-instrument-substitution', 'POSITION_VALUATION_JOIN'],
      ['valuation-quotation-context-substitution', 'POSITION_VALUATION_JOIN'],
      ['valuation-membership-account-substitution', 'POSITION_VALUATION_JOIN'],
      ['valuation-otc-context', 'accepted'],
      ['valuation-definition-quotation-plural', 'accepted'],
      ['valuation-definition-quotation-count-mismatch', 'VALUATION_DEFINITION_QUOTATION_SET'],
      ['valuation-definition-quotation-digest-mismatch', 'VALUATION_DEFINITION_QUOTATION_SET'],
      ['valuation-definition-quotation-unsorted', 'VALUATION_DEFINITION_QUOTATION_SET'],
      ['valuation-definition-quotation-duplicate', 'VALUATION_DEFINITION_QUOTATION_SET'],
      ['valuation-definition-quotation-empty', 'WORKER_EXIT'],
      ['valuation-definition-quotation-logical-member', 'WORKER_EXIT'],
      ['integrity-duplicate-conflict', 'accepted'],
      ['integrity-sequence-gap', 'accepted'],
      ['integrity-out-of-order', 'accepted'],
      ['integrity-late-fill', 'accepted'],
      ['integrity-missing-acknowledgement', 'accepted'],
      ['integrity-transition-violation', 'accepted'],
      ['integrity-affected-digest-substitution', 'FINDING_AFFECTED_DIGEST'],
      ['integrity-mixed-branch-fields', 'FINDING_SEQUENCE_GAP'],
      ['integrity-related-set-digest-substitution', 'FINDING_RELATED_DIGEST'],
      ['integrity-identical-retry-not-conflict', 'FINDING_DUPLICATE_CONFLICT'],
      ['integrity-profile-allows-transition', 'FINDING_TRANSITION_VIOLATION'],
      ['membership-closure-omitted-eligible-member', 'MEMBERSHIP_CLOSURE_COMPLETENESS'],
      ['membership-closure-future-member-not-eligible', 'accepted'],
      ['membership-closure-probe-semantic-substitution', 'MEMBERSHIP_CLOSURE_PROBE'],
      ['membership-closure-late-input-context', 'MEMBERSHIP_CLOSURE_INPUT'],
      ['membership-closure-future-pit-pivot', 'MEMBERSHIP_CLOSURE_PIT'],
      ['portfolio-valuation-input-digest-without-bytes', 'WORKER_EXIT'],
      ['portfolio-valuation-late-input-context', 'PORTFOLIO_VALUATION_INPUT_CONTEXT'],
      ['portfolio-valuation-late-conversion-context', 'PORTFOLIO_VALUATION_CONVERSION_CONTEXT'],
      ['portfolio-valuation-future-pit-pivot', 'PORTFOLIO_VALUATION_PIT'],
      ['portfolio-valuation-closure-portfolio-substitution', 'PORTFOLIO_VALUATION_CLOSURE'],
      ['portfolio-valuation-closure-omitted-member', 'MEMBERSHIP_CLOSURE_COMPLETENESS'],
      ['portfolio-valuation-formula-semantic-substitution', 'VALUATION_DEFINITION_ARTIFACT'],
      ['portfolio-valuation-empty-run-id', 'PORTFOLIO_VALUATION_CONTEXT'],
      ['valuation-definition-formula-digest-without-bytes', 'WORKER_EXIT'],
      ['cost-basis-implementation-digest-without-bytes', 'WORKER_EXIT'],
      ['cost-basis-implementation-semantic-substitution', 'COST_BASIS_ARTIFACT'],
      ['fx-conversion-reversed-rate-unit', 'FX_CONVERSION_RATE_UNIT'],
      ['lot-allocation-lot-instrument-substitution', 'LOT_ALLOCATION_JOIN'],
      ['lot-allocation-execution-instrument-substitution', 'LOT_ALLOCATION_JOIN'],
      ['lot-allocation-definition-substitution', 'LOT_ALLOCATION_JOIN'],
      ['lot-allocation-listing-instrument-substitution', 'LOT_ALLOCATION_JOIN'],
      ['lot-allocation-unit-substitution', 'LOT_ALLOCATION_JOIN'],
      ['fee-allocation-cross-basis-without-fx', 'FEE_ALLOCATION_FX'],
      ['fee-allocation-closure-count-substitution', 'FEE_ALLOCATION_CLOSURE'],
      ['fee-allocation-closure-fee-omission', 'FEE_ALLOCATION_JOIN'],
      ['fee-allocation-execution-substitution', 'FEE_ALLOCATION_JOIN'],
      ['fee-allocation-definition-substitution', 'FEE_ALLOCATION_JOIN'],
      ['fee-allocation-cross-basis-fx', 'accepted'],
      ['fee-allocation-reversed-fx-unit', 'FEE_ALLOCATION_FX'],
      ['execution-closure-extra-eligible-lot', 'EXECUTION_CLOSURE_ELIGIBLE'],
      ['execution-closure-extra-allocation', 'EXECUTION_CLOSURE_ALLOCATION'],
      ['execution-closure-extra-fee', 'EXECUTION_CLOSURE_FEE'],
      ['execution-closure-extra-fee-allocation', 'EXECUTION_CLOSURE_FEE'],
      ['execution-closure-selection-probe-substitution', 'EXECUTION_CLOSURE_PROBE'],
      ['execution-closure-late-input-context', 'EXECUTION_CLOSURE_INPUT'],
      ['execution-closure-future-pit', 'EXECUTION_CLOSURE_PIT'],
      ['execution-closure-definition-substitution', 'EXECUTION_CLOSURE_DEFINITION'],
      ['execution-closure-fifo-skip', 'EXECUTION_CLOSURE_SELECTION'],
      ['execution-closure-fee-conservation', 'EXECUTION_CLOSURE_FEE'],
      ['execution-closure-fee-definition-substitution', 'EXECUTION_CLOSURE_FEE'],
      ['execution-closure-allocation-context-substitution', 'EXECUTION_CLOSURE_ALLOCATION'],
      ['lot-state-extra-open-lot', 'LOT_STATE_SET'],
      ['lot-state-extra-allocation', 'LOT_STATE_ALLOCATION_SET'],
      ['lot-state-extra-execution-closure', 'LOT_STATE_EXECUTION_SET'],
      ['lot-state-instrument-substitution', 'LOT_STATE_JOIN'],
      ['lot-state-allocation-definition-substitution', 'LOT_STATE_ALLOCATION_SET'],
      ['lot-state-external-snapshot', 'LOT_STATE_IDENTITY'],
      ['lot-state-zero-lot-retained', 'LOT_STATE_SET'],
      ['lot-state-probe-substitution', 'LOT_STATE_PROBE'],
      ['lot-state-late-input-context', 'LOT_STATE_INPUT'],
      ['lot-state-future-pit', 'LOT_STATE_PIT'],
      ['lot-state-definition-substitution', 'LOT_STATE_POLICY'],
      ['lot-state-snapshot-quantity-substitution', 'LOT_STATE_REMAINING'],
      ['lot-state-execution-digest-substitution', 'LOT_STATE_EXECUTION_SET'],
      ['lot-state-opening-quantity-substitution', 'LOT_STATE_JOIN'],
      ['lot-state-quotation-substitution', 'LOT_STATE_JOIN'],
      ['pnl-snapshot-substitution', 'PNL_JOIN'],
      ['pnl-definition-substitution', 'PNL_VALUATION_CONTEXT_INVENTORY'],
      ['pnl-quotation-substitution', 'PNL_VALUATION_CONTEXT_INVENTORY'],
      ['pnl-calculation-context-substitution', 'PNL_VALUATION_CONTEXT_OUTPUT'],
      ['pnl-generating-run-substitution', 'PNL_VALUATION_CONTEXT_OUTPUT'],
      ['pnl-open-lot-digest-substitution', 'PNL_VALUATION_CONTEXT_OUTPUT'],
      ['pnl-allocation-digest-substitution', 'PNL_VALUATION_CONTEXT_OUTPUT'],
      ['pnl-valuation-value-substitution', 'PNL_VALUE_JOIN'],
      ['pnl-state-basis-substitution', 'PNL_VALUE_JOIN'],
      ['pnl-late-conversion-context', 'PNL_CONVERSION_CONTEXT'],
      ['pnl-late-valuation-input', 'PNL_VALUATION_CONTEXT'],
      ['pnl-future-valuation-pit', 'PNL_VALUATION_CONTEXT'],
      ['pnl-currency-substitution', 'PNL_VALUATION_CONTEXT_OUTPUT'],
      ['pnl-future-state', 'PNL_PIT'],
      ['pnl-definition-quotation-substitution', 'PNL_VALUATION_CONTEXT_INVENTORY'],
      ['pnl-price-quotation-substitution', 'PNL_JOIN'],
      ['pnl-conversion-header-substitution', 'PNL_CONVERSION_CONTEXT'],
      ['opening-allocation-duplicate', 'OPENING_ALLOCATION_XONE'],
      ['opening-allocation-definition-substitution', 'OPENING_ALLOCATION_JOIN'],
      ['opening-allocation-context-substitution', 'OPENING_ALLOCATION_JOIN'],
      ['opening-allocation-unit-substitution', 'OPENING_ALLOCATION_JOIN'],
      ['opening-allocation-execution-substitution', 'OPENING_ALLOCATION_JOIN'],
      ['opening-allocation-instrument-substitution', 'OPENING_ALLOCATION_JOIN'],
      ['opening-allocation-listing-substitution', 'OPENING_ALLOCATION_JOIN'],
      ['opening-allocation-quotation-substitution', 'OPENING_ALLOCATION_JOIN'],
      ['opening-allocation-side-substitution', 'OPENING_ALLOCATION_JOIN'],
      ['opening-allocation-future', 'OPENING_ALLOCATION_JOIN'],
      ['reconciliation-quantity-mismatch', 'accepted'],
      ['reconciliation-signed-external-position', 'accepted'],
      ['reconciliation-missing-external-quantity', 'RECONCILIATION_ABSENCE_UNPROVEN'],
      ['reconciliation-missing-derived-quantity', 'RECONCILIATION_ABSENCE_UNPROVEN'],
      ['reconciliation-basis-match', 'accepted'],
      ['reconciliation-basis-mismatch', 'accepted'],
      ['reconciliation-basis-definition-substitution', 'RECONCILIATION_BASIS_DEFINITION'],
      ['reconciliation-missing-external-basis', 'RECONCILIATION_ABSENCE_UNPROVEN'],
      ['reconciliation-missing-derived-basis', 'RECONCILIATION_ABSENCE_UNPROVEN'],
      ['reconciliation-external-snapshot-type-conflict', 'RECONCILIATION_BRANCH'],
      ['reconciliation-subject-digest-substitution', 'RECONCILIATION_SUBJECT_DIGEST'],
      ['reconciliation-account-substitution', 'RECONCILIATION_CANDIDATE_GRAPH'],
      ['reconciliation-instrument-substitution', 'RECONCILIATION_CANDIDATE_GRAPH'],
      ['reconciliation-listing-substitution', 'RECONCILIATION_CANDIDATE_GRAPH'],
      ['reconciliation-unit-substitution', 'RECONCILIATION_CANDIDATE_GRAPH'],
      ['reconciliation-external-source-substitution', 'RECONCILIATION_SOURCE_KIND'],
      ['reconciliation-future-external-input', 'RECONCILIATION_CANDIDATE_GRAPH'],
      ['reconciliation-future-pit-request', 'RECONCILIATION_PIT'],
      ['reconciliation-context-semantic-substitution', 'RECONCILIATION_CONTEXT'],
      ['reconciliation-late-context', 'RECONCILIATION_CONTEXT'],
      ['reconciliation-generating-run-substitution', 'RECONCILIATION_CONTEXT'],
      ['reconciliation-kind-substitution', 'RECONCILIATION_KIND'],
      ['reconciliation-basis-currency-substitution', 'RECONCILIATION_CANDIDATE_GRAPH'],
      ['reconciliation-hidden-external-candidate', 'RECONCILIATION_CLOSURE'],
      ['reconciliation-extra-eligible-candidate', 'RECONCILIATION_CANDIDATE_GRAPH'],
      ['reconciliation-candidate-count-substitution', 'RECONCILIATION_CLOSURE'],
      ['reconciliation-input-inventory-omission', 'RECONCILIATION_INPUT'],
      ['reconciliation-probe-semantic-substitution', 'RECONCILIATION_PROBE'],
      ['reconciliation-candidate-graph-third-source', 'RECONCILIATION_CANDIDATE_GRAPH'],
      ['reconciliation-candidate-graph-record-omission', 'RECONCILIATION_CANDIDATE_GRAPH'],
      ['reconciliation-external-manifest-incomplete-response', 'RECONCILIATION_EXTERNAL_MANIFEST'],
      ['reconciliation-external-manifest-page-omission', 'RECONCILIATION_EXTERNAL_MANIFEST'],
      ['reconciliation-external-page-record-omission', 'RECONCILIATION_EXTERNAL_MANIFEST'],
      ['reconciliation-derived-manifest-run-substitution', 'RECONCILIATION_DERIVED_MANIFEST'],
      ['reconciliation-query-definition-substitution', 'RECONCILIATION_QUERY'],
      ['reconciliation-query-tool-lock-substitution', 'RECONCILIATION_QUERY'],
      ['reconciliation-knowledge-after-availability', 'HOLDING_TEMPORAL'],
      ['reconciliation-deleted-candidate-with-locked-inventory', 'RECONCILIATION_CANDIDATE_GRAPH'],
      ['reconciliation-expired-external-candidate', 'RECONCILIATION_CANDIDATE_GRAPH'],
      ['reconciliation-expired-listing-candidate', 'POSITION_LISTING'],
      ['opening-price-substitution', 'POSITION_LOT_GROSS'],
      ['opening-quotation-substitution', 'POSITION_LOT_JOIN'],
      ['opening-half-even-tie', 'accepted'],
      ['opening-half-up-policy-replay', 'POSITION_LOT_GROSS'],
      ['opening-fx-base-to-quote', 'accepted'],
      ['opening-fx-quote-to-base', 'accepted'],
      ['opening-fx-input-substitution', 'POSITION_LOT_FX'],
      ['opening-fx-rate-substitution', 'POSITION_LOT_GROSS'],
      ['opening-fx-reverse-link', 'POSITION_LOT_FX'],
      ['opening-fx-future-rate', 'POSITION_LOT_FX'],
      ['opening-fx-late-context', 'POSITION_LOT_FX'],
      ['opening-listing-instrument-substitution', 'POSITION_LOT_JOIN'],
      ['opening-execution-listing-substitution', 'POSITION_LOT_JOIN'],
      ['opening-quotation-listing-substitution', 'POSITION_LOT_JOIN'],
      ['opening-future-listing', 'POSITION_LOT_JOIN'],
    ].map(([caseId, intended]) => {
      const result = evidence.vectorResults.find((row) => (
        row.category === 'semanticBoundary' && row.caseId === caseId
      ));
      const lifecycle = PENDING_VALIDATOR_EXECUTION[result?.validatorId];
      return [
        caseId,
        lifecycle && result.status === 'pending' ? lifecycle.pendingCode : intended,
      ];
    })),
  );
  assert.ok(Object.values(evidence.permissionAssurance).every((value) => value === true));
  const { exactReadAllowlist, ...executionBoundary } = evidence.executionBoundary;
  assert.deepEqual(executionBoundary, {
    exactReadAllowlistCount: 8,
    maxInputBytes: 262144,
    maxOldSpaceMiB: 64,
    maxOutputBytes: 65536,
    nodePermissionModel: true,
    timeoutMs: 1500,
    trustedRepositoryImplementationOnly: true,
  });
  assert.deepEqual(
    exactReadAllowlist.map((row) => [row.role, row.ref.path]),
    [
      ['adapter', 'scripts/domain/lib/orders-portfolio-canonical-record-adapter.cjs'],
      ['arithmetic', 'scripts/domain/lib/orders-portfolio-exact-arithmetic.cjs'],
      ['implementation', 'scripts/domain/lib/orders-portfolio-custom-validators.cjs'],
      ['canonicalization', 'scripts/domain/lib/strict-source-locator.cjs'],
      ['input-contract', 'scripts/domain/orders-portfolio-custom-profile/v0.3.0/input-contract.json'],
      ['reference-registry', 'scripts/domain/orders-portfolio-custom-profile/v0.3.0/reference-registry.json'],
      ['reference-registry-implementation', 'scripts/domain/lib/orders-portfolio-reference-registry.cjs'],
      ['worker', 'scripts/domain/orders-portfolio-custom-worker.cjs'],
    ].sort((left, right) => Buffer.compare(Buffer.from(left[1]), Buffer.from(right[1]))),
  );
  const closureRows = new Map(
    readStrictJcs(PATHS.closure).value.artifacts.map((row) => [row.ref.path, row]),
  );
  for (const row of exactReadAllowlist) {
    assert.equal(row.digest, closureRows.get(row.ref.path)?.digest, `${row.role} must match implementation closure`);
  }
});

test('discovery profile closes target, expression, implementation, and all 35 bindings', () => {
  const profile = readStrictJcs(PATHS.discovery).value;
  assert.equal(validateProfile(profile).constraints.length, 35);

  const expressionTamper = clone(profile);
  expressionTamper.constraints[0].expressionDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateProfile(expressionTamper), /expression digest drift/u);

  const targetTamper = clone(profile);
  targetTamper.constraints[0].targetElement = 'https://axiolune.ai/ontology/finance/orders-execution/WrongTarget';
  assert.throws(() => validateProfile(targetTamper), /targetElement\/scope\/binding closure drift/u);

  const implementationTamper = clone(profile);
  implementationTamper.constraints[0].implementationDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateProfile(implementationTamper), /implementation digest\/ref drift/u);

  const dispatchTamper = clone(profile);
  dispatchTamper.constraints[0].dispatchDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateProfile(dispatchTamper), /dispatch descriptor drift/u);

  for (const prefix of [
    'adapter', 'arithmetic', 'inputContract', 'outputContract', 'referenceRegistry',
  ]) {
    const artifactTamper = clone(profile);
    artifactTamper.constraints[0][`${prefix}Digest`] = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => validateProfile(artifactTamper), new RegExp(`${prefix} digest/ref drift`, 'u'));
  }

  const missing = clone(profile);
  missing.constraints.pop();
  assert.throws(() => validateProfile(missing), /exactly 35 bindings/u);
});

test('vector lifecycle marks every Orders/Portfolio validator executable', () => {
  const profile = readStrictJcs(PATHS.discovery).value;
  const vectors = readStrictJcs(PATHS.vectors).value;
  assert.equal(validateVectors(vectors, profile).vectors.length, 35);
  assert.equal(Object.keys(PENDING_VALIDATOR_EXECUTION).length, 0);
  assert.ok(vectors.vectors.every((row) => (
    row.execution.eligible === true
      && row.execution.status === 'executable'
      && row.execution.pendingCode === null
      && row.execution.pendingRequirement === null
  )));

  const hiddenPending = clone(vectors);
  hiddenPending.vectors[0].execution = {
    eligible: false,
    pendingCode: 'FORGED_PENDING',
    pendingRequirement: 'caller-authored pending lifecycle',
    status: 'pending',
  };
  assert.throws(
    () => validateVectors(hiddenPending, profile),
    /vector execution lifecycle drift/u,
  );
});

test('implementation closure rejects artifact and join-digest tampering', () => {
  const closure = readStrictJcs(PATHS.closure).value;
  assert.equal(verifyClosure(closure).artifacts.length, 20);
  assert.deepEqual(
    closure.artifacts.find((row) => row.role === 'profile-builder')?.ref,
    {
      kind: 'path',
      path: 'scripts/domain/lib/orders-portfolio-custom-profile.cjs',
      root: 'sourceTree',
    },
  );
  const artifactTamper = clone(closure);
  artifactTamper.artifacts[0].digest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => verifyClosure(artifactTamper), /artifact digest drift/u);
  const joinTamper = clone(closure);
  joinTamper.closureDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => verifyClosure(joinTamper), /join digest drift/u);
});

test('worker fails closed for unknown or mismatched constraint-to-validator bindings', () => {
  const vectors = readStrictJcs(PATHS.vectors).value;
  const seed = vectors.vectors[0];
  const unbound = executeRequest({
    constraintIri: 'https://axiolune.ai/ontology/finance/orders-execution/UnknownCustom',
    scenario: seed.accepted.scenario,
    schemaVersion: '1.0',
    validatorId: seed.validatorId,
  });
  assert.equal(unbound.status, 'engine-failure');
  assert.equal(unbound.code, 'WORKER_EXIT');
  const mismatch = executeRequest({
    constraintIri: seed.constraintIri,
    scenario: seed.accepted.scenario,
    schemaVersion: '1.0',
    validatorId: 'FeeContract',
  });
  assert.equal(mismatch.status, 'engine-failure');
  assert.equal(mismatch.code, 'WORKER_EXIT');
});

test('accepted-vector tampering is detected by actual validator execution', () => {
  const vectors = readStrictJcs(PATHS.vectors).value;
  const tampered = clone(vectors);
  tampered.vectors[0].accepted.scenario = {};
  assert.throws(() => createEvidence({ vectorOverride: tampered }), /accepted vector failed/u);
});

test('profile generator check independently rejects source/artifact drift', () => {
  const run = spawnSync(process.execPath, [PATHS.generator, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /35 bindings/);
});
