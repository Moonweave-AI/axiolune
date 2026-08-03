#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  auditConstraintInstanceClosure,
} = require('./lib/m2-constraint-instance-audit.cjs');
const {
  buildConstraintInstanceManifest,
} = require('./lib/m2-constraint-instance-builder.cjs');
const {
  OUTPUT_PATHS,
} = require('./generate-constraint-instance-release-closure.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');

function posix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function addFile(files, relativePath) {
  if (files.has(relativePath)) return;
  const absolute = path.join(ROOT, ...relativePath.split('/'));
  if (!fs.existsSync(absolute)) return;
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) return;
  files.set(relativePath, fs.readFileSync(absolute));
}

function findManifests(directory, files) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'reference') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) findManifests(absolute, files);
    else if (entry.isFile() && entry.name === 'constraint-instance-manifest.json') {
      files.set(posix(path.relative(ROOT, absolute)), fs.readFileSync(absolute));
    }
  }
}

function workspaceFiles() {
  const files = new Map();
  const finance = path.join(ROOT, 'ontology', 'domain', 'finance');
  for (const moduleName of fs.readdirSync(finance).sort()) {
    addFile(files, `ontology/domain/finance/${moduleName}/module.yaml`);
  }
  for (const relativePath of [
    'scripts/domain/release-profile/v0.3.0/constraint-instance-execution-routes.json',
    'scripts/domain/run-m2-shacl-instance-closure.cjs',
    'scripts/domain/verify-custom-release-capabilities.cjs',
    'scripts/domain/release-profile/v0.3.0/custom-capability-bindings.json',
  ]) addFile(files, relativePath);
  addFile(
    files,
    'scripts/domain/release-profile/v0.3.0/constraint-instance-manifest.json',
  );
  for (const [manifestPath, bytes] of [...files]) {
    if (!manifestPath.endsWith('constraint-instance-manifest.json')) continue;
    try {
      const manifest = JSON.parse(bytes.toString('utf8'));
      for (const entry of Array.isArray(manifest.entries) ? manifest.entries : []) {
        for (const expectation of [entry.positiveExpectation, entry.negativeExpectation]) {
          for (const reference of [expectation?.artifactRef, expectation?.schemaRef]) {
            if (reference?.kind === 'path' && reference.root === 'sourceTree') {
              addFile(files, reference.path);
            }
          }
        }
      }
    } catch {
      // The validator emits the parse/JCS diagnostic.
    }
  }
  return files;
}

function readJcs(relativePath) {
  const bytes = fs.readFileSync(path.join(ROOT, ...relativePath.split('/')));
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${relativePath} is not exact UTF-8 RFC 8785 JCS`);
  }
  return value;
}

async function auditWorkspace() {
  const replay = await buildConstraintInstanceManifest({ sourceRoot: ROOT });
  if (replay.outcome !== 'built' || replay.instanceCount !== 10678) {
    return {
      outcome: 'invalid',
      issues: replay.issues,
      moduleCount: replay.moduleCount,
      entryCount: replay.instanceCount,
      replayOutcome: replay.outcome,
    };
  }
  return auditConstraintInstanceClosure({
    files: workspaceFiles(),
    replayedContextInventory: replay.instances,
    gateJoin: {
      discovery: readJcs(OUTPUT_PATHS.discovery),
      subjectInventory: readJcs(OUTPUT_PATHS.subjectInventory),
      report: readJcs(OUTPUT_PATHS.report),
    },
  });
}

async function main() {
  const result = await auditWorkspace();
  process.stdout.write(`${canonicalJcs(result)}\n`);
  process.exitCode = result.outcome === 'passed' ? 0 : 1;
}

if (require.main === module) {
  main().catch((cause) => {
    process.stderr.write(`${cause.stack || cause.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { auditWorkspace, workspaceFiles };
