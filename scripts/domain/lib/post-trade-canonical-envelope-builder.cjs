'use strict';

const crypto = require('node:crypto');

const {
  canonicalJcs,
  computeSelectionDigest,
} = require('./strict-source-locator.cjs');
const {
  ROUTE_INVENTORY_PROFILE,
  compilePostTradeTypedRouteInventory,
} = require('./post-trade-typed-route-inventory.cjs');
const {
  effectivePatternInjectedAttributeUses,
} = require('./pattern-injected-fields.cjs');

const TYPED_FIXTURE_PROFILE = 'axiolune-post-trade-canonical-typed-fixture/v1';
const COVERAGE_PROFILE = 'axiolune-post-trade-authored-ontology-coverage/v1';
const PATTERN_BASE = 'https://axiolune.ai/ontology/meta/patterns/attributes/';
const DATA_BINDING_BASE = 'https://axiolune.ai/ontology/meta/data-binding/attributes/';
const PATTERN_ATTRIBUTE = Object.freeze({
  validFrom: `${PATTERN_BASE}validFrom`,
  knowledgeFrom: `${PATTERN_BASE}knowledgeFrom`,
  availableFrom: `${PATTERN_BASE}availableFrom`,
  source: `${PATTERN_BASE}source`,
});
const DEFAULT_INSTANT = '2026-01-01T00:00:00Z';
const DEFAULT_DATE = '2026-01-01';
const DEFAULT_QUANTITY_UNIT = 'https://example.test/unit/share';
const DEFAULT_MONEY_CURRENCY = 'USD';
const MONEY_VALUE_TYPE = 'https://axiolune.ai/ontology/meta/core/values/MonetaryAmount';
const QUANTITY_VALUE_TYPE = 'https://axiolune.ai/ontology/meta/core/values/QuantityValue';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const DECIMAL_RE = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/u;
const CURRENCY_RE = /^[A-Z]{3}$/u;
const ROUNDING_MODES = new Set(['floor', 'ceiling', 'half-up', 'half-even']);
const MANIFEST_FIELDS = new Set([
  'schemaVersion',
  'profile',
  'sourceFixtureRef',
  'sourceFixtureDigest',
  'sourceDocumentDigest',
  'classificationRef',
  'classificationDigest',
  'extractorProfileRef',
  'extractorProfileDigest',
  'expected',
]);
const EXPECTED_FIELDS = new Set([
  'routeInventoryDigest',
  'sourceHeuristicCandidateCount',
  'typedRecordCount',
  'uniqueTypedRecordCount',
  'duplicateRecordOccurrenceCount',
  'classifiedNonRecordCount',
  'unresolvedCount',
  'extraClaimCount',
  'requiredSyntheticDerivationCount',
  'typedDocumentDigest',
  'summaryDigest',
]);

class PostTradeCanonicalEnvelopeError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'PostTradeCanonicalEnvelopeError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PostTradeCanonicalEnvelopeError(code, message, details);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function taggedDigest(tag, value) {
  return sha256(`${tag}\0${canonicalJcs(value)}`);
}

function assertClosed(value, allowed, at, code = 'PTO_TYPED_MANIFEST') {
  if (!isPlainObject(value)) fail(code, `${at} must be a plain object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) fail(code, `${at} contains unknown fields: ${unknown.join(', ')}`);
}

function mergeFinanceOntologyDocuments(documents) {
  if (!Array.isArray(documents) || documents.length === 0) {
    fail('PTO_TYPED_SCHEMA', 'documents must be a non-empty ontology document array');
  }
  const merged = {
    module: {
      moduleIri: 'urn:axiolune:fixture-audit:finance-import-closure',
      version: '0.3.0',
    },
    domain: {
      objectTypes: {},
      associationTypes: {},
      attributeTypes: {},
      codeLists: {},
      constraints: {},
    },
  };
  const iriByBucket = new Map();
  for (const [documentIndex, document] of documents.entries()) {
    if (!isPlainObject(document?.domain)) {
      fail('PTO_TYPED_SCHEMA', `ontology document ${documentIndex} lacks domain`);
    }
    for (const bucket of ['objectTypes', 'associationTypes', 'attributeTypes', 'codeLists', 'constraints']) {
      const byIri = iriByBucket.get(bucket) || new Map();
      iriByBucket.set(bucket, byIri);
      for (const [name, value] of Object.entries(document.domain[bucket] || {})) {
        if (!isPlainObject(value) || typeof value.iri !== 'string') {
          fail('PTO_TYPED_SCHEMA', `ontology document ${documentIndex} has invalid ${bucket}.${name}`);
        }
        const prior = byIri.get(value.iri);
        if (prior) {
          if (canonicalJcs(prior) !== canonicalJcs(value)) {
            fail('PTO_TYPED_SCHEMA', `public IRI ${value.iri} has conflicting definitions`);
          }
          continue;
        }
        byIri.set(value.iri, value);
        let key = name;
        if (Object.hasOwn(merged.domain[bucket], key)) key = `${documentIndex}__${name}`;
        merged.domain[bucket][key] = structuredClone(value);
      }
    }
  }
  return merged;
}

function validateCanonicalTypedFixtureManifest({
  manifestDocument,
  sourceFixtureRef,
  sourceBytes,
  sourceDocument,
  classificationRef,
  classificationBytes,
  extractorProfileRef,
  extractorProfileBytes,
} = {}) {
  assertClosed(manifestDocument, MANIFEST_FIELDS, 'manifest');
  assertClosed(manifestDocument.expected, EXPECTED_FIELDS, 'manifest.expected');
  if (manifestDocument.schemaVersion !== '1.0') fail('PTO_TYPED_MANIFEST', 'schemaVersion must be 1.0');
  if (manifestDocument.profile !== TYPED_FIXTURE_PROFILE) {
    fail('PTO_TYPED_MANIFEST', `profile must be ${TYPED_FIXTURE_PROFILE}`);
  }
  if (!Buffer.isBuffer(sourceBytes) || !Buffer.isBuffer(classificationBytes) || !Buffer.isBuffer(extractorProfileBytes)) {
    fail('PTO_TYPED_MANIFEST', 'all locked artifacts must be supplied as Buffers');
  }
  const checks = [
    ['sourceFixtureRef', manifestDocument.sourceFixtureRef, sourceFixtureRef],
    ['sourceFixtureDigest', manifestDocument.sourceFixtureDigest, sha256(sourceBytes)],
    ['sourceDocumentDigest', manifestDocument.sourceDocumentDigest, sha256(canonicalJcs(sourceDocument))],
    ['classificationRef', manifestDocument.classificationRef, classificationRef],
    ['classificationDigest', manifestDocument.classificationDigest, sha256(classificationBytes)],
    ['extractorProfileDigest', manifestDocument.extractorProfileDigest, sha256(extractorProfileBytes)],
  ];
  for (const [field, actual, expected] of checks) {
    if (actual !== expected) {
      fail(
        'PTO_TYPED_MANIFEST',
        `${field} differs from its locked artifact`,
        { manifestValue: actual, computedValue: expected },
      );
    }
  }
  if (canonicalJcs(manifestDocument.extractorProfileRef) !== canonicalJcs(extractorProfileRef)) {
    fail('PTO_TYPED_MANIFEST', 'extractorProfileRef differs from the executable builder ref');
  }
  for (const digestField of [
    'sourceFixtureDigest',
    'sourceDocumentDigest',
    'classificationDigest',
    'extractorProfileDigest',
    'routeInventoryDigest',
    'typedDocumentDigest',
    'summaryDigest',
  ]) {
    const value = Object.hasOwn(manifestDocument, digestField)
      ? manifestDocument[digestField]
      : manifestDocument.expected[digestField];
    if (!DIGEST_RE.test(value || '')) fail('PTO_TYPED_MANIFEST', `${digestField} is not a canonical digest`);
  }
  for (const field of [
    'sourceHeuristicCandidateCount',
    'typedRecordCount',
    'uniqueTypedRecordCount',
    'duplicateRecordOccurrenceCount',
    'classifiedNonRecordCount',
    'unresolvedCount',
    'extraClaimCount',
    'requiredSyntheticDerivationCount',
  ]) {
    if (!Number.isSafeInteger(manifestDocument.expected[field]) || manifestDocument.expected[field] < 0) {
      fail('PTO_TYPED_MANIFEST', `expected.${field} must be a non-negative safe integer`);
    }
  }
  return true;
}

function assertCanonicalTypedFixtureBuildMatchesManifest(manifestDocument, built) {
  for (const field of EXPECTED_FIELDS) {
    const actual = field === 'routeInventoryDigest'
      ? built.summary.routeInventoryDigest
      : built.summary[field];
    if (actual !== manifestDocument.expected[field]) {
      fail(
        'PTO_TYPED_MANIFEST_BUILD_DRIFT',
        `generated ${field} differs from manifest`,
        { expected: manifestDocument.expected[field], actual },
      );
    }
  }
  return true;
}

function localName(iri) {
  return iri.slice(Math.max(iri.lastIndexOf('/'), iri.lastIndexOf('#')) + 1);
}

function getAt(value, selector) {
  let current = value;
  for (const segment of selector.split('.')) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) return undefined;
      current = current[index];
    } else if (isPlainObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function setAt(value, selector, replacement) {
  const segments = selector.split('.');
  let current = value;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = Array.isArray(current) ? current[Number(segment)] : current[segment];
    if (!isPlainObject(next) && !Array.isArray(next)) {
      fail('PTO_TYPED_ADAPTER_BINDING', `adapter path does not resolve at ${selector}`);
    }
    current = next;
  }
  const finalSegment = segments.at(-1);
  if (
    (Array.isArray(current) && !/^(?:0|[1-9][0-9]*)$/u.test(finalSegment))
    || !Object.hasOwn(current, finalSegment)
  ) {
    fail('PTO_TYPED_ADAPTER_BINDING', `adapter field is absent at ${selector}`);
  }
  current[finalSegment] = structuredClone(replacement);
}

function compileSchema(ontologyDocument, patternDocument) {
  if (!isPlainObject(ontologyDocument?.domain)) {
    fail('PTO_TYPED_SCHEMA', 'ontologyDocument.domain must be a plain object');
  }
  const patterns = patternDocument?.CrossDomainPatterns?.patterns;
  if (!Array.isArray(patterns)) fail('PTO_TYPED_SCHEMA', 'canonical pattern inventory is missing');
  const patternsByIri = new Map(patterns.map((pattern) => [pattern.iri, pattern]));
  const attributeTypesByIri = new Map();
  const codeListsByIri = new Map();
  for (const attribute of Object.values(ontologyDocument.domain.attributeTypes || {})) {
    if (isPlainObject(attribute) && typeof attribute.iri === 'string') {
      attributeTypesByIri.set(attribute.iri, attribute);
    }
  }
  for (const codeList of Object.values(ontologyDocument.domain.codeLists || {})) {
    if (isPlainObject(codeList) && typeof codeList.iri === 'string') codeListsByIri.set(codeList.iri, codeList);
  }

  function patternClosure(patternIri, visiting = new Set(), visited = new Set(), result = []) {
    if (visited.has(patternIri)) return result;
    if (visiting.has(patternIri)) fail('PTO_TYPED_SCHEMA', `cyclic pattern dependency ${patternIri}`);
    const pattern = patternsByIri.get(patternIri);
    if (!pattern) fail('PTO_TYPED_SCHEMA', `unresolved pattern ${patternIri}`);
    visiting.add(patternIri);
    for (const dependency of pattern.dependencies || []) {
      patternClosure(dependency, visiting, visited, result);
    }
    visiting.delete(patternIri);
    visited.add(patternIri);
    result.push(pattern);
    return result;
  }

  const typesByIri = new Map();
  for (const [bucketName, typeKind] of [['objectTypes', 'ObjectType'], ['associationTypes', 'AssociationType']]) {
    for (const [name, type] of Object.entries(ontologyDocument.domain[bucketName] || {})) {
      const attributes = new Map();
      for (const use of type.attributeUses || []) {
        attributes.set(use.attribute, {
          iri: use.attribute,
          localName: localName(use.attribute),
          minCount: use.minCount ?? 0,
          maxCount: Object.hasOwn(use, 'maxCount') ? use.maxCount : null,
          origin: 'authored',
        });
      }
      for (const binding of type.patternBindings || []) {
        for (const pattern of patternClosure(binding.pattern)) {
          for (const injection of pattern.injectedAttributes || []) {
            const existing = attributes.get(injection.attribute);
            attributes.set(injection.attribute, {
              iri: injection.attribute,
              localName: localName(injection.attribute),
              minCount: Math.max(existing?.minCount || 0, injection.minCount ?? 0),
              maxCount: Object.hasOwn(injection, 'maxCount') ? injection.maxCount : existing?.maxCount ?? null,
              origin: existing ? 'authored+pattern' : 'pattern',
            });
          }
        }
      }
      // The canonical M3 pattern document remains the vocabulary/dependency
      // source, while RFC-001 section 5.8 tightens the effective finance
      // profile for concrete FactVersion records. In particular, the raw M3
      // ProvenancedFact definition declares revision 0..1, but every
      // materialized finance type requires it exactly once. Keep adapters on
      // the same effective profile as the OWL/SHACL projectors and validators
      // so optional raw M3 cardinality cannot silently omit a version key.
      for (const injection of effectivePatternInjectedAttributeUses(type)) {
        const existing = attributes.get(injection.attribute);
        attributes.set(injection.attribute, {
          iri: injection.attribute,
          localName: localName(injection.attribute),
          minCount: Math.max(existing?.minCount || 0, injection.minCount ?? 0),
          maxCount: Object.hasOwn(injection, 'maxCount')
            ? injection.maxCount
            : existing?.maxCount ?? null,
          origin: existing ? `${existing.origin}+effective-finance-profile` : 'effective-finance-profile',
        });
      }
      const roles = (type.participantRoles || []).map((role) => ({
        ...role,
        targetIri: `${type.iri}/role/${role.id}`,
      }));
      typesByIri.set(type.iri, {
        iri: type.iri,
        localName: type.localName || name,
        typeKind,
        attributes: [...attributes.values()].sort((left, right) => compareUtf8(left.iri, right.iri)),
        roles: roles.sort((left, right) => compareUtf8(left.id, right.id)),
      });
    }
  }
  const xoneConstraintsByTypeIri = new Map();
  for (const [name, constraint] of Object.entries(ontologyDocument.domain.constraints || {})) {
    const expression = constraint?.expression?.expression;
    if (constraint?.expression?.language !== 'SHACL' || typeof expression !== 'string') continue;
    const match = /^sh:xone\(([A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)+)\)$/u.exec(expression);
    if (!match || typeof constraint.targetElement !== 'string') continue;
    const type = typesByIri.get(constraint.targetElement);
    if (!type) fail('PTO_TYPED_SCHEMA', `${name} targets unknown xone type ${constraint.targetElement}`);
    const attributeByLocal = new Map(type.attributes.map((field) => [field.localName, field.iri]));
    const roleById = new Map(type.roles.map((role) => [role.id, role.targetIri]));
    const branches = [];
    let supported = true;
    for (const branch of match[1].split(',')) {
      if (attributeByLocal.has(branch)) {
        branches.push({ localName: branch, container: 'attribute', propertyIri: attributeByLocal.get(branch) });
      } else if (roleById.has(branch)) {
        branches.push({ localName: branch, container: 'role', propertyIri: roleById.get(branch) });
      } else {
        // Some repository-wide xone constraints address relationUses, which are
        // outside this fixture envelope's attributes/roles representation.
        supported = false;
        break;
      }
    }
    if (!supported) continue;
    const rows = xoneConstraintsByTypeIri.get(type.iri) || [];
    rows.push({ name, iri: constraint.iri, branches });
    xoneConstraintsByTypeIri.set(type.iri, rows);
  }
  return {
    attributeTypesByIri,
    codeListsByIri,
    typesByIri,
    xoneConstraintsByTypeIri,
  };
}

const GLOBAL_ATTRIBUTE_SELECTORS = Object.freeze({
  sourceEventId: ['sourceEventId', 'versionIri'],
  corporateActionKind: ['kind', 'eventKind'],
  announcementDate: ['announcementDate', 'dates.announcement'],
  exDate: ['exDate', 'dates.ex'],
  recordDate: ['recordDate', 'dates.record'],
  paymentDate: ['paymentDate', 'dates.payment'],
  effectiveDate: ['effectiveDate', 'dates.effective'],
  electionDeadline: ['electionDeadline', 'dates.electionDeadline'],
  priceValue: ['priceValue', 'price'],
  providerObservationId: ['providerObservationId', 'versionIri'],
  sourceOrderKey: ['sourceOrderKey'],
  distributionAssessmentInputKind: ['distributionAssessmentInputKind', 'inputKind'],
  distributionAssessmentPriceSelection: ['distributionAssessmentPriceSelection', 'priceSelection'],
  distributionAssessmentRequiresMarketPrice: ['distributionAssessmentRequiresMarketPrice', 'requiresMarketPrice'],
  distributionAssessmentRequiredPriceKindIri: ['distributionAssessmentRequiredPriceKindIri', 'requiredPriceKind'],
  distributionAssessmentPrecision: ['distributionAssessmentPrecision', 'precision'],
  distributionAssessmentRoundingMode: ['distributionAssessmentRoundingMode', 'roundingMode'],
  distributionAssessmentFormulaDigest: ['distributionAssessmentFormulaDigest', 'formulaDigest'],
  distributionAssessmentImplementationDigest: ['distributionAssessmentImplementationDigest', 'implementationDigest'],
  assessmentInputVersionRef: ['assessmentInputVersionRef', 'inputVersionIris'],
  assessmentInputVersionCount: ['assessmentInputVersionCount', 'inputVersionCount'],
  assessmentInputVersionSetDigest: ['assessmentInputVersionSetDigest', 'inputVersionSetDigest'],
  applicabilityPriority: ['applicabilityPriority', 'priority'],
  ruleEvaluationRequestId: ['ruleEvaluationRequestId', 'versionIri'],
  obligationQuantity: ['obligationQuantity', 'quantity'],
  obligationMoney: ['obligationMoney', 'benefit'],
  obligationQuantityBenefit: ['obligationQuantityBenefit', 'benefit'],
  qualifiedDueBillQuantity: ['qualifiedDueBillQuantity', 'qualifiedQuantity'],
  qualificationResult: ['qualificationResult', 'result'],
  transferTime: ['transferTime', 'occurrenceTime'],
  transferState: ['transferState', 'state'],
  transferMoney: ['transferMoney', 'asset'],
  transferQuantity: ['transferQuantity', 'asset'],
  movementEvidenceRef: ['movementEvidenceRef', 'movementEvidenceIri'],
  fulfillmentOccurrenceTime: ['fulfillmentOccurrenceTime', 'occurrenceTime'],
  subscriptionFulfillmentAssetKind: ['subscriptionFulfillmentAssetKind', 'assetKind'],
  settlementMethod: ['settlementMethod', 'method'],
  settlementStatus: ['settlementStatus', 'state'],
  reconciliationStatus: ['reconciliationStatus', 'state', 'currentStatus'],
  providerEventId: ['providerEventId', 'versionIri'],
  normalizedProviderKey: ['normalizedProviderKey', 'sourceProviderKey'],
  sourceProviderKey: ['sourceProviderKey'],
  electedQuantity: ['electedQuantity', 'maximumRightsQuantity'],
  electionDecision: ['electionDecision', 'decision'],
  subscriptionCash: ['subscriptionCash', 'cashAmount'],
  fulfilledSubscriptionCash: ['fulfilledSubscriptionCash', 'fulfilledCashAmount'],
  fulfilledSubscriptionSecurity: ['fulfilledSubscriptionSecurity', 'fulfilledSecurityQuantity'],
  subscriptionFulfillmentCount: ['subscriptionFulfillmentCount', 'fulfillmentCount'],
  subscriptionFulfillmentSetDigest: ['subscriptionFulfillmentSetDigest', 'fulfillmentSetDigest'],
  subscriptionClosureProbeRef: ['subscriptionClosureProbeRef', 'closureProbe.ref'],
  subscriptionClosureProbeDigest: ['subscriptionClosureProbeDigest', 'closureProbe.digest'],
  transferCount: ['transferCount'],
  transferVersionSetDigest: ['transferVersionSetDigest', 'transferSetDigest'],
  transferClosureProbeRef: ['transferClosureProbeRef', 'closureProbe.ref'],
  transferClosureProbeDigest: ['transferClosureProbeDigest', 'closureProbe.digest'],
  fulfillmentResult: ['fulfillmentResult', 'result'],
  allocatedQuantity: ['allocatedQuantity', 'quantity'],
  settlementSystem: ['settlementSystem', 'system'],
  settlementLocation: ['settlementLocation', 'location'],
  settlementLegMoney: ['settlementLegMoney', 'asset'],
  settlementLegQuantity: ['settlementLegQuantity', 'asset'],
  entryDirection: ['entryDirection', 'direction'],
  projectedMoney: ['projectedMoney', 'value'],
  projectedQuantity: ['projectedQuantity', 'value'],
  statementLineMoney: ['statementLineMoney', 'value'],
  statementLineQuantity: ['statementLineQuantity', 'value'],
  statusAtomicGroupId: ['statusAtomicGroupId', 'atomicGroupId'],
  findingKind: ['findingKind', 'kind'],
  mismatchDimension: ['mismatchDimension', 'mismatchDimensions'],
  internalMismatchDimension: ['internalMismatchDimension', 'internalMismatchDimensions'],
  externalMismatchDimension: ['externalMismatchDimension', 'externalMismatchDimensions'],
  crossMismatchDimension: ['crossMismatchDimension', 'crossMismatchDimensions'],
  expectedSide: ['expectedSide'],
  comparisonQuantityUnit: ['comparisonQuantityUnit'],
  observedAt: ['observedAt', 'occurrenceTime', 'receivedAt'],
});

const TYPE_ATTRIBUTE_SELECTORS = Object.freeze({
  CorporateActionDistributionSizeAssessment: {
    generatingContextRef: ['generatingContextRef', 'pitContext.versionIri'],
  },
  CorporateActionElectionProviderPolicy: {
    electionEquivalenceField: ['electionEquivalenceFieldIris'],
  },
  CorporateActionAdjustment: {
    adjustmentMovementEvidenceRef: ['movementEvidenceIris'],
  },
  CorporateActionDueBillTransferFulfillmentClosure: {
    fulfilledQuantity: ['fulfilledAmount'],
    remainingQuantity: ['remainingAmount'],
  },
  CorporateActionSubscriptionFulfillment: {
    fulfilledSubscriptionMoney: ['amount'],
    fulfilledSubscriptionQuantity: ['amount'],
  },
  TradeSettlementAllocation: {
    fromDirectAccount: ['fromMode'],
    toDirectAccount: ['toMode'],
  },
  ReconciliationCase: {
    allocationVersionSetDigest: ['allocationVersionSetDigest'],
  },
});

const ROLE_SELECTORS = Object.freeze({
  sourceAuthority: ['sourceAuthorityVersionIri', 'sourceAuthorityLogicalIri'],
  affectedSecurity: ['affectedSecurityIri', 'affectedSecurityLogicalIri'],
  affectedListing: ['listingVersionIri', 'affectedListingVersionIri'],
  successorSecurity: ['successorSecurityIri'],
  evaluationEvent: ['eventVersionIri'],
  evaluationRequest: ['requestVersionIri', 'pitContext.versionIri'],
  applicableRuleVersion: ['scheduleRuleVersionIri'],
  observationStream: ['streamVersionIri'],
  observedInstrument: ['observedSecurityLogicalIri', 'instrumentIri'],
  observedListing: ['listingVersionIri'],
  quotationContract: ['quotationContractVersionIri'],
  assessmentEvaluationInput: ['evaluationInputVersionIri'],
  assessmentEvent: ['eventVersionIri'],
  candidateApplicability: ['applicabilityVersionIri'],
  candidateScheduleRule: ['scheduleRuleVersionIri'],
  assessmentMethod: ['methodVersionIri', 'assessmentMethodVersionIri'],
  assessmentPriceObservation: ['priceObservation.versionIri'],
  resolutionEvent: ['eventVersionIri'],
  resolutionEvaluationInput: ['evaluationInputVersionIri'],
  resolutionRequest: ['requestVersionIri'],
  winningApplicability: ['applicabilityVersionIri'],
  scheduleRule: ['scheduleRuleVersionIri'],
  distributionAssessment: ['assessmentVersionIri'],
  qualificationEvent: ['eventVersionIri'],
  qualificationScheduleResolution: ['resolutionVersionIri', 'scheduleResolutionVersionIri'],
  qualificationExecution: ['execution.versionIri', 'executionVersionIri'],
  qualificationAllocation: ['allocation.versionIri', 'allocationVersionIri'],
  qualificationSecurityLeg: ['securityLeg.versionIri', 'securityLegVersionIri'],
  qualificationLiableParty: ['liableParty'],
  qualificationBeneficiaryParty: ['beneficiaryParty'],
  qualificationLiableAccountPartyRole: ['liableAccountPartyRoles.0.versionIri'],
  qualificationBeneficiaryAccountPartyRole: ['beneficiaryAccountPartyRoles.0.versionIri'],
  qualificationSettlementStatusEvent: ['settlementStatusEvent.versionIri'],
  roleAccount: ['account'],
  roleParty: ['party'],
  allocationExecution: ['execution.versionIri', 'executionVersionIri'],
  allocationInstruction: ['instructionVersionIri'],
  allocationSecurityLeg: ['securityLegVersionIri'],
  fromEconomicAccount: ['fromEconomicAccount'],
  toEconomicAccount: ['toEconomicAccount'],
  fromAccountBridge: ['fromBridgeVersionIri'],
  toAccountBridge: ['toBridgeVersionIri'],
  instructionAuthority: ['instructionAuthorityVersionIri', 'instructionAuthorityLogicalIri'],
  securitiesDeliverer: ['securitiesDeliverer'],
  securitiesReceiver: ['securitiesReceiver'],
  settlementCalendar: ['calendarVersionIri'],
  instructionLeg: ['legs'],
  legInstruction: ['instructionVersionIri'],
  legFromParty: ['fromParty'],
  legToParty: ['toParty'],
  legFromAccount: ['fromAccount'],
  legToAccount: ['toAccount'],
  legInstrument: ['asset.instrumentIri', 'asset.securityIri', 'instrumentIri'],
  statusInstruction: ['instructionVersionIri'],
  statusAuthority: ['authorityVersionIri', 'sourceAuthorityVersionIri'],
  statusLeg: ['legVersionIri'],
  executionAccount: ['account'],
  executionInstrument: ['instrumentIri'],
  bridgeAuthority: ['authorityVersionIri'],
  economicAccount: ['economicAccount'],
  settlementAccount: ['settlementAccount'],
  economicParty: ['economicParty'],
  custodianParty: ['custodianParty'],
  obligationEvent: ['eventVersionIri'],
  obligationScheduleResolution: ['resolutionVersionIri', 'scheduleResolutionVersionIri'],
  liableAccount: ['liableAccount'],
  beneficiaryAccount: ['beneficiaryAccount'],
  liableParty: ['liableParty'],
  beneficiaryParty: ['beneficiaryParty'],
  liableAccountPartyRole: ['liableAccountPartyRoles.0.versionIri'],
  beneficiaryAccountPartyRole: ['beneficiaryAccountPartyRoles.0.versionIri'],
  obligationSecurity: ['obligationSecurityIri'],
  tradeQualification: ['tradeQualificationVersionIri'],
  claimAuthority: ['claimAuthorityVersionIri'],
  transferAuthority: ['transferAuthorityVersionIri', 'authorityVersionIri'],
  transferObligation: ['obligationVersionIri'],
  transferFromAccount: ['fromAccount'],
  transferToAccount: ['toAccount'],
  transferFromParty: ['fromParty'],
  transferToParty: ['toParty'],
  closureObligation: ['obligationVersionIri'],
  closureTransfer: ['transferVersionIris'],
  entitlementEvent: ['eventVersionIri'],
  entitlementScheduleResolution: ['scheduleResolutionVersionIri'],
  beneficiaryParty: ['entitledPartyVersionIri', 'beneficiaryParty'],
  memberPolicy: ['policyVersionIri'],
  eligibleProvider: ['providerLogicalIri'],
  normalizationPolicy: ['policyVersionIri'],
  normalizedProvider: ['normalizedProviderLogicalIri'],
  precedencePolicy: ['policyVersionIri'],
  higherPriorityProvider: ['higherProviderLogicalIri'],
  lowerPriorityProvider: ['lowerProviderLogicalIri'],
  electionProvider: ['providerVersionIri', 'providerLogicalIri'],
  electionEntitlement: ['entitlementVersionIri'],
  electionEvent: ['eventVersionIri'],
  electingParty: ['electingPartyVersionIri'],
  authorizationAccountPartyRole: ['authorizationAccountPartyRole.versionIri'],
  resolutionEntitlement: ['entitlementVersionIri'],
  providerPolicy: ['providerPolicyVersionIri'],
  candidateElection: ['candidateVersionIris'],
  selectedElection: ['selectedElectionVersionIri'],
  subscriptionResolution: ['electionResolutionVersionIri'],
  subscriptionElection: ['selectedElectionVersionIri'],
  subscriptionEntitlement: ['entitlementVersionIri'],
  subscriptionEvent: ['eventVersionIri'],
  subscriptionScheduleResolution: ['scheduleResolutionVersionIri'],
  subscriptionSuccessorSecurity: ['successorSecurityIri'],
  subscriberSecuritiesAccount: ['subscriberSecuritiesAccount'],
  subscriberCashAccount: ['subscriberCashAccount'],
  subscriptionAgent: ['agentPartyVersionIri'],
  subscriptionAgentCashAccount: ['agentCashAccount'],
  subscriptionAgentSecuritiesAccount: ['agentSecuritiesAccount'],
  fulfillmentAuthority: ['authorityVersionIri'],
  subscriptionObligation: ['subscriptionObligationVersionIri', 'obligationVersionIri'],
  fulfillmentFromAccount: ['fromAccount'],
  fulfillmentToAccount: ['toAccount'],
  fulfillmentFromParty: ['fromParty'],
  fulfillmentToParty: ['toParty'],
  subscriptionClosureObligation: ['obligationVersionIri'],
  subscriptionClosureFulfillment: ['fulfillmentVersionIris'],
  adjustmentEvent: ['eventVersionIri'],
  adjustmentScheduleResolution: ['scheduleResolutionVersionIri'],
  adjustmentEntitlement: ['entitlementVersionIri'],
  beneficiarySecuritiesAccount: ['securitiesAccount'],
  cashComponentAccount: ['cashAccount'],
  quantityComponentAccount: ['securitiesAccount'],
  adjustmentElectionResolution: ['electionResolutionVersionIri'],
  adjustmentSelectedElection: ['selectedElectionVersionIri'],
  adjustmentSubscriptionObligation: ['subscriptionObligationVersionIri'],
  adjustmentSubscriptionClosure: ['fulfillmentClosureVersionIri'],
  caseOwner: ['caseOwnerVersionIri'],
  internalSourceAuthority: ['internalSourceAuthorityVersionIri'],
  externalStatement: ['externalStatementVersionIri'],
  caseFocalAccount: ['focalAccount'],
  caseComparator: ['comparatorVersionIri'],
  caseAllocation: ['allocationVersionIris'],
  lineStatement: ['statementVersionIri'],
  lineFocalAccount: ['focalAccount'],
  lineInstrument: ['lineInstrumentIri'],
  projectionCase: ['caseVersionIri'],
  projectionComparator: ['comparatorVersionIri'],
  projectionFocalAccount: ['focalAccount'],
  projectionLeg: ['legVersionIri'],
  projectionAllocation: ['allocationVersionIris'],
  projectionBridge: ['bridgeVersionIris'],
  projectionInstrument: ['projectionInstrumentIri'],
  missingCase: ['caseVersionIri'],
  missingComparator: ['comparatorVersionIri'],
  comparisonInstrument: ['comparisonInstrumentIri'],
  findingCase: ['caseVersionIri'],
  internalProjection: ['internalProjectionVersionIris'],
  externalStatementLine: ['externalStatementLineVersionIris'],
  missingSideAssertion: ['missingSideAssertionVersionIri'],
  statusCase: ['caseVersionIri'],
  statusSourceAuthority: ['sourceAuthorityVersionIri'],
});

function selectorsForAttribute(typeLocalName, attributeLocalName) {
  return [
    ...(TYPE_ATTRIBUTE_SELECTORS[typeLocalName]?.[attributeLocalName] || []),
    ...(GLOBAL_ATTRIBUTE_SELECTORS[attributeLocalName] || []),
    attributeLocalName,
  ].filter((selector, index, all) => all.indexOf(selector) === index);
}

function selectValue(raw, selectors) {
  for (const selector of selectors) {
    const value = getAt(raw, selector);
    if (value !== undefined && value !== null) return { value, selector };
  }
  return null;
}

function normalizeRoleValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (isPlainObject(item) && typeof item.versionIri === 'string') return item.versionIri;
      return null;
    }).filter(Boolean);
  }
  if (typeof value === 'string') return value;
  if (isPlainObject(value) && typeof value.versionIri === 'string') return value.versionIri;
  return undefined;
}

function canonicalCodeValue(value, attributeType, codeListsByIri) {
  const codeList = codeListsByIri.get(attributeType?.valueType);
  if (!codeList) return null;
  const canonicalizeOne = (candidate) => {
    const exact = (codeList.values || []).find(
      (item) => item.iri === candidate || item.notation === candidate,
    );
    return exact?.iri || null;
  };
  if (Array.isArray(value)) {
    const canonical = value.map(canonicalizeOne);
    if (canonical.length === 0 || canonical.some((item) => item === null)) {
      fail(
        'PTO_TYPED_CANONICAL_SOURCE',
        `${attributeType.localName} contains a value outside ${codeList.iri}`,
      );
    }
    return { value: canonical, transform: 'codeNotation' };
  }
  const canonical = canonicalizeOne(value);
  if (!canonical) {
    fail(
      'PTO_TYPED_CANONICAL_SOURCE',
      `${attributeType.localName} contains a value outside ${codeList.iri}`,
    );
  }
  return { value: canonical, transform: 'codeNotation' };
}

function decimalLexical(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    value = String(value);
  }
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) return null;
  return value;
}

function decimalPlaces(value) {
  const unsigned = String(value).replace(/^[+-]/u, '');
  const dot = unsigned.indexOf('.');
  return dot < 0 ? 0 : unsigned.length - dot - 1;
}

function inferQuantityUnit(raw) {
  const candidates = [
    raw?.unit,
    raw?.quantity?.unit,
    raw?.benefit?.unit,
    raw?.asset?.unit,
    raw?.value?.unit,
    raw?.allocation?.quantity?.unit,
    raw?.recordPosition?.unit,
  ];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.length > 0)
    || DEFAULT_QUANTITY_UNIT;
}

function inferMoneyCurrency(raw) {
  const candidates = [
    raw?.currency,
    raw?.money?.currency,
    raw?.benefit?.currency,
    raw?.asset?.currency,
    raw?.value?.currency,
    raw?.subscriptionPrice?.currency,
    raw?.cashPerUnit?.currency,
  ];
  return candidates.find((candidate) => typeof candidate === 'string' && CURRENCY_RE.test(candidate))
    || DEFAULT_MONEY_CURRENCY;
}

function canonicalQuantityValue(value, raw) {
  if (isPlainObject(value)) {
    if (value.kind === 'money' || (Object.hasOwn(value, 'currency') && !Object.hasOwn(value, 'unit'))) {
      return null;
    }
    const lexical = decimalLexical(value.value ?? value.amount);
    if (lexical === null) {
      fail('PTO_TYPED_CANONICAL_SOURCE', 'legacy QuantityValue has no valid decimal value/amount');
    }
    const unit = typeof value.unit === 'string' && value.unit.length > 0
      ? value.unit
      : inferQuantityUnit(raw);
    const canonical = {
      value: lexical,
      unit,
      precision: Number.isInteger(value.precision) && value.precision >= 0
        ? value.precision
        : decimalPlaces(lexical),
    };
    if (value.rounding !== undefined) {
      if (!ROUNDING_MODES.has(value.rounding)) {
        fail('PTO_TYPED_CANONICAL_SOURCE', 'legacy QuantityValue has an invalid rounding mode');
      }
      canonical.rounding = value.rounding;
    }
    return {
      value: canonical,
      transform: 'quantityObject',
      legacyTemplate: structuredClone(value),
    };
  }
  if (raw?.assetKind === 'cashPayment') return null;
  const lexical = decimalLexical(value);
  if (lexical === null) {
    fail('PTO_TYPED_CANONICAL_SOURCE', 'legacy QuantityValue scalar is not a decimal');
  }
  return {
    value: {
      value: lexical,
      unit: inferQuantityUnit(raw),
      precision: decimalPlaces(lexical),
    },
    transform: 'quantityScalar',
  };
}

function canonicalMoneyValue(value, raw) {
  if (isPlainObject(value)) {
    if (value.kind === 'quantity' || value.kind === 'security'
        || (Object.hasOwn(value, 'unit') && !Object.hasOwn(value, 'currency'))) {
      return null;
    }
    const amount = decimalLexical(value.amount);
    if (amount === null || typeof value.currency !== 'string' || !CURRENCY_RE.test(value.currency)) {
      fail('PTO_TYPED_CANONICAL_SOURCE', 'legacy MonetaryAmount has an invalid amount or currency');
    }
    const canonical = { amount, currency: value.currency };
    if (value.scale !== undefined) {
      if (!Number.isInteger(value.scale) || value.scale < 0) {
        fail('PTO_TYPED_CANONICAL_SOURCE', 'legacy MonetaryAmount scale must be non-negative');
      }
      canonical.scale = value.scale;
    }
    const exactCanonicalKeys = Object.keys(value).every(
      (key) => key === 'amount' || key === 'currency' || key === 'scale',
    );
    return exactCanonicalKeys
      ? { value: canonical, transform: 'identity' }
      : {
        value: canonical,
        transform: 'moneyObject',
        legacyTemplate: structuredClone(value),
      };
  }
  if (raw?.assetKind === 'securityDelivery') return null;
  const amount = decimalLexical(value);
  if (amount === null) {
    fail('PTO_TYPED_CANONICAL_SOURCE', 'legacy MonetaryAmount scalar is not a decimal');
  }
  return {
    value: { amount, currency: inferMoneyCurrency(raw) },
    transform: 'moneyScalar',
  };
}

function canonicalPrimitiveValue(value, valueType) {
  const recognized = new Set([
    'string',
    'decimal',
    'integer',
    'nonNegativeInteger',
    'positiveInteger',
    'boolean',
    'date',
    'instant',
    'dateTime',
    'uri',
    'iri',
    'digest',
  ]);
  if (!recognized.has(valueType)) return { recognized: false };
  const validateOne = (candidate) => {
    if (valueType === 'string') return typeof candidate === 'string';
    if (valueType === 'decimal') return typeof candidate === 'string' && DECIMAL_RE.test(candidate);
    if (valueType === 'integer') return Number.isSafeInteger(candidate);
    if (valueType === 'nonNegativeInteger') return Number.isSafeInteger(candidate) && candidate >= 0;
    if (valueType === 'positiveInteger') return Number.isSafeInteger(candidate) && candidate > 0;
    if (valueType === 'boolean') return typeof candidate === 'boolean';
    if (valueType === 'date') {
      return typeof candidate === 'string'
        && /^\d{4}-\d{2}-\d{2}$/u.test(candidate)
        && !Number.isNaN(Date.parse(`${candidate}T00:00:00Z`));
    }
    if (valueType === 'instant' || valueType === 'dateTime') {
      return typeof candidate === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(candidate)
        && !Number.isNaN(Date.parse(candidate));
    }
    if (valueType === 'uri' || valueType === 'iri') {
      return typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(candidate);
    }
    return typeof candidate === 'string' && DIGEST_RE.test(candidate);
  };
  const valid = Array.isArray(value) ? value.every(validateOne) : validateOne(value);
  return valid
    ? { recognized: true, value: structuredClone(value), transform: 'identity' }
    : { recognized: true, value: null };
}

function canonicalAttributeValue(value, attributeType, context, raw) {
  const coded = canonicalCodeValue(value, attributeType, context.schema.codeListsByIri);
  if (coded) return coded;
  if (attributeType?.valueType === QUANTITY_VALUE_TYPE) {
    return canonicalQuantityValue(value, raw);
  }
  if (attributeType?.valueType === MONEY_VALUE_TYPE) {
    return canonicalMoneyValue(value, raw);
  }
  if (
    attributeType?.valueType === 'boolean'
    && (attributeType.localName === 'fromDirectAccount' || attributeType.localName === 'toDirectAccount')
    && typeof value === 'string'
  ) {
    return value === 'directAccount'
      ? { value: true, transform: 'branchMarker', legacyTemplate: value }
      : null;
  }
  if (attributeType?.valueType === 'ArtifactRef' || attributeType?.iri === `${DATA_BINDING_BASE}sourceArtifactRef`) {
    if (isPlainObject(value)) return { value, transform: 'identity' };
    if (typeof value === 'string') return { value: { kind: 'iri', iri: value }, transform: 'artifactRefIri' };
    fail('PTO_TYPED_CANONICAL_SOURCE', 'sourceArtifactRef is not a supported legacy or canonical branch');
  }
  if (attributeType?.valueType === 'SourceLocator' || attributeType?.iri === `${DATA_BINDING_BASE}sourceLocator`) {
    if (isPlainObject(value)) return { value, transform: 'identity' };
    return null;
  }
  const primitive = canonicalPrimitiveValue(value, attributeType?.valueType);
  if (primitive.recognized) {
    if (primitive.value === null) {
      fail(
        'PTO_TYPED_CANONICAL_SOURCE',
        `${attributeType.localName} does not satisfy ${attributeType.valueType}`,
      );
    }
    return primitive;
  }
  return { value, transform: 'identity' };
}

function deriveAttribute(descriptor, type, recordIri, raw, context) {
  const attributeType = context.schema.attributeTypesByIri.get(descriptor.iri);
  const codeList = context.schema.codeListsByIri.get(attributeType?.valueType);
  const seed = `${recordIri}\0${descriptor.iri}`;
  const local = descriptor.localName;
  if (descriptor.iri === PATTERN_ATTRIBUTE.validFrom) {
    return raw.validFrom || raw.observedAt || raw.occurrenceTime || DEFAULT_INSTANT;
  }
  if (descriptor.iri === PATTERN_ATTRIBUTE.knowledgeFrom) {
    return raw.knowledgeFrom || raw.validFrom || raw.observedAt || raw.occurrenceTime || DEFAULT_INSTANT;
  }
  if (descriptor.iri === PATTERN_ATTRIBUTE.availableFrom) {
    return raw.availableFrom || raw.knowledgeFrom || raw.validFrom || raw.observedAt || raw.occurrenceTime || DEFAULT_INSTANT;
  }
  if (descriptor.iri === PATTERN_ATTRIBUTE.source) return 'https://example.test/source/post-trade-typed-fixture';
  if (descriptor.iri === `${DATA_BINDING_BASE}sourceArtifactRef`) return context.sourceArtifactRef;
  if (descriptor.iri === `${DATA_BINDING_BASE}sourceArtifactDigest`) return context.sourceFixtureDigest;
  if (descriptor.iri === `${DATA_BINDING_BASE}sourceLocator`) return context.sourceLocator;
  if (codeList?.values?.length > 0) return codeList.values[0].iri;
  const valueType = attributeType?.valueType || '';
  if (valueType === MONEY_VALUE_TYPE) return { amount: '0', currency: DEFAULT_MONEY_CURRENCY };
  if (valueType === QUANTITY_VALUE_TYPE) {
    return {
      value: '0',
      unit: DEFAULT_QUANTITY_UNIT,
      precision: 0,
    };
  }
  if (valueType === 'date' || /Date$/u.test(local)) return DEFAULT_DATE;
  if (valueType === 'dateTime' || /(At|From|To|Cutoff|Pivot|Time)$/u.test(local)) return DEFAULT_INSTANT;
  if (valueType === 'boolean' || /^(?:has|is|requires|deadlineInclusive|selfElection|selectedExercise|selectedDecline|defaultLapse)/u.test(local)) return false;
  if (['integer', 'nonNegativeInteger', 'positiveInteger'].includes(valueType) || /(Count|Precision|Order|Priority|Scale|revision)$/u.test(local)) return valueType === 'positiveInteger' ? 1 : 0;
  if (valueType === 'decimal' || /(Ratio|Percentage|Tolerance|Bound|Quantity)$/u.test(local)) return '0';
  if (/Digest$/u.test(local) || valueType === 'digest') return sha256(`axiolune-typed-fixture-derived-v1\0${seed}`);
  if (/Money$/u.test(local)) return { amount: '0', currency: 'USD' };
  if (valueType === 'uri' || valueType === 'iri' || /(Ref|Iri)$/u.test(local)) {
    return `https://example.test/fixture/value/${sha256(seed).slice(-24)}`;
  }
  return `fixture-derived-${type.localName}-${local}-${sha256(seed).slice(-12)}`;
}

function deriveRole(role, type, recordIri) {
  return `https://example.test/fixture/role-target/${encodeURIComponent(type.localName)}/${encodeURIComponent(role.id)}/${sha256(recordIri).slice(-16)}`;
}

function valuePresent(value) {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
}

function addSemanticBranchDerivations(type, raw, recordIri, attributes, roles, derivations) {
  const attributeByLocal = new Map(type.attributes.map((field) => [field.localName, field]));
  const roleById = new Map(type.roles.map((role) => [role.id, role]));
  const putAttribute = (localName, value) => {
    const field = attributeByLocal.get(localName);
    if (!field || valuePresent(attributes[field.iri])) return;
    attributes[field.iri] = structuredClone(value);
    derivations.push({ kind: 'semanticBranchAttribute', propertyIri: field.iri });
  };
  const putRole = (roleId) => {
    const role = roleById.get(roleId);
    if (!role || valuePresent(roles[role.targetIri])) return;
    roles[role.targetIri] = deriveRole(role, type, recordIri);
    derivations.push({ kind: 'semanticBranchRole', propertyIri: role.targetIri });
  };

  // These legacy records prove the surrounding business scenario but omit the
  // explicit branch node required by the authored ontology. Keep the resulting
  // enrichment deterministic, counted, and non-release diagnostic evidence.
  if (type.localName === 'Execution') {
    const listing = roleById.get('executionListing')?.targetIri;
    const otc = roleById.get('executionOtcContext')?.targetIri;
    if (!valuePresent(roles[listing]) && !valuePresent(roles[otc])) putRole('executionListing');
  }
  if (type.localName === 'CorporateActionEvent' && raw.kind === 'stockSplit') {
    putAttribute('splitRatio', '1');
  }
  if (type.localName === 'CorporateActionEntitlement') {
    const evidenceRoles = ['recordHoldingSnapshot', 'recordPositionSnapshot', 'recordPositionAbsence'];
    if (evidenceRoles.every((id) => !valuePresent(roles[roleById.get(id)?.targetIri]))) {
      putRole('recordPositionSnapshot');
    }
  }
}

function assertCanonicalStructuredValue(value, valueType, at) {
  const rows = Array.isArray(value) ? value : [value];
  for (const [index, row] of rows.entries()) {
    const rowAt = Array.isArray(value) ? `${at}[${index}]` : at;
    if (!isPlainObject(row)) fail('PTO_TYPED_CANONICAL_VALUE', `${rowAt} must be a plain object`);
    if (valueType === MONEY_VALUE_TYPE) {
      const unknown = Object.keys(row).filter((key) => !['amount', 'currency', 'scale'].includes(key));
      if (unknown.length > 0 || decimalLexical(row.amount) === null || !CURRENCY_RE.test(row.currency || '')
          || (row.scale !== undefined && (!Number.isInteger(row.scale) || row.scale < 0))) {
        fail('PTO_TYPED_CANONICAL_VALUE', `${rowAt} is not a canonical MonetaryAmount`);
      }
    } else {
      const unknown = Object.keys(row).filter(
        (key) => !['value', 'unit', 'precision', 'rounding'].includes(key),
      );
      if (unknown.length > 0 || decimalLexical(row.value) === null
          || typeof row.unit !== 'string' || row.unit.length === 0
          || (row.precision !== undefined && (!Number.isInteger(row.precision) || row.precision < 0))
          || (row.rounding !== undefined && !ROUNDING_MODES.has(row.rounding))) {
        fail('PTO_TYPED_CANONICAL_VALUE', `${rowAt} is not a canonical QuantityValue`);
      }
    }
  }
}

function assertCanonicalEnvelope(type, attributes, roles, schema) {
  for (const descriptor of type.attributes) {
    const count = valuePresent(attributes[descriptor.iri])
      ? (Array.isArray(attributes[descriptor.iri]) ? attributes[descriptor.iri].length : 1)
      : 0;
    if (count < descriptor.minCount
        || (descriptor.maxCount !== null && count > descriptor.maxCount)) {
      fail(
        'PTO_TYPED_CARDINALITY',
        `${type.localName}.${descriptor.localName} requires ${descriptor.minCount}..${descriptor.maxCount ?? '*'}, got ${count}`,
      );
    }
  }
  for (const role of type.roles) {
    const count = valuePresent(roles[role.targetIri])
      ? (Array.isArray(roles[role.targetIri]) ? roles[role.targetIri].length : 1)
      : 0;
    if (count < (role.minCount ?? 0)
        || (role.maxCount !== null && role.maxCount !== undefined && count > role.maxCount)) {
      fail(
        'PTO_TYPED_CARDINALITY',
        `${type.localName}.${role.id} requires ${role.minCount ?? 0}..${role.maxCount ?? '*'}, got ${count}`,
      );
    }
  }

  for (const [attributeIri, value] of Object.entries(attributes)) {
    const attributeType = schema.attributeTypesByIri.get(attributeIri);
    if (!attributeType) continue;
    if (attributeType.valueType === MONEY_VALUE_TYPE || attributeType.valueType === QUANTITY_VALUE_TYPE) {
      assertCanonicalStructuredValue(value, attributeType.valueType, `${type.localName}.${attributeType.localName}`);
      continue;
    }
    const codeList = schema.codeListsByIri.get(attributeType.valueType);
    if (codeList) {
      const allowed = new Set((codeList.values || []).map((item) => item.iri));
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0 || values.some((item) => !allowed.has(item))) {
        fail(
          'PTO_TYPED_CANONICAL_VALUE',
          `${type.localName}.${attributeType.localName} must use exact code-value IRIs`,
        );
      }
      continue;
    }
    const primitive = canonicalPrimitiveValue(value, attributeType.valueType);
    if (primitive.recognized && primitive.value === null) {
      fail(
        'PTO_TYPED_CANONICAL_VALUE',
        `${type.localName}.${attributeType.localName} violates ${attributeType.valueType}`,
      );
    }
  }

  for (const constraint of schema.xoneConstraintsByTypeIri.get(type.iri) || []) {
    const present = constraint.branches.filter((branch) => valuePresent(
      branch.container === 'attribute'
        ? attributes[branch.propertyIri]
        : roles[branch.propertyIri],
    ));
    if (present.length !== 1) {
      fail(
        'PTO_TYPED_XONE',
        `${type.localName} violates ${constraint.name}: expected one branch, got ${present.length}`,
        { present: present.map((branch) => branch.localName) },
      );
    }
  }
}

function mergeRawViews(entries, recordIri) {
  const merged = {};
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry.value)) {
      if (!Object.hasOwn(merged, key)) {
        merged[key] = structuredClone(value);
      } else if (canonicalJcs(merged[key]) !== canonicalJcs(value)) {
        fail(
          'PTO_TYPED_DUPLICATE_VIEW_CONFLICT',
          `${recordIri} has conflicting ${key} values across fixture occurrences`,
          { pointers: entries.map((item) => item.pointer), key },
        );
      }
    }
  }
  return merged;
}

function buildOneEnvelope(type, raw, recordIri, context) {
  const attributes = {};
  const roles = {};
  const bindings = [];
  const derivations = [];
  for (const descriptor of type.attributes) {
    // RFC-001 immutable FactVersion profile forbids knowledgeTo and
    // availableTo on the canonical node even when a legacy diagnostic source
    // carries those mutable closure fields. They remain in the source template
    // for exact round-trip diagnostics but are not projected or source-bound.
    if (descriptor.maxCount === 0) continue;
    const selected = selectValue(raw, selectorsForAttribute(type.localName, descriptor.localName));
    if (selected) {
      const attributeType = context.schema.attributeTypesByIri.get(descriptor.iri);
      const canonical = canonicalAttributeValue(selected.value, attributeType, context, raw);
      if (canonical) {
        attributes[descriptor.iri] = structuredClone(canonical.value);
        bindings.push({
          container: 'attribute',
          propertyIri: descriptor.iri,
          rawSelector: selected.selector,
          transform: canonical.transform,
          canonicalValueDigest: sha256(canonicalJcs(canonical.value)),
          ...(canonical.legacyTemplate === undefined
            ? {}
            : { legacyTemplate: structuredClone(canonical.legacyTemplate) }),
        });
        continue;
      }
    }
    if (descriptor.minCount > 0) {
      const derived = deriveAttribute(descriptor, type, recordIri, raw, context);
      attributes[descriptor.iri] = descriptor.minCount > 1
        ? Array.from({ length: descriptor.minCount }, () => structuredClone(derived))
        : structuredClone(derived);
      derivations.push({ kind: 'requiredAttribute', propertyIri: descriptor.iri });
    }
  }
  for (const role of type.roles) {
    const selected = selectValue(raw, ROLE_SELECTORS[role.id] || [role.id]);
    const normalized = selected ? normalizeRoleValue(selected.value) : undefined;
    const count = Array.isArray(normalized) ? normalized.length : normalized === undefined ? 0 : 1;
    if (count > 0) {
      roles[role.targetIri] = structuredClone(normalized);
      const containsEmbeddedRecord = isPlainObject(selected.value)
        || (Array.isArray(selected.value) && selected.value.some(isPlainObject));
      if (!containsEmbeddedRecord) {
        bindings.push({
          container: 'role',
          propertyIri: role.targetIri,
          rawSelector: selected.selector,
          transform: 'identity',
          canonicalValueDigest: sha256(canonicalJcs(normalized)),
        });
      }
    } else if ((role.minCount ?? 0) > 0) {
      roles[role.targetIri] = role.minCount > 1
        ? Array.from(
          { length: role.minCount },
          (_, index) => `${deriveRole(role, type, recordIri)}/${index + 1}`,
        )
        : deriveRole(role, type, recordIri);
      derivations.push({ kind: 'requiredRole', propertyIri: role.targetIri });
    }
  }

  addSemanticBranchDerivations(type, raw, recordIri, attributes, roles, derivations);
  assertCanonicalEnvelope(type, attributes, roles, context.schema);

  return {
    envelope: {
      ontologyType: type.iri,
      recordIri,
      attributes,
      roles,
    },
    bindings,
    derivations,
  };
}

function decodeBoundValue(value, binding, context) {
  if (sha256(canonicalJcs(value)) !== binding.canonicalValueDigest) {
    fail(
      'PTO_TYPED_ADAPTER_BINDING',
      `typed value no longer matches the source-bound canonical value for ${binding.propertyIri}`,
    );
  }
  const { transform } = binding;
  if (transform === 'identity') return structuredClone(value);
  if (transform === 'artifactRefIri') {
    if (!isPlainObject(value) || value.kind !== 'iri' || typeof value.iri !== 'string') {
      fail('PTO_TYPED_ADAPTER_BINDING', 'typed ArtifactRef no longer has the locked IRI branch');
    }
    return value.iri;
  }
  if (transform === 'codeNotation') {
    const decodeOne = (candidate) => {
      const code = context.codeValueByIri.get(candidate);
      if (!code) fail('PTO_TYPED_ADAPTER_BINDING', `unknown typed code value ${String(candidate)}`);
      return code.notation;
    };
    return Array.isArray(value) ? value.map(decodeOne) : decodeOne(value);
  }
  if (transform === 'quantityScalar') {
    if (!isPlainObject(value) || decimalLexical(value.value) === null) {
      fail('PTO_TYPED_ADAPTER_BINDING', 'typed QuantityValue no longer has a valid value field');
    }
    return value.value;
  }
  if (transform === 'quantityObject') {
    if (!isPlainObject(binding.legacyTemplate) || !isPlainObject(value)) {
      fail('PTO_TYPED_ADAPTER_BINDING', 'quantityObject binding is malformed');
    }
    const legacy = structuredClone(binding.legacyTemplate);
    if (Object.hasOwn(legacy, 'value')) legacy.value = value.value;
    else if (Object.hasOwn(legacy, 'amount')) legacy.amount = value.value;
    else fail('PTO_TYPED_ADAPTER_BINDING', 'quantityObject legacy template lacks value/amount');
    for (const key of ['unit', 'precision', 'rounding']) {
      if (Object.hasOwn(legacy, key)) legacy[key] = value[key];
    }
    return legacy;
  }
  if (transform === 'moneyScalar') {
    if (!isPlainObject(value) || decimalLexical(value.amount) === null) {
      fail('PTO_TYPED_ADAPTER_BINDING', 'typed MonetaryAmount no longer has a valid amount field');
    }
    return value.amount;
  }
  if (transform === 'moneyObject') {
    if (!isPlainObject(binding.legacyTemplate) || !isPlainObject(value)) {
      fail('PTO_TYPED_ADAPTER_BINDING', 'moneyObject binding is malformed');
    }
    const legacy = structuredClone(binding.legacyTemplate);
    for (const key of ['amount', 'currency', 'scale']) {
      if (Object.hasOwn(legacy, key)) legacy[key] = value[key];
    }
    return legacy;
  }
  if (transform === 'branchMarker') {
    if (value !== true || typeof binding.legacyTemplate !== 'string') {
      fail('PTO_TYPED_ADAPTER_BINDING', 'branchMarker binding is malformed');
    }
    return binding.legacyTemplate;
  }
  if (transform === 'recordArray') {
    if (!Array.isArray(value)) fail('PTO_TYPED_ADAPTER_BINDING', 'recordArray binding must remain an array');
    return value.map((recordIri) => ({ versionIri: recordIri }));
  }
  fail('PTO_TYPED_ADAPTER_BINDING', `unknown reverse transform ${transform}`);
}

function buildPostTradeCanonicalTypedFixture({
  sourceDocument,
  sourceFixtureRef,
  sourceBytes,
  ontologyDocument,
  patternDocument,
  classificationDocument,
  extractorProfileRef,
  extractorProfileDigest,
} = {}) {
  if (!Buffer.isBuffer(sourceBytes)) fail('PTO_TYPED_SOURCE', 'sourceBytes must be a Buffer');
  if (!isPlainObject(classificationDocument) || !Array.isArray(classificationDocument.classifications)) {
    fail('PTO_TYPED_SOURCE', 'classificationDocument.classifications must be an array');
  }
  const sourceFixtureDigest = sha256(sourceBytes);
  if (classificationDocument.profile !== ROUTE_INVENTORY_PROFILE) {
    fail('PTO_TYPED_SOURCE', `classification profile must be ${ROUTE_INVENTORY_PROFILE}`);
  }
  if (classificationDocument.sourceFixtureDigest !== sourceFixtureDigest) {
    fail('PTO_TYPED_SOURCE', 'classification sourceFixtureDigest differs from source bytes');
  }
  if (!DIGEST_RE.test(extractorProfileDigest || '')) fail('PTO_TYPED_SOURCE', 'extractorProfileDigest is invalid');
  const sourceArtifactRef = { kind: 'path', root: 'sourceTree', path: sourceFixtureRef };
  const locatorWithoutSelection = {
    kind: 'wholeFile',
    path: sourceFixtureRef,
    mediaType: 'application/yaml',
    extractorProfileRef,
    extractorProfileDigest,
  };
  const sourceLocator = {
    ...locatorWithoutSelection,
    selectionDigest: computeSelectionDigest(locatorWithoutSelection, sourceBytes),
  };
  const schema = compileSchema(ontologyDocument, patternDocument);
  const inventory = compilePostTradeTypedRouteInventory(
    sourceDocument,
    classificationDocument.classifications,
  );
  const context = {
    schema,
    sourceArtifactRef,
    sourceFixtureDigest,
    sourceLocator,
  };

  const prepared = inventory.records.map((entry) => {
    const type = schema.typesByIri.get(entry.typeIri);
    if (!type) fail('PTO_TYPED_TYPE', `route type does not resolve: ${entry.typeIri}`);
    const recordIri = typeof entry.value.versionIri === 'string'
      ? entry.value.versionIri
      : `https://example.test/fixture/typed-record/${sha256(entry.pointer).slice(-24)}`;
    return { ...entry, type, recordIri };
  });
  const groups = new Map();
  for (const entry of prepared) {
    const key = `${entry.typeIri}\0${entry.recordIri}`;
    const group = groups.get(key) || [];
    group.push(entry);
    groups.set(key, group);
  }

  const builtByGroup = new Map();
  for (const [key, entries] of groups) {
    const mergedRaw = mergeRawViews(entries, entries[0].recordIri);
    builtByGroup.set(key, buildOneEnvelope(entries[0].type, mergedRaw, entries[0].recordIri, context));
  }

  const fixtureRows = sourceDocument.fixtures.map((fixture) => ({
    id: fixture.id,
    contract: fixture.contract,
    ontologyRecords: [],
  }));
  const adapterRecords = [];
  const derivations = [];
  for (const entry of prepared) {
    const fixtureMatch = /^\/fixtures\/(\d+)\//u.exec(entry.pointer);
    if (!fixtureMatch) fail('PTO_TYPED_ROUTE', `record route is outside one fixture: ${entry.pointer}`);
    const fixtureIndex = Number(fixtureMatch[1]);
    const key = `${entry.typeIri}\0${entry.recordIri}`;
    const built = builtByGroup.get(key);
    const recordIndex = fixtureRows[fixtureIndex].ontologyRecords.length;
    fixtureRows[fixtureIndex].ontologyRecords.push(structuredClone(built.envelope));
    const occurrenceBindings = built.bindings.filter((binding) => getAt(entry.value, binding.rawSelector) !== undefined);
    if (typeof entry.value.versionIri === 'string') {
      occurrenceBindings.push({
        container: 'recordIri',
        propertyIri: null,
        rawSelector: 'versionIri',
        transform: 'identity',
        canonicalValueDigest: sha256(canonicalJcs(entry.recordIri)),
      });
    }
    adapterRecords.push({
      sourcePointer: entry.pointer,
      sourceRecordDigest: entry.sourceRecordDigest,
      fixtureIndex,
      recordIndex,
      ontologyType: entry.typeIri,
      recordIri: entry.recordIri,
      bindings: occurrenceBindings,
    });
    for (const derivation of built.derivations) {
      derivations.push({ sourcePointer: entry.pointer, ontologyType: entry.typeIri, ...derivation });
    }
  }

  const typedDocument = {
    fixtureProfile: sourceDocument.fixtureProfile,
    typedFixtureProfile: TYPED_FIXTURE_PROFILE,
    ontologyCoverage: {
      profile: COVERAGE_PROFILE,
      completeness: 'complete',
      recordCount: inventory.typedRecordCount,
    },
    sourceClassification: {
      profile: inventory.profile,
      sourceHeuristicCandidateCount: inventory.sourceHeuristicCandidateCount,
      typedRecordCount: inventory.typedRecordCount,
      classifiedNonRecordCount: inventory.classifiedNonRecordCount,
      unresolvedCount: inventory.unresolvedCount,
      extraClaimCount: inventory.extraClaimCount,
      inventoryDigest: inventory.inventoryDigest,
      nonRecordClassifications: inventory.nonRecordClassifications,
    },
    fixtures: fixtureRows,
  };
  const codeValueByIri = new Map();
  for (const codeList of schema.codeListsByIri.values()) {
    for (const value of codeList.values || []) codeValueByIri.set(value.iri, value);
  }
  const adapterPlanCore = {
    profile: TYPED_FIXTURE_PROFILE,
    sourceTemplate: structuredClone(sourceDocument),
    sourceDocumentDigest: taggedDigest('axiolune-post-trade-source-document-v1', sourceDocument),
    expectedCanonicalDocumentDigest: sha256(canonicalJcs(sourceDocument)),
    expectedTypedDocumentDigest: sha256(canonicalJcs(typedDocument)),
    typedRecordCount: inventory.typedRecordCount,
    records: adapterRecords,
  };
  const summaryCore = {
    profile: TYPED_FIXTURE_PROFILE,
    routeInventoryDigest: inventory.inventoryDigest,
    sourceHeuristicCandidateCount: inventory.sourceHeuristicCandidateCount,
    typedRecordCount: inventory.typedRecordCount,
    uniqueTypedRecordCount: groups.size,
    duplicateRecordOccurrenceCount: inventory.typedRecordCount - groups.size,
    classifiedNonRecordCount: inventory.classifiedNonRecordCount,
    unresolvedCount: inventory.unresolvedCount,
    extraClaimCount: inventory.extraClaimCount,
    requiredSyntheticDerivationCount: derivations.length,
    complete: inventory.unresolvedCount === 0 && inventory.extraClaimCount === 0,
    stopShip: inventory.unresolvedCount !== 0 || inventory.extraClaimCount !== 0,
    approvalEligible: false,
    releaseEvidence: false,
  };
  const adapterDigestProjection = {
    profile: adapterPlanCore.profile,
    sourceDocumentDigest: adapterPlanCore.sourceDocumentDigest,
    expectedCanonicalDocumentDigest: adapterPlanCore.expectedCanonicalDocumentDigest,
    expectedTypedDocumentDigest: adapterPlanCore.expectedTypedDocumentDigest,
    typedRecordCount: adapterPlanCore.typedRecordCount,
    records: adapterPlanCore.records,
  };
  return Object.freeze({
    document: typedDocument,
    adapterPlan: Object.freeze({
      ...adapterPlanCore,
      codeValueByIri,
      adapterPlanDigest: taggedDigest('axiolune-post-trade-adapter-plan-v1', adapterDigestProjection),
    }),
    derivations,
    inventory,
    summary: Object.freeze({
      ...summaryCore,
      typedDocumentDigest: sha256(canonicalJcs(typedDocument)),
      summaryDigest: taggedDigest('axiolune-post-trade-typed-summary-v1', summaryCore),
    }),
  });
}

function normalizePostTradeCanonicalTypedFixture(typedDocument, adapterPlan, options = {}) {
  if (!isPlainObject(typedDocument) || typedDocument.typedFixtureProfile !== TYPED_FIXTURE_PROFILE) {
    fail('PTO_TYPED_ADAPTER_SHAPE', `typedDocument must use ${TYPED_FIXTURE_PROFILE}`);
  }
  if (!adapterPlan || adapterPlan.profile !== TYPED_FIXTURE_PROFILE) {
    fail('PTO_TYPED_ADAPTER_SHAPE', 'adapterPlan profile mismatch');
  }
  if (typedDocument.ontologyCoverage?.recordCount !== adapterPlan.typedRecordCount) {
    fail('PTO_TYPED_ADAPTER_COUNT', 'typed coverage count differs from adapter plan');
  }
  const actualCount = (typedDocument.fixtures || []).reduce(
    (sum, fixture) => sum + (Array.isArray(fixture.ontologyRecords) ? fixture.ontologyRecords.length : 0),
    0,
  );
  if (actualCount !== adapterPlan.typedRecordCount) {
    fail('PTO_TYPED_ADAPTER_COUNT', `expected ${adapterPlan.typedRecordCount} typed records, got ${actualCount}`);
  }

  const normalized = structuredClone(adapterPlan.sourceTemplate);
  for (const mapping of adapterPlan.records) {
    const envelope = typedDocument.fixtures?.[mapping.fixtureIndex]?.ontologyRecords?.[mapping.recordIndex];
    if (!isPlainObject(envelope)) fail('PTO_TYPED_ADAPTER_RECORD', `missing typed record ${mapping.sourcePointer}`);
    if (envelope.ontologyType !== mapping.ontologyType || envelope.recordIri !== mapping.recordIri) {
      fail('PTO_TYPED_ADAPTER_RECORD', `typed identity drift at ${mapping.sourcePointer}`);
    }
    const rawRecord = resolveRawPointer(normalized, mapping.sourcePointer);
    for (const binding of mapping.bindings) {
      let typedValue;
      if (binding.container === 'recordIri') typedValue = envelope.recordIri;
      else if (binding.container === 'attribute') typedValue = envelope.attributes?.[binding.propertyIri];
      else if (binding.container === 'role') typedValue = envelope.roles?.[binding.propertyIri];
      else fail('PTO_TYPED_ADAPTER_BINDING', `unknown binding container ${binding.container}`);
      if (typedValue === undefined) {
        fail('PTO_TYPED_ADAPTER_BINDING', `typed property is missing for ${mapping.sourcePointer}`);
      }
      const decoded = decodeBoundValue(typedValue, binding, adapterPlan);
      setAt(rawRecord, binding.rawSelector, decoded);
    }
  }
  const normalizedDocumentDigest = sha256(canonicalJcs(normalized));
  const expected = options.expectedDocumentDigest || adapterPlan.expectedCanonicalDocumentDigest;
  if (normalizedDocumentDigest !== expected) {
    fail(
      'PTO_TYPED_NORMALIZATION_DRIFT',
      'typed records do not normalize to the locked source semantics',
      { expected, actual: normalizedDocumentDigest },
    );
  }
  const typedDocumentDigest = sha256(canonicalJcs(typedDocument));
  const expectedTyped = options.expectedTypedDocumentDigest || adapterPlan.expectedTypedDocumentDigest;
  if (typedDocumentDigest !== expectedTyped) {
    fail(
      'PTO_TYPED_DOCUMENT_DRIFT',
      'typed fixture differs from the exact canonical document produced by the locked executable',
      { expected: expectedTyped, actual: typedDocumentDigest },
    );
  }
  return Object.freeze({ document: normalized, normalizedDocumentDigest });
}

function resolveRawPointer(document, pointer) {
  let current = document;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replace(/~1/gu, '/').replace(/~0/gu, '~');
    current = Array.isArray(current) ? current[Number(token)] : current[token];
    if (current === undefined) fail('PTO_TYPED_ADAPTER_RECORD', `source pointer no longer resolves: ${pointer}`);
  }
  return current;
}

module.exports = {
  TYPED_FIXTURE_PROFILE,
  PostTradeCanonicalEnvelopeError,
  assertCanonicalTypedFixtureBuildMatchesManifest,
  buildPostTradeCanonicalTypedFixture,
  compileSchema,
  mergeFinanceOntologyDocuments,
  normalizePostTradeCanonicalTypedFixture,
  validateCanonicalTypedFixtureManifest,
};
