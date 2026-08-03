'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  loadYaml,
  validateRiskModule,
} = require('../lib/risk-v03-contract.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const moduleDocument = loadYaml(path.join(
  ROOT,
  'ontology',
  'domain',
  'finance',
  'risk',
  'module.yaml',
));

function withoutAttribute(container, owner, attributeIri) {
  const document = structuredClone(moduleDocument);
  const uses = document.domain[container][owner].attributeUses;
  document.domain[container][owner].attributeUses = uses.filter(
    (use) => use.attribute !== attributeIri,
  );
  return document;
}

test('Risk module validator accepts the authored v0.3 source contract', () => {
  assert.deepEqual(validateRiskModule(moduleDocument).errors, []);
});

for (const [container, owner, attributeIri] of [
  [
    'objectTypes',
    'RiskMeasureDefinition',
    'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceLocator',
  ],
  [
    'associationTypes',
    'RiskMeasurement',
    'https://axiolune.ai/ontology/meta/data-binding/attributes/generatingContextRef',
  ],
  [
    'associationTypes',
    'RiskLimitEvaluation',
    'https://axiolune.ai/ontology/finance/risk/evaluationResult',
  ],
  [
    'associationTypes',
    'LimitBreach',
    'https://axiolune.ai/ontology/meta/data-binding/attributes/generatingContextRef',
  ],
]) {
  test(`Risk module validator rejects missing ${owner}.${attributeIri}`, () => {
    const result = validateRiskModule(withoutAttribute(container, owner, attributeIri));
    assert.ok(
      result.errors.some((message) => message.includes(owner) && message.includes(attributeIri)),
      result.errors.join('\n'),
    );
  });
}
