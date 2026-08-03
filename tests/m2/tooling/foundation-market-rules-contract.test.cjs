'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { Parser } = require('n3');
const {
  loadYaml,
  mutate,
  validateFoundation,
  validateMarketRules,
  validateInstance,
} = require('../../../scripts/domain/lib/foundation-market-rules-contract.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const file = (...parts) => path.join(ROOT, ...parts);
const MARKET_RULES_MODULE = file('ontology', 'domain', 'finance', 'market-rules', 'module.yaml');

function project(script) {
  const result = spawnSync(
    process.execPath,
    [file('scripts', 'domain', script), MARKET_RULES_MODULE, '-'],
    { cwd: ROOT, encoding: 'utf8', shell: false },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.length > 0);
  return result.stdout;
}

function configureCorporateActionDates(instance, kind) {
  const scheduleIri = 'https://axiolune.ai/data/rules/corporate-action/version/sha256-e';
  const retained = instance.marketRules.clauses.filter((clause) => (
    clause.ruleVersionIri !== scheduleIri
    || !['CorporateActionDateResolutionClause', 'CorporateActionDateOrderingClause'].includes(clause.type)
  ));
  const direct = (resolvedDateRole, sourceEventDateField = resolvedDateRole) => ({
    ruleVersionIri: scheduleIri,
    type: 'CorporateActionDateResolutionClause',
    resolvedDateRole,
    sourceEventDateField,
    dateResolutionOffset: { value: '0', unit: 'https://axiolune.ai/units/business-day' },
    dateBusinessDayAdjustment: 'unadjusted',
  });
  const roles = {
    cashDividend: [
      direct('announcementDate'), direct('exDate'), direct('recordDate'), direct('paymentDate'),
    ],
    stockSplit: [
      direct('announcementDate'), direct('exDate'), direct('recordDate'), direct('effectiveDate'),
    ],
    rightsIssue: [
      direct('announcementDate'), direct('exDate'), direct('recordDate'),
      direct('electionDeadline'), direct('effectiveDate'),
      direct('subscriptionCashDueDate', 'paymentDate'),
      direct('successorDeliveryDate', 'effectiveDate'),
    ],
  }[kind];
  const ordering = {
    cashDividend: ['recordDate', 'notAfter', 'paymentDate'],
    stockSplit: ['recordDate', 'notAfter', 'effectiveDate'],
    rightsIssue: ['electionDeadline', 'notAfter', 'effectiveDate'],
  }[kind];
  const clauses = roles.map((clause, index) => ({ ...clause, sequence: index + 1 }));
  clauses.push({
    ruleVersionIri: scheduleIri,
    type: 'CorporateActionDateOrderingClause',
    sequence: clauses.length + 1,
    orderingLeftDateRole: ordering[0],
    dateOrderingOperator: ordering[1],
    orderingRightDateRole: ordering[2],
  });
  instance.marketRules.clauses = [...retained, ...clauses];
}

test('Foundation typed module satisfies the executable RFC contract with no literal pending source refs', () => {
  const result = validateFoundation(loadYaml(file(
    'ontology', 'domain', 'finance', 'foundation', 'module.yaml',
  )));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.pending, []);
});

test('Market Rules typed module closes runtime evidence with no literal pending source refs', () => {
  const result = validateMarketRules(loadYaml(MARKET_RULES_MODULE));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(result.evidence, [
    'REQUEST_SCOPE_CUSTOM',
    'RESOLVER_RUN',
    'FACT_GENERATION_RUN',
    'CANONICAL_EXTERNAL_FACT_IDENTITY',
    'PRECEDENCE_PRIORITY_AUTHORITY',
    'SYNTHETIC_NON_AUTHORITY_BOUNDARY',
  ]);
});

test('Market Rules OWL and SHACL projections are deterministic, parseable, and contain only the v0.3 corporate-action contract', () => {
  const owlFirst = project('generate-m2-owl.cjs');
  const owlSecond = project('generate-m2-owl.cjs');
  const shaclFirst = project('generate-m2-shacl.cjs');
  const shaclSecond = project('generate-m2-shacl.cjs');
  assert.equal(owlFirst, owlSecond);
  assert.equal(shaclFirst, shaclSecond);
  assert.ok(new Parser().parse(owlFirst).length > 0);
  assert.ok(new Parser().parse(shaclFirst).length > 0);
  for (const artifact of [owlFirst, shaclFirst]) {
    assert.match(artifact, /CorporateActionDistributionAssessmentMethod/);
    assert.match(artifact, /corporateActionDistributionAssessmentMethod/);
    assert.match(artifact, /CorporateActionEntitlementMode/);
    assert.doesNotMatch(artifact, /CorporateActionEntitlementBasis/);
    assert.doesNotMatch(artifact, /CorporateActionKind\/value\/(?:stockDividend|split|spinOff|merger|tenderOffer)/);
  }
});

test('positive Foundation and Market Rules instance fixture is accepted', () => {
  const fixture = loadYaml(file(
    'tests', 'm2', 'fixtures', 'positive', 'foundation-market-rules-contract.yaml',
  )).fixtures[0];
  assert.equal(validateInstance(fixture.instance), null);
});

test('all three frozen corporate-action kinds and the no-boundary/official-percentage branches are executable', async (context) => {
  const base = loadYaml(file(
    'tests', 'm2', 'fixtures', 'positive', 'foundation-market-rules-contract.yaml',
  )).fixtures[0].instance;
  const schedule = (instance) => instance.marketRules.rules[4];
  const method = (instance) => instance.marketRules.distributionAssessmentMethods[0];

  await context.test('stockSplit uses a split-calculated method', () => {
    const instance = structuredClone(base);
    schedule(instance).corporateActionKind = 'stockSplit';
    method(instance).inputKind = 'splitCalculated';
    configureCorporateActionDates(instance, 'stockSplit');
    assert.equal(validateInstance(instance), null);
  });

  await context.test('rightsIssue freezes both due dates and non-transferable direct subscription', () => {
    const instance = structuredClone(base);
    schedule(instance).corporateActionKind = 'rightsIssue';
    schedule(instance).nonTransferableDirectSubscription = true;
    method(instance).inputKind = 'rightsCalculated';
    configureCorporateActionDates(instance, 'rightsIssue');
    assert.equal(validateInstance(instance), null);
  });

  await context.test('a schedule with no percentage interval binds no method', () => {
    const instance = structuredClone(base);
    delete schedule(instance).distributionPercentageLowerBound;
    delete schedule(instance).distributionPercentageLowerInclusive;
    delete schedule(instance).distributionAssessmentMethodVersionIri;
    assert.equal(validateInstance(instance), null);
  });

  await context.test('official percentage consumes no market price', () => {
    const instance = structuredClone(base);
    method(instance).inputKind = 'officialPercentage';
    method(instance).priceSelection = 'notApplicable';
    method(instance).requiresMarketPrice = false;
    delete method(instance).requiredPriceKindIri;
    assert.equal(validateInstance(instance), null);
  });
});

test('corporate-action schedule and method cross-branch contradictions fail closed', async (context) => {
  const base = loadYaml(file(
    'tests', 'm2', 'fixtures', 'positive', 'foundation-market-rules-contract.yaml',
  )).fixtures[0].instance;
  const schedule = (instance) => instance.marketRules.rules[4];
  const method = (instance) => instance.marketRules.distributionAssessmentMethods[0];

  await context.test('method without percentage interval', () => {
    const instance = structuredClone(base);
    delete schedule(instance).distributionPercentageLowerBound;
    delete schedule(instance).distributionPercentageLowerInclusive;
    assert.equal(validateInstance(instance), 'corporate-action-method-interval-iff');
  });

  await context.test('wrong method input for kind', () => {
    const instance = structuredClone(base);
    method(instance).inputKind = 'rightsCalculated';
    assert.equal(validateInstance(instance), 'corporate-action-assessment-method-kind');
  });

  await context.test('required resolved date coverage is closed by kind', () => {
    const instance = structuredClone(base);
    instance.marketRules.clauses = instance.marketRules.clauses.filter(
      (clause) => clause.resolvedDateRole !== 'exDate',
    );
    assert.equal(validateInstance(instance), 'corporate-action-date-resolution-coverage');
  });

  await context.test('one output date role cannot be resolved twice', () => {
    const instance = structuredClone(base);
    const existing = instance.marketRules.clauses.find(
      (clause) => clause.resolvedDateRole === 'recordDate',
    );
    instance.marketRules.clauses.push({ ...structuredClone(existing), sequence: 99 });
    assert.equal(validateInstance(instance), 'corporate-action-date-resolution-duplicate');
  });

  await context.test('date ordering compares two distinct resolved roles', () => {
    const instance = structuredClone(base);
    const ordering = instance.marketRules.clauses.find(
      (clause) => clause.type === 'CorporateActionDateOrderingClause',
    );
    ordering.orderingRightDateRole = ordering.orderingLeftDateRole;
    assert.equal(validateInstance(instance), 'corporate-action-date-ordering-clause');
  });

  await context.test('rightsIssue cannot make subscription rights transferable', () => {
    const instance = structuredClone(base);
    schedule(instance).corporateActionKind = 'rightsIssue';
    schedule(instance).nonTransferableDirectSubscription = false;
    method(instance).inputKind = 'rightsCalculated';
    configureCorporateActionDates(instance, 'rightsIssue');
    assert.equal(validateInstance(instance), 'corporate-action-rights-v03-contract');
  });
});

test('every negative fixture fails with its exact semantic violation', async (context) => {
  const positive = loadYaml(file(
    'tests', 'm2', 'fixtures', 'positive', 'foundation-market-rules-contract.yaml',
  ));
  const byId = new Map(positive.fixtures.map((fixture) => [fixture.id, fixture]));
  const negative = loadYaml(file(
    'tests', 'm2', 'fixtures', 'negative', 'foundation-market-rules-contract.yaml',
  ));
  for (const testCase of negative.cases) {
    await context.test(testCase.id, () => {
      const base = byId.get(testCase.baseFixtureId);
      assert.ok(base);
      assert.equal(
        validateInstance(mutate(base.instance, testCase.mutation)),
        testCase.expectedViolation,
      );
    });
  }
});
