#!/usr/bin/env node
'use strict';

/**
 * Focused executable contract for RFC-001 sections 5.5 and 5.11.
 *
 * It validates the v0.3 typed source and exercises fail-closed
 * account/identifier fixtures. Pending external evidence is reported
 * separately from executable semantic failures.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const {
  canonicalJcs,
  validateSourceLocator,
} = require('./lib/strict-source-locator.cjs');
const {
  parseUtcInstantNanoseconds,
} = require('./lib/instant-lexical.cjs');
const {
  executeIdentifierConstraint,
  normalizeSchemeValidatorRegistry,
} = require('./lib/foundation-identifier-custom.cjs');
const {
  discoverIdentifierConstraints,
  loadCapabilityArtifacts,
} = require('./lib/foundation-identifier-capability.cjs');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_FILE = path.join(ROOT, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml');
const REFERENCE_LOCK_FILE = path.join(ROOT, 'docs', 'ontology', 'references', 'references.lock.yaml');
const POSITIVE_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'foundation-account-identity.yaml');
const NEGATIVE_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'negative', 'foundation-account-identity.yaml');
const BASE = 'https://axiolune.ai/ontology/finance/foundation/';
const TEMPORAL = 'https://axiolune.ai/ontology/meta/patterns/TemporalFact';
const PROVENANCED = 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact';
const LOGICAL_REFERENCE = 'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference';
const EXACT_VERSION_REFERENCE = 'https://axiolune.ai/ontology/meta/core/constraints/ExactVersionReference';
const IDENTIFIER_CONSTRAINT_BY_VALUE_TYPE = Object.freeze({
  ISINValue: `${BASE}ISINValidation`,
  LEIValue: `${BASE}LEIValidation`,
  LocalIdentifierValue: `${BASE}LocalIdentifierValidation`,
  MICValue: `${BASE}MICValidation`,
});
const STANDARD_SCHEME_VALIDATOR_BY_KIND = Object.freeze({
  gleifLei: `${BASE}LEIValidation`,
  iso10383Mic: `${BASE}MICValidation`,
  iso6166Isin: `${BASE}ISINValidation`,
});

const identifierCapabilityArtifacts = loadCapabilityArtifacts();
const identifierSchemeValidatorRegistry = normalizeSchemeValidatorRegistry(
  identifierCapabilityArtifacts.registry,
);

let passed = 0;
let failed = 0;
let pending = 0;

function pass(id, detail) {
  passed += 1;
  console.log(`PASS ${id}: ${detail}`);
}

function fail(id, detail) {
  failed += 1;
  console.error(`FAIL ${id}: ${detail}`);
}

function pend(id, detail) {
  pending += 1;
  console.log(`PENDING ${id}: ${detail}`);
}

function loadYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.JSON_SCHEMA });
}

function exactCardinality(value, min = 1, max = 1) {
  return value && value.minCount === min && value.maxCount === max;
}

function patterns(element) {
  return new Set((element && element.patternBindings || []).map((binding) => binding.pattern || binding));
}

function hasFactPatterns(element) {
  const bound = patterns(element);
  return bound.has(TEMPORAL) && bound.has(PROVENANCED);
}

let activeDomain;

function elementMap(domain) {
  const result = {};
  for (const container of [
    'objectTypes',
    'associationTypes',
    'relationTypes',
    'attributeTypes',
    'identifierTypes',
    'codeLists',
    'constraints',
  ]) {
    for (const [name, element] of Object.entries(domain[container] || {})) {
      result[name] = element;
    }
  }
  return result;
}

function hasReferenceMode(targetElement, referenceMode) {
  const expected = referenceMode === 'logical' ? LOGICAL_REFERENCE : EXACT_VERSION_REFERENCE;
  return (activeDomain.constraintBindings || []).some((binding) =>
    binding.targetElement === targetElement && binding.constraintRef === expected);
}

function exactUse(element, field, iri, referenceMode) {
  if (field === 'relationUses') {
    const use = (activeDomain.relationUses || []).find((candidate) =>
      candidate.relation === iri && candidate.subjectType === element.iri);
    return use
      && exactCardinality(use.outboundCardinality)
      && (referenceMode === undefined
        || hasReferenceMode(iri, referenceMode)
        || (use.constraints || []).some((binding) =>
          binding.constraintRef === (referenceMode === 'logical'
            ? LOGICAL_REFERENCE
            : EXACT_VERSION_REFERENCE)));
  }
  const use = (element && element[field] || []).find((candidate) => candidate.attribute === iri);
  return exactCardinality(use);
}

function exactRole(element, name, range, referenceMode, min = 1, max = 1) {
  const role = (element && element.participantRoles || []).find((candidate) =>
    (candidate.roleName || candidate.id) === name);
  return role && role.range === range && exactCardinality(role, min, max)
    && (
      role.referenceMode === referenceMode
      || hasReferenceMode(`${element.iri}/role/${role.id || role.roleName}`, referenceMode)
    );
}

function codeNotations(element) {
  return (element && element.values || []).map((value) =>
    typeof value === 'string' ? value : value.notation);
}

function moduleContractViolation(doc) {
  if (!doc.module || doc.module.status !== 'draft') return 'module-must-remain-draft';
  activeDomain = doc.domain || {};
  const d = elementMap(activeDomain);
  const required = [
    'IdentifiableSubject',
    'IdentifierAuthority',
    'IdentifierScheme',
    'IdentifierValue',
    'ISINValue',
    'LEIValue',
    'MICValue',
    'LocalIdentifierValue',
    'IdentifierSchemeAuthorization',
    'FinancialIdentifierAssignment',
    'IdentifierAssignmentConflict',
    'FinancialAccount',
    'FinancialAccountPartyRole',
    'AccountType',
  ];
  if (!required.every((name) => d[name] && d[name].iri === `${BASE}${name}`)) {
    return 'required-foundation-owned-symbol';
  }
  if (d.hasPrimaryIdentifier) return 'duplicate-primary-identifier-truth';

  const lists = {
    IdentifierSchemeKind: [
      'gleifLei',
      'iso6166Isin',
      'iso10383Mic',
      'internalInstrument',
      'financialAccount',
      'venueListing',
    ],
    IdentifierUniquenessScope: ['global', 'authorityScoped'],
    IdentifierAuthorityRole: ['assigningAuthority'],
    AccountType: ['cash', 'securitiesCustody', 'multiAsset'],
    FinancialAccountPartyRoleKind: [
      'accountHolder',
      'beneficialOwner',
      'authorizedOperator',
      'custodian',
    ],
  };
  for (const [name, expected] of Object.entries(lists)) {
    if (JSON.stringify(codeNotations(d[name])) !== JSON.stringify(expected)) return `${name}-closed-members`;
    if ((d[name].values || []).some((value) =>
      typeof value !== 'object' || value.iri !== `${d[name].iri}/value/${value.notation}`)) {
      return `${name}-member-iri`;
    }
  }

  const schemeAttrs = [
    'identifierSchemeKind',
    'identifierSchemeVersion',
    'identifierSchemeValidatorRef',
    'identifierUniquenessScope',
    'identifierSchemeSourceEvidenceRef',
  ];
  if (!schemeAttrs.every((name) => exactUse(d.IdentifierScheme, 'attributeUses', `${BASE}${name}`))
      || !exactUse(d.IdentifierScheme, 'relationUses', `${BASE}identifierSchemeMaintainer`, 'logical')
      || !hasFactPatterns(d.IdentifierScheme)) {
    return 'identifier-scheme-version-contract';
  }
  if (d.identifierSchemeMaintainer.domain !== `${BASE}IdentifierScheme`
      || d.identifierSchemeMaintainer.range !== `${BASE}IdentifierAuthority`
      || !(d.identifierSchemeMaintainer.characteristics || []).includes('functional')
      || d.identifierSchemeMaintainer.valueType !== undefined) {
    return 'identifier-scheme-maintainer-object-relation';
  }
  if (!exactUse(d.IdentifierValue, 'relationUses', `${BASE}identifierValueScheme`, 'logical')
      || !hasFactPatterns(d.IdentifierValue)) {
    return 'identifier-value-scheme-contract';
  }
  const valueAttrs = {
    ISINValue: 'isinLexicalValue',
    LEIValue: 'leiLexicalValue',
    MICValue: 'micLexicalValue',
    LocalIdentifierValue: 'localIdentifierLexicalValue',
  };
  for (const [name, attr] of Object.entries(valueAttrs)) {
    if (!(d[name].superTypes || []).includes(`${BASE}IdentifierValue`)
        || !exactUse(d[name], 'attributeUses', `${BASE}${attr}`)) {
      return `${name}-lexical-contract`;
    }
  }

  if (!(d.Party.superTypes || []).includes(`${BASE}IdentifiableSubject`)
      || !(d.IdentifierAuthority.superTypes || []).includes(`${BASE}Party`)) {
    return 'identifiable-subject-hierarchy';
  }
  if (!exactRole(d.IdentifierSchemeAuthorization, 'authorizedSchemeVersion', `${BASE}IdentifierScheme`, 'version')
      || !exactRole(d.IdentifierSchemeAuthorization, 'authorizedAuthorityVersion', `${BASE}IdentifierAuthority`, 'version')
      || !exactUse(d.IdentifierSchemeAuthorization, 'attributeUses', `${BASE}identifierAuthorityRole`)
      || !hasFactPatterns(d.IdentifierSchemeAuthorization)) {
    return 'identifier-authorization-contract';
  }
  const assignmentRoles = [
    ['identifiedSubjectVersion', 'IdentifiableSubject'],
    ['identifierValueVersion', 'IdentifierValue'],
    ['identifierSchemeVersion', 'IdentifierScheme'],
    ['assigningAuthorityVersion', 'IdentifierAuthority'],
  ];
  if (!assignmentRoles.every(([name, range]) =>
    exactRole(d.FinancialIdentifierAssignment, name, `${BASE}${range}`, 'version'))
      || !exactUse(d.FinancialIdentifierAssignment, 'attributeUses', `${BASE}assignmentId`)
      || !hasFactPatterns(d.FinancialIdentifierAssignment)) {
    return 'identifier-assignment-contract';
  }
  if (!exactRole(
    d.IdentifierAssignmentConflict,
    'conflictingAssignmentVersion',
    `${BASE}FinancialIdentifierAssignment`,
    'version',
    2,
    null,
  ) || !exactRole(d.IdentifierAssignmentConflict, 'conflictSchemeVersion', `${BASE}IdentifierScheme`, 'version')
      || !exactRole(d.IdentifierAssignmentConflict, 'conflictValueVersion', `${BASE}IdentifierValue`, 'version')
      || !exactUse(d.IdentifierAssignmentConflict, 'attributeUses', `${BASE}assignmentVersionSetDigest`)
      || !exactUse(
        d.IdentifierAssignmentConflict,
        'attributeUses',
        'https://axiolune.ai/ontology/meta/data-binding/attributes/generatingContextRef',
      )
      || !hasFactPatterns(d.IdentifierAssignmentConflict)) {
    return 'identifier-conflict-contract';
  }

  if (!(d.FinancialAccount.superTypes || []).includes(`${BASE}IdentifiableSubject`)
      || !exactUse(d.FinancialAccount, 'attributeUses', `${BASE}accountType`)
      || !exactUse(d.FinancialAccount, 'relationUses', `${BASE}accountIdentifierScheme`, 'logical')
      || !exactUse(d.FinancialAccount, 'relationUses', `${BASE}accountIdentifierValue`, 'logical')
      || !hasFactPatterns(d.FinancialAccount)) {
    return 'financial-account-contract';
  }
  if (d.accountIdentifierScheme.domain !== `${BASE}FinancialAccount`
      || d.accountIdentifierScheme.range !== `${BASE}IdentifierScheme`
      || d.accountIdentifierValue.domain !== `${BASE}FinancialAccount`
      || d.accountIdentifierValue.range !== `${BASE}LocalIdentifierValue`) {
    return 'financial-account-identity-relation-range';
  }
  if (!exactRole(d.FinancialAccountPartyRole, 'roleAccount', `${BASE}FinancialAccount`, 'logical')
      || !exactRole(d.FinancialAccountPartyRole, 'roleParty', `${BASE}Party`, 'logical')
      || !exactUse(d.FinancialAccountPartyRole, 'attributeUses', `${BASE}financialAccountPartyRoleKind`)
      || !hasFactPatterns(d.FinancialAccountPartyRole)) {
    return 'financial-account-party-role-contract';
  }
  return null;
}

function alignmentEvidenceViolation(doc, lockDocument) {
  const lock = (lockDocument.references || []).find((entry) => entry.id === 'fibo-local-evidence');
  if (!lock || !/^sha256:[0-9a-f]{64}$/.test(lock.artifactDigest || '')) return 'missing-fibo-reference-lock';
  const d = elementMap(doc.domain || {});
  for (const name of ['FinancialAccount']) {
    const alignment = ((d[name] || {}).alignments || []).find((value) =>
      value.vocabulary === 'FIBO' && value.sourceRelease);
    if (!alignment) return `${name}-missing-alignment`;
    const locator = alignment.sourceLocator === undefined
      ? { ok: false }
      : validateSourceLocator(alignment.sourceLocator);
    if (alignment.sourceRelease.artifactDigest !== lock.artifactDigest || !locator.ok) {
      return `${name}-stale-alignment-evidence`;
    }
  }
  return null;
}

function one(values) {
  return Array.isArray(values) && values.length === 1 ? values[0] : undefined;
}

function validIri(value) {
  return typeof value === 'string'
    && /^https?:\/\/[^\s\u0000-\u001f\u007f]+$/u.test(value)
    && value === value.normalize('NFC');
}

function exactVersionIri(value) {
  return validIri(value) && value.includes('/version/sha256-');
}

function temporalInterval(value, fromField = 'validFrom', toField = 'validTo') {
  try {
    const start = parseUtcInstantNanoseconds(value?.[fromField]);
    const end = value?.[toField] == null
      ? null
      : parseUtcInstantNanoseconds(value[toField]);
    if (end !== null && end <= start) return null;
    return { end, start };
  } catch {
    return null;
  }
}

function factEnvelope(value) {
  // RFC-001 section 5.8 makes FactVersion nodes byte-immutable.  Knowledge
  // and availability ends are asserted only by separate FactClosureAssertion
  // evidence; accepting inline ends here would turn a mutable overwrite into
  // apparently valid PIT state.
  if (Object.hasOwn(value || {}, 'knowledgeTo')
      || Object.hasOwn(value || {}, 'availableTo')) return null;
  const valid = temporalInterval(value, 'validFrom', 'validTo');
  const knowledge = temporalInterval(value, 'knowledgeFrom', null);
  const availability = temporalInterval(value, 'availableFrom', null);
  if (valid === null || knowledge === null || availability === null
      || !validIri(value?.source)
      || !Number.isSafeInteger(value?.revision)
      || value.revision < 0) return null;
  return { availability, knowledge, valid };
}

function covers(authorization, assignment) {
  const authorizationInterval = temporalInterval(authorization);
  const assignmentInterval = temporalInterval(assignment);
  if (authorizationInterval === null || assignmentInterval === null
      || authorizationInterval.start > assignmentInterval.start) return false;
  const authorizationKnowledge = parseUtcInstantNanoseconds(authorization.knowledgeFrom);
  const authorizationAvailability = parseUtcInstantNanoseconds(authorization.availableFrom);
  const assignmentKnowledge = parseUtcInstantNanoseconds(assignment.knowledgeFrom);
  const assignmentAvailability = parseUtcInstantNanoseconds(assignment.availableFrom);
  if (authorizationKnowledge > assignmentKnowledge
      || authorizationAvailability > assignmentAvailability) return false;
  if (authorizationInterval.end === null) return true;
  return assignmentInterval.end !== null
    && authorizationInterval.end >= assignmentInterval.end;
}

function pitEligibleAt(reference, pivot) {
  const referenceEnvelope = factEnvelope(reference);
  const pivotEnvelope = factEnvelope(pivot);
  if (referenceEnvelope === null || pivotEnvelope === null) return false;
  return referenceEnvelope.valid.start <= pivotEnvelope.valid.start
    && (referenceEnvelope.valid.end === null
      || pivotEnvelope.valid.start < referenceEnvelope.valid.end)
    && referenceEnvelope.knowledge.start <= pivotEnvelope.knowledge.start
    && referenceEnvelope.availability.start <= pivotEnvelope.availability.start;
}

function digestVersions(iris) {
  const sorted = [...new Set(iris.map((iri) => String(iri).normalize('NFC')))]
    .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  const u64be = (value) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(BigInt(value));
    return bytes;
  };
  const chunks = [Buffer.from('axiolune-iri-set-v1\0', 'utf8'), u64be(sorted.length)];
  for (const iri of sorted) {
    const bytes = Buffer.from(iri, 'utf8');
    chunks.push(u64be(bytes.length), bytes);
  }
  return `sha256:${crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex')}`;
}

function bijectionViolation(records, keyOf) {
  const logicalToKey = new Map();
  const keyToLogical = new Map();
  for (const record of records) {
    const key = JSON.stringify(keyOf(record));
    if (logicalToKey.has(record.logicalIri) && logicalToKey.get(record.logicalIri) !== key) return true;
    if (keyToLogical.has(key) && keyToLogical.get(key) !== record.logicalIri) return true;
    logicalToKey.set(record.logicalIri, key);
    keyToLogical.set(key, record.logicalIri);
  }
  return false;
}

function immutableVersionConflict(records) {
  const contentByVersion = new Map();
  for (const record of records) {
    if (typeof record?.versionIri !== 'string') continue;
    const content = canonicalJcs(record);
    if (contentByVersion.has(record.versionIri)
        && contentByVersion.get(record.versionIri) !== content) return true;
    contentByVersion.set(record.versionIri, content);
  }
  return false;
}

function findForbidden(value) {
  const forbidden = new Set([
    'hasPrimaryIdentifier',
    'hasAccountHolder',
    'hasBeneficialOwner',
    'authorizedOperator',
    'custodian',
  ]);
  if (!value || typeof value !== 'object') return false;
  if (Object.keys(value).some((key) => forbidden.has(key))) return true;
  return Object.values(value).some(findForbidden);
}

function instanceViolation(instance) {
  if (findForbidden(instance)) return 'forbidden-derived-truth';
  const schemes = instance.schemeVersions || [];
  const values = instance.identifierValues || [];
  const authorities = instance.authorityVersions || [];
  const authorizations = instance.authorizations || [];
  const accounts = instance.accounts || [];
  const assignments = instance.assignments || [];
  const partyRoles = instance.partyRoles || [];
  const conflicts = instance.conflicts || [];
  if (immutableVersionConflict(assignments)) {
    return 'assignment-version-immutable-conflict';
  }
  if (conflicts.some((conflict) => [
    'winner',
    'winnerVersionIri',
    'winningAssignmentVersionIri',
    'selectedAssignmentVersionIri',
  ].some((field) => Object.hasOwn(conflict, field)))) {
    return 'assignment-conflict-silent-winner';
  }
  const schemeByLogical = new Map(schemes.map((value) => [value.logicalIri, value]));
  const schemeByVersion = new Map(schemes.map((value) => [value.versionIri, value]));
  const valueByLogical = new Map(values.map((value) => [value.logicalIri, value]));
  const valueByVersion = new Map(values.map((value) => [value.versionIri, value]));
  const authorityByVersion = new Map(authorities.map((value) => [value.versionIri, value]));
  const compatibility = {
    gleifLei: ['LEIValue', 'LegalEntity'],
    iso6166Isin: ['ISINValue', 'Security'],
    iso10383Mic: ['MICValue', 'MICRegistryEntry'],
    internalInstrument: ['LocalIdentifierValue', 'FinancialInstrument'],
    financialAccount: ['LocalIdentifierValue', 'FinancialAccount'],
    venueListing: ['LocalIdentifierValue', 'InstrumentListing'],
  };

  for (const scheme of schemes) {
    if (!validIri(scheme.logicalIri)
        || !exactVersionIri(scheme.versionIri)
        || !Object.hasOwn(compatibility, scheme.kind)
        || !['global', 'authorityScoped'].includes(scheme.uniquenessScope)
        || !validIri(scheme.validatorRef)
        || factEnvelope(scheme) === null) {
      return 'identifier-scheme-version-closure';
    }
  }
  for (const authority of authorities) {
    if (!validIri(authority.logicalIri)
        || !exactVersionIri(authority.versionIri)
        || factEnvelope(authority) === null) {
      return 'identifier-authority-version-closure';
    }
  }
  for (const authorization of authorizations) {
    if (factEnvelope(authorization) === null) {
      return 'authorization-temporal-interval';
    }
  }

  for (const value of values) {
    const scheme = schemeByLogical.get(value.schemeLogicalIri);
    if (!validIri(value.logicalIri) || !exactVersionIri(value.versionIri)
        || !scheme
        || !Object.hasOwn(IDENTIFIER_CONSTRAINT_BY_VALUE_TYPE, value.type)
        || typeof value.lexicalValue !== 'string' || value.lexicalValue.length === 0
        || value.lexicalValue !== value.lexicalValue.normalize('NFC')
        || factEnvelope(value) === null) {
      return 'identifier-value-scheme-closure';
    }
    const constraintDefinitionIri = compatibility[scheme.kind]?.[0] === value.type
      ? IDENTIFIER_CONSTRAINT_BY_VALUE_TYPE[value.type]
      : null;
    if (constraintDefinitionIri) {
      const expectedStandardValidator = STANDARD_SCHEME_VALIDATOR_BY_KIND[scheme.kind];
      if (expectedStandardValidator && scheme.validatorRef !== expectedStandardValidator) {
        return 'identifier-scheme-validator-binding';
      }
      const execution = executeIdentifierConstraint(
        {
          constraintDefinitionIri,
          focusNode: value.versionIri,
          lexicalValue: value.lexicalValue,
          schemaVersion: '1.0',
          schemeValidatorRef: value.type === 'LocalIdentifierValue' ? scheme.validatorRef || null : null,
        },
        identifierSchemeValidatorRegistry,
      );
      if (execution.outcome === 'engineFailure') return 'identifier-custom-engine-failure';
      if (execution.outcome === 'violation') return `identifier-custom-${execution.violations[0].code}`;
    }
  }
  if (bijectionViolation(values, (value) => [
    value.schemeLogicalIri,
    value.lexicalValue,
  ])) {
    return 'identifier-value-identity-key-bijection';
  }

  for (const account of accounts) {
    const type = one(account.accountType);
    const schemeLogicalIri = one(account.accountIdentifierScheme);
    const valueLogicalIri = one(account.accountIdentifierValue);
    if (!validIri(account.logicalIri)
        || !exactVersionIri(account.versionIri)
        || factEnvelope(account) === null) return 'account-version-closure';
    if (type === undefined) return 'accountType-cardinality';
    if (!['cash', 'securitiesCustody', 'multiAsset'].includes(type)) return 'accountType-member';
    if (!schemeLogicalIri || !valueLogicalIri) return 'account-identity-cardinality';
    const scheme = schemeByLogical.get(schemeLogicalIri);
    const value = valueByLogical.get(valueLogicalIri);
    if (!scheme || scheme.kind !== 'financialAccount') return 'account-scheme-kind';
    if (!value || value.type !== 'LocalIdentifierValue') return 'account-value-subtype';
    if (value.schemeLogicalIri !== schemeLogicalIri) return 'account-value-scheme-equality';
  }
  if (bijectionViolation(accounts, (account) => [
    one(account.accountIdentifierScheme),
    one(account.accountIdentifierValue),
  ])) {
    return 'account-identity-key-bijection';
  }

  for (const assignment of assignments) {
    const scheme = schemeByVersion.get(assignment.schemeVersionIri);
    const value = valueByVersion.get(assignment.identifierValueVersionIri);
    const authority = authorityByVersion.get(assignment.assigningAuthorityVersionIri);
    if (!validIri(assignment.logicalIri)
        || !exactVersionIri(assignment.versionIri)
        || typeof assignment.assignmentId !== 'string'
        || assignment.assignmentId.length === 0
        || assignment.assignmentId !== assignment.assignmentId.trim()
        || assignment.assignmentId !== assignment.assignmentId.normalize('NFC')
        || /[\u0000-\u001f\u007f]/u.test(assignment.assignmentId)
        || !Number.isSafeInteger(assignment.revision)
        || assignment.revision < 0
        || factEnvelope(assignment) === null) {
      return 'assignment-version-closure';
    }
    if (!scheme || !value || !authority
        || !exactVersionIri(assignment.identifiedSubjectVersionIri)
        || value.logicalIri !== assignment.identifierValueLogicalIri
        || scheme.logicalIri !== assignment.schemeLogicalIri
        || authority.logicalIri !== assignment.assigningAuthorityLogicalIri
        || value.schemeLogicalIri !== scheme.logicalIri) {
      return 'assignment-exact-version-closure';
    }
    if (!pitEligibleAt(scheme, assignment)
        || !pitEligibleAt(value, assignment)
        || !pitEligibleAt(authority, assignment)) {
      return 'assignment-exact-version-pit-eligibility';
    }
    const expected = compatibility[scheme.kind];
    if (!expected || value.type !== expected[0] || assignment.subjectType !== expected[1]) {
      return 'assignment-compatibility-matrix';
    }
    const authorization = authorizations.find((candidate) =>
      candidate.schemeVersionIri === assignment.schemeVersionIri
      && candidate.authorityVersionIri === assignment.assigningAuthorityVersionIri
      && candidate.role === 'assigningAuthority'
      && covers(candidate, assignment));
    if (!authorization) return 'assignment-authorization';
  }
  if (bijectionViolation(assignments, (assignment) => [
    assignment.assigningAuthorityLogicalIri,
    assignment.assignmentId,
  ])) {
    return 'assignment-logical-key-bijection';
  }
  for (const account of accounts) {
    const matching = assignments.find((assignment) =>
      assignment.subjectType === 'FinancialAccount'
      && assignment.identifiedSubjectLogicalIri === account.logicalIri
      && assignment.identifiedSubjectVersionIri === account.versionIri
      && assignment.schemeLogicalIri === one(account.accountIdentifierScheme)
      && assignment.identifierValueLogicalIri === one(account.accountIdentifierValue));
    if (!matching) return 'account-identity-assignment-closure';
  }

  for (const role of partyRoles) {
    const account = one(role.accountLogicalIri);
    const party = one(role.partyLogicalIri);
    const kind = one(role.role);
    if (!validIri(role.logicalIri) || factEnvelope(role) === null) {
      return 'account-party-role-version-closure';
    }
    if (!account || !party || !kind) return 'account-party-role-cardinality';
    if (!['accountHolder', 'beneficialOwner', 'authorizedOperator', 'custodian'].includes(kind)) {
      return 'account-party-role-member';
    }
  }
  if (bijectionViolation(partyRoles, (role) => [
    one(role.accountLogicalIri),
    one(role.partyLogicalIri),
    one(role.role),
  ])) {
    return 'account-party-role-identity';
  }

  const compareUtf8 = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  const expectedConflictSets = new Map();
  const globalGroups = new Map();
  for (const assignment of assignments) {
    const scheme = schemeByVersion.get(assignment.schemeVersionIri);
    if (scheme?.uniquenessScope !== 'global') continue;
    const key = JSON.stringify([
      assignment.schemeLogicalIri,
      assignment.schemeVersionIri,
      assignment.identifierValueLogicalIri,
      assignment.identifierValueVersionIri,
    ]);
    const group = globalGroups.get(key) || [];
    group.push(assignment);
    globalGroups.set(key, group);
  }
  for (const group of globalGroups.values()) {
    const boundaries = new Set();
    for (const assignment of group) {
      const interval = temporalInterval(assignment);
      if (interval === null) continue;
      boundaries.add(interval.start);
      if (interval.end !== null) boundaries.add(interval.end);
    }
    for (const boundary of [...boundaries].sort((left, right) => (
      left < right ? -1 : left > right ? 1 : 0
    ))) {
      const active = group.filter((assignment) => {
        const interval = temporalInterval(assignment);
        return interval !== null
          && interval.start <= boundary
          && (interval.end === null || boundary < interval.end);
      });
      if (new Set(active.map((assignment) => assignment.identifiedSubjectLogicalIri)).size < 2) {
        continue;
      }
      const exactSet = [...new Set(active.map((assignment) => assignment.versionIri))]
        .sort(compareUtf8);
      const setKey = JSON.stringify(exactSet);
      expectedConflictSets.set(setKey, {
        exactSet,
        identifierValueVersionIri: active[0].identifierValueVersionIri,
        schemeVersionIri: active[0].schemeVersionIri,
      });
    }
  }

  const matchedConflicts = new Set();
  if (conflicts.some((conflict) => !validIri(conflict.logicalIri)
      || factEnvelope(conflict) === null)) {
    return 'assignment-conflict-closure';
  }
  for (const expected of expectedConflictSets.values()) {
    const matchingConflicts = conflicts.filter((candidate) =>
      JSON.stringify([...(candidate.assignmentVersionIris || [])].sort(compareUtf8))
        === JSON.stringify(expected.exactSet));
    if (matchingConflicts.length === 0) return 'missing-assignment-conflict';
    if (matchingConflicts.length !== 1) return 'assignment-conflict-cardinality';
    const [conflict] = matchingConflicts;
    matchedConflicts.add(conflict);
    const expectedDigest = digestVersions(expected.exactSet);
    if (conflict.assignmentVersionSetDigest !== expectedDigest
        || conflict.logicalIri !== `https://axiolune.ai/data/identifier-assignment-conflicts/${expectedDigest.replace(':', '-')}`
        || conflict.schemeVersionIri !== expected.schemeVersionIri
        || conflict.identifierValueVersionIri !== expected.identifierValueVersionIri
        || !validIri(conflict.generatingContextRef)) {
      return 'assignment-conflict-closure';
    }
  }
  if (conflicts.some((conflict) => !matchedConflicts.has(conflict))) {
    return 'assignment-conflict-false-predicate';
  }
  return null;
}

function mutate(instance, mutation) {
  const result = JSON.parse(JSON.stringify(instance));
  const parts = mutation.path.split('/').slice(1).map((part) =>
    part.replace(/~1/g, '/').replace(/~0/g, '~'));
  const leaf = parts.pop();
  let parent = result;
  for (const part of parts) parent = parent[Array.isArray(parent) ? Number(part) : part];
  if (mutation.op === 'remove') {
    if (Array.isArray(parent)) parent.splice(Number(leaf), 1);
    else delete parent[leaf];
  } else if (mutation.op === 'add' || mutation.op === 'replace') {
    if (Array.isArray(parent) && leaf === '-') parent.push(mutation.value);
    else parent[Array.isArray(parent) ? Number(leaf) : leaf] = mutation.value;
  } else {
    throw new Error(`unsupported mutation operation ${mutation.op}`);
  }
  return result;
}

function runFixtures() {
  const positive = loadYaml(POSITIVE_FILE);
  const byId = new Map((positive.fixtures || []).map((fixture) => [fixture.id, fixture]));
  for (const fixture of positive.fixtures || []) {
    const violation = instanceViolation(fixture.instance);
    if (fixture.expectedResult === 'accepted' && violation === null) {
      pass(`FIXTURE+/${fixture.id}`, 'accepted');
    } else {
      fail(`FIXTURE+/${fixture.id}`, `unexpected violation ${violation || 'none'}`);
    }
  }

  const idempotent = structuredClone(
    byId.get('account-type-change-preserves-logical-identity').instance,
  );
  idempotent.assignments.push(structuredClone(idempotent.assignments[0]));
  if (instanceViolation(idempotent) === null) {
    pass('REGRESSION/assignment-byte-identical-replay', 'byte-identical assignment version is idempotent');
  } else {
    fail('REGRESSION/assignment-byte-identical-replay', 'byte-identical assignment version was not idempotent');
  }
  const conflictingReplay = structuredClone(idempotent);
  const overwrittenAssignment = conflictingReplay.assignments.at(-1);
  overwrittenAssignment.identifiedSubjectLogicalIri = 'https://axiolune.ai/data/accounts/conflicting';
  overwrittenAssignment.identifiedSubjectVersionIri = 'https://axiolune.ai/data/accounts/conflicting/version/sha256-v1';
  if (instanceViolation(conflictingReplay) === 'assignment-version-immutable-conflict') {
    pass('REGRESSION/assignment-immutable-replay-conflict', 'same version IRI with different content fails closed');
  } else {
    fail('REGRESSION/assignment-immutable-replay-conflict', 'same version IRI overwrite escaped');
  }
  const delimiterTuples = [
    { logicalIri: 'urn:logical:one', parts: ['a\u001fb', 'c'] },
    { logicalIri: 'urn:logical:two', parts: ['a', 'b\u001fc'] },
  ];
  if (!bijectionViolation(delimiterTuples, (record) => record.parts)) {
    pass('REGRESSION/identity-tuple-framing', 'component delimiter bytes cannot alias distinct identity tuples');
  } else {
    fail('REGRESSION/identity-tuple-framing', 'distinct framed identity tuples collided');
  }
  const lateArrivingFact = {
    validFrom: '2025-01-01T00:00:00Z',
    validTo: '2025-02-01T00:00:00Z',
    knowledgeFrom: '2025-03-01T00:00:00Z',
    availableFrom: '2025-03-02T00:00:00Z',
    source: 'https://axiolune.ai/sources/late-arriving-regression-v1',
    revision: 0,
  };
  if (factEnvelope(lateArrivingFact) !== null) {
    pass(
      'REGRESSION/late-arriving-fact-axes',
      'validTo is not misread as an inline knowledge/availability closure',
    );
  } else {
    fail(
      'REGRESSION/late-arriving-fact-axes',
      'a valid fact learned after its business interval was rejected',
    );
  }

  const negative = loadYaml(NEGATIVE_FILE);
  for (const fixture of negative.cases || []) {
    const base = byId.get(fixture.baseFixtureId);
    if (!base) {
      fail(`FIXTURE-/${fixture.id}`, `unknown base fixture ${fixture.baseFixtureId}`);
      continue;
    }
    const violation = instanceViolation(mutate(base.instance, fixture.mutation));
    if (violation === fixture.expectedViolation) {
      pass(`FIXTURE-/${fixture.id}`, `rejected with ${violation}`);
    } else {
      fail(`FIXTURE-/${fixture.id}`, `expected ${fixture.expectedViolation}, got ${violation || 'accepted'}`);
    }
  }
}

function main() {
  try {
    const moduleDocument = loadYaml(MODULE_FILE);
    const discoveredIdentifierConstraints = discoverIdentifierConstraints(
      moduleDocument,
      identifierCapabilityArtifacts.discovery,
    );
    const moduleViolation = moduleContractViolation(moduleDocument);
    if (moduleViolation) fail('MODULE', moduleViolation);
    else pass('MODULE', 'RFC-001 5.5/5.11 Foundation-owned account and identifier skeleton is present');
    runFixtures();
    const alignmentViolation = alignmentEvidenceViolation(
      moduleDocument,
      loadYaml(REFERENCE_LOCK_FILE),
    );
    if (alignmentViolation) {
      pend('ALIGNMENT-EVIDENCE', alignmentViolation);
    } else {
      pass('ALIGNMENT-EVIDENCE', 'targeted FIBO alignments join the strict lock and SourceLocator');
    }
    pass(
      'IDENTIFIER-CUSTOM-RUNTIME',
      `${discoveredIdentifierConstraints.length} Identifier Custom constraints bind the digest-locked executor; account/identifier fixtures execute their lexical and checksum rules`,
    );
  } catch (error) {
    fail('UNCAUGHT', error.stack || error.message);
  }

  console.log(`\nfoundation account/identity targeted checks: ${passed} passed, ${failed} failed, ${pending} pending`);
  process.exit(failed > 0 ? 1 : pending > 0 ? 2 : 0);
}

if (require.main === module) main();

module.exports = {
  instanceViolation,
  main,
  mutate,
};
