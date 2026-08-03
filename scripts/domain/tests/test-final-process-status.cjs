'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertFinalProcessResult,
  collectNonFinalStatusMarkers,
} = require('../lib/final-process-status.cjs');

test('clean exit-zero output is final', () => {
  assert.deepEqual(
    collectNonFinalStatusMarkers('PASS all checks\nSUMMARY pass=4 fail=0 pending=0', ''),
    [],
  );
  assert.doesNotThrow(() => assertFinalProcessResult({
    status: 0,
    stdout: 'PASS all checks\nSUMMARY pass=4 fail=0 pending=0',
    stderr: '',
  }, 'fixture'));
});

for (const [name, stdout, options] of [
  ['explicit pending line', 'PASS one\nPENDING authority adoption', {}],
  ['positive pending count', 'SUMMARY pass=39 fail=0 pending=1', {}],
  ['positive warning count', 'warnings: 2', {}],
  ['TAP skip directive', 'ok 1 - optional test # SKIP unavailable', { tap: true }],
  ['TAP todo directive', 'not ok 1 - future test # TODO implement', { tap: true }],
  ['TAP summary', '# tests 2\n# skipped 1', { tap: true }],
]) {
  test(`exit zero cannot hide ${name}`, () => {
    const result = { status: 0, stdout, stderr: '' };
    assert.throws(
      () => assertFinalProcessResult(result, 'synthetic gate', options),
      /non-final status/u,
    );
  });
}

test('ordinary test names containing pending are not mistaken for status', () => {
  assert.deepEqual(
    collectNonFinalStatusMarkers('✔ pending adoption is rejected by the validator', '', { tap: true }),
    [],
  );
});

test('nonzero exit remains fatal even without a marker', () => {
  assert.throws(
    () => assertFinalProcessResult({ status: 2, stdout: '', stderr: '' }, 'synthetic gate'),
    /exit 2/u,
  );
});
