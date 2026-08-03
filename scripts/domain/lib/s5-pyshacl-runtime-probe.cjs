'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EXPECTED_PYTHON_VERSION = '3.12.10';
const EXPECTED_PYSHACL_VERSION = '0.26.0';
const EXPECTED_RDFLIB_VERSION = '7.6.0';
const RUNTIME_DOMAIN_TAG = 'axiolune-s5-python-runtime-v1\0';
const PINNED_RUNTIME_LOCKS = Object.freeze({
  'win32-x64': Object.freeze([Object.freeze({
    executableDigest: 'sha256:4d6f5f81a4bca11191c4c7c6b43632694d0a4ce74e068619d8fdc161d469859a',
    fileCount: 3302,
    pythonVersion: EXPECTED_PYTHON_VERSION,
    runtimeByteLength: 86599945,
    runtimeClosureDigest: 'sha256:69d30b01067c180c00915532b22661d62bebd58fd7dafc808b13db27048ecd1e',
  })]),
});

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function u64be(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function workerEnvironment() {
  const environment = {
    ALL_PROXY: '',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    NO_PROXY: '*',
    PYTHONHASHSEED: '0',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
  };
  for (const key of ['SystemRoot', 'WINDIR']) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  return environment;
}

function pythonCandidates(options = {}) {
  if (options.pythonPath !== undefined) return [options.pythonPath];
  const candidates = [];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(
      process.env.LOCALAPPDATA,
      'Programs',
      'Python',
      'Python312',
      'python.exe',
    ));
  }
  for (const candidate of options.additionalPythonPaths || []) candidates.push(candidate);
  return [...new Set(candidates)];
}

function collectRuntimeFiles(runtimeRoot) {
  const files = [];
  for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
    const absolute = path.join(runtimeRoot, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`runtime root contains symlink ${entry.name}`);
    if (entry.isFile()) files.push({ absolute, relative: entry.name });
  }
  const walk = (absoluteDirectory, relativeDirectory) => {
    const directoryState = fs.lstatSync(absoluteDirectory);
    if (!directoryState.isDirectory() || directoryState.isSymbolicLink()) {
      throw new Error(`${relativeDirectory} is not a real runtime directory`);
    }
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue;
      const absolute = path.join(absoluteDirectory, entry.name);
      const relative = `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`runtime contains symlink ${relative}`);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) {
        if (!entry.name.endsWith('.pyc')) files.push({ absolute, relative });
      } else throw new Error(`runtime contains special entry ${relative}`);
    }
  };
  walk(path.join(runtimeRoot, 'DLLs'), 'DLLs');
  walk(path.join(runtimeRoot, 'Lib'), 'Lib');
  files.sort((left, right) => compareUtf8(left.relative, right.relative));
  return files;
}

function runtimeClosureIdentity(runtimeRoot) {
  const files = collectRuntimeFiles(runtimeRoot);
  const digest = crypto.createHash('sha256');
  digest.update(Buffer.from(RUNTIME_DOMAIN_TAG, 'utf8'));
  digest.update(u64be(files.length));
  let runtimeByteLength = 0;
  for (const file of files) {
    const relative = Buffer.from(file.relative, 'utf8');
    const bytes = fs.readFileSync(file.absolute);
    runtimeByteLength += bytes.length;
    digest.update(u64be(relative.length));
    digest.update(relative);
    digest.update(u64be(bytes.length));
    digest.update(bytes);
  }
  return Object.freeze({
    fileCount: files.length,
    runtimeByteLength,
    runtimeClosureDigest: `sha256:${digest.digest('hex')}`,
  });
}

function validateRuntimeCandidate(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new Error('not an absolute executable path');
  }
  const state = fs.lstatSync(candidate);
  if (!state.isFile() || state.isSymbolicLink()) {
    throw new Error('executable is not a real regular file');
  }
  const executable = fs.realpathSync.native(candidate);
  const runtimeRoot = path.dirname(executable);
  const executableDigest = sha256(fs.readFileSync(executable));
  const closure = runtimeClosureIdentity(runtimeRoot);
  const locks = PINNED_RUNTIME_LOCKS[`${process.platform}-${process.arch}`] || [];
  const lock = locks.find((entry) => (
    entry.executableDigest === executableDigest
      && entry.runtimeClosureDigest === closure.runtimeClosureDigest
      && entry.fileCount === closure.fileCount
      && entry.runtimeByteLength === closure.runtimeByteLength
  ));
  if (!lock) {
    throw new Error(
      `runtime identity is not verifier-locked (executable ${executableDigest}; `
        + `closure ${closure.runtimeClosureDigest})`,
    );
  }
  return Object.freeze({
    executable,
    executableDigest,
    runtimeRoot,
    ...closure,
    lock,
  });
}

function runPinnedProcess(identity, args, options = {}) {
  const before = validateRuntimeCandidate(identity.executable);
  if (before.executableDigest !== identity.executableDigest
      || before.runtimeClosureDigest !== identity.runtimeClosureDigest) {
    throw new Error('pinned Python runtime changed before execution');
  }
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-s5-pycache-'));
  try {
    const result = spawnSync(identity.executable, [
      '-I',
      '-B',
      '-X',
      `pycache_prefix=${cacheRoot}`,
      ...args,
    ], {
      cwd: options.cwd,
      encoding: options.encoding,
      env: workerEnvironment(),
      input: options.input,
      maxBuffer: options.maxBuffer,
      shell: false,
      timeout: options.timeout,
      windowsHide: true,
    });
    const after = validateRuntimeCandidate(identity.executable);
    if (after.executableDigest !== identity.executableDigest
        || after.runtimeClosureDigest !== identity.runtimeClosureDigest) {
      throw new Error('pinned Python runtime changed during execution');
    }
    return result;
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
}

function validateProbeMetadata(metadata, identity) {
  const expectedKeys = [
    'pythonExecutable', 'pythonPrefix', 'pythonVersion',
    'pyshaclEntry', 'pyshaclVersion', 'rdflibEntry', 'rdflibVersion',
  ].sort();
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('probe output differs from the closed runtime identity schema');
  }
  if (metadata.pythonVersion !== identity.lock.pythonVersion
      || metadata.pyshaclVersion !== EXPECTED_PYSHACL_VERSION
      || metadata.rdflibVersion !== EXPECTED_RDFLIB_VERSION) {
    throw new Error('runtime metadata differs from exact pins');
  }
  const executable = fs.realpathSync.native(metadata.pythonExecutable);
  const prefix = fs.realpathSync.native(metadata.pythonPrefix);
  if (executable !== identity.executable || prefix !== identity.runtimeRoot) {
    throw new Error('Python self-identity differs from the verified runtime root');
  }
  const sitePackages = path.join(identity.runtimeRoot, 'Lib', 'site-packages');
  for (const [field, suffix] of [
    ['pyshaclEntry', path.join('pyshacl', '__init__.py')],
    ['rdflibEntry', path.join('rdflib', '__init__.py')],
  ]) {
    if (typeof metadata[field] !== 'string' || !path.isAbsolute(metadata[field])) {
      throw new Error(`${field} is not absolute`);
    }
    const actual = fs.realpathSync.native(metadata[field]);
    const expected = fs.realpathSync.native(path.join(sitePackages, suffix));
    if (actual !== expected || !fs.statSync(actual).isFile()) {
      throw new Error(`${field} is outside the verified runtime closure`);
    }
  }
}

function probePython(options = {}) {
  const diagnostics = [];
  const script = [
    'import json,sys,pyshacl,rdflib',
    'print(json.dumps({"pythonExecutable":sys.executable,"pythonPrefix":sys.prefix,"pythonVersion":".".join(map(str,sys.version_info[:3])),"pyshaclEntry":pyshacl.__file__,"pyshaclVersion":pyshacl.__version__,"rdflibEntry":rdflib.__file__,"rdflibVersion":rdflib.__version__},sort_keys=True,separators=(",",":")))',
  ].join(';');
  for (const candidate of pythonCandidates(options)) {
    try {
      const identity = validateRuntimeCandidate(candidate);
      const result = runPinnedProcess(identity, ['-c', script], {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0 || result.error) {
        throw new Error(result.error?.message || result.stderr.trim() || `exit ${result.status}`);
      }
      const metadata = JSON.parse(result.stdout);
      validateProbeMetadata(metadata, identity);
      return Object.freeze({
        executable: identity.executable,
        executableDigest: identity.executableDigest,
        fileCount: identity.fileCount,
        pythonVersion: metadata.pythonVersion,
        pyshaclEntry: metadata.pyshaclEntry,
        pyshaclVersion: metadata.pyshaclVersion,
        rdflibEntry: metadata.rdflibEntry,
        rdflibVersion: metadata.rdflibVersion,
        runtimeByteLength: identity.runtimeByteLength,
        runtimeClosureDigest: identity.runtimeClosureDigest,
      });
    } catch (cause) {
      diagnostics.push(`${String(candidate)}: ${cause.message}`);
    }
  }
  throw new Error(
    `no verifier-locked Python runtime with pySHACL ${EXPECTED_PYSHACL_VERSION} `
      + `and RDFLib ${EXPECTED_RDFLIB_VERSION} was found: ${diagnostics.join('; ')}`,
  );
}

function spawnPinnedPython(runtime, scriptPath, options = {}) {
  if (!runtime || typeof runtime !== 'object'
      || typeof runtime.executable !== 'string'
      || typeof runtime.executableDigest !== 'string'
      || typeof runtime.runtimeClosureDigest !== 'string') {
    throw new Error('runtime must be an identity returned by probePython');
  }
  if (typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath)
      || !fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) {
    throw new Error('Python worker must be an existing absolute file');
  }
  return runPinnedProcess(runtime, [scriptPath, ...(options.args || [])], options);
}

module.exports = {
  EXPECTED_PYTHON_VERSION,
  EXPECTED_PYSHACL_VERSION,
  EXPECTED_RDFLIB_VERSION,
  probePython,
  runtimeClosureIdentity,
  spawnPinnedPython,
};
