'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  CUSTOM_COMPONENT,
  SH,
} = require('../lib/m2-shacl-instance-descriptor.cjs');
const {
  compileShaclInstanceFixtures,
} = require('../lib/m2-shacl-instance-fixture-compiler.cjs');
const {
  ShaclInstanceExecutionError,
  EXPECTED_RDFLIB_VERSION,
  PERMISSION_ASSURANCE,
  WORKER_PATH,
  assembleShaclExpectationEntries,
  executeShaclInstanceFixtures,
  probePython,
  validateWorkerResponse,
} = require('../lib/m2-shacl-instance-executor.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');

const TARGET = 'https://example.test/Target';
const PATH = 'https://example.test/value';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function projection(includeCustom = true) {
  const contexts = [{
    originKind: 'generatedConstraint',
    originRef: PATH,
    targetRef: TARGET,
    pathKind: 'iri',
    path: PATH,
    component: `${SH}MinCountConstraintComponent`,
    severity: 'violation',
    generatedOrAuthored: 'generated',
  }];
  if (includeCustom) {
    contexts.push({
      originKind: 'constraintDefinition',
      originRef: 'https://example.test/CustomRule',
      targetRef: TARGET,
      component: CUSTOM_COMPONENT,
      severity: 'violation',
      generatedOrAuthored: 'authored',
    });
  }
  return {
    modulePath: 'ontology/domain/finance/example/module.yaml',
    contexts,
    shaclBytes: Buffer.from(`
      @prefix sh: <${SH}> .
      @prefix ex: <https://example.test/> .
      ex:TargetShape a sh:NodeShape ;
        sh:targetClass ex:Target ;
        sh:property ex:valueShape .
      ex:valueShape a sh:PropertyShape ;
        sh:path ex:value ;
        sh:minCount 1 .
    `, 'utf8'),
  };
}

function inProjection() {
  return {
    modulePath: 'ontology/domain/finance/example/module.yaml',
    contexts: [{
      originKind: 'generatedConstraint',
      originRef: PATH,
      targetRef: TARGET,
      pathKind: 'iri',
      path: PATH,
      component: `${SH}InConstraintComponent`,
      severity: 'violation',
      generatedOrAuthored: 'generated',
    }],
    shaclBytes: Buffer.from(`
      @prefix sh: <${SH}> .
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix ex: <https://example.test/> .
      ex:TargetShape a sh:NodeShape ; sh:targetClass ex:Target ; sh:property ex:valueShape .
      ex:valueShape a sh:PropertyShape ; sh:path ex:value ; sh:in ( "allowed" ) .
    `, 'utf8'),
  };
}

function nodeKindProjection() {
  return {
    modulePath: 'ontology/domain/finance/example/module.yaml',
    contexts: [{
      originKind: 'generatedConstraint',
      originRef: TARGET,
      targetRef: TARGET,
      component: `${SH}NodeKindConstraintComponent`,
      severity: 'violation',
      generatedOrAuthored: 'generated',
    }],
    shaclBytes: Buffer.from(`
      @prefix sh: <${SH}> .
      @prefix ex: <https://example.test/> .
      ex:TargetShape a sh:NodeShape ; sh:targetClass ex:Target ; sh:nodeKind sh:IRI .
    `, 'utf8'),
  };
}

function rebuildAggregate(artifact, mutate) {
  const value = JSON.parse(canonicalJcs(artifact.value));
  mutate(value);
  const bytes = Buffer.from(canonicalJcs(value), 'utf8');
  return Object.freeze({ value, bytes, digest: sha256(bytes) });
}

function withAggregate(compilation, polarity, aggregate) {
  return Object.freeze({ ...compilation, [polarity]: aggregate });
}

test('compiler emits deterministic isolated RDFC fixtures and preserves Custom as unresolved', async () => {
  const left = await compileShaclInstanceFixtures({ projections: [projection()] });
  const right = await compileShaclInstanceFixtures({ projections: [projection()] });
  assert.equal(left.outcome, 'incomplete');
  assert.equal(left.descriptorCount, 2);
  assert.equal(left.shaclCount, 1);
  assert.equal(left.customCount, 1);
  assert.equal(left.custom[0].resolution, 'unresolved-custom-capability');
  assert.equal(left.positive.digest, right.positive.digest);
  assert.equal(left.negative.digest, right.negative.digest);
  assert.ok(left.positive.bytes.equals(right.positive.bytes));
  assert.ok(left.negative.bytes.equals(right.negative.bytes));
  assert.notEqual(left.positive.digest, left.negative.digest);
  assert.match(left.positive.value.cases[0].shapeNQuads, /shacl#targetNode/u);
  assert.match(left.positive.value.cases[0].dataNQuads, new RegExp(PATH, 'u'));
  assert.doesNotMatch(left.negative.value.cases[0].dataNQuads, new RegExp(PATH, 'u'));
});

test('sh:in positive uses an allowed member while only the negative checks non-membership', async () => {
  const compilation = await compileShaclInstanceFixtures({ projections: [inProjection()] });
  const execution = await executeShaclInstanceFixtures(compilation, { timeoutMs: 30_000 });
  assert.equal(execution.value.outcome, 'passed');
  assert.match(compilation.positive.value.cases[0].dataNQuads, /"allowed"/u);
});

test('worker reports a plain RDF 1.1 string focus in explicit xsd:string form', async () => {
  const compilation = await compileShaclInstanceFixtures({ projections: [nodeKindProjection()] });
  const execution = await executeShaclInstanceFixtures(compilation, { timeoutMs: 30_000 });
  assert.equal(execution.value.outcome, 'passed');
  assert.equal(
    execution.value.results[0].negative.results[0].focusNode,
    compilation.negative.value.cases[0].focusNode,
  );
  assert.match(execution.value.results[0].negative.results[0].focusNode, /XMLSchema#string/u);
});

test('pinned pySHACL executes one positive/negative pair and expectation assembly stays partial', async () => {
  const compilation = await compileShaclInstanceFixtures({ projections: [projection()] });
  const execution = await executeShaclInstanceFixtures(compilation, { timeoutMs: 30_000 });
  assert.equal(execution.value.outcome, 'passed');
  assert.deepEqual(execution.value.summary, {
    discovered: 1,
    executed: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    pending: 0,
    caseExecutions: 2,
    engineFailures: 0,
  });
  assert.equal(execution.value.results[0].negative.rootResultCount, 1);
  assert.equal(
    execution.value.results[0].negative.results[0].sourceConstraintComponent,
    `${SH}MinCountConstraintComponent`,
  );
  const assembled = assembleShaclExpectationEntries({
    compilation,
    execution,
    positiveArtifactRef: { kind: 'path', root: 'sourceTree', path: 'fixtures/positive.json' },
    negativeArtifactRef: { kind: 'path', root: 'sourceTree', path: 'fixtures/negative.json' },
    schemaRef: { kind: 'path', root: 'sourceTree', path: 'fixtures/schema.json' },
    schemaDigest: `sha256:${'a'.repeat(64)}`,
  });
  assert.equal(assembled.outcome, 'shacl-verified-custom-unresolved');
  assert.equal(assembled.shaclEntryCount, 1);
  assert.equal(assembled.unresolvedCustomCount, 1);
  assert.equal(assembled.entries[0].positiveExpectation.expectedResult, 'conforms');
  assert.equal(assembled.entries[0].negativeExpectation.expectedResult, 'violates');
});

test('digest tampering is rejected before the SHACL engine starts', async () => {
  const compilation = await compileShaclInstanceFixtures({ projections: [projection(false)] });
  const tampered = Object.freeze({
    ...compilation.positive,
    digest: `sha256:${'0'.repeat(64)}`,
  });
  await assert.rejects(
    executeShaclInstanceFixtures(withAggregate(compilation, 'positive', tampered)),
    (cause) => cause instanceof ShaclInstanceExecutionError
      && cause.code === 'M2_SHACL_EXECUTOR_AGGREGATE_CANONICAL',
  );
});

test('vacuous negative and mismatched expected component are both non-PASS', async () => {
  const base = await compileShaclInstanceFixtures({ projections: [projection(false)] });
  const vacuousNegative = rebuildAggregate(base.negative, (value) => {
    value.cases[0].dataNQuads = base.positive.value.cases[0].dataNQuads;
    value.cases[0].dataDigest = base.positive.value.cases[0].dataDigest;
  });
  const vacuousExecution = await executeShaclInstanceFixtures(
    withAggregate(base, 'negative', vacuousNegative),
    { timeoutMs: 30_000 },
  );
  assert.equal(vacuousExecution.value.outcome, 'failed');
  assert.ok(vacuousExecution.value.findings.some(
    (finding) => finding.code === 'M2_SHACL_INSTANCE_NEGATIVE_VACUOUS',
  ));

  const wrongComponent = rebuildAggregate(base.negative, (value) => {
    value.cases[0].expectedComponent = `${SH}MaxCountConstraintComponent`;
  });
  const componentExecution = await executeShaclInstanceFixtures(
    withAggregate(base, 'negative', wrongComponent),
    { timeoutMs: 30_000 },
  );
  assert.equal(componentExecution.value.outcome, 'failed');
  assert.ok(componentExecution.value.findings.some(
    (finding) => finding.code === 'M2_SHACL_INSTANCE_SOURCE_CONSTRAINT_COMPONENT',
  ));
});

test('RDF/parser engine failure is explicit evidence and never pending or PASS', async () => {
  const base = await compileShaclInstanceFixtures({ projections: [projection(false)] });
  const invalid = rebuildAggregate(base.negative, (value) => {
    value.cases[0].shapeNQuads = 'this is not RDF\n';
    value.cases[0].shapeDigest = sha256(Buffer.from(value.cases[0].shapeNQuads, 'utf8'));
  });
  const execution = await executeShaclInstanceFixtures(
    withAggregate(base, 'negative', invalid),
    { timeoutMs: 30_000 },
  );
  assert.equal(execution.value.outcome, 'failed');
  assert.equal(execution.value.summary.engineFailures, 1);
  assert.equal(execution.value.summary.pending, 0);
  assert.ok(execution.value.findings.some(
    (finding) => finding.code === 'M2_SHACL_INSTANCE_ENGINE_FAILURE',
  ));
});

test('worker response duplicate/missing coverage fails closed at the protocol boundary', () => {
  assert.throws(
    () => validateWorkerResponse({
      schemaVersion: '1.0',
      engine: 'pyshacl',
      engineVersion: '0.26.0',
      rdfEngine: 'rdflib',
      rdfEngineVersion: '7.6.0',
      permissionAssurance: PERMISSION_ASSURANCE,
      results: [],
    }, [{ fixtureId: 'x', constraintInstanceId: 'y', polarity: 'positive' }], {
      pyshaclVersion: '0.26.0',
      rdflibVersion: '7.6.0',
    }),
    (cause) => cause.code === 'M2_SHACL_EXECUTOR_RESULT_COVERAGE',
  );
});

test('worker response rejects RDFLib version drift even when probe and worker collude', () => {
  assert.equal(EXPECTED_RDFLIB_VERSION, '7.6.0');
  assert.throws(
    () => validateWorkerResponse({
      schemaVersion: '1.0',
      engine: 'pyshacl',
      engineVersion: '0.26.0',
      rdfEngine: 'rdflib',
      rdfEngineVersion: '7.7.0',
      permissionAssurance: PERMISSION_ASSURANCE,
      results: [],
    }, [], {
      pyshaclVersion: '0.26.0',
      rdflibVersion: '7.7.0',
    }),
    (cause) => cause.code === 'M2_SHACL_EXECUTOR_RESPONSE_SCHEMA',
  );
});

test('pinned worker records an executed in-process no-network self-test', async () => {
  const compilation = await compileShaclInstanceFixtures({ projections: [projection(false)] });
  const execution = await executeShaclInstanceFixtures(compilation, { timeoutMs: 30_000 });
  assert.deepEqual(execution.value.engine.permissionAssurance, PERMISSION_ASSURANCE);
});

test('worker direct boundary rejects duplicate-member and non-JCS request bytes', () => {
  const runtime = probePython();
  for (const [input, pattern] of [
    ['{"schemaVersion":"1.0","schemaVersion":"1.0"}', /duplicate JSON member/u],
    ['{"schemaVersion": "1.0"}', /not exact RFC 8785 JCS/u],
  ]) {
    const result = spawnSync(runtime.executable, ['-I', WORKER_PATH], {
      cwd: process.cwd(),
      encoding: 'utf8',
      input,
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONHASHSEED: '0',
        PYTHONUTF8: '1',
      },
      shell: false,
      timeout: 15_000,
      windowsHide: true,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, pattern);
  }
});
