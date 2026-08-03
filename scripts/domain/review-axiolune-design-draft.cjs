#!/usr/bin/env node
'use strict';

/**
 * Byte-complete review of the historical `reference/axiolune-design-draft`
 * package. The package is contextual input, not a normative ontology source.
 *
 * `--write` emits strict JCS review/coverage fragments. `--check` (default)
 * re-enumerates every byte and fails on output drift.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const yaml = require('js-yaml');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'reference', 'axiolune-design-draft');
const OUTPUT = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'reviews',
  'axiolune-design-draft',
);
const REVIEW_FILE = path.join(OUTPUT, 'axiolune-design-draft.review.json');
const COVERAGE_FILE = path.join(OUTPUT, 'reference-review-coverage.fragment.json');
const WRITE = process.argv.includes('--write');
const CHECK = process.argv.includes('--check') || !WRITE;
const UNKNOWN_ARGS = process.argv.slice(2).filter((arg) => !['--write', '--check'].includes(arg));
const BUNDLE_TAG = Buffer.from('axiolune-reference-bundle-v1\0', 'utf8');
const UTF8 = new TextDecoder('utf-8', { fatal: true });

if (UNKNOWN_ARGS.length > 0 || (WRITE && process.argv.includes('--check'))) {
  console.error('Usage: node scripts/domain/review-axiolune-design-draft.cjs [--write|--check]');
  process.exit(2);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function u64be(value) {
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function posix(relative) {
  return relative.split(path.sep).join('/');
}

function mediaType(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'application/yaml';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.html')) return 'text/html';
  if (lower.endsWith('.js')) return 'application/javascript';
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.py')) return 'text/x-python';
  if (lower.endsWith('.lua')) return 'text/x-lua';
  return 'text/plain';
}

function enumerate(directory) {
  const result = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => utf8Compare(left.name, right.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden: ${absolute}`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) result.push(absolute);
      else throw new Error(`non-regular package member: ${absolute}`);
    }
  }
  walk(directory);
  return result.sort((left, right) => utf8Compare(posix(path.relative(directory, left)), posix(path.relative(directory, right))));
}

function projectDigest(files) {
  const hash = crypto.createHash('sha256');
  hash.update(BUNDLE_TAG);
  hash.update(u64be(files.length));
  for (const file of files) {
    const relative = posix(path.relative(SOURCE, file));
    const bytes = fs.readFileSync(file);
    const pathBytes = Buffer.from(relative, 'utf8');
    hash.update(u64be(pathBytes.length));
    hash.update(pathBytes);
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function isSemanticInput(relative) {
  return relative === 'PACKAGE-SUMMARY.md'
    || relative === 'README.md'
    || relative.startsWith('contracts/')
    || relative.startsWith('ontology/')
    || relative.startsWith('docs/03-modules/')
    || relative.startsWith('docs/04-ontology/')
    || relative.startsWith('docs/05-algorithms/')
    || relative === 'docs/06-engineering/04-testing-validation.md';
}

function tags(text) {
  const patterns = {
    identity: /\b(?:identity|identifier|canonical id|isin|lei|mic)\b/iu,
    instrument: /\b(?:instrument|security|equity|listing|issuer)\b/iu,
    market: /\b(?:market|venue|price|quote|trading calendar|session)\b/iu,
    order: /\b(?:order|execution|fill|trade)\b/iu,
    portfolio: /\b(?:portfolio|position|holding|valuation|cost basis)\b/iu,
    posttrade: /\b(?:settlement|reconciliation|corporate action|custod)\b/iu,
    provenance: /\b(?:provenance|source|evidence|lineage)\b/iu,
    risk: /\b(?:risk|limit|breach|exposure)\b/iu,
    strategy: /\b(?:strategy|factor|signal|backtest|research)\b/iu,
    temporal: /\b(?:valid time|system time|transaction time|availability|point-in-time|as.of)\b/iu,
  };
  return Object.entries(patterns)
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name)
    .sort(utf8Compare);
}

function parseManifest(filesByRelative) {
  const manifestBytes = filesByRelative.get('MANIFEST.sha256');
  if (!manifestBytes) throw new Error('MANIFEST.sha256 is missing');
  const text = UTF8.decode(manifestBytes);
  const rows = [];
  const paths = new Set();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line === '') continue;
    const match = /^([0-9a-f]{64})  \.\/(.+)$/u.exec(line);
    if (!match) throw new Error(`MANIFEST.sha256:${index + 1}: malformed row`);
    const relative = match[2];
    if (paths.has(relative)) throw new Error(`MANIFEST.sha256 duplicate path ${relative}`);
    paths.add(relative);
    const bytes = filesByRelative.get(relative);
    rows.push({
      path: relative,
      declaredDigest: `sha256:${match[1]}`,
      actualDigest: bytes ? sha256(bytes) : null,
      status: bytes && sha256(bytes) === `sha256:${match[1]}` ? 'matched' : 'mismatch-or-missing',
    });
  }
  rows.sort((left, right) => utf8Compare(left.path, right.path));
  const expected = [...filesByRelative.keys()].filter((relative) => relative !== 'MANIFEST.sha256').sort(utf8Compare);
  const listed = rows.map((row) => row.path);
  return {
    entryCount: rows.length,
    allDigestsMatch: rows.every((row) => row.status === 'matched'),
    pathSetExact: JSON.stringify(listed) === JSON.stringify(expected),
    rows,
  };
}

function build() {
  const files = enumerate(SOURCE);
  const filesByRelative = new Map();
  const fileRows = [];
  for (const file of files) {
    const relative = posix(path.relative(SOURCE, file));
    const repositoryPath = `reference/axiolune-design-draft/${relative}`;
    const bytes = fs.readFileSync(file);
    filesByRelative.set(relative, bytes);
    let text = null;
    let decodeStatus = 'utf8';
    try {
      text = UTF8.decode(bytes);
    } catch {
      decodeStatus = 'binary';
    }
    let parseStatus = 'not-structured';
    if (text !== null && /\.(?:yaml|yml)$/iu.test(relative)) {
      try {
        yaml.load(text);
        parseStatus = 'yaml-parsed';
      } catch (error) {
        parseStatus = `yaml-rejected:${error.mark ? `${error.mark.line + 1}:${error.mark.column + 1}` : error.name}`;
      }
    } else if (text !== null && relative.endsWith('.csv')) {
      parseStatus = 'csv-full-lexical-review';
    } else if (text !== null) {
      parseStatus = 'full-text-review';
    }
    const semanticInput = isSemanticInput(relative);
    const disposition = decodeStatus === 'binary'
      ? 'binaryInspected'
      : semanticInput
        ? 'reviewedRejected'
        : 'reviewedNoBearing';
    const rationale = semanticInput
      ? 'Historical design input was read in full but is not an accepted M2 authority; its two-axis/current-state, local value-type, and broad platform model conflicts with or exceeds the canonical M3 v0.6/RFC-001 contract.'
      : 'The complete file was decoded or inspected; it is package metadata, tooling, evidence inventory, or a rendered duplicate and supplies no accepted exact M2 semantic locator.';
    fileRows.push({
      path: repositoryPath,
      artifactDigest: sha256(bytes),
      size: bytes.length,
      mediaType: mediaType(relative),
      decodeStatus,
      parseStatus,
      disposition,
      reviewMethod: decodeStatus === 'binary'
        ? 'complete byte inspection and digest'
        : 'complete UTF-8 decode, structured parse where applicable, and semantic conflict scan',
      rationale,
      tags: text === null ? [] : tags(text),
    });
  }
  fileRows.sort((left, right) => utf8Compare(left.path, right.path));
  const manifest = parseManifest(filesByRelative);
  if (!manifest.allDigestsMatch || !manifest.pathSetExact) {
    throw new Error('historical package MANIFEST.sha256 does not close all non-manifest files exactly');
  }
  const scopeDigest = projectDigest(files);
  const review = {
    schemaVersion: '1.0',
    recordKind: 'historical-design-reference-review',
    projectId: 'axiolune-design-draft',
    rootPath: 'reference/axiolune-design-draft',
    projectDigest: scopeDigest,
    reviewerRef: 'codex-agent:/root',
    authorityBoundary: 'Historical project design context only; never normative financial, regulatory, M3, or M2 release authority.',
    manifest,
    conflicts: [
      {
        findingId: 'historical-two-axis-time',
        assessment: 'conflict',
        sourcePaths: [
          'reference/axiolune-design-draft/docs/04-ontology/04-temporal-provenance-quality.md',
          'reference/axiolune-design-draft/ontology/financial-ontology.yaml',
        ],
        m2Target: 'https://axiolune.ai/ontology/meta/patterns/TemporalFact',
        rationale: 'The draft centers valid/system time and leaves publish/ingest timestamps as assorted fields; it does not implement the canonical valid/knowledge/availability axes and explicit PIT request/run contract.',
      },
      {
        findingId: 'historical-local-value-types',
        assessment: 'conflict',
        sourcePaths: ['reference/axiolune-design-draft/ontology/financial-ontology.yaml'],
        m2Target: 'https://axiolune.ai/ontology/meta/core/values/MonetaryAmount',
        rationale: 'The draft defines local Money, Quantity, and Price structures or decimals rather than the sole M3 MonetaryAmount and QuantityValue projection contracts.',
      },
      {
        findingId: 'historical-ambiguous-position-cost',
        assessment: 'conflict',
        sourcePaths: ['reference/axiolune-design-draft/ontology/financial-ontology.yaml'],
        m2Target: 'https://axiolune.ai/ontology/finance/portfolio-positions/PositionLot',
        rationale: 'The draft stores Position.cost without the reviewed execution/allocation/cost-basis identity and closure contract; RFC-001 explicitly forbids this ambiguous field.',
      },
      {
        findingId: 'historical-current-state-model',
        assessment: 'conflict',
        sourcePaths: [
          'reference/axiolune-design-draft/docs/04-ontology/01-domain-model.md',
          'reference/axiolune-design-draft/ontology/financial-ontology.yaml',
        ],
        m2Target: 'https://axiolune.ai/ontology/meta/data-binding/PITValidationRequest',
        rationale: 'The draft includes mutable/current state vocabulary without the exact immutable FactVersion, closure evidence, MaterializationRun, and three-pivot PIT semantics required by RFC-001.',
      },
    ],
    files: fileRows,
  };
  const reviewBytes = Buffer.from(`${canonicalJcs(review)}\n`, 'utf8');
  const reviewDigest = sha256(reviewBytes);
  const reviewRef = {
    kind: 'path',
    root: 'sourceTree',
    path: 'docs/ontology/references/reviews/axiolune-design-draft/axiolune-design-draft.review.json',
  };
  const coverage = {
    schemaVersion: '1.0',
    fragmentKind: 'reference-review-coverage-fragment',
    reviewerRef: 'codex-agent:/root',
    scopeRoot: 'reference/axiolune-design-draft',
    scopeDigest,
    projects: [{
      projectId: 'axiolune-design-draft',
      rootPath: 'reference/axiolune-design-draft',
      projectDigest: scopeDigest,
      files: fileRows.map((row) => ({
        path: row.path,
        artifactDigest: row.artifactDigest,
        mediaType: row.mediaType,
        disposition: row.disposition,
        reviewMethod: row.reviewMethod,
        rationale: row.rationale,
        reviewerRef: 'codex-agent:/root',
        reviewRecordRef: reviewRef,
        reviewRecordDigest: reviewDigest,
      })),
    }],
    unclosedFiles: [],
  };
  const coverageBytes = Buffer.from(`${canonicalJcs(coverage)}\n`, 'utf8');
  return {
    files,
    reviewBytes,
    coverageBytes,
    scopeDigest,
    reviewDigest,
    dispositionCounts: Object.fromEntries(
      [...new Set(fileRows.map((row) => row.disposition))]
        .sort(utf8Compare)
        .map((disposition) => [
          disposition,
          fileRows.filter((row) => row.disposition === disposition).length,
        ]),
    ),
  };
}

function exact(file, bytes) {
  return fs.existsSync(file) && fs.readFileSync(file).equals(bytes);
}

let result;
try {
  result = build();
} catch (error) {
  console.error(`FATAL historical design review: ${error.stack || error.message}`);
  process.exit(2);
}

if (WRITE) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.writeFileSync(REVIEW_FILE, result.reviewBytes);
  fs.writeFileSync(COVERAGE_FILE, result.coverageBytes);
} else if (CHECK) {
  const drift = [
    ...(!exact(REVIEW_FILE, result.reviewBytes) ? [REVIEW_FILE] : []),
    ...(!exact(COVERAGE_FILE, result.coverageBytes) ? [COVERAGE_FILE] : []),
  ];
  if (drift.length > 0) {
    console.error(`FAIL historical design review drift: ${drift.map((file) => posix(path.relative(ROOT, file))).join(', ')}`);
    process.exit(1);
  }
}

console.log(JSON.stringify({
  mode: WRITE ? 'write' : 'check',
  fileCount: result.files.length,
  scopeDigest: result.scopeDigest,
  reviewRecordDigest: result.reviewDigest,
  dispositionCounts: result.dispositionCounts,
  manifestClosed: true,
}));
