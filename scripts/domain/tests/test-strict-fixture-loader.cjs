'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  applyMutation,
  loadFixture,
  pathTokens,
} = require('../lib/strict-fixture-loader.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-fixture-loader-'));
try {
  fs.writeFileSync(
    path.join(directory, 'base.yaml'),
    'caseId: base\npayload:\n  rows:\n    - {id: one, value: 1}\nexpected: {valid: true}\n',
  );
  fs.writeFileSync(
    path.join(directory, 'child.yaml'),
    'caseId: child\nextends: base.yaml\nmutations:\n  - {op: set, path: "payload.rows[0].value", value: 2}\nexpected: {valid: false, codes: [CHANGED]}\n',
  );
  const child = loadFixture(path.join(directory, 'child.yaml'), { rootDirectory: directory });
  assert.equal(child.caseId, 'child');
  assert.equal(child.payload.rows[0].value, 2);
  assert.deepEqual(child.expected, { valid: false, codes: ['CHANGED'] });
  assert.equal(Object.hasOwn(child, 'extends'), false);
  assert.equal(Object.hasOwn(child, 'mutations'), false);

  assert.deepEqual(pathTokens('payload.rows[0].value'), ['payload', 'rows', 0, 'value']);
  assert.throws(() => pathTokens('payload.__proto__.x'), /unsafe mutation path/u);
  assert.throws(
    () => applyMutation(child, { op: 'delete', path: 'payload.rows[1]' }),
    /does not resolve/u,
  );

  fs.writeFileSync(
    path.join(directory, 'cycle-a.yaml'),
    'caseId: cycle-a\nextends: cycle-b.yaml\n',
  );
  fs.writeFileSync(
    path.join(directory, 'cycle-b.yaml'),
    'caseId: cycle-b\nextends: cycle-a.yaml\n',
  );
  assert.throws(
    () => loadFixture(path.join(directory, 'cycle-a.yaml'), { rootDirectory: directory }),
    /cyclic fixture inheritance/u,
  );
  assert.throws(
    () => loadFixture(path.join(directory, '..', 'outside.yaml'), { rootDirectory: directory }),
    /fixture escapes directory/u,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('strict-fixture-loader: PASS');
