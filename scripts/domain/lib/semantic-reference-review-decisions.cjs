'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const ALLOWED_DISPOSITIONS = new Set([
  'reviewedNoBearing',
  'reviewedRejected',
]);
const MANIFEST_FIELDS = new Set(['decisions', 'schemaVersion']);
const DECISION_FIELDS = new Set([
  'artifactDigest',
  'disposition',
  'path',
  'rationale',
  'reviewMethod',
  'reviewerRef',
]);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requireExactFields(value, allowed, at) {
  if (!isPlainObject(value)) throw new Error(`${at}: expected an object`);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`${at}.${field}: unexpected field`);
  }
  for (const field of allowed) {
    if (!(field in value)) throw new Error(`${at}.${field}: missing field`);
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function loadSemanticReviewDecisions({
  manifestPath,
  rootDir,
}) {
  if (!path.isAbsolute(manifestPath)) {
    throw new Error('semantic review decision manifest path must be absolute');
  }
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw new Error(`missing semantic review decision manifest ${path.relative(rootDir, manifestPath)}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`${path.relative(rootDir, manifestPath)}: ${error.message}`);
  }
  requireExactFields(manifest, MANIFEST_FIELDS, 'semanticReviewDecisions');
  if (manifest.schemaVersion !== '1.0') {
    throw new Error('semanticReviewDecisions.schemaVersion: expected 1.0');
  }
  if (!Array.isArray(manifest.decisions)) {
    throw new Error('semanticReviewDecisions.decisions: expected an array');
  }

  const byPath = new Map();
  let previousPath = null;
  for (let index = 0; index < manifest.decisions.length; index++) {
    const decision = manifest.decisions[index];
    const at = `semanticReviewDecisions.decisions[${index}]`;
    requireExactFields(decision, DECISION_FIELDS, at);
    if (typeof decision.path !== 'string'
      || !decision.path.startsWith('reference/')
      || decision.path.includes('\\')
      || path.posix.normalize(decision.path) !== decision.path) {
      throw new Error(`${at}.path: expected a normalized repository-relative reference path`);
    }
    if (previousPath !== null && compareUtf8(previousPath, decision.path) >= 0) {
      throw new Error(`${at}.path: decisions must be strictly UTF-8 path sorted and unique`);
    }
    previousPath = decision.path;
    if (!DIGEST_RE.test(decision.artifactDigest)) {
      throw new Error(`${at}.artifactDigest: expected sha256:<64 lowercase hex>`);
    }
    if (!ALLOWED_DISPOSITIONS.has(decision.disposition)) {
      throw new Error(`${at}.disposition: expected reviewedNoBearing or reviewedRejected`);
    }
    for (const field of ['rationale', 'reviewMethod', 'reviewerRef']) {
      if (typeof decision[field] !== 'string' || decision[field].trim() === '') {
        throw new Error(`${at}.${field}: expected a non-empty string`);
      }
    }
    if (/no current (?:machine-readable )?(?:downstream )?consumer/iu.test(decision.rationale)
        || /absence of (?:a )?downstream (?:use|reference)/iu.test(decision.rationale)) {
      throw new Error(
        `${at}.rationale: consumer absence cannot establish reviewedNoBearing/reviewedRejected; `
        + 'record the file semantics and the coverage, mismatch, provenance defect, or explicit non-goal',
      );
    }
    byPath.set(decision.path, Object.freeze({ ...decision }));
  }
  return {
    byPath,
    manifest,
    manifestPath,
  };
}

function resolveSemanticReviewDecision(decisions, filePath, artifactDigest) {
  const decision = decisions.byPath.get(filePath);
  if (!decision) return null;
  if (decision.artifactDigest !== artifactDigest) {
    throw new Error(
      `${filePath}: semantic review decision digest ${decision.artifactDigest} `
      + `does not match current bytes ${artifactDigest}`,
    );
  }
  return decision;
}

function findUnusedDecisions(decisions, usedPaths, rootPrefix) {
  return [...decisions.byPath.keys()]
    .filter((filePath) => filePath.startsWith(`${rootPrefix}/`) && !usedPaths.has(filePath))
    .sort(compareUtf8);
}

module.exports = {
  findUnusedDecisions,
  loadSemanticReviewDecisions,
  resolveSemanticReviewDecision,
};
