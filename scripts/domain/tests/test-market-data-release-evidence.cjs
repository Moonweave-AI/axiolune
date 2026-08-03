'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  calculationClosureAssertionSetDigest,
  calculationInputSetDigest,
  executeCanonicalOrderingTransformation,
  isSyntheticDigest,
  quantizeExactRational,
  quantizedWeightedMean,
  selectCalculationInputsAtPit,
  sha256,
  validateScenarioReleaseEvidence,
} = require('../lib/market-data-release-evidence.cjs');
const {
  loadFixture,
} = require('../lib/strict-fixture-loader.cjs');
const {
  compareUtcInstantLexical,
  durationNanosecondsToDecimalSeconds,
  isUtcInstantLexical,
  utcInstantDifferenceNanoseconds,
} = require('../lib/instant-lexical.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
} = require('../lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'm2', 'fixtures', 'market-data-v03');

function load(name) {
  return loadFixture(path.join(FIXTURE_DIR, name), { rootDirectory: FIXTURE_DIR });
}

test('canonical Market Data scenario closes every byte artifact and source selection', () => {
  const scenario = load('positive-complete.yaml');
  assert.deepEqual(validateScenarioReleaseEvidence(scenario), []);
  assert.deepEqual(scenario.fixtureScope, {
    familyId: 'market-data-v03-positive-complete',
    kind: 'semantic-contract-fixture',
    releaseEligible: false,
  });
  assert.equal(scenario.artifactBindings.length, 12);
  for (const binding of scenario.artifactBindings) {
    assert.equal(isSyntheticDigest(binding.artifactDigest), false, binding.artifactIri);
    const bytes = fs.readFileSync(path.join(ROOT, ...binding.artifactRef.path.split('/')));
    assert.equal(sha256(bytes), binding.artifactDigest, binding.artifactIri);
  }
  const contextBinding = scenario.artifactBindings.find(
    (binding) => binding.artifactIri === 'urn:validation-run:market-data-v03',
  );
  const context = JSON.parse(fs.readFileSync(
    path.join(ROOT, ...contextBinding.artifactRef.path.split('/')),
    'utf8',
  ));
  assert.equal(
    context.artifactTypeIri,
    'https://axiolune.ai/ontology/finance/market-data/artifact-types/'
      + 'SemanticFixtureContextDefinition',
  );
  assert.equal(context.releaseEligible, false);
  assert.equal(context.scope, 'semantic-only');
  for (const forbidden of [
    'materializationRunIri', 'mappingDigest', 'outputGraphDigest',
    'validationReportDigest',
  ]) {
    assert.equal(Object.hasOwn(context, forbidden), false, forbidden);
  }
});

test('semantic fixture scope cannot be promoted into release evidence by a flag change', () => {
  const scenario = load('positive-complete.yaml');
  scenario.fixtureScope.releaseEligible = true;
  const codes = validateScenarioReleaseEvidence(scenario).map((row) => row.code);
  assert.ok(codes.includes('FIXTURE_SCOPE'), codes.join(', '));
});

test('semantic fixture context implementation closure rejects an omitted reachable dependency', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-market-data-closure-'));
  t.after(() => fs.rmSync(temporaryRoot, { force: true, recursive: true }));
  const temporaryLibrary = path.join(temporaryRoot, 'scripts', 'domain', 'lib');
  const temporaryFixture = path.join(
    temporaryRoot,
    'tests',
    'm2',
    'fixtures',
    'market-data-v03',
  );
  fs.mkdirSync(path.dirname(temporaryLibrary), { recursive: true });
  fs.cpSync(path.join(ROOT, 'scripts', 'domain', 'lib'), temporaryLibrary, { recursive: true });
  fs.mkdirSync(temporaryFixture, { recursive: true });
  fs.cpSync(path.join(FIXTURE_DIR, 'evidence'), path.join(temporaryFixture, 'evidence'), {
    recursive: true,
  });

  const scenario = load('positive-complete.yaml');
  const closureRelative = 'tests/m2/fixtures/market-data-v03/evidence/'
    + 'market-data-validator-implementation-closure-v1.json';
  const closureFile = path.join(temporaryRoot, ...closureRelative.split('/'));
  const closure = JSON.parse(fs.readFileSync(closureFile, 'utf8'));
  const omitted = 'scripts/domain/lib/whole-file-source-extractor.cjs';
  closure.artifacts = closure.artifacts.filter((artifact) => artifact.artifactRef.path !== omitted);
  closure.closureDigest = sha256(Buffer.concat([
    Buffer.from('axiolune-market-data-implementation-closure-v1\0', 'utf8'),
    Buffer.from(canonicalJcs(closure.artifacts), 'utf8'),
  ]));
  const closureBytes = Buffer.from(`${JSON.stringify(closure, null, 2)}\n`, 'utf8');
  fs.writeFileSync(closureFile, closureBytes);

  const contextRelative = 'tests/m2/fixtures/market-data-v03/evidence/'
    + 'market-data-semantic-fixture-context-v1.json';
  const contextFile = path.join(temporaryRoot, ...contextRelative.split('/'));
  const context = JSON.parse(fs.readFileSync(contextFile, 'utf8'));
  context.implementationArtifactDigest = sha256(closureBytes);
  context.implementationLocator.selectionDigest = computeSelectionDigest(
    context.implementationLocator,
    closureBytes,
  );
  const contextBytes = Buffer.from(`${JSON.stringify(context, null, 2)}\n`, 'utf8');
  fs.writeFileSync(contextFile, contextBytes);
  scenario.artifactBindings.find(
    (binding) => binding.artifactIri === context.testContextIri,
  ).artifactDigest = sha256(contextBytes);

  const violations = validateScenarioReleaseEvidence(scenario, {
    repositoryRoot: temporaryRoot,
  });
  assert.ok(violations.some((violation) => (
    violation.code === 'FIXTURE_CONTEXT_IMPLEMENTATION'
      && violation.message.includes(`reachable dependency ${omitted} is absent`)
  )), JSON.stringify(violations, null, 2));
});

test('release evidence rejects non-NFC and control-character IRI aliases independently', () => {
  for (const invalidIri of [
    'urn:source-contract:price-e\u0301',
    'urn:source-contract:price\u0001',
  ]) {
    const scenario = load('positive-complete.yaml');
    scenario.artifactBindings[0].artifactIri = invalidIri;
    const codes = validateScenarioReleaseEvidence(scenario).map((row) => row.code);
    assert.ok(codes.includes('RELEASE_ARTIFACT_BINDING'), `${invalidIri}: ${codes.join(', ')}`);
  }
});

test('VWAP and TWAP CalculationRunEvidence bind the strict schema, exact input set, and replayable bytes', () => {
  const schemaFile = path.join(
    ROOT,
    'scripts',
    'domain',
    'lib',
    'market-data-calculation-run-v1.schema.json',
  );
  const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  const schemaDigest = sha256(fs.readFileSync(schemaFile));
  for (const [fixture, priceKind] of [
    ['positive-complete.yaml', 'vwap'],
    ['positive-twap.yaml', 'twap'],
  ]) {
    const scenario = load(fixture);
    assert.deepEqual(validateScenarioReleaseEvidence(scenario), []);
    const output = scenario.observations.find((row) => row.priceKind === priceKind);
    const binding = scenario.artifactBindings.find(
      (row) => row.artifactIri === output.calculationRunRef,
    );
    const document = JSON.parse(fs.readFileSync(
      path.join(ROOT, ...binding.artifactRef.path.split('/')),
      'utf8',
    ));
    assert.equal(document.schemaIri, schema.$id);
    assert.equal(document.schemaDigest, schemaDigest);
    assert.equal(binding.artifactDigest, output.calculationRunDigest);
    const inputs = scenario.observations.filter((row) => (
      document.inputObservationVersionIris.includes(row.versionIri)
    ));
    assert.equal(
      calculationInputSetDigest(inputs, priceKind),
      output.calculationInputSetDigest,
    );
  }
});

test('exact rational replay handles non-terminating division and signed half-even ties', () => {
  const policy = {
    input: 'exact-base-10-decimal',
    intermediate: 'exact-rational',
    rounding: { mode: 'half-even', scale: 2, stage: 'final-output-only' },
  };
  assert.equal(quantizeExactRational(1005n, 1000n, policy.rounding), '1.00');
  assert.equal(quantizeExactRational(1015n, 1000n, policy.rounding), '1.02');
  assert.equal(quantizeExactRational(-1005n, 1000n, policy.rounding), '-1.00');
  assert.equal(quantizeExactRational(-1015n, 1000n, policy.rounding), '-1.02');
  assert.equal(quantizeExactRational(5n, 3n, policy.rounding), '1.67');
  assert.equal(quantizedWeightedMean(
    [
      { tradePrice: { amount: '1' } },
      { tradePrice: { amount: '2' } },
    ],
    'tradePrice',
    ['1', '2'],
    policy,
  ), '1.67');
});

test('exact rational replay implements signed floor, ceiling, and half-up without binary64', () => {
  assert.equal(quantizeExactRational(1001n, 1000n, { mode: 'floor', scale: 2 }), '1.00');
  assert.equal(quantizeExactRational(-1001n, 1000n, { mode: 'floor', scale: 2 }), '-1.01');
  assert.equal(quantizeExactRational(1001n, 1000n, { mode: 'ceiling', scale: 2 }), '1.01');
  assert.equal(quantizeExactRational(-1001n, 1000n, { mode: 'ceiling', scale: 2 }), '-1.00');
  assert.equal(quantizeExactRational(1005n, 1000n, { mode: 'half-up', scale: 2 }), '1.01');
  assert.equal(quantizeExactRational(-1005n, 1000n, { mode: 'half-up', scale: 2 }), '-1.01');
  assert.equal(quantizeExactRational(0n, -7n, { mode: 'half-even', scale: 2 }), '0.00');
});

test('UTC instant replay preserves nanosecond half-open boundaries and rejects normalized dates', () => {
  assert.equal(isUtcInstantLexical('2026-02-29T00:00:00Z'), false);
  assert.equal(isUtcInstantLexical('2024-02-29T00:00:00Z'), true);
  assert.equal(compareUtcInstantLexical(
    '2026-07-31T10:00:00.000000001Z',
    '2026-07-31T10:00:00.000000002Z',
  ), -1);
  assert.equal(durationNanosecondsToDecimalSeconds(utcInstantDifferenceNanoseconds(
    '2026-07-31T10:00:01.000000002Z',
    '2026-07-31T10:00:00.000000001Z',
  )), '1.000000001');
});

test('calculation PIT selection rejects overlapping revisions and selects one closed-chain version', () => {
  const scenario = load('positive-complete.yaml');
  const runBinding = scenario.artifactBindings.find(
    (row) => row.artifactIri === 'urn:calculation-run:vwap:price-002:v1',
  );
  const run = JSON.parse(fs.readFileSync(
    path.join(ROOT, ...runBinding.artifactRef.path.split('/')),
    'utf8',
  ));
  const predecessor = scenario.observations.find(
    (row) => row.versionIri === 'urn:observation:trade-001:v0',
  );
  const successor = structuredClone(predecessor);
  successor.id = 'trade-001-v1';
  successor.versionIri = 'urn:observation:trade-001:v1';
  successor.supersedes = predecessor.versionIri;
  successor.axes = {
    ...successor.axes,
    revision: 1,
    knowledgeFrom: '2026-07-31T10:00:05Z',
    availableFrom: '2026-07-31T10:00:05Z',
  };
  const observations = [...scenario.observations, successor];
  const ambiguous = selectCalculationInputsAtPit(
    observations,
    run.selection,
    run.window,
    run.pitSelection,
    scenario.closures,
  );
  assert.equal(ambiguous.conflicts.length, 1);
  assert.equal(ambiguous.conflicts[0].logicalIri, predecessor.logicalIri);

  const closure = {
    id: 'trade-001-v0-knowledge-closure',
    targetVersionIri: predecessor.versionIri,
    axis: 'knowledge',
    closedAt: successor.axes.knowledgeFrom,
    causeKind: 'successor',
    causeVersionIri: successor.versionIri,
    evidenceRef: 'urn:evidence:trade-correction-r1',
    generatingContextRef: 'urn:validation-run:market-data-v03',
  };
  const closed = selectCalculationInputsAtPit(
    observations,
    run.selection,
    run.window,
    run.pitSelection,
    [...scenario.closures, closure],
  );
  assert.deepEqual(closed.conflicts, []);
  assert.ok(closed.inputs.some((row) => row.versionIri === successor.versionIri));
  assert.ok(!closed.inputs.some((row) => row.versionIri === predecessor.versionIri));
  assert.notEqual(
    calculationClosureAssertionSetDigest(ambiguous.candidates, scenario.closures),
    calculationClosureAssertionSetDigest(closed.candidates, [...scenario.closures, closure]),
  );
});

test('digest-bound FX reciprocal replay rejects the previously accepted mode/value exploit', () => {
  const scenario = load('positive-complete.yaml');
  scenario.fxDerivations[0].rate.value = '0.87703911594457111';
  scenario.fxDerivations[0].rate.rounding = 'floor';
  const codes = validateScenarioReleaseEvidence(scenario).map((row) => row.code);
  assert.ok(codes.includes('FX_RECIPROCAL_POLICY'), codes.join(', '));
});

test('source snapshot is content-related and covers every canonical observation tuple', () => {
  const scenario = load('positive-complete.yaml');
  const orderingBindingRow = scenario.artifactBindings.find(
    (row) => row.artifactIri === 'urn:transform:canonical-market-order-v1',
  );
  const orderingBinding = {
    ...orderingBindingRow,
    document: JSON.parse(fs.readFileSync(
      path.join(ROOT, ...orderingBindingRow.artifactRef.path.split('/')),
      'utf8',
    )),
  };
  const ref = scenario.observations[0].provenance.sourceArtifactRef;
  const snapshot = JSON.parse(fs.readFileSync(
    path.join(ROOT, ...ref.path.split('/')),
    'utf8',
  ));
  assert.equal(snapshot.providerLogicalIri, 'urn:party:provider-a');
  assert.ok(snapshot.records.length >= scenario.observations.length);
  for (const observation of scenario.observations) {
    const stream = scenario.streams.find((row) => row.id === observation.stream);
    const eventId = observation.type === 'TradeObservation'
      ? observation.sourceTradeId
      : observation.providerObservationId;
    const matches = snapshot.records.filter((record) => record.id === eventId
      && record.observedAt === observation.observedAt
      && executeCanonicalOrderingTransformation(
        orderingBinding,
        record,
        stream.logicalIri,
      ).sourceOrderKey === observation.sourceOrderKey
      && (observation.sourceRevisionToken === undefined
        || record.revisionToken === observation.sourceRevisionToken));
    assert.equal(matches.length, 1, observation.id);
    assert.equal(Object.hasOwn(matches[0], 'sourceOrderKey'), false, observation.id);
  }
});

test('canonical ordering executes locked sourceSequence semantics and rejects unsafe input', () => {
  const scenario = load('positive-complete.yaml');
  const bindingRow = scenario.artifactBindings.find(
    (row) => row.artifactIri === 'urn:transform:canonical-market-order-v1',
  );
  const binding = {
    ...bindingRow,
    document: JSON.parse(fs.readFileSync(
      path.join(ROOT, ...bindingRow.artifactRef.path.split('/')),
      'utf8',
    )),
  };
  assert.deepEqual(
    executeCanonicalOrderingTransformation(
      binding,
      {
        id: 'EVENT-1',
        observedAt: '2026-07-31T10:00:00Z',
        sourceSequence: 7,
        sourceOrderKey: 999,
      },
      'urn:stream:logical',
    ),
    {
      observedAt: '2026-07-31T10:00:00Z',
      streamLogicalIri: 'urn:stream:logical',
      sourceOrderKey: 7,
      sourceEventId: 'EVENT-1',
    },
  );
  assert.throws(
    () => executeCanonicalOrderingTransformation(
      binding,
      {
        id: 'EVENT-1',
        observedAt: '2026-07-31T10:00:00Z',
        sourceSequence: Number.MAX_SAFE_INTEGER + 1,
      },
      'urn:stream:logical',
    ),
    /non-negative safe integer/u,
  );
  assert.throws(
    () => executeCanonicalOrderingTransformation(
      binding,
      {
        id: 'EVENT-1',
        observedAt: '2026-07-31T10:00:00Z',
        sourceOrderKey: 1,
      },
      'urn:stream:logical',
    ),
    /sourceSequence/u,
  );
});

test('M3 v0.6 ArtifactRef and SourceLocator structures are closed in canonical evidence', () => {
  const scenario = load('positive-complete.yaml');
  for (const record of [
    ...scenario.streams,
    ...scenario.barSpecifications,
    ...scenario.observations,
    ...scenario.fxDerivations,
  ]) {
    assert.deepEqual(
      Object.keys(record.provenance.sourceArtifactRef).sort(),
      ['kind', 'path', 'root'],
    );
    assert.deepEqual(
      Object.keys(record.provenance.sourceLocator).sort(),
      [
        'extractorProfileDigest',
        'extractorProfileRef',
        'kind',
        'mediaType',
        'path',
        'selectionDigest',
      ],
    );
  }
  for (const stream of scenario.streams) {
    assert.equal(stream.mappings.observationIdField, undefined);
    assert.equal(stream.mappings.sourceRevisionField, undefined);
    assert.equal(stream.mappings.observationIdFieldLocator.kind, 'jsonPointer');
    if (stream.revisionMode === 'revisionedRecord') {
      assert.equal(stream.mappings.sourceRevisionFieldLocator.kind, 'jsonPointer');
    } else {
      assert.equal(stream.mappings.sourceRevisionFieldLocator, undefined);
    }
  }
});

const negativeEvidenceCases = [
  ['negative-artifact-declared-identity-mismatch.yaml', 'RELEASE_ARTIFACT_CONTENT'],
  ['negative-provenance-scalar-artifact-ref.yaml', 'RELEASE_SOURCE_ARTIFACT'],
  ['negative-provenance-scalar-locator.yaml', 'RELEASE_SOURCE_SELECTION'],
  ['negative-source-artifact-placeholder-digest.yaml', 'RELEASE_SOURCE_ARTIFACT'],
  ['negative-extractor-profile-placeholder-digest.yaml', 'RELEASE_SOURCE_SELECTION'],
  ['negative-extractor-implementation-drift.yaml', 'RELEASE_FIELD_SELECTION'],
  ['negative-json-pointer-duplicate-key.yaml', 'RELEASE_FIELD_SELECTION'],
  ['negative-json-pointer-invalid-utf8.yaml', 'RELEASE_FIELD_SELECTION'],
  ['negative-selection-digest-mismatch.yaml', 'RELEASE_SOURCE_SELECTION'],
  ['negative-source-contract-artifact-drift.yaml', 'RELEASE_ARTIFACT_DIGEST'],
  ['negative-source-record-content-mismatch.yaml', 'RELEASE_SOURCE_RECORD'],
  ['negative-ordering-transform-artifact-drift.yaml', 'RELEASE_ARTIFACT_DIGEST'],
  ['negative-ordering-transform-wrong-capability.yaml', 'RELEASE_ARTIFACT_CAPABILITY'],
  ['negative-calculation-artifact-drift.yaml', 'RELEASE_ARTIFACT_DIGEST'],
  ['negative-calculation-wrong-capability.yaml', 'RELEASE_ARTIFACT_CAPABILITY'],
  ['negative-calculation-input-omission.yaml', 'CALCULATION_INPUT_SET'],
  ['negative-calculation-input-substitution.yaml', 'CALCULATION_INPUT_SET'],
  ['negative-calculation-window-drift.yaml', 'CALCULATION_WINDOW'],
  ['negative-calculation-future-input.yaml', 'CALCULATION_INPUT_FUTURE'],
  ['negative-calculation-invalid-policy.yaml', 'RELEASE_ARTIFACT_SCHEMA'],
  ['negative-calculation-output-replay.yaml', 'CALCULATION_OUTPUT'],
  ['negative-calculation-input-payload-drift.yaml', 'CALCULATION_INPUT_SET'],
  ['negative-calculation-closure-set-drift.yaml', 'CALCULATION_CLOSURE_SET'],
  ['negative-fx-transformation-artifact-drift.yaml', 'RELEASE_ARTIFACT_DIGEST'],
  ['negative-fx-reciprocal-rounding-mode.yaml', 'FX_RECIPROCAL_POLICY'],
  ['negative-fx-reciprocal-extra-digit.yaml', 'FX_RECIPROCAL_POLICY'],
  ['negative-fx-reciprocal-scale-drift.yaml', 'FX_RECIPROCAL_POLICY'],
  ['negative-observation-field-scalar-locator.yaml', 'RELEASE_FIELD_SELECTION'],
];

for (const [name, expectedCode] of negativeEvidenceCases) {
  test(`${name} fails closed with ${expectedCode}`, () => {
    const codes = validateScenarioReleaseEvidence(load(name)).map((row) => row.code);
    assert.ok(codes.includes(expectedCode), `${name}: ${codes.join(', ')}`);
  });
}
