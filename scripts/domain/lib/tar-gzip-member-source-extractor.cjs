'use strict';

const path = require('node:path');
const zlib = require('node:zlib');
const { TextDecoder } = require('node:util');

const BLOCK_SIZE = 512;
const DEFAULT_MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_EXPANDED_BYTES = 64 * 1024 * 1024;

function decodeField(bytes, at) {
  const nul = bytes.indexOf(0);
  const value = bytes.subarray(0, nul === -1 ? bytes.length : nul);
  if (nul !== -1 && bytes.subarray(nul).some((byte) => byte !== 0)) {
    throw new Error(`${at} contains non-NUL bytes after its terminator`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch (error) {
    throw new Error(`${at} is not valid UTF-8: ${error.message}`);
  }
}

function parseOctal(bytes, at) {
  if ((bytes[0] & 0x80) !== 0) throw new Error(`${at} base-256 encoding is unsupported`);
  const text = Buffer.from(bytes).toString('ascii').replace(/\0.*$/u, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/u.test(text)) throw new Error(`${at} is not canonical octal`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${at} exceeds safe integer range`);
  return value;
}

function assertSafeMemberPath(memberPath, at = 'tar member path') {
  if (typeof memberPath !== 'string' || memberPath.length === 0
      || memberPath !== memberPath.normalize('NFC')
      || memberPath.includes('\\') || memberPath.startsWith('/')
      || /^[A-Za-z]:/u.test(memberPath)) {
    throw new Error(`${at} must be one normalized relative POSIX path`);
  }
  const normalized = path.posix.normalize(memberPath);
  if (normalized !== memberPath
      || memberPath.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${at} contains an unsafe path segment`);
  }
}

function headerChecksum(header) {
  let checksum = 0;
  for (let index = 0; index < header.length; index += 1) {
    checksum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return checksum;
}

function parseTarRegularFiles(tarBytes, options = {}) {
  const bytes = Buffer.isBuffer(tarBytes) ? tarBytes : Buffer.from(tarBytes);
  const maxExpandedBytes = options.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES;
  if (!Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < BLOCK_SIZE) {
    throw new Error('maxExpandedBytes must be a positive safe integer of at least one tar block');
  }
  if (bytes.length > maxExpandedBytes) throw new Error('expanded tar exceeds the configured byte limit');
  if (bytes.length % BLOCK_SIZE !== 0) throw new Error('tar byte length is not a multiple of 512');
  const files = new Map();
  let offset = 0;
  let sawTerminator = false;
  while (offset < bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      sawTerminator = true;
      if (!bytes.subarray(offset).every((byte) => byte === 0)) {
        throw new Error('tar contains non-zero bytes after the zero-block terminator');
      }
      break;
    }
    const recordedChecksum = parseOctal(header.subarray(148, 156), 'tar header checksum');
    const actualChecksum = headerChecksum(header);
    if (recordedChecksum !== actualChecksum) {
      throw new Error(`tar header checksum mismatch: expected ${recordedChecksum}, got ${actualChecksum}`);
    }
    const name = decodeField(header.subarray(0, 100), 'tar name');
    const prefix = decodeField(header.subarray(345, 500), 'tar prefix');
    const memberPath = prefix ? `${prefix}/${name}` : name;
    assertSafeMemberPath(memberPath);
    const typeFlag = header[156];
    if (typeFlag !== 0 && typeFlag !== 0x30) {
      throw new Error(`tar member ${memberPath} is not a regular file`);
    }
    if (decodeField(header.subarray(157, 257), `tar member ${memberPath} link name`) !== '') {
      throw new Error(`tar member ${memberPath} unexpectedly names a link target`);
    }
    const size = parseOctal(header.subarray(124, 136), `tar member ${memberPath} size`);
    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) throw new Error(`tar member ${memberPath} exceeds archive bounds`);
    if (files.has(memberPath)) throw new Error(`tar contains duplicate member ${memberPath}`);
    files.set(memberPath, Buffer.from(bytes.subarray(dataStart, dataEnd)));
    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }
  if (!sawTerminator) throw new Error('tar is missing its zero-block terminator');
  return files;
}

function extractTarGzipMembers(archiveBytes, memberPaths, options = {}) {
  const compressed = Buffer.isBuffer(archiveBytes) ? archiveBytes : Buffer.from(archiveBytes);
  const maxCompressedBytes = options.maxCompressedBytes ?? DEFAULT_MAX_COMPRESSED_BYTES;
  const maxExpandedBytes = options.maxExpandedBytes ?? DEFAULT_MAX_EXPANDED_BYTES;
  if (!Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes < 1) {
    throw new Error('maxCompressedBytes must be a positive safe integer');
  }
  if (compressed.length > maxCompressedBytes) throw new Error('gzip archive exceeds the configured byte limit');
  if (!Array.isArray(memberPaths) || memberPaths.length === 0) {
    throw new Error('memberPaths must be a non-empty array');
  }
  const requested = new Set();
  memberPaths.forEach((memberPath, index) => {
    assertSafeMemberPath(memberPath, `memberPaths[${index}]`);
    if (requested.has(memberPath)) throw new Error(`duplicate requested member ${memberPath}`);
    requested.add(memberPath);
  });
  let tarBytes;
  try {
    tarBytes = zlib.gunzipSync(compressed, { maxOutputLength: maxExpandedBytes });
  } catch (error) {
    throw new Error(`gzip decompression failed: ${error.message}`);
  }
  const files = parseTarRegularFiles(tarBytes, { maxExpandedBytes });
  const selected = new Map();
  for (const memberPath of memberPaths) {
    const value = files.get(memberPath);
    if (!value) throw new Error(`requested tar member is absent: ${memberPath}`);
    selected.set(memberPath, value);
  }
  return selected;
}

module.exports = {
  BLOCK_SIZE,
  DEFAULT_MAX_COMPRESSED_BYTES,
  DEFAULT_MAX_EXPANDED_BYTES,
  assertSafeMemberPath,
  extractTarGzipMembers,
  parseTarRegularFiles,
};
