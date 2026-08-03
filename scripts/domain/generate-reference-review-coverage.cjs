#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');
const {
  collectActiveReferenceEvidence,
} = require('./lib/active-reference-evidence.cjs');
const { inspectReferenceBundle } = require('./lib/reference-closure.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'reference-review-coverage.json',
);
const LOCK_PATH = path.join(
  ROOT,
  'docs',
  'ontology',
  'references',
  'references.lock.yaml',
);
const FRAGMENT_PATHS = [
  path.join(
    ROOT,
    'docs',
    'ontology',
    'references',
    'reviews',
    'authority',
    'reference-review-coverage.fragment.json',
  ),
  path.join(
    ROOT,
    'docs',
    'ontology',
    'references',
    'reviews',
    'axiolune-design-draft',
    'reference-review-coverage.fragment.json',
  ),
  path.join(
    ROOT,
    'docs',
    'ontology',
    'references',
    'reviews',
    'ontology-design',
    'reference-review-coverage.fragment.json',
  ),
  path.join(
    ROOT,
    'docs',
    'ontology',
    'references',
    'reviews',
    'project-reference',
    'project-reference-coverage.fragment.json',
  ),
];
const PROJECT_FIELDS = new Set([
  'files',
  'projectDigest',
  'projectId',
  'releaseOrCommit',
  'rootPath',
]);
const FILE_FIELDS = new Set([
  'artifactDigest',
  'disposition',
  'mediaType',
  'path',
  'rationale',
  'reviewMethod',
  'reviewRecordDigest',
  'reviewRecordRef',
  'reviewerRef',
]);

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactFields(value, allowed, at) {
  if (!isPlainObject(value)) throw new Error(`${at}: expected an object`);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${at}.${field}: unexpected field`);
  }
}

function loadFragment(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`missing reference review fragment ${path.relative(ROOT, file)}`);
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${path.relative(ROOT, file)}: ${error.message}`);
  }
  if (!isPlainObject(value) || value.schemaVersion !== '1.0' || !Array.isArray(value.projects)) {
    throw new Error(`${path.relative(ROOT, file)}: invalid fragment contract`);
  }
  return value;
}

function buildCoverageFromFragments(fragments, inspection) {
  if (!inspection || !inspection.referenceRootDigest) {
    throw new Error('reference inventory did not produce an exact root digest');
  }
  if (inspection.ok === false) {
    const detail = (inspection.errors || [])
      .slice(0, 10)
      .map((error) => `${error.code}@${error.at}`)
      .join(', ');
    throw new Error(`reference inventory is structurally invalid: ${detail}`);
  }
  const inventoryByRoot = new Map(
    inspection.projects.map((project) => [project.rootPath, project]),
  );
  const seenIds = new Set();
  const seenRoots = new Set();
  const seenPaths = new Set();
  const projects = [];
  let fileCount = 0;

  for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex++) {
    const fragment = fragments[fragmentIndex];
    if (!isPlainObject(fragment) || fragment.schemaVersion !== '1.0' || !Array.isArray(fragment.projects)) {
      throw new Error(`fragments[${fragmentIndex}]: invalid fragment contract`);
    }
    for (let projectIndex = 0; projectIndex < fragment.projects.length; projectIndex++) {
      const source = fragment.projects[projectIndex];
      const at = `fragments[${fragmentIndex}].projects[${projectIndex}]`;
      exactFields(source, PROJECT_FIELDS, at);
      if (typeof source.projectId !== 'string' || source.projectId.length === 0) {
        throw new Error(`${at}.projectId: expected a non-empty string`);
      }
      if (seenIds.has(source.projectId)) throw new Error(`${at}.projectId: duplicate ${source.projectId}`);
      if (seenRoots.has(source.rootPath)) throw new Error(`${at}.rootPath: duplicate ${source.rootPath}`);
      seenIds.add(source.projectId);
      seenRoots.add(source.rootPath);

      const inventory = inventoryByRoot.get(source.rootPath);
      if (!inventory) throw new Error(`${at}.rootPath: orphan project root ${source.rootPath}`);
      if (source.projectDigest !== inventory.projectDigest) {
        throw new Error(`${at}.projectDigest: expected ${inventory.projectDigest}`);
      }
      if (!Array.isArray(source.files) || source.files.length === 0) {
        throw new Error(`${at}.files: expected a non-empty file list`);
      }
      if (source.files.length !== inventory.fileCount) {
        throw new Error(`${at}.files: expected ${inventory.fileCount}, got ${source.files.length}`);
      }

      const files = source.files.map((row, rowIndex) => {
        const rowAt = `${at}.files[${rowIndex}]`;
        exactFields(row, FILE_FIELDS, rowAt);
        if (typeof row.path !== 'string' || !row.path.startsWith(`${source.rootPath}/`)) {
          throw new Error(`${rowAt}.path: outside ${source.rootPath}`);
        }
        if (seenPaths.has(row.path)) throw new Error(`${rowAt}.path: duplicate ${row.path}`);
        seenPaths.add(row.path);
        return {
          path: row.path,
          artifactDigest: row.artifactDigest,
          mediaType: row.mediaType,
          disposition: row.disposition,
          reviewMethod: row.reviewMethod,
          rationale: row.rationale,
          reviewerRef: row.reviewerRef,
          reviewRecordRef: row.reviewRecordRef,
          reviewRecordDigest: row.reviewRecordDigest,
        };
      }).sort((left, right) => utf8Compare(left.path, right.path));
      fileCount += files.length;

      if (inventory.releaseOrCommit && source.releaseOrCommit !== inventory.releaseOrCommit) {
        throw new Error(
          `${at}.releaseOrCommit: expected exact Git commit ${inventory.releaseOrCommit}`,
        );
      }
      projects.push({
        projectId: source.projectId,
        rootPath: source.rootPath,
        ...(inventory.releaseOrCommit
          ? { releaseOrCommit: inventory.releaseOrCommit }
          : {}),
        projectDigest: source.projectDigest,
        files,
      });
    }
  }

  for (const rootPath of inventoryByRoot.keys()) {
    if (!seenRoots.has(rootPath)) throw new Error(`uncovered reference project ${rootPath}`);
  }
  if (seenRoots.size !== inventoryByRoot.size) {
    throw new Error(`coverage root count ${seenRoots.size} does not equal inventory ${inventoryByRoot.size}`);
  }
  if (fileCount !== inspection.fileCount) {
    throw new Error(`coverage file count ${fileCount} does not equal inventory ${inspection.fileCount}`);
  }
  projects.sort((left, right) => utf8Compare(left.projectId, right.projectId));
  return {
    schemaVersion: '1.0',
    referenceRootDigest: inspection.referenceRootDigest,
    projects,
  };
}

function validateActiveCoverageBindings(coverage, activeEvidence) {
  if (!coverage || !Array.isArray(coverage.projects)) {
    throw new Error('coverage binding requires the strict aggregate');
  }
  if (!activeEvidence || !(activeEvidence.byPath instanceof Map)) {
    throw new Error('coverage binding requires active evidence indexed by path');
  }

  const rowsByPath = new Map();
  for (const project of coverage.projects) {
    for (const row of project.files) {
      if (rowsByPath.has(row.path)) {
        throw new Error(`${row.path}: duplicate aggregate coverage path`);
      }
      rowsByPath.set(row.path, row);
    }
  }

  function validateRecords(records, at) {
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error(`${at}: active evidence record list is empty`);
    }
    for (const record of records) {
      if (!['normative', 'implementation', 'contextual'].includes(record.usage)) {
        throw new Error(`${at}: unsupported active evidence usage ${record.usage}`);
      }
    }
  }

  for (const [activePath, records] of activeEvidence.byPath) {
    const row = rowsByPath.get(activePath);
    if (!row) throw new Error(`${activePath}: active evidence has no aggregate coverage row`);
    validateRecords(records, activePath);
    if (!['usedNormative', 'usedImplementation'].includes(row.disposition)) {
      throw new Error(
        `${activePath}: active evidence requires a used disposition, got ${row.disposition}`,
      );
    }
  }

}

function outputBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function run(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  if (write === check) {
    throw new Error('choose exactly one mode: --write or --check');
  }
  const fragments = FRAGMENT_PATHS.map(loadFragment);
  const inspection = inspectReferenceBundle({ rootDir: ROOT });
  const coverage = buildCoverageFromFragments(fragments, inspection);
  const lock = YAML.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const activeEvidence = collectActiveReferenceEvidence(ROOT, lock);
  validateActiveCoverageBindings(coverage, activeEvidence);
  const expected = outputBytes(coverage);
  if (write) {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, expected);
  } else if (!fs.existsSync(OUTPUT) || !fs.readFileSync(OUTPUT).equals(expected)) {
    throw new Error('reference-review-coverage.json is missing or byte-drifted');
  }
  return {
    mode: write ? 'write' : 'check',
    referenceRootDigest: coverage.referenceRootDigest,
    projectCount: coverage.projects.length,
    fileCount: coverage.projects.reduce((total, project) => total + project.files.length, 0),
    gitCheckoutCount: inspection.gitCheckoutCount,
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(run()));
  } catch (error) {
    console.error(`FAIL reference review coverage: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildCoverageFromFragments,
  outputBytes,
  run,
  validateActiveCoverageBindings,
};
