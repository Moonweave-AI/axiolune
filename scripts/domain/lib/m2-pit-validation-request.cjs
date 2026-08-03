'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const {
  canonicalJcs,
  validateArtifactRef,
} = require('./strict-source-locator.cjs');
const {
  parseJsonRejectingDuplicateMembers,
} = require('./json-pointer-source-extractor.cjs');
const {
  absoluteIri: validateCanonicalIri,
  isVerifiedMaterializationContext,
  instantEpoch: validateWholeSecondInstant,
  plannedInputDigest,
  resolvedInputDigest,
  validatePlannedInput,
  verifiedMaterializationContextBuild,
  verifiedMaterializationContextRunSlotId,
  verifiedMaterializationContextSourceArtifact,
} = require('./s5-control-record-chain.cjs');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PIT_VALIDATOR_REF = Object.freeze({
  kind: 'path',
  path: 'scripts/domain/lib/m2-pit-validation-request.cjs',
  root: 'sourceTree',
});

const REQUEST_FIELDS = [
  'asOfAvailable',
  'asOfKnowledge',
  'asOfValid',
  'attemptId',
  'build',
  'iri',
  'materializationContext',
  'plannedInputDigest',
  'recordType',
  'requestId',
  'resolvedInputDigest',
  'schemaVersion',
  'slotId',
  'targetRdfCanonicalization',
  'validatorDigest',
  'validatorRef',
];

const BUILD_FIELDS = [
  'buildId',
  'buildInputsDigest',
  'buildInputsRef',
  'controlRecordPlanDigest',
  'controlRecordPlanRef',
  'controlRecordSchemaManifestDigest',
  'controlRecordSchemaManifestRef',
  'sourceTreeDigest',
  'toolLockDigest',
  'toolLockRef',
];

const RUN_CONTEXT_FIELDS = [
  'contextKind',
  'recordDigest',
  'recordRef',
  'targetGraph',
  'targetGraphDigest',
];

const BATCH_CONTEXT_FIELDS = [
  'contextKind',
  'recordDigest',
  'recordRef',
  'targetDataset',
  'targetDatasetDigest',
];

const VERIFIED_COMMON_FIELDS = [
  'contextKind',
  'evidenceLedgerRecordDigest',
  'evidenceLedgerRef',
  'ledgerVerified',
  'outcome',
  'recordDigest',
  'recordRef',
  'referenceTime',
  'verificationKind',
];

class PITValidationRequestError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'PITValidationRequestError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PITValidationRequestError(code, message);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, label, code = 'M2_PIT_SCHEMA') {
  if (!isPlainObject(value)) fail(code, `${label} must be a closed object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((field, index) => field !== wanted[index])) {
    const missing = wanted.filter((field) => !actual.includes(field));
    const unknown = actual.filter((field) => !wanted.includes(field));
    fail(
      code,
      `${label} field closure mismatch; missing=[${missing.join(',')}], unknown=[${unknown.join(',')}]`,
    );
  }
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    fail('M2_PIT_DIGEST', `${label} must be a lowercase sha256 digest`);
  }
}

function recordId(value, label) {
  if (typeof value !== 'string' || !RECORD_ID_RE.test(value)) {
    fail('M2_PIT_RECORD_ID', `${label} must be a canonical recordId`);
  }
}

function absoluteIri(value, label) {
  try {
    validateCanonicalIri(value, label);
  } catch (error) {
    fail('M2_PIT_IRI', error.message);
  }
}

function artifactRef(value, label) {
  const result = validateArtifactRef(value, label);
  if (!result.ok) fail('M2_PIT_ARTIFACT_REF', result.errors.join('; '));
}

function instantKey(value, label) {
  try {
    return validateWholeSecondInstant(value, label);
  } catch (error) {
    fail('M2_PIT_INSTANT', error.message);
  }
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
  } else if (isPlainObject(value)) {
    Object.values(value).forEach(deepFreeze);
  }
  return Object.freeze(value);
}

function exactJcsDocument(input, label) {
  if (!Buffer.isBuffer(input)) {
    fail('M2_PIT_JCS', `${label} must be supplied as exact UTF-8 JCS bytes`);
  }
  const bytes = Buffer.from(input);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    fail('M2_PIT_JCS', `${label} is not valid UTF-8: ${error.message}`);
  }
  let value;
  try {
    value = parseJsonRejectingDuplicateMembers(text);
  } catch (error) {
    fail('M2_PIT_JCS', `${label} is not unambiguous JSON: ${error.message}`);
  }
  let canonical;
  try {
    canonical = Buffer.from(canonicalJcs(value), 'utf8');
  } catch (error) {
    fail('M2_PIT_JCS', `${label} is outside the strict JCS profile: ${error.message}`);
  }
  if (!bytes.equals(canonical)) {
    fail('M2_PIT_JCS', `${label} bytes are not exact RFC 8785 JCS`);
  }
  return Object.freeze({ bytes, value: deepFreeze(value) });
}

function validateBuild(value) {
  exactKeys(value, BUILD_FIELDS, 'request.build', 'M2_PIT_BUILD');
  for (const field of [
    'buildId',
    'sourceTreeDigest',
    'toolLockDigest',
    'buildInputsDigest',
    'controlRecordSchemaManifestDigest',
    'controlRecordPlanDigest',
  ]) digest(value[field], `request.build.${field}`);
  for (const field of [
    'toolLockRef',
    'buildInputsRef',
    'controlRecordSchemaManifestRef',
    'controlRecordPlanRef',
  ]) artifactRef(value[field], `request.build.${field}`);
}

function validateMaterializationContext(value) {
  if (!isPlainObject(value)) fail('M2_PIT_CONTEXT_XONE', 'materializationContext must select exactly one closed branch');
  if (value.contextKind === 'materializationRun') {
    if ('targetDataset' in value || 'targetDatasetDigest' in value) {
      fail('M2_PIT_CONTEXT_XONE', 'materializationRun context contains batch-only fields');
    }
    exactKeys(value, RUN_CONTEXT_FIELDS, 'request.materializationContext', 'M2_PIT_CONTEXT_XONE');
    absoluteIri(value.targetGraph, 'request.materializationContext.targetGraph');
    digest(value.targetGraphDigest, 'request.materializationContext.targetGraphDigest');
  } else if (value.contextKind === 'materializationBatchRun') {
    if ('targetGraph' in value || 'targetGraphDigest' in value) {
      fail('M2_PIT_CONTEXT_XONE', 'materializationBatchRun context contains run-only fields');
    }
    exactKeys(value, BATCH_CONTEXT_FIELDS, 'request.materializationContext', 'M2_PIT_CONTEXT_XONE');
    absoluteIri(value.targetDataset, 'request.materializationContext.targetDataset');
    digest(value.targetDatasetDigest, 'request.materializationContext.targetDatasetDigest');
  } else {
    fail('M2_PIT_CONTEXT_XONE', 'materializationContext.contextKind must select Run or BatchRun');
  }
  absoluteIri(value.recordRef, 'request.materializationContext.recordRef');
  digest(value.recordDigest, 'request.materializationContext.recordDigest');
  return value.contextKind;
}

function validateVerifiedContext(value) {
  if (!isVerifiedMaterializationContext(value)) {
    fail(
      'M2_PIT_CONTEXT_UNVERIFIED',
      'verifiedContext must be the in-process result of the completed materialization verifier',
    );
  }
  if (!isPlainObject(value)) {
    fail('M2_PIT_CONTEXT_EVIDENCE', 'verifiedContext must be a closed verifier summary');
  }
  if (value.outcome !== 'completed') {
    fail('M2_PIT_CONTEXT_NOT_COMPLETED', 'verifiedContext does not prove a completed materialization');
  }
  if (value.ledgerVerified !== true
      || !Object.prototype.hasOwnProperty.call(value, 'evidenceLedgerRef')
      || !Object.prototype.hasOwnProperty.call(value, 'evidenceLedgerRecordDigest')) {
    fail('M2_PIT_CONTEXT_UNLEDGERED', 'verifiedContext does not prove exact EvidenceLedger inclusion');
  }
  if (value.verificationKind !== 'verifiedCompletedMaterializationContext') {
    fail('M2_PIT_CONTEXT_EVIDENCE', 'verifiedContext has the wrong verificationKind');
  }

  let targetFields;
  if (value.contextKind === 'materializationRun') {
    targetFields = ['targetGraph', 'targetGraphDigest'];
  } else if (value.contextKind === 'materializationBatchRun') {
    targetFields = ['targetDataset', 'targetDatasetDigest'];
  } else {
    fail('M2_PIT_CONTEXT_EVIDENCE', 'verifiedContext has an unsupported contextKind');
  }
  exactKeys(value, [...VERIFIED_COMMON_FIELDS, ...targetFields], 'verifiedContext', 'M2_PIT_CONTEXT_EVIDENCE');
  absoluteIri(value.recordRef, 'verifiedContext.recordRef');
  digest(value.recordDigest, 'verifiedContext.recordDigest');
  absoluteIri(value.evidenceLedgerRef, 'verifiedContext.evidenceLedgerRef');
  digest(value.evidenceLedgerRecordDigest, 'verifiedContext.evidenceLedgerRecordDigest');
  absoluteIri(value[targetFields[0]], `verifiedContext.${targetFields[0]}`);
  digest(value[targetFields[1]], `verifiedContext.${targetFields[1]}`);
  const referenceTime = instantKey(value.referenceTime, 'verifiedContext.referenceTime');
  return { referenceTime, targetFields };
}

function bindVerifiedContext(requestContext, verifiedContext, targetFields) {
  if (requestContext.contextKind !== verifiedContext.contextKind
      || requestContext.recordRef !== verifiedContext.recordRef
      || requestContext.recordDigest !== verifiedContext.recordDigest
      || requestContext[targetFields[0]] !== verifiedContext[targetFields[0]]
      || requestContext[targetFields[1]] !== verifiedContext[targetFields[1]]) {
    fail(
      'M2_PIT_CONTEXT_BINDING',
      'materializationContext is not an exact record-and-target binding to verifiedContext',
    );
  }
}

function digestBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function pitValidationRequestDigest(requestBytes) {
  return digestBytes(exactJcsDocument(requestBytes, 'request').bytes);
}

/**
 * Validates one M3 PITValidationRequest against a summary produced by an
 * upstream verifier. This function validates the summary contract and exact
 * request binding; it intentionally does not turn an unverified run into a
 * verified one.
 */
function validatePITValidationRequest(requestBytes, verifiedContext, plannedInputBytes) {
  const requestArtifact = exactJcsDocument(requestBytes, 'request');
  const request = requestArtifact.value;
  exactKeys(request, REQUEST_FIELDS, 'request');
  if (request.schemaVersion !== '1.0') fail('M2_PIT_LITERAL', 'request.schemaVersion must equal 1.0');
  if (request.recordType !== 'pitRequest') fail('M2_PIT_LITERAL', 'request.recordType must equal pitRequest');
  if (request.targetRdfCanonicalization !== 'RDFC-1.0') {
    fail('M2_PIT_CANONICALIZATION', 'request.targetRdfCanonicalization must equal RDFC-1.0');
  }

  absoluteIri(request.iri, 'request.iri');
  for (const field of ['slotId', 'requestId', 'attemptId']) recordId(request[field], `request.${field}`);
  for (const field of ['plannedInputDigest', 'resolvedInputDigest', 'validatorDigest']) {
    digest(request[field], `request.${field}`);
  }
  artifactRef(request.validatorRef, 'request.validatorRef');
  validateBuild(request.build);
  validateMaterializationContext(request.materializationContext);

  const asOfValid = instantKey(request.asOfValid, 'request.asOfValid');
  const asOfKnowledge = instantKey(request.asOfKnowledge, 'request.asOfKnowledge');
  const asOfAvailable = instantKey(request.asOfAvailable, 'request.asOfAvailable');
  const verified = validateVerifiedContext(verifiedContext);
  bindVerifiedContext(request.materializationContext, verifiedContext, verified.targetFields);
  const verifiedBuild = verifiedMaterializationContextBuild(verifiedContext);
  if (canonicalJcs(request.build) !== canonicalJcs(verifiedBuild)) {
    fail(
      'M2_PIT_BUILD_BINDING',
      'request.build does not equal the authenticated completed-run build binding',
    );
  }
  const plannedInput = exactJcsDocument(plannedInputBytes, 'plannedInput').value;
  try {
    validatePlannedInput(plannedInput, 'pitRequest', 'plannedInput');
  } catch (error) {
    fail('M2_PIT_PLANNED_INPUT', error.message);
  }
  const expectedPlannedInput = {
    dependencySelectors: [{
      fieldPointer: '/iri',
      sourceSlotId: verifiedMaterializationContextRunSlotId(verifiedContext),
      sourceStage: 'finalRecord',
    }],
    recordType: 'pitRequest',
    schemaVersion: '1.0',
    staticInputs: {
      asOfAvailable: request.asOfAvailable,
      asOfKnowledge: request.asOfKnowledge,
      asOfValid: request.asOfValid,
      attemptId: request.attemptId,
      recordId: request.requestId,
      slotId: request.slotId,
      targetRdfCanonicalization: request.targetRdfCanonicalization,
      validatorDigest: request.validatorDigest,
      validatorRef: request.validatorRef,
    },
  };
  if (canonicalJcs(plannedInput) !== canonicalJcs(expectedPlannedInput)) {
    fail(
      'M2_PIT_PLANNED_INPUT',
      'plannedInput does not equal the exact static request and verified-run dependency plan',
    );
  }
  if (request.plannedInputDigest !== plannedInputDigest('pitRequest', plannedInput)) {
    fail('M2_PIT_PLANNED_INPUT', 'request.plannedInputDigest does not recompute');
  }
  if (request.resolvedInputDigest !== resolvedInputDigest(request)) {
    fail('M2_PIT_RESOLVED_INPUT', 'request.resolvedInputDigest does not recompute');
  }
  let validatorArtifact;
  if (canonicalJcs(request.validatorRef) !== canonicalJcs(PIT_VALIDATOR_REF)) {
    fail(
      'M2_PIT_VALIDATOR_BINDING',
      'validatorRef does not select the canonical PIT validator entrypoint',
    );
  }
  try {
    validatorArtifact = verifiedMaterializationContextSourceArtifact(
      verifiedContext,
      request.validatorRef,
    );
  } catch (error) {
    fail('M2_PIT_VALIDATOR_BINDING', error.message);
  }
  if (request.validatorDigest !== validatorArtifact.digest
      || validatorArtifact.mediaType !== 'application/javascript') {
    fail(
      'M2_PIT_VALIDATOR_BINDING',
      'validator ref/digest/media type do not equal the authenticated source-tree artifact',
    );
  }
  if (asOfKnowledge > verified.referenceTime || asOfAvailable > verified.referenceTime) {
    fail(
      'M2_PIT_FUTURE_PIVOT',
      'asOfKnowledge and asOfAvailable must not exceed the verified materialization referenceTime',
    );
  }

  return Object.freeze({
    asOfAvailable: request.asOfAvailable,
    asOfKnowledge: request.asOfKnowledge,
    asOfValid: request.asOfValid,
    contextKind: request.materializationContext.contextKind,
    recordDigest: request.materializationContext.recordDigest,
    recordRef: request.materializationContext.recordRef,
    requestDigest: digestBytes(requestArtifact.bytes),
    requestIri: request.iri,
  });
}

module.exports = {
  PITValidationRequestError,
  pitValidationRequestDigest,
  validatePITValidationRequest,
};
