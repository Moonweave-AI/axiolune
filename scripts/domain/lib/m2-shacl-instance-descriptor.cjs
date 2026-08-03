'use strict';

const crypto = require('node:crypto');
const { Parser } = require('n3');
const rdfCanonize = require('rdf-canonize');
const {
  PACKAGE_VERSION: RDFC_PACKAGE_VERSION,
  validateToolVersion: validateRdfcToolVersion,
} = require('./rdfc-1.0.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const SH = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';
const CUSTOM_COMPONENT =
  'https://axiolune.ai/conformance/m2/0.3.0/components/CustomConstraintComponent';

const COMPONENT_PREDICATES = Object.freeze({
  [`${SH}ClassConstraintComponent`]: `${SH}class`,
  [`${SH}DatatypeConstraintComponent`]: `${SH}datatype`,
  [`${SH}InConstraintComponent`]: `${SH}in`,
  [`${SH}MaxCountConstraintComponent`]: `${SH}maxCount`,
  [`${SH}MinCountConstraintComponent`]: `${SH}minCount`,
  [`${SH}NodeConstraintComponent`]: `${SH}node`,
  [`${SH}NodeKindConstraintComponent`]: `${SH}nodeKind`,
  [`${SH}NotConstraintComponent`]: `${SH}not`,
  [`${SH}PatternConstraintComponent`]: `${SH}pattern`,
  [`${SH}SPARQLConstraintComponent`]: `${SH}sparql`,
  [`${SH}XoneConstraintComponent`]: `${SH}xone`,
});

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function contextLabel(context) {
  return [
    context.originKind,
    context.originRef,
    context.targetRef,
    Object.hasOwn(context, 'path') ? context.path : '',
    context.component,
  ].join(' | ');
}

function contextKey(context) {
  const pathPresent = Object.hasOwn(context, 'pathKind') || Object.hasOwn(context, 'path');
  return [
    context.originKind,
    context.originRef,
    context.targetRef,
    pathPresent ? '1' : '0',
    pathPresent ? context.pathKind : '',
    pathPresent ? context.path : '',
    context.component,
  ].join('\0');
}

class ShaclDescriptorResolutionError extends Error {
  constructor(code, context, candidates) {
    const candidateText = candidates.length === 0 ? 'none' : candidates.join(', ');
    super(`${code}: ${contextLabel(context)}; candidates=${candidateText}`);
    this.name = 'ShaclDescriptorResolutionError';
    this.code = code;
    this.context = context;
    this.candidates = candidates;
  }
}

function parseIndex(shaclBytes) {
  const quads = new Parser().parse(Buffer.isBuffer(shaclBytes)
    ? shaclBytes.toString('utf8')
    : String(shaclBytes));
  const bySubjectPredicate = new Map();
  const subjectsByPredicate = new Map();
  const parentsByPropertyShape = new Map();

  function pair(subject, predicate) {
    return `${subject}\0${predicate}`;
  }

  for (const quad of quads) {
    const subject = quad.subject.value;
    const predicate = quad.predicate.value;
    const object = quad.object.value;
    const key = pair(subject, predicate);
    if (!bySubjectPredicate.has(key)) bySubjectPredicate.set(key, []);
    bySubjectPredicate.get(key).push(quad.object);
    if (!subjectsByPredicate.has(predicate)) subjectsByPredicate.set(predicate, new Set());
    subjectsByPredicate.get(predicate).add(subject);
    if (predicate === `${SH}property`) {
      if (!parentsByPropertyShape.has(object)) parentsByPropertyShape.set(object, new Set());
      parentsByPropertyShape.get(object).add(subject);
    }
  }

  return {
    quads,
    objects(subject, predicate) {
      return bySubjectPredicate.get(pair(subject, predicate)) || [];
    },
    subjects(predicate) {
      return [...(subjectsByPredicate.get(predicate) || [])].sort(byteCompare);
    },
    parents(propertyShape) {
      return [...(parentsByPropertyShape.get(propertyShape) || [])].sort(byteCompare);
    },
  };
}

function quadKey(quad) {
  const termKey = (term) => [
    term.termType,
    term.value,
    term.language || '',
    term.datatype?.value || '',
  ].join('\0');
  return [quad.subject, quad.predicate, quad.object, quad.graph].map(termKey).join('\u0001');
}

function selectedComponentClosure(index, descriptor) {
  if (descriptor.executionKind !== 'shacl') {
    throw new Error('selectedComponentClosure requires a SHACL descriptor');
  }
  const selected = new Map();
  const visitingShapes = new Set();
  const visitingResources = new Set();
  const visitedListNodes = new Set();

  function add(quad) {
    selected.set(quadKey(quad), quad);
  }

  function addMatches(subject, predicate) {
    const matches = index.quads.filter((quad) => (
      quad.subject.value === subject && quad.predicate.value === predicate
    ));
    for (const quad of matches) add(quad);
    return matches;
  }

  function visitOpaqueResource(term) {
    if (!term || !['BlankNode', 'NamedNode'].includes(term.termType)
        || visitingResources.has(`${term.termType}\0${term.value}`)) return;
    visitingResources.add(`${term.termType}\0${term.value}`);
    for (const quad of index.quads.filter((candidate) => (
      candidate.subject.termType === term.termType
        && candidate.subject.value === term.value
    ))) {
      add(quad);
      if (quad.object.termType === 'BlankNode') visitOpaqueResource(quad.object);
    }
  }

  function visitList(term, membersAreShapes) {
    if (!term || term.termType === 'NamedNode' && term.value === RDF_NIL) return;
    if (term.termType !== 'BlankNode') {
      throw new ShaclDescriptorResolutionError(
        'M2_SHACL_DESCRIPTOR_LIST_NODE',
        descriptor.context,
        [term.value],
      );
    }
    const listKey = `${membersAreShapes ? 'shape' : 'value'}\0${term.value}`;
    if (visitedListNodes.has(listKey)) {
      throw new ShaclDescriptorResolutionError(
        'M2_SHACL_DESCRIPTOR_LIST_CYCLE',
        descriptor.context,
        [term.value],
      );
    }
    visitedListNodes.add(listKey);
    const first = addMatches(term.value, RDF_FIRST);
    const rest = addMatches(term.value, RDF_REST);
    if (first.length !== 1 || rest.length !== 1) {
      throw new ShaclDescriptorResolutionError(
        'M2_SHACL_DESCRIPTOR_LIST_ARITY',
        descriptor.context,
        [term.value],
      );
    }
    if (membersAreShapes) visitShape(first[0].object.value);
    if (rest[0].object.termType === 'BlankNode') visitList(rest[0].object, membersAreShapes);
    else if (rest[0].object.termType !== 'NamedNode' || rest[0].object.value !== RDF_NIL) {
      throw new ShaclDescriptorResolutionError(
        'M2_SHACL_DESCRIPTOR_LIST_TAIL',
        descriptor.context,
        [rest[0].object.value],
      );
    }
    visitedListNodes.delete(listKey);
  }

  function visitComponentObject(predicate, object) {
    if (predicate === `${SH}in`) visitList(object, false);
    else if (predicate === `${SH}xone`) visitList(object, true);
    else if (predicate === `${SH}node` || predicate === `${SH}not`) {
      if (!['NamedNode', 'BlankNode'].includes(object.termType)) {
        throw new ShaclDescriptorResolutionError(
          'M2_SHACL_DESCRIPTOR_SHAPE_OBJECT',
          descriptor.context,
          [object.value],
        );
      }
      visitShape(object.value);
    } else if (predicate === `${SH}sparql`) visitOpaqueResource(object);
  }

  function visitShape(shapeRef) {
    if (visitingShapes.has(shapeRef)) return;
    visitingShapes.add(shapeRef);
    const typeRows = addMatches(shapeRef, RDF_TYPE).filter((quad) => (
      quad.object.value === `${SH}NodeShape` || quad.object.value === `${SH}PropertyShape`
    ));
    if (typeRows.length !== 1) {
      throw new ShaclDescriptorResolutionError(
        'M2_SHACL_DESCRIPTOR_NESTED_SHAPE_KIND',
        descriptor.context,
        [shapeRef],
      );
    }
    for (const predicate of [`${SH}path`, `${SH}message`, `${SH}severity`]) {
      addMatches(shapeRef, predicate);
    }
    for (const predicate of Object.values(COMPONENT_PREDICATES)) {
      for (const quad of addMatches(shapeRef, predicate)) {
        visitComponentObject(predicate, quad.object);
      }
    }
    for (const quad of addMatches(shapeRef, `${SH}property`)) {
      visitShape(quad.object.value);
    }
  }

  const typeRows = index.quads.filter((quad) => (
    quad.subject.value === descriptor.shapeRef
      && quad.predicate.value === RDF_TYPE
      && quad.object.value === `${SH}${descriptor.shapeKind === 'property' ? 'PropertyShape' : 'NodeShape'}`
  ));
  if (typeRows.length !== 1) {
    throw new ShaclDescriptorResolutionError(
      'M2_SHACL_DESCRIPTOR_SHAPE_KIND',
      descriptor.context,
      [descriptor.shapeRef],
    );
  }
  add(typeRows[0]);
  if (descriptor.shapeKind === 'property') {
    const paths = addMatches(descriptor.shapeRef, `${SH}path`);
    if (paths.length !== 1) {
      throw new ShaclDescriptorResolutionError(
        'M2_SHACL_DESCRIPTOR_PATH_ARITY',
        descriptor.context,
        [descriptor.shapeRef],
      );
    }
  }
  for (const predicate of [`${SH}message`, `${SH}severity`]) {
    addMatches(descriptor.shapeRef, predicate);
  }
  const componentRows = addMatches(descriptor.shapeRef, descriptor.componentPredicate);
  if (componentRows.length !== 1) {
    throw new ShaclDescriptorResolutionError(
      'M2_SHACL_DESCRIPTOR_COMPONENT_ARITY',
      descriptor.context,
      [descriptor.shapeRef],
    );
  }
  visitComponentObject(descriptor.componentPredicate, componentRows[0].object);
  return [...selected.values()];
}

async function canonicalizeSelectedClosure(index, descriptor) {
  validateRdfcToolVersion();
  const quads = selectedComponentClosure(index, descriptor);
  const nquads = rdfCanonize.NQuads.serialize(quads);
  const canonicalNQuads = await rdfCanonize.canonize(nquads, {
    algorithm: 'RDFC-1.0',
    inputFormat: 'application/n-quads',
    format: 'application/n-quads',
  });
  const digest = `sha256:${crypto.createHash('sha256')
    .update(Buffer.from('axiolune-m2-shacl-component-closure-v1\0', 'utf8'))
    .update(Buffer.from(canonicalNQuads, 'utf8'))
    .digest('hex')}`;
  return { algorithm: 'RDFC-1.0', packageVersion: RDFC_PACKAGE_VERSION, canonicalNQuads, digest };
}

function hasObject(index, subject, predicate, object) {
  return index.objects(subject, predicate).some((term) => term.value === object);
}

function isAuthoredDirectComponent(context) {
  return context.originKind === 'constraintDefinition'
    && (context.component === `${SH}XoneConstraintComponent`
      || context.component === `${SH}SPARQLConstraintComponent`);
}

function matchesPathShape(index, subject, context) {
  if (!hasObject(index, subject, `${SH}path`, context.path)) return false;

  // AttributeTypeDefinition property shapes are independently targeted via
  // sh:targetSubjectsOf and use the attribute IRI as both target and path.
  if (hasObject(index, subject, `${SH}targetSubjectsOf`, context.targetRef)) return true;

  // Contextual AttributeUse, ParticipantRole, RelationUse, pattern, and
  // reference-mode property shapes are linked from a parent shape.  The
  // contextual target is either that named parent shape or its target class.
  return index.parents(subject).some((parent) => (
    parent === context.targetRef
      || hasObject(index, parent, `${SH}targetClass`, context.targetRef)
  ));
}

function matchesNodeShape(index, subject, context) {
  if (subject === context.targetRef || subject === `${context.targetRef}Shape`) return true;
  return hasObject(index, subject, `${SH}targetClass`, context.targetRef);
}

function resolveOne(index, context) {
  if (context.component === CUSTOM_COMPONENT) {
    return Object.freeze({
      executionKind: 'custom',
      context: Object.freeze({ ...context }),
    });
  }
  const componentPredicate = COMPONENT_PREDICATES[context.component];
  if (!componentPredicate) {
    throw new ShaclDescriptorResolutionError(
      'M2_SHACL_DESCRIPTOR_COMPONENT_UNSUPPORTED',
      context,
      [],
    );
  }

  let candidates = index.subjects(componentPredicate);
  if (isAuthoredDirectComponent(context)) {
    candidates = candidates.filter((subject) => subject === `${context.originRef}/shape`);
  } else if (context.component === `${SH}SPARQLConstraintComponent`) {
    // Pattern-generated valid-interval SPARQL is attached to the canonical
    // target class shape.  Matching only targetClass would also select an
    // independently authored direct SPARQL shape on the same class.
    candidates = candidates.filter((subject) => subject === `${context.targetRef}Shape`);
  } else if (Object.hasOwn(context, 'path')) {
    candidates = candidates.filter((subject) => matchesPathShape(index, subject, context));
  } else {
    candidates = candidates.filter((subject) => matchesNodeShape(index, subject, context));
  }

  if (candidates.length !== 1) {
    throw new ShaclDescriptorResolutionError(
      candidates.length === 0
        ? 'M2_SHACL_DESCRIPTOR_MISSING'
        : 'M2_SHACL_DESCRIPTOR_AMBIGUOUS',
      context,
      candidates,
    );
  }
  const shapeRef = candidates[0];
  const componentObjects = index.objects(shapeRef, componentPredicate);
  if (componentObjects.length !== 1) {
    throw new ShaclDescriptorResolutionError(
      'M2_SHACL_DESCRIPTOR_COMPONENT_ARITY',
      context,
      [shapeRef],
    );
  }
  const isPropertyShape = hasObject(index, shapeRef, RDF_TYPE, `${SH}PropertyShape`);
  const isNodeShape = hasObject(index, shapeRef, RDF_TYPE, `${SH}NodeShape`);
  if (isPropertyShape === isNodeShape) {
    throw new ShaclDescriptorResolutionError(
      'M2_SHACL_DESCRIPTOR_SHAPE_KIND',
      context,
      [shapeRef],
    );
  }
  // A SPARQL constraint can bind ?path in its result while remaining a node
  // shape.  Therefore path presence in the manifest is not itself a property
  // shape classifier.
  if (isPropertyShape && Object.hasOwn(context, 'path')
      && !hasObject(index, shapeRef, `${SH}path`, context.path)) {
    throw new ShaclDescriptorResolutionError(
      'M2_SHACL_DESCRIPTOR_PATH_MISMATCH',
      context,
      [shapeRef],
    );
  }

  return Object.freeze({
    executionKind: 'shacl',
    context: Object.freeze({ ...context }),
    shapeRef,
    shapeKind: isPropertyShape ? 'property' : 'node',
    componentPredicate,
    componentObject: componentObjects[0],
  });
}

function resolveShaclExecutionDescriptors(options = {}) {
  if (!Array.isArray(options.contexts) || options.contexts.length === 0) {
    throw new Error('contexts must be a non-empty normalized-IR inventory');
  }
  if (options.shaclBytes === undefined || options.shaclBytes === null) {
    throw new Error('shaclBytes are required');
  }
  const index = parseIndex(options.shaclBytes);
  return options.contexts.map((context) => resolveOne(index, context));
}

async function resolveGlobalShaclExecutionDescriptors(options = {}) {
  if (!Array.isArray(options.projections) || options.projections.length === 0) {
    throw new Error('projections must be a non-empty module projection list');
  }
  const groups = new Map();
  for (const [projectionIndex, projection] of options.projections.entries()) {
    if (!projection || typeof projection.modulePath !== 'string'
        || !Array.isArray(projection.contexts) || projection.contexts.length === 0
        || projection.shaclBytes === undefined) {
      throw new Error(`projections[${projectionIndex}] is not a modulePath/contexts/shaclBytes tuple`);
    }
    const index = parseIndex(projection.shaclBytes);
    const descriptors = projection.contexts.map((context) => resolveOne(index, context));
    for (const descriptor of descriptors) {
      const key = contextKey(descriptor.context);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ modulePath: projection.modulePath, descriptor, index });
    }
  }

  const resolved = [];
  for (const [key, emissions] of [...groups].sort((left, right) => byteCompare(left[0], right[0]))) {
    const first = emissions[0];
    if (emissions.some((emission) => (
      canonicalJcs(emission.descriptor.context) !== canonicalJcs(first.descriptor.context)
        || emission.descriptor.executionKind !== first.descriptor.executionKind
    ))) {
      throw new ShaclDescriptorResolutionError(
        'M2_SHACL_DESCRIPTOR_CONTEXT_DRIFT',
        first.descriptor.context,
        emissions.map((emission) => emission.modulePath),
      );
    }
    if (first.descriptor.executionKind === 'custom') {
      resolved.push(Object.freeze({
        ...first.descriptor,
        emittedBy: Object.freeze(emissions.map((emission) => emission.modulePath).sort(byteCompare)),
      }));
      continue;
    }
    if (emissions.some((emission) => (
      emission.descriptor.shapeRef !== first.descriptor.shapeRef
        || emission.descriptor.shapeKind !== first.descriptor.shapeKind
        || emission.descriptor.componentPredicate !== first.descriptor.componentPredicate
    ))) {
      throw new ShaclDescriptorResolutionError(
        'M2_SHACL_DESCRIPTOR_GLOBAL_AMBIGUOUS',
        first.descriptor.context,
        emissions.map((emission) => `${emission.modulePath}:${emission.descriptor.shapeRef}`),
      );
    }
    const closures = [];
    for (const emission of emissions) {
      closures.push(await canonicalizeSelectedClosure(emission.index, emission.descriptor));
    }
    if (closures.some((closure) => closure.canonicalNQuads !== closures[0].canonicalNQuads)) {
      throw new ShaclDescriptorResolutionError(
        'M2_SHACL_DESCRIPTOR_RDFC_DRIFT',
        first.descriptor.context,
        emissions.map((emission, index) => (
          `${emission.modulePath}:${closures[index].digest}`
        )),
      );
    }
    resolved.push(Object.freeze({
      ...first.descriptor,
      emittedBy: Object.freeze(emissions.map((emission) => emission.modulePath).sort(byteCompare)),
      semanticClosure: Object.freeze(closures[0]),
    }));
  }
  return resolved;
}

module.exports = {
  COMPONENT_PREDICATES,
  CUSTOM_COMPONENT,
  SH,
  ShaclDescriptorResolutionError,
  canonicalizeSelectedClosure,
  contextKey,
  parseIndex,
  resolveGlobalShaclExecutionDescriptors,
  resolveShaclExecutionDescriptors,
  selectedComponentClosure,
};
