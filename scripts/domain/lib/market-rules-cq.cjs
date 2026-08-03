'use strict';

const crypto = require('node:crypto');
const {
  canonicalJcs,
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');
const {
  buildIdentityIris,
} = require('./identity-contract-compiler.cjs');
const {
  buildFactClosureAssertionIri,
  canonicalUtcInstantLexical,
} = require('./fact-closure-identity.cjs');
const {
  parseUtcInstantNanoseconds,
} = require('./instant-lexical.cjs');

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const INSTANT_INFINITY = 253402300800000000000n;
const SCOPE_ORDER = ['listing', 'instrument', 'segment', 'venue', 'accountType', 'jurisdiction'];
const FOUNDATION_ACCOUNT_TYPE_BASE =
  'https://axiolune.ai/ontology/finance/foundation/AccountType/value/';
const FOUNDATION_ACCOUNT_TYPES = new Set([
  `${FOUNDATION_ACCOUNT_TYPE_BASE}cash`,
  `${FOUNDATION_ACCOUNT_TYPE_BASE}securitiesCustody`,
  `${FOUNDATION_ACCOUNT_TYPE_BASE}multiAsset`,
]);
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RULE_CONFLICT_KIND = 'https://axiolune.ai/ontology/finance/market-rules/RuleConflictKind/value/';
const REQUEST_IDENTITY_CONTRACT = {
  identityBaseIri: 'https://axiolune.ai/data/rule-evaluation-request',
  logicalComponents: [{ name: 'requestAuthority' }, { name: 'ruleEvaluationRequestId' }],
  versionComponents: [
    { name: 'validFrom' },
    { name: 'knowledgeFrom' },
    { name: 'availableFrom' },
    { name: 'revision' },
  ],
};
const CONFLICT_IDENTITY_CONTRACT = {
  identityBaseIri: 'https://axiolune.ai/data/rule-conflict',
  logicalComponents: [
    { name: 'evaluationRequest' },
    { name: 'candidateApplicabilitySetDigest' },
  ],
  versionComponents: REQUEST_IDENTITY_CONTRACT.versionComponents,
};

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

class MarketRulesCqError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarketRulesCqError';
    this.code = code;
  }
}

function issue(violations, code, path, message) {
  violations.push({ code, path, message });
}

function absoluteIri(value) {
  if (typeof value !== 'string'
      || /[\s\u0000-\u001f\u007f]/u.test(value)
      || value !== value.normalize('NFC')) return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol) && parsed.href === value;
  } catch {
    return false;
  }
}

function foundationAccountType(value) {
  return FOUNDATION_ACCOUNT_TYPES.has(value);
}

function parseInstant(value) {
  try {
    return parseUtcInstantNanoseconds(value);
  } catch {
    return null;
  }
}

function validParsedInstant(value) {
  return typeof value === 'bigint';
}

function validateAxes(value, path, prefix, violations) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issue(violations, `${prefix}_TEMPORAL`, path, 'axes must be an object');
    return;
  }
  const allowed = new Set(['validFrom', 'validTo', 'knowledgeFrom', 'availableFrom', 'revision']);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    issue(
      violations,
      Object.hasOwn(value, 'knowledgeTo') || Object.hasOwn(value, 'availableTo')
        ? 'RULE_INLINE_CLOSURE'
        : `${prefix}_TEMPORAL`,
      path,
      'only validTo may be stored inline; knowledge/availability ends require closure evidence',
    );
    return;
  }
  const validFrom = parseInstant(value.validFrom);
  const knowledgeFrom = parseInstant(value.knowledgeFrom);
  const availableFrom = parseInstant(value.availableFrom);
  if (![validFrom, knowledgeFrom, availableFrom].every(validParsedInstant)
      || !Number.isSafeInteger(value.revision)
      || value.revision < 0) {
    issue(violations, `${prefix}_TEMPORAL`, path, 'required axes/revision are invalid');
    return;
  }
  if (value.validTo != null) {
    const validTo = parseInstant(value.validTo);
    if (!validParsedInstant(validTo) || validFrom >= validTo) {
      issue(violations, `${prefix}_TEMPORAL`, path, 'valid interval must be half-open and increasing');
    }
  }
}

function scopeMapsOverlap(left, right) {
  return Object.keys(left).every((key) => (
    !Object.hasOwn(right, key) || right[key] === left[key]
  ));
}

function hasDirectedCycle(edges) {
  const adjacency = new Map();
  const indegree = new Map();
  for (const edge of edges) {
    const children = adjacency.get(edge.higherRuleVersionIri) || [];
    children.push(edge.lowerRuleVersionIri);
    adjacency.set(edge.higherRuleVersionIri, children);
    if (!indegree.has(edge.higherRuleVersionIri)) indegree.set(edge.higherRuleVersionIri, 0);
    indegree.set(edge.lowerRuleVersionIri, (indegree.get(edge.lowerRuleVersionIri) || 0) + 1);
  }
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([versionIri]) => versionIri);
  let removed = 0;
  while (ready.length > 0) {
    const versionIri = ready.pop();
    removed += 1;
    for (const child of adjacency.get(versionIri) || []) {
      const next = indegree.get(child) - 1;
      indegree.set(child, next);
      if (next === 0) ready.push(child);
    }
  }
  return removed !== indegree.size;
}

function closureKey(targetVersionIri, axis) {
  return `${targetVersionIri}\0${axis}`;
}

function buildClosureIndex(scenario, referenceInstant = INSTANT_INFINITY) {
  const runCompletedAt = new Map((scenario.runRecords || []).map((run) => [
    run.runRef,
    parseInstant(run.completedAt),
  ]));
  return new Map((scenario.closures || [])
    .filter((closure) => {
      const completedAt = runCompletedAt.get(closure.generatingContextRef);
      return validParsedInstant(completedAt) && completedAt <= referenceInstant;
    })
    .map((closure) => [
      closureKey(closure.targetVersionIri, closure.axis),
      closure,
    ]));
}

function buildScopeVersionIndex(scenario) {
  return new Map((scenario.scopeVersions || []).map((row) => [row.versionIri, row]));
}

function iriTerm(value) {
  return `<${value}>`;
}

function typedLiteral(value, datatype) {
  return `${JSON.stringify(String(value))}^^<${XSD}${datatype}>`;
}

function identityVersionTerms(axes) {
  return {
    validFrom: typedLiteral(canonicalUtcInstantLexical(axes.validFrom), 'dateTimeStamp'),
    knowledgeFrom: typedLiteral(canonicalUtcInstantLexical(axes.knowledgeFrom), 'dateTimeStamp'),
    availableFrom: typedLiteral(canonicalUtcInstantLexical(axes.availableFrom), 'dateTimeStamp'),
    revision: typedLiteral(axes.revision, 'nonNegativeInteger'),
  };
}

function buildRuleEvaluationRequestIdentity(request, authorityLogicalIri) {
  return buildIdentityIris(
    REQUEST_IDENTITY_CONTRACT,
    {
      requestAuthority: iriTerm(authorityLogicalIri),
      ruleEvaluationRequestId: typedLiteral(request.requestId, 'string'),
    },
    identityVersionTerms(request.axes),
  );
}

function buildRuleConflictIdentity(conflict, requestLogicalIri) {
  return buildIdentityIris(
    CONFLICT_IDENTITY_CONTRACT,
    {
      evaluationRequest: iriTerm(requestLogicalIri),
      candidateApplicabilitySetDigest: typedLiteral(
        conflict.candidateApplicabilitySetDigest,
        'string',
      ),
    },
    identityVersionTerms(conflict.axes),
  );
}

function buildClosureAssertionIri(closure) {
  return buildFactClosureAssertionIri(closure);
}

function expandScopeClosure(scopes, scopeVersionIndex) {
  const normalized = {};
  const dependencies = new Map();
  const conflicts = [];
  function bind(kind, row, origin) {
    if (!row) return;
    dependencies.set(row.versionIri, row);
    if (Object.hasOwn(normalized, kind) && normalized[kind] !== row.logicalIri) {
      conflicts.push({ kind, origin, expected: normalized[kind], actual: row.logicalIri });
      return;
    }
    normalized[kind] = row.logicalIri;
  }
  for (const [kind, versionIri] of Object.entries(scopes || {})) {
    if (kind === 'accountType') {
      if (Object.hasOwn(normalized, kind) && normalized[kind] !== versionIri) {
        conflicts.push({ kind, origin: 'accountType', expected: normalized[kind], actual: versionIri });
      }
      normalized[kind] = versionIri;
      continue;
    }
    const row = scopeVersionIndex.get(versionIri);
    bind(kind, row, kind);
    if (kind === 'listing' && row) {
      bind(
        'instrument',
        scopeVersionIndex.get(row.listedInstrumentVersionIri),
        'listing.listedInstrument',
      );
      const facility = scopeVersionIndex.get(row.listingFacilityVersionIri);
      if (facility) {
        bind(facility.kind, facility, 'listing.listingFacility');
        if (facility.kind === 'segment') {
          bind(
            'venue',
            scopeVersionIndex.get(facility.marketSegmentVenueVersionIri),
            'listing.listingFacility.marketSegmentVenue',
          );
        }
      }
    } else if (kind === 'segment' && row) {
      bind(
        'venue',
        scopeVersionIndex.get(row.marketSegmentVenueVersionIri),
        'segment.marketSegmentVenue',
      );
    }
  }
  return { normalized, dependencies: [...dependencies.values()], conflicts };
}

function normalizedScopes(scopes, scopeVersionIndex) {
  return expandScopeClosure(scopes, scopeVersionIndex).normalized;
}

function validateProvenance(value, path, prefix, violations) {
  const allowed = new Set([
    'source', 'sourceVersion', 'sourceArtifactRef', 'sourceArtifactDigest', 'sourceLocator',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((field) => !allowed.has(field))
      || !absoluteIri(value.source)
      || typeof value.sourceVersion !== 'string'
      || value.sourceVersion.trim() === ''
      || !validateArtifactRef(value.sourceArtifactRef).ok
      || !DIGEST.test(value.sourceArtifactDigest || '')
      || !validateSourceLocator(value.sourceLocator).ok) {
    issue(violations, `${prefix}_PROVENANCE`, path, 'provenance/source artifact/locator closure is invalid');
  }
}

function validateMarketRulesScenario(scenario) {
  const violations = [];
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    return [{ code: 'RULE_SCENARIO_ROOT', path: '$', message: 'scenario must be an object' }];
  }
  if (scenario.schemaVersion !== 1) {
    issue(violations, 'RULE_SCENARIO_VERSION', '$.schemaVersion', 'expected 1.0');
  }
  for (const field of [
    'rules', 'clauses', 'applicabilities', 'precedence', 'closures', 'scopeVersions',
    'evidenceRecords', 'requestAuthorityVersions', 'contextRecords', 'evaluationRequests',
    'ruleConflicts', 'runRecords',
  ]) {
    if (!Array.isArray(scenario[field])) issue(violations, 'RULE_SCENARIO_ARRAY', `$.${field}`, 'expected array');
  }
  if (violations.length > 0) return violations;
  if (!absoluteIri(scenario.graphRef)) {
    issue(violations, 'RULE_SCENARIO_GRAPH', '$.graphRef', 'one absolute output graph IRI is required');
  }

  const scopeVersionIndex = new Map();
  for (let index = 0; index < scenario.scopeVersions.length; index += 1) {
    const row = scenario.scopeVersions[index];
    const at = `$.scopeVersions[${index}]`;
    const allowed = new Set([
      'versionIri', 'logicalIri', 'versionOf', 'kind', 'listedInstrumentVersionIri',
      'listingFacilityVersionIri', 'marketSegmentVenueVersionIri', 'supersedes',
      'axes', 'provenance',
    ]);
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some((field) => !allowed.has(field))
        || !absoluteIri(row.versionIri)
        || !absoluteIri(row.logicalIri)
        || row.versionOf !== row.logicalIri
        || !['listing', 'instrument', 'segment', 'venue', 'jurisdiction'].includes(row.kind)) {
      issue(violations, 'RULE_SCOPE_VERSION_INTEGRITY', at, 'scope-version identity row is invalid or open-schema');
      continue;
    }
    if (scopeVersionIndex.has(row.versionIri)) {
      issue(violations, 'RULE_SCOPE_VERSION_DUPLICATE', at, 'scope version resolves more than once');
    } else {
      scopeVersionIndex.set(row.versionIri, row);
    }
    validateAxes(row?.axes, `${at}.axes`, 'RULE_SCOPE_VERSION', violations);
    validateProvenance(row?.provenance, `${at}.provenance`, 'RULE_SCOPE_VERSION', violations);
  }
  for (let index = 0; index < scenario.scopeVersions.length; index += 1) {
    const row = scenario.scopeVersions[index];
    const at = `$.scopeVersions[${index}]`;
    if (!row || typeof row !== 'object' || !scopeVersionIndex.has(row.versionIri)) continue;
    const relationFields = [
      'listedInstrumentVersionIri', 'listingFacilityVersionIri', 'marketSegmentVenueVersionIri',
    ].filter((field) => row[field] !== undefined);
    if (row.kind === 'listing') {
      const instrument = scopeVersionIndex.get(row.listedInstrumentVersionIri);
      const facility = scopeVersionIndex.get(row.listingFacilityVersionIri);
      if (relationFields.length !== 2
          || !instrument
          || instrument.kind !== 'instrument'
          || !facility
          || !['segment', 'venue'].includes(facility.kind)) {
        issue(
          violations,
          'RULE_SCOPE_RELATION_TARGET',
          at,
          'listing must resolve exactly one listedInstrument and TradingFacility version',
        );
      }
    } else if (row.kind === 'segment') {
      const venue = scopeVersionIndex.get(row.marketSegmentVenueVersionIri);
      if (relationFields.length !== 1 || !venue || venue.kind !== 'venue') {
        issue(
          violations,
          'RULE_SCOPE_RELATION_TARGET',
          at,
          'segment must resolve exactly one marketSegmentVenue version',
        );
      }
    } else if (relationFields.length !== 0) {
      issue(
        violations,
        'RULE_SCOPE_RELATION_FORBIDDEN',
        at,
        'only listing and segment scope versions may carry normalization relations',
      );
    }
  }
  const evidenceIndex = new Map();
  for (let index = 0; index < scenario.evidenceRecords.length; index += 1) {
    const row = scenario.evidenceRecords[index];
    const at = `$.evidenceRecords[${index}]`;
    const allowed = new Set(['evidenceRef', 'artifactRef', 'artifactDigest', 'sourceLocator']);
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some((field) => !allowed.has(field))
        || !absoluteIri(row.evidenceRef)
        || !validateArtifactRef(row.artifactRef).ok
        || !DIGEST.test(row.artifactDigest || '')
        || !validateSourceLocator(row.sourceLocator).ok) {
      issue(violations, 'RULE_EVIDENCE_RECORD_INTEGRITY', at, 'locked evidence record is invalid or open-schema');
      continue;
    }
    if (evidenceIndex.has(row.evidenceRef)) {
      issue(violations, 'RULE_EVIDENCE_RECORD_DUPLICATE', at, 'evidenceRef resolves more than once');
    } else {
      evidenceIndex.set(row.evidenceRef, row);
    }
  }

  const requestAuthorityIndex = new Map();
  for (let index = 0; index < scenario.requestAuthorityVersions.length; index += 1) {
    const row = scenario.requestAuthorityVersions[index];
    const at = `$.requestAuthorityVersions[${index}]`;
    const allowed = new Set([
      'logicalIri', 'versionIri', 'versionOf', 'supersedes', 'axes', 'provenance',
    ]);
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some((field) => !allowed.has(field))
        || !absoluteIri(row.logicalIri)
        || !absoluteIri(row.versionIri)
        || row.versionOf !== row.logicalIri) {
      issue(
        violations,
        'RULE_REQUEST_AUTHORITY_INTEGRITY',
        at,
        'request authority exact-version record is invalid or open-schema',
      );
      continue;
    }
    if (requestAuthorityIndex.has(row.versionIri)) {
      issue(violations, 'RULE_REQUEST_AUTHORITY_DUPLICATE', at, 'request authority version resolves more than once');
    } else {
      requestAuthorityIndex.set(row.versionIri, row);
    }
    validateAxes(row.axes, `${at}.axes`, 'RULE_REQUEST_AUTHORITY', violations);
    validateProvenance(row.provenance, `${at}.provenance`, 'RULE_REQUEST_AUTHORITY', violations);
  }

  const contextIndex = new Map();
  for (let index = 0; index < scenario.contextRecords.length; index += 1) {
    const row = scenario.contextRecords[index];
    const at = `$.contextRecords[${index}]`;
    const allowed = new Set(['contextRef', 'recordDigest', 'status', 'completedAt']);
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some((field) => !allowed.has(field))
        || !absoluteIri(row.contextRef)
        || !DIGEST.test(row.recordDigest || '')
        || row.status !== 'completed'
        || !validParsedInstant(parseInstant(row.completedAt))) {
      issue(
        violations,
        'RULE_REQUEST_CONTEXT_INTEGRITY',
        at,
        'input context must be one completed digest-bound record',
      );
      continue;
    }
    if (contextIndex.has(row.contextRef)) {
      issue(violations, 'RULE_REQUEST_CONTEXT_DUPLICATE', at, 'input context ref resolves more than once');
    } else {
      contextIndex.set(row.contextRef, row);
    }
  }

  const runRecordIndex = new Map();
  const runArtifactBindings = new Map();
  function registerRunArtifact(artifactRef, artifactDigest, locator, at) {
    const key = canonicalJcs(artifactRef);
    const binding = canonicalJcs({ artifactDigest, locator });
    if (runArtifactBindings.has(key) && runArtifactBindings.get(key) !== binding) {
      issue(
        violations,
        'RULE_RUN_ARTIFACT_COLLISION',
        at,
        'one ArtifactRef cannot resolve to conflicting digest/locator bytes',
      );
    } else {
      runArtifactBindings.set(key, binding);
    }
  }
  for (let index = 0; index < scenario.runRecords.length; index += 1) {
    const row = scenario.runRecords[index];
    const at = `$.runRecords[${index}]`;
    const allowed = new Set([
      'runRef', 'recordArtifactRef', 'recordDigest', 'recordLocator', 'status',
      'completedAt', 'outputGraphRef', 'implementationArtifactRef',
      'implementationArtifactDigest', 'implementationLocator',
    ]);
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some((field) => !allowed.has(field))
        || !absoluteIri(row.runRef)
        || !validateArtifactRef(row.recordArtifactRef).ok
        || !DIGEST.test(row.recordDigest || '')
        || !validateSourceLocator(row.recordLocator).ok
        || row.status !== 'completed'
        || !validParsedInstant(parseInstant(row.completedAt))
        || row.outputGraphRef !== scenario.graphRef
        || !validateArtifactRef(row.implementationArtifactRef).ok
        || !DIGEST.test(row.implementationArtifactDigest || '')
        || !validateSourceLocator(row.implementationLocator).ok) {
      issue(
        violations,
        'RULE_RUN_RECORD_INTEGRITY',
        at,
        'resolver Run must be one completed, output-bound, artifact-locked record',
      );
      continue;
    }
    if (runRecordIndex.has(row.runRef)) {
      issue(violations, 'RULE_RUN_RECORD_DUPLICATE', at, 'resolver Run IRI resolves more than once');
    } else {
      runRecordIndex.set(row.runRef, row);
    }
    registerRunArtifact(row.recordArtifactRef, row.recordDigest, row.recordLocator, `${at}.recordArtifactRef`);
    registerRunArtifact(
      row.implementationArtifactRef,
      row.implementationArtifactDigest,
      row.implementationLocator,
      `${at}.implementationArtifactRef`,
    );
  }

  const evaluationRequestIndex = new Map();
  const requestKeyToLogical = new Map();
  const requestLogicalToKey = new Map();
  for (let index = 0; index < scenario.evaluationRequests.length; index += 1) {
    const request = scenario.evaluationRequests[index];
    const at = `$.evaluationRequests[${index}]`;
    const allowed = new Set([
      'logicalIri', 'versionIri', 'versionOf', 'supersedes', 'requestAuthorityVersionIri', 'requestId',
      'scopes', 'asOfValid', 'asOfKnowledge', 'asOfAvailable', 'inputContextRef',
      'inputContextRecordDigest', 'axes', 'provenance',
    ]);
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some((field) => !allowed.has(field))
        || !absoluteIri(request.logicalIri)
        || !absoluteIri(request.versionIri)
        || request.versionOf !== request.logicalIri
        || !absoluteIri(request.requestAuthorityVersionIri)
        || typeof request.requestId !== 'string'
        || request.requestId.trim() === ''
        || request.requestId !== request.requestId.trim()
        || request.requestId !== request.requestId.normalize('NFC')
        || !request.scopes
        || typeof request.scopes !== 'object'
        || Array.isArray(request.scopes)) {
      issue(
        violations,
        'RULE_EVALUATION_REQUEST_INTEGRITY',
        at,
        'RuleEvaluationRequest record is invalid or open-schema',
      );
      continue;
    }
    const authority = requestAuthorityIndex.get(request.requestAuthorityVersionIri);
    if (!authority) {
      issue(
        violations,
        'RULE_EVALUATION_REQUEST_AUTHORITY',
        at,
        'requestAuthorityVersionIri must resolve to one exact Party version',
      );
    }
    const scopeKeys = Object.keys(request.scopes);
    if (scopeKeys.length === 0
        || scopeKeys.some((key) => !SCOPE_ORDER.includes(key)
          || !absoluteIri(request.scopes[key]))) {
      issue(
        violations,
        'RULE_EVALUATION_REQUEST_SCOPE',
        `${at}.scopes`,
        'request must bind at least one supported exact scope',
      );
    } else {
      for (const key of scopeKeys) {
        if (key === 'accountType') {
          if (!foundationAccountType(request.scopes[key])) {
            issue(
              violations,
              'RULE_EVALUATION_REQUEST_SCOPE',
              `${at}.scopes.${key}`,
              'accountType must be a canonical member of the closed Foundation AccountType code list',
            );
          }
          continue;
        }
        const resolved = scopeVersionIndex.get(request.scopes[key]);
        if (!resolved || resolved.kind !== key) {
          issue(
            violations,
            'RULE_EVALUATION_REQUEST_SCOPE',
            `${at}.scopes.${key}`,
            'request scope must resolve to one same-kind exact version',
          );
        }
      }
      const closure = expandScopeClosure(request.scopes, scopeVersionIndex);
      if (closure.conflicts.length > 0) {
        issue(
          violations,
          'RULE_EVALUATION_REQUEST_SCOPE_INCONSISTENT',
          `${at}.scopes`,
          'explicit request scopes contradict listing/segment relation closure',
        );
      }
    }
    const pivots = [request.asOfValid, request.asOfKnowledge, request.asOfAvailable]
      .map(parseInstant);
    if (!pivots.every(validParsedInstant)) {
      issue(
        violations,
        'RULE_EVALUATION_REQUEST_PIVOT',
        at,
        'request must bind three canonical UTC PIT pivots',
      );
    }
    const context = contextIndex.get(request.inputContextRef);
    if (!context || context.recordDigest !== request.inputContextRecordDigest) {
      issue(
        violations,
        'RULE_EVALUATION_REQUEST_CONTEXT',
        at,
        'input context ref/digest must resolve exactly once',
      );
    } else if (parseInstant(context.completedAt) >= parseInstant(request.axes?.knowledgeFrom)
        || parseInstant(context.completedAt) >= parseInstant(request.axes?.availableFrom)) {
      issue(
        violations,
        'RULE_EVALUATION_REQUEST_CONTEXT_ORDER',
        at,
        'completed input context must be strictly prior to request knowledge/availability',
      );
    }
    validateAxes(request.axes, `${at}.axes`, 'RULE_EVALUATION_REQUEST', violations);
    validateProvenance(
      request.provenance,
      `${at}.provenance`,
      'RULE_EVALUATION_REQUEST',
      violations,
    );
    if (authority
        && validParsedInstant(parseInstant(request.axes?.validFrom))
        && validParsedInstant(parseInstant(request.axes?.knowledgeFrom))
        && validParsedInstant(parseInstant(request.axes?.availableFrom))
        && Number.isSafeInteger(request.axes?.revision)) {
      try {
        const identity = buildRuleEvaluationRequestIdentity(request, authority.logicalIri);
        if (request.logicalIri !== identity.logicalIri || request.versionIri !== identity.versionIri) {
          issue(
            violations,
            'RULE_EVALUATION_REQUEST_IDENTITY',
            at,
            'request logical/version IRI does not match the RFC 5.8 identity frame',
          );
        }
      } catch {
        issue(
          violations,
          'RULE_EVALUATION_REQUEST_IDENTITY',
          at,
          'request identity terms cannot be canonically framed',
        );
      }
      const key = `${authority.logicalIri}\0${request.requestId}`;
      if ((requestKeyToLogical.has(key) && requestKeyToLogical.get(key) !== request.logicalIri)
          || (requestLogicalToKey.has(request.logicalIri)
            && requestLogicalToKey.get(request.logicalIri) !== key)) {
        issue(
          violations,
          'RULE_EVALUATION_REQUEST_IDENTITY_COLLISION',
          at,
          'request logical identity is not bijective with authority/request ID',
        );
      }
      requestKeyToLogical.set(key, request.logicalIri);
      requestLogicalToKey.set(request.logicalIri, key);
    }
    if (evaluationRequestIndex.has(request.versionIri)) {
      issue(violations, 'RULE_EVALUATION_REQUEST_DUPLICATE', at, 'request version resolves more than once');
    } else {
      evaluationRequestIndex.set(request.versionIri, request);
    }
  }

  const rules = new Map();
  for (let index = 0; index < scenario.rules.length; index += 1) {
    const rule = scenario.rules[index];
    const at = `$.rules[${index}]`;
    const allowed = new Set([
      'logicalIri', 'versionIri', 'versionOf', 'ruleSetVersionIri', 'authorityLogicalIri',
      'ruleId', 'kind', 'gapPolicy', 'supersedes', 'axes', 'provenance',
    ]);
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
        || Object.keys(rule).some((field) => !allowed.has(field))
        || !absoluteIri(rule.logicalIri)
        || !absoluteIri(rule.versionIri)
        || rule.versionOf !== rule.logicalIri
        || !absoluteIri(rule.ruleSetVersionIri)
        || !absoluteIri(rule.authorityLogicalIri)
        || typeof rule.ruleId !== 'string'
        || rule.ruleId.trim() === ''
        || !['settlementCycle', 'priceLimit'].includes(rule.kind)
        || !['reject', 'allow'].includes(rule.gapPolicy)) {
      issue(violations, 'RULE_INTEGRITY', at, 'MarketRule record is invalid or open-schema');
      continue;
    }
    if (rules.has(rule.versionIri)) issue(violations, 'RULE_DUPLICATE_VERSION', at, 'duplicate rule version');
    rules.set(rule.versionIri, rule);
    validateAxes(rule.axes, `${at}.axes`, 'RULE', violations);
    validateProvenance(rule.provenance, `${at}.provenance`, 'RULE', violations);
  }

  const clausesByRule = new Map();
  const clauseVersions = new Set();
  for (let index = 0; index < scenario.clauses.length; index += 1) {
    const clause = scenario.clauses[index];
    const at = `$.clauses[${index}]`;
    const common = [
      'logicalIri', 'versionIri', 'versionOf', 'ruleVersionIri', 'clauseId', 'sequence',
      'type', 'supersedes', 'axes', 'provenance',
    ];
    const branch = clause?.type === 'SettlementCycleClause'
      ? ['settlementCycle']
      : clause?.type === 'PriceLimitClause'
        ? ['priceLimitPercentage', 'priceLimitAmount']
        : [];
    const allowed = new Set([...common, ...branch]);
    if (!clause || typeof clause !== 'object' || Array.isArray(clause)
        || Object.keys(clause).some((field) => !allowed.has(field))
        || !absoluteIri(clause.logicalIri)
        || !absoluteIri(clause.versionIri)
        || clause.versionOf !== clause.logicalIri
        || !absoluteIri(clause.ruleVersionIri)
        || typeof clause.clauseId !== 'string'
        || clause.clauseId.trim() === ''
        || !Number.isSafeInteger(clause.sequence)
        || clause.sequence < 0
        || !['SettlementCycleClause', 'PriceLimitClause'].includes(clause.type)) {
      issue(violations, 'RULE_CLAUSE_INTEGRITY', at, 'RuleClause record is invalid or open-schema');
      continue;
    }
    if (clauseVersions.has(clause.versionIri)) issue(violations, 'RULE_CLAUSE_DUPLICATE', at, 'duplicate clause version');
    clauseVersions.add(clause.versionIri);
    const rule = rules.get(clause.ruleVersionIri);
    if (!rule) {
      issue(violations, 'RULE_CLAUSE_ORPHAN', at, 'clause does not join one rule version');
    } else if ((rule.kind === 'settlementCycle') !== (clause.type === 'SettlementCycleClause')) {
      issue(violations, 'RULE_CLAUSE_KIND', at, 'clause subtype is incompatible with rule kind');
    }
    if (clause.type === 'SettlementCycleClause') {
      if (!clause.settlementCycle
          || typeof clause.settlementCycle !== 'object'
          || Array.isArray(clause.settlementCycle)
          || Object.keys(clause.settlementCycle).some((field) => !['value', 'unit'].includes(field))
          || !Number.isSafeInteger(clause.settlementCycle.value)
          || clause.settlementCycle.value < 0
          || clause.settlementCycle.unit !== 'urn:unit:business-day') {
        issue(violations, 'RULE_SETTLEMENT_VALUE', at, 'settlement cycle must be a non-negative business-day quantity');
      }
    } else {
      const branches = ['priceLimitPercentage', 'priceLimitAmount']
        .filter((field) => clause[field] !== undefined);
      if (branches.length !== 1) {
        issue(violations, 'RULE_PRICE_LIMIT_XONE', at, 'price limit needs exactly one typed boundary');
      } else if (branches[0] === 'priceLimitPercentage') {
        const value = clause.priceLimitPercentage;
        if (!value
            || typeof value !== 'object'
            || Array.isArray(value)
            || Object.keys(value).some((field) => !['value', 'unit'].includes(field))
            || !DECIMAL.test(value.value || '')
            || value.unit !== 'urn:unit:dimensionless') {
          issue(violations, 'RULE_PRICE_LIMIT_VALUE', at, 'percentage boundary is invalid');
        }
      } else {
        const value = clause.priceLimitAmount;
        if (!value
            || typeof value !== 'object'
            || Array.isArray(value)
            || Object.keys(value).some((field) => !['amount', 'currency', 'scale'].includes(field))
            || !DECIMAL.test(value.amount || '')
            || !/^[A-Z]{3}$/u.test(value.currency || '')
            || !Number.isSafeInteger(value.scale)
            || value.scale < 0
            || (String(value.amount).split('.')[1] || '').length > value.scale) {
          issue(violations, 'RULE_PRICE_LIMIT_VALUE', at, 'money boundary is invalid');
        }
      }
    }
    validateAxes(clause.axes, `${at}.axes`, 'RULE_CLAUSE', violations);
    validateProvenance(clause.provenance, `${at}.provenance`, 'RULE_CLAUSE', violations);
    const rows = clausesByRule.get(clause.ruleVersionIri) || [];
    rows.push(clause);
    clausesByRule.set(clause.ruleVersionIri, rows);
  }
  for (const [versionIri] of rules) {
    const clauses = clausesByRule.get(versionIri) || [];
    if (clauses.length === 0) issue(violations, 'RULE_WITHOUT_CLAUSE', versionIri, 'rule has no executable clause');
    const sequences = clauses.map((clause) => clause.sequence);
    if (new Set(sequences).size !== sequences.length) {
      issue(violations, 'RULE_CLAUSE_SEQUENCE', versionIri, 'clause sequences are not unique');
    }
  }

  const applicabilityVersions = new Set();
  const applicabilityIndex = new Map();
  for (let index = 0; index < scenario.applicabilities.length; index += 1) {
    const applicability = scenario.applicabilities[index];
    const at = `$.applicabilities[${index}]`;
    const allowed = new Set([
      'logicalIri', 'versionIri', 'versionOf', 'ruleVersionIri', 'ruleSetVersionIri', 'sourceLogicalIri',
      'priority', 'scopes', 'supersedes', 'axes', 'provenance',
    ]);
    if (!applicability || typeof applicability !== 'object' || Array.isArray(applicability)
        || Object.keys(applicability).some((field) => !allowed.has(field))
        || !absoluteIri(applicability.logicalIri)
        || !absoluteIri(applicability.versionIri)
        || applicability.versionOf !== applicability.logicalIri
        || !absoluteIri(applicability.ruleVersionIri)
        || !absoluteIri(applicability.ruleSetVersionIri)
        || !absoluteIri(applicability.sourceLogicalIri)
        || !Number.isSafeInteger(applicability.priority)
        || !applicability.scopes
        || typeof applicability.scopes !== 'object'
        || Array.isArray(applicability.scopes)) {
      issue(violations, 'RULE_APPLICABILITY_INTEGRITY', at, 'RuleApplicability record is invalid or open-schema');
      continue;
    }
    const scopeKeys = Object.keys(applicability.scopes);
    if (scopeKeys.length === 0) {
      issue(violations, 'RULE_APPLICABILITY_EMPTY_SCOPE', `${at}.scopes`, 'absence never means global');
    } else if (scopeKeys.some((key) => !SCOPE_ORDER.includes(key)
        || !absoluteIri(applicability.scopes[key]))) {
      issue(violations, 'RULE_APPLICABILITY_SCOPE', `${at}.scopes`, 'scope key/value is invalid');
    } else {
      for (const key of scopeKeys) {
        if (key === 'accountType') {
          if (!foundationAccountType(applicability.scopes[key])) {
            issue(
              violations,
              'RULE_APPLICABILITY_SCOPE',
              `${at}.scopes.${key}`,
              'accountType must be a canonical member of the closed Foundation AccountType code list',
            );
          }
          continue;
        }
        const resolved = scopeVersionIndex.get(applicability.scopes[key]);
        if (!resolved || resolved.kind !== key) {
          issue(
            violations,
            'RULE_SCOPE_VERSION_UNRESOLVED',
            `${at}.scopes.${key}`,
            'exact scope version does not resolve to one same-kind logical anchor',
          );
        }
      }
      if (expandScopeClosure(applicability.scopes, scopeVersionIndex).conflicts.length > 0) {
        issue(
          violations,
          'RULE_APPLICABILITY_SCOPE_INCONSISTENT',
          `${at}.scopes`,
          'explicit applicability scopes contradict listing/segment relation closure',
        );
      }
    }
    const rule = rules.get(applicability.ruleVersionIri);
    if (!rule) {
      issue(violations, 'RULE_APPLICABILITY_ORPHAN', at, 'applicability does not join one rule');
    } else if (applicability.ruleSetVersionIri !== rule.ruleSetVersionIri) {
      issue(violations, 'RULE_APPLICABILITY_RULE_SET', at, 'applicability/rule rule-set versions differ');
    }
    if (applicabilityVersions.has(applicability.versionIri)) {
      issue(violations, 'RULE_APPLICABILITY_DUPLICATE', at, 'duplicate applicability version');
    }
    applicabilityVersions.add(applicability.versionIri);
    applicabilityIndex.set(applicability.versionIri, applicability);
    validateAxes(applicability.axes, `${at}.axes`, 'RULE_APPLICABILITY', violations);
    validateProvenance(applicability.provenance, `${at}.provenance`, 'RULE_APPLICABILITY', violations);
    if (applicability.sourceLogicalIri !== applicability.provenance?.source) {
      issue(
        violations,
        'RULE_APPLICABILITY_SOURCE',
        at,
        'priority-group authoritative source must equal ProvenancedFact source',
      );
    }
  }

  const ruleConflictIndex = new Map();
  const conflictLogicalKeys = new Map();
  for (let index = 0; index < scenario.ruleConflicts.length; index += 1) {
    const conflict = scenario.ruleConflicts[index];
    const at = `$.ruleConflicts[${index}]`;
    const allowed = new Set([
      'logicalIri', 'versionIri', 'versionOf', 'supersedes', 'evaluationRequestVersionIri',
      'candidateApplicabilityVersionIris', 'ruleConflictKind',
      'candidateApplicabilitySetDigest', 'generatingContextRef', 'axes', 'provenance',
    ]);
    if (!conflict || typeof conflict !== 'object' || Array.isArray(conflict)
        || Object.keys(conflict).some((field) => !allowed.has(field))
        || !absoluteIri(conflict.logicalIri)
        || !absoluteIri(conflict.versionIri)
        || conflict.versionOf !== conflict.logicalIri
        || !absoluteIri(conflict.evaluationRequestVersionIri)
        || !Array.isArray(conflict.candidateApplicabilityVersionIris)
        || ![
          `${RULE_CONFLICT_KIND}incompatibleResults`,
          `${RULE_CONFLICT_KIND}incomparableAuthorities`,
        ].includes(conflict.ruleConflictKind)
        || !DIGEST.test(conflict.candidateApplicabilitySetDigest || '')
        || !absoluteIri(conflict.generatingContextRef)) {
      issue(
        violations,
        'RULE_CONFLICT_INTEGRITY',
        at,
        'RuleConflict fact is invalid or open-schema',
      );
      continue;
    }
    const request = evaluationRequestIndex.get(conflict.evaluationRequestVersionIri);
    if (!request) {
      issue(
        violations,
        'RULE_CONFLICT_REQUEST',
        at,
        'evaluationRequestVersionIri must resolve to one exact request version',
      );
    }
    const runRecord = runRecordIndex.get(conflict.generatingContextRef);
    if (!runRecord) {
      issue(
        violations,
        'RULE_CONFLICT_RUN',
        at,
        'generatingContextRef must resolve to one completed detached resolver Run record',
      );
    } else if (conflict.provenance
        && (canonicalJcs(runRecord.implementationArtifactRef)
            !== canonicalJcs(conflict.provenance.sourceArtifactRef)
          || runRecord.implementationArtifactDigest
            !== conflict.provenance.sourceArtifactDigest
          || canonicalJcs(runRecord.implementationLocator)
            !== canonicalJcs(conflict.provenance.sourceLocator))) {
      issue(
        violations,
        'RULE_CONFLICT_RUN_PROVENANCE',
        at,
        'resolver Run implementation lock must equal conflict provenance evidence',
      );
    }
    const candidates = conflict.candidateApplicabilityVersionIris;
    const sortedCandidates = [...candidates].sort((left, right) => (
      Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
    ));
    if (candidates.length < 2
        || new Set(candidates).size !== candidates.length
        || candidates.some((candidate) => !applicabilityVersions.has(candidate))
        || candidates.some((candidate, candidateIndex) => candidate !== sortedCandidates[candidateIndex])) {
      issue(
        violations,
        'RULE_CONFLICT_CANDIDATES',
        at,
        'candidate roles must be a sorted unique set of at least two exact applicability versions',
      );
    }
    const candidateKinds = new Set(candidates.map((candidate) => {
      const applicability = applicabilityIndex.get(candidate);
      return rules.get(applicability?.ruleVersionIri)?.kind;
    }));
    if (candidateKinds.size !== 1 || candidateKinds.has(undefined)) {
      issue(
        violations,
        'RULE_CONFLICT_CANDIDATE_KIND',
        at,
        'all candidate applicability versions in one conflict must resolve to one rule kind',
      );
    }
    if (conflict.candidateApplicabilitySetDigest !== framedSetDigest(candidates)) {
      issue(
        violations,
        'RULE_CONFLICT_DIGEST',
        at,
        'candidateApplicabilitySetDigest does not recompute from the exact role set',
      );
    }
    validateAxes(conflict.axes, `${at}.axes`, 'RULE_CONFLICT', violations);
    validateProvenance(conflict.provenance, `${at}.provenance`, 'RULE_CONFLICT', violations);
    if (request
        && validParsedInstant(parseInstant(conflict.axes?.validFrom))
        && validParsedInstant(parseInstant(conflict.axes?.knowledgeFrom))
        && validParsedInstant(parseInstant(conflict.axes?.availableFrom))
        && Number.isSafeInteger(conflict.axes?.revision)) {
      try {
        const identity = buildRuleConflictIdentity(conflict, request.logicalIri);
        if (conflict.logicalIri !== identity.logicalIri || conflict.versionIri !== identity.versionIri) {
          issue(
            violations,
            'RULE_CONFLICT_IDENTITY',
            at,
            'conflict logical/version IRI does not match the RFC 5.8 identity frame',
          );
        }
      } catch {
        issue(
          violations,
          'RULE_CONFLICT_IDENTITY',
          at,
          'conflict identity terms cannot be canonically framed',
        );
      }
      const logicalKey = `${request.logicalIri}\0${conflict.candidateApplicabilitySetDigest}`;
      if (conflictLogicalKeys.has(logicalKey)
          && conflictLogicalKeys.get(logicalKey) !== conflict.logicalIri) {
        issue(
          violations,
          'RULE_CONFLICT_IDENTITY_COLLISION',
          at,
          'conflict logical key maps to more than one logical IRI',
        );
      }
      conflictLogicalKeys.set(logicalKey, conflict.logicalIri);
    }
    if (request
        && (parseInstant(conflict.axes?.knowledgeFrom) < parseInstant(request.axes?.knowledgeFrom)
          || parseInstant(conflict.axes?.availableFrom) < parseInstant(request.axes?.availableFrom))) {
      issue(
        violations,
        'RULE_CONFLICT_TEMPORAL_ORDER',
        at,
        'materialized conflict cannot precede its evaluation request',
      );
    }
    if (request && runRecord
        && (parseInstant(runRecord.completedAt) < parseInstant(request.axes?.knowledgeFrom)
          || parseInstant(runRecord.completedAt) < parseInstant(request.axes?.availableFrom)
          || parseInstant(runRecord.completedAt) > parseInstant(conflict.axes?.knowledgeFrom)
          || parseInstant(runRecord.completedAt) > parseInstant(conflict.axes?.availableFrom))) {
      issue(
        violations,
        'RULE_CONFLICT_RUN_ORDER',
        at,
        'resolver Run must complete after its request and no later than conflict availability',
      );
    }
    if (ruleConflictIndex.has(conflict.versionIri)) {
      issue(violations, 'RULE_CONFLICT_DUPLICATE', at, 'conflict version resolves more than once');
    } else {
      ruleConflictIndex.set(conflict.versionIri, conflict);
    }
  }

  const precedenceRows = [];
  const precedenceVersions = new Set();
  for (let index = 0; index < scenario.precedence.length; index += 1) {
    const edge = scenario.precedence[index];
    const at = `$.precedence[${index}]`;
    const allowed = new Set([
      'logicalIri', 'versionIri', 'versionOf', 'higherRuleVersionIri', 'lowerRuleVersionIri',
      'reason', 'supersedes', 'axes', 'provenance',
    ]);
    const higher = rules.get(edge?.higherRuleVersionIri);
    const lower = rules.get(edge?.lowerRuleVersionIri);
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)
        || Object.keys(edge).some((field) => !allowed.has(field))
        || !absoluteIri(edge.logicalIri)
        || !absoluteIri(edge.versionIri)
        || edge.versionOf !== edge.logicalIri
        || !higher
        || !lower
        || higher.kind !== lower.kind
        || higher.versionIri === lower.versionIri
        || typeof edge.reason !== 'string'
        || edge.reason.trim() === '') {
      issue(violations, 'RULE_PRECEDENCE_INTEGRITY', at, 'precedence endpoints/reason/kind are invalid');
      continue;
    }
    if (precedenceVersions.has(edge.versionIri)) {
      issue(violations, 'RULE_PRECEDENCE_DUPLICATE', at, 'duplicate precedence version');
    }
    precedenceVersions.add(edge.versionIri);
    precedenceRows.push(edge);
    validateAxes(edge.axes, `${at}.axes`, 'RULE_PRECEDENCE', violations);
    validateProvenance(edge.provenance, `${at}.provenance`, 'RULE_PRECEDENCE', violations);
    const higherScopes = scenario.applicabilities
      .filter((row) => row?.ruleVersionIri === higher.versionIri)
      .map((row) => normalizedScopes(row.scopes || {}, scopeVersionIndex));
    const lowerScopes = scenario.applicabilities
      .filter((row) => row?.ruleVersionIri === lower.versionIri)
      .map((row) => normalizedScopes(row.scopes || {}, scopeVersionIndex));
    if (!higherScopes.some((left) => lowerScopes.some((right) => scopeMapsOverlap(left, right)))) {
      issue(
        violations,
        'RULE_PRECEDENCE_NON_OVERLAP',
        at,
        'precedence endpoints have no overlapping authored scope',
      );
    }
  }

  const facts = new Map();
  for (const fact of [
    ...scenario.scopeVersions,
    ...scenario.requestAuthorityVersions,
    ...scenario.evaluationRequests,
    ...scenario.rules,
    ...scenario.clauses,
    ...scenario.applicabilities,
    ...scenario.precedence,
    ...scenario.ruleConflicts,
  ]) {
    if (absoluteIri(fact?.versionIri)) {
      if (facts.has(fact.versionIri)) {
        issue(
          violations,
          'RULE_FACT_DUPLICATE_VERSION',
          fact.versionIri,
          'one exact version IRI identifies more than one market-rule fact',
        );
      } else {
        facts.set(fact.versionIri, fact);
      }
    }
  }
  const closureByTargetAxis = new Map();
  for (let index = 0; index < scenario.closures.length; index += 1) {
    const closure = scenario.closures[index];
    const at = `$.closures[${index}]`;
    const allowed = new Set([
      'id', 'targetVersionIri', 'axis', 'closedAt', 'causeKind', 'causeVersionIri',
      'evidenceRef', 'generatingContextRef',
    ]);
    if (!closure || typeof closure !== 'object' || Array.isArray(closure)
        || Object.keys(closure).some((field) => !allowed.has(field))
        || !absoluteIri(closure.id)
        || !absoluteIri(closure.targetVersionIri)
        || !['knowledge', 'availability'].includes(closure.axis)
        || !validParsedInstant(parseInstant(closure.closedAt))
        || !absoluteIri(closure.evidenceRef)
        || !absoluteIri(closure.generatingContextRef)) {
      issue(violations, 'RULE_CLOSURE_INTEGRITY', at, 'FactClosureAssertion record is invalid or open-schema');
      continue;
    }
    const key = closureKey(closure.targetVersionIri, closure.axis);
    if (closureByTargetAxis.has(key)) {
      issue(violations, 'RULE_CLOSURE_DUPLICATE', at, 'at most one closure is legal per target and axis');
    } else {
      closureByTargetAxis.set(key, closure);
    }
    const target = facts.get(closure.targetVersionIri);
    const fromField = closure.axis === 'knowledge' ? 'knowledgeFrom' : 'availableFrom';
    if (!target
        || !validParsedInstant(parseInstant(target.axes?.[fromField]))
        || parseInstant(closure.closedAt) <= parseInstant(target.axes[fromField])) {
      issue(violations, 'RULE_CLOSURE_TARGET', at, 'closure must target a fact and close strictly after its axis start');
    }
    if (!facts.has(closure.evidenceRef) && !evidenceIndex.has(closure.evidenceRef)) {
      issue(
        violations,
        'RULE_CLOSURE_EVIDENCE',
        at,
        'evidenceRef must resolve to exactly one fact version or locked evidence record',
      );
    } else if (facts.has(closure.evidenceRef) && evidenceIndex.has(closure.evidenceRef)) {
      issue(
        violations,
        'RULE_CLOSURE_EVIDENCE',
        at,
        'evidenceRef is ambiguous between a fact version and locked evidence record',
      );
    }
    const generatingRun = runRecordIndex.get(closure.generatingContextRef);
    if (!generatingRun) {
      issue(
        violations,
        'RULE_CLOSURE_CONTEXT',
        at,
        'generatingContextRef must resolve to one completed Run for the scenario output graph',
      );
    }
    const allowedCauses = closure.axis === 'knowledge'
      ? ['successor', 'retraction']
      : ['successor', 'sourceWithdrawal'];
    if (!allowedCauses.includes(closure.causeKind)) {
      issue(violations, 'RULE_CLOSURE_CAUSE', at, 'axis/causeKind combination is invalid');
    } else if (closure.causeKind === 'successor') {
      const cause = facts.get(closure.causeVersionIri);
      if (!cause
          || cause.supersedes !== closure.targetVersionIri
          || closure.closedAt !== cause.axes?.[fromField]
          || (target?.logicalIri !== undefined && cause.logicalIri !== target.logicalIri)) {
        issue(violations, 'RULE_CLOSURE_CAUSE_VERSION', at, 'successor must be the exact direct successor');
      }
    } else if (closure.causeVersionIri !== undefined) {
      issue(violations, 'RULE_CLOSURE_CAUSE_VERSION', at, 'non-successor closure forbids causeVersionIri');
    }
    try {
      if (closure.id !== buildClosureAssertionIri(closure)) {
        issue(
          violations,
          'RULE_CLOSURE_IDENTITY',
          at,
          'FactClosureAssertion IRI does not recompute from the RFC 5.8 identity frame',
        );
      }
    } catch {
      issue(
        violations,
        'RULE_CLOSURE_IDENTITY',
        at,
        'FactClosureAssertion identity terms cannot be canonically framed',
      );
    }
  }
  for (const fact of facts.values()) {
    if (fact.supersedes === undefined) continue;
    const predecessor = facts.get(fact.supersedes);
    if (!predecessor
        || fact.axes?.revision !== predecessor.axes?.revision + 1
        || parseInstant(fact.axes?.knowledgeFrom) <= parseInstant(predecessor.axes?.knowledgeFrom)
        || (fact.logicalIri !== undefined && fact.logicalIri !== predecessor.logicalIri)) {
      issue(
        violations,
        'RULE_SUPERSESSION_INTEGRITY',
        fact.versionIri,
        'supersession must stay in one logical anchor and increment revision/knowledge',
      );
      continue;
    }
    const closure = closureByTargetAxis.get(closureKey(fact.supersedes, 'knowledge'));
    if (!closure
        || closure.causeKind !== 'successor'
        || closure.causeVersionIri !== fact.versionIri
        || closure.closedAt !== fact.axes.knowledgeFrom) {
      issue(
        violations,
        'RULE_SUPERSESSION_CLOSURE',
        fact.versionIri,
        'direct successor requires the unique exact predecessor knowledge closure',
      );
    }
  }
  const logicalGroups = new Map();
  for (const fact of facts.values()) {
    if (!absoluteIri(fact.logicalIri) || !fact.axes) continue;
    const rows = logicalGroups.get(fact.logicalIri) || [];
    rows.push(fact);
    logicalGroups.set(fact.logicalIri, rows);
  }
  function intervalOverlap(leftFrom, leftTo, rightFrom, rightTo) {
    return leftFrom < rightTo && rightFrom < leftTo;
  }
  function closureEnd(fact, axis) {
    return parseInstant(closureByTargetAxis.get(closureKey(fact.versionIri, axis))?.closedAt);
  }
  for (const [logicalIri, rows] of logicalGroups) {
    const revisions = new Map();
    for (const row of rows) {
      const revision = row.axes?.revision;
      if (Number.isSafeInteger(revision)) {
        if (revisions.has(revision)) {
          issue(
            violations,
            'RULE_REVISION_DUPLICATE',
            row.versionIri,
            `logical anchor ${logicalIri} has more than one version at revision ${revision}`,
          );
        } else {
          revisions.set(revision, row.versionIri);
        }
        if ((revision === 0 && row.supersedes !== undefined)
            || (revision > 0 && row.supersedes === undefined)) {
          issue(
            violations,
            'RULE_REVISION_INITIAL',
            row.versionIri,
            'revision 0 is the only legal initial version; every later revision requires its direct predecessor',
          );
        }
      }
    }
    for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
      const left = rows[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
        const right = rows[rightIndex];
        const leftValidFrom = parseInstant(left.axes?.validFrom);
        const leftValidTo = left.axes?.validTo == null ? INSTANT_INFINITY : parseInstant(left.axes.validTo);
        const rightValidFrom = parseInstant(right.axes?.validFrom);
        const rightValidTo = right.axes?.validTo == null ? INSTANT_INFINITY : parseInstant(right.axes.validTo);
        const leftKnowledgeFrom = parseInstant(left.axes?.knowledgeFrom);
        const leftKnowledgeTo = closureEnd(left, 'knowledge');
        const rightKnowledgeFrom = parseInstant(right.axes?.knowledgeFrom);
        const rightKnowledgeTo = closureEnd(right, 'knowledge');
        const leftAvailableFrom = parseInstant(left.axes?.availableFrom);
        const leftAvailableTo = closureEnd(left, 'availability');
        const rightAvailableFrom = parseInstant(right.axes?.availableFrom);
        const rightAvailableTo = closureEnd(right, 'availability');
        if ([
          leftValidFrom, leftValidTo, rightValidFrom, rightValidTo,
          leftKnowledgeFrom, rightKnowledgeFrom, leftAvailableFrom, rightAvailableFrom,
        ].every(validParsedInstant)
            && intervalOverlap(leftValidFrom, leftValidTo, rightValidFrom, rightValidTo)
            && intervalOverlap(
              leftKnowledgeFrom,
              validParsedInstant(leftKnowledgeTo) ? leftKnowledgeTo : INSTANT_INFINITY,
              rightKnowledgeFrom,
              validParsedInstant(rightKnowledgeTo) ? rightKnowledgeTo : INSTANT_INFINITY,
            )
            && intervalOverlap(
              leftAvailableFrom,
              validParsedInstant(leftAvailableTo) ? leftAvailableTo : INSTANT_INFINITY,
              rightAvailableFrom,
              validParsedInstant(rightAvailableTo) ? rightAvailableTo : INSTANT_INFINITY,
            )) {
          issue(
            violations,
            'RULE_FACT_PIT_OVERLAP',
            logicalIri,
            `versions ${left.versionIri} and ${right.versionIri} are co-eligible for one PIT tuple`,
          );
        }
      }
    }
  }
  function activeAt(row, valid, knowledge, availability) {
    const validFrom = parseInstant(row.axes?.validFrom);
    const validTo = row.axes?.validTo == null ? INSTANT_INFINITY : parseInstant(row.axes.validTo);
    const knowledgeFrom = parseInstant(row.axes?.knowledgeFrom);
    const knowledgeTo = closureEnd(row, 'knowledge');
    const availableFrom = parseInstant(row.axes?.availableFrom);
    const availableTo = closureEnd(row, 'availability');
    return validFrom <= valid && valid < validTo
      && knowledgeFrom <= knowledge
      && knowledge < (validParsedInstant(knowledgeTo) ? knowledgeTo : INSTANT_INFINITY)
      && availableFrom <= availability
      && availability < (validParsedInstant(availableTo) ? availableTo : INSTANT_INFINITY);
  }
  const cyclePrecedenceRows = precedenceRows.filter((edge) => (
    validParsedInstant(parseInstant(edge.axes?.validFrom))
      && validParsedInstant(parseInstant(edge.axes?.knowledgeFrom))
      && validParsedInstant(parseInstant(edge.axes?.availableFrom))
  ));
  let activeCycle = false;
  for (const valid of new Set(cyclePrecedenceRows.map((edge) => parseInstant(edge.axes.validFrom)))) {
    const validRows = cyclePrecedenceRows.filter((edge) => (
      parseInstant(edge.axes.validFrom) <= valid
        && valid < (edge.axes.validTo == null ? INSTANT_INFINITY : parseInstant(edge.axes.validTo))
    ));
    if (!hasDirectedCycle(validRows)) continue;
    for (const knowledge of new Set(validRows.map((edge) => parseInstant(edge.axes.knowledgeFrom)))) {
      const knowledgeRows = validRows.filter((edge) => {
        const end = closureEnd(edge, 'knowledge');
        return parseInstant(edge.axes.knowledgeFrom) <= knowledge
          && knowledge < (validParsedInstant(end) ? end : INSTANT_INFINITY);
      });
      if (!hasDirectedCycle(knowledgeRows)) continue;
      for (const availability of new Set(
        knowledgeRows.map((edge) => parseInstant(edge.axes.availableFrom)),
      )) {
        const rows = knowledgeRows.filter((edge) => activeAt(edge, valid, knowledge, availability));
        if (hasDirectedCycle(rows)) {
          activeCycle = true;
          break;
        }
      }
      if (activeCycle) break;
    }
    if (activeCycle) break;
  }
  if (activeCycle) {
    issue(violations, 'RULE_PRECEDENCE_CYCLE', '$.precedence', 'active precedence graph is cyclic');
  }
  return violations.sort((left, right) => (
    compareUtf8(left.code, right.code) || compareUtf8(left.path, right.path)
  ));
}

function requireQuery(condition, code, message) {
  if (!condition) throw new MarketRulesCqError(code, message);
}

function validatePivot(pivot) {
  requireQuery(pivot && typeof pivot === 'object', 'RULE_QUERY_PIVOT', 'explicit pivots are required');
  const parsed = {
    valid: parseInstant(pivot.asOfValid),
    knowledge: parseInstant(pivot.asOfKnowledge),
    available: parseInstant(pivot.asOfAvailable),
    reference: parseInstant(pivot.referenceTime),
  };
  requireQuery(
    Object.values(parsed).every(validParsedInstant),
    'RULE_QUERY_PIVOT',
    'all pivots must be canonical UTC instants',
  );
  requireQuery(
    parsed.knowledge <= parsed.reference && parsed.available <= parsed.reference,
    'RULE_QUERY_FUTURE',
    'knowledge and availability pivots may not exceed referenceTime',
  );
  return parsed;
}

function eligible(fact, pivot, closureByTargetAxis) {
  const axes = fact.axes;
  const validFrom = parseInstant(axes.validFrom);
  const validTo = axes.validTo == null ? INSTANT_INFINITY : parseInstant(axes.validTo);
  const knowledgeTo = closureByTargetAxis
    .get(closureKey(fact.versionIri, 'knowledge'))?.closedAt;
  const availableTo = closureByTargetAxis
    .get(closureKey(fact.versionIri, 'availability'))?.closedAt;
  return validFrom <= pivot.valid
    && pivot.valid < validTo
    && parseInstant(axes.knowledgeFrom) <= pivot.knowledge
    && (knowledgeTo == null || pivot.knowledge < parseInstant(knowledgeTo))
    && parseInstant(axes.availableFrom) <= pivot.available
    && (availableTo == null || pivot.available < parseInstant(availableTo))
    && parseInstant(axes.knowledgeFrom) <= pivot.reference;
}

function compareVector(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function framedSetDigest(values) {
  const sorted = [...new Set(values)].sort((left, right) => (
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
  ));
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('axiolune-iri-set-v1\0', 'utf8'));
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(sorted.length));
  hash.update(count);
  for (const value of sorted) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function resultFor(rule, clauses) {
  return {
    ruleKind: rule.kind,
    clauses: clauses
      .slice()
      .sort((left, right) => left.sequence - right.sequence)
      .map((clause) => {
        if (clause.type === 'SettlementCycleClause') {
          return {
            type: clause.type,
            sequence: clause.sequence,
            settlementCycle: clause.settlementCycle,
          };
        }
        return {
          type: clause.type,
          sequence: clause.sequence,
          ...(clause.priceLimitPercentage
            ? { priceLimitPercentage: clause.priceLimitPercentage }
            : { priceLimitAmount: clause.priceLimitAmount }),
        };
      }),
  };
}

function canonicalDecimal(value) {
  const [integer, fraction = ''] = String(value).split('.');
  const trimmedFraction = fraction.replace(/0+$/u, '');
  return `${integer}.${trimmedFraction || '0'}`;
}

function canonicalTypedResult(result) {
  return {
    ruleKind: result.ruleKind,
    clauses: result.clauses.map((clause) => {
      if (clause.type === 'SettlementCycleClause') return structuredClone(clause);
      if (clause.priceLimitPercentage) {
        return {
          ...clause,
          priceLimitPercentage: {
            ...clause.priceLimitPercentage,
            value: canonicalDecimal(clause.priceLimitPercentage.value),
          },
        };
      }
      return {
        ...clause,
        priceLimitAmount: {
          ...clause.priceLimitAmount,
          amount: canonicalDecimal(clause.priceLimitAmount.amount),
        },
      };
    }),
  };
}

function resolveMarketRule(scenario, query) {
  const violations = validateMarketRulesScenario(scenario);
  requireQuery(
    violations.length === 0,
    'RULE_QUERY_INVALID_SCENARIO',
    violations.map((row) => `${row.code}@${row.path}`).join(','),
  );
  requireQuery(
    query
      && typeof query === 'object'
      && !Array.isArray(query)
      && Object.keys(query).every((field) => (
        ['kind', 'evaluationRequestVersionIri', 'referenceTime'].includes(field)
      ))
      && ['settlementCycle', 'priceLimit'].includes(query.kind)
      && absoluteIri(query.evaluationRequestVersionIri)
      && validParsedInstant(parseInstant(query.referenceTime)),
    'RULE_QUERY_INTEGRITY',
    'kind, exact evaluationRequestVersionIri, and referenceTime are required',
  );
  const request = scenario.evaluationRequests.find(
    (row) => row.versionIri === query.evaluationRequestVersionIri,
  );
  requireQuery(
    request,
    'RULE_QUERY_REQUEST',
    'evaluationRequestVersionIri does not resolve to one immutable request fact',
  );
  const pivot = validatePivot({
    asOfValid: request.asOfValid,
    asOfKnowledge: request.asOfKnowledge,
    asOfAvailable: request.asOfAvailable,
    referenceTime: query.referenceTime,
  });
  const referenceInstant = pivot.reference;
  const closureByTargetAxis = buildClosureIndex(scenario, referenceInstant);
  const scopeVersionIndex = buildScopeVersionIndex(scenario);
  const requestScopeClosure = expandScopeClosure(request.scopes, scopeVersionIndex);
  requireQuery(
    requestScopeClosure.conflicts.length === 0,
    'RULE_QUERY_SCOPE_INCONSISTENT',
    'request exact scopes contradict their listing/segment relation closure',
  );
  requireQuery(
    requestScopeClosure.dependencies.every((row) => eligible(row, pivot, closureByTargetAxis)),
    'RULE_QUERY_SCOPE_NOT_ELIGIBLE',
    'request scope or one required listing/segment relation target is not PIT eligible',
  );
  const queryScopeValues = requestScopeClosure.normalized;
  const outputPivot = {
    valid: pivot.valid,
    knowledge: referenceInstant,
    available: referenceInstant,
    reference: referenceInstant,
  };
  const requestReferencePivot = {
    valid: referenceInstant,
    knowledge: referenceInstant,
    available: referenceInstant,
    reference: referenceInstant,
  };
  requireQuery(
    eligible(request, requestReferencePivot, closureByTargetAxis),
    'RULE_QUERY_REQUEST_NOT_ELIGIBLE',
    'evaluation request fact is not eligible at referenceTime',
  );
  const requestAuthority = scenario.requestAuthorityVersions.find(
    (row) => row.versionIri === request.requestAuthorityVersionIri,
  );
  const requestCreationPivot = {
    valid: parseInstant(request.axes.validFrom),
    knowledge: parseInstant(request.axes.knowledgeFrom),
    available: parseInstant(request.axes.availableFrom),
    reference: referenceInstant,
  };
  requireQuery(
    requestAuthority
      && eligible(requestAuthority, requestCreationPivot, closureByTargetAxis),
    'RULE_QUERY_REQUEST_AUTHORITY_NOT_ELIGIBLE',
    'exact request authority version was not PIT eligible when the request became available',
  );
  const rules = new Map(scenario.rules.map((rule) => [rule.versionIri, rule]));
  const applicabilityByVersion = new Map(
    scenario.applicabilities.map((row) => [row.versionIri, row]),
  );
  const clausesByRule = new Map();
  for (const clause of scenario.clauses) {
    const rows = clausesByRule.get(clause.ruleVersionIri) || [];
    rows.push(clause);
    clausesByRule.set(clause.ruleVersionIri, rows);
  }
  let candidates = [];
  for (const applicability of scenario.applicabilities) {
    const rule = rules.get(applicability.ruleVersionIri);
    if (rule.kind !== query.kind
        || !eligible(rule, pivot, closureByTargetAxis)
        || !eligible(applicability, pivot, closureByTargetAxis)) continue;
    const authoredScopes = Object.entries(applicability.scopes);
    const applicabilityScopeClosure = expandScopeClosure(
      applicability.scopes,
      scopeVersionIndex,
    );
    if (applicabilityScopeClosure.conflicts.length > 0
        || !applicabilityScopeClosure.dependencies.every(
          (row) => eligible(row, pivot, closureByTargetAxis),
        )) continue;
    const normalizedApplicabilityScopes = applicabilityScopeClosure.normalized;
    if (authoredScopes.some(([key]) => (
      queryScopeValues[key] !== normalizedApplicabilityScopes[key]
    ))) continue;
    const clauses = (clausesByRule.get(rule.versionIri) || [])
      .filter((clause) => eligible(clause, pivot, closureByTargetAxis));
    if (clauses.length !== (clausesByRule.get(rule.versionIri) || []).length) continue;
    candidates.push({
      applicability,
      rule,
      clauses,
      vector: SCOPE_ORDER.map((key) => (Object.hasOwn(applicability.scopes, key) ? 1 : 0)),
      normalizedScopes: normalizedApplicabilityScopes,
      result: resultFor(rule, clauses),
    });
  }
  const materializedConflicts = scenario.ruleConflicts.filter((conflict) => {
    const conflictKinds = new Set(conflict.candidateApplicabilityVersionIris.map((versionIri) => {
      const applicability = applicabilityByVersion.get(versionIri);
      return rules.get(applicability?.ruleVersionIri)?.kind;
    }));
    return conflict.evaluationRequestVersionIri === request.versionIri
      && conflictKinds.size === 1
      && conflictKinds.has(query.kind)
      && eligible(conflict, outputPivot, closureByTargetAxis);
  });
  if (candidates.length === 0) {
    requireQuery(
      materializedConflicts.length === 0,
      'RULE_CONFLICT_SPURIOUS',
      'a materialized RuleConflict exists although the request has no incompatible survivors',
    );
    return { outcome: 'none', evaluationRequestVersionIri: request.versionIri };
  }

  const candidateRules = new Set(candidates.map((candidate) => candidate.rule.versionIri));
  const activePrecedence = scenario.precedence.filter((edge) => (
    eligible(edge, pivot, closureByTargetAxis)
      && candidateRules.has(edge.higherRuleVersionIri)
      && candidateRules.has(edge.lowerRuleVersionIri)
  ));
  requireQuery(
    !hasDirectedCycle(activePrecedence),
    'RULE_PRECEDENCE_CYCLE',
    'reference-visible active precedence graph is cyclic at the request PIT',
  );
  const dominated = new Set();
  for (const edge of activePrecedence) {
    dominated.add(edge.lowerRuleVersionIri);
  }
  candidates = candidates.filter((candidate) => !dominated.has(candidate.rule.versionIri));
  requireQuery(
    candidates.length > 0,
    'RULE_PRECEDENCE_NO_SURVIVOR',
    'precedence elimination removed every candidate',
  );
  const bestVector = candidates.reduce(
    (best, candidate) => (compareVector(candidate.vector, best) > 0 ? candidate.vector : best),
    candidates[0].vector,
  );
  candidates = candidates.filter((candidate) => compareVector(candidate.vector, bestVector) === 0);

  const groups = new Map();
  for (const candidate of candidates) {
    const groupKey = canonicalJcs({
      ruleSetVersionIri: candidate.applicability.ruleSetVersionIri,
      sourceLogicalIri: candidate.applicability.sourceLogicalIri,
      scopes: candidate.normalizedScopes,
    });
    const rows = groups.get(groupKey) || [];
    rows.push(candidate);
    groups.set(groupKey, rows);
  }
  candidates = [...groups.values()].flatMap((rows) => {
    const highest = Math.max(...rows.map((row) => row.applicability.priority));
    return rows.filter((row) => row.applicability.priority === highest);
  });

  const byResult = new Map();
  for (const candidate of candidates) {
    const key = canonicalJcs(canonicalTypedResult(candidate.result));
    const rows = byResult.get(key) || [];
    rows.push(candidate);
    byResult.set(key, rows);
  }
  if (byResult.size > 1) {
    const ids = candidates.map((candidate) => candidate.applicability.versionIri)
      .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
    const authorityCount = new Set(
      candidates.map((candidate) => candidate.applicability.sourceLogicalIri),
    ).size;
    const expectedKind = `${RULE_CONFLICT_KIND}${
      authorityCount > 1 ? 'incomparableAuthorities' : 'incompatibleResults'
    }`;
    const expectedDigest = framedSetDigest(ids);
    requireQuery(
      materializedConflicts.length === 1,
      materializedConflicts.length === 0 ? 'RULE_CONFLICT_REQUIRED' : 'RULE_CONFLICT_AMBIGUOUS',
      'incompatible survivors require exactly one current materialized RuleConflict fact',
    );
    const conflict = materializedConflicts[0];
    requireQuery(
      conflict.ruleConflictKind === expectedKind
        && conflict.candidateApplicabilitySetDigest === expectedDigest
        && conflict.candidateApplicabilityVersionIris.length === ids.length
        && conflict.candidateApplicabilityVersionIris.every((value, index) => value === ids[index]),
      'RULE_CONFLICT_MISMATCH',
      'materialized RuleConflict does not equal the complete computed survivor set/kind',
    );
    return {
      outcome: 'conflict',
      evaluationRequestVersionIri: request.versionIri,
      conflictVersionIri: conflict.versionIri,
      conflict: structuredClone(conflict),
    };
  }
  requireQuery(
    materializedConflicts.length === 0,
    'RULE_CONFLICT_SPURIOUS',
    'a materialized RuleConflict exists although canonical typed results have a winner',
  );
  const equivalent = [...byResult.values()][0]
    .slice()
    .sort((left, right) => compareUtf8(
      left.applicability.versionIri,
      right.applicability.versionIri,
    ));
  const winner = equivalent[0];
  return {
    outcome: 'resolved',
    evaluationRequestVersionIri: request.versionIri,
    applicabilityVersionIri: winner.applicability.versionIri,
    ruleVersionIri: winner.rule.versionIri,
    ruleLogicalIri: winner.rule.logicalIri,
    result: winner.result,
    equivalentApplicabilityVersionIris: equivalent.map((row) => row.applicability.versionIri),
  };
}

module.exports = {
  MarketRulesCqError,
  buildClosureAssertionIri,
  buildRuleConflictIdentity,
  buildRuleEvaluationRequestIdentity,
  expandScopeClosure,
  framedSetDigest,
  resolveMarketRule,
  validateMarketRulesScenario,
};
