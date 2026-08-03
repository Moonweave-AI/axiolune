#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const { Parser } = require('n3');

const {
  FACT_IDENTITY,
  FACT_VERSION,
  VERSION_OF,
  compileReferenceBindingIndex,
} = require('../lib/reference-identity-materializer.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNNER = path.join(ROOT, 'scripts', 'domain', 'run-domain-shacl.cjs');
const FINANCE = path.join(ROOT, 'ontology', 'domain', 'finance');
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const YAML_SCHEMA = yaml.CORE_SCHEMA.withTags(yaml.mergeTag);
const MODULE_FIXTURES = new Map([
  ['orders-execution', [
    'tests/m2/fixtures/positive/orders-execution-positive.yaml',
    'tests/m2/fixtures/negative/orders-execution-negative.yaml',
  ]],
  ['portfolio-positions', [
    'tests/m2/fixtures/positive/portfolio-positions-positive.yaml',
    'tests/m2/fixtures/negative/portfolio-positions-negative.yaml',
  ]],
  ['market-structure', [
    'tests/m2/fixtures/positive/market-structure-positive.yaml',
    'tests/m2/fixtures/negative/market-structure-negative.yaml',
  ]],
  ['market-data', [
    'tests/m2/fixtures/positive/market-data-positive.yaml',
    'tests/m2/fixtures/negative/market-data-negative.yaml',
  ]],
  ['strategy-research', [
    'tests/m2/fixtures/positive/strategy-research-positive.yaml',
    'tests/m2/fixtures/positive/factor-observation-revision.yaml',
    'tests/m2/fixtures/negative/strategy-research-negative.yaml',
    'tests/m2/fixtures/negative/factor-observation-revision-negative.yaml',
  ]],
  ['market-rules', [
    'tests/m2/fixtures/positive/rule-applicability-cn-market.yaml',
    'tests/m2/fixtures/negative/rule-applicability-cn-market-negative.yaml',
  ]],
]);
const EXPECTED_EXECUTION_COUNTS = new Map([
  ['orders-execution', { fixtures: 16, references: 135, exact: 65, logical: 70 }],
  ['portfolio-positions', { fixtures: 16, references: 100, exact: 46, logical: 54 }],
  ['market-structure', { fixtures: 5, references: 17, exact: 12, logical: 5 }],
  ['market-data', { fixtures: 22, references: 116, exact: 90, logical: 26 }],
  ['strategy-research', { fixtures: 19, references: 130, exact: 73, logical: 57 }],
  ['market-rules', { fixtures: 5, references: 25, exact: 25, logical: 0 }],
]);

function loadYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'), { schema: YAML_SCHEMA });
}

function fixtureIds(moduleName) {
  return MODULE_FIXTURES.get(moduleName).flatMap((relative) => (
    loadYaml(path.join(ROOT, relative)).fixtures
      .filter((fixture) => fixture.validationEngine !== 'pit')
      .map((fixture) => fixture.id)
  ));
}

function objects(quads, subject, predicate) {
  return quads
    .filter((quad) => quad.subject.value === subject && quad.predicate.value === predicate)
    .map((quad) => quad.object.value);
}

function has(quads, subject, predicate, object) {
  return quads.some((quad) => (
    quad.subject.value === subject
      && quad.predicate.value === predicate
      && quad.object.value === object
  ));
}

function subjectsWithType(quads, typeIri) {
  return [...new Set(quads
    .filter((quad) => quad.predicate.value === RDF_TYPE && quad.object.value === typeIri)
    .map((quad) => quad.subject.value))];
}

function typeSuperClosure(moduleDocument) {
  const definitions = [
    ...Object.values(moduleDocument.domain.objectTypes || {}),
    ...Object.values(moduleDocument.domain.associationTypes || {}),
  ];
  const byIri = new Map(definitions.map((definition) => [definition.iri, definition]));
  const memo = new Map();
  function visit(typeIri, active = new Set()) {
    if (memo.has(typeIri)) return memo.get(typeIri);
    assert.equal(active.has(typeIri), false, `cyclic type hierarchy at ${typeIri}`);
    active.add(typeIri);
    const result = new Set();
    for (const superType of byIri.get(typeIri)?.superTypes || []) {
      result.add(superType);
      for (const ancestor of visit(superType, active)) result.add(ancestor);
    }
    active.delete(typeIri);
    memo.set(typeIri, result);
    return result;
  }
  for (const typeIri of byIri.keys()) visit(typeIri);
  return memo;
}

function auditFixtureIdentityClosure(moduleName, moduleDocument, index, file) {
  const quads = new Parser().parse(fs.readFileSync(file, 'utf8'));
  const superClosure = typeSuperClosure(moduleDocument);
  let references = 0;
  let exact = 0;
  let logical = 0;

  for (const quad of quads) {
    const pathIri = quad.predicate.value;
    if (!index.hasPath(pathIri)) continue;
    assert.equal(quad.object.termType, 'NamedNode', `${file}: ${pathIri} value must be an IRI`);
    const ownerTypes = new Set(objects(quads, quad.subject.value, RDF_TYPE));
    const matches = index.rows.filter((row) => (
      row.path === pathIri && ownerTypes.has(row.subjectType)
    ));
    assert.equal(
      matches.length,
      1,
      `${file}: ${quad.subject.value} ${pathIri} must resolve to one source binding`,
    );
    const binding = matches[0];
    const value = quad.object.value;
    references++;

    if (binding.mode === 'exact') {
      exact++;
      assert.equal(has(quads, value, RDF_TYPE, binding.expectedType), true, `${value}: authored type`);
      assert.equal(has(quads, value, RDF_TYPE, FACT_VERSION), true, `${value}: FactVersion`);
      assert.equal(has(quads, value, RDF_TYPE, FACT_IDENTITY), false, `${value}: not FactIdentity`);
      const identityTargets = [...new Set(objects(quads, value, VERSION_OF))];
      assert.equal(identityTargets.length, 1, `${value}: exactly one versionOf`);
      const identity = identityTargets[0];
      const identityCompanions = [...new Set(objects(quads, identity, RDF_TYPE)
        .filter((typeIri) => typeIri.endsWith('/LogicalIdentity')))];
      assert.equal(identityCompanions.length, 1, `${identity}: one concrete logical-identity companion`);
      const concreteType = identityCompanions[0].slice(0, -'/LogicalIdentity'.length);
      assert.equal(has(quads, value, RDF_TYPE, concreteType), true, `${value}: concrete authored type`);
      assert.equal(
        concreteType === binding.expectedType
          || (superClosure.get(concreteType) || new Set()).has(binding.expectedType),
        true,
        `${concreteType} must satisfy exact range ${binding.expectedType}`,
      );
      assert.equal(has(quads, identity, RDF_TYPE, FACT_IDENTITY), true, `${identity}: FactIdentity`);
      assert.equal(has(quads, identity, RDF_TYPE, FACT_VERSION), false, `${identity}: not FactVersion`);
      assert.equal(objects(quads, identity, VERSION_OF).length, 0, `${identity}: no versionOf`);
    } else {
      logical++;
      assert.equal(
        has(quads, value, RDF_TYPE, `${binding.expectedType}/LogicalIdentity`),
        true,
        `${value}: expected logical-identity companion`,
      );
      assert.equal(has(quads, value, RDF_TYPE, FACT_IDENTITY), true, `${value}: FactIdentity`);
      assert.equal(has(quads, value, RDF_TYPE, binding.expectedType), false, `${value}: no authored version type`);
      assert.equal(has(quads, value, RDF_TYPE, FACT_VERSION), false, `${value}: no FactVersion`);
      assert.equal(objects(quads, value, VERSION_OF).length, 0, `${value}: no versionOf`);
    }
  }

  // Audit the whole emitted graph, not only nodes reached from a reference edge.
  // This catches incomplete standalone TemporalFact closures and identity/version
  // role mixing even when a fixture happens not to reference those nodes.
  for (const version of subjectsWithType(quads, FACT_VERSION)) {
    assert.equal(has(quads, version, RDF_TYPE, FACT_IDENTITY), false, `${version}: version is not identity`);
    const identityTargets = [...new Set(objects(quads, version, VERSION_OF))];
    assert.equal(identityTargets.length, 1, `${version}: graph-wide exactly one versionOf`);
    const identity = identityTargets[0];
    assert.equal(has(quads, identity, RDF_TYPE, FACT_IDENTITY), true, `${identity}: graph-wide FactIdentity`);
    assert.equal(has(quads, identity, RDF_TYPE, FACT_VERSION), false, `${identity}: graph-wide not FactVersion`);
    assert.equal(objects(quads, identity, VERSION_OF).length, 0, `${identity}: graph-wide no versionOf`);
  }

  for (const identity of subjectsWithType(quads, FACT_IDENTITY)) {
    assert.equal(has(quads, identity, RDF_TYPE, FACT_VERSION), false, `${identity}: identity is not version`);
    assert.equal(objects(quads, identity, VERSION_OF).length, 0, `${identity}: identity has no versionOf`);
  }

  return { references, exact, logical };
}

test('all six domain SHACL builders execute fresh pySHACL and materialize complete identity closure', {
  timeout: 180_000,
}, (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-shacl-reference-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const totals = { fixtures: 0, references: 0, exact: 0, logical: 0 };

  for (const moduleName of MODULE_FIXTURES.keys()) {
    const output = path.join(temporaryRoot, moduleName);
    const execution = spawnSync(process.execPath, [
      RUNNER,
      '--module', moduleName,
      '--output-dir', output,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(
      execution.status,
      0,
      `${moduleName} fresh pySHACL failed\n${execution.stdout || ''}\n${execution.stderr || ''}`,
    );

    const moduleFile = path.join(FINANCE, moduleName, 'module.yaml');
    const moduleDocument = loadYaml(moduleFile);
    const index = compileReferenceBindingIndex(moduleDocument, moduleName);
    const ids = fixtureIds(moduleName);
    assert.ok(ids.length > 0, `${moduleName}: canonical fixture ids`);
    const moduleCounts = { fixtures: 0, references: 0, exact: 0, logical: 0 };
    for (const id of ids) {
      const fixtureFile = path.join(output, `${id}.ttl`);
      assert.equal(fs.existsSync(fixtureFile), true, `${moduleName}: ${id}.ttl`);
      const counts = auditFixtureIdentityClosure(moduleName, moduleDocument, index, fixtureFile);
      totals.fixtures++;
      totals.references += counts.references;
      totals.exact += counts.exact;
      totals.logical += counts.logical;
      moduleCounts.fixtures++;
      moduleCounts.references += counts.references;
      moduleCounts.exact += counts.exact;
      moduleCounts.logical += counts.logical;
    }
    assert.deepEqual(moduleCounts, EXPECTED_EXECUTION_COUNTS.get(moduleName), moduleName);
  }

  assert.deepEqual(totals, { fixtures: 83, references: 523, exact: 311, logical: 212 });
});
