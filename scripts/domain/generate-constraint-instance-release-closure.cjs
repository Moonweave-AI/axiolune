#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  EXPECTATIONS_PATH,
  MANIFEST_PATH,
  buildConstraintInstanceManifest,
} = require('./lib/m2-constraint-instance-builder.cjs');
const {
  EXECUTION_ROUTES_PATH,
  PROFILE_REF,
  auditConstraintInstanceClosure,
} = require('./lib/m2-constraint-instance-audit.cjs');
const {
  taggedJcsDigest,
  verifyConstraintInstanceGateJoin,
} = require('./lib/m2-constraint-instance-gate-join.cjs');
const {
  CONSTRAINT_GATE_PATHS,
  CONSTRAINT_GATE_ROOT,
  CUSTOM_EVIDENCE_MANIFEST_PATH,
  CUSTOM_EVIDENCE_PATH,
  CUSTOM_RUN_ROUND,
  EXPECTED_COUNTS,
  SHACL_RUN_MANIFEST_PATH,
  SHACL_RUN_ROUND,
} = require('./lib/m2-constraint-instance-profile.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const CUSTOM_COMPONENT =
  'https://axiolune.ai/conformance/m2/0.3.0/components/CustomConstraintComponent';
const REGISTRY_PATH =
  'scripts/domain/release-profile/v0.3.0/custom-capability-bindings.json';
const CUSTOM_SCHEMA_PATH =
  'scripts/domain/release-profile/v0.3.0/custom-constraint-instance-expectation.schema.json';
const SHACL_RUN_PATH = SHACL_RUN_MANIFEST_PATH;
const OUTPUT_ROOT = CONSTRAINT_GATE_ROOT;
const OUTPUT_PATHS = CONSTRAINT_GATE_PATHS;
const SHACL_SEVERITY = Object.freeze({
  violation: 'http://www.w3.org/ns/shacl#Violation',
  warning: 'http://www.w3.org/ns/shacl#Warning',
  info: 'http://www.w3.org/ns/shacl#Info',
});

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function ref(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function absolute(relativePath) {
  return path.join(ROOT, ...relativePath.split('/'));
}

function readBytes(relativePath) {
  return fs.readFileSync(absolute(relativePath));
}

function readJcs(relativePath) {
  const bytes = readBytes(relativePath);
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${relativePath} is not exact UTF-8 RFC 8785 JCS`);
  }
  return { bytes, value, digest: sha256(bytes), ref: ref(relativePath) };
}

function artifact(relativePath, bytes) {
  return { ref: ref(relativePath), digest: sha256(bytes), bytes };
}

function assertEqual(actual, expected, label) {
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    throw new Error(`${label} differs from the exact expected value`);
  }
}

function indexUnique(rows, key, label) {
  const result = new Map();
  for (const row of rows) {
    const value = key(row);
    if (result.has(value)) throw new Error(`${label} contains duplicate ${value}`);
    result.set(value, row);
  }
  return result;
}

function assertSet(actual, expected, label) {
  const left = [...actual].sort(byteCompare);
  const right = [...expected].sort(byteCompare);
  if (canonicalJcs(left) !== canonicalJcs(right)) {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    const missing = right.filter((value) => !leftSet.has(value));
    const extra = left.filter((value) => !rightSet.has(value));
    throw new Error(`${label} set differs: missing=${missing.length}, extra=${extra.length}`);
  }
}

function verifyArtifactBinding(binding, loaded, label) {
  if (canonicalJcs(binding.artifactRef) !== canonicalJcs(loaded.ref)
      || binding.artifactDigest !== loaded.digest
      || binding.byteLength !== loaded.bytes.length) {
    throw new Error(`${label} run-manifest artifact binding differs from current bytes`);
  }
}

function verifyShaclEvidence(instances) {
  const run = readJcs(SHACL_RUN_PATH);
  if (run.value.outcome !== 'shacl-passed-custom-unresolved'
      || run.value.constraintInventory?.descriptorCount !== EXPECTED_COUNTS.entryCount
      || run.value.constraintInventory?.shaclCount !== EXPECTED_COUNTS.shaclInstanceCount
      || run.value.constraintInventory?.customCount !== EXPECTED_COUNTS.customInstanceCount
      || run.value.executionSummary?.passed !== EXPECTED_COUNTS.shaclInstanceCount
      || run.value.executionSummary?.failed !== 0
      || run.value.executionSummary?.pending !== 0
      || run.value.executionSummary?.skipped !== 0
      || run.value.executionSummary?.engineFailures !== 0) {
    throw new Error(
      `SHACL round-${SHACL_RUN_ROUND} manifest does not prove the exact `
        + `${EXPECTED_COUNTS.shaclInstanceCount}/${EXPECTED_COUNTS.customInstanceCount} split`,
    );
  }
  for (const source of run.value.sourceSnapshot) {
    const bytes = readBytes(source.path);
    if (sha256(bytes) !== source.digest) {
      throw new Error(`SHACL round-${SHACL_RUN_ROUND} source snapshot is stale at ${source.path}`);
    }
  }
  const positive = readJcs(run.value.artifacts.positiveFixtures.artifactRef.path);
  const negative = readJcs(run.value.artifacts.negativeFixtures.artifactRef.path);
  const execution = readJcs(run.value.artifacts.executionEvidence.artifactRef.path);
  const unresolved = readJcs(run.value.artifacts.unresolvedCustom.artifactRef.path);
  const schema = {
    ref: run.value.artifacts.fixtureSchema.artifactRef,
    digest: run.value.artifacts.fixtureSchema.artifactDigest,
    bytes: readBytes(run.value.artifacts.fixtureSchema.artifactRef.path),
  };
  verifyArtifactBinding(run.value.artifacts.positiveFixtures, positive, 'positive SHACL fixtures');
  verifyArtifactBinding(run.value.artifacts.negativeFixtures, negative, 'negative SHACL fixtures');
  verifyArtifactBinding(run.value.artifacts.executionEvidence, execution, 'SHACL execution evidence');
  verifyArtifactBinding(run.value.artifacts.unresolvedCustom, unresolved, 'unresolved Custom inventory');
  if (sha256(schema.bytes) !== schema.digest) throw new Error('SHACL fixture schema digest drift');

  const shaclInstances = instances.filter((row) => row.component !== CUSTOM_COMPONENT);
  const customInstances = instances.filter((row) => row.component === CUSTOM_COMPONENT);
  if (shaclInstances.length !== EXPECTED_COUNTS.shaclInstanceCount
      || customInstances.length !== EXPECTED_COUNTS.customInstanceCount) {
    throw new Error(
      `live normalized IR is not ${EXPECTED_COUNTS.shaclInstanceCount} SHACL + `
        + `${EXPECTED_COUNTS.customInstanceCount} Custom: `
        + `${shaclInstances.length}/${customInstances.length}`,
    );
  }
  const positiveById = indexUnique(positive.value.cases, (row) => row.constraintInstanceId, 'positive SHACL fixtures');
  const negativeById = indexUnique(negative.value.cases, (row) => row.constraintInstanceId, 'negative SHACL fixtures');
  const executionById = indexUnique(execution.value.results, (row) => row.constraintInstanceId, 'SHACL execution evidence');
  assertSet(positiveById.keys(), shaclInstances.map((row) => row.constraintInstanceId), 'positive SHACL fixture');
  assertSet(negativeById.keys(), shaclInstances.map((row) => row.constraintInstanceId), 'negative SHACL fixture');
  assertSet(executionById.keys(), shaclInstances.map((row) => row.constraintInstanceId), 'SHACL execution');
  for (const instance of shaclInstances) {
    const id = instance.constraintInstanceId;
    const positiveCase = positiveById.get(id);
    const negativeCase = negativeById.get(id);
    const result = executionById.get(id);
    for (const [polarity, fixture, expectedResult] of [
      ['positive', positiveCase, 'conforms'], ['negative', negativeCase, 'violates'],
    ]) {
      if (fixture.fixtureId !== `${id}-${polarity}`
          || fixture.expectedResult !== expectedResult
          || fixture.expectedComponent !== instance.component
          || fixture.expectedSeverity !== SHACL_SEVERITY[instance.severity]
          || typeof fixture.focusNode !== 'string' || fixture.focusNode.length === 0) {
        throw new Error(`${id}/${polarity} SHACL expectation identity differs from normalized IR`);
      }
      if (instance.pathKind === 'iri' && fixture.expectedPath !== instance.path) {
        throw new Error(`${id}/${polarity} SHACL expectation path differs from normalized IR`);
      }
    }
    if (result.outcome !== 'passed'
        || result.positive?.fixtureId !== positiveCase.fixtureId
        || result.positive?.outcome !== 'conforms'
        || result.positive?.engineError !== null
        || result.negative?.fixtureId !== negativeCase.fixtureId
        || result.negative?.outcome !== 'violates'
        || result.negative?.engineError !== null
        || result.negative?.rootResultCount !== 1
        || result.negative?.results?.[0]?.sourceConstraintComponent !== instance.component
        || result.negative?.results?.[0]?.resultSeverity !== SHACL_SEVERITY[instance.severity]) {
      throw new Error(`${id} SHACL positive/negative execution is not an exact pass`);
    }
  }
  const unresolvedById = indexUnique(
    unresolved.value.entries, (row) => row.constraintInstanceId, 'unresolved Custom inventory',
  );
  assertSet(unresolvedById.keys(), customInstances.map((row) => row.constraintInstanceId), 'unresolved Custom');
  for (const instance of customInstances) {
    const unresolvedRow = unresolvedById.get(instance.constraintInstanceId);
    const context = { ...instance };
    delete context.constraintInstanceId;
    assertEqual(unresolvedRow.context, context, `${instance.constraintInstanceId} unresolved Custom context`);
  }
  return {
    run, positive, negative, execution, unresolved, schema,
    shaclInstances, customInstances,
  };
}

function verifyCustomEvidence(customInstances) {
  const registry = readJcs(REGISTRY_PATH);
  const evidence = readJcs(CUSTOM_EVIDENCE_PATH);
  const evidenceManifest = readJcs(CUSTOM_EVIDENCE_MANIFEST_PATH);
  if (evidenceManifest.value.evidenceDigest !== evidence.digest
      || canonicalJcs(evidenceManifest.value.evidenceRef) !== canonicalJcs(evidence.ref)
      || evidenceManifest.value.evidenceByteLength !== evidence.bytes.length) {
    throw new Error(`Custom round-${CUSTOM_RUN_ROUND} evidence manifest differs from evidence bytes`);
  }
  const expectedCustomDefinitions = registry.value.entries.length;
  const expectedCustomCases = expectedCustomDefinitions * 5;
  if (evidence.value.outcome !== 'passed' || evidence.value.definitionCount !== expectedCustomDefinitions
      || evidence.value.contextCount !== EXPECTED_COUNTS.customInstanceCount
      || evidence.value.caseCount !== expectedCustomCases
      || evidence.value.passedCaseCount !== expectedCustomCases || evidence.value.failedCaseCount !== 0
      || evidence.value.pendingCaseCount !== 0 || evidence.value.skippedCaseCount !== 0
      || evidence.value.registryDigest !== registry.digest
      || evidence.value.runtime?.engine !== 'node' || evidence.value.runtime?.version !== '24.18.0') {
    throw new Error(
      `Custom round-${CUSTOM_RUN_ROUND} evidence does not prove exact `
        + `${expectedCustomDefinitions}/${EXPECTED_COUNTS.customInstanceCount}/${expectedCustomCases} closure`,
    );
  }
  const entriesByIri = indexUnique(registry.value.entries, (row) => row.constraintIri, 'Custom registry');
  const rowsByCase = indexUnique(evidence.value.rows, (row) => row.caseId, 'Custom evidence');
  const contextsById = new Map();
  const verifiedCases = new Map();
  for (const entry of registry.value.entries) {
    const vectorBytes = readBytes(entry.testVectorsRef.path);
    if (sha256(vectorBytes) !== entry.testVectorsDigest) throw new Error(`${entry.constraintIri} vectors drifted`);
    const vectors = JSON.parse(vectorBytes.toString('utf8'));
    if (vectors.categories.positive.length !== 1 || vectors.categories.violation.length !== 1) {
      throw new Error(`${entry.constraintIri} lacks one exact positive/violation vector`);
    }
    const byPolarity = {};
    for (const [polarity, category] of [['positive', 'positive'], ['negative', 'violation']]) {
      const vector = vectors.categories[category][0];
      const row = rowsByCase.get(vector.caseId);
      if (!row || row.category !== category || row.constraintIri !== entry.constraintIri
          || row.inputDigest !== vector.inputDigest || row.status !== vector.expected.status
          || row.outcome !== vector.expected.outcome || row.code !== vector.expected.code
          || row.semanticOwner !== entry.constraintIri) {
        throw new Error(`${entry.constraintIri}/${category} execution evidence differs from its vector`);
      }
      const inputBytes = readBytes(vector.inputRef.path);
      if (sha256(inputBytes) !== vector.inputDigest) throw new Error(`${vector.caseId} input bytes drifted`);
      byPolarity[polarity] = { vector, row };
    }
    verifiedCases.set(entry.constraintIri, byPolarity);
    const discoveryBytes = readBytes(entry.discoveryContractRef.path);
    if (sha256(discoveryBytes) !== entry.discoveryContractDigest) throw new Error(`${entry.constraintIri} discovery drifted`);
    const discovery = JSON.parse(discoveryBytes.toString('utf8'));
    if (discovery.subjectCount !== 1 || discovery.subjects?.length !== 1
        || discovery.subjects[0].constraintIri !== entry.constraintIri
        || discovery.subjects[0].contextCount !== discovery.subjects[0].contexts.length) {
      throw new Error(`${entry.constraintIri} discovery is not a closed singleton subject`);
    }
    for (const context of discovery.subjects[0].contexts) {
      if (contextsById.has(context.constraintInstanceId)) throw new Error(`duplicate Custom context ${context.constraintInstanceId}`);
      contextsById.set(context.constraintInstanceId, {
        originRef: entry.constraintIri,
        targetRef: context.targetRef,
      });
    }
  }
  assertSet(contextsById.keys(), customInstances.map((row) => row.constraintInstanceId), 'Custom discovery');
  for (const instance of customInstances) {
    const context = contextsById.get(instance.constraintInstanceId);
    if (context.originRef !== instance.originRef || context.targetRef !== instance.targetRef
        || !entriesByIri.has(instance.originRef)) {
      throw new Error(`${instance.constraintInstanceId} Custom discovery/context binding differs`);
    }
  }
  return { registry, evidence, evidenceManifest, verifiedCases };
}

function customExpectationArtifacts(customInstances, custom) {
  const make = (polarity, expectedResult) => ({
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    artifactKind: 'customConstraintInstanceExpectationAggregate',
    polarity,
    sourceEvidenceRef: custom.evidence.ref,
    sourceEvidenceDigest: custom.evidence.digest,
    registryRef: custom.registry.ref,
    registryDigest: custom.registry.digest,
    cases: customInstances.map((instance) => {
      const verified = custom.verifiedCases.get(instance.originRef)[polarity];
      return {
        constraintInstanceId: instance.constraintInstanceId,
        fixtureId: `${instance.constraintInstanceId}-${polarity}`,
        originRef: instance.originRef,
        targetRef: instance.targetRef,
        sourceCaseId: verified.vector.caseId,
        inputRef: verified.vector.inputRef,
        inputDigest: verified.vector.inputDigest,
        evidenceRowDigest: sha256(Buffer.from(canonicalJcs(verified.row), 'utf8')),
        expectedResult,
      };
    }),
  });
  const positiveBytes = Buffer.from(canonicalJcs(make('positive', 'conforms')), 'utf8');
  const negativeBytes = Buffer.from(canonicalJcs(make('negative', 'violates')), 'utf8');
  return {
    positive: artifact(OUTPUT_PATHS.customPositive, positiveBytes),
    negative: artifact(OUTPUT_PATHS.customNegative, negativeBytes),
  };
}

function executionRoutes(instances, custom) {
  const shaclPath = 'scripts/domain/run-m2-shacl-instance-closure.cjs';
  const customPath = 'scripts/domain/verify-custom-release-capabilities.cjs';
  const moduleNames = fs.readdirSync(absolute('ontology/domain/finance'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && fs.existsSync(absolute(`ontology/domain/finance/${entry.name}/module.yaml`)))
    .map((entry) => entry.name)
    .sort(byteCompare);
  if (moduleNames.length !== 10) throw new Error(`route manifest requires 10 modules; found ${moduleNames.length}`);
  const value = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    executors: {
      SHACL: { entrypointRef: ref(shaclPath), entrypointDigest: sha256(readBytes(shaclPath)) },
      Custom: {
        entrypointRef: ref(customPath), entrypointDigest: sha256(readBytes(customPath)),
        registryRef: custom.registry.ref, registryDigest: custom.registry.digest,
      },
    },
    modules: moduleNames.map((moduleName) => {
      const modulePath = `ontology/domain/finance/${moduleName}/module.yaml`;
      return {
        moduleName,
        moduleRef: ref(modulePath),
        moduleDigest: sha256(readBytes(modulePath)),
        executionKinds: ['Custom', 'SHACL'],
      };
    }),
  };
  return artifact(EXECUTION_ROUTES_PATH, Buffer.from(canonicalJcs(value), 'utf8'));
}

function expectationRegistry(instances, shacl, customArtifacts, schema) {
  const entries = instances.map((instance) => {
    const isCustom = instance.component === CUSTOM_COMPONENT;
    return {
      constraintInstanceId: instance.constraintInstanceId,
      positiveExpectation: {
        fixtureId: `${instance.constraintInstanceId}-positive`,
        artifactRef: isCustom ? customArtifacts.positive.ref : shacl.positive.ref,
        artifactDigest: isCustom ? customArtifacts.positive.digest : shacl.positive.digest,
        schemaRef: isCustom ? schema.ref : shacl.schema.ref,
        schemaDigest: isCustom ? schema.digest : shacl.schema.digest,
        expectedResult: 'conforms',
      },
      negativeExpectation: {
        fixtureId: `${instance.constraintInstanceId}-negative`,
        artifactRef: isCustom ? customArtifacts.negative.ref : shacl.negative.ref,
        artifactDigest: isCustom ? customArtifacts.negative.digest : shacl.negative.digest,
        schemaRef: isCustom ? schema.ref : shacl.schema.ref,
        schemaDigest: isCustom ? schema.digest : shacl.schema.digest,
        expectedResult: 'violates',
      },
    };
  });
  return { schemaVersion: '1.0', profileRef: PROFILE_REF, entries };
}

function subjectId(entry, subjectRef, subjectDigest) {
  return taggedJcsDigest('axiolune-constraint-instance-subject-v1\0', {
    constraintInstanceId: entry.constraintInstanceId,
    subjectRef,
    subjectDigest,
  });
}

function gateArtifacts(manifest, shacl, custom, customArtifacts) {
  const manifestDigest = taggedJcsDigest(
    'axiolune-constraint-instance-manifest-v1\0', manifest,
  );
  const items = [];
  const subjects = [];
  const checks = [];
  for (const entry of manifest.entries) {
    const isCustom = entry.component === CUSTOM_COMPONENT;
    const subjectRef = entry.positiveExpectation.artifactRef;
    const subjectDigest = entry.positiveExpectation.artifactDigest;
    const id = subjectId(entry, subjectRef, subjectDigest);
    items.push({
      constraintInstanceId: entry.constraintInstanceId,
      positiveExpectation: entry.positiveExpectation,
      negativeExpectation: entry.negativeExpectation,
      subjectId: id,
      subjectRef,
      subjectDigest,
    });
    subjects.push({ subjectId: id, subjectRef, subjectDigest, classifier: 'constraintInstance' });
    checks.push({
      checkId: entry.constraintInstanceId,
      status: 'passed',
      subjectId: id,
      subjectRef,
      subjectDigest,
      inputDigests: [...new Set([
        entry.positiveExpectation.artifactDigest,
        entry.positiveExpectation.schemaDigest,
        entry.negativeExpectation.artifactDigest,
        entry.negativeExpectation.schemaDigest,
        isCustom ? custom.evidence.digest : shacl.execution.digest,
        ...(isCustom ? [custom.registry.digest] : []),
      ])].sort(byteCompare),
    });
  }
  subjects.sort((left, right) => byteCompare(left.subjectId, right.subjectId));
  const discovery = {
    schemaVersion: '1.0', profileRef: PROFILE_REF, gateId: 'shacl-execution',
    manifestDigest, items,
  };
  const subjectInventory = {
    schemaVersion: '1.0', profileRef: PROFILE_REF, gateId: 'shacl-execution', subjects,
  };
  const report = {
    schemaVersion: '1.0', profileRef: PROFILE_REF, gateId: 'shacl-execution',
    counts: {
      discovered: manifest.entries.length, executed: manifest.entries.length,
      passed: manifest.entries.length, failed: 0, skipped: 0, pending: 0, warnings: 0,
    },
    result: { outcome: 'passed', checks },
  };
  const joined = verifyConstraintInstanceGateJoin({ manifest, discovery, subjectInventory, report });
  if (joined.outcome !== 'passed') throw new Error(`constraint-instance gate join failed: ${canonicalJcs(joined.issues)}`);
  const sourceEvidence = {
    schemaVersion: '1.0', profileRef: PROFILE_REF,
    artifactKind: 'constraintInstanceSourceEvidenceClosure', outcome: 'passed',
    counts: {
      total: EXPECTED_COUNTS.entryCount,
      shacl: EXPECTED_COUNTS.shaclInstanceCount,
      custom: EXPECTED_COUNTS.customInstanceCount,
    },
    shacl: {
      runManifestRef: shacl.run.ref, runManifestDigest: shacl.run.digest,
      executionEvidenceRef: shacl.execution.ref, executionEvidenceDigest: shacl.execution.digest,
    },
    custom: {
      evidenceRef: custom.evidence.ref, evidenceDigest: custom.evidence.digest,
      registryRef: custom.registry.ref, registryDigest: custom.registry.digest,
      positiveProjectionRef: customArtifacts.positive.ref,
      positiveProjectionDigest: customArtifacts.positive.digest,
      negativeProjectionRef: customArtifacts.negative.ref,
      negativeProjectionDigest: customArtifacts.negative.digest,
    },
  };
  return {
    discovery,
    subjectInventory,
    report,
    sourceEvidence,
    joined,
  };
}

function addSource(files, relativePath, bytes = null) {
  files.set(relativePath, bytes || readBytes(relativePath));
}

async function generateConstraintInstanceReleaseClosure() {
  const emptyExpectations = { schemaVersion: '1.0', profileRef: PROFILE_REF, entries: [] };
  const inventory = await buildConstraintInstanceManifest({
    sourceRoot: ROOT,
    expectations: emptyExpectations,
  });
  if (inventory.instanceCount !== EXPECTED_COUNTS.entryCount
      || inventory.authoredCount !== EXPECTED_COUNTS.authoredInstanceCount
      || inventory.generatedCount !== EXPECTED_COUNTS.generatedCount) {
    throw new Error(
      `live normalized IR must contain ${EXPECTED_COUNTS.entryCount} = `
        + `${EXPECTED_COUNTS.authoredInstanceCount} authored + `
        + `${EXPECTED_COUNTS.generatedCount} generated; `
        + `found ${inventory.instanceCount} = ${inventory.authoredCount} + ${inventory.generatedCount}`,
    );
  }
  const instances = inventory.instances;
  const shacl = verifyShaclEvidence(instances);
  const custom = verifyCustomEvidence(shacl.customInstances);
  const customArtifacts = customExpectationArtifacts(shacl.customInstances, custom);
  const routeArtifact = executionRoutes(instances, custom);
  const customSchema = artifact(CUSTOM_SCHEMA_PATH, readBytes(CUSTOM_SCHEMA_PATH));
  const expectations = expectationRegistry(instances, shacl, customArtifacts, customSchema);
  const expectationBytes = Buffer.from(canonicalJcs(expectations), 'utf8');

  const buildFiles = new Map();
  addSource(buildFiles, routeArtifact.ref.path, routeArtifact.bytes);
  addSource(buildFiles, customArtifacts.positive.ref.path, customArtifacts.positive.bytes);
  addSource(buildFiles, customArtifacts.negative.ref.path, customArtifacts.negative.bytes);
  addSource(buildFiles, CUSTOM_SCHEMA_PATH, customSchema.bytes);
  const built = await buildConstraintInstanceManifest({
    sourceRoot: ROOT,
    expectations,
    files: buildFiles,
  });
  if (built.outcome !== 'built'
      || built.instanceCount !== EXPECTED_COUNTS.entryCount || !built.manifest) {
    throw new Error(`constraint-instance manifest build failed: ${canonicalJcs(built.issues)}`);
  }
  const gate = gateArtifacts(built.manifest, shacl, custom, customArtifacts);
  const serializedGate = {
    discovery: artifact(OUTPUT_PATHS.discovery, Buffer.from(canonicalJcs(gate.discovery), 'utf8')),
    subjectInventory: artifact(OUTPUT_PATHS.subjectInventory, Buffer.from(canonicalJcs(gate.subjectInventory), 'utf8')),
    report: artifact(OUTPUT_PATHS.report, Buffer.from(canonicalJcs(gate.report), 'utf8')),
    sourceEvidence: artifact(OUTPUT_PATHS.sourceEvidence, Buffer.from(canonicalJcs(gate.sourceEvidence), 'utf8')),
  };

  const auditFiles = new Map(buildFiles);
  for (const moduleName of fs.readdirSync(absolute('ontology/domain/finance'))) {
    const modulePath = `ontology/domain/finance/${moduleName}/module.yaml`;
    if (fs.existsSync(absolute(modulePath))) addSource(auditFiles, modulePath);
  }
  addSource(auditFiles, MANIFEST_PATH, built.bytes);
  for (const expectation of expectations.entries) {
    for (const value of [expectation.positiveExpectation, expectation.negativeExpectation]) {
      if (!auditFiles.has(value.artifactRef.path)) addSource(auditFiles, value.artifactRef.path);
      if (!auditFiles.has(value.schemaRef.path)) addSource(auditFiles, value.schemaRef.path);
    }
  }
  addSource(auditFiles, 'scripts/domain/run-m2-shacl-instance-closure.cjs');
  addSource(auditFiles, 'scripts/domain/verify-custom-release-capabilities.cjs');
  addSource(auditFiles, REGISTRY_PATH);
  const audit = auditConstraintInstanceClosure({
    files: auditFiles,
    replayedContextInventory: instances,
    gateJoin: {
      discovery: gate.discovery,
      subjectInventory: gate.subjectInventory,
      report: gate.report,
    },
  });
  if (audit.outcome !== 'passed') throw new Error(`constraint-instance closure audit failed: ${canonicalJcs(audit.issues)}`);

  const artifacts = new Map([
    [routeArtifact.ref.path, routeArtifact.bytes],
    [EXPECTATIONS_PATH, expectationBytes],
    [MANIFEST_PATH, built.bytes],
    [customArtifacts.positive.ref.path, customArtifacts.positive.bytes],
    [customArtifacts.negative.ref.path, customArtifacts.negative.bytes],
    [serializedGate.discovery.ref.path, serializedGate.discovery.bytes],
    [serializedGate.subjectInventory.ref.path, serializedGate.subjectInventory.bytes],
    [serializedGate.report.ref.path, serializedGate.report.bytes],
    [serializedGate.sourceEvidence.ref.path, serializedGate.sourceEvidence.bytes],
  ]);
  return {
    artifacts,
    outcome: 'passed',
    moduleCount: built.moduleCount,
    instanceCount: built.instanceCount,
    authoredCount: built.authoredCount,
    generatedCount: built.generatedCount,
    shaclCount: shacl.shaclInstances.length,
    customCount: shacl.customInstances.length,
    authoredBindingCount: audit.authoredBindingCount,
    authoredBindingMissing: audit.authoredBindingMissing.length,
    authoredOriginMissing: audit.authoredOriginMissing.length,
    gateJoinOutcome: gate.joined.outcome,
    manifestDigest: audit.manifestDigest,
  };
}

function writeArtifacts(artifacts) {
  for (const [relativePath, bytes] of artifacts) {
    const filePath = absolute(relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, bytes);
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--write')) {
    throw new Error('usage: node scripts/domain/generate-constraint-instance-release-closure.cjs [--write]');
  }
  const result = await generateConstraintInstanceReleaseClosure();
  if (argv[0] === '--write') writeArtifacts(result.artifacts);
  process.stdout.write(`${canonicalJcs({
    outcome: result.outcome,
    wrote: argv[0] === '--write',
    artifactCount: result.artifacts.size,
    moduleCount: result.moduleCount,
    instanceCount: result.instanceCount,
    authoredCount: result.authoredCount,
    generatedCount: result.generatedCount,
    shaclCount: result.shaclCount,
    customCount: result.customCount,
    authoredBindingCount: result.authoredBindingCount,
    authoredBindingMissing: result.authoredBindingMissing,
    authoredOriginMissing: result.authoredOriginMissing,
    gateJoinOutcome: result.gateJoinOutcome,
    manifestDigest: result.manifestDigest,
  })}\n`);
}

if (require.main === module) {
  main().catch((cause) => {
    process.stderr.write(`${cause.stack || cause.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  OUTPUT_PATHS,
  generateConstraintInstanceReleaseClosure,
  main,
  verifyCustomEvidence,
  verifyShaclEvidence,
  writeArtifacts,
};
