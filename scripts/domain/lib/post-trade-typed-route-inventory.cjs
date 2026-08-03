'use strict';

const crypto = require('node:crypto');

const { canonicalJcs } = require('./strict-source-locator.cjs');

const ROUTE_INVENTORY_PROFILE = 'axiolune-post-trade-typed-route-inventory/v1';
const BASE = 'https://axiolune.ai/ontology/finance/';

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

const TYPE = Object.freeze({
  CorporateActionEvent: `${BASE}post-trade-operations/CorporateActionEvent`,
  CorporateActionScheduleEvaluationInput: `${BASE}post-trade-operations/CorporateActionScheduleEvaluationInput`,
  RuleApplicability: `${BASE}market-rules/RuleApplicability`,
  CorporateActionScheduleRule: `${BASE}market-rules/CorporateActionScheduleRule`,
  CorporateActionDistributionAssessmentMethod: `${BASE}market-rules/CorporateActionDistributionAssessmentMethod`,
  RuleEvaluationRequest: `${BASE}market-rules/RuleEvaluationRequest`,
  PriceObservation: `${BASE}market-data/PriceObservation`,
  CorporateActionDistributionSizeAssessment: `${BASE}post-trade-operations/CorporateActionDistributionSizeAssessment`,
  CorporateActionScheduleResolution: `${BASE}post-trade-operations/CorporateActionScheduleResolution`,
  CorporateActionDueBillTradeQualification: `${BASE}post-trade-operations/CorporateActionDueBillTradeQualification`,
  TradeSettlementAllocation: `${BASE}post-trade-operations/TradeSettlementAllocation`,
  Execution: `${BASE}orders-execution/Execution`,
  SettlementInstruction: `${BASE}post-trade-operations/SettlementInstruction`,
  SettlementLeg: `${BASE}post-trade-operations/SettlementLeg`,
  SettlementStatusEvent: `${BASE}post-trade-operations/SettlementStatusEvent`,
  FinancialAccountPartyRole: `${BASE}foundation/FinancialAccountPartyRole`,
  CorporateActionDueBillObligation: `${BASE}post-trade-operations/CorporateActionDueBillObligation`,
  CorporateActionDueBillTransfer: `${BASE}post-trade-operations/CorporateActionDueBillTransfer`,
  CorporateActionDueBillTransferFulfillmentClosure: `${BASE}post-trade-operations/CorporateActionDueBillTransferFulfillmentClosure`,
  CorporateActionEntitlement: `${BASE}post-trade-operations/CorporateActionEntitlement`,
  CorporateActionElectionProviderPolicy: `${BASE}post-trade-operations/CorporateActionElectionProviderPolicy`,
  CorporateActionElectionProviderMember: `${BASE}post-trade-operations/CorporateActionElectionProviderMember`,
  CorporateActionElectionProviderNormalization: `${BASE}post-trade-operations/CorporateActionElectionProviderNormalization`,
  CorporateActionElectionProviderPrecedenceEdge: `${BASE}post-trade-operations/CorporateActionElectionProviderPrecedenceEdge`,
  CorporateActionElection: `${BASE}post-trade-operations/CorporateActionElection`,
  CorporateActionElectionResolution: `${BASE}post-trade-operations/CorporateActionElectionResolution`,
  CorporateActionSubscriptionObligation: `${BASE}post-trade-operations/CorporateActionSubscriptionObligation`,
  CorporateActionSubscriptionFulfillment: `${BASE}post-trade-operations/CorporateActionSubscriptionFulfillment`,
  CorporateActionSubscriptionFulfillmentClosure: `${BASE}post-trade-operations/CorporateActionSubscriptionFulfillmentClosure`,
  CorporateActionAdjustment: `${BASE}post-trade-operations/CorporateActionAdjustment`,
  CustodySettlementAccountBridge: `${BASE}post-trade-operations/CustodySettlementAccountBridge`,
  ReconciliationCase: `${BASE}post-trade-operations/ReconciliationCase`,
  SettlementReconciliationComparator: `${BASE}post-trade-operations/SettlementReconciliationComparator`,
  ExternalSettlementStatement: `${BASE}post-trade-operations/ExternalSettlementStatement`,
  SettlementReconciliationInternalProjection: `${BASE}post-trade-operations/SettlementReconciliationInternalProjection`,
  ExternalSettlementStatementLine: `${BASE}post-trade-operations/ExternalSettlementStatementLine`,
  MissingSideAssertion: `${BASE}post-trade-operations/MissingSideAssertion`,
  ReconciliationFinding: `${BASE}post-trade-operations/ReconciliationFinding`,
  ReconciliationStatusEvent: `${BASE}post-trade-operations/ReconciliationStatusEvent`,
});

function route(pointerPattern, typeIri, expectedCount) {
  return Object.freeze({ pointerPattern, typeIri, expectedCount });
}

const RECORD_ROUTE_RULES = Object.freeze([
  route('/fixtures/0/instance/events/*', TYPE.CorporateActionEvent, 3),

  route('/fixtures/1/instance/event', TYPE.CorporateActionEvent, 1),
  route('/fixtures/1/instance/evaluationInput', TYPE.CorporateActionScheduleEvaluationInput, 1),
  route('/fixtures/1/instance/applicability', TYPE.RuleApplicability, 1),
  route('/fixtures/1/instance/scheduleRule', TYPE.CorporateActionScheduleRule, 1),
  route('/fixtures/1/instance/method', TYPE.CorporateActionDistributionAssessmentMethod, 1),
  route('/fixtures/1/instance/assessment/pitContext', TYPE.RuleEvaluationRequest, 1),
  route('/fixtures/1/instance/assessment/priceObservation', TYPE.PriceObservation, 1),
  route('/fixtures/1/instance/assessment', TYPE.CorporateActionDistributionSizeAssessment, 1),

  route('/fixtures/2/instance/event', TYPE.CorporateActionEvent, 1),
  route('/fixtures/2/instance/resolution', TYPE.CorporateActionScheduleResolution, 1),
  route('/fixtures/2/instance/qualifications/*', TYPE.CorporateActionDueBillTradeQualification, 1),
  route('/fixtures/2/instance/qualifications/*/allocation', TYPE.TradeSettlementAllocation, 1),
  route('/fixtures/2/instance/qualifications/*/execution', TYPE.Execution, 1),
  route('/fixtures/2/instance/qualifications/*/instruction', TYPE.SettlementInstruction, 1),
  route('/fixtures/2/instance/qualifications/*/instruction/legs/*', TYPE.SettlementLeg, 2),
  route('/fixtures/2/instance/qualifications/*/securityLeg', TYPE.SettlementLeg, 1),
  route('/fixtures/2/instance/qualifications/*/settlementStatusEvent', TYPE.SettlementStatusEvent, 1),
  route('/fixtures/2/instance/qualifications/*/liableAccountPartyRoles/*', TYPE.FinancialAccountPartyRole, 1),
  route('/fixtures/2/instance/qualifications/*/beneficiaryAccountPartyRoles/*', TYPE.FinancialAccountPartyRole, 1),
  route('/fixtures/2/instance/obligations/*', TYPE.CorporateActionDueBillObligation, 3),
  route('/fixtures/2/instance/obligations/*/liableAccountPartyRoles/*', TYPE.FinancialAccountPartyRole, 3),
  route('/fixtures/2/instance/obligations/*/beneficiaryAccountPartyRoles/*', TYPE.FinancialAccountPartyRole, 3),
  route('/fixtures/2/instance/transfers/*', TYPE.CorporateActionDueBillTransfer, 5),
  route('/fixtures/2/instance/transferClosures/*', TYPE.CorporateActionDueBillTransferFulfillmentClosure, 3),

  route('/fixtures/3/instance/event', TYPE.CorporateActionEvent, 1),
  route('/fixtures/3/instance/entitlement', TYPE.CorporateActionEntitlement, 1),
  route('/fixtures/3/instance/providerPolicy', TYPE.CorporateActionElectionProviderPolicy, 1),
  route('/fixtures/3/instance/providerPolicy/providerMembers/*', TYPE.CorporateActionElectionProviderMember, 2),
  route('/fixtures/3/instance/providerPolicy/normalizationMappings/*', TYPE.CorporateActionElectionProviderNormalization, 2),
  route('/fixtures/3/instance/providerPolicy/precedenceEdges/*', TYPE.CorporateActionElectionProviderPrecedenceEdge, 1),
  route('/fixtures/3/instance/electionCandidates/*', TYPE.CorporateActionElection, 2),
  route('/fixtures/3/instance/electionCandidates/1/authorizationAccountPartyRole', TYPE.FinancialAccountPartyRole, 1),
  route('/fixtures/3/instance/resolution', TYPE.CorporateActionElectionResolution, 1),
  route('/fixtures/3/instance/subscriptionObligation', TYPE.CorporateActionSubscriptionObligation, 1),
  route('/fixtures/3/instance/fulfillments/*', TYPE.CorporateActionSubscriptionFulfillment, 2),
  route('/fixtures/3/instance/fulfillmentClosure', TYPE.CorporateActionSubscriptionFulfillmentClosure, 1),
  route('/fixtures/3/instance/adjustment', TYPE.CorporateActionAdjustment, 1),

  route('/fixtures/4/instance/bridges/*', TYPE.CustodySettlementAccountBridge, 1),
  route('/fixtures/4/instance/instructions/*', TYPE.SettlementInstruction, 2),
  route('/fixtures/4/instance/instructions/*/legs/*', TYPE.SettlementLeg, 3),
  route('/fixtures/4/instance/instructions/1/statusEvents/0', TYPE.SettlementStatusEvent, 1),
  route('/fixtures/4/instance/allocations/*', TYPE.TradeSettlementAllocation, 2),
  route('/fixtures/4/instance/allocations/*/execution', TYPE.Execution, 2),

  route('/fixtures/6/instance/case', TYPE.ReconciliationCase, 1),
  route('/fixtures/6/instance/comparator', TYPE.SettlementReconciliationComparator, 1),
  route('/fixtures/6/instance/externalStatement', TYPE.ExternalSettlementStatement, 1),
  route('/fixtures/6/instance/bridges/*', TYPE.CustodySettlementAccountBridge, 2),
  route('/fixtures/6/instance/legs/*', TYPE.SettlementLeg, 10),
  route('/fixtures/6/instance/allocations/*', TYPE.TradeSettlementAllocation, 13),
  route('/fixtures/6/instance/internalProjections/*', TYPE.SettlementReconciliationInternalProjection, 10),
  route('/fixtures/6/instance/externalStatementLines/*', TYPE.ExternalSettlementStatementLine, 10),
  route('/fixtures/6/instance/missingSideAssertions/*', TYPE.MissingSideAssertion, 4),
  route('/fixtures/6/instance/findings/*', TYPE.ReconciliationFinding, 9),
  route('/fixtures/6/instance/statusEvents/*', TYPE.ReconciliationStatusEvent, 3),

  route('/fixtures/7/instance/case', TYPE.ReconciliationCase, 1),
  route('/fixtures/7/instance/comparator', TYPE.SettlementReconciliationComparator, 1),
  route('/fixtures/7/instance/externalStatement', TYPE.ExternalSettlementStatement, 1),
  route('/fixtures/7/instance/legs/*', TYPE.SettlementLeg, 2),
  route('/fixtures/7/instance/internalProjections/*', TYPE.SettlementReconciliationInternalProjection, 2),
  route('/fixtures/7/instance/externalStatementLines/*', TYPE.ExternalSettlementStatementLine, 2),
  route('/fixtures/7/instance/findings/*', TYPE.ReconciliationFinding, 2),
  route('/fixtures/7/instance/statusEvents/*', TYPE.ReconciliationStatusEvent, 3),
]);

const NON_RECORD_REASON = Object.freeze({
  fixtureScenarioContainer: 'fixtureScenarioContainer',
  expectedProjectionAssertion: 'expectedProjectionAssertion',
  embeddedRecordPositionEvidence: 'embeddedRecordPositionEvidence',
});
const NON_RECORD_REASON_SET = new Set(Object.values(NON_RECORD_REASON));
const SIGNAL_FIELDS = new Set([
  'versionIri',
  'logicalIri',
  'validFrom',
  'knowledgeFrom',
  'availableFrom',
  'sourceArtifactRef',
  'generatingContextRef',
]);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class PostTradeTypedRouteInventoryError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'PostTradeTypedRouteInventoryError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PostTradeTypedRouteInventoryError(code, message, details);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJcs(value), 'utf8').digest('hex')}`;
}

function escapePointerToken(value) {
  return String(value).replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function unescapePointerToken(value, at) {
  if (/~(?![01])/u.test(value)) fail('PTO_ROUTE_POINTER', `invalid JSON Pointer escape at ${at}`);
  const decoded = value.replace(/~1/gu, '/').replace(/~0/gu, '~');
  if (UNSAFE_KEYS.has(decoded)) fail('PTO_ROUTE_POINTER', `unsafe JSON Pointer token at ${at}`);
  return decoded;
}

function resolvePointer(document, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
    fail('PTO_ROUTE_POINTER', `expected non-root canonical JSON Pointer, got ${String(pointer)}`);
  }
  let current = document;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = unescapePointerToken(rawToken, pointer);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) fail('PTO_ROUTE_POINTER', `invalid array index at ${pointer}`);
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) fail('PTO_ROUTE_POINTER', `array index out of bounds at ${pointer}`);
      current = current[index];
    } else if (isPlainObject(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      fail('PTO_ROUTE_POINTER', `pointer does not resolve: ${pointer}`);
    }
  }
  return current;
}

function expandPattern(document, pointerPattern) {
  const rawTokens = pointerPattern.slice(1).split('/');
  const matches = [];
  function visit(value, index, tokens) {
    if (index === rawTokens.length) {
      matches.push({ pointer: `/${tokens.join('/')}`, value });
      return;
    }
    const rawToken = rawTokens[index];
    if (rawToken === '*') {
      if (!Array.isArray(value)) fail('PTO_ROUTE_PATTERN', `${pointerPattern} wildcard must traverse an array`);
      value.forEach((item, itemIndex) => visit(item, index + 1, [...tokens, String(itemIndex)]));
      return;
    }
    const token = unescapePointerToken(rawToken, pointerPattern);
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) {
        fail('PTO_ROUTE_PATTERN', `${pointerPattern} has a non-canonical array index ${token}`);
      }
      const arrayIndex = Number(token);
      if (!Number.isSafeInteger(arrayIndex) || arrayIndex >= value.length) {
        fail('PTO_ROUTE_PATTERN', `${pointerPattern} array index is out of bounds at ${token}`);
      }
      visit(value[arrayIndex], index + 1, [...tokens, token]);
      return;
    }
    if (!isPlainObject(value) || !Object.hasOwn(value, token)) {
      fail('PTO_ROUTE_PATTERN', `${pointerPattern} does not resolve at ${token}`);
    }
    visit(value[token], index + 1, [...tokens, escapePointerToken(token)]);
  }
  visit(document, 0, []);
  return matches;
}

function collectHeuristicCandidates(document) {
  const result = [];
  function visit(value, pointer) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${pointer}/${index}`));
      return;
    }
    if (!isPlainObject(value)) return;
    const signalFields = Object.keys(value)
      .filter((key) => SIGNAL_FIELDS.has(key) || key.endsWith('VersionIri'))
      .sort();
    if (signalFields.length > 0) result.push({ pointer, value, signalFields });
    for (const [key, nested] of Object.entries(value)) {
      visit(nested, `${pointer}/${escapePointerToken(key)}`);
    }
  }
  visit(document, '');
  return result.sort((left, right) => compareUtf8(left.pointer, right.pointer));
}

function compilePostTradeTypedRouteInventory(sourceDocument, classifications) {
  if (!isPlainObject(sourceDocument)) fail('PTO_ROUTE_SOURCE', 'sourceDocument must be a plain object');
  if (!Array.isArray(classifications)) fail('PTO_ROUTE_CLASSIFICATION', 'classifications must be an array');

  const records = [];
  const claimed = new Map();
  for (const rule of RECORD_ROUTE_RULES) {
    const matches = expandPattern(sourceDocument, rule.pointerPattern);
    if (matches.length !== rule.expectedCount) {
      fail(
        'PTO_ROUTE_COUNT',
        `${rule.pointerPattern} expected ${rule.expectedCount} records, got ${matches.length}`,
      );
    }
    for (const match of matches) {
      if (!isPlainObject(match.value)) fail('PTO_ROUTE_RECORD_SHAPE', `${match.pointer} must be a plain record object`);
      if (claimed.has(match.pointer)) fail('PTO_ROUTE_DUPLICATE', `${match.pointer} is claimed by two record routes`);
      const entry = {
        pointer: match.pointer,
        pointerPattern: rule.pointerPattern,
        typeIri: rule.typeIri,
        sourceRecordDigest: digest(match.value),
        value: match.value,
      };
      claimed.set(match.pointer, { kind: 'record', entry });
      records.push(entry);
    }
  }

  const nonRecords = [];
  let previousPath = null;
  for (const [index, classification] of classifications.entries()) {
    if (!isPlainObject(classification)) fail('PTO_ROUTE_CLASSIFICATION', `classification ${index} must be an object`);
    const keys = Object.keys(classification).sort();
    if (canonicalJcs(keys) !== canonicalJcs(['path', 'reason', 'sourceObjectDigest'].sort())) {
      fail('PTO_ROUTE_CLASSIFICATION', `classification ${index} must contain exactly path, reason, sourceObjectDigest`);
    }
    if (typeof classification.path !== 'string' || !classification.path.startsWith('/')) {
      fail('PTO_ROUTE_CLASSIFICATION', `classification ${index}.path must be a non-root JSON Pointer`);
    }
    if (previousPath !== null && previousPath >= classification.path) {
      fail('PTO_ROUTE_CLASSIFICATION', 'classifications must be strictly sorted by path');
    }
    previousPath = classification.path;
    if (!NON_RECORD_REASON_SET.has(classification.reason)) {
      fail('PTO_ROUTE_CLASSIFICATION', `unsupported non-record reason ${String(classification.reason)}`);
    }
    if (!DIGEST_RE.test(classification.sourceObjectDigest || '')) {
      fail('PTO_ROUTE_CLASSIFICATION', `${classification.path} has invalid sourceObjectDigest`);
    }
    if (claimed.has(classification.path)) {
      fail('PTO_ROUTE_DUPLICATE', `${classification.path} is both a record and a non-record`);
    }
    const value = resolvePointer(sourceDocument, classification.path);
    if (!isPlainObject(value)) fail('PTO_ROUTE_CLASSIFICATION', `${classification.path} must select a plain object`);
    const actualDigest = digest(value);
    if (actualDigest !== classification.sourceObjectDigest) {
      fail(
        'PTO_ROUTE_CLASSIFICATION_DIGEST',
        `${classification.path} content differs from its non-record classification lock`,
        { expected: classification.sourceObjectDigest, actual: actualDigest },
      );
    }
    const entry = { ...classification, value };
    claimed.set(classification.path, { kind: 'nonRecord', entry });
    nonRecords.push(entry);
  }

  const candidates = collectHeuristicCandidates(sourceDocument);
  const candidatePaths = new Set(candidates.map((candidate) => candidate.pointer));
  const unresolved = candidates.filter((candidate) => !claimed.has(candidate.pointer));
  const extraClaims = [...claimed.keys()]
    .filter((pointer) => !candidatePaths.has(pointer))
    .sort(compareUtf8);
  if (unresolved.length > 0 || extraClaims.length > 0) {
    fail(
      'PTO_ROUTE_CLOSURE',
      `route inventory is not closed: unresolved=${unresolved.length} extraClaims=${extraClaims.length}`,
      {
        unresolved: unresolved.map((entry) => ({ pointer: entry.pointer, signalFields: entry.signalFields })),
        extraClaims,
      },
    );
  }

  records.sort((left, right) => compareUtf8(left.pointer, right.pointer));
  const reportCore = {
    profile: ROUTE_INVENTORY_PROFILE,
    sourceHeuristicCandidateCount: candidates.length,
    typedRecordCount: records.length,
    classifiedNonRecordCount: nonRecords.length,
    unresolvedCount: unresolved.length,
    extraClaimCount: extraClaims.length,
    recordRoutes: records.map(({ pointer, pointerPattern, typeIri, sourceRecordDigest }) => ({
      pointer,
      pointerPattern,
      typeIri,
      sourceRecordDigest,
    })),
    nonRecordClassifications: nonRecords.map(({ path, reason, sourceObjectDigest }) => ({
      path,
      reason,
      sourceObjectDigest,
    })),
  };
  return Object.freeze({
    ...reportCore,
    records,
    nonRecords,
    inventoryDigest: digest(reportCore),
  });
}

module.exports = {
  NON_RECORD_REASON,
  RECORD_ROUTE_RULES,
  ROUTE_INVENTORY_PROFILE,
  TYPE,
  PostTradeTypedRouteInventoryError,
  collectHeuristicCandidates,
  compilePostTradeTypedRouteInventory,
  digest,
  resolvePointer,
};
