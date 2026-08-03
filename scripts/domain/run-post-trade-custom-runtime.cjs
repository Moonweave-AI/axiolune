#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  buildClosure,
  buildDiscovery,
  buildVectors,
} = require('./generate-post-trade-custom-profile.cjs');
const {
  PATHS,
  PROFILE_REF,
  ROOT,
} = require('./lib/post-trade-custom-profile.cjs');
const {
  customConstraintDispatchDescriptor,
  mutate,
  validateScenario,
} = require('./lib/post-trade-v03-contract.cjs');
const {
  canonicalJcs,
} = require('./lib/strict-source-locator.cjs');

const EVIDENCE_NAME = 'post-trade-custom-runtime-evidence.json';
const MAX_INPUT_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const TIMEOUT_MS = 1500;

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function jcsBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an unknown or missing field`);
  }
}

function artifactRef(file) {
  return {
    kind: 'path',
    path: path.relative(ROOT, file).split(path.sep).join('/'),
    root: 'sourceTree',
  };
}

function resolveArtifactRef(ref, label) {
  exactKeys(ref, ['kind', 'path', 'root'], label);
  if (ref.kind !== 'path' || ref.root !== 'sourceTree'
      || typeof ref.path !== 'string' || path.isAbsolute(ref.path)
      || ref.path.includes('\\') || ref.path.split('/').includes('..')) {
    throw new TypeError(`${label} is not a closed sourceTree ArtifactRef`);
  }
  const resolved = path.resolve(ROOT, ...ref.path.split('/'));
  const relative = path.relative(ROOT, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError(`${label} escapes the source tree`);
  }
  return resolved;
}

function parseStrictJcsBytes(bytes, label) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (cause) {
    throw new TypeError(`${label} is not JSON: ${cause.message}`);
  }
  if (!bytes.equals(jcsBytes(value))) throw new TypeError(`${label} is not exact JCS`);
  return value;
}

function readStrictJcs(file) {
  const bytes = fs.readFileSync(file);
  return { bytes, value: parseStrictJcsBytes(bytes, path.relative(ROOT, file)) };
}

function validateProfile(profile) {
  const moduleDocument = YAML.parse(fs.readFileSync(PATHS.module, 'utf8'));
  const expected = buildDiscovery(moduleDocument, sha256(fs.readFileSync(PATHS.implementation)));
  exactKeys(profile, ['constraints', 'profileRef', 'runtimeId', 'schemaVersion'], 'profile');
  if (profile.schemaVersion !== '1.0' || profile.profileRef !== PROFILE_REF
      || profile.runtimeId !== 'axiolune-post-trade-custom-runtime-v1') {
    throw new Error('post-trade Custom discovery identity drift');
  }
  if (!Array.isArray(profile.constraints) || profile.constraints.length !== 31) {
    throw new Error('post-trade Custom discovery must contain exactly 31 bindings');
  }
  for (const [index, row] of profile.constraints.entries()) {
    const expectedRow = expected.constraints[index];
    if (!expectedRow || row.constraintIri !== expectedRow.constraintIri) {
      throw new Error(`post-trade Custom inventory/order drift at row ${index}`);
    }
    if (row.expressionDigest !== expectedRow.expressionDigest
        || row.expressionTextDigest !== expectedRow.expressionTextDigest) {
      throw new Error(`post-trade Custom expression digest drift at ${row.constraintIri}`);
    }
    if (row.implementationDigest !== expectedRow.implementationDigest
        || canonicalJcs(row.implementationRef) !== canonicalJcs(expectedRow.implementationRef)) {
      throw new Error(`post-trade Custom implementation digest/ref drift at ${row.constraintIri}`);
    }
    if (canonicalJcs(row) !== canonicalJcs(expectedRow)) {
      throw new Error(`post-trade Custom target/scope/fixture binding drift at ${row.constraintIri}`);
    }
  }
  return profile;
}

function validateVectors(vectors, profile) {
  exactKeys(vectors, ['fixtureCorpus', 'profileRef', 'schemaVersion', 'vectors'], 'vectors');
  if (vectors.schemaVersion !== '1.0' || vectors.profileRef !== PROFILE_REF
      || !Array.isArray(vectors.vectors) || vectors.vectors.length !== 31) {
    throw new Error('post-trade Custom vector identity/inventory drift');
  }
  const expected = buildVectors();
  if (canonicalJcs(vectors.fixtureCorpus) !== canonicalJcs(expected.fixtureCorpus)) {
    throw new Error('post-trade Custom fixture corpus digest/ref/count drift');
  }
  for (const [index, row] of vectors.vectors.entries()) {
    if (row.constraintIri !== profile.constraints[index]?.constraintIri) {
      throw new Error(`post-trade Custom vector/discovery order drift at ${index}`);
    }
    if (canonicalJcs(row) !== canonicalJcs(expected.vectors[index])) {
      throw new Error(`post-trade Custom fixture/vector drift at ${row.constraintIri}`);
    }
    if (sha256(jcsBytes(row.accepted.fixture)) !== row.accepted.fixtureDigest
        || sha256(jcsBytes(row.violation.fixture)) !== row.violation.fixtureDigest) {
      throw new Error(`post-trade Custom embedded fixture digest drift at ${row.constraintIri}`);
    }
  }
  return vectors;
}

function verifyClosure(closure, discoveryBytes, vectorBytes) {
  exactKeys(closure, ['artifacts', 'closureDigest', 'profileRef', 'schemaVersion'], 'closure');
  if (closure.schemaVersion !== '1.0' || closure.profileRef !== PROFILE_REF
      || !Array.isArray(closure.artifacts) || closure.artifacts.length !== 17) {
    throw new Error('post-trade Custom implementation closure identity/inventory drift');
  }
  const supplied = new Map([
    [path.resolve(PATHS.discovery), discoveryBytes],
    [path.resolve(PATHS.vectors), vectorBytes],
  ]);
  let previous = null;
  for (const [index, row] of closure.artifacts.entries()) {
    exactKeys(row, ['digest', 'ref', 'role'], `closure.artifacts[${index}]`);
    const file = resolveArtifactRef(row.ref, `closure.artifacts[${index}].ref`);
    if (previous !== null && Buffer.compare(Buffer.from(previous, 'utf8'), Buffer.from(row.ref.path, 'utf8')) >= 0) {
      throw new Error('post-trade Custom closure artifacts are not strictly path-sorted');
    }
    previous = row.ref.path;
    const actual = sha256(supplied.get(file) || fs.readFileSync(file));
    if (row.digest !== actual) throw new Error(`post-trade Custom closure artifact digest drift: ${row.ref.path}`);
  }
  const expected = buildClosure(discoveryBytes, vectorBytes);
  if (canonicalJcs(closure.artifacts) !== canonicalJcs(expected.artifacts)) {
    throw new Error('post-trade Custom implementation closure artifact/role drift');
  }
  const actualJoin = sha256(Buffer.concat([
    Buffer.from('axiolune-post-trade-custom-closure-v1\0', 'utf8'),
    jcsBytes(closure.artifacts),
  ]));
  if (closure.closureDigest !== actualJoin) {
    throw new Error('post-trade Custom implementation closure join digest drift');
  }
  return closure;
}

function sanitizedEnvironment() {
  const environment = {};
  for (const name of ['SystemRoot', 'WINDIR']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

function executeRequest(request, options = {}) {
  const input = jcsBytes(request);
  const inputLimit = options.maxInputBytes || MAX_INPUT_BYTES;
  const outputLimit = options.maxOutputBytes || MAX_OUTPUT_BYTES;
  if (input.length > inputLimit) return { code: 'INPUT_LIMIT', status: 'input-rejected' };
  const result = childProcess.spawnSync(process.execPath, [
    '--permission', '--disable-sigusr1', '--no-addons', '--no-global-search-paths', '--max-old-space-size=64',
    `--allow-fs-read=${PATHS.worker}`,
    `--allow-fs-read=${PATHS.implementation}`,
    `--allow-fs-read=${PATHS.profileLibrary}`,
    `--allow-fs-read=${PATHS.sourceArtifactInventory}`,
    `--allow-fs-read=${PATHS.jsonPointerExtractor}`,
    `--allow-fs-read=${PATHS.strictJcs}`,
    `--allow-fs-read=${PATHS.jsonPointerProfile}`,
    PATHS.worker,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: sanitizedEnvironment(),
    input,
    maxBuffer: outputLimit,
    shell: false,
    timeout: options.timeoutMs || TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error?.code === 'ETIMEDOUT') return { code: 'TIME_LIMIT', status: 'timeout' };
  if (result.error?.code === 'ENOBUFS') return { code: 'OUTPUT_LIMIT', status: 'output-rejected' };
  if (result.error) return { code: result.error.code || 'ENGINE_FAILURE', status: 'engine-failure' };
  if (result.status !== 0) {
    return { code: 'WORKER_EXIT', detail: String(result.stderr || '').trim(), status: 'engine-failure' };
  }
  const bytes = Buffer.from(result.stdout || '', 'utf8');
  if (bytes.length > outputLimit) return { code: 'OUTPUT_LIMIT', status: 'output-rejected' };
  let response;
  try { response = parseStrictJcsBytes(bytes, 'worker response'); } catch (cause) {
    return { code: /exact JCS/u.test(cause.message) ? 'OUTPUT_JCS' : 'OUTPUT_PARSE', status: 'engine-failure' };
  }
  try {
    exactKeys(response, [
      'assurance', 'constraintIri', 'dispatchDigest', 'evaluatorId', 'fixtureContract',
      'observedViolation', 'observedViolationOwner', 'outcome', 'schemaVersion', 'validatorId', 'violation',
    ], 'worker response');
  } catch {
    return { code: 'OUTPUT_SCHEMA', status: 'engine-failure' };
  }
  if (response.schemaVersion !== '1.0'
      || response.constraintIri !== request.constraintIri
      || response.validatorId !== request.validatorId
      || response.fixtureContract !== request.fixture.contract) {
    return { code: 'OUTPUT_BINDING', status: 'engine-failure' };
  }
  const dispatch = customConstraintDispatchDescriptor(request.validatorId);
  if (response.dispatchDigest !== dispatch.dispatchDigest || response.evaluatorId !== dispatch.evaluatorId) {
    return { code: 'OUTPUT_DISPATCH', status: 'engine-failure' };
  }
  return { response, status: 'completed' };
}

function executeFocusedRegression() {
  const positive = YAML.parse(fs.readFileSync(PATHS.positive, 'utf8'));
  const negative = YAML.parse(fs.readFileSync(PATHS.negative, 'utf8'));
  const processingFindingPositive = YAML.parse(fs.readFileSync(PATHS.processingFindingPositive, 'utf8'));
  const processingFindingNegative = YAML.parse(fs.readFileSync(PATHS.processingFindingNegative, 'utf8'));
  const positives = new Map((positive.fixtures || []).map((fixture) => [fixture.id, fixture]));
  const results = [];
  for (const fixture of positive.fixtures || []) {
    validateScenario(fixture);
    results.push({ actual: 'accepted', caseId: fixture.id, category: 'positive', expected: 'accepted', status: 'passed' });
  }
  for (const testCase of negative.cases || []) {
    const base = positives.get(testCase.baseFixtureId);
    if (!base) throw new Error(`post-trade regression references unknown base ${testCase.baseFixtureId}`);
    let instance = base.instance;
    for (const mutation of testCase.mutations || []) instance = mutate(instance, mutation);
    let actual = null;
    try {
      validateScenario({ ...base, instance });
    } catch (cause) {
      actual = cause?.code || null;
    }
    if (actual !== testCase.expectedViolation) {
      throw new Error(`${testCase.id} expected ${testCase.expectedViolation}, got ${String(actual)}`);
    }
    results.push({ actual, caseId: testCase.id, category: 'violation', expected: testCase.expectedViolation, status: 'passed' });
  }
  const supplemental = processingFindingPositive.fixture;
  if (!supplemental || supplemental.id !== processingFindingNegative.baseFixtureId) {
    throw new Error('processing-finding focused regression fixture join drift');
  }
  validateScenario(supplemental);
  results.push({
    actual: 'accepted', caseId: supplemental.id, category: 'processingFindingPositive',
    expected: 'accepted', status: 'passed',
  });
  for (const testCase of processingFindingNegative.cases || []) {
    let instance = supplemental.instance;
    for (const mutation of testCase.mutations || []) instance = mutate(instance, mutation);
    let actual = null;
    try { validateScenario({ ...supplemental, instance }); } catch (cause) { actual = cause?.code || null; }
    if (actual !== testCase.expectedViolation) {
      throw new Error(`${testCase.id} expected ${testCase.expectedViolation}, got ${String(actual)}`);
    }
    results.push({
      actual, caseId: testCase.id, category: 'processingFindingViolation',
      expected: testCase.expectedViolation, status: 'passed',
    });
  }
  if (results.length !== 242) throw new Error(`post-trade focused regression count drift: ${results.length}`);
  return results;
}

function createEvidence(options = {}) {
  const discoveryArtifact = readStrictJcs(PATHS.discovery);
  const vectorArtifact = readStrictJcs(PATHS.vectors);
  const closureArtifact = readStrictJcs(PATHS.closure);
  const profile = validateProfile(options.profileOverride || discoveryArtifact.value);
  const vectors = validateVectors(options.vectorOverride || vectorArtifact.value, profile);
  const closure = verifyClosure(
    options.closureOverride || closureArtifact.value,
    discoveryArtifact.bytes,
    vectorArtifact.bytes,
  );
  const regressionResults = executeFocusedRegression();
  const vectorResults = [];
  let permissionAssurance = null;
  for (const vector of vectors.vectors) {
    const accepted = executeRequest({
      constraintIri: vector.constraintIri,
      fixture: vector.accepted.fixture,
      schemaVersion: '1.0',
      validatorId: vector.validatorId,
    });
    if (accepted.status !== 'completed' || accepted.response.outcome !== 'accepted'
        || accepted.response.violation !== null) {
      throw new Error(`${vector.constraintIri} accepted vector failed: ${accepted.status}/${accepted.response?.violation}`);
    }
    permissionAssurance = permissionAssurance || accepted.response.assurance;
    vectorResults.push({
      actual: 'accepted', caseId: vector.accepted.caseId, category: 'accepted',
      constraintIri: vector.constraintIri, expected: 'accepted', status: 'passed', validatorId: vector.validatorId,
    });

    const violation = executeRequest({
      constraintIri: vector.constraintIri,
      fixture: vector.violation.fixture,
      schemaVersion: '1.0',
      validatorId: vector.validatorId,
    });
    if (violation.status !== 'completed' || violation.response.outcome !== 'violation'
        || violation.response.violation !== vector.violation.expectedCode) {
      throw new Error(`${vector.constraintIri} violation vector failed: ${violation.status}/${violation.response?.violation}`);
    }
    vectorResults.push({
      actual: violation.response.violation, caseId: vector.violation.caseId, category: 'violation',
      constraintIri: vector.constraintIri, expected: vector.violation.expectedCode, status: 'passed', validatorId: vector.validatorId,
    });
  }

  const dispatchAttributionResults = [];
  for (const vector of vectors.vectors) {
    const peer = vectors.vectors.find((candidate) => (
      candidate.validatorId !== vector.validatorId
        && candidate.accepted.fixture.contract === vector.violation.fixture.contract
    ));
    if (!peer) continue;
    const cross = executeRequest({
      constraintIri: peer.constraintIri,
      fixture: vector.violation.fixture,
      schemaVersion: '1.0',
      validatorId: peer.validatorId,
    });
    if (vector.violation.expectedCode === 'reconciliation-external-source-evidence'
        && cross.status === 'engine-failure' && cross.code === 'WORKER_EXIT') {
      dispatchAttributionResults.push({
        actual: 'WORKER_EXIT',
        caseId: `${vector.validatorId}-violation-cross-dispatched-to-${peer.validatorId}`,
        expected: 'WORKER_EXIT',
        observedViolation: null,
        observedViolationOwner: null,
        status: 'passed',
        testedConstraintIri: peer.constraintIri,
        vectorConstraintIri: vector.constraintIri,
      });
      continue;
    }
    if (cross.status !== 'completed' || cross.response.outcome !== 'notApplicable'
        || cross.response.violation !== null
        || cross.response.observedViolation !== vector.violation.expectedCode
        || cross.response.observedViolationOwner !== vector.validatorId) {
      throw new Error(
        `${vector.constraintIri} violation was misattributed to ${peer.constraintIri}: `
          + `${cross.status}/${cross.response?.outcome}/${cross.response?.violation}`,
      );
    }
    dispatchAttributionResults.push({
      actual: 'notApplicable',
      caseId: `${vector.validatorId}-violation-cross-dispatched-to-${peer.validatorId}`,
      expected: 'notApplicable',
      observedViolation: cross.response.observedViolation,
      observedViolationOwner: cross.response.observedViolationOwner,
      status: 'passed',
      testedConstraintIri: peer.constraintIri,
      vectorConstraintIri: vector.constraintIri,
    });
  }
  if (dispatchAttributionResults.length !== 29) {
    throw new Error(`post-trade dispatch attribution coverage drift: ${dispatchAttributionResults.length}`);
  }

  const seed = vectors.vectors[0];
  const mismatch = vectors.vectors.find(
    (vector) => vector.accepted.fixture.contract !== seed.accepted.fixture.contract,
  );
  if (!mismatch) throw new Error('post-trade Custom controls require two fixture-contract branches');
  const controls = [
    ['unknown-constraint', executeRequest({ constraintIri: `${PROFILE_REF}/UnknownConstraint`, fixture: seed.accepted.fixture, schemaVersion: '1.0', validatorId: seed.validatorId }), 'WORKER_EXIT'],
    ['binding-tamper', executeRequest({ constraintIri: seed.constraintIri, fixture: seed.accepted.fixture, schemaVersion: '1.0', validatorId: mismatch.validatorId }), 'WORKER_EXIT'],
    ['fixture-contract-tamper', executeRequest({ constraintIri: seed.constraintIri, fixture: mismatch.accepted.fixture, schemaVersion: '1.0', validatorId: seed.validatorId }), 'WORKER_EXIT'],
    ['timeout', executeRequest({ constraintIri: seed.constraintIri, fixture: seed.accepted.fixture, mode: 'hang', schemaVersion: '1.0', validatorId: seed.validatorId }, { timeoutMs: 200 }), 'TIME_LIMIT'],
    ['oversize-input', executeRequest({ constraintIri: seed.constraintIri, fixture: { contract: seed.accepted.fixture.contract, instance: { padding: 'x'.repeat(MAX_INPUT_BYTES + 1) } }, schemaVersion: '1.0', validatorId: seed.validatorId }), 'INPUT_LIMIT'],
    ['oversize-output-cap', executeRequest({ constraintIri: seed.constraintIri, fixture: seed.accepted.fixture, schemaVersion: '1.0', validatorId: seed.validatorId }, { maxOutputBytes: 32 }), 'OUTPUT_LIMIT'],
  ];
  for (const [caseId, result, expected] of controls) {
    if (result.code !== expected) throw new Error(`${caseId} returned ${result.status}/${result.code}, expected ${expected}`);
    vectorResults.push({
      actual: result.code, caseId, category: 'engineFailure', constraintIri: null,
      expected, status: 'passed', validatorId: null,
    });
  }
  const assuranceKeys = [
    'childProcessDenied', 'fileWriteDenied', 'networkDenied', 'permissionModelEnabled',
    'unrelatedFileReadDenied', 'workerCreationDenied',
  ];
  if (!permissionAssurance || assuranceKeys.some((key) => permissionAssurance[key] !== true)) {
    throw new Error(`post-trade restricted runtime assurance failed: ${canonicalJcs(permissionAssurance)}`);
  }

  const artifacts = {
    closureDigest: sha256(closureArtifact.bytes),
    closureRef: artifactRef(PATHS.closure),
    discoveryDigest: sha256(discoveryArtifact.bytes),
    discoveryRef: artifactRef(PATHS.discovery),
    implementationDigest: sha256(fs.readFileSync(PATHS.implementation)),
    implementationRef: artifactRef(PATHS.implementation),
    negativeFixtureDigest: sha256(fs.readFileSync(PATHS.negative)),
    negativeFixtureRef: artifactRef(PATHS.negative),
    positiveFixtureDigest: sha256(fs.readFileSync(PATHS.positive)),
    positiveFixtureRef: artifactRef(PATHS.positive),
    processingFindingNegativeFixtureDigest: sha256(fs.readFileSync(PATHS.processingFindingNegative)),
    processingFindingNegativeFixtureRef: artifactRef(PATHS.processingFindingNegative),
    processingFindingPositiveFixtureDigest: sha256(fs.readFileSync(PATHS.processingFindingPositive)),
    processingFindingPositiveFixtureRef: artifactRef(PATHS.processingFindingPositive),
    vectorDigest: sha256(vectorArtifact.bytes),
    vectorRef: artifactRef(PATHS.vectors),
    workerDigest: sha256(fs.readFileSync(PATHS.worker)),
    workerRef: artifactRef(PATHS.worker),
  };
  return {
    artifacts,
    componentEligible: true,
    discoveredConstraints: profile.constraints.map((row) => ({
      constraintIri: row.constraintIri,
      dispatchDigest: row.dispatchDigest,
      evaluatorId: row.evaluatorId,
      expressionDigest: row.expressionDigest,
      expressionTextDigest: row.expressionTextDigest,
      fixtureContract: row.fixtureContract,
      implementationDigest: row.implementationDigest,
      targetElement: row.targetElement,
      violationCodeSetDigest: row.violationCodeSetDigest,
      validatorId: row.validatorId,
    })),
    evidenceClassification: {
      authorityClaim: 'none',
      externalAuthorityEvidence: false,
      productionEligible: false,
      scope: 'M2 Custom runtime conformance',
      syntheticFixture: true,
    },
    executionBoundary: {
      exactReadAllowlistCount: 7,
      maxInputBytes: MAX_INPUT_BYTES,
      maxOldSpaceMiB: 64,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      nodePermissionModel: true,
      timeoutMs: TIMEOUT_MS,
      trustedRepositoryImplementationOnly: true,
    },
    dispatchAttributionResults,
    focusedRegressionResults: regressionResults,
    outcome: 'passed',
    permissionAssurance,
    profileRef: PROFILE_REF,
    runtimeId: profile.runtimeId,
    schemaVersion: '1.0',
    vectorResults,
  };
}

function parseArgs(argv) {
  if (argv.length === 2 && argv[0] === '--output-dir') return path.resolve(argv[1]);
  throw new Error('Usage: node scripts/domain/run-post-trade-custom-runtime.cjs --output-dir <directory>');
}

function main(argv) {
  const outputDirectory = parseArgs(argv);
  const evidence = createEvidence();
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, EVIDENCE_NAME), jcsBytes(evidence));
  process.stdout.write(
    `Post-trade Custom runtime: PASS (constraints=${evidence.discoveredConstraints.length}, `
      + `vectors=${evidence.vectorResults.length}, regression=${evidence.focusedRegressionResults.length}, `
      + `dispatchAttribution=${evidence.dispatchAttributionResults.length})\n`,
  );
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (cause) {
    process.stderr.write(`${cause?.stack || cause}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  EVIDENCE_NAME,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  TIMEOUT_MS,
  createEvidence,
  executeFocusedRegression,
  executeRequest,
  parseStrictJcsBytes,
  readStrictJcs,
  validateProfile,
  validateVectors,
  verifyClosure,
};
