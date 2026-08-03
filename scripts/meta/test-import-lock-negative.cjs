#!/usr/bin/env node
'use strict';

/**
 * Regression tests for byte-authenticated M3 import locks.
 *
 * Each case first constructs a completely self-consistent four-module closure
 * in a temporary directory. It then introduces exactly one well-formed lock
 * defect while keeping the importing file's own digests.json entry current.
 * This prevents malformed syntax or an unrelated stale manifest from making a
 * negative test pass for the wrong reason.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const SOURCE_DIR = path.join(__dirname, '..', '..', 'ontology', 'meta');
const VERIFY = path.join(__dirname, 'verify-meta-model.js');
const FILES = [
  'core-meta-model.yaml',
  'cross-domain-patterns.yaml',
  'behavior-meta-model.yaml',
  'data-binding-meta-model.yaml',
];
const MODULE_FILE = new Map([
  ['https://axiolune.ai/ontology/meta/core', 'core-meta-model.yaml'],
  ['https://axiolune.ai/ontology/meta/patterns', 'cross-domain-patterns.yaml'],
  ['https://axiolune.ai/ontology/meta/behavior', 'behavior-meta-model.yaml'],
  ['https://axiolune.ai/ontology/meta/data-binding', 'data-binding-meta-model.yaml'],
]);
const ORDER = [
  'https://axiolune.ai/ontology/meta/core',
  'https://axiolune.ai/ontology/meta/patterns',
  'https://axiolune.ai/ontology/meta/behavior',
  'https://axiolune.ai/ontology/meta/data-binding',
];

function digestBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function digestFile(file) {
  return digestBytes(fs.readFileSync(file));
}

function writeYaml(file, doc) {
  fs.writeFileSync(file, yaml.dump(doc, { lineWidth: 120, noRefs: true }), 'utf8');
}

function updateImport(importSpec, targetIri, targetDoc, targetDigest) {
  importSpec.moduleIri = `${targetIri}#${targetDigest}`;
  importSpec.version = targetDoc.module.version;
  importSpec.artifactDigest = targetDigest;
}

function buildConsistentClosure(tempDir) {
  for (const file of FILES) {
    fs.copyFileSync(path.join(SOURCE_DIR, file), path.join(tempDir, file));
  }

  const docs = new Map();
  const digests = {};
  for (const moduleIri of ORDER) {
    const file = MODULE_FILE.get(moduleIri);
    const filePath = path.join(tempDir, file);
    const doc = yaml.load(fs.readFileSync(filePath, 'utf8'));
    for (const importSpec of doc.module.imports || []) {
      const targetIri = String(importSpec.moduleIri).split('#')[0];
      const targetDoc = docs.get(targetIri);
      if (!targetDoc || !digests[targetIri]) {
        throw new Error(`non-topological import ${moduleIri} -> ${targetIri}`);
      }
      updateImport(importSpec, targetIri, targetDoc, digests[targetIri]);
    }
    if ((doc.module.imports || []).length) writeYaml(filePath, doc);
    docs.set(moduleIri, doc);
    digests[moduleIri] = digestFile(filePath);
  }
  fs.writeFileSync(path.join(tempDir, 'digests.json'),
    `${JSON.stringify({ digests }, null, 2)}\n`, 'utf8');
}

function runVerifier(tempDir) {
  return spawnSync(process.execPath, [VERIFY], {
    cwd: path.join(__dirname, '..', '..'),
    env: { ...process.env, META_DIR: tempDir },
    encoding: 'utf8',
  });
}

function mutateDataBinding(tempDir, mutate) {
  const file = path.join(tempDir, 'data-binding-meta-model.yaml');
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  mutate(doc.module.imports[0]);
  writeYaml(file, doc);
  const manifestFile = path.join(tempDir, 'digests.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.digests['https://axiolune.ai/ontology/meta/data-binding'] = digestFile(file);
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

const ZERO = `sha256:${'0'.repeat(64)}`;
const cases = [
  {
    name: 'well-formed stale artifact digest and matching IRI fragment',
    expected: '!= imported bytes',
    mutate: imp => {
      const base = String(imp.moduleIri).split('#')[0];
      imp.moduleIri = `${base}#${ZERO}`;
      imp.artifactDigest = ZERO;
    },
  },
  {
    name: 'IRI fragment differs from artifactDigest',
    expected: '!= artifactDigest',
    mutate: imp => {
      const base = String(imp.moduleIri).split('#')[0];
      imp.moduleIri = `${base}#${ZERO}`;
    },
  },
  {
    name: 'stale imported module version',
    expected: '!= imported module version',
    mutate: imp => { imp.version = '0.5.0'; },
  },
  {
    name: 'unknown content-addressed module target',
    expected: 'unknown import target',
    mutate: imp => {
      imp.moduleIri = `https://axiolune.ai/ontology/meta/not-shipped#${imp.artifactDigest}`;
    },
  },
];

let failed = 0;
for (const testCase of cases) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-meta-lock-'));
  try {
    buildConsistentClosure(tempDir);
    const baseline = runVerifier(tempDir);
    if (baseline.status !== 0) {
      console.error(`FAIL ${testCase.name}: consistent baseline was rejected`);
      console.error((baseline.stdout || '') + (baseline.stderr || ''));
      failed++;
      continue;
    }
    mutateDataBinding(tempDir, testCase.mutate);
    const result = runVerifier(tempDir);
    const output = (result.stdout || '') + (result.stderr || '');
    if (result.status === 0 || !output.includes(testCase.expected)) {
      console.error(`FAIL ${testCase.name}: exit=${result.status}, expected diagnostic ${testCase.expected}`);
      failed++;
    } else {
      console.log(`PASS ${testCase.name}`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (failed) {
  console.error(`${failed}/${cases.length} import-lock negative tests failed`);
  process.exit(1);
}
console.log(`PASS import-lock negative vectors: ${cases.length}`);
