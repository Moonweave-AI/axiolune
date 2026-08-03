'use strict';

const {
  ARTIFACT_FIELDS,
  authenticateSourceClaims,
  validateAuthenticatedSourceArtifacts,
} = require('./post-trade-risk-source-artifact-inventory.cjs');

const BASE = 'https://axiolune.ai/ontology/finance/risk/';
const EVALUATION_RESULT = `${BASE}RiskLimitEvaluationResult/value/`;
const CURRENCY_DATA = 'https://axiolune.ai/data/currency/';
const MARKET_DATA_STREAM_TYPE = 'https://axiolune.ai/ontology/finance/market-data/MarketDataStream';
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u;

const TYPES = Object.freeze({
  breach: `${BASE}LimitBreach`,
  bucketSchema: `${BASE}RiskBucketSchema`,
  bucketSet: `${BASE}RiskBucketSet`,
  bucketValue: `${BASE}RiskBucketValue`,
  definition: `${BASE}RiskMeasureDefinition`,
  evaluation: `${BASE}RiskLimitEvaluation`,
  limit: `${BASE}RiskLimit`,
  measurement: `${BASE}RiskMeasurement`,
});

const COMMON_REQUIRED = Object.freeze([
  'availableFrom',
  'knowledgeFrom',
  'revision',
  'source',
  'typeIri',
  'validFrom',
  'versionIri',
]);
const COMMON_OPTIONAL = Object.freeze([
  'sourceVersion',
  'validTo',
]);
const ARTIFACT_REQUIRED = Object.freeze([
  'sourceArtifactDigest',
  'sourceArtifactRef',
  'sourceLocator',
]);

class CanonicalRiskRecordError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'CanonicalRiskRecordError';
    this.code = code;
  }
}

function fail(code, detail) {
  throw new CanonicalRiskRecordError(code, detail);
}

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('risk-canonical-record', `${label} must be an object`);
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail('risk-canonical-required-field', `${label}.${key}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('risk-canonical-unknown-field', `${label}.${key}`);
    }
  }
}

function requireIri(value, label) {
  if (typeof value !== 'string' || !ABSOLUTE_IRI.test(value)) {
    fail('risk-canonical-iri', label);
  }
  return value;
}

function commonKeys(artifactRequired = false) {
  return artifactRequired
    ? [...COMMON_REQUIRED, ...ARTIFACT_REQUIRED]
    : [...COMMON_REQUIRED];
}

function commonFromLegacy(record, typeIri, artifactRequired = false) {
  const result = {
    availableFrom: record.axes?.availableFrom,
    knowledgeFrom: record.axes?.knowledgeFrom,
    revision: record.axes?.revision,
    source: record.provenance?.source,
    typeIri,
    validFrom: record.axes?.validFrom,
    versionIri: record.versionIri,
  };
  if (record.axes?.validTo !== undefined) result.validTo = record.axes.validTo;
  if (record.provenance?.sourceVersion !== undefined) {
    result.sourceVersion = record.provenance.sourceVersion;
  }
  if (artifactRequired) {
    result.sourceArtifactRef = record.provenance?.sourceArtifactRef;
    result.sourceArtifactDigest = record.provenance?.sourceArtifactDigest;
    result.sourceLocator = record.provenance?.sourceLocator;
  }
  return result;
}

function internalAxes(record) {
  const result = {
    availableFrom: record.availableFrom,
    knowledgeFrom: record.knowledgeFrom,
    revision: record.revision,
    validFrom: record.validFrom,
  };
  if (record.validTo !== undefined) result.validTo = record.validTo;
  return result;
}

function internalProvenance(record, artifactRequired = false) {
  const result = { source: record.source };
  if (record.sourceVersion !== undefined) result.sourceVersion = record.sourceVersion;
  if (artifactRequired) {
    result.sourceArtifactRef = record.sourceArtifactRef;
    result.sourceArtifactDigest = record.sourceArtifactDigest;
    result.sourceLocator = record.sourceLocator;
  }
  return result;
}

function rolesFromScopes(scopes, prefix) {
  const result = {};
  for (const scope of scopes || []) {
    const suffix = {
      account: 'Account',
      portfolio: 'Portfolio',
      position: 'Position',
    }[scope.kind];
    if (!suffix) fail('risk-canonical-scope-kind', String(scope.kind));
    const field = `${prefix}${suffix}`;
    if (Object.hasOwn(result, field)) fail('risk-canonical-scope-duplicate', field);
    result[field] = scope.ref;
  }
  return result;
}

function scopesFromRoles(record, prefix) {
  const result = [];
  for (const [suffix, kind] of [
    ['Portfolio', 'portfolio'],
    ['Account', 'account'],
    ['Position', 'position'],
  ]) {
    const field = `${prefix}${suffix}`;
    if (record[field] !== undefined) result.push({ kind, ref: record[field] });
  }
  return result;
}

function encodeDefinition(definition) {
  const result = {
    ...commonFromLegacy(definition, TYPES.definition, true),
    implementationDigest: definition.implementationDigest,
    inputContractDigest: definition.inputContractDigest,
    methodDigest: definition.methodDigest,
    methodRef: definition.methodRef,
    methodVersion: definition.methodVersion,
    outputContractDigest: definition.outputContractDigest,
    riskMeasureId: definition.riskMeasureId,
  };
  for (const field of [
    'benchmarkRef',
    'confidenceLevel',
    'observationWindow',
    'riskHorizon',
    'samplingMethodRef',
    'scenarioRef',
  ]) {
    if (definition[field] !== undefined) result[field] = structuredClone(definition[field]);
  }
  if (definition.representation === 'money') {
    result.definitionCurrency = `${CURRENCY_DATA}${definition.currency}`;
  } else if (definition.representation === 'quantity') {
    result.definitionUnit = definition.unit;
  } else if (definition.representation === 'bucket') {
    result.definitionBucketSchema = definition.bucketSchema?.versionIri;
  } else {
    fail('risk-canonical-definition-branch', String(definition.representation));
  }
  return result;
}

function encodeBucketSchema(schema) {
  return {
    ...commonFromLegacy(schema, TYPES.bucketSchema, true),
    bucketDimensionRef: schema.dimensionRef,
    bucketKeyContractDigest: schema.bucketKeyContractDigest,
    bucketSchemaId: schema.bucketSchemaId,
    bucketUnit: schema.unit,
  };
}

function encodeBucketSet(bucketSet) {
  return {
    ...commonFromLegacy(bucketSet, TYPES.bucketSet),
    bucketSetId: bucketSet.bucketSetId,
    bucketSetSchema: bucketSet.schemaVersionIri,
    bucketValueCount: bucketSet.bucketValueCount,
    bucketValueSetDigest: bucketSet.bucketValueSetDigest,
    closureCompleted: bucketSet.closureCompleted,
    closureProbeDigest: bucketSet.closureProbeDigest,
    closureProbeRef: bucketSet.closureProbeRef,
    generatingContextRef: bucketSet.generatingContextRef,
  };
}

function encodeBucketValue(value, bucketSet, schema) {
  return {
    ...commonFromLegacy(value, TYPES.bucketValue),
    bucketKey: value.key,
    bucketQuantity: structuredClone(value.quantity),
    bucketValueDimensionRef: value.dimensionRef,
    bucketValueSchema: schema.versionIri,
    bucketValueSet: bucketSet.versionIri,
    generatingContextRef: value.generatingContextRef,
  };
}

function encodeMeasurement(measurement) {
  const result = {
    ...commonFromLegacy(measurement, TYPES.measurement),
    ...rolesFromScopes(measurement.scopes, 'measurement'),
    generatingContextRef: measurement.generatingContextRef,
    inputContextCompleted: measurement.inputContextCompleted,
    inputContextRecordDigest: measurement.inputContextRecordDigest,
    inputContextRef: measurement.inputContextRef,
    measurementDefinition: measurement.definitionVersionIri,
  };
  if (measurement.marketDataStreamVersionIri !== undefined) {
    result.measurementMarketDataStream = measurement.marketDataStreamVersionIri;
  }
  if (measurement.money !== undefined) result.measuredMoney = structuredClone(measurement.money);
  if (measurement.quantity !== undefined) {
    result.measuredQuantity = structuredClone(measurement.quantity);
  }
  if (measurement.bucketSet !== undefined) {
    result.measurementBucketSet = measurement.bucketSet.versionIri;
  }
  return result;
}

function encodeLimit(limit) {
  const result = {
    ...commonFromLegacy(limit, TYPES.limit, true),
    ...rolesFromScopes(limit.scopes, 'limit'),
    approvalDecisionDigest: limit.approvalDecisionDigest,
    approvalDecisionRef: limit.approvalDecisionRef,
    approvedAt: limit.approvedAt,
    approvedBy: limit.approvedBy,
    limitDefinition: limit.definitionVersionIri,
    limitId: limit.limitId,
    limitOwner: limit.ownerRef,
  };
  if (limit.money !== undefined) result.limitMoney = structuredClone(limit.money);
  if (limit.quantity !== undefined) result.limitQuantity = structuredClone(limit.quantity);
  if (limit.bucketSet !== undefined) result.limitBucketSet = limit.bucketSet.versionIri;
  return result;
}

function encodeEvaluation(evaluation) {
  const result = {
    ...commonFromLegacy(evaluation, TYPES.evaluation),
    evaluatedLimit: evaluation.limitVersionIri,
    evaluatedMeasurement: evaluation.measurementVersionIri,
    evaluationResult: `${EVALUATION_RESULT}${evaluation.result}`,
    evaluatorDigest: evaluation.evaluatorDigest,
    generatingContextRef: evaluation.generatingContextRef,
  };
  if (evaluation.reason !== undefined) result.evaluationReason = evaluation.reason;
  return result;
}

function encodeBreach(breach) {
  return {
    ...commonFromLegacy(breach, TYPES.breach),
    breachEvaluation: breach.evaluationVersionIri,
    breachLimit: breach.limitVersionIri,
    breachMeasurement: breach.measurementVersionIri,
    generatingContextRef: breach.generatingContextRef,
  };
}

function encodeCanonicalRiskScenario(instance) {
  if (!instance || typeof instance !== 'object' || Array.isArray(instance)) {
    fail('risk-canonical-scenario', 'legacy scenario must be an object');
  }
  const records = [encodeDefinition(instance.definition)];
  if (instance.definition?.bucketSchema) records.push(encodeBucketSchema(instance.definition.bucketSchema));
  for (const bucketSet of [
    instance.measurement?.bucketSet,
    instance.limit?.bucketSet,
  ].filter(Boolean)) {
    records.push(encodeBucketSet(bucketSet));
    for (const value of bucketSet.values || []) {
      records.push(encodeBucketValue(value, bucketSet, instance.definition.bucketSchema));
    }
  }
  records.push(
    encodeMeasurement(instance.measurement),
    encodeLimit(instance.limit),
    encodeEvaluation(instance.evaluation),
  );
  if (instance.breach) records.push(encodeBreach(instance.breach));
  return authenticateSourceClaims({
    artifacts: [],
    artifactRecords: structuredClone(instance.artifactRecords || []),
    evidenceRecords: structuredClone(instance.evidenceRecords || []),
    identityRecords: structuredClone(instance.identityRecords || []),
    inputContextRecords: structuredClone(instance.contextRecords || []),
    probeRecords: structuredClone(instance.probeRecords || []),
    referenceRecords: structuredClone(instance.referenceRecords || []),
    records,
    schemaVersion: '1.0',
    temporalClosureRecords: structuredClone(instance.closures || []),
  }, { namespace: 'risk-source' });
}

const RECORD_SCHEMAS = new Map([
  [TYPES.definition, {
    artifact: true,
    required: [
      'implementationDigest',
      'inputContractDigest',
      'methodDigest',
      'methodRef',
      'methodVersion',
      'outputContractDigest',
      'riskMeasureId',
    ],
    optional: [
      'benchmarkRef',
      'confidenceLevel',
      'definitionBucketSchema',
      'definitionCurrency',
      'definitionUnit',
      'observationWindow',
      'riskHorizon',
      'samplingMethodRef',
      'scenarioRef',
    ],
  }],
  [TYPES.bucketSchema, {
    artifact: true,
    required: ['bucketDimensionRef', 'bucketKeyContractDigest', 'bucketSchemaId', 'bucketUnit'],
    optional: [],
  }],
  [TYPES.bucketSet, {
    artifact: false,
    required: [
      'bucketSetId',
      'bucketSetSchema',
      'bucketValueCount',
      'bucketValueSetDigest',
      'closureCompleted',
      'closureProbeDigest',
      'closureProbeRef',
      'generatingContextRef',
    ],
    optional: [],
  }],
  [TYPES.bucketValue, {
    artifact: false,
    required: [
      'bucketKey',
      'bucketQuantity',
      'bucketValueDimensionRef',
      'bucketValueSchema',
      'bucketValueSet',
      'generatingContextRef',
    ],
    optional: [],
  }],
  [TYPES.measurement, {
    artifact: false,
    required: [
      'generatingContextRef',
      'inputContextCompleted',
      'inputContextRecordDigest',
      'inputContextRef',
      'measurementDefinition',
    ],
    optional: [
      'measuredMoney',
      'measuredQuantity',
      'measurementAccount',
      'measurementBucketSet',
      'measurementMarketDataStream',
      'measurementPortfolio',
      'measurementPosition',
    ],
  }],
  [TYPES.limit, {
    artifact: true,
    required: [
      'approvalDecisionDigest',
      'approvalDecisionRef',
      'approvedAt',
      'approvedBy',
      'limitDefinition',
      'limitId',
      'limitOwner',
    ],
    optional: [
      'limitAccount',
      'limitBucketSet',
      'limitMoney',
      'limitPortfolio',
      'limitPosition',
      'limitQuantity',
    ],
  }],
  [TYPES.evaluation, {
    artifact: false,
    required: [
      'evaluatedLimit',
      'evaluatedMeasurement',
      'evaluationResult',
      'evaluatorDigest',
      'generatingContextRef',
    ],
    optional: ['evaluationReason'],
  }],
  [TYPES.breach, {
    artifact: false,
    required: [
      'breachEvaluation',
      'breachLimit',
      'breachMeasurement',
      'generatingContextRef',
    ],
    optional: [],
  }],
]);

const AUXILIARY_RECORD_SCHEMAS = Object.freeze({
  artifactRecords: Object.freeze({
    required: Object.freeze([
      'artifactDigest',
      'artifactPath',
      'artifactRef',
      'artifactRole',
      'artifactSelector',
      'subjectVersionIri',
    ]),
    optional: Object.freeze([
      'sourceLocator',
    ]),
  }),
  evidenceRecords: Object.freeze({
    required: Object.freeze([
      'artifactDigest',
      'artifactRef',
      'evidenceRef',
      'sourceLocator',
    ]),
    optional: Object.freeze([]),
  }),
  inputContextRecords: Object.freeze({
    required: Object.freeze([
      'completedAt',
      'contextRef',
      'recordDigest',
      'recordPath',
      'recordSelector',
      'status',
    ]),
    optional: Object.freeze([]),
  }),
  identityRecords: Object.freeze({
    required: Object.freeze([
      'identityDigest',
      'identityPath',
      'identitySelector',
      'logicalIri',
      'riskMeasureId',
      'versionIri',
      'versionOf',
    ]),
    optional: Object.freeze([]),
  }),
  probeRecords: Object.freeze({
    required: Object.freeze([
      'bucketSetVersionIri',
      'completedAt',
      'generatingContextRef',
      'inputContextRecordDigest',
      'inputContextRef',
      'probeDigest',
      'probePath',
      'probeRef',
      'probeSelector',
      'status',
      'subjectSetDigest',
      'subjectVersionIris',
    ]),
    optional: Object.freeze([]),
  }),
  referenceRecords: Object.freeze({
    required: Object.freeze([
      'availableFrom',
      'knowledgeFrom',
      'recordDigest',
      'recordPath',
      'recordSelector',
      'revision',
      'source',
      'typeIri',
      'validFrom',
      'versionIri',
    ]),
    optional: Object.freeze([
      'validTo',
    ]),
  }),
  temporalClosureRecords: Object.freeze({
    required: Object.freeze([
      'axis',
      'causeKind',
      'closedAt',
      'evidenceRef',
      'generatingContextRef',
      'targetVersionIri',
    ]),
    optional: Object.freeze([
      'causeVersionIri',
    ]),
  }),
});

function canonicalRiskInputContract() {
  return {
    auxiliaryRecordSchemas: Object.fromEntries(
      Object.entries(AUXILIARY_RECORD_SCHEMAS).map(([field, schema]) => [
        field,
        {
          optionalFields: [...schema.optional].sort(),
          requiredFields: [...schema.required].sort(),
        },
      ]),
    ),
    canonicalEncoding: 'RFC8785-JCS',
    contractId: 'axiolune-risk-custom-canonical-record-input-v1',
    recordDiscriminator: 'typeIri',
    recordSchemas: [...RECORD_SCHEMAS.entries()]
      .map(([typeIri, schema]) => ({
        optionalFields: [...COMMON_OPTIONAL, ...schema.optional].sort(),
        requiredFields: [...commonKeys(schema.artifact), ...schema.required].sort(),
        typeIri,
      }))
      .sort((left, right) => Buffer.compare(
        Buffer.from(left.typeIri, 'utf8'),
        Buffer.from(right.typeIri, 'utf8'),
      )),
    schemaVersion: '1.0',
    sourceArtifactInventorySchema: {
      artifactFields: [...ARTIFACT_FIELDS],
      exactCoverage: true,
      exactRefJoin: true,
      ordering: 'strict-artifact-ref-utf8',
      selectedBytes: 'json-pointer-jcs-v1',
    },
    topLevelOptionalFields: [],
    topLevelRequiredFields: [
      'artifactRecords',
      'artifacts',
      'evidenceRecords',
      'identityRecords',
      'inputContextRecords',
      'probeRecords',
      'referenceRecords',
      'records',
      'schemaVersion',
      'temporalClosureRecords',
    ],
    unknownFields: 'fatal',
  };
}

function validateRecordSchema(record, index) {
  requireIri(record?.typeIri, `records[${index}].typeIri`);
  const schema = RECORD_SCHEMAS.get(record.typeIri);
  if (!schema) fail('risk-canonical-type', record.typeIri);
  exactKeys(
    record,
    [...commonKeys(schema.artifact), ...schema.required],
    [...COMMON_OPTIONAL, ...schema.optional],
    `records[${index}]`,
  );
  requireIri(record.versionIri, `records[${index}].versionIri`);
  requireIri(record.source, `records[${index}].source`);
}

function validateAuxiliaryRecords(document) {
  for (const [field, schema] of Object.entries(AUXILIARY_RECORD_SCHEMAS)) {
    const rows = document[field];
    if (!Array.isArray(rows)) fail('risk-canonical-scenario', field);
    for (const [index, record] of rows.entries()) {
      exactKeys(
        record,
        schema.required,
        schema.optional,
        `${field}[${index}]`,
      );
    }
  }
}

function singleton(byType, typeIri, label, optional = false) {
  const rows = byType.get(typeIri) || [];
  if (rows.length !== (optional ? 0 : 1) && !(optional && rows.length === 1)) {
    fail('risk-canonical-cardinality', `${label} count=${rows.length}`);
  }
  return rows[0];
}

function decodeDefinition(record, recordsByVersion) {
  const branches = ['definitionCurrency', 'definitionUnit', 'definitionBucketSchema']
    .filter((field) => record[field] !== undefined);
  if (branches.length !== 1) fail('definition-representation-xone', branches.join(','));
  const result = {
    axes: internalAxes(record),
    implementationDigest: record.implementationDigest,
    inputContractDigest: record.inputContractDigest,
    methodDigest: record.methodDigest,
    methodRef: record.methodRef,
    methodVersion: record.methodVersion,
    outputContractDigest: record.outputContractDigest,
    provenance: internalProvenance(record, true),
    riskMeasureId: record.riskMeasureId,
    versionIri: record.versionIri,
  };
  for (const field of [
    'benchmarkRef',
    'confidenceLevel',
    'observationWindow',
    'riskHorizon',
    'samplingMethodRef',
    'scenarioRef',
  ]) {
    if (record[field] !== undefined) result[field] = structuredClone(record[field]);
  }
  if (branches[0] === 'definitionCurrency') {
    requireIri(record.definitionCurrency, 'definitionCurrency');
    if (!record.definitionCurrency.startsWith(CURRENCY_DATA)) {
      fail('risk-canonical-currency', record.definitionCurrency);
    }
    result.representation = 'money';
    result.currency = record.definitionCurrency.slice(CURRENCY_DATA.length);
  } else if (branches[0] === 'definitionUnit') {
    result.representation = 'quantity';
    result.unit = requireIri(record.definitionUnit, 'definitionUnit');
  } else {
    const schema = recordsByVersion.get(record.definitionBucketSchema);
    if (schema?.typeIri !== TYPES.bucketSchema) {
      fail('risk-canonical-reference', 'definitionBucketSchema');
    }
    result.representation = 'bucket';
    result.bucketSchema = decodeBucketSchema(schema);
  }
  return result;
}

function decodeBucketSchema(record) {
  return {
    axes: internalAxes(record),
    bucketKeyContractDigest: record.bucketKeyContractDigest,
    bucketSchemaId: record.bucketSchemaId,
    dimensionRef: record.bucketDimensionRef,
    provenance: internalProvenance(record, true),
    unit: record.bucketUnit,
    versionIri: record.versionIri,
  };
}

function decodeBucketSet(record, recordsByVersion, bucketValuesBySet) {
  const schema = recordsByVersion.get(record.bucketSetSchema);
  if (schema?.typeIri !== TYPES.bucketSchema) fail('risk-canonical-reference', 'bucketSetSchema');
  const values = (bucketValuesBySet.get(record.versionIri) || []).map((value) => {
    if (value.bucketValueSchema !== record.bucketSetSchema) {
      fail('risk-canonical-reference', 'bucketValueSchema');
    }
    return {
      axes: internalAxes(value),
      dimensionRef: value.bucketValueDimensionRef,
      generatingContextRef: value.generatingContextRef,
      key: value.bucketKey,
      provenance: internalProvenance(value),
      quantity: structuredClone(value.bucketQuantity),
      versionIri: value.versionIri,
    };
  });
  return {
    axes: internalAxes(record),
    bucketSetId: record.bucketSetId,
    bucketValueCount: record.bucketValueCount,
    bucketValueSetDigest: record.bucketValueSetDigest,
    closureCompleted: record.closureCompleted,
    closureProbeDigest: record.closureProbeDigest,
    closureProbeRef: record.closureProbeRef,
    generatingContextRef: record.generatingContextRef,
    provenance: internalProvenance(record),
    schemaVersionIri: record.bucketSetSchema,
    values,
    versionIri: record.versionIri,
  };
}

function decodeMeasurement(record, recordsByVersion, bucketValuesBySet) {
  const result = {
    axes: internalAxes(record),
    definitionVersionIri: record.measurementDefinition,
    generatingContextRef: record.generatingContextRef,
    inputContextCompleted: record.inputContextCompleted,
    inputContextRecordDigest: record.inputContextRecordDigest,
    inputContextRef: record.inputContextRef,
    provenance: internalProvenance(record),
    scopes: scopesFromRoles(record, 'measurement'),
    versionIri: record.versionIri,
  };
  if (record.measurementMarketDataStream !== undefined) {
    result.marketDataStreamVersionIri = record.measurementMarketDataStream;
  }
  if (record.measuredMoney !== undefined) result.money = structuredClone(record.measuredMoney);
  if (record.measuredQuantity !== undefined) {
    result.quantity = structuredClone(record.measuredQuantity);
  }
  if (record.measurementBucketSet !== undefined) {
    const bucketSet = recordsByVersion.get(record.measurementBucketSet);
    if (bucketSet?.typeIri !== TYPES.bucketSet) {
      fail('risk-canonical-reference', 'measurementBucketSet');
    }
    result.bucketSet = decodeBucketSet(bucketSet, recordsByVersion, bucketValuesBySet);
  }
  return result;
}

function decodeLimit(record, recordsByVersion, bucketValuesBySet) {
  const result = {
    approvalDecisionDigest: record.approvalDecisionDigest,
    approvalDecisionRef: record.approvalDecisionRef,
    approvedAt: record.approvedAt,
    approvedBy: record.approvedBy,
    axes: internalAxes(record),
    definitionVersionIri: record.limitDefinition,
    limitId: record.limitId,
    ownerRef: record.limitOwner,
    provenance: internalProvenance(record, true),
    scopes: scopesFromRoles(record, 'limit'),
    versionIri: record.versionIri,
  };
  if (record.limitMoney !== undefined) result.money = structuredClone(record.limitMoney);
  if (record.limitQuantity !== undefined) result.quantity = structuredClone(record.limitQuantity);
  if (record.limitBucketSet !== undefined) {
    const bucketSet = recordsByVersion.get(record.limitBucketSet);
    if (bucketSet?.typeIri !== TYPES.bucketSet) {
      fail('risk-canonical-reference', 'limitBucketSet');
    }
    result.bucketSet = decodeBucketSet(bucketSet, recordsByVersion, bucketValuesBySet);
  }
  return result;
}

function decodeEvaluation(record) {
  if (typeof record.evaluationResult !== 'string'
      || !record.evaluationResult.startsWith(EVALUATION_RESULT)) {
    fail('risk-canonical-code-value', 'evaluationResult');
  }
  const result = {
    axes: internalAxes(record),
    evaluatorDigest: record.evaluatorDigest,
    generatingContextRef: record.generatingContextRef,
    limitVersionIri: record.evaluatedLimit,
    measurementVersionIri: record.evaluatedMeasurement,
    provenance: internalProvenance(record),
    result: record.evaluationResult.slice(EVALUATION_RESULT.length),
    versionIri: record.versionIri,
  };
  if (record.evaluationReason !== undefined) result.reason = record.evaluationReason;
  return result;
}

function decodeBreach(record) {
  return {
    axes: internalAxes(record),
    evaluationVersionIri: record.breachEvaluation,
    generatingContextRef: record.generatingContextRef,
    limitVersionIri: record.breachLimit,
    measurementVersionIri: record.breachMeasurement,
    provenance: internalProvenance(record),
    versionIri: record.versionIri,
  };
}

function decodeCanonicalRiskScenario(document) {
  exactKeys(
    document,
    [
      'artifacts',
      'evidenceRecords',
      'artifactRecords',
      'identityRecords',
      'inputContextRecords',
      'probeRecords',
      'referenceRecords',
      'records',
      'schemaVersion',
      'temporalClosureRecords',
    ],
    [],
    'scenario',
  );
  if (document.schemaVersion !== '1.0' || !Array.isArray(document.records)) {
    fail('risk-canonical-scenario', 'schemaVersion/records');
  }
  validateAuthenticatedSourceArtifacts(document);
  validateAuxiliaryRecords(document);
  const byType = new Map();
  const recordsByVersion = new Map();
  const bucketValuesBySet = new Map();
  for (const [index, record] of document.records.entries()) {
    validateRecordSchema(record, index);
    if (recordsByVersion.has(record.versionIri)) {
      fail('risk-canonical-duplicate-version', record.versionIri);
    }
    recordsByVersion.set(record.versionIri, record);
    const rows = byType.get(record.typeIri) || [];
    rows.push(record);
    byType.set(record.typeIri, rows);
    if (record.typeIri === TYPES.bucketValue) {
      const values = bucketValuesBySet.get(record.bucketValueSet) || [];
      values.push(record);
      bucketValuesBySet.set(record.bucketValueSet, values);
    }
  }
  const definitionRecord = singleton(byType, TYPES.definition, 'RiskMeasureDefinition');
  const measurementRecord = singleton(byType, TYPES.measurement, 'RiskMeasurement');
  const limitRecord = singleton(byType, TYPES.limit, 'RiskLimit');
  const evaluationRecord = singleton(byType, TYPES.evaluation, 'RiskLimitEvaluation');
  const breachRecord = singleton(byType, TYPES.breach, 'LimitBreach', true);
  for (const typeIri of [TYPES.bucketSchema, TYPES.bucketSet, TYPES.bucketValue]) {
    for (const row of byType.get(typeIri) || []) {
      if (typeIri === TYPES.bucketValue
          && recordsByVersion.get(row.bucketValueSet)?.typeIri !== TYPES.bucketSet) {
        fail('risk-canonical-reference', 'bucketValueSet');
      }
    }
  }
  const instance = {
    artifactRecords: structuredClone(document.artifactRecords),
    bucketValueCandidates: (byType.get(TYPES.bucketValue) || []).map((record) => ({
      axes: internalAxes(record),
      bucketSetVersionIri: record.bucketValueSet,
      dimensionRef: record.bucketValueDimensionRef,
      generatingContextRef: record.generatingContextRef,
      key: record.bucketKey,
      provenance: internalProvenance(record),
      quantity: structuredClone(record.bucketQuantity),
      schemaVersionIri: record.bucketValueSchema,
      versionIri: record.versionIri,
    })),
    closures: structuredClone(document.temporalClosureRecords),
    contextRecords: structuredClone(document.inputContextRecords),
    definition: decodeDefinition(definitionRecord, recordsByVersion),
    evidenceRecords: structuredClone(document.evidenceRecords),
    identityRecords: structuredClone(document.identityRecords),
    evaluation: decodeEvaluation(evaluationRecord),
    limit: decodeLimit(limitRecord, recordsByVersion, bucketValuesBySet),
    measurement: decodeMeasurement(measurementRecord, recordsByVersion, bucketValuesBySet),
    probeRecords: structuredClone(document.probeRecords),
    referenceRecords: structuredClone(document.referenceRecords),
  };
  if (breachRecord) instance.breach = decodeBreach(breachRecord);
  return instance;
}

module.exports = {
  CanonicalRiskRecordError,
  MARKET_DATA_STREAM_TYPE,
  TYPES,
  canonicalRiskInputContract,
  decodeCanonicalRiskScenario,
  encodeCanonicalRiskScenario,
};
