#!/usr/bin/env node
'use strict';

/**
 * Merge module.core.yaml (+ optional profile/binding) → module.yaml
 * Usage: node scripts/domain/merge-module-envelope.cjs <module-dir> [--write] [--check]
 */

const fs = require('fs');
const path = require('path');
const {
  loadModuleEnvelope,
  hasEnvelopeFragments,
  serializeModuleDoc,
  isMergedStale,
  fragmentPaths,
} = require('./lib/load-module-envelope.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const WRITE = process.argv.includes('--write');
const CHECK = process.argv.includes('--check');
const arg = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);

if (!arg) {
  console.error('Usage: node scripts/domain/merge-module-envelope.cjs <module-dir-or-name> [--write] [--check]');
  process.exit(1);
}

let moduleDir = path.resolve(ROOT, arg);
if (!fs.existsSync(moduleDir)) {
  moduleDir = path.join(ROOT, 'ontology/domain/finance', arg);
}
if (!hasEnvelopeFragments(moduleDir)) {
  console.error(`No module.core.yaml in ${moduleDir}`);
  process.exit(1);
}

const { doc, source } = loadModuleEnvelope(moduleDir);
const outPath = fragmentPaths(moduleDir).legacy;
const content = serializeModuleDoc(doc);

if (CHECK) {
  if (isMergedStale(moduleDir)) {
    console.error(`STALE: ${outPath} does not match envelope fragments`);
    process.exit(1);
  }
  console.log(`OK: ${outPath} matches envelope (${source})`);
  process.exit(0);
}

console.log(`Merge ${path.relative(ROOT, moduleDir)} → module.yaml`);

if (WRITE) {
  fs.writeFileSync(outPath, content, 'utf8');
  console.log(`✅ Written ${outPath}`);
} else {
  console.log('(dry-run — pass --write to apply)');
}
