#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const childProcess = require('node:child_process');
const { Worker } = require('node:worker_threads');
const {
  RISK_CUSTOM_VALIDATORS,
  RiskContractViolation,
  riskConstraintDispatchDescriptor,
  validateConstraint,
} = require('./lib/risk-v03-contract.cjs');
const {
  canonicalJcs,
} = require('./lib/strict-source-locator.cjs');
const {
  decodeCanonicalRiskScenario,
} = require('./lib/risk-canonical-record-adapter.cjs');
const {
  SourceArtifactInventoryError,
} = require('./lib/post-trade-risk-source-artifact-inventory.cjs');

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
function denied(action) {
  try {
    action();
    return false;
  } catch (cause) {
    return cause && cause.code === 'ERR_ACCESS_DENIED';
  }
}

function permissionAssurance() {
  return {
    permissionModelEnabled: Boolean(process.permission),
    unrelatedFileReadDenied: denied(() => fs.readFileSync('package.json')),
    fileWriteDenied: denied(() => fs.writeFileSync('risk-custom-forbidden.tmp', 'x')),
    childProcessDenied: denied(() => childProcess.spawnSync(process.execPath, ['--version'])),
    workerCreationDenied: denied(() => new Worker('0', { eval: true })),
    networkDenied: Boolean(process.permission) && process.permission.has('net') === false,
  };
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

function main() {
  const chunks = [];
  let byteCount = 0;
  process.stdin.on('data', (chunk) => {
    byteCount += chunk.length;
    if (byteCount > MAX_INPUT_BYTES) {
      process.stderr.write('input exceeds runtime limit\n');
      process.exit(2);
    }
    chunks.push(chunk);
  });
  process.stdin.on('end', () => {
    try {
      const bytes = Buffer.concat(chunks);
      const request = JSON.parse(bytes.toString('utf8'));
      if (!bytes.equals(Buffer.from(canonicalJcs(request), 'utf8'))) {
        throw new TypeError('input is not exact JCS');
      }
      exactKeys(
        request,
        ['constraintIri', 'evaluatorId', 'scenario', 'schemaVersion'],
        ['mode'],
        'request',
      );
      if (request.schemaVersion !== '1.0') throw new TypeError('unsupported request schemaVersion');
      if (request.mode === 'hang') {
        for (;;) {
          // The parent timeout is the fail-closed interruption boundary.
        }
      }
      const evaluator = RISK_CUSTOM_VALIDATORS.get(request.constraintIri);
      if (!evaluator) {
        throw new TypeError('constraint is not bound by this runtime');
      }
      let result;
      const dispatch = riskConstraintDispatchDescriptor(request.constraintIri);
      if (request.evaluatorId !== dispatch.evaluatorId) {
        throw new TypeError('constraint/evaluator binding mismatch');
      }
      try {
        let canonicalScenario;
        try {
          canonicalScenario = decodeCanonicalRiskScenario(request.scenario);
        } catch (cause) {
          if (cause instanceof SourceArtifactInventoryError
              && request.constraintIri
                === 'https://axiolune.ai/ontology/finance/risk/RiskMeasureDefinitionContract') {
            throw new RiskContractViolation('definition-provenance', cause.code);
          }
          throw cause;
        }
        const validation = validateConstraint(request.constraintIri, canonicalScenario);
        result = {
          outcome: validation.applicable === false ? 'notApplicable' : 'accepted',
          violation: null,
        };
      } catch (cause) {
        if (!(cause instanceof RiskContractViolation)) throw cause;
        result = {
          outcome: 'rejected',
          violation: cause.code,
        };
      }
      const output = canonicalJcs({
        schemaVersion: '1.0',
        constraintIri: request.constraintIri,
        dispatchDigest: dispatch.dispatchDigest,
        evaluatorId: dispatch.evaluatorId,
        assurance: permissionAssurance(),
        ...result,
      });
      if (Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) {
        throw new Error('output exceeds runtime limit');
      }
      process.stdout.write(output);
    } catch (cause) {
      process.stderr.write(`${cause && cause.message ? cause.message : cause}\n`);
      process.exitCode = 2;
    }
  });
}

main();
