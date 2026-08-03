#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TAGS,
  compileIdentityContracts,
  taggedJcsDigest,
} = require('../lib/identity-contract-compiler.cjs');
const {
  PROFILE_REF,
  buildTraceabilityManifest,
  fileArtifactDigest,
} = require('../lib/m2-traceability-builder.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
} = require('../lib/strict-source-locator.cjs');
const { buildFixture } = require('../../../tests/m2/fixtures/identity/valid-compilation.cjs');

const DIGEST = `sha256:${'a'.repeat(64)}`;

function ref(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function fixture() {
  const compilation = buildFixture();
  compilation.profileRef = PROFILE_REF;
  compilation.identityTermRegistry.profileRef = PROFILE_REF;
  compilation.identityTermRegistryDigest = taggedJcsDigest(
    TAGS.termRegistry,
    compilation.identityTermRegistry,
  );
  const compiled = compileIdentityContracts(compilation);
  const manifestRef = ref('mappings/fixture/identity-manifest.json');
  const registryRef = compilation.identityTermRegistryRef;

  const selected = Buffer.from('reviewed semantic source', 'utf8');
  const locatorWithoutDigest = {
    kind: 'wholeFile',
    path: 'source.txt',
    mediaType: 'text/plain',
    extractorProfileRef: ref('scripts/domain/reference-extractors/whole-file-v1.json'),
    extractorProfileDigest: DIGEST,
  };
  const locator = {
    ...locatorWithoutDigest,
    selectionDigest: computeSelectionDigest(locatorWithoutDigest, selected),
  };
  const citation = {
    referenceId: 'fixture-reference',
    artifactRef: ref('reference/fixture'),
    artifactDigest: DIGEST,
    locator,
    usage: 'normative',
  };
  const referenceClosure = {
    schemaVersion: '1.0',
    entries: [{
      referenceId: citation.referenceId,
      artifactRef: citation.artifactRef,
      artifactDigest: citation.artifactDigest,
      locators: [locator],
    }],
  };

  const publicIris = compiled.manifest.contracts.map((row) => row.targetType).sort();
  const publicSymbolRef = ref('docs/domain/infrastructure/public-symbol-manifest.json');
  const publicSymbolDigest = DIGEST;
  const publicSymbols = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    symbols: publicIris.map((publicIri) => ({ publicIri })),
  };
  const termCards = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    publicSymbolManifestRef: publicSymbolRef,
    publicSymbolManifestDigest: publicSymbolDigest,
    directEntries: publicIris.map((publicIri, index) => ({
      publicIri,
      cardRef: ref(`term-cards/card-${index}.json`),
      cardDigest: DIGEST,
      status: 'accepted',
      review: { decision: 'accept' },
      sourceCitations: [citation],
    })),
    generatedEntries: [],
  };

  const identityBindingSubjects = [
    ...compiled.manifest.contracts.map((row) => ({
      subjectKind: 'targetIdentityContract', subjectRef: row.contractRef,
    })),
    ...compiled.manifest.contracts.flatMap((row) => row.mappings.map((mapping) => ({
      subjectKind: 'identityMapping', subjectRef: mapping.mappingRef,
    }))),
    ...compilation.identityTermRegistry.termContracts.map((row) => ({
      subjectKind: 'identityTermContract', subjectRef: row.termContractRef,
    })),
    ...compilation.identityTermRegistry.controlledSets.map((row) => ({
      subjectKind: 'controlledIriSet', subjectRef: row.controlledSetRef,
    })),
  ].sort((left, right) => Buffer.compare(
    Buffer.from(`${left.subjectKind}\0${left.subjectRef}`),
    Buffer.from(`${right.subjectKind}\0${right.subjectRef}`),
  ));
  const identitySourceBindings = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    identityManifestRef: manifestRef,
    identityManifestDigest: compiled.manifestDigest,
    identityTermRegistryRef: registryRef,
    identityTermRegistryDigest: compilation.identityTermRegistryDigest,
    entries: identityBindingSubjects.map((entry) => ({ ...entry, sources: [citation] })),
  };

  const files = new Map();
  function fixtureBinding(relativePath, fixtureId, value) {
    const bytes = Buffer.from(canonicalJcs(value), 'utf8');
    const artifactRef = ref(relativePath);
    files.set(canonicalJcs(artifactRef), { bytes });
    return { fixtureId, artifactRef, artifactDigest: fileArtifactDigest(bytes) };
  }
  const constraintPositive = fixtureBinding(
    'tests/trace/constraint-positive.json',
    'constraint-positive',
    { conforms: true },
  );
  const constraintNegative = fixtureBinding(
    'tests/trace/constraint-negative.json',
    'constraint-negative',
    { conforms: false },
  );
  const schemaRef = ref('tests/trace/constraint.schema.json');
  const schemaBytes = Buffer.from(canonicalJcs({ type: 'object' }), 'utf8');
  const schemaDigest = fileArtifactDigest(schemaBytes);
  files.set(canonicalJcs(schemaRef), { bytes: schemaBytes });
  const constraintEntry = {
    constraintInstanceId: 'a'.repeat(64),
    originKind: 'constraintDefinition',
    originRef: 'https://axiolune.ai/test/constraint',
    targetRef: publicIris[0],
    component: 'http://www.w3.org/ns/shacl#MinCountConstraintComponent',
    severity: 'violation',
    generatedOrAuthored: 'authored',
    positiveExpectation: {
      ...constraintPositive,
      schemaRef,
      schemaDigest,
      expectedResult: 'conforms',
    },
    negativeExpectation: {
      ...constraintNegative,
      schemaRef,
      schemaDigest,
      expectedResult: 'violates',
    },
  };
  const constraintValue = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    entries: [constraintEntry],
  };
  const constraintBytes = Buffer.from(canonicalJcs(constraintValue), 'utf8');

  const cqSourceRef = ref('docs/ontology/competency-questions/fixture.yaml');
  const cqSourceBytes = Buffer.from('cqs:\n  - id: CQ-X1\n    status: active\n', 'utf8');
  files.set(canonicalJcs(cqSourceRef), { bytes: cqSourceBytes });
  const cqInventoryValue = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    entries: [{
      cqId: 'CQ-X1',
      status: 'active',
      executionIdentity: 'CQ-X1',
      aliasOf: null,
      sourceRef: cqSourceRef,
      sourceDigest: fileArtifactDigest(cqSourceBytes),
    }],
  };
  const cqInventoryBytes = Buffer.from(canonicalJcs(cqInventoryValue), 'utf8');
  const cqInventoryArtifact = {
    ref: ref('scripts/domain/release-profile/v0.3.0/cq-source-inventory.json'),
    digest: fileArtifactDigest(cqInventoryBytes),
    value: cqInventoryValue,
  };
  const cqPositive = fixtureBinding('tests/trace/cq-positive.json', 'cq-positive', { rows: [1] });
  const cqNegative = fixtureBinding('tests/trace/cq-negative.json', 'cq-negative', { rejected: true });
  const cqBindings = {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    cqSourceInventoryRef: cqInventoryArtifact.ref,
    cqSourceInventoryDigest: cqInventoryArtifact.digest,
    entries: [{
      cqId: 'CQ-X1',
      executionIdentity: 'CQ-X1',
      exercisedPublicIris: [publicIris[0]],
      positiveFixtures: [cqPositive],
      negativeFixtures: [cqNegative],
    }],
  };

  return {
    inputs: {
      publicSymbols,
      termCards,
      referenceClosure,
      identity: {
        compilation,
        manifest: compiled.manifest,
        manifestRef,
        manifestDigest: compiled.manifestDigest,
        registry: compilation.identityTermRegistry,
        registryRef,
        registryDigest: compilation.identityTermRegistryDigest,
      },
      identitySourceBindings,
      constraintArtifact: {
        ref: ref('scripts/domain/release-profile/v0.3.0/constraint-instance-manifest.json'),
        digest: fileArtifactDigest(constraintBytes),
        value: constraintValue,
        bytes: constraintBytes,
      },
      cqInventoryArtifact,
      cqBindings,
      resolveArtifact: (artifactRef) => files.get(canonicalJcs(artifactRef)) || null,
    },
  };
}

test('strict builder reconstructs the full source/term/identity/constraint/CQ/gate graph', () => {
  const { inputs } = fixture();
  const result = buildTraceabilityManifest(inputs);
  assert.ok(result.stats.nodeCount > 0);
  assert.equal(result.stats.publicSymbolCount, inputs.publicSymbols.symbols.length);
  assert.equal(result.stats.identityContractCount, inputs.identity.manifest.contracts.length);
  assert.equal(result.stats.constraintInstanceCount, 1);
  assert.equal(result.stats.competencyQuestionCount, 1);
  assert.ok(result.gateExpectations.expectations.length > 0);
  assert.match(result.manifestDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('strict builder rejects missing identity evidence and incomplete active CQ closure', () => {
  const first = fixture().inputs;
  first.identitySourceBindings.entries.pop();
  assert.throws(
    () => buildTraceabilityManifest(first),
    /has no reviewed source binding|contain missing or unused subjects/u,
  );

  const second = fixture().inputs;
  second.cqBindings.entries = [];
  assert.throws(() => buildTraceabilityManifest(second), /cq-traceability-bindings/u);
});

test('strict builder rejects fixture byte tampering before graph emission', () => {
  const { inputs } = fixture();
  const binding = inputs.cqBindings.entries[0].positiveFixtures[0];
  const originalResolver = inputs.resolveArtifact;
  inputs.resolveArtifact = (artifactRef) => (
    canonicalJcs(artifactRef) === canonicalJcs(binding.artifactRef)
      ? { bytes: Buffer.from('{}', 'utf8') }
      : originalResolver(artifactRef)
  );
  assert.throws(() => buildTraceabilityManifest(inputs), /raw artifact digest must be/u);
});

test('strict builder rejects duplicate term coverage and non-distinct constraint/CQ fixtures', () => {
  const first = fixture().inputs;
  first.termCards.directEntries.push(structuredClone(first.termCards.directEntries.at(-1)));
  assert.throws(
    () => buildTraceabilityManifest(first),
    /not strictly publicIri-sorted|duplicate semantic IRIs/u,
  );

  const second = fixture().inputs;
  const entry = second.constraintArtifact.value.entries[0];
  entry.negativeExpectation = {
    ...structuredClone(entry.positiveExpectation),
    expectedResult: 'violates',
  };
  second.constraintArtifact.bytes = Buffer.from(
    canonicalJcs(second.constraintArtifact.value),
    'utf8',
  );
  second.constraintArtifact.digest = fileArtifactDigest(second.constraintArtifact.bytes);
  assert.throws(
    () => buildTraceabilityManifest(second),
    /positive and negative artifacts are not distinct/u,
  );

  const third = fixture().inputs;
  const cqEntry = third.cqBindings.entries[0];
  cqEntry.negativeFixtures = [{
    ...structuredClone(cqEntry.positiveFixtures[0]),
    fixtureId: 'cq-negative-alias',
  }];
  assert.throws(
    () => buildTraceabilityManifest(third),
    /positive and negative fixture identities, artifacts, and bytes must be distinct/u,
  );
});
