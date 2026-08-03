'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const YAML = require('yaml');
const {
  compareDecimalLexical,
  isDecimalLexical,
  parseDecimalLexical,
} = require('./decimal-lexical.cjs');
const {
  loadQuantityUnitRegistry,
  quantityUnitForApplication,
} = require('./strategy-research-quantity-units.cjs');
const {
  validateSourceArtifactEvidence,
} = require('./market-data-release-evidence.cjs');
const {
  canonicalJcs,
} = require('./strict-source-locator.cjs');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ABSOLUTE_IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;
const UTC_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const TEMPORAL_PATTERN = 'https://axiolune.ai/ontology/meta/patterns/TemporalFact';
const PROVENANCE_PATTERN = 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact';
const EXACT_REF = 'https://axiolune.ai/ontology/meta/core/constraints/ExactVersionReference';
const LOGICAL_REF = 'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference';
const BASE = 'https://axiolune.ai/ontology/finance/strategy-research/';

let quantityUnitRegistryIndex = null;

function controlledQuantityUnits() {
  if (quantityUnitRegistryIndex === null) {
    quantityUnitRegistryIndex = loadQuantityUnitRegistry();
  }
  return quantityUnitRegistryIndex;
}

const REQUIRED_IMPORTS = [
  'https://axiolune.ai/ontology/finance/foundation',
  'https://axiolune.ai/ontology/finance/instruments',
  'https://axiolune.ai/ontology/finance/market-data',
  'https://axiolune.ai/ontology/finance/portfolio-positions',
];

const REQUIRED_OBJECTS = [
  'SignalGenerator',
  'FactorDefinition',
  'StrategyDefinition',
  'RunContext',
  'BacktestRun',
  'ResearchRun',
  'MetricDefinition',
  'CalculationContext',
];

const REQUIRED_ASSOCIATIONS = [
  'Signal',
  'FactorObservation',
  'BacktestStatusEvent',
  'PerformanceObservation',
  'PositionAttribution',
];

const REQUIRED_GENERATOR_ATTRIBUTES = [
  'generatorId',
  'generatorName',
  'implementationDigest',
  'inputContractDigest',
  'outputContractDigest',
  'toolLockRef',
  'toolLockDigest',
  'runtimeDigest',
  'sourceArtifactRef',
  'sourceArtifactDigest',
  'sourceLocator',
];

const REQUIRED_RUN_ATTRIBUTES = [
  'runContextId',
  'runContextKind',
  'runStartedAt',
  'parameterSnapshotRef',
  'parameterSnapshotDigest',
  'ontologyClosureDigest',
  'mappingClosureDigest',
  'calendarSnapshotRef',
  'calendarSnapshotDigest',
  'compilerDigest',
  'inputContextRef',
  'inputContextRecordDigest',
  'pitRequestRef',
  'pitRequestRecordDigest',
  'sourceArtifactRef',
  'sourceArtifactDigest',
  'sourceLocator',
];

const REQUIRED_BACKTEST_ATTRIBUTES = [
  'simulationFrom',
  'simulationTo',
  'initialCapital',
  'codeDefinitionDigest',
  'feeAssumptionRef',
  'feeAssumptionDigest',
  'slippageAssumptionRef',
  'slippageAssumptionDigest',
  'fillAssumptionRef',
  'fillAssumptionDigest',
  'benchmarkRef',
  'benchmarkDigest',
  'deterministicSeed',
];

const REQUIRED_RESEARCH_ATTRIBUTES = [
  'researchQuestionRef',
  'researchQuestionDigest',
  'researchDatasetRef',
  'researchDatasetDigest',
  'researchOutputContractDigest',
  'deterministicSeed',
];

const REQUIRED_METRIC_ATTRIBUTES = [
  'metricDefinitionId',
  'metricName',
  'metricValueKind',
  'formulaDigest',
  'implementationDigest',
  'inputContractDigest',
  'outputContractDigest',
  'toolLockRef',
  'toolLockDigest',
  'runtimeDigest',
];

const REQUIRED_CALCULATION_ATTRIBUTES = [
  'calculationContextId',
  'calculationFrequency',
  'calculationImplementationDigest',
  'calculationParameterSnapshotRef',
  'calculationParameterSnapshotDigest',
  'calculationParameterSnapshotLocator',
];

const EXPECTED_QLIB_EVIDENCE = new Map([
  ['reference/project-reference/qlib/docs/advanced/PIT.rst', 'sha256:7f8796a6062e1ab4a335bad65fdcfb96fc6ab1337b3dfd1f6204d50ec3fa29af'],
  ['reference/project-reference/qlib/qlib/data/data.py', 'sha256:cf02f3c2735f532f25c13d6a82e91c8fb6360b507c95bce5934600d892425313'],
  ['reference/project-reference/qlib/qlib/utils/__init__.py', 'sha256:1ad8e68874ed1a0bcfcd03037e5506ab44e567b20b154e2eb7184b97ef39af80'],
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function localName(iri) {
  if (typeof iri !== 'string') return '';
  const slash = iri.lastIndexOf('/');
  const hash = iri.lastIndexOf('#');
  return iri.slice(Math.max(slash, hash) + 1);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function canonicalArrayEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pushViolation(violations, code, at, message) {
  violations.push({ code, at, message });
}

function validateDigest(value, at, violations) {
  if (!DIGEST_RE.test(value || '')) {
    pushViolation(violations, 'DIGEST_FORMAT', at, 'must be a lowercase sha256 digest');
    return false;
  }
  return true;
}

function validateIri(value, at, violations) {
  if (!ABSOLUTE_IRI_RE.test(value || '')) {
    pushViolation(violations, 'IRI_FORMAT', at, 'must be an absolute IRI');
    return false;
  }
  return true;
}

function parseInstant(value) {
  if (!UTC_INSTANT_RE.test(value || '')) return Number.NaN;
  return Date.parse(value);
}

function validateInstant(value, at, violations) {
  const parsed = parseInstant(value);
  if (!Number.isFinite(parsed)) {
    pushViolation(violations, 'INSTANT_FORMAT', at, 'must be an explicit UTC instant ending in Z');
    return Number.NaN;
  }
  return parsed;
}

function validateExactRef(value, at, violations) {
  if (!isObject(value)) {
    pushViolation(violations, 'EXACT_REFERENCE', at, 'must be an exact-version reference object');
    return false;
  }
  let valid = true;
  if (value.referenceMode !== 'version') {
    pushViolation(violations, 'EXACT_REFERENCE', `${at}.referenceMode`, 'must equal version');
    valid = false;
  }
  valid = validateIri(value.logicalIri, `${at}.logicalIri`, violations) && valid;
  valid = validateIri(value.versionIri, `${at}.versionIri`, violations) && valid;
  if (value.logicalIri === value.versionIri) {
    pushViolation(violations, 'EXACT_REFERENCE', at, 'logical and immutable version IRIs must be distinct');
    valid = false;
  }
  return valid;
}

function validateLogicalRef(value, at, violations) {
  if (!isObject(value)) {
    pushViolation(violations, 'LOGICAL_REFERENCE', at, 'must be a logical-reference object');
    return false;
  }
  let valid = true;
  if (value.referenceMode !== 'logical') {
    pushViolation(violations, 'LOGICAL_REFERENCE', `${at}.referenceMode`, 'must equal logical');
    valid = false;
  }
  valid = validateIri(value.logicalIri, `${at}.logicalIri`, violations) && valid;
  if (Object.hasOwn(value, 'versionIri')) {
    pushViolation(violations, 'LOGICAL_REFERENCE', `${at}.versionIri`, 'must be absent on a logical-only reference');
    valid = false;
  }
  return valid;
}

function validateTemporal(value, at, violations) {
  if (!isObject(value)) {
    pushViolation(violations, 'TEMPORAL_REQUIRED', at, 'must contain valid knowledge and availability axes');
    return;
  }
  const starts = {};
  for (const key of ['validFrom', 'knowledgeFrom', 'availableFrom']) {
    starts[key] = validateInstant(value[key], `${at}.${key}`, violations);
  }
  for (const [from, to] of [
    ['validFrom', 'validTo'],
    ['knowledgeFrom', 'knowledgeTo'],
    ['availableFrom', 'availableTo'],
  ]) {
    if (value[to] !== undefined && value[to] !== null) {
      const end = validateInstant(value[to], `${at}.${to}`, violations);
      if (Number.isFinite(starts[from]) && Number.isFinite(end) && starts[from] >= end) {
        pushViolation(violations, 'TEMPORAL_INTERVAL', at, `${from}/${to} must be a non-empty half-open interval`);
      }
    }
  }
  if (!Number.isInteger(value.revision) || value.revision < 0) {
    pushViolation(violations, 'REVISION_FORMAT', `${at}.revision`, 'must be a non-negative integer');
  }
  for (const derivedEnd of ['knowledgeTo', 'availableTo']) {
    if (Object.hasOwn(value, derivedEnd)) {
      pushViolation(
        violations,
        'FACT_VERSION_INLINE_CLOSURE',
        `${at}.${derivedEnd}`,
        'canonical immutable FactVersion payloads use separate closure assertions, not later-mutated end triples',
      );
    }
  }
  for (const forbidden of ['now', 'currentTimestamp', 'CURRENT_TIMESTAMP']) {
    if (Object.values(value).includes(forbidden)) {
      pushViolation(violations, 'IMPLICIT_TIME', at, 'implicit or non-reproducible time values are forbidden');
    }
  }
}

function validateIdentity(identity, logicalKey, temporal, at, violations) {
  if (!isObject(identity)) {
    pushViolation(violations, 'IDENTITY_REQUIRED', at, 'must contain logicalIri versionIri logicalKey and versionKey');
    return;
  }
  validateIri(identity.logicalIri, `${at}.logicalIri`, violations);
  validateIri(identity.versionIri, `${at}.versionIri`, violations);
  if (identity.logicalIri === identity.versionIri) {
    pushViolation(violations, 'IDENTITY_IRI_DISTINCT', at, 'logical and immutable version IRIs must be distinct');
  }
  if (!canonicalArrayEqual(identity.logicalKey, logicalKey)) {
    pushViolation(violations, 'LOGICAL_KEY', `${at}.logicalKey`, `must equal ${JSON.stringify(logicalKey)}`);
  }
  const expectedVersionKey = [
    temporal && temporal.validFrom,
    temporal && temporal.knowledgeFrom,
    temporal && temporal.availableFrom,
    temporal && temporal.revision,
  ];
  if (!canonicalArrayEqual(identity.versionKey, expectedVersionKey)) {
    pushViolation(violations, 'VERSION_KEY', `${at}.versionKey`, `must equal ${JSON.stringify(expectedVersionKey)}`);
  }
}

function validateQuantity(value, at, violations, options = {}) {
  if (!isObject(value)) {
    pushViolation(violations, 'QUANTITY_REQUIRED', at, 'must be a Quantity value object');
    return;
  }
  const expectedFields = ['rounding', 'unit', 'value'];
  const actualFields = Object.keys(value).sort();
  if (!canonicalArrayEqual(actualFields, expectedFields)) {
    pushViolation(violations, 'QUANTITY_SHAPE', at, 'must contain exactly value, unit, and rounding');
  }
  const decimalValid = isDecimalLexical(value.value);
  if (!decimalValid) {
    pushViolation(
      violations,
      'QUANTITY_VALUE',
      `${at}.value`,
      'must be a canonical decimal lexical string without exponent notation, negative zero, or binary floating-point coercion',
    );
  }
  let controlledUnit = null;
  try {
    controlledUnit = quantityUnitForApplication(
      controlledQuantityUnits(),
      value.unit,
      options.application,
    );
  } catch (cause) {
    pushViolation(violations, 'QUANTITY_UNIT_REGISTRY', `${at}.unit`, cause.message);
  }
  if (!controlledUnit) {
    pushViolation(
      violations,
      'QUANTITY_UNIT',
      `${at}.unit`,
      `must be a controlled Strategy/Research Quantity unit allowed for ${String(options.application)}`,
    );
  }
  if (!['floor', 'ceiling', 'half-up', 'half-even'].includes(value.rounding)) {
    pushViolation(violations, 'QUANTITY_ROUNDING', `${at}.rounding`, 'must be an explicit reviewed rounding mode');
  }
  if (decimalValid && options.min !== undefined
      && compareDecimalLexical(value.value, options.min) < 0) {
    pushViolation(violations, 'QUANTITY_RANGE', `${at}.value`, `must be >= ${options.min}`);
  }
  if (decimalValid && options.max !== undefined
      && compareDecimalLexical(value.value, options.max) > 0) {
    pushViolation(violations, 'QUANTITY_RANGE', `${at}.value`, `must be <= ${options.max}`);
  }
  if (decimalValid && options.positive && compareDecimalLexical(value.value, '0') <= 0) {
    pushViolation(violations, 'QUANTITY_RANGE', `${at}.value`, 'must be positive');
  }
}

function validateMoney(value, at, violations) {
  if (!isObject(value)) {
    pushViolation(violations, 'MONEY_REQUIRED', at, 'must be a Money value object');
    return;
  }
  const amountValid = isDecimalLexical(value.amount);
  if (!amountValid) {
    pushViolation(
      violations,
      'MONEY_AMOUNT',
      `${at}.amount`,
      'must be a canonical decimal lexical string without binary floating-point coercion',
    );
  }
  if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/u.test(value.currency)) {
    pushViolation(violations, 'MONEY_CURRENCY', `${at}.currency`, 'must be an ISO 4217 three-letter currency code');
  }
  if (!Number.isInteger(value.scale) || value.scale < 0) {
    pushViolation(violations, 'MONEY_SCALE', `${at}.scale`, 'must be a non-negative integer');
  } else if (amountValid && parseDecimalLexical(value.amount).scale !== value.scale) {
    pushViolation(violations, 'MONEY_SCALE', `${at}.scale`, 'must equal the explicit decimal fractional-digit count');
  }
}

function validatePair(payload, refName, digestName, at, violations) {
  validateIri(payload && payload[refName], `${at}.${refName}`, violations);
  validateDigest(payload && payload[digestName], `${at}.${digestName}`, violations);
}

function validateOptionalPair(payload, refName, digestName, at, violations) {
  const hasRef = isObject(payload) && payload[refName] !== undefined;
  const hasDigest = isObject(payload) && payload[digestName] !== undefined;
  if (!hasRef && !hasDigest) return;
  if (hasRef !== hasDigest) {
    pushViolation(violations, 'REF_DIGEST_PAIR', at, `${refName} and ${digestName} must be supplied together`);
    return;
  }
  validateIri(payload[refName], `${at}.${refName}`, violations);
  validateDigest(payload[digestName], `${at}.${digestName}`, violations);
}

function validateArtifactRef(value, at, violations) {
  if (!isObject(value)) {
    pushViolation(violations, 'ARTIFACT_REFERENCE', at, 'must be a closed ArtifactRef value');
    return;
  }
  if (value.kind === 'iri') {
    validateIri(value.iri, `${at}.iri`, violations);
    return;
  }
  if (value.kind === 'path') {
    if (!['sourceTree', 'buildEvidence', 'payload', 'adoptionEvidence'].includes(value.root)
        || typeof value.path !== 'string'
        || value.path.length === 0
        || value.path.includes('\\')
        || value.path.startsWith('/')
        || value.path.split('/').includes('..')) {
      pushViolation(violations, 'ARTIFACT_REFERENCE', at, 'path ArtifactRef must stay below one reviewed root using a POSIX-relative path');
    }
    return;
  }
  pushViolation(violations, 'ARTIFACT_REFERENCE', `${at}.kind`, 'must equal iri or path');
}

function validateSourceLocator(value, at, violations) {
  if (!isObject(value)) {
    pushViolation(violations, 'SOURCE_LOCATOR', at, 'must be a closed media-aware SourceLocator');
    return;
  }
  if (value.kind !== 'wholeFile') pushViolation(violations, 'SOURCE_LOCATOR', `${at}.kind`, 'fixture profile supports the wholeFile locator only');
  if (typeof value.path !== 'string' || value.path.length === 0 || value.path.includes('\\') || value.path.startsWith('/') || value.path.split('/').includes('..')) {
    pushViolation(violations, 'SOURCE_LOCATOR', `${at}.path`, 'must be a POSIX-relative path without parent traversal');
  }
  if (typeof value.mediaType !== 'string' || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(value.mediaType)) {
    pushViolation(violations, 'SOURCE_LOCATOR', `${at}.mediaType`, 'must be an explicit IANA-style media type');
  }
  validateArtifactRef(value.extractorProfileRef, `${at}.extractorProfileRef`, violations);
  validateDigest(value.extractorProfileDigest, `${at}.extractorProfileDigest`, violations);
  validateDigest(value.selectionDigest, `${at}.selectionDigest`, violations);
}

function hasExactKeys(value, expected) {
  return isObject(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function validateCalculationParameterSnapshotDocument(snapshot, payload, at, violations) {
  const topLevelKeys = [
    'aggregationPolicy',
    'benchmarkPolicy',
    'calculationFrequency',
    'calendarPolicy',
    'missingValuePolicy',
    'returnPolicy',
    'scalarParameters',
    'schemaVersion',
  ];
  if (!hasExactKeys(snapshot, topLevelKeys) || snapshot.schemaVersion !== '1.0') {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_CONTENT', at, 'must use the closed calculation-parameter snapshot v1 schema');
    return;
  }
  if (snapshot.calculationFrequency !== payload.calculationFrequency) {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_MISMATCH', `${at}.calculationFrequency`, 'must equal CalculationContext.calculationFrequency');
  }

  const returnPolicy = snapshot.returnPolicy;
  if (!hasExactKeys(returnPolicy, ['kind']) || !['simple', 'log'].includes(returnPolicy.kind)) {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_CONTENT', `${at}.returnPolicy`, 'return kind must equal simple or log');
  }

  const aggregation = snapshot.aggregationPolicy;
  if (!hasExactKeys(aggregation, ['mode', 'period'])
      || !['compound', 'sum'].includes(aggregation.mode)
      || !['perObservation', 'daily', 'weekly', 'monthly', 'fullRun'].includes(aggregation.period)) {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_CONTENT', `${at}.aggregationPolicy`, 'aggregation must close mode and resample period');
  } else if (aggregation.period !== payload.calculationFrequency) {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_MISMATCH', `${at}.aggregationPolicy.period`, 'must equal CalculationContext.calculationFrequency');
  }

  const missing = snapshot.missingValuePolicy;
  const forbiddenLookAheadMissing = isObject(missing)
    && ['backfillPriceThenZeroReturn', 'backfillFutureObservation', 'backwardFill'].includes(missing.benchmark);
  if (forbiddenLookAheadMissing) {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_LOOKAHEAD', `${at}.missingValuePolicy.benchmark`, 'future-observation/backward fill is forbidden because it leaks later benchmark prices into earlier observations');
  }
  if (!hasExactKeys(missing, ['benchmark', 'input', 'nonFinite'])
      || !['dropPaired', 'zeroFill', 'reject'].includes(missing.benchmark)
      || !['drop', 'zeroFill', 'reject'].includes(missing.input)
      || !['drop', 'reject'].includes(missing.nonFinite)) {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_CONTENT', `${at}.missingValuePolicy`, 'missing and non-finite policies must be explicit reviewed members');
  }

  const calendar = snapshot.calendarPolicy;
  if (!hasExactKeys(calendar, ['resampleAnchor', 'timeZone'])
      || !['observation', 'sessionClose', 'weekMonday', 'monthEnd', 'fullRun'].includes(calendar.resampleAnchor)
      || calendar.timeZone !== 'UTC') {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_CONTENT', `${at}.calendarPolicy`, 'v0.3 calendar policy must close one reviewed resample anchor and use UTC; session calendars/tzdb require a future digest-bound authority');
  } else {
    const anchorForFrequency = {
      perObservation: 'observation',
      daily: 'sessionClose',
      weekly: 'weekMonday',
      monthly: 'monthEnd',
      fullRun: 'fullRun',
    };
    if (calendar.resampleAnchor !== anchorForFrequency[snapshot.calculationFrequency]) {
      pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_ANCHOR', `${at}.calendarPolicy.resampleAnchor`, 'must equal the closed resample anchor for calculationFrequency');
    }
  }

  const benchmark = snapshot.benchmarkPolicy;
  const forbiddenLookAheadAlignment = isObject(benchmark)
    && ['backfillCalendarThenIntersect', 'backfillFutureObservationThenIntersect', 'backwardFillThenIntersect'].includes(benchmark.alignment);
  if (forbiddenLookAheadAlignment) {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_LOOKAHEAD', `${at}.benchmarkPolicy.alignment`, 'future-observation/backward fill is forbidden because it leaks later benchmark prices into earlier observations');
  }
  if (!hasExactKeys(benchmark, ['alignment', 'benchmarkDigest', 'benchmarkRef', 'volatilityMatch'])
      || !['none', 'exactIndexIntersection', 'forwardFillPastObservationThenIntersect'].includes(benchmark.alignment)
      || !['disabled', 'sampleStandardDeviationRatio'].includes(benchmark.volatilityMatch)) {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_CONTENT', `${at}.benchmarkPolicy`, 'benchmark alignment and volatility-match policy must be explicit reviewed members');
  } else {
    const expectedRef = payload.benchmarkRef ?? null;
    const expectedDigest = payload.benchmarkDigest ?? null;
    if (benchmark.benchmarkRef !== expectedRef || benchmark.benchmarkDigest !== expectedDigest) {
      pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_MISMATCH', `${at}.benchmarkPolicy`, 'benchmark ref/digest must equal the CalculationContext pair');
    }
    if (expectedRef === null && (benchmark.alignment !== 'none' || benchmark.volatilityMatch !== 'disabled')) {
      pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_CONTENT', `${at}.benchmarkPolicy`, 'alignment and volatility matching require a benchmark pair');
    }
  }

  const scalars = snapshot.scalarParameters;
  const scalarKeys = ['annualizationFactor', 'calculationWindow', 'confidenceLevel', 'riskFreeRate'];
  if (!hasExactKeys(scalars, scalarKeys)) {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_CONTENT', `${at}.scalarParameters`, 'must close every result-affecting scalar parameter, using null when absent');
  } else {
    for (const field of scalarKeys) {
      let actual;
      let expected;
      try {
        actual = canonicalJcs(scalars[field]);
        expected = canonicalJcs(payload[field] ?? null);
      } catch (error) {
        pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_CONTENT', `${at}.scalarParameters.${field}`, error.message);
        continue;
      }
      if (actual !== expected) {
        pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_MISMATCH', `${at}.scalarParameters.${field}`, `must equal CalculationContext.${field}`);
      }
    }
  }
}

function validateCalculationParameterSnapshotEvidence(payload, at, violations, options = {}) {
  const ref = payload.calculationParameterSnapshotRef;
  const digest = payload.calculationParameterSnapshotDigest;
  const locator = payload.calculationParameterSnapshotLocator;
  const hasRef = ref !== undefined;
  const hasDigest = digest !== undefined;
  const hasLocator = locator !== undefined;
  if (!hasRef && !hasDigest && !hasLocator) return;
  validateArtifactRef(ref, `${at}.calculationParameterSnapshotRef`, violations);
  validateDigest(digest, `${at}.calculationParameterSnapshotDigest`, violations);
  validateSourceLocator(locator, `${at}.calculationParameterSnapshotLocator`, violations);
  if (!hasRef || !hasDigest || !hasLocator) {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_PAIR', at, 'snapshot ref, digest, and locator must be supplied together');
    return;
  }
  if (!isObject(ref) || ref.kind !== 'path' || ref.root !== 'sourceTree' || !isObject(locator)) return;

  let findings;
  try {
    findings = validateSourceArtifactEvidence({
      sourceArtifactDigest: digest,
      sourceArtifactRef: ref,
      sourceLocator: locator,
    }, { at: `${at}.calculationParameterSnapshotEvidence`, repositoryRoot: options.repositoryRoot });
  } catch (error) {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_BYTES', at, error.message);
    return;
  }
  for (const finding of findings) {
    const code = finding.code === 'RELEASE_SOURCE_ARTIFACT'
      ? 'CALCULATION_PARAMETER_SNAPSHOT_DIGEST'
      : 'CALCULATION_PARAMETER_SNAPSHOT_SELECTION';
    pushViolation(violations, code, finding.at, finding.message);
  }
  if (findings.length > 0) return;

  const root = path.resolve(options.repositoryRoot || path.resolve(__dirname, '..', '..', '..'));
  const file = path.resolve(root, ...ref.path.split('/'));
  try {
    const bytes = fs.readFileSync(file);
    const snapshot = JSON.parse(bytes.toString('utf8'));
    const jcs = Buffer.from(canonicalJcs(snapshot), 'utf8');
    const jcsWithLf = Buffer.concat([jcs, Buffer.from('\n', 'utf8')]);
    if (!bytes.equals(jcs) && !bytes.equals(jcsWithLf)) {
      pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_CONTENT', at, 'snapshot bytes must be exact UTF-8 JCS with at most one terminal LF and without duplicate-member ambiguity');
      return;
    }
    validateCalculationParameterSnapshotDocument(snapshot, payload, at, violations);
  } catch (error) {
    pushViolation(violations, 'CALCULATION_PARAMETER_SNAPSHOT_CONTENT', at, `snapshot is not a valid closed JCS document: ${error.message}`);
  }
}

function validateGeneratorDefinition(payload, at = 'payload') {
  const violations = [];
  if (!isObject(payload)) {
    pushViolation(violations, 'PAYLOAD_OBJECT', at, 'must be an object');
    return violations;
  }
  if (!['FactorDefinition', 'StrategyDefinition'].includes(payload.directType)) {
    pushViolation(violations, 'GENERATOR_DIRECT_TYPE', `${at}.directType`, 'SignalGenerator is abstract; direct type must be FactorDefinition or StrategyDefinition');
  }
  validateLogicalRef(payload.authority, `${at}.authority`, violations);
  for (const field of ['generatorId', 'generatorName']) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0) {
      pushViolation(violations, 'GENERATOR_IDENTITY', `${at}.${field}`, 'must be a non-empty NFC string');
    }
  }
  for (const field of ['implementationDigest', 'inputContractDigest', 'outputContractDigest', 'toolLockDigest', 'runtimeDigest']) {
    validateDigest(payload[field], `${at}.${field}`, violations);
  }
  validateIri(payload.toolLockRef, `${at}.toolLockRef`, violations);
  validateArtifactRef(payload.sourceArtifactRef, `${at}.sourceArtifactRef`, violations);
  validateDigest(payload.sourceArtifactDigest, `${at}.sourceArtifactDigest`, violations);
  validateSourceLocator(payload.sourceLocator, `${at}.sourceLocator`, violations);
  for (const finding of validateSourceArtifactEvidence({
    sourceArtifactDigest: payload.sourceArtifactDigest,
    sourceArtifactRef: payload.sourceArtifactRef,
    sourceLocator: payload.sourceLocator,
  }, { at: `${at}.sourceEvidence` })) {
    pushViolation(
      violations,
      'SOURCE_ARTIFACT_EVIDENCE',
      finding.at,
      finding.message,
    );
  }
  if (payload.directType === 'FactorDefinition') {
    validatePair(payload, 'factorExpressionRef', 'factorExpressionDigest', at, violations);
  }
  if (payload.directType === 'StrategyDefinition') {
    const factors = asArray(payload.usesFactors);
    if (factors.length === 0) {
      pushViolation(violations, 'STRATEGY_USES_FACTOR', `${at}.usesFactors`, 'must contain every exact FactorDefinition dependency');
    }
    const seen = new Set();
    factors.forEach((factor, index) => {
      validateExactRef(factor, `${at}.usesFactors[${index}]`, violations);
      if (seen.has(factor && factor.versionIri)) {
        pushViolation(violations, 'STRATEGY_USES_FACTOR', `${at}.usesFactors[${index}]`, 'must not repeat an exact FactorDefinition version');
      }
      seen.add(factor && factor.versionIri);
    });
  }
  validateTemporal(payload.temporal, `${at}.temporal`, violations);
  validateIdentity(
    payload.identity,
    [payload.authority && payload.authority.logicalIri, payload.generatorId],
    payload.temporal,
    `${at}.identity`,
    violations,
  );
  return violations;
}

function validateSignal(payload, at = 'payload') {
  const violations = [];
  if (!isObject(payload)) {
    pushViolation(violations, 'PAYLOAD_OBJECT', at, 'must be an object');
    return violations;
  }
  validateExactRef(payload.generator, `${at}.generator`, violations);
  validateExactRef(payload.instrument, `${at}.instrument`, violations);
  validateExactRef(payload.runContext, `${at}.runContext`, violations);
  if (payload.listing !== undefined) {
    validateExactRef(payload.listing, `${at}.listing`, violations);
    if (payload.listing.listedInstrumentVersionIri !== payload.instrument.versionIri) {
      pushViolation(violations, 'SIGNAL_LISTING_INSTRUMENT', `${at}.listing`, 'listing instrument must equal signal instrument exact version');
    }
  }
  if (!['long', 'short', 'neutral', 'exit'].includes(payload.direction)) {
    pushViolation(violations, 'SIGNAL_DIRECTION', `${at}.direction`, 'must be a reviewed SignalDirection member');
  }
  if (typeof payload.sourceSignalId !== 'string' || payload.sourceSignalId.length === 0) {
    pushViolation(violations, 'SOURCE_SIGNAL_ID', `${at}.sourceSignalId`, 'must be non-empty');
  }
  if (typeof payload.horizon !== 'string' || !/^P(?!$)/.test(payload.horizon)) {
    pushViolation(violations, 'SIGNAL_HORIZON', `${at}.horizon`, 'must be an explicit ISO-8601 duration');
  }
  validateQuantity(payload.strength, `${at}.strength`, violations, {
    application: 'signalStrength', min: '0', max: '1',
  });
  validateTemporal(payload.temporal, `${at}.temporal`, violations);
  validateIdentity(
    payload.identity,
    [payload.generator && payload.generator.logicalIri, payload.runContext && payload.runContext.logicalIri, payload.sourceSignalId],
    payload.temporal,
    `${at}.identity`,
    violations,
  );
  return violations;
}

function validateSignalSet(payload, at = 'payload') {
  const violations = [];
  const signals = asArray(payload && payload.signals);
  if (signals.length === 0) {
    pushViolation(violations, 'SIGNAL_SET_EMPTY', `${at}.signals`, 'must contain at least one signal');
    return violations;
  }
  const identities = new Map();
  signals.forEach((signal, index) => {
    const signalAt = `${at}.signals[${index}]`;
    violations.push(...validateSignal(signal, signalAt));
    const key = JSON.stringify([
      signal.generator && signal.generator.logicalIri,
      signal.runContext && signal.runContext.logicalIri,
      signal.sourceSignalId,
    ]);
    const logicalIri = signal.identity && signal.identity.logicalIri;
    if (identities.has(key) && identities.get(key) !== logicalIri) {
      pushViolation(violations, 'SIGNAL_SOURCE_ID_UNIQUENESS', signalAt, 'same generator/run/source ID maps to multiple logical IRIs');
    } else {
      identities.set(key, logicalIri);
    }
  });
  return violations;
}

function validateFactorFact(payload, at, violations) {
  validateExactRef(payload.factor, `${at}.factor`, violations);
  validateExactRef(payload.instrument, `${at}.instrument`, violations);
  validateExactRef(payload.runContext, `${at}.runContext`, violations);
  if (payload.listing !== undefined) {
    validateExactRef(payload.listing, `${at}.listing`, violations);
    if (payload.listing.listedInstrumentVersionIri !== payload.instrument.versionIri) {
      pushViolation(violations, 'FACTOR_LISTING_INSTRUMENT', `${at}.listing`, 'listing instrument must equal factor instrument exact version');
    }
  }
  if (payload.priorVersion !== undefined) validateExactRef(payload.priorVersion, `${at}.priorVersion`, violations);
  if (typeof payload.sourceFactorId !== 'string' || payload.sourceFactorId.length === 0) {
    pushViolation(violations, 'SOURCE_FACTOR_ID', `${at}.sourceFactorId`, 'must be non-empty');
  }
  if (typeof payload.reportingPeriodKey !== 'string' || payload.reportingPeriodKey.length === 0) {
    pushViolation(violations, 'REPORTING_PERIOD_KEY', `${at}.reportingPeriodKey`, 'must be non-empty');
  }
  for (const forbidden of ['qlibNextPointer', 'sourceStoragePointer', 'sourceByteOffset', '_next', 'nextRevision']) {
    if (Object.hasOwn(payload, forbidden)) {
      pushViolation(violations, 'FACTOR_STORAGE_POINTER', `${at}.${forbidden}`, 'implementation-private storage pointers are not domain revision relations');
    }
  }
  validateQuantity(payload.value, `${at}.value`, violations, { application: 'factorValue' });
  validateTemporal(payload.temporal, `${at}.temporal`, violations);
  const logicalKey = [
    payload.factor && payload.factor.logicalIri,
    payload.instrument && payload.instrument.logicalIri,
    payload.sourceFactorId,
    payload.reportingPeriodKey,
  ];
  validateIdentity(payload.identity, logicalKey, payload.temporal, `${at}.identity`, violations);
  return logicalKey;
}

function validateFactorRevision(payload, at = 'payload') {
  const violations = [];
  if (!isObject(payload) || !isObject(payload.previous) || !isObject(payload.current)) {
    pushViolation(violations, 'FACTOR_REVISION_PAIR', at, 'must contain previous and current factor facts');
    return violations;
  }
  const previousKey = validateFactorFact(payload.previous, `${at}.previous`, violations);
  const currentKey = validateFactorFact(payload.current, `${at}.current`, violations);
  if (!canonicalArrayEqual(previousKey, currentKey)) {
    pushViolation(violations, 'FACTOR_LOGICAL_KEY_DRIFT', at, 'factor revisions must preserve the same logical key');
  }
  if ((payload.current.identity && payload.current.identity.logicalIri) !== (payload.previous.identity && payload.previous.identity.logicalIri)) {
    pushViolation(violations, 'FACTOR_LOGICAL_IRI_DRIFT', at, 'factor revisions must preserve the same logical IRI');
  }
  if (!payload.current.priorVersion
      || payload.current.priorVersion.logicalIri !== (payload.previous.identity && payload.previous.identity.logicalIri)
      || payload.current.priorVersion.versionIri !== (payload.previous.identity && payload.previous.identity.versionIri)) {
    pushViolation(violations, 'FACTOR_SUPERSESSION', `${at}.current.priorVersion`, 'must reference the immediately prior exact version');
  }
  validateSuccessorClosure(
    payload.knowledgeClosure,
    'FACTOR',
    'knowledge',
    payload.previous.identity && payload.previous.identity.versionIri,
    payload.current.identity && payload.current.identity.versionIri,
    payload.previous.temporal && payload.previous.temporal.knowledgeFrom,
    payload.current.temporal && payload.current.temporal.knowledgeFrom,
    `${at}.knowledgeClosure`,
    violations,
  );
  validateSuccessorClosure(
    payload.availabilityClosure,
    'FACTOR',
    'availability',
    payload.previous.identity && payload.previous.identity.versionIri,
    payload.current.identity && payload.current.identity.versionIri,
    payload.previous.temporal && payload.previous.temporal.availableFrom,
    payload.current.temporal && payload.current.temporal.availableFrom,
    `${at}.availabilityClosure`,
    violations,
  );
  if ((payload.current.temporal && payload.current.temporal.revision) !== (payload.previous.temporal && payload.previous.temporal.revision) + 1) {
    pushViolation(violations, 'FACTOR_REVISION_SEQUENCE', at, 'revision must increment by exactly one');
  }
  return violations;
}

function validateSuccessorClosure(value, codePrefix, axis, targetVersion, causeVersion, targetStartedAt, closedAt, at, violations) {
  if (!isObject(value)) {
    pushViolation(violations, `${codePrefix}_${axis.toUpperCase()}_CLOSURE`, at, `must contain the separate ${axis} closure assertion`);
    return;
  }
  if (value.axis !== axis
      || value.targetVersion !== targetVersion
      || value.closedAt !== closedAt
      || value.causeKind !== 'successor'
      || value.causeVersion !== causeVersion) {
    pushViolation(
      violations,
      `${codePrefix}_${axis.toUpperCase()}_CLOSURE`,
      at,
      `must close the prior version ${axis} axis at the successor start through causeKind successor`,
    );
  }
  const parsedTargetStart = parseInstant(targetStartedAt);
  const parsedClosedAt = validateInstant(value.closedAt, `${at}.closedAt`, violations);
  if (Number.isFinite(parsedTargetStart) && Number.isFinite(parsedClosedAt) && parsedClosedAt <= parsedTargetStart) {
    pushViolation(violations, `${codePrefix}_${axis.toUpperCase()}_CLOSURE`, `${at}.closedAt`, 'must follow the prior version axis start');
  }
  validateIri(value.evidenceRef, `${at}.evidenceRef`, violations);
  if (value.evidenceRef !== causeVersion) {
    pushViolation(violations, `${codePrefix}_${axis.toUpperCase()}_CLOSURE_EVIDENCE`, `${at}.evidenceRef`, 'successor closure evidence must be the exact successor FactVersion, not an unbound free-form IRI');
  }
  validateIri(value.generatingContextRef, `${at}.generatingContextRef`, violations);
}

function validateCommonRun(payload, expectedKind, at, violations) {
  validateLogicalRef(payload.runAuthority, `${at}.runAuthority`, violations);
  if (payload.runKind !== expectedKind) {
    pushViolation(violations, 'RUN_KIND', `${at}.runKind`, `must equal ${expectedKind}`);
  }
  if (typeof payload.runContextId !== 'string' || payload.runContextId.length === 0) {
    pushViolation(violations, 'RUN_CONTEXT_ID', `${at}.runContextId`, 'must be non-empty');
  }
  validateInstant(payload.startedAt, `${at}.startedAt`, violations);
  for (const field of ['parameterSnapshot', 'calendarSnapshot']) {
    validatePair(payload, `${field}Ref`, `${field}Digest`, at, violations);
  }
  for (const field of ['ontologyClosureDigest', 'mappingClosureDigest', 'compilerDigest']) {
    validateDigest(payload[field], `${at}.${field}`, violations);
  }
  validatePair(payload, 'inputContextRef', 'inputContextRecordDigest', at, violations);
  validatePair(payload, 'pitRequestRef', 'pitRequestRecordDigest', at, violations);
  validateTemporal(payload.temporal, `${at}.temporal`, violations);
  validateIdentity(
    payload.identity,
    [payload.runAuthority && payload.runAuthority.logicalIri, payload.runContextId],
    payload.temporal,
    `${at}.identity`,
    violations,
  );

  const context = payload.inputContext;
  if (!isObject(context)) {
    pushViolation(violations, 'INPUT_CONTEXT_REQUIRED', `${at}.inputContext`, 'must provide the joined immutable control record');
  } else {
    validateIri(context.recordRef, `${at}.inputContext.recordRef`, violations);
    validateDigest(context.recordDigest, `${at}.inputContext.recordDigest`, violations);
    const completedAt = validateInstant(context.completedAt, `${at}.inputContext.completedAt`, violations);
    const startedAt = parseInstant(payload.startedAt);
    if (Number.isFinite(completedAt) && Number.isFinite(startedAt) && completedAt >= startedAt) {
      pushViolation(violations, 'INPUT_CONTEXT_NOT_PRIOR', `${at}.inputContext.completedAt`, 'must be strictly earlier than run startedAt');
    }
    if (context.status !== 'completed') {
      pushViolation(violations, 'INPUT_CONTEXT_STATUS', `${at}.inputContext.status`, 'must equal completed');
    }
    if (context.recordRef !== payload.inputContextRef || context.recordDigest !== payload.inputContextRecordDigest) {
      pushViolation(violations, 'INPUT_CONTEXT_JOIN', `${at}.inputContext`, 'record ref and digest must equal the RunContext pair');
    }
  }

  const report = payload.pitReport;
  if (!isObject(report)) {
    pushViolation(violations, 'PIT_REPORT_REQUIRED', `${at}.pitReport`, 'must provide joined passed PIT validation evidence');
  } else {
    if (report.status !== 'passed') {
      pushViolation(violations, 'PIT_REPORT_STATUS', `${at}.pitReport.status`, 'must equal passed');
    }
    validateIri(report.generatingContextRef, `${at}.pitReport.generatingContextRef`, violations);
    if (report.requestRef !== payload.pitRequestRef || report.requestDigest !== payload.pitRequestRecordDigest) {
      pushViolation(violations, 'PIT_REQUEST_JOIN', `${at}.pitReport`, 'request ref and digest must match the RunContext pair');
    }
    if (report.contextRef !== payload.inputContextRef || report.contextDigest !== payload.inputContextRecordDigest) {
      pushViolation(violations, 'PIT_CONTEXT_JOIN', `${at}.pitReport`, 'context ref and digest must match the RunContext pair');
    }
    for (const pivot of ['asOfValid', 'asOfKnowledge', 'asOfAvailable']) {
      validateInstant(report[pivot], `${at}.pitReport.${pivot}`, violations);
    }
  }
}

function validateBacktest(payload, at = 'payload') {
  const violations = [];
  if (!isObject(payload)) {
    pushViolation(violations, 'PAYLOAD_OBJECT', at, 'must be an object');
    return violations;
  }
  validateCommonRun(payload, 'backtest', at, violations);
  validateExactRef(payload.strategy, `${at}.strategy`, violations);
  if (payload.portfolio !== undefined) validateExactRef(payload.portfolio, `${at}.portfolio`, violations);
  if (payload.benchmarkInstrument !== undefined) validateExactRef(payload.benchmarkInstrument, `${at}.benchmarkInstrument`, violations);
  const from = validateInstant(payload.simulationFrom, `${at}.simulationFrom`, violations);
  const to = validateInstant(payload.simulationTo, `${at}.simulationTo`, violations);
  if (Number.isFinite(from) && Number.isFinite(to) && from >= to) {
    pushViolation(violations, 'BACKTEST_INTERVAL', at, 'simulation interval must be non-empty and half-open');
  }
  validateMoney(payload.initialCapital, `${at}.initialCapital`, violations);
  validateDigest(payload.codeDefinitionDigest, `${at}.codeDefinitionDigest`, violations);
  for (const field of ['feeAssumption', 'slippageAssumption', 'fillAssumption', 'benchmark']) {
    validatePair(payload, `${field}Ref`, `${field}Digest`, at, violations);
  }
  if (!Number.isInteger(payload.deterministicSeed) || payload.deterministicSeed < 0) {
    pushViolation(violations, 'DETERMINISTIC_SEED', `${at}.deterministicSeed`, 'must be a non-negative integer');
  }
  if (Object.hasOwn(payload, 'status') || Object.hasOwn(payload, 'backtestLifecycleState')) {
    pushViolation(violations, 'MUTABLE_RUN_STATUS', at, 'BacktestRun configuration must not embed lifecycle status');
  }
  const snapshots = asArray(payload.inputContext && payload.inputContext.datasetSnapshots);
  const corporateActions = snapshots.filter((snapshot) => snapshot.datasetKind === 'corporateAction');
  if (corporateActions.length !== 1) {
    pushViolation(violations, 'CORPORATE_ACTION_SNAPSHOT', `${at}.inputContext.datasetSnapshots`, 'must contain exactly one corporate-action InputDatasetSnapshot');
  } else {
    validateIri(corporateActions[0].datasetRef, `${at}.inputContext.datasetSnapshots[corporateAction].datasetRef`, violations);
    validateDigest(corporateActions[0].artifactDigest, `${at}.inputContext.datasetSnapshots[corporateAction].artifactDigest`, violations);
    validateDigest(corporateActions[0].schemaDigest, `${at}.inputContext.datasetSnapshots[corporateAction].schemaDigest`, violations);
  }
  return violations;
}

function validateResearchRun(payload, at = 'payload') {
  const violations = [];
  if (!isObject(payload)) {
    pushViolation(violations, 'PAYLOAD_OBJECT', at, 'must be an object');
    return violations;
  }
  validateCommonRun(payload, 'research', at, violations);
  validateExactRef(payload.generator, `${at}.generator`, violations);
  if (payload.portfolio !== undefined) validateExactRef(payload.portfolio, `${at}.portfolio`, violations);
  validatePair(payload, 'researchQuestionRef', 'researchQuestionDigest', at, violations);
  validatePair(payload, 'researchDatasetRef', 'researchDatasetDigest', at, violations);
  validateDigest(payload.researchOutputContractDigest, `${at}.researchOutputContractDigest`, violations);
  if (!Number.isInteger(payload.deterministicSeed) || payload.deterministicSeed < 0) {
    pushViolation(violations, 'DETERMINISTIC_SEED', `${at}.deterministicSeed`, 'must be a non-negative integer');
  }
  return violations;
}

function validateMetricDefinition(payload, at = 'payload') {
  const violations = [];
  if (!isObject(payload)) {
    pushViolation(violations, 'PAYLOAD_OBJECT', at, 'must be an object');
    return violations;
  }
  validateLogicalRef(payload.authority, `${at}.authority`, violations);
  for (const field of ['metricDefinitionId', 'metricName']) {
    if (typeof payload[field] !== 'string' || payload[field].length === 0
        || payload[field] !== payload[field].normalize('NFC')) {
      pushViolation(violations, 'METRIC_DEFINITION_IDENTITY', `${at}.${field}`, 'must be one non-empty NFC string');
    }
  }
  if (!['money', 'quantity'].includes(payload.metricValueKind)) {
    pushViolation(violations, 'METRIC_VALUE_KIND', `${at}.metricValueKind`, 'must equal money or quantity');
  }
  for (const field of [
    'formulaDigest', 'implementationDigest', 'inputContractDigest', 'outputContractDigest',
    'toolLockDigest', 'runtimeDigest',
  ]) {
    validateDigest(payload[field], `${at}.${field}`, violations);
  }
  validateIri(payload.toolLockRef, `${at}.toolLockRef`, violations);
  validateTemporal(payload.temporal, `${at}.temporal`, violations);
  validateIdentity(
    payload.identity,
    [payload.authority && payload.authority.logicalIri, payload.metricDefinitionId],
    payload.temporal,
    `${at}.identity`,
    violations,
  );
  return violations;
}

function validateCalculationContext(payload, at = 'payload', options = {}) {
  const violations = [];
  if (!isObject(payload)) {
    pushViolation(violations, 'PAYLOAD_OBJECT', at, 'must be an object');
    return violations;
  }
  validateLogicalRef(payload.authority, `${at}.authority`, violations);
  if (typeof payload.calculationContextId !== 'string'
      || payload.calculationContextId.length === 0
      || payload.calculationContextId !== payload.calculationContextId.normalize('NFC')) {
    pushViolation(violations, 'CALCULATION_CONTEXT_IDENTITY', `${at}.calculationContextId`, 'must be one non-empty NFC string');
  }
  if (!['perObservation', 'daily', 'weekly', 'monthly', 'fullRun'].includes(payload.calculationFrequency)) {
    pushViolation(violations, 'CALCULATION_FREQUENCY', `${at}.calculationFrequency`, 'must be a reviewed frequency member');
  }
  validateDigest(
    payload.calculationImplementationDigest,
    `${at}.calculationImplementationDigest`,
    violations,
  );
  validateCalculationParameterSnapshotEvidence(payload, at, violations, options);
  validateOptionalPair(payload, 'benchmarkRef', 'benchmarkDigest', at, violations);
  if (payload.annualizationFactor !== undefined) {
    validateQuantity(payload.annualizationFactor, `${at}.annualizationFactor`, violations, {
      application: 'annualizationFactor', positive: true,
    });
  }
  if (payload.riskFreeRate !== undefined) {
    validateQuantity(payload.riskFreeRate, `${at}.riskFreeRate`, violations, { application: 'riskFreeRate' });
  }
  if (payload.calculationWindow !== undefined) {
    validateQuantity(payload.calculationWindow, `${at}.calculationWindow`, violations, {
      application: 'calculationWindow', positive: true,
    });
  }
  if (payload.confidenceLevel !== undefined) {
    validateQuantity(payload.confidenceLevel, `${at}.confidenceLevel`, violations, {
      application: 'confidenceLevel', min: '0', max: '1',
    });
  }
  validateTemporal(payload.temporal, `${at}.temporal`, violations);
  validateIdentity(
    payload.identity,
    [payload.authority && payload.authority.logicalIri, payload.calculationContextId],
    payload.temporal,
    `${at}.identity`,
    violations,
  );
  return violations;
}

function validateMetricValue(payload, valuePrefix, at, violations) {
  const metric = payload.metric;
  const calculation = payload.calculationContext;
  if (!isObject(metric)) {
    pushViolation(violations, 'METRIC_REQUIRED', `${at}.metric`, 'must provide metric definition and exact reference');
    return;
  }
  validateExactRef(metric.ref, `${at}.metric.ref`, violations);
  if (!['money', 'quantity'].includes(metric.valueKind)) {
    pushViolation(violations, 'METRIC_VALUE_KIND', `${at}.metric.valueKind`, 'must equal money or quantity');
  }
  if (!isObject(calculation)) {
    pushViolation(violations, 'CALCULATION_CONTEXT_REQUIRED', `${at}.calculationContext`, 'must provide calculation context and exact reference');
  } else {
    validateExactRef(calculation.ref, `${at}.calculationContext.ref`, violations);
    if (!['perObservation', 'daily', 'weekly', 'monthly', 'fullRun'].includes(calculation.frequency)) {
      pushViolation(violations, 'CALCULATION_FREQUENCY', `${at}.calculationContext.frequency`, 'must be a reviewed frequency member');
    }
    validateDigest(calculation.implementationDigest, `${at}.calculationContext.implementationDigest`, violations);
    validateCalculationParameterSnapshotEvidence({
      annualizationFactor: calculation.annualizationFactor,
      benchmarkDigest: calculation.benchmarkDigest,
      benchmarkRef: calculation.benchmarkRef,
      calculationContextId: calculation.ref?.logicalIri,
      calculationFrequency: calculation.frequency,
      calculationImplementationDigest: calculation.implementationDigest,
      calculationParameterSnapshotDigest: calculation.calculationParameterSnapshotDigest,
      calculationParameterSnapshotLocator: calculation.calculationParameterSnapshotLocator,
      calculationParameterSnapshotRef: calculation.calculationParameterSnapshotRef,
      calculationWindow: calculation.window,
      confidenceLevel: calculation.confidenceLevel,
      riskFreeRate: calculation.riskFreeRate,
    }, `${at}.calculationContext`, violations);
    validateOptionalPair(calculation, 'benchmarkRef', 'benchmarkDigest', `${at}.calculationContext`, violations);
    if ((metric && metric.metricCode === 'sharpe') || calculation.annualizationFactor !== undefined) {
      validateQuantity(calculation.annualizationFactor, `${at}.calculationContext.annualizationFactor`, violations, {
        application: 'annualizationFactor', positive: true,
      });
    }
    if ((metric && metric.metricCode === 'sharpe') || calculation.riskFreeRate !== undefined) {
      validateQuantity(calculation.riskFreeRate, `${at}.calculationContext.riskFreeRate`, violations, { application: 'riskFreeRate' });
    }
    if ((metric && metric.metricCode === 'sharpe') || calculation.window !== undefined) {
      validateQuantity(calculation.window, `${at}.calculationContext.window`, violations, {
        application: 'calculationWindow', positive: true,
      });
    }
    if (calculation.confidenceLevel !== undefined) {
      validateQuantity(calculation.confidenceLevel, `${at}.calculationContext.confidenceLevel`, violations, {
        application: 'confidenceLevel', min: '0', max: '1',
      });
    }
  }
  const moneyName = `${valuePrefix}MoneyValue`;
  const quantityName = `${valuePrefix}QuantityValue`;
  const hasMoney = payload[moneyName] !== undefined;
  const hasQuantity = payload[quantityName] !== undefined;
  if (hasMoney === hasQuantity) {
    pushViolation(violations, 'METRIC_VALUE_XONE', at, `exactly one of ${moneyName} and ${quantityName} is required`);
  } else if (hasMoney) {
    validateMoney(payload[moneyName], `${at}.${moneyName}`, violations);
  } else {
    validateQuantity(payload[quantityName], `${at}.${quantityName}`, violations, {
      application: quantityName,
    });
  }
  if ((metric.valueKind === 'money') !== hasMoney || (metric.valueKind === 'quantity') !== hasQuantity) {
    pushViolation(violations, 'METRIC_VALUE_MISMATCH', at, 'present value representation must match MetricDefinition valueKind');
  }
  if (metric.metricCode === 'sharpe') {
    if (!calculation) return;
    if (hasQuantity) validateQuantity(payload[quantityName], `${at}.${quantityName}`, violations, {
      application: quantityName,
    });
  }
}

function validatePerformance(payload, at = 'payload') {
  const violations = [];
  if (!isObject(payload)) {
    pushViolation(violations, 'PAYLOAD_OBJECT', at, 'must be an object');
    return violations;
  }
  validateMetricValue(payload, 'performance', at, violations);
  validateExactRef(payload.runContext, `${at}.runContext`, violations);
  if (payload.priorVersion !== undefined) validateExactRef(payload.priorVersion, `${at}.priorVersion`, violations);
  if (typeof payload.sourcePerformanceId !== 'string' || payload.sourcePerformanceId.length === 0) {
    pushViolation(violations, 'SOURCE_PERFORMANCE_ID', `${at}.sourcePerformanceId`, 'must be non-empty');
  }
  validateTemporal(payload.temporal, `${at}.temporal`, violations);
  validateIdentity(
    payload.identity,
    [
      payload.runContext && payload.runContext.logicalIri,
      payload.metric && payload.metric.ref && payload.metric.ref.logicalIri,
      payload.calculationContext && payload.calculationContext.ref && payload.calculationContext.ref.logicalIri,
      payload.sourcePerformanceId,
    ],
    payload.temporal,
    `${at}.identity`,
    violations,
  );
  return violations;
}

function validatePerformanceRevision(payload, at = 'payload') {
  const violations = [];
  if (!isObject(payload) || !isObject(payload.previous) || !isObject(payload.current)) {
    pushViolation(violations, 'PERFORMANCE_REVISION_PAIR', at, 'must contain previous and current PerformanceObservation facts');
    return violations;
  }
  violations.push(...validatePerformance(payload.previous, `${at}.previous`));
  violations.push(...validatePerformance(payload.current, `${at}.current`));
  const previousIdentity = payload.previous.identity || {};
  const currentIdentity = payload.current.identity || {};
  if (!canonicalArrayEqual(previousIdentity.logicalKey, currentIdentity.logicalKey)) {
    pushViolation(violations, 'PERFORMANCE_LOGICAL_KEY_DRIFT', at, 'performance revisions must preserve the same logical key');
  }
  if (currentIdentity.logicalIri !== previousIdentity.logicalIri) {
    pushViolation(violations, 'PERFORMANCE_LOGICAL_IRI_DRIFT', at, 'performance revisions must preserve the same logical IRI');
  }
  if (!payload.current.priorVersion
      || payload.current.priorVersion.logicalIri !== previousIdentity.logicalIri
      || payload.current.priorVersion.versionIri !== previousIdentity.versionIri) {
    pushViolation(violations, 'PERFORMANCE_SUPERSESSION', `${at}.current.priorVersion`, 'must reference the immediately prior exact PerformanceObservation version');
  }
  validateSuccessorClosure(
    payload.knowledgeClosure,
    'PERFORMANCE',
    'knowledge',
    previousIdentity.versionIri,
    currentIdentity.versionIri,
    payload.previous.temporal && payload.previous.temporal.knowledgeFrom,
    payload.current.temporal && payload.current.temporal.knowledgeFrom,
    `${at}.knowledgeClosure`,
    violations,
  );
  validateSuccessorClosure(
    payload.availabilityClosure,
    'PERFORMANCE',
    'availability',
    previousIdentity.versionIri,
    currentIdentity.versionIri,
    payload.previous.temporal && payload.previous.temporal.availableFrom,
    payload.current.temporal && payload.current.temporal.availableFrom,
    `${at}.availabilityClosure`,
    violations,
  );
  if ((payload.current.temporal && payload.current.temporal.revision) !== (payload.previous.temporal && payload.previous.temporal.revision) + 1) {
    pushViolation(violations, 'PERFORMANCE_REVISION_SEQUENCE', at, 'revision must increment by exactly one');
  }
  return violations;
}

function validatePerformanceTrajectory(payload, at = 'payload') {
  const violations = [];
  if (!isObject(payload)) {
    pushViolation(violations, 'PAYLOAD_OBJECT', at, 'must be an object');
    return violations;
  }
  const from = validateInstant(payload.from, `${at}.from`, violations);
  const to = validateInstant(payload.to, `${at}.to`, violations);
  const asOfValid = validateInstant(payload.asOfValid, `${at}.asOfValid`, violations);
  const asOfKnowledge = validateInstant(payload.asOfKnowledge, `${at}.asOfKnowledge`, violations);
  const asOfAvailable = validateInstant(payload.asOfAvailable, `${at}.asOfAvailable`, violations);
  if (Number.isFinite(from) && Number.isFinite(to) && from >= to) {
    pushViolation(violations, 'PERFORMANCE_TRAJECTORY_INTERVAL', at, 'query interval must be explicit non-empty [from,to)');
  }
  for (const forbidden of ['lastQuarter', 'relativeInterval', 'now', 'currentTimestamp']) {
    if (Object.hasOwn(payload, forbidden)) {
      pushViolation(violations, 'PERFORMANCE_TRAJECTORY_RELATIVE_TIME', `${at}.${forbidden}`, 'relative or implicit time input is forbidden');
    }
  }
  const observations = asArray(payload.observations);
  if (observations.length < 2) {
    pushViolation(violations, 'PERFORMANCE_TRAJECTORY_EMPTY', `${at}.observations`, 'must contain at least two ordered Sharpe observations');
    return violations;
  }
  let expectedRun;
  let expectedMetric;
  let expectedCalculation;
  let priorValidFrom = Number.NEGATIVE_INFINITY;
  observations.forEach((observation, index) => {
    const observationAt = `${at}.observations[${index}]`;
    violations.push(...validatePerformance(observation, observationAt));
    if (observation.metric && observation.metric.metricCode !== 'sharpe') {
      pushViolation(violations, 'PERFORMANCE_TRAJECTORY_METRIC', `${observationAt}.metric.metricCode`, 'must equal sharpe');
    }
    const run = observation.runContext && observation.runContext.logicalIri;
    const metric = observation.metric && observation.metric.ref && observation.metric.ref.versionIri;
    const calculation = observation.calculationContext && observation.calculationContext.ref && observation.calculationContext.ref.versionIri;
    if (index === 0) {
      expectedRun = run;
      expectedMetric = metric;
      expectedCalculation = calculation;
    } else if (run !== expectedRun || metric !== expectedMetric || calculation !== expectedCalculation) {
      pushViolation(violations, 'PERFORMANCE_TRAJECTORY_CONTEXT', observationAt, 'all observations must use one run logical identity and exact metric/calculation versions');
    }
    const validFrom = parseInstant(observation.temporal && observation.temporal.validFrom);
    const knowledgeFrom = parseInstant(observation.temporal && observation.temporal.knowledgeFrom);
    const availableFrom = parseInstant(observation.temporal && observation.temporal.availableFrom);
    if (Number.isFinite(validFrom) && Number.isFinite(from) && Number.isFinite(to) && (validFrom < from || validFrom >= to)) {
      pushViolation(violations, 'PERFORMANCE_TRAJECTORY_INTERVAL', `${observationAt}.temporal.validFrom`, 'must lie inside the explicit [from,to) interval');
    }
    if (Number.isFinite(validFrom) && validFrom <= priorValidFrom) {
      pushViolation(violations, 'PERFORMANCE_TRAJECTORY_ORDER', `${observationAt}.temporal.validFrom`, 'observations must be strictly ordered by validFrom');
    }
    priorValidFrom = validFrom;
    if ((Number.isFinite(validFrom) && Number.isFinite(asOfValid) && validFrom > asOfValid)
        || (Number.isFinite(knowledgeFrom) && Number.isFinite(asOfKnowledge) && knowledgeFrom > asOfKnowledge)
        || (Number.isFinite(availableFrom) && Number.isFinite(asOfAvailable) && availableFrom > asOfAvailable)) {
      pushViolation(violations, 'PERFORMANCE_TRAJECTORY_PIT', observationAt, 'observation is not visible at the explicit three-axis pivots');
    }
  });
  return violations;
}

function validateAttribution(payload, at = 'payload') {
  const violations = [];
  if (!isObject(payload)) {
    pushViolation(violations, 'PAYLOAD_OBJECT', at, 'must be an object');
    return violations;
  }
  const hasSnapshot = payload.positionSnapshot !== undefined;
  const hasLot = payload.positionLot !== undefined;
  if (hasSnapshot === hasLot) {
    pushViolation(violations, 'ATTRIBUTION_SUBJECT_XONE', at, 'exactly one of positionSnapshot and positionLot is required');
  }
  if (hasSnapshot) validateExactRef(payload.positionSnapshot, `${at}.positionSnapshot`, violations);
  if (hasLot) validateExactRef(payload.positionLot, `${at}.positionLot`, violations);
  validateExactRef(payload.generator, `${at}.generator`, violations);
  validateExactRef(payload.runContext, `${at}.runContext`, violations);
  validateMetricValue(payload, 'attribution', at, violations);
  if (typeof payload.sourceAttributionId !== 'string' || payload.sourceAttributionId.length === 0) {
    pushViolation(violations, 'SOURCE_ATTRIBUTION_ID', `${at}.sourceAttributionId`, 'must be non-empty');
  }
  validateTemporal(payload.temporal, `${at}.temporal`, violations);
  const subject = payload.positionSnapshot || payload.positionLot;
  validateIdentity(
    payload.identity,
    [
      subject && subject.logicalIri,
      payload.generator && payload.generator.logicalIri,
      payload.runContext && payload.runContext.logicalIri,
      payload.metric && payload.metric.ref && payload.metric.ref.logicalIri,
      payload.sourceAttributionId,
    ],
    payload.temporal,
    `${at}.identity`,
    violations,
  );
  return violations;
}

function validateStatusEvent(payload, at = 'payload') {
  const violations = [];
  if (!isObject(payload)) {
    pushViolation(violations, 'PAYLOAD_OBJECT', at, 'must be an object');
    return violations;
  }
  validateExactRef(payload.run, `${at}.run`, violations);
  if (!['planned', 'running', 'completed', 'failed', 'cancelled'].includes(payload.state)) {
    pushViolation(violations, 'BACKTEST_STATE', `${at}.state`, 'must be a reviewed lifecycle member');
  }
  if (!Number.isInteger(payload.sequence) || payload.sequence < 0) {
    pushViolation(violations, 'STATUS_SEQUENCE', `${at}.sequence`, 'must be a non-negative integer');
  }
  if (typeof payload.sourceRunEventId !== 'string' || payload.sourceRunEventId.length === 0) {
    pushViolation(violations, 'SOURCE_RUN_EVENT_ID', `${at}.sourceRunEventId`, 'must be non-empty');
  }
  if (payload.previous !== undefined) {
    validateExactRef(payload.previous.ref, `${at}.previous.ref`, violations);
    if (payload.sequence !== payload.previous.sequence + 1) {
      pushViolation(violations, 'STATUS_SEQUENCE', at, 'sequence must increment by exactly one');
    }
    const allowed = {
      planned: ['running', 'cancelled'],
      running: ['completed', 'failed', 'cancelled'],
      completed: [],
      failed: [],
      cancelled: [],
    };
    if (!asArray(allowed[payload.previous.state]).includes(payload.state)) {
      pushViolation(violations, 'STATUS_TRANSITION', at, 'previous and current states do not form a reviewed transition');
    }
  } else if (payload.sequence !== 0 || payload.state !== 'planned') {
    pushViolation(violations, 'STATUS_INITIAL', at, 'initial event must be planned at sequence zero');
  }
  validateTemporal(payload.temporal, `${at}.temporal`, violations);
  validateIdentity(
    payload.identity,
    [payload.run && payload.run.logicalIri, payload.sourceRunEventId],
    payload.temporal,
    `${at}.identity`,
    violations,
  );
  return violations;
}

function validateCompletedBacktestResults(payload, at = 'payload') {
  const violations = [];
  if (!isObject(payload)) {
    pushViolation(violations, 'PAYLOAD_OBJECT', at, 'must be an object');
    return violations;
  }
  validateExactRef(payload.run, `${at}.run`, violations);
  violations.push(...validateStatusEvent(payload.terminalStatus, `${at}.terminalStatus`));
  if (!payload.terminalStatus || payload.terminalStatus.state !== 'completed') {
    pushViolation(violations, 'BACKTEST_NOT_COMPLETED', `${at}.terminalStatus.state`, 'must equal completed');
  }
  if (!payload.terminalStatus
      || !payload.terminalStatus.run
      || payload.terminalStatus.run.logicalIri !== (payload.run && payload.run.logicalIri)
      || payload.terminalStatus.run.versionIri !== (payload.run && payload.run.versionIri)) {
    pushViolation(violations, 'COMPLETED_BACKTEST_STATUS_JOIN', `${at}.terminalStatus.run`, 'must reference the exact completed BacktestRun version');
  }
  const performances = asArray(payload.performances);
  if (performances.length === 0) {
    pushViolation(violations, 'COMPLETED_BACKTEST_PERFORMANCE_EMPTY', `${at}.performances`, 'must contain at least one PerformanceObservation');
  }
  performances.forEach((performance, index) => {
    const performanceAt = `${at}.performances[${index}]`;
    violations.push(...validatePerformance(performance, performanceAt));
    if (!performance.runContext
        || performance.runContext.logicalIri !== (payload.run && payload.run.logicalIri)
        || performance.runContext.versionIri !== (payload.run && payload.run.versionIri)) {
      pushViolation(violations, 'COMPLETED_BACKTEST_PERFORMANCE_JOIN', `${performanceAt}.runContext`, 'must reference the exact completed BacktestRun version');
    }
  });
  return violations;
}

const CASE_VALIDATORS = Object.freeze({
  calculationContext: validateCalculationContext,
  completedBacktestResults: validateCompletedBacktestResults,
  generatorDefinition: validateGeneratorDefinition,
  metricDefinition: validateMetricDefinition,
  signal: validateSignal,
  signalSet: validateSignalSet,
  factorRevision: validateFactorRevision,
  backtest: validateBacktest,
  researchRun: validateResearchRun,
  performance: validatePerformance,
  performanceRevision: validatePerformanceRevision,
  performanceTrajectory: validatePerformanceTrajectory,
  attribution: validateAttribution,
  statusEvent: validateStatusEvent,
});

function validateFixtureDocument(document, options = {}) {
  const errors = [];
  const results = [];
  if (!isObject(document)) {
    return { ok: false, errors: [{ code: 'DOCUMENT_OBJECT', at: '$', message: 'fixture document must be an object' }], results };
  }
  if (document.schemaVersion !== '1.0') {
    errors.push({ code: 'SCHEMA_VERSION', at: '$.schemaVersion', message: 'must equal 1.0' });
  }
  const cases = asArray(document.cases);
  if (cases.length === 0) {
    errors.push({ code: 'CASES_EMPTY', at: '$.cases', message: 'must contain at least one executable case' });
  }
  const ids = new Set();
  cases.forEach((testCase, index) => {
    const at = `$.cases[${index}]`;
    if (!isObject(testCase)) {
      errors.push({ code: 'CASE_OBJECT', at, message: 'case must be an object' });
      return;
    }
    if (typeof testCase.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(testCase.id)) {
      errors.push({ code: 'CASE_ID', at: `${at}.id`, message: 'must be a lower-kebab stable ID' });
    } else if (ids.has(testCase.id)) {
      errors.push({ code: 'CASE_ID_DUPLICATE', at: `${at}.id`, message: 'must be unique in the document' });
    } else {
      ids.add(testCase.id);
    }
    const validator = CASE_VALIDATORS[testCase.kind];
    if (!validator) {
      errors.push({ code: 'CASE_KIND', at: `${at}.kind`, message: `unsupported kind ${String(testCase.kind)}` });
      return;
    }
    if (!['accept', 'reject'].includes(testCase.expected)) {
      errors.push({ code: 'CASE_EXPECTED', at: `${at}.expected`, message: 'must equal accept or reject' });
      return;
    }
    const violations = validator(testCase.payload, `${at}.payload`);
    const actual = violations.length === 0 ? 'accept' : 'reject';
    const expectedCodeSatisfied = testCase.expected !== 'reject'
      || (typeof testCase.expectedCode === 'string' && violations.some((violation) => violation.code === testCase.expectedCode));
    const matched = actual === testCase.expected && expectedCodeSatisfied;
    results.push({ id: testCase.id, kind: testCase.kind, expected: testCase.expected, actual, matched, violations });
    if (!matched) {
      errors.push({
        code: 'CASE_EXPECTATION',
        at,
        message: `expected ${testCase.expected}${testCase.expectedCode ? ` with ${testCase.expectedCode}` : ''}, got ${actual} with ${violations.map((v) => v.code).join(',') || 'no violations'}`,
      });
    }
  });
  if (options.requirePositive && !cases.some((testCase) => testCase.expected === 'accept')) {
    errors.push({ code: 'POSITIVE_REQUIRED', at: '$.cases', message: 'at least one positive case is required' });
  }
  if (options.requireNegative && !cases.some((testCase) => testCase.expected === 'reject')) {
    errors.push({ code: 'NEGATIVE_REQUIRED', at: '$.cases', message: 'at least one negative case is required' });
  }
  return { ok: errors.length === 0, errors, results };
}

function loadYaml(filePath) {
  return YAML.parse(fs.readFileSync(filePath, 'utf8'));
}

function collectAlignments(value, found = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectAlignments(entry, found);
  } else if (isObject(value)) {
    if (Array.isArray(value.alignments)) found.push(...value.alignments);
    for (const entry of Object.values(value)) collectAlignments(entry, found);
  }
  return found;
}

function attributeLocalNames(type) {
  return new Set(asArray(type && type.attributeUses).map((entry) => localName(entry.attribute)));
}

function requireAttributeUses(type, typeName, requiredNames, errors, cardinality = { minCount: 1, maxCount: 1 }) {
  const uses = asArray(type && type.attributeUses);
  for (const name of requiredNames) {
    const matches = uses.filter((entry) => localName(entry.attribute) === name);
    if (matches.length !== 1) {
      errors.push(`${typeName} requires exactly one AttributeUse for ${name}`);
      continue;
    }
    if (matches[0].minCount !== cardinality.minCount || matches[0].maxCount !== cardinality.maxCount) {
      errors.push(`${typeName}.${name} cardinality must equal ${cardinality.minCount}..${String(cardinality.maxCount)}`);
    }
  }
}

function requireRole(association, associationName, roleName, expected, errors) {
  const matches = asArray(association && association.participantRoles).filter((role) => role.id === roleName);
  if (matches.length !== 1) {
    errors.push(`${associationName} requires exactly one role ${roleName}`);
    return;
  }
  const role = matches[0];
  if (role.range !== expected.range || role.minCount !== expected.minCount || role.maxCount !== expected.maxCount) {
    errors.push(`${associationName}.${roleName} range/cardinality does not match RFC-001`);
  }
}

function hasReferenceBinding(bindings, targetElement, constraintRef) {
  return bindings.filter((binding) => binding.targetElement === targetElement && binding.constraintRef === constraintRef).length;
}

function validateStrategyResearchModule(options = {}) {
  const root = path.resolve(options.root || path.resolve(__dirname, '..', '..', '..'));
  const modulePath = path.resolve(root, options.modulePath || 'ontology/domain/finance/strategy-research/module.yaml');
  const reviewPath = path.resolve(root, options.reviewPath || 'docs/ontology/references/reviews/project-reference/qlib.review.json');
  const mappingRoot = path.resolve(root, options.mappingRoot || 'mappings/finance/v0.3.0/strategy-research');
  const cqRoot = path.resolve(root, options.cqRoot || 'tests/m2/cq/strategy-research');
  const replayEvidence = path.resolve(root, options.replayEvidence || 'docs/domain/infrastructure/strategy-research-pit-replay-evidence.json');
  const executableEvidence = path.resolve(root, options.executableEvidence || 'docs/domain/infrastructure/strategy-research-executable-evidence.json');
  const errors = [];
  const pending = [];
  const evidence = {
    cqActivePassed: 0,
    cqDeferredNonCore: 0,
    formulaVectorsPassed: 0,
    materializedRecords: 0,
    materializedTypes: 0,
    pitReplaysPassed: 0,
    qlibConflictMappings: 0,
    quantityUnits: 0,
    referenceModeBindings: 0,
    semanticMappingDefinitions: 0,
  };
  let document;
  try {
    document = loadYaml(modulePath);
  } catch (error) {
    return { status: 'fail', errors: [`module YAML cannot be parsed: ${error.message}`], pending, evidence };
  }
  const module = document.module || {};
  const domain = document.domain || {};
  if (module.moduleIri !== BASE.slice(0, -1)) errors.push('moduleIri must be the canonical strategy-research IRI');
  if (module.baseIri !== BASE) errors.push('baseIri must be the canonical strategy-research base');
  if (module.version !== '0.3.0') errors.push('module version must be 0.3.0');
  if (module.status !== 'draft' || !module.governance || module.governance.status !== 'draft') {
    errors.push('module and governance status must remain draft until the repository-wide release gate authorizes approval');
  }
  const imports = asArray(module.imports);
  if (!canonicalArrayEqual(imports.map((entry) => entry.moduleIri), REQUIRED_IMPORTS)) {
    errors.push(`direct import DAG must equal ${REQUIRED_IMPORTS.join(', ')}`);
  }
  imports.forEach((entry, index) => {
    if (entry.version !== '0.3.0') errors.push(`import[${index}] version must equal 0.3.0`);
    if (entry.importMode !== 'All') errors.push(`import[${index}] importMode must equal All`);
    if (!DIGEST_RE.test(entry.artifactDigest || '')) errors.push(`import[${index}] artifactDigest must be a Digest`);
  });

  const objects = domain.objectTypes || {};
  const associations = domain.associationTypes || {};
  for (const name of REQUIRED_OBJECTS) if (!objects[name]) errors.push(`missing ObjectType ${name}`);
  for (const name of REQUIRED_ASSOCIATIONS) if (!associations[name]) errors.push(`missing AssociationType ${name}`);
  if (objects.SignalObservation || associations.SignalObservation) {
    errors.push('SignalObservation must not duplicate RFC-001 canonical Signal; Signal carries the Signal Observation label');
  }
  const serialized = JSON.stringify(document);
  if (serialized.includes('nextRevision') || serialized.includes('_next')) {
    errors.push('implementation-private Qlib linked-record pointers must not appear in canonical module semantics');
  }
  if (/CURRENT_TIMESTAMP|currentTimestamp|\bnow\(\)/.test(serialized)) {
    errors.push('implicit or non-reproducible time functions must not appear in canonical module semantics');
  }

  for (const [containerName, container] of [['objectTypes', objects], ['associationTypes', associations]]) {
    for (const [name, type] of Object.entries(container)) {
      const patterns = asArray(type.patternBindings).map((binding) => binding.pattern);
      evidence.materializedTypes += 1;
      if (patterns.filter((iri) => iri === TEMPORAL_PATTERN).length !== 1
          || patterns.filter((iri) => iri === PROVENANCE_PATTERN).length !== 1
          || patterns.length !== 2) {
        errors.push(`${containerName}.${name} must bind exactly TemporalFact and ProvenancedFact`);
      }
    }
  }

  requireAttributeUses(objects.SignalGenerator, 'SignalGenerator', REQUIRED_GENERATOR_ATTRIBUTES, errors);
  requireAttributeUses(objects.RunContext, 'RunContext', REQUIRED_RUN_ATTRIBUTES, errors);
  requireAttributeUses(objects.BacktestRun, 'BacktestRun', REQUIRED_BACKTEST_ATTRIBUTES, errors);
  requireAttributeUses(objects.ResearchRun, 'ResearchRun', REQUIRED_RESEARCH_ATTRIBUTES, errors);
  requireAttributeUses(objects.MetricDefinition, 'MetricDefinition', REQUIRED_METRIC_ATTRIBUTES, errors);
  requireAttributeUses(objects.CalculationContext, 'CalculationContext', REQUIRED_CALCULATION_ATTRIBUTES, errors);
  requireAttributeUses(objects.FactorDefinition, 'FactorDefinition', ['factorExpressionRef', 'factorExpressionDigest'], errors);
  const backtestAttributes = attributeLocalNames(objects.BacktestRun);
  if (backtestAttributes.has('backtestLifecycleState')) errors.push('BacktestRun must not embed lifecycle status');
  for (const [typeName, parentName] of [
    ['FactorDefinition', 'SignalGenerator'],
    ['StrategyDefinition', 'SignalGenerator'],
    ['BacktestRun', 'RunContext'],
    ['ResearchRun', 'RunContext'],
  ]) {
    if (!asArray(objects[typeName] && objects[typeName].superTypes).includes(`${BASE}${parentName}`)) {
      errors.push(`${typeName} must specialize ${parentName}`);
    }
  }

  const bindings = asArray(domain.constraintBindings);
  for (const [associationName, association] of Object.entries(associations)) {
    for (const role of asArray(association.participantRoles)) {
      if (typeof role.label !== 'string' || role.label.length === 0 || typeof role.definition !== 'string' || role.definition.length === 0) {
        errors.push(`${associationName}.${role.id} requires public role label and definition`);
      }
      const target = `${association.iri}/role/${role.id}`;
      const exactCount = hasReferenceBinding(bindings, target, EXACT_REF);
      const logicalCount = hasReferenceBinding(bindings, target, LOGICAL_REF);
      evidence.referenceModeBindings += exactCount + logicalCount;
      if (exactCount + logicalCount !== 1) {
        errors.push(`${associationName}.${role.id} requires exactly one reference-mode binding`);
      }
    }
  }
  for (const [index, use] of asArray(domain.relationUses).entries()) {
    const references = asArray(use.constraints).filter((binding) => [EXACT_REF, LOGICAL_REF].includes(binding.constraintRef));
    evidence.referenceModeBindings += references.length;
    if (references.length !== 1) errors.push(`relationUses[${index}] requires exactly one reference-mode binding`);
  }

  requireRole(associations.Signal, 'Signal', 'signalGenerator', { range: `${BASE}SignalGenerator`, minCount: 1, maxCount: 1 }, errors);
  requireRole(associations.Signal, 'Signal', 'signalInstrument', { range: 'https://axiolune.ai/ontology/finance/instruments/FinancialInstrument', minCount: 1, maxCount: 1 }, errors);
  requireRole(associations.Signal, 'Signal', 'signalListing', { range: 'https://axiolune.ai/ontology/finance/instruments/InstrumentListing', minCount: 0, maxCount: 1 }, errors);
  requireRole(associations.Signal, 'Signal', 'signalRunContext', { range: `${BASE}RunContext`, minCount: 1, maxCount: 1 }, errors);
  requireAttributeUses(associations.Signal, 'Signal', ['sourceSignalId', 'signalDirection', 'signalStrength', 'signalHorizon'], errors);
  requireRole(associations.PerformanceObservation, 'PerformanceObservation', 'performanceMetric', { range: `${BASE}MetricDefinition`, minCount: 1, maxCount: 1 }, errors);
  requireRole(associations.PerformanceObservation, 'PerformanceObservation', 'performanceRunContext', { range: `${BASE}RunContext`, minCount: 1, maxCount: 1 }, errors);
  requireRole(associations.PerformanceObservation, 'PerformanceObservation', 'performanceCalculationContext', { range: `${BASE}CalculationContext`, minCount: 1, maxCount: 1 }, errors);
  requireRole(associations.PerformanceObservation, 'PerformanceObservation', 'supersedesPerformanceVersion', { range: `${BASE}PerformanceObservation`, minCount: 0, maxCount: 1 }, errors);
  const performanceAttributes = attributeLocalNames(associations.PerformanceObservation);
  if (!performanceAttributes.has('performanceMoneyValue') || !performanceAttributes.has('performanceQuantityValue')) {
    errors.push('PerformanceObservation must expose both optional typed branches for executable xone validation');
  }
  const performanceRoles = new Set(asArray(associations.PerformanceObservation && associations.PerformanceObservation.participantRoles).map((role) => role.id));
  if (!performanceRoles.has('supersedesPerformanceVersion')) {
    errors.push('PerformanceObservation must expose exact prior-version supersession for CQ-SR8');
  }
  if (!domain.constraints
      || !domain.constraints.PerformanceValueContract
      || !domain.constraints.PerformanceRevisionContract
      || !domain.constraints.PositionAttributionContract) {
    errors.push('performance revision/value and attribution executable contract definitions are missing');
  }
  const usesFactor = asArray(domain.relationUses).find((use) => use.relation === `${BASE}usesFactor`);
  if (!usesFactor
      || usesFactor.subjectType !== `${BASE}StrategyDefinition`
      || usesFactor.objectType !== `${BASE}FactorDefinition`
      || !usesFactor.outboundCardinality
      || usesFactor.outboundCardinality.minCount !== 1
      || usesFactor.outboundCardinality.maxCount !== null) {
    errors.push('StrategyDefinition must have required usesFactor exact-version relations');
  }

  for (const [name, expression, target] of [
    ['PerformanceValueXone', 'sh:xone(performanceMoneyValue,performanceQuantityValue)', `${BASE}PerformanceObservation`],
    ['PositionAttributionSubjectXone', 'sh:xone(attributedPositionSnapshot,attributedPositionLot)', `${BASE}PositionAttribution`],
    ['PositionAttributionValueXone', 'sh:xone(attributionMoneyValue,attributionQuantityValue)', `${BASE}PositionAttribution`],
  ]) {
    const constraint = domain.constraints && domain.constraints[name];
    if (!constraint
        || constraint.targetElement !== target
        || !constraint.expression
        || constraint.expression.language !== 'SHACL'
        || constraint.expression.expression !== expression) {
      errors.push(`${name} must be the exact executable RFC-001 SHACL xone constraint`);
    }
    const bindingCount = bindings.filter((binding) => binding.constraintRef === `${BASE}${name}` && binding.targetElement === target).length;
    if (bindingCount !== 1) errors.push(`${name} requires exactly one target binding`);
  }

  for (const codeList of Object.values(domain.codeLists || {})) {
    for (const value of asArray(codeList.values)) {
      if (value.iri !== `${codeList.iri}/value/${value.notation}`) {
        errors.push(`${codeList.localName || codeList.iri} value ${String(value.notation)} does not use the canonical value namespace`);
      }
    }
  }

  const codeLists = domain.codeLists || {};
  for (const [name, codeList] of Object.entries(codeLists)) {
    if (typeof codeList.sourceEvidenceRef === 'string' && codeList.sourceEvidenceRef.includes('/pending-source-evidence/')) {
      pending.push(`code list ${name} has no exact locked source evidence`);
    }
  }

  const qlibAlignments = collectAlignments(domain).filter((alignment) => /qlib/i.test(alignment.vocabulary || '') || /qlib/i.test(alignment.targetIri || ''));
  if (qlibAlignments.length > 0) {
    errors.push('Qlib implementation evidence must not be represented as an ontology alignment');
  }
  try {
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
    const reviewFiles = asArray(review.files);
    const rejectedCandidates = [];
    for (const [evidencePath, expectedDigest] of EXPECTED_QLIB_EVIDENCE) {
      const matches = reviewFiles.filter((file) => file.path === evidencePath);
      if (matches.length !== 1) {
        errors.push(`expected exactly one reviewed Qlib mapping candidate ${evidencePath}, found ${matches.length}`);
      } else {
        const [record] = matches;
        rejectedCandidates.push(record);
        if (record.disposition !== 'reviewedRejected') {
          errors.push(`Qlib mapping candidate must remain reviewedRejected ${evidencePath}`);
        }
        if (record.artifactDigest !== expectedDigest) {
          errors.push(`Qlib evidence digest drift for ${evidencePath}`);
          continue;
        }
        const evidenceFile = path.resolve(root, evidencePath);
        if (!fs.existsSync(evidenceFile)) {
          errors.push(`reviewed Qlib mapping-candidate bytes are absent ${evidencePath}`);
        } else {
          const byteDigest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(evidenceFile)).digest('hex')}`;
          if (byteDigest !== expectedDigest) errors.push(`Qlib evidence bytes drift for ${evidencePath}`);
        }
      }
    }
    const mappings = rejectedCandidates.flatMap((file) => asArray(file.semanticMappings));
    const conflicts = mappings.filter((mapping) => mapping.assessment === 'conflict'
      && mapping.m2Target === `${BASE}FactorObservation`);
    evidence.qlibConflictMappings = conflicts.length;
    if (conflicts.length !== 3) {
      errors.push(`Qlib FactorObservation review must retain exactly three conflict mappings, found ${conflicts.length}`);
    }
    if (conflicts.some((mapping) => !/not equivalent|not encode|not an exact|not a.*mapping/i.test(mapping.rationale || ''))) {
      errors.push('every Qlib conflict mapping must explicitly deny three-axis equivalence');
    }
  } catch (error) {
    errors.push(`Qlib review evidence cannot be verified: ${error.message}`);
  }

  const canonicalEvidencePaths = {
    cqRoot: path.resolve(root, 'tests/m2/cq/strategy-research'),
    executableEvidence: path.resolve(root, 'docs/domain/infrastructure/strategy-research-executable-evidence.json'),
    mappingRoot: path.resolve(root, 'mappings/finance/v0.3.0/strategy-research'),
    replayEvidence: path.resolve(root, 'docs/domain/infrastructure/strategy-research-pit-replay-evidence.json'),
  };
  for (const [name, actual] of Object.entries({ cqRoot, executableEvidence, mappingRoot, replayEvidence })) {
    if (actual !== canonicalEvidencePaths[name]) {
      errors.push(`${name} override is forbidden for the canonical release gate`);
    }
  }
  if (errors.length === 0) {
    const releaseEvidence = require('./strategy-research-release-evidence.cjs');
    let mappingClosure = null;
    try {
      mappingClosure = releaseEvidence.verifyMappingEvidence();
      evidence.semanticMappingDefinitions = mappingClosure.mappingSet.mappings.length;
      evidence.materializedRecords = mappingClosure.output.records.length;
    } catch (error) {
      errors.push(`strategy-research SemanticMappingDefinition closure failed: ${error.message}`);
    }
    try {
      const cqEvidence = releaseEvidence.verifyCqEvidence();
      evidence.cqActivePassed = cqEvidence.queries.filter((row) => row.status === 'passed').length;
      evidence.cqDeferredNonCore = cqEvidence.queries.filter((row) => row.status === 'deferred-non-core').length;
    } catch (error) {
      errors.push(`strategy-research CQ-SR1..SR8 replay failed: ${error.message}`);
    }
    try {
      const pitEvidence = releaseEvidence.verifyPitEvidence(mappingClosure);
      evidence.pitReplaysPassed = pitEvidence.results.filter((row) => row.status === 'passed').length;
    } catch (error) {
      errors.push(`strategy-research three-axis PIT replay failed: ${error.message}`);
    }
    try {
      const formulaEvidence = releaseEvidence.verifyExecutableEvidence();
      evidence.formulaVectorsPassed = formulaEvidence.vectorResults.filter((row) => row.status === 'passed').length;
    } catch (error) {
      errors.push(`strategy-research restricted formula runtime failed: ${error.message}`);
    }
    try {
      evidence.quantityUnits = releaseEvidence.verifyQuantityUnitRegistry().unitCount;
    } catch (error) {
      errors.push(`strategy-research Quantity-unit registry failed: ${error.message}`);
    }
    try {
      releaseEvidence.verifyArtifactManifest();
    } catch (error) {
      errors.push(`strategy-research artifact reference/digest closure failed: ${error.message}`);
    }
  }

  const status = errors.length > 0 ? 'fail' : pending.length > 0 ? 'pending' : 'pass';
  return { status, errors, pending, evidence, modulePath, reviewPath };
}

module.exports = {
  CASE_VALIDATORS,
  validateAttribution,
  validateBacktest,
  validateCalculationContext,
  validateCompletedBacktestResults,
  validateFactorRevision,
  validateFixtureDocument,
  validateGeneratorDefinition,
  validateMetricDefinition,
  validatePerformance,
  validatePerformanceRevision,
  validatePerformanceTrajectory,
  validateResearchRun,
  validateSignal,
  validateSignalSet,
  validateStatusEvent,
  validateStrategyResearchModule,
};
