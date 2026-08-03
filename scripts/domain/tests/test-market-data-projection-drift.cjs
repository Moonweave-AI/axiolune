'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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
  'market-data',
  'module.yaml',
);
const TRACKED = {
  owl: [
    path.join(ROOT, 'ontology/domain/finance/market-data/module.owl.ttl'),
    path.join(ROOT, 'generated/ontology/finance/market-data/market-data.owl.ttl'),
  ],
  shacl: [
    path.join(ROOT, 'ontology/domain/finance/market-data/module.shacl.ttl'),
    path.join(ROOT, 'generated/ontology/finance/market-data/market-data.shacl.ttl'),
  ],
};

let directory;
let generated;

function runGenerator(script, output) {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'domain', script), MODULE, output],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return fs.readFileSync(output);
}

before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-md-projection-'));
  generated = {
    owl: runGenerator(
      'generate-m2-owl.cjs',
      path.join(directory, 'market-data.owl.ttl'),
    ),
    shacl: runGenerator(
      'generate-m2-shacl.cjs',
      path.join(directory, 'market-data.shacl.ttl'),
    ),
  };
});

after(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

test('Market Data OWL and SHACL sidecars equal a fresh v0.3 generation byte-for-byte', () => {
  for (const [kind, files] of Object.entries(TRACKED)) {
    for (const file of files) {
      assert.ok(
        fs.readFileSync(file).equals(generated[kind]),
        `${path.relative(ROOT, file)} drifted from the current module.yaml`,
      );
    }
  }
  const owl = generated.owl.toString('utf8');
  assert.match(
    owl,
    /owl:versionIRI <https:\/\/axiolune\.ai\/ontology\/finance\/market-data\/0\.3\.0>/u,
  );
  assert.doesNotMatch(
    owl,
    /PriceKind\/value\/(?:bid|ask)>/u,
    'legacy one-sided Bid/Ask PriceKind members must not reappear',
  );
});

test('fresh Market Data projections parse as non-empty Turtle graphs', () => {
  for (const [kind, bytes] of Object.entries(generated)) {
    const quads = new Parser().parse(bytes.toString('utf8'));
    assert.ok(quads.length > 0, `${kind} projection parsed as an empty graph`);
  }
});
