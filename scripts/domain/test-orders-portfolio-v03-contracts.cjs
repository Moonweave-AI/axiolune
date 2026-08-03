#!/usr/bin/env node
'use strict';

/**
 * Focused executable contract checks for RFC-001 sections 5.15 and 5.16.
 *
 * Exit codes:
 *   0: all checks pass and no evidence remains pending
 *   1: at least one executable check fails
 *   2: executable checks pass, but external code-list/runtime evidence is pending
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const {
  costBasisDirectUnitValueRaw,
  directUnitValueRaw,
  isCostBasisPrecisionPolicy,
  isCostBasisRoundingPolicy,
  isValuationPrecisionPolicy,
  isValuationRoundingPolicy,
  quantizeRational,
  remainingBasisRaw,
} = require('./lib/orders-portfolio-exact-arithmetic.cjs');
const {
  instantNanoseconds,
} = require('./lib/orders-portfolio-custom-validators.cjs');
const YAML_SCHEMA = yaml.CORE_SCHEMA.withTags(yaml.mergeTag);

const ROOT = path.resolve(__dirname, '..', '..');

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

const ORDERS_FILE = path.join(
  ROOT,
  'ontology',
  'domain',
  'finance',
  'orders-execution',
  'module.yaml',
);
const PORTFOLIO_FILE = path.join(
  ROOT,
  'ontology',
  'domain',
  'finance',
  'portfolio-positions',
  'module.yaml',
);
const FIXTURE_FILES = [
  path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'orders-execution-v03.yaml'),
  path.join(ROOT, 'tests', 'm2', 'fixtures', 'negative', 'orders-execution-v03.yaml'),
  path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'portfolio-positions-v03.yaml'),
  path.join(ROOT, 'tests', 'm2', 'fixtures', 'negative', 'portfolio-positions-v03.yaml'),
  path.join(
    ROOT,
    'tests',
    'm2',
    'fixtures',
    'portfolio-position-lot-correction-matrix.yaml',
  ),
];
const PROJECT_REVIEWS = [
  path.join(ROOT, 'docs', 'ontology', 'references', 'reviews', 'project-reference', 'nautilus-trader.review.json'),
  path.join(ROOT, 'docs', 'ontology', 'references', 'reviews', 'project-reference', 'lean.review.json'),
  path.join(ROOT, 'docs', 'ontology', 'references', 'reviews', 'project-reference', 'rqalpha.review.json'),
];
const DOMAIN_SHACL_RUNNER = path.join(ROOT, 'scripts', 'domain', 'run-domain-shacl.cjs');
const CUSTOM_RUNTIME_RUNNER = path.join(
  ROOT,
  'scripts',
  'domain',
  'run-orders-portfolio-custom-runtime.cjs',
);
const CUSTOM_PROFILE_GENERATOR = path.join(
  ROOT,
  'scripts',
  'domain',
  'generate-orders-portfolio-custom-profile.cjs',
);
const POSITION_LOT_MATRIX_FILE = path.join(
  ROOT,
  'tests',
  'm2',
  'fixtures',
  'portfolio-position-lot-correction-matrix.yaml',
);

const TEMPORAL = 'https://axiolune.ai/ontology/meta/patterns/TemporalFact';
const PROVENANCED = 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact';
const LOGICAL = 'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference';
const EXACT = 'https://axiolune.ai/ontology/meta/core/constraints/ExactVersionReference';
const PENDING_EVIDENCE = 'https://axiolune.ai/pending-source-evidence/';
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const IRI = /^https?:\/\/[^\s]+$/;
const EXACT_VERSION_IRI = /\/version\/[A-Za-z0-9._~:-]+$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const TRIGGER_PRICE_BASES = new Set([
  'venueDefault',
  'lastPrice',
  'markPrice',
  'indexPrice',
  'bidAsk',
  'doubleLast',
  'doubleBidAsk',
  'lastOrBidAsk',
  'midPoint',
]);
const ORDER_LIFECYCLE_STATES = new Set([
  'Initialized',
  'Denied',
  'Emulated',
  'Released',
  'Submitted',
  'Accepted',
  'Rejected',
  'PendingUpdate',
  'PendingCancel',
  'PartiallyFilled',
  'Filled',
  'Canceled',
  'Expired',
  'Triggered',
]);
const ORDER_EVENT_KINDS = new Set([
  'Initialized',
  'Denied',
  'Emulated',
  'Released',
  'Submitted',
  'Accepted',
  'Rejected',
  'PendingUpdate',
  'PendingCancel',
  'Updated',
  'ModifyRejected',
  'CancelRejected',
  'PartiallyFilled',
  'Filled',
  'Canceled',
  'Expired',
  'Triggered',
]);

let passes = 0;
let failures = 0;
let pending = 0;

function pass(id, detail = '') {
  passes += 1;
  console.log(`PASS ${id}${detail ? `: ${detail}` : ''}`);
}

function fail(id, detail) {
  failures += 1;
  console.error(`FAIL ${id}: ${detail}`);
}

function pend(id, detail) {
  pending += 1;
  console.log(`PENDING ${id}: ${detail}`);
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function loadYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'), { schema: YAML_SCHEMA });
}

function mapKeys(document, container) {
  return Object.keys(document.domain?.[container] || {});
}

function element(document, container, localName) {
  return document.domain?.[container]?.[localName];
}

function attrUses(item) {
  return new Map((item?.attributeUses || []).map((use) => [use.attribute, use]));
}

function roles(item) {
  return new Map((item?.participantRoles || []).map((role) => [role.id, role]));
}

function codeNotations(item) {
  return (item?.values || []).map((value) => value.notation);
}

function sameSet(actual, expected) {
  return actual.length === expected.length
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function exactCardinality(value, minCount, maxCount) {
  return value?.minCount === minCount && value?.maxCount === maxCount;
}

function requireInventory(document, container, expected, prefix) {
  const present = new Set(mapKeys(document, container));
  for (const name of expected) {
    invariant(present.has(name), `${prefix} missing ${container}.${name}`);
  }
}

function requireDualPatterns(document, moduleName) {
  for (const container of ['objectTypes', 'associationTypes']) {
    for (const [localName, item] of Object.entries(document.domain?.[container] || {})) {
      const patterns = (item.patternBindings || []).map((binding) => binding.pattern);
      invariant(
        patterns.filter((pattern) => pattern === TEMPORAL).length === 1,
        `${moduleName}.${container}.${localName} lacks exactly one TemporalFact binding`,
      );
      invariant(
        patterns.filter((pattern) => pattern === PROVENANCED).length === 1,
        `${moduleName}.${container}.${localName} lacks exactly one ProvenancedFact binding`,
      );
    }
  }
}

function requirePublicRoleDocumentation(document, moduleName) {
  for (const [localName, item] of Object.entries(document.domain?.associationTypes || {})) {
    for (const role of item.participantRoles || []) {
      invariant(
        typeof role.label === 'string' && role.label.trim() !== '',
        `${moduleName}.${localName}.${role.id} lacks label`,
      );
      invariant(
        typeof role.definition === 'string' && role.definition.trim() !== '',
        `${moduleName}.${localName}.${role.id} lacks definition`,
      );
    }
  }
}

function requireReferenceModes(document, expectedModes, moduleName) {
  const bindings = new Map();
  for (const binding of document.domain?.constraintBindings || []) {
    if (binding.constraintRef !== LOGICAL && binding.constraintRef !== EXACT) continue;
    const values = bindings.get(binding.targetElement) || [];
    values.push(binding.constraintRef);
    bindings.set(binding.targetElement, values);
  }
  for (const [target, expected] of Object.entries(expectedModes)) {
    const actual = bindings.get(target) || [];
    invariant(
      actual.length === 1 && actual[0] === expected,
      `${moduleName} ${target} expected exactly one ${expected}, got ${actual.join(',') || 'none'}`,
    );
  }

  for (const container of ['objectTypes', 'associationTypes']) {
    for (const [localName, item] of Object.entries(document.domain?.[container] || {})) {
      for (const role of item.participantRoles || []) {
        const target = role.roleIri || `${item.iri}/role/${role.id}`;
        const actual = bindings.get(target) || [];
        invariant(
          actual.length === 1,
          `${moduleName}.${container}.${localName}.${role.id} lacks exactly one reference mode`,
        );
      }
    }
  }

  for (const use of document.domain?.relationUses || []) {
    const modes = (use.constraints || []).filter(
      (binding) => binding.constraintRef === LOGICAL || binding.constraintRef === EXACT,
    );
    invariant(modes.length === 1, `${moduleName} RelationUse ${use.relation} lacks one reference mode`);
    invariant(
      modes[0].targetElement === use.relation,
      `${moduleName} RelationUse ${use.relation} targets another predicate`,
    );
  }
}

function requireContractBindings(document, expected, moduleName) {
  const bindings = document.domain?.constraintBindings || [];
  for (const [constraintName, targetName] of Object.entries(expected)) {
    const constraint = element(document, 'constraints', constraintName);
    invariant(constraint, `${moduleName} missing constraints.${constraintName}`);
    const matches = bindings.filter((binding) => binding.constraintRef === constraint.iri);
    invariant(
      matches.length === 1
        && matches[0].targetElement === constraint.targetElement
        && constraint.targetElement.endsWith(`/${targetName}`),
      `${moduleName}.${constraintName} lacks one matching top-level binding to ${targetName}`,
    );
  }
}

function requireSimpleXone(document, constraintName, expression, targetName, moduleName) {
  const constraint = element(document, 'constraints', constraintName);
  invariant(constraint?.expression?.language === 'SHACL', `${moduleName}.${constraintName} must be SHACL`);
  invariant(
    constraint.expression.expression === expression,
    `${moduleName}.${constraintName} must be the exact pure expression ${expression}`,
  );
  invariant(
    constraint.targetElement.endsWith(`/${targetName}`),
    `${moduleName}.${constraintName} targets the wrong type`,
  );
}

function assertNoForbiddenSymbols(document, forbidden, moduleName) {
  const text = JSON.stringify(document);
  for (const term of forbidden) {
    invariant(!text.includes(term), `${moduleName} retains forbidden duplicate/alias truth ${term}`);
  }
}

function validateOrdersModule(orders) {
  requireInventory(orders, 'objectTypes', [
    'OrderIntent',
    'ExternalOrder',
    'OrderEventStream',
    'ExternalOrderStatusVocabulary',
    'OrderTransitionProfile',
    'LiquidityRoleMapping',
  ], 'orders');
  requireInventory(orders, 'associationTypes', [
    'OrderLifecycleEvent',
    'Execution',
    'Fee',
    'ExternalOrderStatusMapping',
    'LiquidityRoleDetermination',
    'OrderEventIntegrityFinding',
  ], 'orders');
  requireInventory(orders, 'relationTypes', [
    'intentAccount',
    'intentInstrument',
    'intentListing',
    'intentOtcContext',
    'externalOrderProvider',
    'externalOrderOriginatingIntent',
    'streamProvider',
    'streamExternalOrder',
  ], 'orders');
  requireInventory(orders, 'codeLists', [
    'OrderSide',
    'OrderType',
    'TriggerPriceBasis',
    'TimeInForce',
    'OrderLifecycleState',
    'OrderEventKind',
    'FeeKind',
    'FeeEffect',
    'LiquidityRoleCapability',
    'LiquidityRole',
    'LiquidityPerspective',
    'LiquidityDeterminationResult',
    'LiquidityUnavailableReason',
    'OrderIntegrityKind',
  ], 'orders');

  invariant(
    !orders.domain.associationTypes.OrderIntent,
    'OrderIntent must be an ObjectType, not an AssociationType',
  );
  assertNoForbiddenSymbols(orders, [
    'hasPreviousState',
    'hasCommission',
    'hasLiquiditySide',
    'LiquiditySide',
    'ExternalStatusMapping',
  ], 'orders');
  requireDualPatterns(orders, 'orders');
  requirePublicRoleDocumentation(orders, 'orders');

  const intentAttrs = attrUses(element(orders, 'objectTypes', 'OrderIntent'));
  invariant(
    exactCardinality(
      intentAttrs.get(
        'https://axiolune.ai/ontology/finance/orders-execution/triggerPriceBasis',
      ),
      0,
      1,
    ),
    'OrderIntent lacks the optional triggerPriceBasis attribute use',
  );

  const eventAttrs = attrUses(element(orders, 'associationTypes', 'OrderLifecycleEvent'));
  for (const name of [
    'providerEventId',
    'sourceOrderKey',
    'lifecycleState',
    'orderEventKind',
  ]) {
    invariant(
      exactCardinality(
        eventAttrs.get(`https://axiolune.ai/ontology/finance/orders-execution/${name}`),
        1,
        1,
      ),
      `OrderLifecycleEvent missing exact ${name}`,
    );
  }

  const executionRoles = roles(element(orders, 'associationTypes', 'Execution'));
  const requiredExecutionRoles = {
    executionStream: ['https://axiolune.ai/ontology/finance/orders-execution/OrderEventStream', 1, 1],
    executionExternalOrder: ['https://axiolune.ai/ontology/finance/orders-execution/ExternalOrder', 1, 1],
    executionOrderIntent: ['https://axiolune.ai/ontology/finance/orders-execution/OrderIntent', 1, 1],
    executionAccount: ['https://axiolune.ai/ontology/finance/foundation/FinancialAccount', 1, 1],
    executionParty: ['https://axiolune.ai/ontology/finance/foundation/Party', 1, 1],
    contraAccount: ['https://axiolune.ai/ontology/finance/foundation/FinancialAccount', 1, 1],
    contraParty: ['https://axiolune.ai/ontology/finance/foundation/Party', 1, 1],
    executionInstrument: ['https://axiolune.ai/ontology/finance/instruments/FinancialInstrument', 1, 1],
    executionListing: ['https://axiolune.ai/ontology/finance/instruments/InstrumentListing', 0, 1],
    executionOtcContext: ['https://axiolune.ai/ontology/finance/market-structure/OTCTradingContext', 0, 1],
    executionQuotationContract: [
      'https://axiolune.ai/ontology/finance/instruments/DirectUnitPriceQuotationContract',
      1,
      1,
    ],
  };
  for (const [name, [range, min, max]] of Object.entries(requiredExecutionRoles)) {
    const role = executionRoles.get(name);
    invariant(
      role?.range === range && exactCardinality(role, min, max),
      `Execution role ${name} is not ${range} ${min}..${max}`,
    );
  }

  const feeAttrs = attrUses(element(orders, 'associationTypes', 'Fee'));
  for (const name of ['feeKind', 'feeEffect', 'feeAmount']) {
    invariant(
      exactCardinality(
        feeAttrs.get(`https://axiolune.ai/ontology/finance/orders-execution/${name}`),
        1,
        1,
      ),
      `Fee missing exact ${name}`,
    );
  }

  const statusMapping = element(orders, 'associationTypes', 'ExternalOrderStatusMapping');
  const statusAttrs = attrUses(statusMapping);
  for (const name of [
    'providerApiIdentifier',
    'providerSchemaVersion',
    'statusMappingVersion',
    'rawStatusCode',
    'canonicalLifecycleState',
    'reviewDecisionRef',
    'reviewDecisionDigest',
  ]) {
    invariant(
      exactCardinality(
        statusAttrs.get(`https://axiolune.ai/ontology/finance/orders-execution/${name}`),
        1,
        1,
      ),
      `ExternalOrderStatusMapping missing exact ${name}`,
    );
  }
  invariant(
    sameSet(codeNotations(element(orders, 'codeLists', 'LiquidityRole')), [
      'maker',
      'taker',
      'auctionUndefined',
    ]),
    'LiquidityRole must be exactly maker/taker/auctionUndefined',
  );
  invariant(
    sameSet(codeNotations(element(orders, 'codeLists', 'FeeEffect')), ['charge', 'rebate']),
    'FeeEffect must be exactly charge/rebate',
  );
  invariant(
    sameSet(
      codeNotations(element(orders, 'codeLists', 'TriggerPriceBasis')),
      [...TRIGGER_PRICE_BASES],
    ),
    'TriggerPriceBasis must match the reviewed broader internal v0.3 vocabulary',
  );
  invariant(
    sameSet(codeNotations(element(orders, 'codeLists', 'LiquidityRoleCapability')), [
      'required',
      'optional',
      'unsupported',
    ]),
    'LiquidityRoleCapability must be exactly required/optional/unsupported',
  );
  invariant(
    sameSet(codeNotations(element(orders, 'codeLists', 'OrderIntegrityKind')), [
      'duplicateConflict',
      'sequenceGap',
      'outOfOrder',
      'lateFill',
      'missingAcknowledgement',
      'transitionViolation',
    ]),
    'OrderIntegrityKind does not match the RFC closed matrix',
  );
  invariant(
    sameSet(
      codeNotations(element(orders, 'codeLists', 'OrderEventKind')),
      [...ORDER_EVENT_KINDS],
    ),
    'OrderEventKind must cover every reviewed state-changing and rejection event kind',
  );
  invariant(
    element(orders, 'constraints', 'OrderLifecycleEventContract')
      ?.expression?.expression.includes('RFC 8785 JCS canonical bytes'),
    'OrderLifecycleEventContract lacks complete canonical JCS duplicate semantics',
  );
  const liquidityContractExpression = element(
    orders,
    'constraints',
    'LiquidityRoleDeterminationContract',
  )?.expression?.expression || '';
  invariant(
    liquidityContractExpression.includes('sourceContractRef/digest equal')
      && liquidityContractExpression.includes('SHA-256(RFC8785-JCS(sourceRecord))')
      && liquidityContractExpression.includes('mapping JSON Pointer'),
    'LiquidityRoleDeterminationContract lacks source-contract, record-digest, or locator joins',
  );
  const finding = element(orders, 'associationTypes', 'OrderEventIntegrityFinding');
  const findingRoles = roles(finding);
  const findingAttrs = attrUses(finding);
  for (const name of [
    'subjectFillExecution',
    'subjectTerminalEvent',
    'subjectMissingAcknowledgementOrder',
    'subjectFromEvent',
    'subjectToEvent',
  ]) {
    invariant(
      exactCardinality(findingRoles.get(name), 0, 1),
      `OrderEventIntegrityFinding lacks kind-specific exact role ${name}`,
    );
  }
  for (const name of [
    'findingProviderEventId',
    'observedSourceOrderKey',
    'requiredPredecessorSourceOrderKey',
    'expectedAfterSourceOrderKey',
  ]) {
    invariant(
      exactCardinality(
        findingAttrs.get(`https://axiolune.ai/ontology/finance/orders-execution/${name}`),
        0,
        1,
      ),
      `OrderEventIntegrityFinding lacks kind-specific field ${name}`,
    );
  }

  const O = 'https://axiolune.ai/ontology/finance/orders-execution/';
  requireReferenceModes(orders, {
    [`${O}OrderLifecycleEvent/role/eventStream`]: EXACT,
    [`${O}OrderLifecycleEvent/role/externalOrder`]: EXACT,
    [`${O}OrderLifecycleEvent/role/orderIntent`]: EXACT,
    [`${O}Execution/role/executionStream`]: EXACT,
    [`${O}Execution/role/executionExternalOrder`]: EXACT,
    [`${O}Execution/role/executionOrderIntent`]: EXACT,
    [`${O}Execution/role/executionAccount`]: LOGICAL,
    [`${O}Execution/role/executionParty`]: LOGICAL,
    [`${O}Execution/role/contraAccount`]: LOGICAL,
    [`${O}Execution/role/contraParty`]: LOGICAL,
    [`${O}Execution/role/executionInstrument`]: LOGICAL,
    [`${O}Execution/role/executionListing`]: EXACT,
    [`${O}Execution/role/executionOtcContext`]: EXACT,
    [`${O}Execution/role/executionQuotationContract`]: EXACT,
    [`${O}Fee/role/feeExecution`]: EXACT,
    [`${O}ExternalOrderStatusMapping/role/statusProvider`]: LOGICAL,
    [`${O}ExternalOrderStatusMapping/role/statusVocabulary`]: EXACT,
    [`${O}LiquidityRoleDetermination/role/determinedExecution`]: EXACT,
    [`${O}LiquidityRoleDetermination/role/determinationStream`]: EXACT,
    [`${O}LiquidityRoleDetermination/role/liquidityMapping`]: EXACT,
    [`${O}OrderEventIntegrityFinding/role/findingStream`]: EXACT,
    [`${O}OrderEventIntegrityFinding/role/subjectFillExecution`]: EXACT,
    [`${O}OrderEventIntegrityFinding/role/subjectTerminalEvent`]: EXACT,
    [`${O}OrderEventIntegrityFinding/role/subjectMissingAcknowledgementOrder`]: EXACT,
    [`${O}OrderEventIntegrityFinding/role/subjectFromEvent`]: EXACT,
    [`${O}OrderEventIntegrityFinding/role/subjectToEvent`]: EXACT,
  }, 'orders');
  requireContractBindings(orders, {
    OrderIntentContract: 'OrderIntent',
    OrderIntentContextXone: 'OrderIntent',
    ExternalOrderContract: 'ExternalOrder',
    OrderEventStreamContract: 'OrderEventStream',
    ExternalOrderStatusVocabularyContract: 'ExternalOrderStatusVocabulary',
    OrderTransitionProfileContract: 'OrderTransitionProfile',
    LiquidityRoleMappingContract: 'LiquidityRoleMapping',
    OrderLifecycleEventContract: 'OrderLifecycleEvent',
    ExecutionContract: 'Execution',
    ExecutionLiquidityDeterminationCompletenessContract: 'Execution',
    ExecutionContextXone: 'Execution',
    FeeContract: 'Fee',
    ExternalOrderStatusMappingContract: 'ExternalOrderStatusMapping',
    LiquidityRoleDeterminationContract: 'LiquidityRoleDetermination',
    OrderEventIntegrityFindingContract: 'OrderEventIntegrityFinding',
  }, 'orders');
  requireSimpleXone(
    orders,
    'OrderIntentContextXone',
    'sh:xone(intentListing,intentOtcContext)',
    'OrderIntent',
    'orders',
  );
  requireSimpleXone(
    orders,
    'ExecutionContextXone',
    'sh:xone(executionListing,executionOtcContext)',
    'Execution',
    'orders',
  );
  pass('MODULE-OE', 'orders/execution inventory, truth separation, roles, and reference modes');
}

function validatePortfolioModule(portfolio) {
  requireInventory(portfolio, 'objectTypes', [
    'Portfolio',
    'ValuationCalculationDefinition',
    'CostBasisCalculationDefinition',
    'ExecutionLotAllocationClosure',
  ], 'portfolio');
  requireInventory(portfolio, 'associationTypes', [
    'PortfolioAccountMembership',
    'PortfolioManagementMandate',
    'PortfolioAccountMembershipClosure',
    'HoldingSnapshot',
    'PositionSnapshot',
    'PositionLot',
    'PortfolioValuation',
    'PositionValuation',
    'FXConversion',
    'PositionLotAllocation',
    'PositionLotFeeAllocation',
    'PositionLotStateClosure',
    'UnrealizedPnLObservation',
    'ExternalCostBasisObservation',
    'PortfolioPositionReconciliationFinding',
  ], 'portfolio');
  requireInventory(portfolio, 'relationTypes', [
    'valuationDefinitionAuthority',
    'costBasisDefinitionAuthority',
    'valuationDefinitionQuotationContract',
    'costBasisDefinitionQuotationContract',
    'costBasisDefinitionBasisCurrency',
    'closureExecution',
    'closureCostBasisDefinition',
    'closureEligibleLot',
    'closureSelectedLot',
    'closureAllocation',
    'closureFee',
    'closureFeeAllocation',
  ], 'portfolio');
  requireInventory(portfolio, 'codeLists', [
    'PositionSourceKind',
    'ValuationMethod',
    'CostBasisMethod',
    'FeeTreatment',
    'LotOpeningPolicy',
    'LotConsumptionPolicy',
    'PositionLotAllocationKind',
    'FXConversionDirection',
    'PortfolioReconciliationKind',
  ], 'portfolio');
  assertNoForbiddenSymbols(portfolio, [
    '/Account"',
    'PositionSide',
    'hasPositionSide',
    'heldInPortfolio',
    'hasCostBasis',
    'hasUnrealizedPnL',
  ], 'portfolio');
  requireDualPatterns(portfolio, 'portfolio');
  requirePublicRoleDocumentation(portfolio, 'portfolio');

  const holdingRoles = roles(element(portfolio, 'associationTypes', 'HoldingSnapshot'));
  invariant(
    holdingRoles.has('holdingAccount')
      && holdingRoles.has('holdingInstrument')
      && !holdingRoles.has('heldInPortfolio'),
    'HoldingSnapshot must be account+instrument scoped and must not directly point to Portfolio',
  );
  const positionAttrs = attrUses(element(portfolio, 'associationTypes', 'PositionSnapshot'));
  invariant(
    exactCardinality(
      positionAttrs.get(
        'https://axiolune.ai/ontology/finance/portfolio-positions/positionQuantity',
      ),
      1,
      1,
    ),
    'PositionSnapshot must have exactly one signed Quantity truth',
  );

  const lot = element(portfolio, 'associationTypes', 'PositionLot');
  const lotRoles = roles(lot);
  const lotAttrs = attrUses(lot);
  const requiredLotRoles = {
    lotInAccount: ['https://axiolune.ai/ontology/finance/foundation/FinancialAccount', 1, 1],
    lotForInstrument: ['https://axiolune.ai/ontology/finance/instruments/FinancialInstrument', 1, 1],
    lotAtListing: ['https://axiolune.ai/ontology/finance/instruments/InstrumentListing', 0, 1],
    openingExecution: ['https://axiolune.ai/ontology/finance/orders-execution/Execution', 1, 1],
    costBasisDefinition: [
      'https://axiolune.ai/ontology/finance/portfolio-positions/CostBasisCalculationDefinition',
      1,
      1,
    ],
    lotQuotationContract: [
      'https://axiolune.ai/ontology/finance/instruments/DirectUnitPriceQuotationContract',
      1,
      1,
    ],
    openingGrossFxConversion: [
      'https://axiolune.ai/ontology/finance/portfolio-positions/FXConversion',
      0,
      1,
    ],
  };
  for (const [name, [range, min, max]] of Object.entries(requiredLotRoles)) {
    const role = lotRoles.get(name);
    invariant(
      role?.range === range && exactCardinality(role, min, max),
      `PositionLot role ${name} is not ${range} ${min}..${max}`,
    );
  }
  for (const name of [
    'lotDiscriminator',
    'originalQuantity',
    'openingGross',
    'openingCostBasis',
    'calculationContextRef',
  ]) {
    invariant(
      exactCardinality(
        lotAttrs.get(`https://axiolune.ai/ontology/finance/portfolio-positions/${name}`),
        1,
        1,
      ),
      `PositionLot missing immutable version content ${name}`,
    );
  }
  invariant(
    element(portfolio, 'attributeTypes', 'lotDiscriminator')?.pattern === '^openingRemainder$',
    'PositionLot lotDiscriminator must admit only openingRemainder',
  );

  const valuation = element(portfolio, 'associationTypes', 'PositionValuation');
  const valuationRoles = roles(valuation);
  invariant(
    exactCardinality(valuationRoles.get('valuedHoldingSnapshot'), 0, 1)
      && exactCardinality(valuationRoles.get('valuedPositionSnapshot'), 0, 1)
      && exactCardinality(valuationRoles.get('valuationPrice'), 1, 1)
      && exactCardinality(valuationRoles.get('valuationFxConversion'), 0, 1),
    'PositionValuation line xone/price/FX role cardinalities are incomplete',
  );
  invariant(
    sameSet(codeNotations(element(portfolio, 'codeLists', 'ValuationMethod')), [
      'directUnitPriceTimesQuantity',
    ]),
    'v0.3 ValuationMethod must have only directUnitPriceTimesQuantity',
  );
  invariant(
    sameSet(codeNotations(element(portfolio, 'codeLists', 'FeeTreatment')), [
      'included',
      'excluded',
    ]),
    'FeeTreatment must be exactly included/excluded',
  );
  invariant(
    sameSet(codeNotations(element(portfolio, 'codeLists', 'PositionLotAllocationKind')), [
      'opening',
      'consumption',
    ]),
    'PositionLotAllocationKind must be exactly opening/consumption',
  );
  invariant(
    sameSet(codeNotations(element(portfolio, 'codeLists', 'LotConsumptionPolicy')), [
      'fifo',
      'lifo',
      'specificIdentification',
    ]),
    'LotConsumptionPolicy must be exactly fifo/lifo/specificIdentification',
  );
  invariant(
    sameSet(codeNotations(element(portfolio, 'codeLists', 'FXConversionDirection')), [
      'baseToQuote',
      'quoteToBase',
    ]),
    'FXConversionDirection must be exactly baseToQuote/quoteToBase',
  );
  const fxRoles = roles(element(portfolio, 'associationTypes', 'FXConversion'));
  invariant(
    exactCardinality(fxRoles.get('conversionRate'), 1, 1)
      && exactCardinality(fxRoles.get('conversionValuationLine'), 0, 1)
      && exactCardinality(fxRoles.get('conversionOpeningLot'), 0, 1)
      && exactCardinality(fxRoles.get('conversionFeeAllocation'), 0, 1),
    'FXConversion must have one exact rate and three optional xone consumer roles',
  );
  for (const definitionName of [
    'ValuationCalculationDefinition',
    'CostBasisCalculationDefinition',
  ]) {
    const definitionAttrs = attrUses(element(portfolio, 'objectTypes', definitionName));
    for (const name of [
      'precisionPolicyRef',
      'precisionPolicyDigest',
      'roundingPolicyRef',
      'roundingPolicyDigest',
      'toolLockRef',
      'toolLockDigest',
      'runtimeDigest',
      'inputContractDigest',
      'outputContractDigest',
    ]) {
      invariant(
        exactCardinality(
          definitionAttrs.get(`https://axiolune.ai/ontology/finance/portfolio-positions/${name}`),
          1,
          1,
        ),
        `${definitionName} lacks locked ${name}`,
      );
    }
  }
  invariant(
    element(portfolio, 'constraints', 'ValuationCalculationDefinitionContract')
      ?.expression?.expression.includes(
        'logicalKey(valuationDefinitionAuthority.logicalIri, valuationDefinitionId)',
      ),
    'valuation definition contract lacks its authority-scoped logical key',
  );
  invariant(
    element(portfolio, 'constraints', 'CostBasisCalculationDefinitionContract')
      ?.expression?.expression.includes(
        'logicalKey(costBasisDefinitionAuthority.logicalIri, costBasisDefinitionId)',
      ),
    'cost-basis definition contract lacks its authority-scoped logical key',
  );
  const allocationClosureAttrs = attrUses(
    element(portfolio, 'objectTypes', 'ExecutionLotAllocationClosure'),
  );
  for (const name of [
    'eligibleLotVersionSetDigest',
    'eligibleLotCount',
    'consumptionSelectionProbeRef',
    'consumptionSelectionProbeDigest',
  ]) {
    invariant(
      exactCardinality(
        allocationClosureAttrs.get(
          `https://axiolune.ai/ontology/finance/portfolio-positions/${name}`,
        ),
        1,
        1,
      ),
      `ExecutionLotAllocationClosure lacks required selection closure field ${name}`,
    );
  }
  for (const name of [
    'specificSelectionRef',
    'specificSelectionDigest',
    'specificSelectionVersionSetDigest',
    'specificSelectionCount',
  ]) {
    invariant(
      exactCardinality(
        allocationClosureAttrs.get(
          `https://axiolune.ai/ontology/finance/portfolio-positions/${name}`,
        ),
        0,
        1,
      ),
      `ExecutionLotAllocationClosure lacks optional specific-selection field ${name}`,
    );
  }
  const stateRoles = roles(element(portfolio, 'associationTypes', 'PositionLotStateClosure'));
  invariant(
    exactCardinality(stateRoles.get('stateAccount'), 1, 1)
      && exactCardinality(stateRoles.get('stateInstrument'), 1, 1)
      && exactCardinality(stateRoles.get('stateListing'), 0, 1),
    'PositionLotStateClosure does not explicitly bind account/instrument/listing truth',
  );
  const pnlRoles = roles(element(portfolio, 'associationTypes', 'UnrealizedPnLObservation'));
  invariant(
    exactCardinality(pnlRoles.get('pnlQuotationContract'), 1, 1)
      && exactCardinality(pnlRoles.get('pnlFxConversion'), 0, 1),
    'UnrealizedPnLObservation lacks quotation/conversion truth joins',
  );

  const P = 'https://axiolune.ai/ontology/finance/portfolio-positions/';
  requireReferenceModes(portfolio, {
    [`${P}PortfolioAccountMembership/role/membershipPortfolio`]: LOGICAL,
    [`${P}PortfolioAccountMembership/role/memberAccount`]: LOGICAL,
    [`${P}PortfolioManagementMandate/role/managedPortfolio`]: LOGICAL,
    [`${P}PortfolioManagementMandate/role/managingParty`]: LOGICAL,
    [`${P}HoldingSnapshot/role/holdingAccount`]: LOGICAL,
    [`${P}HoldingSnapshot/role/holdingInstrument`]: LOGICAL,
    [`${P}HoldingSnapshot/role/holdingListing`]: EXACT,
    [`${P}PositionSnapshot/role/positionAccount`]: LOGICAL,
    [`${P}PositionSnapshot/role/positionInstrument`]: LOGICAL,
    [`${P}PositionSnapshot/role/positionListing`]: EXACT,
    [`${P}PositionLot/role/lotInAccount`]: LOGICAL,
    [`${P}PositionLot/role/lotForInstrument`]: LOGICAL,
    [`${P}PositionLot/role/lotAtListing`]: EXACT,
    [`${P}PositionLot/role/openingExecution`]: EXACT,
    [`${P}PositionLot/role/costBasisDefinition`]: EXACT,
    [`${P}PositionLot/role/lotQuotationContract`]: EXACT,
    [`${P}PositionLot/role/openingGrossFxConversion`]: EXACT,
    [`${P}PortfolioValuation/role/memberAccountClosure`]: EXACT,
    [`${P}PortfolioValuation/role/valuationDefinition`]: EXACT,
    [`${P}PositionValuation/role/valuationHeader`]: EXACT,
    [`${P}PositionValuation/role/valuedHoldingSnapshot`]: EXACT,
    [`${P}PositionValuation/role/valuedPositionSnapshot`]: EXACT,
    [`${P}PositionValuation/role/valuationPrice`]: EXACT,
    [`${P}PositionValuation/role/valuationFxConversion`]: EXACT,
    [`${P}FXConversion/role/conversionValuationLine`]: EXACT,
    [`${P}FXConversion/role/conversionOpeningLot`]: EXACT,
    [`${P}FXConversion/role/conversionFeeAllocation`]: EXACT,
    [`${P}PositionLotAllocation/role/allocationExecution`]: EXACT,
    [`${P}PositionLotAllocation/role/allocatedLot`]: EXACT,
    [`${P}PositionLotFeeAllocation/role/allocatedFee`]: EXACT,
    [`${P}PositionLotStateClosure/role/closedPositionSnapshot`]: EXACT,
    [`${P}PositionLotStateClosure/role/stateAccount`]: LOGICAL,
    [`${P}PositionLotStateClosure/role/stateInstrument`]: LOGICAL,
    [`${P}PositionLotStateClosure/role/stateListing`]: EXACT,
    [`${P}UnrealizedPnLObservation/role/pnlValuation`]: EXACT,
    [`${P}UnrealizedPnLObservation/role/pnlQuotationContract`]: EXACT,
    [`${P}UnrealizedPnLObservation/role/pnlFxConversion`]: EXACT,
  }, 'portfolio');
  const costBasisCurrencyUse = (portfolio.domain.relationUses || []).find(
    (use) => use.relation === `${P}costBasisDefinitionBasisCurrency`,
  );
  invariant(
    costBasisCurrencyUse?.subjectType === `${P}CostBasisCalculationDefinition`
      && costBasisCurrencyUse.objectType
        === 'https://axiolune.ai/ontology/finance/foundation/Currency'
      && exactCardinality(costBasisCurrencyUse.outboundCardinality, 1, 1)
      && costBasisCurrencyUse.constraints?.length === 1
      && costBasisCurrencyUse.constraints[0].constraintRef === LOGICAL,
    'CostBasisCalculationDefinition lacks one logical basis Currency truth',
  );
  const requiredDefinitionAuthorities = [
    [
      'valuationDefinitionAuthority',
      'ValuationCalculationDefinition',
    ],
    [
      'costBasisDefinitionAuthority',
      'CostBasisCalculationDefinition',
    ],
  ];
  for (const [relationName, definitionName] of requiredDefinitionAuthorities) {
    const use = (portfolio.domain.relationUses || []).find(
      (candidate) => candidate.relation === `${P}${relationName}`,
    );
    invariant(
      use?.subjectType === `${P}${definitionName}`
        && use.objectType === 'https://axiolune.ai/ontology/finance/foundation/Party'
        && exactCardinality(use.outboundCardinality, 1, 1)
        && use.constraints?.length === 1
        && use.constraints[0].constraintRef === LOGICAL,
      `${definitionName} lacks exactly one logical definition authority`,
    );
  }
  const eligibleLotUse = (portfolio.domain.relationUses || []).find(
    (use) => use.relation === `${P}closureEligibleLot`,
  );
  invariant(
    eligibleLotUse?.subjectType === `${P}ExecutionLotAllocationClosure`
      && eligibleLotUse.objectType === `${P}PositionLot`
      && exactCardinality(eligibleLotUse.outboundCardinality, 0, null)
      && eligibleLotUse.constraints?.length === 1
      && eligibleLotUse.constraints[0].constraintRef === EXACT,
    'ExecutionLotAllocationClosure lacks the complete exact eligible-lot relation',
  );
  const selectedLotUse = (portfolio.domain.relationUses || []).find(
    (use) => use.relation === `${P}closureSelectedLot`,
  );
  invariant(
    selectedLotUse?.subjectType === `${P}ExecutionLotAllocationClosure`
      && selectedLotUse.objectType === `${P}PositionLot`
      && exactCardinality(selectedLotUse.outboundCardinality, 0, null)
      && selectedLotUse.constraints?.length === 1
      && selectedLotUse.constraints[0].constraintRef === EXACT,
    'ExecutionLotAllocationClosure lacks the exact specific-selected-lot relation',
  );
  requireContractBindings(portfolio, {
    PortfolioContract: 'Portfolio',
    PortfolioAccountMembershipContract: 'PortfolioAccountMembership',
    PortfolioManagementMandateContract: 'PortfolioManagementMandate',
    PortfolioAccountMembershipClosureContract: 'PortfolioAccountMembershipClosure',
    HoldingSnapshotContract: 'HoldingSnapshot',
    PositionSnapshotContract: 'PositionSnapshot',
    PositionLotContract: 'PositionLot',
    PositionLotOpeningAllocationCompletenessContract: 'PositionLot',
    ValuationCalculationDefinitionContract: 'ValuationCalculationDefinition',
    CostBasisCalculationDefinitionContract: 'CostBasisCalculationDefinition',
    PortfolioValuationContract: 'PortfolioValuation',
    PositionValuationInputXone: 'PositionValuation',
    PositionValuationContract: 'PositionValuation',
    FXConversionContract: 'FXConversion',
    PositionLotAllocationContract: 'PositionLotAllocation',
    PositionLotFeeAllocationContract: 'PositionLotFeeAllocation',
    ExecutionLotAllocationClosureContract: 'ExecutionLotAllocationClosure',
    PositionLotStateClosureContract: 'PositionLotStateClosure',
    UnrealizedPnLObservationContract: 'UnrealizedPnLObservation',
    ExternalCostBasisObservationContract: 'ExternalCostBasisObservation',
    PortfolioPositionReconciliationFindingContract:
      'PortfolioPositionReconciliationFinding',
  }, 'portfolio');
  requireSimpleXone(
    portfolio,
    'PositionValuationInputXone',
    'sh:xone(valuedHoldingSnapshot,valuedPositionSnapshot)',
    'PositionValuation',
    'portfolio',
  );
  pass('MODULE-PP', 'portfolio inventory, PositionLot identity, valuation/cost closure, and reference modes');
}

function validateProjectReferenceEvidence() {
  const mappings = [];
  for (const file of PROJECT_REVIEWS) {
    invariant(fs.existsSync(file), `missing generated project-reference review ${file}`);
    const review = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const entry of review.files || []) {
      for (const mapping of entry.semanticMappings || []) {
        mappings.push({...mapping, sourceFile: entry.path});
      }
    }
  }
  const required = [
    ['https://axiolune.ai/ontology/finance/orders-execution/TimeInForce', 'exact'],
    ['https://axiolune.ai/ontology/finance/orders-execution/OrderSide', 'partial'],
    ['https://axiolune.ai/ontology/finance/orders-execution/OrderType', 'partial'],
    ['https://axiolune.ai/ontology/finance/orders-execution/OrderLifecycleState', 'partial'],
    ['https://axiolune.ai/ontology/finance/portfolio-positions/PositionLot', 'partial'],
  ];
  for (const [target, assessment] of required) {
    invariant(
      mappings.some((mapping) => mapping.m2Target === target && mapping.assessment === assessment),
      `generated project review lacks ${assessment} implementation evidence for ${target}`,
    );
  }
  pass(
    'REFERENCE-IMPLEMENTATION',
    'Nautilus/Lean/RQAlpha review evidence is consumed only as implementation corroboration',
  );
}

function validatePendingCodeListEvidence(documents) {
  const unresolved = [];
  for (const document of documents) {
    for (const [name, codeList] of Object.entries(document.domain?.codeLists || {})) {
      if (codeList.sourceEvidenceRef?.startsWith(PENDING_EVIDENCE)) {
        unresolved.push(`${document.module.moduleIri}#${name}`);
      }
    }
  }
  if (unresolved.length > 0) {
    pend(
      'CODE-LIST-EVIDENCE',
      `${unresolved.length} code lists intentionally remain fail-closed pending locked authoritative selection evidence`,
    );
  } else {
    pass('CODE-LIST-EVIDENCE', 'all code-list source evidence references are locked');
  }
}

function canonicalJcs(value, at = '$') {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, at);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    invariant(Number.isFinite(value), `${at} contains a non-finite number`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalJcs(item, `${at}[${index}]`)).join(',')}]`;
  }
  invariant(
    value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,
    `${at} is not a canonical JSON value`,
  );
  const keys = Object.keys(value).sort();
  for (const key of keys) assertUnicodeScalarString(key, `${at} object key`);
  return `{${keys.map((key) => (
    `${JSON.stringify(key)}:${canonicalJcs(value[key], `${at}.${key}`)}`
  )).join(',')}}`;
}

function assertUnicodeScalarString(value, field) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      invariant(
        next >= 0xdc00 && next <= 0xdfff,
        `${field} contains an unpaired high surrogate and is not valid I-JSON`,
      );
      index += 1;
    } else {
      invariant(
        unit < 0xdc00 || unit > 0xdfff,
        `${field} contains an unpaired low surrogate and is not valid I-JSON`,
      );
    }
  }
}

function sha256Jcs(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJcs(value), 'utf8').digest('hex')}`;
}

function sha256DomainJcs(domain, value) {
  invariant(typeof domain === 'string' && domain.length > 0, 'JCS digest domain is missing');
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(`${domain}\0`, 'utf8'));
  hash.update(Buffer.from(canonicalJcs(value), 'utf8'));
  return `sha256:${hash.digest('hex')}`;
}

function u64be(value) {
  invariant(Number.isSafeInteger(value) && value >= 0, 'u64 value must be a safe non-negative integer');
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function iriSetDigest(values, field = 'IRI set') {
  invariant(Array.isArray(values), `${field} must be an exact-version IRI array`);
  invariant(new Set(values).size === values.length, `${field} contains a duplicate IRI`);
  const encoded = values.map((value) => {
    validateExactRef(value, `${field} member`);
    invariant(value === value.normalize('NFC'), `${field} member is not NFC-normalized`);
    return Buffer.from(value, 'utf8');
  }).sort(Buffer.compare);
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('axiolune-iri-set-v1\0', 'utf8'));
  hash.update(u64be(encoded.length));
  for (const bytes of encoded) {
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function validateClosedIriSet(actual, expected, count, digest, field) {
  invariant(Array.isArray(actual), `${field} is missing`);
  invariant(
    sameSet(actual, expected),
    `${field} is incomplete or contains duplicates`,
  );
  invariant(count === actual.length, `${field} count does not match the exact set`);
  invariant(digest === iriSetDigest(actual, field), `${field} digest does not match RFC section 5.8`);
}

function validateIriSetDigest(actual, expected, digest, field) {
  invariant(Array.isArray(actual), `${field} is missing`);
  invariant(
    sameSet(actual, expected),
    `${field} is incomplete or contains duplicates`,
  );
  invariant(digest === iriSetDigest(actual, field), `${field} digest does not match RFC section 5.8`);
}

function validateEvidencePair(reference, digest, field) {
  invariant(IRI.test(reference || ''), `${field} reference is missing or invalid`);
  invariant(SHA256.test(digest || ''), `${field} digest is missing or invalid`);
}

function validateFixtureSourceLocator(locator, field) {
  invariant(
    typeof locator === 'string'
      && locator.length > 2
      && locator.startsWith('$.')
      && !/\s/u.test(locator),
    `${field} is missing or invalid`,
  );
}

function resolveJsonPointer(document, pointer) {
  invariant(
    typeof pointer === 'string' && pointer.startsWith('/'),
    'raw field locator must be a non-empty JSON Pointer',
  );
  invariant(!/~(?:[^01]|$)/.test(pointer), 'raw field locator contains an invalid JSON Pointer escape');
  let current = document;
  for (const encoded of pointer.slice(1).split('/')) {
    const token = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    invariant(
      current !== null
        && typeof current === 'object'
        && Object.prototype.hasOwnProperty.call(current, token),
      'classified raw field absent from exact source record',
    );
    current = current[token];
  }
  return current;
}

const DECIMAL_LEXICAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ZERO_DECIMAL = Object.freeze({ coefficient: 0n, scale: 0 });

/**
 * Parse a finance-domain decimal without ever entering IEEE-754 arithmetic.
 * The lexical scale is deliberately preserved so a governing precision policy
 * can reject values that are more precise than the reviewed contract permits.
 */
function decimal(value, field) {
  invariant(
    typeof value === 'string',
    `${field} must be an explicitly typed decimal lexical value`,
  );
  invariant(
    value === value.trim() && DECIMAL_LEXICAL.test(value),
    `${field} must be a finite decimal lexical value`,
  );
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart, fractionalPart = ''] = unsigned.split('.');
  invariant(fractionalPart.length <= 18, `${field} exceeds the maximum supported decimal scale 18`);
  const digits = `${integerPart}${fractionalPart}`;
  let coefficient = BigInt(digits);
  if (negative) coefficient = -coefficient;
  return { coefficient, scale: fractionalPart.length };
}

function decimalPower(exponent, field = 'decimal scale') {
  invariant(
    Number.isSafeInteger(exponent) && exponent >= 0 && exponent <= 36,
    `${field} is outside the exact arithmetic profile`,
  );
  return 10n ** BigInt(exponent);
}

function decimalAlign(value, scale) {
  invariant(scale >= value.scale, 'cannot align a decimal to a smaller scale');
  return value.coefficient * decimalPower(scale - value.scale);
}

function decimalCompare(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = decimalAlign(left, scale);
  const rightCoefficient = decimalAlign(right, scale);
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

function decimalEqual(left, right) {
  return decimalCompare(left, right) === 0;
}

function decimalIsZero(value) {
  return value.coefficient === 0n;
}

function decimalIsPositive(value) {
  return value.coefficient > 0n;
}

function decimalIsNonNegative(value) {
  return value.coefficient >= 0n;
}

function decimalAdd(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient: decimalAlign(left, scale) + decimalAlign(right, scale),
    scale,
  };
}

function decimalSubtract(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient: decimalAlign(left, scale) - decimalAlign(right, scale),
    scale,
  };
}

function decimalNegate(value) {
  return { coefficient: -value.coefficient, scale: value.scale };
}

function decimalAbs(value) {
  return value.coefficient < 0n ? decimalNegate(value) : value;
}

function decimalMin(left, right) {
  return decimalCompare(left, right) <= 0 ? left : right;
}

function decimalToString(value) {
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient).toString();
  if (value.scale === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(value.scale + 1, '0');
  const split = padded.length - value.scale;
  return `${negative ? '-' : ''}${padded.slice(0, split)}.${padded.slice(split)}`;
}

function decimalToScaledInteger(value, scale, field) {
  invariant(
    Number.isSafeInteger(scale) && scale >= 0 && scale <= 18,
    `${field} policy scale is outside the exact arithmetic profile`,
  );
  invariant(value.scale <= scale, `${field} exceeds its governing precision scale ${scale}`);
  return value.coefficient * decimalPower(scale - value.scale, `${field} scale`);
}

function scaledIntegerToDecimal(value, scale) {
  invariant(typeof value === 'bigint', 'scaled integer result must be BigInt');
  return { coefficient: value, scale };
}

function instant(value, field) {
  invariant(
    typeof value === 'string' && UTC_INSTANT.test(value),
    `${field} must be an explicit UTC dateTimeStamp`,
  );
  const parsed = Date.parse(value);
  invariant(Number.isFinite(parsed), `${field} must be a valid UTC dateTimeStamp`);
  return parsed;
}

function money(value, field) {
  invariant(value && typeof value === 'object', `${field} must be Money`);
  invariant(typeof value.currency === 'string' && value.currency.length > 0, `${field} missing currency`);
  const result = decimal(value.amount, `${field}.amount`);
  if (value.scale !== undefined) {
    invariant(
      Number.isSafeInteger(value.scale) && value.scale >= 0 && value.scale <= 18,
      `${field}.scale is outside the exact arithmetic profile`,
    );
    invariant(result.scale <= value.scale, `${field}.amount exceeds declared Money scale`);
  }
  return result;
}

function quantity(value, field) {
  invariant(value && typeof value === 'object', `${field} must be Quantity`);
  invariant(typeof value.unit === 'string' && value.unit.length > 0, `${field} missing unit`);
  const result = decimal(value.value, `${field}.value`);
  if (value.precision !== undefined) {
    invariant(
      Number.isSafeInteger(value.precision) && value.precision >= 0 && value.precision <= 18,
      `${field}.precision is outside the exact arithmetic profile`,
    );
    invariant(result.scale <= value.precision, `${field}.value exceeds declared Quantity precision`);
  }
  return result;
}

function validateExactRef(value, field) {
  invariant(IRI.test(value || '') && EXACT_VERSION_IRI.test(value), `${field} must be an exact version IRI`);
}

function validateLiquidityDetermination(instance) {
  const {stream, determination, mapping, sourceRecord} = instance;
  invariant(
    ['required', 'optional', 'unsupported'].includes(stream?.capability),
    'invalid stream liquidity capability',
  );
  invariant(
    IRI.test(stream.sourceContractRef || '') && SHA256.test(stream.sourceContractDigest || ''),
    'event stream lacks exact source-contract evidence',
  );
  invariant(determination?.perspective === 'executionAccountOrder', 'wrong liquidity perspective');
  invariant(IRI.test(determination.sourceRecordRef || ''), 'missing exact source record IRI');
  invariant(SHA256.test(determination.sourceRecordDigest || ''), 'missing source record digest');
  invariant(sourceRecord && typeof sourceRecord === 'object', 'missing exact source record bytes');
  invariant(
    determination.sourceRecordDigest === sha256Jcs(sourceRecord),
    'source record digest does not match canonical source record bytes',
  );

  if (determination.result === 'classified') {
    invariant(stream.capability !== 'unsupported', 'unsupported stream cannot classify liquidity');
    invariant(['maker', 'taker', 'auctionUndefined'].includes(determination.role), 'invalid role');
    invariant(mapping && sourceRecord, 'classified branch requires mapping and source record');
    validateExactRef(mapping.versionIri, 'mapping.versionIri');
    invariant(
      mapping.sourceContractRef === stream.sourceContractRef
        && mapping.sourceContractDigest === stream.sourceContractDigest,
      'liquidity mapping source contract differs from the event stream',
    );
    invariant(
      determination.rawFieldLocator === mapping.rawFieldLocator,
      'stored raw field locator differs from the exact mapping locator',
    );
    const raw = resolveJsonPointer(sourceRecord, mapping.rawFieldLocator);
    invariant(typeof raw === 'string', 'classified provider value must be a lexical string');
    invariant(raw === determination.rawLexicalValue, 'stored raw lexical value differs from record');
    invariant(mapping.values?.[raw] === determination.role, 'mapping does not produce stored role');
    invariant(
      mapping.rawPerspective === 'executionAccountOrder'
        || (mapping.rawPerspective === 'contraOrder' && mapping.perspectiveInversion === true),
      'contra perspective lacks reviewed inversion',
    );
    if (determination.role === 'auctionUndefined') {
      invariant(mapping.auctionSemantic === true, 'auctionUndefined lacks explicit contract semantic');
    }
    invariant(!determination.unavailableReason, 'classified branch has unavailable reason');
    invariant(!determination.absenceProbe, 'classified branch has absence probe');
  } else {
    invariant(determination.result === 'unavailable', 'unknown result branch');
    invariant(!determination.role && !mapping, 'unavailable branch cannot carry role or mapping');
    invariant(!determination.rawFieldLocator && !determination.rawLexicalValue, 'unavailable branch has raw value');
    if (stream.capability === 'unsupported') {
      invariant(
        determination.unavailableReason === 'contractUnsupported',
        'unsupported capability requires contractUnsupported',
      );
      invariant(!determination.absenceProbe, 'contractUnsupported forbids fabricated field probe');
    } else {
      invariant(stream.capability === 'optional', 'required capability cannot be unavailable');
      invariant(
        determination.unavailableReason === 'providerNotSpecified',
        'optional absence requires providerNotSpecified',
      );
      invariant(
        determination.absenceProbe?.status === 'completed'
          && determination.absenceProbe?.result === true
          && determination.absenceProbe?.rawFieldLocator === stream.rawFieldLocator
          && determination.absenceProbe?.sourceRecordDigest === determination.sourceRecordDigest,
        'providerNotSpecified requires completed true field-absence probe',
      );
      invariant(
        typeof stream.rawFieldLocator === 'string' && stream.rawFieldLocator.startsWith('/'),
        'optional stream must declare the probed raw field locator',
      );
      let fieldPresent = true;
      try {
        resolveJsonPointer(sourceRecord, stream.rawFieldLocator);
      } catch (error) {
        if (error.message === 'classified raw field absent from exact source record') fieldPresent = false;
        else throw error;
      }
      invariant(!fieldPresent, 'providerNotSpecified source record actually contains the declared field');
    }
  }
}

function detectOrderDefects(instance) {
  const events = instance.events || [];
  const defects = new Set();
  const byId = new Map();
  const eventIdBySourceOrderKey = new Map();
  let priorArrivalKey = null;
  let terminal = null;
  const sortedKeys = [...new Set(events.map((event) => event.sourceOrderKey))].sort((a, b) => a - b);
  for (let index = 1; index < sortedKeys.length; index += 1) {
    if (sortedKeys[index] > sortedKeys[index - 1] + 1) {
      defects.add(`sequenceGap:${sortedKeys[index - 1] + 1}-${sortedKeys[index]}`);
    }
  }
  for (const event of events) {
    invariant(!Object.prototype.hasOwnProperty.call(event, 'previousState'), 'previousState is forbidden stored truth');
    invariant(Number.isSafeInteger(event.sourceOrderKey) && event.sourceOrderKey >= 0, 'invalid sourceOrderKey');
    if (priorArrivalKey !== null && event.sourceOrderKey < priorArrivalKey) {
      defects.add(`outOfOrder:${event.sourceOrderKey}-${priorArrivalKey}`);
    }
    priorArrivalKey = event.sourceOrderKey;
    invariant(
      typeof event.providerEventId === 'string' && event.providerEventId.length > 0,
      'missing providerEventId',
    );
    invariant(ORDER_EVENT_KINDS.has(event.kind), 'invalid OrderEventKind');
    invariant(ORDER_LIFECYCLE_STATES.has(event.state), 'invalid OrderLifecycleState');
    invariant(
      !eventIdBySourceOrderKey.has(event.sourceOrderKey)
        || eventIdBySourceOrderKey.get(event.sourceOrderKey) === event.providerEventId,
      'sourceOrderKey collision between distinct provider event IDs',
    );
    eventIdBySourceOrderKey.set(event.sourceOrderKey, event.providerEventId);
    const canonical = canonicalJcs(event, `event(${event.providerEventId})`);
    if (byId.has(event.providerEventId) && byId.get(event.providerEventId) !== canonical) {
      defects.add(`duplicateConflict:${event.providerEventId}`);
    } else {
      byId.set(event.providerEventId, canonical);
    }
    if (event.kind === 'Filled' && terminal) {
      defects.add(`lateFill:${event.versionIri}-${terminal}`);
    }
    if (['Canceled', 'Expired', 'Rejected', 'Filled'].includes(event.state)) {
      terminal = event.versionIri;
    }
  }
  if (instance.acknowledgementExpectation) {
    const expectation = instance.acknowledgementExpectation;
    validateExactRef(
      expectation.externalOrderVersionIri,
      'acknowledgementExpectation.externalOrderVersionIri',
    );
    invariant(
      Number.isSafeInteger(expectation.expectedAfterSourceOrderKey)
        && expectation.expectedAfterSourceOrderKey >= 0,
      'invalid acknowledgement expectedAfterSourceOrderKey',
    );
    const acknowledged = events.some((event) => (
      event.kind === expectation.requiredEventKind
      && event.sourceOrderKey > expectation.expectedAfterSourceOrderKey
    ));
    if (!acknowledged) {
      defects.add(
        `missingAcknowledgement:${expectation.externalOrderVersionIri}-${expectation.expectedAfterSourceOrderKey}`,
      );
    }
  }
  if (instance.transitionProfile) {
    const profile = instance.transitionProfile;
    validateExactRef(profile.versionIri, 'transitionProfile.versionIri');
    const occurrenceOrder = [...events].sort(
      (left, right) => left.sourceOrderKey - right.sourceOrderKey,
    );
    for (let index = 1; index < occurrenceOrder.length; index += 1) {
      const from = occurrenceOrder[index - 1];
      const to = occurrenceOrder[index];
      if (!(profile.allowedTransitions?.[from.state] || []).includes(to.state)) {
        defects.add(
          `transitionViolation:${from.versionIri}-${to.versionIri}-${profile.versionIri}`,
        );
      }
    }
  }
  return defects;
}

function requireExactObjectKeys(value, expected, field) {
  invariant(
    value && typeof value === 'object' && !Array.isArray(value),
    `${field} must be a JCS object`,
  );
  invariant(
    sameSet(Object.keys(value), expected),
    `${field} has missing or extraneous fields`,
  );
}

function findingSubjectLegacy(kind, subject) {
  switch (kind) {
    case 'duplicateConflict':
      requireExactObjectKeys(subject, ['providerEventId'], 'duplicateConflict subject');
      invariant(
        typeof subject.providerEventId === 'string' && subject.providerEventId.length > 0,
        'duplicateConflict subject has invalid providerEventId',
      );
      return subject.providerEventId;
    case 'sequenceGap':
      requireExactObjectKeys(subject, ['missingFrom', 'missingTo'], 'sequenceGap subject');
      invariant(
        Number.isSafeInteger(subject.missingFrom)
          && Number.isSafeInteger(subject.missingTo)
          && subject.missingFrom >= 0
          && subject.missingTo > subject.missingFrom,
        'sequenceGap subject has invalid half-open interval',
      );
      return `${subject.missingFrom}-${subject.missingTo}`;
    case 'outOfOrder':
      requireExactObjectKeys(
        subject,
        ['observedKey', 'requiredPredecessorKey'],
        'outOfOrder subject',
      );
      invariant(
        Number.isSafeInteger(subject.observedKey)
          && Number.isSafeInteger(subject.requiredPredecessorKey)
          && subject.observedKey >= 0
          && subject.requiredPredecessorKey >= 0,
        'outOfOrder subject has invalid source-order keys',
      );
      return `${subject.observedKey}-${subject.requiredPredecessorKey}`;
    case 'lateFill':
      requireExactObjectKeys(
        subject,
        ['fillVersionIri', 'terminalEventVersionIri'],
        'lateFill subject',
      );
      validateExactRef(subject.fillVersionIri, 'lateFill subject.fillVersionIri');
      validateExactRef(
        subject.terminalEventVersionIri,
        'lateFill subject.terminalEventVersionIri',
      );
      return `${subject.fillVersionIri}-${subject.terminalEventVersionIri}`;
    case 'missingAcknowledgement':
      requireExactObjectKeys(
        subject,
        ['externalOrderVersionIri', 'expectedAfterKey'],
        'missingAcknowledgement subject',
      );
      validateExactRef(
        subject.externalOrderVersionIri,
        'missingAcknowledgement subject.externalOrderVersionIri',
      );
      invariant(
        Number.isSafeInteger(subject.expectedAfterKey) && subject.expectedAfterKey >= 0,
        'missingAcknowledgement subject has invalid expectedAfterKey',
      );
      return `${subject.externalOrderVersionIri}-${subject.expectedAfterKey}`;
    case 'transitionViolation':
      requireExactObjectKeys(
        subject,
        ['fromEventVersionIri', 'toEventVersionIri', 'transitionProfileVersionIri'],
        'transitionViolation subject',
      );
      for (const name of [
        'fromEventVersionIri',
        'toEventVersionIri',
        'transitionProfileVersionIri',
      ]) {
        validateExactRef(subject[name], `transitionViolation subject.${name}`);
      }
      return [
        subject.fromEventVersionIri,
        subject.toEventVersionIri,
        subject.transitionProfileVersionIri,
      ].join('-');
    default:
      throw new Error(`invalid OrderIntegrityKind ${kind}`);
  }
}

function expectedFindingRelatedVersions(instance, finding) {
  const subject = finding.findingSubject;
  switch (finding.kind) {
    case 'duplicateConflict':
      return instance.events
        .filter((event) => event.providerEventId === subject.providerEventId)
        .map((event) => event.versionIri);
    case 'sequenceGap':
      return instance.events
        .filter((event) => (
          event.sourceOrderKey === subject.missingFrom - 1
            || event.sourceOrderKey === subject.missingTo
        ))
        .map((event) => event.versionIri);
    case 'outOfOrder':
      return instance.events
        .filter((event) => (
          event.sourceOrderKey === subject.observedKey
            || event.sourceOrderKey === subject.requiredPredecessorKey
        ))
        .map((event) => event.versionIri);
    case 'lateFill':
      return [subject.fillVersionIri, subject.terminalEventVersionIri];
    case 'missingAcknowledgement':
      return [
        subject.externalOrderVersionIri,
        ...instance.events
          .filter((event) => event.sourceOrderKey <= subject.expectedAfterKey)
          .map((event) => event.versionIri),
      ];
    case 'transitionViolation':
      return [
        subject.fromEventVersionIri,
        subject.toEventVersionIri,
        subject.transitionProfileVersionIri,
      ];
    default:
      throw new Error(`invalid OrderIntegrityKind ${finding.kind}`);
  }
}

function validateOrderFinding(instance, finding) {
  invariant(
    !Object.prototype.hasOwnProperty.call(finding, 'subject'),
    'legacy flattened order finding subject is forbidden',
  );
  findingSubjectLegacy(finding.kind, finding.findingSubject);
  validateExactRef(finding.findingVersionIri, 'finding.findingVersionIri');
  validateExactRef(finding.findingStreamVersionIri, 'finding.findingStreamVersionIri');
  invariant(
    finding.findingStreamVersionIri === instance.streamVersionIri,
    'order finding points to another event stream version',
  );
  invariant(
    finding.affectedKeyDigest
      === sha256DomainJcs('axiolune-order-finding-subject-v1', finding.findingSubject),
    'order finding affectedKeyDigest does not match its strict JCS subject',
  );
  const expectedRelated = expectedFindingRelatedVersions(instance, finding);
  invariant(expectedRelated.length > 0, 'order finding lacks an exact related version');
  validateIriSetDigest(
    finding.relatedVersionIris,
    expectedRelated,
    finding.relatedVersionSetDigest,
    'order finding related-version set',
  );
  for (const name of ['validFrom', 'knowledgeFrom', 'availableFrom']) {
    instant(finding[name], `finding.${name}`);
  }
  invariant(
    finding.revision === 0,
    'fixture order finding must begin its immutable version chain at revision 0',
  );
  invariant(
    IRI.test(finding.generatingContextRef || ''),
    'order finding generatingContextRef is missing or invalid',
  );
}

function validateOrderStreamIntegrity(instance) {
  const events = instance.events || [];
  const findings = instance.findings || [];
  validateExactRef(instance.streamVersionIri, 'OrderEventStream.versionIri');
  for (const event of events) {
    validateExactRef(event.versionIri, 'event.versionIri');
  }
  const expected = detectOrderDefects(instance);
  const actual = new Set(findings.map((finding) => {
    const subject = Object.prototype.hasOwnProperty.call(finding, 'subject')
      ? finding.subject
      : findingSubjectLegacy(finding.kind, finding.findingSubject);
    return `${finding.kind}:${subject}`;
  }));
  invariant(
    sameSet([...actual], [...expected]),
    `integrity finding set mismatch: expected ${[...expected].join(',')} got ${[...actual].join(',')}`,
  );
  for (const finding of findings) validateOrderFinding(instance, finding);
}

function validateExecutionContract(instance) {
  validateExactRef(instance.streamVersionIri, 'streamVersionIri');
  validateExactRef(instance.externalOrderVersionIri, 'externalOrderVersionIri');
  validateExactRef(instance.orderIntentVersionIri, 'orderIntentVersionIri');
  validateExactRef(instance.quotation.versionIri, 'quotation.versionIri');
  invariant(
    IRI.test(instance.account || '')
      && IRI.test(instance.instrument || '')
      && IRI.test(instance.executionParty || '')
      && IRI.test(instance.contraAccount || '')
      && IRI.test(instance.contraParty || ''),
    'missing logical account/instrument or principal/contra party-account role',
  );
  invariant(['Buy', 'Sell'].includes(instance.side), 'invalid execution side');
  const amount = quantity(instance.quantity, 'quantity');
  invariant(decimalIsPositive(amount), 'execution quantity must be strictly positive absolute Quantity');
  const price = money(instance.price, 'price');
  invariant(decimalIsNonNegative(price), 'execution price cannot be negative');
  invariant(Boolean(instance.listingVersionIri) !== Boolean(instance.otcContextVersionIri), 'execution context must be listing xone OTC');
  if (instance.listingVersionIri) validateExactRef(instance.listingVersionIri, 'listingVersionIri');
  if (instance.otcContextVersionIri) validateExactRef(instance.otcContextVersionIri, 'otcContextVersionIri');
  const expectedContext = instance.listingVersionIri || instance.otcContextVersionIri;
  invariant(instance.quotation.contextVersionIri === expectedContext, 'quotation context differs from execution');
  invariant(instance.quotation.instrument === instance.instrument, 'quotation instrument differs from execution');
  invariant(instance.quotation.quoteCurrency === instance.price.currency, 'quotation currency differs from price');
  invariant(instance.quotation.denominatorUnit === instance.quantity.unit, 'quotation denominator differs from quantity unit');
  for (const forbidden of ['signedQuantity', 'liquidityRole', 'commission', 'facility']) {
    invariant(!Object.prototype.hasOwnProperty.call(instance, forbidden), `Execution contains forbidden duplicate ${forbidden}`);
  }
}

function validateOrderIntentContract(instance) {
  invariant(IRI.test(instance.account || '') && IRI.test(instance.instrument || ''), 'intent missing logical account/instrument');
  invariant(['Buy', 'Sell'].includes(instance.side), 'invalid intent side');
  invariant(
    decimalIsPositive(quantity(instance.quantity, 'intent.quantity')),
    'intent quantity must be strictly positive absolute Quantity',
  );
  invariant(
    ['Market', 'Limit', 'Stop', 'StopLimit', 'MarketIfTouched', 'LimitIfTouched'].includes(instance.orderType),
    'invalid order type',
  );
  invariant(
    ['GTC', 'IOC', 'FOK', 'DAY', 'GTD', 'AtTheOpen', 'AtTheClose'].includes(instance.timeInForce),
    'invalid time in force',
  );
  invariant(Boolean(instance.listingVersionIri) !== Boolean(instance.otcContextVersionIri), 'intent context must be listing xone OTC');
  if (instance.listingVersionIri) validateExactRef(instance.listingVersionIri, 'intent.listingVersionIri');
  if (instance.otcContextVersionIri) validateExactRef(instance.otcContextVersionIri, 'intent.otcContextVersionIri');
  const hasLimit = instance.limitPrice !== undefined;
  const hasTrigger = instance.triggerPrice !== undefined;
  const hasTriggerBasis = instance.triggerPriceBasis !== undefined;
  const matrix = {
    Market: [false, false],
    Limit: [true, false],
    Stop: [false, true],
    StopLimit: [true, true],
    MarketIfTouched: [false, true],
    LimitIfTouched: [true, true],
  };
  invariant(
    hasLimit === matrix[instance.orderType][0] && hasTrigger === matrix[instance.orderType][1],
    `order-type field matrix violated for ${instance.orderType}`,
  );
  if (hasLimit) invariant(decimalIsNonNegative(money(instance.limitPrice, 'limitPrice')), 'negative limit price');
  if (hasTrigger) {
    invariant(decimalIsNonNegative(money(instance.triggerPrice, 'triggerPrice')), 'negative trigger price');
    invariant(
      hasTriggerBasis && TRIGGER_PRICE_BASES.has(instance.triggerPriceBasis),
      'trigger order requires exactly one reviewed triggerPriceBasis',
    );
  } else {
    invariant(!hasTriggerBasis, 'non-trigger order forbids triggerPriceBasis');
  }
  invariant(
    (instance.timeInForce === 'GTD') === Boolean(instance.validUntil),
    'GTD requires and only GTD permits explicit validUntil in this v0.3 fixture profile',
  );
  if (instance.validUntil) instant(instance.validUntil, 'validUntil');
  for (const forbidden of ['signedQuantity', 'facility', 'previousState']) {
    invariant(!Object.prototype.hasOwnProperty.call(instance, forbidden), `OrderIntent contains forbidden duplicate ${forbidden}`);
  }
}

function validateExternalStatusMapping(instance) {
  invariant(instance.publicName === 'ExternalOrderStatusMapping', 'canonical public mapping name changed or aliased');
  invariant(IRI.test(instance.provider || ''), 'status mapping lacks provider');
  for (const field of ['apiIdentifier', 'schemaVersion', 'mappingVersion', 'rawCode']) {
    invariant(typeof instance[field] === 'string' && instance[field].length > 0, `status mapping lacks ${field}`);
  }
  invariant(
    Array.isArray(instance.canonicalTargets) && instance.canonicalTargets.length === 1,
    'external status mapping must have exactly one canonical target',
  );
  invariant(
    typeof instance.canonicalTargets[0] === 'string' && instance.canonicalTargets[0].length > 0,
    'canonical status target is empty',
  );
  invariant(
    ORDER_LIFECYCLE_STATES.has(instance.canonicalTargets[0]),
    'external status mapping target is not a reviewed OrderLifecycleState',
  );
  const validFrom = instant(instance.validFrom, 'status mapping validFrom');
  if (instance.validTo !== undefined) {
    invariant(
      instant(instance.validTo, 'status mapping validTo') > validFrom,
      'status mapping validTo must be strictly greater than validFrom',
    );
  }
  invariant(IRI.test(instance.sourceRef || '') && SHA256.test(instance.sourceDigest || ''), 'status mapping source evidence is incomplete');
  invariant(IRI.test(instance.reviewRef || '') && SHA256.test(instance.reviewDigest || ''), 'status mapping review evidence is incomplete');
}

function validateFeeContract(instance) {
  validateExactRef(instance.executionVersionIri, 'executionVersionIri');
  invariant(['commission', 'exchange', 'clearing', 'regulatory', 'tax', 'other'].includes(instance.kind), 'invalid Fee kind');
  invariant(['charge', 'rebate'].includes(instance.effect), 'invalid Fee effect');
  invariant(decimalIsPositive(money(instance.amount, 'fee.amount')), 'Fee amount must be strictly positive');
}

function validatePositionLotIdentity(instance) {
  const logicalToKey = new Map();
  const keyToLogical = new Map();
  const versionKeys = new Map();
  const versionOwners = new Map();
  const byLogical = new Map();
  for (const lot of instance.lots || []) {
    invariant(IRI.test(lot.logicalIri || ''), 'PositionLot missing logical IRI');
    validateExactRef(lot.versionIri, 'PositionLot.versionIri');
    invariant(IRI.test(lot.account || '') && IRI.test(lot.instrument || ''), 'PositionLot missing account/instrument logical IRI');
    invariant(IRI.test(lot.openingExecutionLogicalIri || ''), 'PositionLot missing opening Execution logical IRI');
    validateExactRef(lot.openingExecutionVersionIri, 'openingExecutionVersionIri');
    invariant(IRI.test(lot.costBasisDefinitionLogicalIri || ''), 'PositionLot missing cost definition logical IRI');
    validateExactRef(lot.costBasisDefinitionVersionIri, 'costBasisDefinitionVersionIri');
    invariant(lot.discriminator === 'openingRemainder', 'PositionLot discriminator is not openingRemainder');
    for (const forbidden of ['cost', 'side', 'strategy', 'rowNumber', 'arrivalOrder']) {
      invariant(!Object.prototype.hasOwnProperty.call(lot, forbidden), `PositionLot contains forbidden ${forbidden}`);
    }
    invariant(Number.isSafeInteger(lot.revision) && lot.revision >= 0, 'PositionLot revision must be non-negative integer');
    invariant(
      !Object.prototype.hasOwnProperty.call(lot, 'knowledgeTo')
        && !Object.prototype.hasOwnProperty.call(lot, 'availableTo'),
      'PositionLot FactVersion must not store knowledgeTo or availableTo',
    );
    for (const field of ['validFrom', 'knowledgeFrom', 'availableFrom']) {
      instant(lot[field], `PositionLot.${field}`);
    }
    const key = [
      lot.account,
      lot.instrument,
      lot.openingExecutionLogicalIri,
      lot.costBasisDefinitionLogicalIri,
      lot.discriminator,
    ].join('\u001f');
    invariant(!logicalToKey.has(lot.logicalIri) || logicalToKey.get(lot.logicalIri) === key, 'PositionLot logical key drift');
    logicalToKey.set(lot.logicalIri, key);
    invariant(!keyToLogical.has(key) || keyToLogical.get(key) === lot.logicalIri, 'two logical lots share one openingRemainder tuple');
    keyToLogical.set(key, lot.logicalIri);
    const versionKey = [
      lot.logicalIri,
      lot.validFrom,
      lot.knowledgeFrom,
      lot.availableFrom,
      lot.revision,
    ].join('\u001f');
    const canonicalContent = canonicalJcs(lot);
    const existingVersionKey = versionKeys.get(versionKey);
    invariant(
      existingVersionKey === undefined || existingVersionKey.versionIri === lot.versionIri,
      'PositionLot version-key conflict',
    );
    invariant(
      existingVersionKey === undefined || existingVersionKey.canonicalContent === canonicalContent,
      'PositionLot version-content conflict',
    );
    const owner = `${lot.logicalIri}\u001f${versionKey}`;
    const existingOwner = versionOwners.get(lot.versionIri);
    invariant(
      existingOwner === undefined || existingOwner.owner === owner,
      'PositionLot version IRI is reused by another logical/version key',
    );
    invariant(
      existingOwner === undefined || existingOwner.canonicalContent === canonicalContent,
      'PositionLot version-content conflict',
    );
    if (existingVersionKey !== undefined) {
      // A byte-order-independent replay of the same canonical version is
      // idempotent. It must not create a second revision node or branch.
      continue;
    }
    versionKeys.set(versionKey, { versionIri: lot.versionIri, canonicalContent });
    versionOwners.set(lot.versionIri, { owner, canonicalContent });
    const versions = byLogical.get(lot.logicalIri) || [];
    versions.push(lot);
    byLogical.set(lot.logicalIri, versions);
  }
  const requiredClosures = new Map();
  for (const versions of byLogical.values()) {
    versions.sort((left, right) => left.revision - right.revision);
    invariant(versions[0].revision === 0, 'PositionLot correction chain must begin at revision 0');
    for (let index = 1; index < versions.length; index += 1) {
      invariant(versions[index].revision === versions[index - 1].revision + 1, 'PositionLot correction revision chain has a gap or branch');
      invariant(
        instant(versions[index].knowledgeFrom, 'successor.knowledgeFrom')
          > instant(versions[index - 1].knowledgeFrom, 'predecessor.knowledgeFrom'),
        'PositionLot successor knowledgeFrom must be strictly later than its predecessor',
      );
      invariant(
        versions[index].supersedesVersionIri === versions[index - 1].versionIri,
        'PositionLot successor does not supersede its unique direct predecessor',
      );
      requiredClosures.set(versions[index - 1].versionIri, versions[index]);
    }
  }
  const closures = instance.knowledgeClosures || [];
  const closureTargets = new Set();
  for (const closure of closures) {
    validateExactRef(closure.targetVersionIri, 'knowledgeClosure.targetVersionIri');
    validateExactRef(closure.causeVersionIri, 'knowledgeClosure.causeVersionIri');
    invariant(!closureTargets.has(closure.targetVersionIri), 'duplicate PositionLot knowledge closure');
    closureTargets.add(closure.targetVersionIri);
    const successor = requiredClosures.get(closure.targetVersionIri);
    invariant(successor, 'PositionLot knowledge closure targets a terminal or unknown version');
    invariant(
      closure.axis === 'knowledge'
        && closure.causeKind === 'successor'
        && closure.causeVersionIri === successor.versionIri
        && closure.closedAt === successor.knowledgeFrom,
      'PositionLot successor knowledge closure does not match the direct successor',
    );
    invariant(IRI.test(closure.evidenceRef || ''), 'PositionLot knowledge closure lacks evidenceRef');
    invariant(IRI.test(closure.generatingContextRef || ''), 'PositionLot knowledge closure lacks generatingContextRef');
  }
  invariant(
    sameSet([...closureTargets], [...requiredClosures.keys()]),
    'PositionLot correction chain lacks its exact successor knowledge closures',
  );
}

function validateSnapshotContract(instance) {
  invariant(['holding', 'position'].includes(instance.kind), 'invalid snapshot kind');
  invariant(IRI.test(instance.account || '') && IRI.test(instance.instrument || ''), 'missing account/instrument');
  const value = quantity(instance.quantity, 'snapshot.quantity');
  invariant(!Object.prototype.hasOwnProperty.call(instance, 'side'), 'snapshot stores forbidden side truth');
  invariant(!Object.prototype.hasOwnProperty.call(instance, 'portfolio'), 'snapshot stores forbidden Portfolio edge');
  if (instance.kind === 'holding') {
    invariant(decimalIsNonNegative(value), 'HoldingSnapshot quantity cannot be negative');
  }
}

function validatePolicyArtifact(artifact, predicate, field) {
  invariant(artifact && typeof artifact === 'object', `${field} artifact is missing`);
  validateEvidencePair(artifact.ref, artifact.digest, field);
  invariant(artifact.payload && typeof artifact.payload === 'object', `${field} payload is missing`);
  invariant(artifact.digest === sha256Jcs(artifact.payload), `${field} digest does not match canonical policy bytes`);
  invariant(predicate(artifact.payload), `${field} payload is outside the reviewed exact-arithmetic profile`);
  return artifact.payload;
}

function validateCalculationPolicies(owner, kind, field) {
  const valuation = kind === 'valuation';
  invariant(valuation || kind === 'costBasis', `${field} has an unsupported calculation-policy kind`);
  const precision = validatePolicyArtifact(
    owner?.precisionPolicy,
    valuation ? isValuationPrecisionPolicy : isCostBasisPrecisionPolicy,
    `${field}.precisionPolicy`,
  );
  const rounding = validatePolicyArtifact(
    owner?.roundingPolicy,
    valuation ? isValuationRoundingPolicy : isCostBasisRoundingPolicy,
    `${field}.roundingPolicy`,
  );
  invariant(
    precision.amountScale === rounding.outputScale,
    `${field} amount precision and rounding output scales differ`,
  );
  return { precision, rounding };
}

function samePolicyArtifact(left, right) {
  return Boolean(left && right)
    && left.ref === right.ref
    && left?.digest === right?.digest
    && canonicalJcs(left?.payload) === canonicalJcs(right?.payload);
}

function validateStructuredScales(value, decimalValue, requiredScale, field, scaleField) {
  invariant(
    value?.[scaleField] === requiredScale,
    `${field}.${scaleField} does not match its governing precision policy`,
  );
  decimalToScaledInteger(decimalValue, requiredScale, field);
}

function exactFxValue(inputAmount, rate, direction, precision, rounding) {
  const inputRaw = decimalToScaledInteger(inputAmount, precision.amountScale, 'FX inputMoney.amount');
  const rateRaw = decimalToScaledInteger(rate, precision.rateScale, 'FX rate');
  invariant(rateRaw > 0n, 'FX rate must be strictly positive');
  const outputFactor = decimalPower(rounding.outputScale, 'FX output scale');
  const inputFactor = decimalPower(precision.amountScale, 'FX input scale');
  const rateFactor = decimalPower(precision.rateScale, 'FX rate scale');
  let numerator;
  let denominator;
  if (direction === 'baseToQuote') {
    numerator = inputRaw * rateRaw * outputFactor;
    denominator = inputFactor * rateFactor;
  } else {
    invariant(direction === 'quoteToBase', 'invalid FX direction');
    numerator = inputRaw * rateFactor * outputFactor;
    denominator = inputFactor * rateRaw;
  }
  return scaledIntegerToDecimal(
    quantizeRational(numerator, denominator, rounding.mode),
    rounding.outputScale,
  );
}

function validateFxConversion(
  conversion,
  inputAmount,
  inputCurrency,
  outputCurrency,
  context = 'calculation',
  policies,
  consumer,
) {
  invariant(conversion, `cross-currency ${context} requires FXConversion`);
  validateExactRef(conversion.versionIri, `${context}.fxConversion.versionIri`);
  validateExactRef(conversion.rateVersionIri, 'rateVersionIri');
  invariant(policies?.precision && policies?.rounding, `${context} lacks governing precision/rounding policies`);
  invariant(
    samePolicyArtifact(conversion.roundingPolicy, consumer?.roundingPolicy),
    'FX rounding policy differs from its exact consumer definition',
  );
  const conversionRounding = validatePolicyArtifact(
    conversion.roundingPolicy,
    consumer?.policyKind === 'costBasis' ? isCostBasisRoundingPolicy : isValuationRoundingPolicy,
    `${context}.fxConversion.roundingPolicy`,
  );
  invariant(
    canonicalJcs(conversionRounding) === canonicalJcs(policies.rounding),
    'FX rounding policy payload differs from its exact consumer definition',
  );
  invariant(
    conversion.consumerKind === consumer?.kind
      && conversion.consumerVersionIri === consumer?.versionIri
      && consumer?.fxConversionVersionIri === conversion.versionIri,
    'FX conversion does not close exactly one bidirectional consumer edge',
  );
  validateExactRef(conversion.consumerVersionIri, 'FX consumerVersionIri');
  invariant(!Object.prototype.hasOwnProperty.call(conversion, 'rate'), 'FXConversion forbids an unversioned inline rate duplicate');
  const rateObservation = conversion.rateObservation;
  invariant(rateObservation && typeof rateObservation === 'object', 'FX conversion lacks its exact rate observation');
  validateExactRef(rateObservation.versionIri, 'FX rateObservation.versionIri');
  invariant(rateObservation.versionIri === conversion.rateVersionIri, 'FX rate version does not resolve to the embedded exact observation');
  invariant(
    conversion.baseCurrency === rateObservation.baseCurrency
      && conversion.quoteCurrency === rateObservation.quoteCurrency,
    'FX currencies differ from the exact rate observation',
  );
  invariant(conversion.baseCurrency !== conversion.quoteCurrency, 'FX base and quote currencies must differ');
  const rate = quantity(rateObservation.rate, 'FX rateObservation.rate');
  validateStructuredScales(
    rateObservation.rate,
    rate,
    policies.precision.rateScale,
    'FX rateObservation.rate',
    'precision',
  );
  invariant(
    rateObservation.rate.unit === `urn:unit:${conversion.quoteCurrency}-per-${conversion.baseCurrency}`,
    'FX rate unit does not encode the exact quote-per-base orientation',
  );
  invariant(decimalIsPositive(rate), 'FX rate must be strictly positive');
  const conversionTemporal = {};
  const rateTemporal = {};
  for (const axis of ['validFrom', 'knowledgeFrom', 'availableFrom']) {
    conversionTemporal[axis] = instant(conversion[axis], `FXConversion.${axis}`);
    rateTemporal[axis] = instant(rateObservation[axis], `FXRateObservation.${axis}`);
    invariant(
      rateTemporal[axis] <= conversionTemporal[axis],
      `FX rate is not point-in-time eligible on the ${axis} axis`,
    );
  }
  const inputContext = conversion.inputContext;
  invariant(inputContext && typeof inputContext === 'object', 'FX conversion lacks a completed input context');
  validateEvidencePair(inputContext.ref, inputContext.digest, 'FX input context');
  invariant(
    inputContext.payload && inputContext.digest === sha256Jcs(inputContext.payload),
    'FX input-context digest does not match canonical context bytes',
  );
  invariant(inputContext.payload.status === 'completed', 'FX input context is not completed');
  invariant(
    instant(inputContext.payload.completedAt, 'FX inputContext.completedAt') <= conversionTemporal.knowledgeFrom,
    'FX input context completed after the conversion knowledge pivot',
  );
  invariant(IRI.test(conversion.generatingContextRef || ''), 'FX generatingContextRef is missing or invalid');
  const output = money(conversion.outputMoney, 'FX outputMoney');
  const declaredInput = money(conversion.inputMoney, 'FX inputMoney');
  validateStructuredScales(
    conversion.inputMoney,
    declaredInput,
    policies.precision.amountScale,
    'FX inputMoney',
    'scale',
  );
  validateStructuredScales(
    conversion.outputMoney,
    output,
    policies.rounding.outputScale,
    'FX outputMoney',
    'scale',
  );
  invariant(conversion.inputMoney.currency === inputCurrency, 'FX input currency mismatch');
  invariant(conversion.outputMoney.currency === outputCurrency, 'FX output currency mismatch');
  invariant(decimalEqual(declaredInput, inputAmount), 'FX input amount mismatch');
  if (conversion.direction === 'baseToQuote') {
    invariant(inputCurrency === conversion.baseCurrency && outputCurrency === conversion.quoteCurrency, 'baseToQuote orientation mismatch');
  } else {
    invariant(conversion.direction === 'quoteToBase', 'invalid FX direction');
    invariant(inputCurrency === conversion.quoteCurrency && outputCurrency === conversion.baseCurrency, 'quoteToBase orientation mismatch');
  }
  const expected = exactFxValue(inputAmount, rate, conversion.direction, policies.precision, policies.rounding);
  invariant(
    decimalEqual(output, expected),
    `FX arithmetic mismatch: expected ${decimalToString(expected)}`,
  );
  return output;
}

function validatePositionValuation(instance) {
  const inputs = [instance.holdingSnapshot, instance.positionSnapshot].filter(Boolean);
  invariant(inputs.length === 1, 'PositionValuation requires HoldingSnapshot xone PositionSnapshot');
  const snapshot = inputs[0];
  validateExactRef(instance.header.versionIri, 'header.versionIri');
  validateExactRef(snapshot.versionIri, 'snapshot.versionIri');
  validateExactRef(instance.price.versionIri, 'price.versionIri');
  validateExactRef(instance.header.definitionVersionIri, 'definitionVersionIri');
  validateExactRef(instance.price.quotationContractVersionIri, 'price quotation contract');
  invariant(instance.header.method === 'directUnitPriceTimesQuantity', 'unsupported valuation method');
  invariant(
    instance.header.quotationContractVersionIri === instance.price.quotationContractVersionIri,
    'header definition and price use different quotation contracts',
  );
  invariant(
    Array.isArray(instance.header.memberAccounts)
      && new Set(instance.header.memberAccounts).size === instance.header.memberAccounts.length
      && instance.header.memberAccounts.every((account) => IRI.test(account || '')),
    'valuation header member-account closure must be a unique logical-IRI set',
  );
  invariant(instance.header.memberAccounts.includes(snapshot.account), 'snapshot account is outside member closure');
  invariant(snapshot.instrument === instance.price.instrument, 'snapshot and price instruments differ');
  invariant(snapshot.quantity.unit === instance.price.denominatorUnit, 'snapshot unit differs from quotation denominator');
  if (snapshot.listingVersionIri || instance.price.listingVersionIri) {
    if (snapshot.listingVersionIri) validateExactRef(snapshot.listingVersionIri, 'snapshot.listingVersionIri');
    if (instance.price.listingVersionIri) validateExactRef(instance.price.listingVersionIri, 'price.listingVersionIri');
    invariant(
      snapshot.listingVersionIri === instance.price.listingVersionIri,
      'snapshot and price exact listings differ',
    );
  }
  const snapshotQuantity = quantity(snapshot.quantity, 'snapshot.quantity');
  const priceMoney = money(instance.price.money, 'price.money');
  validateExactRef(instance.versionIri, 'PositionValuation.versionIri');
  const policies = validateCalculationPolicies(instance.header, 'valuation', 'valuation header definition');
  validateStructuredScales(
    snapshot.quantity,
    snapshotQuantity,
    policies.precision.quantityScale,
    'snapshot.quantity',
    'precision',
  );
  validateStructuredScales(
    instance.price.money,
    priceMoney,
    policies.precision.amountScale,
    'price.money',
    'scale',
  );
  const rawValue = scaledIntegerToDecimal(
    directUnitValueRaw(
      decimalToScaledInteger(snapshotQuantity, policies.precision.quantityScale, 'snapshot.quantity'),
      decimalToScaledInteger(priceMoney, policies.precision.amountScale, 'price.money'),
      policies.precision,
      policies.rounding,
    ),
    policies.rounding.outputScale,
  );
  let expected = rawValue;
  if (instance.price.money.currency === instance.header.reportingCurrency) {
    invariant(!instance.fxConversion, 'same-currency valuation forbids FXConversion');
  } else {
    expected = validateFxConversion(
      instance.fxConversion,
      rawValue,
      instance.price.money.currency,
      instance.header.reportingCurrency,
      'position valuation',
      policies,
      {
        fxConversionVersionIri: instance.fxConversion?.versionIri,
        kind: 'valuationLine',
        policyKind: 'valuation',
        roundingPolicy: instance.header.roundingPolicy,
        versionIri: instance.versionIri,
      },
    );
  }
  invariant(instance.marketValue.currency === instance.header.reportingCurrency, 'market value currency differs from header');
  const marketValue = money(instance.marketValue, 'marketValue');
  validateStructuredScales(
    instance.marketValue,
    marketValue,
    policies.rounding.outputScale,
    'marketValue',
    'scale',
  );
  invariant(
    decimalEqual(marketValue, expected),
    `market value mismatch: expected ${decimalToString(expected)}`,
  );
}

function validateConsumptionSelection(
  policy,
  eligibleLots,
  consumptionAllocations,
  selectionClosure,
) {
  invariant(
    ['fifo', 'lifo', 'specificIdentification'].includes(policy),
    'invalid lot consumption policy',
  );
  invariant(Array.isArray(eligibleLots), 'eligible-lot closure is missing');
  invariant(
    Array.isArray(selectionClosure?.eligibleLotVersionIris),
    'eligible-lot exact-version set is missing',
  );
  invariant(
    selectionClosure.selectionProbePassed === true,
    'consumption selection closure probe must pass',
  );

  const eligibleByVersion = new Map();
  for (const lot of eligibleLots) {
    validateExactRef(lot.versionIri, 'eligibleLot.versionIri');
    invariant(!eligibleByVersion.has(lot.versionIri), 'duplicate eligible lot exact version');
    invariant(Number.isFinite(Date.parse(lot.openedAt)), 'eligible lot lacks a valid openedAt');
    invariant(
      decimalIsPositive(quantity(lot.remainingQuantity, 'eligibleLot.remainingQuantity')),
      'eligible lot remaining quantity must be strictly positive',
    );
    eligibleByVersion.set(lot.versionIri, lot);
  }
  invariant(
    sameSet(selectionClosure.eligibleLotVersionIris, [...eligibleByVersion.keys()]),
    'eligible-lot closure set is incomplete or contains duplicates',
  );

  const consumedByLot = new Map();
  for (const allocation of consumptionAllocations) {
    const eligibleLot = eligibleByVersion.get(allocation.lotVersionIri);
    invariant(eligibleLot, 'consumption allocation targets a lot outside the eligible closure');
    const allocated = quantity(allocation.quantity, 'consumption allocation.quantity');
    invariant(decimalIsPositive(allocated), 'consumption allocation quantity must be strictly positive');
    invariant(
      allocation.quantity.unit === eligibleLot.remainingQuantity.unit,
      'consumption allocation unit differs from eligible lot unit',
    );
    consumedByLot.set(
      allocation.lotVersionIri,
      decimalAdd(consumedByLot.get(allocation.lotVersionIri) || ZERO_DECIMAL, allocated),
    );
  }
  for (const [versionIri, consumed] of consumedByLot) {
    invariant(
      decimalCompare(consumed, quantity(
        eligibleByVersion.get(versionIri).remainingQuantity,
        'eligibleLot.remainingQuantity',
      )) <= 0,
      'consumption allocation exceeds eligible lot remaining quantity',
    );
  }

  if (policy === 'specificIdentification') {
    invariant(
      IRI.test(selectionClosure.specificSelectionRef || '')
        && SHA256.test(selectionClosure.specificSelectionDigest || ''),
      'specific-identification policy requires exact selection evidence',
    );
    const selected = selectionClosure.specificSelectionLotVersionIris;
    invariant(Array.isArray(selected), 'specific-identification selected-lot set is missing');
    invariant(
      sameSet(selected, [...consumedByLot.keys()]),
      'specific-identification allocation differs from the exact selected-lot set',
    );
    invariant(
      selected.every((versionIri) => eligibleByVersion.has(versionIri)),
      'specific-identification selected lot is outside the eligible closure',
    );
    return;
  }

  invariant(
    selectionClosure.specificSelectionRef === undefined
      && selectionClosure.specificSelectionDigest === undefined
      && selectionClosure.specificSelectionLotVersionIris === undefined,
    `${policy} policy forbids specific-identification evidence`,
  );
  const direction = policy === 'fifo' ? 1 : -1;
  const orderedLots = [...eligibleLots].sort((left, right) => {
    const timeOrder = Date.parse(left.openedAt) - Date.parse(right.openedAt);
    if (timeOrder !== 0) return direction * timeOrder;
    return direction * compareUtf8(left.versionIri, right.versionIri);
  });
  let unallocated = [...consumedByLot.values()].reduce(decimalAdd, ZERO_DECIMAL);
  const expectedByLot = new Map();
  for (const lot of orderedLots) {
    const remaining = quantity(lot.remainingQuantity, 'eligibleLot.remainingQuantity');
    const expected = decimalMin(unallocated, remaining);
    expectedByLot.set(lot.versionIri, expected);
    unallocated = decimalSubtract(unallocated, expected);
  }
  invariant(decimalIsZero(unallocated), 'consumption quantity exceeds the complete eligible-lot set');
  invariant(
    orderedLots.every((lot) => (
      decimalEqual(
        consumedByLot.get(lot.versionIri) || ZERO_DECIMAL,
        expectedByLot.get(lot.versionIri),
      )
    )),
    `${policy} consumption violates deterministic eligible-lot order`,
  );
}

function validateExecutionClosureEvidence(
  closure,
  allocations,
  fees,
  feeAllocations,
  eligibleLots,
  policy,
) {
  validateClosedIriSet(
    closure.allocationVersionIris,
    allocations.map((allocation) => allocation.versionIri),
    closure.allocationCount,
    closure.allocationVersionSetDigest,
    'allocation exact-version set',
  );
  validateClosedIriSet(
    closure.feeVersionIris,
    fees.map((fee) => fee.versionIri),
    closure.feeCount,
    closure.feeVersionSetDigest,
    'Fee exact-version set',
  );
  validateClosedIriSet(
    closure.feeAllocationVersionIris,
    feeAllocations.map((allocation) => allocation.versionIri),
    closure.feeAllocationCount,
    closure.feeAllocationVersionSetDigest,
    'fee-allocation exact-version set',
  );
  validateClosedIriSet(
    closure.eligibleLotVersionIris,
    eligibleLots.map((lot) => lot.versionIri),
    closure.eligibleLotCount,
    closure.eligibleLotVersionSetDigest,
    'eligible-lot exact-version set',
  );
  validateEvidencePair(
    closure.pitRequestRef,
    closure.pitRequestRecordDigest,
    'allocation closure PIT request',
  );
  validateEvidencePair(
    closure.inputContextRef,
    closure.inputContextRecordDigest,
    'allocation closure input context',
  );
  validateEvidencePair(
    closure.allocationClosureProbeRef,
    closure.allocationClosureProbeDigest,
    'allocation closure probe',
  );
  validateEvidencePair(
    closure.feeClosureProbeRef,
    closure.feeClosureProbeDigest,
    'Fee closure probe',
  );
  validateEvidencePair(
    closure.consumptionSelectionProbeRef,
    closure.consumptionSelectionProbeDigest,
    'consumption-selection closure probe',
  );
  invariant(
    IRI.test(closure.generatingContextRef || ''),
    'allocation closure generating context is missing or invalid',
  );
  if (policy === 'specificIdentification') {
    validateClosedIriSet(
      closure.specificSelectionLotVersionIris,
      closure.specificSelectionLotVersionIris,
      closure.specificSelectionCount,
      closure.specificSelectionVersionSetDigest,
      'specific-selection exact-version set',
    );
    validateEvidencePair(
      closure.specificSelectionRef,
      closure.specificSelectionDigest,
      'specific-selection evidence',
    );
  } else {
    for (const forbidden of [
      'specificSelectionCount',
      'specificSelectionVersionSetDigest',
    ]) {
      invariant(
        !Object.prototype.hasOwnProperty.call(closure, forbidden),
        `${policy} policy forbids ${forbidden}`,
      );
    }
  }
}

function validateExecutionLotClosure(instance) {
  const {
    execution,
    definition,
    lots,
    eligibleLots,
    allocations,
    fees,
    feeAllocations,
    closure,
  } = instance;
  validateExactRef(execution.versionIri, 'execution.versionIri');
  validateExactRef(definition.versionIri, 'definition.versionIri');
  invariant(definition.quotationContractVersionIri === execution.quotationContractVersionIri, 'cost definition quotation differs from Execution');
  invariant(/^[A-Z]{3}$/.test(definition.basisCurrency || ''), 'cost definition lacks exact basis Currency');
  invariant(definition.method === 'executionAllocatedDirectUnitCost', 'unsupported cost-basis method');
  invariant(['included', 'excluded'].includes(definition.feeTreatment), 'invalid fee treatment');
  invariant(definition.lotOpeningPolicy === 'openingRemainder', 'unsupported lot opening policy');
  invariant(
    ['fifo', 'lifo', 'specificIdentification'].includes(definition.lotConsumptionPolicy),
    'invalid lot consumption policy',
  );
  let policies;
  const getPolicies = () => {
    if (!policies) {
      policies = validateCalculationPolicies(definition, 'costBasis', 'cost-basis definition');
    }
    return policies;
  };

  const executionQty = quantity(execution.quantity, 'execution.quantity');
  invariant(decimalIsPositive(executionQty), 'closure Execution quantity must be strictly positive');
  const executionPrice = money(execution.price, 'execution.price');
  invariant(decimalIsNonNegative(executionPrice), 'closure Execution price cannot be negative');
  const allocationByVersion = new Map();
  for (const allocation of allocations) {
    validateExactRef(allocation.versionIri, 'allocation.versionIri');
    invariant(!allocationByVersion.has(allocation.versionIri), 'duplicate lot allocation exact version');
    invariant(['opening', 'consumption'].includes(allocation.kind), 'invalid lot allocation kind');
    invariant(
      decimalIsPositive(quantity(allocation.quantity, 'allocation.quantity')),
      'allocation quantity must be strictly positive',
    );
    invariant(
      allocation.quantity.unit === execution.quantity.unit,
      'allocation unit differs from Execution unit',
    );
    invariant(
      allocation.executionVersionIri === execution.versionIri,
      'lot allocation belongs to another Execution version',
    );
    validateExactRef(allocation.lotVersionIri, 'allocation.lotVersionIri');
    allocationByVersion.set(allocation.versionIri, allocation);
  }
  const feeByVersion = new Map();
  for (const fee of fees) {
    validateExactRef(fee.versionIri, 'fee.versionIri');
    validateExactRef(fee.executionVersionIri, 'Fee.executionVersionIri');
    invariant(
      fee.executionVersionIri === execution.versionIri,
      'Fee belongs to another Execution version',
    );
    invariant(!feeByVersion.has(fee.versionIri), 'duplicate Fee exact version');
    invariant(decimalIsPositive(money(fee.money, 'Fee')), 'Fee magnitude must be strictly positive');
    invariant(['charge', 'rebate'].includes(fee.effect), 'invalid Fee effect');
    feeByVersion.set(fee.versionIri, fee);
  }
  const feeAllocationVersions = new Set();
  const feeAllocationPairs = new Set();
  const feeAllocationBasisAmounts = new Map();
  for (const allocation of feeAllocations) {
    validateExactRef(allocation.versionIri, 'feeAllocation.versionIri');
    invariant(
      !feeAllocationVersions.has(allocation.versionIri),
      'duplicate fee allocation exact version',
    );
    feeAllocationVersions.add(allocation.versionIri);
    invariant(
      allocationByVersion.has(allocation.lotAllocationVersionIri),
      'fee allocation refers to unknown lot allocation',
    );
    const fee = feeByVersion.get(allocation.feeVersionIri);
    invariant(fee, 'fee allocation refers to unknown Fee');
    const allocatedAmount = money(allocation.money, 'fee allocation');
    invariant(decimalIsPositive(allocatedAmount), 'fee allocation magnitude must be strictly positive');
    invariant(
      allocation.money.currency === fee.money.currency,
      'fee allocation currency differs from Fee',
    );
    const pair = `${allocation.feeVersionIri}\u001f${allocation.lotAllocationVersionIri}`;
    invariant(!feeAllocationPairs.has(pair), 'duplicate Fee/allocation identity pair');
    feeAllocationPairs.add(pair);
    if (allocation.money.currency === definition.basisCurrency) {
      invariant(!allocation.fxConversion, 'same-currency Fee allocation forbids FXConversion');
      feeAllocationBasisAmounts.set(allocation.versionIri, allocatedAmount);
    } else {
      const calculationPolicies = getPolicies();
      feeAllocationBasisAmounts.set(
        allocation.versionIri,
        validateFxConversion(
          allocation.fxConversion,
          allocatedAmount,
          allocation.money.currency,
          definition.basisCurrency,
          'Fee allocation',
          calculationPolicies,
          {
            fxConversionVersionIri: allocation.fxConversion?.versionIri,
            kind: 'feeAllocation',
            policyKind: 'costBasis',
            roundingPolicy: definition.roundingPolicy,
            versionIri: allocation.versionIri,
          },
        ),
      );
    }
  }

  const allocationSum = allocations.reduce(
    (sum, allocation) => decimalAdd(sum, quantity(allocation.quantity, 'allocation.quantity')),
    ZERO_DECIMAL,
  );
  invariant(decimalEqual(allocationSum, executionQty), 'allocation quantities do not conserve Execution quantity');
  invariant(
    sameSet(closure.allocationVersionIris, allocations.map((allocation) => allocation.versionIri)),
    'allocation closure set is incomplete or contains duplicates',
  );
  invariant(
    sameSet(closure.feeVersionIris, fees.map((fee) => fee.versionIri)),
    'Fee closure set is incomplete or contains duplicates',
  );
  invariant(
    sameSet(
      closure.feeAllocationVersionIris,
      feeAllocations.map((allocation) => allocation.versionIri),
    ),
    'fee-allocation closure set is incomplete or contains duplicates',
  );
  invariant(closure.allocationProbePassed === true && closure.feeProbePassed === true, 'closure probes must pass');
  validateConsumptionSelection(
    definition.lotConsumptionPolicy,
    eligibleLots,
    allocations.filter((allocation) => allocation.kind === 'consumption'),
    closure,
  );

  if (definition.feeTreatment === 'included') {
    for (const fee of fees) {
      const allocationsForFee = feeAllocations.filter(
        (candidate) => candidate.feeVersionIri === fee.versionIri,
      );
      invariant(allocationsForFee.length > 0, 'included Fee has no allocation');
      const allocated = allocationsForFee.reduce(
        (sum, candidate) => decimalAdd(sum, money(candidate.money, 'fee allocation')),
        ZERO_DECIMAL,
      );
      invariant(
        decimalEqual(allocated, money(fee.money, 'Fee')),
        'included Fee allocations do not exactly conserve Fee magnitude/currency',
      );
    }
  } else {
    invariant(feeAllocations.length === 0, 'excluded Fee treatment forbids fee allocations');
  }

  const calculationPolicies = getPolicies();
  validateStructuredScales(
    execution.quantity,
    executionQty,
    calculationPolicies.precision.quantityScale,
    'execution.quantity',
    'precision',
  );
  validateStructuredScales(
    execution.price,
    executionPrice,
    calculationPolicies.precision.amountScale,
    'execution.price',
    'scale',
  );
  for (const allocation of allocations) {
    validateStructuredScales(
      allocation.quantity,
      quantity(allocation.quantity, 'allocation.quantity'),
      calculationPolicies.precision.quantityScale,
      'allocation.quantity',
      'precision',
    );
  }
  for (const fee of fees) {
    validateStructuredScales(
      fee.money,
      money(fee.money, 'Fee'),
      calculationPolicies.precision.amountScale,
      'Fee',
      'scale',
    );
  }
  for (const allocation of feeAllocations) {
    validateStructuredScales(
      allocation.money,
      money(allocation.money, 'fee allocation'),
      calculationPolicies.precision.amountScale,
      'fee allocation',
      'scale',
    );
  }

  const lotVersions = new Set();
  for (const lot of lots) {
    validateExactRef(lot.versionIri, 'lot.versionIri');
    invariant(!lotVersions.has(lot.versionIri), 'duplicate opening PositionLot exact version');
    lotVersions.add(lot.versionIri);
    invariant(lot.discriminator === 'openingRemainder', 'invalid lot discriminator');
    invariant(!Object.prototype.hasOwnProperty.call(lot, 'cost'), 'ambiguous lot cost is forbidden');
    const openings = allocations.filter(
      (allocation) => allocation.lotVersionIri === lot.versionIri && allocation.kind === 'opening',
    );
    invariant(openings.length === 1, 'each lot requires exactly one opening allocation');
    const original = quantity(lot.originalQuantity, 'lot.originalQuantity');
    invariant(!decimalIsZero(original), 'lot original quantity must be non-zero');
    validateStructuredScales(
      lot.originalQuantity,
      original,
      calculationPolicies.precision.quantityScale,
      'lot.originalQuantity',
      'precision',
    );
    const openingQuantity = quantity(openings[0].quantity, 'opening quantity');
    invariant(
      decimalEqual(openingQuantity, decimalAbs(original)),
      'opening allocation differs from absolute original quantity',
    );
    invariant(openings[0].executionVersionIri === lot.openingExecutionVersionIri, 'opening Execution mismatch');

    const rawGross = scaledIntegerToDecimal(
      costBasisDirectUnitValueRaw(
        decimalToScaledInteger(
          openingQuantity,
          calculationPolicies.precision.quantityScale,
          'opening quantity',
        ),
        decimalToScaledInteger(
          executionPrice,
          calculationPolicies.precision.amountScale,
          'execution.price',
        ),
        calculationPolicies.precision,
        calculationPolicies.rounding,
      ),
      calculationPolicies.rounding.outputScale,
    );
    let gross = rawGross;
    if (execution.price.currency === definition.basisCurrency) {
      invariant(
        !lot.openingGrossFxConversion,
        'same-currency opening gross forbids FXConversion',
      );
    } else {
      gross = validateFxConversion(
        lot.openingGrossFxConversion,
        rawGross,
        execution.price.currency,
        definition.basisCurrency,
        'opening gross',
        calculationPolicies,
        {
          fxConversionVersionIri: lot.openingGrossFxConversion?.versionIri,
          kind: 'openingLot',
          policyKind: 'costBasis',
          roundingPolicy: definition.roundingPolicy,
          versionIri: lot.versionIri,
        },
      );
    }
    invariant(
      lot.openingGross.currency === definition.basisCurrency
        && lot.openingCostBasis.currency === definition.basisCurrency,
      'lot gross and cost basis must use the definition basis Currency',
    );
    const openingGross = money(lot.openingGross, 'lot.openingGross');
    validateStructuredScales(
      lot.openingGross,
      openingGross,
      calculationPolicies.rounding.outputScale,
      'lot.openingGross',
      'scale',
    );
    invariant(decimalEqual(openingGross, gross), 'opening gross mismatch');
    let charges = ZERO_DECIMAL;
    let rebates = ZERO_DECIMAL;
    if (definition.feeTreatment === 'included') {
      for (const allocation of feeAllocations.filter(
        (candidate) => candidate.lotAllocationVersionIri === openings[0].versionIri,
      )) {
        const fee = feeByVersion.get(allocation.feeVersionIri);
        if (fee.effect === 'charge') {
          charges = decimalAdd(charges, feeAllocationBasisAmounts.get(allocation.versionIri));
        } else {
          rebates = decimalAdd(rebates, feeAllocationBasisAmounts.get(allocation.versionIri));
        }
      }
    }
    const expectedBasis = decimalIsPositive(original)
      ? decimalSubtract(decimalAdd(gross, charges), rebates)
      : decimalNegate(decimalAdd(decimalSubtract(gross, charges), rebates));
    const openingCostBasis = money(lot.openingCostBasis, 'lot.openingCostBasis');
    validateStructuredScales(
      lot.openingCostBasis,
      openingCostBasis,
      calculationPolicies.rounding.outputScale,
      'lot.openingCostBasis',
      'scale',
    );
    invariant(
      decimalEqual(openingCostBasis, expectedBasis),
      `opening cost basis mismatch: expected ${decimalToString(expectedBasis)}`,
    );
  }
  for (const allocation of allocations.filter((candidate) => candidate.kind === 'opening')) {
    invariant(
      lotVersions.has(allocation.lotVersionIri),
      'opening allocation targets an unknown PositionLot version',
    );
  }
  validateExecutionClosureEvidence(
    closure,
    allocations,
    fees,
    feeAllocations,
    eligibleLots,
    definition.lotConsumptionPolicy,
  );
}

function validatePositionLotStateEvidence(
  lots,
  consumptionAllocations,
  selectionClosures,
  closure,
  pnl,
) {
  const openingAllocationVersionIris = lots.map((lot) => {
    validateExactRef(lot.openingAllocationVersionIri, 'lot.openingAllocationVersionIri');
    return lot.openingAllocationVersionIri;
  });
  const executionClosureVersionIris = selectionClosures.map((selectionClosure) => {
    validateExactRef(selectionClosure.versionIri, 'selectionClosure.versionIri');
    validateClosedIriSet(
      selectionClosure.eligibleLotVersionIris,
      selectionClosure.eligibleLots.map((lot) => lot.versionIri),
      selectionClosure.eligibleLotCount,
      selectionClosure.eligibleLotVersionSetDigest,
      'state selection eligible-lot exact-version set',
    );
    validateEvidencePair(
      selectionClosure.consumptionSelectionProbeRef,
      selectionClosure.consumptionSelectionProbeDigest,
      'state consumption-selection probe',
    );
    return selectionClosure.versionIri;
  });
  validateIriSetDigest(
    closure.openLotVersionIris,
    closure.openLotVersionIris,
    closure.openLotVersionSetDigest,
    'open-lot exact-version set',
  );
  validateIriSetDigest(
    closure.stateAllocationVersionIris,
    [
      ...openingAllocationVersionIris,
      ...consumptionAllocations.map((allocation) => allocation.versionIri),
    ],
    closure.stateAllocationVersionSetDigest,
    'state-allocation exact-version set',
  );
  validateIriSetDigest(
    closure.stateExecutionClosureVersionIris,
    executionClosureVersionIris,
    closure.stateExecutionClosureVersionSetDigest,
    'state execution-closure exact-version set',
  );
  validateEvidencePair(
    closure.pitRequestRef,
    closure.pitRequestRecordDigest,
    'lot-state PIT request',
  );
  validateEvidencePair(
    closure.inputContextRef,
    closure.inputContextRecordDigest,
    'lot-state input context',
  );
  validateEvidencePair(
    closure.lotClosureProbeRef,
    closure.lotClosureProbeDigest,
    'open-lot closure probe',
  );
  validateEvidencePair(
    closure.stateAllocationClosureProbeRef,
    closure.stateAllocationClosureProbeDigest,
    'state-allocation closure probe',
  );
  invariant(IRI.test(closure.snapshotPivotRef || ''), 'lot-state snapshot pivot is missing or invalid');
  invariant(IRI.test(closure.calculationContextRef || ''), 'lot-state calculation context is missing or invalid');
  invariant(IRI.test(closure.generatingContextRef || ''), 'lot-state generating context is missing or invalid');
  if (pnl) {
    invariant(
      pnl.openLotVersionSetDigest === closure.openLotVersionSetDigest
        && pnl.stateAllocationVersionSetDigest === closure.stateAllocationVersionSetDigest
        && pnl.stateExecutionClosureVersionSetDigest
          === closure.stateExecutionClosureVersionSetDigest,
      'PnL does not reuse the exact lot-state closure digests',
    );
  }
}

function validatePositionLotState(instance) {
  const {
    definition,
    lots,
    consumptionAllocations,
    selectionClosures,
    snapshot,
    closure,
    pnl,
  } = instance;
  invariant(
    ['fifo', 'lifo', 'specificIdentification'].includes(definition?.lotConsumptionPolicy),
    'lot-state closure lacks a reviewed lot consumption policy',
  );
  const allocationByVersion = new Map();
  for (const allocation of consumptionAllocations) {
    validateExactRef(allocation.versionIri, 'consumption.versionIri');
    invariant(!allocationByVersion.has(allocation.versionIri), 'duplicate consumption allocation');
    allocationByVersion.set(allocation.versionIri, allocation);
  }
  const openLots = [];
  const lotStates = [];
  const lotByVersion = new Map();
  const basisCurrency = closure?.remainingCostBasis?.currency;
  for (const lot of lots) {
    validateExactRef(lot.versionIri, 'state lot.versionIri');
    invariant(!lotByVersion.has(lot.versionIri), 'duplicate lot in PositionLotStateClosure input');
    lotByVersion.set(lot.versionIri, lot);
    const original = quantity(lot.originalQuantity, 'lot.originalQuantity');
    invariant(!decimalIsZero(original), 'state lot original quantity must be non-zero');
    invariant(
      lot.openingCostBasis?.currency === basisCurrency,
      'open-lot basis currency differs from the closure basis currency',
    );
    const consumed = consumptionAllocations
      .filter((allocation) => allocation.lotVersionIri === lot.versionIri)
      .reduce(
        (sum, allocation) => decimalAdd(sum, quantity(allocation.quantity, 'consumption.quantity')),
        ZERO_DECIMAL,
      );
    for (const allocation of consumptionAllocations.filter(
      (candidate) => candidate.lotVersionIri === lot.versionIri,
    )) {
      invariant(
        allocation.executionSide === (decimalIsPositive(original) ? 'Sell' : 'Buy'),
        'consumption Execution side is not opposite the lot sign',
      );
      invariant(
        allocation.account === lot.account && allocation.instrument === lot.instrument,
        'consumption account/instrument differs from lot',
      );
      invariant(
        allocation.quantity.unit === lot.originalQuantity.unit,
        'consumption Quantity unit differs from lot original Quantity unit',
      );
    }
    invariant(decimalCompare(consumed, decimalAbs(original)) <= 0, 'lot is over-consumed');
    const remainingMagnitude = decimalSubtract(decimalAbs(original), consumed);
    const remaining = decimalIsPositive(original) ? remainingMagnitude : decimalNegate(remainingMagnitude);
    if (!decimalIsZero(remaining)) {
      openLots.push(lot.versionIri);
    }
    lotStates.push({ lot, original, remaining });
  }
  for (const allocation of consumptionAllocations) {
    invariant(
      lotByVersion.has(allocation.lotVersionIri),
      'consumption allocation targets an unknown PositionLot version',
    );
  }
  invariant(Array.isArray(selectionClosures), 'lot-state selection closures are missing');
  const coveredAllocations = [];
  for (const selectionClosure of selectionClosures) {
    invariant(
      Array.isArray(selectionClosure.consumptionAllocationVersionIris),
      'selection closure allocation set is missing',
    );
    const selectedAllocations = selectionClosure.consumptionAllocationVersionIris.map(
      (versionIri) => {
        const allocation = allocationByVersion.get(versionIri);
        invariant(allocation, 'selection closure refers to unknown consumption allocation');
        return allocation;
      },
    );
    coveredAllocations.push(...selectionClosure.consumptionAllocationVersionIris);
    validateConsumptionSelection(
      definition.lotConsumptionPolicy,
      selectionClosure.eligibleLots,
      selectedAllocations,
      selectionClosure,
    );
  }
  invariant(
    sameSet(coveredAllocations, [...allocationByVersion.keys()]),
    'execution selection closures omit or duplicate a consumption allocation',
  );
  invariant(
    sameSet(closure.openLotVersionIris, openLots),
    'open-lot closure omits or includes an ineligible lot',
  );
  invariant(closure.lotProbePassed === true && closure.allocationProbePassed === true, 'lot-state probes must pass');
  validateExactRef(snapshot.versionIri, 'PositionSnapshot.versionIri');
  if (pnl) {
    invariant(pnl.currency === closure.remainingCostBasis.currency, 'PnL currency differs from remaining basis');
    invariant(
      pnl.marketValue?.currency === pnl.currency
        && pnl.remainingCostBasis?.currency === pnl.currency
        && pnl.unrealizedPnl?.currency === pnl.currency,
      'PnL Money components do not share the declared reporting currency',
    );
  }

  validateExactRef(definition.versionIri, 'lot-state definition.versionIri');
  const policies = validateCalculationPolicies(definition, 'costBasis', 'lot-state cost-basis definition');
  let quantitySum = ZERO_DECIMAL;
  let basisSum = ZERO_DECIMAL;
  for (const { lot, original, remaining } of lotStates) {
    validateStructuredScales(
      lot.originalQuantity,
      original,
      policies.precision.quantityScale,
      'lot.originalQuantity',
      'precision',
    );
    const openingBasis = money(lot.openingCostBasis, 'openingCostBasis');
    validateStructuredScales(
      lot.openingCostBasis,
      openingBasis,
      policies.precision.amountScale,
      'openingCostBasis',
      'scale',
    );
    if (!decimalIsZero(remaining)) {
      quantitySum = decimalAdd(quantitySum, remaining);
      basisSum = decimalAdd(
        basisSum,
        scaledIntegerToDecimal(
          remainingBasisRaw(
            decimalToScaledInteger(openingBasis, policies.precision.amountScale, 'openingCostBasis'),
            decimalToScaledInteger(original, policies.precision.quantityScale, 'lot.originalQuantity'),
            decimalToScaledInteger(remaining, policies.precision.quantityScale, 'remaining quantity'),
            policies.precision,
            policies.rounding,
          ),
          policies.rounding.outputScale,
        ),
      );
    }
  }
  for (const allocation of consumptionAllocations) {
    const value = quantity(allocation.quantity, 'consumption.quantity');
    validateStructuredScales(
      allocation.quantity,
      value,
      policies.precision.quantityScale,
      'consumption.quantity',
      'precision',
    );
  }
  const snapshotQuantity = quantity(snapshot.quantity, 'snapshot.quantity');
  validateStructuredScales(
    snapshot.quantity,
    snapshotQuantity,
    policies.precision.quantityScale,
    'snapshot.quantity',
    'precision',
  );
  invariant(decimalEqual(snapshotQuantity, quantitySum), 'PositionSnapshot quantity does not conserve open lots');
  const remainingCostBasis = money(closure.remainingCostBasis, 'remainingCostBasis');
  validateStructuredScales(
    closure.remainingCostBasis,
    remainingCostBasis,
    policies.rounding.outputScale,
    'remainingCostBasis',
    'scale',
  );
  invariant(decimalEqual(remainingCostBasis, basisSum), 'remaining cost basis does not conserve open lots');
  if (pnl) {
    const market = money(pnl.marketValue, 'pnl.marketValue');
    const basis = money(pnl.remainingCostBasis, 'pnl.remainingCostBasis');
    const unrealized = money(pnl.unrealizedPnl, 'pnl.unrealizedPnl');
    for (const [field, structured, value] of [
      ['pnl.marketValue', pnl.marketValue, market],
      ['pnl.remainingCostBasis', pnl.remainingCostBasis, basis],
      ['pnl.unrealizedPnl', pnl.unrealizedPnl, unrealized],
    ]) {
      validateStructuredScales(
        structured,
        value,
        policies.rounding.outputScale,
        field,
        'scale',
      );
    }
    invariant(decimalEqual(basis, basisSum), 'PnL copies a different remaining basis');
    invariant(
      decimalEqual(unrealized, decimalSubtract(market, basis)),
      'unrealized PnL equation mismatch',
    );
  }
  validatePositionLotStateEvidence(
    lots,
    consumptionAllocations,
    selectionClosures,
    closure,
    pnl,
  );
}

function validateCalculationDefinitionIdentity(instance) {
  invariant(Array.isArray(instance.definitions), 'calculation definitions are missing');
  const logicalByScopedKey = new Map();
  const scopedKeyByLogical = new Map();
  const versionOwner = new Map();
  const definitionsByLogical = new Map();
  for (const definition of instance.definitions) {
    invariant(
      ['valuation', 'costBasis'].includes(definition.kind),
      'invalid calculation-definition kind',
    );
    invariant(IRI.test(definition.authority || ''), 'calculation definition lacks logical authority');
    invariant(
      typeof definition.definitionId === 'string' && definition.definitionId.length > 0,
      'calculation definition lacks stable identifier',
    );
    invariant(IRI.test(definition.logicalIri || ''), 'calculation definition lacks logical IRI');
    validateExactRef(definition.versionIri, 'calculationDefinition.versionIri');
    invariant(
      Number.isSafeInteger(definition.revision) && definition.revision >= 0,
      'calculation definition has invalid revision',
    );
    const scopedKey = [
      definition.kind,
      definition.authority,
      definition.definitionId,
    ].join('\u001f');
    invariant(
      !logicalByScopedKey.has(scopedKey)
        || logicalByScopedKey.get(scopedKey) === definition.logicalIri,
      'two calculation-definition logical IRIs share one authority-scoped key',
    );
    invariant(
      !scopedKeyByLogical.has(definition.logicalIri)
        || scopedKeyByLogical.get(definition.logicalIri) === scopedKey,
      'one calculation-definition logical IRI maps to multiple authority-scoped keys',
    );
    logicalByScopedKey.set(scopedKey, definition.logicalIri);
    scopedKeyByLogical.set(definition.logicalIri, scopedKey);
    invariant(
      !versionOwner.has(definition.versionIri)
        || versionOwner.get(definition.versionIri) === definition.logicalIri,
      'calculation-definition version IRI is reused by another logical identity',
    );
    versionOwner.set(definition.versionIri, definition.logicalIri);
    const versions = definitionsByLogical.get(definition.logicalIri) || [];
    versions.push(definition);
    definitionsByLogical.set(definition.logicalIri, versions);
  }
  for (const versions of definitionsByLogical.values()) {
    versions.sort((left, right) => left.revision - right.revision);
    invariant(versions[0].revision === 0, 'calculation-definition revision chain must begin at 0');
    for (let index = 1; index < versions.length; index += 1) {
      invariant(
        versions[index].revision === versions[index - 1].revision + 1,
        'calculation-definition revision chain has a gap or branch',
      );
    }
  }
}

function validateOrderIntentLineage(instance) {
  invariant(instance && typeof instance === 'object', 'order-intent lineage instance is missing');
  invariant(Array.isArray(instance.intents) && instance.intents.length > 0, 'order-intent lineage endpoint inventory is missing');
  invariant(Array.isArray(instance.lineages) && instance.lineages.length > 0, 'order-intent lineage graph is missing');
  validateExactRef(instance.focusVersionIri, 'order-intent lineage focusVersionIri');
  const intents = new Map();
  for (const intent of instance.intents) {
    validateExactRef(intent.versionIri, 'order-intent lineage endpoint versionIri');
    invariant(intent.type === 'OrderIntent', 'order-intent lineage endpoint has the wrong type');
    invariant(!intents.has(intent.versionIri), 'order-intent lineage endpoint inventory contains a duplicate version');
    invariant(IRI.test(intent.instrument || ''), 'order-intent lineage endpoint lacks a logical instrument');
    invariant(['Buy', 'Sell'].includes(intent.side), 'order-intent lineage endpoint has an invalid side');
    const q = quantity(intent.quantity, 'order-intent lineage endpoint quantity');
    invariant(decimalIsPositive(q), 'order-intent lineage endpoint quantity must be positive');
    const parsedTemporal = {};
    for (const axis of ['validFrom', 'knowledgeFrom', 'availableFrom']) {
      instant(intent[axis], `order-intent lineage endpoint ${axis}`);
      parsedTemporal[axis] = instantNanoseconds(intent[axis]);
      invariant(parsedTemporal[axis] !== null, `order-intent lineage endpoint ${axis} is not an exact instant`);
    }
    intents.set(intent.versionIri, { ...intent, parsedQuantity: q, parsedTemporal });
  }

  const adjacency = new Map();
  const directedPairs = new Set();
  const lineageKeys = new Set();
  const lineageVersions = new Set();
  let focusCount = 0;
  for (const lineage of instance.lineages) {
    validateExactRef(lineage.versionIri, 'order-intent lineage versionIri');
    invariant(!lineageVersions.has(lineage.versionIri), 'order-intent lineage inventory contains a duplicate version');
    lineageVersions.add(lineage.versionIri);
    if (lineage.versionIri === instance.focusVersionIri) focusCount += 1;
    invariant(['split', 'aggregation'].includes(lineage.kind), 'order-intent lineage kind is invalid');
    invariant(
      !['reservation', 'reservationId', 'accountBlock'].some((field) => Object.hasOwn(lineage, field)),
      'runtime reservation state is forbidden in M2 order lineage',
    );
    for (const [field, label] of [
      ['sourceIntentVersionIris', 'source intent exact-version set'],
      ['resultIntentVersionIris', 'result intent exact-version set'],
    ]) {
      const values = lineage[field];
      invariant(Array.isArray(values) && values.length > 0, `${label} is missing`);
      invariant(new Set(values).size === values.length, `${label} contains a duplicate IRI`);
      values.forEach((versionIri) => validateExactRef(versionIri, label));
      invariant(
        values.every((value, index) => index === 0 || compareUtf8(values[index - 1], value) < 0),
        `${label} must be UTF-8 sorted`,
      );
    }
    const sourceDigest = iriSetDigest(lineage.sourceIntentVersionIris);
    const resultDigest = iriSetDigest(lineage.resultIntentVersionIris);
    invariant(lineage.sourceIntentCount === lineage.sourceIntentVersionIris.length, 'source intent count does not match the exact set');
    invariant(lineage.resultIntentCount === lineage.resultIntentVersionIris.length, 'result intent count does not match the exact set');
    invariant(lineage.sourceIntentVersionSetDigest === sourceDigest, 'source intent exact-version set digest does not match RFC section 5.8');
    invariant(lineage.resultIntentVersionSetDigest === resultDigest, 'result intent exact-version set digest does not match RFC section 5.8');
    invariant(
      (lineage.kind === 'split'
        && lineage.sourceIntentCount === 1
        && lineage.resultIntentCount >= 2)
        || (lineage.kind === 'aggregation'
          && lineage.sourceIntentCount >= 2
          && lineage.resultIntentCount === 1),
      'order-intent lineage branch cardinality is invalid',
    );
    invariant(
      lineage.orderLineageKeyDigest === sha256DomainJcs(
        'axiolune-order-intent-lineage-key-v1',
        {
          kind: lineage.kind,
          resultIntentVersionSetDigest: resultDigest,
          sourceIntentVersionSetDigest: sourceDigest,
        },
      ),
      'order-intent lineage key digest does not bind the exact transformation',
    );
    invariant(!lineageKeys.has(lineage.orderLineageKeyDigest), 'order-intent lineage graph contains a duplicate transformation key');
    lineageKeys.add(lineage.orderLineageKeyDigest);
    validateEvidencePair(lineage.sourceArtifactRef, lineage.sourceArtifactDigest, 'order-intent lineage source evidence');
    validateFixtureSourceLocator(lineage.sourceLocator, 'order-intent lineage source locator');
    const parsedTemporal = {};
    for (const axis of ['validFrom', 'knowledgeFrom', 'availableFrom']) {
      instant(lineage[axis], `order-intent lineage ${axis}`);
      parsedTemporal[axis] = instantNanoseconds(lineage[axis]);
      invariant(parsedTemporal[axis] !== null, `order-intent lineage ${axis} is not an exact instant`);
    }
    const endpoints = [...lineage.sourceIntentVersionIris, ...lineage.resultIntentVersionIris];
    invariant(new Set(endpoints).size === endpoints.length, 'order-intent lineage contains a self endpoint');
    const resolved = endpoints.map((versionIri) => {
      const intent = intents.get(versionIri);
      invariant(intent, `order-intent lineage endpoint is orphaned: ${versionIri}`);
      invariant(
        intent.parsedTemporal.knowledgeFrom <= parsedTemporal.knowledgeFrom
          && intent.parsedTemporal.availableFrom <= parsedTemporal.availableFrom,
        'order-intent lineage endpoint is not PIT-eligible for the lineage fact',
      );
      return intent;
    });
    const first = resolved[0];
    invariant(
      resolved.every((intent) => intent.instrument === first.instrument
        && intent.side === first.side
        && intent.quantity.unit === first.quantity.unit),
      'order-intent lineage endpoints disagree on instrument, side, or Quantity unit',
    );
    const sourceQuantity = lineage.sourceIntentVersionIris
      .map((versionIri) => intents.get(versionIri).parsedQuantity)
      .reduce(decimalAdd, ZERO_DECIMAL);
    const resultQuantity = lineage.resultIntentVersionIris
      .map((versionIri) => intents.get(versionIri).parsedQuantity)
      .reduce(decimalAdd, ZERO_DECIMAL);
    invariant(decimalEqual(sourceQuantity, resultQuantity), 'order-intent lineage does not conserve exact Quantity');
    for (const sourceVersionIri of lineage.sourceIntentVersionIris) {
      const targets = adjacency.get(sourceVersionIri) || new Set();
      for (const resultVersionIri of lineage.resultIntentVersionIris) {
        const pair = `${sourceVersionIri}\0${resultVersionIri}`;
        invariant(!directedPairs.has(pair), 'order-intent lineage graph contains a duplicate directed edge');
        directedPairs.add(pair);
        targets.add(resultVersionIri);
      }
      adjacency.set(sourceVersionIri, targets);
    }
  }
  invariant(focusCount === 1, 'order-intent lineage focus must resolve exactly once');
  const visiting = new Set();
  const visited = new Set();
  const visit = (versionIri) => {
    invariant(!visiting.has(versionIri), 'order-intent lineage graph contains a directed cycle');
    if (visited.has(versionIri)) return;
    visiting.add(versionIri);
    for (const next of adjacency.get(versionIri) || []) visit(next);
    visiting.delete(versionIri);
    visited.add(versionIri);
  };
  for (const versionIri of adjacency.keys()) visit(versionIri);
}

function validateFixture(fixture) {
  switch (fixture.contract) {
    case 'LiquidityRoleDetermination':
      validateLiquidityDetermination(fixture.instance);
      break;
    case 'OrderStreamIntegrity':
      validateOrderStreamIntegrity(fixture.instance);
      break;
    case 'ExecutionContract':
      validateExecutionContract(fixture.instance);
      break;
    case 'OrderIntentContract':
      validateOrderIntentContract(fixture.instance);
      break;
    case 'OrderIntentLineageContract':
      validateOrderIntentLineage(fixture.instance);
      break;
    case 'ExternalOrderStatusMapping':
      validateExternalStatusMapping(fixture.instance);
      break;
    case 'FeeContract':
      validateFeeContract(fixture.instance);
      break;
    case 'SnapshotContract':
      validateSnapshotContract(fixture.instance);
      break;
    case 'PositionValuation':
      validatePositionValuation(fixture.instance);
      break;
    case 'ExecutionLotAllocationClosure':
      validateExecutionLotClosure(fixture.instance);
      break;
    case 'PositionLotIdentity':
      validatePositionLotIdentity(fixture.instance);
      break;
    case 'PositionLotStateClosure':
      validatePositionLotState(fixture.instance);
      break;
    case 'CalculationDefinitionIdentity':
      validateCalculationDefinitionIdentity(fixture.instance);
      break;
    default:
      throw new Error(`unknown fixture contract ${fixture.contract}`);
  }
}

function runFixtures() {
  for (const file of FIXTURE_FILES) {
    invariant(fs.existsSync(file), `missing fixture file ${path.relative(ROOT, file)}`);
    const document = loadYaml(file);
    invariant(Array.isArray(document.fixtures), `${file} lacks fixtures`);
    for (const fixture of document.fixtures) {
      let caught;
      try {
        validateFixture(fixture);
      } catch (error) {
        caught = error;
      }
      if (fixture.expectedResult === 'accepted' && !caught) {
        pass(fixture.id);
      } else if (
        fixture.expectedResult === 'rejected'
          && caught
          && (
            fixture.expectedReason === undefined
              || caught.message === fixture.expectedReason
          )
      ) {
        pass(`${fixture.id}-REJECTED`, caught.message);
      } else if (fixture.expectedResult === 'rejected' && caught) {
        fail(
          fixture.id,
          `wrong rejection reason: expected ${fixture.expectedReason}, got ${caught.message}`,
        );
      } else if (fixture.expectedResult === 'accepted') {
        fail(fixture.id, `unexpected rejection: ${caught.message}`);
      } else {
        fail(fixture.id, 'unexpected acceptance');
      }
    }
  }
}

function fileDigest(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function requirePathInside(candidate, directory, field) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(resolvedDirectory, resolvedCandidate);
  invariant(
    relative !== ''
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative),
    `${field} escapes its isolated output directory`,
  );
  invariant(fs.statSync(resolvedCandidate).isFile(), `${field} does not resolve to a regular file`);
  return resolvedCandidate;
}

function expectedShaclFixtures(profile) {
  const expected = new Map();
  for (const relativeFile of profile.fixtureFiles) {
    const absoluteFile = path.join(ROOT, relativeFile);
    const document = loadYaml(absoluteFile);
    invariant(Array.isArray(document.fixtures), `${relativeFile} lacks fixtures`);
    for (const fixture of document.fixtures) {
      invariant(!expected.has(fixture.id), `${profile.module} has duplicate SHACL fixture ${fixture.id}`);
      invariant(
        fixture.expectedResult === 'accepted' || fixture.expectedResult === 'rejected',
        `${fixture.id} has an invalid expectedResult`,
      );
      expected.set(fixture.id, { fixture, relativeFile, absoluteFile });
    }
  }
  return expected;
}

function auditFreshShaclEvidence(evidence, profile, outputDirectory) {
  invariant(evidence && typeof evidence === 'object', `${profile.module} emitted no SHACL evidence`);
  invariant(evidence.failCount === 0, `${profile.module} SHACL evidence reports failures`);
  invariant(evidence.engine?.id === 'pyshacl', `${profile.module} did not execute pySHACL`);
  invariant(
    typeof evidence.engine.version === 'string' && /^\d+\.\d+\.\d+$/.test(evidence.engine.version),
    `${profile.module} lacks an exact pySHACL version`,
  );
  invariant(SHA256.test(evidence.engine.pythonExecutableDigest || ''), 'python executable is not digest-bound');
  invariant(SHA256.test(evidence.engine.packageEntryDigest || ''), 'pySHACL package is not digest-bound');
  invariant(evidence.engine.rdfEngine === 'rdflib', 'domain SHACL RDF engine is not RDFLib');
  invariant(
    evidence.engine.rdfEngineVersion === '7.6.0',
    'domain SHACL RDFLib version is not pinned to 7.6.0',
  );
  invariant(
    SHA256.test(evidence.engine.rdfPackageEntryDigest || ''),
    'RDFLib package is not digest-bound',
  );
  invariant(
    evidence.engine.permissionAssurance?.network === 'denied-in-process'
      && evidence.engine.permissionAssurance?.socketConstructorProbe === 'denied'
      && evidence.engine.permissionAssurance?.urlopenProbe === 'denied',
    'domain SHACL no-network boundary is not self-attested',
  );
  invariant(
    typeof evidence.engine.workerRef === 'string'
      && !path.isAbsolute(evidence.engine.workerRef)
      && SHA256.test(evidence.engine.workerDigest || ''),
    'domain SHACL worker is not repository/digest-bound',
  );
  invariant(
    fileDigest(requirePathInside(
      path.join(ROOT, evidence.engine.workerRef),
      ROOT,
      'workerRef',
    )) === evidence.engine.workerDigest,
    'domain SHACL worker digest drift',
  );
  for (const [referenceField, digestField] of [
    ['requirementsRef', 'requirementsDigest'],
    ['enginePinRef', 'enginePinDigest'],
  ]) {
    const reference = evidence.engine[referenceField];
    invariant(typeof reference === 'string' && !path.isAbsolute(reference), `${referenceField} is not a repository path`);
    const absolute = requirePathInside(path.join(ROOT, reference), ROOT, referenceField);
    invariant(fileDigest(absolute) === evidence.engine[digestField], `${digestField} drift`);
  }
  invariant(
    canonicalJcs(evidence.engine.arguments)
      === canonicalJcs(['-I', '{worker}', '-f', 'nt', '-s', '{shapes}', '{data}']),
    `${profile.module} pySHACL arguments drift`,
  );

  const expected = expectedShaclFixtures(profile);
  invariant(
    Array.isArray(evidence.results) && evidence.results.length === expected.size,
    `${profile.module} SHACL fixture inventory is incomplete`,
  );
  const seen = new Set();
  let accepted = 0;
  let rejected = 0;
  for (const result of evidence.results) {
    invariant(!seen.has(result.id), `${profile.module} SHACL evidence duplicates ${result.id}`);
    seen.add(result.id);
    const expectation = expected.get(result.id);
    invariant(expectation, `${profile.module} SHACL evidence contains unknown ${result.id}`);
    const expectsConformance = expectation.fixture.expectedResult === 'accepted';
    if (expectsConformance) accepted += 1;
    else rejected += 1;
    invariant(result.module === profile.module, `${result.id} is bound to the wrong module`);
    invariant(result.status === 'PASS', `${result.id} is not a passing execution`);
    invariant(result.conforms === expectsConformance, `${result.id} conformance polarity drift`);
    invariant(result.exit === (expectsConformance ? 0 : 1), `${result.id} pySHACL exit drift`);
    invariant(
      expectsConformance ? result.resultCount === 0 : result.resultCount > 0,
      `${result.id} SHACL result count contradicts its expected polarity`,
    );
    invariant(
      result.fixtureDocumentRef === expectation.relativeFile,
      `${result.id} is bound to the wrong fixture document`,
    );
    invariant(
      result.fixtureDocumentDigest === fileDigest(expectation.absoluteFile),
      `${result.id} fixture document digest drift`,
    );
    invariant(
      result.engine === evidence.engine.id && result.engineVersion === evidence.engine.version,
      `${result.id} engine attestation drift`,
    );
    invariant(
      canonicalJcs(result.arguments) === canonicalJcs(evidence.engine.arguments),
      `${result.id} engine argument drift`,
    );
    const shapeFile = requirePathInside(result.shapesRef, outputDirectory, `${result.id}.shapesRef`);
    const dataFile = requirePathInside(result.dataRef, outputDirectory, `${result.id}.dataRef`);
    invariant(fileDigest(shapeFile) === result.shapesDigest, `${result.id} shape digest drift`);
    invariant(fileDigest(dataFile) === result.dataDigest, `${result.id} data digest drift`);
    if (expectation.fixture.expectedViolation) {
      invariant(
        canonicalJcs(result.expectedViolation) === canonicalJcs(expectation.fixture.expectedViolation),
        `${result.id} expected violation drift`,
      );
    }
    if (expectation.fixture.expectedViolations) {
      invariant(
        canonicalJcs(result.expectedViolations) === canonicalJcs(expectation.fixture.expectedViolations),
        `${result.id} expected violation multiset drift`,
      );
    }
    if (!expectsConformance) {
      invariant(
        Array.isArray(result.actualViolations)
          && result.actualViolations.length === result.resultCount
          && result.actualViolations.every((violation) => (
            typeof violation.sourceShape === 'string'
              && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(violation.sourceShape)
          )),
        `${result.id} lacks exact sourceShape-bound actual violations`,
      );
    }
  }
  invariant(seen.size === expected.size, `${profile.module} SHACL fixture set drift`);
  return { accepted, rejected };
}

function validateFreshShaclRuntime() {
  const profiles = [
    {
      module: 'orders-execution',
      evidenceFile: 'orders-execution-targeted-evidence.json',
      fixtureFiles: [
        'tests/m2/fixtures/positive/orders-execution-positive.yaml',
        'tests/m2/fixtures/negative/orders-execution-negative.yaml',
      ],
    },
    {
      module: 'portfolio-positions',
      evidenceFile: 'portfolio-positions-targeted-evidence.json',
      fixtureFiles: [
        'tests/m2/fixtures/positive/portfolio-positions-positive.yaml',
        'tests/m2/fixtures/negative/portfolio-positions-negative.yaml',
      ],
    },
  ];
  const inheritedOutput = process.env.AXIOLUNE_GATE_OUTPUT_DIR;
  const outputRoot = inheritedOutput
    ? path.join(path.resolve(inheritedOutput), 'orders-portfolio-fresh-shacl')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-orders-portfolio-shacl-'));
  if (inheritedOutput) fs.mkdirSync(outputRoot, { recursive: true });
  let accepted = 0;
  let rejected = 0;
  try {
    for (const profile of profiles) {
      const outputDirectory = path.join(outputRoot, profile.module);
      const result = spawnSync(
        process.execPath,
        [DOMAIN_SHACL_RUNNER, '--module', profile.module, '--output-dir', outputDirectory],
        {
          cwd: ROOT,
          encoding: 'utf8',
          shell: false,
          timeout: 180000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      invariant(
        result.status === 0,
        `${profile.module} fresh pySHACL execution failed: ${
          result.error?.message || result.stderr || result.stdout || `exit ${result.status}`
        }`,
      );
      const evidenceFile = path.join(outputDirectory, profile.evidenceFile);
      invariant(fs.existsSync(evidenceFile), `${profile.module} emitted no SHACL evidence file`);
      const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
      const counts = auditFreshShaclEvidence(evidence, profile, outputDirectory);
      accepted += counts.accepted;
      rejected += counts.rejected;

      const tampered = structuredClone(evidence);
      tampered.results[0].dataDigest = `sha256:${'0'.repeat(64)}`;
      let rejectedTamper = false;
      try {
        auditFreshShaclEvidence(tampered, profile, outputDirectory);
      } catch {
        rejectedTamper = true;
      }
      invariant(rejectedTamper, `${profile.module} SHACL evidence tamper was accepted`);
    }
  } finally {
    if (!inheritedOutput) {
      const resolved = path.resolve(outputRoot);
      const temporaryRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
      invariant(
        resolved.startsWith(temporaryRoot)
          && path.basename(resolved).startsWith('axiolune-orders-portfolio-shacl-'),
        'refusing to remove an unverified SHACL temporary directory',
      );
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
  return { accepted, rejected };
}

function validateCorrectionMatrixInventory() {
  const document = loadYaml(POSITION_LOT_MATRIX_FILE);
  invariant(
    document.schemaVersion === '1.0'
      && document.contract === 'axiolune-position-lot-correction-matrix/v1',
    'PositionLot correction matrix profile drift',
  );
  invariant(Array.isArray(document.fixtures), 'PositionLot correction matrix lacks fixtures');
  const ids = document.fixtures.map((fixture) => fixture.id);
  invariant(new Set(ids).size === ids.length, 'PositionLot correction matrix has duplicate fixture IDs');
  const accepted = document.fixtures.filter((fixture) => fixture.expectedResult === 'accepted').length;
  const rejected = document.fixtures.filter((fixture) => fixture.expectedResult === 'rejected').length;
  invariant(accepted === 2 && rejected === 10, 'PositionLot correction matrix coverage drift');
  invariant(
    document.fixtures
      .filter((fixture) => fixture.expectedResult === 'rejected')
      .every((fixture) => typeof fixture.expectedReason === 'string' && fixture.expectedReason.length > 0),
    'PositionLot correction negative lacks an exact expected reason',
  );
  return { accepted, rejected };
}

function validateCustomRuntime() {
  const profileCheck = spawnSync(
    process.execPath,
    [CUSTOM_PROFILE_GENERATOR, '--check'],
    { cwd: ROOT, encoding: 'utf8', shell: false, timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  invariant(
    profileCheck.status === 0,
    `Orders/Portfolio Custom profile drift: ${profileCheck.stderr || profileCheck.stdout}`,
  );
  const inheritedOutput = process.env.AXIOLUNE_GATE_OUTPUT_DIR;
  const outputDirectory = inheritedOutput
    ? path.join(path.resolve(inheritedOutput), 'orders-portfolio-custom-runtime')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-orders-portfolio-custom-'));
  if (inheritedOutput) fs.mkdirSync(outputDirectory, { recursive: true });
  try {
    const result = spawnSync(
      process.execPath,
      [CUSTOM_RUNTIME_RUNNER, '--output-dir', outputDirectory],
      { cwd: ROOT, encoding: 'utf8', shell: false, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 },
    );
    invariant(
      result.status === 0,
      `Orders/Portfolio Custom runtime failed: ${result.error?.message || result.stderr || result.stdout}`,
    );
    const evidenceFile = path.join(outputDirectory, 'orders-portfolio-custom-runtime-evidence.json');
    invariant(fs.existsSync(evidenceFile), 'Orders/Portfolio Custom runtime emitted no evidence');
    const evidenceBytes = fs.readFileSync(evidenceFile);
    const evidence = JSON.parse(evidenceBytes.toString('utf8'));
    invariant(
      evidenceBytes.equals(Buffer.from(canonicalJcs(evidence), 'utf8')),
      'Orders/Portfolio Custom evidence is not exact RFC 8785 JCS',
    );
    invariant(
      evidence.outcome === 'passed' && evidence.componentEligible === true
        && evidence.discoveredConstraints?.length === 35,
      'Orders/Portfolio Custom evidence is not component-eligible or inventory-closed',
    );
    const byConstraint = new Map();
    for (const row of evidence.vectorResults || []) {
      invariant(row.status === 'passed', `Custom vector did not pass: ${row.caseId}`);
      if (row.constraintIri && ['accepted', 'violation'].includes(row.category)) {
        const categories = byConstraint.get(row.constraintIri) || new Set();
        categories.add(row.category);
        byConstraint.set(row.constraintIri, categories);
      }
    }
    invariant(
      byConstraint.size === 35
        && [...byConstraint.values()].every((categories) => categories.has('accepted') && categories.has('violation')),
      'not every Custom constraint has one accepted and one violation execution',
    );
    const engineControls = new Map(
      evidence.vectorResults
        .filter((row) => row.category === 'engineFailure')
        .map((row) => [row.caseId, row.actual]),
    );
    const dispatchControls = new Map(
      evidence.vectorResults
        .filter((row) => row.category === 'dispatchAttribution')
        .map((row) => [row.caseId, row.actual]),
    );
    const inputContractControls = new Map(
      evidence.vectorResults
        .filter((row) => row.category === 'inputContract')
        .map((row) => [row.caseId, row.actual]),
    );
    invariant(
      dispatchControls.get('unbound-constraint') === 'WORKER_EXIT'
        && dispatchControls.get('binding-tamper') === 'WORKER_EXIT'
        && inputContractControls.get('legacy-private-scenario') === 'WORKER_EXIT'
        && inputContractControls.get('unknown-private-field') === 'WORKER_EXIT'
        && inputContractControls.get('missing-official-required-field') === 'WORKER_EXIT'
        && inputContractControls.get('wrong-reference-mode') === 'WORKER_EXIT'
        && inputContractControls.get('wrong-role-target-type') === 'WORKER_EXIT'
        && inputContractControls.get('malformed-structured-value') === 'WORKER_EXIT'
        && engineControls.get('timeout') === 'TIME_LIMIT'
        && engineControls.get('oversize-input') === 'INPUT_LIMIT'
        && engineControls.get('oversize-output-cap') === 'OUTPUT_LIMIT',
      'Custom runtime fail-closed control inventory is incomplete',
    );
    invariant(
      Object.values(evidence.permissionAssurance || {}).every((value) => value === true)
        && evidence.executionBoundary?.nodePermissionModel === true,
      'Custom runtime permission assurance is incomplete',
    );
    for (const [referenceField, digestField] of [
      ['closureRef', 'closureDigest'], ['discoveryRef', 'discoveryDigest'],
      ['canonicalAdapterRef', 'canonicalAdapterDigest'],
      ['inputContractRef', 'inputContractDigest'], ['outputContractRef', 'outputContractDigest'],
      ['implementationRef', 'implementationDigest'], ['vectorRef', 'vectorDigest'],
      ['workerRef', 'workerDigest'],
    ]) {
      const artifactRef = evidence.artifacts?.[referenceField];
      invariant(
        artifactRef?.kind === 'path' && artifactRef.root === 'sourceTree'
          && typeof artifactRef.path === 'string' && !path.isAbsolute(artifactRef.path),
        `Custom evidence ${referenceField} is not a sourceTree ArtifactRef`,
      );
      const artifactFile = path.resolve(ROOT, ...artifactRef.path.split('/'));
      invariant(
        artifactFile.startsWith(`${path.resolve(ROOT)}${path.sep}`)
          && fileDigest(artifactFile) === evidence.artifacts[digestField],
        `Custom evidence ${digestField} drift`,
      );
    }
    const exactReadRoles = new Set([
      'adapter', 'arithmetic', 'canonicalization', 'implementation', 'input-contract', 'worker',
      'reference-registry', 'reference-registry-implementation',
    ]);
    const closureRef = evidence.artifacts.closureRef;
    const closureFile = path.resolve(ROOT, ...closureRef.path.split('/'));
    const closureBytes = fs.readFileSync(closureFile);
    const closure = JSON.parse(closureBytes.toString('utf8'));
    invariant(
      closureBytes.equals(Buffer.from(canonicalJcs(closure), 'utf8')),
      'Custom implementation closure is not exact RFC 8785 JCS',
    );
    const expectedReadAllowlist = (closure.artifacts || [])
      .filter((row) => exactReadRoles.has(row.role))
      .sort((left, right) => Buffer.compare(Buffer.from(left.ref.path, 'utf8'), Buffer.from(right.ref.path, 'utf8')));
    const actualReadAllowlist = evidence.executionBoundary?.exactReadAllowlist;
    invariant(
      exactReadRoles.size === 8
        && expectedReadAllowlist.length === exactReadRoles.size
        && new Set(expectedReadAllowlist.map((row) => row.role)).size === exactReadRoles.size
        && Array.isArray(actualReadAllowlist)
        && actualReadAllowlist.length === exactReadRoles.size
        && evidence.executionBoundary.exactReadAllowlistCount === actualReadAllowlist.length
        && canonicalJcs(actualReadAllowlist) === canonicalJcs(expectedReadAllowlist),
      'Custom runtime exact read allowlist is not the eight-member implementation-closure set',
    );
    return { constraints: byConstraint.size, vectors: evidence.vectorResults.length };
  } finally {
    if (!inheritedOutput) {
      const resolved = path.resolve(outputDirectory);
      invariant(
        resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)
          && path.basename(resolved).startsWith('axiolune-orders-portfolio-custom-'),
        `refusing to remove unverified Custom runtime directory ${resolved}`,
      );
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

function main() {
  try {
    const orders = loadYaml(ORDERS_FILE);
    const portfolio = loadYaml(PORTFOLIO_FILE);
    validateOrdersModule(orders);
    validatePortfolioModule(portfolio);
    validateProjectReferenceEvidence();
    validatePendingCodeListEvidence([orders, portfolio]);
    runFixtures();
    const correctionMatrix = validateCorrectionMatrixInventory();
    pass(
      'CORRECTION-MATRIX',
      `${correctionMatrix.accepted} accepted and ${correctionMatrix.rejected} fail-closed PositionLot correction/idempotence/conflict cases`,
    );
    const shaclRuntime = validateFreshShaclRuntime();
    pass(
      'RUNTIME-SHACL',
      `fresh pinned pySHACL execution covered ${shaclRuntime.accepted} conforming and ${shaclRuntime.rejected} rejecting fixtures with digest/tamper verification`,
    );
    const customRuntime = validateCustomRuntime();
    pass(
      'CUSTOM-RUNTIME-INVENTORY',
      `${customRuntime.constraints} exact constraint/target/expression/implementation bindings executed ${customRuntime.vectors} accepted, violation, tamper, unbound, timeout, and size-cap vectors`,
    );
  } catch (error) {
    fail('HARNESS', error.stack || error.message);
  }

  console.log(
    `\norders/portfolio v0.3 targeted checks: ${passes} passed, ${failures} failed, ${pending} pending`,
  );
  process.exitCode = failures > 0 ? 1 : pending > 0 ? 2 : 0;
}

module.exports = { validateFixture };

if (require.main === module) main();
