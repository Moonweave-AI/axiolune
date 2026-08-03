'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  MATERIALIZER_BINDING_PATHS,
  S5CompletedRunProducerReplayError,
  SLICE_A_REPLAY_PROFILES,
  replayLockedSliceACompletedRun,
} = require('../lib/s5-completed-run-producer-replay.cjs');
const {
  computeDatasetDigest,
  computeNamedGraphDigest,
} = require('../lib/rdfc-1.0.cjs');
const {
  canonicalJcs,
} = require('../lib/strict-source-locator.cjs');
const {
  materializeHistoricalDataset,
} = require('../lib/s5-canonical-materialization.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_ROOT = 'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain';
const SOURCE_SCHEMA = `${FIXTURE_ROOT}/source/source-schema.json`;
const SOURCE_SNAPSHOT = `${FIXTURE_ROOT}/source-snapshot-original.json`;
const PRECISION_POLICY = `${FIXTURE_ROOT}/source/valuation-precision-policy.json`;
const ROUNDING_POLICY = `${FIXTURE_ROOT}/source/valuation-rounding-policy.json`;

function bytes(relativePath) {
  return fs.readFileSync(path.join(ROOT, ...relativePath.split('/')));
}

function clone(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function runIris(profile, runIri) {
  const values = {
    identity: 'urn:axiolune:producer-replay:unselected:identity',
    market: 'urn:axiolune:producer-replay:unselected:market',
    portfolio: 'urn:axiolune:producer-replay:unselected:portfolio',
  };
  values[profile.runSlot] = runIri;
  return values;
}

function requestFor(graphIri) {
  const profile = SLICE_A_REPLAY_PROFILES[graphIri];
  assert.ok(profile, graphIri);
  const runIri = `urn:axiolune:materialization-run:test:${profile.runSlot}`;
  const sourceSnapshotBytes = bytes(SOURCE_SNAPSHOT);
  const rows = JSON.parse(sourceSnapshotBytes.toString('utf8')).rows;
  const valuationPolicyArtifacts = {
    precisionBytes: bytes(PRECISION_POLICY),
    roundingBytes: bytes(ROUNDING_POLICY),
  };
  const selectedRuns = runIris(profile, runIri);
  const produced = materializeHistoricalDataset(
    rows,
    selectedRuns.identity,
    selectedRuns.market,
    selectedRuns.portfolio,
    'urn:axiolune:producer-replay:unselected:batch',
    { valuationPolicyArtifacts },
  );
  const graph = computeNamedGraphDigest(produced.nquads, graphIri);
  return {
    graphIri,
    mappingTargets: clone(profile.mappingTargets),
    materializerArtifacts: MATERIALIZER_BINDING_PATHS.map((relativePath) => ({
      bytes: bytes(relativePath),
      path: relativePath,
    })),
    outputBytes: Buffer.from(graph.canonicalNQuads, 'utf8'),
    planRef: profile.planRef,
    runIri,
    semanticProfileArtifacts: profile.semanticProfilePaths.map((relativePath) => ({
      bytes: bytes(relativePath),
      path: relativePath,
    })),
    sourceSchemaBytes: bytes(SOURCE_SCHEMA),
    sourceSnapshotBytes,
    valuationPolicyArtifacts,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof S5CompletedRunProducerReplayError);
    assert.equal(error.code, code);
    return true;
  });
}

for (const graphIri of Object.keys(SLICE_A_REPLAY_PROFILES)) {
  test(`replays exact installed Slice-A producer for ${graphIri}`, () => {
    const request = requestFor(graphIri);
    const result = replayLockedSliceACompletedRun(request);
    assert.equal(result.graphIri, graphIri);
    assert.equal(result.planRef, request.planRef);
    assert.equal(
      result.graphDigest,
      computeNamedGraphDigest(request.outputBytes.toString('utf8'), graphIri).digest,
    );
    assert.ok(result.factVersionCount > 0);
    assert.equal(result.replayKind, 'verifier-owned-slice-a-materializer');
    assert.ok(Object.isFrozen(result));
  });
}

test('rejects fully canonical output with an extra unmapped property', () => {
  const request = requestFor('urn:axiolune:graph:slice-a:identity:v1');
  const original = request.outputBytes.toString('utf8').trimEnd().split('\n');
  const subject = original[0].slice(1, original[0].indexOf('>'));
  request.outputBytes = Buffer.from(computeDatasetDigest(`${[
    ...original,
    `<${subject}> <urn:axiolune:property:not-in-mapping> "attacker" <${request.graphIri}> .`,
  ].join('\n')}\n`).canonicalNQuads, 'utf8');
  expectCode(
    () => replayLockedSliceACompletedRun(request),
    'S5_PRODUCER_REPLAY_OUTPUT_MISMATCH',
  );
});

test('rejects source/output mismatch after the source snapshot is fully resealed', () => {
  const request = requestFor('urn:axiolune:graph:slice-a:market-data:v1');
  const snapshot = JSON.parse(request.sourceSnapshotBytes.toString('utf8'));
  snapshot.rows[0].price = '999.99';
  snapshot.rows[0].provider_observation_id = 'ATTACKER-SUBSTITUTION';
  request.sourceSnapshotBytes = Buffer.from(canonicalJcs(snapshot), 'utf8');
  expectCode(
    () => replayLockedSliceACompletedRun(request),
    'S5_PRODUCER_REPLAY_OUTPUT_MISMATCH',
  );
});

test('rejects an incomplete mapping target profile before replay', () => {
  const request = requestFor('urn:axiolune:graph:slice-a:portfolio-valuation:v1');
  request.mappingTargets.pop();
  expectCode(
    () => replayLockedSliceACompletedRun(request),
    'S5_PRODUCER_REPLAY_PROFILE',
  );
});

test('rejects bundle materializer bytes that differ from the installed verifier runtime', () => {
  const request = requestFor('urn:axiolune:graph:slice-a:identity:v1');
  request.materializerArtifacts[0].bytes = Buffer.concat([
    request.materializerArtifacts[0].bytes,
    Buffer.from('\n'),
  ]);
  expectCode(
    () => replayLockedSliceACompletedRun(request),
    'S5_PRODUCER_REPLAY_BINDING',
  );
});

test('rejects resealed mapping bytes that differ from the verifier-installed semantic profile', () => {
  const request = requestFor('urn:axiolune:graph:slice-a:market-data:v1');
  const row = request.semanticProfileArtifacts.find(
    (entry) => entry.path.endsWith('price-observation.semantic-mapping.json'),
  );
  const mapping = JSON.parse(row.bytes.toString('utf8'));
  mapping.label = `${mapping.label} attacker`;
  row.bytes = Buffer.from(canonicalJcs(mapping), 'utf8');
  expectCode(
    () => replayLockedSliceACompletedRun(request),
    'S5_PRODUCER_REPLAY_SEMANTIC_PROFILE',
  );
});

test('binds every referenced TransformationDefinition into the producer semantic profile', () => {
  const request = requestFor('urn:axiolune:graph:slice-a:portfolio-valuation:v1');
  const definitionPaths = request.semanticProfileArtifacts
    .map((entry) => entry.path)
    .filter((relativePath) => path.posix.basename(relativePath).startsWith('transformation-')
      && !relativePath.endsWith('-transformation-closure.json'));
  assert.deepEqual(definitionPaths, [
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/transformation-direct-unit-price-times-quantity.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/transformation-quantity-value.json',
  ]);
  request.semanticProfileArtifacts = request.semanticProfileArtifacts.filter(
    (entry) => !entry.path.endsWith('/transformation-quantity-value.json'),
  );
  expectCode(
    () => replayLockedSliceACompletedRun(request),
    'S5_PRODUCER_REPLAY_SEMANTIC_PROFILE',
  );
});

test('rejects resealed TransformationDefinition expected output bytes', () => {
  const request = requestFor('urn:axiolune:graph:slice-a:market-data:v1');
  const row = request.semanticProfileArtifacts.find(
    (entry) => entry.path.endsWith('/transformation-money-value.json'),
  );
  const definition = JSON.parse(row.bytes.toString('utf8'));
  definition.testCases[0].expectedOutput.amount = '42.51';
  row.bytes = Buffer.from(canonicalJcs(definition), 'utf8');
  expectCode(
    () => replayLockedSliceACompletedRun(request),
    'S5_PRODUCER_REPLAY_SEMANTIC_PROFILE',
  );
});

test('rejects a resealed source schema even when the source row and output are unchanged', () => {
  const request = requestFor('urn:axiolune:graph:slice-a:portfolio-valuation:v1');
  const schema = JSON.parse(request.sourceSchemaBytes.toString('utf8'));
  schema.fields.find((field) => field.name === 'price').type = 'string';
  request.sourceSchemaBytes = Buffer.from(canonicalJcs(schema), 'utf8');
  expectCode(
    () => replayLockedSliceACompletedRun(request),
    'S5_PRODUCER_REPLAY_SEMANTIC_PROFILE',
  );
});

test('rejects an incomplete semantic profile inventory', () => {
  const request = requestFor('urn:axiolune:graph:slice-a:identity:v1');
  request.semanticProfileArtifacts.pop();
  expectCode(
    () => replayLockedSliceACompletedRun(request),
    'S5_PRODUCER_REPLAY_SEMANTIC_PROFILE',
  );
});

test('rejects a caller callback or any other open replay request field', () => {
  const request = requestFor('urn:axiolune:graph:slice-a:identity:v1');
  request.producer = () => ({ nquads: request.outputBytes.toString('utf8') });
  expectCode(
    () => replayLockedSliceACompletedRun(request),
    'S5_PRODUCER_REPLAY_SCHEMA',
  );
});

test('rejects caller-substituted valuation policy bytes', () => {
  const request = requestFor('urn:axiolune:graph:slice-a:portfolio-valuation:v1');
  request.valuationPolicyArtifacts.roundingBytes = Buffer.from(
    canonicalJcs({ mode: 'half-even', outputScale: 2, policyId: 'attacker', schemaVersion: '1.0', stage: 'finalMonetaryAmount' }),
    'utf8',
  );
  expectCode(
    () => replayLockedSliceACompletedRun(request),
    'S5_PRODUCER_REPLAY_TRANSFORMATION',
  );
});

test('keeps the old synthetic plan outside the producer replay allowlist', () => {
  const request = requestFor('urn:axiolune:graph:slice-a:identity:v1');
  request.planRef = 'https://axiolune.ai/test/plan/completed-run';
  expectCode(
    () => replayLockedSliceACompletedRun(request),
    'S5_PRODUCER_REPLAY_PROFILE',
  );
});
