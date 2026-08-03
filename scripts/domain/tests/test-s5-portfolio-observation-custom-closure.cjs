#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const {
  MARKET_GRAPH_IRI,
  materializeHistoricalDataset,
} = require('../lib/s5-canonical-materialization.cjs');
const {
  recordSetDigest,
} = require('../lib/portfolio-observation-stream-closure.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
} = require('../lib/strict-source-locator.cjs');

const ROOT = path.join(__dirname, '..', '..', '..');
const SOURCE_REL = 'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source';
const SOURCE = path.join(ROOT, ...SOURCE_REL.split('/'));
const SUPPORT = path.join(SOURCE, 'prior-support', 'dataset.nq');
const CLOSURE_REL = `${SOURCE_REL}/portfolio-observation-closure.json`;
const PAGE_1_RESPONSE_REL = `${SOURCE_REL}/portfolio-observation-page-1-response.json`;
const PAGE_1_LOCATORS_REL = `${SOURCE_REL}/portfolio-observation-page-1-row-locators.json`;
const PAGE_2_RESPONSE_REL = `${SOURCE_REL}/portfolio-observation-page-2-response.json`;
const PAGE_2_LOCATORS_REL = `${SOURCE_REL}/portfolio-observation-page-2-row-locators.json`;
const CUSTOM_MODULE_RELS = Object.freeze([
  'ontology/domain/finance/foundation/module.yaml',
  'ontology/domain/finance/instruments/module.yaml',
  'ontology/domain/finance/market-data/module.yaml',
  'ontology/domain/finance/market-structure/module.yaml',
  'ontology/domain/finance/portfolio-positions/module.yaml',
]);
const CUSTOM_GENERATING_CONTEXTS = Object.freeze([
  'urn:axiolune:run:slice-a:identity:v1',
  'urn:axiolune:run:slice-a:instrument-input-context:v1',
  'urn:axiolune:run:slice-a:market-data:v1',
  'urn:axiolune:run:slice-a:market-structure-input-context:v1',
  'urn:axiolune:run:slice-a:portfolio-input-context:v1',
  'urn:axiolune:run:slice-a:portfolio-valuation:v1',
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sourceFile(relativePath) {
  return path.join(ROOT, ...relativePath.split('/'));
}

function jcsBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function baselineMaterialization() {
  const rows = readJson(path.join(
    ROOT,
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source-snapshot-original.json',
  )).rows;
  return materializeHistoricalDataset(
    rows,
    'urn:axiolune:run:slice-a:identity:v1',
    'urn:axiolune:run:slice-a:market-data:v1',
    'urn:axiolune:run:slice-a:portfolio-valuation:v1',
    'urn:axiolune:run:slice-a:batch:v1',
    {
      valuationPolicyArtifacts: {
        precisionBytes: fs.readFileSync(path.join(SOURCE, 'valuation-precision-policy.json')),
        roundingBytes: fs.readFileSync(path.join(SOURCE, 'valuation-rounding-policy.json')),
      },
    },
  );
}

function lockedEvidenceArtifacts() {
  return readJson(path.join(SOURCE, 'support-evidence-closure.json')).entries.map((entry) => ({
    artifactDigest: entry.artifactDigest,
    artifactRef: structuredClone(entry.artifactRef),
    evidenceIri: entry.evidenceIri,
    evidenceKind: entry.evidenceKind,
    file: sourceFile(entry.artifactRef.path),
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.evidenceIri, 'utf8'),
    Buffer.from(right.evidenceIri, 'utf8'),
  ));
}

function evidenceByPath(artifacts, relativePath) {
  const matches = artifacts.filter((entry) => entry.artifactRef.path === relativePath);
  assert.equal(matches.length, 1, `expected one locked artifact for ${relativePath}`);
  return matches[0];
}

function replaceArtifact(artifacts, relativePath, value, directory) {
  const row = evidenceByPath(artifacts, relativePath);
  const bytes = jcsBytes(value);
  const file = path.join(directory, path.basename(relativePath));
  fs.writeFileSync(file, bytes);
  const oldDigest = row.artifactDigest;
  row.artifactDigest = sha256(bytes);
  row.file = file;
  return { newDigest: row.artifactDigest, oldDigest };
}

function replaceDigest(nquads, oldDigest, newDigest, label) {
  const occurrences = nquads.split(oldDigest).length - 1;
  assert.ok(occurrences > 0, `${label} digest is absent from materialized RDF`);
  return nquads.split(oldDigest).join(newDigest);
}

function runWorker(
  artifacts,
  dataNQuads,
  supportNQuads = fs.readFileSync(SUPPORT, 'utf8'),
) {
  return spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/domain/lib/s5-materialized-custom-worker.cjs')],
    {
      cwd: ROOT,
      encoding: 'utf8',
      input: canonicalJcs({
        allowedGeneratingContextIris: [...CUSTOM_GENERATING_CONTEXTS].sort(),
        asOfAvailable: '2024-07-10T00:00:00Z',
        asOfKnowledge: '2024-07-10T00:00:00Z',
        asOfValid: '2024-07-10T00:00:00Z',
        dataNQuads,
        lockedEvidenceArtifacts: artifacts,
        moduleSourcePaths: CUSTOM_MODULE_RELS.map(sourceFile),
        referenceTime: '2024-07-10T00:00:02Z',
        schemaVersion: '1.0',
        supportNQuads,
        targetGraphIri: MARKET_GRAPH_IRI,
      }),
      shell: false,
      timeout: 60 * 1000,
      windowsHide: true,
    },
  );
}

function withMutation(name, mutate, expectedCode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `axiolune-${name}-`));
  try {
    const artifacts = lockedEvidenceArtifacts();
    const materialized = baselineMaterialization();
    const state = {
      artifacts,
      dataNQuads: materialized.nquads,
      directory,
      supportNQuads: fs.readFileSync(SUPPORT, 'utf8'),
    };
    mutate(state);
    const result = runWorker(artifacts, state.dataNQuads, state.supportNQuads);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /S5_CUSTOM_/u);
    assert.match(result.stderr, new RegExp(expectedCode, 'u'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function resealClosure(state, closure) {
  const changed = replaceArtifact(
    state.artifacts,
    CLOSURE_REL,
    closure,
    state.directory,
  );
  state.supportNQuads = replaceDigest(
    state.supportNQuads,
    changed.oldDigest,
    changed.newDigest,
    'portfolio observation closure',
  );
}

function resealPage1Payload(state, mutatePayload) {
  const closure = readJson(sourceFile(CLOSURE_REL));
  const page1 = readJson(sourceFile(PAGE_1_RESPONSE_REL));
  mutatePayload(page1.records[0].payload);
  const responseChange = replaceArtifact(
    state.artifacts,
    PAGE_1_RESPONSE_REL,
    page1,
    state.directory,
  );
  const locatorManifest = readJson(sourceFile(PAGE_1_LOCATORS_REL));
  locatorManifest.responseDigest = responseChange.newDigest;
  const locator = locatorManifest.rows[0].sourceLocator;
  delete locator.selectionDigest;
  locator.selectionDigest = computeSelectionDigest(locator, jcsBytes(page1.records[0]));
  const locatorChange = replaceArtifact(
    state.artifacts,
    PAGE_1_LOCATORS_REL,
    locatorManifest,
    state.directory,
  );
  closure.pages[0].responseDigest = responseChange.newDigest;
  closure.pages[0].rowLocatorManifestDigest = locatorChange.newDigest;
  state.dataNQuads = replaceDigest(
    state.dataNQuads,
    responseChange.oldDigest,
    responseChange.newDigest,
    'Holding page response',
  );
  resealClosure(state, closure);
}

test('Custom worker accepts the fully byte-locked two-page portfolio observation closure', () => {
  const result = runWorker(lockedEvidenceArtifacts(), baselineMaterialization().nquads);
  assert.equal(result.status, 0, result.stderr);
});

test('Custom worker rejects a locked next cursor whose page is missing', () => {
  withMutation('portfolio-missing-page', (state) => {
    const closure = readJson(sourceFile(CLOSURE_REL));
    closure.pages.pop();
    resealClosure(state, closure);
  }, 'PORTFOLIO_CLOSURE_MISSING_PAGE');
});

test('Custom worker rejects a locked response row omitted from its locator manifest', () => {
  withMutation('portfolio-row-omission', (state) => {
    const closure = readJson(sourceFile(CLOSURE_REL));
    const locators = readJson(sourceFile(PAGE_1_LOCATORS_REL));
    locators.rows = [];
    const locatorChange = replaceArtifact(
      state.artifacts,
      PAGE_1_LOCATORS_REL,
      locators,
      state.directory,
    );
    closure.pages[0].rowLocatorManifestDigest = locatorChange.newDigest;
    resealClosure(state, closure);
  }, 'PORTFOLIO_CLOSURE_OMISSION');
});

test('Custom worker rejects a coherently re-sealed duplicate holding record across pages', () => {
  withMutation('portfolio-duplicate', (state) => {
    const closure = readJson(sourceFile(CLOSURE_REL));
    const page1 = readJson(sourceFile(PAGE_1_RESPONSE_REL));
    const page2 = readJson(sourceFile(PAGE_2_RESPONSE_REL));
    const record = structuredClone(page1.records[0]);
    page2.records = [record];
    const responseChange = replaceArtifact(
      state.artifacts,
      PAGE_2_RESPONSE_REL,
      page2,
      state.directory,
    );

    const template = readJson(sourceFile(PAGE_1_LOCATORS_REL)).rows[0];
    const sourceLocator = {
      ...structuredClone(template.sourceLocator),
      path: PAGE_2_RESPONSE_REL,
      pointer: '/records/0',
    };
    delete sourceLocator.selectionDigest;
    sourceLocator.selectionDigest = computeSelectionDigest(sourceLocator, jcsBytes(record));
    const locatorManifest = {
      kind: 'PortfolioObservationRowLocatorManifest',
      responseDigest: responseChange.newDigest,
      responseRef: structuredClone(closure.pages[1].responseRef),
      rows: [{
        locatorIri: 'urn:axiolune:source-locator:slice-a:duplicate-page-2-record',
        recordKey: structuredClone(record.recordKey),
        sourceLocator,
      }],
      schemaVersion: '1.0',
    };
    const locatorChange = replaceArtifact(
      state.artifacts,
      PAGE_2_LOCATORS_REL,
      locatorManifest,
      state.directory,
    );
    closure.pages[1].orderedRecordKeys = [structuredClone(record.recordKey)];
    closure.pages[1].recordCount = 1;
    closure.pages[1].recordSetDigest = recordSetDigest([record.recordKey]);
    closure.pages[1].responseDigest = responseChange.newDigest;
    closure.pages[1].rowLocatorManifestDigest = locatorChange.newDigest;
    closure.aggregate.duplicateCount = 1;
    closure.aggregate.recordSetDigest = recordSetDigest([record.recordKey, record.recordKey]);
    closure.aggregate.totalRecordCount = 2;
    resealClosure(state, closure);
  }, 'PORTFOLIO_CLOSURE_DUPLICATE_RECORD');
});

test('Custom worker rejects a coherently re-sealed opaque cursor cycle', () => {
  withMutation('portfolio-cursor-cycle', (state) => {
    const closure = readJson(sourceFile(CLOSURE_REL));
    const page2 = readJson(sourceFile(PAGE_2_RESPONSE_REL));
    page2.nextCursor = closure.pages[1].cursor;
    page2.terminal = false;
    const responseChange = replaceArtifact(
      state.artifacts,
      PAGE_2_RESPONSE_REL,
      page2,
      state.directory,
    );
    const locatorManifest = readJson(sourceFile(PAGE_2_LOCATORS_REL));
    locatorManifest.responseDigest = responseChange.newDigest;
    const locatorChange = replaceArtifact(
      state.artifacts,
      PAGE_2_LOCATORS_REL,
      locatorManifest,
      state.directory,
    );
    closure.pages[1].nextCursor = page2.nextCursor;
    closure.pages[1].responseDigest = responseChange.newDigest;
    closure.pages[1].rowLocatorManifestDigest = locatorChange.newDigest;
    closure.pages[1].terminal = false;
    closure.aggregate.terminalObserved = false;
    resealClosure(state, closure);
  }, 'PORTFOLIO_CLOSURE_CURSOR_CYCLE');
});

test('Custom worker rejects a Holding when its exact stream closure is a valid empty snapshot', () => {
  withMutation('portfolio-empty-snapshot', (state) => {
    const closure = readJson(sourceFile(CLOSURE_REL));
    const page1 = readJson(sourceFile(PAGE_1_RESPONSE_REL));
    page1.nextCursor = null;
    page1.records = [];
    page1.terminal = true;
    const responseChange = replaceArtifact(
      state.artifacts,
      PAGE_1_RESPONSE_REL,
      page1,
      state.directory,
    );
    const locatorManifest = readJson(sourceFile(PAGE_1_LOCATORS_REL));
    locatorManifest.responseDigest = responseChange.newDigest;
    locatorManifest.rows = [];
    const locatorChange = replaceArtifact(
      state.artifacts,
      PAGE_1_LOCATORS_REL,
      locatorManifest,
      state.directory,
    );
    const emptySetDigest = recordSetDigest([]);
    closure.pages = [{
      ...closure.pages[0],
      nextCursor: null,
      orderedRecordKeys: [],
      recordCount: 0,
      recordSetDigest: emptySetDigest,
      responseDigest: responseChange.newDigest,
      rowLocatorManifestDigest: locatorChange.newDigest,
      terminal: true,
    }];
    closure.aggregate = {
      duplicateCount: 0,
      pageCount: 1,
      recordSetDigest: emptySetDigest,
      terminalObserved: true,
      totalRecordCount: 0,
    };
    state.dataNQuads = replaceDigest(
      state.dataNQuads,
      responseChange.oldDigest,
      responseChange.newDigest,
      'Holding page response',
    );
    resealClosure(state, closure);
  }, 'S5_CUSTOM_HOLDING_SOURCE_CLOSURE');
});

for (const [name, mutatePayload] of [
  ['quantity', (payload) => { payload.holdingQuantity = '11'; }],
  ['quantity-policy', (payload) => {
    payload.holdingQuantity = '10.0';
    payload.holdingQuantityPrecision = 1;
    payload.holdingQuantityRounding = 'half-up';
  }],
  ['unit', (payload) => { payload.holdingQuantityUnit = 'urn:unit:contract'; }],
  ['valid-axis', (payload) => { payload.validFrom = '2024-07-09T00:00:00Z'; }],
  ['knowledge-axis', (payload) => { payload.knowledgeFrom = '2024-07-09T00:00:00Z'; }],
  ['availability-axis', (payload) => { payload.availableFrom = '2024-07-09T00:00:00Z'; }],
  ['revision', (payload) => { payload.revision = 1; }],
  ['source-kind', (payload) => {
    payload.positionSourceKindIri =
      'https://axiolune.ai/ontology/finance/portfolio-positions/PositionSourceKind/value/internalDerived';
  }],
]) {
  test(`Custom worker rejects coherently re-sealed page ${name} bytes that differ from Holding RDF`, () => {
    withMutation(`portfolio-payload-${name}`, (state) => {
      resealPage1Payload(state, mutatePayload);
    }, 'S5_CUSTOM_HOLDING_SOURCE_PAYLOAD');
  });
}
