'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { Parser } = require('n3');
const {
  buildFlattenedClosure,
  inspectOntologySource,
  requireRejected,
  validateOntologyImportDag,
  verifyExactFlattenedQuadSet,
} = require('../run-owl-dl-gate.cjs');

const META_IRI = 'https://axiolune.ai/ontology/meta';
const MODULE_IRI = 'https://axiolune.ai/ontology/finance/test-module';
const AGGREGATE_IRI = 'https://axiolune.ai/ontology/finance/0.3.0/reasoner-aggregate';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_ONTOLOGY = 'http://www.w3.org/2002/07/owl#Ontology';
const OWL_IMPORTS = 'http://www.w3.org/2002/07/owl#imports';

const metaSource = `
@prefix owl: <http://www.w3.org/2002/07/owl#>.
<${META_IRI}> a owl:Ontology;
  owl:versionIRI <${META_IRI}/0.6.0>.
<${META_IRI}/MetaClass> a owl:Class.
<${META_IRI}/property> a owl:ObjectProperty.
_:shared a owl:Restriction;
  owl:onProperty <${META_IRI}/property>;
  owl:someValuesFrom <${META_IRI}/MetaClass>.
`;

const moduleSource = `
@prefix owl: <http://www.w3.org/2002/07/owl#>.
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
<${MODULE_IRI}> a owl:Ontology;
  owl:imports <${META_IRI}>;
  owl:versionIRI <${MODULE_IRI}/0.3.0>.
<${MODULE_IRI}/DomainClass> a owl:Class;
  rdfs:subClassOf _:shared.
<${MODULE_IRI}/property> a owl:ObjectProperty.
_:shared a owl:Restriction;
  owl:onProperty <${MODULE_IRI}/property>;
  owl:someValuesFrom <${META_IRI}/MetaClass>.
`;

function digest(text) {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function specification(label, ontologyIri, versionIri, expectedImports, source) {
  return {
    label,
    path: `fixtures/${label}.ttl`,
    digest: digest(source),
    ontologyIri,
    versionIri,
    expectedImports,
  };
}

function analyses() {
  return [
    inspectOntologySource(metaSource, specification(
      'meta', META_IRI, `${META_IRI}/0.6.0`, [], metaSource,
    )),
    inspectOntologySource(moduleSource, specification(
      'module', MODULE_IRI, `${MODULE_IRI}/0.3.0`, [META_IRI], moduleSource,
    )),
  ];
}

test('flattened closure is deterministic, header-clean, import-free, and blank-node scoped', () => {
  const first = buildFlattenedClosure(analyses(), AGGREGATE_IRI);
  const second = buildFlattenedClosure(analyses(), AGGREGATE_IRI);
  assert.equal(first.serialized, second.serialized);
  assert.equal(digest(first.serialized), digest(second.serialized));
  assert.equal(first.sourceQuadCount, 16);
  assert.equal(first.removedHeaderQuadCount, 5);
  assert.equal(first.preDedupAxiomQuadCount, 11);
  assert.equal(first.outputQuadCount, 12);

  const quads = new Parser().parse(first.serialized);
  const headers = quads.filter((value) => (
    value.predicate.value === RDF_TYPE && value.object.value === OWL_ONTOLOGY
  ));
  assert.equal(headers.length, 1);
  assert.equal(headers[0].subject.value, AGGREGATE_IRI);
  assert.equal(quads.filter((value) => value.predicate.value === OWL_IMPORTS).length, 0);
  assert.equal(
    new Set(quads.flatMap((value) => [value.subject, value.object])
      .filter((term) => term.termType === 'BlankNode')
      .map((term) => term.value)).size,
    2,
    'same source blank-node label must remain scoped to two documents',
  );
});

test('flattened closure serializes entity declarations before dependent axioms', () => {
  const closure = buildFlattenedClosure(analyses(), AGGREGATE_IRI);
  const lines = closure.serialized.trim().split(/\r?\n/u);
  const classDeclaration = lines.findIndex((line) => (
    line.includes(`<${MODULE_IRI}/DomainClass>`)
      && line.includes('<http://www.w3.org/2002/07/owl#Class>')
  ));
  const propertyDeclaration = lines.findIndex((line) => (
    line.includes(`<${MODULE_IRI}/property>`)
      && line.includes('<http://www.w3.org/2002/07/owl#ObjectProperty>')
  ));
  const subclassAxiom = lines.findIndex((line) => (
    line.includes(`<${MODULE_IRI}/DomainClass>`)
      && line.includes('<http://www.w3.org/2000/01/rdf-schema#subClassOf>')
  ));
  const restrictionUse = lines.findIndex((line) => (
    line.includes('<http://www.w3.org/2002/07/owl#onProperty>')
      && line.includes(`<${MODULE_IRI}/property>`)
  ));
  const restrictionDeclaration = lines.findIndex((line) => (
    line.startsWith('_:owlflat_s1_')
      && line.includes('<http://www.w3.org/2002/07/owl#Restriction>')
  ));
  assert.ok(classDeclaration >= 0 && propertyDeclaration >= 0);
  assert.ok(classDeclaration < subclassAxiom);
  assert.ok(propertyDeclaration < restrictionUse);
  assert.ok(restrictionDeclaration >= 0 && restrictionDeclaration < restrictionUse);
});

test('source inspection rejects duplicate ontology headers', () => {
  const mutated = `${metaSource}\n<urn:axiolune:test:second> a <${OWL_ONTOLOGY}>.\n`;
  assert.throws(
    () => inspectOntologySource(mutated, specification(
      'meta', META_IRI, `${META_IRI}/0.6.0`, [], mutated,
    )),
    /exactly one owl:Ontology declaration/u,
  );
});

test('source inspection rejects a missing or substituted module import', () => {
  const missing = moduleSource.replace(`  owl:imports <${META_IRI}>;\n`, '');
  assert.throws(
    () => inspectOntologySource(missing, specification(
      'module', MODULE_IRI, `${MODULE_IRI}/0.3.0`, [META_IRI], missing,
    )),
    /imports does not equal the locked inventory/u,
  );
  const substituted = moduleSource.replace(META_IRI, 'urn:axiolune:test:substituted-meta');
  assert.throws(
    () => inspectOntologySource(substituted, specification(
      'module', MODULE_IRI, `${MODULE_IRI}/0.3.0`, [META_IRI], substituted,
    )),
    /imports does not equal the locked inventory/u,
  );
});

test('flattening rejects an import cycle even when every individual import inventory matches', () => {
  const cyclicMeta = metaSource.replace(
    `  owl:versionIRI <${META_IRI}/0.6.0>.`,
    `  owl:imports <${MODULE_IRI}>;\n  owl:versionIRI <${META_IRI}/0.6.0>.`,
  );
  const cyclicAnalyses = [
    inspectOntologySource(cyclicMeta, specification(
      'meta', META_IRI, `${META_IRI}/0.6.0`, [MODULE_IRI], cyclicMeta,
    )),
    inspectOntologySource(moduleSource, specification(
      'module', MODULE_IRI, `${MODULE_IRI}/0.3.0`, [META_IRI], moduleSource,
    )),
  ];
  assert.throws(() => validateOntologyImportDag(cyclicAnalyses), /OWL import cycle/u);
});

test('exact flattened-closure verifier rejects one dropped or added axiom', () => {
  const closure = buildFlattenedClosure(analyses(), AGGREGATE_IRI);
  const nonHeaderIndex = closure.quads.findIndex((value) => (
    value.subject.termType !== 'NamedNode' || value.subject.value !== AGGREGATE_IRI
  ));
  assert.ok(nonHeaderIndex >= 0);
  const dropped = closure.quads.filter((value, index) => index !== nonHeaderIndex);
  assert.throws(
    () => verifyExactFlattenedQuadSet(dropped, closure.quads),
    /dropped, added, or changed/u,
  );
  const added = [...closure.quads, closure.quads[nonHeaderIndex]];
  assert.throws(
    () => verifyExactFlattenedQuadSet(added, closure.quads),
    /dropped, added, or changed/u,
  );
});

test('negative semantic controls reject an engine failure instead of treating nonzero as proof', () => {
  assert.throws(
    () => requireRejected(
      { label: 'synthetic reasoner', status: 1, signal: null, stdout: '', stderr: 'Java heap failure' },
      [/The ontology is inconsistent\./u],
    ),
    /failed for the wrong reason/u,
  );
  assert.throws(
    () => requireRejected(
      { label: 'synthetic reasoner', status: null, signal: null, stdout: '', stderr: 'spawn failed' },
      [/The ontology is inconsistent\./u],
    ),
    /unexpectedly passed/u,
  );
});
