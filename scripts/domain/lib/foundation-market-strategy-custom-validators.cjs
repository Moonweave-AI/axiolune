'use strict';

const crypto = require('node:crypto');
const {
  canonicalJcs,
} = require('./strict-source-locator.cjs');
const {
  decodeCanonicalEvidencePayload,
} = require('./foundation-market-strategy-payload-codec.cjs');
const {
  instanceViolation: validateFoundationAccountIdentity,
} = require('../test-foundation-account-identity.cjs');
const {
  validateInstance: validateFoundationMarketRules,
} = require('./foundation-market-rules-contract.cjs');
const {
  validateScenario: validateSliceA,
} = require('./slice-a-market-contracts.cjs');
const {
  validateScenario: validateMarketData,
} = require('./market-data-v03-contracts.cjs');
const {
  MarketRulesCqError,
  resolveMarketRule,
  validateMarketRulesScenario,
} = require('./market-rules-cq.cjs');
const {
  CASE_VALIDATORS: STRATEGY_VALIDATORS,
} = require('./strategy-research-contracts.cjs');

const BASE = Object.freeze({
  foundation: 'https://axiolune.ai/ontology/finance/foundation/',
  instruments: 'https://axiolune.ai/ontology/finance/instruments/',
  marketData: 'https://axiolune.ai/ontology/finance/market-data/',
  marketRules: 'https://axiolune.ai/ontology/finance/market-rules/',
  marketStructure: 'https://axiolune.ai/ontology/finance/market-structure/',
  strategy: 'https://axiolune.ai/ontology/finance/strategy-research/',
});

const CUSTOM_CONSTRAINT_COUNT = 57;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function sha256Jcs(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJcs(value), 'utf8').digest('hex')}`;
}

function row(module, base, localName, fixtureContract, dispatchKey, expectedCode, expectedAtPrefix = null) {
  const constraintIri = `${base}${localName}`;
  const validatorId = `validate${localName}`;
  const descriptor = {
    constraintIri,
    dispatchKey,
    expectedAtPrefix,
    expectedCode,
    fixtureContract,
    module,
    validatorId,
  };
  return Object.freeze({
    ...descriptor,
    dispatchDigest: sha256Jcs({
      contract: 'axiolune-m2-custom-dispatch-v1',
      descriptor,
    }),
  });
}

const BINDING_ROWS = Object.freeze([
  row('fin-foundation', BASE.foundation, 'IdentifierSchemeCompatibilityMatrix', 'foundation-account', 'instance', 'assignment-compatibility-matrix'),
  row('fin-foundation', BASE.foundation, 'IdentifierAuthorizationCoverage', 'foundation-account', 'instance', 'assignment-authorization'),
  row('fin-foundation', BASE.foundation, 'IdentifierGlobalUniquenessConflict', 'foundation-account', 'instance', 'missing-assignment-conflict'),
  row('fin-foundation', BASE.foundation, 'FinancialAccountIdentityIntegrity', 'foundation-account', 'instance', 'account-identity-key-bijection'),
  row('fin-foundation', BASE.foundation, 'ISO4217RegistryEntryIntegrity', 'foundation-market-rules', 'instance', 'iso4217-entry-integrity'),
  row('fin-foundation', BASE.foundation, 'CurrencyUsageIntegrity', 'foundation-market-rules', 'instance', 'currency-usage-cardinality'),

  row('fin-instruments', BASE.instruments, 'InstrumentIssuanceContract', 'slice-a', 'scenario', 'ISSUANCE_OFFERING_JOIN'),
  row('fin-instruments', BASE.instruments, 'InstrumentListingIdentityContract', 'slice-a', 'scenario', 'LISTING_SCHEME_AUTHORIZATION'),
  row('fin-instruments', BASE.instruments, 'InstrumentListingOfferingContract', 'slice-a', 'scenario', 'LISTING_OFFERING_JOIN'),
  row('fin-instruments', BASE.instruments, 'InstrumentListingIntervalContract', 'slice-a', 'scenario', 'LISTING_BUSINESS_INTERVAL'),
  row('fin-instruments', BASE.instruments, 'DirectUnitPriceQuotationRule', 'slice-a', 'scenario', 'QUOTATION_KIND'),

  row('fin-market-data', BASE.marketData, 'MarketDataStreamIdentityContract', 'market-data-v03', 'scenario', 'STREAM_SOURCE_MAPPING'),
  row('fin-market-data', BASE.marketData, 'BarSpecificationContract', 'market-data-v03', 'scenario', 'BAR_SPEC_CONTRACT'),
  row('fin-market-data', BASE.marketData, 'ObservationIdentityAndRevisionContract', 'market-data-v03', 'scenario', 'REVISION_FIELDS'),
  row('fin-market-data', BASE.marketData, 'ObservationContextQuotationContract', 'market-data-v03', 'scenario', 'OBSERVATION_QUOTATION'),
  row('fin-market-data', BASE.marketData, 'PriceKindCompatibilityContract', 'market-data-v03', 'scenario', 'PRICE_KIND'),
  row('fin-market-data', BASE.marketData, 'QuoteObservationContract', 'market-data-v03', 'scenario', 'QUANTITY_NON_NEGATIVE'),
  row('fin-market-data', BASE.marketData, 'TradeObservationContract', 'market-data-v03', 'scenario', 'QUANTITY_POSITIVE'),
  row('fin-market-data', BASE.marketData, 'TradeBarContract', 'market-data-v03', 'scenario', 'BAR_OHLC', 'observations.trade-bar-'),
  row('fin-market-data', BASE.marketData, 'QuoteBarContract', 'market-data-v03', 'scenario', 'BAR_OHLC', 'observations.quote-bar-'),
  row('fin-market-data', BASE.marketData, 'BarInstanceBranchContract', 'market-data-v03', 'scenario', 'BAR_INSTANCE_BRANCH'),
  row('fin-market-data', BASE.marketData, 'MarketDataQualityFindingContract', 'market-data-v03', 'scenario', 'QUALITY_FINDING_FALSE_PREDICATE'),
  row('fin-market-data', BASE.marketData, 'FXRateObservationContract', 'market-data-v03', 'scenario', 'FX_STORED_INVERSE_FORBIDDEN'),
  row('fin-market-data', BASE.marketData, 'ThreeAxisPITContract', 'market-data-v03', 'scenario', 'FACT_THREE_AXIS', 'observations.'),
  row('fin-market-data', BASE.marketData, 'ThreeAxisObjectPITContract', 'market-data-v03', 'scenario', 'FACT_THREE_AXIS', 'streams.'),

  row('fin-market-rules', BASE.marketRules, 'RuleApplicabilityRequiresExplicitScope', 'foundation-market-rules', 'instance', 'rule-applicability-empty-scope'),
  row('fin-market-rules', BASE.marketRules, 'RuleApplicabilityMustMatchRequest', 'foundation-market-rules', 'instance', 'rule-applicability-scope-mismatch'),
  row('fin-market-rules', BASE.marketRules, 'RulePriorityComparability', 'market-rules-v03', 'validate', 'RULE_APPLICABILITY_SOURCE'),
  row('fin-market-rules', BASE.marketRules, 'RuleParameterExclusiveOneOf', 'foundation-market-rules', 'instance', 'rule-parameter-xone'),
  row('fin-market-rules', BASE.marketRules, 'RuleClauseRangeIntegrity', 'foundation-market-rules', 'instance', 'rule-clause-overlap'),
  row('fin-market-rules', BASE.marketRules, 'RuleSubtypeClauseCompatibility', 'foundation-market-rules', 'instance', 'rule-subtype-clause-matrix'),
  row('fin-market-rules', BASE.marketRules, 'PriceLimitClauseExclusiveBoundary', 'foundation-market-rules', 'instance', 'price-limit-boundary-xone'),
  row('fin-market-rules', BASE.marketRules, 'RulePrecedenceIntegrity', 'foundation-market-rules', 'instance', 'rule-precedence-cycle'),
  row('fin-market-rules', BASE.marketRules, 'RuleConflictNoSilentWinner', 'market-rules-v03', 'resolve:priceLimit:mr2-conflict-beta', 'RULE_CONFLICT_REQUIRED'),
  row('fin-market-rules', BASE.marketRules, 'RuleEvaluationRequestIntegrity', 'market-rules-v03', 'validate', 'RULE_EVALUATION_REQUEST_CONTEXT_ORDER'),
  row('fin-market-rules', BASE.marketRules, 'CorporateActionScheduleRuleIntegrity', 'foundation-market-rules', 'instance', 'corporate-action-schedule-integrity'),
  row('fin-market-rules', BASE.marketRules, 'CorporateActionDistributionAssessmentMethodIntegrity', 'foundation-market-rules', 'instance', 'corporate-action-assessment-method-price-matrix'),
  row('fin-market-rules', BASE.marketRules, 'CorporateActionEntitlementClauseIntegrity', 'foundation-market-rules', 'instance', 'corporate-action-entitlement-clause'),
  row('fin-market-rules', BASE.marketRules, 'CorporateActionDateResolutionClauseIntegrity', 'foundation-market-rules', 'instance', 'corporate-action-date-resolution-clause'),
  row('fin-market-rules', BASE.marketRules, 'CorporateActionDateOrderingClauseIntegrity', 'foundation-market-rules', 'instance', 'corporate-action-date-ordering-clause'),

  row('fin-market-structure', BASE.marketStructure, 'MICRegistryEntryContract', 'slice-a', 'scenario', 'MIC_SGMT_CONTRACT'),
  row('fin-market-structure', BASE.marketStructure, 'TradingCalendarIdentityContract', 'slice-a', 'scenario', 'CALENDAR_IDENTITY'),
  row('fin-market-structure', BASE.marketStructure, 'TradingSessionOccurrenceContract', 'slice-a', 'scenario', 'SESSION_OCCURRENCE_JOIN'),
  row('fin-market-structure', BASE.marketStructure, 'TradingCalendarExceptionContract', 'slice-a', 'scenario', 'CALENDAR_EXCEPTION_LATE'),
  row('fin-market-structure', BASE.marketStructure, 'OTCTradingContextReferenceContract', 'slice-a', 'scenario', 'OTC_PROVIDER'),

  row('fin-strategy-research', BASE.strategy, 'SignalGeneratorEvidenceContract', 'strategy-research', 'generatorDefinition', 'STRATEGY_USES_FACTOR'),
  row('fin-strategy-research', BASE.strategy, 'RunInputClosureContract', 'strategy-research', 'backtest', 'INPUT_CONTEXT_NOT_PRIOR'),
  row('fin-strategy-research', BASE.strategy, 'BacktestConfigurationContract', 'strategy-research', 'backtest', 'BACKTEST_INTERVAL'),
  row('fin-strategy-research', BASE.strategy, 'ResearchRunContract', 'strategy-research', 'researchRun', 'RUN_KIND'),
  row('fin-strategy-research', BASE.strategy, 'MetricDefinitionContract', 'strategy-research', 'metricDefinition', 'DIGEST_FORMAT', 'payload.formulaDigest'),
  row('fin-strategy-research', BASE.strategy, 'CalculationContextContract', 'strategy-research', 'calculationContext', 'REF_DIGEST_PAIR'),
  row('fin-strategy-research', BASE.strategy, 'SignalContract', 'strategy-research', 'signal', 'QUANTITY_RANGE'),
  row('fin-strategy-research', BASE.strategy, 'FactorRevisionContract', 'strategy-research', 'factorRevision', 'FACTOR_STORAGE_POINTER'),
  row('fin-strategy-research', BASE.strategy, 'BacktestStatusContract', 'strategy-research', 'statusEvent', 'STATUS_TRANSITION'),
  row('fin-strategy-research', BASE.strategy, 'PerformanceValueContract', 'strategy-research', 'performance', 'METRIC_VALUE_MISMATCH'),
  row('fin-strategy-research', BASE.strategy, 'PerformanceRevisionContract', 'strategy-research', 'performanceRevision', 'PERFORMANCE_SUPERSESSION'),
  row('fin-strategy-research', BASE.strategy, 'PositionAttributionContract', 'strategy-research', 'attribution', 'ATTRIBUTION_SUBJECT_XONE'),
].sort((left, right) => compareUtf8(left.constraintIri, right.constraintIri)));

if (BINDING_ROWS.length !== CUSTOM_CONSTRAINT_COUNT
    || new Set(BINDING_ROWS.map((binding) => binding.constraintIri)).size !== CUSTOM_CONSTRAINT_COUNT
    || new Set(BINDING_ROWS.map((binding) => binding.validatorId)).size !== CUSTOM_CONSTRAINT_COUNT
    || new Set(BINDING_ROWS.map((binding) => binding.dispatchDigest)).size !== CUSTOM_CONSTRAINT_COUNT) {
  throw new Error(`six-module Custom binding inventory must contain ${CUSTOM_CONSTRAINT_COUNT} unique definitions, validators, and dispatches`);
}

const CONSTRAINT_BINDINGS = Object.freeze(Object.fromEntries(
  BINDING_ROWS.map((binding) => [binding.constraintIri, binding]),
));

function finding(code, at = '$', message = '') {
  return { at, code, message };
}

function normalizeFindings(rows) {
  return rows.map((value) => finding(value.code, value.at || value.path || '$', value.message || ''));
}

function resolveQueryScenario(payload, dispatchKey) {
  const [, kind, requestId] = dispatchKey.split(':');
  const request = (payload.evaluationRequests || []).find((candidate) => candidate.requestId === requestId);
  if (!request) return [finding('RULE_QUERY_REQUEST', '$.evaluationRequests', `missing request ${requestId}`)];
  const structural = validateMarketRulesScenario(payload);
  if (structural.length > 0) return normalizeFindings(structural);
  try {
    resolveMarketRule(payload, {
      evaluationRequestVersionIri: request.versionIri,
      kind,
      referenceTime: payload.referenceTime,
    });
    return [];
  } catch (cause) {
    if (!(cause instanceof MarketRulesCqError)) throw cause;
    return [finding(cause.code, '$.resolution', cause.message)];
  }
}

function evaluateSemanticScenario(scenario) {
  const payload = decodeCanonicalEvidencePayload(scenario.payload, scenario.decimalPaths);
  switch (scenario.fixtureContract) {
    case 'foundation-account': {
      const code = validateFoundationAccountIdentity(payload);
      return code === null ? [] : [finding(code)];
    }
    case 'foundation-market-rules': {
      const code = validateFoundationMarketRules(payload);
      return code === null ? [] : [finding(code)];
    }
    case 'slice-a':
      return normalizeFindings(validateSliceA(payload));
    case 'market-data-v03':
      return normalizeFindings(validateMarketData(payload, { includeReleaseEvidence: false }));
    case 'market-rules-v03':
      return scenario.dispatchKey.startsWith('resolve:')
        ? resolveQueryScenario(payload, scenario.dispatchKey)
        : normalizeFindings(validateMarketRulesScenario(payload));
    case 'strategy-research': {
      const validator = STRATEGY_VALIDATORS[scenario.dispatchKey];
      if (typeof validator !== 'function') throw new Error(`unbound strategy dispatch ${scenario.dispatchKey}`);
      return normalizeFindings(validator(payload));
    }
    default:
      throw new Error(`unbound fixture contract ${scenario.fixtureContract}`);
  }
}

function bindingFor(constraintIri) {
  const binding = CONSTRAINT_BINDINGS[constraintIri];
  if (!binding) throw new Error(`unbound Custom constraint ${constraintIri}`);
  return binding;
}

function findingMatchesBinding(value, binding) {
  return value.code === binding.expectedCode
    && (binding.expectedAtPrefix === null || String(value.at).startsWith(binding.expectedAtPrefix));
}

module.exports = {
  BINDING_ROWS,
  CONSTRAINT_BINDINGS,
  CUSTOM_CONSTRAINT_COUNT,
  bindingFor,
  canonicalJcs,
  compareUtf8,
  evaluateSemanticScenario,
  findingMatchesBinding,
  sha256Jcs,
};
