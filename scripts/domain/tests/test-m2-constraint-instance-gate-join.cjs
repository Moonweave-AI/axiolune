#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  PROFILE_REF,
  expectedInputDigests,
  taggedJcsDigest,
  verifyConstraintInstanceGateJoin,
} = require('../lib/m2-constraint-instance-gate-join.cjs');

function digest(seed) {
  return `sha256:${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

function artifactRef(filePath) {
  return { kind: 'path', root: 'sourceTree', path: filePath };
}

function expectation(id, polarity) {
  return {
    fixtureId: `${id}-${polarity}`,
    artifactRef: artifactRef(`tests/${id}-${polarity}.ttl`),
    artifactDigest: digest(`${id}-${polarity}-artifact`),
    schemaRef: artifactRef('tests/constraint-instance-fixture.schema.json'),
    schemaDigest: digest('fixture-schema'),
    expectedResult: polarity === 'positive' ? 'conforms' : 'violates',
  };
}

function manifestEntry(id) {
  return {
    constraintInstanceId: id,
    originKind: 'generatedConstraint',
    originRef: `https://example.test/constraints/${id}`,
    targetRef: `https://example.test/targets/${id}`,
    component: 'http://www.w3.org/ns/shacl#MinCountConstraintComponent',
    severity: 'violation',
    generatedOrAuthored: 'generated',
    positiveExpectation: expectation(id, 'positive'),
    negativeExpectation: expectation(id, 'negative'),
  };
}

function fixture() {
  const ids = ['a'.repeat(64), 'b'.repeat(64)];
  const manifest = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    entries: ids.map(manifestEntry),
  };
  const items = manifest.entries.map((entry, index) => ({
    constraintInstanceId: entry.constraintInstanceId,
    positiveExpectation: structuredClone(entry.positiveExpectation),
    negativeExpectation: structuredClone(entry.negativeExpectation),
    subjectId: digest(`subject-id-${index}`),
    subjectRef: artifactRef(`build/constraint-instance-${index}.json`),
    subjectDigest: digest(`subject-bytes-${index}`),
  }));
  const discovery = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    gateId: 'shacl-execution',
    manifestDigest: taggedJcsDigest(
      'axiolune-constraint-instance-manifest-v1\0',
      manifest,
    ),
    items,
  };
  const subjectInventory = {
    subjects: items
      .map((item) => ({
        subjectId: item.subjectId,
        subjectRef: structuredClone(item.subjectRef),
        subjectDigest: item.subjectDigest,
        classifier: 'constraintInstance',
      }))
      .sort((left, right) => Buffer.compare(
        Buffer.from(left.subjectId), Buffer.from(right.subjectId),
      )),
  };
  const checks = manifest.entries.map((entry, index) => ({
    checkId: entry.constraintInstanceId,
    subjectId: items[index].subjectId,
    subjectRef: structuredClone(items[index].subjectRef),
    subjectDigest: items[index].subjectDigest,
    inputDigests: expectedInputDigests(entry),
    status: 'passed',
  }));
  const report = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    gateId: 'shacl-execution',
    counts: {
      discovered: 2,
      executed: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
      pending: 0,
      warnings: 0,
    },
    result: { outcome: 'passed', checks },
  };
  return { manifest, discovery, subjectInventory, report };
}

test('exact manifest/discovery/inventory/GateCheck join passes', () => {
  const result = verifyConstraintInstanceGateJoin(fixture());
  assert.equal(result.outcome, 'passed');
  assert.equal(result.itemCount, 2);
  assert.equal(result.checkCount, 2);
  assert.deepEqual(result.issues, []);
});

test('one missing discovered item and GateCheck is fatal', () => {
  const value = fixture();
  value.discovery.items.pop();
  value.subjectInventory.subjects = value.subjectInventory.subjects.filter((subject) => (
    subject.subjectId === value.discovery.items[0].subjectId
  ));
  value.report.result.checks.pop();
  value.report.counts.discovered = 1;
  value.report.counts.executed = 1;
  value.report.counts.passed = 1;
  const result = verifyConstraintInstanceGateJoin(value);

  assert.equal(result.outcome, 'invalid');
  assert.ok(result.issues.filter((issue) => (
    issue.code === 'M2_SHACL_INSTANCE_JOIN_SET'
  )).length >= 2);
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_SHACL_INSTANCE_REPORT_COUNTS'
  )));
});

test('discovered fixture identity or digest cannot drift from the manifest', () => {
  const value = fixture();
  value.discovery.items[0].negativeExpectation.fixtureId = 'substituted-negative';
  const result = verifyConstraintInstanceGateJoin(value);
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_SHACL_INSTANCE_DISCOVERY_EXPECTATION'
  )));
});

test('GateCheck must bind every positive and negative fixture/schema digest', () => {
  const value = fixture();
  const required = expectedInputDigests(value.manifest.entries[0]);
  value.report.result.checks[0].inputDigests = required.slice(1);
  const result = verifyConstraintInstanceGateJoin(value);
  const issue = result.issues.find((candidate) => (
    candidate.code === 'M2_SHACL_INSTANCE_GATECHECK_INPUTS'
  ));
  assert.deepEqual(issue.missingDigests, [required[0]]);
});

test('GateCheck cannot be joined to another discovered subject', () => {
  const value = fixture();
  value.report.result.checks[0].subjectId = value.discovery.items[1].subjectId;
  const result = verifyConstraintInstanceGateJoin(value);
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_SHACL_INSTANCE_GATECHECK_SUBJECT'
  )));
});
