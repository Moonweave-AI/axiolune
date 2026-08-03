'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const yaml = require('js-yaml');
const {
  PROFILE_REF,
  PublicSymbolCompilationError,
  compilePublicSymbolManifest,
  utf8Compare,
} = require('./public-symbol-compiler.cjs');
const {
  TermCardCompilationError,
  compileTermCardManifest,
  validateTermCardManifest,
} = require('./term-card-compiler.cjs');
const {
  evaluatePublicIriGeneration,
} = require('./public-iri-generation-rule.cjs');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const GATE_ID = 'public-symbol-term-coverage';
const ASSERTIONS = Object.freeze([
  'accepted-term-card',
  'generated-inheritance',
  'public-symbol-inventory',
].sort(utf8Compare));
const SUBJECT_TAG = 'axiolune-required-gate-subject-v1\0';
const MAX_FINDINGS = 5000;
const MAX_DISCOVERY_ENTRIES = 100000;
const MAX_CORPUS_FILES = 10000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CORPUS_BYTES = 64 * 1024 * 1024;
const MAX_FINDING_TEXT_BYTES = 512;
const PUBLIC_MANIFEST_PATH = 'docs/domain/infrastructure/public-symbol-manifest.json';
const TERM_MANIFEST_PATH = 'docs/domain/infrastructure/term-card-manifest.json';
const REFERENCE_CLOSURE_PATH =
  'docs/ontology/references/reference-closure-manifest.json';
const GENERATION_RULE_PATH = 'scripts/domain/rules/public-iri-generation-v1.json';
const TERM_ROOT = 'docs/ontology/term-cards/v0.3';
const CANDIDATE_INDEX_PATH = `${TERM_ROOT}/candidate-index.json`;

const DISCOVERY_RULES = Object.freeze([
  Object.freeze({
    classifier: 'financeModule',
    pathPrefix: 'ontology/domain/finance/',
    pathSuffix: '/module.yaml',
  }),
  Object.freeze({
    classifier: 'generationRule',
    pathPrefix: 'scripts/domain/rules/',
    pathSuffix: 'public-iri-generation-v1.json',
  }),
  Object.freeze({
    classifier: 'publicSymbolManifest',
    pathPrefix: 'docs/domain/infrastructure/',
    pathSuffix: 'public-symbol-manifest.json',
  }),
  Object.freeze({
    classifier: 'referenceClosure',
    pathPrefix: 'docs/ontology/references/',
    pathSuffix: 'reference-closure-manifest.json',
  }),
  Object.freeze({
    classifier: 'directTermCard',
    pathPrefix: `${TERM_ROOT}/direct/`,
    pathSuffix: '.json',
  }),
  Object.freeze({
    classifier: 'termReview',
    pathPrefix: `${TERM_ROOT}/reviews/`,
    pathSuffix: '.json',
  }),
  Object.freeze({
    classifier: 'generatedInheritance',
    pathPrefix: `${TERM_ROOT}/inheritance/`,
    pathSuffix: '.json',
  }),
  Object.freeze({
    classifier: 'termCardManifest',
    pathPrefix: 'docs/domain/infrastructure/',
    pathSuffix: 'term-card-manifest.json',
  }),
].sort((left, right) => utf8Compare(canonicalJcs(left), canonicalJcs(right))));

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function taggedDigest(tag, value) {
  return sha256(Buffer.concat([
    Buffer.from(tag, 'utf8'),
    Buffer.from(canonicalJcs(value), 'utf8'),
  ]));
}

function posix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function sourceRef(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function classify(relativePath) {
  const matches = DISCOVERY_RULES.filter((rule) => (
    relativePath.startsWith(rule.pathPrefix) && relativePath.endsWith(rule.pathSuffix)
  ));
  if (matches.length > 1) {
    throw new Error(`ambiguous term coverage discovery rules for ${relativePath}`);
  }
  return matches.length === 1 ? matches[0].classifier : null;
}

function safeRelativePath(relativePath) {
  return typeof relativePath === 'string'
    && relativePath.length > 0
    && relativePath === relativePath.normalize('NFC')
    && !relativePath.includes('\0')
    && !relativePath.includes('\\')
    && !path.posix.isAbsolute(relativePath)
    && path.posix.normalize(relativePath) === relativePath
    && relativePath !== '..'
    && !relativePath.startsWith('../');
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertRealPathIdentity(root, relativePath, absolute) {
  const realRoot = fs.realpathSync.native(path.resolve(root));
  const realTarget = fs.realpathSync.native(absolute);
  const relativeReal = path.relative(realRoot, realTarget);
  if (relativeReal === '..' || relativeReal.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeReal)
      || comparablePath(path.join(realRoot, relativeReal)) !== comparablePath(absolute)
      || posix(relativeReal) !== relativePath) {
    throw new Error(`source path does not preserve its lexical identity: ${relativePath}`);
  }
}

function assertNoLinkedComponent(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  let current = resolvedRoot;
  const parts = relativePath.split('/');
  parts.forEach((part, index) => {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`source path refuses symbolic link or junction: ${relativePath}`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`source path parent is not a directory: ${relativePath}`);
    }
    if (index === parts.length - 1 && !stat.isFile()) {
      throw new Error(`source path is not a regular file: ${relativePath}`);
    }
  });
  return current;
}

function statIdentity(stat) {
  return [
    String(stat.dev), String(stat.ino), String(stat.mode), String(stat.size),
    String(stat.mtimeNs), String(stat.ctimeNs),
  ].join('\0');
}

function fileObjectIdentity(stat) {
  return [String(stat.dev), String(stat.ino), String(stat.mode)].join('\0');
}

function captureRegularFileOnce(root, relativePath) {
  const absolute = assertNoLinkedComponent(root, relativePath);
  assertRealPathIdentity(root, relativePath, absolute);
  const lexicalBefore = fs.lstatSync(absolute, { bigint: true });
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
  let bytes;
  let identity;
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error(`source path is not a regular file: ${relativePath}`);
    if (before.size > BigInt(MAX_FILE_BYTES)) {
      throw new Error(
        `source file exceeds ${MAX_FILE_BYTES} byte capture limit: ${relativePath}`,
      );
    }
    if (fileObjectIdentity(lexicalBefore) !== fileObjectIdentity(before)) {
      throw new Error(`source path changed before its descriptor was bound: ${relativePath}`);
    }
    const chunks = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    bytes = Buffer.concat(chunks);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (statIdentity(before) !== statIdentity(after)
        || BigInt(bytes.length) !== after.size) {
      throw new Error(`source file changed while being captured: ${relativePath}`);
    }
    const finalAbsolute = assertNoLinkedComponent(root, relativePath);
    const lexicalAfter = fs.lstatSync(finalAbsolute, { bigint: true });
    if (comparablePath(finalAbsolute) !== comparablePath(absolute)
        || fileObjectIdentity(lexicalAfter) !== fileObjectIdentity(after)) {
      throw new Error(`source path identity changed while being captured: ${relativePath}`);
    }
    assertRealPathIdentity(root, relativePath, finalAbsolute);
    identity = statIdentity(after);
  } finally {
    fs.closeSync(descriptor);
  }
  return { bytes, identity };
}

function readStableRegularFile(root, relativePath) {
  if (!safeRelativePath(relativePath)) {
    throw new Error(`refusing unsafe source path ${String(relativePath)}`);
  }
  const first = captureRegularFileOnce(root, relativePath);
  const second = captureRegularFileOnce(root, relativePath);
  if (first.identity !== second.identity || !first.bytes.equals(second.bytes)) {
    throw new Error(`source file changed across stable-capture verification: ${relativePath}`);
  }
  return first.bytes;
}

function visitTree(root, startRelativePath, onFile, budget) {
  const resolvedRoot = path.resolve(root);
  const start = path.join(resolvedRoot, ...startRelativePath.split('/'));
  if (!fs.existsSync(start)) return;
  const visit = (absolute, relativePath) => {
    budget.entries += 1;
    if (budget.entries > MAX_DISCOVERY_ENTRIES) {
      throw new Error(
        `term-card discovery exceeds ${MAX_DISCOVERY_ENTRIES} filesystem entries`,
      );
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`discovery refuses symbolic link or junction ${relativePath}`);
    }
    assertRealPathIdentity(root, relativePath, absolute);
    if (stat.isFile()) {
      onFile(relativePath);
      return;
    }
    if (!stat.isDirectory()) throw new Error(`discovery refuses non-regular entry ${relativePath}`);
    // Read directory entries incrementally so the discovery budget applies
    // before an attacker-controlled directory can be materialized and sorted
    // wholesale in memory.
    const names = [];
    const directory = fs.opendirSync(absolute);
    try {
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) break;
        if (budget.entries + names.length + 1 > MAX_DISCOVERY_ENTRIES) {
          throw new Error(
            `term-card discovery exceeds ${MAX_DISCOVERY_ENTRIES} filesystem entries`,
          );
        }
        names.push(entry.name);
      }
    } finally {
      directory.closeSync();
    }
    for (const name of names.sort(utf8Compare)) {
      visit(path.join(absolute, name), `${relativePath}/${name}`);
    }
  };
  visit(start, startRelativePath);
}

function discoverPaths(root) {
  const rows = [];
  const budget = { entries: 0 };
  const add = (relativePath) => {
    const classifier = classify(relativePath);
    if (classifier !== null) rows.push({ relativePath, classifier });
  };
  visitTree(root, 'ontology/domain/finance', add, budget);
  visitTree(root, 'scripts/domain/rules', add, budget);
  visitTree(root, 'docs/domain/infrastructure', add, budget);
  visitTree(root, 'docs/ontology/references', add, budget);
  visitTree(root, TERM_ROOT, (relativePath) => {
    if (relativePath === CANDIDATE_INDEX_PATH) return;
    const classifier = classify(relativePath);
    if (classifier === null) {
      throw new Error(`unclassified term-card artifact is outside the gate corpus: ${relativePath}`);
    }
    rows.push({ relativePath, classifier });
  }, budget);
  const byPath = new Map();
  for (const row of rows) {
    if (byPath.has(row.relativePath)) {
      throw new Error(`duplicate corpus discovery path ${row.relativePath}`);
    }
    byPath.set(row.relativePath, row);
  }
  return [...byPath.values()].sort((left, right) => (
    utf8Compare(left.relativePath, right.relativePath)
  ));
}

function discoverSnapshot(root) {
  const first = discoverPaths(root);
  if (first.length > MAX_CORPUS_FILES) {
    throw new Error(`term-card corpus exceeds ${MAX_CORPUS_FILES} captured files`);
  }
  const files = new Map();
  let totalBytes = 0;
  for (const row of first) {
    const bytes = readStableRegularFile(root, row.relativePath);
    totalBytes += bytes.length;
    if (totalBytes > MAX_CORPUS_BYTES) {
      throw new Error(`term-card corpus exceeds ${MAX_CORPUS_BYTES} captured bytes`);
    }
    files.set(row.relativePath, bytes);
  }
  const second = discoverPaths(root);
  if (canonicalJcs(second) !== canonicalJcs(first)) {
    throw new Error('term-card corpus path set changed while its byte snapshot was captured');
  }
  for (const [relativePath, bytes] of files) {
    const verified = readStableRegularFile(root, relativePath);
    if (!verified.equals(bytes)) {
      throw new Error(`term-card corpus bytes changed while captured: ${relativePath}`);
    }
  }
  const finalPaths = discoverPaths(root);
  if (canonicalJcs(finalPaths) !== canonicalJcs(first)) {
    throw new Error('term-card corpus path set changed while its bytes were verified');
  }
  const subjects = first.map(({ relativePath, classifier }) => {
    const subjectRef = sourceRef(relativePath);
    const subjectDigest = sha256(files.get(relativePath));
    return {
      subjectId: taggedDigest(SUBJECT_TAG, {
        gateId: GATE_ID, subjectRef, subjectDigest, classifier,
      }),
      subjectRef,
      subjectDigest,
      classifier,
    };
  }).sort((left, right) => utf8Compare(left.subjectId, right.subjectId));
  return { files, subjects };
}

function finding(code, at, message) {
  const boundedText = (value) => {
    const full = Buffer.from(String(value ?? ''), 'utf8');
    if (full.length <= MAX_FINDING_TEXT_BYTES) return full.toString('utf8');
    const suffix = `…[truncated sha256=${sha256(full)}]`;
    const prefixBudget = MAX_FINDING_TEXT_BYTES - Buffer.byteLength(suffix, 'utf8');
    let end = Math.max(0, prefixBudget);
    while (end > 0 && (full[end] & 0xc0) === 0x80) end -= 1;
    return `${full.subarray(0, end).toString('utf8')}${suffix}`;
  };
  return {
    code: String(code).replace(/[^A-Z0-9_]/gu, '_').toUpperCase(),
    path: boundedText(at),
    message: boundedText(message),
  };
}

function normalizeFindings(findings) {
  const rows = findings.map((row) => finding(row.code, row.path, row.message))
    .sort((left, right) => utf8Compare(
      `${left.code}\0${left.path}\0${left.message}`,
      `${right.code}\0${right.path}\0${right.message}`,
    ));
  if (rows.length <= MAX_FINDINGS) return rows;
  const omitted = rows.slice(MAX_FINDINGS - 1);
  const omittedDigest = taggedDigest(
    'axiolune-omitted-term-coverage-findings-v1\0',
    omitted,
  );
  return [
    ...rows.slice(0, MAX_FINDINGS - 1),
    finding(
      'FINDINGS_TRUNCATED',
      '',
      `${omitted.length} findings omitted; omittedFindingsDigest=${omittedDigest}`,
    ),
  ];
}

function fatalUtf8(bytes, at) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new Error(`${at} is not valid UTF-8: ${cause.message}`);
  }
}

function parseJson(bytes, at, requireJcs = false) {
  const value = JSON.parse(fatalUtf8(bytes, at));
  if (requireJcs && !bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
    throw new Error(`${at} is not exact RFC 8785 JCS bytes`);
  }
  return value;
}

function artifactEnvelope(relativePath, bytes) {
  return { artifactRef: sourceRef(relativePath), bytes };
}

function validateCapturedCorpus(files) {
  if (!(files instanceof Map)) throw new Error('term-card corpus must be an immutable byte Map');
  const findings = [];
  const failAll = () => ({
    ok: false,
    findings: normalizeFindings(findings),
    checkedArtifactCount: files.size,
    passedAssertions: [],
    failedAssertions: [...ASSERTIONS],
  });
  if (files.size > MAX_CORPUS_FILES) {
    findings.push(finding(
      'TERM_CORPUS_RESOURCE_LIMIT',
      '',
      `captured corpus exceeds ${MAX_CORPUS_FILES} files`,
    ));
    return failAll();
  }
  const inventory = new Map();
  let totalBytes = 0;
  let resourceLimitExceeded = false;
  for (const [relativePath, bytes] of files) {
    const safePath = safeRelativePath(relativePath);
    const classifier = safePath ? classify(relativePath) : null;
    if (!safePath || classifier === null || !Buffer.isBuffer(bytes)) {
      findings.push(finding(
        'UNEXPECTED_TERM_CORPUS_ARTIFACT',
        relativePath,
        'captured corpus contains an unclassified path or non-byte payload',
      ));
      continue;
    }
    if (bytes.length > MAX_FILE_BYTES) {
      resourceLimitExceeded = true;
      findings.push(finding(
        'TERM_CORPUS_RESOURCE_LIMIT',
        relativePath,
        `captured artifact exceeds ${MAX_FILE_BYTES} bytes`,
      ));
      continue;
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_CORPUS_BYTES) {
      resourceLimitExceeded = true;
      findings.push(finding(
        'TERM_CORPUS_RESOURCE_LIMIT',
        '',
        `captured corpus exceeds ${MAX_CORPUS_BYTES} bytes`,
      ));
      break;
    }
    if (!inventory.has(classifier)) inventory.set(classifier, []);
    inventory.get(classifier).push([relativePath, Buffer.from(bytes)]);
  }
  if (resourceLimitExceeded) return failAll();
  for (const rows of inventory.values()) rows.sort((left, right) => utf8Compare(left[0], right[0]));

  const singleton = (classifier, relativePath) => {
    const rows = inventory.get(classifier) || [];
    if (rows.length !== 1 || rows[0][0] !== relativePath) {
      findings.push(finding(
        'TERM_CORPUS_SINGLETON_INVENTORY',
        relativePath,
        `expected exactly one ${classifier} artifact`,
      ));
      return null;
    }
    return rows[0][1];
  };

  const moduleRows = inventory.get('financeModule') || [];
  const modules = [];
  if (moduleRows.length === 0) {
    findings.push(finding('EMPTY_MODULE_SET', 'ontology/domain/finance', 'no finance modules captured'));
  }
  for (const [relativePath, bytes] of moduleRows) {
    try {
      modules.push(yaml.load(fatalUtf8(bytes, relativePath)));
    } catch (cause) {
      findings.push(finding('TERM_MODULE_PARSE', relativePath, cause.message));
    }
  }

  const publicBytes = singleton('publicSymbolManifest', PUBLIC_MANIFEST_PATH);
  const closureBytes = singleton('referenceClosure', REFERENCE_CLOSURE_PATH);
  const ruleBytes = singleton('generationRule', GENERATION_RULE_PATH);
  const termBytes = singleton('termCardManifest', TERM_MANIFEST_PATH);
  let compiledPublic = null;
  if (modules.length === moduleRows.length && modules.length > 0) {
    try {
      compiledPublic = compilePublicSymbolManifest(modules);
      const expected = Buffer.from(canonicalJcs(compiledPublic.manifest), 'utf8');
      if (publicBytes !== null && !publicBytes.equals(expected)) {
        findings.push(finding(
          'PUBLIC_SYMBOL_MANIFEST_DRIFT',
          PUBLIC_MANIFEST_PATH,
          `${sha256(publicBytes)} != compiler ${sha256(expected)}`,
        ));
      }
    } catch (cause) {
      const errors = cause instanceof PublicSymbolCompilationError
        ? cause.errors : [{ code: 'PUBLIC_SYMBOL_COMPILER_ERROR', path: 'modules', message: cause.message }];
      for (const row of errors) findings.push(finding(row.code, row.path, row.message));
    }
  }

  let closure = null;
  if (closureBytes !== null) {
    try {
      closure = parseJson(closureBytes, REFERENCE_CLOSURE_PATH, true);
    } catch (cause) {
      findings.push(finding('REFERENCE_CLOSURE_PARSE', REFERENCE_CLOSURE_PATH, cause.message));
    }
  }

  let compiledTerm = null;
  if (publicBytes !== null && closure !== null && ruleBytes !== null
      && modules.length === moduleRows.length && modules.length > 0) {
    const input = {
      profileRef: PROFILE_REF,
      publicSymbolManifestArtifact: artifactEnvelope(PUBLIC_MANIFEST_PATH, publicBytes),
      referenceClosureManifest: closure,
      moduleDocs: modules,
      cardArtifacts: (inventory.get('directTermCard') || [])
        .map(([relativePath, bytes]) => artifactEnvelope(relativePath, bytes)),
      reviewArtifacts: (inventory.get('termReview') || [])
        .map(([relativePath, bytes]) => artifactEnvelope(relativePath, bytes)),
      inheritanceArtifacts: (inventory.get('generatedInheritance') || [])
        .map(([relativePath, bytes]) => artifactEnvelope(relativePath, bytes)),
      generationRuleArtifacts: [artifactEnvelope(GENERATION_RULE_PATH, ruleBytes)],
    };
    const options = { generationRuleEvaluator: evaluatePublicIriGeneration, requireAccepted: true };
    try {
      compiledTerm = compileTermCardManifest(input, options);
      if (termBytes !== null) {
        const actual = parseJson(termBytes, TERM_MANIFEST_PATH, true);
        const validation = validateTermCardManifest(actual, input, options);
        for (const row of validation.errors) findings.push(finding(row.code, row.path, row.message));
        const expected = Buffer.from(canonicalJcs(compiledTerm.manifest), 'utf8');
        if (!termBytes.equals(expected)) {
          findings.push(finding(
            'TERM_CARD_MANIFEST_DRIFT',
            TERM_MANIFEST_PATH,
            `${sha256(termBytes)} != compiler ${sha256(expected)}`,
          ));
        }
      }
    } catch (cause) {
      const errors = cause instanceof TermCardCompilationError
        ? cause.errors : [{ code: 'TERM_CARD_COMPILER_ERROR', path: 'term-cards', message: cause.message }];
      for (const row of errors) findings.push(finding(row.code, row.path, row.message));
    }
  }

  // Assertion truth must be derived from the complete, untruncated finding
  // set.  Presentation truncation is applied only after all assertion states
  // are fixed; otherwise a late-sorting PUBLIC_* finding can disappear and
  // falsely report public-symbol-inventory as passed.
  const publicFailed = publicBytes === null || compiledPublic === null || findings.some((row) => (
    row.code.startsWith('PUBLIC_') || row.code === 'EMPTY_MODULE_SET'
      || row.code === 'TERM_MODULE_PARSE'
  ));
  // Term coverage is meaningful only for the exact current module-derived
  // public inventory.  A missing or stale public manifest must not let cards
  // for an older inventory satisfy either term assertion.
  const termFailed = publicFailed || compiledTerm === null || findings.some((row) => (
    !row.code.startsWith('PUBLIC_') && row.code !== 'EMPTY_MODULE_SET'
      && row.code !== 'TERM_MODULE_PARSE'
  ));
  const normalized = normalizeFindings(findings);
  return {
    ok: normalized.length === 0 && !publicFailed && !termFailed,
    findings: normalized,
    checkedArtifactCount: files.size,
    passedAssertions: [
      ...(!publicFailed ? ['public-symbol-inventory'] : []),
      ...(!termFailed ? ['accepted-term-card', 'generated-inheritance'] : []),
    ].sort(utf8Compare),
    failedAssertions: [
      ...(publicFailed ? ['public-symbol-inventory'] : []),
      ...(termFailed ? ['accepted-term-card', 'generated-inheritance'] : []),
    ].sort(utf8Compare),
  };
}

function captureAndValidate(root) {
  const snapshot = discoverSnapshot(path.resolve(root));
  return { snapshot, validation: validateCapturedCorpus(snapshot.files) };
}

module.exports = {
  ASSERTIONS,
  CANDIDATE_INDEX_PATH,
  DISCOVERY_RULES,
  GATE_ID,
  GENERATION_RULE_PATH,
  MAX_CORPUS_BYTES,
  MAX_CORPUS_FILES,
  MAX_DISCOVERY_ENTRIES,
  MAX_FILE_BYTES,
  MAX_FINDING_TEXT_BYTES,
  PUBLIC_MANIFEST_PATH,
  REFERENCE_CLOSURE_PATH,
  SUBJECT_TAG,
  TERM_MANIFEST_PATH,
  captureAndValidate,
  classify,
  discoverPaths,
  discoverSnapshot,
  readStableRegularFile,
  sha256,
  taggedDigest,
  validateCapturedCorpus,
};
