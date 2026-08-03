'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  auditWorkspace,
} = require('../audit-constraint-instance-closure.cjs');

test('current dual-route release closure joins all 10,325 exact instances', async () => {
  const result = await auditWorkspace();
  assert.equal(result.outcome, 'passed');
  assert.equal(result.moduleCount, 10);
  assert.equal(result.authoredConstraintCount, 170);
  assert.equal(result.authoredBindingCount, 567);
  assert.equal(result.authoredContextLowerBound, 567);
  assert.deepEqual(result.unboundAuthoredDefinitions, []);
  assert.deepEqual(result.routedModules, [
    'foundation', 'instruments', 'market-data', 'market-rules',
    'market-structure', 'orders-execution', 'portfolio-positions',
    'post-trade-operations', 'risk', 'strategy-research',
  ]);
  assert.deepEqual(result.missingRoutedModules, []);
  assert.equal(
    result.manifestPath,
    'scripts/domain/release-profile/v0.3.0/constraint-instance-manifest.json',
  );
  assert.equal(result.entryCount, 10325);
  assert.equal(result.generatedCount, 9664);
  assert.deepEqual(result.authoredOriginMissing, []);
  assert.deepEqual(result.authoredBindingMissing, []);
  assert.equal(result.gateJoin.outcome, 'passed');
  assert.equal(result.gateJoin.itemCount, 10325);
  assert.equal(result.gateJoin.checkCount, 10325);
  assert.deepEqual(result.issues, []);
});
