#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  compileCqSourceInventory,
  discoverCqSourcePaths,
} = require('../lib/m2-cq-source-inventory.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('CQ source inventory discovers every disposition and active execution dynamically', () => {
  const result = compileCqSourceInventory(ROOT);
  assert.equal(result.stats.sourceCount, discoverCqSourcePaths(ROOT).length);
  assert.equal(result.stats.cqCount, result.inventory.entries.length);
  assert.ok(result.stats.activeCqCount > 0);
  assert.ok(result.stats.uniqueActiveExecutionCount > 0);
  assert.ok(result.stats.uniqueActiveExecutionCount <= result.stats.activeCqCount);
  assert.equal(
    result.stats.activeCqCount
      + result.stats.retiredCqCount
      + result.stats.deferredCqCount,
    result.stats.cqCount,
  );
  const alias = result.inventory.entries.find((entry) => entry.aliasOf !== null);
  assert.ok(alias, 'the source registry must preserve its explicit CQ alias');
  assert.equal(alias.executionIdentity, alias.aliasOf);
});

test('CQ source inventory is deterministic and byte-exact JCS', () => {
  const first = compileCqSourceInventory(ROOT);
  const second = compileCqSourceInventory(ROOT);
  assert.deepEqual(first.inventory, second.inventory);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.bytes.at(-1), 0x7d, 'inventory must not contain a trailing LF');
});

test('CQ source inventory rejects an undeclared shared execution identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-cq-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'docs', 'ontology', 'competency-questions');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'test.yaml'), [
    "schemaVersion: '1.0'",
    'cqs:',
    '  - id: CQ-A1',
    '    status: active',
    '  - id: CQ-B1',
    '    status: active',
    '    executionIdentity: CQ-A1',
    '',
  ].join('\n'));
  assert.throws(
    () => compileCqSourceInventory(root),
    /cannot share an executionIdentity without aliasOf/u,
  );
});
