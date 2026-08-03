#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Parser, Store, DataFactory } = require('n3');
const SHACLValidator = require('rdf-validate-shacl').default;
const { projectOwl } = require('./generate-m2-owl.cjs');
const { projectShacl } = require('./generate-m2-shacl.cjs');
const {
  BASE,
  loadYaml,
  mutate,
  validateRiskModule,
  validateScenario,
} = require('./lib/risk-v03-contract.cjs');
const {
  verifyModulePublicSymbolTrace,
} = require('./lib/module-public-symbol-trace.cjs');
const {
  authenticateSourceClaims,
} = require('./lib/post-trade-risk-source-artifact-inventory.cjs');

const { namedNode, quad } = DataFactory;
const ROOT = path.resolve(__dirname, '..', '..');
const RISK_FILE = path.join(ROOT, 'ontology', 'domain', 'finance', 'risk', 'module.yaml');
const POSITIVE_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'risk-v03.yaml');
const NEGATIVE_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'negative', 'risk-v03.yaml');
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SH = 'http://www.w3.org/ns/shacl#';

let passed = 0;
let failed = 0;
let pending = 0;

function pass(id, detail) {
  passed += 1;
  console.log(`PASS ${id}: ${detail}`);
}

function fail(id, detail) {
  failed += 1;
  console.error(`FAIL ${id}: ${detail}`);
}

function pend(id, detail) {
  pending += 1;
  console.log(`PENDING ${id}: ${detail}`);
}

function extractXoneShape(quads, targetClass, constraintIri) {
  const source = new Store(quads);
  const result = new Store();
  const targetShape = `${targetClass}Shape`;
  const constraintShape = `${constraintIri}/shape`;
  result.addQuad(quad(
    namedNode(targetShape),
    namedNode(RDF_TYPE),
    namedNode(`${SH}NodeShape`),
  ));
  result.addQuad(quad(
    namedNode(targetShape),
    namedNode(`${SH}targetClass`),
    namedNode(targetClass),
  ));
  result.addQuad(quad(
    namedNode(targetShape),
    namedNode(`${SH}node`),
    namedNode(constraintShape),
  ));

  const queue = [namedNode(constraintShape)];
  const visited = new Set();
  while (queue.length > 0) {
    const subject = queue.shift();
    const key = `${subject.termType}\0${subject.value}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const statement of source.getQuads(subject, null, null, null)) {
      result.addQuad(statement);
      const object = statement.object;
      if (object.termType === 'BlankNode'
          || (object.termType === 'NamedNode' && object.value.startsWith(constraintIri))) {
        queue.push(object);
      }
    }
  }
  return result;
}

async function validateGeneratedXone(shaclQuads, {
  id,
  targetClass,
  constraint,
  branches,
}) {
  const shapeStore = extractXoneShape(shaclQuads, targetClass, constraint);
  assert.equal(
    shapeStore.countQuads(namedNode(`${constraint}/shape`), namedNode(`${SH}xone`), null, null),
    1,
    `${id} generated shape has no xone`,
  );
  const validator = new SHACLValidator(shapeStore);
  const graph = (selected) => {
    const properties = selected
      .map((predicate, index) => `<${predicate}> "branch-${index}"`)
      .join(' ;\n      ');
    const suffix = properties ? ` ;\n      ${properties}` : '';
    return new Store(new Parser().parse(`
      @prefix rdf: <${RDF_TYPE.slice(0, RDF_TYPE.lastIndexOf('#') + 1)}> .
      <urn:focus:${id}> rdf:type <${targetClass}>${suffix} .
    `));
  };
  assert.equal((await validator.validate(graph([branches[0]]))).conforms, true);
  assert.equal((await validator.validate(graph([]))).conforms, false);
  assert.equal((await validator.validate(graph(branches.slice(0, 2)))).conforms, false);
}

async function main() {
  const risk = loadYaml(RISK_FILE);
  const moduleResult = validateRiskModule(risk);
  if (moduleResult.errors.length === 0) {
    pass('MODULE-RISK', 'typed inventory, roles, reference modes, dimensions, and xone contracts');
  } else {
    for (const error of moduleResult.errors) fail('MODULE-RISK', error);
  }
  for (const item of moduleResult.pending) pend('EVIDENCE-RISK', item);

  try {
    const [owlA, owlB, shaclA, shaclB] = await Promise.all([
      projectOwl(risk),
      projectOwl(risk),
      projectShacl(risk),
      projectShacl(risk),
    ]);
    assert.deepEqual(owlA, owlB);
    assert.deepEqual(shaclA, shaclB);
    const owlQuads = new Parser().parse(owlA.toString('utf8'));
    const shaclQuads = new Parser().parse(shaclA.toString('utf8'));
    pass(
      'PROJECTION-RISK',
      `deterministic parseable OWL=${owlQuads.length} quads SHACL=${shaclQuads.length} quads`,
    );
    const cases = [
      {
        id: 'definition-representation',
        targetClass: `${BASE}RiskMeasureDefinition`,
        constraint: `${BASE}RiskMeasureDefinitionRepresentationXone`,
        branches: [`${BASE}definitionCurrency`, `${BASE}definitionUnit`],
      },
      {
        id: 'measurement-value',
        targetClass: `${BASE}RiskMeasurement`,
        constraint: `${BASE}RiskMeasurementValueXone`,
        branches: [`${BASE}measuredMoney`, `${BASE}measuredQuantity`],
      },
      {
        id: 'limit-value',
        targetClass: `${BASE}RiskLimit`,
        constraint: `${BASE}RiskLimitValueXone`,
        branches: [`${BASE}limitMoney`, `${BASE}limitQuantity`],
      },
    ];
    for (const testCase of cases) {
      await validateGeneratedXone(shaclQuads, testCase);
      pass(
        `SHACL-XONE/${testCase.id}`,
        'real generated shape accepts one branch and rejects zero/two branches',
      );
    }
  } catch (error) {
    fail('PROJECTION-RISK', error.stack || error.message);
  }

  const positive = loadYaml(POSITIVE_FILE);
  const byId = new Map((positive.fixtures || []).map((fixture) => [fixture.id, fixture]));
  for (const fixture of positive.fixtures || []) {
    try {
      validateScenario(fixture.instance);
      pass(`FIXTURE+/${fixture.id}`, 'accepted');
    } catch (error) {
      fail(`FIXTURE+/${fixture.id}`, `unexpected ${error.code || error.message}`);
    }
  }
  const negative = loadYaml(NEGATIVE_FILE);
  for (const testCase of negative.cases || []) {
    const base = byId.get(testCase.baseFixtureId);
    if (!base) {
      fail(`FIXTURE-/${testCase.id}`, `unknown base fixture ${testCase.baseFixtureId}`);
      continue;
    }
    let instance = base.instance;
    for (const mutation of testCase.mutations || []) instance = mutate(instance, mutation);
    if (!(testCase.mutations || []).some((mutation) => (
      /(?:^|\.)(?:sourceArtifactRef|sourceArtifactDigest|sourceLocator)(?:\.|$)/u
        .test(mutation.path)
    ))) {
      instance = authenticateSourceClaims(instance, { namespace: 'risk-source' });
    }
    try {
      validateScenario(instance);
      fail(`FIXTURE-/${testCase.id}`, 'unexpected acceptance');
    } catch (error) {
      const expectedBoundaryViolation = testCase.expectedBoundaryViolation
        || testCase.expectedViolation;
      if (error.code === expectedBoundaryViolation) {
        pass(`FIXTURE-/${testCase.id}`, `rejected with ${error.code}`);
      } else {
        fail(
          `FIXTURE-/${testCase.id}`,
          `expected ${expectedBoundaryViolation}, got ${error.code || error.message}`,
        );
      }
    }
  }

  try {
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-risk-custom-gate-'));
    const runtime = childProcess.spawnSync(
      process.execPath,
      [
        path.join(ROOT, 'scripts', 'domain', 'run-risk-custom-runtime.cjs'),
        '--output-dir',
        output,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      },
    );
    const evidenceFile = path.join(output, 'risk-custom-runtime-evidence.json');
    const evidence = fs.existsSync(evidenceFile)
      ? JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))
      : null;
    assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);
    assert.equal(evidence?.outcome, 'passed');
    assert.equal(evidence?.componentEligible, true);
    assert.equal(evidence?.discoveredConstraints?.length, 8);
    assert.equal(evidence?.vectorResults?.length, 36);
    assert(evidence.vectorResults.every((row) => row.status === 'passed'));
    pass(
      'CUSTOM-RUNTIME-RISK',
      '8 Custom constraints use distinct dispatch and execute 36 positive/violation/cross-dispatch/input-contract/adversarial/fail-closed vectors in the restricted runtime',
    );
  } catch (error) {
    fail('CUSTOM-RUNTIME-RISK', error.stack || error.message);
  }
  const trace = verifyModulePublicSymbolTrace({ ownerModule: BASE.slice(0, -1) });
  if (trace.authored.status === 'pass') {
    pass(
      'TRACEABILITY-RISK/AUTHORED',
      `${trace.authored.closed}/${trace.authored.expected} authored public symbols close through exact term-card bytes and ${trace.authored.tracedCitationCount} locked source citation path(s)`,
    );
  } else {
    fail(
      'TRACEABILITY-RISK/AUTHORED',
      `${trace.authored.closed}/${trace.authored.expected} authored public symbols have exact source/card closure`,
    );
  }
  for (const error of trace.errors) {
    fail(
      `TRACEABILITY-RISK/${error.code}`,
      `${error.subject}: ${error.message}`,
    );
  }
  if (trace.releaseEligible) {
    pass(
      'TRACEABILITY-RISK',
      `${trace.publicSymbols.closed}/${trace.publicSymbols.expected} PublicSymbolNode/definesSymbol paths and ${trace.generated.closed}/${trace.generated.expected} generated inheritance paths are release-closed`,
    );
  } else {
    for (const item of trace.pending) {
      pend(
        `TRACEABILITY-RISK/${item.code}`,
        `${item.count} item(s): ${item.message}`,
      );
    }
    if (trace.errors.length === 0 && trace.pending.length === 0) {
      fail(
        'TRACEABILITY-RISK/INCONSISTENT-DISPOSITION',
        'trace is not release eligible but exposes neither errors nor pending limitations',
      );
    }
  }

  console.log(
    `\nrisk v0.3 targeted checks: ${passed} passed, ${failed} failed, ${pending} pending`,
  );
  process.exitCode = failed > 0 ? 1 : pending > 0 ? 2 : 0;
}

main().catch((error) => {
  fail('UNCAUGHT', error.stack || error.message);
  process.exitCode = 1;
});
