'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  identityKeyDigest,
} = require('./identity-contract-compiler.cjs');
const {
  parseDecimalLexical,
} = require('./decimal-lexical.cjs');
const {
  validateArtifactRef,
  computeSelectionDigest,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');
const { isinChecksumValid } = require('./foundation-identifier-custom.cjs');
const {
  EXPECTED: SLICE_SOURCE_EXPECTED,
  loadLockedIso4217Registry,
  loadLockedQuantityRegistry,
} = require('./slice-a-source-locks.cjs');

const CQ_FUNCTION_VERSION = 'axiolune-m2-cq-foundation-market-instrument/v1';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const SOURCE_TREE_ROOT = path.resolve(__dirname, '..', '..', '..');

const TYPE_IRIS = Object.freeze({
  EquitySecurity: 'https://axiolune.ai/ontology/finance/instruments/EquitySecurity',
  Security: 'https://axiolune.ai/ontology/finance/instruments/Security',
  FinancialInstrument: 'https://axiolune.ai/ontology/finance/instruments/FinancialInstrument',
});

class CqContractError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'CqContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CqContractError(code, message);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveDecimalLexical(value) {
  try {
    return parseDecimalLexical(value).coefficient > 0n;
  } catch {
    return false;
  }
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function u64be(value) {
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
}

function iriSetDigest(values) {
  const normalized = [...new Set(list(values).map((value) => (
    iri(value, 'iriSetDigest member', 'CQ_IRI_SET_MEMBER').normalize('NFC')
  )))].sort(compareText);
  const parts = [Buffer.from('axiolune-iri-set-v1\0', 'utf8'), u64be(normalized.length)];
  for (const value of normalized) {
    const bytes = Buffer.from(value, 'utf8');
    parts.push(u64be(bytes.length), bytes);
  }
  return `sha256:${createHash('sha256').update(Buffer.concat(parts)).digest('hex')}`;
}

function instant(value, label, code = 'CQ_INPUT_INSTANT') {
  const match = typeof value === 'string' && value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u,
  );
  if (!match) {
    fail(code, `${label} must be an explicit offset date-time`);
  }
  const offset = match[8] === 'Z'
    ? 0
    : (match[8][0] === '+' ? 1 : -1)
      * (Number(match[8].slice(1, 3)) * 60 + Number(match[8].slice(4, 6)));
  if (Math.abs(offset) > 14 * 60 || Number(match[8].slice(-2)) > 59) {
    fail(code, `${label} has an invalid UTC offset`);
  }
  const wholeSecondLexical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[8]}`;
  const wholeSecondMilliseconds = Date.parse(wholeSecondLexical);
  if (!Number.isFinite(wholeSecondMilliseconds)) {
    fail(code, `${label} must be a real offset date-time`);
  }
  const local = new Date(wholeSecondMilliseconds + offset * 60_000);
  const expected = [
    local.getUTCFullYear(),
    local.getUTCMonth() + 1,
    local.getUTCDate(),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
  ];
  const authored = match.slice(1, 7).map(Number);
  if (expected.some((component, index) => component !== authored[index])) {
    fail(code, `${label} must be a real calendar instant without normalization`);
  }
  const fractionalNanoseconds = BigInt((match[7] || '').padEnd(9, '0') || '0');
  return BigInt(wholeSecondMilliseconds) * 1_000_000n + fractionalNanoseconds;
}

function floorDivide(dividend, divisor) {
  let quotient = dividend / divisor;
  if (dividend % divisor < 0n) quotient -= 1n;
  return quotient;
}

function epochMillisecondsFloor(nanoseconds) {
  return Number(floorDivide(nanoseconds, 1_000_000n));
}

function date(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail('CQ_INPUT_DATE', `${label} must be YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('CQ_INPUT_DATE', `${label} is not a calendar date`);
  }
  return value;
}

function iri(value, label, code = 'CQ_REFERENCE_IRI') {
  if (typeof value !== 'string'
      || value !== value.normalize('NFC')
      || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]+$/u.test(value)) {
    fail(code, `${label} must be an absolute NFC IRI without control characters`);
  }
  return value;
}

function index(records, label) {
  const result = new Map();
  for (const record of list(records)) {
    const id = iri(record?.id, `${label}.id`, 'CQ_GRAPH_ID');
    if (result.has(id)) fail('CQ_GRAPH_DUPLICATE_ID', `${label} contains duplicate ${id}`);
    result.set(id, record);
  }
  return result;
}

function canonicalInstantLexical(value, label, code) {
  const nanoseconds = instant(value, label, code);
  const wholeSeconds = floorDivide(nanoseconds, 1_000_000_000n);
  const fractionalNanoseconds = nanoseconds - wholeSeconds * 1_000_000_000n;
  const base = new Date(Number(wholeSeconds * 1_000n))
    .toISOString()
    .replace('.000Z', '');
  if (fractionalNanoseconds === 0n) return `${base}Z`;
  const fraction = fractionalNanoseconds
    .toString()
    .padStart(9, '0')
    .replace(/0+$/u, '');
  return `${base}.${fraction}Z`;
}

function rdfIriTerm(value, label, code) {
  return `<${iri(value, label, code)}>`;
}

function rdfTypedLiteral(value, datatypeIri) {
  return `${JSON.stringify(value)}^^<${datatypeIri}>`;
}

function closureAssertionIri(closure) {
  const componentNames = [
    'targetVersion',
    'axis',
    'closedAt',
    'causeKind',
    'causeVersionPresent',
  ];
  const terms = {
    targetVersion: rdfIriTerm(
      closure.targetVersion,
      'FactClosureAssertion.targetVersion',
      'CQ_CLOSURE_TARGET',
    ),
    axis: rdfTypedLiteral(
      closure.axis,
      'http://www.w3.org/2001/XMLSchema#string',
    ),
    closedAt: rdfTypedLiteral(
      canonicalInstantLexical(
        closure.closedAt,
        'FactClosureAssertion.closedAt',
        'CQ_CLOSURE_INTEGRITY',
      ),
      'http://www.w3.org/2001/XMLSchema#dateTimeStamp',
    ),
    causeKind: rdfTypedLiteral(
      closure.causeKind,
      'http://www.w3.org/2001/XMLSchema#string',
    ),
    causeVersionPresent: rdfTypedLiteral(
      closure.causeKind === 'successor' ? 'true' : 'false',
      'http://www.w3.org/2001/XMLSchema#boolean',
    ),
  };
  if (closure.causeKind === 'successor') {
    componentNames.push('causeVersion');
    terms.causeVersion = rdfIriTerm(
      closure.causeVersion,
      'FactClosureAssertion.causeVersion',
      'CQ_CLOSURE_CAUSE_VERSION',
    );
  }
  componentNames.push('evidenceRef', 'generatingContextRef');
  terms.evidenceRef = rdfIriTerm(
    closure.evidenceRef,
    'FactClosureAssertion.evidenceRef',
    'CQ_CLOSURE_EVIDENCE',
  );
  terms.generatingContextRef = rdfIriTerm(
    closure.generatingContextRef,
    'FactClosureAssertion.generatingContextRef',
    'CQ_CLOSURE_CONTEXT',
  );
  const digest = identityKeyDigest(
    componentNames.map((name) => ({ name })),
    terms,
  ).toString('hex');
  return `https://axiolune.ai/data/fact-closure-assertion/sha256-${digest}`;
}

function closureKey(targetVersion, axis) {
  return `${targetVersion}\0${axis}`;
}

function resolveSourceTreeFile(artifactRef, label) {
  if (!object(artifactRef)
      || artifactRef.kind !== 'path'
      || artifactRef.root !== 'sourceTree') {
    fail(
      'CQ_FACT_PROVENANCE_RESOLUTION',
      `${label} must be a sourceTree path ArtifactRef for this executable fixture`,
    );
  }
  const resolved = path.resolve(SOURCE_TREE_ROOT, artifactRef.path);
  const relative = path.relative(SOURCE_TREE_ROOT, resolved);
  if (relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
      || !fs.existsSync(resolved)
      || !fs.statSync(resolved).isFile()) {
    fail('CQ_FACT_PROVENANCE_RESOLUTION', `${label} does not resolve to one source-tree file`);
  }
  const realRoot = fs.realpathSync(SOURCE_TREE_ROOT);
  const realFile = fs.realpathSync(resolved);
  const realRelative = path.relative(realRoot, realFile);
  if (realRelative === '..'
      || realRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(realRelative)) {
    fail('CQ_FACT_PROVENANCE_RESOLUTION', `${label} resolves outside the source tree`);
  }
  return realFile;
}

function validateFactProvenance(record, label) {
  const source = record?.source;
  if (!object(source)
      || Object.keys(source).sort().join(',') !== 'artifactDigest,artifactRef,locator'
      || !DIGEST_RE.test(source.artifactDigest || '')) {
    fail(
      'CQ_FACT_PROVENANCE',
      `${label}.source must be a closed artifactRef/artifactDigest/locator object`,
    );
  }
  const artifact = validateArtifactRef(source.artifactRef, `${label}.source.artifactRef`);
  if (!artifact.ok) {
    fail('CQ_FACT_PROVENANCE', artifact.errors.join('; '));
  }
  const locator = validateSourceLocator(source.locator, {
    at: `${label}.source.locator`,
  });
  if (!locator.ok) {
    fail('CQ_FACT_PROVENANCE', locator.errors.join('; '));
  }
  const artifactFile = resolveSourceTreeFile(
    source.artifactRef,
    `${label}.source.artifactRef`,
  );
  const artifactBytes = fs.readFileSync(artifactFile);
  const actualArtifactDigest = `sha256:${createHash('sha256')
    .update(artifactBytes)
    .digest('hex')}`;
  if (actualArtifactDigest !== source.artifactDigest) {
    fail(
      'CQ_FACT_PROVENANCE_DIGEST',
      `${label}.source.artifactDigest does not match the resolved artifact bytes`,
    );
  }
  if (source.locator.kind !== 'wholeFile'
      || source.locator.path !== source.artifactRef.path) {
    fail(
      'CQ_FACT_PROVENANCE_SELECTION',
      `${label} executable fixture requires a whole-file locator over its exact artifact`,
    );
  }
  const extractorFile = resolveSourceTreeFile(
    source.locator.extractorProfileRef,
    `${label}.source.locator.extractorProfileRef`,
  );
  const actualExtractorDigest = `sha256:${createHash('sha256')
    .update(fs.readFileSync(extractorFile))
    .digest('hex')}`;
  if (actualExtractorDigest !== source.locator.extractorProfileDigest) {
    fail(
      'CQ_FACT_PROVENANCE_DIGEST',
      `${label}.source.locator.extractorProfileDigest does not match its artifact`,
    );
  }
  const actualSelectionDigest = computeSelectionDigest(
    source.locator,
    artifactBytes,
  );
  if (actualSelectionDigest !== source.locator.selectionDigest) {
    fail(
      'CQ_FACT_PROVENANCE_SELECTION',
      `${label}.source.locator.selectionDigest does not recompute`,
    );
  }
}

function collectFactVersions(graph) {
  const versions = new Map();
  for (const [collection, records] of Object.entries(graph)) {
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (!object(record)
          || typeof record.id !== 'string'
          || record.validFrom === undefined
          || record.knowledgeFrom === undefined
          || record.availableFrom === undefined) continue;
      iri(record.id, `${collection}.id`, 'CQ_GRAPH_ID');
      if (versions.has(record.id)) {
        fail(
          'CQ_GRAPH_DUPLICATE_ID',
          `${record.id} is reused by ${versions.get(record.id).collection} and ${collection}`,
        );
      }
      validateFactProvenance(record, `${collection}.${record.id}`);
      versions.set(record.id, { collection, record });
    }
  }
  return versions;
}

function compileClosureContext(graph) {
  const versions = collectFactVersions(graph);
  const closures = new Map();
  const allowedFields = new Set([
    'id',
    'targetVersion',
    'axis',
    'closedAt',
    'causeKind',
    'causeVersion',
    'evidenceRef',
    'generatingContextRef',
  ]);
  for (const [position, closure] of list(graph.factClosureAssertions).entries()) {
    const label = `factClosureAssertions[${position}]`;
    if (!object(closure)
        || Object.keys(closure).some((field) => !allowedFields.has(field))) {
      fail('CQ_CLOSURE_INTEGRITY', `${label} is not a closed FactClosureAssertion`);
    }
    iri(closure.id, `${label}.id`, 'CQ_CLOSURE_ID');
    if (!['knowledge', 'availability'].includes(closure.axis)) {
      fail('CQ_CLOSURE_AXIS', `${label}.axis is outside the closed axis set`);
    }
    const target = versions.get(closure.targetVersion)?.record;
    if (!target) {
      fail('CQ_CLOSURE_TARGET', `${label} targets an unknown exact fact version`);
    }
    const key = closureKey(closure.targetVersion, closure.axis);
    if (closures.has(key)) {
      fail(
        'CQ_CLOSURE_DUPLICATE',
        `${closure.targetVersion} has multiple ${closure.axis} closures`,
      );
    }
    const fromField = closure.axis === 'knowledge'
      ? 'knowledgeFrom'
      : 'availableFrom';
    const closedAt = instant(
      closure.closedAt,
      `${label}.closedAt`,
      'CQ_CLOSURE_INTEGRITY',
    );
    if (closedAt <= instant(target[fromField], `${closure.targetVersion}.${fromField}`, 'CQ_FACT_AXES')) {
      fail(
        'CQ_CLOSURE_INTERVAL',
        `${label}.closedAt must be strictly after target ${fromField}`,
      );
    }
    const allowedCauses = closure.axis === 'knowledge'
      ? ['successor', 'retraction']
      : ['successor', 'sourceWithdrawal'];
    if (!allowedCauses.includes(closure.causeKind)) {
      fail(
        'CQ_CLOSURE_CAUSE',
        `${closure.axis}/${String(closure.causeKind)} is not a legal closure cause`,
      );
    }
    if (closure.causeKind === 'successor') {
      const successor = versions.get(closure.causeVersion)?.record;
      if (!successor
          || successor.supersedes !== closure.targetVersion
          || successor.logicalId !== target.logicalId
          || successor.revision !== target.revision + 1) {
        fail(
          'CQ_CLOSURE_CAUSE_VERSION',
          `${label}.causeVersion is not the unique direct same-identity successor`,
        );
      }
      const successorBoundary = closure.axis === 'knowledge'
        ? successor.knowledgeFrom
        : successor.availableFrom;
      if (closedAt !== instant(
        successorBoundary,
        `${closure.causeVersion}.${fromField}`,
        'CQ_FACT_AXES',
      )) {
        fail(
          'CQ_CLOSURE_SUCCESSOR_BOUNDARY',
          `${label}.closedAt must equal its successor's ${fromField}`,
        );
      }
    } else if (closure.causeVersion !== undefined) {
      fail(
        'CQ_CLOSURE_CAUSE_VERSION',
        `${label} forbids causeVersion for ${closure.causeKind}`,
      );
    }
    iri(closure.evidenceRef, `${label}.evidenceRef`, 'CQ_CLOSURE_EVIDENCE');
    iri(
      closure.generatingContextRef,
      `${label}.generatingContextRef`,
      'CQ_CLOSURE_CONTEXT',
    );
    const expectedIri = closureAssertionIri(closure);
    if (closure.id !== expectedIri) {
      fail(
        'CQ_CLOSURE_ID',
        `${label}.id does not recompute from the RFC-001 identity frame`,
      );
    }
    closures.set(key, { ...closure, closedAtNanoseconds: closedAt });
  }
  for (const { record } of versions.values()) {
    if (record.supersedes === undefined) continue;
    const predecessor = versions.get(record.supersedes)?.record;
    if (!predecessor
        || predecessor.logicalId !== record.logicalId
        || record.revision !== predecessor.revision + 1
        || instant(record.knowledgeFrom, `${record.id}.knowledgeFrom`, 'CQ_FACT_AXES')
          <= instant(predecessor.knowledgeFrom, `${predecessor.id}.knowledgeFrom`, 'CQ_FACT_AXES')) {
      fail(
        'CQ_SUPERSESSION_INTEGRITY',
        `${record.id} is not a legal direct same-identity successor`,
      );
    }
    const knowledgeClosure = closures.get(closureKey(predecessor.id, 'knowledge'));
    if (!knowledgeClosure
        || knowledgeClosure.causeKind !== 'successor'
        || knowledgeClosure.causeVersion !== record.id) {
      fail(
        'CQ_CLOSURE_MISSING',
        `${predecessor.id} lacks the exact knowledge closure for successor ${record.id}`,
      );
    }
    const availabilityClosure = closures.get(closureKey(predecessor.id, 'availability'));
    if (!availabilityClosure
        || availabilityClosure.causeKind !== 'successor'
        || availabilityClosure.causeVersion !== record.id) {
      fail(
        'CQ_CLOSURE_MISSING',
        `${predecessor.id} lacks the exact availability closure for successor ${record.id}`,
      );
    }
  }
  return closures;
}

function pivot(value, graph) {
  if (!object(value)) fail('CQ_INPUT_PIVOT', 'an explicit three-axis pivot is required');
  const normalized = {
    valid: instant(value.asOfValid, 'pivot.asOfValid'),
    knowledge: instant(value.asOfKnowledge, 'pivot.asOfKnowledge'),
    available: instant(value.asOfAvailable, 'pivot.asOfAvailable'),
    reference: instant(value.referenceTime, 'pivot.referenceTime'),
    closures: compileClosureContext(graph),
  };
  if (normalized.knowledge > normalized.reference || normalized.available > normalized.reference) {
    fail('CQ_FUTURE_PIVOT', 'knowledge and availability pivots may not exceed referenceTime');
  }
  return normalized;
}

function axisEligible(record, fromName, toName, at, label) {
  const from = instant(record?.[fromName], `${label}.${fromName}`, 'CQ_FACT_AXES');
  if (record?.[toName] === undefined) return at >= from;
  const to = instant(record[toName], `${label}.${toName}`, 'CQ_FACT_AXES');
  if (to <= from) fail('CQ_FACT_AXES', `${label}.${toName} must be after ${fromName}`);
  return at >= from && at < to;
}

function pitEligible(record, normalizedPivot, label) {
  if (Object.hasOwn(record || {}, 'knowledgeTo')
      || Object.hasOwn(record || {}, 'availableTo')) {
    fail(
      'CQ_INLINE_CLOSURE',
      `${label} stores knowledgeTo/availableTo without FactClosureAssertion evidence`,
    );
  }
  if (!Number.isSafeInteger(record?.revision) || record.revision < 0) {
    fail('CQ_FACT_AXES', `${label}.revision must be a non-negative safe integer`);
  }
  const knowledgeFrom = instant(
    record?.knowledgeFrom,
    `${label}.knowledgeFrom`,
    'CQ_FACT_AXES',
  );
  const availableFrom = instant(
    record?.availableFrom,
    `${label}.availableFrom`,
    'CQ_FACT_AXES',
  );
  if (knowledgeFrom > normalizedPivot.reference) {
    fail('CQ_FUTURE_FACT_KNOWLEDGE', `${label}.knowledgeFrom exceeds referenceTime`);
  }
  if (availableFrom > normalizedPivot.reference) {
    fail('CQ_FUTURE_FACT_AVAILABILITY', `${label}.availableFrom exceeds referenceTime`);
  }
  const knowledgeClosure = normalizedPivot.closures.get(
    closureKey(record.id, 'knowledge'),
  );
  const availabilityClosure = normalizedPivot.closures.get(
    closureKey(record.id, 'availability'),
  );
  return axisEligible(record, 'validFrom', 'validTo', normalizedPivot.valid, label)
    && normalizedPivot.knowledge >= knowledgeFrom
    && (!knowledgeClosure || normalizedPivot.knowledge < knowledgeClosure.closedAtNanoseconds)
    && normalizedPivot.available >= availableFrom
    && (!availabilityClosure || normalizedPivot.available < availabilityClosure.closedAtNanoseconds);
}

function getExact(indexed, id, code, label) {
  iri(id, label, code);
  const record = indexed.get(id);
  if (!record) fail(code, `${label} ${id} was not found`);
  return record;
}

function exactSubject(graph, id) {
  for (const [label, records] of [
    ['instruments', graph.instruments],
    ['parties', graph.parties],
    ['facilities', graph.facilities],
  ]) {
    const found = list(records).find((record) => record?.id === id);
    if (found) return { label, record: found };
  }
  fail('CQ_F1_SUBJECT_NOT_FOUND', `assigned subject version ${id} was not found`);
}

function validateIsin(value, label) {
  if (typeof value !== 'string' || !/^[A-Z]{2}[A-Z0-9]{9}\d$/u.test(value)) {
    fail('CQ_IDENTIFIER_LEXICAL_FORM', `${label} is not a 12-character ISIN`);
  }
  if (!isinChecksumValid(value)) {
    fail('CQ_IDENTIFIER_LEXICAL_FORM', `${label} has an invalid ISIN check digit`);
  }
}

function identifierLexicalValue(value) {
  if (value?.type === 'ISINValue') return value.isinLexicalValue;
  if (value?.type === 'MICValue') return value.micLexicalValue;
  if (value?.type === 'LocalIdentifierValue') return value.localIdentifierLexicalValue;
  return undefined;
}

function f1Indexes(graph) {
  return {
    authorities: index(graph.identifierAuthorityVersions, 'identifierAuthorityVersions'),
    schemes: index(graph.identifierSchemeVersions, 'identifierSchemeVersions'),
    values: index(graph.identifierValueVersions, 'identifierValueVersions'),
    authorizations: index(
      graph.identifierSchemeAuthorizationVersions,
      'identifierSchemeAuthorizationVersions',
    ),
    assignments: index(
      graph.financialIdentifierAssignmentVersions,
      'financialIdentifierAssignmentVersions',
    ),
    conflicts: index(
      graph.identifierAssignmentConflictVersions,
      'identifierAssignmentConflictVersions',
    ),
  };
}

function validateAssignmentBinding(graph, indexes, binding, normalizedPivot) {
  if (!object(binding)) fail('CQ_F1_BINDING', 'assignment binding must be an object');
  const assignment = getExact(
    indexes.assignments,
    binding.assignmentVersionIri,
    'CQ_F1_ASSIGNMENT_NOT_FOUND',
    'assignmentVersionIri',
  );
  const scheme = getExact(
    indexes.schemes,
    binding.schemeVersionIri,
    'CQ_F1_SCHEME_NOT_FOUND',
    'schemeVersionIri',
  );
  const value = getExact(
    indexes.values,
    binding.valueVersionIri,
    'CQ_F1_VALUE_NOT_FOUND',
    'valueVersionIri',
  );
  const authorization = getExact(
    indexes.authorizations,
    binding.authorizationVersionIri,
    'CQ_F1_AUTHORIZATION_NOT_FOUND',
    'authorizationVersionIri',
  );
  const authority = getExact(
    indexes.authorities,
    assignment.assigningAuthorityVersion,
    'CQ_F1_AUTHORITY_NOT_FOUND',
    'assignment.assigningAuthorityVersion',
  );
  const subject = exactSubject(graph, assignment.identifiedSubjectVersion);

  for (const [record, label] of [
    [assignment, `assignment ${assignment.id}`],
    [scheme, `scheme ${scheme.id}`],
    [value, `value ${value.id}`],
    [authorization, `authorization ${authorization.id}`],
    [authority, `authority ${authority.id}`],
    [subject.record, `subject ${subject.record.id}`],
  ]) {
    if (!pitEligible(record, normalizedPivot, label)) {
      fail('CQ_F1_NOT_PIT_ELIGIBLE', `${label} is not eligible at the requested pivot`);
    }
  }

  if (assignment.identifierSchemeVersion !== scheme.id
      || assignment.identifierValueVersion !== value.id
      || value.identifierValueScheme !== scheme.logicalId
      || assignment.assigningAuthorityVersion !== authority.id
      || authorization.authorizedSchemeVersion !== scheme.id
      || authorization.authorizedAuthorityVersion !== authority.id
      || authorization.identifierAuthorityRole !== 'assigningAuthority') {
    fail('CQ_F1_EXACT_CHAIN', `assignment ${assignment.id} does not bind the exact scheme/value/authority/authorization versions`);
  }
  if (typeof assignment.assignmentId !== 'string'
      || assignment.assignmentId.length === 0
      || assignment.assignmentId !== assignment.assignmentId.trim()
      || assignment.assignmentId !== assignment.assignmentId.normalize('NFC')) {
    fail('CQ_F1_ASSIGNMENT_ID', `${assignment.id} lacks a canonical non-empty assignmentId`);
  }
  if (instant(authorization.validFrom, `${authorization.id}.validFrom`, 'CQ_FACT_AXES')
        > instant(assignment.validFrom, `${assignment.id}.validFrom`, 'CQ_FACT_AXES')
      || (authorization.validTo !== undefined
        && (assignment.validTo === undefined
          || instant(authorization.validTo, `${authorization.id}.validTo`, 'CQ_FACT_AXES')
            < instant(assignment.validTo, `${assignment.id}.validTo`, 'CQ_FACT_AXES')))) {
    fail('CQ_F1_AUTHORIZATION_COVERAGE', `authorization ${authorization.id} does not cover assignment ${assignment.id}`);
  }
  if (scheme.identifierSchemeKind === 'iso6166Isin') {
    if (value.type !== 'ISINValue'
        || !['Security', 'EquitySecurity'].includes(subject.record.type)) {
      fail('CQ_F1_COMPATIBILITY', 'ISO 6166 requires ISINValue assigned to Security');
    }
    validateIsin(identifierLexicalValue(value), value.id);
  } else if (scheme.identifierSchemeKind === 'internalInstrument') {
    if (value.type !== 'LocalIdentifierValue'
        || !['FinancialInstrument', 'Security', 'EquitySecurity'].includes(subject.record.type)
        || typeof value.localIdentifierLexicalValue !== 'string'
        || value.localIdentifierLexicalValue.length === 0
        || value.localIdentifierLexicalValue !== value.localIdentifierLexicalValue.trim()
        || value.localIdentifierLexicalValue !== value.localIdentifierLexicalValue.normalize('NFC')) {
      fail('CQ_F1_COMPATIBILITY', 'internal instrument scheme requires LocalIdentifierValue assigned to FinancialInstrument');
    }
  } else {
    fail('CQ_F1_COMPATIBILITY', `scheme kind ${String(scheme.identifierSchemeKind)} is not in CQ-F1's closed matrix`);
  }

  return { assignment, scheme, value, authorization, authority, subject: subject.record };
}

function executeF1(graph, query) {
  const normalizedPivot = pivot(query?.pivot, graph);
  const bindings = list(query?.bindings);
  if (bindings.length < 2) fail('CQ_F1_BINDING', 'CQ-F1 requires at least two exact assignment bindings');
  const indexes = f1Indexes(graph);
  const resolved = bindings.map((binding) => (
    validateAssignmentBinding(graph, indexes, binding, normalizedPivot)
  ));
  const subjects = [...new Map(resolved.map((item) => [item.subject.logicalId, item.subject])).values()]
    .sort((left, right) => compareText(left.logicalId, right.logicalId));
  if (subjects.length === 1) {
    return [{
      resolution: 'sameSubject',
      subjectLogicalIri: subjects[0].logicalId,
      subjectVersionIris: [...new Set(resolved.map((item) => item.subject.id))].sort(compareText),
      assignmentVersionIris: resolved.map((item) => item.assignment.id).sort(compareText),
    }];
  }

  const tupleKeys = new Set(resolved.map((item) => `${item.scheme.logicalId}\0${item.value.logicalId}`));
  const global = resolved.every((item) => item.scheme.identifierUniquenessScope === 'global');
  if (tupleKeys.size === 1 && global) {
    const assignmentIds = resolved.map((item) => item.assignment.id).sort(compareText);
    const candidates = [...indexes.conflicts.values()].filter((conflict) => (
      conflict.conflictSchemeVersion === resolved[0].scheme.id
      && conflict.conflictValueVersion === resolved[0].value.id
      && pitEligible(conflict, normalizedPivot, `conflict ${conflict.id}`)
      && list(conflict.conflictingAssignmentVersion).slice().sort(compareText).join('\0') === assignmentIds.join('\0')
    ));
    if (candidates.length !== 1) {
      fail('CQ_F1_CONFLICT_REQUIRED', `global overlapping assignments require exactly one explicit IdentifierAssignmentConflict; found ${candidates.length}`);
    }
    const expectedSetDigest = iriSetDigest(assignmentIds);
    if (!DIGEST_RE.test(candidates[0].assignmentVersionSetDigest || '')
        || candidates[0].assignmentVersionSetDigest !== expectedSetDigest) {
      fail('CQ_F1_CONFLICT_DIGEST', `${candidates[0].id} assignmentVersionSetDigest does not recompute`);
    }
    iri(
      candidates[0].generatingContextRef,
      `${candidates[0].id}.generatingContextRef`,
      'CQ_F1_CONFLICT_CONTEXT',
    );
    return [{
      resolution: 'IdentifierAssignmentConflict',
      conflictVersionIri: candidates[0].id,
      subjectLogicalIris: subjects.map((subject) => subject.logicalId),
      assignmentVersionIris: assignmentIds,
    }];
  }

  return [{
    resolution: 'differentSubjects',
    subjectLogicalIris: subjects.map((subject) => subject.logicalId),
    assignmentVersionIris: resolved.map((item) => item.assignment.id).sort(compareText),
  }];
}

function executeF2(graph, query) {
  const normalizedPivot = pivot(query?.pivot, graph);
  const jurisdiction = iri(
    query?.jurisdictionLogicalIri,
    'jurisdictionLogicalIri',
    'CQ_F2_JURISDICTION',
  );
  const registryAuthority = iri(
    query?.registryAuthorityLogicalIri,
    'registryAuthorityLogicalIri',
    'CQ_F2_REGISTRY_AUTHORITY',
  );
  const usages = list(graph.currencyUsageVersions).filter((usage) => (
    usage?.usageJurisdiction === jurisdiction
    && pitEligible(usage, normalizedPivot, `CurrencyUsage ${String(usage?.id)}`)
  ));
  const usageByCurrency = new Map();
  for (const usage of usages) {
    iri(usage.id, 'CurrencyUsage.id', 'CQ_GRAPH_ID');
    iri(usage.usedCurrency, `${usage.id}.usedCurrency`, 'CQ_F2_CURRENCY');
    if (usageByCurrency.has(usage.usedCurrency)) {
      fail('CQ_F2_USAGE_AMBIGUITY', `${usage.usedCurrency} has multiple PIT-eligible usages in ${jurisdiction}`);
    }
    usageByCurrency.set(usage.usedCurrency, usage);
  }

  const rows = [];
  for (const [currencyLogical, usage] of usageByCurrency) {
    const registry = list(graph.currencyRegistryEntryVersions).filter((entry) => (
      entry?.iso4217EntryCurrency === currencyLogical
      && entry.iso4217RegistryAuthority === registryAuthority
      && entry.iso4217EntryStatus === 'active'
      && pitEligible(entry, normalizedPivot, `ISO4217RegistryEntry ${String(entry?.id)}`)
    ));
    if (registry.length > 1) {
      fail('CQ_F2_REGISTRY_AMBIGUITY', `${currencyLogical} has ${registry.length} PIT-eligible ISO4217RegistryEntry versions`);
    }
    if (registry.length === 0) continue;
    const entry = registry[0];
    if (!/^[A-Z]{3}$/u.test(entry.iso4217AlphaCode || '')
        || !/^\d{3}$/u.test(entry.iso4217NumericCode || '')
        || !Number.isSafeInteger(entry.iso4217MinorUnit)
        || entry.iso4217MinorUnit < 0) {
      fail('CQ_F2_REGISTRY_ENTRY', `${entry.id} has invalid ISO 4217 code or minor-unit fields`);
    }
    rows.push({
      jurisdictionLogicalIri: jurisdiction,
      currencyLogicalIri: currencyLogical,
      currencyUsageVersionIri: usage.id,
      registryEntryVersionIri: entry.id,
      registryAuthorityLogicalIri: registryAuthority,
      alphabeticCode: entry.iso4217AlphaCode,
      numericCode: entry.iso4217NumericCode,
      minorUnit: entry.iso4217MinorUnit,
    });
  }
  return rows.sort((left, right) => compareText(left.currencyLogicalIri, right.currencyLogicalIri));
}

function marketIndexes(graph) {
  return {
    facilities: index(graph.facilities, 'facilities'),
    micEntries: index(graph.micEntries, 'micEntries'),
    identifierValues: index(graph.identifierValueVersions, 'identifierValueVersions'),
    identifierSchemes: index(graph.identifierSchemeVersions, 'identifierSchemeVersions'),
  };
}

function validateMicEntry(indexes, entry, normalizedPivot) {
  if (!pitEligible(entry, normalizedPivot, `MICRegistryEntry ${entry.id}`)) return null;
  const values = [...indexes.identifierValues.values()].filter((valueVersion) => (
    valueVersion.logicalId === entry.registryMICValue
    && pitEligible(valueVersion, normalizedPivot, `MICValue ${valueVersion.id}`)
  ));
  if (values.length !== 1) {
    fail('CQ_MS1_MIC_VALUE_AMBIGUITY', `${entry.id} resolves ${values.length} PIT-eligible MICValue versions`);
  }
  const value = values[0];
  const schemes = [...indexes.identifierSchemes.values()].filter((schemeVersion) => (
    schemeVersion.logicalId === value.identifierValueScheme
    && pitEligible(schemeVersion, normalizedPivot, `IdentifierScheme ${schemeVersion.id}`)
  ));
  if (schemes.length !== 1) {
    fail('CQ_MS1_MIC_SCHEME_AMBIGUITY', `${value.id} resolves ${schemes.length} PIT-eligible IdentifierScheme versions`);
  }
  const scheme = schemes[0];
  const facility = getExact(
    indexes.facilities,
    entry.registryFacility,
    'CQ_MS1_FACILITY_NOT_FOUND',
    'MICRegistryEntry.registryFacility',
  );
  if (!pitEligible(facility, normalizedPivot, `TradingFacility ${facility.id}`)) return null;
  if (scheme.identifierSchemeKind !== 'iso10383Mic'
      || value.type !== 'MICValue'
      || entry.registryAuthority !== scheme.identifierSchemeMaintainer
      || !/^[A-Z0-9]{4}$/u.test(value.micLexicalValue || '')) {
    fail('CQ_MS1_MIC_CHAIN', `${entry.id} does not bind a compatible ISO 10383 MICValue`);
  }
  let operating = null;
  if (entry.micEntryType === 'OPRT') {
    if (facility.type !== 'TradingVenue' || entry.operatingMICEntry !== undefined) {
      fail('CQ_MS1_OPERATING_CHAIN', `${entry.id} is not a valid OPRT entry`);
    }
  } else if (entry.micEntryType === 'SGMT') {
    operating = getExact(
      indexes.micEntries,
      entry.operatingMICEntry,
      'CQ_MS1_OPERATING_ENTRY_NOT_FOUND',
      'operatingMICEntry',
    );
    const operatingFacility = getExact(
      indexes.facilities,
      operating.registryFacility,
      'CQ_MS1_FACILITY_NOT_FOUND',
      'operatingMICEntry.registryFacility',
    );
    const segmentVenue = getExact(
      indexes.facilities,
      facility.venue,
      'CQ_MS1_FACILITY_NOT_FOUND',
      'MarketSegment.venue',
    );
    if (facility.type !== 'MarketSegment'
        || operating.micEntryType !== 'OPRT'
        || !pitEligible(operating, normalizedPivot, `MICRegistryEntry ${operating.id}`)
        || operatingFacility.type !== 'TradingVenue'
        || segmentVenue.logicalId !== operatingFacility.logicalId) {
      fail('CQ_MS1_SEGMENT_CHAIN', `${entry.id} does not terminate at its venue's active OPRT entry`);
    }
  } else {
    fail('CQ_MS1_ENTRY_TYPE', `${entry.id} has unsupported entry type ${String(entry.micEntryType)}`);
  }
  return { entry, value, scheme, facility, operating };
}

function executeMs1(graph, query) {
  const normalizedPivot = pivot(query?.pivot, graph);
  const indexes = marketIndexes(graph);
  const valueId = iri(
    query?.micValueVersionIri,
    'micValueVersionIri',
    'CQ_MS1_MIC_VALUE_NOT_FOUND',
  );
  const requestedValue = indexes.identifierValues.get(valueId);
  if (!requestedValue || !pitEligible(requestedValue, normalizedPivot, `MICValue ${valueId}`)) return [];
  const matching = [...indexes.micEntries.values()].filter((entry) => (
    entry.registryMICValue === requestedValue.logicalId
  ));
  const resolved = matching
    .map((entry) => validateMicEntry(indexes, entry, normalizedPivot))
    .filter(Boolean);
  if (resolved.length > 1) {
    fail('CQ_MS1_REGISTRY_AMBIGUITY', `${valueId} resolves to ${resolved.length} PIT-eligible MIC registry entries`);
  }
  return resolved.map(({ entry, value, facility, operating }) => ({
    micValueVersionIri: value.id,
    micLexicalValue: value.micLexicalValue,
    micRegistryEntryVersionIri: entry.id,
    entryType: entry.micEntryType,
    validFrom: entry.validFrom,
    validTo: entry.validTo || null,
    tradingFacilityVersionIri: facility.id,
    tradingFacilityLogicalIri: facility.logicalId,
    operatingMicEntryVersionIri: operating?.id || null,
  }));
}

function activeBusinessDate(record, businessDate) {
  return typeof record?.businessFrom === 'string'
    && record.businessFrom <= businessDate
    && (record.businessTo === undefined || businessDate < record.businessTo);
}

function executeMs2(graph, query) {
  const normalizedPivot = pivot(query?.pivot, graph);
  const businessDate = date(query?.businessDate, 'businessDate');
  const indexes = marketIndexes(graph);
  const operatingId = iri(
    query?.operatingMicEntryVersionIri,
    'operatingMicEntryVersionIri',
    'CQ_MS2_OPERATING_ENTRY',
  );
  const operating = indexes.micEntries.get(operatingId);
  if (!operating) return [];
  const validatedOperating = validateMicEntry(indexes, operating, normalizedPivot);
  if (!validatedOperating || operating.micEntryType !== 'OPRT') {
    fail('CQ_MS2_OPERATING_ENTRY', `${operatingId} is not an active PIT-eligible OPRT entry`);
  }
  const listings = index(graph.listings, 'listings');
  const instruments = index(graph.instruments, 'instruments');
  const rows = [];
  for (const segmentEntry of indexes.micEntries.values()) {
    if (segmentEntry.micEntryType !== 'SGMT'
        || segmentEntry.operatingMICEntry !== operatingId) continue;
    const validated = validateMicEntry(indexes, segmentEntry, normalizedPivot);
    if (!validated) continue;
    for (const listing of listings.values()) {
      if (listing.facility !== validated.facility.id
          || !pitEligible(listing, normalizedPivot, `InstrumentListing ${listing.id}`)
          || !activeBusinessDate(listing, businessDate)) continue;
      const instrument = getExact(
        instruments,
        listing.instrument,
        'CQ_MS2_INSTRUMENT_NOT_FOUND',
        'InstrumentListing.instrument',
      );
      if (!pitEligible(instrument, normalizedPivot, `FinancialInstrument ${instrument.id}`)) continue;
      rows.push({
        operatingMicEntryVersionIri: operating.id,
        segmentMicEntryVersionIri: segmentEntry.id,
        marketSegmentVersionIri: validated.facility.id,
        marketSegmentLogicalIri: validated.facility.logicalId,
        listingVersionIri: listing.id,
        listingLogicalIri: listing.logicalId,
        instrumentVersionIri: instrument.id,
        instrumentLogicalIri: instrument.logicalId,
      });
    }
  }
  const duplicate = new Set();
  for (const row of rows) {
    if (duplicate.has(row.listingLogicalIri)) {
      fail('CQ_MS2_LISTING_AMBIGUITY', `${row.listingLogicalIri} has multiple PIT-eligible versions`);
    }
    duplicate.add(row.listingLogicalIri);
  }
  return rows.sort((left, right) => compareText(left.listingVersionIri, right.listingVersionIri));
}

function localDate(instantValue, timeZone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    fail('CQ_MS3_TIME_ZONE', `calendar time zone ${String(timeZone)} is unavailable`);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epochMillisecondsFloor(instantValue)))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function executeMs3(graph, query) {
  const normalizedPivot = pivot(query?.pivot, graph);
  const requestedInstantText = query?.instant;
  const requestedInstant = instant(requestedInstantText, 'instant');
  const calendars = index(graph.calendars, 'calendars');
  const calendarId = iri(
    query?.calendarVersionIri,
    'calendarVersionIri',
    'CQ_MS3_CALENDAR',
  );
  const calendar = calendars.get(calendarId);
  if (!calendar || !pitEligible(calendar, normalizedPivot, `TradingCalendar ${calendarId}`)) return [];
  const templates = index(graph.sessionTemplates, 'sessionTemplates');
  const facilities = index(graph.facilities, 'facilities');
  const businessDate = localDate(requestedInstant, calendar.timeZone);
  const occurrences = list(graph.sessionOccurrences).filter((occurrence) => (
    occurrence?.calendar === calendarId
    && occurrence.businessDate === businessDate
    && pitEligible(occurrence, normalizedPivot, `SessionOccurrence ${String(occurrence?.id)}`)
  ));
  if (occurrences.length === 0) {
    return [{
      calendarVersionIri: calendar.id,
      businessDate,
      instant: requestedInstantText,
      state: 'closed',
      occurrenceVersionIri: null,
      appliedExceptionVersionIri: null,
      effectiveStartUtc: null,
      effectiveEndUtc: null,
    }];
  }
  return occurrences.sort((left, right) => compareText(left.id, right.id)).map((occurrence) => {
    const template = getExact(
      templates,
      occurrence.template,
      'CQ_MS3_TEMPLATE_NOT_FOUND',
      'SessionOccurrence.template',
    );
    const facility = getExact(
      facilities,
      occurrence.facility,
      'CQ_MS3_FACILITY_NOT_FOUND',
      'SessionOccurrence.facility',
    );
    if (!pitEligible(template, normalizedPivot, `TradingSessionTemplate ${template.id}`)
        || !pitEligible(facility, normalizedPivot, `TradingFacility ${facility.id}`)) {
      fail('CQ_MS3_OCCURRENCE_JOIN', `${occurrence.id} references an ineligible template or facility`);
    }
    if (template.calendar !== calendar.id
        || calendar.facilityLogical !== facility.logicalId) {
      fail('CQ_MS3_OCCURRENCE_JOIN', `${occurrence.id} template/calendar/facility versions disagree`);
    }
    let effectiveStart = occurrence.startUtc;
    let effectiveEnd = occurrence.endUtc;
    const exceptions = list(graph.calendarExceptions).filter((exception) => (
      exception?.occurrence === occurrence.id
      && pitEligible(exception, normalizedPivot, `CalendarException ${String(exception?.id)}`)
    ));
    if (exceptions.length > 1) {
      fail('CQ_MS3_EXCEPTION_AMBIGUITY', `${occurrence.id} has ${exceptions.length} eligible exceptions`);
    }
    const exception = exceptions[0];
    if (exception && exception.businessDate !== occurrence.businessDate) {
      fail('CQ_MS3_EXCEPTION_TARGET', `${exception.id} does not share ${occurrence.id}'s business date`);
    }
    if (exception?.kind === 'holiday' || exception?.kind === 'closure') {
      effectiveStart = null;
      effectiveEnd = null;
    } else if (exception?.kind === 'earlySession') {
      effectiveEnd = exception.replacementEndUtc;
    } else if (exception?.kind === 'lateSession') {
      effectiveStart = exception.replacementStartUtc;
    } else if (exception) {
      fail('CQ_MS3_EXCEPTION_KIND', `${exception.id} has unsupported kind ${String(exception.kind)}`);
    }
    let effectiveStartInstant = null;
    let effectiveEndInstant = null;
    if (effectiveStart !== null && effectiveEnd !== null) {
      effectiveStartInstant = instant(
        effectiveStart,
        'effectiveStartUtc',
        'CQ_MS3_OCCURRENCE_INTERVAL',
      );
      effectiveEndInstant = instant(
        effectiveEnd,
        'effectiveEndUtc',
        'CQ_MS3_OCCURRENCE_INTERVAL',
      );
      if (effectiveStartInstant >= effectiveEndInstant) {
        fail('CQ_MS3_OCCURRENCE_INTERVAL', `${occurrence.id} has an empty exception-adjusted interval`);
      }
    }
    const open = effectiveStartInstant !== null
      && requestedInstant >= effectiveStartInstant
      && requestedInstant < effectiveEndInstant;
    return {
      calendarVersionIri: calendar.id,
      businessDate,
      instant: requestedInstantText,
      state: open ? 'open' : 'closed',
      occurrenceVersionIri: occurrence.id,
      appliedExceptionVersionIri: exception?.id || null,
      effectiveStartUtc: effectiveStart,
      effectiveEndUtc: effectiveEnd,
    };
  });
}

function executeI1(graph, query) {
  const normalizedPivot = pivot(query?.pivot, graph);
  const indexes = f1Indexes(graph);
  const valueId = iri(
    query?.isinValueVersionIri,
    'isinValueVersionIri',
    'CQ_I1_ISIN_VALUE',
  );
  const value = indexes.values.get(valueId);
  if (!value) return [];
  if (value.type !== 'ISINValue') fail('CQ_I1_ISIN_VALUE', `${valueId} is not an ISINValue`);
  validateIsin(value.isinLexicalValue, value.id);
  if (!pitEligible(value, normalizedPivot, `ISINValue ${value.id}`)) return [];
  const bindings = [...indexes.assignments.values()]
    .filter((assignment) => assignment.identifierValueVersion === valueId)
    .filter((assignment) => pitEligible(
      assignment,
      normalizedPivot,
      `FinancialIdentifierAssignment ${assignment.id}`,
    ))
    .map((assignment) => {
      const authorizations = [...indexes.authorizations.values()].filter((authorization) => (
        authorization.authorizedSchemeVersion === assignment.identifierSchemeVersion
        && authorization.authorizedAuthorityVersion === assignment.assigningAuthorityVersion
        && authorization.identifierAuthorityRole === 'assigningAuthority'
        && pitEligible(
          authorization,
          normalizedPivot,
          `IdentifierSchemeAuthorization ${authorization.id}`,
        )
      ));
      if (authorizations.length !== 1) {
        fail('CQ_I1_AUTHORIZATION_AMBIGUITY', `${assignment.id} resolves ${authorizations.length} covering authorization versions`);
      }
      return validateAssignmentBinding(graph, indexes, {
        assignmentVersionIri: assignment.id,
        schemeVersionIri: assignment.identifierSchemeVersion,
        valueVersionIri: assignment.identifierValueVersion,
        authorizationVersionIri: authorizations[0].id,
      }, normalizedPivot);
    });
  const subjectLogicalIds = new Set(bindings.map((binding) => binding.subject.logicalId));
  if (subjectLogicalIds.size > 1) {
    fail('CQ_I1_IDENTIFIER_CONFLICT', `${valueId} resolves to multiple Security subjects`);
  }
  const parties = index(graph.parties, 'parties');
  const rows = [];
  for (const binding of bindings) {
    for (const issuance of list(graph.issuances)) {
      if (issuance?.issuedSecurity !== binding.subject.id
          || !pitEligible(issuance, normalizedPivot, `InstrumentIssuance ${String(issuance?.id)}`)) continue;
      const issuer = getExact(
        parties,
        issuance.issuer,
        'CQ_I1_ISSUER_NOT_FOUND',
        'InstrumentIssuance.issuer',
      );
      if (issuer.type !== 'LegalEntity'
          || !pitEligible(issuer, normalizedPivot, `LegalEntity ${issuer.id}`)) {
        fail('CQ_I1_ISSUER_NOT_LEGAL_ENTITY', `${issuer.id} is not an eligible LegalEntity`);
      }
      rows.push({
        isinValueVersionIri: value.id,
        isin: value.isinLexicalValue,
        assignmentVersionIri: binding.assignment.id,
        securityVersionIri: binding.subject.id,
        securityLogicalIri: binding.subject.logicalId,
        issuanceVersionIri: issuance.id,
        issuerVersionIri: issuer.id,
        issuerLogicalIri: issuer.logicalId,
      });
    }
  }
  return rows.sort((left, right) => compareText(left.issuanceVersionIri, right.issuanceVersionIri));
}

function oneEligibleByLogical(records, logicalId, normalizedPivot, label, code) {
  const selected = list(records).filter((record) => (
    record?.logicalId === logicalId && pitEligible(record, normalizedPivot, `${label} ${String(record?.id)}`)
  ));
  if (selected.length > 1) fail(code, `${logicalId} has ${selected.length} PIT-eligible ${label} versions`);
  return selected[0] || null;
}

function executeI2(graph, query) {
  const normalizedPivot = pivot(query?.pivot, graph);
  const businessDate = date(query?.businessDate, 'businessDate');
  const registryAuthority = iri(
    query?.registryAuthorityLogicalIri,
    'registryAuthorityLogicalIri',
    'CQ_I2_REGISTRY_AUTHORITY',
  );
  const listings = index(graph.listings, 'listings');
  const listingId = iri(
    query?.listingVersionIri,
    'listingVersionIri',
    'CQ_I2_LISTING',
  );
  const listing = listings.get(listingId);
  if (!listing
      || !pitEligible(listing, normalizedPivot, `InstrumentListing ${listingId}`)
      || !activeBusinessDate(listing, businessDate)) return [];
  const facilities = index(graph.facilities, 'facilities');
  const instruments = index(graph.instruments, 'instruments');
  const facility = getExact(facilities, listing.facility, 'CQ_I2_FACILITY', 'listing.facility');
  const instrument = getExact(instruments, listing.instrument, 'CQ_I2_INSTRUMENT', 'listing.instrument');
  if (!pitEligible(facility, normalizedPivot, `TradingFacility ${facility.id}`)
      || !pitEligible(instrument, normalizedPivot, `FinancialInstrument ${instrument.id}`)) return [];
  const scheme = oneEligibleByLogical(
    graph.identifierSchemes,
    listing.identifierScheme,
    normalizedPivot,
    'IdentifierScheme',
    'CQ_I2_SCHEME_AMBIGUITY',
  );
  const value = oneEligibleByLogical(
    graph.identifierValues,
    listing.identifierValue,
    normalizedPivot,
    'LocalIdentifierValue',
    'CQ_I2_VALUE_AMBIGUITY',
  );
  if (!scheme || !value || value.schemeLogical !== scheme.logicalId) {
    fail('CQ_I2_LISTING_IDENTIFIER_CHAIN', `${listing.id} lacks its exact direct listing scheme/value chain`);
  }
  const listingAuthorizations = list(graph.identifierAuthorizations).filter((authorization) => (
    authorization?.active === true
    && authorization.schemeVersion === scheme.id
    && authorization.schemeLogical === scheme.logicalId
    && authorization.facilityLogical === facility.logicalId
    && pitEligible(
      authorization,
      normalizedPivot,
      `ListingIdentifierSchemeAuthorization ${String(authorization?.id)}`,
    )
    && (authorization.validTo === undefined
      || (listing.validTo !== undefined
        && instant(
          authorization.validTo,
          `${authorization.id}.validTo`,
          'CQ_FACT_AXES',
        ) >= instant(listing.validTo, `${listing.id}.validTo`, 'CQ_FACT_AXES')))
  ));
  if (listingAuthorizations.length === 0) {
    fail(
      'CQ_I2_SCHEME_AUTHORIZATION_MISSING',
      `${listing.id} lacks a PIT-eligible scheme authorization covering its facility and valid interval`,
    );
  }
  if (listingAuthorizations.length > 1) {
    fail(
      'CQ_I2_SCHEME_AUTHORIZATION_AMBIGUITY',
      `${listing.id} has ${listingAuthorizations.length} PIT-eligible scheme authorizations`,
    );
  }
  const lockedCurrencyRegistry = loadLockedIso4217Registry(SOURCE_TREE_ROOT).entries;
  const registry = list(graph.currencyRegistryEntryVersions).filter((entry) => (
    entry?.iso4217EntryCurrency === listing.quoteCurrency
    && entry.iso4217RegistryAuthority === registryAuthority
    && entry.iso4217EntryStatus === 'active'
    && pitEligible(entry, normalizedPivot, `ISO4217RegistryEntry ${String(entry?.id)}`)
  ));
  for (const entry of registry) {
    const authorityEntry = lockedCurrencyRegistry.get(entry.iso4217AlphaCode);
    if (!authorityEntry
        || authorityEntry.numericCode !== entry.iso4217NumericCode
        || authorityEntry.minorUnit !== entry.iso4217MinorUnit
        || entry.iso4217RegistryAuthority !== 'urn:authority:iso4217'
        || entry.iso4217EntryCurrency
          !== `urn:currency:${entry.iso4217AlphaCode.toLowerCase()}`
        || entry.iso4217RegistrySourceRef
          !== 'https://axiolune.ai/references/six-iso-4217-list-one-2026-01-01'
        || entry.source?.artifactRef?.path
          !== 'reference/authority-reference/six/2026-07-31/iso-4217-list-one/iso-4217-list-one.xml'
        || entry.source?.artifactDigest !== SLICE_SOURCE_EXPECTED.iso4217.rawDigest) {
      fail(
        'CQ_I2_CURRENCY_REGISTRY_AUTHORITY_MISMATCH',
        `${entry.id} does not join the locked ISO 4217 authority snapshot and local Currency identity`,
      );
    }
  }
  if (registry.length === 0) {
    fail('CQ_I2_CURRENCY_REGISTRY_MISSING', `${listing.quoteCurrency} lacks PIT-eligible registry evidence`);
  }
  if (registry.length > 1) {
    fail('CQ_I2_CURRENCY_REGISTRY_AMBIGUITY', `${listing.quoteCurrency} has ${registry.length} PIT-eligible registry entries`);
  }
  const lockedQuantity = loadLockedQuantityRegistry(SOURCE_TREE_ROOT);
  const denominatorBindings = list(graph.quantityUnitRegistry).filter((entry) => {
    const unit = lockedQuantity.registry.units.find((candidate) => (
      candidate.unitIri === entry?.unitIri
    ));
    return entry?.controlled === true
      && unit?.controlled === true
      && list(unit.allowedApplications).includes('directUnitPriceQuotationDenominator')
      && entry.allowedApplication === 'directUnitPriceQuotationDenominator'
      && entry.registryRef
        === 'https://axiolune.ai/references/axiolune-m2-controlled-quantity-units'
      && entry.registryVersion === lockedQuantity.registry.candidateVersion
      && entry.registryCandidateDigest === lockedQuantity.registry.candidateDigest
      && entry.registryArtifactDigest === lockedQuantity.rawDigest
      && entry.decisionStatus === lockedQuantity.registry.decision.status;
  });
  if (denominatorBindings.length !== 1) {
    fail(
      'CQ_I2_QUANTITY_UNIT_REGISTRY',
      `expected one exact digest-locked direct-unit denominator, found ${denominatorBindings.length}`,
    );
  }
  const denominatorUnit = lockedQuantity.registry.units.find((unit) => (
    unit.unitIri === denominatorBindings[0].unitIri
  ));
  const applications = list(graph.marketRuleApplicabilityVersions).filter((application) => (
    application?.scopeListingVersion === listing.id
    && pitEligible(application, normalizedPivot, `RuleApplicability ${String(application?.id)}`)
  ));
  const rules = index(graph.marketRuleVersions, 'marketRuleVersions');
  const clauses = index(graph.ruleClauseVersions, 'ruleClauseVersions');
  const selectedRules = [];
  for (const application of applications) {
    const rule = getExact(
      rules,
      application.applicableRuleVersion,
      'CQ_I2_RULE_NOT_FOUND',
      'application.applicableRuleVersion',
    );
    if (!pitEligible(rule, normalizedPivot, `MarketRule ${rule.id}`)) continue;
    selectedRules.push({ application, rule });
  }
  if (selectedRules.length === 0) return [];
  const tickTerms = [];
  const lotTerms = [];
  for (const selected of selectedRules) {
    for (const clauseId of list(selected.rule.ruleClauseVersions)) {
      const clause = getExact(clauses, clauseId, 'CQ_I2_CLAUSE_NOT_FOUND', 'rule.ruleClauseVersions');
      if (!pitEligible(clause, normalizedPivot, `RuleClause ${clause.id}`)) continue;
      if (selected.rule.type === 'TickScheduleRule'
          && selected.rule.ruleType === 'tickSchedule'
          && clause.type === 'TickSizeClause') {
        tickTerms.push({ ...selected, clause, term: clause.tickSize });
      } else if (selected.rule.type === 'LotScheduleRule'
          && selected.rule.ruleType === 'lotSchedule'
          && clause.type === 'LotSizeClause') {
        lotTerms.push({ ...selected, clause, term: clause.lotSize });
      } else {
        fail('CQ_I2_RULE_CLAUSE_MATRIX', `${selected.rule.id} and ${clause.id} violate the rule/clause subtype matrix`);
      }
    }
  }
  if (tickTerms.length === 0 || lotTerms.length === 0) return [];
  if (tickTerms.length !== 1 || lotTerms.length !== 1) {
    fail('CQ_I2_RULE_AMBIGUITY', `${listing.id} resolves tick=${tickTerms.length}, lot=${lotTerms.length} applicable terms`);
  }
  const [tick] = tickTerms;
  const [lot] = lotTerms;
  for (const [kind, selected] of [['tick', tick], ['lot', lot]]) {
    if (!object(selected.term)
        || !positiveDecimalLexical(selected.term.value)) {
      fail('CQ_I2_RULE_TERMS', `${selected.rule.id} lacks an explicit positive ${kind} decimal Quantity`);
    }
  }
  const expectedTickUnit = `https://axiolune.ai/units/${registry[0].iso4217AlphaCode}-per-${denominatorUnit.notation}`;
  if (lot.term.unit !== denominatorUnit.unitIri
      || tick.term.unit !== expectedTickUnit) {
    fail(
      'CQ_I2_RULE_TERMS',
      `${listing.id} tick/lot units do not derive from its locked quote Currency and denominator unit`,
    );
  }
  const applicationIds = selectedRules.map(({ application }) => application.id).sort(compareText);
  const ruleIds = selectedRules.map(({ rule }) => rule.id).sort(compareText);
  return [{
    listingVersionIri: listing.id,
    listingLogicalIri: listing.logicalId,
    listingIdentifierSchemeLogicalIri: listing.identifierScheme,
    listingIdentifierSchemeVersionIri: scheme.id,
    listingIdentifierValueLogicalIri: listing.identifierValue,
    listingIdentifierValueVersionIri: value.id,
    listingSchemeAuthorizationVersionIri: listingAuthorizations[0].id,
    tradingFacilityVersionIri: facility.id,
    instrumentVersionIri: instrument.id,
    instrumentLogicalIri: instrument.logicalId,
    quoteCurrencyLogicalIri: listing.quoteCurrency,
    currencyRegistryEntryVersionIri: registry[0].id,
    registryAuthorityLogicalIri: registryAuthority,
    ruleApplicabilityVersionIris: applicationIds,
    marketRuleVersionIris: ruleIds,
    tickClauseVersionIri: tick.clause.id,
    lotClauseVersionIri: lot.clause.id,
    tickSize: {
      value: String(tick.term.value),
      unitIri: tick.term.unit,
    },
    lotSize: {
      value: String(lot.term.value),
      unitIri: lot.term.unit,
    },
  }];
}

function executeI3(graph, query) {
  const normalizedPivot = pivot(query?.pivot, graph);
  const instruments = index(graph.instruments, 'instruments');
  const instrumentId = iri(
    query?.instrumentVersionIri,
    'instrumentVersionIri',
    'CQ_I3_INSTRUMENT',
  );
  const instrument = instruments.get(instrumentId);
  if (!instrument || !pitEligible(instrument, normalizedPivot, `FinancialInstrument ${instrumentId}`)) return [];
  if (instrument.type === 'EquityInstrument') {
    fail('CQ_I3_FORBIDDEN_EQUITY_INSTRUMENT', 'EquityInstrument is not a v0.3 classifier');
  }
  if (instrument.type !== 'EquitySecurity') return [];
  return [
    TYPE_IRIS.EquitySecurity,
    TYPE_IRIS.Security,
    TYPE_IRIS.FinancialInstrument,
  ].map((classIri, position) => ({
    instrumentVersionIri: instrument.id,
    instrumentLogicalIri: instrument.logicalId,
    classIri,
    inheritanceDepth: position,
  }));
}

const EXECUTORS = Object.freeze({
  'CQ-F1': executeF1,
  'CQ-F2': executeF2,
  'CQ-MS1': executeMs1,
  'CQ-MS2': executeMs2,
  'CQ-MS3': executeMs3,
  'CQ-I1': executeI1,
  'CQ-I2': executeI2,
  'CQ-I3': executeI3,
});

function executeCq(cqId, graph, query) {
  if (!object(graph)) fail('CQ_GRAPH_ROOT', 'CQ graph must be an object');
  const executor = EXECUTORS[cqId];
  if (!executor) fail('CQ_UNSUPPORTED', `unsupported CQ ${String(cqId)}`);
  return executor(graph, query);
}

module.exports = {
  CQ_FUNCTION_VERSION,
  CqContractError,
  TYPE_IRIS,
  closureAssertionIri,
  compileClosureContext,
  executeCq,
  executeF1,
  executeF2,
  executeI1,
  executeI2,
  executeI3,
  executeMs1,
  executeMs2,
  executeMs3,
  iriSetDigest,
  pitEligible,
  validateIsin,
};
