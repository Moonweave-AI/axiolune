'use strict';

const crypto = require('node:crypto');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const GATE_ID = 'shacl-execution';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const ID_RE = /^[0-9a-f]{64}$/u;

function taggedJcsDigest(tag, value) {
  return `sha256:${crypto.createHash('sha256')
    .update(Buffer.from(tag, 'utf8'))
    .update(Buffer.from(canonicalJcs(value), 'utf8'))
    .digest('hex')}`;
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function artifactRefKey(value) {
  try {
    return canonicalJcs(value);
  } catch {
    return '';
  }
}

function canonicalEqual(left, right) {
  try {
    return canonicalJcs(left) === canonicalJcs(right);
  } catch {
    return false;
  }
}

function validArtifactRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.kind === 'iri') {
    if (!exactKeys(value, ['kind', 'iri']) || typeof value.iri !== 'string') return false;
    try {
      return Boolean(new URL(value.iri).protocol);
    } catch {
      return false;
    }
  }
  return exactKeys(value, ['kind', 'root', 'path'])
    && value.kind === 'path'
    && ['sourceTree', 'buildEvidence', 'payload'].includes(value.root)
    && typeof value.path === 'string' && value.path.length > 0
    && !value.path.includes('\\') && !value.path.startsWith('/')
    && !/^[A-Za-z]:/u.test(value.path)
    && value.path.split('/').every((segment) => (
      segment !== '' && segment !== '.' && segment !== '..'
    ));
}

function checkSortedUnique(values, label, issues) {
  for (let index = 1; index < values.length; index += 1) {
    if (byteCompare(values[index - 1], values[index]) >= 0) {
      issues.push({
        code: 'M2_SHACL_INSTANCE_JOIN_ORDER',
        path: `${label}/${index}`,
        message: `${label} must be UTF-8 byte-sorted and unique`,
      });
      return;
    }
  }
}

function exactSetJoin(expectedIds, actualIds, label, issues) {
  const expected = new Set(expectedIds);
  const actual = new Set(actualIds);
  const missingIds = expectedIds.filter((id) => !actual.has(id));
  const extraIds = actualIds.filter((id) => !expected.has(id));
  if (missingIds.length > 0 || extraIds.length > 0
      || expectedIds.length !== expected.size || actualIds.length !== actual.size) {
    issues.push({
      code: 'M2_SHACL_INSTANCE_JOIN_SET',
      path: label,
      message: `${label} differs from constraint-instance manifest: missing=${missingIds.length}, extra=${extraIds.length}`,
      missingIds,
      extraIds,
    });
  }
}

function expectedInputDigests(entry) {
  return [...new Set([
    entry.positiveExpectation.artifactDigest,
    entry.positiveExpectation.schemaDigest,
    entry.negativeExpectation.artifactDigest,
    entry.negativeExpectation.schemaDigest,
  ])].sort(byteCompare);
}

function verifyConstraintInstanceGateJoin(options = {}) {
  const { manifest, discovery, subjectInventory, report } = options;
  const issues = [];
  if (!manifest || !Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    return {
      outcome: 'invalid',
      issues: [{
        code: 'M2_SHACL_INSTANCE_JOIN_MANIFEST',
        path: 'constraint-instance-manifest.json',
        message: 'a non-empty validated constraint-instance manifest is required',
      }],
      itemCount: 0,
      checkCount: 0,
    };
  }
  const manifestDigest = taggedJcsDigest(
    'axiolune-constraint-instance-manifest-v1\0',
    manifest,
  );
  const manifestIds = manifest.entries.map((entry) => entry.constraintInstanceId);
  checkSortedUnique(manifestIds, 'manifest.entries', issues);

  if (!exactKeys(discovery, [
    'schemaVersion', 'profileRef', 'gateId', 'manifestDigest', 'items',
  ]) || discovery.schemaVersion !== '1.0' || discovery.profileRef !== PROFILE_REF
      || discovery.gateId !== GATE_ID || discovery.manifestDigest !== manifestDigest
      || !Array.isArray(discovery.items)) {
    issues.push({
      code: 'M2_SHACL_INSTANCE_DISCOVERY_SCHEMA',
      path: 'shacl-execution.discovery',
      message: 'discovery artifact is not the closed manifest-bound v1 structure',
    });
  }
  const discoveryItems = Array.isArray(discovery?.items) ? discovery.items : [];
  const discoveryIds = [];
  const discoveryById = new Map();
  for (const [index, item] of discoveryItems.entries()) {
    const at = `shacl-execution.discovery/items/${index}`;
    if (!exactKeys(item, [
      'constraintInstanceId', 'positiveExpectation', 'negativeExpectation',
      'subjectId', 'subjectRef', 'subjectDigest',
    ]) || !ID_RE.test(item.constraintInstanceId)
        || !DIGEST_RE.test(item.subjectId) || !DIGEST_RE.test(item.subjectDigest)
        || !validArtifactRef(item.subjectRef)) {
      issues.push({
        code: 'M2_SHACL_INSTANCE_DISCOVERY_ITEM',
        path: at,
        message: 'discovery item is not a closed constraint-instance subject tuple',
      });
      continue;
    }
    discoveryIds.push(item.constraintInstanceId);
    discoveryById.set(item.constraintInstanceId, item);
  }
  checkSortedUnique(discoveryIds, 'shacl-execution.discovery.items', issues);
  exactSetJoin(manifestIds, discoveryIds, 'shacl-execution.discovery.items', issues);
  const manifestById = new Map(manifest.entries.map((entry) => (
    [entry.constraintInstanceId, entry]
  )));
  for (const item of discoveryItems) {
    const entry = manifestById.get(item.constraintInstanceId);
    if (!entry) continue;
    if (!canonicalEqual(item.positiveExpectation, entry.positiveExpectation)
        || !canonicalEqual(item.negativeExpectation, entry.negativeExpectation)) {
      issues.push({
        code: 'M2_SHACL_INSTANCE_DISCOVERY_EXPECTATION',
        path: item.constraintInstanceId,
        message: 'discovered fixture IDs/refs/digests differ from the manifest entry',
      });
    }
  }

  const subjects = Array.isArray(subjectInventory?.subjects)
    ? subjectInventory.subjects : [];
  const subjectsById = new Map();
  for (const [index, subject] of subjects.entries()) {
    const at = `shacl-execution.subjectInventory/subjects/${index}`;
    if (!exactKeys(subject, ['subjectId', 'subjectRef', 'subjectDigest', 'classifier'])
        || !DIGEST_RE.test(subject.subjectId) || !DIGEST_RE.test(subject.subjectDigest)
        || subject.classifier !== 'constraintInstance'
        || !validArtifactRef(subject.subjectRef)) {
      issues.push({
        code: 'M2_SHACL_INSTANCE_SUBJECT_SCHEMA',
        path: at,
        message: 'inventory subject is not a closed constraintInstance tuple',
      });
      continue;
    }
    if (subjectsById.has(subject.subjectId)) {
      issues.push({
        code: 'M2_SHACL_INSTANCE_SUBJECT_DUPLICATE',
        path: at,
        message: `duplicate subjectId ${subject.subjectId}`,
      });
    }
    subjectsById.set(subject.subjectId, subject);
  }
  checkSortedUnique(
    subjects.map((subject) => subject?.subjectId || ''),
    'shacl-execution.subjectInventory.subjects',
    issues,
  );
  const discoveredSubjectIds = discoveryItems.map((item) => item.subjectId).sort(byteCompare);
  const inventorySubjectIds = [...subjectsById.keys()].sort(byteCompare);
  exactSetJoin(
    discoveredSubjectIds,
    inventorySubjectIds,
    'shacl-execution.subjectInventory.subjects',
    issues,
  );
  for (const item of discoveryItems) {
    const subject = subjectsById.get(item.subjectId);
    if (!subject) continue;
    if (subject.subjectDigest !== item.subjectDigest
        || artifactRefKey(subject.subjectRef) !== artifactRefKey(item.subjectRef)) {
      issues.push({
        code: 'M2_SHACL_INSTANCE_SUBJECT_JOIN',
        path: item.constraintInstanceId,
        message: 'discovery subject ref/digest differs from subject inventory',
      });
    }
  }

  const checks = Array.isArray(report?.result?.checks) ? report.result.checks : [];
  if (report?.schemaVersion !== '1.0' || report?.profileRef !== PROFILE_REF
      || report?.gateId !== GATE_ID || report?.result?.outcome !== 'passed') {
    issues.push({
      code: 'M2_SHACL_INSTANCE_REPORT_HEADER',
      path: 'shacl-execution.validationReport',
      message: 'expected a passed v1 shacl-execution ValidationReport',
    });
  }
  const checkIds = checks.map((check) => check?.checkId).filter((id) => typeof id === 'string');
  checkSortedUnique(checkIds, 'shacl-execution.validationReport.result.checks', issues);
  exactSetJoin(manifestIds, checkIds, 'shacl-execution.validationReport.result.checks', issues);
  const checksById = new Map(checks.map((check) => [check?.checkId, check]));
  for (const entry of manifest.entries) {
    const item = discoveryById.get(entry.constraintInstanceId);
    const check = checksById.get(entry.constraintInstanceId);
    if (!item || !check) continue;
    if (check.status !== 'passed' || check.subjectId !== item.subjectId
        || check.subjectDigest !== item.subjectDigest
        || !validArtifactRef(check.subjectRef)
        || artifactRefKey(check.subjectRef) !== artifactRefKey(item.subjectRef)) {
      issues.push({
        code: 'M2_SHACL_INSTANCE_GATECHECK_SUBJECT',
        path: entry.constraintInstanceId,
        message: 'GateCheck status/subject tuple differs from discovery',
      });
    }
    if (!Array.isArray(check.inputDigests)) {
      issues.push({
        code: 'M2_SHACL_INSTANCE_GATECHECK_INPUTS',
        path: entry.constraintInstanceId,
        message: 'GateCheck inputDigests is not an array',
      });
      continue;
    }
    const inputSet = new Set(check.inputDigests);
    let requiredDigests;
    try {
      requiredDigests = expectedInputDigests(entry);
    } catch (cause) {
      issues.push({
        code: 'M2_SHACL_INSTANCE_GATECHECK_INPUTS',
        path: entry.constraintInstanceId,
        message: `manifest expectation digest extraction failed: ${cause.message}`,
      });
      continue;
    }
    const missingDigests = requiredDigests.filter((digest) => !inputSet.has(digest));
    if (missingDigests.length > 0) {
      issues.push({
        code: 'M2_SHACL_INSTANCE_GATECHECK_INPUTS',
        path: entry.constraintInstanceId,
        message: `GateCheck omits ${missingDigests.length} bound fixture/schema digest(s)`,
        missingDigests,
      });
    }
  }
  const count = manifest.entries.length;
  if (!report?.counts || report.counts.discovered !== count
      || report.counts.executed !== count || report.counts.passed !== count
      || ['failed', 'skipped', 'pending', 'warnings'].some((field) => (
        report.counts?.[field] !== 0
      ))) {
    issues.push({
      code: 'M2_SHACL_INSTANCE_REPORT_COUNTS',
      path: 'shacl-execution.validationReport.counts',
      message: `report counts do not prove ${count}/${count} passed instance checks with zero pending/skip/failure/warning`,
    });
  }
  return {
    outcome: issues.length === 0 ? 'passed' : 'invalid',
    issues,
    itemCount: discoveryItems.length,
    checkCount: checks.length,
    manifestDigest,
  };
}

module.exports = {
  GATE_ID,
  PROFILE_REF,
  expectedInputDigests,
  taggedJcsDigest,
  verifyConstraintInstanceGateJoin,
};
