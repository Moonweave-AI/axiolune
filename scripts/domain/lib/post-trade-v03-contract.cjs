'use strict';

const crypto = require('node:crypto');
const {
  validateAuthenticatedSourceArtifacts,
} = require('./post-trade-risk-source-artifact-inventory.cjs');
const {
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');

const BASE = 'https://axiolune.ai/ontology/finance/post-trade-operations/';
const MR = 'https://axiolune.ai/ontology/finance/market-rules/';
const FOUNDATION = 'https://axiolune.ai/ontology/finance/foundation/';
const INSTRUMENTS = 'https://axiolune.ai/ontology/finance/instruments/';
const MARKET_DATA = 'https://axiolune.ai/ontology/finance/market-data/';
const ORDERS = 'https://axiolune.ai/ontology/finance/orders-execution/';
const TEMPORAL = 'https://axiolune.ai/ontology/meta/patterns/TemporalFact';
const PROVENANCED = 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact';
const EXACT = 'https://axiolune.ai/ontology/meta/core/constraints/ExactVersionReference';
const LOGICAL = 'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference';

class ContractViolation extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ContractViolation';
    this.code = code;
  }
}

function invariant(condition, code, detail = '') {
  if (!condition) throw new ContractViolation(code, detail);
}

function loadYaml(file) {
  // Keep authoring-only filesystem/YAML dependencies outside the restricted
  // Custom runtime.  The runtime imports this module solely for the pure
  // cross-record validators below and receives already-parsed JSON data.
  const fs = require('node:fs');
  const yaml = require('js-yaml');
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    invariant(Number.isSafeInteger(value), 'unsafe-canonical-number');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  invariant(value && typeof value === 'object', 'unsupported-canonical-value');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function u64be(value) {
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(BigInt(value));
  return result;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
}

function compareCanonical(left, right) {
  return Buffer.from(canonical(left), 'utf8').compare(Buffer.from(canonical(right), 'utf8'));
}

/** RFC-001 section 5.8 `axiolune-iri-set-v1` byte framing. */
function iriSetDigest(values) {
  invariant(Array.isArray(values), 'iri-set-not-array');
  for (const iri of values) validateAbsoluteIri(iri, 'iri-set-invalid-member');
  const sorted = sortedUnique(values);
  invariant(sorted.length === values.length, 'iri-set-duplicate');
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('axiolune-iri-set-v1\0', 'utf8'));
  hash.update(u64be(sorted.length));
  for (const iri of sorted) {
    const bytes = Buffer.from(iri, 'utf8');
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function taggedJcsDigest(tag, value) {
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(`${tag}\0`, 'utf8'));
  hash.update(Buffer.from(canonical(value), 'utf8'));
  return `sha256:${hash.digest('hex')}`;
}

function settlementComparisonKeyDigest(key) {
  return taggedJcsDigest('axiolune-settlement-comparison-key-v1', key);
}

function closureProbeDigest(probe) {
  return taggedJcsDigest('axiolune-closure-probe-v1', {
    ref: probe.ref,
    result: probe.result,
    status: probe.status,
    subjectSetDigest: probe.subjectSetDigest,
  });
}

function sha256Utf8Bytes(bytes) {
  invariant(typeof bytes === 'string', 'artifact-bytes-not-string');
  return `sha256:${crypto.createHash('sha256').update(Buffer.from(bytes, 'utf8')).digest('hex')}`;
}

const MISSING_SIDE_QUERY_FUNCTION_CONTRACT = Object.freeze({
  algorithm: 'filter-exact-input-run-universe-by-three-axis-and-comparison-key-v1',
  functionIri: `${BASE}functions/missing-side-candidate-set/v1`,
  inputKinds: {
    external: 'ExternalSettlementStatementLine',
    internal: 'SettlementReconciliationInternalProjection',
  },
  parameters: [
    'asOfAvailable', 'asOfKnowledge', 'asOfValid', 'caseVersionIri', 'comparatorVersionIri',
    'comparisonKeyDigest', 'expectedSide', 'inputRunRecordDigest', 'inputRunRef', 'keyId',
    'pitRequestRecordDigest', 'pitRequestRef',
  ],
  resultKind: 'sortedExactVersionIriSet',
  schemaVersion: '1.0',
});
const MISSING_SIDE_QUERY_FUNCTION_BYTES = canonical(MISSING_SIDE_QUERY_FUNCTION_CONTRACT);
const MISSING_SIDE_QUERY_FUNCTION_DIGEST = sha256Utf8Bytes(MISSING_SIDE_QUERY_FUNCTION_BYTES);

function missingSideAbsenceProbeDigest(probe) {
  invariant(probe && typeof probe === 'object', 'reconciliation-missing-absence-probe');
  const { digest: _digest, ...digestInput } = probe;
  return taggedJcsDigest('axiolune-missing-side-absence-probe-v1', digestInput);
}

function missingSideInputUniverse(records) {
  invariant(Array.isArray(records), 'reconciliation-missing-input-universe');
  const members = records.map((record) => ({
    recordDigest: taggedJcsDigest('axiolune-missing-side-source-record-v1', record),
    versionIri: record?.versionIri,
  })).sort(compareCanonical);
  for (const member of members) {
    validateAbsoluteIri(member.versionIri, 'reconciliation-missing-input-universe');
    validateDigest(member.recordDigest, 'reconciliation-missing-input-universe');
  }
  invariant(new Set(members.map((member) => member.versionIri)).size === members.length,
    'reconciliation-missing-input-universe');
  return {
    members,
    recordCount: members.length,
    recordSetDigest: taggedJcsDigest('axiolune-missing-side-input-universe-v1', members),
  };
}

function refreshMissingSideRuntimeEvidence(instance) {
  if (!Array.isArray(instance?.missingSideAssertions)
      || instance.missingSideAssertions.length === 0) return instance;
  invariant(instance.missingSideProbeArtifacts?.inputRunBytes,
    'reconciliation-missing-input-run');
  const universes = {
    external: missingSideInputUniverse(instance.externalStatementLines || []),
    internal: missingSideInputUniverse(instance.internalProjections || []),
  };
  const inputRun = JSON.parse(instance.missingSideProbeArtifacts.inputRunBytes);
  inputRun.universes = universes;
  const inputRunBytes = canonical(inputRun);
  const inputRunRecordDigest = sha256Utf8Bytes(inputRunBytes);
  instance.missingSideProbeArtifacts.inputRunBytes = inputRunBytes;
  instance.case.inputContextRecordDigest = inputRunRecordDigest;

  const firstProbe = instance.missingSideAssertions[0].absenceProbe;
  const pitRequest = {
    asOfAvailable: instance.case.reconciliationAsOfAvailable,
    asOfKnowledge: instance.case.reconciliationAsOfKnowledge,
    asOfValid: instance.case.reconciliationAsOfValid,
    caseVersionIri: instance.case.versionIri,
    inputRunRecordDigest,
    inputRunRef: firstProbe.inputRunRef,
    iri: firstProbe.pitRequestRef,
    recordType: 'PointInTimeRequest',
    schemaVersion: '1.0',
  };
  const pitRequestBytes = canonical(pitRequest);
  const pitRequestRecordDigest = sha256Utf8Bytes(pitRequestBytes);
  instance.missingSideProbeArtifacts.pitRequestBytes = pitRequestBytes;

  for (const assertion of instance.missingSideAssertions) {
    const probe = assertion.absenceProbe;
    assertion.inputContextRecordDigest = inputRunRecordDigest;
    assertion.pitRequestRecordDigest = pitRequestRecordDigest;
    probe.inputRunRecordDigest = inputRunRecordDigest;
    probe.pitRequestRecordDigest = pitRequestRecordDigest;
    probe.universeDigest = universes[assertion.expectedSide].recordSetDigest;
    const parameters = {
      asOfAvailable: instance.case.reconciliationAsOfAvailable,
      asOfKnowledge: instance.case.reconciliationAsOfKnowledge,
      asOfValid: instance.case.reconciliationAsOfValid,
      caseVersionIri: instance.case.versionIri,
      comparatorVersionIri: instance.case.comparatorVersionIri,
      comparisonKeyDigest: assertion.comparisonKeyDigest,
      expectedSide: assertion.expectedSide,
      inputRunRecordDigest,
      inputRunRef: probe.inputRunRef,
      keyId: assertion.keyId,
      pitRequestRecordDigest,
      pitRequestRef: probe.pitRequestRef,
    };
    probe.queryParametersBytes = canonical(parameters);
    probe.queryParametersDigest = sha256Utf8Bytes(probe.queryParametersBytes);
    probe.digest = missingSideAbsenceProbeDigest(probe);
    assertion.absenceProbeDigest = probe.digest;
  }
  return instance;
}

function parseExactJcsBytes(bytes, digest, code) {
  invariant(typeof bytes === 'string' && Buffer.byteLength(bytes, 'utf8') <= 1024 * 1024, code);
  validateDigest(digest, code);
  invariant(sha256Utf8Bytes(bytes) === digest, code, 'byte digest mismatch');
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    invariant(false, code, 'invalid JSON bytes');
  }
  invariant(canonical(value) === bytes, code, 'bytes are not exact JCS');
  return value;
}

function findingSubjectDigest(subject) {
  return taggedJcsDigest('axiolune-reconciliation-finding-subject-v1', subject);
}

function parseInstant(value, code) {
  invariant(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value), code, String(value));
  const epoch = Date.parse(value);
  const canonicalInput = value.includes('.') ? value : `${value.slice(0, -1)}.000Z`;
  invariant(Number.isFinite(epoch) && new Date(epoch).toISOString() === canonicalInput, code, value);
  return epoch;
}

function parseDecimal(value) {
  invariant(typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value), 'decimal-lexical', String(value));
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  return normalizeDecimal({ coefficient: (negative ? -1n : 1n) * BigInt(`${whole}${fraction}`), scale: fraction.length });
}

function normalizeDecimal(decimal) {
  let { coefficient, scale } = decimal;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function alignDecimal(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.coefficient * 10n ** BigInt(scale - left.scale),
    right: right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function addDecimal(left, right) {
  const aligned = alignDecimal(left, right);
  return normalizeDecimal({ coefficient: aligned.left + aligned.right, scale: aligned.scale });
}

function subtractDecimal(left, right) {
  return addDecimal(left, { coefficient: -right.coefficient, scale: right.scale });
}

function multiplyDecimal(left, right) {
  return normalizeDecimal({ coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale });
}

function compareDecimal(left, right) {
  const aligned = alignDecimal(left, right);
  return aligned.left < aligned.right ? -1 : aligned.left > aligned.right ? 1 : 0;
}

function decimalString(decimal) {
  const value = normalizeDecimal(decimal);
  const negative = value.coefficient < 0n;
  let digits = (negative ? -value.coefficient : value.coefficient).toString();
  if (value.scale === 0) return `${negative ? '-' : ''}${digits}`;
  digits = digits.padStart(value.scale + 1, '0');
  const split = digits.length - value.scale;
  return `${negative ? '-' : ''}${digits.slice(0, split)}.${digits.slice(split)}`;
}

function equalDecimal(left, right) {
  return compareDecimal(parseDecimal(left), parseDecimal(right)) === 0;
}

function validateAbsoluteIri(value, code) {
  invariant(typeof value === 'string' && value === value.normalize('NFC'), code, String(value));
  try {
    const parsed = new URL(value);
    invariant(parsed.href === value && parsed.protocol.length > 1, code, value);
  } catch {
    invariant(false, code, String(value));
  }
  return value;
}

function validateDigest(value, code) {
  invariant(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value) && !/^sha256:0{64}$/u.test(value), code, String(value));
  return value;
}

function validateCanonicalText(value, code) {
  invariant(typeof value === 'string' && value.length > 0 && value === value.trim()
    && value === value.normalize('NFC') && !/[\u0000-\u001f\u007f]/u.test(value), code, String(value));
  return value;
}

function validateDateLiteral(value, code) {
  invariant(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value), code, String(value));
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  invariant(Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value, code, value);
  return value;
}

function validateArtifactReference(value, code) {
  if (typeof value === 'string') {
    validateAbsoluteIri(value, code);
    return;
  }
  invariant(validateArtifactRef(value, code).ok, code);
}

function validateEvidenceLocator(value, code) {
  if (typeof value === 'string') {
    validateCanonicalText(value, code);
    return;
  }
  invariant(validateSourceLocator(value, { at: code }).ok, code);
}

function validateArtifactEvidence(record, code) {
  validateArtifactReference(record?.sourceArtifactRef, code);
  validateDigest(record?.sourceArtifactDigest, code);
  validateEvidenceLocator(record?.sourceLocator, code);
}

function validateHalfOpenAxis(record, fromField, toField, pivot, code) {
  invariant(isHalfOpenAxisEligible(record, fromField, toField, pivot, code), code);
}

function validateAxisInterval(record, fromField, toField, code) {
  const from = parseInstant(record?.[fromField], code);
  if (hasOwn(record, toField)) invariant(from < parseInstant(record[toField], code), code);
}

function validateThreeAxisIntervals(record, code) {
  validateAxisInterval(record, 'validFrom', 'validTo', `${code}-valid`);
  validateAxisInterval(record, 'knowledgeFrom', 'knowledgeTo', `${code}-knowledge`);
  validateAxisInterval(record, 'availableFrom', 'availableTo', `${code}-availability`);
}

function isHalfOpenAxisEligible(record, fromField, toField, pivot, code) {
  const from = parseInstant(record?.[fromField], code);
  const to = hasOwn(record, toField) ? parseInstant(record[toField], code) : undefined;
  return from <= pivot && (to === undefined || pivot < to);
}

function isThreeAxisEligible(record, pivots, code) {
  return isHalfOpenAxisEligible(record, 'validFrom', 'validTo', pivots.asOfValid, `${code}-valid`)
    && isHalfOpenAxisEligible(record, 'knowledgeFrom', 'knowledgeTo', pivots.asOfKnowledge, `${code}-knowledge`)
    && isHalfOpenAxisEligible(record, 'availableFrom', 'availableTo', pivots.asOfAvailable, `${code}-availability`);
}

function divideDecimal(numerator, denominator, precision, roundingMode) {
  invariant(Number.isSafeInteger(precision) && precision >= 0 && precision <= 18, 'assessment-method-precision');
  invariant(['halfEven', 'halfUp', 'down'].includes(roundingMode), 'assessment-method-rounding');
  invariant(denominator.coefficient !== 0n, 'assessment-formula-zero-denominator');
  const negative = (numerator.coefficient < 0n) !== (denominator.coefficient < 0n);
  const numeratorAbs = numerator.coefficient < 0n ? -numerator.coefficient : numerator.coefficient;
  const denominatorAbs = denominator.coefficient < 0n ? -denominator.coefficient : denominator.coefficient;
  const scaledNumerator = numeratorAbs * 10n ** BigInt(denominator.scale + precision);
  const scaledDenominator = denominatorAbs * 10n ** BigInt(numerator.scale);
  let quotient = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  if (roundingMode !== 'down' && remainder !== 0n) {
    const doubled = remainder * 2n;
    if (doubled > scaledDenominator
      || (doubled === scaledDenominator && (roundingMode === 'halfUp' || quotient % 2n !== 0n))) quotient += 1n;
  }
  return normalizeDecimal({ coefficient: negative ? -quotient : quotient, scale: precision });
}

function resolveCurrentVersions(records, label) {
  invariant(Array.isArray(records), `${label}-versions-not-array`);
  const byVersion = new Map();
  const byLogical = new Map();
  for (const record of records) {
    invariant(record && typeof record.versionIri === 'string', `${label}-missing-version`);
    const logicalIri = record.logicalIri || record.versionIri;
    invariant(!byVersion.has(record.versionIri), `${label}-duplicate-version`, record.versionIri);
    byVersion.set(record.versionIri, record);
    const values = byLogical.get(logicalIri) || [];
    values.push(record);
    byLogical.set(logicalIri, values);
  }
  const result = [];
  for (const [logicalIri, versions] of byLogical) {
    const superseded = new Set();
    for (const record of versions) {
      if (!record.supersedesVersionIri) continue;
      const predecessor = byVersion.get(record.supersedesVersionIri);
      invariant(predecessor && (predecessor.logicalIri || predecessor.versionIri) === logicalIri, `${label}-invalid-supersession`);
      superseded.add(record.supersedesVersionIri);
    }
    const heads = versions.filter((record) => !superseded.has(record.versionIri));
    invariant(heads.length === 1, `${label}-nonlinear-current-head`, logicalIri);
    result.push(heads[0]);
  }
  return result;
}

function resolveCurrentVersionsAtPivots(records, pivots, label) {
  invariant(Array.isArray(records), `${label}-versions-not-array`);
  const byVersion = new Map();
  const byLogical = new Map();
  for (const record of records) {
    invariant(record && typeof record.versionIri === 'string' && typeof record.logicalIri === 'string', `${label}-missing-version`);
    validateAbsoluteIri(record.versionIri, `${label}-version-identity`);
    validateAbsoluteIri(record.logicalIri, `${label}-logical-identity`);
    validateThreeAxisIntervals(record, `${label}-temporal`);
    invariant(!byVersion.has(record.versionIri), `${label}-duplicate-version`, record.versionIri);
    byVersion.set(record.versionIri, record);
    const values = byLogical.get(record.logicalIri) || [];
    values.push(record);
    byLogical.set(record.logicalIri, values);
  }
  for (const record of records) {
    if (!record.supersedesVersionIri) continue;
    const predecessor = byVersion.get(record.supersedesVersionIri);
    invariant(predecessor && predecessor.logicalIri === record.logicalIri, `${label}-invalid-supersession`);
  }

  const result = [];
  for (const [logicalIri, versions] of byLogical) {
    const eligible = versions.filter((record) => isThreeAxisEligible(record, pivots, `${label}-pit`));
    if (eligible.length === 0) continue;
    const eligibleVersions = new Set(eligible.map((record) => record.versionIri));
    const supersededEligible = new Set();
    for (const record of eligible) {
      const walked = new Set([record.versionIri]);
      let predecessorIri = record.supersedesVersionIri;
      while (predecessorIri) {
        invariant(!walked.has(predecessorIri), `${label}-supersession-cycle`, logicalIri);
        walked.add(predecessorIri);
        if (eligibleVersions.has(predecessorIri)) supersededEligible.add(predecessorIri);
        predecessorIri = byVersion.get(predecessorIri)?.supersedesVersionIri;
      }
    }
    const heads = eligible.filter((record) => !supersededEligible.has(record.versionIri));
    invariant(heads.length === 1, `${label}-nonlinear-current-head`, logicalIri);
    result.push(heads[0]);
  }
  return result;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value, required, optional, code) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) invariant(hasOwn(value, key), code, `missing ${key}`);
  for (const key of Object.keys(value)) invariant(allowed.has(key), code, `forbidden ${key}`);
}

function validateCorporateActionEvent(event) {
  invariant(event && typeof event === 'object', 'event-missing');
  invariant(typeof event.sourceAuthorityVersionIri === 'string' && typeof event.affectedSecurityIri === 'string', 'event-authority-security');
  const dates = event.dates || {};
  const allDates = ['announcement', 'ex', 'record', 'payment', 'effective', 'electionDeadline'];
  const requireDates = (required, optional = []) => exactKeys(dates, required, optional, 'event-date-matrix');
  const fields = ['cashPerUnit', 'splitRatio', 'entitlementRatio', 'subscriptionPrice', 'successorSecurityIri', 'nonTransferableDirectSubscription', 'election'];
  const forbid = (...allowed) => {
    const allow = new Set(allowed);
    for (const field of fields) invariant(allow.has(field) || !hasOwn(event, field), 'event-field-matrix', `${event.kind} forbids ${field}`);
  };
  if (event.kind === 'cashDividend') {
    requireDates(['announcement', 'ex', 'record', 'payment']);
    forbid('cashPerUnit');
    invariant(event.cashPerUnit?.currency && compareDecimal(parseDecimal(event.cashPerUnit.amount), parseDecimal('0')) > 0, 'cash-dividend-consideration');
  } else if (event.kind === 'stockSplit') {
    requireDates(['announcement', 'ex', 'record', 'effective']);
    forbid('splitRatio', 'successorSecurityIri');
    invariant(compareDecimal(parseDecimal(event.splitRatio), parseDecimal('0')) > 0, 'stock-split-ratio');
  } else if (event.kind === 'rightsIssue') {
    requireDates(['announcement', 'ex', 'record', 'electionDeadline', 'effective'], ['payment']);
    forbid('entitlementRatio', 'subscriptionPrice', 'successorSecurityIri', 'nonTransferableDirectSubscription', 'election');
    invariant(typeof event.successorSecurityIri === 'string', 'rights-successor-security');
    invariant(compareDecimal(parseDecimal(event.entitlementRatio), parseDecimal('0')) > 0, 'rights-entitlement-ratio');
    invariant(event.subscriptionPrice?.currency && compareDecimal(parseDecimal(event.subscriptionPrice.amount), parseDecimal('0')) > 0, 'rights-subscription-price');
    invariant(event.nonTransferableDirectSubscription === true, 'rights-transferability-profile');
  } else {
    invariant(false, 'event-kind-closed', String(event.kind));
  }
}

function validateCorporateActionMatrix(instance) {
  invariant(Array.isArray(instance.events) && instance.events.length === 3, 'event-matrix-case-count');
  for (const event of instance.events) validateCorporateActionEvent(event);
  invariant(canonical(instance.events.map((event) => event.kind).sort()) === canonical(['cashDividend', 'rightsIssue', 'stockSplit']), 'event-kind-coverage');
}

function validateDistributionAssessment(instance) {
  const assessment = instance?.assessment;
  invariant(assessment && typeof assessment === 'object', 'assessment-missing');
  const event = instance.event;
  const evaluationInput = instance.evaluationInput;
  const applicability = instance.applicability;
  const scheduleRule = instance.scheduleRule;
  const method = instance.method;
  invariant(event && evaluationInput && applicability && scheduleRule && method, 'assessment-input-identity');
  const coreInputs = [
    assessment.evaluationInputVersionIri,
    assessment.eventVersionIri,
    assessment.applicabilityVersionIri,
    assessment.scheduleRuleVersionIri,
    assessment.methodVersionIri,
    assessment.pitContext?.versionIri,
  ];
  invariant(coreInputs.every((iri) => {
    try {
      validateAbsoluteIri(iri, 'assessment-input-identity');
      return true;
    } catch {
      return false;
    }
  }), 'assessment-input-identity');
  invariant(assessment.evaluationInputVersionIri === evaluationInput.versionIri
    && assessment.eventVersionIri === event.versionIri
    && assessment.applicabilityVersionIri === applicability.versionIri
    && assessment.scheduleRuleVersionIri === scheduleRule.versionIri
    && assessment.methodVersionIri === method.versionIri, 'assessment-input-identity');
  invariant(evaluationInput.eventVersionIri === event.versionIri
    && evaluationInput.eventKind === event.kind
    && evaluationInput.affectedSecurityLogicalIri === event.affectedSecurityLogicalIri
    && evaluationInput.listingVersionIri === event.listingVersionIri, 'assessment-chain-join');
  invariant(applicability.scheduleRuleVersionIri === scheduleRule.versionIri
    && applicability.hasDistributionPercentageBoundary === true
    && scheduleRule.assessmentMethodVersionIri === method.versionIri, 'assessment-chain-join');
  invariant(['cashCalculated', 'splitCalculated', 'rightsCalculated', 'officialPercentage'].includes(assessment.inputKind), 'assessment-input-kind');
  invariant(method.inputKind === assessment.inputKind, 'assessment-method-input-kind');
  const markerByKind = {
    cashCalculated: 'cashCalculatedInput', splitCalculated: 'splitCalculatedInput',
    rightsCalculated: 'rightsCalculatedInput', officialPercentage: 'officialPercentageInput',
  };
  const presentMarkers = Object.values(markerByKind).filter((name) => hasOwn(assessment, name));
  invariant(presentMarkers.length === 1 && presentMarkers[0] === markerByKind[assessment.inputKind]
    && assessment[presentMarkers[0]] === true, 'assessment-input-xone');
  validateDigest(method.formulaDigest, 'assessment-method-formula');
  validateDigest(method.implementationDigest, 'assessment-method-implementation');
  validateDigest(method.roundingPolicyDigest, 'assessment-method-rounding');
  invariant(assessment.formulaDigest === method.formulaDigest
    && assessment.implementationDigest === method.implementationDigest
    && assessment.roundingPolicyDigest === method.roundingPolicyDigest, 'assessment-method-join');
  invariant(compareDecimal(parseDecimal(assessment.assessmentPercentage), parseDecimal('0')) > 0, 'assessment-percentage-positive');

  const requiresPrice = assessment.inputKind === 'cashCalculated'
    || (assessment.inputKind === 'rightsCalculated' && method.requiresMarketPrice === true);
  invariant(method.requiresMarketPrice === requiresPrice, 'assessment-method-price-requirement');
  if (requiresPrice) {
    invariant(assessment.priceObservation && typeof assessment.priceObservation.versionIri === 'string', 'assessment-price-observation');
    invariant(['last', 'mid', 'open', 'high', 'low', 'close', 'settlement', 'vwap', 'twap'].includes(assessment.priceKind)
      && assessment.priceKind === assessment.priceObservation.priceKind
      && assessment.priceKind === method.requiredPriceKind, 'assessment-price-kind');
    const valuationPivot = parseInstant(assessment.valuationPivot, 'assessment-valuation-pivot');
    const asOfValid = parseInstant(assessment.pitContext.asOfValid, 'assessment-price-pit');
    const asOfKnowledge = parseInstant(assessment.pitContext.asOfKnowledge, 'assessment-price-pit');
    const asOfAvailable = parseInstant(assessment.pitContext.asOfAvailable, 'assessment-price-pit');
    const queryTime = parseInstant(assessment.pitContext.queryTime, 'assessment-query-time');
    invariant(queryTime === asOfAvailable && valuationPivot === asOfValid, 'assessment-price-pit');
    const observedAt = parseInstant(assessment.priceObservation.observedAt, 'assessment-price-observed-at');
    invariant(method.priceSelection === 'exactAt' ? observedAt === valuationPivot
      : method.priceSelection === 'latestStrictlyBefore' && observedAt < valuationPivot, 'assessment-price-valid-pivot');
    validateHalfOpenAxis(assessment.priceObservation, 'validFrom', 'validTo', asOfValid, 'assessment-price-pit');
    validateHalfOpenAxis(assessment.priceObservation, 'knowledgeFrom', 'knowledgeTo', asOfKnowledge, 'assessment-price-pit');
    validateHalfOpenAxis(assessment.priceObservation, 'availableFrom', 'availableTo', asOfAvailable, 'assessment-price-pit');
    invariant(parseInstant(assessment.priceObservation.validFrom, 'assessment-price-pit') === observedAt, 'assessment-price-valid-pivot');
    invariant(assessment.priceObservation.observedSecurityLogicalIri === event.affectedSecurityLogicalIri
      && assessment.priceObservation.listingVersionIri === event.listingVersionIri, 'assessment-price-subject-join');
    const expectedCurrency = assessment.inputKind === 'cashCalculated'
      ? event.cashPerUnit?.currency : event.subscriptionPrice?.currency;
    invariant(assessment.priceObservation.price?.currency === expectedCurrency, 'assessment-price-currency');
    invariant(compareDecimal(parseDecimal(assessment.priceObservation.price?.amount), parseDecimal('0')) > 0, 'assessment-price-positive');
    validateArtifactEvidence(assessment.priceObservation, 'assessment-price-provenance');
    invariant(!hasOwn(assessment, 'officialAuthorityVersionIri'), 'assessment-source-xone');
    coreInputs.push(assessment.priceObservation.versionIri);

    if (assessment.inputKind === 'cashCalculated') {
      invariant(event.kind === 'cashDividend' && event.cashPerUnit?.currency, 'assessment-event-kind');
      const expected = divideDecimal(
        parseDecimal(event.cashPerUnit.amount), parseDecimal(assessment.priceObservation.price.amount),
        method.precision, method.roundingMode,
      );
      invariant(equalDecimal(assessment.assessmentPercentage, decimalString(expected)), 'assessment-percentage-arithmetic');
    } else {
      invariant(event.kind === 'rightsIssue' && event.subscriptionPrice?.currency === assessment.priceObservation.price.currency,
        'assessment-event-kind');
    }
  } else if (assessment.inputKind === 'officialPercentage') {
    invariant(method.priceSelection === 'notApplicable' && !hasOwn(method, 'requiredPriceKind'), 'assessment-method-price-requirement');
    invariant(typeof assessment.officialAuthorityVersionIri === 'string'
      && typeof assessment.officialArtifactRef === 'string'
      && typeof assessment.officialLocator === 'string' && assessment.officialLocator.length > 0, 'assessment-official-evidence');
    validateAbsoluteIri(assessment.officialAuthorityVersionIri, 'assessment-official-evidence');
    validateAbsoluteIri(assessment.officialArtifactRef, 'assessment-official-evidence');
    validateDigest(assessment.officialArtifactDigest, 'assessment-official-evidence');
    invariant(!hasOwn(assessment, 'priceObservation') && !hasOwn(assessment, 'priceKind') && !hasOwn(assessment, 'valuationPivot'), 'assessment-source-xone');
    coreInputs.push(assessment.officialAuthorityVersionIri);
  } else {
    invariant(method.priceSelection === 'notApplicable' && !hasOwn(method, 'requiredPriceKind'), 'assessment-method-price-requirement');
    invariant(!hasOwn(assessment, 'priceObservation') && !hasOwn(assessment, 'priceKind')
      && !hasOwn(assessment, 'valuationPivot') && !hasOwn(assessment, 'officialAuthorityVersionIri')
      && !hasOwn(assessment, 'officialArtifactRef') && !hasOwn(assessment, 'officialArtifactDigest')
      && !hasOwn(assessment, 'officialLocator'), 'assessment-source-xone');
    invariant((assessment.inputKind === 'splitCalculated' && event.kind === 'stockSplit')
      || (assessment.inputKind === 'rightsCalculated' && event.kind === 'rightsIssue'), 'assessment-event-kind');
  }
  const expectedInputs = sortedUnique(coreInputs);
  invariant(expectedInputs.length === coreInputs.length, 'assessment-input-duplicate');
  invariant(canonical(assessment.inputVersionIris) === canonical(expectedInputs), 'assessment-input-version-set');
  invariant(assessment.inputVersionCount === expectedInputs.length, 'assessment-input-version-count');
  invariant(assessment.inputVersionSetDigest === iriSetDigest(expectedInputs), 'assessment-input-version-digest');
}

function validateCompletedProbe(probe, code, subjectSetDigest) {
  invariant(probe && probe.status === 'completed' && probe.result === true, code);
  invariant(typeof probe.ref === 'string' && /^https?:\/\//u.test(probe.ref), code);
  invariant(typeof probe.digest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(probe.digest), code);
  invariant(!/^sha256:0{64}$/u.test(probe.digest), code);
  if (subjectSetDigest !== undefined) {
    invariant(probe.subjectSetDigest === subjectSetDigest, code);
    invariant(probe.digest === closureProbeDigest(probe), code);
  }
}

function validateEconomicPartyRoleSet(roles, account, party, code) {
  invariant(Array.isArray(roles) && roles.length > 0, code);
  const versions = new Set();
  for (const role of roles) {
    invariant(role && typeof role.versionIri === 'string' && !versions.has(role.versionIri), code);
    validateAbsoluteIri(role.versionIri, code);
    validateAbsoluteIri(role.account, code);
    validateAbsoluteIri(role.party, code);
    versions.add(role.versionIri);
    invariant(role.pitEligible === true, code);
    invariant(role.account === account && role.party === party, code);
    invariant(['accountHolder', 'beneficialOwner'].includes(role.kind), code);
  }
}

function assetCompatible(left, right, code) {
  invariant(left?.kind === right?.kind, code);
  if (left.kind === 'money') invariant(left.currency === right.currency, code);
  else invariant(left.unit === right.unit && left.instrumentIri === right.instrumentIri, code);
}

function validateDueBillTransferRecord(transfer, obligation, pivots) {
  invariant(obligation, 'transfer-obligation-join');
  validateAbsoluteIri(transfer.logicalIri, 'transfer-identity');
  validateAbsoluteIri(transfer.versionIri, 'transfer-identity');
  validateAbsoluteIri(transfer.transferAuthorityVersionIri, 'transfer-authority');
  validateCanonicalText(transfer.authorityScopedId, 'transfer-authority');
  const transferTime = parseInstant(transfer.transferTime, 'transfer-time');
  validateThreeAxisIntervals(transfer, 'transfer-temporal');
  invariant(transferTime <= pivots.asOfValid, 'transfer-time-after-pit');
  invariant(transfer.fromAccount === obligation.liableAccount && transfer.toAccount === obligation.beneficiaryAccount,
    'transfer-endpoint-join');
  invariant(transfer.fromParty === obligation.liableParty && transfer.toParty === obligation.beneficiaryParty,
    'transfer-party-endpoint-join');
  assetCompatible(transfer.asset, obligation.benefit, 'transfer-asset-join');
  invariant(['pending', 'completed', 'failed', 'cancelled'].includes(transfer.state), 'transfer-state-closed');
  invariant(compareDecimal(parseDecimal(transfer.asset.amount), parseDecimal('0')) > 0, 'transfer-amount-positive');
  validateAbsoluteIri(transfer.movementEvidenceIri, 'transfer-movement-evidence');
  validateDigest(transfer.movementEvidenceDigest, 'transfer-movement-evidence');
  validateArtifactReference(transfer.sourceArtifactRef, 'transfer-source-evidence');
  validateDigest(transfer.sourceArtifactDigest, 'transfer-source-evidence');
  validateEvidenceLocator(transfer.sourceLocator, 'transfer-source-evidence');
}

function validateDueBillQualification(qualification, event, resolution, pivots) {
  validateAbsoluteIri(qualification.versionIri, 'due-bill-qualification-identity');
  invariant(qualification.eventVersionIri === event.versionIri
    && qualification.resolutionVersionIri === resolution.versionIri, 'due-bill-qualification-event-resolution');
  invariant(qualification.result === 'eligible', 'due-bill-qualification-result');
  validateAbsoluteIri(qualification.generatingContextRef, 'due-bill-qualification-context');
  validateThreeAxisIntervals(qualification, 'due-bill-qualification-temporal');
  invariant(isThreeAxisEligible(qualification, pivots, 'due-bill-qualification-pit'), 'due-bill-qualification-pit');

  const execution = qualification.execution;
  const allocation = qualification.allocation;
  const instruction = qualification.instruction;
  const leg = qualification.securityLeg;
  for (const [record, code] of [
    [execution, 'due-bill-qualification-execution'], [allocation, 'due-bill-qualification-allocation'],
    [instruction, 'due-bill-qualification-instruction'], [leg, 'due-bill-qualification-leg'],
  ]) {
    invariant(record && typeof record === 'object', code);
    validateAbsoluteIri(record.versionIri, code);
  }
  invariant(allocation.executionVersionIri === execution.versionIri
    && allocation.instructionVersionIri === instruction.versionIri
    && allocation.securityLegVersionIri === leg.versionIri
    && leg.instructionVersionIri === instruction.versionIri, 'due-bill-qualification-source-join');
  invariant(instruction.method === 'deliveryVersusPayment', 'due-bill-qualification-instruction');
  validateAbsoluteIri(instruction.securitiesDeliverer, 'due-bill-qualification-instruction');
  validateAbsoluteIri(instruction.securitiesReceiver, 'due-bill-qualification-instruction');
  validateCanonicalText(instruction.atomicGroupId, 'due-bill-qualification-instruction');
  validateCanonicalText(instruction.system, 'due-bill-qualification-instruction');
  validateCanonicalText(instruction.location, 'due-bill-qualification-instruction');
  const instructionLegs = instruction.legs || [];
  const instructionSecuritiesLegs = instructionLegs.filter(
    (item) => item?.asset?.kind === 'security',
  );
  const instructionCashLegs = instructionLegs.filter(
    (item) => item?.asset?.kind === 'money',
  );
  invariant(
    instructionLegs.length === 2
      && instructionSecuritiesLegs.length === 1
      && instructionCashLegs.length === 1,
    'due-bill-qualification-instruction',
  );
  for (const instructionLeg of instructionLegs) {
    validateAbsoluteIri(instructionLeg.versionIri, 'due-bill-qualification-instruction-leg');
    invariant(
      instructionLeg.instructionVersionIri === instruction.versionIri
        && instructionLeg.atomicGroupId === instruction.atomicGroupId,
      'due-bill-qualification-instruction-leg',
    );
    for (const field of ['fromParty', 'toParty', 'fromAccount', 'toAccount']) {
      validateAbsoluteIri(
        instructionLeg[field],
        'due-bill-qualification-instruction-leg',
      );
    }
    invariant(
      instructionLeg.fromParty !== instructionLeg.toParty
        && instructionLeg.fromAccount !== instructionLeg.toAccount
        && compareDecimal(
          parseDecimal(instructionLeg.asset?.amount),
          parseDecimal('0'),
        ) > 0,
      'due-bill-qualification-instruction-leg',
    );
  }
  const instructionSecurityLeg = instructionSecuritiesLegs[0];
  const instructionCashLeg = instructionCashLegs[0];
  invariant(
    instructionSecurityLeg.versionIri === leg.versionIri
      && instructionSecurityLeg.fromParty === instruction.securitiesDeliverer
      && instructionSecurityLeg.toParty === instruction.securitiesReceiver
      && instructionCashLeg.fromParty === instruction.securitiesReceiver
      && instructionCashLeg.toParty === instruction.securitiesDeliverer,
    'due-bill-qualification-instruction',
  );
  invariant(execution.instrumentIri === event.affectedSecurityIri
    && leg.asset?.kind === 'security' && leg.asset.instrumentIri === event.affectedSecurityIri,
  'due-bill-qualification-security');
  const executionQuantity = parseDecimal(execution.quantity);
  const allocationQuantity = parseDecimal(allocation.quantity?.amount);
  invariant(compareDecimal(executionQuantity, parseDecimal('0')) > 0
    && compareDecimal(allocationQuantity, parseDecimal('0')) > 0
    && compareDecimal(parseDecimal(leg.asset.amount), parseDecimal('0')) > 0
    && equalDecimal(decimalString(executionQuantity), decimalString(allocationQuantity))
    && equalDecimal(decimalString(allocationQuantity), qualification.qualifiedQuantity)
    && allocation.quantity.unit === leg.asset.unit, 'due-bill-qualification-quantity');
  const occurrence = parseInstant(execution.occurrenceTime, 'due-bill-qualification-occurrence');
  const intervalStart = parseInstant(resolution.cumEntitlementTradeFrom, 'due-bill-resolution-interval');
  const intervalEnd = parseInstant(resolution.cumEntitlementTradeTo, 'due-bill-resolution-interval');
  invariant(intervalStart <= occurrence && occurrence < intervalEnd, 'due-bill-qualification-interval');
  invariant(['buy', 'sell'].includes(execution.side), 'due-bill-qualification-side');
  invariant(allocation.fromEconomicAccount !== allocation.toEconomicAccount,
    'due-bill-qualification-economic-endpoints');
  invariant(execution.account === (execution.side === 'buy'
    ? allocation.toEconomicAccount : allocation.fromEconomicAccount), 'due-bill-qualification-direction');
  invariant(qualification.liableAccount === allocation.fromEconomicAccount
    && qualification.beneficiaryAccount === allocation.toEconomicAccount,
  'due-bill-qualification-economic-endpoints');
  validateEconomicPartyRoleSet(
    qualification.liableAccountPartyRoles, qualification.liableAccount,
    qualification.liableParty, 'due-bill-qualification-liable-party-role',
  );
  validateEconomicPartyRoleSet(
    qualification.beneficiaryAccountPartyRoles, qualification.beneficiaryAccount,
    qualification.beneficiaryParty, 'due-bill-qualification-beneficiary-party-role',
  );

  const bridges = new Map((qualification.bridges || []).map((bridge) => [bridge.versionIri, bridge]));
  for (const side of ['from', 'to']) {
    const economicAccount = allocation[`${side}EconomicAccount`];
    const settlementAccount = leg[`${side}Account`];
    const mode = allocation[`${side}Mode`];
    if (mode === 'directAccount') {
      invariant(economicAccount === settlementAccount && !hasOwn(allocation, `${side}BridgeVersionIri`),
        `due-bill-qualification-${side}-direct-xone`);
    } else {
      invariant(mode === 'custodyOrOmnibus' && economicAccount !== settlementAccount,
        `due-bill-qualification-${side}-bridge-xone`);
      validateBridge(
        bridges.get(allocation[`${side}BridgeVersionIri`]), economicAccount, settlementAccount, instruction,
        `due-bill-qualification-${side}-bridge-join`,
      );
    }
  }

  const settlementEvidence = qualification.settlementEvidence === true;
  const executionOnly = qualification.executionOnlyQualification === true;
  invariant(settlementEvidence !== executionOnly
    && settlementEvidence === (resolution.qualificationMode === 'settlementEvidence'),
  'due-bill-qualification-evidence-xone');
  if (settlementEvidence) {
    const status = qualification.settlementStatusEvent;
    invariant(status && typeof status === 'object', 'due-bill-qualification-status');
    validateAbsoluteIri(status.versionIri, 'due-bill-qualification-status');
    invariant(status.instructionVersionIri === instruction.versionIri
      && status.subject === 'group' && status.atomicGroupId === instruction.atomicGroupId
      && status.state === 'settled'
      && !hasOwn(status, 'atomicCompletion'),
    'due-bill-qualification-status');
    validateAbsoluteIri(
      status.atomicCompletionEvidenceRef,
      'due-bill-qualification-status',
    );
    validateDigest(
      status.atomicCompletionEvidenceDigest,
      'due-bill-qualification-status',
    );
    invariant(
      status.atomicCompletionEvidenceDigest
        === iriSetDigest(instructionLegs.map((item) => item.versionIri)),
      'due-bill-qualification-status',
    );
    const statusTime = parseInstant(status.observedAt, 'due-bill-qualification-status-time');
    invariant(statusTime <= parseInstant(resolution.settlementEvidenceCutoff, 'due-bill-resolution-settlement-cutoff'),
      'due-bill-qualification-status-time');
    validateThreeAxisIntervals(status, 'due-bill-qualification-status-temporal');
    invariant(isThreeAxisEligible(status, pivots, 'due-bill-qualification-status-pit'),
      'due-bill-qualification-status-pit');
    validateArtifactEvidence(status, 'due-bill-qualification-status-source');
  } else invariant(!hasOwn(qualification, 'settlementStatusEvent'), 'due-bill-qualification-evidence-xone');
  return {
    beneficiaryAccount: qualification.beneficiaryAccount,
    beneficiaryParty: qualification.beneficiaryParty,
    liableAccount: qualification.liableAccount,
    liableParty: qualification.liableParty,
    quantity: qualification.qualifiedQuantity,
  };
}

function validateDueBill(instance) {
  invariant(instance.mode === 'dueBillAdjusted', 'due-bill-mode');
  invariant(Array.isArray(instance.obligations) && Array.isArray(instance.entitlements), 'due-bill-inventory');
  const pitRequest = instance.transferPitRequest;
  invariant(pitRequest && typeof pitRequest === 'object', 'transfer-pit-request');
  validateAbsoluteIri(pitRequest.ref, 'transfer-pit-request');
  validateDigest(pitRequest.recordDigest, 'transfer-pit-request');
  validateAbsoluteIri(pitRequest.inputContextRef, 'transfer-pit-request');
  validateDigest(pitRequest.inputContextRecordDigest, 'transfer-pit-request');
  const transferPivots = {
    asOfValid: parseInstant(pitRequest.asOfValid, 'transfer-pit-request'),
    asOfKnowledge: parseInstant(pitRequest.asOfKnowledge, 'transfer-pit-request'),
    asOfAvailable: parseInstant(pitRequest.asOfAvailable, 'transfer-pit-request'),
  };
  const event = instance.event;
  const resolution = instance.resolution;
  invariant(event && resolution, 'due-bill-event-resolution');
  validateAbsoluteIri(event.versionIri, 'due-bill-event-resolution');
  validateAbsoluteIri(resolution.versionIri, 'due-bill-event-resolution');
  invariant(event.versionIri === instance.eventVersionIri
    && resolution.versionIri === instance.resolutionVersionIri
    && resolution.eventVersionIri === event.versionIri, 'due-bill-event-resolution');
  invariant(['cashDividend', 'stockSplit', 'rightsIssue'].includes(event.kind)
    && resolution.dueBillRequired === true, 'due-bill-event-kind-resolution');
  validateAbsoluteIri(event.affectedSecurityIri, 'due-bill-event-security');
  if (resolution.dtcServiceProfile === 'interimAccounting' && event.kind === 'stockSplit') {
    invariant(resolution.failTrackingEligible === false, 'due-bill-dtc-profile');
  }
  const qualifications = new Map();
  for (const qualification of instance.qualifications || []) {
    invariant(!qualifications.has(qualification.versionIri), 'due-bill-qualification-duplicate');
    qualifications.set(
      qualification.versionIri,
      { record: qualification, derived: validateDueBillQualification(qualification, event, resolution, transferPivots) },
    );
  }
  const obligationByVersion = new Map();
  for (const obligation of instance.obligations) {
    validateAbsoluteIri(obligation.versionIri, 'obligation-identity');
    invariant(!obligationByVersion.has(obligation.versionIri), 'obligation-duplicate-version');
    invariant(obligation.eventVersionIri === instance.eventVersionIri && obligation.resolutionVersionIri === instance.resolutionVersionIri, 'obligation-event-resolution-join');
    invariant(obligation.liableAccount !== obligation.beneficiaryAccount, 'obligation-self-transfer');
    invariant(typeof obligation.liableParty === 'string' && typeof obligation.beneficiaryParty === 'string' && obligation.liableParty !== obligation.beneficiaryParty, 'obligation-party-distinct');
    validateEconomicPartyRoleSet(obligation.liableAccountPartyRoles, obligation.liableAccount, obligation.liableParty, 'obligation-liable-party-role');
    validateEconomicPartyRoleSet(obligation.beneficiaryAccountPartyRoles, obligation.beneficiaryAccount, obligation.beneficiaryParty, 'obligation-beneficiary-party-role');
    invariant(compareDecimal(parseDecimal(obligation.quantity), parseDecimal('0')) > 0, 'obligation-quantity-positive');
    invariant(compareDecimal(parseDecimal(obligation.benefit.amount), parseDecimal('0')) > 0, 'obligation-benefit-positive');
    invariant(obligation.obligationSecurityIri === event.affectedSecurityIri, 'obligation-security-join');
    const tradeDerived = obligation.sourceKind === 'tradeDerived';
    const externalClaim = obligation.sourceKind === 'externalClaim';
    invariant(tradeDerived !== externalClaim, 'obligation-source-xone');
    if (tradeDerived) {
      invariant(!hasOwn(obligation, 'externalClaimId') && !hasOwn(obligation, 'claimAuthorityVersionIri')
        && !hasOwn(obligation, 'sourceArtifactRef') && !hasOwn(obligation, 'sourceArtifactDigest')
        && !hasOwn(obligation, 'sourceLocator'), 'obligation-source-xone');
      const qualification = qualifications.get(obligation.tradeQualificationVersionIri);
      invariant(qualification?.record.result === 'eligible', 'obligation-trade-qualification');
      const derived = qualification.derived;
      invariant(obligation.liableAccount === derived.liableAccount
        && obligation.beneficiaryAccount === derived.beneficiaryAccount
        && obligation.liableParty === derived.liableParty
        && obligation.beneficiaryParty === derived.beneficiaryParty
        && equalDecimal(obligation.quantity, derived.quantity), 'obligation-trade-derived-endpoints');
    } else {
      invariant(!hasOwn(obligation, 'tradeQualificationVersionIri'), 'obligation-source-xone');
      validateAbsoluteIri(obligation.claimAuthorityVersionIri, 'obligation-external-claim');
      validateCanonicalText(obligation.externalClaimId, 'obligation-external-claim');
      validateArtifactEvidence(obligation, 'obligation-external-claim');
    }
    if (event.kind === 'cashDividend') {
      const expected = multiplyDecimal(parseDecimal(obligation.quantity), parseDecimal(event.cashPerUnit.amount));
      invariant(obligation.benefit.kind === 'money' && obligation.benefit.currency === event.cashPerUnit.currency
        && equalDecimal(obligation.benefit.amount, decimalString(expected)), 'obligation-benefit-arithmetic');
    } else {
      const ratio = event.kind === 'stockSplit' ? resolution.splitDeltaRatio : event.entitlementRatio;
      const expected = multiplyDecimal(parseDecimal(obligation.quantity), parseDecimal(ratio));
      invariant(obligation.benefit.kind === 'quantity'
        && obligation.benefit.instrumentIri === resolution.distributionInstrumentIri
        && obligation.benefit.unit === resolution.distributionUnit
        && equalDecimal(obligation.benefit.amount, decimalString(expected)), 'obligation-benefit-arithmetic');
    }
    obligationByVersion.set(obligation.versionIri, obligation);
  }
  const usedQualifications = sortedUnique(instance.obligations
    .filter((obligation) => obligation.sourceKind === 'tradeDerived')
    .map((obligation) => obligation.tradeQualificationVersionIri));
  invariant(canonical(usedQualifications) === canonical(sortedUnique([...qualifications.keys()])),
    'due-bill-qualification-closure');

  const appearances = new Map([...obligationByVersion.keys()].map((iri) => [iri, { outgoing: 0, incoming: 0 }]));
  for (const entitlement of instance.entitlements) {
    const incident = instance.obligations.filter((obligation) => obligation.liableAccount === entitlement.account || obligation.beneficiaryAccount === entitlement.account);
    const expectedIris = sortedUnique(incident.map((obligation) => obligation.versionIri));
    const expectedSetDigest = iriSetDigest(expectedIris);
    validateCompletedProbe(entitlement.closureProbe, 'entitlement-obligation-closure-probe', expectedSetDigest);
    invariant(canonical(entitlement.obligationVersionIris) === canonical(expectedIris), 'entitlement-obligation-set');
    invariant(entitlement.obligationCount === expectedIris.length, 'entitlement-obligation-count');
    invariant(entitlement.obligationSetDigest === expectedSetDigest, 'entitlement-obligation-set-digest');
    let eligible = parseDecimal(entitlement.recordPosition.quantity);
    if (entitlement.recordPosition.kind === 'provenZero') {
      invariant(equalDecimal(entitlement.recordPosition.quantity, '0') && typeof entitlement.recordPosition.absenceAssertionVersionIri === 'string', 'entitlement-proven-zero');
    } else {
      invariant(entitlement.recordPosition.kind === 'snapshot' && typeof entitlement.recordPosition.snapshotVersionIri === 'string', 'entitlement-record-evidence');
    }
    for (const obligation of incident) {
      if (obligation.liableAccount === entitlement.account) {
        appearances.get(obligation.versionIri).outgoing += 1;
        eligible = subtractDecimal(eligible, parseDecimal(obligation.quantity));
      } else {
        appearances.get(obligation.versionIri).incoming += 1;
        eligible = addDecimal(eligible, parseDecimal(obligation.quantity));
      }
    }
    invariant(equalDecimal(entitlement.eligibleQuantity, decimalString(eligible)), 'entitlement-eligible-arithmetic');
  }
  for (const [iri, counts] of appearances) {
    invariant(counts.outgoing === 1 && counts.incoming === 1, 'obligation-bilateral-appearance', iri);
  }

  const transferIdentityKeys = new Map();
  for (const transfer of instance.transfers || []) {
    const obligation = obligationByVersion.get(transfer.obligationVersionIri);
    validateDueBillTransferRecord(transfer, obligation, transferPivots);
    const identityKey = `${transfer.transferAuthorityVersionIri}\0${transfer.authorityScopedId}`;
    const priorLogical = transferIdentityKeys.get(identityKey);
    invariant(priorLogical === undefined || priorLogical === transfer.logicalIri, 'transfer-logical-identity');
    transferIdentityKeys.set(identityKey, transfer.logicalIri);
  }
  const currentTransfers = resolveCurrentVersionsAtPivots(instance.transfers || [], transferPivots, 'transfer');
  invariant(Array.isArray(instance.transferClosures), 'transfer-closure-inventory');
  const closures = new Map();
  for (const closure of instance.transferClosures) {
    invariant(closure && typeof closure.obligationVersionIri === 'string', 'transfer-closure-obligation');
    invariant(obligationByVersion.has(closure.obligationVersionIri), 'transfer-closure-obligation');
    invariant(!closures.has(closure.obligationVersionIri), 'transfer-closure-duplicate', closure.obligationVersionIri);
    validateAbsoluteIri(closure.versionIri, 'transfer-closure-identity');
    validateAbsoluteIri(closure.pitRequestRef, 'transfer-closure-pit-context');
    validateDigest(closure.pitRequestRecordDigest, 'transfer-closure-pit-context');
    validateAbsoluteIri(closure.inputContextRef, 'transfer-closure-input-context');
    validateDigest(closure.inputContextRecordDigest, 'transfer-closure-input-context');
    invariant(closure.pitRequestRef === pitRequest.ref && closure.pitRequestRecordDigest === pitRequest.recordDigest,
      'transfer-closure-pit-context');
    invariant(closure.inputContextRef === pitRequest.inputContextRef
      && closure.inputContextRecordDigest === pitRequest.inputContextRecordDigest, 'transfer-closure-input-context');
    validateAbsoluteIri(closure.generatingContextRef, 'transfer-closure-generating-context');
    closures.set(closure.obligationVersionIri, closure);
  }
  invariant(closures.size === instance.obligations.length, 'transfer-closure-cardinality');
  const globalEvidenceIris = new Set();
  const globalEvidenceDigests = new Set();
  for (const obligation of instance.obligations) {
    const transfers = currentTransfers.filter((transfer) => transfer.obligationVersionIri === obligation.versionIri);
    const closure = closures.get(obligation.versionIri);
    invariant(closure, 'transfer-closure-missing', obligation.versionIri);
    const currentIris = sortedUnique(transfers.map((transfer) => transfer.versionIri));
    const currentSetDigest = iriSetDigest(currentIris);
    validateCompletedProbe(closure.closureProbe, 'transfer-closure-probe', currentSetDigest);
    invariant(canonical(closure.transferVersionIris) === canonical(currentIris), 'transfer-current-version-set');
    invariant(closure.transferCount === currentIris.length, 'transfer-current-version-count');
    invariant(closure.transferSetDigest === currentSetDigest, 'transfer-current-version-digest');
    let fulfilled = parseDecimal('0');
    for (const transfer of transfers) {
      invariant(
        typeof transfer.movementEvidenceIri === 'string'
          && !globalEvidenceIris.has(transfer.movementEvidenceIri)
          && !globalEvidenceDigests.has(transfer.movementEvidenceDigest),
        'transfer-evidence-unique',
      );
      globalEvidenceIris.add(transfer.movementEvidenceIri);
      globalEvidenceDigests.add(transfer.movementEvidenceDigest);
      if (transfer.state === 'completed') fulfilled = addDecimal(fulfilled, parseDecimal(transfer.asset.amount));
    }
    const benefit = parseDecimal(obligation.benefit.amount);
    invariant(compareDecimal(fulfilled, parseDecimal('0')) >= 0, 'transfer-negative-fulfillment');
    invariant(compareDecimal(fulfilled, benefit) <= 0, 'transfer-over-fulfillment');
    const remaining = subtractDecimal(benefit, fulfilled);
    const result = compareDecimal(fulfilled, parseDecimal('0')) === 0 ? 'unfulfilled'
      : compareDecimal(fulfilled, benefit) === 0 ? 'fullyFulfilled' : 'partiallyFulfilled';
    invariant(closure.result === result, 'transfer-closure-result');
    invariant(equalDecimal(closure.fulfilledAmount, decimalString(fulfilled)), 'transfer-closure-fulfilled');
    invariant(equalDecimal(closure.remainingAmount, decimalString(remaining)), 'transfer-closure-remaining');
  }
}

function validateElectionProviderPolicy(policy, event, pivots) {
  invariant(policy && typeof policy.versionIri === 'string' && typeof policy.policyAuthorityVersionIri === 'string', 'rights-provider-policy');
  invariant(typeof event.versionIri === 'string' && typeof event.sourceAuthorityLogicalIri === 'string', 'rights-event-version-authority');
  validateAbsoluteIri(policy.versionIri, 'rights-provider-policy');
  validateAbsoluteIri(policy.policyAuthorityVersionIri, 'rights-provider-policy');
  validateCanonicalText(policy.authorityScopedId, 'rights-provider-policy');
  validateDigest(policy.implementationDigest, 'rights-policy-executable-evidence');
  validateDigest(policy.runtimeDigest, 'rights-policy-executable-evidence');
  validateArtifactReference(policy.sourceArtifactRef, 'rights-policy-source-evidence');
  validateDigest(policy.sourceArtifactDigest, 'rights-policy-source-evidence');
  validateEvidenceLocator(policy.sourceLocator, 'rights-policy-source-evidence');
  invariant(isThreeAxisEligible(policy, pivots, 'rights-policy-pit'), 'rights-policy-pit');
  invariant(policy.eventAuthorityLogicalIri === event.sourceAuthorityLogicalIri, 'rights-policy-event-authority');
  invariant(policy.eventScopeDigest === taggedJcsDigest('axiolune-election-event-scope-v1', {
    affectedSecurityLogicalIri: event.affectedSecurityIri,
    eventAuthorityLogicalIri: policy.eventAuthorityLogicalIri,
    eventKind: event.kind,
  }), 'rights-policy-event-scope-digest');
  const members = policy.providerMembers || [];
  invariant(Array.isArray(members) && members.length > 0, 'rights-policy-provider-members');
  const memberVersions = new Set();
  const providerKeys = new Set();
  const providerByLogical = new Map();
  for (const member of members) {
    invariant(member && typeof member.versionIri === 'string' && !memberVersions.has(member.versionIri), 'rights-policy-provider-members');
    validateAbsoluteIri(member.versionIri, 'rights-policy-provider-members');
    validateAbsoluteIri(member.generatingContextRef, 'rights-policy-provider-members');
    invariant(isThreeAxisEligible(member, pivots, 'rights-policy-provider-member-pit'), 'rights-policy-provider-member-pit');
    memberVersions.add(member.versionIri);
    invariant(member.policyVersionIri === policy.versionIri, 'rights-policy-member-join');
    validateAbsoluteIri(member.providerLogicalIri, 'rights-policy-provider-member');
    validateCanonicalText(member.normalizedProviderKey, 'rights-policy-provider-key');
    invariant(!providerKeys.has(member.normalizedProviderKey), 'rights-policy-provider-key');
    invariant(!providerByLogical.has(member.providerLogicalIri), 'rights-policy-provider-member');
    providerKeys.add(member.normalizedProviderKey);
    providerByLogical.set(member.providerLogicalIri, member);
  }
  const providerIris = sortedUnique([...providerByLogical.keys()]);
  invariant(policy.eligibleProviderCount === providerIris.length, 'rights-policy-provider-count');
  invariant(policy.eligibleProviderSetDigest === iriSetDigest(providerIris), 'rights-policy-provider-digest');
  invariant(policy.providerMemberVersionSetDigest === iriSetDigest(sortedUnique([...memberVersions])), 'rights-policy-provider-member-version-digest');

  const normalizations = policy.normalizationMappings || [];
  invariant(Array.isArray(normalizations) && normalizations.length > 0, 'rights-policy-normalization');
  const mappingVersions = new Set();
  const sourceKeys = new Set();
  const mappingBySourceKey = new Map();
  for (const mapping of normalizations) {
    invariant(mapping && typeof mapping.versionIri === 'string' && !mappingVersions.has(mapping.versionIri), 'rights-policy-normalization');
    validateAbsoluteIri(mapping.versionIri, 'rights-policy-normalization');
    validateAbsoluteIri(mapping.generatingContextRef, 'rights-policy-normalization');
    invariant(isThreeAxisEligible(mapping, pivots, 'rights-policy-normalization-pit'), 'rights-policy-normalization-pit');
    mappingVersions.add(mapping.versionIri);
    invariant(mapping.policyVersionIri === policy.versionIri, 'rights-policy-normalization-join');
    validateCanonicalText(mapping.sourceProviderKey, 'rights-policy-normalization-key');
    invariant(!sourceKeys.has(mapping.sourceProviderKey), 'rights-policy-normalization-key');
    sourceKeys.add(mapping.sourceProviderKey);
    const member = providerByLogical.get(mapping.normalizedProviderLogicalIri);
    invariant(member && mapping.normalizedProviderKey === member.normalizedProviderKey, 'rights-policy-normalization-target');
    mappingBySourceKey.set(mapping.sourceProviderKey, mapping.normalizedProviderLogicalIri);
  }
  invariant(canonical(sortedUnique([...new Set(mappingBySourceKey.values())])) === canonical(providerIris), 'rights-policy-normalization-coverage');
  invariant(policy.providerNormalizationCount === normalizations.length, 'rights-policy-normalization-count');
  const normalizedMappings = [...normalizations].map((mapping) => ({
    normalizedProviderKey: mapping.normalizedProviderKey,
    normalizedProviderLogicalIri: mapping.normalizedProviderLogicalIri,
    policyVersionIri: mapping.policyVersionIri,
    sourceProviderKey: mapping.sourceProviderKey,
    versionIri: mapping.versionIri,
  })).sort(compareCanonical);
  invariant(policy.providerNormalizationDigest === taggedJcsDigest('axiolune-election-provider-normalization-v1', normalizedMappings), 'rights-policy-normalization-digest');

  const edges = policy.precedenceEdges || [];
  invariant(Array.isArray(edges), 'rights-policy-precedence');
  const edgeVersions = new Set();
  const edgePairs = new Set();
  const edgeByPair = new Map();
  const adjacency = new Map(providerIris.map((iri) => [iri, new Set()]));
  for (const edge of edges) {
    invariant(edge && typeof edge.versionIri === 'string' && !edgeVersions.has(edge.versionIri), 'rights-policy-precedence');
    validateAbsoluteIri(edge.versionIri, 'rights-policy-precedence');
    validateAbsoluteIri(edge.generatingContextRef, 'rights-policy-precedence');
    invariant(isThreeAxisEligible(edge, pivots, 'rights-policy-precedence-pit'), 'rights-policy-precedence-pit');
    edgeVersions.add(edge.versionIri);
    invariant(edge.policyVersionIri === policy.versionIri, 'rights-policy-precedence-join');
    invariant(providerByLogical.has(edge.higherProviderLogicalIri) && providerByLogical.has(edge.lowerProviderLogicalIri)
      && edge.higherProviderLogicalIri !== edge.lowerProviderLogicalIri, 'rights-policy-precedence-endpoint');
    const pair = `${edge.higherProviderLogicalIri}\0${edge.lowerProviderLogicalIri}`;
    invariant(!edgePairs.has(pair), 'rights-policy-precedence-duplicate');
    edgePairs.add(pair);
    edgeByPair.set(pair, edge.versionIri);
    adjacency.get(edge.higherProviderLogicalIri).add(edge.lowerProviderLogicalIri);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (provider) => {
    invariant(!visiting.has(provider), 'rights-policy-precedence-cycle');
    if (visited.has(provider)) return;
    visiting.add(provider);
    for (const lower of adjacency.get(provider)) visit(lower);
    visiting.delete(provider);
    visited.add(provider);
  };
  for (const provider of providerIris) visit(provider);
  invariant(policy.precedenceEdgeCount === edges.length, 'rights-policy-precedence-count');
  const normalizedEdges = [...edges].map((edge) => ({
    higherProviderLogicalIri: edge.higherProviderLogicalIri,
    lowerProviderLogicalIri: edge.lowerProviderLogicalIri,
    policyVersionIri: edge.policyVersionIri,
    versionIri: edge.versionIri,
  })).sort(compareCanonical);
  invariant(policy.precedenceGraphDigest === taggedJcsDigest('axiolune-election-provider-precedence-v1', normalizedEdges), 'rights-policy-precedence-digest');

  const requiredEquivalenceFields = [`${BASE}electionDecision`, `${BASE}electedQuantity`];
  invariant(canonical(policy.electionEquivalenceFieldIris) === canonical(requiredEquivalenceFields), 'rights-policy-equivalence-fields');
  invariant(policy.equivalenceFieldsDigest === iriSetDigest(requiredEquivalenceFields), 'rights-policy-equivalence-digest');
  const cutoff = parseInstant(policy.electionDeadlineCutoff, 'rights-policy-deadline');
  invariant(policy.deadlineInclusive === true && policy.electionDeadlineCutoff.slice(0, 10) === event.dates.electionDeadline, 'rights-policy-deadline');
  invariant(policy.deadlineCutoffContractDigest === taggedJcsDigest('axiolune-election-deadline-v1', {
    cutoff: policy.electionDeadlineCutoff,
    inclusive: policy.deadlineInclusive,
  }), 'rights-policy-deadline-digest');

  // RFC-001 requires an active explicit edge. DAG reachability is used only
  // to detect cycles; it must not manufacture an unreviewed precedence edge.
  const dominates = (higher, lower) => adjacency.get(higher)?.has(lower) === true;
  const precedenceEdgeVersion = (higher, lower) => edgeByPair.get(`${higher}\0${lower}`);
  return {
    cutoff, dominates, mappingBySourceKey, providerByLogical, precedenceEdgeVersion,
    providerIris, providerSetDigest: policy.eligibleProviderSetDigest,
    normalizationMappingVersionBySourceKey: new Map(normalizations.map((mapping) => [mapping.sourceProviderKey, mapping.versionIri])),
  };
}

function validateElectionCandidate(candidate, instance, policyState, pivots) {
  const { entitlement, event, providerPolicy } = instance;
  validateAbsoluteIri(candidate.logicalIri, 'rights-candidate-identity');
  validateAbsoluteIri(candidate.versionIri, 'rights-candidate-identity');
  validateCanonicalText(candidate.authorityScopedId, 'rights-candidate-source-evidence');
  validateAbsoluteIri(candidate.sourceRecordRef, 'rights-candidate-source-evidence');
  validateDigest(candidate.sourceRecordDigest, 'rights-candidate-source-evidence');
  validateDigest(candidate.fieldMappingDigest, 'rights-candidate-source-evidence');
  validateArtifactReference(candidate.sourceArtifactRef, 'rights-candidate-source-evidence');
  validateDigest(candidate.sourceArtifactDigest, 'rights-candidate-source-evidence');
  validateEvidenceLocator(candidate.sourceLocator, 'rights-candidate-source-evidence');
  invariant(isThreeAxisEligible(candidate, pivots, 'rights-candidate-pit'), 'rights-candidate-pit');
  invariant(candidate.providerPolicyVersionIri === providerPolicy.versionIri, 'rights-candidate-policy');
  invariant(policyState.providerByLogical.has(candidate.providerLogicalIri), 'rights-candidate-provider');
  validateAbsoluteIri(candidate.providerVersionIri, 'rights-candidate-provider-version');
  invariant(candidate.providerVersionLogicalIri === candidate.providerLogicalIri, 'rights-candidate-provider-version-join');
  validateCanonicalText(candidate.sourceProviderKey, 'rights-candidate-provider-normalization');
  invariant(policyState.mappingBySourceKey.get(candidate.sourceProviderKey) === candidate.providerLogicalIri, 'rights-candidate-provider-normalization');
  invariant(candidate.entitlementVersionIri === entitlement.versionIri && candidate.eventVersionIri === event.versionIri, 'rights-candidate-subject-join');
  const receivedAt = parseInstant(candidate.receivedAt, 'rights-candidate-received-at');
  invariant(receivedAt <= policyState.cutoff, 'rights-candidate-deadline');
  invariant(typeof candidate.electingPartyVersionIri === 'string', 'rights-candidate-electing-party');
  const self = hasOwn(candidate, 'selfElection');
  const authorized = hasOwn(candidate, 'authorizationAccountPartyRole');
  invariant(Number(self) + Number(authorized) === 1, 'rights-candidate-authorization-xone');
  if (self) {
    invariant(candidate.selfElection === true, 'rights-candidate-self-marker');
    invariant(candidate.electingPartyVersionIri === entitlement.entitledPartyVersionIri, 'rights-candidate-self-authorization');
  } else {
    const role = candidate.authorizationAccountPartyRole;
    invariant(role && typeof role.versionIri === 'string', 'rights-candidate-authorization-role');
    validateAbsoluteIri(role.versionIri, 'rights-candidate-authorization-role');
    invariant(isThreeAxisEligible(role, pivots, 'rights-candidate-authorization-role-pit'), 'rights-candidate-authorization-role-pit');
    invariant(role.account === entitlement.accountLogicalIri && role.party === candidate.electingPartyVersionIri
      && ['authorizedOperator', 'custodian'].includes(role.kind), 'rights-candidate-authorization-role');
  }
  invariant(['exercise', 'decline'].includes(candidate.decision), 'rights-candidate-decision');
  if (candidate.decision === 'exercise') {
    invariant(hasOwn(candidate, 'electedQuantity') && compareDecimal(parseDecimal(candidate.electedQuantity), parseDecimal('0')) > 0, 'rights-candidate-exercise-quantity');
    invariant(compareDecimal(parseDecimal(candidate.electedQuantity), parseDecimal(entitlement.maximumRightsQuantity)) <= 0, 'rights-over-election');
  } else invariant(!hasOwn(candidate, 'electedQuantity'), 'rights-candidate-decline-quantity');
}

function validateElectionResolutionCore(instance) {
  validateCorporateActionEvent(instance.event);
  invariant(instance.event.kind === 'rightsIssue', 'rights-chain-kind');
  invariant(instance.entitlement && instance.entitlement.eventVersionIri === instance.event.versionIri, 'rights-entitlement-event-join');
  const pitRequest = instance.electionPitRequest;
  invariant(pitRequest && typeof pitRequest === 'object', 'rights-pit-request');
  validateAbsoluteIri(pitRequest.ref, 'rights-pit-request');
  validateDigest(pitRequest.recordDigest, 'rights-pit-request');
  validateAbsoluteIri(pitRequest.inputContextRef, 'rights-pit-request');
  validateDigest(pitRequest.inputContextRecordDigest, 'rights-pit-request');
  const pivots = {
    asOfValid: parseInstant(pitRequest.asOfValid, 'rights-pit-request'),
    asOfKnowledge: parseInstant(pitRequest.asOfKnowledge, 'rights-pit-request'),
    asOfAvailable: parseInstant(pitRequest.asOfAvailable, 'rights-pit-request'),
  };
  const policyState = validateElectionProviderPolicy(instance.providerPolicy, instance.event, pivots);
  const candidateIdentityKeys = new Map();
  for (const candidate of instance.electionCandidates || []) {
    validateAbsoluteIri(candidate.providerLogicalIri, 'rights-candidate-provider');
    validateAbsoluteIri(candidate.providerVersionIri, 'rights-candidate-provider-version');
    validateCanonicalText(candidate.authorityScopedId, 'rights-candidate-source-evidence');
    const identityKey = `${candidate.providerLogicalIri}\0${candidate.authorityScopedId}`;
    const priorLogical = candidateIdentityKeys.get(identityKey);
    invariant(
      priorLogical === undefined || priorLogical === candidate.logicalIri,
      'rights-candidate-logical-identity',
    );
    candidateIdentityKeys.set(identityKey, candidate.logicalIri);
  }
  const current = resolveCurrentVersionsAtPivots(instance.electionCandidates || [], pivots, 'election');
  for (const candidate of current) validateElectionCandidate(candidate, instance, policyState, pivots);
  const currentIris = sortedUnique(current.map((candidate) => candidate.versionIri));
  invariant(canonical(instance.candidateVersionIris) === canonical(currentIris), 'rights-candidate-version-set');
  invariant(instance.candidateCount === currentIris.length, 'rights-candidate-count');
  const candidateSetDigest = iriSetDigest(currentIris);
  invariant(instance.candidateSetDigest === candidateSetDigest, 'rights-candidate-digest');
  validateCompletedProbe(instance.candidateClosureProbe, 'rights-candidate-closure-probe', candidateSetDigest);

  const resolution = instance.resolution;
  invariant(resolution && typeof resolution === 'object', 'rights-resolution');
  validateAbsoluteIri(resolution.versionIri, 'rights-resolution');
  validateAbsoluteIri(resolution.generatingContextRef, 'rights-resolution-context');
  invariant(resolution.entitlementVersionIri === instance.entitlement.versionIri
    && resolution.providerPolicyVersionIri === instance.providerPolicy.versionIri, 'rights-resolution-subject-join');
  invariant(resolution.pitRequestRef === pitRequest.ref && resolution.pitRequestRecordDigest === pitRequest.recordDigest,
    'rights-resolution-pit-context');
  invariant(resolution.inputContextRef === pitRequest.inputContextRef
    && resolution.inputContextRecordDigest === pitRequest.inputContextRecordDigest, 'rights-resolution-input-context');
  const resultMarkers = ['selectedExercise', 'selectedDecline', 'defaultLapse'].filter((name) => hasOwn(resolution, name));
  invariant(resultMarkers.length === 1 && resultMarkers[0] === resolution.result
    && resolution[resolution.result] === true, 'rights-resolution-result-xone');

  if (current.length === 0) {
    invariant(resolution.result === 'defaultLapse' && !hasOwn(resolution, 'selectedElectionVersionIri')
      && !hasOwn(resolution, 'electedQuantity') && !hasOwn(resolution, 'precedenceProof'), 'rights-resolution-default-lapse');
    invariant(parseInstant(resolution.producedAt, 'rights-resolution-produced-at') >= policyState.cutoff,
      'rights-resolution-default-deadline');
    validateCompletedProbe(resolution.absenceProbe, 'rights-resolution-default-absence-probe', policyState.providerSetDigest);
    return { candidateSetDigest, current, policyState, result: resolution.result, selected: undefined };
  }
  invariant(!hasOwn(resolution, 'absenceProbe'), 'rights-resolution-selected-absence-probe');
  const undominated = current.filter((candidate) => !current.some((other) => other.versionIri !== candidate.versionIri
    && policyState.dominates(other.providerLogicalIri, candidate.providerLogicalIri)));
  invariant(undominated.length > 0, 'rights-resolution-no-candidate');
  const signature = (candidate) => canonical({
    electionDecision: candidate.decision,
    electedQuantity: candidate.electedQuantity || null,
  });
  invariant(sortedUnique(undominated.map(signature)).length === 1, 'rights-resolution-conflict');
  const selected = [...undominated].sort((left, right) => Buffer.from(left.versionIri).compare(Buffer.from(right.versionIri)))[0];
  const expectedResult = selected.decision === 'exercise' ? 'selectedExercise' : 'selectedDecline';
  invariant(resolution.result === expectedResult, 'rights-resolution-result');
  invariant(resolution.selectedElectionVersionIri === selected.versionIri, 'rights-selected-election');
  if (expectedResult === 'selectedExercise') invariant(equalDecimal(resolution.electedQuantity, selected.electedQuantity), 'rights-resolution-elected-quantity');
  else invariant(!hasOwn(resolution, 'electedQuantity'), 'rights-resolution-decline-quantity');

  invariant(resolution.precedenceProof?.selectedProviderLogicalIri === selected.providerLogicalIri, 'rights-resolution-precedence-proof');
  const defeated = sortedUnique(current.filter((candidate) => candidate.versionIri !== selected.versionIri).map((candidate) => candidate.versionIri));
  const normalizationMappings = sortedUnique(current.map((candidate) => policyState.normalizationMappingVersionBySourceKey.get(candidate.sourceProviderKey)));
  const usedEdges = sortedUnique(current.flatMap((higher) => current.flatMap((lower) => {
    if (higher.versionIri === lower.versionIri || !policyState.dominates(higher.providerLogicalIri, lower.providerLogicalIri)) return [];
    return [policyState.precedenceEdgeVersion(higher.providerLogicalIri, lower.providerLogicalIri)];
  })));
  invariant(canonical(resolution.precedenceProof?.defeatedCandidateVersionIris) === canonical(defeated)
    && resolution.precedenceProof?.candidateSetDigest === candidateSetDigest
    && canonical(resolution.precedenceProof?.normalizationMappingVersionIris) === canonical(normalizationMappings)
    && canonical(resolution.precedenceProof?.precedenceEdgeVersionIris) === canonical(usedEdges), 'rights-resolution-precedence-proof');
  return { candidateSetDigest, current, policyState, result: resolution.result, selected };
}

function validateSubscriptionFulfillmentRecord(item, obligation, instance) {
  validateAbsoluteIri(item.logicalIri, 'rights-fulfillment-identity');
  validateAbsoluteIri(item.versionIri, 'rights-fulfillment-identity');
  if (hasOwn(item, 'supersedesVersionIri')) validateAbsoluteIri(item.supersedesVersionIri, 'rights-fulfillment-supersession');
  validateAbsoluteIri(item.authorityVersionIri, 'rights-fulfillment-authority');
  validateCanonicalText(item.authorityScopedId, 'rights-fulfillment-authority');
  validateThreeAxisIntervals(item, 'rights-fulfillment-temporal');
  invariant(item.subscriptionObligationVersionIri === obligation.versionIri && item.state === 'completed', 'rights-fulfillment-state-join');
  const occurrence = parseInstant(item.occurrenceTime, 'rights-fulfillment-occurrence');
  validateDateLiteral(item.effectiveDate, 'rights-fulfillment-date');
  invariant(new Date(occurrence).toISOString().slice(0, 10) === item.effectiveDate, 'rights-fulfillment-date');
  invariant(compareDecimal(parseDecimal(item.amount), parseDecimal('0')) > 0, 'rights-fulfillment-amount-positive');
  validateAbsoluteIri(item.movementEvidenceIri, 'rights-fulfillment-movement-evidence');
  validateDigest(item.movementEvidenceDigest, 'rights-fulfillment-movement-evidence');
  validateArtifactEvidence(item, 'rights-fulfillment-source-evidence');

  if (item.assetKind === 'cashPayment') {
    invariant(item.currency === obligation.currency && !hasOwn(item, 'instrumentIri') && !hasOwn(item, 'unit'), 'rights-cash-fulfillment-asset');
    invariant(item.fromAccount === obligation.subscriberCashAccount && item.toAccount === obligation.agentCashAccount
      && item.fromParty === obligation.subscriberPartyVersionIri && item.toParty === obligation.agentPartyVersionIri
      && item.effectiveDate === instance.subscriptionCashDueDate, 'rights-cash-fulfillment');
  } else {
    invariant(item.assetKind === 'securityDelivery' && item.instrumentIri === obligation.successorSecurityIri
      && item.unit === obligation.securityUnit && !hasOwn(item, 'currency'), 'rights-security-fulfillment-asset');
    invariant(item.fromAccount === obligation.agentSecuritiesAccount && item.toAccount === obligation.subscriberSecuritiesAccount
      && item.fromParty === obligation.agentPartyVersionIri && item.toParty === obligation.subscriberPartyVersionIri
      && item.effectiveDate === instance.successorDeliveryDate, 'rights-security-fulfillment');
  }
}

function validateRightsExercise(instance) {
  invariant(equalDecimal(instance.entitlement.maximumRightsQuantity, instance.maximumRightsQuantity), 'rights-entitlement-maximum');
  const { selected, result } = validateElectionResolutionCore(instance);
  invariant(result === 'selectedExercise' && selected, 'rights-selected-election');
  const obligation = instance.subscriptionObligation;
  validateAbsoluteIri(obligation.versionIri, 'rights-obligation-identity');
  invariant(obligation.electionResolutionVersionIri === instance.resolution.versionIri
    && obligation.selectedElectionVersionIri === selected.versionIri
    && obligation.entitlementVersionIri === instance.entitlement.versionIri
    && obligation.eventVersionIri === instance.event.versionIri
    && obligation.scheduleResolutionVersionIri === instance.scheduleResolutionVersionIri,
  'rights-obligation-resolution-join');
  invariant(obligation.successorSecurityIri === instance.event.successorSecurityIri
    && obligation.subscriberSecuritiesAccount === instance.entitlement.accountLogicalIri,
  'rights-obligation-subject-join');
  validateAbsoluteIri(obligation.subscriberPartyVersionIri, 'rights-obligation-party');
  validateAbsoluteIri(obligation.agentPartyVersionIri, 'rights-obligation-party');
  invariant(obligation.subscriberPartyVersionIri === instance.entitlement.entitledPartyVersionIri
    && obligation.subscriberPartyVersionIri !== obligation.agentPartyVersionIri, 'rights-obligation-party');
  invariant(obligation.subscriptionCashDueDate === instance.subscriptionCashDueDate
    && obligation.successorDeliveryDate === instance.successorDeliveryDate, 'rights-obligation-date');
  validateAbsoluteIri(obligation.generatingContextRef, 'rights-obligation-context');
  invariant(equalDecimal(obligation.securityQuantity, selected.electedQuantity), 'rights-obligation-security-quantity');
  const expectedCash = multiplyDecimal(parseDecimal(selected.electedQuantity), parseDecimal(instance.event.subscriptionPrice.amount));
  invariant(obligation.currency === instance.event.subscriptionPrice.currency && equalDecimal(obligation.cashAmount, decimalString(expectedCash)), 'rights-obligation-cash-arithmetic');

  const fulfillmentPitRequest = instance.fulfillmentPitRequest;
  invariant(fulfillmentPitRequest && typeof fulfillmentPitRequest === 'object', 'rights-fulfillment-pit-request');
  validateAbsoluteIri(fulfillmentPitRequest.ref, 'rights-fulfillment-pit-request');
  validateDigest(fulfillmentPitRequest.recordDigest, 'rights-fulfillment-pit-request');
  validateAbsoluteIri(fulfillmentPitRequest.inputContextRef, 'rights-fulfillment-pit-request');
  validateDigest(fulfillmentPitRequest.inputContextRecordDigest, 'rights-fulfillment-pit-request');
  const fulfillmentPivots = {
    asOfValid: parseInstant(fulfillmentPitRequest.asOfValid, 'rights-fulfillment-pit-request'),
    asOfKnowledge: parseInstant(fulfillmentPitRequest.asOfKnowledge, 'rights-fulfillment-pit-request'),
    asOfAvailable: parseInstant(fulfillmentPitRequest.asOfAvailable, 'rights-fulfillment-pit-request'),
  };
  const fulfillmentAuthorityIds = new Map();
  for (const item of instance.fulfillments || []) {
    validateSubscriptionFulfillmentRecord(item, obligation, instance);
    const key = `${item.authorityVersionIri}\0${item.authorityScopedId}`;
    const prior = fulfillmentAuthorityIds.get(key);
    invariant(prior === undefined || prior === item.logicalIri, 'rights-fulfillment-logical-identity');
    fulfillmentAuthorityIds.set(key, item.logicalIri);
  }
  const fulfillmentCurrent = resolveCurrentVersionsAtPivots(
    instance.fulfillments || [], fulfillmentPivots, 'subscription-fulfillment',
  );
  const fulfillmentIris = sortedUnique(fulfillmentCurrent.map((item) => item.versionIri));
  const fulfillmentSetDigest = iriSetDigest(fulfillmentIris);
  const closure = instance.fulfillmentClosure;
  validateAbsoluteIri(closure.versionIri, 'rights-fulfillment-closure-identity');
  validateAbsoluteIri(closure.generatingContextRef, 'rights-fulfillment-closure-context');
  invariant(closure.obligationVersionIri === obligation.versionIri, 'rights-fulfillment-closure-obligation');
  invariant(closure.pitRequestRef === fulfillmentPitRequest.ref
    && closure.pitRequestRecordDigest === fulfillmentPitRequest.recordDigest, 'rights-fulfillment-closure-pit-context');
  invariant(closure.inputContextRef === fulfillmentPitRequest.inputContextRef
    && closure.inputContextRecordDigest === fulfillmentPitRequest.inputContextRecordDigest, 'rights-fulfillment-closure-input-context');
  validateCompletedProbe(closure.closureProbe, 'rights-fulfillment-closure-probe', fulfillmentSetDigest);
  invariant(canonical(closure.fulfillmentVersionIris) === canonical(fulfillmentIris), 'rights-fulfillment-version-set');
  invariant(closure.fulfillmentCount === fulfillmentIris.length, 'rights-fulfillment-count');
  invariant(closure.fulfillmentSetDigest === fulfillmentSetDigest, 'rights-fulfillment-digest');
  let cash = parseDecimal('0');
  let security = parseDecimal('0');
  const evidenceIris = new Set();
  const evidenceDigests = new Set();
  for (const item of fulfillmentCurrent) {
    invariant(
      !evidenceIris.has(item.movementEvidenceIri)
        && !evidenceDigests.has(item.movementEvidenceDigest),
      'rights-fulfillment-evidence-unique',
    );
    evidenceIris.add(item.movementEvidenceIri);
    evidenceDigests.add(item.movementEvidenceDigest);
    if (item.assetKind === 'cashPayment') {
      cash = addDecimal(cash, parseDecimal(item.amount));
    } else {
      security = addDecimal(security, parseDecimal(item.amount));
    }
  }
  invariant(closure.result === 'fullyFulfilled', 'rights-closure-not-full');
  invariant(compareDecimal(cash, expectedCash) === 0 && equalDecimal(decimalString(security), obligation.securityQuantity), 'rights-closure-arithmetic');
  invariant(equalDecimal(closure.fulfilledCashAmount, decimalString(cash))
    && equalDecimal(closure.fulfilledSecurityQuantity, decimalString(security)), 'rights-closure-arithmetic');
  const adjustment = instance.adjustment;
  validateAbsoluteIri(adjustment.versionIri, 'rights-adjustment-identity');
  validateAbsoluteIri(adjustment.generatingContextRef, 'rights-adjustment-context');
  invariant(adjustment.fulfillmentClosureVersionIri === closure.versionIri
    && adjustment.eventVersionIri === instance.event.versionIri
    && adjustment.scheduleResolutionVersionIri === instance.scheduleResolutionVersionIri
    && adjustment.entitlementVersionIri === instance.entitlement.versionIri
    && adjustment.electionResolutionVersionIri === instance.resolution.versionIri
    && adjustment.selectedElectionVersionIri === selected.versionIri
    && adjustment.subscriptionObligationVersionIri === obligation.versionIri, 'rights-adjustment-closure-join');
  const expectedMovementEvidence = sortedUnique(fulfillmentCurrent.map((item) => item.movementEvidenceIri));
  invariant(canonical(adjustment.movementEvidenceIris) === canonical(expectedMovementEvidence), 'rights-adjustment-evidence-set');
  invariant(adjustment.movementEvidenceCount === expectedMovementEvidence.length && adjustment.movementEvidenceSetDigest === iriSetDigest(expectedMovementEvidence), 'rights-adjustment-evidence-closure');
  invariant(adjustment.cashAccount === obligation.subscriberCashAccount && adjustment.securitiesAccount === obligation.subscriberSecuritiesAccount, 'rights-adjustment-account');
  invariant(adjustment.cashEffectiveDate === instance.subscriptionCashDueDate && adjustment.quantityEffectiveDate === instance.successorDeliveryDate, 'rights-adjustment-date');
  invariant(equalDecimal(adjustment.cashDelta, `-${decimalString(expectedCash)}`) && equalDecimal(adjustment.quantityDelta, obligation.securityQuantity), 'rights-adjustment-arithmetic');
  const latestCompletion = Math.max(...fulfillmentCurrent.map((item) => parseInstant(item.occurrenceTime, 'rights-adjustment-valid-from')));
  invariant(parseInstant(adjustment.validFrom, 'rights-adjustment-valid-from') === latestCompletion, 'rights-adjustment-valid-from');
}

function validateBridge(bridge, economicAccount, settlementAccount, instruction, code) {
  invariant(bridge?.pitEligible === true, code);
  invariant(bridge.economicAccount === economicAccount && bridge.settlementAccount === settlementAccount, code);
  invariant(bridge.system === instruction.system && bridge.location === instruction.location, code);
}

function validateSettlement(instance) {
  const bridges = new Map();
  for (const bridge of instance.bridges || []) {
    validateAbsoluteIri(bridge.versionIri, 'settlement-bridge-identity');
    validateAbsoluteIri(bridge.economicAccount, 'settlement-bridge-account');
    validateAbsoluteIri(bridge.settlementAccount, 'settlement-bridge-account');
    validateCanonicalText(bridge.system, 'settlement-bridge-system');
    validateCanonicalText(bridge.location, 'settlement-bridge-location');
    invariant(bridge.economicAccount !== bridge.settlementAccount, 'settlement-bridge-account');
    invariant(bridge.pitEligible === true, 'settlement-bridge-pit');
    invariant(!bridges.has(bridge.versionIri), 'settlement-bridge-duplicate', bridge.versionIri);
    bridges.set(bridge.versionIri, bridge);
  }
  const instructionVersions = new Set();
  const legVersions = new Set();
  for (const instruction of instance.instructions || []) {
    validateAbsoluteIri(instruction.versionIri, 'settlement-instruction-identity');
    invariant(!instructionVersions.has(instruction.versionIri), 'settlement-instruction-duplicate', instruction.versionIri);
    instructionVersions.add(instruction.versionIri);
    validateAbsoluteIri(instruction.securitiesDeliverer, 'settlement-instruction-party');
    validateAbsoluteIri(instruction.securitiesReceiver, 'settlement-instruction-party');
    validateCanonicalText(instruction.atomicGroupId, 'settlement-instruction-atomic-group');
    validateCanonicalText(instruction.system, 'settlement-instruction-system');
    validateCanonicalText(instruction.location, 'settlement-instruction-location');
    invariant(instruction.securitiesDeliverer !== instruction.securitiesReceiver, 'settlement-party-distinct');
    const legs = instruction.legs || [];
    invariant(legs.length > 0, 'settlement-leg-inventory');
    for (const leg of legs) {
      validateAbsoluteIri(leg.versionIri, 'settlement-leg-identity');
      invariant(!legVersions.has(leg.versionIri), 'settlement-leg-duplicate', leg.versionIri);
      legVersions.add(leg.versionIri);
      for (const field of ['fromParty', 'toParty', 'fromAccount', 'toAccount']) {
        validateAbsoluteIri(leg[field], 'settlement-leg-endpoint');
      }
      invariant(leg.fromParty !== leg.toParty && leg.fromAccount !== leg.toAccount, 'settlement-leg-endpoint-distinct');
      invariant(leg.atomicGroupId === instruction.atomicGroupId, 'settlement-atomic-group-join');
      if (leg.asset.kind === 'security') {
        validateAbsoluteIri(leg.asset.instrumentIri, 'settlement-security-leg');
        validateAbsoluteIri(leg.asset.unit, 'settlement-security-leg');
        invariant(compareDecimal(parseDecimal(leg.asset.amount), parseDecimal('0')) > 0, 'settlement-security-leg');
        invariant(!hasOwn(leg, 'money'), 'settlement-asset-xone');
      } else {
        invariant(
          leg.asset.kind === 'money'
            && /^[A-Z]{3}$/u.test(leg.asset.currency || '')
            && compareDecimal(parseDecimal(leg.asset.amount), parseDecimal('0')) > 0,
          'settlement-cash-leg',
        );
        invariant(!hasOwn(leg, 'instrumentIri'), 'settlement-asset-xone');
      }
    }
    const security = legs.filter((leg) => leg.asset.kind === 'security');
    const cash = legs.filter((leg) => leg.asset.kind === 'money');
    if (instruction.method === 'deliveryVersusPayment') {
      invariant(legs.length === 2 && security.length === 1 && cash.length === 1, 'settlement-dvp-leg-matrix');
      invariant(security[0].fromParty === instruction.securitiesDeliverer && security[0].toParty === instruction.securitiesReceiver, 'settlement-dvp-security-direction');
      invariant(cash[0].fromParty === instruction.securitiesReceiver && cash[0].toParty === instruction.securitiesDeliverer, 'settlement-dvp-cash-reciprocity');
    } else if (instruction.method === 'freeOfPayment') {
      invariant(legs.length === 1 && security.length === 1 && cash.length === 0, 'settlement-fop-leg-matrix');
      invariant(security[0].fromParty === instruction.securitiesDeliverer && security[0].toParty === instruction.securitiesReceiver, 'settlement-fop-security-direction');
    } else invariant(false, 'settlement-method-closed');

    const statusOrderKeys = new Set();
    const statusEvents = instruction.statusEvents || [];
    const statusesBySubject = new Map();
    for (const event of statusEvents) {
      invariant(Number.isSafeInteger(event.order) && event.order >= 0 && !statusOrderKeys.has(event.order), 'settlement-status-order');
      statusOrderKeys.add(event.order);
      invariant(['instructed', 'matched', 'settled', 'cancelled', 'failed'].includes(event.state), 'settlement-status-state');
      const groupSubject = event.subject === 'group' && event.atomicGroupId === instruction.atomicGroupId
        && !hasOwn(event, 'legVersionIri');
      const legSubject = event.subject === 'leg' && typeof event.legVersionIri === 'string'
        && legs.some((leg) => leg.versionIri === event.legVersionIri) && !hasOwn(event, 'atomicGroupId');
      invariant(Number(groupSubject) + Number(legSubject) === 1, 'settlement-status-subject-xone');
      invariant(!hasOwn(event, 'atomicCompletion'), 'settlement-status-atomic-evidence');
      const hasAtomicEvidenceRef = hasOwn(event, 'atomicCompletionEvidenceRef');
      const hasAtomicEvidenceDigest = hasOwn(event, 'atomicCompletionEvidenceDigest');
      invariant(hasAtomicEvidenceRef === hasAtomicEvidenceDigest, 'settlement-status-atomic-evidence');
      if (hasAtomicEvidenceRef) {
        invariant(groupSubject && event.state === 'settled', 'settlement-status-atomic-evidence');
        validateAbsoluteIri(event.atomicCompletionEvidenceRef, 'settlement-status-atomic-evidence');
        validateDigest(event.atomicCompletionEvidenceDigest, 'settlement-status-atomic-evidence');
      }
      const subject = event.subject === 'group'
        ? `group:${event.atomicGroupId}`
        : `leg:${event.legVersionIri}`;
      const subjectEvents = statusesBySubject.get(subject) || [];
      subjectEvents.push(event);
      statusesBySubject.set(subject, subjectEvents);
    }
    const allowedTransitions = {
      instructed: new Set(['matched', 'settled', 'cancelled', 'failed']),
      matched: new Set(['settled', 'cancelled', 'failed']),
      settled: new Set(),
      cancelled: new Set(),
      failed: new Set(),
    };
    for (const subjectEvents of statusesBySubject.values()) {
      const ordered = subjectEvents.slice().sort((left, right) => left.order - right.order);
      for (let index = 1; index < ordered.length; index += 1) {
        invariant(
          allowedTransitions[ordered[index - 1].state].has(ordered[index].state),
          'settlement-status-transition',
        );
      }
    }
    if (instruction.method === 'deliveryVersusPayment') {
      const groupEvents = statusesBySubject.get(`group:${instruction.atomicGroupId}`) || [];
      const currentGroupEvent = groupEvents.slice().sort(
        (left, right) => left.order - right.order,
      ).at(-1);
      invariant(
        currentGroupEvent?.state === 'settled'
          && hasOwn(currentGroupEvent, 'atomicCompletionEvidenceRef')
          && currentGroupEvent.atomicCompletionEvidenceDigest
            === iriSetDigest(legs.map((leg) => leg.versionIri)),
        'settlement-dvp-atomic-completion',
      );
    }
  }

  const instructionByIri = new Map((instance.instructions || []).map((item) => [item.versionIri, item]));
  const allocationIdentities = new Set();
  const allocationVersions = new Set();
  const executionAggregates = new Map();
  const legAggregates = new Map();
  for (const allocation of instance.allocations || []) {
    validateAbsoluteIri(allocation.versionIri, 'allocation-version-identity');
    invariant(!allocationVersions.has(allocation.versionIri), 'allocation-version-duplicate', allocation.versionIri);
    allocationVersions.add(allocation.versionIri);
    const instruction = instructionByIri.get(allocation.instructionVersionIri);
    invariant(instruction, 'allocation-instruction-join');
    const leg = instruction.legs.find((item) => item.versionIri === allocation.securityLegVersionIri);
    invariant(leg?.asset.kind === 'security', 'allocation-security-leg-join');
    validateAbsoluteIri(allocation.execution?.versionIri, 'allocation-execution-version');
    validateAbsoluteIri(allocation.execution?.instrumentIri, 'allocation-execution-instrument');
    validateAbsoluteIri(allocation.execution?.account, 'allocation-execution-account');
    validateAbsoluteIri(allocation.fromEconomicAccount, 'allocation-economic-account');
    validateAbsoluteIri(allocation.toEconomicAccount, 'allocation-economic-account');
    const allocationIdentity = `${allocation.execution.versionIri}\0${allocation.securityLegVersionIri}`;
    invariant(!allocationIdentities.has(allocationIdentity), 'allocation-logical-identity', allocationIdentity);
    allocationIdentities.add(allocationIdentity);
    invariant(allocation.execution.instrumentIri === leg.asset.instrumentIri && allocation.quantity.unit === leg.asset.unit, 'allocation-instrument-unit-join');
    invariant(compareDecimal(parseDecimal(allocation.quantity.amount), parseDecimal('0')) > 0 && compareDecimal(parseDecimal(allocation.quantity.amount), parseDecimal(allocation.execution.quantity)) <= 0, 'allocation-quantity');
    invariant(allocation.fromEconomicAccount !== allocation.toEconomicAccount, 'allocation-economic-endpoint-distinct');
    if (allocation.execution.side === 'buy') invariant(allocation.execution.account === allocation.toEconomicAccount, 'allocation-buy-direction');
    else invariant(allocation.execution.side === 'sell' && allocation.execution.account === allocation.fromEconomicAccount, 'allocation-sell-direction');
    for (const side of ['from', 'to']) {
      const economic = allocation[`${side}EconomicAccount`];
      const settlement = leg[`${side}Account`];
      const mode = allocation[`${side}Mode`];
      const bridgeRef = allocation[`${side}BridgeVersionIri`];
      if (mode === 'directAccount') invariant(economic === settlement && bridgeRef === undefined, `allocation-${side}-direct-xone`);
      else {
        invariant(mode === 'custodyOrOmnibus' && economic !== settlement && typeof bridgeRef === 'string', `allocation-${side}-bridge-xone`);
        validateBridge(bridges.get(bridgeRef), economic, settlement, instruction, `allocation-${side}-bridge-join`);
      }
    }
    const executionSignature = canonical(allocation.execution);
    const aggregate = executionAggregates.get(allocation.execution.versionIri);
    if (aggregate) {
      invariant(aggregate.signature === executionSignature, 'allocation-execution-version-content', allocation.execution.versionIri);
      aggregate.allocated = addDecimal(aggregate.allocated, parseDecimal(allocation.quantity.amount));
    } else {
      executionAggregates.set(allocation.execution.versionIri, {
        signature: executionSignature,
        executed: parseDecimal(allocation.execution.quantity),
        allocated: parseDecimal(allocation.quantity.amount),
      });
    }
    const legAggregate = legAggregates.get(leg.versionIri) || {
      allocated: parseDecimal('0'),
      legAmount: parseDecimal(leg.asset.amount),
    };
    legAggregate.allocated = addDecimal(
      legAggregate.allocated,
      parseDecimal(allocation.quantity.amount),
    );
    legAggregates.set(leg.versionIri, legAggregate);
  }
  for (const [executionVersionIri, aggregate] of executionAggregates) {
    invariant(compareDecimal(aggregate.allocated, aggregate.executed) <= 0, 'allocation-execution-aggregate', executionVersionIri);
  }
  for (const [legVersionIri, aggregate] of legAggregates) {
    invariant(
      compareDecimal(aggregate.allocated, aggregate.legAmount) <= 0,
      'allocation-leg-aggregate',
      legVersionIri,
    );
  }
}

function validateMissingSideKey(assertion) {
  invariant(assertion && ['internal', 'external'].includes(assertion.expectedSide), 'missing-side-expected-side');
  for (const field of [
    'focalAccountLogicalIri', 'normalizedSettlementReference', 'settlementDate',
    'settlementSystem', 'settlementLocation', 'entryDirection', 'assetKind',
  ]) invariant(typeof assertion[field] === 'string' && assertion[field].length > 0, 'missing-side-key-field', field);
  invariant(['debit', 'credit'].includes(assertion.entryDirection), 'missing-side-entry-direction');

  let assetIdentity;
  let unitIdentity;
  if (assertion.assetKind === 'cash') {
    invariant(typeof assertion.comparisonCurrencyAlphaCode === 'string' && /^[A-Z]{3}$/u.test(assertion.comparisonCurrencyAlphaCode), 'missing-side-cash-currency');
    invariant(Number.isSafeInteger(assertion.comparisonCurrencyScale) && assertion.comparisonCurrencyScale >= 0, 'missing-side-cash-scale');
    invariant(!hasOwn(assertion, 'comparisonInstrumentIri') && !hasOwn(assertion, 'comparisonQuantityUnit'), 'missing-side-asset-xone');
    assetIdentity = assertion.comparisonCurrencyAlphaCode;
    unitIdentity = assertion.comparisonCurrencyScale;
  } else {
    invariant(assertion.assetKind === 'security', 'missing-side-asset-kind');
    invariant(typeof assertion.comparisonInstrumentIri === 'string' && /^https?:\/\/[^\s]+$/u.test(assertion.comparisonInstrumentIri), 'missing-side-security-instrument');
    invariant(typeof assertion.comparisonQuantityUnit === 'string' && /^https?:\/\/[^\s]+$/u.test(assertion.comparisonQuantityUnit), 'missing-side-security-unit');
    invariant(!hasOwn(assertion, 'comparisonCurrencyAlphaCode') && !hasOwn(assertion, 'comparisonCurrencyScale'), 'missing-side-asset-xone');
    assetIdentity = assertion.comparisonInstrumentIri;
    unitIdentity = assertion.comparisonQuantityUnit;
  }

  const key = {
    focalAccountLogicalIri: assertion.focalAccountLogicalIri,
    normalizedSettlementReference: assertion.normalizedSettlementReference,
    settlementDate: assertion.settlementDate,
    settlementSystem: assertion.settlementSystem,
    settlementLocation: assertion.settlementLocation,
    entryDirection: assertion.entryDirection,
    assetKind: assertion.assetKind,
    assetIdentity,
    unitIdentity,
  };
  invariant(assertion.comparisonKeyDigest === settlementComparisonKeyDigest(key), 'missing-side-key-digest');
}

function validateMissingSideStrictKey(instance) {
  invariant(Array.isArray(instance.assertions) && instance.assertions.length > 0, 'missing-side-inventory');
  for (const assertion of instance.assertions) validateMissingSideKey(assertion);
  invariant(canonical(sortedUnique(instance.assertions.map((item) => item.assetKind))) === canonical(['cash', 'security']), 'missing-side-asset-coverage');
}

function validateMissingSideAbsenceProbe(assertion, instance, pivots) {
  const probe = assertion?.absenceProbe;
  invariant(probe && typeof probe === 'object', 'reconciliation-missing-absence-probe');
  exactKeys(probe, [
    'digest', 'expectedSide', 'inputRunRecordDigest', 'inputRunRef',
    'pitRequestRecordDigest', 'pitRequestRef', 'queryFunctionDigest', 'queryFunctionRef',
    'queryParametersBytes', 'queryParametersDigest', 'ref', 'result', 'schemaVersion', 'status',
    'subjectSetDigest', 'subjectVersionIris', 'universeDigest',
  ], [], 'reconciliation-missing-absence-probe-schema');
  const artifacts = instance.missingSideProbeArtifacts;
  invariant(artifacts && typeof artifacts === 'object', 'reconciliation-missing-absence-probe-schema');
  exactKeys(artifacts, ['inputRunBytes', 'pitRequestBytes', 'queryFunctionBytes'], [],
    'reconciliation-missing-absence-probe-schema');
  invariant(probe.schemaVersion === '1.0' && probe.status === 'completed',
    'reconciliation-missing-absence-probe');
  validateAbsoluteIri(probe.ref, 'reconciliation-missing-absence-probe');
  validateDigest(probe.digest, 'reconciliation-missing-absence-probe');
  validateAbsoluteIri(probe.queryFunctionRef, 'reconciliation-missing-query-contract');
  validateDigest(probe.queryFunctionDigest, 'reconciliation-missing-query-contract');

  const queryFunction = parseExactJcsBytes(
    artifacts.queryFunctionBytes,
    probe.queryFunctionDigest,
    'reconciliation-missing-query-contract',
  );
  invariant(probe.queryFunctionRef === queryFunction.functionIri,
    'reconciliation-missing-query-contract', 'function reference does not bind parsed bytes');
  invariant(artifacts.queryFunctionBytes === MISSING_SIDE_QUERY_FUNCTION_BYTES
      && probe.queryFunctionDigest === MISSING_SIDE_QUERY_FUNCTION_DIGEST,
  'reconciliation-missing-query-contract', 'wrong query/function contract');

  validateAbsoluteIri(probe.inputRunRef, 'reconciliation-missing-input-run');
  validateDigest(probe.inputRunRecordDigest, 'reconciliation-missing-input-run');
  const inputRun = parseExactJcsBytes(
    artifacts.inputRunBytes,
    probe.inputRunRecordDigest,
    'reconciliation-missing-input-run',
  );
  exactKeys(inputRun, [
    'completedAt', 'iri', 'recordType', 'referenceTime', 'schemaVersion', 'status', 'universes',
  ], [], 'reconciliation-missing-input-run');
  invariant(inputRun.recordType === 'MaterializationRun' && inputRun.schemaVersion === '1.0'
      && inputRun.status === 'completed', 'reconciliation-missing-input-run');
  validateAbsoluteIri(inputRun.iri, 'reconciliation-missing-input-run');
  const completedAt = parseInstant(inputRun.completedAt, 'reconciliation-missing-input-run');
  const referenceTime = parseInstant(inputRun.referenceTime, 'reconciliation-missing-input-run');
  invariant(referenceTime === pivots.asOfAvailable && completedAt <= referenceTime,
    'reconciliation-missing-input-run');

  const expectedUniverses = {
    external: missingSideInputUniverse(instance.externalStatementLines || []),
    internal: missingSideInputUniverse(instance.internalProjections || []),
  };
  invariant(canonical(inputRun.universes) === canonical(expectedUniverses),
    'reconciliation-missing-input-universe', 'input Run is not the complete source universe');
  invariant(probe.inputRunRef === inputRun.iri
      && assertion.inputContextRef === probe.inputRunRef
      && assertion.inputContextRecordDigest === probe.inputRunRecordDigest
      && instance.case.inputContextRef === probe.inputRunRef
      && instance.case.inputContextRecordDigest === probe.inputRunRecordDigest,
  'reconciliation-missing-input-run-binding');

  validateAbsoluteIri(probe.pitRequestRef, 'reconciliation-missing-pit-request');
  validateDigest(probe.pitRequestRecordDigest, 'reconciliation-missing-pit-request');
  const pitRequest = parseExactJcsBytes(
    artifacts.pitRequestBytes,
    probe.pitRequestRecordDigest,
    'reconciliation-missing-pit-request',
  );
  const expectedPitRequest = {
    asOfAvailable: instance.case.reconciliationAsOfAvailable,
    asOfKnowledge: instance.case.reconciliationAsOfKnowledge,
    asOfValid: instance.case.reconciliationAsOfValid,
    caseVersionIri: instance.case.versionIri,
    inputRunRecordDigest: probe.inputRunRecordDigest,
    inputRunRef: probe.inputRunRef,
    iri: probe.pitRequestRef,
    recordType: 'PointInTimeRequest',
    schemaVersion: '1.0',
  };
  invariant(canonical(pitRequest) === canonical(expectedPitRequest),
    'reconciliation-missing-pit-request', 'PIT request bytes do not bind exact pivots and input Run');
  invariant(assertion.pitRequestRef === probe.pitRequestRef
      && assertion.pitRequestRecordDigest === probe.pitRequestRecordDigest,
  'reconciliation-missing-pit-request-binding');

  const expectedParameters = {
    asOfAvailable: instance.case.reconciliationAsOfAvailable,
    asOfKnowledge: instance.case.reconciliationAsOfKnowledge,
    asOfValid: instance.case.reconciliationAsOfValid,
    caseVersionIri: instance.case.versionIri,
    comparatorVersionIri: instance.case.comparatorVersionIri,
    comparisonKeyDigest: assertion.comparisonKeyDigest,
    expectedSide: assertion.expectedSide,
    inputRunRecordDigest: probe.inputRunRecordDigest,
    inputRunRef: probe.inputRunRef,
    keyId: assertion.keyId,
    pitRequestRecordDigest: probe.pitRequestRecordDigest,
    pitRequestRef: probe.pitRequestRef,
  };
  const queryParameters = parseExactJcsBytes(
    probe.queryParametersBytes,
    probe.queryParametersDigest,
    'reconciliation-missing-query-parameters',
  );
  invariant(canonical(queryParameters) === canonical(expectedParameters),
    'reconciliation-missing-query-parameters');
  invariant(probe.expectedSide === assertion.expectedSide,
    'reconciliation-missing-query-parameters');

  const sourceRecords = assertion.expectedSide === 'internal'
    ? (instance.internalProjections || [])
    : (instance.externalStatementLines || []);
  const candidateVersionIris = sortedUnique(sourceRecords.filter((record) => (
    record.keyId === assertion.keyId
      && record.comparisonKeyDigest === assertion.comparisonKeyDigest
      && isThreeAxisEligible(record, pivots, 'reconciliation-missing-query-pit')
  )).map((record) => record.versionIri));
  const subjectSetDigest = iriSetDigest(candidateVersionIris);
  invariant(probe.universeDigest === expectedUniverses[assertion.expectedSide].recordSetDigest,
    'reconciliation-missing-input-universe');
  invariant(canonical(probe.subjectVersionIris) === canonical(candidateVersionIris)
      && probe.subjectSetDigest === subjectSetDigest
      && probe.result === (candidateVersionIris.length === 0)
      && probe.result === true,
  'reconciliation-missing-absence-probe');
  invariant(probe.digest === missingSideAbsenceProbeDigest(probe),
    'reconciliation-missing-absence-probe');
}

function validateReconciliationKey(key) {
  invariant(key && typeof key.keyId === 'string' && key.keyId.length > 0, 'reconciliation-key-id');
  for (const field of [
    'focalAccountLogicalIri', 'normalizedSettlementReference', 'settlementDate', 'settlementSystem',
    'settlementLocation', 'entryDirection', 'assetKind', 'assetIdentity',
  ]) invariant(typeof key[field] === 'string' && key[field].length > 0, 'reconciliation-key-field', field);
  invariant(['debit', 'credit'].includes(key.entryDirection), 'reconciliation-key-direction');
  if (key.assetKind === 'cash') {
    invariant(/^[A-Z]{3}$/u.test(key.assetIdentity) && Number.isSafeInteger(key.unitIdentity) && key.unitIdentity >= 0, 'reconciliation-key-cash');
  } else {
    invariant(key.assetKind === 'security' && /^https?:\/\/[^\s]+$/u.test(key.assetIdentity)
      && typeof key.unitIdentity === 'string' && /^https?:\/\/[^\s]+$/u.test(key.unitIdentity), 'reconciliation-key-security');
  }
  const digestInput = {
    focalAccountLogicalIri: key.focalAccountLogicalIri,
    normalizedSettlementReference: key.normalizedSettlementReference,
    settlementDate: key.settlementDate,
    settlementSystem: key.settlementSystem,
    settlementLocation: key.settlementLocation,
    entryDirection: key.entryDirection,
    assetKind: key.assetKind,
    assetIdentity: key.assetIdentity,
    unitIdentity: key.unitIdentity,
  };
  invariant(key.comparisonKeyDigest === settlementComparisonKeyDigest(digestInput), 'reconciliation-key-digest');
}

function normalizeReconciliationValue(value, key) {
  const parsedAmount = value && parseDecimal(value.amount);
  invariant(parsedAmount && compareDecimal(parsedAmount, parseDecimal('0')) > 0, 'reconciliation-value-positive');
  if (key.assetKind === 'cash') {
    invariant(value.kind === 'money' && value.currency === key.assetIdentity && value.scale === key.unitIdentity
      && Number.isSafeInteger(value.scale) && value.scale >= 0, 'reconciliation-value-cash');
    invariant(parsedAmount.scale <= value.scale, 'reconciliation-value-cash-scale');
    return { amount: decimalString(parsedAmount), currency: value.currency, kind: value.kind, scale: value.scale };
  }
  invariant(value.kind === 'quantity' && value.instrumentIri === key.assetIdentity && value.unit === key.unitIdentity
    && Number.isSafeInteger(value.precision) && value.precision >= 0, 'reconciliation-value-security');
  invariant(parsedAmount.scale <= value.precision, 'reconciliation-value-security-precision');
  return {
    amount: decimalString(parsedAmount), instrumentIri: value.instrumentIri,
    kind: value.kind, precision: value.precision, unit: value.unit,
  };
}

function reconciliationValueDimensions(left, right) {
  invariant(left.kind === right.kind, 'reconciliation-value-kind');
  const dimensions = [];
  if (!equalDecimal(left.amount, right.amount)) dimensions.push(left.kind === 'money' ? 'amount' : 'quantity');
  if (left.kind === 'money') {
    if (left.currency !== right.currency) dimensions.push('currency');
    if (left.scale !== right.scale) dimensions.push('scale');
  } else {
    if (left.unit !== right.unit) dimensions.push('unit');
    if (left.precision !== right.precision) dimensions.push('precision');
  }
  return dimensions;
}

function withinMismatchDimensions(values) {
  const dimensions = new Set();
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      for (const dimension of reconciliationValueDimensions(values[left], values[right])) dimensions.add(dimension);
    }
  }
  return sortedUnique([...dimensions]);
}

function crossMismatchDimensions(internalValues, externalValues) {
  const dimensions = new Set();
  for (const internal of internalValues) {
    for (const external of externalValues) {
      for (const dimension of reconciliationValueDimensions(internal, external)) dimensions.add(dimension);
    }
  }
  return sortedUnique([...dimensions]);
}

function validateFindingRecord(finding, key, internalItems, externalItems, missingAssertions) {
  invariant(!hasOwn(finding, 'evidenceVersionIris'), 'reconciliation-private-field');
  const internalIris = sortedUnique(internalItems.map((item) => item.versionIri));
  const externalIris = sortedUnique(externalItems.map((item) => item.versionIri));
  const internalValues = internalItems.map((item) => item.normalizedValue);
  const externalValues = externalItems.map((item) => item.normalizedValue);
  const internalDimensions = withinMismatchDimensions(internalValues);
  const externalDimensions = withinMismatchDimensions(externalValues);
  const crossDimensions = crossMismatchDimensions(internalValues, externalValues);
  const internalCount = internalIris.length;
  const externalCount = externalIris.length;
  invariant(internalCount + externalCount > 0, 'reconciliation-empty-bucket');
  const expectedKind = internalCount > 1 || externalCount > 1 ? 'duplicate'
    : internalCount === 0 || externalCount === 0 ? 'missingSide'
      : crossDimensions.length === 0 ? 'matched' : 'valueMismatch';
  invariant(finding.kind === expectedKind, 'reconciliation-finding-kind');
  invariant(finding.internalCount === internalCount && finding.externalCount === externalCount, 'reconciliation-count');
  invariant(canonical(finding.internalProjectionVersionIris) === canonical(internalIris)
    && canonical(finding.externalStatementLineVersionIris) === canonical(externalIris), 'reconciliation-finding-members');
  invariant(finding.comparisonKeyDigest === key.comparisonKeyDigest, 'reconciliation-finding-key');

  const variants = {
    matched: 'matchedFinding', valueMismatch: 'valueMismatchFinding',
    duplicate: 'duplicateFinding', missingSide: 'missingSideFinding',
  };
  const presentVariants = Object.values(variants).filter((name) => hasOwn(finding, name));
  invariant(presentVariants.length === 1 && presentVariants[0] === variants[expectedKind]
    && finding[variants[expectedKind]] === true, 'reconciliation-variant-xone');
  if (expectedKind === 'matched') {
    invariant((finding.mismatchDimensions || []).length === 0
      && (finding.internalMismatchDimensions || []).length === 0
      && (finding.externalMismatchDimensions || []).length === 0
      && (finding.crossMismatchDimensions || []).length === 0
      && finding.crossSideValueRelation !== 'mismatch', 'reconciliation-matched-forbids-mismatch');
  }

  const expectedDuplicateSide = internalCount > 1 && externalCount > 1 ? 'both'
    : internalCount > 1 ? 'internal' : externalCount > 1 ? 'external' : undefined;
  invariant(finding.duplicateSide === expectedDuplicateSide, 'reconciliation-duplicate-side');
  const internalRelation = internalCount > 1 ? (internalDimensions.length === 0 ? 'identical' : 'conflicting') : undefined;
  const externalRelation = externalCount > 1 ? (externalDimensions.length === 0 ? 'identical' : 'conflicting') : undefined;
  const crossRelation = internalCount > 0 && externalCount > 0 ? (crossDimensions.length === 0 ? 'allEqual' : 'mismatch') : undefined;
  invariant(finding.internalDuplicateValueRelation === internalRelation, 'reconciliation-internal-duplicate-relation');
  invariant(finding.externalDuplicateValueRelation === externalRelation, 'reconciliation-external-duplicate-relation');
  invariant(finding.crossSideValueRelation === crossRelation, 'reconciliation-cross-relation');
  invariant(canonical(finding.internalMismatchDimensions || []) === canonical(internalDimensions), 'reconciliation-internal-mismatch-dimensions');
  invariant(canonical(finding.externalMismatchDimensions || []) === canonical(externalDimensions), 'reconciliation-external-mismatch-dimensions');
  invariant(canonical(finding.crossMismatchDimensions || []) === canonical(crossDimensions), 'reconciliation-cross-mismatch-dimensions');
  const allDimensions = sortedUnique([...internalDimensions, ...externalDimensions, ...crossDimensions]);
  invariant(canonical(finding.mismatchDimensions || []) === canonical(allDimensions), 'reconciliation-mismatch-dimensions');
  if (expectedKind === 'matched') invariant(allDimensions.length === 0 && crossRelation === 'allEqual', 'reconciliation-matched-forbids-mismatch');

  const missingSide = internalCount === 0 ? 'internal' : externalCount === 0 ? 'external' : undefined;
  let missingAssertion;
  if (missingSide) {
    missingAssertion = missingAssertions.get(finding.missingSideAssertionVersionIri);
    invariant(missingAssertion && missingAssertion.keyId === key.keyId && missingAssertion.expectedSide === missingSide, 'reconciliation-missing-side');
  } else invariant(!hasOwn(finding, 'missingSideAssertionVersionIri'), 'reconciliation-composite-missing-side');

  const evidenceIris = sortedUnique([...internalIris, ...externalIris, ...(missingAssertion ? [missingAssertion.versionIri] : [])]);
  invariant(finding.evidenceSetDigest === iriSetDigest(evidenceIris), 'reconciliation-evidence-digest');
  const subject = {
    schemaVersion: '1.0',
    variant: expectedKind,
    internalVersionIris: internalIris,
    externalVersionIris: externalIris,
  };
  if (missingAssertion) subject.missingSideAssertionVersionIri = missingAssertion.versionIri;
  invariant(finding.findingSubjectDigest === findingSubjectDigest(subject), 'reconciliation-finding-subject-digest');
  return `${internalCount}/${externalCount}/${crossDimensions.length === 0 ? 'equal' : 'different'}`;
}

function validateReconciliationLeg(leg, pivots, caseRecord) {
  invariant(leg && typeof leg === 'object', 'reconciliation-allocation-leg');
  validateAbsoluteIri(leg.versionIri, 'reconciliation-leg-identity');
  validateCanonicalText(leg.normalizedSettlementReference, 'reconciliation-leg-reference');
  invariant(/^\d{4}-\d{2}-\d{2}$/u.test(leg.settlementDate || '')
    && !Number.isNaN(Date.parse(`${leg.settlementDate}T00:00:00Z`)), 'reconciliation-leg-date');
  validateCanonicalText(leg.system, 'reconciliation-leg-system');
  validateCanonicalText(leg.location, 'reconciliation-leg-location');
  validateAbsoluteIri(leg.fromAccount, 'reconciliation-leg-account');
  validateAbsoluteIri(leg.toAccount, 'reconciliation-leg-account');
  invariant(leg.fromAccount !== leg.toAccount, 'reconciliation-leg-account');
  invariant(leg.asset && compareDecimal(parseDecimal(leg.asset.amount), parseDecimal('0')) > 0,
    'reconciliation-leg-value');
  if (leg.asset.kind === 'security') {
    validateAbsoluteIri(leg.asset.instrumentIri, 'reconciliation-leg-instrument');
    validateAbsoluteIri(leg.asset.unit, 'reconciliation-leg-unit');
    invariant(!hasOwn(leg.asset, 'currency') && !hasOwn(leg.asset, 'scale')
      && Number.isSafeInteger(leg.asset.precision) && leg.asset.precision >= 0
      && parseDecimal(leg.asset.amount).scale <= leg.asset.precision, 'reconciliation-leg-precision');
  } else {
    invariant(leg.asset.kind === 'money' && /^[A-Z]{3}$/u.test(leg.asset.currency || '')
      && !hasOwn(leg.asset, 'instrumentIri') && !hasOwn(leg.asset, 'unit') && !hasOwn(leg.asset, 'precision')
      && Number.isSafeInteger(leg.asset.scale) && leg.asset.scale >= 0
      && parseDecimal(leg.asset.amount).scale <= leg.asset.scale, 'reconciliation-leg-money');
  }
  if (caseRecord?.internalProjectionMode === 'settlementAccount') {
    validateAbsoluteIri(leg.instructionVersionIri, 'reconciliation-leg-instruction');
    validateAbsoluteIri(leg.instructionAuthorityLogicalIri, 'reconciliation-leg-authority');
    invariant(leg.instructionAuthorityLogicalIri === caseRecord.internalSourceAuthorityLogicalIri,
      'reconciliation-leg-authority');
  }
  invariant(isThreeAxisEligible(leg, pivots, 'reconciliation-leg-pit'), 'reconciliation-leg-pit');
}

function validateReconciliationBridge(bridge, economicAccount, settlementAccount, leg, pivots, code) {
  invariant(bridge && typeof bridge === 'object', code);
  validateAbsoluteIri(bridge.versionIri, code);
  validateAbsoluteIri(bridge.economicAccount, code);
  validateAbsoluteIri(bridge.settlementAccount, code);
  invariant(bridge.economicAccount === economicAccount && bridge.settlementAccount === settlementAccount
    && economicAccount !== settlementAccount, code);
  invariant(bridge.system === leg.system && bridge.location === leg.location, code);
  invariant(isThreeAxisEligible(bridge, pivots, `${code}-pit`), `${code}-pit`);
  return bridge.versionIri;
}

function validateReconciliationAllocationEndpoint(allocation, side, leg, bridges, pivots) {
  const economicAccount = allocation[`${side}EconomicAccount`];
  const settlementAccount = leg[`${side}Account`];
  const mode = allocation[`${side}Mode`];
  const bridgeVersionIri = allocation[`${side}BridgeVersionIri`];
  validateAbsoluteIri(economicAccount, `reconciliation-allocation-${side}-account`);
  if (mode === 'directAccount') {
    invariant(economicAccount === settlementAccount && !hasOwn(allocation, `${side}BridgeVersionIri`), `reconciliation-allocation-${side}-direct-xone`);
    return undefined;
  }
  invariant(mode === 'custodyOrOmnibus' && economicAccount !== settlementAccount
    && typeof bridgeVersionIri === 'string', `reconciliation-allocation-${side}-bridge-xone`);
  return validateReconciliationBridge(
    bridges.get(bridgeVersionIri), economicAccount, settlementAccount, leg, pivots,
    `reconciliation-allocation-${side}-bridge-join`,
  );
}

function validateReconciliationComparator(comparator, caseRecord, pivots) {
  invariant(comparator && typeof comparator === 'object', 'reconciliation-comparator-record');
  validateAbsoluteIri(comparator.versionIri, 'reconciliation-comparator-record');
  invariant(comparator.versionIri === caseRecord.comparatorVersionIri, 'reconciliation-case-comparator');
  for (const field of [
    'implementationDigest', 'runtimeDigest', 'inputContractDigest', 'outputContractDigest',
    'referenceNormalizationDigest', 'canonicalizationDigest',
  ]) validateDigest(comparator[field], 'reconciliation-comparator-contract');
  invariant(equalDecimal(comparator.numericTolerance, '0'), 'reconciliation-comparator-zero-tolerance');
  validateArtifactEvidence(comparator, 'reconciliation-comparator-evidence');
  validateThreeAxisIntervals(comparator, 'reconciliation-comparator-temporal');
  invariant(isThreeAxisEligible(comparator, pivots, 'reconciliation-comparator-pit'), 'reconciliation-comparator-pit');
}

function validateExternalSettlementStatement(statement, instance, pivots) {
  invariant(statement && typeof statement === 'object', 'reconciliation-statement-record');
  validateAbsoluteIri(statement.versionIri, 'reconciliation-statement-record');
  invariant(statement.versionIri === instance.externalStatementVersionIri, 'reconciliation-case-statement-version');
  validateAbsoluteIri(statement.providerVersionIri, 'reconciliation-statement-provider');
  validateAbsoluteIri(statement.providerLogicalIri, 'reconciliation-statement-provider');
  validateCanonicalText(statement.authorityScopedId, 'reconciliation-statement-identity');
  validateAbsoluteIri(statement.focalAccount, 'reconciliation-statement-focal-account');
  invariant(statement.focalAccount === instance.case.focalAccount, 'reconciliation-statement-focal-account');
  validateDateLiteral(statement.statementDate, 'reconciliation-statement-date');
  invariant(statement.statementDate === instance.case.reconciliationDate, 'reconciliation-statement-date');
  validateAbsoluteIri(statement.sourceSnapshotRef, 'reconciliation-statement-snapshot');
  validateDigest(statement.sourceSnapshotDigest, 'reconciliation-statement-snapshot');
  validateDigest(statement.sourceSchemaDigest, 'reconciliation-statement-schema');
  validateArtifactEvidence(statement, 'reconciliation-statement-evidence');
  validateThreeAxisIntervals(statement, 'reconciliation-statement-temporal');
  invariant(isThreeAxisEligible(statement, pivots, 'reconciliation-statement-pit'), 'reconciliation-statement-pit');
  invariant(instance.case.externalProviderLogicalIri === statement.providerLogicalIri
    && instance.case.internalSourceAuthorityLogicalIri !== statement.providerLogicalIri,
  'reconciliation-case-source-authority');
}

function validateReconciliationStatusHistory(events, caseRecord, pivots) {
  invariant(Array.isArray(events) && events.length > 0, 'reconciliation-status-inventory');
  const versionIris = new Set();
  const providerEventIds = new Set();
  const orderKeys = new Set();
  const ordered = [];
  for (const event of events) {
    validateAbsoluteIri(event.versionIri, 'reconciliation-status-identity');
    invariant(!versionIris.has(event.versionIri), 'reconciliation-status-version');
    versionIris.add(event.versionIri);
    validateCanonicalText(event.providerEventId, 'reconciliation-status-identity');
    invariant(!providerEventIds.has(event.providerEventId), 'reconciliation-status-identity');
    providerEventIds.add(event.providerEventId);
    invariant(Number.isSafeInteger(event.sourceOrderKey) && event.sourceOrderKey >= 0
      && !orderKeys.has(event.sourceOrderKey), 'reconciliation-status-order');
    orderKeys.add(event.sourceOrderKey);
    invariant(event.caseVersionIri === caseRecord.versionIri, 'reconciliation-status-case');
    validateAbsoluteIri(event.sourceAuthorityVersionIri, 'reconciliation-status-authority-version');
    validateAbsoluteIri(event.sourceAuthorityLogicalIri, 'reconciliation-status-authority');
    invariant(event.sourceAuthorityVersionIri === caseRecord.internalSourceAuthorityVersionIri
      && event.sourceAuthorityLogicalIri === caseRecord.internalSourceAuthorityLogicalIri,
      'reconciliation-status-authority');
    invariant(['open', 'investigating', 'resolved', 'closedNoAction'].includes(event.state),
      'reconciliation-status-state');
    const observedAt = parseInstant(event.observedAt, 'reconciliation-status-observed-at');
    validateThreeAxisIntervals(event, 'reconciliation-status-temporal');
    invariant(parseInstant(event.validFrom, 'reconciliation-status-temporal') === observedAt,
      'reconciliation-status-valid-from');
    invariant(isThreeAxisEligible(event, pivots, 'reconciliation-status-pit'), 'reconciliation-status-pit');
    validateArtifactEvidence(event, 'reconciliation-status-source-evidence');
    ordered.push({ ...event, observedAtInstant: observedAt });
  }
  ordered.sort((left, right) => left.sourceOrderKey - right.sourceOrderKey);
  invariant(ordered[0].state === 'open', 'reconciliation-status-transition');
  const allowed = {
    open: new Set(['investigating', 'resolved', 'closedNoAction']),
    investigating: new Set(['resolved', 'closedNoAction']),
    resolved: new Set(),
    closedNoAction: new Set(),
  };
  for (let index = 1; index < ordered.length; index += 1) {
    const prior = ordered[index - 1];
    const current = ordered[index];
    invariant(current.observedAtInstant > prior.observedAtInstant, 'reconciliation-status-order');
    invariant(allowed[prior.state].has(current.state), 'reconciliation-status-transition');
  }
  invariant(caseRecord.currentStatus === ordered.at(-1).state, 'reconciliation-status-current');
}

function validateReconciliationDerivedFact(record, pivots, code) {
  validateAbsoluteIri(record.generatingContextRef, `${code}-context`);
  validateThreeAxisIntervals(record, `${code}-temporal`);
  invariant(isThreeAxisEligible(record, pivots, `${code}-pit`), `${code}-pit`);
}

function validateExternalSettlementStatementLine(item, key, statement, pivots) {
  validateAbsoluteIri(item.versionIri, 'reconciliation-external-identity');
  validateCanonicalText(item.authorityScopedId, 'reconciliation-external-identity');
  validateAbsoluteIri(item.focalAccount, 'reconciliation-external-focal-account');
  invariant(item.statementVersionIri === statement.versionIri, 'reconciliation-external-key-statement');
  invariant(item.focalAccount === statement.focalAccount, 'reconciliation-external-header-join');
  invariant(item.normalizedSettlementReference === key.normalizedSettlementReference
    && item.settlementDate === key.settlementDate
    && item.settlementSystem === key.settlementSystem
    && item.settlementLocation === key.settlementLocation
    && item.entryDirection === key.entryDirection, 'reconciliation-external-key-fields');
  validateCanonicalText(item.normalizedSettlementReference, 'reconciliation-external-key-fields');
  validateDateLiteral(item.settlementDate, 'reconciliation-external-key-fields');
  validateCanonicalText(item.settlementSystem, 'reconciliation-external-key-fields');
  validateCanonicalText(item.settlementLocation, 'reconciliation-external-key-fields');
  invariant(['debit', 'credit'].includes(item.entryDirection), 'reconciliation-external-key-fields');
  if (key.assetKind === 'security') {
    validateAbsoluteIri(item.lineInstrumentIri, 'reconciliation-external-instrument');
    invariant(item.lineInstrumentIri === key.assetIdentity, 'reconciliation-external-instrument');
  } else {
    invariant(!hasOwn(item, 'lineInstrumentIri'), 'reconciliation-external-asset-xone');
  }
  validateArtifactEvidence(item, 'reconciliation-external-source-evidence');
  validateThreeAxisIntervals(item, 'reconciliation-external-temporal');
  invariant(isThreeAxisEligible(item, pivots, 'reconciliation-external-pit'), 'reconciliation-external-pit');
}

function validateReconciliation(instance) {
  invariant(instance && instance.case && ['settlementAccount', 'economicAccountAllocation'].includes(instance.case.internalProjectionMode),
    'reconciliation-case-mode');
  const reconciliationMode = instance.case.internalProjectionMode;
  const settlementMarker = instance.case.settlementAccountMode === true;
  const economicMarker = instance.case.economicAccountAllocationMode === true;
  invariant(settlementMarker !== economicMarker
    && settlementMarker === (reconciliationMode === 'settlementAccount'), 'reconciliation-case-mode-xone');
  validateAbsoluteIri(instance.case.logicalIri, 'reconciliation-case-identity');
  validateAbsoluteIri(instance.case.versionIri, 'reconciliation-case-identity');
  validateCanonicalText(instance.case.authorityScopedId, 'reconciliation-case-identity');
  invariant(instance.case.reconciliationScope === 'accountDateSystem', 'reconciliation-case-scope');
  validateAbsoluteIri(instance.case.caseOwnerVersionIri, 'reconciliation-case-owner');
  validateAbsoluteIri(instance.case.internalSourceAuthorityVersionIri, 'reconciliation-case-source-authority-version');
  validateAbsoluteIri(instance.case.focalAccount, 'reconciliation-case-focal-account');
  validateAbsoluteIri(instance.case.comparatorVersionIri, 'reconciliation-case-comparator');
  validateAbsoluteIri(instance.case.externalStatementVersionIri, 'reconciliation-case-statement-version');
  validateAbsoluteIri(instance.case.internalSourceAuthorityLogicalIri, 'reconciliation-case-source-authority');
  validateAbsoluteIri(instance.case.externalProviderLogicalIri, 'reconciliation-case-source-authority');
  validateDateLiteral(instance.case.reconciliationDate, 'reconciliation-case-date');
  const casePivots = {
    asOfValid: parseInstant(instance.case.reconciliationAsOfValid, 'reconciliation-case-pit'),
    asOfKnowledge: parseInstant(instance.case.reconciliationAsOfKnowledge, 'reconciliation-case-pit'),
    asOfAvailable: parseInstant(instance.case.reconciliationAsOfAvailable, 'reconciliation-case-pit'),
  };
  validateAbsoluteIri(instance.case.inputContextRef, 'reconciliation-case-input-context');
  validateDigest(instance.case.inputContextRecordDigest, 'reconciliation-case-input-context');
  validateAbsoluteIri(instance.case.generatingContextRef, 'reconciliation-case-generating-context');
  validateThreeAxisIntervals(instance.case, 'reconciliation-case-temporal');
  invariant(isThreeAxisEligible(instance.case, casePivots, 'reconciliation-case-pit'), 'reconciliation-case-pit');

  validateAbsoluteIri(instance.externalStatementVersionIri, 'reconciliation-case-statement-version');
  invariant(instance.case.externalStatementVersionIri === instance.externalStatementVersionIri,
    'reconciliation-case-statement-version');
  validateReconciliationComparator(instance.comparator, instance.case, casePivots);
  validateExternalSettlementStatement(instance.externalStatement, instance, casePivots);
  const keys = new Map();
  const keysByDigest = new Map();
  for (const key of instance.comparisonKeys || []) {
    validateReconciliationKey(key);
    invariant(!keys.has(key.keyId) && !keysByDigest.has(key.comparisonKeyDigest), 'reconciliation-key-duplicate');
    keys.set(key.keyId, key);
    keysByDigest.set(key.comparisonKeyDigest, key);
  }
  invariant(keys.size > 0, 'reconciliation-key-inventory');

  const legs = new Map();
  for (const leg of instance.legs || []) {
    validateReconciliationLeg(leg, casePivots, instance.case);
    invariant(!legs.has(leg.versionIri), 'reconciliation-leg-duplicate');
    legs.set(leg.versionIri, leg);
  }
  invariant(legs.size > 0, 'reconciliation-leg-inventory');
  if (reconciliationMode === 'settlementAccount') {
    invariant(
      (instance.bridges || []).length === 0,
      'reconciliation-settlement-mode-forbids-allocation',
    );
  }
  const bridges = new Map();
  for (const bridge of instance.bridges || []) {
    validateAbsoluteIri(bridge.versionIri, 'reconciliation-bridge-identity');
    validateAbsoluteIri(bridge.economicAccount, 'reconciliation-bridge-account');
    validateAbsoluteIri(bridge.settlementAccount, 'reconciliation-bridge-account');
    validateCanonicalText(bridge.system, 'reconciliation-bridge-system');
    validateCanonicalText(bridge.location, 'reconciliation-bridge-location');
    validateThreeAxisIntervals(bridge, 'reconciliation-bridge-temporal');
    invariant(!bridges.has(bridge.versionIri), 'reconciliation-bridge-duplicate');
    bridges.set(bridge.versionIri, bridge);
  }

  let currentAllocations = [];
  const allocationState = new Map();
  const groups = new Map();
  if (reconciliationMode === 'settlementAccount') {
    for (const field of [
      'allocationVersionIris', 'allocationCount', 'allocationVersionSetDigest',
      'allocationClosureProbeRef', 'allocationClosureProbeDigest', 'allocationClosureProbe',
    ]) invariant(!hasOwn(instance.case, field), 'reconciliation-settlement-mode-forbids-allocation');
    invariant((instance.allocations || []).length === 0 && bridges.size === 0,
      'reconciliation-settlement-mode-forbids-allocation');
    for (const leg of legs.values()) {
      const isFrom = leg.fromAccount === instance.case.focalAccount;
      const isTo = leg.toAccount === instance.case.focalAccount;
      if (!isFrom && !isTo) continue;
      invariant(isFrom !== isTo, 'reconciliation-settlement-direction');
      const direction = isFrom ? 'debit' : 'credit';
      const isCash = leg.asset.kind === 'money';
      const comparisonKey = {
        focalAccountLogicalIri: instance.case.focalAccount,
        normalizedSettlementReference: leg.normalizedSettlementReference,
        settlementDate: leg.settlementDate,
        settlementSystem: leg.system,
        settlementLocation: leg.location,
        entryDirection: direction,
        assetKind: isCash ? 'cash' : 'security',
        assetIdentity: isCash ? leg.asset.currency : leg.asset.instrumentIri,
        unitIdentity: isCash ? leg.asset.scale : leg.asset.unit,
      };
      const comparisonKeyDigest = settlementComparisonKeyDigest(comparisonKey);
      const key = keysByDigest.get(comparisonKeyDigest);
      invariant(key, 'reconciliation-settlement-key-source', leg.versionIri);
      const groupIdentity = canonical({ legVersionIri: leg.versionIri, direction, comparisonKeyDigest });
      invariant(!groups.has(groupIdentity), 'reconciliation-settlement-source-duplicate');
      groups.set(groupIdentity, {
        legVersionIri: leg.versionIri,
        direction,
        keyId: key.keyId,
        comparisonKeyDigest,
        amount: decimalString(parseDecimal(leg.asset.amount)),
        allocationVersionIris: [],
        bridgeVersionIris: [],
      });
    }
  } else {
    const structuralAllocationState = new Map();
    for (const allocation of instance.allocations || []) {
      validateAbsoluteIri(allocation.logicalIri, 'reconciliation-allocation-identity');
      validateAbsoluteIri(allocation.versionIri, 'reconciliation-allocation-identity');
      validateAbsoluteIri(allocation.securityLegVersionIri, 'reconciliation-allocation-leg');
      if (hasOwn(allocation, 'supersedesVersionIri')) validateAbsoluteIri(allocation.supersedesVersionIri, 'reconciliation-allocation-supersession');
      validateThreeAxisIntervals(allocation, 'reconciliation-allocation-temporal');
      const leg = legs.get(allocation.securityLegVersionIri);
      invariant(leg?.asset.kind === 'security', 'reconciliation-allocation-leg');
      validateAbsoluteIri(
        allocation.fromEconomicAccount,
        'reconciliation-allocation-from-account',
      );
      validateAbsoluteIri(
        allocation.toEconomicAccount,
        'reconciliation-allocation-to-account',
      );
      invariant(
        allocation.fromEconomicAccount !== allocation.toEconomicAccount,
        'reconciliation-allocation-endpoint-distinct',
      );
      const quantity = parseDecimal(allocation.quantity?.amount);
      invariant(
        compareDecimal(quantity, parseDecimal('0')) > 0
          && allocation.quantity.unit === leg.asset.unit
          && quantity.scale <= leg.asset.precision,
        'reconciliation-allocation-quantity',
      );
      for (const side of ['from', 'to']) {
        const economicAccount = allocation[`${side}EconomicAccount`];
        const settlementAccount = leg[`${side}Account`];
        const mode = allocation[`${side}Mode`];
        if (mode === 'directAccount') {
          invariant(
            economicAccount === settlementAccount
              && !hasOwn(allocation, `${side}BridgeVersionIri`),
            `reconciliation-allocation-${side}-direct-xone`,
          );
        } else {
          const bridgeVersionIri = allocation[`${side}BridgeVersionIri`];
          validateAbsoluteIri(
            bridgeVersionIri,
            `reconciliation-allocation-${side}-bridge-xone`,
          );
          const bridge = bridges.get(bridgeVersionIri);
          invariant(
            mode === 'custodyOrOmnibus'
              && economicAccount !== settlementAccount
              && bridge?.economicAccount === economicAccount
              && bridge?.settlementAccount === settlementAccount
              && bridge?.system === leg.system
              && bridge?.location === leg.location,
            `reconciliation-allocation-${side}-bridge-xone`,
          );
        }
      }
      structuralAllocationState.set(allocation.versionIri, { leg, quantity });
    }
    // Resolve the correction chain inside the Case's three-axis visibility
    // boundary. Resolving the global head first would let a future correction
    // erase the still-current predecessor from a historical query.
    currentAllocations = resolveCurrentVersionsAtPivots(
      instance.allocations || [], casePivots, 'reconciliation-allocation',
    );
    const allocatedByLeg = new Map();
    for (const allocation of currentAllocations) {
      const { leg, quantity } = structuralAllocationState.get(
        allocation.versionIri,
      );
      const bridgeVersionIris = [];
      for (const side of ['from', 'to']) {
        const bridgeVersionIri = validateReconciliationAllocationEndpoint(allocation, side, leg, bridges, casePivots);
        if (bridgeVersionIri) bridgeVersionIris.push(bridgeVersionIri);
      }
      allocationState.set(allocation.versionIri, { bridgeVersionIris: sortedUnique(bridgeVersionIris), leg, quantity });
      allocatedByLeg.set(
        leg.versionIri,
        addDecimal(
          allocatedByLeg.get(leg.versionIri) || parseDecimal('0'),
          quantity,
        ),
      );
    }
    for (const [legVersionIri, allocated] of allocatedByLeg) {
      invariant(
        compareDecimal(
          allocated,
          parseDecimal(legs.get(legVersionIri).asset.amount),
        ) <= 0,
        'reconciliation-allocation-conservation',
        legVersionIri,
      );
    }
    const relevant = currentAllocations.filter((allocation) => allocation.fromEconomicAccount === instance.case.focalAccount
      || allocation.toEconomicAccount === instance.case.focalAccount);
    const relevantIris = sortedUnique(relevant.map((allocation) => allocation.versionIri));
    const relevantSetDigest = iriSetDigest(relevantIris);
    validateCompletedProbe(instance.case.allocationClosureProbe, 'reconciliation-allocation-closure-probe', relevantSetDigest);
    validateAbsoluteIri(instance.case.allocationClosureProbeRef, 'reconciliation-allocation-closure-probe-ref');
    validateDigest(instance.case.allocationClosureProbeDigest, 'reconciliation-allocation-closure-probe-digest');
    invariant(instance.case.allocationClosureProbeRef === instance.case.allocationClosureProbe.ref
      && instance.case.allocationClosureProbeDigest === instance.case.allocationClosureProbe.digest,
    'reconciliation-allocation-closure-probe-contract');
    invariant(canonical(instance.case.allocationVersionIris) === canonical(relevantIris), 'reconciliation-allocation-set');
    invariant(instance.case.allocationCount === relevantIris.length
      && instance.case.allocationVersionSetDigest === relevantSetDigest, 'reconciliation-allocation-closure');
    for (const allocation of relevant) {
      const { leg, quantity, bridgeVersionIris } = allocationState.get(allocation.versionIri);
      const isFrom = allocation.fromEconomicAccount === instance.case.focalAccount;
      const isTo = allocation.toEconomicAccount === instance.case.focalAccount;
      invariant(isFrom !== isTo, 'reconciliation-allocation-direction');
      const direction = isFrom ? 'debit' : 'credit';
      const comparisonKey = {
        focalAccountLogicalIri: instance.case.focalAccount,
        normalizedSettlementReference: leg.normalizedSettlementReference,
        settlementDate: leg.settlementDate,
        settlementSystem: leg.system,
        settlementLocation: leg.location,
        entryDirection: direction,
        assetKind: 'security',
        assetIdentity: leg.asset.instrumentIri,
        unitIdentity: leg.asset.unit,
      };
      const comparisonKeyDigest = settlementComparisonKeyDigest(comparisonKey);
      const key = keysByDigest.get(comparisonKeyDigest);
      invariant(key, 'reconciliation-economic-key-source', leg.versionIri);
      const groupIdentity = canonical({ legVersionIri: leg.versionIri, direction, comparisonKeyDigest });
      const group = groups.get(groupIdentity) || {
        legVersionIri: leg.versionIri,
        direction,
        keyId: key.keyId,
        comparisonKeyDigest,
        amount: parseDecimal('0'),
        allocationVersionIris: [],
        bridgeVersionIris: [],
      };
      group.amount = addDecimal(group.amount, quantity);
      group.allocationVersionIris.push(allocation.versionIri);
      group.bridgeVersionIris.push(...bridgeVersionIris);
      groups.set(groupIdentity, group);
    }
  }
  const actual = [...groups.values()].map((group) => ({
    legVersionIri: group.legVersionIri,
    direction: group.direction,
    keyId: group.keyId,
    comparisonKeyDigest: group.comparisonKeyDigest,
    amount: typeof group.amount === 'string' ? group.amount : decimalString(group.amount),
    allocationVersionIris: sortedUnique(group.allocationVersionIris),
    bridgeVersionIris: sortedUnique(group.bridgeVersionIris),
  })).sort(compareCanonical);
  const expected = [...(instance.expectedProjections || [])].sort(compareCanonical);
  invariant(canonical(actual) === canonical(expected), reconciliationMode === 'settlementAccount'
    ? 'reconciliation-settlement-projection' : 'reconciliation-economic-projection');
  if (reconciliationMode === 'economicAccountAllocation') {
    for (const projection of actual) {
      const leg = legs.get(projection.legVersionIri);
      invariant(compareDecimal(parseDecimal(projection.amount), parseDecimal(leg.asset.amount)) <= 0, 'reconciliation-allocation-conservation');
      if (projection.allocationVersionIris.length < currentAllocations.filter((item) => item.securityLegVersionIri === leg.versionIri).length) {
        invariant(compareDecimal(parseDecimal(projection.amount), parseDecimal(leg.asset.amount)) < 0, 'reconciliation-omnibus-full-leg-attribution');
      }
    }
  }

  const sourceGroups = new Map(actual.map((group) => [`${group.legVersionIri}\0${group.direction}`, group]));
  invariant((instance.internalProjections || []).length === actual.length, 'reconciliation-internal-source-closure');
  const consumedSourceGroups = new Set();
  for (const item of instance.internalProjections || []) {
    validateAbsoluteIri(item.versionIri, 'reconciliation-internal-identity');
    validateReconciliationDerivedFact(item, casePivots, 'reconciliation-internal');
    const sourceGroupId = `${item.legVersionIri}\0${item.direction}`;
    const sourceGroup = sourceGroups.get(sourceGroupId);
    invariant(sourceGroup && !consumedSourceGroups.has(sourceGroupId), 'reconciliation-internal-source-closure');
    consumedSourceGroups.add(sourceGroupId);
    const key = keys.get(item.keyId);
    invariant(key && item.caseVersionIri === instance.case.versionIri
      && item.comparatorVersionIri === instance.case.comparatorVersionIri
      && item.focalAccount === instance.case.focalAccount
      && item.mode === reconciliationMode
      && item.comparisonKeyDigest === key.comparisonKeyDigest
      && item.keyId === sourceGroup.keyId
      && item.comparisonKeyDigest === sourceGroup.comparisonKeyDigest, 'reconciliation-internal-key-case');
    invariant(item.normalizedSettlementReference === key.normalizedSettlementReference
      && item.settlementDate === key.settlementDate
      && item.settlementSystem === key.settlementSystem
      && item.settlementLocation === key.settlementLocation
      && item.entryDirection === key.entryDirection
      && item.settlementAssetKind === key.assetKind, 'reconciliation-internal-key-fields');
    validateCanonicalText(item.normalizedSettlementReference, 'reconciliation-internal-key-fields');
    validateDateLiteral(item.settlementDate, 'reconciliation-internal-key-fields');
    validateCanonicalText(item.settlementSystem, 'reconciliation-internal-key-fields');
    validateCanonicalText(item.settlementLocation, 'reconciliation-internal-key-fields');
    if (key.assetKind === 'security') {
      validateAbsoluteIri(item.projectionInstrumentIri, 'reconciliation-internal-instrument');
      invariant(item.projectionInstrumentIri === key.assetIdentity, 'reconciliation-internal-instrument');
    } else invariant(!hasOwn(item, 'projectionInstrumentIri'), 'reconciliation-internal-asset-xone');
    invariant(item.reconciliationAsOfValid === instance.case.reconciliationAsOfValid
      && item.reconciliationAsOfKnowledge === instance.case.reconciliationAsOfKnowledge
      && item.reconciliationAsOfAvailable === instance.case.reconciliationAsOfAvailable
      && item.inputContextRef === instance.case.inputContextRef, 'reconciliation-internal-pit-context');
    const projectionSettlementMarker = item.projectionSettlementAccountMode === true;
    const projectionEconomicMarker = item.projectionEconomicAllocationMode === true;
    invariant(projectionSettlementMarker !== projectionEconomicMarker
      && projectionSettlementMarker === (reconciliationMode === 'settlementAccount'),
    'reconciliation-internal-mode-xone');
    if (reconciliationMode === 'settlementAccount') {
      invariant(!hasOwn(item, 'allocationVersionIris') && !hasOwn(item, 'bridgeVersionIris'),
        'reconciliation-settlement-projection-source-xone');
    } else {
      invariant(canonical(item.allocationVersionIris) === canonical(sourceGroup.allocationVersionIris)
        && canonical(item.bridgeVersionIris) === canonical(sourceGroup.bridgeVersionIris), 'reconciliation-internal-source-members');
    }
    const sourceVersionIris = sortedUnique([
      sourceGroup.legVersionIri, ...sourceGroup.allocationVersionIris, ...sourceGroup.bridgeVersionIris,
    ]);
    invariant(item.internalSourceVersionSetDigest === iriSetDigest(sourceVersionIris), 'reconciliation-internal-source-digest');
    const leg = legs.get(sourceGroup.legVersionIri);
    const normalizedValue = normalizeReconciliationValue(item.value, key);
    const expectedValue = normalizeReconciliationValue(leg.asset.kind === 'money' ? {
      kind: 'money', amount: sourceGroup.amount, currency: leg.asset.currency, scale: leg.asset.scale,
    } : {
      kind: 'quantity', amount: sourceGroup.amount, instrumentIri: leg.asset.instrumentIri,
      unit: leg.asset.unit, precision: leg.asset.precision,
    }, key);
    invariant(canonical(normalizedValue) === canonical(expectedValue), 'reconciliation-internal-value-source');
  }
  invariant(consumedSourceGroups.size === sourceGroups.size, 'reconciliation-internal-source-closure');

  const internalByKey = new Map([...keys.keys()].map((keyId) => [keyId, []]));
  const externalByKey = new Map([...keys.keys()].map((keyId) => [keyId, []]));
  const recordVersions = new Set();
  const externalLineIdentities = new Set();
  for (const item of instance.internalProjections || []) {
    const key = keys.get(item.keyId);
    invariant(key && item.caseVersionIri === instance.case.versionIri
      && item.comparisonKeyDigest === key.comparisonKeyDigest, 'reconciliation-internal-key-case');
    invariant(!recordVersions.has(item.versionIri), 'reconciliation-record-version');
    recordVersions.add(item.versionIri);
    internalByKey.get(item.keyId).push({ ...item, normalizedValue: normalizeReconciliationValue(item.value, key) });
  }
  for (const item of instance.externalStatementLines || []) {
    const key = keys.get(item.keyId);
    invariant(key, 'reconciliation-external-key-statement');
    validateExternalSettlementStatementLine(item, key, instance.externalStatement, casePivots);
    invariant(key && item.statementVersionIri === instance.externalStatementVersionIri
      && item.comparisonKeyDigest === key.comparisonKeyDigest, 'reconciliation-external-key-statement');
    const externalIdentity = `${item.statementVersionIri}\0${item.authorityScopedId}`;
    invariant(!externalLineIdentities.has(externalIdentity), 'reconciliation-external-authority-identity');
    externalLineIdentities.add(externalIdentity);
    invariant(!recordVersions.has(item.versionIri), 'reconciliation-record-version');
    recordVersions.add(item.versionIri);
    externalByKey.get(item.keyId).push({ ...item, normalizedValue: normalizeReconciliationValue(item.value, key) });
  }
  const missingAssertions = new Map();
  for (const assertion of instance.missingSideAssertions || []) {
    invariant(assertion && !recordVersions.has(assertion.versionIri), 'reconciliation-missing-assertion-version');
    validateAbsoluteIri(assertion.versionIri, 'reconciliation-missing-assertion-version');
    recordVersions.add(assertion.versionIri);
    const key = keys.get(assertion.keyId);
    invariant(key && assertion.comparisonKeyDigest === key.comparisonKeyDigest && ['internal', 'external'].includes(assertion.expectedSide), 'reconciliation-missing-assertion-key');
    validateMissingSideKey(assertion);
    invariant(assertion.caseVersionIri === instance.case.versionIri
      && assertion.comparatorVersionIri === instance.case.comparatorVersionIri
      && assertion.focalAccountLogicalIri === key.focalAccountLogicalIri
      && assertion.normalizedSettlementReference === key.normalizedSettlementReference
      && assertion.settlementDate === key.settlementDate
      && assertion.settlementSystem === key.settlementSystem
      && assertion.settlementLocation === key.settlementLocation
      && assertion.entryDirection === key.entryDirection
      && assertion.assetKind === key.assetKind, 'reconciliation-missing-assertion-key');
    if (key.assetKind === 'cash') {
      invariant(assertion.comparisonCurrencyAlphaCode === key.assetIdentity
        && assertion.comparisonCurrencyScale === key.unitIdentity, 'reconciliation-missing-assertion-key');
    } else {
      invariant(assertion.comparisonInstrumentIri === key.assetIdentity
        && assertion.comparisonQuantityUnit === key.unitIdentity, 'reconciliation-missing-assertion-key');
    }
    invariant(parseInstant(assertion.reconciliationAsOfValid, 'reconciliation-missing-assertion-pit') === casePivots.asOfValid
      && parseInstant(assertion.reconciliationAsOfKnowledge, 'reconciliation-missing-assertion-pit') === casePivots.asOfKnowledge
      && parseInstant(assertion.reconciliationAsOfAvailable, 'reconciliation-missing-assertion-pit') === casePivots.asOfAvailable,
    'reconciliation-missing-assertion-pit');
    validateReconciliationDerivedFact(assertion, casePivots, 'reconciliation-missing-assertion');
    validateAbsoluteIri(assertion.pitRequestRef, 'reconciliation-missing-pit-request-binding');
    validateDigest(assertion.pitRequestRecordDigest, 'reconciliation-missing-pit-request-binding');
    validateAbsoluteIri(assertion.inputContextRef, 'reconciliation-missing-input-run-binding');
    validateDigest(assertion.inputContextRecordDigest, 'reconciliation-missing-input-run-binding');
    validateMissingSideAbsenceProbe(assertion, instance, casePivots);
    validateAbsoluteIri(assertion.absenceProbeRef, 'reconciliation-missing-absence-probe-ref');
    validateDigest(assertion.absenceProbeDigest, 'reconciliation-missing-absence-probe-digest');
    invariant(assertion.absenceProbeRef === assertion.absenceProbe.ref
      && assertion.absenceProbeDigest === assertion.absenceProbe.digest,
    'reconciliation-missing-absence-probe-contract');
    missingAssertions.set(assertion.versionIri, assertion);
  }
  const findingKeys = new Set();
  const usedMissingAssertions = new Set();
  const coverage = new Set();
  for (const finding of instance.findings || []) {
    invariant(finding && !recordVersions.has(finding.versionIri), 'reconciliation-finding-version');
    validateAbsoluteIri(finding.versionIri, 'reconciliation-finding-version');
    invariant(finding.caseVersionIri === instance.case.versionIri, 'reconciliation-finding-case');
    recordVersions.add(finding.versionIri);
    const key = keys.get(finding.keyId);
    invariant(key && !findingKeys.has(finding.keyId), 'reconciliation-finding-key-unique');
    findingKeys.add(finding.keyId);
    const coverageKey = validateFindingRecord(
      finding, key, internalByKey.get(finding.keyId), externalByKey.get(finding.keyId), missingAssertions,
    );
    validateReconciliationDerivedFact(finding, casePivots, 'reconciliation-finding');
    coverage.add(coverageKey);
    if (finding.missingSideAssertionVersionIri) usedMissingAssertions.add(finding.missingSideAssertionVersionIri);
  }
  invariant(findingKeys.size === keys.size, 'reconciliation-finding-closure');
  invariant(canonical(sortedUnique([...usedMissingAssertions])) === canonical(sortedUnique([...missingAssertions.keys()])), 'reconciliation-missing-assertion-closure');
  const requiredCoverage = reconciliationMode === 'economicAccountAllocation'
    ? ['1/1/equal', '1/1/different', '1/0/equal', '0/1/equal', '2/0/equal', '0/2/equal', '2/1/equal', '1/2/equal', '2/2/equal']
    : ['1/1/equal', '1/1/different'];
  for (const key of requiredCoverage) {
    invariant(coverage.has(key), 'reconciliation-matrix-coverage', key);
  }
  validateReconciliationStatusHistory(instance.statusEvents, instance.case, casePivots);
}

const PROCESSING_FINDING_SUBJECT_FIELD = Object.freeze({
  schedule: 'scheduleSubjectVersionIri',
  entitlement: 'entitlementSubjectVersionIri',
  dueBill: 'dueBillSubjectVersionIri',
});

const PROCESSING_FINDING_SUBJECT_TYPE = Object.freeze({
  schedule: 'CorporateActionScheduleEvaluationInput',
  entitlement: 'CorporateActionEntitlement',
  dueBill: 'CorporateActionScheduleResolution',
});

const PROCESSING_FINDING_RELATED_FIELD = Object.freeze({
  relatedEntitlementVersionIri: Object.freeze({
    eventJoin: true,
    multiple: false,
    subjectJoinField: 'scheduleResolutionVersionIri',
    type: 'CorporateActionEntitlement',
  }),
  findingRuleConflictVersionIri: Object.freeze({ multiple: false, type: 'RuleConflict' }),
  failedAssessmentVersionIri: Object.freeze({ multiple: false, type: 'CorporateActionDistributionSizeAssessment' }),
  relatedElectionVersionIris: Object.freeze({ multiple: true, type: 'CorporateActionElection' }),
  relatedElectionResolutionVersionIri: Object.freeze({ multiple: false, type: 'CorporateActionElectionResolution' }),
  relatedSubscriptionObligationVersionIri: Object.freeze({ multiple: false, type: 'CorporateActionSubscriptionObligation' }),
  relatedSubscriptionClosureVersionIri: Object.freeze({ multiple: false, type: 'CorporateActionSubscriptionFulfillmentClosure' }),
  relatedAdjustmentVersionIri: Object.freeze({ multiple: false, type: 'CorporateActionAdjustment' }),
  relatedDueBillQualificationVersionIri: Object.freeze({ multiple: false, type: 'CorporateActionDueBillTradeQualification' }),
  relatedDueBillObligationVersionIri: Object.freeze({ multiple: false, type: 'CorporateActionDueBillObligation' }),
  relatedDueBillTransferVersionIris: Object.freeze({ multiple: true, type: 'CorporateActionDueBillTransfer' }),
  relatedDueBillClosureVersionIri: Object.freeze({ multiple: false, type: 'CorporateActionDueBillTransferFulfillmentClosure' }),
});

const PROCESSING_FINDING_MATRIX = Object.freeze({
  schedule: Object.freeze({
    noApplicableRule: Object.freeze({ allowed: Object.freeze([]), required: Object.freeze([]) }),
    ruleConflict: Object.freeze({
      allowed: Object.freeze(['findingRuleConflictVersionIri']),
      required: Object.freeze(['findingRuleConflictVersionIri']),
    }),
    sizeAssessmentFailure: Object.freeze({
      allowed: Object.freeze(['failedAssessmentVersionIri']),
      required: Object.freeze([]),
    }),
  }),
  entitlement: Object.freeze({
    missingElection: Object.freeze({ allowed: Object.freeze([]), required: Object.freeze([]) }),
    lateElection: Object.freeze({
      allowed: Object.freeze(['relatedElectionVersionIris']),
      minimum: Object.freeze({ relatedElectionVersionIris: 1 }),
      required: Object.freeze(['relatedElectionVersionIris']),
    }),
    overElection: Object.freeze({
      allowed: Object.freeze(['relatedElectionVersionIris']),
      minimum: Object.freeze({ relatedElectionVersionIris: 1 }),
      required: Object.freeze(['relatedElectionVersionIris']),
    }),
    unauthorizedElection: Object.freeze({
      allowed: Object.freeze(['relatedElectionVersionIris']),
      minimum: Object.freeze({ relatedElectionVersionIris: 1 }),
      required: Object.freeze(['relatedElectionVersionIris']),
    }),
    electionConflict: Object.freeze({
      allowed: Object.freeze(['relatedElectionVersionIris']),
      minimum: Object.freeze({ relatedElectionVersionIris: 2 }),
      required: Object.freeze(['relatedElectionVersionIris']),
    }),
    invalidDefaultLapse: Object.freeze({
      allowed: Object.freeze(['relatedElectionResolutionVersionIri']),
      required: Object.freeze(['relatedElectionResolutionVersionIri']),
    }),
    electionResolutionFailure: Object.freeze({
      allowed: Object.freeze(['relatedElectionVersionIris', 'relatedElectionResolutionVersionIri']),
      required: Object.freeze([]),
    }),
    subscriptionFulfillmentMismatch: Object.freeze({
      allowed: Object.freeze([
        'relatedElectionVersionIris', 'relatedElectionResolutionVersionIri',
        'relatedSubscriptionObligationVersionIri', 'relatedSubscriptionClosureVersionIri',
      ]),
      minimum: Object.freeze({ relatedElectionVersionIris: 1 }),
      required: Object.freeze([
        'relatedElectionVersionIris', 'relatedElectionResolutionVersionIri',
        'relatedSubscriptionObligationVersionIri', 'relatedSubscriptionClosureVersionIri',
      ]),
    }),
    calculationMismatch: Object.freeze({
      allowed: Object.freeze([
        'relatedElectionVersionIris', 'relatedElectionResolutionVersionIri',
        'relatedSubscriptionObligationVersionIri', 'relatedSubscriptionClosureVersionIri',
        'relatedAdjustmentVersionIri',
      ]),
      required: Object.freeze([]),
    }),
    adjustmentMismatch: Object.freeze({
      allowed: Object.freeze([
        'relatedElectionVersionIris', 'relatedElectionResolutionVersionIri',
        'relatedSubscriptionObligationVersionIri', 'relatedSubscriptionClosureVersionIri',
        'relatedAdjustmentVersionIri',
      ]),
      required: Object.freeze(['relatedAdjustmentVersionIri']),
    }),
  }),
  dueBill: Object.freeze({
    missingDueBillEvidence: Object.freeze({
      allowed: Object.freeze([
        'relatedEntitlementVersionIri',
        'relatedDueBillQualificationVersionIri', 'relatedDueBillObligationVersionIri',
        'relatedDueBillTransferVersionIris', 'relatedDueBillClosureVersionIri',
      ]),
      required: Object.freeze([]),
    }),
    conflictingDueBillEvidence: Object.freeze({
      allowed: Object.freeze([
        'relatedEntitlementVersionIri',
        'relatedDueBillQualificationVersionIri', 'relatedDueBillObligationVersionIri',
        'relatedDueBillTransferVersionIris', 'relatedDueBillClosureVersionIri',
      ]),
      minimumRelatedCount: 2,
      required: Object.freeze([]),
    }),
    ineligibleTradeQualification: Object.freeze({
      allowed: Object.freeze(['relatedEntitlementVersionIri', 'relatedDueBillQualificationVersionIri']),
      required: Object.freeze(['relatedDueBillQualificationVersionIri']),
    }),
    endpointMismatch: Object.freeze({
      allowed: Object.freeze([
        'relatedEntitlementVersionIri',
        'relatedDueBillQualificationVersionIri', 'relatedDueBillObligationVersionIri',
        'relatedDueBillTransferVersionIris',
      ]),
      minimumRelatedCount: 1,
      required: Object.freeze([]),
    }),
    obligationBenefitMismatch: Object.freeze({
      allowed: Object.freeze(['relatedEntitlementVersionIri', 'relatedDueBillObligationVersionIri']),
      required: Object.freeze(['relatedDueBillObligationVersionIri']),
    }),
    dueBillTransferMismatch: Object.freeze({
      allowed: Object.freeze([
        'relatedEntitlementVersionIri', 'relatedDueBillObligationVersionIri',
        'relatedDueBillTransferVersionIris',
      ]),
      minimum: Object.freeze({ relatedDueBillTransferVersionIris: 1 }),
      required: Object.freeze(['relatedDueBillObligationVersionIri', 'relatedDueBillTransferVersionIris']),
    }),
    duplicateTransfer: Object.freeze({
      allowed: Object.freeze(['relatedEntitlementVersionIri', 'relatedDueBillTransferVersionIris']),
      minimum: Object.freeze({ relatedDueBillTransferVersionIris: 2 }),
      required: Object.freeze(['relatedDueBillTransferVersionIris']),
    }),
    overTransfer: Object.freeze({
      allowed: Object.freeze([
        'relatedEntitlementVersionIri', 'relatedDueBillObligationVersionIri',
        'relatedDueBillTransferVersionIris',
        'relatedDueBillClosureVersionIri',
      ]),
      minimum: Object.freeze({ relatedDueBillTransferVersionIris: 1 }),
      required: Object.freeze([
        'relatedDueBillObligationVersionIri', 'relatedDueBillTransferVersionIris',
        'relatedDueBillClosureVersionIri',
      ]),
    }),
  }),
});

function processingFindingRelatedIris(finding, matrix) {
  const values = [];
  for (const field of matrix.allowed) {
    if (!hasOwn(finding, field)) continue;
    const descriptor = PROCESSING_FINDING_RELATED_FIELD[field];
    if (descriptor.multiple) {
      invariant(Array.isArray(finding[field]), 'processing-finding-presence-matrix', field);
      values.push(...finding[field]);
    } else values.push(finding[field]);
  }
  return values;
}

function validateProcessingFinding(instance) {
  invariant(instance && typeof instance === 'object' && !Array.isArray(instance), 'processing-finding-instance');
  invariant(Array.isArray(instance.records) && Array.isArray(instance.findings) && instance.findings.length > 0,
    'processing-finding-instance');
  const records = new Map();
  for (const record of instance.records) {
    invariant(record && typeof record === 'object' && !Array.isArray(record), 'processing-finding-reference');
    validateAbsoluteIri(record.versionIri, 'processing-finding-reference');
    invariant(typeof record.type === 'string' && !records.has(record.versionIri), 'processing-finding-reference');
    if (record.type === 'CorporateActionEvent') {
      exactKeys(record, ['type', 'logicalIri', 'versionIri'], [], 'processing-finding-reference');
      validateAbsoluteIri(record.logicalIri, 'processing-finding-event');
    } else if (Object.values(PROCESSING_FINDING_SUBJECT_TYPE).includes(record.type)) {
      const optional = record.type === 'CorporateActionEntitlement'
        ? ['scheduleResolutionVersionIri'] : [];
      exactKeys(record, ['type', 'versionIri', 'eventVersionIri'], optional,
        'processing-finding-reference');
      validateAbsoluteIri(record.eventVersionIri, 'processing-finding-reference');
      if (hasOwn(record, 'scheduleResolutionVersionIri')) {
        validateAbsoluteIri(record.scheduleResolutionVersionIri, 'processing-finding-reference');
      }
    } else if (Object.values(PROCESSING_FINDING_RELATED_FIELD).some((descriptor) => descriptor.type === record.type)) {
      exactKeys(record, ['type', 'versionIri', 'subjectVersionIri'], [], 'processing-finding-reference');
      validateAbsoluteIri(record.subjectVersionIri, 'processing-finding-reference');
    } else invariant(false, 'processing-finding-reference-type', record.type);
    records.set(record.versionIri, record);
  }

  const logicalByIdentity = new Map();
  const identityByLogical = new Map();
  const versionIris = new Set();
  const versionKeys = new Set();
  const logicalRevisionKeys = new Set();
  for (const finding of instance.findings) {
    invariant(finding && typeof finding === 'object' && !Array.isArray(finding), 'processing-finding-record');
    exactKeys(finding, [
      'logicalIri', 'versionIri', 'eventLogicalIri', 'eventVersionIri', 'findingStage',
      'processingFindingKind', 'evidenceSetDigest',
      'generatingContextRef', 'validFrom', 'knowledgeFrom', 'availableFrom', 'revision',
    ], [
      ...Object.values(PROCESSING_FINDING_SUBJECT_FIELD),
      ...Object.keys(PROCESSING_FINDING_RELATED_FIELD),
      'validTo', 'knowledgeTo', 'availableTo', 'supersedesVersionIri',
    ], 'processing-finding-record');
    validateAbsoluteIri(finding.logicalIri, 'processing-finding-logical-identity');
    validateAbsoluteIri(finding.versionIri, 'processing-finding-version');
    invariant(!versionIris.has(finding.versionIri), 'processing-finding-version');
    versionIris.add(finding.versionIri);
    validateAbsoluteIri(finding.eventLogicalIri, 'processing-finding-event');
    validateAbsoluteIri(finding.eventVersionIri, 'processing-finding-event');
    validateAbsoluteIri(finding.generatingContextRef, 'processing-finding-generating-context');
    validateThreeAxisIntervals(finding, 'processing-finding-temporal');
    invariant(Number.isSafeInteger(finding.revision) && finding.revision >= 0, 'processing-finding-version-key');
    if (hasOwn(finding, 'supersedesVersionIri')) {
      validateAbsoluteIri(finding.supersedesVersionIri, 'processing-finding-supersession');
    }
    const event = records.get(finding.eventVersionIri);
    invariant(event?.type === 'CorporateActionEvent' && event.logicalIri === finding.eventLogicalIri,
      'processing-finding-event');
    const matrix = PROCESSING_FINDING_MATRIX[finding.findingStage]?.[finding.processingFindingKind];
    invariant(Boolean(matrix), 'processing-finding-stage-kind');
    const subjectFields = Object.values(PROCESSING_FINDING_SUBJECT_FIELD).filter((field) => hasOwn(finding, field));
    const subjectField = PROCESSING_FINDING_SUBJECT_FIELD[finding.findingStage];
    invariant(subjectFields.length === 1 && subjectFields[0] === subjectField,
      'processing-finding-stage-xone');
    const subjectVersionIri = finding[subjectField];
    validateAbsoluteIri(subjectVersionIri, 'processing-finding-stage-subject');
    const subject = records.get(subjectVersionIri);
    invariant(subject?.type === PROCESSING_FINDING_SUBJECT_TYPE[finding.findingStage]
      && subject.eventVersionIri === finding.eventVersionIri, 'processing-finding-stage-subject');

    const presentRelated = Object.keys(PROCESSING_FINDING_RELATED_FIELD).filter((field) => hasOwn(finding, field));
    invariant(presentRelated.every((field) => matrix.allowed.includes(field)), 'processing-finding-presence-matrix');
    invariant(matrix.required.every((field) => hasOwn(finding, field)), 'processing-finding-presence-matrix');
    for (const [field, minimum] of Object.entries(matrix.minimum || {})) {
      invariant(Array.isArray(finding[field]) && finding[field].length >= minimum,
        'processing-finding-presence-matrix', field);
    }
    let relatedCount = 0;
    for (const field of presentRelated) {
      const descriptor = PROCESSING_FINDING_RELATED_FIELD[field];
      const iris = descriptor.multiple ? finding[field] : [finding[field]];
      invariant(Array.isArray(iris) && iris.length > 0 && sortedUnique(iris).length === iris.length,
        'processing-finding-related-reference', field);
      relatedCount += iris.length;
      for (const iri of iris) {
        validateAbsoluteIri(iri, 'processing-finding-related-reference');
        const related = records.get(iri);
        const subjectJoinField = descriptor.subjectJoinField || 'subjectVersionIri';
        invariant(related?.type === descriptor.type && related[subjectJoinField] === subjectVersionIri,
          'processing-finding-related-reference', field);
        if (descriptor.eventJoin) {
          invariant(related.eventVersionIri === finding.eventVersionIri,
            'processing-finding-related-reference', field);
        }
      }
    }
    invariant(relatedCount >= (matrix.minimumRelatedCount || 0), 'processing-finding-presence-matrix');

    const expectedEvidence = sortedUnique([
      finding.eventVersionIri,
      subjectVersionIri,
      ...processingFindingRelatedIris(finding, matrix),
    ]);
    invariant(finding.evidenceSetDigest === iriSetDigest(expectedEvidence),
      'processing-finding-evidence-digest');

    const identityKey = canonical({
      eventLogicalIri: finding.eventLogicalIri,
      findingKind: finding.processingFindingKind,
      stageSubjectVersionIri: subjectVersionIri,
    });
    invariant(!logicalByIdentity.has(identityKey) || logicalByIdentity.get(identityKey) === finding.logicalIri,
      'processing-finding-logical-identity');
    invariant(!identityByLogical.has(finding.logicalIri) || identityByLogical.get(finding.logicalIri) === identityKey,
      'processing-finding-logical-identity');
    logicalByIdentity.set(identityKey, finding.logicalIri);
    identityByLogical.set(finding.logicalIri, identityKey);
    const logicalRevisionKey = canonical({
      logicalIri: finding.logicalIri,
      revision: finding.revision,
    });
    invariant(!logicalRevisionKeys.has(logicalRevisionKey), 'processing-finding-supersession');
    logicalRevisionKeys.add(logicalRevisionKey);
    const versionKey = canonical({
      availableFrom: finding.availableFrom,
      knowledgeFrom: finding.knowledgeFrom,
      logicalIri: finding.logicalIri,
      revision: finding.revision,
      validFrom: finding.validFrom,
    });
    invariant(!versionKeys.has(versionKey), 'processing-finding-version-key');
    versionKeys.add(versionKey);
  }
  const successorByPredecessor = new Map();
  for (const finding of instance.findings) {
    if (!hasOwn(finding, 'supersedesVersionIri')) {
      invariant(finding.revision === 0, 'processing-finding-supersession');
      continue;
    }
    const predecessor = instance.findings.find(
      (candidate) => candidate.versionIri === finding.supersedesVersionIri,
    );
    invariant(predecessor && predecessor.logicalIri === finding.logicalIri
      && finding.revision === predecessor.revision + 1
      && parseInstant(finding.knowledgeFrom, 'processing-finding-supersession')
        > parseInstant(predecessor.knowledgeFrom, 'processing-finding-supersession'),
    'processing-finding-supersession');
    invariant(!successorByPredecessor.has(predecessor.versionIri),
      'processing-finding-supersession');
    successorByPredecessor.set(predecessor.versionIri, finding.versionIri);
  }
}

function queryProcessingFindings(instance, query) {
  validateProcessingFinding(instance);
  invariant(query && typeof query === 'object' && !Array.isArray(query),
    'processing-finding-query');
  exactKeys(query, ['eventVersionIri', 'pivot'], [], 'processing-finding-query');
  validateAbsoluteIri(query.eventVersionIri, 'processing-finding-query-event');
  invariant(query.pivot && typeof query.pivot === 'object' && !Array.isArray(query.pivot),
    'processing-finding-query-pivot');
  exactKeys(query.pivot,
    ['asOfValid', 'asOfKnowledge', 'asOfAvailable', 'referenceTime'], [],
    'processing-finding-query-pivot');
  const pivots = {
    asOfAvailable: parseInstant(query.pivot.asOfAvailable, 'processing-finding-query-pivot'),
    asOfKnowledge: parseInstant(query.pivot.asOfKnowledge, 'processing-finding-query-pivot'),
    asOfValid: parseInstant(query.pivot.asOfValid, 'processing-finding-query-pivot'),
  };
  const referenceTime = parseInstant(query.pivot.referenceTime, 'processing-finding-query-reference-time');
  invariant(pivots.asOfKnowledge <= referenceTime && pivots.asOfAvailable <= referenceTime,
    'processing-finding-query-future-knowledge');

  return resolveCurrentVersionsAtPivots(
    instance.findings.filter((finding) => finding.eventVersionIri === query.eventVersionIri),
    pivots,
    'processing-finding-query',
  ).map((finding) => {
    const matrix = PROCESSING_FINDING_MATRIX[finding.findingStage][finding.processingFindingKind];
    const subjectField = PROCESSING_FINDING_SUBJECT_FIELD[finding.findingStage];
    const subjectVersionIri = finding[subjectField];
    const roleProjection = {
      findingEvent: {
        logicalIri: finding.eventLogicalIri,
        versionIri: finding.eventVersionIri,
      },
      [subjectField.replace(/VersionIri$/, '')]: subjectVersionIri,
    };
    for (const field of matrix.allowed) {
      if (!hasOwn(finding, field)) continue;
      roleProjection[field.replace(/VersionIris?$/, '')] = Array.isArray(finding[field])
        ? [...finding[field]] : finding[field];
    }
    return {
      availableFrom: finding.availableFrom,
      evidenceSetDigest: finding.evidenceSetDigest,
      findingStage: finding.findingStage,
      generatingContextRef: finding.generatingContextRef,
      knowledgeFrom: finding.knowledgeFrom,
      logicalIri: finding.logicalIri,
      processingFindingKind: finding.processingFindingKind,
      revision: finding.revision,
      validFrom: finding.validFrom,
      versionIri: finding.versionIri,
      ...roleProjection,
    };
  }).sort((left, right) => compareCanonical(
    [
      left.findingStage,
      left.processingFindingKind,
      left.scheduleSubject || left.entitlementSubject || left.dueBillSubject,
      left.versionIri,
    ],
    [
      right.findingStage,
      right.processingFindingKind,
      right.scheduleSubject || right.entitlementSubject || right.dueBillSubject,
      right.versionIri,
    ],
  ));
}

const CUSTOM_CONSTRAINT_DISPATCH = Object.freeze({
  CorporateActionEventContract: ['CorporateActionMatrix', 'validateCorporateActionEventConstraint', ['event-kind-closed']],
  ScheduleEvaluationInputContract: ['DistributionAssessmentIdentity', 'validateScheduleEvaluationInputConstraint', ['assessment-chain-join']],
  DistributionSizeAssessmentContract: ['DistributionAssessmentIdentity', 'validateDistributionSizeAssessmentConstraint', ['assessment-price-kind']],
  ScheduleResolutionContract: ['DueBillEntitlementAndTransferClosure', 'validateScheduleResolutionConstraint', ['due-bill-event-resolution']],
  RecordPositionAbsenceContract: ['DueBillEntitlementAndTransferClosure', 'validateRecordPositionAbsenceConstraint', ['entitlement-proven-zero']],
  CorporateActionEntitlementContract: ['DueBillEntitlementAndTransferClosure', 'validateCorporateActionEntitlementConstraint', ['entitlement-obligation-set']],
  CustodySettlementAccountBridgeContract: ['SettlementAndAllocation', 'validateCustodySettlementAccountBridgeConstraint', ['settlement-bridge-pit']],
  DueBillTradeQualificationContract: ['DueBillEntitlementAndTransferClosure', 'validateDueBillTradeQualificationConstraint', ['due-bill-qualification-event-resolution']],
  DueBillObligationContract: ['DueBillEntitlementAndTransferClosure', 'validateDueBillObligationConstraint', ['obligation-benefit-arithmetic']],
  DueBillTransferContract: ['DueBillEntitlementAndTransferClosure', 'validateDueBillTransferConstraint', ['transfer-amount-positive']],
  DueBillTransferClosureContract: ['DueBillEntitlementAndTransferClosure', 'validateDueBillTransferClosureConstraint', ['transfer-over-fulfillment']],
  ElectionProviderPolicyContract: ['RightsExerciseChain', 'validateElectionProviderPolicyConstraint', ['rights-policy-precedence-cycle']],
  CorporateActionElectionContract: ['RightsExerciseChain', 'validateCorporateActionElectionConstraint', ['rights-candidate-deadline']],
  ElectionResolutionContract: ['RightsExerciseChain', 'validateElectionResolutionConstraint', ['rights-resolution-precedence-proof', 'rights-resolution-conflict']],
  SubscriptionObligationContract: ['RightsExerciseChain', 'validateSubscriptionObligationConstraint', ['rights-obligation-cash-arithmetic']],
  SubscriptionFulfillmentContract: ['RightsExerciseChain', 'validateSubscriptionFulfillmentConstraint', ['rights-fulfillment-amount-positive']],
  SubscriptionFulfillmentClosureContract: ['RightsExerciseChain', 'validateSubscriptionFulfillmentClosureConstraint', ['rights-closure-not-full']],
  CorporateActionProcessingFindingContract: ['CorporateActionProcessingFinding', 'validateCorporateActionProcessingFindingConstraint', [
    'processing-finding-instance', 'processing-finding-reference', 'processing-finding-reference-type',
    'processing-finding-record', 'processing-finding-event', 'processing-finding-logical-identity',
    'processing-finding-version', 'processing-finding-generating-context', 'processing-finding-temporal-valid',
    'processing-finding-temporal-knowledge', 'processing-finding-temporal-availability',
    'processing-finding-version-key', 'processing-finding-supersession', 'processing-finding-stage-kind',
    'processing-finding-stage-xone', 'processing-finding-stage-subject', 'processing-finding-presence-matrix',
    'processing-finding-related-reference', 'processing-finding-evidence-set', 'processing-finding-evidence-digest',
  ]],
  CorporateActionAdjustmentContract: ['RightsExerciseChain', 'validateCorporateActionAdjustmentConstraint', ['rights-adjustment-date']],
  SettlementInstructionContract: ['SettlementAndAllocation', 'validateSettlementInstructionConstraint', ['settlement-fop-leg-matrix']],
  SettlementLegContract: ['SettlementAndAllocation', 'validateSettlementLegConstraint', ['settlement-dvp-cash-reciprocity']],
  TradeSettlementAllocationContract: ['SettlementAndAllocation', 'validateTradeSettlementAllocationConstraint', ['allocation-execution-aggregate']],
  SettlementStatusEventContract: ['SettlementAndAllocation', 'validateSettlementStatusEventConstraint', ['settlement-status-transition']],
  ExternalSettlementStatementContract: ['ReconciliationProjectionAndMatrix', 'validateExternalSettlementStatementConstraint', ['reconciliation-statement-snapshot']],
  ExternalSettlementStatementLineContract: ['ReconciliationProjectionAndMatrix', 'validateExternalSettlementStatementLineConstraint', ['reconciliation-external-source-evidence']],
  SettlementReconciliationComparatorContract: ['ReconciliationProjectionAndMatrix', 'validateSettlementReconciliationComparatorConstraint', ['reconciliation-comparator-contract']],
  ReconciliationCaseContract: ['ReconciliationProjectionAndMatrix', 'validateReconciliationCaseConstraint', ['reconciliation-case-mode-xone']],
  InternalProjectionContract: ['ReconciliationProjectionAndMatrix', 'validateInternalProjectionConstraint', ['reconciliation-internal-value-source']],
  MissingSideAssertionContract: ['ReconciliationProjectionAndMatrix', 'validateMissingSideAssertionConstraint', [
    'reconciliation-missing-absence-probe', 'reconciliation-missing-absence-probe-schema',
    'reconciliation-missing-input-run', 'reconciliation-missing-input-run-binding',
    'reconciliation-missing-input-universe', 'reconciliation-missing-pit-request',
    'reconciliation-missing-pit-request-binding', 'reconciliation-missing-query-contract',
    'reconciliation-missing-query-parameters',
  ]],
  ReconciliationFindingContract: ['ReconciliationProjectionAndMatrix', 'validateReconciliationFindingConstraint', ['reconciliation-finding-kind']],
  ReconciliationStatusEventContract: ['ReconciliationProjectionAndMatrix', 'validateReconciliationStatusEventConstraint', ['reconciliation-status-transition']],
});

// These are deliberately keyed by the dispatched evaluator ID rather than by
// fixture contract.  Several targets need the same joined fixture in order to
// recompute their invariant, but they remain distinct runtime entry points and
// only their owned violation code can be credited to that target.
const CUSTOM_CONSTRAINT_EVALUATOR = Object.freeze({
  validateCorporateActionEventConstraint: (instance) => validateCorporateActionMatrix(instance),
  validateScheduleEvaluationInputConstraint: (instance) => validateDistributionAssessment(instance),
  validateDistributionSizeAssessmentConstraint: (instance) => validateDistributionAssessment(instance),
  validateScheduleResolutionConstraint: (instance) => validateDueBill(instance),
  validateRecordPositionAbsenceConstraint: (instance) => validateDueBill(instance),
  validateCorporateActionEntitlementConstraint: (instance) => validateDueBill(instance),
  validateCustodySettlementAccountBridgeConstraint: (instance) => validateSettlement(instance),
  validateDueBillTradeQualificationConstraint: (instance) => validateDueBill(instance),
  validateDueBillObligationConstraint: (instance) => validateDueBill(instance),
  validateDueBillTransferConstraint: (instance) => validateDueBill(instance),
  validateDueBillTransferClosureConstraint: (instance) => validateDueBill(instance),
  validateElectionProviderPolicyConstraint: (instance) => validateRightsExercise(instance),
  validateCorporateActionElectionConstraint: (instance) => validateRightsExercise(instance),
  validateElectionResolutionConstraint: (instance) => validateRightsExercise(instance),
  validateSubscriptionObligationConstraint: (instance) => validateRightsExercise(instance),
  validateSubscriptionFulfillmentConstraint: (instance) => validateRightsExercise(instance),
  validateSubscriptionFulfillmentClosureConstraint: (instance) => validateRightsExercise(instance),
  validateCorporateActionProcessingFindingConstraint: (instance) => validateProcessingFinding(instance),
  validateCorporateActionAdjustmentConstraint: (instance) => validateRightsExercise(instance),
  validateSettlementInstructionConstraint: (instance) => validateSettlement(instance),
  validateSettlementLegConstraint: (instance) => validateSettlement(instance),
  validateTradeSettlementAllocationConstraint: (instance) => validateSettlement(instance),
  validateSettlementStatusEventConstraint: (instance) => validateSettlement(instance),
  validateExternalSettlementStatementConstraint: (instance) => validateReconciliation(instance),
  validateExternalSettlementStatementLineConstraint: (instance) => validateReconciliation(instance),
  validateSettlementReconciliationComparatorConstraint: (instance) => validateReconciliation(instance),
  validateReconciliationCaseConstraint: (instance) => validateReconciliation(instance),
  validateInternalProjectionConstraint: (instance) => validateReconciliation(instance),
  validateMissingSideAssertionConstraint: (instance) => validateReconciliation(instance),
  validateReconciliationFindingConstraint: (instance) => validateReconciliation(instance),
  validateReconciliationStatusEventConstraint: (instance) => validateReconciliation(instance),
});

const CUSTOM_CONSTRAINT_CODE_OWNER = new Map();
const CUSTOM_CONSTRAINT_EVALUATOR_OWNER = new Map();
for (const [validatorId, [, evaluatorId, ownedViolationCodes]] of Object.entries(CUSTOM_CONSTRAINT_DISPATCH)) {
  invariant(typeof CUSTOM_CONSTRAINT_EVALUATOR[evaluatorId] === 'function',
    'custom-dispatch-evaluator', evaluatorId);
  invariant(!CUSTOM_CONSTRAINT_EVALUATOR_OWNER.has(evaluatorId),
    'custom-dispatch-evaluator-owner', evaluatorId);
  CUSTOM_CONSTRAINT_EVALUATOR_OWNER.set(evaluatorId, validatorId);
  for (const code of ownedViolationCodes) {
    invariant(!CUSTOM_CONSTRAINT_CODE_OWNER.has(code), 'custom-dispatch-code-owner', code);
    CUSTOM_CONSTRAINT_CODE_OWNER.set(code, validatorId);
  }
}

function customConstraintDispatchDescriptor(validatorId) {
  const row = CUSTOM_CONSTRAINT_DISPATCH[validatorId];
  invariant(Boolean(row), 'custom-dispatch-unknown-validator', String(validatorId));
  const [fixtureContract, evaluatorId, ownedViolationCodes] = row;
  const descriptor = {
    evaluatorId,
    fixtureContract,
    ownedViolationCodes: [...ownedViolationCodes].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    validatorId,
  };
  return {
    ...descriptor,
    dispatchDigest: taggedJcsDigest('axiolune-post-trade-custom-dispatch-v1', descriptor),
  };
}

function validateCustomConstraint(validatorId, fixture) {
  const descriptor = customConstraintDispatchDescriptor(validatorId);
  invariant(fixture?.contract === descriptor.fixtureContract, 'custom-dispatch-fixture-contract');
  const evaluator = CUSTOM_CONSTRAINT_EVALUATOR[descriptor.evaluatorId];
  invariant(typeof evaluator === 'function', 'custom-dispatch-evaluator');
  try {
    try {
      validateAuthenticatedSourceArtifacts(fixture.instance);
    } catch (cause) {
      if (validatorId === 'ExternalSettlementStatementLineContract') {
        throw new ContractViolation('reconciliation-external-source-evidence', cause.code || cause.message);
      }
      throw cause;
    }
    evaluator(fixture.instance);
    return { ...descriptor, observedViolation: null, outcome: 'accepted' };
  } catch (cause) {
    if (!(cause instanceof ContractViolation)) throw cause;
    if (descriptor.ownedViolationCodes.includes(cause.code)) throw cause;
    return {
      ...descriptor,
      observedViolation: cause.code,
      observedViolationOwner: CUSTOM_CONSTRAINT_CODE_OWNER.get(cause.code) || null,
      outcome: 'notApplicable',
    };
  }
}

function validateScenario(fixture) {
  invariant(fixture && typeof fixture.contract === 'string', 'fixture-contract');
  if (fixture.contract === 'CorporateActionMatrix') validateCorporateActionMatrix(fixture.instance);
  else if (fixture.contract === 'DistributionAssessmentIdentity') validateDistributionAssessment(fixture.instance);
  else if (fixture.contract === 'DueBillEntitlementAndTransferClosure') validateDueBill(fixture.instance);
  else if (fixture.contract === 'RightsExerciseChain') validateRightsExercise(fixture.instance);
  else if (fixture.contract === 'CorporateActionProcessingFinding') validateProcessingFinding(fixture.instance);
  else if (fixture.contract === 'SettlementAndAllocation') validateSettlement(fixture.instance);
  else if (fixture.contract === 'MissingSideStrictKey') validateMissingSideStrictKey(fixture.instance);
  else if (fixture.contract === 'ReconciliationProjectionAndMatrix') validateReconciliation(fixture.instance);
  else invariant(false, 'unknown-fixture-contract', fixture.contract);
}

const REQUIRED_OBJECTS = ['SettlementReconciliationComparator', 'CorporateActionElectionProviderPolicy', 'ExternalSettlementStatement'];
const REQUIRED_ASSOCIATIONS = [
  'CorporateActionElectionProviderMember', 'CorporateActionElectionProviderNormalization',
  'CorporateActionElectionProviderPrecedenceEdge',
  'CorporateActionEvent', 'CorporateActionScheduleEvaluationInput', 'CorporateActionDistributionSizeAssessment',
  'CorporateActionScheduleResolution', 'RecordPositionAbsenceAssertion', 'CorporateActionEntitlement',
  'CustodySettlementAccountBridge', 'CorporateActionDueBillTradeQualification', 'CorporateActionDueBillObligation',
  'CorporateActionDueBillTransfer', 'CorporateActionDueBillTransferFulfillmentClosure', 'CorporateActionElection',
  'CorporateActionElectionResolution', 'CorporateActionSubscriptionObligation', 'CorporateActionSubscriptionFulfillment',
  'CorporateActionSubscriptionFulfillmentClosure', 'CorporateActionProcessingFinding', 'CorporateActionAdjustment',
  'SettlementInstruction', 'SettlementLeg', 'TradeSettlementAllocation', 'SettlementStatusEvent',
  'ExternalSettlementStatementLine', 'ReconciliationCase', 'SettlementReconciliationInternalProjection',
  'MissingSideAssertion', 'ReconciliationFinding', 'ReconciliationStatusEvent',
];

const REQUIRED_XONES = [
  'CorporateActionConsiderationXone', 'DistributionAssessmentInputXone', 'EntitlementRecordEvidenceXone',
  'DueBillQualificationEvidenceXone', 'DueBillObligationSourceXone', 'DueBillObligationBenefitXone',
  'DueBillTransferAssetXone', 'DueBillClosureAssetXone', 'ElectionAuthorizationXone',
  'ElectionResolutionResultXone', 'SubscriptionFulfillmentAssetXone', 'ProcessingFindingStageXone',
  'SettlementLegAssetXone', 'TradeAllocationFromEndpointXone', 'TradeAllocationToEndpointXone',
  'SettlementStatusSubjectXone', 'StatementLineAssetXone', 'ReconciliationCaseModeXone',
  'ProjectionSourceModeXone', 'ProjectionValueXone', 'ReconciliationFindingVariantXone',
];

const REQUIRED_CUSTOM_CONSTRAINTS = [
  'CorporateActionEventContract', 'ScheduleEvaluationInputContract', 'DistributionSizeAssessmentContract',
  'ScheduleResolutionContract', 'RecordPositionAbsenceContract', 'CorporateActionEntitlementContract',
  'CustodySettlementAccountBridgeContract', 'DueBillTradeQualificationContract', 'DueBillObligationContract',
  'DueBillTransferContract', 'DueBillTransferClosureContract', 'ElectionProviderPolicyContract',
  'CorporateActionElectionContract', 'ElectionResolutionContract', 'SubscriptionObligationContract',
  'SubscriptionFulfillmentContract', 'SubscriptionFulfillmentClosureContract', 'CorporateActionProcessingFindingContract',
  'CorporateActionAdjustmentContract', 'SettlementInstructionContract', 'SettlementLegContract',
  'TradeSettlementAllocationContract', 'SettlementStatusEventContract', 'ExternalSettlementStatementContract',
  'ExternalSettlementStatementLineContract', 'SettlementReconciliationComparatorContract', 'ReconciliationCaseContract',
  'InternalProjectionContract', 'MissingSideAssertionContract', 'ReconciliationFindingContract',
  'ReconciliationStatusEventContract',
];

const REQUIRED_RELATION_STRUCTURE = {
  electionPolicyAuthority: [`${BASE}CorporateActionElectionProviderPolicy`, `${FOUNDATION}Party`, 1, 1, EXACT],
  electionPolicyEventAuthority: [`${BASE}CorporateActionElectionProviderPolicy`, `${FOUNDATION}Party`, 1, 1, LOGICAL],
  electionPolicyProviderMember: [`${BASE}CorporateActionElectionProviderPolicy`, `${BASE}CorporateActionElectionProviderMember`, 1, null, EXACT],
  electionPolicyProviderNormalization: [`${BASE}CorporateActionElectionProviderPolicy`, `${BASE}CorporateActionElectionProviderNormalization`, 1, null, EXACT],
  electionPolicyPrecedenceEdge: [`${BASE}CorporateActionElectionProviderPolicy`, `${BASE}CorporateActionElectionProviderPrecedenceEdge`, 0, null, EXACT],
};

const REQUIRED_TYPE_STRUCTURE = {
  CorporateActionElectionProviderPolicy: {
    attributes: {
      eligibleProviderSetDigest: [1, 1], eligibleProviderCount: [1, 1],
      providerMemberVersionSetDigest: [1, 1],
      providerNormalizationDigest: [1, 1], providerNormalizationCount: [1, 1],
      precedenceGraphDigest: [1, 1], precedenceEdgeCount: [1, 1],
      electionEquivalenceField: [1, null], equivalenceFieldsDigest: [1, 1],
      electionDeadlineCutoff: [1, 1], deadlineInclusive: [1, 1], deadlineCutoffContractDigest: [1, 1],
    },
  },
  CorporateActionElectionProviderMember: {
    roles: {
      memberPolicy: [`${BASE}CorporateActionElectionProviderPolicy`, 1, 1, EXACT],
      eligibleProvider: [`${FOUNDATION}Party`, 1, 1, LOGICAL],
    },
    attributes: { normalizedProviderKey: [1, 1] },
  },
  CorporateActionElectionProviderNormalization: {
    roles: {
      normalizationPolicy: [`${BASE}CorporateActionElectionProviderPolicy`, 1, 1, EXACT],
      normalizedProvider: [`${FOUNDATION}Party`, 1, 1, LOGICAL],
    },
    attributes: { sourceProviderKey: [1, 1], normalizedProviderKey: [1, 1] },
  },
  CorporateActionElectionProviderPrecedenceEdge: {
    roles: {
      precedencePolicy: [`${BASE}CorporateActionElectionProviderPolicy`, 1, 1, EXACT],
      higherPriorityProvider: [`${FOUNDATION}Party`, 1, 1, LOGICAL],
      lowerPriorityProvider: [`${FOUNDATION}Party`, 1, 1, LOGICAL],
    },
  },
  CorporateActionEvent: {
    roles: {
      sourceAuthority: [`${FOUNDATION}Party`, 1, 1, EXACT],
      affectedSecurity: [`${INSTRUMENTS}Security`, 1, 1, LOGICAL],
      affectedListing: [`${INSTRUMENTS}InstrumentListing`, 0, 1, EXACT],
      eventJurisdiction: [`${FOUNDATION}Jurisdiction`, 0, 1, LOGICAL],
      eventFacility: ['https://axiolune.ai/ontology/finance/market-structure/TradingFacility', 0, 1, LOGICAL],
      successorSecurity: [`${INSTRUMENTS}Security`, 0, 1, LOGICAL],
    },
    attributes: { sourceEventId: [1, 1] },
  },
  CorporateActionDistributionSizeAssessment: {
    roles: {
      assessmentEvaluationInput: [`${BASE}CorporateActionScheduleEvaluationInput`, 1, 1, EXACT],
      assessmentEvent: [`${BASE}CorporateActionEvent`, 1, 1, EXACT],
      candidateApplicability: [`${MR}RuleApplicability`, 1, 1, EXACT],
      candidateScheduleRule: [`${MR}CorporateActionScheduleRule`, 1, 1, EXACT],
      assessmentMethod: [`${MR}CorporateActionDistributionAssessmentMethod`, 1, 1, EXACT],
      assessmentPriceObservation: [`${MARKET_DATA}PriceObservation`, 0, 1, EXACT],
      officialPercentageAuthority: [`${FOUNDATION}Party`, 0, 1, EXACT],
    },
    attributes: {
      [`${MARKET_DATA}priceKind`]: [0, 1], assessmentInputVersionRef: [1, null],
      assessmentInputVersionCount: [1, 1], assessmentInputVersionSetDigest: [1, 1],
    },
  },
  CorporateActionDueBillTradeQualification: {
    roles: {
      qualificationEvent: [`${BASE}CorporateActionEvent`, 1, 1, EXACT],
      qualificationScheduleResolution: [`${BASE}CorporateActionScheduleResolution`, 1, 1, EXACT],
      qualificationExecution: [`${ORDERS}Execution`, 1, 1, EXACT],
      qualificationAllocation: [`${BASE}TradeSettlementAllocation`, 1, 1, EXACT],
      qualificationSecurityLeg: [`${BASE}SettlementLeg`, 1, 1, EXACT],
      qualificationLiableParty: [`${FOUNDATION}Party`, 1, 1, LOGICAL],
      qualificationBeneficiaryParty: [`${FOUNDATION}Party`, 1, 1, LOGICAL],
      qualificationLiableAccountPartyRole: [`${FOUNDATION}FinancialAccountPartyRole`, 1, null, EXACT],
      qualificationBeneficiaryAccountPartyRole: [`${FOUNDATION}FinancialAccountPartyRole`, 1, null, EXACT],
      qualificationSettlementStatusEvent: [`${BASE}SettlementStatusEvent`, 0, 1, EXACT],
    },
    attributes: {
      executionOnlyQualification: [0, 1], qualifiedDueBillQuantity: [1, 1],
      qualificationResult: [1, 1],
    },
  },
  CorporateActionDueBillObligation: {
    roles: {
      obligationEvent: [`${BASE}CorporateActionEvent`, 1, 1, EXACT],
      obligationScheduleResolution: [`${BASE}CorporateActionScheduleResolution`, 1, 1, EXACT],
      liableAccount: [`${FOUNDATION}FinancialAccount`, 1, 1, LOGICAL],
      beneficiaryAccount: [`${FOUNDATION}FinancialAccount`, 1, 1, LOGICAL],
      liableParty: [`${FOUNDATION}Party`, 1, 1, LOGICAL],
      beneficiaryParty: [`${FOUNDATION}Party`, 1, 1, LOGICAL],
      liableAccountPartyRole: [`${FOUNDATION}FinancialAccountPartyRole`, 1, null, EXACT],
      beneficiaryAccountPartyRole: [`${FOUNDATION}FinancialAccountPartyRole`, 1, null, EXACT],
      obligationSecurity: [`${INSTRUMENTS}Security`, 1, 1, LOGICAL],
      tradeQualification: [`${BASE}CorporateActionDueBillTradeQualification`, 0, 1, EXACT],
      claimAuthority: [`${FOUNDATION}Party`, 0, 1, EXACT],
    },
    attributes: {
      obligationQuantity: [1, 1], obligationMoney: [0, 1], obligationQuantityBenefit: [0, 1],
      externalClaimId: [0, 1],
    },
  },
  MissingSideAssertion: {
    roles: {
      missingCase: [`${BASE}ReconciliationCase`, 1, 1, EXACT],
      missingComparator: [`${BASE}SettlementReconciliationComparator`, 1, 1, EXACT],
      comparisonInstrument: [`${INSTRUMENTS}FinancialInstrument`, 0, 1, LOGICAL],
    },
    attributes: {
      expectedSide: [1, 1], normalizedSettlementReference: [1, 1], settlementDate: [1, 1],
      settlementSystem: [1, 1], settlementLocation: [1, 1], entryDirection: [1, 1],
      settlementAssetKind: [1, 1], comparisonCurrencyAlphaCode: [0, 1], comparisonCurrencyScale: [0, 1],
      comparisonQuantityUnit: [0, 1], comparisonKeyDigest: [1, 1], reconciliationAsOfValid: [1, 1],
      reconciliationAsOfKnowledge: [1, 1], reconciliationAsOfAvailable: [1, 1], absenceProbeRef: [1, 1],
      absenceProbeDigest: [1, 1],
      'https://axiolune.ai/ontology/meta/data-binding/attributes/pitRequestRef': [1, 1],
      'https://axiolune.ai/ontology/meta/data-binding/attributes/pitRequestRecordDigest': [1, 1],
      'https://axiolune.ai/ontology/meta/data-binding/attributes/inputContextRef': [1, 1],
      'https://axiolune.ai/ontology/meta/data-binding/attributes/inputContextRecordDigest': [1, 1],
    },
  },
  ReconciliationFinding: {
    attributes: {
      internalCount: [1, 1], externalCount: [1, 1], mismatchDimension: [0, null],
      internalMismatchDimension: [0, null], externalMismatchDimension: [0, null],
      crossMismatchDimension: [0, null], comparisonKeyDigest: [1, 1],
      evidenceSetDigest: [1, 1], findingSubjectDigest: [1, 1],
    },
  },
};

function validatePostTradeModule(
  document,
  marketRules,
  referenceLockText = '',
  options = {},
) {
  // Module/authority audits are an authoring gate concern.  Lazy loading keeps
  // the least-privilege runtime's read allowlist closed to validator code.
  const {
    auditPostTradeCustomContracts,
  } = require('./post-trade-custom-contract-audit.cjs');
  const {
    auditPostTradeAuthorityEvidence,
    parseReferenceLockYaml,
  } = require('./post-trade-authority-evidence.cjs');
  const errors = [];
  const pending = [];
  const check = (condition, detail) => { if (!condition) errors.push(detail); };
  const domain = document.domain || {};
  check(document.module?.status === 'draft' && document.module?.governance?.status === 'draft', 'module must remain draft until ADR authorization');
  check(document.module?.version === '0.3.0', 'module version must be 0.3.0');
  const expectedImports = [
    'foundation', 'market-structure', 'instruments', 'market-rules', 'market-data', 'orders-execution', 'portfolio-positions',
  ].map((name) => `https://axiolune.ai/ontology/finance/${name}`);
  check(canonical((document.module?.imports || []).map((item) => item.moduleIri)) === canonical(expectedImports), 'import closure must be the seven RFC dependencies in canonical order');
  check(Object.keys(domain.objectTypes || {}).length === 3, 'object inventory count must be 3');
  check(Object.keys(domain.associationTypes || {}).length === 31, 'association inventory count must be 31');
  for (const name of REQUIRED_OBJECTS) check(Boolean(domain.objectTypes?.[name]), `missing ObjectType ${name}`);
  for (const name of REQUIRED_ASSOCIATIONS) check(Boolean(domain.associationTypes?.[name]), `missing AssociationType ${name}`);

  for (const [typeName, expected] of Object.entries(REQUIRED_TYPE_STRUCTURE)) {
    const type = domain.objectTypes?.[typeName] || domain.associationTypes?.[typeName];
    if (!type) continue;
    for (const [roleId, [range, minCount, maxCount, referenceMode]] of Object.entries(expected.roles || {})) {
      const role = (type.participantRoles || []).find((item) => item.id === roleId);
      check(Boolean(role), `${typeName} missing required role ${roleId}`);
      if (!role) continue;
      check(role.range === range && role.minCount === minCount && role.maxCount === maxCount, `${typeName}.${roleId} range/cardinality drift`);
      const target = `${type.iri}/role/${roleId}`;
      const bindings = (domain.constraintBindings || []).filter((item) => item.targetElement === target && [EXACT, LOGICAL].includes(item.constraintRef));
      check(bindings.length === 1 && bindings[0].constraintRef === referenceMode, `${typeName}.${roleId} reference mode drift`);
    }
    for (const [attributeName, [minCount, maxCount]] of Object.entries(expected.attributes || {})) {
      const attributeIri = attributeName.startsWith('http') ? attributeName : `${BASE}${attributeName}`;
      const use = (type.attributeUses || []).find((item) => item.attribute === attributeIri);
      check(Boolean(use), `${typeName} missing required attribute ${attributeName}`);
      if (use) check(use.minCount === minCount && use.maxCount === maxCount, `${typeName}.${attributeName} cardinality drift`);
    }
  }

  for (const [relationName, [subjectType, objectType, minCount, maxCount, referenceMode]] of Object.entries(REQUIRED_RELATION_STRUCTURE)) {
    const relationIri = `${BASE}${relationName}`;
    const relationType = domain.relationTypes?.[relationName];
    check(Boolean(relationType), `missing required RelationType ${relationName}`);
    if (relationType) check(relationType.domain === subjectType && relationType.range === objectType, `${relationName} domain/range drift`);
    const use = (domain.relationUses || []).find((item) => item.relation === relationIri);
    check(Boolean(use), `missing required RelationUse ${relationName}`);
    if (!use) continue;
    check(use.subjectType === subjectType && use.objectType === objectType
      && use.outboundCardinality?.minCount === minCount && use.outboundCardinality?.maxCount === maxCount, `${relationName} relation-use structure drift`);
    const modes = (use.constraints || []).filter((item) => [EXACT, LOGICAL].includes(item.constraintRef));
    check(modes.length === 1 && modes[0].constraintRef === referenceMode, `${relationName} reference mode drift`);
  }

  const entitlement = domain.associationTypes?.CorporateActionEntitlement;
  for (const name of ['dueBillObligationCount', 'dueBillObligationSetDigest', 'obligationClosureProbeRef', 'obligationClosureProbeDigest']) {
    const use = (entitlement?.attributeUses || []).find((item) => item.attribute === `${BASE}${name}`);
    check(use?.minCount === 0 && use?.maxCount === 1, `CorporateActionEntitlement.${name} must be conditional 0..1 so ordinary mode can forbid it`);
  }
  const adjustment = domain.associationTypes?.CorporateActionAdjustment;
  const adjustmentEvidence = (adjustment?.attributeUses || []).find((item) => item.attribute === `${BASE}adjustmentMovementEvidenceRef`);
  check(adjustmentEvidence?.minCount === 1 && adjustmentEvidence?.maxCount === null, 'CorporateActionAdjustment must carry the non-empty exact movement-evidence member set');
  for (const name of ['movementEvidenceCount', 'movementEvidenceSetDigest']) {
    const use = (adjustment?.attributeUses || []).find((item) => item.attribute === `${BASE}${name}`);
    check(use?.minCount === 1 && use?.maxCount === 1, `CorporateActionAdjustment.${name} must be exactly one`);
  }

  const serialized = canonical(domain);
  for (const forbidden of [
    'https://axiolune.ai/ontology/finance/instruments/Issuer',
    'https://axiolune.ai/ontology/finance/portfolio-positions/Account',
    `${BASE}CorporateActionType`, `${BASE}ReconciliationBreak`, `${BASE}EntitlementMode`, `${BASE}AssessmentInputKind`,
  ]) check(!serialized.includes(forbidden), `forbidden or duplicated symbol ${forbidden}`);

  const materialized = [...Object.values(domain.objectTypes || {}), ...Object.values(domain.associationTypes || {})];
  for (const type of materialized) {
    const patterns = (type.patternBindings || []).map((item) => item.pattern);
    check(patterns.filter((item) => item === TEMPORAL).length === 1 && patterns.filter((item) => item === PROVENANCED).length === 1 && patterns.length === 2, `${type.localName} must bind exactly TemporalFact + ProvenancedFact`);
    for (const role of type.participantRoles || []) {
      check(typeof role.id === 'string' && role.id.length > 0 && typeof role.label === 'string' && role.label.length > 0 && typeof role.definition === 'string' && role.definition.length > 0, `${type.localName} has incomplete ParticipantRole metadata`);
      const target = `${type.iri}/role/${role.id}`;
      const bindings = (domain.constraintBindings || []).filter((item) => item.targetElement === target && [EXACT, LOGICAL].includes(item.constraintRef));
      check(bindings.length === 1, `${type.localName}.${role.id} must have exactly one Logical/Exact reference-mode binding`);
    }
  }
  for (const relationUse of domain.relationUses || []) {
    const modes = (relationUse.constraints || []).filter((item) => [EXACT, LOGICAL].includes(item.constraintRef));
    check(modes.length === 1, `${relationUse.relation} must have exactly one inline Logical/Exact mode`);
  }

  const xoneEntries = Object.entries(domain.constraints || {}).filter(([, constraint]) => constraint.expression?.language === 'SHACL');
  const xones = xoneEntries.map(([, constraint]) => constraint);
  check(xones.length === 21, 'must author exactly 21 executable SHACL xone contracts');
  check(canonical(xoneEntries.map(([name]) => name).sort()) === canonical([...REQUIRED_XONES].sort()), 'SHACL xone contract inventory drift');
  const customNames = Object.entries(domain.constraints || {}).filter(([, constraint]) => constraint.expression?.language === 'Custom').map(([name]) => name).sort();
  check(canonical(customNames) === canonical([...REQUIRED_CUSTOM_CONSTRAINTS].sort()), 'Custom semantic contract inventory drift');
  try {
    auditPostTradeCustomContracts(document);
  } catch (cause) {
    errors.push(
      `Post-trade Custom contract audit failed: ${cause.code || cause.name || 'unknown'}: ${cause.message}`,
    );
  }
  for (const constraint of xones) {
    const match = /^sh:xone\(([A-Za-z][A-Za-z0-9]*(?:,[A-Za-z][A-Za-z0-9]*)+)\)$/u.exec(constraint.expression.expression || '');
    check(Boolean(match), `${constraint.localName} must use pure sh:xone(branch,...) syntax`);
    if (!match) continue;
    const target = materialized.find((item) => item.iri === constraint.targetElement);
    check(Boolean(target), `${constraint.localName} target must be materialized`);
    for (const branch of match[1].split(',')) {
      const use = (target?.attributeUses || []).find((item) => item.attribute === `${BASE}${branch}`);
      const role = (target?.participantRoles || []).find((item) => item.id === branch);
      check(Boolean(use || role), `${constraint.localName} branch ${branch} is not authored on target`);
      check((use || role)?.minCount === 0 && (use || role)?.maxCount === 1, `${constraint.localName}.${branch} must be optional 0..1 before xone`);
    }
    const bindings = (domain.constraintBindings || []).filter((item) => item.constraintRef === constraint.iri && item.targetElement === constraint.targetElement);
    check(bindings.length === 1, `${constraint.localName} must have exactly one target binding`);
  }

  const mrKind = marketRules?.domain?.codeLists?.CorporateActionKind;
  check(canonical((mrKind?.values || []).map((item) => item.notation)) === canonical(['cashDividend', 'stockSplit', 'rightsIssue']), 'Market Rules CorporateActionKind must be the exact frozen three-member list');
  check(Boolean(marketRules?.domain?.objectTypes?.CorporateActionDistributionAssessmentMethod), 'Market Rules assessment method must be a versioned ObjectType');
  for (const importedAttribute of ['distributionAssessmentInputKind', 'corporateActionEntitlementMode', 'dueBillSettlementQualification']) {
    check(serialized.includes(`${MR}${importedAttribute}`), `Post-trade must consume canonical Market Rules attribute ${importedAttribute}`);
  }
  for (const name of ['CorporateActionEntitlementMode', 'CorporateActionEventDateField', 'CorporateActionSettlementQualification']) {
    check(Boolean(marketRules?.domain?.codeLists?.[name]), `Market Rules missing canonical ${name}`);
  }

  let authorityEvidence;
  try {
    const referenceLock = parseReferenceLockYaml(referenceLockText);
    authorityEvidence = auditPostTradeAuthorityEvidence({
      moduleDocument: document,
      referenceLock,
      authorityManifest: options.authorityManifest,
    });
    for (const item of authorityEvidence.errors) {
      errors.push(`${item.code} @ ${item.path}: ${item.message}`);
    }
    for (const item of authorityEvidence.pending) {
      pending.push(`${item.code} @ ${item.path}: ${item.message}`);
    }
  } catch (cause) {
    errors.push(`PTO_AUTHORITY_EVIDENCE_FATAL: ${cause.message}`);
  }
  return { errors, pending, xones, authorityEvidence };
}

function pathTokens(expression) {
  return expression.split('.').map((part) => {
    invariant(/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/u.test(part), 'invalid-mutation-path');
    return /^\d+$/u.test(part) ? Number(part) : part;
  });
}

function mutate(value, mutation) {
  const clone = structuredClone(value);
  const tokens = pathTokens(mutation.path);
  let parent = clone;
  for (const token of tokens.slice(0, -1)) {
    invariant(parent !== null && typeof parent === 'object' && token in parent, 'invalid-mutation-path');
    parent = parent[token];
  }
  const last = tokens.at(-1);
  if (mutation.op === 'delete') {
    invariant(last in parent, 'invalid-mutation-path');
    delete parent[last];
  } else if (mutation.op === 'set') parent[last] = structuredClone(mutation.value);
  else if (mutation.op === 'append') {
    invariant(Array.isArray(parent[last]), 'invalid-mutation-path');
    parent[last].push(structuredClone(mutation.value));
  }
  else invariant(false, 'invalid-mutation-op');
  return clone;
}

module.exports = {
  BASE,
  ContractViolation,
  MISSING_SIDE_QUERY_FUNCTION_BYTES,
  MISSING_SIDE_QUERY_FUNCTION_CONTRACT,
  MISSING_SIDE_QUERY_FUNCTION_DIGEST,
  canonical,
  closureProbeDigest,
  customConstraintDispatchDescriptor,
  findingSubjectDigest,
  iriSetDigest,
  loadYaml,
  missingSideAbsenceProbeDigest,
  missingSideInputUniverse,
  mutate,
  queryProcessingFindings,
  refreshMissingSideRuntimeEvidence,
  settlementComparisonKeyDigest,
  sha256Utf8Bytes,
  taggedJcsDigest,
  validateCustomConstraint,
  validatePostTradeModule,
  validateProcessingFinding,
  validateScenario,
};
