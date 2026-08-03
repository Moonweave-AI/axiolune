#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  loadYaml,
} = require('./lib/post-trade-v03-contract.cjs');
const {
  TYPED_FIXTURE_PROFILE,
  buildPostTradeCanonicalTypedFixture,
  mergeFinanceOntologyDocuments,
} = require('./lib/post-trade-canonical-envelope-builder.cjs');
const {
  ROUTE_INVENTORY_PROFILE,
  compilePostTradeTypedRouteInventory,
  digest,
  resolvePointer,
} = require('./lib/post-trade-typed-route-inventory.cjs');
const {
  canonicalJcs,
} = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_REF = 'tests/m2/fixtures/positive/post-trade-closure-reconciliation.yaml';
const CLASSIFICATION_REF = 'tests/m2/fixtures/positive/post-trade-non-record-classifications.json';
const MANIFEST_REF = 'tests/m2/fixtures/positive/post-trade-typed-envelope-overlay.json';
const BUILDER_REF = 'scripts/domain/lib/post-trade-canonical-envelope-builder.cjs';
const PATTERN_REF = 'ontology/meta/cross-domain-patterns.yaml';

const SOURCE_PATH = path.join(ROOT, ...SOURCE_REF.split('/'));
const CLASSIFICATION_PATH = path.join(ROOT, ...CLASSIFICATION_REF.split('/'));
const MANIFEST_PATH = path.join(ROOT, ...MANIFEST_REF.split('/'));
const BUILDER_PATH = path.join(ROOT, ...BUILDER_REF.split('/'));
const PATTERN_PATH = path.join(ROOT, ...PATTERN_REF.split('/'));

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError(`${label} must contain exactly ${keys.join(', ')}`);
  }
}

function loadFinanceOntologyClosure() {
  const financeRoot = path.join(ROOT, 'ontology', 'domain', 'finance');
  const documents = fs.readdirSync(financeRoot)
    .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
    .map((moduleName) => path.join(financeRoot, moduleName, 'module.yaml'))
    .filter((file) => fs.existsSync(file))
    .map((file) => loadYaml(file));
  return mergeFinanceOntologyDocuments(documents);
}

function buildArtifacts() {
  const sourceBytes = fs.readFileSync(SOURCE_PATH);
  const sourceDocument = loadYaml(SOURCE_PATH);
  const currentClassification = JSON.parse(fs.readFileSync(CLASSIFICATION_PATH, 'utf8'));
  assertExactKeys(
    currentClassification,
    ['profile', 'sourceFixtureDigest', 'classifications'],
    'classification document',
  );
  if (currentClassification.profile !== ROUTE_INVENTORY_PROFILE
      || !Array.isArray(currentClassification.classifications)) {
    throw new TypeError(`classification document must use ${ROUTE_INVENTORY_PROFILE}`);
  }

  // Paths and reasons remain authored review decisions. Only byte-derived
  // digests are regenerated; route compilation below rejects missing, extra,
  // duplicate, unsorted, or newly unclassified source candidates.
  const classificationDocument = {
    profile: ROUTE_INVENTORY_PROFILE,
    sourceFixtureDigest: sha256(sourceBytes),
    classifications: currentClassification.classifications.map((row, index) => {
      assertExactKeys(
        row,
        ['path', 'reason', 'sourceObjectDigest'],
        `classification document.classifications[${index}]`,
      );
      return {
        path: row.path,
        reason: row.reason,
        sourceObjectDigest: digest(resolvePointer(sourceDocument, row.path)),
      };
    }),
  };
  const inventory = compilePostTradeTypedRouteInventory(
    sourceDocument,
    classificationDocument.classifications,
  );
  if (inventory.unresolvedCount !== 0 || inventory.extraClaimCount !== 0) {
    throw new Error(
      `typed route inventory is not closed: unresolved=${inventory.unresolvedCount} `
        + `extra=${inventory.extraClaimCount}`,
    );
  }

  const extractorProfileRef = {
    kind: 'path',
    root: 'sourceTree',
    path: BUILDER_REF,
  };
  const built = buildPostTradeCanonicalTypedFixture({
    sourceDocument,
    sourceFixtureRef: SOURCE_REF,
    sourceBytes,
    ontologyDocument: loadFinanceOntologyClosure(),
    patternDocument: loadYaml(PATTERN_PATH),
    classificationDocument,
    extractorProfileRef,
    extractorProfileDigest: sha256(fs.readFileSync(BUILDER_PATH)),
  });
  const classificationBytes = jsonBytes(classificationDocument);
  const manifestDocument = {
    schemaVersion: '1.0',
    profile: TYPED_FIXTURE_PROFILE,
    sourceFixtureRef: SOURCE_REF,
    sourceFixtureDigest: sha256(sourceBytes),
    sourceDocumentDigest: sha256(Buffer.from(canonicalJcs(sourceDocument), 'utf8')),
    classificationRef: CLASSIFICATION_REF,
    classificationDigest: sha256(classificationBytes),
    extractorProfileRef,
    extractorProfileDigest: sha256(fs.readFileSync(BUILDER_PATH)),
    expected: {
      routeInventoryDigest: built.summary.routeInventoryDigest,
      sourceHeuristicCandidateCount: built.summary.sourceHeuristicCandidateCount,
      typedRecordCount: built.summary.typedRecordCount,
      uniqueTypedRecordCount: built.summary.uniqueTypedRecordCount,
      duplicateRecordOccurrenceCount: built.summary.duplicateRecordOccurrenceCount,
      classifiedNonRecordCount: built.summary.classifiedNonRecordCount,
      unresolvedCount: built.summary.unresolvedCount,
      extraClaimCount: built.summary.extraClaimCount,
      requiredSyntheticDerivationCount: built.summary.requiredSyntheticDerivationCount,
      typedDocumentDigest: built.summary.typedDocumentDigest,
      summaryDigest: built.summary.summaryDigest,
    },
  };

  return new Map([
    [CLASSIFICATION_PATH, classificationBytes],
    [MANIFEST_PATH, jsonBytes(manifestDocument)],
  ]);
}

function run(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !['--check', '--write'].includes(argv[0])) {
    throw new Error(
      'usage: node scripts/domain/generate-post-trade-typed-fixture-locks.cjs --check|--write',
    );
  }
  const artifacts = buildArtifacts();
  const drift = [];
  for (const [file, expected] of artifacts) {
    const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (!current || !current.equals(expected)) drift.push(file);
    if (argv[0] === '--write' && (!current || !current.equals(expected))) {
      fs.writeFileSync(file, expected);
    }
  }
  if (argv[0] === '--check' && drift.length > 0) {
    throw new Error(
      `post-trade typed-fixture locks drifted: ${drift.map((file) => path.relative(ROOT, file)).join(', ')}`,
    );
  }
  process.stdout.write(
    `Post-trade typed-fixture locks: ${argv[0] === '--write' ? 'WROTE' : 'PASS'} `
      + `(${artifacts.size} artifacts)\n`,
  );
  return { artifactCount: artifacts.size, driftCount: drift.length };
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildArtifacts,
  run,
};
