'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const CQ_SOURCE_ROOT = 'docs/ontology/competency-questions';
const CQ_SOURCE_INVENTORY_REF = Object.freeze({
  kind: 'path',
  root: 'sourceTree',
  path: 'scripts/domain/release-profile/v0.3.0/cq-source-inventory.json',
});
const CQ_ID_RE = /^CQ-[A-Z0-9]+$/u;
const STATUS = new Set(['active', 'retired', 'deferred']);

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function artifactDigest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function sourceRef(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function sourcePath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0
      || relativePath.includes('\\') || relativePath.startsWith('/')
      || /^[A-Za-z]:/u.test(relativePath)
      || relativePath.split('/').some((segment) => ['', '.', '..'].includes(segment))) {
    throw new Error(`unsafe sourceTree path ${String(relativePath)}`);
  }
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(path.resolve(root), absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`sourceTree path escapes repository root: ${relativePath}`);
  }
  return absolute;
}

function readRegularFile(root, relativePath) {
  const absolute = sourcePath(root, relativePath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`CQ source is not a regular non-symlink file: ${relativePath}`);
  }
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(absolute);
  const relativeReal = path.relative(realRoot, realFile);
  if (relativeReal === '..' || relativeReal.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeReal)) {
    throw new Error(`CQ source resolves outside repository root: ${relativePath}`);
  }
  return fs.readFileSync(realFile);
}

function discoverCqSourcePaths(root) {
  const absoluteRoot = sourcePath(root, CQ_SOURCE_ROOT);
  const stat = fs.lstatSync(absoluteRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${CQ_SOURCE_ROOT} is not a regular directory`);
  }
  return fs.readdirSync(absoluteRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.yaml'))
    .map((entry) => `${CQ_SOURCE_ROOT}/${entry.name}`)
    .sort(compareUtf8);
}

function compileCqSourceInventory(root) {
  const sourcePaths = discoverCqSourcePaths(root);
  if (sourcePaths.length === 0) throw new Error('no CQ YAML sources were discovered');
  const entries = [];
  const byId = new Map();
  for (const relativePath of sourcePaths) {
    const bytes = readRegularFile(root, relativePath);
    let document;
    try {
      document = yaml.load(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      throw new Error(`cannot parse CQ source ${relativePath}: ${error.message}`);
    }
    if (!document || typeof document !== 'object' || !Array.isArray(document.cqs)) {
      throw new Error(`CQ source ${relativePath} has no cqs array`);
    }
    for (const [index, cq] of document.cqs.entries()) {
      if (!cq || typeof cq !== 'object' || Array.isArray(cq)
          || !CQ_ID_RE.test(cq.id || '') || !STATUS.has(cq.status)) {
        throw new Error(`invalid CQ row ${relativePath}#cqs/${index}`);
      }
      if (byId.has(cq.id)) {
        throw new Error(`duplicate CQ ${cq.id} in ${byId.get(cq.id).sourceRef.path} and ${relativePath}`);
      }
      const aliasOf = Object.hasOwn(cq, 'aliasOf') ? cq.aliasOf : null;
      if (aliasOf !== null && !CQ_ID_RE.test(aliasOf || '')) {
        throw new Error(`CQ ${cq.id} has invalid aliasOf`);
      }
      const executionIdentity = cq.executionIdentity || aliasOf || cq.id;
      if (!CQ_ID_RE.test(executionIdentity || '')) {
        throw new Error(`CQ ${cq.id} has invalid executionIdentity`);
      }
      if (aliasOf !== null && executionIdentity !== aliasOf) {
        throw new Error(`CQ ${cq.id} alias executionIdentity must equal aliasOf`);
      }
      if (aliasOf === null && executionIdentity !== cq.id) {
        throw new Error(`CQ ${cq.id} cannot share an executionIdentity without aliasOf`);
      }
      const entry = {
        cqId: cq.id,
        status: cq.status,
        executionIdentity,
        aliasOf,
        sourceRef: sourceRef(relativePath),
        sourceDigest: artifactDigest(bytes),
      };
      entries.push(entry);
      byId.set(entry.cqId, entry);
    }
  }
  for (const entry of entries) {
    if (entry.aliasOf === null) continue;
    const target = byId.get(entry.aliasOf);
    if (!target || target.status !== 'active' || entry.status !== 'active') {
      throw new Error(`CQ ${entry.cqId} alias must resolve to one active CQ`);
    }
    if (target.aliasOf !== null) throw new Error(`CQ ${entry.cqId} alias chains are forbidden`);
  }
  entries.sort((left, right) => compareUtf8(left.cqId, right.cqId));
  const inventory = { schemaVersion: '1.0', profileRef: PROFILE_REF, entries };
  return {
    inventory,
    bytes: Buffer.from(canonicalJcs(inventory), 'utf8'),
    stats: {
      sourceCount: sourcePaths.length,
      cqCount: entries.length,
      activeCqCount: entries.filter((entry) => entry.status === 'active').length,
      uniqueActiveExecutionCount: new Set(entries
        .filter((entry) => entry.status === 'active')
        .map((entry) => entry.executionIdentity)).size,
      retiredCqCount: entries.filter((entry) => entry.status === 'retired').length,
      deferredCqCount: entries.filter((entry) => entry.status === 'deferred').length,
    },
  };
}

module.exports = {
  CQ_SOURCE_INVENTORY_REF,
  CQ_SOURCE_ROOT,
  PROFILE_REF,
  artifactDigest,
  compileCqSourceInventory,
  discoverCqSourcePaths,
  sourcePath,
};
