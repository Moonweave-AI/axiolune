'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  EVIDENCE_USE,
  assertDecisionMatchesEvidence,
  decisionFromEvidence,
  loadProjectReferenceSemanticEvidence,
} = require('../lib/project-reference-semantic-evidence.cjs');
const {
  categoryFromPath,
  reviewRationale,
} = require('../generate-project-reference-review.cjs');

const DIGEST = `sha256:${'a'.repeat(64)}`;

function record(overrides = {}) {
  const value = {
    artifactDigest: DIGEST,
    disposition: 'candidateRejected',
    evidenceLocators: [{ excerpt: 'class OrderState', kind: 'class declaration', line: 17 }],
    fileRole: 'order state implementation',
    m2Assessment: 'The implementation does not establish the M2 immutable event and three-axis ontology contract.',
    path: 'reference/project-reference/example/src/order.py',
    projectId: 'example',
    provenanceAssessment: 'The observed commit is absent from references.lock and cannot close provenance.',
    reviewMethod: 'deterministic full-byte UTF-8 decode and candidate signal extraction; no semantic review inferred',
    reviewerRef: 'tool:axiolune-project-reference-triage/v1',
    reviewStatus: 'automatedCandidate',
    semanticSummary: 'reference/project-reference/example/src/order.py defines the OrderState implementation at L17.',
    semanticTags: ['order'],
    sourceKind: 'py source',
    ...overrides,
  };
  return value;
}

function artifact(records) {
  return {
    evidenceUse: EVIDENCE_USE,
    recordKind: 'projectReferenceSemanticEvidence',
    records,
    reviewedAgainst: ['docs/domain/planning/M2-PLAN.md#01'],
    schemaVersion: '1.0',
  };
}

function write(directory, value) {
  const reviewedPath = path.join(directory, 'docs', 'domain', 'planning', 'M2-PLAN.md');
  fs.mkdirSync(path.dirname(reviewedPath), { recursive: true });
  fs.writeFileSync(reviewedPath, '# M2 plan\n');
  const filePath = path.join(directory, 'evidence.json');
  fs.writeFileSync(filePath, JSON.stringify(value));
  return filePath;
}

test('reviewedAgainst paths must resolve inside the evidence root', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-project-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(
    () => loadProjectReferenceSemanticEvidence({
      evidencePath: write(directory, {
        ...artifact([record()]),
        reviewedAgainst: ['docs/domain/MISSING.md#section'],
      }),
      rootDir: directory,
    }),
    /missing reviewed source/u,
  );
});

test('project triage candidate is exact and line-located but cannot become a review decision', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-project-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const row = record();
  const loaded = loadProjectReferenceSemanticEvidence({
    evidencePath: write(directory, artifact([row])),
    rootDir: directory,
  });
  assert.equal(loaded.byPath.get(row.path).evidenceLocators[0].line, 17);
  assert.throws(
    () => decisionFromEvidence(row),
    /cannot be promoted to a semantic review decision/u,
  );
  assert.throws(
    () => assertDecisionMatchesEvidence({ path: row.path }, row),
    /not a reviewed semantic decision/u,
  );
});

test('candidate evidence cannot use a reviewed disposition or claim completed review', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-project-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(
    () => loadProjectReferenceSemanticEvidence({
      evidencePath: write(directory, artifact([record({ disposition: 'reviewedRejected' })])),
      rootDir: directory,
    }),
    /expected candidateNoBearing or candidateRejected/u,
  );
  assert.throws(
    () => loadProjectReferenceSemanticEvidence({
      evidencePath: write(directory, artifact([record({ reviewStatus: 'reviewed' })])),
      rootDir: directory,
    }),
    /expected automatedCandidate/u,
  );
});

test('missing locators, unsorted tags, and duplicate blanket rationales fail closed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-project-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(
    () => loadProjectReferenceSemanticEvidence({
      evidencePath: write(directory, artifact([record({ evidenceLocators: [] })])),
      rootDir: directory,
    }),
    /at least one exact file locator/u,
  );
  assert.throws(
    () => loadProjectReferenceSemanticEvidence({
      evidencePath: write(directory, artifact([record({ semanticTags: ['temporal', 'order'] })])),
      rootDir: directory,
    }),
    /sorted unique tags/u,
  );
  const left = record();
  const right = record({
    path: 'reference/project-reference/example/src/order2.py',
    semanticSummary: left.semanticSummary,
  });
  assert.throws(
    () => loadProjectReferenceSemanticEvidence({
      evidencePath: write(directory, artifact([left, right])),
      rootDir: directory,
    }),
    /summary must name the exact repository path/u,
  );
});

test('reviewedRejected coverage preserves the digest-bound file-specific decision', () => {
  const repoPath = 'reference/project-reference/example/src/order.py';
  const rationale = `${repoPath} defines a partial order-state mapping at L17; it is not the M2 immutable event contract.`;
  assert.equal(
    reviewRationale(
      repoPath,
      'reviewedRejected',
      ['order'],
      'implementation-or-documentation',
      { rationale },
    ),
    rationale,
  );
  assert.throws(
    () => reviewRationale(
      repoPath,
      'reviewedRejected',
      ['order'],
      'implementation-or-documentation',
      null,
    ),
    /requires a digest-bound file-specific semantic decision/u,
  );
  const mapped = reviewRationale(
    'reference/project-reference/Lean/Common/Orders/OrderTypes.cs',
    'reviewedRejected',
    ['order'],
    'implementation-or-documentation',
    null,
  );
  assert.match(mapped, /QuantConnect\.Orders\.OrderType/u);
  assert.doesNotMatch(mapped, /no current .*consumer|no current .*candidate selects/iu);
});

test('semantic history classes and underscored test-data directories are not metadata/configuration', () => {
  assert.equal(
    categoryFromPath('reference/project-reference/Lean/Common/Data/IndicatorHistory.cs'),
    'implementation-or-documentation',
  );
  assert.equal(
    categoryFromPath('reference/project-reference/nautilus/crates/a/test_data/ws_order_filled.json'),
    'test-or-fixture',
  );
  assert.equal(
    categoryFromPath('reference/project-reference/foo/HISTORY.md'),
    'project-metadata',
  );
});

test('semantic scanner recognizes canonical Chinese finance terms', () => {
  const { semanticScan } = require('../generate-project-reference-review.cjs');
  const tags = semanticScan('未来函数、平今、订单编号、持仓、风险、事件时间').tags;
  for (const tag of ['PIT', 'identity', 'marketRules', 'order', 'portfolio', 'risk', 'temporal']) {
    assert.ok(tags.includes(tag), `missing ${tag}`);
  }
});
