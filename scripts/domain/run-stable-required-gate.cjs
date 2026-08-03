#!/usr/bin/env node
'use strict';

const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  evaluateStableRequiredGate,
} = require('./lib/m2-stable-required-gate-adapters.cjs');

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const VECTOR_CATEGORIES = new Set([
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
    const emptySubject = request.vectorCategory === 'emptySubject';
    const engineFailure = request.vectorCategory === 'engineFailure';
    if (!exactKeys(request, [...common, 'subject', 'subjectDigest'])
        || request.schemaVersion !== '1.0'
        || !VECTOR_CATEGORIES.has(request.vectorCategory)
        || (emptySubject
          ? request.subject !== null || request.subjectDigest !== null
          : request.subject === null || typeof request.subject !== 'object'
            || Array.isArray(request.subject) || !DIGEST_RE.test(request.subjectDigest || ''))
        || request.fault !== (engineFailure ? 'forced-engine-failure' : null)) {
      throw new Error('semantic vector request is not the closed v1 contract');
    }
    return;
  }
  if (!exactKeys(request, [
    ...common, 'subjectInventory', 'subjectInventoryDigest', 'dependencyReports',
  ]) || request.schemaVersion !== '1.0'
      || request.operation !== 'replayRequiredGate'
      || request.vectorCategory !== null || request.fault !== null
      || !DIGEST_RE.test(request.subjectInventoryDigest || '')
      || !exactKeys(request.subjectInventory, [
        'schemaVersion', 'gateId', 'discoveryContractRef',
        'discoveryContractDigest', 'subjects',
      ])
      || request.subjectInventory.schemaVersion !== '1.0'
      || request.subjectInventory.gateId !== request.gateId
      || !exactKeys(request.subjectInventory.discoveryContractRef, ['kind', 'root', 'path'])
      || request.subjectInventory.discoveryContractRef.kind !== 'path'
      || request.subjectInventory.discoveryContractRef.root !== 'sourceTree'
      || !DIGEST_RE.test(
        request.subjectInventory.discoveryContractDigest || '',
      )
      || !Array.isArray(request.subjectInventory.subjects)
      || !Array.isArray(request.dependencyReports)
      || request.dependencyReports.length !== 0) {
    throw new Error('candidate replay request is not the closed v1 contract');
  }
}

async function main(argv = process.argv.slice(2)) {
  if (canonicalJcs(argv) !== canonicalJcs(['--required-gate-semantic'])) {
    throw new Error('usage: run-stable-required-gate.cjs --required-gate-semantic');
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
  const result = await evaluateStableRequiredGate(request, { root: process.cwd() });
  const output = Buffer.from(canonicalJcs(result.value), 'utf8');
  if (output.length > MAX_OUTPUT_BYTES) {
    throw new Error('semantic response exceeds 8 MiB');
  }
  process.stdout.write(output);
  process.exitCode = result.exitStatus;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`stable required-gate engine failure: ${error.message}`);
    process.exitCode = 2;
  });
}

module.exports = { main, validateRequest };
