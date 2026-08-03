#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

const SCHEMA_VERSION = '1.0';
const MAX_INPUT_BYTES = 4096;
const FORMULAS = Object.freeze({
  'momentum-signal-v1': Object.freeze({
    expression: 'delta=currentPriceMicros-previousPriceMicros;direction=sign(delta);returnPpm=truncateTowardZero(delta*1000000/previousPriceMicros);strengthPpm=min(truncateTowardZero(abs(delta)*10000000/previousPriceMicros),1000000)',
    inputFields: Object.freeze(['currentPriceMicros', 'previousPriceMicros']),
    kind: 'SignalGenerator',
  }),
  'total-return-v1': Object.freeze({
    expression: 'returnPpm=truncateTowardZero((endingEquityMicros-beginningEquityMicros)*1000000/beginningEquityMicros)',
    inputFields: Object.freeze(['beginningEquityMicros', 'endingEquityMicros']),
    kind: 'MetricDefinition',
  }),
});

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields differ: ${actual.join(',')}`);
  }
}

function readStrictJcs(file, label) {
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_INPUT_BYTES) throw new Error(`${label} exceeds ${MAX_INPUT_BYTES} bytes`);
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${label} is not exact UTF-8 RFC 8785 JCS`);
  }
  return value;
}

function integer(value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical non-negative integer lexical string`);
  }
  return BigInt(value);
}

function violation(code, message) {
  return { code, message, outcome: 'violation', schemaVersion: SCHEMA_VERSION, value: null };
}

function conforms(value) {
  return { code: null, message: null, outcome: 'conforms', schemaVersion: SCHEMA_VERSION, value };
}

function engineFailure(code, message) {
  return { code, message, outcome: 'engineFailure', schemaVersion: SCHEMA_VERSION, value: null };
}

function executeFormula(request, definitions) {
  exactKeys(request, ['formulaId', 'input', 'schemaVersion'], 'formula request');
  if (request.schemaVersion !== SCHEMA_VERSION) throw new TypeError('formula request schemaVersion must equal 1.0');
  if (!Object.hasOwn(FORMULAS, request.formulaId)) {
    return engineFailure('FORMULA_UNBOUND', `formula ${String(request.formulaId)} is not implemented`);
  }
  exactKeys(definitions, ['definitions', 'schemaVersion'], 'formula definitions');
  if (definitions.schemaVersion !== SCHEMA_VERSION || !Array.isArray(definitions.definitions)) {
    throw new TypeError('formula definitions are outside the v1 contract');
  }
  const matches = definitions.definitions.filter((row) => row?.formulaId === request.formulaId);
  if (matches.length !== 1) return engineFailure('FORMULA_DEFINITION_BINDING', 'formula definition cardinality is not one');
  const locked = FORMULAS[request.formulaId];
  const definition = matches[0];
  if (definition.kind !== locked.kind || definition.expression !== locked.expression) {
    return engineFailure('FORMULA_DEFINITION_DRIFT', 'formula definition differs from the reviewed implementation');
  }
  exactKeys(request.input, locked.inputFields, 'formula input');

  if (request.formulaId === 'momentum-signal-v1') {
    const previous = integer(request.input.previousPriceMicros, 'previousPriceMicros');
    const current = integer(request.input.currentPriceMicros, 'currentPriceMicros');
    if (previous === 0n) return violation('FORMULA_DIVISION_BY_ZERO', 'previous price must be positive');
    const delta = current - previous;
    const returnPpm = (delta * 1000000n) / previous;
    const absoluteDelta = delta < 0n ? -delta : delta;
    const unboundedStrengthPpm = (absoluteDelta * 10000000n) / previous;
    const strengthPpm = unboundedStrengthPpm > 1000000n ? 1000000n : unboundedStrengthPpm;
    return conforms({
      direction: delta > 0n ? 'long' : delta < 0n ? 'short' : 'neutral',
      returnPpm: returnPpm.toString(),
      strengthPpm: strengthPpm.toString(),
    });
  }

  const beginning = integer(request.input.beginningEquityMicros, 'beginningEquityMicros');
  const ending = integer(request.input.endingEquityMicros, 'endingEquityMicros');
  if (beginning === 0n) return violation('FORMULA_DIVISION_BY_ZERO', 'beginning equity must be positive');
  const returnPpm = ((ending - beginning) * 1000000n) / beginning;
  return conforms({ returnPpm: returnPpm.toString() });
}

function main(argv) {
  if (argv.length !== 3) {
    process.stderr.write('usage: strategy-research-formula-worker.cjs INPUT DEFINITIONS OUTPUT\n');
    return 64;
  }
  const [inputFile, definitionsFile, outputFile] = argv.map((value) => path.resolve(value));
  let result;
  try {
    result = executeFormula(
      readStrictJcs(inputFile, 'formula input'),
      readStrictJcs(definitionsFile, 'formula definitions'),
    );
  } catch (cause) {
    result = engineFailure('FORMULA_WORKER_FAILURE', cause.message);
  }
  try {
    fs.writeFileSync(outputFile, Buffer.from(canonicalJcs(result), 'utf8'), { flag: 'wx' });
  } catch (cause) {
    process.stderr.write(`formula output failure: ${cause.message}\n`);
    return 70;
  }
  return { conforms: 0, violation: 1, engineFailure: 2 }[result.outcome];
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { FORMULAS, executeFormula };
