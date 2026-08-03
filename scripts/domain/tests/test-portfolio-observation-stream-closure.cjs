#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const {
  PortfolioObservationClosureError,
  recordSetDigest,
  sha256,
  verifyPortfolioObservationStreamClosure,
} = require('../lib/portfolio-observation-stream-closure.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
} = require('../lib/strict-source-locator.cjs');
const {
  extractJsonPointerJcsBytes,
} = require('../lib/json-pointer-source-extractor.cjs');

function pathRef(path) {
  return { kind: 'path', path, root: 'sourceTree' };
}

function refKey(ref) {
  return canonicalJcs(ref);
}

function jcsBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function key(instrument, snapshotId) {
  return {
    accountLogicalIri: 'https://axiolune.ai/data/finance/foundation/financial-account/acme',
    instrumentLogicalIri: `https://axiolune.ai/data/finance/instruments/security/${instrument}`,
    snapshotId,
  };
}

const KEY_A = key('acme', 'ACME-2026-08-01');
const KEY_B = key('beta', 'BETA-2026-08-01');
const KEY_C = key('gamma', 'GAMMA-2026-08-01');

function sourceRecord(recordKey, quantity) {
  return {
    payload: {
      availableFrom: '2026-08-01T00:00:01Z',
      holdingQuantity: quantity,
      holdingQuantityPrecision: quantity.includes('.')
        ? quantity.length - quantity.indexOf('.') - 1
        : 0,
      holdingQuantityRounding: 'half-even',
      holdingQuantityUnit: 'urn:unit:share',
      knowledgeFrom: '2026-08-01T00:00:00Z',
      positionSourceKindIri:
        'https://axiolune.ai/ontology/finance/portfolio-positions/PositionSourceKind/value/externalReported',
      revision: 0,
      validFrom: '2026-08-01T00:00:00Z',
    },
    recordKey: structuredClone(recordKey),
  };
}

function buildFixture(recordPages = [
  [sourceRecord(KEY_A, '10'), sourceRecord(KEY_B, '20')],
  [sourceRecord(KEY_C, '30')],
], options = {}) {
  const artifacts = new Map();
  function put(ref, document) {
    const bytes = jcsBytes(document);
    artifacts.set(refKey(ref), bytes);
    return { artifactDigest: sha256(bytes), artifactRef: ref };
  }
  function putRaw(ref, bytes) {
    const locked = Buffer.from(bytes);
    artifacts.set(refKey(ref), locked);
    return { artifactDigest: sha256(locked), artifactRef: ref };
  }
  function readArtifact(ref) {
    const bytes = artifacts.get(refKey(ref));
    if (!bytes) throw new Error(`missing fixture artifact ${canonicalJcs(ref)}`);
    return bytes;
  }

  const extractorDependencyRef = pathRef('scripts/domain/lib/strict-source-locator.cjs');
  const extractorDependency = putRaw(
    extractorDependencyRef,
    fs.readFileSync(require.resolve('../lib/strict-source-locator.cjs')),
  );
  const extractorImplementationRef = pathRef(
    'scripts/domain/lib/json-pointer-source-extractor.cjs',
  );
  const extractorImplementation = putRaw(
    extractorImplementationRef,
    fs.readFileSync(require.resolve('../lib/json-pointer-source-extractor.cjs')),
  );
  const extractorProfileRef = pathRef('fixtures/portfolio/json-pointer-jcs-profile.json');
  const extractorProfile = put(extractorProfileRef, {
    algorithm: 'rfc6901-select-then-jcs',
    dependencies: [{
      dependencyDigest: extractorDependency.artifactDigest,
      dependencyRef: extractorDependencyRef,
      role: 'canonical-jcs-and-selection-digest',
    }],
    domainTag: 'axiolune-source-selection-v1\0',
    duplicateMemberPolicy: 'reject-decoded-name-duplicates-at-any-depth',
    encoding: 'utf-8-fatal-no-bom',
    extractorStatus: 'executable',
    implementationDigest: extractorImplementation.artifactDigest,
    implementationRef: extractorImplementationRef,
    networkAccess: false,
    numberProfile: 'selected-value-must-satisfy-axiolune-safe-integer-jcs',
    pointerProfile: 'canonical-rfc6901-string-form',
    schemaVersion: '1.0',
    selectionCardinality: 'exactly-one-non-empty-jcs-value',
    unicodePolicy: 'valid-utf8-unicode-scalars-nfc-in-selected-value',
  });

  const sourceContractRef = pathRef('fixtures/portfolio/source-contract.json');
  const sourceContract = put(sourceContractRef, {
    accountScope: 'request-bound',
    completeness: 'complete-snapshot',
    duplicatePolicy: 'reject',
    failurePolicy: 'reject-degraded-partial-or-error',
    kind: 'PortfolioObservationSourceContract',
    ordering: ['accountLogicalIri', 'instrumentLogicalIri', 'snapshotId'],
    paginationMode: 'opaque-immutable-cursor',
    providerIri: 'https://provider.example/party/custodian',
    responseMediaType: 'application/json',
    schemaVersion: '1.0',
    streamLogicalIri: 'https://axiolune.ai/data/finance/portfolio-positions/portfolio-observation-stream/custodian-acme',
    versionIri: 'https://axiolune.ai/data/finance/portfolio-positions/source-contract/custodian-acme/version/1',
    ...(options.sourceContract || {}),
  });

  const snapshotRequestRef = pathRef('fixtures/portfolio/snapshot-request.json');
  const snapshotRequest = put(snapshotRequestRef, {
    accountLogicalIri: KEY_A.accountLogicalIri,
    asOf: '2026-08-01T00:00:02Z',
    initialCursor: null,
    kind: 'PortfolioObservationSnapshotRequest',
    providerIri: 'https://provider.example/party/custodian',
    requestIri: 'urn:axiolune:portfolio-observation-request:test:1',
    schemaVersion: '1.0',
    sourceContractDigest: sourceContract.artifactDigest,
    sourceContractRef,
    sourceContractVersionIri: 'https://axiolune.ai/data/finance/portfolio-positions/source-contract/custodian-acme/version/1',
    streamLogicalIri: 'https://axiolune.ai/data/finance/portfolio-positions/portfolio-observation-stream/custodian-acme',
    streamVersionIri: 'https://axiolune.ai/data/finance/portfolio-positions/portfolio-observation-stream/custodian-acme/version/1',
    ...(options.snapshotRequest || {}),
  });

  const closure = {
    aggregate: null,
    kind: 'PortfolioObservationStreamClosure',
    pages: [],
    request: snapshotRequest,
    schemaVersion: '1.0',
  };

  for (const [pageIndex, records] of recordPages.entries()) {
    const cursor = pageIndex === 0 ? null : `opaque-cursor-${pageIndex}`;
    const nextCursor = pageIndex === recordPages.length - 1
      ? null
      : `opaque-cursor-${pageIndex + 1}`;
    const terminal = nextCursor === null;
    const requestRef = pathRef(`fixtures/portfolio/page-${pageIndex}-request.json`);
    const requestBinding = put(requestRef, {
      accountLogicalIri: KEY_A.accountLogicalIri,
      asOf: '2026-08-01T00:00:02Z',
      cursor,
      kind: 'PortfolioObservationPageRequest',
      pageRequestIri: `urn:axiolune:portfolio-observation-page-request:test:${pageIndex}`,
      providerIri: 'https://provider.example/party/custodian',
      providerSnapshotToken: pageIndex === 0 ? null : 'provider-snapshot-token-1',
      schemaVersion: '1.0',
      snapshotRequestDigest: snapshotRequest.artifactDigest,
      snapshotRequestIri: 'urn:axiolune:portfolio-observation-request:test:1',
      sourceContractVersionIri: 'https://axiolune.ai/data/finance/portfolio-positions/source-contract/custodian-acme/version/1',
      streamLogicalIri: 'https://axiolune.ai/data/finance/portfolio-positions/portfolio-observation-stream/custodian-acme',
      streamVersionIri: 'https://axiolune.ai/data/finance/portfolio-positions/portfolio-observation-stream/custodian-acme/version/1',
    });
    const responseRef = pathRef(`fixtures/portfolio/page-${pageIndex}-response.json`);
    const responseBinding = put(responseRef, {
      accountLogicalIri: KEY_A.accountLogicalIri,
      asOf: '2026-08-01T00:00:02Z',
      cursor,
      kind: 'PortfolioObservationPageResponse',
      nextCursor,
      pageRequestDigest: requestBinding.artifactDigest,
      pageRequestIri: `urn:axiolune:portfolio-observation-page-request:test:${pageIndex}`,
      providerIri: 'https://provider.example/party/custodian',
      providerSnapshotToken: 'provider-snapshot-token-1',
      records: structuredClone(records),
      retrievalStatus: 'success',
      schemaVersion: '1.0',
      snapshotRequestDigest: snapshotRequest.artifactDigest,
      snapshotRequestIri: 'urn:axiolune:portfolio-observation-request:test:1',
      sourceContractVersionIri: 'https://axiolune.ai/data/finance/portfolio-positions/source-contract/custodian-acme/version/1',
      streamLogicalIri: 'https://axiolune.ai/data/finance/portfolio-positions/portfolio-observation-stream/custodian-acme',
      streamVersionIri: 'https://axiolune.ai/data/finance/portfolio-positions/portfolio-observation-stream/custodian-acme/version/1',
      terminal,
    });
    const responseBytes = artifacts.get(refKey(responseRef));
    const orderedRecordKeys = records.map((record) => structuredClone(record.recordKey));
    const rowLocators = records.map((record, recordIndex) => {
      const locator = {
        extractorProfileDigest: extractorProfile.artifactDigest,
        extractorProfileRef,
        kind: 'jsonPointer',
        mediaType: 'application/json',
        path: responseRef.path,
        pointer: `/records/${recordIndex}`,
      };
      const selectedBytes = extractJsonPointerJcsBytes(responseBytes, locator.pointer);
      locator.selectionDigest = computeSelectionDigest(locator, selectedBytes);
      return {
        locatorIri: `urn:axiolune:source-locator:test:page-${pageIndex}:row-${recordIndex}`,
        recordKey: structuredClone(record.recordKey),
        sourceLocator: locator,
      };
    });
    const rowLocatorManifestRef = pathRef(
      `fixtures/portfolio/page-${pageIndex}-row-locators.json`,
    );
    const rowLocatorManifest = put(rowLocatorManifestRef, {
      kind: 'PortfolioObservationRowLocatorManifest',
      responseDigest: responseBinding.artifactDigest,
      responseRef,
      rows: rowLocators,
      schemaVersion: '1.0',
    });
    closure.pages.push({
      cursor,
      nextCursor,
      orderedRecordKeys,
      pageIndex,
      recordCount: records.length,
      recordSetDigest: recordSetDigest(orderedRecordKeys),
      requestDigest: requestBinding.artifactDigest,
      requestRef,
      responseDigest: responseBinding.artifactDigest,
      responseRef,
      rowLocatorManifestDigest: rowLocatorManifest.artifactDigest,
      rowLocatorManifestRef,
      terminal,
    });
  }

  function responseDocument(pageIndex) {
    return JSON.parse(artifacts.get(refKey(closure.pages[pageIndex].responseRef)).toString('utf8'));
  }

  function locatorDocument(pageIndex) {
    return JSON.parse(artifacts.get(
      refKey(closure.pages[pageIndex].rowLocatorManifestRef),
    ).toString('utf8'));
  }

  function resealLocatorManifest(pageIndex, mutate) {
    const page = closure.pages[pageIndex];
    const manifest = locatorDocument(pageIndex);
    mutate(manifest);
    const bytes = jcsBytes(manifest);
    artifacts.set(refKey(page.rowLocatorManifestRef), bytes);
    page.rowLocatorManifestDigest = sha256(bytes);
  }

  function resealPage(pageIndex, mutate, options = {}) {
    const page = closure.pages[pageIndex];
    const response = responseDocument(pageIndex);
    mutate(response);
    const bytes = jcsBytes(response);
    artifacts.set(refKey(page.responseRef), bytes);
    page.responseDigest = sha256(bytes);
    if (options.rebuildDeclaration !== false) {
      page.nextCursor = response.nextCursor;
      page.terminal = response.terminal;
      page.orderedRecordKeys = response.records.map((record) => structuredClone(record.recordKey));
      page.recordCount = response.records.length;
      page.recordSetDigest = recordSetDigest(page.orderedRecordKeys);
      const rows = response.records.map((record, recordIndex) => {
        const locator = {
          extractorProfileDigest: extractorProfile.artifactDigest,
          extractorProfileRef,
          kind: 'jsonPointer',
          mediaType: 'application/json',
          path: page.responseRef.path,
          pointer: `/records/${recordIndex}`,
        };
        const selectedBytes = extractJsonPointerJcsBytes(bytes, locator.pointer);
        locator.selectionDigest = computeSelectionDigest(locator, selectedBytes);
        return {
          locatorIri: `urn:axiolune:source-locator:test:page-${pageIndex}:row-${recordIndex}`,
          recordKey: structuredClone(record.recordKey),
          sourceLocator: locator,
        };
      });
      const manifest = {
        kind: 'PortfolioObservationRowLocatorManifest',
        responseDigest: page.responseDigest,
        responseRef: page.responseRef,
        rows,
        schemaVersion: '1.0',
      };
      const manifestBytes = jcsBytes(manifest);
      artifacts.set(refKey(page.rowLocatorManifestRef), manifestBytes);
      page.rowLocatorManifestDigest = sha256(manifestBytes);
    }
  }

  function rebuildAggregate() {
    const all = closure.pages.flatMap((page, pageIndex) => (
      responseDocument(pageIndex).records.map((record) => record.recordKey)
    ));
    const counts = new Map();
    for (const recordKey of all) {
      const token = canonicalJcs(recordKey);
      counts.set(token, (counts.get(token) || 0) + 1);
    }
    closure.aggregate = {
      duplicateCount: [...counts.values()].reduce(
        (total, count) => total + Math.max(0, count - 1),
        0,
      ),
      pageCount: closure.pages.length,
      recordSetDigest: recordSetDigest(all),
      terminalObserved: closure.pages.some((page) => page.terminal),
      totalRecordCount: all.length,
    };
  }

  rebuildAggregate();
  return {
    artifacts,
    closure,
    readArtifact,
    rebuildAggregate,
    locatorDocument,
    resealLocatorManifest,
    resealPage,
    responseDocument,
  };
}

function verify(fixture) {
  return verifyPortfolioObservationStreamClosure(fixture.closure, {
    readArtifact: fixture.readArtifact,
  });
}

function expectCode(fixture, code) {
  assert.throws(
    () => verify(fixture),
    (error) => error instanceof PortfolioObservationClosureError && error.code === code,
  );
}

test('two-page closure replays exact scope, page chain, set and row byte selections', () => {
  const fixture = buildFixture();
  const result = verify(fixture);
  assert.equal(result.pageCount, 2);
  assert.equal(result.totalRecordCount, 3);
  assert.equal(result.duplicateCount, 0);
  assert.equal(result.terminalObserved, true);
  assert.equal(result.requestIri, 'urn:axiolune:portfolio-observation-request:test:1');
  assert.equal(result.providerIri, 'https://provider.example/party/custodian');
  assert.equal(result.accountLogicalIri, KEY_A.accountLogicalIri);
  assert.deepEqual(result.records[0].record, sourceRecord(KEY_A, '10'));
  assert.deepEqual(result.records[0].payload, sourceRecord(KEY_A, '10').payload);
  assert.match(result.records[0].selectionDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('logical identities cannot substitute for exact stream or source-contract versions', () => {
  const streamLogicalIri =
    'https://axiolune.ai/data/finance/portfolio-positions/portfolio-observation-stream/custodian-acme';
  expectCode(buildFixture(undefined, {
    snapshotRequest: { streamVersionIri: streamLogicalIri },
  }), 'PORTFOLIO_CLOSURE_VERSION');

  const sourceContractLogicalIri =
    'https://axiolune.ai/data/finance/portfolio-positions/source-contract/custodian-acme';
  expectCode(buildFixture(undefined, {
    sourceContract: { versionIri: sourceContractLogicalIri },
    snapshotRequest: { sourceContractVersionIri: sourceContractLogicalIri },
  }), 'PORTFOLIO_CLOSURE_VERSION');
});

test('one terminal empty page is a complete empty snapshot', () => {
  const fixture = buildFixture([[]]);
  const result = verify(fixture);
  assert.equal(result.pageCount, 1);
  assert.equal(result.totalRecordCount, 0);
  assert.equal(result.recordSetDigest, recordSetDigest([]));
});

test('raw response-byte drift is rejected by the response artifact digest', () => {
  const fixture = buildFixture();
  const page = fixture.closure.pages[0];
  fixture.artifacts.set(refKey(page.responseRef), Buffer.from('{}', 'utf8'));
  expectCode(fixture, 'PORTFOLIO_CLOSURE_DIGEST');
});

test('coherently re-digested provider/scope substitution is rejected semantically', () => {
  const fixture = buildFixture();
  fixture.resealPage(0, (response) => {
    response.providerIri = 'https://provider.example/party/attacker';
  });
  fixture.rebuildAggregate();
  expectCode(fixture, 'PORTFOLIO_CLOSURE_SCOPE');
});

test('degraded or partial retrieval cannot masquerade as a complete empty or non-empty snapshot', () => {
  for (const retrievalStatus of ['degraded', 'partial', 'failed', 'stale-cache']) {
    const fixture = buildFixture();
    fixture.resealPage(0, (response) => {
      response.retrievalStatus = retrievalStatus;
    });
    fixture.rebuildAggregate();
    expectCode(fixture, 'PORTFOLIO_CLOSURE_INCOMPLETE');
  }
});

test('pages from different provider snapshot tokens cannot be combined', () => {
  const fixture = buildFixture();
  fixture.resealPage(1, (response) => {
    response.providerSnapshotToken = 'provider-snapshot-token-2';
  });
  fixture.rebuildAggregate();
  expectCode(fixture, 'PORTFOLIO_CLOSURE_SNAPSHOT');
});

test('a coherently bound source contract cannot weaken completeness or duplicate policy', () => {
  for (const sourceContract of [
    { completeness: 'best-effort' },
    { duplicatePolicy: 'allow' },
    { paginationMode: 'untracked-pages' },
  ]) {
    const fixture = buildFixture(undefined, { sourceContract });
    expectCode(fixture, 'PORTFOLIO_CLOSURE_CONTRACT');
  }
});

test('a next cursor without its locked page is rejected as an incomplete traversal', () => {
  const fixture = buildFixture();
  fixture.closure.pages.pop();
  expectCode(fixture, 'PORTFOLIO_CLOSURE_MISSING_PAGE');
});

test('a response record omitted from row locators is rejected', () => {
  const fixture = buildFixture();
  fixture.resealLocatorManifest(0, (manifest) => manifest.rows.pop());
  expectCode(fixture, 'PORTFOLIO_CLOSURE_OMISSION');
});

test('a response record omitted from declared ordered keys/count is rejected', () => {
  const fixture = buildFixture();
  fixture.closure.pages[0].orderedRecordKeys.pop();
  fixture.closure.pages[0].recordCount -= 1;
  expectCode(fixture, 'PORTFOLIO_CLOSURE_OMISSION');
});

test('a coherently re-sealed duplicate key is rejected by duplicatePolicy=reject', () => {
  const fixture = buildFixture();
  fixture.resealPage(1, (response) => {
    response.records[0].recordKey = structuredClone(KEY_B);
  });
  fixture.rebuildAggregate();
  expectCode(fixture, 'PORTFOLIO_CLOSURE_DUPLICATE_RECORD');
});

test('a coherently re-sealed cursor cycle is rejected', () => {
  const fixture = buildFixture();
  fixture.resealPage(1, (response) => {
    response.nextCursor = 'opaque-cursor-1';
    response.terminal = false;
  });
  fixture.rebuildAggregate();
  expectCode(fixture, 'PORTFOLIO_CLOSURE_CURSOR_CYCLE');
});

test('globally out-of-order records are rejected even with coherent page and set digests', () => {
  const fixture = buildFixture([
    [sourceRecord(KEY_B, '20'), sourceRecord(KEY_A, '10')],
    [sourceRecord(KEY_C, '30')],
  ]);
  expectCode(fixture, 'PORTFOLIO_CLOSURE_ORDER');
});

test('page record-set digest drift is rejected', () => {
  const fixture = buildFixture();
  fixture.closure.pages[0].recordSetDigest = `sha256:${'0'.repeat(64)}`;
  expectCode(fixture, 'PORTFOLIO_CLOSURE_SET_DIGEST');
});

test('aggregate page/count/set/duplicate/terminal drift is rejected', () => {
  for (const mutate of [
    (aggregate) => { aggregate.pageCount += 1; },
    (aggregate) => { aggregate.totalRecordCount += 1; },
    (aggregate) => { aggregate.recordSetDigest = `sha256:${'0'.repeat(64)}`; },
    (aggregate) => { aggregate.duplicateCount += 1; },
    (aggregate) => { aggregate.terminalObserved = false; },
  ]) {
    const fixture = buildFixture();
    mutate(fixture.closure.aggregate);
    expectCode(fixture, 'PORTFOLIO_CLOSURE_AGGREGATE');
  }
});

test('a locator cannot select a different response ordinal even with a recomputed selection digest', () => {
  const fixture = buildFixture();
  const page = fixture.closure.pages[0];
  fixture.resealLocatorManifest(0, (manifest) => {
    const locator = manifest.rows[0].sourceLocator;
    locator.pointer = '/records/1';
    const responseBytes = fixture.artifacts.get(refKey(page.responseRef));
    locator.selectionDigest = computeSelectionDigest(
      locator,
      extractJsonPointerJcsBytes(responseBytes, locator.pointer),
    );
  });
  expectCode(fixture, 'PORTFOLIO_CLOSURE_LOCATOR');
});

test('a row selection digest that does not bind selected JCS bytes is rejected', () => {
  const fixture = buildFixture();
  fixture.resealLocatorManifest(0, (manifest) => {
    manifest.rows[0].sourceLocator.selectionDigest = `sha256:${'0'.repeat(64)}`;
  });
  expectCode(fixture, 'PORTFOLIO_CLOSURE_LOCATOR');
});

test('a locator path cannot substitute a different response artifact', () => {
  const fixture = buildFixture();
  fixture.resealLocatorManifest(0, (manifest) => {
    manifest.rows[0].sourceLocator.path = fixture.closure.pages[1].responseRef.path;
  });
  expectCode(fixture, 'PORTFOLIO_CLOSURE_LOCATOR');
});

test('an unreachable extra page is rejected instead of being counted as completeness evidence', () => {
  const fixture = buildFixture();
  const orphan = structuredClone(fixture.closure.pages[1]);
  orphan.pageIndex = 2;
  orphan.cursor = 'orphan-cursor';
  fixture.closure.pages.push(orphan);
  fixture.closure.aggregate.pageCount = 3;
  expectCode(fixture, 'PORTFOLIO_CLOSURE_EXTRA_PAGE');
});

test('terminal=true is equivalent to nextCursor=null and cannot be forged independently', () => {
  const fixture = buildFixture();
  fixture.resealPage(1, (response) => {
    response.terminal = false;
  });
  fixture.rebuildAggregate();
  expectCode(fixture, 'PORTFOLIO_CLOSURE_TERMINAL');
});

test('extractor profile bytes and algorithm are digest-locked and executable', () => {
  const fixture = buildFixture();
  const locator = fixture.locatorDocument(0).rows[0].sourceLocator;
  const profileBytes = fixture.artifacts.get(refKey(locator.extractorProfileRef));
  const profile = JSON.parse(profileBytes.toString('utf8'));
  profile.algorithm = 'trust-declared-record';
  const changed = jcsBytes(profile);
  fixture.artifacts.set(refKey(locator.extractorProfileRef), changed);
  for (const [pageIndex, page] of fixture.closure.pages.entries()) {
    fixture.resealLocatorManifest(pageIndex, (manifest) => {
      for (const row of manifest.rows) {
        row.sourceLocator.extractorProfileDigest = sha256(changed);
        const responseBytes = fixture.artifacts.get(refKey(page.responseRef));
        row.sourceLocator.selectionDigest = computeSelectionDigest(
          row.sourceLocator,
          extractJsonPointerJcsBytes(responseBytes, row.sourceLocator.pointer),
        );
      }
    });
  }
  expectCode(fixture, 'PORTFOLIO_CLOSURE_LOCATOR_PROFILE');
});

test('same-digest bytes at an arbitrary path cannot impersonate the executed extractor runtime', () => {
  const fixture = buildFixture();
  const locator = fixture.locatorDocument(0).rows[0].sourceLocator;
  const profileBytes = fixture.artifacts.get(refKey(locator.extractorProfileRef));
  const profile = JSON.parse(profileBytes.toString('utf8'));
  const fakeRef = pathRef('fixtures/portfolio/lookalike-json-pointer-source-extractor.cjs');
  fixture.artifacts.set(
    refKey(fakeRef),
    Buffer.from(fixture.artifacts.get(refKey(profile.implementationRef))),
  );
  profile.implementationRef = fakeRef;
  const changed = jcsBytes(profile);
  fixture.artifacts.set(refKey(locator.extractorProfileRef), changed);
  for (const [pageIndex, page] of fixture.closure.pages.entries()) {
    fixture.resealLocatorManifest(pageIndex, (manifest) => {
      for (const row of manifest.rows) {
        row.sourceLocator.extractorProfileDigest = sha256(changed);
        const responseBytes = fixture.artifacts.get(refKey(page.responseRef));
        row.sourceLocator.selectionDigest = computeSelectionDigest(
          row.sourceLocator,
          extractJsonPointerJcsBytes(responseBytes, row.sourceLocator.pointer),
        );
      }
    });
  }
  expectCode(fixture, 'PORTFOLIO_CLOSURE_LOCATOR_PROFILE');
});
