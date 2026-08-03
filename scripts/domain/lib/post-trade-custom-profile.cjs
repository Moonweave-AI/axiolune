'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const BASE = 'https://axiolune.ai/ontology/finance/post-trade-operations/';
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0/post-trade-custom';
const PROFILE_ROOT = path.join(
  ROOT,
  'scripts',
  'domain',
  'post-trade-custom-profile',
  'v0.3.0',
);

const PATHS = Object.freeze({
  audit: path.join(ROOT, 'scripts', 'domain', 'lib', 'post-trade-custom-contract-audit.cjs'),
  closure: path.join(PROFILE_ROOT, 'implementation-closure.json'),
  discovery: path.join(PROFILE_ROOT, 'discovery-contract.json'),
  generator: path.join(ROOT, 'scripts', 'domain', 'generate-post-trade-custom-profile.cjs'),
  implementation: path.join(ROOT, 'scripts', 'domain', 'lib', 'post-trade-v03-contract.cjs'),
  jsonPointerExtractor: path.join(ROOT, 'scripts', 'domain', 'lib', 'json-pointer-source-extractor.cjs'),
  jsonPointerProfile: path.join(ROOT, 'scripts', 'domain', 'reference-extractors', 'json-pointer-jcs-v1.json'),
  module: path.join(ROOT, 'ontology', 'domain', 'finance', 'post-trade-operations', 'module.yaml'),
  negative: path.join(ROOT, 'tests', 'm2', 'fixtures', 'negative', 'post-trade-closure-reconciliation-negative.yaml'),
  positive: path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'post-trade-closure-reconciliation.yaml'),
  processingFindingNegative: path.join(ROOT, 'tests', 'm2', 'fixtures', 'post-trade-processing-finding', 'negative.yaml'),
  processingFindingPositive: path.join(ROOT, 'tests', 'm2', 'fixtures', 'post-trade-processing-finding', 'positive.yaml'),
  profileLibrary: __filename,
  runner: path.join(ROOT, 'scripts', 'domain', 'run-post-trade-custom-runtime.cjs'),
  strictJcs: path.join(ROOT, 'scripts', 'domain', 'lib', 'strict-source-locator.cjs'),
  sourceArtifactInventory: path.join(ROOT, 'scripts', 'domain', 'lib', 'post-trade-risk-source-artifact-inventory.cjs'),
  vectors: path.join(PROFILE_ROOT, 'test-vectors.json'),
  worker: path.join(ROOT, 'scripts', 'domain', 'post-trade-custom-worker.cjs'),
});

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

// This table selects one focused, executable accepted/rejected probe for every
// authored Custom constraint.  It is not an ontology truth source: generation
// independently joins every row to the module, the frozen expression audit,
// and the complete positive/negative fixture corpus.
const VECTOR_CONFIG = Object.freeze([
  ['CorporateActionEventContract', 'CorporateActionMatrix', 'corporate-action-three-kind-closed-matrix', 'unsupported-corporate-action-kind', 'event-kind-closed'],
  ['ScheduleEvaluationInputContract', 'DistributionAssessmentIdentity', 'distribution-assessment-price-kind-and-input-identity', null, 'assessment-chain-join', { op: 'set', path: 'evaluationInput.eventKind', value: 'stockSplit' }],
  ['DistributionSizeAssessmentContract', 'DistributionAssessmentIdentity', 'distribution-assessment-price-kind-and-input-identity', 'distribution-assessment-price-kind-does-not-match-exact-observation', 'assessment-price-kind'],
  ['ScheduleResolutionContract', 'DueBillEntitlementAndTransferClosure', 'due-bill-bilateral-empty-correction-partial-full', null, 'due-bill-event-resolution', { op: 'set', path: 'resolution.eventVersionIri', value: 'https://example.test/fact/corporate-action/event/version/other' }],
  ['RecordPositionAbsenceContract', 'DueBillEntitlementAndTransferClosure', 'due-bill-bilateral-empty-correction-partial-full', null, 'entitlement-proven-zero', { op: 'delete', path: 'entitlements.1.recordPosition.absenceAssertionVersionIri' }],
  ['CorporateActionEntitlementContract', 'DueBillEntitlementAndTransferClosure', 'due-bill-bilateral-empty-correction-partial-full', 'due-bill-entitlement-omits-incident-obligation', 'entitlement-obligation-set'],
  ['CustodySettlementAccountBridgeContract', 'SettlementAndAllocation', 'settlement-dvp-fop-direct-omnibus-allocation', 'settlement-allocation-uses-stale-bridge', 'settlement-bridge-pit'],
  ['DueBillTradeQualificationContract', 'DueBillEntitlementAndTransferClosure', 'due-bill-bilateral-empty-correction-partial-full', 'due-bill-qualification-must-join-exact-event', 'due-bill-qualification-event-resolution'],
  ['DueBillObligationContract', 'DueBillEntitlementAndTransferClosure', 'due-bill-bilateral-empty-correction-partial-full', 'due-bill-obligation-benefit-is-recomputed', 'obligation-benefit-arithmetic'],
  ['DueBillTransferContract', 'DueBillEntitlementAndTransferClosure', 'due-bill-bilateral-empty-correction-partial-full', 'due-bill-negative-transfer-amount', 'transfer-amount-positive'],
  ['DueBillTransferClosureContract', 'DueBillEntitlementAndTransferClosure', 'due-bill-bilateral-empty-correction-partial-full', 'due-bill-current-transfers-over-fulfill', 'transfer-over-fulfillment'],
  ['ElectionProviderPolicyContract', 'RightsExerciseChain', 'rights-election-subscription-adjustment-chain', 'rights-policy-precedence-graph-is-cyclic', 'rights-policy-precedence-cycle'],
  ['CorporateActionElectionContract', 'RightsExerciseChain', 'rights-election-subscription-adjustment-chain', 'rights-candidate-arrives-after-deadline', 'rights-candidate-deadline'],
  ['ElectionResolutionContract', 'RightsExerciseChain', 'rights-election-subscription-adjustment-chain', 'rights-resolution-proof-must-name-explicit-edge', 'rights-resolution-precedence-proof'],
  ['SubscriptionObligationContract', 'RightsExerciseChain', 'rights-election-subscription-adjustment-chain', 'rights-subscription-cash-arithmetic-mismatch', 'rights-obligation-cash-arithmetic'],
  ['SubscriptionFulfillmentContract', 'RightsExerciseChain', 'rights-election-subscription-adjustment-chain', 'rights-cash-fulfillment-must-be-positive', 'rights-fulfillment-amount-positive'],
  ['SubscriptionFulfillmentClosureContract', 'RightsExerciseChain', 'rights-election-subscription-adjustment-chain', 'rights-closure-not-fully-fulfilled', 'rights-closure-not-full'],
  ['CorporateActionProcessingFindingContract', 'CorporateActionProcessingFinding', 'corporate-action-processing-finding-three-stage-closure', 'processing-finding-evidence-digest-is-recomputed', 'processing-finding-evidence-digest'],
  ['CorporateActionAdjustmentContract', 'RightsExerciseChain', 'rights-election-subscription-adjustment-chain', 'rights-adjustment-uses-wrong-cash-date', 'rights-adjustment-date'],
  ['SettlementInstructionContract', 'SettlementAndAllocation', 'settlement-dvp-fop-direct-omnibus-allocation', 'settlement-dvp-reclassified-with-two-legs-as-fop', 'settlement-fop-leg-matrix'],
  ['SettlementLegContract', 'SettlementAndAllocation', 'settlement-dvp-fop-direct-omnibus-allocation', 'settlement-dvp-cash-direction-not-reciprocal', 'settlement-dvp-cash-reciprocity'],
  ['TradeSettlementAllocationContract', 'SettlementAndAllocation', 'settlement-dvp-fop-direct-omnibus-allocation', 'settlement-execution-allocation-aggregate-exceeds-executed-quantity', 'allocation-execution-aggregate'],
  ['SettlementStatusEventContract', 'SettlementAndAllocation', 'settlement-dvp-fop-direct-omnibus-allocation', 'settlement-settled-status-is-terminal', 'settlement-status-transition'],
  ['ExternalSettlementStatementContract', 'ReconciliationProjectionAndMatrix', 'economic-allocation-projection-and-closed-finding-matrix', 'reconciliation-statement-snapshot-digest-is-required', 'reconciliation-statement-snapshot'],
  ['ExternalSettlementStatementLineContract', 'ReconciliationProjectionAndMatrix', 'economic-allocation-projection-and-closed-finding-matrix', 'reconciliation-external-line-artifact-evidence-is-required', 'reconciliation-external-source-evidence'],
  ['SettlementReconciliationComparatorContract', 'ReconciliationProjectionAndMatrix', 'economic-allocation-projection-and-closed-finding-matrix', 'reconciliation-comparator-runtime-digest-is-required', 'reconciliation-comparator-contract'],
  ['ReconciliationCaseContract', 'ReconciliationProjectionAndMatrix', 'settlement-account-security-cash-projection-and-status-history', 'reconciliation-settlement-case-mode-marker-is-exclusive', 'reconciliation-case-mode-xone'],
  ['InternalProjectionContract', 'ReconciliationProjectionAndMatrix', 'economic-allocation-projection-and-closed-finding-matrix', 'reconciliation-projected-value-must-equal-allocation-sum', 'reconciliation-internal-value-source'],
  ['MissingSideAssertionContract', 'ReconciliationProjectionAndMatrix', 'economic-allocation-projection-and-closed-finding-matrix', 'reconciliation-missing-assertion-probe-is-bound-to-empty-result-set', 'reconciliation-missing-absence-probe'],
  ['ReconciliationFindingContract', 'ReconciliationProjectionAndMatrix', 'economic-allocation-projection-and-closed-finding-matrix', 'reconciliation-one-one-mismatch-called-matched', 'reconciliation-finding-kind'],
  ['ReconciliationStatusEventContract', 'ReconciliationProjectionAndMatrix', 'settlement-account-security-cash-projection-and-status-history', 'reconciliation-status-transition-cannot-repeat-state', 'reconciliation-status-transition'],
].map(([validatorId, fixtureContract, positiveFixtureId, negativeCaseId, expectedViolation, inlineNegativeMutation]) => Object.freeze({
  constraintIri: `${BASE}${validatorId}`,
  expectedViolation,
  fixtureContract,
  ...(inlineNegativeMutation ? { inlineNegativeMutation: Object.freeze(inlineNegativeMutation) } : {}),
  ...(negativeCaseId ? { negativeCaseId } : {}),
  positiveFixtureId,
  validatorId,
})));

if (VECTOR_CONFIG.length !== 31
    || new Set(VECTOR_CONFIG.map((row) => row.constraintIri)).size !== 31) {
  throw new Error('post-trade Custom vector configuration must contain 31 unique constraints');
}

const VECTOR_CONFIG_BY_IRI = Object.freeze(Object.fromEntries(
  VECTOR_CONFIG.map((row) => [row.constraintIri, row]),
));

module.exports = {
  BASE,
  PATHS,
  PROFILE_REF,
  ROOT,
  VECTOR_CONFIG,
  VECTOR_CONFIG_BY_IRI,
  compareUtf8,
};
