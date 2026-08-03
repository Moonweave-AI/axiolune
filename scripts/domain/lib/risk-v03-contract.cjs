'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalJcs,
  computeSelectionDigest,
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');
const {
  MARKET_DATA_STREAM_TYPE,
  decodeCanonicalRiskScenario,
} = require('./risk-canonical-record-adapter.cjs');

const BASE = 'https://axiolune.ai/ontology/finance/risk/';
const FINANCE = 'https://axiolune.ai/ontology/finance/';
const LOGICAL = 'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference';
const EXACT = 'https://axiolune.ai/ontology/meta/core/constraints/ExactVersionReference';
const TEMPORAL = 'https://axiolune.ai/ontology/meta/patterns/TemporalFact';
const PROVENANCED = 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact';
const DATA_BINDING_ATTRIBUTES = 'https://axiolune.ai/ontology/meta/data-binding/attributes/';
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u;
const EXACT_VERSION_IRI = /\/version\/[A-Za-z0-9._~:-]+$/u;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const CANONICAL_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const ROOT = path.resolve(__dirname, '..', '..', '..');
const RISK_EVIDENCE_PATH = 'tests/m2/fixtures/risk-evidence-v1.json';
const RISK_RETRACTION_EVIDENCE_PATH = 'tests/m2/fixtures/risk-measurement-retraction-v1.json';
const RISK_BUCKET_KEY_CONTRACT_PATH = 'tests/m2/fixtures/risk-bucket-key-contract-v1.json';
const WHOLE_FILE_PROFILE_PATH = 'scripts/domain/reference-extractors/whole-file-v1.json';
const RISK_IMPLEMENTATION_PATH = 'scripts/domain/lib/risk-v03-contract.cjs';
const RISK_INPUT_CONTRACT_PATH = 'scripts/domain/risk-custom-profile/v0.3.0/input-contract.json';
const RISK_OUTPUT_CONTRACT_PATH = 'scripts/domain/risk-custom-profile/v0.3.0/output-contract.json';

function loadYaml(file) {
  const fs = require('node:fs');
  const yaml = require('js-yaml');
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

function approvalDecisionDigest(record) {
  return sha256Bytes(Buffer.from(canonicalJcs({
    approvalDecisionRef: record.approvalDecisionRef,
    approvedAt: record.approvedAt,
    approvedBy: record.approvedBy,
    limitVersionIri: record.versionIri,
  }), 'utf8'));
}

function rolePredicate(associationIri, roleId) {
  return `${associationIri}/role/${roleId}`;
}

function roles(element) {
  return new Map((element?.participantRoles || []).map((role) => [role.id, role]));
}

function attributes(element) {
  return new Map((element?.attributeUses || []).map((use) => [use.attribute, use]));
}

function exactCardinality(item, minCount, maxCount) {
  return item?.minCount === minCount && item?.maxCount === maxCount;
}

function sameSet(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function requireInventory(document, container, names, errors) {
  const present = new Set(Object.keys(document.domain?.[container] || {}));
  for (const name of names) {
    if (!present.has(name)) errors.push(`missing domain.${container}.${name}`);
  }
}

function validatePatterns(document, errors) {
  for (const container of ['objectTypes', 'associationTypes']) {
    for (const [name, element] of Object.entries(document.domain?.[container] || {})) {
      const patterns = (element.patternBindings || []).map((binding) => binding.pattern);
      if (patterns.filter((pattern) => pattern === TEMPORAL).length !== 1) {
        errors.push(`${container}.${name} must bind TemporalFact exactly once`);
      }
      if (patterns.filter((pattern) => pattern === PROVENANCED).length !== 1) {
        errors.push(`${container}.${name} must bind ProvenancedFact exactly once`);
      }
    }
  }
}

function validateRoleMetadataAndModes(document, errors) {
  const bindings = new Map();
  for (const binding of document.domain?.constraintBindings || []) {
    if (![LOGICAL, EXACT].includes(binding.constraintRef)) continue;
    const values = bindings.get(binding.targetElement) || [];
    values.push(binding.constraintRef);
    bindings.set(binding.targetElement, values);
  }
  for (const [associationName, association] of Object.entries(
    document.domain?.associationTypes || {},
  )) {
    for (const role of association.participantRoles || []) {
      if (!/^[a-z][A-Za-z0-9]*$/u.test(role.id || '')) {
        errors.push(`${associationName}.${String(role.id)} is not lowerCamelCase`);
      }
      if (typeof role.label !== 'string' || role.label.trim() === '') {
        errors.push(`${associationName}.${role.id} has no label`);
      }
      if (typeof role.definition !== 'string' || role.definition.trim() === '') {
        errors.push(`${associationName}.${role.id} has no definition`);
      }
      const predicate = rolePredicate(association.iri, role.id);
      const modes = bindings.get(predicate) || [];
      if (modes.length !== 1) {
        errors.push(`${predicate} must have exactly one reference mode`);
      }
    }
  }
  for (const [index, use] of (document.domain?.relationUses || []).entries()) {
    const modes = (use.constraints || []).filter((binding) => (
      binding.constraintRef === LOGICAL || binding.constraintRef === EXACT
    ));
    if (modes.length !== 1 || modes[0].targetElement !== use.relation) {
      errors.push(`relationUses[${index}] must have one inline reference mode`);
    }
  }
}

function requireRole(document, associationName, roleId, range, min, max, errors) {
  const role = roles(document.domain?.associationTypes?.[associationName]).get(roleId);
  if (!role || role.range !== range || !exactCardinality(role, min, max)) {
    errors.push(
      `${associationName}.${roleId} must be ${range} ${min}..${String(max)}`,
    );
  }
}

function requireAttribute(document, container, owner, attributeName, min, max, errors) {
  requireAttributeIri(document, container, owner, `${BASE}${attributeName}`, min, max, errors);
}

function requireAttributeIri(document, container, owner, attributeIri, min, max, errors) {
  const use = attributes(document.domain?.[container]?.[owner]).get(attributeIri);
  if (!exactCardinality(use, min, max)) {
    errors.push(`${owner}.${attributeIri} must be ${min}..${String(max)}`);
  }
}

function validateRiskModule(document) {
  const errors = [];
  const pending = [];
  if (document.module?.status !== 'approved') errors.push('risk module must be approved at v1.0.0');
  if (document.module?.version !== '1.0.0') errors.push('risk module must be v1.0.0');
  const expectedImports = [
    `${FINANCE}foundation`,
    `${FINANCE}market-data`,
    `${FINANCE}portfolio-positions`,
  ];
  if (!sameSet(
    (document.module?.imports || []).map((entry) => entry.moduleIri),
    expectedImports,
  )) {
    errors.push('risk direct import set does not equal RFC-001 section 5.10.1');
  }

  requireInventory(document, 'objectTypes', [
    'RiskMeasureDefinition',
    'RiskBucketSchema',
    'RiskBucketSet',
    'ScenarioDefinition',
  ], errors);
  requireInventory(document, 'associationTypes', [
    'RiskBucketValue',
    'RiskMeasurement',
    'RiskLimit',
    'RiskLimitEvaluation',
    'LimitBreach',
    'StressTestRun',
  ], errors);
  requireInventory(document, 'relationTypes', [
    'definitionCurrency',
    'definitionBucketSchema',
    'bucketSetSchema',
  ], errors);
  requireInventory(document, 'codeLists', ['RiskLimitEvaluationResult'], errors);
  requireInventory(document, 'constraints', [
    'RiskMeasureDefinitionRepresentationXone',
    'RiskMeasurementValueXone',
    'RiskLimitValueXone',
    'RiskMeasureDefinitionContract',
    'RiskBucketSchemaContract',
    'RiskBucketSetClosureContract',
    'RiskBucketValueContract',
    'RiskMeasurementContract',
    'RiskLimitContract',
    'RiskLimitEvaluationContract',
    'LimitBreachContract',
    'ScenarioDefinitionContract',
    'StressTestRunContract',
  ], errors);
  validatePatterns(document, errors);
  validateRoleMetadataAndModes(document, errors);

  requireRole(
    document,
    'RiskBucketValue',
    'bucketValueSet',
    `${BASE}RiskBucketSet`,
    1,
    1,
    errors,
  );
  requireRole(
    document,
    'RiskBucketValue',
    'bucketValueSchema',
    `${BASE}RiskBucketSchema`,
    1,
    1,
    errors,
  );
  const measurementRoles = {
    measurementDefinition: [`${BASE}RiskMeasureDefinition`, 1, 1],
    measurementPortfolio: [`${FINANCE}portfolio-positions/Portfolio`, 0, 1],
    measurementAccount: [`${FINANCE}foundation/FinancialAccount`, 0, 1],
    measurementPosition: [`${FINANCE}portfolio-positions/PositionSnapshot`, 0, 1],
    measurementMarketDataStream: [`${FINANCE}market-data/MarketDataStream`, 0, 1],
    measurementBucketSet: [`${BASE}RiskBucketSet`, 0, 1],
  };
  for (const [roleId, [range, min, max]] of Object.entries(measurementRoles)) {
    requireRole(document, 'RiskMeasurement', roleId, range, min, max, errors);
  }
  const limitRoles = {
    limitDefinition: [`${BASE}RiskMeasureDefinition`, 1, 1],
    limitPortfolio: [`${FINANCE}portfolio-positions/Portfolio`, 0, 1],
    limitAccount: [`${FINANCE}foundation/FinancialAccount`, 0, 1],
    limitPosition: [`${FINANCE}portfolio-positions/PositionSnapshot`, 0, 1],
    limitOwner: [`${FINANCE}foundation/Party`, 1, 1],
    limitBucketSet: [`${BASE}RiskBucketSet`, 0, 1],
  };
  for (const [roleId, [range, min, max]] of Object.entries(limitRoles)) {
    requireRole(document, 'RiskLimit', roleId, range, min, max, errors);
  }
  for (const [roleId, range] of Object.entries({
    evaluatedMeasurement: `${BASE}RiskMeasurement`,
    evaluatedLimit: `${BASE}RiskLimit`,
  })) {
    requireRole(document, 'RiskLimitEvaluation', roleId, range, 1, 1, errors);
  }
  for (const [roleId, range] of Object.entries({
    breachEvaluation: `${BASE}RiskLimitEvaluation`,
    breachMeasurement: `${BASE}RiskMeasurement`,
    breachLimit: `${BASE}RiskLimit`,
  })) {
    requireRole(document, 'LimitBreach', roleId, range, 1, 1, errors);
  }
  for (const [roleId, [range, min, max]] of Object.entries({
    stressRunScenario: [`${BASE}ScenarioDefinition`, 1, 1],
    stressRunPortfolio: [`${FINANCE}portfolio-positions/Portfolio`, 1, 1],
    stressRunOutput: [`${BASE}RiskMeasurement`, 1, 1],
  })) {
    requireRole(document, 'StressTestRun', roleId, range, min, max, errors);
  }

  for (const [name, cardinality] of Object.entries({
    measuredMoney: [0, 1],
    measuredQuantity: [0, 1],
    inputContextCompleted: [1, 1],
  })) {
    requireAttribute(
      document,
      'associationTypes',
      'RiskMeasurement',
      name,
      cardinality[0],
      cardinality[1],
      errors,
    );
  }
  const localAttributeContracts = {
    RiskMeasureDefinition: {
      riskMeasureId: [1, 1],
      methodRef: [1, 1],
      methodVersion: [1, 1],
      methodDigest: [1, 1],
      implementationDigest: [1, 1],
      inputContractDigest: [1, 1],
      outputContractDigest: [1, 1],
      definitionUnit: [0, 1],
    },
    RiskBucketSchema: {
      bucketSchemaId: [1, 1],
      bucketDimensionRef: [1, 1],
      bucketKeyContractDigest: [1, 1],
      bucketUnit: [1, 1],
    },
    RiskBucketSet: {
      bucketSetId: [1, 1],
      bucketValueCount: [1, 1],
      bucketValueSetDigest: [1, 1],
      closureProbeRef: [1, 1],
      closureProbeDigest: [1, 1],
      closureCompleted: [1, 1],
    },
    RiskBucketValue: {
      bucketKey: [1, 1],
      bucketValueDimensionRef: [1, 1],
      bucketQuantity: [1, 1],
    },
    RiskMeasurement: {
      measuredMoney: [0, 1],
      measuredQuantity: [0, 1],
      inputContextCompleted: [1, 1],
    },
    RiskLimit: {
      limitId: [1, 1],
      limitMoney: [0, 1],
      limitQuantity: [0, 1],
      approvalDecisionRef: [1, 1],
      approvalDecisionDigest: [1, 1],
      approvedBy: [1, 1],
      approvedAt: [1, 1],
    },
    RiskLimitEvaluation: {
      evaluationResult: [1, 1],
      evaluationReason: [0, 1],
      evaluatorDigest: [1, 1],
    },
    ScenarioDefinition: {
      scenarioDefinitionId: [1, 1],
      shockParameterDigest: [1, 1],
    },
    StressTestRun: {
      stressRunId: [1, 1],
    },
  };
  for (const [owner, contract] of Object.entries(localAttributeContracts)) {
    const container = Object.hasOwn(document.domain?.objectTypes || {}, owner)
      ? 'objectTypes' : 'associationTypes';
    for (const [name, [min, max]] of Object.entries(contract)) {
      requireAttribute(document, container, owner, name, min, max, errors);
    }
  }
  const externalAttributeContracts = {
    RiskMeasureDefinition: ['sourceArtifactRef', 'sourceArtifactDigest', 'sourceLocator'],
    RiskBucketSchema: ['sourceArtifactRef', 'sourceArtifactDigest', 'sourceLocator'],
    RiskBucketSet: ['generatingContextRef'],
    RiskBucketValue: ['generatingContextRef'],
    RiskMeasurement: ['inputContextRef', 'inputContextRecordDigest', 'generatingContextRef'],
    RiskLimit: ['sourceArtifactRef', 'sourceArtifactDigest', 'sourceLocator'],
    RiskLimitEvaluation: ['generatingContextRef'],
    LimitBreach: ['generatingContextRef'],
    ScenarioDefinition: ['sourceArtifactRef', 'sourceArtifactDigest', 'sourceLocator'],
    StressTestRun: ['generatingContextRef'],
  };
  for (const [owner, names] of Object.entries(externalAttributeContracts)) {
    const container = Object.hasOwn(document.domain?.objectTypes || {}, owner)
      ? 'objectTypes' : 'associationTypes';
    for (const name of names) {
      requireAttributeIri(
        document,
        container,
        owner,
        `${DATA_BINDING_ATTRIBUTES}${name}`,
        1,
        1,
        errors,
      );
    }
  }
  for (const [name, cardinality] of Object.entries({
    limitMoney: [0, 1],
    limitQuantity: [0, 1],
    approvalDecisionRef: [1, 1],
    approvalDecisionDigest: [1, 1],
    approvedBy: [1, 1],
    approvedAt: [1, 1],
  })) {
    requireAttribute(
      document,
      'associationTypes',
      'RiskLimit',
      name,
      cardinality[0],
      cardinality[1],
      errors,
    );
  }

  const xones = {
    RiskMeasureDefinitionRepresentationXone:
      'sh:xone(definitionCurrency,definitionUnit,definitionBucketSchema)',
    RiskMeasurementValueXone:
      'sh:xone(measuredMoney,measuredQuantity,measurementBucketSet)',
    RiskLimitValueXone:
      'sh:xone(limitMoney,limitQuantity,limitBucketSet)',
  };
  for (const [name, expression] of Object.entries(xones)) {
    const constraint = document.domain?.constraints?.[name];
    if (constraint?.expression?.language !== 'SHACL'
        || constraint.expression.expression !== expression) {
      errors.push(`${name} does not use the exact compiler-supported xone`);
    }
    const matches = (document.domain?.constraintBindings || []).filter(
      (binding) => binding.constraintRef === constraint?.iri
        && binding.targetElement === constraint?.targetElement,
    );
    if (matches.length !== 1) errors.push(`${name} must have one matching binding`);
  }
  for (const [name, constraint] of Object.entries(document.domain?.constraints || {})) {
    if (!Object.prototype.hasOwnProperty.call(xones, name)
        && constraint.expression?.language !== 'Custom') {
      errors.push(`${name} must not masquerade as compiled SHACL`);
    }
  }

  const results = (document.domain?.codeLists?.RiskLimitEvaluationResult?.values || [])
    .map((member) => member.notation);
  if (!sameSet(results, ['withinLimit', 'breach', 'indeterminate'])) {
    errors.push('RiskLimitEvaluationResult is not the exact closed RFC set');
  }
  for (const [name, codeList] of Object.entries(document.domain?.codeLists || {})) {
    if (String(codeList.sourceEvidenceRef || '').startsWith(
      'https://axiolune.ai/pending-source-evidence/',
    )) {
      pending.push(`${name}.sourceEvidenceRef remains unresolved`);
    }
  }
  return { errors, pending };
}

class RiskContractViolation extends Error {
  constructor(code) {
    super(code);
    this.name = 'RiskContractViolation';
    this.code = code;
  }
}

function invariant(condition, code) {
  if (!condition) {
    throw new RiskContractViolation(code);
  }
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readLockedEvidenceSelection(relativePath, selector, code) {
  invariant(relativePath === RISK_EVIDENCE_PATH, code);
  invariant(
    typeof selector === 'string'
      && /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/u.test(selector),
    code,
  );
  const file = path.resolve(ROOT, ...relativePath.split('/'));
  invariant(file === path.resolve(ROOT, 'tests', 'm2', 'fixtures', 'risk-evidence-v1.json'), code);
  let document;
  try {
    document = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    invariant(false, code);
  }
  let payload = document;
  for (const token of selector.split('.')) {
    invariant(payload && typeof payload === 'object' && Object.hasOwn(payload, token), code);
    payload = payload[token];
  }
  const bytes = Buffer.from(canonicalJcs(payload), 'utf8');
  return { bytes, payload };
}

function exactPayload(actual, expected, code) {
  invariant(canonicalJcs(actual) === canonicalJcs(expected), code);
}

function readLockedArtifact(record, expected, code) {
  invariant(record.artifactPath === expected.artifactPath, code);
  if (expected.artifactSelector !== undefined) {
    invariant(record.artifactSelector === expected.artifactSelector, code);
  }
  if (record.artifactSelector !== '$wholeFile') {
    invariant(record.artifactPath === RISK_EVIDENCE_PATH, code);
    return readLockedEvidenceSelection(record.artifactPath, record.artifactSelector, code);
  }
  invariant(new Set([
    RISK_IMPLEMENTATION_PATH,
    RISK_INPUT_CONTRACT_PATH,
    RISK_OUTPUT_CONTRACT_PATH,
  ]).has(record.artifactPath), code);
  const file = path.resolve(ROOT, ...record.artifactPath.split('/'));
  invariant(file.startsWith(`${ROOT}${path.sep}`), code);
  try {
    return { bytes: fs.readFileSync(file) };
  } catch {
    invariant(false, code);
  }
  return null;
}

function validateArtifactRecord(instance, subjectVersionIri, artifactRole, expected) {
  const code = 'definition-artifact-evidence';
  invariant(Array.isArray(instance.artifactRecords), code);
  const matches = instance.artifactRecords.filter((record) => (
    record?.subjectVersionIri === subjectVersionIri && record?.artifactRole === artifactRole
  ));
  invariant(matches.length === 1, code);
  const record = matches[0];
  invariant(
    typeof record.artifactPath === 'string'
      && typeof record.artifactSelector === 'string',
    code,
  );
  invariant(validateArtifactRef(record.artifactRef).ok, code);
  if (record.sourceLocator !== undefined) {
    invariant(validateSourceLocator(record.sourceLocator).ok, code);
    invariant(record.sourceLocator.path === record.artifactPath, code);
    invariant(record.sourceLocator.selectionDigest === record.artifactDigest, code);
    if (record.sourceLocator.kind === 'jsonPointer') {
      invariant(
        record.sourceLocator.pointer === `/${record.artifactSelector.replaceAll('.', '/')}`,
        code,
      );
    }
  }
  invariant(SHA256.test(record.artifactDigest || ''), code);
  if (expected.artifactRef !== undefined) {
    invariant(canonicalJcs(record.artifactRef) === canonicalJcs(expected.artifactRef), code);
  }
  if (expected.sourceLocator !== undefined) {
    invariant(record.sourceLocator !== undefined, code);
    invariant(canonicalJcs(record.sourceLocator) === canonicalJcs(expected.sourceLocator), code);
  }
  invariant(record.artifactDigest === expected.artifactDigest, code);
  const decoded = readLockedArtifact(record, expected, code);
  invariant(sha256Bytes(decoded.bytes) === record.artifactDigest, code);
  if (expected.payload !== undefined) exactPayload(decoded.payload, expected.payload, code);
  return record;
}

function validateDefinitionArtifacts(instance, definition, identity) {
  const subjectVersionIri = definition.versionIri;
  for (const [artifactRole, artifactKind, artifactDigest] of [
    ['method', 'riskMethodDefinition', definition.methodDigest],
    ['implementation', 'riskMethodImplementation', definition.implementationDigest],
    ['inputContract', 'riskMethodInputContract', definition.inputContractDigest],
    ['outputContract', 'riskMethodOutputContract', definition.outputContractDigest],
  ]) {
    validateArtifactRecord(instance, subjectVersionIri, artifactRole, {
      artifactPath: artifactRole === 'method'
        ? RISK_EVIDENCE_PATH
        : ({
          implementation: RISK_IMPLEMENTATION_PATH,
          inputContract: RISK_INPUT_CONTRACT_PATH,
          outputContract: RISK_OUTPUT_CONTRACT_PATH,
        })[artifactRole],
      artifactSelector: artifactRole === 'method' ? undefined : '$wholeFile',
      artifactDigest,
      artifactRef: artifactRole === 'method'
        ? { kind: 'iri', iri: definition.methodRef }
        : {
          kind: 'path',
          root: 'sourceTree',
          path: ({
            implementation: RISK_IMPLEMENTATION_PATH,
            inputContract: RISK_INPUT_CONTRACT_PATH,
            outputContract: RISK_OUTPUT_CONTRACT_PATH,
          })[artifactRole],
        },
      payload: artifactRole === 'method' ? {
        artifactKind,
        methodRef: definition.methodRef,
        methodVersion: definition.methodVersion,
      } : undefined,
    });
  }
}

function validateDefinitionIdentity(instance, definition) {
  const code = 'definition-identity-closure';
  invariant(Array.isArray(instance.identityRecords), code);
  const keyToLogical = new Map();
  const logicalToKey = new Map();
  const versionToIdentity = new Map();
  for (const record of instance.identityRecords) {
    invariant(typeof record.riskMeasureId === 'string' && record.riskMeasureId.trim() !== '', code);
    invariant(ABSOLUTE_URI.test(record.logicalIri || ''), code);
    invariant(ABSOLUTE_URI.test(record.versionIri || ''), code);
    invariant(record.versionOf === record.logicalIri, code);
    invariant(record.versionIri.startsWith(`${record.logicalIri}/version/`), code);
    invariant(SHA256.test(record.identityDigest || ''), code);
    invariant(!versionToIdentity.has(record.versionIri), code);
    const decoded = readLockedEvidenceSelection(record.identityPath, record.identitySelector, code);
    invariant(sha256Bytes(decoded.bytes) === record.identityDigest, code);
    exactPayload(decoded.payload, {
      logicalIri: record.logicalIri,
      riskMeasureId: record.riskMeasureId,
      versionIri: record.versionIri,
      versionOf: record.versionOf,
    }, code);
    invariant(
      !keyToLogical.has(record.riskMeasureId)
        || keyToLogical.get(record.riskMeasureId) === record.logicalIri,
      code,
    );
    invariant(
      !logicalToKey.has(record.logicalIri)
        || logicalToKey.get(record.logicalIri) === record.riskMeasureId,
      code,
    );
    keyToLogical.set(record.riskMeasureId, record.logicalIri);
    logicalToKey.set(record.logicalIri, record.riskMeasureId);
    versionToIdentity.set(record.versionIri, record);
  }
  const current = versionToIdentity.get(definition.versionIri);
  invariant(current, code);
  invariant(current.riskMeasureId === definition.riskMeasureId, code);
  return current;
}

function validateInstant(value, code) {
  invariant(typeof value === 'string' && CANONICAL_UTC_INSTANT.test(value), code);
  const parsed = Date.parse(value);
  invariant(Number.isFinite(parsed) && new Date(parsed).toISOString() === value.replace('Z', '.000Z'), code);
  return parsed;
}

function validateMaterializationRunRecord(record, code) {
  invariant(record && typeof record === 'object' && !Array.isArray(record), code);
  invariant(ABSOLUTE_URI.test(record.contextRef || ''), code);
  invariant(SHA256.test(record.recordDigest || ''), code);
  invariant(record.status === 'completed', code);
  const completedAt = validateInstant(record.completedAt, code);
  const decoded = readLockedEvidenceSelection(record.recordPath, record.recordSelector, code);
  invariant(sha256Bytes(decoded.bytes) === record.recordDigest, code);
  const run = decoded.payload;
  invariant(sameSet(Object.keys(run), [
    'assertionTime',
    'attemptId',
    'build',
    'compilerDigest',
    'executorDigest',
    'inputDatasets',
    'iri',
    'mappingClosure',
    'mappingClosureDigest',
    'ontologyClosureDigest',
    'ontologyClosureRef',
    'outputRdfCanonicalization',
    'planRef',
    'planSourceDigest',
    'plannedInputDigest',
    'recordType',
    'referenceLockDigest',
    'referenceLockRef',
    'referenceTime',
    'resolvedInputDigest',
    'result',
    'runId',
    'schemaVersion',
    'slotId',
    'sourceSchemaClosureDigest',
    'sourceSnapshotRootDigest',
    'validatorDigest',
  ]), code);
  invariant(run.schemaVersion === '1.0' && run.recordType === 'materializationRun', code);
  invariant(run.iri === record.contextRef, code);
  invariant(
    typeof run.slotId === 'string' && run.slotId.length > 0
      && typeof run.runId === 'string' && run.runId.length > 0
      && typeof run.attemptId === 'string' && run.attemptId.length > 0,
    code,
  );
  invariant(ABSOLUTE_URI.test(run.planRef || ''), code);
  for (const field of [
    'plannedInputDigest',
    'resolvedInputDigest',
    'planSourceDigest',
    'sourceSchemaClosureDigest',
    'sourceSnapshotRootDigest',
    'mappingClosureDigest',
    'ontologyClosureDigest',
    'referenceLockDigest',
    'compilerDigest',
    'validatorDigest',
    'executorDigest',
  ]) invariant(SHA256.test(run[field] || ''), code);
  invariant(validateArtifactRef(run.ontologyClosureRef).ok, code);
  invariant(validateArtifactRef(run.referenceLockRef).ok, code);
  invariant(run.outputRdfCanonicalization === 'RDFC-1.0', code);
  const assertionTime = validateInstant(run.assertionTime, code);
  const referenceTime = validateInstant(run.referenceTime, code);
  invariant(referenceTime <= assertionTime && completedAt === assertionTime, code);
  invariant(Array.isArray(run.inputDatasets) && run.inputDatasets.length > 0, code);
  for (const input of run.inputDatasets) {
    invariant(sameSet(Object.keys(input), [
      'artifactDigest', 'dataset', 'schemaDigest', 'snapshotRef', 'snapshotTime',
    ]), code);
    invariant(ABSOLUTE_URI.test(input.dataset || ''), code);
    invariant(validateArtifactRef(input.snapshotRef).ok, code);
    invariant(SHA256.test(input.artifactDigest || '') && SHA256.test(input.schemaDigest || ''), code);
    validateInstant(input.snapshotTime, code);
  }
  invariant(Array.isArray(run.mappingClosure) && run.mappingClosure.length > 0, code);
  for (const mapping of run.mappingClosure) {
    invariant(sameSet(Object.keys(mapping), [
      'mappingRef', 'mappingSourceDigest', 'transformationClosureDigest', 'transformationClosureRef',
    ]), code);
    invariant(ABSOLUTE_URI.test(mapping.mappingRef || ''), code);
    invariant(validateArtifactRef(mapping.transformationClosureRef).ok, code);
    invariant(
      SHA256.test(mapping.mappingSourceDigest || '')
        && SHA256.test(mapping.transformationClosureDigest || ''),
      code,
    );
  }
  invariant(run.build && sameSet(Object.keys(run.build), [
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
  ]), code);
  for (const field of [
    'buildId',
    'buildInputsDigest',
    'controlRecordPlanDigest',
    'controlRecordSchemaManifestDigest',
    'sourceTreeDigest',
    'toolLockDigest',
  ]) invariant(SHA256.test(run.build[field] || ''), code);
  for (const field of [
    'buildInputsRef',
    'controlRecordPlanRef',
    'controlRecordSchemaManifestRef',
    'toolLockRef',
  ]) invariant(validateArtifactRef(run.build[field]).ok, code);
  invariant(run.result && sameSet(Object.keys(run.result), [
    'outcome',
    'outputFactVersionCount',
    'outputGraph',
    'outputGraphDigest',
    'validationReportDigest',
    'validationReportRef',
  ]), code);
  invariant(run.result.outcome === 'completed', code);
  invariant(ABSOLUTE_URI.test(run.result.outputGraph || ''), code);
  invariant(ABSOLUTE_URI.test(run.result.validationReportRef || ''), code);
  invariant(
    SHA256.test(run.result.outputGraphDigest || '')
      && SHA256.test(run.result.validationReportDigest || ''),
    code,
  );
  invariant(Number.isSafeInteger(run.result.outputFactVersionCount)
    && run.result.outputFactVersionCount >= 0, code);
  return { completedAt, run };
}

function materializationRunFor(instance, contextRef, recordDigest, code) {
  invariant(Array.isArray(instance.contextRecords), code);
  const matches = instance.contextRecords.filter((record) => record?.contextRef === contextRef);
  invariant(matches.length === 1 && matches[0].recordDigest === recordDigest, code);
  return { record: matches[0], ...validateMaterializationRunRecord(matches[0], code) };
}

function validateExactMarketDataStream(instance, measurement, measurementAxes) {
  if (measurement.marketDataStreamVersionIri === undefined) return;
  const code = 'measurement-market-data-stream';
  invariant(Array.isArray(instance.referenceRecords), code);
  const matches = instance.referenceRecords.filter((record) => (
    record?.versionIri === measurement.marketDataStreamVersionIri
  ));
  invariant(matches.length === 1, code);
  const record = matches[0];
  invariant(record.typeIri === MARKET_DATA_STREAM_TYPE, code);
  invariant(ABSOLUTE_URI.test(record.versionIri || '') && ABSOLUTE_URI.test(record.source || ''), code);
  invariant(Number.isSafeInteger(record.revision) && record.revision >= 0, code);
  invariant(SHA256.test(record.recordDigest || ''), code);
  const decoded = readLockedEvidenceSelection(record.recordPath, record.recordSelector, code);
  invariant(sha256Bytes(decoded.bytes) === record.recordDigest, code);
  const payload = Object.fromEntries(Object.entries(record)
    .filter(([key]) => !['recordDigest', 'recordPath', 'recordSelector'].includes(key)));
  exactPayload(decoded.payload, payload, code);
  const streamAxes = validateAxes({
    availableFrom: record.availableFrom,
    knowledgeFrom: record.knowledgeFrom,
    revision: record.revision,
    validFrom: record.validFrom,
    ...(record.validTo === undefined ? {} : { validTo: record.validTo }),
  }, code);
  invariant(streamAxes.validFrom <= measurementAxes.validFrom, code);
  invariant(streamAxes.validTo === undefined || measurementAxes.validFrom < streamAxes.validTo, code);
  invariant(streamAxes.knowledgeFrom <= measurementAxes.knowledgeFrom, code);
  invariant(streamAxes.availableFrom <= measurementAxes.availableFrom, code);
}

function validateAxes(value, codePrefix) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${codePrefix}-temporal`);
  const allowed = new Set(['validFrom', 'validTo', 'knowledgeFrom', 'availableFrom', 'revision']);
  invariant(Object.keys(value).every((field) => allowed.has(field)), `${codePrefix}-temporal`);
  invariant(!Object.hasOwn(value, 'knowledgeTo') && !Object.hasOwn(value, 'availableTo'), `${codePrefix}-temporal`);
  const validFrom = validateInstant(value.validFrom, `${codePrefix}-temporal`);
  const knowledgeFrom = validateInstant(value.knowledgeFrom, `${codePrefix}-temporal`);
  const availableFrom = validateInstant(value.availableFrom, `${codePrefix}-temporal`);
  const validTo = value.validTo === undefined || value.validTo === null
    ? Infinity
    : validateInstant(value.validTo, `${codePrefix}-temporal`);
  invariant(validFrom < validTo, `${codePrefix}-temporal`);
  invariant(Number.isSafeInteger(value.revision) && value.revision >= 0, `${codePrefix}-temporal`);
  return {
    validFrom, validTo, knowledgeFrom, availableFrom,
  };
}

function validateProvenance(value, codePrefix, artifactRequired = false) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${codePrefix}-provenance`);
  invariant(ABSOLUTE_URI.test(value.source || ''), `${codePrefix}-provenance`);
  if (value.sourceVersion !== undefined) {
    invariant(
      typeof value.sourceVersion === 'string'
        && value.sourceVersion.trim() !== ''
        && value.sourceVersion === value.sourceVersion.normalize('NFC'),
      `${codePrefix}-provenance`,
    );
  }
  const artifactFields = ['sourceArtifactRef', 'sourceArtifactDigest', 'sourceLocator'];
  const presentCount = artifactFields.filter((field) => value[field] !== undefined).length;
  invariant(
    presentCount === (artifactRequired ? artifactFields.length : 0),
    `${codePrefix}-provenance`,
  );
  if (artifactRequired) {
    invariant(validateArtifactRef(value.sourceArtifactRef).ok, `${codePrefix}-provenance`);
    invariant(SHA256.test(value.sourceArtifactDigest || ''), `${codePrefix}-provenance`);
    invariant(validateSourceLocator(value.sourceLocator).ok, `${codePrefix}-provenance`);
  }
}

function parseDecimal(value, code) {
  invariant(typeof value === 'string' && DECIMAL.test(value), code);
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ''] = unsigned.split('.');
  return {
    coefficient: BigInt(`${negative ? '-' : ''}${integer}${fraction}`),
    scale: fraction.length,
  };
}

function compareDecimal(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * (10n ** BigInt(scale - left.scale));
  const rightValue = right.coefficient * (10n ** BigInt(scale - right.scale));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function validateMoney(value, code) {
  invariant(value && typeof value === 'object', code);
  const amount = parseDecimal(value.amount, code);
  invariant(/^[A-Z]{3}$/u.test(value.currency || ''), code);
  invariant(Number.isSafeInteger(value.scale) && value.scale >= 0, code);
  invariant(amount.scale <= value.scale, code);
  return amount;
}

function validateQuantity(value, code) {
  invariant(value && typeof value === 'object', code);
  const amount = parseDecimal(value.value, code);
  invariant(ABSOLUTE_URI.test(value.unit || ''), code);
  invariant(['floor', 'ceiling', 'half-up', 'half-even'].includes(value.rounding), code);
  return amount;
}

function branchOf(value, names, code) {
  const branches = names.filter((name) => value[name] !== undefined);
  invariant(branches.length === 1, code);
  return branches[0];
}

function canonicalScopes(scopes, code) {
  invariant(Array.isArray(scopes) && scopes.length > 0, code);
  const keys = scopes.map((scope) => {
    invariant(['portfolio', 'account', 'position'].includes(scope.kind), code);
    invariant(ABSOLUTE_URI.test(scope.ref || ''), code);
    if (scope.kind === 'position') invariant(EXACT_VERSION_IRI.test(scope.ref), code);
    return `${scope.kind}\u001f${scope.ref}`;
  });
  invariant(new Set(keys).size === keys.length, code);
  return keys.sort();
}

function bucketDigest(values) {
  const versionIris = values.map((value) => value.versionIri).sort();
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('axiolune-risk-bucket-version-set-v1\0', 'utf8'));
  for (const iri of versionIris) {
    const bytes = Buffer.from(iri, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function validateBucketProbe(instance, bucketSet, codePrefix) {
  const code = `${codePrefix}-closure-probe`;
  invariant(Array.isArray(instance.probeRecords), code);
  const matches = instance.probeRecords.filter((probe) => (
    probe?.probeRef === bucketSet.closureProbeRef
      && probe?.bucketSetVersionIri === bucketSet.versionIri
  ));
  invariant(matches.length === 1, code);
  const probe = matches[0];
  invariant(probe.status === 'completed', code);
  invariant(ABSOLUTE_URI.test(probe.probeRef || ''), code);
  invariant(probe.probeDigest === bucketSet.closureProbeDigest, code);
  invariant(SHA256.test(probe.probeDigest || ''), code);
  invariant(probe.generatingContextRef === bucketSet.generatingContextRef, code);
  invariant(Array.isArray(probe.subjectVersionIris), code);
  const sortedSubjects = [...probe.subjectVersionIris].sort((left, right) => Buffer.compare(
    Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'),
  ));
  invariant(canonicalJcs(probe.subjectVersionIris) === canonicalJcs(sortedSubjects), code);
  invariant(new Set(probe.subjectVersionIris).size === probe.subjectVersionIris.length, code);
  const decoded = readLockedEvidenceSelection(probe.probePath, probe.probeSelector, code);
  invariant(sha256Bytes(decoded.bytes) === probe.probeDigest, code);
  const payload = Object.fromEntries(Object.entries(probe)
    .filter(([key]) => !['probeDigest', 'probePath', 'probeSelector'].includes(key)));
  exactPayload(decoded.payload, payload, code);
  const inputRun = materializationRunFor(
    instance,
    probe.inputContextRef,
    probe.inputContextRecordDigest,
    code,
  );
  const completedAt = validateInstant(probe.completedAt, code);
  invariant(completedAt >= inputRun.completedAt, code);
  const bucketAxes = validateAxes(bucketSet.axes, codePrefix);
  invariant(completedAt < bucketAxes.knowledgeFrom && completedAt < bucketAxes.availableFrom, code);
  invariant(Array.isArray(instance.bucketValueCandidates), code);
  const candidates = probe.subjectVersionIris.map((versionIri) => {
    const rows = instance.bucketValueCandidates.filter((candidate) => candidate.versionIri === versionIri);
    invariant(rows.length === 1, code);
    invariant(rows[0].bucketSetVersionIri === bucketSet.versionIri, code);
    return rows[0];
  });
  invariant(probe.subjectSetDigest === bucketDigest(candidates), code);
  const actualVersions = bucketSet.values.map((value) => value.versionIri);
  invariant(sameSet(actualVersions, probe.subjectVersionIris), code);
  invariant(bucketSet.bucketValueCount === candidates.length, code);
  invariant(bucketSet.bucketValueSetDigest === probe.subjectSetDigest, code);
  return candidates;
}

function validateBucketSchema(schema, codePrefix = 'definition-bucket-schema') {
  invariant(schema && typeof schema === 'object' && !Array.isArray(schema), codePrefix);
  invariant(EXACT_VERSION_IRI.test(schema.versionIri || ''), codePrefix);
  invariant(
    typeof schema.bucketSchemaId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(schema.bucketSchemaId),
    codePrefix,
  );
  invariant(ABSOLUTE_URI.test(schema.dimensionRef || ''), codePrefix);
  invariant(ABSOLUTE_URI.test(schema.unit || ''), codePrefix);
  invariant(SHA256.test(schema.bucketKeyContractDigest || ''), codePrefix);
  invariant(
    schema.bucketKeyContractDigest === sha256Bytes(fs.readFileSync(
      path.join(ROOT, ...RISK_BUCKET_KEY_CONTRACT_PATH.split('/')),
    )),
    codePrefix,
  );
  validateAxes(schema.axes, codePrefix);
  validateProvenance(schema.provenance, codePrefix, true);
}

function validateBucketSetClosure(instance, bucketSet, schema, codePrefix) {
  invariant(bucketSet && schema, `${codePrefix}-missing`);
  invariant(EXACT_VERSION_IRI.test(bucketSet.versionIri || ''), `${codePrefix}-version`);
  invariant(
    typeof bucketSet.bucketSetId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(bucketSet.bucketSetId),
    `${codePrefix}-identity`,
  );
  invariant(bucketSet.schemaVersionIri === schema.versionIri, `${codePrefix}-schema`);
  invariant(bucketSet.closureCompleted === true, `${codePrefix}-closure`);
  invariant(Array.isArray(bucketSet.values) && bucketSet.values.length > 0, `${codePrefix}-closure`);
  invariant(Number.isSafeInteger(bucketSet.bucketValueCount), `${codePrefix}-count`);
  invariant(bucketSet.bucketValueCount === bucketSet.values.length, `${codePrefix}-count`);
  invariant(ABSOLUTE_URI.test(bucketSet.closureProbeRef || ''), `${codePrefix}-closure`);
  invariant(SHA256.test(bucketSet.closureProbeDigest || ''), `${codePrefix}-closure`);
  invariant(ABSOLUTE_URI.test(bucketSet.generatingContextRef || ''), `${codePrefix}-run`);
  validateAxes(bucketSet.axes, codePrefix);
  validateProvenance(bucketSet.provenance, codePrefix);
  const probeCandidates = validateBucketProbe(instance, bucketSet, codePrefix);
  const keys = new Set();
  const versions = new Set();
  for (const value of bucketSet.values) {
    invariant(EXACT_VERSION_IRI.test(value.versionIri || ''), `${codePrefix}-value-version`);
    invariant(!versions.has(value.versionIri), `${codePrefix}-duplicate-version`);
    versions.add(value.versionIri);
    invariant(typeof value.key === 'string' && value.key.trim() !== '', `${codePrefix}-key`);
    invariant(!keys.has(value.key), `${codePrefix}-duplicate-key`);
    keys.add(value.key);
  }
  invariant(bucketSet.bucketValueSetDigest === bucketDigest(probeCandidates), `${codePrefix}-digest`);
  return new Map(bucketSet.values.map((value) => [value.key, value]));
}

function validateBucketValues(bucketSet, schema, codePrefix) {
  invariant(bucketSet && schema, `${codePrefix}-missing`);
  invariant(Array.isArray(bucketSet.values) && bucketSet.values.length > 0, `${codePrefix}-closure`);
  const keys = new Set();
  const versions = new Set();
  for (const value of bucketSet.values) {
    invariant(EXACT_VERSION_IRI.test(value.versionIri || ''), `${codePrefix}-value-version`);
    invariant(!versions.has(value.versionIri), `${codePrefix}-duplicate-version`);
    versions.add(value.versionIri);
    invariant(typeof value.key === 'string' && value.key.trim() !== '', `${codePrefix}-key`);
    invariant(!keys.has(value.key), `${codePrefix}-duplicate-key`);
    keys.add(value.key);
    invariant(value.dimensionRef === schema.dimensionRef, `${codePrefix}-dimension`);
    invariant(
      value.generatingContextRef === bucketSet.generatingContextRef,
      `${codePrefix}-value-run`,
    );
    validateAxes(value.axes, `${codePrefix}-value`);
    validateProvenance(value.provenance, `${codePrefix}-value`);
    validateQuantity(value.quantity, `${codePrefix}-quantity`);
    invariant(value.quantity.unit === schema.unit, `${codePrefix}-unit`);
  }
  return new Map(bucketSet.values.map((value) => [value.key, value]));
}

function validateDefinition(instance, definition) {
  invariant(EXACT_VERSION_IRI.test(definition.versionIri || ''), 'definition-version');
  invariant(
    typeof definition.riskMeasureId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(definition.riskMeasureId),
    'definition-identity',
  );
  invariant(['money', 'quantity', 'bucket'].includes(definition.representation), 'definition-branch');
  invariant(ABSOLUTE_URI.test(definition.methodRef || ''), 'definition-method');
  invariant(
    typeof definition.methodVersion === 'string'
      && definition.methodVersion.trim() !== ''
      && definition.methodVersion === definition.methodVersion.normalize('NFC'),
    'definition-method',
  );
  for (const field of ['methodDigest', 'implementationDigest', 'inputContractDigest', 'outputContractDigest']) {
    invariant(SHA256.test(definition[field] || ''), 'definition-digest');
  }
  validateAxes(definition.axes, 'definition');
  validateProvenance(definition.provenance, 'definition', true);
  const identity = validateDefinitionIdentity(instance, definition);
  validateDefinitionArtifacts(instance, definition, identity);
  const representationFields = ['currency', 'unit', 'bucketSchema']
    .filter((field) => definition[field] !== undefined);
  invariant(representationFields.length === 1, 'definition-representation-xone');
  invariant(
    representationFields[0] === ({ money: 'currency', quantity: 'unit', bucket: 'bucketSchema' })[
      definition.representation
    ],
    'definition-representation-xone',
  );
  if (definition.representation === 'money') {
    invariant(/^[A-Z]{3}$/u.test(definition.currency || ''), 'definition-currency');
  } else if (definition.representation === 'quantity') {
    invariant(ABSOLUTE_URI.test(definition.unit || ''), 'definition-unit');
  } else {
    invariant(definition.bucketSchema, 'definition-bucket-schema');
    invariant(EXACT_VERSION_IRI.test(definition.bucketSchema.versionIri || ''), 'definition-bucket-schema');
  }
  for (const field of ['samplingMethodRef', 'benchmarkRef', 'scenarioRef']) {
    if (definition[field] !== undefined) {
      invariant(ABSOLUTE_URI.test(definition[field]), 'definition-parameter-reference');
    }
  }
  if (definition.confidenceLevel !== undefined) {
    const confidence = validateQuantity(definition.confidenceLevel, 'definition-confidence-level');
    invariant(
      definition.confidenceLevel.unit === 'urn:unit:dimensionless'
        && compareDecimal(confidence, parseDecimal('0', 'definition-confidence-level')) > 0
        && compareDecimal(confidence, parseDecimal('1', 'definition-confidence-level')) < 0,
      'definition-confidence-level',
    );
  }
  for (const field of ['observationWindow', 'riskHorizon']) {
    if (definition[field] !== undefined) {
      const duration = validateQuantity(definition[field], 'definition-duration');
      invariant(
        compareDecimal(duration, parseDecimal('0', 'definition-duration')) > 0,
        'definition-duration',
      );
    }
  }
}

function factVersions(instance) {
  const records = [
    instance.definition,
    instance.definition?.bucketSchema,
    instance.measurement,
    instance.measurement?.bucketSet,
    ...(instance.measurement?.bucketSet?.values || []),
    instance.limit,
    instance.limit?.bucketSet,
    ...(instance.limit?.bucketSet?.values || []),
    instance.evaluation,
    instance.breach,
  ].filter(Boolean);
  const result = new Map();
  for (const record of records) {
    invariant(!result.has(record.versionIri), 'risk-duplicate-version-iri');
    result.set(record.versionIri, record);
  }
  return result;
}

function validateClosures(instance) {
  invariant(Array.isArray(instance.closures), 'risk-closure-array');
  invariant(Array.isArray(instance.evidenceRecords), 'risk-evidence-array');
  const versions = factVersions(instance);
  const evidence = new Map();
  for (const record of instance.evidenceRecords) {
    invariant(record && typeof record === 'object' && !Array.isArray(record), 'risk-evidence');
    const allowed = new Set(['evidenceRef', 'artifactRef', 'artifactDigest', 'sourceLocator']);
    invariant(Object.keys(record).every((field) => allowed.has(field)), 'risk-evidence');
    invariant(ABSOLUTE_URI.test(record.evidenceRef || ''), 'risk-evidence');
    invariant(validateArtifactRef(record.artifactRef).ok, 'risk-evidence');
    invariant(SHA256.test(record.artifactDigest || ''), 'risk-evidence');
    invariant(validateSourceLocator(record.sourceLocator).ok, 'risk-evidence');
    invariant(record.sourceLocator.kind === 'wholeFile', 'risk-evidence');
    invariant(record.sourceLocator.path === RISK_RETRACTION_EVIDENCE_PATH, 'risk-evidence');
    invariant(record.sourceLocator.mediaType === 'application/json', 'risk-evidence');
    invariant(canonicalJcs(record.sourceLocator.extractorProfileRef) === canonicalJcs({
      kind: 'path',
      path: WHOLE_FILE_PROFILE_PATH,
      root: 'sourceTree',
    }), 'risk-evidence');
    const profileBytes = fs.readFileSync(path.join(ROOT, ...WHOLE_FILE_PROFILE_PATH.split('/')));
    invariant(
      record.sourceLocator.extractorProfileDigest === sha256Bytes(profileBytes),
      'risk-evidence',
    );
    const evidenceBytes = fs.readFileSync(
      path.join(ROOT, ...RISK_RETRACTION_EVIDENCE_PATH.split('/')),
    );
    invariant(record.artifactDigest === sha256Bytes(evidenceBytes), 'risk-evidence');
    invariant(
      record.sourceLocator.selectionDigest
        === computeSelectionDigest(record.sourceLocator, evidenceBytes),
      'risk-evidence',
    );
    invariant(!evidence.has(record.evidenceRef), 'risk-evidence-duplicate');
    evidence.set(record.evidenceRef, record);
  }
  const result = new Map();
  for (const closure of instance.closures) {
    invariant(closure && typeof closure === 'object' && !Array.isArray(closure), 'risk-closure');
    const allowed = new Set([
      'targetVersionIri', 'axis', 'closedAt', 'causeKind', 'causeVersionIri',
      'evidenceRef', 'generatingContextRef',
    ]);
    invariant(Object.keys(closure).every((field) => allowed.has(field)), 'risk-closure');
    invariant(['knowledge', 'availability'].includes(closure.axis), 'risk-closure');
    const target = versions.get(closure.targetVersionIri);
    invariant(target, 'risk-closure-target');
    const closedAt = validateInstant(closure.closedAt, 'risk-closure');
    const fromField = closure.axis === 'knowledge' ? 'knowledgeFrom' : 'availableFrom';
    invariant(closedAt > validateInstant(target.axes?.[fromField], 'risk-closure-target'), 'risk-closure-target');
    invariant(ABSOLUTE_URI.test(closure.evidenceRef || ''), 'risk-closure-evidence');
    invariant(
      versions.has(closure.evidenceRef) || evidence.has(closure.evidenceRef),
      'risk-closure-evidence',
    );
    invariant(ABSOLUTE_URI.test(closure.generatingContextRef || ''), 'risk-closure-run');
    const allowedCauses = closure.axis === 'knowledge'
      ? ['successor', 'retraction']
      : ['successor', 'sourceWithdrawal'];
    invariant(allowedCauses.includes(closure.causeKind), 'risk-closure-cause');
    if (closure.causeKind === 'successor') {
      const successor = versions.get(closure.causeVersionIri);
      invariant(
        successor && successor.supersedes === closure.targetVersionIri,
        'risk-closure-cause-version',
      );
    } else {
      invariant(closure.causeVersionIri === undefined, 'risk-closure-cause-version');
    }
    const key = `${closure.targetVersionIri}\0${closure.axis}`;
    invariant(!result.has(key), 'risk-closure-duplicate');
    result.set(key, closure);
  }
  for (const fact of versions.values()) {
    if (fact.supersedes === undefined) continue;
    const predecessor = versions.get(fact.supersedes);
    invariant(predecessor, 'risk-supersedes-target');
    invariant(
      fact.axes.revision === predecessor.axes.revision + 1
        && Date.parse(fact.axes.knowledgeFrom) > Date.parse(predecessor.axes.knowledgeFrom),
      'risk-supersedes-order',
    );
    const closure = result.get(`${fact.supersedes}\0knowledge`);
    invariant(
      closure
        && closure.causeKind === 'successor'
        && closure.causeVersionIri === fact.versionIri
        && closure.closedAt === fact.axes.knowledgeFrom,
      'risk-supersedes-closure',
    );
  }
  return result;
}

function validateInputContext(instance, measurement, measurementAxes) {
  const { completedAt } = materializationRunFor(
    instance,
    measurement.inputContextRef,
    measurement.inputContextRecordDigest,
    'measurement-input-context',
  );
  invariant(
    completedAt < measurementAxes.knowledgeFrom
      && completedAt < measurementAxes.availableFrom,
    'measurement-input-context-order',
  );
}

function scenarioBucketSets(instance) {
  const result = [];
  if (instance.measurement?.bucketSet) {
    result.push({
      bucketSet: instance.measurement.bucketSet,
      schema: instance.definition?.bucketSchema,
      prefix: 'measurement-bucket',
    });
  }
  if (instance.limit?.bucketSet) {
    result.push({
      bucketSet: instance.limit.bucketSet,
      schema: instance.definition?.bucketSchema,
      prefix: 'limit-bucket',
    });
  }
  return result;
}

function expectedValueBranch(definition) {
  return {
    money: 'money',
    quantity: 'quantity',
    bucket: 'bucketSet',
  }[definition?.representation];
}

function validateRiskMeasureDefinitionConstraint(instance) {
  validateDefinition(instance, instance?.definition);
}

function validateRiskBucketSchemaConstraint(instance) {
  if (!instance?.definition?.bucketSchema) return { applicable: false };
  validateBucketSchema(instance.definition.bucketSchema);
  return { applicable: true };
}

function validateRiskBucketSetClosureConstraint(instance) {
  const bucketSets = scenarioBucketSets(instance);
  if (bucketSets.length === 0) return { applicable: false };
  for (const { bucketSet, schema, prefix } of bucketSets) {
    validateBucketSetClosure(instance, bucketSet, schema, prefix);
  }
  return { applicable: true };
}

function validateRiskBucketValueConstraint(instance) {
  const bucketSets = scenarioBucketSets(instance);
  if (bucketSets.length === 0) return { applicable: false };
  for (const { bucketSet, schema, prefix } of bucketSets) {
    validateBucketValues(bucketSet, schema, prefix);
  }
  return { applicable: true };
}

function validateRiskMeasurementConstraint(instance) {
  const { definition, measurement } = instance;
  invariant(EXACT_VERSION_IRI.test(measurement?.versionIri || ''), 'measurement-version');
  const measurementAxes = validateAxes(measurement.axes, 'measurement');
  validateProvenance(measurement.provenance, 'measurement');
  invariant(
    measurement.definitionVersionIri === definition.versionIri,
    'measurement-definition',
  );
  const measurementScopes = canonicalScopes(measurement.scopes, 'measurement-scope');
  invariant(measurement.inputContextCompleted === true, 'measurement-input-context');
  invariant(ABSOLUTE_URI.test(measurement.inputContextRef || ''), 'measurement-input-context');
  invariant(SHA256.test(measurement.inputContextRecordDigest || ''), 'measurement-input-context');
  invariant(ABSOLUTE_URI.test(measurement.generatingContextRef || ''), 'measurement-run');
  invariant(
    measurement.inputContextRef !== measurement.generatingContextRef,
    'measurement-input-context',
  );
  validateInputContext(instance, measurement, measurementAxes);
  validateExactMarketDataStream(instance, measurement, measurementAxes);
  const measurementBranch = branchOf(
    measurement,
    ['money', 'quantity', 'bucketSet'],
    'measurement-value-xone',
  );
  const expectedBranch = expectedValueBranch(definition);
  invariant(measurementBranch === expectedBranch, 'measurement-definition-branch');
  if (measurementBranch === 'money') {
    validateMoney(measurement.money, 'measurement-money');
    invariant(
      measurement.money.currency === definition.currency,
      'risk-currency-compatibility',
    );
  } else if (measurementBranch === 'quantity') {
    validateQuantity(measurement.quantity, 'measurement-quantity');
    invariant(
      measurement.quantity.unit === definition.unit,
      'risk-unit-compatibility',
    );
  } else {
    invariant(
      measurement.bucketSet?.schemaVersionIri === definition.bucketSchema?.versionIri,
      'measurement-bucket-schema',
    );
  }
  return { measurementAxes, measurementScopes, measurementBranch };
}

function validateRiskLimitConstraint(instance) {
  const { definition, limit } = instance;
  invariant(EXACT_VERSION_IRI.test(limit?.versionIri || ''), 'limit-version');
  invariant(
    typeof limit.limitId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(limit.limitId),
    'limit-identity',
  );
  const limitAxes = validateAxes(limit.axes, 'limit');
  validateProvenance(limit.provenance, 'limit', true);
  invariant(limit.definitionVersionIri === definition.versionIri, 'limit-definition');
  const limitScopes = canonicalScopes(limit.scopes, 'limit-scope');
  invariant(ABSOLUTE_URI.test(limit.ownerRef || ''), 'limit-owner');
  invariant(ABSOLUTE_URI.test(limit.approvalDecisionRef || ''), 'limit-approval');
  invariant(SHA256.test(limit.approvalDecisionDigest || ''), 'limit-approval');
  invariant(ABSOLUTE_URI.test(limit.approvedBy || ''), 'limit-approval');
  invariant(limit.approvalDecisionDigest === approvalDecisionDigest(limit), 'limit-approval');
  const approvedAt = validateInstant(limit.approvedAt, 'limit-approval');
  invariant(
    approvedAt >= limitAxes.validFrom
      && approvedAt < limitAxes.validTo
      && approvedAt <= limitAxes.knowledgeFrom,
    'limit-approval',
  );
  const limitBranch = branchOf(limit, ['money', 'quantity', 'bucketSet'], 'limit-value-xone');
  const expectedBranch = expectedValueBranch(definition);
  invariant(limitBranch === expectedBranch, 'limit-definition-branch');
  if (limitBranch === 'money') {
    validateMoney(limit.money, 'limit-money');
    invariant(limit.money.currency === definition.currency, 'risk-currency-compatibility');
  } else if (limitBranch === 'quantity') {
    validateQuantity(limit.quantity, 'limit-quantity');
    invariant(limit.quantity.unit === definition.unit, 'risk-unit-compatibility');
  } else {
    invariant(
      limit.bucketSet?.schemaVersionIri === definition.bucketSchema?.versionIri,
      'limit-bucket-schema',
    );
  }
  return { limitAxes, limitScopes, limitBranch };
}

function comparisonForEvaluation(definition, measurement, limit) {
  let comparison;
  if (definition.representation === 'money') {
    const measured = validateMoney(measurement.money, 'measurement-money');
    const threshold = validateMoney(limit.money, 'limit-money');
    invariant(
      measurement.money.currency === definition.currency
        && limit.money.currency === definition.currency,
      'risk-currency-compatibility',
    );
    comparison = compareDecimal(measured, threshold);
  } else if (definition.representation === 'quantity') {
    const measured = validateQuantity(measurement.quantity, 'measurement-quantity');
    const threshold = validateQuantity(limit.quantity, 'limit-quantity');
    invariant(
      measurement.quantity.unit === definition.unit
        && limit.quantity.unit === definition.unit,
      'risk-unit-compatibility',
    );
    comparison = compareDecimal(measured, threshold);
  } else {
    invariant(
      Array.isArray(measurement.bucketSet?.values)
        && Array.isArray(limit.bucketSet?.values),
      'risk-bucket-compatibility',
    );
    const measured = new Map(
      measurement.bucketSet.values.map((value) => [value.key, value]),
    );
    const thresholds = new Map(
      limit.bucketSet.values.map((value) => [value.key, value]),
    );
    invariant(
      measured.size === measurement.bucketSet.values.length
        && thresholds.size === limit.bucketSet.values.length,
      'risk-bucket-compatibility',
    );
    invariant(sameSet(measured.keys(), thresholds.keys()), 'risk-bucket-compatibility');
    comparison = -1;
    for (const [key, value] of measured.entries()) {
      const measuredValue = validateQuantity(value.quantity, 'measurement-bucket-quantity');
      const limitValue = validateQuantity(
        thresholds.get(key).quantity,
        'limit-bucket-quantity',
      );
      if (compareDecimal(measuredValue, limitValue) > 0) comparison = 1;
    }
  }
  return comparison;
}

function validateRiskLimitEvaluationConstraint(instance) {
  const {
    definition, measurement, limit, evaluation,
  } = instance;
  invariant(
    measurement?.definitionVersionIri === definition?.versionIri
      && limit?.definitionVersionIri === definition?.versionIri,
    'evaluation-definition-compatibility',
  );
  const measurementScopes = canonicalScopes(measurement.scopes, 'measurement-scope');
  const limitScopes = canonicalScopes(limit.scopes, 'limit-scope');
  invariant(sameSet(measurementScopes, limitScopes), 'measurement-limit-scope');
  const measurementBranch = branchOf(
    measurement,
    ['money', 'quantity', 'bucketSet'],
    'measurement-value-xone',
  );
  const limitBranch = branchOf(limit, ['money', 'quantity', 'bucketSet'], 'limit-value-xone');
  invariant(
    measurementBranch === limitBranch
      && measurementBranch === expectedValueBranch(definition),
    'evaluation-representation-compatibility',
  );
  const measurementAxes = validateAxes(measurement.axes, 'measurement');
  const limitAxes = validateAxes(limit.axes, 'limit');
  const comparison = comparisonForEvaluation(definition, measurement, limit);
  invariant(EXACT_VERSION_IRI.test(evaluation?.versionIri || ''), 'evaluation-version');
  const evaluationAxes = validateAxes(evaluation.axes, 'evaluation');
  validateProvenance(evaluation.provenance, 'evaluation');
  invariant(
    evaluation.measurementVersionIri === measurement.versionIri
      && evaluation.limitVersionIri === limit.versionIri,
    'evaluation-exact-references',
  );
  invariant(ABSOLUTE_URI.test(evaluation.generatingContextRef || ''), 'evaluation-run');
  invariant(SHA256.test(evaluation.evaluatorDigest || ''), 'evaluation-digest');
  invariant(evaluation.evaluatorDigest === sha256Bytes(fs.readFileSync(__filename)), 'evaluation-digest');
  invariant(
    evaluationAxes.validFrom >= Math.max(measurementAxes.validFrom, limitAxes.validFrom)
      && evaluationAxes.knowledgeFrom >= Math.max(
        measurementAxes.knowledgeFrom,
        limitAxes.knowledgeFrom,
      )
      && evaluationAxes.availableFrom >= Math.max(
        measurementAxes.availableFrom,
        limitAxes.availableFrom,
      ),
    'evaluation-temporal-order',
  );
  const expectedResult = comparison > 0 ? 'breach' : 'withinLimit';
  if (evaluation.result === 'indeterminate') {
    invariant(
      typeof evaluation.reason === 'string' && evaluation.reason.trim() !== '',
      'evaluation-indeterminate-reason',
    );
  } else {
    invariant(evaluation.result === expectedResult, 'evaluation-result');
  }
  return { evaluationAxes };
}

function validateLimitBreachConstraint(instance) {
  const {
    measurement, limit, evaluation, breach,
  } = instance;
  const evaluationAxes = validateAxes(evaluation?.axes, 'evaluation');
  if (evaluation.result === 'breach') {
    invariant(breach, 'missing-limit-breach');
    invariant(EXACT_VERSION_IRI.test(breach.versionIri || ''), 'breach-version');
    const breachAxes = validateAxes(breach.axes, 'breach');
    validateProvenance(breach.provenance, 'breach');
    invariant(
      breach.evaluationVersionIri === evaluation.versionIri
        && breach.measurementVersionIri === measurement.versionIri
        && breach.limitVersionIri === limit.versionIri,
      'breach-exact-references',
    );
    invariant(
      breach.generatingContextRef === evaluation.generatingContextRef,
      'breach-generating-context',
    );
    invariant(
      breachAxes.validFrom >= evaluationAxes.validFrom
        && breachAxes.knowledgeFrom >= evaluationAxes.knowledgeFrom
        && breachAxes.availableFrom >= evaluationAxes.availableFrom,
      'breach-temporal-order',
    );
  } else {
    invariant(!breach, 'spurious-limit-breach');
  }
}

function validateScenarioDefinitionConstraint(instance) {
  const scenario = instance?.scenarioDefinition || instance?.definition?.scenario;
  if (!scenario) return { applicable: false };
  invariant(typeof scenario.scenarioDefinitionId === 'string' && scenario.scenarioDefinitionId.trim(), 'scenario-id');
  invariant(SHA256.test(scenario.shockParameterDigest || ''), 'scenario-shock-digest');
  validateAxes(scenario.axes, 'scenario');
  validateProvenance(scenario.provenance, 'scenario');
}

function validateStressTestRunConstraint(instance) {
  const run = instance?.stressTestRun || instance?.stressRun;
  if (!run) return { applicable: false };
  invariant(typeof run.stressRunId === 'string' && run.stressRunId.trim(), 'stress-run-id');
  invariant(EXACT_VERSION_IRI.test(run.scenarioVersionIri || ''), 'stress-scenario-version');
  invariant(typeof run.portfolioIri === 'string' && ABSOLUTE_URI.test(run.portfolioIri), 'stress-portfolio');
  invariant(EXACT_VERSION_IRI.test(run.outputMeasurementVersionIri || ''), 'stress-output-measurement');
  invariant(typeof run.generatingContextRef === 'string' && run.generatingContextRef.trim(), 'stress-generating-context');
}

const RISK_CUSTOM_VALIDATORS = new Map([
  [`${BASE}LimitBreachContract`, validateLimitBreachConstraint],
  [`${BASE}RiskBucketSchemaContract`, validateRiskBucketSchemaConstraint],
  [`${BASE}RiskBucketSetClosureContract`, validateRiskBucketSetClosureConstraint],
  [`${BASE}RiskBucketValueContract`, validateRiskBucketValueConstraint],
  [`${BASE}RiskLimitContract`, validateRiskLimitConstraint],
  [`${BASE}RiskLimitEvaluationContract`, validateRiskLimitEvaluationConstraint],
  [`${BASE}RiskMeasureDefinitionContract`, validateRiskMeasureDefinitionConstraint],
  [`${BASE}RiskMeasurementContract`, validateRiskMeasurementConstraint],
  [`${BASE}ScenarioDefinitionContract`, validateScenarioDefinitionConstraint],
  [`${BASE}StressTestRunContract`, validateStressTestRunConstraint],
]);

function validateConstraint(constraintIri, instance) {
  const validator = RISK_CUSTOM_VALIDATORS.get(constraintIri);
  invariant(validator, 'risk-custom-constraint-unbound');
  const result = validator(instance);
  return result || { applicable: true };
}

function riskConstraintDispatchDescriptor(constraintIri) {
  const validator = RISK_CUSTOM_VALIDATORS.get(constraintIri);
  invariant(validator, 'risk-custom-constraint-unbound');
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('axiolune-risk-custom-dispatch-v1\0', 'utf8'));
  hash.update(Buffer.from(constraintIri, 'utf8'));
  hash.update(Buffer.from('\0', 'utf8'));
  hash.update(Buffer.from(validator.name, 'utf8'));
  return {
    dispatchDigest: `sha256:${hash.digest('hex')}`,
    evaluatorId: validator.name,
  };
}

function validateScenario(input) {
  // The public scenario boundary is canonical-only.  Legacy objects remain
  // confined to the one-shot archive migration utility and never enter a
  // trusted validator/runtime path.
  const instance = decodeCanonicalRiskScenario(input);
  validateRiskMeasureDefinitionConstraint(instance);
  if (instance?.definition?.representation === 'bucket') {
    validateRiskBucketSchemaConstraint(instance);
    validateRiskBucketSetClosureConstraint(instance);
    validateRiskBucketValueConstraint(instance);
  }
  validateRiskMeasurementConstraint(instance);
  validateRiskLimitConstraint(instance);
  validateRiskLimitEvaluationConstraint(instance);
  validateLimitBreachConstraint(instance);
  return {
    closureByTargetAxis: validateClosures(instance),
    scenario: instance,
  };
}

function pathTokens(expression) {
  const result = [];
  for (const part of expression.split('.')) {
    invariant(/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/u.test(part), 'invalid-mutation-path');
    result.push(/^[0-9]+$/u.test(part) ? Number(part) : part);
  }
  return result;
}

function mutate(value, mutation) {
  function cloneTree(node) {
    if (Array.isArray(node)) return node.map(cloneTree);
    if (node === null || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, cloneTree(child)]));
  }
  const clone = cloneTree(value);
  const tokens = pathTokens(mutation.path);
  let parent = clone;
  for (const token of tokens.slice(0, -1)) {
    invariant(parent !== null && typeof parent === 'object' && token in parent, 'invalid-mutation-path');
    parent = parent[token];
  }
  const last = tokens[tokens.length - 1];
  if (mutation.op === 'delete') {
    invariant(last in parent, 'invalid-mutation-path');
    delete parent[last];
  } else if (mutation.op === 'remove') {
    invariant(Array.isArray(parent) && Number.isSafeInteger(last), 'invalid-mutation-path');
    invariant(last >= 0 && last < parent.length, 'invalid-mutation-path');
    parent.splice(last, 1);
  } else if (mutation.op === 'set') {
    parent[last] = structuredClone(mutation.value);
  } else {
    invariant(false, 'invalid-mutation-op');
  }
  return clone;
}

module.exports = {
  BASE,
  RISK_CUSTOM_VALIDATORS,
  RiskContractViolation,
  approvalDecisionDigest,
  bucketDigest,
  loadYaml,
  mutate,
  riskConstraintDispatchDescriptor,
  validateConstraint,
  validateRiskModule,
  validateScenario,
};
