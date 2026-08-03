'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const VALIDATOR = path.join(ROOT, 'scripts/domain/validate-pit.cjs');
const SOURCE = path.join(
  ROOT,
  'tests/m2/fixtures/negative/factor-observation-revision-negative.yaml',
);
const REFERENCE_TIME = path.join(
  ROOT,
  'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/control-chain-input.json',
);
const FIXTURE_ID = 'factor-obs-future-availability';

function execute(fixtureFile) {
  return spawnSync(
    process.execPath,
    [
      VALIDATOR,
      fixtureFile,
      REFERENCE_TIME,
      '--fixture-id',
      FIXTURE_ID,
    ],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true },
  );
}

function withMutatedFixture(t, mutate) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-pit-exact-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'fixture.yaml');
  const source = fs.readFileSync(SOURCE, 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, 'mutation must change the fixture bytes');
  fs.writeFileSync(target, mutated, 'utf8');
  return target;
}

test('the routed PIT fixture passes only with its exact rejection code', () => {
  const result = execute(SOURCE);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /future-availability: asOfAvailable < availableFrom/u);
});

test('a broad rejection label cannot receive credit for future-availability', (t) => {
  const fixture = withMutatedFixture(t, (source) => source.replace(
    '    violationType: future-availability\n',
    '    violationType: future\n',
  ));
  const result = execute(fixture);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /PIT rejection code set mismatch; expected future, actual future-availability/u,
  );
});

test('one expected code cannot hide a second PIT-axis violation', (t) => {
  const fixture = withMutatedFixture(t, (source) => source.replace(
    "      asOfValid: '2024-06-15T00:00:00Z'\n",
    "      asOfValid: '2023-06-15T00:00:00Z'\n",
  ));
  const result = execute(fixture);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /expected future-availability, actual valid-before-start,future-availability/u,
  );
});

test('a routed PIT rejection without an exact code fails closed', (t) => {
  const fixture = withMutatedFixture(t, (source) => source.replace(
    '    violationType: future-availability\n',
    '',
  ));
  const result = execute(fixture);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /expected <missing exact code>, actual future-availability/u,
  );
});
