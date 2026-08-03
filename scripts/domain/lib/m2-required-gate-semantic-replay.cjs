'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  PROFILE_REF,
  REPORT_KIND_BY_GATE,
  REQUIRED_GATE_IDS,
  compareUtf8,
  expectedCriterionRefsForGate,
  gateCapabilityId,
  gateDependencies,
} = require('./m2-release-capability-definitions.cjs');
const {
  INVENTORY_TAG,
  loadCatalog,
  payloadEntryMap,
  resolvePair,
  resolveRawPair,
  sha256,
  strictJcs,
  taggedJcsDigest,
} = require('./m2-gate-artifact-binding-replay.cjs');
const { validateJsonSchema } = require('./m2-release-capability-replay.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const SEMANTIC_IMPLEMENTATION_MODE = 'required-gate-semantic-replay-v1';
const SEMANTIC_OPERATION = 'replayRequiredGate';
const SEMANTIC_EVIDENCE_USE = 'required-gate-release-eligibility-evidence';
const VECTOR_EVIDENCE_USE = 'required-gate-semantic-test-vector-only';
const SUBJECT_TAG = 'axiolune-required-gate-subject-v1\0';
const REQUEST_TAG = 'axiolune-required-gate-replay-request-v1\0';
const DEPENDENCY_TREE_TAG = 'axiolune-node-dependency-tree-v1\0';
const TEMP_PREFIX = 'axiolune-required-gate-semantic-replay-';
const RUNTIME_DIRECTORY = '.semantic-runtime';
const SEMANTIC_TEMP_DIRECTORY = '.semantic-tmp';
const NETWORK_GUARD_PATH = `${RUNTIME_DIRECTORY}/network-deny.cjs`;
const NETWORK_GUARD_SOURCE = Buffer.from(String.raw`'use strict';
const deny = () => {
  const error = new Error('network access is denied by the required-gate semantic runtime');
  error.code = 'M2_NETWORK_DENIED';
  throw error;
};
const patch = (target, names) => {
  for (const name of names) {
    if (!(name in target)) continue;
    Object.defineProperty(target, name, {
      value: deny, writable: false, enumerable: true, configurable: false,
    });
  }
};
const net = require('node:net');
const tls = require('node:tls');
const dgram = require('node:dgram');
const dnsModules = [require('node:dns'), require('node:dns/promises')];
const protocolModules = [require('node:http'), require('node:https')];
const http2 = require('node:http2');
patch(net, ['connect', 'createConnection', 'createServer']);
patch(net.Socket.prototype, ['connect']);
patch(net.Server.prototype, ['listen']);
patch(tls, ['connect', 'createServer']);
patch(tls.TLSSocket.prototype, ['connect']);
patch(dgram, ['createSocket']);
for (const dns of dnsModules) {
  patch(dns, Object.keys(dns).filter((key) => (
    key === 'lookup' || key === 'lookupService' || key === 'Resolver'
      || key === 'setDefaultResultOrder' || key === 'setServers'
      || key.startsWith('resolve') || key.startsWith('reverse')
  )));
  Object.freeze(dns);
}
for (const protocol of protocolModules) {
  patch(protocol, ['get', 'request', 'createServer']);
  if (protocol.Agent?.prototype) patch(protocol.Agent.prototype, ['createConnection']);
  Object.freeze(protocol);
}
patch(http2, ['connect', 'createServer', 'createSecureServer']);
Object.freeze(net);
Object.freeze(tls);
Object.freeze(dgram);
Object.freeze(http2);
for (const name of ['binding', '_linkedBinding', 'dlopen', '_debugProcess']) {
  if (name in process) {
    Object.defineProperty(process, name, {
      value: deny, writable: false, enumerable: true, configurable: false,
    });
  }
}
for (const name of ['fetch', 'WebSocket', 'EventSource']) {
  if (name in globalThis) {
    Object.defineProperty(globalThis, name, {
      value: deny, writable: false, enumerable: true, configurable: false,
    });
  }
}
Object.defineProperty(globalThis, '__AXIOLUNE_OFFLINE_RUNTIME__', {
  value: true, writable: false, enumerable: false, configurable: false,
});
`, 'utf8');
const VECTOR_CATEGORIES = Object.freeze([
  'emptySubject', 'engineFailure', 'positive', 'tamper', 'violation',
]);
const MAX_SOURCE_FILES = 20_000;
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const EXPECTED_VECTOR_RESULTS = Object.freeze({
  emptySubject: Object.freeze({
    status: 'engineFailure', outcome: 'engineFailure', exitStatus: 2,
  }),
  engineFailure: Object.freeze({
    status: 'engineFailure', outcome: 'engineFailure', exitStatus: 2,
  }),
  positive: Object.freeze({ status: 'completed', outcome: 'accepted', exitStatus: 0 }),
  tamper: Object.freeze({ status: 'engineFailure', outcome: 'engineFailure', exitStatus: 2 }),
  violation: Object.freeze({ status: 'completed', outcome: 'violation', exitStatus: 0 }),
});
const SUPPORTED_SCHEMA_TYPES = Object.freeze([
  'array', 'boolean', 'integer', 'null', 'number', 'object', 'string',
]);
const SUPPORTED_SCHEMA_KEYWORDS = Object.freeze([
  '$schema', 'additionalProperties', 'const', 'enum', 'items', 'minimum',
  'pattern', 'properties', 'required', 'type', 'uniqueItems',
]);

class SemanticReplayError extends Error {
  constructor(code, message, at = '', kind = 'invalid') {
    super(message);
    this.name = 'SemanticReplayError';
    this.code = code;
    this.at = at;
    this.kind = kind;
  }
}

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort(compareUtf8))
      === canonicalJcs([...expected].sort(compareUtf8));
}

function canonicalPathSegment(segment) {
  return segment.length > 0 && segment !== '.' && segment !== '..'
    && !/[\u0000-\u001f\u007f<>:"|?*]/u.test(segment)
    && !/[. ]$/u.test(segment)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment);
}

function canonicalPath(value) {
  return typeof value === 'string' && value.length > 0
    && value === value.normalize('NFC') && !value.startsWith('/')
    && !value.includes('\\') && !/^[A-Za-z]:/u.test(value)
    && value.split('/').every(canonicalPathSegment);
}

function sourceRef(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function sameRef(left, right) {
  return canonicalJcs(left) === canonicalJcs(right);
}

function safePath(root, relativePath) {
  if (!canonicalPath(relativePath)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_SOURCE_PATH',
      `unsafe reconstructed-P1 path ${String(relativePath)}`,
      String(relativePath),
    );
  }
  const base = path.resolve(root);
  const absolute = path.resolve(base, ...relativePath.split('/'));
  const relative = path.relative(base, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_SOURCE_PATH',
      `reconstructed-P1 path escapes replay root: ${relativePath}`,
      relativePath,
    );
  }
  return absolute;
}

function trustedBytes(options, relativePath) {
  const explicit = options.trustedSourceArtifacts instanceof Map
    ? options.trustedSourceArtifacts.get(relativePath) : null;
  if (Buffer.isBuffer(explicit)) return explicit;
  const trustedRoot = options.trustedRoot && path.resolve(options.trustedRoot);
  if (!trustedRoot) return null;
  try {
    const absolute = safePath(trustedRoot, relativePath);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const realRoot = fs.realpathSync(trustedRoot);
    const realFile = fs.realpathSync(absolute);
    const relative = path.relative(realRoot, realFile);
    if (relative === '..' || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) return null;
    return fs.readFileSync(realFile);
  } catch {
    return null;
  }
}

function sourceControl(options, reference, digest, label, parse = false) {
  if (!exactKeys(reference, ['kind', 'root', 'path'])
      || reference.kind !== 'path' || reference.root !== 'sourceTree'
      || !canonicalPath(reference.path)
      || !/^sha256:[0-9a-f]{64}$/u.test(digest || '')) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_CONTROL_TUPLE',
      `${label} is not a closed sourceTree ref/digest tuple`,
      label,
    );
  }
  const candidate = options.sourceArtifacts.get(reference.path);
  if (!Buffer.isBuffer(candidate)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_CONTROL_MISSING',
      `${label} is absent from the reconstructed P1 tree`,
      reference.path,
      'missing',
    );
  }
  if (sha256(candidate) !== digest) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_CONTROL_DIGEST',
      `${label} digest differs from reconstructed P1 bytes`,
      reference.path,
    );
  }
  const trusted = trustedBytes(options, reference.path);
  if (!Buffer.isBuffer(trusted)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_TRUSTED_CONTROL_REQUIRED',
      `${label} has no independently trusted control bytes`,
      reference.path,
      'unverified',
    );
  }
  if (!candidate.equals(trusted)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_CONTROL_SUBSTITUTION',
      `${label} reconstructed-P1 bytes differ from the trusted verifier control`,
      reference.path,
    );
  }
  return parse ? strictJcs(candidate, label) : candidate;
}

function validateSourceInventory(sourceArtifacts) {
  if (!(sourceArtifacts instanceof Map) || sourceArtifacts.size === 0) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_P1_TREE_REQUIRED',
      'required-gate semantic replay requires a reconstructed P1 source tree',
      '',
      'unverified',
    );
  }
  if (sourceArtifacts.size > MAX_SOURCE_FILES) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_SOURCE_LIMIT',
      `reconstructed P1 exceeds ${MAX_SOURCE_FILES} source files`,
    );
  }
  let total = 0;
  for (const [relativePath, bytes] of sourceArtifacts) {
    if (!canonicalPath(relativePath)
        || ['.semantic-tmp', RUNTIME_DIRECTORY].includes(relativePath.split('/')[0])
        || !Buffer.isBuffer(bytes)) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_SOURCE_ROW',
        'reconstructed P1 source inventory is not a canonical path/byte map',
        String(relativePath),
      );
    }
    total += bytes.length;
    if (total > MAX_SOURCE_BYTES) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_SOURCE_LIMIT',
        `reconstructed P1 exceeds ${MAX_SOURCE_BYTES} source bytes`,
      );
    }
  }
  return total;
}

function validateRequiredGateManifest(required) {
  if (!exactKeys(required, ['schemaVersion', 'gates'])
      || required.schemaVersion !== '1.0' || !Array.isArray(required.gates)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_REQUIRED_INVENTORY',
      'semantic replay requires the closed v1 required-gates manifest',
      '',
    );
  }
  const gateIds = required.gates.map((gate) => gate?.gateId);
  if (canonicalJcs(gateIds) !== canonicalJcs(REQUIRED_GATE_IDS)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_REQUIRED_INVENTORY',
      'semantic replay requires the exact sorted 22-gate required manifest',
      '/gates',
    );
  }
  const fields = [
    'gateId', 'reportKind', 'criterionRefs', 'toolId', 'capabilityId',
    'capabilityRef', 'capabilityDigest', 'entrypointRef', 'entrypointDigest',
    'discoveryContractRef', 'discoveryContractDigest', 'evidenceSchemaRef',
    'evidenceSchemaDigest', 'dependsOn',
  ];
  for (const [index, gate] of required.gates.entries()) {
    const expectedCriteria = expectedCriterionRefsForGate(gate.gateId);
    const expectedDependencies = gateDependencies(gate.gateId);
    if (!exactKeys(gate, fields)
        || gate.reportKind !== REPORT_KIND_BY_GATE[gate.gateId]
        || gate.capabilityId !== gateCapabilityId(gate.gateId)
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(gate.toolId || '')
        || canonicalJcs(gate.criterionRefs) !== canonicalJcs(expectedCriteria)
        || canonicalJcs(gate.dependsOn) !== canonicalJcs(expectedDependencies)) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_REQUIRED_ROW',
        `${gate.gateId} differs from its exact reviewed gate identity/criteria/dependency row`,
        `/gates/${index}`,
      );
    }
  }
}

function validateDiscoveryContract(contract, gate) {
  if (!exactKeys(contract, [
    'schemaVersion', 'profileRef', 'capabilityId', 'bindingKind', 'stageId',
    'strategy',
  ]) || contract.schemaVersion !== '1.0' || contract.profileRef !== PROFILE_REF
      || contract.capabilityId !== gate.capabilityId
      || contract.bindingKind !== 'requiredGate' || contract.stageId !== null
      || !exactKeys(contract.strategy, ['kind', 'rules'])
      || contract.strategy.kind !== 'sourceTreePathSet-v1'
      || !Array.isArray(contract.strategy.rules)
      || contract.strategy.rules.length === 0) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_DISCOVERY_CONTRACT',
      `${gate.gateId} discovery contract is not the closed sourceTreePathSet-v1 profile`,
      gate.discoveryContractRef?.path || gate.gateId,
      'unverified',
    );
  }
  let previous = null;
  for (const [index, rule] of contract.strategy.rules.entries()) {
    const at = `${gate.gateId}/discovery/rules/${index}`;
    if (!exactKeys(rule, ['classifier', 'pathPrefix', 'pathSuffix'])
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(rule.classifier || '')
        || typeof rule.pathPrefix !== 'string' || typeof rule.pathSuffix !== 'string'
        || (rule.pathPrefix && !canonicalPath(`${rule.pathPrefix}sentinel`))
        || rule.pathPrefix.includes('\\') || rule.pathSuffix.includes('\\')) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_DISCOVERY_RULE',
        'discovery rule is not a closed classifier/prefix/suffix tuple',
        at,
      );
    }
    const key = canonicalJcs(rule);
    if (previous !== null && compareUtf8(previous, key) >= 0) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_DISCOVERY_RULE_ORDER',
        'discovery rules must be strictly JCS-sorted and unique',
        at,
      );
    }
    previous = key;
  }
}

function discoverSubjects(gate, contract, sourceArtifacts) {
  validateDiscoveryContract(contract, gate);
  const subjects = [];
  for (const relativePath of [...sourceArtifacts.keys()].sort(compareUtf8)) {
    const matches = contract.strategy.rules.filter((rule) => (
      relativePath.startsWith(rule.pathPrefix) && relativePath.endsWith(rule.pathSuffix)
    ));
    if (matches.length > 1) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_DISCOVERY_AMBIGUOUS',
        `${relativePath} matches more than one reviewed discovery rule`,
        relativePath,
      );
    }
    if (matches.length === 0) continue;
    const bytes = sourceArtifacts.get(relativePath);
    const subjectRef = sourceRef(relativePath);
    const subjectDigest = sha256(bytes);
    const classifier = matches[0].classifier;
    const subjectId = taggedJcsDigest(SUBJECT_TAG, {
      gateId: gate.gateId,
      subjectRef,
      subjectDigest,
      classifier,
    });
    subjects.push({ subjectId, subjectRef, subjectDigest, classifier });
  }
  subjects.sort((left, right) => compareUtf8(left.subjectId, right.subjectId));
  if (subjects.length === 0) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_EMPTY_DISCOVERY',
      `${gate.gateId} independently discovered no candidate subjects`,
      gate.gateId,
      'unverified',
    );
  }
  for (let index = 1; index < subjects.length; index += 1) {
    if (subjects[index - 1].subjectId === subjects[index].subjectId) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_SUBJECT_COLLISION',
        `${gate.gateId} independently discovered a duplicate subjectId`,
        gate.gateId,
      );
    }
  }
  return subjects;
}

function materializeSource(sourceArtifacts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  for (const [relativePath, bytes] of sourceArtifacts) {
    const absolute = safePath(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    fs.writeFileSync(absolute, bytes, { flag: 'wx', mode: 0o600 });
  }
  return root;
}

function removeReplayRoot(root) {
  if (!root) return;
  const resolved = path.resolve(root);
  const temp = path.resolve(os.tmpdir());
  const relative = path.relative(temp, resolved);
  if (!relative.startsWith(TEMP_PREFIX) || relative.includes(path.sep)
      || path.isAbsolute(relative)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_TEMP_CLEANUP',
      `refusing to remove unexpected replay root ${resolved}`,
      resolved,
    );
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function minimalEnvironment(tempRoot) {
  const env = {
    TZ: 'UTC',
    TEMP: tempRoot,
    TMP: tempRoot,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
  };
  for (const name of ['ComSpec', 'PATHEXT', 'SystemRoot', 'WINDIR']) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  }
  return env;
}

function ensureExecutionRuntime(root) {
  const directory = safePath(root, RUNTIME_DIRECTORY);
  const guard = safePath(root, NETWORK_GUARD_PATH);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  if (!fs.existsSync(guard)) {
    fs.writeFileSync(guard, NETWORK_GUARD_SOURCE, { flag: 'wx', mode: 0o600 });
  }
  const bytes = fs.readFileSync(guard);
  if (!bytes.equals(NETWORK_GUARD_SOURCE)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_RUNTIME_GUARD',
      'offline runtime guard bytes changed inside the isolated replay root',
      NETWORK_GUARD_PATH,
    );
  }
  return fs.realpathSync(guard);
}

function validateInputContract(contract, gate, capability) {
  if (!exactKeys(contract, [
    'schemaVersion', 'profileRef', 'capabilityId', 'operation', 'protocol',
    'invocation', 'subjectDiscoveryComponent', 'evidenceResultComponent',
    'testVectors', 'runtimeDependencies', 'permissions',
  ]) || contract.schemaVersion !== '1.0' || contract.profileRef !== PROFILE_REF
      || contract.capabilityId !== gate.capabilityId
      || contract.operation !== SEMANTIC_OPERATION
      || contract.protocol !== 'stdin-jcs-v1'
      || !exactKeys(contract.invocation, [
        'argv', 'environmentPolicy', 'maxOutputBytes', 'successExitCode', 'timeoutMs',
      ])
      || !Array.isArray(contract.invocation.argv)
      || contract.invocation.argv.some((arg) => (
        typeof arg !== 'string' || arg.length === 0 || /[\u0000\r\n]/u.test(arg)
      ))
      || contract.invocation.environmentPolicy !== 'offline-minimal-node-permission-v1'
      || contract.invocation.maxOutputBytes !== MAX_OUTPUT_BYTES
      || contract.invocation.successExitCode !== 0
      || contract.invocation.timeoutMs !== DEFAULT_TIMEOUT_MS
      || !Array.isArray(contract.runtimeDependencies)
      || contract.runtimeDependencies.some((dependency) => (
        !exactKeys(dependency, ['name', 'version', 'treeDigest'])
          || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(dependency.name || '')
          || typeof dependency.version !== 'string' || dependency.version.length === 0
          || !/^sha256:[0-9a-f]{64}$/u.test(dependency.treeDigest || '')
      ))
      || canonicalJcs(contract.runtimeDependencies.map((row) => row.name))
        !== canonicalJcs(
          [...new Set(contract.runtimeDependencies.map((row) => row.name))].sort(compareUtf8),
        )
      || !exactKeys(contract.permissions, ['childProcess', 'fsWriteTemp'])
      || contract.permissions.childProcess !== false
      || contract.permissions.fsWriteTemp !== true
      || !sameRef(contract.subjectDiscoveryComponent?.ref, gate.discoveryContractRef)
      || contract.subjectDiscoveryComponent?.digest !== gate.discoveryContractDigest
      || !sameRef(contract.evidenceResultComponent?.ref, gate.evidenceSchemaRef)
      || contract.evidenceResultComponent?.digest !== gate.evidenceSchemaDigest
      || !sameRef(contract.testVectors?.ref, capability.testVectors?.ref)
      || contract.testVectors?.digest !== capability.testVectors?.digest) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_INPUT_CONTRACT',
      `${gate.gateId} input contract does not lock the semantic invocation protocol`,
      capability.inputContract?.ref?.path || gate.gateId,
      'unverified',
    );
  }
}

function validateOutputContract(contract, gate, capability) {
  if (!exactKeys(contract, [
    'schemaVersion', 'profileRef', 'capabilityId', 'protocol', 'canonicalization',
    'maxOutputBytes', 'successExitCode', 'subjectDiscoveryComponent',
    'evidenceResultComponent',
  ]) || contract.schemaVersion !== '1.0' || contract.profileRef !== PROFILE_REF
      || contract.capabilityId !== gate.capabilityId
      || contract.protocol !== 'stdout-jcs-v1'
      || contract.canonicalization !== 'RFC8785-JCS'
      || contract.maxOutputBytes !== MAX_OUTPUT_BYTES
      || contract.successExitCode !== 0
      || !sameRef(contract.subjectDiscoveryComponent?.ref, gate.discoveryContractRef)
      || contract.subjectDiscoveryComponent?.digest !== gate.discoveryContractDigest
      || !sameRef(contract.evidenceResultComponent?.ref, gate.evidenceSchemaRef)
      || contract.evidenceResultComponent?.digest !== gate.evidenceSchemaDigest) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_OUTPUT_CONTRACT',
      `${gate.gateId} output contract does not lock one bounded JCS record and exit 0`,
      capability.outputContract?.ref?.path || gate.gateId,
      'unverified',
    );
  }
}

function validateEvidenceSchemaProfile(schema, gate) {
  const visit = (rule, pointer, root = false) => {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_SCHEMA_PROFILE',
        `${gate.gateId} evidence schema contains a non-object rule`,
        pointer,
      );
    }
    for (const keyword of Object.keys(rule)) {
      if (!SUPPORTED_SCHEMA_KEYWORDS.includes(keyword)) {
        throw new SemanticReplayError(
          'M2_GATE_SEMANTIC_SCHEMA_KEYWORD',
          `${gate.gateId} evidence schema uses unsupported keyword ${keyword}`,
          `${pointer}/${keyword}`,
          'unverified',
        );
      }
    }
    if (root && rule.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_SCHEMA_DIALECT',
        `${gate.gateId} evidence schema does not lock JSON Schema 2020-12`,
        `${pointer}/$schema`,
        'unverified',
      );
    }
    if (!root && Object.hasOwn(rule, '$schema')) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_SCHEMA_DIALECT',
        `${gate.gateId} evidence schema nests a dialect declaration`,
        `${pointer}/$schema`,
      );
    }
    if (Object.hasOwn(rule, 'type')) {
      const types = Array.isArray(rule.type) ? rule.type : [rule.type];
      if (types.length === 0 || new Set(types).size !== types.length
          || types.some((type) => !SUPPORTED_SCHEMA_TYPES.includes(type))) {
        throw new SemanticReplayError(
          'M2_GATE_SEMANTIC_SCHEMA_TYPE',
          `${gate.gateId} evidence schema has an unsupported type declaration`,
          `${pointer}/type`,
        );
      }
    }
    if (Object.hasOwn(rule, 'pattern')) {
      try {
        if (typeof rule.pattern !== 'string') throw new Error('pattern is not a string');
        new RegExp(rule.pattern, 'u');
      } catch (cause) {
        throw new SemanticReplayError(
          'M2_GATE_SEMANTIC_SCHEMA_PATTERN',
          `${gate.gateId} evidence schema pattern is invalid: ${cause.message}`,
          `${pointer}/pattern`,
        );
      }
    }
    if (Object.hasOwn(rule, 'minimum')
        && (typeof rule.minimum !== 'number' || !Number.isFinite(rule.minimum))) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_SCHEMA_MINIMUM',
        `${gate.gateId} evidence schema minimum is not finite`,
        `${pointer}/minimum`,
      );
    }
    if (Object.hasOwn(rule, 'uniqueItems') && typeof rule.uniqueItems !== 'boolean') {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_SCHEMA_UNIQUE',
        `${gate.gateId} evidence schema uniqueItems is not boolean`,
        `${pointer}/uniqueItems`,
      );
    }
    if (Object.hasOwn(rule, 'additionalProperties')
        && typeof rule.additionalProperties !== 'boolean') {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_SCHEMA_ADDITIONAL',
        `${gate.gateId} evidence schema additionalProperties is not boolean`,
        `${pointer}/additionalProperties`,
      );
    }
    if (Object.hasOwn(rule, 'enum') && (!Array.isArray(rule.enum) || rule.enum.length === 0)) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_SCHEMA_ENUM',
        `${gate.gateId} evidence schema enum is empty or invalid`,
        `${pointer}/enum`,
      );
    }
    const properties = rule.properties;
    if (Object.hasOwn(rule, 'properties')
        && (properties === null || typeof properties !== 'object' || Array.isArray(properties))) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_SCHEMA_PROPERTIES',
        `${gate.gateId} evidence schema properties is not an object`,
        `${pointer}/properties`,
      );
    }
    if (Object.hasOwn(rule, 'required')) {
      if (!Array.isArray(rule.required) || new Set(rule.required).size !== rule.required.length
          || rule.required.some((field) => typeof field !== 'string'
            || !Object.hasOwn(properties || {}, field))) {
        throw new SemanticReplayError(
          'M2_GATE_SEMANTIC_SCHEMA_REQUIRED',
          `${gate.gateId} evidence schema required list is not unique/property-bound`,
          `${pointer}/required`,
        );
      }
    }
    for (const [field, child] of Object.entries(properties || {})) {
      if (!field || field !== field.normalize('NFC')) {
        throw new SemanticReplayError(
          'M2_GATE_SEMANTIC_SCHEMA_PROPERTY',
          `${gate.gateId} evidence schema property name is not non-empty NFC`,
          `${pointer}/properties`,
        );
      }
      visit(child, `${pointer}/properties/${field}`);
    }
    if (Object.hasOwn(rule, 'items')) visit(rule.items, `${pointer}/items`);
  };
  visit(schema, gate.evidenceSchemaRef?.path || gate.gateId, true);
  if (schema.type !== 'object' || schema.additionalProperties !== false
      || !schema.properties || !Array.isArray(schema.required)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_SCHEMA_ROOT',
      `${gate.gateId} evidence schema root must be a closed object with required fields`,
      gate.evidenceSchemaRef?.path || gate.gateId,
      'unverified',
    );
  }
}

function parseExecutionOutput(result, label) {
  if (result.error) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_ENTRYPOINT_ENGINE',
      `${label}: ${result.error.message}`,
      label,
    );
  }
  if (result.signal !== null) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_ENTRYPOINT_SIGNAL',
      `${label} terminated with signal ${String(result.signal)}`,
      label,
    );
  }
  if (!Buffer.isBuffer(result.stdout) || result.stdout.length === 0
      || result.stdout.length > MAX_OUTPUT_BYTES) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.subarray(0, 2048).toString('utf8').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '?')
      : '';
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_ENTRYPOINT_OUTPUT',
      `${label} emitted no bounded JCS output${stderr ? `; stderr: ${stderr}` : ''}`,
      label,
    );
  }
  const text = result.stdout.toString('utf8');
  if (text.includes('\n') || text.includes('\r')) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_ENTRYPOINT_OUTPUT',
      `${label} emitted more than one output record`,
      label,
    );
  }
  const bytes = Buffer.from(text, 'utf8');
  const value = strictJcs(bytes, label);
  return { status: result.status, bytes, value };
}

function executeEntrypoint(root, entrypointRef, inputContract, inputBytes, timeoutMs) {
  const entrypoint = safePath(root, entrypointRef.path);
  const rootReal = fs.realpathSync(root);
  const entryReal = fs.realpathSync(entrypoint);
  const relative = path.relative(rootReal, entryReal);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_ENTRYPOINT_REALPATH',
      'declared entrypoint resolves outside the reconstructed P1 root',
      entrypointRef.path,
    );
  }
  const semanticTemp = safePath(rootReal, SEMANTIC_TEMP_DIRECTORY);
  if (fs.existsSync(semanticTemp)) fs.rmSync(semanticTemp, { recursive: true, force: true });
  fs.mkdirSync(semanticTemp, { recursive: false, mode: 0o700 });
  const permissionArgs = [
    '--permission',
    `--allow-fs-read=${rootReal}`,
    `--allow-fs-write=${fs.realpathSync(semanticTemp)}`,
    '--no-global-search-paths',
    '--disable-proto=throw',
  ];
  const networkGuard = ensureExecutionRuntime(rootReal);
  try {
    const result = spawnSync(process.execPath, [
      ...permissionArgs,
      '--require',
      networkGuard,
      entryReal,
      ...inputContract.invocation.argv,
    ], {
      cwd: rootReal,
      input: inputBytes,
      encoding: null,
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: minimalEnvironment(rootReal),
    });
    return parseExecutionOutput(result, entrypointRef.path);
  } finally {
    fs.rmSync(semanticTemp, { recursive: true, force: true });
  }
}

function copyDependencyDirectory(source, destination) {
  const stat = fs.lstatSync(source);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('dependency root is not a non-symlink directory');
  }
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const child = fs.lstatSync(from);
    if (child.isSymbolicLink()) throw new Error(`dependency contains symlink ${entry.name}`);
    if (child.isDirectory()) copyDependencyDirectory(from, to);
    else if (child.isFile()) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    else throw new Error(`dependency contains non-regular entry ${entry.name}`);
  }
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
  return taggedJcsDigest(DEPENDENCY_TREE_TAG, { schemaVersion: '1.0', files: rows });
}

function prepareRuntimeDependencies(options, root, dependencies) {
  if (dependencies.length === 0) return 0;
  const lockBytes = options.sourceArtifacts.get('package-lock.json');
  const trustedLock = trustedBytes(options, 'package-lock.json');
  if (!Buffer.isBuffer(lockBytes) || !Buffer.isBuffer(trustedLock)
      || !lockBytes.equals(trustedLock)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_DEPENDENCY_LOCK',
      'runtime dependency copy requires byte-identical trusted P1 package-lock.json',
      'package-lock.json',
      'unverified',
    );
  }
  let lock;
  try {
    lock = JSON.parse(lockBytes.toString('utf8'));
  } catch (cause) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_DEPENDENCY_LOCK',
      `package-lock.json cannot be parsed: ${cause.message}`,
      'package-lock.json',
    );
  }
  if (lock?.lockfileVersion !== 3 || lock.packages === null
      || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_DEPENDENCY_LOCK',
      'package-lock.json must be an npm lockfileVersion 3 packages inventory',
      'package-lock.json',
      'unverified',
    );
  }
  const trustedRoot = options.trustedRoot && path.resolve(options.trustedRoot);
  if (!trustedRoot) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_DEPENDENCY_ROOT',
      'runtime dependency copy requires a trusted installed dependency root',
      '',
      'unverified',
    );
  }
  for (const dependency of dependencies) {
    const { name } = dependency;
    const relative = `node_modules/${name}`;
    const locked = lock.packages?.[relative];
    const source = path.join(trustedRoot, ...relative.split('/'));
    const packagePath = path.join(source, 'package.json');
    if (!locked || typeof locked.version !== 'string' || typeof locked.integrity !== 'string'
        || !fs.existsSync(packagePath)) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_DEPENDENCY_LOCK',
        `${name} is not both integrity-locked and installed`,
        relative,
        'unverified',
      );
    }
    const installed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (installed.name !== name || installed.version !== locked.version
        || installed.version !== dependency.version
        || dependencyTreeDigest(source) !== dependency.treeDigest) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_DEPENDENCY_IDENTITY',
        `${name} installed identity/version/bytes differ from the locked runtime dependency`,
        relative,
      );
    }
    const destination = safePath(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(destination)) copyDependencyDirectory(source, destination);
    if (dependencyTreeDigest(destination) !== dependency.treeDigest) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_DEPENDENCY_COPY',
        `${name} copied bytes differ from the locked dependency tree`,
        relative,
      );
    }
  }
  return dependencies.length;
}

function tupleFromCapability(capability, field, label) {
  const tuple = capability?.[field];
  if (!exactKeys(tuple, ['ref', 'digest'])) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_CAPABILITY_TUPLE',
      `${label} is not a closed ref/digest tuple`,
      label,
    );
  }
  return tuple;
}

function validateCapability(capability, gate) {
  if (capability?.schemaVersion !== '1.0' || capability.profileRef !== PROFILE_REF
      || capability.capabilityId !== gate.capabilityId
      || capability.bindingKind !== 'requiredGate' || capability.stageId !== null
      || capability.subjectId !== gate.gateId
      || capability.implementationMode !== SEMANTIC_IMPLEMENTATION_MODE
      || !Array.isArray(capability.semanticImplementationArtifacts)
      || capability.semanticImplementationArtifacts.length === 0) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_CAPABILITY_MODE',
      `${gate.gateId} is not bound to ${SEMANTIC_IMPLEMENTATION_MODE}`,
      gate.capabilityRef?.path || gate.gateId,
      'unverified',
    );
  }
  const entrypoint = tupleFromCapability(capability, 'entrypoint', `${gate.gateId}/entrypoint`);
  const discovery = tupleFromCapability(
    capability,
    'subjectDiscoveryComponent',
    `${gate.gateId}/subjectDiscoveryComponent`,
  );
  const evidence = tupleFromCapability(
    capability,
    'evidenceResultComponent',
    `${gate.gateId}/evidenceResultComponent`,
  );
  if (!sameRef(entrypoint.ref, gate.entrypointRef) || entrypoint.digest !== gate.entrypointDigest
      || !sameRef(discovery.ref, gate.discoveryContractRef)
      || discovery.digest !== gate.discoveryContractDigest
      || !sameRef(evidence.ref, gate.evidenceSchemaRef)
      || evidence.digest !== gate.evidenceSchemaDigest) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_REQUIRED_TUPLE',
      `${gate.gateId} capability does not repeat the required-gate tuple byte-for-byte`,
      gate.gateId,
    );
  }
  const implementations = capability.semanticImplementationArtifacts;
  let previous = null;
  let entrypointDeclared = false;
  for (const [index, implementation] of implementations.entries()) {
    if (!exactKeys(implementation, ['ref', 'digest'])) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_IMPLEMENTATION_TUPLE',
        `${gate.gateId} semantic implementation row is not closed`,
        `${gate.gateId}/semanticImplementationArtifacts/${index}`,
      );
    }
    const key = canonicalJcs(implementation.ref);
    if (previous !== null && compareUtf8(previous, key) >= 0) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_IMPLEMENTATION_ORDER',
        `${gate.gateId} semantic implementation refs are not sorted/unique`,
        `${gate.gateId}/semanticImplementationArtifacts/${index}`,
      );
    }
    previous = key;
    if (sameRef(implementation.ref, gate.entrypointRef)
        && implementation.digest === gate.entrypointDigest) entrypointDeclared = true;
  }
  if (!entrypointDeclared) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_IMPLEMENTATION_ENTRYPOINT',
      `${gate.gateId} semantic implementation closure omits its entrypoint`,
      gate.gateId,
    );
  }
}

function resolveReport(row, gateId, context) {
  if (!row || row.gateId !== gateId || row.outcome !== 'passed') {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_REPORT_REQUIRED',
      `${gateId} has no exact passed report row`,
      `/gateReports/${gateId}`,
      'missing',
    );
  }
  const resolved = resolveRawPair({
    artifactRef: row.reportRef,
    artifactDigest: row.reportDigest,
  }, context, `${gateId} ValidationReport`);
  const report = strictJcs(resolved.bytes, `${gateId} ValidationReport`);
  if (report.schemaVersion !== '1.0' || report.profileRef !== PROFILE_REF
      || report.gateId !== gateId || report.recordType !== 'validationReport'
      || report.result?.outcome !== 'passed'
      || canonicalJcs(report.build) !== canonicalJcs(context.p1?.build)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_REPORT_IDENTITY',
      `${gateId} report bytes are not its passed ValidationReport`,
      row.reportRef?.path || gateId,
    );
  }
  return { row, report, bytes: resolved.bytes };
}

function reportTupleMatches(report, gate) {
  if (report.profileRef !== PROFILE_REF) return false;
  for (const field of [
    'gateId', 'reportKind', 'criterionRefs', 'toolId', 'capabilityId',
    'capabilityRef', 'capabilityDigest', 'entrypointRef', 'entrypointDigest',
    'discoveryContractRef', 'discoveryContractDigest',
  ]) {
    if (canonicalJcs(report[field]) !== canonicalJcs(gate[field])) return false;
  }
  return sameRef(report.kindEvidence?.schemaRef, gate.evidenceSchemaRef)
    && report.kindEvidence?.schemaDigest === gate.evidenceSchemaDigest;
}

function expectedInventory(gate, subjects) {
  return {
    schemaVersion: '1.0',
    gateId: gate.gateId,
    discoveryContractRef: gate.discoveryContractRef,
    discoveryContractDigest: gate.discoveryContractDigest,
    subjects,
  };
}

function loadAndCompareInventory(report, expected, context, gateId) {
  const resolved = resolvePair({
    artifactRef: report.subjectInventoryRef,
    artifactDigest: report.subjectInventoryDigest,
  }, context, `${gateId} subject inventory`);
  const authored = resolved.value || strictJcs(resolved.bytes, `${gateId} subject inventory`);
  const digest = taggedJcsDigest(INVENTORY_TAG, expected);
  if (digest !== report.subjectInventoryDigest
      || canonicalJcs(authored) !== canonicalJcs(expected)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_DISCOVERY_MISMATCH',
      `${gateId} caller-authored inventory differs from independent P1 discovery`,
      gateId,
    );
  }
  return digest;
}

function dependencyReports(gate, rowById, context) {
  const rows = [];
  for (const dependencyId of gate.dependsOn || []) {
    const resolved = resolveReport(rowById.get(dependencyId), dependencyId, context);
    rows.push({
      gateId: dependencyId,
      reportRef: resolved.row.reportRef,
      reportDigest: resolved.row.reportDigest,
    });
  }
  rows.sort((left, right) => compareUtf8(left.gateId, right.gateId));
  return rows;
}

function candidateRequest(gate, inventory, inventoryDigest, dependencies) {
  const request = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    operation: SEMANTIC_OPERATION,
    capabilityId: gate.capabilityId,
    gateId: gate.gateId,
    subjectInventory: inventory,
    subjectInventoryDigest: inventoryDigest,
    dependencyReports: dependencies,
    vectorCategory: null,
    fault: null,
  };
  return {
    value: request,
    bytes: Buffer.from(canonicalJcs(request), 'utf8'),
    digest: taggedJcsDigest(REQUEST_TAG, request),
  };
}

function validateSemanticOutput(output, gate, inventoryDigest, dependencies) {
  const dependencyReportDigests = dependencies
    .map((row) => row.reportDigest).sort(compareUtf8);
  if (output.schemaVersion !== '1.0' || output.profileRef !== PROFILE_REF
      || output.capabilityId !== gate.capabilityId || output.gateId !== gate.gateId
      || output.status !== 'completed' || output.outcome !== 'passed'
      || output.code !== null || output.evidenceUse !== SEMANTIC_EVIDENCE_USE
      || output.releaseEligibilityEvidence !== true
      || output.callerEvidenceAccepted !== false
      || output.subjectInventoryDigest !== inventoryDigest
      || canonicalJcs(output.dependencyReportDigests)
        !== canonicalJcs(dependencyReportDigests)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_OUTPUT_IDENTITY',
      `${gate.gateId} entrypoint output is not closed release-eligibility evidence`,
      gate.gateId,
    );
  }
}

function validateVectorManifest(vectors, gate) {
  if (!exactKeys(vectors, ['schemaVersion', 'profileRef', 'capabilityId', 'categories'])
      || vectors.schemaVersion !== '1.0' || vectors.profileRef !== PROFILE_REF
      || vectors.capabilityId !== gate.capabilityId
      || !exactKeys(vectors.categories, VECTOR_CATEGORIES)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_VECTOR_MANIFEST',
      `${gate.gateId} test-vector manifest does not contain the exact five categories`,
      gate.gateId,
      'unverified',
    );
  }
}

function validateVectorInput(input, gate, category, at) {
  if (!exactKeys(input, [
    'schemaVersion', 'profileRef', 'operation', 'capabilityId', 'gateId',
    'vectorCategory', 'subject', 'subjectDigest', 'fault',
  ]) || input.schemaVersion !== '1.0' || input.profileRef !== PROFILE_REF
      || input.operation !== 'semanticVector'
      || input.capabilityId !== gate.capabilityId || input.gateId !== gate.gateId
      || input.vectorCategory !== category
      || (input.subjectDigest !== null
        && !/^sha256:[0-9a-f]{64}$/u.test(input.subjectDigest || ''))
      || (input.fault !== null
        && (typeof input.fault !== 'string' || input.fault.length === 0))
      || (category === 'emptySubject' ? input.subject !== null : input.subject === null)
      || (category === 'emptySubject' && input.subjectDigest !== null)
      || (category === 'engineFailure' ? input.fault === null : input.fault !== null)
      || (category === 'tamper' && input.subjectDigest === null)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_VECTOR_INPUT',
      `${gate.gateId}/${category} vector input does not lock its gate/category polarity`,
      at,
      'unverified',
    );
  }
}

function validateVectorExpected(expected, gate, category, at) {
  const locked = EXPECTED_VECTOR_RESULTS[category];
  const codeValid = category === 'positive'
    ? expected.code === null
    : typeof expected.code === 'string' && expected.code.length > 0;
  if (expected.status !== locked.status || expected.outcome !== locked.outcome
      || expected.exitStatus !== locked.exitStatus
      || expected.releaseEligibilityEvidence !== false || !codeValid) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_VECTOR_EXPECTED',
      `${gate.gateId}/${category} expected result weakens the locked polarity`,
      at,
      'unverified',
    );
  }
}

function validateVectorOutput(output, gate, category, at) {
  if (output.schemaVersion !== '1.0' || output.profileRef !== PROFILE_REF
      || output.capabilityId !== gate.capabilityId || output.gateId !== gate.gateId
      || output.evidenceUse !== VECTOR_EVIDENCE_USE
      || output.releaseEligibilityEvidence !== false
      || output.callerEvidenceAccepted !== false
      || output.subjectInventoryDigest !== null
      || !Array.isArray(output.dependencyReportDigests)
      || output.dependencyReportDigests.length !== 0) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_VECTOR_IDENTITY',
      `${gate.gateId}/${category} vector output is not isolated non-release evidence`,
      at,
    );
  }
}

function replayVectors(options, gate, capability, schema, inputContract, root) {
  const testVectorsTuple = tupleFromCapability(
    capability,
    'testVectors',
    `${gate.gateId}/testVectors`,
  );
  const vectors = sourceControl(
    options,
    testVectorsTuple.ref,
    testVectorsTuple.digest,
    `${gate.gateId} test vectors`,
    true,
  );
  validateVectorManifest(vectors, gate);
  let caseCount = 0;
  const refs = new Set();
  const digests = new Set();
  for (const category of VECTOR_CATEGORIES) {
    const rows = vectors.categories[category];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_VECTOR_EMPTY',
        `${gate.gateId}/${category} has no executable vector`,
        `${gate.gateId}/${category}`,
        'unverified',
      );
    }
    let previous = null;
    for (const [index, row] of rows.entries()) {
      const at = `${gate.gateId}/${category}/${index}`;
      if (!exactKeys(row, ['caseId', 'category', 'inputRef', 'inputDigest', 'expected'])
          || row.category !== category || typeof row.caseId !== 'string'
          || !exactKeys(row.expected, [
            'code', 'exitStatus', 'outcome', 'releaseEligibilityEvidence', 'status',
          ])) {
        throw new SemanticReplayError(
          'M2_GATE_SEMANTIC_VECTOR_ROW',
          'semantic vector row is not closed',
          at,
        );
      }
      validateVectorExpected(row.expected, gate, category, at);
      if (previous !== null && compareUtf8(previous, row.caseId) >= 0) {
        throw new SemanticReplayError(
          'M2_GATE_SEMANTIC_VECTOR_ORDER',
          'semantic vector case IDs are not strictly sorted',
          at,
        );
      }
      previous = row.caseId;
      const refKey = canonicalJcs(row.inputRef);
      if (refs.has(refKey) || digests.has(row.inputDigest)) {
        throw new SemanticReplayError(
          'M2_GATE_SEMANTIC_VECTOR_REUSE',
          'semantic vectors reuse an input ref or digest',
          at,
        );
      }
      refs.add(refKey);
      digests.add(row.inputDigest);
      const inputBytes = sourceControl(
        options,
        row.inputRef,
        row.inputDigest,
        `${at} input`,
        false,
      );
      const vectorInput = strictJcs(inputBytes, `${at} input`);
      validateVectorInput(vectorInput, gate, category, at);
      const execution = executeEntrypoint(
        root,
        gate.entrypointRef,
        inputContract,
        inputBytes,
        inputContract.invocation.timeoutMs,
      );
      const schemaIssues = validateJsonSchema(execution.value, schema);
      validateVectorOutput(execution.value, gate, category, at);
      if (schemaIssues.length > 0
          || execution.status !== row.expected.exitStatus
          || execution.value.status !== row.expected.status
          || execution.value.outcome !== row.expected.outcome
          || execution.value.code !== row.expected.code
          || execution.value.releaseEligibilityEvidence
            !== row.expected.releaseEligibilityEvidence
          || execution.value.evidenceUse !== VECTOR_EVIDENCE_USE) {
        throw new SemanticReplayError(
          'M2_GATE_SEMANTIC_VECTOR_RESULT',
          `${at} did not produce its locked isolated result`,
          at,
        );
      }
      caseCount += 1;
    }
  }
  return caseCount;
}

function replayOneGate(options, gate, context, rowById, root) {
  const capability = sourceControl(
    options,
    gate.capabilityRef,
    gate.capabilityDigest,
    `${gate.gateId} capability`,
    true,
  );
  validateCapability(capability, gate);
  sourceControl(
    options,
    gate.entrypointRef,
    gate.entrypointDigest,
    `${gate.gateId} entrypoint`,
    false,
  );
  const discovery = sourceControl(
    options,
    gate.discoveryContractRef,
    gate.discoveryContractDigest,
    `${gate.gateId} discovery contract`,
    true,
  );
  const schema = sourceControl(
    options,
    gate.evidenceSchemaRef,
    gate.evidenceSchemaDigest,
    `${gate.gateId} evidence schema`,
    true,
  );
  validateEvidenceSchemaProfile(schema, gate);
  const inputTuple = tupleFromCapability(
    capability,
    'inputContract',
    `${gate.gateId}/inputContract`,
  );
  const inputContract = sourceControl(
    options,
    inputTuple.ref,
    inputTuple.digest,
    `${gate.gateId} input contract`,
    true,
  );
  validateInputContract(inputContract, gate, capability);
  const runtimeDependencyCount = prepareRuntimeDependencies(
    options,
    root,
    inputContract.runtimeDependencies,
  );
  const outputTuple = tupleFromCapability(
    capability,
    'outputContract',
    `${gate.gateId}/outputContract`,
  );
  const outputContract = sourceControl(
    options,
    outputTuple.ref,
    outputTuple.digest,
    `${gate.gateId} output contract`,
    true,
  );
  validateOutputContract(outputContract, gate, capability);
  for (const [index, implementation] of (
    Array.isArray(capability.semanticImplementationArtifacts)
      ? capability.semanticImplementationArtifacts : []
  ).entries()) {
    if (!exactKeys(implementation, ['ref', 'digest'])) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_IMPLEMENTATION_TUPLE',
        `${gate.gateId} semantic implementation row is not closed`,
        `${gate.gateId}/semanticImplementationArtifacts/${index}`,
      );
    }
    sourceControl(
      options,
      implementation.ref,
      implementation.digest,
      `${gate.gateId} semantic implementation ${index}`,
      false,
    );
  }

  const subjects = discoverSubjects(gate, discovery, options.sourceArtifacts);
  const inventory = expectedInventory(gate, subjects);
  const resolvedReport = resolveReport(rowById.get(gate.gateId), gate.gateId, context);
  if (!reportTupleMatches(resolvedReport.report, gate)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_REPORT_TUPLE',
      `${gate.gateId} report tuple differs from the required-gate row`,
      gate.gateId,
    );
  }
  const inventoryDigest = loadAndCompareInventory(
    resolvedReport.report,
    inventory,
    context,
    gate.gateId,
  );
  const dependencies = dependencyReports(gate, rowById, context);
  const vectorCaseCount = replayVectors(
    options,
    gate,
    capability,
    schema,
    inputContract,
    root,
  );
  const request = candidateRequest(gate, inventory, inventoryDigest, dependencies);
  const entrypointBefore = fs.readFileSync(safePath(root, gate.entrypointRef.path));
  const execution = executeEntrypoint(
    root,
    gate.entrypointRef,
    inputContract,
    request.bytes,
    inputContract.invocation.timeoutMs,
  );
  const entrypointAfter = fs.readFileSync(safePath(root, gate.entrypointRef.path));
  if (!entrypointBefore.equals(entrypointAfter)
      || sha256(entrypointAfter) !== gate.entrypointDigest) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_ENTRYPOINT_MUTATION',
      `${gate.gateId} entrypoint bytes changed during replay`,
      gate.entrypointRef.path,
    );
  }
  if (execution.status !== inputContract.invocation.successExitCode) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_ENTRYPOINT_EXIT',
      `${gate.gateId} entrypoint exited ${String(execution.status)}`,
      gate.entrypointRef.path,
    );
  }
  const schemaIssues = validateJsonSchema(execution.value, schema);
  if (schemaIssues.length > 0) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_EVIDENCE_SCHEMA',
      `${gate.gateId} output fails its locked evidence schema: ${schemaIssues[0]}`,
      gate.evidenceSchemaRef.path,
    );
  }
  validateSemanticOutput(execution.value, gate, inventoryDigest, dependencies);
  const evidence = resolvePair({
    artifactRef: resolvedReport.report.kindEvidence.artifactRef,
    artifactDigest: resolvedReport.report.kindEvidence.artifactDigest,
  }, context, `${gate.gateId} kindEvidence`);
  if (!execution.bytes.equals(evidence.bytes)) {
    throw new SemanticReplayError(
      'M2_GATE_SEMANTIC_EVIDENCE_MISMATCH',
      `${gate.gateId} kindEvidence bytes differ from independent entrypoint replay`,
      gate.gateId,
    );
  }
  return {
    subjectCount: subjects.length,
    dependencyCount: dependencies.length,
    vectorCaseCount,
    runtimeDependencyCount,
    requestDigest: request.digest,
    evidenceByteDigest: sha256(execution.bytes),
  };
}

function issueFrom(cause, gateId = '') {
  const value = cause instanceof SemanticReplayError ? cause : new SemanticReplayError(
    'M2_GATE_SEMANTIC_REPLAY_ENGINE',
    cause?.message || String(cause),
    gateId,
  );
  return {
    code: value.code,
    path: value.at,
    kind: value.kind,
    message: value.message,
    gateId,
  };
}

function failedOutcome(gateId, issue) {
  return {
    gateId,
    outcome: issue.kind === 'invalid' ? 'invalid' : 'incomplete',
    releaseGateEvidenceEstablished: false,
    declaredEntrypointExecuted: false,
    declaredDiscoveryReplayed: false,
    declaredEvidenceSchemaValidated: false,
    kindEvidenceByteEquivalent: false,
    dependencyReportsRecomputed: false,
    fiveVectorCategoriesPassed: false,
    callerEvidenceAccepted: false,
    issueCode: issue.code,
  };
}

function applyDependencyOutcomeClosure(required, gateOutcomes, issues) {
  const byId = new Map(gateOutcomes.map((row) => [row.gateId, row]));
  const issued = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const gate of required.gates) {
      const row = byId.get(gate.gateId);
      if (!row?.releaseGateEvidenceEstablished) continue;
      const failed = gate.dependsOn.filter((dependencyId) => (
        byId.get(dependencyId)?.releaseGateEvidenceEstablished !== true
      ));
      if (failed.length === 0) continue;
      row.outcome = 'incomplete';
      row.releaseGateEvidenceEstablished = false;
      row.dependencyReportsRecomputed = false;
      row.issueCode = 'M2_GATE_SEMANTIC_DEPENDENCY_OUTCOME';
      changed = true;
      if (!issued.has(gate.gateId)) {
        issued.add(gate.gateId);
        issues.push({
          code: 'M2_GATE_SEMANTIC_DEPENDENCY_OUTCOME',
          path: gate.gateId,
          kind: 'unverified',
          message: `${gate.gateId} dependencies lack independent semantic replay: ${failed.join(', ')}`,
          gateId: gate.gateId,
        });
      }
    }
  }
}

function verifyRequiredGateSemanticReplay(options = {}) {
  const issues = [];
  const gateOutcomes = [];
  let root = null;
  try {
    const sourceArtifacts = options.sourceArtifacts instanceof Map
      ? options.sourceArtifacts : new Map();
    options = { ...options, sourceArtifacts };
    validateSourceInventory(sourceArtifacts);
    const required = options.requiredGates;
    validateRequiredGateManifest(required);
    if (!options.p1 || !(options.artifacts instanceof Map)
        || options.artifacts.size === 0 || !Array.isArray(options.p1.gateReports)) {
      throw new SemanticReplayError(
        'M2_GATE_SEMANTIC_CANDIDATE_REQUIRED',
        'semantic replay requires P1 manifest, payload bytes, and gate reports',
        '',
        'unverified',
      );
    }
    const entries = payloadEntryMap(options.p1);
    const context = {
      p1: options.p1,
      artifacts: options.artifacts,
      sourceArtifacts,
      entries,
      catalogByPair: loadCatalog(options.p1, options.artifacts, entries),
    };
    const rowById = new Map(options.p1.gateReports.map((row) => [row?.gateId, row]));
    root = materializeSource(sourceArtifacts);
    for (const gate of required.gates) {
      try {
        const result = replayOneGate(options, gate, context, rowById, root);
        gateOutcomes.push({
          gateId: gate.gateId,
          outcome: 'passed',
          releaseGateEvidenceEstablished: true,
          declaredEntrypointExecuted: true,
          declaredDiscoveryReplayed: true,
          declaredEvidenceSchemaValidated: true,
          kindEvidenceByteEquivalent: true,
          dependencyReportsRecomputed: true,
          fiveVectorCategoriesPassed: true,
          callerEvidenceAccepted: false,
          issueCode: null,
          ...result,
        });
      } catch (cause) {
        const issue = issueFrom(cause, gate.gateId);
        issues.push(issue);
        gateOutcomes.push(failedOutcome(gate.gateId, issue));
      }
    }
    applyDependencyOutcomeClosure(required, gateOutcomes, issues);
  } catch (cause) {
    const issue = issueFrom(cause);
    issues.push(issue);
    for (const gateId of REQUIRED_GATE_IDS) gateOutcomes.push(failedOutcome(gateId, issue));
  } finally {
    try {
      removeReplayRoot(root);
    } catch (cause) {
      const issue = issueFrom(cause);
      issues.push(issue);
      for (const row of gateOutcomes) {
        row.outcome = 'invalid';
        row.releaseGateEvidenceEstablished = false;
        row.issueCode = issue.code;
      }
    }
  }
  gateOutcomes.sort((left, right) => compareUtf8(left.gateId, right.gateId));
  const invalid = issues.some((issue) => issue.kind === 'invalid');
  const allPassed = gateOutcomes.length === REQUIRED_GATE_IDS.length
    && gateOutcomes.every((row) => row.releaseGateEvidenceEstablished === true);
  return {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    outcome: allPassed ? 'passed' : invalid ? 'invalid' : 'incomplete',
    releaseGateEvidenceEstablished: allPassed,
    gateOutcomes,
    issues,
    callerEvidenceAccepted: false,
    isolatedTemporaryCopy: root !== null,
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEPENDENCY_TREE_TAG,
  MAX_OUTPUT_BYTES,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_FILES,
  REQUEST_TAG,
  SEMANTIC_EVIDENCE_USE,
  SEMANTIC_IMPLEMENTATION_MODE,
  SEMANTIC_OPERATION,
  SUBJECT_TAG,
  VECTOR_CATEGORIES,
  VECTOR_EVIDENCE_USE,
  SemanticReplayError,
  applyDependencyOutcomeClosure,
  candidateRequest,
  dependencyTreeDigest,
  discoverSubjects,
  expectedInventory,
  removeReplayRoot,
  validateEvidenceSchemaProfile,
  validateDiscoveryContract,
  validateRequiredGateManifest,
  verifyRequiredGateSemanticReplay,
};
