'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');
const {
  canonicalJcs,
  computeSelectionDigest,
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');
const { extractJsonPointerJcsBytes } = require('./json-pointer-source-extractor.cjs');
const {
  extractPdfPageRangeBytes,
  parseRuntimeLock,
  resolveRuntimeRoot,
} = require('./pdf-page-range-runtime.cjs');
const { extractRdfXmlResourceBytes } = require('./rdf-resource-source-extractor.cjs');
const { extractUniqueXmlElementBytes } = require('./reference-source-extractors.cjs');
const { extractTextLineRangeBytes } = require('./text-line-range-source-extractor.cjs');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ASCII_ID_RE = /^[\x21-\x7e]+$/;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const PAYWALLED_SENTINEL = 'sha256:unavailable-paywalled';
const BUNDLE_TAG = Buffer.from('axiolune-reference-bundle-v1\0', 'utf8');
const SELECTION_TAG = Buffer.from('axiolune-source-selection-v1\0', 'utf8');
const TRACE_NODE_TAG = Buffer.from('axiolune-trace-node-v1\0', 'utf8');
const REFERENCE_CATEGORIES = new Set([
  'authority-reference',
  'ontology-design-reference',
  'project-reference',
]);
// Historical pre-phase material is intentionally retained at its original,
// audited path.  Keep this allow-list exact: arbitrary directories directly
// below reference/ must still fail closed.
const STANDALONE_REFERENCE_PROJECTS = new Set(['axiolune-design-draft']);
const PDF_RUNTIME_DRIVER = path.resolve(__dirname, 'pdf-page-range-runtime.cjs');

const NODE_FIELDS = {
  sourceLocator: ['nodeId', 'nodeKind', 'referenceId', 'artifactRef', 'artifactDigest', 'locator'],
  termCard: ['nodeId', 'nodeKind', 'artifactRef', 'artifactDigest', 'publicIri'],
  publicSymbol: ['nodeId', 'nodeKind', 'artifactRef', 'artifactDigest', 'publicIri'],
  targetIdentityContract: [
    'nodeId', 'nodeKind', 'identityManifestRef', 'identityManifestDigest',
    'contractRef', 'contractDigest', 'targetType',
  ],
  identityMapping: [
    'nodeId', 'nodeKind', 'identityManifestRef', 'identityManifestDigest',
    'mappingRef', 'mappingDigest', 'targetType', 'contractRef', 'contractDigest',
  ],
  identityTermContract: [
    'nodeId', 'nodeKind', 'identityTermRegistryRef', 'identityTermRegistryDigest',
    'termContractRef', 'termContractDigest',
  ],
  controlledIriSet: [
    'nodeId', 'nodeKind', 'identityTermRegistryRef', 'identityTermRegistryDigest',
    'controlledSetRef', 'controlledSetDigest',
  ],
  alignmentDecision: [
    'nodeId', 'nodeKind', 'artifactRef', 'artifactDigest',
    'decisionId', 'localPublicIri', 'targetPublicIri', 'outcome',
  ],
  constraintInstance: [
    'nodeId', 'nodeKind', 'artifactRef', 'artifactDigest',
    'constraintInstanceId', 'targetPublicIri',
  ],
  competencyQuestion: [
    'nodeId', 'nodeKind', 'artifactRef', 'artifactDigest', 'cqId', 'executionIdentity',
  ],
  positiveFixture: ['nodeId', 'nodeKind', 'artifactRef', 'artifactDigest', 'fixtureId'],
  negativeFixture: ['nodeId', 'nodeKind', 'artifactRef', 'artifactDigest', 'fixtureId'],
  gateCheckExpectation: ['nodeId', 'nodeKind', 'artifactRef', 'artifactDigest', 'gateId', 'checkId'],
};

const SEMANTIC_KEY_FIELDS = {
  sourceLocator: ['nodeKind', 'referenceId', 'artifactRef', 'locator'],
  termCard: ['nodeKind', 'publicIri'],
  publicSymbol: ['nodeKind', 'publicIri'],
  targetIdentityContract: ['nodeKind', 'contractRef', 'targetType'],
  identityMapping: ['nodeKind', 'mappingRef', 'targetType', 'contractRef'],
  identityTermContract: ['nodeKind', 'termContractRef'],
  controlledIriSet: ['nodeKind', 'controlledSetRef'],
  alignmentDecision: ['nodeKind', 'artifactRef', 'decisionId'],
  constraintInstance: ['nodeKind', 'constraintInstanceId'],
  competencyQuestion: ['nodeKind', 'cqId'],
  positiveFixture: ['nodeKind', 'fixtureId', 'artifactRef'],
  negativeFixture: ['nodeKind', 'fixtureId', 'artifactRef'],
  gateCheckExpectation: ['nodeKind', 'gateId', 'checkId'],
};

const EDGE_MATRIX = new Set([
  'sourceLocator|termCard|supportsTerm',
  'sourceLocator|targetIdentityContract|supportsIdentity',
  'sourceLocator|identityMapping|supportsMapping',
  'sourceLocator|identityTermContract|supportsIdentityTerm',
  'sourceLocator|controlledIriSet|supportsControlledSet',
  'sourceLocator|alignmentDecision|supportsAlignmentDecision',
  'sourceLocator|constraintInstance|supportsConstraint',
  'termCard|publicSymbol|definesSymbol',
  'publicSymbol|targetIdentityContract|hasIdentityContract',
  'targetIdentityContract|identityMapping|boundByMapping',
  'targetIdentityContract|identityTermContract|usesIdentityTerm',
  'identityTermContract|controlledIriSet|usesControlledSet',
  'publicSymbol|constraintInstance|hasConstraint',
  'publicSymbol|competencyQuestion|hasExercise',
  'constraintInstance|positiveFixture|hasPositiveCase',
  'competencyQuestion|positiveFixture|hasPositiveCase',
  'constraintInstance|negativeFixture|hasNegativeCase',
  'competencyQuestion|negativeFixture|hasNegativeCase',
  'targetIdentityContract|gateCheckExpectation|executedAs',
  'identityMapping|gateCheckExpectation|executedAs',
  'identityTermContract|gateCheckExpectation|executedAs',
  'controlledIriSet|gateCheckExpectation|executedAs',
  'constraintInstance|gateCheckExpectation|executedAs',
  'competencyQuestion|gateCheckExpectation|executedAs',
  'positiveFixture|gateCheckExpectation|executedAs',
  'negativeFixture|gateCheckExpectation|executedAs',
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function u64be(value) {
  const number = typeof value === 'bigint' ? value : BigInt(value);
  if (number < 0n || number > 0xffffffffffffffffn) throw new Error('value is outside unsigned 64-bit range');
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(number);
  return bytes;
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function readDirectoryUtf8(directory, rootDir, errors) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const decoded = [];
  for (const dirent of fs.readdirSync(directory, { withFileTypes: true, encoding: 'buffer' })) {
    let name;
    try {
      name = decoder.decode(dirent.name);
    } catch {
      const parent = normalizeRepoPath(path.relative(rootDir, directory)) || '.';
      issue(
        errors,
        'INVALID_UTF8_REFERENCE_PATH',
        `${parent}/0x${dirent.name.toString('hex')}`,
        'filesystem name is not valid UTF-8 and cannot enter the canonical bundle',
      );
      continue;
    }
    decoded.push({ dirent, name });
  }
  return decoded.sort((left, right) => compareUtf8(left.name, right.name));
}

function normalizeRepoPath(value) {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '');
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function fileDigest(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest('hex')}`;
}

function issue(errors, code, at, message, detail) {
  const value = { code, at, message };
  if (detail !== undefined) value.detail = detail;
  errors.push(value);
}

function deduplicateIssues(errors) {
  const unique = new Map();
  for (const value of errors) {
    const key = canonicalJcs(value);
    if (!unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()];
}

function requireClosedObject(value, fields, at, errors) {
  if (!isPlainObject(value)) {
    issue(errors, 'EXPECTED_CLOSED_OBJECT', at, 'expected a closed object');
    return false;
  }
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issue(errors, 'UNKNOWN_FIELD', `${at}.${key}`, 'field is not allowed by the closed contract');
  }
  for (const field of fields) {
    if (!(field in value)) issue(errors, 'MISSING_FIELD', `${at}.${field}`, 'required field is missing');
  }
  return true;
}

function validateDigest(value, at, errors) {
  if (!DIGEST_RE.test(value || '')) issue(errors, 'INVALID_DIGEST', at, 'expected sha256 followed by 64 lowercase hex digits');
}

function validateAsciiId(value, at, errors) {
  if (typeof value !== 'string' || value.length === 0 || !ASCII_ID_RE.test(value)) {
    issue(errors, 'INVALID_ASCII_ID', at, 'expected a non-empty printable ASCII identifier');
  }
}

function validateAbsoluteIri(value, at, errors) {
  if (typeof value !== 'string' || value !== value.normalize('NFC') || /\s/u.test(value)) {
    issue(errors, 'INVALID_ABSOLUTE_IRI', at, 'expected an absolute normalized IRI');
    return;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol) throw new Error('missing protocol');
  } catch {
    issue(errors, 'INVALID_ABSOLUTE_IRI', at, 'expected an absolute normalized IRI');
  }
}

function validatePosixPath(value, at, errors) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')) {
    issue(errors, 'INVALID_POSIX_PATH', at, 'expected a non-empty Unicode-NFC POSIX path');
    return false;
  }
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) {
    issue(errors, 'INVALID_POSIX_PATH', at, 'absolute and backslash paths are forbidden');
    return false;
  }
  const segments = value.replace(/\/+$/u, '').split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    issue(errors, 'INVALID_POSIX_PATH', at, 'empty, dot, and parent segments are forbidden');
    return false;
  }
  return true;
}

function strictJson(filePath, label, errors) {
  if (!fs.existsSync(filePath)) {
    issue(errors, `MISSING_${label}`, normalizeRepoPath(filePath), `${label.toLowerCase().replaceAll('_', ' ')} is required`);
    return null;
  }
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    issue(errors, `UNREADABLE_${label}`, normalizeRepoPath(filePath), error.message);
    return null;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    issue(errors, `INVALID_${label}_JSON`, normalizeRepoPath(filePath), error.message);
    return null;
  }
  try {
    if (text !== canonicalJcs(value)) {
      issue(errors, `NONCANONICAL_${label}`, normalizeRepoPath(filePath), 'file bytes are not exact RFC 8785 JCS');
    }
  } catch (error) {
    issue(errors, `INVALID_${label}_JCS`, normalizeRepoPath(filePath), error.message);
  }
  return value;
}

function readLock(lockPath, errors) {
  if (!fs.existsSync(lockPath)) {
    issue(errors, 'MISSING_REFERENCE_LOCK', normalizeRepoPath(lockPath), 'references.lock.yaml is required');
    return null;
  }
  try {
    const document = YAML.parseDocument(fs.readFileSync(lockPath, 'utf8'), {
      prettyErrors: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      for (const error of document.errors) {
        issue(errors, 'INVALID_REFERENCE_LOCK_YAML', normalizeRepoPath(lockPath), error.message);
      }
      return null;
    }
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    issue(errors, 'INVALID_REFERENCE_LOCK_YAML', normalizeRepoPath(lockPath), error.message);
    return null;
  }
}

function inventoryProjectRoots(rootDir, referenceRoot, errors) {
  const roots = [];
  if (!fs.existsSync(referenceRoot)) {
    issue(errors, 'MISSING_REFERENCE_ROOT', normalizeRepoPath(referenceRoot), 'checked-in reference root is required');
    return roots;
  }
  for (const entry of readDirectoryUtf8(referenceRoot, rootDir, errors)) {
    const entryPath = path.join(referenceRoot, entry.name);
    if (!REFERENCE_CATEGORIES.has(entry.name)) {
      if (STANDALONE_REFERENCE_PROJECTS.has(entry.name)) {
        const projectRel = normalizeRepoPath(path.relative(rootDir, entryPath));
        if (!entry.dirent.isDirectory() || entry.dirent.isSymbolicLink()) {
          issue(errors, 'INVALID_STANDALONE_REFERENCE_PROJECT', projectRel, 'standalone reference project must be a real directory');
        } else {
          roots.push({ absPath: entryPath, rootPath: projectRel });
        }
        continue;
      }
      issue(errors, 'UNEXPECTED_REFERENCE_ROOT_ENTRY', normalizeRepoPath(path.relative(rootDir, entryPath)), 'only phase category directories may occur directly below reference/');
      if (entry.dirent.isDirectory() && !entry.dirent.isSymbolicLink()) {
        roots.push({
          absPath: entryPath,
          rootPath: normalizeRepoPath(path.relative(rootDir, entryPath)),
        });
      }
      continue;
    }
    if (!entry.dirent.isDirectory() || entry.dirent.isSymbolicLink()) {
      issue(errors, 'INVALID_REFERENCE_CATEGORY', normalizeRepoPath(path.relative(rootDir, entryPath)), 'reference category must be a real directory');
      continue;
    }
    for (const project of readDirectoryUtf8(entryPath, rootDir, errors)) {
      const projectPath = path.join(entryPath, project.name);
      const projectRel = normalizeRepoPath(path.relative(rootDir, projectPath));
      if (!project.dirent.isDirectory() || project.dirent.isSymbolicLink()) {
        issue(errors, 'REFERENCE_FILE_OUTSIDE_PROJECT_ROOT', projectRel, 'each category child must be a real project directory');
        continue;
      }
      roots.push({ absPath: projectPath, rootPath: projectRel });
    }
  }
  return roots.sort((a, b) => compareUtf8(a.rootPath, b.rootPath));
}

function inventoryReferenceTree(rootDir, referenceRoot, errors) {
  const files = [];
  const gitRoots = [];
  const normalizedPaths = new Map();

  function walk(directory) {
    const entries = readDirectoryUtf8(directory, rootDir, errors);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.name === '.git') {
        gitRoots.push(directory);
        continue;
      }
      const relative = normalizeRepoPath(path.relative(rootDir, absolute));
      if (entry.name !== entry.name.normalize('NFC')) {
        issue(errors, 'NON_NFC_REFERENCE_PATH', relative, 'reference path is not Unicode NFC');
      }
      const normalized = relative.normalize('NFC');
      if (normalizedPaths.has(normalized) && normalizedPaths.get(normalized) !== relative) {
        issue(errors, 'REFERENCE_PATH_NORMALIZATION_COLLISION', relative, `collides with ${normalizedPaths.get(normalized)}`);
      } else {
        normalizedPaths.set(normalized, relative);
      }
      const stats = fs.lstatSync(absolute, { bigint: true });
      if (stats.isSymbolicLink()) {
        issue(errors, 'REFERENCE_SYMLINK', relative, 'symlinks are forbidden from reference bundle bytes');
      } else if (stats.isDirectory()) {
        walk(absolute);
      } else if (stats.isFile()) {
        if (stats.size > 0xffffffffffffffffn) {
          issue(errors, 'REFERENCE_FILE_TOO_LARGE', relative, 'file size exceeds unsigned 64-bit framing');
        }
        files.push({ absPath: absolute, path: relative, size: stats.size });
      } else {
        issue(errors, 'REFERENCE_NON_REGULAR_FILE', relative, 'only regular files are legal reference bundle members');
      }
    }
  }

  walk(referenceRoot);
  files.sort((a, b) => compareUtf8(a.path, b.path));
  return {
    files,
    gitRoots: [...new Set(gitRoots)].sort((a, b) => compareUtf8(
      normalizeRepoPath(path.relative(rootDir, a)),
      normalizeRepoPath(path.relative(rootDir, b)),
    )),
  };
}

function createBundleContext(rootAbs, files) {
  const hash = crypto.createHash('sha256');
  hash.update(BUNDLE_TAG);
  hash.update(u64be(files.length));
  return { rootAbs, files, hash };
}

function hashInventory(files, contexts, errors) {
  const memberships = new Map();
  for (const context of contexts) {
    for (const file of context.files) {
      const list = memberships.get(file.absPath) || [];
      list.push(context);
      memberships.set(file.absPath, list);
    }
  }

  for (const file of files) {
    const fileHash = crypto.createHash('sha256');
    const active = memberships.get(file.absPath) || [];
    for (const context of active) {
      const relative = normalizeRepoPath(path.relative(context.rootAbs, file.absPath));
      if (!validatePosixPath(relative, file.path, errors)) continue;
      const pathBytes = Buffer.from(relative, 'utf8');
      context.hash.update(u64be(pathBytes.length));
      context.hash.update(pathBytes);
      context.hash.update(u64be(file.size));
    }
    const descriptor = fs.openSync(file.absPath, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
      for (;;) {
        const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (count === 0) break;
        const bytes = buffer.subarray(0, count);
        fileHash.update(bytes);
        for (const context of active) context.hash.update(bytes);
      }
    } finally {
      fs.closeSync(descriptor);
    }
    file.artifactDigest = `sha256:${fileHash.digest('hex')}`;
  }
  for (const context of contexts) context.digest = `sha256:${context.hash.digest('hex')}`;
}

function inspectGit(rootDir, gitRoots, errors) {
  const result = new Map();
  for (const repo of gitRoots) {
    const rel = normalizeRepoPath(path.relative(rootDir, repo));
    // Scope the ownership exception to the exact inventoried repository.  CI
    // and sandbox accounts commonly differ from the checkout owner; relying on
    // a user's global safe.directory list makes closure evidence nondeterministic.
    const gitPrefix = ['-c', `safe.directory=${repo}`, '-C', repo];
    const headResult = spawnSync('git', [...gitPrefix, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      shell: false,
    });
    if (headResult.status !== 0) {
      issue(errors, 'GIT_HEAD_UNREADABLE', rel, (headResult.stderr || headResult.stdout || 'git rev-parse failed').trim());
      continue;
    }
    const head = headResult.stdout.trim();
    if (!COMMIT_RE.test(head)) issue(errors, 'INVALID_GIT_COMMIT', rel, `HEAD is not a full Git object ID: ${head}`);
    const statusResult = spawnSync('git', [...gitPrefix, 'status', '--porcelain=v1', '--untracked-files=all'], {
      encoding: 'utf8',
      shell: false,
    });
    if (statusResult.status !== 0) {
      issue(errors, 'GIT_STATUS_UNREADABLE', rel, (statusResult.stderr || statusResult.stdout || 'git status failed').trim());
      continue;
    }
    const dirty = statusResult.stdout.split(/\r?\n/u).filter(Boolean);
    if (dirty.length > 0) {
      issue(errors, 'DIRTY_REFERENCE_GIT_CHECKOUT', rel, 'reference Git checkout has tracked or untracked changes', dirty);
    }
    result.set(repo, { head, dirty });
  }
  return result;
}

function nearestGitRoot(candidate, gitState) {
  let best = null;
  for (const repo of gitState.keys()) {
    if (isInside(candidate, repo) && (!best || repo.length > best.length)) best = repo;
  }
  return best;
}

function resolveArtifactRef(rootDir, value, at, errors) {
  const validation = validateArtifactRef(value, at);
  for (const message of validation.errors) issue(errors, 'INVALID_ARTIFACT_REF', at, message);
  if (!validation.ok || value.kind !== 'path') return null;
  if (value.root !== 'sourceTree') return null;
  const absolute = path.resolve(rootDir, value.path);
  if (!isInside(absolute, rootDir)) {
    issue(errors, 'ARTIFACT_REF_ESCAPE', at, 'artifact ref escapes source tree');
    return null;
  }
  return absolute;
}

function resolveDigestBoundFile(rootDir, ref, digest, at, errors) {
  const absolute = resolveArtifactRef(rootDir, ref, `${at}Ref`, errors);
  if (!DIGEST_RE.test(digest || '')) {
    issue(errors, 'INVALID_DIGEST', `${at}Digest`, 'expected one lowercase SHA-256 digest');
    return null;
  }
  if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    issue(errors, 'DIGEST_BOUND_ARTIFACT_UNVERIFIABLE', at, 'artifact is not one regular source-tree file');
    return null;
  }
  const actual = fileDigest(absolute);
  if (actual !== digest) {
    issue(errors, 'DIGEST_BOUND_ARTIFACT_MISMATCH', `${at}Digest`, `expected ${actual}`);
    return null;
  }
  return absolute;
}

function buildPdfExecutionPlan(profile, rootDir, at, errors) {
  const before = errors.length;
  requireClosedObject(
    profile,
    [
      'algorithm',
      'domainTag',
      'executionDriverDigest',
      'executionDriverRef',
      'extractorStatus',
      'implementationDigest',
      'implementationRef',
      'networkAccess',
      'pageNumbering',
      'pdfminerVersion',
      'pdfplumberVersion',
      'pythonVersion',
      'runtimeLockDigest',
      'runtimeLockRef',
      'runtimePlatform',
      'runtimeRootEnvironmentVariable',
      'schemaVersion',
      'selectionFraming',
      'selectionNormalization',
    ],
    at,
    errors,
  );
  const exact = {
    algorithm: 'pdfplumber-page-text-framing-v1',
    domainTag: 'axiolune-source-selection-v1\0',
    extractorStatus: 'executable',
    networkAccess: false,
    pageNumbering: 'one-based-inclusive-physical-pages',
    pdfminerVersion: '20251230',
    pdfplumberVersion: '0.11.9',
    pythonVersion: '3.12.13',
    runtimePlatform: 'win32-x64',
    runtimeRootEnvironmentVariable: 'AXIOLUNE_PDF_EXTRACTOR_RUNTIME_DIR',
    schemaVersion: '1.0',
    selectionFraming: 'u64be(page-count)||for-each-page:u64be(page-number)||u64be(utf8-length)||utf8(extract_text-default-or-empty)',
    selectionNormalization: 'none',
  };
  for (const [field, expected] of Object.entries(exact)) {
    if (profile[field] !== expected) {
      issue(
        errors,
        'PDF_EXTRACTOR_PROFILE_CONTRACT_MISMATCH',
        `${at}.${field}`,
        `expected ${JSON.stringify(expected)}`,
      );
    }
  }
  const implementationPath = resolveDigestBoundFile(
    rootDir,
    profile.implementationRef,
    profile.implementationDigest,
    `${at}.implementation`,
    errors,
  );
  const executionDriverPath = resolveDigestBoundFile(
    rootDir,
    profile.executionDriverRef,
    profile.executionDriverDigest,
    `${at}.executionDriver`,
    errors,
  );
  if (executionDriverPath && executionDriverPath !== PDF_RUNTIME_DRIVER) {
    issue(
      errors,
      'PDF_EXTRACTOR_DRIVER_IDENTITY_MISMATCH',
      `${at}.executionDriverRef`,
      'profile must bind the reference-closure PDF runtime driver used by this gate',
    );
  }
  const runtimeLockPath = resolveDigestBoundFile(
    rootDir,
    profile.runtimeLockRef,
    profile.runtimeLockDigest,
    `${at}.runtimeLock`,
    errors,
  );
  let runtimeLock;
  if (runtimeLockPath) {
    try {
      runtimeLock = parseRuntimeLock(fs.readFileSync(runtimeLockPath), `${at}.runtimeLock`);
    } catch (error) {
      issue(errors, 'PDF_EXTRACTOR_RUNTIME_LOCK_INVALID', `${at}.runtimeLock`, error.message);
    }
  }
  if (runtimeLock) {
    resolveDigestBoundFile(
      rootDir,
      runtimeLock.sitePackagesTree.provisionerRef,
      runtimeLock.sitePackagesTree.provisionerDigest,
      `${at}.runtimeLock.sitePackagesProvisioner`,
      errors,
    );
    const versions = new Map(runtimeLock.packages.map((entry) => [entry.distribution, entry.version]));
    if (runtimeLock.python.version !== profile.pythonVersion
        || versions.get('pdfplumber') !== profile.pdfplumberVersion
        || versions.get('pdfminer-six') !== profile.pdfminerVersion) {
      issue(
        errors,
        'PDF_EXTRACTOR_RUNTIME_VERSION_MISMATCH',
        `${at}.runtimeLock`,
        'profile versions do not equal the locked Python distribution versions',
      );
    }
  }
  if (errors.length !== before
      || !implementationPath
      || executionDriverPath !== PDF_RUNTIME_DRIVER
      || !runtimeLock) {
    return null;
  }
  return {
    implementationPath,
    runtimeLock,
    runtimeRoot: resolveRuntimeRoot(rootDir),
  };
}

function classifyLockReference(reference, at, errors) {
  const digest = reference.artifactDigest;
  if (digest === PAYWALLED_SENTINEL) {
    if (reference.localPath !== undefined) {
      issue(errors, 'PAYWALLED_REFERENCE_HAS_LOCAL_BYTES', `${at}.localPath`, 'unavailable paywalled references cannot also claim local bytes');
    }
    if (Array.isArray(reference.locators) && reference.locators.length > 0) {
      issue(errors, 'PAYWALLED_REFERENCE_HAS_LOCATORS', `${at}.locators`, 'unavailable paywalled references require an empty locator list');
    }
    return 'unavailablePaywalled';
  }
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) {
    issue(errors, 'REFERENCE_LOCK_PLACEHOLDER_DIGEST', `${at}.artifactDigest`, 'digest is missing, malformed, or a prohibited placeholder');
  } else if (/^sha256:0{64}$/u.test(digest)) {
    issue(errors, 'REFERENCE_LOCK_PLACEHOLDER_DIGEST', `${at}.artifactDigest`, 'all-zero digest is prohibited');
  }
  return reference.localPath === undefined ? 'remoteSnapshotLocked' : 'localLocked';
}

function validateLock(lock, rootDir, referenceRoot, files, bundleContexts, gitState, errors) {
  const references = new Map();
  const localOwners = new Map();
  const locators = new Map();
  const paywalled = [];
  if (!isPlainObject(lock)) {
    issue(errors, 'INVALID_REFERENCE_LOCK_ROOT', 'references.lock.yaml', 'root must be an object');
    return { references, localOwners, locators, paywalled };
  }
  if (!Array.isArray(lock.references) || lock.references.length === 0) {
    issue(errors, 'INVALID_REFERENCE_LOCK_REFERENCES', 'references.lock.yaml.references', 'expected a non-empty reference list');
    return { references, localOwners, locators, paywalled };
  }

  for (let index = 0; index < lock.references.length; index++) {
    const reference = lock.references[index];
    const at = `references.lock.yaml.references[${index}]`;
    if (!isPlainObject(reference)) {
      issue(errors, 'INVALID_REFERENCE_LOCK_ENTRY', at, 'reference entry must be an object');
      continue;
    }
    validateAsciiId(reference.id, `${at}.id`, errors);
    if (references.has(reference.id)) {
      issue(errors, 'DUPLICATE_REFERENCE_ID', `${at}.id`, `duplicate reference ID ${reference.id}`);
      continue;
    }
    references.set(reference.id, reference);
    const availability = classifyLockReference(reference, at, errors);
    reference._availability = availability;
    if (availability === 'unavailablePaywalled') paywalled.push(reference.id);
    for (const field of ['releaseOrCommit', 'artifactUrl', 'license']) {
      if (typeof reference[field] !== 'string' || reference[field].trim() === '') {
        issue(errors, 'REFERENCE_LOCK_MISSING_METADATA', `${at}.${field}`, 'required reference metadata is missing');
      }
    }
    for (const field of ['maturity', 'usageScope']) {
      if (typeof reference[field] !== 'string' || reference[field].trim() === '') {
        issue(errors, 'REFERENCE_LOCK_MISSING_CLOSURE_METADATA', `${at}.${field}`, 'RFC-001 reference closure requires this field');
      }
    }

    if ('evidenceFiles' in reference) {
      if (!Array.isArray(reference.evidenceFiles)) {
        issue(errors, 'PLAIN_STRING_LOCATOR', `${at}.evidenceFiles`, 'legacy evidenceFiles is not a SourceLocator list');
      } else {
        for (let locatorIndex = 0; locatorIndex < reference.evidenceFiles.length; locatorIndex++) {
          const value = reference.evidenceFiles[locatorIndex];
          issue(
            errors,
            'PLAIN_STRING_LOCATOR',
            `${at}.evidenceFiles[${locatorIndex}]`,
            typeof value === 'string'
              ? 'plain path evidence is forbidden; use the shared SourceLocator union'
              : 'legacy evidenceFiles is forbidden; use locators',
          );
          if (typeof value === 'string') {
            const absolute = path.resolve(rootDir, value);
            if (!isInside(absolute, referenceRoot) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
              issue(errors, 'ORPHAN_LEGACY_EVIDENCE_PATH', `${at}.evidenceFiles[${locatorIndex}]`, `path does not resolve to one regular reference file: ${value}`);
            }
          }
        }
      }
    }

    const locatorList = reference.locators;
    const reviewedContextOnly = reference.usageScope === 'reviewedContextOnly';
    if (reviewedContextOnly && availability !== 'localLocked') {
      issue(
        errors,
        'INVALID_CONTEXT_ONLY_REFERENCE',
        `${at}.usageScope`,
        'reviewedContextOnly is valid only for exact checked-in local provenance',
      );
    }
    if (reviewedContextOnly && Array.isArray(locatorList) && locatorList.length > 0) {
      issue(
        errors,
        'CONTEXT_ONLY_REFERENCE_HAS_LOCATORS',
        `${at}.locators`,
        'reviewedContextOnly provenance must not claim semantic SourceLocators',
      );
    } else if (!reviewedContextOnly
        && availability !== 'unavailablePaywalled'
        && (!Array.isArray(locatorList) || locatorList.length === 0)) {
      issue(errors, 'REFERENCE_LOCK_MISSING_LOCATORS', `${at}.locators`, 'locked references require a non-empty strict SourceLocator list');
    } else if (locatorList !== undefined && !Array.isArray(locatorList)) {
      issue(errors, 'PLAIN_STRING_LOCATOR', `${at}.locators`, 'locators must be an array of SourceLocator objects');
    }
    const referenceLocators = [];
    if (Array.isArray(locatorList)) {
      let previous = null;
      const seen = new Set();
      for (let locatorIndex = 0; locatorIndex < locatorList.length; locatorIndex++) {
        const locator = locatorList[locatorIndex];
        const locatorAt = `${at}.locators[${locatorIndex}]`;
        if (typeof locator === 'string') {
          issue(errors, 'PLAIN_STRING_LOCATOR', locatorAt, 'plain path/string locators are forbidden');
          continue;
        }
        const validation = validateSourceLocator(locator, { at: locatorAt });
        for (const message of validation.errors) issue(errors, 'INVALID_SOURCE_LOCATOR', locatorAt, message);
        let key;
        try {
          key = canonicalJcs(locator);
        } catch (error) {
          issue(errors, 'INVALID_SOURCE_LOCATOR_JCS', locatorAt, error.message);
          continue;
        }
        if (previous !== null && compareUtf8(previous, key) >= 0) {
          issue(errors, 'UNSORTED_OR_DUPLICATE_LOCATORS', locatorAt, 'locator list must be strictly JCS-byte sorted and unique');
        }
        previous = key;
        if (seen.has(key)) issue(errors, 'DUPLICATE_SOURCE_LOCATOR', locatorAt, 'duplicate SourceLocator');
        seen.add(key);
        referenceLocators.push({ locator, key, at: locatorAt });
      }
    }
    locators.set(reference.id, referenceLocators);

    if (availability === 'localLocked') {
      if (!validatePosixPath(normalizeRepoPath(reference.localPath || ''), `${at}.localPath`, errors)) continue;
      const localAbs = path.resolve(rootDir, reference.localPath);
      if (!isInside(localAbs, referenceRoot)) {
        issue(errors, 'REFERENCE_LOCAL_PATH_ESCAPE', `${at}.localPath`, 'localPath must remain under reference/');
        continue;
      }
      if (!fs.existsSync(localAbs)) {
        issue(errors, 'MISSING_LOCKED_REFERENCE_PATH', `${at}.localPath`, 'locked localPath does not exist');
        continue;
      }
      const matchingContext = bundleContexts.find((context) => context.kind === 'lock' && context.referenceId === reference.id);
      if (!matchingContext) {
        issue(errors, 'LOCKED_REFERENCE_HAS_NO_REGULAR_FILES', `${at}.localPath`, 'locked path contains no regular reference files');
      } else if (reference.artifactDigest !== matchingContext.digest) {
        issue(
          errors,
          'REFERENCE_ARTIFACT_DIGEST_MISMATCH',
          `${at}.artifactDigest`,
          `expected deterministic bundle digest ${matchingContext.digest}`,
        );
      }
      const gitRoot = nearestGitRoot(localAbs, gitState);
      if (gitRoot) {
        const state = gitState.get(gitRoot);
        if (reference.releaseOrCommit !== state.head) {
          issue(
            errors,
            'REFERENCE_GIT_COMMIT_MISMATCH',
            `${at}.releaseOrCommit`,
            `expected exact checkout commit ${state.head}, got ${String(reference.releaseOrCommit)}`,
          );
        }
      }
      for (const file of files) {
        if (!isInside(file.absPath, localAbs)) continue;
        const owners = localOwners.get(file.path) || [];
        owners.push(reference.id);
        localOwners.set(file.path, owners);
      }
      for (const locatorRecord of referenceLocators) {
        validateResolvedLocator(locatorRecord, reference, localAbs, rootDir, files, null, errors);
      }
    } else if (availability === 'remoteSnapshotLocked') {
      issue(errors, 'REMOTE_SNAPSHOT_BYTES_UNAVAILABLE', at, 'a non-paywalled digest without checked-in bytes cannot satisfy byte closure');
    }
  }

  for (const file of files) {
    const owners = localOwners.get(file.path) || [];
    if (owners.length > 1) {
      issue(errors, 'AMBIGUOUS_REFERENCE_LOCK_OWNERSHIP', file.path, `file belongs to multiple lock entries: ${owners.join(', ')}`);
    }
  }
  return { references, localOwners, locators, paywalled };
}

function validateCoverageLockOwnership(coverageByPath, lockState, errors) {
  for (const [filePath, row] of coverageByPath.entries()) {
    if (!['usedNormative', 'usedImplementation'].includes(row.disposition)) continue;
    const owners = lockState.localOwners.get(filePath) || [];
    if (owners.length === 0) {
      issue(
        errors,
        'USED_REFERENCE_FILE_NOT_LOCKED',
        filePath,
        'a semantically used reference file must belong to exactly one local reference-lock artifact',
      );
    } else if (owners.some((referenceId) => (
      lockState.references.get(referenceId)?.usageScope === 'reviewedContextOnly'
    ))) {
      issue(
        errors,
        'USED_REFERENCE_FILE_CONTEXT_ONLY_LOCK',
        filePath,
        'a reviewedContextOnly provenance lock cannot own semantically used coverage',
      );
    }
  }
}

function computeWholeFileSelectionDigest(locator, filePath) {
  const withoutDigest = { ...locator };
  delete withoutDigest.selectionDigest;
  const stats = fs.statSync(filePath, { bigint: true });
  const hash = crypto.createHash('sha256');
  hash.update(SELECTION_TAG);
  hash.update(Buffer.from(canonicalJcs(withoutDigest), 'utf8'));
  hash.update(u64be(stats.size));
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return `sha256:${hash.digest('hex')}`;
}

function validateResolvedLocator(record, reference, localAbs, rootDir, files, coverageByPath, errors) {
  const { locator, at } = record;
  let pdfExecutionPlan = null;
  if (!isPlainObject(locator) || typeof locator.path !== 'string') return null;
  const absolute = path.resolve(localAbs, locator.path);
  if (!isInside(absolute, localAbs)) {
    issue(errors, 'SOURCE_LOCATOR_PATH_ESCAPE', `${at}.path`, 'locator path escapes its locked artifact');
    return null;
  }
  const file = files.find((candidate) => candidate.absPath === absolute);
  if (!file) {
    issue(errors, 'ORPHAN_SOURCE_LOCATOR', `${at}.path`, 'locator path does not resolve to one bundled regular file');
    return null;
  }
  if (coverageByPath) {
    const coverage = coverageByPath.get(file.path);
    if (!coverage) {
      issue(errors, 'LOCATOR_FILE_NOT_COVERED', `${at}.path`, 'locator file has no review coverage row');
    } else if (coverage.mediaType !== locator.mediaType) {
      issue(errors, 'LOCATOR_MEDIA_TYPE_MISMATCH', `${at}.mediaType`, `coverage declares ${coverage.mediaType}`);
    }
  }
  if (isPlainObject(locator.extractorProfileRef)) {
    const profilePath = resolveArtifactRef(rootDir, locator.extractorProfileRef, `${at}.extractorProfileRef`, errors);
    if (!profilePath || !fs.existsSync(profilePath) || !fs.statSync(profilePath).isFile()) {
      issue(errors, 'EXTRACTOR_PROFILE_UNVERIFIABLE', `${at}.extractorProfileRef`, 'extractor profile bytes are not a regular source-tree file');
    } else {
      const actualProfileDigest = fileDigest(profilePath);
      if (actualProfileDigest !== locator.extractorProfileDigest) {
        issue(errors, 'EXTRACTOR_PROFILE_DIGEST_MISMATCH', `${at}.extractorProfileDigest`, `expected ${actualProfileDigest}`);
      }
      let profile;
      try {
        profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      } catch (error) {
        issue(errors, 'EXTRACTOR_PROFILE_INVALID_JSON', `${at}.extractorProfileRef`, error.message);
      }
      if (profile) {
        const expectedAlgorithms = {
          wholeFile: 'return-exact-input-bytes',
          textLineRange: 'utf8-line-range-framing-v1',
          xmlElement: 'select-exact-source-byte-span',
          jsonPointer: 'rfc6901-select-then-jcs',
          pdfPageRange: 'pdfplumber-page-text-framing-v1',
          rdfResource: 'rdfxml-about-resource-source-span-v1',
        };
        if (profile.schemaVersion !== '1.0'
            || profile.domainTag !== 'axiolune-source-selection-v1\0'
            || profile.networkAccess !== false) {
          issue(
            errors,
            'EXTRACTOR_PROFILE_CONTRACT_MISMATCH',
            `${at}.extractorProfileRef`,
            'profile must bind schemaVersion 1.0, the selection domain tag, and networkAccess=false',
          );
        }
        if (expectedAlgorithms[locator.kind]
            && profile.algorithm !== expectedAlgorithms[locator.kind]) {
          issue(
            errors,
            'EXTRACTOR_PROFILE_BRANCH_MISMATCH',
            `${at}.extractorProfileRef`,
            `expected algorithm ${expectedAlgorithms[locator.kind]} for ${locator.kind}`,
          );
        }
        if (profile.algorithm === 'rdfxml-about-resource-source-span-v1'
            && locator.mediaType !== 'application/rdf+xml') {
          issue(
            errors,
            'EXTRACTOR_PROFILE_MEDIA_MISMATCH',
            `${at}.mediaType`,
            'the RDF/XML resource selector requires application/rdf+xml',
          );
        }
        const hasImplementationRef = Object.prototype.hasOwnProperty.call(
          profile,
          'implementationRef',
        );
        const hasImplementationDigest = Object.prototype.hasOwnProperty.call(
          profile,
          'implementationDigest',
        );
        if (hasImplementationRef !== hasImplementationDigest) {
          issue(
            errors,
            'EXTRACTOR_IMPLEMENTATION_BINDING_INCOMPLETE',
            `${at}.extractorProfileRef`,
            'implementationRef and implementationDigest must be present together',
          );
        } else if (hasImplementationRef) {
          const implementation = resolveArtifactRef(
            rootDir,
            profile.implementationRef,
            `${at}.extractorProfile.implementationRef`,
            errors,
          );
          if (!isPlainObject(profile.implementationRef)
              || profile.implementationRef.kind !== 'path'
              || profile.implementationRef.root !== 'sourceTree'
              || !DIGEST_RE.test(profile.implementationDigest || '')
              || !implementation
              || !fs.existsSync(implementation)
              || !fs.statSync(implementation).isFile()) {
            issue(
              errors,
              'EXTRACTOR_IMPLEMENTATION_UNVERIFIABLE',
              `${at}.extractorProfile`,
              'implementation must be one digest-locked regular source-tree file',
            );
          } else {
            const implementationDigest = fileDigest(implementation);
            if (implementationDigest !== profile.implementationDigest) {
              issue(
                errors,
                'EXTRACTOR_IMPLEMENTATION_DIGEST_MISMATCH',
                `${at}.extractorProfile.implementationDigest`,
                `expected ${implementationDigest}`,
              );
            }
          }
        }
        if (profile.dependencies !== undefined) {
          if (!Array.isArray(profile.dependencies) || profile.dependencies.length === 0) {
            issue(
              errors,
              'EXTRACTOR_DEPENDENCY_INVENTORY_INVALID',
              `${at}.extractorProfile.dependencies`,
              'dependencies must be a non-empty array when present',
            );
          } else {
            const dependencyKeys = new Set();
            profile.dependencies.forEach((dependency, dependencyIndex) => {
              const dependencyAt = `${at}.extractorProfile.dependencies[${dependencyIndex}]`;
              if (!requireClosedObject(
                dependency,
                ['dependencyDigest', 'dependencyRef', 'role'],
                dependencyAt,
                errors,
              )) return;
              if (typeof dependency.role !== 'string' || dependency.role.trim() === '') {
                issue(errors, 'EXTRACTOR_DEPENDENCY_ROLE_INVALID', `${dependencyAt}.role`, 'role must be non-empty text');
              }
              let dependencyKey;
              try {
                dependencyKey = canonicalJcs(dependency.dependencyRef);
              } catch (error) {
                issue(errors, 'EXTRACTOR_DEPENDENCY_REF_INVALID', `${dependencyAt}.dependencyRef`, error.message);
              }
              if (dependencyKey && dependencyKeys.has(dependencyKey)) {
                issue(errors, 'EXTRACTOR_DEPENDENCY_DUPLICATE', `${dependencyAt}.dependencyRef`, 'dependencyRef must be unique');
              }
              if (dependencyKey) dependencyKeys.add(dependencyKey);
              const dependencyPath = resolveArtifactRef(
                rootDir,
                dependency.dependencyRef,
                `${dependencyAt}.dependencyRef`,
                errors,
              );
              if (!isPlainObject(dependency.dependencyRef)
                  || dependency.dependencyRef.kind !== 'path'
                  || dependency.dependencyRef.root !== 'sourceTree'
                  || !DIGEST_RE.test(dependency.dependencyDigest || '')
                  || !dependencyPath
                  || !fs.existsSync(dependencyPath)
                  || !fs.statSync(dependencyPath).isFile()) {
                issue(
                  errors,
                  'EXTRACTOR_DEPENDENCY_UNVERIFIABLE',
                  dependencyAt,
                  'dependency must be one digest-locked regular source-tree file',
                );
              } else {
                const dependencyDigest = fileDigest(dependencyPath);
                if (dependencyDigest !== dependency.dependencyDigest) {
                  issue(
                    errors,
                    'EXTRACTOR_DEPENDENCY_DIGEST_MISMATCH',
                    `${dependencyAt}.dependencyDigest`,
                    `expected ${dependencyDigest}`,
                  );
                }
              }
            });
          }
        }
        if (locator.kind === 'pdfPageRange') {
          pdfExecutionPlan = buildPdfExecutionPlan(
            profile,
            rootDir,
            `${at}.extractorProfile`,
            errors,
          );
        }
      }
    }
  }
  if (locator.kind === 'wholeFile' && DIGEST_RE.test(locator.selectionDigest || '')) {
    let actual;
    try {
      actual = computeWholeFileSelectionDigest(locator, absolute);
    } catch (error) {
      issue(errors, 'SOURCE_SELECTION_EXECUTION_FAILED', at, error.message);
    }
    if (actual && actual !== locator.selectionDigest) {
      issue(errors, 'SOURCE_SELECTION_DIGEST_MISMATCH', `${at}.selectionDigest`, `expected ${actual}`);
    }
  } else if (locator.kind === 'textLineRange' && DIGEST_RE.test(locator.selectionDigest || '')) {
    let actual;
    try {
      const selected = extractTextLineRangeBytes(
        fs.readFileSync(absolute),
        locator.startLine,
        locator.endLine,
      );
      actual = computeSelectionDigest(locator, selected);
    } catch (error) {
      issue(errors, 'SOURCE_SELECTION_EXECUTION_FAILED', at, error.message);
    }
    if (actual && actual !== locator.selectionDigest) {
      issue(errors, 'SOURCE_SELECTION_DIGEST_MISMATCH', `${at}.selectionDigest`, `expected ${actual}`);
    }
  } else if (locator.kind === 'xmlElement' && DIGEST_RE.test(locator.selectionDigest || '')) {
    let actual;
    try {
      const selected = extractUniqueXmlElementBytes(fs.readFileSync(absolute), locator.elementId);
      actual = computeSelectionDigest(locator, selected);
    } catch (error) {
      issue(errors, 'SOURCE_SELECTION_EXECUTION_FAILED', at, error.message);
    }
    if (actual && actual !== locator.selectionDigest) {
      issue(errors, 'SOURCE_SELECTION_DIGEST_MISMATCH', `${at}.selectionDigest`, `expected ${actual}`);
    }
  } else if (locator.kind === 'jsonPointer' && DIGEST_RE.test(locator.selectionDigest || '')) {
    let actual;
    try {
      const selected = extractJsonPointerJcsBytes(fs.readFileSync(absolute), locator.pointer);
      actual = computeSelectionDigest(locator, selected);
    } catch (error) {
      issue(errors, 'SOURCE_SELECTION_EXECUTION_FAILED', at, error.message);
    }
    if (actual && actual !== locator.selectionDigest) {
      issue(errors, 'SOURCE_SELECTION_DIGEST_MISMATCH', `${at}.selectionDigest`, `expected ${actual}`);
    }
  } else if (locator.kind === 'rdfResource' && DIGEST_RE.test(locator.selectionDigest || '')) {
    let actual;
    try {
      const selected = extractRdfXmlResourceBytes(
        fs.readFileSync(absolute),
        locator.resourceIri,
        locator.graphIri,
      );
      actual = computeSelectionDigest(locator, selected);
    } catch (error) {
      issue(errors, 'SOURCE_SELECTION_EXECUTION_FAILED', at, error.message);
    }
    if (actual && actual !== locator.selectionDigest) {
      issue(errors, 'SOURCE_SELECTION_DIGEST_MISMATCH', `${at}.selectionDigest`, `expected ${actual}`);
    }
  } else if (locator.kind === 'pdfPageRange' && DIGEST_RE.test(locator.selectionDigest || '')) {
    if (!pdfExecutionPlan) {
      issue(
        errors,
        'SOURCE_EXTRACTOR_EXECUTION_UNAVAILABLE',
        at,
        'fail-closed: the PDF page-range extractor profile/runtime is not executable',
      );
    } else {
      let actual;
      try {
        const selected = extractPdfPageRangeBytes({
          implementationPath: pdfExecutionPlan.implementationPath,
          lock: pdfExecutionPlan.runtimeLock,
          runtimeRoot: pdfExecutionPlan.runtimeRoot,
          sourcePath: absolute,
          startPage: locator.startPage,
          endPage: locator.endPage,
        });
        actual = computeSelectionDigest(locator, selected);
      } catch (error) {
        issue(errors, 'SOURCE_SELECTION_EXECUTION_FAILED', at, error.message);
      }
      if (actual && actual !== locator.selectionDigest) {
        issue(errors, 'SOURCE_SELECTION_DIGEST_MISMATCH', `${at}.selectionDigest`, `expected ${actual}`);
      }
    }
  } else if (locator.kind && locator.kind !== 'wholeFile') {
    issue(
      errors,
      'SOURCE_EXTRACTOR_EXECUTION_UNAVAILABLE',
      at,
      `fail-closed: no locked executable extractor was supplied for ${locator.kind}`,
    );
  }
  record.file = file;
  return file;
}

function validateLocatorCoverage(record, coverageByPath, errors) {
  const file = record.file;
  const locator = record.locator;
  if (!file || !isPlainObject(locator)) return;
  const coverage = coverageByPath.get(file.path);
  if (!coverage) {
    issue(errors, 'LOCATOR_FILE_NOT_COVERED', `${record.at}.path`, 'locator file has no review coverage row');
  } else if (coverage.mediaType !== locator.mediaType) {
    issue(
      errors,
      'LOCATOR_MEDIA_TYPE_MISMATCH',
      `${record.at}.mediaType`,
      `coverage declares ${coverage.mediaType}`,
    );
  }
}

function validateCoverage(
  coverage,
  rootDir,
  referenceRoot,
  files,
  projectRoots,
  contexts,
  gitState,
  errors,
) {
  const byPath = new Map();
  if (!coverage) {
    for (const project of projectRoots) {
      issue(errors, 'UNCOVERED_REFERENCE_PROJECT', project.rootPath, 'project has no coverage project row');
    }
    for (const file of files) {
      issue(
        errors,
        'UNCOVERED_REFERENCE_FILE',
        file.path,
        'regular reference file has no file-level review row',
        { artifactDigest: file.artifactDigest },
      );
    }
    return byPath;
  }
  if (!requireClosedObject(coverage, ['schemaVersion', 'referenceRootDigest', 'projects'], 'reference-review-coverage.json', errors)) {
    return byPath;
  }
  if (coverage.schemaVersion !== '1.0') {
    issue(errors, 'INVALID_COVERAGE_SCHEMA_VERSION', 'reference-review-coverage.json.schemaVersion', 'expected 1.0');
  }
  const rootContext = contexts.find((context) => context.kind === 'root');
  if (rootContext && coverage.referenceRootDigest !== rootContext.digest) {
    issue(errors, 'REFERENCE_ROOT_DIGEST_MISMATCH', 'reference-review-coverage.json.referenceRootDigest', `expected ${rootContext.digest}`);
  }
  if (!Array.isArray(coverage.projects) || coverage.projects.length === 0) {
    issue(errors, 'INVALID_COVERAGE_PROJECTS', 'reference-review-coverage.json.projects', 'expected a non-empty project list');
    for (const file of files) {
      issue(
        errors,
        'UNCOVERED_REFERENCE_FILE',
        file.path,
        'regular reference file has no file-level review row',
        { artifactDigest: file.artifactDigest },
      );
    }
    return byPath;
  }
  let previousProjectId = null;
  const coverageRoots = new Set();
  const projectIds = new Set();
  for (let index = 0; index < coverage.projects.length; index++) {
    const project = coverage.projects[index];
    const at = `reference-review-coverage.json.projects[${index}]`;
    const fields = ['projectId', 'rootPath', 'projectDigest', 'files'];
    if (isPlainObject(project) && 'releaseOrCommit' in project) fields.splice(2, 0, 'releaseOrCommit');
    if (!requireClosedObject(project, fields, at, errors)) continue;
    validateAsciiId(project.projectId, `${at}.projectId`, errors);
    validatePosixPath(project.rootPath, `${at}.rootPath`, errors);
    validateDigest(project.projectDigest, `${at}.projectDigest`, errors);
    if (previousProjectId !== null && compareUtf8(previousProjectId, project.projectId) >= 0) {
      issue(errors, 'UNSORTED_OR_DUPLICATE_COVERAGE_PROJECTS', `${at}.projectId`, 'projects must be strictly projectId-byte sorted');
    }
    previousProjectId = project.projectId;
    if (projectIds.has(project.projectId)) issue(errors, 'DUPLICATE_COVERAGE_PROJECT_ID', `${at}.projectId`, 'duplicate projectId');
    projectIds.add(project.projectId);
    coverageRoots.add(project.rootPath);
    const expectedRoot = projectRoots.find((candidate) => candidate.rootPath === project.rootPath);
    if (!expectedRoot) {
      issue(errors, 'ORPHAN_COVERAGE_PROJECT_ROOT', `${at}.rootPath`, 'rootPath is not one immediate checked-in reference project');
    }
    const context = contexts.find((candidate) => candidate.kind === 'project' && candidate.rootPath === project.rootPath);
    if (context && project.projectDigest !== context.digest) {
      issue(errors, 'REFERENCE_PROJECT_DIGEST_MISMATCH', `${at}.projectDigest`, `expected ${context.digest}`);
    }
    if (expectedRoot) {
      const gitRoot = nearestGitRoot(expectedRoot.absPath, gitState);
      if (gitRoot === expectedRoot.absPath) {
        const expectedCommit = gitState.get(gitRoot).head;
        if (project.releaseOrCommit !== expectedCommit) {
          issue(errors, 'COVERAGE_GIT_COMMIT_MISMATCH', `${at}.releaseOrCommit`, `expected exact checkout commit ${expectedCommit}`);
        }
      }
    }
    if (!Array.isArray(project.files) || project.files.length === 0) {
      issue(errors, 'EMPTY_COVERAGE_FILE_LIST', `${at}.files`, 'each project requires a non-empty file list');
      continue;
    }
    let previousPath = null;
    for (let fileIndex = 0; fileIndex < project.files.length; fileIndex++) {
      const row = project.files[fileIndex];
      const rowAt = `${at}.files[${fileIndex}]`;
      if (!requireClosedObject(
        row,
        [
          'path', 'artifactDigest', 'mediaType', 'disposition', 'reviewMethod',
          'rationale', 'reviewerRef', 'reviewRecordRef', 'reviewRecordDigest',
        ],
        rowAt,
        errors,
      )) continue;
      validatePosixPath(row.path, `${rowAt}.path`, errors);
      validateDigest(row.artifactDigest, `${rowAt}.artifactDigest`, errors);
      validateDigest(row.reviewRecordDigest, `${rowAt}.reviewRecordDigest`, errors);
      if (typeof row.mediaType !== 'string' || !MEDIA_TYPE_RE.test(row.mediaType)) {
        issue(errors, 'INVALID_COVERAGE_MEDIA_TYPE', `${rowAt}.mediaType`, 'expected canonical lowercase media type');
      }
      const dispositions = new Set([
        'usedNormative', 'usedImplementation', 'reviewedRejected',
        'reviewedNoBearing', 'binaryInspected', 'pendingSemanticReview',
      ]);
      if (!dispositions.has(row.disposition)) {
        issue(errors, 'INVALID_COVERAGE_DISPOSITION', `${rowAt}.disposition`, 'unknown disposition is forbidden');
      } else if (row.disposition === 'pendingSemanticReview') {
        issue(
          errors,
          'PENDING_SEMANTIC_REVIEW',
          `${rowAt}.disposition`,
          'automated triage is not a digest-bound semantic review decision and cannot close reference coverage',
        );
      }
      if (typeof row.reviewMethod !== 'string' || row.reviewMethod.trim() === '') {
        issue(errors, 'MISSING_REVIEW_METHOD', `${rowAt}.reviewMethod`, 'reviewMethod must be non-empty');
      }
      if (!['usedNormative', 'usedImplementation'].includes(row.disposition)
        && (typeof row.rationale !== 'string' || row.rationale.trim() === '')) {
        issue(errors, 'MISSING_COVERAGE_RATIONALE', `${rowAt}.rationale`, 'non-used disposition requires a rationale');
      }
      if (row.disposition === 'pendingSemanticReview') {
        if (row.reviewerRef !== null) {
          issue(errors, 'INVALID_REVIEWER_REF', `${rowAt}.reviewerRef`, 'pending semantic review must not claim a reviewer');
        }
      } else if ((typeof row.reviewerRef !== 'string' && !isPlainObject(row.reviewerRef))
        || (typeof row.reviewerRef === 'string' && row.reviewerRef.trim() === '')) {
        issue(errors, 'INVALID_REVIEWER_REF', `${rowAt}.reviewerRef`, 'resolved disposition requires a non-empty reviewerRef');
      }
      const reviewPath = resolveArtifactRef(rootDir, row.reviewRecordRef, `${rowAt}.reviewRecordRef`, errors);
      if (!reviewPath || !fs.existsSync(reviewPath) || !fs.statSync(reviewPath).isFile()) {
        issue(errors, 'MISSING_REVIEW_RECORD', `${rowAt}.reviewRecordRef`, 'review record bytes are unavailable');
      } else {
        const actual = fileDigest(reviewPath);
        if (actual !== row.reviewRecordDigest) {
          issue(errors, 'REVIEW_RECORD_DIGEST_MISMATCH', `${rowAt}.reviewRecordDigest`, `expected ${actual}`);
        }
      }
      if (previousPath !== null && compareUtf8(previousPath, row.path) >= 0) {
        issue(errors, 'UNSORTED_OR_DUPLICATE_COVERAGE_FILES', `${rowAt}.path`, 'file rows must be strictly path-byte sorted');
      }
      previousPath = row.path;
      if (byPath.has(row.path)) {
        issue(errors, 'DUPLICATE_COVERAGE_FILE', `${rowAt}.path`, 'file appears more than once in coverage');
      } else {
        byPath.set(row.path, row);
      }
      if (!row.path.startsWith(`${project.rootPath}/`)) {
        issue(errors, 'COVERAGE_FILE_OUTSIDE_PROJECT', `${rowAt}.path`, `file is not below ${project.rootPath}`);
      }
      const actualFile = files.find((candidate) => candidate.path === row.path);
      if (!actualFile) {
        issue(errors, 'ORPHAN_COVERAGE_FILE', `${rowAt}.path`, 'coverage row does not resolve to a regular reference file');
      } else if (actualFile.artifactDigest !== row.artifactDigest) {
        issue(errors, 'REFERENCE_FILE_DIGEST_MISMATCH', `${rowAt}.artifactDigest`, `expected ${actualFile.artifactDigest}`);
      }
    }
  }
  for (const project of projectRoots) {
    if (!coverageRoots.has(project.rootPath)) {
      issue(errors, 'UNCOVERED_REFERENCE_PROJECT', project.rootPath, 'project has no exact coverage project row');
    }
  }
  for (const file of files) {
    if (!byPath.has(file.path)) {
      issue(
        errors,
        'UNCOVERED_REFERENCE_FILE',
        file.path,
        'regular reference file has no file-level review row',
        { artifactDigest: file.artifactDigest },
      );
    }
  }
  return byPath;
}

function validateClosure(
  closure,
  rootDir,
  lockPath,
  referenceRoot,
  rootDigest,
  lockState,
  lockContexts,
  errors,
) {
  const entryById = new Map();
  if (!closure) return entryById;
  if (!requireClosedObject(
    closure,
    [
      'schemaVersion', 'lockSourceRef', 'lockSourceDigest', 'referenceBundleRef',
      'referenceBundleDigest', 'entries',
    ],
    'reference-closure-manifest.json',
    errors,
  )) return entryById;
  if (closure.schemaVersion !== '1.0') {
    issue(errors, 'INVALID_CLOSURE_SCHEMA_VERSION', 'reference-closure-manifest.json.schemaVersion', 'expected 1.0');
  }
  const lockRefPath = resolveArtifactRef(rootDir, closure.lockSourceRef, 'reference-closure-manifest.json.lockSourceRef', errors);
  if (!lockRefPath || path.resolve(lockRefPath) !== path.resolve(lockPath)) {
    issue(errors, 'CLOSURE_LOCK_REF_MISMATCH', 'reference-closure-manifest.json.lockSourceRef', 'must resolve to the authoring references.lock.yaml');
  }
  if (fs.existsSync(lockPath)) {
    const expected = fileDigest(lockPath);
    if (closure.lockSourceDigest !== expected) {
      issue(errors, 'CLOSURE_LOCK_DIGEST_MISMATCH', 'reference-closure-manifest.json.lockSourceDigest', `expected ${expected}`);
    }
  }
  const bundleRefPath = resolveArtifactRef(rootDir, closure.referenceBundleRef, 'reference-closure-manifest.json.referenceBundleRef', errors);
  if (!bundleRefPath || path.resolve(bundleRefPath) !== path.resolve(referenceRoot)) {
    issue(errors, 'CLOSURE_BUNDLE_REF_MISMATCH', 'reference-closure-manifest.json.referenceBundleRef', 'must resolve to checked-in reference/');
  }
  if (closure.referenceBundleDigest !== rootDigest) {
    issue(errors, 'CLOSURE_BUNDLE_DIGEST_MISMATCH', 'reference-closure-manifest.json.referenceBundleDigest', `expected ${rootDigest}`);
  }
  if (!Array.isArray(closure.entries) || closure.entries.length === 0) {
    issue(errors, 'INVALID_CLOSURE_ENTRIES', 'reference-closure-manifest.json.entries', 'expected a non-empty entry list');
    return entryById;
  }
  let previous = null;
  for (let index = 0; index < closure.entries.length; index++) {
    const entry = closure.entries[index];
    const at = `reference-closure-manifest.json.entries[${index}]`;
    if (!isPlainObject(entry)) {
      issue(errors, 'INVALID_CLOSURE_ENTRY', at, 'entry must be a closed object');
      continue;
    }
    const local = entry.availability === 'localLocked' || entry.availability === 'remoteSnapshotLocked';
    const fields = [
      'referenceId', 'availability', 'releaseOrCommit', 'sourceUrl',
      'license', 'maturity', 'usageScope', 'locators',
    ];
    if (local) fields.splice(4, 0, 'artifactRef', 'artifactDigest');
    requireClosedObject(entry, fields, at, errors);
    validateAsciiId(entry.referenceId, `${at}.referenceId`, errors);
    if (previous !== null && compareUtf8(previous, entry.referenceId) >= 0) {
      issue(errors, 'UNSORTED_OR_DUPLICATE_CLOSURE_ENTRIES', `${at}.referenceId`, 'entries must be strictly referenceId-byte sorted');
    }
    previous = entry.referenceId;
    if (entryById.has(entry.referenceId)) {
      issue(errors, 'DUPLICATE_CLOSURE_REFERENCE_ID', `${at}.referenceId`, 'duplicate reference closure entry');
    }
    entryById.set(entry.referenceId, entry);
    const authoring = lockState.references.get(entry.referenceId);
    if (!authoring) {
      issue(errors, 'ORPHAN_CLOSURE_REFERENCE', `${at}.referenceId`, 'closure entry has no authoring lock entry');
      continue;
    }
    if (entry.availability !== authoring._availability) {
      issue(errors, 'CLOSURE_AVAILABILITY_MISMATCH', `${at}.availability`, `expected ${authoring._availability}`);
    }
    const comparisons = [
      ['releaseOrCommit', 'releaseOrCommit'],
      ['sourceUrl', 'artifactUrl'],
      ['license', 'license'],
      ['maturity', 'maturity'],
      ['usageScope', 'usageScope'],
    ];
    for (const [entryField, lockField] of comparisons) {
      if (entry[entryField] !== authoring[lockField]) {
        issue(errors, 'CLOSURE_LOCK_METADATA_MISMATCH', `${at}.${entryField}`, `does not equal references.lock.yaml ${lockField}`);
      }
    }
    if (!Array.isArray(entry.locators)) {
      issue(errors, 'PLAIN_STRING_LOCATOR', `${at}.locators`, 'closure locators must be an array');
    } else {
      const closureKeys = [];
      for (let locatorIndex = 0; locatorIndex < entry.locators.length; locatorIndex++) {
        const locator = entry.locators[locatorIndex];
        if (typeof locator === 'string') {
          issue(errors, 'PLAIN_STRING_LOCATOR', `${at}.locators[${locatorIndex}]`, 'plain path/string locators are forbidden');
          continue;
        }
        const validation = validateSourceLocator(locator, { at: `${at}.locators[${locatorIndex}]` });
        for (const message of validation.errors) issue(errors, 'INVALID_SOURCE_LOCATOR', `${at}.locators[${locatorIndex}]`, message);
        try {
          closureKeys.push(canonicalJcs(locator));
        } catch (error) {
          issue(errors, 'INVALID_SOURCE_LOCATOR_JCS', `${at}.locators[${locatorIndex}]`, error.message);
        }
      }
      const lockKeys = (lockState.locators.get(entry.referenceId) || []).map((record) => record.key);
      if (canonicalJcs(closureKeys) !== canonicalJcs(lockKeys)) {
        issue(errors, 'CLOSURE_LOCATOR_MISMATCH', `${at}.locators`, 'locators are not byte-identical to references.lock.yaml');
      }
    }
    if (entry.availability === 'unavailablePaywalled') {
      if ('artifactRef' in entry || 'artifactDigest' in entry) {
        issue(errors, 'PAYWALLED_CLOSURE_HAS_ARTIFACT', at, 'paywalled closure entries forbid artifactRef/artifactDigest');
      }
      if (!Array.isArray(entry.locators) || entry.locators.length !== 0) {
        issue(errors, 'PAYWALLED_CLOSURE_HAS_LOCATORS', `${at}.locators`, 'paywalled closure entries require an empty locator list');
      }
    } else {
      validateDigest(entry.artifactDigest, `${at}.artifactDigest`, errors);
      const artifactPath = resolveArtifactRef(rootDir, entry.artifactRef, `${at}.artifactRef`, errors);
      if (authoring.localPath) {
        const expectedPath = path.resolve(rootDir, authoring.localPath);
        if (!artifactPath || path.resolve(artifactPath) !== expectedPath) {
          issue(errors, 'CLOSURE_ARTIFACT_REF_MISMATCH', `${at}.artifactRef`, 'artifactRef does not resolve to locked localPath');
        }
        const context = lockContexts.find((candidate) => candidate.referenceId === entry.referenceId);
        if (context && entry.artifactDigest !== context.digest) {
          issue(errors, 'CLOSURE_ARTIFACT_DIGEST_MISMATCH', `${at}.artifactDigest`, `expected ${context.digest}`);
        }
      }
    }
  }
  for (const referenceId of lockState.references.keys()) {
    if (!entryById.has(referenceId)) {
      issue(errors, 'LOCK_REFERENCE_MISSING_FROM_CLOSURE', referenceId, 'authoring lock reference has no closure entry');
    }
  }
  return entryById;
}

function semanticNodeId(node) {
  const fields = SEMANTIC_KEY_FIELDS[node.nodeKind];
  const key = {};
  for (const field of fields) key[field] = node[field];
  return `sha256-${crypto.createHash('sha256')
    .update(TRACE_NODE_TAG)
    .update(Buffer.from(canonicalJcs(key), 'utf8'))
    .digest('hex')}`;
}

function validateNodeScalars(node, at, rootDir, errors) {
  const digestFields = Object.keys(node).filter((field) => field.endsWith('Digest'));
  for (const field of digestFields) validateDigest(node[field], `${at}.${field}`, errors);
  const artifactRefFields = [
    'artifactRef', 'identityManifestRef', 'identityTermRegistryRef',
  ];
  for (const field of artifactRefFields) {
    if (field in node) resolveArtifactRef(rootDir, node[field], `${at}.${field}`, errors);
  }
  for (const field of ['publicIri', 'localPublicIri', 'targetPublicIri']) {
    if (field in node) validateAbsoluteIri(node[field], `${at}.${field}`, errors);
  }
  for (const field of [
    'referenceId', 'targetType', 'constraintInstanceId', 'cqId', 'decisionId', 'outcome',
    'executionIdentity', 'fixtureId', 'gateId', 'checkId',
  ]) {
    if (field in node) validateAsciiId(node[field], `${at}.${field}`, errors);
  }
  for (const field of ['contractRef', 'mappingRef', 'termContractRef', 'controlledSetRef']) {
    if (!(field in node)) continue;
    if (isPlainObject(node[field])) {
      resolveArtifactRef(rootDir, node[field], `${at}.${field}`, errors);
    } else {
      validateAbsoluteIri(node[field], `${at}.${field}`, errors);
    }
  }
}

function validateTraceability(
  trace,
  rootDir,
  files,
  lockState,
  closureEntries,
  coverageByPath,
  errors,
) {
  if (!trace) {
    for (const [referenceId, records] of lockState.locators.entries()) {
      for (const record of records) {
        issue(errors, 'LOCK_LOCATOR_MISSING_FROM_TRACEABILITY', record.at, `reference ${referenceId} has no SourceLocatorNode`);
      }
    }
    return;
  }
  if (!requireClosedObject(
    trace,
    [
      'schemaVersion', 'artifactKind', 'releaseEvidenceEligible',
      'profileRef', 'nodes', 'edges',
    ],
    'reference-support-diagnostics.json',
    errors,
  )) return;
  if (trace.schemaVersion !== '1.0') {
    issue(errors, 'INVALID_TRACE_SCHEMA_VERSION', 'reference-support-diagnostics.json.schemaVersion', 'expected 1.0');
  }
  if (trace.artifactKind !== 'referenceSupportDiagnostics'
      || trace.releaseEvidenceEligible !== false) {
    issue(
      errors,
      'REFERENCE_DIAGNOSTICS_RELEASE_MARKER',
      'reference-support-diagnostics.json',
      'legacy reference support graph must be explicitly marked releaseEvidenceEligible=false',
    );
  }
  resolveArtifactRef(rootDir, trace.profileRef, 'reference-support-diagnostics.json.profileRef', errors);
  if (!Array.isArray(trace.nodes) || !Array.isArray(trace.edges)) {
    issue(errors, 'INVALID_TRACE_ARRAYS', 'reference-support-diagnostics.json', 'nodes and edges must be arrays');
    return;
  }
  const nodes = new Map();
  const semanticKeys = new Map();
  const sourceLocatorCounts = new Map();
  let previousNodeId = null;
  for (let index = 0; index < trace.nodes.length; index++) {
    const node = trace.nodes[index];
    const at = `traceability-manifest.json.nodes[${index}]`;
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(NODE_FIELDS, node.nodeKind)) {
      issue(errors, 'INVALID_TRACE_NODE_KIND', at, 'nodeKind is missing or unsupported');
      continue;
    }
    requireClosedObject(node, NODE_FIELDS[node.nodeKind], at, errors);
    validateAsciiId(node.nodeId, `${at}.nodeId`, errors);
    validateNodeScalars(node, at, rootDir, errors);
    if (previousNodeId !== null && compareUtf8(previousNodeId, node.nodeId) >= 0) {
      issue(errors, 'UNSORTED_OR_DUPLICATE_TRACE_NODES', `${at}.nodeId`, 'nodes must be strictly lowercase nodeId-byte sorted');
    }
    previousNodeId = node.nodeId;
    if (nodes.has(node.nodeId)) issue(errors, 'DUPLICATE_TRACE_NODE_ID', `${at}.nodeId`, 'duplicate nodeId');
    nodes.set(node.nodeId, node);
    try {
      const expected = semanticNodeId(node);
      if (node.nodeId !== expected) {
        issue(errors, 'TRACE_NODE_ID_MISMATCH', `${at}.nodeId`, `expected ${expected}`);
      }
      const semanticKey = canonicalJcs(Object.fromEntries(
        SEMANTIC_KEY_FIELDS[node.nodeKind].map((field) => [field, node[field]]),
      ));
      if (semanticKeys.has(semanticKey)) {
        issue(errors, 'DUPLICATE_TRACE_SEMANTIC_KEY', at, `same semantic key already used by ${semanticKeys.get(semanticKey)}`);
      }
      semanticKeys.set(semanticKey, node.nodeId);
    } catch (error) {
      issue(errors, 'INVALID_TRACE_NODE_JCS', at, error.message);
    }

    if (node.nodeKind !== 'sourceLocator') continue;
    if (typeof node.locator === 'string') {
      issue(errors, 'PLAIN_STRING_LOCATOR', `${at}.locator`, 'SourceLocatorNode locator must be a strict object');
      continue;
    }
    const validation = validateSourceLocator(node.locator, { at: `${at}.locator` });
    for (const message of validation.errors) issue(errors, 'INVALID_SOURCE_LOCATOR', `${at}.locator`, message);
    const reference = lockState.references.get(node.referenceId);
    if (!reference || reference._availability !== 'localLocked') {
      issue(errors, 'ORPHAN_TRACE_SOURCE_LOCATOR', at, 'SourceLocatorNode referenceId does not join one local locked reference');
      continue;
    }
    let locatorKey;
    try {
      locatorKey = canonicalJcs(node.locator);
    } catch {
      continue;
    }
    const lockRecord = (lockState.locators.get(node.referenceId) || []).find((record) => record.key === locatorKey);
    const closureEntry = closureEntries.get(node.referenceId);
    const closureHas = closureEntry
      && Array.isArray(closureEntry.locators)
      && closureEntry.locators.some((locator) => {
        try {
          return canonicalJcs(locator) === locatorKey;
        } catch {
          return false;
        }
      });
    if (!lockRecord || !closureHas) {
      issue(errors, 'ORPHAN_TRACE_SOURCE_LOCATOR', `${at}.locator`, 'locator is not byte-identical in lock and closure manifest');
      continue;
    }
    // The node locator is byte-identical to lockRecord, whose extractor and
    // source file were already validated once at the lock boundary. Reusing
    // that exact resolution prevents one unavailable extractor prerequisite
    // from being counted again merely because the same selector is traced.
    const resolved = lockRecord.file || null;
    if (resolved) {
      const artifactPath = resolveArtifactRef(rootDir, node.artifactRef, `${at}.artifactRef`, errors);
      if (!artifactPath || path.resolve(artifactPath) !== path.resolve(resolved.absPath)) {
        issue(errors, 'TRACE_SOURCE_ARTIFACT_REF_MISMATCH', `${at}.artifactRef`, `must resolve to ${resolved.path}`);
      }
      if (node.artifactDigest !== resolved.artifactDigest) {
        issue(errors, 'TRACE_SOURCE_ARTIFACT_DIGEST_MISMATCH', `${at}.artifactDigest`, `expected ${resolved.artifactDigest}`);
      }
      const row = coverageByPath.get(resolved.path);
      if (row && !['usedNormative', 'usedImplementation'].includes(row.disposition)) {
        issue(errors, 'LOCATOR_FILE_NOT_MARKED_USED', `${at}.locator.path`, `coverage disposition is ${row.disposition}`);
      }
    }
    const countKey = `${node.referenceId}\0${locatorKey}`;
    sourceLocatorCounts.set(countKey, (sourceLocatorCounts.get(countKey) || 0) + 1);
  }

  const outgoing = new Map();
  let previousEdgeKey = null;
  const edgeKeys = new Set();
  for (let index = 0; index < trace.edges.length; index++) {
    const edge = trace.edges[index];
    const at = `traceability-manifest.json.edges[${index}]`;
    if (!requireClosedObject(
      edge,
      ['fromNodeId', 'toNodeId', 'edgeKind', 'assertionScope'],
      at,
      errors,
    )) continue;
    if (!['normative', 'implementation', 'contextOnly'].includes(edge.assertionScope)) {
      issue(errors, 'INVALID_TRACE_ASSERTION_SCOPE', `${at}.assertionScope`, 'expected normative, implementation, or contextOnly');
    }
    const key = [edge.fromNodeId, edge.toNodeId, edge.edgeKind, edge.assertionScope].join('\0');
    if (previousEdgeKey !== null && compareUtf8(previousEdgeKey, key) >= 0) {
      issue(errors, 'UNSORTED_OR_DUPLICATE_TRACE_EDGES', at, 'edges must be strictly tuple-byte sorted');
    }
    previousEdgeKey = key;
    if (edgeKeys.has(key)) issue(errors, 'DUPLICATE_TRACE_EDGE', at, 'duplicate trace edge');
    edgeKeys.add(key);
    if (edge.fromNodeId === edge.toNodeId) issue(errors, 'TRACE_SELF_EDGE', at, 'self edges are forbidden');
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) {
      issue(errors, 'TRACE_EDGE_ORPHAN_ENDPOINT', at, 'both edge endpoints must exist');
      continue;
    }
    if (!EDGE_MATRIX.has(`${from.nodeKind}|${to.nodeKind}|${edge.edgeKind}`)) {
      issue(errors, 'ILLEGAL_TRACE_EDGE', at, `${from.nodeKind} -> ${to.nodeKind} cannot use ${edge.edgeKind}`);
    }
    const list = outgoing.get(edge.fromNodeId) || [];
    list.push(edge);
    outgoing.set(edge.fromNodeId, list);
  }
  for (const node of nodes.values()) {
    if (node.nodeKind === 'sourceLocator' && !(outgoing.get(node.nodeId) || []).some((edge) => edge.edgeKind.startsWith('supports'))) {
      issue(errors, 'ORPHAN_TRACE_SOURCE_LOCATOR', node.nodeId, 'SourceLocatorNode must support at least one semantic node');
    }
  }
  for (const [referenceId, records] of lockState.locators.entries()) {
    for (const record of records) {
      const count = sourceLocatorCounts.get(`${referenceId}\0${record.key}`) || 0;
      if (count !== 1) {
        issue(errors, 'LOCK_LOCATOR_TRACE_CARDINALITY', record.at, `expected exactly one SourceLocatorNode, found ${count}`);
      }
    }
  }
  for (const [filePath, row] of coverageByPath.entries()) {
    if (!['usedNormative', 'usedImplementation'].includes(row.disposition)) continue;
    const used = [...nodes.values()].some((node) => {
      if (node.nodeKind !== 'sourceLocator') return false;
      const reference = lockState.references.get(node.referenceId);
      if (!reference || !isPlainObject(node.locator)) return false;
      return path.resolve(rootDir, reference.localPath, node.locator.path) === path.resolve(rootDir, filePath);
    });
    if (!used) {
      issue(errors, 'USED_COVERAGE_FILE_WITHOUT_TRACE_LOCATOR', filePath, 'used coverage row has no exact SourceLocatorNode');
    }
  }
}

function inspectReferenceBundle(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..', '..', '..'));
  const referenceRoot = path.resolve(rootDir, options.referenceRoot || 'reference');
  const errors = [];
  const projectRoots = inventoryProjectRoots(rootDir, referenceRoot, errors);
  const inventory = inventoryReferenceTree(rootDir, referenceRoot, errors);
  const contexts = [
    Object.assign(createBundleContext(referenceRoot, inventory.files), { kind: 'root' }),
  ];
  for (const project of projectRoots) {
    const projectFiles = inventory.files.filter((file) => isInside(file.absPath, project.absPath));
    contexts.push(Object.assign(createBundleContext(project.absPath, projectFiles), {
      kind: 'project',
      rootPath: project.rootPath,
    }));
  }
  hashInventory(inventory.files, contexts, errors);
  const gitState = inspectGit(rootDir, inventory.gitRoots, errors);
  const rootContext = contexts.find((context) => context.kind === 'root');
  const projects = projectRoots.map((project) => {
    const context = contexts.find(
      (candidate) => candidate.kind === 'project' && candidate.rootPath === project.rootPath,
    );
    const gitRoot = nearestGitRoot(project.absPath, gitState);
    const exactGitRoot = gitRoot === project.absPath ? gitState.get(gitRoot) : null;
    return {
      rootPath: project.rootPath,
      projectDigest: context ? context.digest : null,
      fileCount: context ? context.files.length : 0,
      ...(exactGitRoot ? { releaseOrCommit: exactGitRoot.head } : {}),
    };
  });
  const uniqueErrors = deduplicateIssues(errors);
  uniqueErrors.sort((left, right) => (
    compareUtf8(left.code, right.code)
    || compareUtf8(left.at, right.at)
    || compareUtf8(left.message, right.message)
  ));
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    referenceRootDigest: rootContext ? rootContext.digest : null,
    projects,
    fileCount: inventory.files.length,
    gitCheckoutCount: gitState.size,
  };
}

function validateReferenceClosure(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..', '..', '..'));
  const referenceRoot = path.resolve(rootDir, options.referenceRoot || 'reference');
  const lockPath = path.resolve(rootDir, options.lockPath || 'docs/ontology/references/references.lock.yaml');
  const closurePath = path.resolve(rootDir, options.closurePath || 'docs/ontology/references/reference-closure-manifest.json');
  const coveragePath = path.resolve(rootDir, options.coveragePath || 'docs/ontology/references/reference-review-coverage.json');
  const tracePath = path.resolve(
    rootDir,
    options.tracePath || 'docs/domain/infrastructure/reference-support-diagnostics.json',
  );
  const errors = [];
  const lock = readLock(lockPath, errors);
  const projectRoots = inventoryProjectRoots(rootDir, referenceRoot, errors);
  const inventory = inventoryReferenceTree(rootDir, referenceRoot, errors);

  const contexts = [];
  contexts.push(Object.assign(createBundleContext(referenceRoot, inventory.files), { kind: 'root' }));
  for (const project of projectRoots) {
    const projectFiles = inventory.files.filter((file) => isInside(file.absPath, project.absPath));
    contexts.push(Object.assign(createBundleContext(project.absPath, projectFiles), {
      kind: 'project',
      rootPath: project.rootPath,
    }));
  }
  if (lock && Array.isArray(lock.references)) {
    for (const reference of lock.references) {
      if (!isPlainObject(reference) || typeof reference.localPath !== 'string') continue;
      const localAbs = path.resolve(rootDir, reference.localPath);
      if (!isInside(localAbs, referenceRoot) || !fs.existsSync(localAbs)) continue;
      const localFiles = inventory.files.filter((file) => isInside(file.absPath, localAbs));
      if (localFiles.length === 0) continue;
      contexts.push(Object.assign(createBundleContext(localAbs, localFiles), {
        kind: 'lock',
        referenceId: reference.id,
      }));
    }
  }
  hashInventory(inventory.files, contexts, errors);
  const gitState = inspectGit(rootDir, inventory.gitRoots, errors);
  const lockState = validateLock(
    lock,
    rootDir,
    referenceRoot,
    inventory.files,
    contexts,
    gitState,
    errors,
  );

  const closure = strictJson(closurePath, 'REFERENCE_CLOSURE_MANIFEST', errors);
  const coverage = strictJson(coveragePath, 'REFERENCE_REVIEW_COVERAGE', errors);
  const trace = strictJson(tracePath, 'TRACEABILITY_MANIFEST', errors);
  const coverageByPath = validateCoverage(
    coverage,
    rootDir,
    referenceRoot,
    inventory.files,
    projectRoots,
    contexts,
    gitState,
    errors,
  );
  validateCoverageLockOwnership(coverageByPath, lockState, errors);
  for (const records of lockState.locators.values()) {
    for (const record of records) {
      validateLocatorCoverage(record, coverageByPath, errors);
    }
  }
  const rootContext = contexts.find((context) => context.kind === 'root');
  const closureEntries = validateClosure(
    closure,
    rootDir,
    lockPath,
    referenceRoot,
    rootContext ? rootContext.digest : null,
    lockState,
    contexts.filter((context) => context.kind === 'lock'),
    errors,
  );
  validateTraceability(
    trace,
    rootDir,
    inventory.files,
    lockState,
    closureEntries,
    coverageByPath,
    errors,
  );

  const uniqueErrors = deduplicateIssues(errors);
  uniqueErrors.sort((left, right) => (
    compareUtf8(left.code, right.code)
    || compareUtf8(left.at, right.at)
    || compareUtf8(left.message, right.message)
  ));
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    stats: {
      projectCount: projectRoots.length,
      fileCount: inventory.files.length,
      gitCheckoutCount: gitState.size,
      lockedReferenceCount: lockState.references.size,
      paywalledReferenceCount: lockState.paywalled.length,
      coverageFileCount: coverageByPath.size,
      rootDigest: rootContext ? rootContext.digest : null,
    },
    paywalledReferences: lockState.paywalled.sort(compareUtf8),
  };
}

module.exports = {
  BUNDLE_TAG,
  PAYWALLED_SENTINEL,
  computeWholeFileSelectionDigest,
  fileDigest,
  inspectReferenceBundle,
  semanticNodeId,
  sha256,
  u64be,
  validateReferenceClosure,
};
