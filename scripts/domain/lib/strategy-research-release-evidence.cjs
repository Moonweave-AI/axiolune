'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const { isDecimalLexical } = require('./decimal-lexical.cjs');
const {
  TAGS,
  buildIdentityIris,
  canonicalJcs,
  compileIdentityContracts,
  identityKeyDigest,
  taggedJcsDigest,
  validateIdentityManifest,
} = require('./identity-contract-compiler.cjs');
const {
  BASE,
  MATERIALIZED_TARGETS,
  PATHS,
  PROFILE_REF,
  RELEASE_TARGETS,
  ROOT,
  artifact,
  buildFormulaClosure,
  buildNormalizationContract,
  buildNormalizationVectors,
  buildPitRequests,
  buildSourceSchema,
  compareUtf8,
  fileDigest,
  jcsBytes,
  jcsDigest,
  repositoryPath,
} = require('./strategy-research-v03-profile.cjs');
const {
  buildQuantityUnitRegistry,
  loadQuantityUnitRegistry,
  quantityUnitForApplication,
} = require('./strategy-research-quantity-units.cjs');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const ABSOLUTE_IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u;
const FORMULA_CLOSURE_TAG = 'axiolune-strategy-research-formula-closure-v1\0';

class StrategyResearchEvidenceError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'StrategyResearchEvidenceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StrategyResearchEvidenceError(code, message);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('CLOSED_SCHEMA', `${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('CLOSED_SCHEMA', `${label} fields actual=[${actual.join(',')}] expected=[${wanted.join(',')}]`);
  }
}

function readStrictJcs(file, label = repositoryPath(file)) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (cause) {
    fail('ARTIFACT_MISSING', `${label}: ${cause.message}`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    fail('JSON_PARSE', `${label}: ${cause.message}`);
  }
  if (!bytes.equals(jcsBytes(value))) fail('JCS_BYTES', `${label} is not exact UTF-8 RFC 8785 JCS`);
  return { bytes, value };
}

function requireDigest(value, label) {
  if (!DIGEST_RE.test(value || '')) fail('DIGEST_FORMAT', `${label} is not a lowercase SHA-256 digest`);
}

function requireIri(value, label) {
  if (!ABSOLUTE_IRI_RE.test(value || '')) fail('IRI_FORMAT', `${label} is not an absolute IRI`);
  try {
    if (new URL(value).href !== value) fail('IRI_FORMAT', `${label} is not canonical`);
  } catch {
    fail('IRI_FORMAT', `${label} is not canonical`);
  }
}

function resolveArtifactRef(ref, root = ROOT) {
  exactKeys(ref, ['kind', 'path', 'root'], 'ArtifactRef');
  if (ref.kind !== 'path' || ref.root !== 'sourceTree'
      || typeof ref.path !== 'string' || ref.path === ''
      || ref.path.includes('\\') || ref.path.startsWith('/') || ref.path.split('/').includes('..')) {
    fail('ARTIFACT_REF', 'only sourceTree POSIX-relative path ArtifactRefs are accepted by this profile');
  }
  const absolute = path.resolve(root, ...ref.path.split('/'));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!absolute.startsWith(prefix)) fail('ARTIFACT_REF', `reference escapes sourceTree: ${ref.path}`);
  return absolute;
}

function verifyRefDigest(ref, digest, root = ROOT, label = 'artifact') {
  requireDigest(digest, `${label}.digest`);
  const file = resolveArtifactRef(ref, root);
  if (fileDigest(file) !== digest) fail('ARTIFACT_DIGEST', `${label} byte digest mismatch for ${ref.path}`);
  return file;
}

function escapeLiteral(value) {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
    .replace(/\n/gu, '\\n').replace(/\r/gu, '\\r').replace(/\t/gu, '\\t');
}

function normalizeIdentityValue(value, termContract, algorithmId) {
  if (algorithmId === 'canonical_iri') {
    requireIri(value, 'identity IRI value');
    return `<${value}>`;
  }
  if (algorithmId === 'canonical_integer') {
    if (!Number.isSafeInteger(value)) fail('NORMALIZATION_INPUT', 'integer identity value must be a safe integer');
    return `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`;
  }
  if (algorithmId === 'canonical_date_time_stamp') {
    if (typeof value !== 'string' || !INSTANT_RE.test(value) || !Number.isFinite(Date.parse(value))) {
      fail('NORMALIZATION_INPUT', 'date-time identity value must be an explicit UTC instant');
    }
    return `"${value}"^^<http://www.w3.org/2001/XMLSchema#dateTimeStamp>`;
  }
  if (algorithmId === 'canonical_string') {
    if (typeof value !== 'string' || value === '' || value !== value.normalize('NFC')) {
      fail('NORMALIZATION_INPUT', 'string identity value must be non-empty NFC');
    }
    return `"${escapeLiteral(value)}"^^<http://www.w3.org/2001/XMLSchema#string>`;
  }
  fail('NORMALIZATION_ALGORITHM', `unbound normalization algorithm ${String(algorithmId)}`);
}

function verifyNormalization(mappingSet, root = ROOT) {
  const contractArtifact = readStrictJcs(path.resolve(root, repositoryPath(PATHS.normalizationContract)));
  const vectorsArtifact = readStrictJcs(path.resolve(root, repositoryPath(PATHS.normalizationVectors)));
  if (canonicalJcs(contractArtifact.value) !== canonicalJcs(buildNormalizationContract())) {
    fail('NORMALIZATION_CONTRACT', 'normalization contract differs from the executable profile');
  }
  if (canonicalJcs(vectorsArtifact.value) !== canonicalJcs(buildNormalizationVectors())) {
    fail('NORMALIZATION_VECTORS', 'normalization vectors differ from the executable profile');
  }
  const registryFile = path.resolve(root, repositoryPath(PATHS.identityRegistry));
  const registryArtifact = readStrictJcs(registryFile);
  if (canonicalJcs(registryArtifact.value) !== canonicalJcs(mappingSet.identityTermRegistry)) {
    fail('IDENTITY_REGISTRY_JOIN', 'external registry bytes differ from embedded mapping-set registry');
  }
  if (taggedJcsDigest(TAGS.termRegistry, registryArtifact.value) !== mappingSet.identityTermRegistryDigest) {
    fail('IDENTITY_REGISTRY_DIGEST', 'registry semantic digest mismatch');
  }
  const termIndex = new Map(mappingSet.identityTermRegistry.termContracts.map((row) => [row.termContractRef, row]));
  const ruleIndex = new Map(mappingSet.normalizationRules.map((row) => [row.iri, row]));
  for (const rule of mappingSet.normalizationRules) {
    verifyRefDigest(rule.specificationRef, rule.specificationDigest, root, `normalization(${rule.iri}).specification`);
    verifyRefDigest(rule.implementationRef, rule.implementationDigest, root, `normalization(${rule.iri}).implementation`);
    verifyRefDigest(rule.testVectorsRef, rule.testVectorsDigest, root, `normalization(${rule.iri}).vectors`);
    const term = termIndex.get(rule.outputTermContractRef);
    if (!term || term.termContractDigest !== rule.outputTermContractDigest
        || rule.inputTermContractRef !== rule.outputTermContractRef
        || rule.inputTermContractDigest !== rule.outputTermContractDigest) {
      fail('NORMALIZATION_TERM_JOIN', `normalization ${rule.iri} does not join one registered identity term`);
    }
  }
  for (const vector of vectorsArtifact.value.vectors) {
    const term = [...termIndex.values()].find((row) => algorithmForTermRow(row) === vector.algorithmId);
    if (!term) fail('NORMALIZATION_VECTOR', `no registered term exercises ${vector.algorithmId}`);
    if (normalizeIdentityValue(vector.input, term.definition.termContract, vector.algorithmId) !== vector.output) {
      fail('NORMALIZATION_VECTOR', `normalization vector failed for ${vector.algorithmId}`);
    }
  }
  return { ruleIndex, termIndex, vectorCount: vectorsArtifact.value.vectors.length };
}

function algorithmForTermRow(row) {
  const contract = row.definition.termContract;
  if (contract.termKind === 'iri') return 'canonical_iri';
  if (contract.datatypeIri?.endsWith('#integer')) return 'canonical_integer';
  if (contract.datatypeIri?.endsWith('#dateTimeStamp')) return 'canonical_date_time_stamp';
  return 'canonical_string';
}

function validateValueBinding(binding, aliases, schema, mappingRefs, label) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) fail('MAPPING_BINDING', `${label} must be a ValueBinding`);
  if (binding.bindingType === 'directField') {
    exactKeys(binding, ['bindingType', 'source'], label);
    exactKeys(binding.source, ['dataset', 'field'], `${label}.source`);
    if (!aliases.has(binding.source.dataset)) fail('MAPPING_DATASET', `${label} references an invisible dataset alias`);
    if (!Object.hasOwn(schema.datasets[binding.source.dataset].fields, binding.source.field)) {
      fail('MAPPING_FIELD', `${label} references unknown field ${binding.source.dataset}.${binding.source.field}`);
    }
    return;
  }
  if (binding.bindingType === 'referenceIdentity') {
    exactKeys(binding, ['bindingType', 'keyBindings', 'referenceMode', 'targetMappingRef'], label);
    if (!['logical', 'version'].includes(binding.referenceMode) || !mappingRefs.has(binding.targetMappingRef)) {
      fail('MAPPING_REFERENCE', `${label} has an unbound reference identity`);
    }
    exactKeys(binding.keyBindings, Object.keys(binding.keyBindings), `${label}.keyBindings`);
    for (const [name, child] of Object.entries(binding.keyBindings)) {
      validateValueBinding(child, aliases, schema, mappingRefs, `${label}.keyBindings.${name}`);
    }
    return;
  }
  if (binding.bindingType === 'literal') {
    exactKeys(binding, ['bindingType', 'value'], label);
    canonicalJcs(binding.value);
    return;
  }
  if (binding.bindingType === 'runtimeContext') {
    exactKeys(binding, ['bindingType', 'contextField'], label);
    if (!['iri', 'assertionTime', 'referenceTime', 'runId'].includes(binding.contextField)) {
      fail('MAPPING_RUNTIME_CONTEXT', `${label} uses an unsupported runtime context field`);
    }
    return;
  }
  fail('MAPPING_BINDING', `${label} uses forbidden/unimplemented binding branch ${String(binding.bindingType)}`);
}

function validateTargetSlot(target, moduleDocument, mappingTargetType, label) {
  const domain = moduleDocument.domain || {};
  if (target.slotType === 'attribute') {
    exactKeys(target, ['slotType', 'targetAttribute'], label);
    const locallyDefined = Object.values(domain.attributeTypes || {})
      .some((row) => row?.iri === target.targetAttribute);
    const importedAndUsed = [
      ...Object.values(domain.objectTypes || {}),
      ...Object.values(domain.associationTypes || {}),
    ].some((type) => type?.attributeUses?.some((use) => use.attribute === target.targetAttribute));
    if (!locallyDefined && !importedAndUsed) {
      fail('MAPPING_TARGET_SLOT', `${label} targets an unknown Strategy/Research attribute`);
    }
    return;
  }
  if (target.slotType === 'relation') {
    exactKeys(target, ['slotType', 'targetObjectType', 'targetRelation'], label);
    const relation = Object.values(domain.relationTypes || {}).find((row) => row?.iri === target.targetRelation);
    if (!relation || relation.range !== target.targetObjectType) {
      fail('MAPPING_TARGET_SLOT', `${label} relation/range does not resolve in the module`);
    }
    return;
  }
  if (target.slotType === 'participantRole') {
    exactKeys(target, ['slotType', 'targetAssociation', 'targetRole'], label);
    const association = Object.values(domain.associationTypes || {}).find((row) => row?.iri === target.targetAssociation);
    if (!association || !association.participantRoles?.some((row) => row.id === target.targetRole)) {
      fail('MAPPING_TARGET_SLOT', `${label} participant role does not resolve in the module`);
    }
    return;
  }
  if (target.slotType === 'patternField') {
    exactKeys(target, ['slotType', 'targetField', 'targetPattern'], label);
    const targetType = [
      ...Object.values(domain.objectTypes || {}),
      ...Object.values(domain.associationTypes || {}),
    ].find((type) => type?.iri === mappingTargetType);
    if (!targetType?.patternBindings?.some((row) => row.pattern === target.targetPattern)
        || target.targetPattern !== 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact'
        || target.targetField !== 'generatingContextRef') {
      fail('MAPPING_TARGET_SLOT', `${label} does not resolve one generatingContextRef field injected by ProvenancedFact`);
    }
    return;
  }
  fail('MAPPING_TARGET_SLOT', `${label} uses unsupported target slot ${String(target.slotType)}`);
}

function validateSourceSchema(schema, mappingSet) {
  exactKeys(schema, ['datasets', 'profileRef', 'schemaVersion'], 'source schema');
  if (schema.schemaVersion !== '1.0' || schema.profileRef !== PROFILE_REF) fail('SOURCE_SCHEMA', 'source schema identity mismatch');
  const expectedAliases = mappingSet.mappings.map((mapping) => mapping.source.datasets[0].alias).sort(compareUtf8);
  const actualAliases = Object.keys(schema.datasets).sort(compareUtf8);
  if (canonicalJcs(actualAliases) !== canonicalJcs(expectedAliases)) fail('SOURCE_SCHEMA', 'dataset aliases do not close the mapping inventory');
  for (const alias of actualAliases) {
    exactKeys(schema.datasets[alias], ['fields', 'primaryKey'], `source schema ${alias}`);
    if (!Array.isArray(schema.datasets[alias].primaryKey) || schema.datasets[alias].primaryKey.length === 0) {
      fail('SOURCE_SCHEMA', `${alias} primaryKey must be non-empty`);
    }
    for (const [field, kind] of Object.entries(schema.datasets[alias].fields)) {
      if (!/^[a-z][a-z0-9_]*$/u.test(field)
          || !['digest', 'instant', 'integer', 'iri', 'object', 'string'].includes(kind)) {
        fail('SOURCE_SCHEMA', `${alias}.${field} has an invalid field contract`);
      }
    }
  }
}

function validateMappingSet(mappingSet, sourceSchema, moduleDocument) {
  exactKeys(mappingSet, [
    'concreteTargetTypes', 'contracts', 'derivations', 'identityTermRegistry',
    'identityTermRegistryDigest', 'identityTermRegistryRef', 'mappings',
    'normalizationRules', 'profileRef',
  ], 'SemanticMappingDefinition artifact set');
  if (mappingSet.profileRef !== PROFILE_REF || mappingSet.derivations.length !== 0) {
    fail('MAPPING_PROFILE', 'mapping set profile/derivation contract mismatch');
  }
  if (canonicalJcs(mappingSet.concreteTargetTypes) !== canonicalJcs([...MATERIALIZED_TARGETS])) {
    fail('MAPPING_TARGET_CLOSURE', 'materialized target closure differs from the reviewed v0.3 inventory');
  }
  for (const target of RELEASE_TARGETS) {
    if (!mappingSet.concreteTargetTypes.includes(target)) fail('MAPPING_RELEASE_COVERAGE', `release target is unmapped: ${target}`);
  }
  const serialized = canonicalJcs(mappingSet);
  for (const forbidden of ['targetTypeIri', 'iriTemplate', 'fromTable', 'slotLocal', 'slotRole', 'runnerCapability']) {
    if (serialized.includes(`"${forbidden}"`)) fail('LEGACY_MAPPING_DIALECT', `legacy Slice-A field is forbidden: ${forbidden}`);
  }
  validateSourceSchema(sourceSchema, mappingSet);
  const mappingRefs = new Set(mappingSet.mappings.map((mapping) => mapping.iri));
  const mappingIris = mappingSet.mappings.map((mapping) => mapping.iri);
  if (mappingIris.some((value, index) => index > 0 && compareUtf8(mappingIris[index - 1], value) >= 0)) {
    fail('MAPPING_ORDER', 'mappings must be strictly IRI-byte sorted and unique');
  }
  for (const [index, mapping] of mappingSet.mappings.entries()) {
    exactKeys(mapping, ['identity', 'iri', 'label', 'mappingType', 'provenance', 'slotMappings', 'source', 'targetType', 'temporal'], `mapping[${index}]`);
    if (mapping.mappingType !== 'directTable' || !mappingSet.concreteTargetTypes.includes(mapping.targetType)) {
      fail('MAPPING_SCHEMA', `mapping[${index}] mappingType/targetType mismatch`);
    }
    exactKeys(mapping.source, ['datasets'], `mapping[${index}].source`);
    if (!Array.isArray(mapping.source.datasets) || mapping.source.datasets.length !== 1) fail('MAPPING_SOURCE', `mapping[${index}] requires exactly one dataset`);
    exactKeys(mapping.source.datasets[0], ['alias', 'dataset'], `mapping[${index}].source.datasets[0]`);
    const alias = mapping.source.datasets[0].alias;
    const aliases = new Set([alias]);
    requireIri(mapping.source.datasets[0].dataset, `mapping[${index}] source dataset IRI`);
    exactKeys(mapping.temporal, ['availabilityTime', 'knowledgeTime', 'patternRef', 'validTime'], `mapping[${index}].temporal`);
    if (mapping.temporal.patternRef !== 'https://axiolune.ai/ontology/meta/patterns/TemporalFact') fail('MAPPING_TEMPORAL', `mapping[${index}] temporal pattern mismatch`);
    exactKeys(mapping.temporal.validTime, ['from', 'to'], `mapping[${index}].validTime`);
    exactKeys(mapping.temporal.knowledgeTime, ['closePolicy', 'from'], `mapping[${index}].knowledgeTime`);
    exactKeys(mapping.temporal.availabilityTime, ['from'], `mapping[${index}].availabilityTime`);
    if (mapping.temporal.knowledgeTime.closePolicy !== 'closePreviousVersion') fail('MAPPING_TEMPORAL', `mapping[${index}] knowledge close policy mismatch`);
    for (const axis of ['validTime', 'knowledgeTime', 'availabilityTime']) {
      validateValueBinding(mapping.temporal[axis].from, aliases, sourceSchema, mappingRefs, `mapping[${index}].temporal.${axis}.from`);
      if (mapping.temporal[axis].to) validateValueBinding(mapping.temporal[axis].to, aliases, sourceSchema, mappingRefs, `mapping[${index}].temporal.${axis}.to`);
    }
    exactKeys(mapping.provenance, ['acquisitionTime', 'sourceSystem'], `mapping[${index}].provenance`);
    for (const [name, binding] of Object.entries(mapping.provenance)) {
      validateValueBinding(binding, aliases, sourceSchema, mappingRefs, `mapping[${index}].provenance.${name}`);
    }
    if (!Array.isArray(mapping.slotMappings) || mapping.slotMappings.length === 0) fail('MAPPING_SLOT_COVERAGE', `mapping[${index}] has no slot mappings`);
    for (const [slotIndex, slot] of mapping.slotMappings.entries()) {
      exactKeys(slot, ['target', 'value'], `mapping[${index}].slotMappings[${slotIndex}]`);
      validateTargetSlot(slot.target, moduleDocument, mapping.targetType, `mapping[${index}].slotMappings[${slotIndex}].target`);
      validateValueBinding(slot.value, aliases, sourceSchema, mappingRefs, `mapping[${index}].slotMappings[${slotIndex}].value`);
    }
    const generatingContextSlots = mapping.slotMappings.filter((slot) => (
      slot.target?.slotType === 'patternField'
      && slot.target.targetPattern === 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact'
      && slot.target.targetField === 'generatingContextRef'
    ));
    if (generatingContextSlots.length !== 1
        || generatingContextSlots[0].value?.bindingType !== 'runtimeContext'
        || generatingContextSlots[0].value.contextField !== 'iri') {
      fail(
        'MAPPING_GENERATING_CONTEXT',
        `mapping[${index}] must bind exactly one ProvenancedFact.generatingContextRef from runtimeContext.iri`,
      );
    }
  }
  let compilation;
  try {
    compilation = compileIdentityContracts(mappingSet);
  } catch (cause) {
    fail('IDENTITY_COMPILATION', cause.message);
  }
  return compilation;
}

function validateSourceValue(value, kind, label) {
  if (kind === 'digest') requireDigest(value, label);
  else if (kind === 'iri') requireIri(value, label);
  else if (kind === 'instant') {
    if (typeof value !== 'string' || !INSTANT_RE.test(value) || !Number.isFinite(Date.parse(value))) fail('SOURCE_VALUE', `${label} is not an explicit UTC instant`);
  } else if (kind === 'integer') {
    if (!Number.isSafeInteger(value) || value < 0) fail('SOURCE_VALUE', `${label} is not a non-negative safe integer`);
  } else if (kind === 'string') {
    if (typeof value !== 'string' || value === '' || value !== value.normalize('NFC')) fail('SOURCE_VALUE', `${label} is not a non-empty NFC string`);
  } else if (kind === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('SOURCE_VALUE', `${label} is not an object`);
    canonicalJcs(value);
  }
}

function validateSnapshot(snapshot, schema) {
  exactKeys(snapshot, ['closures', 'datasets', 'profileRef', 'runtimeContext', 'schemaVersion', 'sourceSchemaDigest'], 'source snapshot');
  if (snapshot.schemaVersion !== '1.0' || snapshot.profileRef !== PROFILE_REF || snapshot.sourceSchemaDigest !== jcsDigest(schema)) {
    fail('SOURCE_SNAPSHOT', 'snapshot identity/source-schema digest mismatch');
  }
  exactKeys(snapshot.runtimeContext, ['assertionTime', 'iri', 'referenceTime', 'runId'], 'snapshot runtimeContext');
  validateSourceValue(snapshot.runtimeContext.iri, 'iri', 'runtimeContext.iri');
  for (const field of ['assertionTime', 'referenceTime']) validateSourceValue(snapshot.runtimeContext[field], 'instant', `runtimeContext.${field}`);
  validateSourceValue(snapshot.runtimeContext.runId, 'string', 'runtimeContext.runId');
  const aliases = Object.keys(schema.datasets).sort(compareUtf8);
  if (canonicalJcs(Object.keys(snapshot.datasets).sort(compareUtf8)) !== canonicalJcs(aliases)) fail('SOURCE_SNAPSHOT', 'snapshot dataset closure mismatch');
  for (const alias of aliases) {
    const rows = snapshot.datasets[alias];
    if (!Array.isArray(rows) || rows.length === 0) fail('SOURCE_SNAPSHOT', `${alias} must contain at least one row`);
    const fields = schema.datasets[alias].fields;
    rows.forEach((row, rowIndex) => {
      exactKeys(row, Object.keys(fields), `${alias}[${rowIndex}]`);
      for (const [field, kind] of Object.entries(fields)) validateSourceValue(row[field], kind, `${alias}[${rowIndex}].${field}`);
    });
  }
  if (!Array.isArray(snapshot.closures)) fail('SOURCE_SNAPSHOT', 'closures must be an array');
}

function indexes(mappingSet) {
  return {
    contractByRef: new Map(mappingSet.contracts.map((row) => [row.iri, row])),
    mappingByRef: new Map(mappingSet.mappings.map((row) => [row.iri, row])),
    ruleByRef: new Map(mappingSet.normalizationRules.map((row) => [row.iri, row])),
    termByRef: new Map(mappingSet.identityTermRegistry.termContracts.map((row) => [row.termContractRef, row])),
  };
}

function evaluateRaw(binding, row, snapshot, context) {
  if (binding.bindingType === 'directField') {
    if (!Object.hasOwn(row, binding.source.field)) fail('MATERIALIZATION_FIELD', `row lacks ${binding.source.field}`);
    return row[binding.source.field];
  }
  if (binding.bindingType === 'literal') return binding.value;
  if (binding.bindingType === 'runtimeContext') return snapshot.runtimeContext[binding.contextField];
  if (binding.bindingType === 'referenceIdentity') {
    const target = context.mappingByRef.get(binding.targetMappingRef);
    if (!target) fail('MATERIALIZATION_REFERENCE', `unknown target mapping ${binding.targetMappingRef}`);
    return identityForBindings(target, binding.keyBindings, row, snapshot, context, binding.referenceMode);
  }
  fail('MATERIALIZATION_BINDING', `unsupported binding ${String(binding.bindingType)}`);
}

function normalizeComponent(component, raw, context) {
  const term = context.termByRef.get(component.termContractRef);
  const rule = context.ruleByRef.get(component.normalizationRuleRef);
  if (!term || !rule) fail('MATERIALIZATION_IDENTITY', `component ${component.name} has an unbound term/rule`);
  const termContract = term.definition.termContract;
  let value = raw;
  if (termContract.termKind === 'iri' && raw && typeof raw === 'object') {
    value = termContract.referenceMode === 'version' ? raw.versionIri : raw.logicalIri;
  }
  return normalizeIdentityValue(value, termContract, rule.algorithmId);
}

function identityForBindings(mapping, bindings, row, snapshot, context, mode = 'version') {
  const contract = context.contractByRef.get(mapping.identity.contractRef);
  if (!contract) fail('MATERIALIZATION_IDENTITY', `mapping ${mapping.iri} has no contract`);
  const logicalTerms = {};
  for (const component of contract.logicalComponents) {
    logicalTerms[component.name] = normalizeComponent(
      component,
      evaluateRaw(bindings[component.name], row, snapshot, context),
      context,
    );
  }
  const versionTerms = {};
  if (mode === 'version') {
    for (const component of contract.versionComponents) {
      versionTerms[component.name] = normalizeComponent(
        component,
        evaluateRaw(bindings[component.name], row, snapshot, context),
        context,
      );
    }
  }
  if (mode === 'logical') {
    const logicalHex = identityKeyDigest(contract.logicalComponents, logicalTerms).toString('hex');
    return {
      logicalIri: `${contract.identityBaseIri}/sha256-${logicalHex}`,
      referenceMode: 'logical',
    };
  }
  const iris = buildIdentityIris(contract, logicalTerms, versionTerms);
  return { logicalIri: iris.logicalIri, referenceMode: 'version', versionIri: iris.versionIri };
}

function materialize(mappingSet, schema, snapshot) {
  validateSnapshot(snapshot, schema);
  const context = indexes(mappingSet);
  const quantityUnits = loadQuantityUnitRegistry(PATHS.quantityUnitRegistry);
  const records = [];
  for (const mapping of mappingSet.mappings) {
    const alias = mapping.source.datasets[0].alias;
    const contract = context.contractByRef.get(mapping.identity.contractRef);
    for (const [rowIndex, row] of snapshot.datasets[alias].entries()) {
      const logicalTerms = {};
      const versionTerms = {};
      for (const component of contract.logicalComponents) {
        logicalTerms[component.name] = normalizeComponent(component, evaluateRaw(mapping.identity.logicalKeyBindings[component.name], row, snapshot, context), context);
      }
      for (const component of contract.versionComponents) {
        versionTerms[component.name] = normalizeComponent(component, evaluateRaw(mapping.identity.versionKeyBindings[component.name], row, snapshot, context), context);
      }
      const identity = buildIdentityIris(contract, logicalTerms, versionTerms);
      const slots = mapping.slotMappings.map((slot) => ({
        target: slot.target,
        value: evaluateRaw(slot.value, row, snapshot, context),
      }));
      const quantityApplications = new Map([
        [`${BASE}signalStrength`, 'signalStrength'],
        [`${BASE}performanceQuantityValue`, 'performanceQuantityValue'],
      ]);
      for (const slot of slots) {
        const application = slot.target.slotType === 'attribute'
          ? quantityApplications.get(slot.target.targetAttribute)
          : null;
        if (!application) continue;
        const quantity = slot.value;
        if (!quantity || typeof quantity !== 'object' || Array.isArray(quantity)
            || canonicalJcs(Object.keys(quantity).sort(compareUtf8))
              !== canonicalJcs(['rounding', 'unit', 'value'])
            || !isDecimalLexical(quantity.value)
            || !['floor', 'ceiling', 'half-up', 'half-even'].includes(quantity.rounding)
            || !quantityUnitForApplication(quantityUnits, quantity.unit, application)) {
          fail(
            'MATERIALIZATION_QUANTITY',
            `${mapping.iri} materialized an unregistered or non-exact ${application} Quantity value`,
          );
        }
      }
      const generatingContextSlots = slots.filter((slot) => (
        slot.target.slotType === 'patternField'
        && slot.target.targetPattern === 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact'
        && slot.target.targetField === 'generatingContextRef'
      ));
      if (generatingContextSlots.length !== 1
          || generatingContextSlots[0].value !== snapshot.runtimeContext.iri) {
        fail(
          'MATERIALIZATION_GENERATING_CONTEXT',
          `mapping ${mapping.iri} did not derive generatingContextRef from the closed runtimeContext.iri`,
        );
      }
      const temporal = {
        availableFrom: evaluateRaw(mapping.temporal.availabilityTime.from, row, snapshot, context),
        knowledgeFrom: evaluateRaw(mapping.temporal.knowledgeTime.from, row, snapshot, context),
        revision: row.revision,
        validFrom: evaluateRaw(mapping.temporal.validTime.from, row, snapshot, context),
        validTo: evaluateRaw(mapping.temporal.validTime.to, row, snapshot, context),
      };
      const provenance = Object.fromEntries(Object.entries(mapping.provenance).map(([name, binding]) => [name, evaluateRaw(binding, row, snapshot, context)]));
      records.push({
        identityTerms: { logical: logicalTerms, version: versionTerms },
        logicalIri: identity.logicalIri,
        mappingRef: mapping.iri,
        provenance,
        sourceRowIndex: rowIndex,
        slots,
        targetType: mapping.targetType,
        temporal,
        versionIri: identity.versionIri,
      });
    }
  }
  records.sort((left, right) => compareUtf8(`${left.mappingRef}\0${left.versionIri}`, `${right.mappingRef}\0${right.versionIri}`));
  return { profileRef: PROFILE_REF, records, schemaVersion: '1.0' };
}

function buildMappingEvidence(mappingSet, compilation, schema, snapshot, output, normalizationCount) {
  const targetCounts = MATERIALIZED_TARGETS.map((targetType) => ({
    count: output.records.filter((row) => row.targetType === targetType).length,
    targetType,
  }));
  return {
    compiler: {
      digest: fileDigest(PATHS.identityCompiler),
      ref: artifact(repositoryPath(PATHS.identityCompiler)),
    },
    executor: {
      digest: fileDigest(PATHS.evidenceImplementation),
      ref: artifact(repositoryPath(PATHS.evidenceImplementation)),
    },
    identityManifestDigest: compilation.manifestDigest,
    mappingSetDigest: fileDigest(PATHS.mappingSet),
    materializedOutputDigest: jcsDigest(output),
    normalizationVectorCount: normalizationCount,
    outcome: 'passed',
    profileRef: PROFILE_REF,
    referenceEdges: compilation.dependencyEdges,
    releaseTargets: [...RELEASE_TARGETS],
    schemaVersion: '1.0',
    sourceSchemaDigest: jcsDigest(schema),
    sourceSnapshotDigest: jcsDigest(snapshot),
    targetCounts,
  };
}

function loadYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

function valueOfPerformance(row) {
  return row.performanceQuantityValue ?? row.performanceMoneyValue;
}

function jcsSafe(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      fail('JCS_NUMBER', 'non-integer or unsafe JS numbers are forbidden; use an explicit decimal or integer lexical string');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(jcsSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jcsSafe(child)]));
  }
  return value;
}

function buildCqBindings(card, positiveDocument) {
  const cases = new Map(positiveDocument.cases.map((row) => [row.id, row.payload]));
  const bindings = {};
  const signal = cases.get('signal-canonical-observation');
  bindings['CQ-SR1'] = [{
    direction: signal.direction,
    generatorVersionIri: signal.generator.versionIri,
    instrumentVersionIri: signal.instrument.versionIri,
    signalVersionIri: signal.identity.versionIri,
    strength: signal.strength,
  }];
  const strategy = cases.get('strategy-definition-with-explicit-factor-dependency');
  bindings['CQ-SR2'] = strategy.usesFactors.map((factor) => ({
    factorVersionIri: factor.versionIri,
    strategyVersionIri: strategy.identity.versionIri,
  }));
  const completed = cases.get('completed-backtest-with-joined-performance');
  bindings['CQ-SR3'] = completed.performances.map((performance) => ({
    calculationParameterSnapshotDigest: performance.calculationContext.calculationParameterSnapshotDigest,
    calculationContextVersionIri: performance.calculationContext.ref.versionIri,
    metricVersionIri: performance.metric.ref.versionIri,
    performanceVersionIri: performance.identity.versionIri,
    value: valueOfPerformance(performance),
  }));
  const backtest = cases.get('closed-backtest-configuration');
  bindings['CQ-SR4'] = [{
    benchmarkDigest: backtest.benchmarkDigest,
    calendarSnapshotDigest: backtest.calendarSnapshotDigest,
    codeDefinitionDigest: backtest.codeDefinitionDigest,
    deterministicSeed: backtest.deterministicSeed,
    feeAssumptionDigest: backtest.feeAssumptionDigest,
    fillAssumptionDigest: backtest.fillAssumptionDigest,
    initialCapital: backtest.initialCapital,
    mappingClosureDigest: backtest.mappingClosureDigest,
    ontologyClosureDigest: backtest.ontologyClosureDigest,
    parameterSnapshotDigest: backtest.parameterSnapshotDigest,
    simulationFrom: backtest.simulationFrom,
    simulationTo: backtest.simulationTo,
    slippageAssumptionDigest: backtest.slippageAssumptionDigest,
    strategyVersionIri: backtest.strategy.versionIri,
  }];
  const sr5 = card.cqs.find((row) => row.id === 'CQ-SR5');
  const from = Date.parse(backtest.simulationFrom);
  const to = Date.parse(backtest.simulationTo);
  const queryFrom = Date.parse('2024-04-01T00:00:00Z');
  const queryTo = Date.parse('2024-07-01T00:00:00Z');
  bindings['CQ-SR5'] = from < queryTo && to > queryFrom ? [{
    backtestVersionIri: backtest.identity.versionIri,
    simulationFrom: backtest.simulationFrom,
    simulationTo: backtest.simulationTo,
    strategyVersionIri: backtest.strategy.versionIri,
  }] : [];
  if (sr5.negativeQuery.expectedResult !== 'empty'
      || sr5.negativeQuery.strategyVersionIri === backtest.strategy.versionIri) {
    fail('CQ_NEGATIVE_QUERY', 'CQ-SR5 negative query does not prove an empty result');
  }
  const trajectory = cases.get('ordered-sharpe-trajectory-at-explicit-pivots');
  bindings['CQ-SR6'] = trajectory.observations.map((performance) => ({
    calculationParameterSnapshotDigest: performance.calculationContext.calculationParameterSnapshotDigest,
    performanceVersionIri: performance.identity.versionIri,
    quantityValue: performance.performanceQuantityValue,
    validFrom: performance.temporal.validFrom,
  }));
  const revision = cases.get('performance-knowledge-revision-with-separate-closures');
  bindings['CQ-SR8'] = [revision.previous, revision.current].map((performance) => ({
    availableFrom: performance.temporal.availableFrom,
    knowledgeFrom: performance.temporal.knowledgeFrom,
    performanceVersionIri: performance.identity.versionIri,
    priorVersionIri: performance.priorVersion?.versionIri || null,
    revision: performance.temporal.revision,
  }));
  return bindings;
}

function buildExpectedBindings(card, positiveDocument) {
  const deferred = card.cqs.find((row) => row.id === 'CQ-SR7');
  return {
    bindings: jcsSafe(buildCqBindings(card, positiveDocument)),
    deferred: {
      'CQ-SR7': {
        deferralReason: deferred.deferralReason,
        requiredFutureContracts: deferred.requiredFutureContracts,
        status: 'deferred-non-core',
      },
    },
    schemaVersion: '1.0',
  };
}

function buildCqEvidence(expectedArtifact = null) {
  const { validateFixtureDocument } = require('./strategy-research-contracts.cjs');
  const card = loadYaml(PATHS.card);
  const positive = loadYaml(PATHS.positiveFixture);
  const negative = loadYaml(PATHS.negativeFixture);
  exactKeys(card, ['contract', 'cqs', 'module', 'moduleVersion', 'schemaVersion'], 'Strategy/Research CQ card');
  if (card.schemaVersion !== '1.0' || card.module !== 'fin-strategy-research' || String(card.moduleVersion) !== '0.3.0') fail('CQ_CARD', 'card identity mismatch');
  const expectedIds = Array.from({ length: 8 }, (_, index) => `CQ-SR${index + 1}`);
  if (canonicalJcs(card.cqs.map((row) => row.id)) !== canonicalJcs(expectedIds)) fail('CQ_CARD', 'CQ-SR1..8 inventory/order mismatch');
  const positiveResult = validateFixtureDocument(positive, { requirePositive: true });
  const negativeResult = validateFixtureDocument(negative, { requireNegative: true });
  if (!positiveResult.ok || !negativeResult.ok) fail('CQ_FIXTURE_EXECUTION', 'positive/negative fixture execution failed');
  const resultById = new Map([...positiveResult.results, ...negativeResult.results].map((row) => [row.id, row]));
  const expected = expectedArtifact || readStrictJcs(PATHS.expectedBindings).value;
  exactKeys(expected, ['bindings', 'deferred', 'schemaVersion'], 'CQ expected bindings');
  if (expected.schemaVersion !== '1.0') fail('CQ_EXPECTED', 'expected bindings schemaVersion mismatch');
  const actual = buildExpectedBindings(card, positive);
  if (canonicalJcs(expected) !== canonicalJcs(actual)) fail('CQ_EXPECTED', 'stored expected bindings differ from actual probes');
  const queries = [];
  for (const cq of card.cqs) {
    if (cq.id === 'CQ-SR7') {
      if (cq.status !== 'deferred'
          || canonicalJcs(cq.requiredFutureContracts) !== canonicalJcs(['InstrumentClassification', 'MarketRegime'])
          || !/outside the v0\.3 core scope/u.test(cq.deferralReason)) {
        fail('CQ_SR7_DEFERRAL', 'CQ-SR7 is not the exact reviewed non-core deferral');
      }
      queries.push({ bindingCount: 0, bindingDigest: jcsDigest([]), cqId: cq.id, negativeEvidenceCount: 0, positiveEvidenceCount: 0, status: 'deferred-non-core' });
      continue;
    }
    if (cq.status !== 'active') fail('CQ_STATUS', `${cq.id} must be active`);
    const positiveIds = cq.positiveCases || [];
    const negativeIds = cq.negativeCases || [];
    if (positiveIds.length === 0) fail('CQ_CASE_BINDING', `${cq.id} has no positive fixture binding`);
    for (const id of [...positiveIds, ...negativeIds]) {
      const result = resultById.get(id);
      if (!result || !result.matched) fail('CQ_CASE_BINDING', `${cq.id} fixture ${id} did not execute to its expected outcome`);
    }
    if (cq.id === 'CQ-SR5' && cq.negativeQuery?.expectedResult !== 'empty') fail('CQ_CASE_BINDING', 'CQ-SR5 must bind its explicit empty negative query');
    const rows = expected.bindings[cq.id];
    if (!Array.isArray(rows) || rows.length === 0) fail('CQ_PROBE', `${cq.id} actual probe returned no bindings`);
    queries.push({
      bindingCount: rows.length,
      bindingDigest: jcsDigest(rows),
      cqId: cq.id,
      negativeEvidenceCount: negativeIds.length + (cq.id === 'CQ-SR5' ? 1 : 0),
      positiveEvidenceCount: positiveIds.length,
      status: 'passed',
    });
  }
  return {
    artifacts: {
      card: { digest: fileDigest(PATHS.card), ref: artifact(repositoryPath(PATHS.card)) },
      expectedBindings: { digest: fileDigest(PATHS.expectedBindings), ref: artifact(repositoryPath(PATHS.expectedBindings)) },
      negativeFixture: { digest: fileDigest(PATHS.negativeFixture), ref: artifact(repositoryPath(PATHS.negativeFixture)) },
      positiveFixture: { digest: fileDigest(PATHS.positiveFixture), ref: artifact(repositoryPath(PATHS.positiveFixture)) },
      probeImplementation: { digest: fileDigest(PATHS.evidenceImplementation), ref: artifact(repositoryPath(PATHS.evidenceImplementation)) },
      validatorImplementation: { digest: fileDigest(PATHS.contractImplementation), ref: artifact(repositoryPath(PATHS.contractImplementation)) },
    },
    fixtureExecution: { negativeCount: negativeResult.results.length, negativePassed: negativeResult.results.filter((row) => row.matched).length, positiveCount: positiveResult.results.length, positivePassed: positiveResult.results.filter((row) => row.matched).length },
    outcome: 'passed',
    profileRef: PROFILE_REF,
    queries,
    schemaVersion: '1.0',
  };
}

function closureFor(snapshot, revision) {
  return snapshot.closures.find((row) => row.dataset === 'performance' && row.revision === revision) || null;
}

function visiblePerformance(records, snapshot, request) {
  const pivots = {
    available: Date.parse(request.asOfAvailable),
    knowledge: Date.parse(request.asOfKnowledge),
    valid: Date.parse(request.asOfValid),
  };
  if (Object.values(pivots).some((value) => !Number.isFinite(value))) fail('PIT_REQUEST', `invalid pivots for ${request.caseId}`);
  return records.filter((record) => {
    const temporal = record.temporal;
    for (const name of ['validFrom', 'validTo', 'knowledgeFrom', 'availableFrom']) {
      if (!INSTANT_RE.test(temporal[name] || '')) fail('PIT_INPUT_CONTRACT', `record lacks ${name}`);
    }
    const closure = closureFor(snapshot, temporal.revision);
    return Date.parse(temporal.validFrom) <= pivots.valid
      && pivots.valid < Date.parse(temporal.validTo)
      && Date.parse(temporal.knowledgeFrom) <= pivots.knowledge
      && (!closure || pivots.knowledge < Date.parse(closure.knowledgeClosedAt))
      && Date.parse(temporal.availableFrom) <= pivots.available
      && (!closure || pivots.available < Date.parse(closure.availabilityClosedAt));
  }).sort((left, right) => left.temporal.revision - right.temporal.revision);
}

function pitRows(records) {
  return records.map((row) => ({
    availableFrom: row.temporal.availableFrom,
    knowledgeFrom: row.temporal.knowledgeFrom,
    logicalIri: row.logicalIri,
    revision: row.temporal.revision,
    validFrom: row.temporal.validFrom,
    versionIri: row.versionIri,
  }));
}

function buildPitEvidence(mappingSet, schema, snapshot, output, requests) {
  exactKeys(requests, ['requests', 'schemaVersion', 'targetType'], 'PIT request set');
  if (requests.schemaVersion !== '1.0' || requests.targetType !== `${BASE}PerformanceObservation`) fail('PIT_REQUEST', 'PIT request-set identity mismatch');
  const performance = output.records.filter((row) => row.targetType === requests.targetType);
  const results = requests.requests.map((request) => {
    const rows = pitRows(visiblePerformance(performance, snapshot, request));
    if (canonicalJcs(rows.map((row) => row.revision)) !== canonicalJcs(request.expectedRevisions)) {
      fail('PIT_EXPECTATION', `${request.caseId} returned the wrong revision set`);
    }
    return { caseId: request.caseId, resultDigest: jcsDigest(rows), results: rows, status: 'passed' };
  });

  const futureSnapshot = structuredClone(snapshot);
  const latest = structuredClone(futureSnapshot.datasets.performance.at(-1));
  latest.acquisition_time = '2025-02-01T00:00:02Z';
  latest.available_from = '2025-02-01T00:00:01Z';
  latest.knowledge_from = '2025-02-01T00:00:00Z';
  latest.quantity_value.value = '0.053';
  latest.revision = 2;
  futureSnapshot.datasets.performance.push(latest);
  futureSnapshot.closures.push({
    availabilityClosedAt: latest.available_from,
    dataset: 'performance',
    knowledgeClosedAt: latest.knowledge_from,
    logicalKey: ['backtest-2024', 'total-return', 'daily-close', 'total-return-2024'],
    revision: 1,
    successorRevision: 2,
  });
  const futureOutput = materialize(mappingSet, schema, futureSnapshot);
  const futurePerformance = futureOutput.records.filter((row) => row.targetType === requests.targetType);
  const futureResults = requests.requests.map((request) => pitRows(visiblePerformance(futurePerformance, futureSnapshot, request)));
  if (canonicalJcs(futureResults) !== canonicalJcs(results.map((row) => row.results))) {
    fail('PIT_FUTURE_APPEND', 'future append changed historical replay results');
  }

  const missingAvailability = structuredClone(output.records.find((row) => row.targetType === requests.targetType));
  delete missingAvailability.temporal.availableFrom;
  let missingRejected = false;
  try {
    visiblePerformance([missingAvailability], snapshot, requests.requests[0]);
  } catch (cause) {
    missingRejected = cause.code === 'PIT_INPUT_CONTRACT';
  }
  if (!missingRejected) fail('PIT_NEGATIVE_CONTROL', 'missing availability was not rejected');
  return {
    executor: { digest: fileDigest(PATHS.evidenceImplementation), ref: artifact(repositoryPath(PATHS.evidenceImplementation)) },
    futureAppend: { appendedRevision: 2, historicalReplayInvariant: true, status: 'passed' },
    mappingOutputDigest: jcsDigest(output),
    negativeControls: [{ caseId: 'missing-availability-axis', code: 'PIT_INPUT_CONTRACT', status: 'passed' }],
    outcome: 'passed',
    profileRef: PROFILE_REF,
    requestSet: { digest: fileDigest(PATHS.pitRequests), ref: artifact(repositoryPath(PATHS.pitRequests)) },
    results,
    schemaVersion: '1.0',
    sourceSnapshotDigest: jcsDigest(snapshot),
  };
}

function sandboxEnvironment() {
  const env = { TZ: 'UTC' };
  for (const key of ['SystemRoot', 'TEMP', 'TMP']) if (typeof process.env[key] === 'string') env[key] = process.env[key];
  return env;
}

function executeFormulaSandboxed(request, options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-strategy-formula-'));
  const input = path.join(tempRoot, 'input.json');
  const output = path.join(tempRoot, 'output.json');
  fs.writeFileSync(input, jcsBytes(request), { flag: 'wx' });
  try {
    const execution = spawnSync(process.execPath, [
      '--permission', '--max-old-space-size=64',
      `--allow-fs-read=${PATHS.formulaWorker}`,
      `--allow-fs-read=${PATHS.formulaDefinitions}`,
      `--allow-fs-read=${path.join(ROOT, 'scripts', 'domain', 'lib')}`,
      `--allow-fs-read=${input}`,
      `--allow-fs-write=${output}`,
      PATHS.formulaWorker, input, PATHS.formulaDefinitions, output,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: sandboxEnvironment(),
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: options.timeoutMs || 3000,
      windowsHide: true,
    });
    if (execution.error) throw execution.error;
    if (!fs.existsSync(output)) fail('FORMULA_OUTPUT', `formula worker emitted no output (exit ${String(execution.status)})`);
    const result = readStrictJcs(output, 'formula worker output').value;
    exactKeys(result, ['code', 'message', 'outcome', 'schemaVersion', 'value'], 'formula worker output');
    const expectedExit = { conforms: 0, engineFailure: 2, violation: 1 }[result.outcome];
    if (execution.status !== expectedExit) fail('FORMULA_EXIT', `worker exit ${String(execution.status)} disagrees with ${result.outcome}`);
    return result;
  } finally {
    const resolved = path.resolve(tempRoot);
    if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) fail('TEMP_PATH', `refusing to delete ${resolved}`);
    fs.rmSync(resolved, { force: true, recursive: true });
  }
}

function verifyFormulaClosure(candidate = null) {
  const closure = candidate || readStrictJcs(PATHS.formulaClosure).value;
  exactKeys(closure, ['artifacts', 'closureDigest', 'definitionsDigest', 'schemaVersion', 'vectorsDigest'], 'formula runtime closure');
  if (closure.schemaVersion !== '1.0' || !Array.isArray(closure.artifacts) || closure.artifacts.length !== 3) fail('FORMULA_CLOSURE', 'formula closure shape mismatch');
  let previous = null;
  for (const [index, row] of closure.artifacts.entries()) {
    exactKeys(row, ['digest', 'ref', 'role'], `formula closure artifact ${index}`);
    if (previous !== null && compareUtf8(previous, row.ref.path) >= 0) fail('FORMULA_CLOSURE', 'formula closure artifacts are not strictly path-sorted');
    verifyRefDigest(row.ref, row.digest, ROOT, `formula closure ${row.role}`);
    previous = row.ref.path;
  }
  const actualClosureDigest = `sha256:${crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from(FORMULA_CLOSURE_TAG, 'utf8'), Buffer.from(canonicalJcs(closure.artifacts), 'utf8'),
  ])).digest('hex')}`;
  if (closure.closureDigest !== actualClosureDigest
      || closure.definitionsDigest !== fileDigest(PATHS.formulaDefinitions)
      || closure.vectorsDigest !== fileDigest(PATHS.formulaVectors)) {
    fail('FORMULA_CLOSURE_TAMPER', 'formula closure digest join mismatch');
  }
  return closure;
}

function validateFormulaDefinitions(definitions) {
  exactKeys(definitions, ['definitions', 'schemaVersion'], 'formula definitions');
  if (definitions.schemaVersion !== '1.0' || !Array.isArray(definitions.definitions) || definitions.definitions.length !== 2) fail('FORMULA_DEFINITION', 'formula definition inventory mismatch');
  let previous = null;
  for (const [index, row] of definitions.definitions.entries()) {
    exactKeys(row, ['definitionIri', 'expression', 'formulaDigest', 'formulaId', 'implementationDigest', 'implementationRef', 'inputContract', 'inputContractDigest', 'kind', 'outputContract', 'outputContractDigest'], `formula definition ${index}`);
    if (previous !== null && compareUtf8(previous, row.formulaId) >= 0) fail('FORMULA_DEFINITION', 'formula definitions must be strictly formulaId-sorted');
    requireIri(row.definitionIri, `formula definition ${index}.definitionIri`);
    verifyRefDigest(row.implementationRef, row.implementationDigest, ROOT, `formula definition ${row.formulaId}.implementation`);
    if (row.formulaDigest !== jcsDigest({ expression: row.expression, formulaId: row.formulaId })
        || row.inputContractDigest !== jcsDigest(row.inputContract)
        || row.outputContractDigest !== jcsDigest(row.outputContract)) {
      fail('FORMULA_DEFINITION_TAMPER', `formula definition ${row.formulaId} digest mismatch`);
    }
    previous = row.formulaId;
  }
}

function buildFormulaEvidence() {
  const definitions = readStrictJcs(PATHS.formulaDefinitions).value;
  const vectors = readStrictJcs(PATHS.formulaVectors).value;
  validateFormulaDefinitions(definitions);
  const closure = verifyFormulaClosure();
  exactKeys(vectors, ['schemaVersion', 'vectors'], 'formula vectors');
  const results = [];
  for (const vector of vectors.vectors.filter((row) => ['positive', 'negative'].includes(row.category))) {
    const output = executeFormulaSandboxed(vector.request);
    const passed = output.outcome === vector.expectedOutcome
      && (vector.expectedCode === undefined || output.code === vector.expectedCode)
      && (vector.expectedValue === undefined || canonicalJcs(output.value) === canonicalJcs(vector.expectedValue));
    results.push({ actualCode: output.code, actualOutcome: output.outcome, caseId: vector.caseId, category: vector.category, status: passed ? 'passed' : 'failed' });
  }
  const tampered = structuredClone(closure);
  tampered.artifacts[0].digest = `sha256:${'0'.repeat(64)}`;
  let tamperPassed = false;
  try { verifyFormulaClosure(tampered); } catch (cause) { tamperPassed = cause.code === 'ARTIFACT_DIGEST'; }
  results.push({ actualCode: tamperPassed ? 'FORMULA_CLOSURE_TAMPER' : null, actualOutcome: tamperPassed ? 'engineFailure' : 'conforms', caseId: 'runtime-closure-tamper', category: 'tamper', status: tamperPassed ? 'passed' : 'failed' });
  const timeout = spawnSync(process.execPath, ['--permission', '-e', 'for(;;){}'], {
    cwd: ROOT, encoding: 'utf8', env: sandboxEnvironment(), maxBuffer: 4096,
    shell: false, timeout: 100, windowsHide: true,
  });
  const timedOut = timeout.error?.code === 'ETIMEDOUT';
  results.push({ actualCode: timedOut ? 'FORMULA_TIMEOUT' : null, actualOutcome: timedOut ? 'engineFailure' : 'conforms', caseId: 'runtime-timeout', category: 'timeout', status: timedOut ? 'passed' : 'failed' });
  results.sort((left, right) => compareUtf8(left.caseId, right.caseId));
  return {
    artifactBindings: {
      closure: { digest: fileDigest(PATHS.formulaClosure), ref: artifact(repositoryPath(PATHS.formulaClosure)) },
      definitions: { digest: fileDigest(PATHS.formulaDefinitions), ref: artifact(repositoryPath(PATHS.formulaDefinitions)) },
      orchestrator: { digest: fileDigest(PATHS.evidenceImplementation), ref: artifact(repositoryPath(PATHS.evidenceImplementation)) },
      vectors: { digest: fileDigest(PATHS.formulaVectors), ref: artifact(repositoryPath(PATHS.formulaVectors)) },
      worker: { digest: fileDigest(PATHS.formulaWorker), ref: artifact(repositoryPath(PATHS.formulaWorker)) },
    },
    executionAssurance: { environmentAllowlist: true, fileSystemPermissions: true, freshOutput: true, memoryLimit: true, networkIsolation: false, outputLimit: true, processCreationDenied: true, timeout: true },
    formulaDefinitions: definitions.definitions.map((row) => ({ definitionIri: row.definitionIri, formulaId: row.formulaId, kind: row.kind })),
    outcome: results.every((row) => row.status === 'passed') ? 'passed' : 'failed',
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
    vectorResults: results,
  };
}

const MANIFEST_ARTIFACTS = Object.freeze([
  ['calculation-parameter-extractor-profile', PATHS.calculationParameterExtractorProfile],
  ['calculation-parameter-full-run-snapshot', PATHS.calculationParameterFullRunSnapshot],
  ['calculation-parameter-invalid-policy-snapshot', PATHS.calculationParameterInvalidPolicySnapshot],
  ['calculation-parameter-log-sum-snapshot', PATHS.calculationParameterLogSumSnapshot],
  ['calculation-parameter-lookahead-snapshot', PATHS.calculationParameterLookAheadSnapshot],
  ['calculation-parameter-anchor-mismatch-snapshot', PATHS.calculationParameterAnchorMismatchSnapshot],
  ['calculation-parameter-snapshot', PATHS.calculationParameterSnapshot],
  ['contract-implementation', PATHS.contractImplementation], ['cq-card', PATHS.card], ['cq-evidence', PATHS.cqEvidence],
  ['cq-expected-bindings', PATHS.expectedBindings], ['formula-closure', PATHS.formulaClosure],
  ['formula-definitions', PATHS.formulaDefinitions], ['formula-evidence', PATHS.formulaEvidence],
  ['formula-vectors', PATHS.formulaVectors], ['evidence-implementation', PATHS.evidenceImplementation],
  ['evidence-generator', PATHS.generator], ['identity-manifest', PATHS.identityManifest],
  ['identity-registry', PATHS.identityRegistry], ['mapping-evidence', PATHS.mappingEvidence],
  ['mapping-set', PATHS.mappingSet], ['materialized-output', PATHS.materializedOutput],
  ['module', PATHS.module], ['negative-fixture', PATHS.negativeFixture],
  ['normalization-contract', PATHS.normalizationContract], ['normalization-implementation', PATHS.normalizationImplementation],
  ['normalization-vectors', PATHS.normalizationVectors], ['pit-evidence', PATHS.pitEvidence],
  ['pit-requests', PATHS.pitRequests], ['positive-fixture', PATHS.positiveFixture],
  ['quantity-unit-registry', PATHS.quantityUnitRegistry],
  ['quantity-unit-registry-implementation', PATHS.quantityUnitRegistryImplementation],
  ['source-schema', PATHS.sourceSchema], ['source-snapshot', PATHS.sourceSnapshot],
  ['validation-cli', PATHS.validationCli],
]);

function buildArtifactManifest() {
  return {
    artifacts: MANIFEST_ARTIFACTS.map(([role, file]) => ({ digest: fileDigest(file), ref: artifact(repositoryPath(file)), role }))
      .sort((left, right) => compareUtf8(left.ref.path, right.ref.path)),
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
  };
}

function verifyArtifactManifest() {
  const actual = readStrictJcs(PATHS.artifactManifest).value;
  exactKeys(actual, ['artifacts', 'profileRef', 'schemaVersion'], 'Strategy/Research artifact manifest');
  const expected = buildArtifactManifest();
  if (canonicalJcs(actual) !== canonicalJcs(expected)) fail('ARTIFACT_MANIFEST', 'artifact manifest does not exactly close all release evidence bytes');
  for (const row of actual.artifacts) verifyRefDigest(row.ref, row.digest, ROOT, `manifest ${row.role}`);
  return actual;
}

function verifyMappingEvidence() {
  const mappingSet = readStrictJcs(PATHS.mappingSet).value;
  const schema = readStrictJcs(PATHS.sourceSchema).value;
  const snapshot = readStrictJcs(PATHS.sourceSnapshot).value;
  const moduleDocument = loadYaml(PATHS.module);
  const normalization = verifyNormalization(mappingSet);
  const compilation = validateMappingSet(mappingSet, schema, moduleDocument);
  validateSnapshot(snapshot, schema);
  const identityManifest = readStrictJcs(PATHS.identityManifest).value;
  const identityValidation = validateIdentityManifest(identityManifest, mappingSet);
  if (!identityValidation.ok || canonicalJcs(identityManifest) !== canonicalJcs(compilation.manifest)) {
    fail('IDENTITY_MANIFEST', `identity manifest is not the exact v0.6 compiler projection: ${identityValidation.errors.map((row) => row.code).join(',')}`);
  }
  const output = materialize(mappingSet, schema, snapshot);
  const storedOutput = readStrictJcs(PATHS.materializedOutput).value;
  if (canonicalJcs(storedOutput) !== canonicalJcs(output)) fail('MATERIALIZATION_REPLAY', 'stored materialized output differs from independent replay');
  const expectedEvidence = buildMappingEvidence(mappingSet, compilation, schema, snapshot, output, normalization.vectorCount);
  const storedEvidence = readStrictJcs(PATHS.mappingEvidence).value;
  if (canonicalJcs(storedEvidence) !== canonicalJcs(expectedEvidence)) fail('MAPPING_EVIDENCE', 'mapping evidence differs from independent replay');
  return { compilation, evidence: expectedEvidence, mappingSet, output, schema, snapshot };
}

function verifyQuantityUnitRegistry() {
  let loaded;
  try {
    loaded = loadQuantityUnitRegistry(PATHS.quantityUnitRegistry);
  } catch (cause) {
    fail('QUANTITY_UNIT_REGISTRY', cause.message);
  }
  if (canonicalJcs(loaded.registry) !== canonicalJcs(buildQuantityUnitRegistry())) {
    fail('QUANTITY_UNIT_REGISTRY', 'generated registry differs from the reviewed Strategy/Research v0.3 profile');
  }
  return { registryDigest: loaded.registry.registryDigest, unitCount: loaded.units.size };
}

function verifyCqEvidence() {
  const expected = buildCqEvidence();
  const stored = readStrictJcs(PATHS.cqEvidence).value;
  if (canonicalJcs(stored) !== canonicalJcs(expected)) fail('CQ_EVIDENCE', 'CQ evidence differs from actual fixture/query replay');
  return expected;
}

function verifyPitEvidence(mappingResult = null) {
  const closure = mappingResult || verifyMappingEvidence();
  const requests = readStrictJcs(PATHS.pitRequests).value;
  const expected = buildPitEvidence(closure.mappingSet, closure.schema, closure.snapshot, closure.output, requests);
  const stored = readStrictJcs(PATHS.pitEvidence).value;
  if (canonicalJcs(stored) !== canonicalJcs(expected)) fail('PIT_EVIDENCE', 'PIT evidence differs from three-axis replay');
  return expected;
}

function verifyExecutableEvidence() {
  const expected = buildFormulaEvidence();
  const stored = readStrictJcs(PATHS.formulaEvidence).value;
  if (canonicalJcs(stored) !== canonicalJcs(expected)) fail('FORMULA_EVIDENCE', 'formula evidence differs from restricted runtime replay');
  if (expected.outcome !== 'passed') fail('FORMULA_EVIDENCE', 'formula vector execution failed');
  return expected;
}

function verifyAllStrategyResearchEvidence() {
  const quantityUnits = verifyQuantityUnitRegistry();
  const mapping = verifyMappingEvidence();
  const cq = verifyCqEvidence();
  const pit = verifyPitEvidence(mapping);
  const executable = verifyExecutableEvidence();
  const manifest = verifyArtifactManifest();
  return { cq, executable, manifest, mapping: mapping.evidence, pit, quantityUnits };
}

module.exports = {
  StrategyResearchEvidenceError,
  buildArtifactManifest,
  buildCqBindings,
  buildCqEvidence,
  buildExpectedBindings,
  buildFormulaEvidence,
  buildMappingEvidence,
  buildPitEvidence,
  executeFormulaSandboxed,
  materialize,
  normalizeIdentityValue,
  readStrictJcs,
  validateFormulaDefinitions,
  validateMappingSet,
  validateSnapshot,
  verifyAllStrategyResearchEvidence,
  verifyArtifactManifest,
  verifyCqEvidence,
  verifyExecutableEvidence,
  verifyFormulaClosure,
  verifyMappingEvidence,
  verifyPitEvidence,
  verifyQuantityUnitRegistry,
};
