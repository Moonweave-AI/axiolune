'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const PHASE_REGISTRY_TAG = 'axiolune-artifact-phase-registry-v1\0';
const ROOT_DISCOVERY_CAPABILITY_TAG = 'axiolune-payload-root-discovery-capability-v1\0';
const DEPENDENCY_EXTRACTOR_CAPABILITY_TAG = 'axiolune-artifact-dependency-extractor-capability-v1\0';
const IMPLEMENTATION_PATH = 'scripts/domain/lib/m2-payload-independent-replay.cjs';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const ASCII_ID_RE = /^[A-Za-z][A-Za-z0-9._-]*$/u;

class ReplayError extends Error {
  constructor(code, message, pathRef = '', kind = 'invalid') {
    super(message);
    this.name = 'ReplayError';
    this.code = code;
    this.path = pathRef;
    this.kind = kind;
  }
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function taggedJcsDigest(tag, value) {
  return sha256(Buffer.concat([
    Buffer.from(tag, 'utf8'),
    Buffer.from(canonicalJcs(value), 'utf8'),
  ]));
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function artifactKey(reference, digest) {
  return `${canonicalJcs(reference)}\0${digest}`;
}

function artifactId(node) {
  return taggedJcsDigest('axiolune-artifact-dependency-node-v1\0', {
    artifactRef: node.artifactRef,
    artifactDigest: node.artifactDigest,
    artifactKind: node.artifactKind,
  });
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort(compareUtf8))
      === canonicalJcs([...expected].sort(compareUtf8));
}

function requireCanonicalRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC')
      || value.startsWith('/') || value.includes('\\')
      || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_SOURCE_PATH', `${label} is not a canonical UTF-8 NFC POSIX relative path`, label);
  }
  return value;
}

function requireCanonicalPathPrefix(value, label) {
  if (typeof value !== 'string' || !value.endsWith('/') || value.length < 2) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_SOURCE_PATH', `${label} must be a non-root canonical directory prefix ending in /`, label);
  }
  requireCanonicalRelativePath(value.slice(0, -1), label);
  return value;
}

function requireSourceTreeRef(reference, label) {
  if (!exactKeys(reference, ['kind', 'root', 'path'])
      || reference.kind !== 'path' || reference.root !== 'sourceTree') {
    throw new ReplayError('M2_PAYLOAD_REPLAY_SOURCE_REF', `${label} must be a closed sourceTree path ref`, label);
  }
  requireCanonicalRelativePath(reference.path, `${label}/path`);
  return reference.path;
}

function parseStrictJcs(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
      throw new Error('bytes are not exact UTF-8 RFC 8785 JCS');
    }
    return value;
  } catch (cause) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_POLICY_JCS', `${label}: ${cause.message}`, label);
  }
}

function trustedFileBytes(trustedRoot, relativePath) {
  const root = path.resolve(trustedRoot);
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_TRUSTED_PATH', `${relativePath} escapes or aliases the trusted source root`, relativePath);
  }
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (cause) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_TRUSTED_SOURCE_MISSING', `${relativePath}: ${cause.message}`, relativePath, 'missing');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_TRUSTED_SOURCE_TYPE', `${relativePath} is not a trusted regular non-symlink file`, relativePath);
  }
  return fs.readFileSync(absolute);
}

function sourceBytes(options, relativePath, label) {
  const source = options.sourceArtifacts instanceof Map
    ? options.sourceArtifacts.get(relativePath) : null;
  if (!Buffer.isBuffer(source)) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_P1_SOURCE_MISSING', `${label} is absent from the reconstructed P1 Git tree`, relativePath, 'missing');
  }
  let trusted = null;
  if (options.trustedSourceArtifacts instanceof Map) {
    trusted = options.trustedSourceArtifacts.get(relativePath);
  } else if (typeof options.trustedRoot === 'string' && options.trustedRoot.length > 0) {
    trusted = trustedFileBytes(options.trustedRoot, relativePath);
  }
  if (!Buffer.isBuffer(trusted)) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_TRUSTED_SOURCE_REQUIRED', `${label} has no independently trusted implementation/policy bytes`, relativePath, 'unverified');
  }
  if (!source.equals(trusted)) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_P1_TRUSTED_DRIFT', `${label} differs between reconstructed P1 and the trusted verifier workspace`, relativePath);
  }
  return source;
}

function loadPolicy(options, reference, digest, domainTag, label) {
  if (!DIGEST_RE.test(digest)) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_POLICY_DIGEST', `${label} digest is invalid`, label);
  }
  const relativePath = requireSourceTreeRef(reference, label);
  const bytes = sourceBytes(options, relativePath, label);
  const value = parseStrictJcs(bytes, label);
  if (taggedJcsDigest(domainTag, value) !== digest) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_POLICY_DIGEST', `${label} semantic digest differs from the reconstructed trusted bytes`, label);
  }
  return { relativePath, bytes, value };
}

function validateImplementationBinding(options, capability, label) {
  const implementationPath = requireSourceTreeRef(capability.implementationRef, `${label}/implementationRef`);
  if (implementationPath !== IMPLEMENTATION_PATH) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_IMPLEMENTATION_REF', `${label} must bind the reviewed independent replay implementation`, `${label}/implementationRef`);
  }
  const bytes = sourceBytes(options, implementationPath, `${label} implementation`);
  if (!DIGEST_RE.test(capability.implementationDigest)
      || sha256(bytes) !== capability.implementationDigest) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_IMPLEMENTATION_DIGEST', `${label} implementation digest differs from reconstructed trusted source bytes`, `${label}/implementationDigest`);
  }
}

function validatePhaseRegistry(options) {
  const loaded = loadPolicy(
    options,
    options.phaseRegistryRef,
    options.phaseRegistryDigest,
    PHASE_REGISTRY_TAG,
    'phaseRegistry',
  );
  const registry = loaded.value;
  if (!exactKeys(registry, ['schemaVersion', 'phases', 'artifactKinds'])
      || registry.schemaVersion !== '1.0'
      || canonicalJcs(registry.phases) !== canonicalJcs(options.phases)
      || !Array.isArray(registry.artifactKinds) || registry.artifactKinds.length === 0) {
    throw new ReplayError('M2_PAYLOAD_REPLAY_PHASE_REGISTRY_SCHEMA', 'phase registry differs from the closed phase sequence/schema', loaded.relativePath);
  }
  const byKind = new Map();
  let previous = null;
  for (let index = 0; index < registry.artifactKinds.length; index += 1) {
    const row = registry.artifactKinds[index];
    const at = `${loaded.relativePath}/artifactKinds/${index}`;
    if (!exactKeys(row, ['artifactKind', 'phase', 'finalizationOrdinal'])
        || !ASCII_ID_RE.test(row.artifactKind)
        || !options.phases.includes(row.phase)
        || !Number.isSafeInteger(row.finalizationOrdinal)
        || row.finalizationOrdinal < 0) {
      throw new ReplayError('M2_PAYLOAD_REPLAY_PHASE_REGISTRY_ROW', 'phase-registry row is not closed and valid', at);
    }
    if ((previous !== null && compareUtf8(previous, row.artifactKind) >= 0)
        || byKind.has(row.artifactKind)) {
      throw new ReplayError('M2_PAYLOAD_REPLAY_PHASE_REGISTRY_ORDER', 'artifact kinds are not strictly UTF-8 sorted and unique', at);
    }
    previous = row.artifactKind;
    byKind.set(row.artifactKind, row);
  }
  return { ...loaded, byKind };
}

function validateSelector(selector, at) {
  if (!exactKeys(selector, ['selectorId', 'sourceRoot', 'matchKind', 'path'])) {
    throw new ReplayError('M2_PAYLOAD_ROOT_DISCOVERY_SELECTOR_SCHEMA', 'root-discovery selector is not closed', at);
  }
  if (!ASCII_ID_RE.test(selector.selectorId)
      || !['payload', 'sourceTree'].includes(selector.sourceRoot)
      || !['exactPath', 'pathPrefix'].includes(selector.matchKind)) {
    throw new ReplayError('M2_PAYLOAD_ROOT_DISCOVERY_SELECTOR_SCHEMA', 'root-discovery selector identity/source/match kind is invalid', at);
  }
  if (selector.matchKind === 'pathPrefix') {
    requireCanonicalPathPrefix(selector.path, `${at}/path`);
  } else {
    requireCanonicalRelativePath(selector.path, `${at}/path`);
  }
}

function matchesSelector(relativePath, selector) {
  return selector.matchKind === 'exactPath'
    ? relativePath === selector.path : relativePath.startsWith(selector.path);
}

function replayRootDiscovery(options) {
  const discovered = [];
  const seenPairs = new Set();
  const capabilities = [];
  for (let index = 0; index < options.rootRecords.length; index += 1) {
    const root = options.rootRecords[index];
    const loaded = loadPolicy(
      options,
      root.row.discoveryCapabilityRef,
      root.row.discoveryCapabilityDigest,
      ROOT_DISCOVERY_CAPABILITY_TAG,
      `requiredRoots/${root.row.rootKind}/discoveryCapability`,
    );
    const capability = loaded.value;
    if (!exactKeys(capability, [
      'schemaVersion', 'capabilityId', 'rootKind', 'implementationRef',
      'implementationDigest', 'inputContract', 'selectors',
    ]) || capability.schemaVersion !== '1.0'
        || !ASCII_ID_RE.test(capability.capabilityId)
        || capability.rootKind !== root.row.rootKind
        || capability.inputContract !== 'reconstructed-p1-source-tree-and-exact-payload-bytes-v1'
        || !Array.isArray(capability.selectors) || capability.selectors.length === 0) {
      throw new ReplayError('M2_PAYLOAD_ROOT_DISCOVERY_CAPABILITY_SCHEMA', 'root-discovery capability differs from its closed executable contract', loaded.relativePath);
    }
    validateImplementationBinding(options, capability, `root discovery ${root.row.rootKind}`);
    let previousSelector = null;
    const rootPairs = [];
    const rootPairKeys = new Set();
    for (let selectorIndex = 0; selectorIndex < capability.selectors.length; selectorIndex += 1) {
      const selector = capability.selectors[selectorIndex];
      const at = `${loaded.relativePath}/selectors/${selectorIndex}`;
      validateSelector(selector, at);
      if (previousSelector !== null && compareUtf8(previousSelector, selector.selectorId) >= 0) {
        throw new ReplayError('M2_PAYLOAD_ROOT_DISCOVERY_SELECTOR_ORDER', 'root-discovery selectors are not strictly selectorId-sorted and unique', at);
      }
      previousSelector = selector.selectorId;
      const source = selector.sourceRoot === 'payload'
        ? options.payloadArtifacts : options.sourceArtifacts;
      const matches = [...source.entries()]
        .filter(([relativePath, bytes]) => Buffer.isBuffer(bytes)
          && matchesSelector(relativePath, selector))
        .sort(([left], [right]) => compareUtf8(left, right));
      if (matches.length === 0) {
        throw new ReplayError('M2_PAYLOAD_ROOT_DISCOVERY_EMPTY_SELECTOR', `selector ${selector.selectorId} discovered no artifacts`, at, 'missing');
      }
      for (const [relativePath, bytes] of matches) {
        const pair = {
          artifactRef: { kind: 'path', root: selector.sourceRoot, path: relativePath },
          artifactDigest: sha256(bytes),
        };
        const key = artifactKey(pair.artifactRef, pair.artifactDigest);
        if (rootPairKeys.has(key)) {
          throw new ReplayError('M2_PAYLOAD_ROOT_DISCOVERY_SELECTOR_OVERLAP', `selectors discover ${relativePath} more than once`, at);
        }
        rootPairKeys.add(key);
        rootPairs.push(pair);
      }
    }
    rootPairs.sort((left, right) => compareUtf8(
      artifactKey(left.artifactRef, left.artifactDigest),
      artifactKey(right.artifactRef, right.artifactDigest),
    ));
    if (canonicalJcs(root.manifest.artifacts) !== canonicalJcs(rootPairs)) {
      throw new ReplayError('M2_PAYLOAD_ROOT_DISCOVERY_MISMATCH', `independent ${root.row.rootKind} discovery differs from the authored root manifest`, root.file);
    }
    for (const pair of rootPairs) seenPairs.add(artifactKey(pair.artifactRef, pair.artifactDigest));
    discovered.push({ rootKind: root.row.rootKind, artifacts: rootPairs });
    capabilities.push({
      rootKind: root.row.rootKind,
      capabilityRef: root.row.discoveryCapabilityRef,
      capabilityDigest: root.row.discoveryCapabilityDigest,
      discoveredArtifactCount: rootPairs.length,
    });
  }
  return {
    rootKindCount: discovered.length,
    distinctDiscoveredArtifactCount: seenPairs.size,
    roots: discovered,
    capabilities,
  };
}

function resolveJsonPointer(value, pointer) {
  if (pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
    throw new ReplayError('M2_PAYLOAD_DEPENDENCY_JSON_POINTER', 'JSON Pointer is not canonical', pointer);
  }
  let cursor = value;
  for (const tokenText of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/u.test(tokenText)) {
      throw new ReplayError('M2_PAYLOAD_DEPENDENCY_JSON_POINTER', 'JSON Pointer has an invalid escape', pointer);
    }
    const token = tokenText.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(token) || Number(token) >= cursor.length) {
        throw new ReplayError('M2_PAYLOAD_DEPENDENCY_JSON_POINTER', 'JSON Pointer array index is not canonical/in range', pointer);
      }
      cursor = cursor[Number(token)];
    } else if (cursor && typeof cursor === 'object' && Object.hasOwn(cursor, token)) {
      cursor = cursor[token];
    } else {
      throw new ReplayError('M2_PAYLOAD_DEPENDENCY_JSON_POINTER', 'JSON Pointer does not resolve', pointer);
    }
  }
  return cursor;
}

function escapePointerToken(value) {
  return String(value).replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function isArtifactRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.kind !== 'string') return false;
  if (value.kind === 'path') {
    return typeof value.root === 'string' && typeof value.path === 'string';
  }
  return value.kind === 'iri' && typeof value.iri === 'string';
}

function isArtifactPair(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && isArtifactRef(value.artifactRef) && DIGEST_RE.test(value.artifactDigest);
}

function collectDependencies(value) {
  const found = [];
  const visit = (cursor, pointer, membershipName = null) => {
    if (!cursor || typeof cursor !== 'object') return;
    if (Array.isArray(cursor)) {
      cursor.forEach((entry, index) => visit(entry, `${pointer}/${index}`, membershipName));
      return;
    }
    const membershipPair = membershipName && isArtifactPair(cursor);
    if (membershipPair) {
      if (!/^[\x21-\x7e]+$/u.test(membershipName)) {
        throw new ReplayError('M2_PAYLOAD_DEPENDENCY_MEMBERSHIP_LOCATOR', 'manifest-membership locator is not non-empty printable ASCII', pointer);
      }
      found.push({
        pair: { artifactRef: cursor.artifactRef, artifactDigest: cursor.artifactDigest },
        locator: { locatorKind: 'manifestMembership', value: membershipName },
      });
    }
    const keys = Object.keys(cursor).sort(compareUtf8);
    for (const key of keys) {
      if (membershipPair && ['artifactRef', 'artifactDigest'].includes(key)) continue;
      if (key.endsWith('Ref') && key !== 'artifactRef') {
        const digestKey = `${key.slice(0, -3)}Digest`;
        if (Object.hasOwn(cursor, digestKey)
            && isArtifactRef(cursor[key]) && DIGEST_RE.test(cursor[digestKey])) {
          found.push({
            pair: { artifactRef: cursor[key], artifactDigest: cursor[digestKey] },
            locator: { locatorKind: 'jsonPointer', value: `${pointer}/${escapePointerToken(key)}` },
          });
        }
      }
      const child = cursor[key];
      const nextMembership = Array.isArray(child) ? key : null;
      visit(child, `${pointer}/${escapePointerToken(key)}`, nextMembership);
    }
  };
  visit(value, '', null);
  const unique = new Map();
  for (const row of found) {
    const key = `${artifactKey(row.pair.artifactRef, row.pair.artifactDigest)}\0${canonicalJcs(row.locator)}`;
    unique.set(key, row);
  }
  return [...unique.values()].sort((left, right) => compareUtf8(
    `${artifactKey(left.pair.artifactRef, left.pair.artifactDigest)}\0${canonicalJcs(left.locator)}`,
    `${artifactKey(right.pair.artifactRef, right.pair.artifactDigest)}\0${canonicalJcs(right.locator)}`,
  ));
}

function validateClassificationRule(rule, at) {
  if (!exactKeys(rule, ['ruleId', 'match', 'artifactKind'])
      || !ASCII_ID_RE.test(rule.ruleId) || !ASCII_ID_RE.test(rule.artifactKind)
      || !rule.match || typeof rule.match !== 'object' || Array.isArray(rule.match)) {
    throw new ReplayError('M2_PAYLOAD_DEPENDENCY_CLASSIFIER_SCHEMA', 'classification rule is not closed and valid', at);
  }
  if (rule.match.kind === 'digestDomainTag') {
    if (!exactKeys(rule.match, ['kind', 'value'])
        || typeof rule.match.value !== 'string'
        || !/^[\x20-\x7e]*\0$/u.test(rule.match.value)
        || rule.match.value.slice(0, -1).includes('\0')) {
      throw new ReplayError('M2_PAYLOAD_DEPENDENCY_CLASSIFIER_SCHEMA', 'digest-domain classifier is invalid', `${at}/match`);
    }
  } else if (['pathExact', 'pathPrefix'].includes(rule.match.kind)) {
    if (!exactKeys(rule.match, ['kind', 'root', 'value'])
        || !['payload', 'sourceTree', 'buildEvidence'].includes(rule.match.root)) {
      throw new ReplayError('M2_PAYLOAD_DEPENDENCY_CLASSIFIER_SCHEMA', 'path classifier is invalid', `${at}/match`);
    }
    if (rule.match.kind === 'pathPrefix') {
      requireCanonicalPathPrefix(rule.match.value, `${at}/match/value`);
    } else {
      requireCanonicalRelativePath(rule.match.value, `${at}/match/value`);
    }
  } else if (rule.match.kind === 'jcsFieldEquals') {
    if (!exactKeys(rule.match, ['kind', 'pointer', 'value'])
        || typeof rule.match.pointer !== 'string' || !rule.match.pointer.startsWith('/')
        || rule.match.pointer.split('/').slice(1).some((token) => /~(?:[^01]|$)/u.test(token))) {
      throw new ReplayError('M2_PAYLOAD_DEPENDENCY_CLASSIFIER_SCHEMA', 'JCS-field classifier is invalid', `${at}/match`);
    }
  } else {
    throw new ReplayError('M2_PAYLOAD_DEPENDENCY_CLASSIFIER_SCHEMA', `unsupported classifier ${String(rule.match.kind)}`, `${at}/match/kind`);
  }
}

function ruleMatches(rule, resolved) {
  const match = rule.match;
  if (match.kind === 'digestDomainTag') return resolved.domainTag === match.value;
  if (['pathExact', 'pathPrefix'].includes(match.kind)) {
    if (resolved.pair.artifactRef?.kind !== 'path'
        || resolved.pair.artifactRef.root !== match.root) return false;
    return match.kind === 'pathExact'
      ? resolved.pair.artifactRef.path === match.value
      : resolved.pair.artifactRef.path.startsWith(match.value);
  }
  if (match.kind === 'jcsFieldEquals') {
    if (resolved.semanticValue === null) return false;
    try {
      return canonicalJcs(resolveJsonPointer(resolved.semanticValue, match.pointer))
        === canonicalJcs(match.value);
    } catch {
      return false;
    }
  }
  return false;
}

function parseMaybeJcs(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return bytes.equals(Buffer.from(canonicalJcs(value), 'utf8')) ? value : null;
  } catch {
    return null;
  }
}

function replayDependencyExtraction(options) {
  const expectedScope = options.scope || 'payload';
  const expectedRootPolicy = options.rootPolicy
    || 'nine-required-root-manifests-plus-catalog-v1';
  const phaseRegistry = validatePhaseRegistry(options);
  const loaded = loadPolicy(
    options,
    options.extractorCapabilityRef,
    options.extractorCapabilityDigest,
    DEPENDENCY_EXTRACTOR_CAPABILITY_TAG,
    'dependencyExtractorCapability',
  );
  const capability = loaded.value;
  if (!exactKeys(capability, [
    'schemaVersion', 'capabilityId', 'scope', 'implementationRef',
    'implementationDigest', 'rootPolicy', 'dependencyPolicy', 'classificationRules',
  ]) || capability.schemaVersion !== '1.0'
      || !ASCII_ID_RE.test(capability.capabilityId)
      || capability.scope !== expectedScope
      || capability.rootPolicy !== expectedRootPolicy
      || capability.dependencyPolicy !== 'recursive-artifact-ref-digest-pairs-v1'
      || !Array.isArray(capability.classificationRules)
      || capability.classificationRules.length === 0) {
    throw new ReplayError('M2_PAYLOAD_DEPENDENCY_EXTRACTOR_SCHEMA', 'dependency extractor capability differs from its closed executable contract', loaded.relativePath);
  }
  validateImplementationBinding(options, capability, 'dependency extractor');
  let previousRule = null;
  for (let index = 0; index < capability.classificationRules.length; index += 1) {
    const rule = capability.classificationRules[index];
    const at = `${loaded.relativePath}/classificationRules/${index}`;
    validateClassificationRule(rule, at);
    if (previousRule !== null && compareUtf8(previousRule, rule.ruleId) >= 0) {
      throw new ReplayError('M2_PAYLOAD_DEPENDENCY_CLASSIFIER_ORDER', 'classification rules are not strictly ruleId-sorted and unique', at);
    }
    previousRule = rule.ruleId;
    if (!phaseRegistry.byKind.has(rule.artifactKind)) {
      throw new ReplayError('M2_PAYLOAD_DEPENDENCY_CLASSIFIER_KIND', `classifier names unregistered artifact kind ${rule.artifactKind}`, `${at}/artifactKind`);
    }
  }

  const p1EntryByPath = new Map((options.payloadEntries || []).map((row) => [row.path, row]));
  const catalogByPair = options.catalogByPair instanceof Map
    ? options.catalogByPair : new Map();
  const rootsByPair = new Map((options.rootRecords || []).map((root) => [
    artifactKey(root.row.rootManifestRef, root.row.rootManifestDigest), root,
  ]));
  const catalogPairKey = options.catalogRef && options.catalogDigest
    ? artifactKey(options.catalogRef, options.catalogDigest) : null;
  const excludedManifestKey = artifactKey(options.dependencyManifestRef, options.dependencyManifestDigest);
  const excludedArtifactKeys = new Set([
    excludedManifestKey,
    ...(Array.isArray(options.excludedArtifactPairs)
      ? options.excludedArtifactPairs.map((pair) => artifactKey(
        pair.artifactRef,
        pair.artifactDigest,
      )) : []),
  ]);

  const selectCatalogValue = (row) => {
    const locator = row.locator;
    const bytes = options.payloadArtifacts.get(locator.path);
    if (!Buffer.isBuffer(bytes)) {
      throw new ReplayError('M2_PAYLOAD_DEPENDENCY_RESOLUTION_MISSING', `catalog locator ${String(locator.path)} is absent`, String(locator.path), 'missing');
    }
    if (locator.kind === 'wholeFile') {
      return { bytes, value: parseMaybeJcs(bytes) };
    }
    if (locator.kind === 'jsonValue') {
      const parsed = parseStrictJcs(bytes, locator.path);
      const value = resolveJsonPointer(parsed, locator.pointer);
      return { bytes: Buffer.from(canonicalJcs(value), 'utf8'), value };
    }
    throw new ReplayError(
      'M2_PAYLOAD_DEPENDENCY_RESOLUTION_PROFILE',
      `dependency extraction cannot consume unresolved ${String(locator.kind)} catalog selections`,
      String(locator.path),
      'unverified',
    );
  };

  const resolvePair = (pair) => {
    const key = artifactKey(pair.artifactRef, pair.artifactDigest);
    const root = rootsByPair.get(key);
    if (root) {
      return {
        pair,
        semanticValue: root.manifest,
        domainTag: `axiolune-payload-required-root-${root.row.rootKind}-v1\0`,
        specialKind: `requiredRoot-${root.row.rootKind}`,
        skipDependencies: false,
      };
    }
    if (catalogPairKey !== null && key === catalogPairKey) {
      return {
        pair,
        semanticValue: options.catalog,
        domainTag: 'axiolune-payload-artifact-catalog-v1\0',
        specialKind: 'payloadArtifactCatalog',
        skipDependencies: true,
      };
    }
    const catalogRow = catalogByPair.get(key);
    if (catalogRow) {
      const selected = selectCatalogValue(catalogRow);
      return {
        pair,
        semanticValue: selected.value,
        domainTag: catalogRow.digestProfile?.kind === 'taggedJcs'
          ? catalogRow.digestProfile.domainTag : null,
        specialKind: null,
        skipDependencies: false,
      };
    }
    if (pair.artifactRef?.kind === 'path'
        && ['payload', 'sourceTree'].includes(pair.artifactRef.root)) {
      const source = pair.artifactRef.root === 'payload'
        ? options.payloadArtifacts : options.sourceArtifacts;
      const bytes = source.get(pair.artifactRef.path);
      if (Buffer.isBuffer(bytes) && sha256(bytes) === pair.artifactDigest) {
        if (pair.artifactRef.root === 'payload') {
          const entry = p1EntryByPath.get(pair.artifactRef.path);
          if (!entry || entry.payloadByteDigest !== pair.artifactDigest) {
            throw new ReplayError('M2_PAYLOAD_DEPENDENCY_RAW_ENTRY', 'direct raw payload dependency is not bound by the P1 entry', pair.artifactRef.path);
          }
        }
        return {
          pair,
          semanticValue: parseMaybeJcs(bytes),
          domainTag: null,
          specialKind: null,
          skipDependencies: false,
        };
      }
    }
    throw new ReplayError('M2_PAYLOAD_DEPENDENCY_RESOLUTION_MISSING', 'dependency ref/digest pair has no independent offline resolution', key, 'missing');
  };

  const classify = (resolved) => {
    if (resolved.specialKind) return resolved.specialKind;
    const matches = capability.classificationRules.filter((rule) => ruleMatches(rule, resolved));
    if (matches.length !== 1) {
      throw new ReplayError(
        'M2_PAYLOAD_DEPENDENCY_CLASSIFICATION',
        `artifact must match exactly one trusted classification rule; observed ${matches.length}`,
        artifactKey(resolved.pair.artifactRef, resolved.pair.artifactDigest),
        matches.length === 0 ? 'missing' : 'invalid',
      );
    }
    return matches[0].artifactKind;
  };

  const roots = Array.isArray(options.rootPairs)
    ? options.rootPairs.map((pair) => structuredClone(pair))
    : (options.rootRecords || []).map((root) => ({
      artifactRef: root.row.rootManifestRef,
      artifactDigest: root.row.rootManifestDigest,
    }));
  if (!Array.isArray(options.rootPairs) && catalogPairKey !== null) {
    roots.push({ artifactRef: options.catalogRef, artifactDigest: options.catalogDigest });
  }
  if (roots.length === 0) {
    throw new ReplayError('M2_PAYLOAD_DEPENDENCY_ROOTS_EMPTY', 'independent dependency extraction requires a non-empty fixed root set', '/roots', 'missing');
  }
  const queue = [...roots];
  const nodesByPair = new Map();
  const edgesByKey = new Map();
  while (queue.length > 0) {
    const pair = queue.shift();
    const pairKey = artifactKey(pair.artifactRef, pair.artifactDigest);
    if (excludedArtifactKeys.has(pairKey)) {
      throw new ReplayError('M2_PAYLOAD_DEPENDENCY_SELF_INCLUDED', 'a scope-excluded artifact cannot be discovered as a dependency node', pairKey);
    }
    if (nodesByPair.has(pairKey)) continue;
    const resolved = resolvePair(pair);
    const artifactKind = classify(resolved);
    const phase = phaseRegistry.byKind.get(artifactKind);
    if (!phase) {
      throw new ReplayError('M2_PAYLOAD_DEPENDENCY_PHASE_KIND', `artifact kind ${artifactKind} is absent from the phase registry`, pairKey, 'missing');
    }
    const node = {
      artifactId: '',
      artifactRef: pair.artifactRef,
      artifactDigest: pair.artifactDigest,
      artifactKind,
      phase: phase.phase,
      finalizationOrdinal: phase.finalizationOrdinal,
    };
    node.artifactId = artifactId(node);
    nodesByPair.set(pairKey, { node, resolved });
    if (resolved.skipDependencies || resolved.semanticValue === null) continue;
    for (const dependency of collectDependencies(resolved.semanticValue)) {
      const prerequisiteKey = artifactKey(
        dependency.pair.artifactRef,
        dependency.pair.artifactDigest,
      );
      if (prerequisiteKey === pairKey) {
        throw new ReplayError('M2_PAYLOAD_DEPENDENCY_SELF_EDGE', 'artifact bytes contain a direct self dependency', pairKey);
      }
      queue.push(dependency.pair);
      const edgeKey = `${pairKey}\0${prerequisiteKey}\0${canonicalJcs(dependency.locator)}`;
      edgesByKey.set(edgeKey, { dependentPairKey: pairKey, prerequisitePairKey: prerequisiteKey, locator: dependency.locator });
    }
  }

  const nodes = [...nodesByPair.values()].map(({ node }) => node)
    .sort((left, right) => compareUtf8(left.artifactId, right.artifactId));
  const idByPair = new Map([...nodesByPair.entries()].map(([key, row]) => [key, row.node.artifactId]));
  const edges = [...edgesByKey.values()].map((edge) => {
    const prerequisiteArtifactId = idByPair.get(edge.prerequisitePairKey);
    const dependentArtifactId = idByPair.get(edge.dependentPairKey);
    if (!prerequisiteArtifactId || !dependentArtifactId) {
      throw new ReplayError('M2_PAYLOAD_DEPENDENCY_EDGE_ENDPOINT', 'independent dependency extraction produced an unresolved endpoint');
    }
    return { prerequisiteArtifactId, dependentArtifactId, locator: edge.locator };
  }).sort((left, right) => compareUtf8(
    `${left.dependentArtifactId}\0${left.prerequisiteArtifactId}\0${left.locator.locatorKind}\0${left.locator.value}`,
    `${right.dependentArtifactId}\0${right.prerequisiteArtifactId}\0${right.locator.locatorKind}\0${right.locator.value}`,
  ));
  const rootIds = roots.map((pair) => idByPair.get(artifactKey(pair.artifactRef, pair.artifactDigest)))
    .sort(compareUtf8);
  return {
    roots: rootIds,
    nodes,
    edges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    phaseRegistryRef: options.phaseRegistryRef,
    phaseRegistryDigest: options.phaseRegistryDigest,
    extractorCapabilityRef: options.extractorCapabilityRef,
    extractorCapabilityDigest: options.extractorCapabilityDigest,
    callerGraphAccepted: false,
  };
}

module.exports = {
  DEPENDENCY_EXTRACTOR_CAPABILITY_TAG,
  IMPLEMENTATION_PATH,
  PHASE_REGISTRY_TAG,
  ROOT_DISCOVERY_CAPABILITY_TAG,
  ReplayError,
  artifactId,
  replayDependencyExtraction,
  replayRootDiscovery,
  sha256,
  taggedJcsDigest,
};
