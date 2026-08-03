#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const yaml = require('js-yaml');
const {
  PROFILE_REF,
} = require('../lib/m2-constraint-instance-audit.cjs');
const {
  buildConstraintInstanceManifest,
} = require('../lib/m2-constraint-instance-builder.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');

const BASE = 'https://example.test/ontology/constraint-builder/';
const iri = (name) => `${BASE}${name}`;

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function element(localName, extras = {}) {
  return {
    iri: iri(localName),
    namespace: 'fixture',
    localName,
    label: localName,
    definition: `${localName} fixture definition`,
    ...extras,
  };
}

function document() {
  return {
    module: {
      moduleIri: 'https://example.test/ontology/constraint-builder',
      baseIri: BASE,
      preferredPrefix: 'fixture',
      version: '0.3.0',
      label: 'Constraint builder fixture',
      definition: 'Exercises authored and generated contextual instances.',
      imports: [],
      exports: [],
      status: 'draft',
      governance: {
        ownerRef: 'urn:axiolune:principal:test-owner',
        status: 'draft',
      },
    },
    domain: {
      objectTypes: {
        Thing: element('Thing', {
          attributeUses: [{ attribute: iri('name'), minCount: 1, maxCount: 1 }],
          patternBindings: [],
        }),
      },
      associationTypes: {},
      relationTypes: {},
      attributeTypes: {
        name: element('name', { valueType: 'string' }),
      },
      identifierTypes: {},
      codeLists: {},
      constraints: {
        Rule: element('Rule', {
          constraintType: 'Custom',
          scope: 'Object',
          expression: { language: 'Custom', expression: 'fixture-rule-v1' },
          severity: 'Error',
          message: 'fixture custom rule',
          targetElement: iri('Thing'),
        }),
      },
      relationUses: [],
      constraintBindings: [{
        constraintRef: iri('Rule'),
        targetElement: iri('Thing'),
        enforcementLevel: 'Mandatory',
      }],
    },
  };
}

function moduleTuple() {
  const value = document();
  return {
    path: 'ontology/domain/finance/fixture/module.yaml',
    bytes: Buffer.from(yaml.dump(value, { lineWidth: -1 }), 'utf8'),
    document: value,
  };
}

function routeFiles(module) {
  const shaclPath = 'scripts/domain/test-fixture-shacl.cjs';
  const customPath = 'scripts/domain/test-fixture-custom.cjs';
  const registryPath = 'scripts/domain/test-fixture-custom-registry.json';
  const shaclBytes = Buffer.from('shacl fixture', 'utf8');
  const customBytes = Buffer.from('custom fixture', 'utf8');
  const registryBytes = Buffer.from('{}', 'utf8');
  const route = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    executors: {
      SHACL: {
        entrypointRef: { kind: 'path', root: 'sourceTree', path: shaclPath },
        entrypointDigest: sha256(shaclBytes),
      },
      Custom: {
        entrypointRef: { kind: 'path', root: 'sourceTree', path: customPath },
        entrypointDigest: sha256(customBytes),
        registryRef: { kind: 'path', root: 'sourceTree', path: registryPath },
        registryDigest: sha256(registryBytes),
      },
    },
    modules: [{
      moduleName: 'fixture',
      moduleRef: { kind: 'path', root: 'sourceTree', path: module.path },
      moduleDigest: sha256(module.bytes),
      executionKinds: ['Custom', 'SHACL'],
    }],
  };
  return new Map([
    [shaclPath, shaclBytes],
    [customPath, customBytes],
    [registryPath, registryBytes],
    [
      'scripts/domain/release-profile/v0.3.0/constraint-instance-execution-routes.json',
      Buffer.from(canonicalJcs(route), 'utf8'),
    ],
  ]);
}

function expectation(instanceId, polarity, files) {
  const expectedResult = polarity === 'positive' ? 'conforms' : 'violates';
  const artifactPath = `tests/constraint-builder/${instanceId}-${polarity}.ttl`;
  const schemaPath = 'tests/constraint-builder/fixture.schema.json';
  const artifactBytes = Buffer.from(
    `<urn:${polarity}:${instanceId}> <urn:p> <urn:o> .\n`,
    'utf8',
  );
  const schemaBytes = Buffer.from('{}', 'utf8');
  files.set(artifactPath, artifactBytes);
  files.set(schemaPath, schemaBytes);
  return {
    fixtureId: `${instanceId}-${polarity}`,
    artifactRef: { kind: 'path', root: 'sourceTree', path: artifactPath },
    artifactDigest: sha256(artifactBytes),
    schemaRef: { kind: 'path', root: 'sourceTree', path: schemaPath },
    schemaDigest: sha256(schemaBytes),
    expectedResult,
  };
}

async function completeFixture() {
  const modules = [moduleTuple()];
  const files = routeFiles(modules[0]);
  const discovery = await buildConstraintInstanceManifest({ modules, files });
  assert.equal(discovery.outcome, 'incomplete');
  assert.equal(discovery.authoredCount, 1);
  assert.ok(discovery.generatedCount >= 3);
  const entries = discovery.instances.map((instance) => ({
    constraintInstanceId: instance.constraintInstanceId,
    positiveExpectation: expectation(instance.constraintInstanceId, 'positive', files),
    negativeExpectation: expectation(instance.constraintInstanceId, 'negative', files),
  }));
  return {
    modules,
    files,
    expectations: { schemaVersion: '1.0', profileRef: PROFILE_REF, entries },
    discovery,
  };
}

test('builder deterministically closes normalized IR with exact per-instance expectations', async () => {
  const fixture = await completeFixture();
  const first = await buildConstraintInstanceManifest(fixture);
  const second = await buildConstraintInstanceManifest(fixture);

  assert.equal(first.outcome, 'built');
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.manifest.entries.length, fixture.discovery.instanceCount);
  assert.equal(first.audit.contextualReplayVerified, true);
  assert.equal(first.audit.authoredBindingMissing.length, 0);
  assert.ok(first.issues.some((issue) => (
    issue.code === 'M2_SHACL_EXECUTION_INSTANCE_JOIN_REQUIRED'
  )));
});

test('builder rejects one missing component expectation with the exact stable ID', async () => {
  const fixture = await completeFixture();
  const removed = fixture.expectations.entries.pop();
  const result = await buildConstraintInstanceManifest(fixture);

  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.manifest, null);
  const issue = result.issues.find((candidate) => (
    candidate.code === 'M2_CONSTRAINT_INSTANCE_EXPECTATION_COVERAGE'
  ));
  assert.deepEqual(issue.missingIds, [removed.constraintInstanceId]);
  assert.deepEqual(issue.extraIds, []);
});

test('builder rejects a fixture digest that does not match source bytes', async () => {
  const fixture = await completeFixture();
  fixture.expectations.entries[0].negativeExpectation.artifactDigest =
    `sha256:${'0'.repeat(64)}`;
  const result = await buildConstraintInstanceManifest(fixture);

  assert.equal(result.outcome, 'invalid');
  assert.equal(result.manifest, null);
  assert.ok(result.issues.some((issue) => (
    issue.code === 'M2_CONSTRAINT_INSTANCE_EXPECTATION_DIGEST'
  )));
});

test('builder reports every current normalized-IR ID when no registry exists', async () => {
  const fixture = await completeFixture();
  const issue = fixture.discovery.issues.find((candidate) => (
    candidate.code === 'M2_CONSTRAINT_INSTANCE_EXPECTATIONS_MISSING'
  ));
  assert.equal(issue.missingIds.length, fixture.discovery.instanceCount);
  assert.deepEqual(
    [...issue.missingIds].sort(),
    [...fixture.discovery.instances.map((entry) => entry.constraintInstanceId)].sort(),
  );
});
