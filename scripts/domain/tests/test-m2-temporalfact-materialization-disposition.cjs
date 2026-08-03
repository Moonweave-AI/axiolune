#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MATERIALIZED_DISPOSITION,
  NON_MATERIALIZED_DISPOSITION,
  NO_CANONICAL_MAPPING_REASON,
  TEMPORALFACT_MATERIALIZATION_DISPOSITION_REF,
  TEMPORAL_FACT_PATTERN_REF,
  concreteTemporalFactTypes,
  discoverCompilationRefs,
  loadMaterializedTargetInventory,
  loadNormalizedModuleIr,
  loadTemporalFactMaterializationDisposition,
  readExactJcs,
  validateTemporalFactMaterializationDisposition,
} = require('../lib/m2-materialized-identity-closure.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const {
  buildTemporalFactDisposition,
  run: runMaterializationBoundaryGenerator,
} = require('../generate-materialized-target-inventory.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FOUNDATION = 'https://axiolune.ai/ontology/finance/foundation/';
const STRATEGY = 'https://axiolune.ai/ontology/finance/strategy-research/';

function productionSources() {
  return discoverCompilationRefs(ROOT).map((ref) => (
    readExactJcs(ROOT, ref, `TemporalFact disposition test source ${ref.path}`)
  ));
}

function currentInputs() {
  return {
    disposition: loadTemporalFactMaterializationDisposition(ROOT).disposition,
    inventory: loadMaterializedTargetInventory(ROOT).inventory,
    normalized: loadNormalizedModuleIr(ROOT),
    sources: productionSources(),
  };
}

function validate(inputs) {
  return validateTemporalFactMaterializationDisposition(
    inputs.normalized,
    inputs.inventory,
    inputs.sources,
    inputs.disposition,
  );
}

test('all concrete TemporalFact types have one exact materialization disposition', () => {
  assert.deepEqual(runMaterializationBoundaryGenerator(['--check']), {
    mode: 'check',
    targetCount: 18,
  });
  const inputs = currentInputs();
  const concrete = concreteTemporalFactTypes(inputs.normalized);
  const report = validate(inputs);
  assert.equal(concrete.length, 155);
  assert.equal(inputs.disposition.entries.length, 155);
  assert.deepEqual(report, {
    concreteTemporalFactCount: 155,
    materializedCount: 18,
    nonMaterializedCount: 137,
  });
  assert.deepEqual(
    inputs.disposition.entries.map((row) => row.targetType),
    concrete.map((row) => row.targetType),
  );
  assert.equal(
    inputs.disposition.entries.some((row) => row.targetType === `${STRATEGY}SignalGenerator`),
    false,
    'abstract TemporalFact types must not receive a release materialization disposition',
  );
});

test('non-materialized dispositions have a machine-verifiable absence reason', () => {
  const inputs = currentInputs();
  const mappedTargets = new Set(inputs.sources.flatMap((source) => (
    source.value.mappings.map((mapping) => mapping.targetType)
  )));
  for (const row of inputs.disposition.entries) {
    if (row.disposition === MATERIALIZED_DISPOSITION) {
      assert.equal(mappedTargets.has(row.targetType), true, row.targetType);
      assert.equal(Object.hasOwn(row, 'reasonCode'), false, row.targetType);
    } else {
      assert.equal(row.disposition, NON_MATERIALIZED_DISPOSITION);
      assert.equal(row.reasonCode, NO_CANONICAL_MAPPING_REASON);
      assert.equal(mappedTargets.has(row.targetType), false, row.targetType);
    }
  }
});

test('a newly introduced concrete TemporalFact fails until explicitly dispositioned', () => {
  const inputs = currentInputs();
  const targetType = `${FOUNDATION}NewTemporalFactForNegativeTest`;
  const row = {
    abstract: false,
    definitionKind: 'ObjectTypeDefinition',
    localName: 'NewTemporalFactForNegativeTest',
    moduleIri: `${FOUNDATION.slice(0, -1)}`,
    patternRefs: [TEMPORAL_FACT_PATTERN_REF],
    sourceRef: {
      kind: 'path',
      path: 'ontology/domain/finance/foundation/module.yaml',
      root: 'sourceTree',
    },
    superTypes: [],
    targetType,
  };
  inputs.normalized.types.push(row);
  inputs.normalized.typeByIri.set(targetType, row);
  assert.throws(
    () => validate(inputs),
    (error) => error.code === 'TEMPORALFACT_DISPOSITION_OMITTED'
      && error.message.includes(targetType),
  );
});

test('an omitted existing TemporalFact disposition fails closed', () => {
  const inputs = currentInputs();
  const omitted = inputs.disposition.entries.find(
    (row) => row.disposition === NON_MATERIALIZED_DISPOSITION,
  );
  inputs.disposition = structuredClone(inputs.disposition);
  inputs.disposition.entries = inputs.disposition.entries
    .filter((row) => row.targetType !== omitted.targetType);
  assert.throws(
    () => validate(inputs),
    (error) => error.code === 'TEMPORALFACT_DISPOSITION_OMITTED'
      && error.message.includes(omitted.targetType),
  );
});

test('a non-concrete TemporalFact disposition is rejected as extra', () => {
  const inputs = currentInputs();
  inputs.disposition = structuredClone(inputs.disposition);
  inputs.disposition.entries.push({
    definitionKind: 'ObjectTypeDefinition',
    disposition: NON_MATERIALIZED_DISPOSITION,
    moduleIri: `${STRATEGY.slice(0, -1)}`,
    patternRef: TEMPORAL_FACT_PATTERN_REF,
    reasonCode: NO_CANONICAL_MAPPING_REASON,
    targetType: `${STRATEGY}SignalGenerator`,
  });
  inputs.disposition.entries.sort((left, right) => Buffer.compare(
    Buffer.from(left.targetType, 'utf8'),
    Buffer.from(right.targetType, 'utf8'),
  ));
  assert.throws(
    () => validate(inputs),
    (error) => error.code === 'TEMPORALFACT_DISPOSITION_EXTRA'
      && error.message.includes(`${STRATEGY}SignalGenerator`),
  );
});

test('materialized and non-materialized classifications cannot contradict the inventory', () => {
  const inputs = currentInputs();
  inputs.disposition = structuredClone(inputs.disposition);
  const materialized = inputs.disposition.entries.find(
    (row) => row.disposition === MATERIALIZED_DISPOSITION,
  );
  materialized.disposition = NON_MATERIALIZED_DISPOSITION;
  materialized.reasonCode = NO_CANONICAL_MAPPING_REASON;
  assert.throws(
    () => validate(inputs),
    (error) => error.code === 'TEMPORALFACT_NON_MATERIALIZED_IN_INVENTORY'
      && error.message.includes(materialized.targetType),
  );

  const second = currentInputs();
  second.disposition = structuredClone(second.disposition);
  const nonMaterialized = second.disposition.entries.find(
    (row) => row.disposition === NON_MATERIALIZED_DISPOSITION,
  );
  nonMaterialized.disposition = MATERIALIZED_DISPOSITION;
  delete nonMaterialized.reasonCode;
  assert.throws(
    () => validate(second),
    (error) => error.code === 'TEMPORALFACT_MATERIALIZED_NOT_IN_INVENTORY'
      && error.message.includes(nonMaterialized.targetType),
  );
});

test('NO_CANONICAL_IDENTITY_COMPILATION_MAPPING is rejected when a compiled mapping exists', () => {
  const inputs = currentInputs();
  inputs.sources = structuredClone(inputs.sources);
  const nonMaterialized = inputs.disposition.entries.find(
    (row) => row.disposition === NON_MATERIALIZED_DISPOSITION,
  );
  const source = inputs.sources[0];
  source.value.mappings.push({ targetType: nonMaterialized.targetType });
  assert.throws(
    () => validate(inputs),
    (error) => error.code === 'TEMPORALFACT_NON_MATERIALIZED_HAS_MAPPING'
      && error.message.includes(nonMaterialized.targetType),
  );
});

test('the disposition parser rejects unrecognized non-materialization reasons', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-temporalfact-disposition-'));
  t.after(() => fs.rmSync(tempRoot, { force: true, recursive: true }));
  const value = buildTemporalFactDisposition();
  const row = value.entries.find((entry) => entry.disposition === NON_MATERIALIZED_DISPOSITION);
  row.reasonCode = 'UNREVIEWED_FREE_TEXT_REASON';
  const target = path.resolve(
    tempRoot,
    ...TEMPORALFACT_MATERIALIZATION_DISPOSITION_REF.path.split('/'),
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, canonicalJcs(value));
  assert.throws(
    () => loadTemporalFactMaterializationDisposition(tempRoot),
    (error) => error.code === 'TEMPORALFACT_DISPOSITION_REASON',
  );
});
