#!/usr/bin/env node
/**
 * M3 -> M2 OWL projection generator (ADR-007 §1.3 rules).
 *
 * Projects the concrete, shipped artifacts of the meta-model into OWL2-DL
 * (Turtle). The meta-model ships two kinds of concrete projectable artifacts:
 *   (R1) Pattern attribute instances (core MetaModel.*, namespace=pattern)
 *        -> owl:DatatypeProperty with xsd range, rdfs:label/comment,
 *           owl:deprecated when deprecated:true.
 *   (R2/R3) Structured value classes MoneyTypeDefinition / QuantityTypeDefinition
 *        -> owl:Class (MonetaryAmount / QuantityValue) + component
 *        owl:DatatypeProperty (from owlProjection.properties[]).
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

const META_DIR = path.join(__dirname, '..', 'ontology', 'meta');
const OUT = path.join(META_DIR, 'projection', 'axiolune-meta.owl.ttl');

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
const quads = [];

function add(s, p, o) { quads.push(quad(s, p, o, namedNode(''))); }

// ---- Ontology declaration ----
const ONT = namedNode('https://axiolune.ai/ontology/meta');
add(namedNode(ONT.value), namedNode(RDF + 'type'), namedNode(OWL + 'Ontology'));
add(namedNode(ONT.value), namedNode(OWL + 'versionIRI'), namedNode(ONT.value + '/0.4.0'));

// ---- R1: Pattern attribute instances -> DatatypeProperties ----
let attrCount = 0, depCount = 0;
for (const key of Object.keys(core.MetaModel || {})) {
  const v = core.MetaModel[key];
  if (!v || v.namespace !== 'pattern' || !v.iri) continue;
  const prop = namedNode(v.iri);
  add(prop, namedNode(RDF + 'type'), namedNode(OWL + 'DatatypeProperty'));
  if (v.label) add(prop, namedNode(RDFS + 'label'), literal(v.label));
  if (v.definition) add(prop, namedNode(RDFS + 'comment'), literal(v.definition));
  const range = VT_TO_XSD[v.valueType] || XSD + 'string';
  add(prop, namedNode(RDFS + 'range'), namedNode(range));
  if (v.deprecated === true) {
    add(prop, namedNode(OWL + 'deprecated'), literal('true', namedNode(XSD + 'boolean')));
    depCount++;
  }
  attrCount++;
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
    n++;
  }
  return n;
}

const moneyN = core.MetaModel && projectStructured('MoneyTypeDefinition', core.MetaModel.MoneyTypeDefinition);
const qtyN = core.MetaModel && projectStructured('QuantityTypeDefinition', core.MetaModel.QuantityTypeDefinition);

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
    `MonetaryAmount (${moneyN} terms), QuantityValue (${qtyN} terms) -> ${path.basename(OUT)}`);
  console.log(`  ${quads.length} triples`);
});
