'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  buildSourceTreeManifest,
  inspectCommit,
  repositoryObjectFormat,
  trustedGitRuntimeIdentity,
  verifyReleaseGitObjects,
} = require('../lib/m2-git-replay.cjs');

function git(root, args, input = null) {
  const result = spawnSync('git', ['-C', root, ...args], {
    input,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-git-replay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '--object-format=sha1']);
  git(root, ['config', 'user.name', 'M2 Replay Test']);
  git(root, ['config', 'user.email', 'm2-replay@example.invalid']);
  fs.mkdirSync(path.join(root, 'ontology'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ontology', 'module.yaml'), 'module: v1\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'p0']);
  const p0CommitId = git(root, ['rev-parse', 'HEAD']);
  const p0Commit = inspectCommit(root, p0CommitId, 'sha1');
  const p0Tree = buildSourceTreeManifest(root, p0Commit.treeId, 'sha1');

  fs.writeFileSync(path.join(root, 'ontology', 'module.yaml'), 'module: v2\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# candidate\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'p1']);
  const p1CommitId = git(root, ['rev-parse', 'HEAD']);
  const p1Commit = inspectCommit(root, p1CommitId, 'sha1');
  const p1Tree = buildSourceTreeManifest(root, p1Commit.treeId, 'sha1');
  const authoritativeRef = 'refs/heads/release/m2-v0.3.0';
  git(root, ['update-ref', authoritativeRef, p0CommitId]);
  return {
    root,
    p0: {
      gitObjectFormat: 'sha1',
      authoritativeRef,
      expectedOldCommitId: p0CommitId,
      reviewCommitId: p0CommitId,
      reviewTreeId: p0Commit.treeId,
      build: { sourceTreeDigest: p0Tree.sourceTreeDigest },
    },
    p1: {
      gitObjectFormat: 'sha1',
      authoritativeRef,
      prospectiveCommitId: p1CommitId,
      treeId: p1Commit.treeId,
      parentCommitId: p0CommitId,
      build: { sourceTreeDigest: p1Tree.sourceTreeDigest },
    },
  };
}

test('reconstructs P0/P1 commits, sole parent, trees, blobs, and framed tree digests', (t) => {
  const candidate = fixture(t);
  const result = verifyReleaseGitObjects({
    repositoryRoot: candidate.root,
    p0: candidate.p0,
    p1: candidate.p1,
  });
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.issues, []);
  assert.equal(result.p0.commit.commitId, candidate.p0.reviewCommitId);
  assert.equal(result.p1.commit.commitId, candidate.p1.prospectiveCommitId);
  assert.match(result.p1.sourceTreeManifestDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('Git replay ignores PATH executables and caller GIT_* / NODE_OPTIONS injection', (t) => {
  const candidate = fixture(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-git-env-'));
  const marker = path.join(directory, 'fake-git-executed');
  const preload = path.join(directory, 'preload.cjs');
  fs.writeFileSync(preload, [
    "'use strict';",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    '',
  ].join('\n'));
  if (process.platform === 'win32') {
    fs.copyFileSync(process.execPath, path.join(directory, 'git.exe'));
  } else {
    const fakeGit = path.join(directory, 'git');
    fs.writeFileSync(fakeGit, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\nexit 97\n`);
    fs.chmodSync(fakeGit, 0o755);
  }
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const names = [
    'PATH', 'NODE_OPTIONS', 'GIT_DIR', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT',
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    process.env.PATH = directory;
    process.env.NODE_OPTIONS = `--require=${preload}`;
    process.env.GIT_DIR = path.join(directory, 'attacker.git');
    process.env.GIT_OBJECT_DIRECTORY = path.join(directory, 'objects');
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = path.join(directory, 'alternates');
    process.env.GIT_CONFIG_COUNT = '1';
    assert.equal(repositoryObjectFormat(candidate.root), 'sha1');
    assert.equal(fs.existsSync(marker), false);
    const runtime = trustedGitRuntimeIdentity();
    assert.equal(path.isAbsolute(runtime.executable), true);
    assert.match(runtime.artifactDigest, /^sha256:[0-9a-f]{64}$/u);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('changed tree digest and substituted parent fail closed', (t) => {
  const candidate = fixture(t);
  const digestTamper = structuredClone(candidate.p1);
  digestTamper.build.sourceTreeDigest = `sha256:${'0'.repeat(64)}`;
  let result = verifyReleaseGitObjects({
    repositoryRoot: candidate.root,
    p0: candidate.p0,
    p1: digestTamper,
  });
  assert.ok(result.issues.some((issue) => issue.code === 'M2_RELEASE_P1_SOURCE_TREE_DIGEST'));

  const parentTamper = structuredClone(candidate.p1);
  parentTamper.parentCommitId = candidate.p1.prospectiveCommitId;
  result = verifyReleaseGitObjects({
    repositoryRoot: candidate.root,
    p0: candidate.p0,
    p1: parentTamper,
  });
  assert.ok(result.issues.some((issue) => issue.code === 'M2_RELEASE_P1_GIT_PARENT'));
});

test('missing prospective Git object cannot be replaced by a caller-authored ID', (t) => {
  const candidate = fixture(t);
  candidate.p1.prospectiveCommitId = 'f'.repeat(40);
  const result = verifyReleaseGitObjects({
    repositoryRoot: candidate.root,
    p0: candidate.p0,
    p1: candidate.p1,
  });
  assert.equal(result.outcome, 'invalid');
  assert.ok(result.issues.some((issue) => issue.code === 'M2_RELEASE_GIT_OBJECT_RECONSTRUCTION'));
});

test('a moved authoritative ref cannot satisfy the P0 compare-and-swap precondition', (t) => {
  const candidate = fixture(t);
  git(candidate.root, [
    'update-ref',
    candidate.p0.authoritativeRef,
    candidate.p1.prospectiveCommitId,
  ]);
  const result = verifyReleaseGitObjects({
    repositoryRoot: candidate.root,
    p0: candidate.p0,
    p1: candidate.p1,
  });
  assert.ok(result.issues.some(
    (issue) => issue.code === 'M2_RELEASE_AUTHORITATIVE_REF_OLD_COMMIT',
  ));
});

test('Git symlink mode is rejected without checking it out', (t) => {
  const candidate = fixture(t);
  const blobId = git(candidate.root, ['hash-object', '-w', '--stdin'], 'target');
  git(candidate.root, ['update-index', '--add', '--cacheinfo', `120000,${blobId},unsafe-link`]);
  const treeId = git(candidate.root, ['write-tree']);
  assert.throws(
    () => buildSourceTreeManifest(candidate.root, treeId, 'sha1'),
    /forbidden 120000 blob entry/u,
  );
});
