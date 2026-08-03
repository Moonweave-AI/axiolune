'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const YAML = require('yaml');
const { Parser } = require('n3');

const { projectOwl } = require('../generate-m2-owl.cjs');
const { projectShacl } = require('../generate-m2-shacl.cjs');
const {
  validateAttribution,
  validateBacktest,
  validateCalculationContext,
  validateCompletedBacktestResults,
  validateFactorRevision,
  validateFixtureDocument,
  validateGeneratorDefinition,
  validatePerformance,
  validatePerformanceRevision,
  validatePerformanceTrajectory,
  validateSignal,
  validateStrategyResearchModule,
} = require('../lib/strategy-research-contracts.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MODULE_PATH = path.join(ROOT, 'ontology/domain/finance/strategy-research/module.yaml');
const POSITIVE_PATH = path.join(ROOT, 'tests/m2/fixtures/strategy-research/positive.yaml');
const NEGATIVE_PATH = path.join(ROOT, 'tests/m2/fixtures/strategy-research/negative.yaml');
const QLIB_REVIEW_PATH = path.join(
  ROOT,
  'docs/ontology/references/reviews/project-reference/qlib.review.json',
);

function loadYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

function mutatedQlibReview(t, mutate) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-qlib-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const review = JSON.parse(fs.readFileSync(QLIB_REVIEW_PATH, 'utf8'));
  mutate(review);
  const reviewPath = path.join(directory, 'qlib.review.json');
  fs.writeFileSync(reviewPath, JSON.stringify(review), 'utf8');
  return reviewPath;
}

test('strategy/research module independently replays the complete v0.3 evidence profile', () => {
  const result = validateStrategyResearchModule({ root: ROOT });
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.pending, []);
  assert.equal(result.evidence.qlibConflictMappings, 3);
  assert.equal(result.evidence.materializedTypes, 13);
  assert.equal(result.evidence.referenceModeBindings, 32);
  assert.equal(result.evidence.semanticMappingDefinitions, 7);
  assert.equal(result.evidence.materializedRecords, 8);
  assert.equal(result.evidence.cqActivePassed, 7);
  assert.equal(result.evidence.cqDeferredNonCore, 1);
  assert.equal(result.evidence.pitReplaysPassed, 3);
  assert.equal(result.evidence.formulaVectorsPassed, 11);
  assert.equal(result.evidence.quantityUnits, 2);
});

test('Qlib mapping candidates must remain reviewedRejected under the anti-project-normalization policy', (t) => {
  const reviewPath = mutatedQlibReview(t, (review) => {
    review.files.find((file) => file.path.endsWith('/docs/advanced/PIT.rst')).disposition = 'usedImplementation';
  });
  const result = validateStrategyResearchModule({ root: ROOT, reviewPath });
  assert.equal(result.status, 'fail');
  assert.equal(result.evidence.qlibConflictMappings, 3);
  assert.ok(result.errors.some((error) => /must remain reviewedRejected/.test(error)));
  assert.equal(result.pending.length, 0);
});

test('Qlib reviewedRejected candidates must retain all three explicit temporal conflicts', (t) => {
  const reviewPath = mutatedQlibReview(t, (review) => {
    review.files.find((file) => file.path.endsWith('/qlib/data/data.py')).semanticMappings = [];
  });
  const result = validateStrategyResearchModule({ root: ROOT, reviewPath });
  assert.equal(result.status, 'fail');
  assert.equal(result.evidence.qlibConflictMappings, 2);
  assert.ok(result.errors.some((error) => /exactly three conflict mappings, found 2/.test(error)));
  assert.equal(result.pending.length, 0);
});

test('all positive executable contract families and both metric value branches accept', () => {
  const document = loadYaml(POSITIVE_PATH);
  const result = validateFixtureDocument(document, { requirePositive: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.results.length, 15);
  assert.ok(result.results.every((entry) => entry.actual === 'accept' && entry.matched));
  assert.deepEqual(
    new Set(result.results.map((entry) => entry.kind)),
    new Set(['generatorDefinition', 'metricDefinition', 'calculationContext', 'signal', 'factorRevision', 'backtest', 'researchRun', 'performance', 'performanceRevision', 'performanceTrajectory', 'completedBacktestResults', 'attribution', 'statusEvent']),
  );
});

test('negative fixtures execute expected fail-closed paths', () => {
  const document = loadYaml(NEGATIVE_PATH);
  const result = validateFixtureDocument(document, { requireNegative: true });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.results.length, 25);
  assert.ok(result.results.every((entry) => entry.actual === 'reject' && entry.matched));
  const codes = new Set(result.results.flatMap((entry) => entry.violations.map((violation) => violation.code)));
  for (const code of [
    'QUANTITY_RANGE',
    'SIGNAL_LISTING_INSTRUMENT',
    'SIGNAL_SOURCE_ID_UNIQUENESS',
    'FACTOR_STORAGE_POINTER',
    'INPUT_CONTEXT_NOT_PRIOR',
    'METRIC_VALUE_XONE',
    'ATTRIBUTION_SUBJECT_XONE',
    'RUN_KIND',
    'STATUS_TRANSITION',
    'INSTANT_FORMAT',
    'PERFORMANCE_SUPERSESSION',
    'STRATEGY_USES_FACTOR',
    'PERFORMANCE_TRAJECTORY_ORDER',
    'COMPLETED_BACKTEST_PERFORMANCE_JOIN',
    'CALCULATION_PARAMETER_SNAPSHOT_PAIR',
    'CALCULATION_PARAMETER_SNAPSHOT_DIGEST',
    'CALCULATION_PARAMETER_SNAPSHOT_CONTENT',
    'CALCULATION_PARAMETER_SNAPSHOT_MISMATCH',
    'CALCULATION_PARAMETER_SNAPSHOT_LOOKAHEAD',
    'CALCULATION_PARAMETER_SNAPSHOT_ANCHOR',
  ]) {
    assert.ok(codes.has(code), `missing exercised violation ${code}`);
  }
});

test('exact-version participant mode is not silently weakened', () => {
  const signalCase = loadYaml(POSITIVE_PATH).cases.find((entry) => entry.kind === 'signal');
  const payload = clone(signalCase.payload);
  payload.generator.referenceMode = 'logical';
  const violations = validateSignal(payload);
  assert.ok(violations.some((violation) => violation.code === 'EXACT_REFERENCE'));
});

test('abstract generator and explicit factor dependency contracts fail closed', () => {
  const strategyCase = loadYaml(POSITIVE_PATH).cases.find((entry) => entry.kind === 'generatorDefinition');
  const directAbstract = clone(strategyCase.payload);
  directAbstract.directType = 'SignalGenerator';
  assert.ok(validateGeneratorDefinition(directAbstract).some((violation) => violation.code === 'GENERATOR_DIRECT_TYPE'));
  const logicalFactor = clone(strategyCase.payload);
  logicalFactor.usesFactors[0].referenceMode = 'logical';
  assert.ok(validateGeneratorDefinition(logicalFactor).some((violation) => violation.code === 'EXACT_REFERENCE'));
});

test('targeted mutations reject replay leakage mutable status revision gaps and incomplete contexts', () => {
  const cases = loadYaml(POSITIVE_PATH).cases;

  const backtest = clone(cases.find((entry) => entry.kind === 'backtest').payload);
  backtest.inputContext.datasetSnapshots = [];
  assert.ok(validateBacktest(backtest).some((violation) => violation.code === 'CORPORATE_ACTION_SNAPSHOT'));
  backtest.inputContext.datasetSnapshots = [{
    datasetKind: 'corporateAction',
    datasetRef: 'https://axiolune.ai/data/dataset/corporate-actions/locked-2025-01-07',
    artifactDigest: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    schemaDigest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
  }];
  backtest.status = 'completed';
  assert.ok(validateBacktest(backtest).some((violation) => violation.code === 'MUTABLE_RUN_STATUS'));

  const factor = clone(cases.find((entry) => entry.kind === 'factorRevision').payload);
  factor.current.temporal.knowledgeFrom = '2024-03-02T09:00:00Z';
  assert.ok(validateFactorRevision(factor).some((violation) => violation.code === 'FACTOR_KNOWLEDGE_CLOSURE'));

  const factorAcrossRuns = clone(cases.find((entry) => entry.kind === 'factorRevision').payload);
  factorAcrossRuns.current.runContext = {
    referenceMode: 'version',
    logicalIri: 'https://axiolune.ai/data/run/research-roe-revision-2',
    versionIri: 'https://axiolune.ai/data/run/research-roe-revision-2/version/1',
  };
  assert.deepEqual(validateFactorRevision(factorAcrossRuns), [], 'RunContext is immutable version content, not stable factor identity');

  const inlineClosure = clone(cases.find((entry) => entry.kind === 'factorRevision').payload);
  inlineClosure.previous.temporal.knowledgeTo = inlineClosure.current.temporal.knowledgeFrom;
  assert.ok(validateFactorRevision(inlineClosure).some((violation) => violation.code === 'FACT_VERSION_INLINE_CLOSURE'));

  const performance = clone(cases.find((entry) => entry.id === 'sharpe-performance-with-complete-context').payload);
  delete performance.calculationContext.riskFreeRate;
  assert.ok(validatePerformance(performance).some((violation) => violation.code === 'QUANTITY_REQUIRED'));
  const badConfidence = clone(cases.find((entry) => entry.id === 'sharpe-performance-with-complete-context').payload);
  badConfidence.calculationContext.confidenceLevel = {
    value: '1.01',
    unit: 'https://axiolune.ai/units/one',
    rounding: 'half-even',
  };
  assert.ok(validatePerformance(badConfidence).some((violation) => violation.code === 'QUANTITY_RANGE'));

  const calculation = clone(cases.find((entry) => entry.id === 'locked-daily-calculation-context').payload);
  calculation.annualizationFactor.value = '365';
  assert.ok(validateCalculationContext(calculation).some((violation) => violation.code === 'CALCULATION_PARAMETER_SNAPSHOT_MISMATCH'));

  const missingNestedSnapshot = clone(cases.find((entry) => entry.id === 'sharpe-performance-with-complete-context').payload);
  delete missingNestedSnapshot.calculationContext.calculationParameterSnapshotDigest;
  assert.ok(validatePerformance(missingNestedSnapshot).some((violation) => violation.code === 'CALCULATION_PARAMETER_SNAPSHOT_PAIR'));

  const binaryFloatStrength = clone(cases.find((entry) => entry.kind === 'signal').payload);
  binaryFloatStrength.strength.value = 0.73;
  assert.ok(validateSignal(binaryFloatStrength).some((violation) => violation.code === 'QUANTITY_VALUE'));

  const unregisteredStrengthUnit = clone(cases.find((entry) => entry.kind === 'signal').payload);
  unregisteredStrengthUnit.strength.unit = 'https://example.com/unit/one';
  assert.ok(validateSignal(unregisteredStrengthUnit).some((violation) => violation.code === 'QUANTITY_UNIT'));

  const wrongApplicationUnit = clone(cases.find((entry) => entry.kind === 'signal').payload);
  wrongApplicationUnit.strength.unit = 'https://axiolune.ai/units/trading-day';
  assert.ok(validateSignal(wrongApplicationUnit).some((violation) => violation.code === 'QUANTITY_UNIT'));

  const exactHugeStrength = clone(cases.find((entry) => entry.kind === 'signal').payload);
  exactHugeStrength.strength.value = '10000000000000000000000000000000000000000.00000000000000000001';
  assert.ok(validateSignal(exactHugeStrength).some((violation) => violation.code === 'QUANTITY_RANGE'));

  const performanceRevision = clone(cases.find((entry) => entry.kind === 'performanceRevision').payload);
  performanceRevision.current.temporal.knowledgeFrom = performanceRevision.previous.temporal.knowledgeFrom;
  assert.ok(validatePerformanceRevision(performanceRevision).some((violation) => violation.code === 'PERFORMANCE_KNOWLEDGE_CLOSURE'));

  const trajectory = clone(cases.find((entry) => entry.kind === 'performanceTrajectory').payload);
  trajectory.lastQuarter = true;
  assert.ok(validatePerformanceTrajectory(trajectory).some((violation) => violation.code === 'PERFORMANCE_TRAJECTORY_RELATIVE_TIME'));

  const completed = clone(cases.find((entry) => entry.kind === 'completedBacktestResults').payload);
  completed.terminalStatus.state = 'running';
  assert.ok(validateCompletedBacktestResults(completed).some((violation) => violation.code === 'BACKTEST_NOT_COMPLETED'));

  const attribution = clone(cases.find((entry) => entry.kind === 'attribution').payload);
  attribution.positionLot = {
    referenceMode: 'version',
    logicalIri: 'https://axiolune.ai/data/lot/account-1/AAPL/lot-7',
    versionIri: 'https://axiolune.ai/data/lot/account-1/AAPL/lot-7/version/2',
  };
  assert.ok(validateAttribution(attribution).some((violation) => violation.code === 'ATTRIBUTION_SUBJECT_XONE'));
});

test('canonical module excludes Qlib storage pointers and false alignments', () => {
  const document = loadYaml(MODULE_PATH);
  const serialized = JSON.stringify(document);
  assert.equal(serialized.includes('nextRevision'), false);
  assert.equal(serialized.includes('_next'), false);
  assert.equal(serialized.includes('SignalObservation'), false);
  const qlibAlignment = serialized.match(/"alignments"[^]*?qlib/i);
  assert.equal(qlibAlignment, null);
  assert.equal(document.domain.associationTypes.Signal.label, 'Signal Observation');
});

test('typed OWL and SHACL projections are deterministic and emit three executable xone shapes', async () => {
  const document = loadYaml(MODULE_PATH);
  const [shaclOne, shaclTwo, owlOne, owlTwo] = await Promise.all([
    projectShacl(document),
    projectShacl(document),
    projectOwl(document),
    projectOwl(document),
  ]);
  assert.deepEqual(shaclOne, shaclTwo);
  assert.deepEqual(owlOne, owlTwo);
  const shaclText = shaclOne.toString('utf8');
  assert.equal((shaclText.match(/sh:xone/g) || []).length, 3);
  const shaclQuads = new Parser().parse(shaclText);
  const owlQuads = new Parser().parse(owlOne.toString('utf8'));
  assert.ok(shaclQuads.length > 0);
  assert.ok(owlQuads.length > 0);
  assert.equal(
    shaclQuads.filter((quad) => quad.predicate.value === 'http://www.w3.org/ns/shacl#xone').length,
    3,
  );
  assert.match(shaclText, /PerformanceValueXone\/shape/);
  assert.match(shaclText, /PositionAttributionSubjectXone\/shape/);
  assert.match(shaclText, /PositionAttributionValueXone\/shape/);
  for (const local of [
    'calculationParameterSnapshotRef',
    'calculationParameterSnapshotDigest',
    'calculationParameterSnapshotLocator',
  ]) {
    const property = `https://axiolune.ai/ontology/finance/strategy-research/${local}`;
    const propertyShapes = shaclQuads
      .filter((quad) => quad.predicate.value === 'http://www.w3.org/ns/shacl#path' && quad.object.value === property)
      .map((quad) => quad.subject.value);
    const mandatoryPropertyShapes = propertyShapes.filter((shape) => shaclQuads.some((quad) => (
      quad.subject.value === shape
      && quad.predicate.value === 'http://www.w3.org/ns/shacl#minCount'
      && quad.object.value === '1'
    )));
    assert.equal(mandatoryPropertyShapes.length, 1, `${local} must have exactly one mandatory CalculationContext property shape`);
  }
});

test('all code-value IRIs use the compiler-enforced value namespace', () => {
  const document = loadYaml(MODULE_PATH);
  for (const codeList of Object.values(document.domain.codeLists)) {
    for (const value of codeList.values) {
      assert.ok(value.iri.startsWith(`${codeList.iri}/value/`), value.iri);
    }
  }
});

test('CLI uses exit 0 for independently replayed module evidence and executable fixtures', () => {
  const cli = path.join(ROOT, 'scripts/domain/validate-strategy-research-contract.cjs');
  const moduleRun = spawnSync(process.execPath, [cli, '--module'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(moduleRun.status, 0, moduleRun.stderr || moduleRun.stdout);
  assert.match(moduleRun.stdout, /status: PASS/);
  const fixtureRun = spawnSync(process.execPath, [
    cli,
    '--fixtures',
    path.relative(ROOT, POSITIVE_PATH),
    path.relative(ROOT, NEGATIVE_PATH),
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(fixtureRun.status, 0, fixtureRun.stderr || fixtureRun.stdout);
  assert.match(fixtureRun.stdout, /factor-domain-revision-chain/);
  assert.match(fixtureRun.stdout, /reject-qlib-storage-pointer-as-domain-relation/);
});
