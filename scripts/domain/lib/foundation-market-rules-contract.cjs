'use strict';

const fs = require('node:fs');
const yaml = require('js-yaml');
const {
  verifyAllMarketRulesReleaseEvidence,
} = require('./market-rules-release-evidence.cjs');
const {
  parseUtcInstantNanoseconds,
} = require('./instant-lexical.cjs');
const {
  compareDecimalLexical,
  isDecimalLexical,
} = require('./decimal-lexical.cjs');
const {
  CODE_LIST_AUTHORITY_REFERENCE_IRI,
  validateCodeListAuthority,
} = require('./source-evidence-reference.cjs');

const TEMPORAL = 'https://axiolune.ai/ontology/meta/patterns/TemporalFact';
const PROVENANCED = 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact';
const EXACT = 'https://axiolune.ai/ontology/meta/core/constraints/ExactVersionReference';
const LOGICAL = 'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference';
const FOUNDATION = 'https://axiolune.ai/ontology/finance/foundation/';
const RULES = 'https://axiolune.ai/ontology/finance/market-rules/';
const PENDING = 'https://axiolune.ai/pending-source-evidence/';

function loadYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.JSON_SCHEMA });
}

function patterns(element) {
  return (element.patternBindings || []).map((binding) => binding.pattern);
}

function exactFactPatterns(element) {
  const bound = patterns(element);
  return bound.filter((value) => value === TEMPORAL).length === 1
    && bound.filter((value) => value === PROVENANCED).length === 1;
}

function attributeUse(element, iri, min, max) {
  return (element.attributeUses || []).some((use) => (
    use.attribute === iri && use.minCount === min && use.maxCount === max
  ));
}

function relationUse(domain, relation, subjectType, objectType, min, max, mode) {
  const expectedConstraint = mode === 'logical' ? LOGICAL : EXACT;
  return (domain.relationUses || []).some((use) => (
    use.relation === relation
    && use.subjectType === subjectType
    && use.objectType === objectType
    && use.outboundCardinality?.minCount === min
    && use.outboundCardinality?.maxCount === max
    && (use.constraints || []).filter((binding) => binding.constraintRef === expectedConstraint).length === 1
    && (use.constraints || []).filter((binding) => (
      binding.constraintRef === EXACT || binding.constraintRef === LOGICAL
    )).length === 1
  ));
}

function role(element, id, range, min, max) {
  return (element.participantRoles || []).find((candidate) => (
    candidate.id === id
    && candidate.range === range
    && candidate.minCount === min
    && candidate.maxCount === max
    && typeof candidate.label === 'string'
    && candidate.label.length > 0
    && typeof candidate.definition === 'string'
    && candidate.definition.length > 0
  ));
}

function roleMode(domain, association, id, expectedMode) {
  const predicate = `${association.iri}/role/${id}`;
  const expected = expectedMode === 'logical' ? LOGICAL : EXACT;
  const modes = (domain.constraintBindings || []).filter((binding) => (
    binding.targetElement === predicate
    && (binding.constraintRef === EXACT || binding.constraintRef === LOGICAL)
  ));
  return modes.length === 1 && modes[0].constraintRef === expected;
}

function hasBinding(domain, constraint, target) {
  return (domain.constraintBindings || []).some((binding) => (
    binding.constraintRef === constraint && binding.targetElement === target
  ));
}

function constraintExpressionIncludes(domain, name, fragments) {
  const expression = String(domain.constraints?.[name]?.expression?.expression || '');
  return fragments.every((fragment) => expression.includes(fragment));
}

function codeNotations(codeList) {
  return (codeList?.values || []).map((value) => value.notation);
}

function exactList(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function validateCommon(moduleDocument, label) {
  const errors = [];
  const domain = moduleDocument?.domain || {};
  const containers = [
    'objectTypes', 'associationTypes', 'relationTypes', 'attributeTypes',
    'identifierTypes', 'codeLists', 'constraints', 'relationUses', 'constraintBindings',
  ];
  for (const container of containers) {
    if (domain[container] === undefined) errors.push(`${label}:missing-container:${container}`);
  }
  for (const [kind, values] of [
    ['object', domain.objectTypes || {}],
    ['association', domain.associationTypes || {}],
  ]) {
    for (const [name, element] of Object.entries(values)) {
      if (!exactFactPatterns(element)) errors.push(`${label}:${kind}:${name}:fact-patterns`);
    }
  }
  for (const [name, association] of Object.entries(domain.associationTypes || {})) {
    for (const participant of association.participantRoles || []) {
      if (!participant.label || !participant.definition) {
        errors.push(`${label}:association:${name}:role-documentation:${participant.id}`);
      }
      const predicate = `${association.iri}/role/${participant.id}`;
      const modes = (domain.constraintBindings || []).filter((binding) => (
        binding.targetElement === predicate
        && (binding.constraintRef === EXACT || binding.constraintRef === LOGICAL)
      ));
      if (modes.length !== 1) errors.push(`${label}:association:${name}:role-mode:${participant.id}`);
    }
  }
  return errors;
}

function validateCodeListEvidence(document, moduleId, name, codeList, options, errors, pending) {
  const destination = document.module?.status === 'approved' ? errors : pending;
  if (String(codeList?.sourceEvidenceRef || '').startsWith(PENDING)) {
    destination.push(`${moduleId}:code-list-evidence:${name}`);
    return;
  }
  if (codeList?.sourceEvidenceRef !== CODE_LIST_AUTHORITY_REFERENCE_IRI) {
    errors.push(`${moduleId}:code-list-evidence:${name}:noncanonical-reference`);
    return;
  }
  if (!options?.codeListAuthorityState) return;
  for (const authorityError of validateCodeListAuthority(codeList, {
    authorityState: options.codeListAuthorityState,
    codeListName: name,
    moduleId,
  })) {
    destination.push(`${moduleId}:code-list-authority:${name}:${authorityError}`);
  }
}

function validateFoundation(document, options = {}) {
  const errors = validateCommon(document, 'foundation');
  const pending = [];
  const d = document.domain;
  const requiredObjects = [
    'IdentifiableSubject', 'Party', 'LegalEntity', 'IdentifierAuthority', 'IdentifierScheme',
    'IdentifierValue', 'ISINValue', 'LEIValue', 'MICValue', 'LocalIdentifierValue',
    'FinancialAccount', 'Currency', 'Jurisdiction', 'ISO4217RegistryEntry',
  ];
  const requiredAssociations = [
    'IdentifierSchemeAuthorization', 'FinancialIdentifierAssignment',
    'IdentifierAssignmentConflict', 'FinancialAccountPartyRole', 'CurrencyUsage',
  ];
  for (const name of requiredObjects) {
    if (d.objectTypes?.[name]?.iri !== `${FOUNDATION}${name}`) errors.push(`foundation:object:${name}`);
  }
  for (const name of requiredAssociations) {
    if (d.associationTypes?.[name]?.iri !== `${FOUNDATION}${name}`) errors.push(`foundation:association:${name}`);
  }

  if (!d.identifierTypes?.LocalIdentifier
      || d.attributeTypes?.localIdentifierLexicalValue?.valueType !== `${FOUNDATION}LocalIdentifier`) {
    errors.push('foundation:local-identifier-type');
  }
  if (d.constraints?.MICValidation?.expression?.expression
      !== 'profile=MIC;pattern=^[A-Z0-9]{4}$;length=4;algorithm=none') {
    errors.push('foundation:mic-four-character-contract');
  }
  if (!String(d.constraints?.LEIValidation?.expression?.expression || '')
    .includes('algorithm=ISO/IEC 7064 MOD 97-10')) {
    errors.push('foundation:lei-mod97-contract');
  }
  if (d.attributeTypes.hasCurrencyCode
      || (d.objectTypes.Currency.attributeUses || []).some((use) => use.attribute === `${FOUNDATION}hasCurrencyCode`)) {
    errors.push('foundation:currency-duplicate-code-truth');
  }

  const entry = d.objectTypes.ISO4217RegistryEntry;
  for (const attribute of [
    'iso4217AlphaCode', 'iso4217NumericCode', 'iso4217MinorUnit',
    'iso4217EntryStatus', 'iso4217RegistrySourceRef',
  ]) {
    if (!attributeUse(entry, `${FOUNDATION}${attribute}`, 1, 1)) {
      errors.push(`foundation:iso4217-entry-attribute:${attribute}`);
    }
  }
  if (!relationUse(
    d,
    `${FOUNDATION}iso4217RegistryAuthority`,
    `${FOUNDATION}ISO4217RegistryEntry`,
    `${FOUNDATION}IdentifierAuthority`,
    1,
    1,
    'logical',
  )) errors.push('foundation:iso4217-authority-relation');
  if (!relationUse(
    d,
    `${FOUNDATION}iso4217EntryCurrency`,
    `${FOUNDATION}ISO4217RegistryEntry`,
    `${FOUNDATION}Currency`,
    1,
    1,
    'logical',
  )) errors.push('foundation:iso4217-currency-relation');

  const usage = d.associationTypes.CurrencyUsage;
  if (!role(usage, 'usedCurrency', `${FOUNDATION}Currency`, 1, 1)
      || !roleMode(d, usage, 'usedCurrency', 'logical')
      || !role(usage, 'usageJurisdiction', `${FOUNDATION}Jurisdiction`, 1, 1)
      || !roleMode(d, usage, 'usageJurisdiction', 'logical')) {
    errors.push('foundation:currency-usage-contract');
  }

  const account = d.objectTypes.FinancialAccount;
  if (!attributeUse(account, `${FOUNDATION}accountType`, 1, 1)
      || !relationUse(
        d,
        `${FOUNDATION}accountIdentifierScheme`,
        `${FOUNDATION}FinancialAccount`,
        `${FOUNDATION}IdentifierScheme`,
        1,
        1,
        'logical',
      )
      || !relationUse(
        d,
        `${FOUNDATION}accountIdentifierValue`,
        `${FOUNDATION}FinancialAccount`,
        `${FOUNDATION}LocalIdentifierValue`,
        1,
        1,
        'logical',
      )) {
    errors.push('foundation:financial-account-identity');
  }

  const expectedLists = {
    IdentifierSchemeKind: [
      'gleifLei', 'iso6166Isin', 'iso10383Mic',
      'internalInstrument', 'financialAccount', 'venueListing',
    ],
    IdentifierUniquenessScope: ['global', 'authorityScoped'],
    IdentifierAuthorityRole: ['assigningAuthority'],
    AccountType: ['cash', 'securitiesCustody', 'multiAsset'],
    FinancialAccountPartyRoleKind: [
      'accountHolder', 'beneficialOwner', 'authorizedOperator', 'custodian',
    ],
    ISO4217EntryStatus: ['active', 'withdrawn'],
  };
  for (const [name, expected] of Object.entries(expectedLists)) {
    const codeList = d.codeLists?.[name];
    if (!codeList || !exactList(codeNotations(codeList), expected)) {
      errors.push(`foundation:code-list:${name}`);
      continue;
    }
    if ((codeList.values || []).some((value) => value.iri !== `${codeList.iri}/value/${value.notation}`)) {
      errors.push(`foundation:code-member-iri:${name}`);
    }
  }

  for (const [name, codeList] of Object.entries(d.codeLists || {})) {
    validateCodeListEvidence(
      document,
      'foundation',
      name,
      codeList,
      options,
      errors,
      pending,
    );
  }
  return { errors, pending };
}

function validateMarketRules(document, options = {}) {
  const errors = validateCommon(document, 'market-rules');
  const pending = [];
  const evidence = [];
  const d = document.domain;
  const importIris = (document.module.imports || []).map((value) => value.moduleIri);
  const expectedImports = [
    'https://axiolune.ai/ontology/finance/foundation',
    'https://axiolune.ai/ontology/finance/market-structure',
    'https://axiolune.ai/ontology/finance/instruments',
  ];
  if (!exactList(importIris, expectedImports)) errors.push('market-rules:canonical-imports');

  const requiredObjects = [
    'MarketRuleSet', 'MarketRule', 'RuleClause', 'RuleParameter',
    'TickSizeClause', 'LotSizeClause', 'PriceLimitClause', 'CircuitBreakerClause',
    'SettlementCycleClause', 'ResaleRestrictionClause', 'CorporateActionEntitlementClause',
    'CorporateActionDateResolutionClause', 'CorporateActionDateOrderingClause',
    'TickScheduleRule', 'LotScheduleRule', 'PriceLimitRule', 'CircuitBreakerRule',
    'SettlementCycleRule', 'ResaleRestrictionRule', 'CorporateActionDistributionAssessmentMethod',
    'CorporateActionScheduleRule',
    'RuleEvaluationRequest',
  ];
  for (const name of requiredObjects) {
    if (d.objectTypes?.[name]?.iri !== `${RULES}${name}`) errors.push(`market-rules:object:${name}`);
  }
  for (const name of ['RuleApplicability', 'RulePrecedence', 'RuleConflict']) {
    if (d.associationTypes?.[name]?.iri !== `${RULES}${name}`) errors.push(`market-rules:association:${name}`);
  }
  for (const forbidden of ['InstrumentClass', 'RuleLifecycleStatus', 'CorporateActionDistributionAssessmentMethod']) {
    if (d.codeLists?.[forbidden]) errors.push(`market-rules:deferred-code-list:${forbidden}`);
  }
  for (const forbidden of [
    'appliesToInstrumentClass', 'classifierScope', 'investorCategoryScope',
    'corporateActionEntitlementBasis', 'recordDateOffset', 'exDateOffset',
    'paymentDateOffset', 'distributionPercentageBoundary',
  ]) {
    if (d.attributeTypes?.[forbidden]) errors.push(`market-rules:deferred-scope:${forbidden}`);
  }

  const applicability = d.associationTypes.RuleApplicability;
  const scopes = [
    ['scopeListingVersion', 'https://axiolune.ai/ontology/finance/instruments/InstrumentListing'],
    ['scopeInstrumentVersion', 'https://axiolune.ai/ontology/finance/instruments/FinancialInstrument'],
    ['scopeSegmentVersion', 'https://axiolune.ai/ontology/finance/market-structure/MarketSegment'],
    ['scopeVenueVersion', 'https://axiolune.ai/ontology/finance/market-structure/TradingFacility'],
    ['scopeJurisdictionVersion', `${FOUNDATION}Jurisdiction`],
  ];
  for (const [id, range] of scopes) {
    if (!role(applicability, id, range, 0, 1) || !roleMode(d, applicability, id, 'version')) {
      errors.push(`market-rules:applicability-scope:${id}`);
    }
  }
  if (!attributeUse(applicability, `${RULES}applicabilityAccountType`, 0, 1)
      || d.attributeTypes?.applicabilityAccountType?.valueType !== `${FOUNDATION}AccountType`
      || !hasBinding(d, `${RULES}RuleApplicabilityRequiresExplicitScope`, applicability.iri)
      || !hasBinding(d, `${RULES}RuleApplicabilityMustMatchRequest`, applicability.iri)) {
    errors.push('market-rules:applicability-explicit-scope');
  }

  const request = d.objectTypes.RuleEvaluationRequest;
  for (const attribute of [
    'ruleEvaluationRequestId', 'asOfValid', 'asOfKnowledge', 'asOfAvailable',
  ]) {
    if (!attributeUse(request, `${RULES}${attribute}`, 1, 1)) {
      errors.push(`market-rules:request-attribute:${attribute}`);
    }
  }
  if (!attributeUse(request, `${RULES}requestAccountType`, 0, 1)
      || d.attributeTypes?.requestAccountType?.valueType !== `${FOUNDATION}AccountType`) {
    errors.push('market-rules:request-account-type-contract');
  }
  for (const attribute of [
    'https://axiolune.ai/ontology/meta/data-binding/attributes/inputContextRef',
    'https://axiolune.ai/ontology/meta/data-binding/attributes/inputContextRecordDigest',
  ]) {
    if (!attributeUse(request, attribute, 1, 1)) {
      errors.push(`market-rules:request-attribute:${attribute}`);
    }
  }
  const requestRelations = [
    ['requestAuthority', `${FOUNDATION}Party`, 1, 1],
    ['requestListingScope', 'https://axiolune.ai/ontology/finance/instruments/InstrumentListing', 0, 1],
    ['requestInstrumentScope', 'https://axiolune.ai/ontology/finance/instruments/FinancialInstrument', 0, 1],
    ['requestSegmentScope', 'https://axiolune.ai/ontology/finance/market-structure/MarketSegment', 0, 1],
    ['requestVenueScope', 'https://axiolune.ai/ontology/finance/market-structure/TradingFacility', 0, 1],
    ['requestJurisdictionScope', `${FOUNDATION}Jurisdiction`, 0, 1],
  ];
  for (const [name, range, min, max] of requestRelations) {
    if (!relationUse(d, `${RULES}${name}`, request.iri, range, min, max, 'version')) {
      errors.push(`market-rules:request-relation:${name}`);
    }
  }
  if (!hasBinding(d, `${RULES}RuleEvaluationRequestIntegrity`, request.iri)
      || !constraintExpressionIncludes(d, 'RuleEvaluationRequestIntegrity', [
        'identityBaseIri=https://axiolune.ai/data/rule-evaluation-request',
        'logicalKey(versionOf(requestAuthority),ruleEvaluationRequestId)',
        'versionKey(validFrom,knowledgeFrom,availableFrom,revision)',
        'inputContext=strictlyPrior',
        'pitAxes=3',
        'scopeClosure=listingToInstrumentAndFacility|segmentToVenue',
      ])) {
    errors.push('market-rules:request-identity-runtime-contract');
  }

  const conflict = d.associationTypes.RuleConflict;
  if (!role(conflict, 'candidateApplicabilityVersion', applicability.iri, 2, null)
      || !roleMode(d, conflict, 'candidateApplicabilityVersion', 'version')
      || !role(conflict, 'evaluationRequestVersion', request.iri, 1, 1)
      || !roleMode(d, conflict, 'evaluationRequestVersion', 'version')
      || !attributeUse(conflict, `${RULES}ruleConflictKind`, 1, 1)
      || !attributeUse(conflict, `${RULES}candidateApplicabilitySetDigest`, 1, 1)
      || !attributeUse(
        conflict,
        'https://axiolune.ai/ontology/meta/data-binding/attributes/generatingContextRef',
        1,
        1,
      )
      || !constraintExpressionIncludes(d, 'RuleConflictNoSilentWinner', [
        'identityBaseIri=https://axiolune.ai/data/rule-conflict',
        'logicalKey(versionOf(evaluationRequestVersion),candidateApplicabilitySetDigest)',
        'versionKey(validFrom,knowledgeFrom,availableFrom,revision)',
        'winner=forbidden',
        'candidateSetDigest=required',
        'exactCurrentConflictCount=1',
        'generatingRunLedgerJoin=completed',
      ])) {
    errors.push('market-rules:materialized-conflict-contract');
  }

  if (!hasBinding(d, `${RULES}RuleParameterExclusiveOneOf`, `${RULES}RuleParameter`)
      || !relationUse(
        d,
        `${RULES}parameterClauseReference`,
        `${RULES}RuleParameter`,
        `${RULES}RuleClause`,
        0,
        1,
        'version',
      )) {
    errors.push('market-rules:parameter-xone');
  }
  if (!hasBinding(d, `${RULES}RuleClauseRangeIntegrity`, `${RULES}RuleClause`)
      || !hasBinding(d, `${RULES}RuleSubtypeClauseCompatibility`, `${RULES}MarketRule`)
      || !attributeUse(d.objectTypes.MarketRule, `${RULES}ruleGapPolicy`, 1, 1)) {
    errors.push('market-rules:clause-execution-contract');
  }
  if (!hasBinding(d, `${RULES}RulePriorityComparability`, applicability.iri)
      || !constraintExpressionIncludes(d, 'RulePriorityComparability', [
        'crossAuthority=false',
        'sameRuleSetVersion=true',
        'authoritativeSource=provenance.source',
        'normalizedScopeDigest=identical',
        'authorityLedgerJoin=reviewed',
      ])) {
    errors.push('market-rules:priority-authority-contract');
  }
  if (!hasBinding(d, `${RULES}RulePrecedenceIntegrity`, `${RULES}RulePrecedence`)
      || !constraintExpressionIncludes(d, 'RulePrecedenceIntegrity', [
        'sameRuleKind=true',
        'normalizedScopeOverlap=true',
        'authoritativeSource=provenance.source',
        'reviewedReason=required',
        'authorityLedgerJoin=reviewed',
        'activeAtThreeAxisPit=true',
        'closureAware=true',
        'closureRunCompletedByReference=true',
        'halfOpenIntervals=true',
        'irreflexive=true',
        'acyclic=true',
      ])
      || !hasBinding(d, `${RULES}RuleConflictNoSilentWinner`, `${RULES}RuleConflict`)) {
    errors.push('market-rules:precedence-conflict-contract');
  }
  const schedule = d.objectTypes.CorporateActionScheduleRule;
  for (const attribute of [
    'corporateActionKind', 'scheduleDateResolutionContractDigest',
    'scheduleDateOrderingContractDigest', 'scheduleCalendarCutoffContractDigest',
  ]) {
    if (!attributeUse(schedule, `${RULES}${attribute}`, 1, 1)) {
      errors.push(`market-rules:schedule-attribute:${attribute}`);
    }
  }
  for (const attribute of [
    'distributionPercentageLowerBound', 'distributionPercentageLowerInclusive',
    'distributionPercentageUpperBound', 'distributionPercentageUpperInclusive',
    'nonTransferableDirectSubscription',
  ]) {
    if (!attributeUse(schedule, `${RULES}${attribute}`, 0, 1)) {
      errors.push(`market-rules:schedule-attribute:${attribute}`);
    }
  }
  if (!relationUse(
    d,
    `${RULES}corporateActionDistributionAssessmentMethod`,
    schedule.iri,
    `${RULES}CorporateActionDistributionAssessmentMethod`,
    0,
    1,
    'version',
  ) || !hasBinding(d, `${RULES}CorporateActionScheduleRuleIntegrity`, schedule.iri)) {
    errors.push('market-rules:schedule-integrity');
  }
  const method = d.objectTypes.CorporateActionDistributionAssessmentMethod;
  for (const attribute of [
    'distributionAssessmentMethodId', 'distributionAssessmentInputKind',
    'distributionAssessmentPriceSelection', 'distributionAssessmentRequiresMarketPrice',
    'distributionAssessmentPrecision', 'distributionAssessmentRoundingMode',
    'distributionAssessmentFormulaDigest', 'distributionAssessmentImplementationDigest',
  ]) {
    if (!attributeUse(method, `${RULES}${attribute}`, 1, 1)) {
      errors.push(`market-rules:assessment-method-attribute:${attribute}`);
    }
  }
  if (!attributeUse(method, `${RULES}distributionAssessmentRequiredPriceKindIri`, 0, 1)
      || !relationUse(
        d,
        `${RULES}distributionAssessmentMethodAuthority`,
        method.iri,
        `${FOUNDATION}Party`,
        1,
        1,
        'version',
      )
      || !hasBinding(d, `${RULES}CorporateActionDistributionAssessmentMethodIntegrity`, method.iri)) {
    errors.push('market-rules:assessment-method-integrity');
  }
  const entitlement = d.objectTypes.CorporateActionEntitlementClause;
  for (const attribute of ['corporateActionEntitlementMode', 'entitlementPivotDateField']) {
    if (!attributeUse(entitlement, `${RULES}${attribute}`, 1, 1)) {
      errors.push(`market-rules:entitlement-attribute:${attribute}`);
    }
  }
  for (const attribute of [
    'cumEntitlementTradeStartOffset', 'cumEntitlementTradeEndOffset',
    'dueBillSettlementQualification',
  ]) {
    if (!attributeUse(entitlement, `${RULES}${attribute}`, 0, 1)) {
      errors.push(`market-rules:entitlement-attribute:${attribute}`);
    }
  }
  if (!hasBinding(d, `${RULES}CorporateActionEntitlementClauseIntegrity`, entitlement.iri)) {
    errors.push('market-rules:entitlement-integrity');
  }
  const dateResolution = d.objectTypes.CorporateActionDateResolutionClause;
  for (const attribute of [
    'resolvedDateRole', 'sourceEventDateField', 'dateResolutionOffset', 'dateBusinessDayAdjustment',
  ]) {
    if (!attributeUse(dateResolution, `${RULES}${attribute}`, 1, 1)) {
      errors.push(`market-rules:date-resolution-attribute:${attribute}`);
    }
  }
  if (!hasBinding(d, `${RULES}CorporateActionDateResolutionClauseIntegrity`, dateResolution.iri)) {
    errors.push('market-rules:date-resolution-integrity');
  }
  const dateOrdering = d.objectTypes.CorporateActionDateOrderingClause;
  for (const attribute of [
    'orderingLeftDateRole', 'dateOrderingOperator', 'orderingRightDateRole',
  ]) {
    if (!attributeUse(dateOrdering, `${RULES}${attribute}`, 1, 1)) {
      errors.push(`market-rules:date-ordering-attribute:${attribute}`);
    }
  }
  if (!hasBinding(d, `${RULES}CorporateActionDateOrderingClauseIntegrity`, dateOrdering.iri)) {
    errors.push('market-rules:date-ordering-integrity');
  }
  if (d.objectTypes.SettlementCycleClause.attributeUses.some((use) => use.attribute.includes('Resale'))
      || d.objectTypes.ResaleRestrictionClause.attributeUses.some((use) => use.attribute.includes('settlementCycle'))) {
    errors.push('market-rules:settlement-resale-conflation');
  }

  const expectedLists = {
    RuleType: [
      'tickSchedule', 'lotSchedule', 'priceLimit', 'circuitBreaker',
      'settlementCycle', 'resaleRestriction', 'corporateActionSchedule',
    ],
    ClauseGapPolicy: ['reject', 'allow'],
    RuleConflictKind: ['incompatibleResults', 'incomparableAuthorities'],
    CorporateActionKind: ['cashDividend', 'stockSplit', 'rightsIssue'],
    CorporateActionDistributionAssessmentInputKind: [
      'cashCalculated', 'splitCalculated', 'rightsCalculated', 'officialPercentage',
    ],
    CorporateActionPriceSelectionFunction: ['exactAt', 'latestStrictlyBefore', 'notApplicable'],
    CorporateActionEntitlementMode: ['ordinaryRecordPosition', 'dueBillAdjusted'],
    CorporateActionEventDateField: [
      'announcementDate', 'exDate', 'recordDate', 'paymentDate', 'effectiveDate', 'electionDeadline',
    ],
    CorporateActionResolvedDateRole: [
      'announcementDate', 'exDate', 'recordDate', 'paymentDate', 'effectiveDate', 'electionDeadline',
      'subscriptionCashDueDate', 'successorDeliveryDate',
    ],
    CorporateActionBusinessDayAdjustment: ['unadjusted', 'preceding', 'following'],
    CorporateActionDateOrderingOperator: ['before', 'notAfter', 'sameDate', 'notBefore', 'after'],
    CorporateActionSettlementQualification: ['executionOnly', 'settlementEvidence'],
  };
  for (const [name, expected] of Object.entries(expectedLists)) {
    const codeList = d.codeLists?.[name];
    if (!codeList || !exactList(codeNotations(codeList), expected)) {
      errors.push(`market-rules:code-list:${name}`);
    }
  }
  for (const [name, codeList] of Object.entries(d.codeLists || {})) {
    if ((codeList.values || []).some((value) => value.iri !== `${codeList.iri}/value/${value.notation}`)) {
      errors.push(`market-rules:code-member-iri:${name}`);
    }
    validateCodeListEvidence(
      document,
      'market-rules',
      name,
      codeList,
      options,
      errors,
      pending,
    );
  }
  try {
    const verified = verifyAllMarketRulesReleaseEvidence();
    evidence.push(...verified.checks.map((check) => check.id));
  } catch (error) {
    errors.push(`market-rules:runtime-evidence:${error.code || 'UNCAUGHT'}:${error.message}`);
  }
  return { errors, evidence, pending };
}

function temporalInterval(value) {
  try {
    const start = parseUtcInstantNanoseconds(value?.validFrom);
    const end = value?.validTo == null
      ? null
      : parseUtcInstantNanoseconds(value.validTo);
    if (end !== null && end <= start) return null;
    return { end, start };
  } catch {
    return null;
  }
}

function intervalOverlaps(left, right) {
  const leftInterval = temporalInterval(left);
  const rightInterval = temporalInterval(right);
  if (leftInterval === null || rightInterval === null) return false;
  return (rightInterval.end === null || leftInterval.start < rightInterval.end)
    && (leftInterval.end === null || rightInterval.start < leftInterval.end);
}

function present(value) {
  return value !== undefined && value !== null;
}

function validHttpIri(value) {
  return typeof value === 'string'
    && /^https?:\/\/[^\s\u0000-\u001f\u007f]+$/u.test(value)
    && value === value.normalize('NFC');
}

function sha256(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function quantity(value) {
  return value && typeof value === 'object'
    && isDecimalLexical(value.value)
    && typeof value.unit === 'string'
    && value.unit.trim().length > 0
    && !/[\u0000-\u001f\u007f]/u.test(value.unit)
    && value.unit === value.unit.normalize('NFC');
}

function compareQuantityValues(left, right) {
  if (!quantity(left) || !quantity(right) || left.unit !== right.unit) return null;
  return compareDecimalLexical(left.value, right.value);
}

function positiveQuantity(value) {
  return quantity(value) && compareDecimalLexical(value.value, '0') > 0;
}

function nonNegativeQuantity(value) {
  return quantity(value) && compareDecimalLexical(value.value, '0') >= 0;
}

function money(value) {
  return value && typeof value === 'object'
    && isDecimalLexical(value.amount)
    && /^[A-Z]{3}$/u.test(value.currency || '')
    && Number.isSafeInteger(value.scale)
    && value.scale >= 0;
}

function canonicalToken(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value === value.normalize('NFC');
}

function validateInstance(instance) {
  const foundation = instance.foundation || {};
  const rules = instance.marketRules || {};

  const registryEntries = foundation.registryEntries || [];
  for (const entry of registryEntries) {
    if (temporalInterval(entry) === null
        || typeof entry.alphaCode !== 'string'
        || !/^[A-Z]{3}$/.test(entry.alphaCode)
        || typeof entry.numericCode !== 'string'
        || !/^[0-9]{3}$/.test(entry.numericCode)
        || !Number.isInteger(entry.minorUnit)
        || entry.minorUnit < 0
        || !validHttpIri(entry.authorityLogicalIri)
        || !validHttpIri(entry.currencyLogicalIri)
        || !validHttpIri(entry.sourceRef)) {
      return 'iso4217-entry-integrity';
    }
  }
  for (let left = 0; left < registryEntries.length; left += 1) {
    for (let right = left + 1; right < registryEntries.length; right += 1) {
      const a = registryEntries[left];
      const b = registryEntries[right];
      if (a.authorityLogicalIri === b.authorityLogicalIri
          && a.alphaCode === b.alphaCode
          && intervalOverlaps(a, b)) {
        return 'iso4217-pit-uniqueness';
      }
    }
  }
  for (const usage of foundation.currencyUsages || []) {
    if (!validHttpIri(usage.currencyLogicalIri)
        || !validHttpIri(usage.jurisdictionLogicalIri)) {
      return 'currency-usage-cardinality';
    }
  }

  for (const parameter of rules.parameters || []) {
    const branches = [
      present(parameter.money),
      present(parameter.quantity),
      present(parameter.code),
      present(parameter.clauseReference),
    ].filter(Boolean).length;
    if (branches !== 1) return 'rule-parameter-xone';
    if (!canonicalToken(parameter.id)) return 'rule-parameter-identity';
    if (present(parameter.money) && !money(parameter.money)) {
      return 'rule-parameter-money';
    }
    if (present(parameter.quantity) && !quantity(parameter.quantity)) {
      return 'rule-parameter-quantity';
    }
    if (present(parameter.code) && !canonicalToken(parameter.code)) {
      return 'rule-parameter-code';
    }
    if (present(parameter.clauseReference) && !validHttpIri(parameter.clauseReference)) {
      return 'rule-parameter-clause-reference';
    }
  }

  const ruleByVersion = new Map((rules.rules || []).map((value) => [value.versionIri, value]));
  const assessmentMethodByVersion = new Map(
    (rules.distributionAssessmentMethods || []).map((value) => [value.versionIri, value]),
  );
  for (const method of rules.distributionAssessmentMethods || []) {
    if (!validHttpIri(method.versionIri)
        || !validHttpIri(method.authorityVersionIri)
        || typeof method.methodId !== 'string'
        || method.methodId.trim().length === 0
        || !['cashCalculated', 'splitCalculated', 'rightsCalculated', 'officialPercentage'].includes(method.inputKind)
        || !['exactAt', 'latestStrictlyBefore', 'notApplicable'].includes(method.priceSelection)
        || typeof method.requiresMarketPrice !== 'boolean'
        || !Number.isInteger(method.precision)
        || method.precision < 0
        || typeof method.roundingMode !== 'string'
        || method.roundingMode.trim().length === 0
        || !sha256(method.formulaDigest)
        || !sha256(method.implementationDigest)) {
      return 'corporate-action-assessment-method-integrity';
    }
    const hasPriceKind = validHttpIri(method.requiredPriceKindIri);
    if (method.requiresMarketPrice
      ? (method.priceSelection === 'notApplicable' || !hasPriceKind)
      : (method.priceSelection !== 'notApplicable' || present(method.requiredPriceKindIri))) {
      return 'corporate-action-assessment-method-price-matrix';
    }
  }
  for (const rule of rules.rules || []) {
    if (!['reject', 'allow'].includes(rule.gapPolicy)) return 'rule-gap-policy';
  }
  const clausesByRule = new Map();
  for (const clause of rules.clauses || []) {
    const values = clausesByRule.get(clause.ruleVersionIri) || [];
    values.push(clause);
    clausesByRule.set(clause.ruleVersionIri, values);
    if (clause.type === 'SettlementCycleClause'
        && (present(clause.sameDayResaleAllowed) || present(clause.minimumResaleHoldingPeriod))) {
      return 'settlement-resale-conflation';
    }
    if (clause.type === 'ResaleRestrictionClause' && present(clause.settlementCycle)) {
      return 'settlement-resale-conflation';
    }
    if (clause.type === 'PriceLimitClause'
        && [present(clause.priceLimitPercentage), present(clause.priceLimitAmount)].filter(Boolean).length !== 1) {
      return 'price-limit-boundary-xone';
    }
    if (clause.type === 'TickSizeClause' && !positiveQuantity(clause.tickSize)) {
      return 'tick-size-quantity';
    }
    if (clause.type === 'LotSizeClause' && !positiveQuantity(clause.lotSize)) {
      return 'lot-size-quantity';
    }
    if (clause.type === 'SettlementCycleClause'
        && (!nonNegativeQuantity(clause.settlementCycle)
          || clause.settlementCycle.unit !== 'https://axiolune.ai/units/business-day')) {
      return 'settlement-cycle-quantity';
    }
    if (clause.type === 'ResaleRestrictionClause'
        && present(clause.minimumResaleHoldingPeriod)
        && (!nonNegativeQuantity(clause.minimumResaleHoldingPeriod)
          || clause.minimumResaleHoldingPeriod.unit !== 'https://axiolune.ai/units/business-day')) {
      return 'resale-holding-period-quantity';
    }
    if (clause.type === 'PriceLimitClause'
        && present(clause.priceLimitPercentage)
        && !positiveQuantity(clause.priceLimitPercentage)) {
      return 'price-limit-percentage-quantity';
    }
    if (clause.type === 'PriceLimitClause'
        && present(clause.priceLimitAmount)
        && !money(clause.priceLimitAmount)) {
      return 'price-limit-money';
    }
    if ((present(clause.lower) && !isDecimalLexical(clause.lower))
        || (present(clause.upper) && !isDecimalLexical(clause.upper))) {
      return 'rule-clause-range';
    }
  }
  for (const clauses of clausesByRule.values()) {
    const ordered = [...clauses].sort((a, b) => a.sequence - b.sequence);
    const sequences = new Set();
    for (let index = 0; index < ordered.length; index += 1) {
      const clause = ordered[index];
      if (!Number.isInteger(clause.sequence) || clause.sequence < 0 || sequences.has(clause.sequence)) {
        return 'rule-clause-order';
      }
      sequences.add(clause.sequence);
      if (present(clause.lower) && present(clause.upper)
          && compareDecimalLexical(clause.lower, clause.upper) >= 0) {
        return 'rule-clause-range';
      }
      if (index > 0) {
        const prior = ordered[index - 1];
        if (present(prior.upper) && present(clause.lower)
            && compareDecimalLexical(prior.upper, clause.lower) > 0) {
          return 'rule-clause-overlap';
        }
        if (present(prior.upper) && present(clause.lower)
            && compareDecimalLexical(prior.upper, clause.lower) < 0
            && ruleByVersion.get(clause.ruleVersionIri)?.gapPolicy !== 'allow') {
          return 'rule-clause-gap';
        }
      }
    }
  }

  const requestByIri = new Map((rules.requests || []).map((value) => [value.versionIri, value]));
  for (const applicability of rules.applicabilities || []) {
    const scopes = applicability.scopes || {};
    const keys = ['listing', 'instrument', 'segment', 'venue', 'accountType', 'jurisdiction'];
    const authored = keys.filter((key) => present(scopes[key]));
    if (authored.length === 0) return 'rule-applicability-empty-scope';
    const request = requestByIri.get(applicability.requestVersionIri);
    if (!request) return 'rule-applicability-request';
    if (authored.some((key) => request.scopes?.[key] !== scopes[key])) return 'rule-applicability-scope-mismatch';
    if (present(applicability.classifier) || present(applicability.investorCategory)) {
      return 'rule-applicability-deferred-scope';
    }
  }

  const adjacency = new Map();
  for (const edge of rules.precedence || []) {
    const higher = ruleByVersion.get(edge.higherRuleVersionIri);
    const lower = ruleByVersion.get(edge.lowerRuleVersionIri);
    if (!higher || !lower || higher.kind !== lower.kind || edge.higherRuleVersionIri === edge.lowerRuleVersionIri) {
      return 'rule-precedence-integrity';
    }
    const values = adjacency.get(edge.higherRuleVersionIri) || [];
    values.push(edge.lowerRuleVersionIri);
    adjacency.set(edge.higherRuleVersionIri, values);
  }
  const visiting = new Set();
  const visited = new Set();
  function cycle(node) {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const child of adjacency.get(node) || []) if (cycle(child)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  }
  for (const node of adjacency.keys()) if (cycle(node)) return 'rule-precedence-cycle';

  for (const rule of rules.rules || []) {
    if (rule.kind !== 'corporateActionSchedule') continue;
    if (!['cashDividend', 'stockSplit', 'rightsIssue'].includes(rule.corporateActionKind)
        || !sha256(rule.dateResolutionContractDigest)
        || !sha256(rule.dateOrderingContractDigest)
        || !sha256(rule.calendarCutoffContractDigest)) {
      return 'corporate-action-schedule-integrity';
    }
    const owned = (rules.clauses || []).filter((clause) => clause.ruleVersionIri === rule.versionIri);
    const entitlementClauses = owned.filter((clause) => clause.type === 'CorporateActionEntitlementClause');
    if (entitlementClauses.length !== 1) {
      return 'corporate-action-entitlement-clause';
    }
    const [entitlement] = entitlementClauses;
    if (!['ordinaryRecordPosition', 'dueBillAdjusted'].includes(entitlement.entitlementMode)
        || ![
          'announcementDate', 'exDate', 'recordDate',
          'paymentDate', 'effectiveDate', 'electionDeadline',
        ].includes(entitlement.entitlementPivotDateField)) {
      return 'corporate-action-entitlement-mode';
    }
    const dueFields = [
      present(entitlement.cumEntitlementTradeStartOffset),
      present(entitlement.cumEntitlementTradeEndOffset),
      present(entitlement.settlementQualification),
    ];
    if (entitlement.entitlementMode === 'ordinaryRecordPosition') {
      if (dueFields.some(Boolean)) return 'corporate-action-entitlement-mode';
    } else {
      const dueIntervalComparison = compareQuantityValues(
        entitlement.cumEntitlementTradeStartOffset,
        entitlement.cumEntitlementTradeEndOffset,
      );
      if (!dueFields.every(Boolean)
          || !quantity(entitlement.cumEntitlementTradeStartOffset)
          || !quantity(entitlement.cumEntitlementTradeEndOffset)
          || dueIntervalComparison === null
          || dueIntervalComparison >= 0
          || !['executionOnly', 'settlementEvidence'].includes(entitlement.settlementQualification)) {
        return 'corporate-action-due-bill-interval';
      }
    }

    const eventDateFields = new Set([
      'announcementDate', 'exDate', 'recordDate',
      'paymentDate', 'effectiveDate', 'electionDeadline',
    ]);
    const resolvedDateRoles = new Set([
      ...eventDateFields, 'subscriptionCashDueDate', 'successorDeliveryDate',
    ]);
    const resolutionClauses = owned.filter(
      (clause) => clause.type === 'CorporateActionDateResolutionClause',
    );
    const orderingClauses = owned.filter(
      (clause) => clause.type === 'CorporateActionDateOrderingClause',
    );
    const resolvedCounts = new Map();
    for (const clause of resolutionClauses) {
      resolvedCounts.set(clause.resolvedDateRole, (resolvedCounts.get(clause.resolvedDateRole) || 0) + 1);
      if (!resolvedDateRoles.has(clause.resolvedDateRole)
          || !eventDateFields.has(clause.sourceEventDateField)
          || !quantity(clause.dateResolutionOffset)
          || clause.dateResolutionOffset.unit !== 'https://axiolune.ai/units/business-day'
          || !['unadjusted', 'preceding', 'following'].includes(clause.dateBusinessDayAdjustment)) {
        return 'corporate-action-date-resolution-clause';
      }
    }
    if ([...resolvedCounts.values()].some((count) => count !== 1)) {
      return 'corporate-action-date-resolution-duplicate';
    }
    const requiredDates = {
      cashDividend: ['announcementDate', 'exDate', 'recordDate', 'paymentDate'],
      stockSplit: ['announcementDate', 'exDate', 'recordDate', 'effectiveDate'],
      rightsIssue: [
        'announcementDate', 'exDate', 'recordDate', 'electionDeadline', 'effectiveDate',
        'subscriptionCashDueDate', 'successorDeliveryDate',
      ],
    }[rule.corporateActionKind];
    const allowedDates = new Set([
      ...requiredDates,
      ...(rule.corporateActionKind === 'rightsIssue' ? ['paymentDate'] : []),
    ]);
    if (requiredDates.some((role) => resolvedCounts.get(role) !== 1)
        || [...resolvedCounts.keys()].some((role) => !allowedDates.has(role))) {
      return 'corporate-action-date-resolution-coverage';
    }
    if (orderingClauses.length === 0) return 'corporate-action-date-ordering-clause';
    for (const clause of orderingClauses) {
      if (!resolvedDateRoles.has(clause.orderingLeftDateRole)
          || !resolvedDateRoles.has(clause.orderingRightDateRole)
          || clause.orderingLeftDateRole === clause.orderingRightDateRole
          || !resolvedCounts.has(clause.orderingLeftDateRole)
          || !resolvedCounts.has(clause.orderingRightDateRole)
          || !['before', 'notAfter', 'sameDate', 'notBefore', 'after'].includes(clause.dateOrderingOperator)) {
        return 'corporate-action-date-ordering-clause';
      }
    }

    const hasLower = present(rule.distributionPercentageLowerBound);
    const hasUpper = present(rule.distributionPercentageUpperBound);
    const hasInterval = hasLower || hasUpper;
    const percentageIntervalComparison = hasLower && hasUpper
      ? compareQuantityValues(
        rule.distributionPercentageLowerBound,
        rule.distributionPercentageUpperBound,
      )
      : null;
    if (hasLower !== present(rule.distributionPercentageLowerInclusive)
        || hasUpper !== present(rule.distributionPercentageUpperInclusive)
        || (hasLower && typeof rule.distributionPercentageLowerInclusive !== 'boolean')
        || (hasUpper && typeof rule.distributionPercentageUpperInclusive !== 'boolean')
        || (hasLower && !quantity(rule.distributionPercentageLowerBound))
        || (hasUpper && !quantity(rule.distributionPercentageUpperBound))
        || (hasLower && hasUpper
          && (percentageIntervalComparison === null
            || percentageIntervalComparison > 0
            || (percentageIntervalComparison === 0
              && (!rule.distributionPercentageLowerInclusive || !rule.distributionPercentageUpperInclusive))))) {
      return 'corporate-action-percentage-interval';
    }
    const hasMethod = present(rule.distributionAssessmentMethodVersionIri);
    if (hasMethod !== hasInterval) return 'corporate-action-method-interval-iff';
    if (hasMethod) {
      const method = assessmentMethodByVersion.get(rule.distributionAssessmentMethodVersionIri);
      if (!method) return 'corporate-action-assessment-method-version';
      const compatible = {
        cashDividend: ['cashCalculated', 'officialPercentage'],
        stockSplit: ['splitCalculated', 'officialPercentage'],
        rightsIssue: ['rightsCalculated', 'officialPercentage'],
      };
      if (!compatible[rule.corporateActionKind].includes(method.inputKind)) {
        return 'corporate-action-assessment-method-kind';
      }
    }
    const rightsField = present(rule.nonTransferableDirectSubscription);
    if (rule.corporateActionKind === 'rightsIssue') {
      if (!rightsField || rule.nonTransferableDirectSubscription !== true) {
        return 'corporate-action-rights-v03-contract';
      }
    } else if (rightsField) {
      return 'corporate-action-rights-v03-contract';
    }
  }

  const allowedClauseTypes = {
    tickSchedule: new Set(['TickSizeClause']),
    lotSchedule: new Set(['LotSizeClause']),
    priceLimit: new Set(['PriceLimitClause']),
    circuitBreaker: new Set(['CircuitBreakerClause']),
    settlementCycle: new Set(['SettlementCycleClause']),
    resaleRestriction: new Set(['ResaleRestrictionClause']),
    corporateActionSchedule: new Set([
      'CorporateActionEntitlementClause',
      'CorporateActionDateResolutionClause',
      'CorporateActionDateOrderingClause',
    ]),
  };
  for (const rule of rules.rules || []) {
    const allowed = allowedClauseTypes[rule.kind];
    const owned = clausesByRule.get(rule.versionIri) || [];
    if (!allowed || owned.length === 0 || owned.some((clause) => !allowed.has(clause.type))) {
      return 'rule-subtype-clause-matrix';
    }
  }
  return null;
}

function mutate(value, mutation) {
  const result = structuredClone(value);
  const parts = mutation.path.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  const leaf = parts.pop();
  let parent = result;
  for (const part of parts) parent = parent[Array.isArray(parent) ? Number(part) : part];
  if (mutation.op === 'remove') {
    if (Array.isArray(parent)) parent.splice(Number(leaf), 1);
    else delete parent[leaf];
  } else if (mutation.op === 'replace' || mutation.op === 'add') {
    if (Array.isArray(parent) && leaf === '-') parent.push(mutation.value);
    else parent[Array.isArray(parent) ? Number(leaf) : leaf] = mutation.value;
  } else {
    throw new Error(`unsupported mutation ${mutation.op}`);
  }
  return result;
}

module.exports = {
  loadYaml,
  mutate,
  validateFoundation,
  validateMarketRules,
  validateInstance,
};
