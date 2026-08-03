#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { projectShaclWithInventory } = require('./generate-m2-shacl.cjs');
const {
  compileShaclInstanceFixtures,
} = require('./lib/m2-shacl-instance-fixture-compiler.cjs');
const {
  executeShaclInstanceFixtures,
} = require('./lib/m2-shacl-instance-executor.cjs');
const { canonicalJcs } = require('./lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const FINANCE = path.join(ROOT, 'ontology', 'domain', 'finance');
const SCHEMA_PATH = path.join(
  ROOT,
  'scripts',
  'domain',
  'shacl-instance-profile',
  'v0.3.0',
  'fixture-aggregate.schema.json',
);
const SNAPSHOT_IMPLEMENTATION_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'scripts/domain/generate-m2-shacl.cjs',
  'scripts/domain/run-m2-shacl-instance-closure.cjs',
  'scripts/domain/lib/direct-sparql-select.cjs',
  'scripts/domain/lib/m2-constraint-instance-audit.cjs',
  'scripts/domain/lib/m2-shacl-instance-descriptor.cjs',
  'scripts/domain/lib/m2-shacl-instance-executor.cjs',
  'scripts/domain/lib/m2-shacl-instance-fixture-compiler.cjs',
  'scripts/domain/lib/pattern-injected-fields.cjs',
  'scripts/domain/lib/rdfc-1.0.cjs',
  'scripts/domain/lib/strict-source-locator.cjs',
  'scripts/domain/lib/typed-projection-common.cjs',
  'scripts/domain/shacl-instance-profile/v0.3.0/fixture-aggregate.schema.json',
  'scripts/domain/shacl-instance-profile/v0.3.0/pyshacl-batch-worker.py',
]);

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function repositoryPath(absolutePath) {
  return path.relative(ROOT, absolutePath).replaceAll(path.sep, '/');
}

function modulePaths() {
  return fs.readdirSync(FINANCE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(FINANCE, entry.name, 'module.yaml'))
    .filter((filePath) => fs.existsSync(filePath))
    .sort((left, right) => byteCompare(repositoryPath(left), repositoryPath(right)));
}

function snapshotPaths(modules) {
  return [...new Set([
    ...SNAPSHOT_IMPLEMENTATION_PATHS,
    ...modules.map(repositoryPath),
  ])].sort(byteCompare);
}

function sourceSnapshot(relativePaths) {
  return Object.freeze(relativePaths.map((relativePath) => {
    const absolutePath = path.join(ROOT, ...relativePath.split('/'));
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`snapshot input is missing: ${relativePath}`);
    }
    return Object.freeze({
      path: relativePath,
      digest: sha256(fs.readFileSync(absolutePath)),
    });
  }));
}

async function projectionsFromModules(modules) {
  const projections = [];
  const inventory = [];
  for (const modulePath of modules) {
    const sourceBytes = fs.readFileSync(modulePath);
    const document = yaml.load(sourceBytes.toString('utf8'));
    const projected = await projectShaclWithInventory(document);
    const contextBytes = Buffer.from(canonicalJcs(projected.contexts), 'utf8');
    const relativePath = repositoryPath(modulePath);
    projections.push(Object.freeze({
      modulePath: relativePath,
      contexts: projected.contexts,
      shaclBytes: projected.bytes,
    }));
    inventory.push(Object.freeze({
      modulePath: relativePath,
      moduleDigest: sha256(sourceBytes),
      contextCount: projected.contexts.length,
      contextDigest: sha256(contextBytes),
      shaclDigest: sha256(projected.bytes),
    }));
  }
  return Object.freeze({
    projections: Object.freeze(projections),
    inventory: Object.freeze(inventory),
  });
}

function assertStable(label, before, after) {
  if (canonicalJcs(before) !== canonicalJcs(after)) {
    throw new Error(`${label} drifted during execution; this run is invalid and was not written`);
  }
}

function safeOutputDirectory(argument) {
  if (typeof argument !== 'string' || argument.length === 0) {
    throw new Error('usage: node scripts/domain/run-m2-shacl-instance-closure.cjs --output-dir <new repo-relative directory>');
  }
  const resolved = path.resolve(ROOT, argument);
  if (resolved === ROOT || !resolved.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error('output directory must be a new directory below the repository root');
  }
  if (fs.existsSync(resolved)) throw new Error(`output directory already exists: ${resolved}`);
  return resolved;
}

function writeExclusive(filePath, bytes) {
  fs.writeFileSync(filePath, bytes, { flag: 'wx' });
}

async function main() {
  const outputIndex = process.argv.indexOf('--output-dir');
  const outputDirectory = safeOutputDirectory(
    outputIndex >= 0 ? process.argv[outputIndex + 1] : null,
  );
  const modules = modulePaths();
  if (modules.length === 0) throw new Error('no finance modules discovered');
  const paths = snapshotPaths(modules);
  const sourceBefore = sourceSnapshot(paths);
  const projectionBefore = await projectionsFromModules(modules);
  const compilation = await compileShaclInstanceFixtures({
    projections: projectionBefore.projections,
  });
  const execution = await executeShaclInstanceFixtures(compilation);

  // Re-read every source byte and repeat the pure projection before accepting
  // evidence. A concurrent edit or nondeterministic projection invalidates the run.
  const sourceAfter = sourceSnapshot(paths);
  const projectionAfter = await projectionsFromModules(modules);
  const sourceFinal = sourceSnapshot(paths);
  assertStable('source snapshot', sourceBefore, sourceAfter);
  assertStable('source snapshot after replay projection', sourceBefore, sourceFinal);
  assertStable('projection inventory', projectionBefore.inventory, projectionAfter.inventory);
  for (let index = 0; index < projectionBefore.projections.length; index += 1) {
    const before = projectionBefore.projections[index];
    const after = projectionAfter.projections[index];
    if (!before.shaclBytes.equals(after.shaclBytes)
        || canonicalJcs(before.contexts) !== canonicalJcs(after.contexts)) {
      throw new Error(`projection bytes drifted during execution: ${before.modulePath}`);
    }
  }

  const customValue = Object.freeze({
    schemaVersion: '1.0',
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    artifactKind: 'unresolvedCustomConstraintInstanceInventory',
    resolution: 'unresolved-custom-capability',
    count: compilation.customCount,
    entries: compilation.custom,
  });
  const customBytes = Buffer.from(canonicalJcs(customValue), 'utf8');
  const schemaBytes = fs.readFileSync(SCHEMA_PATH);
  const outputRelative = repositoryPath(outputDirectory);
  const artifact = (name, bytes) => Object.freeze({
    artifactRef: Object.freeze({
      kind: 'path',
      root: 'sourceTree',
      path: `${outputRelative}/${name}`,
    }),
    artifactDigest: sha256(bytes),
    byteLength: bytes.length,
  });
  const manifest = Object.freeze({
    schemaVersion: '1.0',
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    artifactKind: 'shaclConstraintInstanceClosureRun',
    outcome: execution.value.outcome === 'passed' && compilation.customCount === 0
      ? 'passed' : execution.value.outcome === 'passed'
        ? 'shacl-passed-custom-unresolved' : 'failed',
    sourceSnapshot: sourceBefore,
    projectionInventory: projectionBefore.inventory,
    constraintInventory: Object.freeze({
      descriptorCount: compilation.descriptorCount,
      shaclCount: compilation.shaclCount,
      customCount: compilation.customCount,
    }),
    artifacts: Object.freeze({
      positiveFixtures: artifact('positive-fixtures.json', compilation.positive.bytes),
      negativeFixtures: artifact('negative-fixtures.json', compilation.negative.bytes),
      fixtureSchema: Object.freeze({
        artifactRef: Object.freeze({
          kind: 'path',
          root: 'sourceTree',
          path: repositoryPath(SCHEMA_PATH),
        }),
        artifactDigest: sha256(schemaBytes),
        byteLength: schemaBytes.length,
      }),
      executionEvidence: artifact('execution-evidence.json', execution.bytes),
      unresolvedCustom: artifact('unresolved-custom.json', customBytes),
    }),
    executionSummary: execution.value.summary,
  });
  const manifestBytes = Buffer.from(canonicalJcs(manifest), 'utf8');
  fs.mkdirSync(outputDirectory, { recursive: true });
  writeExclusive(path.join(outputDirectory, 'positive-fixtures.json'), compilation.positive.bytes);
  writeExclusive(path.join(outputDirectory, 'negative-fixtures.json'), compilation.negative.bytes);
  writeExclusive(path.join(outputDirectory, 'execution-evidence.json'), execution.bytes);
  writeExclusive(path.join(outputDirectory, 'unresolved-custom.json'), customBytes);
  writeExclusive(path.join(outputDirectory, 'run-manifest.json'), manifestBytes);
  process.stdout.write(`${canonicalJcs({
    outputDirectory: outputRelative,
    outcome: manifest.outcome,
    constraintInventory: manifest.constraintInventory,
    executionSummary: manifest.executionSummary,
    artifactDigests: Object.fromEntries(Object.entries(manifest.artifacts)
      .map(([key, value]) => [key, value.artifactDigest])),
  })}\n`);
}

main().catch((cause) => {
  process.stderr.write(`${cause.stack || cause.message}\n`);
  process.exitCode = 1;
});
