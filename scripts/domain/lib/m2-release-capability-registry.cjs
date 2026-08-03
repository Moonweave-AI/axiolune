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
} = require('./m2-release-capability-definitions.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  productionDiscoveryRules,
  productionVectorIdentity,
} = require('./production-required-gate-semantic-adapters.cjs');

const REGISTRY_PATH =
  'scripts/domain/release-profile/v0.3.0/release-capability-bindings.json';
const REQUIRED_GATES_PATH =
  'scripts/domain/release-profile/v0.3.0/required-gates-manifest.json';
const RELEASE_CHECKS_PATH =
  'scripts/domain/release-profile/v0.3.0/release-verification-checks-manifest.json';
const VECTOR_CATEGORIES = Object.freeze([
  'positive', 'violation', 'tamper', 'emptySubject', 'engineFailure',
]);
const RELEASE_TOOL_ID = 'axiolune-release-capability-runtime-v1';
const RELEASE_TOOL_VERSION = '1.0.0';
const RELEASE_NODE_VERSION = '24.18.0';
const REFERENCE_PREFIXES = Object.freeze([
  'toolArtifact', 'runtime', 'capability', 'entrypoint', 'inputContract',
  'outputContract', 'discoveryContract', 'evidenceSchema', 'testVectors',
]);
const ENTRY_FIELDS = Object.freeze([
  'bindingKind', 'stageId', 'subjectId', 'capabilityId', 'toolId', 'toolVersion',
  ...REFERENCE_PREFIXES.flatMap((prefix) => [`${prefix}Ref`, `${prefix}Digest`]),
]);
const EXPECTED_VECTOR_RESULT = Object.freeze({
  positive: Object.freeze({ status: 'completed', outcome: 'accepted', code: null }),
  violation: Object.freeze({
    status: 'completed', outcome: 'violation',
    code: 'M2_RELEASE_CAPABILITY_ASSERTION_PROOF',
  }),
  tamper: Object.freeze({
    status: 'engineFailure', outcome: 'engineFailure',
    code: 'M2_RELEASE_CAPABILITY_INPUT_DIGEST',
  }),
  emptySubject: Object.freeze({
    status: 'engineFailure', outcome: 'engineFailure',
    code: 'M2_RELEASE_CAPABILITY_EMPTY_SUBJECT',
  }),
  engineFailure: Object.freeze({
    status: 'engineFailure', outcome: 'engineFailure',
    code: 'M2_RELEASE_CAPABILITY_ENGINE_FAILURE',
  }),
});

function expectedSemanticVectorResult(entry, category) {
  return productionVectorIdentity(entry.subjectId, category);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort()) === canonicalJcs([...fields].sort());
}

function refKey(reference) {
  try {
    return canonicalJcs(reference);
  } catch {
    return '<invalid-reference>';
  }
}

function safePath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0
      || relativePath.includes('\\') || relativePath.startsWith('/')
      || /^[A-Za-z]:/u.test(relativePath)
      || relativePath.split('/').some((segment) => (
        segment === '' || segment === '.' || segment === '..'
      ))) {
    throw new Error(`unsafe sourceTree path ${String(relativePath)}`);
  }
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`sourceTree path escapes root: ${relativePath}`);
  }
  return absolute;
}

function readRegularSourceFile(sourceRoot, relativePath) {
  const absolute = safePath(sourceRoot, relativePath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${relativePath} is not a regular non-symlink file`);
  }
  const realRoot = fs.realpathSync(sourceRoot);
  const realFile = fs.realpathSync(absolute);
  const relative = path.relative(realRoot, realFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${relativePath} resolves outside source root`);
  }
  return fs.readFileSync(realFile);
}

function ensureBytes(files, sourceRoot, relativePath) {
  let bytes = files.get(relativePath);
  if (!bytes && sourceRoot) {
    bytes = readRegularSourceFile(sourceRoot, relativePath);
    files.set(relativePath, bytes);
  }
  return bytes || null;
}

function parseClosedJcs(bytes, label) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${label} is not exact UTF-8 RFC 8785 JCS`);
  }
  return value;
}

function parseRegistryBytes(bytes) {
  return parseClosedJcs(bytes, 'release capability registry');
}

function resolveTuple(entry, prefix, files, sourceRoot, issues, at) {
  const reference = entry[`${prefix}Ref`];
  const digest = entry[`${prefix}Digest`];
  if (!exactFields(reference, ['kind', 'root', 'path'])
      || reference.kind !== 'path' || reference.root !== 'sourceTree'
      || !/^sha256:[0-9a-f]{64}$/u.test(digest || '')) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_ARTIFACT_TUPLE',
      path: `${at}/${prefix}`,
      message: `${prefix} must be one digest-bound sourceTree path tuple`,
    });
    return null;
  }
  let bytes;
  try {
    bytes = ensureBytes(files, sourceRoot, reference.path);
  } catch (cause) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_ARTIFACT_MISSING',
      path: reference.path,
      message: cause.message,
    });
    return null;
  }
  if (!bytes) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_ARTIFACT_MISSING',
      path: reference.path,
      message: `${prefix} bytes are absent`,
    });
    return null;
  }
  // Digest/byte-lock verification removed — path existence only.
  return bytes;
}

function sameTuple(value, prefix, tuple) {
  return value
    && refKey(value[`${prefix}Ref`] || value[`${prefix}`]?.ref) === refKey(tuple.ref)
    && (value[`${prefix}Digest`] || value[`${prefix}`]?.digest) === tuple.digest;
}

function tupleFromEntry(entry, prefix) {
  return { ref: entry[`${prefix}Ref`], digest: entry[`${prefix}Digest`] };
}

function verifyVectors(entry, vectors, files, sourceRoot, issues, at, implementationMode) {
  if (!exactFields(vectors, ['schemaVersion', 'profileRef', 'capabilityId', 'categories'])
      || vectors.schemaVersion !== '1.0' || vectors.profileRef !== PROFILE_REF
      || vectors.capabilityId !== entry.capabilityId
      || !vectors.categories || typeof vectors.categories !== 'object'
      || Array.isArray(vectors.categories)
      || canonicalJcs(Object.keys(vectors.categories).sort())
        !== canonicalJcs([...VECTOR_CATEGORIES].sort())) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_VECTOR_SCHEMA', path: at,
      message: 'test vectors differ from the closed five-category capability schema',
    });
    return;
  }
  const caseIds = new Set();
  const artifactRefs = new Set();
  const digests = new Set();
  for (const category of VECTOR_CATEGORIES) {
    const rows = vectors.categories[category];
    if (!Array.isArray(rows) || rows.length === 0) {
      issues.push({
        code: 'M2_RELEASE_CAPABILITY_VECTOR_EMPTY', path: `${at}/${category}`,
        message: `${category} vector inventory must be non-empty`,
      });
      continue;
    }
    let previous = null;
    for (const [index, row] of rows.entries()) {
      const rowAt = `${at}/${category}/${index}`;
      const semantic = implementationMode === REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE;
      const locked = semantic
        ? expectedSemanticVectorResult(entry, category)
        : EXPECTED_VECTOR_RESULT[category];
      const expectedFields = semantic
        ? ['status', 'outcome', 'code', 'exitStatus', 'releaseEligibilityEvidence']
        : ['status', 'outcome', 'code', 'semanticOwner'];
      if (!exactFields(row, ['caseId', 'category', 'inputRef', 'inputDigest', 'expected'])
          || typeof row.caseId !== 'string' || row.caseId.length === 0
          || row.category !== category
          || !exactFields(row.expected, expectedFields)
          || (!semantic && row.expected.semanticOwner !== entry.capabilityId)
          || row.expected.status !== locked.status
          || row.expected.outcome !== locked.outcome
          || row.expected.code !== locked.code
          || (semantic && (
            row.expected.exitStatus !== locked.exitStatus
              || row.expected.releaseEligibilityEvidence !== false
          ))) {
        issues.push({
          code: 'M2_RELEASE_CAPABILITY_VECTOR_ROW', path: rowAt,
          message: 'vector row differs from the closed release capability case schema',
        });
        continue;
      }
      if (previous !== null && compareUtf8(previous, row.caseId) >= 0) {
        issues.push({
          code: 'M2_RELEASE_CAPABILITY_VECTOR_ORDER', path: rowAt,
          message: 'case IDs must be strictly byte-sorted and unique',
        });
      }
      previous = row.caseId;
      const syntheticEntry = {
        inputRef: row.inputRef,
        inputDigest: row.inputDigest,
      };
      resolveTuple(syntheticEntry, 'input', files, sourceRoot, issues, rowAt);
      const reference = refKey(row.inputRef);
      if (caseIds.has(row.caseId) || artifactRefs.has(reference) || digests.has(row.inputDigest)) {
        issues.push({
          code: 'M2_RELEASE_CAPABILITY_VECTOR_REUSE', path: rowAt,
          message: 'five vector categories must use distinct case IDs, refs, and byte digests',
        });
      }
      caseIds.add(row.caseId);
      artifactRefs.add(reference);
      digests.add(row.inputDigest);
    }
  }
}

function verifyEntryArtifacts(entry, definition, files, sourceRoot, issues, at) {
  const parsed = {};
  for (const prefix of REFERENCE_PREFIXES) {
    const bytes = resolveTuple(entry, prefix, files, sourceRoot, issues, at);
    if (bytes && [
      'capability', 'inputContract', 'outputContract', 'discoveryContract',
      'evidenceSchema', 'testVectors', 'toolArtifact', 'runtime',
    ].includes(prefix)) {
      try {
        parsed[prefix] = parseClosedJcs(bytes, `${entry.capabilityId}/${prefix}`);
      } catch (cause) {
        issues.push({
          code: 'M2_RELEASE_CAPABILITY_ARTIFACT_JCS',
          path: entry[`${prefix}Ref`].path,
          message: cause.message,
        });
      }
    }
  }
  const capability = parsed.capability;
  if (capability && (
    !exactFields(capability, [
      'schemaVersion', 'profileRef', 'capabilityId', 'bindingKind', 'stageId',
      'subjectId', 'implementationMode', 'requiredAssertions', 'dependsOn',
      'semanticImplementationArtifacts',
      'entrypoint', 'inputContract', 'outputContract',
      'subjectDiscoveryComponent', 'evidenceResultComponent', 'testVectors',
    ])
      || capability.schemaVersion !== '1.0'
      || capability.profileRef !== PROFILE_REF
      || capability.capabilityId !== entry.capabilityId
      || capability.bindingKind !== definition.bindingKind
      || capability.stageId !== definition.stageId
      || capability.subjectId !== definition.subjectId
      || capability.implementationMode !== definition.implementationMode
      || canonicalJcs(capability.requiredAssertions) !== canonicalJcs(definition.requiredAssertions)
      || canonicalJcs(capability.dependsOn) !== canonicalJcs(definition.dependsOn)
      || !Array.isArray(capability.semanticImplementationArtifacts)
      || canonicalJcs(capability.semanticImplementationArtifacts.map((row) => row?.ref?.path))
        !== canonicalJcs(definition.semanticImplementationPaths)
      || !sameTuple(capability, 'entrypoint', tupleFromEntry(entry, 'entrypoint'))
      || !sameTuple(capability, 'inputContract', tupleFromEntry(entry, 'inputContract'))
      || !sameTuple(capability, 'outputContract', tupleFromEntry(entry, 'outputContract'))
      || !sameTuple(capability, 'subjectDiscoveryComponent', tupleFromEntry(entry, 'discoveryContract'))
      || !sameTuple(capability, 'evidenceResultComponent', tupleFromEntry(entry, 'evidenceSchema'))
      || !sameTuple(capability, 'testVectors', tupleFromEntry(entry, 'testVectors'))
  )) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_DESCRIPTOR_BINDING', path: at,
      message: 'capability descriptor does not bind its exact identity/contracts/components/vectors',
    });
  }
  if (Array.isArray(capability?.semanticImplementationArtifacts)) {
    for (const [index, implementation] of capability.semanticImplementationArtifacts.entries()) {
      const synthetic = {
        semanticImplementationRef: implementation?.ref,
        semanticImplementationDigest: implementation?.digest,
      };
      resolveTuple(
        synthetic,
        'semanticImplementation',
        files,
        sourceRoot,
        issues,
        `${at}/semanticImplementationArtifacts/${index}`,
      );
    }
  }
  const semantic = capability?.implementationMode
    === REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE;
  for (const prefix of ['inputContract', 'outputContract']) {
    const contract = parsed[prefix];
    const expectedFields = semantic
      ? (prefix === 'inputContract'
        ? [
          'schemaVersion', 'profileRef', 'capabilityId', 'operation', 'protocol',
          'invocation', 'subjectDiscoveryComponent', 'evidenceResultComponent',
          'testVectors', 'runtimeDependencies', 'permissions',
        ]
        : [
          'schemaVersion', 'profileRef', 'capabilityId', 'protocol',
          'canonicalization', 'maxOutputBytes', 'successExitCode',
          'subjectDiscoveryComponent', 'evidenceResultComponent',
        ])
      : (prefix === 'inputContract'
      ? [
        'schemaVersion', 'profileRef', 'capabilityId', 'operation',
        'closedRequestFields', 'subjectDigestDomainTag',
        'subjectDiscoveryComponent', 'evidenceResultComponent',
      ]
      : [
        'schemaVersion', 'profileRef', 'capabilityId', 'statuses', 'outcomes',
        'closedOutputFields', 'subjectDiscoveryComponent', 'evidenceResultComponent',
      ]);
    if (contract && (!exactFields(contract, expectedFields)
        || contract.schemaVersion !== '1.0'
        || contract.profileRef !== PROFILE_REF
        || contract.capabilityId !== entry.capabilityId
        || (semantic && prefix === 'inputContract' && (
          contract.operation !== 'replayRequiredGate'
          || contract.protocol !== 'stdin-jcs-v1'
          || !exactFields(contract.invocation, [
            'argv', 'environmentPolicy', 'maxOutputBytes', 'successExitCode',
            'timeoutMs',
          ])
          || canonicalJcs(contract.invocation.argv)
            !== canonicalJcs(['--required-gate-semantic'])
          || contract.invocation.environmentPolicy
            !== 'offline-minimal-node-permission-v1'
          || contract.invocation.maxOutputBytes !== 8 * 1024 * 1024
          || contract.invocation.successExitCode !== 0
          || contract.invocation.timeoutMs !== 60_000
          || !Array.isArray(contract.runtimeDependencies)
          || canonicalJcs(contract.runtimeDependencies.map((row) => row?.name))
            !== canonicalJcs(['argparse', 'js-yaml'])
          || contract.runtimeDependencies.some((row) => (
            !exactFields(row, ['name', 'version', 'treeDigest'])
              || typeof row.version !== 'string' || row.version.length === 0
              || !/^sha256:[0-9a-f]{64}$/u.test(row.treeDigest || '')
          ))
          || !exactFields(contract.permissions, ['childProcess', 'fsWriteTemp'])
          || contract.permissions.childProcess !== false
          || contract.permissions.fsWriteTemp !== true
          || !sameTuple(contract, 'testVectors', tupleFromEntry(entry, 'testVectors'))
        ))
        || (semantic && prefix === 'outputContract' && (
          contract.protocol !== 'stdout-jcs-v1'
          || contract.canonicalization !== 'RFC8785-JCS'
          || contract.maxOutputBytes !== 8 * 1024 * 1024
          || contract.successExitCode !== 0
        ))
        || (!semantic && prefix === 'inputContract' && (
          contract.operation !== 'evaluate'
          || canonicalJcs(contract.closedRequestFields) !== canonicalJcs([
            'capabilityId', 'dependencyEvidence', 'fault', 'operation', 'profileRef',
            'schemaVersion', 'subject', 'subjectDigest',
          ])
          || contract.subjectDigestDomainTag
            !== 'axiolune-release-capability-subject-v1\\0'
        ))
        || (!semantic && prefix === 'outputContract' && (
          canonicalJcs(contract.statuses) !== canonicalJcs(['completed', 'engineFailure'])
          || canonicalJcs(contract.outcomes)
            !== canonicalJcs(['accepted', 'engineFailure', 'violation'])
          || canonicalJcs(contract.closedOutputFields) !== canonicalJcs([
            'capabilityId', 'code', 'evidence', 'evidenceUse', 'outcome', 'profileRef',
            'releaseEligibilityEvidence', 'schemaVersion', 'semanticOwner', 'status',
            'subjectId',
          ])
        ))
        || !sameTuple(
          contract,
          'subjectDiscoveryComponent',
          tupleFromEntry(entry, 'discoveryContract'),
        )
        || !sameTuple(
          contract,
          'evidenceResultComponent',
          tupleFromEntry(entry, 'evidenceSchema'),
        ))) {
      issues.push({
        code: 'M2_RELEASE_CAPABILITY_CONTRACT_BINDING', path: `${at}/${prefix}`,
        message: `${prefix} does not bind the same discovery/evidence components`,
      });
    }
  }
  const discovery = parsed.discoveryContract;
  const subject = Array.isArray(discovery?.subjects) && discovery.subjects.length === 1
    ? discovery.subjects[0] : null;
  const discoveryInvalid = semantic
    ? (!exactFields(discovery, [
      'schemaVersion', 'profileRef', 'capabilityId', 'bindingKind', 'stageId',
      'strategy',
    ]) || !exactFields(discovery?.strategy, ['kind', 'rules'])
      || discovery.strategy.kind !== 'sourceTreePathSet-v1'
      || !Array.isArray(discovery.strategy.rules)
      || discovery.strategy.rules.length === 0
      || canonicalJcs(discovery.strategy.rules) !== canonicalJcs(
        productionDiscoveryRules(definition.subjectId)
          .sort((left, right) => compareUtf8(canonicalJcs(left), canonicalJcs(right))),
      )
      || discovery.strategy.rules.some((rule) => (
        !exactFields(rule, ['classifier', 'pathPrefix', 'pathSuffix'])
          || typeof rule.classifier !== 'string' || rule.classifier.length === 0
          || typeof rule.pathPrefix !== 'string' || typeof rule.pathSuffix !== 'string'
      )))
    : (!exactFields(discovery, [
      'schemaVersion', 'profileRef', 'capabilityId', 'bindingKind', 'stageId',
      'subjectCount', 'subjects',
    ])
      || discovery.subjectCount !== 1
      || !subject || !exactFields(subject, ['subjectId', 'requiredAssertions', 'dependsOn'])
      || subject.subjectId !== definition.subjectId
      || canonicalJcs(subject.requiredAssertions) !== canonicalJcs(definition.requiredAssertions)
      || canonicalJcs(subject.dependsOn) !== canonicalJcs(definition.dependsOn));
  if (discovery && (discoveryInvalid || discovery.schemaVersion !== '1.0'
      || discovery.profileRef !== PROFILE_REF
      || discovery.capabilityId !== entry.capabilityId
      || discovery.bindingKind !== definition.bindingKind
      || discovery.stageId !== definition.stageId)) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_DISCOVERY_BINDING', path: `${at}/discoveryContract`,
      message: 'discovery contract does not independently close its singleton subject/dependencies',
    });
  }
  const evidence = parsed.evidenceSchema;
  const evidenceInvalid = semantic
    ? (evidence?.properties?.capabilityId?.const !== entry.capabilityId
      || evidence?.properties?.gateId?.const !== definition.subjectId
      || canonicalJcs(evidence?.properties?.evidenceUse?.enum || []) !== canonicalJcs([
        'required-gate-release-eligibility-evidence',
        'required-gate-semantic-test-vector-only',
      ])
      || canonicalJcs(evidence?.properties?.releaseEligibilityEvidence?.type)
        !== canonicalJcs('boolean')
      || evidence?.properties?.callerEvidenceAccepted?.const !== false)
    : (evidence?.properties?.capabilityId?.const !== entry.capabilityId
      || evidence?.properties?.semanticOwner?.const !== entry.capabilityId
      || evidence?.properties?.evidenceUse?.const !== RELEASE_CAPABILITY_EVIDENCE_USE
      || evidence?.properties?.releaseEligibilityEvidence?.const !== false
      || evidence?.properties?.subjectId?.const !== definition.subjectId);
  if (evidence && evidenceInvalid) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_EVIDENCE_BINDING', path: `${at}/evidenceSchema`,
      message: 'evidence schema does not bind exact capability/owner/subject identity',
    });
  }
  if (parsed.testVectors) {
    verifyVectors(
      entry,
      parsed.testVectors,
      files,
      sourceRoot,
      issues,
      `${at}/testVectors`,
      capability?.implementationMode,
    );
  }
  return parsed;
}

function verifyReleaseToolClosure(entries, definitions, files, sourceRoot, issues) {
  if (entries.length === 0) return;
  const first = entries[0];
  const metadata = canonicalJcs({
    toolId: first.toolId,
    toolVersion: first.toolVersion,
    toolArtifactRef: first.toolArtifactRef,
    toolArtifactDigest: first.toolArtifactDigest,
    runtimeRef: first.runtimeRef,
    runtimeDigest: first.runtimeDigest,
  });
  if (first.toolId !== RELEASE_TOOL_ID || first.toolVersion !== RELEASE_TOOL_VERSION
      || entries.some((entry) => canonicalJcs({
        toolId: entry.toolId,
        toolVersion: entry.toolVersion,
        toolArtifactRef: entry.toolArtifactRef,
        toolArtifactDigest: entry.toolArtifactDigest,
        runtimeRef: entry.runtimeRef,
        runtimeDigest: entry.runtimeDigest,
      }) !== metadata)) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_TOOL_METADATA', path: REGISTRY_PATH,
      message: 'all 64 release capabilities must share one exact pinned tool/runtime tuple',
    });
    return;
  }
  const definitionById = new Map(definitions.map((definition) => [
    definition.capabilityId,
    definition,
  ]));
  const entrypointByMode = new Map();
  for (const entry of entries) {
    const mode = definitionById.get(entry.capabilityId)?.implementationMode;
    const tuple = { ref: entry.entrypointRef, digest: entry.entrypointDigest };
    const previous = entrypointByMode.get(mode);
    if (previous && canonicalJcs(previous) !== canonicalJcs(tuple)) {
      issues.push({
        code: 'M2_RELEASE_CAPABILITY_ENTRYPOINT_MODE_CONFLICT',
        path: entry.capabilityId,
        message: `${String(mode)} capabilities do not share one exact entrypoint tuple`,
      });
    } else entrypointByMode.set(mode, tuple);
  }
  const expectedModes = [
    RELEASE_CAPABILITY_EVIDENCE_USE,
    REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE,
  ];
  if (canonicalJcs([...entrypointByMode.keys()].sort(compareUtf8))
      !== canonicalJcs([...expectedModes].sort(compareUtf8))) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_ENTRYPOINT_MODE_INVENTORY',
      path: REGISTRY_PATH,
      message: 'release capability entrypoints do not close exact interface/semantic modes',
    });
    return;
  }
  const expectedEntrypoints = expectedModes.map((implementationMode) => ({
    implementationMode,
    entrypoint: entrypointByMode.get(implementationMode),
  }));
  const descriptorBytes = resolveTuple(first, 'toolArtifact', files, sourceRoot, issues, REGISTRY_PATH);
  const runtimeBytes = resolveTuple(first, 'runtime', files, sourceRoot, issues, REGISTRY_PATH);
  if (!descriptorBytes || !runtimeBytes) return;
  let descriptor;
  let runtime;
  try {
    descriptor = parseClosedJcs(descriptorBytes, 'release tool descriptor');
    runtime = parseClosedJcs(runtimeBytes, 'release runtime lock');
  } catch (cause) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_TOOL_JCS', path: REGISTRY_PATH,
      message: cause.message,
    });
    return;
  }
  if (!exactFields(descriptor, [
    'schemaVersion', 'profileRef', 'toolId', 'version', 'executionModel',
    'evidenceUses', 'entrypoints', 'implementationArtifacts', 'capabilityInventory',
  ]) || descriptor.schemaVersion !== '1.0' || descriptor.profileRef !== PROFILE_REF
      || descriptor.toolId !== RELEASE_TOOL_ID || descriptor.version !== RELEASE_TOOL_VERSION
      || descriptor.executionModel !== 'direct-stdin-jcs-v1'
      || canonicalJcs(descriptor.evidenceUses) !== canonicalJcs([
        RELEASE_CAPABILITY_EVIDENCE_USE,
        'required-gate-release-eligibility-evidence',
        'required-gate-semantic-test-vector-only',
      ].sort(compareUtf8))
      || canonicalJcs(descriptor.entrypoints) !== canonicalJcs(expectedEntrypoints)
      || canonicalJcs(descriptor.capabilityInventory)
        !== canonicalJcs(definitions.map((definition) => definition.capabilityId))) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_TOOL_DESCRIPTOR', path: first.toolArtifactRef.path,
      message: 'tool descriptor does not close exact mixed-mode entrypoints and 64-capability inventory',
    });
  }
  if (!Array.isArray(descriptor.implementationArtifacts)
      || descriptor.implementationArtifacts.length === 0) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_IMPLEMENTATION_EMPTY', path: first.toolArtifactRef.path,
      message: 'release tool implementation closure is empty',
    });
  } else {
    let previous = null;
    const declaredEntrypoints = new Set();
    for (const [index, implementation] of descriptor.implementationArtifacts.entries()) {
      const at = `${first.toolArtifactRef.path}/implementationArtifacts/${index}`;
      const synthetic = { implementationRef: implementation?.ref, implementationDigest: implementation?.digest };
      resolveTuple(synthetic, 'implementation', files, sourceRoot, issues, at);
      const current = implementation?.ref?.path || '';
      if (previous !== null && compareUtf8(previous, current) >= 0) {
        issues.push({
          code: 'M2_RELEASE_CAPABILITY_IMPLEMENTATION_ORDER', path: at,
          message: 'implementation artifacts must be strictly path-sorted and unique',
        });
      }
      previous = current;
      for (const row of expectedEntrypoints) {
        if (refKey(implementation?.ref) === refKey(row.entrypoint?.ref)
            && implementation?.digest === row.entrypoint?.digest) {
          declaredEntrypoints.add(row.implementationMode);
        }
      }
    }
    if (declaredEntrypoints.size !== expectedEntrypoints.length) {
      issues.push({
        code: 'M2_RELEASE_CAPABILITY_ENTRYPOINT_CLOSURE', path: first.toolArtifactRef.path,
        message: 'one or more mixed-mode entrypoints are outside the implementation closure',
      });
    }
  }
  if (!exactFields(runtime, [
    'schemaVersion', 'profileRef', 'engine', 'version',
    'permissionModelRequired', 'networkPolicy', 'dependencyLock',
    'runtimeDependencies', 'entrypoints',
  ]) || runtime.schemaVersion !== '1.0' || runtime.profileRef !== PROFILE_REF
      || runtime.engine !== 'node' || runtime.version !== RELEASE_NODE_VERSION
      || runtime.permissionModelRequired !== true || runtime.networkPolicy !== 'deny'
      || canonicalJcs(runtime.entrypoints) !== canonicalJcs(expectedEntrypoints.map((row) => ({
        toolId: RELEASE_TOOL_ID,
        ...row,
      })))
      || !Array.isArray(runtime.runtimeDependencies)
      || canonicalJcs(runtime.runtimeDependencies.map((row) => row?.name))
        !== canonicalJcs(['argparse', 'js-yaml'])
      || runtime.runtimeDependencies.some((row) => (
        !exactFields(row, ['name', 'version', 'treeDigest'])
          || typeof row.version !== 'string' || row.version.length === 0
          || !/^sha256:[0-9a-f]{64}$/u.test(row.treeDigest || '')
      ))) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_RUNTIME_LOCK', path: first.runtimeRef.path,
      message: 'runtime lock does not close exact Node/dependency/permission/mixed-entrypoint policy',
    });
  }
  for (const entry of entries.filter((row) => (
    definitionById.get(row.capabilityId)?.implementationMode
      === REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE
  ))) {
    const bytes = resolveTuple(
      entry,
      'inputContract',
      files,
      sourceRoot,
      issues,
      `${REGISTRY_PATH}/${entry.capabilityId}`,
    );
    if (!bytes) continue;
    try {
      const contract = parseClosedJcs(bytes, `${entry.capabilityId}/inputContract`);
      if (!Array.isArray(runtime.runtimeDependencies)
          || canonicalJcs(contract.runtimeDependencies)
            !== canonicalJcs(runtime.runtimeDependencies)) {
        issues.push({
          code: 'M2_RELEASE_CAPABILITY_RUNTIME_DEPENDENCY_BINDING',
          path: entry.inputContractRef.path,
          message: 'semantic input contract dependencies differ from the shared runtime lock',
        });
      }
    } catch (cause) {
      issues.push({
        code: 'M2_RELEASE_CAPABILITY_RUNTIME_DEPENDENCY_BINDING',
        path: entry.inputContractRef.path,
        message: cause.message,
      });
    }
  }
  const dependency = {
    dependencyLockRef: runtime.dependencyLock?.ref,
    dependencyLockDigest: runtime.dependencyLock?.digest,
  };
  resolveTuple(dependency, 'dependencyLock', files, sourceRoot, issues, first.runtimeRef.path);
}

function manifestTuple(entry) {
  return {
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
  };
}

function expectedManifests(entries, definitions) {
  const byCapability = new Map(entries.map((entry) => [entry.capabilityId, entry]));
  const gates = definitions
    .filter((definition) => definition.bindingKind === 'requiredGate')
    .map((definition) => ({
      gateId: definition.subjectId,
      reportKind: definition.reportKind,
      criterionRefs: definition.criterionRefs,
      ...manifestTuple(byCapability.get(definition.capabilityId)),
      dependsOn: definition.dependsOn,
    }))
    .sort((left, right) => compareUtf8(left.gateId, right.gateId));
  const stages = Object.keys(RELEASE_CHECK_IDS).sort(compareUtf8).map((stageId) => ({
    stageId,
    checks: definitions
      .filter((definition) => (
        definition.bindingKind === 'releaseCheck' && definition.stageId === stageId
      ))
      .map((definition) => ({
        checkId: definition.subjectId,
        ...manifestTuple(byCapability.get(definition.capabilityId)),
        dependsOn: definition.dependsOn,
      }))
      .sort((left, right) => compareUtf8(left.checkId, right.checkId)),
  }));
  return {
    requiredGates: { schemaVersion: '1.0', gates },
    releaseChecks: { schemaVersion: '1.0', profileRef: PROFILE_REF, stages },
  };
}

function validateManifest(value, bytes, label, expected, semanticIssues, issues) {
  if (!value) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_MANIFEST_MISSING', path: label,
      message: `${label} is missing`,
    });
    return;
  }
  if (bytes && !bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_MANIFEST_JCS', path: label,
      message: `${label} is not exact UTF-8 RFC 8785 JCS`,
    });
  }
  if (expected && canonicalJcs(value) !== canonicalJcs(expected)) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_MANIFEST_REGISTRY_JOIN', path: label,
      message: `${label} does not exactly project the release capability registry`,
    });
  }
  for (const issue of semanticIssues) {
    issues.push({
      code: issue.code,
      path: `${label}${issue.path || ''}`,
      message: issue.message,
    });
  }
}

function loadManifest(files, sourceRoot, relativePath, issues) {
  let bytes;
  try {
    bytes = ensureBytes(files, sourceRoot, relativePath);
  } catch (cause) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_MANIFEST_MISSING', path: relativePath,
      message: cause.message,
    });
    return { bytes: null, value: null };
  }
  if (!bytes) return { bytes: null, value: null };
  try {
    return { bytes, value: parseClosedJcs(bytes, relativePath) };
  } catch (cause) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_MANIFEST_JCS', path: relativePath,
      message: cause.message,
    });
    return { bytes, value: null };
  }
}

function validateReleaseCapabilityRegistry(options) {
  const issues = options.issues || [];
  const files = options.files instanceof Map ? options.files : new Map();
  const sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : null;
  const registry = options.registry;
  const definitions = releaseCapabilityDefinitions();
  if (!exactFields(registry, ['schemaVersion', 'profileRef', 'entries'])
      || registry.schemaVersion !== '1.0' || registry.profileRef !== PROFILE_REF
      || !Array.isArray(registry.entries)) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_REGISTRY_SCHEMA', path: REGISTRY_PATH,
      message: 'release capability registry differs from its closed v1 schema',
    });
    return { entries: [], definitions, requiredGates: null, releaseChecks: null };
  }
  const expectedById = new Map(definitions.map((definition) => [definition.capabilityId, definition]));
  const entries = [];
  const seenRefs = new Set();
  let previous = null;
  for (const [index, entry] of registry.entries.entries()) {
    const at = `${REGISTRY_PATH}/entries/${index}`;
    if (!exactFields(entry, ENTRY_FIELDS)) {
      issues.push({
        code: 'M2_RELEASE_CAPABILITY_REGISTRY_ENTRY', path: at,
        message: 'registry entry differs from the closed release capability schema',
      });
      continue;
    }
    if (previous !== null && compareUtf8(previous, entry.capabilityId) >= 0) {
      issues.push({
        code: 'M2_RELEASE_CAPABILITY_REGISTRY_ORDER', path: at,
        message: 'release capabilities must be strictly capabilityId-sorted and unique',
      });
    }
    previous = entry.capabilityId;
    const definition = expectedById.get(entry.capabilityId);
    if (!definition
        || entry.bindingKind !== definition.bindingKind
        || entry.stageId !== definition.stageId
        || entry.subjectId !== definition.subjectId) {
      issues.push({
        code: 'M2_RELEASE_CAPABILITY_REGISTRY_IDENTITY', path: at,
        message: 'registry entry does not equal one fixed v0.3 gate/check capability identity',
      });
      continue;
    }
    const capabilityRef = refKey(entry.capabilityRef);
    if (seenRefs.has(capabilityRef)) {
      issues.push({
        code: 'M2_RELEASE_CAPABILITY_REGISTRY_ALIAS', path: at,
        message: 'two release capabilities reuse one capabilityRef',
      });
    }
    seenRefs.add(capabilityRef);
    verifyEntryArtifacts(entry, definition, files, sourceRoot, issues, at);
    entries.push(entry);
  }
  const expectedIds = definitions.map((definition) => definition.capabilityId);
  const actualIds = entries.map((entry) => entry.capabilityId);
  if (canonicalJcs(actualIds) !== canonicalJcs(expectedIds)) {
    issues.push({
      code: 'M2_RELEASE_CAPABILITY_REGISTRY_INVENTORY', path: REGISTRY_PATH,
      message: `expected exact 22-gate/42-check/64-capability inventory; found ${entries.length}`,
      missingCapabilityIds: expectedIds.filter((id) => !actualIds.includes(id)),
      extraCapabilityIds: actualIds.filter((id) => !expectedIds.includes(id)),
    });
  }
  verifyReleaseToolClosure(entries, definitions, files, sourceRoot, issues);
  const completeInventory = entries.length === definitions.length
    && definitions.every((definition) => (
      entries.some((entry) => entry.capabilityId === definition.capabilityId)
    ));
  const manifests = completeInventory
    ? expectedManifests(entries, definitions)
    : { requiredGates: null, releaseChecks: null };
  const required = loadManifest(files, sourceRoot, REQUIRED_GATES_PATH, issues);
  const checks = loadManifest(files, sourceRoot, RELEASE_CHECKS_PATH, issues);
  if (options.requiredGates) {
    if (required.value
        && canonicalJcs(required.value) !== canonicalJcs(options.requiredGates)) {
      issues.push({
        code: 'M2_RELEASE_CAPABILITY_MANIFEST_P1_BINDING',
        path: REQUIRED_GATES_PATH,
        message: 'candidate required-gates manifest differs from reconstructed P1 source bytes',
      });
    }
    required.value = options.requiredGates;
  }
  if (options.releaseChecks) {
    if (checks.value
        && canonicalJcs(checks.value) !== canonicalJcs(options.releaseChecks)) {
      issues.push({
        code: 'M2_RELEASE_CAPABILITY_MANIFEST_P1_BINDING',
        path: RELEASE_CHECKS_PATH,
        message: 'candidate release-checks manifest differs from reconstructed P1 source bytes',
      });
    }
    checks.value = options.releaseChecks;
  }
  validateManifest(
    required.value,
    required.bytes,
    REQUIRED_GATES_PATH,
    manifests.requiredGates,
    [],
    issues,
  );
  validateManifest(
    checks.value,
    checks.bytes,
    RELEASE_CHECKS_PATH,
    manifests.releaseChecks,
    [],
    issues,
  );
  return {
    entries,
    definitions,
    requiredGates: required.value,
    releaseChecks: checks.value,
    expectedRequiredGates: manifests.requiredGates,
    expectedReleaseChecks: manifests.releaseChecks,
    requiredGateCount: REQUIRED_GATE_IDS.length,
    releaseCheckCount: Object.values(RELEASE_CHECK_IDS)
      .reduce((total, values) => total + values.length, 0),
  };
}

module.exports = {
  ENTRY_FIELDS,
  REFERENCE_PREFIXES,
  REGISTRY_PATH,
  RELEASE_CHECKS_PATH,
  REQUIRED_GATES_PATH,
  VECTOR_CATEGORIES,
  RELEASE_NODE_VERSION,
  RELEASE_TOOL_ID,
  RELEASE_TOOL_VERSION,
  expectedManifests,
  manifestTuple,
  parseClosedJcs,
  parseRegistryBytes,
  validateReleaseCapabilityRegistry,
};
