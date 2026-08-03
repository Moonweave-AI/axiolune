'use strict';

const { TextDecoder } = require('node:util');

const XML_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;

function utf8ByteOffset(text, characterOffset) {
  return Buffer.byteLength(text.slice(0, characterOffset), 'utf8');
}

function findMarkupEnd(text, start) {
  let quote = null;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  throw new Error('unterminated XML markup');
}

function skipDelimited(text, start, opening, closing) {
  const end = text.indexOf(closing, start + opening.length);
  if (end < 0) throw new Error(`unterminated XML ${opening} section`);
  return end + closing.length;
}

/**
 * Select the exact source-byte span occupied by one unnamespaced XML element.
 *
 * This deliberately supports only the narrow profile used by the official
 * ISO 4217 lists. It fails closed for DTD/entity declarations, namespaces,
 * duplicate elements, self-closing elements, and invalid UTF-8 instead of
 * pretending that a partial XML parser established an exact selection.
 */
function extractUniqueXmlElementBytes(sourceBytes, elementId) {
  if (!Buffer.isBuffer(sourceBytes)) throw new TypeError('sourceBytes must be a Buffer');
  if (typeof elementId !== 'string' || !XML_NAME_RE.test(elementId)) {
    throw new Error('elementId must be an unnamespaced XML name');
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
  } catch (error) {
    throw new Error(`XML source is not valid UTF-8: ${error.message}`);
  }
  if (/<!DOCTYPE\b/iu.test(text) || /<!ENTITY\b/iu.test(text)) {
    throw new Error('DTD and entity declarations are forbidden by the XML selector profile');
  }

  const openings = [];
  const closings = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf('<', index);
    if (start < 0) break;
    if (text.startsWith('<!--', start)) {
      index = skipDelimited(text, start, '<!--', '-->');
      continue;
    }
    if (text.startsWith('<![CDATA[', start)) {
      index = skipDelimited(text, start, '<![CDATA[', ']]>');
      continue;
    }
    if (text.startsWith('<?', start)) {
      index = skipDelimited(text, start, '<?', '?>');
      continue;
    }
    if (text.startsWith('<!', start)) {
      throw new Error('unsupported XML declaration is forbidden by the selector profile');
    }
    const end = findMarkupEnd(text, start + 1);
    const raw = text.slice(start + 1, end);
    const closing = raw.startsWith('/');
    const body = closing ? raw.slice(1).trimStart() : raw.trimStart();
    const name = /^([A-Za-z_][A-Za-z0-9_.:-]*)/u.exec(body)?.[1];
    if (name === elementId) {
      if (closing) {
        closings.push({ start, end: end + 1 });
      } else if (/\/\s*$/u.test(raw)) {
        throw new Error(`${elementId} must be a non-self-closing element`);
      } else {
        openings.push({ start, end: end + 1 });
      }
    }
    index = end + 1;
  }

  if (openings.length !== 1 || closings.length !== 1) {
    throw new Error(
      `expected exactly one non-self-closing ${elementId} element; found ${openings.length} opening and ${closings.length} closing tags`,
    );
  }

  if (closings[0].start <= openings[0].start) {
    throw new Error(`${elementId} closing tag does not follow its opening tag`);
  }
  const startByteOffset = utf8ByteOffset(text, openings[0].start);
  const endByteOffset = utf8ByteOffset(text, closings[0].end);
  const selected = sourceBytes.subarray(startByteOffset, endByteOffset);
  if (selected.length === 0) throw new Error(`${elementId} selected an empty byte span`);
  return selected;
}

module.exports = {
  extractUniqueXmlElementBytes,
};
