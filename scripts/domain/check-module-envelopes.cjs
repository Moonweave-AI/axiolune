#!/usr/bin/env node
'use strict';

/**
 * Verify module.yaml matches envelope fragments where module.core.yaml exists.
 * Usage: node scripts/domain/check-module-envelopes.cjs
 */

const fs = require('fs');
const path = require('path');
const { hasEnvelopeFragments, isMergedStale, fragmentPaths } = require('./lib/load-module-envelope.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const FINANCE = path.join(ROOT, 'ontology/domain/finance');

let failures = 0;
const dirs = fs.readdirSync(FINANCE, { withFileTypes: true })
  .filter(d => d.isDirectory() && !['registry', 'archive'].includes(d.name))
  .map(d => path.join(FINANCE, d.name));

console.log('=== MODULE ENVELOPE merge freshness ===');
for (const moduleDir of dirs) {
  if (!hasEnvelopeFragments(moduleDir)) continue;
  const name = path.basename(moduleDir);
  if (isMergedStale(moduleDir)) {
    failures++;
    console.log(`${name}: STALE — run merge-module-envelope.cjs ${name} --write`);
  } else {
    console.log(`${name}: merged module.yaml ✓`);
  }
}

if (failures === 0) {
  console.log('\n✅ All envelope modules in sync.');
} else {
  console.log(`\n=== Result: ${failures} stale envelope(s) ===`);
  process.exit(1);
}
