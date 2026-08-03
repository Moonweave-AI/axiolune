'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  artifactDigest,
} = require('../lib/public-symbol-compiler.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const {
  evaluateModulePublicSymbolTrace,
  verifyModulePublicSymbolTrace,
} = require('../lib/module-public-symbol-trace.cjs');

const OWNER = 'https://axiolune.ai/ontology/finance/risk';

function ref(path) {
  return { kind: 'path', root: 'sourceTree', path };
}

function bytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function reviewedFixture() {
  const authoredIri = `${OWNER}/Authored`;
  const generatedIri = `${OWNER}/Authored/LogicalIdentity`;
  const authoredKey = `sha256:${'1'.repeat(64)}`;
  const generatedKey = `sha256:${'2'.repeat(64)}`;
  const cardRef = ref(`docs/ontology/term-cards/v0.3/direct/${'1'.repeat(64)}.json`);
  const inheritanceRef = ref(`docs/ontology/term-cards/v0.3/inheritance/${'2'.repeat(64)}.json`);
  const sourceLocator = {
    kind: 'wholeFile',
    path: 'source.json',
    mediaType: 'application/json',
    extractorProfileRef: ref('extractor.json'),
    extractorProfileDigest: `sha256:${'3'.repeat(64)}`,
    selectionDigest: `sha256:${'4'.repeat(64)}`,
  };
  const citation = {
    referenceId: 'authority',
    artifactRef: ref('reference/authority'),
    artifactDigest: `sha256:${'5'.repeat(64)}`,
    locator: sourceLocator,
    usage: 'normative',
  };
  const card = {
    schemaVersion: '1.0',
    publicIri: authoredIri,
    version: '0.3.0',
    status: 'accepted',
    preferredLabel: 'Authored',
    definition: 'authored fixture term',
    definitionDigest: artifactDigest(Buffer.from('authored fixture term')),
    ownerRef: 'urn:principal:dri',
    sourceCitations: [citation],
  };
  const sourceRef = ref('reference/authority/source.json');
  const sourceBytes = Buffer.from('{"authority":true}', 'utf8');
  const inheritance = {
    schemaVersion: '1.0',
    generatedIri,
    generatedKind: 'logicalIdentityClass',
    sourceElementKey: generatedKey,
  };
  const artifacts = new Map([
    [canonicalJcs(cardRef), bytes(card)],
    [canonicalJcs(inheritanceRef), bytes(inheritance)],
    [canonicalJcs(sourceRef), sourceBytes],
  ]);
  const publicSymbolManifest = {
    schemaVersion: '1.0',
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    symbols: [
      { origin: 'authored', ownerModule: OWNER, publicIri: authoredIri, sourceElementKey: authoredKey },
      {
        generatedKind: 'logicalIdentityClass',
        origin: 'generated',
        ownerModule: OWNER,
        publicIri: generatedIri,
        sourceElementKey: generatedKey,
      },
    ],
  };
  const publicRef = ref('public-symbol-manifest.json');
  const publicDigest = artifactDigest(bytes(publicSymbolManifest));
  const cardDigest = artifactDigest(artifacts.get(canonicalJcs(cardRef)));
  const inheritanceDigest = artifactDigest(artifacts.get(canonicalJcs(inheritanceRef)));
  const nodes = [
    {
      nodeId: 'source', nodeKind: 'sourceLocator', referenceId: 'authority',
      artifactRef: sourceRef,
      artifactDigest: artifactDigest(sourceBytes),
      locator: sourceLocator,
    },
    { nodeId: 'term-authored', nodeKind: 'termCard', artifactRef: cardRef, artifactDigest: cardDigest, publicIri: authoredIri },
    { nodeId: 'term-generated', nodeKind: 'termCard', artifactRef: inheritanceRef, artifactDigest: inheritanceDigest, publicIri: generatedIri },
    { nodeId: 'public-authored', nodeKind: 'publicSymbol', artifactRef: publicRef, artifactDigest: publicDigest, publicIri: authoredIri },
    { nodeId: 'public-generated', nodeKind: 'publicSymbol', artifactRef: publicRef, artifactDigest: publicDigest, publicIri: generatedIri },
  ];
  const edges = [
    { fromNodeId: 'source', toNodeId: 'term-authored', edgeKind: 'supportsTerm', assertionScope: 'normative' },
    { fromNodeId: 'source', toNodeId: 'term-generated', edgeKind: 'supportsTerm', assertionScope: 'normative' },
    { fromNodeId: 'term-authored', toNodeId: 'public-authored', edgeKind: 'definesSymbol', assertionScope: 'normative' },
    { fromNodeId: 'term-generated', toNodeId: 'public-generated', edgeKind: 'definesSymbol', assertionScope: 'normative' },
  ];
  const input = {
    ownerModule: OWNER,
    publicSymbolManifest,
    publicSymbolManifestRef: publicRef,
    publicSymbolManifestDigest: publicDigest,
    traceManifest: { schemaVersion: '1.0', profileRef: publicRef, nodes, edges },
    referenceClosureManifest: {
      entries: [{
        referenceId: 'authority',
        artifactRef: citation.artifactRef,
        artifactDigest: citation.artifactDigest,
        locators: [sourceLocator],
      }],
    },
    authorityDecisionStatus: 'reviewed',
    termCardManifest: {
      directEntries: [{
        publicIri: authoredIri,
        cardRef,
        cardDigest,
        status: 'accepted',
        review: { decision: 'accept' },
      }],
      generatedEntries: [{
        generatedIri,
        inheritanceRecordRef: inheritanceRef,
        inheritanceRecordDigest: inheritanceDigest,
      }],
    },
    readArtifact: (artifact) => {
      const value = artifacts.get(canonicalJcs(artifact));
      if (!value) throw new Error('fixture artifact missing');
      return value;
    },
  };
  return { input, authoredIri, generatedIri };
}

test('current Risk trace proves the authored source/card layer without fabricating release closure', () => {
  const result = verifyModulePublicSymbolTrace({ ownerModule: OWNER });
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.authored, {
    status: 'pass',
    expected: 63,
    closed: 63,
    tracedCitationCount: result.authored.tracedCitationCount,
  });
  assert.ok(result.authored.tracedCitationCount >= 63);
  assert.deepEqual(result.generated, { status: 'pending', expected: 30, closed: 0 });
  assert.deepEqual(result.publicSymbols, { status: 'pending', expected: 93, closed: 0 });
  assert.equal(result.releaseEligible, false);
  assert.deepEqual(
    result.pending.map((entry) => [entry.code, entry.count]),
    [
      ['TERM_SEMANTIC_REVIEW_PENDING', 63],
      ['GENERATED_TERM_INHERITANCE_PENDING', 30],
      ['PUBLIC_SYMBOL_LINKAGE_PENDING', 93],
    ],
  );
});

test('an exact reviewed authored/generated trace is release-candidate eligible', () => {
  const { input } = reviewedFixture();
  const result = evaluateModulePublicSymbolTrace(input);
  assert.equal(result.status, 'pass');
  assert.equal(result.complete, true);
  assert.equal(result.releaseEligible, true);
  assert.deepEqual(result.errors, []);
});

test('reviewed trace fails when an exact definesSymbol edge is missing', () => {
  const { input } = reviewedFixture();
  input.traceManifest.edges = input.traceManifest.edges.filter((edge) => edge.toNodeId !== 'public-generated');
  const result = evaluateModulePublicSymbolTrace(input);
  assert.equal(result.status, 'fail');
  assert.ok(result.errors.some((entry) => entry.code === 'MISSING_DEFINES_SYMBOL_EDGE'));
});

test('reviewed trace rejects a forged definesSymbol edge from the wrong term', () => {
  const { input } = reviewedFixture();
  input.traceManifest.edges.push({
    fromNodeId: 'term-authored',
    toNodeId: 'public-generated',
    edgeKind: 'definesSymbol',
    assertionScope: 'normative',
  });
  const result = evaluateModulePublicSymbolTrace(input);
  assert.equal(result.status, 'fail');
  assert.ok(result.errors.some((entry) => entry.code === 'FORGED_DEFINES_SYMBOL_EDGE'));
});

test('reviewed trace rejects wrong public-manifest, term-card, and source-locator digests', () => {
  const { input, authoredIri } = reviewedFixture();
  input.traceManifest.nodes.find((node) => node.nodeId === 'public-authored').artifactDigest = `sha256:${'a'.repeat(64)}`;
  input.traceManifest.nodes.find((node) => node.nodeId === 'term-authored').artifactDigest = `sha256:${'b'.repeat(64)}`;
  input.traceManifest.nodes.find((node) => node.nodeId === 'source').artifactDigest = `sha256:${'c'.repeat(64)}`;
  const result = evaluateModulePublicSymbolTrace(input);
  assert.equal(result.status, 'fail');
  assert.ok(result.errors.some((entry) => (
    entry.code === 'PUBLIC_SYMBOL_MANIFEST_DIGEST_MISMATCH' && entry.subject === authoredIri
  )));
  assert.ok(result.errors.some((entry) => (
    entry.code === 'TERM_CARD_DIGEST_MISMATCH' && entry.subject === authoredIri
  )));
  assert.ok(result.errors.some((entry) => (
    entry.code === 'SOURCE_LOCATOR_ARTIFACT_DIGEST_MISMATCH' && entry.subject === authoredIri
  )));
});

test('reviewed trace cannot omit generated inheritance', () => {
  const { input, generatedIri } = reviewedFixture();
  input.termCardManifest.generatedEntries = [];
  const result = evaluateModulePublicSymbolTrace(input);
  assert.equal(result.status, 'fail');
  assert.ok(result.errors.some((entry) => (
    entry.code === 'MISSING_GENERATED_INHERITANCE' && entry.subject === generatedIri
  )));
});
