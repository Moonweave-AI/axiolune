#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  compileIdentitySourceBindings,
  expectedIdentitySubjects,
} = require('../lib/m2-identity-source-bindings.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const CONTRACT = 'https://example.test/identity/contract/a';
const MAPPING = 'https://example.test/identity/mapping/a';
const TERM = 'https://example.test/identity/term/a';
const TARGET = 'https://example.test/ontology/A';
const REFERENCE_ID = 'reviewed-source-a';
const SELECTION = `sha256:${'1'.repeat(64)}`;
const ARTIFACT_DIGEST = `sha256:${'2'.repeat(64)}`;
const EXTRACTOR_DIGEST = `sha256:${'3'.repeat(64)}`;
const MANIFEST_DIGEST = `sha256:${'4'.repeat(64)}`;
const REGISTRY_DIGEST = `sha256:${'5'.repeat(64)}`;

function identity() {
  return {
    manifestRef: {
      kind: 'path', root: 'sourceTree', path: 'mappings/test/identity-manifest.json',
    },
    manifestDigest: MANIFEST_DIGEST,
    registryRef: {
      kind: 'path', root: 'sourceTree', path: 'mappings/test/identity-registry.json',
    },
    registryDigest: REGISTRY_DIGEST,
    manifest: {
      contracts: [{
        contractRef: CONTRACT,
        targetType: TARGET,
        mappings: [{ mappingRef: MAPPING }],
      }],
    },
    compilation: {
      contracts: [{
        iri: CONTRACT,
        targetType: TARGET,
        logicalComponents: [{
          termContractRef: TERM,
          normalizationRuleRef: 'https://example.test/identity/normalization/a',
          semanticValue: { valueKind: 'attributeUse' },
        }],
        versionComponents: [],
      }],
      normalizationRules: [{
        iri: 'https://example.test/identity/normalization/a',
        inputTermContractRef: TERM,
        outputTermContractRef: TERM,
      }],
      derivations: [],
    },
    registry: {
      termContracts: [{
        termContractRef: TERM,
        definition: { termContract: { termKind: 'literal' } },
      }],
      controlledSets: [],
    },
  };
}

function referenceClosure() {
  return {
    schemaVersion: '1.0',
    entries: [{
      referenceId: REFERENCE_ID,
      artifactRef: {
        kind: 'path', root: 'sourceTree', path: 'reference/test/reviewed-source',
      },
      artifactDigest: ARTIFACT_DIGEST,
      locators: [{
        kind: 'wholeFile',
        path: 'source.txt',
        mediaType: 'text/plain',
        extractorProfileRef: {
          kind: 'path', root: 'sourceTree', path: 'scripts/test/whole-file.json',
        },
        extractorProfileDigest: EXTRACTOR_DIGEST,
        selectionDigest: SELECTION,
      }],
    }],
  };
}

function authoring() {
  return {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    entries: [
      {
        subjectKind: 'identityMapping',
        subjectRef: MAPPING,
        sources: [{ referenceId: REFERENCE_ID, selectionDigest: SELECTION, usage: 'implementation' }],
      },
      {
        subjectKind: 'identityTermContract',
        subjectRef: TERM,
        sources: [{ referenceId: REFERENCE_ID, selectionDigest: SELECTION, usage: 'normative' }],
      },
      {
        subjectKind: 'targetIdentityContract',
        subjectRef: CONTRACT,
        sources: [{ referenceId: REFERENCE_ID, selectionDigest: SELECTION, usage: 'implementation' }],
      },
    ],
  };
}

function compile(author = authoring(), sourceIdentity = identity(), closure = referenceClosure()) {
  return compileIdentitySourceBindings('unused-in-injected-test', {
    authoring: author,
    identity: sourceIdentity,
    referenceClosure: closure,
  });
}

test('identity source compiler closes every materialized contract, mapping, and used term', () => {
  const first = compile();
  const second = compile();
  assert.deepEqual(first.bindings, second.bindings);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.bytes.at(-1), 0x7d, 'binding JCS must not have a trailing LF');
  assert.equal(first.stats.subjectBindingCount, 3);
  assert.equal(first.stats.sourceCitationCount, 3);
  assert.equal(first.stats.uniqueReviewedLocatorCount, 1);
  assert.deepEqual(first.bindings.entries.map((entry) => entry.subjectKind), [
    'identityMapping', 'identityTermContract', 'targetIdentityContract',
  ]);
  assert.equal(first.bindings.identityManifestDigest, MANIFEST_DIGEST);
  assert.equal(first.bindings.identityTermRegistryDigest, REGISTRY_DIGEST);
  assert.deepEqual(first.bindings.entries[0].sources[0], {
    referenceId: REFERENCE_ID,
    artifactRef: {
      kind: 'path', root: 'sourceTree', path: 'reference/test/reviewed-source',
    },
    artifactDigest: ARTIFACT_DIGEST,
    locator: referenceClosure().entries[0].locators[0],
    usage: 'implementation',
  });
  assert.deepEqual(expectedIdentitySubjects(identity()).map((row) => row.subjectKind), [
    'identityMapping', 'identityTermContract', 'targetIdentityContract',
  ]);
});

test('identity source compiler rejects incomplete or extra subject coverage', async (t) => {
  await t.test('missing subject', () => {
    const authored = authoring();
    authored.entries.pop();
    assert.throws(() => compile(authored), /subject closure differs: missing=1, extra=0/u);
  });
  await t.test('extra subject', () => {
    const authored = authoring();
    authored.entries.push({
      subjectKind: 'targetIdentityContract',
      subjectRef: 'https://example.test/identity/contract/z',
      sources: [{ referenceId: REFERENCE_ID, selectionDigest: SELECTION, usage: 'implementation' }],
    });
    assert.throws(() => compile(authored), /subject closure differs: missing=0, extra=1/u);
  });
});

test('identity source compiler rejects locator invention and duplicate semantic use', async (t) => {
  await t.test('unknown reviewed locator', () => {
    const authored = authoring();
    authored.entries[0].sources[0].selectionDigest = `sha256:${'9'.repeat(64)}`;
    assert.throws(() => compile(authored), /references an unknown reviewed locator/u);
  });
  await t.test('same locator repeated under another usage', () => {
    const authored = authoring();
    authored.entries[0].sources.push({
      referenceId: REFERENCE_ID, selectionDigest: SELECTION, usage: 'normative',
    });
    authored.entries[0].sources.sort((left, right) => Buffer.compare(
      Buffer.from(`${left.referenceId}\0${left.selectionDigest}\0${left.usage}`),
      Buffer.from(`${right.referenceId}\0${right.selectionDigest}\0${right.usage}`),
    ));
    assert.throws(() => compile(authored), /repeats a locator/u);
  });
});

test('identity source compiler rejects ordering drift and unused registry entries', async (t) => {
  await t.test('authoring order drift', () => {
    const authored = authoring();
    authored.entries.reverse();
    assert.throws(() => compile(authored), /not strictly subject-sorted/u);
  });
  await t.test('unused term registry entry', () => {
    const sourceIdentity = identity();
    sourceIdentity.registry.termContracts.push({
      termContractRef: 'https://example.test/identity/term/unused',
      definition: { termContract: { termKind: 'literal' } },
    });
    assert.throws(
      () => compile(authoring(), sourceIdentity),
      /identity registry contains unused entries: terms=1, sets=0/u,
    );
  });
});

test('identity source compiler output is exact JCS and citation evidence is not author-controlled', () => {
  const result = compile();
  assert.equal(result.bytes.toString('utf8'), canonicalJcs(result.bindings));
  const authored = authoring();
  assert.equal(Object.hasOwn(authored.entries[0].sources[0], 'artifactDigest'), false);
  assert.equal(Object.hasOwn(authored.entries[0].sources[0], 'locator'), false);
});
