'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CANDIDATE_INDEX_PATH,
  DISCOVERY_RULES,
  MAX_CORPUS_FILES,
  MAX_FILE_BYTES,
  MAX_FINDING_TEXT_BYTES,
  classify,
  discoverSnapshot,
  readStableRegularFile,
  validateCapturedCorpus,
} = require('../lib/public-symbol-term-coverage-validator.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');

test('term discovery classifier is derived from the exported contract rules', () => {
  for (const rule of DISCOVERY_RULES) {
    const relativePath = rule.pathSuffix.startsWith('/')
      ? `${rule.pathPrefix}probe${rule.pathSuffix}`
      : `${rule.pathPrefix}probe/${rule.pathSuffix}`;
    const matches = DISCOVERY_RULES.filter((candidate) => (
      relativePath.startsWith(candidate.pathPrefix)
        && relativePath.endsWith(candidate.pathSuffix)
    ));
    assert.equal(matches.length, 1, relativePath);
    assert.equal(classify(relativePath), rule.classifier, relativePath);
  }
  assert.equal(classify(CANDIDATE_INDEX_PATH), null);
});

test('term coverage snapshot excludes the non-semantic candidate index', () => {
  const snapshot = discoverSnapshot(ROOT);
  assert.equal(snapshot.files.has(CANDIDATE_INDEX_PATH), false);
  assert.equal(
    snapshot.subjects.some((row) => row.subjectRef.path === CANDIDATE_INDEX_PATH),
    false,
  );
  assert.equal(snapshot.subjects.length, snapshot.files.size);
  for (const subject of snapshot.subjects) {
    assert.equal(classify(subject.subjectRef.path), subject.classifier);
    assert.match(subject.subjectDigest, /^sha256:[0-9a-f]{64}$/u);
  }
});

test('captured term coverage validation performs no live filesystem read', () => {
  const snapshot = discoverSnapshot(ROOT);
  const original = fs.readFileSync;
  fs.readFileSync = () => {
    throw new Error('live filesystem read after immutable snapshot');
  };
  try {
    const validation = validateCapturedCorpus(snapshot.files);
    assert.equal(typeof validation.ok, 'boolean');
    assert.equal(validation.checkedArtifactCount, snapshot.files.size);
  } finally {
    fs.readFileSync = original;
  }
});

test('invalid UTF-8 in a captured module fails closed', () => {
  const snapshot = discoverSnapshot(ROOT);
  const files = new Map([...snapshot.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const modulePath = [...files.keys()].find((name) => classify(name) === 'financeModule');
  assert.ok(modulePath);
  files.set(modulePath, Buffer.concat([files.get(modulePath), Buffer.from([0xff])]));
  const validation = validateCapturedCorpus(files);
  assert.equal(validation.ok, false);
  assert.ok(validation.findings.some((row) => (
    row.code === 'TERM_MODULE_PARSE' && row.path === modulePath
  )));
});

test('candidate index cannot be smuggled into the semantic corpus Map', () => {
  const snapshot = discoverSnapshot(ROOT);
  const files = new Map(snapshot.files);
  files.set(CANDIDATE_INDEX_PATH, Buffer.from('{}', 'utf8'));
  const validation = validateCapturedCorpus(files);
  assert.equal(validation.ok, false);
  assert.ok(validation.findings.some((row) => (
    row.code === 'UNEXPECTED_TERM_CORPUS_ARTIFACT'
      && row.path === CANDIDATE_INDEX_PATH
  )));
});

test('non-string or unsafe corpus keys fail closed instead of escaping validation', () => {
  const files = new Map([
    [42, Buffer.from('{}', 'utf8')],
    ['../outside.json', Buffer.from('{}', 'utf8')],
    ['docs/ontology/term-cards/v0.3/direct/e\u0301.json', Buffer.from('{}', 'utf8')],
  ]);
  const validation = validateCapturedCorpus(files);
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.passedAssertions, []);
  assert.equal(
    validation.findings.filter((row) => row.code === 'UNEXPECTED_TERM_CORPUS_ARTIFACT').length,
    3,
  );
});

test('finding text is byte-bounded while retaining a digest of truncated input', () => {
  const longPath = `../${'é'.repeat(MAX_FINDING_TEXT_BYTES)}`;
  const validation = validateCapturedCorpus(new Map([
    [longPath, Buffer.from('{}', 'utf8')],
  ]));
  const unexpected = validation.findings.find(
    (row) => row.code === 'UNEXPECTED_TERM_CORPUS_ARTIFACT',
  );
  assert.ok(unexpected);
  assert.ok(Buffer.byteLength(unexpected.path, 'utf8') <= MAX_FINDING_TEXT_BYTES);
  assert.match(unexpected.path, /truncated sha256=sha256:[0-9a-f]{64}/u);
});

test('captured corpus file-count exhaustion fails all assertions before compilation', () => {
  const files = new Map();
  for (let index = 0; index <= MAX_CORPUS_FILES; index += 1) {
    files.set(
      `docs/ontology/term-cards/v0.3/direct/resource-${index}.json`,
      Buffer.from('{}', 'utf8'),
    );
  }
  const validation = validateCapturedCorpus(files);
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.passedAssertions, []);
  assert.deepEqual(validation.failedAssertions, [
    'accepted-term-card',
    'generated-inheritance',
    'public-symbol-inventory',
  ]);
  assert.ok(validation.findings.some((row) => row.code === 'TERM_CORPUS_RESOURCE_LIMIT'));
});

test('missing compiler inputs fail every term coverage assertion', () => {
  const validation = validateCapturedCorpus(new Map());
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.passedAssertions, []);
  assert.deepEqual(validation.failedAssertions, [
    'accepted-term-card',
    'generated-inheritance',
    'public-symbol-inventory',
  ]);
  assert.ok(validation.findings.some((row) => (
    row.code === 'TERM_CORPUS_SINGLETON_INVENTORY'
  )));
});

test('missing public-symbol singleton cannot pass any coverage assertion', () => {
  const snapshot = discoverSnapshot(ROOT);
  const files = new Map(snapshot.files);
  const publicPath = [...files.keys()].find(
    (name) => classify(name) === 'publicSymbolManifest',
  );
  assert.ok(publicPath);
  files.delete(publicPath);
  const validation = validateCapturedCorpus(files);
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.passedAssertions, []);
  assert.deepEqual(validation.failedAssertions, [
    'accepted-term-card',
    'generated-inheritance',
    'public-symbol-inventory',
  ]);
  assert.ok(validation.findings.some((row) => (
    row.code === 'TERM_CORPUS_SINGLETON_INVENTORY'
      && row.path === publicPath
  )));
});

test('finding truncation cannot turn a failed public assertion into pass', () => {
  const snapshot = discoverSnapshot(ROOT);
  const files = new Map([...snapshot.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const publicPath = [...files.keys()].find(
    (name) => classify(name) === 'publicSymbolManifest',
  );
  assert.ok(publicPath);
  files.set(publicPath, Buffer.from('{}', 'utf8'));
  for (let index = 0; index < 5100; index += 1) {
    files.set(
      `docs/ontology/term-cards/v0.3/direct/adversarial-${String(index).padStart(4, '0')}.json`,
      Buffer.from('{', 'utf8'),
    );
  }
  const validation = validateCapturedCorpus(files);
  const truncated = validation.findings.find((row) => row.code === 'FINDINGS_TRUNCATED');
  assert.ok(truncated);
  assert.match(truncated.message, /omittedFindingsDigest=sha256:[0-9a-f]{64}/u);
  assert.ok(validation.failedAssertions.includes('public-symbol-inventory'));
  assert.equal(validation.passedAssertions.includes('public-symbol-inventory'), false);
});

test('stable file capture detects same-path content mutation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-term-capture-'));
  const relativePath = 'artifact.bin';
  const absolute = path.join(directory, relativePath);
  fs.writeFileSync(absolute, Buffer.alloc(128 * 1024, 0x61));
  const original = fs.readSync;
  let mutated = false;
  fs.readSync = (...args) => {
    const count = original(...args);
    if (!mutated && count > 0) {
      mutated = true;
      fs.writeFileSync(absolute, Buffer.alloc(128 * 1024, 0x62));
    }
    return count;
  };
  try {
    assert.throws(
      () => readStableRegularFile(directory, relativePath),
      /changed while being captured/u,
    );
  } finally {
    fs.readSync = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stable file capture rejects an oversized file before reading it', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-term-size-limit-'));
  const relativePath = 'artifact.bin';
  const absolute = path.join(directory, relativePath);
  const descriptor = fs.openSync(absolute, 'w');
  try {
    fs.ftruncateSync(descriptor, MAX_FILE_BYTES + 1);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    assert.throws(
      () => readStableRegularFile(directory, relativePath),
      /capture limit/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stable file capture detects replacement immediately after descriptor close', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-term-close-race-'));
  const relativePath = 'artifact.bin';
  const absolute = path.join(directory, relativePath);
  const replacement = path.join(directory, 'replacement.bin');
  fs.writeFileSync(absolute, Buffer.from('AAAAAAAA', 'utf8'));
  fs.writeFileSync(replacement, Buffer.from('BBBBBBBB', 'utf8'));
  const original = fs.closeSync;
  let mutated = false;
  fs.closeSync = (descriptor) => {
    const result = original(descriptor);
    if (!mutated) {
      mutated = true;
      fs.unlinkSync(absolute);
      fs.renameSync(replacement, absolute);
    }
    return result;
  };
  try {
    assert.throws(
      () => readStableRegularFile(directory, relativePath),
      /changed across stable-capture verification/u,
    );
  } finally {
    fs.closeSync = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('opened descriptor must remain bound to the pre-open lexical file', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-term-parent-race-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-term-parent-outside-'));
  const parent = path.join(directory, 'parent');
  const parked = path.join(directory, 'parent-parked');
  fs.mkdirSync(parent);
  fs.writeFileSync(path.join(parent, 'artifact.bin'), 'INSIDE');
  fs.writeFileSync(path.join(outside, 'artifact.bin'), 'OUTSIDE');
  const original = fs.openSync;
  let swapped = false;
  fs.openSync = (candidate, ...args) => {
    if (!swapped && path.resolve(candidate) === path.join(parent, 'artifact.bin')) {
      swapped = true;
      fs.renameSync(parent, parked);
      try {
        fs.symlinkSync(outside, parent, 'junction');
      } catch (cause) {
        fs.renameSync(parked, parent);
        if (['EPERM', 'EACCES', 'UNKNOWN'].includes(cause.code)) {
          context.skip(`platform cannot create a race-test junction: ${cause.code}`);
          return original(path.join(parent, 'artifact.bin'), ...args);
        }
        throw cause;
      }
      const descriptor = original(candidate, ...args);
      fs.rmdirSync(parent);
      fs.renameSync(parked, parent);
      return descriptor;
    }
    return original(candidate, ...args);
  };
  try {
    assert.throws(
      () => readStableRegularFile(directory, 'parent/artifact.bin'),
      /changed before its descriptor was bound/u,
    );
  } finally {
    fs.openSync = original;
    if (fs.existsSync(parked) && !fs.existsSync(parent)) fs.renameSync(parked, parent);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('stable file capture refuses symlink or junction components', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-term-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-term-outside-'));
  const target = path.join(outside, 'artifact.json');
  const link = path.join(directory, 'linked.json');
  fs.writeFileSync(target, '{}');
  try {
    try {
      fs.symlinkSync(target, link, 'file');
    } catch (cause) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(cause.code)) {
        context.skip(`platform cannot create a test symlink: ${cause.code}`);
        return;
      }
      throw cause;
    }
    assert.throws(
      () => readStableRegularFile(directory, 'linked.json'),
      /refuses symbolic link or junction/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('stable file capture refuses a directory junction', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-term-junction-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-term-junction-target-'));
  const link = path.join(directory, 'linked');
  fs.writeFileSync(path.join(outside, 'artifact.json'), '{}');
  try {
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch (cause) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(cause.code)) {
        context.skip(`platform cannot create a test junction: ${cause.code}`);
        return;
      }
      throw cause;
    }
    assert.throws(
      () => readStableRegularFile(directory, 'linked/artifact.json'),
      /refuses symbolic link or junction/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
