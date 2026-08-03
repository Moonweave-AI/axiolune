'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const {
  projectShaclWithInventory,
} = require('../generate-m2-shacl.cjs');
const {
  CUSTOM_COMPONENT,
  SH,
  resolveGlobalShaclExecutionDescriptors,
  resolveShaclExecutionDescriptors,
} = require('../lib/m2-shacl-instance-descriptor.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FINANCE = path.join(ROOT, 'ontology', 'domain', 'finance');

function modules() {
  return fs.readdirSync(FINANCE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(FINANCE, entry.name, 'module.yaml'))
    .filter((file) => fs.existsSync(file))
    .sort();
}

test('every current normalized SHACL context resolves one exact projected shape component', async () => {
  let resolvedCount = 0;
  let customCount = 0;
  let authoredXoneCount = 0;
  let authoredSparqlCount = 0;

  for (const file of modules()) {
    const projection = await projectShaclWithInventory(
      yaml.load(fs.readFileSync(file, 'utf8')),
    );
    const descriptors = resolveShaclExecutionDescriptors({
      contexts: projection.contexts,
      shaclBytes: projection.bytes,
    });
    assert.equal(descriptors.length, projection.contexts.length);
    for (const descriptor of descriptors) {
      resolvedCount += 1;
      if (descriptor.executionKind === 'custom') {
        customCount += 1;
        assert.equal(descriptor.context.component, CUSTOM_COMPONENT);
        continue;
      }
      assert.match(descriptor.shapeRef, /^(?:https?|urn):/u);
      assert.match(descriptor.componentPredicate, new RegExp(`^${SH}`, 'u'));
      if (descriptor.context.originKind === 'constraintDefinition'
          && descriptor.context.component === `${SH}XoneConstraintComponent`) {
        authoredXoneCount += 1;
        assert.equal(descriptor.shapeRef, `${descriptor.context.originRef}/shape`);
      }
      if (descriptor.context.originKind === 'constraintDefinition'
          && descriptor.context.component === `${SH}SPARQLConstraintComponent`) {
        authoredSparqlCount += 1;
        assert.equal(descriptor.shapeRef, `${descriptor.context.originRef}/shape`);
      }
    }
  }

  assert.ok(resolvedCount > 10_000);
  assert.ok(customCount > 100);
  assert.ok(authoredXoneCount > 30);
  assert.ok(authoredSparqlCount >= 1);
});

test('descriptor resolution fails closed when one context matches two shapes', () => {
  const target = 'https://example.test/Target';
  const pathIri = 'https://example.test/value';
  const ttl = `
    @prefix sh: <${SH}> .
    @prefix ex: <https://example.test/> .
    ex:TargetShape a sh:NodeShape ;
      sh:targetClass ex:Target ;
      sh:property ex:one, ex:two .
    ex:one a sh:PropertyShape ; sh:path ex:value ; sh:minCount 1 .
    ex:two a sh:PropertyShape ; sh:path ex:value ; sh:minCount 1 .
  `;
  assert.throws(
    () => resolveShaclExecutionDescriptors({
      shaclBytes: Buffer.from(ttl, 'utf8'),
      contexts: [{
        originKind: 'generatedConstraint',
        originRef: pathIri,
        targetRef: target,
        pathKind: 'iri',
        path: pathIri,
        component: `${SH}MinCountConstraintComponent`,
        severity: 'violation',
        generatedOrAuthored: 'generated',
      }],
    }),
    (cause) => cause.code === 'M2_SHACL_DESCRIPTOR_AMBIGUOUS'
      && cause.candidates.length === 2,
  );
});

test('descriptor resolution fails closed when a manifest component is absent', () => {
  const target = 'https://example.test/Target';
  const ttl = `
    @prefix sh: <${SH}> .
    @prefix ex: <https://example.test/> .
    ex:TargetShape a sh:NodeShape ; sh:targetClass ex:Target .
  `;
  assert.throws(
    () => resolveShaclExecutionDescriptors({
      shaclBytes: Buffer.from(ttl, 'utf8'),
      contexts: [{
        originKind: 'generatedConstraint',
        originRef: target,
        targetRef: target,
        component: `${SH}NodeKindConstraintComponent`,
        severity: 'violation',
        generatedOrAuthored: 'generated',
      }],
    }),
    (cause) => cause.code === 'M2_SHACL_DESCRIPTOR_MISSING'
      && cause.candidates.length === 0,
  );
});

function xoneProjection(modulePath, labels, maxCount = 1) {
  const target = 'https://example.test/Target';
  const constraint = 'https://example.test/XoneRule';
  const pathIri = 'https://example.test/value';
  return {
    modulePath,
    contexts: [{
      originKind: 'constraintDefinition',
      originRef: constraint,
      targetRef: target,
      component: `${SH}XoneConstraintComponent`,
      severity: 'violation',
      generatedOrAuthored: 'authored',
    }],
    shaclBytes: Buffer.from(`
      @prefix sh: <${SH}> .
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix ex: <https://example.test/> .
      <https://example.test/XoneRule/shape> a sh:NodeShape ;
        sh:targetClass ex:Target ;
        sh:xone _:${labels.list} .
      _:${labels.list} rdf:first ex:branch ; rdf:rest rdf:nil .
      ex:branch a sh:NodeShape ; sh:property _:${labels.property} .
      _:${labels.property} a sh:PropertyShape ;
        sh:path ex:value ; sh:minCount 1 ; sh:maxCount ${maxCount} .
    `, 'utf8'),
  };
}

test('global descriptor closure treats blank-node relabeling as one RDFC-1.0 emission', async () => {
  const descriptors = await resolveGlobalShaclExecutionDescriptors({
    projections: [
      xoneProjection('module-a.yaml', { list: 'a_list', property: 'a_property' }),
      xoneProjection('module-b.yaml', { list: 'b_list', property: 'b_property' }),
    ],
  });
  assert.equal(descriptors.length, 1);
  assert.deepEqual(descriptors[0].emittedBy, ['module-a.yaml', 'module-b.yaml']);
  assert.equal(descriptors[0].semanticClosure.algorithm, 'RDFC-1.0');
  assert.equal(descriptors[0].semanticClosure.packageVersion, '5.0.0');
  assert.match(descriptors[0].semanticClosure.digest, /^sha256:[0-9a-f]{64}$/u);
});

test('global descriptor closure fails closed on semantic drift behind blank nodes', async () => {
  await assert.rejects(
    resolveGlobalShaclExecutionDescriptors({
      projections: [
        xoneProjection('module-a.yaml', { list: 'a_list', property: 'a_property' }),
        xoneProjection('module-b.yaml', { list: 'b_list', property: 'b_property' }, 2),
      ],
    }),
    (cause) => cause.code === 'M2_SHACL_DESCRIPTOR_RDFC_DRIFT'
      && cause.candidates.length === 2,
  );
});
