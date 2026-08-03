'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PROFILE_REFERENCE_FIELDS,
  S5ControlChainError,
  artifactDigest,
  indexControlRecordsByIri,
  sourceSnapshotRootDigest,
  validateControlRecordRef,
} = require('../lib/s5-control-record-chain.cjs');
const {
  sourceSnapshotRootDigest: portfolioSourceSnapshotRootDigest,
} = require('../lib/orders-portfolio-custom-validators.cjs');

function artifact(iri, bytesText, recordType = 'validationReport') {
  const bytes = Buffer.from(bytesText, 'utf8');
  return {
    bytes,
    digest: artifactDigest(bytes),
    record: { iri, recordType },
  };
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => (
    error instanceof S5ControlChainError && error.code === code
  ));
}

test('M3 reference boundary enumerates every S5 control-record URI and snapshot ArtifactRef', () => {
  assert.deepEqual(PROFILE_REFERENCE_FIELDS, {
    evidenceLedger: {},
    failureReport: {},
    materializationBatchRun: {
      'result.completed.validationReportRef': 'uri',
      'result.failed.failureReportRef': 'uri',
    },
    materializationRun: {
      'inputDatasets[].snapshotRef': 'ArtifactRef',
      'result.completed.validationReportRef': 'uri',
      'result.failed.failureReportRef': 'uri',
    },
    pitRequest: {
      'materializationContext.recordRef': 'uri',
    },
    replayReport: {
      originalContextRef: 'uri',
    },
    validationReport: {
      'pit.contextRef': 'uri',
      'pit.requestRef': 'uri',
    },
  });
});

test('source snapshot root accepts ArtifactRef framing and rejects URI substitution', () => {
  const snapshots = [{
    artifactDigest: `sha256:${'1'.repeat(64)}`,
    dataset: 'urn:axiolune:dataset:test',
    schemaDigest: `sha256:${'2'.repeat(64)}`,
    snapshotRef: {
      kind: 'path',
      path: 'snapshots/test.json',
      root: 'sourceTree',
    },
    snapshotTime: '2024-01-01T00:00:00Z',
  }];
  const rootWithoutVolumetrics = sourceSnapshotRootDigest(snapshots);
  assert.match(rootWithoutVolumetrics, /^sha256:[0-9a-f]{64}$/u);
  snapshots[0].rowCount = 0;
  assert.equal(
    sourceSnapshotRootDigest(snapshots),
    rootWithoutVolumetrics,
    'optional M3 rowCount must not change source snapshot identity framing',
  );
  assert.equal(
    portfolioSourceSnapshotRootDigest(snapshots),
    rootWithoutVolumetrics,
    'Portfolio run integration must use the canonical M3 ArtifactRef framing',
  );
  snapshots[0].rowCount = -1;
  expectCode(() => sourceSnapshotRootDigest(snapshots), 'S5_CHAIN_SNAPSHOT_ROOT');
  delete snapshots[0].rowCount;
  snapshots[0].snapshotRef = 'urn:axiolune:snapshot:test';
  expectCode(() => sourceSnapshotRootDigest(snapshots), 'S5_CHAIN_ARTIFACT_REF');
});

test('control-record resolver accepts IRI joins and rejects ArtifactRef substitution', () => {
  const iri = 'urn:axiolune:control:validationReport:test';
  const report = artifact(iri, '{"record":"one"}');
  const context = { recordArtifactsByIri: new Map([[iri, report]]) };
  assert.equal(
    validateControlRecordRef(iri, report.digest, 'report', context, 'validationReport'),
    report.record,
  );
  expectCode(
    () => validateControlRecordRef(
      { kind: 'path', path: 'records/report.json', root: 'buildEvidence' },
      report.digest,
      'report',
      context,
      'validationReport',
    ),
    'S5_CHAIN_IRI',
  );
});

test('missing control-record IRI cannot fall back to a path lookup', () => {
  expectCode(
    () => validateControlRecordRef(
      'urn:axiolune:control:validationReport:missing',
      `sha256:${'0'.repeat(64)}`,
      'report',
      { recordArtifactsByIri: new Map() },
      'validationReport',
    ),
    'S5_CHAIN_RECORD_IRI_MISSING',
  );
});

test('same control-record IRI with different bytes/digests is a collision', () => {
  const iri = 'urn:axiolune:control:validationReport:duplicate';
  const records = new Map([
    ['one', artifact(iri, '{"record":"one"}')],
    ['two', artifact(iri, '{"record":"two"}')],
  ]);
  expectCode(() => indexControlRecordsByIri(records), 'S5_CHAIN_CONTROL_COLLISION');
});

test('same control-record IRI and identical bytes is still a duplicate identity', () => {
  const iri = 'urn:axiolune:control:validationReport:duplicate';
  const first = artifact(iri, '{"record":"same"}');
  const records = new Map([
    ['one', first],
    ['two', { ...first, record: { ...first.record } }],
  ]);
  expectCode(() => indexControlRecordsByIri(records), 'S5_CHAIN_RECORD_IRI_DUPLICATE');
});
