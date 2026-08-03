'use strict';

const crypto = require('node:crypto');
const {
  assertValidTraceabilityExecutionIndex,
  assertValidTraceabilityManifest,
  compareExecutionTuple,
  traceabilityExecutionIndexDigest,
  traceabilityManifestDigest,
} = require('./m2-traceability-contract.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const REPORT_INPUT_FIELDS = Object.freeze([
  'gateId', 'checkId', 'reportRef', 'reportBytes', 'outcome',
]);

function isClosedReportInput(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === REPORT_INPUT_FIELDS.length
    && REPORT_INPUT_FIELDS.every((field) => Object.hasOwn(value, field));
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function buildTraceabilityExecutionIndex(options) {
  const manifest = options?.traceabilityManifest;
  assertValidTraceabilityManifest(manifest);
  if (!Array.isArray(options.reports) || options.reports.length === 0) {
    throw new Error('traceability execution reports must be a non-empty array');
  }
  const reportBytesByPair = new Map();
  const executions = options.reports.map((report, index) => {
    if (!isClosedReportInput(report) || !Buffer.isBuffer(report.reportBytes)) {
      throw new Error(`traceability execution report ${index} is not a closed report tuple`);
    }
    if (report.outcome !== 'passed') {
      throw new Error(`traceability execution report ${report.gateId}/${report.checkId} did not pass`);
    }
    const pair = `${report.gateId}\0${report.checkId}`;
    if (reportBytesByPair.has(pair)) throw new Error(`duplicate traceability execution pair ${pair}`);
    reportBytesByPair.set(pair, report.reportBytes);
    return {
      gateId: report.gateId,
      checkId: report.checkId,
      reportRef: report.reportRef,
      reportDigest: sha256(report.reportBytes),
      outcome: 'passed',
    };
  }).sort(compareExecutionTuple);
  const index = {
    schemaVersion: '1.0',
    build: options.build,
    traceabilityManifestRef: options.traceabilityManifestRef,
    traceabilityManifestDigest: traceabilityManifestDigest(manifest),
    executions,
  };
  assertValidTraceabilityExecutionIndex(index, {
    traceabilityManifest: manifest,
    reportBytesByPair,
    requireReportBytes: true,
  });
  return {
    index,
    bytes: Buffer.from(canonicalJcs(index), 'utf8'),
    indexDigest: traceabilityExecutionIndexDigest(index),
    executionCount: executions.length,
  };
}

module.exports = {
  REPORT_INPUT_FIELDS,
  buildTraceabilityExecutionIndex,
  sha256,
};
