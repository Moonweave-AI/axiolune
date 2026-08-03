#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const test = require('node:test');
const {
  extractTarGzipMembers,
  parseTarRegularFiles,
} = require('../lib/tar-gzip-member-source-extractor.cjs');

function octal(value, length) {
  const text = value.toString(8).padStart(length - 1, '0');
  return Buffer.from(`${text}\0`, 'ascii');
}

function archive(entries) {
  const parts = [];
  for (const [name, value] of entries) {
    const data = Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'ascii');
    octal(0o644, 8).copy(header, 100);
    octal(0, 8).copy(header, 108);
    octal(0, 8).copy(header, 116);
    octal(data.length, 12).copy(header, 124);
    octal(0, 12).copy(header, 136);
    Buffer.from('        ', 'ascii').copy(header, 148);
    header[156] = 0x30;
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    Buffer.from('00', 'ascii').copy(header, 263);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = `${checksum.toString(8).padStart(6, '0')}\0 `;
    Buffer.from(checksumText, 'ascii').copy(header, 148);
    parts.push(header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

test('gzip tar extractor returns exact requested regular-member bytes', () => {
  const bytes = zlib.gzipSync(archive([['version', '2026c\n'], ['zone1970.tab', 'US\tAmerica/New_York\n']]));
  const selected = extractTarGzipMembers(bytes, ['version', 'zone1970.tab']);
  assert.equal(selected.get('version').toString('utf8'), '2026c\n');
  assert.equal(selected.get('zone1970.tab').toString('utf8'), 'US\tAmerica/New_York\n');
});

test('archive and request ambiguity fail closed', () => {
  const tar = archive([['version', '2026c\n']]);
  assert.throws(() => extractTarGzipMembers(Buffer.from('not-gzip'), ['version']), /gzip/u);
  assert.throws(() => extractTarGzipMembers(zlib.gzipSync(tar), ['../version']), /unsafe/u);
  assert.throws(() => extractTarGzipMembers(zlib.gzipSync(tar), ['missing']), /absent/u);
  assert.throws(() => extractTarGzipMembers(zlib.gzipSync(tar), ['version', 'version']), /duplicate/u);
});

test('header and expanded-content tampering are detected', () => {
  const tar = archive([['version', '2026c\n']]);
  const headerTampered = Buffer.from(tar);
  headerTampered[0] ^= 1;
  assert.throws(() => parseTarRegularFiles(headerTampered), /checksum/u);

  const contentTampered = Buffer.from(tar);
  contentTampered[512] ^= 1;
  const selected = extractTarGzipMembers(zlib.gzipSync(contentTampered), ['version']);
  assert.notEqual(selected.get('version').toString('utf8'), '2026c\n');
});

test('non-regular members and oversized inputs fail closed', () => {
  const tar = archive([['version', '2026c\n']]);
  const directory = Buffer.from(tar);
  directory[156] = 0x35;
  Buffer.from('        ', 'ascii').copy(directory, 148);
  let checksum = 0;
  for (let index = 0; index < 512; index += 1) checksum += directory[index];
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(directory, 148);
  assert.throws(() => parseTarRegularFiles(directory), /not a regular file/u);
  assert.throws(
    () => extractTarGzipMembers(zlib.gzipSync(tar), ['version'], { maxCompressedBytes: 1 }),
    /configured byte limit/u,
  );
});
