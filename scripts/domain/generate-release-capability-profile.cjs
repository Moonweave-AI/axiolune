#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  PROFILE_REF,
  RELEASE_CAPABILITY_EVIDENCE_USE,
  REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE,
  RELEASE_CHECK_IDS,
  REQUIRED_GATE_IDS,
  compareUtf8,
  releaseCapabilityDefinitions,
} = require('./lib/m2-release-capability-definitions.cjs');
const {
  productionAdapterVersion,
  productionDiscoveryRules,
  productionRuntimePolicy,
  productionTaggedVectorDigest,
  productionVectorIdentity,
  productionVectorSubject,
} = require('./lib/production-required-gate-semantic-adapters.cjs');
const {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  dependencyTreeDigest,
} = require('./lib/m2-required-gate-semantic-replay.cjs');
const {
  assertionProofDigest,
  dependencyEvidenceDigest,
  subjectDigest,
} = require('./lib/m2-release-capability-runtime.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE_ROOT_REL = 'scripts/domain/release-capability-profile/v0.3.0';
const REGISTRY_REL = 'scripts/domain/release-profile/v0.3.0/release-capability-bindings.json';
const REGISTRY_SCHEMA_REL =
  'scripts/domain/release-profile/v0.3.0/release-capability-bindings.schema.json';
const REQUIRED_GATES_REL =
  'scripts/domain/release-profile/v0.3.0/required-gates-manifest.json';
const RELEASE_CHECKS_REL =
  'scripts/domain/release-profile/v0.3.0/release-verification-checks-manifest.json';
const RELEASE_CHECKS_SCHEMA_REL =
  'scripts/domain/release-profile/v0.3.0/release-verification-checks-manifest.schema.json';
const TOOL_ID = 'axiolune-release-capability-runtime-v1';
const TOOL_VERSION = '1.0.0';
const ENTRYPOINT_REL = 'scripts/domain/run-release-capability.cjs';
const SEMANTIC_ENTRYPOINT_REL = 'scripts/domain/run-production-required-gate.cjs';
const RUNTIME_IMPL_REL = 'scripts/domain/lib/m2-release-capability-runtime.cjs';
const DEFINITIONS_IMPL_REL = 'scripts/domain/lib/m2-release-capability-definitions.cjs';
const JCS_IMPL_REL = 'scripts/domain/lib/strict-source-locator.cjs';
const TOOL_DESCRIPTOR_REL = `${PROFILE_ROOT_REL}/tool-descriptor.json`;
const RUNTIME_LOCK_REL = `${PROFILE_ROOT_REL}/runtime-lock.json`;
const CATEGORIES = Object.freeze([
  'positive', 'violation', 'tamper', 'emptySubject', 'engineFailure',
]);
const SEMANTIC_CATEGORIES = Object.freeze([
  'emptySubject', 'engineFailure', 'positive', 'tamper', 'violation',
]);
const SEMANTIC_RUNTIME_DEPENDENCIES = Object.freeze(['argparse', 'js-yaml']);

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function ref(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function tuple(relativePath, bytes) {
  return { ref: ref(relativePath), digest: sha256(bytes) };
}

function jsonBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function put(outputs, relativePath, value) {
  const bytes = Buffer.isBuffer(value) ? value : jsonBytes(value);
  outputs.set(relativePath, bytes);
  return tuple(relativePath, bytes);
}

function sourceTuple(relativePath) {
  const absolute = path.join(ROOT, ...relativePath.split('/'));
  return tuple(relativePath, fs.readFileSync(absolute));
}

function slug(definition) {
  return definition.bindingKind === 'requiredGate'
    ? `gates/${definition.subjectId}`
    : `checks/${definition.stageId}/${definition.subjectId}`;
}

function makeSubject(definition) {
  return {
    bindingKind: definition.bindingKind,
    subjectId: definition.subjectId,
    stageId: definition.stageId,
    assertions: definition.requiredAssertions.map((assertionId) => ({
      assertionId,
      proofDigest: assertionProofDigest(definition.capabilityId, assertionId),
    })),
  };
}

function makeDependencies(definition) {
  return definition.dependsOn.map((dependencyId) => ({
    dependencyId,
    outcome: 'passed',
    evidenceDigest: dependencyEvidenceDigest(definition.capabilityId, dependencyId),
  }));
}

function baseRequest(definition) {
  const subject = makeSubject(definition);
  return {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    operation: 'evaluate',
    capabilityId: definition.capabilityId,
    subject,
    subjectDigest: subjectDigest(subject),
    dependencyEvidence: makeDependencies(definition),
    fault: null,
  };
}

function expected(definition, category) {
  const table = {
    positive: ['completed', 'accepted', null],
    violation: ['completed', 'violation', 'M2_RELEASE_CAPABILITY_ASSERTION_PROOF'],
    tamper: ['engineFailure', 'engineFailure', 'M2_RELEASE_CAPABILITY_INPUT_DIGEST'],
    emptySubject: ['engineFailure', 'engineFailure', 'M2_RELEASE_CAPABILITY_EMPTY_SUBJECT'],
    engineFailure: ['engineFailure', 'engineFailure', 'M2_RELEASE_CAPABILITY_ENGINE_FAILURE'],
  };
  const [status, outcome, code] = table[category];
  return { status, outcome, code, semanticOwner: definition.capabilityId };
}

function vectorInput(definition, category) {
  const request = baseRequest(definition);
  if (category === 'violation') {
    request.subject.assertions[0].proofDigest = `sha256:${'0'.repeat(64)}`;
    request.subjectDigest = subjectDigest(request.subject);
  } else if (category === 'tamper') {
    request.subjectDigest = `sha256:${'0'.repeat(64)}`;
  } else if (category === 'emptySubject') {
    request.subject = null;
    request.subjectDigest = null;
  } else if (category === 'engineFailure') {
    request.fault = 'forced-engine-failure';
  }
  return request;
}

function runtimeDependency(name) {
  const absolute = path.join(ROOT, 'node_modules', ...name.split('/'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(absolute, 'package.json'), 'utf8'));
  return {
    name,
    version: packageJson.version,
    treeDigest: dependencyTreeDigest(absolute),
  };
}

function semanticVectorSubject(gateId, category) {
  return productionVectorSubject(ROOT, gateId, category);
}

function semanticVectorInput(definition, category) {
  const subject = category === 'emptySubject'
    ? null : semanticVectorSubject(
      definition.subjectId,
      category === 'violation' ? 'violation' : 'positive',
    );
  const subjectDigest = subject === null
    ? null : productionTaggedVectorDigest(definition.subjectId, subject);
  return {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    operation: 'semanticVector',
    capabilityId: definition.capabilityId,
    gateId: definition.subjectId,
    vectorCategory: category,
    subject,
    subjectDigest: category === 'tamper' ? `sha256:${'0'.repeat(64)}` : subjectDigest,
    fault: category === 'engineFailure' ? 'forced-engine-failure' : null,
  };
}

function semanticExpected(definition, category) {
  return productionVectorIdentity(definition.subjectId, category);
}

function semanticEvidenceSchema(definition) {
  const digest = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
  const strings = { type: 'array', uniqueItems: true, items: { type: 'string' } };
  const finding = {
    type: 'object', additionalProperties: false,
    required: ['code', 'path', 'message'],
    properties: {
      code: { type: 'string' }, path: { type: 'string' }, message: { type: 'string' },
    },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion', 'profileRef', 'capabilityId', 'gateId', 'status', 'outcome',
      'code', 'evidenceUse', 'releaseEligibilityEvidence', 'callerEvidenceAccepted',
      'subjectInventoryDigest', 'dependencyReportDigests', 'semanticDigest',
      'kindEvidence',
    ],
    properties: {
      schemaVersion: { const: '1.0' },
      profileRef: { const: PROFILE_REF },
      capabilityId: { const: definition.capabilityId },
      gateId: { const: definition.subjectId },
      status: { enum: ['completed', 'engineFailure'] },
      outcome: { enum: ['accepted', 'engineFailure', 'failed', 'passed', 'violation'] },
      code: { type: ['string', 'null'] },
      evidenceUse: {
        enum: [
          'required-gate-release-eligibility-evidence',
          'required-gate-semantic-test-vector-only',
        ],
      },
      releaseEligibilityEvidence: { type: 'boolean' },
      callerEvidenceAccepted: { const: false },
      subjectInventoryDigest: { type: ['string', 'null'], pattern: '^sha256:[0-9a-f]{64}$' },
      dependencyReportDigests: { type: 'array', uniqueItems: true, items: digest },
      semanticDigest: digest,
      kindEvidence: {
        type: 'object', additionalProperties: false,
        required: [
          'adapterVersion', 'gateKind', 'runtimePolicy', 'checkedAssertions',
          'passedAssertions', 'failedAssertions', 'subjectCount',
          'checkedArtifactCount', 'findingCount', 'findings', 'inputDigest',
          'resultDigest',
        ],
        properties: {
          adapterVersion: { const: productionAdapterVersion(definition.subjectId) },
          gateKind: { const: definition.subjectId },
          runtimePolicy: { const: productionRuntimePolicy(definition.subjectId) },
          checkedAssertions: strings,
          passedAssertions: strings,
          failedAssertions: strings,
          subjectCount: { type: 'integer', minimum: 0 },
          checkedArtifactCount: { type: 'integer', minimum: 0 },
          findingCount: { type: 'integer', minimum: 0 },
          findings: { type: 'array', items: finding },
          inputDigest: digest,
          resultDigest: digest,
        },
      },
    },
  };
}

function artifactRefSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'root', 'path'],
    properties: {
      kind: { const: 'path' },
      root: { const: 'sourceTree' },
      path: {
        type: 'string', minLength: 1,
        pattern: '^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*\\\\).+$',
      },
    },
  };
}

function digestSchema() {
  return { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' };
}

function evidenceSchema(definition) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROFILE_REF}/release-capability/evidence/${encodeURIComponent(definition.capabilityId)}`,
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion', 'profileRef', 'capabilityId', 'semanticOwner',
      'evidenceUse', 'releaseEligibilityEvidence', 'status', 'outcome', 'code',
      'subjectId', 'evidence',
    ],
    properties: {
      schemaVersion: { const: '1.0' },
      profileRef: { const: PROFILE_REF },
      capabilityId: { const: definition.capabilityId },
      semanticOwner: { const: definition.capabilityId },
      evidenceUse: { const: RELEASE_CAPABILITY_EVIDENCE_USE },
      releaseEligibilityEvidence: { const: false },
      status: { enum: ['completed', 'engineFailure'] },
      outcome: { enum: ['accepted', 'violation', 'engineFailure'] },
      code: { type: ['string', 'null'] },
      subjectId: { const: definition.subjectId },
      evidence: {
        type: 'object',
        additionalProperties: false,
        required: [
          'bindingKind', 'stageId', 'subjectId', 'computedSubjectDigest',
          'assertionCount', 'dependencyCount', 'validatedAssertions',
          'validatedDependencies',
        ],
        properties: {
          bindingKind: { const: definition.bindingKind },
          stageId: definition.stageId === null
            ? { type: 'null' } : { const: definition.stageId },
          subjectId: { const: definition.subjectId },
          computedSubjectDigest: { type: ['string', 'null'] },
          assertionCount: { type: 'integer', minimum: 0 },
          dependencyCount: { type: 'integer', minimum: 0 },
          validatedAssertions: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          validatedDependencies: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
      },
    },
  };
}

function registrySchema() {
  const referenceFields = [
    'toolArtifact', 'runtime', 'capability', 'entrypoint', 'inputContract',
    'outputContract', 'discoveryContract', 'evidenceSchema', 'testVectors',
  ];
  const properties = {
    bindingKind: { enum: ['requiredGate', 'releaseCheck'] },
    stageId: { type: ['string', 'null'] },
    subjectId: { type: 'string', minLength: 1 },
    capabilityId: { type: 'string', minLength: 1 },
    toolId: { const: TOOL_ID },
    toolVersion: { const: TOOL_VERSION },
  };
  for (const prefix of referenceFields) {
    properties[`${prefix}Ref`] = artifactRefSchema();
    properties[`${prefix}Digest`] = digestSchema();
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROFILE_REF}/release-capability-bindings-schema`,
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'profileRef', 'entries'],
    properties: {
      schemaVersion: { const: '1.0' },
      profileRef: { const: PROFILE_REF },
      entries: {
        type: 'array', minItems: 64, maxItems: 64,
        items: {
          type: 'object', additionalProperties: false,
          required: Object.keys(properties), properties,
        },
      },
    },
  };
}

function releaseChecksSchema() {
  const check = {
    type: 'object',
    additionalProperties: false,
    required: [
      'checkId', 'toolId', 'capabilityId', 'capabilityRef', 'capabilityDigest',
      'entrypointRef', 'entrypointDigest', 'discoveryContractRef',
      'discoveryContractDigest', 'evidenceSchemaRef', 'evidenceSchemaDigest',
      'dependsOn',
    ],
    properties: {
      checkId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
      toolId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
      capabilityId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
      capabilityRef: artifactRefSchema(),
      capabilityDigest: digestSchema(),
      entrypointRef: artifactRefSchema(),
      entrypointDigest: digestSchema(),
      discoveryContractRef: artifactRefSchema(),
      discoveryContractDigest: digestSchema(),
      evidenceSchemaRef: artifactRefSchema(),
      evidenceSchemaDigest: digestSchema(),
      dependsOn: {
        type: 'array', uniqueItems: true,
        items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
      },
    },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROFILE_REF}/release-verification-checks-manifest-schema`,
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'profileRef', 'stages'],
    properties: {
      schemaVersion: { const: '1.0' },
      profileRef: { const: PROFILE_REF },
      stages: {
        type: 'array', minItems: 4, maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['stageId', 'checks'],
          properties: {
            stageId: {
              enum: [
                'adoptionVerification', 'approvalEligibility',
                'p0Verification', 'payloadVerification',
              ],
            },
            checks: { type: 'array', minItems: 1, items: check },
          },
        },
      },
    },
  };
}

function generate() {
  const outputs = new Map();
  const definitions = releaseCapabilityDefinitions();
  if (definitions.length !== 64
      || definitions.filter((row) => row.bindingKind === 'requiredGate').length !== 22
      || definitions.filter((row) => row.bindingKind === 'releaseCheck').length !== 42) {
    throw new Error('release capability definition inventory is not exact 22/42/64');
  }

  const entrypoint = sourceTuple(ENTRYPOINT_REL);
  const semanticEntrypoint = sourceTuple(SEMANTIC_ENTRYPOINT_REL);
  const entrypoints = [
    { implementationMode: RELEASE_CAPABILITY_EVIDENCE_USE, entrypoint },
    {
      implementationMode: REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE,
      entrypoint: semanticEntrypoint,
    },
  ];
  const implementationPaths = [...new Set([
    DEFINITIONS_IMPL_REL,
    RUNTIME_IMPL_REL,
    JCS_IMPL_REL,
    ENTRYPOINT_REL,
    ...definitions.flatMap((definition) => definition.semanticImplementationPaths),
  ])].sort(compareUtf8);
  const implementationArtifacts = implementationPaths.map(sourceTuple);
  const dependencyLock = sourceTuple('package-lock.json');
  const runtimeDependencies = SEMANTIC_RUNTIME_DEPENDENCIES.map(runtimeDependency);
  const runtimeLock = put(outputs, RUNTIME_LOCK_REL, {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    engine: 'node',
    version: process.versions.node,
    permissionModelRequired: true,
    networkPolicy: 'deny',
    dependencyLock,
    runtimeDependencies,
    entrypoints: entrypoints.map((row) => ({ toolId: TOOL_ID, ...row })),
  });
  const toolDescriptor = put(outputs, TOOL_DESCRIPTOR_REL, {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    toolId: TOOL_ID,
    version: TOOL_VERSION,
    executionModel: 'direct-stdin-jcs-v1',
    evidenceUses: [
      RELEASE_CAPABILITY_EVIDENCE_USE,
      'required-gate-release-eligibility-evidence',
      'required-gate-semantic-test-vector-only',
    ].sort(compareUtf8),
    entrypoints,
    implementationArtifacts,
    capabilityInventory: definitions.map((definition) => definition.capabilityId),
  });

  const entries = [];
  for (const definition of definitions) {
    const root = `${PROFILE_ROOT_REL}/${slug(definition)}`;
    const semantic = definition.implementationMode
      === REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE;
    const capabilityEntrypoint = semantic ? semanticEntrypoint : entrypoint;
    const discovery = put(outputs, `${root}/discovery-contract.json`, semantic ? {
      schemaVersion: '1.0',
      profileRef: PROFILE_REF,
      capabilityId: definition.capabilityId,
      bindingKind: definition.bindingKind,
      stageId: definition.stageId,
      strategy: {
        kind: 'sourceTreePathSet-v1',
        rules: productionDiscoveryRules(definition.subjectId)
          .sort((left, right) => compareUtf8(canonicalJcs(left), canonicalJcs(right))),
      },
    } : {
      schemaVersion: '1.0',
      profileRef: PROFILE_REF,
      capabilityId: definition.capabilityId,
      bindingKind: definition.bindingKind,
      stageId: definition.stageId,
      subjectCount: 1,
      subjects: [{
        subjectId: definition.subjectId,
        requiredAssertions: definition.requiredAssertions,
        dependsOn: definition.dependsOn,
      }],
    });
    const evidence = put(
      outputs,
      `${root}/evidence.schema.json`,
      semantic ? semanticEvidenceSchema(definition) : evidenceSchema(definition),
    );
    let testVectors;
    const inputContractValue = semantic ? {
      schemaVersion: '1.0',
      profileRef: PROFILE_REF,
      capabilityId: definition.capabilityId,
      operation: 'replayRequiredGate',
      protocol: 'stdin-jcs-v1',
      invocation: {
        argv: ['--required-gate-semantic'],
        environmentPolicy: 'offline-minimal-node-permission-v1',
        maxOutputBytes: MAX_OUTPUT_BYTES,
        successExitCode: 0,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      },
      subjectDiscoveryComponent: discovery,
      evidenceResultComponent: evidence,
      testVectors: null,
      runtimeDependencies,
      permissions: { childProcess: false, fsWriteTemp: true },
    } : {
      schemaVersion: '1.0',
      profileRef: PROFILE_REF,
      capabilityId: definition.capabilityId,
      operation: 'evaluate',
      closedRequestFields: [
        'capabilityId', 'dependencyEvidence', 'fault', 'operation', 'profileRef',
        'schemaVersion', 'subject', 'subjectDigest',
      ],
      subjectDigestDomainTag: 'axiolune-release-capability-subject-v1\\0',
      subjectDiscoveryComponent: discovery,
      evidenceResultComponent: evidence,
    };
    const outputContractValue = semantic ? {
      schemaVersion: '1.0',
      profileRef: PROFILE_REF,
      capabilityId: definition.capabilityId,
      protocol: 'stdout-jcs-v1',
      canonicalization: 'RFC8785-JCS',
      maxOutputBytes: MAX_OUTPUT_BYTES,
      successExitCode: 0,
      subjectDiscoveryComponent: discovery,
      evidenceResultComponent: evidence,
    } : {
      schemaVersion: '1.0',
      profileRef: PROFILE_REF,
      capabilityId: definition.capabilityId,
      statuses: ['completed', 'engineFailure'],
      outcomes: ['accepted', 'engineFailure', 'violation'],
      closedOutputFields: [
        'capabilityId', 'code', 'evidence', 'evidenceUse', 'outcome', 'profileRef',
        'releaseEligibilityEvidence', 'schemaVersion', 'semanticOwner', 'status',
        'subjectId',
      ],
      subjectDiscoveryComponent: discovery,
      evidenceResultComponent: evidence,
    };
    const categories = {};
    for (const category of (semantic ? SEMANTIC_CATEGORIES : CATEGORIES)) {
      const input = put(
        outputs,
        `${root}/vectors/${category}.json`,
        semantic
          ? semanticVectorInput(definition, category)
          : vectorInput(definition, category),
      );
      categories[category] = [{
        caseId: `${definition.capabilityId}.${category}`,
        category,
        inputRef: input.ref,
        inputDigest: input.digest,
        expected: semantic
          ? semanticExpected(definition, category)
          : expected(definition, category),
      }];
    }
    testVectors = put(outputs, `${root}/test-vectors.json`, {
      schemaVersion: '1.0',
      profileRef: PROFILE_REF,
      capabilityId: definition.capabilityId,
      categories,
    });
    inputContractValue.testVectors = semantic ? testVectors : undefined;
    if (!semantic) delete inputContractValue.testVectors;
    const inputContract = put(outputs, `${root}/input-contract.json`, inputContractValue);
    const outputContract = put(outputs, `${root}/output-contract.json`, outputContractValue);
    const capability = put(outputs, `${root}/capability.json`, {
      schemaVersion: '1.0',
      profileRef: PROFILE_REF,
      capabilityId: definition.capabilityId,
      bindingKind: definition.bindingKind,
      stageId: definition.stageId,
      subjectId: definition.subjectId,
      implementationMode: definition.implementationMode,
      requiredAssertions: definition.requiredAssertions,
      dependsOn: definition.dependsOn,
      semanticImplementationArtifacts: definition.semanticImplementationPaths
        .map(sourceTuple),
      entrypoint: capabilityEntrypoint,
      inputContract,
      outputContract,
      subjectDiscoveryComponent: discovery,
      evidenceResultComponent: evidence,
      testVectors,
    });
    entries.push({
      bindingKind: definition.bindingKind,
      stageId: definition.stageId,
      subjectId: definition.subjectId,
      capabilityId: definition.capabilityId,
      toolId: TOOL_ID,
      toolVersion: TOOL_VERSION,
      toolArtifactRef: toolDescriptor.ref,
      toolArtifactDigest: toolDescriptor.digest,
      runtimeRef: runtimeLock.ref,
      runtimeDigest: runtimeLock.digest,
      capabilityRef: capability.ref,
      capabilityDigest: capability.digest,
      entrypointRef: capabilityEntrypoint.ref,
      entrypointDigest: capabilityEntrypoint.digest,
      inputContractRef: inputContract.ref,
      inputContractDigest: inputContract.digest,
      outputContractRef: outputContract.ref,
      outputContractDigest: outputContract.digest,
      discoveryContractRef: discovery.ref,
      discoveryContractDigest: discovery.digest,
      evidenceSchemaRef: evidence.ref,
      evidenceSchemaDigest: evidence.digest,
      testVectorsRef: testVectors.ref,
      testVectorsDigest: testVectors.digest,
    });
  }
  entries.sort((left, right) => compareUtf8(left.capabilityId, right.capabilityId));
  put(outputs, REGISTRY_REL, {
    schemaVersion: '1.0', profileRef: PROFILE_REF, entries,
  });
  put(outputs, REGISTRY_SCHEMA_REL, registrySchema());

  const byCapability = new Map(entries.map((entry) => [entry.capabilityId, entry]));
  const bindingTuple = (entry) => ({
    toolId: entry.toolId,
    capabilityId: entry.capabilityId,
    capabilityRef: entry.capabilityRef,
    capabilityDigest: entry.capabilityDigest,
    entrypointRef: entry.entrypointRef,
    entrypointDigest: entry.entrypointDigest,
    discoveryContractRef: entry.discoveryContractRef,
    discoveryContractDigest: entry.discoveryContractDigest,
    evidenceSchemaRef: entry.evidenceSchemaRef,
    evidenceSchemaDigest: entry.evidenceSchemaDigest,
  });
  const gates = definitions
    .filter((definition) => definition.bindingKind === 'requiredGate')
    .map((definition) => ({
      gateId: definition.subjectId,
      reportKind: definition.reportKind,
      criterionRefs: definition.criterionRefs,
      ...bindingTuple(byCapability.get(definition.capabilityId)),
      dependsOn: definition.dependsOn,
    }))
    .sort((left, right) => compareUtf8(left.gateId, right.gateId));
  put(outputs, REQUIRED_GATES_REL, { schemaVersion: '1.0', gates });

  const stages = Object.keys(RELEASE_CHECK_IDS).sort(compareUtf8).map((stageId) => ({
    stageId,
    checks: definitions
      .filter((definition) => (
        definition.bindingKind === 'releaseCheck' && definition.stageId === stageId
      ))
      .map((definition) => ({
        checkId: definition.subjectId,
        ...bindingTuple(byCapability.get(definition.capabilityId)),
        dependsOn: definition.dependsOn,
      }))
      .sort((left, right) => compareUtf8(left.checkId, right.checkId)),
  }));
  put(outputs, RELEASE_CHECKS_REL, {
    schemaVersion: '1.0', profileRef: PROFILE_REF, stages,
  });
  put(outputs, RELEASE_CHECKS_SCHEMA_REL, releaseChecksSchema());
  return outputs;
}

function expectedGeneratedPaths(outputs) {
  return [...outputs.keys()]
    .filter((relativePath) => relativePath.startsWith(`${PROFILE_ROOT_REL}/`))
    .sort(compareUtf8);
}

function actualGeneratedPaths() {
  const root = path.join(ROOT, ...PROFILE_ROOT_REL.split('/'));
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute);
      else if (entry.isFile() && !entry.isSymbolicLink()) {
        files.push(path.relative(ROOT, absolute).split(path.sep).join('/'));
      } else throw new Error(`generated profile contains non-regular entry ${absolute}`);
    }
  };
  visit(root);
  return files.sort(compareUtf8);
}

function write(outputs) {
  for (const [relativePath, bytes] of outputs) {
    const absolute = path.join(ROOT, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
  }
}

function check(outputs) {
  const issues = [];
  for (const [relativePath, expectedBytes] of outputs) {
    const absolute = path.join(ROOT, ...relativePath.split('/'));
    if (!fs.existsSync(absolute)) issues.push(`${relativePath}: missing`);
    else if (!fs.readFileSync(absolute).equals(expectedBytes)) issues.push(`${relativePath}: drift`);
  }
  const expectedPaths = expectedGeneratedPaths(outputs);
  const actualPaths = actualGeneratedPaths();
  if (canonicalJcs(expectedPaths) !== canonicalJcs(actualPaths)) {
    const expectedSet = new Set(expectedPaths);
    const actualSet = new Set(actualPaths);
    for (const relativePath of expectedPaths) {
      if (!actualSet.has(relativePath)) issues.push(`${relativePath}: missing-from-profile-inventory`);
    }
    for (const relativePath of actualPaths) {
      if (!expectedSet.has(relativePath)) issues.push(`${relativePath}: extra-in-profile-inventory`);
    }
  }
  const {
    validateReleaseVerificationChecksManifest,
    validateRequiredGatesManifest,
  } = require('./lib/m2-release-verifier.cjs');
  const requiredGateManifest = JSON.parse(outputs.get(REQUIRED_GATES_REL).toString('utf8'));
  const releaseChecksManifest = JSON.parse(outputs.get(RELEASE_CHECKS_REL).toString('utf8'));
  for (const issue of validateRequiredGatesManifest(requiredGateManifest)) {
    issues.push(`${REQUIRED_GATES_REL}${issue.path}: ${issue.code}: ${issue.message}`);
  }
  for (const issue of validateReleaseVerificationChecksManifest(releaseChecksManifest)) {
    issues.push(`${RELEASE_CHECKS_REL}${issue.path}: ${issue.code}: ${issue.message}`);
  }
  return issues.sort(compareUtf8);
}

function requiredGateImplementationInventory(outputs) {
  const rows = REQUIRED_GATE_IDS.map((gateId) => {
    const relativePath = `${PROFILE_ROOT_REL}/gates/${gateId}/capability.json`;
    const bytes = outputs.get(relativePath);
    if (!Buffer.isBuffer(bytes)) {
      throw new Error(`generated required-gate capability is missing: ${relativePath}`);
    }
    const capability = JSON.parse(bytes.toString('utf8'));
    return {
      gateId,
      implementationMode: capability.implementationMode,
      entrypoint: capability.entrypoint?.ref?.path || null,
    };
  });
  const productionGateIds = rows.filter((row) => (
    row.implementationMode === REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE
  )).map((row) => row.gateId);
  const interfaceOnlyGateIds = rows.filter((row) => (
    row.implementationMode === RELEASE_CAPABILITY_EVIDENCE_USE
  )).map((row) => row.gateId);
  const unknownGateIds = rows.filter((row) => (
    row.implementationMode !== REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE
      && row.implementationMode !== RELEASE_CAPABILITY_EVIDENCE_USE
  )).map((row) => row.gateId);
  return {
    productionRequiredGateCount: productionGateIds.length,
    productionGateIds,
    interfaceOnlyRequiredGateCount: interfaceOnlyGateIds.length,
    interfaceOnlyGateIds,
    unknownRequiredGateCount: unknownGateIds.length,
    unknownGateIds,
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !['--write', '--check'].includes(argv[0])) {
    throw new Error('Usage: node scripts/domain/generate-release-capability-profile.cjs --write|--check');
  }
  const outputs = generate();
  if (argv[0] === '--write') write(outputs);
  const issues = check(outputs);
  const implementationInventory = requiredGateImplementationInventory(outputs);
  const summary = {
    schemaVersion: '1.0',
    outcome: issues.length === 0 ? 'passed' : 'failed',
    capabilityCount: 64,
    requiredGateCount: REQUIRED_GATE_IDS.length,
    releaseCheckCount: Object.values(RELEASE_CHECK_IDS)
      .reduce((total, values) => total + values.length, 0),
    generatedArtifactCount: outputs.size,
    ...implementationInventory,
    issues,
  };
  process.stdout.write(`${canonicalJcs(summary)}\n`);
  if (issues.length > 0) process.exitCode = 1;
  return summary;
}

if (require.main === module) {
  try {
    main();
  } catch (cause) {
    process.stderr.write(`${cause.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CATEGORIES,
  ENTRYPOINT_REL,
  PROFILE_ROOT_REL,
  REGISTRY_REL,
  RELEASE_CHECKS_REL,
  REQUIRED_GATES_REL,
  RUNTIME_LOCK_REL,
  TOOL_DESCRIPTOR_REL,
  TOOL_ID,
  TOOL_VERSION,
  check,
  generate,
  main,
  requiredGateImplementationInventory,
  vectorInput,
  write,
};
