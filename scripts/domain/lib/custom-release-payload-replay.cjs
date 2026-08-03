'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const { runtimeJcs } = require('./custom-release-capability.cjs');
const {
  executeRequest: executeOrdersPortfolioRequest,
  executeRequestWithReconciliationEvidence,
} = require('../run-orders-portfolio-custom-runtime.cjs');

const RECONCILIATION_VALIDATOR_ID = 'PortfolioPositionReconciliationFindingContract';

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const EXPECTED_NODE_VERSION = '24.18.0';
const RUNTIME_SANDBOX_PATHS = Object.freeze([
  'scripts/domain/strategy-research-v03-profile/quantity-unit-registry.json',
  'scripts/domain/lib/strategy-research-quantity-units.cjs',
  'tests/m2/fixtures/risk-bucket-key-contract-v1.json',
  'tests/m2/fixtures/risk-evidence-v1.json',
  'tests/m2/fixtures/risk-measurement-retraction-v1.json',
  'scripts/domain/reference-extractors/json-pointer-jcs-v1.json',
  'scripts/domain/reference-extractors/whole-file-v1.json',
]);
const CATEGORIES = Object.freeze(['positive', 'violation', 'tamper', 'emptySubject', 'engineFailure']);
const REGISTRY_ENTRY_FIELDS = Object.freeze([
  'constraintIri', 'toolId', 'toolVersion', 'toolArtifactRef',
  'toolArtifactDigest', 'runtimeRef', 'runtimeDigest', 'capabilityRef',
  'capabilityDigest', 'entrypointRef', 'entrypointDigest', 'inputContractRef',
  'inputContractDigest', 'outputContractRef', 'outputContractDigest',
  'discoveryContractRef', 'discoveryContractDigest', 'evidenceSchemaRef',
  'evidenceSchemaDigest', 'testVectorsRef', 'testVectorsDigest',
]);
const ASSURANCE_FIELDS = Object.freeze([
  'childProcessDenied', 'fileWriteDenied', 'networkDenied', 'permissionModelEnabled',
  'unrelatedFileReadDenied', 'workerCreationDenied',
]);
const TOOL_PROFILES = Object.freeze({
  'axiolune-identifier-custom-runtime-v1': Object.freeze({
    groupId: 'identifier',
    entrypointPath: 'scripts/domain/foundation-identifier-worker.cjs',
    discoveryPath: 'scripts/domain/identifier-custom-profile/v0.3.0/discovery-contract.json',
    protocol: 'identifier-files-jcs-v1',
  }),
  'axiolune-foundation-market-strategy-custom-runtime-v1': Object.freeze({
    groupId: 'foundation-market-strategy',
    entrypointPath: 'scripts/domain/foundation-market-strategy-custom-worker.cjs',
    discoveryPath: 'scripts/domain/foundation-market-strategy-custom-profile/v0.3.0/discovery-contract.json',
    protocol: 'stdin-jcs-v1',
  }),
  'axiolune-orders-portfolio-custom-runtime-v1': Object.freeze({
    groupId: 'orders-portfolio',
    entrypointPath: 'scripts/domain/orders-portfolio-custom-worker.cjs',
    discoveryPath: 'scripts/domain/orders-portfolio-custom-profile/v0.3.0/discovery-contract.json',
    protocol: 'stdin-jcs-v1',
  }),
  'axiolune-post-trade-custom-runtime-v1': Object.freeze({
    groupId: 'post-trade',
    entrypointPath: 'scripts/domain/post-trade-custom-worker.cjs',
    discoveryPath: 'scripts/domain/post-trade-custom-profile/v0.3.0/discovery-contract.json',
    protocol: 'stdin-jcs-v1',
  }),
  'axiolune-risk-custom-runtime-v1': Object.freeze({
    groupId: 'risk',
    entrypointPath: 'scripts/domain/risk-custom-worker.cjs',
    discoveryPath: 'scripts/domain/risk-custom-profile/v0.3.0/discovery-contract.json',
    protocol: 'stdin-jcs-v1',
  }),
});

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function safePath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0
      || relativePath.includes('\\') || relativePath.startsWith('/')
      || /^[A-Za-z]:/u.test(relativePath)
      || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe payload path ${String(relativePath)}`);
  }
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`payload path escapes root ${relativePath}`);
  return absolute;
}

function artifact(files, ref, digest, label) {
  if (!ref || ref.kind !== 'path' || ref.root !== 'sourceTree') throw new Error(`${label} is not a sourceTree path ref`);
  const bytes = files.get(ref.path);
  if (!Buffer.isBuffer(bytes)) throw new Error(`${label} is absent from reconstructed P1 bytes`);
  return bytes;
}

function walkSourceTreeRefs(value, refs) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkSourceTreeRefs(item, refs);
    return;
  }
  if (value.kind === 'path' && value.root === 'sourceTree' && typeof value.path === 'string') {
    refs.add(value.path);
  }
  for (const nested of Object.values(value)) walkSourceTreeRefs(nested, refs);
}

function addScenarioClosureArtifacts(selected, files, inputBytes, label) {
  let input;
  try {
    input = JSON.parse(inputBytes.toString('utf8'));
  } catch (cause) {
    throw new Error(`${label} is not JSON: ${cause.message}`);
  }
  const refs = new Set();
  walkSourceTreeRefs(input.scenario ?? input, refs);
  for (const refPath of refs) {
    if (selected.has(refPath)) continue;
    const hostBytes = files.get(refPath);
    if (!Buffer.isBuffer(hostBytes)) {
      throw new Error(`${label} references missing sourceTree artifact ${refPath}`);
    }
    selected.set(refPath, hostBytes);
  }
}

function parseJcs(bytes, label, runtime = false) {
  const value = JSON.parse(bytes.toString('utf8'));
  const expected = Buffer.from(runtime ? runtimeJcs(value) : canonicalJcs(value), 'utf8');
  if (!bytes.equals(expected)) throw new Error(`${label} is not exact canonical JCS`);
  return value;
}

function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function registryEntry(tool, capability) {
  return {
    constraintIri: capability.capabilityId,
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

function normalizeExpectedConstraintIris(expectedConstraintIris) {
  if (!Array.isArray(expectedConstraintIris) || expectedConstraintIris.length === 0
      || expectedConstraintIris.some((iri) => typeof iri !== 'string' || iri.length === 0)) {
    throw new Error('authoritative ontology Custom constraint IRI inventory is required');
  }
  const sorted = [...expectedConstraintIris].sort(byteCompare);
  if (new Set(sorted).size !== sorted.length) {
    throw new Error('authoritative ontology Custom constraint IRI inventory contains duplicates');
  }
  return sorted;
}

function assertRegistryMatchesLock(registry, lock, expectedConstraintIris) {
  if (!exactFields(registry, ['schemaVersion', 'profileRef', 'entries'])
      || registry.schemaVersion !== '1.0' || registry.profileRef !== PROFILE_REF
      || !Array.isArray(registry.entries)) {
    throw new Error('Custom capability registry differs from its closed release schema');
  }
  const authoritativeIris = normalizeExpectedConstraintIris(expectedConstraintIris);
  const expected = [];
  for (const tool of Array.isArray(lock?.tools) ? lock.tools : []) {
    if (!Object.hasOwn(TOOL_PROFILES, tool.toolId)) continue;
    for (const capability of Array.isArray(tool?.capabilities) ? tool.capabilities : []) {
      expected.push(registryEntry(tool, capability));
    }
  }
  expected.sort((left, right) => byteCompare(left.constraintIri, right.constraintIri));
  let previous = null;
  for (let index = 0; index < registry.entries.length; index += 1) {
    const actual = registry.entries[index];
    if (!exactFields(actual, REGISTRY_ENTRY_FIELDS)) {
      throw new Error(`Custom capability registry entry ${index} differs from its closed schema`);
    }
    if (previous !== null && byteCompare(previous, actual.constraintIri) >= 0) {
      throw new Error(`Custom capability registry entry ${index} is reordered or duplicated`);
    }
    previous = actual.constraintIri;
  }
  const lockIris = expected.map((entry) => entry.constraintIri);
  const registryIris = registry.entries.map((entry) => entry.constraintIri);
  if (canonicalJcs(lockIris) !== canonicalJcs(authoritativeIris)
      || canonicalJcs(registryIris) !== canonicalJcs(authoritativeIris)) {
    throw new Error(
      'Custom capability registry/lock does not exactly equal the authoritative '
        + `ontology Custom IRI inventory (${authoritativeIris.length} definitions)`,
    );
  }
  for (let index = 0; index < registry.entries.length; index += 1) {
    const actual = registry.entries[index];
    if (canonicalJcs(actual) !== canonicalJcs(expected[index])) {
      throw new Error(`Custom capability registry entry ${index} does not exactly equal the P1 toolchain lock row`);
    }
  }
  return expected;
}

function addArtifact(selected, files, tuple, label) {
  const bytes = artifact(files, tuple.ref, tuple.digest, label);
  selected.set(tuple.ref.path, bytes);
  return bytes;
}

function collectPayloadClosure(files, lock, registry, expectedConstraintIris) {
  assertRegistryMatchesLock(registry, lock, expectedConstraintIris);
  const selected = new Map();
  const work = [];
  let contextCount = 0;
  const runtimeTuples = new Map();
  for (const tool of lock.tools.filter((row) => Object.hasOwn(TOOL_PROFILES, row.toolId))) {
    const profile = TOOL_PROFILES[tool.toolId];
    const toolBytes = addArtifact(selected, files, {
      ref: tool.artifactRef, digest: tool.artifactDigest,
    }, `${tool.toolId} tool descriptor`);
    const descriptor = parseJcs(toolBytes, `${tool.toolId} tool descriptor`);
    if (descriptor.toolId !== tool.toolId || descriptor.groupId !== profile.groupId
        || descriptor.entrypoint?.ref?.path !== profile.entrypointPath
        || descriptor.componentDiscovery?.ref?.path !== profile.discoveryPath) {
      throw new Error(`${tool.toolId} descriptor substitutes its group/entrypoint/discovery identity`);
    }
    if (descriptor.entrypoint.digest !== tool.capabilities[0]?.entrypointDigest) {
      throw new Error(`${tool.toolId} descriptor/first capability entrypoint digest mismatch`);
    }
    const runtimeKey = canonicalJcs({ ref: tool.runtimeRef, digest: tool.runtimeDigest });
    let runtime = runtimeTuples.get(runtimeKey);
    if (!runtime) {
      const bytes = addArtifact(selected, files, {
        ref: tool.runtimeRef, digest: tool.runtimeDigest,
      }, `${tool.toolId} runtime lock`);
      runtime = parseJcs(bytes, `${tool.toolId} runtime lock`);
      runtimeTuples.set(runtimeKey, runtime);
    }
    if (runtime.version !== EXPECTED_NODE_VERSION || runtime.engine !== 'node'
        || runtime.permissionModelRequired !== true || runtime.networkPolicy !== 'deny') {
      throw new Error(`${tool.toolId} runtime permission/version declaration is invalid`);
    }
    addArtifact(selected, files, runtime.dependencyLock, `${tool.toolId} dependency lock`);
    const runtimeEntrypoint = runtime.entrypoints?.find((row) => row.toolId === tool.toolId);
    if (!runtimeEntrypoint || runtimeEntrypoint.entrypoint.ref.path !== profile.entrypointPath
        || runtimeEntrypoint.entrypoint.digest !== descriptor.entrypoint.digest) {
      throw new Error(`${tool.toolId} runtime lock does not bind its direct entrypoint`);
    }
    if (!Array.isArray(descriptor.implementationArtifacts) || descriptor.implementationArtifacts.length === 0) {
      throw new Error(`${tool.toolId} implementation closure is empty`);
    }
    let workerPresent = false;
    for (const implementation of descriptor.implementationArtifacts) {
      addArtifact(selected, files, implementation, `${tool.toolId} implementation ${implementation.ref?.path}`);
      if (implementation.ref.path === profile.entrypointPath
          && implementation.digest === descriptor.entrypoint.digest) workerPresent = true;
    }
    if (!workerPresent) throw new Error(`${tool.toolId} direct worker is outside implementation closure`);
    addArtifact(selected, files, descriptor.componentDiscovery, `${tool.toolId} component discovery`);
    for (const capability of tool.capabilities) {
      if (capability.entrypointRef.path !== profile.entrypointPath
          || capability.entrypointDigest !== descriptor.entrypoint.digest) {
        throw new Error(`${capability.capabilityId} substitutes a facade or worker digest`);
      }
      let subjectDescriptor = null;
      for (const prefix of [
        'capability', 'inputContract', 'outputContract', 'discoveryContract',
        'evidenceSchema', 'testVectors',
      ]) {
        const bytes = addArtifact(selected, files, {
          ref: capability[`${prefix}Ref`], digest: capability[`${prefix}Digest`],
        }, `${capability.capabilityId} ${prefix}`);
        if (prefix === 'capability') {
          subjectDescriptor = parseJcs(bytes, `${capability.capabilityId} capability`);
        }
        if (prefix === 'testVectors') {
          const vectors = parseJcs(bytes, `${capability.capabilityId} vectors`);
          for (const category of CATEGORIES) {
            for (const testCase of vectors.categories?.[category] || []) {
              const inputBytes = addArtifact(selected, files, {
                ref: testCase.inputRef, digest: testCase.inputDigest,
              }, `${capability.capabilityId}/${category} input`);
              addScenarioClosureArtifacts(
                selected,
                files,
                inputBytes,
                `${capability.capabilityId}/${category} input`,
              );
            }
          }
        }
      }
      if (!Number.isSafeInteger(subjectDescriptor?.contextCount)
          || subjectDescriptor.contextCount < 1) {
        throw new Error(`${capability.capabilityId} capability has no positive exact context count`);
      }
      contextCount += subjectDescriptor.contextCount;
      work.push({ capability, descriptor, profile, tool });
    }
  }
  for (const relativePath of RUNTIME_SANDBOX_PATHS) {
    if (!selected.has(relativePath) && Buffer.isBuffer(files.get(relativePath))) {
      selected.set(relativePath, files.get(relativePath));
    }
  }
  return { contextCount, selected, work };
}

function materialize(selected) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-custom-p1-replay-'));
  for (const [relativePath, bytes] of selected) {
    const file = safePath(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: 'wx' });
  }
  return root;
}

function copyRuntimeDependencies(payloadRoot, hostDependencyRoot) {
  const lock = JSON.parse(fs.readFileSync(safePath(payloadRoot, 'package-lock.json'), 'utf8'));
  const dependencies = ['argparse', 'js-yaml', 'yaml'];
  const copied = [];
  for (const name of dependencies) {
    const locked = lock.packages?.[`node_modules/${name}`];
    if (!locked || typeof locked.version !== 'string' || typeof locked.integrity !== 'string') {
      throw new Error(`package-lock does not pin ${name} version/integrity`);
    }
    const source = path.join(hostDependencyRoot, 'node_modules', name);
    const packageJson = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    if (packageJson.version !== locked.version) throw new Error(`installed ${name} version differs from P1 package-lock`);
    const target = path.join(payloadRoot, 'node_modules', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, dereference: false, errorOnExist: true, force: false });
    copied.push(target);
  }
  return copied;
}

function sandboxEnvironment() {
  const result = { TZ: 'UTC' };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[name] === 'string') result[name] = process.env[name];
  }
  return result;
}

function permissionArguments(readPaths, writePaths = []) {
  return [
    '--permission', '--disable-sigusr1', '--no-addons', '--no-global-search-paths',
    '--max-old-space-size=64',
    ...[...new Set(readPaths)].map((file) => `--allow-fs-read=${file}`),
    ...[...new Set(writePaths)].map((file) => `--allow-fs-write=${file}`),
  ];
}

function spawnStdinWorker(options) {
  const result = spawnSync(process.execPath, [
    ...permissionArguments(options.readPaths), options.entrypoint,
  ], {
    cwd: options.root,
    encoding: null,
    env: sandboxEnvironment(),
    input: options.inputBytes,
    maxBuffer: options.maxOutputBytes ?? 128 * 1024,
    shell: false,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  if (result.error?.code === 'ETIMEDOUT') return { status: 'engineFailure', code: 'TIME_LIMIT', outputBytes: null, stderrBytes: Buffer.from(result.stderr || '') };
  if (result.error?.code === 'ENOBUFS') return { status: 'engineFailure', code: 'OUTPUT_LIMIT', outputBytes: null, stderrBytes: Buffer.from(result.stderr || '') };
  if (result.error) return { status: 'engineFailure', code: result.error.code || 'ENGINE_FAILURE', outputBytes: null, stderrBytes: Buffer.from(result.stderr || '') };
  if (result.status !== 0) return { status: 'engineFailure', code: 'WORKER_EXIT', outputBytes: null, stderrBytes: Buffer.from(result.stderr || '') };
  const outputBytes = Buffer.from(result.stdout || '');
  if (outputBytes.length > (options.maxOutputBytes ?? 128 * 1024)) {
    return { status: 'engineFailure', code: 'OUTPUT_LIMIT', outputBytes: null, stderrBytes: Buffer.from(result.stderr || '') };
  }
  try {
    return {
      status: 'completed', code: null,
      output: parseJcs(outputBytes, 'worker output'),
      outputBytes,
      stderrBytes: Buffer.from(result.stderr || ''),
    };
  } catch (cause) {
    return { status: 'engineFailure', code: /canonical/u.test(cause.message) ? 'OUTPUT_JCS' : 'OUTPUT_PARSE', outputBytes: null, stderrBytes: Buffer.from(result.stderr || '') };
  }
}

function spawnIdentifierWorker(options) {
  const outputDirectory = path.join(options.root, '.replay-output');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputFile = path.join(outputDirectory, `${options.caseKey}.json`);
  const registry = safePath(options.root, 'scripts/domain/identifier-custom-profile/v0.3.0/scheme-validator-registry.json');
  const result = spawnSync(process.execPath, [
    ...permissionArguments(options.readPaths, [outputFile]),
    options.entrypoint, options.inputFile, registry, outputFile,
  ], {
    cwd: options.root,
    encoding: null,
    env: sandboxEnvironment(),
    maxBuffer: options.maxOutputBytes ?? 64 * 1024,
    shell: false,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  if (result.error?.code === 'ETIMEDOUT') return { status: 'engineFailure', code: 'TIME_LIMIT', outputBytes: null, stderrBytes: Buffer.from(result.stderr || '') };
  if (result.error?.code === 'ENOBUFS') return { status: 'engineFailure', code: 'OUTPUT_LIMIT', outputBytes: null, stderrBytes: Buffer.from(result.stderr || '') };
  if (result.error) return { status: 'engineFailure', code: result.error.code || 'ENGINE_FAILURE', outputBytes: null, stderrBytes: Buffer.from(result.stderr || '') };
  if (!fs.existsSync(outputFile)) return { status: 'engineFailure', code: 'WORKER_OUTPUT_MISSING', outputBytes: null, stderrBytes: Buffer.from(result.stderr || '') };
  const outputBytes = fs.readFileSync(outputFile);
  let output;
  try { output = parseJcs(outputBytes, 'identifier worker output'); } catch {
    return { status: 'engineFailure', code: 'OUTPUT_JCS', outputBytes: null, stderrBytes: Buffer.from(result.stderr || '') };
  }
  const expectedExit = { conforms: 0, violation: 1, engineFailure: 2 }[output.outcome];
  if (result.status !== expectedExit) return { status: 'engineFailure', code: 'OUTPUT_EXIT_BINDING', outputBytes, output, stderrBytes: Buffer.from(result.stderr || '') };
  const status = output.outcome === 'engineFailure' ? 'engineFailure' : 'completed';
  const outcome = output.outcome === 'conforms' ? 'accepted' : output.outcome;
  const code = output.outcome === 'violation'
    ? output.violations?.[0]?.code || null
    : output.outcome === 'engineFailure' ? output.errors?.[0]?.code || null : null;
  return { status, outcome, code, output, outputBytes, stderrBytes: Buffer.from(result.stderr || '') };
}

function normalizeStdin(groupId, execution) {
  if (execution.status !== 'completed') return { ...execution, outcome: 'engineFailure' };
  const output = execution.output;
  const outcome = output.outcome === 'rejected' ? 'violation' : output.outcome;
  let code = null;
  if (outcome === 'violation') {
    code = groupId === 'foundation-market-strategy'
      ? output.observedViolationCodes?.[0] || null : output.violation;
  }
  return { ...execution, outcome, code };
}

function ordersPortfolioStdinExecution(groupId, category, inputBytes, spawnOptions) {
  const request = JSON.parse(inputBytes.toString('utf8'));
  const useReconciliationEvidence = groupId === 'orders-portfolio'
    && category === 'positive'
    && request.validatorId === RECONCILIATION_VALIDATOR_ID;
  if (!useReconciliationEvidence) {
    return normalizeStdin(groupId, spawnStdinWorker(spawnOptions));
  }
  const execution = executeRequestWithReconciliationEvidence(request, 'baseline');
  if (execution.status !== 'completed') {
    return {
      status: 'engineFailure',
      outcome: 'engineFailure',
      code: execution.code || 'ENGINE_FAILURE',
      output: null,
      outputBytes: null,
      stderrBytes: Buffer.from(String(execution.detail || ''), 'utf8'),
    };
  }
  const output = execution.response;
  const outcome = output.outcome === 'rejected' ? 'violation' : output.outcome;
  const code = outcome === 'violation' ? output.violation : null;
  const outputBytes = Buffer.from(canonicalJcs(output), 'utf8');
  return {
    status: 'completed',
    outcome,
    code,
    output,
    outputBytes,
    stderrBytes: Buffer.alloc(0),
  };
}

function verifyResultIdentity(work, category, expected, execution) {
  const descriptor = parseJcs(
    fs.readFileSync(safePath(work.root, work.capability.capabilityRef.path)),
    `${work.capability.capabilityId} descriptor`,
  );
  if (execution.status !== expected.status || execution.outcome !== expected.outcome
      || execution.code !== expected.code || expected.semanticOwner !== work.capability.capabilityId) {
    throw new Error(
      `${work.capability.capabilityId}/${category} expected `
        + `${expected.status}/${expected.outcome}/${String(expected.code)}, got `
        + `${execution.status}/${String(execution.outcome)}/${String(execution.code)} `
        + `stderr=${String(execution.stderrBytes || '').slice(0, 2048)}`,
    );
  }
  const output = execution.output;
  if (!output) return descriptor;
  if (work.profile.groupId === 'identifier') {
    if (!['tamper', 'emptySubject'].includes(category)
        && output.constraintDefinitionIri !== work.capability.capabilityId) {
      throw new Error(`${work.capability.capabilityId}/${category} identifier output owner mismatch`);
    }
    return descriptor;
  }
  if (output.constraintIri !== work.capability.capabilityId
      || output.dispatchDigest !== descriptor.semanticOwner.dispatchDigest) {
    throw new Error(`${work.capability.capabilityId}/${category} output constraint/dispatch mismatch`);
  }
  if (work.profile.groupId === 'risk') {
    if (output.evaluatorId !== descriptor.semanticOwner.evaluatorId) throw new Error(`${work.capability.capabilityId} evaluator mismatch`);
  } else if (output.validatorId !== descriptor.semanticOwner.validatorId) {
    throw new Error(`${work.capability.capabilityId} validator mismatch`);
  }
  if (work.profile.groupId === 'post-trade'
      && output.evaluatorId !== descriptor.semanticOwner.evaluatorId) {
    throw new Error(`${work.capability.capabilityId} post-trade evaluator mismatch`);
  }
  if (category === 'positive'
      && !ASSURANCE_FIELDS.every((field) => output.assurance?.[field] === true)) {
    throw new Error(`${work.capability.capabilityId} worker permission self-assurance failed`);
  }
  if (category === 'violation' && work.profile.groupId === 'foundation-market-strategy'
      && (output.observedViolationOwner !== expected.semanticOwner
        || output.observedViolationCodes.length === 0
        || output.observedViolationCodes.some((code) => code !== expected.code))) {
    throw new Error(`${work.capability.capabilityId} violation owner/code mismatch`);
  }
  return descriptor;
}

function rowEvidence(work, testCase, execution) {
  return {
    caseId: testCase.caseId,
    category: testCase.category,
    constraintIri: work.capability.capabilityId,
    inputDigest: testCase.inputDigest,
    status: execution.status,
    outcome: execution.outcome,
    code: execution.code,
    semanticOwner: work.capability.capabilityId,
    output: execution.output || null,
    outputDigest: execution.outputBytes ? sha256(execution.outputBytes) : null,
    stderrDigest: sha256(execution.stderrBytes || Buffer.alloc(0)),
  };
}

function removeTemporaryRoot(root) {
  const resolved = path.resolve(root);
  const tempPrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(tempPrefix) || !path.basename(resolved).startsWith('axiolune-custom-p1-replay-')) {
    throw new Error(`refusing to remove non-replay path ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function executeCustomPayload(options) {
  if (process.versions.node !== EXPECTED_NODE_VERSION) throw new Error(`payload replay requires Node ${EXPECTED_NODE_VERSION}`);
  const expectedConstraintIris = normalizeExpectedConstraintIris(options.expectedConstraintIris);
  const expectedDefinitionCount = expectedConstraintIris.length;
  const expectedCaseCount = expectedDefinitionCount * CATEGORIES.length;
  const closure = collectPayloadClosure(
    options.files,
    options.lock,
    options.registry,
    expectedConstraintIris,
  );
  if (options.expectedContextCount !== undefined
      && closure.contextCount !== options.expectedContextCount) {
    throw new Error(
      `Custom payload context inventory differs from ontology: expected `
        + `${options.expectedContextCount}; found ${closure.contextCount}`,
    );
  }
  const root = materialize(closure.selected);
  const rows = [];
  try {
    const dependencyPaths = copyRuntimeDependencies(root, options.hostDependencyRoot);
    for (const base of closure.work) {
      const work = { ...base, root };
      const toolDescriptor = base.descriptor;
      const implementationReads = toolDescriptor.implementationArtifacts
        .map((row) => safePath(root, row.ref.path));
      const readPaths = [
        ...implementationReads,
        ...dependencyPaths,
        safePath(root, 'scripts/domain/lib'),
        safePath(root, 'scripts/domain/reference-extractors'),
        safePath(root, 'scripts/domain/strategy-research-v03-profile'),
        safePath(root, 'scripts/domain/identifier-custom-profile'),
        safePath(root, 'tests/m2/fixtures'),
        safePath(root, 'reference'),
      ];
      const vectors = parseJcs(
        fs.readFileSync(safePath(root, base.capability.testVectorsRef.path)),
        `${base.capability.capabilityId} vectors`,
      );
      for (const category of CATEGORIES) {
        for (const testCase of vectors.categories[category]) {
          const inputFile = safePath(root, testCase.inputRef.path);
          const inputBytes = fs.readFileSync(inputFile);
          parseJcs(inputBytes, `${testCase.caseId} input`, true);
          let execution;
          if (base.profile.protocol === 'identifier-files-jcs-v1') {
            execution = spawnIdentifierWorker({
              root, entrypoint: safePath(root, base.profile.entrypointPath), inputFile,
              readPaths: [...readPaths, inputFile], caseKey: crypto.createHash('sha256').update(testCase.caseId).digest('hex'),
              timeoutMs: 2500, maxOutputBytes: 64 * 1024,
            });
          } else if (base.profile.groupId === 'orders-portfolio') {
            execution = ordersPortfolioStdinExecution(base.profile.groupId, category, inputBytes, {
              root, entrypoint: safePath(root, base.profile.entrypointPath), inputBytes,
              readPaths, timeoutMs: category === 'engineFailure' ? 250 : 2500,
              maxOutputBytes: 128 * 1024,
            });
          } else {
            execution = normalizeStdin(base.profile.groupId, spawnStdinWorker({
              root, entrypoint: safePath(root, base.profile.entrypointPath), inputBytes,
              readPaths, timeoutMs: category === 'engineFailure' ? 250 : 2500,
              maxOutputBytes: 128 * 1024,
            }));
          }
          verifyResultIdentity(work, category, testCase.expected, execution);
          rows.push(rowEvidence(work, testCase, execution));
          if (typeof options.onProgress === 'function' && rows.length % 50 === 0) {
            options.onProgress(rows.length, expectedCaseCount);
          }
        }
      }
    }
    if (closure.work.length !== expectedDefinitionCount || rows.length !== expectedCaseCount) {
      throw new Error(
        `payload replay requires exactly ${expectedDefinitionCount} definitions / ${expectedCaseCount} cases; `
          + `found ${closure.work.length} / ${rows.length}`,
      );
    }
    return {
      outcome: 'passed',
      definitionCount: closure.work.length,
      contextCount: closure.contextCount,
      caseCount: rows.length,
      rows,
      isolatedTemporaryCopy: true,
      callerEvidenceAccepted: false,
    };
  } finally {
    removeTemporaryRoot(root);
  }
}

module.exports = {
  ASSURANCE_FIELDS,
  CATEGORIES,
  TOOL_PROFILES,
  assertRegistryMatchesLock,
  collectPayloadClosure,
  executeCustomPayload,
  permissionArguments,
  spawnIdentifierWorker,
  spawnStdinWorker,
};
