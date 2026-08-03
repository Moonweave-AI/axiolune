'use strict';

const assert = require('assert');
const {
  canonicalJcs,
  computeSelectionDigest,
  validateArtifactRef,
  validateSourceLocator,
} = require('../lib/strict-source-locator.cjs');

const profileRef = {
  kind: 'path',
  root: 'sourceTree',
  path: 'toolchain/extractors/text-v1.json',
};
const digest = `sha256:${'a'.repeat(64)}`;

function locator(kind, branch, mediaType = 'text/plain') {
  const value = {
    kind,
    path: 'reference/project/file.txt',
    mediaType,
    extractorProfileRef: profileRef,
    extractorProfileDigest: digest,
    selectionDigest: digest,
    ...branch,
  };
  return value;
}

const positives = [
  locator('wholeFile', {}),
  locator('textLineRange', { startLine: 1, endLine: 2 }),
  locator('textHeading', { heading: 'Semantics', occurrence: 1, headingLevel: 2 }),
  locator('pdfPageRange', { startPage: 2, endPage: 3 }, 'application/pdf'),
  locator('pdfNamedSection', { sectionTitle: 'Settlement', occurrence: 1, startPage: 4, endPage: 6 }, 'application/pdf'),
  locator('jsonPointer', { pointer: '/items/0' }, 'application/json'),
  locator('rdfResource', { resourceIri: 'https://example.test/term' }, 'text/turtle'),
  locator('xmlElement', { elementId: 'rule-1' }, 'application/xml'),
  locator('htmlFragment', { fragmentId: 'definition' }, 'text/html'),
];

let passed = 0;
for (const value of positives) {
  const result = validateSourceLocator(value);
  assert.equal(result.ok, true, `${value.kind}: ${result.errors.join('; ')}`);
  passed++;
}

const selected = Buffer.from('selected bytes', 'utf8');
const exact = locator('wholeFile', {});
exact.selectionDigest = computeSelectionDigest(exact, selected);
assert.equal(validateSourceLocator(exact, { selectedBytes: selected }).ok, true);
passed++;

const negatives = [
  [locator('pdfPageRange', { startPage: 3, endPage: 1 }, 'application/pdf'), 'reversed PDF range'],
  [locator('jsonPointer', { pointer: '/bad~2escape' }, 'application/json'), 'invalid JSON pointer'],
  [locator('jsonPointer', { pointer: '/e\u0301' }, 'application/json'), 'non-NFC JSON pointer'],
  [locator('rdfResource', { resourceIri: 'not an iri' }, 'text/turtle'), 'invalid RDF resource IRI'],
  [locator('textLineRange', { startLine: 1, endLine: 2 }, 'application/pdf'), 'wrong media branch'],
  [{ ...locator('wholeFile', {}), startLine: 1 }, 'cross-branch field'],
  [{ ...locator('wholeFile', {}), path: '../escape' }, 'parent path'],
  [{ ...locator('wholeFile', {}), mediaType: 'Text/Plain' }, 'noncanonical media type'],
  [{ ...exact, selectionDigest: digest }, 'selection digest mismatch'],
  [locator('pdfNamedSection', { sectionTitle: 'X', occurrence: 1, startPage: 1 }, 'application/pdf'), 'half page bounds'],
];
for (const [value, label] of negatives) {
  const options = label === 'selection digest mismatch' ? { selectedBytes: selected } : {};
  const result = validateSourceLocator(value, options);
  assert.equal(result.ok, false, label);
  passed++;
}

assert.equal(validateArtifactRef({ kind: 'path', root: 'sourceTree', path: 'a/b' }).ok, true);
assert.equal(validateArtifactRef({ kind: 'path', root: 'cwd', path: 'a/b' }).ok, false);
passed += 2;

assert.equal(canonicalJcs({ emoji: '😀' }), '{"emoji":"😀"}');
assert.throws(() => canonicalJcs({ broken: '\ud800' }), /unpaired Unicode surrogate/);
passed += 2;

console.log(`PASS strict SourceLocator/ArtifactRef vectors: ${passed}`);
