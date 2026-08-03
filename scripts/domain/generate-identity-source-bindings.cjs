#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  IDENTITY_SOURCE_BINDINGS_REF,
  compileIdentitySourceBindings,
  readRegularSourceBytes,
} = require('./lib/m2-identity-source-bindings.cjs');
const { sourcePath } = require('./lib/m2-cq-source-inventory.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

function run(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check || argv.some((argument) => !['--write', '--check'].includes(argument))) {
    throw new Error('usage: node scripts/domain/generate-identity-source-bindings.cjs (--write|--check)');
  }
  const result = compileIdentitySourceBindings(ROOT);
  const output = sourcePath(ROOT, IDENTITY_SOURCE_BINDINGS_REF.path);
  if (write) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, result.bytes);
  } else {
    let actual;
    try {
      actual = readRegularSourceBytes(ROOT, IDENTITY_SOURCE_BINDINGS_REF,
        'identity source bindings');
    } catch (error) {
      throw new Error(`${IDENTITY_SOURCE_BINDINGS_REF.path} is missing or unsafe: ${error.message}`);
    }
    if (!actual.equals(result.bytes)) {
      throw new Error(`${IDENTITY_SOURCE_BINDINGS_REF.path} is byte-drifted from its compiler`);
    }
  }
  return { mode: write ? 'write' : 'check', ...result.stats };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run()));
  } catch (error) {
    console.error(`FAIL identity source bindings: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { ROOT, run };
