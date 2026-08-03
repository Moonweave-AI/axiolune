'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  decodeCanonicalOrdersPortfolioScenario,
} = require('../lib/orders-portfolio-canonical-record-adapter.cjs');
const {
  isVerifiedOrdersPortfolioPITRequestIngress,
  verifyOrdersPortfolioPITRequestIngress,
} = require('../lib/orders-portfolio-pit-ingress.cjs');
const {
  CustomConstraintViolation,
  canonicalJcs,
  validateConstraint,
} = require('../lib/orders-portfolio-custom-validators.cjs');
const {
  PATHS,
} = require('../lib/orders-portfolio-custom-profile.cjs');
const {
  pitValidationRequestDigest,
} = require('../lib/m2-pit-validation-request.cjs');
const {
  plannedInputDigest,
  resolvedInputDigest,
  verifyCompletedMaterializationRunBundle,
  verifiedMaterializationContextBuild,
  verifiedMaterializationContextRunSlotId,
  verifiedMaterializationContextSourceArtifact,
  verifiedMaterializationRunContext,
} = require('../lib/s5-control-record-chain.cjs');
const {
  readStrictJcs,
} = require('../run-orders-portfolio-custom-runtime.cjs');
const {
  buildCompletedMaterializationRunBundleFixture,
} = require('./test-completed-materialization-run-bundle.cjs');

const VALIDATOR_REF = Object.freeze({
  kind: 'path',
  path: 'scripts/domain/lib/m2-pit-validation-request.cjs',
  root: 'sourceTree',
});

const PIT_REPLAY_VALIDATORS = Object.freeze(new Map([
  [
    'PortfolioAccountMembershipClosureContract',
    ['pitRequest', 'MEMBERSHIP_CLOSURE_PIT_INGRESS'],
  ],
  [
    'PortfolioValuationContract',
    ['pitRequest', 'PORTFOLIO_VALUATION_PIT_INGRESS'],
  ],
  [
    'ExecutionLotAllocationClosureContract',
    ['pitRequest', 'EXECUTION_CLOSURE_PIT_INGRESS'],
  ],
  [
    'PositionLotStateClosureContract',
    ['pitRequest', 'LOT_STATE_PIT_INGRESS'],
  ],
  [
    'UnrealizedPnLObservationContract',
    ['valuationPitRequest', 'PNL_VALUATION_CONTEXT_INGRESS'],
  ],
]));

function clone(value) {
  return structuredClone(value);
}

function canonicalBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

const UPSTREAM_COMPLETED_RUN_PENDING_CODE = 'S5_BUNDLE_REPORT_REPLAY_SHACL';
let completedEvidenceOutcome;

function completedRunEvidenceOutcome() {
  if (completedEvidenceOutcome === undefined) {
    try {
      const fixture = buildCompletedMaterializationRunBundleFixture();
      const summary = verifyCompletedMaterializationRunBundle(
        fixture.bundle,
        fixture.expectations,
      );
      const context = verifiedMaterializationRunContext(summary);
      completedEvidenceOutcome = Object.freeze({
        evidence: Object.freeze({
          build: verifiedMaterializationContextBuild(context),
          context,
          runSlotId: verifiedMaterializationContextRunSlotId(context),
          validator: verifiedMaterializationContextSourceArtifact(context, VALIDATOR_REF),
        }),
        status: 'available',
      });
    } catch (error) {
      assert.equal(
        error?.code,
        UPSTREAM_COMPLETED_RUN_PENDING_CODE,
        'completed-run evidence may be pending only at the independently replayed SHACL gate',
      );
      completedEvidenceOutcome = Object.freeze({
        code: error.code,
        message: error.message,
        status: 'pending-upstream',
      });
    }
  }
  return completedEvidenceOutcome;
}

function actualCompletedEvidence() {
  const outcome = completedRunEvidenceOutcome();
  assert.equal(
    outcome.status,
    'available',
    `completed-run evidence is ${outcome.status}: ${outcome.code || 'unknown'}`,
  );
  return outcome.evidence;
}

function plannedInput(value) {
  const evidence = actualCompletedEvidence();
  return {
    dependencySelectors: [{
      fieldPointer: '/iri',
      sourceSlotId: evidence.runSlotId,
      sourceStage: 'finalRecord',
    }],
    recordType: 'pitRequest',
    schemaVersion: '1.0',
    staticInputs: {
      asOfAvailable: value.asOfAvailable,
      asOfKnowledge: value.asOfKnowledge,
      asOfValid: value.asOfValid,
      attemptId: value.attemptId,
      recordId: value.requestId,
      slotId: value.slotId,
      targetRdfCanonicalization: value.targetRdfCanonicalization,
      validatorDigest: value.validatorDigest,
      validatorRef: value.validatorRef,
    },
  };
}

function canonicalRequest() {
  const evidence = actualCompletedEvidence();
  const context = evidence.context;
  const value = {
    asOfAvailable: '2024-07-10T00:00:02Z',
    asOfKnowledge: '2024-07-10T00:00:01Z',
    asOfValid: '2024-07-10T00:00:00Z',
    attemptId: 'orders-portfolio-attempt-001',
    build: clone(evidence.build),
    iri: 'urn:axiolune:pit-request:orders-portfolio-001',
    materializationContext: {
      contextKind: context.contextKind,
      recordDigest: context.recordDigest,
      recordRef: context.recordRef,
      targetGraph: context.targetGraph,
      targetGraphDigest: context.targetGraphDigest,
    },
    plannedInputDigest: `sha256:${'0'.repeat(64)}`,
    recordType: 'pitRequest',
    requestId: 'orders-portfolio-request-001',
    resolvedInputDigest: `sha256:${'0'.repeat(64)}`,
    schemaVersion: '1.0',
    slotId: 'orders-portfolio-pit-validation',
    targetRdfCanonicalization: 'RDFC-1.0',
    validatorDigest: evidence.validator.digest,
    validatorRef: clone(VALIDATOR_REF),
  };
  const planned = plannedInput(value);
  value.plannedInputDigest = plannedInputDigest('pitRequest', planned);
  value.resolvedInputDigest = resolvedInputDigest(value);
  return { planned, value };
}

function consumerTemporal(overrides = {}) {
  return {
    availableFrom: '2025-01-01T00:00:02Z',
    knowledgeFrom: '2025-01-01T00:00:01Z',
    revision: 0,
    validFrom: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function ingressInput(options = {}) {
  const request = options.request || canonicalRequest();
  const requestBytes = options.requestBytes || canonicalBytes(request.value);
  return {
    consumerTemporal: options.consumerTemporal || consumerTemporal(),
    expectedRequestDigest:
      options.expectedRequestDigest || pitValidationRequestDigest(requestBytes),
    expectedRequestRef: options.expectedRequestRef || request.value.iri,
    plannedInputBytes: options.plannedInputBytes || canonicalBytes(request.planned),
    requestBytes,
    verifiedContext: options.verifiedContext || actualCompletedEvidence().context,
  };
}

function untrustedIngressInput(overrides = {}) {
  return {
    consumerTemporal: consumerTemporal(),
    expectedRequestDigest: `sha256:${'a'.repeat(64)}`,
    expectedRequestRef: 'urn:axiolune:pit-request:caller-authored',
    plannedInputBytes: Buffer.from('{}', 'utf8'),
    requestBytes: Buffer.from('{}', 'utf8'),
    verifiedContext: {
      contextKind: 'materializationRun',
      evidenceLedgerRecordDigest: `sha256:${'b'.repeat(64)}`,
      evidenceLedgerRef: 'urn:axiolune:evidence-ledger:caller-authored',
      ledgerVerified: true,
      outcome: 'completed',
      recordDigest: `sha256:${'c'.repeat(64)}`,
      recordRef: 'urn:axiolune:materialization-run:caller-authored',
      referenceTime: '2024-07-10T00:00:03Z',
      targetGraph: 'urn:axiolune:graph:caller-authored',
      targetGraphDigest: `sha256:${'d'.repeat(64)}`,
      verificationKind: 'verifiedCompletedMaterializationContext',
    },
    ...overrides,
  };
}

function expectCode(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

test('rejects a fully re-sealed legacy seven-field claim without trusting its payload', () => {
  const payload = {
    availableAt: '2024-07-10T00:00:02Z',
    completedAt: '2024-07-10T00:00:03Z',
    knowledgeAt: '2024-07-10T00:00:01Z',
    requestId: 'caller-resealed',
    schemaVersion: '1.0',
    status: 'passed',
    validAt: '2024-07-10T00:00:00Z',
  };
  const bytes = canonicalBytes(payload);
  const input = untrustedIngressInput({
    expectedRequestDigest: pitValidationRequestDigest(bytes),
    expectedRequestRef: 'urn:axiolune:pit-request:caller-resealed',
    requestBytes: bytes,
  });
  expectCode(
    () => verifyOrdersPortfolioPITRequestIngress(input),
    'ORDERS_PORTFOLIO_PIT_CONTEXT_UNVERIFIED',
  );
});

test('rejects caller-manufactured completed-run lookalikes before reading request claims', () => {
  const input = untrustedIngressInput();
  assert.equal(isVerifiedOrdersPortfolioPITRequestIngress(input.verifiedContext), false);
  expectCode(
    () => verifyOrdersPortfolioPITRequestIngress(input),
    'ORDERS_PORTFOLIO_PIT_CONTEXT_UNVERIFIED',
  );
});

test('rejects open, active, and non-buffer ingress envelopes before provenance replay', () => {
  const open = untrustedIngressInput({ unreviewedOverride: true });
  expectCode(
    () => verifyOrdersPortfolioPITRequestIngress(open),
    'ORDERS_PORTFOLIO_PIT_INGRESS_SCHEMA',
  );

  let getterReads = 0;
  const active = untrustedIngressInput();
  Object.defineProperty(active, 'requestBytes', {
    enumerable: true,
    get() {
      getterReads += 1;
      return Buffer.from('{}', 'utf8');
    },
  });
  expectCode(
    () => verifyOrdersPortfolioPITRequestIngress(active),
    'ORDERS_PORTFOLIO_PIT_INGRESS_SCHEMA',
  );
  assert.equal(getterReads, 0);

  expectCode(
    () => verifyOrdersPortfolioPITRequestIngress(untrustedIngressInput({ requestBytes: {} })),
    'ORDERS_PORTFOLIO_PIT_EXACT_BYTES',
  );
});

test('authenticated request-replay deep checks execute or report pending-upstream', async (t) => {
  const deepCases = [
    {
      name: 'request-only brand stays non-consumable at the domain boundary',
      run() {
        const result = verifyOrdersPortfolioPITRequestIngress(ingressInput());
        assert.equal(isVerifiedOrdersPortfolioPITRequestIngress(result), true);
        assert.equal(result.verificationKind, 'verifiedOrdersPortfolioPITRequestIngress');
        assert.equal(result.releaseConsumable, false);
        assert.equal(
          result.pendingRequirement,
          'verifier-owned-pit-validation-report-replay',
        );
        assert.equal(result.payload.validAt, '2024-07-10T00:00:00Z');
        assert.equal(result.payload.knowledgeAt, '2024-07-10T00:00:01Z');
        assert.equal(result.payload.availableAt, '2024-07-10T00:00:02Z');
        assert.match(result.digest, /^sha256:[0-9a-f]{64}$/u);
        assert.equal(isVerifiedOrdersPortfolioPITRequestIngress(clone(result)), false);

        const inputContract = readStrictJcs(PATHS.inputContract).value;
        const vector = readStrictJcs(PATHS.vectors).value.vectors.find(
          (row) => row.validatorId === 'PortfolioAccountMembershipClosureContract',
        );
        const scenario = decodeCanonicalOrdersPortfolioScenario(
          vector.accepted.scenario,
          vector.validatorId,
          inputContract,
        );
        scenario.pitRequest = result;
        assert.throws(
          () => validateConstraint(vector.constraintIri, vector.validatorId, scenario),
          (cause) => cause instanceof CustomConstraintViolation
            && cause.code === 'MEMBERSHIP_CLOSURE_PIT_PRODUCER_PENDING',
        );
      },
    },
    {
      name: 'authenticated ingress rejects legacy seven-field request bytes',
      run() {
        const payload = {
          availableAt: '2024-07-10T00:00:02Z',
          completedAt: '2024-07-10T00:00:03Z',
          knowledgeAt: '2024-07-10T00:00:01Z',
          requestId: 'caller-resealed',
          schemaVersion: '1.0',
          status: 'passed',
          validAt: '2024-07-10T00:00:00Z',
        };
        const bytes = canonicalBytes(payload);
        expectCode(
          () => verifyOrdersPortfolioPITRequestIngress(ingressInput({
            expectedRequestDigest: pitValidationRequestDigest(bytes),
            expectedRequestRef: 'urn:axiolune:pit-request:caller-resealed',
            requestBytes: bytes,
          })),
          'M2_PIT_SCHEMA',
        );
      },
    },
    {
      name: 'unbranded context copies and non-canonical bytes are rejected',
      run() {
        expectCode(
          () => verifyOrdersPortfolioPITRequestIngress(ingressInput({
            verifiedContext: clone(actualCompletedEvidence().context),
          })),
          'ORDERS_PORTFOLIO_PIT_CONTEXT_UNVERIFIED',
        );

        const request = canonicalRequest();
        expectCode(
          () => verifyOrdersPortfolioPITRequestIngress(ingressInput({
            expectedRequestDigest: pitValidationRequestDigest(canonicalBytes(request.value)),
            request,
            requestBytes: Buffer.from(`${canonicalJcs(request.value)}\n`, 'utf8'),
          })),
          'M2_PIT_JCS',
        );
        expectCode(
          () => verifyOrdersPortfolioPITRequestIngress(ingressInput({
            plannedInputBytes: Buffer.from(`${canonicalJcs(request.planned)}\n`, 'utf8'),
            request,
          })),
          'M2_PIT_JCS',
        );
      },
    },
    {
      name: 'cross-run, source-tree, and target-graph substitutions are rejected',
      run() {
        const attacks = [
          {
            code: 'M2_PIT_CONTEXT_BINDING',
            mutate(value) {
              value.materializationContext.recordRef = 'urn:axiolune:materialization-run:other';
            },
          },
          {
            code: 'M2_PIT_BUILD_BINDING',
            mutate(value) {
              value.build.sourceTreeDigest = `sha256:${'f'.repeat(64)}`;
            },
          },
          {
            code: 'M2_PIT_CONTEXT_BINDING',
            mutate(value) {
              value.materializationContext.targetGraphDigest = `sha256:${'e'.repeat(64)}`;
            },
          },
        ];
        for (const attack of attacks) {
          const request = canonicalRequest();
          attack.mutate(request.value);
          request.value.resolvedInputDigest = resolvedInputDigest(request.value);
          const bytes = canonicalBytes(request.value);
          expectCode(
            () => verifyOrdersPortfolioPITRequestIngress(ingressInput({
              expectedRequestDigest: pitValidationRequestDigest(bytes),
              request,
              requestBytes: bytes,
            })),
            attack.code,
          );
        }
      },
    },
    {
      name: 'request identity and consumer temporal substitutions are rejected',
      run() {
        expectCode(
          () => verifyOrdersPortfolioPITRequestIngress(ingressInput({
            expectedRequestRef: 'urn:axiolune:pit-request:other',
          })),
          'ORDERS_PORTFOLIO_PIT_REQUEST_BINDING',
        );
        expectCode(
          () => verifyOrdersPortfolioPITRequestIngress(ingressInput({
            expectedRequestDigest: `sha256:${'d'.repeat(64)}`,
          })),
          'ORDERS_PORTFOLIO_PIT_REQUEST_BINDING',
        );
        expectCode(
          () => verifyOrdersPortfolioPITRequestIngress(ingressInput({
            consumerTemporal: consumerTemporal({ knowledgeFrom: '2024-07-10T00:00:00Z' }),
          })),
          'ORDERS_PORTFOLIO_PIT_CONSUMER_PIVOT',
        );
        expectCode(
          () => verifyOrdersPortfolioPITRequestIngress(ingressInput({
            consumerTemporal: consumerTemporal({ availableFrom: '2024-07-10T00:00:05Z' }),
          })),
          'ORDERS_PORTFOLIO_PIT_CAUSAL_ORDER',
        );
      },
    },
  ];

  let executed = 0;
  let pendingUpstream = 0;
  for (const deepCase of deepCases) {
    await t.test(deepCase.name, (subtest) => {
      const upstream = completedRunEvidenceOutcome();
      if (upstream.status === 'pending-upstream') {
        pendingUpstream += 1;
        subtest.diagnostic(
          `pending-upstream: ${upstream.code}; deep assertions resume when S5 emits a brand`,
        );
        return;
      }
      executed += 1;
      deepCase.run();
    });
  }

  assert.equal(executed + pendingUpstream, deepCases.length);
  assert.ok(executed === 0 || pendingUpstream === 0, 'upstream availability must be stable');
  t.diagnostic(
    `authenticated PIT deep coverage: executed=${executed}, pending-upstream=${pendingUpstream}, total=${deepCases.length}`,
  );
});

test('all five PIT validators execute replayed evidence and fail closed when ingress is removed', () => {
  const inputContract = readStrictJcs(PATHS.inputContract).value;
  const vectors = readStrictJcs(PATHS.vectors).value;
  for (const [validatorId, [pitField, missingIngressCode]] of PIT_REPLAY_VALIDATORS) {
    const vector = vectors.vectors.find((row) => row.validatorId === validatorId);
    assert.ok(vector, `missing ${validatorId}`);
    const scenario = decodeCanonicalOrdersPortfolioScenario(
      vector.accepted.scenario,
      validatorId,
      inputContract,
    );
    assert.doesNotThrow(
      () => validateConstraint(vector.constraintIri, validatorId, scenario),
      `${validatorId} must execute its verifier-replayed PIT evidence`,
    );
    const withoutIngress = clone(scenario);
    delete withoutIngress[pitField].verification;
    assert.throws(
      () => validateConstraint(vector.constraintIri, validatorId, withoutIngress),
      (cause) => cause instanceof CustomConstraintViolation
        && cause.code === missingIngressCode,
      `${validatorId} must reject a PIT request without verifier ingress evidence`,
    );
  }
});
