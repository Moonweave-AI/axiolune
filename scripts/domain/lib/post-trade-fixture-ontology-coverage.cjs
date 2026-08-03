'use strict';

const crypto = require('node:crypto');

const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  effectivePatternInjectedAttributeUses,
} = require('./pattern-injected-fields.cjs');

const COVERAGE_PROFILE = 'axiolune-post-trade-authored-ontology-coverage/v1';
const TYPE_TAG = 'ontologyType';
const RECORD_ENVELOPE_FIELDS = new Set([
  TYPE_TAG,
  'recordIri',
  'attributes',
  'roles',
]);
const COVERAGE_DECLARATION_FIELDS = new Set([
  'profile',
  'completeness',
  'recordCount',
]);
const RECORD_SIGNAL_FIELDS = new Set([
  'versionIri',
  'logicalIri',
  'validFrom',
  'knowledgeFrom',
  'availableFrom',
  'sourceArtifactRef',
  'generatingContextRef',
]);

const MINIMUM_MIGRATION_PLAN = Object.freeze([
  Object.freeze({
    step: 1,
    action: `Add ${TYPE_TAG} to every ontology record using the exact authored type IRI; do not infer a type from private contract keys.`,
  }),
  Object.freeze({
    step: 2,
    action: 'Move authored datatype properties into attributes and participant references into roles; keep only ontologyType, optional recordIri, attributes, and roles in each record envelope.',
  }),
  Object.freeze({
    step: 3,
    action: 'Populate required effective finance TemporalFact and ProvenancedFact fields, including validFrom, knowledgeFrom, availableFrom, source, and revision.',
  }),
  Object.freeze({
    step: 4,
    action: `Add ontologyCoverage { profile: ${COVERAGE_PROFILE}, completeness: complete, recordCount: <exact tagged count> } and rerun this diagnostic audit.`,
  }),
]);

class PostTradeFixtureCoverageError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'PostTradeFixtureCoverageError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PostTradeFixtureCoverageError(code, message, details);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Utf8(value) {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function localName(iri) {
  const slash = iri.lastIndexOf('/');
  const hash = iri.lastIndexOf('#');
  return iri.slice(Math.max(slash, hash) + 1);
}

function appendPath(parent, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function valueCount(value) {
  if (value === undefined || value === null) return 0;
  return Array.isArray(value) ? value.length : 1;
}

function validateCardinality(value, at, allowNull) {
  if (allowNull && value === null) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('PTO_FIXTURE_ONTOLOGY_SHAPE', `${at} must be a non-negative safe integer${allowNull ? ' or null' : ''}`);
  }
}

function mergeMaximum(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function requireAbsoluteIri(value) {
  if (typeof value !== 'string' || value.length === 0 || /\s/u.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol) && parsed.href === value;
  } catch {
    return false;
  }
}

function buildPatternIndex(patternDocument) {
  const patterns = patternDocument?.CrossDomainPatterns?.patterns;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    fail(
      'PTO_FIXTURE_PATTERN_DOCUMENT',
      'patternDocument.CrossDomainPatterns.patterns must be a non-empty array',
    );
  }
  const byIri = new Map();
  for (const [index, pattern] of patterns.entries()) {
    if (!isPlainObject(pattern) || typeof pattern.iri !== 'string') {
      fail('PTO_FIXTURE_PATTERN_DOCUMENT', `pattern ${index} must have an IRI`);
    }
    if (byIri.has(pattern.iri)) {
      fail('PTO_FIXTURE_PATTERN_DOCUMENT', `duplicate pattern IRI ${pattern.iri}`);
    }
    if (pattern.injectedAttributes !== undefined && !Array.isArray(pattern.injectedAttributes)) {
      fail('PTO_FIXTURE_PATTERN_DOCUMENT', `${pattern.iri}.injectedAttributes must be an array`);
    }
    if (pattern.dependencies !== undefined && !Array.isArray(pattern.dependencies)) {
      fail('PTO_FIXTURE_PATTERN_DOCUMENT', `${pattern.iri}.dependencies must be an array`);
    }
    byIri.set(pattern.iri, pattern);
  }
  return byIri;
}

function patternClosure(rootPatternIri, patternsByIri) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(patternIri) {
    if (visited.has(patternIri)) return;
    if (visiting.has(patternIri)) {
      fail('PTO_FIXTURE_PATTERN_DOCUMENT', `cyclic pattern dependency at ${patternIri}`);
    }
    const pattern = patternsByIri.get(patternIri);
    if (!pattern) {
      fail('PTO_FIXTURE_PATTERN_DOCUMENT', `unresolved pattern dependency ${patternIri}`);
    }
    visiting.add(patternIri);
    for (const dependency of pattern.dependencies || []) {
      if (typeof dependency !== 'string') {
        fail('PTO_FIXTURE_PATTERN_DOCUMENT', `${patternIri} contains a non-string dependency`);
      }
      visit(dependency);
    }
    visiting.delete(patternIri);
    visited.add(patternIri);
    ordered.push(pattern);
  }

  visit(rootPatternIri);
  return ordered;
}

function emptyAttributeDescriptor(iri) {
  return {
    iri,
    localName: localName(iri),
    directMinCount: 0,
    directMaxCount: null,
    patternMinCount: 0,
    patternMaxCount: null,
    direct: false,
    boundPatternIris: new Set(),
    declaringPatternIris: new Set(),
  };
}

function compileType(name, type, typeKind, patternsByIri) {
  if (!isPlainObject(type) || typeof type.iri !== 'string' || typeof type.localName !== 'string') {
    fail('PTO_FIXTURE_ONTOLOGY_SHAPE', `${typeKind} ${name} must have iri and localName`);
  }
  if (type.localName !== name) {
    fail('PTO_FIXTURE_ONTOLOGY_SHAPE', `${typeKind} key/localName drift for ${name}`);
  }

  const attributesByIri = new Map();
  const attributeLocalToIris = new Map();
  const addAttribute = (attributeIri) => {
    if (typeof attributeIri !== 'string' || localName(attributeIri).length === 0) {
      fail('PTO_FIXTURE_ONTOLOGY_SHAPE', `${name} contains an invalid attribute IRI`);
    }
    const fieldLocalName = localName(attributeIri);
    const localCandidates = attributeLocalToIris.get(fieldLocalName) || new Set();
    localCandidates.add(attributeIri);
    attributeLocalToIris.set(fieldLocalName, localCandidates);
    if (!attributesByIri.has(attributeIri)) {
      attributesByIri.set(attributeIri, emptyAttributeDescriptor(attributeIri));
    }
    return attributesByIri.get(attributeIri);
  };

  if (type.attributeUses !== undefined && !Array.isArray(type.attributeUses)) {
    fail('PTO_FIXTURE_ONTOLOGY_SHAPE', `${name}.attributeUses must be an array`);
  }
  for (const [index, use] of (type.attributeUses || []).entries()) {
    if (!isPlainObject(use) || typeof use.attribute !== 'string') {
      fail('PTO_FIXTURE_ONTOLOGY_SHAPE', `${name}.attributeUses[${index}] is invalid`);
    }
    const minCount = use.minCount ?? 0;
    const maxCount = Object.hasOwn(use, 'maxCount') ? use.maxCount : null;
    validateCardinality(minCount, `${name}.attributeUses[${index}].minCount`, false);
    validateCardinality(maxCount, `${name}.attributeUses[${index}].maxCount`, true);
    const descriptor = addAttribute(use.attribute);
    descriptor.direct = true;
    descriptor.directMinCount = Math.max(descriptor.directMinCount, minCount);
    descriptor.directMaxCount = mergeMaximum(descriptor.directMaxCount, maxCount);
  }

  if (type.patternBindings !== undefined && !Array.isArray(type.patternBindings)) {
    fail('PTO_FIXTURE_ONTOLOGY_SHAPE', `${name}.patternBindings must be an array`);
  }
  const rootPatternIris = [];
  for (const [bindingIndex, binding] of (type.patternBindings || []).entries()) {
    if (!isPlainObject(binding) || typeof binding.pattern !== 'string') {
      fail('PTO_FIXTURE_ONTOLOGY_SHAPE', `${name}.patternBindings[${bindingIndex}] is invalid`);
    }
    rootPatternIris.push(binding.pattern);
    for (const pattern of patternClosure(binding.pattern, patternsByIri)) {
      for (const [injectionIndex, injection] of (pattern.injectedAttributes || []).entries()) {
        if (!isPlainObject(injection) || typeof injection.attribute !== 'string') {
          fail(
            'PTO_FIXTURE_PATTERN_DOCUMENT',
            `${pattern.iri}.injectedAttributes[${injectionIndex}] is invalid`,
          );
        }
        const minCount = injection.minCount ?? 0;
        const maxCount = Object.hasOwn(injection, 'maxCount') ? injection.maxCount : null;
        validateCardinality(
          minCount,
          `${pattern.iri}.injectedAttributes[${injectionIndex}].minCount`,
          false,
        );
        validateCardinality(
          maxCount,
          `${pattern.iri}.injectedAttributes[${injectionIndex}].maxCount`,
          true,
        );
        const descriptor = addAttribute(injection.attribute);
        descriptor.patternMinCount = Math.max(descriptor.patternMinCount, minCount);
        descriptor.patternMaxCount = mergeMaximum(descriptor.patternMaxCount, maxCount);
        descriptor.boundPatternIris.add(binding.pattern);
        descriptor.declaringPatternIris.add(pattern.iri);
      }
    }
  }

  // Preserve validation and dependency closure from the canonical M3 pattern
  // document above, then apply the shared RFC-001 finance profile used by the
  // domain validator and projections. Raw ProvenancedFact declares revision
  // 0..1; a concrete finance FactVersion is effective revision 1..1.
  for (const injection of effectivePatternInjectedAttributeUses(type)) {
    const minCount = injection.minCount ?? 0;
    const maxCount = Object.hasOwn(injection, 'maxCount') ? injection.maxCount : null;
    validateCardinality(minCount, `${name}.effectivePattern.${injection.attribute}.minCount`, false);
    validateCardinality(maxCount, `${name}.effectivePattern.${injection.attribute}.maxCount`, true);
    const descriptor = addAttribute(injection.attribute);
    descriptor.patternMinCount = Math.max(descriptor.patternMinCount, minCount);
    descriptor.patternMaxCount = mergeMaximum(descriptor.patternMaxCount, maxCount);
    descriptor.boundPatternIris.add(injection.pattern);
    descriptor.declaringPatternIris.add(injection.pattern);
  }

  if (type.participantRoles !== undefined && !Array.isArray(type.participantRoles)) {
    fail('PTO_FIXTURE_ONTOLOGY_SHAPE', `${name}.participantRoles must be an array`);
  }
  const rolesById = new Map();
  const roleKeyToId = new Map();
  for (const [index, role] of (type.participantRoles || []).entries()) {
    if (
      !isPlainObject(role)
      || typeof role.id !== 'string'
      || role.id.length === 0
      || typeof role.range !== 'string'
    ) {
      fail('PTO_FIXTURE_ONTOLOGY_SHAPE', `${name}.participantRoles[${index}] is invalid`);
    }
    if (rolesById.has(role.id)) {
      fail('PTO_FIXTURE_ONTOLOGY_SHAPE', `${name} contains duplicate role ${role.id}`);
    }
    const minCount = role.minCount ?? 0;
    const maxCount = Object.hasOwn(role, 'maxCount') ? role.maxCount : null;
    validateCardinality(minCount, `${name}.participantRoles[${index}].minCount`, false);
    validateCardinality(maxCount, `${name}.participantRoles[${index}].maxCount`, true);
    const targetIri = `${type.iri}/role/${role.id}`;
    const descriptor = {
      id: role.id,
      targetIri,
      range: role.range,
      minCount,
      maxCount,
    };
    rolesById.set(role.id, descriptor);
    roleKeyToId.set(role.id, role.id);
    roleKeyToId.set(targetIri, role.id);
  }

  const attributeDescriptors = [...attributesByIri.values()]
    .map((descriptor) => ({
      iri: descriptor.iri,
      localName: descriptor.localName,
      directMinCount: descriptor.directMinCount,
      directMaxCount: descriptor.directMaxCount,
      patternMinCount: descriptor.patternMinCount,
      patternMaxCount: descriptor.patternMaxCount,
      direct: descriptor.direct,
      boundPatternIris: [...descriptor.boundPatternIris].sort(compareAscii),
      declaringPatternIris: [...descriptor.declaringPatternIris].sort(compareAscii),
    }))
    .sort((left, right) => compareAscii(left.iri, right.iri));
  const ambiguousAttributeAliases = [...attributeLocalToIris.entries()]
    .filter(([, iris]) => iris.size > 1)
    .map(([alias, iris]) => ({ alias, candidateIris: [...iris].sort(compareAscii) }))
    .sort((left, right) => compareAscii(left.alias, right.alias));

  return {
    name,
    iri: type.iri,
    localName: type.localName,
    typeKind,
    rootPatternIris: [...new Set(rootPatternIris)].sort(compareAscii),
    attributesByIri: new Map(attributeDescriptors.map((field) => [field.iri, field])),
    attributeLocalToIris,
    attributeDescriptors,
    ambiguousAttributeAliases,
    rolesById,
    roleKeyToId,
    roleDescriptors: [...rolesById.values()].sort((left, right) => compareAscii(left.id, right.id)),
  };
}

function buildOntologyIndex(ontologyDocument, patternsByIri) {
  if (!isPlainObject(ontologyDocument) || !isPlainObject(ontologyDocument.domain)) {
    fail('PTO_FIXTURE_ONTOLOGY_SHAPE', 'ontologyDocument.domain must be a plain object');
  }
  const byIri = new Map();
  const byLocalName = new Map();

  for (const [bucketName, typeKind] of [
    ['objectTypes', 'ObjectType'],
    ['associationTypes', 'AssociationType'],
  ]) {
    const bucket = ontologyDocument.domain[bucketName];
    if (!isPlainObject(bucket)) {
      fail('PTO_FIXTURE_ONTOLOGY_SHAPE', `ontologyDocument.domain.${bucketName} must be a plain object`);
    }
    for (const [name, type] of Object.entries(bucket)) {
      const compiled = compileType(name, type, typeKind, patternsByIri);
      if (byIri.has(compiled.iri) || byLocalName.has(compiled.localName)) {
        fail('PTO_FIXTURE_ONTOLOGY_SHAPE', `duplicate authored type ${compiled.iri}`);
      }
      byIri.set(compiled.iri, compiled);
      byLocalName.set(compiled.localName, compiled);
    }
  }
  const ambiguousAttributeAliases = [...byIri.values()]
    .flatMap((type) => type.ambiguousAttributeAliases.map((ambiguity) => ({
      typeIri: type.iri,
      typeLocalName: type.localName,
      alias: ambiguity.alias,
      candidateIris: ambiguity.candidateIris,
    })))
    .sort((left, right) => (
      compareAscii(left.typeIri, right.typeIri)
      || compareAscii(left.alias, right.alias)
    ));
  const compiledTypes = [...byIri.values()];
  const sharedRequiredPatternFields = compiledTypes.length === 0
    ? []
    : compiledTypes[0].attributeDescriptors
      .filter((field) => field.patternMinCount > 0)
      .filter((candidate) => compiledTypes.every((type) => (
        (type.attributesByIri.get(candidate.iri)?.patternMinCount || 0) > 0
      )))
      .map((field) => ({
        iri: field.iri,
        localName: field.localName,
        minCount: Math.min(...compiledTypes.map(
          (type) => type.attributesByIri.get(field.iri).patternMinCount,
        )),
      }))
      .sort((left, right) => compareAscii(left.iri, right.iri));
  return {
    byIri,
    byLocalName,
    ambiguousAttributeAliases,
    sharedRequiredPatternFields,
  };
}

function recordSignals(record) {
  return Object.keys(record)
    .filter((key) => RECORD_SIGNAL_FIELDS.has(key) || key.endsWith('VersionIri'))
    .sort(compareAscii);
}

function scanFixtureDocument(fixtureDocument, sharedRequiredPatternFields) {
  const typedRecords = [];
  const untypedRecordCandidates = [];
  let objectCount = 0;

  function visit(value, path) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isPlainObject(value)) return;
    objectCount += 1;
    if (Object.hasOwn(value, TYPE_TAG)) {
      typedRecords.push({ path, value });
      // The attributes/roles containers are not records, but their values are
      // still traversed so an embedded tagged or record-like object cannot be
      // hidden inside an otherwise valid envelope.
      for (const containerName of ['attributes', 'roles']) {
        const container = value[containerName];
        if (!isPlainObject(container)) continue;
        for (const [key, nested] of Object.entries(container)) {
          visit(nested, appendPath(`${path}.${containerName}`, key));
        }
      }
      return;
    }
    const signals = recordSignals(value);
    if (signals.length > 0) {
      const provisionalMissingSharedPatternFields = sharedRequiredPatternFields
        .filter((field) => (
          valueCount(value[field.iri]) === 0 && valueCount(value[field.localName]) === 0
        ));
      untypedRecordCandidates.push({
        path,
        signalFields: signals,
        provisionalMissingSharedPatternFields,
      });
    }
    for (const [key, nested] of Object.entries(value)) {
      visit(nested, appendPath(path, key));
    }
  }

  visit(fixtureDocument, '$');
  return {
    objectCount,
    typedRecords,
    untypedRecordCandidates: untypedRecordCandidates
      .sort((left, right) => compareAscii(left.path, right.path)),
  };
}

function diagnostic(severity, code, path, message, extra = {}) {
  return { severity, code, path, message, ...extra };
}

function resolveType(typeRef, ontologyIndex) {
  if (typeof typeRef !== 'string') return null;
  return ontologyIndex.byIri.get(typeRef) || null;
}

function validateRecord(recordEntry, ontologyIndex) {
  const { path, value: record } = recordEntry;
  const diagnostics = [];
  const unknownEnvelopeFields = Object.keys(record)
    .filter((field) => !RECORD_ENVELOPE_FIELDS.has(field))
    .sort(compareAscii);
  for (const field of unknownEnvelopeFields) {
    diagnostics.push(diagnostic(
      'error',
      'PTO_FIXTURE_FLAT_FIELD',
      appendPath(path, field),
      'flat/private record field is outside the authored ontology envelope',
      { field },
    ));
  }

  if (record.recordIri !== undefined && !requireAbsoluteIri(record.recordIri, `${path}.recordIri`)) {
    diagnostics.push(diagnostic(
      'error',
      'PTO_FIXTURE_RECORD_IRI',
      `${path}.recordIri`,
      'recordIri must be an exact absolute IRI',
    ));
  }

  const type = resolveType(record[TYPE_TAG], ontologyIndex);
  if (!type) {
    diagnostics.push(diagnostic(
      'error',
      'PTO_FIXTURE_UNKNOWN_TYPE',
      `${path}.${TYPE_TAG}`,
      'ontologyType does not resolve to an authored Post-trade ObjectType or AssociationType',
      { typeRef: typeof record[TYPE_TAG] === 'string' ? record[TYPE_TAG] : `<${typeof record[TYPE_TAG]}>` },
    ));
  }

  let attributes = record.attributes;
  let roles = record.roles;
  if (attributes === undefined) attributes = {};
  if (roles === undefined) roles = {};
  if (!isPlainObject(attributes)) {
    diagnostics.push(diagnostic(
      'error',
      'PTO_FIXTURE_ATTRIBUTE_CONTAINER',
      `${path}.attributes`,
      'attributes must be a plain object',
    ));
    attributes = {};
  }
  if (!isPlainObject(roles)) {
    diagnostics.push(diagnostic(
      'error',
      'PTO_FIXTURE_ROLE_CONTAINER',
      `${path}.roles`,
      'roles must be a plain object',
    ));
    roles = {};
  }

  const result = {
    path,
    typeRef: typeof record[TYPE_TAG] === 'string' ? record[TYPE_TAG] : `<${typeof record[TYPE_TAG]}>`,
    typeIri: type?.iri || null,
    typeLocalName: type?.localName || null,
    typeKind: type?.typeKind || null,
    usedAttributes: [],
    usedRoles: [],
    missingRequiredAttributes: [],
    missingRequiredRoles: [],
    missingRequiredPatternFields: [],
    absentOptionalPatternFields: [],
  };
  if (!type) return { result, diagnostics };

  const attributeCounts = new Map();
  const attributeAliases = new Map();
  for (const key of Object.keys(attributes).sort(compareAscii)) {
    let attributeIri = type.attributesByIri.has(key) ? key : null;
    const localCandidates = type.attributeLocalToIris.get(key);
    if (!attributeIri && localCandidates?.size === 1) {
      [attributeIri] = localCandidates;
    } else if (!attributeIri && localCandidates?.size > 1) {
      diagnostics.push(diagnostic(
        'error',
        'PTO_FIXTURE_AMBIGUOUS_ATTRIBUTE',
        appendPath(`${path}.attributes`, key),
        'attribute localName resolves to multiple authored or pattern-injected IRIs; use an exact full IRI',
        { field: key, candidateIris: [...localCandidates].sort(compareAscii), typeIri: type.iri },
      ));
      continue;
    }
    if (!attributeIri) {
      diagnostics.push(diagnostic(
        'error',
        'PTO_FIXTURE_UNKNOWN_ATTRIBUTE',
        appendPath(`${path}.attributes`, key),
        'attribute is not authored on the claimed ontology type or injected by a bound pattern',
        { field: key, typeIri: type.iri },
      ));
      continue;
    }
    const aliases = attributeAliases.get(attributeIri) || [];
    aliases.push(key);
    attributeAliases.set(attributeIri, aliases);
    const count = valueCount(attributes[key]);
    attributeCounts.set(attributeIri, (attributeCounts.get(attributeIri) || 0) + count);
  }
  for (const [attributeIri, aliases] of attributeAliases) {
    if (aliases.length > 1) {
      diagnostics.push(diagnostic(
        'error',
        'PTO_FIXTURE_DUPLICATE_ATTRIBUTE_ALIAS',
        `${path}.attributes`,
        'one ontology attribute is supplied through more than one alias',
        { attributeIri, aliases: aliases.sort(compareAscii) },
      ));
    }
  }

  for (const field of type.attributeDescriptors) {
    const count = attributeCounts.get(field.iri) || 0;
    if (count > 0) {
      result.usedAttributes.push({
        iri: field.iri,
        localName: field.localName,
        count,
      });
    }
    if (field.directMinCount > count) {
      const missing = {
        iri: field.iri,
        localName: field.localName,
        minCount: field.directMinCount,
        actualCount: count,
      };
      result.missingRequiredAttributes.push(missing);
      diagnostics.push(diagnostic(
        'error',
        'PTO_FIXTURE_AUTHORED_ATTRIBUTE_REQUIRED',
        `${path}.attributes`,
        'required authored attribute is missing',
        missing,
      ));
    }
    if (field.patternMinCount > count) {
      const missing = {
        iri: field.iri,
        localName: field.localName,
        minCount: field.patternMinCount,
        actualCount: count,
        boundPatternIris: field.boundPatternIris,
        declaringPatternIris: field.declaringPatternIris,
      };
      result.missingRequiredPatternFields.push(missing);
      diagnostics.push(diagnostic(
        'error',
        'PTO_FIXTURE_PATTERN_FIELD_REQUIRED',
        `${path}.attributes`,
        'required TemporalFact/ProvenancedFact injected field is missing',
        missing,
      ));
    }
    if (
      field.declaringPatternIris.length > 0
      && field.patternMinCount === 0
      && count === 0
    ) {
      result.absentOptionalPatternFields.push({
        iri: field.iri,
        localName: field.localName,
        boundPatternIris: field.boundPatternIris,
        declaringPatternIris: field.declaringPatternIris,
      });
    }
    const maximums = [field.directMaxCount, field.patternMaxCount]
      .filter((maximum) => maximum !== null);
    const maxCount = maximums.length > 0 ? Math.min(...maximums) : null;
    if (maxCount !== null && count > maxCount) {
      diagnostics.push(diagnostic(
        'error',
        'PTO_FIXTURE_ATTRIBUTE_CARDINALITY',
        `${path}.attributes`,
        'attribute exceeds authored or pattern-injected maximum cardinality',
        { iri: field.iri, localName: field.localName, maxCount, actualCount: count },
      ));
    }
  }

  const roleCounts = new Map();
  const roleAliases = new Map();
  for (const key of Object.keys(roles).sort(compareAscii)) {
    const roleId = type.roleKeyToId.get(key);
    if (!roleId) {
      diagnostics.push(diagnostic(
        'error',
        'PTO_FIXTURE_UNKNOWN_ROLE',
        appendPath(`${path}.roles`, key),
        'role is not authored on the claimed ontology type',
        { field: key, typeIri: type.iri },
      ));
      continue;
    }
    const aliases = roleAliases.get(roleId) || [];
    aliases.push(key);
    roleAliases.set(roleId, aliases);
    const count = valueCount(roles[key]);
    roleCounts.set(roleId, (roleCounts.get(roleId) || 0) + count);
  }
  for (const [roleId, aliases] of roleAliases) {
    if (aliases.length > 1) {
      diagnostics.push(diagnostic(
        'error',
        'PTO_FIXTURE_DUPLICATE_ROLE_ALIAS',
        `${path}.roles`,
        'one ontology role is supplied through more than one alias',
        { roleId, aliases: aliases.sort(compareAscii) },
      ));
    }
  }
  for (const role of type.roleDescriptors) {
    const count = roleCounts.get(role.id) || 0;
    if (count > 0) {
      result.usedRoles.push({
        id: role.id,
        targetIri: role.targetIri,
        range: role.range,
        count,
      });
    }
    if (role.minCount > count) {
      const missing = {
        id: role.id,
        targetIri: role.targetIri,
        minCount: role.minCount,
        actualCount: count,
      };
      result.missingRequiredRoles.push(missing);
      diagnostics.push(diagnostic(
        'error',
        'PTO_FIXTURE_AUTHORED_ROLE_REQUIRED',
        `${path}.roles`,
        'required authored participant role is missing',
        missing,
      ));
    }
    if (role.maxCount !== null && count > role.maxCount) {
      diagnostics.push(diagnostic(
        'error',
        'PTO_FIXTURE_ROLE_CARDINALITY',
        `${path}.roles`,
        'role exceeds authored maximum cardinality',
        { id: role.id, targetIri: role.targetIri, maxCount: role.maxCount, actualCount: count },
      ));
    }
  }

  result.usedAttributes.sort((left, right) => compareAscii(left.iri, right.iri));
  result.usedRoles.sort((left, right) => compareAscii(left.id, right.id));
  result.missingRequiredAttributes.sort((left, right) => compareAscii(left.iri, right.iri));
  result.missingRequiredRoles.sort((left, right) => compareAscii(left.id, right.id));
  result.missingRequiredPatternFields.sort((left, right) => compareAscii(left.iri, right.iri));
  result.absentOptionalPatternFields.sort((left, right) => compareAscii(left.iri, right.iri));
  return { result, diagnostics };
}

function validateCoverageDeclaration(fixtureDocument, typedRecordCount) {
  const diagnostics = [];
  const declaration = fixtureDocument.ontologyCoverage;
  if (declaration === undefined) {
    diagnostics.push(diagnostic(
      'pending',
      'PTO_FIXTURE_COVERAGE_DECLARATION_MISSING',
      '$.ontologyCoverage',
      'fixture does not declare a complete authored-ontology coverage inventory',
    ));
    return diagnostics;
  }
  if (!isPlainObject(declaration)) {
    diagnostics.push(diagnostic(
      'error',
      'PTO_FIXTURE_COVERAGE_DECLARATION',
      '$.ontologyCoverage',
      'ontologyCoverage must be a closed object',
    ));
    return diagnostics;
  }
  const unknown = Object.keys(declaration)
    .filter((field) => !COVERAGE_DECLARATION_FIELDS.has(field))
    .sort(compareAscii);
  for (const field of unknown) {
    diagnostics.push(diagnostic(
      'error',
      'PTO_FIXTURE_COVERAGE_DECLARATION',
      appendPath('$.ontologyCoverage', field),
      'unknown ontologyCoverage field',
      { field },
    ));
  }
  if (declaration.profile !== COVERAGE_PROFILE) {
    diagnostics.push(diagnostic(
      'error',
      'PTO_FIXTURE_COVERAGE_PROFILE',
      '$.ontologyCoverage.profile',
      'ontology coverage profile is absent or unsupported',
      { expected: COVERAGE_PROFILE, actual: String(declaration.profile) },
    ));
  }
  if (declaration.completeness !== 'complete') {
    diagnostics.push(diagnostic(
      declaration.completeness === 'partial' ? 'pending' : 'error',
      'PTO_FIXTURE_COVERAGE_INCOMPLETE',
      '$.ontologyCoverage.completeness',
      'ontology coverage must be explicitly complete before diagnostic conformance',
      { actual: String(declaration.completeness) },
    ));
  }
  if (!Number.isSafeInteger(declaration.recordCount) || declaration.recordCount < 0) {
    diagnostics.push(diagnostic(
      'error',
      'PTO_FIXTURE_COVERAGE_RECORD_COUNT',
      '$.ontologyCoverage.recordCount',
      'recordCount must be a non-negative safe integer',
    ));
  } else if (declaration.recordCount !== typedRecordCount) {
    diagnostics.push(diagnostic(
      'error',
      'PTO_FIXTURE_COVERAGE_RECORD_COUNT',
      '$.ontologyCoverage.recordCount',
      'declared recordCount does not equal the exact discovered tagged record count',
      { expected: typedRecordCount, actual: declaration.recordCount },
    ));
  }
  return diagnostics;
}

function sortDiagnostics(diagnostics) {
  return diagnostics.sort((left, right) => (
    compareAscii(left.path, right.path)
    || compareAscii(left.code, right.code)
    || compareAscii(canonicalJcs(left), canonicalJcs(right))
  ));
}

function auditPostTradeFixtureOntologyCoverage({
  ontologyDocument,
  patternDocument,
  fixtureDocument,
  fixtureRef = '<memory>',
} = {}) {
  if (!isPlainObject(fixtureDocument)) {
    fail('PTO_FIXTURE_DOCUMENT_SHAPE', 'fixtureDocument must be a plain object');
  }
  if (typeof fixtureRef !== 'string' || fixtureRef.length === 0) {
    fail('PTO_FIXTURE_DOCUMENT_SHAPE', 'fixtureRef must be a non-empty string');
  }

  const patternsByIri = buildPatternIndex(patternDocument);
  const ontologyIndex = buildOntologyIndex(ontologyDocument, patternsByIri);
  const scan = scanFixtureDocument(
    fixtureDocument,
    ontologyIndex.sharedRequiredPatternFields,
  );
  const diagnostics = validateCoverageDeclaration(fixtureDocument, scan.typedRecords.length);

  if (scan.typedRecords.length === 0) {
    diagnostics.push(diagnostic(
      'pending',
      'PTO_FIXTURE_TYPE_TAGS_MISSING',
      '$',
      'fixture contains no explicit ontologyType tags; private keys cannot be safely mapped by inference',
      { recordLikeObjectCount: scan.untypedRecordCandidates.length },
    ));
  }
  if (scan.untypedRecordCandidates.length > 0) {
    diagnostics.push(diagnostic(
      'pending',
      'PTO_FIXTURE_UNTYPED_RECORD_CANDIDATE',
      '$',
      'record-like objects remain outside typed authored-ontology envelopes',
      { count: scan.untypedRecordCandidates.length },
    ));
  }

  const records = [];
  for (const recordEntry of scan.typedRecords) {
    const validation = validateRecord(recordEntry, ontologyIndex);
    records.push(validation.result);
    diagnostics.push(...validation.diagnostics);
  }
  sortDiagnostics(diagnostics);

  const errorCount = diagnostics.filter((item) => item.severity === 'error').length;
  const pendingCount = diagnostics.filter((item) => item.severity === 'pending').length;
  const status = errorCount > 0
    ? 'failed'
    : pendingCount > 0
      ? 'pending-type-migration'
      : 'diagnostic-conformant';

  const reportCore = {
    profile: COVERAGE_PROFILE,
    fixtureRef,
    ontologyModuleIri: ontologyDocument.module?.moduleIri || null,
    ontologyVersion: ontologyDocument.module?.version || null,
    status,
    ok: status === 'diagnostic-conformant',
    coverageComplete: status === 'diagnostic-conformant',
    diagnosticOnly: true,
    approvalEligible: false,
    releaseEvidence: false,
    authoredTypeCount: ontologyIndex.byIri.size,
    ontologyAttributeAliasAmbiguities: ontologyIndex.ambiguousAttributeAliases,
    sharedRequiredPatternFields: ontologyIndex.sharedRequiredPatternFields,
    objectCount: scan.objectCount,
    typedRecordCount: scan.typedRecords.length,
    untypedRecordCandidateCount: scan.untypedRecordCandidates.length,
    errorCount,
    pendingCount,
    records,
    untypedRecordCandidates: scan.untypedRecordCandidates,
    diagnostics,
    minimumMigrationPlan: MINIMUM_MIGRATION_PLAN,
  };
  return Object.freeze({
    ...reportCore,
    diagnosticDigest: sha256Utf8(canonicalJcs(reportCore)),
  });
}

module.exports = {
  COVERAGE_PROFILE,
  MINIMUM_MIGRATION_PLAN,
  PostTradeFixtureCoverageError,
  auditPostTradeFixtureOntologyCoverage,
};
