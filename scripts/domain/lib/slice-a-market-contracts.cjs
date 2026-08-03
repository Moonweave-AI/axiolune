'use strict';

const {
  computeSelectionDigest,
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');
const {
  compareDecimalLexical,
  isDecimalLexical,
} = require('./decimal-lexical.cjs');
const {
  isUtcInstantLexical,
  parseUtcInstantNanoseconds,
} = require('./instant-lexical.cjs');
const {
  CqContractError,
  compileClosureContext,
} = require('./foundation-market-instrument-cq.cjs');
const {
  EXPECTED: SOURCE_LOCK_EXPECTED,
  loadLockedIso4217Registry,
  loadLockedQuantityRegistry,
} = require('./slice-a-source-locks.cjs');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TEMPORAL = 'https://axiolune.ai/ontology/meta/patterns/TemporalFact';
const PROVENANCE = 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact';
const LOGICAL = 'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference';
const EXACT = 'https://axiolune.ai/ontology/meta/core/constraints/ExactVersionReference';
const PENDING_EVIDENCE = 'https://axiolune.ai/pending-source-evidence/';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ABSOLUTE_IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;
const MIC_RE = /^[A-Z0-9]{4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const SOURCE_TREE_ROOT = path.resolve(__dirname, '..', '..', '..');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function entries(value) {
  return isObject(value) ? Object.entries(value) : [];
}

function addViolation(violations, code, at, message) {
  violations.push({ code, at, message });
}

function findRelationUse(moduleDocument, relationIri) {
  return array(moduleDocument?.domain?.relationUses)
    .find((candidate) => candidate?.relation === relationIri);
}

function referenceMode(use) {
  return array(use?.constraints)
    .map((binding) => binding?.constraintRef)
    .filter((constraintRef) => constraintRef === LOGICAL || constraintRef === EXACT);
}

function hasPattern(element, pattern) {
  return array(element?.patternBindings)
    .filter((binding) => binding?.pattern === pattern).length === 1;
}

function closesExternalTermAlignment(evidence) {
  const required = new Set([
    'instruments-financial-instrument-fibo-financial-instrument',
    'instruments-security-fibo-security',
  ]);
  const decisions = evidence?.noAlignment?.evidence?.decisions;
  if (evidence?.noAlignment?.ok !== true
      || !DIGEST_RE.test(evidence.noAlignment.evidence?.referenceArtifactDigest || '')
      || !Array.isArray(decisions)
      || evidence?.authoritySourceLocks?.mic !== true
      || evidence?.authoritySourceLocks?.tzdb !== true
      || evidence?.authoritySourceLocks?.quantityUnit !== true) {
    return false;
  }
  for (const decision of decisions) {
    if (!required.has(decision.decisionId)) continue;
    if (decision.outcome !== 'reviewed-no-alignment-semantic-mismatch'
        || !DIGEST_RE.test(decision.decisionDigest || '')
        || !DIGEST_RE.test(decision.localElementDigest || '')
        || !DIGEST_RE.test(decision.sourceSelectionDigest || '')
        || !DIGEST_RE.test(decision.selectedContentDigest || '')
        || decision.rejectedTriple?.present !== false) {
      return false;
    }
    required.delete(decision.decisionId);
  }
  return required.size === 0;
}

function auditModuleContract(market, instruments, options = {}) {
  const violations = [];
  const pending = [];
  const marketBase = 'https://axiolune.ai/ontology/finance/market-structure/';
  const instrumentBase = 'https://axiolune.ai/ontology/finance/instruments/';

  function expectContainer(document, name, moduleName) {
    if (!isObject(document?.domain?.[name]) && !Array.isArray(document?.domain?.[name])) {
      addViolation(violations, 'ONTOLOGY_CONTAINER', `${moduleName}.domain.${name}`, 'missing typed M3 container');
    }
  }

  for (const [moduleName, document] of [['market-structure', market], ['instruments', instruments]]) {
    for (const name of [
      'objectTypes', 'associationTypes', 'relationTypes', 'attributeTypes',
      'identifierTypes', 'codeLists', 'constraints', 'relationUses',
      'constraintBindings',
    ]) {
      expectContainer(document, name, moduleName);
    }
    if (document?.module?.status !== 'draft' || document?.module?.governance?.status !== 'draft') {
      addViolation(violations, 'ONTOLOGY_DRAFT_STATUS', `${moduleName}.module`, 'Slice-A must remain draft while evidence is pending');
    }
  }

  const requiredMarketObjects = [
    'TradingFacility', 'TradingVenue', 'MarketSegment', 'MICRegistryEntry',
    'TradingCalendar', 'TradingSessionTemplate', 'TradingSessionOccurrence',
    'TradingCalendarException', 'OTCTradingContext',
  ];
  const requiredInstrumentObjects = [
    'FinancialInstrument', 'Security', 'EquitySecurity', 'SecurityOffering',
    'InstrumentListing', 'DirectUnitPriceQuotationContract',
  ];

  for (const name of requiredMarketObjects) {
    if (!market?.domain?.objectTypes?.[name]) {
      addViolation(violations, 'ONTOLOGY_MARKET_OBJECT', `market-structure.domain.objectTypes.${name}`, 'required ObjectTypeDefinition is absent');
    }
  }
  for (const name of requiredInstrumentObjects) {
    if (!instruments?.domain?.objectTypes?.[name]) {
      addViolation(violations, 'ONTOLOGY_INSTRUMENT_OBJECT', `instruments.domain.objectTypes.${name}`, 'required ObjectTypeDefinition is absent');
    }
  }
  if (!instruments?.domain?.associationTypes?.InstrumentIssuance) {
    addViolation(violations, 'ONTOLOGY_ISSUANCE_CLASSIFIER', 'instruments.domain.associationTypes.InstrumentIssuance', 'InstrumentIssuance must be an AssociationTypeDefinition');
  }
  if (instruments?.domain?.objectTypes?.InstrumentIssuance) {
    addViolation(violations, 'ONTOLOGY_ISSUANCE_CLASSIFIER', 'instruments.domain.objectTypes.InstrumentIssuance', 'InstrumentIssuance must not be an ObjectTypeDefinition');
  }

  for (const forbidden of ['TradingSession']) {
    if (market?.domain?.objectTypes?.[forbidden]) {
      addViolation(violations, 'ONTOLOGY_FORBIDDEN_LEGACY', `market-structure.domain.objectTypes.${forbidden}`, 'legacy undifferentiated session type is forbidden');
    }
  }
  for (const forbidden of ['Issuer', 'SecuritiesOffering']) {
    if (instruments?.domain?.objectTypes?.[forbidden]) {
      addViolation(violations, 'ONTOLOGY_FORBIDDEN_LEGACY', `instruments.domain.objectTypes.${forbidden}`, 'legacy competing classifier is forbidden');
    }
  }
  for (const forbidden of ['isIssuedBy', 'isListedOn', 'hasDenominatedCurrency']) {
    if (instruments?.domain?.relationTypes?.[forbidden]) {
      addViolation(violations, 'ONTOLOGY_FORBIDDEN_LEGACY', `instruments.domain.relationTypes.${forbidden}`, 'legacy competing truth is forbidden');
    }
  }
  if (findRelationUse(instruments, `${instrumentBase}isTradedOn`)) {
    addViolation(violations, 'ONTOLOGY_DERIVED_TRUTH_STORED', 'instruments.domain.relationUses', 'isTradedOn is a derived view and must not have a stored RelationUse');
  }

  const temporalMarketTypes = requiredMarketObjects;
  const temporalInstrumentTypes = [...requiredInstrumentObjects, 'InstrumentIssuance'];
  for (const name of temporalMarketTypes) {
    const element = market?.domain?.objectTypes?.[name];
    if (!hasPattern(element, TEMPORAL) || !hasPattern(element, PROVENANCE)) {
      addViolation(violations, 'ONTOLOGY_FACT_PATTERNS', `market-structure.${name}`, 'materialized type must bind TemporalFact and ProvenancedFact exactly once');
    }
  }
  for (const name of temporalInstrumentTypes) {
    const element = name === 'InstrumentIssuance'
      ? instruments?.domain?.associationTypes?.[name]
      : instruments?.domain?.objectTypes?.[name];
    if (!hasPattern(element, TEMPORAL) || !hasPattern(element, PROVENANCE)) {
      addViolation(violations, 'ONTOLOGY_FACT_PATTERNS', `instruments.${name}`, 'materialized type must bind TemporalFact and ProvenancedFact exactly once');
    }
  }

  const expectedRelations = [
    [market, `${marketBase}marketSegmentVenue`, `${marketBase}MarketSegment`, `${marketBase}TradingVenue`, 1, 1, LOGICAL],
    [market, `${marketBase}registryMICValue`, `${marketBase}MICRegistryEntry`, 'https://axiolune.ai/ontology/finance/foundation/MICValue', 1, 1, LOGICAL],
    [market, `${marketBase}registryAuthority`, `${marketBase}MICRegistryEntry`, 'https://axiolune.ai/ontology/finance/foundation/IdentifierAuthority', 1, 1, LOGICAL],
    [market, `${marketBase}registryFacility`, `${marketBase}MICRegistryEntry`, `${marketBase}TradingFacility`, 1, 1, EXACT],
    [market, `${marketBase}operatingMICEntry`, `${marketBase}MICRegistryEntry`, `${marketBase}MICRegistryEntry`, 0, 1, EXACT],
    [market, `${marketBase}calendarFacility`, `${marketBase}TradingCalendar`, `${marketBase}TradingFacility`, 1, 1, LOGICAL],
    [market, `${marketBase}calendarAuthority`, `${marketBase}TradingCalendar`, 'https://axiolune.ai/ontology/finance/foundation/Party', 1, 1, LOGICAL],
    [market, `${marketBase}calendarJurisdiction`, `${marketBase}TradingCalendar`, 'https://axiolune.ai/ontology/finance/foundation/Jurisdiction', 1, 1, LOGICAL],
    [market, `${marketBase}templateCalendar`, `${marketBase}TradingSessionTemplate`, `${marketBase}TradingCalendar`, 1, 1, EXACT],
    [market, `${marketBase}occurrenceTemplate`, `${marketBase}TradingSessionOccurrence`, `${marketBase}TradingSessionTemplate`, 1, 1, EXACT],
    [market, `${marketBase}occurrenceCalendar`, `${marketBase}TradingSessionOccurrence`, `${marketBase}TradingCalendar`, 1, 1, EXACT],
    [market, `${marketBase}occurrenceFacility`, `${marketBase}TradingSessionOccurrence`, `${marketBase}TradingFacility`, 1, 1, EXACT],
    [market, `${marketBase}exceptionOccurrence`, `${marketBase}TradingCalendarException`, `${marketBase}TradingSessionOccurrence`, 1, 1, EXACT],
    [market, `${marketBase}otcSourceProvider`, `${marketBase}OTCTradingContext`, 'https://axiolune.ai/ontology/finance/foundation/Party', 1, 1, EXACT],
    [market, `${marketBase}otcQuoteCurrency`, `${marketBase}OTCTradingContext`, 'https://axiolune.ai/ontology/finance/foundation/Currency', 1, 1, LOGICAL],
    [market, `${marketBase}otcSettlementCurrency`, `${marketBase}OTCTradingContext`, 'https://axiolune.ai/ontology/finance/foundation/Currency', 0, 1, LOGICAL],
    [market, `${marketBase}otcReportingFacility`, `${marketBase}OTCTradingContext`, `${marketBase}TradingFacility`, 0, 1, EXACT],
    [market, `${marketBase}otcCounterpartyA`, `${marketBase}OTCTradingContext`, 'https://axiolune.ai/ontology/finance/foundation/Party', 0, 1, EXACT],
    [market, `${marketBase}otcCounterpartyB`, `${marketBase}OTCTradingContext`, 'https://axiolune.ai/ontology/finance/foundation/Party', 0, 1, EXACT],
    [instruments, `${instrumentBase}offeredSecurity`, `${instrumentBase}SecurityOffering`, `${instrumentBase}Security`, 1, 1, EXACT],
    [instruments, `${instrumentBase}listingIdentifierScheme`, `${instrumentBase}InstrumentListing`, 'https://axiolune.ai/ontology/finance/foundation/IdentifierScheme', 1, 1, LOGICAL],
    [instruments, `${instrumentBase}listingIdentifierValue`, `${instrumentBase}InstrumentListing`, 'https://axiolune.ai/ontology/finance/foundation/LocalIdentifierValue', 1, 1, LOGICAL],
    [instruments, `${instrumentBase}listedInstrument`, `${instrumentBase}InstrumentListing`, `${instrumentBase}FinancialInstrument`, 1, 1, EXACT],
    [instruments, `${instrumentBase}listingFacility`, `${instrumentBase}InstrumentListing`, `${marketBase}TradingFacility`, 1, 1, EXACT],
    [instruments, `${instrumentBase}originatingOffering`, `${instrumentBase}InstrumentListing`, `${instrumentBase}SecurityOffering`, 0, 1, EXACT],
    [instruments, `${instrumentBase}listingQuoteCurrency`, `${instrumentBase}InstrumentListing`, 'https://axiolune.ai/ontology/finance/foundation/Currency', 1, 1, LOGICAL],
    [instruments, `${instrumentBase}quotationInstrument`, `${instrumentBase}DirectUnitPriceQuotationContract`, `${instrumentBase}FinancialInstrument`, 1, 1, LOGICAL],
    [instruments, `${instrumentBase}quotationListingContext`, `${instrumentBase}DirectUnitPriceQuotationContract`, `${instrumentBase}InstrumentListing`, 0, 1, EXACT],
    [instruments, `${instrumentBase}quotationOTCContext`, `${instrumentBase}DirectUnitPriceQuotationContract`, `${marketBase}OTCTradingContext`, 0, 1, EXACT],
    [instruments, `${instrumentBase}quotationQuoteCurrency`, `${instrumentBase}DirectUnitPriceQuotationContract`, 'https://axiolune.ai/ontology/finance/foundation/Currency', 1, 1, LOGICAL],
  ];

  for (const [document, relation, subject, object, min, max, mode] of expectedRelations) {
    const use = findRelationUse(document, relation);
    if (!use) {
      addViolation(violations, 'ONTOLOGY_RELATION_USE', relation, 'required direct RelationUse is absent');
      continue;
    }
    if (use.subjectType !== subject || use.objectType !== object
        || use.outboundCardinality?.minCount !== min
        || use.outboundCardinality?.maxCount !== max) {
      addViolation(violations, 'ONTOLOGY_RELATION_CARDINALITY', relation, 'subject, object, or outbound cardinality differs from RFC-001');
    }
    const modes = referenceMode(use);
    if (modes.length !== 1 || modes[0] !== mode) {
      addViolation(violations, 'ONTOLOGY_REFERENCE_MODE', relation, `expected exactly one ${mode} binding`);
    }
  }

  const issuance = instruments?.domain?.associationTypes?.InstrumentIssuance;
  const roleModes = new Map(
    array(instruments?.domain?.constraintBindings)
      .filter((binding) => binding?.constraintRef === EXACT || binding?.constraintRef === LOGICAL)
      .map((binding) => [binding.targetElement, binding.constraintRef]),
  );
  for (const role of array(issuance?.participantRoles)) {
    const at = `${issuance.iri}/role/${role.id}`;
    if (!role.label || !role.definition) {
      addViolation(violations, 'ONTOLOGY_ROLE_SEMANTICS', at, 'exported ParticipantRole requires label and definition');
    }
    if (roleModes.get(at) !== EXACT) {
      addViolation(violations, 'ONTOLOGY_ROLE_REFERENCE_MODE', at, 'issuance participants must be exact version references');
    }
  }
  const roleIds = array(issuance?.participantRoles).map((role) => role.id);
  if (roleIds.join(',') !== 'issuedSecurity,issuer,originatingOffering') {
    addViolation(violations, 'ONTOLOGY_ISSUANCE_ROLES', issuance?.iri || 'InstrumentIssuance', 'issuance role inventory/order is not canonical');
  }

  const marketCodeMembers = {
    MICEntryType: ['OPRT', 'SGMT'],
    CalendarExceptionKind: ['holiday', 'closure', 'earlySession', 'lateSession'],
    MarketConvention: ['directQuotePerUnit'],
  };
  const instrumentCodeMembers = { QuotationKind: ['directUnitPrice'] };
  for (const [name, expected] of Object.entries(marketCodeMembers)) {
    const actual = array(market?.domain?.codeLists?.[name]?.values).map((member) => member.notation);
    if (actual.join(',') !== expected.join(',')) {
      addViolation(violations, 'ONTOLOGY_CODE_LIST', `market-structure.domain.codeLists.${name}`, `expected closed members ${expected.join(',')}`);
    }
  }
  for (const [name, expected] of Object.entries(instrumentCodeMembers)) {
    const actual = array(instruments?.domain?.codeLists?.[name]?.values).map((member) => member.notation);
    if (actual.join(',') !== expected.join(',')) {
      addViolation(violations, 'ONTOLOGY_CODE_LIST', `instruments.domain.codeLists.${name}`, `expected closed members ${expected.join(',')}`);
    }
  }

  const otcConstraint = market?.domain?.constraints?.OTCTradingContextContract;
  const otcExpression = otcConstraint?.expression?.expression || '';
  const otcReferenceConstraint = market?.domain?.constraints
    ?.OTCTradingContextReferenceContract;
  const otcReferenceExpression = otcReferenceConstraint?.expression?.expression || '';
  const listingExpression = instruments?.domain?.constraints
    ?.InstrumentListingIdentityContract?.expression?.expression || '';
  const quotationExpression = instruments?.domain?.constraints?.DirectUnitPriceQuotationRule?.expression?.expression || '';
  const quotationXone = instruments?.domain?.constraints
    ?.DirectUnitPriceQuotationContextXone;
  if (otcConstraint?.expression?.language !== 'SPARQL'
      || !otcExpression.includes('BOUND(?counterpartyA)')
      || !otcExpression.includes('BOUND(?counterpartyB)')
      || !otcExpression.includes('STR(?counterpartyA) >= STR(?counterpartyB)')) {
    addViolation(
      violations,
      'ONTOLOGY_OTC_SPARQL',
      'market-structure.OTCTradingContextContract',
      'counterparty pair must use the compiler-supported direct SPARQL absence/presence and lexical-order contract',
    );
  }
  if (quotationXone?.expression?.language !== 'SHACL'
      || quotationXone.expression.expression !==
        'sh:xone(quotationListingContext,quotationOTCContext)') {
    addViolation(
      violations,
      'ONTOLOGY_QUOTATION_XONE',
      'instruments.DirectUnitPriceQuotationContextXone',
      'listing/OTC context must use the compiler-supported exact sh:xone expression',
    );
  }
  if (otcReferenceConstraint?.expression?.language !== 'Custom'
      || ![
        'logicalKey(versionOf(otcSourceProvider),sourceContractRef,providerContextId)',
        'exactVersionPITEligibleAt',
        'ISO4217RegistryEntry',
        'locked authority bytes',
        'sourceContractDigest authenticates',
      ].every((token) => otcReferenceExpression.includes(token))) {
    addViolation(
      violations,
      'ONTOLOGY_OTC_REFERENCE_CONTRACT',
      'market-structure.OTCTradingContextReferenceContract',
      'OTC identity, three-axis exact-reference, registry, and source-contract semantics are incomplete',
    );
  }
  const otcReferenceBindings = array(market?.domain?.constraintBindings)
    .filter((binding) => (
      binding?.constraintRef === `${marketBase}OTCTradingContextReferenceContract`
      && binding.targetElement === `${marketBase}OTCTradingContext`
      && binding.enforcementLevel === 'Mandatory'
    ));
  if (otcReferenceBindings.length !== 1) {
    addViolation(
      violations,
      'ONTOLOGY_OTC_REFERENCE_BINDING',
      'market-structure.domain.constraintBindings',
      'OTC reference contract must have exactly one Mandatory target binding',
    );
  }
  for (const token of [
    'exactVersionPITEligibleAt',
    'ListingIdentifierSchemeAuthorization',
    'ISO4217RegistryEntry',
    'locked authority bytes',
  ]) {
    if (!listingExpression.includes(token)) {
      addViolation(
        violations,
        'ONTOLOGY_LISTING_IDENTITY_RULE',
        'instruments.InstrumentListingIdentityContract',
        `missing executable identity/reference token ${token}`,
      );
    }
  }
  for (const token of [
    'directUnitPrice', 'explicitDecimalLexical', 'decimalEquals(1)',
    'PITEligible', 'ISO4217RegistryEntry', 'locked authority bytes',
    'nonEmpty', 'digestLockedControlledQuantityUnitRegistry',
    'directUnitPriceQuotationDenominator', 'par', 'accrued', 'inverse',
  ]) {
    if (!quotationExpression.includes(token)) {
      addViolation(violations, 'ONTOLOGY_QUOTATION_RULE', 'instruments.DirectUnitPriceQuotationRule', `missing closed-profile token ${token}`);
    }
  }

  for (const [moduleName, document] of [['market-structure', market], ['instruments', instruments]]) {
    for (const [name, codeList] of entries(document?.domain?.codeLists)) {
      if (typeof codeList.sourceEvidenceRef === 'string'
          && codeList.sourceEvidenceRef.startsWith(PENDING_EVIDENCE)) {
        pending.push({
          code: 'PENDING_CODE_LIST_EVIDENCE',
          at: `${moduleName}.domain.codeLists.${name}.sourceEvidenceRef`,
          message: `external or adopted project evidence is not locked: ${codeList.sourceEvidenceRef}`,
        });
      }
    }
  }

  const marketImports = array(market?.module?.imports).map((item) => item.moduleIri);
  if (!marketImports.includes('https://axiolune.ai/ontology/finance/foundation')) {
    pending.push({
      code: 'PENDING_IMPORT_LOCK',
      at: 'market-structure.module.imports',
      message: 'RFC-001 requires the Foundation edge; root digest/registry closure must add the content-addressed import atomically',
    });
  }
  if (!closesExternalTermAlignment(options.externalTermAlignmentEvidence)) {
    pending.push({
      code: 'PENDING_EXTERNAL_TERM_ALIGNMENT',
      at: 'market-structure/instruments alignments',
      message: 'exact reviewed no-alignment decisions plus MIC/tzdb/Quantity source-lock replays are required; absence of an Alignment is not sufficient',
    });
  }
  return { violations, pending };
}

function validateNfcNonBlank(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.normalize('NFC')
    && value === value.trim();
}

function validDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validInstant(value) {
  return isUtcInstantLexical(value);
}

function validIri(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || value !== value.normalize('NFC')
      || /[\u0000-\u0020\u007f]/u.test(value)
      || !ABSOLUTE_IRI_RE.test(value)) return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol) && parsed.href === value;
  } catch {
    return false;
  }
}

function instantNanoseconds(value) {
  return parseUtcInstantNanoseconds(value);
}

function exactSourceFile(artifactRef) {
  if (!isObject(artifactRef)
      || artifactRef.kind !== 'path'
      || artifactRef.root !== 'sourceTree'
      || typeof artifactRef.path !== 'string') return null;
  const resolved = path.resolve(SOURCE_TREE_ROOT, artifactRef.path);
  const relative = path.relative(SOURCE_TREE_ROOT, resolved);
  if (relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
      || !fs.existsSync(resolved)
      || !fs.statSync(resolved).isFile()) return null;
  const realRoot = fs.realpathSync(SOURCE_TREE_ROOT);
  const realFile = fs.realpathSync(resolved);
  const realRelative = path.relative(realRoot, realFile);
  return realRelative === '..'
      || realRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(realRelative)
    ? null
    : realFile;
}

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function buildIndex(items, label, violations) {
  const index = new Map();
  array(items).forEach((item, position) => {
    const at = `${label}[${position}]`;
    if (!isObject(item) || !validateNfcNonBlank(item.id)) {
      addViolation(violations, 'INSTANCE_ID', at, 'entry requires a non-empty NFC id');
      return;
    }
    if (index.has(item.id)) {
      addViolation(violations, 'INSTANCE_DUPLICATE_ID', at, `duplicate id ${item.id}`);
      return;
    }
    index.set(item.id, item);
  });
  return index;
}

function validateFact(record, at, violations) {
  if (!validIri(record?.id)
      || !validIri(record?.logicalId)
      || record.id === record.logicalId) {
    addViolation(
      violations,
      'FACT_IDENTITY_SEPARATION',
      at,
      'fact requires distinct absolute logical and immutable version IRIs',
    );
  }
  if (!validInstant(record?.validFrom)
      || !validInstant(record?.knowledgeFrom)
      || !validInstant(record?.availableFrom)
      || !Number.isSafeInteger(record?.revision)
      || record.revision < 0) {
    addViolation(violations, 'FACT_THREE_AXIS', at, 'fact requires validFrom, knowledgeFrom, availableFrom, and a non-negative integer revision');
  }
  if (Object.hasOwn(record || {}, 'knowledgeTo')
      || Object.hasOwn(record || {}, 'availableTo')) {
    addViolation(
      violations,
      'FACT_INLINE_CLOSURE',
      at,
      'knowledgeTo/availableTo are forbidden on immutable fact versions; use FactClosureAssertion',
    );
  }
  if (validInstant(record?.knowledgeFrom)
      && validInstant(record?.availableFrom)
      && instantNanoseconds(record.availableFrom) < instantNanoseconds(record.knowledgeFrom)) {
    addViolation(violations, 'FACT_AXIS_ORDER', at, 'availableFrom must not precede knowledgeFrom');
  }
  if (record?.validTo !== undefined
      && (!validInstant(record.validTo)
        || (validInstant(record.validFrom)
          && instantNanoseconds(record.validTo) <= instantNanoseconds(record.validFrom)))) {
    addViolation(violations, 'FACT_VALID_INTERVAL', at, 'validTo must be an instant strictly after validFrom');
  }
  const source = record?.source;
  if (!isObject(source)
      || Object.keys(source).sort().join(',') !== 'artifactDigest,artifactRef,locator'
      || !DIGEST_RE.test(source.artifactDigest || '')) {
    addViolation(violations, 'FACT_SOURCE_CLOSURE', at, 'fact requires an exact artifactRef/artifactDigest/locator source closure');
    return;
  }
  const artifactResult = validateArtifactRef(source.artifactRef, `${at}.source.artifactRef`);
  for (const message of artifactResult.errors) {
    addViolation(violations, 'FACT_SOURCE_ARTIFACT_REF', at, message);
  }
  const locatorResult = validateSourceLocator(source.locator, { at: `${at}.source.locator` });
  for (const message of locatorResult.errors) {
    addViolation(violations, 'FACT_SOURCE_LOCATOR', at, message);
  }
  if (!artifactResult.ok || !locatorResult.ok) return;
  const artifactFile = exactSourceFile(source.artifactRef);
  const extractorFile = exactSourceFile(source.locator.extractorProfileRef);
  if (!artifactFile
      || !extractorFile
      || source.locator.kind !== 'wholeFile'
      || source.locator.path !== source.artifactRef.path) {
    addViolation(violations, 'FACT_SOURCE_RESOLUTION', at, 'fixture provenance must resolve one exact source-tree file and whole-file locator');
    return;
  }
  if (sha256File(artifactFile) !== source.artifactDigest
      || sha256File(extractorFile) !== source.locator.extractorProfileDigest) {
    addViolation(violations, 'FACT_SOURCE_DIGEST', at, 'artifact or extractor digest does not recompute from source-tree bytes');
  }
  const selectionDigest = computeSelectionDigest(source.locator, fs.readFileSync(artifactFile));
  if (selectionDigest !== source.locator.selectionDigest) {
    addViolation(violations, 'FACT_SOURCE_SELECTION', at, 'SourceLocator selectionDigest does not recompute');
  }
}

function pitEligibleAt(record, consumer, closures) {
  if (!isObject(record)
      || !isObject(consumer)
      || !validInstant(record.validFrom)
      || !validInstant(record.knowledgeFrom)
      || !validInstant(record.availableFrom)
      || !validInstant(consumer.validFrom)
      || !validInstant(consumer.knowledgeFrom)
      || !validInstant(consumer.availableFrom)) return false;
  const validAt = instantNanoseconds(consumer.validFrom);
  const knowledgeAt = instantNanoseconds(consumer.knowledgeFrom);
  const availableAt = instantNanoseconds(consumer.availableFrom);
  if (validAt < instantNanoseconds(record.validFrom)
      || knowledgeAt < instantNanoseconds(record.knowledgeFrom)
      || availableAt < instantNanoseconds(record.availableFrom)) return false;
  if (record.validTo !== undefined
      && (!validInstant(record.validTo)
        || validAt >= instantNanoseconds(record.validTo))) return false;
  const knowledgeClosure = closures.get(`${record.id}\0knowledge`);
  const availabilityClosure = closures.get(`${record.id}\0availability`);
  return (!knowledgeClosure || knowledgeAt < knowledgeClosure.closedAtNanoseconds)
    && (!availabilityClosure || availableAt < availabilityClosure.closedAtNanoseconds);
}

function eligibleExact(index, exactId, consumer, closures) {
  const record = index.get(exactId);
  return record && pitEligibleAt(record, consumer, closures) ? record : null;
}

function eligibleByLogical(records, logicalId, consumer, closures) {
  return array(records).filter((record) => (
    record?.logicalId === logicalId && pitEligibleAt(record, consumer, closures)
  ));
}

function validateVersionIdentityGroups(records, label, keyOf, code, violations) {
  const byKey = new Map();
  const keyByLogical = new Map();
  for (const record of array(records)) {
    if (!isObject(record)) continue;
    const key = keyOf(record);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(record);
    if (validIri(record.logicalId)) {
      const priorKey = keyByLogical.get(record.logicalId);
      if (priorKey !== undefined && priorKey !== key) {
        addViolation(
          violations,
          `${code}_LOGICAL_COLLISION`,
          `${label}.${record.id}.logicalId`,
          'one logical IRI cannot represent multiple identity tuples',
        );
      }
      keyByLogical.set(record.logicalId, key);
    }
  }
  for (const [key, versions] of byKey) {
    const logicalIds = new Set(versions.map((record) => record.logicalId));
    if (logicalIds.size !== 1 || !validIri(versions[0]?.logicalId)) {
      addViolation(
        violations,
        `${code}_LOGICAL_KEY`,
        `${label}.${versions[0]?.id || key}`,
        'one identity tuple must preserve exactly one logical IRI across versions',
      );
    }
    const revisions = new Map();
    for (const record of versions) {
      if (revisions.has(record.revision)) {
        addViolation(
          violations,
          code,
          `${label}.${record.id}`,
          `identity tuple has duplicate revision ${String(record.revision)}`,
        );
      }
      revisions.set(record.revision, record);
    }
    const ordered = [...versions].sort((left, right) => left.revision - right.revision);
    ordered.forEach((record, position) => {
      if (record.revision !== position) {
        addViolation(
          violations,
          code,
          `${label}.${record.id}`,
          'version revisions must form one contiguous zero-based chain',
        );
      }
      if (position === 0) {
        if (record.supersedes !== undefined) {
          addViolation(violations, code, `${label}.${record.id}.supersedes`, 'revision zero must not supersede another version');
        }
        return;
      }
      const predecessor = ordered[position - 1];
      if (record.supersedes !== predecessor.id
          || !validInstant(record.knowledgeFrom)
          || !validInstant(predecessor.knowledgeFrom)
          || instantNanoseconds(record.knowledgeFrom)
            <= instantNanoseconds(predecessor.knowledgeFrom)
          || !validInstant(record.availableFrom)
          || !validInstant(predecessor.availableFrom)
          || instantNanoseconds(record.availableFrom)
            <= instantNanoseconds(predecessor.availableFrom)) {
        addViolation(
          violations,
          code,
          `${label}.${record.id}`,
          'each revision must supersede the immediately prior version and advance both knowledge and availability',
        );
      }
    });
  }
}

function validateScenario(document) {
  const violations = [];
  if (!isObject(document)) {
    return [{ code: 'FIXTURE_ROOT', at: '$', message: 'fixture root must be an object' }];
  }

  let closures = new Map();
  try {
    closures = compileClosureContext(document);
  } catch (error) {
    addViolation(
      violations,
      error instanceof CqContractError ? error.code : 'FACT_CLOSURE_CONTEXT',
      'factClosureAssertions',
      error.message,
    );
  }

  const facilities = buildIndex(document.facilities, 'facilities', violations);
  const parties = buildIndex(document.parties, 'parties', violations);
  const instruments = buildIndex(document.instruments, 'instruments', violations);
  const micEntries = buildIndex(document.micEntries, 'micEntries', violations);
  const calendars = buildIndex(document.calendars, 'calendars', violations);
  const templates = buildIndex(document.sessionTemplates, 'sessionTemplates', violations);
  const occurrences = buildIndex(document.sessionOccurrences, 'sessionOccurrences', violations);
  const exceptions = buildIndex(document.calendarExceptions, 'calendarExceptions', violations);
  const otcContexts = buildIndex(document.otcContexts, 'otcContexts', violations);
  const offerings = buildIndex(document.offerings, 'offerings', violations);
  const issuances = buildIndex(document.issuances, 'issuances', violations);
  const listings = buildIndex(document.listings, 'listings', violations);
  const quotations = buildIndex(document.quotationContracts, 'quotationContracts', violations);
  const identifierSchemes = buildIndex(document.identifierSchemes, 'identifierSchemes', violations);
  const identifierValues = buildIndex(document.identifierValues, 'identifierValues', violations);
  const identifierSchemesByLogical = new Map(
    [...identifierSchemes.values()].map((scheme) => [scheme.logicalId, scheme]),
  );
  const identifierValuesByLogical = new Map(
    [...identifierValues.values()].map((value) => [value.logicalId, value]),
  );
  const currencyRegistry = buildIndex(
    document.currencyRegistry,
    'currencyRegistry',
    violations,
  );
  const identifierAuthorizations = buildIndex(
    document.identifierAuthorizations,
    'identifierAuthorizations',
    violations,
  );
  let lockedIso4217 = new Map();
  let lockedQuantityRegistry = null;
  try {
    lockedIso4217 = loadLockedIso4217Registry(SOURCE_TREE_ROOT).entries;
  } catch (error) {
    addViolation(
      violations,
      'CURRENCY_REGISTRY_SOURCE_CLOSURE',
      'currencyRegistry',
      error.message,
    );
  }
  try {
    lockedQuantityRegistry = loadLockedQuantityRegistry(SOURCE_TREE_ROOT);
  } catch (error) {
    addViolation(
      violations,
      'QUANTITY_UNIT_REGISTRY_SOURCE_CLOSURE',
      'quantityUnitRegistry',
      error.message,
    );
  }

  const currencyLogicalByAlpha = new Map([
    ['USD', 'urn:currency:usd'],
    ['EUR', 'urn:currency:eur'],
  ]);
  for (const [id, entry] of currencyRegistry) {
    const at = `currencyRegistry.${id}`;
    validateFact(entry, at, violations);
    const lockedEntry = lockedIso4217.get(entry.iso4217AlphaCode);
    const expectedCurrencyLogical = currencyLogicalByAlpha.get(entry.iso4217AlphaCode);
    if (entry.iso4217RegistryAuthority !== 'urn:authority:iso4217'
        || !/^[A-Z]{3}$/u.test(entry.iso4217AlphaCode || '')
        || !/^\d{3}$/u.test(entry.iso4217NumericCode || '')
        || !Number.isSafeInteger(entry.iso4217MinorUnit)
        || entry.iso4217MinorUnit < 0
        || entry.iso4217EntryStatus !== 'active'
        || !validIri(entry.iso4217EntryCurrency)
        || entry.iso4217EntryCurrency !== expectedCurrencyLogical
        || entry.iso4217RegistrySourceRef
          !== 'https://axiolune.ai/references/six-iso-4217-list-one-2026-01-01'
        || lockedEntry?.numericCode !== entry.iso4217NumericCode
        || lockedEntry?.minorUnit !== entry.iso4217MinorUnit
        || entry.source?.artifactRef?.path
          !== 'reference/authority-reference/six/2026-07-31/iso-4217-list-one/iso-4217-list-one.xml'
        || entry.source?.artifactDigest !== SOURCE_LOCK_EXPECTED.iso4217.rawDigest) {
      addViolation(
        violations,
        'CURRENCY_REGISTRY_ENTRY',
        at,
        'currency registry entry requires the canonical authority/code/minor-unit/status/Currency contract',
      );
    }
  }
  validateVersionIdentityGroups(
    [...currencyRegistry.values()],
    'currencyRegistry',
    (entry) => `${entry.iso4217RegistryAuthority || ''}\0${entry.iso4217AlphaCode || ''}`,
    'CURRENCY_REGISTRY_VERSION_CONFLICT',
    violations,
  );

  for (const [id, authorization] of identifierAuthorizations) {
    const at = `identifierAuthorizations.${id}`;
    validateFact(authorization, at, violations);
    const scheme = identifierSchemes.get(authorization.schemeVersion);
    const facilityCandidates = [...facilities.values()].filter((facility) => (
      facility.logicalId === authorization.facilityLogical
    ));
    if (authorization.active !== true
        || !scheme
        || scheme.logicalId !== authorization.schemeLogical
        || facilityCandidates.length === 0) {
      addViolation(
        violations,
        'IDENTIFIER_AUTHORIZATION_CONTRACT',
        at,
        'authorization must bind one exact scheme version to its logical scheme and a known facility logical identity',
      );
    }
  }
  validateVersionIdentityGroups(
    [...identifierAuthorizations.values()],
    'identifierAuthorizations',
    (authorization) => `${authorization.schemeLogical || ''}\0${authorization.facilityLogical || ''}`,
    'IDENTIFIER_AUTHORIZATION_VERSION_CONFLICT',
    violations,
  );

  function currencyEntriesAt(currencyLogical, consumer) {
    return [...currencyRegistry.values()].filter((entry) => (
      entry.iso4217EntryCurrency === currencyLogical
      && entry.iso4217EntryStatus === 'active'
      && pitEligibleAt(entry, consumer, closures)
    ));
  }

  for (const [id, facility] of facilities) {
    if (!['TradingVenue', 'MarketSegment'].includes(facility.type)
        || !validIri(facility.logicalId)) {
      addViolation(violations, 'FACILITY_TYPE', `facilities.${id}`, 'facility requires TradingVenue or MarketSegment type and logical IRI');
    }
    validateFact(facility, `facilities.${id}`, violations);
    if (facility.type === 'MarketSegment') {
      const venue = eligibleExact(facilities, facility.venue, facility, closures);
      if (venue?.type !== 'TradingVenue') {
        addViolation(violations, 'SEGMENT_VENUE', `facilities.${id}.venue`, 'MarketSegment must reference one PIT-eligible TradingVenue version');
      }
    } else if (facility.venue !== undefined) {
      addViolation(violations, 'SEGMENT_VENUE', `facilities.${id}.venue`, 'TradingVenue must not carry a segment-parent relation');
    }
  }

  for (const [id, party] of parties) {
    if (!validIri(party.logicalId) || !['Party', 'LegalEntity'].includes(party.type)) {
      addViolation(violations, 'PARTY_LOGICAL_ID', `parties.${id}`, 'party version requires Party/LegalEntity type and a logical IRI');
    }
    validateFact(party, `parties.${id}`, violations);
  }

  for (const [id, instrument] of instruments) {
    if (!['FinancialInstrument', 'Security', 'EquitySecurity'].includes(instrument.type)
        || !validIri(instrument.logicalId)) {
      addViolation(violations, 'INSTRUMENT_TYPE', `instruments.${id}`, 'instrument requires an admitted type and logical IRI');
    }
    validateFact(instrument, `instruments.${id}`, violations);
  }

  for (const [id, entry] of micEntries) {
    const at = `micEntries.${id}`;
    validateFact(entry, at, violations, true);
    if (!MIC_RE.test(entry.mic || '')) {
      addViolation(violations, 'MIC_FORMAT', `${at}.mic`, 'MIC must be exactly four uppercase ASCII alphanumeric characters');
    }
    if (!['OPRT', 'SGMT'].includes(entry.entryType)) {
      addViolation(violations, 'MIC_ENTRY_TYPE', `${at}.entryType`, 'MIC entry type must be OPRT or SGMT');
    }
    if (!validIri(entry.authorityLogical)) {
      addViolation(violations, 'MIC_AUTHORITY', `${at}.authorityLogical`, 'registry authority must be a logical IRI');
    }
    const facility = eligibleExact(facilities, entry.facility, entry, closures);
    if (!facility) {
      addViolation(violations, 'MIC_FACILITY', `${at}.facility`, 'registry facility must resolve to an exact PIT-eligible facility version');
    } else if (entry.entryType === 'OPRT') {
      if (facility.type !== 'TradingVenue' || entry.operatingEntry !== undefined) {
        addViolation(violations, 'MIC_OPRT_CONTRACT', at, 'OPRT must identify a TradingVenue and have no operating-entry relation');
      }
    } else if (entry.entryType === 'SGMT') {
      const operating = eligibleExact(micEntries, entry.operatingEntry, entry, closures);
      const segmentVenue = eligibleExact(facilities, facility?.venue, entry, closures);
      const operatingFacility = eligibleExact(facilities, operating?.facility, entry, closures);
      if (facility?.type !== 'MarketSegment'
          || operating?.entryType !== 'OPRT'
          || operatingFacility?.type !== 'TradingVenue'
          || segmentVenue?.logicalId !== operatingFacility?.logicalId) {
        addViolation(violations, 'MIC_SGMT_CONTRACT', at, 'SGMT must identify a MarketSegment and reference the OPRT entry for that segment venue');
      }
    }
    if (!validIri(entry.logicalId)) {
      addViolation(violations, 'MIC_LOGICAL_KEY', `${at}.logicalId`, 'MIC registry entry requires a stable logical IRI');
    }
  }
  validateVersionIdentityGroups(
    [...micEntries.values()],
    'micEntries',
    (entry) => `${entry.authorityLogical || ''}\0${entry.mic || ''}`,
    'MIC_PIT_CONFLICT',
    violations,
  );

  for (const [id, calendar] of calendars) {
    const at = `calendars.${id}`;
    validateFact(calendar, at, violations, true);
    if (eligibleByLogical([...facilities.values()], calendar.facilityLogical, calendar, closures).length !== 1
        || !validIri(calendar.authorityLogical)
        || !validateNfcNonBlank(calendar.authorityCalendarId)
        || !validIri(calendar.jurisdictionLogical)) {
      addViolation(violations, 'CALENDAR_IDENTITY', at, 'calendar requires facility, authority, authority-calendar-id, and jurisdiction logical identities');
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: calendar.timeZone }).format(new Date(0));
    } catch {
      addViolation(violations, 'CALENDAR_TIME_ZONE', `${at}.timeZone`, 'timeZone must resolve in the runtime IANA TZDB');
    }
    if (!validIri(calendar.logicalId)) {
      addViolation(violations, 'CALENDAR_LOGICAL_KEY', `${at}.logicalId`, 'calendar requires a stable logical IRI');
    }
  }
  validateVersionIdentityGroups(
    [...calendars.values()],
    'calendars',
    (calendar) => `${calendar.facilityLogical || ''}\0${calendar.authorityLogical || ''}\0${calendar.authorityCalendarId || ''}`,
    'CALENDAR_VERSION_CHAIN',
    violations,
  );

  for (const [id, template] of templates) {
    const at = `sessionTemplates.${id}`;
    validateFact(template, at, violations, true);
    if (!eligibleExact(calendars, template.calendar, template, closures)
        || !validateNfcNonBlank(template.recurrence)
        || !TIME_RE.test(template.localStart || '')
        || !TIME_RE.test(template.localEnd || '')
        || template.localStart === template.localEnd) {
      addViolation(violations, 'SESSION_TEMPLATE', at, 'template requires exact calendar, recurrence, and a non-empty local-clock interval');
    }
  }

  for (const [id, occurrence] of occurrences) {
    const at = `sessionOccurrences.${id}`;
    validateFact(occurrence, at, violations);
    const template = eligibleExact(templates, occurrence.template, occurrence, closures);
    const calendar = eligibleExact(calendars, occurrence.calendar, occurrence, closures);
    const facility = eligibleExact(facilities, occurrence.facility, occurrence, closures);
    if (!template || !calendar || !facility
        || template.calendar !== occurrence.calendar
        || calendar.facilityLogical !== facility.logicalId) {
      addViolation(violations, 'SESSION_OCCURRENCE_JOIN', at, 'occurrence exact template, calendar, and facility versions must agree');
    }
    if (!validDate(occurrence.businessDate)
        || !validInstant(occurrence.startUtc)
        || !validInstant(occurrence.endUtc)
        || (validInstant(occurrence.startUtc)
          && validInstant(occurrence.endUtc)
          && instantNanoseconds(occurrence.startUtc) >= instantNanoseconds(occurrence.endUtc))) {
      addViolation(violations, 'SESSION_OCCURRENCE_INTERVAL', at, 'occurrence requires a valid business date and non-empty half-open UTC interval');
    }
  }

  for (const [id, exception] of exceptions) {
    const at = `calendarExceptions.${id}`;
    validateFact(exception, at, violations, true);
    const occurrence = eligibleExact(occurrences, exception.occurrence, exception, closures);
    if (!occurrence || exception.businessDate !== occurrence.businessDate) {
      addViolation(violations, 'CALENDAR_EXCEPTION_TARGET', at, 'exception must target an exact occurrence on the same business date');
      continue;
    }
    if (!validInstant(occurrence.startUtc) || !validInstant(occurrence.endUtc)) {
      continue;
    }
    if (exception.kind === 'holiday' || exception.kind === 'closure') {
      if (exception.replacementStartUtc !== undefined || exception.replacementEndUtc !== undefined) {
        addViolation(violations, 'CALENDAR_EXCEPTION_CLOSURE', at, 'holiday/closure removes the occurrence and carries no replacement interval');
      }
    } else if (exception.kind === 'earlySession') {
      if (!validInstant(exception.replacementEndUtc)
          || (validInstant(exception.replacementEndUtc)
            && instantNanoseconds(exception.replacementEndUtc)
              <= instantNanoseconds(occurrence.startUtc))
          || (validInstant(exception.replacementEndUtc)
            && instantNanoseconds(exception.replacementEndUtc)
              >= instantNanoseconds(occurrence.endUtc))
          || exception.replacementStartUtc !== undefined) {
        addViolation(violations, 'CALENDAR_EXCEPTION_EARLY', at, 'earlySession must replace only the end with an earlier non-empty endpoint');
      }
    } else if (exception.kind === 'lateSession') {
      if (!validInstant(exception.replacementStartUtc)
          || (validInstant(exception.replacementStartUtc)
            && instantNanoseconds(exception.replacementStartUtc)
              <= instantNanoseconds(occurrence.startUtc))
          || (validInstant(exception.replacementStartUtc)
            && instantNanoseconds(exception.replacementStartUtc)
              >= instantNanoseconds(occurrence.endUtc))
          || exception.replacementEndUtc !== undefined) {
        addViolation(violations, 'CALENDAR_EXCEPTION_LATE', at, 'lateSession must replace only the start with a later non-empty endpoint');
      }
    } else {
      addViolation(violations, 'CALENDAR_EXCEPTION_KIND', `${at}.kind`, 'exception kind is outside the closed profile');
    }
  }

  for (const [id, context] of otcContexts) {
    const at = `otcContexts.${id}`;
    validateFact(context, at, violations, true);
    const provider = eligibleExact(parties, context.sourceProvider, context, closures);
    if (!provider) {
      addViolation(violations, 'OTC_PROVIDER', `${at}.sourceProvider`, 'source provider must resolve to an exact PIT-eligible Party version');
    }
    if (!validateNfcNonBlank(context.providerContextId)
        || !validIri(context.sourceContractRef)
        || !DIGEST_RE.test(context.sourceContractDigest || '')) {
      addViolation(violations, 'OTC_SOURCE_CONTRACT', at, 'providerContextId and immutable source-contract ref/digest are required');
    }
    if (context.marketConvention !== 'directQuotePerUnit') {
      addViolation(violations, 'OTC_MARKET_CONVENTION', `${at}.marketConvention`, 'market convention is outside the v0.3 closed profile');
    }
    if (!validIri(context.quoteCurrency)
        || currencyEntriesAt(context.quoteCurrency, context).length !== 1) {
      addViolation(violations, 'OTC_QUOTE_CURRENCY', `${at}.quoteCurrency`, 'quote Currency must have exactly one PIT-eligible registry entry');
    }
    if (context.settlementCurrency !== undefined
        && (!validIri(context.settlementCurrency)
          || currencyEntriesAt(context.settlementCurrency, context).length !== 1)) {
      addViolation(violations, 'OTC_SETTLEMENT_CURRENCY', `${at}.settlementCurrency`, 'settlement Currency must have exactly one PIT-eligible registry entry when present');
    }
    if (context.reportingFacility !== undefined
        && !eligibleExact(facilities, context.reportingFacility, context, closures)) {
      addViolation(violations, 'OTC_REPORTING_FACILITY', `${at}.reportingFacility`, 'reporting facility must resolve to an exact PIT-eligible TradingFacility version');
    }
    const hasA = context.counterpartyA !== undefined;
    const hasB = context.counterpartyB !== undefined;
    if (hasA !== hasB) {
      addViolation(violations, 'OTC_COUNTERPARTY_PAIR', at, 'counterparties must be both absent or both present');
    } else if (hasA) {
      const partyA = eligibleExact(parties, context.counterpartyA, context, closures);
      const partyB = eligibleExact(parties, context.counterpartyB, context, closures);
      const logicalA = partyA?.logicalId;
      const logicalB = partyB?.logicalId;
      if (!logicalA || !logicalB || logicalA >= logicalB) {
        addViolation(violations, 'OTC_COUNTERPARTY_CANONICAL_ORDER', at, 'counterparties must be exact PIT-eligible, different, and ordered by logical IRI');
      }
    }
    if (!validIri(context.logicalId)) {
      addViolation(violations, 'OTC_LOGICAL_KEY', `${at}.logicalId`, 'OTC context requires a stable logical IRI');
    }
  }
  validateVersionIdentityGroups(
    [...otcContexts.values()],
    'otcContexts',
    (context) => {
      const provider = parties.get(context.sourceProvider);
      return `${provider?.logicalId || ''}\0${context.sourceContractRef || ''}\0${context.providerContextId || ''}`;
    },
    'OTC_VERSION_CONFLICT',
    violations,
  );

  for (const [id, scheme] of identifierSchemes) {
    if (!validIri(scheme.logicalId) || !['venueListing'].includes(scheme.kind)) {
      addViolation(violations, 'IDENTIFIER_SCHEME', `identifierSchemes.${id}`, 'listing fixture admits only venueListing schemes with logical IRIs');
    }
    validateFact(scheme, `identifierSchemes.${id}`, violations, true);
  }
  for (const [id, value] of identifierValues) {
    if (!validIri(value.logicalId) || !identifierSchemesByLogical.has(value.schemeLogical)
        || !validateNfcNonBlank(value.lexicalValue)) {
      addViolation(violations, 'IDENTIFIER_VALUE', `identifierValues.${id}`, 'LocalIdentifierValue requires logical IRI, logical scheme reference, and non-empty lexical form');
    }
    validateFact(value, `identifierValues.${id}`, violations);
  }

  for (const [id, offering] of offerings) {
    const at = `offerings.${id}`;
    validateFact(offering, at, violations, true);
    const security = eligibleExact(instruments, offering.offeredSecurity, offering, closures);
    if (!validateNfcNonBlank(offering.offeringId)) {
      addViolation(violations, 'OFFERING_ID', at, 'SecurityOffering requires a non-empty NFC offeringId');
    }
    if (!security || !['Security', 'EquitySecurity'].includes(security.type)) {
      addViolation(violations, 'OFFERED_SECURITY', at, 'SecurityOffering must offer one exact PIT-eligible Security version');
    }
  }

  for (const [id, issuance] of issuances) {
    const at = `issuances.${id}`;
    validateFact(issuance, at, violations, true);
    const security = eligibleExact(instruments, issuance.issuedSecurity, issuance, closures);
    const issuer = eligibleExact(parties, issuance.issuer, issuance, closures);
    if (!validateNfcNonBlank(issuance.issuanceId)) {
      addViolation(violations, 'ISSUANCE_ID', at, 'InstrumentIssuance requires a non-empty NFC issuanceId');
    }
    if (!security || !['Security', 'EquitySecurity'].includes(security.type) || issuer?.type !== 'LegalEntity') {
      addViolation(violations, 'ISSUANCE_ROLES', at, 'issuance requires exact PIT-eligible Security and LegalEntity versions');
    }
    const originatingOffering = issuance.originatingOffering === undefined
      ? null
      : eligibleExact(offerings, issuance.originatingOffering, issuance, closures);
    if (issuance.originatingOffering !== undefined
        && (!originatingOffering
          || originatingOffering.offeredSecurity !== issuance.issuedSecurity)) {
      addViolation(violations, 'ISSUANCE_OFFERING_JOIN', at, 'originating offering must offer the exact issued Security version');
    }
  }

  const controlledQuantityUnits = new Map();
  for (const [position, entry] of array(document.quantityUnitRegistry).entries()) {
    const lockedUnit = lockedQuantityRegistry?.registry?.units?.find((unit) => (
      unit.unitIri === entry?.unitIri
    ));
    const joined = entry?.controlled === true
        && validIri(entry.unitIri)
        && Boolean(lockedUnit)
        && lockedUnit.controlled === true
        && array(lockedUnit.allowedApplications).includes(entry.allowedApplication)
        && entry.allowedApplication === 'directUnitPriceQuotationDenominator'
        && entry.registryRef
          === 'https://axiolune.ai/references/axiolune-m2-controlled-quantity-units'
        && entry.registryVersion === lockedQuantityRegistry?.registry?.candidateVersion
        && entry.registryCandidateDigest === lockedQuantityRegistry?.registry?.candidateDigest
        && entry.registryArtifactDigest === lockedQuantityRegistry?.rawDigest
        && entry.decisionStatus === lockedQuantityRegistry?.registry?.decision?.status;
    if (!joined) {
      addViolation(
        violations,
        'QUANTITY_UNIT_REGISTRY_ENTRY',
        `quantityUnitRegistry[${position}]`,
        'unit must join the exact digest-locked candidate member and allowed-application contract',
      );
      continue;
    }
    controlledQuantityUnits.set(
      entry.unitIri,
      (controlledQuantityUnits.get(entry.unitIri) || 0) + 1,
    );
  }
  for (const [id, listing] of listings) {
    const at = `listings.${id}`;
    validateFact(listing, at, violations, true);
    const facility = eligibleExact(facilities, listing.facility, listing, closures);
    const eligibleSchemes = eligibleByLogical(
      [...identifierSchemes.values()],
      listing.identifierScheme,
      listing,
      closures,
    );
    const eligibleValues = eligibleByLogical(
      [...identifierValues.values()],
      listing.identifierValue,
      listing,
      closures,
    );
    const scheme = eligibleSchemes.length === 1 ? eligibleSchemes[0] : null;
    const value = eligibleValues.length === 1 ? eligibleValues[0] : null;
    const instrument = eligibleExact(instruments, listing.instrument, listing, closures);
    if (!facility || !scheme || scheme.kind !== 'venueListing'
        || !value || value.schemeLogical !== listing.identifierScheme
        || !instrument) {
      addViolation(violations, 'LISTING_IDENTITY_PATH', at, 'listing direct facility/scheme/value/instrument path is not uniquely PIT-eligible or is incompatible');
    }
    const coveringAuthorizations = [...identifierAuthorizations.values()].filter((authorization) => (
      authorization?.active === true
      && identifierSchemes.get(authorization.schemeVersion)?.logicalId === authorization.schemeLogical
      && authorization.schemeLogical === listing.identifierScheme
      && authorization.facilityLogical === facility?.logicalId
      && pitEligibleAt(authorization, listing, closures)
      && (authorization.validTo === undefined
        || (validInstant(authorization.validTo)
          && listing.validTo !== undefined
          && validInstant(listing.validTo)
          && instantNanoseconds(authorization.validTo)
            >= instantNanoseconds(listing.validTo)))
    ));
    if (coveringAuthorizations.length !== 1) {
      addViolation(violations, 'LISTING_SCHEME_AUTHORIZATION', at, 'venue-listing scheme requires exactly one PIT-eligible active facility authorization covering the listing interval');
    }
    if (!validIri(listing.quoteCurrency)
        || currencyEntriesAt(listing.quoteCurrency, listing).length !== 1) {
      addViolation(violations, 'LISTING_QUOTE_CURRENCY', at, 'listing requires exactly one logical Currency with PIT-eligible registry evidence');
    }
    if (listing.quoteCurrencyLiteral !== undefined) {
      addViolation(violations, 'LISTING_LITERAL_CURRENCY', at, 'literal quote-currency substitute is forbidden');
    }
    if (!validDate(listing.businessFrom)
        || (listing.businessTo !== undefined
          && (!validDate(listing.businessTo) || listing.businessFrom >= listing.businessTo))) {
      addViolation(violations, 'LISTING_BUSINESS_INTERVAL', at, 'listing business dates must form a valid half-open interval');
    }
    if (validDate(listing.businessFrom) && validInstant(listing.validFrom)
        && listing.businessFrom < listing.validFrom.slice(0, 10)) {
      addViolation(violations, 'LISTING_VALID_INTERVAL', at, 'listing business interval starts before fact validFrom');
    }
    if (listing.businessTo !== undefined && validInstant(listing.validTo)
        && listing.businessTo > listing.validTo.slice(0, 10)) {
      addViolation(violations, 'LISTING_VALID_INTERVAL', at, 'listing business interval ends after fact validTo');
    }
    const originatingOffering = listing.originatingOffering === undefined
      ? null
      : eligibleExact(offerings, listing.originatingOffering, listing, closures);
    if (listing.originatingOffering !== undefined
        && (!originatingOffering
          || originatingOffering.offeredSecurity !== listing.instrument)) {
      addViolation(violations, 'LISTING_OFFERING_JOIN', at, 'listed instrument must equal the originating offering Security');
    }
    if (!validIri(listing.logicalId)) {
      addViolation(violations, 'LISTING_LOGICAL_KEY', `${at}.logicalId`, 'listing requires a stable logical IRI');
    }
  }
  validateVersionIdentityGroups(
    [...listings.values()],
    'listings',
    (listing) => {
      const facility = facilities.get(listing.facility);
      const scheme = identifierSchemesByLogical.get(listing.identifierScheme);
      const value = identifierValuesByLogical.get(listing.identifierValue);
      return `${facility?.logicalId || ''}\0${scheme?.logicalId || ''}\0${value?.logicalId || ''}`;
    },
    'LISTING_VERSION_CONFLICT',
    violations,
  );

  for (const [id, quotation] of quotations) {
    const at = `quotationContracts.${id}`;
    validateFact(quotation, at, violations, true);
    const hasListing = quotation.listingContext !== undefined;
    const hasOtc = quotation.otcContext !== undefined;
    if (hasListing === hasOtc) {
      addViolation(violations, 'QUOTATION_CONTEXT_XONE', at, 'quotation must select exactly one listing or OTC context');
    }
    const eligibleInstruments = eligibleByLogical(
      [...instruments.values()],
      quotation.instrumentLogical,
      quotation,
      closures,
    );
    if (eligibleInstruments.length !== 1) {
      addViolation(violations, 'QUOTATION_INSTRUMENT', at, 'quotation instrument must resolve to exactly one PIT-eligible FinancialInstrument version');
    }
    if (hasListing) {
      const listing = eligibleExact(listings, quotation.listingContext, quotation, closures);
      const listed = eligibleExact(instruments, listing?.instrument, quotation, closures);
      if (!listing
          || listed?.logicalId !== quotation.instrumentLogical
          || listing.quoteCurrency !== quotation.quoteCurrency) {
        addViolation(violations, 'QUOTATION_LISTING_JOIN', at, 'listing branch must be PIT-eligible and its instrument/currency must equal the exact listing truths');
      }
    }
    if (hasOtc) {
      const context = eligibleExact(otcContexts, quotation.otcContext, quotation, closures);
      if (!context || context.quoteCurrency !== quotation.quoteCurrency) {
        addViolation(violations, 'QUOTATION_OTC_JOIN', at, 'OTC branch must be PIT-eligible and its quote currency must equal the exact OTC-context truth');
      }
    }
    if (currencyEntriesAt(quotation.quoteCurrency, quotation).length !== 1) {
      addViolation(violations, 'QUOTATION_CURRENCY_REGISTRY', at, 'quotation quote Currency lacks PIT-eligible registry evidence');
    }
    if (!validIri(quotation.denominatorUnit)
        || controlledQuantityUnits.get(quotation.denominatorUnit) !== 1) {
      addViolation(violations, 'QUOTATION_DENOMINATOR_UNIT', at, 'quotation denominator unit must be an absolute IRI in the controlled Quantity-unit registry');
    }
    if (!Array.isArray(quotation.consumedQuantityUnits)
        || quotation.consumedQuantityUnits.length === 0) {
      addViolation(violations, 'QUOTATION_UNIT_MISMATCH', `${at}.consumedQuantityUnits`, 'quotation requires at least one consumed Quantity unit');
    }
    for (const [index, unit] of array(quotation.consumedQuantityUnits).entries()) {
      if (unit !== quotation.denominatorUnit) {
        addViolation(violations, 'QUOTATION_UNIT_MISMATCH', `${at}.consumedQuantityUnits[${index}]`, 'consumed Quantity unit must equal the quotation denominator unit');
      }
    }
    if (quotation.quotationKind !== 'directUnitPrice') {
      addViolation(violations, 'QUOTATION_KIND', at, 'only directUnitPrice is admitted in v0.3');
    }
    if (!isDecimalLexical(quotation.contractMultiplier)
        || (isDecimalLexical(quotation.contractMultiplier)
          && compareDecimalLexical(quotation.contractMultiplier, '1') !== 0)) {
      addViolation(violations, 'QUOTATION_MULTIPLIER', at, 'contract multiplier must be an explicit decimal lexical string exactly equal to dimensionless one');
    }
    const unsupported = array(quotation.unsupportedApplications);
    if (unsupported.length > 0) {
      addViolation(violations, 'QUOTATION_UNSUPPORTED_APPLICATION', at, `unsupported quotation applications: ${unsupported.join(',')}`);
    }
    if (!validIri(quotation.normalizationContractRef)
        || !DIGEST_RE.test(quotation.normalizationContractDigest || '')) {
      addViolation(violations, 'QUOTATION_NORMALIZATION_CONTRACT', at, 'quotation requires immutable normalization contract ref/digest');
    }
    if (!validIri(quotation.logicalId)) {
      addViolation(violations, 'QUOTATION_LOGICAL_KEY', `${at}.logicalId`, 'quotation contract requires a stable logical IRI');
    }
  }
  validateVersionIdentityGroups(
    [...quotations.values()],
    'quotationContracts',
    (quotation) => {
      const context = quotation.listingContext === undefined
        ? otcContexts.get(quotation.otcContext)
        : listings.get(quotation.listingContext);
      return `${quotation.instrumentLogical || ''}\0${context?.logicalId || ''}\0${quotation.quoteCurrency || ''}\0${quotation.denominatorUnit || ''}`;
    },
    'QUOTATION_VERSION_CONFLICT',
    violations,
  );

  return violations;
}

module.exports = {
  EXACT,
  LOGICAL,
  PROVENANCE,
  TEMPORAL,
  auditModuleContract,
  closesExternalTermAlignment,
  validateScenario,
};
