#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const yaml = require('js-yaml');
const { Parser, Store } = require('n3');
const SHACLValidator = require('rdf-validate-shacl').default;

const {
  EXPLICIT_XSD_DATATYPE_DECLARATIONS,
  META_ONTOLOGY,
  SKOS_DECLARATIONS,
  assertStrictOwlStructure,
  projectOwl,
} = require('../generate-m2-owl.cjs');
const {
  CUSTOM_CONSTRAINT_COMPONENT,
  SHACL_COMPONENT,
  inventoryContextKey,
  projectShacl,
  projectShaclWithInventory,
} = require('../generate-m2-shacl.cjs');
const {
  FACT_VERSION,
  MONEY,
  NS,
  PATTERNS,
  PROVENANCE_FIELDS,
  QUANTITY,
  TEMPORAL_FIELDS,
  rolePredicate,
  validateDocument,
} = require('../lib/typed-projection-common.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OWL_GENERATOR = path.join(ROOT, 'scripts', 'domain', 'generate-m2-owl.cjs');
const SHACL_GENERATOR = path.join(ROOT, 'scripts', 'domain', 'generate-m2-shacl.cjs');
const M2_VALIDATOR = path.join(ROOT, 'scripts', 'domain', 'validate-m2-core.js');
const BASE = 'https://example.test/ontology/typed/';
const iri = (name) => `${BASE}${name}`;

function patterns() {
  return [
    { pattern: PATTERNS.temporal },
    { pattern: PATTERNS.provenance },
  ];
}

function participant(id, range) {
  return {
    id,
    range,
    minCount: 1,
    maxCount: 1,
    label: id,
    definition: `participant role ${id}`,
  };
}

function baseElement(localName, extras = {}) {
  return {
    iri: iri(localName),
    namespace: 'typed',
    localName,
    label: localName,
    definition: `test definition for ${localName}`,
    ...extras,
  };
}

function typedDocument() {
  return {
    module: {
      moduleIri: 'https://example.test/ontology/typed',
      baseIri: BASE,
      preferredPrefix: 'typed',
      version: '0.3.0',
      label: 'Typed projection fixture',
      definition: 'strict typed-container projection fixture',
      imports: [],
      exports: [],
      status: 'draft',
      governance: {
        ownerRef: 'urn:axiolune:principal:test-owner',
        status: 'draft',
      },
    },
    domain: {
      objectTypes: {
        Thing: baseElement('Thing', {
          attributeUses: [
            { attribute: iri('hasStatus'), minCount: 1, maxCount: 1 },
            { attribute: iri('hasMoney'), minCount: 1, maxCount: 1 },
            { attribute: iri('hasQuantity'), minCount: 1, maxCount: 1 },
          ],
          patternBindings: patterns(),
        }),
      },
      associationTypes: {
        EarlierFact: baseElement('EarlierFact', {
          participantRoles: [
            participant('subject', iri('Thing')),
            participant('relatedFact', iri('LaterFact')),
          ],
          patternBindings: patterns(),
        }),
        LaterFact: baseElement('LaterFact', {
          participantRoles: [
            participant('subject', iri('Thing')),
            participant('priorFact', iri('EarlierFact')),
          ],
          patternBindings: patterns(),
        }),
      },
      relationTypes: {
        supersedingFact: baseElement('supersedingFact', {
          domain: iri('LaterFact'),
          range: iri('EarlierFact'),
        }),
      },
      attributeTypes: {
        hasMoney: baseElement('hasMoney', { valueType: MONEY.classIri }),
        hasQuantity: baseElement('hasQuantity', { valueType: QUANTITY.classIri }),
        hasStatus: baseElement('hasStatus', { valueType: iri('Status') }),
      },
      identifierTypes: {},
      codeLists: {
        Status: baseElement('Status', {
          vocabulary: 'Fixture status',
          version: '2026-07-31',
          maintainer: 'Axiolune test suite',
          sourceEvidenceRef: 'urn:axiolune:evidence:fixture-status',
          values: [
            {
              iri: `${iri('Status')}/value/Z`,
              notation: 'Z',
              label: 'Zed',
              definition: 'terminal fixture status',
            },
            {
              iri: `${iri('Status')}/value/A`,
              notation: 'A',
              label: 'Alpha',
              definition: 'deprecated fixture status',
              deprecated: true,
              replacedBy: `${iri('Status')}/value/Z`,
            },
          ],
        }),
      },
      constraints: {},
      relationUses: [
        {
          relation: iri('supersedingFact'),
          subjectType: iri('LaterFact'),
          objectType: iri('EarlierFact'),
          outboundCardinality: { minCount: 1, maxCount: 1 },
        },
      ],
      constraintBindings: [],
    },
  };
}

function parse(bytes) {
  return new Parser().parse(bytes.toString('utf8'));
}

function matches(quads, subject, predicate, object) {
  return quads.some((entry) => (
    (subject === undefined || entry.subject.value === subject)
    && (predicate === undefined || entry.predicate.value === predicate)
    && (object === undefined || entry.object.value === object)
  ));
}

function objects(quads, subject, predicate) {
  return quads
    .filter((entry) => entry.subject.value === subject && entry.predicate.value === predicate)
    .map((entry) => entry.object);
}

function restrictionsFor(quads, ownerClass, propertyIri) {
  const restrictionNodes = new Set(
    objects(quads, ownerClass, `${NS.RDFS}subClassOf`)
      .filter((term) => term.termType === 'BlankNode')
      .map((term) => term.value),
  );
  return [...restrictionNodes].filter((restriction) => (
    matches(quads, restriction, `${NS.OWL}onProperty`, propertyIri)
  ));
}

function readList(quads, head) {
  const values = [];
  let current = head;
  const seen = new Set();
  while (current.termType !== 'NamedNode' || current.value !== `${NS.RDF}nil`) {
    assert.equal(current.termType, 'BlankNode');
    assert.equal(seen.has(current.value), false, 'RDF list must be acyclic');
    seen.add(current.value);
    const first = objects(quads, current.value, `${NS.RDF}first`);
    const rest = objects(quads, current.value, `${NS.RDF}rest`);
    assert.equal(first.length, 1);
    assert.equal(rest.length, 1);
    values.push(first[0]);
    current = rest[0];
  }
  return values;
}

function coreOnlyShapeStore(quads) {
  // rdf-validate-shacl deliberately implements SHACL Core only.  Keep these
  // Tier-1 execution tests scoped to Core while the generated SPARQL
  // constraint is parsed/inspected above and executed by the pinned pySHACL
  // domain gate.
  const sparqlConstraintSubjects = new Set(
    quads
      .filter((entry) => entry.predicate.value === `${NS.SH}sparql`)
      .map((entry) => entry.object.value),
  );
  return new Store(quads.filter((entry) => (
    entry.predicate.value !== `${NS.SH}sparql`
    && !sparqlConstraintSubjects.has(entry.subject.value)
  )));
}

let cachedPyshaclExecutable;

function pyshaclExecutable() {
  if (cachedPyshaclExecutable) return cachedPyshaclExecutable;
  const candidates = [
    process.env.AXIOLUNE_PYTHON,
    path.join(
      process.env.LOCALAPPDATA || '',
      'Programs',
      'Python',
      'Python312',
      'python.exe',
    ),
    path.join(
      process.env.LOCALAPPDATA || '',
      'Programs',
      'Python',
      'Python313',
      'python.exe',
    ),
    'python3',
    'python',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    const probe = spawnSync(
      candidate,
      ['-c', 'import pyshacl; print(pyshacl.__version__)'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (probe.status === 0) {
      cachedPyshaclExecutable = candidate;
      return candidate;
    }
  }
  throw new Error('pinned pySHACL runtime is unavailable');
}

function runPyshacl(shapesBytes, dataTurtle) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-shacl-result-'));
  const shapesPath = path.join(temp, 'shapes.ttl');
  const dataPath = path.join(temp, 'data.ttl');
  try {
    fs.writeFileSync(shapesPath, shapesBytes);
    fs.writeFileSync(dataPath, dataTurtle, 'utf8');
    const result = spawnSync(
      pyshaclExecutable(),
      ['-m', 'pyshacl', '-f', 'nt', '-s', shapesPath, dataPath],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(
      result.status,
      1,
      `expected a pySHACL validation violation; stderr=${result.stderr}`,
    );
    return new Parser({ format: 'N-Triples' }).parse(result.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function reportComponentsForShape(reportQuads, sourceShape) {
  const results = new Set(
    reportQuads
      .filter((quad) => (
        quad.predicate.value === `${NS.SH}sourceShape`
        && quad.object.value === sourceShape
      ))
      .map((quad) => quad.subject.value),
  );
  return reportQuads
    .filter((quad) => (
      results.has(quad.subject.value)
      && quad.predicate.value === `${NS.SH}sourceConstraintComponent`
    ))
    .map((quad) => quad.object.value)
    .sort();
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('pure projections return deterministic bytes from strict typed containers', async () => {
  const document = typedDocument();
  const firstOwl = await projectOwl(document);
  const secondOwl = await projectOwl(document);
  const firstShacl = await projectShacl(document);
  const secondShacl = await projectShacl(document);

  assert.ok(Buffer.isBuffer(firstOwl));
  assert.ok(Buffer.isBuffer(firstShacl));
  assert.deepEqual(firstOwl, secondOwl);
  assert.deepEqual(firstShacl, secondShacl);
});

test('SHACL normalized-IR inventory is deterministic and preserves projection bytes', async () => {
  const document = typedDocument();
  const projected = await projectShaclWithInventory(document);
  const replayed = await projectShaclWithInventory(document);

  assert.deepEqual(projected.bytes, await projectShacl(document));
  assert.deepEqual(projected, replayed);
  const keys = projected.contexts.map(inventoryContextKey);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(projected.contexts.some((entry) => (
    entry.originRef === iri('hasStatus')
      && entry.targetRef === iri('Thing')
      && entry.path === iri('hasStatus')
      && entry.component === SHACL_COMPONENT.minCount
  )));
  assert.ok(projected.contexts.some((entry) => (
    entry.originRef === iri('hasStatus')
      && entry.targetRef === iri('Thing')
      && entry.path === iri('hasStatus')
      && entry.component === SHACL_COMPONENT.maxCount
  )));
  assert.ok(projected.contexts.some((entry) => (
    entry.originRef === iri('hasStatus')
      && entry.targetRef === iri('Thing')
      && entry.path === iri('hasStatus')
      && entry.component === SHACL_COMPONENT.class
  )));
});

test('SHACL omits tautological minCount zero but preserves positive minCount and maxCount zero', async () => {
  const document = typedDocument();
  document.domain.objectTypes.Thing.attributeUses = [
    { attribute: iri('hasStatus'), minCount: 0, maxCount: 0 },
    { attribute: iri('hasMoney'), minCount: 1, maxCount: 1 },
  ];
  const projected = await projectShaclWithInventory(document);
  const quads = parse(projected.bytes);
  const propertyShapes = objects(quads, iri('ThingShape'), `${NS.SH}property`);
  const shapeFor = (pathIri) => propertyShapes.find((shape) => (
    matches(quads, shape.value, `${NS.SH}path`, pathIri)
  ));
  const optionalShape = shapeFor(iri('hasStatus'));
  const requiredShape = shapeFor(iri('hasMoney'));
  assert.ok(optionalShape);
  assert.ok(requiredShape);

  assert.equal(objects(quads, optionalShape.value, `${NS.SH}minCount`).length, 0);
  assert.deepEqual(
    objects(quads, optionalShape.value, `${NS.SH}maxCount`).map((term) => term.value),
    ['0'],
  );
  assert.deepEqual(
    objects(quads, requiredShape.value, `${NS.SH}minCount`).map((term) => term.value),
    ['1'],
  );
  assert.equal(projected.contexts.some((entry) => (
    entry.targetRef === iri('Thing')
      && entry.path === iri('hasStatus')
      && entry.component === SHACL_COMPONENT.minCount
  )), false);
  assert.ok(projected.contexts.some((entry) => (
    entry.targetRef === iri('Thing')
      && entry.path === iri('hasStatus')
      && entry.component === SHACL_COMPONENT.maxCount
  )));
  assert.ok(projected.contexts.some((entry) => (
    entry.targetRef === iri('Thing')
      && entry.path === iri('hasMoney')
      && entry.component === SHACL_COMPONENT.minCount
  )));

  const invalid = typedDocument();
  invalid.domain.objectTypes.Thing.attributeUses[0].minCount = -1;
  await assert.rejects(projectShacl(invalid), /must be a non-negative integer/u);
});

test('OWL projection imports M3 and declares SKOS and exact external alignment entity kinds', async () => {
  const document = typedDocument();
  const classTarget = 'https://external.example/ontology/ClassTarget';
  const relationTarget = 'https://external.example/ontology/objectPropertyTarget';
  const objectAttributeTarget = 'https://external.example/ontology/objectAttributeTarget';
  const datatypeAttributeTarget = 'https://external.example/ontology/datatypeAttributeTarget';
  const annotationAttributeTarget = 'https://external.example/ontology/annotationAttributeTarget';
  const alignment = (targetIri, relation) => ({
    vocabulary: 'Strict DL fixture',
    targetIri,
    relation,
  });
  document.domain.objectTypes.Thing.alignments = [
    alignment(classTarget, 'rdfs:subClassOf'),
  ];
  document.domain.relationTypes.supersedingFact.alignments = [
    alignment(relationTarget, 'rdfs:subPropertyOf'),
  ];
  document.domain.attributeTypes.hasMoney.alignments = [
    alignment(objectAttributeTarget, 'rdfs:subPropertyOf'),
  ];
  document.domain.attributeTypes.hasText = baseElement('hasText', {
    valueType: 'string',
    alignments: [alignment(datatypeAttributeTarget, 'rdfs:subPropertyOf')],
  });
  document.domain.attributeTypes.hasAnnotation = baseElement('hasAnnotation', {
    valueType: 'string',
    owlProjectionOverride: 'annotationProperty',
    alignments: [alignment(annotationAttributeTarget, 'rdfs:subPropertyOf')],
  });

  const owl = parse(await projectOwl(document));
  assert.ok(matches(
    owl,
    document.module.moduleIri,
    `${NS.OWL}imports`,
    META_ONTOLOGY,
  ));
  for (const [entityIri, declaration] of SKOS_DECLARATIONS) {
    assert.ok(matches(owl, entityIri, `${NS.RDF}type`, declaration));
  }
  for (const [targetIri, declaration] of [
    [classTarget, `${NS.OWL}Class`],
    [relationTarget, `${NS.OWL}ObjectProperty`],
    [objectAttributeTarget, `${NS.OWL}ObjectProperty`],
    [datatypeAttributeTarget, `${NS.OWL}DatatypeProperty`],
    [annotationAttributeTarget, `${NS.OWL}AnnotationProperty`],
  ]) {
    assert.ok(matches(owl, targetIri, `${NS.RDF}type`, declaration));
  }
  assert.equal(
    objects(owl, document.module.moduleIri, `${NS.OWL}imports`)
      .some((term) => term.value.startsWith('https://external.example/')),
    false,
    'alignment targets are declared as stubs, never imported as whole ontologies',
  );

  const model = validateDocument(document);
  assert.doesNotThrow(() => assertStrictOwlStructure(owl, model));
  const withoutClassTargetDeclaration = owl.filter((entry) => !(
    entry.subject.value === classTarget
    && entry.predicate.value === `${NS.RDF}type`
    && entry.object.value === `${NS.OWL}Class`
  ));
  assert.throws(
    () => assertStrictOwlStructure(withoutClassTargetDeclaration, model),
    /missing alignment-target OWL declaration/,
  );
  const withoutMetaImport = owl.filter((entry) => !(
    entry.subject.value === document.module.moduleIri
    && entry.predicate.value === `${NS.OWL}imports`
    && entry.object.value === META_ONTOLOGY
  ));
  assert.throws(
    () => assertStrictOwlStructure(withoutMetaImport, model),
    /strict OWL projection must import/,
  );
});

test('annotation properties cannot use the OWL object/data equivalentProperty predicate', async () => {
  const document = typedDocument();
  document.domain.attributeTypes.hasAnnotation = baseElement('hasAnnotation', {
    valueType: 'string',
    owlProjectionOverride: 'annotationProperty',
    alignments: [{
      vocabulary: 'Strict DL fixture',
      targetIri: 'https://external.example/ontology/annotationTarget',
      relation: 'owl:equivalentProperty',
    }],
  });
  await assert.rejects(
    projectOwl(document),
    /equivalentProperty cannot align an OWL annotation property/,
  );
});

test('imported AttributeUses remain modular without filesystem discovery', async () => {
  const document = typedDocument();
  const importedAttribute = 'https://example.test/ontology/imported/hasExternalValue';
  document.domain.objectTypes.Thing.attributeUses.push({
    attribute: importedAttribute,
    minCount: 1,
    maxCount: 1,
  });
  const owl = parse(await projectOwl(document));
  const shacl = parse(await projectShacl(document));
  const importedRestrictions = restrictionsFor(owl, iri('Thing'), importedAttribute);
  assert.equal(importedRestrictions.length, 1);
  assert.ok(matches(
    owl,
    importedRestrictions[0],
    `${NS.OWL}cardinality`,
    '1',
  ));
  assert.equal(matches(
    owl,
    importedRestrictions[0],
    `${NS.OWL}onClass`,
    undefined,
  ), false);
  const importedPathShape = shacl.find((entry) => (
    entry.predicate.value === `${NS.SH}path`
    && entry.object.value === importedAttribute
    && entry.subject.value.startsWith(iri('Thing'))
  )).subject.value;

  assert.ok(matches(shacl, importedPathShape, `${NS.SH}minCount`, '1'));
  assert.ok(matches(shacl, importedPathShape, `${NS.SH}maxCount`, '1'));
  assert.equal(matches(shacl, importedPathShape, `${NS.SH}datatype`, undefined), false);
  assert.equal(matches(shacl, importedPathShape, `${NS.SH}class`, undefined), false);
});

test('OWL projects authored AttributeUses on object and association types with typed cardinalities', async () => {
  const document = typedDocument();
  document.domain.attributeTypes.hasText = baseElement('hasText', {
    valueType: 'string',
    defaultCardinality: { minCount: 0, maxCount: 1 },
  });
  document.domain.objectTypes.Thing.attributeUses.push({ attribute: iri('hasText') });
  document.domain.associationTypes.EarlierFact.attributeUses = [{
    attribute: iri('hasText'),
    minCount: 1,
    maxCount: 1,
  }];

  const owl = parse(await projectOwl(document));
  for (const [propertyIri, rangeIri] of [
    [iri('hasStatus'), iri('Status')],
    [iri('hasMoney'), MONEY.classIri],
    [iri('hasQuantity'), QUANTITY.classIri],
  ]) {
    const restrictions = restrictionsFor(owl, iri('Thing'), propertyIri);
    assert.equal(restrictions.length, 1);
    assert.ok(matches(owl, restrictions[0], `${NS.OWL}onClass`, rangeIri));
    assert.ok(matches(owl, restrictions[0], `${NS.OWL}qualifiedCardinality`, '1'));
  }

  const textRestrictions = restrictionsFor(owl, iri('Thing'), iri('hasText'));
  assert.equal(textRestrictions.length, 2);
  assert.ok(textRestrictions.some((restriction) => (
    matches(owl, restriction, `${NS.OWL}minCardinality`, '0')
  )));
  assert.ok(textRestrictions.some((restriction) => (
    matches(owl, restriction, `${NS.OWL}maxCardinality`, '1')
  )));
  assert.equal(textRestrictions.some((restriction) => (
    matches(owl, restriction, `${NS.OWL}onClass`, undefined)
  )), false);

  const associationRestrictions = restrictionsFor(
    owl,
    iri('EarlierFact'),
    iri('hasText'),
  );
  assert.equal(associationRestrictions.length, 1);
  assert.ok(matches(
    owl,
    associationRestrictions[0],
    `${NS.OWL}cardinality`,
    '1',
  ));
});

test('OWL fails closed when an authored AttributeUse targets an annotation property', async () => {
  const document = typedDocument();
  document.domain.attributeTypes.hasAnnotation = baseElement('hasAnnotation', {
    valueType: 'string',
    owlProjectionOverride: 'annotationProperty',
  });
  document.domain.objectTypes.Thing.attributeUses.push({
    attribute: iri('hasAnnotation'),
    minCount: 0,
    maxCount: 1,
  });
  await assert.rejects(
    projectOwl(document),
    /authored AttributeUse .* cannot target an OWL annotation property/,
  );
});

test('OWL bytes and restrictions drift when an authored AttributeUse is removed', async () => {
  const baseline = typedDocument();
  const drifted = typedDocument();
  drifted.domain.objectTypes.Thing.attributeUses = drifted.domain.objectTypes.Thing.attributeUses
    .filter((use) => use.attribute !== iri('hasStatus'));

  const baselineBytes = await projectOwl(baseline);
  const driftedBytes = await projectOwl(drifted);
  assert.notEqual(sha256(baselineBytes), sha256(driftedBytes));
  assert.equal(
    restrictionsFor(parse(baselineBytes), iri('Thing'), iri('hasStatus')).length,
    1,
  );
  assert.equal(
    restrictionsFor(parse(driftedBytes), iri('Thing'), iri('hasStatus')).length,
    0,
  );
});

test('code values are named individuals and code-list attributes are IRI object properties', async () => {
  const document = typedDocument();
  const owl = parse(await projectOwl(document));
  const shacl = parse(await projectShacl(document));
  const status = iri('Status');
  const memberA = `${status}/value/A`;
  const memberZ = `${status}/value/Z`;

  for (const member of [memberA, memberZ]) {
    assert.ok(matches(owl, member, `${NS.RDF}type`, `${NS.OWL}NamedIndividual`));
    assert.ok(matches(owl, member, `${NS.RDF}type`, status));
    assert.ok(matches(owl, member, `${NS.RDF}type`, `${NS.SKOS}Concept`));
    assert.ok(matches(owl, member, `${NS.SKOS}inScheme`, `${status}/scheme`));
  }
  assert.ok(matches(owl, memberA, `${NS.OWL}deprecated`, 'true'));
  assert.ok(matches(owl, memberA, `${NS.DCTERMS}isReplacedBy`, memberZ));
  const enumerationHead = objects(owl, status, `${NS.OWL}oneOf`);
  assert.equal(enumerationHead.length, 1);
  assert.deepEqual(readList(owl, enumerationHead[0]).map((term) => term.value), [memberA, memberZ]);

  assert.ok(matches(owl, iri('hasStatus'), `${NS.RDF}type`, `${NS.OWL}ObjectProperty`));
  assert.ok(matches(owl, iri('hasStatus'), `${NS.RDFS}range`, status));
  const statusPathShape = shacl.find((entry) => (
    entry.predicate.value === `${NS.SH}path` && entry.object.value === iri('hasStatus')
  )).subject.value;
  assert.ok(matches(shacl, statusPathShape, `${NS.SH}nodeKind`, `${NS.SH}IRI`));
  const allowedHead = objects(shacl, statusPathShape, `${NS.SH}in`);
  assert.equal(allowedHead.length, 1);
  assert.deepEqual(readList(shacl, allowedHead[0]).map((term) => term.value), [memberA, memberZ]);
});

test('Money and Quantity use only the canonical M3 classes, properties, and Tier-1 shapes', async () => {
  const document = typedDocument();
  const owl = parse(await projectOwl(document));
  const shacl = parse(await projectShacl(document));

  assert.ok(matches(owl, iri('hasMoney'), `${NS.RDF}type`, `${NS.OWL}ObjectProperty`));
  assert.ok(matches(owl, iri('hasMoney'), `${NS.RDFS}range`, MONEY.classIri));
  assert.ok(matches(owl, iri('hasQuantity'), `${NS.RDF}type`, `${NS.OWL}ObjectProperty`));
  assert.ok(matches(owl, iri('hasQuantity'), `${NS.RDFS}range`, QUANTITY.classIri));
  assert.equal(matches(owl, iri('MonetaryAmount'), undefined, undefined), false);
  assert.equal(matches(owl, iri('QuantityValue'), undefined, undefined), false);

  for (const component of [MONEY.amount, MONEY.currency, MONEY.scale]) {
    assert.ok(matches(shacl, undefined, `${NS.SH}path`, component));
  }
  for (const component of [QUANTITY.value, QUANTITY.unit, QUANTITY.precision, QUANTITY.rounding]) {
    assert.ok(matches(shacl, undefined, `${NS.SH}path`, component));
  }
  const roundingShape = shacl.find((entry) => (
    entry.predicate.value === `${NS.SH}path` && entry.object.value === QUANTITY.rounding
  )).subject.value;
  const roundingHead = objects(shacl, roundingShape, `${NS.SH}in`);
  assert.equal(roundingHead.length, 1);
  assert.deepEqual(
    readList(shacl, roundingHead[0]).map((term) => term.value),
    ['floor', 'ceiling', 'half-up', 'half-even'],
  );
});

test('association roles use derived predicates and allow fact-to-fact endpoints', async () => {
  const document = typedDocument();
  const owl = parse(await projectOwl(document));
  const shacl = parse(await projectShacl(document));
  const predicate = rolePredicate(iri('LaterFact'), 'priorFact');

  assert.equal(predicate, `${iri('LaterFact')}/role/priorFact`);
  assert.ok(matches(owl, predicate, `${NS.RDF}type`, `${NS.OWL}ObjectProperty`));
  assert.ok(matches(owl, predicate, `${NS.RDFS}domain`, iri('LaterFact')));
  assert.ok(matches(owl, predicate, `${NS.RDFS}range`, iri('EarlierFact')));
  assert.ok(matches(owl, undefined, `${NS.OWL}onProperty`, predicate));
  assert.equal(matches(owl, `${iri('LaterFact')}_priorFact`, undefined, undefined), false);

  const roleShape = shacl.find((entry) => (
    entry.predicate.value === `${NS.SH}path` && entry.object.value === predicate
  )).subject.value;
  assert.ok(matches(shacl, roleShape, `${NS.SH}class`, iri('EarlierFact')));
  assert.ok(matches(shacl, roleShape, `${NS.SH}nodeKind`, `${NS.SH}IRI`));

  assert.ok(matches(owl, iri('supersedingFact'), `${NS.RDFS}domain`, iri('LaterFact')));
  assert.ok(matches(owl, iri('supersedingFact'), `${NS.RDFS}range`, iri('EarlierFact')));
  assert.ok(matches(shacl, undefined, `${NS.SH}class`, iri('EarlierFact')));
});

test('OWL qualified restrictions are strict classes and split unequal min/max cardinalities', async () => {
  const document = typedDocument();
  const priorRole = document.domain.associationTypes.LaterFact.participantRoles
    .find((role) => role.id === 'priorFact');
  priorRole.minCount = 0;
  priorRole.maxCount = 1;
  const owl = parse(await projectOwl(document));
  const predicate = rolePredicate(iri('LaterFact'), 'priorFact');
  const restrictionSubjects = owl
    .filter((entry) => (
      entry.predicate.value === `${NS.OWL}onProperty`
      && entry.object.value === predicate
    ))
    .map((entry) => entry.subject.value);

  assert.equal(restrictionSubjects.length, 2);
  const seen = [];
  for (const subject of restrictionSubjects) {
    assert.ok(matches(owl, subject, `${NS.RDF}type`, `${NS.OWL}Class`));
    assert.ok(matches(owl, subject, `${NS.RDF}type`, `${NS.OWL}Restriction`));
    assert.ok(matches(owl, subject, `${NS.OWL}onClass`, iri('EarlierFact')));
    const cardinalities = owl.filter((entry) => (
      entry.subject.value === subject
      && [
        `${NS.OWL}qualifiedCardinality`,
        `${NS.OWL}minQualifiedCardinality`,
        `${NS.OWL}maxQualifiedCardinality`,
      ].includes(entry.predicate.value)
    ));
    assert.equal(cardinalities.length, 1);
    seen.push([cardinalities[0].predicate.value, cardinalities[0].object.value]);
  }
  assert.deepEqual(
    seen.sort(),
    [
      [`${NS.OWL}maxQualifiedCardinality`, '1'],
      [`${NS.OWL}minQualifiedCardinality`, '0'],
    ].sort(),
  );
});

test('OWL projection explicitly declares RDF date and duration datatypes required by strict DL parsers', async () => {
  const owl = parse(await projectOwl(typedDocument()));
  for (const datatypeIri of EXPLICIT_XSD_DATATYPE_DECLARATIONS) {
    assert.ok(matches(owl, datatypeIri, `${NS.RDF}type`, `${NS.RDFS}Datatype`));
  }
});

test('TemporalFact and ProvenancedFact emit immutable three-axis Tier-1 constraints', async () => {
  const document = typedDocument();
  const owl = parse(await projectOwl(document));
  const shacl = parse(await projectShacl(document));
  const target = iri('LaterFact');

  assert.ok(matches(owl, target, `${NS.RDFS}subClassOf`, PATTERNS.temporal));
  assert.ok(matches(owl, target, `${NS.RDFS}subClassOf`, PATTERNS.provenance));
  assert.ok(matches(owl, target, `${NS.RDFS}subClassOf`, FACT_VERSION));

  for (const field of ['validFrom', 'knowledgeFrom', 'availableFrom']) {
    const propertyShape = shacl.find((entry) => (
      entry.predicate.value === `${NS.SH}path`
      && entry.object.value === TEMPORAL_FIELDS[field]
      && entry.subject.value.startsWith(target)
    )).subject.value;
    assert.ok(matches(shacl, propertyShape, `${NS.SH}minCount`, '1'));
    assert.ok(matches(shacl, propertyShape, `${NS.SH}maxCount`, '1'));
    assert.ok(matches(shacl, propertyShape, `${NS.SH}datatype`, `${NS.XSD}dateTimeStamp`));
  }
  for (const field of ['knowledgeTo', 'availableTo']) {
    const propertyShape = shacl.find((entry) => (
      entry.predicate.value === `${NS.SH}path`
      && entry.object.value === TEMPORAL_FIELDS[field]
      && entry.subject.value.startsWith(target)
    )).subject.value;
    assert.ok(matches(shacl, propertyShape, `${NS.SH}maxCount`, '0'));
  }
  const sourceShape = shacl.find((entry) => (
    entry.predicate.value === `${NS.SH}path`
    && entry.object.value === PROVENANCE_FIELDS.source
    && entry.subject.value.startsWith(target)
  )).subject.value;
  const revisionShape = shacl.find((entry) => (
    entry.predicate.value === `${NS.SH}path`
    && entry.object.value === PROVENANCE_FIELDS.revision
    && entry.subject.value.startsWith(target)
  )).subject.value;
  assert.ok(matches(shacl, sourceShape, `${NS.SH}minCount`, '1'));
  assert.ok(matches(shacl, sourceShape, `${NS.SH}datatype`, `${NS.XSD}anyURI`));
  assert.ok(matches(shacl, revisionShape, `${NS.SH}minCount`, '1'));
  assert.ok(matches(shacl, revisionShape, `${NS.SH}maxCount`, '1'));
  assert.ok(matches(
    shacl,
    revisionShape,
    `${NS.SH}datatype`,
    `${NS.XSD}nonNegativeInteger`,
  ));

  const revisionRestrictions = objects(owl, target, `${NS.RDFS}subClassOf`)
    .filter((term) => term.termType === 'BlankNode')
    .filter((term) => matches(
      owl,
      term.value,
      `${NS.OWL}onProperty`,
      PROVENANCE_FIELDS.revision,
    ));
  assert.equal(revisionRestrictions.length, 1);
  assert.ok(matches(
    owl,
    revisionRestrictions[0].value,
    `${NS.OWL}cardinality`,
    '1',
  ));
  assert.equal(matches(
    owl,
    revisionRestrictions[0].value,
    `${NS.OWL}qualifiedCardinality`,
    undefined,
  ), false);

  const sparqlConstraints = objects(shacl, `${target}Shape`, `${NS.SH}sparql`);
  assert.equal(sparqlConstraints.length, 1);
  const intervalConstraint = sparqlConstraints[0].value;
  assert.ok(matches(
    shacl,
    intervalConstraint,
    `${NS.RDF}type`,
    `${NS.SH}SPARQLConstraint`,
  ));
  const intervalSelect = objects(shacl, intervalConstraint, `${NS.SH}select`);
  assert.equal(intervalSelect.length, 1);
  assert.match(intervalSelect[0].value, /SELECT \$this \?path/u);
  assert.match(intervalSelect[0].value, new RegExp(`<${TEMPORAL_FIELDS.validFrom}>`, 'u'));
  assert.match(intervalSelect[0].value, new RegExp(`<${TEMPORAL_FIELDS.validTo}>`, 'u'));
  assert.match(
    intervalSelect[0].value,
    /FILTER \(STRDT\(STR\(\?validFrom\), <http:\/\/www\.w3\.org\/2001\/XMLSchema#dateTime>\) >= STRDT\(STR\(\?validTo\), <http:\/\/www\.w3\.org\/2001\/XMLSchema#dateTime>\)\)/u,
  );
});

test('generated Tier-1 SHACL accepts a complete graph and rejects missing/legacy encodings', async () => {
  const shapeStore = coreOnlyShapeStore(parse(await projectShacl(typedDocument())));
  const validator = new SHACLValidator(shapeStore);
  const common = `
    @prefix rdf: <${NS.RDF}> .
    @prefix xsd: <${NS.XSD}> .
    <urn:thing> rdf:type <${iri('Thing')}> ;
      <${iri('hasMoney')}> _:money ;
      <${iri('hasQuantity')}> _:quantity ;
      <${TEMPORAL_FIELDS.validFrom}> "2026-07-31T00:00:00Z"^^xsd:dateTimeStamp ;
      <${TEMPORAL_FIELDS.knowledgeFrom}> "2026-07-31T00:00:01Z"^^xsd:dateTimeStamp ;
      <${PROVENANCE_FIELDS.revision}> "0"^^xsd:nonNegativeInteger .
    _:money rdf:type <${MONEY.classIri}> ;
      <${MONEY.amount}> "12.34"^^xsd:decimal ;
      <${MONEY.currency}> "USD"^^xsd:string ;
      <${MONEY.scale}> "2"^^xsd:integer .
    _:quantity rdf:type <${QUANTITY.classIri}> ;
      <${QUANTITY.value}> "10"^^xsd:decimal ;
      <${QUANTITY.unit}> "https://example.test/unit/share"^^xsd:string ;
      <${QUANTITY.rounding}> "half-even"^^xsd:string .
    <${iri('Status')}/value/Z> rdf:type <${iri('Status')}> .
  `;
  const goodData = new Store(new Parser().parse(`
    ${common}
    <urn:thing>
      <${iri('hasStatus')}> <${iri('Status')}/value/Z> ;
      <${TEMPORAL_FIELDS.availableFrom}> "2026-07-31T00:00:02Z"^^xsd:dateTimeStamp ;
      <${PROVENANCE_FIELDS.source}> "urn:source:fixture"^^xsd:anyURI .
  `));
  const badData = new Store(new Parser().parse(`
    ${common}
    <urn:thing> <${iri('hasStatus')}> "Z" .
  `));

  const goodReport = await validator.validate(goodData);
  const badReport = await validator.validate(badData);
  assert.equal(
    goodReport.conforms,
    true,
    goodReport.results.map((result) => (
      [
        result.sourceConstraintComponent?.value,
        `focus=${result.focusNode?.value}`,
        `path=${result.path?.value}`,
        `value=${result.value?.value}`,
      ].join(' ')
    )).join('\n'),
  );
  assert.equal(badReport.conforms, false);
});

test('simple authored sh:xone is projected and executed as an exclusive branch constraint', async () => {
  const document = typedDocument();
  document.domain.objectTypes.Thing.attributeUses = [
    { attribute: iri('hasMoney'), minCount: 0, maxCount: 1 },
    { attribute: iri('hasQuantity'), minCount: 0, maxCount: 1 },
  ];
  document.domain.constraints.ThingValueXone = baseElement('ThingValueXone', {
    constraintType: 'Logical',
    scope: 'Object',
    expression: {
      language: 'SHACL',
      expression: 'sh:xone(hasMoney,hasQuantity)',
    },
    severity: 'Error',
    message: 'Thing must carry exactly one value representation',
    targetElement: iri('Thing'),
  });
  document.domain.constraintBindings.push({
    constraintRef: iri('ThingValueXone'),
    targetElement: iri('Thing'),
    enforcementLevel: 'Mandatory',
  });

  const projected = await projectShaclWithInventory(document);
  const authored = projected.contexts.filter((entry) => (
    entry.originKind === 'constraintDefinition'
      && entry.originRef === iri('ThingValueXone')
  ));
  assert.deepEqual(authored, [{
    originKind: 'constraintDefinition',
    originRef: iri('ThingValueXone'),
    targetRef: iri('Thing'),
    component: SHACL_COMPONENT.xone,
    severity: 'violation',
    generatedOrAuthored: 'authored',
  }]);
  assert.equal(
    projected.contexts.some((entry) => entry.originRef === iri('ThingValueXone')
      && entry.generatedOrAuthored === 'generated'),
    false,
    'nested xone branch operands are not independently executable manifest instances',
  );

  const shapeStore = coreOnlyShapeStore(parse(projected.bytes));
  const quads = shapeStore.getQuads(null, null, null, null);
  const xoneHead = objects(quads, `${iri('ThingValueXone')}/shape`, `${NS.SH}xone`);
  assert.equal(xoneHead.length, 1);
  const branches = readList(quads, xoneHead[0]);
  assert.equal(branches.length, 2);
  assert.ok(matches(
    quads,
    `${iri('ThingValueXone')}/shape`,
    `${NS.SH}targetClass`,
    iri('Thing'),
  ));
  assert.equal(matches(
    quads,
    iri('ThingShape'),
    `${NS.SH}node`,
    `${iri('ThingValueXone')}/shape`,
  ), false);

  const validator = new SHACLValidator(shapeStore);
  const graph = (properties) => new Store(new Parser().parse(`
    @prefix rdf: <${NS.RDF}> .
    @prefix xsd: <${NS.XSD}> .
    <urn:thing> rdf:type <${iri('Thing')}> ;
      <${TEMPORAL_FIELDS.validFrom}> "2026-07-31T00:00:00Z"^^xsd:dateTimeStamp ;
      <${TEMPORAL_FIELDS.knowledgeFrom}> "2026-07-31T00:00:01Z"^^xsd:dateTimeStamp ;
      <${TEMPORAL_FIELDS.availableFrom}> "2026-07-31T00:00:02Z"^^xsd:dateTimeStamp ;
      <${PROVENANCE_FIELDS.source}> "urn:source:xone"^^xsd:anyURI ;
      <${PROVENANCE_FIELDS.revision}> "0"^^xsd:nonNegativeInteger
      ${properties} .
    _:money rdf:type <${MONEY.classIri}> ;
      <${MONEY.amount}> "1.00"^^xsd:decimal ;
      <${MONEY.currency}> "USD"^^xsd:string ;
      <${MONEY.scale}> "2"^^xsd:integer .
    _:quantity rdf:type <${QUANTITY.classIri}> ;
      <${QUANTITY.value}> "1"^^xsd:decimal ;
      <${QUANTITY.unit}> "https://example.test/unit/ratio"^^xsd:string ;
      <${QUANTITY.rounding}> "half-even"^^xsd:string .
  `));
  assert.equal((await validator.validate(graph(`; <${iri('hasMoney')}> _:money`))).conforms, true);
  for (const invalid of [
    graph(''),
    graph(`; <${iri('hasMoney')}> _:money ; <${iri('hasQuantity')}> _:quantity`),
  ]) {
    const report = await validator.validate(invalid);
    assert.equal(report.conforms, false);
    assert.deepEqual(
      [...new Set(report.results
        .filter((result) => result.sourceShape?.value === `${iri('ThingValueXone')}/shape`)
        .map((result) => result.sourceConstraintComponent?.value))],
      [SHACL_COMPONENT.xone],
    );
  }

  const pyshaclReport = runPyshacl(projected.bytes, `
    @prefix rdf: <${NS.RDF}> .
    <urn:thing> rdf:type <${iri('Thing')}> ;
      <${iri('partyA')}> <urn:party:a> .
  `);
  assert.deepEqual(
    reportComponentsForShape(pyshaclReport, `${iri('ThingValueXone')}/shape`),
    [SHACL_COMPONENT.xone],
  );
});

test('unsupported or ambiguous SHACL prose fails projection instead of being silently ignored', async () => {
  const document = typedDocument();
  document.domain.constraints.Uncompiled = baseElement('Uncompiled', {
    constraintType: 'Logical',
    scope: 'Object',
    expression: {
      language: 'SHACL',
      expression: 'sh:xone(hasMoney,hasQuantity); values must also be compatible',
    },
    severity: 'Error',
    message: 'uncompiled test expression',
    targetElement: iri('Thing'),
  });
  document.domain.constraintBindings.push({
    constraintRef: iri('Uncompiled'),
    targetElement: iri('Thing'),
    enforcementLevel: 'Mandatory',
  });

  await assert.rejects(
    projectShacl(document),
    /unsupported SHACL expression; expected exactly sh:xone/,
  );
});

test('Custom constraint projection validation fails closed on a missing or substituted binding', async () => {
  const document = typedDocument();
  document.domain.constraints.CustomRule = baseElement('CustomRule', {
    constraintType: 'Custom',
    scope: 'Object',
    expression: { language: 'Custom', expression: 'profile=fixture' },
    severity: 'Error',
    message: 'fixture Custom rule',
    targetElement: iri('Thing'),
  });

  await assert.rejects(
    projectOwl(document),
    /targeted Custom constraint requires exactly one matching top-level ConstraintBinding/u,
  );
  await assert.rejects(
    projectShacl(document),
    /targeted Custom constraint requires exactly one matching top-level ConstraintBinding/u,
  );

  document.domain.constraintBindings.push({
    constraintRef: iri('CustomRule'),
    targetElement: iri('LaterFact'),
    enforcementLevel: 'Mandatory',
  });
  await assert.rejects(
    projectOwl(document),
    /targeted Custom constraint requires exactly one matching top-level ConstraintBinding/u,
  );

  document.domain.constraintBindings[0].targetElement = iri('Thing');
  await assert.doesNotReject(projectOwl(document));
  const projected = await projectShaclWithInventory(document);
  assert.ok(projected.contexts.some((entry) => (
    entry.originKind === 'constraintDefinition'
      && entry.originRef === iri('CustomRule')
      && entry.targetRef === iri('Thing')
      && entry.component === CUSTOM_CONSTRAINT_COMPONENT
      && entry.severity === 'violation'
      && entry.generatedOrAuthored === 'authored'
  )));
});

test('parameter-free direct SPARQL SELECT is projected as an executable SHACL node constraint', async () => {
  const document = typedDocument();
  document.domain.relationTypes.partyA = baseElement('partyA', {
    domain: iri('Thing'),
    range: iri('Thing'),
    characteristics: ['functional'],
  });
  document.domain.relationTypes.partyB = baseElement('partyB', {
    domain: iri('Thing'),
    range: iri('Thing'),
    characteristics: ['functional'],
  });
  for (const relation of ['partyA', 'partyB']) {
    document.domain.relationUses.push({
      relation: iri(relation),
      subjectType: iri('Thing'),
      objectType: iri('Thing'),
      outboundCardinality: { minCount: 0, maxCount: 1 },
      constraints: [],
    });
  }
  const select = [
    'SELECT $this ?path',
    'WHERE {',
    `  OPTIONAL { $this <${iri('partyA')}> ?partyA . }`,
    `  OPTIONAL { $this <${iri('partyB')}> ?partyB . }`,
    `  BIND(<${iri('partyA')}> AS ?path)`,
    '  FILTER ((BOUND(?partyA) && !BOUND(?partyB))',
    '    || (!BOUND(?partyA) && BOUND(?partyB))',
    '    || (BOUND(?partyA) && BOUND(?partyB) && STR(?partyA) >= STR(?partyB)))',
    '}',
  ].join('\n');
  document.domain.constraints.PartyPair = baseElement('PartyPair', {
    constraintType: 'Logical',
    scope: 'Object',
    expression: { language: 'SPARQL', expression: select },
    severity: 'Error',
    message: 'pair must be absent together or canonically ordered',
    targetElement: iri('Thing'),
  });
  document.domain.constraintBindings.push({
    constraintRef: iri('PartyPair'),
    targetElement: iri('Thing'),
    enforcementLevel: 'Mandatory',
  });

  const projected = await projectShaclWithInventory(document);
  const quads = new Parser().parse(projected.bytes.toString('utf8'));
  const constraintShape = `${iri('PartyPair')}/shape`;
  const sparqlConstraint = `${constraintShape}/sparql`;
  assert.equal(matches(quads, iri('ThingShape'), `${NS.SH}node`, constraintShape), false);
  assert.ok(matches(quads, constraintShape, `${NS.SH}targetClass`, iri('Thing')));
  assert.ok(matches(quads, constraintShape, `${NS.SH}sparql`, sparqlConstraint));
  assert.deepEqual(objects(quads, sparqlConstraint, `${NS.SH}select`).map((term) => term.value), [select]);
  assert.deepEqual(projected.contexts.filter((entry) => (
    entry.originKind === 'constraintDefinition'
      && entry.originRef === iri('PartyPair')
      && entry.targetRef === iri('Thing')
  )), [{
    originKind: 'constraintDefinition',
    originRef: iri('PartyPair'),
    targetRef: iri('Thing'),
    pathKind: 'iri',
    path: iri('partyA'),
    component: SHACL_COMPONENT.sparql,
    severity: 'violation',
    generatedOrAuthored: 'authored',
  }]);

  const pyshaclReport = runPyshacl(projected.bytes, `
    @prefix rdf: <${NS.RDF}> .
    <urn:thing> rdf:type <${iri('Thing')}> ;
      <${iri('partyA')}> <urn:party:a> .
  `);
  assert.deepEqual(
    reportComponentsForShape(pyshaclReport, constraintShape),
    [SHACL_COMPONENT.sparql],
  );
});

test('direct SPARQL projection rejects remote access, updates, and subqueries', async () => {
  for (const malicious of [
    'SELECT $this WHERE { SERVICE <https://example.test/sparql> { $this <https://example.test/p> ?o . } }',
    'SELECT $this WHERE { $this <https://example.test/p> ?o . INSERT { $this <https://example.test/q> ?o } WHERE { } }',
    'SELECT $this WHERE { { SELECT $this WHERE { $this <https://example.test/p> ?o . } } }',
  ]) {
    const document = typedDocument();
    document.domain.constraints.Unsafe = baseElement('Unsafe', {
      constraintType: 'Logical',
      scope: 'Object',
      expression: { language: 'SPARQL', expression: malicious },
      severity: 'Error',
      message: 'unsafe query',
      targetElement: iri('Thing'),
    });
    document.domain.constraintBindings.push({
      constraintRef: iri('Unsafe'),
      targetElement: iri('Thing'),
      enforcementLevel: 'Mandatory',
    });
    await assert.rejects(projectShacl(document), /unsupported direct SPARQL SELECT/);
  }
});

test('direct SPARQL projection rejects a data-dependent result path that cannot be manifest-locked', async () => {
  const document = typedDocument();
  document.domain.relationTypes.partyA = baseElement('partyA', {
    domain: iri('Thing'),
    range: iri('Thing'),
    characteristics: ['functional'],
  });
  document.domain.relationUses.push({
    relation: iri('partyA'),
    subjectType: iri('Thing'),
    objectType: iri('Thing'),
    outboundCardinality: { minCount: 0, maxCount: 1 },
    constraints: [],
  });
  document.domain.constraints.DynamicPath = baseElement('DynamicPath', {
    constraintType: 'Logical',
    scope: 'Object',
    expression: {
      language: 'SPARQL',
      expression: [
        'SELECT $this ?path',
        'WHERE {',
        `  $this <${iri('partyA')}> ?path .`,
        '}',
      ].join('\n'),
    },
    severity: 'Error',
    message: 'dynamic paths cannot identify one stable constraint instance',
    targetElement: iri('Thing'),
  });
  document.domain.constraintBindings.push({
    constraintRef: iri('DynamicPath'),
    targetElement: iri('Thing'),
    enforcementLevel: 'Mandatory',
  });

  await assert.rejects(
    projectShaclWithInventory(document),
    /projected \?path must be bound exactly once to one static absolute IRI/u,
  );
});

test('legacy flat and silently-normalized authoring dialects fail closed', async () => {
  const flat = typedDocument();
  flat.domain = { Thing: flat.domain.objectTypes.Thing };
  await assert.rejects(projectOwl(flat), /M2-TYPED-CONTAINERS-REQUIRED/);
  await assert.rejects(projectShacl(flat), /M2-TYPED-CONTAINERS-REQUIRED/);

  const legacyRole = typedDocument();
  legacyRole.domain.associationTypes.LaterFact.participantRoles[0] = {
    roleName: 'subject',
    roleIri: iri('subject'),
    targetTypeIri: iri('Thing'),
    minCount: 1,
    maxCount: 1,
  };
  await assert.rejects(projectOwl(legacyRole), /roleName.*not allowed|strict M3 type/);

  const literalCodes = typedDocument();
  literalCodes.domain.codeLists.Status.values = ['A', 'Z'];
  await assert.rejects(projectShacl(literalCodes), /values\[0\].*must be an object/);

  const invalidAbstract = typedDocument();
  invalidAbstract.domain.objectTypes.Thing.abstract = 'true';
  await assert.rejects(projectOwl(invalidAbstract), /abstract.*must be boolean/u);
  await assert.rejects(projectShacl(invalidAbstract), /abstract.*must be boolean/u);

  const duplicatePatternField = typedDocument();
  duplicatePatternField.domain.objectTypes.Thing.attributeUses.push({
    attribute: PROVENANCE_FIELDS.revision,
    minCount: 0,
    maxCount: 1,
  });
  await assert.rejects(
    projectOwl(duplicatePatternField),
    /duplicates field injected by pattern.*ProvenancedFact/u,
  );
  await assert.rejects(
    projectShacl(duplicatePatternField),
    /duplicates field injected by pattern.*ProvenancedFact/u,
  );

  const localMoney = typedDocument();
  localMoney.domain.objectTypes.MonetaryAmount = baseElement('MonetaryAmount', {
    patternBindings: patterns(),
  });
  await assert.rejects(projectOwl(localMoney), /canonical M3 value classes/);

  const datatypeClassAlignment = typedDocument();
  datatypeClassAlignment.domain.identifierTypes.ExternalIdentifier = baseElement(
    'ExternalIdentifier',
    {
      baseType: 'string',
      standard: 'test standard',
      validatorRef: iri('ExternalIdentifierValidation'),
      alignments: [{
        vocabulary: 'Test',
        targetIri: 'https://example.test/external/IdentifierClass',
        relation: 'rdfs:subClassOf',
      }],
    },
  );
  await assert.rejects(
    projectOwl(datatypeClassAlignment),
    /IdentifierTypeDefinition projects to rdfs:Datatype/,
  );

  const codeListMapping = typedDocument();
  codeListMapping.domain.codeLists.Status.alignments = [{
    vocabulary: 'Test',
    targetIri: 'https://example.test/external/StatusConcept',
    relation: 'skos:closeMatch',
  }];
  await assert.rejects(
    projectOwl(codeListMapping),
    /CodeListTypeDefinition projects to owl:Class.*no value-level Alignment field/,
  );
});

test('validate-m2-core rejects an explicit field already injected by a bound pattern', () => {
  const sourcePath = path.join(
    ROOT,
    'ontology',
    'domain',
    'finance',
    'market-data',
    'module.yaml',
  );
  const document = yaml.load(fs.readFileSync(sourcePath, 'utf8'));
  const candidate = Object.values(document.domain.objectTypes).find((element) => (
    (element.patternBindings || []).some((binding) => binding.pattern === PATTERNS.provenance)
      && !(element.attributeUses || []).some((use) => use.attribute === PROVENANCE_FIELDS.revision)
  ));
  assert.ok(candidate, 'fixture module must contain a provenance-bound object type');
  candidate.attributeUses ||= [];
  candidate.attributeUses.push({
    attribute: PROVENANCE_FIELDS.revision,
    minCount: 0,
    maxCount: 1,
  });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-pattern-collision-'));
  const input = path.join(temp, 'module.yaml');
  try {
    fs.writeFileSync(input, yaml.dump(document, { lineWidth: -1 }), 'utf8');
    const result = spawnSync(process.execPath, [M2_VALIDATOR, input, '--strict'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /attributeUses\[\d+\]\.attribute: duplicates field injected by pattern .*ProvenancedFact/u,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('typed projection validates the M3 SymbolImportSpec object and import-mode contract', () => {
  const digest = `sha256:${'1'.repeat(64)}`;
  const selective = typedDocument();
  selective.module.imports = [{
    moduleIri: 'https://example.test/ontology/source',
    version: '0.3.0',
    artifactDigest: digest,
    importMode: 'Selective',
    importedSymbols: [{
      symbolIri: 'https://example.test/ontology/source/isIssuedBy',
      localAlias: 'isIssuedBy',
    }],
  }];
  assert.doesNotThrow(() => validateDocument(selective));

  const legacyString = structuredClone(selective);
  legacyString.module.imports[0].importedSymbols = [
    'https://example.test/ontology/source/isIssuedBy',
  ];
  assert.throws(
    () => validateDocument(legacyString),
    /importedSymbols\[0\].*must be an object/u,
  );

  const allWithSymbols = structuredClone(selective);
  allWithSymbols.module.imports[0].importMode = 'All';
  assert.throws(
    () => validateDocument(allWithSymbols),
    /importedSymbols.*must be absent when importMode is All/u,
  );

  const emptySelective = structuredClone(selective);
  emptySelective.module.imports[0].importedSymbols = [];
  assert.throws(
    () => validateDocument(emptySelective),
    /non-empty SymbolImportSpec list/u,
  );

  const emptyAlias = structuredClone(selective);
  emptyAlias.module.imports[0].importedSymbols[0].localAlias = '';
  assert.throws(
    () => validateDocument(emptyAlias),
    /localAlias.*non-empty string/u,
  );

  const nonNfcAlias = structuredClone(selective);
  nonNfcAlias.module.imports[0].importedSymbols[0].localAlias = 'e\u0301Alias';
  assert.throws(
    () => validateDocument(nonNfcAlias),
    /localAlias.*Unicode NFC/u,
  );

  const localCollision = structuredClone(selective);
  localCollision.module.imports[0].importedSymbols[0].localAlias =
    Object.keys(localCollision.domain.objectTypes)[0];
  assert.throws(
    () => validateDocument(localCollision),
    /localAlias.*authored localName.*Unicode NFC/u,
  );
});

test('CLI requires explicit output and never rewrites or derives output beside source', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-typed-generator-'));
  const input = path.join(temp, 'module.yaml');
  const owlOutput = path.join(temp, 'out', 'module.owl.ttl');
  const shaclOutput = path.join(temp, 'out', 'module.shacl.ttl');
  fs.writeFileSync(input, yaml.dump(typedDocument(), { noRefs: true, lineWidth: 120 }));
  const before = fs.readFileSync(input);

  for (const generator of [OWL_GENERATOR, SHACL_GENERATOR]) {
    const missingOutput = spawnSync(process.execPath, [generator, input], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: false,
    });
    assert.notEqual(missingOutput.status, 0);
    assert.match(missingOutput.stderr, /Usage:/);

    const overwrite = spawnSync(process.execPath, [generator, input, input], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: false,
    });
    assert.notEqual(overwrite.status, 0);
    assert.match(overwrite.stderr, /must not overwrite/);
  }

  const owlRun = spawnSync(process.execPath, [OWL_GENERATOR, input, owlOutput], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  const shaclRun = spawnSync(process.execPath, [SHACL_GENERATOR, input, shaclOutput], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(owlRun.status, 0, owlRun.stderr);
  assert.equal(shaclRun.status, 0, shaclRun.stderr);
  assert.ok(fs.statSync(owlOutput).size > 0);
  assert.ok(fs.statSync(shaclOutput).size > 0);
  assert.equal(fs.existsSync(path.join(temp, 'module.owl.ttl')), false);
  assert.equal(fs.existsSync(path.join(temp, 'module.shacl.ttl')), false);
  assert.equal(sha256(fs.readFileSync(input)), sha256(before));
});
