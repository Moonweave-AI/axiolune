'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const {
  canonicalJcs,
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');
const {
  extractJsonPointerJcsBytes,
  parseJsonRejectingDuplicateMembers,
} = require('./json-pointer-source-extractor.cjs');
const { isUtcInstantLexical } = require('./instant-lexical.cjs');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]+$/u;
const RECORD_SET_DOMAIN = Buffer.from(
  'axiolune-portfolio-observation-record-set-v1\0',
  'utf8',
);
const ORDERING = Object.freeze([
  'accountLogicalIri',
  'instrumentLogicalIri',
  'snapshotId',
]);
const NULL_CURSOR_KEY = '\0initial-cursor';
const EXTRACTOR_DEPENDENCY_REF = Object.freeze({
  kind: 'path',
  path: 'scripts/domain/lib/strict-source-locator.cjs',
  root: 'sourceTree',
});
const EXTRACTOR_IMPLEMENTATION_REF = Object.freeze({
  kind: 'path',
  path: 'scripts/domain/lib/json-pointer-source-extractor.cjs',
  root: 'sourceTree',
});
const EXTRACTOR_RUNTIME_BYTES = Object.freeze({
  dependency: fs.readFileSync(require.resolve('./strict-source-locator.cjs')),
  implementation: fs.readFileSync(require.resolve('./json-pointer-source-extractor.cjs')),
});

class PortfolioObservationClosureError extends Error {
  constructor(code, at, message) {
    super(`${at}: ${message}`);
    this.name = 'PortfolioObservationClosureError';
    this.code = code;
    this.at = at;
  }
}

function fail(code, at, message) {
  throw new PortfolioObservationClosureError(code, at, message);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, at) {
  if (!isPlainObject(value)) fail('PORTFOLIO_CLOSURE_SHAPE', at, 'expected a closed object');
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJcs(actual) !== canonicalJcs(wanted)) {
    fail(
      'PORTFOLIO_CLOSURE_SHAPE',
      at,
      `fields must equal ${wanted.join(', ')}`,
    );
  }
}

function validIri(value) {
  return typeof value === 'string'
    && value === value.normalize('NFC')
    && IRI_RE.test(value);
}

function requireIri(value, at) {
  if (!validIri(value)) fail('PORTFOLIO_CLOSURE_SCOPE', at, 'expected an absolute NFC IRI');
}

function requireExactVersionIri(logicalIri, versionIri, at) {
  requireIri(logicalIri, `${at}.logicalIri`);
  requireIri(versionIri, `${at}.versionIri`);
  const marker = versionIri.indexOf('/version/');
  if (marker <= 0
      || marker + '/version/'.length >= versionIri.length
      || versionIri.slice(0, marker) !== logicalIri) {
    fail(
      'PORTFOLIO_CLOSURE_VERSION',
      at,
      'expected an exact FactVersion IRI under the declared stable logical IRI',
    );
  }
}

function requireStandaloneExactVersionIri(versionIri, at) {
  requireIri(versionIri, at);
  const marker = versionIri.indexOf('/version/');
  if (marker <= 0 || marker + '/version/'.length >= versionIri.length) {
    fail(
      'PORTFOLIO_CLOSURE_VERSION',
      at,
      'expected an exact version IRI containing a non-empty /version/<version-key> suffix',
    );
  }
}

function requireText(value, at) {
  if (typeof value !== 'string'
      || value.length === 0
      || value !== value.normalize('NFC')
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('PORTFOLIO_CLOSURE_SHAPE', at, 'expected non-empty NFC text without control characters');
  }
}

function requireDigest(value, at) {
  if (!DIGEST_RE.test(value || '')) {
    fail('PORTFOLIO_CLOSURE_DIGEST', at, 'expected sha256:<64 lowercase hex>');
  }
}

function sha256(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return `sha256:${crypto.createHash('sha256').update(input).digest('hex')}`;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function validateRecordKey(key, at, expectedAccount) {
  exactKeys(key, ORDERING, at);
  requireIri(key.accountLogicalIri, `${at}.accountLogicalIri`);
  requireIri(key.instrumentLogicalIri, `${at}.instrumentLogicalIri`);
  requireText(key.snapshotId, `${at}.snapshotId`);
  if (expectedAccount !== undefined && key.accountLogicalIri !== expectedAccount) {
    fail(
      'PORTFOLIO_CLOSURE_SCOPE',
      `${at}.accountLogicalIri`,
      'record key is outside the request account scope',
    );
  }
}

function compareRecordKeys(left, right) {
  for (const field of ORDERING) {
    const order = compareUtf8(left[field], right[field]);
    if (order !== 0) return order;
  }
  return 0;
}

function recordKeyToken(key) {
  return canonicalJcs(key);
}

function recordSetDigest(keys) {
  if (!Array.isArray(keys)) throw new TypeError('recordSetDigest keys must be an array');
  const unique = new Map();
  for (const [index, key] of keys.entries()) {
    validateRecordKey(key, `recordSetDigest.keys[${index}]`);
    unique.set(recordKeyToken(key), key);
  }
  const ordered = [...unique.values()].sort(compareRecordKeys);
  const hash = crypto.createHash('sha256');
  hash.update(RECORD_SET_DOMAIN);
  hash.update(Buffer.from(canonicalJcs(ordered), 'utf8'));
  return `sha256:${hash.digest('hex')}`;
}

function readBytes(reader, ref, at) {
  const refValidation = validateArtifactRef(ref, `${at}.artifactRef`);
  if (!refValidation.ok) {
    fail('PORTFOLIO_CLOSURE_ARTIFACT', `${at}.artifactRef`, refValidation.errors.join('; '));
  }
  let result;
  try {
    result = reader(ref, at);
  } catch (error) {
    fail('PORTFOLIO_CLOSURE_ARTIFACT', at, `artifact reader failed: ${error.message}`);
  }
  const bytes = Buffer.isBuffer(result) ? result : result?.bytes;
  if (!Buffer.isBuffer(bytes)) {
    fail('PORTFOLIO_CLOSURE_ARTIFACT', at, 'artifact reader must return a Buffer or { bytes: Buffer }');
  }
  return bytes;
}

function stableArtifactReader(reader) {
  const cache = new Map();
  return (ref, at) => {
    const key = canonicalJcs(ref);
    if (cache.has(key)) return cache.get(key);
    let result;
    try {
      result = reader(ref, at);
    } catch (error) {
      fail('PORTFOLIO_CLOSURE_ARTIFACT', at, `artifact reader failed: ${error.message}`);
    }
    const bytes = Buffer.isBuffer(result) ? result : result?.bytes;
    if (!Buffer.isBuffer(bytes)) {
      fail(
        'PORTFOLIO_CLOSURE_ARTIFACT',
        at,
        'artifact reader must return a Buffer or { bytes: Buffer }',
      );
    }
    // One immutable copy per ArtifactRef prevents an underlying reader from
    // presenting different bytes for the same reference during one replay.
    const locked = Buffer.from(bytes);
    cache.set(key, locked);
    return locked;
  };
}

function readBoundJson(reader, ref, digest, at) {
  requireDigest(digest, `${at}.artifactDigest`);
  const bytes = readBytes(reader, ref, at);
  const actual = sha256(bytes);
  if (actual !== digest) {
    fail(
      'PORTFOLIO_CLOSURE_DIGEST',
      `${at}.artifactDigest`,
      `locked digest ${digest} does not equal artifact bytes ${actual}`,
    );
  }
  let document;
  try {
    document = parseJsonRejectingDuplicateMembers(bytes.toString('utf8'));
  } catch (error) {
    fail('PORTFOLIO_CLOSURE_JSON', at, error.message);
  }
  let canonical;
  try {
    canonical = Buffer.from(canonicalJcs(document), 'utf8');
  } catch (error) {
    fail('PORTFOLIO_CLOSURE_JSON', at, error.message);
  }
  if (!bytes.equals(canonical)) {
    fail('PORTFOLIO_CLOSURE_JSON', at, 'artifact must be exact canonical JCS UTF-8 bytes');
  }
  return { bytes, document };
}

function sameRef(left, right) {
  return canonicalJcs(left) === canonicalJcs(right);
}

function validateSourceContract(document, request) {
  const at = 'request.sourceContract';
  exactKeys(document, [
    'accountScope',
    'completeness',
    'failurePolicy',
    'duplicatePolicy',
    'kind',
    'ordering',
    'paginationMode',
    'providerIri',
    'responseMediaType',
    'schemaVersion',
    'streamLogicalIri',
    'versionIri',
  ], at);
  if (document.schemaVersion !== '1.0'
      || document.kind !== 'PortfolioObservationSourceContract'
      || document.accountScope !== 'request-bound'
      || document.completeness !== 'complete-snapshot'
      || document.duplicatePolicy !== 'reject'
      || document.failurePolicy !== 'reject-degraded-partial-or-error'
      || document.paginationMode !== 'opaque-immutable-cursor'
      || document.responseMediaType !== 'application/json'
      || canonicalJcs(document.ordering) !== canonicalJcs(ORDERING)) {
    fail(
      'PORTFOLIO_CLOSURE_CONTRACT',
      at,
      'source contract must be the closed complete-snapshot/opaque-immutable-cursor/reject-failure/reject-duplicate contract',
    );
  }
  requireIri(document.versionIri, `${at}.versionIri`);
  requireIri(document.providerIri, `${at}.providerIri`);
  requireIri(document.streamLogicalIri, `${at}.streamLogicalIri`);
  requireStandaloneExactVersionIri(document.versionIri, `${at}.versionIri`);
  if (document.versionIri !== request.sourceContractVersionIri
      || document.providerIri !== request.providerIri
      || document.streamLogicalIri !== request.streamLogicalIri) {
    fail(
      'PORTFOLIO_CLOSURE_SCOPE',
      at,
      'source contract identity/provider/stream does not equal the exact snapshot request scope',
    );
  }
}

function validateSnapshotRequest(document) {
  const at = 'request';
  exactKeys(document, [
    'accountLogicalIri',
    'asOf',
    'initialCursor',
    'kind',
    'providerIri',
    'requestIri',
    'schemaVersion',
    'sourceContractDigest',
    'sourceContractRef',
    'sourceContractVersionIri',
    'streamLogicalIri',
    'streamVersionIri',
  ], at);
  if (document.schemaVersion !== '1.0'
      || document.kind !== 'PortfolioObservationSnapshotRequest'
      || document.initialCursor !== null) {
    fail(
      'PORTFOLIO_CLOSURE_REQUEST',
      at,
      'snapshot request must be schema 1.0 and start from the null initial cursor',
    );
  }
  for (const field of [
    'accountLogicalIri',
    'providerIri',
    'requestIri',
    'sourceContractVersionIri',
    'streamLogicalIri',
    'streamVersionIri',
  ]) requireIri(document[field], `${at}.${field}`);
  requireExactVersionIri(
    document.streamLogicalIri,
    document.streamVersionIri,
    `${at}.streamVersionIri`,
  );
  requireStandaloneExactVersionIri(
    document.sourceContractVersionIri,
    `${at}.sourceContractVersionIri`,
  );
  if (!isUtcInstantLexical(document.asOf)) {
    fail('PORTFOLIO_CLOSURE_SCOPE', `${at}.asOf`, 'expected a valid UTC instant');
  }
  requireDigest(document.sourceContractDigest, `${at}.sourceContractDigest`);
  const refValidation = validateArtifactRef(document.sourceContractRef, `${at}.sourceContractRef`);
  if (!refValidation.ok) {
    fail('PORTFOLIO_CLOSURE_ARTIFACT', `${at}.sourceContractRef`, refValidation.errors.join('; '));
  }
}

function cursorKey(cursor, at) {
  if (cursor === null) return NULL_CURSOR_KEY;
  requireText(cursor, at);
  return `cursor:${cursor}`;
}

function commonScope(request) {
  return {
    accountLogicalIri: request.accountLogicalIri,
    asOf: request.asOf,
    providerIri: request.providerIri,
    snapshotRequestIri: request.requestIri,
    sourceContractVersionIri: request.sourceContractVersionIri,
    streamLogicalIri: request.streamLogicalIri,
    streamVersionIri: request.streamVersionIri,
  };
}

function validateScopeFields(document, request, at) {
  const expected = commonScope(request);
  for (const [field, value] of Object.entries(expected)) {
    if (document[field] !== value) {
      fail(
        'PORTFOLIO_CLOSURE_SCOPE',
        `${at}.${field}`,
        `value must equal the locked snapshot request ${field}`,
      );
    }
  }
}

function validatePageRequest(
  document,
  request,
  requestDigest,
  page,
  expectedProviderSnapshotToken,
  at,
) {
  exactKeys(document, [
    'accountLogicalIri',
    'asOf',
    'cursor',
    'kind',
    'pageRequestIri',
    'providerIri',
    'providerSnapshotToken',
    'schemaVersion',
    'snapshotRequestDigest',
    'snapshotRequestIri',
    'sourceContractVersionIri',
    'streamLogicalIri',
    'streamVersionIri',
  ], at);
  if (document.schemaVersion !== '1.0' || document.kind !== 'PortfolioObservationPageRequest') {
    fail('PORTFOLIO_CLOSURE_REQUEST', at, 'page request must use the closed schema 1.0 protocol');
  }
  requireIri(document.pageRequestIri, `${at}.pageRequestIri`);
  requireDigest(document.snapshotRequestDigest, `${at}.snapshotRequestDigest`);
  validateScopeFields(document, request, at);
  cursorKey(document.cursor, `${at}.cursor`);
  if (document.providerSnapshotToken !== expectedProviderSnapshotToken) {
    fail(
      'PORTFOLIO_CLOSURE_SNAPSHOT',
      `${at}.providerSnapshotToken`,
      'page request must carry null initially and then the immutable provider snapshot token',
    );
  }
  if (document.cursor !== page.cursor || document.snapshotRequestDigest !== requestDigest) {
    fail(
      'PORTFOLIO_CLOSURE_REQUEST',
      at,
      'page request cursor/root-request digest does not equal the declared page and locked snapshot request',
    );
  }
}

function validateResponseRecord(record, request, at) {
  exactKeys(record, ['payload', 'recordKey'], at);
  validateRecordKey(record.recordKey, `${at}.recordKey`, request.accountLogicalIri);
  if (!isPlainObject(record.payload)) {
    fail('PORTFOLIO_CLOSURE_RECORD', `${at}.payload`, 'record payload must be a JSON object');
  }
  exactKeys(record.payload, [
    'availableFrom',
    'holdingQuantity',
    'holdingQuantityPrecision',
    'holdingQuantityRounding',
    'holdingQuantityUnit',
    'knowledgeFrom',
    'positionSourceKindIri',
    'revision',
    'validFrom',
  ], `${at}.payload`);
  for (const field of ['availableFrom', 'knowledgeFrom', 'validFrom']) {
    if (!isUtcInstantLexical(record.payload[field])) {
      fail('PORTFOLIO_CLOSURE_RECORD', `${at}.payload.${field}`, 'expected a valid UTC instant');
    }
  }
  if (typeof record.payload.holdingQuantity !== 'string'
      || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(record.payload.holdingQuantity)) {
    fail(
      'PORTFOLIO_CLOSURE_RECORD',
      `${at}.payload.holdingQuantity`,
      'expected a canonical non-negative decimal lexical value',
    );
  }
  const decimalScale = record.payload.holdingQuantity.includes('.')
    ? record.payload.holdingQuantity.length - record.payload.holdingQuantity.indexOf('.') - 1
    : 0;
  if (!Number.isSafeInteger(record.payload.holdingQuantityPrecision)
      || record.payload.holdingQuantityPrecision < 0
      || record.payload.holdingQuantityPrecision !== decimalScale
      || !['floor', 'ceiling', 'half-up', 'half-even']
        .includes(record.payload.holdingQuantityRounding)
      || !Number.isSafeInteger(record.payload.revision)
      || record.payload.revision < 0) {
    fail(
      'PORTFOLIO_CLOSURE_RECORD',
      `${at}.payload`,
      'quantity precision/rounding or revision is invalid',
    );
  }
  requireText(record.payload.holdingQuantityUnit, `${at}.payload.holdingQuantityUnit`);
  requireIri(record.payload.positionSourceKindIri, `${at}.payload.positionSourceKindIri`);
  // Ensure payload keys and values are within the same locked JCS profile used
  // to calculate SourceLocator selection bytes.
  try {
    canonicalJcs(record.payload);
  } catch (error) {
    fail('PORTFOLIO_CLOSURE_RECORD', `${at}.payload`, error.message);
  }
}

function validatePageResponse(
  document,
  request,
  requestDigest,
  pageRequest,
  pageRequestDigest,
  page,
  expectedProviderSnapshotToken,
  at,
) {
  exactKeys(document, [
    'accountLogicalIri',
    'asOf',
    'cursor',
    'kind',
    'nextCursor',
    'pageRequestDigest',
    'pageRequestIri',
    'providerIri',
    'providerSnapshotToken',
    'records',
    'retrievalStatus',
    'schemaVersion',
    'snapshotRequestDigest',
    'snapshotRequestIri',
    'sourceContractVersionIri',
    'streamLogicalIri',
    'streamVersionIri',
    'terminal',
  ], at);
  if (document.schemaVersion !== '1.0'
      || document.kind !== 'PortfolioObservationPageResponse'
      || !Array.isArray(document.records)
      || typeof document.terminal !== 'boolean') {
    fail('PORTFOLIO_CLOSURE_RESPONSE', at, 'page response must use the closed schema 1.0 protocol');
  }
  requireDigest(document.pageRequestDigest, `${at}.pageRequestDigest`);
  requireDigest(document.snapshotRequestDigest, `${at}.snapshotRequestDigest`);
  requireText(document.providerSnapshotToken, `${at}.providerSnapshotToken`);
  if (document.retrievalStatus !== 'success') {
    fail(
      'PORTFOLIO_CLOSURE_INCOMPLETE',
      `${at}.retrievalStatus`,
      'degraded, partial, failed, stale-cache, or unknown retrieval cannot prove completeness',
    );
  }
  if (expectedProviderSnapshotToken !== null
      && document.providerSnapshotToken !== expectedProviderSnapshotToken) {
    fail(
      'PORTFOLIO_CLOSURE_SNAPSHOT',
      `${at}.providerSnapshotToken`,
      'all pages must belong to one immutable provider snapshot token',
    );
  }
  validateScopeFields(document, request, at);
  cursorKey(document.cursor, `${at}.cursor`);
  if (document.nextCursor !== null) cursorKey(document.nextCursor, `${at}.nextCursor`);
  if (document.cursor !== page.cursor
      || document.pageRequestIri !== pageRequest.pageRequestIri
      || document.pageRequestDigest !== pageRequestDigest
      || document.snapshotRequestDigest !== requestDigest) {
    fail(
      'PORTFOLIO_CLOSURE_RESPONSE',
      at,
      'response does not bind the exact page request, cursor, and root snapshot request',
    );
  }
  if (document.nextCursor !== page.nextCursor || document.terminal !== page.terminal) {
    fail(
      'PORTFOLIO_CLOSURE_PAGINATION',
      at,
      'response next cursor/terminal state does not equal the page declaration',
    );
  }
  if (document.terminal !== (document.nextCursor === null)) {
    fail(
      'PORTFOLIO_CLOSURE_TERMINAL',
      at,
      'terminal must be true exactly when nextCursor is null',
    );
  }
  document.records.forEach((record, index) => (
    validateResponseRecord(record, request, `${at}.records[${index}]`)
  ));
}

function validateExtractorProfile(reader, locator, cache, at) {
  const key = `${canonicalJcs(locator.extractorProfileRef)}\0${locator.extractorProfileDigest}`;
  if (cache.has(key)) return;
  const { document } = readBoundJson(
    reader,
    locator.extractorProfileRef,
    locator.extractorProfileDigest,
    `${at}.extractorProfile`,
  );
  exactKeys(document, [
    'algorithm',
    'dependencies',
    'domainTag',
    'duplicateMemberPolicy',
    'encoding',
    'extractorStatus',
    'implementationDigest',
    'implementationRef',
    'networkAccess',
    'numberProfile',
    'pointerProfile',
    'schemaVersion',
    'selectionCardinality',
    'unicodePolicy',
  ], `${at}.extractorProfile`);
  if (document.schemaVersion !== '1.0'
      || document.algorithm !== 'rfc6901-select-then-jcs'
      || !Array.isArray(document.dependencies)
      || document.dependencies.length !== 1
      || document.domainTag !== 'axiolune-source-selection-v1\0'
      || document.duplicateMemberPolicy !== 'reject-decoded-name-duplicates-at-any-depth'
      || document.encoding !== 'utf-8-fatal-no-bom'
      || document.extractorStatus !== 'executable'
      || document.networkAccess !== false
      || document.numberProfile !== 'selected-value-must-satisfy-axiolune-safe-integer-jcs'
      || document.pointerProfile !== 'canonical-rfc6901-string-form'
      || document.selectionCardinality !== 'exactly-one-non-empty-jcs-value'
      || document.unicodePolicy !== 'valid-utf8-unicode-scalars-nfc-in-selected-value') {
    fail(
      'PORTFOLIO_CLOSURE_LOCATOR_PROFILE',
      `${at}.extractorProfile`,
      'extractor profile does not lock the executed RFC6901/JCS selection semantics',
    );
  }
  const dependency = document.dependencies[0];
  exactKeys(
    dependency,
    ['dependencyDigest', 'dependencyRef', 'role'],
    `${at}.extractorProfile.dependencies[0]`,
  );
  if (dependency.role !== 'canonical-jcs-and-selection-digest') {
    fail(
      'PORTFOLIO_CLOSURE_LOCATOR_PROFILE',
      `${at}.extractorProfile.dependencies[0].role`,
      'unexpected extractor dependency role',
    );
  }
  for (const [ref, digest, label, expectedRef, actualBytes] of [
    [
      dependency.dependencyRef,
      dependency.dependencyDigest,
      'dependencies[0]',
      EXTRACTOR_DEPENDENCY_REF,
      EXTRACTOR_RUNTIME_BYTES.dependency,
    ],
    [
      document.implementationRef,
      document.implementationDigest,
      'implementation',
      EXTRACTOR_IMPLEMENTATION_REF,
      EXTRACTOR_RUNTIME_BYTES.implementation,
    ],
  ]) {
    requireDigest(digest, `${at}.extractorProfile.${label}Digest`);
    if (canonicalJcs(ref) !== canonicalJcs(expectedRef)) {
      fail(
        'PORTFOLIO_CLOSURE_LOCATOR_PROFILE',
        `${at}.extractorProfile.${label}`,
        'runtime reference does not identify the implementation actually executed by this verifier',
      );
    }
    const bytes = readBytes(reader, ref, `${at}.extractorProfile.${label}`);
    if (sha256(bytes) !== digest
        || !Buffer.from(bytes).equals(actualBytes)
        || digest !== sha256(actualBytes)) {
      fail(
        'PORTFOLIO_CLOSURE_LOCATOR_PROFILE',
        `${at}.extractorProfile.${label}`,
        'locked runtime bytes do not equal the exact implementation executed by this verifier',
      );
    }
  }
  cache.add(key);
}

function validateRowLocators(reader, page, responseBytes, response, request, profileCache, at) {
  const manifestArtifact = readBoundJson(
    reader,
    page.rowLocatorManifestRef,
    page.rowLocatorManifestDigest,
    `${at}.rowLocatorManifest`,
  );
  const manifest = manifestArtifact.document;
  exactKeys(manifest, [
    'kind',
    'responseDigest',
    'responseRef',
    'rows',
    'schemaVersion',
  ], `${at}.rowLocatorManifest`);
  if (manifest.schemaVersion !== '1.0'
      || manifest.kind !== 'PortfolioObservationRowLocatorManifest'
      || !Array.isArray(manifest.rows)
      || !sameRef(manifest.responseRef, page.responseRef)
      || manifest.responseDigest !== page.responseDigest) {
    fail(
      'PORTFOLIO_CLOSURE_LOCATOR',
      `${at}.rowLocatorManifest`,
      'row-locator manifest must bind the exact locked page response',
    );
  }
  if (manifest.rows.length !== response.records.length) {
    fail(
      'PORTFOLIO_CLOSURE_OMISSION',
      `${at}.rowLocatorManifest.rows`,
      'every locked response record must have exactly one row SourceLocator',
    );
  }
  if (!isPlainObject(page.responseRef)
      || page.responseRef.kind !== 'path'
      || page.responseRef.root !== 'sourceTree') {
    fail(
      'PORTFOLIO_CLOSURE_LOCATOR',
      `${at}.responseRef`,
      'row SourceLocator closure requires one sourceTree path response artifact',
    );
  }
  const bindings = [];
  for (const [index, row] of manifest.rows.entries()) {
    const rowAt = `${at}.rowLocatorManifest.rows[${index}]`;
    exactKeys(row, ['locatorIri', 'recordKey', 'sourceLocator'], rowAt);
    requireIri(row.locatorIri, `${rowAt}.locatorIri`);
    validateRecordKey(row.recordKey, `${rowAt}.recordKey`, request.accountLogicalIri);
    if (recordKeyToken(row.recordKey) !== recordKeyToken(response.records[index].recordKey)) {
      fail(
        'PORTFOLIO_CLOSURE_LOCATOR',
        `${rowAt}.recordKey`,
        'row locator key must equal the response record selected at the same ordinal',
      );
    }
    const locator = row.sourceLocator;
    const shape = validateSourceLocator(locator, { at: `${rowAt}.sourceLocator` });
    if (!shape.ok) {
      fail('PORTFOLIO_CLOSURE_LOCATOR', `${rowAt}.sourceLocator`, shape.errors.join('; '));
    }
    if (locator.kind !== 'jsonPointer'
        || locator.mediaType !== 'application/json'
        || locator.path !== page.responseRef.path
        || locator.pointer !== `/records/${index}`) {
      fail(
        'PORTFOLIO_CLOSURE_LOCATOR',
        `${rowAt}.sourceLocator`,
        'locator must select the exact /records/<ordinal> value from its locked page response',
      );
    }
    validateExtractorProfile(reader, locator, profileCache, `${rowAt}.sourceLocator`);
    let selectedBytes;
    try {
      selectedBytes = extractJsonPointerJcsBytes(responseBytes, locator.pointer);
    } catch (error) {
      fail('PORTFOLIO_CLOSURE_LOCATOR', `${rowAt}.sourceLocator`, error.message);
    }
    const selected = validateSourceLocator(locator, {
      at: `${rowAt}.sourceLocator`,
      selectedBytes,
    });
    if (!selected.ok) {
      fail('PORTFOLIO_CLOSURE_LOCATOR', `${rowAt}.sourceLocator`, selected.errors.join('; '));
    }
    bindings.push({
      locatorIri: row.locatorIri,
      payload: structuredClone(response.records[index].payload),
      record: structuredClone(response.records[index]),
      recordKey: structuredClone(row.recordKey),
      responseDigest: page.responseDigest,
      responseRef: structuredClone(page.responseRef),
      selectionDigest: locator.selectionDigest,
      sourceLocator: structuredClone(locator),
    });
  }
  return bindings;
}

function validatePageDeclaration(page, at) {
  exactKeys(page, [
    'cursor',
    'nextCursor',
    'orderedRecordKeys',
    'pageIndex',
    'recordCount',
    'recordSetDigest',
    'requestDigest',
    'requestRef',
    'responseDigest',
    'responseRef',
    'rowLocatorManifestDigest',
    'rowLocatorManifestRef',
    'terminal',
  ], at);
  if (!Number.isSafeInteger(page.pageIndex) || page.pageIndex < 0
      || !Number.isSafeInteger(page.recordCount) || page.recordCount < 0
      || !Array.isArray(page.orderedRecordKeys)
      || typeof page.terminal !== 'boolean') {
    fail('PORTFOLIO_CLOSURE_SHAPE', at, 'invalid page index/count/key-list/terminal field');
  }
  cursorKey(page.cursor, `${at}.cursor`);
  if (page.nextCursor !== null) cursorKey(page.nextCursor, `${at}.nextCursor`);
  requireDigest(page.recordSetDigest, `${at}.recordSetDigest`);
  requireDigest(page.requestDigest, `${at}.requestDigest`);
  requireDigest(page.responseDigest, `${at}.responseDigest`);
  requireDigest(page.rowLocatorManifestDigest, `${at}.rowLocatorManifestDigest`);
  const manifestRef = validateArtifactRef(
    page.rowLocatorManifestRef,
    `${at}.rowLocatorManifestRef`,
  );
  if (!manifestRef.ok) {
    fail(
      'PORTFOLIO_CLOSURE_ARTIFACT',
      `${at}.rowLocatorManifestRef`,
      manifestRef.errors.join('; '),
    );
  }
  for (const [index, key] of page.orderedRecordKeys.entries()) {
    validateRecordKey(key, `${at}.orderedRecordKeys[${index}]`);
  }
}

function verifyPortfolioObservationStreamClosure(closure, options = {}) {
  if (typeof options.readArtifact !== 'function') {
    throw new TypeError('verifyPortfolioObservationStreamClosure requires options.readArtifact');
  }
  const reader = stableArtifactReader(options.readArtifact);
  exactKeys(closure, ['aggregate', 'kind', 'pages', 'request', 'schemaVersion'], 'closure');
  if (closure.schemaVersion !== '1.0'
      || closure.kind !== 'PortfolioObservationStreamClosure'
      || !Array.isArray(closure.pages)
      || closure.pages.length === 0) {
    fail(
      'PORTFOLIO_CLOSURE_SHAPE',
      'closure',
      'closure must use schema 1.0 and contain at least the terminal page',
    );
  }
  exactKeys(closure.request, ['artifactDigest', 'artifactRef'], 'closure.request');
  const requestArtifact = readBoundJson(
    reader,
    closure.request.artifactRef,
    closure.request.artifactDigest,
    'closure.request',
  );
  const request = requestArtifact.document;
  validateSnapshotRequest(request);
  const sourceContract = readBoundJson(
    reader,
    request.sourceContractRef,
    request.sourceContractDigest,
    'request.sourceContract',
  );
  validateSourceContract(sourceContract.document, request);

  const pagesByCursor = new Map();
  for (const [index, page] of closure.pages.entries()) {
    const at = `closure.pages[${index}]`;
    validatePageDeclaration(page, at);
    if (page.pageIndex !== index) {
      fail(
        'PORTFOLIO_CLOSURE_PAGINATION',
        `${at}.pageIndex`,
        'page array order and pageIndex must equal cursor traversal order',
      );
    }
    const key = cursorKey(page.cursor, `${at}.cursor`);
    if (pagesByCursor.has(key)) {
      fail('PORTFOLIO_CLOSURE_DUPLICATE_CURSOR', `${at}.cursor`, 'cursor appears more than once');
    }
    pagesByCursor.set(key, { page, index });
  }

  const visited = new Set();
  const allKeys = [];
  const allRecordBindings = [];
  const seenKeyCounts = new Map();
  const profileCache = new Set();
  let cursor = request.initialCursor;
  let providerSnapshotToken = null;
  let terminalObserved = false;
  for (let traversalIndex = 0; traversalIndex <= closure.pages.length; traversalIndex += 1) {
    const key = cursorKey(cursor, `cursor[${traversalIndex}]`);
    if (visited.has(key)) {
      fail('PORTFOLIO_CLOSURE_CURSOR_CYCLE', `cursor[${traversalIndex}]`, 'cursor chain contains a cycle');
    }
    const entry = pagesByCursor.get(key);
    if (!entry) {
      fail(
        'PORTFOLIO_CLOSURE_MISSING_PAGE',
        `cursor[${traversalIndex}]`,
        'no locked page exists for the response next cursor',
      );
    }
    visited.add(key);
    const { page, index } = entry;
    const at = `closure.pages[${index}]`;
    if (index !== traversalIndex) {
      fail(
        'PORTFOLIO_CLOSURE_PAGINATION',
        at,
        'page array order differs from cursor traversal order',
      );
    }
    if (sameRef(page.requestRef, page.responseRef)) {
      fail(
        'PORTFOLIO_CLOSURE_ARTIFACT',
        at,
        'page request and response must be distinct locked artifacts',
      );
    }
    const pageRequestArtifact = readBoundJson(
      reader,
      page.requestRef,
      page.requestDigest,
      `${at}.request`,
    );
    validatePageRequest(
      pageRequestArtifact.document,
      request,
      closure.request.artifactDigest,
      page,
      providerSnapshotToken,
      `${at}.request`,
    );
    const responseArtifact = readBoundJson(
      reader,
      page.responseRef,
      page.responseDigest,
      `${at}.response`,
    );
    validatePageResponse(
      responseArtifact.document,
      request,
      closure.request.artifactDigest,
      pageRequestArtifact.document,
      page.requestDigest,
      page,
      providerSnapshotToken,
      `${at}.response`,
    );
    providerSnapshotToken = responseArtifact.document.providerSnapshotToken;
    const responseKeys = responseArtifact.document.records.map((record) => record.recordKey);
    if (canonicalJcs(page.orderedRecordKeys) !== canonicalJcs(responseKeys)
        || page.recordCount !== responseKeys.length) {
      fail(
        'PORTFOLIO_CLOSURE_OMISSION',
        at,
        'declared ordered keys/count must equal every record in the locked response',
      );
    }
    const actualPageSetDigest = recordSetDigest(responseKeys);
    if (page.recordSetDigest !== actualPageSetDigest) {
      fail(
        'PORTFOLIO_CLOSURE_SET_DIGEST',
        `${at}.recordSetDigest`,
        `declared page set digest does not equal ${actualPageSetDigest}`,
      );
    }
    allRecordBindings.push(...validateRowLocators(
      reader,
      page,
      responseArtifact.bytes,
      responseArtifact.document,
      request,
      profileCache,
      at,
    ));
    for (const recordKey of responseKeys) {
      const token = recordKeyToken(recordKey);
      seenKeyCounts.set(token, (seenKeyCounts.get(token) || 0) + 1);
      allKeys.push(recordKey);
    }
    if (page.terminal) {
      terminalObserved = true;
      break;
    }
    cursor = page.nextCursor;
  }

  if (!terminalObserved) {
    fail('PORTFOLIO_CLOSURE_TERMINAL', 'closure.pages', 'cursor traversal did not reach a terminal page');
  }
  if (visited.size !== closure.pages.length) {
    fail(
      'PORTFOLIO_CLOSURE_EXTRA_PAGE',
      'closure.pages',
      'closure contains a page that is not reachable from the locked initial cursor',
    );
  }
  for (let index = 1; index < allKeys.length; index += 1) {
    if (compareRecordKeys(allKeys[index - 1], allKeys[index]) >= 0) {
      const duplicate = recordKeyToken(allKeys[index - 1]) === recordKeyToken(allKeys[index]);
      fail(
        duplicate ? 'PORTFOLIO_CLOSURE_DUPLICATE_RECORD' : 'PORTFOLIO_CLOSURE_ORDER',
        `records[${index}]`,
        duplicate
          ? 'source contract duplicatePolicy=reject forbids duplicate record keys'
          : 'record keys are not in the source-contract global canonical order',
      );
    }
  }
  const duplicateCount = [...seenKeyCounts.values()]
    .reduce((total, count) => total + Math.max(0, count - 1), 0);
  if (duplicateCount !== 0) {
    fail(
      'PORTFOLIO_CLOSURE_DUPLICATE_RECORD',
      'closure.aggregate.duplicateCount',
      `source contract duplicatePolicy=reject but recomputed duplicate count is ${duplicateCount}`,
    );
  }

  exactKeys(closure.aggregate, [
    'duplicateCount',
    'pageCount',
    'recordSetDigest',
    'terminalObserved',
    'totalRecordCount',
  ], 'closure.aggregate');
  if (!Number.isSafeInteger(closure.aggregate.pageCount)
      || closure.aggregate.pageCount < 1
      || !Number.isSafeInteger(closure.aggregate.totalRecordCount)
      || closure.aggregate.totalRecordCount < 0
      || !Number.isSafeInteger(closure.aggregate.duplicateCount)
      || closure.aggregate.duplicateCount < 0
      || typeof closure.aggregate.terminalObserved !== 'boolean') {
    fail('PORTFOLIO_CLOSURE_AGGREGATE', 'closure.aggregate', 'invalid aggregate scalar fields');
  }
  requireDigest(closure.aggregate.recordSetDigest, 'closure.aggregate.recordSetDigest');
  const aggregateSetDigest = recordSetDigest(allKeys);
  if (closure.aggregate.pageCount !== visited.size
      || closure.aggregate.totalRecordCount !== allKeys.length
      || closure.aggregate.duplicateCount !== duplicateCount
      || closure.aggregate.terminalObserved !== terminalObserved
      || closure.aggregate.recordSetDigest !== aggregateSetDigest) {
    fail(
      'PORTFOLIO_CLOSURE_AGGREGATE',
      'closure.aggregate',
      'aggregate must equal recomputed pageCount/total/setDigest/duplicateCount/terminalObserved',
    );
  }

  return Object.freeze({
    accountLogicalIri: request.accountLogicalIri,
    asOf: request.asOf,
    duplicateCount,
    pageCount: visited.size,
    providerIri: request.providerIri,
    providerSnapshotToken,
    records: allRecordBindings.map((entry) => Object.freeze(entry)),
    recordSetDigest: aggregateSetDigest,
    requestDigest: closure.request.artifactDigest,
    requestIri: request.requestIri,
    sourceContractDigest: request.sourceContractDigest,
    sourceContractRef: structuredClone(request.sourceContractRef),
    sourceContractVersionIri: request.sourceContractVersionIri,
    streamLogicalIri: request.streamLogicalIri,
    streamVersionIri: request.streamVersionIri,
    terminalObserved,
    totalRecordCount: allKeys.length,
  });
}

module.exports = {
  ORDERING,
  PortfolioObservationClosureError,
  compareRecordKeys,
  recordSetDigest,
  sha256,
  verifyPortfolioObservationStreamClosure,
};
