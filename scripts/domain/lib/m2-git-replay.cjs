'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const MAX_GIT_OUTPUT = 256 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const WINDOWS_GIT_RUNTIME_LOCKS = Object.freeze({
  'win32-x64': Object.freeze([Object.freeze({
    artifactDigest: 'sha256:77965c1ffd7d5d0f7d55ddbec10ad540efa61e58f36eae565cde0f36fab8fe53',
    executable: String.raw`C:\Program Files\Git\mingw64\bin\git.exe`,
    version: 'git version 2.55.0.windows.2',
  })]),
});
let trustedGitRuntimeCache = null;

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function taggedJcsDigest(tag, value) {
  return sha256(Buffer.concat([
    Buffer.from(tag, 'utf8'),
    Buffer.from(canonicalJcs(value), 'utf8'),
  ]));
}

function u64be(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function gitEnvironment() {
  const environment = {
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
  };
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  return environment;
}

function fileDigest(file) {
  return sha256(fs.readFileSync(file));
}

function assertPosixSystemPath(file) {
  const resolved = fs.realpathSync(file);
  const trustedRoots = ['/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/'];
  if (!trustedRoots.some((root) => resolved.startsWith(root))) {
    throw new Error(`Git realpath is outside a trusted system binary root: ${resolved}`);
  }
  for (const target of [resolved, path.dirname(resolved)]) {
    const stat = fs.statSync(target);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error(`Git system path is not root-owned and write-protected: ${target}`);
    }
  }
  return resolved;
}

function gitRuntimeCandidates() {
  const key = `${process.platform}-${process.arch}`;
  if (WINDOWS_GIT_RUNTIME_LOCKS[key]) return WINDOWS_GIT_RUNTIME_LOCKS[key];
  if (process.platform === 'darwin') {
    return Object.freeze([
      Object.freeze({ executable: '/usr/bin/git' }),
      Object.freeze({ executable: '/opt/homebrew/bin/git' }),
    ]);
  }
  return Object.freeze([
    Object.freeze({ executable: '/usr/bin/git' }),
    Object.freeze({ executable: '/usr/local/bin/git' }),
  ]);
}

function resolveTrustedGitRuntime() {
  if (trustedGitRuntimeCache) return trustedGitRuntimeCache;
  const diagnostics = [];
  for (const lock of gitRuntimeCandidates()) {
    try {
      if (!path.isAbsolute(lock.executable)) throw new Error('path is not absolute');
      const lstat = fs.lstatSync(lock.executable);
      if (!lstat.isFile() && !lstat.isSymbolicLink()) throw new Error('path is not a file');
      const executable = process.platform === 'win32'
        ? fs.realpathSync.native(lock.executable)
        : assertPosixSystemPath(lock.executable);
      const artifactDigest = fileDigest(executable);
      if (lock.artifactDigest && artifactDigest !== lock.artifactDigest) {
        throw new Error(`digest ${artifactDigest} differs from the verifier lock`);
      }
      const probe = spawnSync(executable, ['--version'], {
        encoding: 'utf8',
        env: gitEnvironment(),
        maxBuffer: 64 * 1024,
        shell: false,
        timeout: 5_000,
        windowsHide: true,
      });
      if (probe.error || probe.status !== 0) {
        throw new Error(probe.error?.message || probe.stderr.trim() || `exit ${probe.status}`);
      }
      const version = probe.stdout.trim();
      if (!/^git version [0-9]+\.[0-9]+\.[0-9]+(?:[.a-z0-9-]+)?$/u.test(version)
          || (lock.version && version !== lock.version)) {
        throw new Error(`unlocked Git version identity ${JSON.stringify(version)}`);
      }
      if (fileDigest(executable) !== artifactDigest) {
        throw new Error('Git executable changed during identity verification');
      }
      trustedGitRuntimeCache = Object.freeze({ artifactDigest, executable, version });
      return trustedGitRuntimeCache;
    } catch (cause) {
      diagnostics.push(`${lock.executable}: ${cause.message}`);
    }
  }
  throw new Error(`no trusted absolute Git runtime is available: ${diagnostics.join('; ')}`);
}

function trustedGitRuntimeIdentity() {
  return { ...resolveTrustedGitRuntime() };
}

function runGit(repositoryRoot, args) {
  const runtime = resolveTrustedGitRuntime();
  if (fileDigest(runtime.executable) !== runtime.artifactDigest) {
    throw new Error('trusted Git executable changed before replay');
  }
  const result = spawnSync(runtime.executable, [
    '--no-pager',
    '--no-replace-objects',
    '-C',
    repositoryRoot,
    ...args,
  ], {
    shell: false,
    encoding: null,
    env: gitEnvironment(),
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (fileDigest(runtime.executable) !== runtime.artifactDigest) {
    throw new Error('trusted Git executable changed during replay');
  }
  if (result.error || result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString('utf8').trim() : '';
    const timeout = result.error?.code === 'ETIMEDOUT';
    throw new Error(
      timeout
        ? `git ${args[0]} exceeded the ${GIT_TIMEOUT_MS} ms replay limit`
        : result.error?.message || stderr || `git ${args[0]} failed`,
    );
  }
  return result.stdout;
}

function gitIdPattern(objectFormat) {
  if (objectFormat === 'sha1') return /^[0-9a-f]{40}$/u;
  if (objectFormat === 'sha256') return /^[0-9a-f]{64}$/u;
  throw new Error(`unsupported Git object format ${String(objectFormat)}`);
}

function requireGitId(value, objectFormat, label) {
  if (!gitIdPattern(objectFormat).test(value) || /^0+$/u.test(value)) {
    throw new Error(`${label} is not a full non-zero ${objectFormat} object ID`);
  }
}

function inspectCommit(repositoryRoot, commitId, objectFormat) {
  requireGitId(commitId, objectFormat, 'commitId');
  const bytes = runGit(repositoryRoot, ['cat-file', 'commit', commitId]);
  const separator = bytes.indexOf(Buffer.from('\n\n', 'utf8'));
  if (separator < 0) throw new Error(`${commitId} has no canonical commit header separator`);
  const headerLines = bytes.subarray(0, separator).toString('utf8').split('\n');
  const treeLine = headerLines.find((line) => line.startsWith('tree '));
  const parents = headerLines
    .filter((line) => line.startsWith('parent '))
    .map((line) => line.slice('parent '.length));
  if (!treeLine) throw new Error(`${commitId} has no tree header`);
  const treeId = treeLine.slice('tree '.length);
  requireGitId(treeId, objectFormat, 'commit treeId');
  parents.forEach((parent) => requireGitId(parent, objectFormat, 'commit parent'));
  return { commitId, treeId, parents, bytes };
}

function enumerateGitTree(repositoryRoot, treeId, objectFormat) {
  requireGitId(treeId, objectFormat, 'treeId');
  const raw = runGit(repositoryRoot, ['ls-tree', '-r', '-z', '--full-tree', treeId]);
  const payload = raw.length > 0 && raw[raw.length - 1] === 0
    ? raw.subarray(0, raw.length - 1) : raw;
  const records = payload.length === 0 ? [] : payload.toString('binary').split('\0');
  const files = [];
  const exactPaths = new Set();
  const foldedPaths = new Set();
  for (const binaryRecord of records) {
    const record = Buffer.from(binaryRecord, 'binary');
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error('git ls-tree emitted a record without a path separator');
    const header = record.subarray(0, tab).toString('ascii').split(' ');
    if (header.length !== 3) throw new Error('git ls-tree emitted a malformed record header');
    const [mode, type, objectId] = header;
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
      throw new Error(`tree contains forbidden ${mode} ${type} entry`);
    }
    requireGitId(objectId, objectFormat, 'blob objectId');
    const pathBytes = record.subarray(tab + 1);
    const filePath = pathBytes.toString('utf8');
    if (!Buffer.from(filePath, 'utf8').equals(pathBytes)
        || filePath !== filePath.normalize('NFC')
        || filePath.startsWith('/')
        || filePath.includes('\\')
        || filePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error('tree contains a non-canonical UTF-8 NFC POSIX path');
    }
    const folded = filePath.toLocaleLowerCase('und');
    if (exactPaths.has(filePath) || foldedPaths.has(folded)) {
      throw new Error(`tree contains duplicate or case-fold-colliding path ${filePath}`);
    }
    exactPaths.add(filePath);
    foldedPaths.add(folded);
    const content = runGit(repositoryRoot, ['cat-file', 'blob', objectId]);
    files.push({
      mode,
      path: filePath,
      byteLength: content.length,
      artifactDigest: sha256(content),
      content,
    });
  }
  files.sort((left, right) => compareUtf8(left.path, right.path));
  return files;
}

function sourceTreeDigest(files) {
  const chunks = [Buffer.from('axiolune-source-tree-v1\0', 'utf8'), u64be(files.length)];
  for (const file of files) {
    const mode = Buffer.from(file.mode, 'ascii');
    const pathBytes = Buffer.from(file.path, 'utf8');
    chunks.push(
      u64be(mode.length), mode,
      u64be(pathBytes.length), pathBytes,
      u64be(file.content.length), file.content,
    );
  }
  return sha256(Buffer.concat(chunks));
}

function buildSourceTreeManifest(repositoryRoot, treeId, objectFormat) {
  const files = enumerateGitTree(repositoryRoot, treeId, objectFormat);
  const digest = sourceTreeDigest(files);
  const manifest = {
    schemaVersion: '1.0',
    gitObjectFormat: objectFormat,
    sourceTreeDigest: digest,
    files: files.map(({ mode, path: filePath, byteLength, artifactDigest }) => ({
      mode,
      path: filePath,
      byteLength,
      artifactDigest,
    })),
  };
  return {
    files,
    manifest,
    sourceTreeDigest: digest,
    sourceTreeManifestDigest: taggedJcsDigest(
      'axiolune-source-tree-manifest-v1\0',
      manifest,
    ),
  };
}

function repositoryObjectFormat(repositoryRoot) {
  return runGit(repositoryRoot, ['rev-parse', '--show-object-format']).toString('utf8').trim();
}

function verifyReleaseGitObjects(options) {
  const issues = [];
  const add = (code, pathRef, message, kind = 'invalid') => {
    issues.push({ code, stage: 'gitObjectReplay', path: pathRef, message, kind });
  };
  const repositoryRoot = path.resolve(options.repositoryRoot || '');
  if (!options.repositoryRoot || !fs.existsSync(repositoryRoot)) {
    add(
      'M2_RELEASE_GIT_REPOSITORY_REQUIRED',
      '',
      'independently trusted local Git repository is unavailable',
      'unverified',
    );
    return { outcome: 'incomplete', issues, p0: null, p1: null };
  }
  try {
    const p0 = options.p0;
    const p1 = options.p1;
    if (!p0 || !p1) {
      add('M2_RELEASE_GIT_RECORDS_REQUIRED', '', 'P0 and P1 records are required', 'missing');
      return { outcome: 'incomplete', issues, p0: null, p1: null };
    }
    if (p0.gitObjectFormat !== p1.gitObjectFormat) {
      add('M2_RELEASE_GIT_OBJECT_FORMAT', '/gitObjectFormat', 'P0 and P1 object formats differ');
      return { outcome: 'invalid', issues, p0: null, p1: null };
    }
    const objectFormat = repositoryObjectFormat(repositoryRoot);
    if (objectFormat !== p0.gitObjectFormat) {
      add(
        'M2_RELEASE_GIT_OBJECT_FORMAT',
        '/gitObjectFormat',
        `repository uses ${objectFormat}; candidate declares ${p0.gitObjectFormat}`,
      );
      return { outcome: 'invalid', issues, p0: null, p1: null };
    }
    const p0Commit = inspectCommit(repositoryRoot, p0.reviewCommitId, objectFormat);
    if (p0Commit.treeId !== p0.reviewTreeId) {
      add('M2_RELEASE_P0_GIT_TREE', '/reviewTreeId', 'P0 commit tree differs from reviewTreeId');
    }
    if (p0.expectedOldCommitId !== p0.reviewCommitId) {
      add('M2_RELEASE_P0_GIT_OLD_COMMIT', '/expectedOldCommitId', 'P0 old commit differs from review commit');
    }
    if (typeof p0.authoritativeRef === 'string') {
      const observedRef = runGit(
        repositoryRoot,
        ['show-ref', '--verify', '--hash', p0.authoritativeRef],
      ).toString('utf8').trim();
      if (observedRef !== p0.expectedOldCommitId) {
        add(
          'M2_RELEASE_AUTHORITATIVE_REF_OLD_COMMIT',
          '/authoritativeRef',
          'protected ref does not currently equal the independently bound P0 old commit',
        );
      }
    }
    const p0Tree = buildSourceTreeManifest(repositoryRoot, p0Commit.treeId, objectFormat);
    if (p0Tree.sourceTreeDigest !== p0.build?.sourceTreeDigest) {
      add('M2_RELEASE_P0_SOURCE_TREE_DIGEST', '/build/sourceTreeDigest', 'P0 source tree digest replay differs');
    }

    const p1Commit = inspectCommit(repositoryRoot, p1.prospectiveCommitId, objectFormat);
    if (p1Commit.treeId !== p1.treeId) {
      add('M2_RELEASE_P1_GIT_TREE', '/treeId', 'P1 prospective commit tree differs from treeId');
    }
    if (p1.parentCommitId !== p0.reviewCommitId
        || p1Commit.parents.length !== 1
        || p1Commit.parents[0] !== p0.reviewCommitId) {
      add('M2_RELEASE_P1_GIT_PARENT', '/parentCommitId', 'P1 prospective commit does not have exactly P0 as sole parent');
    }
    const p1Tree = buildSourceTreeManifest(repositoryRoot, p1Commit.treeId, objectFormat);
    if (p1Tree.sourceTreeDigest !== p1.build?.sourceTreeDigest) {
      add('M2_RELEASE_P1_SOURCE_TREE_DIGEST', '/build/sourceTreeDigest', 'P1 source tree digest replay differs');
    }
    return {
      outcome: issues.length === 0 ? 'passed' : 'invalid',
      issues,
      p0: { commit: p0Commit, ...p0Tree },
      p1: { commit: p1Commit, ...p1Tree },
    };
  } catch (cause) {
    add(
      'M2_RELEASE_GIT_OBJECT_RECONSTRUCTION',
      '',
      cause && cause.message ? cause.message : String(cause),
      /not a valid object|could not get object info|Not a valid object name/iu.test(cause?.message || '')
        ? 'missing' : 'invalid',
    );
    return { outcome: 'invalid', issues, p0: null, p1: null };
  }
}

module.exports = {
  buildSourceTreeManifest,
  enumerateGitTree,
  inspectCommit,
  repositoryObjectFormat,
  runGit,
  sourceTreeDigest,
  taggedJcsDigest,
  trustedGitRuntimeIdentity,
  verifyReleaseGitObjects,
};
