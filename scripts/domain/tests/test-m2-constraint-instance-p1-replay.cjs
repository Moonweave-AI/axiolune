'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  EXPECTED_COUNTS,
  GATE_PATHS,
  collectConstraintReplayFiles,
  replayConstraintInstancesFromP1,
  workspaceConstraintReplayFiles,
} = require('../lib/m2-constraint-instance-p1-replay.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('independently rebuilds and joins all 10,325 constraint instances from isolated P1 bytes', {
  timeout: 25 * 60 * 1000,
}, () => {
  const files = workspaceConstraintReplayFiles(ROOT);
  const result = replayConstraintInstancesFromP1({ files });
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.issues, []);
  for (const [name, expected] of Object.entries(EXPECTED_COUNTS)) {
    assert.equal(result[name], expected, name);
  }
  assert.equal(result.manifestByteReplayMatched, true);
  assert.equal(result.contextualReplayVerified, true);
  assert.equal(result.gateJoinOutcome, 'passed');
  assert.equal(result.gateJoinItemCount, EXPECTED_COUNTS.entryCount);
  assert.equal(result.gateJoinCheckCount, EXPECTED_COUNTS.entryCount);
  assert.equal(result.isolatedTemporaryCopy, true);
  assert.equal(result.callerEvidenceAccepted, false);
  assert.equal(result.shaclDescriptorCount, 10325);
  assert.equal(result.shaclInstanceCount, 10171);
  assert.equal(result.customDeferredToCapabilityReplayCount, 154);
  assert.equal(result.shaclCaseExecutionCount, 20342);
  assert.equal(result.shaclExecutionOutcome, 'passed');
  assert.equal(result.shaclCallerEvidenceAccepted, false);
});

test('refuses a P1 closure with one missing gate-join artifact', () => {
  const files = workspaceConstraintReplayFiles(ROOT);
  files.delete(GATE_PATHS.report);
  assert.throws(
    () => collectConstraintReplayFiles(files),
    /bytes are missing/u,
  );
});
