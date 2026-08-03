#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  canonicalJcs,
} = require('../lib/strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const AUTHORITY_FILES = Object.freeze([
  {
    relative: 'reference/ontology-design-reference/axiolune-controlled-quantity-units/m2-v0.3-quantity-units.json',
    finalLf: true,
  },
  {
    relative: 'reference/ontology-design-reference/axiolune-controlled-terminology/m2-v0.3-terms.json',
    finalLf: false,
  },
  {
    relative: 'reference/ontology-design-reference/axiolune-controlled-vocabularies/m2-v0.3-code-lists.json',
    finalLf: false,
  },
]);
const ADOPTED_DECISION = Object.freeze({
  decisionTime: '2026-08-01T00:00:00Z',
  driRef: 'urn:axiolune:principal:integration-test-dri',
  rationale: 'Adopt all exact digest-bound M2 v0.3 authority candidates for transition testing.',
  reviewBasisRefs: [
    'urn:axiolune:review:authority-transition-integration',
    'urn:axiolune:review:m2-plan-section-0.1',
  ],
  status: 'adopted',
});

function copyTree(source, target, copyFiles) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(sourcePath, targetPath, copyFiles);
    else if (entry.isFile()) {
      if (copyFiles) fs.copyFileSync(sourcePath, targetPath);
      else fs.linkSync(sourcePath, targetPath);
    } else {
      throw new Error(`isolated transition fixture refuses non-regular entry ${sourcePath}`);
    }
  }
}

function copyFileIfPresent(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function buildIsolatedTree() {
  const temporaryRoot = fs.mkdtempSync(
    path.join(path.parse(ROOT).root, 'axt-'),
  );
  copyTree(path.join(ROOT, 'scripts', 'domain'), path.join(temporaryRoot, 'scripts', 'domain'), false);
  copyTree(
    path.join(ROOT, 'ontology', 'domain', 'finance'),
    path.join(temporaryRoot, 'ontology', 'domain', 'finance'),
    false,
  );
  copyTree(path.join(ROOT, 'reference'), path.join(temporaryRoot, 'reference'), false);
  copyTree(path.join(ROOT, 'docs', 'ontology'), path.join(temporaryRoot, 'docs', 'ontology'), true);
  copyTree(
    path.join(ROOT, 'docs', 'domain', 'planning'),
    path.join(temporaryRoot, 'docs', 'domain', 'planning'),
    false,
  );
  copyFileIfPresent(
    path.join(ROOT, 'docs', 'domain', 'infrastructure', 'public-symbol-manifest.json'),
    path.join(temporaryRoot, 'docs', 'domain', 'infrastructure', 'public-symbol-manifest.json'),
  );
  copyFileIfPresent(
    path.join(ROOT, 'docs', 'domain', 'infrastructure', 'term-card-manifest.json'),
    path.join(temporaryRoot, 'docs', 'domain', 'infrastructure', 'term-card-manifest.json'),
  );
  return temporaryRoot;
}

function replaceFile(file, bytes) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
  fs.writeFileSync(file, bytes);
}

function candidateBytes(value, finalLf) {
  return Buffer.from(`${canonicalJcs(value)}${finalLf ? '\n' : ''}`, 'utf8');
}

function runNode(rootDir, relativeScript, args = []) {
  const nodePath = [
    path.join(ROOT, 'node_modules'),
    process.env.NODE_PATH,
  ].filter(Boolean).join(path.delimiter);
  return spawnSync(process.execPath, [relativeScript, ...args], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      AXIOLUNE_PDF_EXTRACTOR_RUNTIME_DIR: path.join(ROOT, 'tmp', 'pdf-extractor-runtime'),
      NODE_PATH: nodePath,
    },
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    timeout: 120000,
  });
}

function outcome(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
}

function expectPass(rootDir, script, args = []) {
  const result = runNode(rootDir, script, args);
  assert.equal(
    result.status,
    0,
    `${script} ${args.join(' ')} failed\n${outcome(result)}`,
  );
  return result;
}

function expectFail(rootDir, script, args = [], pattern = /./u) {
  const result = runNode(rootDir, script, args);
  assert.notEqual(result.status, 0, `${script} unexpectedly passed`);
  assert.match(outcome(result), pattern);
  return result;
}

test('repository-only adopted edits cannot manufacture authority or accepted term cards', (t) => {
  const isolatedRoot = buildIsolatedTree();
  t.after(() => fs.rmSync(isolatedRoot, { recursive: true, force: true }));

  // The shared work tree may legitimately have module edits while generated
  // global artifacts remain stale.  The isolated transition fixture must bind
  // its own current public-symbol projection before testing authority state.
  expectPass(isolatedRoot, 'scripts/domain/generate-public-symbol-manifest.cjs', ['--write']);

  // `reference/` is hard-linked for test speed.  Detach the three files that
  // this fixture mutates before regenerating them so the source work tree is
  // never modified through a temporary hard link.
  for (const fixture of AUTHORITY_FILES) {
    const file = path.join(isolatedRoot, ...fixture.relative.split('/'));
    replaceFile(file, Buffer.from(fs.readFileSync(file)));
  }
  expectPass(isolatedRoot, 'scripts/domain/generate-code-list-authority-manifest.cjs', ['--write']);
  expectPass(isolatedRoot, 'scripts/domain/generate-term-authority-manifest.cjs', ['--write']);

  for (const fixture of AUTHORITY_FILES) {
    const file = path.join(isolatedRoot, ...fixture.relative.split('/'));
    const candidate = JSON.parse(fs.readFileSync(file, 'utf8'));
    candidate.decision = structuredClone(ADOPTED_DECISION);
    if (fixture.relative.includes('axiolune-controlled-vocabularies/')
        || fixture.relative.includes('axiolune-controlled-terminology/')) {
      candidate.decision.candidateDigest = candidate.candidateDigest;
    }
    const bytes = candidateBytes(candidate, fixture.finalLf);
    replaceFile(file, bytes);
  }

  // Recomputing every mutable repository artifact after editing status/driRef
  // must still fail: self-consistency is not an external trust boundary.
  for (const [script, args] of [
    ['scripts/domain/generate-code-list-authority-manifest.cjs', ['--check']],
    ['scripts/domain/generate-term-authority-manifest.cjs', ['--check']],
    ['scripts/domain/migrate-reference-lock-v0.3.cjs', ['--write']],
    ['scripts/domain/generate-authority-reference-review.cjs', ['--write']],
    ['scripts/domain/generate-term-card-artifacts.cjs', ['--write']],
  ]) {
    expectFail(
      isolatedRoot,
      script,
      args,
      /terminal authority adoption is unavailable|repository-edited adopted JSON|adopted fields|refusing to replace a DRI-adopted|wholeFile selection digest mismatch|reference closure is stale/u,
    );
  }

  // No accepted review/inheritance artifacts may be manufactured by the
  // failed transition.
  const cardRoot = path.join(isolatedRoot, 'docs', 'ontology', 'term-cards', 'v0.3');
  for (const directory of ['reviews', 'inheritance']) {
    const candidate = path.join(cardRoot, directory);
    assert.equal(
      fs.existsSync(candidate) ? fs.readdirSync(candidate).length : 0,
      0,
      `${directory} must remain empty after rejected repository-only adoption`,
    );
  }
});
