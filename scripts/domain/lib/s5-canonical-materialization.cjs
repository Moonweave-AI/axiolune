'use strict';

const crypto = require('node:crypto');
const { DataFactory, Writer } = require('n3');
const rdfCanonize = require('rdf-canonize');
const {
  buildIdentityIris,
  taggedJcsDigest,
} = require('./identity-contract-compiler.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const { literal, namedNode, quad } = DataFactory;

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const META_BINDING = 'https://axiolune.ai/ontology/meta/data-binding/';
const META_BINDING_ATTRIBUTES = `${META_BINDING}attributes/`;
const META_PATTERN_ATTRIBUTES = 'https://axiolune.ai/ontology/meta/patterns/attributes/';
const CORE_VALUES = 'https://axiolune.ai/ontology/meta/core/values/';
const CORE_PROPERTIES = 'https://axiolune.ai/ontology/meta/core/properties/';
const FOUNDATION = 'https://axiolune.ai/ontology/finance/foundation/';
const INSTRUMENTS = 'https://axiolune.ai/ontology/finance/instruments/';
const MARKET_STRUCTURE = 'https://axiolune.ai/ontology/finance/market-structure/';
const MARKET_DATA = 'https://axiolune.ai/ontology/finance/market-data/';
const PORTFOLIO = 'https://axiolune.ai/ontology/finance/portfolio-positions/';

const FACT_IDENTITY = `${META_BINDING}FactIdentity`;
const FACT_VERSION = `${META_BINDING}FactVersion`;
const VERSION_OF = `${META_BINDING}properties/versionOf`;
const GENERATING_CONTEXT = `${META_BINDING_ATTRIBUTES}generatingContextRef`;
const VALID_FROM = `${META_PATTERN_ATTRIBUTES}validFrom`;
const KNOWLEDGE_FROM = `${META_PATTERN_ATTRIBUTES}knowledgeFrom`;
const AVAILABLE_FROM = `${META_PATTERN_ATTRIBUTES}availableFrom`;
const REVISION = `${META_PATTERN_ATTRIBUTES}revision`;
const SOURCE = `${META_PATTERN_ATTRIBUTES}source`;
const PROHIBITED_IRIS = Object.freeze([
  ['urn:axiolune:', 'type:'].join(''),
  ['urn:axiolune:', 'predicate:'].join(''),
  ['https://axiolune.ai/ontology/meta/', 'patterns/FactVersion'].join(''),
]);

const IDENTITY_GRAPH_IRI = 'urn:axiolune:graph:slice-a:identity:v1';
const MARKET_GRAPH_IRI = 'urn:axiolune:graph:slice-a:market-data:v1';
const PORTFOLIO_GRAPH_IRI = 'urn:axiolune:graph:slice-a:portfolio-valuation:v1';
const TARGET_DATASET_IRI = 'urn:axiolune:dataset:slice-a:control-chain:v1';
const PROVENANCE_GRAPH_IRI = `${TARGET_DATASET_IRI}/provenance`;
const SUPPORT_GRAPH_IRI = 'urn:axiolune:graph:slice-a:validation-support:v1';

const TRANSFORMATION_REFS = Object.freeze({
  directUnitPriceTimesQuantity:
    'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/transformation/direct-unit-price-times-quantity',
  moneyValue:
    'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/transformation/money-value',
  quantityValue:
    'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/transformation/quantity-value',
});

const VERSION_COMPONENTS = Object.freeze([
  Object.freeze({ name: 'validFrom' }),
  Object.freeze({ name: 'knowledgeFrom' }),
  Object.freeze({ name: 'availableFrom' }),
  Object.freeze({ name: 'revision' }),
]);

const CONTRACTS = Object.freeze({
  ISINValue: Object.freeze({
    iri: 'urn:axiolune:identity-contract:slice-a:isin-value:v1',
    targetType: `${FOUNDATION}ISINValue`,
    identityBaseIri: 'https://axiolune.ai/data/finance/foundation/isin-value',
    logicalComponents: Object.freeze([
      Object.freeze({ name: 'schemeLogicalIri' }),
      Object.freeze({ name: 'canonicalLexicalValue' }),
    ]),
    versionComponents: VERSION_COMPONENTS,
  }),
  MarketDataStream: Object.freeze({
    iri: 'urn:axiolune:identity-contract:slice-a:market-data-stream:v1',
    targetType: `${MARKET_DATA}MarketDataStream`,
    identityBaseIri: 'https://axiolune.ai/data/finance/market-data/stream',
    logicalComponents: Object.freeze([
      Object.freeze({ name: 'providerLogicalIri' }),
      Object.freeze({ name: 'sourceContractRef' }),
      Object.freeze({ name: 'providerStreamId' }),
    ]),
    versionComponents: VERSION_COMPONENTS,
  }),
  PriceObservation: Object.freeze({
    iri: 'urn:axiolune:identity-contract:slice-a:price-observation:v1',
    targetType: `${MARKET_DATA}PriceObservation`,
    identityBaseIri: 'https://axiolune.ai/data/finance/market-data/price-observation',
    logicalComponents: Object.freeze([
      Object.freeze({ name: 'observationStreamLogicalIri' }),
      Object.freeze({ name: 'providerObservationId' }),
    ]),
    versionComponents: VERSION_COMPONENTS,
  }),
  HoldingSnapshot: Object.freeze({
    iri: 'urn:axiolune:identity-contract:slice-a:holding-snapshot:v1',
    targetType: `${PORTFOLIO}HoldingSnapshot`,
    identityBaseIri: 'https://axiolune.ai/data/finance/portfolio-positions/holding-snapshot',
    logicalComponents: Object.freeze([
      Object.freeze({ name: 'observationStreamLogicalIri' }),
      Object.freeze({ name: 'snapshotId' }),
    ]),
    versionComponents: VERSION_COMPONENTS,
  }),
  PortfolioValuation: Object.freeze({
    iri: 'urn:axiolune:identity-contract:slice-a:portfolio-valuation:v1',
    targetType: `${PORTFOLIO}PortfolioValuation`,
    identityBaseIri: 'https://axiolune.ai/data/finance/portfolio-positions/portfolio-valuation',
    logicalComponents: Object.freeze([
      Object.freeze({ name: 'portfolioLogicalIri' }),
      Object.freeze({ name: 'valuationRunId' }),
    ]),
    versionComponents: VERSION_COMPONENTS,
  }),
  PositionValuation: Object.freeze({
    iri: 'urn:axiolune:identity-contract:slice-a:position-valuation:v1',
    targetType: `${PORTFOLIO}PositionValuation`,
    identityBaseIri: 'https://axiolune.ai/data/finance/portfolio-positions/position-valuation',
    logicalComponents: Object.freeze([
      Object.freeze({ name: 'valuationHeaderVersionIri' }),
      Object.freeze({ name: 'inputSnapshotVersionIri' }),
    ]),
    versionComponents: VERSION_COMPONENTS,
  }),
});

const TARGETS = Object.freeze({
  [`${FOUNDATION}ISINValue`]: Object.freeze({
    contract: CONTRACTS.ISINValue,
    logicalType: `${FOUNDATION}ISINValue/LogicalIdentity`,
    targetGraph: IDENTITY_GRAPH_IRI,
  }),
  [`${MARKET_DATA}MarketDataStream`]: Object.freeze({
    contract: CONTRACTS.MarketDataStream,
    logicalType: `${MARKET_DATA}MarketDataStream/LogicalIdentity`,
    targetGraph: MARKET_GRAPH_IRI,
  }),
  [`${MARKET_DATA}PriceObservation`]: Object.freeze({
    contract: CONTRACTS.PriceObservation,
    logicalType: `${MARKET_DATA}PriceObservation/LogicalIdentity`,
    targetGraph: MARKET_GRAPH_IRI,
  }),
  [`${PORTFOLIO}HoldingSnapshot`]: Object.freeze({
    contract: CONTRACTS.HoldingSnapshot,
    logicalType: `${PORTFOLIO}HoldingSnapshot/LogicalIdentity`,
    targetGraph: PORTFOLIO_GRAPH_IRI,
  }),
  [`${PORTFOLIO}PortfolioValuation`]: Object.freeze({
    contract: CONTRACTS.PortfolioValuation,
    logicalType: `${PORTFOLIO}PortfolioValuation/LogicalIdentity`,
    targetGraph: PORTFOLIO_GRAPH_IRI,
  }),
  [`${PORTFOLIO}PositionValuation`]: Object.freeze({
    contract: CONTRACTS.PositionValuation,
    logicalType: `${PORTFOLIO}PositionValuation/LogicalIdentity`,
    targetGraph: PORTFOLIO_GRAPH_IRI,
  }),
});

class S5CanonicalMaterializationError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'S5CanonicalMaterializationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new S5CanonicalMaterializationError(code, message);
}

function ntriplesEscape(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
}

function typedTerm(value, datatype) {
  return `"${ntriplesEscape(String(value))}"^^<${datatype}>`;
}

function iriTerm(value) {
  return `<${value}>`;
}

function versionTerms(row) {
  return {
    validFrom: typedTerm(row.valid_from, `${XSD}dateTimeStamp`),
    knowledgeFrom: typedTerm(row.knowledge_from, `${XSD}dateTimeStamp`),
    availableFrom: typedTerm(row.available_from, `${XSD}dateTimeStamp`),
    revision: typedTerm(row.revision, `${XSD}nonNegativeInteger`),
  };
}

function writerBytes(statements, reverse = false) {
  const rows = reverse ? [...statements].reverse() : statements;
  return new Writer({ format: 'N-Quads' }).quadsToString(rows);
}

function addType(statements, subject, type, graph) {
  statements.push(quad(namedNode(subject), namedNode(RDF_TYPE), namedNode(type), namedNode(graph)));
}

function addIri(statements, subject, predicate, object, graph) {
  statements.push(quad(namedNode(subject), namedNode(predicate), namedNode(object), namedNode(graph)));
}

function addLiteral(statements, subject, predicate, value, datatype, graph) {
  statements.push(quad(
    namedNode(subject),
    namedNode(predicate),
    literal(String(value), namedNode(datatype)),
    namedNode(graph),
  ));
}

function emitFactVersion(statements, options) {
  const {
    contract, domainTypes, logicalTerms, row, runIri, graph, source = row.source,
  } = options;
  const identity = buildIdentityIris(contract, logicalTerms, versionTerms(row));
  for (const type of domainTypes) addType(statements, identity.versionIri, type, graph);
  addType(statements, identity.versionIri, FACT_VERSION, graph);
  addType(statements, identity.logicalIri, FACT_IDENTITY, graph);
  addType(statements, identity.logicalIri, `${contract.targetType}/LogicalIdentity`, graph);
  addIri(statements, identity.versionIri, VERSION_OF, identity.logicalIri, graph);
  addLiteral(statements, identity.versionIri, VALID_FROM, row.valid_from, `${XSD}dateTimeStamp`, graph);
  addLiteral(statements, identity.versionIri, KNOWLEDGE_FROM, row.knowledge_from, `${XSD}dateTimeStamp`, graph);
  addLiteral(statements, identity.versionIri, AVAILABLE_FROM, row.available_from, `${XSD}dateTimeStamp`, graph);
  addLiteral(statements, identity.versionIri, REVISION, row.revision, `${XSD}nonNegativeInteger`, graph);
  addLiteral(statements, identity.versionIri, SOURCE, source, `${XSD}anyURI`, graph);
  if (runIri !== null) {
    addLiteral(statements, identity.versionIri, GENERATING_CONTEXT, runIri, `${XSD}anyURI`, graph);
  }
  return identity;
}

function logicalIriFromVersion(versionIri, label) {
  const versionMarker = versionIri.indexOf('/version/');
  if (versionMarker <= 0) {
    fail('S5_CANONICAL_EXACT_REFERENCE', `${label} has no /version/ segment`);
  }
  return versionIri.slice(0, versionMarker);
}

function emitExactReference(
  statements,
  graph,
  subjectIri,
  targetType,
  logicalType,
  explicitLogicalIri = null,
) {
  const logicalIri = explicitLogicalIri === null
    ? logicalIriFromVersion(subjectIri, subjectIri)
    : explicitLogicalIri;
  addType(statements, subjectIri, targetType, graph);
  addType(statements, subjectIri, FACT_VERSION, graph);
  addIri(statements, subjectIri, VERSION_OF, logicalIri, graph);
  addType(statements, logicalIri, FACT_IDENTITY, graph);
  addType(statements, logicalIri, logicalType, graph);
  return { logicalIri, versionIri: subjectIri };
}

function emitSupportFactVersion(statements, options) {
  const {
    graph,
    row,
    runIri,
    source = row.source,
    targetType,
    versionIri,
  } = options;
  const identity = emitExactReference(
    statements,
    graph,
    versionIri,
    targetType,
    `${targetType}/LogicalIdentity`,
  );
  addLiteral(statements, versionIri, VALID_FROM, row.valid_from, `${XSD}dateTimeStamp`, graph);
  addLiteral(statements, versionIri, KNOWLEDGE_FROM, row.knowledge_from, `${XSD}dateTimeStamp`, graph);
  addLiteral(statements, versionIri, AVAILABLE_FROM, row.available_from, `${XSD}dateTimeStamp`, graph);
  addLiteral(statements, versionIri, REVISION, row.revision, `${XSD}nonNegativeInteger`, graph);
  addLiteral(statements, versionIri, SOURCE, source, `${XSD}anyURI`, graph);
  addLiteral(statements, versionIri, GENERATING_CONTEXT, runIri, `${XSD}anyURI`, graph);
  return identity;
}

function addLogicalReference(statements, graph, iri, targetType) {
  addType(statements, iri, FACT_IDENTITY, graph);
  addType(statements, iri, `${targetType}/LogicalIdentity`, graph);
}

function parseCanonicalDecimal(value, label) {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(String(value));
  if (!match) fail('S5_CANONICAL_DECIMAL', `${label} is not a canonical decimal string`);
  const fraction = match[3] || '';
  return {
    coefficient: BigInt(`${match[1]}${match[2]}${fraction}`),
    scale: fraction.length,
  };
}

function addQuantity(statements, graph, subject, value, unit, precision, rounding) {
  const canonical = canonicalQuantityValue({ precision, rounding, unit, value });
  addType(statements, subject, `${CORE_VALUES}QuantityValue`, graph);
  addLiteral(statements, subject, `${CORE_PROPERTIES}hasNumericValue`, canonical.value, `${XSD}decimal`, graph);
  addLiteral(statements, subject, `${CORE_PROPERTIES}hasUnit`, canonical.unit, `${XSD}string`, graph);
  addLiteral(statements, subject, `${CORE_PROPERTIES}hasPrecision`, canonical.precision, `${XSD}integer`, graph);
  addLiteral(statements, subject, `${CORE_PROPERTIES}hasRounding`, canonical.rounding, `${XSD}string`, graph);
}

function addMoney(statements, graph, subject, amount, currency, scale) {
  const canonical = canonicalMoneyValue({ amount, currency, scale });
  addType(statements, subject, `${CORE_VALUES}MonetaryAmount`, graph);
  addLiteral(statements, subject, `${CORE_PROPERTIES}hasAmount`, canonical.amount, `${XSD}decimal`, graph);
  addLiteral(statements, subject, `${CORE_PROPERTIES}hasCurrency`, canonical.currency, `${XSD}string`, graph);
  addLiteral(statements, subject, `${CORE_PROPERTIES}hasScale`, canonical.scale, `${XSD}integer`, graph);
}

function formatScaledDecimal(coefficient, scale) {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const sign = negative && coefficient !== 0n ? '-' : '';
  if (scale === 0) return `${sign}${digits}`;
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale);
  return `${sign}${whole}.${fraction}`;
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

function lockedValuationPolicy(row, options) {
  const artifacts = options.valuationPolicyArtifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)
      || canonicalJcs(Object.keys(artifacts).sort())
        !== canonicalJcs(['precisionBytes', 'roundingBytes'])) {
    fail(
      'S5_CANONICAL_VALUATION_POLICY',
      'exact precision and rounding policy artifact bytes are required',
    );
  }
  const readPolicy = (bytes, label, expectedDigest) => {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '', 'utf8');
    const digest = `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
    if (digest !== expectedDigest) {
      fail('S5_CANONICAL_VALUATION_POLICY', `${label} bytes do not match the source-row digest`);
    }
    let value;
    try {
      value = JSON.parse(buffer.toString('utf8'));
    } catch (cause) {
      fail('S5_CANONICAL_VALUATION_POLICY', `${label} is not JSON: ${cause.message}`);
    }
    if (buffer.toString('utf8') !== canonicalJcs(value)) {
      fail('S5_CANONICAL_VALUATION_POLICY', `${label} is not exact RFC8785 JCS`);
    }
    return value;
  };
  const precision = readPolicy(
    artifacts.precisionBytes,
    'precision policy',
    row.valuation_precision_policy_digest,
  );
  const rounding = readPolicy(
    artifacts.roundingBytes,
    'rounding policy',
    row.valuation_rounding_policy_digest,
  );
  if (!precision || typeof precision !== 'object' || Array.isArray(precision)
      || canonicalJcs(Object.keys(precision).sort()) !== canonicalJcs([
        'decimalArithmetic', 'intermediateScale', 'policyId', 'schemaVersion',
      ])
      || precision.schemaVersion !== '1.0' || precision.decimalArithmetic !== 'exact'
      || precision.intermediateScale !== 'unbounded'
      || typeof precision.policyId !== 'string' || precision.policyId.length === 0) {
    fail('S5_CANONICAL_VALUATION_POLICY', 'precision policy schema/semantics are unsupported');
  }
  if (!rounding || typeof rounding !== 'object' || Array.isArray(rounding)
      || canonicalJcs(Object.keys(rounding).sort()) !== canonicalJcs([
        'mode', 'outputScale', 'policyId', 'schemaVersion', 'stage',
      ])
      || rounding.schemaVersion !== '1.0'
      || !['floor', 'ceiling', 'half-up', 'half-even'].includes(rounding.mode)
      || !Number.isSafeInteger(rounding.outputScale)
      || rounding.outputScale < 0 || rounding.outputScale > 18
      || rounding.stage !== 'finalMonetaryAmount'
      || typeof rounding.policyId !== 'string' || rounding.policyId.length === 0) {
    fail('S5_CANONICAL_VALUATION_POLICY', 'rounding policy mode/scale/stage is unsupported');
  }
  return { precision, rounding };
}

function multiplyDecimal(left, right, valuationPolicy) {
  const a = parseCanonicalDecimal(left, 'left multiplicand');
  const b = parseCanonicalDecimal(right, 'right multiplicand');
  const coefficient = a.coefficient * b.coefficient;
  const inputScale = a.scale + b.scale;
  const { mode, outputScale } = valuationPolicy.rounding;
  return formatScaledDecimal(
    roundCoefficient(coefficient, inputScale, outputScale, mode),
    outputScale,
  );
}

function assertClosedTransformationObject(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('S5_CANONICAL_TRANSFORMATION_INPUT', `${label} must be a closed object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    fail(
      'S5_CANONICAL_TRANSFORMATION_INPUT',
      `${label} fields must equal ${expected.join(', ')}`,
    );
  }
}

function canonicalAbsoluteIri(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')
      || /[\u0000-\u0020\u007f\uD800-\uDFFF]/u.test(value)) {
    fail('S5_CANONICAL_TRANSFORMATION_INPUT', `${label} must be a canonical absolute IRI`);
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || parsed.href !== value) throw new Error('non-canonical IRI');
  } catch {
    fail('S5_CANONICAL_TRANSFORMATION_INPUT', `${label} must be a canonical absolute IRI`);
  }
  return value;
}

function canonicalMoneyValue(input) {
  assertClosedTransformationObject(input, ['amount', 'currency', 'scale'], 'Money input');
  if (typeof input.amount !== 'string') {
    fail('S5_CANONICAL_DECIMAL', 'Money amount must be an exact decimal lexical string');
  }
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/u.test(input.currency)) {
    fail('S5_CANONICAL_MONEY_CURRENCY', 'Money currency must be one uppercase ISO 4217 code');
  }
  const parsed = parseCanonicalDecimal(input.amount, 'Money amount');
  if (!Number.isSafeInteger(input.scale) || input.scale < 0 || parsed.scale !== input.scale) {
    fail(
      'S5_CANONICAL_MONEY_SCALE',
      'Money scale must be explicit and equal the materialized decimal lexical scale',
    );
  }
  return Object.freeze({
    amount: String(input.amount),
    currency: input.currency,
    scale: input.scale,
  });
}

function canonicalQuantityValue(input) {
  assertClosedTransformationObject(
    input,
    ['precision', 'rounding', 'unit', 'value'],
    'Quantity input',
  );
  if (!Number.isSafeInteger(input.precision) || input.precision < 0) {
    fail('S5_CANONICAL_QUANTITY_POLICY', 'Quantity precision must be a non-negative safe integer');
  }
  if (!['floor', 'ceiling', 'half-up', 'half-even'].includes(input.rounding)) {
    fail('S5_CANONICAL_QUANTITY_POLICY', 'Quantity rounding must be an explicit supported mode');
  }
  canonicalAbsoluteIri(input.unit, 'Quantity unit');
  if (typeof input.value !== 'string') {
    fail('S5_CANONICAL_DECIMAL', 'Quantity value must be an exact decimal lexical string');
  }
  parseCanonicalDecimal(input.value, 'Quantity value');
  return Object.freeze({
    precision: input.precision,
    rounding: input.rounding,
    unit: input.unit,
    value: String(input.value),
  });
}

function canonicalDirectUnitPriceTimesQuantity(input, valuationPolicy) {
  assertClosedTransformationObject(input, [
    'precisionPolicyDigest', 'precisionPolicyRef', 'price', 'priceScale',
    'quantity', 'quantityPrecision', 'quantityRounding', 'reportingCurrency',
    'roundingPolicyDigest', 'roundingPolicyRef',
  ], 'direct-unit valuation input');
  canonicalAbsoluteIri(input.precisionPolicyRef, 'precisionPolicyRef');
  canonicalAbsoluteIri(input.roundingPolicyRef, 'roundingPolicyRef');
  canonicalAbsoluteIri(input.reportingCurrency, 'reportingCurrency');
  for (const [field, digest] of [
    ['precisionPolicyDigest', input.precisionPolicyDigest],
    ['roundingPolicyDigest', input.roundingPolicyDigest],
  ]) {
    if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
      fail('S5_CANONICAL_TRANSFORMATION_INPUT', `${field} must be a raw SHA-256 digest`);
    }
  }
  if (typeof input.price !== 'string' || typeof input.quantity !== 'string') {
    fail(
      'S5_CANONICAL_DECIMAL',
      'direct-unit price and quantity must be exact decimal lexical strings',
    );
  }
  const price = parseCanonicalDecimal(input.price, 'direct-unit price');
  parseCanonicalDecimal(input.quantity, 'direct-unit quantity');
  if (!Number.isSafeInteger(input.priceScale) || input.priceScale < 0
      || price.scale !== input.priceScale) {
    fail(
      'S5_CANONICAL_TRANSFORMATION_INPUT',
      'priceScale must equal the exact price decimal lexical scale',
    );
  }
  if (!Number.isSafeInteger(input.quantityPrecision) || input.quantityPrecision < 0) {
    fail(
      'S5_CANONICAL_TRANSFORMATION_INPUT',
      'quantityPrecision must be a non-negative safe integer',
    );
  }
  if (!['floor', 'ceiling', 'half-up', 'half-even'].includes(input.quantityRounding)) {
    fail(
      'S5_CANONICAL_TRANSFORMATION_INPUT',
      'quantityRounding must be an explicit supported mode',
    );
  }
  const currencyPrefix = 'https://axiolune.ai/data/finance/foundation/currency/';
  if (!input.reportingCurrency.startsWith(currencyPrefix)) {
    fail(
      'S5_CANONICAL_TRANSFORMATION_INPUT',
      'reportingCurrency must be a canonical Axiolune currency logical IRI',
    );
  }
  const currency = input.reportingCurrency.slice(currencyPrefix.length);
  const amount = multiplyDecimal(input.quantity, input.price, valuationPolicy);
  return canonicalMoneyValue({
    amount,
    currency,
    scale: valuationPolicy.rounding.outputScale,
  });
}

/**
 * Executes one declared S5 TransformationDefinition vector through the same
 * byte-locked value semantics used by the RDF materializer. Callers cannot
 * supply callbacks, module paths, or implementation selectors.
 */
function executeCanonicalTransformation(transformationRef, input, options = {}) {
  canonicalAbsoluteIri(transformationRef, 'transformationRef');
  if (transformationRef === TRANSFORMATION_REFS.moneyValue) {
    assertClosedTransformationObject(options, [], 'Money execution options');
    return canonicalMoneyValue(input);
  }
  if (transformationRef === TRANSFORMATION_REFS.quantityValue) {
    assertClosedTransformationObject(options, [], 'Quantity execution options');
    return canonicalQuantityValue(input);
  }
  if (transformationRef === TRANSFORMATION_REFS.directUnitPriceTimesQuantity) {
    assertClosedTransformationObject(
      options,
      ['valuationPolicyArtifacts'],
      'direct-unit valuation execution options',
    );
    const valuationPolicy = lockedValuationPolicy({
      valuation_precision_policy_digest: input?.precisionPolicyDigest,
      valuation_rounding_policy_digest: input?.roundingPolicyDigest,
    }, options);
    return canonicalDirectUnitPriceTimesQuantity(input, valuationPolicy);
  }
  fail(
    'S5_CANONICAL_TRANSFORMATION_REF',
    `unsupported canonical transformation: ${transformationRef}`,
  );
}

function u64be(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function iriSetDigest(values) {
  if (!Array.isArray(values) || values.length === 0) {
    fail('S5_CANONICAL_IRI_SET', 'IRI-set digest input must be a non-empty array');
  }
  const sorted = [...new Set(values)].sort((left, right) => (
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  ));
  if (sorted.length !== values.length) {
    fail('S5_CANONICAL_IRI_SET', 'IRI-set digest input contains a duplicate');
  }
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('axiolune-iri-set-v1\0', 'utf8'));
  hash.update(u64be(sorted.length));
  for (const iri of sorted) {
    let parsed;
    try {
      parsed = new URL(iri);
    } catch {
      fail('S5_CANONICAL_IRI_SET', `${iri} is not an absolute IRI`);
    }
    if (!parsed.protocol) fail('S5_CANONICAL_IRI_SET', `${iri} is not an absolute IRI`);
    const bytes = Buffer.from(iri, 'utf8');
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function materializeHistoricalDatasetInternal(
  rows,
  identityRunIri,
  marketRunIri,
  portfolioRunIri,
  batchRunIri,
  options = {},
) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail('S5_CANONICAL_ROW_COUNT', 'the locked S5 slice must select exactly one historical row');
  }
  const row = rows[0];
  const required = [
    'account_logical_iri',
    'available_from', 'currency', 'instrument_id', 'instrument_version_iri',
    'instrument_logical_iri', 'internal_id', 'isin', 'knowledge_from',
    'listing_business_from', 'listing_facility_version_iri',
    'listing_identifier_scheme_logical_iri', 'listing_identifier_value_logical_iri',
    'listing_version_iri', 'membership_closure_version_iri', 'price', 'price_scale',
    'market_source_artifact_digest', 'market_source_locator_iri',
    'membership_approval_digest', 'membership_approval_ref',
    'membership_closure_probe_digest', 'membership_closure_probe_ref',
    'ordering_transform_digest', 'ordering_transform_ref',
    'portfolio_logical_iri',
    'portfolio_observation_completeness_contract_digest',
    'portfolio_observation_completeness_contract_ref',
    'portfolio_observation_pagination_contract_digest',
    'portfolio_observation_pagination_contract_ref',
    'portfolio_observation_source_artifact_digest',
    'portfolio_observation_source_artifact_ref',
    'portfolio_observation_source_contract_digest',
    'portfolio_observation_source_contract_ref',
    'portfolio_observation_source_locator_iri',
    'portfolio_observation_stream_id',
    'portfolio_observation_stream_logical_iri',
    'portfolio_observation_stream_version_iri',
    'position_source_kind_iri',
    'provider_iri', 'provider_observation_id', 'provider_stream_id',
    'quotation_contract_version_iri', 'quotation_currency_iri',
    'quotation_denominator_unit', 'revision', 'source', 'source_contract_digest',
    'source_contract_ref',
    'source_order_key', 'holding_quantity', 'holding_quantity_precision',
    'holding_quantity_rounding', 'holding_quantity_unit',
    'holding_snapshot_id', 'holding_source_artifact_digest',
    'holding_source_artifact_ref', 'holding_source_locator_iri',
    'conversion_context_digest', 'conversion_context_ref',
    'reporting_currency_iri', 'valid_from', 'valuation_definition_version_iri',
    'valuation_formula_digest', 'valuation_formula_ref', 'valuation_input_contract_digest',
    'valuation_input_context_digest', 'valuation_input_context_ref',
    'valuation_output_contract_digest', 'valuation_precision_policy_digest',
    'valuation_precision_policy_ref', 'valuation_rounding_policy_digest',
    'valuation_rounding_policy_ref', 'valuation_runtime_digest',
    'valuation_tool_lock_digest', 'valuation_tool_lock_ref',
    'valuation_pit_request_digest', 'valuation_pit_request_ref',
    'valuation_run_id',
  ];
  for (const field of required) {
    if (row[field] === undefined || row[field] === null || row[field] === '') {
      fail('S5_CANONICAL_SOURCE_FIELD', `source row is missing ${field}`);
    }
  }
  const valuationPolicy = lockedValuationPolicy(row, options);
  if (row.instrument_logical_iri
      !== logicalIriFromVersion(row.instrument_version_iri, 'instrument_version_iri')) {
    fail(
      'S5_CANONICAL_INSTRUMENT_IDENTITY',
      'instrument logical IRI does not equal the stable anchor of its exact version',
    );
  }
  if (row.quotation_denominator_unit !== row.holding_quantity_unit) {
    fail(
      'S5_CANONICAL_QUOTATION_UNIT',
      'holding Quantity unit does not equal the exact quotation denominator unit',
    );
  }
  if (row.quotation_currency_iri !== row.reporting_currency_iri
      || row.quotation_currency_iri
        !== `https://axiolune.ai/data/finance/foundation/currency/${row.currency}`) {
    fail(
      'S5_CANONICAL_QUOTATION_CURRENCY',
      'price, quotation, and reporting currency truths are not identical',
    );
  }
  const statements = [];
  // The current batch materializer must never invent prerequisite M1 facts.
  // Support triples are emitted only by the separately invoked, byte-locked
  // upstream producer path below.
  const support = options.emitPriorSupport === true ? [] : null;
  const schemeLogicalIri = 'https://axiolune.ai/data/finance/foundation/identifier-scheme/isin';
  const identifier = emitFactVersion(statements, {
    contract: CONTRACTS.ISINValue,
    domainTypes: [`${FOUNDATION}ISINValue`, `${FOUNDATION}IdentifierValue`],
    logicalTerms: {
      schemeLogicalIri: iriTerm(schemeLogicalIri),
      canonicalLexicalValue: typedTerm(row.isin, `${FOUNDATION}ISIN`),
    },
    row,
    runIri: identityRunIri,
    graph: IDENTITY_GRAPH_IRI,
  });
  addLiteral(statements, identifier.versionIri, `${FOUNDATION}isinLexicalValue`, row.isin, `${FOUNDATION}ISIN`, IDENTITY_GRAPH_IRI);
  addIri(statements, identifier.versionIri, `${FOUNDATION}identifierValueScheme`, schemeLogicalIri, IDENTITY_GRAPH_IRI);
  if (support) {
    addType(support, schemeLogicalIri, FACT_IDENTITY, SUPPORT_GRAPH_IRI);
    addType(support, schemeLogicalIri, `${FOUNDATION}IdentifierScheme/LogicalIdentity`, SUPPORT_GRAPH_IRI);
  }
  const stream = emitFactVersion(statements, {
    contract: CONTRACTS.MarketDataStream,
    domainTypes: [`${MARKET_DATA}MarketDataStream`],
    logicalTerms: {
      providerLogicalIri: iriTerm(row.provider_iri),
      sourceContractRef: iriTerm(row.source_contract_ref),
      providerStreamId: typedTerm(row.provider_stream_id, `${XSD}string`),
    },
    row,
    runIri: marketRunIri,
    graph: MARKET_GRAPH_IRI,
  });
  const observation = emitFactVersion(statements, {
    contract: CONTRACTS.PriceObservation,
    domainTypes: [`${MARKET_DATA}PriceObservation`],
    logicalTerms: {
      observationStreamLogicalIri: iriTerm(stream.logicalIri),
      providerObservationId: typedTerm(row.provider_observation_id, `${XSD}string`),
    },
    row,
    runIri: marketRunIri,
    graph: MARKET_GRAPH_IRI,
  });

  const locator = 'urn:axiolune:source-locator:slice-a:observation-id';
  addLiteral(statements, stream.versionIri, `${MARKET_DATA}providerStreamId`, row.provider_stream_id, `${XSD}string`, MARKET_GRAPH_IRI);
  addLiteral(statements, stream.versionIri, `${MARKET_DATA}sourceContractRef`, row.source_contract_ref, `${XSD}anyURI`, MARKET_GRAPH_IRI);
  addLiteral(statements, stream.versionIri, `${MARKET_DATA}sourceContractDigest`, row.source_contract_digest, `${XSD}string`, MARKET_GRAPH_IRI);
  addLiteral(statements, stream.versionIri, `${MARKET_DATA}sourceApiIdentifier`, 'market-api', `${XSD}string`, MARKET_GRAPH_IRI);
  addLiteral(statements, stream.versionIri, `${MARKET_DATA}sourceSchemaIdentifier`, 'slice-a-price-record', `${XSD}string`, MARKET_GRAPH_IRI);
  addLiteral(statements, stream.versionIri, `${MARKET_DATA}sourceSchemaVersion`, '1.0', `${XSD}string`, MARKET_GRAPH_IRI);
  addIri(statements, stream.versionIri, `${MARKET_DATA}observationIdFieldLocator`, locator, MARKET_GRAPH_IRI);
  addType(statements, locator, `${META_BINDING}structures/SourceLocator`, MARKET_GRAPH_IRI);
  addLiteral(statements, stream.versionIri, `${MARKET_DATA}orderingTransformRef`, row.ordering_transform_ref, `${XSD}anyURI`, MARKET_GRAPH_IRI);
  addLiteral(statements, stream.versionIri, `${MARKET_DATA}orderingTransformDigest`, row.ordering_transform_digest, `${XSD}string`, MARKET_GRAPH_IRI);
  addIri(statements, stream.versionIri, `${MARKET_DATA}streamPurpose`, `${MARKET_DATA}MarketDataStreamPurpose/value/priceObservation`, MARKET_GRAPH_IRI);
  addType(statements, `${MARKET_DATA}MarketDataStreamPurpose/value/priceObservation`, `${MARKET_DATA}MarketDataStreamPurpose`, MARKET_GRAPH_IRI);
  addIri(statements, stream.versionIri, `${MARKET_DATA}sourceRecordRevisionMode`, `${MARKET_DATA}SourceRecordRevisionMode/value/immutableRecord`, MARKET_GRAPH_IRI);
  addType(statements, `${MARKET_DATA}SourceRecordRevisionMode/value/immutableRecord`, `${MARKET_DATA}SourceRecordRevisionMode`, MARKET_GRAPH_IRI);
  addLiteral(statements, stream.versionIri, `${META_BINDING_ATTRIBUTES}sourceArtifactRef`, row.source, `${XSD}anyURI`, MARKET_GRAPH_IRI);
  addLiteral(statements, stream.versionIri, `${META_BINDING_ATTRIBUTES}sourceArtifactDigest`, row.market_source_artifact_digest, `${XSD}string`, MARKET_GRAPH_IRI);
  addIri(statements, stream.versionIri, `${META_BINDING_ATTRIBUTES}sourceLocator`, row.market_source_locator_iri, MARKET_GRAPH_IRI);
  addType(
    statements,
    row.market_source_locator_iri,
    `${META_BINDING}structures/SourceLocator`,
    MARKET_GRAPH_IRI,
  );
  addIri(statements, stream.versionIri, `${MARKET_DATA}streamProvider`, row.provider_iri, MARKET_GRAPH_IRI);

  const listing = { versionIri: row.listing_version_iri };
  const quotation = { versionIri: row.quotation_contract_version_iri };
  const security = {
    logicalIri: row.instrument_logical_iri,
    versionIri: row.instrument_version_iri,
  };
  if (support) {
  addType(support, row.provider_iri, FACT_IDENTITY, SUPPORT_GRAPH_IRI);
  addType(support, row.provider_iri, `${FOUNDATION}Party/LogicalIdentity`, SUPPORT_GRAPH_IRI);
  const upstreamRun = 'urn:axiolune:run:slice-a:instrument-input-context:v1';
  const producedListing = emitSupportFactVersion(support, {
    graph: SUPPORT_GRAPH_IRI,
    row,
    runIri: upstreamRun,
    targetType: `${INSTRUMENTS}InstrumentListing`,
    versionIri: row.listing_version_iri,
  });
  const producedQuotation = emitSupportFactVersion(support, {
    graph: SUPPORT_GRAPH_IRI,
    row,
    runIri: upstreamRun,
    targetType: `${INSTRUMENTS}DirectUnitPriceQuotationContract`,
    versionIri: row.quotation_contract_version_iri,
  });
  const producedSecurity = emitSupportFactVersion(support, {
    graph: SUPPORT_GRAPH_IRI,
    row,
    runIri: upstreamRun,
    targetType: `${INSTRUMENTS}FinancialInstrument`,
    versionIri: row.instrument_version_iri,
  });
  if (producedSecurity.logicalIri !== row.instrument_logical_iri
      || producedSecurity.versionIri !== security.versionIri
      || producedListing.versionIri !== listing.versionIri
      || producedQuotation.versionIri !== quotation.versionIri) {
    fail(
      'S5_CANONICAL_INSTRUMENT_IDENTITY',
      'support FinancialInstrument version does not resolve to its locked logical IRI',
    );
  }
  addType(support, security.versionIri, `${INSTRUMENTS}Security`, SUPPORT_GRAPH_IRI);
  addType(support, security.versionIri, `${INSTRUMENTS}EquitySecurity`, SUPPORT_GRAPH_IRI);
  const facility = emitSupportFactVersion(support, {
    graph: SUPPORT_GRAPH_IRI,
    row,
    runIri: 'urn:axiolune:run:slice-a:market-structure-input-context:v1',
    targetType: `${MARKET_STRUCTURE}TradingFacility`,
    versionIri: row.listing_facility_version_iri,
  });
  addLogicalReference(
    support,
    SUPPORT_GRAPH_IRI,
    row.listing_identifier_scheme_logical_iri,
    `${FOUNDATION}IdentifierScheme`,
  );
  addLogicalReference(
    support,
    SUPPORT_GRAPH_IRI,
    row.listing_identifier_value_logical_iri,
    `${FOUNDATION}LocalIdentifierValue`,
  );
  addLiteral(
    support,
    listing.versionIri,
    `${INSTRUMENTS}listingBusinessFrom`,
    row.listing_business_from,
    `${XSD}date`,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    listing.versionIri,
    `${INSTRUMENTS}listingFacility`,
    facility.versionIri,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    listing.versionIri,
    `${INSTRUMENTS}listingIdentifierScheme`,
    row.listing_identifier_scheme_logical_iri,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    listing.versionIri,
    `${INSTRUMENTS}listingIdentifierValue`,
    row.listing_identifier_value_logical_iri,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    listing.versionIri,
    `${INSTRUMENTS}listedInstrument`,
    security.versionIri,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    listing.versionIri,
    `${INSTRUMENTS}listingQuoteCurrency`,
    row.quotation_currency_iri,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    quotation.versionIri,
    `${INSTRUMENTS}quotationInstrument`,
    row.instrument_logical_iri,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    quotation.versionIri,
    `${INSTRUMENTS}quotationListingContext`,
    listing.versionIri,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    quotation.versionIri,
    `${INSTRUMENTS}quotationQuoteCurrency`,
    row.quotation_currency_iri,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    quotation.versionIri,
    `${INSTRUMENTS}quotationDenominatorUnit`,
    row.quotation_denominator_unit,
    `${XSD}anyURI`,
    SUPPORT_GRAPH_IRI,
  );
  const quotationKind = `${INSTRUMENTS}QuotationKind/value/directUnitPrice`;
  addIri(
    support,
    quotation.versionIri,
    `${INSTRUMENTS}quotationKind`,
    quotationKind,
    SUPPORT_GRAPH_IRI,
  );
  addType(support, quotationKind, `${INSTRUMENTS}QuotationKind`, SUPPORT_GRAPH_IRI);
  addLiteral(
    support,
    quotation.versionIri,
    `${INSTRUMENTS}contractMultiplier`,
    '1',
    `${XSD}decimal`,
    SUPPORT_GRAPH_IRI,
  );
  for (const [predicate, value, datatype] of [
    [`${INSTRUMENTS}normalizationContractRef`, row.ordering_transform_ref, `${XSD}anyURI`],
    [`${INSTRUMENTS}normalizationContractDigest`, row.ordering_transform_digest, `${XSD}string`],
    [`${META_BINDING_ATTRIBUTES}sourceArtifactRef`, row.source, `${XSD}anyURI`],
    [`${META_BINDING_ATTRIBUTES}sourceArtifactDigest`, row.market_source_artifact_digest, `${XSD}string`],
  ]) {
    addLiteral(support, quotation.versionIri, predicate, value, datatype, SUPPORT_GRAPH_IRI);
  }
  addIri(
    support,
    quotation.versionIri,
    `${META_BINDING_ATTRIBUTES}sourceLocator`,
    row.market_source_locator_iri,
    SUPPORT_GRAPH_IRI,
  );
  addType(
    support,
    row.market_source_locator_iri,
    `${META_BINDING}structures/SourceLocator`,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    listing.versionIri,
    `${META_BINDING_ATTRIBUTES}sourceArtifactRef`,
    row.source,
    `${XSD}anyURI`,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    listing.versionIri,
    `${META_BINDING_ATTRIBUTES}sourceArtifactDigest`,
    row.market_source_artifact_digest,
    `${XSD}string`,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    listing.versionIri,
    `${META_BINDING_ATTRIBUTES}sourceLocator`,
    row.market_source_locator_iri,
    SUPPORT_GRAPH_IRI,
  );
  }

  addIri(statements, observation.versionIri, `${MARKET_DATA}PriceObservation/role/observationStream`, stream.versionIri, MARKET_GRAPH_IRI);
  addIri(statements, observation.versionIri, `${MARKET_DATA}PriceObservation/role/observedInstrument`, security.versionIri, MARKET_GRAPH_IRI);
  addIri(statements, observation.versionIri, `${MARKET_DATA}PriceObservation/role/observedListing`, listing.versionIri, MARKET_GRAPH_IRI);
  addIri(statements, observation.versionIri, `${MARKET_DATA}PriceObservation/role/quotationContract`, quotation.versionIri, MARKET_GRAPH_IRI);
  addLiteral(statements, observation.versionIri, `${MARKET_DATA}providerObservationId`, row.provider_observation_id, `${XSD}string`, MARKET_GRAPH_IRI);
  addLiteral(statements, observation.versionIri, `${MARKET_DATA}sourceOrderKey`, row.source_order_key, `${XSD}integer`, MARKET_GRAPH_IRI);
  addLiteral(statements, observation.versionIri, `${META_PATTERN_ATTRIBUTES}observedAt`, row.valid_from, `${XSD}dateTimeStamp`, MARKET_GRAPH_IRI);
  addIri(statements, observation.versionIri, `${MARKET_DATA}priceKind`, `${MARKET_DATA}PriceKind/value/tick/last`, MARKET_GRAPH_IRI);
  addType(statements, `${MARKET_DATA}PriceKind/value/tick/last`, `${MARKET_DATA}PriceKind`, MARKET_GRAPH_IRI);
  const money = `${observation.versionIri}/value/price`;
  addIri(statements, observation.versionIri, `${MARKET_DATA}priceValue`, money, MARKET_GRAPH_IRI);
  addMoney(
    statements,
    MARKET_GRAPH_IRI,
    money,
    row.price,
    row.currency,
    row.price_scale,
  );

  if (row.currency !== 'USD' || row.reporting_currency_iri
      !== 'https://axiolune.ai/data/finance/foundation/currency/USD') {
    fail(
      'S5_CANONICAL_PORTFOLIO_CURRENCY',
      'the v0.3 S5 slice is the same-currency direct-unit valuation branch',
    );
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(row.holding_quantity)) {
    fail(
      'S5_CANONICAL_HOLDING_QUANTITY',
      'HoldingSnapshot quantity must be a canonical non-negative decimal',
    );
  }

  const holding = emitFactVersion(statements, {
    contract: CONTRACTS.HoldingSnapshot,
    domainTypes: [`${PORTFOLIO}HoldingSnapshot`],
    logicalTerms: {
      observationStreamLogicalIri: iriTerm(row.portfolio_observation_stream_logical_iri),
      snapshotId: typedTerm(row.holding_snapshot_id, `${XSD}string`),
    },
    row,
    runIri: portfolioRunIri,
    graph: PORTFOLIO_GRAPH_IRI,
    source: row.holding_source_artifact_ref,
  });
  const holdingQuantity = `${holding.versionIri}/value/quantity`;
  addIri(
    statements,
    holding.versionIri,
    `${PORTFOLIO}HoldingSnapshot/role/holdingObservationStream`,
    row.portfolio_observation_stream_version_iri,
    PORTFOLIO_GRAPH_IRI,
  );
  addIri(
    statements,
    holding.versionIri,
    `${PORTFOLIO}HoldingSnapshot/role/holdingAccount`,
    row.account_logical_iri,
    PORTFOLIO_GRAPH_IRI,
  );
  addIri(
    statements,
    holding.versionIri,
    `${PORTFOLIO}HoldingSnapshot/role/holdingInstrument`,
    row.instrument_logical_iri,
    PORTFOLIO_GRAPH_IRI,
  );
  addIri(
    statements,
    holding.versionIri,
    `${PORTFOLIO}HoldingSnapshot/role/holdingListing`,
    row.listing_version_iri,
    PORTFOLIO_GRAPH_IRI,
  );
  addLiteral(
    statements,
    holding.versionIri,
    `${PORTFOLIO}snapshotId`,
    row.holding_snapshot_id,
    `${XSD}string`,
    PORTFOLIO_GRAPH_IRI,
  );
  addIri(
    statements,
    holding.versionIri,
    `${PORTFOLIO}holdingQuantity`,
    holdingQuantity,
    PORTFOLIO_GRAPH_IRI,
  );
  addQuantity(
    statements,
    PORTFOLIO_GRAPH_IRI,
    holdingQuantity,
    row.holding_quantity,
    row.holding_quantity_unit,
    row.holding_quantity_precision,
    row.holding_quantity_rounding,
  );
  addIri(
    statements,
    holding.versionIri,
    `${PORTFOLIO}positionSourceKind`,
    row.position_source_kind_iri,
    PORTFOLIO_GRAPH_IRI,
  );
  addType(
    statements,
    row.position_source_kind_iri,
    `${PORTFOLIO}PositionSourceKind`,
    PORTFOLIO_GRAPH_IRI,
  );
  addLiteral(
    statements,
    holding.versionIri,
    `${META_BINDING_ATTRIBUTES}sourceArtifactRef`,
    row.holding_source_artifact_ref,
    `${XSD}anyURI`,
    PORTFOLIO_GRAPH_IRI,
  );
  addLiteral(
    statements,
    holding.versionIri,
    `${META_BINDING_ATTRIBUTES}sourceArtifactDigest`,
    row.holding_source_artifact_digest,
    `${XSD}string`,
    PORTFOLIO_GRAPH_IRI,
  );
  addIri(
    statements,
    holding.versionIri,
    `${META_BINDING_ATTRIBUTES}sourceLocator`,
    row.holding_source_locator_iri,
    PORTFOLIO_GRAPH_IRI,
  );
  addType(
    statements,
    row.holding_source_locator_iri,
    `${META_BINDING}structures/SourceLocator`,
    PORTFOLIO_GRAPH_IRI,
  );

  if (support) {
  addLogicalReference(
    support,
    SUPPORT_GRAPH_IRI,
    row.account_logical_iri,
    `${FOUNDATION}FinancialAccount`,
  );
  addLogicalReference(
    support,
    SUPPORT_GRAPH_IRI,
    row.instrument_logical_iri,
    `${INSTRUMENTS}FinancialInstrument`,
  );
  addLogicalReference(
    support,
    SUPPORT_GRAPH_IRI,
    row.portfolio_logical_iri,
    `${PORTFOLIO}Portfolio`,
  );
  addLogicalReference(
    support,
    SUPPORT_GRAPH_IRI,
    row.reporting_currency_iri,
    `${FOUNDATION}Currency`,
  );
  const membershipAuthority = 'https://axiolune.ai/data/finance/foundation/party/portfolio-authority';
  addLogicalReference(
    support,
    SUPPORT_GRAPH_IRI,
    membershipAuthority,
    `${FOUNDATION}Party`,
  );
  const priorRun = 'urn:axiolune:run:slice-a:portfolio-input-context:v1';
  const portfolioObservationStream = emitSupportFactVersion(support, {
    graph: SUPPORT_GRAPH_IRI,
    row,
    runIri: priorRun,
    source: row.portfolio_observation_source_artifact_ref,
    targetType: `${PORTFOLIO}PortfolioObservationStream`,
    versionIri: row.portfolio_observation_stream_version_iri,
  });
  if (portfolioObservationStream.logicalIri !== row.portfolio_observation_stream_logical_iri) {
    fail(
      'S5_CANONICAL_PORTFOLIO_OBSERVATION_STREAM_IDENTITY',
      'portfolio observation stream version does not resolve to its locked logical IRI',
    );
  }
  addIri(
    support,
    portfolioObservationStream.versionIri,
    `${PORTFOLIO}portfolioObservationStreamProvider`,
    row.provider_iri,
    SUPPORT_GRAPH_IRI,
  );
  for (const [predicate, value, datatype] of [
    [`${PORTFOLIO}portfolioObservationStreamId`, row.portfolio_observation_stream_id, `${XSD}string`],
    [
      `${PORTFOLIO}portfolioObservationSourceContractRef`,
      row.portfolio_observation_source_contract_ref,
      `${XSD}anyURI`,
    ],
    [
      `${PORTFOLIO}portfolioObservationSourceContractDigest`,
      row.portfolio_observation_source_contract_digest,
      `${XSD}string`,
    ],
    [
      `${PORTFOLIO}portfolioObservationCompletenessContractRef`,
      row.portfolio_observation_completeness_contract_ref,
      `${XSD}anyURI`,
    ],
    [
      `${PORTFOLIO}portfolioObservationCompletenessContractDigest`,
      row.portfolio_observation_completeness_contract_digest,
      `${XSD}string`,
    ],
    [
      `${PORTFOLIO}portfolioObservationPaginationContractRef`,
      row.portfolio_observation_pagination_contract_ref,
      `${XSD}anyURI`,
    ],
    [
      `${PORTFOLIO}portfolioObservationPaginationContractDigest`,
      row.portfolio_observation_pagination_contract_digest,
      `${XSD}string`,
    ],
    [
      `${META_BINDING_ATTRIBUTES}sourceArtifactRef`,
      row.portfolio_observation_source_artifact_ref,
      `${XSD}anyURI`,
    ],
    [
      `${META_BINDING_ATTRIBUTES}sourceArtifactDigest`,
      row.portfolio_observation_source_artifact_digest,
      `${XSD}string`,
    ],
  ]) {
    addLiteral(
      support,
      portfolioObservationStream.versionIri,
      predicate,
      value,
      datatype,
      SUPPORT_GRAPH_IRI,
    );
  }
  addIri(
    support,
    portfolioObservationStream.versionIri,
    `${META_BINDING_ATTRIBUTES}sourceLocator`,
    row.portfolio_observation_source_locator_iri,
    SUPPORT_GRAPH_IRI,
  );
  addType(
    support,
    row.portfolio_observation_source_locator_iri,
    `${META_BINDING}structures/SourceLocator`,
    SUPPORT_GRAPH_IRI,
  );
  const membershipVersion = 'https://axiolune.ai/data/finance/portfolio-positions/membership/acme-account/version/locked';
  const membership = emitSupportFactVersion(support, {
    graph: SUPPORT_GRAPH_IRI,
    row,
    runIri: priorRun,
    source: row.holding_source_artifact_ref,
    targetType: `${PORTFOLIO}PortfolioAccountMembership`,
    versionIri: membershipVersion,
  });
  addIri(
    support,
    membership.versionIri,
    `${PORTFOLIO}PortfolioAccountMembership/role/membershipPortfolio`,
    row.portfolio_logical_iri,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    membership.versionIri,
    `${PORTFOLIO}PortfolioAccountMembership/role/memberAccount`,
    row.account_logical_iri,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    membership.versionIri,
    `${PORTFOLIO}PortfolioAccountMembership/role/membershipAuthority`,
    membershipAuthority,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    membership.versionIri,
    `${PORTFOLIO}membershipId`,
    'ACME-ACCOUNT-MEMBERSHIP',
    `${XSD}string`,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    membership.versionIri,
    `${PORTFOLIO}authorityScope`,
    'synthetic-slice-a',
    `${XSD}string`,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    membership.versionIri,
    `${PORTFOLIO}approvalRef`,
    row.membership_approval_ref,
    `${XSD}anyURI`,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    membership.versionIri,
    `${PORTFOLIO}approvalDigest`,
    row.membership_approval_digest,
    `${XSD}string`,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    membership.versionIri,
    `${META_BINDING_ATTRIBUTES}sourceArtifactRef`,
    row.holding_source_artifact_ref,
    `${XSD}anyURI`,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    membership.versionIri,
    `${META_BINDING_ATTRIBUTES}sourceArtifactDigest`,
    row.holding_source_artifact_digest,
    `${XSD}string`,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    membership.versionIri,
    `${META_BINDING_ATTRIBUTES}sourceLocator`,
    row.holding_source_locator_iri,
    SUPPORT_GRAPH_IRI,
  );

  const membershipClosure = emitSupportFactVersion(support, {
    graph: SUPPORT_GRAPH_IRI,
    row,
    runIri: priorRun,
    source: row.membership_closure_probe_ref,
    targetType: `${PORTFOLIO}PortfolioAccountMembershipClosure`,
    versionIri: row.membership_closure_version_iri,
  });
  addIri(
    support,
    membershipClosure.versionIri,
    `${PORTFOLIO}PortfolioAccountMembershipClosure/role/closurePortfolio`,
    row.portfolio_logical_iri,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    membershipClosure.versionIri,
    `${PORTFOLIO}PortfolioAccountMembershipClosure/role/closedMembership`,
    membership.versionIri,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    membershipClosure.versionIri,
    `${PORTFOLIO}membershipVersionSetDigest`,
    iriSetDigest([membership.versionIri]),
    `${XSD}string`,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    membershipClosure.versionIri,
    `${PORTFOLIO}membershipCount`,
    1,
    `${XSD}integer`,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    membershipClosure.versionIri,
    `${PORTFOLIO}membershipClosureProbeRef`,
    row.membership_closure_probe_ref,
    `${XSD}anyURI`,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    membershipClosure.versionIri,
    `${PORTFOLIO}membershipClosureProbeDigest`,
    row.membership_closure_probe_digest,
    `${XSD}string`,
    SUPPORT_GRAPH_IRI,
  );
  for (const [predicate, value, datatype] of [
    [`${META_BINDING_ATTRIBUTES}pitRequestRef`, row.valuation_pit_request_ref, `${XSD}anyURI`],
    [`${META_BINDING_ATTRIBUTES}pitRequestRecordDigest`, row.valuation_pit_request_digest, `${XSD}string`],
    [`${META_BINDING_ATTRIBUTES}inputContextRef`, row.valuation_input_context_ref, `${XSD}anyURI`],
    [`${META_BINDING_ATTRIBUTES}inputContextRecordDigest`, row.valuation_input_context_digest, `${XSD}string`],
  ]) {
    addLiteral(support, membershipClosure.versionIri, predicate, value, datatype, SUPPORT_GRAPH_IRI);
  }

  const valuationDefinition = emitSupportFactVersion(support, {
    graph: SUPPORT_GRAPH_IRI,
    row,
    runIri: priorRun,
    source: row.valuation_formula_ref,
    targetType: `${PORTFOLIO}ValuationCalculationDefinition`,
    versionIri: row.valuation_definition_version_iri,
  });
  const valuationMethod = `${PORTFOLIO}ValuationMethod/value/directUnitPriceTimesQuantity`;
  addIri(
    support,
    valuationDefinition.versionIri,
    `${PORTFOLIO}valuationDefinitionAuthority`,
    membershipAuthority,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    valuationDefinition.versionIri,
    `${PORTFOLIO}valuationDefinitionQuotationContract`,
    row.quotation_contract_version_iri,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    valuationDefinition.versionIri,
    `${PORTFOLIO}valuationQuotationContractCount`,
    1,
    `${XSD}integer`,
    SUPPORT_GRAPH_IRI,
  );
  addLiteral(
    support,
    valuationDefinition.versionIri,
    `${PORTFOLIO}valuationQuotationContractVersionSetDigest`,
    iriSetDigest([row.quotation_contract_version_iri]),
    `${XSD}string`,
    SUPPORT_GRAPH_IRI,
  );
  addIri(
    support,
    valuationDefinition.versionIri,
    `${PORTFOLIO}valuationMethod`,
    valuationMethod,
    SUPPORT_GRAPH_IRI,
  );
  addType(support, valuationMethod, `${PORTFOLIO}ValuationMethod`, SUPPORT_GRAPH_IRI);
  addLiteral(
    support,
    valuationDefinition.versionIri,
    `${PORTFOLIO}valuationDefinitionId`,
    'direct-unit-price-times-quantity-v1',
    `${XSD}string`,
    SUPPORT_GRAPH_IRI,
  );
  for (const [predicate, value, datatype] of [
    [`${PORTFOLIO}formulaDigest`, row.valuation_formula_digest, `${XSD}string`],
    [`${PORTFOLIO}inputContractDigest`, row.valuation_input_contract_digest, `${XSD}string`],
    [`${PORTFOLIO}outputContractDigest`, row.valuation_output_contract_digest, `${XSD}string`],
    [`${PORTFOLIO}precisionPolicyRef`, row.valuation_precision_policy_ref, `${XSD}anyURI`],
    [`${PORTFOLIO}precisionPolicyDigest`, row.valuation_precision_policy_digest, `${XSD}string`],
    [`${PORTFOLIO}roundingPolicyRef`, row.valuation_rounding_policy_ref, `${XSD}anyURI`],
    [`${PORTFOLIO}roundingPolicyDigest`, row.valuation_rounding_policy_digest, `${XSD}string`],
    [`${PORTFOLIO}toolLockRef`, row.valuation_tool_lock_ref, `${XSD}anyURI`],
    [`${PORTFOLIO}toolLockDigest`, row.valuation_tool_lock_digest, `${XSD}string`],
    [`${PORTFOLIO}runtimeDigest`, row.valuation_runtime_digest, `${XSD}string`],
  ]) {
    addLiteral(support, valuationDefinition.versionIri, predicate, value, datatype, SUPPORT_GRAPH_IRI);
  }
  }

  const valuationHeader = emitFactVersion(statements, {
    contract: CONTRACTS.PortfolioValuation,
    domainTypes: [`${PORTFOLIO}PortfolioValuation`],
    logicalTerms: {
      portfolioLogicalIri: iriTerm(row.portfolio_logical_iri),
      valuationRunId: typedTerm(row.valuation_run_id, `${XSD}string`),
    },
    row,
    runIri: portfolioRunIri,
    graph: PORTFOLIO_GRAPH_IRI,
    source: row.valuation_formula_ref,
  });
  addIri(
    statements,
    valuationHeader.versionIri,
    `${PORTFOLIO}PortfolioValuation/role/valuedPortfolio`,
    row.portfolio_logical_iri,
    PORTFOLIO_GRAPH_IRI,
  );
  addIri(
    statements,
    valuationHeader.versionIri,
    `${PORTFOLIO}PortfolioValuation/role/memberAccountClosure`,
    row.membership_closure_version_iri,
    PORTFOLIO_GRAPH_IRI,
  );
  addIri(
    statements,
    valuationHeader.versionIri,
    `${PORTFOLIO}PortfolioValuation/role/valuationDefinition`,
    row.valuation_definition_version_iri,
    PORTFOLIO_GRAPH_IRI,
  );
  addIri(
    statements,
    valuationHeader.versionIri,
    `${PORTFOLIO}PortfolioValuation/role/reportingCurrency`,
    row.reporting_currency_iri,
    PORTFOLIO_GRAPH_IRI,
  );
  addLiteral(
    statements,
    valuationHeader.versionIri,
    `${PORTFOLIO}valuationRunId`,
    row.valuation_run_id,
    `${XSD}string`,
    PORTFOLIO_GRAPH_IRI,
  );
  for (const [predicate, value, datatype] of [
    [`${PORTFOLIO}conversionContextRef`, row.conversion_context_ref, `${XSD}anyURI`],
    [`${PORTFOLIO}conversionContextDigest`, row.conversion_context_digest, `${XSD}string`],
    [`${META_BINDING_ATTRIBUTES}pitRequestRef`, row.valuation_pit_request_ref, `${XSD}anyURI`],
    [`${META_BINDING_ATTRIBUTES}pitRequestRecordDigest`, row.valuation_pit_request_digest, `${XSD}string`],
    [`${META_BINDING_ATTRIBUTES}inputContextRef`, row.valuation_input_context_ref, `${XSD}anyURI`],
    [`${META_BINDING_ATTRIBUTES}inputContextRecordDigest`, row.valuation_input_context_digest, `${XSD}string`],
  ]) {
    addLiteral(statements, valuationHeader.versionIri, predicate, value, datatype, PORTFOLIO_GRAPH_IRI);
  }

  const positionValuation = emitFactVersion(statements, {
    contract: CONTRACTS.PositionValuation,
    domainTypes: [`${PORTFOLIO}PositionValuation`],
    logicalTerms: {
      valuationHeaderVersionIri: iriTerm(valuationHeader.versionIri),
      inputSnapshotVersionIri: iriTerm(holding.versionIri),
    },
    row,
    runIri: portfolioRunIri,
    graph: PORTFOLIO_GRAPH_IRI,
    source: row.valuation_formula_ref,
  });
  addIri(
    statements,
    positionValuation.versionIri,
    `${PORTFOLIO}PositionValuation/role/valuationHeader`,
    valuationHeader.versionIri,
    PORTFOLIO_GRAPH_IRI,
  );
  addIri(
    statements,
    positionValuation.versionIri,
    `${PORTFOLIO}PositionValuation/role/valuedHoldingSnapshot`,
    holding.versionIri,
    PORTFOLIO_GRAPH_IRI,
  );
  addIri(
    statements,
    positionValuation.versionIri,
    `${PORTFOLIO}PositionValuation/role/valuationPrice`,
    observation.versionIri,
    PORTFOLIO_GRAPH_IRI,
  );
  const marketValueOutput = canonicalDirectUnitPriceTimesQuantity({
    precisionPolicyDigest: row.valuation_precision_policy_digest,
    precisionPolicyRef: row.valuation_precision_policy_ref,
    price: row.price,
    priceScale: row.price_scale,
    quantity: row.holding_quantity,
    quantityPrecision: row.holding_quantity_precision,
    quantityRounding: row.holding_quantity_rounding,
    reportingCurrency: row.reporting_currency_iri,
    roundingPolicyDigest: row.valuation_rounding_policy_digest,
    roundingPolicyRef: row.valuation_rounding_policy_ref,
  }, valuationPolicy);
  const marketValue = `${positionValuation.versionIri}/value/market-value`;
  addIri(
    statements,
    positionValuation.versionIri,
    `${PORTFOLIO}marketValue`,
    marketValue,
    PORTFOLIO_GRAPH_IRI,
  );
  addMoney(
    statements,
    PORTFOLIO_GRAPH_IRI,
    marketValue,
    marketValueOutput.amount,
    marketValueOutput.currency,
    marketValueOutput.scale,
  );

  addIri(statements, IDENTITY_GRAPH_IRI, 'http://www.w3.org/ns/prov#wasGeneratedBy', batchRunIri, PROVENANCE_GRAPH_IRI);
  addIri(statements, MARKET_GRAPH_IRI, 'http://www.w3.org/ns/prov#wasGeneratedBy', batchRunIri, PROVENANCE_GRAPH_IRI);
  addIri(statements, PORTFOLIO_GRAPH_IRI, 'http://www.w3.org/ns/prov#wasGeneratedBy', batchRunIri, PROVENANCE_GRAPH_IRI);
  addIri(statements, batchRunIri, 'http://www.w3.org/ns/prov#used', row.source, PROVENANCE_GRAPH_IRI);

  const nquads = writerBytes(statements, options.reverse === true);
  const result = {
    nquads,
    graphIris: [
      IDENTITY_GRAPH_IRI,
      MARKET_GRAPH_IRI,
      PORTFOLIO_GRAPH_IRI,
      PROVENANCE_GRAPH_IRI,
    ],
    memberGraphIris: [IDENTITY_GRAPH_IRI, MARKET_GRAPH_IRI, PORTFOLIO_GRAPH_IRI],
    targetDataset: TARGET_DATASET_IRI,
    identities: {
      holding,
      identifier,
      observation,
      positionValuation,
      security,
      stream,
      valuationHeader,
    },
  };
  if (support) result.supportNquads = writerBytes(support, options.reverse === true);
  validateCanonicalFactVersions(nquads, new Map([
    [IDENTITY_GRAPH_IRI, identityRunIri],
    [MARKET_GRAPH_IRI, marketRunIri],
    [PORTFOLIO_GRAPH_IRI, portfolioRunIri],
  ]));
  return result;
}

function materializeHistoricalDataset(
  rows,
  identityRunIri,
  marketRunIri,
  portfolioRunIri,
  batchRunIri,
  options = {},
) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some((key) => ![
        'reverse', 'valuationPolicyArtifacts',
      ].includes(key))
      || (Object.hasOwn(options, 'reverse') && typeof options.reverse !== 'boolean')
      || Object.hasOwn(options, 'emitPriorSupport')) {
    fail(
      'S5_CANONICAL_SUPPORT_SCOPE',
      'current-batch materializer options are closed and cannot enable prior-support synthesis',
    );
  }
  return materializeHistoricalDatasetInternal(
    rows,
    identityRunIri,
    marketRunIri,
    portfolioRunIri,
    batchRunIri,
    { ...options, emitPriorSupport: false },
  );
}

function materializePriorSupportDataset(rows, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some((key) => key !== 'valuationPolicyArtifacts')
      || Object.hasOwn(options, 'emitPriorSupport')) {
    fail('S5_CANONICAL_SUPPORT_SCOPE', 'upstream producer options are closed');
  }
  const produced = materializeHistoricalDatasetInternal(
    rows,
    'urn:axiolune:discarded-run:slice-a:identity',
    'urn:axiolune:discarded-run:slice-a:market-data',
    'urn:axiolune:discarded-run:slice-a:portfolio',
    'urn:axiolune:discarded-run:slice-a:batch',
    { ...options, emitPriorSupport: true },
  );
  return Object.freeze({
    graphIri: SUPPORT_GRAPH_IRI,
    nquads: produced.supportNquads,
  });
}

function datasetObjects(dataset, subject, predicate, graph) {
  return dataset.filter((statement) => (
    statement.subject.termType === 'NamedNode'
      && statement.subject.value === subject
      && statement.predicate.value === predicate
      && statement.graph.termType === 'NamedNode'
      && statement.graph.value === graph
  )).map((statement) => statement.object);
}

function factRows(nquads) {
  const dataset = rdfCanonize.NQuads.parse(nquads);
  const rows = [];
  for (const statement of dataset) {
    if (statement.predicate.value !== RDF_TYPE
        || statement.object.termType !== 'NamedNode'
        || statement.object.value !== FACT_VERSION
        || statement.subject.termType !== 'NamedNode'
        || statement.graph.termType !== 'NamedNode') continue;
    rows.push({ subject: statement.subject.value, graph: statement.graph.value, dataset });
  }
  return rows;
}

function validateCanonicalFactVersions(nquads, expectedRuns) {
  if (PROHIBITED_IRIS.some((iri) => nquads.includes(iri))) {
    fail('S5_CANONICAL_PROHIBITED_IRI', 'output contains a temporary or superseded ontology IRI');
  }
  const rows = factRows(nquads);
  const expectedFactCount = Object.keys(TARGETS).length;
  if (rows.length !== expectedFactCount) {
    fail(
      'S5_CANONICAL_FACT_COUNT',
      `expected ${expectedFactCount} output FactVersions, found ${rows.length}`,
    );
  }
  const seen = new Set();
  const seenTargets = new Set();
  for (const { subject, graph, dataset } of rows) {
    const key = `${graph}\0${subject}`;
    if (seen.has(key)) fail('S5_CANONICAL_FACT_DUPLICATE', subject);
    seen.add(key);
    const types = new Set(datasetObjects(dataset, subject, RDF_TYPE, graph).map((term) => term.value));
    const targetTypes = Object.keys(TARGETS).filter((candidate) => types.has(candidate));
    if (targetTypes.length !== 1) {
      fail(
        'S5_CANONICAL_TARGET_TYPE',
        `${subject} must have exactly one allowed actual M2 target type`,
      );
    }
    const [targetType] = targetTypes;
    if (seenTargets.has(targetType)) {
      fail('S5_CANONICAL_TARGET_DUPLICATE', `more than one ${targetType} was materialized`);
    }
    seenTargets.add(targetType);
    if (TARGETS[targetType].targetGraph !== graph) {
      fail(
        'S5_CANONICAL_TARGET_GRAPH',
        `${subject} is in ${graph}, expected ${TARGETS[targetType].targetGraph}`,
      );
    }
    const versionOf = datasetObjects(dataset, subject, VERSION_OF, graph);
    if (versionOf.length !== 1 || versionOf[0].termType !== 'NamedNode') {
      fail('S5_CANONICAL_VERSION_OF', `${subject} must have exactly one IRI versionOf value`);
    }
    const anchor = versionOf[0].value;
    const anchorTypes = new Set(datasetObjects(dataset, anchor, RDF_TYPE, graph).map((term) => term.value));
    if (!anchorTypes.has(FACT_IDENTITY) || !anchorTypes.has(TARGETS[targetType].logicalType)) {
      fail('S5_CANONICAL_FACT_IDENTITY', `${subject} versionOf anchor lacks exact FactIdentity/domain logical types`);
    }
    const expected = [
      [VALID_FROM, `${XSD}dateTimeStamp`],
      [KNOWLEDGE_FROM, `${XSD}dateTimeStamp`],
      [AVAILABLE_FROM, `${XSD}dateTimeStamp`],
      [REVISION, `${XSD}nonNegativeInteger`],
      [SOURCE, `${XSD}anyURI`],
      [GENERATING_CONTEXT, `${XSD}anyURI`],
    ];
    for (const [predicate, datatype] of expected) {
      const values = datasetObjects(dataset, subject, predicate, graph);
      if (values.length !== 1 || values[0].termType !== 'Literal' || values[0].datatype.value !== datatype) {
        fail('S5_CANONICAL_REQUIRED_FIELD', `${subject} must have exactly one ${predicate} typed ${datatype}`);
      }
    }
    const run = datasetObjects(dataset, subject, GENERATING_CONTEXT, graph)[0].value;
    if (expectedRuns.get(graph) !== run) {
      fail('S5_CANONICAL_GENERATING_CONTEXT', `${subject} generatingContextRef does not equal its MaterializationRun IRI`);
    }
    const versionLexical = subject.slice(subject.lastIndexOf('/version/'));
    if (!/^\/version\/sha256-[0-9a-f]{64}$/u.test(versionLexical)) {
      fail('S5_CANONICAL_VERSION_IRI', `${subject} does not use the RFC-001 identity-key version IRI template`);
    }
  }
  if (seenTargets.size !== expectedFactCount) {
    fail('S5_CANONICAL_TARGET_COVERAGE', 'the exact six-target materialization inventory is incomplete');
  }
  return rows;
}

function countFactVersionsInGraph(nquads, graphIri, runIri) {
  const dataset = rdfCanonize.NQuads.parse(nquads);
  const subjects = new Set(dataset.filter((statement) => (
    statement.graph.termType === 'NamedNode'
      && statement.graph.value === graphIri
      && statement.predicate.value === RDF_TYPE
      && statement.object.termType === 'NamedNode'
      && statement.object.value === FACT_VERSION
  )).map((statement) => statement.subject.value));
  for (const subject of subjects) {
    const values = datasetObjects(dataset, subject, GENERATING_CONTEXT, graphIri);
    if (values.length !== 1 || values[0].termType !== 'Literal'
        || values[0].datatype.value !== `${XSD}anyURI` || values[0].value !== runIri) {
      fail('S5_CANONICAL_GENERATING_CONTEXT', `${subject} does not bind exactly one requested run`);
    }
  }
  return subjects.size;
}

function evaluatePitSelection(nquads, pivots) {
  const thresholds = {
    [VALID_FROM]: Date.parse(pivots.asOfValid),
    [KNOWLEDGE_FROM]: Date.parse(pivots.asOfKnowledge),
    [AVAILABLE_FROM]: Date.parse(pivots.asOfAvailable),
  };
  if (Object.values(thresholds).some((value) => !Number.isFinite(value))) {
    fail('S5_CANONICAL_PIT_PIVOT', 'PIT pivots must be valid instants');
  }
  const rows = factRows(nquads);
  const selectedFactVersionIris = [];
  for (const { subject, graph, dataset } of rows) {
    let eligible = true;
    for (const [predicate, threshold] of Object.entries(thresholds)) {
      const values = datasetObjects(dataset, subject, predicate, graph);
      if (values.length !== 1 || !Number.isFinite(Date.parse(values[0].value))) {
        fail('S5_CANONICAL_PIT_FACT_TIME', `${subject} has an invalid ${predicate}`);
      }
      if (Date.parse(values[0].value) > threshold) eligible = false;
    }
    if (eligible) selectedFactVersionIris.push(subject);
  }
  selectedFactVersionIris.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return Object.freeze({
    selectedFactVersionCount: selectedFactVersionIris.length,
    selectedFactVersionIris,
    selectedFactVersionSetDigest: taggedJcsDigest(
      'axiolune-pit-selected-fact-version-set-v1\0',
      { selectedFactVersionIris },
    ),
  });
}

module.exports = {
  AVAILABLE_FROM,
  CONTRACTS,
  FACT_IDENTITY,
  FACT_VERSION,
  GENERATING_CONTEXT,
  IDENTITY_GRAPH_IRI,
  KNOWLEDGE_FROM,
  MARKET_GRAPH_IRI,
  PORTFOLIO_GRAPH_IRI,
  PROVENANCE_GRAPH_IRI,
  REVISION,
  SOURCE,
  SUPPORT_GRAPH_IRI,
  S5CanonicalMaterializationError,
  TARGET_DATASET_IRI,
  TRANSFORMATION_REFS,
  VALID_FROM,
  VERSION_COMPONENTS,
  VERSION_OF,
  countFactVersionsInGraph,
  executeCanonicalTransformation,
  evaluatePitSelection,
  materializeHistoricalDataset,
  materializePriorSupportDataset,
  validateCanonicalFactVersions,
};
