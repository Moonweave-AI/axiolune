'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const YAML = require('yaml');
const {
  executeRequest: executeFoundationMarketStrategy,
} = require('../run-foundation-market-strategy-custom-runtime.cjs');
const {
  executeRequest: executePostTrade,
} = require('../run-post-trade-custom-runtime.cjs');
const {
  canonicalScenario: canonicalRiskScenario,
  executeRequest: executeRisk,
} = require('../run-risk-custom-runtime.cjs');
const {
  canonicalJcs,
} = require('../lib/strict-source-locator.cjs');

const UNBOUND_DIGEST = `sha256:${'9'.repeat(64)}`;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function substituteUnboundSourceEvidence(document) {
  const candidate = structuredClone(document);
  let scalarLocators = 0;
  let sourceClaims = 0;

  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (Object.hasOwn(value, 'sourceArtifactDigest')) {
      assert.ok(
        Object.hasOwn(value, 'sourceLocator'),
        'sourceArtifactDigest must be paired with sourceLocator',
      );
      value.sourceArtifactDigest = UNBOUND_DIGEST;
      sourceClaims += 1;
      if (typeof value.sourceLocator === 'string') {
        scalarLocators += 1;
      } else if (value.sourceLocator && typeof value.sourceLocator === 'object') {
        assert.ok(
          Object.hasOwn(value.sourceLocator, 'selectionDigest'),
          'structured SourceLocator must bind selected bytes',
        );
        value.sourceLocator.selectionDigest = UNBOUND_DIGEST;
      }
    }
    for (const nested of Object.values(value)) visit(nested);
  }

  visit(candidate);
  return { candidate, scalarLocators, sourceClaims };
}

test('Post-trade source claims fail closed after arbitrary unbound digest substitution', () => {
  const profile = readJson(
    'scripts/domain/post-trade-custom-profile/v0.3.0/test-vectors.json',
  );
  const failures = [];
  let accepted = 0;
  let notApplicable = 0;
  let rejected = 0;
  let scalarLocators = 0;
  let sourceClaims = 0;

  for (const vector of profile.vectors) {
    const mutation = substituteUnboundSourceEvidence(vector.accepted.fixture);
    if (mutation.sourceClaims === 0) continue;
    sourceClaims += mutation.sourceClaims;
    scalarLocators += mutation.scalarLocators;
    const result = executePostTrade({
      constraintIri: vector.constraintIri,
      fixture: mutation.candidate,
      schemaVersion: '1.0',
      validatorId: vector.validatorId,
    });
    const outcome = result.response?.outcome || result.code || result.status;
    if ((result.status === 'completed' && outcome === 'violation')
        || (result.status === 'engine-failure' && result.code === 'WORKER_EXIT')) {
      rejected += 1;
      continue;
    }
    if (outcome === 'accepted') accepted += 1;
    if (outcome === 'notApplicable') notApplicable += 1;
    failures.push(
      `${vector.validatorId}: ${outcome} after ${mutation.sourceClaims} unbound source claim(s)`,
    );
  }

  assert.ok(sourceClaims > 0, 'Post-trade profile exposed no source claim');
  assert.equal(scalarLocators, 0, 'Post-trade source claims must use structured SourceLocator');
  assert.deepEqual(
    failures,
    [],
    `Post-trade source-evidence boundary did not fail closed `
      + `(accepted=${accepted}, notApplicable=${notApplicable}, rejected=${rejected}, `
      + `sourceClaims=${sourceClaims})`,
  );

  const vector = profile.vectors.find((row) => row.accepted.fixture.instance.artifacts.length > 0);
  assert.ok(vector, 'Post-trade profile exposed no authenticated artifact inventory');

  function run(instance) {
    return executePostTrade({
      constraintIri: vector.constraintIri,
      fixture: { contract: vector.accepted.fixture.contract, instance },
      schemaVersion: '1.0',
      validatorId: vector.validatorId,
    });
  }

  const cases = [];
  const missing = structuredClone(vector.accepted.fixture.instance);
  missing.artifacts.pop();
  cases.push(['missing-artifact', missing]);

  const wrongBytes = structuredClone(vector.accepted.fixture.instance);
  const raw = JSON.parse(Buffer.from(wrongBytes.artifacts[0].rawBytesBase64, 'base64'));
  raw.schemaVersion = '1.1';
  wrongBytes.artifacts[0].rawBytesBase64 = Buffer.from(canonicalJcs(raw), 'utf8').toString('base64');
  cases.push(['wrong-raw-bytes', wrongBytes]);

  const wrongProfile = structuredClone(vector.accepted.fixture.instance);
  wrongProfile.artifacts[0].extractorProfileDigest = `sha256:${'8'.repeat(64)}`;
  cases.push(['wrong-extractor-profile', wrongProfile]);

  const duplicate = structuredClone(vector.accepted.fixture.instance);
  duplicate.artifacts.splice(1, 0, structuredClone(duplicate.artifacts[0]));
  cases.push(['duplicate-artifact', duplicate]);

  const extra = structuredClone(vector.accepted.fixture.instance);
  const extraArtifact = structuredClone(extra.artifacts.at(-1));
  extraArtifact.artifactRef = { iri: 'urn:artifact:unclaimed-extra', kind: 'iri' };
  extra.artifacts.push(extraArtifact);
  cases.push(['extra-artifact', extra]);

  for (const [id, instance] of cases) {
    const result = run(instance);
    assert.equal(result.status, 'engine-failure', `${id} did not fail closed`);
    assert.equal(result.code, 'WORKER_EXIT', `${id} failed through the wrong boundary`);
  }
});

test('Risk source claims reject arbitrary digests that are not bound to artifact bytes', () => {
  const profile = readJson(
    'scripts/domain/risk-custom-profile/v0.3.0/discovery-contract.json',
  );
  const fixtures = YAML.parse(
    fs.readFileSync('tests/m2/fixtures/positive/risk-v03.yaml', 'utf8'),
  );
  const byId = new Map(fixtures.fixtures.map((fixture) => [fixture.id, fixture]));
  const failures = [];
  let exercised = 0;

  for (const binding of profile.constraints) {
    const fixture = byId.get(binding.positiveFixtureId);
    assert.ok(fixture, `missing Risk positive fixture ${binding.positiveFixtureId}`);
    const canonicalScenario = canonicalRiskScenario(fixture.instance);
    assert.ok(canonicalScenario.artifacts.length > 0, `${binding.evaluatorId} has no artifact inventory`);
    const mutation = substituteUnboundSourceEvidence(canonicalScenario);
    assert.ok(mutation.sourceClaims > 0, `${binding.evaluatorId} has no source claim`);
    exercised += 1;
    const result = executeRisk({
      constraintIri: binding.constraintIri,
      evaluatorId: binding.evaluatorId,
      scenario: mutation.candidate,
      schemaVersion: '1.0',
    });
    if ((result.status === 'completed' && result.response?.outcome === 'rejected')
        || (result.status === 'engine-failure' && result.code === 'WORKER_EXIT')) continue;
    failures.push(
      `${binding.evaluatorId}: ${result.response?.outcome || result.code || result.status} `
        + `after ${mutation.sourceClaims} unbound source claim(s)`,
    );
  }

  assert.equal(exercised, profile.constraints.length);
  assert.deepEqual(failures, []);

  const binding = profile.constraints.find(
    (row) => row.evaluatorId !== 'validateRiskMeasureDefinitionConstraint',
  );
  const seed = canonicalRiskScenario(byId.get(binding.positiveFixtureId).instance);
  function run(instance) {
    return executeRisk({
      constraintIri: binding.constraintIri,
      evaluatorId: binding.evaluatorId,
      scenario: instance,
      schemaVersion: '1.0',
    });
  }
  const cases = [];
  const missing = structuredClone(seed);
  missing.artifacts.pop();
  cases.push(['missing-artifact', missing]);

  const wrongBytes = structuredClone(seed);
  const raw = JSON.parse(Buffer.from(wrongBytes.artifacts[0].rawBytesBase64, 'base64'));
  raw.schemaVersion = '1.1';
  wrongBytes.artifacts[0].rawBytesBase64 = Buffer.from(canonicalJcs(raw), 'utf8').toString('base64');
  cases.push(['wrong-raw-bytes', wrongBytes]);

  const wrongProfile = structuredClone(seed);
  wrongProfile.artifacts[0].extractorProfileDigest = `sha256:${'8'.repeat(64)}`;
  cases.push(['wrong-extractor-profile', wrongProfile]);

  const duplicate = structuredClone(seed);
  duplicate.artifacts.splice(1, 0, structuredClone(duplicate.artifacts[0]));
  cases.push(['duplicate-artifact', duplicate]);

  const extra = structuredClone(seed);
  const extraArtifact = structuredClone(extra.artifacts.at(-1));
  extraArtifact.artifactRef = { iri: 'urn:artifact:risk-unclaimed-extra', kind: 'iri' };
  extra.artifacts.push(extraArtifact);
  cases.push(['extra-artifact', extra]);

  for (const [id, scenario] of cases) {
    const result = run(scenario);
    assert.equal(result.status, 'engine-failure', `${id} did not fail closed`);
    assert.equal(result.code, 'WORKER_EXIT', `${id} failed through the wrong boundary`);
  }
});

test('Foundation/Market/Strategy digest-locked scenarios reject the same substitution', () => {
  const profile = readJson(
    'scripts/domain/foundation-market-strategy-custom-profile/v0.3.0/test-vectors.json',
  );
  let exercised = 0;
  const failures = [];

  for (const vector of profile.vectors) {
    const mutation = substituteUnboundSourceEvidence(vector.accepted.scenario);
    if (mutation.sourceClaims === 0) continue;
    exercised += 1;
    const result = executeFoundationMarketStrategy({
      constraintIri: vector.constraintIri,
      dispatchDigest: vector.dispatchDigest,
      scenario: mutation.candidate,
      schemaVersion: '1.0',
      validatorId: vector.validatorId,
    });
    if (result.status === 'engine-failure' && result.code === 'WORKER_EXIT') continue;
    failures.push(
      `${vector.validatorId}: ${result.response?.outcome || result.code || result.status}`,
    );
  }

  assert.ok(exercised > 0, 'Foundation/Market/Strategy profile exposed no source claim');
  assert.deepEqual(failures, []);
});

test('Identifier vectors contain lexical validation inputs, not source-evidenced records', () => {
  const profile = readJson(
    'scripts/domain/identifier-custom-profile/v0.3.0/test-vectors.json',
  );
  const mutation = substituteUnboundSourceEvidence(profile);
  assert.equal(mutation.sourceClaims, 0);
});
