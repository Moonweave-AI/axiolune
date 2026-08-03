#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  executeIdentifierConstraint,
} = require('./lib/foundation-identifier-custom.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

function readStrictJcs(file, label) {
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes.toString('utf8'));
  const canonical = Buffer.from(canonicalJcs(value), 'utf8');
  if (!bytes.equals(canonical)) throw new Error(`${label} must be exact UTF-8 RFC 8785 JCS bytes`);
  return value;
}

function safeAbsoluteIri(value) {
  if (typeof value !== 'string' || value === '' || value.trim() !== value) return null;
  try {
    return new URL(value).href === value ? value : null;
  } catch {
    return null;
  }
}

function fatalResult(input, cause) {
  return {
    constraintDefinitionIri: safeAbsoluteIri(input?.constraintDefinitionIri),
    errors: [{
      code: 'IDENTIFIER_WORKER_FAILURE',
      message: cause instanceof Error ? cause.message : String(cause),
    }],
    focusNode: safeAbsoluteIri(input?.focusNode),
    outcome: 'engineFailure',
    schemaVersion: '1.0',
    violations: [],
  };
}

function main(argv) {
  if (argv.length !== 3) {
    process.stderr.write('usage: foundation-identifier-worker.cjs INPUT REGISTRY OUTPUT\n');
    return 64;
  }
  const [inputFile, registryFile, outputFile] = argv.map((value) => path.resolve(value));
  let input = null;
  let result;
  try {
    input = readStrictJcs(inputFile, 'identifier executor input');
    const registry = readStrictJcs(registryFile, 'scheme-validator registry');
    result = executeIdentifierConstraint(input, registry);
  } catch (cause) {
    result = fatalResult(input, cause);
  }
  try {
    fs.writeFileSync(outputFile, Buffer.from(canonicalJcs(result), 'utf8'), { flag: 'wx' });
  } catch (cause) {
    process.stderr.write(`identifier worker output failure: ${cause.message}\n`);
    return 70;
  }
  if (result.outcome === 'conforms') return 0;
  if (result.outcome === 'violation') return 1;
  return 2;
}

process.exitCode = main(process.argv.slice(2));

