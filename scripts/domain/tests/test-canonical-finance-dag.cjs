#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CANONICAL_IMPORTS,
  FINANCE_BASE,
  validateCanonicalFinanceDag,
} = require('../lib/canonical-finance-dag.cjs');

function canonicalRecords() {
  return Object.entries(CANONICAL_IMPORTS).map(([name, imports]) => ({
    module: {
      moduleIri: `${FINANCE_BASE}${name}`,
      version: '0.3.0',
      imports: imports.map((imported) => ({
        moduleIri: `${FINANCE_BASE}${imported}`,
      })),
    },
  }));
}

test('the exact ten-node RFC-001 v0.3 graph is accepted', () => {
  assert.deepEqual(validateCanonicalFinanceDag(canonicalRecords()), []);
});

test('the retired ext-fibo adapter is rejected from the active tree', () => {
  const records = canonicalRecords();
  records.push({
    module: {
      moduleIri: `${FINANCE_BASE}ext-fibo-release-local`,
      version: '0.3.0',
      imports: [],
    },
  });
  assert.deepEqual(
    validateCanonicalFinanceDag(records).map((finding) => finding.code),
    ['EXTRA_FINANCE_MODULE'],
  );
});

test('missing, extra, duplicate, and transitive-only import assumptions fail closed', () => {
  const records = canonicalRecords();
  const risk = records.find((record) => record.module.moduleIri === `${FINANCE_BASE}risk`);
  risk.module.imports = [
    { moduleIri: `${FINANCE_BASE}foundation` },
    { moduleIri: `${FINANCE_BASE}portfolio-positions` },
    { moduleIri: `${FINANCE_BASE}portfolio-positions` },
    { moduleIri: `${FINANCE_BASE}strategy-research` },
  ];
  const findings = validateCanonicalFinanceDag(records);
  assert.deepEqual(
    findings.filter((finding) => finding.module === 'risk').map((finding) => finding.code),
    ['DIRECT_IMPORT_SET_MISMATCH', 'DUPLICATE_DIRECT_IMPORT'],
  );
});

test('wrong module versions are reported independently of graph shape', () => {
  const records = canonicalRecords();
  records[0].module.version = '0.2.0';
  assert.deepEqual(
    validateCanonicalFinanceDag(records).map((finding) => finding.code),
    ['WRONG_FINANCE_VERSION'],
  );
});
