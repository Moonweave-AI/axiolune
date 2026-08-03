'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { projectShaclWithInventory } = require('../generate-m2-shacl.cjs');
const { constraintInstanceId } = require('./m2-constraint-instance-audit.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  PENDING_VALIDATOR_EXECUTION,
} = require('./orders-portfolio-custom-profile.cjs');
const { mutate: mutateRisk } = require('./risk-v03-contract.cjs');
const { encodeCanonicalRiskScenario } = require('./risk-canonical-record-adapter.cjs');
const {
  authenticateSourceClaims,
} = require('./post-trade-risk-source-artifact-inventory.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const PROFILE_ROOT = 'scripts/domain/custom-release-profile/v0.3.0';
const REGISTRY_PATH = 'scripts/domain/release-profile/v0.3.0/custom-capability-bindings.json';
const RUNTIME_LOCK_PATH = `${PROFILE_ROOT}/node-runtime-lock.json`;
const EXPECTED_NODE_VERSION = '24.18.0';
const CATEGORIES = Object.freeze([
  'positive', 'violation', 'tamper', 'emptySubject', 'engineFailure',
]);
const CUSTOM_COMPONENT = `${PROFILE_REF}/components/CustomConstraintComponent`;
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const ORDERS_PORTFOLIO_EXECUTION_FIELDS = Object.freeze([
  'eligible',
  'pendingCode',
  'pendingRequirement',
  'status',
]);

const GROUPS = Object.freeze([
  Object.freeze({
    groupId: 'identifier',
    toolId: 'axiolune-identifier-custom-runtime-v1',
    discoveryPath: 'scripts/domain/identifier-custom-profile/v0.3.0/discovery-contract.json',
    vectorsPath: 'scripts/domain/identifier-custom-profile/v0.3.0/test-vectors.json',
    closurePath: 'scripts/domain/identifier-custom-profile/v0.3.0/implementation-closure.json',
    entrypointPath: 'scripts/domain/foundation-identifier-worker.cjs',
    inputProtocol: 'identifier-files-jcs-v1',
  }),
  Object.freeze({
    groupId: 'foundation-market-strategy',
    toolId: 'axiolune-foundation-market-strategy-custom-runtime-v1',
    discoveryPath: 'scripts/domain/foundation-market-strategy-custom-profile/v0.3.0/discovery-contract.json',
    vectorsPath: 'scripts/domain/foundation-market-strategy-custom-profile/v0.3.0/test-vectors.json',
    closurePath: 'scripts/domain/foundation-market-strategy-custom-profile/v0.3.0/implementation-closure.json',
    entrypointPath: 'scripts/domain/foundation-market-strategy-custom-worker.cjs',
    inputProtocol: 'stdin-jcs-v1',
  }),
  Object.freeze({
    groupId: 'orders-portfolio',
    toolId: 'axiolune-orders-portfolio-custom-runtime-v1',
    discoveryPath: 'scripts/domain/orders-portfolio-custom-profile/v0.3.0/discovery-contract.json',
    vectorsPath: 'scripts/domain/orders-portfolio-custom-profile/v0.3.0/test-vectors.json',
    closurePath: 'scripts/domain/orders-portfolio-custom-profile/v0.3.0/implementation-closure.json',
    entrypointPath: 'scripts/domain/orders-portfolio-custom-worker.cjs',
    inputProtocol: 'stdin-jcs-v1',
  }),
  Object.freeze({
    groupId: 'post-trade',
    toolId: 'axiolune-post-trade-custom-runtime-v1',
    discoveryPath: 'scripts/domain/post-trade-custom-profile/v0.3.0/discovery-contract.json',
    vectorsPath: 'scripts/domain/post-trade-custom-profile/v0.3.0/test-vectors.json',
    closurePath: 'scripts/domain/post-trade-custom-profile/v0.3.0/implementation-closure.json',
    entrypointPath: 'scripts/domain/post-trade-custom-worker.cjs',
    inputProtocol: 'stdin-jcs-v1',
  }),
  Object.freeze({
    groupId: 'risk',
    toolId: 'axiolune-risk-custom-runtime-v1',
    discoveryPath: 'scripts/domain/risk-custom-profile/v0.3.0/discovery-contract.json',
    vectorsPath: null,
    closurePath: null,
    entrypointPath: 'scripts/domain/risk-custom-worker.cjs',
    inputProtocol: 'stdin-jcs-v1',
  }),
]);

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sourceRef(relativePath) {
  return Object.freeze({ kind: 'path', root: 'sourceTree', path: relativePath });
}

function absolute(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0
      || relativePath.includes('\\') || relativePath.startsWith('/')
      || /^[A-Za-z]:/u.test(relativePath)
      || relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`unsafe source path ${String(relativePath)}`);
  }
  const resolved = path.resolve(ROOT, ...relativePath.split('/'));
  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`source path escapes repository ${relativePath}`);
  }
  return resolved;
}

function readBytes(relativePath) {
  const file = absolute(relativePath);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${relativePath} is not a regular non-symlink file`);
  }
  return fs.readFileSync(file);
}

function readJcs(relativePath) {
  const bytes = readBytes(relativePath);
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${relativePath} is not exact UTF-8 RFC 8785 JCS`);
  }
  return { bytes, value };
}

function financeModulePaths() {
  const finance = absolute('ontology/domain/finance');
  return fs.readdirSync(finance, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => `ontology/domain/finance/${entry.name}/module.yaml`)
    .filter((relativePath) => fs.existsSync(absolute(relativePath)))
    .sort(byteCompare);
}

function ontologyCustomDefinitions() {
  const definitions = [];
  for (const modulePath of financeModulePaths()) {
    const document = YAML.parse(readBytes(modulePath).toString('utf8'));
    for (const constraint of Object.values(document?.domain?.constraints || {})) {
      if (constraint?.expression?.language !== 'Custom') continue;
      if (typeof constraint.iri !== 'string' || constraint.iri.length === 0) {
        throw new Error(`${modulePath} contains a Custom constraint without a stable IRI`);
      }
      definitions.push(Object.freeze({
        constraintIri: constraint.iri,
        modulePath,
      }));
    }
  }
  definitions.sort((left, right) => byteCompare(left.constraintIri, right.constraintIri));
  for (let index = 1; index < definitions.length; index += 1) {
    if (definitions[index - 1].constraintIri === definitions[index].constraintIri) {
      throw new Error(`duplicate ontology Custom constraint IRI ${definitions[index].constraintIri}`);
    }
  }
  if (definitions.length === 0) {
    throw new Error('ontology/domain/finance contains no Custom constraint definitions');
  }
  return Object.freeze(definitions);
}

function readJson(relativePath) {
  const bytes = readBytes(relativePath);
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

function readRuntimeJcs(relativePath) {
  const bytes = readBytes(relativePath);
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(runtimeJcs(value), 'utf8'))) {
    throw new Error(`${relativePath} is not exact RFC 8785 JCS`);
  }
  return { bytes, value };
}

function jcsArtifact(value) {
  const bytes = Buffer.from(canonicalJcs(value), 'utf8');
  return Object.freeze({ value: Object.freeze(value), bytes, digest: sha256(bytes) });
}

function runtimeJcs(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          throw new Error('runtime JCS string contains an unpaired surrogate');
        }
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new Error('runtime JCS string contains an unpaired surrogate');
      }
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('runtime JCS number is not finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length
        || keys.some((key, index) => key !== String(index))) {
      throw new Error('runtime JCS array is sparse or has non-index properties');
    }
    return `[${value.map(runtimeJcs).join(',')}]`;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('runtime input is not a JSON value');
  }
  // RFC 8785 property order is lexicographic over UTF-16 code units, which is
  // ECMAScript's default Array#sort ordering.
  return `{${Object.keys(value).sort()
    .map((key) => `${runtimeJcs(key)}:${runtimeJcs(value[key])}`).join(',')}}`;
}

function runtimeInputArtifact(value) {
  const bytes = Buffer.from(runtimeJcs(value), 'utf8');
  return Object.freeze({ value: Object.freeze(value), bytes, digest: sha256(bytes) });
}

function digestBound(relativePath, suppliedBytes = null) {
  const bytes = suppliedBytes || readBytes(relativePath);
  return Object.freeze({ ref: sourceRef(relativePath), digest: sha256(bytes) });
}

function capabilityKey(constraintIri) {
  return crypto.createHash('sha256')
    .update(Buffer.from('axiolune-custom-release-capability-v1\0', 'utf8'))
    .update(Buffer.from(constraintIri, 'utf8'))
    .digest('hex');
}

function groupById(groupId) {
  const group = GROUPS.find((candidate) => candidate.groupId === groupId);
  if (!group) throw new Error(`unknown Custom runtime group ${groupId}`);
  return group;
}

function exactObjectKeys(value, fields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a closed object`);
  }
  const actual = Object.keys(value).sort(byteCompare);
  const expected = [...fields].sort(byteCompare);
  if (actual.length !== expected.length
      || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${label} field closure mismatch`);
  }
}

function ordersPortfolioExecution(vector, discoveryRow = undefined) {
  if (vector === null || typeof vector !== 'object' || Array.isArray(vector)) {
    throw new Error('orders-portfolio vector must be an object');
  }
  if (typeof vector.constraintIri !== 'string' || typeof vector.validatorId !== 'string') {
    throw new Error('orders-portfolio vector identity is incomplete');
  }
  if (discoveryRow !== undefined
      && (vector.constraintIri !== discoveryRow.constraintIri
        || vector.validatorId !== discoveryRow.validatorId)) {
    throw new Error(`${vector.constraintIri} orders-portfolio vector/discovery binding mismatch`);
  }
  exactObjectKeys(
    vector.execution,
    ORDERS_PORTFOLIO_EXECUTION_FIELDS,
    `${vector.constraintIri}.execution`,
  );
  const pending = PENDING_VALIDATOR_EXECUTION[vector.validatorId] || null;
  const expected = pending === null
    ? {
      eligible: true,
      pendingCode: null,
      pendingRequirement: null,
      status: 'executable',
    }
    : {
      eligible: false,
      pendingCode: pending.pendingCode,
      pendingRequirement: pending.pendingRequirement,
      status: 'pending',
    };
  if (canonicalJcs(vector.execution) !== canonicalJcs(expected)) {
    throw new Error(`${vector.constraintIri} orders-portfolio execution lifecycle drift`);
  }
  return Object.freeze(expected);
}

function semanticRow(group, row, vector) {
  if (group.groupId === 'identifier') {
    return {
      constraintIri: row.constraintDefinitionIri,
      validatorId: row.capabilityId,
      dispatchDigest: sha256(Buffer.from(canonicalJcs(row), 'utf8')),
      expectedViolationCode: vector.violation.expectedCode,
    };
  }
  if (group.groupId === 'foundation-market-strategy') {
    return {
      constraintIri: row.constraintIri,
      validatorId: row.validatorId,
      dispatchDigest: row.dispatchDigest,
      expectedViolationCode: vector.negative.expectedCode,
    };
  }
  if (group.groupId === 'orders-portfolio') {
    const execution = ordersPortfolioExecution(vector, row);
    return {
      constraintIri: row.constraintIri,
      validatorId: row.validatorId,
      dispatchDigest: row.dispatchDigest,
      authoredViolationCode: vector.violation.expectedCode,
      execution,
      expectedViolationCode: execution.status === 'pending'
        ? execution.pendingCode
        : vector.violation.expectedCode,
    };
  }
  if (group.groupId === 'post-trade') {
    return {
      constraintIri: row.constraintIri,
      validatorId: row.validatorId,
      evaluatorId: row.evaluatorId,
      dispatchDigest: row.dispatchDigest,
      expectedViolationCode: vector.violation.expectedCode,
    };
  }
  return {
    constraintIri: row.constraintIri,
    validatorId: row.evaluatorId,
    evaluatorId: row.evaluatorId,
    dispatchDigest: row.dispatchDigest,
    expectedViolationCode: row.expectedViolation,
  };
}

function expected(category, constraintIri, code, options = {}) {
  return Object.freeze({
    caseStatus: options.caseStatus || 'passed',
    status: options.status || 'completed',
    outcome: options.outcome || (category === 'positive' ? 'accepted' : 'violation'),
    code: code || null,
    semanticOwner: constraintIri,
  });
}

function identifierVectors(discovery, vectors) {
  const result = [];
  for (const row of discovery.constraints) {
    const constraintIri = row.constraintDefinitionIri;
    const positive = vectors.positive.find((candidate) => (
      candidate.input?.constraintDefinitionIri === constraintIri
    ));
    const violation = vectors.violation.find((candidate) => (
      candidate.input?.constraintDefinitionIri === constraintIri
    ));
    if (!positive || !violation) throw new Error(`identifier vector coverage missing ${constraintIri}`);
    const tamper = { ...positive.input, constraintDefinitionIri: `${PROFILE_REF}/unbound/${capabilityKey(constraintIri)}` };
    const engineFailure = { ...positive.input, lexicalValue: 'X'.repeat(257) };
    result.push({
      row,
      vector: { violation },
      requests: {
        positive: positive.input,
        violation: violation.input,
        tamper,
        emptySubject: {},
        engineFailure,
      },
      expectations: {
        positive: expected('positive', constraintIri, null),
        violation: expected('violation', constraintIri, violation.expectedCode),
        tamper: expected('tamper', constraintIri, 'IDENTIFIER_CUSTOM_UNBOUND', { status: 'engineFailure', outcome: 'engineFailure' }),
        emptySubject: expected('emptySubject', constraintIri, 'IDENTIFIER_INPUT_CONTRACT', { status: 'engineFailure', outcome: 'engineFailure' }),
        engineFailure: expected('engineFailure', constraintIri, 'IDENTIFIER_INPUT_CONTRACT', { status: 'engineFailure', outcome: 'engineFailure' }),
      },
    });
  }
  return result;
}

function stdinVectors(group, discovery, vectors) {
  const byIri = new Map(vectors.vectors.map((vector) => [vector.constraintIri, vector]));
  const result = [];
  for (const row of discovery.constraints) {
    const vector = byIri.get(row.constraintIri);
    if (!vector) throw new Error(`${group.groupId} vector coverage missing ${row.constraintIri}`);
    const constraintIri = row.constraintIri;
    let positive;
    let violation;
    let tamper;
    let emptySubject;
    let engineFailure;
    if (group.groupId === 'foundation-market-strategy') {
      positive = {
        constraintIri, dispatchDigest: row.dispatchDigest,
        scenario: vector.accepted.scenario, schemaVersion: '1.0', validatorId: row.validatorId,
      };
      violation = { ...positive, scenario: vector.negative.scenario };
      tamper = { ...positive, dispatchDigest: ZERO_DIGEST };
      emptySubject = {};
      engineFailure = { ...positive, mode: 'hang' };
    } else if (group.groupId === 'orders-portfolio') {
      positive = {
        constraintIri, scenario: vector.accepted.scenario,
        schemaVersion: '1.0', validatorId: row.validatorId,
      };
      violation = { ...positive, scenario: vector.violation.scenario };
      tamper = { ...positive, validatorId: `${row.validatorId}-tampered` };
      emptySubject = {};
      engineFailure = { ...positive, mode: 'hang' };
    } else {
      positive = {
        constraintIri, fixture: vector.accepted.fixture,
        schemaVersion: '1.0', validatorId: row.validatorId,
      };
      violation = { ...positive, fixture: vector.violation.fixture };
      tamper = { ...positive, validatorId: `${row.validatorId}-tampered` };
      emptySubject = {};
      engineFailure = { ...positive, mode: 'hang' };
    }
    const semantic = semanticRow(group, row, vector);
    const pending = group.groupId === 'orders-portfolio'
      && semantic.execution.status === 'pending';
    const positiveExpectation = pending
      ? expected('positive', constraintIri, semantic.execution.pendingCode, {
        caseStatus: 'pending',
        outcome: 'violation',
      })
      : expected('positive', constraintIri, null);
    const violationExpectation = pending
      ? expected('violation', constraintIri, semantic.execution.pendingCode, {
        caseStatus: 'pending',
      })
      : expected('violation', constraintIri, semantic.expectedViolationCode);
    result.push({
      row,
      vector,
      requests: { positive, violation, tamper, emptySubject, engineFailure },
      expectations: {
        positive: positiveExpectation,
        violation: violationExpectation,
        tamper: expected('tamper', constraintIri, 'WORKER_EXIT', { status: 'engineFailure', outcome: 'engineFailure' }),
        emptySubject: expected('emptySubject', constraintIri, 'WORKER_EXIT', { status: 'engineFailure', outcome: 'engineFailure' }),
        engineFailure: expected('engineFailure', constraintIri, 'TIME_LIMIT', { status: 'engineFailure', outcome: 'engineFailure' }),
      },
    });
  }
  return result;
}

function canonicalRiskScenario(value) {
  return value?.schemaVersion === '1.0' && Array.isArray(value?.records)
    ? structuredClone(value) : encodeCanonicalRiskScenario(value);
}

function riskVectors(discovery) {
  const positiveDocument = YAML.parse(readBytes('tests/m2/fixtures/positive/risk-v03.yaml').toString('utf8'));
  const negativeDocument = YAML.parse(readBytes('tests/m2/fixtures/negative/risk-v03.yaml').toString('utf8'));
  const positives = new Map((positiveDocument.fixtures || []).map((fixture) => [fixture.id, fixture]));
  const negatives = new Map((negativeDocument.cases || []).map((testCase) => [testCase.id, testCase]));
  return discovery.constraints.map((row) => {
    const base = positives.get(row.positiveFixtureId);
    if (!base) throw new Error(`risk positive fixture missing ${row.positiveFixtureId}`);
    let negative;
    if (row.negativeCaseId) {
      const testCase = negatives.get(row.negativeCaseId);
      if (!testCase) throw new Error(`risk negative case missing ${row.negativeCaseId}`);
      negative = structuredClone(positives.get(testCase.baseFixtureId)?.instance);
      if (!negative) throw new Error(`risk negative base missing ${testCase.baseFixtureId}`);
      for (const mutation of testCase.mutations || []) negative = mutateRisk(negative, mutation);
      if (testCase.expectedViolation !== row.expectedViolation) {
        throw new Error(`risk expected violation drift ${row.constraintIri}`);
      }
    } else {
      negative = mutateRisk(base.instance, row.inlineNegativeMutation);
    }
    const negativeMutations = row.negativeCaseId
      ? negatives.get(row.negativeCaseId).mutations || []
      : [row.inlineNegativeMutation];
    if (!negativeMutations.some((mutation) => (
      /(?:^|\.)(?:sourceArtifactRef|sourceArtifactDigest|sourceLocator)(?:\.|$)/u
        .test(mutation.path)
    ))) {
      negative = authenticateSourceClaims(negative, { namespace: 'risk-source' });
    }
    const positive = {
      constraintIri: row.constraintIri,
      evaluatorId: row.evaluatorId,
      scenario: canonicalRiskScenario(base.instance),
      schemaVersion: '1.0',
    };
    const violation = { ...positive, scenario: canonicalRiskScenario(negative) };
    const tamper = { ...positive, evaluatorId: `${row.evaluatorId}-tampered` };
    const emptySubject = {};
    const engineFailure = { ...positive, mode: 'hang' };
    return {
      row,
      vector: { violation: { expectedCode: row.expectedViolation } },
      requests: { positive, violation, tamper, emptySubject, engineFailure },
      expectations: {
        positive: expected('positive', row.constraintIri, null),
        violation: expected('violation', row.constraintIri, row.expectedViolation),
        tamper: expected('tamper', row.constraintIri, 'WORKER_EXIT', { status: 'engineFailure', outcome: 'engineFailure' }),
        emptySubject: expected('emptySubject', row.constraintIri, 'WORKER_EXIT', { status: 'engineFailure', outcome: 'engineFailure' }),
        engineFailure: expected('engineFailure', row.constraintIri, 'TIME_LIMIT', { status: 'engineFailure', outcome: 'engineFailure' }),
      },
    };
  });
}

function loadGroupCapabilities(group) {
  const discovery = (group.groupId === 'risk' ? readJson : readJcs)(group.discoveryPath).value;
  if (!Array.isArray(discovery.constraints) || discovery.constraints.length === 0) {
    throw new Error(`${group.discoveryPath} has no constraints`);
  }
  if (group.groupId === 'identifier') {
    return identifierVectors(discovery, readRuntimeJcs(group.vectorsPath).value);
  }
  if (group.groupId === 'risk') return riskVectors(discovery);
  return stdinVectors(group, discovery, readRuntimeJcs(group.vectorsPath).value);
}

async function customContexts() {
  const grouped = new Map();
  const contextIds = new Set();
  for (const modulePath of financeModulePaths()) {
    const document = YAML.parse(readBytes(modulePath).toString('utf8'));
    const projection = await projectShaclWithInventory(document);
    for (const context of projection.contexts) {
      if (context.component !== CUSTOM_COMPONENT) continue;
      const row = Object.freeze({
        constraintInstanceId: constraintInstanceId(context),
        targetRef: context.targetRef,
      });
      if (contextIds.has(row.constraintInstanceId)) {
        throw new Error(`duplicate ontology Custom context ${row.constraintInstanceId}`);
      }
      contextIds.add(row.constraintInstanceId);
      if (!grouped.has(context.originRef)) grouped.set(context.originRef, []);
      grouped.get(context.originRef).push(row);
    }
  }
  for (const rows of grouped.values()) rows.sort((left, right) => byteCompare(left.constraintInstanceId, right.constraintInstanceId));
  return grouped;
}

function implementationArtifacts(group) {
  if (group.closurePath) {
    const closure = readJcs(group.closurePath);
    const artifacts = Array.isArray(closure.value.artifacts) ? closure.value.artifacts : [];
    for (const row of artifacts) {
      if (sha256(readBytes(row.ref.path)) !== row.digest) {
        throw new Error(`${group.closurePath} implementation digest drift at ${row.ref.path}`);
      }
    }
    return [
      { role: 'componentClosure', ...digestBound(group.closurePath, closure.bytes) },
      ...artifacts.map((row) => ({ role: row.role, ref: row.ref, digest: row.digest })),
    ];
  }
  const riskPaths = [
    group.discoveryPath,
    group.entrypointPath,
    'scripts/domain/lib/risk-v03-contract.cjs',
    'scripts/domain/lib/risk-canonical-record-adapter.cjs',
    'scripts/domain/lib/strict-source-locator.cjs',
    'scripts/domain/risk-custom-profile/v0.3.0/input-contract.json',
    'scripts/domain/risk-custom-profile/v0.3.0/output-contract.json',
    'ontology/domain/finance/risk/module.yaml',
    'tests/m2/fixtures/positive/risk-v03.yaml',
    'tests/m2/fixtures/negative/risk-v03.yaml',
  ];
  return riskPaths.sort(byteCompare).map((relativePath) => ({
    role: 'implementationClosure', ...digestBound(relativePath),
  }));
}

function componentImplementationDigest(group, row) {
  if (typeof row.implementationDigest === 'string') return row.implementationDigest;
  if (group.closurePath) {
    const closure = readJcs(group.closurePath).value;
    if (typeof closure.closureDigest !== 'string') {
      throw new Error(`${group.closurePath} has no semantic closure digest`);
    }
    return closure.closureDigest;
  }
  const artifacts = implementationArtifacts(group)
    .map(({ role, ref, digest }) => ({ role, ref, digest }))
    .sort((left, right) => byteCompare(left.ref.path, right.ref.path));
  return sha256(Buffer.concat([
    Buffer.from('axiolune-custom-component-implementation-v1\0', 'utf8'),
    Buffer.from(canonicalJcs(artifacts), 'utf8'),
  ]));
}

function evidenceSchema(constraintIri) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${PROFILE_REF}/schemas/custom-capability-evidence/${capabilityKey(constraintIri)}`,
    type: 'object',
    additionalProperties: false,
    required: [
      'caseId', 'caseStatus', 'category', 'constraintIri', 'inputDigest', 'status',
      'outcome', 'code', 'pendingRequirement', 'semanticOwner', 'output',
      'outputDigest', 'stderrDigest',
    ],
    properties: {
      caseId: { type: 'string', minLength: 1 },
      caseStatus: { enum: ['passed', 'pending'] },
      category: { enum: CATEGORIES },
      constraintIri: { const: constraintIri },
      inputDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
      status: { enum: ['completed', 'engineFailure'] },
      outcome: { enum: ['accepted', 'violation', 'engineFailure'] },
      code: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
      pendingRequirement: {
        oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
      },
      semanticOwner: { const: constraintIri },
      output: { oneOf: [{ type: 'object' }, { type: 'null' }] },
      outputDigest: { oneOf: [{ type: 'string', pattern: '^sha256:[0-9a-f]{64}$' }, { type: 'null' }] },
      stderrDigest: { oneOf: [{ type: 'string', pattern: '^sha256:[0-9a-f]{64}$' }, { type: 'null' }] },
    },
  };
}

function artifactEntry(artifacts, relativePath, value) {
  let artifact;
  try {
    artifact = jcsArtifact(value);
  } catch (cause) {
    throw new Error(`${relativePath}: ${cause.message}`, { cause });
  }
  artifacts.set(relativePath, artifact.bytes);
  return { ref: sourceRef(relativePath), digest: artifact.digest };
}

function inputArtifactEntry(artifacts, relativePath, value) {
  const artifact = runtimeInputArtifact(value);
  artifacts.set(relativePath, artifact.bytes);
  return { ref: sourceRef(relativePath), digest: artifact.digest };
}

async function buildCustomReleaseArtifacts() {
  if (process.versions.node !== EXPECTED_NODE_VERSION) {
    throw new Error(`Custom release generator requires Node ${EXPECTED_NODE_VERSION}; found ${process.versions.node}`);
  }
  const artifacts = new Map();
  const definitions = ontologyCustomDefinitions();
  const definitionIris = definitions.map((row) => row.constraintIri);
  const contexts = await customContexts();
  const groupRows = GROUPS.map((group) => ({ group, capabilities: loadGroupCapabilities(group) }));
  const componentIris = groupRows.flatMap(({ group, capabilities }) => capabilities.map(({ row }) => (
    group.groupId === 'identifier' ? row.constraintDefinitionIri : row.constraintIri
  ))).sort(byteCompare);
  const contextIris = [...contexts.keys()].sort(byteCompare);
  const componentIriSet = new Set(componentIris);
  if (componentIriSet.size !== componentIris.length
      || canonicalJcs(componentIris) !== canonicalJcs(definitionIris)) {
    const ontology = new Set(definitionIris);
    throw new Error(
      'Custom component discovery differs from the authoritative ontology inventory: '
        + `missing=${definitionIris.filter((iri) => !componentIriSet.has(iri)).join(',') || 'none'}; `
        + `extra=${componentIris.filter((iri) => !ontology.has(iri)).join(',') || 'none'}; `
        + `duplicateCount=${componentIris.length - componentIriSet.size}`,
    );
  }
  if (canonicalJcs(contextIris) !== canonicalJcs(definitionIris)) {
    const contextOrigins = new Set(contextIris);
    const ontology = new Set(definitionIris);
    throw new Error(
      'Custom projected context origins differ from the authoritative ontology inventory: '
        + `missing=${definitionIris.filter((iri) => !contextOrigins.has(iri)).join(',') || 'none'}; `
        + `extra=${contextIris.filter((iri) => !ontology.has(iri)).join(',') || 'none'}`,
    );
  }
  const contextCount = [...contexts.values()].reduce((sum, rows) => sum + rows.length, 0);

  const runtimeLock = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    runtimeId: 'axiolune-node-custom-release-runtime-v1',
    engine: 'node',
    version: EXPECTED_NODE_VERSION,
    executable: 'node',
    permissionModelRequired: true,
    networkPolicy: 'deny',
    dependencyLock: digestBound('package-lock.json'),
    entrypoints: GROUPS.map((group) => ({
      groupId: group.groupId,
      toolId: group.toolId,
      entrypoint: digestBound(group.entrypointPath),
    })).sort((left, right) => byteCompare(left.toolId, right.toolId)),
  };
  const runtime = artifactEntry(artifacts, RUNTIME_LOCK_PATH, runtimeLock);
  const tools = new Map();
  for (const group of GROUPS) {
    const descriptorPath = `${PROFILE_ROOT}/tools/${group.groupId}.json`;
    const descriptor = {
      schemaVersion: '1.0',
      profileRef: PROFILE_REF,
      groupId: group.groupId,
      toolId: group.toolId,
      version: '0.3.0',
      runtime,
      entrypoint: digestBound(group.entrypointPath),
      componentDiscovery: digestBound(group.discoveryPath),
      implementationArtifacts: implementationArtifacts(group)
        .sort((left, right) => byteCompare(left.ref.path, right.ref.path)),
    };
    tools.set(group.groupId, artifactEntry(artifacts, descriptorPath, descriptor));
  }

  const registryEntries = [];
  for (const { group, capabilities } of groupRows) {
    for (const capability of capabilities) {
      const constraintIri = group.groupId === 'identifier'
        ? capability.row.constraintDefinitionIri : capability.row.constraintIri;
      const key = capabilityKey(constraintIri);
      const directory = `${PROFILE_ROOT}/capabilities/${key}`;
      const contextRows = contexts.get(constraintIri);
      if (!contextRows || contextRows.length === 0) throw new Error(`no Custom contexts for ${constraintIri}`);
      const semanticOwner = semanticRow(group, capability.row, capability.vector);
      const evidence = artifactEntry(
        artifacts,
        `${directory}/evidence.schema.json`,
        evidenceSchema(constraintIri),
      );
      const discovery = artifactEntry(artifacts, `${directory}/discovery.json`, {
        schemaVersion: '1.0',
        profileRef: PROFILE_REF,
        selection: 'explicit-singleton',
        subjectCount: 1,
        subjects: [{
          constraintIri,
          semanticOwner,
          contextCount: contextRows.length,
          contexts: contextRows,
        }],
      });
      const contractCommon = {
        schemaVersion: '1.0',
        profileRef: PROFILE_REF,
        constraintIri,
        protocol: group.inputProtocol,
        subjectDiscoveryComponent: discovery,
        evidenceResultComponent: evidence,
      };
      const inputContract = artifactEntry(artifacts, `${directory}/input-contract.json`, {
        ...contractCommon,
        contractKind: 'input',
        closed: true,
        encoding: 'RFC8785-JCS',
      });
      const outputContract = artifactEntry(artifacts, `${directory}/output-contract.json`, {
        ...contractCommon,
        contractKind: 'output',
        closed: true,
        encoding: 'RFC8785-JCS',
      });
      const categoryRows = {};
      for (const category of CATEGORIES) {
        const inputPath = `${directory}/inputs/${category}.json`;
        const input = inputArtifactEntry(artifacts, inputPath, capability.requests[category]);
        categoryRows[category] = [{
          caseId: `${key}-${category}`,
          category,
          inputRef: input.ref,
          inputDigest: input.digest,
          expected: capability.expectations[category],
        }];
      }
      const testVectors = artifactEntry(artifacts, `${directory}/test-vectors.json`, {
        schemaVersion: '1.0',
        profileRef: PROFILE_REF,
        constraintIri,
        categories: categoryRows,
      });
      const entrypoint = digestBound(group.entrypointPath);
      const capabilityDescriptor = artifactEntry(artifacts, `${directory}/capability.json`, {
        schemaVersion: '1.0',
        profileRef: PROFILE_REF,
        capabilityId: constraintIri,
        constraintIri,
        groupId: group.groupId,
        toolId: group.toolId,
        toolVersion: '0.3.0',
        runtime,
        toolArtifact: tools.get(group.groupId),
        entrypoint,
        inputContract,
        outputContract,
        subjectDiscoveryComponent: discovery,
        evidenceResultComponent: evidence,
        testVectors,
        componentDiscoveryRowDigest: sha256(Buffer.from(canonicalJcs(capability.row), 'utf8')),
        implementationDigest: componentImplementationDigest(group, capability.row),
        semanticOwner,
        contextCount: contextRows.length,
        contextInstanceIds: contextRows.map((row) => row.constraintInstanceId),
      });
      registryEntries.push({
        constraintIri,
        toolId: group.toolId,
        toolVersion: '0.3.0',
        toolArtifactRef: tools.get(group.groupId).ref,
        toolArtifactDigest: tools.get(group.groupId).digest,
        runtimeRef: runtime.ref,
        runtimeDigest: runtime.digest,
        capabilityRef: capabilityDescriptor.ref,
        capabilityDigest: capabilityDescriptor.digest,
        entrypointRef: entrypoint.ref,
        entrypointDigest: entrypoint.digest,
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
  }
  registryEntries.sort((left, right) => byteCompare(left.constraintIri, right.constraintIri));
  const registry = jcsArtifact({ schemaVersion: '1.0', profileRef: PROFILE_REF, entries: registryEntries });
  artifacts.set(REGISTRY_PATH, registry.bytes);
  return Object.freeze({
    artifacts,
    definitionIris: Object.freeze([...definitionIris]),
    registry: registry.value,
    registryBytes: registry.bytes,
    registryDigest: registry.digest,
    definitionCount: registryEntries.length,
    contextCount,
  });
}

module.exports = {
  CATEGORIES,
  CUSTOM_COMPONENT,
  EXPECTED_NODE_VERSION,
  GROUPS,
  PROFILE_REF,
  PROFILE_ROOT,
  REGISTRY_PATH,
  ROOT,
  RUNTIME_LOCK_PATH,
  absolute,
  buildCustomReleaseArtifacts,
  byteCompare,
  capabilityKey,
  componentImplementationDigest,
  groupById,
  loadGroupCapabilities,
  ordersPortfolioExecution,
  ontologyCustomDefinitions,
  readBytes,
  readJcs,
  readJson,
  readRuntimeJcs,
  runtimeJcs,
  sha256,
  sourceRef,
};
