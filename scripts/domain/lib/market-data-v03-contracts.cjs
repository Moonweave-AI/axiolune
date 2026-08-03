'use strict';

const crypto = require('node:crypto');
const {
  compareDecimalLexical,
  decimalProductWithin,
  isDecimalLexical,
} = require('./decimal-lexical.cjs');
const {
  NANOSECONDS_PER_SECOND,
  compareUtcInstantLexical,
  isUtcInstantLexical,
  utcInstantDifferenceNanoseconds,
} = require('./instant-lexical.cjs');
const {
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');
const {
  expectedReciprocalLexical,
  validateScenarioSourceEvidence,
  validateScenarioReleaseEvidence,
} = require('./market-data-release-evidence.cjs');
const {
  CODE_LIST_AUTHORITY_REFERENCE_IRI,
  validateCodeListAuthority,
} = require('./source-evidence-reference.cjs');
const {
  effectivePatternInjectedAttributeUse,
} = require('./pattern-injected-fields.cjs');
const {
  buildFactClosureAssertionIri,
} = require('./fact-closure-identity.cjs');

const BASE = 'https://axiolune.ai/ontology/finance/market-data/';
const TEMPORAL = 'https://axiolune.ai/ontology/meta/patterns/TemporalFact';
const PROVENANCE = 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact';
const REVISION = 'https://axiolune.ai/ontology/meta/patterns/attributes/revision';
const LOGICAL = 'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference';
const EXACT = 'https://axiolune.ai/ontology/meta/core/constraints/ExactVersionReference';
const MONEY = 'https://axiolune.ai/ontology/meta/core/values/MonetaryAmount';
const QUANTITY = 'https://axiolune.ai/ontology/meta/core/values/QuantityValue';
const PENDING_EVIDENCE = 'https://axiolune.ai/pending-source-evidence/';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]+$/u;

const PURPOSE_BY_TYPE = Object.freeze({
  PriceObservation: 'priceObservation',
  QuoteObservation: 'quoteObservation',
  TradeObservation: 'tradeObservation',
  TradeBar: 'tradeBar',
  QuoteBar: 'quoteBar',
  FXRateObservation: 'fxRateObservation',
});

const PRICE_KINDS = Object.freeze([
  'last', 'mid', 'open', 'high', 'low', 'close', 'settlement', 'vwap', 'twap',
]);
const DERIVED_PRICE_EVIDENCE_FIELDS = Object.freeze([
  'calculationDefinitionRef',
  'calculationDefinitionDigest',
  'calculationRunRef',
  'calculationRunDigest',
  'calculationInputSetDigest',
]);
const BAR_AGGREGATIONS = Object.freeze(['time', 'tick', 'volume', 'notional', 'range', 'renko']);
const QUANTITY_ROUNDINGS = Object.freeze(['floor', 'ceiling', 'half-up', 'half-even']);

const CONSTRAINT_PROFILE = Object.freeze({
  MarketDataStreamIdentityContract: {
    language: 'Custom',
    expressionDigest: 'sha256:9bb36b422fbf6191760afc7368c4ae38627d92518ca1b38e0aba85d0b2a8b30d',
    targetElement: `${BASE}MarketDataStream`,
    bindingTargets: ['MarketDataStream'],
  },
  BarSpecificationContract: {
    language: 'Custom',
    expressionDigest: 'sha256:8808e137e24c4ff4543f756efe470a24bb86a6747a61941b8f741ed6474fd9fb',
    targetElement: `${BASE}BarSpecification`,
    bindingTargets: ['BarSpecification'],
  },
  ObservationIdentityAndRevisionContract: {
    language: 'Custom',
    expressionDigest: 'sha256:baa5446cca7020080014507af8b8c2d7b32806323a430d737b8d39d303d212f0',
    bindingTargets: ['PriceObservation', 'QuoteObservation', 'TradeObservation', 'TradeBar', 'QuoteBar', 'FXRateObservation'],
  },
  ObservationContextXoneContract: {
    language: 'SHACL',
    expressionDigest: 'sha256:e9ae0ca48b5f50478efe0c85cb6bc98f1dc351eaf978c7a17cedbbb5dbbfb687',
    targetElement: `${BASE}PriceObservation`,
    bindingTargets: ['PriceObservation'],
  },
  QuoteObservationContextXoneContract: {
    language: 'SHACL',
    expressionDigest: 'sha256:e9ae0ca48b5f50478efe0c85cb6bc98f1dc351eaf978c7a17cedbbb5dbbfb687',
    targetElement: `${BASE}QuoteObservation`,
    bindingTargets: ['QuoteObservation'],
  },
  TradeObservationContextXoneContract: {
    language: 'SHACL',
    expressionDigest: 'sha256:e9ae0ca48b5f50478efe0c85cb6bc98f1dc351eaf978c7a17cedbbb5dbbfb687',
    targetElement: `${BASE}TradeObservation`,
    bindingTargets: ['TradeObservation'],
  },
  TradeBarContextXoneContract: {
    language: 'SHACL',
    expressionDigest: 'sha256:e9ae0ca48b5f50478efe0c85cb6bc98f1dc351eaf978c7a17cedbbb5dbbfb687',
    targetElement: `${BASE}TradeBar`,
    bindingTargets: ['TradeBar'],
  },
  QuoteBarContextXoneContract: {
    language: 'SHACL',
    expressionDigest: 'sha256:e9ae0ca48b5f50478efe0c85cb6bc98f1dc351eaf978c7a17cedbbb5dbbfb687',
    targetElement: `${BASE}QuoteBar`,
    bindingTargets: ['QuoteBar'],
  },
  ObservationContextQuotationContract: {
    language: 'Custom',
    expressionDigest: 'sha256:af0c31cdcbcb58890b2864e5a1fcc9b28d8e09de834ee616a6bc2b2711b5df08',
    bindingTargets: ['PriceObservation', 'QuoteObservation', 'TradeObservation', 'TradeBar', 'QuoteBar'],
  },
  PriceKindCompatibilityContract: {
    language: 'Custom',
    expressionDigest: 'sha256:a5d882c45326c0bac132e45634747fe0c757260dac90580be411d7a2cf576f39',
    bindingTargets: ['PriceObservation', 'QuoteObservation', 'TradeObservation', 'TradeBar', 'QuoteBar'],
  },
  QuoteObservationContract: {
    language: 'Custom',
    expressionDigest: 'sha256:30a4e30fe148b28bffd792e0af66c1be0270dfbb054b2c01027c886527ae70c4',
    targetElement: `${BASE}QuoteObservation`,
    bindingTargets: ['QuoteObservation'],
  },
  TradeObservationContract: {
    language: 'Custom',
    expressionDigest: 'sha256:4c2e0ba8489f2b0f1bcc4e0758489f8a6bf892175f613773987fb60ddc6edf06',
    targetElement: `${BASE}TradeObservation`,
    bindingTargets: ['TradeObservation'],
  },
  TradeBarContract: {
    language: 'Custom',
    expressionDigest: 'sha256:f40ef25c6dce70f90eb5b06e790deb5b610216cf396d74226959a8a4db9a9f23',
    targetElement: `${BASE}TradeBar`,
    bindingTargets: ['TradeBar'],
  },
  QuoteBarContract: {
    language: 'Custom',
    expressionDigest: 'sha256:25b1996e0e67386f1611d004926e302e7d8314cdf971a607cb05b74e95495525',
    targetElement: `${BASE}QuoteBar`,
    bindingTargets: ['QuoteBar'],
  },
  BarInstanceBranchContract: {
    language: 'Custom',
    expressionDigest: 'sha256:a9f85632760af9577d5437ce377cd8f7b463467cd63390d89b8c05dfbe9fd6a6',
    bindingTargets: ['TradeBar', 'QuoteBar'],
  },
  MarketDataQualityFindingContract: {
    language: 'Custom',
    expressionDigest: 'sha256:644612b8c19462f01cccf6e1dacfb9307ca52c689a7240b33cfc2363b15bf917',
    targetElement: `${BASE}MarketDataQualityFinding`,
    bindingTargets: ['MarketDataQualityFinding'],
  },
  FXObservationContextXoneContract: {
    language: 'SHACL',
    expressionDigest: 'sha256:e9ae0ca48b5f50478efe0c85cb6bc98f1dc351eaf978c7a17cedbbb5dbbfb687',
    targetElement: `${BASE}FXRateObservation`,
    bindingTargets: ['FXRateObservation'],
  },
  FXRateObservationContract: {
    language: 'Custom',
    expressionDigest: 'sha256:9fbee82aae96edcbd3eaf154c7ce6bfc0365e81545475ead8fe68d7bd059b2a7',
    targetElement: `${BASE}FXRateObservation`,
    bindingTargets: ['FXRateObservation'],
  },
  ThreeAxisPITContract: {
    language: 'Custom',
    expressionDigest: 'sha256:c7803a3d41eb0c5f22e646612d57dbd40386c34be925e01cba884c5f60be48ea',
    bindingTargets: ['PriceObservation', 'QuoteObservation', 'TradeObservation', 'TradeBar', 'QuoteBar', 'MarketDataQualityFinding', 'FXRateObservation'],
  },
  ThreeAxisObjectPITContract: {
    language: 'Custom',
    expressionDigest: 'sha256:c7803a3d41eb0c5f22e646612d57dbd40386c34be925e01cba884c5f60be48ea',
    bindingTargets: ['MarketDataStream', 'BarSpecification'],
  },
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function entries(value) {
  return isObject(value) ? Object.entries(value) : [];
}

function addFinding(findings, code, at, message) {
  findings.push({ code, at, message });
}

function validIri(value) {
  return typeof value === 'string'
    && IRI_RE.test(value)
    && value === value.normalize('NFC');
}

function validNfc(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value === value.normalize('NFC');
}

function tupleKey(values) {
  return JSON.stringify(values);
}

function identityBijectionState() {
  return { keyToLogical: new Map(), logicalToKey: new Map() };
}

function validateIdentityBijection(state, logicalIri, components, code, at, violations) {
  if (!validIri(logicalIri) || components.some((value) => value === undefined)) return;
  const key = tupleKey(components);
  const priorKey = state.logicalToKey.get(logicalIri);
  const priorLogical = state.keyToLogical.get(key);
  if ((priorKey !== undefined && priorKey !== key)
      || (priorLogical !== undefined && priorLogical !== logicalIri)) {
    addFinding(
      violations,
      code,
      at,
      'logical IRI and declared logical-key components must form a bijection',
    );
    return;
  }
  state.logicalToKey.set(logicalIri, key);
  state.keyToLogical.set(key, logicalIri);
}

function validInstant(value) {
  return isUtcInstantLexical(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasExactlyOnePattern(element, pattern) {
  return array(element?.patternBindings)
    .filter((binding) => binding?.pattern === pattern).length === 1;
}

function attributeUse(element, localName) {
  return array(element?.attributeUses).find((use) => use?.attribute === `${BASE}${localName}`
    || use?.attribute === localName);
}

function referenceBindings(document, targetElement) {
  return array(document?.domain?.constraintBindings)
    .filter((binding) => binding?.targetElement === targetElement
      && [LOGICAL, EXACT].includes(binding?.constraintRef));
}

function relationUse(document, relationName) {
  return array(document?.domain?.relationUses)
    .find((use) => use?.relation === `${BASE}${relationName}`);
}

function auditModuleContract(document, options = {}) {
  const violations = [];
  const pending = [];
  const domain = document?.domain || {};

  if (document?.module?.moduleIri !== BASE.slice(0, -1)
      || document?.module?.baseIri !== BASE
      || document?.module?.version !== '0.3.0') {
    addFinding(violations, 'ONTOLOGY_MODULE_IDENTITY', 'module', 'Market Data must use the canonical v0.3.0 module and base IRIs');
  }
  const moduleStatus = document?.module?.status;
  const governanceStatus = document?.module?.governance?.status;
  if (!['draft', 'approved'].includes(moduleStatus) || governanceStatus !== moduleStatus) {
    addFinding(violations, 'ONTOLOGY_LIFECYCLE_STATUS', 'module.status', 'module and governance status must agree and be draft or approved');
  }

  const requiredContainers = [
    ['objectTypes', false], ['associationTypes', false], ['relationTypes', false],
    ['attributeTypes', false], ['identifierTypes', false], ['codeLists', false],
    ['constraints', false], ['relationUses', true], ['constraintBindings', true],
  ];
  for (const [name, list] of requiredContainers) {
    if (list ? !Array.isArray(domain[name]) : !isObject(domain[name])) {
      addFinding(violations, 'ONTOLOGY_TYPED_CONTAINER', `domain.${name}`, 'missing M3 v0.6 typed container');
    }
  }

  const expectedImports = [
    'https://axiolune.ai/ontology/finance/foundation',
    'https://axiolune.ai/ontology/finance/market-structure',
    'https://axiolune.ai/ontology/finance/instruments',
    'https://axiolune.ai/ontology/finance/market-rules',
  ];
  const imports = array(document?.module?.imports);
  if (imports.map((item) => item?.moduleIri).join('\0') !== expectedImports.join('\0')) {
    addFinding(violations, 'ONTOLOGY_IMPORT_DAG', 'module.imports', 'Market Data import order must be Foundation, Market Structure, Instruments, Market Rules');
  }
  imports.forEach((item, index) => {
    if (item?.version !== '0.3.0' || item?.importMode !== 'All' || !DIGEST_RE.test(item?.artifactDigest || '')) {
      addFinding(violations, 'ONTOLOGY_IMPORT_LOCK', `module.imports[${index}]`, 'import must lock version 0.3.0, All mode, and a lowercase SHA-256 digest');
    }
  });

  const requiredObjects = ['MarketDataStream', 'BarSpecification'];
  const requiredAssociations = [
    'PriceObservation', 'QuoteObservation', 'TradeObservation', 'TradeBar',
    'QuoteBar', 'MarketDataQualityFinding', 'FXRateObservation',
  ];
  for (const name of requiredObjects) {
    if (!domain.objectTypes?.[name]) addFinding(violations, 'ONTOLOGY_OBJECT_TYPE', `domain.objectTypes.${name}`, 'required ObjectTypeDefinition is absent');
  }
  for (const name of requiredAssociations) {
    if (!domain.associationTypes?.[name]) addFinding(violations, 'ONTOLOGY_ASSOCIATION_TYPE', `domain.associationTypes.${name}`, 'required AssociationTypeDefinition is absent');
  }
  for (const forbidden of ['Bar', 'QuoteSide', 'SecurityPrice']) {
    if (domain.objectTypes?.[forbidden] || domain.associationTypes?.[forbidden]) {
      addFinding(violations, 'ONTOLOGY_FORBIDDEN_LEGACY', `domain.${forbidden}`, 'legacy or competing classifier is forbidden');
    }
  }
  for (const forbidden of ['hasCurrencyCode', 'currencyCode', 'eventTime', 'providerStream']) {
    if (domain.attributeTypes?.[forbidden] || domain.relationTypes?.[forbidden]) {
      addFinding(violations, 'ONTOLOGY_FORBIDDEN_LEGACY', `domain.${forbidden}`, 'duplicate currency, event-time, or untyped stream truth is forbidden');
    }
  }

  const materialized = [
    ...requiredObjects.map((name) => [name, domain.objectTypes?.[name]]),
    ...requiredAssociations.map((name) => [name, domain.associationTypes?.[name]]),
  ];
  for (const [name, element] of materialized) {
    if (!element) continue;
    if (!hasExactlyOnePattern(element, TEMPORAL) || !hasExactlyOnePattern(element, PROVENANCE)) {
      addFinding(violations, 'ONTOLOGY_FACT_PATTERNS', name, 'materialized type must bind TemporalFact and ProvenancedFact exactly once');
    }
    const revision = effectivePatternInjectedAttributeUse(element, REVISION);
    if (!revision || revision.minCount !== 1 || revision.maxCount !== 1) {
      addFinding(
        violations,
        'ONTOLOGY_VERSION_KEY',
        name,
        'the effective ProvenancedFact profile must inject revision exactly once with cardinality 1..1',
      );
    }
  }

  const expectedRoleInventories = {
    PriceObservation: ['observationStream', 'observedInstrument', 'observedListing', 'observedOtcContext', 'quotationContract'],
    QuoteObservation: ['observationStream', 'observedInstrument', 'observedListing', 'observedOtcContext', 'quotationContract'],
    TradeObservation: ['observationStream', 'observedInstrument', 'observedListing', 'observedOtcContext', 'quotationContract'],
    TradeBar: ['observationStream', 'observedInstrument', 'observedListing', 'observedOtcContext', 'quotationContract', 'barSpecification'],
    QuoteBar: ['observationStream', 'observedInstrument', 'observedListing', 'observedOtcContext', 'quotationContract', 'barSpecification'],
    MarketDataQualityFinding: ['findingStream', 'affectedPriceObservation', 'affectedQuoteObservation', 'affectedTradeObservation', 'affectedTradeBar', 'affectedQuoteBar', 'affectedFxRateObservation'],
    FXRateObservation: ['observationStream', 'baseCurrency', 'quoteCurrency', 'observedListing', 'observedOtcContext'],
  };
  for (const [name, expectedRoles] of Object.entries(expectedRoleInventories)) {
    const association = domain.associationTypes?.[name];
    if (!association) continue;
    const actualRoles = array(association.participantRoles);
    if (actualRoles.map((role) => role?.id).join('\0') !== expectedRoles.join('\0')) {
      addFinding(violations, 'ONTOLOGY_ROLE_INVENTORY', name, `participant roles must be ${expectedRoles.join(', ')}`);
    }
    for (const role of actualRoles) {
      const roleIri = `${association.iri}/role/${role.id}`;
      if (!validNfc(role.label) || !validNfc(role.definition)) {
        addFinding(violations, 'ONTOLOGY_ROLE_SEMANTICS', roleIri, 'public ParticipantRole requires label and definition');
      }
      const bindings = referenceBindings(document, roleIri);
      const expectedMode = ['baseCurrency', 'quoteCurrency'].includes(role.id) ? LOGICAL : EXACT;
      if (bindings.length !== 1 || bindings[0].constraintRef !== expectedMode) {
        addFinding(violations, 'ONTOLOGY_ROLE_REFERENCE_MODE', roleIri, `expected exactly one ${expectedMode} binding`);
      }
    }
  }

  const observationFields = {
    PriceObservation: ['priceValue', 'priceKind', 'providerObservationId', 'sourceOrderKey'],
    QuoteObservation: ['bidPrice', 'bidSize', 'askPrice', 'askSize', 'providerObservationId', 'sourceOrderKey'],
    TradeObservation: ['tradePrice', 'tradeSize', 'priceKind', 'sourceTradeId', 'sourceOrderKey'],
    TradeBar: ['tradeOpenPrice', 'tradeHighPrice', 'tradeLowPrice', 'tradeClosePrice', 'tradeVolume', 'providerObservationId', 'sourceOrderKey'],
    QuoteBar: ['bidOpenPrice', 'bidHighPrice', 'bidLowPrice', 'bidClosePrice', 'askOpenPrice', 'askHighPrice', 'askLowPrice', 'askClosePrice', 'lastBidSize', 'lastAskSize', 'providerObservationId', 'sourceOrderKey'],
    FXRateObservation: ['fxRate', 'providerObservationId', 'sourceOrderKey'],
  };
  for (const [name, fields] of Object.entries(observationFields)) {
    const association = domain.associationTypes?.[name];
    for (const field of fields) {
      const use = attributeUse(association, field);
      if (!use || use.minCount !== 1 || use.maxCount !== 1) {
        addFinding(violations, 'ONTOLOGY_ATTRIBUTE_USE', `${name}.${field}`, 'required field must have exactly-one AttributeUse');
      }
    }
    for (const optional of ['sourceRevisionToken', 'sourceRevisionOrder']) {
      const use = attributeUse(association, optional);
      if (!use || use.minCount !== 0 || use.maxCount !== 1) {
        addFinding(violations, 'ONTOLOGY_REVISION_USE', `${name}.${optional}`, 'source revision fields must be authored optional 0..1 and constrained by revision mode');
      }
    }
  }

  for (const field of DERIVED_PRICE_EVIDENCE_FIELDS) {
    const use = attributeUse(domain.associationTypes?.PriceObservation, field);
    if (!use || use.minCount !== 0 || use.maxCount !== 1) {
      addFinding(
        violations,
        'ONTOLOGY_DERIVED_PRICE_EVIDENCE',
        `PriceObservation.${field}`,
        'each derived-price definition, run, and input-set evidence field must be authored optional 0..1',
      );
    }
    for (const name of requiredAssociations.filter((item) => item !== 'PriceObservation')) {
      if (attributeUse(domain.associationTypes?.[name], field)) {
        addFinding(
          violations,
          'ONTOLOGY_DERIVED_PRICE_EVIDENCE',
          `${name}.${field}`,
          'derived-price calculation evidence belongs only to PriceObservation',
        );
      }
    }
  }
  const derivedPriceTypesValid = domain.attributeTypes?.calculationDefinitionRef?.valueType === 'uri'
    && domain.attributeTypes?.calculationRunRef?.valueType === 'uri'
    && ['calculationDefinitionDigest', 'calculationRunDigest', 'calculationInputSetDigest']
      .every((field) => domain.attributeTypes?.[field]?.valueType === 'string'
        && domain.attributeTypes[field].pattern === '^sha256:[0-9a-f]{64}$');
  if (!derivedPriceTypesValid) {
    addFinding(
      violations,
      'ONTOLOGY_DERIVED_PRICE_EVIDENCE',
      'domain.attributeTypes',
      'derived-price evidence requires two URI references and three lowercase SHA-256 digest attributes',
    );
  }

  const expectedValueTypes = {
    priceValue: MONEY, bidPrice: MONEY, askPrice: MONEY, tradePrice: MONEY,
    tradeOpenPrice: MONEY, tradeHighPrice: MONEY, tradeLowPrice: MONEY, tradeClosePrice: MONEY,
    bidOpenPrice: MONEY, bidHighPrice: MONEY, bidLowPrice: MONEY, bidClosePrice: MONEY,
    askOpenPrice: MONEY, askHighPrice: MONEY, askLowPrice: MONEY, askClosePrice: MONEY,
    bidSize: QUANTITY, askSize: QUANTITY, tradeSize: QUANTITY, tradeVolume: QUANTITY,
    lastBidSize: QUANTITY, lastAskSize: QUANTITY, barThreshold: QUANTITY, fxRate: QUANTITY,
  };
  for (const [name, valueType] of Object.entries(expectedValueTypes)) {
    if (domain.attributeTypes?.[name]?.valueType !== valueType) {
      addFinding(violations, 'ONTOLOGY_STRUCTURED_VALUE', `domain.attributeTypes.${name}`, `valueType must be ${valueType}`);
    }
  }
  if (domain.attributeTypes?.observationIdFieldLocator?.valueType
      !== 'https://axiolune.ai/ontology/meta/data-binding/structures/SourceLocator'
      || domain.attributeTypes?.sourceRevisionFieldLocator?.valueType
      !== 'https://axiolune.ai/ontology/meta/data-binding/structures/SourceLocator') {
    addFinding(violations, 'ONTOLOGY_SOURCE_LOCATOR', 'domain.attributeTypes', 'source field mappings must use the canonical SourceLocator structure');
  }

  const expectedRelations = [
    ['streamProvider', `${BASE}MarketDataStream`, 'https://axiolune.ai/ontology/finance/foundation/Party', 1, 1, LOGICAL],
    ['barSpecificationStream', `${BASE}BarSpecification`, `${BASE}MarketDataStream`, 1, 1, EXACT],
    ['barSpecificationCalendar', `${BASE}BarSpecification`, 'https://axiolune.ai/ontology/finance/market-structure/TradingCalendar', 1, 1, EXACT],
  ];
  for (const [name, subject, object, min, max, mode] of expectedRelations) {
    const use = relationUse(document, name);
    if (!use) {
      addFinding(violations, 'ONTOLOGY_RELATION_USE', `${BASE}${name}`, 'required RelationUse is absent');
      continue;
    }
    if (use.subjectType !== subject || use.objectType !== object
        || use.outboundCardinality?.minCount !== min || use.outboundCardinality?.maxCount !== max) {
      addFinding(violations, 'ONTOLOGY_RELATION_CARDINALITY', `${BASE}${name}`, 'subject, object, or cardinality violates RFC-001');
    }
    const modes = array(use.constraints)
      .map((binding) => binding?.constraintRef)
      .filter((constraint) => [LOGICAL, EXACT].includes(constraint));
    if (modes.length !== 1 || modes[0] !== mode) {
      addFinding(violations, 'ONTOLOGY_RELATION_REFERENCE_MODE', `${BASE}${name}`, `expected exactly one ${mode} binding`);
    }
  }

  const expectedCodeLists = {
    MarketDataStreamPurpose: ['priceObservation', 'quoteObservation', 'tradeObservation', 'tradeBar', 'quoteBar', 'fxRateObservation'],
    SourceRecordRevisionMode: ['immutableRecord', 'revisionedRecord'],
    PriceKind: PRICE_KINDS,
    BarAggregation: BAR_AGGREGATIONS,
    BarPriceBasis: ['trade', 'bidAsk'],
    BarTimestampConvention: ['intervalStart', 'intervalEnd'],
    MarketDataQualityFindingKind: ['crossedQuote', 'duplicateConflict', 'orderingCollision'],
  };
  for (const [name, expected] of Object.entries(expectedCodeLists)) {
    const codeList = domain.codeLists?.[name];
    const actual = array(codeList?.values).map((value) => value?.notation);
    if (actual.join('\0') !== expected.join('\0')) {
      addFinding(violations, 'ONTOLOGY_CODE_LIST', `domain.codeLists.${name}`, `closed members must be ${expected.join(', ')}`);
    }
    if (!validIri(codeList?.sourceEvidenceRef)) {
      addFinding(violations, 'ONTOLOGY_EVIDENCE_STATUS', `domain.codeLists.${name}.sourceEvidenceRef`, 'vocabulary evidence must be an absolute evidence IRI');
    } else if (codeList.sourceEvidenceRef.startsWith(PENDING_EVIDENCE)) {
      addFinding(pending, 'PENDING_CODE_LIST_EVIDENCE', `domain.codeLists.${name}.sourceEvidenceRef`, `authoritative or adopted project evidence is not locked: ${codeList.sourceEvidenceRef}`);
    } else if (codeList.sourceEvidenceRef !== CODE_LIST_AUTHORITY_REFERENCE_IRI) {
      addFinding(
        violations,
        'ONTOLOGY_EVIDENCE_STATUS',
        `domain.codeLists.${name}.sourceEvidenceRef`,
        `non-pending evidence must equal the canonical authority reference ${CODE_LIST_AUTHORITY_REFERENCE_IRI}`,
      );
    } else {
      const authorityErrors = validateCodeListAuthority(codeList, {
        authorityState: options.codeListAuthorityState,
        codeListName: name,
        moduleId: 'market-data',
      });
      const destination = moduleStatus === 'approved' ? violations : pending;
      const code = moduleStatus === 'approved'
        ? 'ONTOLOGY_CODE_LIST_AUTHORITY'
        : 'PENDING_CODE_LIST_AUTHORITY';
      for (const error of authorityErrors) {
        addFinding(
          destination,
          code,
          `domain.codeLists.${name}.sourceEvidenceRef`,
          error,
        );
      }
    }
  }
  if (pending.length > 0 && (moduleStatus !== 'draft' || governanceStatus !== 'draft')) {
    addFinding(violations, 'ONTOLOGY_PREMATURE_APPROVAL', 'module.status', 'Market Data must remain draft while code-list evidence is pending');
  }
  if (array(domain.codeLists?.PriceKind?.values)
    .some((value) => ['bid', 'ask'].includes(String(value?.notation).toLowerCase()))) {
    addFinding(violations, 'ONTOLOGY_PRICE_KIND_SIDE', 'domain.codeLists.PriceKind', 'Bid and Ask are structural quote sides, not PriceKind members');
  }

  const actualConstraintNames = Object.keys(
    isObject(domain.constraints) ? domain.constraints : {},
  ).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const expectedConstraintNames = Object.keys(CONSTRAINT_PROFILE)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (actualConstraintNames.join('\0') !== expectedConstraintNames.join('\0')) {
    addFinding(
      violations,
      'ONTOLOGY_CONSTRAINT_INVENTORY',
      'domain.constraints',
      `constraint names must equal the frozen v0.3 inventory: ${expectedConstraintNames.join(', ')}`,
    );
  }
  for (const [name, expected] of Object.entries(CONSTRAINT_PROFILE)) {
    const at = `domain.constraints.${name}`;
    const constraint = domain.constraints?.[name];
    if (!isObject(constraint)) {
      addFinding(violations, 'ONTOLOGY_CONSTRAINT_INVENTORY', at, 'required constraint is absent');
      continue;
    }
    const expression = constraint?.expression?.expression;
    const expressionDigest = typeof expression === 'string'
      ? `sha256:${crypto.createHash('sha256').update(Buffer.from(expression, 'utf8')).digest('hex')}`
      : null;
    if (constraint.iri !== `${BASE}${name}`
        || constraint.namespace !== 'fin-market-data'
        || constraint.localName !== name
        || !validNfc(constraint.label)
        || !validNfc(constraint.definition)
        || constraint.expression?.language !== expected.language
        || expressionDigest !== expected.expressionDigest
        || constraint.severity !== 'Error'
        || !validNfc(constraint.message)
        || constraint.targetElement !== expected.targetElement) {
      addFinding(
        violations,
        'ONTOLOGY_CONSTRAINT_PROFILE',
        at,
        `constraint identity, expression digest, target, severity, and prose must equal the frozen v0.3 profile (${expected.expressionDigest})`,
      );
    }
    const actualBindings = array(domain.constraintBindings)
      .filter((binding) => binding?.constraintRef === `${BASE}${name}`)
      .map((binding) => {
        const closed = isObject(binding)
          && Object.keys(binding).sort().join('\0')
            === ['constraintRef', 'enforcementLevel', 'targetElement'].sort().join('\0');
        return {
          closed,
          enforcementLevel: binding?.enforcementLevel,
          targetElement: binding?.targetElement,
        };
      })
      .sort((left, right) => Buffer.compare(
        Buffer.from(left.targetElement || ''),
        Buffer.from(right.targetElement || ''),
      ));
    const expectedBindings = expected.bindingTargets
      .map((target) => ({
        closed: true,
        enforcementLevel: 'Mandatory',
        targetElement: `${BASE}${target}`,
      }))
      .sort((left, right) => Buffer.compare(
        Buffer.from(left.targetElement),
        Buffer.from(right.targetElement),
      ));
    if (JSON.stringify(actualBindings) !== JSON.stringify(expectedBindings)) {
      addFinding(
        violations,
        'ONTOLOGY_CONSTRAINT_BINDING_INVENTORY',
        at,
        `bindings must be the exact Mandatory target set ${expectedBindings.map((row) => row.targetElement).join(', ')}`,
      );
    }
  }

  return { violations, pending };
}

function validateAxes(record, at, violations, pivot) {
  const axes = record?.axes;
  if (!isObject(axes)
      || !validInstant(axes.validFrom)
      || !validInstant(axes.knowledgeFrom)
      || !validInstant(axes.availableFrom)
      || !Number.isSafeInteger(axes.revision)
      || axes.revision < 0) {
    addFinding(violations, 'FACT_THREE_AXIS', `${at}.axes`, 'validFrom, knowledgeFrom, availableFrom, and non-negative revision are required');
    return;
  }
  for (const [from, to] of [['validFrom', 'validTo'], ['knowledgeFrom', 'knowledgeTo'], ['availableFrom', 'availableTo']]) {
    if (axes[to] !== undefined && axes[to] !== null
        && (!validInstant(axes[to]) || compareUtcInstantLexical(axes[to], axes[from]) <= 0)) {
      addFinding(violations, 'FACT_INTERVAL', `${at}.axes.${to}`, `${to} must be a valid instant strictly after ${from}`);
    }
  }
  if (Object.hasOwn(axes, 'knowledgeTo') || Object.hasOwn(axes, 'availableTo')) {
    addFinding(violations, 'FACT_MUTABLE_CLOSURE', `${at}.axes`, 'FactVersion forbids knowledgeTo and availableTo; use FactClosureAssertion');
  }
  if (pivot) {
    const comparisons = [
      ['validFrom', 'asOfValid'], ['knowledgeFrom', 'asOfKnowledge'], ['availableFrom', 'asOfAvailable'],
    ];
    for (const [from, asOf] of comparisons) {
      if (!validInstant(pivot[asOf])) {
        addFinding(violations, 'PIT_PIVOT', `queryPivot.${asOf}`, 'PIT pivot instant is missing or invalid');
      } else if (compareUtcInstantLexical(axes[from], pivot[asOf]) > 0) {
        addFinding(violations, 'PIT_FUTURE', `${at}.axes.${from}`, `${from} is later than ${asOf}`);
      } else {
        const to = { validFrom: 'validTo', knowledgeFrom: 'knowledgeTo', availableFrom: 'availableTo' }[from];
        if (validInstant(axes[to]) && compareUtcInstantLexical(pivot[asOf], axes[to]) >= 0) {
          addFinding(violations, 'PIT_OUTSIDE_INTERVAL', `${at}.axes.${to}`, `${asOf} is outside the half-open interval`);
        }
      }
    }
    if (!validInstant(pivot.referenceTime)) {
      addFinding(violations, 'PIT_REFERENCE_TIME', 'queryPivot.referenceTime', 'materialization referenceTime is required');
    } else if (compareUtcInstantLexical(axes.knowledgeFrom, pivot.referenceTime) > 0
        || (validInstant(pivot.asOfKnowledge)
          && compareUtcInstantLexical(pivot.asOfKnowledge, pivot.referenceTime) > 0)
        || (validInstant(pivot.asOfAvailable)
          && compareUtcInstantLexical(pivot.asOfAvailable, pivot.referenceTime) > 0)) {
      addFinding(violations, 'PIT_REFERENCE_TIME', at, 'knowledge/as-of availability bounds exceed materialization referenceTime');
    }
  }
}

function pitEligible(record, pivot, closureByTargetAxis) {
  const axes = record?.axes;
  if (!isObject(axes)
      || !validInstant(pivot?.asOfValid)
      || !validInstant(pivot?.asOfKnowledge)
      || !validInstant(pivot?.asOfAvailable)
      || !validInstant(axes.validFrom)
      || !validInstant(axes.knowledgeFrom)
      || !validInstant(axes.availableFrom)) return false;
  const knowledgeEnd = closureByTargetAxis.get(
    tupleKey([record.versionIri, 'knowledge']),
  )?.closedAt;
  const availabilityEnd = closureByTargetAxis.get(
    tupleKey([record.versionIri, 'availability']),
  )?.closedAt;
  return compareUtcInstantLexical(axes.validFrom, pivot.asOfValid) <= 0
    && (!validInstant(axes.validTo)
      || compareUtcInstantLexical(pivot.asOfValid, axes.validTo) < 0)
    && compareUtcInstantLexical(axes.knowledgeFrom, pivot.asOfKnowledge) <= 0
    && (!validInstant(knowledgeEnd)
      || compareUtcInstantLexical(pivot.asOfKnowledge, knowledgeEnd) < 0)
    && compareUtcInstantLexical(axes.availableFrom, pivot.asOfAvailable) <= 0
    && (!validInstant(availabilityEnd)
      || compareUtcInstantLexical(pivot.asOfAvailable, availabilityEnd) < 0);
}

function validateProvenance(record, at, violations) {
  const provenance = record?.provenance;
  const artifactResult = validateArtifactRef(
    provenance?.sourceArtifactRef,
    `${at}.provenance.sourceArtifactRef`,
  );
  const locatorResult = validateSourceLocator(
    provenance?.sourceLocator,
    { at: `${at}.provenance.sourceLocator` },
  );
  if (!isObject(provenance)
      || !artifactResult.ok
      || !DIGEST_RE.test(provenance?.sourceArtifactDigest || '')
      || !locatorResult.ok) {
    addFinding(
      violations,
      'FACT_PROVENANCE',
      `${at}.provenance`,
      'closed M3 v0.6 ArtifactRef, digest, and closed SourceLocator are required',
    );
  }
}

function validateMoney(value, at, violations, expectedCurrency) {
  if (!isObject(value)
      || !isDecimalLexical(value.amount)
      || !/^[A-Z]{3}$/u.test(value.currency || '')) {
    addFinding(
      violations,
      'MONEY_VALUE',
      at,
      'Money requires an explicit base-10 decimal lexical amount and uppercase ISO-4217 currency code',
    );
    return;
  }
  if (expectedCurrency && value.currency !== expectedCurrency) {
    addFinding(violations, 'OBSERVATION_CURRENCY', `${at}.currency`, `expected context currency ${expectedCurrency}`);
  }
}

function validateQuantity(value, at, violations, options = {}) {
  if (!isObject(value)
      || !isDecimalLexical(value.value)
      || !validIri(value.unit)
      || !QUANTITY_ROUNDINGS.includes(value.rounding)) {
    addFinding(
      violations,
      'QUANTITY_VALUE',
      at,
      'Quantity requires an explicit base-10 decimal lexical value, absolute unit IRI, and controlled rounding mode',
    );
    return;
  }
  if (options.positive && compareDecimalLexical(value.value, '0') <= 0) {
    addFinding(violations, 'QUANTITY_POSITIVE', `${at}.value`, 'quantity must be strictly positive');
  }
  if (options.nonNegative && compareDecimalLexical(value.value, '0') < 0) {
    addFinding(violations, 'QUANTITY_NON_NEGATIVE', `${at}.value`, 'quantity must be non-negative');
  }
  if (options.unit && value.unit !== options.unit) {
    addFinding(violations, 'QUOTATION_UNIT', `${at}.unit`, `expected quotation denominator unit ${options.unit}`);
  }
}

function indexById(items, at, violations) {
  const index = new Map();
  array(items).forEach((item, position) => {
    if (!validNfc(item?.id)) {
      addFinding(violations, 'INSTANCE_ID', `${at}[${position}].id`, 'non-empty NFC id is required');
    } else if (index.has(item.id)) {
      addFinding(violations, 'INSTANCE_DUPLICATE_ID', `${at}[${position}].id`, `duplicate id ${item.id}`);
    } else {
      index.set(item.id, item);
    }
  });
  return index;
}

function observationEventId(observation) {
  return observation?.type === 'TradeObservation'
    ? observation?.sourceTradeId
    : observation?.providerObservationId;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function canonicalObservationContent(observation) {
  const clone = structuredClone(observation);
  delete clone.id;
  delete clone.versionIri;
  delete clone.logicalIri;
  delete clone.axes;
  delete clone.sourceRevisionToken;
  delete clone.sourceRevisionOrder;
  delete clone.supersedes;
  return JSON.stringify(stableValue(clone));
}

function findingDigest(kind, affectedVersionIris) {
  if (!['crossedQuote', 'duplicateConflict', 'orderingCollision'].includes(kind)) {
    throw new TypeError(`unsupported market-data finding kind ${kind}`);
  }
  const sorted = [...new Set(affectedVersionIris)].sort((left, right) => (
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  ));
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(sorted.length));
  const chunks = [Buffer.from('axiolune-iri-set-v1\0', 'utf8'), count];
  for (const iri of sorted) {
    const iriBytes = Buffer.from(iri, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(iriBytes.length));
    chunks.push(length, iriBytes);
  }
  return `sha256:${crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex')}`;
}

function validateScenario(scenario, options = {}) {
  const violations = [];
  violations.push(...validateScenarioSourceEvidence(scenario, {
    repositoryRoot: options.repositoryRoot,
  }));
  const pivot = scenario?.queryPivot;
  if (!validIri(scenario?.graphRef)) {
    addFinding(
      violations,
      'SCENARIO_OUTPUT_GRAPH',
      'graphRef',
      'one absolute NFC output graph IRI is required',
    );
  }
  const streams = indexById(scenario?.streams, 'streams', violations);
  const specifications = indexById(scenario?.barSpecifications, 'barSpecifications', violations);
  const observations = indexById(scenario?.observations, 'observations', violations);
  const closures = indexById(scenario?.closures, 'closures', violations);
  const fxDerivations = indexById(scenario?.fxDerivations, 'fxDerivations', violations);
  const findings = array(scenario?.findings);
  const streamIdentity = identityBijectionState();
  const specificationIdentity = identityBijectionState();
  const observationIdentity = identityBijectionState();
  const findingIdentity = identityBijectionState();

  const versionIndex = new Map();
  for (const record of [
    ...array(scenario?.streams), ...array(scenario?.barSpecifications),
    ...array(scenario?.observations), ...array(scenario?.findings),
  ]) {
    if (validIri(record?.versionIri)) {
      if (versionIndex.has(record.versionIri)) addFinding(violations, 'FACT_DUPLICATE_VERSION_IRI', record.versionIri, 'version IRI must be globally unique');
      else versionIndex.set(record.versionIri, record);
    }
  }
  const evidenceArtifactCounts = new Map();
  for (const binding of array(scenario?.artifactBindings)) {
    if (!validIri(binding?.artifactIri)) continue;
    evidenceArtifactCounts.set(
      binding.artifactIri,
      (evidenceArtifactCounts.get(binding.artifactIri) || 0) + 1,
    );
  }
  const closureByTargetAxis = new Map();
  for (const [id, closure] of closures) {
    const at = `closures.${id}`;
    const allowedClosureFields = new Set([
      'id', 'targetVersionIri', 'axis', 'closedAt', 'causeKind', 'causeVersionIri',
      'evidenceRef', 'generatingContextRef',
    ]);
    if (!isObject(closure)
        || Object.keys(closure).some((field) => !allowedClosureFields.has(field))
        || !validIri(closure?.id)
        || !validIri(closure?.targetVersionIri)
        || !['knowledge', 'availability'].includes(closure?.axis)
        || !validInstant(closure?.closedAt)
        || !validIri(closure?.evidenceRef)
        || !validIri(closure?.generatingContextRef)) {
      addFinding(violations, 'CLOSURE_CONTRACT', at, 'closure requires exact target, axis, closedAt, evidence, and generating context');
      continue;
    }
    const key = tupleKey([closure.targetVersionIri, closure.axis]);
    if (closureByTargetAxis.has(key)) addFinding(violations, 'CLOSURE_DUPLICATE', at, 'at most one closure is legal for each target and axis');
    else closureByTargetAxis.set(key, closure);
    const target = versionIndex.get(closure.targetVersionIri);
    const fromName = closure.axis === 'knowledge' ? 'knowledgeFrom' : 'availableFrom';
    if (!target || !validInstant(target?.axes?.[fromName])
        || compareUtcInstantLexical(closure.closedAt, target.axes[fromName]) <= 0) {
      addFinding(violations, 'CLOSURE_TARGET', at, 'closure target must exist and closedAt must follow the target axis start');
    }
    const evidenceResolutionCount = Number(versionIndex.has(closure.evidenceRef))
      + (evidenceArtifactCounts.get(closure.evidenceRef) || 0);
    if (evidenceResolutionCount !== 1) {
      addFinding(
        violations,
        'CLOSURE_EVIDENCE',
        at,
        'evidenceRef must resolve exactly once to a domain FactVersion or byte-locked artifact binding',
      );
    }
    if ((evidenceArtifactCounts.get(closure.generatingContextRef) || 0) !== 1) {
      addFinding(
        violations,
        'CLOSURE_CONTEXT',
        at,
        'generatingContextRef must resolve exactly once to its detached MaterializationRun artifact',
      );
    }
    const allowedCauses = closure.axis === 'knowledge'
      ? ['successor', 'retraction'] : ['successor', 'sourceWithdrawal'];
    if (!allowedCauses.includes(closure?.causeKind)) {
      addFinding(violations, 'CLOSURE_CAUSE', at, 'axis/causeKind combination is invalid');
    }
    if (closure?.causeKind === 'successor') {
      const cause = versionIndex.get(closure?.causeVersionIri);
      if (!cause || cause?.supersedes !== closure.targetVersionIri
          || cause?.logicalIri !== target?.logicalIri
          || closure.closedAt !== cause?.axes?.[fromName]) {
        addFinding(
          violations,
          'CLOSURE_CAUSE_VERSION',
          at,
          'successor closure must name the exact direct successor under the same logical anchor and close at the successor axis start',
        );
      }
    } else if (closure?.causeVersionIri !== undefined) {
      addFinding(violations, 'CLOSURE_CAUSE_VERSION', at, 'non-successor closure forbids causeVersionIri');
    }
    try {
      if (closure.id !== buildFactClosureAssertionIri(closure)) {
        addFinding(
          violations,
          'CLOSURE_IDENTITY',
          at,
          'FactClosureAssertion IRI must recompute from the canonical RFC 5.8 identity frame',
        );
      }
    } catch {
      addFinding(
        violations,
        'CLOSURE_IDENTITY',
        at,
        'FactClosureAssertion identity terms cannot be canonically framed',
      );
    }
  }

  const sourceContractKeys = new Set();
  for (const [id, stream] of streams) {
    const at = `streams.${id}`;
    validateAxes(stream, at, violations, pivot);
    validateProvenance(stream, at, violations);
    for (const [field, validator] of [
      ['versionIri', validIri], ['logicalIri', validIri], ['providerLogicalIri', validIri],
      ['providerStreamId', validNfc], ['sourceContractRef', validIri],
      ['sourceApiIdentifier', validNfc], ['sourceSchemaIdentifier', validNfc],
      ['sourceSchemaVersion', validNfc],
    ]) {
      if (!validator(stream?.[field])) addFinding(violations, 'STREAM_IDENTITY', `${at}.${field}`, `${field} is missing or invalid`);
    }
    if (!DIGEST_RE.test(stream?.sourceContractDigest || '')) {
      addFinding(violations, 'STREAM_SOURCE_LOCK', `${at}.sourceContractDigest`, 'source contract digest must be lowercase SHA-256');
    }
    validateIdentityBijection(
      streamIdentity,
      stream?.logicalIri,
      [stream?.providerLogicalIri, stream?.sourceContractRef, stream?.providerStreamId],
      'STREAM_LOGICAL_IDENTITY',
      at,
      violations,
    );
    const contractKey = tupleKey([stream.providerLogicalIri, stream.sourceContractRef]);
    if (sourceContractKeys.has(contractKey)) {
      addFinding(violations, 'STREAM_SOURCE_CONTRACT_UNIQUE', at, 'source contract IRI must be unique within provider');
    }
    sourceContractKeys.add(contractKey);
    if (!Object.values(PURPOSE_BY_TYPE).includes(stream?.purpose)) {
      addFinding(violations, 'STREAM_PURPOSE', `${at}.purpose`, 'stream purpose is not in the closed set');
    }
    if (!['immutableRecord', 'revisionedRecord'].includes(stream?.revisionMode)) {
      addFinding(violations, 'STREAM_REVISION_MODE', `${at}.revisionMode`, 'revision mode is not in the closed set');
    }
    const mappings = stream?.mappings;
    const observationLocator = validateSourceLocator(
      mappings?.observationIdFieldLocator,
      { at: `${at}.mappings.observationIdFieldLocator` },
    );
    if (!isObject(mappings)
        || !observationLocator.ok
        || !Array.isArray(mappings.orderingTuple)
        || mappings.orderingTuple.length !== 3
        || mappings.orderingTuple.some(
          (value, index) => value !== [
            'observedAt',
            'sourceSequence',
            'sourceEventId',
          ][index],
        )
        || !validIri(mappings.orderingTransformRef)
        || !DIGEST_RE.test(mappings.orderingTransformDigest || '')) {
      addFinding(violations, 'STREAM_SOURCE_MAPPING', `${at}.mappings`, 'ID field and exact [observedAt, sourceSequence, sourceEventId] digest-locked ordering transform are required');
    }
    if (stream?.revisionMode === 'immutableRecord' && mappings?.sourceRevisionFieldLocator !== undefined) {
      addFinding(violations, 'REVISION_MODE_MAPPING', `${at}.mappings.sourceRevisionFieldLocator`, 'immutableRecord forbids a source revision field locator');
    }
    if (stream?.revisionMode === 'revisionedRecord') {
      const revisionLocator = validateSourceLocator(
        mappings?.sourceRevisionFieldLocator,
        { at: `${at}.mappings.sourceRevisionFieldLocator` },
      );
      if (!revisionLocator.ok) {
        addFinding(violations, 'REVISION_MODE_MAPPING', `${at}.mappings.sourceRevisionFieldLocator`, 'revisionedRecord requires a closed exact source revision field locator');
      }
    }
  }

  for (const [id, spec] of specifications) {
    const at = `barSpecifications.${id}`;
    validateAxes(spec, at, violations, pivot);
    validateProvenance(spec, at, violations);
    const stream = streams.get(spec?.stream);
    if (!stream || spec?.streamVersionIri !== stream?.versionIri) {
      addFinding(violations, 'BAR_SPEC_STREAM', `${at}.stream`, 'BarSpecification must reference one exact stream version');
    }
    if (!validIri(spec?.versionIri)
        || !validIri(spec?.logicalIri)
        || !validNfc(spec?.barSpecificationId)
        || !BAR_AGGREGATIONS.includes(spec?.aggregation)
        || !['trade', 'bidAsk'].includes(spec?.basis)
        || !['intervalStart', 'intervalEnd'].includes(spec?.timestampConvention)
        || !validNfc(spec?.sourceTimeZone)
        || !validIri(spec?.calendarVersionIri)) {
      addFinding(violations, 'BAR_SPEC_CONTRACT', at, 'bar ID, aggregation, basis, timezone, timestamp convention, and exact calendar are required');
    }
    validateIdentityBijection(
      specificationIdentity,
      spec?.logicalIri,
      [stream?.logicalIri, spec?.barSpecificationId],
      'BAR_SPEC_LOGICAL_IDENTITY',
      at,
      violations,
    );
    if (spec?.aggregation === 'time') {
      if (!finiteNumber(spec?.intervalSeconds) || spec.intervalSeconds <= 0 || spec.threshold !== undefined) {
        addFinding(violations, 'BAR_SPEC_BRANCH', at, 'time aggregation requires positive intervalSeconds and forbids threshold');
      }
    } else {
      const before = violations.length;
      validateQuantity(spec?.threshold, `${at}.threshold`, violations, { positive: true });
      if (violations.length !== before || spec.intervalSeconds !== undefined) {
        addFinding(violations, 'BAR_SPEC_BRANCH', at, 'non-time aggregation requires a positive controlled QuantityValue threshold and forbids intervalSeconds');
      }
    }
  }

  const collisionGroups = new Map();
  const orderingGroups = new Map();
  const revisionGroups = new Map();
  const crossedQuotes = [];

  for (const [id, observation] of observations) {
    const at = `observations.${id}`;
    validateAxes(observation, at, violations, pivot);
    validateProvenance(observation, at, violations);
    if (!Object.hasOwn(PURPOSE_BY_TYPE, observation?.type)) {
      addFinding(violations, 'OBSERVATION_TYPE', `${at}.type`, 'unknown market observation type');
      continue;
    }
    if (!validIri(observation?.versionIri) || !validIri(observation?.logicalIri)) {
      addFinding(violations, 'OBSERVATION_IDENTITY', at, 'exact version IRI and logical IRI are required');
    }
    const stream = streams.get(observation?.stream);
    if (!stream || observation?.streamVersionIri !== stream?.versionIri) {
      addFinding(violations, 'OBSERVATION_STREAM', `${at}.stream`, 'observation must reference one exact stream version');
    } else if (stream.purpose !== PURPOSE_BY_TYPE[observation.type]) {
      addFinding(violations, 'OBSERVATION_STREAM_PURPOSE', `${at}.type`, `stream admits ${stream.purpose}, not ${observation.type}`);
    }
    if (!validInstant(observation?.observedAt)
        || !Number.isSafeInteger(observation?.sourceOrderKey)
        || observation.sourceOrderKey < 0) {
      addFinding(violations, 'OBSERVATION_ORDER_FIELDS', at, 'observedAt and a non-negative integer sourceOrderKey are required');
    }
    const eventId = observationEventId(observation);
    if (!validNfc(eventId)) {
      addFinding(violations, 'OBSERVATION_SOURCE_ID', at, 'provider observation/event ID is required and must be NFC');
    }
    validateIdentityBijection(
      observationIdentity,
      observation?.logicalIri,
      [stream?.logicalIri, eventId],
      'OBSERVATION_LOGICAL_IDENTITY',
      at,
      violations,
    );

    const hasListing = isObject(observation?.context?.listing);
    const hasOtc = isObject(observation?.context?.otc);
    if (Number(hasListing) + Number(hasOtc) !== 1) {
      addFinding(violations, 'OBSERVATION_CONTEXT_XONE', `${at}.context`, 'exactly one listed or OTC context is required');
    }
    const context = hasListing ? observation.context.listing : observation?.context?.otc;
    const expectedCurrency = context?.quoteCurrency;
    if (context && (!validIri(context.versionIri) || !/^[A-Z]{3}$/u.test(expectedCurrency || ''))) {
      addFinding(violations, 'OBSERVATION_CONTEXT', `${at}.context`, 'context requires exact version IRI and quote currency');
    }

    if (observation.type !== 'FXRateObservation') {
      if (!isObject(observation?.observedInstrument)
          || !validIri(observation.observedInstrument.versionIri)
          || !validIri(observation.observedInstrument.logicalIri)) {
        addFinding(violations, 'OBSERVATION_INSTRUMENT', `${at}.observedInstrument`, 'exact instrument version and logical anchor are required');
      }
      if (hasListing && context?.instrumentVersionIri !== observation?.observedInstrument?.versionIri) {
        addFinding(violations, 'OBSERVATION_LISTING_INSTRUMENT', `${at}.context.listing.instrumentVersionIri`, 'listing instrument must equal observed exact instrument');
      }
      const quotation = observation?.quotation;
      if (!isObject(quotation)
          || !validIri(quotation.versionIri)
          || quotation.instrumentLogicalIri !== observation?.observedInstrument?.logicalIri
          || quotation.contextVersionIri !== context?.versionIri
          || quotation.quoteCurrency !== expectedCurrency
          || quotation.kind !== 'directUnitPrice'
          || quotation.multiplier !== 1
          || !validIri(quotation.denominatorUnit)) {
        addFinding(violations, 'OBSERVATION_QUOTATION', `${at}.quotation`, 'exact direct-unit quotation contract does not match instrument, context, currency, multiplier, or unit');
      }
    } else if (observation.quotation !== undefined || observation.observedInstrument !== undefined) {
      addFinding(violations, 'FX_SEPARATE_CONTRACT', at, 'FX observation must not use the non-FX instrument quotation contract');
    }

    const denominatorUnit = observation?.quotation?.denominatorUnit;
    if (observation.type === 'PriceObservation') {
      validateMoney(observation.price, `${at}.price`, violations, expectedCurrency);
      if (!PRICE_KINDS.includes(observation?.priceKind)) {
        addFinding(violations, 'PRICE_KIND', `${at}.priceKind`, 'PriceObservation requires one compatible non-Bid/non-Ask PriceKind');
      }
      const derivedPrice = ['vwap', 'twap'].includes(observation?.priceKind);
      const presentDerivedFields = DERIVED_PRICE_EVIDENCE_FIELDS
        .filter((field) => Object.hasOwn(observation, field));
      if (derivedPrice
          && (!validIri(observation?.calculationDefinitionRef)
            || !DIGEST_RE.test(observation?.calculationDefinitionDigest || '')
            || !validIri(observation?.calculationRunRef)
            || !DIGEST_RE.test(observation?.calculationRunDigest || '')
            || !DIGEST_RE.test(observation?.calculationInputSetDigest || ''))) {
        addFinding(
          violations,
          'PRICE_KIND_DERIVATION',
          `${at}.calculationDefinitionRef`,
          'VWAP/TWAP requires exact calculation-definition and calculation-run IRIs/digests plus one input FactVersion set digest',
        );
      } else if (!derivedPrice && presentDerivedFields.length > 0) {
        addFinding(
          violations,
          'PRICE_KIND_DERIVATION',
          `${at}.calculationDefinitionRef`,
          'non-derived PriceKind forbids calculation-definition, calculation-run, and input-set evidence fields',
        );
      }
    }
    if (observation.type === 'QuoteObservation') {
      for (const field of ['bidPrice', 'askPrice']) validateMoney(observation[field], `${at}.${field}`, violations, expectedCurrency);
      for (const field of ['bidSize', 'askSize']) validateQuantity(observation[field], `${at}.${field}`, violations, { nonNegative: true, unit: denominatorUnit });
      if (observation.priceKind !== undefined) addFinding(violations, 'PRICE_KIND', `${at}.priceKind`, 'QuoteObservation forbids PriceKind; sides are structural');
      if (isDecimalLexical(observation?.bidPrice?.amount)
          && isDecimalLexical(observation?.askPrice?.amount)
          && compareDecimalLexical(
            observation.bidPrice.amount,
            observation.askPrice.amount,
          ) > 0) crossedQuotes.push(observation);
    }
    if (observation.type === 'TradeObservation') {
      validateMoney(observation.tradePrice, `${at}.tradePrice`, violations, expectedCurrency);
      validateQuantity(observation.tradeSize, `${at}.tradeSize`, violations, { positive: true, unit: denominatorUnit });
      if (observation?.priceKind !== 'last') addFinding(violations, 'PRICE_KIND', `${at}.priceKind`, 'TradeObservation requires Last');
    }
    if (['TradeBar', 'QuoteBar'].includes(observation.type)) {
      const spec = specifications.get(observation?.barSpecification);
      if (!spec || observation?.barSpecificationVersionIri !== spec?.versionIri) {
        addFinding(violations, 'BAR_SPEC_REFERENCE', `${at}.barSpecification`, 'bar must reference one exact BarSpecification version');
      } else {
        if (spec.stream !== observation.stream) addFinding(violations, 'BAR_SPEC_STREAM', at, 'bar and specification must use the same stream');
        const expectedBasis = observation.type === 'TradeBar' ? 'trade' : 'bidAsk';
        if (spec.basis !== expectedBasis) addFinding(violations, 'BAR_BASIS', at, `${observation.type} requires ${expectedBasis} basis`);
        if (spec.aggregation === 'time') {
          if (!validInstant(observation?.intervalStart)
              || !validInstant(observation?.intervalEnd)
              || compareUtcInstantLexical(observation.intervalStart, observation.intervalEnd) >= 0
              || !Number.isSafeInteger(spec.intervalSeconds)
              || utcInstantDifferenceNanoseconds(
                observation.intervalEnd,
                observation.intervalStart,
              ) !== BigInt(spec.intervalSeconds) * NANOSECONDS_PER_SECOND
              || observation.barSequence !== undefined
              || observation.firstContributingEventAt !== undefined
              || observation.lastContributingEventAt !== undefined
              || observation.observedAt !== observation[spec.timestampConvention]) {
            addFinding(violations, 'BAR_INSTANCE_BRANCH', at, 'time bar interval or timestamp convention is invalid');
          }
        } else if (observation.intervalStart !== undefined
            || observation.intervalEnd !== undefined
            || !Number.isSafeInteger(observation?.barSequence)
            || observation.barSequence < 0
            || !validInstant(observation?.firstContributingEventAt)
            || !validInstant(observation?.lastContributingEventAt)
            || compareUtcInstantLexical(
              observation.firstContributingEventAt,
              observation.lastContributingEventAt,
            ) > 0) {
          addFinding(violations, 'BAR_INSTANCE_BRANCH', at, 'non-time bar sequence and contributing-event bounds are invalid');
        }
      }
      if (observation.priceKind !== undefined) addFinding(violations, 'PRICE_KIND', `${at}.priceKind`, 'bars forbid observation-level PriceKind');
    }
    if (observation.type === 'TradeBar') {
      const prices = ['tradeOpenPrice', 'tradeHighPrice', 'tradeLowPrice', 'tradeClosePrice'];
      prices.forEach((field) => validateMoney(observation[field], `${at}.${field}`, violations, expectedCurrency));
      validateQuantity(observation.tradeVolume, `${at}.tradeVolume`, violations, { nonNegative: true, unit: denominatorUnit });
      const [open, high, low, close] = prices.map((field) => observation?.[field]?.amount);
      if (![open, high, low, close].every(isDecimalLexical)
          || compareDecimalLexical(low, high) > 0
          || compareDecimalLexical(open, low) < 0
          || compareDecimalLexical(open, high) > 0
          || compareDecimalLexical(close, low) < 0
          || compareDecimalLexical(close, high) > 0) {
        addFinding(violations, 'BAR_OHLC', at, 'TradeBar must satisfy Low <= Open/Close <= High');
      }
    }
    if (observation.type === 'QuoteBar') {
      const bidFields = ['bidOpenPrice', 'bidHighPrice', 'bidLowPrice', 'bidClosePrice'];
      const askFields = ['askOpenPrice', 'askHighPrice', 'askLowPrice', 'askClosePrice'];
      [...bidFields, ...askFields].forEach((field) => validateMoney(observation[field], `${at}.${field}`, violations, expectedCurrency));
      validateQuantity(observation.lastBidSize, `${at}.lastBidSize`, violations, { nonNegative: true, unit: denominatorUnit });
      validateQuantity(observation.lastAskSize, `${at}.lastAskSize`, violations, { nonNegative: true, unit: denominatorUnit });
      for (const [side, fields] of [['bid', bidFields], ['ask', askFields]]) {
        const [open, high, low, close] = fields.map((field) => observation?.[field]?.amount);
        if (![open, high, low, close].every(isDecimalLexical)
            || compareDecimalLexical(low, high) > 0
            || compareDecimalLexical(open, low) < 0
            || compareDecimalLexical(open, high) > 0
            || compareDecimalLexical(close, low) < 0
            || compareDecimalLexical(close, high) > 0) {
          addFinding(violations, 'BAR_OHLC', `${at}.${side}`, `${side} side must satisfy Low <= Open/Close <= High`);
        }
      }
    }
    if (observation.type === 'FXRateObservation') {
      if (!isObject(observation?.baseCurrency)
          || !isObject(observation?.quoteCurrency)
          || !validIri(observation?.baseCurrency?.logicalIri)
          || !validIri(observation?.quoteCurrency?.logicalIri)
          || !/^[A-Z]{3}$/u.test(observation?.baseCurrency?.code || '')
          || !/^[A-Z]{3}$/u.test(observation?.quoteCurrency?.code || '')) {
        addFinding(violations, 'FX_CURRENCY', at, 'base and quote need logical Currency IRIs and ISO codes');
      } else if (observation.baseCurrency.logicalIri === observation.quoteCurrency.logicalIri
          || observation.baseCurrency.code === observation.quoteCurrency.code) {
        addFinding(violations, 'FX_IDENTICAL_CURRENCY', at, 'base and quote currencies must differ');
      }
      if (expectedCurrency && expectedCurrency !== observation?.quoteCurrency?.code) {
        addFinding(violations, 'FX_CONTEXT_CURRENCY', `${at}.context`, 'FX observation context quote currency must equal the FX quote Currency');
      }
      const expectedUnit = `urn:unit:${observation?.quoteCurrency?.code || '?'}-per-${observation?.baseCurrency?.code || '?'}`;
      validateQuantity(observation.fxRate, `${at}.fxRate`, violations, { positive: true, unit: expectedUnit });
      if (observation?.inverseOf !== undefined) {
        addFinding(violations, 'FX_STORED_INVERSE_FORBIDDEN', `${at}.inverseOf`, 'an inverse is a non-stored reciprocal derivation and must not be authored on FXRateObservation');
      }
    }

    if (stream) {
      const collisionKey = stream.revisionMode === 'revisionedRecord'
        ? tupleKey([stream.logicalIri, eventId, observation?.sourceRevisionToken])
        : tupleKey([stream.logicalIri, eventId]);
      const collisionGroup = collisionGroups.get(collisionKey) || [];
      collisionGroup.push(observation);
      collisionGroups.set(collisionKey, collisionGroup);
      const orderKey = tupleKey([
        observation?.observedAt,
        stream.logicalIri,
        observation?.sourceOrderKey,
        eventId,
      ]);
      const orderGroup = orderingGroups.get(orderKey) || [];
      orderGroup.push(observation);
      orderingGroups.set(orderKey, orderGroup);
      const revisionKey = tupleKey([stream.logicalIri, eventId]);
      const revisionGroup = revisionGroups.get(revisionKey) || [];
      revisionGroup.push(observation);
      revisionGroups.set(revisionKey, revisionGroup);

      if (stream.revisionMode === 'immutableRecord') {
        if (observation.sourceRevisionToken !== undefined
            || observation.sourceRevisionOrder !== undefined
            || observation.supersedes !== undefined
            || observation?.axes?.revision !== 0) {
          addFinding(violations, 'IMMUTABLE_CORRECTION', at, 'immutableRecord forbids revision fields, supersedes, and nonzero revision');
        }
      } else if (!validNfc(observation?.sourceRevisionToken)
          || !Number.isSafeInteger(observation?.sourceRevisionOrder)
          || observation.sourceRevisionOrder < 0) {
        addFinding(violations, 'REVISION_FIELDS', at, 'revisionedRecord requires token and non-negative source revision order');
      }
    }
  }

  for (const [key, group] of revisionGroups) {
    if (group.length === 0) continue;
    const stream = streams.get(group[0].stream);
    if (stream?.revisionMode !== 'revisionedRecord') continue;
    const byVersion = new Map(group.map((item) => [item.versionIri, item]));
    const orders = new Set();
    const successorCounts = new Map();
    const sorted = group.slice().sort((a, b) => (a?.axes?.revision ?? -1) - (b?.axes?.revision ?? -1));
    for (const item of sorted) {
      if (orders.has(item.sourceRevisionOrder)) addFinding(violations, 'REVISION_DUPLICATE_ORDER', key, 'sourceRevisionOrder must be unique in one correction chain');
      orders.add(item.sourceRevisionOrder);
      if (item.axes?.revision === 0) {
        if (item.supersedes !== undefined) addFinding(violations, 'REVISION_INITIAL_SUPERSEDES', item.id, 'initial revision forbids supersedes');
        continue;
      }
      const predecessor = byVersion.get(item.supersedes);
      if (!predecessor
          || predecessor.logicalIri !== item.logicalIri
          || item.axes?.revision !== predecessor.axes?.revision + 1
          || item.sourceRevisionOrder <= predecessor.sourceRevisionOrder
          || !validInstant(item.axes?.knowledgeFrom)
          || !validInstant(predecessor.axes?.knowledgeFrom)
          || compareUtcInstantLexical(
            item.axes?.knowledgeFrom,
            predecessor.axes?.knowledgeFrom,
          ) <= 0) {
        addFinding(violations, 'REVISION_PREDECESSOR', item.id, 'correction must supersede its immediate prior exact version with increasing revision/order/knowledge');
      }
      const knowledgeClosure = closureByTargetAxis.get(tupleKey([item.supersedes, 'knowledge']));
      if (!knowledgeClosure
          || knowledgeClosure.causeKind !== 'successor'
          || knowledgeClosure.causeVersionIri !== item.versionIri
          || knowledgeClosure.closedAt !== item.axes?.knowledgeFrom) {
        addFinding(violations, 'REVISION_CLOSURE', item.id, 'direct supersedes requires one exact knowledge closure at successor.knowledgeFrom');
      }
      if (item.supersedes) successorCounts.set(item.supersedes, (successorCounts.get(item.supersedes) || 0) + 1);
    }
    for (const [predecessor, count] of successorCounts) {
      if (count > 1) addFinding(violations, 'REVISION_BRANCH', predecessor, 'correction chain must not branch');
    }
  }

  for (const [id, derivation] of fxDerivations) {
    const at = `fxDerivations.${id}`;
    const source = versionIndex.get(derivation?.sourceVersionIri);
    const inverseUnit = `urn:unit:${source?.baseCurrency?.code || '?'}-per-${source?.quoteCurrency?.code || '?'}`;
    const rateViolationsBefore = violations.length;
    validateQuantity(derivation?.rate, `${at}.rate`, violations, { positive: true, unit: inverseUnit });
    let expectedReciprocal = null;
    try {
      expectedReciprocal = expectedReciprocalLexical(source?.fxRate?.value, {
        mode: 'half-even',
        scale: 16,
      });
    } catch {
      // The source/rate structural checks below report the malformed value.
    }
    if (source?.type !== 'FXRateObservation'
        || derivation?.operator !== 'reciprocal'
        || derivation?.baseCurrencyLogicalIri !== source?.quoteCurrency?.logicalIri
        || derivation?.quoteCurrencyLogicalIri !== source?.baseCurrency?.logicalIri
        || violations.length !== rateViolationsBefore
        || !isDecimalLexical(source?.fxRate?.value)
        || !isDecimalLexical(derivation?.rate?.value)
        || derivation?.rate?.rounding !== 'half-even'
        || derivation?.rate?.value !== expectedReciprocal
        || !decimalProductWithin(
          derivation.rate.value,
          source.fxRate.value,
          '1',
          '0.0000000000000001',
        )
        || !validIri(derivation?.transformationRef)
        || !DIGEST_RE.test(derivation?.transformationDigest || '')
        || !validIri(derivation?.generatingContextRef)) {
      addFinding(violations, 'FX_INVERSE_DERIVATION', at, 'inverse must be a non-stored reciprocal view with swapped currencies and exact source/transformation evidence');
    }
    if ((evidenceArtifactCounts.get(derivation?.generatingContextRef) || 0) !== 1) {
      addFinding(
        violations,
        'FX_GENERATING_CONTEXT',
        at,
        'generatingContextRef must resolve exactly once to its detached MaterializationRun artifact',
      );
    }
    validateProvenance(derivation, at, violations);
  }

  function findingPredicateSets(filter) {
    const sets = [];
    for (const quote of crossedQuotes.filter(filter)) {
      sets.push(['crossedQuote', [quote.versionIri], quote.stream]);
    }
    for (const rawGroup of collisionGroups.values()) {
      const group = rawGroup.filter(filter);
      const contents = new Set(group.map(canonicalObservationContent));
      if (group.length >= 2 && contents.size >= 2) {
        sets.push([
          'duplicateConflict',
          group.map((item) => item.versionIri),
          group[0].stream,
        ]);
      }
    }
    for (const rawGroup of orderingGroups.values()) {
      const group = rawGroup.filter(filter);
      const contents = new Set(group.map(canonicalObservationContent));
      const stream = streams.get(group[0]?.stream);
      if (stream?.revisionMode === 'immutableRecord'
          && group.length >= 2
          && contents.size >= 2) {
        sets.push([
          'orderingCollision',
          group.map((item) => item.versionIri),
          group[0].stream,
        ]);
      }
    }
    return sets;
  }

  const historicalFindingSets = findingPredicateSets(() => true);
  const currentFindingSets = findingPredicateSets(
    (observation) => pitEligible(observation, pivot, closureByTargetAxis),
  );

  const findingSignatures = new Map();
  const eligibleFindingSignatures = new Map();
  findings.forEach((finding, index) => {
    const at = `findings[${index}]`;
    validateAxes(finding, at, violations, pivot);
    validateProvenance(finding, at, violations);
    if (!validIri(finding?.versionIri) || !validIri(finding?.logicalIri)) {
      addFinding(violations, 'QUALITY_FINDING_IDENTITY', at, 'finding requires exact version and logical IRIs');
    }
    const affected = array(finding?.affectedVersionIris);
    const sorted = [...new Set(affected)].sort((left, right) => Buffer.compare(Buffer.from(left || '', 'utf8'), Buffer.from(right || '', 'utf8')));
    if (!['crossedQuote', 'duplicateConflict', 'orderingCollision'].includes(finding?.kind)
        || affected.length === 0
        || affected.length !== sorted.length
        || affected.some((value, index) => value !== sorted[index])
        || !affected.every(validIri)
        || finding?.affectedSubjectDigest !== findingDigest(finding?.kind, affected)
        || !validIri(finding?.generatingContextRef)) {
      addFinding(violations, 'QUALITY_FINDING_IDENTITY', at, 'finding kind, exact unique affected set, digest, and generating context are required');
    }
    const affectedRecords = affected.map((versionIri) => versionIndex.get(versionIri));
    if (affectedRecords.every(Boolean)
        && ['validFrom', 'knowledgeFrom', 'availableFrom'].every(
          (field) => validInstant(finding?.axes?.[field])
            && affectedRecords.every((record) => validInstant(record?.axes?.[field])),
        )
        && ['validFrom', 'knowledgeFrom', 'availableFrom'].some(
          (field) => affectedRecords.some((record) => compareUtcInstantLexical(
            finding.axes[field],
            record.axes[field],
          ) < 0),
        )) {
      addFinding(
        violations,
        'QUALITY_FINDING_FUTURE_INPUT',
        at,
        'a quality finding cannot become valid, known, or available before any affected exact version',
      );
    }
    const stream = streams.get(finding?.stream);
    if (!stream || finding.streamVersionIri !== stream.versionIri) addFinding(violations, 'QUALITY_FINDING_STREAM', at, 'finding must reference exact governing stream version');
    if ((evidenceArtifactCounts.get(finding?.generatingContextRef) || 0) !== 1) {
      addFinding(
        violations,
        'QUALITY_FINDING_CONTEXT',
        at,
        'generatingContextRef must resolve exactly once to its detached MaterializationRun artifact',
      );
    }
    validateIdentityBijection(
      findingIdentity,
      finding?.logicalIri,
      [stream?.logicalIri, finding?.kind, finding?.affectedSubjectDigest],
      'QUALITY_FINDING_LOGICAL_IDENTITY',
      at,
      violations,
    );
    const signature = tupleKey([finding.kind, sorted]);
    findingSignatures.set(signature, (findingSignatures.get(signature) || 0) + 1);
    if (pitEligible(finding, pivot, closureByTargetAxis)) {
      eligibleFindingSignatures.set(
        signature,
        (eligibleFindingSignatures.get(signature) || 0) + 1,
      );
    }
  });

  const requiredFindingViolationKeys = new Set();
  function reportRequiredFinding(kind, sorted, streamId) {
    const code = {
      crossedQuote: 'QUALITY_FINDING_REQUIRED_CROSSED',
      duplicateConflict: 'QUALITY_FINDING_REQUIRED_DUPLICATE',
      orderingCollision: 'QUALITY_FINDING_REQUIRED_ORDERING',
    }[kind];
    const key = tupleKey([code, sorted]);
    if (requiredFindingViolationKeys.has(key)) return;
    requiredFindingViolationKeys.add(key);
    addFinding(
      violations,
      code,
      streamId,
      `a ${kind} finding is required over the exact set ${sorted.join(', ')}`,
    );
  }

  for (const [kind, affected, streamId] of historicalFindingSets) {
    const sorted = [...new Set(affected)].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
    const signature = tupleKey([kind, sorted]);
    if (!findingSignatures.has(signature)) {
      reportRequiredFinding(kind, sorted, streamId);
    }
  }

  const resolvedDuplicateAffectedSets = [];
  for (const [kind, affected, streamId] of currentFindingSets) {
    const sorted = [...new Set(affected)].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
    const signature = tupleKey([kind, sorted]);
    if (eligibleFindingSignatures.get(signature) !== 1) {
      reportRequiredFinding(kind, sorted, streamId);
    } else if (kind === 'duplicateConflict') {
      resolvedDuplicateAffectedSets.push(new Set(sorted));
    }
  }
  for (const signature of findingSignatures.keys()) {
    const supported = [...historicalFindingSets, ...currentFindingSets].some(([kind, affected]) => {
      const sorted = [...new Set(affected)].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
      return signature === tupleKey([kind, sorted]);
    });
    if (!supported) addFinding(violations, 'QUALITY_FINDING_FALSE_PREDICATE', 'findings', 'supplied finding predicate or affected exact-version set is false');
  }

  if (validInstant(pivot?.asOfValid)
      && validInstant(pivot?.asOfKnowledge)
      && validInstant(pivot?.asOfAvailable)) {
    const eligibleByLogical = new Map();
    for (const record of versionIndex.values()) {
      if (!validIri(record?.logicalIri) || !isObject(record?.axes)) continue;
      if (pitEligible(record, pivot, closureByTargetAxis)) {
        const group = eligibleByLogical.get(record.logicalIri) || [];
        group.push(record.versionIri);
        eligibleByLogical.set(record.logicalIri, group);
      }
    }
    for (const [logicalIri, versions] of eligibleByLogical) {
      if (versions.length <= 1) continue;
      const resolvedConflict = resolvedDuplicateAffectedSets.some((affected) => (
        affected.size === versions.length
          && versions.every((versionIri) => affected.has(versionIri))
      ));
      if (!resolvedConflict) {
        addFinding(
          violations,
          'PIT_OVERLAPPING_VERSIONS',
          logicalIri,
          `multiple normal versions are eligible without one exact duplicateConflict finding: ${versions.join(', ')}`,
        );
      }
    }
  }

  if (options.includeReleaseEvidence !== false) {
    violations.push(...validateScenarioReleaseEvidence(scenario));
  }
  return violations;
}

module.exports = {
  auditModuleContract,
  buildFactClosureAssertionIri,
  findingDigest,
  validateScenario,
};
