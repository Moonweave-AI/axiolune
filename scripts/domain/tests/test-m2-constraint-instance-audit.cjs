'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const {
  auditConstraintInstanceClosure,
  constraintInstanceId,
} = require('../lib/m2-constraint-instance-audit.cjs');

const RULE = 'https://example.test/ontology/Rule';
const TARGET_A = 'https://example.test/ontology/TargetA';
const TARGET_B = 'https://example.test/ontology/TargetB';
const COMPONENT_A = 'http://www.w3.org/ns/shacl#NodeConstraintComponent';
const COMPONENT_B = 'http://www.w3.org/ns/shacl#MinCountConstraintComponent';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function expectation(prefix, expectedResult, files) {
  const artifactPath = `tests/${prefix}.ttl`;
  const schemaPath = 'tests/fixture.schema.json';
  const artifact = Buffer.from(`<urn:${prefix}> <urn:p> <urn:o> .\n`, 'utf8');
  const schema = Buffer.from('{}', 'utf8');
  files.set(artifactPath, artifact);
  files.set(schemaPath, schema);
  return {
    fixtureId: prefix,
    artifactRef: { kind: 'path', root: 'sourceTree', path: artifactPath },
    artifactDigest: sha256(artifact),
    schemaRef: { kind: 'path', root: 'sourceTree', path: schemaPath },
    schemaDigest: sha256(schema),
    expectedResult,
  };
}

function entry(targetRef, component, files, suffix) {
  const value = {
    originKind: 'constraintDefinition',
    originRef: RULE,
    targetRef,
    component,
    severity: 'violation',
    generatedOrAuthored: 'authored',
    positiveExpectation: expectation(`${suffix}-positive`, 'conforms', files),
    negativeExpectation: expectation(`${suffix}-negative`, 'violates', files),
  };
  value.constraintInstanceId = constraintInstanceId(value);
  return value;
}

function syntheticFiles(entries) {
  const files = new Map();
  files.set('ontology/domain/finance/fixture/module.yaml', Buffer.from([
    'domain:',
    '  constraints:',
    '    Rule:',
    `      iri: ${RULE}`,
    '      expression:',
    '        language: Custom',
    '  constraintBindings:',
    `    - constraintRef: ${RULE}`,
    `      targetElement: ${TARGET_A}`,
    '      enforcementLevel: Mandatory',
    `    - constraintRef: ${RULE}`,
    `      targetElement: ${TARGET_B}`,
    '      enforcementLevel: Mandatory',
    '',
  ].join('\n'), 'utf8'));
  files.set('scripts/domain/run-domain-shacl.cjs', Buffer.from([
    'const MODULE_FIXTURES = {',
    "  'fixture': {",
    '  },',
    '};',
    '',
  ].join('\n'), 'utf8'));
  const hydrated = entries.map((specification, index) => entry(
    specification.targetRef,
    specification.component,
    files,
    `case-${index}`,
  )).sort((left, right) => Buffer.compare(
    Buffer.from(left.constraintInstanceId),
    Buffer.from(right.constraintInstanceId),
  ));
  const manifest = {
    schemaVersion: '1.0',
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    entries: hydrated,
  };
  files.set(
    'scripts/domain/release-profile/v0.3.0/constraint-instance-manifest.json',
    Buffer.from(canonicalJcs(manifest), 'utf8'),
  );
  return { files, entries: hydrated };
}

test('constraint instance IDs separate target and component contexts', () => {
  const files = new Map();
  const targetAComponentA = entry(TARGET_A, COMPONENT_A, files, 'one');
  const targetBComponentA = entry(TARGET_B, COMPONENT_A, files, 'two');
  const targetAComponentB = entry(TARGET_A, COMPONENT_B, files, 'three');
  assert.equal(new Set([
    targetAComponentA.constraintInstanceId,
    targetBComponentA.constraintInstanceId,
    targetAComponentB.constraintInstanceId,
  ]).size, 3);

  const severityOnly = structuredClone(targetAComponentA);
  severityOnly.severity = 'warning';
  assert.equal(
    constraintInstanceId(severityOnly),
    targetAComponentA.constraintInstanceId,
    'severity is deliberately outside the RFC stable-ID frame',
  );
});

test('one definition row cannot stand in for a second target binding', () => {
  const fixture = syntheticFiles([{ targetRef: TARGET_A, component: COMPONENT_A }]);
  const result = auditConstraintInstanceClosure({ files: fixture.files });
  assert.equal(result.authoredBindingCount, 2);
  assert.deepEqual(
    result.authoredBindingMissing.map((binding) => binding.targetRef),
    [TARGET_B],
  );
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_CONSTRAINT_INSTANCE_BINDING_CONTEXT_MISSING'
  )));
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_CONSTRAINT_INSTANCE_CONTEXTUAL_IR_REPLAY_REQUIRED'
  )));
});

test('normalized-IR inventory comparison rejects a missing second component', () => {
  const fixture = syntheticFiles([
    { targetRef: TARGET_A, component: COMPONENT_A },
    { targetRef: TARGET_B, component: COMPONENT_A },
  ]);
  const replayedContextInventory = [
    ...fixture.entries,
    {
      originKind: 'constraintDefinition',
      originRef: RULE,
      targetRef: TARGET_A,
      component: COMPONENT_B,
    },
  ];
  const result = auditConstraintInstanceClosure({
    files: fixture.files,
    replayedContextInventory,
  });
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_CONSTRAINT_INSTANCE_CONTEXT_INVENTORY_MISMATCH'
      && issue.message.includes('missing=1')
  )));
});

test('malformed expectations emit diagnostics instead of crashing the audit', () => {
  const fixture = syntheticFiles([{ targetRef: TARGET_A, component: COMPONENT_A }]);
  const manifestPath = 'scripts/domain/release-profile/v0.3.0/constraint-instance-manifest.json';
  const manifest = JSON.parse(fixture.files.get(manifestPath).toString('utf8'));
  manifest.entries[0].positiveExpectation = null;
  fixture.files.set(manifestPath, Buffer.from(canonicalJcs(manifest), 'utf8'));
  const result = auditConstraintInstanceClosure({ files: fixture.files });
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_CONSTRAINT_INSTANCE_EXPECTATION_SCHEMA'
  )));
});
