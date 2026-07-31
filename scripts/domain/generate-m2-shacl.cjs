#!/usr/bin/env node
/**
 * M2 -> SHACL projection generator (ADR-013 §6).
 * Emits NodeShapes with attributeUses + participantRoles cardinalities.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Writer, DataFactory } = require('n3');
const { quad, namedNode, literal, blankNode } = DataFactory;

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const SH = 'http://www.w3.org/ns/shacl#';

const VT_TO_XSD = {
  string: XSD + 'string', decimal: XSD + 'decimal', integer: XSD + 'integer',
  boolean: XSD + 'boolean', date: XSD + 'date', instant: XSD + 'dateTime',
  duration: XSD + 'duration', uri: XSD + 'anyURI', codelist: XSD + 'string',
};

function expandRange(r) {
  if (!r || typeof r !== 'string') return XSD + 'string';
  if (r.startsWith('http')) return r;
  if (r.startsWith('xsd:')) return XSD + r.slice(4);
  return VT_TO_XSD[r] || XSD + 'string';
}

function localNameFromIri(iri) {
  if (!iri || typeof iri !== 'string') return null;
  const hash = iri.lastIndexOf('#');
  const slash = iri.lastIndexOf('/');
  return iri.slice(Math.max(hash, slash) + 1);
}

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
  return out;
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

// Build a cross-module attribute/identifier definition map so SHACL can resolve
// valueTypes even when an attributeUse points to an element imported from another module.
const GLOBAL_ATTR_MAP = new Map();
const FINANCE_DIR = path.join(__dirname, '..', '..', 'ontology', 'domain', 'finance');
if (fs.existsSync(FINANCE_DIR)) {
  for (const name of fs.readdirSync(FINANCE_DIR)) {
    const p = path.join(FINANCE_DIR, name, 'module.yaml');
    if (!fs.existsSync(p)) continue;
    try {
      const other = yaml.load(fs.readFileSync(p, 'utf8'));
      for (const el of Object.values(other.domain || {})) {
        if (el && el.iri && (el.valueType !== undefined || el.codeListReference !== undefined || el.pattern !== undefined || el.datatype !== undefined || el.values !== undefined)) {
          GLOBAL_ATTR_MAP.set(el.iri, el);
        }
      }
    } catch (_) {
      // Ignore malformed partner modules during projection
    }
  }
}
const GLOBAL_CODE_LIST_MAP = new Map();
for (const el of GLOBAL_ATTR_MAP.values()) {
  if (el.values) {
    if (el.localName) GLOBAL_CODE_LIST_MAP.set(el.localName, el);
    if (el.iri) GLOBAL_CODE_LIST_MAP.set(el.iri, el);
  }
}
function resolveCodeList(ref) {
  if (!ref) return null;
  return GLOBAL_CODE_LIST_MAP.get(ref) || null;
}
function resolveAttrDef(attrIri) {
  const local = domain[localNameFromIri(attrIri)];
  if (local && (local.valueType !== undefined || local.codeListReference !== undefined || local.pattern !== undefined || local.datatype !== undefined)) return local;
  return GLOBAL_ATTR_MAP.get(attrIri) || null;
}
const quads = [];

function add(s, p, o) { quads.push(quad(s, p, o, namedNode(''))); }

const writer = new Writer({ prefixes: { rdf: RDF, sh: SH, xsd: XSD } });
writer.addPrefix(moduleInfo.preferredPrefix, moduleInfo.baseIri);

let shapeCount = 0, propertyCount = 0;

for (const localName in domain) {
  const element = normalizeElement(domain[localName]);
  if (!element || !element.iri) continue;

  const elemIri = namedNode(element.iri);
  const fields = Object.keys(element);
  const hasParticipantRoles = Array.isArray(element.participantRoles);
  const hasSuperTypes = fields.includes('superTypes');
  const hasAttributeUses = Array.isArray(element.attributeUses);
  const hasValueType = fields.includes('valueType');
  const hasValues = fields.includes('values');
  const hasPattern = fields.includes('pattern');
  const hasDomainRange = fields.includes('domain') || fields.includes('range');

  if (hasParticipantRoles || hasSuperTypes || hasAttributeUses || (!hasValueType && !hasValues && !hasPattern && !hasDomainRange)) {
    const shapeIri = namedNode(element.iri + 'Shape');
    add(shapeIri, namedNode(RDF + 'type'), namedNode(SH + 'NodeShape'));
    add(shapeIri, namedNode(SH + 'targetClass'), elemIri);

    if (element.label) add(shapeIri, namedNode(SH + 'name'), literal(element.label));
    if (element.definition) add(shapeIri, namedNode(SH + 'description'), literal(element.definition));

    for (const attrUse of (element.attributeUses || [])) {
      const attrLocal = localNameFromIri(attrUse.attribute) || 'attr';
      const propShapeIri = namedNode(element.iri + 'Shape_' + attrLocal);
      add(shapeIri, namedNode(SH + 'property'), propShapeIri);
      add(propShapeIri, namedNode(RDF + 'type'), namedNode(SH + 'PropertyShape'));
      add(propShapeIri, namedNode(SH + 'path'), namedNode(attrUse.attribute));
      if (attrUse.minCount !== undefined && attrUse.minCount !== null) {
        add(propShapeIri, namedNode(SH + 'minCount'), literal(String(attrUse.minCount), namedNode(XSD + 'integer')));
      }
      if (attrUse.maxCount !== undefined && attrUse.maxCount !== null) {
        add(propShapeIri, namedNode(SH + 'maxCount'), literal(String(attrUse.maxCount), namedNode(XSD + 'integer')));
      }
      // Round-5: resolve attribute valueType → sh:class (structured) or sh:datatype (leaf)
      const attrDef = attrUse.attribute && resolveAttrDef(attrUse.attribute);
      if (attrDef && attrDef.valueType) {
        const vt = attrDef.valueType;
        if (vt.startsWith('http') && (vt.includes('MonetaryAmount') || vt.includes('QuantityValue'))) {
          add(propShapeIri, namedNode(SH + 'class'), namedNode(vt));
          add(propShapeIri, namedNode(SH + 'nodeKind'), namedNode(SH + 'BlankNodeOrIRI'));
        } else if (vt.startsWith('http')) {
          // Object reference (Currency, TradingVenue, FinancialInstrument, ...)
          add(propShapeIri, namedNode(SH + 'class'), namedNode(vt));
          add(propShapeIri, namedNode(SH + 'nodeKind'), namedNode(SH + 'BlankNodeOrIRI'));
        } else if (vt === 'codelist') {
          add(propShapeIri, namedNode(SH + 'datatype'), namedNode(XSD + 'string'));
          const cl = resolveCodeList(attrDef.codeListReference);
          if (cl && cl.values && cl.values.length) {
            // Fixture data uses literal code-list values; constrain with sh:in over literals
            add(propShapeIri, namedNode(SH + 'in'), writer.list(cl.values.map((v) => literal(String(v)))));
          }
        } else if (VT_TO_XSD[vt] || (typeof vt === 'string' && vt.startsWith('xsd:'))) {
          add(propShapeIri, namedNode(SH + 'datatype'), namedNode(expandRange(vt)));
        }
      }
      if (attrDef && attrDef.pattern) {
        add(propShapeIri, namedNode(SH + 'pattern'), literal(attrDef.pattern));
      }
      propertyCount++;
    }

    for (const role of (element.participantRoles || [])) {
      const propShapeIri = namedNode(element.iri + 'Shape_' + role.roleName);
      // Role predicate defaults to module namespace so it matches fixture property names
      const rolePath = role.roleIri || (moduleInfo.baseIri + role.roleName);
      add(shapeIri, namedNode(SH + 'property'), propShapeIri);
      add(propShapeIri, namedNode(RDF + 'type'), namedNode(SH + 'PropertyShape'));
      add(propShapeIri, namedNode(SH + 'path'), namedNode(rolePath));
      if (role.minCount !== undefined && role.minCount !== null) {
        add(propShapeIri, namedNode(SH + 'minCount'), literal(String(role.minCount), namedNode(XSD + 'integer')));
      }
      if (role.maxCount !== undefined && role.maxCount !== null) {
        add(propShapeIri, namedNode(SH + 'maxCount'), literal(String(role.maxCount), namedNode(XSD + 'integer')));
      }
      if (role.range) add(propShapeIri, namedNode(SH + 'class'), namedNode(role.range));
      propertyCount++;
    }

    // Round-5: project patternBindings (TemporalFact, ProvenancedFact) into SHACL PropertyShapes
    for (const pb of (element.patternBindings || [])) {
      const pat = typeof pb === 'string' ? pb : pb.pattern;
      if (pat && pat.includes('TemporalFact')) {
        const tfProps = [
          { p: 'https://axiolune.ai/ontology/meta/patterns/attributes/validFrom', min: 1, max: 1 },
          { p: 'https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeFrom', min: 1, max: 1 },
          { p: 'https://axiolune.ai/ontology/meta/patterns/attributes/availableFrom', min: 1, max: 1 },
          { p: 'https://axiolune.ai/ontology/meta/patterns/attributes/validTo', min: 0, max: 1 },
          { p: 'https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeTo', min: 0, max: 1 },
          { p: 'https://axiolune.ai/ontology/meta/patterns/attributes/availableTo', min: 0, max: 1 },
        ];
        for (const tf of tfProps) {
          const localName = tf.p.split('/').pop();
          const propShapeIri = namedNode(element.iri + 'Shape_pat_' + localName);
          add(shapeIri, namedNode(SH + 'property'), propShapeIri);
          add(propShapeIri, namedNode(RDF + 'type'), namedNode(SH + 'PropertyShape'));
          add(propShapeIri, namedNode(SH + 'path'), namedNode(tf.p));
          add(propShapeIri, namedNode(SH + 'datatype'), namedNode(XSD + 'dateTime'));
          if (tf.min > 0) add(propShapeIri, namedNode(SH + 'minCount'), literal(String(tf.min), namedNode(XSD + 'integer')));
          if (tf.max > 0) add(propShapeIri, namedNode(SH + 'maxCount'), literal(String(tf.max), namedNode(XSD + 'integer')));
          propertyCount++;
        }
        // ADR-012: interval ordering constraints (static; reference-time-dependent constraints enforced by PIT validator)
        const temporalAxes = [
          { from: 'https://axiolune.ai/ontology/meta/patterns/attributes/validFrom', to: 'https://axiolune.ai/ontology/meta/patterns/attributes/validTo', name: 'valid' },
          { from: 'https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeFrom', to: 'https://axiolune.ai/ontology/meta/patterns/attributes/knowledgeTo', name: 'knowledge' },
          { from: 'https://axiolune.ai/ontology/meta/patterns/attributes/availableFrom', to: 'https://axiolune.ai/ontology/meta/patterns/attributes/availableTo', name: 'available' },
        ];
        for (const ax of temporalAxes) {
          const sparqlNode = blankNode('sparql_' + ax.name + '_' + localNameFromIri(element.iri));
          add(shapeIri, namedNode(SH + 'sparql'), sparqlNode);
          add(sparqlNode, namedNode(SH + 'message'), literal(ax.name + ' interval inversion: ' + ax.name + 'To must be greater than ' + ax.name + 'From'));
          add(sparqlNode, namedNode(SH + 'select'), literal(
            `SELECT $this WHERE { $this <${ax.from}> ?from ; <${ax.to}> ?to . FILTER (?to <= ?from) }`
          ));
        }
      } else if (pat && pat.includes('ProvenancedFact')) {
        const pfProps = [
          { p: 'https://axiolune.ai/ontology/meta/patterns/attributes/source', min: 0, max: 1 },
        ];
        for (const pf of pfProps) {
          const localName = pf.p.split('/').pop();
          const propShapeIri = namedNode(element.iri + 'Shape_pat_' + localName);
          add(shapeIri, namedNode(SH + 'property'), propShapeIri);
          add(propShapeIri, namedNode(RDF + 'type'), namedNode(SH + 'PropertyShape'));
          add(propShapeIri, namedNode(SH + 'path'), namedNode(pf.p));
          if (pf.min > 0) add(propShapeIri, namedNode(SH + 'minCount'), literal(String(pf.min), namedNode(XSD + 'integer')));
          if (pf.max > 0) add(propShapeIri, namedNode(SH + 'maxCount'), literal(String(pf.max), namedNode(XSD + 'integer')));
          propertyCount++;
        }
      }
    }

    shapeCount++;
  }

  if (hasPattern && hasValueType) {
    const propShapeIri = namedNode(element.iri + 'Shape');
    add(propShapeIri, namedNode(RDF + 'type'), namedNode(SH + 'PropertyShape'));
    add(propShapeIri, namedNode(SH + 'path'), elemIri);
    if (element.pattern) add(propShapeIri, namedNode(SH + 'pattern'), literal(element.pattern));
    add(propShapeIri, namedNode(SH + 'datatype'), namedNode(expandRange(element.valueType)));
    if (element.label) add(propShapeIri, namedNode(SH + 'name'), literal(element.label));
    propertyCount++;
  }

  if (hasValues) {
    // Emit a NodeShape targeting the code-list class so individual members are constrained.
    // Use the SAME literal encoding as consumer attribute shapes (sh:in over literals)
    // to avoid a dual encoding mismatch (named nodes vs string literals).
    const shapeIri = namedNode(element.iri + 'Shape');
    add(shapeIri, namedNode(RDF + 'type'), namedNode(SH + 'NodeShape'));
    add(shapeIri, namedNode(SH + 'targetClass'), elemIri);
    const valueLiterals = (element.values || []).map((value) => literal(String(value)));
    if (valueLiterals.length) {
      add(shapeIri, namedNode(SH + 'in'), writer.list(valueLiterals));
    }
    if (element.label) add(shapeIri, namedNode(SH + 'name'), literal(element.label));
    shapeCount++;
  }
}

// Identifier pattern shapes (M11): ISIN/LEI/MIC with a regex pattern get a PropertyShape
// whose path is the identifier attribute (e.g. hasPrimaryIdentifier) constrained by sh:pattern.
// Since identifiers are value-typed attributes, we emit a NodeShape targeting the identifier class
// with a sh:property on the identifier's own IRI so the pattern is enforceable on identifier literals.
for (const localName in domain) {
  const element = normalizeElement(domain[localName]);
  if (!element || !element.iri || !element.pattern || element.valueType !== undefined) continue;
  const shapeIri = namedNode(element.iri + 'PatternShape');
  add(shapeIri, namedNode(RDF + 'type'), namedNode(SH + 'NodeShape'));
  add(shapeIri, namedNode(SH + 'targetClass'), namedNode(element.iri));
  const propShapeIri = namedNode(element.iri + 'PatternShape_value');
  add(shapeIri, namedNode(SH + 'property'), propShapeIri);
  add(propShapeIri, namedNode(RDF + 'type'), namedNode(SH + 'PropertyShape'));
  add(propShapeIri, namedNode(SH + 'path'), namedNode(element.iri));
  add(propShapeIri, namedNode(SH + 'datatype'), namedNode(XSD + 'string'));
  add(propShapeIri, namedNode(SH + 'pattern'), literal(element.pattern));
  if (element.label) add(propShapeIri, namedNode(SH + 'name'), literal(element.label));
  shapeCount++;
  propertyCount++;
}

for (const q of quads) writer.addQuad(q.subject, q.predicate, q.object);
writer.end(function(error, result) {
  if (error) { console.error('write error', error); process.exit(1); }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, result);
  console.error('✓ M2 SHACL projected: ' + shapeCount + ' node shapes, ' + propertyCount + ' property constraints');
  console.error('  ' + quads.length + ' triples -> ' + path.basename(outputFile));
});
