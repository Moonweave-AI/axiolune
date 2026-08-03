'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const EVIDENCE_USE = 'automated-triage-candidate-not-semantic-review-or-release-evidence';
const DISPOSITIONS = new Set(['candidateNoBearing', 'candidateRejected']);
const ROOT_FIELDS = new Set([
  'evidenceUse',
  'recordKind',
  'records',
  'reviewedAgainst',
  'schemaVersion',
]);
const RECORD_FIELDS = new Set([
  'artifactDigest',
  'disposition',
  'evidenceLocators',
  'fileRole',
  'm2Assessment',
  'path',
  'projectId',
  'provenanceAssessment',
  'reviewMethod',
  'reviewStatus',
  'reviewerRef',
  'semanticSummary',
  'semanticTags',
  'sourceKind',
]);
const LOCATOR_FIELDS = new Set(['excerpt', 'kind', 'line']);

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requireExactFields(value, fields, at) {
  if (!isPlainObject(value)) throw new Error(`${at}: expected object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length
      || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${at}: closed fields mismatch; got ${actual.join(',')}`);
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function requireNonEmptyString(value, at) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${at}: expected non-empty string`);
  }
}

function formatLocator(locator) {
  return `L${locator.line} ${locator.kind}: ${locator.excerpt}`;
}

function decisionRationaleFromEvidence(record) {
  return [
    record.semanticSummary,
    `Exact file evidence: ${record.evidenceLocators.map(formatLocator).join(' | ')}.`,
    record.m2Assessment,
    record.provenanceAssessment,
  ].join(' ');
}

function decisionFromEvidence(record) {
  throw new Error(
    `${record?.path || 'project-reference candidate'}: automated triage evidence cannot be promoted to a semantic review decision`,
  );
}

function validateRecord(record, index, previousPath) {
  const at = `projectReferenceSemanticEvidence.records[${index}]`;
  requireExactFields(record, RECORD_FIELDS, at);
  if (typeof record.path !== 'string'
      || !record.path.startsWith('reference/project-reference/')
      || record.path.includes('\\')
      || path.posix.normalize(record.path) !== record.path) {
    throw new Error(`${at}.path: expected normalized project-reference path`);
  }
  if (previousPath !== null && compareUtf8(previousPath, record.path) >= 0) {
    throw new Error(`${at}.path: records must be strictly UTF-8 path sorted and unique`);
  }
  if (!DIGEST_RE.test(record.artifactDigest)) {
    throw new Error(`${at}.artifactDigest: expected sha256:<64 lowercase hex>`);
  }
  if (!DISPOSITIONS.has(record.disposition)) {
    throw new Error(`${at}.disposition: expected candidateNoBearing or candidateRejected`);
  }
  if (record.reviewStatus !== 'automatedCandidate') {
    throw new Error(`${at}.reviewStatus: expected automatedCandidate`);
  }
  for (const field of [
    'fileRole',
    'm2Assessment',
    'projectId',
    'provenanceAssessment',
    'reviewMethod',
    'reviewerRef',
    'semanticSummary',
    'sourceKind',
  ]) requireNonEmptyString(record[field], `${at}.${field}`);
  if (!Array.isArray(record.semanticTags)
      || record.semanticTags.some((tag) => typeof tag !== 'string' || tag.trim() === '')) {
    throw new Error(`${at}.semanticTags: expected string array`);
  }
  const sortedTags = [...record.semanticTags].sort(compareUtf8);
  if (sortedTags.some((tag, tagIndex) => tag !== record.semanticTags[tagIndex])
      || new Set(record.semanticTags).size !== record.semanticTags.length) {
    throw new Error(`${at}.semanticTags: expected sorted unique tags`);
  }
  if (!Array.isArray(record.evidenceLocators) || record.evidenceLocators.length === 0) {
    throw new Error(`${at}.evidenceLocators: expected at least one exact file locator`);
  }
  let previousLocator = null;
  for (const [locatorIndex, locator] of record.evidenceLocators.entries()) {
    const locatorAt = `${at}.evidenceLocators[${locatorIndex}]`;
    requireExactFields(locator, LOCATOR_FIELDS, locatorAt);
    if (!Number.isSafeInteger(locator.line) || locator.line < 1) {
      throw new Error(`${locatorAt}.line: expected positive safe integer`);
    }
    requireNonEmptyString(locator.kind, `${locatorAt}.kind`);
    requireNonEmptyString(locator.excerpt, `${locatorAt}.excerpt`);
    const key = `${String(locator.line).padStart(12, '0')}\0${locator.kind}\0${locator.excerpt}`;
    if (previousLocator !== null && compareUtf8(previousLocator, key) >= 0) {
      throw new Error(`${locatorAt}: locators must be strictly sorted and unique`);
    }
    previousLocator = key;
  }
  const rationale = decisionRationaleFromEvidence(record);
  if (!rationale.includes(record.path)) {
    throw new Error(`${at}.semanticSummary: summary must name the exact repository path`);
  }
  if (!/M2|ontology|ontological/iu.test(record.m2Assessment)) {
    throw new Error(`${at}.m2Assessment: expected an explicit M2/ontology comparison`);
  }
  if (!/lock|provenance|commit|locator/iu.test(record.provenanceAssessment)) {
    throw new Error(`${at}.provenanceAssessment: expected provenance/lock assessment`);
  }
  return record.path;
}

function loadProjectReferenceSemanticEvidence({ evidencePath, rootDir }) {
  if (!path.isAbsolute(evidencePath)) throw new Error('project semantic evidence path must be absolute');
  if (!fs.existsSync(evidencePath) || !fs.statSync(evidencePath).isFile()) {
    throw new Error(`missing project semantic evidence ${path.relative(rootDir, evidencePath)}`);
  }
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    throw new Error(`${path.relative(rootDir, evidencePath)}: ${error.message}`);
  }
  requireExactFields(artifact, ROOT_FIELDS, 'projectReferenceSemanticEvidence');
  if (artifact.schemaVersion !== '1.0'
      || artifact.recordKind !== 'projectReferenceSemanticEvidence'
      || artifact.evidenceUse !== EVIDENCE_USE) {
    throw new Error('projectReferenceSemanticEvidence: invalid schemaVersion/recordKind/evidenceUse');
  }
  if (!Array.isArray(artifact.reviewedAgainst)
      || artifact.reviewedAgainst.length === 0
      || artifact.reviewedAgainst.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error('projectReferenceSemanticEvidence.reviewedAgainst: expected non-empty string array');
  }
  for (const [index, entry] of artifact.reviewedAgainst.entries()) {
    const sourcePath = entry.split('#', 1)[0];
    if (path.isAbsolute(sourcePath)
        || sourcePath.includes('\\')
        || path.posix.normalize(sourcePath) !== sourcePath) {
      throw new Error(
        `projectReferenceSemanticEvidence.reviewedAgainst[${index}]: expected normalized repository-relative path`,
      );
    }
    const resolved = path.resolve(rootDir, sourcePath);
    const relative = path.relative(rootDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(resolved)) {
      throw new Error(
        `projectReferenceSemanticEvidence.reviewedAgainst[${index}]: missing reviewed source ${sourcePath}`,
      );
    }
  }
  if (!Array.isArray(artifact.records)) {
    throw new Error('projectReferenceSemanticEvidence.records: expected array');
  }
  const byPath = new Map();
  const rationales = new Map();
  let previousPath = null;
  for (const [index, record] of artifact.records.entries()) {
    previousPath = validateRecord(record, index, previousPath);
    const rationale = decisionRationaleFromEvidence(record);
    if (rationales.has(rationale)) {
      throw new Error(
        `${record.path}: duplicate file rationale also used by ${rationales.get(rationale)}`,
      );
    }
    rationales.set(rationale, record.path);
    byPath.set(record.path, Object.freeze(record));
  }
  return { artifact, byPath, evidencePath };
}

function assertDecisionMatchesEvidence(decision, record) {
  throw new Error(
    `${decision?.path || record?.path || 'project-reference candidate'}: automated triage evidence is not a reviewed semantic decision`,
  );
}

module.exports = {
  EVIDENCE_USE,
  assertDecisionMatchesEvidence,
  decisionFromEvidence,
  decisionRationaleFromEvidence,
  loadProjectReferenceSemanticEvidence,
};
