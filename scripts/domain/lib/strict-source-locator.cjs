'use strict';

const crypto = require('crypto');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const POSITIVE_SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;

const COMMON_FIELDS = new Set([
  'kind',
  'path',
  'mediaType',
  'extractorProfileRef',
  'extractorProfileDigest',
  'selectionDigest',
]);

const BRANCH_FIELDS = {
  wholeFile: [],
  textLineRange: ['startLine', 'endLine'],
  textHeading: ['heading', 'occurrence', 'headingLevel'],
  pdfPageRange: ['startPage', 'endPage'],
  pdfNamedSection: ['sectionTitle', 'occurrence', 'startPage', 'endPage'],
  jsonPointer: ['pointer'],
  rdfResource: ['resourceIri', 'graphIri'],
  xmlElement: ['elementId'],
  htmlFragment: ['fragmentId'],
};

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalJcs(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    if (value !== value.normalize('NFC')) throw new Error('JCS string is not Unicode NFC');
    if (hasUnpairedSurrogate(value)) throw new Error('JCS string contains an unpaired Unicode surrogate');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error('JCS profile accepts only safe integers');
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJcs).join(',')}]`;
  if (!isPlainObject(value)) throw new Error('JCS value must be a JSON value');
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${canonicalJcs(key)}:${canonicalJcs(value[key])}`).join(',')}}`;
}

function u64be(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('length is not a non-negative safe integer');
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function computeSelectionDigest(locator, selectedBytes) {
  const bytes = Buffer.isBuffer(selectedBytes) ? selectedBytes : Buffer.from(selectedBytes);
  const withoutDigest = { ...locator };
  delete withoutDigest.selectionDigest;
  const input = Buffer.concat([
    Buffer.from('axiolune-source-selection-v1\0', 'utf8'),
    Buffer.from(canonicalJcs(withoutDigest), 'utf8'),
    u64be(bytes.length),
    bytes,
  ]);
  return `sha256:${crypto.createHash('sha256').update(input).digest('hex')}`;
}

function validateAbsoluteIri(value, at, errors) {
  if (typeof value !== 'string' || value !== value.normalize('NFC') || /\s/.test(value)) {
    errors.push(`${at}: expected an absolute normalized IRI`);
    return;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol) errors.push(`${at}: expected an absolute normalized IRI`);
  } catch {
    errors.push(`${at}: expected an absolute normalized IRI`);
  }
}

function validateArtifactRef(value, at = 'artifactRef') {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: [`${at}: expected a closed object`] };
  if (value.kind === 'iri') {
    const allowed = new Set(['kind', 'iri']);
    for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${at}.${key}: unknown field`);
    if (Object.keys(value).length !== 2) errors.push(`${at}: iri branch requires exactly kind and iri`);
    validateAbsoluteIri(value.iri, `${at}.iri`, errors);
  } else if (value.kind === 'path') {
    const allowed = new Set(['kind', 'root', 'path']);
    for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${at}.${key}: unknown field`);
    if (!['sourceTree', 'buildEvidence', 'payload', 'adoptionEvidence'].includes(value.root)) {
      errors.push(`${at}.root: unsupported artifact root`);
    }
    validatePosixPath(value.path, `${at}.path`, errors);
  } else {
    errors.push(`${at}.kind: expected iri or path`);
  }
  return { ok: errors.length === 0, errors };
}

function validatePosixPath(value, at, errors) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')) {
    errors.push(`${at}: expected a non-empty Unicode-NFC path`);
    return;
  }
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    errors.push(`${at}: expected a POSIX relative path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    errors.push(`${at}: empty, dot, and parent segments are forbidden`);
  }
}

function positiveSafeInteger(value, at, errors) {
  if (!Number.isSafeInteger(value) || value < 1 || value > POSITIVE_SAFE_INTEGER_MAX) {
    errors.push(`${at}: expected a positive safe integer`);
  }
}

function nonEmptyNfc(value, at, errors) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')) {
    errors.push(`${at}: expected a non-empty Unicode-NFC string`);
  }
}

function mediaAllows(kind, mediaType) {
  if (kind === 'wholeFile') return true;
  if (kind === 'textLineRange' || kind === 'textHeading') {
    return mediaType.startsWith('text/')
      || mediaType === 'application/json'
      || mediaType.endsWith('+json')
      || mediaType === 'application/xml'
      || mediaType.endsWith('+xml')
      || mediaType === 'application/yaml'
      || mediaType === 'application/x-yaml';
  }
  if (kind === 'pdfPageRange' || kind === 'pdfNamedSection') return mediaType === 'application/pdf';
  if (kind === 'jsonPointer') return mediaType === 'application/json' || mediaType.endsWith('+json');
  if (kind === 'rdfResource') {
    return [
      'text/turtle',
      'application/n-triples',
      'application/n-quads',
      'application/trig',
      'application/rdf+xml',
      'application/ld+json',
    ].includes(mediaType);
  }
  if (kind === 'xmlElement') return mediaType === 'application/xml' || mediaType === 'text/xml' || mediaType.endsWith('+xml');
  if (kind === 'htmlFragment') return mediaType === 'text/html' || mediaType === 'application/xhtml+xml';
  return false;
}

function validateSourceLocator(value, options = {}) {
  const at = options.at || 'sourceLocator';
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: [`${at}: expected a closed object`] };
  if (!Object.prototype.hasOwnProperty.call(BRANCH_FIELDS, value.kind)) {
    return { ok: false, errors: [`${at}.kind: unsupported SourceLocator branch`] };
  }

  const allowed = new Set([...COMMON_FIELDS, ...BRANCH_FIELDS[value.kind]]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${at}.${key}: unknown or cross-branch field`);
  for (const field of COMMON_FIELDS) if (!(field in value)) errors.push(`${at}.${field}: missing required field`);

  validatePosixPath(value.path, `${at}.path`, errors);
  if (typeof value.mediaType !== 'string' || !MEDIA_TYPE_RE.test(value.mediaType)) {
    errors.push(`${at}.mediaType: expected a canonical lowercase IANA media type without parameters`);
  } else if (!mediaAllows(value.kind, value.mediaType)) {
    errors.push(`${at}.mediaType: media type is incompatible with ${value.kind}`);
  }
  errors.push(...validateArtifactRef(value.extractorProfileRef, `${at}.extractorProfileRef`).errors);
  if (!DIGEST_RE.test(value.extractorProfileDigest || '')) errors.push(`${at}.extractorProfileDigest: invalid Digest`);
  if (!DIGEST_RE.test(value.selectionDigest || '')) errors.push(`${at}.selectionDigest: invalid Digest`);

  if (value.kind === 'textLineRange') {
    positiveSafeInteger(value.startLine, `${at}.startLine`, errors);
    positiveSafeInteger(value.endLine, `${at}.endLine`, errors);
    if (value.startLine > value.endLine) errors.push(`${at}: startLine must not exceed endLine`);
  } else if (value.kind === 'textHeading') {
    nonEmptyNfc(value.heading, `${at}.heading`, errors);
    positiveSafeInteger(value.occurrence, `${at}.occurrence`, errors);
    if ('headingLevel' in value) positiveSafeInteger(value.headingLevel, `${at}.headingLevel`, errors);
  } else if (value.kind === 'pdfPageRange') {
    positiveSafeInteger(value.startPage, `${at}.startPage`, errors);
    positiveSafeInteger(value.endPage, `${at}.endPage`, errors);
    if (value.startPage > value.endPage) errors.push(`${at}: startPage must not exceed endPage`);
  } else if (value.kind === 'pdfNamedSection') {
    nonEmptyNfc(value.sectionTitle, `${at}.sectionTitle`, errors);
    positiveSafeInteger(value.occurrence, `${at}.occurrence`, errors);
    if (('startPage' in value) !== ('endPage' in value)) errors.push(`${at}: startPage and endPage must be both present or both absent`);
    if ('startPage' in value) {
      positiveSafeInteger(value.startPage, `${at}.startPage`, errors);
      positiveSafeInteger(value.endPage, `${at}.endPage`, errors);
      if (value.startPage > value.endPage) errors.push(`${at}: startPage must not exceed endPage`);
    }
  } else if (value.kind === 'jsonPointer') {
    if (typeof value.pointer !== 'string'
        || value.pointer !== value.pointer.normalize('NFC')
        || hasUnpairedSurrogate(value.pointer)
        || (value.pointer !== '' && !value.pointer.startsWith('/'))
        || /~(?![01])/u.test(value.pointer)) {
      errors.push(`${at}.pointer: invalid canonical RFC 6901 JSON Pointer`);
    }
  } else if (value.kind === 'rdfResource') {
    validateAbsoluteIri(value.resourceIri, `${at}.resourceIri`, errors);
    if ('graphIri' in value) validateAbsoluteIri(value.graphIri, `${at}.graphIri`, errors);
  } else if (value.kind === 'xmlElement') {
    if (typeof value.elementId !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value.elementId)) {
      errors.push(`${at}.elementId: invalid XML ID`);
    }
  } else if (value.kind === 'htmlFragment') {
    nonEmptyNfc(value.fragmentId, `${at}.fragmentId`, errors);
  }

  if (options.selectedBytes !== undefined && DIGEST_RE.test(value.selectionDigest || '')) {
    let actual;
    try {
      actual = computeSelectionDigest(value, options.selectedBytes);
    } catch (error) {
      errors.push(`${at}: cannot canonicalize locator: ${error.message}`);
    }
    if (actual && actual !== value.selectionDigest) errors.push(`${at}.selectionDigest: selected-byte digest mismatch`);
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  canonicalJcs,
  computeSelectionDigest,
  validateArtifactRef,
  validateSourceLocator,
};
