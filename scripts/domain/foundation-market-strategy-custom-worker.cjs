#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');

function networkAccessDenied() {
  const error = new Error('network access is disabled by the locked runtime boundary');
  error.code = 'ERR_ACCESS_DENIED';
  throw error;
}

// This worker executes reviewed repository validators only. Patch the process-wide
// transport primitives before loading them so reviewed code cannot open a socket.
net.connect = networkAccessDenied;
net.createConnection = networkAccessDenied;
globalThis.fetch = networkAccessDenied;

const {
  BINDING_ROWS,
  CUSTOM_CONSTRAINT_COUNT,
  bindingFor,
  canonicalJcs,
  evaluateSemanticScenario,
  findingMatchesBinding,
  sha256Jcs,
} = require('./lib/foundation-market-strategy-custom-validators.cjs');
const {
  decodeCanonicalEvidencePayload,
} = require('./lib/foundation-market-strategy-payload-codec.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const VECTOR_FILE = path.join(
  ROOT,
  'scripts/domain/foundation-market-strategy-custom-profile/v0.3.0/test-vectors.json',
);
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;

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

function denied(action) {
  try {
    action();
    return false;
  } catch (cause) {
    return cause?.code === 'ERR_ACCESS_DENIED';
  }
}

function permissionAssurance() {
  const unrelated = path.join(ROOT, 'package.json');
  const writeProbe = path.join(ROOT, 'tmp', 'six-module-custom-worker-write-probe');
  const assurance = {
    childProcessDenied: denied(() => spawnSync(process.execPath, ['--version'])),
    fileWriteDenied: denied(() => fs.writeFileSync(writeProbe, 'forbidden')),
    networkDenied: denied(() => net.connect({ host: '127.0.0.1', port: 9 })),
    permissionModelEnabled: process.permission?.has('fs.read', __filename) === true,
    unrelatedFileReadDenied: denied(() => fs.readFileSync(unrelated)),
    workerCreationDenied: denied(() => new Worker('0', { eval: true })),
  };
  if (Object.values(assurance).some((value) => value !== true)) {
    throw new Error(`sandbox assurance failed: ${canonicalJcs(assurance)}`);
  }
  return assurance;
}

function readVectors() {
  const bytes = fs.readFileSync(VECTOR_FILE);
  const document = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(document), 'utf8'))) {
    throw new Error('test vector artifact is not exact JCS');
  }
  exactKeys(
    document,
    ['constraintDefinitionCount', 'contextContractCount', 'profileRef', 'schemaVersion', 'vectors'],
    [],
    'vectors',
  );
  if (document.schemaVersion !== '1.0'
      || document.constraintDefinitionCount !== CUSTOM_CONSTRAINT_COUNT
      || document.contextContractCount !== 6
      || !Array.isArray(document.vectors)
      || document.vectors.length !== CUSTOM_CONSTRAINT_COUNT) {
    throw new Error('test vector inventory identity is invalid');
  }
  const scenarios = new Map();
  for (const vector of document.vectors) {
    exactKeys(
      vector,
      ['accepted', 'constraintIri', 'dispatchDigest', 'negative', 'validatorId'],
      [],
      'vector',
    );
    const binding = bindingFor(vector.constraintIri);
    if (vector.validatorId !== binding.validatorId || vector.dispatchDigest !== binding.dispatchDigest) {
      throw new Error(`vector dispatch drift for ${vector.constraintIri}`);
    }
    for (const [polarity, branch] of [['positive', vector.accepted], ['negative', vector.negative]]) {
      const digest = sha256Jcs(branch.scenario);
      if (scenarios.has(digest)) throw new Error(`duplicate canonical scenario digest ${digest}`);
      scenarios.set(digest, {
        binding,
        branch,
        polarity,
      });
    }
  }
  if (scenarios.size !== CUSTOM_CONSTRAINT_COUNT * 2) {
    throw new Error(`test vector scenario inventory must be ${CUSTOM_CONSTRAINT_COUNT * 2}, got ${scenarios.size}`);
  }
  return scenarios;
}

function validateScenarioEnvelope(scenario) {
  exactKeys(
    scenario,
    ['decimalPaths', 'dispatchKey', 'fixtureContract', 'payload', 'scenarioId', 'schemaVersion'],
    [],
    'request.scenario',
  );
  if (scenario.schemaVersion !== '1.0'
      || typeof scenario.dispatchKey !== 'string'
      || typeof scenario.fixtureContract !== 'string'
      || typeof scenario.scenarioId !== 'string'
      || !Array.isArray(scenario.decimalPaths)
      || !scenario.payload
      || typeof scenario.payload !== 'object'
      || Array.isArray(scenario.payload)) {
    throw new TypeError('request.scenario field types are invalid');
  }
}

function observedOwner(findings) {
  let owner = null;
  for (const observed of findings) {
    const owners = BINDING_ROWS.filter((binding) => findingMatchesBinding(observed, binding));
    if (owners.length !== 1) {
      throw new Error(`semantic finding is unowned or cross-owned: ${canonicalJcs({ observed, owners: owners.map((row) => row.constraintIri) })}`);
    }
    if (owner !== null && owner !== owners[0].constraintIri) {
      throw new Error(`negative context has multiple semantic owners: ${owner}, ${owners[0].constraintIri}`);
    }
    owner = owners[0].constraintIri;
  }
  return owner;
}

function execute(request, scenarios, assurance) {
  exactKeys(
    request,
    ['constraintIri', 'dispatchDigest', 'scenario', 'schemaVersion', 'validatorId'],
    ['mode'],
    'request',
  );
  if (request.schemaVersion !== '1.0') throw new TypeError('request.schemaVersion must equal 1.0');
  if (request.mode !== undefined && request.mode !== 'hang') throw new TypeError('request.mode is not allowed');
  if (request.mode === 'hang') {
    // Deliberate control path used only by the parent timeout test.
    // eslint-disable-next-line no-constant-condition
    while (true) {}
  }
  validateScenarioEnvelope(request.scenario);
  // Validate the signed numeric transport before scenario digest lookup so a
  // malformed decimal path cannot be disguised as an ordinary unknown vector.
  decodeCanonicalEvidencePayload(
    request.scenario.payload,
    request.scenario.decimalPaths,
  );
  const requested = bindingFor(request.constraintIri);
  if (request.validatorId !== requested.validatorId
      || request.dispatchDigest !== requested.dispatchDigest) {
    throw new Error('constraint/validator/dispatch binding mismatch');
  }
  const locked = scenarios.get(sha256Jcs(request.scenario));
  if (!locked) throw new Error('scenario is not an exact digest-locked formal fixture context');
  if (request.scenario.fixtureContract !== locked.binding.fixtureContract
      || request.scenario.dispatchKey !== locked.binding.dispatchKey) {
    throw new Error('scenario fixture/semantic dispatch metadata drift');
  }
  const findings = evaluateSemanticScenario(request.scenario);
  const codes = findings.map((value) => value.code);
  let outcome;
  let owner = null;
  if (locked.polarity === 'positive') {
    if (findings.length !== 0) throw new Error(`locked positive context rejected: ${canonicalJcs(findings)}`);
    outcome = requested.constraintIri === locked.binding.constraintIri ? 'accepted' : 'notApplicable';
  } else {
    if (findings.length === 0) throw new Error('locked negative context was accepted');
    owner = observedOwner(findings);
    if (owner !== locked.binding.constraintIri
        || !findings.some((value) => findingMatchesBinding(value, locked.binding))) {
      throw new Error('negative semantic owner differs from its locked ConstraintDefinition');
    }
    outcome = requested.constraintIri === owner ? 'rejected' : 'notApplicable';
  }
  return {
    assurance,
    constraintIri: requested.constraintIri,
    dispatchDigest: requested.dispatchDigest,
    observedViolationCodes: codes,
    observedViolationOwner: owner,
    outcome,
    schemaVersion: '1.0',
    validatorId: requested.validatorId,
  };
}

function main() {
  const chunks = [];
  let size = 0;
  process.stdin.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) {
      process.stderr.write('input exceeds worker byte limit\n');
      process.exit(2);
    }
    chunks.push(chunk);
  });
  process.stdin.on('end', () => {
    try {
      const assurance = permissionAssurance();
      const scenarios = readVectors();
      const input = Buffer.concat(chunks).toString('utf8');
      const request = JSON.parse(input);
      if (input !== canonicalJcs(request)) throw new Error('request must be exact UTF-8 JCS bytes');
      const output = canonicalJcs(execute(request, scenarios, assurance));
      if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) throw new Error('output exceeds worker byte limit');
      process.stdout.write(output);
    } catch (cause) {
      process.stderr.write(`${cause?.message || cause}\n`);
      process.exitCode = 2;
    }
  });
}

main();
