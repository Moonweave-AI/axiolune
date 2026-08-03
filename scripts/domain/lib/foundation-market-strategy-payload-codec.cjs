'use strict';

const DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)\.[0-9]+$/u;

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function encodePointerToken(value) {
  return String(value).replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function decodePointerToken(value) {
  if (/~(?:[^01]|$)/u.test(value)) throw new TypeError(`invalid JSON Pointer token ${value}`);
  return value.replace(/~1/gu, '/').replace(/~0/gu, '~');
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function encodeCanonicalEvidencePayload(value) {
  const decimalPaths = [];

  function visit(current, path) {
    if (current === null || typeof current === 'boolean' || typeof current === 'string') {
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        throw new TypeError(`evidence payload contains a non-canonical number at ${path || '/'}`);
      }
      if (Number.isSafeInteger(current)) return current;
      if (Number.isInteger(current)) {
        throw new TypeError(`evidence payload contains an unsafe integer at ${path || '/'}`);
      }
      const lexical = String(current);
      if (!DECIMAL_RE.test(lexical)) {
        throw new TypeError(
          `evidence payload decimal at ${path || '/'} must be authored as a non-exponent canonical decimal string`,
        );
      }
      decimalPaths.push(path);
      return lexical;
    }
    if (Array.isArray(current)) {
      return current.map((entry, index) => visit(entry, `${path}/${index}`));
    }
    if (!isPlainObject(current)) {
      throw new TypeError(`evidence payload contains a non-JSON value at ${path || '/'}`);
    }
    const encoded = {};
    for (const key of Object.keys(current)) {
      encoded[key] = visit(current[key], `${path}/${encodePointerToken(key)}`);
    }
    return encoded;
  }

  const payload = visit(value, '');
  decimalPaths.sort(compareUtf8);
  return { decimalPaths, payload };
}

function validateEvidenceNumbers(value, path = '') {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError(
        `signed evidence permits only safe integers as JSON numbers; use decimalPaths for ${path || '/'}`,
      );
    }
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateEvidenceNumbers(entry, `${path}/${index}`));
    return;
  }
  if (!isPlainObject(value)) throw new TypeError(`signed evidence contains a non-JSON value at ${path || '/'}`);
  for (const [key, entry] of Object.entries(value)) {
    validateEvidenceNumbers(entry, `${path}/${encodePointerToken(key)}`);
  }
}

function resolvePointerParent(root, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer === '/') {
    throw new TypeError(`decimal path must be a non-root JSON Pointer: ${String(pointer)}`);
  }
  const tokens = pointer.slice(1).split('/').map(decodePointerToken);
  let parent = root;
  for (const token of tokens.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, token)) {
      throw new TypeError(`decimal path does not resolve: ${pointer}`);
    }
    parent = parent[token];
  }
  const leaf = tokens.at(-1);
  if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, leaf)) {
    throw new TypeError(`decimal path does not resolve: ${pointer}`);
  }
  return { leaf, parent };
}

function decodeCanonicalEvidencePayload(payload, decimalPaths) {
  validateEvidenceNumbers(payload);
  if (!Array.isArray(decimalPaths)
      || decimalPaths.some((pointer) => typeof pointer !== 'string')
      || new Set(decimalPaths).size !== decimalPaths.length
      || decimalPaths.some((pointer, index) => (
        index > 0 && compareUtf8(decimalPaths[index - 1], pointer) >= 0
      ))) {
    throw new TypeError('decimalPaths must be a strictly UTF-8-sorted unique string array');
  }
  const decoded = structuredClone(payload);
  for (const pointer of decimalPaths) {
    const { parent, leaf } = resolvePointerParent(decoded, pointer);
    const lexical = parent[leaf];
    if (typeof lexical !== 'string' || !DECIMAL_RE.test(lexical)) {
      throw new TypeError(`decimal path ${pointer} must select a canonical non-exponent decimal string`);
    }
    const value = Number(lexical);
    if (!Number.isFinite(value)
        || Object.is(value, -0)
        || Number.isInteger(value)
        || String(value) !== lexical) {
      throw new TypeError(
        `decimal path ${pointer} must be the lossless canonical lexical form of one runtime decimal`,
      );
    }
    parent[leaf] = value;
  }
  return decoded;
}

function setJsonPointerValue(root, pointer, value) {
  const { parent, leaf } = resolvePointerParent(root, pointer);
  parent[leaf] = value;
}

function getJsonPointerValue(root, pointer) {
  const { parent, leaf } = resolvePointerParent(root, pointer);
  return parent[leaf];
}

module.exports = {
  decodeCanonicalEvidencePayload,
  encodeCanonicalEvidencePayload,
  getJsonPointerValue,
  setJsonPointerValue,
  validateEvidenceNumbers,
};
