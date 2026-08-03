'use strict';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

function requireNfcString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')) {
    throw new TypeError(`${label} must be a non-empty Unicode-NFC string`);
  }
  return value;
}

function normalizeAbsoluteIri(value) {
  const text = requireNfcString(value, 'IRI');
  if (/[\u0000-\u0020\u007f]/u.test(text)) throw new TypeError('IRI contains forbidden characters');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new TypeError('IRI is not absolute and canonical');
  }
  if (!parsed.protocol || parsed.href !== text) throw new TypeError('IRI is not absolute and canonical');
  return `<${text}>`;
}

function escapeLiteral(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\f', '\\f')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
}

function normalizeString(value) {
  return `"${escapeLiteral(requireNfcString(value, 'string'))}"^^<${XSD}string>`;
}

function normalizeDateTimeStamp(value) {
  const text = requireNfcString(value, 'dateTimeStamp');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(text)) {
    throw new TypeError('dateTimeStamp must be an explicit canonical UTC instant');
  }
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch)) throw new TypeError('dateTimeStamp is not a real instant');
  return `"${text}"^^<${XSD}dateTimeStamp>`;
}

function normalizeNonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('revision must be a non-negative safe integer');
  }
  return `"${String(value)}"^^<${XSD}nonNegativeInteger>`;
}

const ALGORITHMS = Object.freeze({
  absolute_iri_v1: normalizeAbsoluteIri,
  nfc_string_v1: normalizeString,
  utc_datetime_stamp_v1: normalizeDateTimeStamp,
  non_negative_integer_v1: normalizeNonNegativeInteger,
});

function normalize(algorithmId, value) {
  const implementation = ALGORITHMS[algorithmId];
  if (!implementation) throw new TypeError(`unknown normalization algorithm ${String(algorithmId)}`);
  return implementation(value);
}

module.exports = {
  ALGORITHMS,
  normalize,
};
