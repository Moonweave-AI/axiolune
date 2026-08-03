'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  bucketDigest,
  loadYaml,
  validateScenario,
} = require('../lib/risk-v03-contract.cjs');
const {
  createRiskAdversarialCases,
} = require('../lib/risk-adversarial-cases.cjs');
const {
  authenticateSourceClaims,
} = require('../lib/post-trade-risk-source-artifact-inventory.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const document = loadYaml(path.join(
  ROOT,
  'tests',
  'm2',
  'fixtures',
  'positive',
  'risk-v03.yaml',
));
const fixtures = new Map(document.fixtures.map((fixture) => [fixture.id, fixture.instance]));
const cases = createRiskAdversarialCases({
  moneyScenario: fixtures.get('cq-r1-money-measurement-within-limit'),
  bucketScenario: fixtures.get('cq-r1-bucketed-greeks-within-limit'),
  bucketDigest,
});

test('implementation and IO contract digests bind exact repository file bytes', () => {
  const pathsByRole = {
    implementation: 'scripts/domain/lib/risk-v03-contract.cjs',
    inputContract: 'scripts/domain/risk-custom-profile/v0.3.0/input-contract.json',
    outputContract: 'scripts/domain/risk-custom-profile/v0.3.0/output-contract.json',
  };
  for (const fixture of fixtures.values()) {
    for (const [role, relativePath] of Object.entries(pathsByRole)) {
      const artifact = fixture.artifactRecords.find((record) => record.artifactRole === role);
      const expectedDigest = `sha256:${crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(ROOT, ...relativePath.split('/'))))
        .digest('hex')}`;
      assert.equal(artifact.artifactPath, relativePath);
      assert.equal(artifact.artifactSelector, '$wholeFile');
      assert.equal(artifact.artifactDigest, expectedDigest);
    }
  }
});

for (const adversarial of cases) {
  test(`full validateScenario rejects ${adversarial.id}`, () => {
    assert.throws(
      () => validateScenario(authenticateSourceClaims(
        adversarial.scenario,
        { namespace: 'risk-source' },
      )),
      (error) => error.code === adversarial.expectedViolation,
    );
  });
}
