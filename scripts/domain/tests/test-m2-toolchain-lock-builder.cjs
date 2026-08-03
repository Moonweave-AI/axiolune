#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
  PROFILE_REF,
  buildReleaseToolchainLock,
} = require('../lib/m2-toolchain-lock-builder.cjs');
const { constraintInstanceId } = require('../lib/m2-constraint-instance-audit.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');

const CONSTRAINTS = [
  'https://example.test/ontology/RuleA',
  'https://example.test/ontology/RuleB',
];
const TARGETS = [
  'https://example.test/ontology/Target0',
  'https://example.test/ontology/Target1',
];
const CUSTOM_COMPONENT =
  'https://axiolune.ai/conformance/m2/0.3.0/components/CustomConstraintComponent';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function put(files, filePath, bytesOrValue) {
  const bytes = Buffer.isBuffer(bytesOrValue)
    ? bytesOrValue
    : Buffer.from(canonicalJcs(bytesOrValue), 'utf8');
  files.set(filePath, bytes);
  return {
    ref: { kind: 'path', root: 'sourceTree', path: filePath },
    digest: sha256(bytes),
  };
}

function fixture() {
  const files = new Map();
  files.set('ontology/domain/finance/fixture/module.yaml', Buffer.from([
    'domain:',
    '  constraints:',
    '    RuleA:',
    `      iri: ${CONSTRAINTS[0]}`,
    `      targetElement: ${TARGETS[0]}`,
    '      expression:',
    '        language: Custom',
    '    RuleB:',
    `      iri: ${CONSTRAINTS[1]}`,
    `      targetElement: ${TARGETS[1]}`,
    '      expression:',
    '        language: Custom',
    '  constraintBindings:',
    `    - constraintRef: ${CONSTRAINTS[0]}`,
    `      targetElement: ${TARGETS[0]}`,
    `    - constraintRef: ${CONSTRAINTS[1]}`,
    `      targetElement: ${TARGETS[1]}`,
    '',
  ].join('\n'), 'utf8'));
  const tool = put(files, 'scripts/tool.cjs', Buffer.from('module.exports = {};\n'));
  const runtime = put(files, 'scripts/runtime.json', { schemaVersion: '1.0' });
  const entrypoint = put(files, 'scripts/entrypoint.cjs', Buffer.from('process.exitCode = 0;\n'));
  const entries = CONSTRAINTS.map((constraintIri, index) => {
    const discovery = put(files, `contracts/${index}-discovery.json`, {
      schemaVersion: '1.0',
      subjectCount: 1,
      subjects: [{
        constraintIri,
        contextCount: 1,
        contexts: [{
          constraintInstanceId: constraintInstanceId({
            originKind: 'constraintDefinition',
            originRef: constraintIri,
            targetRef: TARGETS[index],
            component: CUSTOM_COMPONENT,
          }),
          targetRef: TARGETS[index],
        }],
      }],
    });
    const evidenceSchema = put(files, `contracts/${index}-evidence.json`, {
      type: 'object',
      properties: {
        constraintIri: { const: constraintIri },
        semanticOwner: { const: constraintIri },
      },
    });
    const componentBindings = {
      subjectDiscoveryComponent: discovery,
      evidenceResultComponent: evidenceSchema,
    };
    const inputContract = put(files, `contracts/${index}-input.json`, {
      schemaVersion: '1.0', constraintIri, ...componentBindings,
    });
    const outputContract = put(files, `contracts/${index}-output.json`, {
      schemaVersion: '1.0', constraintIri, ...componentBindings,
    });
    const categories = {};
    for (const category of [
      'positive', 'violation', 'tamper', 'emptySubject', 'engineFailure',
    ]) {
      const input = put(files, `vectors/${index}-${category}.json`, {
        schemaVersion: '1.0', category, constraintIri,
      });
      const engineFailure = ['tamper', 'emptySubject', 'engineFailure'].includes(category);
      categories[category] = [{
        caseId: `${index}-${category}`,
        category,
        inputRef: input.ref,
        inputDigest: input.digest,
        expected: {
          caseStatus: 'passed',
          status: engineFailure ? 'engineFailure' : 'completed',
          outcome: category === 'positive' ? 'accepted'
            : category === 'violation' ? 'violation' : 'engineFailure',
          code: category === 'positive' ? null
            : category === 'violation' ? 'FIXTURE_VIOLATION' : 'ENGINE_FAILURE',
          semanticOwner: constraintIri,
        },
      }];
    }
    const testVectors = put(files, `vectors/${index}.json`, {
      schemaVersion: '1.0',
      profileRef: PROFILE_REF,
      constraintIri,
      categories,
    });
    const capability = put(files, `capabilities/${index}.json`, {
      schemaVersion: '1.0',
      capabilityId: constraintIri,
      constraintIri,
      inputContract,
      outputContract,
      ...componentBindings,
      testVectors,
    });
    return {
      constraintIri,
      toolId: 'fixture-custom-runtime',
      toolVersion: '1.0.0',
      toolArtifactRef: tool.ref,
      toolArtifactDigest: tool.digest,
      runtimeRef: runtime.ref,
      runtimeDigest: runtime.digest,
      capabilityRef: capability.ref,
      capabilityDigest: capability.digest,
      entrypointRef: entrypoint.ref,
      entrypointDigest: entrypoint.digest,
      inputContractRef: inputContract.ref,
      inputContractDigest: inputContract.digest,
      outputContractRef: outputContract.ref,
      outputContractDigest: outputContract.digest,
      discoveryContractRef: discovery.ref,
      discoveryContractDigest: discovery.digest,
      evidenceSchemaRef: evidenceSchema.ref,
      evidenceSchemaDigest: evidenceSchema.digest,
      testVectorsRef: testVectors.ref,
      testVectorsDigest: testVectors.digest,
    };
  });
  return {
    files,
    registry: { schemaVersion: '1.0', profileRef: PROFILE_REF, entries },
    expectedModuleCount: 1,
    expectedConstraintCount: 2,
    expectedContextCount: 2,
  };
}

test('single release toolchain lock is deterministic after exact capability closure', () => {
  const value = fixture();
  const first = buildReleaseToolchainLock(value);
  const second = buildReleaseToolchainLock(value);

  assert.equal(first.outcome, 'built');
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.lock.tools.length, 1);
  assert.deepEqual(
    first.lock.tools[0].capabilities.map((capability) => capability.capabilityId),
    CONSTRAINTS,
  );
  assert.deepEqual(first.issues, []);
});

test('missing release registry reports the exact Custom constraint set', () => {
  const value = fixture();
  delete value.registry;
  const result = buildReleaseToolchainLock(value);
  const issue = result.issues.find((candidate) => (
    candidate.code === 'M2_TOOLCHAIN_BUILDER_REGISTRY_MISSING'
  ));

  assert.equal(result.outcome, 'incomplete');
  assert.deepEqual(issue.missingCapabilityIris, CONSTRAINTS);
  assert.equal(result.bytes, null);
});

test('one missing capability binding blocks lock creation with its exact IRI', () => {
  const value = fixture();
  value.registry.entries.pop();
  const result = buildReleaseToolchainLock(value);
  const issue = result.issues.find((candidate) => (
    candidate.code === 'M2_TOOLCHAIN_BUILDER_COVERAGE'
  ));

  assert.equal(result.outcome, 'incomplete');
  assert.deepEqual(issue.missingCapabilityIris, [CONSTRAINTS[1]]);
  assert.deepEqual(issue.extraCapabilityIris, []);
});

test('source artifact digest substitution blocks lock creation', () => {
  const value = fixture();
  value.registry.entries[0].entrypointDigest = `sha256:${'0'.repeat(64)}`;
  const result = buildReleaseToolchainLock(value);

  assert.equal(result.outcome, 'incomplete');
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_TOOLCHAIN_BUILDER_ARTIFACT_DIGEST'
  )));
  assert.equal(result.bytes, null);
});

test('positive and negative vectors cannot reuse one input artifact', () => {
  const value = fixture();
  const entry = value.registry.entries[0];
  const vectorPath = entry.testVectorsRef.path;
  const vectors = JSON.parse(value.files.get(vectorPath).toString('utf8'));
  vectors.categories.violation[0].inputRef =
    structuredClone(vectors.categories.positive[0].inputRef);
  vectors.categories.violation[0].inputDigest = vectors.categories.positive[0].inputDigest;
  const bytes = Buffer.from(canonicalJcs(vectors), 'utf8');
  value.files.set(vectorPath, bytes);
  entry.testVectorsDigest = sha256(bytes);

  const result = buildReleaseToolchainLock(value);
  assert.equal(result.outcome, 'incomplete');
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_CUSTOM_CONSTRAINT_VECTOR_REUSE'
  )));
});

test('ontology Custom target mutation invalidates the generated discovery context binding', () => {
  const value = fixture();
  const modulePath = 'ontology/domain/finance/fixture/module.yaml';
  const mutated = value.files.get(modulePath).toString('utf8').replaceAll(
    TARGETS[0],
    'https://example.test/ontology/TamperedTarget',
  );
  value.files.set(modulePath, Buffer.from(mutated, 'utf8'));

  const result = buildReleaseToolchainLock(value);
  assert.equal(result.outcome, 'incomplete');
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_CUSTOM_CONSTRAINT_CONTEXT_BINDING'
  )));
});

test('one toolId cannot hide conflicting versions or runtime bindings', () => {
  const value = fixture();
  value.registry.entries[1].toolVersion = '2.0.0';
  const result = buildReleaseToolchainLock(value);

  assert.equal(result.outcome, 'incomplete');
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_TOOLCHAIN_BUILDER_TOOL_CONFLICT'
  )));
});
