#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  MATERIALIZED_DISPOSITION,
  MATERIALIZED_TARGET_INVENTORY_REF,
  NON_MATERIALIZED_DISPOSITION,
  NO_CANONICAL_MAPPING_REASON,
  PROFILE_REF,
  TEMPORALFACT_MATERIALIZATION_DISPOSITION_REF,
  TEMPORAL_FACT_PATTERN_REF,
} = require('./lib/m2-materialized-identity-closure.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const BASE = 'https://axiolune.ai/ontology/finance/';
const SLICE = 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/';
const STRATEGY = 'https://axiolune.ai/conformance/m2/0.3.0/strategy-research/';
const PORTFOLIO_ID = 'https://axiolune.ai/mapping/finance/v0.3.0/portfolio-positions/identity/';
const PORTFOLIO_OBSERVATION = 'https://axiolune.ai/mapping/finance/v0.3.0/portfolio-positions/observation-identity/';
const SLICE_SOURCE = 'mappings/finance/v0.3.0/slice-a-s5/identity-compilation.json';
const POSITION_LOT_SOURCE = 'mappings/finance/v0.3.0/portfolio-positions/identity/position-lot-identity-compilation.json';
const PORTFOLIO_OBSERVATION_SOURCE = 'mappings/finance/v0.3.0/portfolio-positions/identity/portfolio-observation-identity-compilation.json';
const STRATEGY_SOURCE = 'mappings/finance/v0.3.0/strategy-research/semantic-mapping-set.json';

// Explicit materialization boundary. This table is intentionally not read
// from compilation mappings: it is the independently maintained expected
// target inventory and therefore requires deliberate review when it changes.
const INVENTORY_ROWS = Object.freeze([
  [`${BASE}foundation/ISINValue`, `${BASE}foundation`, 'ObjectTypeDefinition', SLICE_SOURCE, `${SLICE}identity-contract/isin-value`, `${SLICE}mapping/isin-value`],
  [`${BASE}market-data/MarketDataStream`, `${BASE}market-data`, 'ObjectTypeDefinition', SLICE_SOURCE, `${SLICE}identity-contract/market-data-stream`, `${SLICE}mapping/market-data-stream`],
  [`${BASE}market-data/PriceObservation`, `${BASE}market-data`, 'AssociationTypeDefinition', SLICE_SOURCE, `${SLICE}identity-contract/price-observation`, `${SLICE}mapping/price-observation`],
  [`${BASE}portfolio-positions/ExternalCostBasisObservation`, `${BASE}portfolio-positions`, 'AssociationTypeDefinition', PORTFOLIO_OBSERVATION_SOURCE, `${PORTFOLIO_OBSERVATION}identity-contract/external-cost-basis-observation`, `${PORTFOLIO_OBSERVATION}mapping/external-cost-basis-observation`],
  [`${BASE}portfolio-positions/HoldingSnapshot`, `${BASE}portfolio-positions`, 'AssociationTypeDefinition', SLICE_SOURCE, `${SLICE}identity-contract/holding-snapshot`, `${SLICE}mapping/holding-snapshot`],
  [`${BASE}portfolio-positions/PortfolioObservationStream`, `${BASE}portfolio-positions`, 'ObjectTypeDefinition', PORTFOLIO_OBSERVATION_SOURCE, `${PORTFOLIO_OBSERVATION}identity-contract/portfolio-observation-stream`, `${PORTFOLIO_OBSERVATION}mapping/portfolio-observation-stream`],
  [`${BASE}portfolio-positions/PortfolioPositionReconciliationFinding`, `${BASE}portfolio-positions`, 'AssociationTypeDefinition', PORTFOLIO_OBSERVATION_SOURCE, `${PORTFOLIO_OBSERVATION}identity-contract/portfolio-position-reconciliation-finding`, `${PORTFOLIO_OBSERVATION}mapping/portfolio-position-reconciliation-finding`],
  [`${BASE}portfolio-positions/PortfolioValuation`, `${BASE}portfolio-positions`, 'AssociationTypeDefinition', SLICE_SOURCE, `${SLICE}identity-contract/portfolio-valuation`, `${SLICE}mapping/portfolio-valuation`],
  [`${BASE}portfolio-positions/PositionLot`, `${BASE}portfolio-positions`, 'AssociationTypeDefinition', POSITION_LOT_SOURCE, `${PORTFOLIO_ID}contracts/position-lot`, `${PORTFOLIO_ID}mappings/position-lot`],
  [`${BASE}portfolio-positions/PositionSnapshot`, `${BASE}portfolio-positions`, 'AssociationTypeDefinition', PORTFOLIO_OBSERVATION_SOURCE, `${PORTFOLIO_OBSERVATION}identity-contract/position-snapshot`, `${PORTFOLIO_OBSERVATION}mapping/position-snapshot`],
  [`${BASE}portfolio-positions/PositionValuation`, `${BASE}portfolio-positions`, 'AssociationTypeDefinition', SLICE_SOURCE, `${SLICE}identity-contract/position-valuation`, `${SLICE}mapping/position-valuation`],
  [`${BASE}strategy-research/BacktestRun`, `${BASE}strategy-research`, 'ObjectTypeDefinition', STRATEGY_SOURCE, `${STRATEGY}identity-contract/backtest-run`, `${STRATEGY}mapping/backtest-run`],
  [`${BASE}strategy-research/CalculationContext`, `${BASE}strategy-research`, 'ObjectTypeDefinition', STRATEGY_SOURCE, `${STRATEGY}identity-contract/calculation-context`, `${STRATEGY}mapping/calculation-context`],
  [`${BASE}strategy-research/FactorDefinition`, `${BASE}strategy-research`, 'ObjectTypeDefinition', STRATEGY_SOURCE, `${STRATEGY}identity-contract/factor-definition`, `${STRATEGY}mapping/factor-definition`],
  [`${BASE}strategy-research/MetricDefinition`, `${BASE}strategy-research`, 'ObjectTypeDefinition', STRATEGY_SOURCE, `${STRATEGY}identity-contract/metric-definition`, `${STRATEGY}mapping/metric-definition`],
  [`${BASE}strategy-research/PerformanceObservation`, `${BASE}strategy-research`, 'AssociationTypeDefinition', STRATEGY_SOURCE, `${STRATEGY}identity-contract/performance-observation`, `${STRATEGY}mapping/performance-observation`],
  [`${BASE}strategy-research/Signal`, `${BASE}strategy-research`, 'AssociationTypeDefinition', STRATEGY_SOURCE, `${STRATEGY}identity-contract/signal`, `${STRATEGY}mapping/signal`],
  [`${BASE}strategy-research/StrategyDefinition`, `${BASE}strategy-research`, 'ObjectTypeDefinition', STRATEGY_SOURCE, `${STRATEGY}identity-contract/strategy-definition`, `${STRATEGY}mapping/strategy-definition`],
]);

// Independent exhaustive release-boundary inventory. Unlike scanning the
// ontology, this explicit list makes a newly added concrete TemporalFact fail
// closed until its materialization disposition is deliberately recorded.
const TEMPORALFACT_DISPOSITION_TYPE_ROWS = Object.freeze([
  ['foundation', 'ObjectTypeDefinition', Object.freeze(['Currency', 'FinancialAccount', 'ISINValue', 'ISO4217RegistryEntry', 'IdentifiableSubject', 'IdentifierAuthority', 'IdentifierScheme', 'IdentifierValue', 'Jurisdiction', 'LEIValue', 'LegalEntity', 'LocalIdentifierValue', 'MICValue', 'Party'])],
  ['foundation', 'AssociationTypeDefinition', Object.freeze(['CurrencyUsage', 'FinancialAccountPartyRole', 'FinancialIdentifierAssignment', 'IdentifierAssignmentConflict', 'IdentifierSchemeAuthorization'])],
  ['instruments', 'ObjectTypeDefinition', Object.freeze(['DirectUnitPriceQuotationContract', 'EquitySecurity', 'FinancialInstrument', 'InstrumentListing', 'Security', 'SecurityOffering'])],
  ['instruments', 'AssociationTypeDefinition', Object.freeze(['InstrumentIssuance'])],
  ['market-data', 'ObjectTypeDefinition', Object.freeze(['BarSpecification', 'MarketDataStream'])],
  ['market-data', 'AssociationTypeDefinition', Object.freeze(['FXRateObservation', 'MarketDataQualityFinding', 'PriceObservation', 'QuoteBar', 'QuoteObservation', 'TradeBar', 'TradeObservation'])],
  ['market-rules', 'ObjectTypeDefinition', Object.freeze(['CircuitBreakerClause', 'CircuitBreakerRule', 'CorporateActionDateOrderingClause', 'CorporateActionDateResolutionClause', 'CorporateActionDistributionAssessmentMethod', 'CorporateActionEntitlementClause', 'CorporateActionScheduleRule', 'LotScheduleRule', 'LotSizeClause', 'MarketRule', 'MarketRuleSet', 'PriceLimitClause', 'PriceLimitRule', 'ResaleRestrictionClause', 'ResaleRestrictionRule', 'RuleClause', 'RuleEvaluationRequest', 'RuleParameter', 'SettlementCycleClause', 'SettlementCycleRule', 'TickScheduleRule', 'TickSizeClause'])],
  ['market-rules', 'AssociationTypeDefinition', Object.freeze(['RuleApplicability', 'RuleConflict', 'RulePrecedence'])],
  ['market-structure', 'ObjectTypeDefinition', Object.freeze(['MICRegistryEntry', 'MarketSegment', 'OTCTradingContext', 'TradingCalendar', 'TradingCalendarException', 'TradingFacility', 'TradingSessionOccurrence', 'TradingSessionTemplate', 'TradingVenue'])],
  ['orders-execution', 'ObjectTypeDefinition', Object.freeze(['ExternalOrder', 'ExternalOrderStatusVocabulary', 'LiquidityRoleMapping', 'OrderEventStream', 'OrderIntent', 'OrderTransitionProfile'])],
  ['orders-execution', 'AssociationTypeDefinition', Object.freeze(['Execution', 'ExternalOrderStatusMapping', 'Fee', 'LiquidityRoleDetermination', 'OrderEventIntegrityFinding', 'OrderIntentLineage', 'OrderLifecycleEvent'])],
  ['portfolio-positions', 'ObjectTypeDefinition', Object.freeze(['CostBasisCalculationDefinition', 'ExecutionLotAllocationClosure', 'Portfolio', 'PortfolioObservationStream', 'ValuationCalculationDefinition'])],
  ['portfolio-positions', 'AssociationTypeDefinition', Object.freeze(['ExternalCostBasisObservation', 'FXConversion', 'HoldingSnapshot', 'PortfolioAccountMembership', 'PortfolioAccountMembershipClosure', 'PortfolioManagementMandate', 'PortfolioPositionReconciliationFinding', 'PortfolioValuation', 'PositionLot', 'PositionLotAllocation', 'PositionLotFeeAllocation', 'PositionLotStateClosure', 'PositionSnapshot', 'PositionValuation', 'UnrealizedPnLObservation'])],
  ['post-trade-operations', 'ObjectTypeDefinition', Object.freeze(['CorporateActionElectionProviderPolicy', 'ExternalSettlementStatement', 'SettlementReconciliationComparator'])],
  ['post-trade-operations', 'AssociationTypeDefinition', Object.freeze(['CorporateActionAdjustment', 'CorporateActionDistributionSizeAssessment', 'CorporateActionDueBillObligation', 'CorporateActionDueBillTradeQualification', 'CorporateActionDueBillTransfer', 'CorporateActionDueBillTransferFulfillmentClosure', 'CorporateActionElection', 'CorporateActionElectionProviderMember', 'CorporateActionElectionProviderNormalization', 'CorporateActionElectionProviderPrecedenceEdge', 'CorporateActionElectionResolution', 'CorporateActionEntitlement', 'CorporateActionEvent', 'CorporateActionProcessingFinding', 'CorporateActionScheduleEvaluationInput', 'CorporateActionScheduleResolution', 'CorporateActionSubscriptionFulfillment', 'CorporateActionSubscriptionFulfillmentClosure', 'CorporateActionSubscriptionObligation', 'CustodySettlementAccountBridge', 'ExternalSettlementStatementLine', 'MissingSideAssertion', 'ReconciliationCase', 'ReconciliationFinding', 'ReconciliationStatusEvent', 'RecordPositionAbsenceAssertion', 'SettlementInstruction', 'SettlementLeg', 'SettlementReconciliationInternalProjection', 'SettlementStatusEvent', 'TradeSettlementAllocation'])],
  ['risk', 'ObjectTypeDefinition', Object.freeze(['RiskBucketSchema', 'RiskBucketSet', 'RiskMeasureDefinition'])],
  ['risk', 'AssociationTypeDefinition', Object.freeze(['LimitBreach', 'RiskBucketValue', 'RiskLimit', 'RiskLimitEvaluation', 'RiskMeasurement'])],
  ['strategy-research', 'ObjectTypeDefinition', Object.freeze(['BacktestRun', 'CalculationContext', 'FactorDefinition', 'MetricDefinition', 'ResearchRun', 'RunContext', 'StrategyDefinition'])],
  ['strategy-research', 'AssociationTypeDefinition', Object.freeze(['BacktestStatusEvent', 'FactorObservation', 'PerformanceObservation', 'PositionAttribution', 'Signal'])],
]);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function buildInventory(rows = INVENTORY_ROWS) {
  return {
    inventoryKind: 'independentMaterializedTargetInventory',
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
    targets: rows.map(([
      targetType,
      moduleIri,
      definitionKind,
      sourcePath,
      contractRef,
      mappingRef,
    ]) => ({
      contractRef,
      definitionKind,
      mappingRefs: [mappingRef],
      moduleIri,
      sourceCompilationRef: { kind: 'path', path: sourcePath, root: 'sourceTree' },
      targetType,
    })).sort((left, right) => compareUtf8(left.targetType, right.targetType)),
  };
}

function buildTemporalFactDisposition(
  typeRows = TEMPORALFACT_DISPOSITION_TYPE_ROWS,
  inventoryRows = INVENTORY_ROWS,
) {
  const materializedTargets = new Set(inventoryRows.map(([targetType]) => targetType));
  const entries = [];
  for (const [moduleName, definitionKind, localNames] of typeRows) {
    for (const localName of localNames) {
      const targetType = `${BASE}${moduleName}/${localName}`;
      const common = {
        definitionKind,
        disposition: materializedTargets.has(targetType)
          ? MATERIALIZED_DISPOSITION
          : NON_MATERIALIZED_DISPOSITION,
        moduleIri: `${BASE}${moduleName}`,
        patternRef: TEMPORAL_FACT_PATTERN_REF,
        targetType,
      };
      entries.push(common.disposition === MATERIALIZED_DISPOSITION
        ? common
        : { ...common, reasonCode: NO_CANONICAL_MAPPING_REASON });
    }
  }
  entries.sort((left, right) => compareUtf8(left.targetType, right.targetType));
  return {
    dispositionKind: 'independentTemporalFactMaterializationDisposition',
    entries,
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
  };
}

function run(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check || argv.some((argument) => !['--write', '--check'].includes(argument))) {
    throw new Error('usage: node scripts/domain/generate-materialized-target-inventory.cjs (--write|--check)');
  }
  const outputs = [
    [MATERIALIZED_TARGET_INVENTORY_REF, buildInventory()],
    [TEMPORALFACT_MATERIALIZATION_DISPOSITION_REF, buildTemporalFactDisposition()],
  ];
  const drift = [];
  for (const [ref, value] of outputs) {
    const content = Buffer.from(canonicalJcs(value), 'utf8');
    const target = path.resolve(ROOT, ...ref.path.split('/'));
    if (write) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    } else if (!fs.existsSync(target) || !fs.statSync(target).isFile()
        || !fs.readFileSync(target).equals(content)) {
      drift.push(ref.path);
    }
  }
  if (drift.length > 0) {
    throw new Error(`materialization boundary artifacts are missing or byte-drifted: ${drift.join(', ')}`);
  }
  return { mode: write ? 'write' : 'check', targetCount: INVENTORY_ROWS.length };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run()));
  } catch (error) {
    console.error(`FAIL materialized target inventory: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  INVENTORY_ROWS,
  TEMPORALFACT_DISPOSITION_TYPE_ROWS,
  buildInventory,
  buildTemporalFactDisposition,
  run,
};
