#!/usr/bin/env node
/**
 * M3 -> M2 OWL projection generator (ADR-007 §1.3 rules).
 *
 * Projects the concrete, shipped artifacts of the meta-model into OWL2-DL
 * (Turtle). The meta-model ships two kinds of concrete projectable artifacts:
 *   (R1) Concrete core attribute instances -> the explicitly selected OWL
 *        property kind (datatype, object, or annotation) with range,
 *        rdfs:label/comment, and owl:deprecated when deprecated:true.
 *   (R2/R3) Structured value classes MoneyTypeDefinition / QuantityTypeDefinition
 *        -> owl:Class (MonetaryAmount / QuantityValue) + component
 *        owl:DatatypeProperty (from owlProjection.properties[]).
 *
 *   (R4) Every concrete Layer 2 PatternDefinition IRI -> owl:Class.
 *
 * Meta-type schemas (ObjectTypeDefinition, AttributeTypeDefinition, etc.) and
 * Identifier/CodeList schemas define the GRAMMAR for domain ontologies and have
 * no concrete individuals in the shipped meta-model, so they are not projected
 * here (they project when a domain ontology instantiates them).
 *
 * Output: ontology/meta/projection/axiolune-meta.owl.ttl
 * Verify: node scripts/generate-owl.js && node scripts/test-projection.js
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Writer, DataFactory } = require('n3');
const { quad, namedNode, literal } = DataFactory;

const META_DIR = process.env.META_DIR
  ? path.resolve(process.env.META_DIR)
  : path.join(__dirname, '..', '..', 'ontology', 'meta');
const PROJECTION_DIR = process.env.META_PROJECTION_DIR
  ? path.resolve(process.env.META_PROJECTION_DIR)
  : path.join(META_DIR, 'projection');
const OUT = path.join(PROJECTION_DIR, 'axiolune-meta.owl.ttl');

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const DC = 'http://purl.org/dc/terms/';

const VT_TO_XSD = {
  string: XSD + 'string', decimal: XSD + 'decimal', integer: XSD + 'integer',
  boolean: XSD + 'boolean', date: XSD + 'date', instant: XSD + 'dateTime',
  duration: XSD + 'duration', uri: XSD + 'anyURI',
};

// Expand "xsd:decimal" / CURIE / absolute IRI to an absolute IRI.
function expandRange(r) {
  if (!r || typeof r !== 'string') return XSD + 'string';
  if (r.startsWith('http')) return r;
  if (r.startsWith('xsd:')) return XSD + r.slice(4);
  return r;
}

const core = yaml.load(fs.readFileSync(path.join(META_DIR, 'core-meta-model.yaml'), 'utf8'));
const patterns = yaml.load(fs.readFileSync(path.join(META_DIR, 'cross-domain-patterns.yaml'), 'utf8'));
const behavior = yaml.load(fs.readFileSync(path.join(META_DIR, 'behavior-meta-model.yaml'), 'utf8'));
const dataBinding = yaml.load(fs.readFileSync(path.join(META_DIR, 'data-binding-meta-model.yaml'), 'utf8'));
const quads = [];

function add(s, p, o) { quads.push(quad(s, p, o, namedNode(''))); }

// ---- Ontology declaration ----
const ONT = namedNode('https://axiolune.ai/ontology/meta');
add(namedNode(ONT.value), namedNode(RDF + 'type'), namedNode(OWL + 'Ontology'));
add(
  namedNode(ONT.value),
  namedNode(OWL + 'versionIRI'),
  namedNode(ONT.value + '/' + core.module.version),
);

// ---- R1: Concrete core attribute instances -> selected property kinds ----
let attrCount = 0, depCount = 0, annotationCount = 0, objectAttributeCount = 0;
for (const key of Object.keys(core.MetaModel || {})) {
  const v = core.MetaModel[key];
  if (!v || !v.iri || !v.namespace || !v.localName || !v.valueType) continue;
  const prop = namedNode(v.iri);
  const projectionKind = {
    annotationProperty: OWL + 'AnnotationProperty',
    objectProperty: OWL + 'ObjectProperty',
    datatypeProperty: OWL + 'DatatypeProperty',
  }[v.owlProjectionOverride || 'datatypeProperty'];
  if (!projectionKind) {
    throw new Error(`Unsupported owlProjectionOverride for MetaModel.${key}: ${v.owlProjectionOverride}`);
  }
  add(prop, namedNode(RDF + 'type'), namedNode(projectionKind));
  if (v.label) add(prop, namedNode(RDFS + 'label'), literal(v.label));
  if (v.definition) add(prop, namedNode(RDFS + 'comment'), literal(v.definition));
  const range = VT_TO_XSD[v.valueType] || XSD + 'string';
  add(prop, namedNode(RDFS + 'range'), namedNode(range));
  if (v.owlProjectionOverride === 'annotationProperty') annotationCount++;
  if (v.owlProjectionOverride === 'objectProperty') objectAttributeCount++;
  if (v.deprecated === true) {
    add(prop, namedNode(OWL + 'deprecated'), literal('true', namedNode(XSD + 'boolean')));
    depCount++;
  }
  attrCount++;
}

// ---- R4: Concrete PatternDefinition instances -> owl:Class ----
let patternClassCount = 0;
for (const pattern of (patterns.CrossDomainPatterns && patterns.CrossDomainPatterns.patterns) || []) {
  if (!pattern || !pattern.iri) continue;
  const cls = namedNode(pattern.iri);
  add(cls, namedNode(RDF + 'type'), namedNode(OWL + 'Class'));
  if (pattern.label) add(cls, namedNode(RDFS + 'label'), literal(pattern.label));
  if (pattern.definition) add(cls, namedNode(RDFS + 'comment'), literal(pattern.definition));
  patternClassCount++;
}

// ---- R0: Meta-type schemas -> OWL declarations ----
// Each meta-type schema (ObjectTypeDefinition, AttributeTypeDefinition, etc.) defines
// the GRAMMAR for domain ontologies. With v0.6.0 they now carry their own canonical IRI
// and are projected as first-class OWL declarations so the meta-model itself is a
// referenceable, alignable ontology. This does NOT project their concrete individuals
// (handled by R1-R4) — it projects the schema types themselves.
const projectedIris = new Set();
let schemaClassCount = 0, schemaPropertyCount = 0;
const META_SECTIONS = [
  { doc: core, section: 'MetaModel' },
  { doc: patterns, section: 'CrossDomainPatterns' },
  { doc: behavior, section: 'PlatformBehavior' },
  { doc: dataBinding, section: 'DataBinding' },
];
const SCALAR_SECTION_META = new Set([
  'version', 'description', 'layer', 'changes', 'note', 'notes', 'purpose',
  'curiePrefixes', 'label', 'definition', 'validationRules', 'ValidationRules',
  'Notes', 'validation', 'examples', 'structures', 'ImplementationNotes',
  'examples', 'constraints', 'patterns',
]);
for (const { doc, section } of META_SECTIONS) {
  const sec = doc[section];
  if (!sec || typeof sec !== 'object') continue;
  for (const [name, def] of Object.entries(sec)) {
    if (SCALAR_SECTION_META.has(name)) continue;
    if (!def || typeof def !== 'object' || !def.iri || typeof def.iri !== 'string') continue;
    // Skip concrete attribute instances (they have valueType + owlProjectionOverride) —
    // those are handled by R1 / Layer4 attribute projection below.
    if (def.valueType && (def.owlProjectionOverride || def.namespace)) continue;
    if (def.constraintType || def.scope) continue; // constraint instances, not schemas
    if (Array.isArray(def)) continue;
    // Skip concrete class/property definitions that are just {definition, owlProjection}
    // with classIri/propertyIri but no grammar fields — those are projected by R2/R3/R-Layer4.
    // We only want schemas that DEFINE a type-classifier (have requiredFields/optionalFields/
    // fields/variants/builtinTypes/structure/commonRequiredFields).
    const isSchema = def.requiredFields || def.optionalFields || def.fields ||
      def.variants || def.builtinTypes || def.structure || def.commonRequiredFields ||
      def.discriminator;
    if (!isSchema) continue;
    if (projectedIris.has(def.iri)) continue;
    projectedIris.add(def.iri);
    const node = namedNode(def.iri);
    const proj = def.owlProjection || {};
    const kind = proj.kind;
    let declType;
    if (kind === 'objectProperty') declType = OWL + 'ObjectProperty';
    else if (kind === 'datatype' || kind === 'rdfLangString') declType = OWL + 'DatatypeProperty';
    else declType = OWL + 'Class'; // class, structuredValueClass, ontology, namedIndividual-as-schema, or unspecified
    add(node, namedNode(RDF + 'type'), namedNode(declType));
    add(node, namedNode(RDFS + 'label'), literal(name));
    if (def.definition) add(node, namedNode(RDFS + 'comment'), literal(def.definition));
    if (declType === OWL + 'Class') schemaClassCount++;
    else schemaPropertyCount++;
  }
}

// ---- R2/R3: Structured value classes ----
function projectStructured(typeKey, v) {
  const proj = v.owlProjection || {};
  if (proj.kind !== 'structuredValueClass' || !proj.classIri) return 0;
  const cls = namedNode(proj.classIri);
  add(cls, namedNode(RDF + 'type'), namedNode(OWL + 'Class'));
  if (v.definition) add(cls, namedNode(RDFS + 'comment'), literal(v.definition));
  let n = 1;
  for (const p of (proj.properties || [])) {
    if (!p.predicateIri) continue;
    const prop = namedNode(p.predicateIri);
    add(prop, namedNode(RDF + 'type'), namedNode(OWL + 'DatatypeProperty'));
    add(prop, namedNode(RDFS + 'domain'), cls);
    add(prop, namedNode(RDFS + 'range'), namedNode(expandRange(p.range)));
    if (p.pattern) add(prop, namedNode(RDFS + 'comment'), literal('pattern: ' + p.pattern));
    if (Array.isArray(p.values)) {
      add(prop, namedNode(RDFS + 'comment'), literal('allowed values: ' + p.values.join(', ')));
    }
    n++;
  }
  return n;
}

const moneyN = core.MetaModel && projectStructured('MoneyTypeDefinition', core.MetaModel.MoneyTypeDefinition);
const qtyN = core.MetaModel && projectStructured('QuantityTypeDefinition', core.MetaModel.QuantityTypeDefinition);

// ---- Layer 4 concrete projection vocabulary ----
let bindingClassCount = 0, bindingPropertyCount = 0;
const bindingRoot = dataBinding.DataBinding || {};
for (const value of Object.values(bindingRoot)) {
  if (!value || typeof value !== 'object') continue;
  const projection = value.owlProjection || {};
  if ((projection.kind === 'class' || projection.kind === 'structuredValueClass') && projection.classIri) {
    const cls = namedNode(projection.classIri);
    add(cls, namedNode(RDF + 'type'), namedNode(OWL + 'Class'));
    if (value.definition) add(cls, namedNode(RDFS + 'comment'), literal(value.definition));
    bindingClassCount++;
  } else if (projection.kind === 'objectProperty' && projection.propertyIri) {
    const prop = namedNode(projection.propertyIri);
    add(prop, namedNode(RDF + 'type'), namedNode(OWL + 'ObjectProperty'));
    if ((projection.characteristics || []).includes('functional')) {
      add(prop, namedNode(RDF + 'type'), namedNode(OWL + 'FunctionalProperty'));
    }
    if (projection.domain) add(prop, namedNode(RDFS + 'domain'), namedNode(projection.domain));
    if (projection.range) add(prop, namedNode(RDFS + 'range'), namedNode(projection.range));
    if (value.definition) add(prop, namedNode(RDFS + 'comment'), literal(value.definition));
    bindingPropertyCount++;
  }

  if (value.namespace === 'ax-binding' && value.iri && value.valueType) {
    const prop = namedNode(value.iri);
    const structuredRange = {
      ArtifactRef: 'https://axiolune.ai/ontology/meta/data-binding/structures/ArtifactRef',
      SourceLocator: 'https://axiolune.ai/ontology/meta/data-binding/structures/SourceLocator',
    }[value.valueType];
    add(
      prop,
      namedNode(RDF + 'type'),
      namedNode(structuredRange ? OWL + 'ObjectProperty' : OWL + 'DatatypeProperty'),
    );
    add(
      prop,
      namedNode(RDFS + 'range'),
      namedNode(structuredRange || (VT_TO_XSD[value.valueType] || XSD + 'string')),
    );
    if (value.label) add(prop, namedNode(RDFS + 'label'), literal(value.label));
    if (value.definition) add(prop, namedNode(RDFS + 'comment'), literal(value.definition));
    bindingPropertyCount++;
  }
}

// ---- Serialize ----
const writer = new Writer({ prefixes: {
  owl: OWL, rdf: RDF, rdfs: RDFS, xsd: XSD, dct: DC,
  ax: 'https://axiolune.ai/ontology/meta/',
} });
for (const q of quads) writer.addQuad(q.subject, q.predicate, q.object);
writer.end((error, result) => {
  if (error) { console.error('write error', error); process.exit(1); }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, result);
  console.log(`✓ OWL projected: ${attrCount} attribute properties (${depCount} deprecated), ` +
    `MonetaryAmount (${moneyN} terms), QuantityValue (${qtyN} terms), ` +
    `Layer4 ${bindingClassCount} classes/${bindingPropertyCount} properties, ` +
    `R0 meta-type schemas (${schemaClassCount} classes/${schemaPropertyCount} properties) -> ${path.basename(OUT)}`);
  console.log(`  ${quads.length} triples`);
});
