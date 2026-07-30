#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Writer, DataFactory } = require('n3');
const { quad, namedNode, literal } = DataFactory;

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SH = 'http://www.w3.org/ns/shacl#';

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
  console.error('Usage: node generate-m2-shacl.cjs <module.yaml> [<output.ttl>]');
  process.exit(1);
}

const inputFile = process.argv[2];
const outputFile = process.argv[3] || inputFile.replace(/\.yaml$/, '.shacl.ttl');

if (!fs.existsSync(inputFile)) {
  console.error('Error: ' + inputFile + ' not found');
  process.exit(1);
}

const doc = yaml.load(fs.readFileSync(inputFile, 'utf8'));
if (!doc.module || !doc.domain) {
  console.error('Error: Not a valid M2 module');
  process.exit(1);
}

const moduleInfo = doc.module;
const domain = doc.domain;
const quads = [];

function add(s, p, o) { quads.push(quad(s, p, o, namedNode(''))); }

let shapeCount = 0, propertyCount = 0;

for (const localName in domain) {
  const element = domain[localName];
  if (!element || !element.iri) continue;

  const elemIri = namedNode(element.iri);
  const fields = Object.keys(element);
  const hasParticipantRoles = fields.includes('participantRoles');
  const hasSuperTypes = fields.includes('superTypes');
  const hasAttributeUses = fields.includes('attributeUses');
  const hasValueType = fields.includes('valueType');
  const hasValues = fields.includes('values');
  const hasPattern = fields.includes('pattern');

  if (hasParticipantRoles || hasSuperTypes || hasAttributeUses || (!hasValueType && !hasValues && !hasPattern)) {
    const shapeIri = namedNode(element.iri + 'Shape');
    add(shapeIri, namedNode(RDF + 'type'), namedNode(SH + 'NodeShape'));
    add(shapeIri, namedNode(SH + 'targetClass'), elemIri);

    if (element.label) add(shapeIri, namedNode(SH + 'name'), literal(element.label));
    if (element.definition) add(shapeIri, namedNode(SH + 'description'), literal(element.definition));

    for (const attrUse of (element.attributeUses || [])) {
      const propShapeIri = namedNode(element.iri + 'Shape_' + attrUse.attribute.split('/').pop());
      add(shapeIri, namedNode(SH + 'property'), propShapeIri);

      add(propShapeIri, namedNode(RDF + 'type'), namedNode(SH + 'PropertyShape'));
      add(propShapeIri, namedNode(SH + 'path'), namedNode(attrUse.attribute));

      if (attrUse.minCount !== undefined && attrUse.minCount !== null) {
        add(propShapeIri, namedNode(SH + 'minCount'), literal(attrUse.minCount.toString(), namedNode(XSD + 'integer')));
      }
      if (attrUse.maxCount !== undefined && attrUse.maxCount !== null) {
        add(propShapeIri, namedNode(SH + 'maxCount'), literal(attrUse.maxCount.toString(), namedNode(XSD + 'integer')));
      }

      propertyCount++;
    }

    for (const role of (element.participantRoles || [])) {
      const propShapeIri = namedNode(element.iri + 'Shape_' + role.roleName);
      add(shapeIri, namedNode(SH + 'property'), propShapeIri);

      add(propShapeIri, namedNode(RDF + 'type'), namedNode(SH + 'PropertyShape'));
      add(propShapeIri, namedNode(SH + 'path'), namedNode(element.iri + '_' + role.roleName));

      if (role.minCount !== undefined && role.minCount !== null) {
        add(propShapeIri, namedNode(SH + 'minCount'), literal(role.minCount.toString(), namedNode(XSD + 'integer')));
      }
      if (role.maxCount !== undefined && role.maxCount !== null) {
        add(propShapeIri, namedNode(SH + 'maxCount'), literal(role.maxCount.toString(), namedNode(XSD + 'integer')));
      }
      if (role.range) {
        add(propShapeIri, namedNode(SH + 'class'), namedNode(role.range));
      }

      propertyCount++;
    }

    shapeCount++;
  }

  if (hasPattern && hasValueType) {
    const propShapeIri = namedNode(element.iri + 'Shape');
    add(propShapeIri, namedNode(RDF + 'type'), namedNode(SH + 'PropertyShape'));
    add(propShapeIri, namedNode(SH + 'path'), elemIri);

    if (element.pattern) {
      add(propShapeIri, namedNode(SH + 'pattern'), literal(element.pattern));
    }

    const datatype = expandRange(element.valueType);
    add(propShapeIri, namedNode(SH + 'datatype'), namedNode(datatype));

    if (element.label) add(propShapeIri, namedNode(SH + 'name'), literal(element.label));

    propertyCount++;
  }

  if (hasValues) {
    const propShapeIri = namedNode(element.iri + 'Shape');
    add(propShapeIri, namedNode(RDF + 'type'), namedNode(SH + 'PropertyShape'));
    add(propShapeIri, namedNode(SH + 'path'), elemIri);

    for (const value of (element.values || [])) {
      const valueIri = namedNode(element.iri + '_' + value);
      add(propShapeIri, namedNode(SH + 'hasValue'), valueIri);
    }

    if (element.label) add(propShapeIri, namedNode(SH + 'name'), literal(element.label));

    propertyCount++;
  }
}

const writer = new Writer({ prefixes: {
  rdf: RDF, sh: SH, xsd: XSD,
} });
writer.addPrefix(moduleInfo.preferredPrefix, moduleInfo.baseIri);
for (const q of quads) writer.addQuad(q.subject, q.predicate, q.object);
writer.end(function(error, result) {
  if (error) { console.error('write error', error); process.exit(1); }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, result);
  console.log('✓ M2 SHACL projected: ' + shapeCount + ' node shapes, ' + propertyCount + ' property constraints');
  console.log('  ' + quads.length + ' triples -> ' + path.basename(outputFile));
});
