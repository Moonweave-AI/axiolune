'use strict';

// This module is the deliberately small bootstrap for terminal M2 adoption.
// It depends only on Node built-ins so every downstream verifier dependency
// can be measured before Node evaluates it. Its own bytes and the CLI bytes
// are an out-of-band trust prerequisite: repository code cannot establish
// trust in the bootstrap that is already executing.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RUNTIME_ID = 'axiolune-m2-terminal-runtime-v1';
const RUNTIME_CLOSURE_TAG = 'axiolune-m2-terminal-runtime-closure-v1\0';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;

// This inventory is code-owned and closed.  An external manifest may pin the
// bytes, but it cannot omit a verifier dependency or choose a smaller TCB.
const REQUIRED_RUNTIME_PATHS = Object.freeze([
  'scripts/domain/lib/m2-adoption-verifier.cjs',
  'scripts/domain/lib/m2-ed25519.cjs',
  'scripts/domain/lib/m2-git-replay.cjs',
  'scripts/domain/lib/m2-payload-independent-replay.cjs',
  'scripts/domain/lib/m2-release-capability-definitions.cjs',
  'scripts/domain/lib/m2-release-lifecycle.cjs',
  'scripts/domain/lib/m2-terminal-adoption-verifier.cjs',
  'scripts/domain/lib/m2-terminal-runtime-closure.cjs',
  'scripts/domain/lib/strict-source-locator.cjs',
  'scripts/domain/run-m2-adoption-verifier.cjs',
]);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalJcs(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    if (value !== value.normalize('NFC')) throw new Error('JCS string is not Unicode NFC');
    if (hasUnpairedSurrogate(value)) throw new Error('JCS string contains an unpaired Unicode surrogate');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error('JCS profile accepts only safe integers');
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJcs).join(',')}]`;
  if (!isPlainObject(value)) throw new Error('JCS value must be a JSON value');
  // RFC 8785 orders object member names by UTF-16 code units, which is the
  // ordering used by JavaScript's default Array.prototype.sort().
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${canonicalJcs(key)}:${canonicalJcs(value[key])}`).join(',')}}`;
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function terminalRuntimeClosureDigest(manifest) {
  return sha256(Buffer.concat([
    Buffer.from(RUNTIME_CLOSURE_TAG, 'utf8'),
    Buffer.from(canonicalJcs(manifest), 'utf8'),
  ]));
}

function exactKeys(value, fields, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a closed object`);
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...fields].sort(compareUtf8);
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    throw new Error(`${label} fields differ from the closed schema`);
  }
}

function resolveRuntimeRoot(runtimeRoot) {
  if (typeof runtimeRoot !== 'string' || runtimeRoot.length === 0) {
    throw new Error('terminal runtimeRoot is required');
  }
  const absolute = path.resolve(runtimeRoot);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('terminal runtimeRoot must be a non-symlink directory');
  }
  return fs.realpathSync.native(absolute);
}

function normalizedPathForComparison(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function samePath(left, right) {
  return normalizedPathForComparison(left) === normalizedPathForComparison(right);
}

function readRegularFileWithinRoot(runtimeRoot, relativePath, label) {
  const absolute = path.resolve(runtimeRoot, ...relativePath.split('/'));
  const relative = path.relative(runtimeRoot, absolute);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} escapes terminal runtimeRoot`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  const real = fs.realpathSync.native(absolute);
  if (!samePath(real, absolute)) {
    throw new Error(`${label} resolves through a filesystem alias`);
  }
  return { absolute: real, bytes: fs.readFileSync(real) };
}

function observeNodeRuntime() {
  const executableRealPath = fs.realpathSync.native(process.execPath);
  const stat = fs.lstatSync(executableRealPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Node executable must resolve to a regular non-symlink file');
  }
  const bytes = fs.readFileSync(executableRealPath);
  return {
    executableRealPath,
    executableByteLength: bytes.length,
    executableDigest: sha256(bytes),
    version: process.version,
    modulesAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
  };
}

function localRequireTargets(sourceBytes, relativePath) {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
  const targets = [];
  const expression = /\brequire\(\s*(['"])(\.[^'"]+)\1\s*\)/gu;
  let match;
  while ((match = expression.exec(source)) !== null) {
    let target = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), match[2]));
    if (!path.posix.extname(target)) target += '.cjs';
    targets.push(target);
  }
  return [...new Set(targets)].sort(compareUtf8);
}

function readRuntimeFiles(runtimeRoot) {
  const allowed = new Set(REQUIRED_RUNTIME_PATHS);
  const observations = [];
  for (const relativePath of REQUIRED_RUNTIME_PATHS) {
    const observed = readRegularFileWithinRoot(
      runtimeRoot,
      relativePath,
      `terminal runtime file ${relativePath}`,
    );
    for (const target of localRequireTargets(observed.bytes, relativePath)) {
      if (!allowed.has(target)) {
        throw new Error(
          `terminal runtime closure omits local dependency ${target} required by ${relativePath}`,
        );
      }
    }
    observations.push({
      path: relativePath,
      byteLength: observed.bytes.length,
      artifactDigest: sha256(observed.bytes),
    });
  }
  return observations;
}

function buildTerminalRuntimeClosureManifest(runtimeRoot) {
  const resolvedRoot = resolveRuntimeRoot(runtimeRoot);
  return {
    schemaVersion: '1.0',
    runtimeId: RUNTIME_ID,
    runtimeRootRealPath: resolvedRoot,
    nodeRuntime: observeNodeRuntime(),
    files: readRuntimeFiles(resolvedRoot),
  };
}

function validateNodeRuntime(value) {
  exactKeys(value, [
    'executableRealPath', 'executableByteLength', 'executableDigest',
    'version', 'modulesAbi', 'platform', 'arch',
  ], 'terminal runtime closure.nodeRuntime');
  if (typeof value.executableRealPath !== 'string' || value.executableRealPath.length === 0
      || !Number.isSafeInteger(value.executableByteLength) || value.executableByteLength < 1
      || !DIGEST_RE.test(value.executableDigest || '')
      || typeof value.version !== 'string' || value.version.length === 0
      || typeof value.modulesAbi !== 'string' || value.modulesAbi.length === 0
      || typeof value.platform !== 'string' || value.platform.length === 0
      || typeof value.arch !== 'string' || value.arch.length === 0) {
    throw new Error('terminal runtime closure.nodeRuntime is invalid');
  }
}

function validateTerminalRuntimeClosureManifest(manifest) {
  exactKeys(manifest, [
    'schemaVersion', 'runtimeId', 'runtimeRootRealPath', 'nodeRuntime', 'files',
  ], 'terminal runtime closure');
  if (manifest.schemaVersion !== '1.0' || manifest.runtimeId !== RUNTIME_ID
      || typeof manifest.runtimeRootRealPath !== 'string'
      || manifest.runtimeRootRealPath.length === 0) {
    throw new Error('terminal runtime closure identity/root is invalid');
  }
  validateNodeRuntime(manifest.nodeRuntime);
  if (!Array.isArray(manifest.files)
      || manifest.files.length !== REQUIRED_RUNTIME_PATHS.length) {
    throw new Error('terminal runtime closure file inventory is incomplete');
  }
  for (let index = 0; index < manifest.files.length; index += 1) {
    const row = manifest.files[index];
    exactKeys(row, ['path', 'byteLength', 'artifactDigest'], `terminal runtime closure.files/${index}`);
    if (row.path !== REQUIRED_RUNTIME_PATHS[index]
        || !Number.isSafeInteger(row.byteLength) || row.byteLength < 1
        || !DIGEST_RE.test(row.artifactDigest || '')) {
      throw new Error(`terminal runtime closure.files/${index} is invalid or out of fixed order`);
    }
  }
  return terminalRuntimeClosureDigest(manifest);
}

function verifyTerminalRuntimeClosure(options = {}) {
  const manifest = options.manifest;
  const declaredDigest = validateTerminalRuntimeClosureManifest(manifest);
  if (!DIGEST_RE.test(options.expectedClosureDigest || '')
      || options.expectedClosureDigest !== declaredDigest) {
    throw new Error('terminal runtime closure differs from the out-of-band closure digest');
  }
  const runtimeRoot = resolveRuntimeRoot(options.runtimeRoot);
  if (!samePath(runtimeRoot, manifest.runtimeRootRealPath)) {
    throw new Error('terminal runtimeRoot differs from the independently pinned real path');
  }
  const observed = {
    schemaVersion: '1.0',
    runtimeId: RUNTIME_ID,
    runtimeRootRealPath: runtimeRoot,
    nodeRuntime: observeNodeRuntime(),
    files: readRuntimeFiles(runtimeRoot),
  };
  if (canonicalJcs(observed) !== canonicalJcs(manifest)) {
    throw new Error('terminal runtime or Node executable bytes differ from the pinned closure');
  }
  if (options.expectedSnapshot
      && canonicalJcs(observed) !== canonicalJcs(options.expectedSnapshot)) {
    throw new Error('terminal runtime closure changed during verification');
  }
  return {
    closureDigest: declaredDigest,
    fileCount: observed.files.length,
    manifest: observed,
  };
}

module.exports = {
  REQUIRED_RUNTIME_PATHS,
  RUNTIME_CLOSURE_TAG,
  RUNTIME_ID,
  buildTerminalRuntimeClosureManifest,
  canonicalJcs,
  compareUtf8,
  observeNodeRuntime,
  sha256,
  terminalRuntimeClosureDigest,
  validateTerminalRuntimeClosureManifest,
  verifyTerminalRuntimeClosure,
};
