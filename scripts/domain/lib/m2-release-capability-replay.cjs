'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  REGISTRY_PATH,
  VECTOR_CATEGORIES,
  parseClosedJcs,
  validateReleaseCapabilityRegistry,
} = require('./m2-release-capability-registry.cjs');
const {
  PROFILE_REF,
  RELEASE_CAPABILITY_EVIDENCE_USE,
  REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE,
  compareUtf8,
  releaseCapabilityDefinitions,
} = require('./m2-release-capability-definitions.cjs');
const {
  evaluateProductionRequiredGate,
} = require('./production-required-gate-semantic-adapters.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  engineFailureOutput: trustedEngineFailureOutput,
  evaluateReleaseCapability: trustedEvaluateReleaseCapability,
} = require('./m2-release-capability-runtime.cjs');

const TOOL_ID = 'axiolune-release-capability-runtime-v1';
const EXPECTED_NODE_VERSION = '24.18.0';
const EXPECTED_CAPABILITY_COUNT = 64;
const EXPECTED_CASE_COUNT = EXPECTED_CAPABILITY_COUNT * VECTOR_CATEGORIES.length;
const EXPECTED_TOOL_DESCRIPTOR_PATH =
  'scripts/domain/release-capability-profile/v0.3.0/tool-descriptor.json';
const EXPECTED_RUNTIME_LOCK_PATH =
  'scripts/domain/release-capability-profile/v0.3.0/runtime-lock.json';
const EXPECTED_ENTRYPOINT_PATH = 'scripts/domain/run-release-capability.cjs';
const EXPECTED_SEMANTIC_ENTRYPOINT_PATH =
  'scripts/domain/run-production-required-gate.cjs';
const EXPECTED_IMPLEMENTATION_PATHS = Object.freeze([...new Set([
  'scripts/domain/lib/m2-release-capability-definitions.cjs',
  'scripts/domain/lib/m2-release-capability-runtime.cjs',
  'scripts/domain/lib/strict-source-locator.cjs',
  EXPECTED_ENTRYPOINT_PATH,
  ...releaseCapabilityDefinitions().flatMap((row) => row.semanticImplementationPaths),
])].sort(compareUtf8));

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function dependencyTreeDigest(root) {
  const rows = [];
  const visit = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort(compareUtf8)) {
      const absolute = path.join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`dependency contains symlink ${relativePath}`);
      if (stat.isDirectory()) visit(absolute, relativePath);
      else if (stat.isFile()) {
        const bytes = fs.readFileSync(absolute);
        rows.push({ path: relativePath, byteLength: bytes.length, digest: sha256(bytes) });
      } else throw new Error(`dependency contains non-regular entry ${relativePath}`);
    }
  };
  visit(root);
  return sha256(Buffer.concat([
    Buffer.from('axiolune-node-dependency-tree-v1\0', 'utf8'),
    Buffer.from(canonicalJcs({ schemaVersion: '1.0', files: rows }), 'utf8'),
  ]));
}

function refKey(reference) {
  return canonicalJcs(reference);
}

function registryEntry(tool, capability, identity) {
  return {
    bindingKind: identity.bindingKind,
    stageId: identity.stageId,
    subjectId: identity.subjectId,
    capabilityId: capability.capabilityId,
    toolId: tool.toolId,
    toolVersion: tool.version,
    toolArtifactRef: tool.artifactRef,
    toolArtifactDigest: tool.artifactDigest,
    runtimeRef: tool.runtimeRef,
    runtimeDigest: tool.runtimeDigest,
    capabilityRef: capability.capabilityRef,
    capabilityDigest: capability.capabilityDigest,
    entrypointRef: capability.entrypointRef,
    entrypointDigest: capability.entrypointDigest,
    inputContractRef: capability.inputContractRef,
    inputContractDigest: capability.inputContractDigest,
    outputContractRef: capability.outputContractRef,
    outputContractDigest: capability.outputContractDigest,
    discoveryContractRef: capability.discoveryContractRef,
    discoveryContractDigest: capability.discoveryContractDigest,
    evidenceSchemaRef: capability.evidenceSchemaRef,
    evidenceSchemaDigest: capability.evidenceSchemaDigest,
    testVectorsRef: capability.testVectorsRef,
    testVectorsDigest: capability.testVectorsDigest,
  };
}

function assertReleaseRegistryMatchesLock(registry, lock) {
  const definitions = releaseCapabilityDefinitions();
  const identityById = new Map(definitions.map((definition) => [
    definition.capabilityId,
    definition,
  ]));
  const tools = (Array.isArray(lock?.tools) ? lock.tools : [])
    .filter((tool) => tool.toolId === TOOL_ID);
  if (tools.length !== 1) {
    throw new Error(`release lock must contain exactly one ${TOOL_ID} tool; found ${tools.length}`);
  }
  const expected = [];
  for (const capability of tools[0].capabilities || []) {
    const identity = identityById.get(capability.capabilityId);
    if (!identity) {
      throw new Error(`lock contains unknown release capability ${capability.capabilityId}`);
    }
    expected.push(registryEntry(tools[0], capability, identity));
  }
  expected.sort((left, right) => compareUtf8(left.capabilityId, right.capabilityId));
  if (!registry || !Array.isArray(registry.entries)
      || registry.entries.length !== EXPECTED_CAPABILITY_COUNT
      || expected.length !== EXPECTED_CAPABILITY_COUNT) {
    throw new Error(
      `release registry/lock must contain exactly ${EXPECTED_CAPABILITY_COUNT} capabilities; `
        + `found ${registry?.entries?.length || 0}/${expected.length}`,
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (canonicalJcs(registry.entries[index]) !== canonicalJcs(expected[index])) {
      throw new Error(`release capability ${index} does not exactly equal its lock row`);
    }
  }
  return expected;
}

function artifact(files, reference, digest, label) {
  if (!reference || reference.kind !== 'path' || reference.root !== 'sourceTree') {
    throw new Error(`${label} is not a sourceTree path reference`);
  }
  const bytes = files.get(reference.path);
  if (!Buffer.isBuffer(bytes)) throw new Error(`${label} is absent from reconstructed P1`);
  if (sha256(bytes) !== digest) throw new Error(`${label} digest differs from P1 bytes`);
  return bytes;
}

function add(selected, files, reference, digest, label) {
  const bytes = artifact(files, reference, digest, label);
  selected.set(reference.path, bytes);
  return bytes;
}

function addDependencyDirectory(selected, trustedRoot, dependency) {
  const relativeRoot = `node_modules/${dependency.name}`;
  const absoluteRoot = path.join(trustedRoot, ...relativeRoot.split('/'));
  if (!fs.existsSync(absoluteRoot) || !fs.lstatSync(absoluteRoot).isDirectory()
      || fs.lstatSync(absoluteRoot).isSymbolicLink()) {
    throw new Error(`trusted runtime dependency is unavailable: ${dependency.name}`);
  }
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(absoluteRoot, 'package.json'), 'utf8'),
  );
  if (packageJson.name !== dependency.name || packageJson.version !== dependency.version
      || dependencyTreeDigest(absoluteRoot) !== dependency.treeDigest) {
    throw new Error(`${dependency.name} identity/version/tree digest differs from runtime lock`);
  }
  const visit = (directory, relative) => {
    for (const name of fs.readdirSync(directory).sort(compareUtf8)) {
      const absolute = path.join(directory, name);
      const childRelative = `${relative}/${name}`;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`${dependency.name} contains symlink ${childRelative}`);
      }
      if (stat.isDirectory()) visit(absolute, childRelative);
      else if (stat.isFile()) selected.set(childRelative, fs.readFileSync(absolute));
      else throw new Error(`${dependency.name} contains non-regular entry ${childRelative}`);
    }
  };
  visit(absoluteRoot, relativeRoot);
}

function collectReleaseCapabilityPayload(options) {
  const issues = [];
  const closure = validateReleaseCapabilityRegistry({
    registry: options.registry,
    files: options.files,
    requiredGates: options.requiredGates,
    releaseChecks: options.releaseChecks,
    issues,
  });
  if (issues.length > 0) {
    throw new Error(`release capability registry closure failed: ${issues[0].code}: ${issues[0].message}`);
  }
  assertReleaseRegistryMatchesLock(options.registry, options.lock);
  const tool = options.lock.tools.find((row) => row.toolId === TOOL_ID);
  if (tool.artifactRef?.path !== EXPECTED_TOOL_DESCRIPTOR_PATH
      || tool.runtimeRef?.path !== EXPECTED_RUNTIME_LOCK_PATH) {
    throw new Error('release tool substitutes the reviewed descriptor/runtime path');
  }
  const selected = new Map();
  const descriptorBytes = add(
    selected, options.files, tool.artifactRef, tool.artifactDigest, 'release tool descriptor',
  );
  const runtimeBytes = add(
    selected, options.files, tool.runtimeRef, tool.runtimeDigest, 'release runtime lock',
  );
  const descriptor = parseClosedJcs(descriptorBytes, 'release tool descriptor');
  const runtime = parseClosedJcs(runtimeBytes, 'release runtime lock');
  const expectedEntrypoints = [
    {
      implementationMode: RELEASE_CAPABILITY_EVIDENCE_USE,
      entrypoint: {
        ref: { kind: 'path', root: 'sourceTree', path: EXPECTED_ENTRYPOINT_PATH },
        digest: sha256(options.files.get(EXPECTED_ENTRYPOINT_PATH)),
      },
    },
    {
      implementationMode: REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE,
      entrypoint: {
        ref: {
          kind: 'path', root: 'sourceTree', path: EXPECTED_SEMANTIC_ENTRYPOINT_PATH,
        },
        digest: sha256(options.files.get(EXPECTED_SEMANTIC_ENTRYPOINT_PATH)),
      },
    },
  ];
  if (descriptor.toolId !== TOOL_ID || descriptor.version !== tool.version
      || descriptor.executionModel !== 'direct-stdin-jcs-v1'
      || canonicalJcs(descriptor.evidenceUses) !== canonicalJcs([
        RELEASE_CAPABILITY_EVIDENCE_USE,
        'required-gate-release-eligibility-evidence',
        'required-gate-semantic-test-vector-only',
      ].sort(compareUtf8))
      || canonicalJcs(descriptor.entrypoints) !== canonicalJcs(expectedEntrypoints)
      || !Array.isArray(descriptor.implementationArtifacts)
      || descriptor.implementationArtifacts.length === 0
      || canonicalJcs(descriptor.capabilityInventory)
        !== canonicalJcs(closure.definitions.map((row) => row.capabilityId))) {
    throw new Error('release tool descriptor identity/implementation/inventory is invalid');
  }
  if (runtime.schemaVersion !== '1.0' || runtime.profileRef !== PROFILE_REF
      || runtime.engine !== 'node' || runtime.version !== EXPECTED_NODE_VERSION
      || runtime.permissionModelRequired !== true || runtime.networkPolicy !== 'deny'
      || !Array.isArray(runtime.runtimeDependencies)
      || canonicalJcs(runtime.runtimeDependencies.map((row) => row?.name))
        !== canonicalJcs(['argparse', 'js-yaml'])) {
    throw new Error('release runtime lock does not pin Node/permission/network policy');
  }
  if (runtime.dependencyLock?.ref?.path !== 'package-lock.json') {
    throw new Error('release runtime substitutes the reviewed dependency lock path');
  }
  add(
    selected,
    options.files,
    runtime.dependencyLock.ref,
    runtime.dependencyLock.digest,
    'release runtime dependency lock',
  );
  for (const implementation of descriptor.implementationArtifacts) {
    add(
      selected,
      options.files,
      implementation.ref,
      implementation.digest,
      `release implementation ${implementation.ref?.path}`,
    );
  }
  const implementationPaths = descriptor.implementationArtifacts
    .map((row) => row.ref?.path)
    .sort(compareUtf8);
  if (canonicalJcs(implementationPaths) !== canonicalJcs(EXPECTED_IMPLEMENTATION_PATHS)) {
    throw new Error('release tool substitutes or omits its reviewed implementation closure');
  }
  const trustedSourceRoot = path.resolve(
    options.trustedSourceRoot || path.resolve(__dirname, '../../..'),
  );
  const dependencyLockValue = JSON.parse(
    selected.get(runtime.dependencyLock.ref.path).toString('utf8'),
  );
  if (dependencyLockValue.lockfileVersion !== 3) {
    throw new Error('release runtime dependency lock is not npm lockfileVersion 3');
  }
  for (const dependency of runtime.runtimeDependencies) {
    const locked = dependencyLockValue.packages?.[`node_modules/${dependency.name}`];
    if (!locked || locked.version !== dependency.version
        || typeof locked.integrity !== 'string' || locked.integrity.length === 0) {
      throw new Error(`${dependency.name} is not version/integrity locked`);
    }
    addDependencyDirectory(selected, trustedSourceRoot, dependency);
  }
  for (const relativePath of [...EXPECTED_IMPLEMENTATION_PATHS, 'package-lock.json']) {
    const p1Bytes = selected.get(relativePath);
    const trustedPath = path.resolve(trustedSourceRoot, ...relativePath.split('/'));
    const relative = path.relative(trustedSourceRoot, trustedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)
        || !fs.existsSync(trustedPath) || !fs.lstatSync(trustedPath).isFile()) {
      throw new Error(`trusted implementation is unavailable: ${relativePath}`);
    }
    const trustedBytes = fs.readFileSync(trustedPath);
    if (!Buffer.isBuffer(p1Bytes) || !p1Bytes.equals(trustedBytes)) {
      throw new Error(`${relativePath} differs from the trusted verifier implementation bytes`);
    }
  }
  if (canonicalJcs(runtime.entrypoints) !== canonicalJcs(expectedEntrypoints.map((row) => ({
    toolId: TOOL_ID,
    ...row,
  })))) {
    throw new Error('runtime lock does not bind the tool descriptor mixed-mode entrypoints');
  }
  const skip = new Set(options.skipCapabilityIds || []);
  const work = [];
  for (const entry of closure.entries) {
    const capability = tool.capabilities.find((row) => row.capabilityId === entry.capabilityId);
    if (!capability) throw new Error(`${entry.capabilityId} is absent from release tool lock`);
    for (const prefix of [
      'capability', 'entrypoint', 'inputContract', 'outputContract',
      'discoveryContract', 'evidenceSchema', 'testVectors',
    ]) {
      add(
        selected,
        options.files,
        capability[`${prefix}Ref`],
        capability[`${prefix}Digest`],
        `${entry.capabilityId}/${prefix}`,
      );
    }
    const capabilityDescriptor = parseClosedJcs(
      artifact(
        options.files,
        capability.capabilityRef,
        capability.capabilityDigest,
        `${entry.capabilityId}/capability`,
      ),
      `${entry.capabilityId}/capability`,
    );
    const vectors = parseClosedJcs(
      artifact(
        options.files,
        capability.testVectorsRef,
        capability.testVectorsDigest,
        `${entry.capabilityId}/vectors`,
      ),
      `${entry.capabilityId}/vectors`,
    );
    const inputContract = parseClosedJcs(
      artifact(
        options.files,
        capability.inputContractRef,
        capability.inputContractDigest,
        `${entry.capabilityId}/inputContract`,
      ),
      `${entry.capabilityId}/inputContract`,
    );
    const evidenceSchema = parseClosedJcs(
      artifact(
        options.files,
        capability.evidenceSchemaRef,
        capability.evidenceSchemaDigest,
        `${entry.capabilityId}/evidenceSchema`,
      ),
      `${entry.capabilityId}/evidenceSchema`,
    );
    for (const category of VECTOR_CATEGORIES) {
      for (const testCase of vectors.categories[category]) {
        add(
          selected,
          options.files,
          testCase.inputRef,
          testCase.inputDigest,
          `${entry.capabilityId}/${testCase.caseId}`,
        );
        if (!skip.has(entry.capabilityId)) {
          work.push({
            entry,
            capability,
            capabilityDescriptor,
            inputContract,
            category,
            testCase,
            evidenceSchema,
          });
        }
      }
    }
  }
  return { selected, work, closure, descriptor, runtime };
}

function safeMaterializedPath(root, relativePath) {
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`materialized path escapes replay root: ${relativePath}`);
  }
  return absolute;
}

function materialize(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-release-capability-p1-replay-'));
  for (const [relativePath, bytes] of files) {
    const absolute = safeMaterializedPath(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes, { flag: 'wx' });
  }
  return root;
}

function removeReplayRoot(root) {
  const resolved = path.resolve(root);
  const prefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(prefix)
      || !path.basename(resolved).startsWith('axiolune-release-capability-p1-replay-')) {
    throw new Error(`refusing to remove unexpected replay root ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function executeCase(
  root,
  entrypointPath,
  inputBytes,
  timeoutMs,
  semantic = false,
  argv = [],
) {
  const semanticTemp = path.join(root, '.semantic-tmp');
  if (semantic) {
    if (fs.existsSync(semanticTemp)) fs.rmSync(semanticTemp, { recursive: true, force: true });
    fs.mkdirSync(semanticTemp, { recursive: false });
  }
  try {
    const result = spawnSync(process.execPath, [
      '--permission',
      `--allow-fs-read=${root}`,
      ...(semantic ? [`--allow-fs-write=${semanticTemp}`] : []),
      '--no-global-search-paths',
      entrypointPath,
      ...argv,
    ], {
      cwd: root,
      input: inputBytes,
      encoding: null,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH || '',
        SystemRoot: process.env.SystemRoot || '',
        WINDIR: process.env.WINDIR || '',
      },
    });
    if (result.error) throw result.error;
    if (!Buffer.isBuffer(result.stdout) || result.stdout.length === 0) {
      throw new Error('release capability worker emitted no JCS output');
    }
    if (semantic && (result.stdout.includes(0x0a) || result.stdout.includes(0x0d))) {
      throw new Error('semantic release capability worker emitted framed/non-JCS output');
    }
    const outputBytes = semantic
      ? result.stdout
      : Buffer.from(result.stdout.toString('utf8').trim(), 'utf8');
    const value = parseClosedJcs(outputBytes, 'release capability result');
    return {
      status: result.status,
      signal: result.signal,
      stderr: result.stderr,
      value,
      bytes: outputBytes,
    };
  } finally {
    if (semantic) fs.rmSync(semanticTemp, { recursive: true, force: true });
  }
}

function schemaTypeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function validateJsonSchema(value, schema, at = '') {
  const issues = [];
  const visit = (actual, rule, pointer) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      issues.push(`${pointer || '/'}: invalid schema rule`);
      return;
    }
    if (Object.hasOwn(rule, 'const') && canonicalJcs(actual) !== canonicalJcs(rule.const)) {
      issues.push(`${pointer || '/'}: const mismatch`);
    }
    if (Array.isArray(rule.enum)
        && !rule.enum.some((candidate) => canonicalJcs(candidate) === canonicalJcs(actual))) {
      issues.push(`${pointer || '/'}: enum mismatch`);
    }
    if (rule.type) {
      const types = Array.isArray(rule.type) ? rule.type : [rule.type];
      if (!types.some((type) => schemaTypeMatches(actual, type))) {
        issues.push(`${pointer || '/'}: type mismatch`);
        return;
      }
    }
    if (typeof actual === 'string' && rule.pattern
        && !(new RegExp(rule.pattern, 'u')).test(actual)) {
      issues.push(`${pointer || '/'}: pattern mismatch`);
    }
    if (typeof actual === 'number' && typeof rule.minimum === 'number'
        && actual < rule.minimum) {
      issues.push(`${pointer || '/'}: minimum mismatch`);
    }
    if (Array.isArray(actual)) {
      if (rule.uniqueItems === true) {
        const keys = actual.map((item) => canonicalJcs(item));
        if (new Set(keys).size !== keys.length) issues.push(`${pointer || '/'}: duplicate items`);
      }
      if (rule.items) actual.forEach((item, index) => visit(item, rule.items, `${pointer}/${index}`));
    }
    if (actual !== null && typeof actual === 'object' && !Array.isArray(actual)) {
      if (Array.isArray(rule.required)) {
        for (const field of rule.required) {
          if (!Object.hasOwn(actual, field)) issues.push(`${pointer}/${field}: missing`);
        }
      }
      if (rule.additionalProperties === false && rule.properties) {
        for (const field of Object.keys(actual)) {
          if (!Object.hasOwn(rule.properties, field)) issues.push(`${pointer}/${field}: additional`);
        }
      }
      for (const [field, child] of Object.entries(rule.properties || {})) {
        if (Object.hasOwn(actual, field)) visit(actual[field], child, `${pointer}/${field}`);
      }
    }
  };
  visit(value, schema, at);
  return issues;
}

function verifyCaseResult(work, execution, input) {
  const expected = work.testCase.expected;
  const value = execution.value;
  if (work.capabilityDescriptor.implementationMode
      === REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE) {
    const trustedRoot = fs.mkdtempSync(path.join(
      os.tmpdir(), 'axiolune-production-gate-vector-trusted-',
    ));
    let trusted;
    try {
      trusted = evaluateProductionRequiredGate(structuredClone(input), { root: trustedRoot });
    } finally {
      fs.rmSync(trustedRoot, { recursive: true, force: true });
    }
    if (canonicalJcs(value) !== canonicalJcs(trusted.value)) {
      throw new Error(
        `${work.testCase.caseId} P1 output differs from trusted-host production validator recomputation`,
      );
    }
    if (value.schemaVersion !== '1.0' || value.profileRef !== PROFILE_REF
        || value.capabilityId !== work.entry.capabilityId
        || value.gateId !== work.entry.subjectId
        || value.evidenceUse !== 'required-gate-semantic-test-vector-only'
        || value.releaseEligibilityEvidence !== false
        || value.callerEvidenceAccepted !== false
        || value.status !== expected.status || value.outcome !== expected.outcome
        || value.code !== expected.code
        || execution.status !== expected.exitStatus || execution.signal !== null
        || trusted.exitStatus !== expected.exitStatus) {
      throw new Error(`${work.testCase.caseId} differs from locked semantic vector polarity`);
    }
    const schemaIssues = validateJsonSchema(value, work.evidenceSchema);
    if (schemaIssues.length > 0) {
      throw new Error(
        `${work.testCase.caseId} output fails locked semantic evidence schema: ${schemaIssues[0]}`,
      );
    }
    if (!value.kindEvidence
        || canonicalJcs(value.kindEvidence.checkedAssertions)
          !== canonicalJcs(work.capabilityDescriptor.requiredAssertions)) {
      throw new Error(`${work.testCase.caseId} did not execute the exact gate assertion set`);
    }
    return;
  }
  let trustedValue;
  try {
    trustedValue = trustedEvaluateReleaseCapability(structuredClone(input));
  } catch (cause) {
    trustedValue = trustedEngineFailureOutput(input, cause);
  }
  if (canonicalJcs(value) !== canonicalJcs(trustedValue)) {
    throw new Error(
      `${work.testCase.caseId} P1 output differs from independent trusted-host recomputation`,
    );
  }
  if (value.schemaVersion !== '1.0' || value.profileRef !== PROFILE_REF
      || value.capabilityId !== work.entry.capabilityId
      || value.semanticOwner !== work.entry.capabilityId
      || value.evidenceUse !== RELEASE_CAPABILITY_EVIDENCE_USE
      || value.releaseEligibilityEvidence !== false
      || value.subjectId !== work.entry.subjectId
      || value.status !== expected.status || value.outcome !== expected.outcome
      || value.code !== expected.code) {
    throw new Error(`${work.testCase.caseId} output differs from locked expected identity/result`);
  }
  const expectedExit = expected.status === 'completed' ? 0 : 2;
  if (execution.status !== expectedExit || execution.signal !== null) {
    throw new Error(
      `${work.testCase.caseId} process status differs: ${execution.status}/${execution.signal}`,
    );
  }
  if (!value.evidence || value.evidence.bindingKind !== work.entry.bindingKind
      || value.evidence.stageId !== work.entry.stageId
      || value.evidence.subjectId !== work.entry.subjectId) {
    throw new Error(`${work.testCase.caseId} evidence does not bind capability subject identity`);
  }
  const schemaIssues = validateJsonSchema(value, work.evidenceSchema);
  if (schemaIssues.length > 0) {
    throw new Error(
      `${work.testCase.caseId} output fails locked evidence schema: ${schemaIssues[0]}`,
    );
  }
  if (input.subject !== null && work.category !== 'engineFailure') {
    const recomputedSubjectDigest = sha256(Buffer.concat([
      Buffer.from('axiolune-release-capability-subject-v1\0', 'utf8'),
      Buffer.from(canonicalJcs(input.subject), 'utf8'),
    ]));
    if (value.evidence.computedSubjectDigest !== recomputedSubjectDigest) {
      throw new Error(`${work.testCase.caseId} evidence does not bind the independently recomputed subject digest`);
    }
  }
  if (work.category === 'positive') {
    const definition = releaseCapabilityDefinitions()
      .find((row) => row.capabilityId === work.entry.capabilityId);
    if (canonicalJcs(value.evidence.validatedAssertions)
          !== canonicalJcs(definition.requiredAssertions)
        || canonicalJcs(value.evidence.validatedDependencies)
          !== canonicalJcs(definition.dependsOn)) {
      throw new Error(`${work.testCase.caseId} did not independently validate exact assertions/dependencies`);
    }
  }
}

function executeReleaseCapabilityPayload(options) {
  if (process.versions.node !== EXPECTED_NODE_VERSION) {
    throw new Error(`release capability replay requires Node ${EXPECTED_NODE_VERSION}`);
  }
  const payload = collectReleaseCapabilityPayload(options);
  const root = materialize(payload.selected);
  const rows = [];
  try {
    for (const work of payload.work) {
      const inputBytes = fs.readFileSync(
        safeMaterializedPath(root, work.testCase.inputRef.path),
      );
      const input = parseClosedJcs(inputBytes, `${work.testCase.caseId}/input`);
      const semantic = work.capabilityDescriptor.implementationMode
        === REQUIRED_GATE_SEMANTIC_IMPLEMENTATION_MODE;
      const entrypointPath = safeMaterializedPath(
        root,
        work.capability.entrypointRef.path,
      );
      const execution = executeCase(
        root,
        entrypointPath,
        inputBytes,
        options.timeoutMs || 3000,
        semantic,
        semantic ? work.inputContract.invocation.argv : [],
      );
      verifyCaseResult(work, execution, input);
      rows.push({
        capabilityId: work.entry.capabilityId,
        caseId: work.testCase.caseId,
        category: work.category,
        status: execution.value.status,
        outcome: execution.value.outcome,
        code: execution.value.code,
        outputDigest: sha256(execution.bytes),
        stderrDigest: sha256(execution.stderr || Buffer.alloc(0)),
      });
      if (typeof options.onProgress === 'function' && rows.length % 32 === 0) {
        options.onProgress(rows.length, EXPECTED_CASE_COUNT);
      }
    }
    const executedCapabilities = new Set(rows.map((row) => row.capabilityId));
    if (executedCapabilities.size !== EXPECTED_CAPABILITY_COUNT
        || rows.length !== EXPECTED_CASE_COUNT) {
      throw new Error(
        `release capability replay requires exact ${EXPECTED_CAPABILITY_COUNT}/${EXPECTED_CASE_COUNT} execution; `
          + `found ${executedCapabilities.size}/${rows.length}`,
      );
    }
    return {
      outcome: 'passed',
      capabilityCount: executedCapabilities.size,
      requiredGateCapabilityCount: payload.closure.requiredGateCount,
      releaseCheckCapabilityCount: payload.closure.releaseCheckCount,
      caseCount: rows.length,
      rows,
      isolatedTemporaryCopy: true,
      callerEvidenceAccepted: false,
    };
  } finally {
    removeReplayRoot(root);
  }
}

module.exports = {
  EXPECTED_CAPABILITY_COUNT,
  EXPECTED_CASE_COUNT,
  EXPECTED_NODE_VERSION,
  EXPECTED_IMPLEMENTATION_PATHS,
  TOOL_ID,
  assertReleaseRegistryMatchesLock,
  collectReleaseCapabilityPayload,
  executeReleaseCapabilityPayload,
  validateJsonSchema,
};
