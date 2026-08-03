'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  decodeCanonicalOrdersPortfolioScenario,
  encodeCanonicalOrdersPortfolioScenario,
} = require('../lib/orders-portfolio-canonical-record-adapter.cjs');
const {
  CustomConstraintViolation,
  sha256Jcs,
  validateConstraint,
} = require('../lib/orders-portfolio-custom-validators.cjs');
const {
  PATHS,
  PENDING_VALIDATOR_EXECUTION,
} = require('../lib/orders-portfolio-custom-profile.cjs');
const { readStrictJcs } = require('../run-orders-portfolio-custom-runtime.cjs');

const inputContract = readStrictJcs(PATHS.inputContract).value;
const vectors = readStrictJcs(PATHS.vectors).value;

function replaceExact(value, prior, replacement) {
  if (value === prior) return replacement;
  if (Array.isArray(value)) {
    return value.map((item) => replaceExact(item, prior, replacement));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceExact(item, prior, replacement),
      ]),
    );
  }
  return value;
}

function decodedAccepted(vector) {
  return decodeCanonicalOrdersPortfolioScenario(
    vector.accepted.scenario,
    vector.validatorId,
    inputContract,
  );
}

test('run-reference validators enforce IRIs, with pending producers blocked first by evidence ingress', () => {
  const covered = [];
  for (const vector of vectors.vectors) {
    const scenario = decodedAccepted(vector);
    if (!Object.hasOwn(scenario, 'generatingContextRef')) continue;
    covered.push(vector.validatorId);
    const urn = `urn:axiolune:materialization-run:${vector.validatorId}`;
    let urnScenario = replaceExact(scenario, scenario.generatingContextRef, urn);
    if (['PortfolioValuationContract', 'UnrealizedPnLObservationContract'].includes(
      vector.validatorId,
    )) {
      urnScenario = decodeCanonicalOrdersPortfolioScenario(
        encodeCanonicalOrdersPortfolioScenario(vector.validatorId, urnScenario),
        vector.validatorId,
        inputContract,
      );
    }
    if (vector.validatorId === 'PortfolioPositionReconciliationFindingContract') {
      urnScenario.reconciliationContext.digest = sha256Jcs(
        urnScenario.reconciliationContext.payload,
      );
      urnScenario.closureProbe.payload.reconciliationContextDigest =
        urnScenario.reconciliationContext.digest;
      urnScenario.closureProbe.digest = sha256Jcs(urnScenario.closureProbe.payload);
    }
    const pending = PENDING_VALIDATOR_EXECUTION[vector.validatorId] || null;
    if (vector.validatorId === 'PortfolioPositionReconciliationFindingContract') {
      assert.throws(
        () => validateConstraint(vector.constraintIri, vector.validatorId, urnScenario),
        (error) => error instanceof CustomConstraintViolation
          && error.code === 'RECONCILIATION_UNVERIFIED_PROJECTION',
        `${vector.validatorId} must require an in-process verifier-owned projection`,
      );
    } else if (pending) {
      assert.throws(
        () => validateConstraint(vector.constraintIri, vector.validatorId, urnScenario),
        (error) => error instanceof CustomConstraintViolation
          && error.code === pending.pendingCode,
        `${vector.validatorId} must not inspect a caller-authored absolute run IRI before evidence ingress closes`,
      );
    } else {
      assert.doesNotThrow(
        () => validateConstraint(vector.constraintIri, vector.validatorId, urnScenario),
        `${vector.validatorId} rejected an absolute MaterializationRun URN`,
      );
    }

    const relativeScenario = replaceExact(
      scenario,
      scenario.generatingContextRef,
      'materialization-run/not-absolute',
    );
    assert.throws(
      () => validateConstraint(vector.constraintIri, vector.validatorId, relativeScenario),
      (error) => error instanceof CustomConstraintViolation
        && (!pending || error.code === pending.pendingCode),
      `${vector.validatorId} accepted a non-IRI generatingContextRef`,
    );
  }
  assert.ok(covered.length >= 10, `expected at least ten run-reference validators, got ${covered.length}`);
});

test('PnL output replay rejects a caller-authored run-reference substitution', () => {
  const vector = vectors.vectors.find(
    (row) => row.validatorId === 'UnrealizedPnLObservationContract',
  );
  assert.ok(vector);
  const scenario = decodedAccepted(vector);
  scenario.generatingContextRef = 'urn:axiolune:materialization-run:substituted';
  assert.throws(
    () => validateConstraint(vector.constraintIri, vector.validatorId, scenario),
    (error) => error instanceof CustomConstraintViolation
      && error.code === 'PNL_VALUATION_CONTEXT_OUTPUT',
  );
});
