'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  audit,
  discoverConstraints,
} = require('../audit-custom-release-toolchain.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('discovers the unique ontology-authoritative Custom constraint IRIs across ten modules', () => {
  const rows = discoverConstraints();
  assert.ok(rows.length > 0);
  assert.equal(new Set(rows.map((row) => row.moduleName)).size, 10);
  assert.equal(new Set(rows.map((row) => row.constraintIri)).size, rows.length);
  assert.ok(rows.some((row) => row.constraintIri.endsWith('/OTCTradingContextReferenceContract')));
  assert.ok(rows.some((row) => row.constraintIri.endsWith('/PortfolioObservationStreamContract')));
  assert.ok(rows.some((row) => row.constraintIri.endsWith('/OrderIntentLineageContract')));
});

test('component S5 lock cannot masquerade as a missing single v0.3 release lock', () => {
  const missingReleaseLock = path.join(ROOT, 'releases', 'v0.3.0', 'missing-toolchain.lock.json');
  const result = audit(missingReleaseLock);
  const expectedCount = discoverConstraints().length;
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.releaseLockExists, false);
  assert.equal(result.customConstraintCount, expectedCount);
  assert.equal(result.boundConstraintCount, 0);
  assert.equal(result.missingCapabilityIris.length, expectedCount);
  assert.equal(result.componentLocksCountAsReleaseLock, false);
  assert.ok(result.existingComponentLockPaths.includes(
    'scripts/domain/control-record-profile/s5-v1/toolchain.lock.json',
  ));
});
