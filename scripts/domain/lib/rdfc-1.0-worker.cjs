#!/usr/bin/env node
'use strict';

const { canonize } = require('rdf-canonize');

const MAX_INPUT_BYTES = 1024 * 1024;

async function main() {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.length;
    if (byteLength > MAX_INPUT_BYTES) {
      throw new Error(`RDFC_INPUT_TOO_LARGE: input exceeds ${MAX_INPUT_BYTES} bytes`);
    }
    chunks.push(bytes);
  }
  const input = Buffer.concat(chunks).toString('utf8');
  const canonical = await canonize(input, {
    algorithm: 'RDFC-1.0',
    inputFormat: 'application/n-quads',
    format: 'application/n-quads',
    maxWorkFactor: 2,
    rejectURDNA2015: true,
  });
  process.stdout.write(canonical);
}

main().catch((error) => {
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
