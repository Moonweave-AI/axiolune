#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const YAML = require('yaml');
const {
  CONSTRAINT_BINDINGS,
  CustomConstraintViolation,
  VALIDATORS,
  canonicalJcs,
  constraintDispatchDescriptor,
  iriSetDigest,
  sha256DomainJcs,
  validateConstraint,
} = require('./lib/orders-portfolio-custom-validators.cjs');
const {
  TYPES,
  decodeCanonicalOrdersPortfolioScenario,
  encodeCanonicalOrdersPortfolioScenario,
} = require('./lib/orders-portfolio-canonical-record-adapter.cjs');
const {
  PATHS,
  PENDING_VALIDATOR_EXECUTION,
  PROFILE_REF,
  ROOT,
  compareUtf8,
} = require('./lib/orders-portfolio-custom-profile.cjs');
const {
  buildInputContract,
  buildOutputContract,
} = require('./generate-orders-portfolio-custom-profile.cjs');

const EVIDENCE_NAME = 'orders-portfolio-custom-runtime-evidence.json';
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const TIMEOUT_MS = 1500;
const RECONCILIATION_VALIDATOR_ID =
  'PortfolioPositionReconciliationFindingContract';
let reconciliationBroker = null;
let reconciliationPermissionAssurance = null;
const READ_ALLOWLIST_SPEC = Object.freeze([
  Object.freeze({ file: PATHS.adapter, role: 'adapter' }),
  Object.freeze({ file: PATHS.arithmetic, role: 'arithmetic' }),
  Object.freeze({ file: PATHS.canonicalization, role: 'canonicalization' }),
  Object.freeze({ file: PATHS.implementation, role: 'implementation' }),
  Object.freeze({ file: PATHS.inputContract, role: 'input-contract' }),
  Object.freeze({ file: PATHS.referenceRegistry, role: 'reference-registry' }),
  Object.freeze({ file: PATHS.referenceRegistryImplementation, role: 'reference-registry-implementation' }),
  Object.freeze({ file: PATHS.worker, role: 'worker' }),
]);

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function jcsBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} is not closed: actual=[${actual}] expected=[${wanted}]`);
  }
}

function readStrictJcs(file) {
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(jcsBytes(value))) throw new Error(`${path.relative(ROOT, file)} is not exact RFC 8785 JCS`);
  return { bytes, value };
}

function validateGeneratedContract(file, expectedValue, label) {
  const artifact = readStrictJcs(file);
  const expectedBytes = jcsBytes(expectedValue);
  if (!artifact.bytes.equals(expectedBytes)) throw new Error(`${label} drift from current ontology-derived contract`);
  return artifact;
}

function resolveRef(ref) {
  exactKeys(ref, ['kind', 'path', 'root'], 'ArtifactRef');
  if (ref.kind !== 'path' || ref.root !== 'sourceTree' || typeof ref.path !== 'string'
      || ref.path.includes('\\') || ref.path.startsWith('/') || ref.path.split('/').includes('..')) {
    throw new Error('only sourceTree relative ArtifactRefs are accepted');
  }
  const file = path.resolve(ROOT, ...ref.path.split('/'));
  if (!file.startsWith(`${path.resolve(ROOT)}${path.sep}`)) throw new Error('ArtifactRef escapes sourceTree');
  return file;
}

function moduleInventory() {
  const modules = [
    ['fin-orders-execution', PATHS.ordersModule],
    ['fin-portfolio-positions', PATHS.portfolioModule],
  ];
  const inventory = new Map();
  for (const [moduleId, file] of modules) {
    const document = YAML.parse(fs.readFileSync(file, 'utf8'));
    for (const constraint of Object.values(document.domain?.constraints || {})) {
      if (constraint.expression?.language !== 'Custom') continue;
      const bindings = (document.domain?.constraintBindings || []).filter((row) => (
        row.constraintRef === constraint.iri && row.targetElement === constraint.targetElement
      ));
      inventory.set(constraint.iri, { bindings, constraint, moduleId });
    }
  }
  return inventory;
}

function validateProfile(profile) {
  exactKeys(profile, ['constraints', 'profileRef', 'runtimeId', 'schemaVersion'], 'discovery profile');
  if (profile.schemaVersion !== '1.0' || profile.profileRef !== PROFILE_REF
      || profile.runtimeId !== 'axiolune-orders-portfolio-custom-runtime-v1') {
    throw new Error('Orders/Portfolio Custom profile identity mismatch');
  }
  if (!Array.isArray(profile.constraints) || profile.constraints.length !== 35) {
    throw new Error(`Orders/Portfolio Custom profile requires exactly 35 bindings, got ${profile.constraints?.length}`);
  }
  const authored = moduleInventory();
  if (authored.size !== 35 || Object.keys(CONSTRAINT_BINDINGS).length !== 35 || Object.keys(VALIDATORS).length !== 35) {
    throw new Error(`Custom closure mismatch authored=${authored.size} bindings=${Object.keys(CONSTRAINT_BINDINGS).length} validators=${Object.keys(VALIDATORS).length}`);
  }
  const implementationDigest = sha256(fs.readFileSync(PATHS.implementation));
  const expectedImplementationRef = 'scripts/domain/lib/orders-portfolio-custom-validators.cjs';
  let previous = null;
  const seen = new Set();
  for (const [index, row] of profile.constraints.entries()) {
    exactKeys(row, [
      'adapterDigest', 'adapterRef', 'arithmeticDigest', 'arithmeticRef',
      'constraintIri', 'expressionDigest', 'implementationDigest', 'implementationRef',
      'dispatchDigest',
      'inputContractDigest', 'inputContractRef', 'module', 'outputContractDigest', 'outputContractRef',
      'referenceRegistryDigest', 'referenceRegistryRef',
      'scope', 'targetElement', 'validatorId',
    ], `profile.constraints[${index}]`);
    if (previous !== null && compareUtf8(previous, row.constraintIri) >= 0) throw new Error('profile rows are not strictly IRI-byte sorted');
    previous = row.constraintIri;
    if (seen.has(row.constraintIri)) throw new Error(`duplicate binding ${row.constraintIri}`);
    seen.add(row.constraintIri);
    const actual = authored.get(row.constraintIri);
    if (!actual || actual.moduleId !== row.module || actual.constraint.scope !== row.scope
        || actual.constraint.targetElement !== row.targetElement || actual.bindings.length !== 1) {
      throw new Error(`targetElement/scope/binding closure drift at ${row.constraintIri}`);
    }
    if (row.expressionDigest !== sha256(jcsBytes(actual.constraint.expression))) {
      throw new Error(`expression digest drift at ${row.constraintIri}`);
    }
    exactKeys(row.implementationRef, ['kind', 'path', 'root'], `${row.constraintIri}.implementationRef`);
    if (row.implementationRef.kind !== 'path' || row.implementationRef.root !== 'sourceTree'
        || row.implementationRef.path !== expectedImplementationRef
        || row.implementationDigest !== implementationDigest) {
      throw new Error(`implementation digest/ref drift at ${row.constraintIri}`);
    }
    for (const [prefix, file] of [
      ['adapter', PATHS.adapter],
      ['arithmetic', PATHS.arithmetic],
      ['inputContract', PATHS.inputContract],
      ['outputContract', PATHS.outputContract],
      ['referenceRegistry', PATHS.referenceRegistry],
    ]) {
      exactKeys(row[`${prefix}Ref`], ['kind', 'path', 'root'], `${row.constraintIri}.${prefix}Ref`);
      const expectedPath = path.relative(ROOT, file).split(path.sep).join('/');
      if (row[`${prefix}Ref`].kind !== 'path' || row[`${prefix}Ref`].root !== 'sourceTree'
          || row[`${prefix}Ref`].path !== expectedPath || row[`${prefix}Digest`] !== sha256(fs.readFileSync(file))) {
        throw new Error(`${prefix} digest/ref drift at ${row.constraintIri}`);
      }
    }
    if (CONSTRAINT_BINDINGS[row.constraintIri] !== row.validatorId || typeof VALIDATORS[row.validatorId] !== 'function') {
      throw new Error(`trusted validator binding drift at ${row.constraintIri}`);
    }
    const dispatch = constraintDispatchDescriptor(row.constraintIri);
    if (dispatch.evaluatorId !== row.validatorId || dispatch.dispatchDigest !== row.dispatchDigest) {
      throw new Error(`dispatch descriptor drift at ${row.constraintIri}`);
    }
  }
  if ([...authored.keys()].some((iri) => !seen.has(iri))) throw new Error('profile omits an authored Custom constraint');
  return profile;
}

function validateVectors(vectors, profile) {
  exactKeys(vectors, ['profileRef', 'schemaVersion', 'vectors'], 'vector set');
  if (vectors.schemaVersion !== '1.0' || vectors.profileRef !== PROFILE_REF
      || !Array.isArray(vectors.vectors) || vectors.vectors.length !== 35) {
    throw new Error('Custom test-vector inventory mismatch');
  }
  for (const [index, vector] of vectors.vectors.entries()) {
    exactKeys(
      vector,
      ['accepted', 'constraintIri', 'execution', 'validatorId', 'violation'],
      `vectors[${index}]`,
    );
    const profileRow = profile.constraints[index];
    if (vector.constraintIri !== profileRow.constraintIri || vector.validatorId !== profileRow.validatorId) {
      throw new Error(`vector/profile join drift at ${vector.constraintIri}`);
    }
    exactKeys(vector.accepted, ['caseId', 'expectedOutcome', 'scenario'], `${vector.constraintIri}.accepted`);
    exactKeys(vector.violation, ['caseId', 'expectedCode', 'expectedOutcome', 'scenario'], `${vector.constraintIri}.violation`);
    exactKeys(
      vector.execution,
      ['eligible', 'pendingCode', 'pendingRequirement', 'status'],
      `${vector.constraintIri}.execution`,
    );
    if (vector.accepted.expectedOutcome !== 'accepted' || vector.violation.expectedOutcome !== 'violation'
        || typeof vector.violation.expectedCode !== 'string' || !vector.accepted.scenario || !vector.violation.scenario) {
      throw new Error(`vector polarity/shape drift at ${vector.constraintIri}`);
    }
    const pendingDefinition = PENDING_VALIDATOR_EXECUTION[vector.validatorId] || null;
    const expectedExecution = pendingDefinition
      ? {
        eligible: false,
        pendingCode: pendingDefinition.pendingCode,
        pendingRequirement: pendingDefinition.pendingRequirement,
        status: 'pending',
      }
      : {
        eligible: true,
        pendingCode: null,
        pendingRequirement: null,
        status: 'executable',
      };
    if (canonicalJcs(vector.execution) !== canonicalJcs(expectedExecution)) {
      throw new Error(`vector execution lifecycle drift at ${vector.constraintIri}`);
    }
  }
  return vectors;
}

function verifyClosure(closure) {
  exactKeys(closure, ['artifacts', 'closureDigest', 'profileRef', 'schemaVersion'], 'implementation closure');
  if (closure.schemaVersion !== '1.0' || closure.profileRef !== PROFILE_REF
      || !Array.isArray(closure.artifacts) || closure.artifacts.length !== 20) throw new Error('implementation closure shape mismatch');
  let previous = null;
  for (const row of closure.artifacts) {
    exactKeys(row, ['digest', 'ref', 'role'], 'closure artifact');
    const file = resolveRef(row.ref);
    if (previous !== null && compareUtf8(previous, row.ref.path) >= 0) throw new Error('closure artifacts are not path-sorted');
    previous = row.ref.path;
    if (sha256(fs.readFileSync(file)) !== row.digest) throw new Error(`artifact digest drift for ${row.ref.path}`);
  }
  const actual = sha256(Buffer.concat([
    Buffer.from('axiolune-orders-portfolio-custom-closure-v1\0', 'utf8'),
    jcsBytes(closure.artifacts),
  ]));
  if (closure.closureDigest !== actual) throw new Error('implementation closure join digest drift');
  return closure;
}

function exactRuntimeReadAllowlist(closure) {
  if (READ_ALLOWLIST_SPEC.length !== 8) throw new Error('runtime read allowlist must contain exactly eight files');
  const rowsByRole = new Map(closure.artifacts.map((row) => [row.role, row]));
  const allowlist = READ_ALLOWLIST_SPEC.map(({ file, role }) => {
    const row = rowsByRole.get(role);
    if (!row || resolveRef(row.ref) !== path.resolve(file)) {
      throw new Error(`runtime read allowlist/implementation closure drift for ${role}`);
    }
    return row;
  }).sort((left, right) => compareUtf8(left.ref.path, right.ref.path));
  if (new Set(allowlist.map((row) => row.ref.path)).size !== READ_ALLOWLIST_SPEC.length) {
    throw new Error('runtime read allowlist contains duplicate files');
  }
  return allowlist;
}

function sanitizedEnvironment() {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR']) if (typeof process.env[key] === 'string') env[key] = process.env[key];
  return env;
}

function executeRequest(request, options = {}) {
  const input = jcsBytes(request);
  const inputLimit = options.maxInputBytes || MAX_INPUT_BYTES;
  const outputLimit = options.maxOutputBytes || MAX_OUTPUT_BYTES;
  if (input.length > inputLimit) return { code: 'INPUT_LIMIT', status: 'input-rejected' };
  const result = childProcess.spawnSync(process.execPath, [
    '--permission', '--disable-sigusr1', '--no-addons', '--no-global-search-paths', '--max-old-space-size=64',
    ...READ_ALLOWLIST_SPEC.map(({ file }) => `--allow-fs-read=${file}`),
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
  if (result.status !== 0) return { code: 'WORKER_EXIT', detail: String(result.stderr || '').trim(), status: 'engine-failure' };
  const bytes = Buffer.from(result.stdout || '', 'utf8');
  if (bytes.length > outputLimit) return { code: 'OUTPUT_LIMIT', status: 'output-rejected' };
  let response;
  try { response = JSON.parse(bytes.toString('utf8')); } catch { return { code: 'OUTPUT_PARSE', status: 'engine-failure' }; }
  if (!bytes.equals(jcsBytes(response))) return { code: 'OUTPUT_JCS', status: 'engine-failure' };
  exactKeys(response, ['assurance', 'constraintIri', 'dispatchDigest', 'outcome', 'schemaVersion', 'validatorId', 'violation'], 'worker response');
  const dispatch = constraintDispatchDescriptor(request.constraintIri);
  if (response.schemaVersion !== '1.0' || response.constraintIri !== request.constraintIri
      || response.validatorId !== request.validatorId || dispatch.evaluatorId !== request.validatorId
      || response.dispatchDigest !== dispatch.dispatchDigest) return { code: 'OUTPUT_BINDING', status: 'engine-failure' };
  return { response, status: 'completed' };
}

function loadReconciliationBroker() {
  if (reconciliationBroker) return reconciliationBroker;
  const {
    INPUT_FIXTURE_REL,
    createS5ControlRecordChain,
    verifiedS5ControlRecordChainMaterializationContexts,
  } = require('./lib/s5-control-record-chain.cjs');
  const {
    PORTFOLIO_GRAPH_IRI,
  } = require('./lib/s5-canonical-materialization.cjs');
  const {
    verifyPortfolioReconciliationProjection,
  } = require('./lib/orders-portfolio-reconciliation-evidence.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-reconciliation-evidence-'));
  try {
    const summary = createS5ControlRecordChain(
      { kind: 'path', path: INPUT_FIXTURE_REL, root: 'sourceTree' },
      { buildEvidence: directory, sourceTree: ROOT },
    );
    const context = verifiedS5ControlRecordChainMaterializationContexts(summary)
      .find((candidate) => candidate.targetGraph === PORTFOLIO_GRAPH_IRI);
    if (!context) {
      throw new Error('verified S5 chain omitted the completed Portfolio materialization context');
    }
    const producerInput = readStrictJcs(PATHS.reconciliationProducerInputs).value;
    exactKeys(
      producerInput,
      ['cases', 'producerContract', 'schemaVersion'],
      'portfolio reconciliation producer input inventory',
    );
    const projections = new Map(producerInput.cases.map((row) => [
      row.caseId,
      verifyPortfolioReconciliationProjection(context, row.caseId),
    ]));
    reconciliationBroker = Object.freeze({ projections });
    return reconciliationBroker;
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

function actualWorkerAssurance(request) {
  if (reconciliationPermissionAssurance) return reconciliationPermissionAssurance;
  const workerBoundary = executeRequest(request);
  if (workerBoundary.status !== 'completed' || !workerBoundary.response?.assurance) {
    throw new Error(
      `reconciliation worker assurance probe failed: ${workerBoundary.status}/${workerBoundary.code || 'missing-response'}`,
    );
  }
  reconciliationPermissionAssurance = Object.freeze({
    ...workerBoundary.response.assurance,
  });
  return reconciliationPermissionAssurance;
}

function executeRequestWithReconciliationEvidence(request, caseId = 'baseline') {
  try {
    exactKeys(
      request,
      ['constraintIri', 'scenario', 'schemaVersion', 'validatorId'],
      'reconciliation evidence request',
    );
    if (request.schemaVersion !== '1.0'
        || request.validatorId !== RECONCILIATION_VALIDATOR_ID) {
      throw new TypeError('reconciliation evidence request identity is invalid');
    }
    const dispatch = constraintDispatchDescriptor(request.constraintIri);
    if (dispatch.evaluatorId !== request.validatorId) {
      throw new TypeError('reconciliation constraint/evaluator binding is invalid');
    }
    const inputContract = readStrictJcs(PATHS.inputContract).value;
    const normalizedScenario = decodeCanonicalOrdersPortfolioScenario(
      request.scenario,
      request.validatorId,
      inputContract,
    );
    const projection = loadReconciliationBroker().projections.get(caseId);
    if (!projection) throw new Error(`unknown reconciliation producer projection case ${caseId}`);
    let outcome = 'accepted';
    let violation = null;
    try {
      validateConstraint(
        request.constraintIri,
        request.validatorId,
        normalizedScenario,
        { portfolioCandidateProjection: projection },
      );
    } catch (cause) {
      if (!(cause instanceof CustomConstraintViolation)) throw cause;
      outcome = 'violation';
      violation = cause.code;
    }
    return {
      response: {
        assurance: actualWorkerAssurance(request),
        constraintIri: request.constraintIri,
        dispatchDigest: dispatch.dispatchDigest,
        outcome,
        schemaVersion: '1.0',
        validatorId: request.validatorId,
        violation,
      },
      status: 'completed',
    };
  } catch (cause) {
    return {
      code: 'RECONCILIATION_EVIDENCE_BROKER_EXIT',
      detail: cause?.code || cause?.message || String(cause),
      status: 'engine-failure',
    };
  }
}

function createEvidence(options = {}) {
  const profileArtifact = readStrictJcs(PATHS.discovery);
  const vectorArtifact = readStrictJcs(PATHS.vectors);
  const closureArtifact = readStrictJcs(PATHS.closure);
  const inputContractArtifact = validateGeneratedContract(PATHS.inputContract, buildInputContract(), 'input contract');
  const outputContractArtifact = validateGeneratedContract(PATHS.outputContract, buildOutputContract(), 'output contract');
  const profile = validateProfile(options.profileOverride || profileArtifact.value);
  const vectors = validateVectors(options.vectorOverride || vectorArtifact.value, profile);
  const closure = verifyClosure(closureArtifact.value);
  const exactReadAllowlist = exactRuntimeReadAllowlist(closure);
  const results = [];
  let permissionAssurance = null;
  for (const vector of vectors.vectors) {
    const acceptedRequest = {
      constraintIri: vector.constraintIri, scenario: vector.accepted.scenario,
      schemaVersion: '1.0', validatorId: vector.validatorId,
    };
    const accepted = vector.validatorId === RECONCILIATION_VALIDATOR_ID
      ? executeRequestWithReconciliationEvidence(acceptedRequest, 'baseline')
      : executeRequest(acceptedRequest);
    permissionAssurance = permissionAssurance || accepted.response?.assurance || null;
    if (vector.execution.status === 'pending') {
      if (accepted.status !== 'completed'
          || accepted.response.outcome !== 'violation'
          || accepted.response.violation !== vector.execution.pendingCode) {
        throw new Error(
          `${vector.constraintIri} pending accepted-oracle vector did not fail closed: `
            + `${accepted.status}/${accepted.response?.violation}`,
        );
      }
      results.push({
        actual: accepted.response.violation,
        caseId: vector.accepted.caseId,
        category: 'accepted',
        constraintIri: vector.constraintIri,
        expected: vector.execution.pendingCode,
        status: 'pending',
        validatorId: vector.validatorId,
      });
    } else {
      if (accepted.status !== 'completed' || accepted.response.outcome !== 'accepted'
          || accepted.response.violation !== null) {
        throw new Error(`${vector.constraintIri} accepted vector failed`);
      }
      results.push({ actual: 'accepted', caseId: vector.accepted.caseId, category: 'accepted', constraintIri: vector.constraintIri, expected: 'accepted', status: 'passed', validatorId: vector.validatorId });
    }

    const violation = executeRequest({
      constraintIri: vector.constraintIri, scenario: vector.violation.scenario,
      schemaVersion: '1.0', validatorId: vector.validatorId,
    });
    const expectedViolation = vector.execution.status === 'pending'
      ? vector.execution.pendingCode
      : vector.violation.expectedCode;
    if (violation.status !== 'completed' || violation.response.outcome !== 'violation'
        || violation.response.violation !== expectedViolation) {
      throw new Error(`${vector.constraintIri} violation vector failed: ${violation.status}/${violation.response?.violation}`);
    }
    results.push({
      actual: violation.response.violation,
      caseId: vector.violation.caseId,
      category: 'violation',
      constraintIri: vector.constraintIri,
      expected: expectedViolation,
      status: vector.execution.status === 'pending' ? 'pending' : 'passed',
      validatorId: vector.validatorId,
    });
  }

  const valuationVector = vectors.vectors.find((row) => row.validatorId === 'PositionValuationContract');
  const valuationDefinitionVector = vectors.vectors.find(
    (row) => row.validatorId === 'ValuationCalculationDefinitionContract',
  );
  if (!valuationVector || !valuationDefinitionVector) {
    throw new Error('valuation semantic-boundary seeds are missing');
  }
  const valuationLegacy = decodeCanonicalOrdersPortfolioScenario(
    valuationVector.accepted.scenario,
    valuationVector.validatorId,
    inputContractArtifact.value,
  );
  const encodedValuation = (mutate) => {
    const legacy = structuredClone(valuationLegacy);
    mutate(legacy);
    return encodeCanonicalOrdersPortfolioScenario(valuationVector.validatorId, legacy);
  };
  const contextPayload = {
    completedAt: '2025-01-01T00:00:00Z',
    contextId: 'fx-input-1',
    schemaVersion: '1.0',
    status: 'completed',
  };
  const fxContext = {
    digest: sha256(jcsBytes(contextPayload)),
    payload: contextPayload,
    ref: 'https://axiolune.ai/contexts/fx-input/1',
  };
  const crossCurrency = (direction) => encodedValuation((legacy) => {
    legacy.priceCurrency = direction === 'baseToQuote' ? 'USD' : 'EUR';
    legacy.reportingCurrency = direction === 'baseToQuote' ? 'EUR' : 'USD';
    legacy.marketValueMicros = direction === 'baseToQuote' ? 12_000_000 : 3_000_000;
    legacy.fx = {
      baseCurrency: 'USD',
      direction,
      inputContext: structuredClone(fxContext),
      inputCurrency: direction === 'baseToQuote' ? 'USD' : 'EUR',
      outputCurrency: direction === 'baseToQuote' ? 'EUR' : 'USD',
      quoteCurrency: 'EUR',
      ratePpm: 2_000_000,
    };
  });
  const subMicroCorrect = encodedValuation((legacy) => {
    legacy.quantityMicros = 2;
    legacy.priceMicros = 3;
    legacy.marketValueMicros = 0;
  });
  const formerScaleError = encodedValuation((legacy) => {
    legacy.quantityMicros = 2;
    legacy.priceMicros = 3;
    legacy.marketValueMicros = 6;
  });
  const highIntermediate = encodedValuation((legacy) => {
    legacy.quantityMicros = 3_000_000_001;
    legacy.priceMicros = 3_000_000_001;
    legacy.marketValueMicros = 9_000_000_006_000;
  });
  const halfEvenTie = encodedValuation((legacy) => {
    legacy.quantityMicros = 1;
    legacy.priceMicros = 500_000;
    legacy.marketValueMicros = 0;
  });
  const halfUpReplay = structuredClone(halfEvenTie);
  const halfUpDefinition = halfUpReplay.records.find((row) => row.typeIri === TYPES.ValuationCalculationDefinition);
  const halfUpArtifact = halfUpReplay.artifacts.find((row) => row.artifactRef.iri === halfUpDefinition.roundingPolicyRef);
  halfUpArtifact.payload.mode = 'half-up';
  halfUpArtifact.artifactDigest = sha256(jcsBytes(halfUpArtifact.payload));
  halfUpDefinition.roundingPolicyDigest = halfUpArtifact.artifactDigest;

  const baseCross = crossCurrency('baseToQuote');
  const fxInputSubstitution = structuredClone(baseCross);
  fxInputSubstitution.records.find((row) => row.typeIri === TYPES.FXConversion).inputMoney.amount = '5.000000';
  const fxRateSubstitution = structuredClone(baseCross);
  fxRateSubstitution.records.find((row) => row.typeIri === TYPES.FXRateObservation).fxRate.numericValue = '3.000000';
  const fxRateUnitSubstitution = structuredClone(baseCross);
  fxRateUnitSubstitution.records.find(
    (row) => row.typeIri === TYPES.FXRateObservation,
  ).fxRate.unit = 'https://axiolune.ai/units/USD-per-EUR';
  const fxReverseLink = structuredClone(baseCross);
  fxReverseLink.records.find((row) => row.typeIri === TYPES.FXConversion).conversionValuationLine =
    'https://axiolune.ai/data/valuation/other/version/0';
  const fxFutureRate = structuredClone(baseCross);
  fxFutureRate.records.find((row) => row.typeIri === TYPES.FXRateObservation).availableFrom = '2025-01-02T00:00:00Z';
  const fxNanosecondFutureRate = structuredClone(baseCross);
  fxNanosecondFutureRate.records.find((row) => row.versionIri === fxNanosecondFutureRate.focusVersionIri).availableFrom =
    '2025-01-01T00:00:02.000000001Z';
  fxNanosecondFutureRate.records.find((row) => row.typeIri === TYPES.FXRateObservation).availableFrom =
    '2025-01-01T00:00:02.000000002Z';
  const fxNanosecondPriorRate = structuredClone(baseCross);
  fxNanosecondPriorRate.records.find((row) => row.versionIri === fxNanosecondPriorRate.focusVersionIri).availableFrom =
    '2025-01-01T00:00:02.000000002Z';
  fxNanosecondPriorRate.records.find((row) => row.typeIri === TYPES.FXRateObservation).availableFrom =
    '2025-01-01T00:00:02.000000001Z';
  const fxLateContext = structuredClone(baseCross);
  const lateFx = fxLateContext.records.find((row) => row.typeIri === TYPES.FXConversion);
  const lateContextArtifact = fxLateContext.artifacts.find((row) => row.artifactRef.iri === lateFx.inputContextRef);
  lateContextArtifact.payload.completedAt = '2025-01-02T00:00:00Z';
  lateContextArtifact.artifactDigest = sha256(jcsBytes(lateContextArtifact.payload));
  lateFx.inputContextRecordDigest = lateContextArtifact.artifactDigest;
  const fxNanosecondLateContext = structuredClone(baseCross);
  fxNanosecondLateContext.records.find(
    (row) => row.versionIri === fxNanosecondLateContext.focusVersionIri,
  ).availableFrom = '2025-01-01T00:00:02.000000001Z';
  const nanosecondLateFx = fxNanosecondLateContext.records.find((row) => row.typeIri === TYPES.FXConversion);
  const nanosecondLateContextArtifact = fxNanosecondLateContext.artifacts.find(
    (row) => row.artifactRef.iri === nanosecondLateFx.inputContextRef,
  );
  nanosecondLateContextArtifact.payload.completedAt = '2025-01-01T00:00:02.000000002Z';
  nanosecondLateContextArtifact.artifactDigest = sha256(jcsBytes(nanosecondLateContextArtifact.payload));
  nanosecondLateFx.inputContextRecordDigest = nanosecondLateContextArtifact.artifactDigest;
  const policyDigestTamper = structuredClone(baseCross);
  const tamperedDefinition = policyDigestTamper.records.find((row) => row.typeIri === TYPES.ValuationCalculationDefinition);
  policyDigestTamper.artifacts.find((row) => row.artifactRef.iri === tamperedDefinition.precisionPolicyRef).payload.amountScale = 5;
  const quotationInstrumentSubstitution = encodedValuation(() => {});
  quotationInstrumentSubstitution.records.find(
    (row) => row.typeIri === TYPES.DirectUnitPriceQuotationContract,
  ).quotationInstrument = 'https://axiolune.ai/data/instrument/runtime-other';
  const listingInstrumentSubstitution = encodedValuation(() => {});
  listingInstrumentSubstitution.records.find(
    (row) => row.typeIri === TYPES.InstrumentListing,
  ).listedInstrument = 'https://axiolune.ai/data/instrument/runtime-other/version/0';
  const quotationContextSubstitution = encodedValuation(() => {});
  const firstValuationListing = quotationContextSubstitution.records.find(
    (row) => row.typeIri === TYPES.InstrumentListing,
  );
  const secondValuationListing = structuredClone(firstValuationListing);
  secondValuationListing.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/valuation-listing/other';
  secondValuationListing.versionIri =
    'https://axiolune.ai/data/valuation-market-context/other/version/0';
  quotationContextSubstitution.records.push(secondValuationListing);
  quotationContextSubstitution.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  quotationContextSubstitution.records.find(
    (row) => row.typeIri === TYPES.DirectUnitPriceQuotationContract,
  ).quotationListingContext = secondValuationListing.versionIri;
  const valuationMembershipSubstitution = encodedValuation(() => {});
  valuationMembershipSubstitution.records.find(
    (row) => row.typeIri === TYPES.PortfolioAccountMembership,
  ).memberAccount = 'https://axiolune.ai/data/account/runtime-other';
  const otcValuation = encodedValuation((legacy) => {
    legacy.contextKind = 'otc';
  });
  const quotationSubstitution = structuredClone(baseCross);
  const quotationSubstitutionDefinition = quotationSubstitution.records.find(
    (row) => row.typeIri === TYPES.ValuationCalculationDefinition,
  );
  quotationSubstitutionDefinition.valuationDefinitionQuotationContract =
    ['https://axiolune.ai/data/quotation/other/version/0'];
  quotationSubstitutionDefinition.valuationQuotationContractVersionSetDigest =
    iriSetDigest(quotationSubstitutionDefinition.valuationDefinitionQuotationContract);

  const pluralQuotationMembership = encodedValuation(() => {});
  const pluralDefinition = pluralQuotationMembership.records.find(
    (row) => row.typeIri === TYPES.ValuationCalculationDefinition,
  );
  const pluralPrice = pluralQuotationMembership.records.find(
    (row) => row.typeIri === TYPES.PriceObservation,
  );
  const firstQuotation = pluralQuotationMembership.records.find(
    (row) => row.typeIri === TYPES.DirectUnitPriceQuotationContract,
  );
  const secondQuotation = structuredClone(firstQuotation);
  secondQuotation.versionIri = 'https://axiolune.ai/data/quotation/2/version/0';
  secondQuotation.source = 'https://axiolune.ai/sources/orders-portfolio-custom/quotation/2';
  pluralQuotationMembership.records.push(secondQuotation);
  pluralDefinition.valuationDefinitionQuotationContract = [
    firstQuotation.versionIri,
    secondQuotation.versionIri,
  ];
  pluralDefinition.valuationQuotationContractCount = 2;
  pluralDefinition.valuationQuotationContractVersionSetDigest =
    iriSetDigest(pluralDefinition.valuationDefinitionQuotationContract);
  pluralPrice.quotationContract = secondQuotation.versionIri;

  const definitionClosureScenario = (mutate) => {
    const scenario = structuredClone(valuationDefinitionVector.accepted.scenario);
    const firstQuotationRecord = scenario.records.find(
      (row) => row.typeIri === TYPES.DirectUnitPriceQuotationContract,
    );
    if (!firstQuotationRecord) {
      throw new Error('valuation definition quotation record is missing');
    }
    const secondQuotationRecord = structuredClone(firstQuotationRecord);
    secondQuotationRecord.source =
      'https://axiolune.ai/sources/orders-portfolio-custom/quotation/2';
    secondQuotationRecord.versionIri =
      'https://axiolune.ai/data/quotation/2/version/0';
    scenario.records.push(secondQuotationRecord);
    scenario.records.sort((left, right) => compareUtf8(left.versionIri, right.versionIri));
    const definition = scenario.records.find(
      (row) => row.versionIri === scenario.focusVersionIri,
    );
    mutate(definition);
    return scenario;
  };
  const firstDefinitionQuotation =
    'https://axiolune.ai/data/quotation/1/version/0';
  const secondDefinitionQuotation =
    'https://axiolune.ai/data/quotation/2/version/0';
  const pluralDefinitionClosure = definitionClosureScenario((definition) => {
    definition.valuationDefinitionQuotationContract = [
      firstDefinitionQuotation,
      secondDefinitionQuotation,
    ];
    definition.valuationQuotationContractCount = 2;
    definition.valuationQuotationContractVersionSetDigest =
      iriSetDigest(definition.valuationDefinitionQuotationContract);
  });
  const definitionCountMismatch = definitionClosureScenario((definition) => {
    definition.valuationQuotationContractCount = 2;
  });
  const definitionDigestMismatch = definitionClosureScenario((definition) => {
    definition.valuationQuotationContractVersionSetDigest = `sha256:${'0'.repeat(64)}`;
  });
  const definitionUnsortedSet = definitionClosureScenario((definition) => {
    definition.valuationDefinitionQuotationContract = [
      secondDefinitionQuotation,
      firstDefinitionQuotation,
    ];
    definition.valuationQuotationContractCount = 2;
    definition.valuationQuotationContractVersionSetDigest =
      iriSetDigest(definition.valuationDefinitionQuotationContract);
  });
  const definitionDuplicateMember = definitionClosureScenario((definition) => {
    definition.valuationDefinitionQuotationContract = [
      firstDefinitionQuotation,
      firstDefinitionQuotation,
    ];
    definition.valuationQuotationContractCount = 2;
  });
  const definitionEmptySet = definitionClosureScenario((definition) => {
    definition.valuationDefinitionQuotationContract = [];
    definition.valuationQuotationContractCount = 0;
    definition.valuationQuotationContractVersionSetDigest = iriSetDigest([]);
  });
  const definitionLogicalMember = definitionClosureScenario((definition) => {
    definition.valuationDefinitionQuotationContract =
      ['https://axiolune.ai/data/quotation/1'];
    definition.valuationQuotationContractCount = 1;
    definition.valuationQuotationContractVersionSetDigest =
      iriSetDigest(definition.valuationDefinitionQuotationContract);
  });

  const semanticCases = [
    ['sub-micro-half-even', subMicroCorrect, 'accepted', null],
    ['former-million-times-result', formerScaleError, 'violation', 'POSITION_VALUATION_ARITHMETIC'],
    ['bigint-high-intermediate', highIntermediate, 'accepted', null],
    ['half-even-tie', halfEvenTie, 'accepted', null],
    ['half-up-policy-replay', halfUpReplay, 'violation', 'POSITION_VALUATION_ARITHMETIC'],
    ['fx-base-to-quote', baseCross, 'accepted', null],
    ['fx-quote-to-base', crossCurrency('quoteToBase'), 'accepted', null],
    ['fx-input-substitution', fxInputSubstitution, 'violation', 'POSITION_VALUATION_FX'],
    ['fx-rate-substitution', fxRateSubstitution, 'violation', 'POSITION_VALUATION_ARITHMETIC'],
    ['fx-rate-unit-substitution', fxRateUnitSubstitution, 'violation', 'POSITION_VALUATION_FX'],
    ['fx-reverse-link', fxReverseLink, 'violation', 'POSITION_VALUATION_FX'],
    ['fx-future-rate', fxFutureRate, 'violation', 'POSITION_VALUATION_FX'],
    ['fx-nanosecond-future-rate', fxNanosecondFutureRate, 'violation', 'POSITION_VALUATION_FX'],
    ['fx-nanosecond-prior-rate', fxNanosecondPriorRate, 'accepted', null],
    ['fx-late-input-context', fxLateContext, 'violation', 'POSITION_VALUATION_FX'],
    ['fx-nanosecond-late-input-context', fxNanosecondLateContext, 'violation', 'POSITION_VALUATION_FX'],
    ['definition-quotation-plural-second-member', pluralQuotationMembership, 'accepted', null],
    ['definition-quotation-substitution', quotationSubstitution, 'violation', 'POSITION_VALUATION_DEFINITION'],
    ['policy-payload-digest-tamper', policyDigestTamper, 'engine-failure', 'WORKER_EXIT'],
    ['valuation-quotation-instrument-substitution', quotationInstrumentSubstitution, 'violation', 'POSITION_VALUATION_JOIN'],
    ['valuation-listing-instrument-substitution', listingInstrumentSubstitution, 'violation', 'POSITION_VALUATION_JOIN'],
    ['valuation-quotation-context-substitution', quotationContextSubstitution, 'violation', 'POSITION_VALUATION_JOIN'],
    ['valuation-membership-account-substitution', valuationMembershipSubstitution, 'violation', 'POSITION_VALUATION_JOIN'],
    ['valuation-otc-context', otcValuation, 'accepted', null],
    ['valuation-definition-quotation-plural', pluralDefinitionClosure, 'accepted', null, valuationDefinitionVector],
    ['valuation-definition-quotation-count-mismatch', definitionCountMismatch, 'violation', 'VALUATION_DEFINITION_QUOTATION_SET', valuationDefinitionVector],
    ['valuation-definition-quotation-digest-mismatch', definitionDigestMismatch, 'violation', 'VALUATION_DEFINITION_QUOTATION_SET', valuationDefinitionVector],
    ['valuation-definition-quotation-unsorted', definitionUnsortedSet, 'violation', 'VALUATION_DEFINITION_QUOTATION_SET', valuationDefinitionVector],
    ['valuation-definition-quotation-duplicate', definitionDuplicateMember, 'violation', 'VALUATION_DEFINITION_QUOTATION_SET', valuationDefinitionVector],
    ['valuation-definition-quotation-empty', definitionEmptySet, 'engine-failure', 'WORKER_EXIT', valuationDefinitionVector, 'orders-portfolio-canonical-cardinality'],
    ['valuation-definition-quotation-logical-member', definitionLogicalMember, 'engine-failure', 'WORKER_EXIT', valuationDefinitionVector, 'orders-portfolio-canonical-reference-mode'],
  ];

  const integrityVector = vectors.vectors.find(
    (row) => row.validatorId === 'OrderEventIntegrityFindingContract',
  );
  if (!integrityVector) throw new Error('OrderEventIntegrityFinding semantic-boundary seed is missing');
  const integrityLegacy = decodeCanonicalOrdersPortfolioScenario(
    integrityVector.accepted.scenario,
    integrityVector.validatorId,
    inputContractArtifact.value,
  );
  const encodedIntegrity = (kind, findingSubject, extras = {}) => (
    encodeCanonicalOrdersPortfolioScenario(integrityVector.validatorId, {
      findingSubject: structuredClone(findingSubject),
      generatingContextRef: integrityLegacy.generatingContextRef,
      kind,
      stream: structuredClone(integrityLegacy.stream),
      temporal: structuredClone(integrityLegacy.temporal),
      ...structuredClone(extras),
    })
  );
  const integrityBranches = {
    duplicateConflict: encodedIntegrity(
      'duplicateConflict',
      { providerEventId: 'runtime-duplicate-provider-event-1' },
    ),
    lateFill: encodedIntegrity('lateFill', {
      fillVersionIri: 'https://axiolune.ai/data/execution/runtime-late/version/0',
      terminalEventVersionIri:
        'https://axiolune.ai/data/event/runtime-terminal/version/0',
    }),
    missingAcknowledgement: encodedIntegrity('missingAcknowledgement', {
      expectedAfterKey: 3,
      externalOrderVersionIri:
        'https://axiolune.ai/data/external-order/runtime-missing-ack/version/0',
    }),
    outOfOrder: encodedIntegrity(
      'outOfOrder',
      { observedKey: 2, requiredPredecessorKey: 5 },
    ),
    sequenceGap: encodedIntegrity(
      'sequenceGap',
      { missingFrom: 2, missingTo: 4 },
    ),
    transitionViolation: encodedIntegrity('transitionViolation', {
      fromEventVersionIri:
        'https://axiolune.ai/data/event/runtime-transition-from/version/0',
      toEventVersionIri:
        'https://axiolune.ai/data/event/runtime-transition-to/version/0',
      transitionProfileVersionIri:
        'https://axiolune.ai/data/transition-profile/runtime-finding/version/0',
    }),
  };
  const integrityAffectedDigest = structuredClone(integrityBranches.sequenceGap);
  integrityAffectedDigest.records.find(
    (row) => row.versionIri === integrityAffectedDigest.focusVersionIri,
  ).affectedKeyDigest = `sha256:${'0'.repeat(64)}`;
  const integrityMixedBranch = structuredClone(integrityBranches.sequenceGap);
  integrityMixedBranch.records.find(
    (row) => row.versionIri === integrityMixedBranch.focusVersionIri,
  ).observedSourceOrderKey = 2;
  const integrityRelatedDigest = structuredClone(integrityBranches.outOfOrder);
  integrityRelatedDigest.records.find(
    (row) => row.versionIri === integrityRelatedDigest.focusVersionIri,
  ).relatedVersionSetDigest = `sha256:${'0'.repeat(64)}`;
  const integrityIdenticalRetry = encodedIntegrity(
    'duplicateConflict',
    { providerEventId: 'runtime-identical-retry-1' },
    {
      relatedLifecycleEvents: [
        {
          kind: 'Accepted',
          lifecycleState: 'Accepted',
          providerEventId: 'runtime-identical-retry-1',
          sourceOrderKey: 1,
          versionIri:
            'https://axiolune.ai/data/event/runtime-identical-retry-a/version/0',
        },
        {
          kind: 'Accepted',
          lifecycleState: 'Accepted',
          providerEventId: 'runtime-identical-retry-1',
          sourceOrderKey: 1,
          versionIri:
            'https://axiolune.ai/data/event/runtime-identical-retry-b/version/0',
        },
      ],
    },
  );
  const integrityAllowedTransition = structuredClone(
    integrityBranches.transitionViolation,
  );
  const integrityTransitionProfile = integrityAllowedTransition.records.find(
    (row) => row.typeIri === TYPES.OrderTransitionProfile,
  );
  const integrityTransitionInput = integrityAllowedTransition.artifacts.find(
    (row) => row.artifactDigest === integrityTransitionProfile.inputContractDigest,
  );
  integrityTransitionInput.payload.allowedTransitions.Accepted = ['Canceled'];
  integrityTransitionInput.artifactDigest = sha256(jcsBytes(integrityTransitionInput.payload));
  integrityTransitionProfile.inputContractDigest = integrityTransitionInput.artifactDigest;
  semanticCases.push(
    ['integrity-duplicate-conflict', integrityBranches.duplicateConflict, 'accepted', null, integrityVector],
    ['integrity-sequence-gap', integrityBranches.sequenceGap, 'accepted', null, integrityVector],
    ['integrity-out-of-order', integrityBranches.outOfOrder, 'accepted', null, integrityVector],
    ['integrity-late-fill', integrityBranches.lateFill, 'accepted', null, integrityVector],
    ['integrity-missing-acknowledgement', integrityBranches.missingAcknowledgement, 'accepted', null, integrityVector],
    ['integrity-transition-violation', integrityBranches.transitionViolation, 'accepted', null, integrityVector],
    ['integrity-affected-digest-substitution', integrityAffectedDigest, 'violation', 'FINDING_AFFECTED_DIGEST', integrityVector],
    ['integrity-mixed-branch-fields', integrityMixedBranch, 'violation', 'FINDING_SEQUENCE_GAP', integrityVector],
    ['integrity-related-set-digest-substitution', integrityRelatedDigest, 'violation', 'FINDING_RELATED_DIGEST', integrityVector],
    ['integrity-identical-retry-not-conflict', integrityIdenticalRetry, 'violation', 'FINDING_DUPLICATE_CONFLICT', integrityVector],
    ['integrity-profile-allows-transition', integrityAllowedTransition, 'violation', 'FINDING_TRANSITION_VIOLATION', integrityVector],
  );

  const membershipClosureVector = vectors.vectors.find(
    (row) => row.validatorId === 'PortfolioAccountMembershipClosureContract',
  );
  if (!membershipClosureVector) {
    throw new Error('PortfolioAccountMembershipClosure semantic-boundary seed is missing');
  }
  const membershipClosureBase = membershipClosureVector.accepted.scenario;
  const addMembershipRecord = (scenario, options = {}) => {
    const seedMembership = scenario.records.find(
      (row) => row.typeIri === TYPES.PortfolioAccountMembership,
    );
    if (!seedMembership) throw new Error('membership closure seed record is missing');
    const added = structuredClone(seedMembership);
    added.memberAccount = options.memberAccount
      || 'https://axiolune.ai/data/account/runtime-extra';
    added.membershipId = options.membershipId || 'runtime-extra-membership';
    added.versionIri = options.versionIri
      || 'https://axiolune.ai/data/membership/runtime-extra/version/0';
    if (options.availableFrom) added.availableFrom = options.availableFrom;
    if (options.knowledgeFrom) added.knowledgeFrom = options.knowledgeFrom;
    if (options.validFrom) added.validFrom = options.validFrom;
    scenario.records.push(added);
    scenario.records.sort((left, right) => compareUtf8(left.versionIri, right.versionIri));
  };
  const membershipClosureOmission = structuredClone(membershipClosureBase);
  addMembershipRecord(membershipClosureOmission);
  const membershipClosureFutureCandidate = structuredClone(membershipClosureBase);
  addMembershipRecord(membershipClosureFutureCandidate, {
    availableFrom: '2025-01-01T00:00:03Z',
    knowledgeFrom: '2025-01-01T00:00:03Z',
    validFrom: '2025-01-01T00:00:03Z',
  });
  const membershipClosureProbeSubstitution = structuredClone(membershipClosureBase);
  const membershipClosureProbeRecord = membershipClosureProbeSubstitution.records.find(
    (row) => row.versionIri === membershipClosureProbeSubstitution.focusVersionIri,
  );
  const membershipClosureProbeArtifact = membershipClosureProbeSubstitution.artifacts.find(
    (row) => row.artifactRef.iri === membershipClosureProbeRecord.membershipClosureProbeRef,
  );
  membershipClosureProbeArtifact.payload.membershipCount += 1;
  membershipClosureProbeArtifact.artifactDigest = sha256(jcsBytes(
    membershipClosureProbeArtifact.payload,
  ));
  membershipClosureProbeRecord.membershipClosureProbeDigest =
    membershipClosureProbeArtifact.artifactDigest;
  const membershipClosureLateInput = structuredClone(membershipClosureBase);
  const membershipClosureLateInputRecord = membershipClosureLateInput.records.find(
    (row) => row.versionIri === membershipClosureLateInput.focusVersionIri,
  );
  const membershipClosureLateInputArtifact = membershipClosureLateInput.artifacts.find(
    (row) => row.artifactRef.iri === membershipClosureLateInputRecord.inputContextRef,
  );
  membershipClosureLateInputArtifact.payload.completedAt =
    membershipClosureLateInputRecord.availableFrom;
  membershipClosureLateInputArtifact.artifactDigest = sha256(jcsBytes(
    membershipClosureLateInputArtifact.payload,
  ));
  membershipClosureLateInputRecord.inputContextRecordDigest =
    membershipClosureLateInputArtifact.artifactDigest;
  const membershipClosureFuturePit = structuredClone(membershipClosureBase);
  const membershipClosureFuturePitRecord = membershipClosureFuturePit.records.find(
    (row) => row.versionIri === membershipClosureFuturePit.focusVersionIri,
  );
  const membershipClosureFuturePitArtifact = membershipClosureFuturePit.artifacts.find(
    (row) => row.artifactRef.iri === membershipClosureFuturePitRecord.pitRequestRef,
  );
  membershipClosureFuturePitArtifact.payload.availableAt =
    '2025-01-01T00:00:03Z';
  membershipClosureFuturePitArtifact.artifactDigest = sha256(jcsBytes(
    membershipClosureFuturePitArtifact.payload,
  ));
  membershipClosureFuturePitRecord.pitRequestRecordDigest =
    membershipClosureFuturePitArtifact.artifactDigest;
  semanticCases.push(
    ['membership-closure-omitted-eligible-member', membershipClosureOmission, 'violation', 'MEMBERSHIP_CLOSURE_COMPLETENESS', membershipClosureVector],
    ['membership-closure-future-member-not-eligible', membershipClosureFutureCandidate, 'accepted', null, membershipClosureVector],
    ['membership-closure-probe-semantic-substitution', membershipClosureProbeSubstitution, 'violation', 'MEMBERSHIP_CLOSURE_PROBE', membershipClosureVector],
    ['membership-closure-late-input-context', membershipClosureLateInput, 'violation', 'MEMBERSHIP_CLOSURE_INPUT', membershipClosureVector],
    ['membership-closure-future-pit-pivot', membershipClosureFuturePit, 'violation', 'MEMBERSHIP_CLOSURE_PIT', membershipClosureVector],
  );

  const portfolioValuationVector = vectors.vectors.find(
    (row) => row.validatorId === 'PortfolioValuationContract',
  );
  if (!portfolioValuationVector) {
    throw new Error('PortfolioValuation semantic-boundary seed is missing');
  }
  const portfolioValuationBase = portfolioValuationVector.accepted.scenario;
  const portfolioValuationLegacy = decodeCanonicalOrdersPortfolioScenario(
    portfolioValuationBase,
    portfolioValuationVector.validatorId,
    inputContractArtifact.value,
  );
  const encodedPortfolioValuation = (mutate) => {
    const legacy = structuredClone(portfolioValuationLegacy);
    mutate(legacy);
    return encodeCanonicalOrdersPortfolioScenario(
      portfolioValuationVector.validatorId,
      legacy,
    );
  };
  const portfolioValuationMissingInputBytes = structuredClone(portfolioValuationBase);
  portfolioValuationMissingInputBytes.records.find(
    (row) => row.versionIri === portfolioValuationMissingInputBytes.focusVersionIri,
  ).inputContextRecordDigest = `sha256:${'1'.repeat(64)}`;
  const portfolioValuationLateInput = encodedPortfolioValuation((legacy) => {
    legacy.inputContext.payload.completedAt = legacy.temporal.availableFrom;
    legacy.inputContext.digest = sha256(jcsBytes(legacy.inputContext.payload));
  });
  const portfolioValuationLateConversion = encodedPortfolioValuation((legacy) => {
    legacy.conversionContext.payload.completedAt = legacy.temporal.availableFrom;
    legacy.conversionContext.digest = sha256(jcsBytes(
      legacy.conversionContext.payload,
    ));
  });
  const portfolioValuationFuturePit = encodedPortfolioValuation((legacy) => {
    legacy.pitRequest.payload.availableAt = '2025-01-01T00:00:04Z';
    legacy.pitRequest.digest = sha256(jcsBytes(legacy.pitRequest.payload));
  });
  const portfolioValuationClosureSubstitution = structuredClone(portfolioValuationBase);
  const substitutedClosure = portfolioValuationClosureSubstitution.records.find(
    (row) => row.typeIri === TYPES.PortfolioAccountMembershipClosure,
  );
  const substitutedPortfolio = 'https://axiolune.ai/data/portfolio/runtime-other';
  substitutedClosure.closurePortfolio = substitutedPortfolio;
  for (const membership of portfolioValuationClosureSubstitution.records.filter(
    (row) => row.typeIri === TYPES.PortfolioAccountMembership,
  )) membership.membershipPortfolio = substitutedPortfolio;
  const substitutedProbe = portfolioValuationClosureSubstitution.artifacts.find(
    (row) => row.artifactRef.iri === substitutedClosure.membershipClosureProbeRef,
  );
  substitutedProbe.payload.portfolioLogicalIri = substitutedPortfolio;
  substitutedProbe.artifactDigest = sha256(jcsBytes(substitutedProbe.payload));
  substitutedClosure.membershipClosureProbeDigest = substitutedProbe.artifactDigest;
  const portfolioValuationClosureOmission = structuredClone(portfolioValuationBase);
  addMembershipRecord(portfolioValuationClosureOmission, {
    memberAccount: 'https://axiolune.ai/data/account/runtime-header-extra',
    membershipId: 'runtime-header-extra-membership',
    versionIri: 'https://axiolune.ai/data/membership/runtime-header-extra/version/0',
  });
  const portfolioValuationFormulaSubstitution = structuredClone(portfolioValuationBase);
  const substitutedDefinition = portfolioValuationFormulaSubstitution.records.find(
    (row) => row.typeIri === TYPES.ValuationCalculationDefinition,
  );
  const substitutedFormula = portfolioValuationFormulaSubstitution.artifacts.find(
    (row) => row.artifactDigest === substitutedDefinition.formulaDigest,
  );
  substitutedFormula.payload.artifact = 'formula-substituted';
  substitutedFormula.artifactDigest = sha256(jcsBytes(substitutedFormula.payload));
  substitutedDefinition.formulaDigest = substitutedFormula.artifactDigest;
  const portfolioValuationEmptyRun = encodedPortfolioValuation((legacy) => {
    legacy.valuationRunId = '';
  });
  semanticCases.push(
    ['portfolio-valuation-input-digest-without-bytes', portfolioValuationMissingInputBytes, 'engine-failure', 'WORKER_EXIT', portfolioValuationVector, 'orders-portfolio-canonical-artifact-reference'],
    ['portfolio-valuation-late-input-context', portfolioValuationLateInput, 'violation', 'PORTFOLIO_VALUATION_INPUT_CONTEXT', portfolioValuationVector],
    ['portfolio-valuation-late-conversion-context', portfolioValuationLateConversion, 'violation', 'PORTFOLIO_VALUATION_CONVERSION_CONTEXT', portfolioValuationVector],
    ['portfolio-valuation-future-pit-pivot', portfolioValuationFuturePit, 'violation', 'PORTFOLIO_VALUATION_PIT', portfolioValuationVector],
    ['portfolio-valuation-closure-portfolio-substitution', portfolioValuationClosureSubstitution, 'violation', 'PORTFOLIO_VALUATION_CLOSURE', portfolioValuationVector],
    ['portfolio-valuation-closure-omitted-member', portfolioValuationClosureOmission, 'violation', 'MEMBERSHIP_CLOSURE_COMPLETENESS', portfolioValuationVector],
    ['portfolio-valuation-formula-semantic-substitution', portfolioValuationFormulaSubstitution, 'violation', 'VALUATION_DEFINITION_ARTIFACT', portfolioValuationVector],
    ['portfolio-valuation-empty-run-id', portfolioValuationEmptyRun, 'violation', 'PORTFOLIO_VALUATION_CONTEXT', portfolioValuationVector],
  );

  const valuationDefinitionMissingFormulaBytes = structuredClone(
    valuationDefinitionVector.accepted.scenario,
  );
  valuationDefinitionMissingFormulaBytes.records.find(
    (row) => row.versionIri === valuationDefinitionMissingFormulaBytes.focusVersionIri,
  ).formulaDigest = `sha256:${'0'.repeat(64)}`;
  const costBasisDefinitionVector = vectors.vectors.find(
    (row) => row.validatorId === 'CostBasisCalculationDefinitionContract',
  );
  if (!costBasisDefinitionVector) {
    throw new Error('CostBasisCalculationDefinition semantic-boundary seed is missing');
  }
  const costBasisMissingImplementationBytes = structuredClone(
    costBasisDefinitionVector.accepted.scenario,
  );
  costBasisMissingImplementationBytes.records.find(
    (row) => row.versionIri === costBasisMissingImplementationBytes.focusVersionIri,
  ).implementationDigest = `sha256:${'0'.repeat(64)}`;
  const costBasisImplementationSubstitution = structuredClone(
    costBasisDefinitionVector.accepted.scenario,
  );
  const costBasisDefinition = costBasisImplementationSubstitution.records.find(
    (row) => row.versionIri === costBasisImplementationSubstitution.focusVersionIri,
  );
  const costBasisImplementation = costBasisImplementationSubstitution.artifacts.find(
    (row) => row.artifactDigest === costBasisDefinition.implementationDigest,
  );
  costBasisImplementation.payload.artifact = 'cost-implementation-substituted';
  costBasisImplementation.artifactDigest = sha256(jcsBytes(
    costBasisImplementation.payload,
  ));
  costBasisDefinition.implementationDigest = costBasisImplementation.artifactDigest;
  const fxConversionVector = vectors.vectors.find(
    (row) => row.validatorId === 'FXConversionContract',
  );
  if (!fxConversionVector) throw new Error('FXConversion semantic-boundary seed is missing');
  const fxConversionReversedUnit = structuredClone(fxConversionVector.accepted.scenario);
  fxConversionReversedUnit.records.find(
    (row) => row.typeIri === TYPES.FXRateObservation,
  ).fxRate.unit = 'https://axiolune.ai/units/USD-per-EUR';
  const lotAllocationVector = vectors.vectors.find(
    (row) => row.validatorId === 'PositionLotAllocationContract',
  );
  if (!lotAllocationVector) {
    throw new Error('PositionLotAllocation semantic-boundary seed is missing');
  }
  const lotAllocationInstrumentSubstitution = structuredClone(
    lotAllocationVector.accepted.scenario,
  );
  lotAllocationInstrumentSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLot,
  ).lotForInstrument = 'https://axiolune.ai/data/instrument/runtime-other';
  const lotAllocationExecutionInstrumentSubstitution = structuredClone(
    lotAllocationVector.accepted.scenario,
  );
  lotAllocationExecutionInstrumentSubstitution.records.find(
    (row) => row.typeIri === TYPES.Execution,
  ).executionInstrument = 'https://axiolune.ai/data/instrument/runtime-other';
  const lotAllocationDefinitionSubstitution = structuredClone(
    lotAllocationVector.accepted.scenario,
  );
  const firstAllocationDefinition = lotAllocationDefinitionSubstitution.records.find(
    (row) => row.typeIri === TYPES.CostBasisCalculationDefinition,
  );
  const secondAllocationDefinition = structuredClone(firstAllocationDefinition);
  secondAllocationDefinition.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/allocation-definition/other';
  secondAllocationDefinition.versionIri =
    'https://axiolune.ai/data/cost-definition/runtime-other/version/0';
  lotAllocationDefinitionSubstitution.records.push(secondAllocationDefinition);
  lotAllocationDefinitionSubstitution.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  lotAllocationDefinitionSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLotAllocation,
  ).allocationCostBasisDefinition = secondAllocationDefinition.versionIri;
  const lotAllocationListingInstrumentSubstitution = structuredClone(
    lotAllocationVector.accepted.scenario,
  );
  lotAllocationListingInstrumentSubstitution.records.find(
    (row) => row.typeIri === TYPES.InstrumentListing,
  ).listedInstrument = 'https://axiolune.ai/data/instrument/runtime-other/version/0';
  const lotAllocationUnitSubstitution = structuredClone(
    lotAllocationVector.accepted.scenario,
  );
  lotAllocationUnitSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLotAllocation,
  ).allocatedQuantity.unit = 'https://axiolune.ai/units/contract';
  const feeAllocationVector = vectors.vectors.find(
    (row) => row.validatorId === 'PositionLotFeeAllocationContract',
  );
  if (!feeAllocationVector) {
    throw new Error('PositionLotFeeAllocation semantic-boundary seed is missing');
  }
  const feeAllocationLegacy = decodeCanonicalOrdersPortfolioScenario(
    feeAllocationVector.accepted.scenario,
    feeAllocationVector.validatorId,
    inputContractArtifact.value,
  );
  const encodedFeeAllocation = (mutate) => {
    const legacy = structuredClone(feeAllocationLegacy);
    mutate(legacy);
    return encodeCanonicalOrdersPortfolioScenario(feeAllocationVector.validatorId, legacy);
  };
  const feeAllocationMissingFx = structuredClone(feeAllocationVector.accepted.scenario);
  feeAllocationMissingFx.records.find(
    (row) => row.typeIri === TYPES.CostBasisCalculationDefinition,
  ).costBasisDefinitionBasisCurrency = 'https://axiolune.ai/data/currency/EUR';
  feeAllocationMissingFx.records.find(
    (row) => row.typeIri === TYPES.PositionLotFeeAllocation,
  ).allocatedFeeAmount.currency = 'EUR';
  const feeAllocationCountSubstitution = structuredClone(
    feeAllocationVector.accepted.scenario,
  );
  feeAllocationCountSubstitution.records.find(
    (row) => row.typeIri === TYPES.ExecutionLotAllocationClosure,
  ).feeCount = 2;
  const feeAllocationClosureOmission = structuredClone(
    feeAllocationVector.accepted.scenario,
  );
  const omittedFeeClosure = feeAllocationClosureOmission.records.find(
    (row) => row.typeIri === TYPES.ExecutionLotAllocationClosure,
  );
  omittedFeeClosure.closureFee = [];
  omittedFeeClosure.feeCount = 0;
  omittedFeeClosure.feeVersionSetDigest = iriSetDigest([]);
  const feeAllocationExecutionSubstitution = structuredClone(
    feeAllocationVector.accepted.scenario,
  );
  const originalFeeExecution = feeAllocationExecutionSubstitution.records.find(
    (row) => row.typeIri === TYPES.Execution,
  );
  const substitutedFeeExecution = structuredClone(originalFeeExecution);
  substitutedFeeExecution.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/fee-execution/runtime-other';
  substitutedFeeExecution.versionIri =
    'https://axiolune.ai/data/execution/fee-runtime-other/version/0';
  feeAllocationExecutionSubstitution.records.push(substitutedFeeExecution);
  feeAllocationExecutionSubstitution.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  feeAllocationExecutionSubstitution.records.find(
    (row) => row.typeIri === TYPES.Fee,
  ).feeExecution = substitutedFeeExecution.versionIri;
  const feeAllocationDefinitionSubstitution = structuredClone(
    feeAllocationVector.accepted.scenario,
  );
  const originalFeeDefinition = feeAllocationDefinitionSubstitution.records.find(
    (row) => row.typeIri === TYPES.CostBasisCalculationDefinition,
  );
  const substitutedFeeDefinition = structuredClone(originalFeeDefinition);
  substitutedFeeDefinition.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/fee-definition/runtime-other';
  substitutedFeeDefinition.versionIri =
    'https://axiolune.ai/data/cost-definition/fee-runtime-other/version/0';
  feeAllocationDefinitionSubstitution.records.push(substitutedFeeDefinition);
  feeAllocationDefinitionSubstitution.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  feeAllocationDefinitionSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLotFeeAllocation,
  ).feeCostBasisDefinition = substitutedFeeDefinition.versionIri;
  feeAllocationDefinitionSubstitution.records.find(
    (row) => row.typeIri === TYPES.ExecutionLotAllocationClosure,
  ).closureCostBasisDefinition = substitutedFeeDefinition.versionIri;
  const feeAllocationCrossFx = encodedFeeAllocation((legacy) => {
    legacy.amountMicros = 20;
    legacy.basisCurrency = 'EUR';
    legacy.currency = 'EUR';
    legacy.feeAmountMicros = 10;
    legacy.feeCurrency = 'USD';
    legacy.fx = {
      baseCurrency: 'USD',
      direction: 'baseToQuote',
      inputCurrency: 'USD',
      inputMicros: 10,
      outputCurrency: 'EUR',
      outputMicros: 20,
      quoteCurrency: 'EUR',
      ratePpm: 2_000_000,
    };
  });
  const feeAllocationReversedFxUnit = structuredClone(feeAllocationCrossFx);
  feeAllocationReversedFxUnit.records.find(
    (row) => row.typeIri === TYPES.FXRateObservation,
  ).fxRate.unit = 'https://axiolune.ai/units/USD-per-EUR';
  const executionClosureVector = vectors.vectors.find(
    (row) => row.validatorId === 'ExecutionLotAllocationClosureContract',
  );
  if (!executionClosureVector) {
    throw new Error('ExecutionLotAllocationClosure semantic-boundary seed is missing');
  }
  const executionClosureExtraEligibleLot = structuredClone(
    executionClosureVector.accepted.scenario,
  );
  const originalClosureLot = executionClosureExtraEligibleLot.records.find(
    (row) => row.typeIri === TYPES.PositionLot,
  );
  const extraClosureLot = structuredClone(originalClosureLot);
  extraClosureLot.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/closure-lot/runtime-extra';
  extraClosureLot.versionIri =
    'https://axiolune.ai/data/lot/closure-runtime-extra/version/0';
  executionClosureExtraEligibleLot.records.push(extraClosureLot);
  executionClosureExtraEligibleLot.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  const executionClosureExtraAllocation = structuredClone(
    executionClosureVector.accepted.scenario,
  );
  const originalClosureAllocation = executionClosureExtraAllocation.records.find(
    (row) => row.typeIri === TYPES.PositionLotAllocation,
  );
  const extraClosureAllocation = structuredClone(originalClosureAllocation);
  extraClosureAllocation.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/closure-allocation/runtime-extra';
  extraClosureAllocation.versionIri =
    'https://axiolune.ai/data/allocation/closure-runtime-extra/version/0';
  executionClosureExtraAllocation.records.push(extraClosureAllocation);
  executionClosureExtraAllocation.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  const executionClosureExtraFee = structuredClone(
    executionClosureVector.accepted.scenario,
  );
  const originalClosureFee = executionClosureExtraFee.records.find(
    (row) => row.typeIri === TYPES.Fee,
  );
  const extraClosureFee = structuredClone(originalClosureFee);
  extraClosureFee.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/closure-fee/runtime-extra';
  extraClosureFee.versionIri =
    'https://axiolune.ai/data/fee/closure-runtime-extra/version/0';
  executionClosureExtraFee.records.push(extraClosureFee);
  executionClosureExtraFee.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  const executionClosureExtraFeeAllocation = structuredClone(
    executionClosureVector.accepted.scenario,
  );
  const originalClosureFeeAllocation = executionClosureExtraFeeAllocation.records.find(
    (row) => row.typeIri === TYPES.PositionLotFeeAllocation,
  );
  const extraClosureFeeAllocation = structuredClone(originalClosureFeeAllocation);
  extraClosureFeeAllocation.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/closure-fee-allocation/runtime-extra';
  extraClosureFeeAllocation.versionIri =
    'https://axiolune.ai/data/fee-allocation/closure-runtime-extra/version/0';
  executionClosureExtraFeeAllocation.records.push(extraClosureFeeAllocation);
  executionClosureExtraFeeAllocation.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  const executionClosureSelectionProbeSubstitution = structuredClone(
    executionClosureVector.accepted.scenario,
  );
  const selectionProbeClosure = executionClosureSelectionProbeSubstitution.records.find(
    (row) => row.typeIri === TYPES.ExecutionLotAllocationClosure,
  );
  const selectionProbeArtifact = executionClosureSelectionProbeSubstitution.artifacts.find(
    (row) => row.artifactRef.iri === selectionProbeClosure.consumptionSelectionProbeRef,
  );
  selectionProbeArtifact.payload.lotConsumptionPolicy = 'lifo';
  selectionProbeArtifact.artifactDigest = sha256(jcsBytes(selectionProbeArtifact.payload));
  selectionProbeClosure.consumptionSelectionProbeDigest =
    selectionProbeArtifact.artifactDigest;
  const executionClosureLateInput = structuredClone(
    executionClosureVector.accepted.scenario,
  );
  const lateInputClosure = executionClosureLateInput.records.find(
    (row) => row.typeIri === TYPES.ExecutionLotAllocationClosure,
  );
  const executionClosureLateInputArtifact = executionClosureLateInput.artifacts.find(
    (row) => row.artifactRef.iri === lateInputClosure.inputContextRef,
  );
  executionClosureLateInputArtifact.payload.completedAt = '2025-01-02T00:00:00Z';
  executionClosureLateInputArtifact.artifactDigest = sha256(
    jcsBytes(executionClosureLateInputArtifact.payload),
  );
  lateInputClosure.inputContextRecordDigest =
    executionClosureLateInputArtifact.artifactDigest;
  const executionClosureFuturePit = structuredClone(
    executionClosureVector.accepted.scenario,
  );
  const futurePitClosure = executionClosureFuturePit.records.find(
    (row) => row.typeIri === TYPES.ExecutionLotAllocationClosure,
  );
  const executionClosureFuturePitArtifact = executionClosureFuturePit.artifacts.find(
    (row) => row.artifactRef.iri === futurePitClosure.pitRequestRef,
  );
  executionClosureFuturePitArtifact.payload.validAt = '2025-01-02T00:00:00Z';
  executionClosureFuturePitArtifact.artifactDigest = sha256(
    jcsBytes(executionClosureFuturePitArtifact.payload),
  );
  futurePitClosure.pitRequestRecordDigest =
    executionClosureFuturePitArtifact.artifactDigest;
  const executionClosureDefinitionSubstitution = structuredClone(
    executionClosureVector.accepted.scenario,
  );
  const closureDefinition = executionClosureDefinitionSubstitution.records.find(
    (row) => row.typeIri === TYPES.CostBasisCalculationDefinition,
  );
  const closureImplementation = executionClosureDefinitionSubstitution.artifacts.find(
    (row) => row.artifactDigest === closureDefinition.implementationDigest,
  );
  closureImplementation.payload.artifact = 'cost-implementation-substituted';
  closureImplementation.artifactDigest = sha256(jcsBytes(closureImplementation.payload));
  closureDefinition.implementationDigest = closureImplementation.artifactDigest;
  const executionClosureFifoSkip = structuredClone(
    executionClosureVector.accepted.scenario,
  );
  for (const lot of executionClosureFifoSkip.records.filter(
    (row) => row.typeIri === TYPES.PositionLot,
  )) {
    lot.originalQuantity.numericValue = '0.000100';
  }
  const executionClosureFeeMismatch = structuredClone(
    executionClosureVector.accepted.scenario,
  );
  executionClosureFeeMismatch.records.find(
    (row) => row.typeIri === TYPES.Fee,
  ).feeAmount.amount = '0.000011';
  const executionClosureFeeDefinitionSubstitution = structuredClone(
    executionClosureVector.accepted.scenario,
  );
  executionClosureFeeDefinitionSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLotFeeAllocation,
  ).feeCostBasisDefinition =
    'https://axiolune.ai/data/cost-definition/runtime-other/version/0';
  const executionClosureAllocationContextSubstitution = structuredClone(
    executionClosureVector.accepted.scenario,
  );
  executionClosureAllocationContextSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLotAllocation,
  ).calculationContextRef =
    'https://axiolune.ai/context/calculation/runtime-other';
  const lotStateVector = vectors.vectors.find(
    (row) => row.validatorId === 'PositionLotStateClosureContract',
  );
  if (!lotStateVector) {
    throw new Error('PositionLotStateClosure semantic-boundary seed is missing');
  }
  const lotStateExtraOpenLot = structuredClone(lotStateVector.accepted.scenario);
  const originalStateLot = lotStateExtraOpenLot.records.find(
    (row) => row.typeIri === TYPES.PositionLot,
  );
  const extraStateLot = structuredClone(originalStateLot);
  extraStateLot.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/state-lot/runtime-extra';
  extraStateLot.versionIri =
    'https://axiolune.ai/data/lot/state-runtime-extra/version/0';
  lotStateExtraOpenLot.records.push(extraStateLot);
  lotStateExtraOpenLot.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  const lotStateExtraAllocation = structuredClone(lotStateVector.accepted.scenario);
  const originalStateAllocation = lotStateExtraAllocation.records.find(
    (row) => row.typeIri === TYPES.PositionLotAllocation,
  );
  const extraStateAllocation = structuredClone(originalStateAllocation);
  extraStateAllocation.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/state-allocation/runtime-extra';
  extraStateAllocation.versionIri =
    'https://axiolune.ai/data/allocation/state-runtime-extra/version/0';
  lotStateExtraAllocation.records.push(extraStateAllocation);
  lotStateExtraAllocation.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  const lotStateExtraExecutionClosure = structuredClone(
    lotStateVector.accepted.scenario,
  );
  const originalStateExecutionClosure = lotStateExtraExecutionClosure.records.find(
    (row) => row.typeIri === TYPES.ExecutionLotAllocationClosure,
  );
  const extraStateExecutionClosure = structuredClone(originalStateExecutionClosure);
  extraStateExecutionClosure.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/state-execution-closure/runtime-extra';
  extraStateExecutionClosure.versionIri =
    'https://axiolune.ai/data/execution-closure/state-runtime-extra/version/0';
  lotStateExtraExecutionClosure.records.push(extraStateExecutionClosure);
  lotStateExtraExecutionClosure.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  const lotStateInstrumentSubstitution = structuredClone(
    lotStateVector.accepted.scenario,
  );
  lotStateInstrumentSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLot,
  ).lotForInstrument = 'https://axiolune.ai/data/instrument/runtime-other';
  const lotStateAllocationDefinitionSubstitution = structuredClone(
    lotStateVector.accepted.scenario,
  );
  lotStateAllocationDefinitionSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLotAllocation,
  ).allocationCostBasisDefinition =
    'https://axiolune.ai/data/cost-definition/runtime-other/version/0';
  const lotStateExternalSnapshot = structuredClone(lotStateVector.accepted.scenario);
  lotStateExternalSnapshot.records.find(
    (row) => row.typeIri === TYPES.PositionSnapshot,
  ).positionSourceKind =
    'https://axiolune.ai/ontology/finance/portfolio-positions/PositionSourceKind/value/externalReported';
  const lotStateZeroLotRetained = structuredClone(lotStateVector.accepted.scenario);
  const zeroStateLot = lotStateZeroLotRetained.records.find(
    (row) => row.typeIri === TYPES.PositionLot,
  );
  zeroStateLot.originalQuantity.numericValue = '0.000040';
  lotStateZeroLotRetained.records.find(
    (row) => row.versionIri === zeroStateLot.openingExecution,
  ).executionQuantity.numericValue = '0.000040';
  lotStateZeroLotRetained.records.find(
    (row) => row.typeIri === TYPES.PositionSnapshot,
  ).positionQuantity.numericValue = '0.000000';
  lotStateZeroLotRetained.records.find(
    (row) => row.typeIri === TYPES.PositionLotStateClosure,
  ).remainingCostBasis.amount = '0.000000';
  const lotStateProbeSubstitution = structuredClone(lotStateVector.accepted.scenario);
  const probeStateClosure = lotStateProbeSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLotStateClosure,
  );
  const stateLotProbeArtifact = lotStateProbeSubstitution.artifacts.find(
    (row) => row.artifactRef.iri === probeStateClosure.lotClosureProbeRef,
  );
  stateLotProbeArtifact.payload.remainingQuantityMicros += 1;
  stateLotProbeArtifact.artifactDigest = sha256(jcsBytes(stateLotProbeArtifact.payload));
  probeStateClosure.lotClosureProbeDigest = stateLotProbeArtifact.artifactDigest;
  const lotStateLateInput = structuredClone(lotStateVector.accepted.scenario);
  const lateStateClosure = lotStateLateInput.records.find(
    (row) => row.typeIri === TYPES.PositionLotStateClosure,
  );
  const lateStateInputArtifact = lotStateLateInput.artifacts.find(
    (row) => row.artifactRef.iri === lateStateClosure.inputContextRef,
  );
  lateStateInputArtifact.payload.completedAt = '2025-01-02T00:00:00Z';
  lateStateInputArtifact.artifactDigest = sha256(jcsBytes(lateStateInputArtifact.payload));
  lateStateClosure.inputContextRecordDigest = lateStateInputArtifact.artifactDigest;
  const lotStateFuturePit = structuredClone(lotStateVector.accepted.scenario);
  const futureStateClosure = lotStateFuturePit.records.find(
    (row) => row.typeIri === TYPES.PositionLotStateClosure,
  );
  const futureStatePitArtifact = lotStateFuturePit.artifacts.find(
    (row) => row.artifactRef.iri === futureStateClosure.pitRequestRef,
  );
  futureStatePitArtifact.payload.availableAt = '2025-01-02T00:00:00Z';
  futureStatePitArtifact.artifactDigest = sha256(jcsBytes(futureStatePitArtifact.payload));
  futureStateClosure.pitRequestRecordDigest = futureStatePitArtifact.artifactDigest;
  const lotStateDefinitionSubstitution = structuredClone(
    lotStateVector.accepted.scenario,
  );
  const stateDefinition = lotStateDefinitionSubstitution.records.find(
    (row) => row.typeIri === TYPES.CostBasisCalculationDefinition,
  );
  const stateImplementation = lotStateDefinitionSubstitution.artifacts.find(
    (row) => row.artifactDigest === stateDefinition.implementationDigest,
  );
  stateImplementation.payload.artifact = 'cost-implementation-substituted';
  stateImplementation.artifactDigest = sha256(jcsBytes(stateImplementation.payload));
  stateDefinition.implementationDigest = stateImplementation.artifactDigest;
  const lotStateSnapshotQuantitySubstitution = structuredClone(
    lotStateVector.accepted.scenario,
  );
  lotStateSnapshotQuantitySubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionSnapshot,
  ).positionQuantity.numericValue = '0.000061';
  const lotStateExecutionDigestSubstitution = structuredClone(
    lotStateVector.accepted.scenario,
  );
  lotStateExecutionDigestSubstitution.records.find(
    (row) => row.typeIri === TYPES.ExecutionLotAllocationClosure,
  ).allocationVersionSetDigest = `sha256:${'0'.repeat(64)}`;
  const lotStateOpeningQuantitySubstitution = structuredClone(
    lotStateVector.accepted.scenario,
  );
  const openingQuantityStateLot = lotStateOpeningQuantitySubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLot,
  );
  lotStateOpeningQuantitySubstitution.records.find(
    (row) => row.versionIri === openingQuantityStateLot.openingExecution,
  ).executionQuantity.numericValue = '0.000099';
  const lotStateQuotationSubstitution = structuredClone(
    lotStateVector.accepted.scenario,
  );
  lotStateQuotationSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLot,
  ).lotQuotationContract =
    'https://axiolune.ai/data/quotation/runtime-other/version/0';
  const pnlVector = vectors.vectors.find(
    (row) => row.validatorId === 'UnrealizedPnLObservationContract',
  );
  if (!pnlVector) {
    throw new Error('UnrealizedPnLObservation semantic-boundary seed is missing');
  }
  const pnlLegacy = decodeCanonicalOrdersPortfolioScenario(
    pnlVector.accepted.scenario,
    pnlVector.validatorId,
    inputContractArtifact.value,
  );
  const encodedPnl = (mutate) => {
    const legacy = structuredClone(pnlLegacy);
    legacy.inputTemporal = structuredClone(legacy.stateTemporal);
    mutate(legacy);
    return encodeCanonicalOrdersPortfolioScenario(
      pnlVector.validatorId,
      legacy,
    );
  };
  const pnlSnapshotSubstitution = structuredClone(pnlVector.accepted.scenario);
  pnlSnapshotSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionValuation,
  ).valuedPositionSnapshot =
    'https://axiolune.ai/data/position/runtime-other/version/0';
  const pnlDefinitionSubstitution = structuredClone(pnlVector.accepted.scenario);
  pnlDefinitionSubstitution.records.find(
    (row) => row.typeIri === TYPES.UnrealizedPnLObservation,
  ).pnlCostBasisDefinition =
    'https://axiolune.ai/data/cost-definition/runtime-other/version/0';
  const pnlQuotationSubstitution = structuredClone(pnlVector.accepted.scenario);
  pnlQuotationSubstitution.records.find(
    (row) => row.typeIri === TYPES.UnrealizedPnLObservation,
  ).pnlQuotationContract =
    'https://axiolune.ai/data/quotation/runtime-other/version/0';
  const pnlCalculationContextSubstitution = structuredClone(
    pnlVector.accepted.scenario,
  );
  pnlCalculationContextSubstitution.records.find(
    (row) => row.typeIri === TYPES.UnrealizedPnLObservation,
  ).calculationContextRef =
    'https://axiolune.ai/context/calculation/runtime-other';
  const pnlGeneratingRunSubstitution = structuredClone(pnlVector.accepted.scenario);
  pnlGeneratingRunSubstitution.records.find(
    (row) => row.typeIri === TYPES.UnrealizedPnLObservation,
  ).generatingContextRef =
    'https://axiolune.ai/data/run/pnl-runtime-other/version/0';
  const pnlOpenLotDigestSubstitution = structuredClone(pnlVector.accepted.scenario);
  pnlOpenLotDigestSubstitution.records.find(
    (row) => row.typeIri === TYPES.UnrealizedPnLObservation,
  ).openLotVersionSetDigest = `sha256:${'0'.repeat(64)}`;
  const pnlAllocationDigestSubstitution = structuredClone(
    pnlVector.accepted.scenario,
  );
  pnlAllocationDigestSubstitution.records.find(
    (row) => row.typeIri === TYPES.UnrealizedPnLObservation,
  ).stateAllocationVersionSetDigest = `sha256:${'0'.repeat(64)}`;
  const pnlValuationValueSubstitution = structuredClone(pnlVector.accepted.scenario);
  pnlValuationValueSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionValuation,
  ).marketValue.amount = '0.001001';
  const pnlStateBasisSubstitution = structuredClone(pnlVector.accepted.scenario);
  pnlStateBasisSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLotStateClosure,
  ).remainingCostBasis.amount = '0.000601';
  const pnlLateConversionContext = encodedPnl((legacy) => {
    legacy.conversionContext.payload.completedAt = '2025-01-02T00:00:00Z';
    legacy.conversionContext.digest = sha256(jcsBytes(
      legacy.conversionContext.payload,
    ));
  });
  const pnlLateValuationInput = structuredClone(pnlVector.accepted.scenario);
  const latePnlValuationHeader = pnlLateValuationInput.records.find(
    (row) => row.typeIri === TYPES.PortfolioValuation,
  );
  const latePnlValuationArtifact = pnlLateValuationInput.artifacts.find(
    (row) => row.artifactRef.iri === latePnlValuationHeader.inputContextRef,
  );
  latePnlValuationArtifact.payload.completedAt = '2025-01-02T00:00:00Z';
  latePnlValuationArtifact.artifactDigest = sha256(
    jcsBytes(latePnlValuationArtifact.payload),
  );
  latePnlValuationHeader.inputContextRecordDigest =
    latePnlValuationArtifact.artifactDigest;
  const pnlFutureValuationPit = encodedPnl((legacy) => {
    legacy.valuationPitRequest.payload.knowledgeAt = '2025-01-02T00:00:00Z';
    legacy.valuationPitRequest.digest = sha256(jcsBytes(
      legacy.valuationPitRequest.payload,
    ));
  });
  const pnlCurrencySubstitution = structuredClone(pnlVector.accepted.scenario);
  pnlCurrencySubstitution.records.find(
    (row) => row.typeIri === TYPES.UnrealizedPnLObservation,
  ).unrealizedPnl.currency = 'EUR';
  const pnlFutureState = structuredClone(pnlVector.accepted.scenario);
  pnlFutureState.records.find(
    (row) => row.typeIri === TYPES.PositionLotStateClosure,
  ).knowledgeFrom = '2025-01-02T00:00:00Z';
  const pnlDefinitionQuotationSubstitution = structuredClone(
    pnlVector.accepted.scenario,
  );
  const pnlDefinitionQuotation = pnlDefinitionQuotationSubstitution.records.find(
    (row) => row.typeIri === TYPES.ValuationCalculationDefinition,
  );
  const pnlOtherQuotationVersionIri =
    'https://axiolune.ai/data/quotation/runtime-other/version/0';
  const pnlOtherQuotation = structuredClone(
    pnlDefinitionQuotationSubstitution.records.find(
      (row) => row.versionIri
        === pnlDefinitionQuotation.valuationDefinitionQuotationContract[0],
    ),
  );
  pnlOtherQuotation.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/pnl-quotation/runtime-other';
  pnlOtherQuotation.versionIri = pnlOtherQuotationVersionIri;
  pnlDefinitionQuotationSubstitution.records.push(pnlOtherQuotation);
  pnlDefinitionQuotationSubstitution.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  pnlDefinitionQuotation.valuationDefinitionQuotationContract = [
    pnlOtherQuotationVersionIri,
  ];
  const pnlPriceQuotationSubstitution = structuredClone(
    pnlVector.accepted.scenario,
  );
  pnlPriceQuotationSubstitution.records.find(
    (row) => row.typeIri === TYPES.PriceObservation,
  ).quotationContract =
    'https://axiolune.ai/data/quotation/runtime-other/version/0';
  const pnlConversionHeaderSubstitution = structuredClone(
    pnlVector.accepted.scenario,
  );
  const substitutionPnl = pnlConversionHeaderSubstitution.records.find(
    (row) => row.typeIri === TYPES.UnrealizedPnLObservation,
  );
  const substitutionHeader = pnlConversionHeaderSubstitution.records.find(
    (row) => row.typeIri === TYPES.PortfolioValuation,
  );
  const originalPnlConversionArtifact = pnlConversionHeaderSubstitution.artifacts.find(
    (row) => row.artifactRef.iri === substitutionPnl.conversionContextRef,
  );
  const substitutedPnlConversionArtifact = structuredClone(
    originalPnlConversionArtifact,
  );
  substitutedPnlConversionArtifact.artifactRef.iri =
    'https://axiolune.ai/contexts/pnl/conversion-runtime-other';
  pnlConversionHeaderSubstitution.artifacts.push(substitutedPnlConversionArtifact);
  pnlConversionHeaderSubstitution.artifacts.sort(
    (left, right) => compareUtf8(left.artifactRef.iri, right.artifactRef.iri),
  );
  substitutionHeader.conversionContextRef =
    substitutedPnlConversionArtifact.artifactRef.iri;
  const openingAllocationVector = vectors.vectors.find(
    (row) => row.validatorId === 'PositionLotOpeningAllocationCompletenessContract',
  );
  if (!openingAllocationVector) {
    throw new Error('PositionLotOpeningAllocationCompleteness semantic-boundary seed is missing');
  }
  const openingAllocationDuplicate = structuredClone(
    openingAllocationVector.accepted.scenario,
  );
  const originalOpeningAllocation = openingAllocationDuplicate.records.find(
    (row) => row.typeIri === TYPES.PositionLotAllocation,
  );
  const duplicateOpeningAllocation = structuredClone(originalOpeningAllocation);
  duplicateOpeningAllocation.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/opening-allocation/runtime-duplicate';
  duplicateOpeningAllocation.versionIri =
    'https://axiolune.ai/data/opening-allocation/runtime-duplicate/version/0';
  openingAllocationDuplicate.records.push(duplicateOpeningAllocation);
  openingAllocationDuplicate.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  const openingAllocationDefinitionSubstitution = structuredClone(
    openingAllocationVector.accepted.scenario,
  );
  openingAllocationDefinitionSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLotAllocation,
  ).allocationCostBasisDefinition =
    'https://axiolune.ai/data/cost-definition/runtime-other/version/0';
  const openingAllocationContextSubstitution = structuredClone(
    openingAllocationVector.accepted.scenario,
  );
  openingAllocationContextSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLotAllocation,
  ).calculationContextRef =
    'https://axiolune.ai/context/calculation/runtime-other';
  const openingAllocationUnitSubstitution = structuredClone(
    openingAllocationVector.accepted.scenario,
  );
  openingAllocationUnitSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLotAllocation,
  ).allocatedQuantity.unit = 'https://axiolune.ai/units/contract';
  const openingAllocationExecutionSubstitution = structuredClone(
    openingAllocationVector.accepted.scenario,
  );
  openingAllocationExecutionSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLotAllocation,
  ).allocationExecution =
    'https://axiolune.ai/data/execution/runtime-other/version/0';
  const openingAllocationInstrumentSubstitution = structuredClone(
    openingAllocationVector.accepted.scenario,
  );
  openingAllocationInstrumentSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionLot,
  ).lotForInstrument = 'https://axiolune.ai/data/instrument/runtime-other';
  const openingAllocationListingSubstitution = structuredClone(
    openingAllocationVector.accepted.scenario,
  );
  openingAllocationListingSubstitution.records.find(
    (row) => row.typeIri === TYPES.InstrumentListing,
  ).listedInstrument =
    'https://axiolune.ai/data/instrument/runtime-other/version/0';
  const openingAllocationQuotationSubstitution = structuredClone(
    openingAllocationVector.accepted.scenario,
  );
  openingAllocationQuotationSubstitution.records.find(
    (row) => row.typeIri === TYPES.CostBasisCalculationDefinition,
  ).costBasisDefinitionQuotationContract =
    'https://axiolune.ai/data/quotation/runtime-other/version/0';
  const openingAllocationSideSubstitution = structuredClone(
    openingAllocationVector.accepted.scenario,
  );
  openingAllocationSideSubstitution.records.find(
    (row) => row.typeIri === TYPES.Execution,
  ).orderSide =
    'https://axiolune.ai/ontology/finance/orders-execution/OrderSide/value/Sell';
  const openingAllocationFuture = structuredClone(
    openingAllocationVector.accepted.scenario,
  );
  openingAllocationFuture.records.find(
    (row) => row.typeIri === TYPES.PositionLotAllocation,
  ).availableFrom = '2025-01-02T00:00:00Z';
  const reconciliationVector = vectors.vectors.find(
    (row) => row.validatorId
      === 'PortfolioPositionReconciliationFindingContract',
  );
  if (!reconciliationVector) {
    throw new Error('PortfolioPositionReconciliationFinding semantic-boundary seed is missing');
  }
  const reconciliationVersion = (name) => ({
    logicalIri: `https://axiolune.ai/data/${name}`,
    referenceMode: 'version',
    versionIri: `https://axiolune.ai/data/${name}/version/0`,
  });
  const reconciliationBase = {
    derivedSnapshot: reconciliationVersion('position/reconciliation-derived'),
    externalSnapshot: reconciliationVersion('holding/reconciliation-external'),
    kind: 'matched',
    leftAccountIri: 'https://axiolune.ai/data/account/1',
    leftInstrumentIri: 'https://axiolune.ai/data/instrument/1',
    leftValueMicros: 100,
    rightAccountIri: 'https://axiolune.ai/data/account/1',
    rightInstrumentIri: 'https://axiolune.ai/data/instrument/1',
    rightValueMicros: 100,
    temporal: {
      availableFrom: '2025-01-01T00:00:02Z',
      knowledgeFrom: '2025-01-01T00:00:01Z',
      revision: 0,
      validFrom: '2025-01-01T00:00:00Z',
    },
  };
  const reconciliationScenario = (overrides = {}) => (
    encodeCanonicalOrdersPortfolioScenario(
      reconciliationVector.validatorId,
      { ...reconciliationBase, ...overrides },
    )
  );
  const reconciliationQuantityMismatch = reconciliationScenario({
    kind: 'quantityMismatch',
    rightValueMicros: 90,
  });
  const reconciliationExternalPosition = reconciliationScenario({
    externalPositionSnapshot: reconciliationVersion(
      'position/reconciliation-external',
    ),
    externalSnapshot: undefined,
    leftValueMicros: -100,
    rightValueMicros: -100,
  });
  const reconciliationMissingExternalQuantity = reconciliationScenario({
    externalSnapshot: undefined,
    kind: 'missingExternal',
  });
  const reconciliationMissingDerivedQuantity = reconciliationScenario({
    derivedSnapshot: undefined,
    kind: 'missingDerived',
  });
  const reconciliationBasisMatched = reconciliationScenario({
    derivedSnapshot: undefined,
    externalBasis: reconciliationVersion('basis/reconciliation-external'),
    externalSnapshot: undefined,
    lotState: reconciliationVersion('lot-state/reconciliation-derived'),
  });
  const reconciliationBasisMismatch = reconciliationScenario({
    derivedSnapshot: undefined,
    externalBasis: reconciliationVersion('basis/reconciliation-external'),
    externalSnapshot: undefined,
    kind: 'basisMismatch',
    lotState: reconciliationVersion('lot-state/reconciliation-derived'),
    rightValueMicros: 90,
  });
  const reconciliationBasisDefinitionSubstitution = reconciliationScenario({
    derivedSnapshot: undefined,
    externalBasis: reconciliationVersion('basis/reconciliation-external'),
    externalBasisDefinitionVersionIri:
      'https://axiolune.ai/data/cost-definition/reconciliation-external-substitution/version/0',
    externalSnapshot: undefined,
    lotState: reconciliationVersion('lot-state/reconciliation-derived'),
  });
  const reconciliationMissingExternalBasis = reconciliationScenario({
    derivedSnapshot: undefined,
    externalBasis: undefined,
    externalSnapshot: undefined,
    kind: 'missingExternal',
    lotState: reconciliationVersion('lot-state/reconciliation-derived'),
  });
  const reconciliationMissingDerivedBasis = reconciliationScenario({
    derivedSnapshot: undefined,
    externalBasis: reconciliationVersion('basis/reconciliation-external'),
    externalSnapshot: undefined,
    kind: 'missingDerived',
    lotState: undefined,
  });
  const reconciliationExternalTypeConflict = reconciliationScenario({
    externalPositionSnapshot: reconciliationVersion(
      'position/reconciliation-external',
    ),
  });
  const reconciliationSubjectDigestSubstitution = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  reconciliationSubjectDigestSubstitution.records.find(
    (row) => row.typeIri
      === TYPES.PortfolioPositionReconciliationFinding,
  ).reconciliationSubjectDigest = `sha256:${'0'.repeat(64)}`;
  const reconciliationAccountSubstitution = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  reconciliationAccountSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionSnapshot,
  ).positionAccount = 'https://axiolune.ai/data/account/runtime-other';
  const reconciliationInstrumentSubstitution = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  reconciliationInstrumentSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionSnapshot,
  ).positionInstrument = 'https://axiolune.ai/data/instrument/runtime-other';
  const reconciliationInstrumentListing = structuredClone(
    reconciliationInstrumentSubstitution.records.find(
      (row) => row.typeIri === TYPES.InstrumentListing,
    ),
  );
  reconciliationInstrumentListing.listedInstrument =
    'https://axiolune.ai/data/instrument/runtime-other/version/0';
  reconciliationInstrumentListing.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/reconciliation-instrument-listing/runtime-other';
  reconciliationInstrumentListing.versionIri =
    'https://axiolune.ai/data/listing/reconciliation-instrument-runtime-other/version/0';
  reconciliationInstrumentSubstitution.records.push(
    reconciliationInstrumentListing,
  );
  reconciliationInstrumentSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionSnapshot,
  ).positionListing = reconciliationInstrumentListing.versionIri;
  reconciliationInstrumentSubstitution.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  const reconciliationListingSubstitution = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  const reconciliationOriginalListing = reconciliationListingSubstitution.records.find(
    (row) => row.typeIri === TYPES.InstrumentListing,
  );
  const reconciliationOtherListing = structuredClone(
    reconciliationOriginalListing,
  );
  reconciliationOtherListing.source =
    'https://axiolune.ai/sources/orders-portfolio-custom/reconciliation-listing/runtime-other';
  reconciliationOtherListing.versionIri =
    'https://axiolune.ai/data/listing/reconciliation-runtime-other/version/0';
  reconciliationListingSubstitution.records.push(reconciliationOtherListing);
  reconciliationListingSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionSnapshot,
  ).positionListing = reconciliationOtherListing.versionIri;
  reconciliationListingSubstitution.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  const reconciliationUnitSubstitution = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  reconciliationUnitSubstitution.records.find(
    (row) => row.typeIri === TYPES.PositionSnapshot,
  ).positionQuantity.unit = 'https://axiolune.ai/units/contract';
  const reconciliationExternalSourceSubstitution = structuredClone(
    reconciliationExternalPosition,
  );
  const reconciliationExternalSourceFocus =
    reconciliationExternalSourceSubstitution.records.find(
      (row) => row.typeIri
        === TYPES.PortfolioPositionReconciliationFinding,
    );
  reconciliationExternalSourceSubstitution.records.find(
    (row) => row.versionIri
      === reconciliationExternalSourceFocus.comparedExternalPositionSnapshot,
  ).positionSourceKind =
    'https://axiolune.ai/ontology/finance/portfolio-positions/PositionSourceKind/value/executionDerived';
  const reconciliationFutureExternal = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  reconciliationFutureExternal.records.find(
    (row) => row.typeIri === TYPES.HoldingSnapshot,
  ).availableFrom = '2025-01-01T00:00:01.600000000Z';
  const reconciliationPitSubstitution = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  const reconciliationFocus = (scenario) => scenario.records.find(
    (row) => row.typeIri
      === TYPES.PortfolioPositionReconciliationFinding,
  );
  const mutateReconciliationArtifact = (
    scenario,
    refField,
    digestField,
    mutate,
  ) => {
    const focusRecord = reconciliationFocus(scenario);
    const lockedArtifact = scenario.artifacts.find(
      (row) => row.artifactRef.iri === focusRecord[refField],
    );
    mutate(lockedArtifact.payload, focusRecord);
    lockedArtifact.artifactDigest = sha256(jcsBytes(lockedArtifact.payload));
    focusRecord[digestField] = lockedArtifact.artifactDigest;
  };
  mutateReconciliationArtifact(
    reconciliationPitSubstitution,
    'pitRequestRef',
    'pitRequestRecordDigest',
    (payload) => {
      payload.availableAt = '2025-01-01T00:00:02.000000001Z';
      payload.completedAt = '2025-01-01T00:00:02.000000002Z';
    },
  );
  const mutateReconciliationContext = (scenario, mutate) => {
    mutateReconciliationArtifact(
      scenario,
      'reconciliationContextRef',
      'reconciliationContextDigest',
      mutate,
    );
  };
  const reconciliationContextSemanticSubstitution = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  mutateReconciliationContext(
    reconciliationContextSemanticSubstitution,
    (payload) => { payload.comparisonMode = 'tolerant'; },
  );
  const reconciliationLateContext = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  mutateReconciliationContext(
    reconciliationLateContext,
    (payload) => {
      payload.completedAt = '2025-01-01T00:00:02.000000001Z';
    },
  );
  const reconciliationGeneratingRunSubstitution = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  reconciliationGeneratingRunSubstitution.records.find(
    (row) => row.typeIri
      === TYPES.PortfolioPositionReconciliationFinding,
  ).generatingContextRef =
    'https://axiolune.ai/data/run/reconciliation-runtime-other/version/0';
  const reconciliationWrongKind = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  reconciliationWrongKind.records.find(
    (row) => row.typeIri
      === TYPES.PortfolioPositionReconciliationFinding,
  ).portfolioReconciliationKind =
    'https://axiolune.ai/ontology/finance/portfolio-positions/PortfolioReconciliationKind/value/quantityMismatch';
  const reconciliationBasisCurrencySubstitution = structuredClone(
    reconciliationBasisMatched,
  );
  reconciliationBasisCurrencySubstitution.records.find(
    (row) => row.typeIri === TYPES.ExternalCostBasisObservation,
  ).externalCostBasis.currency = 'EUR';
  const reconciliationHiddenExternalCandidate = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  const reconciliationHiddenExternalFocus = reconciliationFocus(
    reconciliationHiddenExternalCandidate,
  );
  delete reconciliationHiddenExternalFocus.comparedExternalSnapshot;
  reconciliationHiddenExternalFocus.portfolioReconciliationKind =
    'https://axiolune.ai/ontology/finance/portfolio-positions/PortfolioReconciliationKind/value/missingExternal';
  const reconciliationExtraEligibleCandidate = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  const reconciliationExtraHolding = structuredClone(
    reconciliationExtraEligibleCandidate.records.find(
      (row) => row.typeIri === TYPES.HoldingSnapshot,
    ),
  );
  reconciliationExtraHolding.snapshotId = 'runtime-extra-eligible';
  reconciliationExtraHolding.versionIri =
    'https://axiolune.ai/data/holding/reconciliation-extra/version/0';
  reconciliationExtraEligibleCandidate.records.push(
    reconciliationExtraHolding,
  );
  reconciliationExtraEligibleCandidate.records.sort(
    (left, right) => compareUtf8(left.versionIri, right.versionIri),
  );
  const reconciliationCandidateCountSubstitution = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  reconciliationFocus(
    reconciliationCandidateCountSubstitution,
  ).reconciliationExternalCandidateCount = 2;
  const reconciliationInputInventoryOmission = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  mutateReconciliationArtifact(
    reconciliationInputInventoryOmission,
    'inputContextRef',
    'inputContextRecordDigest',
    (payload) => {
      payload.externalCandidateCount = 0;
      payload.externalCandidateVersionSetDigest = iriSetDigest([]);
      payload.externalCandidates = [];
    },
  );
  const reconciliationProbeSemanticSubstitution = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  mutateReconciliationArtifact(
    reconciliationProbeSemanticSubstitution,
    'reconciliationClosureProbeRef',
    'reconciliationClosureProbeDigest',
    (payload) => {
      payload.result = 'partial';
    },
  );
  const reconciliationCandidateGraphThirdSource = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  mutateReconciliationArtifact(
    reconciliationCandidateGraphThirdSource,
    'reconciliationCandidateGraphRef',
    'reconciliationCandidateGraphDigest',
    (payload) => {
      payload.records[0].sourceScopeRef =
        'https://axiolune.ai/sources/portfolio-reconciliation/unreviewed-third-source';
    },
  );
  const reconciliationCandidateGraphOmission = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  mutateReconciliationArtifact(
    reconciliationCandidateGraphOmission,
    'reconciliationCandidateGraphRef',
    'reconciliationCandidateGraphDigest',
    (payload) => {
      payload.records.pop();
    },
  );
  const reconciliationExternalManifestIncomplete = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  mutateReconciliationArtifact(
    reconciliationExternalManifestIncomplete,
    'reconciliationExternalSnapshotManifestRef',
    'reconciliationExternalSnapshotManifestDigest',
    (payload) => {
      payload.completeResponse = false;
    },
  );
  const reconciliationExternalManifestPageOmission = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  mutateReconciliationArtifact(
    reconciliationExternalManifestPageOmission,
    'reconciliationExternalSnapshotManifestRef',
    'reconciliationExternalSnapshotManifestDigest',
    (payload) => {
      payload.pages = [];
      payload.pageCount = 0;
    },
  );
  const reconciliationExternalPageRecordOmission = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  {
    const finding = reconciliationFocus(reconciliationExternalPageRecordOmission);
    const manifestArtifact = reconciliationExternalPageRecordOmission.artifacts.find(
      (row) => row.artifactRef.iri
        === finding.reconciliationExternalSnapshotManifestRef,
    );
    const pageDescriptor = manifestArtifact.payload.pages[0];
    const pageArtifact = reconciliationExternalPageRecordOmission.artifacts.find(
      (row) => row.artifactRef.iri === pageDescriptor.pageRef,
    );
    pageArtifact.payload.records = [];
    pageArtifact.payload.recordCount = 0;
    pageArtifact.payload.recordSetDigest = sha256DomainJcs(
      'axiolune-reconciliation-record-set-v1',
      [],
    );
    pageArtifact.artifactDigest = sha256(jcsBytes(pageArtifact.payload));
    pageDescriptor.pageDigest = pageArtifact.artifactDigest;
    manifestArtifact.artifactDigest = sha256(jcsBytes(manifestArtifact.payload));
    finding.reconciliationExternalSnapshotManifestDigest =
      manifestArtifact.artifactDigest;
  }
  const reconciliationDerivedManifestRunSubstitution = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  mutateReconciliationArtifact(
    reconciliationDerivedManifestRunSubstitution,
    'reconciliationDerivedOutputManifestRef',
    'reconciliationDerivedOutputManifestDigest',
    (payload) => {
      payload.generatingContextRef =
        'https://axiolune.ai/data/run/portfolio-derived-unreviewed/version/0';
    },
  );
  const reconciliationQueryDefinitionSubstitution = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  mutateReconciliationArtifact(
    reconciliationQueryDefinitionSubstitution,
    'reconciliationQueryDefinitionRef',
    'reconciliationQueryDefinitionDigest',
    (payload) => {
      payload.algorithm = 'implicit-current-state-v0';
    },
  );
  const reconciliationQueryToolSubstitution = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  mutateReconciliationArtifact(
    reconciliationQueryToolSubstitution,
    'reconciliationQueryToolLockRef',
    'reconciliationQueryToolLockDigest',
    (payload) => {
      payload.runtime = 'unlocked-host-runtime';
    },
  );
  const reconciliationKnowledgeAfterAvailability = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  reconciliationKnowledgeAfterAvailability.records.find(
    (row) => row.typeIri === TYPES.HoldingSnapshot,
  ).knowledgeFrom = '2025-01-01T00:00:01.750000000Z';
  const reconciliationDeletedCandidate = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  const reconciliationDeletedFocus = reconciliationFocus(
    reconciliationDeletedCandidate,
  );
  const reconciliationDeletedVersion =
    reconciliationDeletedFocus.comparedExternalSnapshot;
  delete reconciliationDeletedFocus.comparedExternalSnapshot;
  reconciliationDeletedFocus.portfolioReconciliationKind =
    'https://axiolune.ai/ontology/finance/portfolio-positions/PortfolioReconciliationKind/value/missingExternal';
  reconciliationDeletedCandidate.records =
    reconciliationDeletedCandidate.records.filter(
      (row) => row.versionIri !== reconciliationDeletedVersion,
    );
  const reconciliationExpiredExternal = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  const reconciliationExpiredHolding =
    reconciliationExpiredExternal.records.find(
      (row) => row.typeIri === TYPES.HoldingSnapshot,
    );
  reconciliationExpiredHolding.validFrom = '2024-12-31T00:00:00Z';
  reconciliationExpiredHolding.validTo = '2025-01-01T00:00:00Z';
  reconciliationExpiredExternal.records.find(
    (row) => row.typeIri === TYPES.InstrumentListing,
  ).validFrom = '2024-12-30T00:00:00Z';
  const reconciliationExpiredListing = structuredClone(
    reconciliationVector.accepted.scenario,
  );
  const reconciliationExpiredListingRecord =
    reconciliationExpiredListing.records.find(
      (row) => row.typeIri === TYPES.InstrumentListing,
    );
  reconciliationExpiredListingRecord.validFrom =
    '2024-12-31T00:00:00Z';
  reconciliationExpiredListingRecord.validTo =
    '2025-01-01T00:00:00Z';
  semanticCases.push(
    ['valuation-definition-formula-digest-without-bytes', valuationDefinitionMissingFormulaBytes, 'engine-failure', 'WORKER_EXIT', valuationDefinitionVector, 'orders-portfolio-canonical-artifact-reference'],
    ['cost-basis-implementation-digest-without-bytes', costBasisMissingImplementationBytes, 'engine-failure', 'WORKER_EXIT', costBasisDefinitionVector, 'orders-portfolio-canonical-artifact-reference'],
    ['cost-basis-implementation-semantic-substitution', costBasisImplementationSubstitution, 'violation', 'COST_BASIS_ARTIFACT', costBasisDefinitionVector],
    ['fx-conversion-reversed-rate-unit', fxConversionReversedUnit, 'violation', 'FX_CONVERSION_RATE_UNIT', fxConversionVector],
    ['lot-allocation-lot-instrument-substitution', lotAllocationInstrumentSubstitution, 'violation', 'LOT_ALLOCATION_JOIN', lotAllocationVector],
    ['lot-allocation-execution-instrument-substitution', lotAllocationExecutionInstrumentSubstitution, 'violation', 'LOT_ALLOCATION_JOIN', lotAllocationVector],
    ['lot-allocation-definition-substitution', lotAllocationDefinitionSubstitution, 'violation', 'LOT_ALLOCATION_JOIN', lotAllocationVector],
    ['lot-allocation-listing-instrument-substitution', lotAllocationListingInstrumentSubstitution, 'violation', 'LOT_ALLOCATION_JOIN', lotAllocationVector],
    ['lot-allocation-unit-substitution', lotAllocationUnitSubstitution, 'violation', 'LOT_ALLOCATION_JOIN', lotAllocationVector],
    ['fee-allocation-cross-basis-without-fx', feeAllocationMissingFx, 'violation', 'FEE_ALLOCATION_FX', feeAllocationVector],
    ['fee-allocation-closure-count-substitution', feeAllocationCountSubstitution, 'violation', 'FEE_ALLOCATION_CLOSURE', feeAllocationVector],
    ['fee-allocation-closure-fee-omission', feeAllocationClosureOmission, 'violation', 'FEE_ALLOCATION_JOIN', feeAllocationVector],
    ['fee-allocation-execution-substitution', feeAllocationExecutionSubstitution, 'violation', 'FEE_ALLOCATION_JOIN', feeAllocationVector],
    ['fee-allocation-definition-substitution', feeAllocationDefinitionSubstitution, 'violation', 'FEE_ALLOCATION_JOIN', feeAllocationVector],
    ['fee-allocation-cross-basis-fx', feeAllocationCrossFx, 'accepted', null, feeAllocationVector],
    ['fee-allocation-reversed-fx-unit', feeAllocationReversedFxUnit, 'violation', 'FEE_ALLOCATION_FX', feeAllocationVector],
    ['execution-closure-extra-eligible-lot', executionClosureExtraEligibleLot, 'violation', 'EXECUTION_CLOSURE_ELIGIBLE', executionClosureVector],
    ['execution-closure-extra-allocation', executionClosureExtraAllocation, 'violation', 'EXECUTION_CLOSURE_ALLOCATION', executionClosureVector],
    ['execution-closure-extra-fee', executionClosureExtraFee, 'violation', 'EXECUTION_CLOSURE_FEE', executionClosureVector],
    ['execution-closure-extra-fee-allocation', executionClosureExtraFeeAllocation, 'violation', 'EXECUTION_CLOSURE_FEE', executionClosureVector],
    ['execution-closure-selection-probe-substitution', executionClosureSelectionProbeSubstitution, 'violation', 'EXECUTION_CLOSURE_PROBE', executionClosureVector],
    ['execution-closure-late-input-context', executionClosureLateInput, 'violation', 'EXECUTION_CLOSURE_INPUT', executionClosureVector],
    ['execution-closure-future-pit', executionClosureFuturePit, 'violation', 'EXECUTION_CLOSURE_PIT', executionClosureVector],
    ['execution-closure-definition-substitution', executionClosureDefinitionSubstitution, 'violation', 'EXECUTION_CLOSURE_DEFINITION', executionClosureVector],
    ['execution-closure-fifo-skip', executionClosureFifoSkip, 'violation', 'EXECUTION_CLOSURE_SELECTION', executionClosureVector],
    ['execution-closure-fee-conservation', executionClosureFeeMismatch, 'violation', 'EXECUTION_CLOSURE_FEE', executionClosureVector],
    ['execution-closure-fee-definition-substitution', executionClosureFeeDefinitionSubstitution, 'violation', 'EXECUTION_CLOSURE_FEE', executionClosureVector],
    ['execution-closure-allocation-context-substitution', executionClosureAllocationContextSubstitution, 'violation', 'EXECUTION_CLOSURE_ALLOCATION', executionClosureVector],
    ['lot-state-extra-open-lot', lotStateExtraOpenLot, 'violation', 'LOT_STATE_SET', lotStateVector],
    ['lot-state-extra-allocation', lotStateExtraAllocation, 'violation', 'LOT_STATE_ALLOCATION_SET', lotStateVector],
    ['lot-state-extra-execution-closure', lotStateExtraExecutionClosure, 'violation', 'LOT_STATE_EXECUTION_SET', lotStateVector],
    ['lot-state-instrument-substitution', lotStateInstrumentSubstitution, 'violation', 'LOT_STATE_JOIN', lotStateVector],
    ['lot-state-allocation-definition-substitution', lotStateAllocationDefinitionSubstitution, 'violation', 'LOT_STATE_ALLOCATION_SET', lotStateVector],
    ['lot-state-external-snapshot', lotStateExternalSnapshot, 'violation', 'LOT_STATE_IDENTITY', lotStateVector],
    ['lot-state-zero-lot-retained', lotStateZeroLotRetained, 'violation', 'LOT_STATE_SET', lotStateVector],
    ['lot-state-probe-substitution', lotStateProbeSubstitution, 'violation', 'LOT_STATE_PROBE', lotStateVector],
    ['lot-state-late-input-context', lotStateLateInput, 'violation', 'LOT_STATE_INPUT', lotStateVector],
    ['lot-state-future-pit', lotStateFuturePit, 'violation', 'LOT_STATE_PIT', lotStateVector],
    ['lot-state-definition-substitution', lotStateDefinitionSubstitution, 'violation', 'LOT_STATE_POLICY', lotStateVector],
    ['lot-state-snapshot-quantity-substitution', lotStateSnapshotQuantitySubstitution, 'violation', 'LOT_STATE_REMAINING', lotStateVector],
    ['lot-state-execution-digest-substitution', lotStateExecutionDigestSubstitution, 'violation', 'LOT_STATE_EXECUTION_SET', lotStateVector],
    ['lot-state-opening-quantity-substitution', lotStateOpeningQuantitySubstitution, 'violation', 'LOT_STATE_JOIN', lotStateVector],
    ['lot-state-quotation-substitution', lotStateQuotationSubstitution, 'violation', 'LOT_STATE_JOIN', lotStateVector],
    ['pnl-snapshot-substitution', pnlSnapshotSubstitution, 'violation', 'PNL_JOIN', pnlVector],
    ['pnl-definition-substitution', pnlDefinitionSubstitution, 'violation', 'PNL_VALUATION_CONTEXT_INVENTORY', pnlVector],
    ['pnl-quotation-substitution', pnlQuotationSubstitution, 'violation', 'PNL_VALUATION_CONTEXT_INVENTORY', pnlVector],
    ['pnl-calculation-context-substitution', pnlCalculationContextSubstitution, 'violation', 'PNL_VALUATION_CONTEXT_OUTPUT', pnlVector],
    ['pnl-generating-run-substitution', pnlGeneratingRunSubstitution, 'violation', 'PNL_VALUATION_CONTEXT_OUTPUT', pnlVector],
    ['pnl-open-lot-digest-substitution', pnlOpenLotDigestSubstitution, 'violation', 'PNL_VALUATION_CONTEXT_OUTPUT', pnlVector],
    ['pnl-allocation-digest-substitution', pnlAllocationDigestSubstitution, 'violation', 'PNL_VALUATION_CONTEXT_OUTPUT', pnlVector],
    ['pnl-valuation-value-substitution', pnlValuationValueSubstitution, 'violation', 'PNL_VALUE_JOIN', pnlVector],
    ['pnl-state-basis-substitution', pnlStateBasisSubstitution, 'violation', 'PNL_VALUE_JOIN', pnlVector],
    ['pnl-late-conversion-context', pnlLateConversionContext, 'violation', 'PNL_CONVERSION_CONTEXT', pnlVector],
    ['pnl-late-valuation-input', pnlLateValuationInput, 'violation', 'PNL_VALUATION_CONTEXT', pnlVector],
    ['pnl-future-valuation-pit', pnlFutureValuationPit, 'violation', 'PNL_VALUATION_CONTEXT', pnlVector],
    ['pnl-currency-substitution', pnlCurrencySubstitution, 'violation', 'PNL_VALUATION_CONTEXT_OUTPUT', pnlVector],
    ['pnl-future-state', pnlFutureState, 'violation', 'PNL_PIT', pnlVector],
    ['pnl-definition-quotation-substitution', pnlDefinitionQuotationSubstitution, 'violation', 'PNL_VALUATION_CONTEXT_INVENTORY', pnlVector],
    ['pnl-price-quotation-substitution', pnlPriceQuotationSubstitution, 'violation', 'PNL_JOIN', pnlVector],
    ['pnl-conversion-header-substitution', pnlConversionHeaderSubstitution, 'violation', 'PNL_CONVERSION_CONTEXT', pnlVector],
    ['opening-allocation-duplicate', openingAllocationDuplicate, 'violation', 'OPENING_ALLOCATION_XONE', openingAllocationVector],
    ['opening-allocation-definition-substitution', openingAllocationDefinitionSubstitution, 'violation', 'OPENING_ALLOCATION_JOIN', openingAllocationVector],
    ['opening-allocation-context-substitution', openingAllocationContextSubstitution, 'violation', 'OPENING_ALLOCATION_JOIN', openingAllocationVector],
    ['opening-allocation-unit-substitution', openingAllocationUnitSubstitution, 'violation', 'OPENING_ALLOCATION_JOIN', openingAllocationVector],
    ['opening-allocation-execution-substitution', openingAllocationExecutionSubstitution, 'violation', 'OPENING_ALLOCATION_JOIN', openingAllocationVector],
    ['opening-allocation-instrument-substitution', openingAllocationInstrumentSubstitution, 'violation', 'OPENING_ALLOCATION_JOIN', openingAllocationVector],
    ['opening-allocation-listing-substitution', openingAllocationListingSubstitution, 'violation', 'OPENING_ALLOCATION_JOIN', openingAllocationVector],
    ['opening-allocation-quotation-substitution', openingAllocationQuotationSubstitution, 'violation', 'OPENING_ALLOCATION_JOIN', openingAllocationVector],
    ['opening-allocation-side-substitution', openingAllocationSideSubstitution, 'violation', 'OPENING_ALLOCATION_JOIN', openingAllocationVector],
    ['opening-allocation-future', openingAllocationFuture, 'violation', 'OPENING_ALLOCATION_JOIN', openingAllocationVector],
    ['reconciliation-quantity-mismatch', reconciliationQuantityMismatch, 'accepted', null, reconciliationVector],
    ['reconciliation-signed-external-position', reconciliationExternalPosition, 'accepted', null, reconciliationVector],
    ['reconciliation-missing-external-quantity', reconciliationMissingExternalQuantity, 'violation', 'RECONCILIATION_ABSENCE_UNPROVEN', reconciliationVector],
    ['reconciliation-missing-derived-quantity', reconciliationMissingDerivedQuantity, 'violation', 'RECONCILIATION_ABSENCE_UNPROVEN', reconciliationVector],
    ['reconciliation-basis-match', reconciliationBasisMatched, 'accepted', null, reconciliationVector],
    ['reconciliation-basis-mismatch', reconciliationBasisMismatch, 'accepted', null, reconciliationVector],
    ['reconciliation-basis-definition-substitution', reconciliationBasisDefinitionSubstitution, 'violation', 'RECONCILIATION_BASIS_DEFINITION', reconciliationVector],
    ['reconciliation-missing-external-basis', reconciliationMissingExternalBasis, 'violation', 'RECONCILIATION_ABSENCE_UNPROVEN', reconciliationVector],
    ['reconciliation-missing-derived-basis', reconciliationMissingDerivedBasis, 'violation', 'RECONCILIATION_ABSENCE_UNPROVEN', reconciliationVector],
    ['reconciliation-external-snapshot-type-conflict', reconciliationExternalTypeConflict, 'violation', 'RECONCILIATION_BRANCH', reconciliationVector],
    ['reconciliation-subject-digest-substitution', reconciliationSubjectDigestSubstitution, 'violation', 'RECONCILIATION_SUBJECT_DIGEST', reconciliationVector],
    ['reconciliation-account-substitution', reconciliationAccountSubstitution, 'violation', 'RECONCILIATION_CANDIDATE_GRAPH', reconciliationVector],
    ['reconciliation-instrument-substitution', reconciliationInstrumentSubstitution, 'violation', 'RECONCILIATION_CANDIDATE_GRAPH', reconciliationVector],
    ['reconciliation-listing-substitution', reconciliationListingSubstitution, 'violation', 'RECONCILIATION_CANDIDATE_GRAPH', reconciliationVector],
    ['reconciliation-unit-substitution', reconciliationUnitSubstitution, 'violation', 'RECONCILIATION_CANDIDATE_GRAPH', reconciliationVector],
    ['reconciliation-external-source-substitution', reconciliationExternalSourceSubstitution, 'violation', 'RECONCILIATION_SOURCE_KIND', reconciliationVector],
    ['reconciliation-future-external-input', reconciliationFutureExternal, 'violation', 'RECONCILIATION_CANDIDATE_GRAPH', reconciliationVector],
    ['reconciliation-future-pit-request', reconciliationPitSubstitution, 'violation', 'RECONCILIATION_PIT', reconciliationVector],
    ['reconciliation-context-semantic-substitution', reconciliationContextSemanticSubstitution, 'violation', 'RECONCILIATION_CONTEXT', reconciliationVector],
    ['reconciliation-late-context', reconciliationLateContext, 'violation', 'RECONCILIATION_CONTEXT', reconciliationVector],
    ['reconciliation-generating-run-substitution', reconciliationGeneratingRunSubstitution, 'violation', 'RECONCILIATION_CONTEXT', reconciliationVector],
    ['reconciliation-kind-substitution', reconciliationWrongKind, 'violation', 'RECONCILIATION_KIND', reconciliationVector],
    ['reconciliation-basis-currency-substitution', reconciliationBasisCurrencySubstitution, 'violation', 'RECONCILIATION_CANDIDATE_GRAPH', reconciliationVector],
    ['reconciliation-hidden-external-candidate', reconciliationHiddenExternalCandidate, 'violation', 'RECONCILIATION_CLOSURE', reconciliationVector],
    ['reconciliation-extra-eligible-candidate', reconciliationExtraEligibleCandidate, 'violation', 'RECONCILIATION_CANDIDATE_GRAPH', reconciliationVector],
    ['reconciliation-candidate-count-substitution', reconciliationCandidateCountSubstitution, 'violation', 'RECONCILIATION_CLOSURE', reconciliationVector],
    ['reconciliation-input-inventory-omission', reconciliationInputInventoryOmission, 'violation', 'RECONCILIATION_INPUT', reconciliationVector],
    ['reconciliation-probe-semantic-substitution', reconciliationProbeSemanticSubstitution, 'violation', 'RECONCILIATION_PROBE', reconciliationVector],
    ['reconciliation-candidate-graph-third-source', reconciliationCandidateGraphThirdSource, 'violation', 'RECONCILIATION_CANDIDATE_GRAPH', reconciliationVector],
    ['reconciliation-candidate-graph-record-omission', reconciliationCandidateGraphOmission, 'violation', 'RECONCILIATION_CANDIDATE_GRAPH', reconciliationVector],
    ['reconciliation-external-manifest-incomplete-response', reconciliationExternalManifestIncomplete, 'violation', 'RECONCILIATION_EXTERNAL_MANIFEST', reconciliationVector],
    ['reconciliation-external-manifest-page-omission', reconciliationExternalManifestPageOmission, 'violation', 'RECONCILIATION_EXTERNAL_MANIFEST', reconciliationVector],
    ['reconciliation-external-page-record-omission', reconciliationExternalPageRecordOmission, 'violation', 'RECONCILIATION_EXTERNAL_MANIFEST', reconciliationVector],
    ['reconciliation-derived-manifest-run-substitution', reconciliationDerivedManifestRunSubstitution, 'violation', 'RECONCILIATION_DERIVED_MANIFEST', reconciliationVector],
    ['reconciliation-query-definition-substitution', reconciliationQueryDefinitionSubstitution, 'violation', 'RECONCILIATION_QUERY', reconciliationVector],
    ['reconciliation-query-tool-lock-substitution', reconciliationQueryToolSubstitution, 'violation', 'RECONCILIATION_QUERY', reconciliationVector],
    ['reconciliation-knowledge-after-availability', reconciliationKnowledgeAfterAvailability, 'violation', 'HOLDING_TEMPORAL', reconciliationVector],
    ['reconciliation-deleted-candidate-with-locked-inventory', reconciliationDeletedCandidate, 'violation', 'RECONCILIATION_CANDIDATE_GRAPH', reconciliationVector],
    ['reconciliation-expired-external-candidate', reconciliationExpiredExternal, 'violation', 'RECONCILIATION_CANDIDATE_GRAPH', reconciliationVector],
    ['reconciliation-expired-listing-candidate', reconciliationExpiredListing, 'violation', 'POSITION_LISTING', reconciliationVector],
  );

  const positionLotVector = vectors.vectors.find((row) => row.validatorId === 'PositionLotContract');
  if (!positionLotVector) throw new Error('PositionLot semantic-boundary seed is missing');
  const positionLotLegacy = decodeCanonicalOrdersPortfolioScenario(
    positionLotVector.accepted.scenario,
    positionLotVector.validatorId,
    inputContractArtifact.value,
  );
  const encodedPositionLot = (mutate) => {
    const legacy = structuredClone(positionLotLegacy);
    mutate(legacy);
    return encodeCanonicalOrdersPortfolioScenario(positionLotVector.validatorId, legacy);
  };
  const openingPriceSubstitution = encodedPositionLot(() => {});
  openingPriceSubstitution.records.find((row) => row.typeIri === TYPES.Execution).executionPrice.amount = '4.000000';
  const openingQuotationSubstitution = encodedPositionLot(() => {});
  openingQuotationSubstitution.records.find((row) => row.typeIri === TYPES.CostBasisCalculationDefinition)
    .costBasisDefinitionQuotationContract = 'https://axiolune.ai/data/quotation/other/version/0';
  const openingHalfEven = encodedPositionLot((legacy) => {
    legacy.originalQuantityMicros = 5;
    legacy.executionPriceMicros = 500_000;
    legacy.openingGrossMicros = 2;
    legacy.openingCostBasisMicros = 2;
  });
  const openingHalfUp = structuredClone(openingHalfEven);
  const openingHalfUpDefinition = openingHalfUp.records.find((row) => row.typeIri === TYPES.CostBasisCalculationDefinition);
  const openingHalfUpArtifact = openingHalfUp.artifacts.find((row) => row.artifactRef.iri === openingHalfUpDefinition.roundingPolicyRef);
  openingHalfUpArtifact.payload.mode = 'half-up';
  openingHalfUpArtifact.artifactDigest = sha256(jcsBytes(openingHalfUpArtifact.payload));
  openingHalfUpDefinition.roundingPolicyDigest = openingHalfUpArtifact.artifactDigest;
  const openingCross = (direction) => encodedPositionLot((legacy) => {
    legacy.executionCurrency = direction === 'baseToQuote' ? 'USD' : 'EUR';
    legacy.basisCurrency = direction === 'baseToQuote' ? 'EUR' : 'USD';
    legacy.costBasisDefinition.basisCurrency = legacy.basisCurrency;
    legacy.openingGrossMicros = direction === 'baseToQuote' ? 12_000_000 : 3_000_000;
    legacy.openingCostBasisMicros = legacy.openingGrossMicros;
    legacy.fxConversion = {
      baseCurrency: 'USD',
      direction,
      inputContext: structuredClone(fxContext),
      inputCurrency: direction === 'baseToQuote' ? 'USD' : 'EUR',
      outputCurrency: direction === 'baseToQuote' ? 'EUR' : 'USD',
      quoteCurrency: 'EUR',
      ratePpm: 2_000_000,
    };
  });
  const openingBaseCross = openingCross('baseToQuote');
  const openingFxInput = structuredClone(openingBaseCross);
  openingFxInput.records.find((row) => row.typeIri === TYPES.FXConversion).inputMoney.amount = '5.000000';
  const openingFxRate = structuredClone(openingBaseCross);
  openingFxRate.records.find((row) => row.typeIri === TYPES.FXRateObservation).fxRate.numericValue = '3.000000';
  const openingFxReverse = structuredClone(openingBaseCross);
  openingFxReverse.records.find((row) => row.typeIri === TYPES.FXConversion).conversionOpeningLot =
    'https://axiolune.ai/data/lot/other/version/0';
  const openingFxFuture = structuredClone(openingBaseCross);
  openingFxFuture.records.find((row) => row.typeIri === TYPES.FXRateObservation).knowledgeFrom = '2025-01-02T00:00:00Z';
  const openingFxContext = structuredClone(openingBaseCross);
  const openingContextFx = openingFxContext.records.find((row) => row.typeIri === TYPES.FXConversion);
  const openingContextArtifact = openingFxContext.artifacts.find((row) => row.artifactRef.iri === openingContextFx.inputContextRef);
  openingContextArtifact.payload.completedAt = '2025-01-02T00:00:00Z';
  openingContextArtifact.artifactDigest = sha256(jcsBytes(openingContextArtifact.payload));
  openingContextFx.inputContextRecordDigest = openingContextArtifact.artifactDigest;
  const openingListingInstrumentSubstitution = encodedPositionLot(() => {});
  openingListingInstrumentSubstitution.records.find(
    (row) => row.typeIri === TYPES.InstrumentListing,
  ).listedInstrument =
    'https://axiolune.ai/data/instrument/runtime-other/version/0';
  const openingExecutionListingSubstitution = encodedPositionLot(() => {});
  openingExecutionListingSubstitution.records.find(
    (row) => row.typeIri === TYPES.Execution,
  ).executionListing =
    'https://axiolune.ai/data/listing/runtime-other/version/0';
  const openingQuotationListingSubstitution = encodedPositionLot(() => {});
  openingQuotationListingSubstitution.records.find(
    (row) => row.typeIri === TYPES.DirectUnitPriceQuotationContract,
  ).quotationListingContext =
    'https://axiolune.ai/data/listing/runtime-other/version/0';
  const openingFutureListing = encodedPositionLot(() => {});
  openingFutureListing.records.find(
    (row) => row.typeIri === TYPES.InstrumentListing,
  ).availableFrom = '2025-01-02T00:00:00Z';

  semanticCases.push(
    ['opening-price-substitution', openingPriceSubstitution, 'violation', 'POSITION_LOT_GROSS'],
    ['opening-quotation-substitution', openingQuotationSubstitution, 'violation', 'POSITION_LOT_JOIN'],
    ['opening-half-even-tie', openingHalfEven, 'accepted', null],
    ['opening-half-up-policy-replay', openingHalfUp, 'violation', 'POSITION_LOT_GROSS'],
    ['opening-fx-base-to-quote', openingBaseCross, 'accepted', null],
    ['opening-fx-quote-to-base', openingCross('quoteToBase'), 'accepted', null],
    ['opening-fx-input-substitution', openingFxInput, 'violation', 'POSITION_LOT_FX'],
    ['opening-fx-rate-substitution', openingFxRate, 'violation', 'POSITION_LOT_GROSS'],
    ['opening-fx-reverse-link', openingFxReverse, 'violation', 'POSITION_LOT_FX'],
    ['opening-fx-future-rate', openingFxFuture, 'violation', 'POSITION_LOT_FX'],
    ['opening-fx-late-context', openingFxContext, 'violation', 'POSITION_LOT_FX'],
    ['opening-listing-instrument-substitution', openingListingInstrumentSubstitution, 'violation', 'POSITION_LOT_JOIN'],
    ['opening-execution-listing-substitution', openingExecutionListingSubstitution, 'violation', 'POSITION_LOT_JOIN'],
    ['opening-quotation-listing-substitution', openingQuotationListingSubstitution, 'violation', 'POSITION_LOT_JOIN'],
    ['opening-future-listing', openingFutureListing, 'violation', 'POSITION_LOT_JOIN'],
  );
  for (const [
    caseId,
    scenario,
    expectedOutcome,
    expectedViolation,
    explicitVector,
    expectedEngineDetail,
  ] of semanticCases) {
    const vector = explicitVector
      || (caseId.startsWith('opening-') ? positionLotVector : valuationVector);
    const semanticRequest = {
      constraintIri: vector.constraintIri,
      scenario,
      schemaVersion: '1.0',
      validatorId: vector.validatorId,
    };
    const actual = vector.validatorId === RECONCILIATION_VALIDATOR_ID
      ? executeRequestWithReconciliationEvidence(
        semanticRequest,
        expectedOutcome === 'accepted' ? caseId : 'baseline',
      )
      : executeRequest(semanticRequest);
    let observed;
    if (expectedOutcome === 'engine-failure') observed = actual.code;
    else if (actual.status === 'completed') observed = actual.response.outcome === 'accepted'
      ? 'accepted' : actual.response.violation;
    else observed = actual.code;
    const pending = vector.execution.status === 'pending'
      && expectedOutcome !== 'engine-failure';
    const expected = pending
      ? vector.execution.pendingCode
      : expectedOutcome === 'accepted' ? 'accepted' : expectedViolation;
    if (pending && (actual.status !== 'completed'
        || actual.response.outcome !== 'violation')) {
      throw new Error(
        `${caseId} pending semantic control did not fail closed as a violation`,
      );
    }
    if (observed !== expected) {
      throw new Error(`${caseId} semantic-boundary control returned ${actual.status}/${observed}, expected ${expected}`);
    }
    if (!pending && expectedEngineDetail && actual.detail !== expectedEngineDetail) {
      throw new Error(
        `${caseId} failed for ${actual.detail || 'an unattributed reason'}, expected ${expectedEngineDetail}`,
      );
    }
    results.push({
      actual: observed,
      caseId,
      category: 'semanticBoundary',
      constraintIri: vector.constraintIri,
      expected,
      status: pending ? 'pending' : 'passed',
      validatorId: vector.validatorId,
    });
  }

  const seed = vectors.vectors[0];
  const eventStream = vectors.vectors.find((row) => row.validatorId === 'OrderEventStreamContract');
  const execution = vectors.vectors.find((row) => row.validatorId === 'ExecutionContract');
  if (!eventStream || !execution) throw new Error('canonical boundary control seeds are missing');
  const unknownPrivate = structuredClone(execution.accepted.scenario);
  unknownPrivate.records.find((row) => row.versionIri === unknownPrivate.focusVersionIri).privateExecutionAccount = 'https://axiolune.ai/data/account/1';
  const missingRequired = structuredClone(eventStream.accepted.scenario);
  delete missingRequired.records.find((row) => row.versionIri === missingRequired.focusVersionIri).providerStreamId;
  const wrongReferenceMode = structuredClone(execution.accepted.scenario);
  wrongReferenceMode.records.find((row) => row.versionIri === wrongReferenceMode.focusVersionIri).executionAccount = 'https://axiolune.ai/data/account/1/version/0';
  const wrongRoleTarget = structuredClone(execution.accepted.scenario);
  const wrongRoleFocus = wrongRoleTarget.records.find((row) => row.versionIri === wrongRoleTarget.focusVersionIri);
  wrongRoleFocus.executionOrderIntent = wrongRoleFocus.executionQuotationContract;
  const malformedStructuredValue = structuredClone(execution.accepted.scenario);
  delete malformedStructuredValue.records.find((row) => row.versionIri === malformedStructuredValue.focusVersionIri).executionPrice.currency;
  const invalidCalendarInstant = structuredClone(execution.accepted.scenario);
  invalidCalendarInstant.records.find(
    (row) => row.versionIri === invalidCalendarInstant.focusVersionIri,
  ).availableFrom = '2025-02-30T00:00:00Z';
  const unboundConstraintIri = 'https://axiolune.ai/ontology/finance/orders-execution/UnboundCustom';
  const controls = [
    ['unbound-constraint', 'dispatchAttribution', unboundConstraintIri, seed.validatorId, executeRequest({ constraintIri: unboundConstraintIri, scenario: seed.accepted.scenario, schemaVersion: '1.0', validatorId: seed.validatorId }), 'WORKER_EXIT'],
    ['binding-tamper', 'dispatchAttribution', seed.constraintIri, 'FeeContract', executeRequest({ constraintIri: seed.constraintIri, scenario: seed.accepted.scenario, schemaVersion: '1.0', validatorId: 'FeeContract' }), 'WORKER_EXIT'],
    ['legacy-private-scenario', 'inputContract', execution.constraintIri, execution.validatorId, executeRequest({ constraintIri: execution.constraintIri, scenario: { account: { logicalIri: 'https://axiolune.ai/data/account/1', referenceMode: 'logical' } }, schemaVersion: '1.0', validatorId: execution.validatorId }), 'WORKER_EXIT'],
    ['unknown-private-field', 'inputContract', execution.constraintIri, execution.validatorId, executeRequest({ constraintIri: execution.constraintIri, scenario: unknownPrivate, schemaVersion: '1.0', validatorId: execution.validatorId }), 'WORKER_EXIT'],
    ['missing-official-required-field', 'inputContract', eventStream.constraintIri, eventStream.validatorId, executeRequest({ constraintIri: eventStream.constraintIri, scenario: missingRequired, schemaVersion: '1.0', validatorId: eventStream.validatorId }), 'WORKER_EXIT'],
    ['wrong-reference-mode', 'inputContract', execution.constraintIri, execution.validatorId, executeRequest({ constraintIri: execution.constraintIri, scenario: wrongReferenceMode, schemaVersion: '1.0', validatorId: execution.validatorId }), 'WORKER_EXIT'],
    ['wrong-role-target-type', 'inputContract', execution.constraintIri, execution.validatorId, executeRequest({ constraintIri: execution.constraintIri, scenario: wrongRoleTarget, schemaVersion: '1.0', validatorId: execution.validatorId }), 'WORKER_EXIT'],
    ['malformed-structured-value', 'inputContract', execution.constraintIri, execution.validatorId, executeRequest({ constraintIri: execution.constraintIri, scenario: malformedStructuredValue, schemaVersion: '1.0', validatorId: execution.validatorId }), 'WORKER_EXIT'],
    ['invalid-calendar-instant', 'inputContract', execution.constraintIri, execution.validatorId, executeRequest({ constraintIri: execution.constraintIri, scenario: invalidCalendarInstant, schemaVersion: '1.0', validatorId: execution.validatorId }), 'WORKER_EXIT'],
    ['timeout', 'engineFailure', seed.constraintIri, seed.validatorId, executeRequest({ constraintIri: seed.constraintIri, mode: 'hang', scenario: {}, schemaVersion: '1.0', validatorId: seed.validatorId }, { timeoutMs: 200 }), 'TIME_LIMIT'],
    ['oversize-input', 'engineFailure', seed.constraintIri, seed.validatorId, executeRequest({ constraintIri: seed.constraintIri, scenario: { padding: 'x'.repeat(MAX_INPUT_BYTES + 1) }, schemaVersion: '1.0', validatorId: seed.validatorId }), 'INPUT_LIMIT'],
    ['oversize-output-cap', 'engineFailure', seed.constraintIri, seed.validatorId, executeRequest({ constraintIri: seed.constraintIri, scenario: seed.accepted.scenario, schemaVersion: '1.0', validatorId: seed.validatorId }, { maxOutputBytes: 32 }), 'OUTPUT_LIMIT'],
  ];
  for (const [caseId, category, constraintIri, validatorId, actual, expected] of controls) {
    if (actual.code !== expected) throw new Error(`${caseId} fail-closed control returned ${actual.status}/${actual.code}`);
    results.push({ actual: actual.code, caseId, category, constraintIri, expected, status: 'passed', validatorId });
  }
  const assuranceKeys = ['childProcessDenied', 'fileWriteDenied', 'networkDenied', 'permissionModelEnabled', 'unrelatedFileReadDenied', 'workerCreationDenied'];
  if (!permissionAssurance || assuranceKeys.some((key) => permissionAssurance[key] !== true)) {
    throw new Error(`restricted worker assurance failed: ${canonicalJcs(permissionAssurance)}`);
  }
  const pendingResults = results.filter((row) => row.status === 'pending');
  const pending = {
    codes: [...new Set(pendingResults.map((row) => row.actual))].sort(compareUtf8),
    constraintIris: [...new Set(pendingResults.map((row) => row.constraintIri))]
      .sort(compareUtf8),
    requirements: [...new Set(vectors.vectors
      .filter((row) => row.execution.status === 'pending')
      .map((row) => row.execution.pendingRequirement))]
      .sort(compareUtf8),
    resultCount: pendingResults.length,
  };
  const componentEligible = pending.resultCount === 0;
  return {
    artifacts: {
      closureDigest: sha256(closureArtifact.bytes), closureRef: { kind: 'path', path: path.relative(ROOT, PATHS.closure).split(path.sep).join('/'), root: 'sourceTree' },
      canonicalAdapterDigest: sha256(fs.readFileSync(PATHS.adapter)), canonicalAdapterRef: { kind: 'path', path: path.relative(ROOT, PATHS.adapter).split(path.sep).join('/'), root: 'sourceTree' },
      canonicalizationDigest: sha256(fs.readFileSync(PATHS.canonicalization)), canonicalizationRef: { kind: 'path', path: path.relative(ROOT, PATHS.canonicalization).split(path.sep).join('/'), root: 'sourceTree' },
      discoveryDigest: sha256(profileArtifact.bytes), discoveryRef: { kind: 'path', path: path.relative(ROOT, PATHS.discovery).split(path.sep).join('/'), root: 'sourceTree' },
      exactArithmeticDigest: sha256(fs.readFileSync(PATHS.arithmetic)), exactArithmeticRef: { kind: 'path', path: path.relative(ROOT, PATHS.arithmetic).split(path.sep).join('/'), root: 'sourceTree' },
      inputContractDigest: sha256(inputContractArtifact.bytes), inputContractRef: { kind: 'path', path: path.relative(ROOT, PATHS.inputContract).split(path.sep).join('/'), root: 'sourceTree' },
      implementationDigest: sha256(fs.readFileSync(PATHS.implementation)), implementationRef: { kind: 'path', path: path.relative(ROOT, PATHS.implementation).split(path.sep).join('/'), root: 'sourceTree' },
      outputContractDigest: sha256(outputContractArtifact.bytes), outputContractRef: { kind: 'path', path: path.relative(ROOT, PATHS.outputContract).split(path.sep).join('/'), root: 'sourceTree' },
      vectorDigest: sha256(vectorArtifact.bytes), vectorRef: { kind: 'path', path: path.relative(ROOT, PATHS.vectors).split(path.sep).join('/'), root: 'sourceTree' },
      workerDigest: sha256(fs.readFileSync(PATHS.worker)), workerRef: { kind: 'path', path: path.relative(ROOT, PATHS.worker).split(path.sep).join('/'), root: 'sourceTree' },
    },
    componentEligible,
    discoveredConstraints: profile.constraints.map((row) => ({ constraintIri: row.constraintIri, dispatchDigest: row.dispatchDigest, expressionDigest: row.expressionDigest, implementationDigest: row.implementationDigest, targetElement: row.targetElement, validatorId: row.validatorId })),
    executionBoundary: {
      exactReadAllowlist,
      exactReadAllowlistCount: exactReadAllowlist.length,
      maxInputBytes: MAX_INPUT_BYTES,
      maxOldSpaceMiB: 64,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      nodePermissionModel: true,
      timeoutMs: TIMEOUT_MS,
      trustedRepositoryImplementationOnly: true,
    },
    outcome: componentEligible ? 'passed' : 'pending',
    pending,
    permissionAssurance,
    profileRef: PROFILE_REF,
    runtimeId: profile.runtimeId,
    schemaVersion: '1.0',
    vectorResults: results,
  };
}

function parseArgs(argv) {
  if (argv.length === 2 && argv[0] === '--output-dir') return path.resolve(argv[1]);
  throw new Error('Usage: node scripts/domain/run-orders-portfolio-custom-runtime.cjs --output-dir <directory>');
}

function main(argv) {
  const outputDirectory = parseArgs(argv);
  const evidence = createEvidence();
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, EVIDENCE_NAME), jcsBytes(evidence));
  if (!evidence.componentEligible || evidence.outcome !== 'passed') {
    process.stderr.write(
      `Orders/Portfolio Custom runtime: PENDING (constraints=35, vectors=${evidence.vectorResults.length}, pending=${evidence.pending.resultCount})\n`,
    );
    process.exitCode = 2;
    return;
  }
  process.stdout.write(
    `Orders/Portfolio Custom runtime: PASS (constraints=35, vectors=${evidence.vectorResults.length})\n`,
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
  executeRequest,
  executeRequestWithReconciliationEvidence,
  readStrictJcs,
  validateProfile,
  validateVectors,
  verifyClosure,
};
