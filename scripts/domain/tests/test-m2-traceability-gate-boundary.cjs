#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  OUTPUT_PATH: DIAGNOSTIC_OUTPUT_PATH,
} = require('../generate-reference-traceability-manifest.cjs');
const {
  validateTraceabilityManifest,
} = require('../lib/m2-traceability-contract.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CANONICAL_PATH = path.join(
  ROOT,
  'docs', 'ontology', 'references', 'traceability-manifest.json',
);

test('legacy reference support graph is diagnostic-only and cannot satisfy strict traceability', () => {
  assert.equal(
    path.relative(ROOT, DIAGNOSTIC_OUTPUT_PATH).split(path.sep).join('/'),
    'docs/domain/infrastructure/reference-support-diagnostics.json',
  );
  const diagnostic = JSON.parse(fs.readFileSync(DIAGNOSTIC_OUTPUT_PATH, 'utf8'));
  assert.equal(diagnostic.artifactKind, 'referenceSupportDiagnostics');
  assert.equal(diagnostic.releaseEvidenceEligible, false);
  const validation = validateTraceabilityManifest(diagnostic);
  assert.equal(validation.ok, false);
  const codes = new Set(validation.errors.map((issue) => issue.code));
  assert.ok(codes.has('TRACE_UNKNOWN_FIELD'));
  assert.ok(codes.has('TRACE_INVALID_NODE_KIND'));
  assert.ok(codes.has('TRACE_ILLEGAL_EDGE'));
});

test('canonical path, when present, must pass the strict RFC-001 section 5.23 validator', () => {
  if (!fs.existsSync(CANONICAL_PATH)) return;
  const value = JSON.parse(fs.readFileSync(CANONICAL_PATH, 'utf8'));
  const validation = validateTraceabilityManifest(value);
  assert.equal(
    validation.ok,
    true,
    validation.errors.slice(0, 10).map((issue) => `${issue.code}:${issue.at}`).join(', '),
  );
});
