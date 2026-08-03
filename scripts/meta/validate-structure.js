#!/usr/bin/env node
/**
 * Deep structural validator for the Axiolune meta-model (canonical).
 *
 * The meta-model is a heterogeneous DSL: a single top-level section mixes
 * meta-type classifiers (ObjectTypeDefinition, ...) with inline attribute
 * instances (validFrom, ...). A blanket additionalProperties:false is therefore
 * impossible by design (requiredFields/optionalFields are intentionally open maps).
 * This validator enforces the structural invariants that matter for production:
 *   - root shape (module + exactly one layer section, no unknown top-level keys)
 *   - module metadata (required fields, IRI/semver formats, import lock shape)
 *   - layer-section metadata (semver, layer range, changes)
 *   - IRI well-formedness on every `iri:` field (type defs, attributes, constraints, patterns)
 *   - required fields per kind: attribute instances, constraint definitions, pattern definitions
 *   - enum correctness on key fields
 *
 * Usage: node scripts/validate-structure.js [--strict]
 *   --strict also flags unknown fields on type-classifiers (typo detection).
 * Exit 0 if valid, 1 otherwise.
 */
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const DEFAULT_META_DIR = path.join(__dirname, '..', '..', 'ontology', 'meta');
let META_DIR = process.env.META_DIR ? path.resolve(process.env.META_DIR) : DEFAULT_META_DIR;
let STRICT = process.argv.includes('--strict');

const IRI_RE = /^https?:\/\/[^\s]+$/;
const CURIE_RE = /^[a-zA-Z][a-zA-Z0-9._-]*:[^\s]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const LAYER_SECTIONS = {
  MetaModel: { file: 'core-meta-model.yaml', layer: 1 },
  CrossDomainPatterns: { file: 'cross-domain-patterns.yaml', layer: 2 },
  PlatformBehavior: { file: 'behavior-meta-model.yaml', layer: 3 },
  DataBinding: { file: 'data-binding-meta-model.yaml', layer: 4 },
};

let errors = [];
const err = (loc, msg) => errors.push(`${loc}: ${msg}`);
let loadedDocs = new Map();
let SOURCE_OVERRIDES = null;

function readMetaSource(file) {
  const overridden = SOURCE_OVERRIDES instanceof Map ? SOURCE_OVERRIDES.get(file) : undefined;
  if (Buffer.isBuffer(overridden)) return overridden.toString('utf8');
  if (typeof overridden === 'string') return overridden;
  return fs.readFileSync(path.join(META_DIR, file), 'utf8');
}

// Accepts absolute IRIs (https://...) and CURIEs (prefix:localName), per the
// meta-model's compact-IRI convention used in examples and cross-refs.
function isIri(v) { return typeof v === 'string' && v.length > 0 && (IRI_RE.test(v) || CURIE_RE.test(v)); }

function validateModule(doc, file) {
  const m = doc.module;
  if (!m) return err(file, 'missing top-level `module`');
  for (const f of ['moduleIri', 'baseIri', 'preferredPrefix', 'version']) {
    if (!m[f]) err(`${file}.module`, `missing required field \`${f}\``);
  }
  if (m.moduleIri && !isIri(m.moduleIri)) err(`${file}.module.moduleIri`, 'not a valid IRI');
  if (m.baseIri && !/^https?:\/\/[^\s]+[/#]$/.test(m.baseIri)) err(`${file}.module.baseIri`, 'must end with / or #');
  if (m.preferredPrefix && !/^[a-z][a-z0-9-]*$/.test(m.preferredPrefix)) err(`${file}.module.preferredPrefix`, 'invalid prefix');
  if (m.version && !SEMVER_RE.test(m.version)) err(`${file}.module.version`, 'not semver');
  if (Array.isArray(m.imports)) {
    m.imports.forEach((imp, i) => {
      for (const f of ['moduleIri', 'version', 'importMode']) {
        if (!imp[f]) err(`${file}.module.imports[${i}]`, `missing \`${f}\``);
      }
      if (imp.moduleIri && !isIri(imp.moduleIri)) err(`${file}.module.imports[${i}].moduleIri`, 'not a valid IRI');
      if (imp.version && !SEMVER_RE.test(imp.version)) err(`${file}.module.imports[${i}].version`, 'not semver');
      if (imp.importMode && !['All', 'Selective'].includes(imp.importMode)) err(`${file}.module.imports[${i}].importMode`, 'bad enum');
    });
  }
}

function validateLayerMeta(doc, file, expectedLayer) {
  const sectionKey = Object.keys(LAYER_SECTIONS).find(k => doc[k]);
  if (!sectionKey) return err(file, 'missing layer section');
  const s = doc[sectionKey];
  if (typeof s.version === 'string' && !SEMVER_RE.test(s.version)) err(`${file}.${sectionKey}.version`, 'not semver');
  if (s.layer !== undefined && (typeof s.layer !== 'number' || s.layer < 1 || s.layer > 4)) err(`${file}.${sectionKey}.layer`, 'must be 1-4');
  if (expectedLayer && s.layer !== expectedLayer) err(`${file}.${sectionKey}.layer`, `expected ${expectedLayer}, got ${s.layer}`);
  if (s.description !== undefined && typeof s.description !== 'string') err(`${file}.${sectionKey}.description`, 'must be string');
  if (s.changes !== undefined && !Array.isArray(s.changes)) err(`${file}.${sectionKey}.changes`, 'must be array');
}

// Recursively find every `iri:` string value and check format.
function scanIris(obj, loc) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k === 'iri' && typeof v === 'string' && !isIri(v)) err(`${loc}.iri`, `invalid IRI: ${v}`);
    if (k === 'iri' && v === undefined) err(`${loc}.iri`, 'empty IRI');
    if (v && typeof v === 'object') scanIris(v, `${loc}.${k}`);
  }
}

const OWL_OVERRIDE = ['datatypeProperty', 'objectProperty', 'annotationProperty'];
const CONSTRAINT_TYPES = ['Cardinality', 'ValueRange', 'Pattern', 'Custom', 'Logical', 'Uniqueness', 'Dependency'];
const SEVERITIES = ['Error', 'Warning', 'Info'];
const CONSTRAINT_SCOPES = ['Attribute', 'Identifier', 'CodeList', 'Relation', 'Object', 'Association', 'Pattern', 'Module'];
const EXPR_LANGUAGES = ['SHACL', 'SPARQL', 'JSONSchema', 'Regex', 'Custom'];

function validateAttributeInstance(name, v, loc) {
  for (const f of ['iri', 'namespace', 'localName', 'label', 'definition', 'valueType']) {
    if (v[f] === undefined || v[f] === null || v[f] === '') err(`${loc}`, `attribute instance missing \`${f}\``);
  }
  if (v.owlProjectionOverride && !OWL_OVERRIDE.includes(v.owlProjectionOverride)) err(`${loc}.owlProjectionOverride`, 'bad enum');
}

function validateAuthoredAlignments(value, loc) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childLoc = `${loc}.${key}`;
    if (key === 'alignments' && Array.isArray(child)) {
      child.forEach((alignment, index) => {
        const rowLoc = `${childLoc}[${index}]`;
        if (!alignment || typeof alignment !== 'object' || Array.isArray(alignment)) {
          err(rowLoc, 'alignment must be an object');
          return;
        }
        for (const field of [
          'vocabulary', 'targetIri', 'relation', 'sourceRelease',
          'sourceLocator', 'rationale', 'verification',
        ]) {
          if (alignment[field] === undefined || alignment[field] === null || alignment[field] === '') {
            err(rowLoc, `alignment missing mandatory evidence field \`${field}\``);
          }
        }
        if (!alignment.sourceLocator || typeof alignment.sourceLocator !== 'object' || Array.isArray(alignment.sourceLocator)) {
          err(`${rowLoc}.sourceLocator`, 'must be a closed Layer4 SourceLocator object');
        }
        const status = alignment.verification && alignment.verification.status;
        if (!['proposed', 'reviewed', 'approved', 'deprecated'].includes(status)) {
          err(`${rowLoc}.verification.status`, 'must be proposed, reviewed, approved, or deprecated');
        }
      });
    }
    validateAuthoredAlignments(child, childLoc);
  }
}

function validateConstraintDef(name, v, loc) {
  for (const f of ['iri', 'namespace', 'localName', 'label', 'definition', 'constraintType', 'scope', 'expression', 'targetElement', 'severity', 'message']) {
    if (v[f] === undefined || v[f] === null || v[f] === '') err(`${loc}`, `constraint missing \`${f}\``);
  }
  if (v.constraintType && !CONSTRAINT_TYPES.includes(v.constraintType)) err(`${loc}.constraintType`, `bad enum: ${v.constraintType}`);
  if (v.scope && !CONSTRAINT_SCOPES.includes(v.scope)) err(`${loc}.scope`, `bad enum: ${v.scope}`);
  if (v.severity && !SEVERITIES.includes(v.severity)) err(`${loc}.severity`, `bad enum: ${v.severity}`);
  // expression must be structured { language, expression } per ConstraintDefinition (core Layer 1)
  if (v.expression && typeof v.expression === 'object') {
    if (!v.expression.language) err(`${loc}.expression.language`, 'missing language');
    else if (!EXPR_LANGUAGES.includes(v.expression.language)) err(`${loc}.expression.language`, `bad enum: ${v.expression.language}`);
    if (!v.expression.expression) err(`${loc}.expression.expression`, 'missing expression string');
  } else if (v.expression !== undefined) {
    err(`${loc}.expression`, 'must be structured { language, expression }');
  }
}

function validatePattern(p, i, loc) {
  const base = `${loc}[${i}]`;
  for (const f of ['pattern', 'iri', 'namespace', 'localName', 'label', 'definition', 'version']) {
    if (p[f] === undefined || p[f] === null || p[f] === '') err(base, `pattern missing \`${f}\``);
  }
  if (p.version && !SEMVER_RE.test(p.version)) err(`${base}.version`, 'not semver');
  if (p.appliesTo !== undefined && !Array.isArray(p.appliesTo)) err(`${base}.appliesTo`, 'must be array');
  if (Array.isArray(p.injectedAttributes)) {
    p.injectedAttributes.forEach((a, j) => {
      if (!a.attribute) err(`${base}.injectedAttributes[${j}]`, 'missing `attribute`');
      if (a.minCount !== undefined && typeof a.minCount !== 'number') err(`${base}.injectedAttributes[${j}].minCount`, 'must be number');
    });
  }
  if (Array.isArray(p.constraintsAdded)) {
    p.constraintsAdded.forEach((c, j) => {
      if (!c.constraintRef) err(`${base}.constraintsAdded[${j}]`, 'missing `constraintRef`');
      if (!c.targetElement) err(`${base}.constraintsAdded[${j}]`, 'missing `targetElement`');
    });
  }
}

function validateCore(doc) {
  const mm = doc.MetaModel;
  if (!mm) return;
  const knownClassifiers = new Set([
    'OntologyModuleDefinition','ModuleImportDefinition','SymbolImportSpec','LocalizedTextDefinition',
    'ValueType','IdentifierTypeDefinition','MoneyTypeDefinition','QuantityTypeDefinition',
    'CodeListTypeDefinition','CodeValueDefinition','ObjectTypeDefinition','AttributeTypeDefinition','AttributeUse',
    'RelationTypeDefinition','RelationUse','AssociationTypeDefinition','ParticipantRole',
    'PatternBinding','Alignment','ConstraintDefinition','ConstraintExpression','ConstraintParameter',
    'ConstraintBinding','ChangeRecord','GovernanceMetadata',
  ]);
  const metaStructural = new Set(['version','description','layer','changes','note',
    'ValidationRules','Notes','Examples','ImplementationNotes','constraints','patterns']);
  for (const key of Object.keys(mm)) {
    const v = mm[key];
    if (!v || typeof v !== 'object') continue;
    // Concrete attribute instances have their own IRI/name/valueType tuple;
    // namespace is not restricted to the cross-domain pattern namespace.
    const looksLikeConcreteAttribute = v.namespace === 'pattern' ||
      key === 'sourceEvidenceRef' ||
      (v.iri && v.namespace && v.localName && v.valueType);
    if (looksLikeConcreteAttribute) {
      validateAttributeInstance(key, v, `MetaModel.${key}`);
    } else if (STRICT && !knownClassifiers.has(key) && !metaStructural.has(key)) {
      err(`MetaModel.${key}`, `unknown key (not a known type-classifier nor a pattern attribute) — possible typo`);
    }
  }

  const attributeProjection = mm.AttributeTypeDefinition && mm.AttributeTypeDefinition.owlProjection;
  const expectedProjectionRules = [
    'IF valueType references a primitive (string, integer, decimal, boolean, date, instant, duration, uri) THEN owl:DatatypeProperty',
    'IF valueType references IdentifierTypeDefinition THEN owl:DatatypeProperty with range = identifier datatype IRI',
    'IF valueType references CodeListTypeDefinition THEN owl:ObjectProperty with range = code-list class IRI',
    'IF valueType references MoneyTypeDefinition, QuantityTypeDefinition, or other StructuredValueType THEN owl:ObjectProperty with range = structured value class IRI',
  ];
  if (!attributeProjection || JSON.stringify(attributeProjection.rules) !== JSON.stringify(expectedProjectionRules)) {
    err('MetaModel.AttributeTypeDefinition.owlProjection.rules',
      'must preserve the primitive/identifier datatype-property and code-list/structured object-property split');
  }

  const sourceEvidenceRef = mm.sourceEvidenceRef;
  if (!sourceEvidenceRef ||
      sourceEvidenceRef.iri !== 'https://axiolune.ai/ontology/meta/core/annotations/sourceEvidenceRef' ||
      sourceEvidenceRef.owlProjectionOverride !== 'annotationProperty' ||
      sourceEvidenceRef.valueType !== 'uri') {
    err('MetaModel.sourceEvidenceRef',
      'must define the public sourceEvidenceRef IRI as a uri-valued annotationProperty');
  }

  if (mm.availableAt !== undefined) {
    err('MetaModel.availableAt', 'removed in v0.6.0; use availableFrom/availableTo');
  }
  expectExactKeys(mm.CodeValueDefinition && mm.CodeValueDefinition.requiredFields,
    ['iri', 'notation', 'label', 'definition'],
    'MetaModel.CodeValueDefinition.requiredFields');
  expectExactKeys((mm.CodeValueDefinition && mm.CodeValueDefinition.optionalFields) || {},
    ['deprecated', 'replacedBy', 'sourceEvidenceRef'],
    'MetaModel.CodeValueDefinition.optionalFields');
  if (!mm.CodeListTypeDefinition || !mm.CodeListTypeDefinition.requiredFields ||
      !mm.CodeListTypeDefinition.requiredFields.sourceEvidenceRef) {
    err('MetaModel.CodeListTypeDefinition.requiredFields.sourceEvidenceRef',
      'must lock the authoritative code-list evidence');
  }
  const codeValues = mm.CodeListTypeDefinition && mm.CodeListTypeDefinition.optionalFields &&
    mm.CodeListTypeDefinition.optionalFields.values;
  if (!codeValues || codeValues.type !== 'list[CodeValueDefinition]') {
    err('MetaModel.CodeListTypeDefinition.optionalFields.values.type',
      'must be list[CodeValueDefinition]');
  }
  const localAlias = mm.SymbolImportSpec && mm.SymbolImportSpec.optionalFields &&
    mm.SymbolImportSpec.optionalFields.localAlias;
  if (!localAlias || localAlias.type !== 'string' || localAlias.minLength !== 1) {
    err('MetaModel.SymbolImportSpec.optionalFields.localAlias',
      'must be a string with minLength 1');
  }
  const abstractObjectType = mm.ObjectTypeDefinition &&
    mm.ObjectTypeDefinition.optionalFields &&
    mm.ObjectTypeDefinition.optionalFields.abstract;
  if (!abstractObjectType || abstractObjectType.type !== 'boolean' ||
      abstractObjectType.default !== false) {
    err('MetaModel.ObjectTypeDefinition.optionalFields.abstract',
      'must define the boolean false-default abstract classifier flag');
  }
  const quantityProps = mm.QuantityTypeDefinition && mm.QuantityTypeDefinition.owlProjection &&
    mm.QuantityTypeDefinition.owlProjection.properties;
  const rounding = Array.isArray(quantityProps)
    ? quantityProps.find(p => p && p.predicateIri === 'https://axiolune.ai/ontology/meta/core/properties/hasRounding')
    : null;
  if (!rounding) {
    err('MetaModel.QuantityTypeDefinition.owlProjection.properties', 'missing hasRounding');
  } else {
    if (rounding.range !== 'xsd:string') {
      err('MetaModel.QuantityTypeDefinition.hasRounding.range', 'must be xsd:string');
    }
    const expectedRounding = ['floor', 'ceiling', 'half-up', 'half-even'];
    if (JSON.stringify(rounding.values) !== JSON.stringify(expectedRounding)) {
      err('MetaModel.QuantityTypeDefinition.hasRounding.values',
        `must be exactly ${expectedRounding.join(', ')}`);
    }
    if (rounding.default !== 'half-even') {
      err('MetaModel.QuantityTypeDefinition.hasRounding.default', 'must be half-even');
    }
  }
  const endpointType = 'union[ObjectTypeDefinition,AssociationTypeDefinition]';
  for (const [defName, fields] of Object.entries({
    RelationTypeDefinition: ['domain', 'range'],
    RelationUse: ['subjectType', 'objectType'],
    ParticipantRole: ['range'],
  })) {
    for (const field of fields) {
      const spec = mm[defName] && mm[defName].requiredFields && mm[defName].requiredFields[field];
      if (!spec || spec.type !== endpointType) {
        err(`MetaModel.${defName}.requiredFields.${field}.type`, `must be ${endpointType}`);
      }
    }
  }
  const alignmentFields = mm.Alignment && mm.Alignment.requiredFields;
  expectExactKeys(alignmentFields, [
    'vocabulary', 'targetIri', 'relation', 'sourceRelease',
    'sourceLocator', 'rationale', 'verification',
  ], 'MetaModel.Alignment.requiredFields');
  const alignmentLocator = alignmentFields && alignmentFields.sourceLocator;
  if (!alignmentLocator || alignmentLocator.type !== 'Layer4:SourceLocator') {
    err('MetaModel.Alignment.requiredFields.sourceLocator.type',
      'must resolve the active Layer4:SourceLocator closed union');
  }
  const alignmentDigest = alignmentFields && alignmentFields.sourceRelease &&
    alignmentFields.sourceRelease.artifactDigest;
  if (!alignmentDigest || alignmentDigest.type !== 'digest') {
    err('MetaModel.Alignment.requiredFields.sourceRelease.artifactDigest.type',
      'must be digest');
  }
}

function validatePatterns(doc) {
  const cdp = doc.CrossDomainPatterns;
  if (!cdp) return;
  const c = cdp.constraints;
  if (c && typeof c === 'object') {
    for (const name of Object.keys(c)) validateConstraintDef(name, c[name], `CrossDomainPatterns.constraints.${name}`);
  }
  if (Array.isArray(cdp.patterns)) cdp.patterns.forEach((p, i) => validatePattern(p, i, 'CrossDomainPatterns.patterns'));
  if (!cdp.PatternDefinition || !cdp.PatternDefinition.owlProjection ||
      cdp.PatternDefinition.owlProjection.kind !== 'class') {
    err('CrossDomainPatterns.PatternDefinition.owlProjection.kind',
      'must be class so every concrete PatternDefinition IRI has an explicit owl:Class signature');
  }
}

function expectExactKeys(value, expected, loc) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    err(loc, 'must be an object');
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const missing = wanted.filter(k => !actual.includes(k));
  const extra = actual.filter(k => !wanted.includes(k));
  if (missing.length) err(loc, `missing keys: ${missing.join(', ')}`);
  if (extra.length) err(loc, `unknown keys: ${extra.join(', ')}`);
}

function expectDefinitionFields(section, name, required, optional = []) {
  const def = section && section[name];
  const loc = `DataBinding.${name}`;
  if (!def || typeof def !== 'object') {
    err(loc, 'missing definition');
    return;
  }
  expectExactKeys(def.requiredFields, required, `${loc}.requiredFields`);
  if (optional.length || def.optionalFields !== undefined) {
    expectExactKeys(def.optionalFields || {}, optional, `${loc}.optionalFields`);
  }
}

function expectUnionValue(def, loc, discriminator, variants) {
  if (!def || typeof def !== 'object') {
    err(loc, 'missing union definition');
    return;
  }
  if (def.discriminator !== discriminator) {
    err(`${loc}.discriminator`, `expected ${discriminator}, got ${def.discriminator}`);
  }
  expectExactKeys(def.variants, Object.keys(variants), `${loc}.variants`);
  if (!def.variants || typeof def.variants !== 'object') return;
  for (const [variant, fieldSpec] of Object.entries(variants)) {
    const value = def.variants[variant];
    if (!value || typeof value !== 'object') continue;
    expectExactKeys(value.requiredFields, fieldSpec.required, `${loc}.variants.${variant}.requiredFields`);
    if ((fieldSpec.optional || []).length || value.optionalFields !== undefined) {
      expectExactKeys(value.optionalFields || {}, fieldSpec.optional || [], `${loc}.variants.${variant}.optionalFields`);
    }
  }
}

function expectUnionVariants(section, name, discriminator, variants) {
  expectUnionValue(section && section[name], `DataBinding.${name}`, discriminator, variants);
}

function validateDataBinding(doc) {
  const db = doc.DataBinding;
  if (!db) return;

  expectUnionVariants(db, 'ArtifactRef', 'kind', {
    iri: { required: ['kind', 'iri'] },
    path: { required: ['kind', 'root', 'path'] },
  });
  const artifactRoots = db.ArtifactRef && db.ArtifactRef.variants && db.ArtifactRef.variants.path &&
    db.ArtifactRef.variants.path.requiredFields && db.ArtifactRef.variants.path.requiredFields.root &&
    db.ArtifactRef.variants.path.requiredFields.root.values;
  if (JSON.stringify(artifactRoots) !== JSON.stringify(['sourceTree', 'buildEvidence', 'payload', 'adoptionEvidence'])) {
    err('DataBinding.ArtifactRef.variants.path.requiredFields.root.values',
      'must be exactly sourceTree, buildEvidence, payload, adoptionEvidence');
  }
  const sourceLocator = db.SourceLocator;
  expectExactKeys(sourceLocator && sourceLocator.commonRequiredFields, [
    'path', 'mediaType', 'extractorProfileRef', 'extractorProfileDigest', 'selectionDigest',
  ], 'DataBinding.SourceLocator.commonRequiredFields');
  expectUnionValue(sourceLocator, 'DataBinding.SourceLocator', 'kind', {
    wholeFile: { required: ['kind'] },
    textLineRange: { required: ['kind', 'startLine', 'endLine'] },
    textHeading: { required: ['kind', 'heading', 'occurrence'], optional: ['headingLevel'] },
    pdfPageRange: { required: ['kind', 'startPage', 'endPage'] },
    pdfNamedSection: {
      required: ['kind', 'sectionTitle', 'occurrence'],
      optional: ['startPage', 'endPage'],
    },
    jsonPointer: { required: ['kind', 'pointer'] },
    rdfResource: { required: ['kind', 'resourceIri'], optional: ['graphIri'] },
    xmlElement: { required: ['kind', 'elementId'] },
    htmlFragment: { required: ['kind', 'fragmentId'] },
  });
  expectUnionVariants(db, 'SemanticValueDefinition', 'valueKind', {
    attributeUse: { required: ['valueKind', 'containingType', 'attributeRef'] },
    participantRole: { required: ['valueKind', 'containingAssociation', 'roleId', 'effectivePredicate'] },
    relationUse: { required: ['valueKind', 'relationRef', 'subjectType', 'objectType'] },
    patternField: { required: ['valueKind', 'containingType', 'patternRef', 'fieldRef'] },
    derivation: { required: ['valueKind', 'derivationRef', 'derivationDigest', 'outputName'] },
  });

  expectDefinitionFields(db, 'IdentityComponentDefinition',
    ['name', 'semanticValue', 'termContractRef', 'termContractDigest', 'normalizationRuleRef', 'normalizationRuleDigest']);
  expectDefinitionFields(db, 'IdentityTermContractDefinition',
    ['iri', 'label', 'definition', 'termContract']);
  const termUnion = db.IdentityTermContractDefinition && db.IdentityTermContractDefinition.structures &&
    db.IdentityTermContractDefinition.structures.IdentityTermContract;
  expectUnionValue(termUnion, 'DataBinding.IdentityTermContractDefinition.structures.IdentityTermContract',
    'termKind', {
      factReference: { required: ['termKind', 'referenceMode', 'expectedTargetType'] },
      controlledIri: { required: ['termKind', 'referenceMode', 'controlledSetRef', 'controlledSetDigest'] },
      literal: { required: ['termKind', 'datatypeIri'], optional: ['languageTag'] },
    });
  expectDefinitionFields(db, 'IdentityNormalizationRuleDefinition', [
    'iri', 'label', 'definition',
    'inputTermContractRef', 'inputTermContractDigest',
    'outputTermContractRef', 'outputTermContractDigest',
    'algorithmId', 'algorithmVersion',
    'specificationRef', 'specificationDigest',
    'implementationRef', 'implementationDigest',
    'testVectorsRef', 'testVectorsDigest',
  ]);
  expectDefinitionFields(db, 'IdentityDerivationDefinition', [
    'iri', 'label', 'definition', 'inputSemanticValues', 'outputs',
    'expressionRef', 'expressionDigest', 'implementationRef',
    'implementationDigest', 'testVectorsRef', 'testVectorsDigest',
  ]);
  expectDefinitionFields(db, 'ControlledIriSetDefinition', [
    'iri', 'label', 'definition', 'setKind', 'sourceDefinitionRef',
    'sourceEvidenceRef', 'sourceEvidenceDigest', 'sourceLocator', 'members',
  ]);
  expectDefinitionFields(db, 'TargetIdentityContractDefinition', [
    'iri', 'label', 'definition', 'targetType', 'identityBaseIri',
    'logicalComponents', 'versionComponents',
  ]);
  expectDefinitionFields(db, 'ReferenceIdentityBinding',
    ['bindingType', 'targetMappingRef', 'referenceMode', 'keyBindings']);
  expectDefinitionFields(db, 'IdentitySpec',
    ['contractRef', 'logicalKeyBindings', 'versionKeyBindings']);
  const valueReference = db.ValueBinding && db.ValueBinding.variants &&
    db.ValueBinding.variants.ReferenceIdentityBinding;
  if (!valueReference || !valueReference.fields) {
    err('DataBinding.ValueBinding.variants.ReferenceIdentityBinding', 'missing reference-identity binding branch');
  } else {
    expectExactKeys(valueReference.fields,
      ['bindingType', 'targetMappingRef', 'referenceMode', 'keyBindings'],
      'DataBinding.ValueBinding.variants.ReferenceIdentityBinding.fields');
  }
  const runtimeContext = db.ValueBinding && db.ValueBinding.variants &&
    db.ValueBinding.variants.RuntimeContextBinding;
  if (!runtimeContext || !runtimeContext.fields) {
    err('DataBinding.ValueBinding.variants.RuntimeContextBinding',
      'missing immutable MaterializationRun context binding branch');
  } else {
    expectExactKeys(runtimeContext.fields,
      ['bindingType', 'contextField'],
      'DataBinding.ValueBinding.variants.RuntimeContextBinding.fields');
    const contextField = runtimeContext.fields.contextField;
    if (!contextField || contextField.type !== 'enum'
        || JSON.stringify(contextField.values)
          !== JSON.stringify(['iri', 'assertionTime', 'referenceTime', 'runId'])) {
      err('DataBinding.ValueBinding.variants.RuntimeContextBinding.fields.contextField',
        'must be the exact closed enum iri, assertionTime, referenceTime, runId');
    }
  }

  expectDefinitionFields(db, 'MaterializationRun', [
    'schemaVersion', 'iri', 'recordType', 'slotId', 'runId', 'attemptId',
    'plannedInputDigest', 'resolvedInputDigest', 'planRef', 'planSourceDigest',
    'sourceSchemaClosureDigest', 'sourceSnapshotRootDigest', 'inputDatasets',
    'mappingClosure', 'mappingClosureDigest', 'ontologyClosureRef',
    'ontologyClosureDigest', 'referenceLockRef', 'referenceLockDigest', 'build',
    'compilerDigest', 'validatorDigest', 'executorDigest',
    'outputRdfCanonicalization', 'assertionTime', 'referenceTime', 'result',
  ]);
  expectDefinitionFields(db, 'MaterializationBatchRun', [
    'schemaVersion', 'iri', 'recordType', 'slotId', 'runId', 'attemptId',
    'plannedInputDigest', 'resolvedInputDigest', 'batchRef', 'batchSourceDigest',
    'sourceSnapshotRootDigest', 'ontologyClosureRef', 'ontologyClosureDigest',
    'referenceLockRef', 'referenceLockDigest', 'build', 'compilerDigest',
    'validatorDigest', 'executorDigest', 'outputRdfCanonicalization',
    'assertionTime', 'referenceTime', 'targetDataset', 'result',
  ]);
  expectDefinitionFields(db, 'PITValidationRequest', [
    'schemaVersion', 'iri', 'slotId', 'requestId', 'attemptId',
    'plannedInputDigest', 'resolvedInputDigest', 'recordType',
    'targetRdfCanonicalization', 'asOfValid', 'asOfKnowledge', 'asOfAvailable',
    'build', 'validatorRef', 'validatorDigest', 'materializationContext',
  ]);
  expectDefinitionFields(db, 'ValidationReport', [
    'schemaVersion', 'iri', 'slotId', 'reportId', 'attemptId',
    'plannedInputDigest', 'resolvedInputDigest', 'recordType', 'profileRef',
    'gateId', 'reportKind', 'criterionRefs', 'subjectRef', 'build', 'inputs',
    'toolId', 'capabilityId', 'capabilityRef', 'capabilityDigest',
    'entrypointRef', 'entrypointDigest', 'discoveryContractRef',
    'discoveryContractDigest', 'subjectInventoryRef', 'subjectInventoryDigest',
    'kindEvidence', 'counts', 'result',
  ], [
    'requestRef', 'requestRecordDigest', 'contextRef', 'contextRecordDigest',
    'recomputedTargetDigest', 'asOfValid', 'asOfKnowledge', 'asOfAvailable',
    'memberRunRecordDigests', 'outputDatasetDigest',
  ]);
  expectDefinitionFields(db, 'FailureReport', [
    'schemaVersion', 'iri', 'slotId', 'reportId', 'attemptId',
    'plannedInputDigest', 'resolvedInputDigest', 'recordType', 'subjectRef',
    'build', 'failureStage', 'inputs', 'errors',
  ]);
  expectDefinitionFields(db, 'ReplayReport', [
    'schemaVersion', 'iri', 'slotId', 'reportId', 'attemptId',
    'plannedInputDigest', 'resolvedInputDigest', 'recordType', 'build',
    'originalContextRef', 'originalContextRecordDigest', 'originalTargetRef',
    'originalTargetDigest', 'replaySourceSnapshotRootDigest',
    'replayMappingClosureDigest', 'replayOntologyClosureDigest',
    'replayReferenceLockDigest', 'replayToolLockDigest', 'result',
  ]);
  expectDefinitionFields(db, 'EvidenceLedger', [
    'schemaVersion', 'slotId', 'ledgerId', 'attemptId', 'plannedInputDigest',
    'resolvedInputDigest', 'iri', 'build', 'slotSelections', 'entries',
  ]);

  expectDefinitionFields(db, 'InputDatasetSnapshot',
    ['dataset', 'snapshotRef', 'artifactDigest', 'schemaDigest', 'snapshotTime'], ['rowCount']);
  expectDefinitionFields(db, 'ExecutionError',
    ['code', 'stage', 'message'], ['sourcePath', 'constraintRef', 'causeDigest']);
  expectDefinitionFields(db, 'BuildEvidenceBinding', [
    'buildId', 'sourceTreeDigest', 'toolLockRef', 'toolLockDigest',
    'buildInputsRef', 'buildInputsDigest', 'controlRecordSchemaManifestRef',
    'controlRecordSchemaManifestDigest', 'controlRecordPlanRef',
    'controlRecordPlanDigest',
  ]);
  expectDefinitionFields(db, 'ArtifactBinding',
    ['name', 'artifactRef', 'mediaType', 'artifactDigest']);

  expectUnionVariants(db, 'MaterializationResult', 'outcome', {
    completed: {
      required: [
        'outcome', 'outputGraph', 'outputGraphDigest', 'validationReportRef',
        'validationReportDigest', 'outputFactVersionCount',
      ],
    },
    failed: {
      required: [
        'outcome', 'failureStage', 'failureReportRef', 'failureReportDigest', 'errors',
      ],
    },
  });
  expectUnionVariants(db, 'MaterializationContext', 'contextKind', {
    materializationRun: {
      required: ['contextKind', 'recordRef', 'recordDigest', 'targetGraph', 'targetGraphDigest'],
    },
    materializationBatchRun: {
      required: ['contextKind', 'recordRef', 'recordDigest', 'targetDataset', 'targetDatasetDigest'],
    },
  });
  expectUnionVariants(db, 'GateResult', 'outcome', {
    passed: { required: ['outcome', 'checks', 'violations', 'errors'] },
    failed: { required: ['outcome', 'checks', 'violations', 'errors'] },
    engineFailure: { required: ['outcome', 'checks', 'violations', 'errors'] },
  });
  expectUnionVariants(db, 'ReplayResult', 'outcome', {
    identical: { required: ['outcome', 'comparisons', 'errors'] },
    mismatch: { required: ['outcome', 'comparisons', 'errors'] },
    engineFailure: { required: ['outcome', 'comparisons', 'errors'] },
  });
  const batchResult = db.MaterializationBatchRun && db.MaterializationBatchRun.structures &&
    db.MaterializationBatchRun.structures.MaterializationBatchResult;
  expectUnionValue(batchResult, 'DataBinding.MaterializationBatchRun.structures.MaterializationBatchResult',
    'outcome', {
      completed: {
        required: ['outcome', 'members', 'outputDatasetDigest', 'validationReportRef', 'validationReportDigest'],
      },
      failed: {
        required: ['outcome', 'attemptedMembers', 'failureStage', 'failureReportRef', 'failureReportDigest', 'errors'],
      },
    });

  const mapping = db.SemanticMappingDefinition;
  if (!mapping || !mapping.requiredFields || !mapping.requiredFields.identity) {
    err('DataBinding.SemanticMappingDefinition.requiredFields.identity',
      'identity must be mandatory for every concrete materialized target');
  }
  if (mapping && mapping.optionalFields && mapping.optionalFields.identity) {
    err('DataBinding.SemanticMappingDefinition.optionalFields.identity',
      'identity cannot be optional');
  }

  const serialized = yaml.dump(db);
  for (const forbidden of ['logicalKey:', 'versionKey:', 'iriTemplate:', 'inputSnapshotDigest:']) {
    if (serialized.includes(forbidden)) {
      err('DataBinding', `removed v0.6 field remains in executable meta-model: ${forbidden.slice(0, -1)}`);
    }
  }
}

const PRIMITIVE_TYPES = new Set([
  'any', 'string', 'boolean', 'integer', 'decimal', 'float', 'double',
  'duration', 'instant', 'datetime', 'date', 'time', 'uri', 'digest',
  'recordId', 'asciiIdentifier', 'nfcString', 'posixRelativePath',
  'ianaMediaType', 'canonicalJsonPointer', 'canonicalNTriplesTerm',
  'canonicalBcp47', 'xmlId', 'semver', 'const', 'literal', 'enum', 'dict',
  'map', 'list', 'union', 'positiveSafeInteger', 'nonNegativeSafeInteger',
  'safeInteger',
]);

function collectDeclaredTypes(value, declarations) {
  if (!value || typeof value !== 'object') return;
  if (value.structures && typeof value.structures === 'object') {
    for (const name of Object.keys(value.structures)) declarations.add(name);
  }
  for (const child of Object.values(value)) collectDeclaredTypes(child, declarations);
}

function scanTypeReferences(value, loc, declarations) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childLoc = `${loc}.${key}`;
    if (key === 'type' && typeof child === 'string') {
      if (/^[A-Za-z][A-Za-z0-9._-]*:[^\s]+$/.test(child) || /^https?:\/\//.test(child)) continue;
      const withoutCompactIris = child.replace(/[A-Za-z][A-Za-z0-9._-]*:[A-Za-z_][A-Za-z0-9._-]*/g, '');
      const tokens = withoutCompactIris.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
      for (const token of tokens) {
        if (PRIMITIVE_TYPES.has(token) || declarations.has(token)) continue;
        if (/^[a-z]/.test(token)) continue;
        err(childLoc, `unresolved schema type reference: ${token}`);
      }
    } else {
      scanTypeReferences(child, childLoc, declarations);
    }
  }
}

function validateTypeReferenceClosure() {
  const declarations = new Set();
  for (const doc of loadedDocs.values()) {
    const sectionName = Object.keys(LAYER_SECTIONS).find(k => doc[k]);
    const section = doc[sectionName];
    for (const name of Object.keys(section || {})) declarations.add(name);
    collectDeclaredTypes(section, declarations);
  }
  for (const [file, doc] of loadedDocs.entries()) {
    const sectionName = Object.keys(LAYER_SECTIONS).find(k => doc[k]);
    scanTypeReferences(doc[sectionName], `${file}.${sectionName}`, declarations);
  }
}

function validateFile(name, expectedLayer) {
  const file = LAYER_SECTIONS[name].file;
  let doc;
  try { doc = yaml.load(readMetaSource(file)); }
  catch (e) { err(file, `YAML parse error: ${e.message}`); return; }
  loadedDocs.set(file, doc);
  // root: module + exactly one layer section, no unknown top-level keys
  const knownTop = new Set(['module', ...Object.keys(LAYER_SECTIONS)]);
  for (const k of Object.keys(doc)) {
    if (!knownTop.has(k)) err(file, `unknown top-level key \`${k}\``);
  }
  const present = Object.keys(LAYER_SECTIONS).filter(k => doc[k]);
  if (present.length !== 1) err(file, `expected exactly one layer section, found ${present.length}: ${present.join(', ')}`);
  if (present[0] !== name) err(file, `expected layer section ${name}, found ${present[0]}`);
  validateModule(doc, file);
  validateLayerMeta(doc, file, expectedLayer);
  scanIris(doc, file);
  validateAuthoredAlignments(doc, file);
  if (name === 'MetaModel') validateCore(doc);
  if (name === 'CrossDomainPatterns') validatePatterns(doc);
  if (name === 'DataBinding') validateDataBinding(doc);
}

function validateMetaStructure(options = {}) {
  META_DIR = path.resolve(options.metaDir || DEFAULT_META_DIR);
  STRICT = options.strict === true;
  SOURCE_OVERRIDES = options.sources instanceof Map ? options.sources : null;
  errors = [];
  loadedDocs = new Map();
  validateFile('MetaModel', 1);
  validateFile('CrossDomainPatterns', 2);
  validateFile('PlatformBehavior', 3);
  validateFile('DataBinding', 4);
  validateTypeReferenceClosure();
  return { ok: errors.length === 0, errors: [...errors] };
}

function main(argv = process.argv.slice(2)) {
  const result = validateMetaStructure({
    metaDir: process.env.META_DIR || DEFAULT_META_DIR,
    strict: argv.includes('--strict'),
  });
  console.log('=== Deep Structural Validation ===\n');
  if (result.ok) {
    console.log('✅ STRUCTURE VALID (0 errors)');
    return 0;
  }
  console.log(`❌ STRUCTURE INVALID (${result.errors.length} errors)\n`);
  result.errors.forEach((entry) => console.log('  - ' + entry));
  return 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { validateMetaStructure };
