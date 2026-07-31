#!/usr/bin/env node
/**
 * Compute real SHA-256 digests for domain module.yaml files,
 * update import artifactDigest fields (topological), and refresh module-registry.yaml.
 * Modules remain status: draft (Stop-Ship — not approved).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const FINANCE = path.join(ROOT, 'ontology', 'domain', 'finance');
const REGISTRY = path.join(FINANCE, 'registry', 'module-registry.yaml');

const ORDER = [
  'foundation', 'market-structure', 'market-rules', 'instruments',
  'market-data', 'portfolio-positions', 'orders-execution',
  'strategy-research', 'risk', 'post-trade-operations',
  'ext-fibo-release-local',
];

function shaFile(p) {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const digestsByIri = {};
const entries = [];

for (const name of ORDER) {
  const modPath = path.join(FINANCE, name, 'module.yaml');
  if (!fs.existsSync(modPath)) continue;
  const raw = fs.readFileSync(modPath, 'utf8');
  const doc = yaml.load(raw);
  const m = doc.module;
  // First pass: compute digest of current file (imports may still be placeholders)
  // We will rewrite imports then re-hash in a second pass for dependents.
  digestsByIri[m.moduleIri] = { name, path: modPath, doc, raw };
}

// Update imports using currently known digests; iterate until stable (DAG)
for (let round = 0; round < ORDER.length + 2; round++) {
  let changed = false;
  for (const name of ORDER) {
    const rec = Object.values(digestsByIri).find((r) => r.name === name);
    if (!rec) continue;
    const dig = shaFile(rec.path);
    digestsByIri[rec.doc.module.moduleIri].digest = dig;
  }
  for (const name of ORDER) {
    const rec = Object.values(digestsByIri).find((r) => r.name === name);
    if (!rec) continue;
    const imports = rec.doc.module.imports || [];
    let fileChanged = false;
    for (const imp of imports) {
      const dep = digestsByIri[imp.moduleIri];
      if (!dep || !dep.digest) continue;
      if (imp.artifactDigest !== dep.digest) {
        imp.artifactDigest = dep.digest;
        fileChanged = true;
      }
    }
    if (fileChanged) {
      const header = rec.raw.match(/^([\s\S]*?\n)(?=module:)/);
      fs.writeFileSync(rec.path, (header ? header[1] : '') + yaml.dump(rec.doc, { lineWidth: 120, noRefs: true }));
      rec.raw = fs.readFileSync(rec.path, 'utf8');
      rec.doc = yaml.load(rec.raw);
      changed = true;
    }
  }
  if (!changed && round > 0) break;
}

// Final digests + registry
for (const name of ORDER) {
  const modPath = path.join(FINANCE, name, 'module.yaml');
  if (!fs.existsSync(modPath)) continue;
  const doc = yaml.load(fs.readFileSync(modPath, 'utf8'));
  const digest = shaFile(modPath);
  digestsByIri[doc.module.moduleIri] = { name, digest, doc };
  entries.push({
    moduleIri: doc.module.moduleIri,
    version: doc.module.version,
    artifactDigest: digest,
    status: doc.module.status || 'draft',
    preferredPrefix: doc.module.preferredPrefix,
    path: `ontology/domain/finance/${name}/module.yaml`,
  });
  console.log(`${name}: ${digest}`);
}

const registry = {
  registryVersion: '0.1.0',
  updated: '2026-07-30',
  note: 'All modules remain draft under Stop-Ship. Only approved modules may be imported by policy (ADR-013 §4); draft imports allowed only for internal WIP with real digests.',
  modules: entries,
};
fs.writeFileSync(REGISTRY, yaml.dump(registry, { lineWidth: 120, noRefs: true }));
console.log('\n✓ wrote ' + path.relative(ROOT, REGISTRY));
