'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const {
  parseJsonRejectingDuplicateMembers,
} = require('./json-pointer-source-extractor.cjs');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const TREE_DIGEST_TAG = Buffer.from('axiolune-runtime-tree-v1\0', 'utf8');
const TREE_DIGEST_ALGORITHM = 'sha256(tag||u64be(file-count)||for-each-utf8-path:u64be(path-length)||path||u64be(file-length)||bytes)';
const RUNTIME_ENV = 'AXIOLUNE_PDF_EXTRACTOR_RUNTIME_DIR';
const DEFAULT_RUNTIME_PATH = 'tmp/pdf-extractor-runtime';

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function u64be(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('runtime-tree frame length must be a non-negative safe integer');
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest('hex')}`;
}

function inventoryTree(rootPath) {
  const absoluteRoot = path.resolve(rootPath);
  if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) {
    throw new Error(`runtime tree is not a directory: ${absoluteRoot}`);
  }
  const files = [];
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`runtime tree must not contain symbolic links: ${absolute}`);
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const relative = path.relative(absoluteRoot, absolute).split(path.sep).join('/');
        if (relative !== relative.normalize('NFC')) {
          throw new Error(`runtime tree path is not Unicode NFC: ${relative}`);
        }
        files.push({ absolute, relative });
      } else {
        throw new Error(`runtime tree contains a non-regular entry: ${absolute}`);
      }
    }
  };
  visit(absoluteRoot);
  files.sort((left, right) => compareUtf8(left.relative, right.relative));
  return files;
}

function computeTreeDigest(rootPath) {
  const hash = crypto.createHash('sha256');
  hash.update(TREE_DIGEST_TAG);
  const files = inventoryTree(rootPath);
  hash.update(u64be(files.length));
  for (const file of files) {
    const relativeBytes = Buffer.from(file.relative, 'utf8');
    const size = fs.statSync(file.absolute).size;
    hash.update(u64be(relativeBytes.length));
    hash.update(relativeBytes);
    hash.update(u64be(size));
    const descriptor = fs.openSync(file.absolute, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      while (true) {
        const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (count === 0) break;
        hash.update(buffer.subarray(0, count));
      }
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return {
    digest: `sha256:${hash.digest('hex')}`,
    fileCount: files.length,
  };
}

function assertClosedObject(value, fields, at) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${at} must be an object`);
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...fields].sort(compareUtf8);
  if (actual.length !== expected.length
      || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${at} must contain exactly: ${expected.join(', ')}`);
  }
}

function assertArtifactShape(value, at) {
  assertClosedObject(value, ['byteLength', 'fileName', 'sha256', 'url'], at);
  if (typeof value.fileName !== 'string' || value.fileName.length === 0
      || value.fileName.includes('/') || value.fileName.includes('\\')) {
    throw new Error(`${at}.fileName must be one portable basename`);
  }
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 1) {
    throw new Error(`${at}.byteLength must be a positive safe integer`);
  }
  if (!DIGEST_RE.test(value.sha256)) {
    throw new Error(`${at}.sha256 must be a lowercase SHA-256 digest`);
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error(`${at}.url must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${at}.url must use HTTPS`);
}

function parseRuntimeLock(bytes, at = 'pdf runtime lock') {
  let lock;
  let text;
  try {
    if (Buffer.isBuffer(bytes)
        && bytes.length >= 3
        && bytes[0] === 0xef
        && bytes[1] === 0xbb
        && bytes[2] === 0xbf) {
      throw new Error('UTF-8 BOM is forbidden');
    }
    text = Buffer.isBuffer(bytes)
      ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      : String(bytes);
    if (text.charCodeAt(0) === 0xfeff) throw new Error('UTF-8 BOM is forbidden');
    lock = parseJsonRejectingDuplicateMembers(text);
  } catch (error) {
    throw new Error(`${at} is not strict unambiguous JSON: ${error.message}`);
  }
  assertClosedObject(
    lock,
    [
      'architecture',
      'networkAccess',
      'operatingSystem',
      'packages',
      'python',
      'runtimeId',
      'schemaVersion',
      'sitePackagesTree',
      'treeDigestAlgorithm',
    ],
    at,
  );
  if (lock.schemaVersion !== '1.0'
      || lock.runtimeId !== 'pdf-page-range-pdfplumber-v1'
      || lock.networkAccess !== false
      || lock.treeDigestAlgorithm !== TREE_DIGEST_ALGORITHM) {
    throw new Error(
      `${at} has an unsupported schemaVersion, runtimeId, tree digest, or network policy`,
    );
  }
  if (lock.operatingSystem !== 'win32' || lock.architecture !== 'x64') {
    throw new Error(`${at} must lock the verified win32/x64 release environment`);
  }
  assertClosedObject(
    lock.python,
    [
      'archive',
      'distribution',
      'executablePath',
      'release',
      'tree',
      'version',
    ],
    `${at}.python`,
  );
  if (lock.python.distribution !== 'astral-sh/python-build-standalone'
      || lock.python.release !== '20260718'
      || lock.python.version !== '3.12.13') {
    throw new Error(`${at}.python has an unsupported distribution or version`);
  }
  assertArtifactShape(lock.python.archive, `${at}.python.archive`);
  for (const [tree, treeAt] of [
    [lock.python.tree, `${at}.python.tree`],
  ]) {
    assertClosedObject(tree, ['digest', 'fileCount', 'path'], treeAt);
    if (!DIGEST_RE.test(tree.digest)
        || !Number.isSafeInteger(tree.fileCount) || tree.fileCount < 1
        || typeof tree.path !== 'string' || tree.path.length === 0
        || path.isAbsolute(tree.path)) {
      throw new Error(`${treeAt} has an invalid path, fileCount, or digest`);
    }
  }
  assertClosedObject(
    lock.sitePackagesTree,
    [
      'digest',
      'fileCount',
      'path',
      'provisionerDigest',
      'provisionerRef',
      'provisioningAlgorithm',
    ],
    `${at}.sitePackagesTree`,
  );
  if (!DIGEST_RE.test(lock.sitePackagesTree.digest)
      || !Number.isSafeInteger(lock.sitePackagesTree.fileCount)
      || lock.sitePackagesTree.fileCount < 1
      || typeof lock.sitePackagesTree.path !== 'string'
      || lock.sitePackagesTree.path.length === 0
      || path.isAbsolute(lock.sitePackagesTree.path)
      || !DIGEST_RE.test(lock.sitePackagesTree.provisionerDigest)
      || lock.sitePackagesTree.provisioningAlgorithm !== 'safe-direct-wheel-unpack-v1') {
    throw new Error(`${at}.sitePackagesTree has an invalid contract`);
  }
  assertClosedObject(
    lock.sitePackagesTree.provisionerRef,
    ['kind', 'path', 'root'],
    `${at}.sitePackagesTree.provisionerRef`,
  );
  if (lock.sitePackagesTree.provisionerRef.kind !== 'path'
      || lock.sitePackagesTree.provisionerRef.root !== 'sourceTree'
      || typeof lock.sitePackagesTree.provisionerRef.path !== 'string'
      || lock.sitePackagesTree.provisionerRef.path.length === 0
      || path.isAbsolute(lock.sitePackagesTree.provisionerRef.path)
      || lock.sitePackagesTree.provisionerRef.path.includes('\\')
      || lock.sitePackagesTree.provisionerRef.path.split('/').includes('..')) {
    throw new Error(`${at}.sitePackagesTree.provisionerRef is invalid`);
  }
  if (typeof lock.python.executablePath !== 'string'
      || lock.python.executablePath.length === 0
      || path.isAbsolute(lock.python.executablePath)) {
    throw new Error(`${at}.python.executablePath must be a relative path`);
  }
  if (lock.python.tree.path !== 'standalone-3.12.13-locked/python'
      || lock.python.executablePath !== 'standalone-3.12.13-locked/python/python.exe'
      || lock.sitePackagesTree.path !== 'site-packages-wheel-extract-v1') {
    throw new Error(`${at} has an unsupported executable tree layout`);
  }
  if (!Array.isArray(lock.packages) || lock.packages.length === 0) {
    throw new Error(`${at}.packages must be a non-empty array`);
  }
  const packageNames = new Set();
  const wheelNames = new Set();
  lock.packages.forEach((entry, index) => {
    const entryAt = `${at}.packages[${index}]`;
    assertClosedObject(entry, ['distribution', 'version', 'wheel'], entryAt);
    if (typeof entry.distribution !== 'string' || entry.distribution.length === 0
        || typeof entry.version !== 'string' || entry.version.length === 0) {
      throw new Error(`${entryAt} must name one exact distribution version`);
    }
    const normalized = entry.distribution.toLowerCase().replace(/[_.-]+/gu, '-');
    if (packageNames.has(normalized)) throw new Error(`${entryAt} duplicates a distribution`);
    packageNames.add(normalized);
    assertArtifactShape(entry.wheel, `${entryAt}.wheel`);
    if (wheelNames.has(entry.wheel.fileName)) throw new Error(`${entryAt} duplicates a wheel`);
    wheelNames.add(entry.wheel.fileName);
  });
  const sorted = [...lock.packages].sort((left, right) => (
    compareUtf8(left.distribution.toLowerCase(), right.distribution.toLowerCase())
  ));
  if (sorted.some((entry, index) => entry !== lock.packages[index])) {
    throw new Error(`${at}.packages must be UTF-8 sorted by distribution`);
  }
  return lock;
}

function safeResolveInside(rootPath, relativePath, at) {
  const root = path.resolve(rootPath);
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, absolute);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${at} escapes or resolves to the runtime root`);
  }
  return absolute;
}

function assertLockedFile(filePath, artifact, at) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${at} is missing or not a regular file: ${filePath}`);
  }
  const size = fs.statSync(filePath).size;
  if (size !== artifact.byteLength) {
    throw new Error(`${at} byte length drift: expected ${artifact.byteLength}, got ${size}`);
  }
  const digest = sha256File(filePath);
  if (digest !== artifact.sha256) {
    throw new Error(`${at} digest drift: expected ${artifact.sha256}, got ${digest}`);
  }
}

function resolveRuntimeRoot(rootDir, environment = process.env) {
  const configured = environment[RUNTIME_ENV];
  return path.resolve(rootDir, configured || DEFAULT_RUNTIME_PATH);
}

function verifyRuntime(runtimeRoot, lock) {
  if (process.platform !== lock.operatingSystem || process.arch !== lock.architecture) {
    throw new Error(
      `PDF runtime platform mismatch: expected ${lock.operatingSystem}/${lock.architecture}, `
      + `got ${process.platform}/${process.arch}`,
    );
  }
  const archivePath = path.join(runtimeRoot, lock.python.archive.fileName);
  assertLockedFile(archivePath, lock.python.archive, 'python archive');

  const wheelhouse = path.join(runtimeRoot, 'wheelhouse');
  if (!fs.existsSync(wheelhouse) || !fs.statSync(wheelhouse).isDirectory()) {
    throw new Error(`locked wheelhouse is missing: ${wheelhouse}`);
  }
  const wheelEntries = fs.readdirSync(wheelhouse, { withFileTypes: true });
  if (wheelEntries.some((entry) => !entry.isFile())) {
    throw new Error('locked wheelhouse contains a non-regular entry');
  }
  const actualWheels = wheelEntries
    .map((entry) => entry.name)
    .sort(compareUtf8);
  const expectedWheels = lock.packages.map((entry) => entry.wheel.fileName).sort(compareUtf8);
  if (actualWheels.length !== expectedWheels.length
      || actualWheels.some((fileName, index) => fileName !== expectedWheels[index])) {
    throw new Error('locked wheelhouse inventory drift');
  }
  for (const entry of lock.packages) {
    assertLockedFile(
      path.join(wheelhouse, entry.wheel.fileName),
      entry.wheel,
      `wheel ${entry.distribution} ${entry.version}`,
    );
  }

  const pythonTree = safeResolveInside(runtimeRoot, lock.python.tree.path, 'python.tree.path');
  const actualPythonTree = computeTreeDigest(pythonTree);
  if (actualPythonTree.digest !== lock.python.tree.digest
      || actualPythonTree.fileCount !== lock.python.tree.fileCount) {
    throw new Error(
      `python runtime tree drift: expected ${lock.python.tree.digest}/${lock.python.tree.fileCount}, `
      + `got ${actualPythonTree.digest}/${actualPythonTree.fileCount}`,
    );
  }
  const sitePackages = safeResolveInside(
    runtimeRoot,
    lock.sitePackagesTree.path,
    'sitePackagesTree.path',
  );
  const actualSiteTree = computeTreeDigest(sitePackages);
  if (actualSiteTree.digest !== lock.sitePackagesTree.digest
      || actualSiteTree.fileCount !== lock.sitePackagesTree.fileCount) {
    throw new Error(
      `site-packages tree drift: expected ${lock.sitePackagesTree.digest}/${lock.sitePackagesTree.fileCount}, `
      + `got ${actualSiteTree.digest}/${actualSiteTree.fileCount}`,
    );
  }

  const pythonExecutable = safeResolveInside(
    runtimeRoot,
    lock.python.executablePath,
    'python.executablePath',
  );
  if (!fs.existsSync(pythonExecutable) || !fs.statSync(pythonExecutable).isFile()) {
    throw new Error(`locked Python executable is missing: ${pythonExecutable}`);
  }
  const probe = [
    'import importlib.metadata as md,json,sys',
    'site=sys.argv[1]',
    'sys.path.insert(0,site)',
    'import cffi,charset_normalizer,cryptography,pdfminer,pdfplumber,PIL,pycparser,pypdfium2',
    'versions={"cffi":md.version("cffi"),"charset-normalizer":md.version("charset-normalizer"),'
      + '"cryptography":md.version("cryptography"),"pdfminer-six":md.version("pdfminer-six"),'
      + '"pdfplumber":md.version("pdfplumber"),"pillow":md.version("pillow"),'
      + '"pycparser":md.version("pycparser"),"pypdfium2":md.version("pypdfium2"),'
      + '"python":".".join(map(str,sys.version_info[:3]))}',
    'print(json.dumps(versions,sort_keys=True,separators=(",",":")))',
  ].join(';');
  const result = spawnSync(
    pythonExecutable,
    ['-B', '-I', '-S', '-c', probe, sitePackages],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
      },
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.error) throw new Error(`locked Python probe failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `locked Python probe exited ${String(result.status)}: ${(result.stderr || '').trim()}`,
    );
  }
  let versions;
  try {
    versions = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error('locked Python probe did not emit one JSON version object');
  }
  const expectedVersions = Object.fromEntries(
    lock.packages.map((entry) => [
      entry.distribution.toLowerCase().replace(/[_.-]+/gu, '-'),
      entry.version,
    ]),
  );
  expectedVersions.python = lock.python.version;
  const actualJcs = JSON.stringify(
    Object.fromEntries(Object.entries(versions).sort(([left], [right]) => compareUtf8(left, right))),
  );
  const expectedJcs = JSON.stringify(
    Object.fromEntries(
      Object.entries(expectedVersions).sort(([left], [right]) => compareUtf8(left, right)),
    ),
  );
  if (actualJcs !== expectedJcs) {
    throw new Error(`locked Python package version drift: expected ${expectedJcs}, got ${actualJcs}`);
  }
  return { pythonExecutable, sitePackages };
}

function extractPdfPageRangeBytes({
  implementationPath,
  lock,
  runtimeRoot,
  sourcePath,
  startPage,
  endPage,
}) {
  if (!Number.isSafeInteger(startPage) || !Number.isSafeInteger(endPage)
      || startPage < 1 || endPage < startPage) {
    throw new Error('PDF page range must be one-based, inclusive, and non-reversed');
  }
  if (!fs.existsSync(implementationPath) || !fs.statSync(implementationPath).isFile()) {
    throw new Error(`PDF extractor implementation is missing: ${implementationPath}`);
  }
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`PDF source is missing: ${sourcePath}`);
  }
  const { pythonExecutable, sitePackages } = verifyRuntime(runtimeRoot, lock);
  const wrapper = [
    'import runpy,sys',
    'site,script,*args=sys.argv[1:]',
    'sys.path.insert(0,site)',
    'sys.argv=[script,*args]',
    'runpy.run_path(script,run_name="__main__")',
  ].join(';');
  const result = spawnSync(
    pythonExecutable,
    [
      '-B',
      '-I',
      '-S',
      '-c',
      wrapper,
      sitePackages,
      implementationPath,
      sourcePath,
      String(startPage),
      String(endPage),
    ],
    {
      encoding: null,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
      },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    },
  );
  if (result.error) throw new Error(`PDF extractor failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `PDF extractor exited ${String(result.status)}: ${Buffer.from(result.stderr || []).toString('utf8').trim()}`,
    );
  }
  return Buffer.from(result.stdout);
}

module.exports = {
  DEFAULT_RUNTIME_PATH,
  RUNTIME_ENV,
  TREE_DIGEST_ALGORITHM,
  TREE_DIGEST_TAG,
  computeTreeDigest,
  extractPdfPageRangeBytes,
  parseRuntimeLock,
  resolveRuntimeRoot,
  sha256File,
  verifyRuntime,
};
