'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  BINDING_ROWS,
  CUSTOM_CONSTRAINT_COUNT,
  canonicalJcs,
  compareUtf8,
  evaluateSemanticScenario,
  findingMatchesBinding,
} = require('./foundation-market-strategy-custom-validators.cjs');
const {
  loadFixture,
} = require('./strict-fixture-loader.cjs');
const {
  encodeCanonicalEvidencePayload,
} = require('./foundation-market-strategy-payload-codec.cjs');
const {
  mutate: mutateAccount,
} = require('../test-foundation-account-identity.cjs');
const {
  mutate: mutateFoundationRules,
} = require('./foundation-market-rules-contract.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0/foundation-market-strategy-custom';
const PROFILE_ROOT = path.join(
  ROOT,
  'scripts',
  'domain',
  'foundation-market-strategy-custom-profile',
  'v0.3.0',
);

const PATHS = Object.freeze({
  closure: path.join(PROFILE_ROOT, 'implementation-closure.json'),
  discovery: path.join(PROFILE_ROOT, 'discovery-contract.json'),
  evidenceSchema: path.join(PROFILE_ROOT, 'evidence.schema.json'),
  generator: path.join(ROOT, 'scripts/domain/generate-foundation-market-strategy-custom-profile.cjs'),
  implementation: path.join(ROOT, 'scripts/domain/lib/foundation-market-strategy-custom-validators.cjs'),
  inputContract: path.join(PROFILE_ROOT, 'input-contract.json'),
  outputContract: path.join(PROFILE_ROOT, 'output-contract.json'),
  profile: path.join(ROOT, 'scripts/domain/lib/foundation-market-strategy-custom-profile.cjs'),
  runner: path.join(ROOT, 'scripts/domain/run-foundation-market-strategy-custom-runtime.cjs'),
  vectors: path.join(PROFILE_ROOT, 'test-vectors.json'),
  worker: path.join(ROOT, 'scripts/domain/foundation-market-strategy-custom-worker.cjs'),
});

const FIXTURES = Object.freeze({
  accountNegative: path.join(ROOT, 'tests/m2/fixtures/negative/foundation-account-identity.yaml'),
  accountPositive: path.join(ROOT, 'tests/m2/fixtures/positive/foundation-account-identity.yaml'),
  foundationRulesNegative: path.join(ROOT, 'tests/m2/fixtures/negative/foundation-market-rules-contract.yaml'),
  foundationRulesPositive: path.join(ROOT, 'tests/m2/fixtures/positive/foundation-market-rules-contract.yaml'),
  marketData: path.join(ROOT, 'tests/m2/fixtures/market-data-v03'),
  marketRules: path.join(ROOT, 'tests/m2/fixtures/market-rules-v03'),
  sliceA: path.join(ROOT, 'tests/m2/fixtures/slice-a'),
  strategyNegative: path.join(ROOT, 'tests/m2/fixtures/strategy-research/negative.yaml'),
  strategyPositive: path.join(ROOT, 'tests/m2/fixtures/strategy-research/positive.yaml'),
});

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function source(file) {
  return {
    digest: sha256(fs.readFileSync(file)),
    ref: { kind: 'path', path: relative(file), root: 'sourceTree' },
  };
}

function loadYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

function loadResolved(directory, name) {
  return loadFixture(path.join(directory, name), { rootDirectory: directory });
}

function byId(rows, label) {
  const result = new Map();
  for (const row of rows || []) {
    if (!row || typeof row.id !== 'string' || result.has(row.id)) {
      throw new Error(`${label} fixture IDs must be unique strings`);
    }
    result.set(row.id, row);
  }
  return result;
}

function accountCase(positiveMap, negativeMap, caseId) {
  const testCase = negativeMap.get(caseId);
  if (!testCase) throw new Error(`missing Foundation account negative ${caseId}`);
  const base = positiveMap.get(testCase.baseFixtureId);
  if (!base) throw new Error(`missing Foundation account base ${testCase.baseFixtureId}`);
  return mutateAccount(base.instance, testCase.mutation);
}

function foundationRulesCase(positiveMap, negativeMap, caseId) {
  const testCase = negativeMap.get(caseId);
  if (!testCase) throw new Error(`missing Foundation/Rules negative ${caseId}`);
  const base = positiveMap.get(testCase.baseFixtureId);
  if (!base) throw new Error(`missing Foundation/Rules base ${testCase.baseFixtureId}`);
  return mutateFoundationRules(base.instance, testCase.mutation);
}

const NEGATIVE_FIXTURE = Object.freeze({
  IdentifierSchemeCompatibilityMatrix: ['account', 'assignment-subject-type-incompatible-with-scheme'],
  IdentifierAuthorizationCoverage: ['account', 'assignment-without-assigning-authorization'],
  IdentifierGlobalUniquenessConflict: ['account', 'global-overlap-without-explicit-conflict'],
  FinancialAccountIdentityIntegrity: ['account', 'account-identity-type-drift-creates-new-logical-account'],
  ISO4217RegistryEntryIntegrity: ['foundationRules', 'invalid-iso4217-alpha-code'],
  CurrencyUsageIntegrity: ['foundationRules', 'currency-usage-without-jurisdiction'],

  InstrumentIssuanceContract: ['slice', 'negative-issuance-offering-join.yaml'],
  InstrumentListingIdentityContract: ['slice', 'negative-listing-scheme-authorization.yaml'],
  InstrumentListingOfferingContract: ['slice', 'negative-offering-listing-join.yaml'],
  InstrumentListingIntervalContract: ['slice', 'negative-listing-business-interval.yaml'],
  DirectUnitPriceQuotationRule: ['slice', 'negative-quotation-kind.yaml'],
  MICRegistryEntryContract: ['slice', 'negative-mic-segment.yaml'],
  TradingCalendarIdentityContract: ['slice', 'negative-calendar-identity.yaml'],
  TradingSessionOccurrenceContract: ['slice', 'negative-session-occurrence.yaml'],
  TradingCalendarExceptionContract: ['slice', 'negative-calendar-exception.yaml'],
  OTCTradingContextReferenceContract: ['slice', 'negative-otc-provider-one-nanosecond-future.yaml'],

  MarketDataStreamIdentityContract: ['marketData', 'negative-arbitrary-ordering-tuple.yaml'],
  BarSpecificationContract: ['marketData', 'negative-bar-specification-contract.yaml'],
  ObservationIdentityAndRevisionContract: ['marketData', 'negative-revision-fields.yaml'],
  ObservationContextQuotationContract: ['marketData', 'negative-wrong-security-same-currency.yaml'],
  PriceKindCompatibilityContract: ['marketData', 'negative-price-kind-bid.yaml'],
  QuoteObservationContract: ['marketData', 'negative-quote-size.yaml'],
  TradeObservationContract: ['marketData', 'negative-trade-size.yaml'],
  TradeBarContract: ['marketData', 'negative-trade-bar-ohlc.yaml'],
  QuoteBarContract: ['marketData', 'negative-quote-bar-ohlc.yaml'],
  BarInstanceBranchContract: ['marketData', 'negative-time-bar-branch.yaml'],
  MarketDataQualityFindingContract: ['marketData', 'negative-false-finding.yaml'],
  FXRateObservationContract: ['marketData', 'negative-stored-fx-inverse.yaml'],
  ThreeAxisPITContract: ['marketData', 'negative-availability-missing.yaml'],
  ThreeAxisObjectPITContract: ['marketData', 'negative-object-availability-missing.yaml'],

  RuleApplicabilityRequiresExplicitScope: ['foundationRules', 'applicability-has-no-explicit-scope'],
  RuleApplicabilityMustMatchRequest: ['foundationRules', 'every-authored-scope-must-match-request'],
  RulePriorityComparability: ['marketRules', 'negative-forged-priority-source.yaml'],
  RuleParameterExclusiveOneOf: ['foundationRules', 'rule-parameter-has-no-value-branch'],
  RuleClauseRangeIntegrity: ['foundationRules', 'ordered-clauses-must-not-overlap'],
  RuleSubtypeClauseCompatibility: ['foundationRules', 'rule-kind-closes-its-legal-clause-subtypes'],
  PriceLimitClauseExclusiveBoundary: ['foundationRules', 'price-limit-clause-requires-exactly-one-boundary'],
  RulePrecedenceIntegrity: ['foundationRules', 'active-precedence-must-be-acyclic'],
  RuleConflictNoSilentWinner: ['marketRules', 'negative-missing-materialized-conflict.yaml'],
  RuleEvaluationRequestIntegrity: ['marketRules', 'negative-request-context-order.yaml'],
  CorporateActionScheduleRuleIntegrity: ['foundationRules', 'corporate-action-kind-is-frozen-to-three-members'],
  CorporateActionDistributionAssessmentMethodIntegrity: ['foundationRules', 'method-price-fields-are-an-iff-contract'],
  CorporateActionEntitlementClauseIntegrity: ['foundationRules', 'schedule-rule-needs-entitlement-clause'],
  CorporateActionDateResolutionClauseIntegrity: ['foundationRules', 'date-resolution-clause-requires-complete-adjustment'],
  CorporateActionDateOrderingClauseIntegrity: ['foundationRules', 'date-ordering-clause-requires-distinct-roles'],

  SignalGeneratorEvidenceContract: ['strategy', 'reject-strategy-without-explicit-factor-dependency'],
  RunInputClosureContract: ['strategy', 'reject-backtest-input-context-not-strictly-prior'],
  ResearchRunContract: ['strategy', 'reject-research-run-with-backtest-kind'],
  MetricDefinitionContract: ['strategy', 'reject-metric-definition-with-unlocked-formula'],
  CalculationContextContract: ['strategy', 'reject-calculation-context-with-unpaired-benchmark'],
  SignalContract: ['strategy', 'reject-signal-strength-outside-unit-interval'],
  FactorRevisionContract: ['strategy', 'reject-qlib-storage-pointer-as-domain-relation'],
  BacktestStatusContract: ['strategy', 'reject-terminal-status-transition'],
  PerformanceRevisionContract: ['strategy', 'reject-performance-revision-with-wrong-prior-version'],
  PositionAttributionContract: ['strategy', 'reject-attribution-with-two-position-subjects'],
});

function localName(iri) {
  return iri.slice(iri.lastIndexOf('/') + 1);
}

function scenario(binding, payload, polarity) {
  const encoded = encodeCanonicalEvidencePayload(structuredClone(payload));
  return {
    decimalPaths: encoded.decimalPaths,
    dispatchKey: binding.dispatchKey,
    fixtureContract: binding.fixtureContract,
    payload: encoded.payload,
    scenarioId: `${localName(binding.constraintIri)}-${polarity}`,
    schemaVersion: '1.0',
  };
}

function buildVectorSet() {
  const accountPositiveDocument = loadYaml(FIXTURES.accountPositive);
  const accountNegativeDocument = loadYaml(FIXTURES.accountNegative);
  const foundationPositiveDocument = loadYaml(FIXTURES.foundationRulesPositive);
  const foundationNegativeDocument = loadYaml(FIXTURES.foundationRulesNegative);
  const strategyPositiveDocument = loadYaml(FIXTURES.strategyPositive);
  const strategyNegativeDocument = loadYaml(FIXTURES.strategyNegative);
  const accountPositive = byId(accountPositiveDocument.fixtures, 'Foundation account positive');
  const accountNegative = byId(accountNegativeDocument.cases, 'Foundation account negative');
  const foundationPositive = byId(foundationPositiveDocument.fixtures, 'Foundation/Rules positive');
  const foundationNegative = byId(foundationNegativeDocument.cases, 'Foundation/Rules negative');
  const strategyPositive = byId(strategyPositiveDocument.cases, 'Strategy positive');
  const strategyNegative = byId(strategyNegativeDocument.cases, 'Strategy negative');
  const slicePositive = loadResolved(FIXTURES.sliceA, 'positive-market-instrument-contract.yaml');
  const marketDataPositive = loadResolved(FIXTURES.marketData, 'positive-complete.yaml');
  const marketDataFindingPositive = loadResolved(FIXTURES.marketData, 'positive-crossed-finding.yaml');
  const marketRulesPositive = loadResolved(FIXTURES.marketRules, 'positive-cq-execution.yaml');
  const foundationBase = foundationPositive.get('iso4217-and-scoped-executable-market-rules').instance;
  const accountBase = accountPositive.get('account-type-change-preserves-logical-identity').instance;
  const accountConflictBase = accountPositive.get('global-overlap-is-an-explicit-conflict').instance;

  const positiveStrategyId = {
    attribution: 'position-attribution-with-quantity-value',
    backtest: 'closed-backtest-configuration',
    calculationContext: 'locked-daily-calculation-context',
    factorRevision: 'factor-domain-revision-chain',
    generatorDefinition: 'strategy-definition-with-explicit-factor-dependency',
    metricDefinition: 'locked-sharpe-metric-definition',
    performance: 'sharpe-performance-with-complete-context',
    performanceRevision: 'performance-knowledge-revision-with-separate-closures',
    researchRun: 'closed-research-run',
    signal: 'signal-canonical-observation',
    statusEvent: 'immutable-backtest-running-event',
  };

  const vectors = [];
  for (const binding of BINDING_ROWS) {
    const name = localName(binding.constraintIri);
    let positivePayload;
    let positiveSources;
    if (binding.fixtureContract === 'foundation-account') {
      positivePayload = name === 'IdentifierGlobalUniquenessConflict' ? accountConflictBase : accountBase;
      positiveSources = [source(FIXTURES.accountPositive)];
    } else if (binding.fixtureContract === 'foundation-market-rules') {
      positivePayload = foundationBase;
      positiveSources = [source(FIXTURES.foundationRulesPositive)];
    } else if (binding.fixtureContract === 'slice-a') {
      positivePayload = slicePositive;
      positiveSources = [source(path.join(FIXTURES.sliceA, 'positive-market-instrument-contract.yaml'))];
    } else if (binding.fixtureContract === 'market-data-v03') {
      const finding = name === 'MarketDataQualityFindingContract';
      positivePayload = finding ? marketDataFindingPositive : marketDataPositive;
      positiveSources = [source(path.join(FIXTURES.marketData, finding ? 'positive-crossed-finding.yaml' : 'positive-complete.yaml'))];
    } else if (binding.fixtureContract === 'market-rules-v03') {
      positivePayload = marketRulesPositive;
      positiveSources = [source(path.join(FIXTURES.marketRules, 'positive-cq-execution.yaml'))];
    } else if (binding.fixtureContract === 'strategy-research') {
      const row = strategyPositive.get(positiveStrategyId[binding.dispatchKey]);
      if (!row) throw new Error(`missing positive Strategy case for ${binding.dispatchKey}`);
      positivePayload = row.payload;
      positiveSources = [source(FIXTURES.strategyPositive)];
    } else {
      throw new Error(`unhandled positive fixture contract ${binding.fixtureContract}`);
    }

    let negativePayload;
    let negativeSources;
    let mutation = null;
    if (name === 'BacktestConfigurationContract') {
      negativePayload = structuredClone(strategyPositive.get('closed-backtest-configuration').payload);
      negativePayload.simulationTo = negativePayload.simulationFrom;
      negativeSources = [source(FIXTURES.strategyPositive)];
      mutation = { op: 'replace', path: '/simulationTo', valueFrom: '/simulationFrom' };
    } else if (name === 'PerformanceValueContract') {
      negativePayload = structuredClone(strategyPositive.get('sharpe-performance-with-complete-context').payload);
      negativePayload.metric.valueKind = 'money';
      negativeSources = [source(FIXTURES.strategyPositive)];
      mutation = { op: 'replace', path: '/metric/valueKind', value: 'money' };
    } else {
      const specification = NEGATIVE_FIXTURE[name];
      if (!specification) throw new Error(`missing negative fixture binding for ${name}`);
      const [family, id] = specification;
      if (family === 'account') {
        negativePayload = accountCase(accountPositive, accountNegative, id);
        negativeSources = [source(FIXTURES.accountPositive), source(FIXTURES.accountNegative)];
      } else if (family === 'foundationRules') {
        negativePayload = foundationRulesCase(foundationPositive, foundationNegative, id);
        negativeSources = [source(FIXTURES.foundationRulesPositive), source(FIXTURES.foundationRulesNegative)];
      } else if (family === 'slice') {
        negativePayload = loadResolved(FIXTURES.sliceA, id);
        negativeSources = [source(path.join(FIXTURES.sliceA, 'positive-market-instrument-contract.yaml')), source(path.join(FIXTURES.sliceA, id))];
      } else if (family === 'marketData') {
        negativePayload = loadResolved(FIXTURES.marketData, id);
        negativeSources = [source(path.join(FIXTURES.marketData, 'positive-complete.yaml')), source(path.join(FIXTURES.marketData, id))];
      } else if (family === 'marketRules') {
        negativePayload = loadResolved(FIXTURES.marketRules, id);
        negativeSources = [source(path.join(FIXTURES.marketRules, 'positive-cq-execution.yaml')), source(path.join(FIXTURES.marketRules, id))];
      } else if (family === 'strategy') {
        const row = strategyNegative.get(id);
        if (!row) throw new Error(`missing Strategy negative ${id}`);
        negativePayload = row.payload;
        negativeSources = [source(FIXTURES.strategyNegative)];
      } else {
        throw new Error(`unhandled negative fixture family ${family}`);
      }
    }

    const acceptedScenario = scenario(binding, positivePayload, 'positive');
    const negativeScenario = scenario(binding, negativePayload, 'negative');
    const acceptedFindings = evaluateSemanticScenario(acceptedScenario);
    if (acceptedFindings.length !== 0) {
      throw new Error(`${binding.constraintIri} positive fixture rejected: ${JSON.stringify(acceptedFindings)}`);
    }
    const negativeFindings = evaluateSemanticScenario(negativeScenario);
    const owners = new Set();
    for (const observed of negativeFindings) {
      const findingOwners = [];
      for (const candidate of BINDING_ROWS) {
        if (findingMatchesBinding(observed, candidate)) findingOwners.push(candidate.constraintIri);
      }
      if (findingOwners.length !== 1 || findingOwners[0] !== binding.constraintIri) {
        throw new Error(
          `${binding.constraintIri} has unowned/cross-owned negative finding ${JSON.stringify(observed)}: ${JSON.stringify(findingOwners)}`,
        );
      }
      owners.add(findingOwners[0]);
    }
    if (negativeFindings.length === 0
        || owners.size !== 1
        || !owners.has(binding.constraintIri)
        || !negativeFindings.some((observed) => findingMatchesBinding(observed, binding))) {
      throw new Error(
        `${binding.constraintIri} negative owner closure failed: findings=${JSON.stringify(negativeFindings)} owners=${JSON.stringify([...owners])}`,
      );
    }
    vectors.push({
      accepted: {
        expectedOutcome: 'accepted',
        fixtureSources: positiveSources.sort((left, right) => compareUtf8(left.ref.path, right.ref.path)),
        scenario: acceptedScenario,
      },
      constraintIri: binding.constraintIri,
      dispatchDigest: binding.dispatchDigest,
      negative: {
        expectedCode: binding.expectedCode,
        expectedOutcome: 'rejected',
        fixtureSources: negativeSources.sort((left, right) => compareUtf8(left.ref.path, right.ref.path)),
        ...(mutation ? { mutation } : {}),
        observedFindingDigest: sha256(Buffer.from(canonicalJcs(negativeFindings), 'utf8')),
        scenario: negativeScenario,
      },
      validatorId: binding.validatorId,
    });
  }
  return {
    constraintDefinitionCount: CUSTOM_CONSTRAINT_COUNT,
    contextContractCount: 6,
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
    vectors,
  };
}

module.exports = {
  FIXTURES,
  PATHS,
  PROFILE_REF,
  PROFILE_ROOT,
  ROOT,
  buildVectorSet,
  relative,
  sha256,
  source,
};
