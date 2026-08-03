'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { Parser } = require('n3');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MODULE = path.join(
  ROOT,
  'ontology',
  'domain',
  'finance',
  'post-trade-operations',
  'module.yaml',
);

const COMPARISONS = [
  {
    kind: 'owl',
    tracked: path.join(
      ROOT,
      'ontology/domain/finance/post-trade-operations/module.owl.ttl',
    ),
  },
  {
    kind: 'shacl',
    tracked: path.join(
      ROOT,
      'ontology/domain/finance/post-trade-operations/module.shacl.ttl',
    ),
  },
  {
    kind: 'owl',
    tracked: path.join(
      ROOT,
      'generated/ontology/finance/post-trade-operations/post-trade-operations.owl.ttl',
    ),
  },
  {
    kind: 'shacl',
    tracked: path.join(
      ROOT,
      'generated/ontology/finance/post-trade-operations/post-trade-operations.shacl.ttl',
    ),
  },
];

let directory;
let generated;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function firstDifference(left, right) {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return left.length === right.length ? -1 : sharedLength;
}

function runGenerator(script, output) {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'domain', script), MODULE, output],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(
    result.status,
    0,
    `${script} failed with exit ${String(result.status)}:\n${result.stderr || result.stdout}`,
  );
  return fs.readFileSync(output);
}

before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-pto-projection-'));
  generated = {
    owl: runGenerator(
      'generate-m2-owl.cjs',
      path.join(directory, 'post-trade-operations.owl.ttl'),
    ),
    shacl: runGenerator(
      'generate-m2-shacl.cjs',
      path.join(directory, 'post-trade-operations.shacl.ttl'),
    ),
  };
});

after(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test('Post-trade OWL/SHACL fresh generation matches all four tracked projections byte-for-byte', () => {
  const missing = COMPARISONS
    .filter(({ tracked }) => !fs.existsSync(tracked))
    .map(({ tracked }) => path.relative(ROOT, tracked));
  assert.deepEqual(missing, [], `missing tracked projection(s): ${missing.join(', ')}`);

  const drift = [];
  for (const { kind, tracked } of COMPARISONS) {
    const expected = generated[kind];
    const actual = fs.readFileSync(tracked);
    if (!actual.equals(expected)) {
      drift.push({
        file: path.relative(ROOT, tracked).replaceAll('\\', '/'),
        freshSha256: sha256(expected),
        trackedSha256: sha256(actual),
        freshBytes: expected.length,
        trackedBytes: actual.length,
        firstDifferingByte: firstDifference(expected, actual),
      });
    }
  }

  assert.deepEqual(
    drift,
    [],
    `Post-trade projection drift detected in ${drift.length}/4 tracked artifacts:\n${JSON.stringify(drift, null, 2)}`,
  );
});

test('fresh Post-trade OWL and SHACL projections parse as non-empty Turtle graphs', () => {
  for (const [kind, bytes] of Object.entries(generated)) {
    const quads = new Parser().parse(bytes.toString('utf8'));
    assert.ok(quads.length > 0, `${kind} projection parsed as an empty graph`);
  }
});
