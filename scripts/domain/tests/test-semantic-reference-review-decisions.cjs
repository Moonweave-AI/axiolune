'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  findUnusedDecisions,
  loadSemanticReviewDecisions,
  resolveSemanticReviewDecision,
} = require('../lib/semantic-reference-review-decisions.cjs');

const DIGEST = `sha256:${'a'.repeat(64)}`;

function writeManifest(directory, decisions) {
  const manifestPath = path.join(directory, 'decisions.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    decisions,
    schemaVersion: '1.0',
  }));
  return manifestPath;
}

function decision(overrides = {}) {
  return {
    artifactDigest: DIGEST,
    disposition: 'reviewedRejected',
    path: 'reference/ontology-design-reference/BIAN/MarketOrder/MarketOrderSpecification.csv',
    rationale: 'Reviewed against the active order scope; operational account blocking is not adopted as normative ontology evidence.',
    reviewMethod: 'manual full-content semantic review against M2-PLAN and active ontology modules',
    reviewerRef: 'urn:axiolune:reviewer:test',
    ...overrides,
  };
}

test('decision loading is exact, digest-bound, and reports unused scoped decisions', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-semantic-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const row = decision();
  const decisions = loadSemanticReviewDecisions({
    manifestPath: writeManifest(directory, [row]),
    rootDir: directory,
  });
  assert.equal(resolveSemanticReviewDecision(decisions, row.path, DIGEST).disposition, 'reviewedRejected');
  assert.deepEqual(
    findUnusedDecisions(decisions, new Set(), 'reference/ontology-design-reference'),
    [row.path],
  );
  assert.deepEqual(
    findUnusedDecisions(decisions, new Set([row.path]), 'reference/ontology-design-reference'),
    [],
  );
});

test('decision digest drift, duplicate paths, and blanket used dispositions fail closed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-semantic-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const loaded = loadSemanticReviewDecisions({
    manifestPath: writeManifest(directory, [decision()]),
    rootDir: directory,
  });
  assert.throws(
    () => resolveSemanticReviewDecision(loaded, decision().path, `sha256:${'b'.repeat(64)}`),
    /does not match current bytes/u,
  );

  assert.throws(
    () => loadSemanticReviewDecisions({
      manifestPath: writeManifest(directory, [decision(), decision()]),
      rootDir: directory,
    }),
    /strictly UTF-8 path sorted and unique/u,
  );

  assert.throws(
    () => loadSemanticReviewDecisions({
      manifestPath: writeManifest(directory, [decision({ disposition: 'usedNormative' })]),
      rootDir: directory,
    }),
    /reviewedNoBearing or reviewedRejected/u,
  );

  assert.throws(
    () => loadSemanticReviewDecisions({
      manifestPath: writeManifest(directory, [decision({
        rationale: 'No current machine-readable downstream consumer selects this file.',
      })]),
      rootDir: directory,
    }),
    /consumer absence cannot establish/u,
  );
});
