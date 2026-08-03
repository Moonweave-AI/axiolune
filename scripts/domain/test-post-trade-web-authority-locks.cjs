#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  BUNDLE_TAG,
  fileDigest,
  u64be,
} = require('./lib/reference-closure.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
  validateSourceLocator,
} = require('./lib/strict-source-locator.cjs');
const {
  extractTextLineRangeBytes,
} = require('./lib/text-line-range-source-extractor.cjs');
const {
  auditPostTradeReferenceLock,
} = require('./lib/post-trade-authority-evidence.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCK_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'references.lock.yaml',
);
const WHOLE_PROFILE_PATH = 'scripts/domain/reference-extractors/whole-file-v1.json';
const TEXT_PROFILE_PATH = 'scripts/domain/reference-extractors/text-line-range-utf8-v1.json';
const WHOLE_PROFILE_DIGEST = 'sha256:49c5d4e1c0de9f60a95ac9a1b144dc5f7fb14dd302e7da2cf26fa2cb5360d775';
const TEXT_PROFILE_DIGEST = 'sha256:c4477ead7814966979f29e2a98a32116f0b837f1b3b1850d15ce8ed1ae1afff2';
const CAPTURED_AT = '2026-07-31T20:00:00Z';

const SPECS = Object.freeze([
  Object.freeze({
    id: 'finra-rule-11140-2026-07-31',
    authority: 'Financial Industry Regulatory Authority (FINRA)',
    artifactUrl: 'https://www.finra.org/rules-guidance/rulebooks/finra-rules/11140',
    localPath: 'reference/authority-reference/finra/2026-07-31/rule-11140',
    selector: '.field--name-field-tab-content .field--name-body.field__item',
    artifactDigest: 'sha256:de2ae70161ce33f483e4d39effcbdfbbb6090b50b4fbb50db8a7d46ee206c2aa',
    fileDigests: Object.freeze({
      'capture.json': 'sha256:6ec039119575f29195b90434729a7773cea87c9d1b9999aab10ccbec69f537ab',
      'content.html': 'sha256:fe7b061d80d5b3058f395466977bf95d5f22a7d0fab965b5f7f9fa23804dfcc0',
      'content.txt': 'sha256:b927d57303961b94fb3e2073d3b8cf9bf831cacee659d8520ca500fbbfa8d6b3',
    }),
    ranges: Object.freeze([
      Object.freeze({ startLine: 1, endLine: 2, fragments: Object.freeze(['Designation of Ex-Date']) }),
      Object.freeze({ startLine: 3, endLine: 4, fragments: Object.freeze(['less than 25 percent']) }),
      Object.freeze({ startLine: 5, endLine: 6, fragments: Object.freeze(['25 percent or greater']) }),
      Object.freeze({ startLine: 7, endLine: 8, fragments: Object.freeze(['Late Information']) }),
      Object.freeze({ startLine: 13, endLine: 20, fragments: Object.freeze(['May 28, 2024']) }),
    ]),
  }),
  Object.freeze({
    id: 'finra-notice-00-54-2026-07-31',
    authority: 'Financial Industry Regulatory Authority (FINRA); originally National Association of Securities Dealers (NASD)',
    artifactUrl: 'https://www.finra.org/rules-guidance/notices/00-54',
    localPath: 'reference/authority-reference/finra/2026-07-31/notice-00-54',
    selector: 'article.node--type-notices .field--name-body.field__item',
    artifactDigest: 'sha256:cdbd9acd42b5a1b90e0aea0d338ed55d22eef11e1ace30b712dc7a9879086c72',
    fileDigests: Object.freeze({
      'capture.json': 'sha256:079d044ac368612503f97513de98d9273edcd6d3f0b9227cdadc9a5a516a8710',
      'content.html': 'sha256:8174db019071d20b1645ced33f67b196b5129a6aee482bd045dee3b9aae8c95d',
      'content.txt': 'sha256:be58f22a4a6630c67675997f7cd08270376852afb27e6ca25b69dda4ad8cec49',
    }),
    ranges: Object.freeze([
      Object.freeze({
        startLine: 17,
        endLine: 21,
        fragments: Object.freeze([
          '25 percent or greater',
          'first business day following the payable date',
          'relinquish the dividend to the buyer',
        ]),
      }),
    ]),
  }),
  Object.freeze({
    id: 'investor-gov-ex-dividend-2026-07-31',
    authority: 'U.S. Securities and Exchange Commission, Office of Investor Education and Advocacy (Investor.gov)',
    artifactUrl: 'https://www.investor.gov/introduction-investing/investing-basics/glossary/ex-dividend-dates-when-are-you-entitled-stock-and',
    localPath: 'reference/authority-reference/investor-gov/2026-07-31/ex-dividend',
    selector: 'article.node--type-glossary-term',
    artifactDigest: 'sha256:08ecfb785101bcc1faf9abe8c061c436e644f9666a7c6a6294399c2caeaf8989',
    fileDigests: Object.freeze({
      'capture.json': 'sha256:db11094fa1aef42f3db85176ab6da3a980410b153fe2acc2f6fbc33b2d6dbeee',
      'content.html': 'sha256:88f71d8ef1427d1c84ee17b8b1e619c6755e70932f1c41bd0817e9b2b0067624',
      'content.txt': 'sha256:3bcb51ac85bf1f6c9929ea0a1f91f26eb8b5044d59b101fe03faddfc7122600f',
    }),
    ranges: Object.freeze([
      Object.freeze({
        startLine: 17,
        endLine: 21,
        fragments: Object.freeze([
          '25% or more',
          'one business day after the dividend is paid',
          '"due bill"',
        ]),
      }),
    ]),
  }),
]);

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function exactKeys(value, expected, at, errors) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${at}: expected an object`);
    return;
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    errors.push(`${at}: fields differ; actual=${actual.join(',')} expected=${wanted.join(',')}`);
  }
}

function readFiles(spec) {
  const directory = path.join(ROOT, ...spec.localPath.split('/'));
  const names = fs.readdirSync(directory, { withFileTypes: true });
  assert.deepEqual(
    names.map((entry) => entry.name).sort(compareUtf8),
    Object.keys(spec.fileDigests).sort(compareUtf8),
    `${spec.id}: exact three-file inventory drift`,
  );
  const files = new Map();
  for (const name of Object.keys(spec.fileDigests)) {
    const absolute = path.join(directory, name);
    assert.equal(fs.statSync(absolute).isFile(), true, `${spec.id}/${name}: not a regular file`);
    files.set(name, fs.readFileSync(absolute));
  }
  return files;
}

function bundleDigest(files) {
  const names = [...files.keys()].sort(compareUtf8);
  const hash = crypto.createHash('sha256');
  hash.update(BUNDLE_TAG);
  hash.update(u64be(names.length));
  for (const name of names) {
    const nameBytes = Buffer.from(name, 'utf8');
    const bytes = files.get(name);
    hash.update(u64be(nameBytes.length));
    hash.update(nameBytes);
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function locatorKey(locator) {
  return [
    locator.kind,
    locator.path,
    locator.startLine === undefined ? '' : locator.startLine,
    locator.endLine === undefined ? '' : locator.endLine,
  ].join('|');
}

function expectedLocatorKeys(spec) {
  return [
    ...spec.ranges.map((range) => (
      `textLineRange|content.txt|${range.startLine}|${range.endLine}`
    )),
    'wholeFile|capture.json||',
    'wholeFile|content.html||',
    'wholeFile|content.txt||',
  ].sort(compareUtf8);
}

function validateCapture(spec, bytes, files, errors) {
  let capture;
  try {
    capture = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    errors.push(`${spec.id}/capture.json: invalid JSON: ${error.message}`);
    return;
  }
  try {
    if (!bytes.equals(Buffer.from(`${canonicalJcs(capture)}\n`, 'utf8'))) {
      errors.push(`${spec.id}/capture.json: bytes are not exact JCS plus one LF`);
    }
  } catch (error) {
    errors.push(`${spec.id}/capture.json: cannot canonicalize: ${error.message}`);
  }
  exactKeys(capture, [
    'schemaVersion',
    'id',
    'authorityPageUrl',
    'finalUrl',
    'title',
    'capturedAt',
    'captureMethod',
    'contentSelector',
    'htmlNormalization',
    'textNormalization',
    'artifacts',
  ], `${spec.id}/capture.json`, errors);
  if (capture.schemaVersion !== '1.0'
      || capture.id !== spec.id
      || capture.authorityPageUrl !== spec.artifactUrl
      || capture.finalUrl !== spec.artifactUrl
      || capture.capturedAt !== CAPTURED_AT
      || capture.captureMethod !== 'Chrome CDP isolated background tab; scoped DOM element serialization'
      || capture.contentSelector !== spec.selector
      || capture.htmlNormalization !== 'CRLF/CR converted to LF; Unicode NFC; one terminal LF'
      || capture.textNormalization !== 'innerText; CRLF/CR to LF; trim/collapse horizontal whitespace; remove empty lines; Unicode NFC; one terminal LF'
      || typeof capture.title !== 'string'
      || capture.title.trim() === '') {
    errors.push(`${spec.id}/capture.json: capture identity or normalization contract drift`);
  }
  if (!Array.isArray(capture.artifacts) || capture.artifacts.length !== 2) {
    errors.push(`${spec.id}/capture.json: expected exactly two captured artifacts`);
    return;
  }
  const expectedMedia = new Map([
    ['content.html', 'text/html'],
    ['content.txt', 'text/plain'],
  ]);
  const seen = new Set();
  for (const [index, artifact] of capture.artifacts.entries()) {
    exactKeys(
      artifact,
      ['path', 'mediaType', 'byteLength', 'digest'],
      `${spec.id}/capture.json.artifacts[${index}]`,
      errors,
    );
    const selected = files.get(artifact?.path);
    if (!selected
        || seen.has(artifact.path)
        || artifact.mediaType !== expectedMedia.get(artifact.path)
        || artifact.byteLength !== selected.length
        || artifact.digest !== sha256(selected)) {
      errors.push(`${spec.id}/capture.json.artifacts[${index}]: byte binding mismatch`);
    }
    seen.add(artifact?.path);
  }
  if (seen.size !== 2 || !seen.has('content.html') || !seen.has('content.txt')) {
    errors.push(`${spec.id}/capture.json: captured artifact identity set drift`);
  }
}

function validateRecord(record, spec, files) {
  const errors = [];
  if (!record || record.id !== spec.id) return [`${spec.id}: exact lock record is missing`];
  if (record.authority !== spec.authority
      || record.artifactUrl !== spec.artifactUrl
      || record.localPath !== spec.localPath
      || record.artifactDigest !== spec.artifactDigest
      || record.retrievalDate !== '2026-07-31') {
    errors.push(`${spec.id}: lock identity or stable artifact digest drift`);
  }
  if (bundleDigest(files) !== spec.artifactDigest) {
    errors.push(`${spec.id}: directory bundle digest mismatch`);
  }
  for (const [name, expected] of Object.entries(spec.fileDigests)) {
    if (sha256(files.get(name)) !== expected) {
      errors.push(`${spec.id}/${name}: stable exact-byte digest mismatch`);
    }
  }
  validateCapture(spec, files.get('capture.json'), files, errors);

  if (!Array.isArray(record.locators)) {
    errors.push(`${spec.id}: locator inventory is absent`);
    return errors;
  }
  const actualKeys = record.locators.map(locatorKey).sort(compareUtf8);
  const wantedKeys = expectedLocatorKeys(spec);
  if (JSON.stringify(actualKeys) !== JSON.stringify(wantedKeys)) {
    errors.push(`${spec.id}: exact locator inventory drift`);
  }
  const uniqueKeys = new Set(actualKeys);
  if (uniqueKeys.size !== actualKeys.length) {
    errors.push(`${spec.id}: duplicate locator identity`);
  }

  for (const [index, locator] of record.locators.entries()) {
    const source = files.get(locator?.path);
    if (!source) {
      errors.push(`${spec.id}.locators[${index}]: source file is absent`);
      continue;
    }
    const expectedProfilePath = locator.kind === 'textLineRange'
      ? TEXT_PROFILE_PATH
      : WHOLE_PROFILE_PATH;
    const expectedProfileDigest = locator.kind === 'textLineRange'
      ? TEXT_PROFILE_DIGEST
      : WHOLE_PROFILE_DIGEST;
    if (locator.extractorProfileRef?.kind !== 'path'
        || locator.extractorProfileRef?.root !== 'sourceTree'
        || locator.extractorProfileRef?.path !== expectedProfilePath
        || locator.extractorProfileDigest !== expectedProfileDigest
        || fileDigest(path.join(ROOT, ...expectedProfilePath.split('/'))) !== expectedProfileDigest) {
      errors.push(`${spec.id}.locators[${index}]: extractor profile binding drift`);
      continue;
    }
    let selected;
    try {
      selected = locator.kind === 'textLineRange'
        ? extractTextLineRangeBytes(source, locator.startLine, locator.endLine)
        : Buffer.from(source);
    } catch (error) {
      errors.push(`${spec.id}.locators[${index}]: selection failed: ${error.message}`);
      continue;
    }
    const validation = validateSourceLocator(locator, {
      at: `${spec.id}.locators[${index}]`,
      selectedBytes: selected,
    });
    errors.push(...validation.errors);
    if (computeSelectionDigest(locator, selected) !== locator.selectionDigest) {
      errors.push(`${spec.id}.locators[${index}]: selection digest replay mismatch`);
    }
  }

  const lines = files.get('content.txt').toString('utf8').trimEnd().split('\n');
  for (const range of spec.ranges) {
    const selected = lines.slice(range.startLine - 1, range.endLine).join('\n');
    for (const fragment of range.fragments) {
      if (!selected.includes(fragment)) {
        errors.push(
          `${spec.id}:${range.startLine}-${range.endLine}: required semantic fragment missing: ${fragment}`,
        );
      }
    }
  }
  return errors;
}

function mutateFullyRecomputed(record, spec, originalFiles, mutation) {
  const files = new Map(
    [...originalFiles.entries()].map(([name, bytes]) => [name, Buffer.from(bytes)]),
  );
  mutation(files);
  const capture = JSON.parse(files.get('capture.json').toString('utf8'));
  for (const artifact of capture.artifacts) {
    const bytes = files.get(artifact.path);
    artifact.byteLength = bytes.length;
    artifact.digest = sha256(bytes);
  }
  files.set('capture.json', Buffer.from(`${canonicalJcs(capture)}\n`, 'utf8'));
  const forged = structuredClone(record);
  for (const locator of forged.locators) {
    const source = files.get(locator.path);
    const selected = locator.kind === 'textLineRange'
      ? extractTextLineRangeBytes(source, locator.startLine, locator.endLine)
      : source;
    locator.selectionDigest = computeSelectionDigest(locator, selected);
  }
  forged.artifactDigest = bundleDigest(files);
  return { files, forged };
}

function main() {
  const lock = YAML.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const genericAudit = auditPostTradeReferenceLock(lock);
  assert.deepEqual(genericAudit.errors, [], 'post-trade reference structure audit must have no errors');
  assert.deepEqual(genericAudit.pending, [], 'all six post-trade reference profiles must be resolved');

  let positiveCount = 0;
  let negativeCount = 0;
  for (const spec of SPECS) {
    const matches = lock.references.filter((reference) => reference.id === spec.id);
    assert.equal(matches.length, 1, `${spec.id}: expected exactly one lock record`);
    const record = matches[0];
    const files = readFiles(spec);
    assert.deepEqual(validateRecord(record, spec, files), [], `${spec.id}: replay failed`);
    positiveCount += 1;

    const identityTamper = structuredClone(record);
    identityTamper.authority = 'forged authority';
    assert.notEqual(validateRecord(identityTamper, spec, files).length, 0);
    negativeCount += 1;

    const selectedByteTamper = new Map(
      [...files.entries()].map(([name, bytes]) => [name, Buffer.from(bytes)]),
    );
    selectedByteTamper.set(
      'content.txt',
      Buffer.concat([selectedByteTamper.get('content.txt'), Buffer.from('forged\n', 'utf8')]),
    );
    assert.notEqual(validateRecord(record, spec, selectedByteTamper).length, 0);
    negativeCount += 1;

    const recomputed = mutateFullyRecomputed(record, spec, files, (mutable) => {
      mutable.set(
        'content.txt',
        Buffer.concat([mutable.get('content.txt'), Buffer.from('forged\n', 'utf8')]),
      );
    });
    assert.notEqual(
      validateRecord(recomputed.forged, spec, recomputed.files).length,
      0,
      `${spec.id}: a fully recomputed content forgery must fail the stable exact-byte anchor`,
    );
    negativeCount += 1;

    const unknownField = mutateFullyRecomputed(record, spec, files, (mutable) => {
      const capture = JSON.parse(mutable.get('capture.json').toString('utf8'));
      capture.unreviewedField = true;
      mutable.set('capture.json', Buffer.from(`${canonicalJcs(capture)}\n`, 'utf8'));
    });
    assert.notEqual(
      validateRecord(unknownField.forged, spec, unknownField.files).length,
      0,
      `${spec.id}: an unknown capture field must fail closed`,
    );
    negativeCount += 1;
  }

  process.stdout.write(
    `PASS post-trade web authority locks: ${positiveCount} exact records replayed; `
      + `${negativeCount} identity/source/recomputed/unknown-field tamper cases rejected\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`FAIL post-trade web authority locks: ${error.stack || error.message}\n`);
  process.exitCode = 1;
}
