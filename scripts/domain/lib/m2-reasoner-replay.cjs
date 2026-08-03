'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const REASONER_GATE_IDS = Object.freeze([
  'owl-dl-profile',
  'owl-reasoner-primary',
  'owl-reasoner-secondary',
]);
const TRUSTED_CONTROL_PATHS = Object.freeze([
  'scripts/domain/owl-dl-profile/v0.3.0/owl-dl-evidence.schema.json',
  'scripts/domain/owl-dl-profile/v0.3.0/subject-discovery-contract.json',
  'scripts/domain/owl-dl-profile/v0.3.0/tool-lock.json',
  'scripts/domain/run-owl-dl-gate.cjs',
]);
const MATERIALIZED_EXACT_PATHS = new Set([
  'ontology/meta/projection/axiolune-meta.owl.ttl',
  'package-lock.json',
  ...TRUSTED_CONTROL_PATHS,
]);
const MATERIALIZED_PREFIXES = Object.freeze([
  'ontology/domain/finance/',
  'scripts/domain/owl-dl-profile/v0.3.0/',
  'tests/m2/fixtures/owl-dl/',
]);
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_RUNNER_OUTPUT_BYTES = 32 * 1024 * 1024;

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function artifactDigest(value) {
  return sha256(Buffer.from(canonicalJcs(value), 'utf8'));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function isCanonicalRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.normalize('NFC')
    && !value.startsWith('/')
    && !value.includes('\\')
    && !/^[A-Za-z]:/u.test(value)
    && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function shouldMaterialize(relativePath) {
  return MATERIALIZED_EXACT_PATHS.has(relativePath)
    || MATERIALIZED_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function materializeVerifiedP1Subset(files, destinationRoot) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('verified P1 file inventory is empty');
  }
  const destination = path.resolve(destinationRoot);
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  const written = [];
  for (const file of files) {
    if (!shouldMaterialize(file?.path)) continue;
    if (!isCanonicalRelativePath(file.path) || !Buffer.isBuffer(file.content)) {
      throw new Error(`P1 contains an unsafe reasoner source entry ${String(file?.path)}`);
    }
    const target = path.resolve(destination, ...file.path.split('/'));
    const relative = path.relative(destination, target);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) {
      throw new Error(`reasoner source entry escapes the materialization root: ${file.path}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const descriptor = fs.openSync(target, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, file.content);
    } finally {
      fs.closeSync(descriptor);
    }
    written.push(file.path);
  }
  written.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const requiredPath of MATERIALIZED_EXACT_PATHS) {
    if (!written.includes(requiredPath)) {
      throw new Error(`P1 reasoner source is missing ${requiredPath}`);
    }
  }
  return written;
}

function treeFileMap(gitReplay) {
  return new Map(
    (Array.isArray(gitReplay?.p1?.files) ? gitReplay.p1.files : [])
      .map((file) => [file.path, file]),
  );
}

function exactTrustedControlBindings(gitReplay, trustedRoot, issues) {
  const byPath = treeFileMap(gitReplay);
  for (const relativePath of TRUSTED_CONTROL_PATHS) {
    const p1File = byPath.get(relativePath);
    const trustedPath = path.join(trustedRoot, ...relativePath.split('/'));
    let trustedBytes = null;
    try {
      const stat = fs.lstatSync(trustedPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('trusted control is not a non-symlink regular file');
      }
      trustedBytes = fs.readFileSync(trustedPath);
    } catch (cause) {
      issues.push({
        code: 'M2_RELEASE_REASONER_TRUSTED_CONTROL_REQUIRED',
        path: relativePath,
        message: cause?.message || String(cause),
        kind: 'unverified',
      });
      continue;
    }
    if (!p1File) {
      issues.push({
        code: 'M2_RELEASE_REASONER_P1_CONTROL_MISSING',
        path: relativePath,
        message: 'the reconstructed P1 tree omits one trusted reasoner control',
        kind: 'missing',
      });
    } else if (!p1File.content.equals(trustedBytes)) {
      issues.push({
        code: 'M2_RELEASE_REASONER_TRUSTED_CONTROL_SUBSTITUTION',
        path: relativePath,
        message: `P1 ${sha256(p1File.content)} differs from trusted verifier control ${sha256(trustedBytes)}`,
        kind: 'invalid',
      });
    }
  }
}

function safeTempCleanup(tempRoot) {
  if (!tempRoot) return;
  const resolved = path.resolve(tempRoot);
  const expectedParent = path.resolve(os.tmpdir());
  const relative = path.relative(expectedParent, resolved);
  if (!relative.startsWith('axiolune-m2-reasoner-replay-')
      || relative.includes(path.sep) || path.isAbsolute(relative)) {
    throw new Error(`refusing to remove unexpected reasoner temp path ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function trustedRuntimePaths(trustedRoot) {
  const lockPath = path.join(
    trustedRoot,
    'scripts',
    'domain',
    'owl-dl-profile',
    'v0.3.0',
    'tool-lock.json',
  );
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const runtimeRoot = path.join(trustedRoot, 'tmp', 'owl-dl-runtime');
  return {
    java: path.join(
      runtimeRoot,
      'jre-17.0.20+8',
      'jdk-17.0.20+8-jre',
      'bin',
      process.platform === 'win32' ? 'java.exe' : 'java',
    ),
    robotJar: path.join(runtimeRoot, lock.robot.artifactFileName),
    jreArchive: path.join(runtimeRoot, lock.javaRuntime.archiveFileName),
  };
}

function minimalRunnerEnvironment(tempRoot) {
  const allowed = [
    'ComSpec', 'PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR',
  ];
  const environment = {};
  for (const name of allowed) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  environment.TEMP = tempRoot;
  environment.TMP = tempRoot;
  return environment;
}

function executeTrustedRunner({ sourceRoot, outputRoot, tempRoot, trustedRoot }) {
  const runnerPath = path.join(trustedRoot, 'scripts', 'domain', 'run-owl-dl-gate.cjs');
  const runtime = trustedRuntimePaths(trustedRoot);
  for (const [label, runtimePath] of Object.entries(runtime)) {
    let stat;
    try {
      stat = fs.lstatSync(runtimePath);
    } catch (cause) {
      return {
        status: null,
        signal: null,
        stdout: '',
        stderr: `${label} is unavailable: ${cause?.message || String(cause)}`,
        runtimeMissing: true,
      };
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {
        status: null,
        signal: null,
        stdout: '',
        stderr: `${label} is not a non-symlink regular file`,
        runtimeMissing: true,
      };
    }
  }
  return spawnSync(process.execPath, [
    runnerPath,
    '--source-root', sourceRoot,
    '--output-dir', outputRoot,
    '--java', runtime.java,
    '--robot-jar', runtime.robotJar,
    '--jre-archive', runtime.jreArchive,
  ], {
    cwd: trustedRoot,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    env: minimalRunnerEnvironment(tempRoot),
    timeout: 30 * 60 * 1000,
    maxBuffer: MAX_RUNNER_OUTPUT_BYTES,
  });
}

function validateReplayEvidence(evidence) {
  if (!isPlainObject(evidence)
      || evidence.schemaVersion !== '1.0'
      || evidence.profileRef !== PROFILE_REF
      || evidence.outcome !== 'passed'
      || evidence.moduleCount !== 10) {
    throw new Error('trusted runner evidence has the wrong closed release identity');
  }
  if (!Array.isArray(evidence.sourceArtifacts) || evidence.sourceArtifacts.length !== 11
      || !Array.isArray(evidence.importedOntologyIris)
      || evidence.importedOntologyIris.length !== 11) {
    throw new Error('trusted runner evidence does not cover the exact M3 + ten-module inventory');
  }
  const gateIds = Array.isArray(evidence.gates)
    ? evidence.gates.map((gate) => gate?.gateId) : [];
  if (canonicalJcs(gateIds) !== canonicalJcs(REASONER_GATE_IDS)
      || evidence.gates.some((gate) => gate?.outcome !== 'passed')) {
    throw new Error('trusted runner evidence does not contain the exact three passed OWL gates');
  }
  const negatives = Array.isArray(evidence.negativeReasonerCorpus)
    ? evidence.negativeReasonerCorpus : [];
  const negativeKeys = negatives.map((row) => (
    `${row?.reasoner || ''}\0${row?.fixture || ''}\0${row?.outcome || ''}\0${row?.diagnosticCode || ''}`
  )).sort();
  const expected = [
    'HermiT\0inconsistent.ttl\0rejected\0ontology-inconsistent',
    'HermiT\0unsatisfiable.ttl\0rejected\0unsatisfiable-class',
    'JFact\0inconsistent.ttl\0rejected\0ontology-inconsistent',
    'JFact\0unsatisfiable.ttl\0rejected\0unsatisfiable-class',
  ].sort();
  if (canonicalJcs(negativeKeys) !== canonicalJcs(expected)) {
    throw new Error('trusted runner evidence does not contain the exact two-reasoner negative corpus');
  }
}

function parseJsonArtifact(bytes, label) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${label} is missing`);
  return JSON.parse(bytes.toString('utf8'));
}

function artifactKey(reference, digest) {
  return `${canonicalJcs(reference)}\0${digest}`;
}

function loadPayloadCatalog(p1, artifacts) {
  const reference = p1?.payloadArtifactCatalogRef;
  if (!isPlainObject(reference) || reference.kind !== 'path'
      || reference.root !== 'payload' || typeof reference.path !== 'string') {
    throw new Error('P1 payloadArtifactCatalogRef is not a payload path');
  }
  const catalog = parseJsonArtifact(artifacts.get(reference.path), 'payload artifact catalog');
  if (!Array.isArray(catalog.entries)) throw new Error('payload artifact catalog has no entries');
  return new Map(catalog.entries.map((row) => [
    artifactKey(row.artifactRef, row.artifactDigest),
    row,
  ]));
}

function resolveEvidenceArtifact(reference, digest, context) {
  if (!isPlainObject(reference)) throw new Error('kindEvidence artifactRef is invalid');
  if (reference.kind === 'path' && reference.root === 'payload') {
    return context.artifacts.get(reference.path);
  }
  if (reference.kind === 'path' && reference.root === 'sourceTree') {
    return treeFileMap(context.gitReplay).get(reference.path)?.content;
  }
  const row = context.catalog.get(artifactKey(reference, digest));
  if (!row || row.locator?.kind !== 'wholeFile' || typeof row.locator.path !== 'string') {
    throw new Error('kindEvidence has no exact whole-file payload-catalog locator');
  }
  return context.artifacts.get(row.locator.path);
}

function bindReplayToGateReports(options, replayEvidence, replayDigest, issues) {
  const p1 = options.p1;
  const artifacts = options.artifacts instanceof Map ? options.artifacts : new Map();
  let catalog;
  try {
    catalog = loadPayloadCatalog(p1, artifacts);
  } catch (cause) {
    issues.push({
      code: 'M2_RELEASE_REASONER_EVIDENCE_CATALOG_REQUIRED',
      path: '/payloadArtifactCatalogRef',
      message: cause?.message || String(cause),
      kind: 'invalid',
    });
    return;
  }
  const rows = Array.isArray(p1?.gateReports) ? p1.gateReports : [];
  const rowById = new Map(rows.map((row) => [row?.gateId, row]));
  for (const gateId of REASONER_GATE_IDS) {
    const row = rowById.get(gateId);
    if (!row || row.reportRef?.kind !== 'path' || row.reportRef.root !== 'payload') {
      issues.push({
        code: 'M2_RELEASE_REASONER_GATE_REPORT_REQUIRED',
        path: `/gateReports/${gateId}`,
        message: `${gateId} has no exact payload ValidationReport`,
        kind: 'missing',
      });
      continue;
    }
    try {
      const report = parseJsonArtifact(
        artifacts.get(row.reportRef.path),
        `${gateId} ValidationReport`,
      );
      if (artifactDigest(report) !== row.reportDigest) {
        throw new Error(`${gateId} reportDigest differs from the resolved report`);
      }
      const binding = report.kindEvidence;
      if (!isPlainObject(binding) || binding.artifactDigest !== replayDigest) {
        throw new Error(`${gateId} kindEvidence digest is not the independently replayed evidence digest`);
      }
      const evidenceBytes = resolveEvidenceArtifact(
        binding.artifactRef,
        binding.artifactDigest,
        { artifacts, catalog, gitReplay: options.gitReplay },
      );
      const authoredEvidence = parseJsonArtifact(evidenceBytes, `${gateId} kindEvidence`);
      if (artifactDigest(authoredEvidence) !== binding.artifactDigest
          || canonicalJcs(authoredEvidence) !== canonicalJcs(replayEvidence)) {
        throw new Error(`${gateId} kindEvidence bytes/content differ from trusted replay`);
      }
    } catch (cause) {
      issues.push({
        code: 'M2_RELEASE_REASONER_EVIDENCE_REPLAY_MISMATCH',
        path: row?.reportRef?.path || `/gateReports/${gateId}`,
        message: cause?.message || String(cause),
        kind: 'invalid',
      });
    }
  }
}

function verifyReasonerReplay(options = {}) {
  const issues = [];
  const gitReplay = options.gitReplay;
  if (!gitReplay?.p1 || !Array.isArray(gitReplay.p1.files)
      || gitReplay.p1.files.length === 0
      || (Array.isArray(gitReplay.issues) && gitReplay.issues.length > 0)) {
    return {
      outcome: 'incomplete',
      evidence: null,
      issues: [{
        code: 'M2_RELEASE_REASONER_P1_TREE_REQUIRED',
        path: '',
        message: 'reasoner replay requires an independently reconstructed, issue-free P1 Git tree',
        kind: 'unverified',
      }],
    };
  }
  const trustedRoot = path.resolve(options.trustedRoot || path.resolve(__dirname, '..', '..', '..'));
  exactTrustedControlBindings(gitReplay, trustedRoot, issues);
  if (issues.length > 0) {
    return { outcome: 'invalid', evidence: null, issues };
  }

  let tempRoot = null;
  let evidence = null;
  try {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-m2-reasoner-replay-'));
    const sourceRoot = path.join(tempRoot, 'source');
    const outputRoot = path.join(tempRoot, 'output');
    materializeVerifiedP1Subset(gitReplay.p1.files, sourceRoot);
    const execute = options.executeRunner || executeTrustedRunner;
    const result = execute({ sourceRoot, outputRoot, tempRoot, trustedRoot });
    if (result?.runtimeMissing) {
      issues.push({
        code: 'M2_RELEASE_REASONER_RUNTIME_REQUIRED',
        path: '',
        message: result.stderr || 'pinned OWL runtime is unavailable',
        kind: 'unverified',
      });
      return { outcome: 'incomplete', evidence: null, issues };
    }
    if (result?.error || result?.status !== 0 || result?.signal) {
      const diagnostic = `${result?.stderr || ''}\n${result?.stdout || ''}`.trim().slice(0, 8000);
      issues.push({
        code: 'M2_RELEASE_REASONER_EXECUTION_FAILED',
        path: '',
        message: result?.error?.message || diagnostic || `trusted runner exited ${String(result?.status)}`,
        kind: 'invalid',
      });
      return { outcome: 'invalid', evidence: null, issues };
    }
    const evidencePath = path.join(outputRoot, 'owl-dl-evidence.json');
    const stat = fs.lstatSync(evidencePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_EVIDENCE_BYTES) {
      throw new Error('trusted runner evidence is not a bounded non-symlink regular file');
    }
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    validateReplayEvidence(evidence);
    const replayDigest = artifactDigest(evidence);
    bindReplayToGateReports(options, evidence, replayDigest, issues);
  } catch (cause) {
    issues.push({
      code: 'M2_RELEASE_REASONER_REPLAY_FAILED',
      path: '',
      message: cause?.message || String(cause),
      kind: 'invalid',
    });
  } finally {
    try {
      safeTempCleanup(tempRoot);
    } catch (cause) {
      issues.push({
        code: 'M2_RELEASE_REASONER_TEMP_CLEANUP',
        path: tempRoot || '',
        message: cause?.message || String(cause),
        kind: 'invalid',
      });
    }
  }
  return {
    outcome: issues.some((issue) => issue.kind === 'invalid')
      ? 'invalid' : issues.length > 0 ? 'incomplete' : 'passed',
    evidence,
    issues,
    // This replayer deliberately invokes the dedicated OWL runner.  The
    // current required-gate rows still declare run-release-capability.cjs and
    // its generic discovery/evidence contracts instead.  Until those reviewed
    // rows bind this exact runner and its OWL controls, this successful
    // computation is diagnostic evidence only, not release-gate evidence.
    releaseGateEvidenceEstablished: false,
    declaredEntrypointExecuted: false,
    declaredDiscoveryReplayed: false,
    declaredEvidenceSchemaValidated: false,
    callerEvidenceAccepted: false,
  };
}

module.exports = {
  MATERIALIZED_EXACT_PATHS,
  MATERIALIZED_PREFIXES,
  REASONER_GATE_IDS,
  TRUSTED_CONTROL_PATHS,
  artifactDigest,
  bindReplayToGateReports,
  materializeVerifiedP1Subset,
  validateReplayEvidence,
  verifyReasonerReplay,
};
