'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const YAML = require('yaml');

const {
  buildCqEvidence,
  buildFormulaEvidence,
  buildPitEvidence,
  materialize,
  readStrictJcs,
  validateMappingSet,
  validateSnapshot,
  verifyAllStrategyResearchEvidence,
  verifyFormulaClosure,
  verifyQuantityUnitRegistry,
} = require('../lib/strategy-research-release-evidence.cjs');
const {
  MATERIALIZED_TARGETS,
  PATHS,
  RELEASE_TARGETS,
} = require('../lib/strategy-research-v03-profile.cjs');
const {
  sealQuantityUnitRegistry,
  validateQuantityUnitRegistry,
} = require('../lib/strategy-research-quantity-units.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function clone(value) {
  return structuredClone(value);
}

function loadYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

function loadEvidenceInputs() {
  return {
    mappingSet: readStrictJcs(PATHS.mappingSet).value,
    moduleDocument: loadYaml(PATHS.module),
    output: readStrictJcs(PATHS.materializedOutput).value,
    pitRequests: readStrictJcs(PATHS.pitRequests).value,
    schema: readStrictJcs(PATHS.sourceSchema).value,
    snapshot: readStrictJcs(PATHS.sourceSnapshot).value,
  };
}

test('all Strategy/Research evidence is independently replayable and inventory-closed', () => {
  const result = verifyAllStrategyResearchEvidence();
  assert.equal(result.mapping.outcome, 'passed');
  assert.equal(result.mapping.targetCounts.length, 7);
  assert.equal(result.mapping.targetCounts.reduce((sum, row) => sum + row.count, 0), 8);
  assert.deepEqual(
    result.mapping.targetCounts.map((row) => row.targetType),
    [...MATERIALIZED_TARGETS],
  );
  for (const targetType of RELEASE_TARGETS) {
    assert.ok(result.mapping.targetCounts.some((row) => row.targetType === targetType && row.count > 0));
  }
  assert.equal(result.cq.queries.filter((row) => row.status === 'passed').length, 7);
  assert.deepEqual(
    result.cq.queries.filter((row) => row.status === 'deferred-non-core').map((row) => row.cqId),
    ['CQ-SR7'],
  );
  assert.equal(result.pit.results.length, 3);
  assert.equal(result.executable.vectorResults.length, 11);
  assert.deepEqual(result.quantityUnits, verifyQuantityUnitRegistry());
  assert.equal(result.quantityUnits.unitCount, 2);
  const referenceEdges = new Map(result.mapping.referenceEdges);
  assert.deepEqual(
    referenceEdges.get('https://axiolune.ai/conformance/m2/0.3.0/strategy-research/mapping/strategy-definition'),
    ['https://axiolune.ai/conformance/m2/0.3.0/strategy-research/mapping/factor-definition'],
  );
  assert.ok(
    referenceEdges.get('https://axiolune.ai/conformance/m2/0.3.0/strategy-research/mapping/backtest-run')
      .includes('https://axiolune.ai/conformance/m2/0.3.0/strategy-research/mapping/strategy-definition'),
  );
});

test('generated JSON corpus uses exact closed JCS bytes', () => {
  for (const file of [
    PATHS.artifactManifest, PATHS.cqEvidence, PATHS.expectedBindings,
    PATHS.formulaClosure, PATHS.formulaDefinitions, PATHS.formulaEvidence,
    PATHS.formulaVectors, PATHS.identityManifest, PATHS.identityRegistry,
    PATHS.mappingEvidence, PATHS.mappingSet, PATHS.materializedOutput,
    PATHS.normalizationContract, PATHS.normalizationVectors, PATHS.pitEvidence,
    PATHS.pitRequests, PATHS.quantityUnitRegistry, PATHS.sourceSchema, PATHS.sourceSnapshot,
  ]) {
    assert.doesNotThrow(() => readStrictJcs(file), file);
  }
});

test('mapping schema rejects legacy fields and missing three-axis time', () => {
  const { mappingSet, moduleDocument, schema } = loadEvidenceInputs();
  const legacy = clone(mappingSet);
  legacy.mappings[0].targetTypeIri = legacy.mappings[0].targetType;
  assert.throws(
    () => validateMappingSet(legacy, schema, moduleDocument),
    (error) => error.code === 'LEGACY_MAPPING_DIALECT',
  );

  const missingAvailability = clone(mappingSet);
  delete missingAvailability.mappings[0].temporal.availabilityTime;
  assert.throws(
    () => validateMappingSet(missingAvailability, schema, moduleDocument),
    (error) => error.code === 'CLOSED_SCHEMA',
  );
});

test('identity compiler rejects an unbound version term', () => {
  const { mappingSet, moduleDocument, schema } = loadEvidenceInputs();
  const tampered = clone(mappingSet);
  delete tampered.mappings[0].identity.versionKeyBindings.revision;
  assert.throws(
    () => validateMappingSet(tampered, schema, moduleDocument),
    (error) => error.code === 'IDENTITY_COMPILATION',
  );

  const incompleteExactReference = clone(mappingSet);
  const strategyMapping = incompleteExactReference.mappings.find((mapping) => (
    mapping.iri.endsWith('/strategy-definition')
  ));
  const factorReference = strategyMapping.slotMappings.find((slot) => (
    slot.target.slotType === 'relation' && slot.target.targetRelation.endsWith('/usesFactor')
  ));
  delete factorReference.value.keyBindings.revision;
  assert.throws(
    () => validateMappingSet(incompleteExactReference, schema, moduleDocument),
    (error) => error.code === 'IDENTITY_COMPILATION'
      && /REFERENCE_KEY_COVERAGE_MISMATCH/u.test(error.message),
  );
});

test('materializer exactly recomputes stored output and is sensitive to source time', () => {
  const { mappingSet, output, schema, snapshot } = loadEvidenceInputs();
  assert.deepEqual(materialize(mappingSet, schema, snapshot), output);

  const changed = clone(snapshot);
  changed.datasets.backtest[0].available_from = '2025-01-10T00:00:02Z';
  const rematerialized = materialize(mappingSet, schema, changed);
  assert.notDeepEqual(rematerialized, output);
  const original = output.records.find((row) => row.mappingRef.endsWith('/backtest-run'));
  const revised = rematerialized.records.find((row) => row.mappingRef.endsWith('/backtest-run'));
  assert.notEqual(revised.versionIri, original.versionIri);
  assert.equal(revised.temporal.availableFrom, '2025-01-10T00:00:02Z');

  for (const record of output.records) {
    const generatingContextSlots = record.slots.filter((slot) => (
      slot.target.slotType === 'patternField'
      && slot.target.targetPattern === 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact'
      && slot.target.targetField === 'generatingContextRef'
    ));
    assert.deepEqual(
      generatingContextSlots.map((slot) => slot.value),
      [snapshot.runtimeContext.iri],
      `${record.versionIri} must derive exactly one generatingContextRef from runtimeContext.iri`,
    );
  }

  const unregisteredQuantity = clone(snapshot);
  unregisteredQuantity.datasets.signal[0].strength.unit = 'https://example.com/unit/one';
  assert.throws(
    () => materialize(mappingSet, schema, unregisteredQuantity),
    (error) => error.code === 'MATERIALIZATION_QUANTITY',
  );

  const binaryFloatQuantity = clone(snapshot);
  binaryFloatQuantity.datasets.signal[0].strength.value = 0.5;
  assert.throws(
    () => materialize(mappingSet, schema, binaryFloatQuantity),
    /safe integers/u,
  );

  const nonObjectArtifactRef = clone(snapshot);
  nonObjectArtifactRef.datasets.backtest[0].source_artifact_ref = 'sourceTree:path';
  assert.throws(
    () => materialize(mappingSet, schema, nonObjectArtifactRef),
    (error) => error.code === 'SOURCE_VALUE'
      && /backtest\[0\]\.source_artifact_ref is not an object/u.test(error.message),
  );
});

test('generatingContextRef rejects adapter injection and an open or malformed runtime snapshot', () => {
  const { mappingSet, moduleDocument, schema, snapshot } = loadEvidenceInputs();
  const injected = clone(mappingSet);
  const slot = injected.mappings[0].slotMappings.find((row) => (
    row.target.slotType === 'patternField' && row.target.targetField === 'generatingContextRef'
  ));
  slot.value = { bindingType: 'literal', value: 'https://adapter.example/run/arbitrary' };
  assert.throws(
    () => validateMappingSet(injected, schema, moduleDocument),
    (error) => error.code === 'MAPPING_GENERATING_CONTEXT',
  );

  const openContext = clone(snapshot);
  openContext.runtimeContext.adapterIri = 'https://adapter.example/run/arbitrary';
  assert.throws(() => validateSnapshot(openContext, schema), (error) => error.code === 'CLOSED_SCHEMA');

  const malformedContext = clone(snapshot);
  malformedContext.runtimeContext.iri = 'not an iri';
  assert.throws(() => validateSnapshot(malformedContext, schema));
});

test('Quantity-unit registry rejects recomputed but unreviewed application widening', () => {
  const registry = readStrictJcs(PATHS.quantityUnitRegistry).value;
  const tamperedPayload = clone(registry);
  delete tamperedPayload.registryDigest;
  tamperedPayload.units[1].allowedApplications = ['calculationWindow', 'signalStrength'];
  const coherentlyResealed = sealQuantityUnitRegistry(tamperedPayload);
  assert.throws(
    () => validateQuantityUnitRegistry(coherentlyResealed),
    /differs from the reviewed v0\.3 profile/u,
  );
});

test('CQ expected-binding tamper is rejected by actual probes', () => {
  const expected = readStrictJcs(PATHS.expectedBindings).value;
  const tampered = clone(expected);
  tampered.bindings['CQ-SR1'][0].strategyDefinition = 'https://axiolune.ai/data/strategy/tampered';
  assert.throws(
    () => buildCqEvidence(tampered),
    (error) => error.code === 'CQ_EXPECTED',
  );
});

test('three-axis PIT replay preserves history and rejects missing availability', () => {
  const { mappingSet, output, pitRequests, schema, snapshot } = loadEvidenceInputs();
  const evidence = buildPitEvidence(mappingSet, schema, snapshot, output, pitRequests);
  assert.deepEqual(evidence.results.map((row) => row.status), ['passed', 'passed', 'passed']);
  assert.deepEqual(evidence.results.map((row) => row.results.map((item) => item.revision)), [[0], [1], []]);
  assert.equal(evidence.futureAppend.historicalReplayInvariant, true);
  assert.deepEqual(evidence.negativeControls, [{ caseId: 'missing-availability-axis', code: 'PIT_INPUT_CONTRACT', status: 'passed' }]);
});

test('formula closure tamper and all four runtime vector categories are exercised', () => {
  const closure = readStrictJcs(PATHS.formulaClosure).value;
  const tampered = clone(closure);
  tampered.closureDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () => verifyFormulaClosure(tampered),
    (error) => error.code === 'FORMULA_CLOSURE_TAMPER',
  );
  const evidence = buildFormulaEvidence();
  assert.deepEqual(
    [...new Set(evidence.vectorResults.map((row) => row.category))].sort(),
    ['negative', 'positive', 'tamper', 'timeout'],
  );
  assert.ok(evidence.vectorResults.every((row) => row.status === 'passed'));
});

test('strict reader rejects semantically identical non-JCS bytes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-strategy-jcs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const candidate = path.join(directory, 'mapping.json');
  fs.writeFileSync(candidate, Buffer.concat([fs.readFileSync(PATHS.mappingSet), Buffer.from('\n')]));
  assert.throws(() => readStrictJcs(candidate), (error) => error.code === 'JCS_BYTES');
});

test('evidence generator check mode is read-only and succeeds', () => {
  const run = spawnSync(process.execPath, [PATHS.generator, '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30000,
    windowsHide: true,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /closed and replayable/);
});
