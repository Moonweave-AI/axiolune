'use strict';

function findMapping(input, suffix) {
  return input.mappings.find((mapping) => mapping.iri.endsWith(`/mappings/${suffix}`));
}

function findContract(input, suffix) {
  return input.contracts.find((contract) => contract.iri.endsWith(`/contracts/${suffix}`));
}

module.exports = [
  {
    vectorId: 'contract-unknown-field',
    expectedCode: 'UNKNOWN_FIELD',
    mutate(input) {
      findContract(input, 'party').iriTemplate = '{partyId}';
    },
  },
  {
    vectorId: 'identity-spec-unknown-field',
    expectedCode: 'UNKNOWN_FIELD',
    mutate(input) {
      findMapping(input, 'party').identity.template = '{partyId}';
    },
  },
  {
    vectorId: 'reference-binding-unknown-field',
    expectedCode: 'UNKNOWN_FIELD',
    mutate(input) {
      findMapping(input, 'account').identity.logicalKeyBindings.owner.unused = true;
    },
  },
  {
    vectorId: 'duplicate-component-across-logical-version',
    expectedCode: 'DUPLICATE_COMPONENT_NAME',
    mutate(input) {
      findContract(input, 'party').versionComponents[0].name = 'partyId';
      const party = findMapping(input, 'party');
      party.identity.versionKeyBindings = { partyId: party.identity.versionKeyBindings.asOf };
    },
  },
  {
    vectorId: 'duplicate-contract-for-target',
    expectedCode: 'DUPLICATE_TARGET_CONTRACT',
    mutate(input) {
      const duplicate = structuredClone(findContract(input, 'party'));
      duplicate.iri += '-duplicate';
      duplicate.identityBaseIri += '-duplicate';
      input.contracts.push(duplicate);
    },
  },
  {
    vectorId: 'duplicate-identity-base',
    expectedCode: 'DUPLICATE_IDENTITY_BASE',
    mutate(input) {
      findContract(input, 'account').identityBaseIri = findContract(input, 'party').identityBaseIri;
    },
  },
  {
    vectorId: 'term-contract-digest-mismatch',
    expectedCode: 'TERM_CONTRACT_DIGEST_MISMATCH',
    mutate(input) {
      input.identityTermRegistry.termContracts[0].termContractDigest = `sha256:${'0'.repeat(64)}`;
    },
  },
  {
    vectorId: 'registry-digest-mismatch',
    expectedCode: 'TERM_REGISTRY_DIGEST_MISMATCH',
    mutate(input) {
      input.identityTermRegistryDigest = `sha256:${'0'.repeat(64)}`;
    },
  },
  {
    vectorId: 'logical-key-missing',
    expectedCode: 'LOGICAL_KEY_COVERAGE_MISMATCH',
    mutate(input) {
      delete findMapping(input, 'account').identity.logicalKeyBindings.accountKind;
    },
  },
  {
    vectorId: 'version-key-extra',
    expectedCode: 'VERSION_KEY_COVERAGE_MISMATCH',
    mutate(input) {
      findMapping(input, 'party').identity.versionKeyBindings.revision = {
        bindingType: 'literal',
        value: 0,
      };
    },
  },
  {
    vectorId: 'reference-mode-mismatch',
    expectedCode: 'REFERENCE_MODE_MISMATCH',
    mutate(input) {
      findMapping(input, 'account').identity.logicalKeyBindings.owner.referenceMode = 'version';
    },
  },
  {
    vectorId: 'logical-reference-key-map-mismatch',
    expectedCode: 'REFERENCE_KEY_COVERAGE_MISMATCH',
    mutate(input) {
      findMapping(input, 'account').identity.logicalKeyBindings.owner.keyBindings.extra = {
        bindingType: 'literal',
        value: 'unused',
      };
    },
  },
  {
    vectorId: 'version-reference-key-map-mismatch',
    expectedCode: 'REFERENCE_KEY_COVERAGE_MISMATCH',
    mutate(input) {
      delete findMapping(input, 'holding').identity.logicalKeyBindings.accountVersion.keyBindings.asOf;
    },
  },
  {
    vectorId: 'reference-target-type-mismatch',
    expectedCode: 'REFERENCE_TARGET_TYPE_MISMATCH',
    mutate(input) {
      findMapping(input, 'account').identity.logicalKeyBindings.owner.targetMappingRef =
        findMapping(input, 'account').iri;
    },
  },
  {
    vectorId: 'unknown-reference-mapping',
    expectedCode: 'UNKNOWN_TARGET_MAPPING',
    mutate(input) {
      findMapping(input, 'account').identity.logicalKeyBindings.owner.targetMappingRef =
        'https://axiolune.ai/test/identity/mappings/missing';
    },
  },
  {
    vectorId: 'self-reference-cycle',
    expectedCode: 'REFERENCE_DEPENDENCY_CYCLE',
    mutate(input) {
      const party = findMapping(input, 'party');
      const partyContract = findContract(input, 'party');
      const refComponent = structuredClone(
        findContract(input, 'account').logicalComponents.find((component) => component.name === 'owner'),
      );
      refComponent.semanticValue.containingType = party.targetType;
      refComponent.semanticValue.attributeRef = `${party.targetType}/attributes/self`;
      refComponent.name = 'self';
      partyContract.logicalComponents.push(refComponent);
      party.identity.logicalKeyBindings.self = {
        bindingType: 'referenceIdentity',
        targetMappingRef: party.iri,
        referenceMode: 'logical',
        keyBindings: {
          partyId: {
            bindingType: 'directField',
            source: { dataset: 'fixture', field: 'party_id' },
          },
          self: {
            bindingType: 'referenceIdentity',
            targetMappingRef: party.iri,
            referenceMode: 'logical',
            keyBindings: {},
          },
        },
      };
    },
  },
  {
    vectorId: 'mutual-reference-cycle',
    expectedCode: 'REFERENCE_DEPENDENCY_CYCLE',
    mutate(input) {
      const party = findMapping(input, 'party');
      const partyContract = findContract(input, 'party');
      const accountVersionComponent = structuredClone(
        findContract(input, 'holding').logicalComponents.find(
          (component) => component.name === 'accountVersion',
        ),
      );
      accountVersionComponent.name = 'linkedAccount';
      accountVersionComponent.semanticValue.containingType = party.targetType;
      accountVersionComponent.semanticValue.attributeRef = `${party.targetType}/attributes/linkedAccount`;
      partyContract.logicalComponents.push(accountVersionComponent);
      party.identity.logicalKeyBindings.linkedAccount = {
        bindingType: 'referenceIdentity',
        targetMappingRef: findMapping(input, 'account').iri,
        referenceMode: 'version',
        keyBindings: {
          accountId: {
            bindingType: 'directField',
            source: { dataset: 'fixture', field: 'linked_account_id' },
          },
          accountKind: {
            bindingType: 'directField',
            source: { dataset: 'fixture', field: 'linked_account_kind' },
          },
          owner: {
            bindingType: 'directField',
            source: { dataset: 'fixture', field: 'linked_account_owner_iri' },
          },
          asOf: {
            bindingType: 'directField',
            source: { dataset: 'fixture', field: 'linked_account_as_of' },
          },
        },
      };
    },
  },
  {
    vectorId: 'duplicate-mapping-ref',
    expectedCode: 'DUPLICATE_MAPPING_REF',
    mutate(input) {
      input.mappings.push(structuredClone(findMapping(input, 'party')));
    },
  },
  {
    vectorId: 'mapping-target-contract-mismatch',
    expectedCode: 'MAPPING_CONTRACT_MISMATCH',
    mutate(input) {
      findMapping(input, 'party').identity.contractRef = findContract(input, 'account').iri;
    },
  },
  {
    vectorId: 'mapping-without-contract',
    expectedCode: 'MAPPING_OUTSIDE_TARGET_CLOSURE',
    mutate(input) {
      findMapping(input, 'party').targetType = 'https://axiolune.ai/test/identity/types/Unknown';
    },
  },
  {
    vectorId: 'contract-without-mapping',
    expectedCode: 'CONTRACT_WITHOUT_MAPPING',
    mutate(input) {
      const partyRef = findMapping(input, 'party').iri;
      input.mappings = input.mappings.filter((mapping) => mapping.iri !== partyRef);
      const account = findMapping(input, 'account');
      account.identity.logicalKeyBindings.owner.targetMappingRef = account.iri;
      const holding = findMapping(input, 'holding');
      holding.identity.logicalKeyBindings.accountVersion.keyBindings.owner.targetMappingRef = account.iri;
    },
  },
];
