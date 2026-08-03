'use strict';

const crypto = require('node:crypto');

const { canonicalJcs } = require('./strict-source-locator.cjs');

const POST_TRADE_BASE = 'https://axiolune.ai/ontology/finance/post-trade-operations/';
const EXPECTED_CUSTOM_CONTRACT_COUNT = 31;
const EXPECTED_CUSTOM_CONTRACT_SET_DIGEST = 'sha256:39ae61f87f69cfa15fa4162c0508c4a2a1d593254e5e5abf92664ec1d6eaca80';
const EXPECTED_MANDATORY_BINDING_COUNT = 231;
const EXPECTED_MANDATORY_BINDING_SET_DIGEST = 'sha256:fe7f37b89e647b6151ff9336a58ee936763ca4fdbc3aca369c8578ba77505e69';

// These rows are an independent, reviewed lock. They must never be derived from
// the document passed to auditPostTradeCustomContracts(). Expression digests are
// SHA-256 over the exact UTF-8 bytes of expression.expression, without trimming
// or normalization.
const CUSTOM_CONTRACT_ROWS = Object.freeze([
  ['CorporateActionEventContract', 'CorporateActionEvent', 'corporate-action event matrix or scope is invalid', '0202b6e0318d3e0404f52d80c0174ab90ec8982caae060f5cf639f498dac573a'],
  ['ScheduleEvaluationInputContract', 'CorporateActionScheduleEvaluationInput', 'schedule evaluation input does not close Event/request scope', '58a2e5111cae79b0d5f1ca691d963711fbda087b683c8972d2a8e3caa89cee35'],
  ['DistributionSizeAssessmentContract', 'CorporateActionDistributionSizeAssessment', 'distribution size assessment is invalid', '7b8fce11b097dd1d7d3192fcbdf564eca1432640c492e75e0e883812f7ab376a'],
  ['ScheduleResolutionContract', 'CorporateActionScheduleResolution', 'corporate-action schedule resolution is invalid', '9fc7013df211f81a9f1849c8d9cacddc7ff6b76d744950aa39f4c296a4990eeb'],
  ['RecordPositionAbsenceContract', 'RecordPositionAbsenceAssertion', 'record-position absence assertion is invalid', '64d02acdb6cefa3d8f4743b98edc2b13cdf20ab878e36f8c3976768190096341'],
  ['CorporateActionEntitlementContract', 'CorporateActionEntitlement', 'corporate-action entitlement closure or arithmetic is invalid', '61c7a4ccef055458395ad7f2eff1d01a169fb6a69962443da8fe83a6a18e4166'],
  ['CustodySettlementAccountBridgeContract', 'CustodySettlementAccountBridge', 'custody settlement account bridge is invalid', '6fb8a4884a57bc3ecd8229eb20cc3a48dc213edfb93d81b417987d3e0f3efb4d'],
  ['DueBillTradeQualificationContract', 'CorporateActionDueBillTradeQualification', 'due-bill trade qualification is invalid', 'da2485bbf9acbbc61c825c4b8344eb0afe8815235d390db838ee3f52c7ae3601'],
  ['DueBillObligationContract', 'CorporateActionDueBillObligation', 'due-bill obligation source, endpoints, or benefit is invalid', '65b13c09ac78ee478cb7925aeb083caad84a1224cf80da657496b231b3a934a1'],
  ['DueBillTransferContract', 'CorporateActionDueBillTransfer', 'due-bill transfer is invalid', 'ef2656cd519e614be5b4dc52ef5fb8fc8ab9b53e3f983810d3d76473c7d87a1f'],
  ['DueBillTransferClosureContract', 'CorporateActionDueBillTransferFulfillmentClosure', 'due-bill transfer fulfillment closure is invalid', 'ebf5f0651a98c133e6614ff45def2782c2be63cf794a3d173c23eaea631bc964'],
  ['ElectionProviderPolicyContract', 'CorporateActionElectionProviderPolicy', 'election-provider policy is invalid', '6fb1f9cb07ef310b20e801bb79bba5ca984e87158787a4633f13f79b19ecd056'],
  ['CorporateActionElectionContract', 'CorporateActionElection', 'corporate-action election is invalid', '4fe26b9e234905ae5eeda550ea0935e12099091754e525af631646a9c9980b06'],
  ['ElectionResolutionContract', 'CorporateActionElectionResolution', 'corporate-action election resolution is invalid', '19bd2e23b482eefb22f514fbdbafc89e5fc92ba02a19ed8f03c7c16889ec08b6'],
  ['SubscriptionObligationContract', 'CorporateActionSubscriptionObligation', 'corporate-action subscription obligation is invalid', '8f7d78deb0d241492233738ac8dc2733f287ac80e30916ab888fbdbb54ef3fe3'],
  ['SubscriptionFulfillmentContract', 'CorporateActionSubscriptionFulfillment', 'subscription fulfillment is invalid', '8750dd146aa24b6fa220696b3995aa881f58c4f645b247faf3d8d3eb6cd7d8d9'],
  ['SubscriptionFulfillmentClosureContract', 'CorporateActionSubscriptionFulfillmentClosure', 'subscription fulfillment closure is invalid', '2cf27ad2733d929c5bd592a5e0766c695739f0ce405198835d91bdec01d8ab28'],
  ['CorporateActionProcessingFindingContract', 'CorporateActionProcessingFinding', 'corporate-action processing finding matrix is invalid', 'f7c06331d1e798128ec3ee0711d435ae444db831eafac268f66851b41f632d30'],
  ['CorporateActionAdjustmentContract', 'CorporateActionAdjustment', 'corporate-action adjustment is invalid', '4575e345882f84a318b871ce7af8260defb38d98db5de008c054da426465fd9a'],
  ['SettlementInstructionContract', 'SettlementInstruction', 'settlement instruction DVP/FOP structure is invalid', 'd45cb704e4efcc8c83ee9d7554184b0ab15807017e6ed57687a19f5e5448c2c1'],
  ['SettlementLegContract', 'SettlementLeg', 'settlement leg endpoints or asset branch is invalid', '08025427ffdfa334f06996cbf6829971f5040cd09bec452855a968cce81712bc'],
  ['TradeSettlementAllocationContract', 'TradeSettlementAllocation', 'trade settlement allocation is invalid', 'f91d6c32e5362cc7b77f386d407cd2d26880ff527265acf3772e1e8a0a19b3e0'],
  ['SettlementStatusEventContract', 'SettlementStatusEvent', 'settlement status event is invalid', '7b95f311264a0f0b34e58142d5635f269f3c13ad2559791a7fcacfe91c9fb039'],
  ['ExternalSettlementStatementContract', 'ExternalSettlementStatement', 'external settlement statement is invalid', 'ee8176ada447707d8a04cd9428ba3718e2fa4a23613d0264011c21e4bccd80a8'],
  ['ExternalSettlementStatementLineContract', 'ExternalSettlementStatementLine', 'external settlement statement line is invalid', 'efae93a3c76de699cfc8a28346e06eb3edec0cd68d571a7c1b2a05ce6c8738bf'],
  ['SettlementReconciliationComparatorContract', 'SettlementReconciliationComparator', 'settlement reconciliation comparator is invalid', '4f661c8bbc2d90f3dfbb07327c208c85661b8fcae9e1c82652a71053c2dbd234'],
  ['ReconciliationCaseContract', 'ReconciliationCase', 'reconciliation case mode or allocation closure is invalid', '964f0ae9155ba3a080b44e762b797c6c330b7b1dec6de19ed8ac9e4570cb66f7'],
  ['InternalProjectionContract', 'SettlementReconciliationInternalProjection', 'settlement reconciliation internal projection is invalid', '0f4722312d1f161eec4e48101e05f1987b6550e6a71fca1abbc469e2d4e94194'],
  ['MissingSideAssertionContract', 'MissingSideAssertion', 'missing-side assertion is invalid', 'b5c9774f69b3fc6151d56e46d590ce0f05266e3026243da3a6c1d9c8c910c682'],
  ['ReconciliationFindingContract', 'ReconciliationFinding', 'reconciliation finding count/kind matrix is invalid', '8dba67ba4ddcad87dd68a2a85a46f297a2bc022bf238e5a5cb4bb3e2265f0ad5'],
  ['ReconciliationStatusEventContract', 'ReconciliationStatusEvent', 'reconciliation status event is invalid', '4fe7ec41aef9d2d7890992f14d05dc2e8d9ca6aee7d0a694cf1dc5320bb7624b'],
].map((row) => Object.freeze(row)));

const POST_TRADE_CUSTOM_CONTRACT_LOCK = Object.freeze(Object.fromEntries(
  CUSTOM_CONTRACT_ROWS.map(([name, targetLocalName, message, expressionSha256]) => [
    name,
    Object.freeze({
      name,
      iri: `${POST_TRADE_BASE}${name}`,
      localName: name,
      targetElement: `${POST_TRADE_BASE}${targetLocalName}`,
      severity: 'Error',
      message,
      expressionSha256,
    }),
  ]),
));

class PostTradeCustomContractAuditError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'PostTradeCustomContractAuditError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PostTradeCustomContractAuditError(code, message, details);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Utf8(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalSetDigest(values) {
  const members = values.map((value) => canonicalJcs(value)).sort(compareAscii);
  return `sha256:${sha256Utf8(`[${members.join(',')}]`)}`;
}

function computeCustomContractSetDigest(contracts) {
  const sorted = [...contracts].sort((left, right) => compareAscii(left.name, right.name));
  return `sha256:${sha256Utf8(canonicalJcs(sorted))}`;
}

function isTrivialExpression(value) {
  if (typeof value !== 'string') return true;
  const collapsed = value.trim().replace(/\s+/gu, ' ');
  if (collapsed.length < 32) return true;
  const normalized = collapsed.toLowerCase().replace(/[.;\s]+$/gu, '');
  return /^(?:true|false|pass|allow|accept|valid|return\s+true|always\s+true)(?:\(\))?$/u.test(normalized);
}

function assertStaticLockIntegrity() {
  if (CUSTOM_CONTRACT_ROWS.length !== EXPECTED_CUSTOM_CONTRACT_COUNT) {
    throw new Error('post-trade Custom contract lock count drift');
  }
  const names = CUSTOM_CONTRACT_ROWS.map(([name]) => name);
  if (new Set(names).size !== names.length) {
    throw new Error('post-trade Custom contract lock contains duplicate names');
  }
  const digest = computeCustomContractSetDigest(Object.values(POST_TRADE_CUSTOM_CONTRACT_LOCK));
  if (digest !== EXPECTED_CUSTOM_CONTRACT_SET_DIGEST) {
    throw new Error(`post-trade Custom contract lock digest drift: ${digest}`);
  }
}

assertStaticLockIntegrity();

function auditPostTradeCustomContracts(document) {
  if (!isPlainObject(document) || !isPlainObject(document.domain)) {
    fail('PTO_CUSTOM_DOCUMENT_SHAPE', 'document.domain must be a plain object');
  }
  const { constraints, constraintBindings } = document.domain;
  if (!isPlainObject(constraints)) {
    fail('PTO_CUSTOM_DOCUMENT_SHAPE', 'document.domain.constraints must be a plain object');
  }
  if (!Array.isArray(constraintBindings)) {
    fail('PTO_CUSTOM_DOCUMENT_SHAPE', 'document.domain.constraintBindings must be an array');
  }

  const expectedNames = Object.keys(POST_TRADE_CUSTOM_CONTRACT_LOCK);
  const missing = expectedNames.filter((name) => !Object.hasOwn(constraints, name));
  const extra = Object.entries(constraints)
    .filter(([name, constraint]) => (
      constraint?.expression?.language === 'Custom'
      && !Object.hasOwn(POST_TRADE_CUSTOM_CONTRACT_LOCK, name)
    ))
    .map(([name]) => name)
    .sort(compareAscii);
  if (missing.length > 0 || extra.length > 0) {
    fail(
      'PTO_CUSTOM_INVENTORY',
      'Custom constraint inventory is not the frozen closed set',
      { missing: missing.sort(compareAscii), extra },
    );
  }

  const auditedContracts = [];
  for (const name of expectedNames) {
    const expected = POST_TRADE_CUSTOM_CONTRACT_LOCK[name];
    const actual = constraints[name];
    if (!isPlainObject(actual) || !isPlainObject(actual.expression)) {
      fail('PTO_CUSTOM_EXPRESSION_SHAPE', `${name} must contain a closed expression object`, { name });
    }
    const expressionKeys = Object.keys(actual.expression).sort(compareAscii);
    if (canonicalJcs(expressionKeys) !== canonicalJcs(['expression', 'language'])) {
      fail(
        'PTO_CUSTOM_EXPRESSION_SHAPE',
        `${name} expression must contain exactly language and expression`,
        { name, expressionKeys },
      );
    }
    if (actual.expression.language !== 'Custom') {
      fail(
        'PTO_CUSTOM_EXPRESSION_LANGUAGE',
        `${name} expression language must remain Custom`,
        { name, actual: actual.expression.language },
      );
    }
    if (isTrivialExpression(actual.expression.expression)) {
      fail(
        'PTO_CUSTOM_EXPRESSION_TRIVIAL',
        `${name} expression is absent or semantically vacuous`,
        { name },
      );
    }

    const metadataFields = ['iri', 'localName', 'targetElement', 'severity', 'message'];
    const driftedFields = metadataFields.filter((field) => actual[field] !== expected[field]);
    if (driftedFields.length > 0) {
      fail(
        'PTO_CUSTOM_METADATA',
        `${name} metadata drifted from the frozen contract`,
        {
          name,
          driftedFields,
          expected: Object.fromEntries(driftedFields.map((field) => [field, expected[field]])),
          actual: Object.fromEntries(driftedFields.map((field) => [field, actual[field]])),
        },
      );
    }

    const expressionSha256 = sha256Utf8(actual.expression.expression);
    if (expressionSha256 !== expected.expressionSha256) {
      fail(
        'PTO_CUSTOM_EXPRESSION_DIGEST',
        `${name} full expression SHA-256 drifted`,
        { name, expected: expected.expressionSha256, actual: expressionSha256 },
      );
    }
    auditedContracts.push({
      name,
      iri: actual.iri,
      localName: actual.localName,
      targetElement: actual.targetElement,
      severity: actual.severity,
      message: actual.message,
      expressionSha256,
    });
  }

  for (const [index, binding] of constraintBindings.entries()) {
    if (!isPlainObject(binding)) {
      fail(
        'PTO_MANDATORY_BINDING_SHAPE',
        `constraint binding ${index} must be a plain object`,
        { index },
      );
    }
  }

  for (const expected of Object.values(POST_TRADE_CUSTOM_CONTRACT_LOCK)) {
    const expectedBinding = {
      constraintRef: expected.iri,
      targetElement: expected.targetElement,
      enforcementLevel: 'Mandatory',
    };
    const matching = constraintBindings.filter((binding) => binding.constraintRef === expected.iri);
    if (matching.length !== 1 || canonicalJcs(matching[0]) !== canonicalJcs(expectedBinding)) {
      fail(
        'PTO_CUSTOM_BINDING_CLOSURE',
        `${expected.name} must have exactly one exact Mandatory target binding`,
        { name: expected.name, expected: expectedBinding, actual: matching },
      );
    }
  }

  const mandatoryBindings = constraintBindings
    .filter((binding) => binding.enforcementLevel === 'Mandatory');
  let mandatoryBindingSetDigest;
  try {
    mandatoryBindingSetDigest = canonicalSetDigest(mandatoryBindings);
  } catch (cause) {
    fail(
      'PTO_MANDATORY_BINDING_SHAPE',
      `Mandatory binding is not canonical JSON: ${cause.message}`,
    );
  }
  if (
    mandatoryBindings.length !== EXPECTED_MANDATORY_BINDING_COUNT
    || mandatoryBindingSetDigest !== EXPECTED_MANDATORY_BINDING_SET_DIGEST
  ) {
    fail(
      'PTO_MANDATORY_BINDING_CLOSURE',
      'Mandatory bindings are not the frozen exact closed set',
      {
        expectedCount: EXPECTED_MANDATORY_BINDING_COUNT,
        actualCount: mandatoryBindings.length,
        expectedDigest: EXPECTED_MANDATORY_BINDING_SET_DIGEST,
        actualDigest: mandatoryBindingSetDigest,
      },
    );
  }

  const customContractSetDigest = computeCustomContractSetDigest(auditedContracts);
  if (customContractSetDigest !== EXPECTED_CUSTOM_CONTRACT_SET_DIGEST) {
    fail(
      'PTO_CUSTOM_CONTRACT_SET_DIGEST',
      'audited Custom contract set differs from the static lock',
      { expected: EXPECTED_CUSTOM_CONTRACT_SET_DIGEST, actual: customContractSetDigest },
    );
  }

  return Object.freeze({
    ok: true,
    profile: 'post-trade-custom-contract-audit/v1',
    customConstraintCount: auditedContracts.length,
    customContractSetDigest,
    mandatoryBindingCount: mandatoryBindings.length,
    mandatoryBindingSetDigest,
  });
}

module.exports = {
  EXPECTED_CUSTOM_CONTRACT_COUNT,
  EXPECTED_CUSTOM_CONTRACT_SET_DIGEST,
  EXPECTED_MANDATORY_BINDING_COUNT,
  EXPECTED_MANDATORY_BINDING_SET_DIGEST,
  POST_TRADE_CUSTOM_CONTRACT_LOCK,
  PostTradeCustomContractAuditError,
  auditPostTradeCustomContracts,
};
