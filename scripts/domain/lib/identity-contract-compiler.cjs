'use strict';

const crypto = require('crypto');
const {
  canonicalJcs,
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ASCII_ID_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const LOWER_BCP47_RE = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/;
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

const TAGS = Object.freeze({
  termContract: 'axiolune-identity-term-contract-v1\0',
  controlledSet: 'axiolune-controlled-iri-set-v1\0',
  termRegistry: 'axiolune-identity-term-registry-v1\0',
  normalizationRule: 'axiolune-identity-normalization-rule-v1\0',
  derivation: 'axiolune-identity-derivation-v1\0',
  targetContract: 'axiolune-target-identity-contract-v1\0',
  semanticMapping: 'axiolune-semantic-mapping-definition-v1\0',
  identityManifest: 'axiolune-materialized-target-identity-manifest-v1\0',
  identityKey: 'axiolune-identity-key-v1\0',
});

class IdentityContractError extends Error {
  constructor(errors) {
    super(errors.map((entry) => `${entry.code} ${entry.path}: ${entry.message}`).join('\n'));
    this.name = 'IdentityContractError';
    this.errors = errors;
  }
}

function issue(errors, code, path, message) {
  errors.push({ code, path, message });
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function u64be(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('length must be a non-negative safe integer');
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
}

function artifactDigest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function taggedJcsDigest(tag, value) {
  if (typeof tag !== 'string' || !tag.endsWith('\0')) throw new Error('digest tag must end with NUL');
  return artifactDigest(Buffer.concat([
    Buffer.from(tag, 'utf8'),
    Buffer.from(canonicalJcs(value), 'utf8'),
  ]));
}

function validateClosed(value, required, optional, path, errors, code = 'CLOSED_OBJECT') {
  if (!isPlainObject(value)) {
    issue(errors, code, path, 'expected a closed object');
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(errors, 'UNKNOWN_FIELD', `${path}.${key}`, 'unknown field');
  }
  for (const key of required) {
    if (!own(value, key)) issue(errors, 'MISSING_FIELD', `${path}.${key}`, 'missing required field');
  }
  return true;
}

function validateNfcString(value, path, errors, options = {}) {
  if (typeof value !== 'string'
      || value !== value.normalize('NFC')
      || (options.nonEmpty !== false && value.length === 0)) {
    issue(errors, 'INVALID_STRING', path, 'expected a non-empty Unicode-NFC string');
    return false;
  }
  return true;
}

function validateAsciiId(value, path, errors) {
  if (typeof value !== 'string' || !ASCII_ID_RE.test(value)) {
    issue(errors, 'INVALID_ASCII_IDENTIFIER', path, 'expected a non-empty ASCII identifier');
    return false;
  }
  return true;
}

function validateDigest(value, path, errors) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    issue(errors, 'INVALID_DIGEST', path, 'expected sha256 followed by 64 lowercase hexadecimal digits');
    return false;
  }
  return true;
}

function validateAbsoluteIri(value, path, errors, options = {}) {
  let valid = true;
  if (typeof value !== 'string'
      || value.length === 0
      || value !== value.normalize('NFC')
      || /[\u0000-\u0020\u007f]/u.test(value)) {
    valid = false;
  } else {
    try {
      const parsed = new URL(value);
      valid = Boolean(parsed.protocol) && parsed.href === value;
    } catch {
      valid = false;
    }
  }
  if (!valid) issue(errors, 'INVALID_ABSOLUTE_IRI', path, 'expected a normalized absolute IRI');
  if (valid && options.noTrailingSlash && value.endsWith('/')) {
    issue(errors, 'INVALID_IDENTITY_BASE', path, 'identityBaseIri must not end in "/"');
    valid = false;
  }
  return valid;
}

function validateExactKeys(value, expectedNames, path, errors, code = 'KEY_COVERAGE_MISMATCH') {
  if (!isPlainObject(value)) {
    issue(errors, code, path, 'expected a binding map');
    return false;
  }
  const actual = Object.keys(value).sort(utf8Compare);
  const expected = [...expectedNames].sort(utf8Compare);
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    issue(
      errors,
      code,
      path,
      `keys must equal [${expectedNames.join(', ')}] exactly; received [${Object.keys(value).join(', ')}]`,
    );
    return false;
  }
  return true;
}

function safeTaggedDigest(tag, value, path, errors) {
  try {
    return taggedJcsDigest(tag, value);
  } catch (error) {
    issue(errors, 'JCS_CANONICALIZATION_FAILED', path, error.message);
    return null;
  }
}

function validateTermContractDefinition(definition, path, errors) {
  if (!validateClosed(definition, ['iri', 'label', 'definition', 'termContract'], [], path, errors)) return;
  validateAbsoluteIri(definition.iri, `${path}.iri`, errors);
  validateNfcString(definition.label, `${path}.label`, errors);
  validateNfcString(definition.definition, `${path}.definition`, errors);
  const term = definition.termContract;
  if (!isPlainObject(term)) {
    issue(errors, 'INVALID_TERM_CONTRACT', `${path}.termContract`, 'expected a closed term contract');
    return;
  }
  if (term.termKind === 'iri' && ['logical', 'version'].includes(term.referenceMode)) {
    if (!validateClosed(term, ['termKind', 'referenceMode', 'expectedTargetType'], [], `${path}.termContract`, errors)) return;
    validateAbsoluteIri(term.expectedTargetType, `${path}.termContract.expectedTargetType`, errors);
  } else if (term.termKind === 'iri' && term.referenceMode === 'controlledIri') {
    if (!validateClosed(
      term,
      ['termKind', 'referenceMode', 'controlledSetRef', 'controlledSetDigest'],
      [],
      `${path}.termContract`,
      errors,
    )) return;
    validateAbsoluteIri(term.controlledSetRef, `${path}.termContract.controlledSetRef`, errors);
    validateDigest(term.controlledSetDigest, `${path}.termContract.controlledSetDigest`, errors);
  } else if (term.termKind === 'literal') {
    if (!validateClosed(term, ['termKind', 'datatypeIri'], ['languageTag'], `${path}.termContract`, errors)) return;
    validateAbsoluteIri(term.datatypeIri, `${path}.termContract.datatypeIri`, errors);
    if (term.datatypeIri === RDF_LANG_STRING) {
      if (!own(term, 'languageTag')) {
        issue(errors, 'LANGUAGE_TAG_REQUIRED', `${path}.termContract.languageTag`, 'rdf:langString requires languageTag');
      }
    } else if (own(term, 'languageTag')) {
      issue(errors, 'LANGUAGE_TAG_FORBIDDEN', `${path}.termContract.languageTag`, 'languageTag is legal only for rdf:langString');
    }
    if (own(term, 'languageTag')
        && (typeof term.languageTag !== 'string'
          || term.languageTag !== term.languageTag.toLowerCase()
          || !LOWER_BCP47_RE.test(term.languageTag))) {
      issue(errors, 'INVALID_LANGUAGE_TAG', `${path}.termContract.languageTag`, 'expected lowercase canonical BCP 47 spelling');
    }
  } else {
    issue(errors, 'INVALID_TERM_CONTRACT_BRANCH', `${path}.termContract`, 'unsupported or cross-branch term contract');
  }
}

function validateControlledSetDefinition(definition, path, errors) {
  const fields = [
    'iri',
    'label',
    'definition',
    'setKind',
    'sourceDefinitionRef',
    'sourceEvidenceRef',
    'sourceEvidenceDigest',
    'sourceLocator',
    'members',
  ];
  if (!validateClosed(definition, fields, [], path, errors)) return;
  validateAbsoluteIri(definition.iri, `${path}.iri`, errors);
  validateNfcString(definition.label, `${path}.label`, errors);
  validateNfcString(definition.definition, `${path}.definition`, errors);
  if (!['codeList', 'reviewedIriInventory'].includes(definition.setKind)) {
    issue(errors, 'INVALID_SET_KIND', `${path}.setKind`, 'expected codeList or reviewedIriInventory');
  }
  validateAbsoluteIri(definition.sourceDefinitionRef, `${path}.sourceDefinitionRef`, errors);
  validateAbsoluteIri(definition.sourceEvidenceRef, `${path}.sourceEvidenceRef`, errors);
  validateDigest(definition.sourceEvidenceDigest, `${path}.sourceEvidenceDigest`, errors);
  const locatorResult = validateSourceLocator(definition.sourceLocator, { at: `${path}.sourceLocator` });
  for (const message of locatorResult.errors) issue(errors, 'INVALID_SOURCE_LOCATOR', `${path}.sourceLocator`, message);
  if (!Array.isArray(definition.members) || definition.members.length === 0) {
    issue(errors, 'EMPTY_CONTROLLED_SET', `${path}.members`, 'members must be a non-empty array');
  } else {
    let previous = null;
    definition.members.forEach((member, index) => {
      validateAbsoluteIri(member, `${path}.members[${index}]`, errors);
      if (previous !== null && utf8Compare(previous, member) >= 0) {
        issue(errors, 'UNSORTED_OR_DUPLICATE_MEMBERS', `${path}.members[${index}]`, 'members must be strictly IRI-byte sorted and unique');
      }
      previous = member;
    });
  }
}

function buildTermRegistryIndex(registry, registryDigest, errors) {
  const termContracts = new Map();
  const controlledSets = new Map();
  if (!validateClosed(
    registry,
    ['schemaVersion', 'profileRef', 'termContracts', 'controlledSets'],
    [],
    'identityTermRegistry',
    errors,
  )) return { termContracts, controlledSets };
  if (registry.schemaVersion !== '1.0') issue(errors, 'SCHEMA_VERSION_MISMATCH', 'identityTermRegistry.schemaVersion', 'expected "1.0"');
  validateAbsoluteIri(registry.profileRef, 'identityTermRegistry.profileRef', errors);
  if (!Array.isArray(registry.termContracts) || registry.termContracts.length === 0) {
    issue(errors, 'EMPTY_TERM_REGISTRY', 'identityTermRegistry.termContracts', 'termContracts must be non-empty');
  } else {
    let previous = null;
    const definitionDigests = new Set();
    registry.termContracts.forEach((row, index) => {
      const path = `identityTermRegistry.termContracts[${index}]`;
      if (!validateClosed(row, ['termContractRef', 'termContractDigest', 'definition'], [], path, errors)) return;
      validateAbsoluteIri(row.termContractRef, `${path}.termContractRef`, errors);
      validateDigest(row.termContractDigest, `${path}.termContractDigest`, errors);
      validateTermContractDefinition(row.definition, `${path}.definition`, errors);
      if (row.definition && row.termContractRef !== row.definition.iri) {
        issue(errors, 'TERM_CONTRACT_REF_MISMATCH', path, 'termContractRef must equal definition.iri');
      }
      const actual = safeTaggedDigest(TAGS.termContract, row.definition, `${path}.definition`, errors);
      if (actual && row.termContractDigest !== actual) {
        issue(errors, 'TERM_CONTRACT_DIGEST_MISMATCH', `${path}.termContractDigest`, `expected ${actual}`);
      }
      if (previous !== null && utf8Compare(previous, row.termContractRef) >= 0) {
        issue(errors, 'UNSORTED_OR_DUPLICATE_TERM_CONTRACT', path, 'term contracts must be strictly ref-sorted and unique');
      }
      previous = row.termContractRef;
      if (termContracts.has(row.termContractRef)) {
        issue(errors, 'DUPLICATE_TERM_CONTRACT', path, 'duplicate termContractRef');
      } else {
        termContracts.set(row.termContractRef, row);
      }
      if (actual && definitionDigests.has(actual)) issue(errors, 'DUPLICATE_TERM_DEFINITION', path, 'duplicate effective term contract definition');
      if (actual) definitionDigests.add(actual);
    });
  }
  if (!Array.isArray(registry.controlledSets)) {
    issue(errors, 'INVALID_CONTROLLED_SETS', 'identityTermRegistry.controlledSets', 'controlledSets must be an array');
  } else {
    let previous = null;
    registry.controlledSets.forEach((row, index) => {
      const path = `identityTermRegistry.controlledSets[${index}]`;
      if (!validateClosed(row, ['controlledSetRef', 'controlledSetDigest', 'definition'], [], path, errors)) return;
      validateAbsoluteIri(row.controlledSetRef, `${path}.controlledSetRef`, errors);
      validateDigest(row.controlledSetDigest, `${path}.controlledSetDigest`, errors);
      validateControlledSetDefinition(row.definition, `${path}.definition`, errors);
      if (row.definition && row.controlledSetRef !== row.definition.iri) {
        issue(errors, 'CONTROLLED_SET_REF_MISMATCH', path, 'controlledSetRef must equal definition.iri');
      }
      const actual = safeTaggedDigest(TAGS.controlledSet, row.definition, `${path}.definition`, errors);
      if (actual && row.controlledSetDigest !== actual) {
        issue(errors, 'CONTROLLED_SET_DIGEST_MISMATCH', `${path}.controlledSetDigest`, `expected ${actual}`);
      }
      if (previous !== null && utf8Compare(previous, row.controlledSetRef) >= 0) {
        issue(errors, 'UNSORTED_OR_DUPLICATE_CONTROLLED_SET', path, 'controlled sets must be strictly ref-sorted and unique');
      }
      previous = row.controlledSetRef;
      if (controlledSets.has(row.controlledSetRef)) {
        issue(errors, 'DUPLICATE_CONTROLLED_SET', path, 'duplicate controlledSetRef');
      } else {
        controlledSets.set(row.controlledSetRef, row);
      }
    });
  }
  for (const [ref, row] of termContracts) {
    const term = row.definition && row.definition.termContract;
    if (term && term.referenceMode === 'controlledIri') {
      const set = controlledSets.get(term.controlledSetRef);
      if (!set) {
        issue(errors, 'UNKNOWN_CONTROLLED_SET', `termContract(${ref})`, 'controlledSetRef does not resolve in registry');
      } else if (set.controlledSetDigest !== term.controlledSetDigest) {
        issue(errors, 'CONTROLLED_SET_JOIN_MISMATCH', `termContract(${ref})`, 'controlled set digest does not match registry row');
      }
    }
  }
  const actualRegistryDigest = safeTaggedDigest(TAGS.termRegistry, registry, 'identityTermRegistry', errors);
  validateDigest(registryDigest, 'identityTermRegistryDigest', errors);
  if (actualRegistryDigest && actualRegistryDigest !== registryDigest) {
    issue(errors, 'TERM_REGISTRY_DIGEST_MISMATCH', 'identityTermRegistryDigest', `expected ${actualRegistryDigest}`);
  }
  return { termContracts, controlledSets };
}

function validateArtifactRefInto(value, path, errors) {
  const result = validateArtifactRef(value, path);
  for (const message of result.errors) issue(errors, 'INVALID_ARTIFACT_REF', path, message);
}

function buildNormalizationRuleIndex(rules, registryIndex, errors) {
  const index = new Map();
  if (!Array.isArray(rules)) {
    issue(errors, 'INVALID_NORMALIZATION_RULES', 'normalizationRules', 'expected an array');
    return index;
  }
  const fields = [
    'iri', 'label', 'definition',
    'inputTermContractRef', 'inputTermContractDigest',
    'outputTermContractRef', 'outputTermContractDigest',
    'algorithmId', 'algorithmVersion',
    'specificationRef', 'specificationDigest',
    'implementationRef', 'implementationDigest',
    'testVectorsRef', 'testVectorsDigest',
  ];
  rules.forEach((rule, ruleIndex) => {
    const path = `normalizationRules[${ruleIndex}]`;
    if (!validateClosed(rule, fields, [], path, errors)) return;
    validateAbsoluteIri(rule.iri, `${path}.iri`, errors);
    validateNfcString(rule.label, `${path}.label`, errors);
    validateNfcString(rule.definition, `${path}.definition`, errors);
    validateAsciiId(rule.algorithmId, `${path}.algorithmId`, errors);
    if (typeof rule.algorithmVersion !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(rule.algorithmVersion)) {
      issue(errors, 'INVALID_SEMVER', `${path}.algorithmVersion`, 'expected semantic version');
    }
    for (const side of ['input', 'output']) {
      const refName = `${side}TermContractRef`;
      const digestName = `${side}TermContractDigest`;
      validateAbsoluteIri(rule[refName], `${path}.${refName}`, errors);
      validateDigest(rule[digestName], `${path}.${digestName}`, errors);
      const row = registryIndex.termContracts.get(rule[refName]);
      if (!row) issue(errors, 'UNKNOWN_TERM_CONTRACT', `${path}.${refName}`, 'term contract is not registered');
      else if (row.termContractDigest !== rule[digestName]) {
        issue(errors, 'TERM_CONTRACT_JOIN_MISMATCH', `${path}.${digestName}`, 'digest does not match registered term contract');
      }
    }
    for (const refName of ['specificationRef', 'implementationRef', 'testVectorsRef']) {
      validateArtifactRefInto(rule[refName], `${path}.${refName}`, errors);
    }
    for (const digestName of ['specificationDigest', 'implementationDigest', 'testVectorsDigest']) {
      validateDigest(rule[digestName], `${path}.${digestName}`, errors);
    }
    if (index.has(rule.iri)) issue(errors, 'DUPLICATE_NORMALIZATION_RULE', path, 'duplicate normalization-rule IRI');
    else index.set(rule.iri, {
      definition: rule,
      digest: safeTaggedDigest(TAGS.normalizationRule, rule, path, errors),
    });
  });
  return index;
}

const SEMANTIC_VALUE_FIELDS = Object.freeze({
  attributeUse: ['valueKind', 'containingType', 'attributeRef'],
  participantRole: ['valueKind', 'containingAssociation', 'roleId', 'effectivePredicate'],
  relationUse: ['valueKind', 'relationRef', 'subjectType', 'objectType'],
  patternField: ['valueKind', 'containingType', 'patternRef', 'fieldRef'],
  derivation: ['valueKind', 'derivationRef', 'derivationDigest', 'outputName'],
});

function validateSemanticValue(value, path, errors, derivations) {
  if (!isPlainObject(value) || !own(SEMANTIC_VALUE_FIELDS, value.valueKind)) {
    issue(errors, 'INVALID_SEMANTIC_VALUE_BRANCH', path, 'unsupported semantic value branch');
    return;
  }
  const fields = SEMANTIC_VALUE_FIELDS[value.valueKind];
  if (!validateClosed(value, fields, [], path, errors)) return;
  for (const field of fields) {
    if (field === 'valueKind') continue;
    if (field === 'roleId' || field === 'outputName') validateAsciiId(value[field], `${path}.${field}`, errors);
    else if (field.endsWith('Digest')) validateDigest(value[field], `${path}.${field}`, errors);
    else validateAbsoluteIri(value[field], `${path}.${field}`, errors);
  }
  if (value.valueKind === 'derivation') {
    const row = derivations.get(value.derivationRef);
    if (!row) {
      issue(errors, 'UNKNOWN_DERIVATION', `${path}.derivationRef`, 'derivation does not resolve');
    } else {
      if (row.digest !== value.derivationDigest) issue(errors, 'DERIVATION_DIGEST_MISMATCH', `${path}.derivationDigest`, 'digest does not match derivation');
      const output = row.definition.outputs.find((candidate) => candidate.outputName === value.outputName);
      if (!output) issue(errors, 'UNKNOWN_DERIVATION_OUTPUT', `${path}.outputName`, 'outputName does not resolve');
    }
  }
}

function buildDerivationIndex(derivations, registryIndex, errors) {
  const index = new Map();
  if (!Array.isArray(derivations)) {
    issue(errors, 'INVALID_DERIVATIONS', 'derivations', 'expected an array');
    return index;
  }
  const fields = [
    'iri', 'label', 'definition', 'inputSemanticValues', 'outputs',
    'expressionRef', 'expressionDigest', 'implementationRef',
    'implementationDigest', 'testVectorsRef', 'testVectorsDigest',
  ];
  derivations.forEach((derivation, derivationIndex) => {
    const path = `derivations[${derivationIndex}]`;
    if (!validateClosed(derivation, fields, [], path, errors)) return;
    validateAbsoluteIri(derivation.iri, `${path}.iri`, errors);
    validateNfcString(derivation.label, `${path}.label`, errors);
    validateNfcString(derivation.definition, `${path}.definition`, errors);
    if (!Array.isArray(derivation.inputSemanticValues) || derivation.inputSemanticValues.length === 0) {
      issue(errors, 'EMPTY_DERIVATION_INPUTS', `${path}.inputSemanticValues`, 'must be a non-empty ordered array');
    }
    for (const refName of ['expressionRef', 'implementationRef', 'testVectorsRef']) {
      validateArtifactRefInto(derivation[refName], `${path}.${refName}`, errors);
    }
    for (const digestName of ['expressionDigest', 'implementationDigest', 'testVectorsDigest']) {
      validateDigest(derivation[digestName], `${path}.${digestName}`, errors);
    }
    if (!Array.isArray(derivation.outputs) || derivation.outputs.length === 0) {
      issue(errors, 'EMPTY_DERIVATION_OUTPUTS', `${path}.outputs`, 'must be a non-empty outputName-sorted array');
    } else {
      let previous = null;
      derivation.outputs.forEach((output, outputIndex) => {
        const outputPath = `${path}.outputs[${outputIndex}]`;
        if (!validateClosed(output, ['outputName', 'termContractRef', 'termContractDigest'], [], outputPath, errors)) return;
        validateAsciiId(output.outputName, `${outputPath}.outputName`, errors);
        validateAbsoluteIri(output.termContractRef, `${outputPath}.termContractRef`, errors);
        validateDigest(output.termContractDigest, `${outputPath}.termContractDigest`, errors);
        const term = registryIndex.termContracts.get(output.termContractRef);
        if (!term) issue(errors, 'UNKNOWN_TERM_CONTRACT', `${outputPath}.termContractRef`, 'term contract is not registered');
        else if (term.termContractDigest !== output.termContractDigest) {
          issue(errors, 'TERM_CONTRACT_JOIN_MISMATCH', `${outputPath}.termContractDigest`, 'digest does not match registry');
        }
        if (previous !== null && utf8Compare(previous, output.outputName) >= 0) {
          issue(errors, 'UNSORTED_OR_DUPLICATE_DERIVATION_OUTPUT', outputPath, 'outputs must be strictly outputName-sorted and unique');
        }
        previous = output.outputName;
      });
    }
    if (index.has(derivation.iri)) issue(errors, 'DUPLICATE_DERIVATION', path, 'duplicate derivation IRI');
    else index.set(derivation.iri, {
      definition: derivation,
      digest: safeTaggedDigest(TAGS.derivation, derivation, path, errors),
    });
  });
  for (const [ref, row] of index) {
    row.definition.inputSemanticValues.forEach((value, valueIndex) => {
      validateSemanticValue(value, `derivation(${ref}).inputSemanticValues[${valueIndex}]`, errors, index);
    });
  }
  return index;
}

function validateIdentityComponent(component, path, errors, indexes) {
  const fields = [
    'name', 'semanticValue', 'termContractRef', 'termContractDigest',
    'normalizationRuleRef', 'normalizationRuleDigest',
  ];
  if (!validateClosed(component, fields, [], path, errors)) return;
  validateAsciiId(component.name, `${path}.name`, errors);
  validateSemanticValue(component.semanticValue, `${path}.semanticValue`, errors, indexes.derivations);
  validateAbsoluteIri(component.termContractRef, `${path}.termContractRef`, errors);
  validateDigest(component.termContractDigest, `${path}.termContractDigest`, errors);
  validateAbsoluteIri(component.normalizationRuleRef, `${path}.normalizationRuleRef`, errors);
  validateDigest(component.normalizationRuleDigest, `${path}.normalizationRuleDigest`, errors);
  const term = indexes.registry.termContracts.get(component.termContractRef);
  if (!term) {
    issue(errors, 'UNKNOWN_TERM_CONTRACT', `${path}.termContractRef`, 'term contract is not registered');
  } else if (term.termContractDigest !== component.termContractDigest) {
    issue(errors, 'TERM_CONTRACT_JOIN_MISMATCH', `${path}.termContractDigest`, 'digest does not match registry');
  }
  const rule = indexes.normalizationRules.get(component.normalizationRuleRef);
  if (!rule) {
    issue(errors, 'UNKNOWN_NORMALIZATION_RULE', `${path}.normalizationRuleRef`, 'normalization rule does not resolve');
  } else {
    if (rule.digest !== component.normalizationRuleDigest) {
      issue(errors, 'NORMALIZATION_RULE_DIGEST_MISMATCH', `${path}.normalizationRuleDigest`, 'digest does not match normalization rule');
    }
    if (rule.definition.outputTermContractRef !== component.termContractRef
        || rule.definition.outputTermContractDigest !== component.termContractDigest) {
      issue(errors, 'NORMALIZATION_OUTPUT_CONTRACT_MISMATCH', path, 'component contract must equal normalization-rule output contract');
    }
  }
  if (component.semanticValue && component.semanticValue.valueKind === 'derivation') {
    const derivation = indexes.derivations.get(component.semanticValue.derivationRef);
    const output = derivation && derivation.definition.outputs.find(
      (candidate) => candidate.outputName === component.semanticValue.outputName,
    );
    if (output
        && (output.termContractRef !== (rule && rule.definition.inputTermContractRef)
          || output.termContractDigest !== (rule && rule.definition.inputTermContractDigest))) {
      issue(errors, 'DERIVATION_INPUT_CONTRACT_MISMATCH', path, 'derivation output must equal normalization-rule input contract');
    }
  }
}

function buildContractIndexes(contracts, indexes, errors) {
  const byRef = new Map();
  const byTarget = new Map();
  const byBase = new Map();
  if (!Array.isArray(contracts) || contracts.length === 0) {
    issue(errors, 'EMPTY_TARGET_CONTRACTS', 'contracts', 'contracts must be a non-empty array');
    return { byRef, byTarget, byBase };
  }
  const fields = [
    'iri', 'label', 'definition', 'targetType', 'identityBaseIri',
    'logicalComponents', 'versionComponents',
  ];
  contracts.forEach((contract, contractIndex) => {
    const path = `contracts[${contractIndex}]`;
    if (!validateClosed(contract, fields, [], path, errors)) return;
    validateAbsoluteIri(contract.iri, `${path}.iri`, errors);
    validateNfcString(contract.label, `${path}.label`, errors);
    validateNfcString(contract.definition, `${path}.definition`, errors);
    validateAbsoluteIri(contract.targetType, `${path}.targetType`, errors);
    validateAbsoluteIri(contract.identityBaseIri, `${path}.identityBaseIri`, errors, { noTrailingSlash: true });
    if (!Array.isArray(contract.logicalComponents) || contract.logicalComponents.length === 0) {
      issue(errors, 'EMPTY_LOGICAL_COMPONENTS', `${path}.logicalComponents`, 'logicalComponents must be a non-empty ordered array');
    }
    if (!Array.isArray(contract.versionComponents)) {
      issue(errors, 'INVALID_VERSION_COMPONENTS', `${path}.versionComponents`, 'versionComponents must be an ordered array');
    }
    const names = new Set();
    for (const listName of ['logicalComponents', 'versionComponents']) {
      if (!Array.isArray(contract[listName])) continue;
      contract[listName].forEach((component, componentIndex) => {
        validateIdentityComponent(component, `${path}.${listName}[${componentIndex}]`, errors, indexes);
        if (component && typeof component.name === 'string') {
          if (names.has(component.name)) {
            issue(errors, 'DUPLICATE_COMPONENT_NAME', `${path}.${listName}[${componentIndex}].name`, 'component names must be unique across logical and version arrays');
          }
          names.add(component.name);
        }
      });
    }
    if (byRef.has(contract.iri)) issue(errors, 'DUPLICATE_CONTRACT_REF', path, 'duplicate contract IRI');
    else byRef.set(contract.iri, contract);
    if (byTarget.has(contract.targetType)) issue(errors, 'DUPLICATE_TARGET_CONTRACT', path, 'one contract per targetType is required');
    else byTarget.set(contract.targetType, contract);
    if (byBase.has(contract.identityBaseIri)) {
      issue(errors, 'DUPLICATE_IDENTITY_BASE', path, `identityBaseIri already belongs to ${byBase.get(contract.identityBaseIri)}`);
    } else {
      byBase.set(contract.identityBaseIri, contract.targetType);
    }
  });
  return { byRef, byTarget, byBase };
}

function componentNames(contract, mode) {
  if (mode === 'logical') return contract.logicalComponents.map((component) => component.name);
  return [
    ...contract.logicalComponents.map((component) => component.name),
    ...contract.versionComponents.map((component) => component.name),
  ];
}

function componentList(contract, mode) {
  return mode === 'logical'
    ? contract.logicalComponents
    : [...contract.logicalComponents, ...contract.versionComponents];
}

function validateValueBinding(binding, path, errors, context) {
  if (!isPlainObject(binding)) {
    issue(errors, 'INVALID_VALUE_BINDING', path, 'expected a strict ValueBinding object');
    return;
  }
  const type = binding.bindingType;
  if (type === 'directField') {
    if (!validateClosed(binding, ['bindingType', 'source'], [], path, errors)) return;
    if (validateClosed(binding.source, ['dataset', 'field'], [], `${path}.source`, errors)) {
      validateNfcString(binding.source.dataset, `${path}.source.dataset`, errors);
      validateNfcString(binding.source.field, `${path}.source.field`, errors);
    }
  } else if (type === 'transformation') {
    if (!validateClosed(binding, ['bindingType', 'transformationRef', 'inputs'], [], path, errors)) return;
    validateAbsoluteIri(binding.transformationRef, `${path}.transformationRef`, errors);
    if (!isPlainObject(binding.inputs)) issue(errors, 'INVALID_TRANSFORMATION_INPUTS', `${path}.inputs`, 'expected a binding map');
    else for (const [name, child] of Object.entries(binding.inputs)) {
      validateAsciiId(name, `${path}.inputs key`, errors);
      validateValueBinding(child, `${path}.inputs.${name}`, errors, { ...context, component: null });
    }
  } else if (type === 'literal') {
    if (!validateClosed(binding, ['bindingType', 'value'], [], path, errors)) return;
    try {
      canonicalJcs(binding.value);
    } catch (error) {
      issue(errors, 'INVALID_LITERAL_BINDING', `${path}.value`, error.message);
    }
  } else if (type === 'runtimeContext') {
    if (!validateClosed(binding, ['bindingType', 'contextField'], [], path, errors)) return;
    if (!['iri', 'assertionTime', 'referenceTime', 'runId'].includes(binding.contextField)) {
      issue(
        errors,
        'INVALID_RUNTIME_CONTEXT_FIELD',
        `${path}.contextField`,
        'expected iri, assertionTime, referenceTime, or runId',
      );
    }
  } else if (type === 'referenceIdentity') {
    if (!validateClosed(binding, ['bindingType', 'targetMappingRef', 'referenceMode', 'keyBindings'], [], path, errors)) return;
    validateAbsoluteIri(binding.targetMappingRef, `${path}.targetMappingRef`, errors);
    if (!['logical', 'version'].includes(binding.referenceMode)) {
      issue(errors, 'INVALID_REFERENCE_MODE', `${path}.referenceMode`, 'expected logical or version');
      return;
    }
    const callerTerm = context.component && context.registry.termContracts.get(context.component.termContractRef);
    const termContract = callerTerm && callerTerm.definition.termContract;
    if (context.component) {
      if (!termContract || termContract.termKind !== 'iri' || !['logical', 'version'].includes(termContract.referenceMode)) {
        issue(errors, 'REFERENCE_BINDING_TERM_MISMATCH', path, 'ReferenceIdentityBinding requires a fact-reference term contract');
      } else if (termContract.referenceMode !== binding.referenceMode) {
        issue(errors, 'REFERENCE_MODE_MISMATCH', `${path}.referenceMode`, `component requires ${termContract.referenceMode}`);
      }
    } else if (!context.referenceSlot) {
      issue(errors, 'REFERENCE_BINDING_CONTEXT', path, 'ReferenceIdentityBinding is outside identity or semantic slot compilation');
    }
    const targetMapping = context.mappings.get(binding.targetMappingRef);
    if (!targetMapping) {
      issue(errors, 'UNKNOWN_TARGET_MAPPING', `${path}.targetMappingRef`, 'target mapping is not in the visible compilation closure');
      return;
    }
    if (context.visibleRefs && !context.visibleRefs.has(binding.targetMappingRef)) {
      issue(errors, 'INVISIBLE_TARGET_MAPPING', `${path}.targetMappingRef`, 'target mapping is not visible to the caller');
    }
    context.edges.get(context.ownerMappingRef).add(binding.targetMappingRef);
    const targetContract = context.contracts.byTarget.get(targetMapping.targetType);
    if (!targetContract) {
      issue(errors, 'MAPPING_WITHOUT_CONTRACT', `${path}.targetMappingRef`, 'target mapping has no registered target contract');
      return;
    }
    if (!isPlainObject(targetMapping.identity) || targetMapping.identity.contractRef !== targetContract.iri) {
      issue(errors, 'TARGET_MAPPING_CONTRACT_MISMATCH', `${path}.targetMappingRef`, 'target mapping does not use its target contract');
    }
    const expectedTargetType = termContract?.expectedTargetType || context.expectedTargetType;
    if (expectedTargetType && expectedTargetType !== targetMapping.targetType) {
      issue(errors, 'REFERENCE_TARGET_TYPE_MISMATCH', path, 'fact-reference term expectedTargetType differs from target mapping type');
    }
    const expectedNames = componentNames(targetContract, binding.referenceMode);
    if (validateExactKeys(binding.keyBindings, expectedNames, `${path}.keyBindings`, errors, 'REFERENCE_KEY_COVERAGE_MISMATCH')) {
      componentList(targetContract, binding.referenceMode).forEach((component) => {
        validateValueBinding(binding.keyBindings[component.name], `${path}.keyBindings.${component.name}`, errors, {
          ...context,
          component,
        });
      });
    }
  } else {
    issue(errors, 'UNKNOWN_VALUE_BINDING_BRANCH', `${path}.bindingType`, 'unsupported ValueBinding branch');
  }
}

function validateMappingSlotBindings(mapping, mappingRef, errors, context) {
  if (!own(mapping, 'slotMappings')) return;
  if (!Array.isArray(mapping.slotMappings)) {
    issue(errors, 'INVALID_SLOT_MAPPINGS', `mapping(${mappingRef}).slotMappings`, 'slotMappings must be an array');
    return;
  }
  mapping.slotMappings.forEach((slot, index) => {
    const slotPath = `mapping(${mappingRef}).slotMappings[${index}]`;
    if (!isPlainObject(slot) || !isPlainObject(slot.target) || !own(slot, 'value')) {
      issue(errors, 'INVALID_SLOT_MAPPING', slotPath, 'expected target and value objects');
      return;
    }
    const expectedTargetType = slot.target.slotType === 'relation'
      ? slot.target.targetObjectType
      : null;
    validateValueBinding(slot.value, `${slotPath}.value`, errors, {
      ...context,
      component: null,
      expectedTargetType,
      referenceSlot: true,
    });
  });
}

function validateIdentitySpec(identity, mapping, path, errors, context) {
  if (!validateClosed(identity, ['contractRef', 'logicalKeyBindings', 'versionKeyBindings'], [], path, errors)) return;
  validateAbsoluteIri(identity.contractRef, `${path}.contractRef`, errors);
  const contract = context.contracts.byTarget.get(mapping.targetType);
  if (!contract) {
    issue(errors, 'MAPPING_WITHOUT_CONTRACT', path, 'mapping targetType has no contract');
    return;
  }
  if (identity.contractRef !== contract.iri) {
    issue(errors, 'MAPPING_CONTRACT_MISMATCH', `${path}.contractRef`, 'mapping must use the unique contract registered for targetType');
  }
  const logicalNames = contract.logicalComponents.map((component) => component.name);
  const versionNames = contract.versionComponents.map((component) => component.name);
  if (validateExactKeys(identity.logicalKeyBindings, logicalNames, `${path}.logicalKeyBindings`, errors, 'LOGICAL_KEY_COVERAGE_MISMATCH')) {
    contract.logicalComponents.forEach((component) => {
      validateValueBinding(identity.logicalKeyBindings[component.name], `${path}.logicalKeyBindings.${component.name}`, errors, {
        ...context,
        component,
      });
    });
  }
  if (validateExactKeys(identity.versionKeyBindings, versionNames, `${path}.versionKeyBindings`, errors, 'VERSION_KEY_COVERAGE_MISMATCH')) {
    contract.versionComponents.forEach((component) => {
      validateValueBinding(identity.versionKeyBindings[component.name], `${path}.versionKeyBindings.${component.name}`, errors, {
        ...context,
        component,
      });
    });
  }
}

function buildMappingIndex(mappings, errors) {
  const index = new Map();
  if (!Array.isArray(mappings) || mappings.length === 0) {
    issue(errors, 'EMPTY_MAPPINGS', 'mappings', 'mappings must be a non-empty array');
    return index;
  }
  mappings.forEach((mapping, mappingIndex) => {
    const path = `mappings[${mappingIndex}]`;
    if (!isPlainObject(mapping)) {
      issue(errors, 'INVALID_MAPPING', path, 'expected a normalized mapping definition');
      return;
    }
    for (const field of ['iri', 'targetType', 'identity']) {
      if (!own(mapping, field)) issue(errors, 'MISSING_FIELD', `${path}.${field}`, 'mapping definition is missing identity compiler field');
    }
    validateAbsoluteIri(mapping.iri, `${path}.iri`, errors);
    validateAbsoluteIri(mapping.targetType, `${path}.targetType`, errors);
    if (index.has(mapping.iri)) issue(errors, 'DUPLICATE_MAPPING_REF', path, 'mapping IRI must be unique');
    else index.set(mapping.iri, mapping);
    try {
      canonicalJcs(mapping);
    } catch (error) {
      issue(errors, 'JCS_CANONICALIZATION_FAILED', path, error.message);
    }
  });
  return index;
}

function validateCoverage(concreteTargetTypes, contracts, mappings, errors) {
  if (!Array.isArray(concreteTargetTypes) || concreteTargetTypes.length === 0) {
    issue(errors, 'EMPTY_TARGET_CLOSURE', 'concreteTargetTypes', 'discovered concrete target list must be non-empty');
    return;
  }
  const targets = new Set();
  concreteTargetTypes.forEach((target, index) => {
    validateAbsoluteIri(target, `concreteTargetTypes[${index}]`, errors);
    if (targets.has(target)) issue(errors, 'DUPLICATE_CONCRETE_TARGET', `concreteTargetTypes[${index}]`, 'duplicate discovered target');
    targets.add(target);
  });
  for (const target of targets) {
    if (!contracts.byTarget.has(target)) issue(errors, 'TARGET_WITHOUT_CONTRACT', `target(${target})`, 'discovered target has no identity contract');
  }
  for (const target of contracts.byTarget.keys()) {
    if (!targets.has(target)) issue(errors, 'ORPHAN_CONTRACT', `contractTarget(${target})`, 'contract target is outside discovered mapping closure');
  }
  const mappingCount = new Map();
  for (const [mappingRef, mapping] of mappings) {
    if (!targets.has(mapping.targetType)) issue(errors, 'MAPPING_OUTSIDE_TARGET_CLOSURE', `mapping(${mappingRef})`, 'mapping target is not discovered');
    mappingCount.set(mapping.targetType, (mappingCount.get(mapping.targetType) || 0) + 1);
  }
  for (const target of targets) {
    if (!mappingCount.has(target)) issue(errors, 'CONTRACT_WITHOUT_MAPPING', `target(${target})`, 'each target contract requires at least one mapping');
  }
}

function detectMappingCycles(edges, errors) {
  const state = new Map();
  const stack = [];
  function visit(node) {
    const current = state.get(node) || 0;
    if (current === 2) return;
    if (current === 1) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      issue(errors, 'REFERENCE_DEPENDENCY_CYCLE', `mapping(${node})`, cycle.join(' -> '));
      return;
    }
    state.set(node, 1);
    stack.push(node);
    for (const target of edges.get(node) || []) visit(target);
    stack.pop();
    state.set(node, 2);
  }
  for (const node of edges.keys()) visit(node);
}

function validateCompilationInput(input, options = {}) {
  const errors = [];
  if (!validateClosed(
    input,
    [
      'profileRef', 'identityTermRegistryRef', 'identityTermRegistryDigest',
      'identityTermRegistry', 'normalizationRules', 'derivations',
      'contracts', 'mappings', 'concreteTargetTypes',
    ],
    [],
    'compilation',
    errors,
  )) return { ok: false, errors };
  validateAbsoluteIri(input.profileRef, 'profileRef', errors);
  validateArtifactRefInto(input.identityTermRegistryRef, 'identityTermRegistryRef', errors);
  const registry = buildTermRegistryIndex(input.identityTermRegistry, input.identityTermRegistryDigest, errors);
  if (input.identityTermRegistry && input.identityTermRegistry.profileRef !== input.profileRef) {
    issue(errors, 'REGISTRY_PROFILE_MISMATCH', 'identityTermRegistry.profileRef', 'registry profileRef must equal compilation profileRef');
  }
  const normalizationRules = buildNormalizationRuleIndex(input.normalizationRules, registry, errors);
  const derivations = buildDerivationIndex(input.derivations, registry, errors);
  const indexes = { registry, normalizationRules, derivations };
  const contracts = buildContractIndexes(input.contracts, indexes, errors);
  const mappings = buildMappingIndex(input.mappings, errors);
  validateCoverage(input.concreteTargetTypes, contracts, mappings, errors);
  const edges = new Map([...mappings.keys()].map((ref) => [ref, new Set()]));
  for (const [mappingRef, mapping] of mappings) {
    const visible = options.visibleMappingRefsByMapping
      && options.visibleMappingRefsByMapping[mappingRef];
    const visibleRefs = visible ? new Set(visible) : null;
    validateIdentitySpec(mapping.identity, mapping, `mapping(${mappingRef}).identity`, errors, {
      registry,
      contracts,
      mappings,
      edges,
      ownerMappingRef: mappingRef,
      visibleRefs,
      component: null,
    });
    validateMappingSlotBindings(mapping, mappingRef, errors, {
      registry,
      contracts,
      mappings,
      edges,
      ownerMappingRef: mappingRef,
      visibleRefs,
      component: null,
    });
  }
  detectMappingCycles(edges, errors);
  return {
    ok: errors.length === 0,
    errors,
    indexes: { registry, normalizationRules, derivations, contracts, mappings, edges },
  };
}

function compileIdentityContracts(input, options = {}) {
  const validation = validateCompilationInput(input, options);
  if (!validation.ok) throw new IdentityContractError(validation.errors);
  const { contracts, mappings } = validation.indexes;
  const mappingRows = new Map();
  for (const [mappingRef, mapping] of mappings) {
    const row = {
      mappingRef,
      mappingDigest: taggedJcsDigest(TAGS.semanticMapping, mapping),
    };
    if (!mappingRows.has(mapping.targetType)) mappingRows.set(mapping.targetType, []);
    mappingRows.get(mapping.targetType).push(row);
  }
  const manifest = {
    schemaVersion: '1.0',
    profileRef: input.profileRef,
    identityTermRegistryRef: input.identityTermRegistryRef,
    identityTermRegistryDigest: input.identityTermRegistryDigest,
    contracts: [...contracts.byTarget.values()]
      .sort((left, right) => utf8Compare(left.targetType, right.targetType))
      .map((contract) => ({
        contractRef: contract.iri,
        contractDigest: taggedJcsDigest(TAGS.targetContract, contract),
        targetType: contract.targetType,
        identityBaseIri: contract.identityBaseIri,
        logicalComponents: contract.logicalComponents,
        versionComponents: contract.versionComponents,
        mappings: mappingRows.get(contract.targetType)
          .sort((left, right) => utf8Compare(left.mappingRef, right.mappingRef)),
      })),
  };
  return {
    manifest,
    manifestDigest: taggedJcsDigest(TAGS.identityManifest, manifest),
    dependencyEdges: [...validation.indexes.edges.entries()]
      .map(([from, targets]) => [from, [...targets].sort(utf8Compare)]),
  };
}

function validateManifestShape(manifest, errors) {
  if (!validateClosed(
    manifest,
    ['schemaVersion', 'profileRef', 'identityTermRegistryRef', 'identityTermRegistryDigest', 'contracts'],
    [],
    'manifest',
    errors,
  )) return;
  if (manifest.schemaVersion !== '1.0') issue(errors, 'SCHEMA_VERSION_MISMATCH', 'manifest.schemaVersion', 'expected "1.0"');
  validateAbsoluteIri(manifest.profileRef, 'manifest.profileRef', errors);
  validateArtifactRefInto(manifest.identityTermRegistryRef, 'manifest.identityTermRegistryRef', errors);
  validateDigest(manifest.identityTermRegistryDigest, 'manifest.identityTermRegistryDigest', errors);
  if (!Array.isArray(manifest.contracts) || manifest.contracts.length === 0) {
    issue(errors, 'EMPTY_MANIFEST_CONTRACTS', 'manifest.contracts', 'contracts must be non-empty');
    return;
  }
  let previousTarget = null;
  const mappingRefs = new Set();
  manifest.contracts.forEach((row, rowIndex) => {
    const path = `manifest.contracts[${rowIndex}]`;
    if (!validateClosed(
      row,
      [
        'contractRef', 'contractDigest', 'targetType', 'identityBaseIri',
        'logicalComponents', 'versionComponents', 'mappings',
      ],
      [],
      path,
      errors,
    )) return;
    validateAbsoluteIri(row.contractRef, `${path}.contractRef`, errors);
    validateDigest(row.contractDigest, `${path}.contractDigest`, errors);
    validateAbsoluteIri(row.targetType, `${path}.targetType`, errors);
    validateAbsoluteIri(row.identityBaseIri, `${path}.identityBaseIri`, errors, { noTrailingSlash: true });
    if (previousTarget !== null && utf8Compare(previousTarget, row.targetType) >= 0) {
      issue(errors, 'UNSORTED_OR_DUPLICATE_MANIFEST_TARGET', path, 'contract rows must be strictly targetType-sorted and unique');
    }
    previousTarget = row.targetType;
    if (!Array.isArray(row.logicalComponents) || !Array.isArray(row.versionComponents)) {
      issue(errors, 'INVALID_MANIFEST_COMPONENTS', path, 'component arrays are required');
    }
    if (!Array.isArray(row.mappings) || row.mappings.length === 0) {
      issue(errors, 'EMPTY_MANIFEST_MAPPINGS', `${path}.mappings`, 'each contract row needs at least one mapping');
    } else {
      let previousMapping = null;
      row.mappings.forEach((mapping, mappingIndex) => {
        const mappingPath = `${path}.mappings[${mappingIndex}]`;
        if (!validateClosed(mapping, ['mappingRef', 'mappingDigest'], [], mappingPath, errors)) return;
        validateAbsoluteIri(mapping.mappingRef, `${mappingPath}.mappingRef`, errors);
        validateDigest(mapping.mappingDigest, `${mappingPath}.mappingDigest`, errors);
        if (previousMapping !== null && utf8Compare(previousMapping, mapping.mappingRef) >= 0) {
          issue(errors, 'UNSORTED_OR_DUPLICATE_MANIFEST_MAPPING', mappingPath, 'mapping rows must be strictly ref-sorted and unique');
        }
        previousMapping = mapping.mappingRef;
        if (mappingRefs.has(mapping.mappingRef)) {
          issue(errors, 'DUPLICATE_MANIFEST_MAPPING', mappingPath, 'mapping must appear exactly once in the manifest');
        }
        mappingRefs.add(mapping.mappingRef);
      });
    }
  });
}

function validateIdentityManifest(manifest, input, options = {}) {
  const errors = [];
  validateManifestShape(manifest, errors);
  let expected;
  try {
    expected = compileIdentityContracts(input, options).manifest;
  } catch (error) {
    if (error instanceof IdentityContractError) errors.push(...error.errors);
    else throw error;
  }
  if (expected) {
    let actualCanonical;
    let expectedCanonical;
    try {
      actualCanonical = canonicalJcs(manifest);
      expectedCanonical = canonicalJcs(expected);
    } catch (error) {
      issue(errors, 'JCS_CANONICALIZATION_FAILED', 'manifest', error.message);
    }
    if (actualCanonical && actualCanonical !== expectedCanonical) {
      issue(errors, 'IDENTITY_MANIFEST_MISMATCH', 'manifest', 'manifest is not the exact compiler projection');
    }
  }
  return { ok: errors.length === 0, errors };
}

function frameIdentityKey(components, termsByName) {
  if (!Array.isArray(components)) throw new TypeError('components must be an ordered array');
  const errors = [];
  const names = components.map((component) => component.name);
  const seenNames = new Set();
  names.forEach((name, index) => {
    validateAsciiId(name, `components[${index}].name`, errors);
    if (seenNames.has(name)) {
      issue(errors, 'DUPLICATE_COMPONENT_NAME', `components[${index}].name`, 'identity frame component names must be unique');
    }
    seenNames.add(name);
  });
  validateExactKeys(termsByName, names, 'termsByName', errors, 'IDENTITY_TERM_COVERAGE_MISMATCH');
  if (errors.length) throw new IdentityContractError(errors);
  const chunks = [Buffer.from(TAGS.identityKey, 'utf8'), u64be(components.length)];
  for (const component of components) {
    const nameBytes = Buffer.from(component.name, 'utf8');
    const term = termsByName[component.name];
    if (typeof term !== 'string'
        || term.length === 0
        || term !== term.normalize('NFC')
        || !isCanonicalRdfTermShape(term)) {
      throw new IdentityContractError([{
        code: 'INVALID_CANONICAL_RDF_TERM',
        path: `termsByName.${component.name}`,
        message: 'expected an explicit canonical non-blank N-Triples IRI, typed literal, or language literal',
      }]);
    }
    const termBytes = Buffer.from(term, 'utf8');
    chunks.push(u64be(nameBytes.length), nameBytes, u64be(termBytes.length), termBytes);
  }
  return Buffer.concat(chunks);
}

function isCanonicalRdfTermShape(term) {
  if (/[\r\n]/u.test(term) || term.startsWith('_:')) return false;
  const iriMatch = /^<([^<>\\]*)>$/u.exec(term);
  if (iriMatch) {
    const iriErrors = [];
    return validateAbsoluteIri(iriMatch[1], 'canonicalRdfTerm', iriErrors) && iriErrors.length === 0;
  }
  const literalMatch =
    /^"(?:[^"\\\r\n]|\\["\\bfnrt]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8})*"(?:(@[a-z]{2,8}(?:-[a-z0-9]{1,8})*)|\^\^<([^<>\\]*)>)$/u.exec(term);
  if (!literalMatch) return false;
  if (literalMatch[1]) return LOWER_BCP47_RE.test(literalMatch[1].slice(1));
  const iriErrors = [];
  return validateAbsoluteIri(literalMatch[2], 'canonicalRdfTerm.datatype', iriErrors) && iriErrors.length === 0;
}

function identityKeyDigest(components, termsByName) {
  return crypto.createHash('sha256').update(frameIdentityKey(components, termsByName)).digest();
}

function buildIdentityIris(contract, logicalTerms, versionTerms) {
  const errors = [];
  validateAbsoluteIri(contract && contract.identityBaseIri, 'contract.identityBaseIri', errors, { noTrailingSlash: true });
  if (errors.length) throw new IdentityContractError(errors);
  const logicalHex = identityKeyDigest(contract.logicalComponents, logicalTerms).toString('hex');
  const logicalIri = `${contract.identityBaseIri}/sha256-${logicalHex}`;
  if (contract.versionComponents.length === 0) {
    if (versionTerms !== undefined && isPlainObject(versionTerms) && Object.keys(versionTerms).length !== 0) {
      throw new IdentityContractError([{
        code: 'VERSION_IRI_FORBIDDEN',
        path: 'versionTerms',
        message: 'an empty version-component list forbids version terms and a version IRI',
      }]);
    }
    return { logicalIri, versionIri: null };
  }
  const versionHex = identityKeyDigest(contract.versionComponents, versionTerms).toString('hex');
  return {
    logicalIri,
    versionIri: `${logicalIri}/version/sha256-${versionHex}`,
  };
}

module.exports = {
  IdentityContractError,
  TAGS,
  artifactDigest,
  buildIdentityIris,
  canonicalJcs,
  compileIdentityContracts,
  frameIdentityKey,
  identityKeyDigest,
  taggedJcsDigest,
  validateCompilationInput,
  validateIdentityManifest,
};
