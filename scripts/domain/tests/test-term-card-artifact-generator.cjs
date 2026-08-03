'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  collectGeneratedSources,
  compileArtifacts,
} = require('../generate-term-card-artifacts.cjs');
const {
  parseExactJcs,
  validateSnapshotInventory,
} = require('../generate-term-card-manifest.cjs');
const {
  sourceKey,
} = require('../lib/public-symbol-compiler.cjs');

test('abstract object types do not create orphan logical-identity term inheritance', () => {
  const moduleIri = 'https://example.test/module';
  const abstractIri = 'https://example.test/module/AbstractType';
  const concreteIri = 'https://example.test/module/ConcreteType';
  const moduleDocument = {
    module: { moduleIri, exports: [] },
    domain: {
      objectTypes: {
        AbstractType: {
          iri: abstractIri,
          abstract: true,
          definition: 'An abstract classifier.',
        },
        ConcreteType: {
          iri: concreteIri,
          definition: 'A concrete classifier.',
        },
      },
      associationTypes: {},
      codeLists: {},
    },
  };
  const concreteSourceKey = sourceKey({
    kind: 'logicalIdentityClass',
    typeIri: concreteIri,
  });
  const publicByIri = new Map([
    [`${concreteIri}/LogicalIdentity`, {
      publicIri: `${concreteIri}/LogicalIdentity`,
      origin: 'generated',
      generatedKind: 'logicalIdentityClass',
      ownerModule: moduleIri,
      sourceElementKey: concreteSourceKey,
    }],
  ]);

  const sources = collectGeneratedSources([moduleDocument], publicByIri);
  assert.deepEqual(
    sources.map((source) => source.generatedIri),
    [`${concreteIri}/LogicalIdentity`],
  );
  assert.ok(!sources.some((source) => source.generatedIri === `${abstractIri}/LogicalIdentity`));
});

test('term-card manifest generation rejects singleton lookalike artifacts', () => {
  const files = new Map([
    ['docs/domain/infrastructure/public-symbol-manifest.json', Buffer.from('{}')],
    ['docs/ontology/references/reference-closure-manifest.json', Buffer.from('{}')],
    ['scripts/domain/rules/public-iri-generation-v1.json', Buffer.from('{}')],
  ]);
  assert.doesNotThrow(() => validateSnapshotInventory(files));
  files.set(
    'docs/domain/infrastructure/unreviewed/public-symbol-manifest.json',
    Buffer.from('{}'),
  );
  assert.throws(
    () => validateSnapshotInventory(files),
    /expected exactly one publicSymbolManifest/u,
  );
});

test('term-card manifest generation rejects non-JCS reference closure bytes', () => {
  assert.deepEqual(parseExactJcs(Buffer.from('{"a":1}', 'utf8'), 'closure'), { a: 1 });
  assert.throws(
    () => parseExactJcs(Buffer.from('{"a":1}\n', 'utf8'), 'closure'),
    /not exact RFC 8785 JCS bytes/u,
  );
});

test('terminology authority decision controls the complete card/review/inheritance disposition', () => {
  const compiled = compileArtifacts();
  const directCards = [...compiled.files.entries()]
    .filter(([file]) => file.includes(`${require('node:path').sep}direct${require('node:path').sep}`))
    .map(([, bytes]) => JSON.parse(bytes.toString('utf8')));
  const reviewArtifacts = [...compiled.files.keys()].filter(
    (file) => file.includes(`${require('node:path').sep}reviews${require('node:path').sep}`),
  );
  const inheritanceArtifacts = [...compiled.files.keys()].filter(
    (file) => file.includes(`${require('node:path').sep}inheritance${require('node:path').sep}`),
  );
  assert.equal(directCards.length, compiled.index.directCardCount);
  assert.ok(['pending', 'reviewed'].includes(compiled.index.authorityDecisionStatus));
  assert.equal(compiled.reviewed, compiled.index.authorityDecisionStatus === 'reviewed');
  assert.equal(
    compiled.index.reviewCount,
    compiled.reviewed ? compiled.index.directCardCount : 0,
  );
  assert.equal(
    compiled.index.generatedInheritanceCount > 0,
    compiled.reviewed,
  );
  assert.equal(reviewArtifacts.length, compiled.index.reviewCount);
  assert.equal(inheritanceArtifacts.length, compiled.index.generatedInheritanceCount);
  for (const card of directCards) {
    const authorityCitations = card.sourceCitations.filter(
      (citation) => citation.referenceId === 'axiolune-m2-controlled-terminology',
    );
    assert.equal(authorityCitations.length, 1);
    assert.equal(authorityCitations[0].usage, compiled.reviewed ? 'normative' : 'implementation');
    assert.equal(card.status, compiled.reviewed ? 'accepted' : 'review');
  }
});
