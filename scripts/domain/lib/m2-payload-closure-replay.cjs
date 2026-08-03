'use strict';

const crypto = require('node:crypto');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const { computeTaggedNamedGraphDigest } = require('./rdfc-1.0.cjs');
const {
  ReplayError,
  replayDependencyExtraction,
  replayRootDiscovery,
} = require('./m2-payload-independent-replay.cjs');

const PHASES = Object.freeze([
  'static', 'p0Build', 'p0Verification', 'promotionAuthorization',
  'p1TreeCommit', 'p0p1Link', 'p1Build', 'payload',
  'payloadVerification', 'approvalEligibility', 'adoptionAttemptChallenge',
  'releaseApproval', 'adoptionRefUpdate', 'adoptedCheckout', 'adoptionCheck',
  'adoptionFailureEvidence', 'rollbackRefUpdate', 'adoptionVerification',
]);

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function taggedJcsDigest(tag, value) {
  return sha256(Buffer.concat([
    Buffer.from(tag, 'utf8'),
    Buffer.from(canonicalJcs(value), 'utf8'),
  ]));
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
    && canonicalJcs(Object.keys(value).sort()) === canonicalJcs([...expected].sort());
}

function canonicalRelativePath(value) {
  return typeof value === 'string' && value.length > 0
    && value === value.normalize('NFC') && !value.startsWith('/')
    && !value.includes('\\')
    && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function absoluteIri(value) {
  if (typeof value !== 'string' || value.length === 0
      || value !== value.normalize('NFC') || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol) && parsed.href === value;
  } catch {
    return false;
  }
}

function validArtifactRef(value) {
  if (value?.kind === 'iri') {
    return exactKeys(value, ['kind', 'iri']) && absoluteIri(value.iri);
  }
  if (value?.kind === 'path') {
    return exactKeys(value, ['kind', 'root', 'path'])
      && ['sourceTree', 'buildEvidence', 'payload', 'adoptionEvidence'].includes(value.root)
      && canonicalRelativePath(value.path);
  }
  return false;
}

function terminalNulDomainTag(value) {
  return typeof value === 'string' && value.length > 1
    && /^[\x20-\x7e]+\0$/u.test(value) && !value.slice(0, -1).includes('\0');
}

function validMediaType(value) {
  return typeof value === 'string'
    && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value);
}

function validateCatalogRowSchema(row, at, issues) {
  if (!exactKeys(row, [
    'artifactRef', 'artifactDigest', 'payloadByteDigest', 'mediaType', 'locator',
    'digestProfile',
  ]) || !/^sha256:[0-9a-f]{64}$/u.test(row?.artifactDigest)
      || !/^sha256:[0-9a-f]{64}$/u.test(row?.payloadByteDigest)
      || !validArtifactRef(row?.artifactRef) || !validMediaType(row?.mediaType)) {
    issues.push({ code: 'M2_PAYLOAD_CATALOG_ENTRY_SCHEMA', path: at, message: 'catalog entry differs from the closed ref/digest/media/locator/profile schema' });
    return false;
  }
  const locator = row.locator;
  let locatorValid = false;
  if (locator?.kind === 'wholeFile') {
    locatorValid = exactKeys(locator, ['kind', 'path', 'byteLength'])
      && canonicalRelativePath(locator.path)
      && Number.isSafeInteger(locator.byteLength) && locator.byteLength >= 0;
  } else if (locator?.kind === 'jsonValue') {
    locatorValid = exactKeys(locator, ['kind', 'path', 'pointer', 'canonicalization'])
      && canonicalRelativePath(locator.path)
      && typeof locator.pointer === 'string'
      && (locator.pointer === '' || locator.pointer.startsWith('/'))
      && locator.canonicalization === 'RFC8785-JCS';
  } else if (locator?.kind === 'rdfNamedGraph') {
    locatorValid = exactKeys(locator, ['kind', 'path', 'graphIri', 'canonicalization'])
      && canonicalRelativePath(locator.path) && absoluteIri(locator.graphIri)
      && locator.canonicalization === 'RDFC-1.0';
  } else if (locator?.kind === 'archiveMember') {
    locatorValid = exactKeys(locator, [
      'kind', 'path', 'memberPath', 'containerDigest', 'memberByteLength',
    ]) && canonicalRelativePath(locator.path) && canonicalRelativePath(locator.memberPath)
      && /^sha256:[0-9a-f]{64}$/u.test(locator.containerDigest)
      && Number.isSafeInteger(locator.memberByteLength) && locator.memberByteLength >= 0;
  }
  if (!locatorValid) {
    issues.push({ code: 'M2_PAYLOAD_CATALOG_LOCATOR_SCHEMA', path: `${at}/locator`, message: 'catalog locator differs from the closed locator union' });
    return false;
  }
  const profile = row.digestProfile;
  let profileValid = false;
  if (profile?.kind === 'rawBytes') {
    profileValid = exactKeys(profile, ['kind', 'algorithm']) && profile.algorithm === 'sha256';
  } else if (profile?.kind === 'taggedJcs') {
    profileValid = exactKeys(profile, ['kind', 'domainTag', 'canonicalization'])
      && terminalNulDomainTag(profile.domainTag)
      && profile.canonicalization === 'RFC8785-JCS'
      && ['wholeFile', 'jsonValue'].includes(locator.kind);
  } else if (profile?.kind === 'taggedRdf') {
    profileValid = exactKeys(profile, ['kind', 'domainTag', 'canonicalization'])
      && terminalNulDomainTag(profile.domainTag)
      && profile.canonicalization === 'RDFC-1.0'
      && locator.kind === 'rdfNamedGraph';
  } else if (profile?.kind === 'lockedFraming') {
    profileValid = exactKeys(profile, [
      'kind', 'profileRef', 'profileDigest', 'capabilityRef', 'capabilityDigest',
    ]) && /^sha256:[0-9a-f]{64}$/u.test(profile.profileDigest)
      && /^sha256:[0-9a-f]{64}$/u.test(profile.capabilityDigest);
  }
  if (!profileValid) {
    issues.push({ code: 'M2_PAYLOAD_CATALOG_DIGEST_PROFILE_SCHEMA', path: `${at}/digestProfile`, message: 'catalog digest profile differs from the closed profile union or is incompatible with its locator' });
    return false;
  }
  return true;
}

function parseStrictJcs(artifacts, relativePath, code, issues) {
  const bytes = artifacts.get(relativePath);
  if (!bytes) {
    issues.push({ code: `${code}_MISSING`, path: relativePath, message: `${relativePath} is missing`, kind: 'missing' });
    return null;
  }
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
      throw new Error('bytes are not exact UTF-8 RFC 8785 JCS');
    }
    return value;
  } catch (cause) {
    issues.push({ code, path: relativePath, message: cause.message });
    return null;
  }
}

function payloadPath(reference, label, issues) {
  if (!reference || reference.kind !== 'path' || reference.root !== 'payload'
      || typeof reference.path !== 'string') {
    issues.push({ code: 'M2_PAYLOAD_CLOSURE_FIXED_REF', path: label, message: `${label} must be a payload path ref` });
    return null;
  }
  return reference.path;
}

function resolveJsonPointer(value, pointer) {
  if (pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
    throw new Error('JSON Pointer is not canonical');
  }
  let cursor = value;
  for (const tokenText of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/u.test(tokenText)) throw new Error('JSON Pointer has an invalid escape');
    const token = tokenText.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(token)) throw new Error('JSON Pointer array index is not canonical');
      cursor = cursor[Number(token)];
    } else if (cursor && typeof cursor === 'object' && Object.hasOwn(cursor, token)) {
      cursor = cursor[token];
    } else {
      throw new Error('JSON Pointer does not resolve');
    }
  }
  return cursor;
}

function validateRootManifests(p1, artifacts, issues) {
  const roots = [];
  for (const row of Array.isArray(p1.requiredRoots) ? p1.requiredRoots : []) {
    const file = payloadPath(row.rootManifestRef, `/requiredRoots/${row.rootKind}`, issues);
    if (!file) continue;
    const manifest = parseStrictJcs(artifacts, file, 'M2_REQUIRED_ROOT_MANIFEST_JCS', issues);
    if (!manifest) continue;
    if (!exactKeys(manifest, ['schemaVersion', 'rootKind', 'artifacts'])
        || manifest.schemaVersion !== '1.0'
        || manifest.rootKind !== row.rootKind
        || !Array.isArray(manifest.artifacts)
        || manifest.artifacts.length === 0) {
      issues.push({ code: 'M2_REQUIRED_ROOT_MANIFEST_SCHEMA', path: file, message: 'required-root manifest differs from the closed schema/identity' });
      continue;
    }
    const digest = taggedJcsDigest(
      `axiolune-payload-required-root-${row.rootKind}-v1\0`,
      manifest,
    );
    if (digest !== row.rootManifestDigest) {
      issues.push({ code: 'M2_REQUIRED_ROOT_MANIFEST_DIGEST', path: file, message: 'required-root manifest digest differs from P1 binding' });
    }
    let previous = null;
    const keys = new Set();
    for (const artifact of manifest.artifacts) {
      if (!exactKeys(artifact, ['artifactRef', 'artifactDigest'])
          || !validArtifactRef(artifact.artifactRef)
          || !/^sha256:[0-9a-f]{64}$/u.test(artifact.artifactDigest)) {
        issues.push({ code: 'M2_REQUIRED_ROOT_MANIFEST_SCHEMA', path: file, message: 'required-root artifact row is not closed' });
        continue;
      }
      const key = artifactKey(artifact.artifactRef, artifact.artifactDigest);
      if ((previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(key)) >= 0)
          || keys.has(key)) {
        issues.push({ code: 'M2_REQUIRED_ROOT_MANIFEST_ORDER', path: file, message: 'required-root artifacts are not strictly sorted and unique' });
      }
      previous = key;
      keys.add(key);
    }
    roots.push({ row, manifest, file });
  }
  return roots;
}

function validateCatalog(p1, artifacts, payloadEntries, issues) {
  const file = payloadPath(p1.payloadArtifactCatalogRef, '/payloadArtifactCatalogRef', issues);
  if (!file) return null;
  const catalog = parseStrictJcs(artifacts, file, 'M2_PAYLOAD_CATALOG_JCS', issues);
  if (!catalog) return null;
  if (!exactKeys(catalog, ['schemaVersion', 'targetVersion', 'entries'])
      || catalog.schemaVersion !== '1.0'
      || catalog.targetVersion !== p1.targetVersion
      || !Array.isArray(catalog.entries)) {
    issues.push({ code: 'M2_PAYLOAD_CATALOG_SCHEMA', path: file, message: 'payload catalog differs from the closed schema/identity' });
    return null;
  }
  if (taggedJcsDigest('axiolune-payload-artifact-catalog-v1\0', catalog)
      !== p1.payloadArtifactCatalogDigest) {
    issues.push({ code: 'M2_PAYLOAD_CATALOG_DIGEST', path: file, message: 'payload catalog digest differs from P1 binding' });
  }
  const p1Entries = new Map(payloadEntries.map((row) => [row.path, row]));
  const byArtifact = new Map();
  let previous = null;
  for (let index = 0; index < catalog.entries.length; index += 1) {
    const row = catalog.entries[index];
    const rowAt = `${file}/entries/${index}`;
    if (!validateCatalogRowSchema(row, rowAt, issues)) continue;
    const key = artifactKey(row?.artifactRef, row?.artifactDigest);
    if (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(key)) >= 0) {
      issues.push({ code: 'M2_PAYLOAD_CATALOG_ORDER', path: `${file}/entries/${index}`, message: 'catalog entries are not strictly sorted and unique' });
    }
    previous = key;
    if (byArtifact.has(key)) {
      issues.push({ code: 'M2_PAYLOAD_CATALOG_ALIAS', path: `${file}/entries/${index}`, message: 'catalog artifact pair is duplicated' });
    }
    byArtifact.set(key, row);
    const locatorPath = row?.locator?.path;
    const bytes = typeof locatorPath === 'string' ? artifacts.get(locatorPath) : null;
    if (!bytes || !p1Entries.has(locatorPath)) {
      issues.push({ code: 'M2_PAYLOAD_CATALOG_LOCATOR', path: `${file}/entries/${index}/locator`, message: 'catalog locator is not one P1 payload entry', kind: bytes ? 'invalid' : 'missing' });
      continue;
    }
    if (sha256(bytes) !== row.payloadByteDigest
        || p1Entries.get(locatorPath).payloadByteDigest !== row.payloadByteDigest) {
      issues.push({ code: 'M2_PAYLOAD_CATALOG_BYTE_DIGEST', path: locatorPath, message: 'catalog payloadByteDigest differs from exact payload bytes/P1 entry' });
    }
    if (row.locator.kind === 'wholeFile' && row.locator.byteLength !== bytes.length) {
      issues.push({ code: 'M2_PAYLOAD_CATALOG_BYTE_LENGTH', path: `${rowAt}/locator/byteLength`, message: 'whole-file byteLength differs from exact payload bytes' });
    }
    if (row.locator.kind === 'archiveMember'
        && row.locator.containerDigest !== row.payloadByteDigest) {
      issues.push({ code: 'M2_PAYLOAD_CATALOG_CONTAINER_DIGEST', path: `${rowAt}/locator/containerDigest`, message: 'archive containerDigest differs from payloadByteDigest' });
    }
    try {
      let semanticDigest = null;
      let selectedBytes = null;
      let selectedValue = null;
      if (row.locator.kind === 'wholeFile') {
        selectedBytes = bytes;
      } else if (row.locator.kind === 'jsonValue') {
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (!bytes.equals(Buffer.from(canonicalJcs(parsed), 'utf8'))) {
          throw new Error('jsonValue locator file is not strict JCS');
        }
        selectedValue = resolveJsonPointer(parsed, row.locator.pointer);
        selectedBytes = Buffer.from(canonicalJcs(selectedValue), 'utf8');
      } else if (row.locator.kind === 'rdfNamedGraph') {
        if (row.mediaType !== 'application/n-quads') {
          issues.push({
            code: 'M2_PAYLOAD_CATALOG_DIGEST_PROFILE_REPLAY_REQUIRED',
            path: `${rowAt}/mediaType`,
            message: `RDFC named-graph replay currently requires locked application/n-quads bytes; found ${row.mediaType}`,
            kind: 'unverified',
          });
        } else if (row.digestProfile.kind === 'taggedRdf') {
          semanticDigest = computeTaggedNamedGraphDigest(
            bytes.toString('utf8'),
            row.locator.graphIri,
            row.digestProfile.domainTag,
          ).digest;
        }
      } else if (row.locator.kind === 'archiveMember') {
        issues.push({
          code: 'M2_PAYLOAD_CATALOG_DIGEST_PROFILE_REPLAY_REQUIRED',
          path: `${rowAt}/locator`,
          message: 'archiveMember requires a separately locked deterministic archive verifier before release eligibility',
          kind: 'unverified',
        });
      }
      if (row.digestProfile.kind === 'rawBytes' && selectedBytes) {
        semanticDigest = sha256(selectedBytes);
      } else if (row.digestProfile.kind === 'taggedJcs' && selectedBytes) {
        if (selectedValue === null) {
          selectedValue = JSON.parse(selectedBytes.toString('utf8'));
          if (!selectedBytes.equals(Buffer.from(canonicalJcs(selectedValue), 'utf8'))) {
            throw new Error('taggedJcs whole-file locator is not strict JCS');
          }
        }
        semanticDigest = taggedJcsDigest(row.digestProfile.domainTag, selectedValue);
      } else if (row.digestProfile.kind === 'lockedFraming') {
        issues.push({
          code: 'M2_PAYLOAD_CATALOG_DIGEST_PROFILE_REPLAY_REQUIRED',
          path: `${rowAt}/digestProfile`,
          message: 'lockedFraming requires invocation of its bound profile/capability implementation',
          kind: 'unverified',
        });
      } else if (row.digestProfile.kind === 'taggedRdf' && row.locator.kind !== 'rdfNamedGraph') {
        throw new Error('taggedRdf is not paired with rdfNamedGraph');
      } else {
        // taggedRdf/rdfNamedGraph is computed above. Unsupported selection
        // branches already emitted an explicit unverified issue.
      }
      if (semanticDigest && semanticDigest !== row.artifactDigest) {
        issues.push({ code: 'M2_PAYLOAD_CATALOG_SEMANTIC_DIGEST', path: `${file}/entries/${index}`, message: 'catalog semantic digest replay differs' });
      }
    } catch (cause) {
      issues.push({ code: 'M2_PAYLOAD_CATALOG_SEMANTIC_DIGEST', path: `${file}/entries/${index}`, message: cause.message });
    }
  }
  return { catalog, file, byArtifact };
}

function validateDependencyManifest(p1, artifacts, expectedRootPairs, catalogInfo, issues) {
  const file = payloadPath(
    p1.payloadArtifactDependencyManifestRef,
    '/payloadArtifactDependencyManifestRef',
    issues,
  );
  if (!file) return null;
  const manifest = parseStrictJcs(artifacts, file, 'M2_PAYLOAD_DEPENDENCY_JCS', issues);
  if (!manifest) return null;
  if (!exactKeys(
    manifest,
    [
      'schemaVersion', 'scope', 'phaseRegistryRef', 'phaseRegistryDigest',
      'extractorCapabilityRef', 'extractorCapabilityDigest', 'roots', 'nodes', 'edges',
    ],
  ) || manifest.schemaVersion !== '1.0' || manifest.scope !== 'payload'
      || !Array.isArray(manifest.roots) || !Array.isArray(manifest.nodes)
      || !Array.isArray(manifest.edges)) {
    issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_SCHEMA', path: file, message: 'payload dependency manifest differs from the closed payload schema' });
    return null;
  }
  if (taggedJcsDigest('axiolune-artifact-dependency-manifest-v1\0', manifest)
      !== p1.payloadArtifactDependencyManifestDigest) {
    issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_DIGEST', path: file, message: 'payload dependency manifest digest differs from P1 binding' });
  }
  const byId = new Map();
  const byPair = new Map();
  let previousNode = null;
  for (const node of manifest.nodes) {
    if (!exactKeys(node, [
      'artifactId', 'artifactRef', 'artifactDigest', 'artifactKind', 'phase',
      'finalizationOrdinal',
    ]) || !/^sha256:[0-9a-f]{64}$/u.test(node.artifactId)
        || !validArtifactRef(node.artifactRef)
        || !/^sha256:[0-9a-f]{64}$/u.test(node.artifactDigest)
        || typeof node.artifactKind !== 'string'
        || !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(node.artifactKind)) {
      issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_NODE_SCHEMA', path: file, message: 'dependency node is not closed' });
      continue;
    }
    if (node.artifactId !== artifactId(node)) {
      issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_NODE_ID', path: node.artifactId, message: 'dependency node artifactId does not recompute' });
    }
    if (previousNode !== null
        && Buffer.compare(Buffer.from(previousNode), Buffer.from(node.artifactId)) >= 0) {
      issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_NODE_ORDER', path: node.artifactId, message: 'dependency nodes are not strictly artifactId-sorted and unique' });
    }
    previousNode = node.artifactId;
    if (byId.has(node.artifactId)) {
      issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_NODE_ID_ALIAS', path: node.artifactId, message: 'dependency node artifactId is duplicated' });
    }
    byId.set(node.artifactId, node);
    const pair = artifactKey(node.artifactRef, node.artifactDigest);
    if (byPair.has(pair)) {
      issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_NODE_ALIAS', path: node.artifactId, message: 'artifact ref/digest pair has multiple dependency nodes' });
    }
    byPair.set(pair, node);
    if (!PHASES.includes(node.phase)
        || !Number.isSafeInteger(node.finalizationOrdinal)
        || node.finalizationOrdinal < 0) {
      issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_PHASE', path: node.artifactId, message: 'dependency node phase/ordinal is invalid' });
    }
  }
  const expectedRootIds = [];
  for (const pair of expectedRootPairs) {
    const node = byPair.get(artifactKey(pair.artifactRef, pair.artifactDigest));
    if (!node) {
      issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_ROOT_NODE', path: file, message: 'one required root/catalog pair has no dependency node' });
    } else {
      expectedRootIds.push(node.artifactId);
    }
  }
  expectedRootIds.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (manifest.roots.some((id) => !/^sha256:[0-9a-f]{64}$/u.test(id))) {
    issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_ROOT_ID', path: `${file}/roots`, message: 'dependency roots contain a non-Digest artifactId' });
  }
  if (canonicalJcs(manifest.roots) !== canonicalJcs(expectedRootIds)) {
    issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_ROOT_SET', path: `${file}/roots`, message: 'roots do not equal the nine root manifests plus catalog' });
  }
  const incoming = new Map([...byId.keys()].map((id) => [id, []]));
  const edgeKeys = new Set();
  let previousEdge = null;
  for (let edgeIndex = 0; edgeIndex < manifest.edges.length; edgeIndex += 1) {
    const edge = manifest.edges[edgeIndex];
    const edgeAt = `${file}/edges/${edgeIndex}`;
    if (!exactKeys(edge, ['prerequisiteArtifactId', 'dependentArtifactId', 'locator'])
        || !exactKeys(edge.locator, ['locatorKind', 'value'])
        || !/^sha256:[0-9a-f]{64}$/u.test(edge.prerequisiteArtifactId)
        || !/^sha256:[0-9a-f]{64}$/u.test(edge.dependentArtifactId)) {
      issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_EDGE_SCHEMA', path: edgeAt, message: 'dependency edge is not closed' });
      continue;
    }
    if (!['jsonPointer', 'rdfPredicate', 'manifestMembership', 'derivedInput'].includes(edge.locator.locatorKind)
        || typeof edge.locator.value !== 'string' || edge.locator.value.length === 0) {
      issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_EDGE_LOCATOR', path: `${edgeAt}/locator`, message: 'dependency edge locator is outside the closed locator union' });
      continue;
    }
    const edgeKey = `${edge.dependentArtifactId}\0${edge.prerequisiteArtifactId}\0${edge.locator.locatorKind}\0${edge.locator.value}`;
    if ((previousEdge !== null && Buffer.compare(Buffer.from(previousEdge), Buffer.from(edgeKey)) >= 0)
        || edgeKeys.has(edgeKey)) {
      issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_EDGE_ORDER', path: edgeAt, message: 'dependency edges are not strictly dependent/prerequisite/locator-sorted and unique' });
    }
    previousEdge = edgeKey;
    edgeKeys.add(edgeKey);
    const prerequisite = byId.get(edge.prerequisiteArtifactId);
    const dependent = byId.get(edge.dependentArtifactId);
    if (!prerequisite || !dependent || prerequisite === dependent) {
      issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_EDGE_ENDPOINT', path: edgeAt, message: 'dependency edge has a missing/self endpoint' });
      continue;
    }
    incoming.get(dependent.artifactId).push(prerequisite.artifactId);
    const before = PHASES.indexOf(prerequisite.phase) < PHASES.indexOf(dependent.phase)
      || (prerequisite.phase === dependent.phase
        && prerequisite.finalizationOrdinal < dependent.finalizationOrdinal);
    if (!before) {
      issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_BACK_EDGE', path: dependent.artifactId, message: 'dependency edge is not strictly forward in phase/ordinal order' });
    }
    const catalogNode = byPair.get(artifactKey(
      p1.payloadArtifactCatalogRef,
      p1.payloadArtifactCatalogDigest,
    ));
    if (catalogNode && dependent.artifactId === catalogNode.artifactId
        && edge.locator.locatorKind === 'manifestMembership') {
      issues.push({ code: 'M2_PAYLOAD_CATALOG_MEMBERSHIP_EDGE', path: dependent.artifactId, message: 'catalog membership cannot authorize a dependency edge' });
    }
  }
  const reachable = new Set();
  const visit = (id, stack) => {
    if (stack.has(id)) {
      issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_CYCLE', path: id, message: 'dependency graph contains a cycle' });
      return;
    }
    if (reachable.has(id)) return;
    reachable.add(id);
    const next = new Set(stack);
    next.add(id);
    for (const prerequisite of incoming.get(id) || []) visit(prerequisite, next);
  };
  for (const root of manifest.roots) visit(root, new Set());
  if (reachable.size !== byId.size) {
    issues.push({ code: 'M2_PAYLOAD_DEPENDENCY_ORPHAN', path: file, message: 'dependency manifest contains unreachable/orphan nodes' });
  }
  return { manifest, file, byId, byPair, catalogInfo };
}

function verifyPayloadClosure(options) {
  const issues = [];
  const p1 = options.p1;
  const artifacts = options.artifacts instanceof Map ? options.artifacts : new Map();
  if (!p1) {
    return { outcome: 'incomplete', issues: [{ code: 'M2_PAYLOAD_CLOSURE_P1_REQUIRED', path: '', message: 'P1 manifest is required', kind: 'missing' }] };
  }
  const payloadEntries = Array.isArray(p1.entries) ? p1.entries : [];
  const roots = validateRootManifests(p1, artifacts, issues);
  const catalog = validateCatalog(p1, artifacts, payloadEntries, issues);
  const expectedRootPairs = roots.map(({ row }) => ({
    artifactRef: row.rootManifestRef,
    artifactDigest: row.rootManifestDigest,
  }));
  expectedRootPairs.push({
    artifactRef: p1.payloadArtifactCatalogRef,
    artifactDigest: p1.payloadArtifactCatalogDigest,
  });
  const dependency = validateDependencyManifest(
    p1,
    artifacts,
    expectedRootPairs,
    catalog,
    issues,
  );
  if (catalog && dependency) {
    const expectedPaths = new Set([
      ...roots.map((root) => root.file),
      catalog.file,
      dependency.file,
    ]);
    const p1EntryByPath = new Map(payloadEntries.map((row) => [row.path, row]));
    for (const node of dependency.byId.values()) {
      if (canonicalJcs(node.artifactRef) === canonicalJcs(p1.payloadArtifactCatalogRef)
          && node.artifactDigest === p1.payloadArtifactCatalogDigest) {
        // The resolver catalog is an explicitly fixed root and deliberately
        // excludes its own ref/digest row to avoid self-reference.
        continue;
      }
      if (node.artifactRef?.kind === 'path' && node.artifactRef.root === 'payload'
          && p1EntryByPath.get(node.artifactRef.path)?.payloadByteDigest === node.artifactDigest) {
        expectedPaths.add(node.artifactRef.path);
        continue;
      }
      const catalogRow = catalog.byArtifact.get(artifactKey(node.artifactRef, node.artifactDigest));
      if (!catalogRow) {
        issues.push({ code: 'M2_PAYLOAD_CATALOG_NODE_RESOLUTION', path: node.artifactId, message: 'dependency node has no direct raw path or exact catalog row' });
      } else if (typeof catalogRow.locator?.path === 'string') {
        expectedPaths.add(catalogRow.locator.path);
      }
    }
    const actualPaths = [...p1EntryByPath.keys()].sort();
    const derivedPaths = [...expectedPaths].sort();
    if (canonicalJcs(actualPaths) !== canonicalJcs(derivedPaths)) {
      issues.push({ code: 'M2_PAYLOAD_ENTRY_EQUATION', path: '/entries', message: 'P1 entries do not equal paths derived from dependency closure plus roots/catalog/manifest' });
    }
  }
  if (!issues.some((issue) => (issue.kind || 'invalid') === 'invalid')
      && roots.length > 0 && catalog && dependency) {
    const sourceReplayAvailable = options.sourceArtifacts instanceof Map
      && (options.trustedSourceArtifacts instanceof Map
        || (typeof options.trustedRoot === 'string' && options.trustedRoot.length > 0));
    if (!sourceReplayAvailable) {
      issues.push({
        code: 'M2_RELEASE_DEPENDENCY_EXTRACTION_REPLAY_REQUIRED',
        path: '',
        message: 'independent root discovery/dependency extraction requires reconstructed P1 source bytes and an independently trusted source workspace',
        kind: 'unverified',
      });
    } else {
      try {
        const replayOptions = {
          sourceArtifacts: options.sourceArtifacts,
          trustedSourceArtifacts: options.trustedSourceArtifacts,
          trustedRoot: options.trustedRoot,
          payloadArtifacts: artifacts,
          payloadEntries,
          rootRecords: roots,
          catalog: catalog.catalog,
          catalogByPair: catalog.byArtifact,
          catalogRef: p1.payloadArtifactCatalogRef,
          catalogDigest: p1.payloadArtifactCatalogDigest,
          dependencyManifestRef: p1.payloadArtifactDependencyManifestRef,
          dependencyManifestDigest: p1.payloadArtifactDependencyManifestDigest,
          phaseRegistryRef: dependency.manifest.phaseRegistryRef,
          phaseRegistryDigest: dependency.manifest.phaseRegistryDigest,
          extractorCapabilityRef: dependency.manifest.extractorCapabilityRef,
          extractorCapabilityDigest: dependency.manifest.extractorCapabilityDigest,
          phases: PHASES,
        };
        const rootReplay = replayRootDiscovery(replayOptions);
        if (rootReplay.rootKindCount !== roots.length
            || rootReplay.rootKindCount !== p1.requiredRoots.length) {
          issues.push({
            code: 'M2_PAYLOAD_ROOT_DISCOVERY_CLOSURE',
            path: '/requiredRoots',
            message: 'independent root discovery did not execute exactly once for every required root',
          });
        }
        const extracted = replayDependencyExtraction(replayOptions);
        if (extracted.callerGraphAccepted !== false) {
          issues.push({
            code: 'M2_PAYLOAD_DEPENDENCY_CALLER_GRAPH',
            path: dependency.file,
            message: 'independent extractor accepted caller-authored graph data',
          });
        }
        if (canonicalJcs(extracted.roots) !== canonicalJcs(dependency.manifest.roots)) {
          issues.push({
            code: 'M2_PAYLOAD_DEPENDENCY_REPLAY_ROOTS',
            path: `${dependency.file}/roots`,
            message: 'independently reconstructed roots differ from the dependency manifest',
          });
        }
        if (canonicalJcs(extracted.nodes) !== canonicalJcs(dependency.manifest.nodes)) {
          issues.push({
            code: 'M2_PAYLOAD_DEPENDENCY_REPLAY_NODES',
            path: `${dependency.file}/nodes`,
            message: 'independently reconstructed nodes differ from the dependency manifest',
          });
        }
        if (canonicalJcs(extracted.edges) !== canonicalJcs(dependency.manifest.edges)) {
          issues.push({
            code: 'M2_PAYLOAD_DEPENDENCY_REPLAY_EDGES',
            path: `${dependency.file}/edges`,
            message: 'independently reconstructed edges differ from the dependency manifest',
          });
        }
        const p1EntryByPath = new Map(payloadEntries.map((row) => [row.path, row]));
        const expectedCatalogKeys = extracted.nodes
          .filter((node) => canonicalJcs(node.artifactRef) !== canonicalJcs(p1.payloadArtifactCatalogRef)
            || node.artifactDigest !== p1.payloadArtifactCatalogDigest)
          .filter((node) => !(node.artifactRef?.kind === 'path'
            && node.artifactRef.root === 'payload'
            && p1EntryByPath.get(node.artifactRef.path)?.payloadByteDigest === node.artifactDigest))
          .map((node) => artifactKey(node.artifactRef, node.artifactDigest))
          .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
        const actualCatalogKeys = catalog.catalog.entries
          .map((row) => artifactKey(row.artifactRef, row.artifactDigest))
          .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
        if (canonicalJcs(expectedCatalogKeys) !== canonicalJcs(actualCatalogKeys)) {
          issues.push({
            code: 'M2_PAYLOAD_CATALOG_REPLAY_KEY_SET',
            path: `${catalog.file}/entries`,
            message: 'catalog rows do not equal the independently discovered non-direct-raw artifact aliases',
          });
        }
      } catch (cause) {
        const replayCause = cause instanceof ReplayError ? cause : {
          code: 'M2_PAYLOAD_DEPENDENCY_REPLAY_ENGINE',
          path: '',
          kind: 'invalid',
          message: cause && cause.message ? cause.message : String(cause),
        };
        issues.push({
          code: replayCause.code,
          path: replayCause.path || '',
          message: replayCause.message,
          kind: replayCause.kind || 'invalid',
        });
      }
    }
  }
  return {
    outcome: issues.some((issue) => (issue.kind || 'invalid') === 'invalid')
      ? 'invalid' : issues.length > 0 ? 'incomplete' : 'passed',
    issues,
  };
}

module.exports = {
  PHASES,
  artifactId,
  taggedJcsDigest,
  verifyPayloadClosure,
};
