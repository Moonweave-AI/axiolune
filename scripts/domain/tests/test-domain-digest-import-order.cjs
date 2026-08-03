#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const {
  CANONICAL_IMPORTS,
  FINANCE_BASE,
} = require('../lib/canonical-finance-dag.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('digest closure preserves the RFC canonical finance import order', () => {
  for (const [moduleName, expectedImports] of Object.entries(CANONICAL_IMPORTS)) {
    const file = path.join(
      ROOT,
      'ontology',
      'domain',
      'finance',
      moduleName,
      'module.yaml',
    );
    const document = yaml.load(fs.readFileSync(file, 'utf8'));
    const actual = document.module.imports.map((entry) => entry.moduleIri);
    assert.deepEqual(
      actual,
      expectedImports.map((name) => `${FINANCE_BASE}${name}`),
      `${moduleName} import order drifted`,
    );
  }
});

test('digest closure read-only check accepts the byte-closed source tree', () => {
  const run = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'domain', 'compute-digests.cjs')],
    {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /PASS domain digest closure/u);
});
