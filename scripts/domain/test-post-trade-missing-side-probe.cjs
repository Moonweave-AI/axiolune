#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  canonical,
  missingSideAbsenceProbeDigest,
  missingSideInputUniverse,
  mutate,
  sha256Utf8Bytes,
  validateScenario,
} = require('./lib/post-trade-v03-contract.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const POSITIVE = path.join(
  ROOT,
  'tests', 'm2', 'fixtures', 'positive', 'post-trade-closure-reconciliation.yaml',
);
const NEGATIVE = path.join(
  ROOT,
  'tests', 'm2', 'fixtures', 'negative', 'post-trade-closure-reconciliation-negative.yaml',
);
const BASE_ID = 'economic-allocation-projection-and-closed-finding-matrix';
const EXPECTED = new Map([
  ['reconciliation-missing-probe-rejects-wrong-query-with-coherent-digests',
    'reconciliation-missing-query-contract'],
  ['reconciliation-missing-probe-rejects-incomplete-universe-with-coherent-digests',
    'reconciliation-missing-input-universe'],
  ['reconciliation-missing-probe-rejects-pit-request-replacement',
    'reconciliation-missing-pit-request-binding'],
  ['reconciliation-missing-probe-rejects-input-run-replacement',
    'reconciliation-missing-input-run-binding'],
  ['reconciliation-missing-probe-rejects-hidden-eligible-candidate',
    'reconciliation-missing-input-universe'],
]);

function load(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

function applyMutations(instance, mutations) {
  let result = instance;
  for (const mutation of mutations || []) result = mutate(result, mutation);
  return result;
}

const positive = load(POSITIVE);
const negative = load(NEGATIVE);
const base = positive.fixtures.find((fixture) => fixture.id === BASE_ID);
assert(base, `missing ${BASE_ID}`);
assert.doesNotThrow(() => validateScenario(base));

const inputRun = JSON.parse(base.instance.missingSideProbeArtifacts.inputRunBytes);
assert.equal(canonical(inputRun), base.instance.missingSideProbeArtifacts.inputRunBytes);
assert.deepEqual(inputRun.universes, {
  external: missingSideInputUniverse(base.instance.externalStatementLines),
  internal: missingSideInputUniverse(base.instance.internalProjections),
});

for (const [caseId, expectedCode] of EXPECTED) {
  const testCase = negative.cases.find((candidate) => candidate.id === caseId);
  assert(testCase, `missing adversarial case ${caseId}`);
  assert.equal(testCase.baseFixtureId, BASE_ID);
  assert.equal(testCase.expectedViolation, expectedCode);
  const instance = applyMutations(base.instance, testCase.mutations);
  const probe = instance.missingSideAssertions[0].absenceProbe;
  assert.equal(probe.digest, missingSideAbsenceProbeDigest(probe), `${caseId} probe digest is coherent`);
  assert.equal(instance.missingSideAssertions[0].absenceProbeDigest, probe.digest,
    `${caseId} outer probe digest is coherent`);
  if (caseId.includes('wrong-query')) {
    assert.equal(sha256Utf8Bytes(instance.missingSideProbeArtifacts.queryFunctionBytes),
      probe.queryFunctionDigest);
  } else if (caseId.includes('pit-request')) {
    assert.equal(sha256Utf8Bytes(instance.missingSideProbeArtifacts.pitRequestBytes),
      probe.pitRequestRecordDigest);
  } else if (caseId.includes('universe') || caseId.includes('input-run-replacement')) {
    assert.equal(sha256Utf8Bytes(instance.missingSideProbeArtifacts.inputRunBytes),
      probe.inputRunRecordDigest);
  }
  assert.throws(
    () => validateScenario({ ...base, instance }),
    (cause) => cause?.code === expectedCode,
    caseId,
  );
}

process.stdout.write('PASS post-trade MissingSide exact query/PIT/input-Run/universe proof (1 positive, 5 adversarial negatives)\n');
