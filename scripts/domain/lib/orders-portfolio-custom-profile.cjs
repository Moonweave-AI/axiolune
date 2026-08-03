'use strict';

const path = require('node:path');
const {
  CONSTRAINT_BINDINGS,
  iriSetDigest,
  sha256Jcs,
} = require('./orders-portfolio-custom-validators.cjs');
const {
  encodeCanonicalOrdersPortfolioScenario,
} = require('./orders-portfolio-canonical-record-adapter.cjs');
const {
  DEFAULT_COST_BASIS_PRECISION_POLICY,
  DEFAULT_COST_BASIS_ROUNDING_POLICY,
  DEFAULT_VALUATION_PRECISION_POLICY,
  DEFAULT_VALUATION_ROUNDING_POLICY,
} = require('./orders-portfolio-exact-arithmetic.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0/orders-portfolio-custom';
const RECONCILIATION_PENDING_CODE = 'RECONCILIATION_PRODUCER_REPLAY_PENDING';
const RECONCILIATION_PENDING_REQUIREMENT =
  's5-branded-portfolio-candidate-projection';
const PENDING_VALIDATOR_EXECUTION = Object.freeze({});
const PROFILE_ROOT = path.join(ROOT, 'scripts', 'domain', 'orders-portfolio-custom-profile', 'v0.3.0');
const PATHS = Object.freeze({
  adapter: path.join(ROOT, 'scripts', 'domain', 'lib', 'orders-portfolio-canonical-record-adapter.cjs'),
  arithmetic: path.join(ROOT, 'scripts', 'domain', 'lib', 'orders-portfolio-exact-arithmetic.cjs'),
  canonicalization: path.join(ROOT, 'scripts', 'domain', 'lib', 'strict-source-locator.cjs'),
  closure: path.join(PROFILE_ROOT, 'implementation-closure.json'),
  discovery: path.join(PROFILE_ROOT, 'discovery-contract.json'),
  generator: path.join(ROOT, 'scripts', 'domain', 'generate-orders-portfolio-custom-profile.cjs'),
  implementation: path.join(ROOT, 'scripts', 'domain', 'lib', 'orders-portfolio-custom-validators.cjs'),
  inputContract: path.join(PROFILE_ROOT, 'input-contract.json'),
  instrumentsModule: path.join(ROOT, 'ontology', 'domain', 'finance', 'instruments', 'module.yaml'),
  iso4217Source: path.join(ROOT, 'reference', 'authority-reference', 'six', '2026-07-31', 'iso-4217-list-one', 'iso-4217-list-one.xml'),
  marketDataModule: path.join(ROOT, 'ontology', 'domain', 'finance', 'market-data', 'module.yaml'),
  marketStructureModule: path.join(ROOT, 'ontology', 'domain', 'finance', 'market-structure', 'module.yaml'),
  ordersModule: path.join(ROOT, 'ontology', 'domain', 'finance', 'orders-execution', 'module.yaml'),
  outputContract: path.join(PROFILE_ROOT, 'output-contract.json'),
  portfolioModule: path.join(ROOT, 'ontology', 'domain', 'finance', 'portfolio-positions', 'module.yaml'),
  profileBuilder: __filename,
  reconciliationEvidence: path.join(
    ROOT,
    'scripts',
    'domain',
    'lib',
    'orders-portfolio-reconciliation-evidence.cjs',
  ),
  reconciliationProducerInputs: path.join(
    PROFILE_ROOT,
    'portfolio-reconciliation-producer-inputs.json',
  ),
  referenceRegistry: path.join(PROFILE_ROOT, 'reference-registry.json'),
  referenceRegistryGenerator: path.join(ROOT, 'scripts', 'domain', 'generate-orders-portfolio-reference-registry.cjs'),
  referenceRegistryImplementation: path.join(ROOT, 'scripts', 'domain', 'lib', 'orders-portfolio-reference-registry.cjs'),
  referenceSourceLocks: path.join(ROOT, 'scripts', 'domain', 'lib', 'slice-a-source-locks.cjs'),
  runner: path.join(ROOT, 'scripts', 'domain', 'run-orders-portfolio-custom-runtime.cjs'),
  quantityUnitsSource: path.join(ROOT, 'reference', 'ontology-design-reference', 'axiolune-controlled-quantity-units', 'm2-v0.3-quantity-units.json'),
  vectors: path.join(PROFILE_ROOT, 'test-vectors.json'),
  worker: path.join(ROOT, 'scripts', 'domain', 'orders-portfolio-custom-worker.cjs'),
});

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function temporal() {
  return { availableFrom: '2025-01-01T00:00:02Z', knowledgeFrom: '2025-01-01T00:00:01Z', revision: 0, validFrom: '2025-01-01T00:00:00Z' };
}

function materializedTemporal() {
  return { availableFrom: '2025-01-01T00:00:03Z', knowledgeFrom: '2025-01-01T00:00:02Z', revision: 0, validFrom: '2025-01-01T00:00:00Z' };
}

function logical(name) {
  return { logicalIri: `https://axiolune.ai/data/${name}`, referenceMode: 'logical' };
}

function version(name) {
  return { logicalIri: `https://axiolune.ai/data/${name}`, referenceMode: 'version', versionIri: `https://axiolune.ai/data/${name}/version/0` };
}

function evidence(name) {
  const payload = { evidence: name };
  return {
    digest: sha256Jcs(payload),
    payload,
    ref: `https://axiolune.ai/evidence/${name}`,
  };
}

function digest(name) {
  return sha256Jcs({ artifact: name });
}

function lockedArtifact(ref, payload) {
  return { digest: sha256Jcs(payload), payload, ref };
}

function completedContext(name) {
  return lockedArtifact(
    `https://axiolune.ai/contexts/${name}`,
    {
      completedAt: '2025-01-01T00:00:00Z',
      contextId: name,
      schemaVersion: '1.0',
      status: 'completed',
    },
  );
}

function completedPitRequest(name) {
  return lockedArtifact(
    `https://axiolune.ai/pit/${name}`,
    {
      availableAt: '2025-01-01T00:00:02Z',
      completedAt: '2025-01-01T00:00:02Z',
      knowledgeAt: '2025-01-01T00:00:01Z',
      requestId: name,
      schemaVersion: '1.0',
      status: 'passed',
      validAt: '2025-01-01T00:00:00Z',
    },
  );
}

function exactSet(values) {
  const sorted = [...values].sort(compareUtf8);
  return { count: sorted.length, digest: iriSetDigest(sorted), values: sorted };
}

function positiveScenarios() {
  const sourceContract = {
    liquidityRoleCapability: 'required',
    schemaVersion: '1.0',
    semanticMapping: { rawFieldLocator: '/liquidity' },
    sourceSchema: { fields: ['liquidity'], schemaVersion: '1.0' },
  };
  const sourceRecord = { liquidity: 'M' };
  const members = exactSet([
    'https://axiolune.ai/data/membership/a/version/0',
    'https://axiolune.ai/data/membership/b/version/0',
  ]);
  const eligible = exactSet([
    'https://axiolune.ai/data/lot/a/version/0',
    'https://axiolune.ai/data/lot/b/version/0',
  ]);
  const allocations = exactSet([
    'https://axiolune.ai/data/allocation/a/version/0',
    'https://axiolune.ai/data/allocation/b/version/0',
  ]);
  const openLots = exactSet(['https://axiolune.ai/data/lot/open/version/0']);
  const stream = version('order-stream/1');
  const account = logical('account/1');
  const instrument = logical('instrument/1');
  const portfolio = logical('portfolio/1');
  const observationStream = logical('portfolio-observation-stream/1');
  const lineageSource = exactSet([
    'https://axiolune.ai/data/intent/lineage-source/version/0',
  ]);
  const lineageResults = exactSet([
    'https://axiolune.ai/data/intent/lineage-result-a/version/0',
    'https://axiolune.ai/data/intent/lineage-result-b/version/0',
  ]);
  const lineageFocusVersionIri =
    'https://axiolune.ai/data/order-intent-lineage/split/version/0';
  const lineageGraph = exactSet([lineageFocusVersionIri]);
  const lineagePitRequest = completedPitRequest('order-lineage');
  const lineageGraphPayload = {
    artifactKind: 'OrderIntentLineageGraphInventory',
    focusVersionIri: lineageFocusVersionIri,
    lineageVersionCount: lineageGraph.count,
    lineageVersionIris: lineageGraph.values,
    lineageVersionSetDigest: lineageGraph.digest,
    pitRequestDigest: lineagePitRequest.digest,
    pitRequestRef: lineagePitRequest.ref,
    schemaVersion: '1.0',
    selectionScopeRef:
      'https://axiolune.ai/source-scopes/orders/order-intent-lineage/complete-graph/v1',
  };
  const lineageGraphEvidence = {
    digest: sha256Jcs(lineageGraphPayload),
    payload: lineageGraphPayload,
    ref: 'https://axiolune.ai/evidence/order-lineage/selected-graph/v1',
  };
  const precisionPolicy = {
    digest: sha256Jcs(DEFAULT_VALUATION_PRECISION_POLICY),
    payload: structuredClone(DEFAULT_VALUATION_PRECISION_POLICY),
    ref: 'https://axiolune.ai/policies/valuation-precision/1',
  };
  const roundingPolicy = {
    digest: sha256Jcs(DEFAULT_VALUATION_ROUNDING_POLICY),
    payload: structuredClone(DEFAULT_VALUATION_ROUNDING_POLICY),
    ref: 'https://axiolune.ai/policies/valuation-rounding/1',
  };
  const costPrecisionPolicy = {
    digest: sha256Jcs(DEFAULT_COST_BASIS_PRECISION_POLICY),
    payload: structuredClone(DEFAULT_COST_BASIS_PRECISION_POLICY),
    ref: 'https://axiolune.ai/policies/cost-basis-precision/1',
  };
  const costRoundingPolicy = {
    digest: sha256Jcs(DEFAULT_COST_BASIS_ROUNDING_POLICY),
    payload: structuredClone(DEFAULT_COST_BASIS_ROUNDING_POLICY),
    ref: 'https://axiolune.ai/policies/cost-basis-rounding/1',
  };
  const fxInputContextPayload = {
    completedAt: '2025-01-01T00:00:00Z',
    contextId: 'fx-input-1',
    schemaVersion: '1.0',
    status: 'completed',
  };
  const fxInputContext = {
    digest: sha256Jcs(fxInputContextPayload),
    payload: fxInputContextPayload,
    ref: 'https://axiolune.ai/contexts/fx-input/1',
  };
  const definitionDigests = {
    formulaDigest: digest('formula'), inputContractDigest: digest('input'),
    outputContractDigest: digest('output'), precisionDigest: precisionPolicy.digest,
    roundingDigest: roundingPolicy.digest, runtimeDigest: digest('runtime'), toolLockDigest: digest('tool-lock'),
  };
  return {
    OrderIntentContract: {
      account, clientIntentId: 'intent-1', instrument, kind: 'Market', quantityMicros: 1000000,
      side: 'Buy', temporal: temporal(), timeInForce: 'Day',
    },
    ExternalOrderContract: {
      apiIdentifier: 'api-v1', externalOrderId: 'external-1', originatingIntent: version('intent/1'),
      provider: logical('provider/1'), providerSchemaVersion: '1.0', sourceEvidence: evidence('external-order'), temporal: temporal(),
    },
    OrderEventStreamContract: {
      externalOrder: logical('external-order/1'), liquidityRoleCapability: 'required', lockedSourceContract: sourceContract,
      provider: logical('provider/1'), sourceContractDigest: sha256Jcs(sourceContract), sourceEvidence: evidence('event-stream'), temporal: temporal(),
    },
    ExternalOrderStatusVocabularyContract: {
      apiIdentifier: 'api-v1', provider: logical('provider/1'), providerSchemaVersion: '1.0',
      sourceEvidence: evidence('status-vocabulary'), temporal: temporal(), vocabularyId: 'status-v1',
    },
    OrderTransitionProfileContract: {
      implementationDigest: digest('transition-implementation'), inputContractDigest: digest('transition-input'),
      outputContractDigest: digest('transition-output'), profileId: 'transition-v1', provider: logical('provider/1'),
      runtimeDigest: digest('transition-runtime'), temporal: temporal(), toolLockDigest: digest('transition-tool'), toolLockRef: 'https://axiolune.ai/tools/transition-lock',
    },
    LiquidityRoleMappingContract: {
      entries: [{ rawValue: 'M', role: 'Maker' }, { rawValue: 'T', role: 'Taker' }], mappingDigest: digest('liquidity-mapping'),
      mappingId: 'liquidity-v1', perspectiveInversion: true, rawPerspective: 'contraOrder',
      sourceContractDigest: digest('source-contract'), sourceContractRef: 'https://axiolune.ai/contracts/source/1', temporal: temporal(),
    },
    OrderLifecycleEventContract: {
      externalOrder: version('external-order/1'), orderIntent: version('intent/1'), providerEventId: 'evt-1',
      retries: [{ kind: 'Accepted', key: 1 }, { kind: 'Accepted', key: 1 }], sourceOrderKey: 1, stream, temporal: temporal(),
    },
    OrderIntentLineageContract: {
      kind: 'split',
      pitRequest: lineagePitRequest,
      resultIntentCount: lineageResults.count,
      resultIntentVersionSetDigest: lineageResults.digest,
      resultIntentVersionIris: lineageResults.values,
      resultIntents: [
        {
          account: logical('account/lineage-result-a'), instrument,
          quantityMicros: 400000, quantityUnit: 'share', side: 'Buy',
          sourceEvidence: evidence('order-lineage-result-a'),
          temporal: temporal(), versionIri: lineageResults.values[0],
        },
        {
          account: logical('account/lineage-result-b'), instrument,
          quantityMicros: 600000, quantityUnit: 'share', side: 'Buy',
          sourceEvidence: evidence('order-lineage-result-b'),
          temporal: temporal(), versionIri: lineageResults.values[1],
        },
      ],
      sourceEvidence: lineageGraphEvidence,
      sourceIntentCount: lineageSource.count,
      sourceIntentVersionSetDigest: lineageSource.digest,
      sourceIntentVersionIris: lineageSource.values,
      sourceIntents: [{
        account: logical('account/lineage-source'), instrument,
        quantityMicros: 1000000, quantityUnit: 'share', side: 'Buy',
        sourceEvidence: evidence('order-lineage-source'),
        temporal: temporal(), versionIri: lineageSource.values[0],
      }],
      temporal: materializedTemporal(),
      versionIri: lineageFocusVersionIri,
    },
    ExecutionContract: {
      account, instrument, intentAccountIri: account.logicalIri, intentInstrumentIri: instrument.logicalIri,
      contraAccount: logical('account/contra/1'), contraParty: logical('party/contra/1'),
      executionParty: logical('party/execution-principal/1'), executingBroker: logical('party/executing-broker/1'),
      priceCurrency: 'USD', quantityMicros: 1000000, quantityUnit: 'share', quoteCurrency: 'USD',
      quoteDenominatorUnit: 'share', quoteInstrumentIri: instrument.logicalIri, side: 'Buy', stream, temporal: temporal(),
    },
    ExecutionLiquidityDeterminationCompletenessContract: {
      determinations: [{ stream }], executionStream: stream,
    },
    FeeContract: { amountMicros: 125, effect: 'charge', execution: version('execution/1'), feeId: 'fee-1', temporal: temporal() },
    ExternalOrderStatusMappingContract: {
      apiIdentifier: 'api-v1', canonicalStates: ['Accepted'], provider: logical('provider/1'), providerSchemaVersion: '1.0',
      retiredAliases: [], reviewEvidence: evidence('status-review'), sourceEvidence: evidence('status-source'), temporal: temporal(),
      vocabularyApiIdentifier: 'api-v1', vocabularyProviderIri: 'https://axiolune.ai/data/provider/1', vocabularySchemaVersion: '1.0',
    },
    LiquidityRoleDeterminationContract: {
      capability: 'required', execution: version('execution/1'), executionStreamVersionIri: stream.versionIri,
      outcome: 'classified', perspective: 'executionAccountOrder', pointer: '/liquidity', rawValue: 'M', role: 'Maker',
      sourceRecord, sourceRecordDigest: sha256Jcs(sourceRecord), stream, temporal: temporal(),
    },
    OrderEventIntegrityFindingContract: {
      findingSubject: { missingFrom: 2, missingTo: 4 },
      kind: 'sequenceGap',
      stream,
      temporal: temporal(),
    },
    PortfolioContract: { portfolioId: 'PORT-1', temporal: temporal() },
    PortfolioObservationStreamContract: {
      completenessContract: evidence('portfolio-observation-completeness-contract'),
      paginationContract: evidence('portfolio-observation-pagination-contract'),
      provider: logical('provider/portfolio-observation/1'),
      sourceContract: evidence('portfolio-observation-source-contract'),
      sourceEvidence: evidence('portfolio-observation-stream-source'),
      sourceLocatorPresent: true,
      streamId: 'portfolio-observation-stream-1',
      temporal: temporal(),
    },
    PortfolioAccountMembershipContract: {
      account, approvalEvidence: evidence('membership-approval'), authorityEvidence: evidence('membership-authority'),
      membershipId: 'membership-1', portfolio, sourceEvidence: evidence('membership-source'), temporal: temporal(),
    },
    PortfolioManagementMandateContract: {
      approvalEvidence: evidence('mandate-approval'), authorityEvidence: evidence('mandate-authority'), managingParty: logical('party/manager'),
      mandateId: 'mandate-1', portfolio, sourceEvidence: evidence('mandate-source'), temporal: temporal(),
    },
    PortfolioAccountMembershipClosureContract: {
      generatedAt: '2025-01-02T00:00:00Z', inputCompletedAt: '2025-01-01T00:00:00Z', inputContextRef: 'https://axiolune.ai/context/input/1',
      members: members.values, membershipCount: members.count, membershipVersionSetDigest: members.digest,
      pitRequestRef: 'https://axiolune.ai/pit/1', portfolio, probePassed: true,
    },
    HoldingSnapshotContract: {
      account, instrument, observationStream, quantityMicros: 0,
      sourceEvidence: evidence('holding'), temporal: temporal(),
    },
    PositionSnapshotContract: {
      account, instrument, observationStream, quantityMicros: -1000000,
      sourceEvidence: evidence('position'), temporal: temporal(),
    },
    PositionLotContract: {
      account, basisCurrency: 'USD', calculationContextRef: 'https://axiolune.ai/context/calculation/1',
      costBasisDefinition: {
        basisCurrency: 'USD',
        precisionPolicy: costPrecisionPolicy,
        quotationContract: version('quotation/1'),
        roundingPolicy: costRoundingPolicy,
        versionIri: 'https://axiolune.ai/data/cost-definition/1/version/0',
      },
      executionCurrency: 'USD', executionPriceMicros: 3000000, instrument,
      lotDiscriminator: 'openingRemainder', openingCostBasisMicros: 6000000, openingExecution: version('execution/1'),
      openingGrossMicros: 6000000, originalQuantityMicros: 2000000, quantityUnit: 'share',
      quotationContract: version('quotation/1'), sourceEvidence: evidence('position-lot'), temporal: temporal(),
    },
    PositionLotOpeningAllocationCompletenessContract: {
      lot: version('lot/1'), openingAllocations: [{ executionVersionIri: 'https://axiolune.ai/data/execution/1/version/0', lotVersionIri: 'https://axiolune.ai/data/lot/1/version/0', quantityMicros: 100 }],
      openingExecutionVersionIri: 'https://axiolune.ai/data/execution/1/version/0', originalQuantityMicros: 100,
    },
    ValuationCalculationDefinitionContract: {
      authority: logical('authority/valuation'), definitionId: 'valuation-v1', method: 'directUnitPriceTimesQuantity',
      precisionPolicy, quotationContract: version('quotation/1'), roundingPolicy, temporal: temporal(), ...definitionDigests,
    },
    CostBasisCalculationDefinitionContract: {
      authority: logical('authority/cost'), basisCurrency: logical('currency/USD'), feeTreatment: 'included',
      currencyPolicy: 'definitionBasisCurrency', definitionId: 'cost-v1', fxPolicy: 'explicitDirectionCorrect',
      implementationDigest: digest('cost-implementation'), inputContractDigest: digest('cost-input'), lotConsumptionPolicy: 'fifo',
      lotOpeningPolicy: 'openingRemainder', method: 'executionAllocatedDirectUnitCost', outputContractDigest: digest('cost-output'),
      precisionPolicy: costPrecisionPolicy, quotationContract: version('quotation/1'), roundingPolicy: costRoundingPolicy,
      runtimeDigest: digest('cost-runtime'), sourceEvidence: evidence('cost-definition'), temporal: temporal(),
      toolLockDigest: digest('cost-tool-lock'), toolLockRef: 'https://axiolune.ai/tools/cost-basis/1',
    },
    PortfolioValuationContract: {
      conversionContext: completedContext('portfolio-valuation-conversion'),
      inputTemporal: temporal(),
      inputContext: completedContext('portfolio-valuation-input'),
      memberClosurePortfolioIri: portfolio.logicalIri,
      pitRequest: completedPitRequest('portfolio-valuation'),
      reportingCurrency: 'USD', temporal: materializedTemporal(), valuationDefinition: version('valuation-definition/1'),
      valuationRunId: 'valuation-run-1', valuedPortfolio: portfolio,
    },
    PositionValuationContract: {
      marketValueMicros: 6000000, memberAccountIri: account.logicalIri, priceCurrency: 'USD', priceInstrumentIri: instrument.logicalIri,
      priceMicros: 3000000, quantityMicros: 2000000, quantityUnit: 'share', quoteDenominatorUnit: 'share', reportingCurrency: 'USD',
      snapshotAccountIri: account.logicalIri, snapshotInstrumentIri: instrument.logicalIri, temporal: temporal(),
      valuationDefinition: {
        method: 'directUnitPriceTimesQuantity',
        precisionPolicy,
        quotationContract: version('quotation/1'),
        roundingPolicy,
      },
    },
    FXConversionContract: {
      baseCurrency: 'USD', consumers: ['https://axiolune.ai/data/valuation/1/version/0'], direction: 'baseToQuote',
      inputContext: fxInputContext, inputMicros: 100, outputMicros: 200, quoteCurrency: 'EUR', ratePpm: 2000000,
      roundingPolicy, temporal: temporal(),
    },
    PositionLotAllocationContract: {
      calculationContextRef: 'https://axiolune.ai/context/calculation/1', definitionVersionIri: 'https://axiolune.ai/data/cost-definition/1/version/0',
      execution: version('execution/1'), kind: 'opening', lot: version('lot/1'), lotCalculationContextRef: 'https://axiolune.ai/context/calculation/1',
      lotDefinitionVersionIri: 'https://axiolune.ai/data/cost-definition/1/version/0', openingExecutionVersionIri: 'https://axiolune.ai/data/execution/1/version/0',
      originalQuantityMicros: 100, quantityMicros: 100, temporal: temporal(),
    },
    PositionLotFeeAllocationContract: {
      amountMicros: 10, calculationContextRef: 'https://axiolune.ai/context/calculation/1', closureAllocationVersionIris: ['https://axiolune.ai/data/allocation/1/version/0'],
      currency: 'USD', definitionVersionIri: 'https://axiolune.ai/data/cost-definition/1/version/0', feeCurrency: 'USD',
      lotAllocationContextRef: 'https://axiolune.ai/context/calculation/1', lotAllocationDefinitionVersionIri: 'https://axiolune.ai/data/cost-definition/1/version/0',
      lotAllocationVersionIri: 'https://axiolune.ai/data/allocation/1/version/0', temporal: temporal(),
    },
    ExecutionLotAllocationClosureContract: {
      allocationCount: allocations.count, allocationProbePassed: true, allocationQuantityMicros: [40, 60],
      allocationVersionIris: allocations.values, allocationVersionSetDigest: allocations.digest,
      allocations: [
        {
          lotVersionIri: eligible.values[0],
          quantityMicros: 40,
          versionIri: allocations.values[0],
        },
        {
          lotVersionIri: eligible.values[1],
          quantityMicros: 60,
          versionIri: allocations.values[1],
        },
      ],
      definition: {
        basisCurrency: 'USD',
        feeTreatment: 'included',
        lotConsumptionPolicy: 'fifo',
      },
      eligibleLotCount: eligible.count, eligibleLotVersionIris: eligible.values, eligibleLotVersionSetDigest: eligible.digest,
      feeAllocations: [
        {
          amountMicros: 4,
          currency: 'USD',
          feeVersionIri: 'https://axiolune.ai/data/fee/closure/version/0',
          lotAllocationVersionIri: allocations.values[0],
          versionIri: 'https://axiolune.ai/data/fee-allocation/closure-a/version/0',
        },
        {
          amountMicros: 6,
          currency: 'USD',
          feeVersionIri: 'https://axiolune.ai/data/fee/closure/version/0',
          lotAllocationVersionIri: allocations.values[1],
          versionIri: 'https://axiolune.ai/data/fee-allocation/closure-b/version/0',
        },
      ],
      fees: [{
        amountMicros: 10,
        currency: 'USD',
        versionIri: 'https://axiolune.ai/data/fee/closure/version/0',
      }],
      lots: [
        {
          originalQuantityMicros: 40,
          temporal: {
            availableFrom: '2024-12-01T00:00:02Z',
            knowledgeFrom: '2024-12-01T00:00:01Z',
            revision: 0,
            validFrom: '2024-12-01T00:00:00Z',
          },
          versionIri: eligible.values[0],
        },
        {
          originalQuantityMicros: 60,
          temporal: {
            availableFrom: '2024-12-02T00:00:02Z',
            knowledgeFrom: '2024-12-02T00:00:01Z',
            revision: 0,
            validFrom: '2024-12-02T00:00:00Z',
          },
          versionIri: eligible.values[1],
        },
      ],
      executionQuantityMicros: 100, selectionProbePassed: true, temporal: temporal(),
    },
    PositionLotStateClosureContract: {
      allocationProbePassed: true, lotProbePassed: true, lots: [{ consumedQuantityMicros: 40, openingCostBasisMicros: 1000, originalQuantityMicros: 100 }],
      costBasisDefinition: {
        precisionPolicy: costPrecisionPolicy,
        roundingPolicy: costRoundingPolicy,
      },
      openLotCount: openLots.count, openLotVersionIris: openLots.values, openLotVersionSetDigest: openLots.digest,
      remainingCostBasisMicros: 600, remainingQuantityMicros: 60, temporal: temporal(),
    },
    UnrealizedPnLObservationContract: {
      closedSnapshotVersionIri: 'https://axiolune.ai/data/position/1/version/0', currency: 'USD', lotState: version('lot-state/1'),
      inputTemporal: temporal(),
      marketValueCurrency: 'USD', marketValueMicros: 1000, remainingCostBasisCurrency: 'USD', remainingCostBasisMicros: 600,
      temporal: materializedTemporal(), unrealizedPnlMicros: 400, valuation: version('valuation/1'), valuationSnapshotVersionIri: 'https://axiolune.ai/data/position/1/version/0',
    },
    ExternalCostBasisObservationContract: {
      account, costBasisDefinitionVersionIri: 'https://axiolune.ai/data/cost-definition/external-basis/version/0',
      externalBasisId: 'external-basis-1', instrument, observationStream,
      overwritesDerivedState: false, sourceEvidence: evidence('external-basis'), temporal: temporal(),
    },
    PortfolioPositionReconciliationFindingContract: {
      derivedSnapshot: version('position/derived'), externalSnapshot: version('position/external'), kind: 'matched',
      leftAccountIri: account.logicalIri, leftInstrumentIri: instrument.logicalIri, leftValueMicros: 100,
      rightAccountIri: account.logicalIri, rightInstrumentIri: instrument.logicalIri, rightValueMicros: 100, temporal: temporal(),
    },
  };
}

function reconciliationProducerInputs() {
  const baseline = structuredClone(
    positiveScenarios().PortfolioPositionReconciliationFindingContract,
  );
  const version = (name) => ({
    logicalIri: `https://axiolune.ai/data/${name}`,
    referenceMode: 'version',
    versionIri: `https://axiolune.ai/data/${name}/version/0`,
  });
  const semanticBase = {
    derivedSnapshot: version('position/reconciliation-derived'),
    externalSnapshot: version('holding/reconciliation-external'),
    kind: 'matched',
    leftAccountIri: 'https://axiolune.ai/data/account/1',
    leftInstrumentIri: 'https://axiolune.ai/data/instrument/1',
    leftValueMicros: 100,
    rightAccountIri: 'https://axiolune.ai/data/account/1',
    rightInstrumentIri: 'https://axiolune.ai/data/instrument/1',
    rightValueMicros: 100,
    temporal: temporal(),
  };
  const withOmissions = (value, omissions, additions) => {
    const result = { ...value, ...additions };
    for (const key of omissions) delete result[key];
    return result;
  };
  const cases = [
    ['baseline', baseline],
    ['reconciliation-quantity-mismatch', {
      ...semanticBase,
      kind: 'quantityMismatch',
      rightValueMicros: 90,
    }],
    ['reconciliation-signed-external-position', withOmissions(
      semanticBase,
      ['externalSnapshot'],
      {
        externalPositionSnapshot: version('position/reconciliation-external'),
        leftValueMicros: -100,
        rightValueMicros: -100,
      },
    )],
    ['reconciliation-basis-match', withOmissions(
      semanticBase,
      ['derivedSnapshot', 'externalSnapshot'],
      {
        externalBasis: version('basis/reconciliation-external'),
        lotState: version('lot-state/reconciliation-derived'),
      },
    )],
    ['reconciliation-basis-mismatch', withOmissions(
      semanticBase,
      ['derivedSnapshot', 'externalSnapshot'],
      {
        externalBasis: version('basis/reconciliation-external'),
        kind: 'basisMismatch',
        lotState: version('lot-state/reconciliation-derived'),
        rightValueMicros: 90,
      },
    )],
  ].map(([caseId, legacyInput]) => ({
    caseId,
    legacyInput: structuredClone(legacyInput),
    validatorId: 'PortfolioPositionReconciliationFindingContract',
  })).sort((left, right) => compareUtf8(left.caseId, right.caseId));
  return {
    cases,
    producerContract:
      'orders-portfolio-reconciliation-canonical-record-producer-v1',
    schemaVersion: '1.0',
  };
}

const NEGATIVE_MUTATIONS = Object.freeze({
  OrderIntentContract: (s) => { s.quantityMicros = 0; },
  ExternalOrderContract: (s) => { s.externalOrderId = ''; },
  OrderEventStreamContract: (s) => { s.providerStreamId = ''; },
  ExternalOrderStatusVocabularyContract: (s) => { s.vocabularyId = ''; },
  OrderTransitionProfileContract: (s) => { s.profileId = ''; },
  LiquidityRoleMappingContract: (s) => { s.perspectiveInversion = false; },
  OrderLifecycleEventContract: (s) => { s.retries[1] = { kind: 'Rejected', key: 1 }; },
  OrderIntentLineageContract: (s) => { s.kind = 'aggregation'; },
  ExecutionContract: (s) => { s.quantityMicros = -1; },
  ExecutionLiquidityDeterminationCompletenessContract: (s) => { s.determinations = []; },
  FeeContract: (s) => { s.amountMicros = -1; },
  ExternalOrderStatusMappingContract: (s) => { s.apiIdentifier = 'api-v2'; },
  LiquidityRoleDeterminationContract: (s) => { s.outcome = 'unavailable'; },
  OrderEventIntegrityFindingContract: (s) => {
    s.findingSubject.missingTo = s.findingSubject.missingFrom;
  },
  PortfolioContract: (s) => { s.portfolioId = ''; },
  PortfolioObservationStreamContract: (s) => {
    s.sourceContract.digest = `sha256:${'0'.repeat(64)}`;
  },
  PortfolioAccountMembershipContract: (s) => { s.membershipId = ''; },
  PortfolioManagementMandateContract: (s) => { s.mandateId = ''; },
  PortfolioAccountMembershipClosureContract: (s) => { s.members.pop(); },
  HoldingSnapshotContract: (s) => { s.quantityMicros = -1; },
  PositionSnapshotContract: (s) => { s.snapshotId = ' non-canonical '; },
  PositionLotContract: (s) => { s.openingCostBasisMicros = -1000; },
  PositionLotOpeningAllocationCompletenessContract: (s) => { s.openingAllocations = []; },
  ValuationCalculationDefinitionContract: (s) => { s.definitionId = ''; },
  CostBasisCalculationDefinitionContract: (s) => { s.currencyPolicy = 'unreviewed'; },
  PortfolioValuationContract: (s) => { s.memberClosurePortfolioIri = 'https://axiolune.ai/data/portfolio/other'; },
  PositionValuationContract: (s) => { s.marketValueMicros = 7; },
  FXConversionContract: (s) => { s.outputMicros = 201; },
  PositionLotAllocationContract: (s) => { s.quantityMicros = 0; },
  PositionLotFeeAllocationContract: (s) => {
    s.feeAmountMicros = s.amountMicros;
    s.amountMicros += 1;
  },
  ExecutionLotAllocationClosureContract: (s) => {
    s.allocationQuantityMicros = [40, 50];
    s.allocations[1].quantityMicros = 50;
  },
  PositionLotStateClosureContract: (s) => { s.remainingQuantityMicros = 61; },
  UnrealizedPnLObservationContract: (s) => { s.unrealizedPnlMicros = 399; },
  ExternalCostBasisObservationContract: (s) => { s.externalBasisId = ''; },
  PortfolioPositionReconciliationFindingContract: (s) => { s.externalBasis = version('basis/external'); s.lotState = version('lot-state/1'); },
});

const EXPECTED_CODES = Object.freeze({
  OrderIntentContract: 'ORDER_INTENT_QUANTITY', ExternalOrderContract: 'EXTERNAL_ORDER_IDENTITY',
  OrderEventStreamContract: 'EVENT_STREAM_IDENTITY', ExternalOrderStatusVocabularyContract: 'STATUS_VOCAB_IDENTITY',
  OrderTransitionProfileContract: 'TRANSITION_PROFILE_IDENTITY', LiquidityRoleMappingContract: 'LIQUIDITY_MAPPING_PERSPECTIVE',
  OrderLifecycleEventContract: 'LIFECYCLE_EVENT_DUPLICATE', ExecutionContract: 'EXECUTION_QUANTITY',
  OrderIntentLineageContract: 'ORDER_LINEAGE_BRANCH',
  ExecutionLiquidityDeterminationCompletenessContract: 'EXECUTION_LIQUIDITY_COMPLETENESS', FeeContract: 'FEE_AMOUNT',
  ExternalOrderStatusMappingContract: 'STATUS_MAPPING_SCOPE', LiquidityRoleDeterminationContract: 'LIQUIDITY_REQUIRED',
  OrderEventIntegrityFindingContract: 'FINDING_SEQUENCE_GAP', PortfolioContract: 'PORTFOLIO_ID',
  PortfolioObservationStreamContract: 'PORTFOLIO_OBSERVATION_STREAM_CONTRACT',
  PortfolioAccountMembershipContract: 'MEMBERSHIP_IDENTITY', PortfolioManagementMandateContract: 'MANDATE_IDENTITY',
  PortfolioAccountMembershipClosureContract: 'MEMBERSHIP_CLOSURE_SET', HoldingSnapshotContract: 'HOLDING_QUANTITY',
  PositionSnapshotContract: 'POSITION_SUBJECT', PositionLotContract: 'POSITION_LOT_SIGN',
  PositionLotOpeningAllocationCompletenessContract: 'OPENING_ALLOCATION_XONE', ValuationCalculationDefinitionContract: 'VALUATION_DEFINITION_IDENTITY',
  CostBasisCalculationDefinitionContract: 'COST_BASIS_POLICY', PortfolioValuationContract: 'PORTFOLIO_VALUATION_CLOSURE',
  PositionValuationContract: 'POSITION_VALUATION_ARITHMETIC', FXConversionContract: 'FX_CONVERSION_ARITHMETIC',
  PositionLotAllocationContract: 'LOT_ALLOCATION_QUANTITY', PositionLotFeeAllocationContract: 'FEE_ALLOCATION_CURRENCY',
  ExecutionLotAllocationClosureContract: 'EXECUTION_CLOSURE_CONSERVATION', PositionLotStateClosureContract: 'LOT_STATE_REMAINING',
  UnrealizedPnLObservationContract: 'PNL_VALUATION_CONTEXT_OUTPUT', ExternalCostBasisObservationContract: 'EXTERNAL_BASIS_IDENTITY',
  PortfolioPositionReconciliationFindingContract: 'RECONCILIATION_KIND',
});

function buildVectorSet(referenceRegistry) {
  const positives = positiveScenarios();
  const vectors = Object.entries(CONSTRAINT_BINDINGS)
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([constraintIri, validatorId]) => {
      const acceptedLegacy = structuredClone(positives[validatorId]);
      const violationLegacy = structuredClone(acceptedLegacy);
      NEGATIVE_MUTATIONS[validatorId](violationLegacy);
      const options = referenceRegistry === undefined ? {} : { referenceRegistry };
      const acceptedScenario = encodeCanonicalOrdersPortfolioScenario(
        validatorId,
        acceptedLegacy,
        options,
      );
      let violationScenario;
      if (validatorId === 'PortfolioValuationContract') {
        violationScenario = structuredClone(acceptedScenario);
        const otherPortfolio = 'https://axiolune.ai/data/portfolio/other';
        const closure = violationScenario.records.find(
          (record) => record.typeIri.endsWith('/PortfolioAccountMembershipClosure'),
        );
        closure.closurePortfolio = otherPortfolio;
        for (const membership of violationScenario.records.filter(
          (record) => record.typeIri.endsWith('/PortfolioAccountMembership'),
        )) membership.membershipPortfolio = otherPortfolio;
        const closureProbe = violationScenario.artifacts.find(
          (row) => row.artifactRef.iri === closure.membershipClosureProbeRef,
        );
        closureProbe.payload.portfolioLogicalIri = otherPortfolio;
        closureProbe.artifactDigest = sha256Jcs(closureProbe.payload);
        closure.membershipClosureProbeDigest = closureProbe.artifactDigest;
      } else if (validatorId === 'UnrealizedPnLObservationContract') {
        violationScenario = structuredClone(acceptedScenario);
        const focus = violationScenario.records.find(
          (record) => record.versionIri === violationScenario.focusVersionIri,
        );
        focus.unrealizedPnl.amount = '0.000399';
      } else if (validatorId === 'PortfolioPositionReconciliationFindingContract') {
        violationScenario = structuredClone(acceptedScenario);
        const focus = violationScenario.records.find(
          (record) => record.versionIri === violationScenario.focusVersionIri,
        );
        focus.portfolioReconciliationKind =
          'https://axiolune.ai/ontology/finance/portfolio-positions/PortfolioReconciliationKind/value/quantityMismatch';
      } else {
        violationScenario = encodeCanonicalOrdersPortfolioScenario(
          validatorId,
          violationLegacy,
          options,
        );
      }
      const pendingExecution = PENDING_VALIDATOR_EXECUTION[validatorId] || null;
      const pending = pendingExecution !== null;
      return {
        accepted: { caseId: `${validatorId}-accepted`, expectedOutcome: 'accepted', scenario: acceptedScenario },
        constraintIri,
        execution: {
          eligible: !pending,
          pendingCode: pending ? pendingExecution.pendingCode : null,
          pendingRequirement: pending ? pendingExecution.pendingRequirement : null,
          status: pending ? 'pending' : 'executable',
        },
        validatorId,
        violation: { caseId: `${validatorId}-violation`, expectedCode: EXPECTED_CODES[validatorId], expectedOutcome: 'violation', scenario: violationScenario },
      };
    });
  return { profileRef: PROFILE_REF, schemaVersion: '1.0', vectors };
}

module.exports = {
  EXPECTED_CODES,
  PATHS,
  PENDING_VALIDATOR_EXECUTION,
  PROFILE_REF,
  RECONCILIATION_PENDING_CODE,
  RECONCILIATION_PENDING_REQUIREMENT,
  ROOT,
  buildVectorSet,
  compareUtf8,
  reconciliationProducerInputs,
};
