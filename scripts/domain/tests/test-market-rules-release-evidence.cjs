'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  CLASSIFICATION,
  FILES,
  LEDGER_FILES,
  MarketRulesReleaseEvidenceError,
  buildAllMarketRulesReleaseEvidence,
  readStrictJcs,
  verifyAllMarketRulesReleaseEvidence,
  verifyLedgerCandidate,
} = require('../lib/market-rules-release-evidence.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('all five immutable Market Rules ledgers replay and close the six former runtime pendings', () => {
  const result = verifyAllMarketRulesReleaseEvidence();
  assert.deepEqual(result.checks, [
    { id: 'REQUEST_SCOPE_CUSTOM', status: 'passed' },
    { id: 'RESOLVER_RUN', status: 'passed' },
    { id: 'FACT_GENERATION_RUN', status: 'passed' },
    { id: 'CANONICAL_EXTERNAL_FACT_IDENTITY', status: 'passed' },
    { id: 'PRECEDENCE_PRIORITY_AUTHORITY', status: 'passed' },
    { id: 'SYNTHETIC_NON_AUTHORITY_BOUNDARY', status: 'passed' },
  ]);
  assert.equal(result.ledgerCount, 5);
  assert.equal(result.tamperChecks.length, 5);
  assert.deepEqual(result.classification, CLASSIFICATION);
});

test('every stored ledger is strict JCS and repeats the non-production/non-authority boundary', () => {
  for (const file of Object.values(LEDGER_FILES)) {
    const ledger = readStrictJcs(file);
    assert.deepEqual(ledger.classification, CLASSIFICATION);
    assert.equal(ledger.outcome, 'passed');
    assert.match(ledger.evidenceDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.match(ledger.runId, /^sha256:[0-9a-f]{64}$/u);
  }
  assert.deepEqual(readStrictJcs(FILES.artifactManifest).classification, CLASSIFICATION);
});

test('digest tamper is rejected independently for each ledger kind', () => {
  const expected = buildAllMarketRulesReleaseEvidence();
  for (const [kind, ledger] of Object.entries(expected.ledgers)) {
    const candidate = structuredClone(ledger);
    candidate.evidenceDigest = `sha256:${'0'.repeat(64)}`;
    assert.throws(
      () => verifyLedgerCandidate(candidate, ledger, expected.schema),
      (error) => error instanceof MarketRulesReleaseEvidenceError
        && error.code === 'MR_EVIDENCE_DIGEST',
      kind,
    );
  }
});

test('verification mode is read-only and executes the focused runner', () => {
  const evidenceFiles = [
    FILES.artifactManifest,
    FILES.implementationClosure,
    FILES.schemaManifest,
    ...Object.values(LEDGER_FILES),
  ];
  const before = new Map(evidenceFiles.map((file) => [file, fs.readFileSync(file)]));
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'domain', 'generate-market-rules-release-evidence.cjs')],
    { cwd: ROOT, encoding: 'utf8', shell: false, timeout: 30000, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /market-rules runtime evidence: 13 passed, 0 failed/u);
  for (const file of evidenceFiles) assert.deepEqual(fs.readFileSync(file), before.get(file));
});
