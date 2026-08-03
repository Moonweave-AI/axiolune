#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LOCK = path.join(
  ROOT,
  'scripts',
  'domain',
  'owl-dl-profile',
  'v0.3.0',
  'tool-lock.json',
);
const PROFILE_ROOT = path.dirname(LOCK);

test('OWL DL tool lock pins a DL profile and two independent complete engines', () => {
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  assert.equal(lock.schemaVersion, '1.0');
  assert.equal(lock.profile.robotArgument, 'DL');
  assert.match(lock.javaRuntime.artifactDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(lock.robot.artifactDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(lock.reasoners.length, 2);
  assert.deepEqual(
    lock.reasoners.map((reasoner) => reasoner.gateId).sort(),
    ['owl-reasoner-primary', 'owl-reasoner-secondary'],
  );
  assert.equal(
    new Set(lock.reasoners.map((reasoner) => reasoner.implementation)).size,
    2,
  );
  for (const reasoner of lock.reasoners) {
    assert.equal(typeof reasoner.version, 'string');
    assert.ok(reasoner.version.length > 0);
  }
});

test('OWL DL negative corpus is present and non-empty', () => {
  const root = path.join(ROOT, 'tests', 'm2', 'fixtures', 'owl-dl');
  for (const name of [
    'consistent.ttl',
    'inconsistent.ttl',
    'profile-violation.ttl',
    'unsatisfiable.ttl',
  ]) {
    const file = path.join(root, name);
    assert.ok(fs.existsSync(file), `missing ${name}`);
    assert.ok(fs.statSync(file).size > 0, `empty ${name}`);
  }
});

test('OWL DL runner has reviewed discovery and closed evidence contracts', () => {
  const discovery = JSON.parse(fs.readFileSync(
    path.join(PROFILE_ROOT, 'subject-discovery-contract.json'),
    'utf8',
  ));
  assert.deepEqual(discovery.gateIds, [
    'owl-dl-profile',
    'owl-reasoner-primary',
    'owl-reasoner-secondary',
  ]);
  assert.equal(discovery.entrypoint, 'scripts/domain/run-owl-dl-gate.cjs');
  assert.equal(discovery.moduleDiscovery.exactCount, 10);
  assert.deepEqual(discovery.closureConstruction, {
    parserPackage: 'n3',
    parserVersion: '2.1.1',
    dependencyLock: 'package-lock.json',
    packageIntegrity: 'sha512-kqg8ers6Lc+uAmHeS+ycd3b8mC4x8wr8V8Fi6+w7l4hX6b0KZ5bT05Tf49qM2mujwaqZT3+08zcgtXgfxivbVQ==',
    aggregateOntologyIri: 'https://axiolune.ai/ontology/finance/0.3.0/reasoner-aggregate',
    outputFileName: 'flattened-closure.ttl',
    requiredMetaImport: 'https://axiolune.ai/ontology/meta',
    mode: 'parse-verify-strip-headers-deduplicate-flatten',
    invocationTimeoutMs: 300000,
  });

  const schema = JSON.parse(fs.readFileSync(
    path.join(PROFILE_ROOT, 'owl-dl-evidence.schema.json'),
    'utf8',
  ));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.outcome.const, 'passed');
  assert.equal(schema.properties.moduleCount.const, 10);
  assert.equal(schema.$defs.toolchain.properties.n3Version.const, '2.1.1');
  assert.equal(schema.$defs.flattenedClosure.additionalProperties, false);
  assert.equal(schema.properties.gates.minItems, 3);
  assert.equal(schema.properties.gates.maxItems, 3);
  assert.equal(schema.properties.negativeReasonerCorpus.minItems, 4);
  assert.equal(schema.properties.negativeReasonerCorpus.maxItems, 4);
  assert.ok(schema.$defs.negativeReasonerResult.required.includes('diagnosticCode'));
});
