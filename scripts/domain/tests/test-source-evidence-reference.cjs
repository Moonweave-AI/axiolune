#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CODE_LIST_AUTHORITY_LOCAL_PATH,
  CODE_LIST_AUTHORITY_REFERENCE_ID,
  CODE_LIST_AUTHORITY_REFERENCE_IRI,
  buildCodeListAuthorityIndex,
  buildReferenceEvidenceIndex,
  digestCandidate,
  validateLockedSourceEvidenceRef,
} = require('../lib/source-evidence-reference.cjs');

const VALID_DIGEST = `sha256:${'1'.repeat(64)}`;
const WHOLE_FILE_PROFILE = {
  kind: 'path',
  root: 'sourceTree',
  path: 'scripts/domain/reference-extractors/whole-file-v1.json',
};

function locator(path = 'evidence.txt', mediaType = 'text/plain') {
  return {
    kind: 'wholeFile',
    path,
    mediaType,
    extractorProfileRef: WHOLE_FILE_PROFILE,
    extractorProfileDigest: VALID_DIGEST,
    selectionDigest: VALID_DIGEST,
  };
}

function reference(id, overrides = {}) {
  return {
    id,
    artifactDigest: VALID_DIGEST,
    locators: [locator()],
    ...overrides,
  };
}

function codeList() {
  return {
    iri: 'https://axiolune.ai/ontology/finance/test/State',
    version: '0.3.0',
    sourceEvidenceRef: CODE_LIST_AUTHORITY_REFERENCE_IRI,
    values: [
      {
        iri: 'https://axiolune.ai/ontology/finance/test/State/value/closed',
        notation: 'closed',
        label: 'Closed',
        definition: 'A terminal state in the exact adopted fixture vocabulary.',
      },
      {
        iri: 'https://axiolune.ai/ontology/finance/test/State/value/open',
        notation: 'open',
        label: 'Open',
        definition: 'A non-terminal state in the exact adopted fixture vocabulary.',
      },
    ],
  };
}

function authorityManifest(codeListValue, decision = 'pending') {
  const entries = [{
    authorityKind: 'axioluneOperational',
    codeListIri: codeListValue.iri,
    codeListName: 'State',
    members: structuredClone(codeListValue.values),
    moduleId: 'test',
    rationale: 'The exact member set is an Axiolune runtime interoperability contract.',
    sourceEvidenceRef: codeListValue.sourceEvidenceRef,
    upstreamEvidence: [],
    version: codeListValue.version,
  }];
  const candidateDigest = digestCandidate(
    'https://axiolune.ai/conformance/m2/0.3.0',
    '0.3.0',
    entries,
  );
  let decisionEnvelope = { status: 'pending' };
  if (decision === 'reviewed') {
    decisionEnvelope = {
      candidateDigest,
      decisionTime: '2026-07-31T00:00:00Z',
      rationale: 'The reviewer checked the exact candidate digest and its source boundaries.',
      reviewBasisRefs: ['https://axiolune.ai/reviews/test-code-list-authority'],
      reviewerRef: 'https://axiolune.ai/principals/test-reviewer',
      status: 'reviewed',
    };
  } else if (decision === 'adopted') {
    decisionEnvelope = {
      candidateDigest,
      decisionTime: '2026-07-31T00:00:00Z',
      driRef: 'https://axiolune.ai/principals/test-dri',
      rationale: 'The DRI reviewed and adopted the exact candidate digest.',
      reviewBasisRefs: ['https://axiolune.ai/reviews/test-code-list-authority'],
      status: 'adopted',
    };
  }
  const manifest = {
    candidateDigest,
    decision: decisionEnvelope,
    entries,
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    schemaVersion: '1.0',
    snapshotVersion: '0.3.0',
  };
  return manifest;
}

function rebindCandidate(manifest) {
  manifest.candidateDigest = digestCandidate(
    manifest.profileRef,
    manifest.snapshotVersion,
    manifest.entries,
  );
  if (['reviewed', 'adopted'].includes(manifest.decision?.status)) {
    manifest.decision.candidateDigest = manifest.candidateDigest;
  }
}

test('an exact canonical IRI resolves one locked, located artifact', () => {
  const { entries, errors } = buildReferenceEvidenceIndex({
    references: [reference('locked-source')],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    validateLockedSourceEvidenceRef(
      'https://axiolune.ai/references/locked-source',
      entries,
    ),
    [],
  );
});

test('pending, arbitrary, orphan and unavailable evidence fail closed', () => {
  const { entries } = buildReferenceEvidenceIndex({
    references: [
      reference('paywalled', { artifactDigest: 'sha256:unavailable-paywalled', locators: [] }),
      reference('no-locator', { locators: [] }),
    ],
  });
  const cases = [
    'https://axiolune.ai/pending-source-evidence/module/List',
    'https://example.test/evidence',
    'https://axiolune.ai/references/missing',
    'https://axiolune.ai/references/paywalled',
    'https://axiolune.ai/references/no-locator',
  ];
  for (const value of cases) {
    assert.notDeepEqual(validateLockedSourceEvidenceRef(value, entries), [], value);
  }
});

test('a non-empty but malformed locked locator does not close source evidence', () => {
  const { entries } = buildReferenceEvidenceIndex({
    references: [reference('malformed-locator', {
      locators: [{ kind: 'wholeFile', path: 'evidence.txt' }],
    })],
  });
  assert.match(
    validateLockedSourceEvidenceRef(
      'https://axiolune.ai/references/malformed-locator',
      entries,
    ).join('\n'),
    /invalid locked SourceLocator/u,
  );
});

test('duplicate and malformed lock identifiers do not become resolvable aliases', () => {
  const { entries, errors } = buildReferenceEvidenceIndex({
    references: [
      reference('same'),
      reference('same'),
      reference('contains/slash'),
    ],
  });
  assert.equal(entries.size, 1);
  assert.equal(errors.length, 2);
});

test('a broad lock record cannot authorize an arbitrary code list without a reviewed member snapshot', () => {
  const list = codeList();
  const { entries } = buildReferenceEvidenceIndex({
    references: [reference(CODE_LIST_AUTHORITY_REFERENCE_ID, {
      localPath: CODE_LIST_AUTHORITY_LOCAL_PATH,
      locators: [locator('m2-v0.3-code-lists.json', 'application/json')],
    })],
  });
  const result = validateLockedSourceEvidenceRef(
    list.sourceEvidenceRef,
    entries,
    {
      authorityState: {
        entries: new Map(),
        decisionStatus: 'missing',
      },
      codeList: list,
      codeListName: 'State',
      moduleId: 'test',
    },
  );
  assert.ok(result.some((message) => /authority manifest|authority entry/u.test(message)));
});

test('a repository-edited adopted snapshot cannot close code-list evidence', () => {
  const list = codeList();
  const { entries } = buildReferenceEvidenceIndex({
    references: [reference(CODE_LIST_AUTHORITY_REFERENCE_ID, {
      localPath: CODE_LIST_AUTHORITY_LOCAL_PATH,
      locators: [locator('m2-v0.3-code-lists.json', 'application/json')],
    })],
  });
  const authorityState = buildCodeListAuthorityIndex(
    authorityManifest(list, 'adopted'),
    entries,
  );
  assert.match(
    authorityState.errors.join('\n'),
    /terminal authority adoption is unavailable|repository-edited adopted JSON/u,
  );
  assert.match(
    validateLockedSourceEvidenceRef(
      list.sourceEvidenceRef,
      entries,
      {
        authorityState,
        codeList: list,
        codeListName: 'State',
        moduleId: 'test',
      },
    ).join('\n'),
    /authority manifest is invalid/u,
  );
});

test('pending review and exact member drift both fail closed', () => {
  const list = codeList();
  const { entries } = buildReferenceEvidenceIndex({
    references: [reference(CODE_LIST_AUTHORITY_REFERENCE_ID, {
      localPath: CODE_LIST_AUTHORITY_LOCAL_PATH,
      locators: [locator('m2-v0.3-code-lists.json', 'application/json')],
    })],
  });
  const pendingState = buildCodeListAuthorityIndex(
    authorityManifest(list, 'pending'),
    entries,
  );
  assert.ok(validateLockedSourceEvidenceRef(
    list.sourceEvidenceRef,
    entries,
    {
      authorityState: pendingState,
      codeList: list,
      codeListName: 'State',
      moduleId: 'test',
    },
  ).some((message) => /not semantically reviewed/u.test(message)));

  const reviewedState = buildCodeListAuthorityIndex(
    authorityManifest(list, 'reviewed'),
    entries,
  );
  assert.deepEqual(reviewedState.errors, []);
  assert.equal(reviewedState.decisionStatus, 'reviewed');
  const drifted = structuredClone(list);
  drifted.values[0].definition = 'Silently changed after semantic review.';
  assert.ok(validateLockedSourceEvidenceRef(
    drifted.sourceEvidenceRef,
    entries,
    {
      authorityState: reviewedState,
      codeList: drifted,
      codeListName: 'State',
      moduleId: 'test',
    },
  ).some((message) => /do not equal/u.test(message)));
});

test('a reviewed decision cannot be replayed for a replacement candidate', () => {
  const list = codeList();
  const { entries } = buildReferenceEvidenceIndex({
    references: [reference(CODE_LIST_AUTHORITY_REFERENCE_ID, {
      localPath: CODE_LIST_AUTHORITY_LOCAL_PATH,
      locators: [locator('m2-v0.3-code-lists.json', 'application/json')],
    })],
  });

  const unboundLegacyDecision = authorityManifest(list, 'reviewed');
  delete unboundLegacyDecision.decision.candidateDigest;
  assert.match(
    buildCodeListAuthorityIndex(unboundLegacyDecision, entries).errors.join('\n'),
    /decision reviewed fields must equal candidateDigest/u,
  );

  const replacedCandidate = authorityManifest(list, 'reviewed');
  const reviewedDigest = replacedCandidate.decision.candidateDigest;
  replacedCandidate.entries[0].members[0].definition =
    'A replacement candidate whose semantic bytes changed after the old adoption.';
  replacedCandidate.candidateDigest = digestCandidate(
    replacedCandidate.profileRef,
    replacedCandidate.snapshotVersion,
    replacedCandidate.entries,
  );
  assert.notEqual(replacedCandidate.candidateDigest, reviewedDigest);
  assert.match(
    buildCodeListAuthorityIndex(replacedCandidate, entries).errors.join('\n'),
    /decision\.candidateDigest must equal the exact current candidate digest/u,
  );

  const detachedApproval = authorityManifest(list, 'reviewed');
  detachedApproval.decision.candidateDigest = `sha256:${'0'.repeat(64)}`;
  assert.match(
    buildCodeListAuthorityIndex(detachedApproval, entries).errors.join('\n'),
    /decision\.candidateDigest must equal the exact current candidate digest/u,
  );
});

test('authority IRIs reject control characters and non-NFC aliases', () => {
  const list = codeList();
  const { entries } = buildReferenceEvidenceIndex({
    references: [reference(CODE_LIST_AUTHORITY_REFERENCE_ID, {
      localPath: CODE_LIST_AUTHORITY_LOCAL_PATH,
      locators: [locator('m2-v0.3-code-lists.json', 'application/json')],
    })],
  });

  const controlled = authorityManifest(list, 'reviewed');
  controlled.decision.reviewerRef = 'https://axiolune.ai/principals/test-reviewer\u007fhidden';
  assert.ok(buildCodeListAuthorityIndex(controlled, entries).errors.some(
    (message) => /decision\.reviewerRef/u.test(message),
  ));

  const nonNfc = authorityManifest(list);
  nonNfc.entries[0].members[0].iri =
    'https://axiolune.ai/ontology/finance/test/State/value/cafe\u0301';
  assert.ok(buildCodeListAuthorityIndex(nonNfc, entries).errors.some(
    (message) => /members\[0\]\.iri/u.test(message),
  ));
});

test('authority member text is canonical and member notation is unique', () => {
  const list = codeList();
  const { entries } = buildReferenceEvidenceIndex({
    references: [reference(CODE_LIST_AUTHORITY_REFERENCE_ID, {
      localPath: CODE_LIST_AUTHORITY_LOCAL_PATH,
      locators: [locator('m2-v0.3-code-lists.json', 'application/json')],
    })],
  });

  const controlledNotation = authorityManifest(list);
  controlledNotation.entries[0].members[0].notation = 'closed\u0001';
  rebindCandidate(controlledNotation);
  assert.ok(buildCodeListAuthorityIndex(controlledNotation, entries).errors.some(
    (message) => /members\[0\]\.notation must be non-empty NFC text/u.test(message),
  ));

  const nonNfcLabel = authorityManifest(list);
  nonNfcLabel.entries[0].members[0].label = 'Cafe\u0301';
  assert.ok(buildCodeListAuthorityIndex(nonNfcLabel, entries).errors.some(
    (message) => /members\[0\]\.label must be non-empty NFC text/u.test(message),
  ));

  const duplicateNotation = authorityManifest(list);
  duplicateNotation.entries[0].members[1].notation =
    duplicateNotation.entries[0].members[0].notation;
  rebindCandidate(duplicateNotation);
  assert.ok(buildCodeListAuthorityIndex(duplicateNotation, entries).errors.some(
    (message) => /notation is duplicated within the code list/u.test(message),
  ));
});

test('authority upstream evidence must reuse a byte-identical locked locator', () => {
  const list = codeList();
  const { entries } = buildReferenceEvidenceIndex({
    references: [
      reference(CODE_LIST_AUTHORITY_REFERENCE_ID, {
        localPath: CODE_LIST_AUTHORITY_LOCAL_PATH,
        locators: [locator('m2-v0.3-code-lists.json', 'application/json')],
      }),
      reference('upstream'),
    ],
  });
  const manifest = authorityManifest(list);
  manifest.entries[0].authorityKind = 'implementationAdopted';
  manifest.entries[0].upstreamEvidence = [{
    locator: { kind: 'wholeFile', path: 'different.txt' },
    rationale: 'A deliberately wrong locator must not join by reference ID alone.',
    referenceId: 'upstream',
    transformation: 'caseNormalizedSubset',
    usage: 'implementation',
  }];
  rebindCandidate(manifest);
  const state = buildCodeListAuthorityIndex(manifest, entries);
  assert.ok(state.errors.some((message) => /not byte-identical/u.test(message)));
});

test('externalExact cannot relabel local members as exact external identities', () => {
  const list = codeList();
  const upstreamLocator = {
    ...locator('vocabulary.rdf', 'application/rdf+xml'),
    kind: 'rdfResource',
    resourceIri: 'https://external.example/vocabulary/closed',
  };
  const { entries } = buildReferenceEvidenceIndex({
    references: [
      reference(CODE_LIST_AUTHORITY_REFERENCE_ID, {
        localPath: CODE_LIST_AUTHORITY_LOCAL_PATH,
        locators: [locator('m2-v0.3-code-lists.json', 'application/json')],
      }),
      reference('external-vocabulary', { locators: [upstreamLocator] }),
    ],
  });
  const manifest = authorityManifest(list, 'pending');
  manifest.entries[0].authorityKind = 'externalExact';
  manifest.entries[0].upstreamEvidence = [{
    locator: upstreamLocator,
    rationale: 'The external resource deliberately has a different identity from the local member.',
    referenceId: 'external-vocabulary',
    transformation: 'exactIdentity',
    usage: 'normative',
  }];
  rebindCandidate(manifest);
  assert.match(
    buildCodeListAuthorityIndex(manifest, entries).errors.join('\n'),
    /resourceIri equals each authored member IRI/u,
  );
});

test('project implementations are context-only and cannot become canonical vocabulary authority', () => {
  const list = codeList();
  const upstreamLocator = locator('implementation-enums.rs', 'text/x-rust');
  const { entries } = buildReferenceEvidenceIndex({
    references: [
      reference(CODE_LIST_AUTHORITY_REFERENCE_ID, {
        localPath: CODE_LIST_AUTHORITY_LOCAL_PATH,
        locators: [locator('m2-v0.3-code-lists.json', 'application/json')],
      }),
      reference('project-implementation', {
        localPath: 'reference/project-reference/example-engine',
        locators: [upstreamLocator],
      }),
    ],
  });

  function policyErrors(authorityKind, usage, transformation) {
    const manifest = authorityManifest(list);
    manifest.entries[0].authorityKind = authorityKind;
    manifest.entries[0].upstreamEvidence = [{
      locator: upstreamLocator,
      rationale: 'locked project source is secondary behavioral context only',
      referenceId: 'project-implementation',
      transformation,
      usage,
    }];
    rebindCandidate(manifest);
    return buildCodeListAuthorityIndex(manifest, entries).errors;
  }

  assert.match(
    policyErrors('implementationAdopted', 'implementation', 'contextOnly').join('\n'),
    /implementationAdopted authority is prohibited/u,
  );
  assert.match(
    policyErrors('axioluneOperational', 'implementation', 'caseNormalizedSubset').join('\n'),
    /implementation evidence must use transformation=contextOnly/u,
  );
  assert.match(
    policyErrors('axioluneOperational', 'normative', 'exactIdentity').join('\n'),
    /project-reference evidence must be implementation\/contextOnly/u,
  );
  assert.deepEqual(
    policyErrors('axioluneOperational', 'implementation', 'contextOnly'),
    [],
  );
});

test('authority rejects malformed locators and non-UTC or impossible adoption instants', () => {
  const list = codeList();
  const { entries } = buildReferenceEvidenceIndex({
    references: [
      reference(CODE_LIST_AUTHORITY_REFERENCE_ID, {
        localPath: CODE_LIST_AUTHORITY_LOCAL_PATH,
        locators: [locator('m2-v0.3-code-lists.json', 'application/json')],
      }),
      reference('upstream', {
        locators: [{ kind: 'wholeFile', path: 'evidence.txt' }],
      }),
    ],
  });
  const malformed = authorityManifest(list);
  malformed.entries[0].authorityKind = 'implementationAdopted';
  malformed.entries[0].upstreamEvidence = [{
    locator: { kind: 'wholeFile', path: 'evidence.txt' },
    rationale: 'The byte-identical locked locator is deliberately structurally incomplete.',
    referenceId: 'upstream',
    transformation: 'exactIdentity',
    usage: 'implementation',
  }];
  rebindCandidate(malformed);
  assert.ok(
    buildCodeListAuthorityIndex(malformed, entries).errors
      .some((message) => /missing required field/u.test(message)),
  );

  for (const invalid of [
    '2026-07-31T00:00:00+00:00',
    '2026-07-31T00:00:00.000Z',
    '2026-02-31T00:00:00Z',
  ]) {
    const invalidDecision = authorityManifest(list, 'reviewed');
    invalidDecision.decision.decisionTime = invalid;
    const invalidState = buildCodeListAuthorityIndex(invalidDecision, entries);
    assert.ok(
      invalidState.errors.some((message) => /whole-second UTC instant/u.test(message)),
      invalid,
    );
    assert.match(
      validateLockedSourceEvidenceRef(
        list.sourceEvidenceRef,
        entries,
        {
          authorityState: invalidState,
          codeList: list,
          codeListName: 'State',
          moduleId: 'test',
        },
      ).join('\n'),
      /authority manifest is invalid/u,
      invalid,
    );
  }
});
