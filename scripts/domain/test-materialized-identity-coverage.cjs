#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  MaterializedIdentityCoverageError,
  analyzeCompilationArtifacts,
  assertMaterializedIdentityCoverage,
  discoverCompilationArtifacts,
  isCompilationArtifact,
} = require('./lib/materialized-identity-coverage.cjs');
const {
  discoverCompilationRefs: discoverProductionCompilationRefs,
  loadMaterializedTargetInventory,
  loadNormalizedModuleIr,
  loadTemporalFactMaterializationDisposition,
  readExactJcs,
  validateTemporalFactMaterializationDisposition,
} = require('./lib/m2-materialized-identity-closure.cjs');

const F = 'https://axiolune.ai/ontology/finance/foundation/';
const MS = 'https://axiolune.ai/ontology/finance/market-structure/';
const I = 'https://axiolune.ai/ontology/finance/instruments/';
const MD = 'https://axiolune.ai/ontology/finance/market-data/';
const ROOT = path.resolve(__dirname, '..', '..');

function clone(value) {
  return structuredClone(value);
}

const report = assertMaterializedIdentityCoverage();
assert.deepEqual(report.missingContractTargets, []);
assert.deepEqual(report.orphanContractTargets, []);
assert.deepEqual(report.targetsByModule.foundation, [`${F}ISINValue`]);
assert.deepEqual(report.targetsByModule['market-data'], [
  `${MD}MarketDataStream`,
  `${MD}PriceObservation`,
]);
assert.equal(report.targetsByModule['portfolio-positions'].length, 8);
assert.equal(report.targetsByModule['strategy-research'].length, 7);
assert.equal(report.targetsByModule['market-structure'], undefined);
assert.equal(report.targetsByModule.instruments, undefined);
assert.equal(report.canonicalTargets.length, 18);
assert.deepEqual(report.temporalFactDisposition, {
  concreteTemporalFactCount: 156,
  materializedCount: 18,
  nonMaterializedCount: 138,
});

for (const fixtureOnly of [
  `${MS}TradingSessionTemplate`,
  `${MS}TradingSessionOccurrence`,
  `${MS}TradingCalendarException`,
  `${MS}OTCTradingContext`,
  `${I}SecurityOffering`,
  `${I}InstrumentIssuance`,
  `${I}InstrumentListing`,
  `${I}DirectUnitPriceQuotationContract`,
]) {
  assert(report.fixtureOnlyTargets.includes(fixtureOnly), `${fixtureOnly} must remain fixture-only`);
}

assert(report.legacyMappingTargets.includes(`${F}LegalEntity`));
assert(report.legacyMappingTargets.includes(`${I}FinancialInstrument`));
assert(report.legacyMappingTargets.includes(`${I}InstrumentListing`));
assert(report.legacyMappingTargets.includes(`${MD}PriceObservation`));
assert.equal(report.canonicalTargets.includes(`${F}LegalEntity`), false);
assert.equal(report.canonicalTargets.includes(`${I}FinancialInstrument`), false);
assert.equal(report.canonicalTargets.includes(`${I}InstrumentListing`), false);

const discovery = discoverCompilationArtifacts();
const s5 = discovery.artifacts.find((artifact) => (
  artifact.relativePath === 'mappings/finance/v0.3.0/slice-a-s5/identity-compilation.json'
));
assert(s5, 'S5 canonical compilation artifact must be discovered');
assert.equal(
  discovery.artifacts.some((artifact) => (
    artifact.relativePath === 'mappings/finance/v0.3.0/materialized-target-identity-compilation.json'
  )),
  false,
  'the generated aggregate compilation must never be rediscovered as a source',
);

const missingContract = clone(s5.value);
missingContract.contracts = missingContract.contracts
  .filter((contract) => contract.targetType !== `${F}ISINValue`);
const missingReport = analyzeCompilationArtifacts([{
  ...s5,
  relativePath: 'negative/missing-contract.json',
  value: missingContract,
}]);
assert(missingReport.errors.some((entry) => (
  entry.code === 'IDENTITY_COMPILER_TARGET_WITHOUT_CONTRACT'
)));

const targetDrift = clone(s5.value);
targetDrift.mappings[0].targetType = `${I}FinancialInstrument`;
const driftReport = analyzeCompilationArtifacts([{
  ...s5,
  relativePath: 'negative/target-drift.json',
  value: targetDrift,
}]);
assert(driftReport.errors.some((entry) => (
  entry.code === 'IDENTITY_COMPILER_MAPPING_OUTSIDE_TARGET_CLOSURE'
    || entry.code === 'IDENTITY_COMPILER_MAPPING_WITHOUT_CONTRACT'
)));

const conflicting = clone(s5.value);
conflicting.contracts[0].identityBaseIri = 'https://axiolune.ai/data/conflicting-isin-value';
const conflictReport = analyzeCompilationArtifacts([
  s5,
  { ...s5, relativePath: 'negative/conflicting-contract.json', value: conflicting },
]);
assert(conflictReport.errors.some((entry) => (
  entry.code === 'CROSS_ARTIFACT_TARGET_CONTRACT_CONFLICT'
)));

assert.equal(isCompilationArtifact({
  targets: [{ targetTypeIri: `${MD}PriceObservation` }],
}), false, 'legacy targetTypeIri mapping must never enter the canonical closure');

const dispositionInputs = {
  disposition: loadTemporalFactMaterializationDisposition(ROOT).disposition,
  inventory: loadMaterializedTargetInventory(ROOT).inventory,
  normalized: loadNormalizedModuleIr(ROOT),
  sources: discoverProductionCompilationRefs(ROOT).map((ref) => (
    readExactJcs(ROOT, ref, `target identity gate source ${ref.path}`)
  )),
};
const omittedDisposition = structuredClone(dispositionInputs.disposition);
const omittedTemporalFact = omittedDisposition.entries.pop();
assert.throws(
  () => validateTemporalFactMaterializationDisposition(
    dispositionInputs.normalized,
    dispositionInputs.inventory,
    dispositionInputs.sources,
    omittedDisposition,
  ),
  (error) => error.code === 'TEMPORALFACT_DISPOSITION_OMITTED'
    && error.message.includes(omittedTemporalFact.targetType),
);

const contradictedDisposition = structuredClone(dispositionInputs.disposition);
const contradictedTemporalFact = contradictedDisposition.entries.find(
  (row) => row.disposition === 'nonMaterialized',
);
const contradictedSources = structuredClone(dispositionInputs.sources);
contradictedSources[0].value.mappings.push({ targetType: contradictedTemporalFact.targetType });
assert.throws(
  () => validateTemporalFactMaterializationDisposition(
    dispositionInputs.normalized,
    dispositionInputs.inventory,
    contradictedSources,
    contradictedDisposition,
  ),
  (error) => error.code === 'TEMPORALFACT_NON_MATERIALIZED_HAS_MAPPING'
    && error.message.includes(contradictedTemporalFact.targetType),
);

assert.throws(
  () => {
    if (missingReport.errors.length > 0) {
      throw new MaterializedIdentityCoverageError(missingReport.errors);
    }
  },
  MaterializedIdentityCoverageError,
);

console.log(
  `Materialized target identity coverage: PASS `
    + `(${report.artifacts.length} canonical artifacts, `
    + `${report.canonicalTargets.length} discovered targets, `
    + `${report.temporalFactDisposition.concreteTemporalFactCount} concrete TemporalFacts dispositioned, `
    + `${report.fixtureOnlyTargets.length} fixture-only types, 6 fail-closed negatives)`,
);
