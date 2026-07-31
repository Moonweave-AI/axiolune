#!/usr/bin/env node
/**
 * M2 -> OWL projection generator (ADR-013 §6).
 * Canonical dialect: participantRoles / attributeUses / pattern.
 * Structured valueTypes (absolute IRI, MonetaryAmount, QuantityValue) → owl:ObjectProperty.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Writer, DataFactory } = require('n3');
const { quad, namedNode, literal } = DataFactory;

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';

const VT_TO_XSD = {
  string: XSD + 'string', decimal: XSD + 'decimal', integer: XSD + 'integer',
  boolean: XSD + 'boolean', date: XSD + 'date', instant: XSD + 'dateTime',
  duration: XSD + 'duration', uri: XSD + 'anyURI', codelist: XSD + 'string',
};

const STRUCTURED_HINTS = new Set([
  'Money', 'MonetaryAmount', 'Quantity', 'QuantityValue',
  'https://axiolune.ai/ontology/meta/core/values/MonetaryAmount',
  'https://axiolune.ai/ontology/meta/core/values/QuantityValue',
  'https://axiolune.ai/ontology/finance/foundation/MonetaryAmount',
  'https://axiolune.ai/ontology/finance/foundation/QuantityValue',
]);

function expandRange(r) {
  if (!r || typeof r !== 'string') return XSD + 'string';
  if (r.startsWith('http')) return r;
  if (r.startsWith('xsd:')) return XSD + r.slice(4);
  return VT_TO_XSD[r] || XSD + 'string';
}

function isStructuredValueType(vt) {
  if (!vt || typeof vt !== 'string') return false;
  if (STRUCTURED_HINTS.has(vt)) return true;
  if (vt.startsWith('http') && (vt.includes('MonetaryAmount') || vt.includes('QuantityValue') || vt.includes('/Money') || vt.includes('/Quantity'))) {
    return true;
  }
  return false;
}

function localNameFromIri(iri) {
  if (!iri || typeof iri !== 'string') return null;
  const hash = iri.lastIndexOf('#');
  const slash = iri.lastIndexOf('/');
  return iri.slice(Math.max(hash, slash) + 1);
}

/** Accept legacy dialect keys if present (defensive; sources should already be normalized). */
function normalizeElement(el) {
  const out = { ...el };
  if (Array.isArray(el.participants) && !el.participantRoles) {
    out.participantRoles = el.participants.map((p) => ({
      roleName: p.roleName || localNameFromIri(p.roleIri),
      range: p.range || p.targetTypeIri,
      minCount: p.minCount,
      maxCount: p.maxCount,
      roleIri: p.roleIri,
    }));
  }
  if (Array.isArray(el.attributes) && !el.attributeUses) {
    if (el.attributes.every((a) => a && (a.attributeIri || a.attribute))) {
      out.attributeUses = el.attributes.map((a) => ({
        attribute: a.attribute || a.attributeIri,
        minCount: a.minCount,
        maxCount: a.maxCount,
      }));
    }
  }
  if (Array.isArray(el.patternBindings)) {
    out.patternBindings = el.patternBindings.map((b) => {
      const pattern = b.pattern || b.patternIri;
      return {
        ...b,
        pattern: pattern && pattern.includes('/foundation/patterns/')
          ? pattern.replace('/foundation/patterns/', '/meta/patterns/')
          : pattern,
      };
    });
  }
  return out;
}

if (process.argv.length < 3) {
  console.error('Usage: node generate-m2-owl.cjs <module.yaml> [<output.ttl>]');
  process.exit(1);
}

const inputFile = process.argv[2];
const outputFile = process.argv[3] || inputFile.replace(/\.yaml$/, '.owl.ttl');

if (!fs.existsSync(inputFile)) {
  console.error('Error: ' + inputFile + ' not found');
  process.exit(1);
}

const doc = yaml.load(fs.readFileSync(inputFile, 'utf8'));
if (!doc.module || !doc.domain) {
  console.error('Error: Not a valid M2 module (missing module + domain envelope)');
  process.exit(1);
}

const moduleInfo = doc.module;
const domain = doc.domain;
const quads = [];

function add(s, p, o) { quads.push(quad(s, p, o, namedNode(''))); }

const ONT = namedNode(moduleInfo.moduleIri);
add(ONT, namedNode(RDF + 'type'), namedNode(OWL + 'Ontology'));
add(ONT, namedNode(OWL + 'versionIRI'), namedNode(moduleInfo.moduleIri + '/' + moduleInfo.version));
if (moduleInfo.label) add(ONT, namedNode(RDFS + 'label'), literal(moduleInfo.label));
if (moduleInfo.definition) add(ONT, namedNode(RDFS + 'comment'), literal(moduleInfo.definition));

for (const imp of (moduleInfo.imports || [])) {
  add(ONT, namedNode(OWL + 'imports'), namedNode(imp.moduleIri));
}

let objectCount = 0, attrCount = 0, relationCount = 0, assocCount = 0, idCount = 0, codeListCount = 0;

for (const localName in domain) {
  const element = normalizeElement(domain[localName]);
  if (!element || !element.iri) continue;

  const elemIri = namedNode(element.iri);
  const fields = Object.keys(element);
  const hasParticipantRoles = Array.isArray(element.participantRoles);
  const hasValueType = fields.includes('valueType');
  const hasPattern = fields.includes('pattern');
  const hasValues = fields.includes('values');
  const hasDomain = fields.includes('domain');
  const hasRange = fields.includes('range');

  if (hasParticipantRoles) {
    add(elemIri, namedNode(RDF + 'type'), namedNode(OWL + 'Class'));
    if (element.label) add(elemIri, namedNode(RDFS + 'label'), literal(element.label));
    if (element.definition) add(elemIri, namedNode(RDFS + 'comment'), literal(element.definition));

    for (const role of (element.participantRoles || [])) {
      const rolePropIri = role.roleIri || (element.iri + '_' + role.roleName);
      const roleProp = namedNode(rolePropIri);
      add(roleProp, namedNode(RDF + 'type'), namedNode(OWL + 'ObjectProperty'));
      add(roleProp, namedNode(RDFS + 'domain'), elemIri);
      if (role.range) add(roleProp, namedNode(RDFS + 'range'), namedNode(role.range));
      if (role.roleName) add(roleProp, namedNode(RDFS + 'label'), literal(role.roleName));
    }
    assocCount++;
  } else if (hasValues) {
    add(elemIri, namedNode(RDF + 'type'), namedNode(OWL + 'Class'));
    if (element.label) add(elemIri, namedNode(RDFS + 'label'), literal(element.label));
    if (element.definition) add(elemIri, namedNode(RDFS + 'comment'), literal(element.definition));
    for (const value of (element.values || [])) {
      const valueIri = namedNode(element.iri + '_' + value);
      add(valueIri, namedNode(RDF + 'type'), elemIri);
      add(valueIri, namedNode(RDFS + 'label'), literal(value));
    }
    codeListCount++;
  } else if (hasPattern && !hasValueType) {
    add(elemIri, namedNode(RDF + 'type'), namedNode(OWL + 'DatatypeProperty'));
    if (element.label) add(elemIri, namedNode(RDFS + 'label'), literal(element.label));
    if (element.definition) add(elemIri, namedNode(RDFS + 'comment'), literal(element.definition));
    add(elemIri, namedNode(RDFS + 'range'), namedNode(XSD + 'string'));
    idCount++;
  } else if ((hasDomain || hasRange) && !hasValueType) {
    add(elemIri, namedNode(RDF + 'type'), namedNode(OWL + 'ObjectProperty'));
    if (element.label) add(elemIri, namedNode(RDFS + 'label'), literal(element.label));
    if (element.definition) add(elemIri, namedNode(RDFS + 'comment'), literal(element.definition));
    if (element.domain) add(elemIri, namedNode(RDFS + 'domain'), namedNode(element.domain));
    if (element.range) add(elemIri, namedNode(RDFS + 'range'), namedNode(element.range));
    relationCount++;
  } else if (hasValueType) {
    const vt = element.valueType;
    // Absolute-IRI valueTypes (Currency, TradingVenue, FinancialInstrument, MonetaryAmount, QuantityValue) are object references → owl:ObjectProperty.
    // Leaf valueTypes (string/decimal/xsd:*) → owl:DatatypeProperty.
    const isObjectRef = (typeof vt === 'string' && vt.startsWith('http')) || isStructuredValueType(vt);
    add(elemIri, namedNode(RDF + 'type'), namedNode(isObjectRef ? OWL + 'ObjectProperty' : OWL + 'DatatypeProperty'));
    if (element.label) add(elemIri, namedNode(RDFS + 'label'), literal(element.label));
    if (element.definition) add(elemIri, namedNode(RDFS + 'comment'), literal(element.definition));
    add(elemIri, namedNode(RDFS + 'range'), namedNode(expandRange(vt)));
    attrCount++;
  } else {
    add(elemIri, namedNode(RDF + 'type'), namedNode(OWL + 'Class'));
    if (element.label) add(elemIri, namedNode(RDFS + 'label'), literal(element.label));
    if (element.definition) add(elemIri, namedNode(RDFS + 'comment'), literal(element.definition));
    for (const superType of (element.superTypes || [])) {
      add(elemIri, namedNode(RDFS + 'subClassOf'), namedNode(superType));
    }
    objectCount++;
  }
}

// Project alignments (M2-PLAN §5.4) into OWL subclass / subproperty / SKOS mapping triples
for (const localName in domain) {
  const element = normalizeElement(domain[localName]);
  if (!element || !element.iri || !Array.isArray(element.alignments)) continue;
  const elemIri = namedNode(element.iri);
  for (const al of element.alignments) {
    if (!al || !al.targetIri) continue;
    const target = namedNode(al.targetIri);
    const rel = al.relation || 'skos:closeMatch';
    switch (rel) {
      case 'rdfs:subClassOf':
        add(elemIri, namedNode(RDFS + 'subClassOf'), target);
        break;
      case 'rdfs:subPropertyOf':
        add(elemIri, namedNode(RDFS + 'subPropertyOf'), target);
        break;
      case 'skos:closeMatch':
      case 'skos:exactMatch':
      case 'skos:broadMatch':
      case 'skos:narrowMatch':
      case 'skos:relatedMatch':
        add(elemIri, namedNode(SKOS + rel.slice(5)), target);
        break;
      case 'owl:equivalentClass':
        add(elemIri, namedNode(OWL + 'equivalentClass'), target);
        break;
      case 'owl:equivalentProperty':
        add(elemIri, namedNode(OWL + 'equivalentProperty'), target);
        break;
      default:
        // Unknown relation: emit as annotation property linking to target
        add(elemIri, namedNode(SKOS + 'closeMatch'), target);
    }
  }
}

const writer = new Writer({ prefixes: {
  owl: OWL, rdf: RDF, rdfs: RDFS, xsd: XSD, skos: SKOS,
} });
writer.addPrefix(moduleInfo.preferredPrefix, moduleInfo.baseIri);
for (const q of quads) writer.addQuad(q.subject, q.predicate, q.object);
writer.end(function(error, result) {
  if (error) { console.error('write error', error); process.exit(1); }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, result);
  // Status to stderr so shell redirects of stdout cannot corrupt TTL.
  console.error('✓ M2 OWL projected: ' + objectCount + ' classes, ' + attrCount + ' attributes, ' + relationCount + ' relations, ' + assocCount + ' associations, ' + idCount + ' identifiers, ' + codeListCount + ' code lists');
  console.error('  ' + quads.length + ' triples -> ' + path.basename(outputFile));
});
