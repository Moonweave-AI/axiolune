#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const {
  ContractViolation,
  canonical,
  customConstraintDispatchDescriptor,
  validateCustomConstraint,
} = require('./lib/post-trade-v03-contract.cjs');
const {
  VECTOR_CONFIG_BY_IRI,
} = require('./lib/post-trade-custom-profile.cjs');

const MAX_INPUT_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

function denied(action) {
  try {
    action();
    return false;
  } catch (cause) {
    return cause?.code === 'ERR_ACCESS_DENIED';
  }
}

function permissionAssurance() {
  return {
    childProcessDenied: denied(() => childProcess.spawnSync(process.execPath, ['--version'])),
    fileWriteDenied: denied(() => fs.writeFileSync('post-trade-custom-forbidden.tmp', 'x')),
    networkDenied: Boolean(process.permission) && process.permission.has('net') === false,
    permissionModelEnabled: Boolean(process.permission),
    unrelatedFileReadDenied: denied(() => fs.readFileSync('package.json')),
    workerCreationDenied: denied(() => new Worker('0', { eval: true })),
  };
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} is not closed by the runtime schema`);
  }
}

function validateRequest(request) {
  exactKeys(
    request,
    request.mode === 'hang'
      ? ['constraintIri', 'fixture', 'mode', 'schemaVersion', 'validatorId']
      : ['constraintIri', 'fixture', 'schemaVersion', 'validatorId'],
    'request',
  );
  if (request.schemaVersion !== '1.0'
      || typeof request.constraintIri !== 'string'
      || typeof request.validatorId !== 'string') {
    throw new TypeError('request identity fields violate the runtime schema');
  }
  exactKeys(request.fixture, ['contract', 'instance'], 'request.fixture');
  if (typeof request.fixture.contract !== 'string'
      || !request.fixture.instance
      || typeof request.fixture.instance !== 'object'
      || Array.isArray(request.fixture.instance)) {
    throw new TypeError('request.fixture violates the runtime schema');
  }
  const binding = VECTOR_CONFIG_BY_IRI[request.constraintIri];
  if (!binding) throw new TypeError('constraint is not bound by this runtime');
  if (binding.validatorId !== request.validatorId
      || binding.fixtureContract !== request.fixture.contract) {
    throw new TypeError('constraint/validator/fixture-contract binding mismatch');
  }
}

function main() {
  const chunks = [];
  let size = 0;
  process.stdin.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) {
      process.stderr.write('input exceeds worker limit\n');
      process.exit(2);
    }
    chunks.push(chunk);
  });
  process.stdin.on('end', () => {
    try {
      const bytes = Buffer.concat(chunks);
      const request = JSON.parse(bytes.toString('utf8'));
      if (!bytes.equals(Buffer.from(canonical(request), 'utf8'))) {
        throw new TypeError('input is not exact JCS');
      }
      validateRequest(request);
      if (request.mode === 'hang') {
        for (;;) {
          // The parent timeout is the independent interruption boundary.
        }
      }
      let outcome = 'accepted';
      let violation = null;
      let dispatch;
      try {
        dispatch = validateCustomConstraint(request.validatorId, request.fixture);
        outcome = dispatch.outcome;
      } catch (cause) {
        if (!(cause instanceof ContractViolation)) throw cause;
        dispatch = customConstraintDispatchDescriptor(request.validatorId);
        outcome = 'violation';
        violation = cause.code;
      }
      const output = Buffer.from(canonical({
        assurance: permissionAssurance(),
        constraintIri: request.constraintIri,
        dispatchDigest: dispatch.dispatchDigest,
        evaluatorId: dispatch.evaluatorId,
        fixtureContract: request.fixture.contract,
        observedViolation: dispatch.observedViolation || null,
        observedViolationOwner: dispatch.observedViolationOwner || null,
        outcome,
        schemaVersion: '1.0',
        validatorId: request.validatorId,
        violation,
      }), 'utf8');
      if (output.length > MAX_OUTPUT_BYTES) throw new Error('output exceeds worker limit');
      process.stdout.write(output);
    } catch (cause) {
      process.stderr.write(`${cause?.code || cause?.message || cause}\n`);
      process.exitCode = 2;
    }
  });
}

main();
