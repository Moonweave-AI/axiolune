#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  parseRuntimeLock,
  resolveRuntimeRoot,
  sha256File,
  verifyRuntime,
} = require('./lib/pdf-page-range-runtime.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const LOCK_PATH = path.join(
  ROOT,
  'scripts',
  'domain',
  'reference-extractors',
  'pdf-page-range-pdfplumber-v1.runtime-lock.json',
);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function resolvesInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertLockedDownload(filePath, artifact, label) {
  requireCondition(fs.existsSync(filePath), `${label} was not downloaded: ${filePath}`);
  requireCondition(fs.statSync(filePath).isFile(), `${label} is not a regular file: ${filePath}`);
  requireCondition(
    fs.statSync(filePath).size === artifact.byteLength,
    `${label} byte length mismatch`,
  );
  requireCondition(sha256File(filePath) === artifact.sha256, `${label} SHA-256 mismatch`);
}

function downloadLockedArtifact(runtimeRoot, artifact, label) {
  const target = path.join(runtimeRoot, artifact.fileName);
  if (fs.existsSync(target)) {
    assertLockedDownload(target, artifact, label);
    return target;
  }
  const partial = `${target}.partial`;
  requireCondition(!fs.existsSync(partial), `stale partial download requires review: ${partial}`);
  const download = spawnSync(
    'curl.exe',
    [
      '--fail',
      '--location',
      '--proto',
      '=https',
      '--show-error',
      '--silent',
      '--tlsv1.2',
      '--user-agent',
      'axiolune-m2-pdf-runtime-provisioner/1.0',
      '--output',
      partial,
      artifact.url,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 120_000,
      windowsHide: true,
    },
  );
  requireCondition(
    download.status === 0,
    `${label} download failed: ${(download.stderr || download.stdout || download.error?.message || '').trim()}`,
  );
  try {
    assertLockedDownload(partial, artifact, label);
    fs.renameSync(partial, target);
  } catch (error) {
    throw new Error(`${label} failed locked-download verification; retained ${partial}: ${error.message}`);
  }
  return target;
}

function main() {
  const lock = parseRuntimeLock(fs.readFileSync(LOCK_PATH));
  requireCondition(
    process.platform === lock.operatingSystem && process.arch === lock.architecture,
    `runtime lock supports only ${lock.operatingSystem}/${lock.architecture}`,
  );
  const runtimeRoot = resolveRuntimeRoot(ROOT);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const archivePath = downloadLockedArtifact(runtimeRoot, lock.python.archive, 'Python archive');
  const wheelhouse = path.join(runtimeRoot, 'wheelhouse');
  fs.mkdirSync(wheelhouse, { recursive: true });
  for (const entry of lock.packages) {
    const wheelPath = path.join(wheelhouse, entry.wheel.fileName);
    if (fs.existsSync(wheelPath)) {
      assertLockedDownload(wheelPath, entry.wheel, `wheel ${entry.distribution}`);
    } else {
      const downloaded = downloadLockedArtifact(runtimeRoot, entry.wheel, `wheel ${entry.distribution}`);
      fs.renameSync(downloaded, wheelPath);
    }
  }

  const pythonTree = path.resolve(runtimeRoot, ...lock.python.tree.path.split('/'));
  const pythonContainer = path.dirname(pythonTree);
  if (!fs.existsSync(pythonTree)) {
    requireCondition(
      !fs.existsSync(pythonContainer),
      `partial Python extraction requires review: ${pythonContainer}`,
    );
    fs.mkdirSync(pythonContainer, { recursive: true });
    const extraction = spawnSync(
      process.platform === 'win32' ? 'tar.exe' : 'tar',
      ['-xzf', archivePath, '-C', pythonContainer],
      { cwd: ROOT, encoding: 'utf8', shell: false, windowsHide: true },
    );
    requireCondition(
      extraction.status === 0,
      `Python extraction failed: ${(extraction.stderr || extraction.stdout || '').trim()}`,
    );
  }

  const sitePackages = path.resolve(runtimeRoot, ...lock.sitePackagesTree.path.split('/'));
  if (!fs.existsSync(sitePackages)) {
    const pythonExecutable = path.resolve(
      runtimeRoot,
      ...lock.python.executablePath.split('/'),
    );
    const provisioner = path.resolve(
      ROOT,
      ...lock.sitePackagesTree.provisionerRef.path.split('/'),
    );
    requireCondition(
      resolvesInside(provisioner, ROOT)
        && fs.existsSync(provisioner)
        && fs.statSync(provisioner).isFile(),
      'site-packages provisioner is not one regular source-tree file',
    );
    requireCondition(
      sha256File(provisioner) === lock.sitePackagesTree.provisionerDigest,
      'site-packages provisioner digest mismatch',
    );
    const install = spawnSync(
      pythonExecutable,
      [
        '-B',
        '-I',
        '-S',
        provisioner,
        wheelhouse,
        sitePackages,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        shell: false,
        windowsHide: true,
      },
    );
    requireCondition(
      install.status === 0,
      `locked wheel extraction failed: ${(install.stderr || install.stdout || '').trim()}`,
    );
  }
  verifyRuntime(runtimeRoot, lock);
  console.log(`PASS: provisioned locked PDF extractor runtime at ${runtimeRoot}`);
}

try {
  main();
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
}
