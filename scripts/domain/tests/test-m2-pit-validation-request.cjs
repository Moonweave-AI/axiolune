'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PITValidationRequestError,
  pitValidationRequestDigest,
  validatePITValidationRequest: validatePITValidationRequestRaw,
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
  buildCompletedMaterializationRunBundleFixture,
} = require('./test-completed-materialization-run-bundle.cjs');
const {
  canonicalJcs,
} = require('../lib/strict-source-locator.cjs');

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function pathRef(root, relativePath) {
  return { kind: 'path', path: relativePath, root };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildBinding() {
  return {
    buildId: digest('1'),
    buildInputsDigest: digest('2'),
    buildInputsRef: pathRef('buildEvidence', 'm2/build-inputs.json'),
    controlRecordPlanDigest: digest('3'),
    controlRecordPlanRef: pathRef('sourceTree', 'scripts/domain/control-record-plan.json'),
    controlRecordSchemaManifestDigest: digest('4'),
    controlRecordSchemaManifestRef: pathRef('sourceTree', 'scripts/domain/control-record-schemas.json'),
    sourceTreeDigest: digest('5'),
    toolLockDigest: digest('6'),
    toolLockRef: pathRef('sourceTree', 'scripts/domain/toolchain.lock.json'),
  };
}

const VALIDATOR_REF = pathRef(
  'sourceTree',
  'scripts/domain/lib/m2-pit-validation-request.cjs',
);

function pitPlannedInput(requestValue = null) {
  const evidence = actualCompletedRunEvidence();
  const validatorDigest = evidence.validator.digest;
  const fields = requestValue || {
    asOfAvailable: '2024-07-10T00:00:02Z',
    asOfKnowledge: '2024-07-10T00:00:01Z',
    asOfValid: '2027-01-01T00:00:00Z',
    attemptId: 'attempt-001',
    requestId: 'request-001',
    slotId: 'pit-validation',
    targetRdfCanonicalization: 'RDFC-1.0',
    validatorDigest,
    validatorRef: VALIDATOR_REF,
  };
  return {
    dependencySelectors: [{
      fieldPointer: '/iri',
      sourceSlotId: evidence.runSlotId,
      sourceStage: 'finalRecord',
    }],
    recordType: 'pitRequest',
    schemaVersion: '1.0',
    staticInputs: {
      asOfAvailable: fields.asOfAvailable,
      asOfKnowledge: fields.asOfKnowledge,
      asOfValid: fields.asOfValid,
      attemptId: fields.attemptId,
      recordId: fields.requestId,
      slotId: fields.slotId,
      targetRdfCanonicalization: fields.targetRdfCanonicalization,
      validatorDigest: fields.validatorDigest,
      validatorRef: fields.validatorRef,
    },
  };
}

let completedRunEvidence;

function actualCompletedRunEvidence() {
  if (!completedRunEvidence) {
    const fixture = buildCompletedMaterializationRunBundleFixture();
    const summary = verifyCompletedMaterializationRunBundle(
      fixture.bundle,
      fixture.expectations,
    );
    const verified = verifiedMaterializationRunContext(summary);
    completedRunEvidence = {
      build: verifiedMaterializationContextBuild(verified),
      context: verified,
      runSlotId: verifiedMaterializationContextRunSlotId(verified),
      requestContext: {
        contextKind: verified.contextKind,
        recordDigest: verified.recordDigest,
        recordRef: verified.recordRef,
        targetGraph: verified.targetGraph,
        targetGraphDigest: verified.targetGraphDigest,
      },
      validator: verifiedMaterializationContextSourceArtifact(verified, VALIDATOR_REF),
    };
  }
  return completedRunEvidence;
}

function runContext() {
  return clone(actualCompletedRunEvidence().requestContext);
}

function batchContext() {
  return {
    contextKind: 'materializationBatchRun',
    recordDigest: digest('9'),
    recordRef: 'urn:axiolune:materialization-batch-run:test-batch',
    targetDataset: 'urn:axiolune:dataset:test-batch',
    targetDatasetDigest: digest('a'),
  };
}

function verifiedContext() {
  return actualCompletedRunEvidence().context;
}

function request(context = runContext()) {
  const value = {
    asOfAvailable: '2024-07-10T00:00:02Z',
    asOfKnowledge: '2024-07-10T00:00:01Z',
    asOfValid: '2027-01-01T00:00:00Z',
    attemptId: 'attempt-001',
    build: clone(actualCompletedRunEvidence().build),
    iri: 'urn:axiolune:pit-request:test-001',
    materializationContext: context,
    plannedInputDigest: digest('c'),
    recordType: 'pitRequest',
    requestId: 'request-001',
    resolvedInputDigest: digest('d'),
    schemaVersion: '1.0',
    slotId: 'pit-validation',
    targetRdfCanonicalization: 'RDFC-1.0',
    validatorDigest: actualCompletedRunEvidence().validator.digest,
    validatorRef: VALIDATOR_REF,
  };
  value.plannedInputDigest = plannedInputDigest('pitRequest', pitPlannedInput(value));
  value.resolvedInputDigest = resolvedInputDigest(value);
  return value;
}

function validatePITValidationRequest(value, context, planned = null) {
  const requestBytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(canonicalJcs(value), 'utf8');
  const selectedPlanned = planned || pitPlannedInput(value);
  const plannedBytes = Buffer.isBuffer(selectedPlanned)
    ? selectedPlanned
    : Buffer.from(canonicalJcs(selectedPlanned), 'utf8');
  return validatePITValidationRequestRaw(requestBytes, context, plannedBytes);
}

function expectCode(fn, expectedCode) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof PITValidationRequestError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

test('accepts an exact completed, ledger-verified MaterializationRun graph binding', () => {
  const context = runContext();
  const value = request(context);
  const result = validatePITValidationRequest(value, verifiedContext(context));
  assert.equal(result.contextKind, 'materializationRun');
  assert.equal(result.recordRef, context.recordRef);
  assert.equal(result.recordDigest, context.recordDigest);
  assert.equal(
    result.requestDigest,
    pitValidationRequestDigest(Buffer.from(canonicalJcs(value), 'utf8')),
  );
  assert.match(result.requestDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('rejects a batch lookalike until a real completed-batch verifier brands it', () => {
  const context = batchContext();
  const lookalike = {
    contextKind: context.contextKind,
    evidenceLedgerRecordDigest: digest('b'),
    evidenceLedgerRef: 'urn:axiolune:evidence-ledger:test',
    ledgerVerified: true,
    outcome: 'completed',
    recordDigest: context.recordDigest,
    recordRef: context.recordRef,
    referenceTime: '2026-08-01T12:00:00.123456789Z',
    targetDataset: context.targetDataset,
    targetDatasetDigest: context.targetDatasetDigest,
    verificationKind: 'verifiedCompletedMaterializationContext',
  };
  expectCode(
    () => validatePITValidationRequest(request(context), lookalike),
    'M2_PIT_CONTEXT_UNVERIFIED',
  );
});

test('rejects the legacy seven-field portfolio request shape', () => {
  const legacy = {
    availableAt: '2026-08-01T12:00:00Z',
    completedAt: '2026-08-01T12:00:00Z',
    knowledgeAt: '2026-08-01T12:00:00Z',
    requestId: 'legacy-request',
    schemaVersion: '1.0',
    status: 'completed',
    validAt: '2026-08-01T12:00:00Z',
  };
  expectCode(
    () => validatePITValidationRequest(legacy, verifiedContext(), pitPlannedInput()),
    'M2_PIT_SCHEMA',
  );
});

test('rejects mixed Run and Batch context branches', () => {
  const value = request();
  value.materializationContext.targetDataset = 'urn:axiolune:dataset:substituted';
  value.materializationContext.targetDatasetDigest = digest('f');
  expectCode(
    () => validatePITValidationRequest(value, verifiedContext()),
    'M2_PIT_CONTEXT_XONE',
  );
});

test('rejects caller-manufactured completed context evidence', () => {
  const evidence = clone(verifiedContext());
  expectCode(
    () => validatePITValidationRequest(request(), evidence),
    'M2_PIT_CONTEXT_UNVERIFIED',
  );
});

test('rejects a caller-manufactured unledgered context', () => {
  const evidence = clone(verifiedContext());
  evidence.ledgerVerified = false;
  expectCode(
    () => validatePITValidationRequest(request(), evidence),
    'M2_PIT_CONTEXT_UNVERIFIED',
  );
});

test('rejects a copied verifier context without the private verifier brand', () => {
  const evidence = clone(verifiedContext());
  delete evidence.evidenceLedgerRecordDigest;
  expectCode(
    () => validatePITValidationRequest(request(), evidence),
    'M2_PIT_CONTEXT_UNVERIFIED',
  );
});

test('rejects a valid-format substituted materialization record digest', () => {
  const value = request();
  value.materializationContext.recordDigest = digest('0');
  expectCode(
    () => validatePITValidationRequest(value, verifiedContext()),
    'M2_PIT_CONTEXT_BINDING',
  );
});

test('rejects a valid-format substituted target graph digest', () => {
  const value = request();
  value.materializationContext.targetGraphDigest = digest('0');
  expectCode(
    () => validatePITValidationRequest(value, verifiedContext()),
    'M2_PIT_CONTEXT_BINDING',
  );
});

test('rejects a valid-format substituted target dataset digest', () => {
  const context = batchContext();
  const evidence = clone(verifiedContext());
  evidence.contextKind = 'materializationBatchRun';
  delete evidence.targetGraph;
  delete evidence.targetGraphDigest;
  evidence.recordRef = context.recordRef;
  evidence.recordDigest = context.recordDigest;
  evidence.targetDataset = context.targetDataset;
  evidence.targetDatasetDigest = context.targetDatasetDigest;
  const value = request(context);
  value.materializationContext.targetDatasetDigest = digest('0');
  expectCode(
    () => validatePITValidationRequest(value, evidence),
    'M2_PIT_CONTEXT_UNVERIFIED',
  );
});

test('rejects a valid-format substituted materialization record reference', () => {
  const value = request();
  value.materializationContext.recordRef = 'urn:axiolune:materialization-run:substituted';
  expectCode(
    () => validatePITValidationRequest(value, verifiedContext()),
    'M2_PIT_CONTEXT_BINDING',
  );
});

test('rejects knowledge pivot after the verifier-bound referenceTime', () => {
  const value = request();
  value.asOfKnowledge = '2026-08-01T12:00:00Z';
  value.plannedInputDigest = plannedInputDigest('pitRequest', pitPlannedInput(value));
  value.resolvedInputDigest = resolvedInputDigest(value);
  expectCode(
    () => validatePITValidationRequest(value, verifiedContext()),
    'M2_PIT_FUTURE_PIVOT',
  );
});

test('rejects availability pivot after the verifier-bound referenceTime', () => {
  const value = request();
  value.asOfAvailable = '2026-08-01T12:00:01Z';
  value.plannedInputDigest = plannedInputDigest('pitRequest', pitPlannedInput(value));
  value.resolvedInputDigest = resolvedInputDigest(value);
  expectCode(
    () => validatePITValidationRequest(value, verifiedContext()),
    'M2_PIT_FUTURE_PIVOT',
  );
});

test('validates all three axes as real canonical UTC instants', () => {
  const value = request();
  value.asOfValid = '2026-02-30T00:00:00Z';
  expectCode(
    () => validatePITValidationRequest(value, verifiedContext()),
    'M2_PIT_INSTANT',
  );
});

test('rejects malformed planned and resolved input digests independently', () => {
  for (const field of ['plannedInputDigest', 'resolvedInputDigest']) {
    const value = request();
    value[field] = digest('A');
    expectCode(
      () => validatePITValidationRequest(value, verifiedContext()),
      'M2_PIT_DIGEST',
    );
  }
});

test('rejects an open or incomplete BuildEvidenceBinding', () => {
  const open = request();
  open.build.unreviewedBuildUrl = 'https://example.invalid/build';
  expectCode(() => validatePITValidationRequest(open, verifiedContext()), 'M2_PIT_BUILD');

  const incomplete = request();
  delete incomplete.build.toolLockDigest;
  expectCode(() => validatePITValidationRequest(incomplete, verifiedContext()), 'M2_PIT_BUILD');
});

test('rejects invalid BuildEvidenceBinding artifact refs and digests', () => {
  const badRef = request();
  badRef.build.buildInputsRef = { kind: 'path', path: '../build-inputs.json', root: 'buildEvidence' };
  expectCode(
    () => validatePITValidationRequest(badRef, verifiedContext()),
    'M2_PIT_ARTIFACT_REF',
  );

  const badDigest = request();
  badDigest.build.controlRecordPlanDigest = digest('F');
  expectCode(
    () => validatePITValidationRequest(badDigest, verifiedContext()),
    'M2_PIT_DIGEST',
  );
});

test('rejects invalid validator ref/digest and canonicalization lock', () => {
  const badRef = request();
  badRef.validatorRef = { kind: 'iri', iri: 'relative/validator' };
  expectCode(
    () => validatePITValidationRequest(badRef, verifiedContext()),
    'M2_PIT_ARTIFACT_REF',
  );

  const badDigest = request();
  badDigest.validatorDigest = digest('E');
  expectCode(
    () => validatePITValidationRequest(badDigest, verifiedContext()),
    'M2_PIT_DIGEST',
  );

  const badCanonicalization = request();
  badCanonicalization.targetRdfCanonicalization = 'implementation-default';
  expectCode(
    () => validatePITValidationRequest(badCanonicalization, verifiedContext()),
    'M2_PIT_CANONICALIZATION',
  );
});

test('rejects open verifier summaries and request/context branch disagreement', () => {
  const openEvidence = clone(verifiedContext());
  openEvidence.unverifiedNote = 'trust me';
  expectCode(
    () => validatePITValidationRequest(request(), openEvidence),
    'M2_PIT_CONTEXT_UNVERIFIED',
  );

  const batchLookalike = clone(verifiedContext());
  batchLookalike.contextKind = 'materializationBatchRun';
  delete batchLookalike.targetGraph;
  delete batchLookalike.targetGraphDigest;
  Object.assign(batchLookalike, batchContext());
  expectCode(
    () => validatePITValidationRequest(request(), batchLookalike),
    'M2_PIT_CONTEXT_UNVERIFIED',
  );
});

test('rejects a valid-format build substitution against the authenticated run build', () => {
  const value = request();
  value.build.buildId = digest('f');
  expectCode(
    () => validatePITValidationRequest(value, verifiedContext()),
    'M2_PIT_BUILD_BINDING',
  );
});

test('rejects a different authenticated JavaScript file as the PIT validator', () => {
  const value = request();
  const substitutedRef = pathRef(
    'sourceTree',
    'scripts/domain/lib/s5-control-record-chain.cjs',
  );
  value.validatorRef = substitutedRef;
  value.validatorDigest = verifiedMaterializationContextSourceArtifact(
    verifiedContext(),
    substitutedRef,
  ).digest;
  const planned = pitPlannedInput(value);
  value.plannedInputDigest = plannedInputDigest('pitRequest', planned);
  expectCode(
    () => validatePITValidationRequest(value, verifiedContext(), planned),
    'M2_PIT_VALIDATOR_BINDING',
  );
});

test('rejects a fully resealed but semantically widened planned input', () => {
  const value = request();
  const planned = pitPlannedInput(value);
  planned.staticInputs.unreviewedOverride = true;
  value.plannedInputDigest = plannedInputDigest('pitRequest', planned);
  expectCode(
    () => validatePITValidationRequest(value, verifiedContext(), planned),
    'M2_PIT_PLANNED_INPUT',
  );
});

test('rejects non-canonical IRIs using the same dialect as the S5 verifier', () => {
  const value = request();
  value.iri = 'HTTPS://EXAMPLE.COM/pit';
  const planned = pitPlannedInput(value);
  value.plannedInputDigest = plannedInputDigest('pitRequest', planned);
  value.resolvedInputDigest = resolvedInputDigest(value);
  expectCode(
    () => validatePITValidationRequest(value, verifiedContext(), planned),
    'M2_PIT_IRI',
  );
});

test('rejects fractional instants to preserve whole-second S5 replay compatibility', () => {
  const value = request();
  value.asOfKnowledge = '2024-07-10T00:00:01.100000000Z';
  const planned = pitPlannedInput(value);
  value.plannedInputDigest = plannedInputDigest('pitRequest', planned);
  value.resolvedInputDigest = resolvedInputDigest(value);
  expectCode(
    () => validatePITValidationRequest(value, verifiedContext(), planned),
    'M2_PIT_INSTANT',
  );
});

test('requires exact JCS bytes and rejects duplicate JSON members', () => {
  const value = request();
  const canonical = canonicalJcs(value);
  expectCode(
    () => validatePITValidationRequest(
      Buffer.from(`${canonical}\n`, 'utf8'),
      verifiedContext(),
      pitPlannedInput(value),
    ),
    'M2_PIT_JCS',
  );

  const needle = `"iri":${JSON.stringify(value.iri)},`;
  const duplicate = canonical.replace(
    needle,
    `${needle}"iri":"urn:axiolune:pit-request:duplicate",`,
  );
  assert.notEqual(duplicate, canonical);
  expectCode(
    () => validatePITValidationRequest(
      Buffer.from(duplicate, 'utf8'),
      verifiedContext(),
      pitPlannedInput(value),
    ),
    'M2_PIT_JCS',
  );
});

test('rejects active objects before reading accessors', () => {
  let getterReads = 0;
  const active = request();
  Object.defineProperty(active, 'iri', {
    enumerable: true,
    get() {
      getterReads += 1;
      return 'urn:axiolune:pit-request:accessor';
    },
  });
  const plannedBytes = Buffer.from(canonicalJcs(pitPlannedInput()), 'utf8');
  expectCode(
    () => validatePITValidationRequestRaw(active, verifiedContext(), plannedBytes),
    'M2_PIT_JCS',
  );
  assert.equal(getterReads, 0);
});
