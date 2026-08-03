'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  EXPECTATIONS_PATH,
  MANIFEST_PATH,
  buildConstraintInstanceManifest,
} = require('./m2-constraint-instance-builder.cjs');
const {
  EXECUTION_ROUTES_PATH,
  auditConstraintInstanceClosure,
} = require('./m2-constraint-instance-audit.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  compileShaclInstanceFixtures,
} = require('./m2-shacl-instance-fixture-compiler.cjs');
const {
  WORKER_PATH,
  executeShaclInstanceFixtures,
  probePython,
} = require('./m2-shacl-instance-executor.cjs');

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const EXPECTED_COUNTS = Object.freeze({
  moduleCount: 10,
  entryCount: 10325,
  authoredInstanceCount: 661,
  generatedCount: 9664,
  authoredConstraintCount: 170,
  authoredBindingCount: 567,
});
const GATE_PATHS = Object.freeze({
  discovery:
    'docs/domain/infrastructure/constraint-instance-runs/round-1/shacl-execution.discovery.json',
  subjectInventory:
    'docs/domain/infrastructure/constraint-instance-runs/round-1/shacl-execution.subject-inventory.json',
  report:
    'docs/domain/infrastructure/constraint-instance-runs/round-1/shacl-execution.validation-report.json',
});
const SHACL_RUN_MANIFEST_PATH =
  'docs/domain/infrastructure/shacl-instance-runs/round-7/run-manifest.json';
const SHACL_IMPLEMENTATION_PATHS = Object.freeze([
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
const FIXED_PATHS = Object.freeze([
  EXPECTATIONS_PATH,
  MANIFEST_PATH,
  EXECUTION_ROUTES_PATH,
  SHACL_RUN_MANIFEST_PATH,
  ...Object.values(GATE_PATHS),
]);
const MAX_SELECTED_FILES = 128;
const MAX_SELECTED_BYTES = 256 * 1024 * 1024;
const TEMP_PREFIX = 'axiolune-constraint-p1-replay-';

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function safePath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0
      || relativePath !== relativePath.normalize('NFC')
      || relativePath.includes('\\') || relativePath.startsWith('/')
      || /^[A-Za-z]:/u.test(relativePath)
      || relativePath.split('/').some((segment) => (
        segment === '' || segment === '.' || segment === '..'
      ))) {
    throw new Error(`unsafe reconstructed-P1 path ${String(relativePath)}`);
  }
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`reconstructed-P1 path escapes replay root: ${relativePath}`);
  }
  return absolute;
}

function parseJcs(bytes, label) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${label} bytes are missing`);
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${label} is not exact UTF-8 RFC 8785 JCS`);
  }
  return value;
}

function sourceRefs(value, paths = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) sourceRefs(item, paths);
    return paths;
  }
  if (!value || typeof value !== 'object') return paths;
  if (value.kind === 'path' && value.root === 'sourceTree'
      && typeof value.path === 'string') {
    paths.add(value.path);
  }
  for (const child of Object.values(value)) sourceRefs(child, paths);
  return paths;
}

function collectConstraintReplayFiles(files) {
  if (!(files instanceof Map)) throw new Error('reconstructed P1 files must be a Map');
  const selectedPaths = new Set(FIXED_PATHS);
  for (const filePath of files.keys()) {
    if (/^ontology\/domain\/finance\/[^/]+\/module\.yaml$/u.test(filePath)) {
      selectedPaths.add(filePath);
    }
  }
  for (const relativePath of FIXED_PATHS) {
    const value = parseJcs(files.get(relativePath), relativePath);
    for (const referencePath of sourceRefs(value)) selectedPaths.add(referencePath);
    if (relativePath === SHACL_RUN_MANIFEST_PATH) {
      for (const snapshot of Array.isArray(value.sourceSnapshot) ? value.sourceSnapshot : []) {
        if (typeof snapshot?.path === 'string') selectedPaths.add(snapshot.path);
      }
    }
  }
  if (selectedPaths.size > MAX_SELECTED_FILES) {
    throw new Error(
      `constraint replay closure exceeds ${MAX_SELECTED_FILES} source files: ${selectedPaths.size}`,
    );
  }
  const selected = new Map();
  let byteLength = 0;
  for (const relativePath of [...selectedPaths].sort(byteCompare)) {
    safePath(process.cwd(), relativePath);
    const bytes = files.get(relativePath);
    if (!Buffer.isBuffer(bytes)) {
      throw new Error(`constraint replay source is absent from reconstructed P1: ${relativePath}`);
    }
    byteLength += bytes.length;
    if (byteLength > MAX_SELECTED_BYTES) {
      throw new Error(
        `constraint replay closure exceeds ${MAX_SELECTED_BYTES} bytes`,
      );
    }
    selected.set(relativePath, bytes);
  }
  return selected;
}

function materialize(selected) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  try {
    for (const [relativePath, bytes] of selected) {
      const absolute = safePath(root, relativePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, bytes, { flag: 'wx' });
    }
    return root;
  } catch (cause) {
    removeTemporaryRoot(root);
    throw cause;
  }
}

function removeTemporaryRoot(root) {
  const resolved = path.resolve(root);
  const tempPrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(tempPrefix)
      || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error(`refusing to remove non-constraint-replay path ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function readTree(root) {
  const files = new Map();
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`symlink in replay tree: ${entry.name}`);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        const relativePath = path.relative(root, absolute).split(path.sep).join('/');
        safePath(root, relativePath);
        files.set(relativePath, fs.readFileSync(absolute));
      } else {
        throw new Error(`non-regular entry in replay tree: ${absolute}`);
      }
    }
  }
  walk(root);
  return files;
}

function readJcsFromRoot(root, relativePath) {
  return parseJcs(fs.readFileSync(safePath(root, relativePath)), relativePath);
}

function countIssue(pathLabel, expected, actual) {
  return {
    code: 'M2_CONSTRAINT_INSTANCE_EXACT_COUNT',
    path: pathLabel,
    message: `expected exact release count ${expected}; found ${actual}`,
  };
}

function verifyExactArtifact(files, descriptor, expectedBytes, label, issues) {
  const fields = ['artifactRef', 'artifactDigest', 'byteLength'];
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)
      || canonicalJcs(Object.keys(descriptor).sort()) !== canonicalJcs(fields.sort())
      || descriptor.artifactRef?.kind !== 'path'
      || descriptor.artifactRef?.root !== 'sourceTree'
      || typeof descriptor.artifactRef?.path !== 'string'
      || !/^sha256:[0-9a-f]{64}$/u.test(descriptor.artifactDigest || '')
      || !Number.isInteger(descriptor.byteLength) || descriptor.byteLength < 0) {
    issues.push({
      code: 'M2_SHACL_P1_ARTIFACT_SCHEMA',
      path: label,
      message: `${label} differs from its closed sourceTree artifact tuple`,
    });
    return false;
  }
  const bytes = files.get(descriptor.artifactRef.path);
  if (!Buffer.isBuffer(bytes) || sha256(bytes) !== descriptor.artifactDigest
      || bytes.length !== descriptor.byteLength) {
    issues.push({
      code: 'M2_SHACL_P1_ARTIFACT_DIGEST',
      path: descriptor.artifactRef.path,
      message: `${label} ref/digest/byteLength does not resolve to exact P1 bytes`,
    });
    return false;
  }
  if (expectedBytes && !bytes.equals(expectedBytes)) {
    issues.push({
      code: 'M2_SHACL_P1_REEXECUTION_MISMATCH',
      path: descriptor.artifactRef.path,
      message: `${label} bytes differ from independent pinned-engine replay`,
    });
    return false;
  }
  return true;
}

function expectedSourceSnapshotPaths(modulePaths) {
  return [...SHACL_IMPLEMENTATION_PATHS, ...modulePaths].sort(byteCompare);
}

function verifyShaclRunManifest(options) {
  const {
    files, manifest, replay, compilation, execution, hostRoot,
  } = options;
  const issues = [];
  const expectedFields = [
    'schemaVersion', 'profileRef', 'artifactKind', 'outcome', 'sourceSnapshot',
    'projectionInventory', 'constraintInventory', 'artifacts', 'executionSummary',
  ];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || canonicalJcs(Object.keys(manifest).sort())
        !== canonicalJcs(expectedFields.sort())
      || manifest.schemaVersion !== '1.0' || manifest.profileRef !== PROFILE_REF
      || manifest.artifactKind !== 'shaclConstraintInstanceClosureRun'
      || manifest.outcome !== 'shacl-passed-custom-unresolved') {
    issues.push({
      code: 'M2_SHACL_P1_RUN_MANIFEST_SCHEMA',
      path: SHACL_RUN_MANIFEST_PATH,
      message: 'P1 SHACL run manifest differs from the closed passed-with-Custom-unresolved schema',
    });
  }
  const modulePaths = replay.projections.map((projection) => projection.modulePath)
    .sort(byteCompare);
  const expectedSnapshotPaths = expectedSourceSnapshotPaths(modulePaths);
  const snapshots = Array.isArray(manifest?.sourceSnapshot) ? manifest.sourceSnapshot : [];
  const actualSnapshotPaths = snapshots.map((snapshot) => snapshot?.path);
  if (canonicalJcs(actualSnapshotPaths) !== canonicalJcs(expectedSnapshotPaths)) {
    issues.push({
      code: 'M2_SHACL_P1_SOURCE_SNAPSHOT_COVERAGE',
      path: `${SHACL_RUN_MANIFEST_PATH}/sourceSnapshot`,
      message: 'P1 SHACL source snapshot does not equal the exact implementation-plus-module inventory',
    });
  }
  for (const snapshot of snapshots) {
    const bytes = files.get(snapshot?.path);
    if (!snapshot || typeof snapshot.path !== 'string'
        || !/^sha256:[0-9a-f]{64}$/u.test(snapshot.digest || '')
        || !Buffer.isBuffer(bytes) || sha256(bytes) !== snapshot.digest) {
      issues.push({
        code: 'M2_SHACL_P1_SOURCE_SNAPSHOT_DIGEST',
        path: snapshot?.path || SHACL_RUN_MANIFEST_PATH,
        message: 'P1 SHACL source snapshot row does not bind exact reconstructed Git bytes',
      });
      continue;
    }
    if (SHACL_IMPLEMENTATION_PATHS.includes(snapshot.path)) {
      const hostPath = safePath(hostRoot, snapshot.path);
      const hostBytes = fs.existsSync(hostPath) ? fs.readFileSync(hostPath) : null;
      if (!Buffer.isBuffer(hostBytes) || !hostBytes.equals(bytes)) {
        issues.push({
          code: 'M2_SHACL_P1_TRUSTED_VERIFIER_DRIFT',
          path: snapshot.path,
          message: 'P1 SHACL implementation bytes differ from this trusted verifier implementation',
        });
      }
    }
  }
  const projectionInventory = replay.projections.map((projection) => {
    const moduleBytes = files.get(projection.modulePath);
    return {
      modulePath: projection.modulePath,
      moduleDigest: sha256(moduleBytes),
      contextCount: projection.contexts.length,
      contextDigest: sha256(Buffer.from(canonicalJcs(projection.contexts), 'utf8')),
      shaclDigest: sha256(projection.shaclBytes),
    };
  });
  if (canonicalJcs(manifest?.projectionInventory) !== canonicalJcs(projectionInventory)) {
    issues.push({
      code: 'M2_SHACL_P1_PROJECTION_INVENTORY',
      path: `${SHACL_RUN_MANIFEST_PATH}/projectionInventory`,
      message: 'P1 projection inventory differs from independent normalized-IR projection bytes',
    });
  }
  const expectedConstraintInventory = {
    descriptorCount: EXPECTED_COUNTS.entryCount,
    shaclCount: 10171,
    customCount: 154,
  };
  if (canonicalJcs(manifest?.constraintInventory)
      !== canonicalJcs(expectedConstraintInventory)
      || compilation.descriptorCount !== expectedConstraintInventory.descriptorCount
      || compilation.shaclCount !== expectedConstraintInventory.shaclCount
      || compilation.customCount !== expectedConstraintInventory.customCount) {
    issues.push({
      code: 'M2_SHACL_P1_CONSTRAINT_INVENTORY',
      path: `${SHACL_RUN_MANIFEST_PATH}/constraintInventory`,
      message: 'P1/independently compiled SHACL-Custom inventory is not exactly 10,325/10,171/154',
    });
  }
  const unresolvedCustomBytes = Buffer.from(canonicalJcs({
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    artifactKind: 'unresolvedCustomConstraintInstanceInventory',
    resolution: 'unresolved-custom-capability',
    count: compilation.customCount,
    entries: compilation.custom,
  }), 'utf8');
  const artifacts = manifest?.artifacts || {};
  const artifactFields = [
    'positiveFixtures', 'negativeFixtures', 'fixtureSchema',
    'executionEvidence', 'unresolvedCustom',
  ];
  if (canonicalJcs(Object.keys(artifacts).sort()) !== canonicalJcs(artifactFields.sort())) {
    issues.push({
      code: 'M2_SHACL_P1_ARTIFACT_INVENTORY',
      path: `${SHACL_RUN_MANIFEST_PATH}/artifacts`,
      message: 'P1 SHACL run artifact inventory differs from the closed five-artifact set',
    });
  }
  verifyExactArtifact(
    files, artifacts.positiveFixtures, compilation.positive.bytes,
    'positiveFixtures', issues,
  );
  verifyExactArtifact(
    files, artifacts.negativeFixtures, compilation.negative.bytes,
    'negativeFixtures', issues,
  );
  verifyExactArtifact(files, artifacts.fixtureSchema, null, 'fixtureSchema', issues);
  verifyExactArtifact(
    files, artifacts.executionEvidence, execution.bytes,
    'executionEvidence', issues,
  );
  verifyExactArtifact(
    files, artifacts.unresolvedCustom, unresolvedCustomBytes,
    'unresolvedCustom', issues,
  );
  if (execution.value.outcome !== 'passed'
      || canonicalJcs(manifest?.executionSummary) !== canonicalJcs(execution.value.summary)
      || execution.value.summary.discovered !== 10171
      || execution.value.summary.executed !== 10171
      || execution.value.summary.passed !== 10171
      || execution.value.summary.caseExecutions !== 20342
      || ['failed', 'skipped', 'pending', 'engineFailures'].some(
        (field) => execution.value.summary[field] !== 0,
      )) {
    issues.push({
      code: 'M2_SHACL_P1_REEXECUTION_OUTCOME',
      path: `${SHACL_RUN_MANIFEST_PATH}/executionSummary`,
      message: 'independent pinned-engine P1 replay did not prove exactly 10,171/10,171 SHACL instances and 20,342 cases passed',
    });
  }
  return issues;
}

async function replayWorker(root, pythonPath) {
  const replay = await buildConstraintInstanceManifest({ sourceRoot: root });
  const files = readTree(root);
  const storedManifestBytes = files.get(MANIFEST_PATH);
  const manifestByteReplayMatched = Buffer.isBuffer(replay.bytes)
    && Buffer.isBuffer(storedManifestBytes)
    && replay.bytes.equals(storedManifestBytes);
  const issues = [];
  if (replay.outcome !== 'built') {
    issues.push(...(replay.issues || []));
  }
  if (!manifestByteReplayMatched) {
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_MANIFEST_REPLAY_MISMATCH',
      path: MANIFEST_PATH,
      message: 'stored P1 manifest bytes differ from the manifest independently rebuilt from P1 normalized IR',
    });
  }
  const gateJoin = {
    discovery: readJcsFromRoot(root, GATE_PATHS.discovery),
    subjectInventory: readJcsFromRoot(root, GATE_PATHS.subjectInventory),
    report: readJcsFromRoot(root, GATE_PATHS.report),
  };
  const audit = auditConstraintInstanceClosure({
    files,
    replayedContextInventory: replay.instances,
    gateJoin,
  });
  issues.push(...audit.issues);
  const compilation = await compileShaclInstanceFixtures({
    projections: replay.projections,
  });
  const execution = await executeShaclInstanceFixtures(compilation, {
    pythonPath,
    workerPath: WORKER_PATH,
    workerRef:
      'scripts/domain/shacl-instance-profile/v0.3.0/pyshacl-batch-worker.py',
  });
  const shaclRunManifest = readJcsFromRoot(root, SHACL_RUN_MANIFEST_PATH);
  issues.push(...verifyShaclRunManifest({
    files,
    manifest: shaclRunManifest,
    replay,
    compilation,
    execution,
    hostRoot: path.resolve(__dirname, '..', '..', '..'),
  }));
  const actualCounts = {
    moduleCount: audit.moduleCount,
    entryCount: audit.entryCount,
    authoredInstanceCount: replay.authoredCount,
    generatedCount: audit.generatedCount,
    authoredConstraintCount: audit.authoredConstraintCount,
    authoredBindingCount: audit.authoredBindingCount,
  };
  for (const [name, expected] of Object.entries(EXPECTED_COUNTS)) {
    if (actualCounts[name] !== expected) {
      issues.push(countIssue(name, expected, actualCounts[name]));
    }
  }
  if (audit.gateJoin?.itemCount !== EXPECTED_COUNTS.entryCount
      || audit.gateJoin?.checkCount !== EXPECTED_COUNTS.entryCount) {
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_GATE_JOIN_EXACT_COUNT',
      path: GATE_PATHS.report,
      message: `expected ${EXPECTED_COUNTS.entryCount}/${EXPECTED_COUNTS.entryCount} `
        + `discovery/check joins; found ${audit.gateJoin?.itemCount || 0}/`
        + `${audit.gateJoin?.checkCount || 0}`,
    });
  }
  if (audit.routedModules.length !== EXPECTED_COUNTS.moduleCount
      || audit.missingRoutedModules.length !== 0) {
    issues.push({
      code: 'M2_CONSTRAINT_INSTANCE_ROUTE_EXACT_COUNT',
      path: EXECUTION_ROUTES_PATH,
      message: `expected ${EXPECTED_COUNTS.moduleCount} fully dual-routed modules and no missing modules`,
    });
  }
  return {
    schemaVersion: '1.0',
    profileRef: PROFILE_REF,
    outcome: issues.length === 0 ? 'passed' : 'invalid',
    issues,
    ...actualCounts,
    routedModuleCount: audit.routedModules.length,
    missingRoutedModuleCount: audit.missingRoutedModules.length,
    manifestByteReplayMatched,
    contextualReplayVerified: audit.contextualReplayVerified === true,
    gateJoinOutcome: audit.gateJoin?.outcome || 'invalid',
    gateJoinItemCount: audit.gateJoin?.itemCount || 0,
    gateJoinCheckCount: audit.gateJoin?.checkCount || 0,
    shaclDescriptorCount: compilation.descriptorCount,
    shaclInstanceCount: compilation.shaclCount,
    customDeferredToCapabilityReplayCount: compilation.customCount,
    shaclCaseExecutionCount: execution.value.summary.caseExecutions,
    shaclExecutionOutcome: execution.value.outcome,
    shaclCallerEvidenceAccepted: false,
  };
}

function sandboxEnvironment() {
  const result = { TZ: 'UTC' };
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[name] === 'string') result[name] = process.env[name];
  }
  return result;
}

function replayConstraintInstancesFromP1(options) {
  const selected = collectConstraintReplayFiles(options.files);
  const root = materialize(selected);
  try {
    const pythonRuntime = probePython({
      ...(options.pythonPath ? { pythonPath: options.pythonPath } : {}),
    });
    const scriptRoot = path.resolve(__dirname, '..', '..', '..');
    const result = spawnSync(process.execPath, [
      '--permission',
      '--allow-child-process',
      '--disable-sigusr1',
      '--no-addons',
      '--no-global-search-paths',
      '--max-old-space-size=3072',
      `--allow-fs-read=${root}`,
      `--allow-fs-read=${path.join(scriptRoot, 'scripts', 'domain')}`,
      `--allow-fs-read=${path.join(scriptRoot, 'node_modules')}`,
      `--allow-fs-read=${path.join(scriptRoot, 'package.json')}`,
      `--allow-fs-read=${path.join(scriptRoot, 'package-lock.json')}`,
      `--allow-fs-read=${pythonRuntime.executable}`,
      __filename,
      '--worker',
      root,
      pythonRuntime.executable,
    ], {
      cwd: root,
      encoding: null,
      env: sandboxEnvironment(),
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      timeout: options.timeoutMs ?? 20 * 60 * 1000,
      windowsHide: true,
    });
    if (result.error?.code === 'ETIMEDOUT') {
      throw new Error('independent P1 constraint-instance replay exceeded its time limit');
    }
    if (result.error?.code === 'ENOBUFS') {
      throw new Error('independent P1 constraint-instance replay exceeded its output limit');
    }
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `independent P1 constraint-instance replay exited ${result.status}: `
          + Buffer.from(result.stderr || '').toString('utf8').slice(0, 4096),
      );
    }
    const value = parseJcs(Buffer.from(result.stdout || ''), 'constraint replay worker output');
    return {
      ...value,
      isolatedTemporaryCopy: true,
      callerEvidenceAccepted: false,
      selectedFileCount: selected.size,
      selectedByteCount: [...selected.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    };
  } finally {
    removeTemporaryRoot(root);
  }
}

function workspaceConstraintReplayFiles(root) {
  const candidates = new Map();
  const finance = safePath(root, 'ontology/domain/finance');
  for (const entry of fs.readdirSync(finance, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const relativePath = `ontology/domain/finance/${entry.name}/module.yaml`;
    const absolute = safePath(root, relativePath);
    if (fs.existsSync(absolute)) candidates.set(relativePath, fs.readFileSync(absolute));
  }
  for (const relativePath of FIXED_PATHS) {
    candidates.set(relativePath, fs.readFileSync(safePath(root, relativePath)));
  }
  for (const relativePath of FIXED_PATHS) {
    const value = parseJcs(candidates.get(relativePath), relativePath);
    for (const referencePath of sourceRefs(value)) {
      if (!candidates.has(referencePath)) {
        candidates.set(referencePath, fs.readFileSync(safePath(root, referencePath)));
      }
    }
    if (relativePath === SHACL_RUN_MANIFEST_PATH) {
      for (const snapshot of Array.isArray(value.sourceSnapshot) ? value.sourceSnapshot : []) {
        if (typeof snapshot?.path === 'string' && !candidates.has(snapshot.path)) {
          candidates.set(snapshot.path, fs.readFileSync(safePath(root, snapshot.path)));
        }
      }
    }
  }
  return collectConstraintReplayFiles(candidates);
}

async function workerMain(argv) {
  if (argv.length !== 3 || argv[0] !== '--worker' || !path.isAbsolute(argv[2])) {
    throw new Error('internal worker requires --worker <materialized-p1-root> <absolute-python-path>');
  }
  const value = await replayWorker(path.resolve(argv[1]), argv[2]);
  process.stdout.write(canonicalJcs(value));
}

if (require.main === module) {
  workerMain(process.argv.slice(2)).catch((cause) => {
    process.stderr.write(`${cause.stack || cause.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  EXPECTED_COUNTS,
  FIXED_PATHS,
  GATE_PATHS,
  SHACL_IMPLEMENTATION_PATHS,
  SHACL_RUN_MANIFEST_PATH,
  collectConstraintReplayFiles,
  replayConstraintInstancesFromP1,
  replayWorker,
  safePath,
  verifyShaclRunManifest,
  workspaceConstraintReplayFiles,
};
