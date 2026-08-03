'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  CRITERION_REFS,
  PROFILE_REF,
  REQUIRED_GATE_IDS,
  compareUtf8,
} = require('./m2-release-capability-definitions.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEMP_PREFIX = 'axiolune-m2-component-p1-replay-';
const SUMMARY_PREFIX = 'AXIOLUNE_M2_COMPONENT_REPLAY=';
const MAX_SOURCE_FILE_COUNT = 20_000;
const MAX_SOURCE_BYTE_COUNT = 1024 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;

const EXPECTED_COMPONENT_IDS = Object.freeze([
  'governance-baseline',
  'm3-meta-model-regression',
  'core-authoring-import-registry',
  'domain-digest-closure',
  'domain-tooling-regressions',
  'constraint-instance-release-closure',
  'isolated-custom-payload-replay',
  'specialized-domain-contracts',
  'foundation-identifier-custom-runtime',
  'public-symbol-inventory',
  'public-symbol-term-coverage',
  'cq-coverage-execution',
  'projection-determinism-drift',
  'owl-dl-profile-and-reasoners',
  'pit-fixture-diagnostic',
  'reference-review-file-coverage',
  'reference-coverage-traceability',
  'alignment-reference-digest-check',
  'alignment-semantic-review',
  'source-mutation',
  'final-source-mutation',
]);

const GATE_COMPONENT_BINDINGS = Object.freeze({
  'aggregate-pre-manifest': EXPECTED_COMPONENT_IDS,
  'artifact-dependency-dag': ['domain-tooling-regressions'],
  'compatibility-migration': ['domain-tooling-regressions'],
  'cq-coverage-execution': ['cq-coverage-execution'],
  'm2-compile': ['core-authoring-import-registry', 'domain-digest-closure'],
  'm3-import-digest': ['m3-meta-model-regression', 'core-authoring-import-registry'],
  'm3-schema': ['m3-meta-model-regression', 'core-authoring-import-registry'],
  'mapping-materialization': [
    'domain-tooling-regressions',
    'isolated-custom-payload-replay',
    'specialized-domain-contracts',
  ],
  'module-import-dag': ['core-authoring-import-registry', 'domain-digest-closure'],
  'owl-dl-profile': ['owl-dl-profile-and-reasoners'],
  'owl-reasoner-primary': ['owl-dl-profile-and-reasoners'],
  'owl-reasoner-secondary': ['owl-dl-profile-and-reasoners'],
  'pit-execution': ['domain-tooling-regressions', 'pit-fixture-diagnostic'],
  'projection-determinism-drift': ['projection-determinism-drift'],
  'public-symbol-term-coverage': ['public-symbol-inventory', 'public-symbol-term-coverage'],
  'reference-coverage-traceability': [
    'reference-review-file-coverage',
    'reference-coverage-traceability',
    'alignment-reference-digest-check',
    'alignment-semantic-review',
  ],
  'release-bundle-tamper': ['domain-tooling-regressions'],
  'replay-equivalence': [
    'domain-tooling-regressions',
    'constraint-instance-release-closure',
    'isolated-custom-payload-replay',
  ],
  'shacl-execution': [
    'domain-tooling-regressions',
    'constraint-instance-release-closure',
    'isolated-custom-payload-replay',
  ],
  'shacl-meta': [
    'domain-tooling-regressions',
    'constraint-instance-release-closure',
    'projection-determinism-drift',
  ],
  'source-mutation': ['source-mutation', 'final-source-mutation'],
  'target-identity-contract': [
    'domain-tooling-regressions',
    'foundation-identifier-custom-runtime',
    'reference-coverage-traceability',
  ],
});

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function exactKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort()) === canonicalJcs([...expected].sort());
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

function validateComponentReplaySummary(value) {
  const issues = [];
  const expectedFields = [
    'schemaVersion', 'profileRef', 'runMode', 'outcome', 'componentCount',
    'components', 'acceptanceStatuses', 'lifecycleStatus', 'callerEvidenceAccepted',
  ];
  if (!exactKeys(value, expectedFields)) {
    issues.push({
      code: 'M2_COMPONENT_P1_SUMMARY_SCHEMA',
      path: '',
      message: 'component replay summary differs from its closed field inventory',
    });
    return issues;
  }
  if (value.schemaVersion !== '1.0' || value.profileRef !== PROFILE_REF
      || value.runMode !== 'component-only' || value.outcome !== 'passed'
      || value.lifecycleStatus !== 'pending' || value.callerEvidenceAccepted !== false) {
    issues.push({
      code: 'M2_COMPONENT_P1_SUMMARY_OUTCOME',
      path: '',
      message: 'component replay summary is not one passed, non-evidentiary component-only run',
    });
  }
  const components = Array.isArray(value.components) ? value.components : [];
  if (value.componentCount !== EXPECTED_COMPONENT_IDS.length
      || value.componentCount !== components.length) {
    issues.push({
      code: 'M2_COMPONENT_P1_INVENTORY',
      path: '/components',
      message: `expected exactly ${EXPECTED_COMPONENT_IDS.length} executed components`,
    });
  }
  const actualIds = [];
  for (let index = 0; index < components.length; index += 1) {
    const row = components[index];
    if (!exactKeys(row, ['id', 'status']) || typeof row.id !== 'string'
        || row.status !== 'passed') {
      issues.push({
        code: 'M2_COMPONENT_P1_RESULT',
        path: `/components/${index}`,
        message: 'every exact component row must be passed',
      });
    }
    actualIds.push(row?.id);
  }
  if (canonicalJcs(actualIds) !== canonicalJcs(EXPECTED_COMPONENT_IDS)) {
    issues.push({
      code: 'M2_COMPONENT_P1_INVENTORY',
      path: '/components',
      message: 'component inventory/order differs from the trusted execution contract',
    });
  }
  const acceptance = Array.isArray(value.acceptanceStatuses) ? value.acceptanceStatuses : [];
  const expectedAcceptance = CRITERION_REFS.map((criterionRef) => ({
    criterionRef,
    status: 'pending',
  }));
  if (canonicalJcs(acceptance) !== canonicalJcs(expectedAcceptance)) {
    issues.push({
      code: 'M2_COMPONENT_P1_ACCEPTANCE_BOUNDARY',
      path: '/acceptanceStatuses',
      message: 'component-only replay must keep all six release criteria pending',
    });
  }
  return issues;
}

function gateReplayCoverage(value) {
  const passed = new Set((value.components || [])
    .filter((row) => row?.status === 'passed')
    .map((row) => row.id));
  const bindingIds = Object.keys(GATE_COMPONENT_BINDINGS).sort(compareUtf8);
  if (canonicalJcs(bindingIds) !== canonicalJcs(REQUIRED_GATE_IDS)) {
    throw new Error('P1 component replay gate binding inventory drifted from required gates');
  }
  return REQUIRED_GATE_IDS.map((gateId) => {
    const componentIds = [...GATE_COMPONENT_BINDINGS[gateId]];
    const missingComponentIds = componentIds.filter((componentId) => !passed.has(componentId));
    return {
      gateId,
      componentIds,
      // These rows are deliberately *not* gate execution evidence.  They only
      // prove that the reconstructed P1 tree passed the broad component
      // prerequisites associated with a gate.  The release verifier must still
      // resolve the gate's subject inventory and kindEvidence, invoke its
      // reviewed entrypoint, and byte-compare the independently replayed output.
      prerequisiteOutcome: missingComponentIds.length === 0 ? 'passed' : 'failed',
      evidenceUse: 'component-prerequisites-only',
      releaseEligibilityEvidence: false,
      missingComponentIds,
    };
  });
}

function sourceFileMap(gitReplay) {
  return new Map((gitReplay?.p1?.files || []).map((file) => [file.path, file]));
}

function verifySourceInventory(files) {
  if (files.size === 0) throw new Error('P1 component replay requires a reconstructed Git source tree');
  if (files.size > MAX_SOURCE_FILE_COUNT) {
    throw new Error(`P1 source tree exceeds ${MAX_SOURCE_FILE_COUNT} files`);
  }
  let byteCount = 0;
  for (const [relativePath, file] of files) {
    safePath(path.parse(SOURCE_ROOT).root, relativePath);
    if (!file || !Buffer.isBuffer(file.content) || !['100644', '100755'].includes(file.mode)
        || file.byteLength !== file.content.length || file.artifactDigest !== sha256(file.content)) {
      throw new Error(`P1 Git source row is not byte-closed: ${relativePath}`);
    }
    byteCount += file.content.length;
    if (byteCount > MAX_SOURCE_BYTE_COUNT) {
      throw new Error(`P1 source tree exceeds ${MAX_SOURCE_BYTE_COUNT} bytes`);
    }
  }
  return byteCount;
}

function walkRegularFiles(root, relativeRoot) {
  const absoluteRoot = safePath(root, relativeRoot);
  if (!fs.existsSync(absoluteRoot) || !fs.lstatSync(absoluteRoot).isDirectory()) return [];
  const rows = [];
  const visit = (absolute, relative) => {
    const entries = fs.readdirSync(absolute, { withFileTypes: true })
      .sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = `${relative}/${entry.name}`;
      const stat = fs.lstatSync(childAbsolute);
      if (stat.isSymbolicLink()) throw new Error(`trusted executable closure has symlink ${childRelative}`);
      if (stat.isDirectory()) visit(childAbsolute, childRelative);
      else if (stat.isFile()) rows.push(childRelative);
      else throw new Error(`trusted executable closure has non-regular artifact ${childRelative}`);
    }
  };
  visit(absoluteRoot, relativeRoot);
  return rows;
}

function trustedExecutablePaths() {
  const paths = [
    ...walkRegularFiles(SOURCE_ROOT, 'scripts/domain'),
    ...walkRegularFiles(SOURCE_ROOT, 'scripts/meta'),
    ...walkRegularFiles(SOURCE_ROOT, 'tests/m2/tooling')
      .filter((relativePath) => /\.(?:cjs|js|mjs|py)$/u.test(relativePath)),
    'package.json',
    'package-lock.json',
  ];
  return [...new Set(paths)].sort(compareUtf8);
}

function assertTrustedExecutableClosure(files) {
  const expected = trustedExecutablePaths();
  const expectedSet = new Set(expected);
  const candidateExecutablePaths = [...files.keys()].filter((relativePath) => (
    relativePath.startsWith('scripts/domain/')
      || relativePath.startsWith('scripts/meta/')
      || (relativePath.startsWith('tests/m2/tooling/')
        && /\.(?:cjs|js|mjs|py)$/u.test(relativePath))
      || ['package.json', 'package-lock.json'].includes(relativePath)
  )).sort(compareUtf8);
  if (canonicalJcs(candidateExecutablePaths) !== canonicalJcs(expected)) {
    const candidateSet = new Set(candidateExecutablePaths);
    const missing = expected.filter((relativePath) => !candidateSet.has(relativePath));
    const extra = candidateExecutablePaths.filter((relativePath) => !expectedSet.has(relativePath));
    throw new Error(
      `P1 executable inventory differs from trusted verifier: missing=${missing.slice(0, 10).join(',') || 'none'}; `
        + `extra=${extra.slice(0, 10).join(',') || 'none'}`,
    );
  }
  for (const relativePath of expected) {
    const candidate = files.get(relativePath)?.content;
    const trusted = fs.readFileSync(safePath(SOURCE_ROOT, relativePath));
    if (!Buffer.isBuffer(candidate) || !candidate.equals(trusted)) {
      throw new Error(`P1 executable differs from trusted verifier bytes: ${relativePath}`);
    }
  }
  return expected.length;
}

function materializeSource(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  for (const [relativePath, file] of files) {
    const absolute = safePath(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.content, { flag: 'wx' });
    if (file.mode === '100755' && process.platform !== 'win32') fs.chmodSync(absolute, 0o755);
  }
  return root;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: null,
    shell: false,
    windowsHide: true,
    maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
    timeout: options.timeout || 5 * 60 * 1000,
    cwd: options.cwd,
    env: options.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} ${args[0] || ''} exited ${String(result.status)}: `
        + Buffer.from(result.stderr || '').toString('utf8').slice(0, 4096),
    );
  }
  return result;
}

function initializeReplayRepository(root) {
  run('git', ['init', '--quiet'], { cwd: root });
  run('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  run('git', ['config', 'core.filemode', 'false'], { cwd: root });
  run('git', ['config', 'core.symlinks', 'false'], { cwd: root });
  run('git', ['config', 'user.name', 'Axiolune P1 Replay'], { cwd: root });
  run('git', ['config', 'user.email', 'p1-replay@invalid.example'], { cwd: root });
  run('git', ['add', '-f', '--all'], { cwd: root, timeout: 20 * 60 * 1000 });
  run('git', ['commit', '--quiet', '--no-gpg-sign', '-m', 'isolated P1 replay snapshot'], {
    cwd: root,
    timeout: 20 * 60 * 1000,
  });
  const exclude = path.join(root, '.git', 'info', 'exclude');
  fs.appendFileSync(exclude, '\nnode_modules/\ntmp/\n', 'utf8');
}

function verifyInstalledDependencyVersions(root) {
  const packageJson = JSON.parse(fs.readFileSync(safePath(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(safePath(root, 'package-lock.json'), 'utf8'));
  const dependencyNames = [...new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.devDependencies || {}),
  ])].sort(compareUtf8);
  for (const name of dependencyNames) {
    const locked = lock.packages?.[`node_modules/${name}`];
    const installedPath = path.join(SOURCE_ROOT, 'node_modules', ...name.split('/'), 'package.json');
    if (!locked || typeof locked.version !== 'string' || typeof locked.integrity !== 'string'
        || !fs.existsSync(installedPath)) {
      throw new Error(`trusted runtime dependency is not locked/installed: ${name}`);
    }
    const installed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
    if (installed.version !== locked.version) {
      throw new Error(`installed ${name}@${installed.version} differs from P1 lock ${locked.version}`);
    }
  }
  return dependencyNames.length;
}

function copyRuntimeDependencies(root) {
  const runtimeLock = JSON.parse(fs.readFileSync(
    safePath(root, 'scripts/domain/release-capability-profile/v0.3.0/runtime-lock.json'),
    'utf8',
  ));
  const dependencyLockBytes = fs.readFileSync(safePath(root, 'package-lock.json'));
  if (!exactKeys(runtimeLock, [
    'schemaVersion', 'profileRef', 'engine', 'version', 'permissionModelRequired',
    'networkPolicy', 'dependencyLock', 'entrypoints',
  ]) || runtimeLock.schemaVersion !== '1.0' || runtimeLock.profileRef !== PROFILE_REF
      || runtimeLock.engine !== 'node' || runtimeLock.version !== process.versions.node
      || runtimeLock.permissionModelRequired !== true || runtimeLock.networkPolicy !== 'deny'
      || runtimeLock.dependencyLock?.ref?.kind !== 'path'
      || runtimeLock.dependencyLock?.ref?.root !== 'sourceTree'
      || runtimeLock.dependencyLock?.ref?.path !== 'package-lock.json'
      || runtimeLock.dependencyLock?.digest !== sha256(dependencyLockBytes)) {
    throw new Error('P1 component replay runtime/dependency lock differs from the executing Node runtime');
  }
  const dependencyCount = verifyInstalledDependencyVersions(root);
  fs.cpSync(path.join(SOURCE_ROOT, 'node_modules'), path.join(root, 'node_modules'), {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });

  if (process.platform !== 'win32') {
    throw new Error('P1 component replay OWL runtime is pinned to the Windows Temurin artifact');
  }
  const lock = JSON.parse(fs.readFileSync(
    safePath(root, 'scripts/domain/owl-dl-profile/v0.3.0/tool-lock.json'),
    'utf8',
  ));
  const hostRuntime = path.join(SOURCE_ROOT, 'tmp', 'owl-dl-runtime');
  const targetRuntime = path.join(root, 'tmp', 'owl-dl-runtime');
  fs.mkdirSync(targetRuntime, { recursive: true });
  for (const row of [lock.javaRuntime, lock.robot]) {
    const source = path.join(hostRuntime, row.archiveFileName || row.artifactFileName);
    const name = row.archiveFileName || row.artifactFileName;
    if (!fs.existsSync(source) || sha256(fs.readFileSync(source)) !== row.artifactDigest) {
      throw new Error(`trusted OWL runtime artifact differs from P1 lock: ${name}`);
    }
    fs.copyFileSync(source, path.join(targetRuntime, name), fs.constants.COPYFILE_EXCL);
  }
  const extractionRoot = path.join(targetRuntime, 'jre-17.0.20+8');
  fs.mkdirSync(extractionRoot, { recursive: true });
  run('tar', [
    '-xf', path.join(targetRuntime, lock.javaRuntime.archiveFileName),
    '-C', extractionRoot,
  ], { cwd: root, timeout: 10 * 60 * 1000 });
  const javaPath = path.join(
    extractionRoot,
    'jdk-17.0.20+8-jre',
    'bin',
    'java.exe',
  );
  if (!fs.existsSync(javaPath)) throw new Error('locked JRE extraction emitted no expected java.exe');
  return {
    dependencyCount,
    javaPath,
    robotPath: path.join(targetRuntime, lock.robot.artifactFileName),
    jreArchivePath: path.join(targetRuntime, lock.javaRuntime.archiveFileName),
  };
}

function replayEnvironment(runtime) {
  const env = {
    TZ: 'UTC',
    PATH: process.env.PATH || '',
    SystemRoot: process.env.SystemRoot || '',
    WINDIR: process.env.WINDIR || '',
    TEMP: process.env.TEMP || os.tmpdir(),
    TMP: process.env.TMP || os.tmpdir(),
    AXIOLUNE_JAVA: runtime.javaPath,
    AXIOLUNE_ROBOT_JAR: runtime.robotPath,
    AXIOLUNE_JRE_ARCHIVE: runtime.jreArchivePath,
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '',
  };
  for (const name of ['COMSPEC', 'PATHEXT']) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  }
  return env;
}

function parseSummary(stdout) {
  const lines = Buffer.from(stdout || '').toString('utf8').split(/\r?\n/u);
  const matches = lines.filter((line) => line.startsWith(SUMMARY_PREFIX));
  if (matches.length !== 1) {
    throw new Error(`P1 component replay emitted ${matches.length} machine summaries; expected one`);
  }
  const bytes = Buffer.from(matches[0].slice(SUMMARY_PREFIX.length), 'utf8');
  const value = JSON.parse(bytes.toString('utf8'));
  if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error('P1 component replay summary is not exact RFC 8785 JCS');
  }
  return { value, bytes };
}

function removeReplayRoot(root) {
  const resolved = path.resolve(root);
  const prefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(prefix) || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error(`refusing to remove unexpected P1 replay root ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function replayP1ComponentGate(options) {
  const files = sourceFileMap(options.gitReplay);
  const sourceByteCount = verifySourceInventory(files);
  const trustedExecutableCount = assertTrustedExecutableClosure(files);
  const root = materializeSource(files);
  try {
    initializeReplayRepository(root);
    const runtime = copyRuntimeDependencies(root);
    const result = spawnSync(process.execPath, [
      safePath(root, 'scripts/domain/test-all-domain.js'),
      '--component-only',
      '--machine-component-summary',
    ], {
      cwd: root,
      env: replayEnvironment(runtime),
      encoding: null,
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (result.error?.code === 'ETIMEDOUT') {
      throw new Error('independent P1 component replay exceeded its time limit');
    }
    if (result.error?.code === 'ENOBUFS') {
      throw new Error('independent P1 component replay exceeded its output limit');
    }
    if (result.error) throw result.error;
    const summary = parseSummary(result.stdout);
    const issues = validateComponentReplaySummary(summary.value);
    const gateCoverage = gateReplayCoverage(summary.value);
    for (const row of gateCoverage) {
      if (row.prerequisiteOutcome !== 'passed') {
        issues.push({
          code: 'M2_COMPONENT_P1_GATE_PREREQUISITE',
          path: row.gateId,
          message: `gate lacks passed component prerequisites: ${row.missingComponentIds.join(',')}`,
        });
      }
    }
    return {
      outcome: issues.length === 0 ? 'passed' : 'invalid',
      issues,
      componentCount: summary.value.componentCount,
      gateCoverage,
      sourceFileCount: files.size,
      sourceByteCount,
      trustedExecutableCount,
      runtimeDependencyCount: runtime.dependencyCount,
      isolatedTemporaryCopy: true,
      callerEvidenceAccepted: false,
      processStatus: result.status,
      stdoutDigest: sha256(Buffer.from(result.stdout || '')),
      stderrDigest: sha256(Buffer.from(result.stderr || '')),
      summaryDigest: sha256(summary.bytes),
    };
  } finally {
    removeReplayRoot(root);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  EXPECTED_COMPONENT_IDS,
  GATE_COMPONENT_BINDINGS,
  MAX_SOURCE_BYTE_COUNT,
  MAX_SOURCE_FILE_COUNT,
  SUMMARY_PREFIX,
  assertTrustedExecutableClosure,
  gateReplayCoverage,
  parseSummary,
  replayP1ComponentGate,
  safePath,
  validateComponentReplaySummary,
  verifySourceInventory,
};
