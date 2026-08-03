'use strict';

const { TextDecoder } = require('node:util');

const RDF_NAMESPACE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const XML_NAME = '[A-Za-z_][A-Za-z0-9_.-]*';
const QNAME_RE = new RegExp(`^(?:${XML_NAME})(?::${XML_NAME})?$`, 'u');
const ENTITY_NAME_RE = new RegExp(`^${XML_NAME}$`, 'u');

function byteOffset(text, characterOffset) {
  return Buffer.byteLength(text.slice(0, characterOffset), 'utf8');
}

function findMarkupEnd(text, start) {
  let quote = null;
  for (let index = start; index < text.length; index += 1) {
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

function findDoctypeEnd(text, start) {
  let quote = null;
  let subsetDepth = 0;
  for (let index = start + '<!DOCTYPE'.length; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '[') {
      subsetDepth += 1;
    } else if (character === ']') {
      subsetDepth -= 1;
      if (subsetDepth < 0) throw new Error('malformed XML DOCTYPE internal subset');
    } else if (character === '>' && subsetDepth === 0) {
      return index + 1;
    }
  }
  throw new Error('unterminated XML DOCTYPE');
}

function skipDelimited(text, start, opening, closing) {
  const end = text.indexOf(closing, start + opening.length);
  if (end < 0) throw new Error(`unterminated XML ${opening} section`);
  return end + closing.length;
}

function absoluteIri(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /\s/u.test(value)) {
    throw new Error(`${label} must be an absolute IRI`);
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol) throw new Error('missing protocol');
  } catch {
    throw new Error(`${label} must be an absolute IRI`);
  }
}

function parseInternalEntities(doctype) {
  const entities = new Map();
  if (doctype === null) return entities;
  if (/\b(?:SYSTEM|PUBLIC)\b/iu.test(doctype)
      || /<!ENTITY\s+%/iu.test(doctype)
      || /%[A-Za-z_][A-Za-z0-9_.-]*;/u.test(doctype)) {
    throw new Error('external and parameter entities are forbidden by the RDF/XML selector profile');
  }
  const open = doctype.indexOf('[');
  if (open < 0) return entities;
  const close = doctype.lastIndexOf(']');
  if (close <= open) throw new Error('malformed XML DOCTYPE internal subset');
  const subset = doctype.slice(open + 1, close);
  let index = 0;
  while (index < subset.length) {
    const whitespace = /^[\t\n\r ]*/u.exec(subset.slice(index))[0];
    index += whitespace.length;
    if (index === subset.length) break;
    if (!subset.startsWith('<!ENTITY', index)) {
      throw new Error('DOCTYPE may contain only internal general IRI entity declarations');
    }
    const end = findMarkupEnd(subset, index + '<!ENTITY'.length);
    const declaration = subset.slice(index, end + 1);
    const match = /^<!ENTITY\s+([A-Za-z_][A-Za-z0-9_.-]*)\s+(?:"([^"<>]*)"|'([^'<>]*)')\s*>$/u.exec(declaration);
    if (!match) throw new Error('unsupported internal entity declaration');
    const [, name, doubleQuoted, singleQuoted] = match;
    const replacement = doubleQuoted === undefined ? singleQuoted : doubleQuoted;
    if (entities.has(name)) throw new Error(`duplicate internal entity ${name}`);
    if (/[&%]/u.test(replacement)) {
      throw new Error(`nested entity replacement is forbidden for ${name}`);
    }
    absoluteIri(replacement, `internal entity ${name}`);
    entities.set(name, replacement);
    index = end + 1;
  }
  return entities;
}

function codePoint(reference) {
  const radix = reference.startsWith('#x') ? 16 : 10;
  const digits = radix === 16 ? reference.slice(2) : reference.slice(1);
  if (digits.length === 0 || !(radix === 16 ? /^[0-9A-Fa-f]+$/u : /^\d+$/u).test(digits)) {
    throw new Error(`invalid XML character reference &${reference};`);
  }
  const value = Number.parseInt(digits, radix);
  if (value === 0
      || value > 0x10ffff
      || (value >= 0xd800 && value <= 0xdfff)
      || (value < 0x20 && ![0x9, 0xa, 0xd].includes(value))) {
    throw new Error(`forbidden XML character reference &${reference};`);
  }
  return String.fromCodePoint(value);
}

function decodeAttribute(value, entities) {
  const builtins = new Map([
    ['amp', '&'],
    ['apos', "'"],
    ['gt', '>'],
    ['lt', '<'],
    ['quot', '"'],
  ]);
  let result = '';
  let cursor = 0;
  const reference = /&(#x[0-9A-Fa-f]+|#\d+|[A-Za-z_][A-Za-z0-9_.-]*);/gu;
  for (let match = reference.exec(value); match; match = reference.exec(value)) {
    const prefix = value.slice(cursor, match.index);
    if (prefix.indexOf('&') >= 0) throw new Error('malformed XML entity reference');
    result += prefix;
    const name = match[1];
    if (name.startsWith('#')) {
      result += codePoint(name);
    } else if (builtins.has(name)) {
      result += builtins.get(name);
    } else if (entities.has(name)) {
      result += entities.get(name);
    } else {
      throw new Error(`undeclared XML entity ${name}`);
    }
    cursor = match.index + match[0].length;
  }
  const suffix = value.slice(cursor);
  if (suffix.indexOf('&') >= 0) throw new Error('malformed XML entity reference');
  return result + suffix;
}

function parseOpening(raw) {
  let cursor = 0;
  const whitespace = () => {
    const match = /^[\t\n\r ]*/u.exec(raw.slice(cursor))[0];
    cursor += match.length;
    return match.length;
  };
  whitespace();
  const nameMatch = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/u.exec(raw.slice(cursor));
  if (!nameMatch) throw new Error('opening tag has an invalid QName');
  const qname = nameMatch[0];
  cursor += qname.length;
  const attributes = [];
  const names = new Set();
  let selfClosing = false;
  for (;;) {
    const spaceCount = whitespace();
    if (cursor === raw.length) break;
    if (raw[cursor] === '/') {
      cursor += 1;
      whitespace();
      if (cursor !== raw.length) throw new Error('unexpected content after self-closing slash');
      selfClosing = true;
      break;
    }
    if (spaceCount === 0) throw new Error('XML attributes must be whitespace-separated');
    const attributeMatch = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/u.exec(raw.slice(cursor));
    if (!attributeMatch) throw new Error('attribute has an invalid QName');
    const attributeName = attributeMatch[0];
    if (names.has(attributeName)) throw new Error(`duplicate XML attribute ${attributeName}`);
    names.add(attributeName);
    cursor += attributeName.length;
    whitespace();
    if (raw[cursor] !== '=') throw new Error(`attribute ${attributeName} is missing =`);
    cursor += 1;
    whitespace();
    const quote = raw[cursor];
    if (quote !== '"' && quote !== "'") throw new Error(`attribute ${attributeName} must be quoted`);
    cursor += 1;
    const end = raw.indexOf(quote, cursor);
    if (end < 0) throw new Error(`attribute ${attributeName} has an unterminated value`);
    attributes.push({ name: attributeName, value: raw.slice(cursor, end) });
    cursor = end + 1;
  }
  return { attributes, qname, selfClosing };
}

function splitQName(value) {
  if (!QNAME_RE.test(value)) throw new Error(`invalid QName ${value}`);
  const colon = value.indexOf(':');
  return colon < 0
    ? { prefix: '', localName: value }
    : { prefix: value.slice(0, colon), localName: value.slice(colon + 1) };
}

function resolveAgainstBase(value, base, label) {
  if (typeof value !== 'string' || value.length === 0 || /\s/u.test(value)) {
    throw new Error(`${label} must be a non-empty IRI without whitespace`);
  }
  try {
    const result = base === null ? new URL(value) : new URL(value, base);
    return result.href;
  } catch {
    throw new Error(`${label} cannot be resolved as an IRI`);
  }
}

/**
 * Select the exact original source-byte span of the unique RDF/XML node
 * element whose expanded rdf:about IRI equals resourceIri.
 *
 * This is intentionally a narrow, network-free RDF/XML profile. It expands
 * only safe internal general entities with absolute-IRI replacement text,
 * follows in-scope xmlns/xml:base declarations, and rejects external or
 * parameter entities. Comments and character data never participate in the
 * resource match.
 */
function extractRdfXmlResourceBytes(sourceBytes, resourceIri, graphIri = undefined) {
  if (!Buffer.isBuffer(sourceBytes)) throw new TypeError('sourceBytes must be a Buffer');
  absoluteIri(resourceIri, 'resourceIri');
  if (graphIri !== undefined) {
    throw new Error('graphIri is unsupported by the default-graph-only RDF/XML selector profile');
  }
  if (sourceBytes.length >= 3
      && sourceBytes[0] === 0xef
      && sourceBytes[1] === 0xbb
      && sourceBytes[2] === 0xbf) {
    throw new Error('UTF-8 BOM is forbidden by the RDF/XML selector profile');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
  } catch (error) {
    throw new Error(`RDF/XML source is not valid UTF-8: ${error.message}`);
  }

  let entities = new Map();
  let doctypeSeen = false;
  let documentElementSeen = false;
  let documentElementClosed = false;
  const stack = [];
  const selections = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf('<', index);
    const characterData = text.slice(index, start < 0 ? text.length : start);
    if (stack.length === 0 && /[^\t\n\r ]/u.test(characterData)) {
      throw new Error('non-whitespace character data is forbidden outside the XML document element');
    }
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
    if (text.startsWith('<!DOCTYPE', start)) {
      if (doctypeSeen) throw new Error('multiple XML DOCTYPE declarations are forbidden');
      if (documentElementSeen || stack.length !== 0) {
        throw new Error('XML DOCTYPE must precede the document element');
      }
      const doctypeEnd = findDoctypeEnd(text, start);
      entities = parseInternalEntities(text.slice(start, doctypeEnd));
      doctypeSeen = true;
      index = doctypeEnd;
      continue;
    }
    if (text.startsWith('<!', start)) {
      throw new Error('unsupported XML declaration is forbidden by the RDF/XML selector profile');
    }

    const end = findMarkupEnd(text, start + 1);
    if (text[start + 1] === '/') {
      const qname = text.slice(start + 2, end).trim();
      if (!QNAME_RE.test(qname)) throw new Error('closing tag has an invalid QName');
      const current = stack.pop();
      if (!current || current.qname !== qname) throw new Error(`mismatched closing tag ${qname}`);
      if (current.target) selections.push({ start: current.start, end: end + 1 });
      if (stack.length === 0) documentElementClosed = true;
      index = end + 1;
      continue;
    }

    const parsed = parseOpening(text.slice(start + 1, end));
    const parent = stack.at(-1);
    if (!parent) {
      if (documentElementSeen || documentElementClosed) {
        throw new Error('RDF/XML source must contain exactly one document element');
      }
      documentElementSeen = true;
    }
    const namespaces = new Map(parent?.namespaces || [
      ['xml', XML_NAMESPACE],
    ]);
    for (const attribute of parsed.attributes) {
      if (attribute.name === 'xmlns') {
        const namespace = decodeAttribute(attribute.value, entities);
        if (namespace === XML_NAMESPACE || namespace === XMLNS_NAMESPACE) {
          throw new Error('the default namespace cannot bind a reserved XML namespace');
        }
        namespaces.set('', namespace);
      } else if (attribute.name.startsWith('xmlns:')) {
        const prefix = attribute.name.slice('xmlns:'.length);
        if (!ENTITY_NAME_RE.test(prefix) || prefix === 'xmlns') {
          throw new Error(`invalid namespace prefix ${prefix}`);
        }
        const namespace = decodeAttribute(attribute.value, entities);
        if (prefix === 'xml') {
          if (namespace !== XML_NAMESPACE) {
            throw new Error('the xml prefix must bind the canonical XML namespace');
          }
        } else if (namespace.length === 0
            || namespace === XML_NAMESPACE
            || namespace === XMLNS_NAMESPACE) {
          throw new Error(`namespace prefix ${prefix} cannot bind an empty or reserved XML namespace`);
        }
        namespaces.set(prefix, namespace);
      }
    }

    let base = parent?.base || null;
    const aboutValues = [];
    const expandedAttributeNames = new Set();
    for (const attribute of parsed.attributes) {
      if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) continue;
      const { prefix, localName } = splitQName(attribute.name);
      const namespace = prefix === '' ? '' : namespaces.get(prefix);
      if (prefix !== '' && namespace === undefined) {
        throw new Error(`undeclared namespace prefix ${prefix}`);
      }
      const expanded = `${namespace || ''}\0${localName}`;
      if (expandedAttributeNames.has(expanded)) {
        throw new Error(`duplicate expanded XML attribute ${attribute.name}`);
      }
      expandedAttributeNames.add(expanded);
      const value = decodeAttribute(attribute.value, entities);
      if (namespace === XML_NAMESPACE && localName === 'base') {
        base = resolveAgainstBase(value, base, 'xml:base');
      }
      if (namespace === RDF_NAMESPACE && localName === 'about') aboutValues.push(value);
    }
    if (aboutValues.length > 1) throw new Error('RDF/XML node element has multiple rdf:about values');
    const target = aboutValues.length === 1
      && resolveAgainstBase(aboutValues[0], base, 'rdf:about') === resourceIri;
    const frame = {
      base,
      namespaces,
      qname: parsed.qname,
      start,
      target,
    };
    if (parsed.selfClosing) {
      if (target) selections.push({ start, end: end + 1 });
      if (!parent) documentElementClosed = true;
    } else {
      stack.push(frame);
    }
    index = end + 1;
  }

  if (stack.length !== 0) throw new Error('RDF/XML source ended with unclosed elements');
  if (!documentElementSeen || !documentElementClosed) {
    throw new Error('RDF/XML source has no complete document element');
  }
  if (selections.length !== 1) {
    throw new Error(`expected exactly one rdf:about resource ${resourceIri}; found ${selections.length}`);
  }
  const selected = sourceBytes.subarray(
    byteOffset(text, selections[0].start),
    byteOffset(text, selections[0].end),
  );
  if (selected.length === 0) throw new Error('rdfResource selected an empty source-byte span');
  return selected;
}

module.exports = {
  RDF_NAMESPACE,
  XML_NAMESPACE,
  XMLNS_NAMESPACE,
  extractRdfXmlResourceBytes,
};
