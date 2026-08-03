'use strict';

const { validateScenario } = require('./risk-v03-contract.cjs');

const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

class RiskCqError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RiskCqError';
    this.code = code;
  }
}

function requireCq(condition, code, message) {
  if (!condition) throw new RiskCqError(code, message);
}

function instant(value, field) {
  requireCq(
    typeof value === 'string' && UTC_INSTANT.test(value),
    'RISK_CQ_INVALID_PIVOT',
    `${field} must be a canonical UTC instant`,
  );
  const parsed = Date.parse(value);
  requireCq(
    Number.isFinite(parsed) && new Date(parsed).toISOString() === value.replace('Z', '.000Z'),
    'RISK_CQ_INVALID_PIVOT',
    `${field} is not a real canonical UTC instant`,
  );
  return parsed;
}

function validatePivot(pivot) {
  requireCq(
    pivot && typeof pivot === 'object' && !Array.isArray(pivot),
    'RISK_CQ_INVALID_PIVOT',
    'query requires an explicit three-axis pivot and referenceTime',
  );
  const parsed = {
    valid: instant(pivot.asOfValid, 'asOfValid'),
    knowledge: instant(pivot.asOfKnowledge, 'asOfKnowledge'),
    available: instant(pivot.asOfAvailable, 'asOfAvailable'),
    reference: instant(pivot.referenceTime, 'referenceTime'),
  };
  requireCq(
    parsed.knowledge <= parsed.reference && parsed.available <= parsed.reference,
    'RISK_CQ_FUTURE_PIVOT',
    'knowledge and availability pivots may not exceed referenceTime',
  );
  return parsed;
}

function optionalEnd(value, field) {
  return value == null ? Infinity : instant(value, field);
}

function pitEligible(fact, pivot, closureByTargetAxis = new Map()) {
  requireCq(
    fact && fact.axes && typeof fact.axes === 'object',
    'RISK_CQ_MISSING_TEMPORAL',
    'queried risk fact has no temporal axes',
  );
  const axes = fact.axes;
  requireCq(
    !Object.hasOwn(axes, 'knowledgeTo') && !Object.hasOwn(axes, 'availableTo'),
    'RISK_CQ_INLINE_CLOSURE',
    'knowledgeTo/availableTo must be derived from closure evidence, not stored inline',
  );
  const validFrom = instant(axes.validFrom, 'validFrom');
  const knowledgeFrom = instant(axes.knowledgeFrom, 'knowledgeFrom');
  const availableFrom = instant(axes.availableFrom, 'availableFrom');
  const validTo = optionalEnd(axes.validTo, 'validTo');
  const knowledgeTo = optionalEnd(
    closureByTargetAxis.get(`${fact.versionIri}\0knowledge`)?.closedAt,
    'effectiveKnowledgeTo',
  );
  const availableTo = optionalEnd(
    closureByTargetAxis.get(`${fact.versionIri}\0availability`)?.closedAt,
    'effectiveAvailableTo',
  );
  return validFrom <= pivot.valid
    && pivot.valid < validTo
    && knowledgeFrom <= pivot.knowledge
    && pivot.knowledge < knowledgeTo
    && availableFrom <= pivot.available
    && pivot.available < availableTo
    && knowledgeFrom <= pivot.reference;
}

function effectiveTemporal(fact, closureByTargetAxis) {
  return {
    ...structuredClone(fact.axes),
    effectiveKnowledgeTo: closureByTargetAxis
      .get(`${fact.versionIri}\0knowledge`)?.closedAt || null,
    effectiveAvailableTo: closureByTargetAxis
      .get(`${fact.versionIri}\0availability`)?.closedAt || null,
  };
}

function exactScope(scopes, kind, ref) {
  return Array.isArray(scopes)
    && scopes.some((scope) => scope.kind === kind && scope.ref === ref);
}

function valueBranch(fact) {
  const names = ['money', 'quantity', 'bucketSet'];
  const selected = names.filter((name) => fact[name] !== undefined);
  requireCq(
    selected.length === 1,
    'RISK_CQ_VALUE_XONE',
    'risk value must have exactly one representation branch',
  );
  const kind = selected[0] === 'bucketSet' ? 'bucket' : selected[0];
  return { kind, value: structuredClone(fact[selected[0]]) };
}

function validateAndSelect(scenarios, pivot) {
  requireCq(Array.isArray(scenarios), 'RISK_CQ_INVALID_INPUT', 'scenarios must be an array');
  const parsedPivot = validatePivot(pivot);
  return scenarios.map((scenario, index) => {
    try {
      const validation = validateScenario(scenario);
      return {
        scenario: validation.scenario,
        pivot: parsedPivot,
        closureByTargetAxis: validation.closureByTargetAxis,
      };
    } catch (error) {
      throw new RiskCqError(
        'RISK_CQ_INVALID_SCENARIO',
        `scenario[${index}] violates ${error.code || error.message}`,
      );
    }
  });
}

function selectRiskMeasurements(scenarios, query) {
  requireCq(
    query && typeof query === 'object',
    'RISK_CQ_INVALID_QUERY',
    'measurement query is required',
  );
  requireCq(
    typeof query.scopeKind === 'string'
      && typeof query.scopeRef === 'string'
      && typeof query.riskMeasureId === 'string',
    'RISK_CQ_INVALID_QUERY',
    'scopeKind, scopeRef and riskMeasureId are required',
  );
  const rows = [];
  for (const { scenario, pivot, closureByTargetAxis } of validateAndSelect(scenarios, query.pivot)) {
    const { definition, measurement } = scenario;
    if (definition.riskMeasureId !== query.riskMeasureId) continue;
    if (!exactScope(measurement.scopes, query.scopeKind, query.scopeRef)) continue;
    if (!pitEligible(definition, pivot, closureByTargetAxis)
        || !pitEligible(measurement, pivot, closureByTargetAxis)) continue;
    const represented = valueBranch(measurement);
    const temporal = effectiveTemporal(measurement, closureByTargetAxis);
    rows.push({
      measurementVersionIri: measurement.versionIri,
      definitionVersionIri: definition.versionIri,
      riskMeasureId: definition.riskMeasureId,
      representation: represented.kind,
      value: represented.value,
      methodRef: definition.methodRef,
      methodVersion: definition.methodVersion,
      methodDigest: definition.methodDigest,
      implementationDigest: definition.implementationDigest,
      inputContractDigest: definition.inputContractDigest,
      outputContractDigest: definition.outputContractDigest,
      inputContextRef: measurement.inputContextRef,
      inputContextRecordDigest: measurement.inputContextRecordDigest,
      generatingContextRef: measurement.generatingContextRef,
      measurementProvenance: structuredClone(measurement.provenance),
      definitionProvenance: structuredClone(definition.provenance),
      temporal,
      effectiveKnowledgeTo: temporal.effectiveKnowledgeTo,
      effectiveAvailableTo: temporal.effectiveAvailableTo,
    });
  }
  requireCq(
    rows.length <= 1,
    'RISK_CQ_AMBIGUOUS_MEASUREMENT',
    'one scope/measure/PIT query resolved more than one RiskMeasurement',
  );
  rows.sort((left, right) => compareUtf8(left.measurementVersionIri, right.measurementVersionIri));
  return rows;
}

function selectRiskEvaluations(scenarios, query) {
  requireCq(
    query && typeof query === 'object'
      && typeof query.measurementVersionIri === 'string'
      && typeof query.limitVersionIri === 'string',
    'RISK_CQ_INVALID_QUERY',
    'measurementVersionIri and limitVersionIri are required',
  );
  const rows = [];
  for (const { scenario, pivot, closureByTargetAxis } of validateAndSelect(scenarios, query.pivot)) {
    const {
      definition, measurement, limit, evaluation, breach,
    } = scenario;
    if (measurement.versionIri !== query.measurementVersionIri
        || limit.versionIri !== query.limitVersionIri) continue;
    if (![definition, measurement, limit, evaluation]
      .every((fact) => pitEligible(fact, pivot, closureByTargetAxis))) {
      continue;
    }
    if (breach && !pitEligible(breach, pivot, closureByTargetAxis)) continue;
    requireCq(
      (evaluation.result === 'breach') === Boolean(breach),
      'RISK_CQ_BREACH_IFF',
      'LimitBreach must exist exactly when evaluation result is breach',
    );
    const evaluationTemporal = effectiveTemporal(evaluation, closureByTargetAxis);
    rows.push({
      evaluationVersionIri: evaluation.versionIri,
      measurementVersionIri: measurement.versionIri,
      limitVersionIri: limit.versionIri,
      result: evaluation.result,
      evaluatorDigest: evaluation.evaluatorDigest,
      generatingContextRef: evaluation.generatingContextRef,
      temporal: evaluationTemporal,
      evaluationTemporal,
      evaluationProvenance: structuredClone(evaluation.provenance),
      limitProvenance: structuredClone(limit.provenance),
      limitApproval: {
        ownerRef: limit.ownerRef,
        decisionRef: limit.approvalDecisionRef,
        decisionDigest: limit.approvalDecisionDigest,
        approvedBy: limit.approvedBy,
        approvedAt: limit.approvedAt,
      },
      breach: breach
        ? {
          versionIri: breach.versionIri,
          evaluationVersionIri: breach.evaluationVersionIri,
          measurementVersionIri: breach.measurementVersionIri,
          limitVersionIri: breach.limitVersionIri,
          generatingContextRef: breach.generatingContextRef,
          temporal: effectiveTemporal(breach, closureByTargetAxis),
          provenance: structuredClone(breach.provenance),
        }
        : null,
    });
  }
  requireCq(
    rows.length <= 1,
    'RISK_CQ_DUPLICATE_EVALUATION',
    'one exact measurement/limit pair resolved more than one evaluation',
  );
  rows.sort((left, right) => compareUtf8(left.evaluationVersionIri, right.evaluationVersionIri));
  return rows;
}

module.exports = {
  RiskCqError,
  pitEligible,
  selectRiskEvaluations,
  selectRiskMeasurements,
  validatePivot,
};
