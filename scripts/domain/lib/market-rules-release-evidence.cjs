'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const yaml = require('js-yaml');
const {
  parseJsonRejectingDuplicateMembers,
  resolveJsonPointer,
} = require('./json-pointer-source-extractor.cjs');
const { loadFixture } = require('./strict-fixture-loader.cjs');
const { canonicalJcs, validateArtifactRef } = require('./strict-source-locator.cjs');
const {
  buildClosureAssertionIri,
  buildRuleConflictIdentity,
  buildRuleEvaluationRequestIdentity,
  expandScopeClosure,
  resolveMarketRule,
  validateMarketRulesScenario,
} = require('./market-rules-cq.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_DIRECTORY = path.join(ROOT, 'tests', 'm2', 'fixtures', 'market-rules-v03');
const EVIDENCE_DIRECTORY = path.join(
  ROOT,
  'docs',
  'domain',
  'infrastructure',
  'market-rules-runtime-evidence',
);
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/market-rules-runtime-evidence/1.0';
const ARTIFACT_KIND = 'axiolune-market-rules-m2-test-evidence-ledger';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;

const TAGS = Object.freeze({
  closure: 'axiolune-market-rules-test-implementation-closure-v1\0',
  evidence: 'axiolune-market-rules-test-evidence-v1\0',
  identity: 'axiolune-market-rules-test-identity-v1\0',
  manifest: 'axiolune-market-rules-test-artifact-manifest-v1\0',
  result: 'axiolune-market-rules-test-result-v1\0',
  run: 'axiolune-market-rules-test-run-id-v1\0',
});

const CLASSIFICATION = Object.freeze({
  authorityClaim: 'none',
  evidenceScope: 'm2-runtime-conformance-test-only',
  externalAuthorityEvidence: false,
  productionEligible: false,
  syntheticFixture: true,
});

const FILES = Object.freeze({
  artifactManifest: path.join(EVIDENCE_DIRECTORY, 'artifact-manifest.json'),
  canonicalIdentityLedger: path.join(
    EVIDENCE_DIRECTORY,
    'canonical-external-fact-identity.ledger.json',
  ),
  factGenerationLedger: path.join(EVIDENCE_DIRECTORY, 'fact-generation-run.ledger.json'),
  forgedPriorityFixture: path.join(FIXTURE_DIRECTORY, 'negative-forged-priority-source.yaml'),
  implementationClosure: path.join(EVIDENCE_DIRECTORY, 'implementation-closure.json'),
  marketRulesModule: path.join(
    ROOT,
    'ontology',
    'domain',
    'finance',
    'market-rules',
    'module.yaml',
  ),
  positiveFixture: path.join(FIXTURE_DIRECTORY, 'positive-cq-execution.yaml'),
  precedenceLedger: path.join(
    EVIDENCE_DIRECTORY,
    'precedence-priority-authority.ledger.json',
  ),
  requestScopeFixture: path.join(
    FIXTURE_DIRECTORY,
    'negative-request-scope-contradiction.yaml',
  ),
  requestScopeLedger: path.join(EVIDENCE_DIRECTORY, 'request-scope-custom.ledger.json'),
  resolverLedger: path.join(EVIDENCE_DIRECTORY, 'resolver-run.ledger.json'),
  schemaManifest: path.join(EVIDENCE_DIRECTORY, 'schema-manifest.json'),
});

const IMPLEMENTATION_FILES = Object.freeze([
  ['evidence-runner', __filename],
  ['identity-contract-compiler', path.join(__dirname, 'identity-contract-compiler.cjs')],
  ['json-duplicate-and-jcs-reader', path.join(__dirname, 'json-pointer-source-extractor.cjs')],
  ['market-rules-resolver', path.join(__dirname, 'market-rules-cq.cjs')],
  ['package-manifest', path.join(ROOT, 'package.json')],
  ['package-lock', path.join(ROOT, 'package-lock.json')],
  ['strict-fixture-loader', path.join(__dirname, 'strict-fixture-loader.cjs')],
  ['strict-source-locator', path.join(__dirname, 'strict-source-locator.cjs')],
]);

const LEDGER_FILES = Object.freeze({
  canonicalExternalFactIdentity: FILES.canonicalIdentityLedger,
  factGenerationRun: FILES.factGenerationLedger,
  precedencePriorityAuthority: FILES.precedenceLedger,
  requestScopeCustom: FILES.requestScopeLedger,
  resolverRun: FILES.resolverLedger,
});

class MarketRulesReleaseEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarketRulesReleaseEvidenceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MarketRulesReleaseEvidenceError(code, message);
}

function invariant(condition, code, message) {
  if (!condition) fail(code, message);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function exactKeys(value, expected, label, code = 'MR_EVIDENCE_SCHEMA') {
  invariant(isPlainObject(value), code, `${label} must be a closed object`);
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  invariant(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    code,
    `${label} fields differ: expected ${wanted.join(',')}; found ${actual.join(',')}`,
  );
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function taggedJcsDigest(tag, value) {
  return sha256(Buffer.concat([
    Buffer.from(tag, 'utf8'),
    Buffer.from(canonicalJcs(value), 'utf8'),
  ]));
}

function jcsFileBytes(value) {
  return Buffer.from(`${canonicalJcs(value)}\n`, 'utf8');
}

function repositoryPath(file) {
  const relative = path.relative(ROOT, file);
  invariant(
    relative !== ''
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative),
    'MR_EVIDENCE_PATH',
    `artifact is outside sourceTree: ${file}`,
  );
  return relative.split(path.sep).join('/');
}

function artifactRef(file) {
  return { kind: 'path', path: repositoryPath(file), root: 'sourceTree' };
}

function resolveSourceTreeRef(ref, label) {
  const validation = validateArtifactRef(ref, label);
  invariant(validation.ok, 'MR_EVIDENCE_ARTIFACT_REF', validation.errors.join('; '));
  invariant(
    ref.kind === 'path' && ref.root === 'sourceTree',
    'MR_EVIDENCE_ARTIFACT_REF',
    `${label} must use a sourceTree path ref`,
  );
  const candidate = path.resolve(ROOT, ...ref.path.split('/'));
  const relative = path.relative(ROOT, candidate);
  invariant(
    relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'MR_EVIDENCE_ARTIFACT_REF',
    `${label} escapes sourceTree`,
  );
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (error) {
    fail('MR_EVIDENCE_ARTIFACT_REF', `${label} cannot be read: ${error.message}`);
  }
  const realRoot = fs.realpathSync(ROOT);
  const realRelative = path.relative(realRoot, real);
  invariant(
    realRelative !== '..'
      && !realRelative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(realRelative),
    'MR_EVIDENCE_ARTIFACT_REF',
    `${label} symlink escapes sourceTree`,
  );
  invariant(fs.statSync(real).isFile(), 'MR_EVIDENCE_ARTIFACT_REF', `${label} is not a file`);
  return real;
}

function rawFileBinding(file, role = undefined) {
  const bytes = fs.readFileSync(file);
  return {
    artifactDigest: sha256(bytes),
    artifactRef: artifactRef(file),
    ...(role === undefined ? {} : { role }),
  };
}

function objectFileBinding(file, value) {
  return {
    artifactDigest: sha256(jcsFileBytes(value)),
    artifactRef: artifactRef(file),
  };
}

function parseStrictJcsBytes(bytes, label = 'strict JCS artifact') {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    fail('MR_EVIDENCE_UTF8', `${label} is not strict UTF-8: ${error.message}`);
  }
  invariant(text.charCodeAt(0) !== 0xfeff, 'MR_EVIDENCE_UTF8', `${label} has a BOM`);
  invariant(text.endsWith('\n') && !text.endsWith('\n\n'), 'MR_EVIDENCE_JCS', `${label} must have exactly one terminal LF`);
  invariant(!text.includes('\r'), 'MR_EVIDENCE_JCS', `${label} contains CR bytes`);
  let value;
  try {
    value = parseJsonRejectingDuplicateMembers(text.slice(0, -1));
  } catch (error) {
    fail('MR_EVIDENCE_JSON', `${label} is ambiguous JSON: ${error.message}`);
  }
  let expected;
  try {
    expected = `${canonicalJcs(value)}\n`;
  } catch (error) {
    fail('MR_EVIDENCE_JCS', `${label} is outside the locked JCS profile: ${error.message}`);
  }
  invariant(text === expected, 'MR_EVIDENCE_JCS', `${label} bytes are not exact JCS plus one LF`);
  return value;
}

function readStrictJcs(file, label = repositoryPath(file)) {
  return parseStrictJcsBytes(fs.readFileSync(file), label);
}

function schemaObject(pathValue, requiredFields) {
  return { path: pathValue, requiredFields: [...requiredFields].sort(compareUtf8) };
}

function schemaArray(pathValue, requiredItemFields) {
  return { path: pathValue, requiredItemFields: [...requiredItemFields].sort(compareUtf8) };
}

function commonSchemaObjects(resultFields) {
  return [
    schemaObject('/classification', Object.keys(CLASSIFICATION)),
    schemaObject('/implementationClosureBinding', ['artifactDigest', 'artifactRef']),
    schemaObject('/results', resultFields),
    schemaObject('/schemaBinding', ['artifactDigest', 'artifactRef']),
  ];
}

function buildSchemaManifest() {
  const rootRequiredFields = [
    'artifactKind',
    'classification',
    'evidenceDigest',
    'implementationClosureBinding',
    'inputBindings',
    'ledgerKind',
    'outcome',
    'profileRef',
    'results',
    'runId',
    'schemaBinding',
    'schemaVersion',
  ].sort(compareUtf8);
  const schemas = [
    {
      ledgerKind: 'canonicalExternalFactIdentity',
      resultFields: ['collisionCount', 'identityRows', 'stableReplay'],
      objects: [],
      arrays: [schemaArray('/results/identityRows', [
        'factKind', 'identityDigest', 'logicalIri', 'status', 'versionIri',
      ])],
    },
    {
      ledgerKind: 'factGenerationRun',
      resultFields: ['factRows', 'summary'],
      objects: [schemaObject('/results/summary', [
        'closureFactCount', 'conflictFactCount', 'requestFactCount', 'totalFactCount',
      ])],
      arrays: [schemaArray('/results/factRows', [
        'factIri', 'factKind', 'identityDigest', 'sourceKey', 'status',
      ])],
    },
    {
      ledgerKind: 'precedencePriorityAuthority',
      resultFields: ['cases', 'policy'],
      objects: [schemaObject('/results/policy', [
        'crossAuthoritySilentWinner', 'numericPriorityBoundary', 'resolutionOrder',
      ])],
      arrays: [schemaArray('/results/cases', [
        'caseId', 'observedOutcome', 'resultDigest', 'selectedIri', 'status',
      ])],
    },
    {
      ledgerKind: 'requestScopeCustom',
      resultFields: [
        'constraintIri', 'negativeConflictCheck', 'positiveClosure', 'scenarioValidation',
      ],
      objects: [
        schemaObject('/results/negativeConflictCheck', [
          'actualViolation', 'caseId', 'path', 'status',
        ]),
        schemaObject('/results/positiveClosure', [
          'dependencyVersionIris', 'normalizedScopes', 'requestVersionIri', 'status',
        ]),
        schemaObject('/results/positiveClosure/normalizedScopes', [
          'instrument', 'listing', 'segment', 'venue',
        ]),
        schemaObject('/results/scenarioValidation', ['status', 'violationCount']),
      ],
      arrays: [],
    },
    {
      ledgerKind: 'resolverRun',
      resultFields: ['cases', 'outputGraphRef', 'scenarioValidation'],
      objects: [schemaObject('/results/scenarioValidation', ['status', 'violationCount'])],
      arrays: [schemaArray('/results/cases', [
        'caseId', 'evaluationRequestVersionIri', 'observedOutcome', 'queryDigest',
        'resultDigest', 'selectedIri', 'status',
      ])],
    },
  ].map((schema) => ({
    additionalProperties: false,
    closedArrayItems: schema.arrays.sort((left, right) => compareUtf8(left.path, right.path)),
    closedObjects: [
      ...commonSchemaObjects(schema.resultFields),
      ...schema.objects,
    ].sort((left, right) => compareUtf8(left.path, right.path)),
    ledgerKind: schema.ledgerKind,
    rootRequiredFields,
  })).sort((left, right) => compareUtf8(left.ledgerKind, right.ledgerKind));
  return {
    additionalProperties: false,
    artifactKind: 'axiolune-market-rules-m2-test-evidence-schema-manifest',
    ledgerSchemas: schemas,
    schemaVersion: '1.0',
  };
}

function buildImplementationClosure() {
  const artifacts = IMPLEMENTATION_FILES.map(([role, file]) => {
    const bytes = fs.readFileSync(file);
    return {
      artifactDigest: sha256(bytes),
      artifactRef: artifactRef(file),
      byteLength: bytes.length,
      role,
    };
  }).sort((left, right) => compareUtf8(left.role, right.role));
  const withoutDigest = {
    artifactKind: 'axiolune-market-rules-m2-test-implementation-closure',
    artifacts,
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
  };
  return {
    ...withoutDigest,
    closureDigest: taggedJcsDigest(TAGS.closure, withoutDigest),
  };
}

function inputBindings(entries) {
  const result = entries.map(([role, file]) => rawFileBinding(file, role))
    .sort((left, right) => compareUtf8(left.role, right.role));
  invariant(
    new Set(result.map((row) => row.role)).size === result.length,
    'MR_EVIDENCE_INPUT_BINDING',
    'input roles must be unique',
  );
  return result;
}

function requestById(scenario, requestId) {
  const request = scenario.evaluationRequests.find((row) => row.requestId === requestId);
  invariant(request, 'MR_EVIDENCE_FIXTURE', `missing request ${requestId}`);
  return request;
}

function exactQuery(scenario, kind, requestId) {
  return {
    evaluationRequestVersionIri: requestById(scenario, requestId).versionIri,
    kind,
    referenceTime: scenario.referenceTime,
  };
}

function validateRequestScopeModuleContract(moduleDocument) {
  const constraint = moduleDocument?.domain?.constraints?.RuleEvaluationRequestIntegrity;
  invariant(
    constraint?.iri
      === 'https://axiolune.ai/ontology/finance/market-rules/RuleEvaluationRequestIntegrity'
      && constraint?.expression?.language === 'Custom'
      && String(constraint?.expression?.expression || '').includes(
        'scopeClosure=listingToInstrumentAndFacility|segmentToVenue',
      ),
    'MR_EVIDENCE_REQUEST_SCOPE',
    'authored RuleEvaluationRequest Custom scope-closure contract drifted',
  );
  const bindings = (moduleDocument?.domain?.constraintBindings || []).filter((binding) => (
    binding.constraintRef === constraint.iri
      && binding.targetElement
        === 'https://axiolune.ai/ontology/finance/market-rules/RuleEvaluationRequest'
      && binding.enforcementLevel === 'Mandatory'
  ));
  invariant(
    bindings.length === 1,
    'MR_EVIDENCE_REQUEST_SCOPE',
    'RuleEvaluationRequest Custom contract must have one Mandatory target binding',
  );
}

function buildRequestScopeResults(scenario, negative, moduleDocument) {
  validateRequestScopeModuleContract(moduleDocument);
  const scenarioViolations = validateMarketRulesScenario(scenario);
  invariant(
    scenarioViolations.length === 0,
    'MR_EVIDENCE_REQUEST_SCOPE',
    `positive scenario violations: ${canonicalJcs(scenarioViolations)}`,
  );
  const request = requestById(scenario, 'mr1-listing-alpha');
  const scopeIndex = new Map(scenario.scopeVersions.map((row) => [row.versionIri, row]));
  const closure = expandScopeClosure(request.scopes, scopeIndex);
  invariant(
    closure.conflicts.length === 0,
    'MR_EVIDENCE_REQUEST_SCOPE',
    'positive request scope closure contains a contradiction',
  );
  const expectedScopes = {
    instrument: 'urn:instrument:alpha',
    listing: 'urn:listing:alpha-xnas',
    segment: 'urn:segment:xnas-equities',
    venue: 'urn:facility:xnas',
  };
  invariant(
    canonicalJcs(closure.normalized) === canonicalJcs(expectedScopes),
    'MR_EVIDENCE_REQUEST_SCOPE',
    `normalized request scopes drifted: ${canonicalJcs(closure.normalized)}`,
  );
  const negativeViolations = validateMarketRulesScenario(negative);
  invariant(
    negativeViolations.length === 1
      && negativeViolations[0].code === 'RULE_EVALUATION_REQUEST_SCOPE_INCONSISTENT'
      && negativeViolations[0].path === '$.evaluationRequests[2].scopes',
    'MR_EVIDENCE_REQUEST_SCOPE',
    `request-scope negative did not fail exactly: ${canonicalJcs(negativeViolations)}`,
  );
  return {
    constraintIri: 'https://axiolune.ai/ontology/finance/market-rules/RuleEvaluationRequestIntegrity',
    negativeConflictCheck: {
      actualViolation: negativeViolations[0].code,
      caseId: negative.caseId,
      path: negativeViolations[0].path,
      status: 'passed',
    },
    positiveClosure: {
      dependencyVersionIris: closure.dependencies.map((row) => row.versionIri)
        .sort(compareUtf8),
      normalizedScopes: closure.normalized,
      requestVersionIri: request.versionIri,
      status: 'passed',
    },
    scenarioValidation: { status: 'passed', violationCount: 0 },
  };
}

function resolvedSelection(result) {
  if (result.outcome === 'resolved') return result.ruleVersionIri;
  if (result.outcome === 'conflict') return result.conflictVersionIri;
  return 'https://axiolune.ai/outcomes/no-market-rule';
}

function executeResolverCase(scenario, specification) {
  const query = exactQuery(scenario, specification.kind, specification.requestId);
  const result = resolveMarketRule(scenario, query);
  const selectedIri = resolvedSelection(result);
  invariant(
    result.outcome === specification.outcome && selectedIri === specification.selectedIri,
    'MR_EVIDENCE_RESOLVER_REPLAY',
    `${specification.caseId} expected ${specification.outcome}/${specification.selectedIri}; found ${result.outcome}/${selectedIri}`,
  );
  return {
    caseId: specification.caseId,
    evaluationRequestVersionIri: query.evaluationRequestVersionIri,
    observedOutcome: result.outcome,
    queryDigest: taggedJcsDigest(TAGS.result, query),
    resultDigest: taggedJcsDigest(TAGS.result, result),
    selectedIri,
    status: 'passed',
  };
}

function buildResolverResults(scenario) {
  const violations = validateMarketRulesScenario(scenario);
  invariant(violations.length === 0, 'MR_EVIDENCE_RESOLVER_REPLAY', canonicalJcs(violations));
  const specifications = [
    {
      caseId: 'conflict-across-authorities',
      kind: 'priceLimit',
      outcome: 'conflict',
      requestId: 'mr2-conflict-beta',
      selectedIri: 'https://axiolune.ai/data/rule-conflict/sha256-cc7178f296464abd7fe23e41e935c7b6d4d342f0d861b98723ab1a1270859bcf/version/sha256-cb9dfd3f81827fc0ee3ec3f0073d321868afdecdda82f30ab752193ba550d355',
    },
    {
      caseId: 'listing-scope-closure',
      kind: 'settlementCycle',
      outcome: 'resolved',
      requestId: 'mr1-listing-alpha',
      selectedIri: 'urn:rule:settlement-main:version:1',
    },
    {
      caseId: 'reviewed-precedence',
      kind: 'priceLimit',
      outcome: 'resolved',
      requestId: 'mr2-alpha',
      selectedIri: 'urn:rule:price-primary:version:1',
    },
    {
      caseId: 'three-axis-current-settlement',
      kind: 'settlementCycle',
      outcome: 'resolved',
      requestId: 'mr1-alpha-current',
      selectedIri: 'urn:rule:settlement-main:version:1',
    },
  ];
  return {
    cases: specifications.map((row) => executeResolverCase(scenario, row))
      .sort((left, right) => compareUtf8(left.caseId, right.caseId)),
    outputGraphRef: scenario.graphRef,
    scenarioValidation: { status: 'passed', violationCount: 0 },
  };
}

function generatedIdentityRows(scenario) {
  const rows = [];
  for (const request of scenario.evaluationRequests) {
    const authority = scenario.requestAuthorityVersions.find(
      (row) => row.versionIri === request.requestAuthorityVersionIri,
    );
    invariant(authority, 'MR_EVIDENCE_FACT_GENERATION', `request authority missing for ${request.requestId}`);
    const generated = buildRuleEvaluationRequestIdentity(request, authority.logicalIri);
    invariant(
      generated.logicalIri === request.logicalIri && generated.versionIri === request.versionIri,
      'MR_EVIDENCE_FACT_GENERATION',
      `RuleEvaluationRequest identity drift for ${request.requestId}`,
    );
    rows.push({
      factKind: 'RuleEvaluationRequest',
      logicalIri: generated.logicalIri,
      sourceKey: request.requestId,
      versionIri: generated.versionIri,
    });
  }
  for (const conflict of scenario.ruleConflicts) {
    const request = scenario.evaluationRequests.find(
      (row) => row.versionIri === conflict.evaluationRequestVersionIri,
    );
    invariant(request, 'MR_EVIDENCE_FACT_GENERATION', 'conflict request is missing');
    const generated = buildRuleConflictIdentity(conflict, request.logicalIri);
    invariant(
      generated.logicalIri === conflict.logicalIri && generated.versionIri === conflict.versionIri,
      'MR_EVIDENCE_FACT_GENERATION',
      `RuleConflict identity drift for ${conflict.versionIri}`,
    );
    rows.push({
      factKind: 'RuleConflict',
      logicalIri: generated.logicalIri,
      sourceKey: conflict.evaluationRequestVersionIri,
      versionIri: generated.versionIri,
    });
  }
  for (const closure of scenario.closures) {
    const generated = buildClosureAssertionIri(closure);
    invariant(
      generated === closure.id,
      'MR_EVIDENCE_FACT_GENERATION',
      `FactClosureAssertion identity drift for ${closure.targetVersionIri}/${closure.axis}`,
    );
    rows.push({
      factKind: 'FactClosureAssertion',
      logicalIri: generated,
      sourceKey: `${closure.targetVersionIri}\0${closure.axis}`,
      versionIri: generated,
    });
  }
  return rows.sort((left, right) => compareUtf8(left.versionIri, right.versionIri));
}

function buildFactGenerationResults(scenario) {
  const identities = generatedIdentityRows(scenario);
  const factRows = identities.map((row) => ({
    factIri: row.versionIri,
    factKind: row.factKind,
    identityDigest: taggedJcsDigest(TAGS.identity, {
      logicalIri: row.logicalIri,
      versionIri: row.versionIri,
    }),
    sourceKey: row.sourceKey,
    status: 'passed',
  }));
  const count = (kind) => factRows.filter((row) => row.factKind === kind).length;
  return {
    factRows,
    summary: {
      closureFactCount: count('FactClosureAssertion'),
      conflictFactCount: count('RuleConflict'),
      requestFactCount: count('RuleEvaluationRequest'),
      totalFactCount: factRows.length,
    },
  };
}

function buildCanonicalIdentityResults(scenario) {
  const first = generatedIdentityRows(scenario);
  const second = generatedIdentityRows(structuredClone(scenario));
  const stableReplay = canonicalJcs(first) === canonicalJcs(second);
  invariant(stableReplay, 'MR_EVIDENCE_IDENTITY', 'identity replay is not deterministic');
  const versions = new Map();
  let collisionCount = 0;
  for (const row of first) {
    const identity = canonicalJcs({
      factKind: row.factKind,
      logicalIri: row.logicalIri,
      versionIri: row.versionIri,
    });
    if (versions.has(row.versionIri) && versions.get(row.versionIri) !== identity) collisionCount += 1;
    versions.set(row.versionIri, identity);
  }
  invariant(collisionCount === 0, 'MR_EVIDENCE_IDENTITY', 'one version IRI maps to different identities');
  return {
    collisionCount,
    identityRows: first.map((row) => ({
      factKind: row.factKind,
      identityDigest: taggedJcsDigest(TAGS.identity, {
        factKind: row.factKind,
        logicalIri: row.logicalIri,
        versionIri: row.versionIri,
      }),
      logicalIri: row.logicalIri,
      status: 'passed',
      versionIri: row.versionIri,
    })),
    stableReplay,
  };
}

function precedenceResultRow(caseId, result) {
  return {
    caseId,
    observedOutcome: result.outcome,
    resultDigest: taggedJcsDigest(TAGS.result, result),
    selectedIri: resolvedSelection(result),
    status: 'passed',
  };
}

function buildPrecedenceResults(scenario, forgedPriority) {
  const rows = [];
  const precedence = resolveMarketRule(scenario, exactQuery(scenario, 'priceLimit', 'mr2-alpha'));
  invariant(
    precedence.outcome === 'resolved'
      && precedence.ruleVersionIri === 'urn:rule:price-primary:version:1',
    'MR_EVIDENCE_PRECEDENCE',
    'reviewed precedence did not run before numeric priority',
  );
  rows.push(precedenceResultRow('reviewed-precedence-before-priority', precedence));

  const priorityScenario = structuredClone(scenario);
  priorityScenario.precedence = [];
  const priority = resolveMarketRule(
    priorityScenario,
    exactQuery(priorityScenario, 'priceLimit', 'mr2-alpha'),
  );
  invariant(
    priority.outcome === 'resolved'
      && priority.ruleVersionIri === 'urn:rule:price-secondary:version:1',
    'MR_EVIDENCE_PRECEDENCE',
    'numeric priority did not select inside one comparable group',
  );
  rows.push(precedenceResultRow('priority-inside-identical-authority-scope', priority));

  const specificityScenario = structuredClone(priorityScenario);
  specificityScenario.applicabilities.find(
    (row) => row.versionIri === 'urn:applicability:price-secondary:version:1',
  ).scopes = { venue: 'urn:facility:xnas:version:1' };
  const specificity = resolveMarketRule(
    specificityScenario,
    exactQuery(specificityScenario, 'priceLimit', 'mr2-alpha'),
  );
  invariant(
    specificity.outcome === 'resolved'
      && specificity.ruleVersionIri === 'urn:rule:price-primary:version:1',
    'MR_EVIDENCE_PRECEDENCE',
    'specificity did not execute before numeric priority',
  );
  rows.push(precedenceResultRow('specificity-before-priority', specificity));

  const authorityConflict = resolveMarketRule(
    scenario,
    exactQuery(scenario, 'priceLimit', 'mr2-conflict-beta'),
  );
  invariant(
    authorityConflict.outcome === 'conflict',
    'MR_EVIDENCE_PRECEDENCE',
    'cross-authority priority selected a silent winner',
  );
  rows.push(precedenceResultRow('cross-authority-priority-forbidden', authorityConflict));

  const forgedViolations = validateMarketRulesScenario(forgedPriority);
  invariant(
    forgedViolations.length === 1
      && forgedViolations[0].code === 'RULE_APPLICABILITY_SOURCE',
    'MR_EVIDENCE_PRECEDENCE',
    `forged source was not rejected exactly: ${canonicalJcs(forgedViolations)}`,
  );
  rows.push({
    caseId: 'forged-priority-source-rejected',
    observedOutcome: 'rejected',
    resultDigest: taggedJcsDigest(TAGS.result, forgedViolations),
    selectedIri: 'https://axiolune.ai/violations/RULE_APPLICABILITY_SOURCE',
    status: 'passed',
  });

  return {
    cases: rows.sort((left, right) => compareUtf8(left.caseId, right.caseId)),
    policy: {
      crossAuthoritySilentWinner: false,
      numericPriorityBoundary: 'same-rule-set-authority-and-normalized-scope',
      resolutionOrder: 'precedence-then-specificity-then-comparable-priority',
    },
  };
}

function ledgerRunId(ledger) {
  return taggedJcsDigest(TAGS.run, {
    classification: ledger.classification,
    implementationClosureBinding: ledger.implementationClosureBinding,
    inputBindings: ledger.inputBindings,
    ledgerKind: ledger.ledgerKind,
    profileRef: ledger.profileRef,
    schemaBinding: ledger.schemaBinding,
  });
}

function ledgerEvidenceDigest(ledger) {
  const withoutDigest = structuredClone(ledger);
  delete withoutDigest.evidenceDigest;
  return taggedJcsDigest(TAGS.evidence, withoutDigest);
}

function buildLedger(kind, results, inputs, schema, closure) {
  const ledger = {
    artifactKind: ARTIFACT_KIND,
    classification: structuredClone(CLASSIFICATION),
    implementationClosureBinding: objectFileBinding(FILES.implementationClosure, closure),
    inputBindings: inputBindings(inputs),
    ledgerKind: kind,
    outcome: 'passed',
    profileRef: PROFILE_REF,
    results,
    runId: null,
    schemaBinding: objectFileBinding(FILES.schemaManifest, schema),
    schemaVersion: '1.0',
  };
  ledger.runId = ledgerRunId(ledger);
  ledger.evidenceDigest = ledgerEvidenceDigest(ledger);
  return ledger;
}

function loadEvidenceFixtures() {
  let moduleDocument;
  try {
    moduleDocument = yaml.load(fs.readFileSync(FILES.marketRulesModule, 'utf8'), {
      schema: yaml.JSON_SCHEMA,
    });
  } catch (error) {
    fail('MR_EVIDENCE_REQUEST_SCOPE', `market-rules module cannot be parsed: ${error.message}`);
  }
  return {
    forgedPriority: loadFixture(FILES.forgedPriorityFixture, { rootDirectory: FIXTURE_DIRECTORY }),
    moduleDocument,
    positive: loadFixture(FILES.positiveFixture, { rootDirectory: FIXTURE_DIRECTORY }),
    requestScopeNegative: loadFixture(FILES.requestScopeFixture, { rootDirectory: FIXTURE_DIRECTORY }),
  };
}

function buildLedgers(schema, closure) {
  const fixtures = loadEvidenceFixtures();
  const commonInput = [['market-rules-module-contract', FILES.marketRulesModule]];
  return {
    canonicalExternalFactIdentity: buildLedger(
      'canonicalExternalFactIdentity',
      buildCanonicalIdentityResults(fixtures.positive),
      [...commonInput, ['positive-synthetic-scenario', FILES.positiveFixture]],
      schema,
      closure,
    ),
    factGenerationRun: buildLedger(
      'factGenerationRun',
      buildFactGenerationResults(fixtures.positive),
      [...commonInput, ['positive-synthetic-scenario', FILES.positiveFixture]],
      schema,
      closure,
    ),
    precedencePriorityAuthority: buildLedger(
      'precedencePriorityAuthority',
      buildPrecedenceResults(fixtures.positive, fixtures.forgedPriority),
      [
        ...commonInput,
        ['forged-priority-source-negative', FILES.forgedPriorityFixture],
        ['positive-synthetic-scenario', FILES.positiveFixture],
      ],
      schema,
      closure,
    ),
    requestScopeCustom: buildLedger(
      'requestScopeCustom',
      buildRequestScopeResults(
        fixtures.positive,
        fixtures.requestScopeNegative,
        fixtures.moduleDocument,
      ),
      [
        ...commonInput,
        ['positive-synthetic-scenario', FILES.positiveFixture],
        ['request-scope-conflict-negative', FILES.requestScopeFixture],
      ],
      schema,
      closure,
    ),
    resolverRun: buildLedger(
      'resolverRun',
      buildResolverResults(fixtures.positive),
      [...commonInput, ['positive-synthetic-scenario', FILES.positiveFixture]],
      schema,
      closure,
    ),
  };
}

function generatedObjectByFile(schema, closure, ledgers) {
  return new Map([
    [FILES.schemaManifest, schema],
    [FILES.implementationClosure, closure],
    ...Object.entries(LEDGER_FILES).map(([kind, file]) => [file, ledgers[kind]]),
  ]);
}

function manifestArtifactRows(schema, closure, ledgers) {
  const generated = generatedObjectByFile(schema, closure, ledgers);
  const rows = [];
  const seen = new Set();
  function add(role, file) {
    if (seen.has(file)) return;
    seen.add(file);
    const bytes = generated.has(file) ? jcsFileBytes(generated.get(file)) : fs.readFileSync(file);
    rows.push({
      artifactDigest: sha256(bytes),
      artifactRef: artifactRef(file),
      byteLength: bytes.length,
      role,
    });
  }
  add('evidence-schema-manifest', FILES.schemaManifest);
  add('implementation-closure', FILES.implementationClosure);
  for (const [kind, file] of Object.entries(LEDGER_FILES)) add(`ledger-${kind}`, file);
  add('market-rules-module-contract', FILES.marketRulesModule);
  add('positive-synthetic-scenario', FILES.positiveFixture);
  add('request-scope-conflict-negative', FILES.requestScopeFixture);
  add('forged-priority-source-negative', FILES.forgedPriorityFixture);
  for (const [role, file] of IMPLEMENTATION_FILES) add(`implementation-${role}`, file);
  return rows.sort((left, right) => compareUtf8(left.role, right.role));
}

function buildArtifactManifest(schema, closure, ledgers) {
  const withoutDigest = {
    artifactKind: 'axiolune-market-rules-m2-test-evidence-artifact-manifest',
    artifacts: manifestArtifactRows(schema, closure, ledgers),
    classification: structuredClone(CLASSIFICATION),
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
  };
  return {
    ...withoutDigest,
    manifestDigest: taggedJcsDigest(TAGS.manifest, withoutDigest),
  };
}

function buildAllMarketRulesReleaseEvidence() {
  const schema = buildSchemaManifest();
  const implementationClosure = buildImplementationClosure();
  const ledgers = buildLedgers(schema, implementationClosure);
  const artifactManifest = buildArtifactManifest(schema, implementationClosure, ledgers);
  return { artifactManifest, implementationClosure, ledgers, schema };
}

function validateSchemaManifest(schema) {
  exactKeys(
    schema,
    ['additionalProperties', 'artifactKind', 'ledgerSchemas', 'schemaVersion'],
    'schema manifest',
  );
  invariant(
    schema.additionalProperties === false
      && schema.artifactKind === 'axiolune-market-rules-m2-test-evidence-schema-manifest'
      && schema.schemaVersion === '1.0'
      && Array.isArray(schema.ledgerSchemas)
      && schema.ledgerSchemas.length === 5,
    'MR_EVIDENCE_SCHEMA',
    'schema manifest identity or inventory drifted',
  );
  let priorKind = null;
  for (const [index, ledgerSchema] of schema.ledgerSchemas.entries()) {
    exactKeys(
      ledgerSchema,
      [
        'additionalProperties', 'closedArrayItems', 'closedObjects', 'ledgerKind',
        'rootRequiredFields',
      ],
      `schema manifest ledgerSchemas[${index}]`,
    );
    invariant(
      ledgerSchema.additionalProperties === false
        && typeof ledgerSchema.ledgerKind === 'string'
        && Array.isArray(ledgerSchema.rootRequiredFields)
        && Array.isArray(ledgerSchema.closedObjects)
        && Array.isArray(ledgerSchema.closedArrayItems)
        && (priorKind === null || compareUtf8(priorKind, ledgerSchema.ledgerKind) < 0),
      'MR_EVIDENCE_SCHEMA',
      'ledger schemas must be closed and strictly ledgerKind-sorted',
    );
    for (const [collectionName, collection, fieldName] of [
      ['closedObjects', ledgerSchema.closedObjects, 'requiredFields'],
      ['closedArrayItems', ledgerSchema.closedArrayItems, 'requiredItemFields'],
    ]) {
      let priorPath = null;
      for (const [rowIndex, row] of collection.entries()) {
        exactKeys(row, ['path', fieldName], `${ledgerSchema.ledgerKind}.${collectionName}[${rowIndex}]`);
        invariant(
          typeof row.path === 'string'
            && row.path.startsWith('/')
            && Array.isArray(row[fieldName])
            && (priorPath === null || compareUtf8(priorPath, row.path) < 0),
          'MR_EVIDENCE_SCHEMA',
          `${ledgerSchema.ledgerKind}.${collectionName} must be path-sorted closed schema rows`,
        );
        priorPath = row.path;
      }
    }
    priorKind = ledgerSchema.ledgerKind;
  }
}

function schemaForLedger(schema, ledgerKind) {
  const matches = schema.ledgerSchemas.filter((row) => row.ledgerKind === ledgerKind);
  invariant(matches.length === 1, 'MR_EVIDENCE_SCHEMA', `no unique schema for ${ledgerKind}`);
  return matches[0];
}

function validateClosedSchema(ledger, schema) {
  const selected = schemaForLedger(schema, ledger?.ledgerKind);
  exactKeys(ledger, selected.rootRequiredFields, `${ledger?.ledgerKind || 'unknown'} ledger`);
  for (const row of selected.closedObjects) {
    let value;
    try {
      value = resolveJsonPointer(ledger, row.path);
    } catch (error) {
      fail('MR_EVIDENCE_SCHEMA', `${selected.ledgerKind}${row.path} is missing: ${error.message}`);
    }
    exactKeys(value, row.requiredFields, `${selected.ledgerKind}${row.path}`);
  }
  for (const row of selected.closedArrayItems) {
    let values;
    try {
      values = resolveJsonPointer(ledger, row.path);
    } catch (error) {
      fail('MR_EVIDENCE_SCHEMA', `${selected.ledgerKind}${row.path} is missing: ${error.message}`);
    }
    invariant(Array.isArray(values), 'MR_EVIDENCE_SCHEMA', `${selected.ledgerKind}${row.path} must be an array`);
    values.forEach((value, index) => exactKeys(
      value,
      row.requiredItemFields,
      `${selected.ledgerKind}${row.path}/${index}`,
    ));
  }
}

function validateBinding(binding, label, roleRequired = false) {
  exactKeys(
    binding,
    roleRequired ? ['artifactDigest', 'artifactRef', 'role'] : ['artifactDigest', 'artifactRef'],
    label,
  );
  invariant(DIGEST_RE.test(binding.artifactDigest || ''), 'MR_EVIDENCE_BINDING', `${label} digest is invalid`);
  if (roleRequired) invariant(typeof binding.role === 'string' && binding.role.length > 0, 'MR_EVIDENCE_BINDING', `${label} role is invalid`);
  const file = resolveSourceTreeRef(binding.artifactRef, `${label}.artifactRef`);
  invariant(
    sha256(fs.readFileSync(file)) === binding.artifactDigest,
    'MR_EVIDENCE_BINDING',
    `${label} byte digest drifted`,
  );
}

function validateClassification(classification, label) {
  exactKeys(classification, Object.keys(CLASSIFICATION), label);
  invariant(
    canonicalJcs(classification) === canonicalJcs(CLASSIFICATION),
    'MR_EVIDENCE_CLASSIFICATION',
    `${label} must remain synthetic, non-production, and non-authoritative`,
  );
}

function verifyLedgerCandidate(candidate, expected, schema) {
  validateClosedSchema(candidate, schema);
  invariant(candidate.artifactKind === ARTIFACT_KIND, 'MR_EVIDENCE_SCHEMA', 'ledger artifactKind drifted');
  invariant(candidate.schemaVersion === '1.0', 'MR_EVIDENCE_SCHEMA', 'ledger schemaVersion drifted');
  invariant(candidate.profileRef === PROFILE_REF, 'MR_EVIDENCE_SCHEMA', 'ledger profileRef drifted');
  invariant(candidate.outcome === 'passed', 'MR_EVIDENCE_OUTCOME', `${candidate.ledgerKind} did not pass`);
  validateClassification(candidate.classification, `${candidate.ledgerKind}.classification`);
  validateBinding(candidate.implementationClosureBinding, `${candidate.ledgerKind}.implementationClosureBinding`);
  validateBinding(candidate.schemaBinding, `${candidate.ledgerKind}.schemaBinding`);
  invariant(
    Array.isArray(candidate.inputBindings) && candidate.inputBindings.length > 0,
    'MR_EVIDENCE_BINDING',
    `${candidate.ledgerKind}.inputBindings must be non-empty`,
  );
  let priorRole = null;
  for (const [index, binding] of candidate.inputBindings.entries()) {
    validateBinding(binding, `${candidate.ledgerKind}.inputBindings[${index}]`, true);
    invariant(
      priorRole === null || compareUtf8(priorRole, binding.role) < 0,
      'MR_EVIDENCE_BINDING',
      `${candidate.ledgerKind}.inputBindings must be strictly role-sorted`,
    );
    priorRole = binding.role;
  }
  invariant(candidate.runId === ledgerRunId(candidate), 'MR_EVIDENCE_RUN_ID', `${candidate.ledgerKind} runId drifted`);
  invariant(
    candidate.evidenceDigest === ledgerEvidenceDigest(candidate),
    'MR_EVIDENCE_DIGEST',
    `${candidate.ledgerKind} evidenceDigest drifted`,
  );
  invariant(
    canonicalJcs(candidate) === canonicalJcs(expected),
    'MR_EVIDENCE_RECOMPUTE',
    `${candidate.ledgerKind} differs from actual deterministic replay`,
  );
}

function validateImplementationClosure(closure) {
  exactKeys(
    closure,
    ['artifactKind', 'artifacts', 'closureDigest', 'profileRef', 'schemaVersion'],
    'implementation closure',
  );
  invariant(
    closure.artifactKind === 'axiolune-market-rules-m2-test-implementation-closure'
      && closure.profileRef === PROFILE_REF
      && closure.schemaVersion === '1.0'
      && Array.isArray(closure.artifacts)
      && closure.artifacts.length === IMPLEMENTATION_FILES.length,
    'MR_EVIDENCE_IMPLEMENTATION',
    'implementation closure identity/inventory drifted',
  );
  let priorRole = null;
  for (const [index, row] of closure.artifacts.entries()) {
    exactKeys(row, ['artifactDigest', 'artifactRef', 'byteLength', 'role'], `implementation closure artifacts[${index}]`);
    validateBinding({ artifactDigest: row.artifactDigest, artifactRef: row.artifactRef }, `implementation closure artifacts[${index}]`);
    const file = resolveSourceTreeRef(row.artifactRef, `implementation closure artifacts[${index}].artifactRef`);
    invariant(fs.readFileSync(file).length === row.byteLength, 'MR_EVIDENCE_IMPLEMENTATION', `implementation ${row.role} byteLength drifted`);
    invariant(priorRole === null || compareUtf8(priorRole, row.role) < 0, 'MR_EVIDENCE_IMPLEMENTATION', 'implementation artifacts are not role-sorted');
    priorRole = row.role;
  }
  const withoutDigest = structuredClone(closure);
  delete withoutDigest.closureDigest;
  invariant(
    closure.closureDigest === taggedJcsDigest(TAGS.closure, withoutDigest),
    'MR_EVIDENCE_IMPLEMENTATION',
    'implementation closureDigest drifted',
  );
}

function validateArtifactManifest(manifest, expected) {
  exactKeys(
    manifest,
    ['artifactKind', 'artifacts', 'classification', 'manifestDigest', 'profileRef', 'schemaVersion'],
    'artifact manifest',
  );
  invariant(
    manifest.artifactKind === 'axiolune-market-rules-m2-test-evidence-artifact-manifest'
      && manifest.profileRef === PROFILE_REF
      && manifest.schemaVersion === '1.0'
      && Array.isArray(manifest.artifacts),
    'MR_EVIDENCE_MANIFEST',
    'artifact manifest identity drifted',
  );
  validateClassification(manifest.classification, 'artifact manifest classification');
  let priorRole = null;
  for (const [index, row] of manifest.artifacts.entries()) {
    exactKeys(row, ['artifactDigest', 'artifactRef', 'byteLength', 'role'], `artifact manifest artifacts[${index}]`);
    validateBinding({ artifactDigest: row.artifactDigest, artifactRef: row.artifactRef }, `artifact manifest artifacts[${index}]`);
    const file = resolveSourceTreeRef(row.artifactRef, `artifact manifest artifacts[${index}].artifactRef`);
    invariant(fs.readFileSync(file).length === row.byteLength, 'MR_EVIDENCE_MANIFEST', `manifest ${row.role} byteLength drifted`);
    invariant(priorRole === null || compareUtf8(priorRole, row.role) < 0, 'MR_EVIDENCE_MANIFEST', 'manifest artifacts are not role-sorted');
    priorRole = row.role;
  }
  const withoutDigest = structuredClone(manifest);
  delete withoutDigest.manifestDigest;
  invariant(
    manifest.manifestDigest === taggedJcsDigest(TAGS.manifest, withoutDigest),
    'MR_EVIDENCE_MANIFEST',
    'manifestDigest drifted',
  );
  invariant(
    canonicalJcs(manifest) === canonicalJcs(expected),
    'MR_EVIDENCE_RECOMPUTE',
    'artifact manifest differs from actual byte closure',
  );
}

function expectReject(expectedCode, operation, label) {
  let caught = null;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  invariant(
    caught instanceof MarketRulesReleaseEvidenceError && caught.code === expectedCode,
    'MR_EVIDENCE_TAMPER_TEST',
    `${label} expected ${expectedCode}; found ${caught?.code || 'acceptance'}`,
  );
  return { caseId: label, rejectionCode: expectedCode, status: 'passed' };
}

function runTamperAudit(expected) {
  const baseline = expected.ledgers.requestScopeCustom;
  const checks = [];
  checks.push(expectReject('MR_EVIDENCE_SCHEMA', () => {
    const candidate = structuredClone(baseline);
    candidate.unexpected = true;
    verifyLedgerCandidate(candidate, baseline, expected.schema);
  }, 'unknown-field-rejected'));
  checks.push(expectReject('MR_EVIDENCE_DIGEST', () => {
    const candidate = structuredClone(baseline);
    candidate.results.scenarioValidation.violationCount = 1;
    verifyLedgerCandidate(candidate, baseline, expected.schema);
  }, 'result-tamper-breaks-evidence-digest'));
  checks.push(expectReject('MR_EVIDENCE_RECOMPUTE', () => {
    const candidate = structuredClone(baseline);
    candidate.results.scenarioValidation.violationCount = 1;
    candidate.evidenceDigest = ledgerEvidenceDigest(candidate);
    verifyLedgerCandidate(candidate, baseline, expected.schema);
  }, 'digest-rewrite-cannot-forge-replay'));
  checks.push(expectReject('MR_EVIDENCE_JSON', () => {
    parseStrictJcsBytes(Buffer.from('{"a":1,"a":2}\n', 'utf8'), 'duplicate-member-control');
  }, 'duplicate-member-rejected'));
  checks.push(expectReject('MR_EVIDENCE_JCS', () => {
    parseStrictJcsBytes(Buffer.from('{ "a": 1 }\n', 'utf8'), 'non-jcs-control');
  }, 'non-jcs-bytes-rejected'));
  return checks;
}

function verifyAllMarketRulesReleaseEvidence() {
  const expected = buildAllMarketRulesReleaseEvidence();
  const schema = readStrictJcs(FILES.schemaManifest);
  validateSchemaManifest(schema);
  invariant(
    canonicalJcs(schema) === canonicalJcs(expected.schema),
    'MR_EVIDENCE_RECOMPUTE',
    'stored schema manifest differs from the executable closed schema',
  );
  const closure = readStrictJcs(FILES.implementationClosure);
  validateImplementationClosure(closure);
  invariant(
    canonicalJcs(closure) === canonicalJcs(expected.implementationClosure),
    'MR_EVIDENCE_RECOMPUTE',
    'stored implementation closure differs from actual runtime bytes',
  );
  for (const [kind, file] of Object.entries(LEDGER_FILES)) {
    const actual = readStrictJcs(file);
    verifyLedgerCandidate(actual, expected.ledgers[kind], schema);
  }
  const manifest = readStrictJcs(FILES.artifactManifest);
  validateArtifactManifest(manifest, expected.artifactManifest);
  const tamperChecks = runTamperAudit(expected);
  return {
    checks: [
      { id: 'REQUEST_SCOPE_CUSTOM', status: 'passed' },
      { id: 'RESOLVER_RUN', status: 'passed' },
      { id: 'FACT_GENERATION_RUN', status: 'passed' },
      { id: 'CANONICAL_EXTERNAL_FACT_IDENTITY', status: 'passed' },
      { id: 'PRECEDENCE_PRIORITY_AUTHORITY', status: 'passed' },
      { id: 'SYNTHETIC_NON_AUTHORITY_BOUNDARY', status: 'passed' },
    ],
    classification: structuredClone(CLASSIFICATION),
    ledgerCount: Object.keys(LEDGER_FILES).length,
    manifestDigest: manifest.manifestDigest,
    tamperChecks,
  };
}

function writeAllMarketRulesReleaseEvidence() {
  const built = buildAllMarketRulesReleaseEvidence();
  fs.mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  const writes = [
    [FILES.schemaManifest, built.schema],
    [FILES.implementationClosure, built.implementationClosure],
    ...Object.entries(LEDGER_FILES).map(([kind, file]) => [file, built.ledgers[kind]]),
    [FILES.artifactManifest, built.artifactManifest],
  ];
  for (const [file, value] of writes) fs.writeFileSync(file, jcsFileBytes(value));
  return built;
}

module.exports = {
  CLASSIFICATION,
  FILES,
  LEDGER_FILES,
  MarketRulesReleaseEvidenceError,
  buildAllMarketRulesReleaseEvidence,
  buildArtifactManifest,
  buildImplementationClosure,
  buildSchemaManifest,
  parseStrictJcsBytes,
  readStrictJcs,
  runTamperAudit,
  verifyAllMarketRulesReleaseEvidence,
  verifyLedgerCandidate,
  writeAllMarketRulesReleaseEvidence,
};
