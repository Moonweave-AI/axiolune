#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { compileIdentityContracts } = require('./lib/identity-contract-compiler.cjs');
const {
  buildQuantityUnitRegistry,
} = require('./lib/strategy-research-quantity-units.cjs');
const {
  PATHS,
  buildFormulaClosure,
  buildFormulaDefinitions,
  buildFormulaVectors,
  buildMappingSet,
  buildNormalizationContract,
  buildNormalizationVectors,
  buildPitRequests,
  buildSourceSchema,
  buildSourceSnapshot,
  jcsBytes,
} = require('./lib/strategy-research-v03-profile.cjs');
const {
  buildArtifactManifest,
  buildCqEvidence,
  buildExpectedBindings,
  buildFormulaEvidence,
  buildMappingEvidence,
  buildPitEvidence,
  materialize,
  verifyAllStrategyResearchEvidence,
} = require('./lib/strategy-research-release-evidence.cjs');

function writeJcs(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jcsBytes(value));
  console.log(`wrote ${file}`);
}

function writeAll() {
  writeJcs(PATHS.quantityUnitRegistry, buildQuantityUnitRegistry());
  writeJcs(PATHS.normalizationContract, buildNormalizationContract());
  writeJcs(PATHS.normalizationVectors, buildNormalizationVectors());

  const formulaDefinitions = buildFormulaDefinitions();
  const formulaVectors = buildFormulaVectors();
  writeJcs(PATHS.formulaDefinitions, formulaDefinitions);
  writeJcs(PATHS.formulaVectors, formulaVectors);
  writeJcs(PATHS.formulaClosure, buildFormulaClosure(formulaDefinitions, formulaVectors));

  const mappingSet = buildMappingSet();
  writeJcs(PATHS.mappingSet, mappingSet);
  writeJcs(PATHS.identityRegistry, mappingSet.identityTermRegistry);
  const sourceSchema = buildSourceSchema(mappingSet);
  const sourceSnapshot = buildSourceSnapshot(mappingSet, formulaDefinitions);
  writeJcs(PATHS.sourceSchema, sourceSchema);
  writeJcs(PATHS.sourceSnapshot, sourceSnapshot);

  const compilation = compileIdentityContracts(mappingSet);
  writeJcs(PATHS.identityManifest, compilation.manifest);
  const materializedOutput = materialize(mappingSet, sourceSchema, sourceSnapshot);
  writeJcs(PATHS.materializedOutput, materializedOutput);
  writeJcs(
    PATHS.mappingEvidence,
    buildMappingEvidence(mappingSet, compilation, sourceSchema, sourceSnapshot, materializedOutput, 4),
  );

  const card = YAML.parse(fs.readFileSync(PATHS.card, 'utf8'));
  const positive = YAML.parse(fs.readFileSync(PATHS.positiveFixture, 'utf8'));
  writeJcs(PATHS.expectedBindings, buildExpectedBindings(card, positive));
  writeJcs(PATHS.cqEvidence, buildCqEvidence());

  const pitRequests = buildPitRequests();
  writeJcs(PATHS.pitRequests, pitRequests);
  writeJcs(
    PATHS.pitEvidence,
    buildPitEvidence(mappingSet, sourceSchema, sourceSnapshot, materializedOutput, pitRequests),
  );
  writeJcs(PATHS.formulaEvidence, buildFormulaEvidence());
  writeJcs(PATHS.artifactManifest, buildArtifactManifest());

  verifyAllStrategyResearchEvidence();
  console.log('PASS strategy/research v0.3 evidence regenerated and independently replayed');
}

function main(argv) {
  if (argv.length !== 1 || !['--check', '--write'].includes(argv[0])) {
    throw new Error('usage: generate-strategy-research-v03-evidence.cjs --write|--check');
  }
  if (argv[0] === '--write') writeAll();
  else {
    verifyAllStrategyResearchEvidence();
    console.log('PASS strategy/research v0.3 evidence is closed and replayable');
  }
}

try {
  main(process.argv.slice(2));
} catch (cause) {
  console.error(cause.stack || cause.message);
  process.exitCode = 1;
}
