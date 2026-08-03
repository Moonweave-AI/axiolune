'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const {
  BUNDLE_TAG,
  computeWholeFileSelectionDigest,
  fileDigest,
  u64be,
} = require('../lib/reference-closure.cjs');
const {
  extractPdfPageRangeBytes,
  parseRuntimeLock,
  resolveRuntimeRoot,
} = require('../lib/pdf-page-range-runtime.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
  validateSourceLocator,
} = require('../lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LOCK_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'references.lock.yaml',
);
const OVERRIDES_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'term-authority-overrides.json',
);
const PDF_PROFILE_PATH = path.join(
  ROOT,
  'scripts',
  'domain',
  'reference-extractors',
  'pdf-page-range-pdfplumber-v1.json',
);

const SOURCES = [
  {
    id: 'anna-isin-guidelines-v26-2026-06',
    publicIri: 'https://axiolune.ai/ontology/finance/foundation/ISIN',
    artifactUrl: 'https://anna-web.org/wp-content/uploads/2026/06/ISIN-Guidelines-Version-26-Jun-2026.pdf',
    localPath: 'reference/authority-reference/anna/2026-08-01/isin-guidelines-v26',
    fileName: 'isin-guidelines-v26.pdf',
    byteLength: 549783,
    rawDigest: 'sha256:148850738b9cb94c5c09691073fd60aa89bd10a1947abcb7a11f39e33b0d41a7',
    artifactDigest: 'sha256:d9cb244490a9d1065f3179be855ce4422af7e90783a0f3e9b60e110ac27b9abe',
    pages: [
      {
        startPage: 3,
        endPage: 3,
        selectionDigest: 'sha256:b238898651ffaaebc3bc68f44c5e2f1b9f0503f68d18599ef67f7b458c4d8724',
        patterns: [/registration authority/iu, /National Numbering Agenc/iu, /NNAs and DSB/iu],
      },
      {
        startPage: 23,
        endPage: 23,
        selectionDigest: 'sha256:c314c2d1a5fcc664a39ab2ff86856afa3d4f61c7d52eef3c23faf0ade49989c1',
        patterns: [/12[- ]character/iu, /Double.Add.Double/iu, /check digit/iu],
      },
    ],
  },
  {
    id: 'gleif-lei-faq-v1-2024-04-22',
    publicIri: 'https://axiolune.ai/ontology/finance/foundation/LEI',
    artifactUrl: 'https://www.gleif.org/_documents/2024-04-22_the-legal-entity-identifier-faqs_v1.0-final_approved_.pdf',
    localPath: 'reference/authority-reference/gleif/2026-08-01/lei-faq-v1.0',
    fileName: 'lei-faq-v1.0.pdf',
    byteLength: 150219,
    rawDigest: 'sha256:597bd122803b17dda11880a136779d7589ab4682f2381d686f08088655d1ea5c',
    artifactDigest: 'sha256:e511072e9d1b0061ed983d7164d1f5dab373448c8b382c18f01c095a6cfce63c',
    pages: [
      {
        startPage: 1,
        endPage: 2,
        selectionDigest: 'sha256:26c1bcdbe62fdf7d7d9a76ad0b56e85df79766364b580f20587bee1bc2a1f90d',
        patterns: [/20-(?:digit|character),? alphanumeric/iu, /ISO(?: standard)? 17442/iu, /GLEIF/iu],
      },
      {
        startPage: 5,
        endPage: 5,
        selectionDigest: 'sha256:de6b4ed86056d49025589ef88f7c71634e11e61c5dc6680e498b29cfc13e8fa7',
        patterns: [/Local Operating Unit/iu, /accredited/iu, /issue LEIs/iu],
      },
    ],
  },
  {
    id: 'gleif-lei-cdf-qa-v2.4-2022-02-22',
    publicIri: 'https://axiolune.ai/ontology/finance/foundation/LEI',
    artifactUrl: 'https://www.gleif.org/lei-data/access-and-use-lei-data/2022-02-22_cdf_questions_and_answers_v2.4.pdf',
    localPath: 'reference/authority-reference/gleif/2026-08-01/lei-cdf-qa-v2.4',
    fileName: 'lei-cdf-qa-v2.4.pdf',
    byteLength: 1049603,
    rawDigest: 'sha256:26e6d87962172223f362a72bcae7cd3dd0da61622d07e487c94454277fb422dd',
    artifactDigest: 'sha256:a25bdd0286a71e24bbe8b3581c34d770b8308dd3932e0d91b1b4e510b6c4ac5a',
    pages: [
      {
        startPage: 19,
        endPage: 19,
        selectionDigest: 'sha256:b46da6d1581e505baac30322ecc84f0bf05da126c79e43e3a1b3c79942333dcc',
        patterns: [/final 2 digits/iu, /Characters 5-18/iu, /ISO Standard 7064/iu],
      },
    ],
  },
  {
    id: 'iso10383-ra-mic-release-2-factsheet-v2-2022-11',
    publicIri: 'https://axiolune.ai/ontology/finance/foundation/MIC',
    artifactUrl: 'https://www.iso20022.org/sites/default/files/2022-11/ISO10383_MIC_Release_2_0_Factsheet_v2.pdf',
    localPath: 'reference/authority-reference/iso10383-ra/2026-08-01/mic-release-2-factsheet-v2',
    fileName: 'mic-release-2-factsheet-v2.pdf',
    byteLength: 171035,
    rawDigest: 'sha256:9aa9dd7e5e76d3bd9508fa63e76a270191ae504fb109ddbbef61bfedb1b5234a',
    artifactDigest: 'sha256:ac48b7d8d830e2e144362249a69f041d647111b0eb000dc3198f02c0fb0be45c',
    pages: [
      {
        startPage: 1,
        endPage: 2,
        selectionDigest: 'sha256:b518fdae36fddebbb3479af629e54048be0bdf039bb6478a74f96019811d707d',
        patterns: [/SWIFT/iu, /Registration Authority/iu, /\[A-Z0-9\]\{4,4\}/u],
      },
    ],
  },
];

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function singleFileBundleDigest(fileName, bytes) {
  const relative = Buffer.from(fileName, 'utf8');
  const hash = crypto.createHash('sha256');
  hash.update(BUNDLE_TAG);
  hash.update(u64be(1));
  hash.update(u64be(relative.length));
  hash.update(relative);
  hash.update(u64be(bytes.length));
  hash.update(bytes);
  return `sha256:${hash.digest('hex')}`;
}

function lockedLocator(reference, expected) {
  const matches = reference.locators.filter((locator) => (
    locator.kind === 'pdfPageRange'
      && locator.startPage === expected.startPage
      && locator.endPage === expected.endPage
  ));
  assert.equal(matches.length, 1, `${reference.id} must lock the exact page selector once`);
  return matches[0];
}

test('identifier authority PDFs are byte-locked and every normative page selector replays', () => {
  const lock = YAML.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const profile = JSON.parse(fs.readFileSync(PDF_PROFILE_PATH, 'utf8'));
  const runtimeLock = parseRuntimeLock(fs.readFileSync(path.join(
    ROOT,
    ...profile.runtimeLockRef.path.split('/'),
  )));
  const implementationPath = path.join(ROOT, ...profile.implementationRef.path.split('/'));
  const runtimeRoot = resolveRuntimeRoot(ROOT);

  for (const expected of SOURCES) {
    const references = lock.references.filter((reference) => reference.id === expected.id);
    assert.equal(references.length, 1, `${expected.id} lock cardinality`);
    const [reference] = references;
    assert.equal(reference.artifactUrl, expected.artifactUrl, `${expected.id} official URL`);
    assert.equal(reference.localPath, expected.localPath, `${expected.id} local path`);
    assert.equal(reference.artifactDigest, expected.artifactDigest, `${expected.id} bundle digest`);
    assert.match(
      reference.note,
      new RegExp(`rawFileSha256=${expected.rawDigest}`),
      `${expected.id} raw digest note`,
    );

    const sourcePath = path.join(ROOT, ...reference.localPath.split('/'), expected.fileName);
    const sourceBytes = fs.readFileSync(sourcePath);
    assert.equal(sourceBytes.length, expected.byteLength, `${expected.id} raw byte length`);
    assert.equal(fileDigest(sourcePath), expected.rawDigest, `${expected.id} raw digest`);
    assert.equal(
      singleFileBundleDigest(expected.fileName, sourceBytes),
      expected.artifactDigest,
      `${expected.id} framed bundle digest`,
    );

    const tamperedSource = Buffer.from(sourceBytes);
    tamperedSource[0] ^= 0x01;
    assert.notEqual(sha256(tamperedSource), expected.rawDigest, `${expected.id} raw tamper`);

    const wholeLocators = reference.locators.filter((locator) => locator.kind === 'wholeFile');
    assert.equal(wholeLocators.length, 1, `${expected.id} whole-file locator cardinality`);
    assert.equal(
      computeWholeFileSelectionDigest(wholeLocators[0], sourcePath),
      wholeLocators[0].selectionDigest,
      `${expected.id} whole-file selector replay`,
    );

    for (const page of expected.pages) {
      const locator = lockedLocator(reference, page);
      assert.equal(locator.selectionDigest, page.selectionDigest);
      assert.equal(locator.extractorProfileDigest, fileDigest(PDF_PROFILE_PATH));
      const selected = extractPdfPageRangeBytes({
        implementationPath,
        lock: runtimeLock,
        runtimeRoot,
        sourcePath,
        startPage: locator.startPage,
        endPage: locator.endPage,
      });
      assert.equal(computeSelectionDigest(locator, selected), locator.selectionDigest);
      assert.deepEqual(validateSourceLocator(locator, { selectedBytes: selected }).errors, []);
      const selectedText = selected.toString('utf8');
      for (const pattern of page.patterns) assert.match(selectedText, pattern);

      const tamperedSelection = Buffer.from(selected);
      tamperedSelection[tamperedSelection.length - 1] ^= 0x01;
      assert.equal(
        validateSourceLocator(locator, { selectedBytes: tamperedSelection }).ok,
        false,
        `${expected.id} selected-byte tamper must fail closed`,
      );
      const driftedRange = { ...locator, endPage: locator.endPage + 1 };
      assert.equal(
        validateSourceLocator(driftedRange, { selectedBytes: selected }).ok,
        false,
        `${expected.id} locator-range tamper must fail closed`,
      );
    }
  }
});

test('identifier term authority uses only exact locked normative locators', () => {
  const lock = YAML.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
  const lockById = new Map(lock.references.map((reference) => [reference.id, reference]));

  for (const publicIri of new Set(SOURCES.map((source) => source.publicIri))) {
    const entries = overrides.entries.filter((entry) => entry.publicIri === publicIri);
    assert.equal(entries.length, 1, `${publicIri} override cardinality`);
    const [entry] = entries;
    assert.equal(entry.authorityKind, 'externalAdapted', `${publicIri} authority kind`);
    assert.ok(entry.upstreamEvidence.length > 0, `${publicIri} normative evidence`);
    for (const evidence of entry.upstreamEvidence) {
      assert.equal(evidence.usage, 'normative', `${publicIri} evidence usage`);
      assert.equal(evidence.transformation, 'adaptedComposite', `${publicIri} transformation`);
      const reference = lockById.get(evidence.referenceId);
      assert.ok(reference, `${publicIri} reference ${evidence.referenceId}`);
      const key = canonicalJcs(evidence.locator);
      assert.equal(
        reference.locators.filter((locator) => canonicalJcs(locator) === key).length,
        1,
        `${publicIri} evidence must match exactly one locked locator`,
      );
    }
  }
});
