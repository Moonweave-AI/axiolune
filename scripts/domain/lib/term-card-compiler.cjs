'use strict';

const { TextDecoder } = require('node:util');
const {
  PROFILE_REF,
  PUBLIC_SYMBOL_MANIFEST_TAG,
  PublicSymbolCompilationError,
  artifactDigest,
  compilePublicSymbolManifest,
  sourceKey,
  taggedJcsDigest,
  utf8Compare,
} = require('./public-symbol-compiler.cjs');
const {
  canonicalJcs,
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');
const {
  CANDIDATE_M3_TYPE_IRIS,
  deriveTermCardSemantics,
} = require('./term-card-semantics.cjs');

const TERM_CARD_MANIFEST_TAG = 'axiolune-term-card-manifest-v1\0';
const SOURCE_CITATIONS_TAG = 'axiolune-source-citations-v1\0';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const SEMVER_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;
const REFERENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const GENERATED_KINDS = new Set(['rolePredicate', 'codeMember', 'logicalIdentityClass']);
const CARD_STATUSES = new Set(['draft', 'review', 'accepted', 'rejected']);
const REVIEW_DECISIONS = new Set(['accept', 'reject']);
const CITATION_USAGES = new Set(['normative', 'implementation']);
const CANDIDATE_M3_TYPE_SET = new Set(CANDIDATE_M3_TYPE_IRIS);

class TermCardCompilationError extends Error {
  constructor(errors) {
    super(errors.map((entry) => `${entry.code} ${entry.path}: ${entry.message}`).join('\n'));
    this.name = 'TermCardCompilationError';
    this.errors = errors;
  }
}

function issue(errors, code, path, message) {
  errors.push({ code, path, message });
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateClosed(value, required, optional, path, errors) {
  if (!isPlainObject(value)) {
    issue(errors, 'EXPECTED_CLOSED_OBJECT', path, 'expected a closed object');
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(errors, 'UNKNOWN_FIELD', `${path}.${key}`, 'field is not allowed');
  }
  for (const key of required) {
    if (!own(value, key)) issue(errors, 'MISSING_FIELD', `${path}.${key}`, 'required field is missing');
  }
  return true;
}

function validateNfcString(value, path, errors) {
  if (typeof value !== 'string'
      || value.length === 0
      || value !== value.normalize('NFC')
      || /[\uD800-\uDFFF]/u.test(value)) {
    issue(errors, 'INVALID_NFC_STRING', path, 'expected a non-empty Unicode-NFC string');
    return false;
  }
  return true;
}

function validateSortedNfcStringArray(value, path, errors, emptyCode) {
  if (!Array.isArray(value)) {
    issue(errors, 'INVALID_TERM_SEMANTIC_LIST', path, 'expected an array');
    return false;
  }
  if (value.length === 0) {
    issue(errors, emptyCode, path, 'expected at least one fact-based entry');
    return false;
  }
  let valid = true;
  let previous = null;
  value.forEach((item, index) => {
    if (!validateNfcString(item, `${path}[${index}]`, errors)) valid = false;
    if (typeof item === 'string' && previous !== null && utf8Compare(previous, item) >= 0) {
      issue(
        errors,
        'UNSORTED_OR_DUPLICATE_TERM_SEMANTIC_LIST',
        path,
        'entries must be strictly UTF-8 sorted and unique',
      );
      valid = false;
    }
    if (typeof item === 'string') previous = item;
  });
  return valid;
}

function validateAbsoluteIri(value, path, errors) {
  let valid = typeof value === 'string'
    && value.length > 0
    && value === value.normalize('NFC')
    && !/[\uD800-\uDFFF]/u.test(value)
    && !/[\u0000-\u0020\u007f]/u.test(value);
  if (valid) {
    try {
      const parsed = new URL(value);
      valid = Boolean(parsed.protocol) && parsed.href === value;
    } catch {
      valid = false;
    }
  }
  if (!valid) issue(errors, 'INVALID_ABSOLUTE_IRI', path, 'expected a normalized absolute IRI');
  return valid;
}

function validateDigest(value, path, errors) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    issue(errors, 'INVALID_DIGEST', path, 'expected sha256 followed by 64 lowercase hexadecimal digits');
    return false;
  }
  return true;
}

function validateSemVer(value, path, errors) {
  if (typeof value !== 'string' || !SEMVER_RE.test(value)) {
    issue(errors, 'INVALID_CANONICAL_SEMVER', path, 'expected canonical MAJOR.MINOR.PATCH without leading zeroes or suffixes');
    return false;
  }
  return true;
}

function validateInstant(value, path, errors) {
  const match = typeof value === 'string' ? INSTANT_RE.exec(value) : null;
  if (!match) {
    issue(errors, 'INVALID_INSTANT', path, 'expected RFC 3339 UTC at whole-second precision');
    return false;
  }
  const [, year, month, day, hour, minute, second] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [y, m, d, h, min, s] = parts;
  const instant = new Date(0);
  instant.setUTCFullYear(y, m - 1, d);
  instant.setUTCHours(h, min, s, 0);
  const valid = y >= 1
    && m >= 1 && m <= 12
    && d >= 1 && d <= 31
    && h <= 23 && min <= 59 && s <= 59
    && instant.getUTCFullYear() === y
    && instant.getUTCMonth() === m - 1
    && instant.getUTCDate() === d
    && instant.getUTCHours() === h
    && instant.getUTCMinutes() === min
    && instant.getUTCSeconds() === s;
  if (!valid) issue(errors, 'INVALID_INSTANT', path, 'instant contains an invalid calendar or clock value');
  return valid;
}

function validateArtifactRefInto(value, path, errors, options = {}) {
  const result = validateArtifactRef(value, path);
  for (const message of result.errors) issue(errors, 'INVALID_ARTIFACT_REF', path, message);
  if (result.ok && options.prePayload && value.kind === 'path'
      && !['sourceTree', 'buildEvidence'].includes(value.root)) {
    issue(errors, 'ILLEGAL_ARTIFACT_ROOT', `${path}.root`, 'pre-payload records allow only sourceTree or buildEvidence');
  }
  return result.ok;
}

function artifactRefKey(value) {
  return canonicalJcs(value);
}

function artifactRefSortKey(value) {
  if (isPlainObject(value) && value.kind === 'iri') return `iri\0${value.iri}`;
  if (isPlainObject(value) && value.kind === 'path') return `path\0${value.root}\0${value.path}`;
  throw new Error('cannot derive the canonical sort key of an invalid ArtifactRef');
}

function compareTuple(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const comparison = utf8Compare(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function citationSortTuple(citation) {
  return [
    citation.referenceId,
    artifactRefSortKey(citation.artifactRef),
    citation.artifactDigest,
    canonicalJcs(citation.locator),
    citation.usage,
  ];
}

function citationLocatorTuple(citation) {
  return citationSortTuple(citation).slice(0, 4);
}

function buildReferenceLocatorIndex(referenceClosureManifest, errors) {
  const index = new Map();
  if (!isPlainObject(referenceClosureManifest) || !Array.isArray(referenceClosureManifest.entries)) {
    issue(errors, 'INVALID_REFERENCE_CLOSURE', 'referenceClosureManifest', 'expected a reference closure manifest with entries');
    return index;
  }
  referenceClosureManifest.entries.forEach((entry, entryIndex) => {
    if (!isPlainObject(entry) || typeof entry.referenceId !== 'string'
        || !isPlainObject(entry.artifactRef) || typeof entry.artifactDigest !== 'string'
        || !Array.isArray(entry.locators)) return;
    entry.locators.forEach((locator, locatorIndex) => {
      let key;
      try {
        key = canonicalJcs([
          entry.referenceId,
          entry.artifactRef,
          entry.artifactDigest,
          locator,
        ]);
      } catch (error) {
        issue(
          errors,
          'INVALID_REFERENCE_CLOSURE_LOCATOR',
          `referenceClosureManifest.entries[${entryIndex}].locators[${locatorIndex}]`,
          error.message,
        );
        return;
      }
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ entryIndex, locatorIndex });
    });
  });
  return index;
}

function validateCitation(citation, path, errors, referenceIndex) {
  if (!validateClosed(
    citation,
    ['referenceId', 'artifactRef', 'artifactDigest', 'locator', 'usage'],
    [],
    path,
    errors,
  )) return;
  if (typeof citation.referenceId !== 'string' || !REFERENCE_ID_RE.test(citation.referenceId)) {
    issue(errors, 'INVALID_REFERENCE_ID', `${path}.referenceId`, 'expected a canonical ASCII reference identifier');
  }
  validateArtifactRefInto(citation.artifactRef, `${path}.artifactRef`, errors, { prePayload: true });
  validateDigest(citation.artifactDigest, `${path}.artifactDigest`, errors);
  const locatorResult = validateSourceLocator(citation.locator, { at: `${path}.locator` });
  for (const message of locatorResult.errors) issue(errors, 'INVALID_SOURCE_LOCATOR', `${path}.locator`, message);
  if (!CITATION_USAGES.has(citation.usage)) {
    issue(errors, 'INVALID_CITATION_USAGE', `${path}.usage`, 'expected normative or implementation');
  }
  let key;
  try {
    key = canonicalJcs([
      citation.referenceId,
      citation.artifactRef,
      citation.artifactDigest,
      citation.locator,
    ]);
  } catch (error) {
    issue(errors, 'INVALID_CITATION_JOIN_KEY', path, error.message);
    return;
  }
  const matches = referenceIndex instanceof Map ? (referenceIndex.get(key) || []) : [];
  if (matches.length !== 1) {
    issue(
      errors,
      matches.length === 0 ? 'UNRESOLVED_SOURCE_CITATION' : 'AMBIGUOUS_SOURCE_CITATION',
      path,
      `citation must join exactly one locked reference locator; found ${matches.length}`,
    );
  }
}

function validateCitations(citations, path, errors, referenceIndex) {
  if (!Array.isArray(citations) || citations.length === 0) {
    issue(errors, 'EMPTY_SOURCE_CITATIONS', path, 'sourceCitations must be a non-empty array');
    return;
  }
  let previousComplete = null;
  const locatorKeys = new Set();
  citations.forEach((citation, index) => {
    const citationPath = `${path}[${index}]`;
    validateCitation(citation, citationPath, errors, referenceIndex);
    if (!isPlainObject(citation)) return;
    try {
      const complete = citationSortTuple(citation);
      if (previousComplete !== null && compareTuple(previousComplete, complete) >= 0) {
        issue(
          errors,
          'UNSORTED_OR_DUPLICATE_SOURCE_CITATION',
          citationPath,
          'citations must be strictly sorted and unique by the RFC tuple',
        );
      }
      previousComplete = complete;
      const locatorKey = canonicalJcs(citationLocatorTuple(citation));
      if (locatorKeys.has(locatorKey)) {
        issue(
          errors,
          'DUPLICATE_CITATION_LOCATOR',
          citationPath,
          'the same locked locator cannot be cited twice or dual-labelled',
        );
      }
      locatorKeys.add(locatorKey);
    } catch (error) {
      issue(errors, 'INVALID_CITATION_SORT_KEY', citationPath, error.message);
    }
  });
}

function validateDirectTermCardSourceRecord(record, path, errors, referenceIndex) {
  if (!validateClosed(
    record,
    [
      'schemaVersion', 'publicIri', 'version', 'status', 'preferredLabel',
      'definition', 'definitionDigest', 'genus', 'differentia', 'excludes',
      'candidateM3Type', 'ownerRef', 'sourceCitations',
    ],
    [],
    path,
    errors,
  )) return;
  if (record.schemaVersion !== '1.0') issue(errors, 'SCHEMA_VERSION_MISMATCH', `${path}.schemaVersion`, 'expected "1.0"');
  validateAbsoluteIri(record.publicIri, `${path}.publicIri`, errors);
  validateSemVer(record.version, `${path}.version`, errors);
  if (!CARD_STATUSES.has(record.status)) issue(errors, 'INVALID_CARD_STATUS', `${path}.status`, 'unsupported card status');
  validateNfcString(record.preferredLabel, `${path}.preferredLabel`, errors);
  validateNfcString(record.genus, `${path}.genus`, errors);
  validateSortedNfcStringArray(
    record.differentia,
    `${path}.differentia`,
    errors,
    'EMPTY_DIFFERENTIA',
  );
  validateSortedNfcStringArray(
    record.excludes,
    `${path}.excludes`,
    errors,
    'EMPTY_EXCLUDES',
  );
  if (validateAbsoluteIri(record.candidateM3Type, `${path}.candidateM3Type`, errors)
      && !CANDIDATE_M3_TYPE_SET.has(record.candidateM3Type)) {
    issue(
      errors,
      'INVALID_CANDIDATE_M3_TYPE',
      `${path}.candidateM3Type`,
      'expected one canonical M3 term-definition IRI',
    );
  }
  const validDefinition = validateNfcString(record.definition, `${path}.definition`, errors);
  validateDigest(record.definitionDigest, `${path}.definitionDigest`, errors);
  if (validDefinition) {
    const expected = artifactDigest(Buffer.from(record.definition, 'utf8'));
    if (record.definitionDigest !== expected) {
      issue(errors, 'DEFINITION_DIGEST_MISMATCH', `${path}.definitionDigest`, `expected ${expected}`);
    }
  }
  validateAbsoluteIri(record.ownerRef, `${path}.ownerRef`, errors);
  validateCitations(record.sourceCitations, `${path}.sourceCitations`, errors, referenceIndex);
}

function validateTermReviewDecisionRecord(record, path, errors) {
  if (!validateClosed(
    record,
    [
      'schemaVersion', 'publicIri', 'cardRef', 'cardDigest', 'reviewedVersion',
      'reviewedDefinitionDigest', 'sourceCitationsDigest', 'decision',
      'reviewerRef', 'decisionTime', 'rationale',
    ],
    [],
    path,
    errors,
  )) return;
  if (record.schemaVersion !== '1.0') issue(errors, 'SCHEMA_VERSION_MISMATCH', `${path}.schemaVersion`, 'expected "1.0"');
  validateAbsoluteIri(record.publicIri, `${path}.publicIri`, errors);
  validateArtifactRefInto(record.cardRef, `${path}.cardRef`, errors, { prePayload: true });
  validateDigest(record.cardDigest, `${path}.cardDigest`, errors);
  validateSemVer(record.reviewedVersion, `${path}.reviewedVersion`, errors);
  validateDigest(record.reviewedDefinitionDigest, `${path}.reviewedDefinitionDigest`, errors);
  validateDigest(record.sourceCitationsDigest, `${path}.sourceCitationsDigest`, errors);
  if (!REVIEW_DECISIONS.has(record.decision)) issue(errors, 'INVALID_REVIEW_DECISION', `${path}.decision`, 'expected accept or reject');
  validateAbsoluteIri(record.reviewerRef, `${path}.reviewerRef`, errors);
  validateInstant(record.decisionTime, `${path}.decisionTime`, errors);
  validateNfcString(record.rationale, `${path}.rationale`, errors);
}

function validateGeneratedInheritanceRecord(record, path, errors) {
  if (!validateClosed(
    record,
    [
      'schemaVersion', 'generatedIri', 'generatedKind', 'sourceElementKey',
      'inheritedDefinitionDigest', 'ownerRef', 'sourceCardRef', 'sourceCardDigest',
      'sourceCitationsDigest', 'reviewRecordRef', 'reviewRecordDigest',
      'generationRuleRef', 'generationRuleDigest',
    ],
    [],
    path,
    errors,
  )) return;
  if (record.schemaVersion !== '1.0') issue(errors, 'SCHEMA_VERSION_MISMATCH', `${path}.schemaVersion`, 'expected "1.0"');
  validateAbsoluteIri(record.generatedIri, `${path}.generatedIri`, errors);
  if (!GENERATED_KINDS.has(record.generatedKind)) issue(errors, 'INVALID_GENERATED_KIND', `${path}.generatedKind`, 'unsupported generated kind');
  validateDigest(record.sourceElementKey, `${path}.sourceElementKey`, errors);
  validateDigest(record.inheritedDefinitionDigest, `${path}.inheritedDefinitionDigest`, errors);
  validateAbsoluteIri(record.ownerRef, `${path}.ownerRef`, errors);
  validateArtifactRefInto(record.sourceCardRef, `${path}.sourceCardRef`, errors, { prePayload: true });
  validateDigest(record.sourceCardDigest, `${path}.sourceCardDigest`, errors);
  validateDigest(record.sourceCitationsDigest, `${path}.sourceCitationsDigest`, errors);
  validateArtifactRefInto(record.reviewRecordRef, `${path}.reviewRecordRef`, errors, { prePayload: true });
  validateDigest(record.reviewRecordDigest, `${path}.reviewRecordDigest`, errors);
  validateArtifactRefInto(record.generationRuleRef, `${path}.generationRuleRef`, errors, { prePayload: true });
  validateDigest(record.generationRuleDigest, `${path}.generationRuleDigest`, errors);
}

function parseCanonicalJsonArtifact(envelope, path, errors, validator, validatorContext) {
  if (!validateClosed(envelope, ['artifactRef', 'bytes'], [], path, errors)) return null;
  validateArtifactRefInto(envelope.artifactRef, `${path}.artifactRef`, errors, { prePayload: true });
  if (!Buffer.isBuffer(envelope.bytes)) {
    issue(errors, 'INVALID_ARTIFACT_BYTES', `${path}.bytes`, 'artifact bytes must be a Buffer');
    return null;
  }
  const bytes = envelope.bytes;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    issue(errors, 'NON_CANONICAL_ARTIFACT_BYTES', `${path}.bytes`, 'UTF-8 BOM is forbidden');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    issue(errors, 'INVALID_UTF8_ARTIFACT', `${path}.bytes`, error.message);
    return null;
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    issue(errors, 'INVALID_JSON_ARTIFACT', `${path}.bytes`, error.message);
    return null;
  }
  try {
    const expected = Buffer.from(canonicalJcs(record), 'utf8');
    if (!bytes.equals(expected)) {
      issue(
        errors,
        'NON_CANONICAL_ARTIFACT_BYTES',
        `${path}.bytes`,
        'artifact must be exact UTF-8 JCS bytes with no BOM, whitespace, or trailing newline',
      );
    }
  } catch (error) {
    issue(errors, 'JCS_CANONICALIZATION_FAILED', `${path}.bytes`, error.message);
  }
  validator(record, `${path}.record`, errors, validatorContext);
  let refKey = null;
  try {
    refKey = artifactRefKey(envelope.artifactRef);
  } catch (error) {
    issue(errors, 'INVALID_ARTIFACT_REF_KEY', `${path}.artifactRef`, error.message);
  }
  return {
    artifactRef: envelope.artifactRef,
    bytes,
    digest: artifactDigest(bytes),
    record,
    refKey,
  };
}

function parseArbitraryArtifact(envelope, path, errors) {
  if (!validateClosed(envelope, ['artifactRef', 'bytes'], [], path, errors)) return null;
  validateArtifactRefInto(envelope.artifactRef, `${path}.artifactRef`, errors, { prePayload: true });
  if (!Buffer.isBuffer(envelope.bytes) || envelope.bytes.length === 0) {
    issue(errors, 'INVALID_ARTIFACT_BYTES', `${path}.bytes`, 'generation-rule bytes must be a non-empty Buffer');
    return null;
  }
  let refKey = null;
  try {
    refKey = artifactRefKey(envelope.artifactRef);
  } catch (error) {
    issue(errors, 'INVALID_ARTIFACT_REF_KEY', `${path}.artifactRef`, error.message);
  }
  return {
    artifactRef: envelope.artifactRef,
    bytes: envelope.bytes,
    digest: artifactDigest(envelope.bytes),
    refKey,
  };
}

function validatePublicSymbolManifest(record, path, errors) {
  if (!validateClosed(record, ['schemaVersion', 'profileRef', 'symbols'], [], path, errors)) return;
  if (record.schemaVersion !== '1.0') issue(errors, 'SCHEMA_VERSION_MISMATCH', `${path}.schemaVersion`, 'expected "1.0"');
  validateAbsoluteIri(record.profileRef, `${path}.profileRef`, errors);
  if (!Array.isArray(record.symbols) || record.symbols.length === 0) {
    issue(errors, 'EMPTY_PUBLIC_SYMBOL_MANIFEST', `${path}.symbols`, 'symbols must be a non-empty array');
    return;
  }
  let previous = null;
  const sourceKeys = new Set();
  record.symbols.forEach((symbol, index) => {
    const symbolPath = `${path}.symbols[${index}]`;
    if (!isPlainObject(symbol)) {
      issue(errors, 'EXPECTED_CLOSED_OBJECT', symbolPath, 'expected a closed symbol object');
      return;
    }
    const isGenerated = symbol.origin === 'generated';
    validateClosed(
      symbol,
      isGenerated
        ? ['publicIri', 'origin', 'ownerModule', 'sourceElementKey', 'generatedKind']
        : ['publicIri', 'origin', 'ownerModule', 'sourceElementKey'],
      [],
      symbolPath,
      errors,
    );
    validateAbsoluteIri(symbol.publicIri, `${symbolPath}.publicIri`, errors);
    if (!['authored', 'generated'].includes(symbol.origin)) issue(errors, 'INVALID_SYMBOL_ORIGIN', `${symbolPath}.origin`, 'expected authored or generated');
    validateAbsoluteIri(symbol.ownerModule, `${symbolPath}.ownerModule`, errors);
    validateDigest(symbol.sourceElementKey, `${symbolPath}.sourceElementKey`, errors);
    if (isGenerated && !GENERATED_KINDS.has(symbol.generatedKind)) issue(errors, 'INVALID_GENERATED_KIND', `${symbolPath}.generatedKind`, 'unsupported generated kind');
    if (previous !== null && utf8Compare(previous, symbol.publicIri) >= 0) {
      issue(errors, 'UNSORTED_OR_DUPLICATE_PUBLIC_SYMBOL', symbolPath, 'symbols must be strictly publicIri-sorted and unique');
    }
    previous = symbol.publicIri;
    if (sourceKeys.has(symbol.sourceElementKey)) issue(errors, 'DUPLICATE_PUBLIC_SOURCE_KEY', symbolPath, 'sourceElementKey must be unique');
    sourceKeys.add(symbol.sourceElementKey);
  });
}

function parseArtifactArray(values, path, errors, parser, ...parserArgs) {
  if (!Array.isArray(values)) {
    issue(errors, 'INVALID_ARTIFACT_INVENTORY', path, 'expected an artifact array');
    return [];
  }
  const parsed = [];
  const refs = new Set();
  values.forEach((value, index) => {
    const artifact = parser(value, `${path}[${index}]`, errors, ...parserArgs);
    if (!artifact) return;
    if (artifact.refKey !== null && refs.has(artifact.refKey)) {
      issue(errors, 'DUPLICATE_ARTIFACT_REF', `${path}[${index}].artifactRef`, 'artifact ref must be unique in its inventory');
    }
    if (artifact.refKey !== null) refs.add(artifact.refKey);
    parsed.push(artifact);
  });
  return parsed;
}

function validateCrossInventoryArtifactRefs(inventories, errors) {
  const seen = new Map();
  for (const [inventoryName, artifacts] of inventories) {
    for (const artifact of artifacts) {
      if (artifact.refKey === null) continue;
      const prior = seen.get(artifact.refKey);
      if (prior) {
        issue(
          errors,
          'CROSS_INVENTORY_ARTIFACT_REF',
          `${inventoryName}(${artifact.refKey})`,
          `ArtifactRef is already used by ${prior}; one ref cannot resolve multiple artifact roles`,
        );
      } else {
        seen.set(artifact.refKey, inventoryName);
      }
    }
  }
}

function buildAuthoredSourceIndex(moduleDocs, publicSymbols, errors) {
  const index = new Map();
  const containers = [
    'objectTypes',
    'associationTypes',
    'relationTypes',
    'attributeTypes',
    'identifierTypes',
    'codeLists',
    'constraints',
  ];
  moduleDocs.forEach((doc, moduleIndex) => {
    const modulePath = `moduleDocs[${moduleIndex}]`;
    if (!isPlainObject(doc) || !isPlainObject(doc.module) || !isPlainObject(doc.domain)) {
      issue(errors, 'INVALID_MODULE_SOURCE', modulePath, 'expected a module/domain object');
      return;
    }
    const version = doc.module.version;
    const ownerRef = doc.module.governance?.ownerRef;
    validateSemVer(version, `${modulePath}.module.version`, errors);
    validateAbsoluteIri(ownerRef, `${modulePath}.module.governance.ownerRef`, errors);
    for (const containerName of containers) {
      const container = doc.domain[containerName];
      if (container === undefined) continue;
      if (!isPlainObject(container)) {
        issue(
          errors,
          'INVALID_MODULE_SOURCE_CONTAINER',
          `${modulePath}.domain.${containerName}`,
          'expected an object map',
        );
        continue;
      }
      for (const [localName, element] of Object.entries(container)) {
        const at = `${modulePath}.domain.${containerName}.${localName}`;
        if (!isPlainObject(element) || typeof element.iri !== 'string') continue;
        const symbol = publicSymbols.get(element.iri);
        if (!symbol || symbol.origin !== 'authored') continue;
        if (index.has(element.iri)) {
          issue(
            errors,
            'DUPLICATE_AUTHORED_CARD_SOURCE',
            at,
            'authored public IRI resolves to more than one module source',
          );
          continue;
        }
        validateNfcString(element.label, `${at}.label`, errors);
        validateNfcString(element.definition, `${at}.definition`, errors);
        let termSemantics;
        try {
          termSemantics = deriveTermCardSemantics(containerName, element);
        } catch (error) {
          issue(errors, 'TERM_SEMANTICS_DERIVATION_FAILED', at, error.message);
          continue;
        }
        index.set(element.iri, {
          ...termSemantics,
          definition: element.definition,
          definitionDigest: typeof element.definition === 'string'
            ? artifactDigest(Buffer.from(element.definition, 'utf8'))
            : null,
          ownerRef,
          preferredLabel: element.label,
          publicIri: element.iri,
          version,
        });
      }
    }
  });
  for (const symbol of publicSymbols.values()) {
    if (symbol.origin === 'authored' && !index.has(symbol.publicIri)) {
      issue(
        errors,
        'MISSING_AUTHORED_CARD_SOURCE',
        `publicSymbol(${symbol.publicIri})`,
        'authored public symbol does not resolve to one normalized module source',
      );
    }
  }
  return index;
}

function buildGeneratedSourceIndex(moduleDocs, errors) {
  const index = new Map();
  if (!Array.isArray(moduleDocs) || moduleDocs.length === 0) {
    issue(errors, 'EMPTY_MODULE_SET', 'moduleDocs', 'expected a non-empty normalized module list');
    return index;
  }

  function add(source, path) {
    if (!validateNfcString(source.definition, `${path}.definition`, errors)) return;
    if (index.has(source.sourceElementKey)) {
      issue(errors, 'DUPLICATE_GENERATED_SOURCE_KEY', path, 'generated source key is not unique in normalized IR');
      return;
    }
    index.set(source.sourceElementKey, source);
  }

  moduleDocs.forEach((doc, moduleIndex) => {
    const path = `moduleDocs[${moduleIndex}]`;
    if (!isPlainObject(doc) || !isPlainObject(doc.module) || !isPlainObject(doc.domain)) {
      issue(errors, 'INVALID_MODULE', path, 'expected a module/domain object');
      return;
    }
    const ownerModule = doc.module.moduleIri;
    validateAbsoluteIri(ownerModule, `${path}.module.moduleIri`, errors);
    if (!Array.isArray(doc.module.exports)) {
      issue(errors, 'INVALID_EXPORTS', `${path}.module.exports`, 'expected an exports array');
      return;
    }
    const exports = new Set(doc.module.exports);
    const all = exports.size === 0;
    const selected = (element) => isPlainObject(element)
      && typeof element.iri === 'string'
      && (all || exports.has(element.iri));

    for (const containerKind of ['objectTypes', 'associationTypes']) {
      const container = doc.domain[containerKind] || {};
      if (!isPlainObject(container)) continue;
      for (const [name, element] of Object.entries(container)) {
        if (!selected(element)) continue;
        const elementPath = `${path}.domain.${containerKind}.${name}`;
        if (element.abstract !== true) {
          const tuple = { kind: 'logicalIdentityClass', typeIri: element.iri };
          let key;
          try {
            key = sourceKey(tuple);
          } catch (error) {
            issue(errors, 'INVALID_GENERATED_SOURCE_TUPLE', elementPath, error.message);
            continue;
          }
          add({
            generatedIri: `${element.iri}/LogicalIdentity`,
            generatedKind: 'logicalIdentityClass',
            sourceElementKey: key,
            sourcePublicIri: element.iri,
            ownerModule,
            definition: element.definition,
            sourceTuple: tuple,
          }, `${elementPath}#logicalIdentityClass`);
        }
        if (containerKind === 'associationTypes') {
          if (!Array.isArray(element.participantRoles)) {
            issue(errors, 'INVALID_PARTICIPANT_ROLES', `${elementPath}.participantRoles`, 'expected an array');
            continue;
          }
          element.participantRoles.forEach((role, roleIndex) => {
            const rolePath = `${elementPath}.participantRoles[${roleIndex}]`;
            if (!isPlainObject(role) || typeof role.id !== 'string') {
              issue(errors, 'INVALID_PARTICIPANT_ROLE', rolePath, 'expected a role with an id');
              return;
            }
            const roleTuple = {
              kind: 'participantRole',
              containingType: element.iri,
              roleId: role.id,
            };
            let roleKey;
            try {
              roleKey = sourceKey(roleTuple);
            } catch (error) {
              issue(errors, 'INVALID_GENERATED_SOURCE_TUPLE', rolePath, error.message);
              return;
            }
            add({
              generatedIri: `${element.iri}/role/${role.id}`,
              generatedKind: 'rolePredicate',
              sourceElementKey: roleKey,
              sourcePublicIri: element.iri,
              ownerModule,
              definition: role.definition,
              sourceTuple: roleTuple,
            }, rolePath);
          });
        }
      }
    }

    const codeLists = doc.domain.codeLists || {};
    if (isPlainObject(codeLists)) {
      for (const [name, codeList] of Object.entries(codeLists)) {
        if (!selected(codeList)) continue;
        const codePath = `${path}.domain.codeLists.${name}`;
        if (!Array.isArray(codeList.values)) {
          issue(errors, 'INVALID_CODE_VALUES', `${codePath}.values`, 'expected an array');
          continue;
        }
        codeList.values.forEach((value, valueIndex) => {
          const valuePath = `${codePath}.values[${valueIndex}]`;
          if (!isPlainObject(value) || typeof value.iri !== 'string') {
            issue(errors, 'INVALID_CODE_VALUE', valuePath, 'expected a code value with an IRI');
            return;
          }
          const tuple = {
            kind: 'codeValue',
            codeListIri: codeList.iri,
            codeValueIri: value.iri,
          };
          let key;
          try {
            key = sourceKey(tuple);
          } catch (error) {
            issue(errors, 'INVALID_GENERATED_SOURCE_TUPLE', valuePath, error.message);
            return;
          }
          add({
            generatedIri: value.iri,
            generatedKind: 'codeMember',
            sourceElementKey: key,
            sourcePublicIri: codeList.iri,
            ownerModule,
            definition: value.definition,
            sourceTuple: tuple,
          }, valuePath);
        });
      }
    }
  });
  return index;
}

function joinReviewToCard(card, reviews, usedReviews, errors) {
  const matches = reviews.filter((review) => {
    if (!review.record || !review.refKey) return false;
    let cardKey;
    try {
      cardKey = artifactRefKey(review.record.cardRef);
    } catch {
      return false;
    }
    return cardKey === card.refKey && review.record.cardDigest === card.digest;
  });
  if (matches.length !== 1) {
    issue(
      errors,
      matches.length === 0 ? 'MISSING_CARD_REVIEW' : 'AMBIGUOUS_CARD_REVIEW',
      `card(${card.record.publicIri})`,
      `card must resolve exactly one review record; found ${matches.length}`,
    );
    return null;
  }
  const review = matches[0];
  usedReviews.add(review.refKey);
  const record = review.record;
  const citationsDigest = taggedJcsDigest(SOURCE_CITATIONS_TAG, card.record.sourceCitations);
  const exact = [
    ['publicIri', card.record.publicIri],
    ['reviewedVersion', card.record.version],
    ['reviewedDefinitionDigest', card.record.definitionDigest],
    ['sourceCitationsDigest', citationsDigest],
  ];
  exact.forEach(([field, expected]) => {
    if (record[field] !== expected) issue(errors, 'STALE_OR_UNRELATED_REVIEW', `review(${card.record.publicIri}).${field}`, `expected ${expected}`);
  });
  if (card.record.status === 'accepted' && record.decision !== 'accept') {
    issue(errors, 'CARD_REVIEW_DECISION_MISMATCH', `card(${card.record.publicIri}).status`, 'accepted requires an accept review');
  }
  if (card.record.status === 'rejected' && record.decision !== 'reject') {
    issue(errors, 'CARD_REVIEW_DECISION_MISMATCH', `card(${card.record.publicIri}).status`, 'rejected requires a reject review');
  }
  return { artifact: review, citationsDigest };
}

function validateInputEnvelope(input, errors) {
  return validateClosed(
    input,
    [
      'profileRef', 'publicSymbolManifestArtifact', 'referenceClosureManifest',
      'moduleDocs', 'cardArtifacts', 'reviewArtifacts', 'inheritanceArtifacts',
      'generationRuleArtifacts',
    ],
    [],
    'input',
    errors,
  );
}

function compileTermCardManifest(input, options = {}) {
  const errors = [];
  if (!validateInputEnvelope(input, errors)) throw new TermCardCompilationError(errors);
  validateAbsoluteIri(input.profileRef, 'input.profileRef', errors);
  const referenceIndex = buildReferenceLocatorIndex(input.referenceClosureManifest, errors);
  const publicArtifact = parseCanonicalJsonArtifact(
    input.publicSymbolManifestArtifact,
    'input.publicSymbolManifestArtifact',
    errors,
    validatePublicSymbolManifest,
  );
  const generatedSources = buildGeneratedSourceIndex(input.moduleDocs, errors);

  let expectedPublicManifest = null;
  try {
    expectedPublicManifest = compilePublicSymbolManifest(input.moduleDocs, { profileRef: input.profileRef }).manifest;
  } catch (error) {
    if (error instanceof PublicSymbolCompilationError) {
      for (const entry of error.errors) issue(errors, `PUBLIC_${entry.code}`, entry.path, entry.message);
    } else {
      throw error;
    }
  }
  if (publicArtifact) {
    if (publicArtifact.record.profileRef !== input.profileRef) {
      issue(errors, 'PUBLIC_SYMBOL_PROFILE_MISMATCH', 'input.publicSymbolManifestArtifact.record.profileRef', 'profileRef must equal compilation profileRef');
    }
    if (expectedPublicManifest) {
      try {
        if (canonicalJcs(publicArtifact.record) !== canonicalJcs(expectedPublicManifest)) {
          issue(errors, 'PUBLIC_SYMBOL_MANIFEST_DRIFT', 'input.publicSymbolManifestArtifact', 'artifact is not the exact compiler projection of moduleDocs');
        }
      } catch (error) {
        issue(errors, 'JCS_CANONICALIZATION_FAILED', 'input.publicSymbolManifestArtifact', error.message);
      }
    }
  }

  const cards = parseArtifactArray(
    input.cardArtifacts,
    'input.cardArtifacts',
    errors,
    parseCanonicalJsonArtifact,
    validateDirectTermCardSourceRecord,
    referenceIndex,
  );
  const reviews = parseArtifactArray(
    input.reviewArtifacts,
    'input.reviewArtifacts',
    errors,
    parseCanonicalJsonArtifact,
    validateTermReviewDecisionRecord,
  );
  const inheritances = parseArtifactArray(
    input.inheritanceArtifacts,
    'input.inheritanceArtifacts',
    errors,
    parseCanonicalJsonArtifact,
    validateGeneratedInheritanceRecord,
  );
  const generationRules = parseArtifactArray(
    input.generationRuleArtifacts,
    'input.generationRuleArtifacts',
    errors,
    parseArbitraryArtifact,
  );
  validateCrossInventoryArtifactRefs([
    ['cardArtifacts', cards],
    ['reviewArtifacts', reviews],
    ['inheritanceArtifacts', inheritances],
    ['generationRuleArtifacts', generationRules],
  ], errors);

  const publicSymbols = new Map();
  if (publicArtifact && Array.isArray(publicArtifact.record.symbols)) {
    for (const symbol of publicArtifact.record.symbols) {
      if (isPlainObject(symbol) && typeof symbol.publicIri === 'string') publicSymbols.set(symbol.publicIri, symbol);
    }
  }
  const authoredSources = buildAuthoredSourceIndex(input.moduleDocs, publicSymbols, errors);
  const cardByIri = new Map();
  const directEntries = [];
  const usedReviews = new Set();
  cards.forEach((card) => {
    if (!isPlainObject(card.record) || typeof card.record.publicIri !== 'string') return;
    if (cardByIri.has(card.record.publicIri)) {
      issue(errors, 'DUPLICATE_CARD_PUBLIC_IRI', `card(${card.record.publicIri})`, 'direct card public IRI must be unique');
      return;
    }
    cardByIri.set(card.record.publicIri, card);
    const symbol = publicSymbols.get(card.record.publicIri);
    if (!symbol || symbol.origin !== 'authored') {
      issue(errors, 'ORPHAN_DIRECT_CARD', `card(${card.record.publicIri})`, 'card must select exactly one authored public symbol');
    } else {
      const source = authoredSources.get(card.record.publicIri);
      if (!source) {
        issue(
          errors,
          'MISSING_AUTHORED_CARD_SOURCE',
          `card(${card.record.publicIri})`,
          'card cannot resolve its normalized module source',
        );
      } else {
        for (const field of [
          'publicIri',
          'version',
          'preferredLabel',
          'definition',
          'definitionDigest',
          'genus',
          'candidateM3Type',
          'ownerRef',
        ]) {
          if (card.record[field] !== source[field]) {
            issue(
              errors,
              'DIRECT_CARD_SOURCE_DRIFT',
              `card(${card.record.publicIri}).${field}`,
              `expected exact normalized module value ${String(source[field])}`,
            );
          }
        }
        for (const field of ['differentia', 'excludes']) {
          if (Array.isArray(card.record[field])
              && canonicalJcs(card.record[field]) !== canonicalJcs(source[field])) {
            issue(
              errors,
              'DIRECT_CARD_SOURCE_DRIFT',
              `card(${card.record.publicIri}).${field}`,
              `expected exact fact-derived normalized module value ${canonicalJcs(source[field])}`,
            );
          }
        }
      }
    }
    const reviewJoin = joinReviewToCard(card, reviews, usedReviews, errors);
    if (options.requireAccepted !== false && card.record.status !== 'accepted') {
      issue(errors, 'NON_RELEASE_CARD_STATUS', `card(${card.record.publicIri}).status`, 'release compilation requires accepted status');
    }
    if (reviewJoin) {
      const review = reviewJoin.artifact;
      directEntries.push({
        publicIri: card.record.publicIri,
        cardRef: card.artifactRef,
        cardDigest: card.digest,
        version: card.record.version,
        status: card.record.status,
        preferredLabel: card.record.preferredLabel,
        definition: card.record.definition,
        definitionDigest: card.record.definitionDigest,
        genus: card.record.genus,
        differentia: card.record.differentia,
        excludes: card.record.excludes,
        candidateM3Type: card.record.candidateM3Type,
        ownerRef: card.record.ownerRef,
        sourceCitations: card.record.sourceCitations,
        review: {
          decision: review.record.decision,
          reviewerRef: review.record.reviewerRef,
          decisionTime: review.record.decisionTime,
          rationale: review.record.rationale,
          reviewRecordRef: review.artifactRef,
          reviewRecordDigest: review.digest,
        },
      });
      card.reviewJoin = reviewJoin;
    }
  });
  for (const review of reviews) {
    if (review.refKey && !usedReviews.has(review.refKey)) {
      issue(errors, 'ORPHAN_REVIEW_RECORD', `review(${review.record && review.record.publicIri})`, 'review does not bind exactly one card artifact');
    }
  }
  for (const symbol of publicSymbols.values()) {
    if (symbol.origin === 'authored' && !cardByIri.has(symbol.publicIri)) {
      issue(errors, 'MISSING_DIRECT_TERM_CARD', `publicSymbol(${symbol.publicIri})`, 'authored public symbol lacks a direct card');
    }
  }

  const ruleByRef = new Map(generationRules.filter((rule) => rule.refKey).map((rule) => [rule.refKey, rule]));
  const usedRules = new Set();
  const inheritanceByIri = new Map();
  const generatedEntries = [];
  inheritances.forEach((inheritance) => {
    const record = inheritance.record;
    if (!isPlainObject(record) || typeof record.generatedIri !== 'string') return;
    if (inheritanceByIri.has(record.generatedIri)) {
      issue(errors, 'DUPLICATE_GENERATED_INHERITANCE', `inheritance(${record.generatedIri})`, 'generated IRI must be unique');
      return;
    }
    inheritanceByIri.set(record.generatedIri, inheritance);
    const symbol = publicSymbols.get(record.generatedIri);
    if (!symbol || symbol.origin !== 'generated') {
      issue(errors, 'ORPHAN_GENERATED_INHERITANCE', `inheritance(${record.generatedIri})`, 'inheritance must select exactly one generated public symbol');
      return;
    }
    for (const field of ['generatedKind', 'sourceElementKey']) {
      if (record[field] !== symbol[field]) issue(errors, 'GENERATED_SYMBOL_JOIN_MISMATCH', `inheritance(${record.generatedIri}).${field}`, `expected ${symbol[field]}`);
    }
    const source = generatedSources.get(record.sourceElementKey);
    if (!source) {
      issue(errors, 'UNRESOLVED_GENERATED_SOURCE', `inheritance(${record.generatedIri}).sourceElementKey`, 'sourceElementKey does not resolve in normalized IR');
      return;
    }
    if (source.generatedIri !== record.generatedIri
        || source.generatedKind !== record.generatedKind
        || source.ownerModule !== symbol.ownerModule) {
      issue(errors, 'GENERATED_SOURCE_JOIN_MISMATCH', `inheritance(${record.generatedIri})`, 'normalized source tuple does not reproduce the public symbol');
    }
    const sourceCard = cardByIri.get(source.sourcePublicIri);
    if (!sourceCard || !sourceCard.reviewJoin) {
      issue(errors, 'MISSING_SOURCE_CARD_BINDING', `inheritance(${record.generatedIri})`, `source card ${source.sourcePublicIri} is unavailable`);
      return;
    }
    const sourceReview = sourceCard.reviewJoin.artifact;
    if (sourceCard.record.status !== 'accepted' || sourceReview.record.decision !== 'accept') {
      issue(errors, 'SOURCE_CARD_NOT_ACCEPTED', `inheritance(${record.generatedIri})`, 'generated inheritance requires an accepted source card and accept review');
    }
    const expectedFields = {
      inheritedDefinitionDigest: artifactDigest(Buffer.from(source.definition, 'utf8')),
      ownerRef: sourceCard.record.ownerRef,
      sourceCardDigest: sourceCard.digest,
      sourceCitationsDigest: sourceCard.reviewJoin.citationsDigest,
      reviewRecordDigest: sourceReview.digest,
    };
    for (const [field, expected] of Object.entries(expectedFields)) {
      if (record[field] !== expected) issue(errors, 'INHERITED_FIELD_DRIFT', `inheritance(${record.generatedIri}).${field}`, `expected ${expected}`);
    }
    try {
      if (artifactRefKey(record.sourceCardRef) !== sourceCard.refKey) {
        issue(errors, 'SOURCE_CARD_REF_MISMATCH', `inheritance(${record.generatedIri}).sourceCardRef`, 'must resolve the exact source card');
      }
      if (artifactRefKey(record.reviewRecordRef) !== sourceReview.refKey) {
        issue(errors, 'REVIEW_RECORD_REF_MISMATCH', `inheritance(${record.generatedIri}).reviewRecordRef`, 'must resolve the exact source review');
      }
    } catch (error) {
      issue(errors, 'INVALID_INHERITANCE_REF', `inheritance(${record.generatedIri})`, error.message);
    }

    let rule = null;
    try {
      rule = ruleByRef.get(artifactRefKey(record.generationRuleRef));
    } catch {
      rule = null;
    }
    if (!rule) {
      issue(errors, 'MISSING_GENERATION_RULE', `inheritance(${record.generatedIri}).generationRuleRef`, 'generation-rule artifact does not resolve');
    } else {
      usedRules.add(rule.refKey);
      if (record.generationRuleDigest !== rule.digest) {
        issue(errors, 'GENERATION_RULE_DIGEST_MISMATCH', `inheritance(${record.generatedIri}).generationRuleDigest`, `expected ${rule.digest}`);
      }
      if (typeof options.generationRuleEvaluator !== 'function') {
        issue(errors, 'MISSING_GENERATION_RULE_EVALUATOR', `inheritance(${record.generatedIri})`, 'a locked rule evaluator is required to reproduce generated IRIs');
      } else {
        try {
          const reproduced = options.generationRuleEvaluator({
            artifactRef: rule.artifactRef,
            bytes: rule.bytes,
            generatedKind: source.generatedKind,
            source: source.sourceTuple,
          });
          if (typeof reproduced !== 'string' || reproduced !== source.generatedIri || reproduced !== record.generatedIri) {
            issue(errors, 'GENERATION_RULE_REPRODUCTION_MISMATCH', `inheritance(${record.generatedIri})`, 'generation-rule bytes did not reproduce the exact generated IRI');
          }
        } catch (error) {
          issue(errors, 'GENERATION_RULE_EVALUATION_FAILED', `inheritance(${record.generatedIri})`, error.message);
        }
      }
    }
    generatedEntries.push({
      generatedIri: record.generatedIri,
      generatedKind: record.generatedKind,
      sourceElementKey: record.sourceElementKey,
      inheritanceRecordRef: inheritance.artifactRef,
      inheritanceRecordDigest: inheritance.digest,
    });
  });
  for (const symbol of publicSymbols.values()) {
    if (symbol.origin === 'generated' && !inheritanceByIri.has(symbol.publicIri)) {
      issue(errors, 'MISSING_GENERATED_INHERITANCE', `publicSymbol(${symbol.publicIri})`, 'generated public symbol lacks an inheritance record');
    }
  }
  for (const rule of generationRules) {
    if (rule.refKey && !usedRules.has(rule.refKey)) {
      issue(errors, 'ORPHAN_GENERATION_RULE', 'input.generationRuleArtifacts', 'generation-rule artifact is not referenced by any inheritance record');
    }
  }

  directEntries.sort((left, right) => utf8Compare(left.publicIri, right.publicIri));
  generatedEntries.sort((left, right) => utf8Compare(left.generatedIri, right.generatedIri));
  if (errors.length > 0) throw new TermCardCompilationError(errors);

  const manifest = {
    schemaVersion: '1.0',
    profileRef: input.profileRef,
    publicSymbolManifestRef: publicArtifact.artifactRef,
    publicSymbolManifestDigest: taggedJcsDigest(PUBLIC_SYMBOL_MANIFEST_TAG, publicArtifact.record),
    directEntries,
    generatedEntries,
  };
  return {
    manifest,
    manifestDigest: taggedJcsDigest(TERM_CARD_MANIFEST_TAG, manifest),
  };
}

function validateManifestCitation(citation, path, errors) {
  if (!validateClosed(citation, ['referenceId', 'artifactRef', 'artifactDigest', 'locator', 'usage'], [], path, errors)) return;
  if (typeof citation.referenceId !== 'string' || !REFERENCE_ID_RE.test(citation.referenceId)) issue(errors, 'INVALID_REFERENCE_ID', `${path}.referenceId`, 'invalid reference ID');
  validateArtifactRefInto(citation.artifactRef, `${path}.artifactRef`, errors, { prePayload: true });
  validateDigest(citation.artifactDigest, `${path}.artifactDigest`, errors);
  const locator = validateSourceLocator(citation.locator, { at: `${path}.locator` });
  for (const message of locator.errors) issue(errors, 'INVALID_SOURCE_LOCATOR', `${path}.locator`, message);
  if (!CITATION_USAGES.has(citation.usage)) issue(errors, 'INVALID_CITATION_USAGE', `${path}.usage`, 'invalid citation usage');
}

function validateManifestCitationOrder(citations, path, errors) {
  let previous = null;
  const locatorKeys = new Set();
  citations.forEach((citation, index) => {
    if (!isPlainObject(citation)) return;
    try {
      const tuple = citationSortTuple(citation);
      if (previous !== null && compareTuple(previous, tuple) >= 0) {
        issue(
          errors,
          'UNSORTED_OR_DUPLICATE_SOURCE_CITATION',
          `${path}[${index}]`,
          'citations must be strictly sorted and unique by the RFC tuple',
        );
      }
      previous = tuple;
      const locatorKey = canonicalJcs(citationLocatorTuple(citation));
      if (locatorKeys.has(locatorKey)) {
        issue(
          errors,
          'DUPLICATE_CITATION_LOCATOR',
          `${path}[${index}]`,
          'the same locked locator cannot be cited twice or dual-labelled',
        );
      }
      locatorKeys.add(locatorKey);
    } catch (error) {
      issue(errors, 'INVALID_CITATION_SORT_KEY', `${path}[${index}]`, error.message);
    }
  });
}

function validateTermCardManifestShape(manifest, errors) {
  if (!validateClosed(
    manifest,
    [
      'schemaVersion', 'profileRef', 'publicSymbolManifestRef',
      'publicSymbolManifestDigest', 'directEntries', 'generatedEntries',
    ],
    [],
    'manifest',
    errors,
  )) return;
  if (manifest.schemaVersion !== '1.0') issue(errors, 'SCHEMA_VERSION_MISMATCH', 'manifest.schemaVersion', 'expected "1.0"');
  validateAbsoluteIri(manifest.profileRef, 'manifest.profileRef', errors);
  validateArtifactRefInto(manifest.publicSymbolManifestRef, 'manifest.publicSymbolManifestRef', errors, { prePayload: true });
  validateDigest(manifest.publicSymbolManifestDigest, 'manifest.publicSymbolManifestDigest', errors);
  const directIris = new Set();
  if (!Array.isArray(manifest.directEntries)) issue(errors, 'INVALID_DIRECT_ENTRIES', 'manifest.directEntries', 'expected an array');
  else {
    let previous = null;
    manifest.directEntries.forEach((entry, index) => {
      const path = `manifest.directEntries[${index}]`;
      if (!validateClosed(
        entry,
        [
          'publicIri', 'cardRef', 'cardDigest', 'version', 'status', 'preferredLabel',
          'definition', 'definitionDigest', 'genus', 'differentia', 'excludes',
          'candidateM3Type', 'ownerRef', 'sourceCitations', 'review',
        ],
        [],
        path,
        errors,
      )) return;
      validateAbsoluteIri(entry.publicIri, `${path}.publicIri`, errors);
      validateArtifactRefInto(entry.cardRef, `${path}.cardRef`, errors, { prePayload: true });
      validateDigest(entry.cardDigest, `${path}.cardDigest`, errors);
      validateSemVer(entry.version, `${path}.version`, errors);
      if (!CARD_STATUSES.has(entry.status)) issue(errors, 'INVALID_CARD_STATUS', `${path}.status`, 'invalid card status');
      validateNfcString(entry.preferredLabel, `${path}.preferredLabel`, errors);
      validateNfcString(entry.genus, `${path}.genus`, errors);
      validateSortedNfcStringArray(
        entry.differentia,
        `${path}.differentia`,
        errors,
        'EMPTY_DIFFERENTIA',
      );
      validateSortedNfcStringArray(
        entry.excludes,
        `${path}.excludes`,
        errors,
        'EMPTY_EXCLUDES',
      );
      if (validateAbsoluteIri(entry.candidateM3Type, `${path}.candidateM3Type`, errors)
          && !CANDIDATE_M3_TYPE_SET.has(entry.candidateM3Type)) {
        issue(
          errors,
          'INVALID_CANDIDATE_M3_TYPE',
          `${path}.candidateM3Type`,
          'expected one canonical M3 term-definition IRI',
        );
      }
      const validDefinition = validateNfcString(entry.definition, `${path}.definition`, errors);
      validateDigest(entry.definitionDigest, `${path}.definitionDigest`, errors);
      if (validDefinition) {
        const expectedDefinitionDigest = artifactDigest(Buffer.from(entry.definition, 'utf8'));
        if (entry.definitionDigest !== expectedDefinitionDigest) {
          issue(errors, 'DEFINITION_DIGEST_MISMATCH', `${path}.definitionDigest`, `expected ${expectedDefinitionDigest}`);
        }
      }
      validateAbsoluteIri(entry.ownerRef, `${path}.ownerRef`, errors);
      if (!Array.isArray(entry.sourceCitations) || entry.sourceCitations.length === 0) issue(errors, 'EMPTY_SOURCE_CITATIONS', `${path}.sourceCitations`, 'expected non-empty citations');
      else {
        entry.sourceCitations.forEach((citation, citationIndex) => validateManifestCitation(citation, `${path}.sourceCitations[${citationIndex}]`, errors));
        validateManifestCitationOrder(entry.sourceCitations, `${path}.sourceCitations`, errors);
      }
      if (validateClosed(
        entry.review,
        ['decision', 'reviewerRef', 'decisionTime', 'rationale', 'reviewRecordRef', 'reviewRecordDigest'],
        [],
        `${path}.review`,
        errors,
      )) {
        if (!REVIEW_DECISIONS.has(entry.review.decision)) issue(errors, 'INVALID_REVIEW_DECISION', `${path}.review.decision`, 'invalid review decision');
        validateAbsoluteIri(entry.review.reviewerRef, `${path}.review.reviewerRef`, errors);
        validateInstant(entry.review.decisionTime, `${path}.review.decisionTime`, errors);
        validateNfcString(entry.review.rationale, `${path}.review.rationale`, errors);
        validateArtifactRefInto(entry.review.reviewRecordRef, `${path}.review.reviewRecordRef`, errors, { prePayload: true });
        validateDigest(entry.review.reviewRecordDigest, `${path}.review.reviewRecordDigest`, errors);
        if (entry.status === 'accepted' && entry.review.decision !== 'accept') {
          issue(errors, 'CARD_REVIEW_DECISION_MISMATCH', `${path}.review.decision`, 'accepted requires accept');
        }
        if (entry.status === 'rejected' && entry.review.decision !== 'reject') {
          issue(errors, 'CARD_REVIEW_DECISION_MISMATCH', `${path}.review.decision`, 'rejected requires reject');
        }
      }
      if (previous !== null && utf8Compare(previous, entry.publicIri) >= 0) issue(errors, 'UNSORTED_OR_DUPLICATE_DIRECT_ENTRY', path, 'direct entries must be strictly publicIri-sorted and unique');
      previous = entry.publicIri;
      directIris.add(entry.publicIri);
    });
  }
  if (!Array.isArray(manifest.generatedEntries)) issue(errors, 'INVALID_GENERATED_ENTRIES', 'manifest.generatedEntries', 'expected an array');
  else {
    let previous = null;
    const sourceKeys = new Set();
    manifest.generatedEntries.forEach((entry, index) => {
      const path = `manifest.generatedEntries[${index}]`;
      if (!validateClosed(
        entry,
        ['generatedIri', 'generatedKind', 'sourceElementKey', 'inheritanceRecordRef', 'inheritanceRecordDigest'],
        [],
        path,
        errors,
      )) return;
      validateAbsoluteIri(entry.generatedIri, `${path}.generatedIri`, errors);
      if (!GENERATED_KINDS.has(entry.generatedKind)) issue(errors, 'INVALID_GENERATED_KIND', `${path}.generatedKind`, 'invalid generated kind');
      validateDigest(entry.sourceElementKey, `${path}.sourceElementKey`, errors);
      validateArtifactRefInto(entry.inheritanceRecordRef, `${path}.inheritanceRecordRef`, errors, { prePayload: true });
      validateDigest(entry.inheritanceRecordDigest, `${path}.inheritanceRecordDigest`, errors);
      if (previous !== null && utf8Compare(previous, entry.generatedIri) >= 0) issue(errors, 'UNSORTED_OR_DUPLICATE_GENERATED_ENTRY', path, 'generated entries must be strictly generatedIri-sorted and unique');
      previous = entry.generatedIri;
      if (directIris.has(entry.generatedIri)) issue(errors, 'DIRECT_GENERATED_SET_OVERLAP', path, 'direct and generated sets must be disjoint');
      if (sourceKeys.has(entry.sourceElementKey)) issue(errors, 'DUPLICATE_GENERATED_SOURCE_KEY', path, 'generated sourceElementKey must be unique');
      sourceKeys.add(entry.sourceElementKey);
    });
  }
}

function validateTermCardManifest(manifest, input, options = {}) {
  const errors = [];
  validateTermCardManifestShape(manifest, errors);
  let expected = null;
  try {
    expected = compileTermCardManifest(input, options).manifest;
  } catch (error) {
    if (error instanceof TermCardCompilationError) errors.push(...error.errors);
    else throw error;
  }
  if (expected) {
    try {
      if (canonicalJcs(manifest) !== canonicalJcs(expected)) {
        issue(errors, 'TERM_CARD_MANIFEST_MISMATCH', 'manifest', 'manifest is not the exact compiler projection');
      }
    } catch (error) {
      issue(errors, 'JCS_CANONICALIZATION_FAILED', 'manifest', error.message);
    }
  }
  return { ok: errors.length === 0, errors, expectedManifest: expected };
}

module.exports = {
  PROFILE_REF,
  PUBLIC_SYMBOL_MANIFEST_TAG,
  SOURCE_CITATIONS_TAG,
  TERM_CARD_MANIFEST_TAG,
  TermCardCompilationError,
  artifactDigest,
  buildGeneratedSourceIndex,
  citationSortTuple,
  compileTermCardManifest,
  taggedJcsDigest,
  validateDirectTermCardSourceRecord,
  validateGeneratedInheritanceRecord,
  validateTermCardManifest,
  validateTermCardManifestShape,
  validateTermReviewDecisionRecord,
};
