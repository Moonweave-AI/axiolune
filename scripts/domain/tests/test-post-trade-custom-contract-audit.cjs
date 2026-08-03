'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const {
  EXPECTED_CUSTOM_CONTRACT_COUNT,
  EXPECTED_CUSTOM_CONTRACT_SET_DIGEST,
  EXPECTED_MANDATORY_BINDING_COUNT,
  EXPECTED_MANDATORY_BINDING_SET_DIGEST,
  PostTradeCustomContractAuditError,
  auditPostTradeCustomContracts,
} = require('../lib/post-trade-custom-contract-audit.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MODULE_PATH = path.join(
  ROOT,
  'ontology/domain/finance/post-trade-operations/module.yaml',
);
const BASE = 'https://axiolune.ai/ontology/finance/post-trade-operations/';
const FIRST_CONTRACT = 'CorporateActionEventContract';
const FIRST_CONTRACT_IRI = `${BASE}${FIRST_CONTRACT}`;

function loadModule() {
  return YAML.parse(fs.readFileSync(MODULE_PATH, 'utf8'));
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => (
    error instanceof PostTradeCustomContractAuditError && error.code === code
  ));
}

test('canonical post-trade Custom contracts and Mandatory bindings match both static locks', () => {
  assert.deepEqual(auditPostTradeCustomContracts(loadModule()), {
    ok: true,
    profile: 'post-trade-custom-contract-audit/v1',
    customConstraintCount: EXPECTED_CUSTOM_CONTRACT_COUNT,
    customContractSetDigest: EXPECTED_CUSTOM_CONTRACT_SET_DIGEST,
    mandatoryBindingCount: EXPECTED_MANDATORY_BINDING_COUNT,
    mandatoryBindingSetDigest: EXPECTED_MANDATORY_BINDING_SET_DIGEST,
  });
});

test('vacuous Custom expression is rejected before digest comparison', () => {
  const document = loadModule();
  document.domain.constraints[FIRST_CONTRACT].expression.expression = 'return true;';
  expectCode(
    () => auditPostTradeCustomContracts(document),
    'PTO_CUSTOM_EXPRESSION_TRIVIAL',
  );
});

test('non-vacuous one-character expression drift is rejected by the full UTF-8 digest', () => {
  const document = loadModule();
  document.domain.constraints[FIRST_CONTRACT].expression.expression += '!';
  expectCode(
    () => auditPostTradeCustomContracts(document),
    'PTO_CUSTOM_EXPRESSION_DIGEST',
  );
});

test('IRI localName target severity and message are each frozen', () => {
  const mutations = {
    iri: `${BASE}FabricatedContract`,
    localName: 'FabricatedContract',
    targetElement: `${BASE}FabricatedTarget`,
    severity: 'Warning',
    message: 'silently weakened message',
  };
  for (const [field, value] of Object.entries(mutations)) {
    const document = loadModule();
    document.domain.constraints[FIRST_CONTRACT][field] = value;
    expectCode(
      () => auditPostTradeCustomContracts(document),
      'PTO_CUSTOM_METADATA',
    );
  }
});

test('wrong binding target is rejected by the per-Custom exact binding lock', () => {
  const document = loadModule();
  const binding = document.domain.constraintBindings
    .find((candidate) => candidate.constraintRef === FIRST_CONTRACT_IRI);
  binding.targetElement = `${BASE}FabricatedTarget`;
  expectCode(
    () => auditPostTradeCustomContracts(document),
    'PTO_CUSTOM_BINDING_CLOSURE',
  );
});

test('deleting a required Custom Mandatory binding is rejected', () => {
  const document = loadModule();
  document.domain.constraintBindings = document.domain.constraintBindings
    .filter((binding) => binding.constraintRef !== FIRST_CONTRACT_IRI);
  expectCode(
    () => auditPostTradeCustomContracts(document),
    'PTO_CUSTOM_BINDING_CLOSURE',
  );
});

test('adding a fabricated Mandatory binding is rejected by closed-set count and digest', () => {
  const document = loadModule();
  document.domain.constraintBindings.push({
    constraintRef: `${BASE}FabricatedContract`,
    targetElement: `${BASE}FabricatedTarget`,
    enforcementLevel: 'Mandatory',
  });
  expectCode(
    () => auditPostTradeCustomContracts(document),
    'PTO_MANDATORY_BINDING_CLOSURE',
  );
});

test('same-count replacement with a fabricated Mandatory binding is rejected by set digest', () => {
  const document = loadModule();
  const replacementIndex = document.domain.constraintBindings.findIndex(
    (binding) => !binding.constraintRef.startsWith(BASE),
  );
  assert.notEqual(replacementIndex, -1);
  document.domain.constraintBindings[replacementIndex] = {
    constraintRef: `${BASE}FabricatedContract`,
    targetElement: `${BASE}FabricatedTarget`,
    enforcementLevel: 'Mandatory',
  };
  expectCode(
    () => auditPostTradeCustomContracts(document),
    'PTO_MANDATORY_BINDING_CLOSURE',
  );
});

test('Custom inventory and expression object are closed against shadow additions', () => {
  const extraDocument = loadModule();
  extraDocument.domain.constraints.FabricatedContract = {
    expression: { language: 'Custom', expression: 'a fabricated condition that appears superficially meaningful' },
  };
  expectCode(
    () => auditPostTradeCustomContracts(extraDocument),
    'PTO_CUSTOM_INVENTORY',
  );

  const shadowDocument = loadModule();
  shadowDocument.domain.constraints[FIRST_CONTRACT].expression.fallback = 'return true;';
  expectCode(
    () => auditPostTradeCustomContracts(shadowDocument),
    'PTO_CUSTOM_EXPRESSION_SHAPE',
  );
});
