'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  CONSTRAINTS,
  normalizeSchemeValidatorRegistry,
} = require('./foundation-identifier-custom.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROFILE_ROOT = path.join(ROOT, 'scripts', 'domain', 'identifier-custom-profile', 'v0.3.0');
const WORKER_PATH = path.join(ROOT, 'scripts', 'domain', 'foundation-identifier-worker.cjs');
const WASM_CORE_PATH = path.join(
  PROFILE_ROOT,
  'foundation-identifier-core.wasm',
);
const WAT_SOURCE_PATH = path.join(
  PROFILE_ROOT,
  'foundation-identifier-core.wat',
);
const WASM_BUILD_PATH = path.join(ROOT, 'scripts', 'domain', 'build-foundation-identifier-wasm.cjs');
const MODULE_PATH = path.join(ROOT, 'ontology', 'domain', 'finance', 'foundation', 'module.yaml');
const IMPLEMENTATION_CLOSURE_PATH = path.join(PROFILE_ROOT, 'implementation-closure.json');
const DISCOVERY_PATH = path.join(PROFILE_ROOT, 'discovery-contract.json');
const INPUT_CONTRACT_PATH = path.join(PROFILE_ROOT, 'input-contract.json');
const OUTPUT_CONTRACT_PATH = path.join(PROFILE_ROOT, 'output-contract.json');
const EVIDENCE_SCHEMA_PATH = path.join(PROFILE_ROOT, 'evidence.schema.json');
const TEST_VECTORS_PATH = path.join(PROFILE_ROOT, 'test-vectors.json');
const REGISTRY_PATH = path.join(PROFILE_ROOT, 'scheme-validator-registry.json');
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const IMPLEMENTATION_CLOSURE_TAG =
  'axiolune-foundation-identifier-implementation-closure-v1\0';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function sourceRef(relativePath) {
  return { kind: 'path', path: relativePath, root: 'sourceTree' };
}

function repositoryPath(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function fileDigest(file) {
  return sha256(fs.readFileSync(file));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (actual.length !== wanted.length
      || actual.some((field, index) => field !== wanted[index])) {
    throw new TypeError(`${label} fields differ: actual=${actual.join(',')} expected=${wanted.join(',')}`);
  }
}

function readStrictJcs(file, label = repositoryPath(file)) {
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes.toString('utf8'));
  const canonical = Buffer.from(canonicalJcs(value), 'utf8');
  if (!bytes.equals(canonical)) throw new Error(`${label} must be exact UTF-8 RFC 8785 JCS bytes`);
  return { bytes, value };
}

function implementationClosureDigest(artifacts) {
  return sha256(Buffer.concat([
    Buffer.from(IMPLEMENTATION_CLOSURE_TAG, 'utf8'),
    Buffer.from(canonicalJcs(artifacts), 'utf8'),
  ]));
}

function verifyImplementationClosure(candidate = null) {
  const closure = candidate || readStrictJcs(IMPLEMENTATION_CLOSURE_PATH).value;
  exactKeys(closure, ['artifacts', 'closureDigest', 'schemaVersion'], 'implementation closure');
  if (closure.schemaVersion !== '1.0' || !Array.isArray(closure.artifacts)) {
    throw new TypeError('implementation closure must be schemaVersion 1.0 with an artifacts array');
  }
  const expected = [
    ['implementation', 'scripts/domain/lib/foundation-identifier-custom.cjs'],
    ['runtimeDependency', 'scripts/domain/lib/strict-source-locator.cjs'],
    ['registry', 'scripts/domain/identifier-custom-profile/v0.3.0/scheme-validator-registry.json'],
    ['wasm', 'scripts/domain/identifier-custom-profile/v0.3.0/foundation-identifier-core.wasm'],
    ['worker', 'scripts/domain/foundation-identifier-worker.cjs'],
  ].sort((left, right) => compareUtf8(left[1], right[1]));
  if (closure.artifacts.length !== expected.length) {
    throw new Error(`implementation closure requires exactly ${expected.length} artifacts`);
  }
  let previous = null;
  closure.artifacts.forEach((artifact, index) => {
    exactKeys(artifact, ['digest', 'ref', 'role'], `implementation closure artifact ${index}`);
    exactKeys(artifact.ref, ['kind', 'path', 'root'], `implementation closure artifact ${index} ref`);
    const [role, expectedPath] = expected[index];
    if (artifact.role !== role
        || artifact.ref.kind !== 'path'
        || artifact.ref.root !== 'sourceTree'
        || artifact.ref.path !== expectedPath) {
      throw new Error(`implementation closure artifact ${index} identity mismatch`);
    }
    if (previous !== null && compareUtf8(previous, artifact.ref.path) >= 0) {
      throw new Error('implementation closure artifacts must be strictly UTF-8 sorted and unique');
    }
    const absolute = path.join(ROOT, ...artifact.ref.path.split('/'));
    if (artifact.digest !== fileDigest(absolute)) {
      throw new Error(`implementation closure digest mismatch for ${artifact.ref.path}`);
    }
    previous = artifact.ref.path;
  });
  if (closure.closureDigest !== implementationClosureDigest(closure.artifacts)) {
    throw new Error('implementation closure semantic digest mismatch');
  }
  return closure;
}

function validateDiscoveryDocument(discovery) {
  exactKeys(
    discovery,
    ['constraints', 'moduleRef', 'profileRef', 'schemaVersion'],
    'identifier discovery contract',
  );
  if (discovery.schemaVersion !== '1.0' || discovery.profileRef !== PROFILE_REF) {
    throw new Error('identifier discovery contract version/profile mismatch');
  }
  exactKeys(discovery.moduleRef, ['kind', 'path', 'root'], 'identifier discovery moduleRef');
  if (canonicalJcs(discovery.moduleRef) !== canonicalJcs(sourceRef(repositoryPath(MODULE_PATH)))) {
    throw new Error('identifier discovery contract must target the Foundation module');
  }
  if (!Array.isArray(discovery.constraints) || discovery.constraints.length !== 4) {
    throw new Error('identifier discovery contract must contain exactly four constraints');
  }
  let previous = null;
  for (const [index, row] of discovery.constraints.entries()) {
    exactKeys(
      row,
      ['capabilityId', 'constraintDefinitionIri', 'expression', 'profile', 'targetIdentifierTypeIri'],
      `identifier discovery row ${index}`,
    );
    const expected = CONSTRAINTS[row.constraintDefinitionIri];
    if (!expected
        || row.capabilityId !== expected.capabilityId
        || row.profile !== expected.profile
        || row.targetIdentifierTypeIri !== expected.targetIdentifierTypeIri) {
      throw new Error(`identifier discovery row ${index} is not bound to the implementation inventory`);
    }
    if (previous !== null && compareUtf8(previous, row.constraintDefinitionIri) >= 0) {
      throw new Error('identifier discovery rows must be strictly IRI sorted and unique');
    }
    previous = row.constraintDefinitionIri;
  }
}

function discoverIdentifierConstraints(moduleDocument, discovery) {
  validateDiscoveryDocument(discovery);
  const authored = Object.values(moduleDocument?.domain?.constraints || {})
    .filter((value) => value?.constraintType === 'Custom' && value?.scope === 'Identifier')
    .sort((left, right) => compareUtf8(left.iri, right.iri));
  if (authored.length !== discovery.constraints.length) {
    throw new Error(
      `Foundation Identifier Custom inventory mismatch: authored=${authored.length}, locked=${discovery.constraints.length}`,
    );
  }
  for (let index = 0; index < authored.length; index += 1) {
    const actual = authored[index];
    const expected = discovery.constraints[index];
    if (actual.iri !== expected.constraintDefinitionIri
        || actual.targetElement !== expected.targetIdentifierTypeIri
        || actual.expression?.language !== 'Custom'
        || actual.expression?.expression !== expected.expression
        || actual.severity !== 'Error') {
      throw new Error(`Foundation Identifier Custom constraint drift at ${expected.constraintDefinitionIri}`);
    }
    const type = Object.values(moduleDocument.domain.identifierTypes || {})
      .find((candidate) => candidate?.iri === expected.targetIdentifierTypeIri);
    if (!type || type.validatorRef !== expected.constraintDefinitionIri) {
      throw new Error(`IdentifierTypeDefinition validatorRef drift at ${expected.targetIdentifierTypeIri}`);
    }
    const bindings = (moduleDocument.domain.constraintBindings || []).filter((binding) => (
      binding?.constraintRef === expected.constraintDefinitionIri
    ));
    if (bindings.length !== 1
        || bindings[0].targetElement !== expected.targetIdentifierTypeIri
        || bindings[0].enforcementLevel !== 'Mandatory') {
      throw new Error(
        `Foundation Identifier Custom ConstraintBinding drift at ${expected.constraintDefinitionIri}`,
      );
    }
  }
  return authored.map((value) => value.iri);
}

function loadCapabilityArtifacts() {
  const closure = verifyImplementationClosure();
  const discoveryArtifact = readStrictJcs(DISCOVERY_PATH);
  validateDiscoveryDocument(discoveryArtifact.value);
  const input = readStrictJcs(INPUT_CONTRACT_PATH);
  const output = readStrictJcs(OUTPUT_CONTRACT_PATH);
  const evidence = readStrictJcs(EVIDENCE_SCHEMA_PATH);
  const vectors = readStrictJcs(TEST_VECTORS_PATH);
  const registry = readStrictJcs(REGISTRY_PATH);
  normalizeSchemeValidatorRegistry(registry.value);
  return {
    closure,
    discovery: discoveryArtifact.value,
    input: input.value,
    output: output.value,
    evidence: evidence.value,
    vectors: vectors.value,
    registry: registry.value,
  };
}

function expectedCapabilityRows(artifacts = null) {
  const loaded = artifacts || loadCapabilityArtifacts();
  const capabilityRef = sourceRef(repositoryPath(IMPLEMENTATION_CLOSURE_PATH));
  const capabilityDigest = fileDigest(IMPLEMENTATION_CLOSURE_PATH);
  const entrypointRef = sourceRef(repositoryPath(WORKER_PATH));
  const entrypointDigest = fileDigest(WORKER_PATH);
  const inputContractRef = sourceRef(repositoryPath(INPUT_CONTRACT_PATH));
  const outputContractRef = sourceRef(repositoryPath(OUTPUT_CONTRACT_PATH));
  const discoveryContractRef = sourceRef(repositoryPath(DISCOVERY_PATH));
  const evidenceSchemaRef = sourceRef(repositoryPath(EVIDENCE_SCHEMA_PATH));
  const testVectorsRef = sourceRef(repositoryPath(TEST_VECTORS_PATH));
  return loaded.discovery.constraints.map((row) => ({
    capabilityDigest,
    capabilityId: row.capabilityId,
    capabilityRef,
    discoveryContractDigest: fileDigest(DISCOVERY_PATH),
    discoveryContractRef,
    entrypointDigest,
    entrypointRef,
    evidenceSchemaDigest: fileDigest(EVIDENCE_SCHEMA_PATH),
    evidenceSchemaRef,
    inputContractDigest: fileDigest(INPUT_CONTRACT_PATH),
    inputContractRef,
    outputContractDigest: fileDigest(OUTPUT_CONTRACT_PATH),
    outputContractRef,
    testVectorsDigest: fileDigest(TEST_VECTORS_PATH),
    testVectorsRef,
  }));
}

function validateWorkerOutput(value) {
  exactKeys(
    value,
    ['constraintDefinitionIri', 'errors', 'focusNode', 'outcome', 'schemaVersion', 'violations'],
    'identifier worker output',
  );
  if (value.schemaVersion !== '1.0'
      || !['conforms', 'engineFailure', 'violation'].includes(value.outcome)
      || !Array.isArray(value.errors)
      || !Array.isArray(value.violations)) {
    throw new TypeError('identifier worker output has invalid common fields');
  }
  if (value.outcome === 'conforms' && (value.errors.length !== 0 || value.violations.length !== 0)) {
    throw new Error('conforming output must contain no errors or violations');
  }
  if (value.outcome === 'violation' && (value.errors.length !== 0 || value.violations.length === 0)) {
    throw new Error('violation output must contain violations and no engine errors');
  }
  if (value.outcome === 'engineFailure' && (value.errors.length === 0 || value.violations.length !== 0)) {
    throw new Error('engineFailure output must contain errors and no violations');
  }
}

function sandboxEnvironment() {
  const allowed = {};
  for (const key of ['SystemRoot', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string') allowed[key] = process.env[key];
  }
  allowed.TZ = 'UTC';
  return allowed;
}

function executeSandboxed(input, options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-identifier-custom-'));
  const inputFile = path.join(tempRoot, 'input.json');
  const outputDirectory = path.join(tempRoot, 'output');
  const outputFile = path.join(outputDirectory, 'result.json');
  fs.mkdirSync(outputDirectory);
  if (fs.readdirSync(outputDirectory).length !== 0) throw new Error('sandbox output directory is not empty');
  fs.writeFileSync(inputFile, Buffer.from(canonicalJcs(input), 'utf8'), { flag: 'wx' });
  const args = [
    '--permission',
    '--disable-sigusr1',
    '--no-addons',
    '--no-global-search-paths',
    '--max-old-space-size=64',
    `--allow-fs-read=${WORKER_PATH}`,
    `--allow-fs-read=${path.join(ROOT, 'scripts', 'domain', 'lib', 'foundation-identifier-custom.cjs')}`,
    `--allow-fs-read=${path.join(ROOT, 'scripts', 'domain', 'lib', 'strict-source-locator.cjs')}`,
    `--allow-fs-read=${WASM_CORE_PATH}`,
    `--allow-fs-read=${REGISTRY_PATH}`,
    `--allow-fs-read=${inputFile}`,
    `--allow-fs-write=${outputFile}`,
    WORKER_PATH,
    inputFile,
    REGISTRY_PATH,
    outputFile,
  ];
  let execution;
  try {
    execution = spawnSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      env: sandboxEnvironment(),
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: options.timeoutMs || 5000,
      windowsHide: true,
    });
    if (execution.error) throw execution.error;
    if (!fs.existsSync(outputFile)) {
      throw new Error(`identifier worker emitted no output (exit ${String(execution.status)})`);
    }
    const output = readStrictJcs(outputFile, 'identifier worker output').value;
    validateWorkerOutput(output);
    const expectedExit = { conforms: 0, engineFailure: 2, violation: 1 }[output.outcome];
    if (execution.status !== expectedExit) {
      throw new Error(`identifier worker exit ${execution.status} disagrees with ${output.outcome}`);
    }
    return {
      output,
      stderr: execution.stderr,
      stdout: execution.stdout,
    };
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const systemTemp = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (!resolvedTemp.startsWith(systemTemp)) {
      throw new Error(`refusing to remove non-temporary sandbox path ${resolvedTemp}`);
    }
    fs.rmSync(resolvedTemp, { force: true, recursive: true });
  }
}

function loadFoundationModule() {
  return yaml.load(fs.readFileSync(MODULE_PATH, 'utf8'), { schema: yaml.JSON_SCHEMA });
}

module.exports = {
  DISCOVERY_PATH,
  EVIDENCE_SCHEMA_PATH,
  IMPLEMENTATION_CLOSURE_PATH,
  IMPLEMENTATION_CLOSURE_TAG,
  INPUT_CONTRACT_PATH,
  MODULE_PATH,
  OUTPUT_CONTRACT_PATH,
  PROFILE_REF,
  PROFILE_ROOT,
  REGISTRY_PATH,
  ROOT,
  TEST_VECTORS_PATH,
  WASM_BUILD_PATH,
  WASM_CORE_PATH,
  WAT_SOURCE_PATH,
  WORKER_PATH,
  discoverIdentifierConstraints,
  executeSandboxed,
  expectedCapabilityRows,
  fileDigest,
  implementationClosureDigest,
  loadCapabilityArtifacts,
  loadFoundationModule,
  readStrictJcs,
  repositoryPath,
  sha256,
  sourceRef,
  validateDiscoveryDocument,
  validateWorkerOutput,
  verifyImplementationClosure,
};
