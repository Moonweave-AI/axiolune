'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  PATHS,
  createPostTradeFixtureReleaseEvidence,
  executeShaclXoneEvidence,
  verifyPostTradeFixtureReleaseEvidence,
} = require('../lib/post-trade-fixture-release-evidence.cjs');
const {
  PATHS: CUSTOM_PATHS,
  ROOT,
} = require('../lib/post-trade-custom-profile.cjs');
const {
  canonicalJcs,
} = require('../lib/strict-source-locator.cjs');
const YAML = require('yaml');

let sharedEvidence;
async function evidence() {
  if (!sharedEvidence) sharedEvidence = createPostTradeFixtureReleaseEvidence();
  return sharedEvidence;
}

function clone(value) {
  return structuredClone(value);
}

test('equivalent release gate executes canonical runtime, SHACL, and exact normalization while quarantining typed defaults', async () => {
  const result = await evidence();
  assert.equal(verifyPostTradeFixtureReleaseEvidence(result), result);
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.classification, {
    fixtureReleaseEvidenceEligible: true,
    m2ConformanceOnly: true,
    productionDataEligible: false,
    syntheticFixture: true,
    typedEnvelopeReleaseEvidence: false,
  });
  assert.equal(result.canonicalRuntime.customRuntimeEvidence.discoveredConstraints.length, 31);
  assert.equal(result.canonicalRuntime.customRuntimeEvidence.vectorResults.length, 68);
  assert.equal(result.canonicalRuntime.customRuntimeEvidence.focusedRegressionResults.length, 242);
  assert.equal(result.canonicalRuntime.customRuntimeEvidence.dispatchAttributionResults.length, 29);
  assert.equal(result.canonicalRuntime.positiveFixtureCount, 8);
  assert.equal(result.canonicalRuntime.negativeFixtureCount, 219);
  assert.equal(result.canonicalRuntime.processingFindingPositiveFixtureCount, 1);
  assert.equal(result.canonicalRuntime.processingFindingNegativeFixtureCount, 14);
  assert.equal(result.shacl.constraintCount, 21);
  assert.equal(result.shacl.resultCount, 63);
  assert.equal(result.shacl.processingFindingEntityResultCount, 5);
  assert.equal(result.shacl.processingFindingEntityResults.filter((row) => row.expectedConforms).length, 3);
  assert.equal(result.shacl.processingFindingEntityResults.filter((row) => !row.expectedConforms).length, 2);
  assert.ok(result.shacl.processingFindingEntityResults.every((row) => (
    row.status === 'passed' && row.actualConforms === row.expectedConforms
  )));
  assert.equal(result.shacl.relatedEntitlementRoleResultCount, 4);
  assert.ok(result.shacl.relatedEntitlementRoleResults.every((row) => (
    row.status === 'passed' && row.actualConforms === row.expectedConforms
  )));
  assert.equal(result.normalization.exactSourceRoundTrip, true);
  assert.equal(result.diagnosticTypedAdapter.derivationCount, 814);
  assert.equal(result.diagnosticTypedAdapter.boundDerivationOverlapCount, 0);
  assert.equal(result.diagnosticTypedAdapter.releaseEvidence, false);
  assert.equal(result.diagnosticTypedAdapter.approvalEligible, false);
});

test('release evidence verifier rejects Custom, SHACL, diagnostic-boundary, and artifact tampering', async () => {
  const baseline = await evidence();
  const custom = clone(baseline);
  custom.canonicalRuntime.customRuntimeEvidence.focusedRegressionResults[0].status = 'failed';
  custom.canonicalRuntime.customRuntimeEvidenceDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => verifyPostTradeFixtureReleaseEvidence(custom), /canonical focused runtime evidence/u);

  const shacl = clone(baseline);
  shacl.shacl.results[0].status = 'failed';
  assert.throws(() => verifyPostTradeFixtureReleaseEvidence(shacl), /SHACL xone execution evidence/u);

  const findingShacl = clone(baseline);
  findingShacl.shacl.processingFindingEntityResults[0].actualConforms = false;
  assert.throws(() => verifyPostTradeFixtureReleaseEvidence(findingShacl), /SHACL xone execution evidence/u);

  const entitlementRoleShacl = clone(baseline);
  entitlementRoleShacl.shacl.relatedEntitlementRoleResults[0].actualConforms = false;
  assert.throws(() => verifyPostTradeFixtureReleaseEvidence(entitlementRoleShacl), /SHACL xone execution evidence/u);

  const diagnostic = clone(baseline);
  diagnostic.diagnosticTypedAdapter.boundDerivationOverlapCount = 1;
  assert.throws(() => verifyPostTradeFixtureReleaseEvidence(diagnostic), /derivation quarantine/u);

  const artifact = clone(baseline);
  artifact.artifacts[0].digest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => verifyPostTradeFixtureReleaseEvidence(artifact), /artifact closure drift/u);
});

test('canonical release vectors are explicit JCS runtime fixtures and contain no diagnostic typed envelope', () => {
  const bytes = fs.readFileSync(CUSTOM_PATHS.vectors);
  const vectors = JSON.parse(bytes.toString('utf8'));
  assert.ok(bytes.equals(Buffer.from(canonicalJcs(vectors), 'utf8')));
  assert.equal(vectors.vectors.length, 31);
  assert.equal(vectors.fixtureCorpus.processingFindingPositive.itemCount, 1);
  assert.equal(vectors.fixtureCorpus.processingFindingNegative.itemCount, 14);
  assert.equal(canonicalJcs(vectors).includes('typedFixtureProfile'), false);
  assert.ok(vectors.vectors.every((row) => (
    row.accepted.fixture.contract === row.violation.fixture.contract
      && typeof row.accepted.fixture.instance === 'object'
      && typeof row.violation.fixture.instance === 'object'
  )));
});

test('fresh SHACL execution fails closed if one authored xone disappears', async () => {
  const moduleDocument = YAML.parse(fs.readFileSync(PATHS.module, 'utf8'));
  delete moduleDocument.domain.constraints.CorporateActionConsiderationXone;
  await assert.rejects(
    () => executeShaclXoneEvidence(moduleDocument),
    /unknown imported ConstraintBinding constraintRef: .*CorporateActionConsiderationXone/u,
  );
});

test('release evidence CLI writes strict JCS that independently verifies', (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-pto-fixture-release-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const run = spawnSync(
    process.execPath,
    [PATHS.boundaryRunner, '--output-dir', output],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      timeout: 180000,
      windowsHide: true,
    },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /Custom=31, fixtures=8\/219\+1\/14, SHACL=21, findingEntitySHACL=5, entitlementRoleSHACL=4, diagnosticDerivations=814/u);
  const bytes = fs.readFileSync(path.join(output, 'post-trade-fixture-release-evidence.json'));
  const result = JSON.parse(bytes.toString('utf8'));
  assert.ok(bytes.equals(Buffer.from(canonicalJcs(result), 'utf8')));
  assert.equal(verifyPostTradeFixtureReleaseEvidence(result), result);
});
