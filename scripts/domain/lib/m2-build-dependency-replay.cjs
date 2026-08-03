'use strict';

const crypto = require('node:crypto');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const {
  ReplayError,
  artifactId,
  replayDependencyExtraction,
  taggedJcsDigest,
} = require('./m2-payload-independent-replay.cjs');

const BUILD_GATE_ID = 'artifact-dependency-dag';
const AGGREGATE_GATE_ID = 'aggregate-pre-manifest';
const MANIFEST_TAG = 'axiolune-artifact-dependency-manifest-v1\0';
const CATALOG_TAG = 'axiolune-payload-artifact-catalog-v1\0';
const BUILD_ROOT_POLICY = 'all-depends-on-validation-reports-v1';
const PHASES = Object.freeze([
  'static', 'p0Build', 'p0Verification', 'promotionAuthorization',
  'p1TreeCommit', 'p0p1Link', 'p1Build', 'payload',
  'payloadVerification', 'approvalEligibility', 'adoptionAttemptChallenge',
  'releaseApproval', 'adoptionRefUpdate', 'adoptedCheckout', 'adoptionCheck',
  'adoptionFailureEvidence', 'rollbackRefUpdate', 'adoptionVerification',
]);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && canonicalJcs(Object.keys(value).sort(compareUtf8))
      === canonicalJcs([...expected].sort(compareUtf8));
}

function artifactKey(reference, digest) {
  return `${canonicalJcs(reference)}\0${digest}`;
}

function canonicalPath(value) {
  return typeof value === 'string' && value.length > 0
    && value === value.normalize('NFC') && !value.startsWith('/')
    && !value.includes('\\') && !/^[A-Za-z]:/u.test(value)
    && value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function strictJcs(bytes, label) {
  if (!Buffer.isBuffer(bytes)) {
    throw new ReplayError('M2_BUILD_DAG_ARTIFACT_MISSING', `${label} is missing`, label, 'missing');
  }
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!bytes.equals(Buffer.from(canonicalJcs(value), 'utf8'))) {
      throw new Error('bytes are not exact UTF-8 RFC 8785 JCS');
    }
    return value;
  } catch (cause) {
    throw new ReplayError('M2_BUILD_DAG_ARTIFACT_JCS', `${label}: ${cause.message}`, label);
  }
}

function requirePayloadPath(reference, label) {
  if (!exactKeys(reference, ['kind', 'root', 'path'])
      || reference.kind !== 'path' || reference.root !== 'payload'
      || !canonicalPath(reference.path)) {
    throw new ReplayError('M2_BUILD_DAG_PAYLOAD_REF', `${label} must be a closed payload path ref`, label);
  }
  return reference.path;
}

function payloadEntryMap(p1) {
  const result = new Map();
  for (const row of Array.isArray(p1?.entries) ? p1.entries : []) {
    if (!canonicalPath(row?.path) || !DIGEST_RE.test(row?.payloadByteDigest || '')
        || result.has(row.path)) {
      throw new ReplayError('M2_BUILD_DAG_PAYLOAD_ENTRY', 'P1 entries are not a unique byte-closed path inventory', '/entries');
    }
    result.set(row.path, row);
  }
  return result;
}

function loadCatalog(p1, artifacts, entries) {
  const path = requirePayloadPath(p1?.payloadArtifactCatalogRef, '/payloadArtifactCatalogRef');
  const bytes = artifacts.get(path);
  const catalog = strictJcs(bytes, path);
  if (!exactKeys(catalog, ['schemaVersion', 'targetVersion', 'entries'])
      || catalog.schemaVersion !== '1.0' || catalog.targetVersion !== p1.targetVersion
      || !Array.isArray(catalog.entries)
      || taggedJcsDigest(CATALOG_TAG, catalog) !== p1.payloadArtifactCatalogDigest) {
    throw new ReplayError('M2_BUILD_DAG_CATALOG', 'payload catalog identity/digest/schema is invalid', path);
  }
  const byPair = new Map();
  let previous = null;
  for (let index = 0; index < catalog.entries.length; index += 1) {
    const row = catalog.entries[index];
    const at = `${path}/entries/${index}`;
    if (!exactKeys(row, [
      'artifactRef', 'artifactDigest', 'payloadByteDigest', 'mediaType', 'locator',
      'digestProfile',
    ]) || !DIGEST_RE.test(row.artifactDigest || '')
        || !DIGEST_RE.test(row.payloadByteDigest || '')) {
      throw new ReplayError('M2_BUILD_DAG_CATALOG_ROW', 'catalog row is not closed', at);
    }
    const key = artifactKey(row.artifactRef, row.artifactDigest);
    if ((previous !== null && compareUtf8(previous, key) >= 0) || byPair.has(key)) {
      throw new ReplayError('M2_BUILD_DAG_CATALOG_ORDER', 'catalog rows are not strictly pair-sorted and unique', at);
    }
    previous = key;
    const locatorPath = row.locator?.path;
    if (!canonicalPath(locatorPath) || !entries.has(locatorPath)) {
      throw new ReplayError('M2_BUILD_DAG_CATALOG_LOCATOR', 'catalog locator is not a P1 payload entry', at);
    }
    const located = artifacts.get(locatorPath);
    if (!Buffer.isBuffer(located)) {
      throw new ReplayError('M2_BUILD_DAG_CATALOG_BYTES', 'catalog locator payload is missing', locatorPath, 'missing');
    }
    if (sha256(located) !== row.payloadByteDigest
        || entries.get(locatorPath).payloadByteDigest !== row.payloadByteDigest) {
      throw new ReplayError('M2_BUILD_DAG_CATALOG_BYTES', 'catalog locator bytes differ from its P1 binding', locatorPath);
    }
    byPair.set(key, row);
  }
  return { catalog, byPair };
}

function resolvePointer(value, pointer) {
  if (pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error('invalid JSON Pointer');
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/u.test(raw)) throw new Error('invalid JSON Pointer escape');
    const token = raw.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (Array.isArray(current) && /^(0|[1-9][0-9]*)$/u.test(token)
        && Number(token) < current.length) current = current[Number(token)];
    else if (current && typeof current === 'object' && Object.hasOwn(current, token)) current = current[token];
    else throw new Error('unresolved JSON Pointer');
  }
  return current;
}

function resolveSemanticPair(pair, context, label) {
  const row = context.catalogByPair.get(artifactKey(pair.artifactRef, pair.artifactDigest));
  if (row) {
    const located = context.artifacts.get(row.locator.path);
    let selectedBytes;
    let selectedValue = null;
    if (row.locator.kind === 'wholeFile') {
      selectedBytes = located;
    } else if (row.locator.kind === 'jsonValue') {
      const container = strictJcs(located, row.locator.path);
      selectedValue = resolvePointer(container, row.locator.pointer);
      selectedBytes = Buffer.from(canonicalJcs(selectedValue), 'utf8');
    } else {
      throw new ReplayError('M2_BUILD_DAG_CATALOG_PROFILE', `${label} requires wholeFile or jsonValue resolution`, label, 'unverified');
    }
    let semanticDigest;
    if (row.digestProfile?.kind === 'rawBytes' && row.digestProfile.algorithm === 'sha256') {
      semanticDigest = sha256(selectedBytes);
    } else if (row.digestProfile?.kind === 'taggedJcs'
        && row.digestProfile.canonicalization === 'RFC8785-JCS'
        && typeof row.digestProfile.domainTag === 'string') {
      if (selectedValue === null) selectedValue = strictJcs(selectedBytes, label);
      semanticDigest = taggedJcsDigest(row.digestProfile.domainTag, selectedValue);
    } else {
      throw new ReplayError('M2_BUILD_DAG_CATALOG_PROFILE', `${label} has no executable rawBytes/taggedJcs profile`, label, 'unverified');
    }
    if (semanticDigest !== pair.artifactDigest) {
      throw new ReplayError('M2_BUILD_DAG_ARTIFACT_DIGEST', `${label} semantic digest differs`, label);
    }
    return { bytes: selectedBytes, value: selectedValue };
  }
  if (pair.artifactRef?.kind === 'path' && pair.artifactRef.root === 'payload'
      && canonicalPath(pair.artifactRef.path)) {
    const bytes = context.artifacts.get(pair.artifactRef.path);
    if (!Buffer.isBuffer(bytes) || sha256(bytes) !== pair.artifactDigest
        || context.entries.get(pair.artifactRef.path)?.payloadByteDigest !== pair.artifactDigest) {
      throw new ReplayError('M2_BUILD_DAG_ARTIFACT_DIGEST', `${label} direct payload bytes differ`, label);
    }
    return { bytes, value: strictJcs(bytes, label) };
  }
  if (pair.artifactRef?.kind === 'path' && pair.artifactRef.root === 'sourceTree'
      && canonicalPath(pair.artifactRef.path)) {
    const bytes = context.sourceArtifacts.get(pair.artifactRef.path);
    if (!Buffer.isBuffer(bytes) || sha256(bytes) !== pair.artifactDigest) {
      throw new ReplayError('M2_BUILD_DAG_ARTIFACT_DIGEST', `${label} source bytes differ`, label);
    }
    return { bytes, value: strictJcs(bytes, label) };
  }
  throw new ReplayError('M2_BUILD_DAG_ARTIFACT_RESOLUTION', `${label} has no independent offline resolution`, label, 'missing');
}

function reportPair(row) {
  return { artifactRef: row.reportRef, artifactDigest: row.reportDigest };
}

function loadReport(row, expectedGateId, context) {
  if (!row || row.gateId !== expectedGateId || row.outcome !== 'passed'
      || !DIGEST_RE.test(row.reportDigest || '')) {
    throw new ReplayError('M2_BUILD_DAG_REPORT_ROW', `${expectedGateId} has no exact passed gate-report row`, `/gateReports/${expectedGateId}`, 'missing');
  }
  const pair = reportPair(row);
  const resolved = resolveSemanticPair(pair, context, `${expectedGateId} ValidationReport`);
  const report = resolved.value;
  if (!report || report.recordType !== 'validationReport' || report.gateId !== expectedGateId
      || report.result?.outcome !== 'passed') {
    throw new ReplayError('M2_BUILD_DAG_REPORT_IDENTITY', `${expectedGateId} resolved bytes are not its passed ValidationReport`, `/gateReports/${expectedGateId}`);
  }
  return { row, pair, report };
}

function validateAuthoredManifest(manifest, manifestPair) {
  const fields = [
    'schemaVersion', 'scope', 'phaseRegistryRef', 'phaseRegistryDigest',
    'extractorCapabilityRef', 'extractorCapabilityDigest', 'roots', 'nodes', 'edges',
  ];
  if (!exactKeys(manifest, fields) || manifest.schemaVersion !== '1.0'
      || manifest.scope !== 'build' || !Array.isArray(manifest.roots)
      || !Array.isArray(manifest.nodes) || !Array.isArray(manifest.edges)
      || taggedJcsDigest(MANIFEST_TAG, manifest) !== manifestPair.artifactDigest) {
    throw new ReplayError('M2_BUILD_DAG_MANIFEST_SCHEMA', 'build dependency manifest schema/scope/digest is invalid', '/kindEvidence');
  }
  let previousRoot = null;
  for (const root of manifest.roots) {
    if (!DIGEST_RE.test(root) || (previousRoot !== null && compareUtf8(previousRoot, root) >= 0)) {
      throw new ReplayError('M2_BUILD_DAG_ROOT_ORDER', 'build roots are not strictly artifactId-sorted and unique', '/roots');
    }
    previousRoot = root;
  }
  let previousNode = null;
  for (const node of manifest.nodes) {
    if (!exactKeys(node, [
      'artifactId', 'artifactRef', 'artifactDigest', 'artifactKind', 'phase',
      'finalizationOrdinal',
    ]) || artifactId(node) !== node.artifactId
        || (previousNode !== null && compareUtf8(previousNode, node.artifactId) >= 0)) {
      throw new ReplayError('M2_BUILD_DAG_NODE_SCHEMA', 'build nodes are not closed/id-valid/sorted', '/nodes');
    }
    previousNode = node.artifactId;
  }
}

function verifyForwardEdges(extracted) {
  const byId = new Map(extracted.nodes.map((node) => [node.artifactId, node]));
  for (const edge of extracted.edges) {
    const prerequisite = byId.get(edge.prerequisiteArtifactId);
    const dependent = byId.get(edge.dependentArtifactId);
    const before = prerequisite && dependent && (
      PHASES.indexOf(prerequisite.phase) < PHASES.indexOf(dependent.phase)
        || (prerequisite.phase === dependent.phase
          && prerequisite.finalizationOrdinal < dependent.finalizationOrdinal)
    );
    if (!before) {
      throw new ReplayError('M2_BUILD_DAG_BACK_EDGE', 'independently extracted build dependency is not strictly forward', '/edges');
    }
  }
}

function verifyBuildDependencyReplay(options = {}) {
  const issues = [];
  try {
    const p1 = options.p1;
    const required = options.requiredGates;
    const artifacts = options.artifacts instanceof Map ? options.artifacts : new Map();
    const sourceArtifacts = options.sourceArtifacts instanceof Map
      ? options.sourceArtifacts : new Map();
    if (!p1 || !Array.isArray(required?.gates) || artifacts.size === 0
        || sourceArtifacts.size === 0) {
      throw new ReplayError('M2_BUILD_DAG_REPLAY_INPUT_REQUIRED', 'build DAG replay requires P1, required gates, payload bytes, and reconstructed P1 source bytes', '', 'unverified');
    }
    const gateById = new Map(required.gates.map((gate) => [gate?.gateId, gate]));
    const buildGate = gateById.get(BUILD_GATE_ID);
    if (!buildGate || !Array.isArray(buildGate.dependsOn) || buildGate.dependsOn.length === 0
        || buildGate.dependsOn.includes(BUILD_GATE_ID)
        || buildGate.dependsOn.includes(AGGREGATE_GATE_ID)) {
      throw new ReplayError('M2_BUILD_DAG_REQUIRED_GATE', 'artifact-dependency-dag has no valid fixed dependsOn root policy', '/gates/artifact-dependency-dag');
    }
    const expectedDependsOn = required.gates
      .map((gate) => gate.gateId)
      .filter((gateId) => ![BUILD_GATE_ID, AGGREGATE_GATE_ID].includes(gateId))
      .sort(compareUtf8);
    if (canonicalJcs(buildGate.dependsOn) !== canonicalJcs(expectedDependsOn)) {
      throw new ReplayError('M2_BUILD_DAG_REQUIRED_GATE', 'artifact-dependency-dag dependsOn is not the exact ordinary-gate inventory', '/gates/artifact-dependency-dag/dependsOn');
    }

    const entries = payloadEntryMap(p1);
    const catalog = loadCatalog(p1, artifacts, entries);
    const context = {
      artifacts,
      sourceArtifacts,
      entries,
      catalogByPair: catalog.byPair,
    };
    const rows = Array.isArray(p1.gateReports) ? p1.gateReports : [];
    const rowById = new Map(rows.map((row) => [row?.gateId, row]));
    const rootReports = buildGate.dependsOn.map((gateId) => (
      loadReport(rowById.get(gateId), gateId, context)
    ));
    const buildReport = loadReport(rowById.get(BUILD_GATE_ID), BUILD_GATE_ID, context);
    const manifestPair = buildReport.report.kindEvidence;
    if (!exactKeys(manifestPair, ['schemaRef', 'schemaDigest', 'artifactRef', 'artifactDigest'])) {
      throw new ReplayError('M2_BUILD_DAG_KIND_EVIDENCE', 'artifact-dependency-dag kindEvidence is not closed', '/kindEvidence');
    }
    const resolvedManifest = resolveSemanticPair(
      { artifactRef: manifestPair.artifactRef, artifactDigest: manifestPair.artifactDigest },
      context,
      'build dependency manifest',
    );
    const manifest = resolvedManifest.value || strictJcs(resolvedManifest.bytes, 'build dependency manifest');
    validateAuthoredManifest(manifest, manifestPair);

    const rootPairs = rootReports.map(({ pair }) => pair);
    const aggregateRow = rowById.get(AGGREGATE_GATE_ID);
    const excludedArtifactPairs = [buildReport.pair];
    if (aggregateRow?.reportRef && aggregateRow?.reportDigest) excludedArtifactPairs.push(reportPair(aggregateRow));
    const extracted = replayDependencyExtraction({
      sourceArtifacts,
      trustedSourceArtifacts: options.trustedSourceArtifacts,
      trustedRoot: options.trustedRoot,
      payloadArtifacts: artifacts,
      payloadEntries: p1.entries,
      catalog: catalog.catalog,
      catalogByPair: catalog.byPair,
      dependencyManifestRef: manifestPair.artifactRef,
      dependencyManifestDigest: manifestPair.artifactDigest,
      excludedArtifactPairs,
      phaseRegistryRef: manifest.phaseRegistryRef,
      phaseRegistryDigest: manifest.phaseRegistryDigest,
      extractorCapabilityRef: manifest.extractorCapabilityRef,
      extractorCapabilityDigest: manifest.extractorCapabilityDigest,
      phases: PHASES,
      scope: 'build',
      rootPolicy: BUILD_ROOT_POLICY,
      rootPairs,
    });
    verifyForwardEdges(extracted);
    for (const [field, value] of [
      ['roots', extracted.roots],
      ['nodes', extracted.nodes],
      ['edges', extracted.edges],
    ]) {
      if (canonicalJcs(manifest[field]) !== canonicalJcs(value)) {
        throw new ReplayError('M2_BUILD_DAG_REPLAY_MISMATCH', `authored ${field} differ from independent extraction`, `/${field}`);
      }
    }
    if (extracted.callerGraphAccepted !== false
        || extracted.roots.length !== buildGate.dependsOn.length) {
      throw new ReplayError('M2_BUILD_DAG_REPLAY_CLOSURE', 'build DAG replay did not preserve the fixed root/caller-evidence boundary', '/roots');
    }
    return {
      outcome: 'passed',
      issues,
      gateId: BUILD_GATE_ID,
      rootCount: extracted.roots.length,
      nodeCount: extracted.nodeCount,
      edgeCount: extracted.edgeCount,
      callerGraphAccepted: false,
      // The independent verifier function is not the entrypoint currently
      // declared by the required-gate/toolchain tuple.  Preserve the useful
      // graph replay result while refusing to promote it to gate evidence.
      releaseGateEvidenceEstablished: false,
      declaredEntrypointExecuted: false,
      declaredDiscoveryReplayed: false,
      declaredEvidenceSchemaValidated: false,
      callerEvidenceAccepted: false,
    };
  } catch (cause) {
    const issue = cause instanceof ReplayError ? cause : {
      code: 'M2_BUILD_DAG_REPLAY_ENGINE',
      path: '',
      kind: 'invalid',
      message: cause?.message || String(cause),
    };
    issues.push({
      code: issue.code,
      path: issue.path || '',
      kind: issue.kind || 'invalid',
      message: issue.message,
    });
    return {
      outcome: issues.some((row) => row.kind === 'invalid') ? 'invalid' : 'incomplete',
      issues,
      gateId: BUILD_GATE_ID,
      rootCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      callerGraphAccepted: null,
      releaseGateEvidenceEstablished: false,
      declaredEntrypointExecuted: false,
      declaredDiscoveryReplayed: false,
      declaredEvidenceSchemaValidated: false,
      callerEvidenceAccepted: false,
    };
  }
}

module.exports = {
  AGGREGATE_GATE_ID,
  BUILD_GATE_ID,
  BUILD_ROOT_POLICY,
  MANIFEST_TAG,
  PHASES,
  verifyBuildDependencyReplay,
};
