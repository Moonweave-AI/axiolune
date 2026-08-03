'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');

const {
  ASSESSMENTS_PATH,
  DECISIONS_PATH,
  constructArtifacts: constructDecisionArtifacts,
  inspectOrderLineageClosure,
} = require('../generate-ontology-design-semantic-review-decisions.cjs');
const {
  constructArtifacts: constructReviewArtifacts,
  dispositionFor,
} = require('../review-ontology-design-references.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, ...relativePath.split('/')), 'utf8');
}

function cqDocumentWithDigest(field, bytes) {
  const relativePath = 'docs/ontology/competency-questions/fin-orders-execution-cq.yaml';
  const document = YAML.parse(source(relativePath));
  document.joinedExecution[field] = sha256(Buffer.from(bytes, 'utf8'));
  const cq = document.cqs.find((entry) => entry.id === 'CQ-OE11');
  cq.execution[field] = document.joinedExecution[field];
  return YAML.stringify(document);
}

test('all three ontology-design projects have explicit digest-bound decisions or active exact use', () => {
  const result = constructDecisionArtifacts();
  assert.equal(result.fileCount, 2087);
  assert.equal(result.activeTargetFileCount, 13);
  assert.equal(result.decisionCount, 2074);
  assert.equal(result.assessments.entries.length, 38);

  const target = result.decisions.decisions.filter((decision) => (
    /^reference\/ontology-design-reference\/(?:BIAN|FinRegOnt|fibo)\//u.test(decision.path)
  ));
  assert.equal(target.length, 2074);
  assert.deepEqual(
    Object.fromEntries(['BIAN', 'FinRegOnt', 'fibo'].map((projectId) => [
      projectId,
      target.filter((decision) => decision.path.startsWith(`reference/ontology-design-reference/${projectId}/`)).length,
    ])),
    { BIAN: 1294, FinRegOnt: 326, fibo: 454 },
  );
  assert.equal(new Set(target.map((decision) => decision.path)).size, target.length);
  for (const decision of target) {
    const absolute = path.join(ROOT, ...decision.path.split('/'));
    assert.equal(decision.artifactDigest, sha256(fs.readFileSync(absolute)), decision.path);
    assert.doesNotMatch(decision.rationale, /no current .*consumer|no downstream/iu, decision.path);
    assert.ok(decision.rationale.length >= 120, `${decision.path}: rationale is not file-specific enough`);
    assert.ok(['reviewedNoBearing', 'reviewedRejected'].includes(decision.disposition));
  }
  const marketOrderDecision = target.find((decision) => (
    decision.path.endsWith('/BIAN/MarketOrder/MarketOrderSpecification.csv')
  ));
  assert.ok(marketOrderDecision, 'MarketOrder specification decision is missing');
  assert.match(marketOrderDecision.rationale, /split\/aggregation gap is closed/iu);
  assert.doesNotMatch(
    marketOrderDecision.rationale,
    /current ontology has no explicit parent\/child split-or-aggregation lineage contract/iu,
  );

  const marketOrderExecution = result.assessments.entries.find((entry) => (
    entry.assessmentId === 'bian-MarketOrderExecution'
  ));
  assert.equal(marketOrderExecution.severity, 'info');
  assert.equal(marketOrderExecution.outcome, 'implemented-plan-gap-closed');
  assert.deepEqual(
    new Set(marketOrderExecution.requiredLanding.map((landing) => landing.kind)),
    new Set(['constraint', 'cq', 'fixture', 'module']),
  );
  assert.ok(marketOrderExecution.requiredLanding.every(
    (landing) => landing.status === 'implemented-source-closure-machine-checked',
  ));
  const marketOrder = result.assessments.entries.find((entry) => (
    entry.assessmentId === 'bian-MarketOrder'
  ));
  assert.equal(marketOrder.severity, 'info');
  assert.equal(marketOrder.outcome, 'implemented-plan-gap-closed');
  assert.deepEqual(
    new Set(marketOrder.requiredLanding.map((landing) => landing.kind)),
    new Set(['constraint', 'cq', 'fixture', 'module', 'runtime']),
  );
  assert.ok(marketOrder.requiredLanding.every(
    (landing) => landing.status === 'implemented-source-closure-machine-checked',
  ));
  assert.equal(
    result.assessments.entries.filter((entry) => entry.severity === 'blocker').length,
    0,
  );
  assert.equal(
    result.assessments.entries.filter((entry) => entry.severity === 'major').length,
    0,
  );
  assert.equal(fs.readFileSync(DECISIONS_PATH, 'utf8'), canonicalJcs(result.decisions));
  assert.equal(fs.readFileSync(ASSESSMENTS_PATH, 'utf8'), canonicalJcs(result.assessments));
});

test('MarketOrder lineage assessment fails closed under ontology and fixture mutations', () => {
  const baseline = inspectOrderLineageClosure();
  assert.deepEqual(baseline, { errors: [], ok: true });

  const modulePath = 'ontology/domain/finance/orders-execution/module.yaml';
  const moduleSource = fs.readFileSync(path.join(ROOT, ...modulePath.split('/')), 'utf8');
  const mutatedModule = moduleSource.replace(
    'axiolune-order-intent-lineage-key-v1\\0',
    'axiolune-order-intent-lineage-key-v2\\0',
  );
  assert.notEqual(mutatedModule, moduleSource, 'test mutation did not alter the lineage domain tag');
  const ontologyMutation = inspectOrderLineageClosure({
    contentOverrides: new Map([[modulePath, mutatedModule]]),
  });
  assert.equal(ontologyMutation.ok, false);
  assert.ok(ontologyMutation.errors.some((error) => (
    error.includes('axiolune-order-intent-lineage-key-v1')
  )));

  const fixturePath = 'tests/m2/fixtures/positive/orders-execution-v03.yaml';
  const fixtureSource = fs.readFileSync(path.join(ROOT, ...fixturePath.split('/')), 'utf8');
  const mutatedFixture = fixtureSource.replace(
    /^\s+sourceLocator: \$\.routingTransformations\[0\]\r?\n/mu,
    '',
  );
  assert.notEqual(mutatedFixture, fixtureSource, 'test mutation did not remove the lineage locator');
  const fixtureMutation = inspectOrderLineageClosure({
    contentOverrides: new Map([[fixturePath, mutatedFixture]]),
  });
  assert.equal(fixtureMutation.ok, false);
  assert.ok(fixtureMutation.errors.some((error) => error.includes('sourceLocator')));

  const invalidLocator = fixtureSource.replace(
    'sourceLocator: $.routingTransformations[0]',
    'sourceLocator: nonsense',
  );
  assert.notEqual(invalidLocator, fixtureSource, 'test mutation did not corrupt the lineage locator');
  const invalidLocatorMutation = inspectOrderLineageClosure({
    contentOverrides: new Map([[fixturePath, invalidLocator]]),
  });
  assert.equal(invalidLocatorMutation.ok, false);
  assert.ok(invalidLocatorMutation.errors.includes(
    'OE-POS-020.lineages[0].sourceLocator is absent or invalid',
  ));
});

test('MarketOrder lineage assessment requires exact nonempty CQ lock inventories', () => {
  const cqPath = 'docs/ontology/competency-questions/fin-orders-execution-cq.yaml';
  const baseline = YAML.parse(source(cqPath));
  const expectedDependencies = baseline.joinedExecution.dependencyLocks;
  const extraLock = {
    ref: 'package-lock.json',
    digest: sha256(fs.readFileSync(path.join(ROOT, 'package-lock.json'))),
  };
  const mutations = [
    { label: 'empty', locks: [] },
    { label: 'missing', locks: expectedDependencies.slice(1) },
    { label: 'duplicate', locks: [...expectedDependencies, expectedDependencies[0]] },
    { label: 'extra', locks: [...expectedDependencies, extraLock] },
  ];
  for (const mutation of mutations) {
    const document = YAML.parse(source(cqPath));
    document.joinedExecution.dependencyLocks = mutation.locks;
    document.cqs.find((entry) => entry.id === 'CQ-OE11').execution.dependencyLocks = mutation.locks;
    const result = inspectOrderLineageClosure({
      contentOverrides: new Map([[cqPath, YAML.stringify(document)]]),
    });
    assert.equal(result.ok, false, mutation.label);
    assert.ok(result.errors.includes('CQ-OE11 dependency locks is not the required exact set'));
  }

  const artifactDocument = YAML.parse(source(cqPath));
  artifactDocument.joinedExecution.artifactLocks = [];
  artifactDocument.cqs.find((entry) => entry.id === 'CQ-OE11').execution.artifactLocks = [];
  const artifactResult = inspectOrderLineageClosure({
    contentOverrides: new Map([[cqPath, YAML.stringify(artifactDocument)]]),
  });
  assert.equal(artifactResult.ok, false);
  assert.ok(artifactResult.errors.includes('CQ-OE11 artifact locks is not the required exact set'));
});

test('MarketOrder lineage assessment rejects digest-matched CQ-OE11 case stubs', () => {
  const cqPath = 'docs/ontology/competency-questions/fin-orders-execution-cq.yaml';
  const positivePath = 'tests/m2/fixtures/orders-portfolio-cq/positive.yaml';
  const negativePath = 'tests/m2/fixtures/orders-portfolio-cq/negative.yaml';
  const positive = YAML.parse(source(positivePath));
  const negative = YAML.parse(source(negativePath));
  positive.cases = positive.cases.map((entry) => (
    entry.cqId === 'CQ-OE11' ? { id: entry.id, cqId: entry.cqId } : entry
  ));
  negative.cases = negative.cases.map((entry) => (
    entry.cqId === 'CQ-OE11' ? { id: entry.id, cqId: entry.cqId } : entry
  ));
  const positiveBytes = YAML.stringify(positive);
  const negativeBytes = YAML.stringify(negative);
  const cq = YAML.parse(source(cqPath));
  for (const [field, bytes] of [
    ['positiveFixtureDigest', positiveBytes],
    ['negativeFixtureDigest', negativeBytes],
  ]) {
    cq.joinedExecution[field] = sha256(Buffer.from(bytes, 'utf8'));
    cq.cqs.find((entry) => entry.id === 'CQ-OE11').execution[field] = cq.joinedExecution[field];
  }
  const result = inspectOrderLineageClosure({
    contentOverrides: new Map([
      [cqPath, YAML.stringify(cq)],
      [positivePath, positiveBytes],
      [negativePath, negativeBytes],
    ]),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('case fields is not the required exact set')));
});

test('MarketOrder lineage content overrides still execute CQ-OE11 negative mutations', () => {
  const cqPath = 'docs/ontology/competency-questions/fin-orders-execution-cq.yaml';
  const negativePath = 'tests/m2/fixtures/orders-portfolio-cq/negative.yaml';
  const negative = YAML.parse(source(negativePath));
  const candidate = negative.cases.find(
    (entry) => entry.id === 'cq-oe11-source-count-closure-drift-rejected',
  );
  candidate.mutations[0].value = 1;
  const negativeBytes = YAML.stringify(negative);
  const cqBytes = cqDocumentWithDigest('negativeFixtureDigest', negativeBytes);
  const result = inspectOrderLineageClosure({
    contentOverrides: new Map([
      [cqPath, cqBytes],
      [negativePath, negativeBytes],
    ]),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes(
    'cq-oe11-source-count-closure-drift-rejected runtime returned accepted, expected CQ_OE11_SOURCE_SET',
  ));
});

test('MarketOrder lineage assessment rejects structurally gutted domain fixtures', () => {
  const positivePath = 'tests/m2/fixtures/positive/orders-execution-v03.yaml';
  const negativePath = 'tests/m2/fixtures/negative/orders-execution-v03.yaml';
  const positive = YAML.parse(source(positivePath));
  const negative = YAML.parse(source(negativePath));
  const positiveCase = positive.fixtures.find(
    (entry) => entry.id === 'OE-POS-020-immutable-split-and-aggregation-lineage',
  );
  positiveCase.instance = {
    lineages: [
      { kind: 'split', sourceIntentCount: 1, resultIntentCount: 2, sourceLocator: '$.x' },
      { kind: 'aggregation', sourceIntentCount: 2, resultIntentCount: 1, sourceLocator: '$.x' },
    ],
  };
  for (const fixture of negative.fixtures.filter((entry) => /^OE-NEG-02[0-7]-/u.test(entry.id))) {
    fixture.instance = { lineages: fixture.id.includes('027') ? [{}] : [] };
  }
  const result = inspectOrderLineageClosure({
    contentOverrides: new Map([
      [positivePath, YAML.stringify(positive)],
      [negativePath, YAML.stringify(negative)],
    ]),
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('OE-POS-020 instance fields is not the required exact set'));
  assert.ok(result.errors.some((error) => error.includes('intent inventory is absent')));
  assert.ok(result.errors.some((error) => error.includes('lineage inventory is absent')));
});

test('reviewer never infers no-bearing from signal absence or binary metadata', () => {
  const file = { path: 'reference/ontology-design-reference/example/file.bin' };
  const noSignals = { contentSignals: [], outcome: 'parsed' };
  const binary = { contentSignals: [], outcome: 'metadata-inspected' };
  assert.equal(dispositionFor(file, noSignals, [], null), null);
  assert.equal(dispositionFor(file, binary, [], null), 'binaryInspected');
  assert.equal(
    dispositionFor(file, binary, [], { disposition: 'reviewedRejected' }),
    'reviewedRejected',
  );
});

test('review closure has no semantic-decision or provenance gaps', { timeout: 120000 }, () => {
  const result = constructReviewArtifacts();
  assert.deepEqual(result.semanticDecisionBlockers, []);
  assert.deepEqual(result.referenceProvenanceBlockers, []);
  assert.equal(result.stats.referenceProvenanceBlockerCount, 0);
  assert.equal(result.stats.semanticDecisionBlockerCount, 0);
});
