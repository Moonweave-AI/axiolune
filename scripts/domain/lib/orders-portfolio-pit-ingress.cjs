'use strict';

const {
  validatePITValidationRequest,
} = require('./m2-pit-validation-request.cjs');
const {
  instantEpoch,
  isVerifiedMaterializationContext,
} = require('./s5-control-record-chain.cjs');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const VERIFIED_REQUEST_INGRESSES = new WeakSet();

const INGRESS_FIELDS = Object.freeze([
  'consumerTemporal',
  'expectedRequestDigest',
  'expectedRequestRef',
  'plannedInputBytes',
  'requestBytes',
  'verifiedContext',
]);

const TEMPORAL_REQUIRED_FIELDS = Object.freeze([
  'availableFrom',
  'knowledgeFrom',
  'validFrom',
]);

const TEMPORAL_OPTIONAL_FIELDS = Object.freeze([
  'revision',
  'validTo',
]);

class OrdersPortfolioPITIngressError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'OrdersPortfolioPITIngressError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new OrdersPortfolioPITIngressError(code, message);
}

function isPlainPassiveObject(value) {
  if (value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => (
    descriptor.enumerable === true
      && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      && descriptor.get === undefined
      && descriptor.set === undefined
  ));
}

function exactPassiveObject(value, required, optional, label, code) {
  if (!isPlainPassiveObject(value)) fail(code, `${label} must be a passive closed object`);
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  const missing = required.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  const unknown = actual.filter((field) => !allowed.has(field));
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      code,
      `${label} field closure mismatch; missing=[${missing.join(',')}], unknown=[${unknown.join(',')}]`,
    );
  }
}

function canonicalDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    fail('ORDERS_PORTFOLIO_PIT_BINDING', `${label} must be a lowercase sha256 digest`);
  }
}

function canonicalIri(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('ORDERS_PORTFOLIO_PIT_BINDING', `${label} must be an absolute canonical IRI`);
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || parsed.href !== value) {
      fail('ORDERS_PORTFOLIO_PIT_BINDING', `${label} must be an absolute canonical IRI`);
    }
  } catch (error) {
    if (error instanceof OrdersPortfolioPITIngressError) throw error;
    fail('ORDERS_PORTFOLIO_PIT_BINDING', `${label} must be an absolute canonical IRI`);
  }
}

function instant(value, label) {
  try {
    return instantEpoch(value, label);
  } catch (error) {
    fail('ORDERS_PORTFOLIO_PIT_TEMPORAL', error.message);
  }
}

function freezePassive(value) {
  if (Array.isArray(value)) value.forEach(freezePassive);
  else if (value && typeof value === 'object') Object.values(value).forEach(freezePassive);
  return Object.freeze(value);
}

/**
 * Establishes request-level PIT ingress for the Orders/Portfolio Custom
 * boundary. The request is independently replayed from exact JCS bytes and
 * must bind to an in-process, private-branded completed MaterializationRun
 * context. This is deliberately non-consumable: it does not prove a passed PIT
 * ValidationReport, selected FactVersion closure, completion, or ledgering of
 * that validation. A caller-authored `{ref,digest,payload}` wrapper can never
 * acquire even this request-only WeakSet brand.
 */
function verifyOrdersPortfolioPITRequestIngress(input) {
  exactPassiveObject(
    input,
    INGRESS_FIELDS,
    [],
    'ingress',
    'ORDERS_PORTFOLIO_PIT_INGRESS_SCHEMA',
  );
  if (!Buffer.isBuffer(input.requestBytes) || !Buffer.isBuffer(input.plannedInputBytes)) {
    fail(
      'ORDERS_PORTFOLIO_PIT_EXACT_BYTES',
      'requestBytes and plannedInputBytes must be exact UTF-8 JCS Buffers',
    );
  }
  if (!isVerifiedMaterializationContext(input.verifiedContext)) {
    fail(
      'ORDERS_PORTFOLIO_PIT_CONTEXT_UNVERIFIED',
      'verifiedContext must carry the completed-run verifier private brand',
    );
  }
  canonicalIri(input.expectedRequestRef, 'expectedRequestRef');
  canonicalDigest(input.expectedRequestDigest, 'expectedRequestDigest');
  exactPassiveObject(
    input.consumerTemporal,
    TEMPORAL_REQUIRED_FIELDS,
    TEMPORAL_OPTIONAL_FIELDS,
    'consumerTemporal',
    'ORDERS_PORTFOLIO_PIT_TEMPORAL',
  );
  if (Object.prototype.hasOwnProperty.call(input.consumerTemporal, 'revision')
      && (!Number.isSafeInteger(input.consumerTemporal.revision)
        || input.consumerTemporal.revision < 0)) {
    fail(
      'ORDERS_PORTFOLIO_PIT_TEMPORAL',
      'consumerTemporal.revision must be a non-negative safe integer',
    );
  }

  // The M3 validator enforces exact JCS, build/source-tree closure, exact
  // MaterializationRun record/target graph binding, ledger inclusion, validator
  // implementation binding, planned/resolved inputs, and all three pivots.
  const verified = validatePITValidationRequest(
    input.requestBytes,
    input.verifiedContext,
    input.plannedInputBytes,
  );
  if (verified.requestIri !== input.expectedRequestRef
      || verified.requestDigest !== input.expectedRequestDigest) {
    fail(
      'ORDERS_PORTFOLIO_PIT_REQUEST_BINDING',
      'canonical record ref/digest do not equal the independently replayed PIT request bytes',
    );
  }

  const consumerValid = instant(input.consumerTemporal.validFrom, 'consumerTemporal.validFrom');
  const consumerKnowledge = instant(
    input.consumerTemporal.knowledgeFrom,
    'consumerTemporal.knowledgeFrom',
  );
  const consumerAvailable = instant(
    input.consumerTemporal.availableFrom,
    'consumerTemporal.availableFrom',
  );
  const pivotValid = instant(verified.asOfValid, 'verified.asOfValid');
  const pivotKnowledge = instant(verified.asOfKnowledge, 'verified.asOfKnowledge');
  const pivotAvailable = instant(verified.asOfAvailable, 'verified.asOfAvailable');
  const contextReferenceTime = instant(
    input.verifiedContext.referenceTime,
    'verifiedContext.referenceTime',
  );

  if (pivotValid > consumerValid
      || pivotKnowledge > consumerKnowledge
      || pivotAvailable > consumerAvailable) {
    fail(
      'ORDERS_PORTFOLIO_PIT_CONSUMER_PIVOT',
      'the exact PIT pivots are later than the consuming FactVersion axes',
    );
  }
  if (contextReferenceTime >= consumerAvailable) {
    fail(
      'ORDERS_PORTFOLIO_PIT_CAUSAL_ORDER',
      'the verified completed-run referenceTime must be strictly prior to consumer availability',
    );
  }

  const result = freezePassive({
    contextKind: verified.contextKind,
    contextRecordDigest: verified.recordDigest,
    contextRecordRef: verified.recordRef,
    digest: verified.requestDigest,
    payload: {
      availableAt: verified.asOfAvailable,
      knowledgeAt: verified.asOfKnowledge,
      validAt: verified.asOfValid,
    },
    pendingRequirement: 'verifier-owned-pit-validation-report-replay',
    ref: verified.requestIri,
    referenceTime: input.verifiedContext.referenceTime,
    releaseConsumable: false,
    verificationKind: 'verifiedOrdersPortfolioPITRequestIngress',
  });
  VERIFIED_REQUEST_INGRESSES.add(result);
  return result;
}

function isVerifiedOrdersPortfolioPITRequestIngress(value) {
  return value !== null
    && typeof value === 'object'
    && VERIFIED_REQUEST_INGRESSES.has(value)
    && Object.isFrozen(value)
    && Object.isFrozen(value.payload);
}

module.exports = {
  OrdersPortfolioPITIngressError,
  isVerifiedOrdersPortfolioPITRequestIngress,
  verifyOrdersPortfolioPITRequestIngress,
};
