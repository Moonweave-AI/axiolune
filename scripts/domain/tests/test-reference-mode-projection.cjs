#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const { Parser, Store } = require('n3');
const SHACLValidator = require('rdf-validate-shacl').default;

const {
  projectOwl,
} = require('../generate-m2-owl.cjs');
const {
  CUSTOM_CONSTRAINT_COMPONENT,
  EXACT_VERSION_REFERENCE,
  LOGICAL_REFERENCE,
  SHACL_COMPONENT,
  projectShaclWithInventory,
} = require('../generate-m2-shacl.cjs');
const {
  FACT_IDENTITY,
  FACT_VERSION,
  NS,
  PATTERNS,
  VERSION_OF,
  rolePredicate,
} = require('../lib/typed-projection-common.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FINANCE = path.join(ROOT, 'ontology', 'domain', 'finance');

function modules() {
  return fs.readdirSync(FINANCE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      file: path.join(FINANCE, entry.name, 'module.yaml'),
    }))
    .filter((entry) => fs.existsSync(entry.file))
    .sort((left, right) => Buffer.compare(
      Buffer.from(left.name, 'utf8'),
      Buffer.from(right.name, 'utf8'),
    ))
    .map((entry) => ({
      ...entry,
      document: yaml.load(fs.readFileSync(entry.file, 'utf8')),
    }));
}

function referenceMode(constraintRef) {
  if (constraintRef === EXACT_VERSION_REFERENCE) return 'exact';
  if (constraintRef === LOGICAL_REFERENCE) return 'logical';
  return null;
}

function sourceBindings(document) {
  const rows = [];
  for (const association of Object.values(document.domain.associationTypes)) {
    for (const role of association.participantRoles) {
      const pathIri = rolePredicate(association.iri, role.id);
      const matches = document.domain.constraintBindings.filter((binding) => (
        binding.targetElement === pathIri && referenceMode(binding.constraintRef)
      ));
      assert.equal(matches.length, 1, `${pathIri} must have one reference-mode binding`);
      rows.push({
        constraintRef: matches[0].constraintRef,
        mode: referenceMode(matches[0].constraintRef),
        targetRef: association.iri,
        path: pathIri,
        expectedType: role.range,
        sourceKind: 'participantRole',
      });
    }
  }
  for (const use of document.domain.relationUses) {
    const matches = (use.constraints || []).filter((binding) => (
      referenceMode(binding.constraintRef)
    ));
    assert.equal(matches.length, 1, `${use.relation} must have one reference-mode binding`);
    assert.equal(matches[0].targetElement, use.relation);
    rows.push({
      constraintRef: matches[0].constraintRef,
      mode: referenceMode(matches[0].constraintRef),
      targetRef: use.subjectType,
      path: use.relation,
      expectedType: use.objectType,
      sourceKind: 'relationUse',
    });
  }
  return rows;
}

function parse(bytes) {
  return new Parser().parse(bytes.toString('utf8'));
}

function objects(quads, subject, predicate) {
  return quads
    .filter((quad) => quad.subject.value === subject && quad.predicate.value === predicate)
    .map((quad) => quad.object);
}

function has(quads, subject, predicate, object) {
  return quads.some((quad) => (
    quad.subject.value === subject
      && quad.predicate.value === predicate
      && quad.object.value === object
  ));
}

function sourceKey(row) {
  return `${row.constraintRef || row.originRef}\0${row.targetRef}\0${row.path}`;
}

test('all ten modules compile exactly 349 exact and 121 logical source bindings', async () => {
  const discovered = modules();
  assert.equal(discovered.length, 10);
  const allSources = [];
  const allContexts = [];
  let referenceNodeTriples = 0;

  for (const module of discovered) {
    const sources = sourceBindings(module.document);
    const projected = await projectShaclWithInventory(module.document);
    const quads = parse(projected.bytes);
    allSources.push(...sources);
    allContexts.push(...projected.contexts);

    for (const source of sources) {
      const expectedShape = `${source.expectedType}/shape/reference/${source.mode}`;
      const propertyShapes = quads
        .filter((quad) => (
          quad.predicate.value === `${NS.SH}path` && quad.object.value === source.path
        ))
        .map((quad) => quad.subject.value)
        .filter((shapeIri) => has(quads, shapeIri, `${NS.SH}node`, expectedShape));
      assert.equal(
        propertyShapes.length,
        1,
        `${module.name}: ${source.path} must compile to one ${source.mode} node shape`,
      );
    }
    referenceNodeTriples += quads.filter((quad) => (
      quad.predicate.value === `${NS.SH}node`
        && /\/shape\/reference\/(?:exact|logical)$/u.test(quad.object.value)
    )).length;
  }

  assert.equal(allSources.length, 470);
  assert.equal(allSources.filter((row) => row.mode === 'exact').length, 349);
  assert.equal(allSources.filter((row) => row.mode === 'logical').length, 121);
  assert.equal(new Set(allSources.map(sourceKey)).size, 470);
  assert.equal(referenceNodeTriples, 470);
  assert.deepEqual(
    allSources.filter((row) => (
      row.path === 'https://axiolune.ai/ontology/finance/foundation/identifierSchemeMaintainer'
    )),
    [{
      constraintRef: LOGICAL_REFERENCE,
      mode: 'logical',
      targetRef: 'https://axiolune.ai/ontology/finance/foundation/IdentifierScheme',
      path: 'https://axiolune.ai/ontology/finance/foundation/identifierSchemeMaintainer',
      expectedType: 'https://axiolune.ai/ontology/finance/foundation/IdentifierAuthority',
      sourceKind: 'relationUse',
    }],
  );

  const referenceContexts = allContexts.filter((entry) => (
    entry.originKind === 'constraintDefinition'
      && referenceMode(entry.originRef)
      && entry.component === SHACL_COMPONENT.node
      && Object.hasOwn(entry, 'path')
  ));
  assert.equal(referenceContexts.length, 470);
  assert.equal(referenceContexts.filter((entry) => (
    entry.originRef === EXACT_VERSION_REFERENCE
  )).length, 349);
  assert.equal(referenceContexts.filter((entry) => (
    entry.originRef === LOGICAL_REFERENCE
  )).length, 121);
  assert.deepEqual(
    new Set(referenceContexts.map(sourceKey)),
    new Set(allSources.map(sourceKey)),
  );
  assert.equal(allContexts.some((entry) => (
    referenceMode(entry.originRef) && entry.component === CUSTOM_CONSTRAINT_COMPONENT
  )), false);
});

test('OWL emits two-level identity companions and mode-specific ranges for every source binding', async () => {
  const discovered = modules();
  let concreteVersioned = 0;
  let abstractVersioned = 0;
  let checkedBindings = 0;

  for (const module of discovered) {
    const document = module.document;
    const quads = parse(await projectOwl(document));
    for (const container of ['objectTypes', 'associationTypes']) {
      for (const element of Object.values(document.domain[container])) {
        if (!(element.patternBindings || []).some((binding) => (
          binding.pattern === PATTERNS.temporal
        ))) continue;
        assert.equal(has(
          quads,
          element.iri,
          `${NS.RDFS}subClassOf`,
          FACT_VERSION,
        ), true);
        const companion = `${element.iri}/LogicalIdentity`;
        if (element.abstract === true) {
          abstractVersioned += 1;
          assert.equal(has(quads, companion, `${NS.RDF}type`, `${NS.OWL}Class`), false);
          continue;
        }
        concreteVersioned += 1;
        assert.equal(has(quads, companion, `${NS.RDF}type`, `${NS.OWL}Class`), true);
        assert.equal(has(quads, companion, `${NS.RDFS}subClassOf`, FACT_IDENTITY), true);
        assert.equal(has(quads, companion, `${NS.OWL}disjointWith`, FACT_VERSION), true);
        const restrictions = objects(quads, element.iri, `${NS.RDFS}subClassOf`)
          .filter((term) => term.termType === 'BlankNode')
          .map((term) => term.value)
          .filter((subject) => (
            has(quads, subject, `${NS.OWL}onProperty`, VERSION_OF)
              && has(quads, subject, `${NS.OWL}onClass`, companion)
              && has(quads, subject, `${NS.OWL}qualifiedCardinality`, '1')
          ));
        assert.equal(restrictions.length, 1, `${element.iri} versionOf companion restriction`);
      }
    }

    for (const source of sourceBindings(document)) {
      checkedBindings += 1;
      const expectedRange = source.mode === 'logical'
        ? `${source.expectedType}/LogicalIdentity`
        : source.expectedType;
      assert.deepEqual(
        objects(quads, source.path, `${NS.RDFS}range`).map((term) => term.value),
        [expectedRange],
        `${source.path} global range`,
      );
      const restrictions = objects(quads, source.targetRef, `${NS.RDFS}subClassOf`)
        .filter((term) => term.termType === 'BlankNode')
        .map((term) => term.value)
        .filter((subject) => (
          has(quads, subject, `${NS.OWL}onProperty`, source.path)
            && has(quads, subject, `${NS.OWL}onClass`, expectedRange)
        ));
      assert.ok(restrictions.length >= 1, `${source.targetRef} must restrict ${source.path}`);
    }
  }

  assert.equal(concreteVersioned, 154);
  assert.equal(abstractVersioned, 1);
  assert.equal(checkedBindings, 470);
});

function referenceOnlyExecutionShapes(quads, selectedPaths) {
  const execution = 'https://axiolune.ai/ontology/finance/orders-execution/Execution';
  const ownerShape = `${execution}Shape`;
  const selectedPropertyShapes = new Set(
    quads
      .filter((quad) => (
        quad.predicate.value === `${NS.SH}path` && selectedPaths.has(quad.object.value)
      ))
      .map((quad) => quad.subject.value)
      .filter((shapeIri) => has(quads, ownerShape, `${NS.SH}property`, shapeIri)),
  );
  assert.equal(selectedPropertyShapes.size, selectedPaths.size);

  const kept = quads.filter((quad) => (
    quad.subject.value === ownerShape
      && (
        quad.predicate.value === `${NS.RDF}type`
          || quad.predicate.value === `${NS.SH}targetClass`
          || (quad.predicate.value === `${NS.SH}property`
            && selectedPropertyShapes.has(quad.object.value))
      )
  ));
  const queue = [...selectedPropertyShapes];
  const visited = new Set();
  while (queue.length > 0) {
    const subject = queue.shift();
    if (visited.has(subject)) continue;
    visited.add(subject);
    for (const quad of quads.filter((candidate) => candidate.subject.value === subject)) {
      kept.push(quad);
      if ([`${NS.SH}node`, `${NS.SH}not`, `${NS.SH}property`].includes(quad.predicate.value)) {
        queue.push(quad.object.value);
      }
    }
  }
  return new Store(kept);
}

function executionData(options = {}) {
  const ORDERS = 'https://axiolune.ai/ontology/finance/orders-execution/';
  const FOUNDATION = 'https://axiolune.ai/ontology/finance/foundation/';
  const streamTypes = [`<${ORDERS}OrderEventStream>`];
  if (options.streamFactVersion !== false) streamTypes.push(`<${FACT_VERSION}>`);
  const accountTypes = [`<${FACT_IDENTITY}>`];
  if (options.accountCompanion !== false) {
    accountTypes.push(`<${FOUNDATION}FinancialAccount/LogicalIdentity>`);
  }
  if (options.accountFactVersion === true) accountTypes.push(`<${FACT_VERSION}>`);
  return new Store(new Parser().parse(`
    @prefix rdf: <${NS.RDF}> .
    <urn:execution:1> rdf:type <${ORDERS}Execution> ;
      <${ORDERS}Execution/role/executionStream> <urn:stream:1:version:1> ;
      <${ORDERS}Execution/role/executionAccount> <urn:account:1> .
    <urn:stream:1:version:1> rdf:type ${streamTypes.join(', ')}
      ${options.streamVersionOf === false ? '.' : `; <${VERSION_OF}> <urn:stream:1> .`}
    <urn:stream:1> rdf:type <${FACT_IDENTITY}>, <${ORDERS}OrderEventStream/LogicalIdentity> .
    <urn:account:1> rdf:type ${accountTypes.join(', ')}
      ${options.accountVersionOf === true ? `; <${VERSION_OF}> <urn:account:root> .` : '.'}
  `));
}

test('orders Execution exact stream and logical account shapes execute positive and fail-closed RDF vectors', async () => {
  const orders = modules().find((entry) => entry.name === 'orders-execution');
  const projected = await projectShaclWithInventory(orders.document);
  const streamPath =
    'https://axiolune.ai/ontology/finance/orders-execution/Execution/role/executionStream';
  const accountPath =
    'https://axiolune.ai/ontology/finance/orders-execution/Execution/role/executionAccount';
  const shapes = referenceOnlyExecutionShapes(parse(projected.bytes), new Set([
    streamPath,
    accountPath,
  ]));
  const validator = new SHACLValidator(shapes);

  const positive = await validator.validate(executionData());
  assert.equal(
    positive.conforms,
    true,
    positive.results.map((result) => (
      `${result.sourceConstraintComponent?.value} ${result.focusNode?.value} ${result.path?.value}`
    )).join('\n'),
  );
  for (const negative of [
    { streamFactVersion: false },
    { streamVersionOf: false },
    { accountCompanion: false },
    { accountFactVersion: true },
    { accountVersionOf: true },
  ]) {
    const report = await validator.validate(executionData(negative));
    assert.equal(report.conforms, false, JSON.stringify(negative));
  }
});
