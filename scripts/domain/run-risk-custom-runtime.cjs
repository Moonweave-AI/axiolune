#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const YAML = require('yaml');
const {
  canonicalJcs,
} = require('./lib/strict-source-locator.cjs');
const {
  RISK_CUSTOM_VALIDATORS,
  bucketDigest,
  mutate,
  riskConstraintDispatchDescriptor,
} = require('./lib/risk-v03-contract.cjs');
const {
  createRiskAdversarialCases,
} = require('./lib/risk-adversarial-cases.cjs');
const {
  TYPES,
  canonicalRiskInputContract,
} = require('./lib/risk-canonical-record-adapter.cjs');
const {
  authenticateSourceClaims,
  validateAuthenticatedSourceArtifacts,
} = require('./lib/post-trade-risk-source-artifact-inventory.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const PROFILE_REL = 'scripts/domain/risk-custom-profile/v0.3.0/discovery-contract.json';
const PROFILE_FILE = path.join(ROOT, ...PROFILE_REL.split('/'));
const WORKER_REL = 'scripts/domain/risk-custom-worker.cjs';
const WORKER_FILE = path.join(ROOT, ...WORKER_REL.split('/'));
const IMPLEMENTATION_REL = 'scripts/domain/lib/risk-v03-contract.cjs';
const IMPLEMENTATION_FILE = path.join(ROOT, ...IMPLEMENTATION_REL.split('/'));
const ADAPTER_REL = 'scripts/domain/lib/risk-canonical-record-adapter.cjs';
const ADAPTER_FILE = path.join(ROOT, ...ADAPTER_REL.split('/'));
const INPUT_CONTRACT_REL = 'scripts/domain/risk-custom-profile/v0.3.0/input-contract.json';
const INPUT_CONTRACT_FILE = path.join(ROOT, ...INPUT_CONTRACT_REL.split('/'));
const OUTPUT_CONTRACT_REL = 'scripts/domain/risk-custom-profile/v0.3.0/output-contract.json';
const OUTPUT_CONTRACT_FILE = path.join(ROOT, ...OUTPUT_CONTRACT_REL.split('/'));
const LOCATOR_REL = 'scripts/domain/lib/strict-source-locator.cjs';
const LOCATOR_FILE = path.join(ROOT, ...LOCATOR_REL.split('/'));
const SOURCE_INVENTORY_REL = 'scripts/domain/lib/post-trade-risk-source-artifact-inventory.cjs';
const SOURCE_INVENTORY_FILE = path.join(ROOT, ...SOURCE_INVENTORY_REL.split('/'));
const JSON_POINTER_EXTRACTOR_REL = 'scripts/domain/lib/json-pointer-source-extractor.cjs';
const JSON_POINTER_EXTRACTOR_FILE = path.join(ROOT, ...JSON_POINTER_EXTRACTOR_REL.split('/'));
const JSON_POINTER_PROFILE_REL = 'scripts/domain/reference-extractors/json-pointer-jcs-v1.json';
const JSON_POINTER_PROFILE_FILE = path.join(ROOT, ...JSON_POINTER_PROFILE_REL.split('/'));
const RUNTIME_EVIDENCE_REL = 'tests/m2/fixtures/risk-evidence-v1.json';
const RUNTIME_EVIDENCE_FILE = path.join(ROOT, ...RUNTIME_EVIDENCE_REL.split('/'));
const RETRACTION_EVIDENCE_REL = 'tests/m2/fixtures/risk-measurement-retraction-v1.json';
const RETRACTION_EVIDENCE_FILE = path.join(ROOT, ...RETRACTION_EVIDENCE_REL.split('/'));
const BUCKET_KEY_CONTRACT_REL = 'tests/m2/fixtures/risk-bucket-key-contract-v1.json';
const BUCKET_KEY_CONTRACT_FILE = path.join(ROOT, ...BUCKET_KEY_CONTRACT_REL.split('/'));
const WHOLE_FILE_PROFILE_REL = 'scripts/domain/reference-extractors/whole-file-v1.json';
const WHOLE_FILE_PROFILE_FILE = path.join(ROOT, ...WHOLE_FILE_PROFILE_REL.split('/'));
const ADVERSARIAL_CASES_REL = 'scripts/domain/lib/risk-adversarial-cases.cjs';
const ADVERSARIAL_CASES_FILE = path.join(ROOT, ...ADVERSARIAL_CASES_REL.split('/'));
const MODULE_FILE = path.join(ROOT, 'ontology', 'domain', 'finance', 'risk', 'module.yaml');
const POSITIVE_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'positive', 'risk-v03.yaml');
const NEGATIVE_FILE = path.join(ROOT, 'tests', 'm2', 'fixtures', 'negative', 'risk-v03.yaml');
const EVIDENCE_NAME = 'risk-custom-runtime-evidence.json';
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const TIMEOUT_MS = 1500;

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalScenario(value) {
  if (value?.schemaVersion !== '1.0' || !Array.isArray(value?.records)) {
    throw new Error('risk runtime accepts canonical authoring scenarios only');
  }
  const scenario = structuredClone(value);
  validateAuthenticatedSourceArtifacts(scenario);
  return scenario;
}

function reauthenticateMutatedScenario(value) {
  return authenticateSourceClaims(value, { namespace: 'risk-source' });
}

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

function validateProfile(profile, moduleDocument) {
  exactKeys(
    profile,
    ['schemaVersion', 'profileRef', 'runtimeId', 'constraints'],
    [],
    'profile',
  );
  if (profile.schemaVersion !== '1.0'
      || profile.profileRef !== PROFILE_REF
      || profile.runtimeId !== 'axiolune-risk-custom-runtime-v1') {
    throw new Error('risk Custom discovery profile identity is invalid');
  }
  if (!Array.isArray(profile.constraints) || profile.constraints.length !== 8) {
    throw new Error('risk Custom discovery profile must bind exactly eight constraints');
  }
  const discovered = Object.values(moduleDocument.domain?.constraints || {})
    .filter((constraint) => constraint.expression?.language === 'Custom')
    .sort((left, right) => Buffer.compare(
      Buffer.from(left.iri, 'utf8'),
      Buffer.from(right.iri, 'utf8'),
    ));
  if (discovered.length !== 8) {
    throw new Error(`risk module exposes ${discovered.length} Custom constraints; expected eight`);
  }
  let previous = null;
  for (const [index, row] of profile.constraints.entries()) {
    exactKeys(
      row,
      [
        'constraintIri',
        'dispatchDigest',
        'evaluatorId',
        'targetElement',
        'expressionDigest',
        'positiveFixtureId',
        'expectedViolation',
      ],
      ['negativeCaseId', 'inlineNegativeMutation'],
      `profile.constraints[${index}]`,
    );
    if ((Object.hasOwn(row, 'negativeCaseId') ? 1 : 0)
        + (Object.hasOwn(row, 'inlineNegativeMutation') ? 1 : 0) !== 1) {
      throw new Error(`${row.constraintIri} must select exactly one negative-vector branch`);
    }
    if (previous !== null && Buffer.compare(
      Buffer.from(previous, 'utf8'),
      Buffer.from(row.constraintIri, 'utf8'),
    ) >= 0) {
      throw new Error('risk Custom discovery rows must be strictly constraint-Iri sorted');
    }
    previous = row.constraintIri;
    const constraint = discovered[index];
    if (!constraint
        || constraint.iri !== row.constraintIri
        || constraint.targetElement !== row.targetElement) {
      throw new Error(`risk Custom discovery closure drift at ${row.constraintIri}`);
    }
    const expressionDigest = sha256(
      Buffer.from(canonicalJcs(constraint.expression), 'utf8'),
    );
    if (expressionDigest !== row.expressionDigest) {
      throw new Error(`risk Custom expression drift at ${row.constraintIri}`);
    }
    const dispatch = riskConstraintDispatchDescriptor(row.constraintIri);
    if (!RISK_CUSTOM_VALIDATORS.has(row.constraintIri)
        || row.evaluatorId !== dispatch.evaluatorId
        || row.dispatchDigest !== dispatch.dispatchDigest) {
      throw new Error(`risk Custom dispatch drift at ${row.constraintIri}`);
    }
    const bindings = (moduleDocument.domain?.constraintBindings || []).filter(
      (binding) => binding.constraintRef === row.constraintIri
        && binding.targetElement === row.targetElement,
    );
    if (bindings.length !== 1) {
      throw new Error(`${row.constraintIri} requires exactly one target binding`);
    }
  }
  return discovered;
}

function sanitizedEnvironment() {
  const environment = {};
  for (const name of ['SystemRoot', 'WINDIR']) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

function executeRequest(request, options = {}) {
  const input = Buffer.from(canonicalJcs(request), 'utf8');
  if (input.length > MAX_INPUT_BYTES) {
    return { status: 'input-rejected', code: 'INPUT_LIMIT' };
  }
  const result = childProcess.spawnSync(
    process.execPath,
    [
      '--permission',
      '--disable-sigusr1',
      '--no-addons',
      '--no-global-search-paths',
      '--max-old-space-size=64',
      `--allow-fs-read=${WORKER_FILE}`,
      `--allow-fs-read=${IMPLEMENTATION_FILE}`,
      `--allow-fs-read=${ADAPTER_FILE}`,
      `--allow-fs-read=${LOCATOR_FILE}`,
      `--allow-fs-read=${SOURCE_INVENTORY_FILE}`,
      `--allow-fs-read=${JSON_POINTER_EXTRACTOR_FILE}`,
      `--allow-fs-read=${JSON_POINTER_PROFILE_FILE}`,
      `--allow-fs-read=${WHOLE_FILE_PROFILE_FILE}`,
      `--allow-fs-read=${INPUT_CONTRACT_FILE}`,
      `--allow-fs-read=${OUTPUT_CONTRACT_FILE}`,
      `--allow-fs-read=${RUNTIME_EVIDENCE_FILE}`,
      `--allow-fs-read=${RETRACTION_EVIDENCE_FILE}`,
      `--allow-fs-read=${BUCKET_KEY_CONTRACT_FILE}`,
      WORKER_FILE,
    ],
    {
      cwd: ROOT,
      env: sanitizedEnvironment(),
      input,
      encoding: 'utf8',
      windowsHide: true,
      timeout: options.timeoutMs || TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    },
  );
  if (result.error && result.error.code === 'ETIMEDOUT') {
    return { status: 'timeout', code: 'TIME_LIMIT' };
  }
  if (result.error) {
    return { status: 'engine-failure', code: result.error.code || 'ENGINE_FAILURE' };
  }
  if (result.status !== 0) {
    return {
      status: 'engine-failure',
      code: 'WORKER_EXIT',
      detail: String(result.stderr || '').trim(),
    };
  }
  if (Buffer.byteLength(result.stdout || '', 'utf8') > MAX_OUTPUT_BYTES) {
    return { status: 'engine-failure', code: 'OUTPUT_LIMIT' };
  }
  try {
    const response = JSON.parse(result.stdout);
    if (result.stdout !== canonicalJcs(response)) {
      return { status: 'engine-failure', code: 'OUTPUT_JCS' };
    }
    exactKeys(
      response,
      [
        'assurance',
        'constraintIri',
        'dispatchDigest',
        'evaluatorId',
        'outcome',
        'schemaVersion',
        'violation',
      ],
      [],
      'worker response',
    );
    const dispatch = riskConstraintDispatchDescriptor(request.constraintIri);
    if (response.schemaVersion !== '1.0'
        || response.constraintIri !== request.constraintIri
        || response.evaluatorId !== request.evaluatorId
        || response.evaluatorId !== dispatch.evaluatorId
        || response.dispatchDigest !== dispatch.dispatchDigest) {
      return { status: 'engine-failure', code: 'OUTPUT_BINDING' };
    }
    return { status: 'completed', response };
  } catch {
    return { status: 'engine-failure', code: 'OUTPUT_PARSE' };
  }
}

function createEvidence(profileOverride = null) {
  const profileBytes = fs.readFileSync(PROFILE_FILE);
  const profile = profileOverride || JSON.parse(profileBytes.toString('utf8'));
  const inputContractBytes = fs.readFileSync(INPUT_CONTRACT_FILE);
  if (!inputContractBytes.equals(Buffer.from(canonicalJcs(canonicalRiskInputContract()), 'utf8'))) {
    throw new Error('risk Custom canonical input contract drift');
  }
  const outputContractBytes = fs.readFileSync(OUTPUT_CONTRACT_FILE);
  const outputContract = JSON.parse(outputContractBytes.toString('utf8'));
  if (outputContractBytes.toString('utf8') !== canonicalJcs(outputContract)
      || canonicalJcs(outputContract.fields) !== canonicalJcs([
        'assurance',
        'constraintIri',
        'dispatchDigest',
        'evaluatorId',
        'outcome',
        'schemaVersion',
        'violation',
      ])) {
    throw new Error('risk Custom canonical output contract drift');
  }
  const moduleDocument = YAML.parse(fs.readFileSync(MODULE_FILE, 'utf8'));
  validateProfile(profile, moduleDocument);
  const positive = YAML.parse(fs.readFileSync(POSITIVE_FILE, 'utf8'));
  const negative = YAML.parse(fs.readFileSync(NEGATIVE_FILE, 'utf8'));
  const positives = new Map((positive.fixtures || []).map((fixture) => [fixture.id, fixture]));
  const negatives = new Map((negative.cases || []).map((testCase) => [testCase.id, testCase]));
  const vectorResults = [];
  let assurance = null;

  for (const [rowIndex, row] of profile.constraints.entries()) {
    const positiveFixture = positives.get(row.positiveFixtureId);
    if (!positiveFixture) throw new Error(`missing positive fixture ${row.positiveFixtureId}`);
    const acceptedScenario = canonicalScenario(positiveFixture.instance);
    const positiveResult = executeRequest({
      constraintIri: row.constraintIri,
      evaluatorId: row.evaluatorId,
      scenario: acceptedScenario,
      schemaVersion: '1.0',
    });
    if (positiveResult.status !== 'completed'
        || positiveResult.response.outcome !== 'accepted'
        || positiveResult.response.violation !== null
        || positiveResult.response.evaluatorId !== row.evaluatorId
        || positiveResult.response.dispatchDigest !== row.dispatchDigest) {
      throw new Error(`${row.constraintIri} positive runtime vector failed`);
    }
    assurance = assurance || positiveResult.response.assurance;
    vectorResults.push({
      id: `${row.constraintIri.split('/').pop()}-positive`,
      constraintIri: row.constraintIri,
      category: 'positive',
      expected: 'accepted',
      actual: 'accepted',
      status: 'passed',
    });

    let negativeScenario;
    let negativeId;
    let negativeMutations;
    if (row.negativeCaseId) {
      const testCase = negatives.get(row.negativeCaseId);
      if (!testCase) throw new Error(`missing negative case ${row.negativeCaseId}`);
      const base = positives.get(testCase.baseFixtureId);
      if (!base) throw new Error(`missing negative base fixture ${testCase.baseFixtureId}`);
      negativeScenario = acceptedScenario;
      negativeMutations = testCase.mutations || [];
      for (const mutation of negativeMutations) {
        negativeScenario = mutate(negativeScenario, mutation);
      }
      negativeId = testCase.id;
      if (testCase.expectedViolation !== row.expectedViolation) {
        throw new Error(`${row.constraintIri} expected-violation join drift`);
      }
    } else {
      negativeMutations = [row.inlineNegativeMutation];
      negativeScenario = mutate(acceptedScenario, row.inlineNegativeMutation);
      negativeId = 'inline-schema-contract-negative';
    }
    if (!negativeMutations.some((mutation) => (
      /(?:^|\.)(?:sourceArtifactRef|sourceArtifactDigest|sourceLocator)(?:\.|$)/u
        .test(mutation.path)
    ))) {
      negativeScenario = reauthenticateMutatedScenario(negativeScenario);
    }
    const negativeResult = executeRequest({
      constraintIri: row.constraintIri,
      evaluatorId: row.evaluatorId,
      scenario: negativeScenario,
      schemaVersion: '1.0',
    });
    const actualViolation = negativeResult.response?.violation;
    if (negativeResult.status !== 'completed'
        || negativeResult.response.outcome !== 'rejected'
        || actualViolation !== row.expectedViolation) {
      throw new Error(
        `${row.constraintIri} negative runtime vector failed: `
          + `${negativeResult.status}/${String(actualViolation)}`,
      );
    }
    vectorResults.push({
      id: `${row.constraintIri.split('/').pop()}-${negativeId}`,
      constraintIri: row.constraintIri,
      category: 'violation',
      expected: row.expectedViolation,
      actual: actualViolation,
      status: 'passed',
    });

    const peer = profile.constraints[(rowIndex + 1) % profile.constraints.length];
    const crossDispatch = executeRequest({
      constraintIri: peer.constraintIri,
      evaluatorId: peer.evaluatorId,
      scenario: negativeScenario,
      schemaVersion: '1.0',
    });
    if (row.expectedViolation === 'definition-provenance'
        && crossDispatch.status === 'engine-failure'
        && crossDispatch.code === 'WORKER_EXIT') {
      vectorResults.push({
        id: `${row.constraintIri.split('/').pop()}-cross-dispatched-to-${peer.constraintIri.split('/').pop()}`,
        constraintIri: peer.constraintIri,
        category: 'dispatchAttribution',
        expected: 'WORKER_EXIT',
        actual: 'WORKER_EXIT',
        status: 'passed',
      });
      continue;
    }
    if (crossDispatch.status !== 'completed'
        || !['accepted', 'notApplicable'].includes(crossDispatch.response.outcome)
        || crossDispatch.response.violation !== null) {
      throw new Error(
        `${row.constraintIri} violation was incorrectly attributed by ${peer.constraintIri}: `
          + `${crossDispatch.status}/${String(crossDispatch.response?.violation)}`,
      );
    }
    vectorResults.push({
      id: `${row.constraintIri.split('/').pop()}-cross-dispatched-to-${peer.constraintIri.split('/').pop()}`,
      constraintIri: peer.constraintIri,
      category: 'dispatchAttribution',
      expected: crossDispatch.response.outcome,
      actual: crossDispatch.response.outcome,
      status: 'passed',
    });
  }

  const unbound = executeRequest({
    constraintIri: 'https://axiolune.ai/ontology/finance/risk/UnboundConstraint',
    evaluatorId: 'validateUnboundConstraint',
    scenario: canonicalScenario(positives.values().next().value.instance),
    schemaVersion: '1.0',
  });
  if (unbound.status !== 'engine-failure' || unbound.code !== 'WORKER_EXIT') {
    throw new Error('unbound constraint did not fail closed');
  }
  vectorResults.push({
    id: 'unbound-constraint',
    constraintIri: null,
    category: 'engineFailure',
    expected: 'WORKER_EXIT',
    actual: unbound.code,
    status: 'passed',
  });

  const wrongEvaluator = executeRequest({
    constraintIri: profile.constraints[0].constraintIri,
    evaluatorId: profile.constraints[1].evaluatorId,
    scenario: canonicalScenario(positives.values().next().value.instance),
    schemaVersion: '1.0',
  });
  if (wrongEvaluator.status !== 'engine-failure' || wrongEvaluator.code !== 'WORKER_EXIT') {
    throw new Error('constraint/evaluator mismatch did not fail closed');
  }
  vectorResults.push({
    id: 'wrong-evaluator-binding',
    constraintIri: profile.constraints[0].constraintIri,
    category: 'engineFailure',
    expected: 'WORKER_EXIT',
    actual: wrongEvaluator.code,
    status: 'passed',
  });

  const canonicalSeed = canonicalScenario(positives.values().next().value.instance);
  const canonicalBoundaryMutants = [
    {
      id: 'private-scopes-field',
      mutate(document) {
        document.records.find((record) => record.typeIri === TYPES.measurement).scopes = [];
      },
    },
    {
      id: 'private-money-slot',
      mutate(document) {
        const measurement = document.records.find((record) => record.typeIri === TYPES.measurement);
        measurement.money = measurement.measuredMoney;
        delete measurement.measuredMoney;
      },
    },
    {
      id: 'missing-required-pattern-source',
      mutate(document) {
        delete document.records.find((record) => record.typeIri === TYPES.measurement).source;
      },
    },
  ];
  for (const mutant of canonicalBoundaryMutants) {
    const scenario = structuredClone(canonicalSeed);
    mutant.mutate(scenario);
    const result = executeRequest({
      constraintIri: profile.constraints.at(-1).constraintIri,
      evaluatorId: profile.constraints.at(-1).evaluatorId,
      scenario,
      schemaVersion: '1.0',
    });
    if (result.status !== 'engine-failure' || result.code !== 'WORKER_EXIT') {
      throw new Error(`${mutant.id} did not fail the canonical record boundary`);
    }
    vectorResults.push({
      id: mutant.id,
      constraintIri: profile.constraints.at(-1).constraintIri,
      category: 'inputContract',
      expected: 'WORKER_EXIT',
      actual: result.code,
      status: 'passed',
    });
  }

  const adversarialCases = createRiskAdversarialCases({
    moneyScenario: positives.get('cq-r1-money-measurement-within-limit').instance,
    bucketScenario: positives.get('cq-r1-bucketed-greeks-within-limit').instance,
    bucketDigest,
  });
  for (const adversarial of adversarialCases) {
    const row = profile.constraints.find(
      (candidate) => candidate.constraintIri === adversarial.constraintIri,
    );
    if (!row) throw new Error(`${adversarial.id} has no restricted-runtime dispatch row`);
    const result = executeRequest({
      constraintIri: row.constraintIri,
      evaluatorId: row.evaluatorId,
      scenario: reauthenticateMutatedScenario(adversarial.scenario),
      schemaVersion: '1.0',
    });
    if (result.status !== 'completed'
        || result.response.outcome !== 'rejected'
        || result.response.violation !== adversarial.expectedViolation) {
      throw new Error(
        `${adversarial.id} adversarial runtime vector failed: `
          + `${result.status}/${String(result.response?.violation)}`,
      );
    }
    vectorResults.push({
      id: adversarial.id,
      constraintIri: row.constraintIri,
      category: 'adversarialEvidence',
      expected: adversarial.expectedViolation,
      actual: result.response.violation,
      status: 'passed',
    });
  }

  const timeout = executeRequest(
    {
      constraintIri: profile.constraints[0].constraintIri,
      evaluatorId: profile.constraints[0].evaluatorId,
      mode: 'hang',
      scenario: {},
      schemaVersion: '1.0',
    },
    { timeoutMs: 250 },
  );
  if (timeout.status !== 'timeout') throw new Error('infinite runtime did not time out');
  vectorResults.push({
    id: 'infinite-runtime-timeout',
    constraintIri: profile.constraints[0].constraintIri,
    category: 'engineFailure',
    expected: 'TIME_LIMIT',
    actual: timeout.code,
    status: 'passed',
  });

  const oversize = executeRequest({
    constraintIri: profile.constraints[0].constraintIri,
    evaluatorId: profile.constraints[0].evaluatorId,
    scenario: { padding: 'x'.repeat(MAX_INPUT_BYTES + 1) },
    schemaVersion: '1.0',
  });
  if (oversize.status !== 'input-rejected') throw new Error('oversize input did not fail closed');
  vectorResults.push({
    id: 'oversize-input',
    constraintIri: profile.constraints[0].constraintIri,
    category: 'engineFailure',
    expected: 'INPUT_LIMIT',
    actual: oversize.code,
    status: 'passed',
  });

  const assuranceFields = [
    'permissionModelEnabled',
    'unrelatedFileReadDenied',
    'fileWriteDenied',
    'childProcessDenied',
    'workerCreationDenied',
    'networkDenied',
  ];
  if (!assurance || assuranceFields.some((field) => assurance[field] !== true)) {
    throw new Error(`risk runtime permission assurance failed: ${canonicalJcs(assurance)}`);
  }

  return {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    runtimeId: profile.runtimeId,
    outcome: 'passed',
    componentEligible: true,
    executionBoundary: {
      implementationTrust: 'reviewed-repository-code-only',
      untrustedCodeSandbox: false,
      inputContract: 'strict-json-data-only',
      nodePermissionModel: true,
      timeoutMs: TIMEOUT_MS,
      maxInputBytes: MAX_INPUT_BYTES,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxOldSpaceMiB: 64,
    },
    permissionAssurance: assurance,
    artifacts: {
      adversarialCasesRef: {
        kind: 'path',
        root: 'sourceTree',
        path: ADVERSARIAL_CASES_REL,
      },
      adversarialCasesDigest: sha256(fs.readFileSync(ADVERSARIAL_CASES_FILE)),
      canonicalAdapterRef: {
        kind: 'path',
        root: 'sourceTree',
        path: ADAPTER_REL,
      },
      canonicalAdapterDigest: sha256(fs.readFileSync(ADAPTER_FILE)),
      runtimeEvidenceRef: {
        kind: 'path',
        root: 'sourceTree',
        path: RUNTIME_EVIDENCE_REL,
      },
      runtimeEvidenceDigest: sha256(fs.readFileSync(RUNTIME_EVIDENCE_FILE)),
      retractionEvidenceRef: {
        kind: 'path',
        root: 'sourceTree',
        path: RETRACTION_EVIDENCE_REL,
      },
      retractionEvidenceDigest: sha256(fs.readFileSync(RETRACTION_EVIDENCE_FILE)),
      bucketKeyContractRef: {
        kind: 'path',
        root: 'sourceTree',
        path: BUCKET_KEY_CONTRACT_REL,
      },
      bucketKeyContractDigest: sha256(fs.readFileSync(BUCKET_KEY_CONTRACT_FILE)),
      wholeFileExtractorProfileRef: {
        kind: 'path',
        root: 'sourceTree',
        path: WHOLE_FILE_PROFILE_REL,
      },
      wholeFileExtractorProfileDigest: sha256(fs.readFileSync(WHOLE_FILE_PROFILE_FILE)),
      inputContractRef: {
        kind: 'path',
        root: 'sourceTree',
        path: INPUT_CONTRACT_REL,
      },
      inputContractDigest: sha256(inputContractBytes),
      outputContractRef: {
        kind: 'path',
        root: 'sourceTree',
        path: OUTPUT_CONTRACT_REL,
      },
      outputContractDigest: sha256(outputContractBytes),
      discoveryContractRef: {
        kind: 'path',
        root: 'sourceTree',
        path: PROFILE_REL,
      },
      discoveryContractDigest: sha256(profileBytes),
      implementationRef: {
        kind: 'path',
        root: 'sourceTree',
        path: IMPLEMENTATION_REL,
      },
      implementationDigest: sha256(fs.readFileSync(IMPLEMENTATION_FILE)),
      workerRef: {
        kind: 'path',
        root: 'sourceTree',
        path: WORKER_REL,
      },
      workerDigest: sha256(fs.readFileSync(WORKER_FILE)),
    },
    discoveredConstraints: profile.constraints.map((row) => ({
      constraintIri: row.constraintIri,
      dispatchDigest: row.dispatchDigest,
      evaluatorId: row.evaluatorId,
      targetElement: row.targetElement,
      expressionDigest: row.expressionDigest,
    })),
    vectorResults,
  };
}

function parseArguments(argv) {
  if (argv.length === 2 && argv[0] === '--output-dir') {
    return { outputDir: path.resolve(argv[1]) };
  }
  throw new Error('Usage: node scripts/domain/run-risk-custom-runtime.cjs --output-dir <directory>');
}

function main(argv) {
  const { outputDir } = parseArguments(argv);
  const evidence = createEvidence();
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, EVIDENCE_NAME),
    Buffer.from(canonicalJcs(evidence), 'utf8'),
  );
  process.stdout.write(
    `Risk Custom runtime: PASS `
      + `(constraints=${evidence.discoveredConstraints.length}, vectors=${evidence.vectorResults.length})\n`,
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (cause) {
    process.stderr.write(`${cause && cause.stack ? cause.stack : cause}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  EVIDENCE_NAME,
  canonicalScenario,
  createEvidence,
  executeRequest,
  main,
  validateProfile,
};
