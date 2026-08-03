#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  DECISION_PATH,
  REQUIRED_DECISIONS,
  verifyReviewedNoAlignments,
} = require('../lib/reviewed-no-alignment.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, ...relativePath.split('/')));
}

function decisionDocument() {
  return JSON.parse(read(DECISION_PATH).toString('utf8'));
}

function rejects(result, pattern) {
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), pattern);
}

test('exact reviewed no-alignment decisions replay local, FIBO, lock, and projection evidence', () => {
  const result = verifyReviewedNoAlignments({ rootDir: ROOT });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.evidence.conclusion, 'pass-reviewed-no-alignment');
  assert.equal(result.evidence.approvalStatus, 'not-approved');
  assert.equal(result.evidence.decisions.length, 7);
  assert.ok(result.evidence.decisions.every((row) => row.rejectedTriple.present === false));
});

test('local element definition/digest drift is rejected', () => {
  const modulePath = 'ontology/domain/finance/instruments/module.yaml';
  const mutated = Buffer.from(read(modulePath).toString('utf8').replace(
    'identifiable financial contract that may be issued, offered, listed, observed, traded, or valued without',
    'identifiable financial contract that is always issued and denominated without',
  ));
  rejects(verifyReviewedNoAlignments({
    rootDir: ROOT,
    byteOverrides: new Map([[modulePath, mutated]]),
  }), /exact element digest\/IRI\/definition mismatch/u);
});

test('selected FIBO byte mutation is rejected by the exact SourceLocator', () => {
  const sourcePath = 'reference/ontology-design-reference/fibo/FBC/FinancialInstruments/FinancialInstruments.rdf';
  const mutated = Buffer.from(read(sourcePath));
  const offset = mutated.indexOf(Buffer.from('isIssuedBy', 'utf8'));
  assert.notEqual(offset, -1);
  mutated[offset] = 0x58;
  rejects(verifyReviewedNoAlignments({
    rootDir: ROOT,
    byteOverrides: new Map([[sourcePath, mutated]]),
  }), /selected-byte digest mismatch|selected-content digest mismatch/u);
});

test('selected FIBO RDF resource mutation is rejected by the exact SourceLocator', () => {
  const sourcePath = 'reference/ontology-design-reference/fibo/FBC/FinancialInstruments/InstrumentPricing.rdf';
  const mutated = Buffer.from(read(sourcePath));
  const offset = mutated.indexOf(Buffer.from(
    'monetary price for a financial instrument at some point in time',
    'utf8',
  ));
  assert.notEqual(offset, -1);
  mutated[offset] = 0x58;
  rejects(verifyReviewedNoAlignments({
    rootDir: ROOT,
    byteOverrides: new Map([[sourcePath, mutated]]),
  }), /selected-byte digest mismatch|selected-content digest mismatch/u);
});

test('locator selection tamper is rejected against decision and lock', () => {
  const document = decisionDocument();
  document.decisions[0].candidate.sourceLocator.selectionDigest = `sha256:${'0'.repeat(64)}`;
  rejects(verifyReviewedNoAlignments({ rootDir: ROOT, document }), /decision digest mismatch|exactly one FIBO lock locator/u);
});

test('reintroduced rejected projection triple is detected', () => {
  const projectionPath = 'ontology/domain/finance/instruments/module.owl.ttl';
  const appended = Buffer.concat([
    read(projectionPath),
    Buffer.from(
      '\n<https://axiolune.ai/ontology/finance/instruments/FinancialInstrument> '
      + '<http://www.w3.org/2000/01/rdf-schema#subClassOf> '
      + '<https://spec.edmcouncil.org/fibo/ontology/FBC/FinancialInstruments/FinancialInstruments/FinancialInstrument> .\n',
      'utf8',
    ),
  ]);
  rejects(verifyReviewedNoAlignments({
    rootDir: ROOT,
    byteOverrides: new Map([[projectionPath, appended]]),
  }), /rejected rdfs:subClassOf triple is present/u);
});

test('outcome weakening and decision omission are rejected', () => {
  const weakened = decisionDocument();
  weakened.decisions[0].outcome = 'aligned';
  rejects(verifyReviewedNoAlignments({ rootDir: ROOT, document: weakened }), /decision digest mismatch|fixed local\/candidate\/outcome identity mismatch/u);
  const omitted = decisionDocument();
  omitted.decisions.pop();
  rejects(verifyReviewedNoAlignments({ rootDir: ROOT, document: omitted }), /expected exact decision set/u);
});

test('decision scope never force-aligns PositionLot or HoldingSnapshot', () => {
  const specifications = Object.values(REQUIRED_DECISIONS);
  assert.equal(specifications.length, 7);
  assert.ok(specifications.every((spec) => !['PositionLot', 'HoldingSnapshot'].includes(spec.key)));
  const documentText = read(DECISION_PATH).toString('utf8');
  assert.ok(!documentText.includes('PositionLot') || documentText.includes('intentionally not forced'));
  assert.ok(!documentText.includes('HoldingSnapshot') || documentText.includes('intentionally not forced'));
});
