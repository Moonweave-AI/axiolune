'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  loadYaml,
  validateMarketRules,
} = require('../lib/foundation-market-rules-contract.cjs');

const MODULE = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'ontology',
  'domain',
  'finance',
  'market-rules',
  'module.yaml',
);
const authored = loadYaml(MODULE);

function errorsFor(candidate) {
  return validateMarketRules(candidate).errors;
}

test('Market Rules module validator accepts the authored request/conflict identity contract', () => {
  assert.deepEqual(errorsFor(authored), []);
});

test('Market Rules module validator rejects removal of request identity framing', () => {
  const candidate = structuredClone(authored);
  candidate.domain.constraints.RuleEvaluationRequestIntegrity.expression.expression =
    'contract=rfc001-rule-evaluation-request-v1;inputContext=strictlyPrior;pitAxes=3';
  assert.ok(errorsFor(candidate).includes('market-rules:request-identity-runtime-contract'));
});

test('Market Rules module validator rejects removal of exact conflict/run materialization', () => {
  const candidate = structuredClone(authored);
  candidate.domain.constraints.RuleConflictNoSilentWinner.expression.expression =
    'contract=rfc001-rule-conflict-v1;winner=forbidden;candidateSetDigest=required';
  assert.ok(errorsFor(candidate).includes('market-rules:materialized-conflict-contract'));
});

test('Market Rules module validator rejects deletion of the strict prior input-context join', () => {
  const candidate = structuredClone(authored);
  candidate.domain.constraints.RuleEvaluationRequestIntegrity.expression.expression =
    candidate.domain.constraints.RuleEvaluationRequestIntegrity.expression.expression
      .replace('inputContext=strictlyPrior;', '');
  assert.ok(errorsFor(candidate).includes('market-rules:request-identity-runtime-contract'));
});

test('Market Rules module validator rejects deletion of the three request PIT pivots', () => {
  const candidate = structuredClone(authored);
  candidate.domain.constraints.RuleEvaluationRequestIntegrity.expression.expression =
    candidate.domain.constraints.RuleEvaluationRequestIntegrity.expression.expression
      .replace('pitAxes=3;', '');
  assert.ok(errorsFor(candidate).includes('market-rules:request-identity-runtime-contract'));
});

test('Market Rules module validator rejects deletion of the no-winner conflict rule', () => {
  const candidate = structuredClone(authored);
  candidate.domain.constraints.RuleConflictNoSilentWinner.expression.expression =
    candidate.domain.constraints.RuleConflictNoSilentWinner.expression.expression
      .replace('winner=forbidden;', '');
  assert.ok(errorsFor(candidate).includes('market-rules:materialized-conflict-contract'));
});

test('Market Rules module validator rejects deletion of the candidate-set digest rule', () => {
  const candidate = structuredClone(authored);
  candidate.domain.constraints.RuleConflictNoSilentWinner.expression.expression =
    candidate.domain.constraints.RuleConflictNoSilentWinner.expression.expression
      .replace('candidateSetDigest=required;', '');
  assert.ok(errorsFor(candidate).includes('market-rules:materialized-conflict-contract'));
});

test('Market Rules module validator rejects deletion of the priority authority-ledger join', () => {
  const candidate = structuredClone(authored);
  candidate.domain.constraints.RulePriorityComparability.expression.expression =
    candidate.domain.constraints.RulePriorityComparability.expression.expression
      .replace('authorityLedgerJoin=reviewed', '');
  assert.ok(errorsFor(candidate).includes('market-rules:priority-authority-contract'));
});

test('Market Rules module validator rejects deletion of the precedence authority-ledger join', () => {
  const candidate = structuredClone(authored);
  candidate.domain.constraints.RulePrecedenceIntegrity.expression.expression =
    candidate.domain.constraints.RulePrecedenceIntegrity.expression.expression
      .replace('authorityLedgerJoin=reviewed;', '');
  assert.ok(errorsFor(candidate).includes('market-rules:precedence-conflict-contract'));
});

test('Market Rules module validator rejects a precedence graph without three-axis PIT activation', () => {
  const candidate = structuredClone(authored);
  candidate.domain.constraints.RulePrecedenceIntegrity.expression.expression =
    candidate.domain.constraints.RulePrecedenceIntegrity.expression.expression
      .replace('activeAtThreeAxisPit=true;', '');
  assert.ok(errorsFor(candidate).includes('market-rules:precedence-conflict-contract'));
});

test('Market Rules module validator rejects precedence activation that ignores immutable closures', () => {
  const candidate = structuredClone(authored);
  candidate.domain.constraints.RulePrecedenceIntegrity.expression.expression =
    candidate.domain.constraints.RulePrecedenceIntegrity.expression.expression
      .replace('closureAware=true;', '');
  assert.ok(errorsFor(candidate).includes('market-rules:precedence-conflict-contract'));
});

test('Market Rules module validator requires closure Run completion by query reference time', () => {
  const candidate = structuredClone(authored);
  candidate.domain.constraints.RulePrecedenceIntegrity.expression.expression =
    candidate.domain.constraints.RulePrecedenceIntegrity.expression.expression
      .replace('closureRunCompletedByReference=true;', '');
  assert.ok(errorsFor(candidate).includes('market-rules:precedence-conflict-contract'));
});

test('Market Rules module validator pins both account-type scopes to Foundation AccountType', () => {
  const applicability = structuredClone(authored);
  applicability.domain.attributeTypes.applicabilityAccountType.valueType =
    'https://example.invalid/AttackerAccountType';
  assert.ok(errorsFor(applicability).includes('market-rules:applicability-explicit-scope'));

  const request = structuredClone(authored);
  request.domain.attributeTypes.requestAccountType.valueType =
    'https://example.invalid/AttackerAccountType';
  assert.ok(errorsFor(request).includes('market-rules:request-account-type-contract'));
});

test('Market Rules module validator rejects a missing request input-context digest', () => {
  const candidate = structuredClone(authored);
  const request = candidate.domain.objectTypes.RuleEvaluationRequest;
  request.attributeUses = request.attributeUses.filter((use) => (
    use.attribute !== 'https://axiolune.ai/ontology/meta/data-binding/attributes/inputContextRecordDigest'
  ));
  assert.ok(errorsFor(candidate).some((error) => error.includes('market-rules:request-attribute:')));
});

test('Market Rules module validator rejects a non-exact conflict request role', () => {
  const candidate = structuredClone(authored);
  const target = `${candidate.domain.associationTypes.RuleConflict.iri}/role/evaluationRequestVersion`;
  const binding = candidate.domain.constraintBindings.find((row) => row.targetElement === target);
  binding.constraintRef = 'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference';
  assert.ok(errorsFor(candidate).includes('market-rules:materialized-conflict-contract'));
});
