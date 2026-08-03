#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const childProcess = require('node:child_process');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const {
  CustomConstraintViolation,
  canonicalJcs,
  constraintDispatchDescriptor,
  validateConstraint,
} = require('./lib/orders-portfolio-custom-validators.cjs');
const {
  decodeCanonicalOrdersPortfolioScenario,
} = require('./lib/orders-portfolio-canonical-record-adapter.cjs');

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const INPUT_CONTRACT = path.join(__dirname, 'orders-portfolio-custom-profile', 'v0.3.0', 'input-contract.json');

function denied(action) {
  try {
    action();
    return false;
  } catch (cause) {
    return cause?.code === 'ERR_ACCESS_DENIED';
  }
}

function assurance() {
  return {
    childProcessDenied: denied(() => childProcess.spawnSync(process.execPath, ['--version'])),
    fileWriteDenied: denied(() => fs.writeFileSync('orders-portfolio-custom-forbidden.tmp', 'x')),
    networkDenied: Boolean(process.permission) && process.permission.has('net') === false,
    permissionModelEnabled: Boolean(process.permission),
    unrelatedFileReadDenied: denied(() => fs.readFileSync('package.json')),
    workerCreationDenied: denied(() => new Worker('0', { eval: true })),
  };
}

function exactRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('request must be an object');
  const keys = Object.keys(request).sort();
  const expected = (request.mode === 'hang'
    ? ['constraintIri', 'mode', 'scenario', 'schemaVersion', 'validatorId']
    : ['constraintIri', 'scenario', 'schemaVersion', 'validatorId']).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError('request is not closed by the runtime schema');
  }
  if (request.schemaVersion !== '1.0' || typeof request.constraintIri !== 'string'
      || typeof request.validatorId !== 'string' || !request.scenario
      || typeof request.scenario !== 'object' || Array.isArray(request.scenario)) {
    throw new TypeError('request fields violate the runtime schema');
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
      if (!bytes.equals(Buffer.from(canonicalJcs(request), 'utf8'))) throw new TypeError('input is not exact JCS');
      exactRequest(request);
      if (request.mode === 'hang') {
        for (;;) {
          // Parent timeout is the independent interruption boundary.
        }
      }
      const inputContractBytes = fs.readFileSync(INPUT_CONTRACT);
      const inputContract = JSON.parse(inputContractBytes.toString('utf8'));
      if (!inputContractBytes.equals(Buffer.from(canonicalJcs(inputContract), 'utf8'))) {
        throw new TypeError('canonical input contract is not exact JCS');
      }
      const dispatch = constraintDispatchDescriptor(request.constraintIri);
      if (dispatch.evaluatorId !== request.validatorId) {
        const error = new Error('constraint/evaluator dispatch binding is not trusted');
        error.code = 'CUSTOM_UNBOUND';
        throw error;
      }
      const normalizedScenario = decodeCanonicalOrdersPortfolioScenario(
        request.scenario,
        request.validatorId,
        inputContract,
      );
      let outcome = 'accepted';
      let violation = null;
      try {
        validateConstraint(request.constraintIri, request.validatorId, normalizedScenario);
      } catch (cause) {
        if (!(cause instanceof CustomConstraintViolation)) throw cause;
        outcome = 'violation';
        violation = cause.code;
      }
      const output = Buffer.from(canonicalJcs({
        assurance: assurance(),
        constraintIri: request.constraintIri,
        dispatchDigest: dispatch.dispatchDigest,
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
