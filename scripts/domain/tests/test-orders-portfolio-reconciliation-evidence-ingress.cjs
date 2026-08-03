'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  decodeCanonicalOrdersPortfolioScenario,
  encodeCanonicalOrdersPortfolioScenario,
} = require('../lib/orders-portfolio-canonical-record-adapter.cjs');
const {
  CustomConstraintViolation,
  validateConstraint,
} = require('../lib/orders-portfolio-custom-validators.cjs');
const {
  PATHS,
  ROOT,
  reconciliationProducerInputs,
} = require('../lib/orders-portfolio-custom-profile.cjs');
const {
  PORTFOLIO_GRAPH_IRI,
} = require('../lib/s5-canonical-materialization.cjs');
const {
  INPUT_FIXTURE_REL,
  createS5ControlRecordChain,
  verifyCompletedMaterializationRunBundle,
  verifiedS5ControlRecordChainMaterializationContexts,
} = require('../lib/s5-control-record-chain.cjs');
const {
  verifyPortfolioReconciliationProjection,
} = require('../lib/orders-portfolio-reconciliation-evidence.cjs');
const {
  executeRequest,
  readStrictJcs,
} = require('../run-orders-portfolio-custom-runtime.cjs');
const {
  buildCompletedMaterializationRunBundleFixture,
} = require('./test-completed-materialization-run-bundle.cjs');

const inputContract = readStrictJcs(PATHS.inputContract).value;
const vector = readStrictJcs(PATHS.vectors).value.vectors.find(
  (row) => row.validatorId === 'PortfolioPositionReconciliationFindingContract',
);
assert.ok(vector, 'missing Portfolio reconciliation vector');

let evidenceDirectory;
let portfolioContext;
let baselineProjection;
let quantityMismatchProjection;

function decoded(canonicalScenario = vector.accepted.scenario) {
  return decodeCanonicalOrdersPortfolioScenario(
    structuredClone(canonicalScenario),
    vector.validatorId,
    inputContract,
  );
}

function expectViolation(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof CustomConstraintViolation);
    assert.equal(error.code, code);
    return true;
  });
}

test.before(() => {
  evidenceDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'axiolune-reconciliation-ingress-test-'),
  );
  const summary = createS5ControlRecordChain(
    { kind: 'path', path: INPUT_FIXTURE_REL, root: 'sourceTree' },
    { buildEvidence: evidenceDirectory, sourceTree: ROOT },
  );
  portfolioContext = verifiedS5ControlRecordChainMaterializationContexts(summary)
    .find((candidate) => candidate.targetGraph === PORTFOLIO_GRAPH_IRI);
  assert.ok(portfolioContext, 'S5 chain did not export a verified Portfolio context');
  baselineProjection = verifyPortfolioReconciliationProjection(
    portfolioContext,
    'baseline',
  );
  quantityMismatchProjection = verifyPortfolioReconciliationProjection(
    portfolioContext,
    'reconciliation-quantity-mismatch',
  );
});

test.after(() => {
  if (evidenceDirectory) {
    fs.rmSync(evidenceDirectory, { force: true, recursive: true });
  }
});

test('verifier-owned S5 Portfolio projection authorizes the exact baseline scenario', () => {
  assert.doesNotThrow(() => validateConstraint(
    vector.constraintIri,
    vector.validatorId,
    decoded(),
    { portfolioCandidateProjection: baselineProjection },
  ));
});

test('self-reported candidate graph cannot establish reconciliation acceptance', () => {
  expectViolation(
    () => validateConstraint(vector.constraintIri, vector.validatorId, decoded()),
    'RECONCILIATION_UNVERIFIED_PROJECTION',
  );
});

test('specific reconciliation diagnostics precede projection ingress', () => {
  expectViolation(
    () => validateConstraint(
      vector.constraintIri,
      vector.validatorId,
      decoded(vector.violation.scenario),
      { portfolioCandidateProjection: baselineProjection },
    ),
    vector.violation.expectedCode,
  );
});

test('JSON worker boundary cannot transport the private verifier projection brand', () => {
  const result = executeRequest({
    constraintIri: vector.constraintIri,
    scenario: vector.accepted.scenario,
    schemaVersion: '1.0',
    validatorId: vector.validatorId,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.response.outcome, 'violation');
  assert.equal(
    result.response.violation,
    'RECONCILIATION_UNVERIFIED_PROJECTION',
  );
});

test('forged and cloned projection lookalikes fail closed', () => {
  for (const projection of [
    { ...baselineProjection },
    structuredClone(baselineProjection),
  ]) {
    expectViolation(
      () => validateConstraint(
        vector.constraintIri,
        vector.validatorId,
        decoded(),
        { portfolioCandidateProjection: projection },
      ),
      'RECONCILIATION_UNVERIFIED_PROJECTION',
    );
  }
});

test('coherently resealed alternate candidate fails against baseline proof and passes exact proof', () => {
  const producerCase = reconciliationProducerInputs().cases.find(
    (row) => row.caseId === 'reconciliation-quantity-mismatch',
  );
  assert.ok(producerCase);
  const alternate = decoded(encodeCanonicalOrdersPortfolioScenario(
    producerCase.validatorId,
    producerCase.legacyInput,
  ));
  expectViolation(
    () => validateConstraint(
      vector.constraintIri,
      vector.validatorId,
      alternate,
      { portfolioCandidateProjection: baselineProjection },
    ),
    'RECONCILIATION_PROJECTION_MISMATCH',
  );
  assert.doesNotThrow(() => validateConstraint(
    vector.constraintIri,
    vector.validatorId,
    alternate,
    { portfolioCandidateProjection: quantityMismatchProjection },
  ));
});

test('caller-manufactured completed context cannot create a projection', () => {
  assert.throws(
    () => verifyPortfolioReconciliationProjection({
      outcome: 'completed',
      targetGraph: PORTFOLIO_GRAPH_IRI,
      verificationKind: 'verifiedCompletedMaterializationContext',
    }),
    (error) => error?.code === 'RECONCILIATION_PROJECTION_UNVERIFIED_CONTEXT',
  );
});

test('S5 withholds the completed-run brand when independent report replay rejects the graph', () => {
  const fixture = buildCompletedMaterializationRunBundleFixture();
  assert.throws(
    () => verifyCompletedMaterializationRunBundle(
      fixture.bundle,
      fixture.expectations,
    ),
    (error) => error?.code === 'S5_BUNDLE_REPORT_REPLAY_SHACL',
  );
});
