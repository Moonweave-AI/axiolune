#!/usr/bin/env node
/**
 * M3 -> M2 SHACL projection generator.
 *
 * Projects the meta-model's constraint and pattern vocabulary into SHACL shapes
 * (Turtle). Two tiers (honest about machine-verifiability):
 *
 *   Tier 1 — core SHACL (machine-verified by rdf-validate-shacl via test-projection.js):
 *     - PatternFactShape: format/range constraints (ConfidenceRange, DigestFormat,
 *       SemanticVersionFormat) + datatype on auxiliary attributes.
 *     - Per-pattern anchor shapes (ax:TemporalFactShape etc.): require the
 *       attributes each pattern injects, using the pattern's INJECTED cardinality
 *       (e.g. TemporalFact requires validFrom + knowledgeFrom at minCount 1). These
 *       are targeted at pattern anchor classes so they are machine-testable; M2
 *       types bind via rdfs:subClassOf or sh:node.
 *
 *   Tier 2 — sh:SPARQL constraints (parse-verified by n3; enforcement requires a
 *     SPARQL-capable SHACL engine, e.g. pyshacl/topbraid — rdf-validate-shacl does
 *     not implement sh:SPARQL):
 *     - Parameter-free direct sh:sparql: ValidIntervalConsistency,
 *       KnowledgeIntervalConsistency, PublishBeforeReceive, ObservationBeforeRecording
 *       (standard direct SPARQL constraints; only $this pre-bound; BOUND() syntax).
 *     - Parameterized sh:ConstraintComponent: NoFutureKnowledge ($referenceTime),
 *       AvailabilityBeforeUse ($queryTime) — declared as standard constraint
 *       components with sh:parameter + sh:SPARQLSelectValidator so the runtime
 *       parameter is properly declared and bound by the engine when invoked.
 *
 * Output:
 *   ontology/meta/projection/axiolune-meta.shacl.ttl          (Tier 1)
 *   ontology/meta/projection/axiolune-meta.shacl-sparql.ttl   (Tier 2)
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
const OUT1 = path.join(PROJECTION_DIR, 'axiolune-meta.shacl.ttl');       // Tier 1 (machine-verifiable)
const OUT2 = path.join(PROJECTION_DIR, 'axiolune-meta.shacl-sparql.ttl'); // Tier 2 (parse-verified)
const AX = 'https://axiolune.ai/ontology/meta/';
const SH = 'http://www.w3.org/ns/shacl#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

const core = yaml.load(fs.readFileSync(path.join(META_DIR, 'core-meta-model.yaml'), 'utf8'));
const patterns = yaml.load(fs.readFileSync(path.join(META_DIR, 'cross-domain-patterns.yaml'), 'utf8'));
const constraints = (patterns.CrossDomainPatterns && patterns.CrossDomainPatterns.constraints) || {};
const attrs = {};
for (const k of Object.keys(core.MetaModel || {})) {
  const v = core.MetaModel[k];
  if (v && v.namespace === 'pattern' && v.iri) attrs[v.localName || k] = v;
}

const quads = [];
const sparqlQuads = []; // Tier 2 only (separate file)
const add = (s, p, o) => quads.push(quad(s, p, o, namedNode('')));
const addSparql = (s, p, o) => sparqlQuads.push(quad(s, p, o, namedNode('')));
const sh = (n) => namedNode(SH + n);
let bn = 0;
const bnode = () => DataFactory.blankNode('b' + (++bn));

function rdfList(values) {
  if (values.length === 0) return namedNode(RDF + 'nil');
  const head = bnode();
  let current = head;
  values.forEach((value, index) => {
    add(current, namedNode(RDF + 'first'), value);
    const next = index === values.length - 1 ? namedNode(RDF + 'nil') : bnode();
    add(current, namedNode(RDF + 'rest'), next);
    current = next;
  });
  return head;
}

function severityOf(c) {
  const s = (c.severity || '').toLowerCase();
  if (s === 'warning') return sh('Warning');
  if (s === 'info') return sh('Info');
  return sh('Violation');
}

// ---- Anchor class + shape (Tier 1 file) ----
// PatternFactShape targets the abstract anchor and carries the pattern-agnostic
// format/range constraints (ConfidenceRange, DigestFormat, SemanticVersionFormat).
const factClass = namedNode(AX + 'PatternFact');
const factShape = namedNode(AX + 'PatternFactShape');
add(factClass, namedNode(RDF + 'type'), namedNode('http://www.w3.org/2002/07/owl#Class'));
add(factShape, namedNode(RDF + 'type'), sh('NodeShape'));
add(factShape, sh('targetClass'), factClass);

// ---- Canonical structured-value shapes (Tier 1) ----
// These shapes are derived from the same M3 projection metadata used by OWL.
// The cardinalities are part of the v0.6 canonical encoding: effective scale
// and rounding values are emitted, so replay never depends on generator defaults.
const REQUIRED_STRUCTURED_COMPONENTS = new Set([
  'hasAmount', 'hasCurrency', 'hasScale',
  'hasNumericValue', 'hasUnit', 'hasRounding',
]);
let structuredShapes = 0;
function projectStructuredShape(typeDefinition) {
  const projection = typeDefinition && typeDefinition.owlProjection;
  if (!projection || projection.kind !== 'structuredValueClass' || !projection.classIri) return;
  const shape = namedNode(projection.classIri + 'Shape');
  add(shape, namedNode(RDF + 'type'), sh('NodeShape'));
  add(shape, sh('targetClass'), namedNode(projection.classIri));
  for (const property of (projection.properties || [])) {
    if (!property.predicateIri) continue;
    const propertyShape = bnode();
    const localName = property.predicateIri.slice(property.predicateIri.lastIndexOf('/') + 1);
    add(shape, sh('property'), propertyShape);
    add(propertyShape, sh('path'), namedNode(property.predicateIri));
    const range = typeof property.range === 'string' && property.range.startsWith('xsd:')
      ? XSD + property.range.slice(4)
      : property.range;
    if (range) add(propertyShape, sh('datatype'), namedNode(range));
    add(
      propertyShape,
      sh('minCount'),
      literal(REQUIRED_STRUCTURED_COMPONENTS.has(localName) ? '1' : '0', namedNode(XSD + 'integer')),
    );
    add(propertyShape, sh('maxCount'), literal('1', namedNode(XSD + 'integer')));
    if (property.pattern) add(propertyShape, sh('pattern'), literal(property.pattern));
    if (localName === 'hasUnit') {
      add(propertyShape, sh('pattern'), literal('^[A-Za-z][A-Za-z0-9+.-]*:[^\\s]+$'));
    }
    if (Array.isArray(property.values) && property.values.length) {
      add(propertyShape, sh('in'), rdfList(property.values.map((value) => literal(String(value)))));
    }
  }
  structuredShapes++;
}
projectStructuredShape(core.MetaModel && core.MetaModel.MoneyTypeDefinition);
projectStructuredShape(core.MetaModel && core.MetaModel.QuantityTypeDefinition);

// ---- Per-pattern anchor classes + targeted shapes (Tier 1) ----
// Each pattern that injects required attributes gets its own anchor class and
// a targeted NodeShape requiring those attributes with their INJECTED cardinality
// (not the attribute's defaultCardinality). This encodes e.g. "TemporalFact
// requires validFrom and knowledgeFrom (minCount 1)" as an enforceable shape,
// testable against instances of ax:TemporalFact. M2 types bind via rdfs:subClassOf
// or sh:node. Conflicting patterns (TemporalFact vs TemporalObservation) get
// separate anchor classes; mutual exclusivity is a domain-ontology concern.
const VT_XSD = { string: 'string', decimal: 'decimal', integer: 'integer', boolean: 'boolean', date: 'date', instant: 'dateTime', duration: 'duration', uri: 'anyURI' };
function datatypeOf(attrIri) {
  for (const k in attrs) if (attrs[k].iri === attrIri) return VT_XSD[attrs[k].valueType];
  return null;
}
let patternShapes = 0;
const patternList = (patterns.CrossDomainPatterns && patterns.CrossDomainPatterns.patterns) || [];
for (const p of patternList) {
  if (!Array.isArray(p.injectedAttributes) || p.injectedAttributes.length === 0) continue;
  // Use the pattern's canonical IRI (from source) so projection is consistent with M2 bindings.
  const pClass = namedNode(p.iri || (AX + p.localName));
  const pShape = namedNode((p.iri || (AX + p.localName)) + 'Shape');
  add(pClass, namedNode(RDF + 'type'), namedNode('http://www.w3.org/2002/07/owl#Class'));
  add(pClass, namedNode('http://www.w3.org/2000/01/rdf-schema#subClassOf'), factClass);
  add(pShape, namedNode(RDF + 'type'), sh('NodeShape'));
  add(pShape, sh('targetClass'), pClass);
  for (const ia of p.injectedAttributes) {
    if (!ia.attribute) continue;
    const ps = bnode();
    add(pShape, sh('property'), ps);
    add(ps, sh('path'), namedNode(ia.attribute));
    const dt = datatypeOf(ia.attribute);
    if (dt) add(ps, sh('datatype'), namedNode(XSD + dt));
    if (ia.minCount !== undefined) add(ps, sh('minCount'), literal(String(ia.minCount), namedNode(XSD + 'integer')));
    if (ia.maxCount !== undefined && ia.maxCount !== null) add(ps, sh('maxCount'), literal(String(ia.maxCount), namedNode(XSD + 'integer')));
  }
  patternShapes++;
}

// ---- Separate anchor shape for the SPARQL file (Tier 2, parse-verified) ----
const sparqlShape = namedNode(AX + 'PatternFactSparqlShape');
addSparql(factClass, namedNode(RDF + 'type'), namedNode('http://www.w3.org/2002/07/owl#Class'));
addSparql(sparqlShape, namedNode(RDF + 'type'), sh('NodeShape'));
addSparql(sparqlShape, sh('targetClass'), factClass);

// ---- Tier 1: format/range constraints as sh:property on PatternFactShape ----
function addPropertyShape(pathIri, build) {
  const ps = bnode();
  add(factShape, sh('property'), ps);
  add(ps, sh('path'), namedNode(pathIri));
  build(ps);
  return ps;
}

let tier1 = 0;
if (constraints.ConfidenceRange) {
  addPropertyShape(constraints.ConfidenceRange.targetElement, (ps) => {
    add(ps, sh('minInclusive'), literal('0.0', namedNode(XSD + 'decimal')));
    add(ps, sh('maxInclusive'), literal('1.0', namedNode(XSD + 'decimal')));
    add(ps, sh('message'), literal(constraints.ConfidenceRange.message));
    add(ps, sh('severity'), severityOf(constraints.ConfidenceRange));
  }); tier1++;
}
if (constraints.DigestFormat) {
  addPropertyShape(constraints.DigestFormat.targetElement, (ps) => {
    add(ps, sh('pattern'), literal('^(sha256|sha512|blake3):[a-f0-9]{64,128}$'));
    add(ps, sh('message'), literal(constraints.DigestFormat.message));
    add(ps, sh('severity'), severityOf(constraints.DigestFormat));
  }); tier1++;
}
if (constraints.SemanticVersionFormat) {
  addPropertyShape(constraints.SemanticVersionFormat.targetElement, (ps) => {
    add(ps, sh('pattern'), literal('^[0-9]+\\.[0-9]+\\.[0-9]+$'));
    add(ps, sh('message'), literal(constraints.SemanticVersionFormat.message));
    add(ps, sh('severity'), severityOf(constraints.SemanticVersionFormat));
  }); tier1++;
}

// ---- Tier 2: sh:SPARQL constraints ----
// Parameter-free constraints: direct sh:sparql on sparqlShape (standard SHACL;
// only $this is pre-bound). Fixed FILTER syntax uses BOUND() per SPARQL 1.1.
// Parameterized constraints (NoFutureKnowledge/AvailabilityBeforeUse) are declared
// as standard sh:ConstraintComponent with sh:parameter + sh:SPARQLSelectValidator;
// the runtime PIT validator binds the parameter from MaterializationRun/Query.
function sparqlFor(name, c) {
  const pathOf = (iri) => '<' + iri + '>';
  const sel = {
    ValidIntervalConsistency: `SELECT $this WHERE { $this ${pathOf(attrs.validFrom.iri)} ?vf . $this ${pathOf(attrs.validTo.iri)} ?vt . FILTER(BOUND(?vt) && ?vf > ?vt) }`,
    KnowledgeIntervalConsistency: `SELECT $this WHERE { $this ${pathOf(attrs.knowledgeFrom.iri)} ?kf . $this ${pathOf(attrs.knowledgeTo.iri)} ?kt . FILTER(BOUND(?kt) && ?kf > ?kt) }`,
    AvailabilityIntervalConsistency: `SELECT $this WHERE { $this ${pathOf(attrs.availableFrom.iri)} ?af . $this ${pathOf(attrs.availableTo.iri)} ?at . FILTER(BOUND(?at) && ?af > ?at) }`,
    PublishBeforeReceive: `SELECT $this WHERE { $this ${pathOf(attrs.publishedAt.iri)} ?pub . $this ${pathOf(attrs.receivedAt.iri)} ?rcv . FILTER(?pub > ?rcv) }`,
    ObservationBeforeRecording: `SELECT $this WHERE { $this ${pathOf(attrs.observedAt.iri)} ?obs . $this ${pathOf(attrs.recordedAt.iri)} ?rec . FILTER(?obs > ?rec) }`,
  };
  if (sel[name]) {
    const sp = bnode();
    addSparql(sparqlShape, sh('sparql'), sp);
    addSparql(sp, sh('message'), literal(c.message));
    addSparql(sp, sh('severity'), severityOf(c));
    addSparql(sp, namedNode(SH + 'select'), literal(sel[name]));
    return 'sparql';
  }
  if (name === 'NoFutureKnowledge' || name === 'AvailabilityBeforeUse') {
    // Declare a standard sh:ConstraintComponent (NOT a direct sh:sparql constraint),
    // so the custom parameter ($referenceTime / $queryTime) is properly declared and
    // pre-bound by the engine when the component is invoked on a shape.
    const isRef = name === 'NoFutureKnowledge';
    const compIri = namedNode(AX + name + 'Component');
    const paramPath = namedNode(AX + (isRef ? 'referenceTime' : 'queryTime'));
    const from = isRef ? attrs.knowledgeFrom.iri : attrs.availableFrom.iri;
    const param = isRef ? '$referenceTime' : '$queryTime';
    addSparql(compIri, namedNode(RDF + 'type'), sh('ConstraintComponent'));
    addSparql(compIri, namedNode('http://www.w3.org/2000/01/rdf-schema#label'), literal(c.label || name));
    const paramBn = bnode();
    addSparql(compIri, sh('parameter'), paramBn);
    addSparql(paramBn, sh('path'), paramPath);
    addSparql(paramBn, sh('datatype'), namedNode(XSD + 'dateTime'));
    addSparql(paramBn, sh('minCount'), literal('1', namedNode(XSD + 'integer')));
    addSparql(paramBn, sh('description'), literal(isRef ? 'Immutable reference time from MaterializationRun (ADR-012)' : 'Explicit query time (asOfAvailable) supplied by caller (ADR-012)'));
    const validatorBn = bnode();
    addSparql(compIri, sh('validator'), validatorBn);
    addSparql(validatorBn, namedNode(RDF + 'type'), sh('SPARQLSelectValidator'));
    addSparql(validatorBn, sh('message'), literal(c.message));
    addSparql(validatorBn, sh('severity'), severityOf(c));
    addSparql(validatorBn, namedNode(SH + 'select'), literal(`SELECT $this WHERE { $this ${pathOf(from)} ?t . FILTER(?t > ${param}) }`));
    return 'sparql-component';
  }
  return 'skip';
}

let tier2 = 0, tier2param = 0;
for (const name of Object.keys(constraints)) {
  const r = sparqlFor(name, constraints[name]);
  if (r === 'sparql') tier2++;
  else if (r === 'sparql-component') tier2param++;
}

// ---- Serialize ----
const prefixes = { sh: SH, xsd: XSD, ax: AX, rdf: RDF, rdfs: RDFS, owl: 'http://www.w3.org/2002/07/owl#' };
function writeQuads(file, qset, header) {
  const writer = new Writer({ prefixes });
  if (header) writer.addQuad(namedNode(AX), namedNode('http://www.w3.org/2000/01/rdf-schema#comment'), literal(header));
  for (const q of qset) writer.addQuad(q.subject, q.predicate, q.object);
  writer.end((error, result) => {
    if (error) { console.error('write error', error); process.exit(1); }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, result);
  });
}
fs.mkdirSync(path.dirname(OUT1), { recursive: true });
writeQuads(OUT1, quads, 'Axiolune meta-model SHACL shapes — Tier 1 (machine-verifiable via rdf-validate-shacl).');
writeQuads(OUT2, sparqlQuads, 'Axiolune meta-model SHACL Tier 2 — parameter-free sh:sparql + parameterized sh:ConstraintComponent (parse-verified; enforcement requires a SPARQL-capable SHACL engine, e.g. pyshacl).');
console.log(`✓ SHACL projected: Tier1 ${tier1} format/range + ${patternShapes} per-pattern + ${structuredShapes} structured-value shapes (machine-verifiable) -> ${path.basename(OUT1)}`);
console.log(`✓ SHACL projected: Tier2 ${tier2} parameter-free SPARQL + ${tier2param} ConstraintComponent (parse-verified) -> ${path.basename(OUT2)}`);
console.log(`  ${quads.length} Tier1 triples, ${sparqlQuads.length} Tier2 triples`);
