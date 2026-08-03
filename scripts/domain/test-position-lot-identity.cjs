#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  IdentityContractError,
  compileIdentityContracts,
  validateIdentityManifest,
} = require('./lib/identity-contract-compiler.cjs');
const {
  FILES,
  IDENTITY_DIR,
  canonicalBytes,
  checkArtifacts,
  createArtifacts,
} = require('./build-position-lot-identity.cjs');

function clone(value) {
  return structuredClone(value);
}

const artifacts = createArtifacts();
checkArtifacts(artifacts);

const compilation = artifacts[FILES.compilation];
const manifest = artifacts[FILES.manifest];
const evidence = artifacts[FILES.evidence];
assert.equal(evidence.outcome, 'passed');
assert.equal(evidence.targetType, 'https://axiolune.ai/ontology/finance/portfolio-positions/PositionLot');
assert.equal(evidence.vectorResults.length, 8);
assert(evidence.vectorResults.every((row) => row.status === 'passed'));
assert.match(evidence.materializedIdentity.logicalIri, /^https:\/\/axiolune\.ai\/data\/position-lot\/sha256-[0-9a-f]{64}$/u);
assert.match(evidence.materializedIdentity.versionIri, /\/version\/sha256-[0-9a-f]{64}$/u);

const missingBinding = clone(compilation);
delete missingBinding.mappings[0].identity.versionKeyBindings.revision;
assert.throws(
  () => compileIdentityContracts(missingBinding),
  (cause) => cause instanceof IdentityContractError
    && cause.errors.some((entry) => entry.code === 'VERSION_KEY_COVERAGE_MISMATCH'),
);

const extraBinding = clone(compilation);
extraBinding.mappings[0].identity.logicalKeyBindings.rowNumber = {
  bindingType: 'directField',
  source: { dataset: 'lot', field: 'rowNumber' },
};
assert.throws(
  () => compileIdentityContracts(extraBinding),
  (cause) => cause instanceof IdentityContractError
    && cause.errors.some((entry) => entry.code === 'LOGICAL_KEY_COVERAGE_MISMATCH'),
);

const targetDrift = clone(compilation);
targetDrift.mappings[0].targetType =
  'https://axiolune.ai/ontology/finance/portfolio-positions/HoldingSnapshot';
assert.throws(
  () => compileIdentityContracts(targetDrift),
  (cause) => cause instanceof IdentityContractError
    && cause.errors.some((entry) => (
      entry.code === 'MAPPING_WITHOUT_CONTRACT'
      || entry.code === 'MAPPING_CONTRACT_MISMATCH'
      || entry.code === 'MAPPING_OUTSIDE_TARGET_CLOSURE'
    )),
);

const tamperedManifest = clone(manifest);
tamperedManifest.contracts[0].identityBaseIri =
  'https://axiolune.ai/data/tampered-position-lot';
const manifestResult = validateIdentityManifest(tamperedManifest, compilation);
assert.equal(manifestResult.ok, false);
assert(manifestResult.errors.some((entry) => entry.code === 'IDENTITY_MANIFEST_MISMATCH'));

const evidenceBytes = fs.readFileSync(`${IDENTITY_DIR}/${FILES.evidence}`);
assert(evidenceBytes.equals(canonicalBytes(evidence)));

console.log(
  'PositionLot identity contract: PASS '
    + '(8 normalization vectors, deterministic artifacts, 4 fail-closed negatives)',
);
