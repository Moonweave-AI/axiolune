'use strict';

const { TextDecoder } = require('node:util');

function u64be(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('text-line frame value must be a non-negative safe integer');
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function decodeUtf8Lines(sourceBytes) {
  const bytes = Buffer.isBuffer(sourceBytes) ? sourceBytes : Buffer.from(sourceBytes);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error('UTF-8 BOM is forbidden');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`source is not valid UTF-8: ${error.message}`);
  }
  if (text.includes('\u0000')) throw new Error('NUL is forbidden in line-oriented source text');
  if (/(?:^|[^\r])\r(?:[^\n]|$)/u.test(text) || /\r$/u.test(text)) {
    throw new Error('lone CR is forbidden; line endings must be LF or CRLF');
  }
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function extractTextLineRangeBytes(sourceBytes, startLine, endLine) {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
      || startLine < 1 || endLine < startLine) {
    throw new Error('text line range must be one-based, inclusive, and non-reversed');
  }
  const lines = decodeUtf8Lines(sourceBytes);
  if (endLine > lines.length) {
    throw new Error(`text line range ends at ${endLine}, but source has ${lines.length} logical lines`);
  }
  const selected = lines.slice(startLine - 1, endLine);
  const parts = [u64be(selected.length)];
  selected.forEach((line, offset) => {
    const lineBytes = Buffer.from(line, 'utf8');
    parts.push(u64be(startLine + offset), u64be(lineBytes.length), lineBytes);
  });
  return Buffer.concat(parts);
}

module.exports = {
  decodeUtf8Lines,
  extractTextLineRangeBytes,
};
