'use strict';

const crypto = require('node:crypto');
const { canonicalJcs } = require('./strict-source-locator.cjs');

const CATALOG_TAG = 'axiolune-payload-artifact-catalog-v1\0';
const INVENTORY_TAG = 'axiolune-gate-subject-inventory-v1\0';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const ASCII_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MEDIA_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/u;

class GateBindingError extends Error {
  constructor(code, message, at = '', kind = 'invalid') {
    super(message);
    this.name = 'GateBindingError';
    this.code = code;
    this.at = at;
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

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort(compareUtf8))
      === canonicalJcs([...expected].sort(compareUtf8));
}

function canonicalPath(value) {
  return typeof value === 'string' && value.length > 0
    && value === value.normalize('NFC') && !value.startsWith('/')
    && !value.includes('\\') && !/^[A-Za-z]:/u.test(value)
    && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function absoluteIri(value) {
  if (typeof value !== 'string' || value.length === 0
      || value !== value.normalize('NFC') || /\s/u.test(value)) return false;
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
  return value?.kind === 'path'
    && exactKeys(value, ['kind', 'root', 'path'])
    && ['sourceTree', 'buildEvidence', 'payload'].includes(value.root)
    && canonicalPath(value.path);
}

function artifactKey(reference, digest) {
  return `${canonicalJcs(reference)}\0${digest}`;
}

function strictJcs(bytes, label) {
  if (!Buffer.isBuffer(bytes)) {
    throw new GateBindingError(
      'M2_GATE_BINDING_ARTIFACT_MISSING',
      `${label} bytes are missing`,
      label,
      'missing',
    );
  }
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
      throw new Error('bytes are not exact UTF-8 RFC 8785 JCS');
    }
    return value;
  } catch (cause) {
    throw new GateBindingError(
      'M2_GATE_BINDING_ARTIFACT_JCS',
      `${label}: ${cause.message}`,
      label,
    );
  }
}

function resolvePointer(value, pointer) {
  if (pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
    throw new Error('JSON Pointer is not canonical');
  }
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/u.test(raw)) throw new Error('JSON Pointer escape is invalid');
    const token = raw.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (Array.isArray(current) && /^(0|[1-9][0-9]*)$/u.test(token)
        && Number(token) < current.length) {
      current = current[Number(token)];
    } else if (current && typeof current === 'object' && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      throw new Error('JSON Pointer does not resolve');
    }
  }
  return current;
}

function payloadEntryMap(p1) {
  const entries = new Map();
  for (const row of Array.isArray(p1?.entries) ? p1.entries : []) {
    if (!exactKeys(row, ['path', 'mediaType', 'byteLength', 'payloadByteDigest'])
        || !canonicalPath(row?.path) || !MEDIA_TYPE_RE.test(row?.mediaType || '')
        || !Number.isSafeInteger(row?.byteLength) || row.byteLength < 0
        || !DIGEST_RE.test(row?.payloadByteDigest || '')
        || entries.has(row.path)) {
      throw new GateBindingError(
        'M2_GATE_BINDING_PAYLOAD_ENTRY',
        'P1 entries are not a closed unique path/media/length/digest inventory',
        '/entries',
      );
    }
    entries.set(row.path, row);
  }
  return entries;
}

function loadCatalog(p1, artifacts, entries) {
  const reference = p1?.payloadArtifactCatalogRef;
  if (!exactKeys(reference, ['kind', 'root', 'path'])
      || reference.kind !== 'path' || reference.root !== 'payload'
      || !canonicalPath(reference.path)) {
    throw new GateBindingError(
      'M2_GATE_BINDING_CATALOG_REF',
      'payloadArtifactCatalogRef is not a closed payload path',
      '/payloadArtifactCatalogRef',
    );
  }
  const bytes = artifacts.get(reference.path);
  const catalog = strictJcs(bytes, reference.path);
  const catalogEntry = entries.get(reference.path);
  if (!catalogEntry || catalogEntry.byteLength !== bytes.length
      || catalogEntry.payloadByteDigest !== sha256(bytes)) {
    throw new GateBindingError(
      'M2_GATE_BINDING_CATALOG_BYTES',
      'payload artifact catalog bytes are not exactly bound by the P1 entry inventory',
      reference.path,
      catalogEntry ? 'invalid' : 'missing',
    );
  }
  if (!exactKeys(catalog, ['schemaVersion', 'targetVersion', 'entries'])
      || catalog.schemaVersion !== '1.0' || catalog.targetVersion !== p1.targetVersion
      || !Array.isArray(catalog.entries)
      || taggedJcsDigest(CATALOG_TAG, catalog) !== p1.payloadArtifactCatalogDigest) {
    throw new GateBindingError(
      'M2_GATE_BINDING_CATALOG_SCHEMA',
      'payload artifact catalog identity/schema/digest is invalid',
      reference.path,
    );
  }
  const byPair = new Map();
  let previous = null;
  for (let index = 0; index < catalog.entries.length; index += 1) {
    const row = catalog.entries[index];
    const at = `${reference.path}/entries/${index}`;
    if (!exactKeys(row, [
      'artifactRef', 'artifactDigest', 'payloadByteDigest', 'mediaType', 'locator',
      'digestProfile',
    ]) || !validArtifactRef(row.artifactRef)
        || !DIGEST_RE.test(row.artifactDigest || '')
        || !DIGEST_RE.test(row.payloadByteDigest || '')
        || !MEDIA_TYPE_RE.test(row.mediaType || '')) {
      throw new GateBindingError(
        'M2_GATE_BINDING_CATALOG_ROW',
        'catalog row is not closed or digest-valid',
        at,
      );
    }
    const key = artifactKey(row.artifactRef, row.artifactDigest);
    if ((previous !== null && compareUtf8(previous, key) >= 0) || byPair.has(key)) {
      throw new GateBindingError(
        'M2_GATE_BINDING_CATALOG_ORDER',
        'catalog rows are not strict pair-sorted and unique',
        at,
      );
    }
    previous = key;
    const locatorPath = row.locator?.path;
    const wholeFile = row.locator?.kind === 'wholeFile'
      && exactKeys(row.locator, ['kind', 'path', 'byteLength'])
      && Number.isSafeInteger(row.locator.byteLength) && row.locator.byteLength >= 0;
    const jsonValue = row.locator?.kind === 'jsonValue'
      && exactKeys(row.locator, ['kind', 'path', 'pointer'])
      && typeof row.locator.pointer === 'string';
    const rawBytes = row.digestProfile?.kind === 'rawBytes'
      && exactKeys(row.digestProfile, ['kind', 'algorithm'])
      && row.digestProfile.algorithm === 'sha256';
    const taggedJcs = row.digestProfile?.kind === 'taggedJcs'
      && exactKeys(row.digestProfile, ['kind', 'domainTag', 'canonicalization'])
      && row.digestProfile.canonicalization === 'RFC8785-JCS'
      && typeof row.digestProfile.domainTag === 'string'
      && row.digestProfile.domainTag.endsWith('\0')
      && !row.digestProfile.domainTag.slice(0, -1).includes('\0');
    if ((!wholeFile && !jsonValue) || (!rawBytes && !taggedJcs)
        || !canonicalPath(locatorPath) || !entries.has(locatorPath)) {
      throw new GateBindingError(
        'M2_GATE_BINDING_CATALOG_PROFILE',
        'catalog locator/digestProfile is not a closed supported P1 binding',
        at,
      );
    }
    const located = artifacts.get(locatorPath);
    if (!Buffer.isBuffer(located)) {
      throw new GateBindingError(
        'M2_GATE_BINDING_ARTIFACT_MISSING',
        `catalog locator ${locatorPath} is missing`,
        locatorPath,
        'missing',
      );
    }
    const locatorEntry = entries.get(locatorPath);
    if (sha256(located) !== row.payloadByteDigest
        || locatorEntry.payloadByteDigest !== row.payloadByteDigest
        || locatorEntry.byteLength !== located.length) {
      throw new GateBindingError(
        'M2_GATE_BINDING_CATALOG_BYTES',
        'catalog locator bytes differ from P1/catalog binding',
        locatorPath,
      );
    }
    byPair.set(key, row);
  }
  return byPair;
}

function resolvePair(pair, context, label) {
  if (!validArtifactRef(pair?.artifactRef) || !DIGEST_RE.test(pair?.artifactDigest || '')) {
    throw new GateBindingError(
      'M2_GATE_BINDING_PAIR',
      `${label} ref/digest pair is invalid`,
      label,
    );
  }
  const catalogRow = context.catalogByPair.get(
    artifactKey(pair.artifactRef, pair.artifactDigest),
  );
  if (catalogRow) {
    const containerBytes = context.artifacts.get(catalogRow.locator.path);
    let bytes;
    let value = null;
    if (catalogRow.locator.kind === 'wholeFile') {
      bytes = containerBytes;
      if (!Number.isSafeInteger(catalogRow.locator.byteLength)
          || catalogRow.locator.byteLength !== bytes.length) {
        throw new GateBindingError(
          'M2_GATE_BINDING_CATALOG_LENGTH',
          `${label} whole-file byteLength differs`,
          label,
        );
      }
    } else if (catalogRow.locator.kind === 'jsonValue') {
      const container = strictJcs(containerBytes, catalogRow.locator.path);
      value = resolvePointer(container, catalogRow.locator.pointer);
      bytes = Buffer.from(canonicalJcs(value), 'utf8');
    } else {
      throw new GateBindingError(
        'M2_GATE_BINDING_PROFILE_REPLAY_REQUIRED',
        `${label} requires a gate-specific ${String(catalogRow.locator.kind)} resolver`,
        label,
        'unverified',
      );
    }
    let actualDigest;
    if (catalogRow.digestProfile?.kind === 'rawBytes'
        && catalogRow.digestProfile.algorithm === 'sha256') {
      actualDigest = sha256(bytes);
    } else if (catalogRow.digestProfile?.kind === 'taggedJcs'
        && catalogRow.digestProfile.canonicalization === 'RFC8785-JCS'
        && typeof catalogRow.digestProfile.domainTag === 'string') {
      if (value === null) value = strictJcs(bytes, label);
      actualDigest = taggedJcsDigest(catalogRow.digestProfile.domainTag, value);
    } else {
      throw new GateBindingError(
        'M2_GATE_BINDING_PROFILE_REPLAY_REQUIRED',
        `${label} has no independently executable rawBytes/taggedJcs profile`,
        label,
        'unverified',
      );
    }
    if (actualDigest !== pair.artifactDigest) {
      throw new GateBindingError(
        'M2_GATE_BINDING_DIGEST',
        `${label} semantic digest differs`,
        label,
      );
    }
    return { bytes, value };
  }
  if (pair.artifactRef.kind === 'path' && pair.artifactRef.root === 'payload') {
    const bytes = context.artifacts.get(pair.artifactRef.path);
    const entry = context.entries.get(pair.artifactRef.path);
    if (!Buffer.isBuffer(bytes) || sha256(bytes) !== pair.artifactDigest
        || entry?.payloadByteDigest !== pair.artifactDigest
        || entry.byteLength !== bytes.length) {
      throw new GateBindingError(
        'M2_GATE_BINDING_DIGEST',
        `${label} direct payload bytes differ`,
        label,
        Buffer.isBuffer(bytes) ? 'invalid' : 'missing',
      );
    }
    return { bytes, value: null };
  }
  if (pair.artifactRef.kind === 'path' && pair.artifactRef.root === 'sourceTree') {
    const bytes = context.sourceArtifacts.get(pair.artifactRef.path);
    if (!Buffer.isBuffer(bytes) || sha256(bytes) !== pair.artifactDigest) {
      throw new GateBindingError(
        'M2_GATE_BINDING_DIGEST',
        `${label} reconstructed-P1 source bytes differ`,
        label,
        Buffer.isBuffer(bytes) ? 'invalid' : 'missing',
      );
    }
    return { bytes, value: null };
  }
  throw new GateBindingError(
    'M2_GATE_BINDING_CATALOG_PAIR_REQUIRED',
    `${label} has no exact payload-catalog locator`,
    label,
    'missing',
  );
}

function pair(reference, digest) {
  return { artifactRef: reference, artifactDigest: digest };
}

function resolveRawPair(binding, context, label) {
  const resolved = resolvePair(binding, context, label);
  if (sha256(resolved.bytes) !== binding.artifactDigest) {
    throw new GateBindingError(
      'M2_GATE_BINDING_RAW_DIGEST',
      `${label} is required to use its raw artifact byte digest`,
      label,
    );
  }
  return resolved;
}

function validateInventory(inventory, report, context, label) {
  if (!exactKeys(inventory, [
    'schemaVersion', 'gateId', 'discoveryContractRef', 'discoveryContractDigest',
    'subjects',
  ]) || inventory.schemaVersion !== '1.0' || inventory.gateId !== report.gateId
      || canonicalJcs(inventory.discoveryContractRef) !== canonicalJcs(report.discoveryContractRef)
      || inventory.discoveryContractDigest !== report.discoveryContractDigest
      || !Array.isArray(inventory.subjects) || inventory.subjects.length === 0) {
    throw new GateBindingError(
      'M2_GATE_BINDING_INVENTORY_SCHEMA',
      `${label} is not the strict report-bound subject inventory`,
      label,
    );
  }
  let previous = null;
  const byId = new Map();
  for (let index = 0; index < inventory.subjects.length; index += 1) {
    const subject = inventory.subjects[index];
    const at = `${label}/subjects/${index}`;
    if (!exactKeys(subject, ['subjectId', 'subjectRef', 'subjectDigest', 'classifier'])
        || !DIGEST_RE.test(subject?.subjectId || '')
        || !DIGEST_RE.test(subject?.subjectDigest || '')
        || !ASCII_ID_RE.test(subject?.classifier || '')
        || !validArtifactRef(subject?.subjectRef)
        || (previous !== null && compareUtf8(previous, subject.subjectId) >= 0)
        || byId.has(subject.subjectId)) {
      throw new GateBindingError(
        'M2_GATE_BINDING_INVENTORY_SUBJECT',
        'inventory subjects are not closed, digest-valid, sorted, and unique',
        at,
      );
    }
    previous = subject.subjectId;
    byId.set(subject.subjectId, subject);
    resolveRawPair(pair(subject.subjectRef, subject.subjectDigest), context, `${at}/artifact`);
  }
  if (report.counts?.discovered !== inventory.subjects.length) {
    throw new GateBindingError(
      'M2_GATE_BINDING_INVENTORY_COUNT',
      'ValidationReport discovered count differs from subject inventory',
      label,
    );
  }
  const seenSubjects = new Set();
  for (let index = 0; index < (report.result?.checks || []).length; index += 1) {
    const check = report.result.checks[index];
    const subject = byId.get(check?.subjectId);
    if (!subject || check.subjectDigest !== subject.subjectDigest
        || canonicalJcs(check.subjectRef) !== canonicalJcs(subject.subjectRef)) {
      throw new GateBindingError(
        'M2_GATE_BINDING_CHECK_SUBJECT',
        'GateCheck subject tuple differs from the resolved inventory',
        `${label}/checks/${index}`,
      );
    }
    seenSubjects.add(check.subjectId);
  }
  if (report.result?.outcome === 'passed' && seenSubjects.size !== byId.size) {
    throw new GateBindingError(
      'M2_GATE_BINDING_CHECK_SET',
      'passed report does not execute every inventoried subject',
      label,
    );
  }
  return inventory.subjects.length;
}

function verifyOneReport(row, gate, context, scope) {
  const label = `${scope}:${row?.gateId || 'unknown'}`;
  if (!gate || row?.gateId !== gate.gateId || row.outcome !== 'passed') {
    throw new GateBindingError(
      'M2_GATE_BINDING_REPORT_ROW',
      `${label} is not a required passed report row`,
      label,
    );
  }
  const resolvedReport = resolveRawPair(pair(row.reportRef, row.reportDigest), context, label);
  const report = strictJcs(resolvedReport.bytes, label);
  if (report.gateId !== gate.gateId || report.recordType !== 'validationReport'
      || report.result?.outcome !== 'passed') {
    throw new GateBindingError(
      'M2_GATE_BINDING_REPORT_IDENTITY',
      `${label} bytes are not its passed ValidationReport`,
      label,
    );
  }
  for (const field of [
    'gateId', 'reportKind', 'criterionRefs', 'toolId', 'capabilityId',
    'capabilityRef', 'capabilityDigest', 'entrypointRef', 'entrypointDigest',
    'discoveryContractRef', 'discoveryContractDigest',
  ]) {
    if (canonicalJcs(report[field]) !== canonicalJcs(gate[field])) {
      throw new GateBindingError(
        'M2_GATE_BINDING_REQUIRED_TUPLE',
        `${label}/${field} differs from the required gate tuple`,
        `${label}/${field}`,
      );
    }
  }
  if (canonicalJcs(report.kindEvidence?.schemaRef)
        !== canonicalJcs(gate.evidenceSchemaRef)
      || report.kindEvidence?.schemaDigest !== gate.evidenceSchemaDigest) {
    throw new GateBindingError(
      'M2_GATE_BINDING_REQUIRED_TUPLE',
      `${label}/kindEvidence schema differs from the required gate tuple`,
      `${label}/kindEvidence`,
    );
  }

  for (const [name, reference, digest, parse] of [
    ['capability', report.capabilityRef, report.capabilityDigest, true],
    ['entrypoint', report.entrypointRef, report.entrypointDigest, false],
    ['discoveryContract', report.discoveryContractRef, report.discoveryContractDigest, true],
    ['evidenceSchema', report.kindEvidence?.schemaRef, report.kindEvidence?.schemaDigest, true],
  ]) {
    const resolved = resolveRawPair(pair(reference, digest), context, `${label}/${name}`);
    if (parse) strictJcs(resolved.bytes, `${label}/${name}`);
    else if (resolved.bytes.length === 0) {
      throw new GateBindingError(
        'M2_GATE_BINDING_ARTIFACT_MISSING',
        `${label}/${name} is empty`,
        `${label}/${name}`,
        'missing',
      );
    }
  }
  for (let index = 0; index < (report.inputs || []).length; index += 1) {
    const input = report.inputs[index];
    resolveRawPair(
      pair(input?.artifactRef, input?.artifactDigest),
      context,
      `${label}/inputs/${index}`,
    );
  }
  const evidence = resolvePair(
    pair(report.kindEvidence?.artifactRef, report.kindEvidence?.artifactDigest),
    context,
    `${label}/kindEvidence`,
  );
  if (evidence.bytes.length === 0) {
    throw new GateBindingError(
      'M2_GATE_BINDING_ARTIFACT_MISSING',
      `${label}/kindEvidence is empty`,
      `${label}/kindEvidence`,
      'missing',
    );
  }
  if (!Array.isArray(report.result?.checks) || report.result.checks.length === 0) {
    throw new GateBindingError(
      'M2_GATE_BINDING_CHECK_SET',
      `${label} has no executable GateCheck set`,
      `${label}/checks`,
    );
  }
  for (let index = 0; index < report.result.checks.length; index += 1) {
    const check = report.result.checks[index];
    for (const field of [
      'toolId', 'capabilityId', 'capabilityRef', 'capabilityDigest',
      'entrypointRef', 'entrypointDigest',
    ]) {
      if (canonicalJcs(check?.[field]) !== canonicalJcs(report[field])) {
        throw new GateBindingError(
          'M2_GATE_BINDING_CHECK_TOOL_TUPLE',
          `${label}/checks/${index}/${field} differs from the ValidationReport`,
          `${label}/checks/${index}/${field}`,
        );
      }
    }
    if (check.status !== 'passed'
        || canonicalJcs(check.evidenceRef) !== canonicalJcs(report.kindEvidence.artifactRef)
        || check.evidenceDigest !== report.kindEvidence.artifactDigest) {
      throw new GateBindingError(
        'M2_GATE_BINDING_CHECK_EVIDENCE',
        `${label}/checks/${index} is not a passed check bound to kindEvidence`,
        `${label}/checks/${index}`,
      );
    }
  }
  const inventoryPair = pair(report.subjectInventoryRef, report.subjectInventoryDigest);
  const resolvedInventory = resolvePair(inventoryPair, context, `${label}/subjectInventory`);
  const inventory = resolvedInventory.value
    || strictJcs(resolvedInventory.bytes, `${label}/subjectInventory`);
  if (taggedJcsDigest(INVENTORY_TAG, inventory) !== report.subjectInventoryDigest) {
    throw new GateBindingError(
      'M2_GATE_BINDING_INVENTORY_DIGEST',
      `${label} subject inventory tagged digest differs`,
      `${label}/subjectInventory`,
    );
  }
  return {
    subjectCount: validateInventory(inventory, report, context, label),
    checkCount: report.result.checks.length,
  };
}

function verifyGateArtifactBindingReplay(options = {}) {
  const issues = [];
  let reportCount = 0;
  let subjectCount = 0;
  let checkCount = 0;
  try {
    const p1 = options.p1;
    const manifest = options.manifest || p1;
    const required = options.requiredGates;
    const artifacts = options.artifacts instanceof Map ? options.artifacts : new Map();
    const sourceArtifacts = options.sourceArtifacts instanceof Map
      ? options.sourceArtifacts : new Map();
    if (!p1 || !manifest || !Array.isArray(required?.gates)
        || !Array.isArray(manifest?.gateReports)
        || artifacts.size === 0 || sourceArtifacts.size === 0) {
      throw new GateBindingError(
        'M2_GATE_BINDING_REPLAY_INPUT_REQUIRED',
        'gate artifact replay requires P1 catalog/payload bytes, report manifest, required gates, and reconstructed source bytes',
        '',
        'unverified',
      );
    }
    const entries = payloadEntryMap(p1);
    const context = {
      artifacts,
      sourceArtifacts,
      entries,
      catalogByPair: loadCatalog(p1, artifacts, entries),
    };
    const gateById = new Map(required.gates.map((gate) => [gate?.gateId, gate]));
    const reportIds = manifest.gateReports.map((row) => row?.gateId);
    const requiredIds = required.gates.map((gate) => gate?.gateId);
    if (gateById.size !== required.gates.length
        || new Set(reportIds).size !== reportIds.length
        || canonicalJcs([...reportIds].sort(compareUtf8))
          !== canonicalJcs([...requiredIds].sort(compareUtf8))) {
      throw new GateBindingError(
        'M2_GATE_BINDING_REPORT_SET',
        'gate report rows do not equal the unique required-gate inventory',
        '/gateReports',
      );
    }
    for (const row of manifest.gateReports) {
      try {
        const result = verifyOneReport(
          row,
          gateById.get(row?.gateId),
          context,
          options.scope || 'p1',
        );
        reportCount += 1;
        subjectCount += result.subjectCount;
        checkCount += result.checkCount;
      } catch (cause) {
        const issue = cause instanceof GateBindingError ? cause : new GateBindingError(
          'M2_GATE_BINDING_REPLAY_ENGINE',
          cause?.message || String(cause),
          row?.gateId || '',
        );
        issues.push({
          code: issue.code,
          path: issue.at,
          kind: issue.kind,
          message: issue.message,
        });
      }
    }
  } catch (cause) {
    const issue = cause instanceof GateBindingError ? cause : new GateBindingError(
      'M2_GATE_BINDING_REPLAY_ENGINE',
      cause?.message || String(cause),
    );
    issues.push({
      code: issue.code,
      path: issue.at,
      kind: issue.kind,
      message: issue.message,
    });
  }
  return {
    outcome: issues.some((issue) => issue.kind === 'invalid')
      ? 'invalid' : issues.length > 0 ? 'incomplete' : 'passed',
    issues,
    reportCount,
    subjectCount,
    checkCount,
    artifactBindingsEstablished: issues.length === 0,
    releaseGateEvidenceEstablished: false,
    declaredEntrypointExecuted: false,
    declaredDiscoveryReplayed: false,
    declaredEvidenceSchemaValidated: false,
    callerEvidenceAccepted: false,
  };
}

module.exports = {
  CATALOG_TAG,
  INVENTORY_TAG,
  GateBindingError,
  artifactKey,
  loadCatalog,
  payloadEntryMap,
  resolvePair,
  resolveRawPair,
  sha256,
  strictJcs,
  taggedJcsDigest,
  validateInventory,
  verifyGateArtifactBindingReplay,
};
