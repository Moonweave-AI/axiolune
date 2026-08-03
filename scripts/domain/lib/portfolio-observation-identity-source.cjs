'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  IdentityContractError,
  TAGS,
  artifactDigest,
  compileIdentityContracts,
  taggedJcsDigest,
} = require('./identity-contract-compiler.cjs');

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const NS = 'https://axiolune.ai/mapping/finance/v0.3.0/portfolio-positions/observation-identity/';
const P = 'https://axiolune.ai/ontology/finance/portfolio-positions/';
const F = 'https://axiolune.ai/ontology/finance/foundation/';
const META_PATTERN = 'https://axiolune.ai/ontology/meta/patterns/';
const META_BINDING_ATTRIBUTES = 'https://axiolune.ai/ontology/meta/data-binding/attributes/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const GENERATING_CONTEXT_ATTRIBUTE = META_BINDING_ATTRIBUTES + 'generatingContextRef';
const PROVENANCED_FACT = META_PATTERN + 'ProvenancedFact';
const TEMPORAL_FACT = META_PATTERN + 'TemporalFact';

const SOURCE_COMPILATION_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'mappings/finance/v0.3.0/portfolio-positions/identity/portfolio-observation-identity-compilation.json',
});
const SOURCE_REGISTRY_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'mappings/finance/v0.3.0/portfolio-positions/identity/portfolio-observation-identity-term-registry.json',
});
const NORMALIZATION_IMPLEMENTATION_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'mappings/finance/v0.3.0/portfolio-positions/identity/normalization-implementation.cjs',
});
const NORMALIZATION_SPECIFICATION_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'mappings/finance/v0.3.0/portfolio-positions/identity/normalization-contract.json',
});
const NORMALIZATION_VECTORS_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'mappings/finance/v0.3.0/portfolio-positions/identity/normalization-vectors.json',
});

const TARGETS = Object.freeze({
  externalBasis: `${P}ExternalCostBasisObservation`,
  finding: `${P}PortfolioPositionReconciliationFinding`,
  position: `${P}PositionSnapshot`,
  stream: `${P}PortfolioObservationStream`,
});

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
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

function mappingIssue(errors, code, issuePath, message) {
  errors.push({ code, path: issuePath, message });
}

function readYaml(root, relativePath, label) {
  const absolute = path.resolve(root, ...relativePath.split('/'));
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(label + ' is missing: ' + relativePath);
  }
  return YAML.parse(fs.readFileSync(absolute, 'utf8'));
}

function collectSchemaDefinitions(dataBinding) {
  const definitions = new Map();
  for (const [name, definition] of Object.entries(dataBinding)) {
    if (!isPlainObject(definition)) continue;
    definitions.set(name, definition);
    for (const [structureName, structure] of Object.entries(definition.structures || {})) {
      if (definitions.has(structureName)) {
        throw new Error('duplicate current-M3 structure name: ' + structureName);
      }
      definitions.set(structureName, structure);
    }
  }
  return definitions;
}

function schemaFields(definition) {
  if (isPlainObject(definition.requiredFields)
      || isPlainObject(definition.optionalFields)) {
    const required = isPlainObject(definition.requiredFields)
      ? definition.requiredFields
      : {};
    const optional = isPlainObject(definition.optionalFields)
      ? definition.optionalFields
      : {};
    return {
      descriptors: { ...required, ...optional },
      required: new Set(Object.keys(required)),
    };
  }
  const fields = isPlainObject(definition.fields)
    ? definition.fields
    : Object.fromEntries(Object.entries(definition).filter(([, descriptor]) => (
      isPlainObject(descriptor) && typeof descriptor.type === 'string'
    )));
  return {
    descriptors: fields,
    required: new Set(Object.entries(fields)
      .filter(([, descriptor]) => descriptor.required === true || descriptor.type === 'literal')
      .map(([name]) => name)),
  };
}

function validateM3Uri(value, valuePath, errors) {
  if (typeof value !== 'string' || value.length === 0) {
    mappingIssue(errors, 'M3_INVALID_URI', valuePath, 'expected an absolute IRI string');
    return;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol) throw new Error('missing protocol');
  } catch {
    mappingIssue(errors, 'M3_INVALID_URI', valuePath, 'expected an absolute IRI string');
  }
}

function validateM3Descriptor(value, descriptor, valuePath, errors, definitions) {
  const declaredType = typeof descriptor.type === 'string'
    ? descriptor.type.replaceAll(' ', '')
    : null;
  if (value === null
      && typeof descriptor.description === 'string'
      && descriptor.description.includes('null means')) {
    return;
  }
  if (declaredType === 'any') return;
  if (declaredType === 'uri') {
    validateM3Uri(value, valuePath, errors);
    return;
  }
  if (declaredType === 'string') {
    if (typeof value !== 'string') {
      mappingIssue(errors, 'M3_INVALID_TYPE', valuePath, 'expected string');
    }
    return;
  }
  if (declaredType === 'integer') {
    if (!Number.isSafeInteger(value)) {
      mappingIssue(errors, 'M3_INVALID_TYPE', valuePath, 'expected safe integer');
    }
    return;
  }
  if (declaredType === 'instant') {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
      mappingIssue(errors, 'M3_INVALID_TYPE', valuePath, 'expected ISO instant');
    }
    return;
  }
  if (declaredType === 'boolean') {
    if (typeof value !== 'boolean') {
      mappingIssue(errors, 'M3_INVALID_TYPE', valuePath, 'expected boolean');
    }
    return;
  }
  if (declaredType === 'decimal') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      mappingIssue(errors, 'M3_INVALID_TYPE', valuePath, 'expected finite decimal');
    }
    return;
  }
  if (declaredType === 'enum') {
    if (!Array.isArray(descriptor.values) || !descriptor.values.includes(value)) {
      mappingIssue(
        errors,
        'M3_INVALID_ENUM',
        valuePath,
        'expected one of current M3 values: ' + (descriptor.values || []).join(', '),
      );
    }
    return;
  }
  if (declaredType === 'literal') {
    if (value !== descriptor.value) {
      mappingIssue(
        errors,
        'M3_INVALID_ENUM',
        valuePath,
        'expected current M3 literal ' + String(descriptor.value),
      );
    }
    return;
  }
  const listMatch = /^list\[(.+)\]$/u.exec(declaredType || '');
  if (listMatch) {
    if (!Array.isArray(value)) {
      mappingIssue(errors, 'M3_INVALID_TYPE', valuePath, 'expected list');
      return;
    }
    if (Number.isSafeInteger(descriptor.minCount) && value.length < descriptor.minCount) {
      mappingIssue(
        errors,
        'M3_MIN_COUNT',
        valuePath,
        'expected at least ' + descriptor.minCount + ' values',
      );
    }
    value.forEach((entry, index) => validateM3Descriptor(
      entry,
      { type: listMatch[1] },
      valuePath + '[' + index + ']',
      errors,
      definitions,
    ));
    return;
  }
  const mapMatch = /^map\[string,(.+)\]$/u.exec(declaredType || '');
  if (mapMatch) {
    if (!isPlainObject(value)) {
      mappingIssue(errors, 'M3_INVALID_TYPE', valuePath, 'expected string-keyed map');
      return;
    }
    for (const [name, entry] of Object.entries(value)) {
      validateM3Descriptor(
        entry,
        { type: mapMatch[1] },
        valuePath + '.' + name,
        errors,
        definitions,
      );
    }
    return;
  }
  const definition = definitions.get(declaredType);
  if (!definition) {
    mappingIssue(
      errors,
      'M3_UNKNOWN_SCHEMA_TYPE',
      valuePath,
      'current M3 does not define type ' + String(declaredType),
    );
    return;
  }
  validateM3Object(value, definition, valuePath, errors, definitions);
}

function validateM3ClosedObject(value, definition, valuePath, errors, definitions) {
  if (!isPlainObject(value)) {
    mappingIssue(errors, 'M3_INVALID_OBJECT', valuePath, 'expected a closed M3 object');
    return;
  }
  const { descriptors, required } = schemaFields(definition);
  for (const name of Object.keys(value)) {
    if (!own(descriptors, name)) {
      mappingIssue(errors, 'M3_UNKNOWN_FIELD', valuePath + '.' + name, 'unknown current-M3 field');
    }
  }
  for (const name of required) {
    if (!own(value, name)) {
      mappingIssue(errors, 'M3_MISSING_FIELD', valuePath + '.' + name, 'missing required M3 field');
    }
  }
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (own(value, name)) {
      validateM3Descriptor(
        value[name],
        descriptor,
        valuePath + '.' + name,
        errors,
        definitions,
      );
    }
  }
}

function validateM3Object(value, definition, valuePath, errors, definitions) {
  if (!isPlainObject(value)) {
    mappingIssue(errors, 'M3_INVALID_OBJECT', valuePath, 'expected a closed M3 object');
    return;
  }
  if (typeof definition.discriminator === 'string'
      && isPlainObject(definition.variants)) {
    const discriminator = definition.discriminator;
    if (!own(value, discriminator)) {
      mappingIssue(
        errors,
        'M3_MISSING_FIELD',
        valuePath + '.' + discriminator,
        'missing M3 union discriminator',
      );
      return;
    }
    const variant = Object.values(definition.variants).find((candidate) => (
      candidate?.fields?.[discriminator]?.value === value[discriminator]
    ));
    if (!variant) {
      mappingIssue(
        errors,
        'M3_INVALID_ENUM',
        valuePath + '.' + discriminator,
        'unknown current-M3 union variant',
      );
      return;
    }
    validateM3ClosedObject(value, variant, valuePath, errors, definitions);
    return;
  }
  validateM3ClosedObject(value, definition, valuePath, errors, definitions);
}

function validateBindingAliases(binding, aliases, bindingPath, errors) {
  if (!isPlainObject(binding)) return;
  if (binding.bindingType === 'directField') {
    const alias = binding.source?.dataset;
    if (typeof alias === 'string' && !aliases.has(alias)) {
      mappingIssue(
        errors,
        'M3_UNKNOWN_SOURCE_ALIAS',
        bindingPath + '.source.dataset',
        'direct field uses an alias outside SourceBinding.datasets',
      );
    }
    return;
  }
  if (binding.bindingType === 'transformation') {
    for (const [name, child] of Object.entries(binding.inputs || {})) {
      validateBindingAliases(child, aliases, bindingPath + '.inputs.' + name, errors);
    }
    return;
  }
  if (binding.bindingType === 'referenceIdentity') {
    for (const [name, child] of Object.entries(binding.keyBindings || {})) {
      validateBindingAliases(child, aliases, bindingPath + '.keyBindings.' + name, errors);
    }
  }
}

function targetSlotKey(target) {
  if (target?.slotType === 'attribute') return 'attribute:' + target.targetAttribute;
  if (target?.slotType === 'participantRole') {
    return 'participantRole:' + target.targetAssociation + ':' + target.targetRole;
  }
  if (target?.slotType === 'relation') return 'relation:' + target.targetRelation;
  if (target?.slotType === 'patternField') {
    return 'patternField:' + target.targetPattern + ':' + target.targetField;
  }
  return null;
}

function localName(iri) {
  const splitAt = Math.max(iri.lastIndexOf('/'), iri.lastIndexOf('#'));
  return splitAt >= 0 ? iri.slice(splitAt + 1) : iri;
}

function loadPortfolioMappingSchema(root) {
  const dataBindingDocument = readYaml(
    root,
    'ontology/meta/data-binding-meta-model.yaml',
    'current M3 data-binding schema',
  );
  const moduleDocument = readYaml(
    root,
    'ontology/domain/finance/portfolio-positions/module.yaml',
    'current Portfolio/Positions module',
  );
  const patternDocument = readYaml(
    root,
    'ontology/meta/cross-domain-patterns.yaml',
    'current M3 cross-domain patterns',
  );
  if (!isPlainObject(dataBindingDocument.DataBinding)
      || !isPlainObject(moduleDocument.domain)
      || !Array.isArray(patternDocument.CrossDomainPatterns?.patterns)) {
    throw new Error('current M3 or Portfolio/Positions schema has an invalid root structure');
  }
  const definitions = collectSchemaDefinitions(dataBindingDocument.DataBinding);
  const mappingDefinition = definitions.get('SemanticMappingDefinition');
  if (!mappingDefinition) throw new Error('current M3 lacks SemanticMappingDefinition');
  const targetTypes = new Map();
  for (const [kind, collection] of [
    ['objectType', moduleDocument.domain.objectTypes],
    ['associationType', moduleDocument.domain.associationTypes],
  ]) {
    for (const definition of Object.values(collection || {})) {
      if (isPlainObject(definition) && typeof definition.iri === 'string') {
        targetTypes.set(definition.iri, { definition, kind });
      }
    }
  }
  const relations = new Map(Object.values(moduleDocument.domain.relationTypes || {})
    .filter((definition) => isPlainObject(definition) && typeof definition.iri === 'string')
    .map((definition) => [definition.iri, definition]));
  const patterns = new Map(patternDocument.CrossDomainPatterns.patterns
    .filter((definition) => isPlainObject(definition) && typeof definition.iri === 'string')
    .map((definition) => [definition.iri, definition]));
  return { definitions, mappingDefinition, patterns, relations, targetTypes };
}

function validateTargetSlotSemantics(target, mapping, targetState, schemaState, slotPath, errors) {
  const targetDefinition = targetState.definition;
  if (target?.slotType === 'attribute') {
    if (!(targetDefinition.attributeUses || [])
      .some((use) => use?.attribute === target.targetAttribute)) {
      mappingIssue(
        errors,
        'M3_TARGET_SLOT_NOT_APPLICABLE',
        slotPath,
        'attribute is not used by mapping target ' + mapping.targetType,
      );
    }
    return;
  }
  if (target?.slotType === 'participantRole') {
    if (targetState.kind !== 'associationType'
        || target.targetAssociation !== mapping.targetType
        || !(targetDefinition.participantRoles || [])
          .some((role) => role?.id === target.targetRole)) {
      mappingIssue(
        errors,
        'M3_TARGET_SLOT_NOT_APPLICABLE',
        slotPath,
        'participant role does not resolve on mapping target',
      );
    }
    return;
  }
  if (target?.slotType === 'relation') {
    const relation = schemaState.relations.get(target.targetRelation);
    if (!relation
        || relation.domain !== mapping.targetType
        || (own(target, 'targetObjectType') && relation.range !== target.targetObjectType)) {
      mappingIssue(
        errors,
        'M3_TARGET_SLOT_NOT_APPLICABLE',
        slotPath,
        'relation domain/range is incompatible with mapping target',
      );
    }
    return;
  }
  if (target?.slotType === 'patternField') {
    const pattern = schemaState.patterns.get(target.targetPattern);
    const bound = (targetDefinition.patternBindings || [])
      .some((binding) => binding?.pattern === target.targetPattern);
    const injected = (pattern?.injectedAttributes || [])
      .some((attribute) => (
        attribute?.attribute === target.targetField
        || localName(attribute?.attribute || '') === target.targetField
      ));
    if (!bound || !injected) {
      mappingIssue(
        errors,
        'M3_TARGET_SLOT_NOT_APPLICABLE',
        slotPath,
        'pattern field is not injected into mapping target',
      );
    }
  }
}

function validatePortfolioMappingSemantics(mapping, mappingPath, schemaState, errors) {
  const targetState = schemaState.targetTypes.get(mapping.targetType);
  if (!targetState) {
    mappingIssue(
      errors,
      'M3_UNKNOWN_TARGET_TYPE',
      mappingPath + '.targetType',
      'targetType is not defined by the current Portfolio/Positions module',
    );
    return;
  }
  const aliases = new Set(
    Array.isArray(mapping.source?.datasets)
      ? mapping.source.datasets
        .map((dataset) => dataset?.alias)
        .filter((alias) => typeof alias === 'string')
      : [],
  );
  const slots = Array.isArray(mapping.slotMappings) ? mapping.slotMappings : [];
  for (const [groupName, group] of [
    ['logicalKeyBindings', mapping.identity?.logicalKeyBindings],
    ['versionKeyBindings', mapping.identity?.versionKeyBindings],
  ]) {
    for (const [name, binding] of Object.entries(group || {})) {
      validateBindingAliases(
        binding,
        aliases,
        mappingPath + '.identity.' + groupName + '.' + name,
        errors,
      );
    }
  }
  for (const [index, slot] of slots.entries()) {
    validateBindingAliases(
      slot?.value,
      aliases,
      mappingPath + '.slotMappings[' + index + '].value',
      errors,
    );
    validateTargetSlotSemantics(
      slot?.target,
      mapping,
      targetState,
      schemaState,
      mappingPath + '.slotMappings[' + index + '].target',
      errors,
    );
  }
  for (const [axisName, axis] of [
    ['validTime', mapping.temporal?.validTime],
    ['knowledgeTime', mapping.temporal?.knowledgeTime],
    ['availabilityTime', mapping.temporal?.availabilityTime],
  ]) {
    validateBindingAliases(
      axis?.from,
      aliases,
      mappingPath + '.temporal.' + axisName + '.from',
      errors,
    );
    if (axis?.to !== undefined && axis.to !== null) {
      validateBindingAliases(
        axis.to,
        aliases,
        mappingPath + '.temporal.' + axisName + '.to',
        errors,
      );
    }
    if (axisName !== 'knowledgeTime' && own(axis || {}, 'closePolicy')) {
      mappingIssue(
        errors,
        'M3_TIME_AXIS_POLICY_SCOPE',
        mappingPath + '.temporal.' + axisName + '.closePolicy',
        'current M3 restricts closePolicy to knowledgeTime',
      );
    }
  }
  for (const [name, binding] of Object.entries(mapping.provenance || {})) {
    validateBindingAliases(
      binding,
      aliases,
      mappingPath + '.provenance.' + name,
      errors,
    );
  }

  const targetDefinition = targetState.definition;
  const boundPatterns = new Set((targetDefinition.patternBindings || [])
    .map((binding) => binding?.pattern));
  if (boundPatterns.has(TEMPORAL_FACT)) {
    if (mapping.temporal?.patternRef !== TEMPORAL_FACT) {
      mappingIssue(
        errors,
        'M3_TEMPORAL_PATTERN_NOT_BOUND',
        mappingPath + '.temporal.patternRef',
        'TemporalFact target requires the current TemporalFact mapping spec',
      );
    }
  }
  if (boundPatterns.has(PROVENANCED_FACT)
      && !own(mapping.provenance || {}, 'sourceSystem')) {
    mappingIssue(
      errors,
      'M3_PROVENANCE_SOURCE_MISSING',
      mappingPath + '.provenance.sourceSystem',
      'ProvenancedFact requires its mandatory source binding',
    );
  }

  const slotCounts = new Map();
  for (const slot of slots) {
    const key = targetSlotKey(slot?.target);
    if (key !== null) slotCounts.set(key, (slotCounts.get(key) || 0) + 1);
  }
  for (const use of targetDefinition.attributeUses || []) {
    const key = 'attribute:' + use.attribute;
    const count = slotCounts.get(key) || 0;
    if (Number.isSafeInteger(use.minCount) && count < use.minCount) {
      mappingIssue(
        errors,
        'M3_REQUIRED_SLOT_MISSING',
        mappingPath + '.slotMappings',
        'missing required target attribute slot ' + use.attribute,
      );
    }
    if (Number.isSafeInteger(use.maxCount) && count > use.maxCount) {
      mappingIssue(
        errors,
        'M3_SLOT_CARDINALITY',
        mappingPath + '.slotMappings',
        'too many mappings for target attribute ' + use.attribute,
      );
    }
  }
  for (const role of targetDefinition.participantRoles || []) {
    const key = 'participantRole:' + mapping.targetType + ':' + role.id;
    const count = slotCounts.get(key) || 0;
    if (Number.isSafeInteger(role.minCount) && count < role.minCount) {
      mappingIssue(
        errors,
        'M3_REQUIRED_SLOT_MISSING',
        mappingPath + '.slotMappings',
        'missing required participant role slot ' + role.id,
      );
    }
    if (Number.isSafeInteger(role.maxCount) && count > role.maxCount) {
      mappingIssue(
        errors,
        'M3_SLOT_CARDINALITY',
        mappingPath + '.slotMappings',
        'too many mappings for participant role ' + role.id,
      );
    }
  }

  const generatingContextUse = (targetDefinition.attributeUses || [])
    .find((use) => use?.attribute === GENERATING_CONTEXT_ATTRIBUTE);
  if (generatingContextUse) {
    const generatingSlots = slots.filter((slot) => (
      slot?.target?.slotType === 'attribute'
      && slot.target.targetAttribute === GENERATING_CONTEXT_ATTRIBUTE
    ));
    if (generatingSlots.length !== 1
        || generatingSlots[0].value?.bindingType !== 'runtimeContext'
        || generatingSlots[0].value.contextField !== 'iri') {
      mappingIssue(
        errors,
        'M3_GENERATING_CONTEXT_BINDING',
        mappingPath + '.slotMappings',
        'generatingContextRef must bind exactly runtimeContext.iri',
      );
    }
  }
}

function validatePortfolioObservationMappingCompilation(compilation, root) {
  const errors = [];
  const schemaState = loadPortfolioMappingSchema(root);
  if (!Array.isArray(compilation?.mappings)) {
    mappingIssue(errors, 'M3_INVALID_TYPE', 'compilation.mappings', 'expected mapping list');
  } else {
    compilation.mappings.forEach((mapping, index) => {
      const mappingPath = 'mappings[' + index + ']';
      validateM3Object(
        mapping,
        schemaState.mappingDefinition,
        mappingPath,
        errors,
        schemaState.definitions,
      );
      if (isPlainObject(mapping)) {
        validatePortfolioMappingSemantics(mapping, mappingPath, schemaState, errors);
      }
    });
  }
  if (errors.length > 0) throw new IdentityContractError(errors);
  return true;
}

function compilePortfolioObservationIdentitySource(compilation, root) {
  validatePortfolioObservationMappingCompilation(compilation, root);
  return compileIdentityContracts(compilation);
}

function refDigest(root, ref) {
  const absolute = path.resolve(root, ...ref.path.split('/'));
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`portfolio identity dependency is missing: ${ref.path}`);
  }
  return artifactDigest(fs.readFileSync(absolute));
}

function termDefinition(suffix, label, definition, termContract) {
  const value = {
    definition,
    iri: `${NS}term-contract/${suffix}`,
    label,
    termContract,
  };
  return {
    definition: value,
    termContractDigest: taggedJcsDigest(TAGS.termContract, value),
    termContractRef: value.iri,
  };
}

function buildPortfolioObservationIdentitySource(root) {
  const terms = [
    termDefinition(
      'date-time-stamp',
      'UTC date-time stamp',
      'Canonical xsd:dateTimeStamp identity term.',
      { datatypeIri: `${XSD}dateTimeStamp`, termKind: 'literal' },
    ),
    termDefinition(
      'non-negative-integer',
      'Non-negative revision',
      'Canonical xsd:nonNegativeInteger identity term.',
      { datatypeIri: `${XSD}nonNegativeInteger`, termKind: 'literal' },
    ),
    termDefinition(
      'party-logical',
      'Party logical identity',
      'Canonical logical Party IRI.',
      { expectedTargetType: `${F}Party`, referenceMode: 'logical', termKind: 'iri' },
    ),
    termDefinition(
      'portfolio-observation-stream-logical',
      'PortfolioObservationStream logical identity',
      'Canonical logical portfolio observation stream IRI.',
      { expectedTargetType: TARGETS.stream, referenceMode: 'logical', termKind: 'iri' },
    ),
    termDefinition(
      'sha256-digest',
      'SHA-256 digest lexical value',
      'Canonical lowercase SHA-256 digest lexical value.',
      { datatypeIri: `${XSD}string`, termKind: 'literal' },
    ),
    termDefinition(
      'string',
      'NFC string',
      'Canonical non-empty NFC xsd:string identity term.',
      { datatypeIri: `${XSD}string`, termKind: 'literal' },
    ),
    termDefinition(
      'uri',
      'Absolute URI literal',
      'Canonical absolute xsd:anyURI identity term.',
      { datatypeIri: `${XSD}anyURI`, termKind: 'literal' },
    ),
  ].sort((left, right) => compareUtf8(left.termContractRef, right.termContractRef));
  const registry = {
    controlledSets: [],
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
    termContracts: terms,
  };
  const registryDigest = taggedJcsDigest(TAGS.termRegistry, registry);
  const termBySuffix = new Map(
    terms.map((term) => [term.termContractRef.split('/').at(-1), term]),
  );
  const implementationDigest = refDigest(root, NORMALIZATION_IMPLEMENTATION_REF);
  const specificationDigest = refDigest(root, NORMALIZATION_SPECIFICATION_REF);
  const testVectorsDigest = refDigest(root, NORMALIZATION_VECTORS_REF);
  const normalizationRules = [...termBySuffix.entries()].map(([suffix, term]) => ({
    algorithmId: `portfolio_identity_${suffix.replaceAll('-', '_')}`,
    algorithmVersion: '1.0.0',
    definition: `Deterministic ${suffix} normalization for Portfolio identity.`,
    implementationDigest,
    implementationRef: NORMALIZATION_IMPLEMENTATION_REF,
    inputTermContractDigest: term.termContractDigest,
    inputTermContractRef: term.termContractRef,
    iri: `${NS}normalization/${suffix}`,
    label: `Portfolio ${suffix} normalization`,
    outputTermContractDigest: term.termContractDigest,
    outputTermContractRef: term.termContractRef,
    specificationDigest,
    specificationRef: NORMALIZATION_SPECIFICATION_REF,
    testVectorsDigest,
    testVectorsRef: NORMALIZATION_VECTORS_REF,
  })).sort((left, right) => compareUtf8(left.iri, right.iri));
  const ruleBySuffix = new Map(
    normalizationRules.map((rule) => [rule.iri.split('/').at(-1), rule]),
  );

  function component(name, semanticValue, suffix) {
    const term = termBySuffix.get(suffix);
    const rule = ruleBySuffix.get(suffix);
    if (!term || !rule) throw new Error(`unknown Portfolio identity term ${suffix}`);
    return {
      name,
      normalizationRuleDigest: taggedJcsDigest(TAGS.normalizationRule, rule),
      normalizationRuleRef: rule.iri,
      semanticValue,
      termContractDigest: term.termContractDigest,
      termContractRef: term.termContractRef,
    };
  }

  function versionComponents(targetType) {
    return [
      component('validFrom', {
        containingType: targetType,
        fieldRef: `${META_PATTERN}attributes/validFrom`,
        patternRef: `${META_PATTERN}TemporalFact`,
        valueKind: 'patternField',
      }, 'date-time-stamp'),
      component('knowledgeFrom', {
        containingType: targetType,
        fieldRef: `${META_PATTERN}attributes/knowledgeFrom`,
        patternRef: `${META_PATTERN}TemporalFact`,
        valueKind: 'patternField',
      }, 'date-time-stamp'),
      component('availableFrom', {
        containingType: targetType,
        fieldRef: `${META_PATTERN}attributes/availableFrom`,
        patternRef: `${META_PATTERN}TemporalFact`,
        valueKind: 'patternField',
      }, 'date-time-stamp'),
      component('revision', {
        containingType: targetType,
        fieldRef: `${META_PATTERN}attributes/revision`,
        patternRef: `${META_PATTERN}TemporalFact`,
        valueKind: 'patternField',
      }, 'non-negative-integer'),
    ];
  }

  const contracts = [
    {
      definition: 'Logical identity is the provider logical IRI, immutable source-contract reference, and provider-scoped stream identifier.',
      identityBaseIri: 'https://axiolune.ai/data/finance/portfolio-positions/observation-stream',
      iri: `${NS}identity-contract/portfolio-observation-stream`,
      label: 'PortfolioObservationStream identity contract',
      logicalComponents: [
        component('providerLogicalIri', {
          objectType: `${F}Party`,
          relationRef: `${P}portfolioObservationStreamProvider`,
          subjectType: TARGETS.stream,
          valueKind: 'relationUse',
        }, 'party-logical'),
        component('sourceContractRef', {
          attributeRef: `${P}portfolioObservationSourceContractRef`,
          containingType: TARGETS.stream,
          valueKind: 'attributeUse',
        }, 'uri'),
        component('providerStreamId', {
          attributeRef: `${P}portfolioObservationStreamId`,
          containingType: TARGETS.stream,
          valueKind: 'attributeUse',
        }, 'string'),
      ],
      targetType: TARGETS.stream,
      versionComponents: versionComponents(TARGETS.stream),
    },
    {
      definition: 'Logical identity is the typed PortfolioObservationStream logical IRI and source-scoped snapshot identifier; account, instrument, and optional listing are version content.',
      identityBaseIri: 'https://axiolune.ai/data/finance/portfolio-positions/position-snapshot',
      iri: `${NS}identity-contract/position-snapshot`,
      label: 'PositionSnapshot identity contract',
      logicalComponents: [
        component('observationStreamLogicalIri', {
          containingAssociation: TARGETS.position,
          effectivePredicate: `${TARGETS.position}/role/positionObservationStream`,
          roleId: 'positionObservationStream',
          valueKind: 'participantRole',
        }, 'portfolio-observation-stream-logical'),
        component('snapshotId', {
          attributeRef: `${P}snapshotId`,
          containingType: TARGETS.position,
          valueKind: 'attributeUse',
        }, 'string'),
      ],
      targetType: TARGETS.position,
      versionComponents: versionComponents(TARGETS.position),
    },
    {
      definition: 'Logical identity is the typed PortfolioObservationStream logical IRI and source-scoped external basis identifier; scope and optional listing are version content.',
      identityBaseIri: 'https://axiolune.ai/data/finance/portfolio-positions/external-cost-basis',
      iri: `${NS}identity-contract/external-cost-basis-observation`,
      label: 'ExternalCostBasisObservation identity contract',
      logicalComponents: [
        component('observationStreamLogicalIri', {
          containingAssociation: TARGETS.externalBasis,
          effectivePredicate: `${TARGETS.externalBasis}/role/externalBasisObservationStream`,
          roleId: 'externalBasisObservationStream',
          valueKind: 'participantRole',
        }, 'portfolio-observation-stream-logical'),
        component('externalBasisId', {
          attributeRef: `${P}externalBasisId`,
          containingType: TARGETS.externalBasis,
          valueKind: 'attributeUse',
        }, 'string'),
      ],
      targetType: TARGETS.externalBasis,
      versionComponents: versionComponents(TARGETS.externalBasis),
    },
    {
      definition: 'Logical identity is the exact reconciliation definition reference, PIT request reference, and digest-framed comparison subject.',
      identityBaseIri: 'https://axiolune.ai/data/finance/portfolio-positions/reconciliation-finding',
      iri: `${NS}identity-contract/portfolio-position-reconciliation-finding`,
      label: 'PortfolioPositionReconciliationFinding identity contract',
      logicalComponents: [
        component('reconciliationDefinitionRef', {
          attributeRef: `${P}reconciliationQueryDefinitionRef`,
          containingType: TARGETS.finding,
          valueKind: 'attributeUse',
        }, 'uri'),
        component('pitRequestRef', {
          attributeRef: `${META_BINDING_ATTRIBUTES}pitRequestRef`,
          containingType: TARGETS.finding,
          valueKind: 'attributeUse',
        }, 'uri'),
        component('reconciliationSubjectDigest', {
          attributeRef: `${P}reconciliationSubjectDigest`,
          containingType: TARGETS.finding,
          valueKind: 'attributeUse',
        }, 'sha256-digest'),
      ],
      targetType: TARGETS.finding,
      versionComponents: versionComponents(TARGETS.finding),
    },
  ].sort((left, right) => compareUtf8(left.iri, right.iri));
  const contractByTarget = new Map(contracts.map((contract) => [contract.targetType, contract]));
  const direct = (field) => ({
    bindingType: 'directField',
    source: { dataset: 'row', field },
  });
  const directAttribute = (targetAttribute, field) => ({
    target: { slotType: 'attribute', targetAttribute },
    value: direct(field),
  });
  const directParticipantRole = (targetAssociation, targetRole, field) => ({
    target: { slotType: 'participantRole', targetAssociation, targetRole },
    value: direct(field),
  });
  const runtimeGeneratingContext = () => ({
    target: {
      slotType: 'attribute',
      targetAttribute: GENERATING_CONTEXT_ATTRIBUTE,
    },
    value: { bindingType: 'runtimeContext', contextField: 'iri' },
  });
  const source = {
    datasets: [{
      alias: 'row',
      dataset: 'https://axiolune.ai/source/portfolio-observation-release',
    }],
  };
  const temporal = {
    availabilityTime: { from: direct('availableFrom') },
    knowledgeTime: { closePolicy: 'explicitOnly', from: direct('knowledgeFrom') },
    patternRef: TEMPORAL_FACT,
    validTime: { from: direct('validFrom') },
  };
  const versionKeyBindings = {
    availableFrom: direct('availableFrom'),
    knowledgeFrom: direct('knowledgeFrom'),
    revision: direct('revision'),
    validFrom: direct('validFrom'),
  };
  const provenance = {
    sourceSystem: direct('source'),
  };

  const mappingSpecs = [
    {
      id: 'portfolio-observation-stream',
      logicalKeyBindings: {
        providerLogicalIri: direct('providerLogicalIri'),
        providerStreamId: direct('providerStreamId'),
        sourceContractRef: direct('sourceContractRef'),
      },
      slotMappings: [
        { target: { slotType: 'relation', targetObjectType: `${F}Party`, targetRelation: `${P}portfolioObservationStreamProvider` }, value: direct('providerLogicalIri') },
        { target: { slotType: 'attribute', targetAttribute: `${P}portfolioObservationSourceContractRef` }, value: direct('sourceContractRef') },
        { target: { slotType: 'attribute', targetAttribute: `${P}portfolioObservationSourceContractDigest` }, value: direct('sourceContractDigest') },
        { target: { slotType: 'attribute', targetAttribute: `${P}portfolioObservationStreamId` }, value: direct('providerStreamId') },
        { target: { slotType: 'attribute', targetAttribute: `${P}portfolioObservationCompletenessContractRef` }, value: direct('completenessContractRef') },
        { target: { slotType: 'attribute', targetAttribute: `${P}portfolioObservationCompletenessContractDigest` }, value: direct('completenessContractDigest') },
        { target: { slotType: 'attribute', targetAttribute: `${P}portfolioObservationPaginationContractRef` }, value: direct('paginationContractRef') },
        { target: { slotType: 'attribute', targetAttribute: `${P}portfolioObservationPaginationContractDigest` }, value: direct('paginationContractDigest') },
        directAttribute(META_BINDING_ATTRIBUTES + 'sourceArtifactRef', 'sourceArtifactRef'),
        directAttribute(META_BINDING_ATTRIBUTES + 'sourceArtifactDigest', 'sourceArtifactDigest'),
        directAttribute(META_BINDING_ATTRIBUTES + 'sourceLocator', 'sourceLocator'),
      ],
      targetType: TARGETS.stream,
    },
    {
      id: 'position-snapshot',
      logicalKeyBindings: {
        observationStreamLogicalIri: direct('observationStreamLogicalIri'),
        snapshotId: direct('snapshotId'),
      },
      slotMappings: [
        { target: { slotType: 'participantRole', targetAssociation: TARGETS.position, targetRole: 'positionObservationStream' }, value: direct('observationStreamLogicalIri') },
        { target: { slotType: 'participantRole', targetAssociation: TARGETS.position, targetRole: 'positionAccount' }, value: direct('accountLogicalIri') },
        { target: { slotType: 'participantRole', targetAssociation: TARGETS.position, targetRole: 'positionInstrument' }, value: direct('instrumentLogicalIri') },
        { target: { slotType: 'participantRole', targetAssociation: TARGETS.position, targetRole: 'positionListing' }, value: direct('listingVersionIri') },
        { target: { slotType: 'attribute', targetAttribute: `${P}snapshotId` }, value: direct('snapshotId') },
        directAttribute(P + 'positionQuantity', 'positionQuantity'),
        directAttribute(P + 'positionSourceKind', 'positionSourceKind'),
        directAttribute(META_BINDING_ATTRIBUTES + 'sourceArtifactRef', 'sourceArtifactRef'),
        directAttribute(META_BINDING_ATTRIBUTES + 'sourceArtifactDigest', 'sourceArtifactDigest'),
        directAttribute(META_BINDING_ATTRIBUTES + 'sourceLocator', 'sourceLocator'),
        runtimeGeneratingContext(),
      ],
      targetType: TARGETS.position,
    },
    {
      id: 'external-cost-basis-observation',
      logicalKeyBindings: {
        externalBasisId: direct('externalBasisId'),
        observationStreamLogicalIri: direct('observationStreamLogicalIri'),
      },
      slotMappings: [
        { target: { slotType: 'participantRole', targetAssociation: TARGETS.externalBasis, targetRole: 'externalBasisObservationStream' }, value: direct('observationStreamLogicalIri') },
        { target: { slotType: 'participantRole', targetAssociation: TARGETS.externalBasis, targetRole: 'externalBasisAccount' }, value: direct('accountLogicalIri') },
        { target: { slotType: 'participantRole', targetAssociation: TARGETS.externalBasis, targetRole: 'externalBasisInstrument' }, value: direct('instrumentLogicalIri') },
        { target: { slotType: 'participantRole', targetAssociation: TARGETS.externalBasis, targetRole: 'externalBasisListing' }, value: direct('listingVersionIri') },
        directParticipantRole(TARGETS.externalBasis, 'externalBasisDefinition', 'externalBasisDefinition'),
        { target: { slotType: 'attribute', targetAttribute: `${P}externalBasisId` }, value: direct('externalBasisId') },
        directAttribute(P + 'externalCostBasis', 'externalCostBasis'),
        directAttribute(META_BINDING_ATTRIBUTES + 'sourceArtifactRef', 'sourceArtifactRef'),
        directAttribute(META_BINDING_ATTRIBUTES + 'sourceArtifactDigest', 'sourceArtifactDigest'),
        directAttribute(META_BINDING_ATTRIBUTES + 'sourceLocator', 'sourceLocator'),
        runtimeGeneratingContext(),
      ],
      targetType: TARGETS.externalBasis,
    },
    {
      id: 'portfolio-position-reconciliation-finding',
      logicalKeyBindings: {
        pitRequestRef: direct('pitRequestRef'),
        reconciliationDefinitionRef: direct('reconciliationQueryDefinitionRef'),
        reconciliationSubjectDigest: direct('reconciliationSubjectDigest'),
      },
      slotMappings: [
        directParticipantRole(TARGETS.finding, 'comparedExternalSnapshot', 'comparedExternalSnapshot'),
        directParticipantRole(
          TARGETS.finding,
          'comparedExternalPositionSnapshot',
          'comparedExternalPositionSnapshot',
        ),
        directParticipantRole(TARGETS.finding, 'comparedDerivedSnapshot', 'comparedDerivedSnapshot'),
        directParticipantRole(TARGETS.finding, 'comparedExternalBasis', 'comparedExternalBasis'),
        directParticipantRole(TARGETS.finding, 'comparedLotStateClosure', 'comparedLotStateClosure'),
        directAttribute(P + 'portfolioReconciliationKind', 'portfolioReconciliationKind'),
        directAttribute(P + 'reconciliationSubjectDigest', 'reconciliationSubjectDigest'),
        directAttribute(
          P + 'reconciliationExternalCandidateCount',
          'reconciliationExternalCandidateCount',
        ),
        directAttribute(
          P + 'reconciliationExternalCandidateVersionSetDigest',
          'reconciliationExternalCandidateVersionSetDigest',
        ),
        directAttribute(
          P + 'reconciliationDerivedCandidateCount',
          'reconciliationDerivedCandidateCount',
        ),
        directAttribute(
          P + 'reconciliationDerivedCandidateVersionSetDigest',
          'reconciliationDerivedCandidateVersionSetDigest',
        ),
        directAttribute(
          P + 'reconciliationExternalSourceScopeRef',
          'reconciliationExternalSourceScopeRef',
        ),
        directAttribute(
          P + 'reconciliationDerivedSourceScopeRef',
          'reconciliationDerivedSourceScopeRef',
        ),
        directAttribute(
          P + 'reconciliationCandidateGraphRecordCount',
          'reconciliationCandidateGraphRecordCount',
        ),
        directAttribute(P + 'reconciliationCandidateGraphRef', 'reconciliationCandidateGraphRef'),
        directAttribute(
          P + 'reconciliationCandidateGraphDigest',
          'reconciliationCandidateGraphDigest',
        ),
        directAttribute(
          P + 'reconciliationExternalSnapshotManifestRef',
          'reconciliationExternalSnapshotManifestRef',
        ),
        directAttribute(
          P + 'reconciliationExternalSnapshotManifestDigest',
          'reconciliationExternalSnapshotManifestDigest',
        ),
        directAttribute(
          P + 'reconciliationDerivedOutputManifestRef',
          'reconciliationDerivedOutputManifestRef',
        ),
        directAttribute(
          P + 'reconciliationDerivedOutputManifestDigest',
          'reconciliationDerivedOutputManifestDigest',
        ),
        directAttribute(P + 'reconciliationQueryDefinitionRef', 'reconciliationQueryDefinitionRef'),
        directAttribute(
          P + 'reconciliationQueryDefinitionDigest',
          'reconciliationQueryDefinitionDigest',
        ),
        directAttribute(
          P + 'reconciliationQueryToolLockRef',
          'reconciliationQueryToolLockRef',
        ),
        directAttribute(
          P + 'reconciliationQueryToolLockDigest',
          'reconciliationQueryToolLockDigest',
        ),
        directAttribute(P + 'reconciliationClosureProbeRef', 'reconciliationClosureProbeRef'),
        directAttribute(
          P + 'reconciliationClosureProbeDigest',
          'reconciliationClosureProbeDigest',
        ),
        directAttribute(P + 'reconciliationContextRef', 'reconciliationContextRef'),
        directAttribute(P + 'reconciliationContextDigest', 'reconciliationContextDigest'),
        directAttribute(META_BINDING_ATTRIBUTES + 'pitRequestRef', 'pitRequestRef'),
        directAttribute(
          META_BINDING_ATTRIBUTES + 'pitRequestRecordDigest',
          'pitRequestRecordDigest',
        ),
        directAttribute(META_BINDING_ATTRIBUTES + 'inputContextRef', 'inputContextRef'),
        directAttribute(
          META_BINDING_ATTRIBUTES + 'inputContextRecordDigest',
          'inputContextRecordDigest',
        ),
        runtimeGeneratingContext(),
      ],
      targetType: TARGETS.finding,
    },
  ];
  const mappings = mappingSpecs.map((spec) => ({
    identity: {
      contractRef: contractByTarget.get(spec.targetType).iri,
      logicalKeyBindings: spec.logicalKeyBindings,
      versionKeyBindings,
    },
    iri: `${NS}mapping/${spec.id}`,
    label: `${spec.id} identity mapping`,
    mappingType: 'directTable',
    provenance,
    slotMappings: spec.slotMappings,
    source,
    targetType: spec.targetType,
    temporal,
  })).sort((left, right) => compareUtf8(left.iri, right.iri));

  const compilation = {
    concreteTargetTypes: Object.values(TARGETS).sort(compareUtf8),
    contracts,
    derivations: [],
    identityTermRegistry: registry,
    identityTermRegistryDigest: registryDigest,
    identityTermRegistryRef: SOURCE_REGISTRY_REF,
    mappings,
    normalizationRules,
    profileRef: PROFILE_REF,
  };
  const compiled = compilePortfolioObservationIdentitySource(compilation, root);
  return {
    compilation,
    manifest: compiled.manifest,
    registry,
  };
}

module.exports = {
  SOURCE_COMPILATION_REF,
  SOURCE_REGISTRY_REF,
  TARGETS,
  buildPortfolioObservationIdentitySource,
  compilePortfolioObservationIdentitySource,
  validatePortfolioObservationMappingCompilation,
};
