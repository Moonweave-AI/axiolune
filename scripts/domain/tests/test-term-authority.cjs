'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  TermAuthorityError,
  compileTermAuthorityCandidate,
  mergeTermAuthorityOverrides,
  validateTermAuthorityManifest,
} = require('../lib/term-authority.cjs');

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const MODULE_IRI = 'https://example.test/finance';
const LOCATOR = {
  kind: 'rdfResource',
  path: 'terms.rdf',
  mediaType: 'application/rdf+xml',
  extractorProfileRef: {
    kind: 'path',
    root: 'sourceTree',
    path: 'scripts/domain/reference-extractors/rdf-resource-rdfxml-v1.json',
  },
  extractorProfileDigest: HASH_A,
  selectionDigest: HASH_B,
  resourceIri: `${MODULE_IRI}/Instrument`,
};

function fixture() {
  const moduleDocs = [{
    module: {
      moduleIri: MODULE_IRI,
      baseIri: `${MODULE_IRI}/`,
      preferredPrefix: 'fin',
      version: '0.3.0',
      label: 'Finance',
      definition: 'test finance module',
      imports: [],
      exports: [],
      status: 'draft',
      governance: {
        ownerRef: 'urn:example:principal:owner',
        status: 'draft',
      },
    },
    domain: {
      objectTypes: {
        Instrument: {
          iri: `${MODULE_IRI}/Instrument`,
          namespace: 'fin',
          localName: 'Instrument',
          label: 'Instrument',
          definition: 'a contract or asset with a stable financial identity',
          abstract: false,
          superTypes: [],
          attributeUses: [],
          patternBindings: [],
        },
      },
      relationTypes: {
        issuedBy: {
          iri: `${MODULE_IRI}/issuedBy`,
          namespace: 'fin',
          localName: 'issuedBy',
          label: 'issued by',
          definition: 'relates an instrument to its issuer',
          domain: `${MODULE_IRI}/Instrument`,
          range: `${MODULE_IRI}/Instrument`,
          characteristics: [],
        },
      },
    },
  }];
  const lock = {
    references: [{
      id: 'external-terms',
      artifactDigest: HASH_A,
      locators: [LOCATOR],
    }],
  };
  const overrides = {
    schemaVersion: '1.0',
    entries: [{
      authorityKind: 'externalExact',
      publicIri: `${MODULE_IRI}/Instrument`,
      upstreamEvidence: [{
        locator: LOCATOR,
        rationale: 'the locked source defines the exact selected test term',
        referenceId: 'external-terms',
        transformation: 'exactIdentity',
        usage: 'normative',
      }],
    }],
  };
  return { lock, moduleDocs, overrides };
}

test('term authority candidate is an exact authored-public-symbol projection', () => {
  const { lock, moduleDocs, overrides } = fixture();
  const candidate = compileTermAuthorityCandidate(moduleDocs, overrides, lock);
  assert.equal(candidate.entries.length, 2);
  assert.equal(candidate.decision.status, 'pending');
  assert.equal(candidate.entries[0].authorityKind, 'externalExact');
  assert.equal(candidate.entries[1].authorityKind, 'axioluneOperational');
  assert.match(candidate.candidateDigest, /^sha256:[0-9a-f]{64}$/u);
  const validation = validateTermAuthorityManifest(candidate, moduleDocs, lock, overrides);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.ok, true);
});

test('term authority rejects orphan overrides and non-locked evidence locators', () => {
  const { lock, moduleDocs, overrides } = fixture();
  const orphan = structuredClone(overrides);
  orphan.entries[0].publicIri = 'https://example.test/orphan';
  assert.throws(
    () => compileTermAuthorityCandidate(moduleDocs, orphan, lock),
    (error) => error instanceof TermAuthorityError
      && error.errors.some((message) => message.includes('does not select one authored public symbol')),
  );

  const drifted = structuredClone(overrides);
  drifted.entries[0].upstreamEvidence[0].locator.selectionDigest = HASH_A;
  assert.throws(
    () => compileTermAuthorityCandidate(moduleDocs, drifted, lock),
    (error) => error instanceof TermAuthorityError
      && error.errors.some((message) => message.includes('byte-identical')),
  );
});

test('term authority keeps project implementation evidence context-only', () => {
  const { lock, moduleDocs, overrides } = fixture();
  lock.references[0].localPath = 'reference/project-reference/example-engine';
  overrides.entries[0].authorityKind = 'axioluneOperational';
  overrides.entries[0].upstreamEvidence[0].usage = 'implementation';
  overrides.entries[0].upstreamEvidence[0].transformation = 'contextOnly';
  assert.doesNotThrow(() => compileTermAuthorityCandidate(moduleDocs, overrides, lock));

  const adopted = structuredClone(overrides);
  adopted.entries[0].authorityKind = 'implementationAdopted';
  assert.throws(
    () => compileTermAuthorityCandidate(moduleDocs, adopted, lock),
    (error) => error instanceof TermAuthorityError
      && error.errors.some((message) => /implementationAdopted is prohibited/u.test(message)),
  );

  const subset = structuredClone(overrides);
  subset.entries[0].upstreamEvidence[0].transformation = 'caseNormalizedSubset';
  assert.throws(
    () => compileTermAuthorityCandidate(moduleDocs, subset, lock),
    (error) => error instanceof TermAuthorityError
      && error.errors.some((message) => /implementation evidence must use transformation=contextOnly/u.test(message)),
  );

  const normative = structuredClone(overrides);
  normative.entries[0].upstreamEvidence[0].usage = 'normative';
  normative.entries[0].upstreamEvidence[0].transformation = 'exactIdentity';
  assert.throws(
    () => compileTermAuthorityCandidate(moduleDocs, normative, lock),
    (error) => error instanceof TermAuthorityError
      && error.errors.some((message) => /project-reference evidence must be implementation\/contextOnly/u.test(message)),
  );
});

test('context-only evidence cannot masquerade as normative authority', () => {
  const { lock, moduleDocs, overrides } = fixture();
  overrides.entries[0].authorityKind = 'externalAdapted';
  overrides.entries[0].upstreamEvidence[0].usage = 'normative';
  overrides.entries[0].upstreamEvidence[0].transformation = 'contextOnly';
  assert.throws(
    () => compileTermAuthorityCandidate(moduleDocs, overrides, lock),
    (error) => error instanceof TermAuthorityError
      && error.errors.some(
        (message) => /normative evidence cannot use transformation=contextOnly/u.test(message),
      ),
  );
});

test('term authority validation detects definition, source-key, and candidate drift', () => {
  const { lock, moduleDocs, overrides } = fixture();
  const candidate = compileTermAuthorityCandidate(moduleDocs, overrides, lock);
  const changed = structuredClone(candidate);
  changed.entries[0].definition = 'mutated after review';
  const codes = validateTermAuthorityManifest(changed, moduleDocs, lock, overrides).errors.join('\n');
  assert.match(codes, /definitionDigest/u);
  assert.match(codes, /candidateDigest/u);
  assert.match(codes, /exact projection/u);

  const wrongKey = structuredClone(candidate);
  wrongKey.entries[0].sourceElementKey = HASH_A;
  assert.match(
    validateTermAuthorityManifest(wrongKey, moduleDocs, lock, overrides).errors.join('\n'),
    /exact projection/u,
  );
});

test('term authority rejects incomplete or non-canonical ISO 704 card semantics', () => {
  const { lock, moduleDocs, overrides } = fixture();
  const candidate = compileTermAuthorityCandidate(moduleDocs, overrides, lock);

  const missing = structuredClone(candidate);
  delete missing.entries[0].genus;
  assert.match(
    validateTermAuthorityManifest(missing, moduleDocs, lock, overrides).errors.join('\n'),
    /fields must equal/u,
  );

  const emptyDifferentia = structuredClone(candidate);
  emptyDifferentia.entries[0].differentia = [];
  assert.match(
    validateTermAuthorityManifest(
      emptyDifferentia,
      moduleDocs,
      lock,
      overrides,
    ).errors.join('\n'),
    /differentia must be a non-empty array/u,
  );

  const wrongMetaType = structuredClone(candidate);
  wrongMetaType.entries[0].candidateM3Type =
    'https://axiolune.ai/ontology/meta/core/ConstraintDefinition';
  assert.match(
    validateTermAuthorityManifest(wrongMetaType, moduleDocs, lock, overrides).errors.join('\n'),
    /candidateM3Type must equal the canonical M3 type/u,
  );
});

test('repository-edited term adoption is digest-bound but never terminal authority', () => {
  const { lock, moduleDocs, overrides } = fixture();
  const candidate = compileTermAuthorityCandidate(moduleDocs, overrides, lock);
  candidate.decision = {
    candidateDigest: candidate.candidateDigest,
    decisionTime: '2026-07-31T14:30:00Z',
    driRef: 'urn:example:principal:owner',
    rationale: 'reviewed the exact candidate bytes and accepted the definitions',
    reviewBasisRefs: ['https://example.test/reviews/term-authority'],
    status: 'adopted',
  };
  assert.match(
    validateTermAuthorityManifest(candidate, moduleDocs, lock, overrides).errors.join('\n'),
    /terminal authority adoption is unavailable|repository-edited adopted JSON/u,
  );
  candidate.decision.decisionTime = '2026-07-31T14:30:00+00:00';
  assert.match(
    validateTermAuthorityManifest(candidate, moduleDocs, lock, overrides).errors.join('\n'),
    /whole-second UTC/u,
  );
  candidate.decision.decisionTime = '2026-02-31T14:30:00Z';
  assert.match(
    validateTermAuthorityManifest(candidate, moduleDocs, lock, overrides).errors.join('\n'),
    /whole-second UTC/u,
  );
});

test('term authority accepts a digest-bound semantic review without claiming adoption', () => {
  const { lock, moduleDocs, overrides } = fixture();
  const candidate = compileTermAuthorityCandidate(moduleDocs, overrides, lock);
  candidate.decision = {
    candidateDigest: candidate.candidateDigest,
    decisionTime: '2026-07-31T14:30:00Z',
    rationale: 'Reviewed the exact candidate definitions and their locked evidence boundaries.',
    reviewBasisRefs: ['https://example.test/reviews/term-authority'],
    reviewerRef: 'urn:example:principal:owner',
    status: 'reviewed',
  };
  const validation = validateTermAuthorityManifest(candidate, moduleDocs, lock, overrides);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.decisionStatus, 'reviewed');

  candidate.entries[0].definition = 'mutated after semantic review';
  assert.match(
    validateTermAuthorityManifest(candidate, moduleDocs, lock, overrides).errors.join('\n'),
    /candidateDigest|exact projection|definitionDigest/u,
  );
});

test('term authority accepts supplementary Unicode and rejects nondeterministic review refs', () => {
  const { lock, moduleDocs, overrides } = fixture();
  moduleDocs[0].domain.objectTypes.Instrument.definition =
    'A contract with a stable identity represented by the symbol \u{1F4C8}.';
  const candidate = compileTermAuthorityCandidate(moduleDocs, overrides, lock);
  assert.equal(validateTermAuthorityManifest(candidate, moduleDocs, lock, overrides).ok, true);

  candidate.decision = {
    candidateDigest: candidate.candidateDigest,
    decisionTime: '2026-07-31T14:30:00Z',
    driRef: 'urn:example:principal:owner',
    rationale: 'reviewed the exact candidate bytes and accepted the definitions',
    reviewBasisRefs: [
      'https://example.test/reviews/z',
      'https://example.test/reviews/a',
    ],
    status: 'adopted',
  };
  assert.match(
    validateTermAuthorityManifest(candidate, moduleDocs, lock, overrides).errors.join('\n'),
    /strictly UTF-8 sorted and unique/u,
  );
});

test('code-list authority evidence is projected into the matching direct term authority', () => {
  const { lock, moduleDocs } = fixture();
  moduleDocs[0].domain.codeLists = {
    InstrumentKind: {
      iri: `${MODULE_IRI}/InstrumentKind`,
      namespace: 'fin',
      localName: 'InstrumentKind',
      label: 'Instrument Kind',
      definition: 'closed classification of instrument kinds',
      vocabulary: 'Instrument Kind',
      version: '0.3.0',
      maintainer: 'Axiolune test maintainers',
      sourceEvidenceRef: 'https://example.test/evidence/instrument-kind',
      values: [{
        iri: `${MODULE_IRI}/InstrumentKind/value/example`,
        notation: 'example',
        label: 'Example',
        definition: 'example instrument kind',
      }],
    },
  };
  const codeListOverrides = {
    schemaVersion: '1.0',
    entries: [{
      authorityKind: 'externalAdapted',
      codeListIri: `${MODULE_IRI}/InstrumentKind`,
      rationale: 'the locked source defines the selected test vocabulary',
      upstreamEvidence: [{
        locator: LOCATOR,
        rationale: 'the locked source defines the exact selected test term',
        referenceId: 'external-terms',
        transformation: 'adaptedComposite',
        usage: 'normative',
      }],
    }],
  };
  const merged = mergeTermAuthorityOverrides(
    moduleDocs,
    { schemaVersion: '1.0', entries: [] },
    codeListOverrides,
  );
  assert.deepEqual(Object.keys(merged.entries[0]).sort(), [
    'authorityKind',
    'publicIri',
    'upstreamEvidence',
  ]);
  const candidate = compileTermAuthorityCandidate(moduleDocs, merged, lock);
  const entry = candidate.entries.find(
    (term) => term.publicIri === `${MODULE_IRI}/InstrumentKind`,
  );
  assert.equal(entry.authorityKind, 'externalAdapted');
  assert.equal(entry.upstreamEvidence.length, 1);
  assert.equal(entry.upstreamEvidence[0].referenceId, 'external-terms');
});

test('authority override merge rejects cross-input duplicates and non-code-list targets', () => {
  const { moduleDocs, overrides } = fixture();
  const duplicate = {
    schemaVersion: '1.0',
    entries: [{
      authorityKind: 'externalExact',
      codeListIri: `${MODULE_IRI}/Instrument`,
      rationale: 'invalidly targets an object type',
      upstreamEvidence: overrides.entries[0].upstreamEvidence,
    }],
  };
  assert.throws(
    () => mergeTermAuthorityOverrides(moduleDocs, overrides, duplicate),
    (error) => error instanceof TermAuthorityError
      && error.errors.some((message) => message.includes('CodeListDefinition')),
  );

  moduleDocs[0].domain.codeLists = {
    InstrumentKind: {
      iri: `${MODULE_IRI}/InstrumentKind`,
      label: 'Instrument Kind',
      definition: 'closed classification of instrument kinds',
    },
  };
  const sameIri = `${MODULE_IRI}/InstrumentKind`;
  const explicit = {
    schemaVersion: '1.0',
    entries: [{
      authorityKind: 'axioluneOperational',
      publicIri: sameIri,
      upstreamEvidence: [],
    }],
  };
  duplicate.entries[0].codeListIri = sameIri;
  assert.throws(
    () => mergeTermAuthorityOverrides(moduleDocs, explicit, duplicate),
    (error) => error instanceof TermAuthorityError
      && error.errors.some((message) => message.includes('duplicated across')),
  );
});
