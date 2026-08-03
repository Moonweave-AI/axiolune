#!/usr/bin/env node
'use strict';

const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  engineFailureOutput,
  evaluateReleaseCapability,
} = require('./lib/m2-release-capability-runtime.cjs');

const MAX_INPUT_BYTES = 1024 * 1024;
let bytes = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  bytes = Buffer.concat([bytes, chunk]);
  if (bytes.length > MAX_INPUT_BYTES) {
    process.stderr.write('release capability input exceeds 1 MiB\n');
    process.exit(2);
  }
});

process.stdin.on('end', () => {
  let request = null;
  let result;
  try {
    request = JSON.parse(bytes.toString('utf8'));
    result = evaluateReleaseCapability(request);
  } catch (cause) {
    result = engineFailureOutput(request, cause);
  }
  process.stdout.write(`${canonicalJcs(result)}\n`);
  process.exitCode = result.status === 'completed' ? 0 : 2;
});
