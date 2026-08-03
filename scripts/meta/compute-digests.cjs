#!/usr/bin/env node
'use strict';

/**
 * Deterministically update/check the content-addressed M3 import closure.
 *
 * The default mode is read-only and exits non-zero on drift. `--write` updates
 * import version/digest triples in topological order and writes a deterministic
 * digests.json without a wall-clock timestamp. YAML comments and formatting are
 * preserved; only the three import scalar lines are replaced.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const META_DIR = process.env.META_DIR
  ? path.resolve(process.env.META_DIR)
  : path.join(ROOT, 'ontology', 'meta');
const WRITE = process.argv.includes('--write');
const MODULES = [
  ['https://axiolune.ai/ontology/meta/core', 'core-meta-model.yaml'],
  ['https://axiolune.ai/ontology/meta/patterns', 'cross-domain-patterns.yaml'],
  ['https://axiolune.ai/ontology/meta/behavior', 'behavior-meta-model.yaml'],
  ['https://axiolune.ai/ontology/meta/data-binding', 'data-binding-meta-model.yaml'],
];
const FILE_BY_IRI = new Map(MODULES);

function digest(text) {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function quoted(value) {
  return `"${value}"`;
}

function rewriteImports(text, targetState, file) {
  const parts = text.split(/(\r\n|\n)/);
  let current = null;
  const seen = new Map();
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const lineNumber = (index / 2) + 1;
    const moduleMatch = line.match(/^(\s*)-\s+moduleIri:\s*["']?([^"'\s]+)["']?\s*$/);
    if (moduleMatch) {
      const baseIri = moduleMatch[2].split('#')[0];
      if (!FILE_BY_IRI.has(baseIri)) {
        throw new Error(`${file}:${lineNumber}: unknown M3 import ${baseIri}`);
      }
      const target = targetState.get(baseIri);
      if (!target) {
        throw new Error(`${file}:${lineNumber}: non-topological import ${baseIri}`);
      }
      current = { baseIri, indent: moduleMatch[1].length, version: false, digest: false };
      seen.set(baseIri, current);
      parts[index] = `${moduleMatch[1]}- moduleIri: ${quoted(`${baseIri}#${target.digest}`)}`;
      continue;
    }
    if (!current) continue;
    const scalarMatch = line.match(/^(\s*)(version|artifactDigest):\s*.*$/);
    if (scalarMatch && scalarMatch[1].length > current.indent) {
      const target = targetState.get(current.baseIri);
      const value = scalarMatch[2] === 'version' ? target.version : target.digest;
      parts[index] = `${scalarMatch[1]}${scalarMatch[2]}: ${quoted(value)}`;
      current[scalarMatch[2] === 'version' ? 'version' : 'digest'] = true;
      continue;
    }
    if (/^\s*-\s+/.test(line) && line.search(/\S/) <= current.indent) current = null;
  }
  for (const [baseIri, fields] of seen.entries()) {
    if (!fields.version || !fields.digest) {
      throw new Error(`${file}: import ${baseIri} must contain version and artifactDigest`);
    }
  }
  return parts.join('');
}

const state = new Map();
const desiredFiles = new Map();
const changed = [];
for (const [moduleIri, file] of MODULES) {
  const filePath = path.join(META_DIR, file);
  const original = fs.readFileSync(filePath, 'utf8');
  const originalDoc = yaml.load(original);
  if (!originalDoc || !originalDoc.module || originalDoc.module.moduleIri !== moduleIri) {
    throw new Error(`${file}: moduleIri mismatch`);
  }
  const rewritten = rewriteImports(original, state, file);
  const parsed = yaml.load(rewritten);
  const moduleDigest = digest(rewritten);
  state.set(moduleIri, { version: parsed.module.version, digest: moduleDigest });
  desiredFiles.set(filePath, rewritten);
  if (rewritten !== original) changed.push(file);
}

const digestObject = {};
for (const [moduleIri] of MODULES) digestObject[moduleIri] = state.get(moduleIri).digest;
const manifestPath = path.join(META_DIR, 'digests.json');
const desiredManifest = `${JSON.stringify({ digests: digestObject }, null, 2)}\n`;
const currentManifest = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
if (desiredManifest !== currentManifest) changed.push('digests.json');

if (!changed.length) {
  console.log('PASS M3 import/digest closure is current');
  process.exit(0);
}

if (!WRITE) {
  console.error(`FAIL M3 import/digest drift: ${changed.join(', ')}`);
  process.exit(1);
}

for (const [filePath, content] of desiredFiles.entries()) fs.writeFileSync(filePath, content, 'utf8');
fs.writeFileSync(manifestPath, desiredManifest, 'utf8');
console.log(`UPDATED M3 import/digest closure: ${changed.join(', ')}`);
