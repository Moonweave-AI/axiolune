#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  collectAlignments,
  expectedEvidence,
} = require('../sync-alignment-digests.cjs');

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const TARGET = 'https://example.test/fibo/Target';
const SUBJECT_PATH = 'reference/ontology-design-reference/fibo/Target.rdf';

function locator(path = 'Target.rdf') {
  return {
    kind: 'rdfResource',
    path,
    mediaType: 'application/rdf+xml',
    extractorProfileRef: {
      kind: 'path',
      root: 'sourceTree',
      path: 'scripts/domain/reference-extractors/rdf-resource-rdfxml-v1.json',
    },
    extractorProfileDigest: DIGEST_A,
    selectionDigest: DIGEST_B,
    resourceIri: TARGET,
  };
}

function inputs({
  status = 'subject-present',
  subjectPaths = [SUBJECT_PATH],
  includeLocator = true,
} = {}) {
  return {
    fibo: {
      releaseOrCommit: '2024Q1',
      artifactDigest: DIGEST_A,
    },
    evidenceByTarget: new Map([[
      TARGET,
      { targetIri: TARGET, status, subjectPaths },
    ]]),
    locatorsByTargetIri: new Map(includeLocator ? [[TARGET, [{
      absolutePath: SUBJECT_PATH,
      locator: locator(),
    }]]] : []),
  };
}

function alignment(overrides = {}) {
  return {
    vocabulary: 'FIBO',
    targetIri: TARGET,
    relation: 'rdfs:subClassOf',
    sourceRelease: {
      vocabulary: 'FIBO',
      release: 'stale',
      artifactDigest: DIGEST_B,
    },
    sourceLocator: locator('stale.rdf'),
    rationale: 'test-only alignment evidence',
    verification: { status: 'proposed' },
    ...overrides,
  };
}

test('collectAlignments reports every nested alignment with a stable document path', () => {
  const value = {
    domain: {
      objectTypes: {
        TestObject: {
          alignments: [alignment()],
        },
      },
      codeLists: {
        TestCodes: {
          alignments: [alignment(), alignment()],
        },
      },
    },
  };

  assert.deepEqual(
    collectAlignments(value).map((record) => record.path),
    [
      ['domain', 'objectTypes', 'TestObject', 'alignments', 0],
      ['domain', 'codeLists', 'TestCodes', 'alignments', 0],
      ['domain', 'codeLists', 'TestCodes', 'alignments', 1],
    ],
  );
});

test('expectedEvidence derives exact release, digest, and reviewed locator bytes', () => {
  assert.deepEqual(expectedEvidence(alignment(), inputs()), {
    sourceRelease: {
      vocabulary: 'FIBO',
      release: '2024Q1',
      artifactDigest: DIGEST_A,
    },
    sourceLocator: locator(),
  });
});

test('non-FIBO and undeclared extension fields fail closed', () => {
  assert.throws(
    () => expectedEvidence(alignment({ vocabulary: 'Other' }), inputs()),
    /unsupported alignment vocabulary Other/,
  );
  assert.throws(
    () => expectedEvidence(alignment({ lockRef: 'invented-shortcut' }), inputs()),
    /forbidden field lockRef/,
  );
});

test('object-only or absent target evidence cannot substantiate an RDF alignment', () => {
  assert.throws(
    () => expectedEvidence(alignment(), inputs({ status: 'object-only' })),
    /target is not an RDF subject/,
  );
  assert.throws(
    () => expectedEvidence(
      alignment({ targetIri: 'https://example.test/fibo/Unknown' }),
      inputs(),
    ),
    /target has no reviewed evidence row/,
  );
});

test('subject evidence outside the strict lock locator closure fails closed', () => {
  assert.throws(
    () => expectedEvidence(alignment(), inputs({ includeLocator: false })),
    /requires exactly one exact rdfResource lock locator; found 0/,
  );
});

test('a whole-file locator cannot substantiate exact target semantics', () => {
  const inexact = inputs({ includeLocator: false });
  inexact.locatorsByTargetIri.set(TARGET, [{
    absolutePath: SUBJECT_PATH,
    locator: { ...locator(), kind: 'wholeFile', resourceIri: undefined },
  }]);
  assert.throws(
    () => expectedEvidence(alignment(), inexact),
    /requires exactly one exact rdfResource lock locator; found 0/,
  );
});

test('duplicate exact target locators fail rather than selecting one by path order', () => {
  const ambiguous = inputs();
  ambiguous.locatorsByTargetIri.get(TARGET).push({
    absolutePath: SUBJECT_PATH,
    locator: { ...locator(), selectionDigest: `sha256:${'c'.repeat(64)}` },
  });
  assert.throws(
    () => expectedEvidence(alignment(), ambiguous),
    /requires exactly one exact rdfResource lock locator; found 2/,
  );
});
