'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const {
  CQ_FUNCTION_VERSION,
} = require('../lib/market-data-cq.cjs');
const {
  NEGATIVE_FILE,
  POSITIVE_FILE,
  SUPPORTED_CQS,
  loadMarketDataCqMatrix,
} = require('../lib/market-data-cq-matrix.cjs');
const {
  materializeYamlMerges,
} = require('../lib/strict-fixture-loader.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CARD_FILE = path.join(
  ROOT,
  'docs',
  'ontology',
  'competency-questions',
  'fin-market-data-cq.yaml',
);

function repositoryRef(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function digestFile(ref) {
  const resolved = path.resolve(ROOT, ref);
  const relative = path.relative(ROOT, resolved);
  assert.ok(
    relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `${ref} escapes the repository`,
  );
  assert.ok(fs.statSync(resolved).isFile(), `${ref} is not a file`);
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')}`;
}

function verifyLock(ref, digest, label) {
  assert.equal(typeof ref, 'string', `${label} ref`);
  assert.equal(digest, digestFile(ref), `${label} digest drift`);
}

function sorted(values) {
  return [...values].sort();
}

test('Market Data CQ card exactly closes matrix cases and executable byte locks', () => {
  const card = materializeYamlMerges(yaml.load(fs.readFileSync(CARD_FILE, 'utf8')));
  const matrix = loadMarketDataCqMatrix();
  assert.deepEqual(sorted(card.cqs.map(({ id }) => id)), sorted(SUPPORTED_CQS));

  const fixedLocks = [
    ['implementation', 'implementationDigest', 'scripts/domain/lib/market-data-cq.cjs'],
    ['matrixImplementation', 'matrixImplementationDigest', 'scripts/domain/lib/market-data-cq-matrix.cjs'],
    ['graphFixture', 'graphFixtureDigest', 'tests/m2/fixtures/market-data-v03/positive-complete.yaml'],
    ['positiveFixture', 'positiveFixtureDigest', repositoryRef(POSITIVE_FILE)],
    ['negativeFixture', 'negativeFixtureDigest', repositoryRef(NEGATIVE_FILE)],
  ];
  const expectedDependencies = sorted([
    'scripts/domain/lib/decimal-lexical.cjs',
    'scripts/domain/lib/json-pointer-source-extractor.cjs',
    'scripts/domain/lib/market-data-release-evidence.cjs',
    'scripts/domain/lib/market-data-v03-contracts.cjs',
    'scripts/domain/lib/strict-fixture-loader.cjs',
    'scripts/domain/lib/strict-source-locator.cjs',
    'scripts/domain/lib/whole-file-source-extractor.cjs',
  ]);

  for (const cq of card.cqs) {
    const expectedPositive = sorted([...matrix.cases.values()]
      .filter((entry) => entry.cqId === cq.id && entry.polarity === 'positive')
      .map(({ caseId }) => caseId));
    const expectedNegative = sorted([...matrix.cases.values()]
      .filter((entry) => entry.cqId === cq.id && entry.polarity === 'negative')
      .map(({ caseId }) => caseId));
    assert.deepEqual(sorted(cq.positiveCases), expectedPositive, `${cq.id} positive case inventory`);
    assert.deepEqual(sorted(cq.negativeCases), expectedNegative, `${cq.id} negative case inventory`);

    const execution = cq.execution;
    assert.ok(execution && !Object.hasOwn(execution, '<<'), `${cq.id} execution merge`);
    assert.equal(execution.functionVersion, CQ_FUNCTION_VERSION, `${cq.id} function version`);
    for (const [refField, digestField, expectedRef] of fixedLocks) {
      assert.equal(execution[refField], expectedRef, `${cq.id} ${refField}`);
      verifyLock(execution[refField], execution[digestField], `${cq.id} ${refField}`);
    }

    assert.deepEqual(
      sorted(execution.dependencyLocks.map(({ ref }) => ref)),
      expectedDependencies,
      `${cq.id} dependency inventory`,
    );
    for (const lock of execution.dependencyLocks) {
      assert.deepEqual(sorted(Object.keys(lock)), ['digest', 'ref']);
      verifyLock(lock.ref, lock.digest, `${cq.id} dependency ${lock.ref}`);
    }

    const expectedFixtureRefs = sorted([...new Set([...matrix.cases.values()]
      .filter((entry) => entry.cqId === cq.id
        && entry.polarity === 'negative'
        && entry.kind === 'fixture')
      .map((entry) => repositoryRef(path.resolve(path.dirname(NEGATIVE_FILE), entry.fixture))))]);
    assert.deepEqual(
      sorted(execution.fixtureLocks.map(({ ref }) => ref)),
      expectedFixtureRefs,
      `${cq.id} fixture lock inventory`,
    );
    for (const lock of execution.fixtureLocks) {
      assert.deepEqual(sorted(Object.keys(lock)), ['digest', 'ref']);
      verifyLock(lock.ref, lock.digest, `${cq.id} fixture ${lock.ref}`);
    }

    assert.equal(execution.runtime.engine, 'node');
    assert.equal(execution.runtime.version, process.version);
    verifyLock(
      execution.runtime.dependencyLock,
      execution.runtime.dependencyLockDigest,
      `${cq.id} runtime lock`,
    );
  }
});
