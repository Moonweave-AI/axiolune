#!/usr/bin/env node
/**
 * M2 -> OWL projection generator (ADR-013 §6 generator contract).
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

const VT_TO_XSD = {
  string: XSD + 'string', decimal: XSD + 'decimal', integer: XSD + 'integer',
  boolean: XSD + 'boolean', date: XSD + 'date', instant: XSD + 'dateTime',
  duration: XSD + 'duration', uri: XSD + 'anyURI',
};

function expandRange(r) {
  if (!r || typeof r !== 'string') return XSD + 'string';
  if (r.startsWith('http')) return r;
  if (r.startsWith('xsd:')) return XSD + r.slice(4);
  return VT_TO_XSD[r] || XSD + 'string';
}

if (process.argv.length < 3) {
  console.error('Usage: node generate-m2-owl.js <moduleInfo.yaml> [<output.ttl>]');
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
  const element = domain[localName];
  if (!element || !element.iri) continue;

  const elemIri = namedNode(element.iri);
  const fields = Object.keys(element);
  const hasParticipantRoles = fields.includes('participantRoles');
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
      const roleProp = namedNode(element.iri + '_' + role.roleName);
      add(roleProp, namedNode(RDF + 'type'), namedNode(OWL + 'ObjectProperty'));
      add(roleProp, namedNode(RDFS + 'domain'), elemIri);
      if (role.range) add(roleProp, namedNode(RDFS + 'range'), namedNode(role.range));
      if (role.roleName) add(roleProp, namedNode(RDFS + 'label'), literal(role.roleName));
    }
    assocCount++;
  }
  else if (hasValues) {
    add(elemIri, namedNode(RDF + 'type'), namedNode(OWL + 'Class'));
    if (element.label) add(elemIri, namedNode(RDFS + 'label'), literal(element.label));
    if (element.definition) add(elemIri, namedNode(RDFS + 'comment'), literal(element.definition));

    for (const value of (element.values || [])) {
      const valueIri = namedNode(element.iri + '_' + value);
      add(valueIri, namedNode(RDF + 'type'), elemIri);
      add(valueIri, namedNode(RDFS + 'label'), literal(value));
    }
    codeListCount++;
  }
  else if (hasPattern && !hasValueType) {
    add(elemIri, namedNode(RDF + 'type'), namedNode(OWL + 'DatatypeProperty'));
    if (element.label) add(elemIri, namedNode(RDFS + 'label'), literal(element.label));
    if (element.definition) add(elemIri, namedNode(RDFS + 'comment'), literal(element.definition));
    add(elemIri, namedNode(RDFS + 'range'), namedNode(XSD + 'string'));
    idCount++;
  }
  else if (hasDomain || hasRange) {
    add(elemIri, namedNode(RDF + 'type'), namedNode(OWL + 'ObjectProperty'));
    if (element.label) add(elemIri, namedNode(RDFS + 'label'), literal(element.label));
    if (element.definition) add(elemIri, namedNode(RDFS + 'comment'), literal(element.definition));
    if (element.domain) add(elemIri, namedNode(RDFS + 'domain'), namedNode(element.domain));
    if (element.range) add(elemIri, namedNode(RDFS + 'range'), namedNode(element.range));
    relationCount++;
  }
  else if (hasValueType) {
    add(elemIri, namedNode(RDF + 'type'), namedNode(OWL + 'DatatypeProperty'));
    if (element.label) add(elemIri, namedNode(RDFS + 'label'), literal(element.label));
    if (element.definition) add(elemIri, namedNode(RDFS + 'comment'), literal(element.definition));
    const range = expandRange(element.valueType);
    add(elemIri, namedNode(RDFS + 'range'), namedNode(range));
    attrCount++;
  }
  else {
    add(elemIri, namedNode(RDF + 'type'), namedNode(OWL + 'Class'));
    if (element.label) add(elemIri, namedNode(RDFS + 'label'), literal(element.label));
    if (element.definition) add(elemIri, namedNode(RDFS + 'comment'), literal(element.definition));

    for (const superType of (element.superTypes || [])) {
      add(elemIri, namedNode(RDFS + 'subClassOf'), namedNode(superType));
    }
    objectCount++;
  }
}

const writer = new Writer({ prefixes: {
  owl: OWL, rdf: RDF, rdfs: RDFS, xsd: XSD,
} });
writer.addPrefix(moduleInfo.preferredPrefix, moduleInfo.baseIri);
for (const q of quads) writer.addQuad(q.subject, q.predicate, q.object);
writer.end(function(error, result) {
  if (error) { console.error('write error', error); process.exit(1); }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, result);
  console.log('✓ M2 OWL projected: ' + objectCount + ' classes, ' + attrCount + ' attributes, ' + relationCount + ' relations, ' + assocCount + ' associations, ' + idCount + ' identifiers, ' + codeListCount + ' code lists');
  console.log('  ' + quads.length + ' triples -> ' + path.basename(outputFile));
});
