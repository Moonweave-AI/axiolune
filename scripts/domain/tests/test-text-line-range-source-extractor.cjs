#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  decodeUtf8Lines,
  extractTextLineRangeBytes,
} = require('../lib/text-line-range-source-extractor.cjs');

test('line extraction is one-based, inclusive, and independent of LF versus CRLF framing', () => {
  const lf = extractTextLineRangeBytes(Buffer.from('alpha\nbeta\ngamma\n'), 2, 3);
  const crlf = extractTextLineRangeBytes(Buffer.from('alpha\r\nbeta\r\ngamma\r\n'), 2, 3);
  assert.deepEqual(lf, crlf);
  assert.equal(lf.readBigUInt64BE(0), 2n);
  assert.equal(lf.readBigUInt64BE(8), 2n);
  assert.equal(lf.readBigUInt64BE(16), 4n);
  assert.equal(lf.subarray(24, 28).toString('utf8'), 'beta');
});

test('line identity is part of selected bytes', () => {
  const source = Buffer.from('same\nsame\n');
  assert.notDeepEqual(
    extractTextLineRangeBytes(source, 1, 1),
    extractTextLineRangeBytes(source, 2, 2),
  );
});

test('final line without a terminator is selectable', () => {
  assert.deepEqual(decodeUtf8Lines(Buffer.from('alpha\nbeta')), ['alpha', 'beta']);
  assert.doesNotThrow(() => extractTextLineRangeBytes(Buffer.from('alpha\nbeta'), 2, 2));
});

test('ambiguous or invalid source bytes fail closed', () => {
  assert.throws(() => decodeUtf8Lines(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), /BOM/u);
  assert.throws(() => decodeUtf8Lines(Buffer.from([0xc3, 0x28])), /valid UTF-8/u);
  assert.throws(() => decodeUtf8Lines(Buffer.from('alpha\rbeta')), /lone CR/u);
  assert.throws(() => decodeUtf8Lines(Buffer.from('alpha\u0000beta')), /NUL/u);
});

test('invalid and out-of-bounds ranges fail closed', () => {
  const source = Buffer.from('alpha\nbeta\n');
  assert.throws(() => extractTextLineRangeBytes(source, 0, 1), /one-based/u);
  assert.throws(() => extractTextLineRangeBytes(source, 2, 1), /non-reversed/u);
  assert.throws(() => extractTextLineRangeBytes(source, 1, 3), /source has 2/u);
});
