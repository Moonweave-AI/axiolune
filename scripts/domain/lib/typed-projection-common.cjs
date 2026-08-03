'use strict';

const crypto = require('node:crypto');
const { DataFactory, Writer } = require('n3');
const {
  directSparqlSelectError,
} = require('./direct-sparql-select.cjs');
const {
  patternInjectedAttributeUseCollisions,
} = require('./pattern-injected-fields.cjs');

const { blankNode, literal, namedNode, quad } = DataFactory;

const NS = Object.freeze({
  DCTERMS: 'http://purl.org/dc/terms/',
  OWL: 'http://www.w3.org/2002/07/owl#',
  RDF: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  RDFS: 'http://www.w3.org/2000/01/rdf-schema#',
  SH: 'http://www.w3.org/ns/shacl#',
  SKOS: 'http://www.w3.org/2004/02/skos/core#',
  XSD: 'http://www.w3.org/2001/XMLSchema#',
});

const MONEY = Object.freeze({
  classIri: 'https://axiolune.ai/ontology/meta/core/values/MonetaryAmount',
  amount: 'https://axiolune.ai/ontology/meta/core/properties/hasAmount',
  currency: 'https://axiolune.ai/ontology/meta/core/properties/hasCurrency',
  scale: 'https://axiolune.ai/ontology/meta/core/properties/hasScale',
});

const QUANTITY = Object.freeze({
  classIri: 'https://axiolune.ai/ontology/meta/core/values/QuantityValue',
  value: 'https://axiolune.ai/ontology/meta/core/properties/hasNumericValue',
  unit: 'https://axiolune.ai/ontology/meta/core/properties/hasUnit',
  precision: 'https://axiolune.ai/ontology/meta/core/properties/hasPrecision',
  rounding: 'https://axiolune.ai/ontology/meta/core/properties/hasRounding',
});

const PATTERNS = Object.freeze({
  temporal: 'https://axiolune.ai/ontology/meta/patterns/TemporalFact',
  provenance: 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact',
  temporalObservation: 'https://axiolune.ai/ontology/meta/patterns/TemporalObservation',
});

const FACT_IDENTITY = 'https://axiolune.ai/ontology/meta/data-binding/FactIdentity';
const FACT_VERSION = 'https://axiolune.ai/ontology/meta/data-binding/FactVersion';
const VERSION_OF = 'https://axiolune.ai/ontology/meta/data-binding/properties/versionOf';
const SOURCE_EVIDENCE =
  'https://axiolune.ai/ontology/meta/core/annotations/sourceEvidenceRef';

const TEMPORAL_FIELDS = Object.freeze({
  validFrom: 'https://axiolune.ai/ontology/meta/patterns/attributes/validFrom',
  validTo: 'https://axiolune.ai/ontology/meta/patterns/attributes/validTo',
  knowledgeFrom: 'https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeFrom',
  knowledgeTo: 'https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeTo',
  availableFrom: 'https://axiolune.ai/ontology/meta/patterns/attributes/availableFrom',
  availableTo: 'https://axiolune.ai/ontology/meta/patterns/attributes/availableTo',
});

const PROVENANCE_FIELDS = Object.freeze({
  source: 'https://axiolune.ai/ontology/meta/patterns/attributes/source',
  revision: 'https://axiolune.ai/ontology/meta/patterns/attributes/revision',
});

const PRIMITIVE_RANGES = Object.freeze({
  string: `${NS.XSD}string`,
  decimal: `${NS.XSD}decimal`,
  integer: `${NS.XSD}integer`,
  boolean: `${NS.XSD}boolean`,
  date: `${NS.XSD}date`,
  instant: `${NS.XSD}dateTimeStamp`,
  duration: `${NS.XSD}duration`,
  uri: `${NS.XSD}anyURI`,
});
const PROHIBITED_LOCAL_STRUCTURED_VALUES = new Set([
  'Money', 'MonetaryAmount', 'Quantity', 'QuantityValue',
]);

const DOMAIN_CONTAINERS = Object.freeze([
  'objectTypes',
  'associationTypes',
  'relationTypes',
  'attributeTypes',
  'identifierTypes',
  'codeLists',
  'constraints',
  'relationUses',
  'constraintBindings',
]);

const COMMON_FIELDS = ['iri', 'namespace', 'localName', 'label', 'definition'];
const FIELDS_BY_CONTAINER = Object.freeze({
  objectTypes: new Set([
    ...COMMON_FIELDS, 'superTypes', 'attributeUses', 'patternBindings',
    'alignments', 'governance', 'abstract',
  ]),
  associationTypes: new Set([
    ...COMMON_FIELDS, 'participantRoles', 'attributeUses', 'patternBindings',
    'projectedRelations', 'alignments',
  ]),
  relationTypes: new Set([
    ...COMMON_FIELDS, 'domain', 'range', 'inverseOf', 'characteristics',
    'alignments',
  ]),
  attributeTypes: new Set([
    ...COMMON_FIELDS, 'valueType', 'owlProjectionOverride',
    'defaultCardinality', 'enumValues', 'pattern', 'unit', 'alignments',
  ]),
  identifierTypes: new Set([
    ...COMMON_FIELDS, 'baseType', 'standard', 'validatorRef',
    'issuingAuthority', 'alignments',
  ]),
  codeLists: new Set([
    ...COMMON_FIELDS, 'vocabulary', 'version', 'maintainer',
    'sourceEvidenceRef', 'values', 'alignments',
  ]),
  constraints: new Set([
    ...COMMON_FIELDS, 'constraintType', 'scope', 'expression', 'severity',
    'message', 'targetElement', 'note', 'parameters',
  ]),
});

const REQUIRED_BY_CONTAINER = Object.freeze({
  objectTypes: COMMON_FIELDS,
  associationTypes: [...COMMON_FIELDS, 'participantRoles'],
  relationTypes: [...COMMON_FIELDS, 'domain', 'range'],
  attributeTypes: [...COMMON_FIELDS, 'valueType'],
  identifierTypes: [...COMMON_FIELDS, 'baseType', 'standard', 'validatorRef'],
  codeLists: [
    ...COMMON_FIELDS, 'vocabulary', 'version', 'maintainer',
    'sourceEvidenceRef',
  ],
  constraints: [
    ...COMMON_FIELDS, 'constraintType', 'scope', 'expression', 'severity',
    'message',
  ],
});

class ProjectionInputError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'ProjectionInputError';
    this.code = 'M2-PROJECTION-INPUT';
    this.path = path;
  }
}

function fail(path, message) {
  throw new ProjectionInputError(path, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertObject(value, path) {
  if (!isObject(value)) fail(path, 'must be an object');
}

function assertArray(value, path) {
  if (!Array.isArray(value)) fail(path, 'must be an array');
}

function assertExactKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'field is not allowed by the strict M3 type');
  }
}

function requireFields(value, fields, path) {
  for (const field of fields) {
    if (!hasOwn(value, field) || value[field] === undefined || value[field] === null
        || value[field] === '') {
      fail(`${path}.${field}`, 'required field is missing');
    }
  }
}

function assertAbsoluteIri(value, path) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u.test(value)) {
    fail(path, 'must be an absolute IRI');
  }
}

function byteCompare(left, right) {
  return Buffer.compare(
    Buffer.from(String(left).normalize('NFC'), 'utf8'),
    Buffer.from(String(right).normalize('NFC'), 'utf8'),
  );
}

function assertCardinality(value, path, allowNull = false) {
  if (allowNull && value === null) return;
  if (!Number.isInteger(value) || value < 0) {
    fail(path, allowNull
      ? 'must be a non-negative integer or null'
      : 'must be a non-negative integer');
  }
}

function validateAttributeUse(use, path) {
  assertObject(use, path);
  assertExactKeys(
    use,
    new Set(['attribute', 'minCount', 'maxCount', 'label', 'defaultValue', 'constraints']),
    path,
  );
  requireFields(use, ['attribute'], path);
  assertAbsoluteIri(use.attribute, `${path}.attribute`);
  if (hasOwn(use, 'minCount')) assertCardinality(use.minCount, `${path}.minCount`);
  if (hasOwn(use, 'maxCount')) assertCardinality(use.maxCount, `${path}.maxCount`, true);
  if (Number.isInteger(use.minCount) && Number.isInteger(use.maxCount)
      && use.minCount > use.maxCount) {
    fail(path, 'minCount must not exceed maxCount');
  }
}

function validatePatternBinding(binding, path) {
  assertObject(binding, path);
  assertExactKeys(binding, new Set(['pattern', 'parameters']), path);
  requireFields(binding, ['pattern'], path);
  assertAbsoluteIri(binding.pattern, `${path}.pattern`);
  if (binding.pattern === PATTERNS.temporalObservation) {
    fail(`${path}.pattern`, 'TemporalObservation is prohibited by RFC-001 §5.8');
  }
}

function validateAlignments(alignments, path, containerName) {
  if (alignments === undefined) return;
  assertArray(alignments, path);
  const allowed = new Set([
    'vocabulary', 'targetIri', 'relation', 'sourceRelease', 'sourceLocator',
    'rationale', 'verification',
  ]);
  const relations = new Set([
    'rdfs:subClassOf', 'rdfs:subPropertyOf', 'owl:equivalentClass',
    'owl:equivalentProperty', 'skos:closeMatch', 'skos:exactMatch',
    'skos:broadMatch', 'skos:narrowMatch', 'skos:relatedMatch',
  ]);
  alignments.forEach((alignment, index) => {
    const alignmentPath = `${path}[${index}]`;
    assertObject(alignment, alignmentPath);
    assertExactKeys(alignment, allowed, alignmentPath);
    requireFields(alignment, ['vocabulary', 'targetIri', 'relation'], alignmentPath);
    assertAbsoluteIri(alignment.targetIri, `${alignmentPath}.targetIri`);
    if (!relations.has(alignment.relation)) {
      fail(`${alignmentPath}.relation`, 'unsupported M3 Alignment relation');
    }
    const classRelations = new Set(['rdfs:subClassOf', 'owl:equivalentClass']);
    const propertyRelations = new Set(['rdfs:subPropertyOf', 'owl:equivalentProperty']);
    if (containerName === 'identifierTypes') {
      fail(
        `${alignmentPath}.relation`,
        'IdentifierTypeDefinition projects to rdfs:Datatype; align its scheme-bound identifier value ObjectType instead',
      );
    }
    if (classRelations.has(alignment.relation)
        && !['objectTypes', 'associationTypes'].includes(containerName)) {
      fail(`${alignmentPath}.relation`, 'class alignment requires an OWL class projection');
    }
    if (propertyRelations.has(alignment.relation)
        && !['relationTypes', 'attributeTypes'].includes(containerName)) {
      fail(`${alignmentPath}.relation`, 'property alignment requires an OWL property projection');
    }
    if (alignment.relation.startsWith('skos:')) {
      fail(
        `${alignmentPath}.relation`,
        'SKOS mappings require an actual CodeValueDefinition/skos:Concept; '
          + 'CodeListTypeDefinition projects to owl:Class and the v0.3 authoring schema has no value-level Alignment field',
      );
    }
  });
}

function validateRole(role, path, exported) {
  assertObject(role, path);
  assertExactKeys(
    role,
    new Set(['id', 'range', 'minCount', 'maxCount', 'label', 'definition']),
    path,
  );
  requireFields(role, ['id', 'range', 'minCount'], path);
  if (!hasOwn(role, 'maxCount')) fail(`${path}.maxCount`, 'required field is missing');
  if (typeof role.id !== 'string' || !/^[a-z][A-Za-z0-9]*$/.test(role.id)) {
    fail(`${path}.id`, 'must be an RFC-001 lowerCamelCase ASCII role id');
  }
  assertAbsoluteIri(role.range, `${path}.range`);
  assertCardinality(role.minCount, `${path}.minCount`);
  assertCardinality(role.maxCount, `${path}.maxCount`, true);
  if (Number.isInteger(role.maxCount) && role.minCount > role.maxCount) {
    fail(path, 'minCount must not exceed maxCount');
  }
  if (exported) requireFields(role, ['label', 'definition'], path);
}

function validateCodeValues(codeList, path, globalIris) {
  if (!hasOwn(codeList, 'values')) return;
  assertArray(codeList.values, `${path}.values`);
  const memberByIri = new Map();
  const notations = new Set();
  const allowed = new Set([
    'iri', 'notation', 'label', 'definition', 'deprecated', 'replacedBy',
    'sourceEvidenceRef',
  ]);

  codeList.values.forEach((member, index) => {
    const memberPath = `${path}.values[${index}]`;
    assertObject(member, memberPath);
    assertExactKeys(member, allowed, memberPath);
    requireFields(member, ['iri', 'notation', 'label', 'definition'], memberPath);
    assertAbsoluteIri(member.iri, `${memberPath}.iri`);
    if (!member.iri.startsWith(`${codeList.iri}/value/`)) {
      fail(`${memberPath}.iri`, `must be below ${codeList.iri}/value/`);
    }
    if (globalIris.has(member.iri)) fail(`${memberPath}.iri`, 'duplicate generated/member IRI');
    globalIris.add(member.iri);
    if (typeof member.notation !== 'string' || member.notation.length === 0) {
      fail(`${memberPath}.notation`, 'must be a non-empty string');
    }
    if (notations.has(member.notation)) {
      fail(`${memberPath}.notation`, 'must be unique within its code list');
    }
    notations.add(member.notation);
    if (hasOwn(member, 'deprecated') && typeof member.deprecated !== 'boolean') {
      fail(`${memberPath}.deprecated`, 'must be boolean');
    }
    if (member.replacedBy !== undefined) {
      if (member.deprecated !== true) {
        fail(`${memberPath}.replacedBy`, 'is legal only when deprecated is true');
      }
      assertAbsoluteIri(member.replacedBy, `${memberPath}.replacedBy`);
      if (member.replacedBy === member.iri) fail(`${memberPath}.replacedBy`, 'cannot replace itself');
    }
    if (member.sourceEvidenceRef !== undefined) {
      assertAbsoluteIri(member.sourceEvidenceRef, `${memberPath}.sourceEvidenceRef`);
    }
    memberByIri.set(member.iri, { member, path: memberPath });
  });

  for (const { member, path: memberPath } of memberByIri.values()) {
    if (!member.replacedBy || !memberByIri.has(member.replacedBy)) continue;
    const target = memberByIri.get(member.replacedBy).member;
    if (target.deprecated === true) {
      fail(`${memberPath}.replacedBy`, 'must target a non-deprecated local member');
    }
  }
}

function validateElement(element, key, containerName, path, model, globalIris) {
  assertObject(element, path);
  assertExactKeys(element, FIELDS_BY_CONTAINER[containerName], path);
  requireFields(element, REQUIRED_BY_CONTAINER[containerName], path);
  if (element.localName !== key) fail(`${path}.localName`, `must equal map key ${key}`);
  if (element.namespace !== model.module.preferredPrefix) {
    fail(`${path}.namespace`, 'must equal module.preferredPrefix');
  }
  assertAbsoluteIri(element.iri, `${path}.iri`);
  if (element.iri !== `${model.module.baseIri}${key}`) {
    fail(`${path}.iri`, 'must equal module.baseIri + localName');
  }
  if (globalIris.has(element.iri)) fail(`${path}.iri`, 'duplicate element IRI');
  globalIris.add(element.iri);

  const attributeUses = new Set();
  for (const [index, use] of (element.attributeUses || []).entries()) {
    validateAttributeUse(use, `${path}.attributeUses[${index}]`);
    if (attributeUses.has(use.attribute)) {
      fail(`${path}.attributeUses[${index}].attribute`, 'duplicate contextual AttributeUse');
    }
    attributeUses.add(use.attribute);
  }
  const patternIris = new Set();
  for (const [index, binding] of (element.patternBindings || []).entries()) {
    validatePatternBinding(binding, `${path}.patternBindings[${index}]`);
    if (patternIris.has(binding.pattern)) {
      fail(`${path}.patternBindings[${index}].pattern`, 'duplicate pattern binding');
    }
    patternIris.add(binding.pattern);
  }
  for (const collision of patternInjectedAttributeUseCollisions(element)) {
    fail(
      `${path}.attributeUses[${collision.attributeUseIndex}].attribute`,
      `duplicates field injected by pattern ${collision.pattern}`,
    );
  }
  validateAlignments(element.alignments, `${path}.alignments`, containerName);

  if (containerName === 'associationTypes') {
    assertArray(element.participantRoles, `${path}.participantRoles`);
    if (element.participantRoles.length < 2) {
      fail(`${path}.participantRoles`, 'must contain at least two roles');
    }
    const ids = new Set();
    const exported = model.exportAll || model.exports.has(element.iri);
    element.participantRoles.forEach((role, index) => {
      validateRole(role, `${path}.participantRoles[${index}]`, exported);
      if (ids.has(role.id)) fail(`${path}.participantRoles[${index}].id`, 'duplicate role id');
      ids.add(role.id);
      const roleIri = `${element.iri}/role/${role.id}`;
      if (globalIris.has(roleIri)) fail(`${path}.participantRoles[${index}]`, 'derived role predicate collides');
      globalIris.add(roleIri);
    });
  }
  if (containerName === 'objectTypes'
      && PROHIBITED_LOCAL_STRUCTURED_VALUES.has(element.localName)) {
    fail(path, 'local Money/Quantity classes are prohibited; use the canonical M3 value classes');
  }
  if (containerName === 'objectTypes'
      && hasOwn(element, 'abstract')
      && typeof element.abstract !== 'boolean') {
    fail(`${path}.abstract`, 'must be boolean');
  }
  if (containerName === 'relationTypes') {
    assertAbsoluteIri(element.domain, `${path}.domain`);
    assertAbsoluteIri(element.range, `${path}.range`);
  }
  if (containerName === 'attributeTypes') {
    if (typeof element.valueType !== 'string' || element.valueType.length === 0) {
      fail(`${path}.valueType`, 'must be a non-empty primitive name or absolute IRI');
    }
    if (!PRIMITIVE_RANGES[element.valueType]) {
      assertAbsoluteIri(element.valueType, `${path}.valueType`);
    }
    if (element.valueType === 'codelist') {
      fail(`${path}.valueType`, 'literal codelist encoding is prohibited by RFC-001 §5.6');
    }
  }
  if (containerName === 'identifierTypes') {
    if (!PRIMITIVE_RANGES[element.baseType]) {
      fail(`${path}.baseType`, 'must be a supported primitive value type');
    }
    assertAbsoluteIri(element.validatorRef, `${path}.validatorRef`);
  }
  if (containerName === 'codeLists') {
    assertAbsoluteIri(element.sourceEvidenceRef, `${path}.sourceEvidenceRef`);
    const schemeIri = `${element.iri}/scheme`;
    if (globalIris.has(schemeIri)) fail(path, 'derived concept-scheme IRI collides');
    globalIris.add(schemeIri);
    validateCodeValues(element, path, globalIris);
  }
  if (containerName === 'constraints') {
    assertObject(element.expression, `${path}.expression`);
    assertExactKeys(
      element.expression,
      new Set(['language', 'expression']),
      `${path}.expression`,
    );
    requireFields(element.expression, ['language', 'expression'], `${path}.expression`);
    if (!['SHACL', 'SPARQL', 'JSONSchema', 'Regex', 'Custom'].includes(element.expression.language)) {
      fail(`${path}.expression.language`, 'must be a supported ConstraintExpression language');
    }
    if (typeof element.expression.expression !== 'string'
        || element.expression.expression.length === 0) {
      fail(`${path}.expression.expression`, 'must be a non-empty string');
    }
    if (element.expression.language === 'SPARQL') {
      const sparqlError = directSparqlSelectError(element.expression.expression);
      if (sparqlError) {
        fail(
          `${path}.expression.expression`,
          `unsupported direct SPARQL SELECT: ${sparqlError}`,
        );
      }
    }
  }
}

function validateRelationUse(use, index) {
  const path = `domain.relationUses[${index}]`;
  assertObject(use, path);
  assertExactKeys(
    use,
    new Set([
      'relation', 'subjectType', 'objectType', 'outboundCardinality',
      'inboundCardinality', 'constraints',
    ]),
    path,
  );
  requireFields(use, ['relation', 'subjectType', 'objectType'], path);
  for (const field of ['relation', 'subjectType', 'objectType']) {
    assertAbsoluteIri(use[field], `${path}.${field}`);
  }
  for (const cardinalityName of ['outboundCardinality', 'inboundCardinality']) {
    if (use[cardinalityName] === undefined) continue;
    const cardinality = use[cardinalityName];
    assertObject(cardinality, `${path}.${cardinalityName}`);
    assertExactKeys(cardinality, new Set(['minCount', 'maxCount']), `${path}.${cardinalityName}`);
    if (hasOwn(cardinality, 'minCount')) {
      assertCardinality(cardinality.minCount, `${path}.${cardinalityName}.minCount`);
    }
    if (hasOwn(cardinality, 'maxCount')) {
      assertCardinality(cardinality.maxCount, `${path}.${cardinalityName}.maxCount`, true);
    }
  }
}

function validateConstraintBinding(binding, index) {
  const path = `domain.constraintBindings[${index}]`;
  assertObject(binding, path);
  assertExactKeys(
    binding,
    new Set([
      'constraintRef', 'targetElement', 'parameters', 'enforcementLevel',
      'enforcementContext',
    ]),
    path,
  );
  requireFields(binding, ['constraintRef', 'targetElement'], path);
  assertAbsoluteIri(binding.constraintRef, `${path}.constraintRef`);
  assertAbsoluteIri(binding.targetElement, `${path}.targetElement`);
}

function validateDocument(document) {
  assertObject(document, '$');
  assertExactKeys(document, new Set(['module', 'domain']), '$');
  requireFields(document, ['module', 'domain'], '$');
  assertObject(document.module, 'module');
  assertExactKeys(
    document.module,
    new Set([
      'moduleIri', 'baseIri', 'preferredPrefix', 'version', 'label',
      'definition', 'imports', 'exports', 'status', 'governance',
    ]),
    'module',
  );
  requireFields(
    document.module,
    [
      'moduleIri', 'baseIri', 'preferredPrefix', 'version', 'label',
      'definition', 'imports', 'exports', 'status', 'governance',
    ],
    'module',
  );
  assertAbsoluteIri(document.module.moduleIri, 'module.moduleIri');
  assertAbsoluteIri(document.module.baseIri, 'module.baseIri');
  if (!document.module.baseIri.endsWith('/')) fail('module.baseIri', 'must end with /');
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(document.module.preferredPrefix)) {
    fail('module.preferredPrefix', 'must be an ASCII prefix');
  }
  assertArray(document.module.imports, 'module.imports');
  const importedAliases = new Map();
  document.module.imports.forEach((moduleImport, index) => {
    const importPath = `module.imports[${index}]`;
    assertObject(moduleImport, importPath);
    assertExactKeys(
      moduleImport,
      new Set(['moduleIri', 'version', 'importMode', 'importedSymbols', 'artifactDigest']),
      importPath,
    );
    requireFields(
      moduleImport,
      ['moduleIri'],
      importPath,
    );
    assertAbsoluteIri(moduleImport.moduleIri, `${importPath}.moduleIri`);
    if (moduleImport.importedSymbols !== undefined) {
      assertArray(moduleImport.importedSymbols, `${importPath}.importedSymbols`);
      const importedIris = new Set();
      moduleImport.importedSymbols.forEach((symbol, symbolIndex) => {
        const symbolPath = `${importPath}.importedSymbols[${symbolIndex}]`;
        assertObject(symbol, symbolPath);
        assertExactKeys(symbol, new Set(['symbolIri', 'localAlias']), symbolPath);
        requireFields(symbol, ['symbolIri'], symbolPath);
        assertAbsoluteIri(symbol.symbolIri, `${symbolPath}.symbolIri`);
        if (importedIris.has(symbol.symbolIri)) {
          fail(`${symbolPath}.symbolIri`, 'must be unique within importedSymbols');
        }
        importedIris.add(symbol.symbolIri);
        if (symbol.localAlias !== undefined) {
          if (typeof symbol.localAlias !== 'string' || symbol.localAlias.length === 0
              || symbol.localAlias !== symbol.localAlias.normalize('NFC')) {
            fail(`${symbolPath}.localAlias`, 'must be a non-empty string authored in Unicode NFC');
          }
          const aliasKey = symbol.localAlias.normalize('NFC');
          if (importedAliases.has(aliasKey)) {
            fail(`${symbolPath}.localAlias`, 'must be unique across module imports');
          }
          importedAliases.set(aliasKey, `${symbolPath}.localAlias`);
        }
      });
    }
  });
  assertArray(document.module.exports, 'module.exports');
  document.module.exports.forEach((iri, index) => (
    assertAbsoluteIri(iri, `module.exports[${index}]`)
  ));

  assertObject(document.domain, 'domain');
  const domainKeys = Object.keys(document.domain);
  const missing = DOMAIN_CONTAINERS.filter((key) => !domainKeys.includes(key));
  const extra = domainKeys.filter((key) => !DOMAIN_CONTAINERS.includes(key));
  if (missing.length || extra.length) {
    fail(
      'domain',
      `M2-TYPED-CONTAINERS-REQUIRED missing=[${missing.join(',')}] extra=[${extra.join(',')}]`,
    );
  }

  const model = {
    document,
    module: document.module,
    domain: document.domain,
    exportAll: document.module.exports.length === 0,
    exports: new Set(document.module.exports),
    symbols: new Map(),
  };
  const globalIris = new Set([document.module.moduleIri]);

  for (const containerName of DOMAIN_CONTAINERS.slice(0, 7)) {
    const container = document.domain[containerName];
    assertObject(container, `domain.${containerName}`);
    for (const [key, element] of Object.entries(container)) {
      const path = `domain.${containerName}.${key}`;
      validateElement(element, key, containerName, path, model, globalIris);
      model.symbols.set(element.iri, { kind: containerName, element });
    }
  }
  const localNameKeys = new Set(
    [...model.symbols.values()].map(({ element }) => element.localName.normalize('NFC')),
  );
  for (const [aliasKey, aliasPath] of importedAliases) {
    if (localNameKeys.has(aliasKey)) {
      fail(aliasPath, 'must not collide with an authored localName after Unicode NFC normalization');
    }
  }
  assertArray(document.domain.relationUses, 'domain.relationUses');
  const relationUseKeys = new Set();
  document.domain.relationUses.forEach((use, index) => {
    validateRelationUse(use, index);
    const key = `${use.relation}\0${use.subjectType}\0${use.objectType}`;
    if (relationUseKeys.has(key)) {
      fail(`domain.relationUses[${index}]`, 'duplicate contextual RelationUse tuple');
    }
    relationUseKeys.add(key);
  });
  assertArray(document.domain.constraintBindings, 'domain.constraintBindings');
  const bindingKeys = new Set();
  document.domain.constraintBindings.forEach((binding, index) => {
    validateConstraintBinding(binding, index);
    const key = `${binding.constraintRef}\0${binding.targetElement}`;
    if (bindingKeys.has(key)) {
      fail(`domain.constraintBindings[${index}]`, 'duplicate ConstraintBinding');
    }
    bindingKeys.add(key);
  });

  for (const [localName, constraint] of Object.entries(document.domain.constraints)) {
    if (constraint.expression?.language !== 'Custom') continue;
    const bindings = document.domain.constraintBindings.filter((binding) => (
      binding.constraintRef === constraint.iri
    ));
    if (constraint.targetElement) {
      if (bindings.length !== 1 || bindings[0].targetElement !== constraint.targetElement) {
        fail(
          `domain.constraints.${localName}`,
          'targeted Custom constraint requires exactly one matching top-level ConstraintBinding',
        );
      }
    } else if (bindings.length === 0) {
      fail(
        `domain.constraints.${localName}`,
        'unbound Custom constraint requires at least one top-level ConstraintBinding',
      );
    }
  }

  for (const [index, exportedIri] of document.module.exports.entries()) {
    if (!model.symbols.has(exportedIri)) {
      fail(`module.exports[${index}]`, 'must reference a symbol authored by this module');
    }
  }

  return model;
}

function sortedEntries(container) {
  return Object.entries(container).sort((a, b) => {
    const byIri = byteCompare(a[1].iri, b[1].iri);
    return byIri || byteCompare(a[0], b[0]);
  });
}

function sortedValues(values) {
  return [...(values || [])].sort((a, b) => byteCompare(a.iri, b.iri));
}

function shortDigest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}

function addTriple(quads, subject, predicate, object) {
  quads.push(quad(subject, predicate, object));
}

function addRdfList(quads, terms, seed) {
  if (terms.length === 0) return namedNode(`${NS.RDF}nil`);
  const digest = shortDigest(seed);
  const nodes = terms.map((_, index) => blankNode(`l_${digest}_${index}`));
  terms.forEach((term, index) => {
    addTriple(quads, nodes[index], namedNode(`${NS.RDF}first`), term);
    addTriple(
      quads,
      nodes[index],
      namedNode(`${NS.RDF}rest`),
      index + 1 < nodes.length ? nodes[index + 1] : namedNode(`${NS.RDF}nil`),
    );
  });
  return nodes[0];
}

function termSortKey(term) {
  return `${term.termType}\0${term.value}\0${term.language || ''}\0${term.datatype?.value || ''}`;
}

function sortQuads(quads) {
  return quads.sort((a, b) => {
    const left = [a.subject, a.predicate, a.object].map(termSortKey).join('\0');
    const right = [b.subject, b.predicate, b.object].map(termSortKey).join('\0');
    return byteCompare(left, right);
  });
}

function serializeTurtle(quads, prefixes) {
  const writer = new Writer({ prefixes });
  sortQuads(quads);
  writer.addQuads(quads);
  return new Promise((resolve, reject) => {
    writer.end((error, result) => {
      if (error) reject(error);
      else resolve(Buffer.from(result, 'utf8'));
    });
  });
}

function rolePredicate(associationIri, roleId) {
  return `${associationIri}/role/${roleId}`;
}

function attributeProjection(model, attribute) {
  const override = attribute.owlProjectionOverride;
  if (override === 'annotationProperty') {
    return { kind: 'annotation', range: valueTypeRange(model, attribute.valueType) };
  }
  if (override === 'datatypeProperty') {
    return { kind: 'datatype', range: valueTypeRange(model, attribute.valueType) };
  }
  if (override === 'objectProperty') {
    return { kind: 'object', range: attribute.valueType };
  }
  if (PRIMITIVE_RANGES[attribute.valueType]) {
    return { kind: 'datatype', range: PRIMITIVE_RANGES[attribute.valueType] };
  }
  if (attribute.valueType === MONEY.classIri || attribute.valueType === QUANTITY.classIri) {
    return { kind: 'object', range: attribute.valueType };
  }
  const target = model.symbols.get(attribute.valueType);
  if (target?.kind === 'identifierTypes') {
    return { kind: 'datatype', range: attribute.valueType };
  }
  if (target?.kind === 'codeLists') {
    return { kind: 'object', range: attribute.valueType, codeList: target.element };
  }
  return { kind: 'object', range: attribute.valueType };
}

function valueTypeRange(model, valueType) {
  if (PRIMITIVE_RANGES[valueType]) return PRIMITIVE_RANGES[valueType];
  const target = model.symbols.get(valueType);
  if (target?.kind === 'identifierTypes') return target.element.iri;
  return valueType;
}

function localName(iri) {
  const index = Math.max(iri.lastIndexOf('/'), iri.lastIndexOf('#'));
  return iri.slice(index + 1);
}

module.exports = {
  FACT_IDENTITY,
  FACT_VERSION,
  MONEY,
  NS,
  PATTERNS,
  PROVENANCE_FIELDS,
  ProjectionInputError,
  QUANTITY,
  SOURCE_EVIDENCE,
  TEMPORAL_FIELDS,
  VERSION_OF,
  addRdfList,
  addTriple,
  attributeProjection,
  blankNode,
  literal,
  localName,
  namedNode,
  rolePredicate,
  serializeTurtle,
  shortDigest,
  sortedEntries,
  sortedValues,
  validateDocument,
  valueTypeRange,
};
