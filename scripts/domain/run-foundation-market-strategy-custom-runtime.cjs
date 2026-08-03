#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const {
  BINDING_ROWS,
  CUSTOM_CONSTRAINT_COUNT,
  bindingFor,
  canonicalJcs,
} = require('./lib/foundation-market-strategy-custom-validators.cjs');
const {
  PATHS,
  PROFILE_REF,
  ROOT,
  relative,
  sha256,
} = require('./lib/foundation-market-strategy-custom-profile.cjs');
const {
  expectedArtifacts,
} = require('./generate-foundation-market-strategy-custom-profile.cjs');
const EVIDENCE_FILE = path.join(
  ROOT,
  'scripts/domain/foundation-market-strategy-custom-profile/v0.3.0/runtime-evidence.json',
);
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const TIMEOUT_MS = 2500;

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not allowed`);
  }
}

function readJcs(file) {
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${relative(file)} is not exact UTF-8 JCS`);
  }
  return { bytes, value };
}

function verifyGeneratedArtifacts() {
  for (const [file, expected] of expectedArtifacts()) {
    if (!fs.existsSync(file) || !fs.readFileSync(file).equals(expected)) {
      throw new Error(`six-module Custom artifact drift: ${relative(file)}`);
    }
  }
  const closure = readJcs(PATHS.closure).value;
  exactKeys(closure, ['artifacts', 'closureDigest', 'profileRef', 'schemaVersion'], [], 'closure');
  if (closure.schemaVersion !== '1.0' || closure.profileRef !== PROFILE_REF || !Array.isArray(closure.artifacts)) {
    throw new Error('implementation closure identity is invalid');
  }
  let previous = null;
  for (const artifact of closure.artifacts) {
    exactKeys(artifact, ['digest', 'ref', 'role'], [], 'closure artifact');
    exactKeys(artifact.ref, ['kind', 'path', 'root'], [], 'closure artifact ref');
    if (artifact.ref.kind !== 'path' || artifact.ref.root !== 'sourceTree') {
      throw new Error('closure artifact must use one sourceTree path ref');
    }
    if (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(artifact.ref.path)) >= 0) {
      throw new Error('closure artifacts are not strictly UTF-8 sorted and unique');
    }
    const file = path.join(ROOT, ...artifact.ref.path.split('/'));
    if (artifact.digest !== sha256(fs.readFileSync(file))) {
      throw new Error(`closure digest drift for ${artifact.ref.path}`);
    }
    previous = artifact.ref.path;
  }
  const expectedClosureDigest = sha256(Buffer.concat([
    Buffer.from('axiolune-foundation-market-strategy-custom-closure-v1\0', 'utf8'),
    Buffer.from(canonicalJcs(closure.artifacts), 'utf8'),
  ]));
  if (closure.closureDigest !== expectedClosureDigest) {
    throw new Error('implementation closure semantic digest mismatch');
  }
}

function permissionArguments() {
  const reads = [
    PATHS.worker,
    PATHS.vectors,
    path.join(ROOT, 'scripts/domain/lib'),
    path.join(ROOT, 'scripts/domain/test-foundation-account-identity.cjs'),
    path.join(ROOT, 'scripts/domain/foundation-identifier-worker.cjs'),
    path.join(ROOT, 'scripts/domain/identifier-custom-profile/v0.3.0'),
    path.join(ROOT, 'scripts/domain/reference-extractors/whole-file-v1.json'),
    path.join(ROOT, 'scripts/domain/reference-extractors/text-line-range-utf8-v1.json'),
    path.join(ROOT, 'scripts/domain/reference-extractors/xml-element-v1.json'),
    path.join(ROOT, 'scripts/domain/reference-extractors/pdf-page-range-pdfplumber-v1.json'),
    path.join(ROOT, 'scripts/domain/reference-extractors/tar-gzip-member-v1.json'),
    path.join(ROOT, 'scripts/domain/strategy-research-v03-profile/quantity-unit-registry.json'),
    path.join(ROOT, 'tests/m2/fixtures'),
    path.join(ROOT, 'reference/authority-reference'),
    path.join(ROOT, 'reference/ontology-design-reference/axiolune-controlled-quantity-units'),
    path.join(ROOT, 'node_modules/js-yaml'),
    path.join(ROOT, 'node_modules/argparse'),
    path.join(ROOT, 'node_modules/yaml'),
  ];
  return [
    '--permission',
    '--disable-sigusr1',
    '--no-addons',
    '--no-global-search-paths',
    '--max-old-space-size=96',
    ...reads.map((file) => `--allow-fs-read=${file}`),
  ];
}

function sanitizedEnvironment() {
  const environment = {};
  for (const name of ['SystemRoot', 'WINDIR']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

function spawnWorker(input, options = {}) {
  const args = [
    ...(options.disablePermissions ? [] : permissionArguments()),
    PATHS.worker,
  ];
  return childProcess.spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: sanitizedEnvironment(),
    input,
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: options.timeoutMs || TIMEOUT_MS,
    windowsHide: true,
  });
}

function executeRequest(request, options = {}) {
  const input = options.rawInput || Buffer.from(canonicalJcs(request), 'utf8');
  if (input.length > MAX_INPUT_BYTES) return { code: 'INPUT_LIMIT', status: 'input-rejected' };
  const result = spawnWorker(input, options);
  if (result.error?.code === 'ETIMEDOUT') return { code: 'TIME_LIMIT', status: 'timeout' };
  if (result.error) return { code: result.error.code || 'ENGINE_FAILURE', status: 'engine-failure' };
  if (result.status !== 0) {
    return {
      code: 'WORKER_EXIT',
      detail: String(result.stderr || '').trim(),
      status: 'engine-failure',
    };
  }
  if (Buffer.byteLength(result.stdout || '', 'utf8') > MAX_OUTPUT_BYTES) {
    return { code: 'OUTPUT_LIMIT', status: 'engine-failure' };
  }
  try {
    const response = JSON.parse(result.stdout);
    if (result.stdout !== canonicalJcs(response)) return { code: 'OUTPUT_JCS', status: 'engine-failure' };
    exactKeys(
      response,
      [
        'assurance', 'constraintIri', 'dispatchDigest', 'observedViolationCodes',
        'observedViolationOwner', 'outcome', 'schemaVersion', 'validatorId',
      ],
      [],
      'worker response',
    );
    const binding = bindingFor(request.constraintIri);
    if (response.schemaVersion !== '1.0'
        || response.constraintIri !== binding.constraintIri
        || response.validatorId !== binding.validatorId
        || response.dispatchDigest !== binding.dispatchDigest
        || !Array.isArray(response.observedViolationCodes)) {
      return { code: 'OUTPUT_BINDING', status: 'engine-failure' };
    }
    return { response, status: 'completed' };
  } catch (cause) {
    return { code: 'OUTPUT_PARSE', detail: cause.message, status: 'engine-failure' };
  }
}

function requestFor(binding, scenario, overrides = {}) {
  return {
    constraintIri: binding.constraintIri,
    dispatchDigest: binding.dispatchDigest,
    scenario,
    schemaVersion: '1.0',
    validatorId: binding.validatorId,
    ...overrides,
  };
}

function expectWorkerExit(result, id, controls, detailPattern = null) {
  if (result.status !== 'engine-failure' || result.code !== 'WORKER_EXIT') {
    throw new Error(`${id} did not fail closed: ${canonicalJcs(result)}`);
  }
  if (detailPattern !== null && !detailPattern.test(result.detail || '')) {
    throw new Error(`${id} failed for the wrong reason: ${String(result.detail)}`);
  }
  controls.push({ actual: result.code, expected: 'WORKER_EXIT', id, status: 'passed' });
}

function createEvidence() {
  verifyGeneratedArtifacts();
  const discovery = readJcs(PATHS.discovery);
  const vectors = readJcs(PATHS.vectors).value;
  const input = readJcs(PATHS.inputContract).value;
  const output = readJcs(PATHS.outputContract).value;
  if (canonicalJcs(input.fields) !== canonicalJcs([
    'constraintIri', 'dispatchDigest', 'scenario', 'schemaVersion', 'validatorId',
  ]) || canonicalJcs(output.fields) !== canonicalJcs([
    'assurance', 'constraintIri', 'dispatchDigest', 'observedViolationCodes',
    'observedViolationOwner', 'outcome', 'schemaVersion', 'validatorId',
  ])) {
    throw new Error('canonical input/output field contract drift');
  }
  if (vectors.constraintDefinitionCount !== CUSTOM_CONSTRAINT_COUNT
      || vectors.contextContractCount !== 6
      || vectors.vectors.length !== CUSTOM_CONSTRAINT_COUNT) {
    throw new Error('vector definition/context counts are invalid');
  }

  const vectorResults = [];
  let assurance = null;
  for (const [index, vector] of vectors.vectors.entries()) {
    const owner = bindingFor(vector.constraintIri);
    const positive = executeRequest(requestFor(owner, vector.accepted.scenario));
    if (positive.status !== 'completed'
        || positive.response.outcome !== 'accepted'
        || positive.response.observedViolationOwner !== null
        || positive.response.observedViolationCodes.length !== 0) {
      throw new Error(`${owner.constraintIri} positive vector failed: ${canonicalJcs(positive)}`);
    }
    assurance = assurance || positive.response.assurance;
    vectorResults.push({
      actual: 'accepted',
      category: 'positive',
      constraintIri: owner.constraintIri,
      expected: 'accepted',
      id: vector.accepted.scenario.scenarioId,
      status: 'passed',
    });

    const negative = executeRequest(requestFor(owner, vector.negative.scenario));
    if (negative.status !== 'completed'
        || negative.response.outcome !== 'rejected'
        || negative.response.observedViolationOwner !== owner.constraintIri
        || !negative.response.observedViolationCodes.includes(vector.negative.expectedCode)) {
      throw new Error(`${owner.constraintIri} negative vector failed: ${canonicalJcs(negative)}`);
    }
    vectorResults.push({
      actual: vector.negative.expectedCode,
      category: 'negative',
      constraintIri: owner.constraintIri,
      expected: vector.negative.expectedCode,
      id: vector.negative.scenario.scenarioId,
      status: 'passed',
    });

    const peer = BINDING_ROWS[(index + 1) % BINDING_ROWS.length];
    const cross = executeRequest(requestFor(peer, vector.negative.scenario));
    if (cross.status !== 'completed'
        || cross.response.outcome !== 'notApplicable'
        || cross.response.observedViolationOwner !== owner.constraintIri
        || !cross.response.observedViolationCodes.includes(vector.negative.expectedCode)) {
      throw new Error(`${owner.constraintIri} cross-dispatch failed via ${peer.constraintIri}: ${canonicalJcs(cross)}`);
    }
    vectorResults.push({
      actual: owner.constraintIri,
      category: 'crossDispatch',
      constraintIri: peer.constraintIri,
      expected: owner.constraintIri,
      id: `${vector.negative.scenario.scenarioId}-via-${peer.validatorId}`,
      status: 'passed',
    });
  }
  if (vectorResults.length !== CUSTOM_CONSTRAINT_COUNT * 3) {
    throw new Error(`expected ${CUSTOM_CONSTRAINT_COUNT * 3} vector results, got ${vectorResults.length}`);
  }

  const controls = [];
  const firstVector = vectors.vectors[0];
  const first = bindingFor(firstVector.constraintIri);
  const second = BINDING_ROWS[1];
  expectWorkerExit(executeRequest({
    constraintIri: 'https://axiolune.ai/ontology/finance/foundation/UnboundCustom',
    dispatchDigest: first.dispatchDigest,
    scenario: firstVector.accepted.scenario,
    schemaVersion: '1.0',
    validatorId: first.validatorId,
  }), 'unbound-constraint', controls);
  expectWorkerExit(executeRequest(requestFor(first, firstVector.accepted.scenario, {
    validatorId: second.validatorId,
  })), 'cross-validator-binding', controls);
  expectWorkerExit(executeRequest(requestFor(first, firstVector.accepted.scenario, {
    dispatchDigest: second.dispatchDigest,
  })), 'cross-dispatch-digest-binding', controls);
  expectWorkerExit(executeRequest({
    ...requestFor(first, firstVector.accepted.scenario),
    unknownField: true,
  }), 'unknown-request-field', controls);
  expectWorkerExit(executeRequest(requestFor(first, {
    ...firstVector.accepted.scenario,
    unknownField: true,
  })), 'unknown-scenario-field', controls);
  const payloadMutant = structuredClone(firstVector.accepted.scenario);
  payloadMutant.payload.unreviewedRuntimeField = true;
  expectWorkerExit(executeRequest(requestFor(first, payloadMutant)), 'unknown-payload-field-digest-lock', controls);
  const nonCanonical = Buffer.from(`${JSON.stringify(requestFor(first, firstVector.accepted.scenario), null, 2)}\n`, 'utf8');
  expectWorkerExit(executeRequest({}, { rawInput: nonCanonical }), 'non-jcs-input', controls);

  // The authored fixtures may already carry every decimal as an explicit
  // lexical string, so transport hardening must not depend on finding an
  // incidental YAML binary64 value.  Add a synthetic field to a locked
  // scenario: a canonical decimal string must pass numeric decoding and reach
  // the later digest-lock rejection, while malformed representations must be
  // rejected by the numeric transport boundary first.
  const decimalPath = '/__transportDecimal';
  const decimalScenario = structuredClone(firstVector.accepted.scenario);
  decimalScenario.payload = {
    __transportDecimal: '0.25',
    ...decimalScenario.payload,
  };
  decimalScenario.decimalPaths = [...decimalScenario.decimalPaths, decimalPath].sort();
  const canonicalDecimalResult = executeRequest(requestFor(first, decimalScenario));
  if (canonicalDecimalResult.status !== 'engine-failure'
      || canonicalDecimalResult.code !== 'WORKER_EXIT'
      || !/scenario is not an exact digest-locked formal fixture context/u.test(
        canonicalDecimalResult.detail || '',
      )) {
    throw new Error(
      `canonical decimal transport did not reach the digest boundary: `
        + canonicalJcs(canonicalDecimalResult),
    );
  }

  const binary64Scenario = structuredClone(decimalScenario);
  binary64Scenario.payload.__transportDecimal = 0.25;
  const binary64Raw = Buffer.from(JSON.stringify(requestFor(first, binary64Scenario)), 'utf8');
  expectWorkerExit(
    executeRequest({}, { rawInput: binary64Raw }),
    'binary64-decimal-input',
    controls,
    /safe integers/u,
  );
  for (const [id, lexical] of [
    ['noncanonical-decimal-input', '1.2300'],
    ['lossy-decimal-input', '0.10000000000000001'],
  ]) {
    const lexicalScenario = structuredClone(decimalScenario);
    lexicalScenario.payload.__transportDecimal = lexical;
    const lexicalRaw = Buffer.from(
      JSON.stringify(requestFor(first, lexicalScenario)),
      'utf8',
    );
    expectWorkerExit(
      executeRequest({}, { rawInput: lexicalRaw }),
      id,
      controls,
      /lossless canonical lexical form/u,
    );
  }

  const marketDataVector = vectors.vectors.find((vector) => (
    vector.accepted.scenario.fixtureContract === 'market-data-v03'
      && Array.isArray(vector.accepted.scenario.payload.observations)
  ));
  if (!marketDataVector) throw new Error('market-data boundary vector is absent');
  const unsafeIntegerScenario = structuredClone(marketDataVector.accepted.scenario);
  unsafeIntegerScenario.payload.observations[0].sourceOrderKey = 9_007_199_254_740_992;
  const unsafeIntegerOwner = bindingFor(marketDataVector.constraintIri);
  const unsafeIntegerRaw = Buffer.from(
    JSON.stringify(requestFor(unsafeIntegerOwner, unsafeIntegerScenario)),
    'utf8',
  );
  expectWorkerExit(
    executeRequest({}, { rawInput: unsafeIntegerRaw }),
    'unsafe-integer-input',
    controls,
    /safe integers/u,
  );

  expectWorkerExit(executeRequest(
    requestFor(first, firstVector.accepted.scenario),
    { disablePermissions: true },
  ), 'sandbox-assurance-failure', controls);

  const timeout = executeRequest(
    requestFor(first, firstVector.accepted.scenario, { mode: 'hang' }),
    { timeoutMs: 250 },
  );
  if (timeout.status !== 'timeout' || timeout.code !== 'TIME_LIMIT') {
    throw new Error(`runtime timeout control failed: ${canonicalJcs(timeout)}`);
  }
  controls.push({ actual: timeout.code, expected: 'TIME_LIMIT', id: 'runtime-timeout', status: 'passed' });

  const oversize = requestFor(first, {
    ...firstVector.accepted.scenario,
    payload: { padding: 'x'.repeat(MAX_INPUT_BYTES + 1) },
  });
  const oversizeResult = executeRequest(oversize);
  if (oversizeResult.status !== 'input-rejected' || oversizeResult.code !== 'INPUT_LIMIT') {
    throw new Error(`oversize input control failed: ${canonicalJcs(oversizeResult)}`);
  }
  controls.push({ actual: oversizeResult.code, expected: 'INPUT_LIMIT', id: 'oversize-input', status: 'passed' });

  const assuranceFields = [
    'childProcessDenied', 'fileWriteDenied', 'networkDenied', 'permissionModelEnabled',
    'unrelatedFileReadDenied', 'workerCreationDenied',
  ];
  if (!assurance || assuranceFields.some((field) => assurance[field] !== true)) {
    throw new Error(`runtime sandbox assurance is incomplete: ${canonicalJcs(assurance)}`);
  }
  controls.push({
    actual: 'all-denied',
    expected: 'all-denied',
    id: 'sandbox-permission-assurance',
    status: 'passed',
  });

  return {
    componentEligible: true,
    constraintDefinitionCount: CUSTOM_CONSTRAINT_COUNT,
    contextContractCount: 6,
    controlResults: controls,
    discoveryDigest: sha256(discovery.bytes),
    outcome: 'passed',
    profileRef: PROFILE_REF,
    runtimeId: 'axiolune-foundation-market-strategy-custom-runtime-v1',
    schemaVersion: '1.0',
    vectorResults,
  };
}

function main(argv) {
  if (argv.length !== 1 || !['--check', '--write'].includes(argv[0])) {
    throw new Error('Usage: node scripts/domain/run-foundation-market-strategy-custom-runtime.cjs --check|--write');
  }
  const content = Buffer.from(canonicalJcs(createEvidence()), 'utf8');
  if (argv[0] === '--write') {
    fs.writeFileSync(EVIDENCE_FILE, content);
  } else if (!fs.existsSync(EVIDENCE_FILE) || !fs.readFileSync(EVIDENCE_FILE).equals(content)) {
    throw new Error(`six-module Custom runtime evidence drift: ${relative(EVIDENCE_FILE)}`);
  }
  process.stdout.write(`PASS six-module Custom runtime ${argv[0].slice(2)} (definitions=${CUSTOM_CONSTRAINT_COUNT} contexts=6 vectors=${CUSTOM_CONSTRAINT_COUNT * 3})\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${cause?.stack || cause}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  createEvidence,
  executeRequest,
};
