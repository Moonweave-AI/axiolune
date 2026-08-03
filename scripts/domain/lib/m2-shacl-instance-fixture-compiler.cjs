'use strict';

const crypto = require('node:crypto');
const rdfCanonize = require('rdf-canonize');
const { DataFactory, Parser } = require('n3');
const {
  SH,
  parseIndex,
  resolveGlobalShaclExecutionDescriptors,
} = require('./m2-shacl-instance-descriptor.cjs');
const {
  constraintInstanceId,
} = require('./m2-constraint-instance-audit.cjs');
const {
  PACKAGE_VERSION: RDFC_PACKAGE_VERSION,
  validateToolVersion: validateRdfcToolVersion,
} = require('./rdfc-1.0.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const { defaultGraph, literal, namedNode, quad } = DataFactory;

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_NIL = `${RDF}nil`;
const SHAPE_PREDICATES = Object.freeze({
  class: `${SH}class`,
  datatype: `${SH}datatype`,
  in: `${SH}in`,
  maxCount: `${SH}maxCount`,
  minCount: `${SH}minCount`,
  node: `${SH}node`,
  nodeKind: `${SH}nodeKind`,
  not: `${SH}not`,
  pattern: `${SH}pattern`,
  property: `${SH}property`,
  sparql: `${SH}sparql`,
  xone: `${SH}xone`,
});
const SEVERITY_IRIS = Object.freeze({
  violation: `${SH}Violation`,
  warning: `${SH}Warning`,
  info: `${SH}Info`,
});
const FIXTURE_FOCUS_CLASS = 'urn:axiolune:m2:constraint-instance:FixtureFocus';
const FIXTURE_ANCHOR = 'urn:axiolune:m2:constraint-instance:FixtureAnchor';

class ShaclFixtureCompileError extends Error {
  constructor(code, instanceId, message) {
    super(`${code}: ${instanceId}: ${message}`);
    this.name = 'ShaclFixtureCompileError';
    this.code = code;
    this.instanceId = instanceId;
  }
}

function fail(code, instanceId, message) {
  throw new ShaclFixtureCompileError(code, instanceId, message);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function termKey(term) {
  return [term.termType, term.value, term.language || '', term.datatype?.value || ''].join('\0');
}

function quadKey(value) {
  return [value.subject, value.predicate, value.object, value.graph]
    .map(termKey).join('\u0001');
}

function addQuad(quads, subject, predicate, object) {
  const value = quad(subject, predicate, object, defaultGraph());
  quads.set(quadKey(value), value);
}

function termNTriples(term) {
  if (term.termType === 'NamedNode') return `<${term.value}>`;
  if (term.termType === 'BlankNode') return `_:${term.value}`;
  if (term.termType !== 'Literal') throw new Error(`unsupported RDF term ${term.termType}`);
  const lexical = JSON.stringify(term.value)
    .replace(/\\b/gu, '\\u0008')
    .replace(/\\f/gu, '\\u000c');
  if (term.language) return `${lexical}@${term.language}`;
  return `${lexical}^^<${term.datatype.value}>`;
}

async function canonicalizeQuads(quads) {
  const input = rdfCanonize.NQuads.serialize([...quads.values()]);
  return rdfCanonize.canonize(input, {
    algorithm: 'RDFC-1.0',
    inputFormat: 'application/n-quads',
    format: 'application/n-quads',
  });
}

function readList(index, head, instanceId) {
  const values = [];
  const seen = new Set();
  let current = head;
  while (!(current.termType === 'NamedNode' && current.value === RDF_NIL)) {
    if (current.termType !== 'BlankNode' || seen.has(current.value)) {
      fail('M2_SHACL_FIXTURE_LIST', instanceId, 'RDF list is cyclic or not blank-node linked');
    }
    seen.add(current.value);
    const first = index.objects(current.value, RDF_FIRST);
    const rest = index.objects(current.value, RDF_REST);
    if (first.length !== 1 || rest.length !== 1) {
      fail('M2_SHACL_FIXTURE_LIST', instanceId, `list node ${current.value} has invalid arity`);
    }
    values.push(first[0]);
    current = rest[0];
  }
  if (values.length === 0) fail('M2_SHACL_FIXTURE_LIST', instanceId, 'RDF list is empty');
  return values;
}

function integerObject(index, subject, predicate, fallback, instanceId) {
  const values = index.objects(subject, predicate);
  if (values.length === 0) return fallback;
  if (values.length !== 1 || values[0].termType !== 'Literal'
      || !/^(?:0|[1-9][0-9]*)$/u.test(values[0].value)) {
    fail('M2_SHACL_FIXTURE_INTEGER', instanceId, `${subject} ${predicate} is not one integer`);
  }
  return Number(values[0].value);
}

function patternLexical(pattern, polarity, instanceId) {
  const values = {
    '^\\S(?:.*\\S)?$': ['value', ' '],
    '^sha256:[0-9a-f]{64}$': [`sha256:${'a'.repeat(64)}`, 'sha256:not-a-digest'],
    '^[A-Z]{3}$': ['USD', 'usd'],
    '^[0-9]{3}$': ['123', '12A'],
    '^[A-Za-z_+-]+(?:/[A-Za-z0-9_+.-]+)+$|^UTC$': ['UTC', 'bad timezone'],
    '^[A-Za-z][A-Za-z0-9+.-]*:[^\\s]+$': ['urn:fixture:unit', 'not an iri'],
    '^https?://\\S+$': ['https://example.test/value', 'urn:not-http'],
    '^[A-Za-z_+-]+(?:/[A-Za-z0-9_+-]+)+$': ['Asia/Shanghai', 'bad timezone'],
    '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$': ['12:34:56', '25:99'],
    '^openingRemainder$': ['openingRemainder', 'closingRemainder'],
    '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$': ['fixture-id', '!bad'],
  }[pattern];
  if (!values) fail('M2_SHACL_FIXTURE_PATTERN_UNSUPPORTED', instanceId, pattern);
  const value = values[polarity === 'positive' ? 0 : 1];
  const matches = new RegExp(pattern, 'u').test(value);
  if ((polarity === 'positive') !== matches) {
    fail('M2_SHACL_FIXTURE_PATTERN_VECTOR', instanceId, `${pattern} / ${value}`);
  }
  return value;
}

function datatypeLiteral(datatype, lexicalOverride) {
  const lexical = lexicalOverride ?? ({
    [`${XSD}string`]: 'value',
    [`${XSD}anyURI`]: 'urn:fixture:value',
    [`${XSD}integer`]: '1',
    [`${XSD}nonNegativeInteger`]: '0',
    [`${XSD}decimal`]: '1.0',
    [`${XSD}dateTimeStamp`]: '2026-01-01T00:00:00Z',
    [`${XSD}date`]: '2026-01-01',
    [`${XSD}duration`]: 'P1D',
    [`${XSD}boolean`]: 'true',
  }[datatype] || 'VALID');
  return literal(lexical, namedNode(datatype));
}

function marker(quads, focus) {
  addQuad(
    quads,
    namedNode(FIXTURE_ANCHOR),
    namedNode(RDF_TYPE),
    namedNode(FIXTURE_FOCUS_CLASS),
  );
  if (focus.termType === 'NamedNode') {
    addQuad(quads, focus, namedNode(RDF_TYPE), namedNode(FIXTURE_FOCUS_CLASS));
  }
}

function distinctIri(instanceId, suffix) {
  return namedNode(`urn:axiolune:m2:constraint-instance:${instanceId}:${suffix}`);
}

function componentObject(index, shapeRef, predicate, instanceId) {
  const values = index.objects(shapeRef, predicate);
  if (values.length !== 1) {
    fail('M2_SHACL_FIXTURE_COMPONENT_ARITY', instanceId, `${shapeRef} ${predicate}`);
  }
  return values[0];
}

function satisfyingPropertyValue(index, propertyShape, instanceId, ordinal, quads) {
  const inObjects = index.objects(propertyShape, SHAPE_PREDICATES.in);
  if (inObjects.length > 0) return readList(index, inObjects[0], instanceId)[0];
  const patterns = index.objects(propertyShape, SHAPE_PREDICATES.pattern);
  const datatypes = index.objects(propertyShape, SHAPE_PREDICATES.datatype);
  if (patterns.length > 1 || datatypes.length > 1) {
    fail('M2_SHACL_FIXTURE_PROPERTY_ARITY', instanceId, propertyShape);
  }
  if (datatypes.length === 1) {
    const lexical = patterns.length === 1
      ? patternLexical(patterns[0].value, 'positive', instanceId) : undefined;
    return datatypeLiteral(datatypes[0].value, lexical);
  }
  if (patterns.length === 1) {
    return literal(patternLexical(patterns[0].value, 'positive', instanceId));
  }
  return distinctIri(instanceId, `nested-value-${ordinal}`);
}

function satisfyShape(index, shapeRef, focus, instanceId, quads, visiting = new Set()) {
  if (visiting.has(shapeRef)) return;
  visiting.add(shapeRef);
  for (const classTerm of index.objects(shapeRef, SHAPE_PREDICATES.class)) {
    if (focus.termType !== 'NamedNode') {
      fail('M2_SHACL_FIXTURE_NESTED_CLASS', instanceId, `${shapeRef} needs an IRI focus`);
    }
    addQuad(quads, focus, namedNode(RDF_TYPE), classTerm);
  }
  for (const nodeKind of index.objects(shapeRef, SHAPE_PREDICATES.nodeKind)) {
    if (![`${SH}IRI`, `${SH}BlankNodeOrIRI`].includes(nodeKind.value)
        || focus.termType !== 'NamedNode') {
      fail('M2_SHACL_FIXTURE_NESTED_NODE_KIND', instanceId, `${shapeRef} ${nodeKind.value}`);
    }
  }
  for (const nested of index.objects(shapeRef, SHAPE_PREDICATES.node)) {
    satisfyShape(index, nested.value, focus, instanceId, quads, visiting);
  }
  // Current logical-reference contracts use sh:not [ sh:class FactVersion ].
  // Satisfying the outer shape means deliberately adding no facts that make
  // the forbidden nested class shape conform.  Verify the nested shape is a
  // closed one-class contract so this omission cannot become vacuous drift.
  for (const forbidden of index.objects(shapeRef, SHAPE_PREDICATES.not)) {
    const classes = index.objects(forbidden.value, SHAPE_PREDICATES.class);
    const other = Object.values(SHAPE_PREDICATES)
      .filter((predicate) => predicate !== SHAPE_PREDICATES.class)
      .some((predicate) => index.objects(forbidden.value, predicate).length > 0);
    if (classes.length !== 1 || other) {
      fail('M2_SHACL_FIXTURE_NESTED_NOT_UNSUPPORTED', instanceId, forbidden.value);
    }
  }
  for (const propertyShape of index.objects(shapeRef, SHAPE_PREDICATES.property)) {
    const paths = index.objects(propertyShape.value, `${SH}path`);
    if (paths.length !== 1 || paths[0].termType !== 'NamedNode') {
      fail('M2_SHACL_FIXTURE_NESTED_PATH', instanceId, propertyShape.value);
    }
    const minCount = integerObject(
      index,
      propertyShape.value,
      SHAPE_PREDICATES.minCount,
      0,
      instanceId,
    );
    const maxCount = integerObject(
      index,
      propertyShape.value,
      SHAPE_PREDICATES.maxCount,
      Number.MAX_SAFE_INTEGER,
      instanceId,
    );
    if (minCount > maxCount) fail('M2_SHACL_FIXTURE_NESTED_CARDINALITY', instanceId, propertyShape.value);
    for (let ordinal = 0; ordinal < minCount; ordinal += 1) {
      const value = satisfyingPropertyValue(
        index,
        propertyShape.value,
        instanceId,
        ordinal,
        quads,
      );
      addQuad(quads, focus, paths[0], value);
      for (const classTerm of index.objects(propertyShape.value, SHAPE_PREDICATES.class)) {
        if (value.termType !== 'NamedNode') {
          fail('M2_SHACL_FIXTURE_NESTED_VALUE_CLASS', instanceId, propertyShape.value);
        }
        addQuad(quads, value, namedNode(RDF_TYPE), classTerm);
      }
      for (const nested of index.objects(propertyShape.value, SHAPE_PREDICATES.node)) {
        satisfyShape(index, nested.value, value, instanceId, quads, visiting);
      }
    }
  }
  visiting.delete(shapeRef);
}

function failNestedShape(index, shapeRef, focus, instanceId, quads) {
  const classes = index.objects(shapeRef, SHAPE_PREDICATES.class);
  if (classes.length === 1) return;
  const minProperties = index.objects(shapeRef, SHAPE_PREDICATES.property)
    .filter((propertyShape) => integerObject(
      index,
      propertyShape.value,
      SHAPE_PREDICATES.minCount,
      0,
      instanceId,
    ) > 0);
  if (minProperties.length > 0) return;
  fail('M2_SHACL_FIXTURE_NESTED_FAILURE_UNSUPPORTED', instanceId, shapeRef);
}

function expectedSparqlPath(index, descriptor, instanceId) {
  const object = componentObject(
    index,
    descriptor.shapeRef,
    SHAPE_PREDICATES.sparql,
    instanceId,
  );
  const selects = index.objects(object.value, `${SH}select`);
  if (selects.length !== 1 || selects[0].termType !== 'Literal') {
    fail('M2_SHACL_FIXTURE_SPARQL_SELECT', instanceId, object.value);
  }
  const match = /BIND\(\s*<([^>]+)>\s+AS\s+\?path\s*\)/u.exec(selects[0].value);
  const derived = match?.[1] || null;
  if (descriptor.context.path && derived && descriptor.context.path !== derived) {
    fail('M2_SHACL_FIXTURE_SPARQL_PATH_DRIFT', instanceId, `${descriptor.context.path} != ${derived}`);
  }
  return { object, select: selects[0].value, path: descriptor.context.path || derived };
}

function synthesizeData(index, descriptor, instanceId, polarity) {
  const context = descriptor.context;
  const quads = new Map();
  const baseFocus = distinctIri(instanceId, 'focus');
  let focus = baseFocus;
  const predicate = context.path ? namedNode(context.path) : null;
  const component = context.component;
  const object = componentObject(index, descriptor.shapeRef, descriptor.componentPredicate, instanceId);

  if (component === `${SH}NodeKindConstraintComponent` && descriptor.shapeKind === 'node') {
    focus = polarity === 'positive'
      ? baseFocus : literal('literal-focus', namedNode(`${XSD}string`));
  } else if (component === `${SH}InConstraintComponent` && descriptor.shapeKind === 'node') {
    const allowed = readList(index, object, instanceId);
    focus = polarity === 'positive'
      ? allowed[0] : distinctIri(instanceId, 'not-in-list');
    if (polarity === 'negative' && allowed.some((term) => term.equals(focus))) {
      fail('M2_SHACL_FIXTURE_IN_NEGATIVE', instanceId, 'negative term collides with list');
    }
  }
  marker(quads, focus);

  const addValues = (count, factory) => {
    if (!predicate || focus.termType !== 'NamedNode') {
      fail('M2_SHACL_FIXTURE_PROPERTY_TARGET', instanceId, component);
    }
    for (let indexValue = 0; indexValue < count; indexValue += 1) {
      addQuad(quads, focus, predicate, factory(indexValue));
    }
  };

  if (component === `${SH}MinCountConstraintComponent`) {
    const count = Number(object.value);
    addValues(polarity === 'positive' ? count : count - 1, (ordinal) => (
      distinctIri(instanceId, `value-${ordinal}`)
    ));
  } else if (component === `${SH}MaxCountConstraintComponent`) {
    const count = Number(object.value);
    addValues(polarity === 'positive' ? count : count + 1, (ordinal) => (
      distinctIri(instanceId, `value-${ordinal}`)
    ));
  } else if (component === `${SH}DatatypeConstraintComponent`) {
    if (polarity === 'positive') addValues(1, () => datatypeLiteral(object.value));
    else addValues(1, () => distinctIri(instanceId, 'wrong-datatype'));
  } else if (component === `${SH}ClassConstraintComponent`) {
    const target = descriptor.shapeKind === 'property'
      ? distinctIri(instanceId, 'class-value') : focus;
    if (descriptor.shapeKind === 'property') addValues(1, () => target);
    if (polarity === 'positive') addQuad(quads, target, namedNode(RDF_TYPE), object);
  } else if (component === `${SH}NodeKindConstraintComponent`) {
    if (![`${SH}IRI`, `${SH}BlankNodeOrIRI`].includes(object.value)) {
      fail('M2_SHACL_FIXTURE_NODE_KIND_UNSUPPORTED', instanceId, object.value);
    }
    if (descriptor.shapeKind === 'property') {
      addValues(1, () => polarity === 'positive'
        ? distinctIri(instanceId, 'iri-value')
        : literal('literal-value', namedNode(`${XSD}string`)));
    }
  } else if (component === `${SH}PatternConstraintComponent`) {
    addValues(1, () => literal(patternLexical(object.value, polarity, instanceId)));
  } else if (component === `${SH}InConstraintComponent`) {
    if (descriptor.shapeKind === 'property') {
      const allowed = readList(index, object, instanceId);
      const value = polarity === 'positive' ? allowed[0] : distinctIri(instanceId, 'not-in-list');
      if (polarity === 'negative' && allowed.some((term) => term.equals(value))) {
        fail('M2_SHACL_FIXTURE_IN_NEGATIVE', instanceId, 'negative term collides with list');
      }
      addValues(1, () => value);
    }
  } else if (component === `${SH}NodeConstraintComponent`) {
    const value = polarity === 'positive'
      ? distinctIri(instanceId, 'node-value')
      : literal('invalid-node', namedNode(`${XSD}string`));
    if (descriptor.shapeKind === 'property') addValues(1, () => value);
    else focus = value;
    if (polarity === 'positive') satisfyShape(index, object.value, value, instanceId, quads);
    if (descriptor.shapeKind === 'node' && polarity === 'negative') {
      // Replace the marker focus after selecting the literal negative node.
      marker(quads, focus);
    }
  } else if (component === `${SH}NotConstraintComponent`) {
    if (polarity === 'positive') failNestedShape(index, object.value, focus, instanceId, quads);
    else satisfyShape(index, object.value, focus, instanceId, quads);
  } else if (component === `${SH}XoneConstraintComponent`) {
    const branches = readList(index, object, instanceId);
    if (polarity === 'positive') {
      satisfyShape(index, branches[0].value, focus, instanceId, quads);
    } else {
      for (const branch of branches) {
        failNestedShape(index, branch.value, focus, instanceId, quads);
      }
    }
  } else if (component === `${SH}SPARQLConstraintComponent`) {
    const contract = expectedSparqlPath(index, descriptor, instanceId);
    if (contract.select.includes('validFrom') && contract.select.includes('validTo')) {
      const validFrom = namedNode('https://axiolune.ai/ontology/meta/patterns/attributes/validFrom');
      const validTo = namedNode('https://axiolune.ai/ontology/meta/patterns/attributes/validTo');
      addQuad(
        quads,
        focus,
        validFrom,
        datatypeLiteral(`${XSD}dateTimeStamp`, '2026-01-01T00:00:00Z'),
      );
      addQuad(
        quads,
        focus,
        validTo,
        datatypeLiteral(
          `${XSD}dateTimeStamp`,
          polarity === 'positive' ? '2026-01-02T00:00:00Z' : '2025-12-31T00:00:00Z',
        ),
      );
    } else if (contract.select.includes('otcCounterpartyA')
        && contract.select.includes('otcCounterpartyB')) {
      if (polarity === 'negative') {
        addQuad(
          quads,
          focus,
          namedNode('https://axiolune.ai/ontology/finance/market-structure/otcCounterpartyA'),
          distinctIri(instanceId, 'counterparty-a'),
        );
      }
    } else {
      fail('M2_SHACL_FIXTURE_SPARQL_UNSUPPORTED', instanceId, context.originRef);
    }
  } else {
    fail('M2_SHACL_FIXTURE_COMPONENT_UNSUPPORTED', instanceId, component);
  }
  return { focus, quads };
}

async function shapeFixture(index, descriptor, instanceId, focus) {
  const closureQuads = new Parser({ format: 'N-Quads' }).parse(
    descriptor.semanticClosure.canonicalNQuads,
  );
  const quads = new Map(closureQuads.map((value) => [quadKey(value), value]));
  const shape = namedNode(descriptor.shapeRef);
  const severityIri = SEVERITY_IRIS[descriptor.context.severity];
  if (!severityIri) fail('M2_SHACL_FIXTURE_SEVERITY', instanceId, descriptor.context.severity);
  const severities = closureQuads.filter((value) => (
    value.subject.value === descriptor.shapeRef && value.predicate.value === `${SH}severity`
  ));
  if (severities.length > 1 || severities.some((value) => value.object.value !== severityIri)) {
    fail('M2_SHACL_FIXTURE_SEVERITY_DRIFT', instanceId, descriptor.shapeRef);
  }
  if (severities.length === 0) addQuad(quads, shape, namedNode(`${SH}severity`), namedNode(severityIri));
  addQuad(quads, shape, namedNode(`${SH}targetNode`), focus);
  return canonicalizeQuads(quads);
}

function expectedPath(index, descriptor, instanceId) {
  if (descriptor.context.component === `${SH}SPARQLConstraintComponent`) {
    return expectedSparqlPath(index, descriptor, instanceId).path || null;
  }
  return descriptor.context.path || null;
}

async function compileOne(descriptor, polarity) {
  const instanceId = constraintInstanceId(descriptor.context);
  const index = parseIndex(Buffer.from(descriptor.semanticClosure.canonicalNQuads, 'utf8'));
  const data = synthesizeData(index, descriptor, instanceId, polarity);
  const [shapeNQuads, dataNQuads] = await Promise.all([
    shapeFixture(index, descriptor, instanceId, data.focus),
    canonicalizeQuads(data.quads),
  ]);
  return Object.freeze({
    fixtureId: `${instanceId}-${polarity}`,
    constraintInstanceId: instanceId,
    emittedBy: descriptor.emittedBy,
    shapeRef: descriptor.shapeRef,
    shapeDigest: sha256(Buffer.from(shapeNQuads, 'utf8')),
    shapeNQuads,
    dataDigest: sha256(Buffer.from(dataNQuads, 'utf8')),
    dataNQuads,
    focusNode: termNTriples(data.focus),
    expectedPath: expectedPath(index, descriptor, instanceId),
    expectedComponent: descriptor.context.component,
    expectedSeverity: SEVERITY_IRIS[descriptor.context.severity],
    expectedResult: polarity === 'positive' ? 'conforms' : 'violates',
  });
}

function aggregate(polarity, cases) {
  const value = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    artifactKind: 'constraintInstanceFixtureAggregate',
    polarity,
    rdfCanonicalization: 'RDFC-1.0',
    rdfCanonicalizer: `rdf-canonize@${RDFC_PACKAGE_VERSION}`,
    cases,
  };
  const bytes = Buffer.from(canonicalJcs(value), 'utf8');
  return Object.freeze({
    value,
    bytes,
    digest: sha256(bytes),
  });
}

async function compileShaclInstanceFixtures(options = {}) {
  validateRdfcToolVersion();
  const descriptors = await resolveGlobalShaclExecutionDescriptors({
    projections: options.projections,
  });
  const custom = [];
  const shacl = [];
  for (const descriptor of descriptors) {
    const instanceId = constraintInstanceId(descriptor.context);
    if (descriptor.executionKind === 'custom') {
      custom.push(Object.freeze({
        constraintInstanceId: instanceId,
        context: descriptor.context,
        emittedBy: descriptor.emittedBy,
        resolution: 'unresolved-custom-capability',
      }));
    } else {
      shacl.push({ instanceId, descriptor });
    }
  }
  shacl.sort((left, right) => byteCompare(left.instanceId, right.instanceId));
  custom.sort((left, right) => byteCompare(
    left.constraintInstanceId,
    right.constraintInstanceId,
  ));
  const ids = [...shacl.map((row) => row.instanceId), ...custom.map((row) => row.constraintInstanceId)];
  if (new Set(ids).size !== ids.length) {
    throw new Error('constraint-instance stable ID collision during fixture compilation');
  }
  const positiveCases = [];
  const negativeCases = [];
  for (const row of shacl) {
    positiveCases.push(await compileOne(row.descriptor, 'positive'));
    negativeCases.push(await compileOne(row.descriptor, 'negative'));
  }
  return Object.freeze({
    outcome: custom.length === 0 ? 'compiled' : 'incomplete',
    descriptorCount: descriptors.length,
    shaclCount: shacl.length,
    customCount: custom.length,
    custom: Object.freeze(custom),
    positive: aggregate('positive', Object.freeze(positiveCases)),
    negative: aggregate('negative', Object.freeze(negativeCases)),
  });
}

module.exports = {
  PROFILE_REF,
  SEVERITY_IRIS,
  ShaclFixtureCompileError,
  compileOne,
  compileShaclInstanceFixtures,
  datatypeLiteral,
  patternLexical,
  readList,
  satisfyShape,
  synthesizeData,
  termNTriples,
};
