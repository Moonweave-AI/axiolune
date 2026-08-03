'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const {
  ContractViolation,
  canonical,
  iriSetDigest,
  taggedJcsDigest,
  validateScenario,
} = require('./post-trade-v03-contract.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CQ_FUNCTION_VERSION = 'axiolune-m2-cq-post-trade/v2';
const GRAPH_CONTRACT = 'axiolune-m2-cq-post-trade-manifest/v2';
const MODULE_IRI = 'https://axiolune.ai/ontology/finance/post-trade-operations';
const REFERENCE_TIME = '2026-07-31T00:00:00Z';
const QUERY_DIGEST_TAG = 'axiolune-post-trade-cq-query-v2';
const RESULT_DIGEST_TAG = 'axiolune-post-trade-cq-result-v2';

class PostTradeCqError extends Error {
  constructor(code, detail = '', causeCode = undefined) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PostTradeCqError';
    this.code = code;
    if (causeCode !== undefined) this.causeCode = causeCode;
  }
}

function fail(code, detail = '', causeCode = undefined) {
  throw new PostTradeCqError(code, detail, causeCode);
}

function assert(condition, code, detail = '') {
  if (!condition) fail(code, detail);
}

function clone(value) {
  return structuredClone(value);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function isDigest(value) {
  return typeof value === 'string'
    && /^sha256:[0-9a-f]{64}$/u.test(value)
    && value !== `sha256:${'0'.repeat(64)}`;
}

function repositoryFile(relativePath, code = 'PTO_CQ_ARTIFACT_PATH') {
  assert(typeof relativePath === 'string' && relativePath.length > 0, code, String(relativePath));
  assert(!path.isAbsolute(relativePath), code, relativePath);
  const normalized = relativePath.replaceAll('\\', '/');
  assert(normalized === path.posix.normalize(normalized) && !normalized.startsWith('../'), code, relativePath);
  const resolved = path.resolve(ROOT, ...normalized.split('/'));
  const relative = path.relative(ROOT, resolved);
  assert(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative), code, relativePath);
  assert(fs.statSync(resolved, { throwIfNoEntry: false })?.isFile() === true, code, relativePath);
  const rootRealPath = fs.realpathSync(ROOT);
  const realPath = fs.realpathSync(resolved);
  const realRelative = path.relative(rootRealPath, realPath);
  assert(realRelative !== '' && !realRelative.startsWith('..') && !path.isAbsolute(realRelative),
    code, `${relativePath} resolves outside the repository`);
  return realPath;
}

function verifyLockedArtifact(reference, code = 'PTO_CQ_ARTIFACT_LOCK') {
  assert(isObject(reference), code, 'reference');
  const file = repositoryFile(reference.path, code);
  const actualDigest = sha256File(file);
  return { file, bytes: fs.readFileSync(file), digest: actualDigest };
}

function parseLockedArtifact(reference, code = 'PTO_CQ_ARTIFACT_LOCK') {
  const artifact = verifyLockedArtifact(reference, code);
  try {
    const text = artifact.bytes.toString('utf8');
    const document = reference.path.endsWith('.json') ? JSON.parse(text) : yaml.load(text);
    assert(isObject(document), 'PTO_CQ_ARTIFACT_PARSE', reference.path);
    return { ...artifact, document };
  } catch (cause) {
    if (cause instanceof PostTradeCqError) throw cause;
    fail('PTO_CQ_ARTIFACT_PARSE', `${reference.path}: ${cause.message}`);
  }
}

function queryDigest(cqId, query) {
  return taggedJcsDigest(QUERY_DIGEST_TAG, { cqId, query });
}

function resultDigest(cqId, rows) {
  return taggedJcsDigest(RESULT_DIGEST_TAG, { cqId, rows });
}

function exactMultiset(values) {
  return [...values].sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
}

function assertUnique(values, code, label) {
  assert(values.length === new Set(values).size, code, label);
}

function assertSameRef(left, right, code, label) {
  assert(left?.path === right?.path && left?.digest === right?.digest, code, label);
}

function verifyModuleAndImportClosure(graph, moduleDocument, registryDocument) {
  const module = moduleDocument?.module;
  assert(module?.moduleIri === MODULE_IRI, 'PTO_CQ_MODULE_LOCK', 'module IRI');
  assert(module.version === '0.3.0', 'PTO_CQ_MODULE_LOCK', 'module version');
  assert(module.status === 'draft' && module.governance?.status === 'draft', 'PTO_CQ_MODULE_LOCK', 'module status');
  const registryEntries = registryDocument?.modules;
  assert(Array.isArray(registryEntries), 'PTO_CQ_REGISTRY_LOCK', 'modules');
  assertUnique(registryEntries.map((entry) => entry.moduleIri), 'PTO_CQ_REGISTRY_LOCK', 'duplicate module IRI');
  const registryByIri = new Map(registryEntries.map((entry) => [entry.moduleIri, entry]));
  const moduleEntry = registryByIri.get(MODULE_IRI);
  assert(moduleEntry?.path === graph.module.path, 'PTO_CQ_REGISTRY_LOCK', 'post-trade path');
  assert(moduleEntry.version === module.version && moduleEntry.status === module.status,
    'PTO_CQ_REGISTRY_LOCK', 'post-trade metadata');

  const imports = module.imports || [];
  assert(imports.length > 0, 'PTO_CQ_IMPORT_CLOSURE', 'empty imports');
  assertUnique(imports.map((entry) => entry.moduleIri), 'PTO_CQ_IMPORT_CLOSURE', 'duplicate import');
  for (const imported of imports) {
    const registryEntry = registryByIri.get(imported.moduleIri);
    assert(registryEntry, 'PTO_CQ_IMPORT_CLOSURE', imported.moduleIri);
    assert(imported.version === registryEntry.version
      && imported.importMode === 'All', 'PTO_CQ_IMPORT_CLOSURE', imported.moduleIri);
    repositoryFile(registryEntry.path, 'PTO_CQ_IMPORT_CLOSURE');
  }
}

function verifyMaterializationRun(graph, run) {
  assert(run.contract === 'axiolune-post-trade-cq-materialization-run/v1',
    'PTO_CQ_MATERIALIZATION_RUN', 'contract');
  assert(run.status === 'completed' && run.result === 'success',
    'PTO_CQ_MATERIALIZATION_RUN', 'run is not completed successfully');
  assert(run.referenceTime === graph.referenceTime && run.referenceTime === REFERENCE_TIME,
    'PTO_CQ_MATERIALIZATION_RUN', 'referenceTime');
  assert(typeof run.runId === 'string' && /^https?:\/\//u.test(run.runId),
    'PTO_CQ_MATERIALIZATION_RUN', 'runId');
  assert(run.completedAt === run.referenceTime, 'PTO_CQ_MATERIALIZATION_RUN', 'completedAt');
  const required = [
    'module', 'registry', 'owl', 'shacl', 'semanticValidator',
    'coreValidator', 'pitValidator', 'canonicalSource', 'implementation', 'oracleGenerator',
  ];
  for (const name of required) assertSameRef(run.inputs?.[name], graph[name],
    'PTO_CQ_MATERIALIZATION_RUN', name);
}

function verifyControlLedgers(graph, pitLedger, probeLedger, expectedLedger) {
  assert(pitLedger.contract === 'axiolune-post-trade-cq-pit-ledger/v1'
    && pitLedger.status === 'completed', 'PTO_CQ_PIT_LEDGER', 'contract/status');
  assertSameRef(pitLedger.materializationRun, graph.materializationRun,
    'PTO_CQ_PIT_LEDGER', 'materialization run');
  assert(pitLedger.referenceTime === graph.referenceTime, 'PTO_CQ_PIT_LEDGER', 'referenceTime');
  assert(Array.isArray(pitLedger.cases) && pitLedger.cases.length > 0, 'PTO_CQ_PIT_LEDGER', 'cases');
  assertUnique(pitLedger.cases.map((entry) => entry.caseId), 'PTO_CQ_PIT_LEDGER', 'duplicate case ID');
  for (const entry of pitLedger.cases) {
    assert(['CQ-PTO1', 'CQ-PTO2'].includes(entry.cqId) && isDigest(entry.queryDigest),
      'PTO_CQ_PIT_LEDGER', entry.caseId);
    assert(entry.referenceTime === graph.referenceTime, 'PTO_CQ_PIT_LEDGER', `${entry.caseId} referenceTime`);
  }

  assert(probeLedger.contract === 'axiolune-post-trade-cq-probe-ledger/v1'
    && probeLedger.status === 'completed', 'PTO_CQ_PROBE_LEDGER', 'contract/status');
  assertSameRef(probeLedger.materializationRun, graph.materializationRun,
    'PTO_CQ_PROBE_LEDGER', 'materialization run');
  assertSameRef(probeLedger.pitLedger, graph.pitLedger, 'PTO_CQ_PROBE_LEDGER', 'PIT ledger');
  assertSameRef(probeLedger.canonicalSource, graph.canonicalSource,
    'PTO_CQ_PROBE_LEDGER', 'canonical source');
  assert(Array.isArray(probeLedger.cases), 'PTO_CQ_PROBE_LEDGER', 'cases');
  assertUnique(probeLedger.cases.map((entry) => entry.caseId), 'PTO_CQ_PROBE_LEDGER', 'duplicate case ID');
  for (const entry of probeLedger.cases) {
    assert(['CQ-PTO1', 'CQ-PTO2'].includes(entry.cqId) && isDigest(entry.resultDigest),
      'PTO_CQ_PROBE_LEDGER', entry.caseId);
  }

  assert(expectedLedger.contract === 'axiolune-independent-post-trade-ledger/v1',
    'PTO_CQ_EXPECTED_LEDGER', 'contract');
  assert(expectedLedger.derivedByRuntime === false && expectedLedger.reviewStatus === 'unapproved',
    'PTO_CQ_EXPECTED_LEDGER', 'independence/status');
  assert(Array.isArray(expectedLedger.cases) && expectedLedger.cases.length > 0,
    'PTO_CQ_EXPECTED_LEDGER', 'cases');
  assertUnique(expectedLedger.cases.map((entry) => entry.caseId),
    'PTO_CQ_EXPECTED_LEDGER', 'duplicate case ID');
}

function validateCanonicalSource(source) {
  assert(source?.fixtureProfile === 'axiolune-post-trade-v0.3',
    'PTO_CQ_CANONICAL_SOURCE', 'fixtureProfile');
  assert(Array.isArray(source.fixtures), 'PTO_CQ_CANONICAL_SOURCE', 'fixtures');
  const ids = source.fixtures.map((fixture) => fixture.id);
  assertUnique(ids, 'PTO_CQ_CANONICAL_SOURCE', 'duplicate scenario ID');
  const required = [
    'corporate-action-three-kind-closed-matrix',
    'distribution-assessment-price-kind-and-input-identity',
    'due-bill-bilateral-empty-correction-partial-full',
    'rights-election-subscription-adjustment-chain',
    'settlement-dvp-fop-direct-omnibus-allocation',
    'missing-side-strict-cash-security-key',
    'economic-allocation-projection-and-closed-finding-matrix',
    'settlement-account-security-cash-projection-and-status-history',
  ];
  assert(JSON.stringify(exactMultiset(ids)) === JSON.stringify(exactMultiset(required)),
    'PTO_CQ_CANONICAL_SOURCE', 'scenario closure');
  try {
    for (const fixture of source.fixtures) validateScenario(fixture);
  } catch (cause) {
    if (cause instanceof ContractViolation) {
      fail('PTO_CQ_CANONICAL_CONTRACT', cause.message, cause.code);
    }
    fail('PTO_CQ_CANONICAL_FATAL', cause?.message || String(cause));
  }
  return new Map(source.fixtures.map((fixture) => [fixture.id, fixture]));
}

function buildIndexes(source) {
  const fixturesById = validateCanonicalSource(source);
  return { fixturesById, scenarioCount: fixturesById.size };
}

function prepare(graph, sourceOverride = undefined) {
  assert(graph?.contract === GRAPH_CONTRACT, 'PTO_CQ_GRAPH_CONTRACT', String(graph?.contract));
  assert(graph.referenceTime === REFERENCE_TIME, 'PTO_CQ_GRAPH_CONTRACT', 'referenceTime');
  const refs = [
    'module', 'registry', 'owl', 'shacl', 'semanticValidator', 'coreValidator',
    'pitValidator', 'canonicalSource', 'implementation', 'oracleGenerator', 'materializationRun',
    'pitLedger', 'probeLedger', 'expectedLedger',
  ];
  for (const name of refs) assert(isObject(graph[name]), 'PTO_CQ_GRAPH_CONTRACT', name);

  const moduleArtifact = parseLockedArtifact(graph.module);
  const registryArtifact = parseLockedArtifact(graph.registry);
  const owlArtifact = verifyLockedArtifact(graph.owl);
  const shaclArtifact = verifyLockedArtifact(graph.shacl);
  verifyLockedArtifact(graph.semanticValidator);
  verifyLockedArtifact(graph.coreValidator);
  verifyLockedArtifact(graph.pitValidator);
  verifyLockedArtifact(graph.implementation);
  verifyLockedArtifact(graph.oracleGenerator);
  assert(owlArtifact.bytes.includes(Buffer.from(MODULE_IRI, 'utf8')),
    'PTO_CQ_PROJECTION_LOCK', 'OWL module IRI');
  assert(shaclArtifact.bytes.includes(Buffer.from(MODULE_IRI, 'utf8')),
    'PTO_CQ_PROJECTION_LOCK', 'SHACL module IRI');
  verifyModuleAndImportClosure(graph, moduleArtifact.document, registryArtifact.document);

  const sourceArtifact = parseLockedArtifact(graph.canonicalSource);
  const runArtifact = parseLockedArtifact(graph.materializationRun);
  const pitArtifact = parseLockedArtifact(graph.pitLedger);
  const probeArtifact = parseLockedArtifact(graph.probeLedger);
  const expectedArtifact = parseLockedArtifact(graph.expectedLedger);
  verifyMaterializationRun(graph, runArtifact.document);
  verifyControlLedgers(graph, pitArtifact.document, probeArtifact.document, expectedArtifact.document);

  const source = sourceOverride === undefined ? sourceArtifact.document : sourceOverride;
  const fixturesById = validateCanonicalSource(source);
  assert(Array.isArray(graph.targets) && graph.targets.length === 5,
    'PTO_CQ_GRAPH_CONTRACT', 'target bindings');
  assertUnique(graph.targets.map((entry) => entry.id), 'PTO_CQ_GRAPH_CONTRACT', 'duplicate target binding');
  return {
    fixturesById,
    pitLedger: pitArtifact.document,
    probeLedger: probeArtifact.document,
    expectedLedger: expectedArtifact.document,
  };
}

function parseInstant(value, code) {
  assert(typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value), code, String(value));
  const epoch = Date.parse(value);
  const canonicalInput = value.includes('.') ? value : `${value.slice(0, -1)}.000Z`;
  assert(Number.isFinite(epoch) && new Date(epoch).toISOString() === canonicalInput,
    code, String(value));
  return epoch;
}

function validatePivot(query, graph, target) {
  const pivot = query?.pivot;
  assert(isObject(pivot), 'PTO_CQ_PIVOT', 'missing pivot');
  const fields = ['asOfValid', 'asOfKnowledge', 'asOfAvailable', 'referenceTime'];
  assert(JSON.stringify(Object.keys(pivot).sort()) === JSON.stringify(fields.sort()),
    'PTO_CQ_PIVOT', 'pivot fields');
  const parsed = {};
  for (const field of fields) parsed[field] = parseInstant(pivot[field], 'PTO_CQ_PIVOT');
  assert(pivot.referenceTime === graph.referenceTime, 'PTO_CQ_REFERENCE_TIME', pivot.referenceTime);
  for (const field of ['asOfValid', 'asOfKnowledge', 'asOfAvailable']) {
    assert(parsed[field] <= parsed.referenceTime, 'PTO_CQ_FUTURE_PIVOT', field);
  }
  const axisByField = {
    asOfValid: 'valid', asOfKnowledge: 'knowledge', asOfAvailable: 'available',
  };
  for (const field of ['asOfValid', 'asOfKnowledge', 'asOfAvailable']) {
    const window = target.visibility?.[axisByField[field]];
    if (!window) continue;
    if (parsed[field] < parseInstant(window.from, 'PTO_CQ_GRAPH_CONTRACT')) return false;
    if (window.to && parsed[field] >= parseInstant(window.to, 'PTO_CQ_GRAPH_CONTRACT')) return false;
  }
  return true;
}

function targetMatches(cqId, target, query) {
  if (target.cqId !== cqId) return false;
  if (cqId === 'CQ-PTO1') return query.eventVersionIri === target.eventVersionIri;
  return query.instructionVersionIri === target.instructionVersionIri
    && query.reconciliationCaseVersionIri === target.reconciliationCaseVersionIri;
}

function findTarget(cqId, graph, query) {
  assert(['CQ-PTO1', 'CQ-PTO2'].includes(cqId), 'PTO_CQ_UNSUPPORTED', cqId);
  const expectedKeys = cqId === 'CQ-PTO1'
    ? ['eventVersionIri', 'pivot']
    : ['instructionVersionIri', 'pivot', 'reconciliationCaseVersionIri'];
  assert(isObject(query)
    && JSON.stringify(Object.keys(query).sort()) === JSON.stringify(expectedKeys.sort()),
  'PTO_CQ_QUERY_CONTRACT', cqId);
  const target = graph.targets.find((candidate) => targetMatches(cqId, candidate, query));
  return target;
}

function fixtureInstance(fixturesById, id) {
  const fixture = fixturesById.get(id);
  assert(fixture, 'PTO_CQ_CANONICAL_SOURCE', id);
  return fixture.instance;
}

function mapAssessment(instance) {
  return [{
    eventVersionIri: instance.event.versionIri,
    corporateActionKind: instance.event.kind,
    assessment: {
      evaluationInputVersionIri: instance.assessment.evaluationInputVersionIri,
      applicabilityVersionIri: instance.assessment.applicabilityVersionIri,
      scheduleRuleVersionIri: instance.assessment.scheduleRuleVersionIri,
      methodVersionIri: instance.assessment.methodVersionIri,
      inputKind: instance.assessment.inputKind,
      assessmentPercentage: instance.assessment.assessmentPercentage,
      priceKind: instance.assessment.priceKind,
      valuationPivot: instance.assessment.valuationPivot,
      priceObservation: clone(instance.assessment.priceObservation),
      inputVersionIris: clone(instance.assessment.inputVersionIris),
      inputVersionCount: instance.assessment.inputVersionCount,
      inputVersionSetDigest: instance.assessment.inputVersionSetDigest,
    },
  }];
}

function mapDueBill(instance) {
  return [{
    eventVersionIri: instance.event.versionIri,
    corporateActionKind: instance.event.kind,
    resolutionVersionIri: instance.resolution.versionIri,
    transferPitRequest: clone(instance.transferPitRequest),
    qualificationExecutionVersionIris: exactMultiset(
      instance.qualifications.map((entry) => entry.execution.versionIri),
    ),
    entitlements: instance.entitlements.map((entry) => ({
      account: entry.account,
      recordPosition: clone(entry.recordPosition),
      obligationVersionIris: clone(entry.obligationVersionIris),
      obligationCount: entry.obligationCount,
      obligationSetDigest: entry.obligationSetDigest,
      closureProbe: clone(entry.closureProbe),
      eligibleQuantity: entry.eligibleQuantity,
    })),
    obligations: instance.obligations.map((entry) => ({
      versionIri: entry.versionIri,
      liableAccount: entry.liableAccount,
      beneficiaryAccount: entry.beneficiaryAccount,
      liableParty: entry.liableParty,
      beneficiaryParty: entry.beneficiaryParty,
      sourceKind: entry.sourceKind,
      tradeQualificationVersionIri: entry.tradeQualificationVersionIri || null,
      externalClaimId: entry.externalClaimId || null,
      quantity: entry.quantity,
      benefit: clone(entry.benefit),
    })),
    transferClosures: instance.transferClosures.map((entry) => ({
      versionIri: entry.versionIri,
      obligationVersionIri: entry.obligationVersionIri,
      transferVersionIris: clone(entry.transferVersionIris),
      transferCount: entry.transferCount,
      transferSetDigest: entry.transferSetDigest,
      closureProbe: clone(entry.closureProbe),
      fulfilledAmount: entry.fulfilledAmount,
      remainingAmount: entry.remainingAmount,
      result: entry.result,
    })),
  }];
}

function mapRights(instance) {
  return [{
    eventVersionIri: instance.event.versionIri,
    corporateActionKind: instance.event.kind,
    entitlement: clone(instance.entitlement),
    electionPitRequest: clone(instance.electionPitRequest),
    providerPolicyVersionIri: instance.providerPolicy.versionIri,
    providerMemberVersionIris: exactMultiset(
      instance.providerPolicy.providerMembers.map((entry) => entry.versionIri),
    ),
    precedenceEdgeVersionIris: exactMultiset(
      instance.providerPolicy.precedenceEdges.map((entry) => entry.versionIri),
    ),
    candidates: instance.electionCandidates.map((entry) => ({
      versionIri: entry.versionIri,
      providerLogicalIri: entry.providerLogicalIri,
      decision: entry.decision,
      electedQuantity: entry.electedQuantity || null,
    })),
    candidateVersionIris: clone(instance.candidateVersionIris),
    candidateCount: instance.candidateCount,
    candidateSetDigest: instance.candidateSetDigest,
    candidateClosureProbe: clone(instance.candidateClosureProbe),
    resolution: clone(instance.resolution),
    subscriptionObligation: clone(instance.subscriptionObligation),
    fulfillmentPitRequest: clone(instance.fulfillmentPitRequest),
    fulfillments: instance.fulfillments.map((entry) => ({
      versionIri: entry.versionIri,
      state: entry.state,
      assetKind: entry.assetKind,
      amount: entry.amount,
      currency: entry.currency || null,
      instrumentIri: entry.instrumentIri || null,
      unit: entry.unit || null,
      fromAccount: entry.fromAccount,
      toAccount: entry.toAccount,
      occurrenceTime: entry.occurrenceTime,
      movementEvidenceIri: entry.movementEvidenceIri,
      movementEvidenceDigest: entry.movementEvidenceDigest,
    })),
    fulfillmentClosure: clone(instance.fulfillmentClosure),
    adjustment: clone(instance.adjustment),
  }];
}

function mapFinding(entry) {
  return {
    versionIri: entry.versionIri,
    keyId: entry.keyId,
    kind: entry.kind,
    internalProjectionVersionIris: clone(entry.internalProjectionVersionIris),
    externalStatementLineVersionIris: clone(entry.externalStatementLineVersionIris),
    internalCount: entry.internalCount,
    externalCount: entry.externalCount,
    missingSideAssertionVersionIri: entry.missingSideAssertionVersionIri || null,
    duplicateSide: entry.duplicateSide || null,
    internalDuplicateValueRelation: entry.internalDuplicateValueRelation || null,
    externalDuplicateValueRelation: entry.externalDuplicateValueRelation || null,
    crossSideValueRelation: entry.crossSideValueRelation || null,
    mismatchDimensions: clone(entry.mismatchDimensions || []),
    comparisonKeyDigest: entry.comparisonKeyDigest,
    evidenceSetDigest: entry.evidenceSetDigest,
    findingSubjectDigest: entry.findingSubjectDigest,
  };
}

function mapReconciliation(instance) {
  return {
    caseVersionIri: instance.case.versionIri,
    internalProjectionMode: instance.case.internalProjectionMode,
    focalAccount: instance.case.focalAccount,
    currentStatus: instance.case.currentStatus,
    pivots: {
      asOfValid: instance.case.reconciliationAsOfValid,
      asOfKnowledge: instance.case.reconciliationAsOfKnowledge,
      asOfAvailable: instance.case.reconciliationAsOfAvailable,
    },
    comparator: {
      versionIri: instance.comparator.versionIri,
      numericTolerance: instance.comparator.numericTolerance,
      implementationDigest: instance.comparator.implementationDigest,
      runtimeDigest: instance.comparator.runtimeDigest,
      inputContractDigest: instance.comparator.inputContractDigest,
      outputContractDigest: instance.comparator.outputContractDigest,
    },
    externalStatementVersionIri: instance.externalStatement.versionIri,
    comparisonKeys: instance.comparisonKeys.map((entry) => clone(entry)),
    internalProjections: instance.internalProjections.map((entry) => ({
      versionIri: entry.versionIri,
      keyId: entry.keyId,
      mode: entry.mode,
      legVersionIri: entry.legVersionIri,
      direction: entry.direction,
      allocationVersionIris: clone(entry.allocationVersionIris || []),
      bridgeVersionIris: clone(entry.bridgeVersionIris || []),
      internalSourceVersionSetDigest: entry.internalSourceVersionSetDigest,
      value: clone(entry.value),
    })),
    externalStatementLines: instance.externalStatementLines.map((entry) => ({
      versionIri: entry.versionIri,
      keyId: entry.keyId,
      authorityScopedId: entry.authorityScopedId,
      comparisonKeyDigest: entry.comparisonKeyDigest,
      value: clone(entry.value),
    })),
    missingSideAssertions: instance.missingSideAssertions.map((entry) => ({
      versionIri: entry.versionIri,
      keyId: entry.keyId,
      expectedSide: entry.expectedSide,
      comparisonKeyDigest: entry.comparisonKeyDigest,
      absenceProbeRef: entry.absenceProbeRef,
      absenceProbeDigest: entry.absenceProbeDigest,
    })),
    findings: instance.findings.map(mapFinding),
    statusHistory: instance.statusEvents.map((entry) => ({
      versionIri: entry.versionIri,
      providerEventId: entry.providerEventId,
      sourceOrderKey: entry.sourceOrderKey,
      state: entry.state,
      observedAt: entry.observedAt,
      sourceArtifactRef: entry.sourceArtifactRef,
      sourceArtifactDigest: entry.sourceArtifactDigest,
    })),
  };
}

function mapSettlement(settlement, reconciliation, target) {
  const instruction = settlement.instructions.find(
    (entry) => entry.versionIri === target.instructionVersionIri,
  );
  assert(instruction, 'PTO_CQ_IDENTITY_LOCK', target.instructionVersionIri);
  assert(reconciliation.case.versionIri === target.reconciliationCaseVersionIri,
    'PTO_CQ_IDENTITY_LOCK', target.reconciliationCaseVersionIri);
  const allocations = settlement.allocations.filter(
    (entry) => entry.instructionVersionIri === instruction.versionIri,
  );
  const executionVersionIris = exactMultiset(
    allocations.map((entry) => entry.execution.versionIri),
  );
  assert(JSON.stringify(executionVersionIris) === JSON.stringify(exactMultiset(target.executionVersionIris)),
    'PTO_CQ_IDENTITY_LOCK', 'allocation-execution-version-set');
  assert(instruction.statusEvents.some((entry) => entry.state === 'settled'),
    'PTO_CQ_IDENTITY_LOCK', 'canonical settled state');
  return [{
    instructionVersionIri: instruction.versionIri,
    deliveryMode: instruction.method,
    atomicGroupId: instruction.atomicGroupId,
    system: instruction.system,
    location: instruction.location,
    legs: instruction.legs.map((entry) => clone(entry)),
    allocations: allocations.map((entry) => ({
      versionIri: entry.versionIri,
      securityLegVersionIri: entry.securityLegVersionIri,
      execution: {
        versionIri: entry.execution.versionIri,
        side: entry.execution.side,
        account: entry.execution.account,
        instrumentIri: entry.execution.instrumentIri,
        quantity: {
          value: entry.execution.quantity,
          unit: entry.quantity.unit,
        },
      },
      quantity: clone(entry.quantity),
      fromEconomicAccount: entry.fromEconomicAccount,
      toEconomicAccount: entry.toEconomicAccount,
      fromMode: entry.fromMode,
      toMode: entry.toMode,
      fromBridgeVersionIri: entry.fromBridgeVersionIri || null,
      toBridgeVersionIri: entry.toBridgeVersionIri || null,
    })),
    settlementStatusHistory: instruction.statusEvents.map((entry) => clone(entry)),
    reconciliation: mapReconciliation(reconciliation),
  }];
}

function materializeTarget(target, fixturesById) {
  if (['assessment', 'dueBill', 'rights'].includes(target.role)) {
    const mapper = {
      assessment: mapAssessment,
      dueBill: mapDueBill,
      rights: mapRights,
    }[target.role];
    const rows = mapper(fixtureInstance(fixturesById, target.scenarioIds[0]));
    assert(rows.length === 1 && rows[0].eventVersionIri === target.eventVersionIri,
      'PTO_CQ_IDENTITY_LOCK', `${target.id} eventVersionIri`);
    return rows;
  }
  if (target.role === 'settlementReconciliation') {
    return mapSettlement(
      fixtureInstance(fixturesById, target.scenarioIds[0]),
      fixtureInstance(fixturesById, target.scenarioIds[1]),
      target,
    );
  }
  fail('PTO_CQ_GRAPH_CONTRACT', `unsupported target role ${target.role}`);
}

function verifyCaseControl(cqId, query, options, prepared) {
  const caseId = options?.caseId;
  assert(typeof caseId === 'string' && caseId.length > 0, 'PTO_CQ_CASE_ID', String(caseId));
  const records = prepared.pitLedger.cases.filter((entry) => entry.caseId === caseId);
  assert(records.length === 1, 'PTO_CQ_CASE_ID', caseId);
  const record = records[0];
  assert(record.cqId === cqId, 'PTO_CQ_CASE_ID', `${caseId} cqId`);
  assert(record.queryDigest === queryDigest(cqId, query), 'PTO_CQ_CASE_ID', `${caseId} query digest`);
  return caseId;
}

function verifyResultEvidence(cqId, caseId, rows, prepared) {
  const actualDigest = resultDigest(cqId, rows);
  const probes = prepared.probeLedger.cases.filter((entry) => entry.caseId === caseId);
  if (probes.length > 0) {
    assert(probes.length === 1 && probes[0].cqId === cqId && probes[0].resultDigest === actualDigest,
      'PTO_CQ_PROBE_RESULT_DRIFT', caseId);
  }
  const expected = prepared.expectedLedger.cases.filter((entry) => entry.caseId === caseId);
  if (expected.length > 0) {
    assert(expected.length === 1 && expected[0].cqId === cqId,
      'PTO_CQ_EXPECTED_LEDGER', caseId);
    assert(canonical(expected[0].rows) === canonical(rows),
      'PTO_CQ_EXPECTED_MISMATCH', caseId);
  }
}

function executePrepared(cqId, graph, query, options, prepared) {
  const target = findTarget(cqId, graph, query);
  const isEligible = target ? validatePivot(query, graph, target) : true;
  const caseId = verifyCaseControl(cqId, query, options, prepared);
  if (!target) {
    verifyResultEvidence(cqId, caseId, [], prepared);
    return [];
  }
  if (!isEligible) {
    verifyResultEvidence(cqId, caseId, [], prepared);
    return [];
  }
  const rows = materializeTarget(target, prepared.fixturesById);
  verifyResultEvidence(cqId, caseId, rows, prepared);
  return rows;
}

function executeCq(cqId, graph, query, options = {}) {
  return executePrepared(cqId, graph, query, options, prepare(graph));
}

/** Test-only seam: all byte locks/control records still execute; only canonical source bytes are replaced in memory. */
function executeFixtureCq(cqId, graph, query, sourceDocument, options = {}) {
  return executePrepared(cqId, graph, query, options, prepare(graph, sourceDocument));
}

module.exports = {
  CQ_FUNCTION_VERSION,
  GRAPH_CONTRACT,
  PostTradeCqError,
  buildIndexes,
  executeCq,
  executeFixtureCq,
  iriSetDigest,
  queryDigest,
  resultDigest,
  sha256File,
};
