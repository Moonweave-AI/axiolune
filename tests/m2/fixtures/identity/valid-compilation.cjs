'use strict';

const {
  TAGS,
  taggedJcsDigest,
} = require('../../../../scripts/domain/lib/identity-contract-compiler.cjs');

const PROFILE = 'https://axiolune.ai/profile/fixture-identity-v1';
const NS = 'https://axiolune.ai/test/identity/';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_DATE_TIME_STAMP = 'http://www.w3.org/2001/XMLSchema#dateTimeStamp';
const DUMMY_DIGEST = `sha256:${'a'.repeat(64)}`;

function artifact(path) {
  return { kind: 'path', root: 'sourceTree', path };
}

function direct(field) {
  return {
    bindingType: 'directField',
    source: { dataset: 'fixture', field },
  };
}

function ref(targetMappingRef, referenceMode, keyBindings) {
  return {
    bindingType: 'referenceIdentity',
    targetMappingRef,
    referenceMode,
    keyBindings,
  };
}

function semantic(containingType, attributeName) {
  return {
    valueKind: 'attributeUse',
    containingType,
    attributeRef: `${containingType}/attributes/${attributeName}`,
  };
}

function makeRule(termRow, suffix) {
  const definition = {
    iri: `${NS}normalization/${suffix}`,
    label: `${suffix} identity normalization`,
    definition: `Fixture identity normalization for ${suffix}.`,
    inputTermContractRef: termRow.termContractRef,
    inputTermContractDigest: termRow.termContractDigest,
    outputTermContractRef: termRow.termContractRef,
    outputTermContractDigest: termRow.termContractDigest,
    algorithmId: `fixture_${suffix}`,
    algorithmVersion: '1.0.0',
    specificationRef: artifact(`tests/m2/fixtures/identity/specs/${suffix}.txt`),
    specificationDigest: DUMMY_DIGEST,
    implementationRef: artifact(`tests/m2/fixtures/identity/implementations/${suffix}.cjs`),
    implementationDigest: DUMMY_DIGEST,
    testVectorsRef: artifact(`tests/m2/fixtures/identity/vectors/${suffix}.json`),
    testVectorsDigest: DUMMY_DIGEST,
  };
  return {
    definition,
    digest: taggedJcsDigest(TAGS.normalizationRule, definition),
  };
}

function buildFixture() {
  const partyType = `${NS}types/Party`;
  const accountType = `${NS}types/Account`;
  const holdingType = `${NS}types/Holding`;
  const partyMappingRef = `${NS}mappings/party`;
  const accountMappingRef = `${NS}mappings/account`;
  const holdingMappingRef = `${NS}mappings/holding`;

  const controlledSetDefinition = {
    iri: `${NS}controlled-sets/account-kind`,
    label: 'Fixture account-kind set',
    definition: 'Complete reviewed account-kind set for identity compiler fixtures.',
    setKind: 'reviewedIriInventory',
    sourceDefinitionRef: `${NS}inventories/account-kind`,
    sourceEvidenceRef: `${NS}evidence/account-kind`,
    sourceEvidenceDigest: DUMMY_DIGEST,
    sourceLocator: {
      kind: 'wholeFile',
      path: 'tests/m2/fixtures/identity/account-kind-source.json',
      mediaType: 'application/json',
      extractorProfileRef: { kind: 'iri', iri: `${NS}extractors/whole-json-v1` },
      extractorProfileDigest: DUMMY_DIGEST,
      selectionDigest: DUMMY_DIGEST,
    },
    members: [`${NS}codes/account-kind/cash`, `${NS}codes/account-kind/margin`],
  };
  const controlledSetDigest = taggedJcsDigest(TAGS.controlledSet, controlledSetDefinition);

  const termDefinitions = [
    {
      iri: `${NS}term-contracts/account-version`,
      label: 'Account version reference',
      definition: 'Exact account FactVersion IRI.',
      termContract: {
        termKind: 'iri',
        referenceMode: 'version',
        expectedTargetType: accountType,
      },
    },
    {
      iri: `${NS}term-contracts/controlled-account-kind`,
      label: 'Controlled account kind',
      definition: 'IRI drawn from the fixture account-kind set.',
      termContract: {
        termKind: 'iri',
        referenceMode: 'controlledIri',
        controlledSetRef: controlledSetDefinition.iri,
        controlledSetDigest,
      },
    },
    {
      iri: `${NS}term-contracts/date-time-stamp`,
      label: 'UTC timestamp',
      definition: 'Canonical xsd:dateTimeStamp identity term.',
      termContract: {
        termKind: 'literal',
        datatypeIri: XSD_DATE_TIME_STAMP,
      },
    },
    {
      iri: `${NS}term-contracts/party-logical`,
      label: 'Party logical reference',
      definition: 'Stable party FactIdentity IRI.',
      termContract: {
        termKind: 'iri',
        referenceMode: 'logical',
        expectedTargetType: partyType,
      },
    },
    {
      iri: `${NS}term-contracts/string`,
      label: 'Identity string',
      definition: 'Canonical xsd:string identity term.',
      termContract: {
        termKind: 'literal',
        datatypeIri: XSD_STRING,
      },
    },
  ];
  const termRows = termDefinitions
    .map((definition) => ({
      termContractRef: definition.iri,
      termContractDigest: taggedJcsDigest(TAGS.termContract, definition),
      definition,
    }))
    .sort((left, right) => Buffer.compare(
      Buffer.from(left.termContractRef, 'utf8'),
      Buffer.from(right.termContractRef, 'utf8'),
    ));
  const termBySuffix = new Map(termRows.map((row) => [row.termContractRef.split('/').pop(), row]));
  const identityTermRegistry = {
    schemaVersion: '1.0',
    profileRef: PROFILE,
    termContracts: termRows,
    controlledSets: [{
      controlledSetRef: controlledSetDefinition.iri,
      controlledSetDigest,
      definition: controlledSetDefinition,
    }],
  };
  const identityTermRegistryDigest = taggedJcsDigest(TAGS.termRegistry, identityTermRegistry);

  const rules = [
    makeRule(termBySuffix.get('account-version'), 'account_version'),
    makeRule(termBySuffix.get('controlled-account-kind'), 'account_kind'),
    makeRule(termBySuffix.get('date-time-stamp'), 'date_time_stamp'),
    makeRule(termBySuffix.get('party-logical'), 'party_logical'),
    makeRule(termBySuffix.get('string'), 'string'),
  ];
  const ruleBySuffix = new Map(rules.map((row) => [row.definition.iri.split('/').pop(), row]));

  function component(name, containingType, termSuffix, ruleSuffix) {
    const term = termBySuffix.get(termSuffix);
    const rule = ruleBySuffix.get(ruleSuffix);
    return {
      name,
      semanticValue: semantic(containingType, name),
      termContractRef: term.termContractRef,
      termContractDigest: term.termContractDigest,
      normalizationRuleRef: rule.definition.iri,
      normalizationRuleDigest: rule.digest,
    };
  }

  const partyContract = {
    iri: `${NS}contracts/party`,
    label: 'Fixture Party identity',
    definition: 'Stable fixture party logical and version identity.',
    targetType: partyType,
    identityBaseIri: `${NS}data/party`,
    logicalComponents: [
      component('partyId', partyType, 'string', 'string'),
    ],
    versionComponents: [
      component('asOf', partyType, 'date-time-stamp', 'date_time_stamp'),
    ],
  };
  const accountContract = {
    iri: `${NS}contracts/account`,
    label: 'Fixture Account identity',
    definition: 'Stable fixture account logical and version identity.',
    targetType: accountType,
    identityBaseIri: `${NS}data/account`,
    logicalComponents: [
      component('accountId', accountType, 'string', 'string'),
      component('accountKind', accountType, 'controlled-account-kind', 'account_kind'),
      component('owner', accountType, 'party-logical', 'party_logical'),
    ],
    versionComponents: [
      component('asOf', accountType, 'date-time-stamp', 'date_time_stamp'),
    ],
  };
  const holdingContract = {
    iri: `${NS}contracts/holding`,
    label: 'Fixture Holding identity',
    definition: 'Stable fixture holding identity with an exact account-version dependency.',
    targetType: holdingType,
    identityBaseIri: `${NS}data/holding`,
    logicalComponents: [
      component('accountVersion', holdingType, 'account-version', 'account_version'),
      component('holdingId', holdingType, 'string', 'string'),
    ],
    versionComponents: [
      component('asOf', holdingType, 'date-time-stamp', 'date_time_stamp'),
    ],
  };

  const partyMapping = {
    iri: partyMappingRef,
    label: 'Fixture party mapping',
    source: { fixtureDataset: 'party' },
    targetType: partyType,
    mappingType: 'directTable',
    identity: {
      contractRef: partyContract.iri,
      logicalKeyBindings: { partyId: direct('party_id') },
      versionKeyBindings: { asOf: direct('party_as_of') },
    },
  };
  const accountOwner = ref(partyMappingRef, 'logical', {
    partyId: direct('owner_party_id'),
  });
  const accountMapping = {
    iri: accountMappingRef,
    label: 'Fixture account mapping',
    source: { fixtureDataset: 'account' },
    targetType: accountType,
    mappingType: 'directTable',
    identity: {
      contractRef: accountContract.iri,
      logicalKeyBindings: {
        owner: accountOwner,
        accountKind: direct('account_kind'),
        accountId: direct('account_id'),
      },
      versionKeyBindings: { asOf: direct('account_as_of') },
    },
    slotMappings: [{
      target: {
        slotType: 'relation',
        targetObjectType: partyType,
        targetRelation: `${NS}relations/account-auditor`,
      },
      value: ref(partyMappingRef, 'version', {
        asOf: direct('auditor_party_as_of'),
        partyId: direct('auditor_party_id'),
      }),
    }, {
      target: {
        slotType: 'patternField',
        targetField: 'generatingContextRef',
        targetPattern: `${NS}patterns/ProvenancedFact`,
      },
      value: { bindingType: 'runtimeContext', contextField: 'iri' },
    }],
  };
  const holdingMapping = {
    iri: holdingMappingRef,
    label: 'Fixture holding mapping',
    source: { fixtureDataset: 'holding' },
    targetType: holdingType,
    mappingType: 'directTable',
    identity: {
      contractRef: holdingContract.iri,
      logicalKeyBindings: {
        holdingId: direct('holding_id'),
        accountVersion: ref(accountMappingRef, 'version', {
          asOf: direct('account_as_of'),
          owner: ref(partyMappingRef, 'logical', {
            partyId: direct('owner_party_id'),
          }),
          accountKind: direct('account_kind'),
          accountId: direct('account_id'),
        }),
      },
      versionKeyBindings: { asOf: direct('holding_as_of') },
    },
  };

  return {
    profileRef: PROFILE,
    identityTermRegistryRef: artifact('tests/m2/fixtures/identity/identity-term-registry.json'),
    identityTermRegistryDigest,
    identityTermRegistry,
    normalizationRules: rules.map((row) => row.definition),
    derivations: [],
    contracts: [holdingContract, partyContract, accountContract],
    mappings: [holdingMapping, partyMapping, accountMapping],
    concreteTargetTypes: [holdingType, partyType, accountType],
  };
}

module.exports = {
  NS,
  buildFixture,
};
