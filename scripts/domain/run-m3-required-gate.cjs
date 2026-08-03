#!/usr/bin/env node
'use strict';

const {
  evaluateM3RequiredGate,
} = require('./lib/m3-required-gate-semantic-adapter.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const VECTOR_CATEGORIES = Object.freeze([
  'emptySubject', 'engineFailure', 'positive', 'tamper', 'violation',
]);

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort()) === canonicalJcs([...expected].sort());
}

function validateRequest(request) {
  const common = [
    'schemaVersion', 'profileRef', 'operation', 'capabilityId', 'gateId',
    'vectorCategory', 'fault',
  ];
  if (request?.operation === 'semanticVector') {
    if (!exactKeys(request, [...common, 'subject', 'subjectDigest'])
        || request.schemaVersion !== '1.0'
        || !VECTOR_CATEGORIES.includes(request.vectorCategory)
        || (request.subjectDigest !== null
          && !/^sha256:[0-9a-f]{64}$/u.test(request.subjectDigest || ''))
        || (request.vectorCategory === 'emptySubject'
          ? request.subject !== null || request.subjectDigest !== null
          : request.subject === null || request.subjectDigest === null)
        || (request.vectorCategory === 'engineFailure'
          ? request.fault !== 'forced-engine-failure'
          : request.fault !== null)) {
      throw new Error('semantic vector request is not the closed M3 v1 contract');
    }
    return;
  }
  if (!exactKeys(request, [
    ...common, 'subjectInventory', 'subjectInventoryDigest', 'dependencyReports',
  ]) || request.schemaVersion !== '1.0'
      || request.operation !== 'replayRequiredGate'
      || request.vectorCategory !== null || request.fault !== null
      || !/^sha256:[0-9a-f]{64}$/u.test(request.subjectInventoryDigest || '')
      || !Array.isArray(request.dependencyReports)) {
    throw new Error('candidate replay request is not the closed M3 v1 contract');
  }
}

async function main(argv = process.argv.slice(2)) {
  if (canonicalJcs(argv) !== canonicalJcs(['--required-gate-semantic'])) {
    throw new Error('usage: run-m3-required-gate.cjs --required-gate-semantic');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_INPUT_BYTES) throw new Error('semantic request exceeds 8 MiB');
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0 || bytes.includes(0x0a) || bytes.includes(0x0d)) {
    throw new Error('semantic request must be one non-empty unframed JCS value');
  }
  const request = JSON.parse(bytes.toString('utf8'));
  if (!Buffer.from(canonicalJcs(request), 'utf8').equals(bytes)) {
    throw new Error('semantic request is not exact RFC 8785 JCS');
  }
  validateRequest(request);
  const result = evaluateM3RequiredGate(request, { root: process.cwd() });
  process.stdout.write(canonicalJcs(result.value));
  process.exitCode = result.exitStatus;
}

if (require.main === module) {
  main().catch((cause) => {
    process.stderr.write(`M3 required-gate engine failure: ${cause.message}`);
    process.exitCode = 2;
  });
}

module.exports = { main, validateRequest };
