'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const { PROFILE_REF } = require('./m2-shacl-instance-fixture-compiler.cjs');

const EXPECTED_PYSHACL_VERSION = '0.26.0';
const EXPECTED_RDFLIB_VERSION = '7.6.0';
const WORKER_PATH = path.resolve(
  __dirname,
  '..',
  'shacl-instance-profile',
  'v0.3.0',
  'pyshacl-batch-worker.py',
);
const WORKER_REF = 'scripts/domain/shacl-instance-profile/v0.3.0/pyshacl-batch-worker.py';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

const AGGREGATE_FIELDS = Object.freeze([
  'schemaVersion', 'profileRef', 'artifactKind', 'polarity',
  'rdfCanonicalization', 'rdfCanonicalizer', 'cases',
]);
const CASE_FIELDS = Object.freeze([
  'fixtureId', 'constraintInstanceId', 'emittedBy', 'shapeRef',
  'shapeDigest', 'shapeNQuads', 'dataDigest', 'dataNQuads',
  'focusNode', 'expectedPath', 'expectedComponent', 'expectedSeverity',
  'expectedResult',
]);
const RESPONSE_FIELDS = Object.freeze([
  'schemaVersion', 'engine', 'engineVersion', 'rdfEngine', 'rdfEngineVersion',
  'permissionAssurance', 'results',
]);
const PERMISSION_ASSURANCE = Object.freeze({
  guard: 'python-socket-urllib-v1',
  network: 'denied-in-process',
  socketConstructorProbe: 'denied',
  urlopenProbe: 'denied',
  inference: 'none',
  js: false,
  owlImports: false,
  rules: false,
});
const RESULT_FIELDS = Object.freeze([
  'fixtureId', 'constraintInstanceId', 'polarity', 'outcome',
  'rootResultCount', 'results', 'engineError',
]);
const RESULT_RECORD_FIELDS = Object.freeze([
  'focusNode', 'resultPath', 'sourceConstraintComponent', 'resultSeverity',
  'sourceShape', 'value', 'details',
]);
const ENGINE_ERROR_FIELDS = Object.freeze(['type', 'message', 'causeDigest']);

class ShaclInstanceExecutionError extends Error {
  constructor(code, message, details = null) {
    super(`${code}: ${message}`);
    this.name = 'ShaclInstanceExecutionError';
    this.code = code;
    this.details = details;
  }
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function exactKeys(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort()) === canonicalJcs([...fields].sort());
}

function assertProtocol(condition, code, message, details = null) {
  if (!condition) throw new ShaclInstanceExecutionError(code, message, details);
}

function validateCase(value, polarity, at) {
  assertProtocol(
    exactKeys(value, CASE_FIELDS),
    'M2_SHACL_EXECUTOR_CASE_SCHEMA',
    `${at} differs from the closed fixture case schema`,
  );
  assertProtocol(
    typeof value.fixtureId === 'string'
      && /^[0-9a-f]{64}-(?:positive|negative)$/u.test(value.fixtureId)
      && typeof value.constraintInstanceId === 'string'
      && /^[0-9a-f]{64}$/u.test(value.constraintInstanceId)
      && value.fixtureId === `${value.constraintInstanceId}-${polarity}`
      && value.expectedResult === (polarity === 'positive' ? 'conforms' : 'violates')
      && Array.isArray(value.emittedBy) && value.emittedBy.length > 0
      && value.emittedBy.every((entry) => typeof entry === 'string')
      && typeof value.shapeRef === 'string'
      && typeof value.shapeNQuads === 'string'
      && typeof value.dataNQuads === 'string'
      && /^sha256:[0-9a-f]{64}$/u.test(value.shapeDigest)
      && /^sha256:[0-9a-f]{64}$/u.test(value.dataDigest)
      && typeof value.focusNode === 'string'
      && (value.expectedPath === null || typeof value.expectedPath === 'string')
      && typeof value.expectedComponent === 'string'
      && typeof value.expectedSeverity === 'string',
    'M2_SHACL_EXECUTOR_CASE_VALUE',
    `${at} contains invalid fixture metadata`,
  );
  assertProtocol(
    sha256(Buffer.from(value.shapeNQuads, 'utf8')) === value.shapeDigest
      && sha256(Buffer.from(value.dataNQuads, 'utf8')) === value.dataDigest,
    'M2_SHACL_EXECUTOR_CASE_DIGEST',
    `${at} RDF digest does not match its bytes`,
  );
}

function validateAggregateArtifact(artifact, polarity) {
  assertProtocol(
    exactKeys(artifact, ['value', 'bytes', 'digest'])
      && Buffer.isBuffer(artifact.bytes)
      && /^sha256:[0-9a-f]{64}$/u.test(artifact.digest),
    'M2_SHACL_EXECUTOR_AGGREGATE_ARTIFACT',
    `${polarity} aggregate is not a value/bytes/digest artifact`,
  );
  const expectedBytes = Buffer.from(canonicalJcs(artifact.value), 'utf8');
  assertProtocol(
    artifact.bytes.equals(expectedBytes) && artifact.digest === sha256(artifact.bytes),
    'M2_SHACL_EXECUTOR_AGGREGATE_CANONICAL',
    `${polarity} aggregate is not exact RFC 8785 JCS or its digest drifted`,
  );
  const value = artifact.value;
  assertProtocol(
    exactKeys(value, AGGREGATE_FIELDS)
      && value.schemaVersion === '1.0'
      && value.profileRef === PROFILE_REF
      && value.artifactKind === 'constraintInstanceFixtureAggregate'
      && value.polarity === polarity
      && value.rdfCanonicalization === 'RDFC-1.0'
      && /^rdf-canonize@[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.rdfCanonicalizer)
      && Array.isArray(value.cases),
    'M2_SHACL_EXECUTOR_AGGREGATE_SCHEMA',
    `${polarity} aggregate differs from the closed v1 schema`,
  );
  let previous = null;
  for (const [index, fixture] of value.cases.entries()) {
    validateCase(fixture, polarity, `${polarity}.cases[${index}]`);
    assertProtocol(
      previous === null || byteCompare(previous, fixture.constraintInstanceId) < 0,
      'M2_SHACL_EXECUTOR_AGGREGATE_ORDER',
      `${polarity} aggregate IDs are not byte-sorted and unique`,
    );
    previous = fixture.constraintInstanceId;
  }
  return value;
}

function workerEnvironment() {
  const environment = {
    PYTHONHASHSEED: '0',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONUTF8: '1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '*',
  };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  return environment;
}

function pythonCandidates(options = {}) {
  if (options.pythonPath !== undefined) return [options.pythonPath];
  const candidates = [];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(
      process.env.LOCALAPPDATA,
      'Programs',
      'Python',
      'Python312',
      'python.exe',
    ));
  }
  for (const candidate of options.additionalPythonPaths || []) candidates.push(candidate);
  return [...new Set(candidates)];
}

function probePython(options = {}) {
  const diagnostics = [];
  const script = [
    'import json,sys,pyshacl,rdflib',
    'print(json.dumps({"pythonVersion":".".join(map(str,sys.version_info[:3])),"pyshaclVersion":pyshacl.__version__,"rdflibVersion":rdflib.__version__},sort_keys=True,separators=(",",":")))',
  ].join(';');
  for (const candidate of pythonCandidates(options)) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || !fs.existsSync(candidate)) {
      diagnostics.push(`${String(candidate)}: not an existing absolute executable path`);
      continue;
    }
    const result = spawnSync(candidate, ['-I', '-c', script], {
      cwd: path.dirname(WORKER_PATH),
      encoding: 'utf8',
      env: workerEnvironment(),
      shell: false,
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || result.error) {
      diagnostics.push(`${candidate}: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`);
      continue;
    }
    try {
      const metadata = JSON.parse(result.stdout);
      if (metadata.pyshaclVersion !== EXPECTED_PYSHACL_VERSION) {
        diagnostics.push(`${candidate}: pyshacl ${metadata.pyshaclVersion}`);
        continue;
      }
      if (!/^3\.12\.[0-9]+$/u.test(metadata.pythonVersion)
          || metadata.rdflibVersion !== EXPECTED_RDFLIB_VERSION) {
        diagnostics.push(`${candidate}: invalid runtime metadata`);
        continue;
      }
      return Object.freeze({ executable: candidate, ...metadata });
    } catch (cause) {
      diagnostics.push(`${candidate}: invalid probe output (${cause.message})`);
    }
  }
  throw new ShaclInstanceExecutionError(
    'M2_SHACL_EXECUTOR_RUNTIME_UNAVAILABLE',
    `no absolute Python 3.12 runtime with pySHACL ${EXPECTED_PYSHACL_VERSION} was found`,
    diagnostics,
  );
}

function runWorker(runtime, request, options = {}) {
  const workerPath = options.workerPath ? path.resolve(options.workerPath) : WORKER_PATH;
  assertProtocol(fs.existsSync(workerPath), 'M2_SHACL_EXECUTOR_WORKER_MISSING', workerPath);
  const requestBytes = Buffer.from(canonicalJcs(request), 'utf8');
  const maxOutputBytes = options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.executable, ['-I', workerPath], {
      cwd: path.dirname(workerPath),
      env: workerEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const overflow = (stream) => finish(() => {
      child.kill();
      reject(new ShaclInstanceExecutionError(
        'M2_SHACL_EXECUTOR_OUTPUT_LIMIT',
        `${stream} exceeded ${maxOutputBytes} bytes`,
      ));
    });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) overflow('stdout');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) overflow('stderr');
      else stderr.push(chunk);
    });
    child.on('error', (cause) => finish(() => reject(new ShaclInstanceExecutionError(
      'M2_SHACL_EXECUTOR_SPAWN', cause.message,
    ))));
    child.on('close', (status, signal) => finish(() => {
      const errorText = Buffer.concat(stderr).toString('utf8');
      if (status !== 0) {
        reject(new ShaclInstanceExecutionError(
          'M2_SHACL_EXECUTOR_PROCESS',
          `worker exited with status ${status} signal ${signal || 'none'}: ${errorText.slice(0, 4096)}`,
        ));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
      } catch (cause) {
        reject(new ShaclInstanceExecutionError(
          'M2_SHACL_EXECUTOR_RESPONSE_JSON', cause.message,
        ));
      }
    }));
    const timer = setTimeout(() => finish(() => {
      child.kill();
      reject(new ShaclInstanceExecutionError(
        'M2_SHACL_EXECUTOR_TIMEOUT',
        `worker exceeded ${timeoutMs}ms`,
      ));
    }), timeoutMs);
    child.stdin.on('error', (cause) => finish(() => reject(new ShaclInstanceExecutionError(
      'M2_SHACL_EXECUTOR_STDIN', cause.message,
    ))));
    child.stdin.end(requestBytes);
  });
}

function validateResultRecord(record, at, seen = new Set()) {
  assertProtocol(
    exactKeys(record, RESULT_RECORD_FIELDS)
      && (record.focusNode === null || typeof record.focusNode === 'string')
      && (record.resultPath === null || typeof record.resultPath === 'string')
      && typeof record.sourceConstraintComponent === 'string'
      && typeof record.resultSeverity === 'string'
      && (record.sourceShape === null || typeof record.sourceShape === 'string')
      && (record.value === null || typeof record.value === 'string')
      && Array.isArray(record.details),
    'M2_SHACL_EXECUTOR_RESULT_RECORD',
    `${at} differs from the closed SHACL result schema`,
  );
  assertProtocol(!seen.has(record), 'M2_SHACL_EXECUTOR_DETAIL_CYCLE', at);
  seen.add(record);
  record.details.forEach((detail, index) => validateResultRecord(detail, `${at}.details[${index}]`, seen));
  seen.delete(record);
}

function validateWorkerResponse(response, expectedSequence, runtime) {
  assertProtocol(
    exactKeys(response, RESPONSE_FIELDS)
      && response.schemaVersion === '1.0'
      && response.engine === 'pyshacl'
      && response.engineVersion === EXPECTED_PYSHACL_VERSION
      && response.engineVersion === runtime.pyshaclVersion
      && response.rdfEngine === 'rdflib'
      && response.rdfEngineVersion === EXPECTED_RDFLIB_VERSION
      && response.rdfEngineVersion === runtime.rdflibVersion
      && canonicalJcs(response.permissionAssurance) === canonicalJcs(PERMISSION_ASSURANCE)
      && Array.isArray(response.results),
    'M2_SHACL_EXECUTOR_RESPONSE_SCHEMA',
    'worker response differs from the closed pinned-engine schema',
  );
  assertProtocol(
    response.results.length === expectedSequence.length,
    'M2_SHACL_EXECUTOR_RESULT_COVERAGE',
    `expected ${expectedSequence.length} case results, found ${response.results.length}`,
  );
  const byKey = new Map();
  for (const [index, result] of response.results.entries()) {
    const expected = expectedSequence[index];
    const at = `results[${index}]`;
    assertProtocol(
      exactKeys(result, RESULT_FIELDS)
        && result.fixtureId === expected.fixtureId
        && result.constraintInstanceId === expected.constraintInstanceId
        && result.polarity === expected.polarity
        && ['conforms', 'violates', 'engineFailure'].includes(result.outcome)
        && Number.isInteger(result.rootResultCount) && result.rootResultCount >= 0
        && Array.isArray(result.results),
      'M2_SHACL_EXECUTOR_RESULT_SCHEMA',
      `${at} differs from its exact request tuple`,
    );
    if (result.engineError === null) {
      assertProtocol(result.outcome !== 'engineFailure', 'M2_SHACL_EXECUTOR_ENGINE_ERROR_MISSING', at);
    } else {
      assertProtocol(
        result.outcome === 'engineFailure'
          && exactKeys(result.engineError, ENGINE_ERROR_FIELDS)
          && typeof result.engineError.type === 'string'
          && typeof result.engineError.message === 'string'
          && /^sha256:[0-9a-f]{64}$/u.test(result.engineError.causeDigest)
          && result.engineError.causeDigest === sha256(Buffer.from(result.engineError.message, 'utf8')),
        'M2_SHACL_EXECUTOR_ENGINE_ERROR_SCHEMA',
        at,
      );
    }
    result.results.forEach((record, recordIndex) => (
      validateResultRecord(record, `${at}.results[${recordIndex}]`)
    ));
    assertProtocol(
      result.rootResultCount === result.results.length,
      'M2_SHACL_EXECUTOR_ROOT_COUNT',
      `${at} rootResultCount does not equal the returned top-level results`,
    );
    const key = `${result.polarity}\0${result.constraintInstanceId}`;
    assertProtocol(!byKey.has(key), 'M2_SHACL_EXECUTOR_RESULT_DUPLICATE', key);
    byKey.set(key, result);
  }
  return byKey;
}

function addFinding(findings, instanceId, polarity, code, message) {
  findings.push(Object.freeze({ constraintInstanceId: instanceId, polarity, code, message }));
}

function verifyCaseResult(fixture, result, findings) {
  const instanceId = fixture.constraintInstanceId;
  const polarity = fixture.expectedResult === 'conforms' ? 'positive' : 'negative';
  if (result.outcome === 'engineFailure') {
    addFinding(findings, instanceId, polarity, 'M2_SHACL_INSTANCE_ENGINE_FAILURE', result.engineError.message);
    return;
  }
  if (result.outcome !== fixture.expectedResult) {
    addFinding(
      findings,
      instanceId,
      polarity,
      polarity === 'positive'
        ? 'M2_SHACL_INSTANCE_POSITIVE_OUTCOME' : 'M2_SHACL_INSTANCE_NEGATIVE_VACUOUS',
      `expected ${fixture.expectedResult}, found ${result.outcome}`,
    );
  }
  if (polarity === 'positive') {
    if (result.rootResultCount !== 0 || result.results.length !== 0) {
      addFinding(
        findings,
        instanceId,
        polarity,
        'M2_SHACL_INSTANCE_POSITIVE_RESULT',
        `conforming fixture emitted ${result.rootResultCount} top-level results`,
      );
    }
    return;
  }
  if (result.rootResultCount !== 1 || result.results.length !== 1) {
    addFinding(
      findings,
      instanceId,
      polarity,
      'M2_SHACL_INSTANCE_NEGATIVE_RESULT_CARDINALITY',
      `negative fixture must emit exactly one top-level result, found ${result.rootResultCount}`,
    );
    return;
  }
  const root = result.results[0];
  const expected = {
    focusNode: fixture.focusNode,
    resultPath: fixture.expectedPath === null ? null : `<${fixture.expectedPath}>`,
    sourceConstraintComponent: fixture.expectedComponent,
    resultSeverity: fixture.expectedSeverity,
    sourceShape: `<${fixture.shapeRef}>`,
  };
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (root[field] !== expectedValue) {
      addFinding(
        findings,
        instanceId,
        polarity,
        `M2_SHACL_INSTANCE_${field.replace(/([A-Z])/gu, '_$1').toUpperCase()}`,
        `expected ${field}=${String(expectedValue)}, found ${String(root[field])}`,
      );
    }
  }
}

async function executeShaclInstanceFixtures(compilation, options = {}) {
  assertProtocol(
    compilation && typeof compilation === 'object'
      && ['compiled', 'incomplete'].includes(compilation.outcome)
      && Array.isArray(compilation.custom)
      && Number.isInteger(compilation.descriptorCount)
      && Number.isInteger(compilation.shaclCount)
      && Number.isInteger(compilation.customCount),
    'M2_SHACL_EXECUTOR_COMPILATION_SCHEMA',
    'fixture compilation result is missing its exact inventory metadata',
  );
  const positive = validateAggregateArtifact(compilation.positive, 'positive');
  const negative = validateAggregateArtifact(compilation.negative, 'negative');
  const positiveIds = positive.cases.map((fixture) => fixture.constraintInstanceId);
  const negativeIds = negative.cases.map((fixture) => fixture.constraintInstanceId);
  assertProtocol(
    canonicalJcs(positiveIds) === canonicalJcs(negativeIds)
      && positiveIds.length === compilation.shaclCount
      && compilation.shaclCount + compilation.customCount === compilation.descriptorCount
      && compilation.custom.length === compilation.customCount,
    'M2_SHACL_EXECUTOR_INVENTORY_DRIFT',
    'positive, negative, SHACL, Custom, and descriptor inventories do not close exactly',
  );
  const runtime = probePython(options);
  const response = await runWorker(runtime, {
    schemaVersion: '1.0',
    positive,
    negative,
  }, options);
  const expectedSequence = [
    ...positive.cases.map((fixture) => ({
      fixtureId: fixture.fixtureId,
      constraintInstanceId: fixture.constraintInstanceId,
      polarity: 'positive',
    })),
    ...negative.cases.map((fixture) => ({
      fixtureId: fixture.fixtureId,
      constraintInstanceId: fixture.constraintInstanceId,
      polarity: 'negative',
    })),
  ];
  const byKey = validateWorkerResponse(response, expectedSequence, runtime);
  const findings = [];
  const rows = [];
  for (let index = 0; index < positive.cases.length; index += 1) {
    const positiveFixture = positive.cases[index];
    const negativeFixture = negative.cases[index];
    const before = findings.length;
    const positiveResult = byKey.get(`positive\0${positiveFixture.constraintInstanceId}`);
    const negativeResult = byKey.get(`negative\0${negativeFixture.constraintInstanceId}`);
    verifyCaseResult(positiveFixture, positiveResult, findings);
    verifyCaseResult(negativeFixture, negativeResult, findings);
    rows.push(Object.freeze({
      constraintInstanceId: positiveFixture.constraintInstanceId,
      outcome: findings.length === before ? 'passed' : 'failed',
      positive: positiveResult,
      negative: negativeResult,
      findingCodes: findings.slice(before).map((finding) => finding.code),
    }));
  }
  findings.sort((left, right) => byteCompare(
    `${left.constraintInstanceId}\0${left.polarity}\0${left.code}\0${left.message}`,
    `${right.constraintInstanceId}\0${right.polarity}\0${right.code}\0${right.message}`,
  ));
  const passed = rows.filter((row) => row.outcome === 'passed').length;
  const engineFailures = response.results.filter((result) => result.outcome === 'engineFailure').length;
  const workerBytes = fs.readFileSync(options.workerPath ? path.resolve(options.workerPath) : WORKER_PATH);
  const evidence = Object.freeze({
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    artifactKind: 'shaclConstraintInstanceExecutionEvidence',
    outcome: passed === rows.length ? 'passed' : 'failed',
    engine: Object.freeze({
      name: response.engine,
      version: response.engineVersion,
      rdfEngine: response.rdfEngine,
      rdfEngineVersion: response.rdfEngineVersion,
      pythonVersion: runtime.pythonVersion,
      permissionAssurance: response.permissionAssurance,
      workerRef: options.workerRef || WORKER_REF,
      workerDigest: sha256(workerBytes),
    }),
    inputs: Object.freeze({
      positiveAggregateDigest: compilation.positive.digest,
      negativeAggregateDigest: compilation.negative.digest,
    }),
    summary: Object.freeze({
      discovered: rows.length,
      executed: rows.length,
      passed,
      failed: rows.length - passed,
      skipped: 0,
      pending: 0,
      caseExecutions: response.results.length,
      engineFailures,
    }),
    findings: Object.freeze(findings),
    results: Object.freeze(rows),
  });
  const bytes = Buffer.from(canonicalJcs(evidence), 'utf8');
  return Object.freeze({ value: evidence, bytes, digest: sha256(bytes) });
}

function validateArtifactReference(reference, label) {
  assertProtocol(
    reference && typeof reference === 'object' && !Array.isArray(reference),
    'M2_SHACL_EXPECTATION_ARTIFACT_REF',
    `${label} must be an artifact reference object`,
  );
  return Object.freeze(JSON.parse(canonicalJcs(reference)));
}

function assembleShaclExpectationEntries(options = {}) {
  const { compilation, execution } = options;
  assertProtocol(
    execution?.value?.outcome === 'passed'
      && execution.value.summary.failed === 0
      && execution.value.summary.skipped === 0
      && execution.value.summary.pending === 0
      && execution.value.inputs.positiveAggregateDigest === compilation?.positive?.digest
      && execution.value.inputs.negativeAggregateDigest === compilation?.negative?.digest,
    'M2_SHACL_EXPECTATION_EXECUTION_NOT_PASSED',
    'expectation tuples require exact passed execution evidence for these aggregates',
  );
  const positiveRef = validateArtifactReference(options.positiveArtifactRef, 'positiveArtifactRef');
  const negativeRef = validateArtifactReference(options.negativeArtifactRef, 'negativeArtifactRef');
  const schemaRef = validateArtifactReference(options.schemaRef, 'schemaRef');
  assertProtocol(
    /^sha256:[0-9a-f]{64}$/u.test(options.schemaDigest || ''),
    'M2_SHACL_EXPECTATION_SCHEMA_DIGEST',
    'schemaDigest must be SHA-256',
  );
  const positive = validateAggregateArtifact(compilation.positive, 'positive');
  const negative = validateAggregateArtifact(compilation.negative, 'negative');
  const entries = positive.cases.map((fixture, index) => {
    const counterpart = negative.cases[index];
    assertProtocol(
      counterpart.constraintInstanceId === fixture.constraintInstanceId,
      'M2_SHACL_EXPECTATION_PAIR_DRIFT',
      fixture.constraintInstanceId,
    );
    return Object.freeze({
      constraintInstanceId: fixture.constraintInstanceId,
      positiveExpectation: Object.freeze({
        fixtureId: fixture.fixtureId,
        artifactRef: positiveRef,
        artifactDigest: compilation.positive.digest,
        schemaRef,
        schemaDigest: options.schemaDigest,
        expectedResult: 'conforms',
      }),
      negativeExpectation: Object.freeze({
        fixtureId: counterpart.fixtureId,
        artifactRef: negativeRef,
        artifactDigest: compilation.negative.digest,
        schemaRef,
        schemaDigest: options.schemaDigest,
        expectedResult: 'violates',
      }),
    });
  });
  return Object.freeze({
    outcome: compilation.customCount === 0 ? 'complete' : 'shacl-verified-custom-unresolved',
    shaclEntryCount: entries.length,
    unresolvedCustomCount: compilation.customCount,
    entries: Object.freeze(entries),
    unresolvedCustom: compilation.custom,
  });
}

module.exports = {
  EXPECTED_PYSHACL_VERSION,
  EXPECTED_RDFLIB_VERSION,
  PERMISSION_ASSURANCE,
  WORKER_PATH,
  ShaclInstanceExecutionError,
  assembleShaclExpectationEntries,
  executeShaclInstanceFixtures,
  probePython,
  runWorker,
  validateAggregateArtifact,
  validateWorkerResponse,
};
