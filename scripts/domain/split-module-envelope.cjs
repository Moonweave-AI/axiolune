#!/usr/bin/env node
'use strict';

/**
 * Bootstrap envelope split from legacy module.yaml
 * Usage: node scripts/domain/split-module-envelope.cjs <module-dir> [--write]
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const {
  extractBindingDomain,
  fragmentPaths,
  hasEnvelopeFragments,
} = require('./lib/load-module-envelope.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const WRITE = process.argv.includes('--write');
const arg = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);

if (!arg) {
  console.error('Usage: node scripts/domain/split-module-envelope.cjs <module-dir-or-name> [--write]');
  process.exit(1);
}

let moduleDir = path.resolve(ROOT, arg);
if (!fs.existsSync(moduleDir)) {
  moduleDir = path.join(ROOT, 'ontology/domain/finance', arg);
}
const legacyPath = path.join(moduleDir, 'module.yaml');
if (!fs.existsSync(legacyPath)) {
  console.error(`Missing ${legacyPath}`);
  process.exit(1);
}
if (hasEnvelopeFragments(moduleDir) && !WRITE) {
  console.error('module.core.yaml already exists — pass --write to overwrite');
  process.exit(1);
}

const doc = yaml.load(fs.readFileSync(legacyPath, 'utf8'));
const { coreDomain, bindingDomain } = extractBindingDomain(doc.domain || {});

const coreHeader = `# ${doc.module.preferredPrefix || 'module'} — domain core (Phase B)\n`
  + `# Practitioner-first semantics. See M2-DEFINITION-STYLE-GUIDE.md\n\n`;
const bindingHeader = `# ${doc.module.preferredPrefix || 'module'} — Layer-4 binding overlay (Phase B)\n`
  + `# Materialization refs/digests — data/platform engineers\n\n`;

const coreDoc = { module: doc.module, domain: coreDomain };
const bindingDoc = { domain: bindingDomain };

const coreYaml = coreHeader + yaml.dump(coreDoc, { lineWidth: 120, noRefs: true, quotingType: '"' });
const bindingYaml = bindingHeader + yaml.dump(bindingDoc, { lineWidth: 120, noRefs: true, quotingType: '"' });

const bindingTypes = Object.values(bindingDomain).reduce((n, c) => n + Object.keys(c || {}).length, 0);
console.log(`Split ${path.relative(ROOT, moduleDir)}:`);
console.log(`  binding overlay entries: ${bindingTypes}`);

if (WRITE) {
  fs.writeFileSync(fragmentPaths(moduleDir).core, coreYaml, 'utf8');
  fs.writeFileSync(fragmentPaths(moduleDir).binding, bindingYaml, 'utf8');
  console.log('✅ Written module.core.yaml + module.binding.yaml');
} else {
  console.log('(dry-run — pass --write to apply)');
}
