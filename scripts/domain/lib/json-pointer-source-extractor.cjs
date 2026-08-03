'use strict';

const { TextDecoder } = require('node:util');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const ARRAY_INDEX_RE = /^(?:0|[1-9][0-9]*)$/u;
const HEX4_RE = /^[0-9A-Fa-f]{4}$/u;

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

function assertUnicodeScalarTree(value, at = '$') {
  if (typeof value === 'string') {
    if (hasUnpairedSurrogate(value)) {
      throw new Error(`${at} contains an unpaired Unicode surrogate`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertUnicodeScalarTree(entry, `${at}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (hasUnpairedSurrogate(key)) {
        throw new Error(`${at} contains an object key with an unpaired Unicode surrogate`);
      }
      assertUnicodeScalarTree(entry, `${at}.${key}`);
    }
  }
}

/**
 * Parse JSON while rejecting duplicate decoded member names at every depth.
 *
 * JSON.parse silently keeps the last duplicate member, which cannot establish
 * an unambiguous evidence locator. This scanner validates the complete JSON
 * grammar and records decoded keys before JSON.parse constructs the value.
 */
function parseJsonRejectingDuplicateMembers(text) {
  let offset = 0;

  function fail(message) {
    throw new Error(`${message} at UTF-16 offset ${offset}`);
  }

  function skipWhitespace() {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[offset])) {
      offset += 1;
    }
  }

  function scanString() {
    if (text[offset] !== '"') fail('expected a JSON string');
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const character = text[offset];
      const code = text.charCodeAt(offset);
      if (character === '"') {
        offset += 1;
        const raw = text.slice(start, offset);
        let decoded;
        try {
          decoded = JSON.parse(raw);
        } catch (error) {
          fail(`invalid JSON string: ${error.message}`);
        }
        if (hasUnpairedSurrogate(decoded)) fail('JSON string contains an unpaired Unicode surrogate');
        return decoded;
      }
      if (code <= 0x1f) fail('unescaped control character in JSON string');
      if (character === '\\') {
        offset += 1;
        if (offset >= text.length) fail('unterminated JSON string escape');
        const escape = text[offset];
        if (escape === 'u') {
          const digits = text.slice(offset + 1, offset + 5);
          if (!HEX4_RE.test(digits)) fail('invalid JSON Unicode escape');
          offset += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escape)) fail('invalid JSON string escape');
      }
      offset += 1;
    }
    fail('unterminated JSON string');
  }

  function scanNumber() {
    const remainder = text.slice(offset);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(remainder);
    if (!match) fail('invalid JSON number');
    offset += match[0].length;
  }

  function scanArray() {
    offset += 1;
    skipWhitespace();
    if (text[offset] === ']') {
      offset += 1;
      return;
    }
    for (;;) {
      scanValue();
      skipWhitespace();
      if (text[offset] === ']') {
        offset += 1;
        return;
      }
      if (text[offset] !== ',') fail('expected comma or closing bracket');
      offset += 1;
      skipWhitespace();
    }
  }

  function scanObject() {
    offset += 1;
    skipWhitespace();
    const keys = new Set();
    if (text[offset] === '}') {
      offset += 1;
      return;
    }
    for (;;) {
      const key = scanString();
      if (keys.has(key)) fail(`duplicate JSON member ${JSON.stringify(key)}`);
      keys.add(key);
      skipWhitespace();
      if (text[offset] !== ':') fail('expected colon after JSON member name');
      offset += 1;
      skipWhitespace();
      scanValue();
      skipWhitespace();
      if (text[offset] === '}') {
        offset += 1;
        return;
      }
      if (text[offset] !== ',') fail('expected comma or closing brace');
      offset += 1;
      skipWhitespace();
    }
  }

  function scanValue() {
    skipWhitespace();
    const character = text[offset];
    if (character === '"') {
      scanString();
    } else if (character === '{') {
      scanObject();
    } else if (character === '[') {
      scanArray();
    } else if (character === '-' || /[0-9]/u.test(character || '')) {
      scanNumber();
    } else if (text.startsWith('true', offset)) {
      offset += 4;
    } else if (text.startsWith('false', offset)) {
      offset += 5;
    } else if (text.startsWith('null', offset)) {
      offset += 4;
    } else {
      fail('expected a JSON value');
    }
  }

  skipWhitespace();
  scanValue();
  skipWhitespace();
  if (offset !== text.length) fail('unexpected bytes after the JSON value');
  return JSON.parse(text);
}

function decodePointerToken(token) {
  return token.replace(/~1/gu, '/').replace(/~0/gu, '~');
}

function resolveJsonPointer(root, pointer) {
  if (typeof pointer !== 'string'
      || (pointer !== '' && !pointer.startsWith('/'))
      || /~(?![01])/u.test(pointer)) {
    throw new Error('pointer must be a canonical RFC 6901 JSON Pointer');
  }
  if (pointer === '') return root;
  let current = root;
  const tokens = pointer.slice(1).split('/').map(decodePointerToken);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX_RE.test(token)) {
        throw new Error(`pointer token ${index} is not a canonical array index`);
      }
      const arrayIndex = Number(token);
      if (!Number.isSafeInteger(arrayIndex) || arrayIndex >= current.length) {
        throw new Error(`pointer token ${index} is outside the selected array`);
      }
      current = current[arrayIndex];
    } else if (current !== null && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        throw new Error(`pointer token ${index} does not select an object member`);
      }
      current = current[token];
    } else {
      throw new Error(`pointer token ${index} cannot traverse a scalar value`);
    }
  }
  return current;
}

function extractJsonPointerJcsBytes(sourceBytes, pointer) {
  if (!Buffer.isBuffer(sourceBytes)) throw new TypeError('sourceBytes must be a Buffer');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
  } catch (error) {
    throw new Error(`JSON source is not valid UTF-8: ${error.message}`);
  }
  if (text.charCodeAt(0) === 0xfeff) throw new Error('JSON source must not contain a UTF-8 BOM');
  const document = parseJsonRejectingDuplicateMembers(text);
  const selected = resolveJsonPointer(document, pointer);
  assertUnicodeScalarTree(selected);
  let canonical;
  try {
    canonical = canonicalJcs(selected);
  } catch (error) {
    throw new Error(`selected JSON value is outside the locked JCS profile: ${error.message}`);
  }
  const bytes = Buffer.from(canonical, 'utf8');
  if (bytes.length === 0) throw new Error('JSON Pointer selected an empty canonical value');
  return bytes;
}

module.exports = {
  extractJsonPointerJcsBytes,
  parseJsonRejectingDuplicateMembers,
  resolveJsonPointer,
};
