'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { loadFixture } = require('../lib/strict-fixture-loader.cjs');
const {
  buildClosureAssertionIri,
  buildRuleConflictIdentity,
  framedSetDigest,
  resolveMarketRule,
  validateMarketRulesScenario,
} = require('../lib/market-rules-cq.cjs');

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'tests', 'm2', 'fixtures', 'market-rules-v03');
const scenario = loadFixture(path.join(FIXTURE_DIR, 'positive-cq-execution.yaml'), {
  rootDirectory: FIXTURE_DIR,
});

function requestVersion(requestId, source = scenario) {
  const request = source.evaluationRequests.find((row) => row.requestId === requestId);
  assert.ok(request, `missing request fixture ${requestId}`);
  return request.versionIri;
}

function exactQuery(kind, requestId, source = scenario, referenceTime = source.referenceTime) {
  return {
    kind,
    evaluationRequestVersionIri: requestVersion(requestId, source),
    referenceTime,
  };
}

test('focused Market Rules scenario is structurally closed', () => {
  assert.deepEqual(validateMarketRulesScenario(scenario), []);
});

test('CQ-MR1 resolves the current T+1 settlement rule at explicit pivots', () => {
  const result = resolveMarketRule(scenario, exactQuery('settlementCycle', 'mr1-alpha-current'));
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.evaluationRequestVersionIri, requestVersion('mr1-alpha-current'));
  assert.equal(result.ruleVersionIri, 'urn:rule:settlement-main:version:1');
  assert.deepEqual(
    result.result.clauses[0].settlementCycle,
    { value: 1, unit: 'urn:unit:business-day' },
  );
});

test('CQ-MR1 rejects a non-PIT scope closure and future pivots', () => {
  assert.throws(
    () => resolveMarketRule(
      scenario,
      exactQuery('settlementCycle', 'mr1-alpha-before-valid'),
    ),
    (error) => error.code === 'RULE_QUERY_SCOPE_NOT_ELIGIBLE',
  );
  assert.throws(
    () => resolveMarketRule(
      scenario,
      exactQuery(
        'settlementCycle',
        'mr1-alpha-current',
        scenario,
        '2026-07-15T11:59:59Z',
      ),
    ),
    (error) => error.code === 'RULE_QUERY_FUTURE',
  );
});

test('CQ-MR1 expands a PIT-eligible listing through its segment facility to the operating venue', () => {
  const result = resolveMarketRule(
    scenario,
    exactQuery('settlementCycle', 'mr1-listing-alpha'),
  );
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.ruleVersionIri, 'urn:rule:settlement-main:version:1');
});

test('CQ-MR1 rejects a listing when its indirectly required segment closes at the pivot', () => {
  const closed = loadFixture(path.join(FIXTURE_DIR, 'negative-listing-segment-closure.yaml'), {
    rootDirectory: FIXTURE_DIR,
  });
  assert.deepEqual(validateMarketRulesScenario(closed), []);
  assert.throws(
    () => resolveMarketRule(closed, exactQuery('settlementCycle', 'mr1-listing-alpha', closed)),
    (error) => error.code === 'RULE_QUERY_SCOPE_NOT_ELIGIBLE',
  );
});

test('CQ-MR1 rejects listing closure exactly at its half-open availability end', () => {
  const closed = structuredClone(scenario);
  const closure = {
    targetVersionIri: 'urn:listing:alpha-xnas:version:1',
    axis: 'availability',
    closedAt: '2026-07-15T12:00:00Z',
    causeKind: 'sourceWithdrawal',
    evidenceRef: 'urn:evidence:authority-b-source-withdrawal',
    generatingContextRef: 'urn:validation-run:market-rules-v03',
  };
  closure.id = buildClosureAssertionIri(closure);
  closed.closures.push(closure);
  assert.throws(
    () => resolveMarketRule(closed, exactQuery('settlementCycle', 'mr1-listing-alpha', closed)),
    (error) => error.code === 'RULE_QUERY_SCOPE_NOT_ELIGIBLE',
  );
});

test('CQ-MR2 applies reviewed precedence before numeric priority', () => {
  const result = resolveMarketRule(scenario, exactQuery('priceLimit', 'mr2-alpha'));
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.ruleVersionIri, 'urn:rule:price-primary:version:1');
  assert.equal(result.result.clauses[0].priceLimitPercentage.value, '0.10');
});

test('CQ-MR2 permits a precedence direction reversal when the two edges never share a PIT', () => {
  const reversal = loadFixture(
    path.join(FIXTURE_DIR, 'positive-precedence-temporal-reversal.yaml'),
    { rootDirectory: FIXTURE_DIR },
  );
  assert.deepEqual(validateMarketRulesScenario(reversal), []);
  const result = resolveMarketRule(reversal, exactQuery('priceLimit', 'mr2-alpha', reversal));
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.ruleVersionIri, 'urn:rule:price-secondary:version:1');
});

test('CQ-MR2 evaluates precedence closures only after their generating Run is reference-visible', () => {
  const replay = loadFixture(
    path.join(FIXTURE_DIR, 'positive-precedence-reference-visible-closure.yaml'),
    { rootDirectory: FIXTURE_DIR },
  );
  assert.deepEqual(validateMarketRulesScenario(replay), []);
  assert.throws(
    () => resolveMarketRule(
      replay,
      exactQuery('priceLimit', 'mr2-alpha', replay, '2026-07-20T00:00:00Z'),
    ),
    (error) => error.code === 'RULE_PRECEDENCE_CYCLE',
  );
  const afterRun = resolveMarketRule(
    replay,
    exactQuery('priceLimit', 'mr2-alpha', replay, '2026-07-31T00:00:00Z'),
  );
  assert.equal(afterRun.outcome, 'resolved');
  assert.equal(afterRun.ruleVersionIri, 'urn:rule:price-secondary:version:1');
});

test('CQ-MR2 preserves the one-nanosecond Run visibility boundary', () => {
  const replay = loadFixture(
    path.join(FIXTURE_DIR, 'positive-precedence-reference-visible-closure.yaml'),
    { rootDirectory: FIXTURE_DIR },
  );
  const generatingRun = replay.runRecords.find(
    (row) => row.runRef === 'urn:validation-run:market-rules-v03',
  );
  assert.ok(generatingRun);
  generatingRun.completedAt = '2026-07-30T00:00:00.000000001Z';
  assert.deepEqual(validateMarketRulesScenario(replay), []);

  assert.throws(
    () => resolveMarketRule(
      replay,
      exactQuery('priceLimit', 'mr2-alpha', replay, '2026-07-30T00:00:00Z'),
    ),
    (error) => error.code === 'RULE_PRECEDENCE_CYCLE',
  );
  const atRunCompletion = resolveMarketRule(
    replay,
    exactQuery('priceLimit', 'mr2-alpha', replay, '2026-07-30T00:00:00.000000001Z'),
  );
  assert.equal(atRunCompletion.outcome, 'resolved');
  assert.equal(atRunCompletion.ruleVersionIri, 'urn:rule:price-secondary:version:1');
});

test('Market Rules time parsing rejects over-precision and invalid calendar instants', () => {
  assert.throws(
    () => resolveMarketRule(
      scenario,
      exactQuery(
        'settlementCycle',
        'mr1-alpha-current',
        scenario,
        '2026-07-30T00:00:00.0000000001Z',
      ),
    ),
    (error) => error.code === 'RULE_QUERY_INTEGRITY',
  );
  assert.throws(
    () => resolveMarketRule(
      scenario,
      exactQuery('settlementCycle', 'mr1-alpha-current', scenario, '2026-02-30T00:00:00Z'),
    ),
    (error) => error.code === 'RULE_QUERY_INTEGRITY',
  );
});

test('CQ-MR2 applies specificity before priority and priority only inside an identical group', () => {
  const specificity = structuredClone(scenario);
  specificity.precedence = [];
  specificity.applicabilities[3].scopes = {
    venue: 'urn:facility:xnas:version:1',
  };
  const specific = resolveMarketRule(specificity, exactQuery('priceLimit', 'mr2-alpha', specificity));
  assert.equal(specific.ruleVersionIri, 'urn:rule:price-primary:version:1');

  const priority = structuredClone(scenario);
  priority.precedence = [];
  const prioritized = resolveMarketRule(priority, exactQuery('priceLimit', 'mr2-alpha', priority));
  assert.equal(prioritized.ruleVersionIri, 'urn:rule:price-secondary:version:1');
});

for (const axis of [
  'listing', 'instrument', 'segment', 'venue', 'account-type', 'jurisdiction',
]) {
  test(`CQ-MR2 executes the ${axis} specificity position`, () => {
    const focused = loadFixture(
      path.join(FIXTURE_DIR, `positive-specificity-${axis}.yaml`),
      { rootDirectory: FIXTURE_DIR },
    );
    assert.deepEqual(validateMarketRulesScenario(focused), []);
    const result = resolveMarketRule(
      focused,
      exactQuery('priceLimit', 'mr2-alpha', focused),
    );
    assert.equal(result.outcome, 'resolved');
    assert.equal(result.ruleVersionIri, 'urn:rule:price-primary:version:1');
  });
}

test('CQ-MR2 does not admit an ineligible exact scope version despite a shared logical anchor', () => {
  const normalized = structuredClone(scenario);
  normalized.precedence = [];
  normalized.applicabilities[3].scopes.instrument = 'urn:instrument:alpha:version:0';
  const result = resolveMarketRule(normalized, exactQuery('priceLimit', 'mr2-alpha', normalized));
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.ruleVersionIri, 'urn:rule:price-primary:version:1');
});

test('CQ-MR2 expands a PIT-eligible segment to its exact operating venue', () => {
  const result = resolveMarketRule(
    scenario,
    exactQuery('priceLimit', 'mr2-segment-alpha'),
  );
  assert.equal(result.outcome, 'resolved');
  assert.equal(result.ruleVersionIri, 'urn:rule:price-primary:version:1');
});

test('CQ-MR2 returns typed conflict across incomparable authorities', () => {
  const result = resolveMarketRule(scenario, exactQuery('priceLimit', 'mr2-conflict-beta'));
  const ids = [
    'urn:applicability:price-conflict-a:version:1',
    'urn:applicability:price-conflict-b:version:1',
  ];
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.evaluationRequestVersionIri, requestVersion('mr2-conflict-beta'));
  assert.equal(
    result.conflictVersionIri,
    'https://axiolune.ai/data/rule-conflict/sha256-cc7178f296464abd7fe23e41e935c7b6d4d342f0d861b98723ab1a1270859bcf/version/sha256-cb9dfd3f81827fc0ee3ec3f0073d321868afdecdda82f30ab752193ba550d355',
  );
  assert.deepEqual(result.conflict.candidateApplicabilityVersionIris, ids);
  assert.equal(
    result.conflict.ruleConflictKind,
    'https://axiolune.ai/ontology/finance/market-rules/RuleConflictKind/value/incomparableAuthorities',
  );
  assert.equal(result.conflict.generatingContextRef, 'urn:run:market-rules-resolver-v03');
  assert.ok(result.conflict.axes && result.conflict.provenance);
});

test('CQ-MR2 distinguishes incompatible results under one authority', () => {
  const sameAuthority = structuredClone(scenario);
  const candidate = sameAuthority.applicabilities.find(
    (row) => row.versionIri === 'urn:applicability:price-conflict-b:version:1',
  );
  candidate.sourceLogicalIri = 'urn:authority:a';
  candidate.provenance.source = 'urn:authority:a';
  sameAuthority.ruleConflicts[0].ruleConflictKind =
    'https://axiolune.ai/ontology/finance/market-rules/RuleConflictKind/value/incompatibleResults';
  const result = resolveMarketRule(
    sameAuthority,
    exactQuery('priceLimit', 'mr2-conflict-beta', sameAuthority),
  );
  assert.equal(result.outcome, 'conflict');
  assert.equal(
    result.conflict.ruleConflictKind,
    'https://axiolune.ai/ontology/finance/market-rules/RuleConflictKind/value/incompatibleResults',
  );
});

test('CQ-MR2 compares canonical typed decimals before declaring conflict', () => {
  const equivalent = structuredClone(scenario);
  equivalent.precedence = [];
  equivalent.applicabilities[3].priority = 10;
  equivalent.clauses[3].priceLimitPercentage.value = '0.100';
  const result = resolveMarketRule(equivalent, exactQuery('priceLimit', 'mr2-alpha', equivalent));
  assert.equal(result.outcome, 'resolved');
  assert.deepEqual(result.equivalentApplicabilityVersionIris, [
    'urn:applicability:price-primary:version:1',
    'urn:applicability:price-secondary:version:1',
  ]);
});

test('CQ-MR2 rejects an incompatible survivor set without its materialized conflict', () => {
  const missing = loadFixture(path.join(FIXTURE_DIR, 'negative-missing-materialized-conflict.yaml'), {
    rootDirectory: FIXTURE_DIR,
  });
  assert.deepEqual(validateMarketRulesScenario(missing), []);
  assert.throws(
    () => resolveMarketRule(missing, exactQuery('priceLimit', 'mr2-conflict-beta', missing)),
    (error) => error.code === 'RULE_CONFLICT_REQUIRED',
  );
});

test('CQ-MR2 rejects a materialized conflict for a request with a normal winner', () => {
  const spurious = loadFixture(path.join(FIXTURE_DIR, 'negative-spurious-materialized-conflict.yaml'), {
    rootDirectory: FIXTURE_DIR,
  });
  assert.deepEqual(validateMarketRulesScenario(spurious), []);
  assert.throws(
    () => resolveMarketRule(spurious, exactQuery('priceLimit', 'mr2-alpha', spurious)),
    (error) => error.code === 'RULE_CONFLICT_SPURIOUS',
  );
});

test('CQ-MR2 rejects a structurally valid conflict whose roles are not the computed survivors', () => {
  const mismatch = structuredClone(scenario);
  const conflict = mismatch.ruleConflicts[0];
  conflict.candidateApplicabilityVersionIris = [
    'urn:applicability:price-conflict-a:version:1',
    'urn:applicability:price-primary:version:1',
  ];
  conflict.candidateApplicabilitySetDigest = framedSetDigest(
    conflict.candidateApplicabilityVersionIris,
  );
  const request = mismatch.evaluationRequests.find(
    (row) => row.versionIri === conflict.evaluationRequestVersionIri,
  );
  Object.assign(conflict, buildRuleConflictIdentity(conflict, request.logicalIri));
  conflict.versionOf = conflict.logicalIri;
  assert.deepEqual(validateMarketRulesScenario(mismatch), []);
  assert.throws(
    () => resolveMarketRule(mismatch, exactQuery('priceLimit', 'mr2-conflict-beta', mismatch)),
    (error) => error.code === 'RULE_CONFLICT_MISMATCH',
  );
});

test('CQ-MR2 rejects two simultaneously current conflict versions at the structural PIT gate', () => {
  const duplicate = structuredClone(scenario);
  const second = structuredClone(duplicate.ruleConflicts[0]);
  second.axes = {
    ...second.axes,
    knowledgeFrom: '2026-07-17T00:00:00Z',
    availableFrom: '2026-07-17T00:00:01Z',
    revision: 1,
  };
  const request = duplicate.evaluationRequests.find(
    (row) => row.versionIri === second.evaluationRequestVersionIri,
  );
  Object.assign(second, buildRuleConflictIdentity(second, request.logicalIri));
  second.versionOf = second.logicalIri;
  duplicate.ruleConflicts.push(second);
  const codes = validateMarketRulesScenario(duplicate).map((row) => row.code);
  assert.ok(codes.includes('RULE_FACT_PIT_OVERLAP'));
  assert.ok(codes.includes('RULE_REVISION_INITIAL'));
});

test('a conflict materialized for another rule kind does not contaminate this query kind', () => {
  const result = resolveMarketRule(
    scenario,
    exactQuery('settlementCycle', 'mr2-conflict-beta'),
  );
  assert.deepEqual(result, {
    outcome: 'none',
    evaluationRequestVersionIri: requestVersion('mr2-conflict-beta'),
  });
});

test('resolver refuses caller-authored scope/pivot fields outside an exact request fact', () => {
  assert.throws(
    () => resolveMarketRule(scenario, {
      kind: 'priceLimit',
      instrument: 'urn:instrument:beta:version:1',
      venue: 'urn:facility:xnas:version:1',
      pivot: {},
    }),
    (error) => error.code === 'RULE_QUERY_INTEGRITY',
  );
});

test('resolver rejects an exact request authority version closed at request availability', () => {
  const closed = loadFixture(path.join(FIXTURE_DIR, 'negative-request-authority-not-eligible.yaml'), {
    rootDirectory: FIXTURE_DIR,
  });
  assert.deepEqual(validateMarketRulesScenario(closed), []);
  assert.throws(
    () => resolveMarketRule(
      closed,
      exactQuery('settlementCycle', 'mr1-alpha-current', closed),
    ),
    (error) => error.code === 'RULE_QUERY_REQUEST_AUTHORITY_NOT_ELIGIBLE',
  );
});

test('CQ-MR2 applies availability closure as a half-open boundary', () => {
  const before = resolveMarketRule(
    scenario,
    exactQuery('priceLimit', 'mr2-conflict-beta-before-withdrawal'),
  );
  assert.equal(before.outcome, 'conflict');

  const atBoundary = resolveMarketRule(
    scenario,
    exactQuery('priceLimit', 'mr2-conflict-beta-at-withdrawal'),
  );
  assert.equal(atBoundary.outcome, 'resolved');
  assert.equal(atBoundary.ruleVersionIri, 'urn:rule:price-conflict-a:version:1');
});

test('CQ-MR3 selects the correct immutable revision on each side of a knowledge closure', () => {
  const oldResult = resolveMarketRule(
    scenario,
    exactQuery('settlementCycle', 'mr3-gamma-before'),
  );
  const newResult = resolveMarketRule(
    scenario,
    exactQuery('settlementCycle', 'mr3-gamma-at'),
  );
  assert.equal(oldResult.ruleVersionIri, 'urn:rule:settlement-revisioned:version:0');
  assert.equal(newResult.ruleVersionIri, 'urn:rule:settlement-revisioned:version:1');
});

for (const [file, code] of [
  ['negative-missing-scope.yaml', 'RULE_APPLICABILITY_EMPTY_SCOPE'],
  ['negative-inline-knowledge-end.yaml', 'RULE_INLINE_CLOSURE'],
  ['negative-precedence-cycle.yaml', 'RULE_PRECEDENCE_CYCLE'],
  ['negative-orphan-applicability.yaml', 'RULE_APPLICABILITY_ORPHAN'],
  ['negative-duplicate-closure.yaml', 'RULE_CLOSURE_DUPLICATE'],
  ['negative-precedence-non-overlap.yaml', 'RULE_PRECEDENCE_NON_OVERLAP'],
  ['negative-request-account-type-member.yaml', 'RULE_EVALUATION_REQUEST_SCOPE'],
  ['negative-applicability-account-type-member.yaml', 'RULE_APPLICABILITY_SCOPE'],
  ['negative-price-limit-money.yaml', 'RULE_PRICE_LIMIT_VALUE'],
  ['negative-price-limit-nested-field.yaml', 'RULE_PRICE_LIMIT_VALUE'],
  ['negative-cross-type-version-collision.yaml', 'RULE_FACT_DUPLICATE_VERSION'],
  ['negative-unresolved-closure-evidence.yaml', 'RULE_CLOSURE_EVIDENCE'],
  ['negative-closure-identity.yaml', 'RULE_CLOSURE_IDENTITY'],
  ['negative-closure-unresolved-run.yaml', 'RULE_CLOSURE_CONTEXT'],
  ['negative-run-artifact-collision.yaml', 'RULE_RUN_ARTIFACT_COLLISION'],
  ['negative-scope-version-of.yaml', 'RULE_SCOPE_VERSION_INTEGRITY'],
  ['negative-request-authority-version-of.yaml', 'RULE_REQUEST_AUTHORITY_INTEGRITY'],
  ['negative-initial-revision.yaml', 'RULE_REVISION_INITIAL'],
  ['negative-logical-pit-overlap.yaml', 'RULE_FACT_PIT_OVERLAP'],
  ['negative-forged-priority-source.yaml', 'RULE_APPLICABILITY_SOURCE'],
  ['negative-supersession-revision-skip.yaml', 'RULE_SUPERSESSION_INTEGRITY'],
  ['negative-listing-relation-wrong-kind.yaml', 'RULE_SCOPE_RELATION_TARGET'],
  ['negative-segment-relation-missing.yaml', 'RULE_SCOPE_RELATION_TARGET'],
  ['negative-request-scope-contradiction.yaml', 'RULE_EVALUATION_REQUEST_SCOPE_INCONSISTENT'],
  ['negative-request-identity.yaml', 'RULE_EVALUATION_REQUEST_IDENTITY'],
  ['negative-request-context-order.yaml', 'RULE_EVALUATION_REQUEST_CONTEXT_ORDER'],
  ['negative-request-version-of.yaml', 'RULE_EVALUATION_REQUEST_INTEGRITY'],
  ['negative-conflict-digest.yaml', 'RULE_CONFLICT_DIGEST'],
  ['negative-conflict-missing-run.yaml', 'RULE_CONFLICT_INTEGRITY'],
  ['negative-conflict-candidate-duplicate.yaml', 'RULE_CONFLICT_CANDIDATES'],
  ['negative-conflict-mixed-rule-kind.yaml', 'RULE_CONFLICT_CANDIDATE_KIND'],
  ['negative-conflict-wrong-request.yaml', 'RULE_CONFLICT_REQUEST'],
  ['negative-conflict-identity.yaml', 'RULE_CONFLICT_IDENTITY'],
  ['negative-conflict-version-of.yaml', 'RULE_CONFLICT_INTEGRITY'],
  ['negative-conflict-unresolved-run.yaml', 'RULE_CONFLICT_RUN'],
  ['negative-conflict-run-provenance.yaml', 'RULE_CONFLICT_RUN_PROVENANCE'],
  ['negative-conflict-run-order.yaml', 'RULE_CONFLICT_RUN_ORDER'],
]) {
  test(`${file} is rejected with ${code}`, () => {
    const negative = loadFixture(path.join(FIXTURE_DIR, file), { rootDirectory: FIXTURE_DIR });
    const codes = validateMarketRulesScenario(negative).map((row) => row.code);
    assert.ok(codes.includes(code), `${file}: ${codes.join(',')}`);
  });
}
