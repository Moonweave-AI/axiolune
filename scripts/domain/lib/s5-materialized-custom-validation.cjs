'use strict';

const crypto = require('node:crypto');
const { Parser } = require('n3');
const {
  constraintInstanceId,
} = require('./m2-constraint-instance-audit.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  PortfolioObservationClosureError,
  verifyPortfolioObservationStreamClosure,
} = require('./portfolio-observation-stream-closure.cjs');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const COMPONENT = 'https://axiolune.ai/conformance/m2/0.3.0/components/CustomConstraintComponent';
const META = 'https://axiolune.ai/ontology/meta/';
const DB = `${META}data-binding/`;
const DBA = `${DB}attributes/`;
const DBP = `${DB}properties/`;
const PA = `${META}patterns/attributes/`;
const COREP = `${META}core/properties/`;
const F = 'https://axiolune.ai/ontology/finance/foundation/';
const I = 'https://axiolune.ai/ontology/finance/instruments/';
const MD = 'https://axiolune.ai/ontology/finance/market-data/';
const OE = 'https://axiolune.ai/ontology/finance/orders-execution/';
const P = 'https://axiolune.ai/ontology/finance/portfolio-positions/';
const EVIDENCE = Object.freeze({
  conversionContext: 'urn:axiolune:evidence:slice-a:conversion-context:v1',
  inputContract: 'urn:axiolune:evidence:slice-a:valuation-input-contract:v1',
  outputContract: 'urn:axiolune:evidence:slice-a:valuation-output-contract:v1',
  priorInputContext: 'urn:axiolune:evidence:slice-a:prior-input-context:v1',
  priorPitRequest: 'urn:axiolune:evidence:slice-a:prior-pit-request:v1',
  precisionPolicy: 'urn:axiolune:evidence:slice-a:valuation-precision-policy:v1',
  portfolioObservationCompleteness:
    'urn:axiolune:evidence:slice-a:portfolio-observation-completeness-contract:v1',
  portfolioObservationPagination:
    'urn:axiolune:evidence:slice-a:portfolio-observation-pagination-contract:v1',
  portfolioObservationSourceContract:
    'urn:axiolune:evidence:slice-a:portfolio-observation-source-contract:v1',
  roundingPolicy: 'urn:axiolune:evidence:slice-a:valuation-rounding-policy:v1',
  runtime: 'urn:axiolune:evidence:slice-a:valuation-runtime:v1',
  toolLock: 'urn:axiolune:evidence:slice-a:valuation-tool-lock:v1',
  valuationFormula: 'urn:axiolune:evidence:slice-a:valuation-formula:v1',
});

class S5MaterializedCustomError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'S5MaterializedCustomError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new S5MaterializedCustomError(code, message);
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function u64be(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function iriSetDigest(values) {
  const sorted = [...new Set(values)].sort(utf8Compare);
  if (sorted.length === 0 || sorted.length !== values.length) {
    fail('S5_CUSTOM_IRI_SET', 'IRI set must be non-empty and duplicate-free');
  }
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

function parseDecimal(value, label) {
  const match = typeof value === 'string'
    ? value.match(/^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/u)
    : null;
  if (!match) fail('S5_CUSTOM_DECIMAL', `${label} is not a canonical decimal`);
  const scale = (match[3] || '').length;
  const coefficient = BigInt(`${match[1]}${match[2]}${match[3] || ''}`);
  return { coefficient, scale };
}

function decimalProduct(left, right) {
  const a = parseDecimal(left, 'multiplicand');
  const b = parseDecimal(right, 'multiplier');
  const coefficient = a.coefficient * b.coefficient;
  const scale = a.scale + b.scale;
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  if (scale === 0) return `${negative ? '-' : ''}${digits}`;
  return `${negative ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function formatScaledDecimal(coefficient, scale) {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const sign = negative && coefficient !== 0n ? '-' : '';
  if (scale === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function roundCoefficient(coefficient, inputScale, outputScale, mode) {
  if (inputScale <= outputScale) {
    return coefficient * (10n ** BigInt(outputScale - inputScale));
  }
  const divisor = 10n ** BigInt(inputScale - outputScale);
  const negative = coefficient < 0n;
  const absolute = negative ? -coefficient : coefficient;
  let quotient = absolute / divisor;
  const remainder = absolute % divisor;
  let increment = false;
  if (remainder !== 0n) {
    if (mode === 'floor') increment = negative;
    else if (mode === 'ceiling') increment = !negative;
    else if (mode === 'half-up') increment = remainder * 2n >= divisor;
    else if (mode === 'half-even') {
      increment = remainder * 2n > divisor
        || (remainder * 2n === divisor && quotient % 2n === 1n);
    }
  }
  if (increment) quotient += 1n;
  return negative ? -quotient : quotient;
}

function policyDecimalProduct(left, right, policy) {
  const a = parseDecimal(left, 'valuation quantity');
  const b = parseDecimal(right, 'valuation price');
  return formatScaledDecimal(
    roundCoefficient(
      a.coefficient * b.coefficient,
      a.scale + b.scale,
      policy.outputScale,
      policy.mode,
    ),
    policy.outputScale,
  );
}

function decimalEqual(left, right) {
  const a = parseDecimal(left, 'left decimal');
  const b = parseDecimal(right, 'right decimal');
  const scale = Math.max(a.scale, b.scale);
  return a.coefficient * (10n ** BigInt(scale - a.scale))
    === b.coefficient * (10n ** BigInt(scale - b.scale));
}

function createIndex(nquads) {
  let quads;
  try {
    quads = new Parser({ format: 'N-Quads' }).parse(nquads);
  } catch (cause) {
    fail('S5_CUSTOM_RDF_PARSE', cause.message);
  }
  if (quads.length === 0) fail('S5_CUSTOM_RDF_EMPTY', 'combined validation scope is empty');
  const bySubject = new Map();
  const byType = new Map();
  for (const statement of quads) {
    if (statement.subject.termType !== 'NamedNode') continue;
    if (!bySubject.has(statement.subject.value)) bySubject.set(statement.subject.value, new Map());
    const predicates = bySubject.get(statement.subject.value);
    if (!predicates.has(statement.predicate.value)) predicates.set(statement.predicate.value, []);
    predicates.get(statement.predicate.value).push(statement.object);
    if (statement.predicate.value === RDF_TYPE && statement.object.termType === 'NamedNode') {
      if (!byType.has(statement.object.value)) byType.set(statement.object.value, new Set());
      byType.get(statement.object.value).add(statement.subject.value);
    }
  }
  return { bySubject, byType, quads };
}

function termKey(term) {
  if (term.termType === 'Literal') {
    return canonicalTermKey(
      term.termType,
      term.value,
      term.language || '',
      term.datatype?.value || '',
    );
  }
  return canonicalTermKey(term.termType, term.value, '', '');
}

function canonicalTermKey(termType, value, language, datatype) {
  return JSON.stringify([termType, value, language, datatype]);
}

function graphIndependentStatementKey(statement) {
  return `${termKey(statement.subject)}\0${termKey(statement.predicate)}\0${termKey(statement.object)}`;
}

function assertNoCrossDatasetSubjectAugmentation(ownerIndex, candidateIndex, labels) {
  const ownerSubjects = new Set(ownerIndex.quads.map((statement) => termKey(statement.subject)));
  const ownerStatements = new Set(ownerIndex.quads.map(graphIndependentStatementKey));
  const augmentations = candidateIndex.quads.filter((statement) => (
    ownerSubjects.has(termKey(statement.subject))
    && !ownerStatements.has(graphIndependentStatementKey(statement))
  ));
  if (augmentations.length > 0) {
    const first = augmentations[0];
    fail(
      'S5_CUSTOM_SUPPORT_AUGMENTATION',
      `${labels.candidate} attempts to add ${first.predicate.value} to ${labels.owner} subject ${first.subject.value}`,
    );
  }
}

function assertValidationDatasetsAreIsolated(dataIndex, supportIndex) {
  assertNoCrossDatasetSubjectAugmentation(dataIndex, supportIndex, {
    candidate: 'support dataset', owner: 'current materialized dataset',
  });
  assertNoCrossDatasetSubjectAugmentation(supportIndex, dataIndex, {
    candidate: 'current materialized dataset', owner: 'prior support dataset',
  });
}

function objects(index, subject, predicate) {
  return index.bySubject.get(subject)?.get(predicate) || [];
}

function one(index, subject, predicate, expectedTermType) {
  const values = objects(index, subject, predicate);
  if (values.length !== 1 || (expectedTermType && values[0].termType !== expectedTermType)) {
    fail(
      'S5_CUSTOM_CARDINALITY',
      `${subject} must have exactly one ${predicate}${expectedTermType ? ` as ${expectedTermType}` : ''}`,
    );
  }
  return values[0].value;
}

function atMostOne(index, subject, predicate) {
  const values = objects(index, subject, predicate);
  if (values.length > 1) fail('S5_CUSTOM_CARDINALITY', `${subject} has multiple ${predicate}`);
  return values[0]?.value;
}

function requireType(index, subject, type) {
  if (!index.byType.get(type)?.has(subject)) {
    fail('S5_CUSTOM_TYPE', `${subject} is not typed ${type}`);
  }
}

function assertLogicalKeyBijection(index, options) {
  const {
    code, keyMatches, keyValues, logicalIri, subject, type,
  } = options;
  const typedSubjects = [...(index.byType.get(type) || [])];
  const sameKey = typedSubjects.filter(keyMatches);
  const keyLogicals = new Set(sameKey.map((candidate) => (
    one(index, candidate, `${DBP}versionOf`, 'NamedNode')
  )));
  if (sameKey.length === 0 || keyLogicals.size !== 1 || !keyLogicals.has(logicalIri)) {
    fail(code, `${subject} logical key does not resolve to exactly one logical identity`);
  }
  const sameLogical = typedSubjects.filter((candidate) => (
    objects(index, candidate, `${DBP}versionOf`)
      .some((term) => term.termType === 'NamedNode' && term.value === logicalIri)
  ));
  if (sameLogical.length === 0 || sameLogical.some((candidate) => (
    canonicalJcs(keyValues(candidate)) !== canonicalJcs(keyValues(subject))
  ))) {
    fail(code, `${subject} logical identity is shared by different logical keys`);
  }
}

function assertNoOutgoingObjectType(index, subject, forbiddenTypes, code, label) {
  const predicates = index.bySubject.get(subject) || new Map();
  for (const terms of predicates.values()) {
    for (const term of terms) {
      if (term.termType !== 'NamedNode') continue;
      if (forbiddenTypes.some((type) => index.byType.get(type)?.has(term.value))) {
        fail(code, `${subject} has forbidden ${label} edge to ${term.value}`);
      }
    }
  }
}

function requireDigest(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) fail('S5_CUSTOM_DIGEST', `${label} is not sha256`);
}

function lockedEvidence(context, evidenceIri, evidenceKind, expectedDigest) {
  const artifact = context.lockedEvidence?.get(evidenceIri);
  if (!artifact || artifact.evidenceKind !== evidenceKind) {
    fail('S5_CUSTOM_EVIDENCE', `${evidenceIri} is absent or has the wrong evidence kind`);
  }
  if (expectedDigest !== undefined && artifact.artifactDigest !== expectedDigest) {
    fail('S5_CUSTOM_EVIDENCE', `${evidenceIri} digest differs from the materialized fact`);
  }
  return artifact;
}

function lockedRefDigest(
  index,
  subject,
  refPredicate,
  digestPredicate,
  context,
  evidenceKind,
) {
  const evidenceIri = one(index, subject, refPredicate, 'Literal');
  const digest = one(index, subject, digestPredicate, 'Literal');
  requireDigest(digest, digestPredicate);
  return lockedEvidence(context, evidenceIri, evidenceKind, digest);
}

function replayPortfolioObservationClosure(artifact, context) {
  if (typeof context.readLockedArtifact !== 'function') {
    fail(
      'S5_CUSTOM_PORTFOLIO_OBSERVATION_CLOSURE',
      'locked artifact reader is unavailable for portfolio observation replay',
    );
  }
  if (!(context.portfolioObservationClosureCache instanceof Map)) {
    context.portfolioObservationClosureCache = new Map();
  }
  if (context.portfolioObservationClosureCache.has(artifact.artifactDigest)) {
    return context.portfolioObservationClosureCache.get(artifact.artifactDigest);
  }
  let result;
  try {
    result = verifyPortfolioObservationStreamClosure(artifact.value, {
      readArtifact: context.readLockedArtifact,
    });
  } catch (error) {
    const detail = error instanceof PortfolioObservationClosureError
      ? `${error.code}: ${error.message}`
      : error.message;
    fail(
      'S5_CUSTOM_PORTFOLIO_OBSERVATION_CLOSURE',
      `portfolio observation closure replay failed: ${detail}`,
    );
  }
  context.portfolioObservationClosureCache.set(artifact.artifactDigest, result);
  return result;
}

function validateMaterializerCapabilityEvidence(formula, output, runtime, toolLock) {
  const expectedImplementationRef = {
    kind: 'path',
    path: 'scripts/domain/lib/s5-canonical-materialization.cjs',
    root: 'sourceTree',
  };
  const expectedOutputRef = {
    kind: 'path',
    path: 'scripts/domain/control-record-profile/s5-v1/materialization-capability-output-contract.json',
    root: 'sourceTree',
  };
  const expectedRuntimeRef = {
    kind: 'path',
    path: 'scripts/domain/control-record-profile/s5-v1/materialization-runtime-closure.json',
    root: 'sourceTree',
  };
  const value = toolLock.value;
  const materializers = Array.isArray(value?.tools)
    ? value.tools.filter((entry) => entry?.toolId === 's5-canonical-materializer')
    : [];
  if (value?.schemaVersion !== '1.0' || materializers.length !== 1) {
    fail('S5_CUSTOM_PRODUCER_CAPABILITY', 'tool lock has no unique canonical materializer');
  }
  const tool = materializers[0];
  const capabilities = Array.isArray(tool.capabilities)
    ? tool.capabilities.filter((entry) => (
      entry?.capabilityId === 's5-canonical-materialization'
    ))
    : [];
  if (capabilities.length !== 1) {
    fail('S5_CUSTOM_PRODUCER_CAPABILITY', 'canonical materializer capability is absent or ambiguous');
  }
  const capability = capabilities[0];
  if (canonicalJcs(tool.artifactRef) !== canonicalJcs(expectedImplementationRef)
      || tool.artifactDigest !== formula.artifactDigest
      || canonicalJcs(capability.capabilityRef) !== canonicalJcs(expectedImplementationRef)
      || capability.capabilityDigest !== formula.artifactDigest
      || canonicalJcs(capability.entrypointRef) !== canonicalJcs(expectedImplementationRef)
      || capability.entrypointDigest !== formula.artifactDigest
      || canonicalJcs(capability.outputContractRef) !== canonicalJcs(expectedOutputRef)
      || capability.outputContractDigest !== output.artifactDigest
      || canonicalJcs(tool.runtimeRef) !== canonicalJcs(expectedRuntimeRef)
      || tool.runtimeDigest !== runtime.artifactDigest) {
    fail(
      'S5_CUSTOM_PRODUCER_CAPABILITY',
      'definition evidence does not join one exact canonical-materialization capability tuple',
    );
  }
  const outputValue = output.value;
  if (outputValue?.schemaVersion !== '1.0'
      || outputValue.entrypoint !== 'materializeHistoricalDataset'
      || outputValue.canonicalRdfMediaType !== 'application/n-quads'
      || outputValue.priorSupportOutputProhibited !== true
      || outputValue.targetDataset !== 'urn:axiolune:dataset:slice-a:control-chain:v1'
      || canonicalJcs(outputValue.required) !== canonicalJcs([
        'graphIris', 'identities', 'memberGraphIris', 'nquads', 'targetDataset',
      ])
      || canonicalJcs(outputValue.valueObjectRequirements) !== canonicalJcs({
        Money: ['hasAmount', 'hasCurrency', 'hasScale'],
        Quantity: ['hasNumericValue', 'hasPrecision', 'hasRounding', 'hasUnit'],
      })) {
    fail(
      'S5_CUSTOM_PRODUCER_CAPABILITY',
      'locked producer output contract does not describe the actual RDF/value-object output',
    );
  }
  const runtimeValue = runtime.value;
  const runtimePaths = Array.isArray(runtimeValue?.entries)
    ? runtimeValue.entries.map((entry) => entry?.artifactRef?.path)
    : [];
  if (runtimeValue?.runtimeId !== 's5-canonical-materialization-runtime-v1'
      || !runtimePaths.includes(expectedImplementationRef.path)
      || !runtimePaths.includes('scripts/domain/lib/identity-contract-compiler.cjs')
      || !runtimePaths.includes('scripts/domain/lib/strict-source-locator.cjs')) {
    fail('S5_CUSTOM_PRODUCER_CAPABILITY', 'canonical materializer runtime closure is incomplete');
  }
}

function validatePriorCompletedContext(contextArtifact, subjectKnowledgeFrom, context) {
  const value = contextArtifact.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== '1.0' || value.outcome !== 'completed'
      || typeof value.completedAt !== 'string'
      || !Number.isFinite(Date.parse(value.completedAt))
      || Date.parse(value.completedAt) >= Date.parse(subjectKnowledgeFrom)
      || Date.parse(value.completedAt) > Date.parse(context.referenceTime)) {
    fail('S5_CUSTOM_INPUT_CONTEXT', 'input context is not completed strictly before the subject knowledge start');
  }
  const inputSet = lockedEvidence(
    context,
    value.inputSetRef,
    'valuationInputSet',
    value.inputSetDigest,
  );
  if (inputSet.value?.selectionComplete !== true) {
    fail('S5_CUSTOM_INPUT_CONTEXT', 'input context does not bind a completed valuation input set');
  }
  return inputSet;
}

function validatePitEvidence(pitArtifact, contextArtifact, context) {
  const value = pitArtifact.value;
  if (!value || value.schemaVersion !== '1.0'
      || value.inputContextRef !== contextArtifact.evidenceIri
      || value.inputContextDigest !== contextArtifact.artifactDigest
      || value.asOfAvailable !== context.asOfAvailable
      || value.asOfKnowledge !== context.asOfKnowledge
      || value.asOfValid !== context.asOfValid) {
    fail('S5_CUSTOM_PIT_EVIDENCE', 'PIT request does not bind the exact pivots and input context');
  }
}

function money(index, subject, label) {
  requireType(index, subject, `${META}core/values/MonetaryAmount`);
  const amount = one(index, subject, `${COREP}hasAmount`, 'Literal');
  const currency = one(index, subject, `${COREP}hasCurrency`, 'Literal');
  const scaleLexical = one(index, subject, `${COREP}hasScale`, 'Literal');
  if (!/^(?:0|[1-9]\d*)$/u.test(scaleLexical)) {
    fail('S5_CUSTOM_MONEY_SCALE', `${label} scale is not a non-negative integer`);
  }
  const scale = Number(scaleLexical);
  const parsed = parseDecimal(amount, `${label} amount`);
  if (parsed.scale !== scale) {
    fail('S5_CUSTOM_MONEY_SCALE', `${label} amount lexical scale differs from explicit hasScale`);
  }
  if (!/^[A-Z]{3}$/u.test(currency)) {
    fail('S5_CUSTOM_MONEY_CURRENCY', `${label} currency is not an ISO 4217 code`);
  }
  return { amount, currency, scale };
}

function quantity(index, subject, label) {
  requireType(index, subject, `${META}core/values/QuantityValue`);
  const value = one(index, subject, `${COREP}hasNumericValue`, 'Literal');
  const unit = one(index, subject, `${COREP}hasUnit`, 'Literal');
  const precision = one(index, subject, `${COREP}hasPrecision`, 'Literal');
  const rounding = one(index, subject, `${COREP}hasRounding`, 'Literal');
  const parsed = parseDecimal(value, `${label} value`);
  if (!/^(?:0|[1-9]\d*)$/u.test(precision)
      || Number(precision) !== parsed.scale
      || !['floor', 'ceiling', 'half-up', 'half-even'].includes(rounding)) {
    fail('S5_CUSTOM_QUANTITY_POLICY', `${label} precision/rounding is incomplete or inconsistent`);
  }
  return { precision: Number(precision), rounding, unit, value };
}

function valuationPolicies(index, definition, context) {
  const precision = lockedRefDigest(
    index,
    definition,
    `${P}precisionPolicyRef`,
    `${P}precisionPolicyDigest`,
    context,
    'precisionPolicy',
  ).value;
  const rounding = lockedRefDigest(
    index,
    definition,
    `${P}roundingPolicyRef`,
    `${P}roundingPolicyDigest`,
    context,
    'roundingPolicy',
  ).value;
  if (!precision || precision.schemaVersion !== '1.0'
      || precision.decimalArithmetic !== 'exact'
      || precision.intermediateScale !== 'unbounded') {
    fail('S5_CUSTOM_VALUATION_POLICY', 'valuation precision policy is not exact/unbounded');
  }
  if (!rounding || rounding.schemaVersion !== '1.0'
      || !['floor', 'ceiling', 'half-up', 'half-even'].includes(rounding.mode)
      || !Number.isSafeInteger(rounding.outputScale)
      || rounding.outputScale < 0 || rounding.outputScale > 18
      || rounding.stage !== 'finalMonetaryAmount') {
    fail('S5_CUSTOM_VALUATION_POLICY', 'valuation rounding policy mode/scale/stage is invalid');
  }
  return { precision, rounding };
}

function commonFactVersion(index, subject, context) {
  requireType(index, subject, `${DB}FactVersion`);
  one(index, subject, `${DBP}versionOf`, 'NamedNode');
  const validFrom = one(index, subject, `${PA}validFrom`, 'Literal');
  const knowledgeFrom = one(index, subject, `${PA}knowledgeFrom`, 'Literal');
  const availableFrom = one(index, subject, `${PA}availableFrom`, 'Literal');
  const revision = one(index, subject, `${PA}revision`, 'Literal');
  one(index, subject, `${PA}source`, 'Literal');
  const generatingContext = one(index, subject, `${DBA}generatingContextRef`, 'Literal');
  if (!/^\d+$/u.test(revision)) fail('S5_CUSTOM_REVISION', `${subject} revision is invalid`);
  for (const [name, value, pivot] of [
    ['validFrom', validFrom, context.asOfValid],
    ['knowledgeFrom', knowledgeFrom, context.asOfKnowledge],
    ['availableFrom', availableFrom, context.asOfAvailable],
  ]) {
    const instant = Date.parse(value);
    if (!Number.isFinite(instant) || instant > Date.parse(pivot)) {
      fail('S5_CUSTOM_PIT', `${subject} ${name} is not eligible at ${pivot}`);
    }
  }
  if (Date.parse(knowledgeFrom) > Date.parse(context.referenceTime)) {
    fail('S5_CUSTOM_FUTURE_KNOWLEDGE', `${subject} knowledgeFrom exceeds referenceTime`);
  }
  if (!context.allowedGeneratingContextIris.includes(generatingContext)) {
    fail('S5_CUSTOM_GENERATING_CONTEXT', `${subject} cites unbound run ${generatingContext}`);
  }
  if (objects(index, subject, `${PA}knowledgeTo`).length
      || objects(index, subject, `${PA}availableTo`).length) {
    fail('S5_CUSTOM_MUTABLE_CLOSURE', `${subject} mutates a closure onto FactVersion`);
  }
}

function listingIdentity(index, subject) {
  one(index, subject, `${I}listingFacility`, 'NamedNode');
  one(index, subject, `${I}listingIdentifierScheme`, 'NamedNode');
  one(index, subject, `${I}listingIdentifierValue`, 'NamedNode');
  one(index, subject, `${I}listedInstrument`, 'NamedNode');
  one(index, subject, `${I}listingQuoteCurrency`, 'NamedNode');
}

function listingOffering(index, subject) {
  atMostOne(index, subject, `${I}originatingOffering`);
}

function listingInterval(index, subject) {
  const from = one(index, subject, `${I}listingBusinessFrom`, 'Literal');
  const to = atMostOne(index, subject, `${I}listingBusinessTo`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(from) || (to && !(from < to))) {
    fail('S5_CUSTOM_LISTING_INTERVAL', `${subject} listing interval is invalid`);
  }
}

function directQuotation(index, subject) {
  const kind = one(index, subject, `${I}quotationKind`, 'NamedNode');
  const multiplier = one(index, subject, `${I}contractMultiplier`, 'Literal');
  const listed = atMostOne(index, subject, `${I}quotationListingContext`);
  const otc = atMostOne(index, subject, `${I}quotationOTCContext`);
  if (kind !== `${I}QuotationKind/value/directUnitPrice`
      || !decimalEqual(multiplier, '1')
      || Boolean(listed) === Boolean(otc)) {
    fail('S5_CUSTOM_QUOTATION', `${subject} is not a direct-unit xone quotation`);
  }
  one(index, subject, `${I}quotationInstrument`, 'NamedNode');
  one(index, subject, `${I}quotationQuoteCurrency`, 'NamedNode');
  one(index, subject, `${I}quotationDenominatorUnit`, 'Literal');
  requireDigest(one(index, subject, `${I}normalizationContractDigest`, 'Literal'), 'normalization digest');
}

function streamIdentity(index, subject) {
  for (const predicate of [
    `${MD}providerStreamId`, `${MD}sourceContractRef`, `${MD}sourceContractDigest`,
    `${MD}sourceApiIdentifier`, `${MD}sourceSchemaIdentifier`, `${MD}sourceSchemaVersion`,
    `${MD}orderingTransformRef`, `${MD}orderingTransformDigest`,
  ]) one(index, subject, predicate, 'Literal');
  one(index, subject, `${MD}observationIdFieldLocator`, 'NamedNode');
  one(index, subject, `${MD}streamProvider`, 'NamedNode');
  one(index, subject, `${MD}streamPurpose`, 'NamedNode');
  one(index, subject, `${MD}sourceRecordRevisionMode`, 'NamedNode');
}

function observationIdentity(index, subject) {
  one(index, subject, `${MD}PriceObservation/role/observationStream`, 'NamedNode');
  one(index, subject, `${MD}providerObservationId`, 'Literal');
  const order = one(index, subject, `${MD}sourceOrderKey`, 'Literal');
  if (!/^\d+$/u.test(order)) fail('S5_CUSTOM_OBSERVATION_ORDER', `${subject} source order is invalid`);
}

function observationContext(index, subject) {
  const instrument = one(index, subject, `${MD}PriceObservation/role/observedInstrument`, 'NamedNode');
  const listing = atMostOne(index, subject, `${MD}PriceObservation/role/observedListing`);
  const otc = atMostOne(index, subject, `${MD}PriceObservation/role/observedOtcContext`);
  const quotation = one(index, subject, `${MD}PriceObservation/role/quotationContract`, 'NamedNode');
  if (Boolean(listing) === Boolean(otc)) {
    fail('S5_CUSTOM_OBSERVATION_CONTEXT', `${subject} must select exactly one market context`);
  }
  if (listing) {
    const listedInstrument = one(index, listing, `${I}listedInstrument`, 'NamedNode');
    if (listedInstrument !== instrument) {
      fail('S5_CUSTOM_OBSERVATION_CONTEXT', `${subject} instrument differs from listing`);
    }
    const quotationListing = one(index, quotation, `${I}quotationListingContext`, 'NamedNode');
    if (quotationListing !== listing) {
      fail('S5_CUSTOM_OBSERVATION_CONTEXT', `${subject} quotation differs from listing context`);
    }
  }
  const instrumentLogical = one(index, instrument, `${DBP}versionOf`, 'NamedNode');
  if (one(index, quotation, `${I}quotationInstrument`, 'NamedNode') !== instrumentLogical) {
    fail('S5_CUSTOM_OBSERVATION_CONTEXT', `${subject} quotation instrument differs`);
  }
}

function priceKind(index, subject) {
  const kind = one(index, subject, `${MD}priceKind`, 'NamedNode');
  const price = one(index, subject, `${MD}priceValue`, 'NamedNode');
  if (kind !== `${MD}PriceKind/value/tick/last`) {
    fail('S5_CUSTOM_PRICE_KIND', `${subject} uses an unsupported price kind in Slice A`);
  }
  one(index, price, `${COREP}hasAmount`, 'Literal');
  one(index, price, `${COREP}hasCurrency`, 'Literal');
}

function membership(index, subject) {
  for (const predicate of [
    `${P}PortfolioAccountMembership/role/membershipPortfolio`,
    `${P}PortfolioAccountMembership/role/memberAccount`,
    `${P}PortfolioAccountMembership/role/membershipAuthority`,
  ]) one(index, subject, predicate, 'NamedNode');
  for (const predicate of [`${P}membershipId`, `${P}authorityScope`, `${P}approvalRef`]) {
    one(index, subject, predicate, 'Literal');
  }
  requireDigest(one(index, subject, `${P}approvalDigest`, 'Literal'), 'membership approval digest');
}

function membershipClosure(index, subject) {
  one(index, subject, `${P}PortfolioAccountMembershipClosure/role/closurePortfolio`, 'NamedNode');
  const members = objects(index, subject, `${P}PortfolioAccountMembershipClosure/role/closedMembership`)
    .map((term) => term.value);
  const count = one(index, subject, `${P}membershipCount`, 'Literal');
  const digest = one(index, subject, `${P}membershipVersionSetDigest`, 'Literal');
  if (!/^\d+$/u.test(count) || Number(count) !== members.length
      || digest !== iriSetDigest(members)) {
    fail('S5_CUSTOM_MEMBERSHIP_CLOSURE', `${subject} closed set/count/digest differs`);
  }
  for (const predicate of [
    `${P}membershipClosureProbeRef`, `${DBA}pitRequestRef`, `${DBA}inputContextRef`,
  ]) one(index, subject, predicate, 'Literal');
  for (const predicate of [
    `${P}membershipClosureProbeDigest`, `${DBA}pitRequestRecordDigest`,
    `${DBA}inputContextRecordDigest`,
  ]) requireDigest(one(index, subject, predicate, 'Literal'), predicate);
}

function portfolioObservationStream(index, subject, context) {
  const logical = one(index, subject, `${DBP}versionOf`, 'NamedNode');
  requireType(index, logical, `${P}PortfolioObservationStream/LogicalIdentity`);
  requireType(index, logical, `${DB}FactIdentity`);
  const versionMarker = subject.indexOf('/version/');
  if (versionMarker <= 0 || subject.slice(0, versionMarker) !== logical) {
    fail(
      'S5_CUSTOM_PORTFOLIO_OBSERVATION_STREAM',
      `${subject} is not an exact version of its declared stable logical IRI`,
    );
  }
  const provider = one(
    index,
    subject,
    `${P}portfolioObservationStreamProvider`,
    'NamedNode',
  );
  requireType(index, provider, `${F}Party/LogicalIdentity`);
  const streamId = one(index, subject, `${P}portfolioObservationStreamId`, 'Literal');
  if (streamId.length === 0 || streamId !== streamId.normalize('NFC')) {
    fail(
      'S5_CUSTOM_PORTFOLIO_OBSERVATION_STREAM',
      `${subject} has an invalid provider-scoped stream identifier`,
    );
  }
  const sourceContract = lockedRefDigest(
    index,
    subject,
    `${P}portfolioObservationSourceContractRef`,
    `${P}portfolioObservationSourceContractDigest`,
    context,
    'portfolioObservationSourceContract',
  );
  const completeness = lockedRefDigest(
    index,
    subject,
    `${P}portfolioObservationCompletenessContractRef`,
    `${P}portfolioObservationCompletenessContractDigest`,
    context,
    'completenessContract',
  );
  const pagination = lockedRefDigest(
    index,
    subject,
    `${P}portfolioObservationPaginationContractRef`,
    `${P}portfolioObservationPaginationContractDigest`,
    context,
    'paginationContract',
  );
  const sourceArtifact = lockedRefDigest(
    index,
    subject,
    `${DBA}sourceArtifactRef`,
    `${DBA}sourceArtifactDigest`,
    context,
    'portfolioObservationClosure',
  );
  if (one(index, subject, `${PA}source`, 'Literal') !== sourceArtifact.evidenceIri) {
    fail(
      'S5_CUSTOM_PORTFOLIO_OBSERVATION_STREAM',
      `${subject} provenance source differs from its byte-locked source artifact`,
    );
  }
  const sourceLocator = one(index, subject, `${DBA}sourceLocator`, 'NamedNode');
  requireType(index, sourceLocator, `${DB}structures/SourceLocator`);
  if (sourceContract.evidenceIri !== EVIDENCE.portfolioObservationSourceContract
      || sourceContract.value?.schemaVersion !== '1.0'
      || sourceContract.value?.kind !== 'PortfolioObservationSourceContract') {
    fail(
      'S5_CUSTOM_PORTFOLIO_OBSERVATION_STREAM',
      `${subject} source contract does not close the observation-stream identity input`,
    );
  }
  if (completeness.evidenceIri !== EVIDENCE.portfolioObservationCompleteness
      || canonicalJcs(completeness.value) !== canonicalJcs({
        contractId: 'slice-a-portfolio-observation-completeness-v1',
        duplicatePolicy: 'reject',
        failurePolicy: 'reject-degraded-partial-or-error',
        omissionSemantics: 'completeSnapshot',
        recordScope: 'all-provider-visible-holdings-for-account',
        schemaVersion: '1.0',
      })) {
    fail(
      'S5_CUSTOM_PORTFOLIO_OBSERVATION_STREAM',
      `${subject} completeness contract semantics drift`,
    );
  }
  if (pagination.evidenceIri !== EVIDENCE.portfolioObservationPagination
      || canonicalJcs(pagination.value) !== canonicalJcs({
        contractId: 'slice-a-portfolio-observation-pagination-v1',
        cursorMode: 'opaqueImmutable',
        ordering: ['account_logical_iri', 'instrument_logical_iri', 'holding_snapshot_id'],
        replayTermination: 'empty-next-cursor',
        schemaVersion: '1.0',
        snapshotConsistency: 'immutable-provider-snapshot-token',
      })) {
    fail(
      'S5_CUSTOM_PORTFOLIO_OBSERVATION_STREAM',
      `${subject} pagination contract semantics drift`,
    );
  }
  const closure = replayPortfolioObservationClosure(sourceArtifact, context);
  if (closure.providerIri !== provider
      || closure.streamLogicalIri !== logical
      || closure.streamVersionIri !== subject
      || closure.asOf !== context.asOfAvailable
      || closure.sourceContractDigest !== sourceContract.artifactDigest
      || canonicalJcs(closure.sourceContractRef) !== canonicalJcs(sourceContract.artifactRef)) {
    fail(
      'S5_CUSTOM_PORTFOLIO_OBSERVATION_CLOSURE',
      `${subject} does not equal the replayed provider/stream/as-of/source-contract closure`,
    );
  }
  const keyValues = (candidate) => ({
    provider: one(
      index,
      candidate,
      `${P}portfolioObservationStreamProvider`,
      'NamedNode',
    ),
    sourceContractRef: one(
      index,
      candidate,
      `${P}portfolioObservationSourceContractRef`,
      'Literal',
    ),
    streamId: one(index, candidate, `${P}portfolioObservationStreamId`, 'Literal'),
  });
  assertLogicalKeyBijection(index, {
    code: 'S5_CUSTOM_PORTFOLIO_OBSERVATION_STREAM',
    keyMatches: (candidate) => canonicalJcs(keyValues(candidate)) === canonicalJcs({
      provider,
      sourceContractRef: sourceContract.evidenceIri,
      streamId,
    }),
    keyValues,
    logicalIri: logical,
    subject,
    type: `${P}PortfolioObservationStream`,
  });
  return closure;
}

function holding(index, subject, context) {
  const logical = one(index, subject, `${DBP}versionOf`, 'NamedNode');
  requireType(index, logical, `${P}HoldingSnapshot/LogicalIdentity`);
  const observationStream = one(
    index,
    subject,
    `${P}HoldingSnapshot/role/holdingObservationStream`,
    'NamedNode',
  );
  requireType(index, observationStream, `${P}PortfolioObservationStream`);
  const observationStreamLogical = one(
    index,
    observationStream,
    `${DBP}versionOf`,
    'NamedNode',
  );
  requireType(index, observationStreamLogical, `${P}PortfolioObservationStream/LogicalIdentity`);
  const observationClosure = portfolioObservationStream(index, observationStream, context);
  const account = one(
    index,
    subject,
    `${P}HoldingSnapshot/role/holdingAccount`,
    'NamedNode',
  );
  requireType(index, account, `${F}FinancialAccount/LogicalIdentity`);
  const instrument = one(
    index,
    subject,
    `${P}HoldingSnapshot/role/holdingInstrument`,
    'NamedNode',
  );
  requireType(index, instrument, `${I}FinancialInstrument/LogicalIdentity`);
  const listingTerms = objects(index, subject, `${P}HoldingSnapshot/role/holdingListing`);
  if (listingTerms.length > 1
      || (listingTerms.length === 1 && listingTerms[0].termType !== 'NamedNode')) {
    fail('S5_CUSTOM_HOLDING', `${subject} has an invalid optional holding listing`);
  }
  const listing = listingTerms[0]?.value;
  if (listing) {
    requireType(index, listing, `${I}InstrumentListing`);
    const listedInstrument = one(index, listing, `${I}listedInstrument`, 'NamedNode');
    const listedInstrumentLogical = objects(index, listedInstrument, `${DBP}versionOf`)
      .filter((term) => term.termType === 'NamedNode')
      .map((term) => term.value);
    if (listedInstrument !== instrument
        && (listedInstrumentLogical.length !== 1
          || listedInstrumentLogical[0] !== instrument)) {
      fail('S5_CUSTOM_HOLDING', `${subject} listing does not list its holding instrument`);
    }
  }
  const quantityNode = one(index, subject, `${P}holdingQuantity`, 'NamedNode');
  const quantityValue = quantity(index, quantityNode, 'holding quantity');
  const numeric = quantityValue.value;
  if (parseDecimal(numeric, 'holding quantity').coefficient < 0n) {
    fail('S5_CUSTOM_HOLDING', `${subject} has a negative holding quantity`);
  }
  const snapshotId = one(index, subject, `${P}snapshotId`, 'Literal');
  const sourceKind = one(index, subject, `${P}positionSourceKind`, 'NamedNode');
  requireType(index, sourceKind, `${P}PositionSourceKind`);
  const sourceArtifact = lockedRefDigest(
    index,
    subject,
    `${DBA}sourceArtifactRef`,
    `${DBA}sourceArtifactDigest`,
    context,
    'portfolioObservationPageResponse',
  );
  if (one(index, subject, `${PA}source`, 'Literal') !== sourceArtifact.evidenceIri) {
    fail('S5_CUSTOM_HOLDING', `${subject} does not bind the byte-locked holding source record`);
  }
  const sourceLocator = one(index, subject, `${DBA}sourceLocator`, 'NamedNode');
  requireType(index, sourceLocator, `${DB}structures/SourceLocator`);
  const sourceMatches = observationClosure.records.filter((entry) => (
    entry.recordKey.accountLogicalIri === account
      && entry.recordKey.instrumentLogicalIri === instrument
      && entry.recordKey.snapshotId === snapshotId
  ));
  if (sourceMatches.length !== 1
      || canonicalJcs(sourceMatches[0].responseRef) !== canonicalJcs(sourceArtifact.artifactRef)
      || sourceMatches[0].responseDigest !== sourceArtifact.artifactDigest
      || sourceMatches[0].locatorIri !== sourceLocator) {
    fail(
      'S5_CUSTOM_HOLDING_SOURCE_CLOSURE',
      `${subject} is not the unique byte-selected row in its exact observation-stream FactVersion closure`,
    );
  }
  const selectedPayload = sourceMatches[0].payload;
  const selectedKey = sourceMatches[0].recordKey;
  const factPayload = {
    availableFrom: one(index, subject, `${PA}availableFrom`, 'Literal'),
    holdingQuantity: quantityValue.value,
    holdingQuantityPrecision: quantityValue.precision,
    holdingQuantityRounding: quantityValue.rounding,
    holdingQuantityUnit: quantityValue.unit,
    knowledgeFrom: one(index, subject, `${PA}knowledgeFrom`, 'Literal'),
    positionSourceKindIri: sourceKind,
    revision: Number(one(index, subject, `${PA}revision`, 'Literal')),
    validFrom: one(index, subject, `${PA}validFrom`, 'Literal'),
  };
  if (selectedKey.accountLogicalIri !== account
      || selectedKey.instrumentLogicalIri !== instrument
      || selectedKey.snapshotId !== snapshotId
      || !decimalEqual(selectedPayload.holdingQuantity, factPayload.holdingQuantity)
      || selectedPayload.holdingQuantityPrecision !== factPayload.holdingQuantityPrecision
      || selectedPayload.holdingQuantityRounding !== factPayload.holdingQuantityRounding
      || selectedPayload.holdingQuantityUnit !== factPayload.holdingQuantityUnit
      || selectedPayload.availableFrom !== factPayload.availableFrom
      || selectedPayload.knowledgeFrom !== factPayload.knowledgeFrom
      || selectedPayload.positionSourceKindIri !== factPayload.positionSourceKindIri
      || selectedPayload.revision !== factPayload.revision
      || selectedPayload.validFrom !== factPayload.validFrom) {
    fail(
      'S5_CUSTOM_HOLDING_SOURCE_PAYLOAD',
      `${subject} RDF fields do not equal the exact JCS-selected provider page record bytes`,
    );
  }
  assertNoOutgoingObjectType(
    index,
    subject,
    [`${P}Portfolio`, `${P}Portfolio/LogicalIdentity`],
    'S5_CUSTOM_HOLDING',
    'direct Portfolio',
  );
  if (objects(index, subject, `${OE}orderSide`).length > 0
      || objects(index, subject, `${P}positionSide`).length > 0) {
    fail('S5_CUSTOM_HOLDING', `${subject} stores a forbidden directional side`);
  }
  const keyValues = (candidate) => ({
    observationStreamLogical: one(
      index,
      one(
        index,
        candidate,
        `${P}HoldingSnapshot/role/holdingObservationStream`,
        'NamedNode',
      ),
      `${DBP}versionOf`,
      'NamedNode',
    ),
    snapshotId: one(index, candidate, `${P}snapshotId`, 'Literal'),
  });
  assertLogicalKeyBijection(index, {
    code: 'S5_CUSTOM_HOLDING',
    keyMatches: (candidate) => canonicalJcs(keyValues(candidate)) === canonicalJcs({
      observationStreamLogical,
      snapshotId,
    }),
    keyValues,
    logicalIri: logical,
    subject,
    type: `${P}HoldingSnapshot`,
  });
}

function valuationDefinitionFacts(index, subject, context) {
  requireType(index, subject, `${P}ValuationCalculationDefinition`);
  const logical = one(index, subject, `${DBP}versionOf`, 'NamedNode');
  requireType(index, logical, `${P}ValuationCalculationDefinition/LogicalIdentity`);
  const authority = one(index, subject, `${P}valuationDefinitionAuthority`, 'NamedNode');
  requireType(index, authority, `${F}Party/LogicalIdentity`);
  const definitionId = one(index, subject, `${P}valuationDefinitionId`, 'Literal');
  if (definitionId.length === 0) {
    fail('S5_CUSTOM_VALUATION_DEFINITION', `${subject} has an empty authority-scoped identifier`);
  }
  const sameLogicalKey = [...(
    index.byType.get(`${P}ValuationCalculationDefinition`) || []
  )].filter((candidate) => (
    objects(index, candidate, `${P}valuationDefinitionAuthority`)
      .some((term) => term.value === authority)
      && objects(index, candidate, `${P}valuationDefinitionId`)
        .some((term) => term.value === definitionId)
  ));
  if (sameLogicalKey.length !== 1 || sameLogicalKey[0] !== subject) {
    fail(
      'S5_CUSTOM_VALUATION_DEFINITION',
      `${subject} authority/definitionId logical key is not unique`,
    );
  }
  const quotations = objects(index, subject, `${P}valuationDefinitionQuotationContract`)
    .map((term) => {
      if (term.termType !== 'NamedNode') {
        fail('S5_CUSTOM_VALUATION_DEFINITION', `${subject} quotation closure contains a non-IRI member`);
      }
      requireType(index, term.value, `${I}DirectUnitPriceQuotationContract`);
      return term.value;
    })
    .sort(utf8Compare);
  const quotationCount = one(
    index,
    subject,
    `${P}valuationQuotationContractCount`,
    'Literal',
  );
  const quotationSetDigest = one(
    index,
    subject,
    `${P}valuationQuotationContractVersionSetDigest`,
    'Literal',
  );
  if (!/^[1-9]\d*$/u.test(quotationCount)
      || Number(quotationCount) !== quotations.length
      || quotationSetDigest !== iriSetDigest(quotations)) {
    fail(
      'S5_CUSTOM_VALUATION_DEFINITION',
      `${subject} quotation closure/count/section-5.8 digest differs`,
    );
  }
  if (one(index, subject, `${P}valuationMethod`, 'NamedNode')
      !== `${P}ValuationMethod/value/directUnitPriceTimesQuantity`) {
    fail('S5_CUSTOM_VALUATION_DEFINITION', `${subject} method is not direct unit price times quantity`);
  }
  const formulaDigest = one(index, subject, `${P}formulaDigest`, 'Literal');
  const formulaRef = one(index, subject, `${PA}source`, 'Literal');
  requireDigest(formulaDigest, 'formulaDigest');
  const formula = lockedEvidence(
    context,
    formulaRef,
    'valuationFormulaImplementation',
    formulaDigest,
  );
  const inputDigest = one(index, subject, `${P}inputContractDigest`, 'Literal');
  const outputDigest = one(index, subject, `${P}outputContractDigest`, 'Literal');
  const runtimeDigest = one(index, subject, `${P}runtimeDigest`, 'Literal');
  for (const [name, digest] of [
    ['inputContractDigest', inputDigest],
    ['outputContractDigest', outputDigest],
    ['runtimeDigest', runtimeDigest],
  ]) requireDigest(digest, name);
  lockedEvidence(context, EVIDENCE.inputContract, 'inputContract', inputDigest);
  const output = lockedEvidence(
    context,
    EVIDENCE.outputContract,
    'outputContract',
    outputDigest,
  );
  const runtime = lockedEvidence(context, EVIDENCE.runtime, 'runtimeClosure', runtimeDigest);
  const toolLock = lockedRefDigest(
    index,
    subject,
    `${P}toolLockRef`,
    `${P}toolLockDigest`,
    context,
    'toolLock',
  );
  validateMaterializerCapabilityEvidence(formula, output, runtime, toolLock);
  const policies = valuationPolicies(index, subject, context);
  return {
    authority,
    definitionId,
    logical,
    policies,
    quotationSetDigest,
    quotations,
  };
}

function valuationDefinition(index, subject, context) {
  valuationDefinitionFacts(index, subject, context);
}

function portfolioValuationFacts(index, subject, context) {
  requireType(index, subject, `${P}PortfolioValuation`);
  const valuedPortfolio = one(
    index,
    subject,
    `${P}PortfolioValuation/role/valuedPortfolio`,
    'NamedNode',
  );
  requireType(index, valuedPortfolio, `${P}Portfolio/LogicalIdentity`);
  const memberClosure = one(
    index,
    subject,
    `${P}PortfolioValuation/role/memberAccountClosure`,
    'NamedNode',
  );
  requireType(index, memberClosure, `${P}PortfolioAccountMembershipClosure`);
  if (one(
    index,
    memberClosure,
    `${P}PortfolioAccountMembershipClosure/role/closurePortfolio`,
    'NamedNode',
  ) !== valuedPortfolio) {
    fail('S5_CUSTOM_PORTFOLIO_VALUATION', `${subject} closure portfolio differs from valued portfolio`);
  }
  const definition = one(
    index,
    subject,
    `${P}PortfolioValuation/role/valuationDefinition`,
    'NamedNode',
  );
  const definitionFacts = valuationDefinitionFacts(index, definition, context);
  const reportingCurrency = one(
    index,
    subject,
    `${P}PortfolioValuation/role/reportingCurrency`,
    'NamedNode',
  );
  requireType(index, reportingCurrency, `${F}Currency/LogicalIdentity`);
  const valuationRunId = one(index, subject, `${P}valuationRunId`, 'Literal');
  if (valuationRunId.length === 0) {
    fail('S5_CUSTOM_PORTFOLIO_VALUATION', `${subject} valuationRunId is empty`);
  }
  const logical = one(index, subject, `${DBP}versionOf`, 'NamedNode');
  requireType(index, logical, `${P}PortfolioValuation/LogicalIdentity`);
  const sameLogicalKey = [...(index.byType.get(`${P}PortfolioValuation`) || [])].filter(
    (candidate) => objects(index, candidate, `${P}PortfolioValuation/role/valuedPortfolio`)
      .some((term) => term.value === valuedPortfolio)
      && objects(index, candidate, `${P}valuationRunId`)
        .some((term) => term.value === valuationRunId),
  );
  if (sameLogicalKey.length !== 1 || sameLogicalKey[0] !== subject) {
    fail(
      'S5_CUSTOM_PORTFOLIO_VALUATION',
      `${subject} valuedPortfolio/valuationRunId logical key is not unique`,
    );
  }
  const conversionContext = lockedRefDigest(
    index,
    subject,
    `${P}conversionContextRef`,
    `${P}conversionContextDigest`,
    context,
    'conversionContext',
  );
  if (conversionContext.value?.schemaVersion !== '1.0'
      || !['sameCurrency', 'crossCurrency'].includes(conversionContext.value.branch)
      || !Array.isArray(conversionContext.value.conversions)) {
    fail('S5_CUSTOM_PORTFOLIO_VALUATION', `${subject} conversion context is invalid`);
  }
  const inputContext = lockedRefDigest(
    index,
    subject,
    `${DBA}inputContextRef`,
    `${DBA}inputContextRecordDigest`,
    context,
    'completedInputContext',
  );
  const knowledgeFrom = one(index, subject, `${PA}knowledgeFrom`, 'Literal');
  validatePriorCompletedContext(inputContext, knowledgeFrom, context);
  const pit = lockedRefDigest(
    index,
    subject,
    `${DBA}pitRequestRef`,
    `${DBA}pitRequestRecordDigest`,
    context,
    'pitRequest',
  );
  validatePitEvidence(pit, inputContext, context);
  return {
    conversionContext,
    definition,
    definitionFacts,
    logical,
    memberClosure,
    reportingCurrency,
    valuedPortfolio,
    valuationRunId,
  };
}

function portfolioValuation(index, subject, context) {
  portfolioValuationFacts(index, subject, context);
}

function positionValuation(index, subject, context) {
  const header = one(index, subject, `${P}PositionValuation/role/valuationHeader`, 'NamedNode');
  const headerFacts = portfolioValuationFacts(index, header, context);
  const holdingNode = one(
    index,
    subject,
    `${P}PositionValuation/role/valuedHoldingSnapshot`,
    'NamedNode',
  );
  requireType(index, holdingNode, `${P}HoldingSnapshot`);
  if (objects(index, subject, `${P}PositionValuation/role/valuedPositionSnapshot`).length !== 0) {
    fail('S5_CUSTOM_POSITION_VALUATION', `${subject} violates the input snapshot xone`);
  }
  const priceNode = one(index, subject, `${P}PositionValuation/role/valuationPrice`, 'NamedNode');
  requireType(index, priceNode, `${MD}PriceObservation`);
  const marketValueNode = one(index, subject, `${P}marketValue`, 'NamedNode');

  const holdingAccount = one(
    index,
    holdingNode,
    `${P}HoldingSnapshot/role/holdingAccount`,
    'NamedNode',
  );
  const closedMemberships = objects(
    index,
    headerFacts.memberClosure,
    `${P}PortfolioAccountMembershipClosure/role/closedMembership`,
  ).map((term) => term.value);
  const accountMemberships = closedMemberships.filter((membershipNode) => (
    objects(index, membershipNode, `${P}PortfolioAccountMembership/role/memberAccount`)
      .some((term) => term.value === holdingAccount)
  ));
  if (accountMemberships.length !== 1) {
    fail(
      'S5_CUSTOM_POSITION_VALUATION',
      `${subject} holding account is not represented exactly once in the header membership closure`,
    );
  }
  requireType(index, accountMemberships[0], `${P}PortfolioAccountMembership`);
  if (one(
    index,
    accountMemberships[0],
    `${P}PortfolioAccountMembership/role/membershipPortfolio`,
    'NamedNode',
  ) !== headerFacts.valuedPortfolio) {
    fail(
      'S5_CUSTOM_POSITION_VALUATION',
      `${subject} matched account membership belongs to a different portfolio`,
    );
  }

  const holdingInstrument = one(
    index,
    holdingNode,
    `${P}HoldingSnapshot/role/holdingInstrument`,
    'NamedNode',
  );
  const priceInstrumentVersion = one(
    index,
    priceNode,
    `${MD}PriceObservation/role/observedInstrument`,
    'NamedNode',
  );
  if (one(index, priceInstrumentVersion, `${DBP}versionOf`, 'NamedNode') !== holdingInstrument) {
    fail('S5_CUSTOM_POSITION_VALUATION', `${subject} snapshot and price instruments differ`);
  }
  const holdingListing = one(
    index,
    holdingNode,
    `${P}HoldingSnapshot/role/holdingListing`,
    'NamedNode',
  );
  if (one(
    index,
    priceNode,
    `${MD}PriceObservation/role/observedListing`,
    'NamedNode',
  ) !== holdingListing) {
    fail('S5_CUSTOM_POSITION_VALUATION', `${subject} snapshot and price listings differ`);
  }

  const quantityNode = one(index, holdingNode, `${P}holdingQuantity`, 'NamedNode');
  const quantityValue = quantity(index, quantityNode, 'holding quantity');
  const quotation = one(
    index,
    priceNode,
    `${MD}PriceObservation/role/quotationContract`,
    'NamedNode',
  );
  if (!headerFacts.definitionFacts.quotations.includes(quotation)) {
    fail('S5_CUSTOM_POSITION_VALUATION', `${subject} price quotation is outside the definition closure`);
  }
  if (one(index, quotation, `${I}quotationDenominatorUnit`, 'Literal')
      !== quantityValue.unit) {
    fail('S5_CUSTOM_POSITION_VALUATION', `${subject} quotation and quantity units differ`);
  }

  const priceValueNode = one(index, priceNode, `${MD}priceValue`, 'NamedNode');
  const price = money(index, priceValueNode, 'valuation price');
  const marketValue = money(index, marketValueNode, 'position market value');
  const reportingCurrencyIri = headerFacts.reportingCurrency;
  if (reportingCurrencyIri
      !== `https://axiolune.ai/data/finance/foundation/currency/${marketValue.currency}`
      || marketValue.currency !== price.currency
      || one(index, quotation, `${I}quotationQuoteCurrency`, 'NamedNode')
        !== reportingCurrencyIri
      || headerFacts.conversionContext.value.priceCurrency !== price.currency
      || headerFacts.conversionContext.value.reportingCurrency !== marketValue.currency) {
    fail('S5_CUSTOM_POSITION_VALUATION', `${subject} currency/quotation/context truths differ`);
  }
  if (headerFacts.conversionContext.value.branch !== 'sameCurrency'
      || headerFacts.conversionContext.value.conversions.length !== 0
      || objects(index, subject, `${P}PositionValuation/role/valuationFxConversion`).length !== 0) {
    fail('S5_CUSTOM_POSITION_VALUATION', `${subject} same-currency branch contains FX evidence`);
  }
  const rounding = headerFacts.definitionFacts.policies.rounding;
  const expectedAmount = policyDecimalProduct(quantityValue.value, price.amount, rounding);
  if (marketValue.scale !== rounding.outputScale || marketValue.amount !== expectedAmount) {
    fail('S5_CUSTOM_POSITION_VALUATION', `${subject} policy-driven value arithmetic/scale differs`);
  }

  for (const predicate of [
    `${P}valuationMethod`, `${P}parValue`, `${P}accruedInterest`, `${P}inversePrice`,
    `${P}notionalValue`, `${I}contractMultiplier`,
  ]) {
    if (objects(index, subject, predicate).length !== 0) {
      fail('S5_CUSTOM_POSITION_VALUATION', `${subject} carries forbidden fallback ${predicate}`);
    }
  }
  const sameIdentityPair = [...(index.byType.get(`${P}PositionValuation`) || [])].filter(
    (candidate) => objects(index, candidate, `${P}PositionValuation/role/valuationHeader`)
      .some((term) => term.value === header)
      && objects(index, candidate, `${P}PositionValuation/role/valuedHoldingSnapshot`)
        .some((term) => term.value === holdingNode),
  );
  if (sameIdentityPair.length !== 1 || sameIdentityPair[0] !== subject) {
    fail('S5_CUSTOM_POSITION_VALUATION', `${subject} reverse logical-key link is not unique`);
  }
}

const EVALUATORS = Object.freeze({
  DirectUnitPriceQuotationRule: directQuotation,
  HoldingSnapshotContract: holding,
  InstrumentListingIdentityContract: listingIdentity,
  InstrumentListingIntervalContract: listingInterval,
  InstrumentListingOfferingContract: listingOffering,
  MarketDataStreamIdentityContract: streamIdentity,
  ObservationContextQuotationContract: observationContext,
  ObservationIdentityAndRevisionContract: observationIdentity,
  PortfolioAccountMembershipClosureContract: membershipClosure,
  PortfolioAccountMembershipContract: membership,
  PortfolioObservationStreamContract: portfolioObservationStream,
  PortfolioValuationContract: portfolioValuation,
  PositionValuationContract: positionValuation,
  PriceKindCompatibilityContract: priceKind,
  ThreeAxisObjectPITContract: commonFactVersion,
  ThreeAxisPITContract: commonFactVersion,
  ValuationCalculationDefinitionContract: valuationDefinition,
});

function discoverApplicableCustom(moduleDocuments, index) {
  const discovered = new Map();
  for (const document of moduleDocuments) {
    const constraints = new Map(
      Object.values(document?.domain?.constraints || {}).map((constraint) => [constraint.iri, constraint]),
    );
    for (const binding of document?.domain?.constraintBindings || []) {
      const constraint = constraints.get(binding.constraintRef);
      if (!constraint || constraint.expression?.language !== 'Custom') continue;
      const focusNodes = [...(index.byType.get(binding.targetElement) || [])].sort(utf8Compare);
      if (focusNodes.length === 0) continue;
      const key = `${constraint.iri}\0${binding.targetElement}`;
      if (discovered.has(key)) fail('S5_CUSTOM_DISCOVERY', `duplicate Custom binding ${key}`);
      const evaluatorName = constraint.iri.split('/').at(-1);
      if (!Object.hasOwn(EVALUATORS, evaluatorName)) {
        fail('S5_CUSTOM_ENGINE_MISSING', `no locked evaluator for applicable ${constraint.iri}`);
      }
      discovered.set(key, {
        constraintIri: constraint.iri,
        evaluatorName,
        focusNodes,
        targetType: binding.targetElement,
      });
    }
  }
  return [...discovered.values()].sort((left, right) => utf8Compare(
    `${left.constraintIri}\0${left.targetType}`,
    `${right.constraintIri}\0${right.targetType}`,
  ));
}

function validateMaterializedCustom(options) {
  const {
    allowedGeneratingContextIris, asOfAvailable, asOfKnowledge, asOfValid,
    dataNQuads, lockedEvidence, moduleDocuments, readLockedArtifact, referenceTime, supportNQuads,
    targetGraphIri,
  } = options;
  if (!Array.isArray(moduleDocuments) || moduleDocuments.length === 0
      || !Array.isArray(allowedGeneratingContextIris)
      || allowedGeneratingContextIris.length === 0
      || !(lockedEvidence instanceof Map) || lockedEvidence.size === 0) {
    fail('S5_CUSTOM_REQUEST', 'module, evidence, and generating-context closures must be non-empty');
  }
  const dataIndex = createIndex(dataNQuads);
  const supportIndex = createIndex(supportNQuads);
  assertValidationDatasetsAreIsolated(dataIndex, supportIndex);
  const index = createIndex(`${dataNQuads}${supportNQuads}`);
  if (!index.quads.some((statement) => statement.graph.value === targetGraphIri)) {
    fail('S5_CUSTOM_TARGET_GRAPH', `target graph is absent: ${targetGraphIri}`);
  }
  const evidenceContext = {
    allowedGeneratingContextIris: [...allowedGeneratingContextIris].sort(utf8Compare),
    asOfAvailable,
    asOfKnowledge,
    asOfValid,
    referenceTime,
  };
  const runtimeContext = { ...evidenceContext, lockedEvidence, readLockedArtifact };
  const discovered = discoverApplicableCustom(moduleDocuments, index);
  if (discovered.length === 0) fail('S5_CUSTOM_DISCOVERY', 'no applicable Custom constraints discovered');
  const checks = [];
  for (const entry of discovered) {
    const evaluator = EVALUATORS[entry.evaluatorName];
    for (const focusNode of entry.focusNodes) evaluator(index, focusNode, runtimeContext);
    const constraintInstance = {
      component: COMPONENT,
      originKind: 'constraintDefinition',
      originRef: entry.constraintIri,
      targetRef: entry.targetType,
    };
    checks.push({
      constraintInstanceId: constraintInstanceId(constraintInstance),
      constraintIri: entry.constraintIri,
      evaluatorName: entry.evaluatorName,
      focusNodeIris: entry.focusNodes,
      outcome: 'passed',
      targetType: entry.targetType,
    });
  }
  return {
    artifactKind: 's5MaterializedApplicableCustomEvidence',
    context: evidenceContext,
    counts: {
      discovered: checks.length,
      executed: checks.length,
      failed: 0,
      passed: checks.length,
    },
    data: {
      materializedDatasetDigest: sha256(Buffer.from(dataNQuads, 'utf8')),
      supportDatasetDigest: sha256(Buffer.from(supportNQuads, 'utf8')),
      targetGraphIri,
    },
    checks,
    outcome: 'passed',
    schemaVersion: '1.0',
  };
}

module.exports = {
  EVALUATORS,
  S5MaterializedCustomError,
  discoverApplicableCustom,
  validateMaterializedCustom,
};
