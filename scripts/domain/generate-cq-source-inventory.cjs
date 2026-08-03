#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  CQ_SOURCE_INVENTORY_REF,
  compileCqSourceInventory,
  sourcePath,
} = require('./lib/m2-cq-source-inventory.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

function run(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check || argv.some((argument) => !['--write', '--check'].includes(argument))) {
    throw new Error('usage: node scripts/domain/generate-cq-source-inventory.cjs (--write|--check)');
  }
  const result = compileCqSourceInventory(ROOT);
  const output = sourcePath(ROOT, CQ_SOURCE_INVENTORY_REF.path);
  if (write) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, result.bytes);
  } else if (!fs.existsSync(output) || !fs.lstatSync(output).isFile()
      || fs.lstatSync(output).isSymbolicLink() || !fs.readFileSync(output).equals(result.bytes)) {
    throw new Error(`${CQ_SOURCE_INVENTORY_REF.path} is missing or byte-drifted`);
  }
  return { mode: write ? 'write' : 'check', ...result.stats };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run()));
  } catch (error) {
    console.error(`FAIL CQ source inventory: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { run };
