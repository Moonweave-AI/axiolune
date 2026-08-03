#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const {
  compilePublicSymbolManifest,
  sourceKey,
} = require('../lib/public-symbol-compiler.cjs');
const {
  PUBLIC_SYMBOL_MANIFEST_TAG,
  SOURCE_CITATIONS_TAG,
  TERM_CARD_MANIFEST_TAG,
  TermCardCompilationError,
  artifactDigest,
  compileTermCardManifest,
  taggedJcsDigest,
  validateTermCardManifest,
} = require('../lib/term-card-compiler.cjs');
const { deriveTermCardSemantics } = require('../lib/term-card-semantics.cjs');

const BASE = 'https://axiolune.ai/test/term-card/';
const PROFILE = 'https://axiolune.ai/conformance/m2/0.3.0';
const OWNER = 'https://axiolune.ai/principals/ontology-owner';
const REVIEWER = 'https://axiolune.ai/principals/term-reviewer';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;

function ref(path) {
  return { kind: 'path', root: 'sourceTree', path };
}

function jcsArtifact(artifactRef, record) {
  return { artifactRef, bytes: Buffer.from(canonicalJcs(record), 'utf8') };
}

function generationEvaluator({ bytes, generatedKind, source }) {
  assert.equal(bytes.toString('utf8'), `axiolune-test-generation-rule-v1:${generatedKind}`);
  if (generatedKind === 'rolePredicate') return `${source.containingType}/role/${source.roleId}`;
  if (generatedKind === 'codeMember') return source.codeValueIri;
  if (generatedKind === 'logicalIdentityClass') return `${source.typeIri}/LogicalIdentity`;
  throw new Error(`unsupported kind ${generatedKind}`);
}

function moduleFixture(options = {}) {
  if (options.directOnly) {
    return {
      module: {
        moduleIri: `${BASE}module-direct`,
        version: '0.3.0',
        exports: [],
        governance: { ownerRef: OWNER },
      },
      domain: {
        relationTypes: {
          relatedTo: {
            iri: `${BASE}relatedTo`,
            label: 'related to',
            definition: 'Direct-only relation used to exercise review status cross-products.',
            domain: `${BASE}Instrument`,
            range: `${BASE}Instrument`,
            characteristics: [],
          },
        },
      },
    };
  }
  return {
    module: {
      moduleIri: `${BASE}module`,
      version: '0.3.0',
      exports: [],
      governance: { ownerRef: OWNER },
    },
    domain: {
      objectTypes: {
        Instrument: {
          iri: `${BASE}Instrument`,
          label: 'Instrument',
          definition: 'A reviewed financial instrument test type.',
          superTypes: [],
          attributeUses: [],
          patternBindings: [],
        },
      },
      associationTypes: {
        Ownership: {
          iri: `${BASE}Ownership`,
          label: 'Ownership',
          definition: 'A reviewed ownership association test type.',
          participantRoles: [{
            id: 'ownedInstrument',
            range: `${BASE}Instrument`,
            minCount: 1,
            maxCount: 1,
            label: 'owned instrument',
            definition: 'The exact instrument participating in the ownership association.',
          }],
          attributeUses: [],
          patternBindings: [],
        },
      },
      codeLists: {
        State: {
          iri: `${BASE}State`,
          label: 'State',
          definition: 'A reviewed state vocabulary.',
          vocabulary: 'State',
          version: '0.3.0',
          maintainer: 'Axiolune test maintainers',
          sourceEvidenceRef: `${BASE}evidence/state`,
          values: [{
            iri: `${BASE}State/value/open`,
            notation: 'open',
            label: 'Open',
            definition: 'A state whose governed lifecycle remains open.',
          }],
        },
      },
    },
  };
}

function sourceDefinitionMap(moduleDoc) {
  const definitions = new Map();
  for (const containerName of ['objectTypes', 'associationTypes', 'relationTypes', 'codeLists']) {
    for (const element of Object.values(moduleDoc.domain[containerName] || {})) {
      definitions.set(element.iri, {
        ...deriveTermCardSemantics(containerName, element),
        definition: element.definition,
        label: element.label,
      });
    }
  }
  return definitions;
}

function generatedSources(moduleDoc) {
  const rows = [];
  for (const type of Object.values(moduleDoc.domain.objectTypes || {})) {
    rows.push({
      generatedIri: `${type.iri}/LogicalIdentity`,
      generatedKind: 'logicalIdentityClass',
      sourceElementKey: sourceKey({ kind: 'logicalIdentityClass', typeIri: type.iri }),
      sourcePublicIri: type.iri,
      definition: type.definition,
    });
  }
  for (const type of Object.values(moduleDoc.domain.associationTypes || {})) {
    rows.push({
      generatedIri: `${type.iri}/LogicalIdentity`,
      generatedKind: 'logicalIdentityClass',
      sourceElementKey: sourceKey({ kind: 'logicalIdentityClass', typeIri: type.iri }),
      sourcePublicIri: type.iri,
      definition: type.definition,
    });
    for (const role of type.participantRoles) {
      rows.push({
        generatedIri: `${type.iri}/role/${role.id}`,
        generatedKind: 'rolePredicate',
        sourceElementKey: sourceKey({ kind: 'participantRole', containingType: type.iri, roleId: role.id }),
        sourcePublicIri: type.iri,
        definition: role.definition,
      });
    }
  }
  for (const codeList of Object.values(moduleDoc.domain.codeLists || {})) {
    for (const value of codeList.values) {
      rows.push({
        generatedIri: value.iri,
        generatedKind: 'codeMember',
        sourceElementKey: sourceKey({ kind: 'codeValue', codeListIri: codeList.iri, codeValueIri: value.iri }),
        sourcePublicIri: codeList.iri,
        definition: value.definition,
      });
    }
  }
  return rows;
}

function buildFixture(options = {}) {
  const moduleDoc = moduleFixture(options);
  const publicManifest = compilePublicSymbolManifest([moduleDoc], { profileRef: PROFILE }).manifest;
  const publicSymbolManifestArtifact = jcsArtifact(
    ref('docs/domain/infrastructure/public-symbol-manifest.json'),
    publicManifest,
  );
  const locator = {
    kind: 'wholeFile',
    path: 'fixture/reference.txt',
    mediaType: 'text/plain',
    extractorProfileRef: ref('scripts/domain/reference-extractors/whole-file-v1.json'),
    extractorProfileDigest: HASH_A,
    selectionDigest: HASH_B,
  };
  const referenceArtifactRef = ref('reference/project-reference/fixture');
  const citation = {
    referenceId: 'fixture-reference',
    artifactRef: referenceArtifactRef,
    artifactDigest: HASH_C,
    locator,
    usage: 'implementation',
  };
  const referenceClosureManifest = {
    schemaVersion: '1.0',
    entries: [{
      referenceId: 'fixture-reference',
      artifactRef: referenceArtifactRef,
      artifactDigest: HASH_C,
      locators: [locator],
    }],
  };
  const definitions = sourceDefinitionMap(moduleDoc);
  const cardArtifacts = [];
  const reviewArtifacts = [];
  const cardsByIri = new Map();
  const reviewsByIri = new Map();

  for (const symbol of publicManifest.symbols.filter((row) => row.origin === 'authored')) {
    const source = definitions.get(symbol.publicIri);
    const local = symbol.publicIri.slice(BASE.length).replaceAll('/', '-');
    const cardRef = ref(`term-cards/${local}.json`);
    const cardRecord = {
      schemaVersion: '1.0',
      publicIri: symbol.publicIri,
      version: '0.3.0',
      status: 'accepted',
      preferredLabel: source.label,
      definition: source.definition,
      definitionDigest: artifactDigest(Buffer.from(source.definition, 'utf8')),
      genus: source.genus,
      differentia: source.differentia,
      excludes: source.excludes,
      candidateM3Type: source.candidateM3Type,
      ownerRef: OWNER,
      sourceCitations: [citation],
    };
    const cardArtifact = jcsArtifact(cardRef, cardRecord);
    const cardDigest = artifactDigest(cardArtifact.bytes);
    const reviewRef = ref(`term-card-reviews/${local}.json`);
    const reviewRecord = {
      schemaVersion: '1.0',
      publicIri: symbol.publicIri,
      cardRef,
      cardDigest,
      reviewedVersion: cardRecord.version,
      reviewedDefinitionDigest: cardRecord.definitionDigest,
      sourceCitationsDigest: taggedJcsDigest(SOURCE_CITATIONS_TAG, cardRecord.sourceCitations),
      decision: 'accept',
      reviewerRef: REVIEWER,
      decisionTime: '2026-07-31T12:34:56Z',
      rationale: 'The definition and locked citations support the public term.',
    };
    const reviewArtifact = jcsArtifact(reviewRef, reviewRecord);
    cardArtifacts.push(cardArtifact);
    reviewArtifacts.push(reviewArtifact);
    cardsByIri.set(symbol.publicIri, { artifact: cardArtifact, record: cardRecord });
    reviewsByIri.set(symbol.publicIri, { artifact: reviewArtifact, record: reviewRecord });
  }

  const generationRuleArtifacts = [];
  const rulesByKind = new Map();
  for (const kind of ['rolePredicate', 'codeMember', 'logicalIdentityClass']) {
    if (!publicManifest.symbols.some((row) => row.generatedKind === kind)) continue;
    const artifact = {
      artifactRef: ref(`generation-rules/${kind}.txt`),
      bytes: Buffer.from(`axiolune-test-generation-rule-v1:${kind}`, 'utf8'),
    };
    generationRuleArtifacts.push(artifact);
    rulesByKind.set(kind, artifact);
  }

  const inheritanceArtifacts = [];
  for (const source of generatedSources(moduleDoc)) {
    const card = cardsByIri.get(source.sourcePublicIri);
    const review = reviewsByIri.get(source.sourcePublicIri);
    const rule = rulesByKind.get(source.generatedKind);
    const local = source.generatedIri.slice(BASE.length).replaceAll('/', '-');
    const record = {
      schemaVersion: '1.0',
      generatedIri: source.generatedIri,
      generatedKind: source.generatedKind,
      sourceElementKey: source.sourceElementKey,
      inheritedDefinitionDigest: artifactDigest(Buffer.from(source.definition, 'utf8')),
      ownerRef: OWNER,
      sourceCardRef: card.artifact.artifactRef,
      sourceCardDigest: artifactDigest(card.artifact.bytes),
      sourceCitationsDigest: taggedJcsDigest(SOURCE_CITATIONS_TAG, card.record.sourceCitations),
      reviewRecordRef: review.artifact.artifactRef,
      reviewRecordDigest: artifactDigest(review.artifact.bytes),
      generationRuleRef: rule.artifactRef,
      generationRuleDigest: artifactDigest(rule.bytes),
    };
    inheritanceArtifacts.push(jcsArtifact(ref(`term-card-inheritance/${local}.json`), record));
  }

  return {
    input: {
      profileRef: PROFILE,
      publicSymbolManifestArtifact,
      referenceClosureManifest,
      moduleDocs: [moduleDoc],
      cardArtifacts,
      reviewArtifacts,
      inheritanceArtifacts,
      generationRuleArtifacts,
    },
    moduleDoc,
  };
}

function recordOf(artifact) {
  return JSON.parse(artifact.bytes.toString('utf8'));
}

function rewrite(artifact, mutate) {
  const record = recordOf(artifact);
  mutate(record);
  artifact.bytes = Buffer.from(canonicalJcs(record), 'utf8');
}

function compileCodes(input, options = {}) {
  try {
    compileTermCardManifest(input, { generationRuleEvaluator: generationEvaluator, ...options });
  } catch (error) {
    if (!(error instanceof TermCardCompilationError)) throw error;
    return new Set(error.errors.map((entry) => entry.code));
  }
  return new Set();
}

test('compiles exact direct cards and all three generated inheritance kinds deterministically', () => {
  const { input } = buildFixture();
  const first = compileTermCardManifest(input, { generationRuleEvaluator: generationEvaluator });
  const second = compileTermCardManifest(input, { generationRuleEvaluator: generationEvaluator });
  assert.equal(first.manifest.directEntries.length, 3);
  assert.equal(first.manifest.generatedEntries.length, 4);
  assert.deepEqual(
    new Set(first.manifest.generatedEntries.map((entry) => entry.generatedKind)),
    new Set(['rolePredicate', 'codeMember', 'logicalIdentityClass']),
  );
  assert.equal(first.manifestDigest, taggedJcsDigest(TERM_CARD_MANIFEST_TAG, first.manifest));
  assert.equal(
    first.manifest.publicSymbolManifestDigest,
    taggedJcsDigest(PUBLIC_SYMBOL_MANIFEST_TAG, recordOf(input.publicSymbolManifestArtifact)),
  );
  assert.equal(canonicalJcs(first.manifest), canonicalJcs(second.manifest));
  const validation = validateTermCardManifest(first.manifest, input, {
    generationRuleEvaluator: generationEvaluator,
  });
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.ok, true);
});

test('direct cards are byte-semantically bound to normalized module metadata', async (t) => {
  await t.test('label drift', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => {
      record.preferredLabel = `${record.preferredLabel} alias`;
    });
    assert.ok(compileCodes(input).has('DIRECT_CARD_SOURCE_DRIFT'));
  });
  await t.test('definition drift with a recomputed digest', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => {
      record.definition = `${record.definition} Unreviewed semantic extension.`;
      record.definitionDigest = artifactDigest(Buffer.from(record.definition, 'utf8'));
    });
    assert.ok(compileCodes(input).has('DIRECT_CARD_SOURCE_DRIFT'));
  });
  await t.test('owner drift', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => {
      record.ownerRef = 'https://axiolune.ai/principals/substitute-owner';
    });
    assert.ok(compileCodes(input).has('DIRECT_CARD_SOURCE_DRIFT'));
  });
  await t.test('version drift', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => {
      record.version = '0.3.1';
    });
    assert.ok(compileCodes(input).has('DIRECT_CARD_SOURCE_DRIFT'));
  });
  await t.test('fact-derived genus drift', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => {
      record.genus = 'generic domain concept';
    });
    assert.ok(compileCodes(input).has('DIRECT_CARD_SOURCE_DRIFT'));
  });
  await t.test('fact-derived differentia drift', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => {
      record.differentia = ['manually asserted semantic claim'];
    });
    assert.ok(compileCodes(input).has('DIRECT_CARD_SOURCE_DRIFT'));
  });
  await t.test('candidate M3 type drift', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => {
      record.candidateM3Type = 'https://axiolune.ai/ontology/meta/core/ConstraintDefinition';
    });
    assert.ok(compileCodes(input).has('DIRECT_CARD_SOURCE_DRIFT'));
  });
});

test('direct card source records reject unknown fields, invalid primitives, and non-JCS bytes', async (t) => {
  await t.test('unknown field', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => { record.unreviewedClaim = true; });
    assert.ok(compileCodes(input).has('UNKNOWN_FIELD'));
  });
  await t.test('noncanonical SemVer', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => { record.version = '01.2.3'; });
    assert.ok(compileCodes(input).has('INVALID_CANONICAL_SEMVER'));
  });
  await t.test('non-NFC preferred label', () => {
    const { input } = buildFixture();
    const record = recordOf(input.cardArtifacts[0]);
    record.preferredLabel = 'Cafe\u0301';
    input.cardArtifacts[0].bytes = Buffer.from(JSON.stringify(record), 'utf8');
    assert.ok(compileCodes(input).has('INVALID_NFC_STRING'));
  });
  await t.test('wrong definition digest', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => { record.definitionDigest = HASH_A; });
    assert.ok(compileCodes(input).has('DEFINITION_DIGEST_MISMATCH'));
  });
  await t.test('invalid principal IRI', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => { record.ownerRef = 'relative-owner'; });
    assert.ok(compileCodes(input).has('INVALID_ABSOLUTE_IRI'));
  });
  await t.test('non-canonical absolute IRI serialization', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => {
      record.ownerRef = 'https://EXAMPLE.com/owner';
    });
    assert.ok(compileCodes(input).has('INVALID_ABSOLUTE_IRI'));
  });
  await t.test('trailing newline changes exact artifact bytes', () => {
    const { input } = buildFixture();
    input.cardArtifacts[0].bytes = Buffer.concat([input.cardArtifacts[0].bytes, Buffer.from('\n')]);
    assert.ok(compileCodes(input).has('NON_CANONICAL_ARTIFACT_BYTES'));
  });
  await t.test('missing genus is rejected by the closed schema', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => { delete record.genus; });
    assert.ok(compileCodes(input).has('MISSING_FIELD'));
  });
  await t.test('empty differentia is rejected', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => { record.differentia = []; });
    assert.ok(compileCodes(input).has('EMPTY_DIFFERENTIA'));
  });
  await t.test('empty exclusions are rejected', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => { record.excludes = []; });
    assert.ok(compileCodes(input).has('EMPTY_EXCLUDES'));
  });
  await t.test('differentia must be deterministically sorted and unique', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => {
      record.differentia = ['same semantic fact', 'same semantic fact'];
    });
    assert.ok(compileCodes(input).has('UNSORTED_OR_DUPLICATE_TERM_SEMANTIC_LIST'));
  });
  await t.test('candidate M3 type must be one exact core meta-model IRI', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => {
      record.candidateM3Type = 'https://axiolune.ai/ontology/meta/core/UnknownDefinition';
    });
    assert.ok(compileCodes(input).has('INVALID_CANDIDATE_M3_TYPE'));
  });
});

test('review records are complete-card decisions with strict status/decision cross-products', async (t) => {
  await t.test('unknown review field', () => {
    const { input } = buildFixture();
    rewrite(input.reviewArtifacts[0], (record) => { record.approvalShortcut = true; });
    assert.ok(compileCodes(input).has('UNKNOWN_FIELD'));
  });
  await t.test('one ArtifactRef cannot name both a card and a review record', () => {
    const { input } = buildFixture();
    input.reviewArtifacts[0].artifactRef = structuredClone(input.cardArtifacts[0].artifactRef);
    assert.ok(compileCodes(input).has('CROSS_INVENTORY_ARTIFACT_REF'));
  });
  await t.test('invalid whole-second UTC instant', () => {
    const { input } = buildFixture();
    rewrite(input.reviewArtifacts[0], (record) => { record.decisionTime = '2026-07-31T12:34:56.100Z'; });
    assert.ok(compileCodes(input).has('INVALID_INSTANT'));
  });
  await t.test('stale reviewed version', () => {
    const { input } = buildFixture();
    rewrite(input.reviewArtifacts[0], (record) => { record.reviewedVersion = '0.2.0'; });
    assert.ok(compileCodes(input).has('STALE_OR_UNRELATED_REVIEW'));
  });
  await t.test('card mutation after review invalidates the card-digest join', () => {
    const { input } = buildFixture();
    rewrite(input.cardArtifacts[0], (record) => {
      record.definition = `${record.definition} Changed after review.`;
      record.definitionDigest = artifactDigest(Buffer.from(record.definition, 'utf8'));
    });
    assert.ok(compileCodes(input).has('MISSING_CARD_REVIEW'));
  });
  await t.test('accepted card with reject decision', () => {
    const { input } = buildFixture();
    rewrite(input.reviewArtifacts[0], (record) => { record.decision = 'reject'; });
    assert.ok(compileCodes(input).has('CARD_REVIEW_DECISION_MISMATCH'));
  });
  await t.test('rejected card with matching reject decision is internally valid outside release mode', () => {
    const { input } = buildFixture({ directOnly: true });
    rewrite(input.cardArtifacts[0], (record) => { record.status = 'rejected'; });
    const card = input.cardArtifacts[0];
    rewrite(input.reviewArtifacts[0], (record) => {
      record.cardDigest = artifactDigest(card.bytes);
      record.decision = 'reject';
    });
    assert.deepEqual([...compileCodes(input, { requireAccepted: false })], []);
    assert.ok(compileCodes(input).has('NON_RELEASE_CARD_STATUS'));
  });
  await t.test('rejected card with accept decision is inconsistent', () => {
    const { input } = buildFixture({ directOnly: true });
    rewrite(input.cardArtifacts[0], (record) => { record.status = 'rejected'; });
    const card = input.cardArtifacts[0];
    rewrite(input.reviewArtifacts[0], (record) => { record.cardDigest = artifactDigest(card.bytes); });
    assert.ok(compileCodes(input, { requireAccepted: false }).has('CARD_REVIEW_DECISION_MISMATCH'));
  });
});

test('citations are sorted, locator-unique, strict, and joined to exactly one closure row', async (t) => {
  await t.test('citation schema is recursively closed', () => {
    const { input } = buildFixture({ directOnly: true });
    rewrite(input.cardArtifacts[0], (record) => { record.sourceCitations[0].note = 'not allowed'; });
    assert.ok(compileCodes(input, { requireAccepted: false }).has('UNKNOWN_FIELD'));
  });
  await t.test('dual-labelled locator is fatal', () => {
    const { input } = buildFixture({ directOnly: true });
    rewrite(input.cardArtifacts[0], (record) => {
      const second = structuredClone(record.sourceCitations[0]);
      second.usage = 'normative';
      record.sourceCitations = [record.sourceCitations[0], second];
    });
    const codes = compileCodes(input, { requireAccepted: false });
    assert.ok(codes.has('DUPLICATE_CITATION_LOCATOR'));
  });
  await t.test('unsorted tuple is fatal', () => {
    const { input } = buildFixture({ directOnly: true });
    const closureEntry = input.referenceClosureManifest.entries[0];
    const secondEntry = structuredClone(closureEntry);
    secondEntry.referenceId = 'another-reference';
    input.referenceClosureManifest.entries.push(secondEntry);
    rewrite(input.cardArtifacts[0], (record) => {
      const second = structuredClone(record.sourceCitations[0]);
      second.referenceId = 'another-reference';
      record.sourceCitations = [record.sourceCitations[0], second];
    });
    assert.ok(compileCodes(input, { requireAccepted: false }).has('UNSORTED_OR_DUPLICATE_SOURCE_CITATION'));
  });
  await t.test('wrong locked digest has zero joins', () => {
    const { input } = buildFixture({ directOnly: true });
    rewrite(input.cardArtifacts[0], (record) => { record.sourceCitations[0].artifactDigest = HASH_A; });
    assert.ok(compileCodes(input, { requireAccepted: false }).has('UNRESOLVED_SOURCE_CITATION'));
  });
  await t.test('duplicated closure locator has multiple joins', () => {
    const { input } = buildFixture({ directOnly: true });
    input.referenceClosureManifest.entries.push(structuredClone(input.referenceClosureManifest.entries[0]));
    assert.ok(compileCodes(input, { requireAccepted: false }).has('AMBIGUOUS_SOURCE_CITATION'));
  });
});

test('generated inheritance joins normalized sources, accepted source cards, and locked rules', async (t) => {
  await t.test('inheritance record schema is closed', () => {
    const { input } = buildFixture();
    rewrite(input.inheritanceArtifacts[0], (record) => { record.inheritedWithoutReview = true; });
    assert.ok(compileCodes(input).has('UNKNOWN_FIELD'));
  });
  await t.test('inherited definition drift', () => {
    const { input } = buildFixture();
    rewrite(input.inheritanceArtifacts[0], (record) => { record.inheritedDefinitionDigest = HASH_A; });
    assert.ok(compileCodes(input).has('INHERITED_FIELD_DRIFT'));
  });
  await t.test('resealing a changed role definition cannot retain the containing-card review', () => {
    const { input, moduleDoc } = buildFixture();
    const role = moduleDoc.domain.associationTypes.Ownership.participantRoles[0];
    role.definition = 'Changed role meaning that has not received a new containing-card review.';
    const inheritance = input.inheritanceArtifacts.find(
      (artifact) => recordOf(artifact).generatedKind === 'rolePredicate',
    );
    rewrite(inheritance, (record) => {
      record.inheritedDefinitionDigest = artifactDigest(Buffer.from(role.definition, 'utf8'));
    });
    assert.ok(compileCodes(input).has('DIRECT_CARD_SOURCE_DRIFT'));
  });
  await t.test('resealing a changed code-member definition cannot retain the code-list review', () => {
    const { input, moduleDoc } = buildFixture();
    const value = moduleDoc.domain.codeLists.State.values[0];
    value.definition = 'Changed code-member meaning that has not received a new code-list review.';
    const inheritance = input.inheritanceArtifacts.find(
      (artifact) => recordOf(artifact).generatedKind === 'codeMember',
    );
    rewrite(inheritance, (record) => {
      record.inheritedDefinitionDigest = artifactDigest(Buffer.from(value.definition, 'utf8'));
    });
    assert.ok(compileCodes(input).has('DIRECT_CARD_SOURCE_DRIFT'));
  });
  await t.test('wrong source element key', () => {
    const { input } = buildFixture();
    rewrite(input.inheritanceArtifacts[0], (record) => { record.sourceElementKey = HASH_A; });
    const codes = compileCodes(input);
    assert.ok(codes.has('GENERATED_SYMBOL_JOIN_MISMATCH'));
    assert.ok(codes.has('UNRESOLVED_GENERATED_SOURCE'));
  });
  await t.test('source card ref cannot point at another card', () => {
    const { input } = buildFixture();
    const other = input.cardArtifacts[1].artifactRef;
    rewrite(input.inheritanceArtifacts[0], (record) => { record.sourceCardRef = other; });
    assert.ok(compileCodes(input).has('SOURCE_CARD_REF_MISMATCH'));
  });
  await t.test('stale source review digest', () => {
    const { input } = buildFixture();
    rewrite(input.inheritanceArtifacts[0], (record) => { record.reviewRecordDigest = HASH_A; });
    assert.ok(compileCodes(input).has('INHERITED_FIELD_DRIFT'));
  });
  await t.test('wrong generation-rule digest', () => {
    const { input } = buildFixture();
    rewrite(input.inheritanceArtifacts[0], (record) => { record.generationRuleDigest = HASH_A; });
    assert.ok(compileCodes(input).has('GENERATION_RULE_DIGEST_MISMATCH'));
  });
  await t.test('missing locked evaluator fails closed', () => {
    const { input } = buildFixture();
    assert.throws(
      () => compileTermCardManifest(input),
      (error) => error instanceof TermCardCompilationError
        && error.errors.some((entry) => entry.code === 'MISSING_GENERATION_RULE_EVALUATOR'),
    );
  });
  await t.test('evaluator must reproduce the exact generated IRI', () => {
    const { input } = buildFixture();
    const codes = (() => {
      try {
        compileTermCardManifest(input, { generationRuleEvaluator: () => `${BASE}wrong` });
      } catch (error) {
        return new Set(error.errors.map((entry) => entry.code));
      }
      return new Set();
    })();
    assert.ok(codes.has('GENERATION_RULE_REPRODUCTION_MISMATCH'));
  });
});

test('public-symbol union coverage rejects missing and orphan card/inheritance artifacts', async (t) => {
  await t.test('missing direct card', () => {
    const { input } = buildFixture();
    input.cardArtifacts.shift();
    assert.ok(compileCodes(input).has('MISSING_DIRECT_TERM_CARD'));
  });
  await t.test('missing generated inheritance', () => {
    const { input } = buildFixture();
    input.inheritanceArtifacts.shift();
    assert.ok(compileCodes(input).has('MISSING_GENERATED_INHERITANCE'));
  });
  await t.test('orphan direct card', () => {
    const { input } = buildFixture({ directOnly: true });
    const originalCard = recordOf(input.cardArtifacts[0]);
    const originalReview = recordOf(input.reviewArtifacts[0]);
    const orphanIri = `${BASE}orphan`;
    originalCard.publicIri = orphanIri;
    originalCard.definitionDigest = artifactDigest(Buffer.from(originalCard.definition, 'utf8'));
    const orphanCard = jcsArtifact(ref('term-cards/orphan.json'), originalCard);
    originalReview.publicIri = orphanIri;
    originalReview.cardRef = orphanCard.artifactRef;
    originalReview.cardDigest = artifactDigest(orphanCard.bytes);
    const orphanReview = jcsArtifact(ref('term-card-reviews/orphan.json'), originalReview);
    input.cardArtifacts.push(orphanCard);
    input.reviewArtifacts.push(orphanReview);
    assert.ok(compileCodes(input, { requireAccepted: false }).has('ORPHAN_DIRECT_CARD'));
  });
});

test('term-card manifest itself is closed, sorted, and the exact compiler projection', async (t) => {
  await t.test('unknown nested review field', () => {
    const { input } = buildFixture();
    const compiled = compileTermCardManifest(input, { generationRuleEvaluator: generationEvaluator });
    compiled.manifest.directEntries[0].review.signature = 'not-in-schema';
    const result = validateTermCardManifest(compiled.manifest, input, {
      generationRuleEvaluator: generationEvaluator,
    });
    const codes = new Set(result.errors.map((entry) => entry.code));
    assert.ok(codes.has('UNKNOWN_FIELD'));
    assert.ok(codes.has('TERM_CARD_MANIFEST_MISMATCH'));
  });
  await t.test('reordered direct entries', () => {
    const { input } = buildFixture();
    const compiled = compileTermCardManifest(input, { generationRuleEvaluator: generationEvaluator });
    compiled.manifest.directEntries.reverse();
    const codes = new Set(validateTermCardManifest(compiled.manifest, input, {
      generationRuleEvaluator: generationEvaluator,
    }).errors.map((entry) => entry.code));
    assert.ok(codes.has('UNSORTED_OR_DUPLICATE_DIRECT_ENTRY'));
    assert.ok(codes.has('TERM_CARD_MANIFEST_MISMATCH'));
  });
  await t.test('embedded public-symbol digest drift', () => {
    const { input } = buildFixture();
    const compiled = compileTermCardManifest(input, { generationRuleEvaluator: generationEvaluator });
    compiled.manifest.publicSymbolManifestDigest = HASH_A;
    const codes = new Set(validateTermCardManifest(compiled.manifest, input, {
      generationRuleEvaluator: generationEvaluator,
    }).errors.map((entry) => entry.code));
    assert.ok(codes.has('TERM_CARD_MANIFEST_MISMATCH'));
  });
  await t.test('direct and generated sets are disjoint', () => {
    const { input } = buildFixture();
    const compiled = compileTermCardManifest(input, { generationRuleEvaluator: generationEvaluator });
    compiled.manifest.generatedEntries[0].generatedIri = compiled.manifest.directEntries[0].publicIri;
    const codes = new Set(validateTermCardManifest(compiled.manifest, input, {
      generationRuleEvaluator: generationEvaluator,
    }).errors.map((entry) => entry.code));
    assert.ok(codes.has('DIRECT_GENERATED_SET_OVERLAP'));
    assert.ok(codes.has('TERM_CARD_MANIFEST_MISMATCH'));
  });
});
