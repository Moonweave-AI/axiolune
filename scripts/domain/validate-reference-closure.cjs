#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { validateReferenceClosure } = require('./lib/reference-closure.cjs');

function usage() {
  console.error([
    'Usage: node scripts/domain/validate-reference-closure.cjs [options]',
    '  --root <path>              repository root',
    '  --reference-root <path>    checked-in reference root (default: reference)',
    '  --lock <path>              authoring reference lock',
    '  --closure <path>           strict reference closure manifest',
    '  --coverage <path>          strict file-level review coverage',
    '  --diagnostics <path>       non-release reference support diagnostics',
    '  --json                     emit one JSON result',
    '  --max-errors <n>           cap displayed errors only (validation remains complete)',
  ].join('\n'));
}

const args = process.argv.slice(2);
const options = {};
let json = false;
let maxErrors = Number.POSITIVE_INFINITY;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--json') {
    json = true;
  } else if (arg === '--help' || arg === '-h') {
    usage();
    process.exit(0);
  } else if (arg === '--max-errors') {
    const value = Number(args[++index]);
    if (!Number.isSafeInteger(value) || value < 0) {
      console.error('--max-errors must be a non-negative safe integer');
      process.exit(2);
    }
    maxErrors = value;
  } else {
    const optionMap = {
      '--root': 'rootDir',
      '--reference-root': 'referenceRoot',
      '--lock': 'lockPath',
      '--closure': 'closurePath',
      '--coverage': 'coveragePath',
      '--diagnostics': 'tracePath',
      '--trace': 'tracePath',
    };
    const key = optionMap[arg];
    if (!key || index + 1 >= args.length) {
      usage();
      process.exit(2);
    }
    options[key] = args[++index];
  }
}

if (options.rootDir) options.rootDir = path.resolve(options.rootDir);

let result;
try {
  result = validateReferenceClosure(options);
} catch (error) {
  console.error(`FATAL reference closure validator crashed: ${error.stack || error.message}`);
  process.exit(2);
}

const visibleErrors = result.errors.slice(0, maxErrors);
if (json) {
  console.log(JSON.stringify({
    ...result,
    errors: visibleErrors,
    omittedErrorCount: result.errors.length - visibleErrors.length,
  }));
} else {
  const label = result.ok ? 'PASS' : 'FAIL';
  console.log(`${label} reference closure: ${result.errors.length} blocker(s)`);
  console.log(JSON.stringify(result.stats));
  if (result.paywalledReferences.length > 0) {
    console.log(`PAYWALLED-UNAVAILABLE ${result.paywalledReferences.join(', ')}`);
  }
  for (const error of visibleErrors) {
    console.log(`${error.code} ${error.at}: ${error.message}`);
    if (error.detail !== undefined) console.log(`  ${JSON.stringify(error.detail)}`);
  }
  if (visibleErrors.length !== result.errors.length) {
    console.log(`... ${result.errors.length - visibleErrors.length} additional blocker(s) omitted from display`);
  }
}
process.exit(result.ok ? 0 : 1);
