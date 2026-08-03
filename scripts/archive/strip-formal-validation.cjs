#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..', '..');

function walkYamlFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'reference') continue;
      walkYamlFiles(absolute, out);
    } else if (entry.isFile() && /\.ya?ml$/u.test(entry.name)) {
      out.push(absolute);
    }
  }
  return out;
}

function stripModuleIriHash(moduleIri) {
  if (typeof moduleIri !== 'string') return moduleIri;
  return moduleIri.replace(/#sha256:[a-f0-9]{64}$/u, '');
}

function stripImports(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.imports)) {
    for (const imp of node.imports) {
      if (!imp || typeof imp !== 'object') continue;
      if (imp.moduleIri) imp.moduleIri = stripModuleIriHash(imp.moduleIri);
      delete imp.artifactDigest;
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') stripImports(value);
  }
}

function stripRegistryEntries(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.modules)) {
    for (const entry of node.modules) {
      if (entry && typeof entry === 'object') delete entry.artifactDigest;
    }
  }
}

let changed = 0;
for (const file of walkYamlFiles(path.join(ROOT, 'ontology'))) {
  const text = fs.readFileSync(file, 'utf8');
  const doc = YAML.parse(text);
  if (!doc) continue;
  stripImports(doc.module ? doc : doc);
  if (file.endsWith('module-registry.yaml')) stripRegistryEntries(doc);
  const next = YAML.stringify(doc).replace(/\n$/u, '') + '\n';
  if (next !== text) {
    fs.writeFileSync(file, next);
    changed += 1;
    console.log('updated', path.relative(ROOT, file));
  }
}

const digestsPath = path.join(ROOT, 'ontology', 'meta', 'digests.json');
if (fs.existsSync(digestsPath)) {
  fs.unlinkSync(digestsPath);
  console.log('deleted ontology/meta/digests.json');
}

console.log(JSON.stringify({ yamlFilesUpdated: changed }));
