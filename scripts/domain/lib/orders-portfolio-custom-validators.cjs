'use strict';

const crypto = require('node:crypto');
const {
  canonicalJcs,
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');
const {
  DEFAULT_VALUATION_PRECISION_POLICY,
  costBasisDirectUnitValueRaw,
  directUnitValueRaw,
  fxValueRaw,
  isCostBasisPrecisionPolicy,
  isCostBasisRoundingPolicy,
  isValuationPrecisionPolicy,
  isValuationRoundingPolicy,
  remainingBasisRaw,
} = require('./orders-portfolio-exact-arithmetic.cjs');

const ORDERS = 'https://axiolune.ai/ontology/finance/orders-execution/';
const PORTFOLIO = 'https://axiolune.ai/ontology/finance/portfolio-positions/';
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u;
const IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/u;
const PIT_INGRESS_SCHEMA_VERSION = '1.0';
const PIT_INGRESS_VERIFIER_ID = 'axiolune.orders-portfolio.pit-ingress-verifier.v1';
const SOURCE_EXTRACTOR_PROFILE_REF =
  'https://axiolune.ai/extractors/orders-portfolio-canonical-whole-file/v1';
const SOURCE_EXTRACTOR_PROFILE_PAYLOAD = Object.freeze({
  canonicalization: 'RFC8785-JCS-safe-integer-profile',
  extractorKind: 'wholeFile',
  mediaType: 'application/json',
  profileId: 'orders-portfolio-canonical-whole-file-v1',
  schemaVersion: '1.0',
  selectionDigestDomain: 'axiolune-source-selection-v1',
});

class CustomConstraintViolation extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'CustomConstraintViolation';
    this.code = code;
  }
}

function reject(code, message) {
  throw new CustomConstraintViolation(code, message);
}

function requireCondition(condition, code, message) {
  if (!condition) reject(code, message);
}

function closedObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function sha256Jcs(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJcs(value), 'utf8').digest('hex')}`;
}

function sha256DomainJcs(domain, value) {
  requireCondition(
    typeof domain === 'string' && domain.length > 0 && !domain.includes('\0'),
    'DOMAIN_JCS_INPUT',
    'JCS digest domain must be a non-empty NUL-free string',
  );
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(`${domain}\0`, 'utf8'));
  hash.update(Buffer.from(canonicalJcs(value), 'utf8'));
  return `sha256:${hash.digest('hex')}`;
}

function u64be(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function rawDigestBytes(value, code = 'DIGEST_INPUT') {
  requireCondition(digest(value), code, 'value must be a lowercase SHA-256 Digest');
  return Buffer.from(value.slice('sha256:'.length), 'hex');
}

function taggedJcsDigest(tag, value) {
  requireCondition(
    typeof tag === 'string'
      && tag.endsWith('\0')
      && !tag.slice(0, -1).includes('\0'),
    'TAGGED_JCS_INPUT',
    'JCS digest tag must contain exactly one terminal NUL',
  );
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from(tag, 'utf8'));
  hash.update(Buffer.from(canonicalJcs(value), 'utf8'));
  return `sha256:${hash.digest('hex')}`;
}

function artifactRefSortKey(value) {
  const validation = validateArtifactRef(value, 'artifactRef');
  requireCondition(
    validation.ok,
    'ARTIFACT_REF_INPUT',
    validation.errors.join('; '),
  );
  return value.kind === 'iri'
    ? `iri\0${value.iri}`
    : `path\0${value.root}\0${value.path}`;
}

function sourceSnapshotRootDigest(inputDatasets) {
  requireCondition(
    Array.isArray(inputDatasets) && inputDatasets.length > 0,
    'SOURCE_SNAPSHOT_ROOT_INPUT',
    'inputDatasets must be non-empty',
  );
  const ordered = [...inputDatasets].sort(
    (left, right) => compareUtf8(left.dataset, right.dataset),
  );
  requireCondition(
    new Set(ordered.map((row) => row.dataset)).size === ordered.length,
    'SOURCE_SNAPSHOT_ROOT_INPUT',
    'inputDatasets contain a duplicate dataset IRI',
  );
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('axiolune-source-snapshot-root-v1\0', 'utf8'));
  hash.update(u64be(ordered.length));
  for (const row of ordered) {
    let snapshotRefKey = null;
    try {
      snapshotRefKey = artifactRefSortKey(row?.snapshotRef);
    } catch {
      // The closed input check below reports the public helper error.
    }
    requireCondition(
      row
        && iri(row.dataset)
        && snapshotRefKey !== null
        && digest(row.artifactDigest)
        && digest(row.schemaDigest)
        && instantNanoseconds(row.snapshotTime) !== null
        && (row.rowCount === undefined
          || (Number.isSafeInteger(row.rowCount) && row.rowCount >= 0)),
      'SOURCE_SNAPSHOT_ROOT_INPUT',
      'input dataset snapshot is incomplete',
    );
    const datasetBytes = Buffer.from(row.dataset, 'utf8');
    const snapshotRefBytes = Buffer.from(snapshotRefKey, 'utf8');
    hash.update(u64be(datasetBytes.length));
    hash.update(datasetBytes);
    hash.update(u64be(snapshotRefBytes.length));
    hash.update(snapshotRefBytes);
    hash.update(rawDigestBytes(row.artifactDigest));
    hash.update(rawDigestBytes(row.schemaDigest));
  }
  return `sha256:${hash.digest('hex')}`;
}

function sourceSchemaClosureDigest(inputDatasets) {
  requireCondition(
    Array.isArray(inputDatasets) && inputDatasets.length > 0,
    'SOURCE_SCHEMA_ROOT_INPUT',
    'inputDatasets must be non-empty',
  );
  const ordered = [...inputDatasets].sort(
    (left, right) => compareUtf8(left.dataset, right.dataset),
  );
  requireCondition(
    new Set(ordered.map((row) => row.dataset)).size === ordered.length,
    'SOURCE_SCHEMA_ROOT_INPUT',
    'inputDatasets contain a duplicate dataset IRI',
  );
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('axiolune-source-schema-closure-v1\0', 'utf8'));
  hash.update(u64be(ordered.length));
  for (const row of ordered) {
    requireCondition(
      row && iri(row.dataset) && digest(row.schemaDigest),
      'SOURCE_SCHEMA_ROOT_INPUT',
      'input dataset schema binding is incomplete',
    );
    const datasetBytes = Buffer.from(row.dataset, 'utf8');
    hash.update(u64be(datasetBytes.length));
    hash.update(datasetBytes);
    hash.update(rawDigestBytes(row.schemaDigest));
  }
  return `sha256:${hash.digest('hex')}`;
}

function mappingClosureDigest(entries) {
  requireCondition(
    Array.isArray(entries) && entries.length > 0,
    'MAPPING_CLOSURE_INPUT',
    'mapping closure must be non-empty',
  );
  const ordered = [...entries].sort(
    (left, right) => compareUtf8(left.mappingRef, right.mappingRef),
  );
  requireCondition(
    new Set(ordered.map((row) => row.mappingRef)).size === ordered.length,
    'MAPPING_CLOSURE_INPUT',
    'mapping closure contains a duplicate mappingRef',
  );
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('axiolune-mapping-closure-v1\0', 'utf8'));
  hash.update(u64be(ordered.length));
  for (const row of ordered) {
    requireCondition(
      row
        && iri(row.mappingRef)
        && digest(row.mappingSourceDigest)
        && digest(row.transformationClosureDigest),
      'MAPPING_CLOSURE_INPUT',
      'mapping closure entry is incomplete',
    );
    const mappingBytes = Buffer.from(row.mappingRef, 'utf8');
    const closureBytes = Buffer.from(
      artifactRefSortKey(row.transformationClosureRef),
      'utf8',
    );
    hash.update(u64be(mappingBytes.length));
    hash.update(mappingBytes);
    hash.update(rawDigestBytes(row.mappingSourceDigest));
    hash.update(u64be(closureBytes.length));
    hash.update(closureBytes);
    hash.update(rawDigestBytes(row.transformationClosureDigest));
  }
  return `sha256:${hash.digest('hex')}`;
}

function rdfGraphDigest(canonicalNQuads) {
  requireCondition(
    typeof canonicalNQuads === 'string'
      && canonicalNQuads.length > 0
      && canonicalNQuads.endsWith('\n'),
    'RDF_GRAPH_INPUT',
    'canonical N-Quads must be non-empty and newline terminated',
  );
  const lines = canonicalNQuads.slice(0, -1).split('\n');
  requireCondition(
    lines.every((line) => line.length > 0)
      && lines.every(
        (line, index) => index === 0 || compareUtf8(lines[index - 1], line) < 0,
      ),
    'RDF_GRAPH_INPUT',
    'canonical N-Quads must be strictly byte-sorted and duplicate-free',
  );
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('axiolune-rdf-graph-v1\0', 'utf8'));
  hash.update(Buffer.from(canonicalNQuads, 'utf8'));
  return `sha256:${hash.digest('hex')}`;
}

function controlRecordIri(
  buildId,
  slotId,
  recordType,
  recordId,
  attemptId,
  plannedInputDigest,
) {
  for (const [label, value] of [
    ['slotId', slotId],
    ['recordType', recordType],
    ['recordId', recordId],
    ['attemptId', attemptId],
  ]) {
    requireCondition(
      typeof value === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value),
      'CONTROL_RECORD_ID_INPUT',
      `${label} must be an ASCII RecordId`,
    );
  }
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('axiolune-control-record-iri-v1\0', 'utf8'));
  hash.update(rawDigestBytes(buildId));
  for (const value of [slotId, recordType, recordId, attemptId]) {
    const bytes = Buffer.from(value, 'utf8');
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  hash.update(rawDigestBytes(plannedInputDigest));
  return `urn:axiolune:control:${recordType}:sha256-${hash.digest('hex')}`;
}

function iriSetDigest(values) {
  if (!Array.isArray(values) || values.some((value) => !iri(value))
      || new Set(values).size !== values.length) {
    reject('IRI_SET_INPUT', 'IRI set must contain unique absolute IRIs');
  }
  const sorted = [...values].sort(compareUtf8);
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('axiolune-iri-set-v1\0', 'utf8'));
  hash.update(u64be(sorted.length));
  for (const value of sorted) {
    const bytes = Buffer.from(value, 'utf8');
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function iri(value) {
  return typeof value === 'string' && IRI.test(value);
}

function digest(value) {
  return typeof value === 'string' && DIGEST.test(value);
}

function validJsonPointer(value) {
  return typeof value === 'string' && /^(?:\/(?:[^~]|~[01])*)+$/u.test(value);
}

function resolveJsonPointer(document, pointer) {
  if (!validJsonPointer(pointer)) return { found: false, value: undefined };
  let current = document;
  const tokens = pointer.slice(1).split('/').map((token) => token.replace(/~1/gu, '/').replace(/~0/gu, '~'));
  for (const token of tokens) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, token)) {
      return { found: false, value: undefined };
    }
    current = current[token];
  }
  return { found: true, value: current };
}

function sourceLexicalValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Number.isSafeInteger(value)) return String(value);
  return null;
}

function instantNanoseconds(value) {
  if (typeof value !== 'string') return null;
  const match = INSTANT.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ''] = match;
  const fields = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = fields;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (!Number.isFinite(date.getTime())
      || date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day
      || date.getUTCHours() !== hour
      || date.getUTCMinutes() !== minute
      || date.getUTCSeconds() !== second) return null;
  return BigInt(Math.trunc(date.getTime() / 1000)) * 1_000_000_000n
    + BigInt(fraction.padEnd(9, '0') || '0');
}

function exactVersion(value) {
  return iri(value) && /\/version\/[A-Za-z0-9._~:-]+$/u.test(value);
}

function logicalRef(value) {
  return value && value.referenceMode === 'logical' && iri(value.logicalIri)
    && !Object.hasOwn(value, 'versionIri');
}

function versionRef(value) {
  return value && value.referenceMode === 'version' && iri(value.logicalIri)
    && exactVersion(value.versionIri);
}

function temporal(value, code = 'TEMPORAL_CONTRACT') {
  requireCondition(value && instantNanoseconds(value.validFrom) !== null
    && instantNanoseconds(value.knowledgeFrom) !== null
    && instantNanoseconds(value.availableFrom) !== null
    && Number.isSafeInteger(value.revision) && value.revision >= 0,
  code, 'valid/knowledge/availability/revision are incomplete');
  requireCondition(
    !Object.hasOwn(value, 'validTo')
      || (
        instantNanoseconds(value.validTo) !== null
        && instantNanoseconds(value.validFrom)
          < instantNanoseconds(value.validTo)
      ),
    code,
    'validTo must be a valid exclusive bound strictly after validFrom',
  );
  requireCondition(
    instantNanoseconds(value.knowledgeFrom)
      <= instantNanoseconds(value.availableFrom),
    code,
    'availableFrom cannot precede knowledgeFrom',
  );
  requireCondition(!Object.hasOwn(value, 'knowledgeTo') && !Object.hasOwn(value, 'availableTo'), code,
    'mutable knowledge/availability ends are forbidden on the version');
}

function evidence(value, code) {
  requireCondition(value && iri(value.ref) && digest(value.digest)
    && value.digest !== `sha256:${'0'.repeat(64)}`, code, 'evidence ref/digest pair is incomplete');
}

function authenticatedSourceEvidence(value, code) {
  evidence(value, code);
  requireCondition(
    closedObject(value, [
      'digest',
      'extractorProfile',
      'locator',
      'mediaType',
      'payload',
      'ref',
    ])
      && value.mediaType === 'application/json'
      && value.digest === sha256Jcs(value.payload),
    code,
    'source evidence is not a closed ref/digest/canonical-byte artifact tuple',
  );
  const profileDigest = sha256Jcs(SOURCE_EXTRACTOR_PROFILE_PAYLOAD);
  requireCondition(
    closedObject(value.extractorProfile, [
      'digest', 'mediaType', 'payload', 'ref',
    ])
      && value.extractorProfile.ref === SOURCE_EXTRACTOR_PROFILE_REF
      && value.extractorProfile.digest === profileDigest
      && value.extractorProfile.mediaType === 'application/json'
      && canonicalJcs(value.extractorProfile.payload)
        === canonicalJcs(SOURCE_EXTRACTOR_PROFILE_PAYLOAD)
      && value.locator?.kind === 'wholeFile'
      && value.locator?.mediaType === value.mediaType
      && value.locator?.extractorProfileRef?.kind === 'iri'
      && value.locator.extractorProfileRef.iri === SOURCE_EXTRACTOR_PROFILE_REF
      && value.locator.extractorProfileDigest === profileDigest,
    code,
    'source evidence extractor profile tuple is not exactly locked',
  );
  const selectedBytes = Buffer.from(canonicalJcs(value.payload), 'utf8');
  const locatorResult = validateSourceLocator(value.locator, {
    at: 'sourceEvidence.locator',
    selectedBytes,
  });
  requireCondition(
    locatorResult.ok,
    code,
    `source evidence locator is invalid: ${locatorResult.errors.join('; ')}`,
  );
}

function policyArtifact(value, validator, code, label) {
  requireCondition(value && iri(value.ref) && digest(value.digest) && validator(value.payload)
    && value.digest === sha256Jcs(value.payload), code, `${label} ref/digest/payload is invalid`);
}

function pitIngressArtifactRef(pitRequestRef, role) {
  requireCondition(
    iri(pitRequestRef)
      && typeof role === 'string'
      && /^[a-z][a-z0-9-]+$/u.test(role),
    'PIT_INGRESS_BUILD_INPUT',
    'PIT request ref or ingress artifact role is invalid',
  );
  const requestKey = sha256Jcs({
    pitRequestRef,
    schemaVersion: PIT_INGRESS_SCHEMA_VERSION,
  }).slice('sha256:'.length);
  return `urn:axiolune:pit-ingress:${requestKey}:${role}`;
}

function pitIngressArtifact(ref, payload) {
  return {
    digest: sha256Jcs(payload),
    payload,
    ref,
  };
}

/**
 * Produce the only admissible PIT ingress evidence bytes.  The runtime calls
 * this independently during validation and compares every supplied artifact
 * against the reconstructed result; the supplied report/run/ledger are not
 * trusted as assertions merely because their own digests are internally
 * consistent.
 */
function buildVerifierOwnedPitIngress(
  pitRequest,
  selectedFactVersionIris,
  materializedOutputDescriptor = undefined,
) {
  const hasMaterializedOutput = materializedOutputDescriptor !== undefined;
  requireCondition(
    pitRequest
      && iri(pitRequest.ref)
      && digest(pitRequest.digest)
      && pitRequest.payload
      && pitRequest.digest === sha256Jcs(pitRequest.payload)
      && sortedUnique(selectedFactVersionIris)
      && selectedFactVersionIris.every(exactVersion),
    'PIT_INGRESS_BUILD_INPUT',
    'PIT request or selected FactVersion inventory is not canonical',
  );
  if (hasMaterializedOutput) {
    requireCondition(
      closedObject(materializedOutputDescriptor, [
        'outputFactTypeIri',
        'outputFactVersionIri',
        'outputRecord',
        'selectionBindings',
      ])
        && iri(materializedOutputDescriptor.outputFactTypeIri)
        && exactVersion(materializedOutputDescriptor.outputFactVersionIri)
        && materializedOutputDescriptor.outputRecord
        && typeof materializedOutputDescriptor.outputRecord === 'object'
        && !Array.isArray(materializedOutputDescriptor.outputRecord)
        && materializedOutputDescriptor.outputRecord.typeIri
          === materializedOutputDescriptor.outputFactTypeIri
        && materializedOutputDescriptor.outputRecord.versionIri
          === materializedOutputDescriptor.outputFactVersionIri
        && Array.isArray(materializedOutputDescriptor.selectionBindings)
        && materializedOutputDescriptor.selectionBindings.length > 0,
      'PIT_INGRESS_BUILD_INPUT',
      'materialized output must bind one exact-version canonical output record',
    );
    let previousRole = null;
    const boundVersions = [];
    for (const binding of materializedOutputDescriptor.selectionBindings) {
      requireCondition(
        closedObject(binding, ['factVersionIris', 'role'])
          && typeof binding.role === 'string'
          && /^[a-z][A-Za-z0-9]*$/u.test(binding.role)
          && (previousRole === null || compareUtf8(previousRole, binding.role) < 0)
          && sortedUnique(binding.factVersionIris)
          && binding.factVersionIris.length > 0
          && binding.factVersionIris.every(exactVersion),
        'PIT_INGRESS_BUILD_INPUT',
        'selection bindings must be role-sorted closed exact-version sets',
      );
      previousRole = binding.role;
      boundVersions.push(...binding.factVersionIris);
    }
    const boundVersionSet = selectedFactVersionClosure(boundVersions);
    requireCondition(
      canonicalJcs(boundVersionSet) === canonicalJcs(selectedFactVersionIris),
      'PIT_INGRESS_BUILD_INPUT',
      'selection binding union does not equal the selected FactVersion inventory',
    );
    // Reject values which RFC 8785 cannot represent before constructing any
    // evidence. This also makes the output-record digest an exact-JCS digest,
    // rather than a digest of an implementation-specific object rendering.
    canonicalJcs(materializedOutputDescriptor.outputRecord);
  }
  const selected = structuredClone(selectedFactVersionIris);
  const selectedFactVersionSetDigest = iriSetDigest(selected);
  const inventoryRef = pitIngressArtifactRef(
    pitRequest.ref,
    'selected-fact-version-inventory',
  );
  const runRef = pitIngressArtifactRef(pitRequest.ref, 'materialization-run');
  const selectionRequestRef = hasMaterializedOutput
    ? pitIngressArtifactRef(pitRequest.ref, 'fact-version-selection-request')
    : null;
  const outputRef = hasMaterializedOutput
    ? pitIngressArtifactRef(pitRequest.ref, 'materialized-fact-output')
    : null;
  const reportRef = pitIngressArtifactRef(pitRequest.ref, 'validation-report');
  const ledgerRef = pitIngressArtifactRef(pitRequest.ref, 'evidence-ledger');
  const selectionRequest = hasMaterializedOutput
    ? pitIngressArtifact(selectionRequestRef, {
      artifactKind: 'FactVersionSelectionRequest',
      asOfAvailable: pitRequest.payload.availableAt,
      asOfKnowledge: pitRequest.payload.knowledgeAt,
      asOfValid: pitRequest.payload.validAt,
      outputFactTypeIri: materializedOutputDescriptor.outputFactTypeIri,
      outputFactVersionIri: materializedOutputDescriptor.outputFactVersionIri,
      pitRequestDigest: pitRequest.digest,
      pitRequestRef: pitRequest.ref,
      schemaVersion: PIT_INGRESS_SCHEMA_VERSION,
      selectedFactVersionCount: selected.length,
      selectedFactVersionSetDigest,
      selectionBindings: structuredClone(
        materializedOutputDescriptor.selectionBindings,
      ),
      selectionContractDigest: sha256DomainJcs(
        'axiolune-fact-version-selection-contract-v1',
        {
          outputFactTypeIri: materializedOutputDescriptor.outputFactTypeIri,
          selectionBindings: materializedOutputDescriptor.selectionBindings,
        },
      ),
      selectionRequestRef,
    })
    : null;
  const inventory = pitIngressArtifact(inventoryRef, {
    artifactKind: 'SelectedFactVersionInventory',
    inventoryRef,
    pitRequestDigest: pitRequest.digest,
    pitRequestRef: pitRequest.ref,
    schemaVersion: PIT_INGRESS_SCHEMA_VERSION,
    ...(selectionRequest === null ? {} : {
      selectionRequestDigest: selectionRequest.digest,
      selectionRequestRef: selectionRequest.ref,
    }),
    selectedFactVersionCount: selected.length,
    selectedFactVersionIris: selected,
    selectedFactVersionSetDigest,
  });
  const materializedOutput = hasMaterializedOutput
    ? pitIngressArtifact(outputRef, {
      artifactKind: 'MaterializedFactOutput',
      outputFactTypeIri: materializedOutputDescriptor.outputFactTypeIri,
      outputFactVersionIri: materializedOutputDescriptor.outputFactVersionIri,
      outputRecord: structuredClone(materializedOutputDescriptor.outputRecord),
      outputRecordDigest: sha256Jcs(materializedOutputDescriptor.outputRecord),
      outputRef,
      pitRequestDigest: pitRequest.digest,
      pitRequestRef: pitRequest.ref,
      schemaVersion: PIT_INGRESS_SCHEMA_VERSION,
      selectionRequestDigest: selectionRequest.digest,
      selectionRequestRef: selectionRequest.ref,
      selectedFactVersionInventoryDigest: inventory.digest,
      selectedFactVersionInventoryRef: inventory.ref,
      selectedFactVersionSetDigest,
    })
    : null;
  const materializationRun = pitIngressArtifact(runRef, {
    artifactKind: 'MaterializationRunCompletion',
    completedAt: pitRequest.payload.completedAt,
    materializationRunRef: runRef,
    pitRequestDigest: pitRequest.digest,
    pitRequestRef: pitRequest.ref,
    result: {
      outcome: 'completed',
      ...(materializedOutput === null ? {} : {
        outputFactTypeIri: materializedOutputDescriptor.outputFactTypeIri,
        outputFactVersionIri: materializedOutputDescriptor.outputFactVersionIri,
        outputRecordDigest: materializedOutput.payload.outputRecordDigest,
      }),
      selectedFactVersionCount: selected.length,
      selectedFactVersionSetDigest,
    },
    schemaVersion: PIT_INGRESS_SCHEMA_VERSION,
    ...(selectionRequest === null ? {} : {
      selectionRequestDigest: selectionRequest.digest,
      selectionRequestRef: selectionRequest.ref,
    }),
    ...(materializedOutput === null ? {} : {
      materializedOutputDigest: materializedOutput.digest,
      materializedOutputRef: materializedOutput.ref,
    }),
    selectedFactVersionInventoryDigest: inventory.digest,
    selectedFactVersionInventoryRef: inventory.ref,
    status: 'completed',
  });
  const verifierProtocolDigest = sha256Jcs({
    protocol: PIT_INGRESS_VERIFIER_ID,
    schemaVersion: PIT_INGRESS_SCHEMA_VERSION,
  });
  const validationReport = pitIngressArtifact(reportRef, {
    artifactKind: 'ValidationReport',
    conforms: true,
    materializationRunDigest: materializationRun.digest,
    materializationRunRef: materializationRun.ref,
    pitRequestDigest: pitRequest.digest,
    pitRequestRef: pitRequest.ref,
    schemaVersion: PIT_INGRESS_SCHEMA_VERSION,
    ...(selectionRequest === null ? {} : {
      selectionRequestDigest: selectionRequest.digest,
      selectionRequestRef: selectionRequest.ref,
    }),
    ...(materializedOutput === null ? {} : {
      materializedOutputDigest: materializedOutput.digest,
      materializedOutputRef: materializedOutput.ref,
      outputRecordDigest: materializedOutput.payload.outputRecordDigest,
    }),
    selectedFactVersionInventoryDigest: inventory.digest,
    selectedFactVersionInventoryRef: inventory.ref,
    selectedFactVersionSetDigest,
    status: 'passed',
    validationReportRef: reportRef,
    verifiedAt: pitRequest.payload.completedAt,
    verifierId: PIT_INGRESS_VERIFIER_ID,
    verifierProtocolDigest,
  });
  const entries = [
    { artifactDigest: pitRequest.digest, artifactRef: pitRequest.ref, role: 'pitRequest' },
    { artifactDigest: inventory.digest, artifactRef: inventory.ref, role: 'selectedFactVersionInventory' },
    ...(selectionRequest === null ? [] : [{
      artifactDigest: selectionRequest.digest,
      artifactRef: selectionRequest.ref,
      role: 'factVersionSelectionRequest',
    }]),
    ...(materializedOutput === null ? [] : [{
      artifactDigest: materializedOutput.digest,
      artifactRef: materializedOutput.ref,
      role: 'materializedFactOutput',
    }]),
    { artifactDigest: materializationRun.digest, artifactRef: materializationRun.ref, role: 'materializationRunCompletion' },
    { artifactDigest: validationReport.digest, artifactRef: validationReport.ref, role: 'validationReport' },
  ].sort((left, right) => compareUtf8(left.artifactRef, right.artifactRef));
  const evidenceLedger = pitIngressArtifact(ledgerRef, {
    artifactKind: 'EvidenceLedger',
    entries,
    evidenceLedgerRef: ledgerRef,
    pitRequestDigest: pitRequest.digest,
    pitRequestRef: pitRequest.ref,
    schemaVersion: PIT_INGRESS_SCHEMA_VERSION,
    status: 'sealed',
  });
  return {
    evidenceLedger,
    ...(materializedOutput === null ? {} : { materializedOutput }),
    materializationRun,
    ...(selectionRequest === null ? {} : { selectionRequest }),
    selectedFactVersionInventory: inventory,
    validationReport,
  };
}

function namedArtifact(value, expectedName, code, label) {
  policyArtifact(
    value,
    (payload) => closedObject(payload, ['artifact']) && payload.artifact === expectedName,
    code,
    label,
  );
}

function completedInputContext(value, temporalValue, code) {
  evidence(value, code);
  requireCondition(value.payload
    && Object.keys(value.payload).length === 4
    && value.payload.schemaVersion === '1.0'
    && typeof value.payload.contextId === 'string'
    && value.payload.contextId.length > 0
    && value.payload.status === 'completed'
    && instantNanoseconds(value.payload.completedAt) !== null
    && value.digest === sha256Jcs(value.payload)
    && instantNanoseconds(value.payload.completedAt) < instantNanoseconds(temporalValue.availableFrom),
  code, 'input context is not a digest-bound, strictly prior completed context');
}

function isPitEligibleForConsumer(rateTemporal, consumerTemporal) {
  return Boolean(rateTemporal && consumerTemporal
    && ['validFrom', 'knowledgeFrom', 'availableFrom'].every((axis) => (
      instantNanoseconds(rateTemporal[axis]) !== null
      && instantNanoseconds(consumerTemporal[axis]) !== null
      && instantNanoseconds(rateTemporal[axis]) <= instantNanoseconds(consumerTemporal[axis])
    ))
    && (!Object.hasOwn(rateTemporal, 'validTo')
      || instantNanoseconds(consumerTemporal.validFrom)
        < instantNanoseconds(rateTemporal.validTo)));
}

function pitEligible(rateTemporal, consumerTemporal, code) {
  requireCondition(
    isPitEligibleForConsumer(rateTemporal, consumerTemporal),
    code,
    'input fact is not PIT-eligible for the consuming fact under the half-open valid interval',
  );
}

function validateLegacyPitRequestClaim(value, temporalValue, code, label) {
  policyArtifact(
    value,
    (payload) => closedObject(payload, [
      'availableAt',
      'completedAt',
      'knowledgeAt',
      'requestId',
      'schemaVersion',
      'status',
      'validAt',
    ])
      && payload.schemaVersion === '1.0'
      && payload.status === 'passed'
      && typeof payload.requestId === 'string'
      && payload.requestId.length > 0
      && ['validAt', 'knowledgeAt', 'availableAt', 'completedAt'].every(
        (field) => instantNanoseconds(payload[field]) !== null,
      ),
    code,
    label,
  );
  requireCondition(
    instantNanoseconds(value.payload.validAt) <= instantNanoseconds(temporalValue.validFrom)
      && instantNanoseconds(value.payload.knowledgeAt)
        <= instantNanoseconds(temporalValue.knowledgeFrom)
      && instantNanoseconds(value.payload.availableAt)
        <= instantNanoseconds(temporalValue.availableFrom)
      && instantNanoseconds(value.payload.completedAt)
        < instantNanoseconds(temporalValue.availableFrom),
    code,
    `${label} pivots or completion are later than the consuming fact`,
  );
}

function completedPitRequest(
  value,
  temporalValue,
  code,
  selectedFactVersionIris,
  materializedOutputDescriptor = undefined,
) {
  // A request without any verifier ingress artifacts remains an honest
  // producer gap.  Once an ingress envelope is present, however, malformed or
  // incomplete evidence is a real constraint violation rather than pending.
  if (value.verification === undefined) {
    if (selectedFactVersionIris !== undefined) {
      reject(
        `${code}_INGRESS`,
        'required verifier PIT ingress envelope is absent',
      );
    }
    reject(
      `${code}_PRODUCER_PENDING`,
      'PIT request has no verifier-replayed selected FactVersion inventory, completed MaterializationRun, passed ValidationReport, or EvidenceLedger',
    );
  }
  validateLegacyPitRequestClaim(value, temporalValue, code, 'PIT validation request');
  const verificationFields = [
      'evidenceLedger',
      'materializationRun',
      'selectedFactVersionInventory',
      'validationReport',
  ];
  if (materializedOutputDescriptor !== undefined) {
    verificationFields.push('materializedOutput');
    verificationFields.push('selectionRequest');
  }
  requireCondition(
    closedObject(value.verification, verificationFields),
    `${code}_INGRESS`,
    'PIT verifier ingress envelope is not closed',
  );
  requireCondition(
    sortedUnique(selectedFactVersionIris)
      && selectedFactVersionIris.every(exactVersion),
    `${code}_INVENTORY`,
    'expected selected FactVersion inventory is not a sorted unique exact-version set',
  );

  const expected = buildVerifierOwnedPitIngress(
    value,
    selectedFactVersionIris,
    materializedOutputDescriptor,
  );
  const exactArtifact = (actualRows, expectedArtifact, artifactCode, label) => {
    requireCondition(
      Array.isArray(actualRows) && actualRows.length === 1,
      artifactCode,
      `${label} must occur exactly once for this PIT request`,
    );
    const actual = actualRows[0];
    policyArtifact(
      actual,
      (payload) => canonicalJcs(payload) === canonicalJcs(expectedArtifact.payload),
      artifactCode,
      label,
    );
    requireCondition(
      actual.ref === expectedArtifact.ref
        && actual.digest === expectedArtifact.digest,
      artifactCode,
      `${label} ref/digest does not match verifier reconstruction`,
    );
  };
  exactArtifact(
    value.verification.selectedFactVersionInventory,
    expected.selectedFactVersionInventory,
    `${code}_INVENTORY`,
    'selected FactVersion inventory',
  );
  if (materializedOutputDescriptor !== undefined) {
    exactArtifact(
      value.verification.selectionRequest,
      expected.selectionRequest,
      `${code}_SELECTION_REQUEST`,
      'exact-JCS FactVersion selection request',
    );
    exactArtifact(
      value.verification.materializedOutput,
      expected.materializedOutput,
      `${code}_OUTPUT`,
      'materialized FactVersion output',
    );
  }
  exactArtifact(
    value.verification.materializationRun,
    expected.materializationRun,
    `${code}_RUN`,
    'MaterializationRun completion',
  );
  exactArtifact(
    value.verification.validationReport,
    expected.validationReport,
    `${code}_REPORT`,
    'passed ValidationReport',
  );
  exactArtifact(
    value.verification.evidenceLedger,
    expected.evidenceLedger,
    `${code}_LEDGER`,
    'EvidenceLedger inclusion',
  );
}

function reconciliationEvidenceIngress(scenario, runtimeEvidence) {
  if (runtimeEvidence === undefined || runtimeEvidence === null) {
    reject(
      'RECONCILIATION_UNVERIFIED_PROJECTION',
      'Portfolio reconciliation requires an in-process verifier-owned candidate projection',
    );
  }
  requireCondition(
    closedObject(runtimeEvidence, ['portfolioCandidateProjection']),
    'RECONCILIATION_UNVERIFIED_PROJECTION',
    'runtime evidence must be a closed verifier-owned projection envelope',
  );

  // Lazy loading keeps the JSON-only restricted worker fail-closed before it
  // can load the S5 verifier closure. The private WeakSet brand cannot cross
  // that worker boundary or survive serialization/structured cloning.
  const {
    assertVerifiedPortfolioReconciliationProjection,
  } = require('./orders-portfolio-reconciliation-evidence.cjs');
  try {
    assertVerifiedPortfolioReconciliationProjection(
      runtimeEvidence.portfolioCandidateProjection,
      scenario,
    );
  } catch (cause) {
    if (cause?.code === 'RECONCILIATION_PROJECTION_MISMATCH') {
      reject(
        'RECONCILIATION_PROJECTION_MISMATCH',
        'candidate scenario differs from the independently replayed S5-bound producer projection',
      );
    }
    reject(
      'RECONCILIATION_UNVERIFIED_PROJECTION',
      'runtime evidence is not an in-process verifier-owned Portfolio reconciliation projection',
    );
  }
}

function isPitEligibleAt(temporalValue, pivot) {
  return temporalValue
    && pivot
    && instantNanoseconds(temporalValue.validFrom) !== null
    && instantNanoseconds(temporalValue.knowledgeFrom) !== null
    && instantNanoseconds(temporalValue.availableFrom) !== null
    && instantNanoseconds(pivot.validAt) !== null
    && instantNanoseconds(pivot.knowledgeAt) !== null
    && instantNanoseconds(pivot.availableAt) !== null
    && instantNanoseconds(temporalValue.validFrom)
      <= instantNanoseconds(pivot.validAt)
    && (!Object.hasOwn(temporalValue, 'validTo')
      || instantNanoseconds(pivot.validAt)
        < instantNanoseconds(temporalValue.validTo))
    && instantNanoseconds(temporalValue.knowledgeFrom)
      <= instantNanoseconds(pivot.knowledgeAt)
    && instantNanoseconds(temporalValue.availableFrom)
      <= instantNanoseconds(pivot.availableAt);
}

function requirePitEligibleAt(temporalValue, pivot, code, label) {
  requireCondition(
    isPitEligibleAt(temporalValue, pivot),
    code,
    `${label} is not PIT-eligible under the three-axis half-open valid interval`,
  );
}

function exactCompletedProbe(value, expectedPayload, temporalValue, code, label) {
  policyArtifact(
    value,
    (payload) => payload
      && payload.schemaVersion === '1.0'
      && payload.status === 'passed'
      && instantNanoseconds(payload.completedAt) !== null,
    code,
    label,
  );
  requireCondition(
    instantNanoseconds(value.payload.completedAt)
      < instantNanoseconds(temporalValue.availableFrom)
      && canonicalJcs(value.payload) === canonicalJcs({
        ...expectedPayload,
        completedAt: value.payload.completedAt,
        schemaVersion: '1.0',
        status: 'passed',
      }),
    code,
    `${label} does not replay the exact closed input and result payload`,
  );
}

function sortedUnique(values) {
  return Array.isArray(values) && new Set(values).size === values.length
    && values.every(iri) && values.every((value, index) => index === 0 || compareUtf8(values[index - 1], value) < 0);
}

function exactSet(values, count, setDigest, code) {
  requireCondition(
    sortedUnique(values)
      && values.every(exactVersion)
      && count === values.length
      && setDigest === iriSetDigest(values),
    code,
    'closed exact-version set/count/digest mismatch');
}

function validateOrderIntent(s) {
  temporal(s.temporal, 'ORDER_INTENT_TEMPORAL');
  requireCondition(typeof s.clientIntentId === 'string' && s.clientIntentId.length > 0
    && logicalRef(s.account) && logicalRef(s.instrument), 'ORDER_INTENT_IDENTITY', 'stable identity is incomplete');
  requireCondition(Number.isSafeInteger(s.quantityMicros) && s.quantityMicros > 0, 'ORDER_INTENT_QUANTITY', 'quantity must be positive scaled integer');
  requireCondition(['Buy', 'Sell'].includes(s.side), 'ORDER_INTENT_SIDE', 'side is not reviewed');
  const trigger = ['Stop', 'MarketIfTouched', 'StopLimit', 'LimitIfTouched'].includes(s.kind);
  const limit = ['Limit', 'StopLimit', 'LimitIfTouched'].includes(s.kind);
  requireCondition(limit === Number.isSafeInteger(s.limitPriceMicros), 'ORDER_INTENT_PRICE_BRANCH', 'limit price branch mismatch');
  requireCondition(trigger === Number.isSafeInteger(s.triggerPriceMicros)
    && trigger === (typeof s.triggerPriceBasis === 'string'), 'ORDER_INTENT_PRICE_BRANCH', 'trigger price branch mismatch');
  requireCondition((s.timeInForce === 'GTD') === (instantNanoseconds(s.validUntil) !== null), 'ORDER_INTENT_GTD', 'GTD validity branch mismatch');
  requireCondition(exactVersion(s.contextVersionIri) && ['listing', 'otc'].includes(s.contextKind),
    'ORDER_INTENT_CONTEXT', 'exact market context is missing');
  pitEligible(s.contextTemporal, s.temporal, 'ORDER_INTENT_CONTEXT');
  if (s.contextKind === 'listing') {
    requireCondition(s.listedInstrumentIri === s.instrument.logicalIri,
      'ORDER_INTENT_CONTEXT', 'listing does not list the intended instrument');
  }
  authenticatedSourceEvidence(s.sourceEvidence, 'ORDER_INTENT_EVIDENCE');
  requireCondition(!['signedQuantity', 'facility', 'previousState'].some((key) => Object.hasOwn(s, key)), 'ORDER_INTENT_FORBIDDEN', 'duplicate truth is forbidden');
}

function validateExternalOrder(s) {
  temporal(s.temporal, 'EXTERNAL_ORDER_TEMPORAL');
  requireCondition(logicalRef(s.provider) && typeof s.apiIdentifier === 'string' && s.apiIdentifier.length > 0
    && typeof s.providerSchemaVersion === 'string' && s.providerSchemaVersion.length > 0
    && typeof s.externalOrderId === 'string' && s.externalOrderId.length > 0,
  'EXTERNAL_ORDER_IDENTITY', 'provider-scoped logical key is incomplete');
  requireCondition(versionRef(s.originatingIntent), 'EXTERNAL_ORDER_ORIGIN', 'originating intent must be exact version');
  authenticatedSourceEvidence(s.sourceEvidence, 'EXTERNAL_ORDER_EVIDENCE');
}

function validateEventStream(s) {
  temporal(s.temporal, 'EVENT_STREAM_TEMPORAL');
  requireCondition(logicalRef(s.provider) && logicalRef(s.externalOrder)
    && typeof s.apiIdentifier === 'string' && s.apiIdentifier.length > 0
    && typeof s.providerSchemaVersion === 'string' && s.providerSchemaVersion.length > 0
    && typeof s.providerStreamId === 'string' && s.providerStreamId.length > 0
    && ['required', 'optional', 'unsupported'].includes(s.liquidityRoleCapability),
  'EVENT_STREAM_IDENTITY', 'stream identity/capability is invalid');
  requireCondition(closedObject(s.lockedSourceContract, [
    'liquidityRoleCapability', 'schemaVersion', 'semanticMapping', 'sourceSchema',
  ])
    && s.lockedSourceContract.schemaVersion === '1.0'
    && s.lockedSourceContract.sourceSchema
    && typeof s.lockedSourceContract.sourceSchema === 'object'
    && !Array.isArray(s.lockedSourceContract.sourceSchema)
    && s.lockedSourceContract.semanticMapping
    && typeof s.lockedSourceContract.semanticMapping === 'object'
    && !Array.isArray(s.lockedSourceContract.semanticMapping)
    && s.lockedSourceContract.liquidityRoleCapability === s.liquidityRoleCapability
    && s.sourceContractDigest === sha256Jcs(s.lockedSourceContract),
  'EVENT_STREAM_DIGEST', 'locked source schema, mapping, capability, or digest mismatch');
  authenticatedSourceEvidence(s.sourceEvidence, 'EVENT_STREAM_EVIDENCE');
}

function validateStatusVocabulary(s) {
  temporal(s.temporal, 'STATUS_VOCAB_TEMPORAL');
  requireCondition(logicalRef(s.provider) && typeof s.apiIdentifier === 'string' && s.apiIdentifier.length > 0
    && typeof s.providerSchemaVersion === 'string' && s.providerSchemaVersion.length > 0
    && typeof s.vocabularyId === 'string' && s.vocabularyId.length > 0,
  'STATUS_VOCAB_IDENTITY', 'vocabulary identity is incomplete');
  authenticatedSourceEvidence(s.sourceEvidence, 'STATUS_VOCAB_EVIDENCE');
}

function validateTransitionProfile(s) {
  temporal(s.temporal, 'TRANSITION_PROFILE_TEMPORAL');
  requireCondition(logicalRef(s.provider) && typeof s.profileId === 'string' && s.profileId.length > 0, 'TRANSITION_PROFILE_IDENTITY', 'profile identity is incomplete');
  for (const key of ['implementationDigest', 'inputContractDigest', 'outputContractDigest', 'toolLockDigest', 'runtimeDigest']) {
    requireCondition(digest(s[key]), 'TRANSITION_PROFILE_DIGEST', `${key} is not a locked digest`);
  }
  requireCondition(iri(s.toolLockRef), 'TRANSITION_PROFILE_DIGEST', 'tool lock ref is missing');
  requireCondition(closedObject(s.lockedArtifacts, [
    'implementation', 'inputContract', 'outputContract', 'runtime', 'toolLock',
  ]), 'TRANSITION_PROFILE_ARTIFACT', 'executable artifact closure is incomplete');
  for (const [role, artifactValue] of Object.entries(s.lockedArtifacts)) {
    policyArtifact(artifactValue, () => true, 'TRANSITION_PROFILE_ARTIFACT', role);
  }
  requireCondition(s.lockedArtifacts.implementation.digest === s.implementationDigest
    && s.lockedArtifacts.inputContract.digest === s.inputContractDigest
    && s.lockedArtifacts.outputContract.digest === s.outputContractDigest
    && s.lockedArtifacts.runtime.digest === s.runtimeDigest
    && s.lockedArtifacts.toolLock.digest === s.toolLockDigest
    && s.lockedArtifacts.toolLock.ref === s.toolLockRef,
  'TRANSITION_PROFILE_ARTIFACT', 'executable artifact bytes do not match the profile locks');
}

function validateLiquidityMapping(s) {
  temporal(s.temporal, 'LIQUIDITY_MAPPING_TEMPORAL');
  requireCondition(iri(s.sourceContractRef) && digest(s.sourceContractDigest) && digest(s.mappingDigest)
    && typeof s.mappingId === 'string' && s.mappingId.length > 0
    && validJsonPointer(s.rawFieldLocator), 'LIQUIDITY_MAPPING_IDENTITY', 'mapping lock is incomplete');
  requireCondition(['executionAccountOrder', 'contraOrder'].includes(s.rawPerspective), 'LIQUIDITY_MAPPING_PERSPECTIVE', 'raw perspective is invalid');
  requireCondition(s.rawPerspective !== 'contraOrder' || s.perspectiveInversion === true,
    'LIQUIDITY_MAPPING_PERSPECTIVE', 'contra perspective requires reviewed inversion');
  policyArtifact(s.sourceContractArtifact, () => true, 'LIQUIDITY_MAPPING_DIGEST', 'source contract');
  policyArtifact(s.mappingArtifact, () => true, 'LIQUIDITY_MAPPING_DIGEST', 'liquidity mapping');
  requireCondition(s.sourceContractArtifact.ref === s.sourceContractRef
    && s.sourceContractArtifact.digest === s.sourceContractDigest
    && s.mappingArtifact.digest === s.mappingDigest
    && closedObject(s.mappingArtifact.payload, [
      'entries', 'perspectiveInversion', 'rawFieldLocator', 'rawPerspective', 'schemaVersion',
    ])
    && s.mappingArtifact.payload.schemaVersion === '1.0'
    && s.mappingArtifact.payload.rawFieldLocator === s.rawFieldLocator
    && s.mappingArtifact.payload.rawPerspective === s.rawPerspective
    && s.mappingArtifact.payload.perspectiveInversion === s.perspectiveInversion
    && canonicalJcs(s.mappingArtifact.payload.entries) === canonicalJcs(s.entries),
  'LIQUIDITY_MAPPING_DIGEST', 'locked source-contract or mapping bytes do not match the record');
  requireCondition(Array.isArray(s.entries) && s.entries.length > 0
    && new Set(s.entries.map((row) => row.rawValue)).size === s.entries.length
    && s.entries.every((row) => {
      const auction = row.role === 'Undefined';
      return closedObject(row, auction ? ['auctionSemantic', 'rawValue', 'role'] : ['rawValue', 'role'])
        && typeof row.rawValue === 'string' && row.rawValue.length > 0
        && ['Maker', 'Taker', 'Undefined'].includes(row.role)
        && (!auction || (closedObject(row.auctionSemantic, ['kind', 'reviewed'])
          && typeof row.auctionSemantic.kind === 'string' && row.auctionSemantic.kind.length > 0
          && row.auctionSemantic.reviewed === true));
    }),
  'LIQUIDITY_MAPPING_VALUES', 'raw values do not map exactly once to reviewed roles');
}

function validateLifecycleEvent(s) {
  temporal(s.temporal, 'LIFECYCLE_EVENT_TEMPORAL');
  requireCondition(versionRef(s.stream) && versionRef(s.externalOrder) && versionRef(s.orderIntent)
    && typeof s.providerEventId === 'string' && s.providerEventId.length > 0
    && Number.isSafeInteger(s.sourceOrderKey) && s.sourceOrderKey >= 0,
  'LIFECYCLE_EVENT_IDENTITY', 'event stream identity is incomplete');
  requireCondition(s.streamExternalOrderIri === s.externalOrder.logicalIri
    && s.externalOriginatingIntentVersionIri === s.orderIntent.versionIri,
  'LIFECYCLE_EVENT_CHAIN', 'event stream, external order, and originating intent do not agree');
  requireCondition(!Object.hasOwn(s, 'previousState'), 'LIFECYCLE_EVENT_PREVIOUS_STATE', 'previousState is derived and cannot be stored');
  requireCondition(Array.isArray(s.retries) && s.retries.length > 0
    && s.retries.every((row) => closedObject(row, ['event', 'providerEventId', 'sourceOrderKey'])
      && row.providerEventId === s.providerEventId
      && row.sourceOrderKey === s.sourceOrderKey
      && row.event && typeof row.event === 'object' && !Array.isArray(row.event)),
  'LIFECYCLE_EVENT_SOURCE', 'complete provider event objects are not locked to the event identity');
  if (s.retries.length > 1) {
    const canonical = s.retries.map((row) => canonicalJcs(row));
    const conflict = new Set(canonical).size > 1;
    requireCondition(!conflict || (s.duplicateConflictFinding
      && s.duplicateConflictFinding.providerEventId === s.providerEventId
      && Array.isArray(s.duplicateConflictFinding.relatedVersions)
      && s.duplicateConflictFinding.relatedVersions.length === 2
      && s.duplicateConflictFinding.relatedVersionSetDigest
        === iriSetDigest(s.duplicateConflictFinding.relatedVersions)),
    'LIFECYCLE_EVENT_DUPLICATE', 'non-identical retries require a digest-closed duplicate-conflict finding');
  }
}

function validateOrderIntentLineage(s) {
  temporal(s.temporal, 'ORDER_LINEAGE_TEMPORAL');
  authenticatedSourceEvidence(s.sourceEvidence, 'ORDER_LINEAGE_EVIDENCE');
  requireCondition(
    !['reservation', 'reservationId', 'accountBlock'].some((field) => Object.hasOwn(s, field)),
    'ORDER_LINEAGE_RUNTIME_STATE',
    'runtime reservation state is forbidden in the M2 lineage fact',
  );
  requireCondition(['split', 'aggregation'].includes(s.kind),
    'ORDER_LINEAGE_BRANCH', 'lineage kind must be split or aggregation');
  exactSet(
    s.sourceIntentVersionIris,
    s.sourceIntentCount,
    s.sourceIntentVersionSetDigest,
    'ORDER_LINEAGE_SOURCE_SET',
  );
  exactSet(
    s.resultIntentVersionIris,
    s.resultIntentCount,
    s.resultIntentVersionSetDigest,
    'ORDER_LINEAGE_RESULT_SET',
  );
  requireCondition(
    (s.kind === 'split'
      && s.sourceIntentCount === 1
      && s.resultIntentCount >= 2)
      || (s.kind === 'aggregation'
        && s.sourceIntentCount >= 2
        && s.resultIntentCount === 1),
    'ORDER_LINEAGE_BRANCH',
    'split requires 1..many and aggregation requires many..1 endpoint cardinality',
  );
  requireCondition(
    !s.sourceIntentVersionIris.some((versionIri) => (
      s.resultIntentVersionIris.includes(versionIri)
    )),
    'ORDER_LINEAGE_SELF_EDGE',
    'source and result endpoint sets must be disjoint',
  );
  requireCondition(
    s.orderLineageKeyDigest === sha256DomainJcs(
      'axiolune-order-intent-lineage-key-v1',
      {
        kind: s.kind,
        resultIntentVersionSetDigest: s.resultIntentVersionSetDigest,
        sourceIntentVersionSetDigest: s.sourceIntentVersionSetDigest,
      },
    ),
    'ORDER_LINEAGE_KEY',
    'lineage key digest does not bind kind and both exact endpoint sets',
  );

  requireCondition(
    Array.isArray(s.sourceIntents) && Array.isArray(s.resultIntents),
    'ORDER_LINEAGE_ENDPOINT',
    'resolved source and result endpoint inventories are required',
  );
  const endpointIntents = [...s.sourceIntents, ...s.resultIntents];
  requireCondition(
    endpointIntents.length === s.sourceIntentCount + s.resultIntentCount
      && endpointIntents.every((intent) => (
        exactVersion(intent.versionIri)
        && logicalRef(intent.instrument)
        && ['Buy', 'Sell'].includes(intent.side)
        && Number.isSafeInteger(intent.quantityMicros)
        && intent.quantityMicros > 0
        && typeof intent.quantityUnit === 'string'
        && intent.quantityUnit.length > 0
      )),
    'ORDER_LINEAGE_ENDPOINT',
    'every endpoint must resolve to a complete exact OrderIntent version',
  );
  requireCondition(
    canonicalJcs(s.sourceIntents.map((intent) => intent.versionIri))
      === canonicalJcs(s.sourceIntentVersionIris)
      && canonicalJcs(s.resultIntents.map((intent) => intent.versionIri))
        === canonicalJcs(s.resultIntentVersionIris),
    'ORDER_LINEAGE_ENDPOINT',
    'resolved endpoint closure differs from the declared exact sets',
  );
  for (const intent of endpointIntents) {
    authenticatedSourceEvidence(
      intent.sourceEvidence,
      'ORDER_LINEAGE_ENDPOINT_EVIDENCE',
    );
    temporal(intent.temporal, 'ORDER_LINEAGE_ENDPOINT_TEMPORAL');
    pitEligible(intent.temporal, s.temporal, 'ORDER_LINEAGE_ENDPOINT_PIT');
  }
  const first = endpointIntents[0];
  requireCondition(
    endpointIntents.every((intent) => (
      intent.instrument.logicalIri === first.instrument.logicalIri
      && intent.side === first.side
      && intent.quantityUnit === first.quantityUnit
    )),
    'ORDER_LINEAGE_SEMANTICS',
    'lineage endpoints must share instrument, side, and Quantity unit',
  );
  const sourceQuantity = s.sourceIntents.reduce(
    (sum, intent) => sum + BigInt(intent.quantityMicros),
    0n,
  );
  const resultQuantity = s.resultIntents.reduce(
    (sum, intent) => sum + BigInt(intent.quantityMicros),
    0n,
  );
  requireCondition(
    sourceQuantity === resultQuantity,
    'ORDER_LINEAGE_CONSERVATION',
    'exact source and result Quantity sums differ',
  );

  requireCondition(
    Array.isArray(s.lineages) && s.lineages.length > 0,
    'ORDER_LINEAGE_GRAPH',
    'selected lineage graph is empty',
  );
  const graphInventory = s.sourceEvidence.payload;
  requireCondition(
    closedObject(graphInventory, [
      'artifactKind',
      'focusVersionIri',
      'lineageVersionCount',
      'lineageVersionIris',
      'lineageVersionSetDigest',
      'pitRequestDigest',
      'pitRequestRef',
      'schemaVersion',
      'selectionScopeRef',
    ])
      && graphInventory.artifactKind === 'OrderIntentLineageGraphInventory'
      && graphInventory.schemaVersion === '1.0'
      && graphInventory.focusVersionIri === s.versionIri
      && iri(graphInventory.selectionScopeRef)
      && graphInventory.pitRequestRef === s.pitRequest?.ref
      && graphInventory.pitRequestDigest === s.pitRequest?.digest,
    'ORDER_LINEAGE_GRAPH_INVENTORY',
    'selected lineage graph does not bind a closed source inventory artifact',
  );
  exactSet(
    graphInventory.lineageVersionIris,
    graphInventory.lineageVersionCount,
    graphInventory.lineageVersionSetDigest,
    'ORDER_LINEAGE_GRAPH_INVENTORY',
  );
  const actualLineageVersions = s.lineages
    .map((lineage) => lineage.versionIri)
    .sort(compareUtf8);
  requireCondition(
    canonicalJcs(actualLineageVersions)
      === canonicalJcs(graphInventory.lineageVersionIris),
    'ORDER_LINEAGE_GRAPH_INVENTORY',
    'runtime lineage graph differs from the authenticated selected inventory',
  );
  const selectedLineageFactVersions = [...new Set([
    ...actualLineageVersions,
    ...s.lineages.flatMap((lineage) => [
      ...lineage.sourceIntentVersionIris,
      ...lineage.resultIntentVersionIris,
    ]),
  ])].sort(compareUtf8);
  completedPitRequest(
    s.pitRequest,
    s.temporal,
    'ORDER_LINEAGE_PIT',
    selectedLineageFactVersions,
  );
  const keyDigests = new Set();
  const directedPairs = new Set();
  const adjacency = new Map();
  const lineageVersions = new Set();
  let focusCount = 0;
  for (const lineage of s.lineages) {
    authenticatedSourceEvidence(lineage.sourceEvidence, 'ORDER_LINEAGE_GRAPH_EVIDENCE');
    requireCondition(
      canonicalJcs(lineage.sourceEvidence) === canonicalJcs(s.sourceEvidence),
      'ORDER_LINEAGE_GRAPH_INVENTORY',
      'lineage fact does not bind the common selected graph evidence',
    );
    requireCondition(
      exactVersion(lineage.versionIri)
        && ['split', 'aggregation'].includes(lineage.kind),
      'ORDER_LINEAGE_GRAPH',
      'lineage graph contains an invalid fact identity or kind',
    );
    requireCondition(
      !lineageVersions.has(lineage.versionIri),
      'ORDER_LINEAGE_DUPLICATE',
      'lineage graph repeats an exact fact version',
    );
    lineageVersions.add(lineage.versionIri);
    requireCondition(
      !['reservation', 'reservationId', 'accountBlock'].some((field) => Object.hasOwn(lineage, field)),
      'ORDER_LINEAGE_RUNTIME_STATE',
      'runtime reservation state is forbidden in the M2 lineage graph',
    );
    exactSet(
      lineage.sourceIntentVersionIris,
      lineage.sourceIntentCount,
      lineage.sourceIntentVersionSetDigest,
      'ORDER_LINEAGE_GRAPH_SOURCE_SET',
    );
    exactSet(
      lineage.resultIntentVersionIris,
      lineage.resultIntentCount,
      lineage.resultIntentVersionSetDigest,
      'ORDER_LINEAGE_GRAPH_RESULT_SET',
    );
    requireCondition(
      (lineage.kind === 'split'
        && lineage.sourceIntentCount === 1
        && lineage.resultIntentCount >= 2)
        || (lineage.kind === 'aggregation'
          && lineage.sourceIntentCount >= 2
          && lineage.resultIntentCount === 1),
      'ORDER_LINEAGE_GRAPH_BRANCH',
      'lineage graph contains a fact with the wrong branch cardinality',
    );
    requireCondition(
      lineage.orderLineageKeyDigest === sha256DomainJcs(
        'axiolune-order-intent-lineage-key-v1',
        {
          kind: lineage.kind,
          resultIntentVersionSetDigest: lineage.resultIntentVersionSetDigest,
          sourceIntentVersionSetDigest: lineage.sourceIntentVersionSetDigest,
        },
      ),
      'ORDER_LINEAGE_GRAPH_KEY',
      'lineage graph contains an unbound key digest',
    );
    temporal(lineage.temporal, 'ORDER_LINEAGE_GRAPH_TEMPORAL');
    requireCondition(
      Array.isArray(lineage.sourceIntents)
        && Array.isArray(lineage.resultIntents)
        && lineage.sourceIntents.length === lineage.sourceIntentCount
        && lineage.resultIntents.length === lineage.resultIntentCount
        && canonicalJcs(lineage.sourceIntents.map((intent) => intent.versionIri))
          === canonicalJcs(lineage.sourceIntentVersionIris)
        && canonicalJcs(lineage.resultIntents.map((intent) => intent.versionIri))
          === canonicalJcs(lineage.resultIntentVersionIris),
      'ORDER_LINEAGE_GRAPH_ENDPOINT',
      'lineage graph endpoint closure is absent, orphaned, or differs from its exact sets',
    );
    const graphEndpoints = [...lineage.sourceIntents, ...lineage.resultIntents];
    requireCondition(
      graphEndpoints.every((intent) => (
        exactVersion(intent.versionIri)
          && logicalRef(intent.instrument)
          && ['Buy', 'Sell'].includes(intent.side)
          && Number.isSafeInteger(intent.quantityMicros)
          && intent.quantityMicros > 0
          && typeof intent.quantityUnit === 'string'
          && intent.quantityUnit.length > 0
      )),
      'ORDER_LINEAGE_GRAPH_ENDPOINT',
      'lineage graph contains an incomplete or wrong-type OrderIntent endpoint',
    );
    for (const intent of graphEndpoints) {
      authenticatedSourceEvidence(
        intent.sourceEvidence,
        'ORDER_LINEAGE_GRAPH_ENDPOINT_EVIDENCE',
      );
      temporal(intent.temporal, 'ORDER_LINEAGE_GRAPH_ENDPOINT_TEMPORAL');
      pitEligible(intent.temporal, lineage.temporal, 'ORDER_LINEAGE_GRAPH_ENDPOINT_PIT');
    }
    const graphFirst = graphEndpoints[0];
    requireCondition(
      graphEndpoints.every((intent) => (
        intent.instrument.logicalIri === graphFirst.instrument.logicalIri
          && intent.side === graphFirst.side
          && intent.quantityUnit === graphFirst.quantityUnit
      )),
      'ORDER_LINEAGE_GRAPH_SEMANTICS',
      'lineage graph endpoints disagree on instrument, side, or Quantity unit',
    );
    requireCondition(
      lineage.sourceIntents.reduce(
        (sum, intent) => sum + BigInt(intent.quantityMicros),
        0n,
      ) === lineage.resultIntents.reduce(
        (sum, intent) => sum + BigInt(intent.quantityMicros),
        0n,
      ),
      'ORDER_LINEAGE_GRAPH_CONSERVATION',
      'lineage graph does not conserve exact Quantity',
    );
    requireCondition(
      !keyDigests.has(lineage.orderLineageKeyDigest),
      'ORDER_LINEAGE_DUPLICATE',
      'lineage graph repeats a transformation key',
    );
    keyDigests.add(lineage.orderLineageKeyDigest);
    if (lineage.versionIri === s.versionIri) focusCount += 1;
    for (const sourceVersionIri of lineage.sourceIntentVersionIris) {
      const targets = adjacency.get(sourceVersionIri) || new Set();
      for (const resultVersionIri of lineage.resultIntentVersionIris) {
        requireCondition(
          sourceVersionIri !== resultVersionIri,
          'ORDER_LINEAGE_SELF_EDGE',
          'lineage graph contains a self edge',
        );
        const pair = `${sourceVersionIri}\0${resultVersionIri}`;
        requireCondition(
          !directedPairs.has(pair),
          'ORDER_LINEAGE_DUPLICATE',
          'lineage graph repeats a directed endpoint pair',
        );
        directedPairs.add(pair);
        targets.add(resultVersionIri);
      }
      adjacency.set(sourceVersionIri, targets);
    }
  }
  requireCondition(
    focusCount === 1,
    'ORDER_LINEAGE_GRAPH',
    'focus lineage must occur exactly once in the selected graph',
  );
  const visiting = new Set();
  const visited = new Set();
  const visit = (node) => {
    if (visiting.has(node)) reject('ORDER_LINEAGE_CYCLE', 'lineage graph contains a directed cycle');
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of adjacency.get(node) || []) visit(next);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of adjacency.keys()) visit(node);
}

function validateExecution(s) {
  temporal(s.temporal, 'EXECUTION_TEMPORAL');
  requireCondition(versionRef(s.stream) && logicalRef(s.account) && logicalRef(s.instrument)
    && logicalRef(s.executionParty) && logicalRef(s.contraAccount) && logicalRef(s.contraParty)
    && typeof s.providerExecutionId === 'string' && s.providerExecutionId.length > 0,
  'EXECUTION_IDENTITY', 'execution identity is incomplete');
  requireCondition(Number.isSafeInteger(s.quantityMicros) && s.quantityMicros > 0, 'EXECUTION_QUANTITY', 'execution quantity must be positive');
  requireCondition(['Buy', 'Sell'].includes(s.side) && s.account.logicalIri === s.intentAccountIri
    && s.instrument.logicalIri === s.intentInstrumentIri, 'EXECUTION_TRUTH_JOIN', 'execution truth differs from intent');
  requireCondition(s.externalOriginatingIntentVersionIri === s.orderIntentVersionIri
    && s.streamExternalOrderIri === s.executionExternalOrderLogicalIri,
  'EXECUTION_ORDER_CHAIN', 'stream, external order, and intent exact versions do not agree');
  requireCondition(exactVersion(s.contextVersionIri) && s.contextVersionIri === s.quotationContextVersionIri
    && s.contextKind === s.quotationContextKind, 'EXECUTION_CONTEXT', 'execution and quotation contexts differ');
  pitEligible(s.contextTemporal, s.temporal, 'EXECUTION_CONTEXT');
  if (s.contextKind === 'listing') {
    requireCondition(s.listedInstrumentIri === s.instrument.logicalIri,
      'EXECUTION_CONTEXT', 'listing does not list the execution instrument');
  }
  requireCondition(s.quoteInstrumentIri === s.instrument.logicalIri && s.priceCurrency === s.quoteCurrency
    && s.priceCurrency === s.contextQuoteCurrency && s.quantityUnit === s.quoteDenominatorUnit,
  'EXECUTION_QUOTATION', 'quotation context is inconsistent');
  authenticatedSourceEvidence(s.sourceEvidence, 'EXECUTION_EVIDENCE');
  requireCondition(!['signedQuantity', 'liquidityRole', 'commission', 'facility'].some((key) => Object.hasOwn(s, key)), 'EXECUTION_FORBIDDEN', 'duplicate execution truth is forbidden');
}

function validateExecutionLiquidityCompleteness(s) {
  requireCondition(versionRef(s.executionStream) && Array.isArray(s.determinations)
    && s.determinations.length === 1 && versionRef(s.determinations[0].stream)
    && s.determinations[0].stream.versionIri === s.executionStream.versionIri,
  'EXECUTION_LIQUIDITY_COMPLETENESS', 'execution requires exactly one same-stream determination');
  validateLiquidityDetermination(s.determinations[0]);
}

function validateFee(s) {
  temporal(s.temporal, 'FEE_TEMPORAL');
  requireCondition(versionRef(s.execution) && typeof s.feeId === 'string' && s.feeId.length > 0
    && (!Object.hasOwn(s, 'assessor') || logicalRef(s.assessor)),
  'FEE_IDENTITY', 'fee logical key is incomplete');
  requireCondition(Number.isSafeInteger(s.amountMicros) && s.amountMicros > 0
    && Number.isSafeInteger(s.amountScale) && s.amountScale >= 0
    && typeof s.amountCurrency === 'string' && s.amountCurrency.length > 0,
  'FEE_AMOUNT', 'fee magnitude/currency must be positive and explicit');
  requireCondition(
    ['commission', 'exchange', 'clearing', 'regulatory', 'tax', 'other'].includes(s.feeKind),
    'FEE_KIND',
    'fee kind is not a reviewed code-list member',
  );
  requireCondition(['charge', 'rebate'].includes(s.effect) && !Object.hasOwn(s, 'signedAmountMicros'), 'FEE_EFFECT', 'fee sign is represented only by effect');
  authenticatedSourceEvidence(s.sourceEvidence, 'FEE_EVIDENCE');
}

function validateStatusMapping(s) {
  temporal(s.temporal, 'STATUS_MAPPING_TEMPORAL');
  requireCondition(logicalRef(s.provider) && logicalRef(s.reviewer)
    && exactVersion(s.vocabularyVersionIri)
    && typeof s.apiIdentifier === 'string' && s.apiIdentifier.length > 0
    && typeof s.providerSchemaVersion === 'string' && s.providerSchemaVersion.length > 0
    && typeof s.mappingVersion === 'string' && s.mappingVersion.length > 0
    && typeof s.rawStatusCode === 'string' && s.rawStatusCode.length > 0
    && typeof s.vocabularyId === 'string' && s.vocabularyId.length > 0,
  'STATUS_MAPPING_IDENTITY', 'provider-scoped mapping identity or reviewer is incomplete');
  requireCondition(s.provider.logicalIri === s.vocabularyProviderIri
    && s.apiIdentifier === s.vocabularyApiIdentifier
    && s.providerSchemaVersion === s.vocabularySchemaVersion,
  'STATUS_MAPPING_SCOPE', 'mapping and vocabulary scopes differ');
  requireCondition(Array.isArray(s.canonicalStates) && s.canonicalStates.length === 1,
    'STATUS_MAPPING_XONE', 'exactly one canonical lifecycle state is required');
  requireCondition(Array.isArray(s.retiredAliases) && s.retiredAliases.length === 0, 'STATUS_MAPPING_RETIRED_ALIAS', 'retired aliases are forbidden');
  authenticatedSourceEvidence(s.sourceEvidence, 'STATUS_MAPPING_EVIDENCE');
  evidence(s.reviewEvidence, 'STATUS_MAPPING_EVIDENCE');
}

function validateLiquidityDetermination(s) {
  temporal(s.temporal, 'LIQUIDITY_DETERMINATION_TEMPORAL');
  requireCondition(versionRef(s.execution) && versionRef(s.stream)
    && s.stream.versionIri === s.executionStreamVersionIri && s.perspective === 'executionAccountOrder'
    && exactVersion(s.versionIri) && iri(s.generatingContextRef),
  'LIQUIDITY_DETERMINATION_JOIN', 'determination does not join the execution stream');
  requireCondition(s.sourceRecord && typeof s.sourceRecord === 'object' && !Array.isArray(s.sourceRecord)
    && iri(s.sourceRecordRef) && s.sourceRecordDigest === sha256Jcs(s.sourceRecord),
  'LIQUIDITY_SOURCE_RECORD', 'source record bytes/digest/ref are incomplete');
  policyArtifact(s.sourceContractArtifact, () => true, 'LIQUIDITY_SOURCE_CONTRACT', 'source contract');
  requireCondition(s.sourceContractArtifact.ref === s.sourceContractRef
    && s.sourceContractArtifact.digest === s.sourceContractDigest
    && closedObject(s.sourceContractArtifact.payload, [
      'liquidityRoleCapability', 'schemaVersion', 'semanticMapping', 'sourceSchema',
    ])
    && s.sourceContractArtifact.payload.schemaVersion === '1.0'
    && s.sourceContractArtifact.payload.liquidityRoleCapability === s.capability
    && validJsonPointer(s.sourceContractArtifact.payload.semanticMapping?.rawFieldLocator),
  'LIQUIDITY_SOURCE_CONTRACT', 'stream capability/mapping is not locked by its source contract');
  const declaredPointer = s.sourceContractArtifact.payload.semanticMapping.rawFieldLocator;

  const requireClassified = (code) => {
    requireCondition(s.outcome === 'classified' && typeof s.rawValue === 'string'
      && typeof s.role === 'string' && validJsonPointer(s.pointer)
      && s.mapping && exactVersion(s.mapping.versionIri)
      && !Object.hasOwn(s, 'absenceReason') && !Object.hasOwn(s, 'absenceProbe'),
    code, 'classified branch is incomplete or mixed');
    validateLiquidityMapping(s.mapping);
    requireCondition(s.mapping.sourceContractRef === s.sourceContractRef
      && s.mapping.sourceContractDigest === s.sourceContractDigest
      && s.mapping.rawFieldLocator === declaredPointer
      && s.pointer === declaredPointer,
    code, 'mapping and exact stream source contract do not agree');
    const resolved = resolveJsonPointer(s.sourceRecord, s.pointer);
    const lexical = resolved.found ? sourceLexicalValue(resolved.value) : null;
    requireCondition(lexical !== null && lexical === s.rawValue, code,
      'raw pointer does not resolve to the stored lexical value');
    const entries = s.mapping.entries.filter((entry) => entry.rawValue === s.rawValue);
    requireCondition(entries.length === 1, code, 'raw value is absent or ambiguous in the reviewed mapping');
    let expectedRole = entries[0].role;
    if (s.mapping.rawPerspective === 'contraOrder') {
      requireCondition(s.mapping.perspectiveInversion === true, code, 'contra mapping lacks reviewed inversion');
      if (expectedRole === 'Maker') expectedRole = 'Taker';
      else if (expectedRole === 'Taker') expectedRole = 'Maker';
    }
    requireCondition(s.role === expectedRole, code, 'stored role differs from the reviewed mapped role');
  };

  if (s.capability === 'required') {
    requireClassified('LIQUIDITY_REQUIRED');
  } else if (s.capability === 'unsupported') {
    requireCondition(s.outcome === 'unavailable' && s.absenceReason === 'contractUnsupported'
      && !Object.hasOwn(s, 'mapping') && !Object.hasOwn(s, 'rawValue')
      && !Object.hasOwn(s, 'pointer') && !Object.hasOwn(s, 'role')
      && !Object.hasOwn(s, 'absenceProbe'),
    'LIQUIDITY_UNSUPPORTED', 'unsupported branch is malformed');
  } else {
    requireCondition(s.capability === 'optional', 'LIQUIDITY_CAPABILITY', 'unknown capability');
    if (s.outcome === 'classified') requireClassified('LIQUIDITY_OPTIONAL');
    else {
      requireCondition(s.outcome === 'unavailable' && s.absenceReason === 'providerNotSpecified'
        && !Object.hasOwn(s, 'mapping') && !Object.hasOwn(s, 'rawValue')
        && !Object.hasOwn(s, 'pointer') && !Object.hasOwn(s, 'role'),
      'LIQUIDITY_OPTIONAL', 'optional unavailable branch is mixed');
      policyArtifact(s.absenceProbe, () => true, 'LIQUIDITY_OPTIONAL', 'field-absence probe');
      requireCondition(closedObject(s.absenceProbe.payload, [
        'rawFieldLocator', 'result', 'schemaVersion', 'sourceRecordDigest', 'status',
      ])
        && s.absenceProbe.payload.schemaVersion === '1.0'
        && s.absenceProbe.payload.status === 'completed'
        && s.absenceProbe.payload.result === 'absent'
        && s.absenceProbe.payload.sourceRecordDigest === s.sourceRecordDigest
        && s.absenceProbe.payload.rawFieldLocator === declaredPointer
        && resolveJsonPointer(s.sourceRecord, declaredPointer).found === false,
      'LIQUIDITY_OPTIONAL', 'optional absence probe does not prove absence from the exact source record');
    }
  }
}

function sameStringSet(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected)
    && actual.length === expected.length
    && new Set(actual).size === actual.length
    && actual.every((value) => expected.includes(value));
}

function integrityEventContent(event) {
  return {
    eventStreamVersionIri: event.streamVersionIri,
    externalOrderVersionIri: event.externalOrderVersionIri,
    kind: event.kind,
    lifecycleState: event.lifecycleState,
    observedAt: event.observedAt,
    orderIntentVersionIri: event.orderIntentVersionIri,
    providerEventId: event.providerEventId,
    sourceArtifact: event.sourceArtifact,
    sourceArtifactDigest: event.sourceArtifactDigest,
    sourceOrderKey: event.sourceOrderKey,
  };
}

function requireFindingBranch(s, expectedFields, expectedSubjectKeys, code) {
  requireCondition(
    sameStringSet(s.presentBranchFields, expectedFields)
      && closedObject(s.findingSubject, expectedSubjectKeys),
    code,
    'finding branch has missing, extraneous, or mixed subject fields',
  );
}

function requireRelatedLifecycleOnly(s, code) {
  requireCondition(
    Array.isArray(s.relatedLifecycleEvents) && s.relatedLifecycleEvents.length > 0
      && Array.isArray(s.relatedExecutions) && s.relatedExecutions.length === 0,
    code,
    'finding branch has the wrong generic related-record kinds',
  );
}

function validateIntegrityFinding(s) {
  temporal(s.temporal, 'INTEGRITY_FINDING_TEMPORAL');
  requireCondition(
    versionRef(s.stream)
      && iri(s.generatingContextRef)
      && Array.isArray(s.relatedVersions)
      && s.relatedVersions.length > 0
      && s.relatedVersions.every(exactVersion)
      && new Set(s.relatedVersions).size === s.relatedVersions.length
      && Array.isArray(s.genericRelatedVersionRefs)
      && s.genericRelatedVersionRefs.every(exactVersion)
      && new Set(s.genericRelatedVersionRefs).size === s.genericRelatedVersionRefs.length
      && Array.isArray(s.relatedLifecycleEvents)
      && Array.isArray(s.relatedExecutions),
    'FINDING_SUBJECT',
    'finding stream, context, or exact related versions are incomplete',
  );
  requireCondition(
    [...s.relatedLifecycleEvents, ...s.relatedExecutions].every(
      (record) => record.streamVersionIri === s.stream.versionIri,
    ),
    'FINDING_STREAM',
    'related lifecycle event or execution belongs to another event stream version',
  );

  if (s.kind === 'duplicateConflict') {
    requireFindingBranch(
      s,
      ['findingProviderEventId'],
      ['providerEventId'],
      'FINDING_DUPLICATE_CONFLICT',
    );
    requireRelatedLifecycleOnly(s, 'FINDING_DUPLICATE_CONFLICT');
    requireCondition(
      typeof s.findingSubject.providerEventId === 'string'
        && s.findingSubject.providerEventId.length > 0
        && s.relatedLifecycleEvents.length === 2
        && s.relatedLifecycleEvents.every(
          (event) => event.providerEventId === s.findingSubject.providerEventId,
        )
        && canonicalJcs(integrityEventContent(s.relatedLifecycleEvents[0]))
          !== canonicalJcs(integrityEventContent(s.relatedLifecycleEvents[1])),
      'FINDING_DUPLICATE_CONFLICT',
      'duplicate conflict must bind exactly two same-ID events with different canonical content',
    );
  } else if (s.kind === 'sequenceGap') {
    requireFindingBranch(
      s,
      ['missingKeyFrom', 'missingKeyTo'],
      ['missingFrom', 'missingTo'],
      'FINDING_SEQUENCE_GAP',
    );
    requireRelatedLifecycleOnly(s, 'FINDING_SEQUENCE_GAP');
    const { missingFrom, missingTo } = s.findingSubject;
    const expectedBoundaryKeys = missingFrom === 0
      ? [missingTo]
      : [missingFrom - 1, missingTo];
    const observedBoundaryKeys = [...new Set(
      s.relatedLifecycleEvents.map((event) => event.sourceOrderKey),
    )];
    requireCondition(
      Number.isSafeInteger(missingFrom)
        && Number.isSafeInteger(missingTo)
        && missingFrom >= 0
        && missingTo > missingFrom
        && sameStringSet(
          observedBoundaryKeys.map(String),
          expectedBoundaryKeys.map(String),
        )
        && s.relatedLifecycleEvents.every(
          (event) => expectedBoundaryKeys.includes(event.sourceOrderKey),
        ),
      'FINDING_SEQUENCE_GAP',
      'sequence-gap subject or exact boundary-event closure is invalid',
    );
  } else if (s.kind === 'outOfOrder') {
    requireFindingBranch(
      s,
      ['observedSourceOrderKey', 'requiredPredecessorSourceOrderKey'],
      ['observedKey', 'requiredPredecessorKey'],
      'FINDING_OUT_OF_ORDER',
    );
    requireRelatedLifecycleOnly(s, 'FINDING_OUT_OF_ORDER');
    const { observedKey, requiredPredecessorKey } = s.findingSubject;
    const observed = s.relatedLifecycleEvents.filter(
      (event) => event.sourceOrderKey === observedKey,
    );
    const predecessor = s.relatedLifecycleEvents.filter(
      (event) => event.sourceOrderKey === requiredPredecessorKey,
    );
    requireCondition(
      Number.isSafeInteger(observedKey)
        && Number.isSafeInteger(requiredPredecessorKey)
        && observedKey >= 0
        && observedKey < requiredPredecessorKey
        && s.relatedLifecycleEvents.length === 2
        && observed.length === 1
        && predecessor.length === 1
        && instantNanoseconds(predecessor[0].observedAt)
          < instantNanoseconds(observed[0].observedAt),
      'FINDING_OUT_OF_ORDER',
      'out-of-order subject or arrival-order proof is invalid',
    );
  } else if (s.kind === 'lateFill') {
    requireFindingBranch(
      s,
      ['subjectFillExecution', 'subjectTerminalEvent'],
      ['fillVersionIri', 'terminalEventVersionIri'],
      'FINDING_LATE_FILL',
    );
    const fill = s.relatedExecutions.filter(
      (execution) => execution.versionIri === s.findingSubject.fillVersionIri,
    );
    const terminal = s.relatedLifecycleEvents.filter(
      (event) => event.versionIri === s.findingSubject.terminalEventVersionIri,
    );
    requireCondition(
      s.relatedExecutions.length === 1
        && s.relatedLifecycleEvents.length === 1
        && fill.length === 1
        && terminal.length === 1
        && ['Canceled', 'Expired', 'Rejected', 'Filled'].includes(
          terminal[0].lifecycleState,
        )
        && instantNanoseconds(terminal[0].observedAt)
          < instantNanoseconds(fill[0].observedAt),
      'FINDING_LATE_FILL',
      'late-fill subject must bind one later execution and one prior terminal event',
    );
  } else if (s.kind === 'missingAcknowledgement') {
    requireFindingBranch(
      s,
      ['expectedAfterSourceOrderKey', 'subjectMissingAcknowledgementOrder'],
      ['expectedAfterKey', 'externalOrderVersionIri'],
      'FINDING_MISSING_ACKNOWLEDGEMENT',
    );
    requireRelatedLifecycleOnly(s, 'FINDING_MISSING_ACKNOWLEDGEMENT');
    const { expectedAfterKey, externalOrderVersionIri } = s.findingSubject;
    requireCondition(
      Number.isSafeInteger(expectedAfterKey)
        && expectedAfterKey >= 0
        && s.subjectMissingAcknowledgementOrder?.versionIri === externalOrderVersionIri
        && s.relatedLifecycleEvents.some(
          (event) => event.sourceOrderKey === expectedAfterKey,
        )
        && s.relatedLifecycleEvents.every(
          (event) => event.sourceOrderKey <= expectedAfterKey
            && event.kind !== 'Accepted',
        ),
      'FINDING_MISSING_ACKNOWLEDGEMENT',
      'missing-acknowledgement subject or evaluated event prefix is invalid',
    );
  } else if (s.kind === 'transitionViolation') {
    requireFindingBranch(
      s,
      ['evaluatedTransitionProfile', 'subjectFromEvent', 'subjectToEvent'],
      ['fromEventVersionIri', 'toEventVersionIri', 'transitionProfileVersionIri'],
      'FINDING_TRANSITION_VIOLATION',
    );
    requireRelatedLifecycleOnly(s, 'FINDING_TRANSITION_VIOLATION');
    const {
      fromEventVersionIri,
      toEventVersionIri,
      transitionProfileVersionIri,
    } = s.findingSubject;
    const from = s.relatedLifecycleEvents.filter(
      (event) => event.versionIri === fromEventVersionIri,
    );
    const to = s.relatedLifecycleEvents.filter(
      (event) => event.versionIri === toEventVersionIri,
    );
    const allowed = s.evaluatedTransitionProfile?.inputContract?.allowedTransitions;
    requireCondition(
      s.relatedLifecycleEvents.length === 2
        && from.length === 1
        && to.length === 1
        && s.evaluatedTransitionProfile?.versionIri === transitionProfileVersionIri
        && allowed
        && typeof allowed === 'object'
        && !Array.isArray(allowed)
        && Array.isArray(allowed[from[0].lifecycleState])
        && !allowed[from[0].lifecycleState].includes(to[0].lifecycleState)
        && from[0].sourceOrderKey < to[0].sourceOrderKey,
      'FINDING_TRANSITION_VIOLATION',
      'transition subject, exact profile input, or rejected transition proof is invalid',
    );
  } else {
    reject('FINDING_KIND', 'unsupported integrity finding kind');
  }

  requireCondition(
    s.affectedKeyDigest
      === sha256DomainJcs('axiolune-order-finding-subject-v1', s.findingSubject),
    'FINDING_AFFECTED_DIGEST',
    'affected-key digest does not bind the strict kind-discriminated subject bytes',
  );
  requireCondition(
    s.relatedVersionSetDigest === iriSetDigest(s.relatedVersions),
    'FINDING_RELATED_DIGEST',
    'related exact-version digest mismatch',
  );
}

function validatePortfolio(s) {
  temporal(s.temporal, 'PORTFOLIO_TEMPORAL');
  requireCondition(typeof s.portfolioId === 'string' && s.portfolioId.length > 0, 'PORTFOLIO_ID', 'stable portfolioId is required');
}

function validatePortfolioObservationStream(s) {
  temporal(s.temporal, 'PORTFOLIO_OBSERVATION_STREAM_TEMPORAL');
  requireCondition(
    exactVersion(s.versionIri)
      && logicalRef(s.provider)
      && canonicalBusinessId(s.streamId)
      && iri(s.sourceContract?.ref),
    'PORTFOLIO_OBSERVATION_STREAM_IDENTITY',
    'stream version, provider, source contract, or provider-scoped stream identifier is incomplete',
  );
  evidence(s.sourceContract, 'PORTFOLIO_OBSERVATION_STREAM_CONTRACT');
  evidence(s.completenessContract, 'PORTFOLIO_OBSERVATION_STREAM_CONTRACT');
  evidence(s.paginationContract, 'PORTFOLIO_OBSERVATION_STREAM_CONTRACT');
  authenticatedSourceEvidence(s.sourceEvidence, 'PORTFOLIO_OBSERVATION_STREAM_PROVENANCE');
  requireCondition(
    s.sourceLocatorPresent === true,
    'PORTFOLIO_OBSERVATION_STREAM_PROVENANCE',
    'stream provenance must include its closed source locator',
  );
}

function validateMembership(s) {
  temporal(s.temporal, 'MEMBERSHIP_TEMPORAL');
  requireCondition(logicalRef(s.portfolio) && logicalRef(s.account) && typeof s.membershipId === 'string' && s.membershipId.length > 0, 'MEMBERSHIP_IDENTITY', 'membership logical key is incomplete');
  evidence(s.authorityEvidence, 'MEMBERSHIP_EVIDENCE'); evidence(s.approvalEvidence, 'MEMBERSHIP_EVIDENCE'); authenticatedSourceEvidence(s.sourceEvidence, 'MEMBERSHIP_EVIDENCE');
}

function validateMandate(s) {
  temporal(s.temporal, 'MANDATE_TEMPORAL');
  requireCondition(logicalRef(s.portfolio) && logicalRef(s.managingParty) && typeof s.mandateId === 'string' && s.mandateId.length > 0, 'MANDATE_IDENTITY', 'mandate logical key is incomplete');
  evidence(s.authorityEvidence, 'MANDATE_EVIDENCE'); evidence(s.approvalEvidence, 'MANDATE_EVIDENCE'); authenticatedSourceEvidence(s.sourceEvidence, 'MANDATE_EVIDENCE');
}

function validateMembershipClosure(s) {
  completedPitRequest(
    s.pitRequest,
    s.temporal,
    'MEMBERSHIP_CLOSURE_PIT',
    s.members,
  );
  temporal(s.temporal, 'MEMBERSHIP_CLOSURE_TEMPORAL');
  exactSet(s.members, s.membershipCount, s.membershipVersionSetDigest, 'MEMBERSHIP_CLOSURE_SET');
  requireCondition(
    logicalRef(s.portfolio)
      && exactVersion(s.versionIri)
      && iri(s.generatingContextRef)
      && Array.isArray(s.membershipRecords),
    'MEMBERSHIP_CLOSURE_CONTEXT',
    'membership closure identity, producer, or canonical input graph is incomplete',
  );
  completedInputContext(s.inputContext, s.temporal, 'MEMBERSHIP_CLOSURE_INPUT');

  const eligibleMemberships = [];
  for (const membership of s.membershipRecords) {
    temporal(membership.temporal, 'MEMBERSHIP_CLOSURE_MEMBER_TEMPORAL');
    requireCondition(
      exactVersion(membership.versionIri)
        && logicalRef(membership.portfolio)
        && logicalRef(membership.account)
        && typeof membership.membershipId === 'string'
        && membership.membershipId.length > 0,
      'MEMBERSHIP_CLOSURE_MEMBER',
      'canonical membership input is incomplete',
    );
    if (membership.portfolio.logicalIri !== s.portfolio.logicalIri) continue;
    if (isPitEligibleAt(membership.temporal, s.pitRequest.payload)) {
      eligibleMemberships.push(membership.versionIri);
    }
  }
  eligibleMemberships.sort(compareUtf8);
  requireCondition(
    new Set(eligibleMemberships).size === eligibleMemberships.length,
    'MEMBERSHIP_CLOSURE_MEMBER',
    'canonical input graph contains duplicate eligible membership versions',
  );
  requireCondition(
    eligibleMemberships.length === s.members.length
      && eligibleMemberships.every((value, index) => value === s.members[index]),
    'MEMBERSHIP_CLOSURE_COMPLETENESS',
    'closedMembership is not the complete PIT-eligible membership set in the canonical input graph',
  );

  policyArtifact(
    s.closureProbe,
    (payload) => closedObject(payload, [
      'completedAt',
      'inputContextDigest',
      'inputContextRef',
      'membershipCount',
      'membershipVersionIris',
      'membershipVersionSetDigest',
      'pitRequestDigest',
      'pitRequestRef',
      'portfolioLogicalIri',
      'result',
      'schemaVersion',
      'status',
    ])
      && payload.schemaVersion === '1.0'
      && payload.status === 'completed'
      && payload.result === 'complete'
      && instantNanoseconds(payload.completedAt) !== null
      && payload.portfolioLogicalIri === s.portfolio.logicalIri
      && Array.isArray(payload.membershipVersionIris)
      && payload.membershipVersionIris.length === s.members.length
      && payload.membershipVersionIris.every((value, index) => value === s.members[index])
      && payload.membershipCount === s.membershipCount
      && payload.membershipVersionSetDigest === s.membershipVersionSetDigest
      && payload.pitRequestRef === s.pitRequest.ref
      && payload.pitRequestDigest === s.pitRequest.digest
      && payload.inputContextRef === s.inputContext.ref
      && payload.inputContextDigest === s.inputContext.digest,
    'MEMBERSHIP_CLOSURE_PROBE',
    'membership closure probe',
  );
  requireCondition(
    instantNanoseconds(s.closureProbe.payload.completedAt)
      < instantNanoseconds(s.temporal.availableFrom),
    'MEMBERSHIP_CLOSURE_PROBE',
    'membership closure probe did not complete strictly before publication',
  );
}

function canonicalBusinessId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && value.normalize('NFC') === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateOptionalSnapshotListing(s, code) {
  const hasListing = typeof s.listingVersionIri === 'string';
  if (!hasListing) {
    requireCondition(
      !s.listingInstrumentVersionIri && s.listingTemporal === null,
      code,
      'absent optional listing has dangling listing evidence',
    );
    return;
  }
  const listedInstrumentVersionIri = s.listingInstrumentVersionIri;
  requireCondition(
    exactVersion(s.listingVersionIri)
      && exactVersion(listedInstrumentVersionIri)
      && listedInstrumentVersionIri.slice(
        0,
        listedInstrumentVersionIri.lastIndexOf('/version/'),
      ) === s.instrument.logicalIri
      && s.listingTemporal,
    code,
    'listing does not exactly version the snapshot instrument',
  );
  temporal(s.listingTemporal, code);
  pitEligible(s.listingTemporal, s.temporal, code);
}

function validateHolding(s) {
  temporal(s.temporal, 'HOLDING_TEMPORAL');
  requireCondition(
    exactVersion(s.versionIri)
      && canonicalBusinessId(s.snapshotId)
      && versionRef(s.observationStream)
      && logicalRef(s.account)
      && logicalRef(s.instrument)
      && iri(s.generatingContextRef),
    'HOLDING_SUBJECT',
    'holding version, logical key, account, or instrument is incomplete',
  );
  requireCondition(
    Number.isSafeInteger(s.quantityMicros)
      && s.quantityMicros >= 0
      && iri(s.quantityUnitIri),
    'HOLDING_QUANTITY',
    'holding quantity must be a non-negative scaled integer with an exact unit',
  );
  requireCondition(
    s.sourceKind === 'externalReported',
    'HOLDING_SOURCE_KIND',
    'a HoldingSnapshot must remain externally reported rather than execution-derived',
  );
  validateOptionalSnapshotListing(s, 'HOLDING_LISTING');
  requireCondition(!Object.hasOwn(s, 'portfolio') && !Object.hasOwn(s, 'side'), 'HOLDING_FORBIDDEN', 'direct portfolio/side duplicate truth is forbidden');
  authenticatedSourceEvidence(s.sourceEvidence, 'HOLDING_EVIDENCE');
}

function validatePosition(s) {
  temporal(s.temporal, 'POSITION_TEMPORAL');
  requireCondition(
    exactVersion(s.versionIri)
      && canonicalBusinessId(s.snapshotId)
      && logicalRef(s.observationStream)
      && logicalRef(s.account)
      && logicalRef(s.instrument)
      && iri(s.generatingContextRef),
    'POSITION_SUBJECT',
    'position version, logical key, account, or instrument is incomplete',
  );
  requireCondition(
    Number.isSafeInteger(s.quantityMicros) && iri(s.quantityUnitIri),
    'POSITION_QUANTITY',
    'signed position quantity must be a scaled integer with an exact unit',
  );
  requireCondition(['externalReported', 'executionDerived'].includes(s.sourceKind), 'POSITION_SOURCE_KIND', 'position source kind is not reviewed');
  validateOptionalSnapshotListing(s, 'POSITION_LISTING');
  requireCondition(!['portfolio', 'side', 'costBasis', 'pnl'].some((key) => Object.hasOwn(s, key)), 'POSITION_DUPLICATE_TRUTH', 'derived duplicate truth is forbidden');
  authenticatedSourceEvidence(s.sourceEvidence, 'POSITION_EVIDENCE');
}

function validatePositionLot(s) {
  temporal(s.temporal, 'POSITION_LOT_TEMPORAL');
  requireCondition(typeof s.lotDiscriminator === 'string' && s.lotDiscriminator.normalize('NFC') === s.lotDiscriminator
    && s.lotDiscriminator === 'openingRemainder', 'POSITION_LOT_IDENTITY', 'lot discriminator is not canonical');
  requireCondition(logicalRef(s.account) && logicalRef(s.instrument) && versionRef(s.openingExecution)
    && s.costBasisDefinition && exactVersion(s.costBasisDefinition.versionIri)
    && versionRef(s.quotationContract) && exactVersion(s.listingVersionIri)
    && iri(s.calculationContextRef),
  'POSITION_LOT_IDENTITY', 'lot account/instrument/execution/definition/context identity is incomplete');
  policyArtifact(s.costBasisDefinition.precisionPolicy, isCostBasisPrecisionPolicy, 'POSITION_LOT_POLICY', 'cost-basis precision policy');
  policyArtifact(s.costBasisDefinition.roundingPolicy, isCostBasisRoundingPolicy, 'POSITION_LOT_POLICY', 'cost-basis rounding policy');
  const precisionPolicy = s.costBasisDefinition.precisionPolicy.payload;
  const roundingPolicy = s.costBasisDefinition.roundingPolicy.payload;
  requireCondition(Number.isSafeInteger(s.originalQuantityMicros) && s.originalQuantityMicros !== 0
    && Number.isSafeInteger(s.openingGrossMicros) && s.openingGrossMicros > 0
    && Number.isSafeInteger(s.executionPriceMicros) && s.executionPriceMicros > 0
    && s.quantityScale === precisionPolicy.quantityScale
    && s.executionPriceScale === precisionPolicy.amountScale
    && s.openingCostBasisScale === precisionPolicy.amountScale
    && s.openingGrossScale === roundingPolicy.outputScale,
  'POSITION_LOT_MAGNITUDE', 'lot quantity/gross magnitude is invalid');
  requireCondition(Math.sign(s.openingCostBasisMicros) === Math.sign(s.originalQuantityMicros), 'POSITION_LOT_SIGN', 'basis sign differs from quantity sign');
  requireCondition(s.executionAccountIri === s.account.logicalIri
    && s.executionInstrumentIri === s.instrument.logicalIri
    && s.executionQuotationContractVersionIri === s.quotationContract.versionIri
    && s.costBasisDefinition.quotationContractVersionIri === s.quotationContract.versionIri
    && s.executionListingVersionIri === s.listingVersionIri
    && s.quoteListingVersionIri === s.listingVersionIri
    && s.listingInstrumentVersionIri === `${s.instrument.logicalIri}/version/0`
    && s.quoteInstrumentIri === s.instrument.logicalIri
    && s.quoteCurrency === s.executionCurrency
    && s.quoteDenominatorUnit === s.quantityUnit
    && s.costBasisDefinition.basisCurrency === s.basisCurrency
    && s.openingGrossCurrency === s.basisCurrency,
  'POSITION_LOT_JOIN', 'opening execution, quotation, and cost-basis definition do not join');
  pitEligible(s.listingTemporal, s.temporal, 'POSITION_LOT_JOIN');
  const directGross = costBasisDirectUnitValueRaw(
    Math.abs(s.originalQuantityMicros),
    s.executionPriceMicros,
    precisionPolicy,
    roundingPolicy,
  );
  let expectedGross = directGross;
  if (s.executionCurrency === s.basisCurrency) {
    requireCondition(!s.fxConversion, 'POSITION_LOT_FX', 'same-currency opening gross forbids FX');
  } else {
    const fx = s.fxConversion;
    requireCondition(fx && exactVersion(fx.versionIri) && exactVersion(fx.rateVersionIri)
      && fx.consumerVersionIri === s.versionIri && fx.consumerBackReference === fx.versionIri
      && fx.inputCurrency === s.executionCurrency && fx.outputCurrency === s.basisCurrency
      && fx.inputScale === precisionPolicy.amountScale
      && fx.outputScale === roundingPolicy.outputScale
      && fx.rateScale === precisionPolicy.rateScale
      && fx.rateUnit === `https://axiolune.ai/units/${fx.quoteCurrency}-per-${fx.baseCurrency}`
      && BigInt(fx.inputMicros) === directGross && fx.outputMicros === s.openingGrossMicros
      && fx.roundingPolicy.ref === s.costBasisDefinition.roundingPolicy.ref
      && fx.roundingPolicy.digest === s.costBasisDefinition.roundingPolicy.digest,
    'POSITION_LOT_FX', 'cross-currency opening gross lacks its exact direction-correct FX conversion');
    policyArtifact(fx.roundingPolicy, isCostBasisRoundingPolicy, 'POSITION_LOT_FX', 'cost-basis FX rounding policy');
    pitEligible(fx.rateTemporal, s.temporal, 'POSITION_LOT_FX');
    completedInputContext(fx.inputContext, s.temporal, 'POSITION_LOT_FX');
    if (fx.direction === 'baseToQuote') {
      requireCondition(fx.baseCurrency === s.executionCurrency && fx.quoteCurrency === s.basisCurrency,
        'POSITION_LOT_FX', 'base-to-quote opening conversion currencies are inconsistent');
    } else if (fx.direction === 'quoteToBase') {
      requireCondition(fx.quoteCurrency === s.executionCurrency && fx.baseCurrency === s.basisCurrency,
        'POSITION_LOT_FX', 'quote-to-base opening conversion currencies are inconsistent');
    } else reject('POSITION_LOT_FX', 'opening conversion direction is not reviewed');
    expectedGross = fxValueRaw(
      fx.inputMicros,
      fx.ratePpm,
      fx.direction,
      precisionPolicy,
      roundingPolicy,
    );
  }
  requireCondition(BigInt(s.openingGrossMicros) === expectedGross,
    'POSITION_LOT_GROSS', 'opening gross does not replay from quantity, price, and exact FX policy');
  authenticatedSourceEvidence(s.sourceEvidence, 'POSITION_LOT_EVIDENCE');
  requireCondition(!['cost', 'side', 'strategy', 'rowNumber', 'arrivalOrder'].some((key) => Object.hasOwn(s, key)), 'POSITION_LOT_FORBIDDEN', 'proxy/duplicate lot truth is forbidden');
}

function validateOpeningAllocation(s) {
  temporal(s.temporal, 'OPENING_ALLOCATION_TEMPORAL');
  requireCondition(
    versionRef(s.lot)
      && exactVersion(s.openingExecutionVersionIri)
      && exactVersion(s.definitionVersionIri)
      && exactVersion(s.quotationVersionIri)
      && iri(s.accountIri)
      && iri(s.instrumentIri)
      && iri(s.calculationContextRef)
      && Number.isSafeInteger(s.originalQuantityMicros)
      && s.originalQuantityMicros !== 0
      && Array.isArray(s.openingAllocations)
      && s.openingAllocations.length === 1,
    'OPENING_ALLOCATION_XONE',
    'lot requires exactly one opening allocation and complete immutable lot identity',
  );
  const allocation = s.openingAllocations[0];
  pitEligible(
    allocation.temporal,
    s.temporal,
    'OPENING_ALLOCATION_JOIN',
  );
  requireCondition(
    exactVersion(allocation.versionIri)
      && allocation.lotVersionIri === s.lot.versionIri
      && allocation.executionVersionIri === s.openingExecutionVersionIri
      && allocation.definitionVersionIri === s.definitionVersionIri
      && allocation.calculationContextRef === s.calculationContextRef
      && allocation.quantityMicros === Math.abs(s.originalQuantityMicros)
      && allocation.quantityMicros > 0
      && allocation.quantityUnit === s.quantityUnit
      && s.executionQuantityMicros === Math.abs(s.originalQuantityMicros)
      && s.executionQuantityUnit === s.quantityUnit
      && s.executionAccountIri === s.accountIri
      && s.executionInstrumentIri === s.instrumentIri
      && s.executionQuotationVersionIri === s.quotationVersionIri
      && s.definitionQuotationVersionIri === s.quotationVersionIri
      && s.quotationInstrumentIri === s.instrumentIri
      && ((s.originalQuantityMicros > 0 && s.executionSide === 'Buy')
        || (s.originalQuantityMicros < 0 && s.executionSide === 'Sell'))
      && ((s.listingVersionIri === undefined
        && s.executionListingVersionIri === undefined
        && s.listingInstrumentIri === undefined)
        || (exactVersion(s.listingVersionIri)
          && s.executionListingVersionIri === s.listingVersionIri
          && s.listingInstrumentIri === `${s.instrumentIri}/version/0`)),
    'OPENING_ALLOCATION_JOIN',
    'opening allocation does not reproduce execution, lot, definition, context, listing, unit, quotation, sign, or quantity truths',
  );
}

function validateValuationDefinition(s) {
  temporal(s.temporal, 'VALUATION_DEFINITION_TEMPORAL');
  requireCondition(logicalRef(s.authority)
    && typeof s.definitionId === 'string' && s.definitionId.length > 0,
  'VALUATION_DEFINITION_IDENTITY', 'definition identity is incomplete');
  exactSet(
    s.quotationContractVersionIris,
    s.quotationContractCount,
    s.quotationContractVersionSetDigest,
    'VALUATION_DEFINITION_QUOTATION_SET',
  );
  requireCondition(s.method === 'directUnitPriceTimesQuantity', 'VALUATION_DEFINITION_METHOD', 'valuation method is not the reviewed executable method');
  for (const key of ['formulaDigest', 'inputContractDigest', 'outputContractDigest', 'precisionDigest', 'roundingDigest', 'toolLockDigest', 'runtimeDigest']) requireCondition(digest(s[key]), 'VALUATION_DEFINITION_DIGEST', `${key} is invalid`);
  namedArtifact(s.formulaArtifact, 'formula', 'VALUATION_DEFINITION_ARTIFACT', 'valuation formula');
  namedArtifact(s.inputContractArtifact, 'input', 'VALUATION_DEFINITION_ARTIFACT', 'valuation input contract');
  namedArtifact(s.outputContractArtifact, 'output', 'VALUATION_DEFINITION_ARTIFACT', 'valuation output contract');
  namedArtifact(s.runtimeArtifact, 'runtime', 'VALUATION_DEFINITION_ARTIFACT', 'valuation runtime');
  namedArtifact(s.toolLockArtifact, 'tool-lock', 'VALUATION_DEFINITION_ARTIFACT', 'valuation tool lock');
  requireCondition(
    s.formulaDigest === s.formulaArtifact.digest
      && s.inputContractDigest === s.inputContractArtifact.digest
      && s.outputContractDigest === s.outputContractArtifact.digest
      && s.runtimeDigest === s.runtimeArtifact.digest
      && s.toolLockDigest === s.toolLockArtifact.digest,
    'VALUATION_DEFINITION_ARTIFACT',
    'valuation definition digest fields do not bind the executable artifact bytes',
  );
  policyArtifact(s.precisionPolicy, isValuationPrecisionPolicy, 'VALUATION_DEFINITION_POLICY', 'precision policy');
  policyArtifact(s.roundingPolicy, isValuationRoundingPolicy, 'VALUATION_DEFINITION_POLICY', 'rounding policy');
  requireCondition(s.precisionDigest === s.precisionPolicy.digest
    && s.roundingDigest === s.roundingPolicy.digest
    && s.precisionPolicy.payload.amountScale === s.roundingPolicy.payload.outputScale,
  'VALUATION_DEFINITION_POLICY', 'valuation definition does not bind the executable precision/rounding policies');
}

function validateCostBasisDefinition(s) {
  temporal(s.temporal, 'COST_BASIS_TEMPORAL');
  requireCondition(logicalRef(s.authority) && versionRef(s.quotationContract) && logicalRef(s.basisCurrency)
    && typeof s.definitionId === 'string' && s.definitionId.length > 0,
  'COST_BASIS_IDENTITY', 'cost-basis identity is incomplete');
  requireCondition(s.method === 'executionAllocatedDirectUnitCost' && s.lotOpeningPolicy === 'openingRemainder'
    && ['included', 'excluded'].includes(s.feeTreatment)
    && ['fifo', 'lifo', 'specificIdentification'].includes(s.lotConsumptionPolicy)
    && s.currencyPolicy === 'definitionBasisCurrency'
    && s.fxPolicy === 'explicitDirectionCorrect',
  'COST_BASIS_POLICY', 'cost-basis policy is not reviewed');
  for (const key of ['implementationDigest', 'inputContractDigest', 'outputContractDigest', 'runtimeDigest', 'toolLockDigest']) {
    requireCondition(digest(s[key]), 'COST_BASIS_DIGEST', `${key} is invalid`);
  }
  namedArtifact(s.implementationArtifact, 'cost-implementation', 'COST_BASIS_ARTIFACT', 'cost-basis implementation');
  namedArtifact(s.inputContractArtifact, 'cost-input', 'COST_BASIS_ARTIFACT', 'cost-basis input contract');
  namedArtifact(s.outputContractArtifact, 'cost-output', 'COST_BASIS_ARTIFACT', 'cost-basis output contract');
  namedArtifact(s.runtimeArtifact, 'cost-runtime', 'COST_BASIS_ARTIFACT', 'cost-basis runtime');
  namedArtifact(s.toolLockArtifact, 'cost-tool-lock', 'COST_BASIS_ARTIFACT', 'cost-basis tool lock');
  requireCondition(
    s.implementationDigest === s.implementationArtifact.digest
      && s.inputContractDigest === s.inputContractArtifact.digest
      && s.outputContractDigest === s.outputContractArtifact.digest
      && s.runtimeDigest === s.runtimeArtifact.digest
      && s.toolLockDigest === s.toolLockArtifact.digest
      && s.toolLockRef === s.toolLockArtifact.ref,
    'COST_BASIS_ARTIFACT',
    'cost-basis definition digest/ref fields do not bind the executable artifact bytes',
  );
  policyArtifact(s.precisionPolicy, isCostBasisPrecisionPolicy, 'COST_BASIS_POLICY', 'cost-basis precision policy');
  policyArtifact(s.roundingPolicy, isCostBasisRoundingPolicy, 'COST_BASIS_POLICY', 'cost-basis rounding policy');
  authenticatedSourceEvidence(s.sourceEvidence, 'COST_BASIS_EVIDENCE');
}

function canonicalFactRecordTemporal(value) {
  const result = {
    availableFrom: value.availableFrom,
    knowledgeFrom: value.knowledgeFrom,
    revision: value.revision,
    validFrom: value.validFrom,
  };
  if (Object.hasOwn(value, 'validTo')) result.validTo = value.validTo;
  return result;
}

function canonicalMoneyRecord(micros, currency) {
  const sign = micros < 0 ? '-' : '';
  const absolute = Math.abs(micros);
  return {
    amount: `${sign}${Math.trunc(absolute / 1_000_000)}.${String(absolute % 1_000_000).padStart(6, '0')}`,
    currency,
    scale: 6,
  };
}

function selectedFactVersionClosure(values) {
  return [...new Set(values)].sort(compareUtf8);
}

function canonicalSelectionBindings(rows) {
  return rows
    .filter((row) => row.factVersionIris.length > 0)
    .map((row) => ({
      factVersionIris: selectedFactVersionClosure(row.factVersionIris),
      role: row.role,
    }))
    .sort((left, right) => compareUtf8(left.role, right.role));
}

function portfolioValuationOutputDescriptor(s) {
  const outputRecord = {
    ...canonicalFactRecordTemporal(s.temporal),
    conversionContextDigest: s.conversionContext.digest,
    conversionContextRef: s.conversionContext.ref,
    generatingContextRef: s.generatingContextRef,
    inputContextRecordDigest: s.inputContext.digest,
    inputContextRef: s.inputContext.ref,
    memberAccountClosure: s.memberClosure.versionIri,
    pitRequestRecordDigest: s.pitRequest.digest,
    pitRequestRef: s.pitRequest.ref,
    reportingCurrency: s.reportingCurrency.logicalIri,
    source: s.sourceScopeRef,
    typeIri: `${PORTFOLIO}PortfolioValuation`,
    valuationDefinition: s.valuationDefinition.versionIri,
    valuationRunId: s.valuationRunId,
    valuedPortfolio: s.valuedPortfolio.logicalIri,
    versionIri: s.versionIri,
  };
  return {
    outputFactTypeIri: outputRecord.typeIri,
    outputFactVersionIri: outputRecord.versionIri,
    outputRecord,
    selectionBindings: canonicalSelectionBindings([
      { factVersionIris: [s.memberClosure.versionIri], role: 'memberAccountClosure' },
      { factVersionIris: s.memberClosure.members, role: 'memberMembership' },
      { factVersionIris: [s.valuationDefinition.versionIri], role: 'valuationDefinition' },
      {
        factVersionIris: s.valuationDefinition.quotationContractVersionIris,
        role: 'valuationQuotationContract',
      },
    ]),
  };
}

function pnlOutputDescriptor(s) {
  const outputRecord = {
    ...canonicalFactRecordTemporal(s.temporal),
    calculationContextRef: s.calculationContextRef,
    conversionContextDigest: s.conversionContext.digest,
    conversionContextRef: s.conversionContext.ref,
    generatingContextRef: s.generatingContextRef,
    marketValue: canonicalMoneyRecord(s.marketValueMicros, s.marketValueCurrency),
    openLotVersionSetDigest: s.openLotVersionSetDigest,
    pnlCostBasisDefinition: s.pnlCostBasisDefinitionVersionIri,
    ...(s.pnlFxConversionVersionIri === undefined ? {} : {
      pnlFxConversion: s.pnlFxConversionVersionIri,
    }),
    pnlLotStateClosure: s.lotState.versionIri,
    pnlQuotationContract: s.pnlQuotationVersionIri,
    pnlValuation: s.valuation.versionIri,
    remainingCostBasis: canonicalMoneyRecord(
      s.remainingCostBasisMicros,
      s.remainingCostBasisCurrency,
    ),
    source: s.sourceScopeRef,
    stateAllocationVersionSetDigest: s.stateAllocationVersionSetDigest,
    stateExecutionClosureVersionSetDigest: s.stateExecutionClosureVersionSetDigest,
    typeIri: `${PORTFOLIO}UnrealizedPnLObservation`,
    unrealizedPnl: canonicalMoneyRecord(s.unrealizedPnlMicros, s.currency),
    versionIri: s.versionIri,
  };
  return {
    outputFactTypeIri: outputRecord.typeIri,
    outputFactVersionIri: outputRecord.versionIri,
    outputRecord,
    selectionBindings: canonicalSelectionBindings([
      { factVersionIris: [s.pnlCostBasisDefinitionVersionIri], role: 'costBasisDefinition' },
      {
        factVersionIris: s.pnlFxConversionVersionIri === undefined
          ? []
          : [s.pnlFxConversionVersionIri],
        role: 'pnlFxConversion',
      },
      { factVersionIris: [s.lotState.versionIri], role: 'pnlLotStateClosure' },
      { factVersionIris: [s.valuation.versionIri], role: 'pnlValuation' },
      { factVersionIris: [s.pnlQuotationVersionIri], role: 'quotationContract' },
      { factVersionIris: [s.closedSnapshotVersionIri], role: 'stateSnapshot' },
      {
        factVersionIris: [s.valuationDefinitionVersionIri],
        role: 'valuationDefinition',
      },
      { factVersionIris: [s.valuationHeaderVersionIri], role: 'valuationHeader' },
      { factVersionIris: [s.valuationPriceVersionIri], role: 'valuationPrice' },
      {
        factVersionIris: s.valuationDefinitionQuotationVersionIris,
        role: 'valuationQuotationContract',
      },
    ]),
  };
}

function validatePortfolioValuation(s) {
  const outputDescriptor = portfolioValuationOutputDescriptor(s);
  const selectedFactVersionIris = selectedFactVersionClosure(
    outputDescriptor.selectionBindings.flatMap((row) => row.factVersionIris),
  );
  completedPitRequest(
    s.pitRequest,
    s.temporal,
    'PORTFOLIO_VALUATION_PIT',
    selectedFactVersionIris,
    outputDescriptor,
  );
  temporal(s.temporal, 'PORTFOLIO_VALUATION_TEMPORAL');
  for (const selected of [
    { label: 'membership closure', temporal: s.memberClosure.temporal },
    ...s.memberClosure.membershipRecords.map((record) => ({
      label: `membership ${record.versionIri}`,
      temporal: record.temporal,
    })),
    { label: 'valuation definition', temporal: s.valuationDefinition.temporal },
    ...s.valuationDefinition.quotationContractRecords.map((record) => ({
      label: `valuation quotation ${record.versionIri}`,
      temporal: record.temporal,
    })),
  ]) {
    requirePitEligibleAt(
      selected.temporal,
      s.pitRequest.payload,
      'PORTFOLIO_VALUATION_PIT_ELIGIBILITY',
      selected.label,
    );
  }
  requireCondition(
    logicalRef(s.valuedPortfolio)
      && logicalRef(s.reportingCurrency)
      && exactVersion(s.versionIri)
      && iri(s.generatingContextRef)
      && typeof s.valuationRunId === 'string'
      && s.valuationRunId.length > 0,
    'PORTFOLIO_VALUATION_CONTEXT',
    'valuation identity, currency, run, or producer context is incomplete',
  );
  validateMembershipClosure(s.memberClosure);
  requireCondition(
    s.memberClosure.portfolio.logicalIri === s.valuedPortfolio.logicalIri,
    'PORTFOLIO_VALUATION_CLOSURE',
    'membership closure belongs to another portfolio',
  );
  validateValuationDefinition(s.valuationDefinition);
  completedInputContext(
    s.conversionContext,
    s.temporal,
    'PORTFOLIO_VALUATION_CONVERSION_CONTEXT',
  );
  completedInputContext(
    s.inputContext,
    s.temporal,
    'PORTFOLIO_VALUATION_INPUT_CONTEXT',
  );
  for (const dependencyTemporal of [
    s.memberClosure.temporal,
    s.valuationDefinition.temporal,
  ]) {
    pitEligible(
      dependencyTemporal,
      s.temporal,
      'PORTFOLIO_VALUATION_PIT',
    );
  }
}

function validatePositionValuation(s) {
  temporal(s.temporal, 'POSITION_VALUATION_TEMPORAL');
  requireCondition(
    sortedUnique(s.memberAccountIris)
      && s.memberAccountIris.includes(s.snapshotAccountIri)
      && s.snapshotInstrumentIri === s.priceInstrumentIri
      && s.quoteInstrumentIri === s.priceInstrumentIri
      && s.quantityUnit === s.quoteDenominatorUnit
      && s.quoteCurrency === s.priceCurrency
      && ['listing', 'otc'].includes(s.priceContext.kind)
      && s.priceContext.kind === s.quoteContext.kind
      && s.priceContext.versionIri === s.quoteContext.versionIri
      && s.priceContext.quoteCurrency === s.priceCurrency
      && s.quoteContext.quoteCurrency === s.priceCurrency,
    'POSITION_VALUATION_JOIN',
    'snapshot, member closure, price, quotation, or market context do not join',
  );
  if (s.priceContext.kind === 'listing') {
    requireCondition(
      s.snapshotListingVersionIri === s.priceContext.versionIri
        && s.priceContext.listedInstrumentIri === s.priceInstrumentIri,
      'POSITION_VALUATION_JOIN',
      'listed valuation does not join the snapshot and listed instrument',
    );
  } else {
    requireCondition(
      s.snapshotListingVersionIri === undefined,
      'POSITION_VALUATION_JOIN',
      'OTC valuation must not carry a listing snapshot context',
    );
  }
  pitEligible(s.priceContext.temporal, s.temporal, 'POSITION_VALUATION_JOIN');
  const definition = s.valuationDefinition;
  requireCondition(definition && exactVersion(definition.versionIri)
    && definition.method === 'directUnitPriceTimesQuantity',
  'POSITION_VALUATION_DEFINITION', 'valuation line does not join the exact header definition and quotation contract');
  exactSet(
    definition.quotationContractVersionIris,
    definition.quotationContractCount,
    definition.quotationContractVersionSetDigest,
    'POSITION_VALUATION_DEFINITION',
  );
  requireCondition(
    definition.quotationContractVersionIris.includes(s.priceQuotationContractVersionIri),
    'POSITION_VALUATION_DEFINITION',
    'price quotation contract is absent from the exact header-definition quotation closure',
  );
  policyArtifact(definition.precisionPolicy, isValuationPrecisionPolicy, 'POSITION_VALUATION_POLICY', 'precision policy');
  policyArtifact(definition.roundingPolicy, isValuationRoundingPolicy, 'POSITION_VALUATION_POLICY', 'rounding policy');
  const precisionPolicy = definition.precisionPolicy.payload;
  const roundingPolicy = definition.roundingPolicy.payload;
  requireCondition(s.quantityScale === precisionPolicy.quantityScale
    && s.priceScale === precisionPolicy.amountScale
    && s.marketValueScale === roundingPolicy.outputScale
    && s.marketValueCurrency === s.reportingCurrency,
  'POSITION_VALUATION_POLICY', 'valuation structured values do not match the definition precision/rounding policy');
  const directValue = directUnitValueRaw(
    s.quantityMicros,
    s.priceMicros,
    precisionPolicy,
    roundingPolicy,
  );
  let expected = directValue;
  if (s.priceCurrency !== s.reportingCurrency) {
    requireCondition(s.fx
      && exactVersion(s.fx.versionIri)
      && exactVersion(s.fx.rateVersionIri)
      && s.fx.consumerVersionIri === s.versionIri
      && s.fx.consumerBackReference === s.fx.versionIri
      && s.fx.inputCurrency === s.priceCurrency
      && s.fx.outputCurrency === s.reportingCurrency
      && s.fx.inputScale === precisionPolicy.amountScale
      && s.fx.outputScale === roundingPolicy.outputScale
      && s.fx.rateScale === precisionPolicy.rateScale
      && s.fx.rateUnit === `https://axiolune.ai/units/${s.fx.quoteCurrency}-per-${s.fx.baseCurrency}`
      && BigInt(s.fx.inputMicros) === directValue
      && s.fx.outputMicros === s.marketValueMicros
      && s.fx.roundingPolicy.ref === definition.roundingPolicy.ref
      && s.fx.roundingPolicy.digest === definition.roundingPolicy.digest,
      'POSITION_VALUATION_FX', 'cross-currency valuation lacks direction-correct FX');
    policyArtifact(s.fx.roundingPolicy, isValuationRoundingPolicy, 'POSITION_VALUATION_FX', 'FX rounding policy');
    pitEligible(s.fx.rateTemporal, s.temporal, 'POSITION_VALUATION_FX');
    if (s.fx.direction === 'baseToQuote') {
      requireCondition(s.fx.baseCurrency === s.priceCurrency && s.fx.quoteCurrency === s.reportingCurrency,
        'POSITION_VALUATION_FX', 'base-to-quote currencies do not match the valuation line');
    } else if (s.fx.direction === 'quoteToBase') {
      requireCondition(s.fx.quoteCurrency === s.priceCurrency && s.fx.baseCurrency === s.reportingCurrency,
        'POSITION_VALUATION_FX', 'quote-to-base currencies do not match the valuation line');
    } else reject('POSITION_VALUATION_FX', 'FX direction is not reviewed');
    completedInputContext(s.fx.inputContext, s.temporal, 'POSITION_VALUATION_FX');
    expected = fxValueRaw(
      s.fx.inputMicros,
      s.fx.ratePpm,
      s.fx.direction,
      precisionPolicy,
      roundingPolicy,
    );
  } else requireCondition(!s.fx, 'POSITION_VALUATION_FX', 'same-currency valuation forbids FX');
  requireCondition(BigInt(s.marketValueMicros) === expected, 'POSITION_VALUATION_ARITHMETIC', 'market value arithmetic mismatch');
}

function validateFxConversion(s) {
  temporal(s.temporal, 'FX_CONVERSION_TEMPORAL');
  requireCondition(s.baseCurrency !== s.quoteCurrency && Number.isSafeInteger(s.ratePpm) && s.ratePpm > 0,
    'FX_CONVERSION_RATE', 'FX rate/context is invalid');
  requireCondition(
    s.rateUnit === `https://axiolune.ai/units/${s.quoteCurrency}-per-${s.baseCurrency}`,
    'FX_CONVERSION_RATE_UNIT',
    'FX rate unit does not encode the exact quote-per-base orientation',
  );
  policyArtifact(s.roundingPolicy, isValuationRoundingPolicy, 'FX_CONVERSION_POLICY', 'FX rounding policy');
  requireCondition(s.inputScale === DEFAULT_VALUATION_PRECISION_POLICY.amountScale
    && s.outputScale === s.roundingPolicy.payload.outputScale
    && s.rateScale === DEFAULT_VALUATION_PRECISION_POLICY.rateScale,
  'FX_CONVERSION_POLICY', 'FX structured-value scales do not match the executable policy');
  pitEligible(s.rateTemporal, s.temporal, 'FX_CONVERSION_RATE');
  let orientationValid = false;
  if (s.direction === 'baseToQuote') {
    orientationValid = s.inputCurrency === s.baseCurrency && s.outputCurrency === s.quoteCurrency;
  } else if (s.direction === 'quoteToBase') {
    orientationValid = s.inputCurrency === s.quoteCurrency && s.outputCurrency === s.baseCurrency;
  }
  requireCondition(orientationValid, 'FX_CONVERSION_RATE', 'FX input/output currencies do not match the selected direction');
  const expected = fxValueRaw(
    s.inputMicros,
    s.ratePpm,
    s.direction,
    DEFAULT_VALUATION_PRECISION_POLICY,
    s.roundingPolicy.payload,
  );
  requireCondition(BigInt(s.outputMicros) === expected, 'FX_CONVERSION_ARITHMETIC', 'FX conversion arithmetic/direction mismatch');
  requireCondition(Array.isArray(s.consumers) && s.consumers.length === 1 && exactVersion(s.consumers[0])
    && s.consumerBackReference === s.versionIri,
    'FX_CONVERSION_CONSUMER', 'FX conversion requires exactly one exact consumer');
  completedInputContext(s.inputContext, s.temporal, 'FX_CONVERSION_CONTEXT');
}

function validateLotAllocation(s) {
  temporal(s.temporal, 'LOT_ALLOCATION_TEMPORAL');
  requireCondition(Number.isSafeInteger(s.quantityMicros) && s.quantityMicros > 0, 'LOT_ALLOCATION_QUANTITY', 'allocation quantity must be positive');
  requireCondition(
    versionRef(s.execution)
      && versionRef(s.lot)
      && iri(s.generatingContextRef)
      && logicalRef({ logicalIri: s.lotAccountIri, referenceMode: 'logical' })
      && logicalRef({ logicalIri: s.lotInstrumentIri, referenceMode: 'logical' })
      && s.definitionVersionIri === s.lotDefinitionVersionIri
      && s.definitionQuotationVersionIri === s.lotQuotationVersionIri
      && s.definitionQuotationVersionIri === s.executionQuotationVersionIri
      && s.calculationContextRef === s.lotCalculationContextRef
      && s.executionAccountIri === s.lotAccountIri
      && s.executionInstrumentIri === s.lotInstrumentIri
      && s.executionListingVersionIri === s.lotListingVersionIri
      && s.lotListedInstrumentVersionIri === `${s.lotInstrumentIri}/version/0`
      && s.quantityUnit === s.lotQuantityUnit
      && s.quantityUnit === s.executionQuantityUnit,
    'LOT_ALLOCATION_JOIN',
    'allocation does not join the exact lot, execution, definition, listing, quotation, account, instrument, and unit truths',
  );
  pitEligible(s.lotTemporal, s.temporal, 'LOT_ALLOCATION_JOIN');
  pitEligible(s.executionTemporal, s.temporal, 'LOT_ALLOCATION_JOIN');
  if (s.kind === 'opening') {
    requireCondition(
      s.quantityMicros === Math.abs(s.originalQuantityMicros)
        && s.execution.versionIri === s.openingExecutionVersionIri
        && s.executionQuantityMicros >= s.quantityMicros
        && s.executionSide === (s.originalQuantityMicros < 0 ? 'Sell' : 'Buy'),
      'LOT_ALLOCATION_OPENING',
      'opening allocation does not reproduce the opening execution and lot sign',
    );
  } else {
    requireCondition(
      s.kind === 'consumption'
        && s.executionSide === (s.originalQuantityMicros < 0 ? 'Buy' : 'Sell')
        && Number.isSafeInteger(s.priorRemainingMicros)
        && s.quantityMicros <= s.priorRemainingMicros,
      'LOT_ALLOCATION_CONSUMPTION',
      'consumption allocation does not close side or prior remaining quantity',
    );
  }
}

function validateFeeAllocation(s) {
  temporal(s.temporal, 'FEE_ALLOCATION_TEMPORAL');
  requireCondition(
    Number.isSafeInteger(s.amountMicros)
      && s.amountMicros > 0
      && Number.isSafeInteger(s.feeAmountMicros)
      && s.feeAmountMicros > 0,
    'FEE_ALLOCATION_AMOUNT',
    'fee and allocated fee amounts must be positive exact scaled integers',
  );
  exactSet(
    s.closureFeeVersionIris,
    s.closureFeeCount,
    s.closureFeeVersionSetDigest,
    'FEE_ALLOCATION_CLOSURE',
  );
  exactSet(
    s.closureFeeAllocationVersionIris,
    s.closureFeeAllocationCount,
    s.closureFeeAllocationVersionSetDigest,
    'FEE_ALLOCATION_CLOSURE',
  );
  requireCondition(
    exactVersion(s.versionIri)
      && iri(s.generatingContextRef)
      && s.definitionVersionIri === s.lotAllocationDefinitionVersionIri
      && s.definitionVersionIri === s.closureDefinitionVersionIri
      && s.calculationContextRef === s.lotAllocationContextRef
      && s.closureAllocationVersionIris.includes(s.lotAllocationVersionIri)
      && s.closureFeeVersionIris.includes(s.feeVersionIri)
      && s.closureFeeAllocationVersionIris.includes(s.versionIri)
      && s.feeExecutionVersionIri === s.lotAllocationExecutionVersionIri
      && s.feeExecutionVersionIri === s.closureExecutionVersionIri
      && s.currency === s.basisCurrency,
    'FEE_ALLOCATION_JOIN',
    'fee allocation does not join its execution, allocation, definition, basis currency, and governing exact closure',
  );
  policyArtifact(
    s.precisionPolicy,
    isCostBasisPrecisionPolicy,
    'FEE_ALLOCATION_POLICY',
    'fee-allocation cost-basis precision policy',
  );
  policyArtifact(
    s.roundingPolicy,
    isCostBasisRoundingPolicy,
    'FEE_ALLOCATION_POLICY',
    'fee-allocation cost-basis rounding policy',
  );
  if (s.feeCurrency === s.basisCurrency) {
    requireCondition(
      !s.fx && s.amountMicros === s.feeAmountMicros,
      'FEE_ALLOCATION_CURRENCY',
      'same-basis-currency fee allocation must equal the fee and must not use FX',
    );
    return;
  }
  requireCondition(
    s.fx
      && exactVersion(s.fx.versionIri)
      && exactVersion(s.fx.rateVersionIri)
      && s.fx.consumerVersionIri === s.versionIri
      && s.fx.consumerBackReference === s.fx.versionIri
      && s.fx.inputCurrency === s.feeCurrency
      && s.fx.outputCurrency === s.basisCurrency
      && s.fx.inputMicros === s.feeAmountMicros
      && s.fx.outputMicros === s.amountMicros
      && s.fx.inputScale === s.precisionPolicy.payload.amountScale
      && s.fx.outputScale === s.roundingPolicy.payload.outputScale
      && s.fx.rateScale === s.precisionPolicy.payload.rateScale
      && s.fx.rateUnit
        === `https://axiolune.ai/units/${s.fx.quoteCurrency}-per-${s.fx.baseCurrency}`
      && s.fx.roundingPolicy.ref === s.roundingPolicy.ref
      && s.fx.roundingPolicy.digest === s.roundingPolicy.digest,
    'FEE_ALLOCATION_FX',
    'cross-basis-currency fee allocation lacks an exact direction-correct FX conversion',
  );
  policyArtifact(
    s.fx.roundingPolicy,
    isCostBasisRoundingPolicy,
    'FEE_ALLOCATION_FX',
    'fee FX rounding policy',
  );
  pitEligible(s.fx.rateTemporal, s.temporal, 'FEE_ALLOCATION_FX');
  completedInputContext(s.fx.inputContext, s.temporal, 'FEE_ALLOCATION_FX');
  if (s.fx.direction === 'baseToQuote') {
    requireCondition(
      s.fx.baseCurrency === s.feeCurrency
        && s.fx.quoteCurrency === s.basisCurrency,
      'FEE_ALLOCATION_FX',
      'base-to-quote fee FX currencies are inconsistent',
    );
  } else if (s.fx.direction === 'quoteToBase') {
    requireCondition(
      s.fx.quoteCurrency === s.feeCurrency
        && s.fx.baseCurrency === s.basisCurrency,
      'FEE_ALLOCATION_FX',
      'quote-to-base fee FX currencies are inconsistent',
    );
  } else reject('FEE_ALLOCATION_FX', 'fee FX direction is not reviewed');
  requireCondition(
    BigInt(s.amountMicros) === fxValueRaw(
      s.feeAmountMicros,
      s.fx.ratePpm,
      s.fx.direction,
      s.precisionPolicy.payload,
      s.roundingPolicy.payload,
    ),
    'FEE_ALLOCATION_FX',
    'fee FX allocation arithmetic does not replay exactly',
  );
}

function validateExecutionClosure(s) {
  completedPitRequest(
    s.pitRequest,
    s.temporal,
    'EXECUTION_CLOSURE_PIT',
    s.eligibleLotVersionIris,
  );
  temporal(s.temporal, 'EXECUTION_CLOSURE_TEMPORAL');
  requireCondition(
    exactVersion(s.versionIri)
      && iri(s.generatingContextRef)
      && exactVersion(s.executionVersionIri)
      && exactVersion(s.definitionVersionIri)
      && Number.isSafeInteger(s.executionQuantityMicros)
      && s.executionQuantityMicros > 0
      && ['Buy', 'Sell'].includes(s.executionSide)
      && iri(s.executionAccountIri)
      && iri(s.executionInstrumentIri)
      && exactVersion(s.executionListingVersionIri)
      && s.executionListingInstrumentIri === `${s.executionInstrumentIri}/version/0`
      && exactVersion(s.executionQuotationVersionIri)
      && s.executionQuotationVersionIri === s.quotationVersionIri
      && typeof s.calculationContextRef === 'string'
      && iri(s.calculationContextRef),
    'EXECUTION_CLOSURE_IDENTITY',
    'closure identity, execution context, quantity, listing, or quotation is invalid',
  );
  completedInputContext(s.inputContext, s.temporal, 'EXECUTION_CLOSURE_INPUT');
  policyArtifact(
    s.precisionPolicy,
    isCostBasisPrecisionPolicy,
    'EXECUTION_CLOSURE_DEFINITION',
    'execution-closure cost-basis precision policy',
  );
  policyArtifact(
    s.roundingPolicy,
    isCostBasisRoundingPolicy,
    'EXECUTION_CLOSURE_DEFINITION',
    'execution-closure cost-basis rounding policy',
  );
  namedArtifact(
    s.definitionArtifacts.implementation,
    'cost-implementation',
    'EXECUTION_CLOSURE_DEFINITION',
    'execution-closure cost-basis implementation',
  );
  namedArtifact(
    s.definitionArtifacts.inputContract,
    'cost-input',
    'EXECUTION_CLOSURE_DEFINITION',
    'execution-closure cost-basis input contract',
  );
  namedArtifact(
    s.definitionArtifacts.outputContract,
    'cost-output',
    'EXECUTION_CLOSURE_DEFINITION',
    'execution-closure cost-basis output contract',
  );
  namedArtifact(
    s.definitionArtifacts.runtime,
    'cost-runtime',
    'EXECUTION_CLOSURE_DEFINITION',
    'execution-closure cost-basis runtime',
  );
  namedArtifact(
    s.definitionArtifacts.toolLock,
    'cost-tool-lock',
    'EXECUTION_CLOSURE_DEFINITION',
    'execution-closure cost-basis tool lock',
  );
  exactSet(
    s.eligibleLotVersionIris,
    s.eligibleLotCount,
    s.eligibleLotVersionSetDigest,
    'EXECUTION_CLOSURE_ELIGIBLE',
  );
  exactSet(
    s.allocationVersionIris,
    s.allocationCount,
    s.allocationVersionSetDigest,
    'EXECUTION_CLOSURE_ALLOCATION',
  );
  exactSet(
    s.feeVersionIris,
    s.feeCount,
    s.feeVersionSetDigest,
    'EXECUTION_CLOSURE_FEE',
  );
  exactSet(
    s.feeAllocationVersionIris,
    s.feeAllocationCount,
    s.feeAllocationVersionSetDigest,
    'EXECUTION_CLOSURE_FEE',
  );
  const noLaterThanClosure = (candidateTemporal) => (
    isPitEligibleForConsumer(candidateTemporal, s.temporal)
  );
  const signEligible = (lot) => (
    (s.executionSide === 'Sell' && lot.originalQuantityMicros > 0)
      || (s.executionSide === 'Buy' && lot.originalQuantityMicros < 0)
  );
  const eligibleLots = s.allLots.filter((lot) => (
    exactVersion(lot.versionIri)
      && exactVersion(lot.openingExecutionVersionIri)
      && lot.accountIri === s.executionAccountIri
      && lot.instrumentIri === s.executionInstrumentIri
      && lot.listingVersionIri === s.executionListingVersionIri
      && lot.definitionVersionIri === s.definitionVersionIri
      && lot.quotationVersionIri === s.quotationVersionIri
      && lot.calculationContextRef === s.calculationContextRef
      && lot.quantityUnit === s.executionQuantityUnit
      && lot.openingExecutionAccountIri === s.executionAccountIri
      && lot.openingExecutionInstrumentIri === s.executionInstrumentIri
      && lot.openingExecutionListingVersionIri === s.executionListingVersionIri
      && ((lot.originalQuantityMicros > 0 && lot.openingExecutionSide === 'Buy')
        || (lot.originalQuantityMicros < 0 && lot.openingExecutionSide === 'Sell'))
      && Number.isSafeInteger(lot.originalQuantityMicros)
      && lot.originalQuantityMicros !== 0
      && signEligible(lot)
      && noLaterThanClosure(lot.temporal)
  )).sort((left, right) => compareUtf8(left.versionIri, right.versionIri));
  const graphEligibleLotVersionIris = eligibleLots.map((lot) => lot.versionIri);
  requireCondition(
    canonicalJcs(s.eligibleLotVersionIris) === canonicalJcs(graphEligibleLotVersionIris),
    'EXECUTION_CLOSURE_ELIGIBLE',
    'closed eligible-lot set is not the complete graph-derived PIT-eligible set',
  );
  const executionAllocations = s.allAllocations
    .filter((allocation) => allocation.executionVersionIri === s.executionVersionIri)
    .sort((left, right) => compareUtf8(left.versionIri, right.versionIri));
  requireCondition(
    canonicalJcs(s.allocationVersionIris)
      === canonicalJcs(executionAllocations.map((allocation) => allocation.versionIri)),
    'EXECUTION_CLOSURE_ALLOCATION',
    'closed allocation set is not the complete graph-derived execution set',
  );
  requireCondition(
    executionAllocations.every((allocation) => (
      exactVersion(allocation.versionIri)
        && allocation.kind === 'consumption'
        && allocation.definitionVersionIri === s.definitionVersionIri
        && allocation.calculationContextRef === s.calculationContextRef
        && s.eligibleLotVersionIris.includes(allocation.lotVersionIri)
        && Number.isSafeInteger(allocation.quantityMicros)
        && allocation.quantityMicros > 0
        && allocation.quantityUnit === s.executionQuantityUnit
        && noLaterThanClosure(allocation.temporal)
    ))
      && new Set(executionAllocations.map((allocation) => allocation.lotVersionIri)).size
        === executionAllocations.length,
    'EXECUTION_CLOSURE_ALLOCATION',
    'allocation does not join the exact execution, eligible lot, definition, context, unit, or PIT',
  );
  requireCondition(
    executionAllocations.reduce(
      (sum, allocation) => sum + BigInt(allocation.quantityMicros),
      0n,
    ) === BigInt(s.executionQuantityMicros),
    'EXECUTION_CLOSURE_CONSERVATION',
    'allocation quantities do not conserve execution quantity exactly once',
  );
  const allocationByLot = new Map(
    executionAllocations.map((allocation) => [
      allocation.lotVersionIri,
      allocation.quantityMicros,
    ]),
  );
  requireCondition(
    eligibleLots.every((lot) => (
      (allocationByLot.get(lot.versionIri) || 0) <= Math.abs(lot.originalQuantityMicros)
    )),
    'EXECUTION_CLOSURE_CONSERVATION',
    'allocation consumes more than the eligible lot quantity',
  );
  requireCondition(
    ['fifo', 'lifo', 'specificIdentification'].includes(s.lotConsumptionPolicy),
    'EXECUTION_CLOSURE_SELECTION',
    'lot-consumption policy is not reviewed',
  );
  if (s.lotConsumptionPolicy === 'fifo' || s.lotConsumptionPolicy === 'lifo') {
    requireCondition(
      s.selectedLotVersionIris.length === 0
        && s.selectedLotCount === undefined
        && s.selectedLotVersionSetDigest === undefined
        && s.specificSelection === null,
      'EXECUTION_CLOSURE_SELECTION',
      'FIFO/LIFO closure must not contain specific-identification evidence',
    );
    const ordered = [...eligibleLots].sort((left, right) => {
      const temporalOrder = instantNanoseconds(left.temporal.validFrom)
        < instantNanoseconds(right.temporal.validFrom) ? -1
        : instantNanoseconds(left.temporal.validFrom)
          > instantNanoseconds(right.temporal.validFrom) ? 1
          : compareUtf8(left.versionIri, right.versionIri);
      return s.lotConsumptionPolicy === 'fifo' ? temporalOrder : -temporalOrder;
    });
    let encounteredPartial = false;
    for (const lot of ordered) {
      const consumed = allocationByLot.get(lot.versionIri) || 0;
      requireCondition(
        !(encounteredPartial && consumed > 0),
        'EXECUTION_CLOSURE_SELECTION',
        `${s.lotConsumptionPolicy} consumed a later lot before exhausting an earlier lot`,
      );
      if (consumed < Math.abs(lot.originalQuantityMicros)) encounteredPartial = true;
    }
  } else {
    exactSet(
      s.selectedLotVersionIris,
      s.selectedLotCount,
      s.selectedLotVersionSetDigest,
      'EXECUTION_CLOSURE_SELECTION',
    );
    requireCondition(
      s.specificSelection
        && s.selectedLotVersionIris.every((value) => s.eligibleLotVersionIris.includes(value))
        && executionAllocations.every((allocation) => (
          s.selectedLotVersionIris.includes(allocation.lotVersionIri)
        )),
      'EXECUTION_CLOSURE_SELECTION',
      'specific-identification selections and consumed lots do not close over eligible lots',
    );
    policyArtifact(
      s.specificSelection,
      (payload) => closedObject(payload, [
        'closureDefinitionVersionIri',
        'closureExecutionVersionIri',
        'schemaVersion',
        'selectedLotVersionIris',
        'selectedLotVersionSetDigest',
        'status',
      ])
        && payload.schemaVersion === '1.0'
        && payload.status === 'approved'
        && payload.closureDefinitionVersionIri === s.definitionVersionIri
        && payload.closureExecutionVersionIri === s.executionVersionIri
        && canonicalJcs(payload.selectedLotVersionIris)
          === canonicalJcs(s.selectedLotVersionIris)
        && payload.selectedLotVersionSetDigest === s.selectedLotVersionSetDigest,
      'EXECUTION_CLOSURE_SELECTION',
      'specific-identification evidence',
    );
  }
  const executionFees = s.allFees
    .filter((fee) => fee.executionVersionIri === s.executionVersionIri)
    .sort((left, right) => compareUtf8(left.versionIri, right.versionIri));
  requireCondition(
    canonicalJcs(s.feeVersionIris)
      === canonicalJcs(executionFees.map((fee) => fee.versionIri)),
    'EXECUTION_CLOSURE_FEE',
    'closed Fee set is not the complete graph-derived execution Fee set',
  );
  const allocationSet = new Set(s.allocationVersionIris);
  const feeSet = new Set(s.feeVersionIris);
  const executionFeeAllocations = s.allFeeAllocations.filter((feeAllocation) => (
    allocationSet.has(feeAllocation.lotAllocationVersionIri)
      || feeSet.has(feeAllocation.feeVersionIri)
  )).sort((left, right) => compareUtf8(left.versionIri, right.versionIri));
  requireCondition(
    canonicalJcs(s.feeAllocationVersionIris)
      === canonicalJcs(executionFeeAllocations.map((row) => row.versionIri)),
    'EXECUTION_CLOSURE_FEE',
    'closed fee-allocation set is not the complete graph-derived set',
  );
  requireCondition(
    executionFees.every((fee) => (
      exactVersion(fee.versionIri)
        && Number.isSafeInteger(fee.amountMicros)
        && fee.amountMicros > 0
        && noLaterThanClosure(fee.temporal)
    ))
      && executionFeeAllocations.every((feeAllocation) => (
        exactVersion(feeAllocation.versionIri)
          && feeSet.has(feeAllocation.feeVersionIri)
          && allocationSet.has(feeAllocation.lotAllocationVersionIri)
          && feeAllocation.definitionVersionIri === s.definitionVersionIri
          && feeAllocation.calculationContextRef === s.calculationContextRef
          && Number.isSafeInteger(feeAllocation.amountMicros)
          && feeAllocation.amountMicros > 0
          && noLaterThanClosure(feeAllocation.temporal)
      )),
    'EXECUTION_CLOSURE_FEE',
    'Fee or fee allocation does not join the exact closure graph',
  );
  if (s.feeTreatment === 'excluded') {
    requireCondition(
      executionFeeAllocations.length === 0,
      'EXECUTION_CLOSURE_FEE',
      'excluded fee treatment forbids lot fee allocations',
    );
  } else {
    requireCondition(
      s.feeTreatment === 'included',
      'EXECUTION_CLOSURE_FEE',
      'fee treatment is not reviewed',
    );
    for (const fee of executionFees) {
      const rows = executionFeeAllocations.filter(
        (feeAllocation) => feeAllocation.feeVersionIri === fee.versionIri,
      );
      requireCondition(
        rows.length > 0
          && new Set(rows.map((row) => row.lotAllocationVersionIri)).size === rows.length
          && rows.every((row) => row.currency === fee.currency
            && row.currency === s.basisCurrency
            && row.fxVersionIri === undefined)
          && rows.reduce((sum, row) => sum + BigInt(row.amountMicros), 0n)
            === BigInt(fee.amountMicros),
        'EXECUTION_CLOSURE_FEE',
        'included fee allocation does not conserve one Fee across distinct lot allocations',
      );
    }
  }
  const probeCommon = {
    closureDefinitionVersionIri: s.definitionVersionIri,
    closureExecutionVersionIri: s.executionVersionIri,
    closureVersionIri: s.versionIri,
    inputContextDigest: s.inputContext.digest,
    inputContextRef: s.inputContext.ref,
    pitRequestDigest: s.pitRequest.digest,
    pitRequestRef: s.pitRequest.ref,
  };
  exactCompletedProbe(
    s.selectionProbe,
    {
      ...probeCommon,
      eligibleLotVersionIris: s.eligibleLotVersionIris,
      eligibleLotVersionSetDigest: s.eligibleLotVersionSetDigest,
      lotConsumptionPolicy: s.lotConsumptionPolicy,
      selectedLotVersionIris: s.selectedLotVersionIris,
      selectedLotVersionSetDigest: iriSetDigest(s.selectedLotVersionIris),
    },
    s.temporal,
    'EXECUTION_CLOSURE_PROBE',
    'eligible-lot selection probe',
  );
  exactCompletedProbe(
    s.allocationProbe,
    {
      ...probeCommon,
      allocationVersionIris: s.allocationVersionIris,
      allocationVersionSetDigest: s.allocationVersionSetDigest,
      executionQuantityMicros: s.executionQuantityMicros,
    },
    s.temporal,
    'EXECUTION_CLOSURE_PROBE',
    'allocation closure probe',
  );
  exactCompletedProbe(
    s.feeProbe,
    {
      ...probeCommon,
      feeAllocationVersionIris: s.feeAllocationVersionIris,
      feeAllocationVersionSetDigest: s.feeAllocationVersionSetDigest,
      feeTreatment: s.feeTreatment,
      feeVersionIris: s.feeVersionIris,
      feeVersionSetDigest: s.feeVersionSetDigest,
    },
    s.temporal,
    'EXECUTION_CLOSURE_PROBE',
    'Fee closure probe',
  );
}

function validateLotState(s) {
  completedPitRequest(
    s.pitRequest,
    s.temporal,
    'LOT_STATE_PIT',
    s.openLotVersionIris,
  );
  temporal(s.temporal, 'LOT_STATE_TEMPORAL');
  requireCondition(
    exactVersion(s.versionIri)
      && iri(s.generatingContextRef)
      && exactVersion(s.snapshotVersionIri)
      && s.snapshotPivotRef === s.snapshotVersionIri
      && s.snapshotSourceKind === 'executionDerived'
      && iri(s.accountIri)
      && iri(s.instrumentIri)
      && exactVersion(s.listingVersionIri)
      && s.listingInstrumentIri === `${s.instrumentIri}/version/0`
      && exactVersion(s.quotationVersionIri)
      && iri(s.calculationContextRef)
      && s.snapshotAccountIri === s.accountIri
      && s.snapshotInstrumentIri === s.instrumentIri
      && s.snapshotListingVersionIri === s.listingVersionIri,
    'LOT_STATE_IDENTITY',
    'lot-state closure, pivot, snapshot source, account, instrument, listing, quotation, or context is invalid',
  );
  completedInputContext(s.inputContext, s.temporal, 'LOT_STATE_INPUT');
  exactSet(
    s.openLotVersionIris,
    s.openLotCount,
    s.openLotVersionSetDigest,
    'LOT_STATE_SET',
  );
  exactSet(
    s.allocationVersionIris,
    s.allocationVersionIris.length,
    s.allocationVersionSetDigest,
    'LOT_STATE_ALLOCATION_SET',
  );
  exactSet(
    s.executionClosureVersionIris,
    s.executionClosureVersionIris.length,
    s.executionClosureVersionSetDigest,
    'LOT_STATE_EXECUTION_SET',
  );
  requireCondition(
    s.costBasisDefinition
      && exactVersion(s.costBasisDefinition.versionIri)
      && s.costBasisDefinition.basisCurrency === s.basisCurrency,
    'LOT_STATE_POLICY',
    'lot-state closure lacks an exact basis-currency calculation definition',
  );
  policyArtifact(
    s.costBasisDefinition.precisionPolicy,
    isCostBasisPrecisionPolicy,
    'LOT_STATE_POLICY',
    'cost-basis precision policy',
  );
  policyArtifact(
    s.costBasisDefinition.roundingPolicy,
    isCostBasisRoundingPolicy,
    'LOT_STATE_POLICY',
    'cost-basis rounding policy',
  );
  namedArtifact(
    s.costBasisDefinition.artifacts.implementation,
    'cost-implementation',
    'LOT_STATE_POLICY',
    'lot-state cost-basis implementation',
  );
  namedArtifact(
    s.costBasisDefinition.artifacts.inputContract,
    'cost-input',
    'LOT_STATE_POLICY',
    'lot-state cost-basis input contract',
  );
  namedArtifact(
    s.costBasisDefinition.artifacts.outputContract,
    'cost-output',
    'LOT_STATE_POLICY',
    'lot-state cost-basis output contract',
  );
  namedArtifact(
    s.costBasisDefinition.artifacts.runtime,
    'cost-runtime',
    'LOT_STATE_POLICY',
    'lot-state cost-basis runtime',
  );
  namedArtifact(
    s.costBasisDefinition.artifacts.toolLock,
    'cost-tool-lock',
    'LOT_STATE_POLICY',
    'lot-state cost-basis tool lock',
  );
  const precisionPolicy = s.costBasisDefinition.precisionPolicy.payload;
  const roundingPolicy = s.costBasisDefinition.roundingPolicy.payload;
  const noLaterThanClosure = (candidateTemporal) => (
    isPitEligibleForConsumer(candidateTemporal, s.temporal)
  );
  const relevantLots = s.allLots.filter((lot) => (
    exactVersion(lot.versionIri)
      && exactVersion(lot.openingExecutionVersionIri)
      && lot.accountIri === s.accountIri
      && lot.instrumentIri === s.instrumentIri
      && lot.listingVersionIri === s.listingVersionIri
      && lot.definitionVersionIri === s.costBasisDefinition.versionIri
      && lot.quotationVersionIri === s.quotationVersionIri
      && lot.calculationContextRef === s.calculationContextRef
      && lot.quantityUnit === s.quantityUnit
      && lot.basisCurrency === s.basisCurrency
      && lot.openingExecutionAccountIri === s.accountIri
      && lot.openingExecutionInstrumentIri === s.instrumentIri
      && lot.openingExecutionListingVersionIri === s.listingVersionIri
      && lot.openingExecutionQuantityMicros === Math.abs(lot.originalQuantityMicros)
      && lot.openingExecutionQuantityUnit === s.quantityUnit
      && ((lot.originalQuantityMicros > 0 && lot.openingExecutionSide === 'Buy')
        || (lot.originalQuantityMicros < 0 && lot.openingExecutionSide === 'Sell'))
      && Number.isSafeInteger(lot.originalQuantityMicros)
      && lot.originalQuantityMicros !== 0
      && Number.isSafeInteger(lot.openingCostBasisMicros)
      && noLaterThanClosure(lot.temporal)
  )).sort((left, right) => compareUtf8(left.versionIri, right.versionIri));
  requireCondition(
    relevantLots.length === s.allLots.length,
    'LOT_STATE_JOIN',
    'one or more lot candidates disagree on account, instrument, listing, unit, definition, quotation, context, source execution, currency, or PIT',
  );
  const relevantLotSet = new Set(relevantLots.map((lot) => lot.versionIri));
  const relevantAllocations = s.allAllocations
    .filter((allocation) => relevantLotSet.has(allocation.lotVersionIri))
    .sort((left, right) => compareUtf8(left.versionIri, right.versionIri));
  requireCondition(
    canonicalJcs(s.allocationVersionIris)
      === canonicalJcs(relevantAllocations.map((allocation) => allocation.versionIri)),
    'LOT_STATE_ALLOCATION_SET',
    'state allocation set is not the complete graph-derived lot allocation set',
  );
  requireCondition(
    relevantAllocations.every((allocation) => (
      exactVersion(allocation.versionIri)
        && exactVersion(allocation.executionVersionIri)
        && allocation.kind === 'consumption'
        && allocation.definitionVersionIri === s.costBasisDefinition.versionIri
        && allocation.calculationContextRef === s.calculationContextRef
        && allocation.quantityUnit === s.quantityUnit
        && Number.isSafeInteger(allocation.quantityMicros)
        && allocation.quantityMicros > 0
        && noLaterThanClosure(allocation.temporal)
    )),
    'LOT_STATE_ALLOCATION_SET',
    'state allocation does not join its lot, execution, definition, context, unit, or PIT',
  );
  const allocationSet = new Set(s.allocationVersionIris);
  const relevantExecutionClosures = s.allExecutionClosures.filter((closure) => (
    closure.definitionVersionIri === s.costBasisDefinition.versionIri
      && closure.allocationVersionIris.some((value) => allocationSet.has(value))
  )).sort((left, right) => compareUtf8(left.versionIri, right.versionIri));
  requireCondition(
    canonicalJcs(s.executionClosureVersionIris)
      === canonicalJcs(relevantExecutionClosures.map((closure) => closure.versionIri))
      && relevantExecutionClosures.every((closure) => (
        exactVersion(closure.versionIri)
          && exactVersion(closure.executionVersionIri)
          && closure.allocationVersionSetDigest
            === iriSetDigest(closure.allocationVersionIris)
          && closure.allocationVersionIris.every((value) => allocationSet.has(value))
          && noLaterThanClosure(closure.temporal)
      ))
      && relevantAllocations.every((allocation) => (
        relevantExecutionClosures.some((closure) => (
          closure.executionVersionIri === allocation.executionVersionIri
            && closure.allocationVersionIris.includes(allocation.versionIri)
        ))
      )),
    'LOT_STATE_EXECUTION_SET',
    'state execution-closure set is incomplete or does not close every allocation exactly',
  );
  const consumedByLot = new Map(relevantLots.map((lot) => [lot.versionIri, 0n]));
  for (const allocation of relevantAllocations) {
    consumedByLot.set(
      allocation.lotVersionIri,
      consumedByLot.get(allocation.lotVersionIri) + BigInt(allocation.quantityMicros),
    );
  }
  requireCondition(
    relevantLots.every((lot) => (
      consumedByLot.get(lot.versionIri)
        <= (BigInt(lot.originalQuantityMicros) < 0n
          ? -BigInt(lot.originalQuantityMicros)
          : BigInt(lot.originalQuantityMicros))
    )),
    'LOT_STATE_REMAINING',
    'lot consumption exceeds original signed quantity',
  );
  const contributions = relevantLots.map((lot) => {
    const original = BigInt(lot.originalQuantityMicros);
    const absolute = original < 0n ? -original : original;
    const remainingAbsolute = absolute - consumedByLot.get(lot.versionIri);
    const remaining = original < 0n ? -remainingAbsolute : remainingAbsolute;
    return {
      basis: remainingBasisRaw(
        lot.openingCostBasisMicros,
        lot.originalQuantityMicros,
        remaining,
        precisionPolicy,
        roundingPolicy,
      ),
      lotVersionIri: lot.versionIri,
      quantity: remaining,
    };
  });
  const graphOpenLotVersionIris = contributions
    .filter((row) => row.quantity !== 0n)
    .map((row) => row.lotVersionIri)
    .sort(compareUtf8);
  requireCondition(
    canonicalJcs(s.openLotVersionIris) === canonicalJcs(graphOpenLotVersionIris),
    'LOT_STATE_SET',
    'open-lot set is not the complete non-zero graph-derived set',
  );
  const expectedQuantity = contributions.reduce((sum, row) => sum + row.quantity, 0n);
  const expectedBasis = contributions.reduce((sum, row) => sum + row.basis, 0n);
  requireCondition(
    Number.isSafeInteger(s.remainingQuantityMicros)
      && Number.isSafeInteger(s.remainingCostBasisMicros)
      && BigInt(s.remainingQuantityMicros) === expectedQuantity
      && BigInt(s.remainingCostBasisMicros) === expectedBasis,
    'LOT_STATE_REMAINING',
    'snapshot quantity or remaining cost basis does not conserve lots',
  );
  const probeCommon = {
    closureVersionIri: s.versionIri,
    definitionVersionIri: s.costBasisDefinition.versionIri,
    inputContextDigest: s.inputContext.digest,
    inputContextRef: s.inputContext.ref,
    pitRequestDigest: s.pitRequest.digest,
    pitRequestRef: s.pitRequest.ref,
    snapshotPivotRef: s.snapshotPivotRef,
    snapshotVersionIri: s.snapshotVersionIri,
  };
  exactCompletedProbe(
    s.lotProbe,
    {
      ...probeCommon,
      openLotVersionIris: s.openLotVersionIris,
      openLotVersionSetDigest: s.openLotVersionSetDigest,
      remainingCostBasisMicros: s.remainingCostBasisMicros,
      remainingQuantityMicros: s.remainingQuantityMicros,
    },
    s.temporal,
    'LOT_STATE_PROBE',
    'open-lot closure probe',
  );
  exactCompletedProbe(
    s.allocationProbe,
    {
      ...probeCommon,
      allocationVersionIris: s.allocationVersionIris,
      allocationVersionSetDigest: s.allocationVersionSetDigest,
      executionClosureVersionIris: s.executionClosureVersionIris,
      executionClosureVersionSetDigest: s.executionClosureVersionSetDigest,
    },
    s.temporal,
    'LOT_STATE_PROBE',
    'state allocation closure probe',
  );
}

function validatePnl(s) {
  const outputDescriptor = pnlOutputDescriptor(s);
  const selectedFactVersionIris = selectedFactVersionClosure(
    outputDescriptor.selectionBindings.flatMap((row) => row.factVersionIris),
  );
  completedPitRequest(
    s.valuationPitRequest,
    s.temporal,
    'PNL_VALUATION_CONTEXT',
    selectedFactVersionIris,
    outputDescriptor,
  );
  temporal(s.temporal, 'PNL_TEMPORAL');
  requireCondition(
    exactVersion(s.versionIri)
      && iri(s.generatingContextRef)
      && versionRef(s.valuation)
      && versionRef(s.lotState)
      && exactVersion(s.closedSnapshotVersionIri)
      && exactVersion(s.pnlCostBasisDefinitionVersionIri)
      && exactVersion(s.pnlQuotationVersionIri)
      && s.valuationSnapshotVersionIri === s.closedSnapshotVersionIri
      && s.pnlCostBasisDefinitionVersionIri
        === s.stateCostBasisDefinitionVersionIri
      && s.pnlQuotationVersionIri === s.stateQuotationVersionIri
      && s.valuationPriceQuotationVersionIri === s.pnlQuotationVersionIri
      && s.pnlFxConversionVersionIri === s.valuationFxConversionVersionIri
      && s.valuationDefinitionQuotationVersionIris.includes(
        s.pnlQuotationVersionIri,
      )
      && s.calculationContextRef === s.stateCalculationContextRef
      && s.generatingContextRef === s.valuationGeneratingContextRef,
    'PNL_JOIN',
    'PnL valuation, lot state, snapshot, definition, quotation, context, or generating run does not join',
  );
  requireCondition(
    s.openLotVersionSetDigest === s.stateOpenLotVersionSetDigest
      && s.stateAllocationVersionSetDigest
        === s.stateStateAllocationVersionSetDigest
      && s.stateExecutionClosureVersionSetDigest
        === s.stateStateExecutionClosureVersionSetDigest,
    'PNL_DIGEST',
    'PnL does not carry the exact three lot-state closure digests',
  );
  completedInputContext(
    s.valuationInputContext,
    s.temporal,
    'PNL_VALUATION_CONTEXT',
  );
  completedInputContext(
    s.conversionContext,
    s.temporal,
    'PNL_CONVERSION_CONTEXT',
  );
  requireCondition(
    s.conversionContext.ref === s.valuationHeaderConversionContext.ref
      && s.conversionContext.digest === s.valuationHeaderConversionContext.digest
      && canonicalJcs(s.conversionContext.payload)
        === canonicalJcs(s.valuationHeaderConversionContext.payload),
    'PNL_CONVERSION_CONTEXT',
    'PnL and valuation header do not bind the same conversion context bytes',
  );
  pitEligible(s.stateTemporal, s.temporal, 'PNL_PIT');
  pitEligible(s.valuationTemporal, s.temporal, 'PNL_PIT');
  const selectedInputTemporals = [
    { label: 'PnL lot-state closure', temporal: s.stateTemporal },
    { label: 'PnL valuation', temporal: s.valuationTemporal },
    { label: 'state snapshot', temporal: s.stateSnapshotTemporal },
    { label: 'cost-basis definition', temporal: s.stateDefinitionTemporal },
    { label: 'state quotation', temporal: s.stateQuotationTemporal },
    { label: 'valuation definition', temporal: s.valuationDefinitionTemporal },
    { label: 'valuation header', temporal: s.valuationHeaderTemporal },
    { label: 'valuation price', temporal: s.valuationPriceTemporal },
    ...s.valuationDefinitionQuotationRecords.map((record) => ({
      label: `valuation quotation ${record.versionIri}`,
      temporal: record.temporal,
    })),
    ...(s.valuationFxConversionVersionIri === undefined ? [] : [{
      label: 'valuation FX conversion',
      temporal: s.valuationFxConversionTemporal,
    }]),
  ];
  for (const selected of selectedInputTemporals) {
    requirePitEligibleAt(
      selected.temporal,
      s.valuationPitRequest.payload,
      'PNL_VALUATION_CONTEXT_ELIGIBILITY',
      selected.label,
    );
  }
  requireCondition(
    [
      s.marketValueMicros,
      s.valuationMarketValueMicros,
      s.remainingCostBasisMicros,
      s.stateRemainingCostBasisMicros,
      s.unrealizedPnlMicros,
    ].every(Number.isSafeInteger)
      && s.marketValueMicros === s.valuationMarketValueMicros
      && s.remainingCostBasisMicros === s.stateRemainingCostBasisMicros,
    'PNL_VALUE_JOIN',
    'PnL market value or remaining basis does not equal its exact source fact',
  );
  requireCondition(
    BigInt(s.marketValueMicros) - BigInt(s.remainingCostBasisMicros)
      === BigInt(s.unrealizedPnlMicros),
    'PNL_EQUATION',
    'unrealized PnL equation mismatch',
  );
  requireCondition(
    s.currency === s.marketValueCurrency
      && s.currency === s.remainingCostBasisCurrency
      && s.currency === s.valuationMarketValueCurrency
      && s.currency === s.valuationReportingCurrency
      && s.currency === s.stateBasisCurrency
      && s.valuationPriceCurrency === s.currency,
    'PNL_CURRENCY',
    'PnL, valuation, reporting, price, or cost-basis currencies disagree',
  );
}

function validateExternalBasis(s) {
  temporal(s.temporal, 'EXTERNAL_BASIS_TEMPORAL');
  requireCondition(
    exactVersion(s.versionIri)
      && logicalRef(s.observationStream)
      && logicalRef(s.account)
      && logicalRef(s.instrument)
      && exactVersion(s.costBasisDefinitionVersionIri)
      && canonicalBusinessId(s.externalBasisId)
      && iri(s.generatingContextRef),
    'EXTERNAL_BASIS_IDENTITY',
    'external-basis version, observation stream, logical scope, exact calculation definition, or source id is incomplete',
  );
  requireCondition(
    Number.isSafeInteger(s.amountMicros)
      && typeof s.currency === 'string'
      && /^[A-Z]{3}$/u.test(s.currency),
    'EXTERNAL_BASIS_VALUE',
    'external cost basis must be an exact scaled Money value',
  );
  validateOptionalSnapshotListing(s, 'EXTERNAL_BASIS_LISTING');
  authenticatedSourceEvidence(s.sourceEvidence, 'EXTERNAL_BASIS_EVIDENCE');
  requireCondition(s.overwritesDerivedState !== true, 'EXTERNAL_BASIS_OVERWRITE', 'external observation cannot overwrite derived lot state');
}

function validateReconciliation(s, runtimeEvidence) {
  // Everything in `s` is caller-authored. The checks below are useful as
  // closed-schema and internal-consistency diagnostics, but none of their
  // self-recomputed digests establish MaterializationRun provenance.
  temporal(s.temporal, 'RECONCILIATION_TEMPORAL');
  requireCondition(
    exactVersion(s.versionIri) && iri(s.generatingContextRef),
    'RECONCILIATION_IDENTITY',
    'finding version or MaterializationRun IRI is incomplete',
  );
  requireCondition(
    iri(s.externalSourceScopeRef)
      && iri(s.derivedSourceScopeRef)
      && s.externalSourceScopeRef !== s.derivedSourceScopeRef
      && Array.isArray(s.candidateRecords),
    'RECONCILIATION_SOURCE',
    'distinct external and derived source scopes plus a canonical candidate graph are required',
  );
  const externalQuantitySides = [
    s.externalHoldingSnapshot,
    s.externalPositionSnapshot,
  ].filter(Boolean);
  const quantityFamilyPresent = externalQuantitySides.length > 0
    || Boolean(s.derivedSnapshotDetails);
  const basisFamilyPresent = Boolean(
    s.externalBasisDetails || s.lotStateDetails,
  );
  requireCondition(
    Number(quantityFamilyPresent) + Number(basisFamilyPresent) === 1
      && externalQuantitySides.length <= 1,
    'RECONCILIATION_BRANCH',
    'exactly one quantity or basis family with at most one external snapshot type is required',
  );
  const comparisonFamily = quantityFamilyPresent ? 'quantity' : 'basis';
  const external = quantityFamilyPresent
    ? externalQuantitySides[0]
    : s.externalBasisDetails;
  const derived = quantityFamilyPresent
    ? s.derivedSnapshotDetails
    : s.lotStateDetails;
  requireCondition(
    Boolean(external) || Boolean(derived),
    'RECONCILIATION_BRANCH',
    'the selected comparison family must contain at least one side',
  );

  validateLegacyPitRequestClaim(
    s.pitRequest,
    s.temporal,
    'RECONCILIATION_PIT',
    'caller-authored legacy reconciliation PIT claim',
  );
  const request = s.pitRequest.payload;
  requireCondition(
    instantNanoseconds(request.availableAt)
        < instantNanoseconds(request.completedAt),
    'RECONCILIATION_PIT',
    'PIT request did not complete after its availability cutoff',
  );

  const inputKeys = [
    'accountLogicalIri',
    'candidateGraphDigest',
    'candidateGraphRecordCount',
    'candidateGraphRef',
    'comparisonFamily',
    'completedAt',
    'contextId',
    'derivedCandidateCount',
    'derivedCandidateVersionSetDigest',
    'derivedCandidates',
    'derivedOutputManifestDigest',
    'derivedOutputManifestRef',
    'derivedSourceScopeRef',
    'externalCandidateCount',
    'externalCandidateVersionSetDigest',
    'externalCandidates',
    'externalSnapshotManifestDigest',
    'externalSnapshotManifestRef',
    'externalSourceScopeRef',
    'instrumentLogicalIri',
    'listingVersionIri',
    'queryDefinitionDigest',
    'queryDefinitionRef',
    'queryToolLockDigest',
    'queryToolLockRef',
    'schemaVersion',
    'status',
  ];
  policyArtifact(
    s.inputContext,
    (payload) => closedObject(payload, inputKeys)
      && payload.schemaVersion === '1.0'
      && payload.status === 'completed'
      && typeof payload.contextId === 'string'
      && payload.contextId.length > 0
      && instantNanoseconds(payload.completedAt) !== null
      && iri(payload.accountLogicalIri)
      && iri(payload.instrumentLogicalIri)
      && (payload.listingVersionIri === null
        || exactVersion(payload.listingVersionIri))
      && payload.comparisonFamily === comparisonFamily
      && iri(payload.candidateGraphRef)
      && digest(payload.candidateGraphDigest)
      && Number.isSafeInteger(payload.candidateGraphRecordCount)
      && payload.candidateGraphRecordCount >= 0
      && iri(payload.externalSnapshotManifestRef)
      && digest(payload.externalSnapshotManifestDigest)
      && iri(payload.derivedOutputManifestRef)
      && digest(payload.derivedOutputManifestDigest)
      && iri(payload.queryDefinitionRef)
      && digest(payload.queryDefinitionDigest)
      && iri(payload.queryToolLockRef)
      && digest(payload.queryToolLockDigest)
      && payload.externalSourceScopeRef === s.externalSourceScopeRef
      && payload.derivedSourceScopeRef === s.derivedSourceScopeRef
      && Array.isArray(payload.externalCandidates)
      && Array.isArray(payload.derivedCandidates),
    'RECONCILIATION_INPUT',
    'reconciliation input context',
  );
  const input = s.inputContext.payload;
  const descriptor = (row) => row
    && closedObject(row, ['recordType', 'versionIri'])
    && [
      'ExternalCostBasisObservation',
      'HoldingSnapshot',
      'PositionLotStateClosure',
      'PositionSnapshot',
    ].includes(row.recordType)
    && exactVersion(row.versionIri);
  requireCondition(
    input.externalCandidates.every(descriptor)
      && input.derivedCandidates.every(descriptor),
    'RECONCILIATION_INPUT',
    'candidate inventory contains an invalid typed exact-version descriptor',
  );

  const candidateAccountIri = (row) => (
    row.account?.logicalIri || row.accountIri || null
  );
  const candidateInstrumentIri = (row) => (
    row.instrument?.logicalIri || row.instrumentIri || null
  );
  const candidateListingVersionIri = (row) => (
    row.listingVersionIri || null
  );
  const candidateListingInstrumentVersionIri = (row) => (
    row.listingInstrumentVersionIri || row.listingInstrumentIri || null
  );
  const validateCandidate = (row) => {
    requireCondition(
      row
        && exactVersion(row.versionIri)
        && iri(row.sourceScopeRef)
        && iri(row.generatingContextRef)
        && digest(row.recordDigest),
      'RECONCILIATION_CANDIDATE',
      'candidate version, source scope, record digest, or generating run is incomplete',
    );
    if (row.recordType === 'HoldingSnapshot') validateHolding(row);
    else if (row.recordType === 'PositionSnapshot') validatePosition(row);
    else if (row.recordType === 'ExternalCostBasisObservation') {
      validateExternalBasis(row);
    } else if (row.recordType === 'PositionLotStateClosure') {
      validateLotState(row);
    } else {
      requireCondition(
        false,
        'RECONCILIATION_CANDIDATE',
        'candidate record type is not supported',
      );
    }
  };
  for (const candidate of s.candidateRecords) validateCandidate(candidate);

  const pitEligibleForRequest = (row) => {
    if (!isPitEligibleAt(row.temporal, request)) return false;
    if (!row.listingVersionIri) return true;
    return isPitEligibleAt(row.listingTemporal, request);
  };
  const inSubjectScope = (row, sourceScopeRef) => (
    row.sourceScopeRef === sourceScopeRef
      && candidateAccountIri(row) === input.accountLogicalIri
      && candidateInstrumentIri(row) === input.instrumentLogicalIri
      && candidateListingVersionIri(row) === input.listingVersionIri
      && pitEligibleForRequest(row)
  );
  const isExternalCandidate = (row) => comparisonFamily === 'quantity'
    ? (
      (row.recordType === 'HoldingSnapshot'
        && row.sourceKind === 'externalReported')
      || (row.recordType === 'PositionSnapshot'
        && row.sourceKind === 'externalReported')
    )
    : row.recordType === 'ExternalCostBasisObservation';
  const isDerivedCandidate = (row) => comparisonFamily === 'quantity'
    ? (
      row.recordType === 'PositionSnapshot'
        && row.sourceKind === 'executionDerived'
    )
    : (
      row.recordType === 'PositionLotStateClosure'
        && row.snapshotSourceKind === 'executionDerived'
    );
  const inManifestSubjectScope = (row, sourceScopeRef) => (
    row.sourceScopeRef === sourceScopeRef
      && candidateAccountIri(row) === input.accountLogicalIri
      && candidateInstrumentIri(row) === input.instrumentLogicalIri
      && candidateListingVersionIri(row) === input.listingVersionIri
  );
  const isExternalFamilyRecord = (row) => comparisonFamily === 'quantity'
    ? ['HoldingSnapshot', 'PositionSnapshot'].includes(row.recordType)
    : row.recordType === 'ExternalCostBasisObservation';
  const isDerivedFamilyRecord = (row) => comparisonFamily === 'quantity'
    ? row.recordType === 'PositionSnapshot'
    : row.recordType === 'PositionLotStateClosure';
  const externalManifestCandidateRecords = s.candidateRecords.filter((row) => (
    inManifestSubjectScope(row, s.externalSourceScopeRef)
      && isExternalFamilyRecord(row)
  ));
  const derivedManifestCandidateRecords = s.candidateRecords.filter((row) => (
    inManifestSubjectScope(row, s.derivedSourceScopeRef)
      && isDerivedFamilyRecord(row)
  ));
  requireCondition(
    externalManifestCandidateRecords.every(isExternalCandidate)
      && derivedManifestCandidateRecords.every(isDerivedCandidate),
    'RECONCILIATION_SOURCE_KIND',
    'manifest-scoped records must carry the source kind required by their external or derived branch',
  );
  const externalCandidates = s.candidateRecords
    .filter((row) => isExternalCandidate(row)
      && inSubjectScope(row, s.externalSourceScopeRef))
    .sort((left, right) => compareUtf8(left.versionIri, right.versionIri));
  const derivedCandidates = s.candidateRecords
    .filter((row) => isDerivedCandidate(row)
      && inSubjectScope(row, s.derivedSourceScopeRef))
    .sort((left, right) => compareUtf8(left.versionIri, right.versionIri));
  const externalVersionIris = externalCandidates.map((row) => row.versionIri);
  const derivedVersionIris = derivedCandidates.map((row) => row.versionIri);
  const externalDescriptors = externalCandidates.map((row) => ({
    recordType: row.recordType,
    versionIri: row.versionIri,
  }));
  const derivedDescriptors = derivedCandidates.map((row) => ({
    recordType: row.recordType,
    versionIri: row.versionIri,
  }));
  const graphDescriptor = (row) => ({
    accountLogicalIri: candidateAccountIri(row),
    generatingContextRef: row.generatingContextRef,
    instrumentLogicalIri: candidateInstrumentIri(row),
    listingVersionIri: candidateListingVersionIri(row),
    recordDigest: row.recordDigest,
    recordType: row.recordType,
    sourceScopeRef: row.sourceScopeRef,
    versionIri: row.versionIri,
  });
  const candidateGraphRows = s.candidateRecords
    .map(graphDescriptor)
    .sort((left, right) => compareUtf8(
      left.versionIri,
      right.versionIri,
    ));
  policyArtifact(
    s.candidateGraph,
    (payload) => closedObject(payload, [
      'graphKind',
      'records',
      'schemaVersion',
      'sourceScopes',
      'status',
    ])
      && payload.graphKind === 'preReconciliationCandidateInput'
      && payload.schemaVersion === '1.0'
      && payload.status === 'sealed'
      && canonicalJcs(payload.sourceScopes)
        === canonicalJcs([
          s.derivedSourceScopeRef,
          s.externalSourceScopeRef,
        ].sort(compareUtf8))
      && candidateGraphRows.every((row) => (
        row.sourceScopeRef === s.derivedSourceScopeRef
          || row.sourceScopeRef === s.externalSourceScopeRef
      ))
      && canonicalJcs(payload.records) === canonicalJcs(candidateGraphRows),
    'RECONCILIATION_CANDIDATE_GRAPH',
    'pre-run reconciliation candidate graph',
  );
  requireCondition(
    s.candidateGraphRecordCount === candidateGraphRows.length,
    'RECONCILIATION_CANDIDATE_GRAPH',
    'candidate graph count does not equal its complete canonical record inventory',
  );

  policyArtifact(
    s.queryDefinition,
    (payload) => closedObject(payload, [
      'absenceSemantics',
      'algorithm',
      'candidateFamilies',
      'exactScopeFields',
      'schemaVersion',
      'selectionCardinality',
      'validInterval',
    ])
      && payload.schemaVersion === '1.0'
      && payload.algorithm === 'three-axis-pit-half-open-v1'
      && payload.validInterval === '[validFrom,validTo)'
      && payload.selectionCardinality === 'zero-or-one-per-side'
      && payload.absenceSemantics
        === 'missing-side-only-after-complete-source-manifest'
      && canonicalJcs(payload.exactScopeFields) === canonicalJcs([
        'accountLogicalIri',
        'instrumentLogicalIri',
        'listingVersionIri',
        'sourceScopeRef',
      ])
      && payload.candidateFamilies
      && closedObject(payload.candidateFamilies, ['basis', 'quantity'])
      && closedObject(
        payload.candidateFamilies.basis,
        ['derived', 'external'],
      )
      && closedObject(
        payload.candidateFamilies.quantity,
        ['derived', 'external'],
      )
      && canonicalJcs(payload.candidateFamilies) === canonicalJcs({
        basis: {
          derived: ['PositionLotStateClosure'],
          external: ['ExternalCostBasisObservation'],
        },
        quantity: {
          derived: ['PositionSnapshot:executionDerived'],
          external: [
            'HoldingSnapshot:externalReported',
            'PositionSnapshot:externalReported',
          ],
        },
      }),
    'RECONCILIATION_QUERY',
    'candidate-selection query definition',
  );
  policyArtifact(
    s.queryToolLock,
    (payload) => closedObject(payload, [
      'canonicalization',
      'implementationContract',
      'queryDefinitionDigest',
      'queryDefinitionRef',
      'runtime',
      'schemaVersion',
      'status',
    ])
      && payload.schemaVersion === '1.0'
      && payload.status === 'locked'
      && payload.canonicalization === 'RFC8785-JCS'
      && payload.runtime === 'node-commonjs-restricted-worker'
      && payload.implementationContract
        === 'orders-portfolio-reconciliation-candidate-selection-v1'
      && payload.queryDefinitionRef === s.queryDefinition.ref
      && payload.queryDefinitionDigest === s.queryDefinition.digest,
    'RECONCILIATION_QUERY',
    'candidate-selection query tool lock',
  );

  const allExternalManifestRows = candidateGraphRows
    .filter((row) => row.sourceScopeRef === s.externalSourceScopeRef)
    .filter((row) => (
      row.accountLogicalIri === input.accountLogicalIri
        && row.instrumentLogicalIri === input.instrumentLogicalIri
        && row.listingVersionIri === input.listingVersionIri
    ))
    .filter((row) => comparisonFamily === 'quantity'
      ? ['HoldingSnapshot', 'PositionSnapshot'].includes(row.recordType)
      : row.recordType === 'ExternalCostBasisObservation');
  const allDerivedManifestRows = candidateGraphRows
    .filter((row) => row.sourceScopeRef === s.derivedSourceScopeRef)
    .filter((row) => (
      row.accountLogicalIri === input.accountLogicalIri
        && row.instrumentLogicalIri === input.instrumentLogicalIri
        && row.listingVersionIri === input.listingVersionIri
    ))
    .filter((row) => comparisonFamily === 'quantity'
      ? row.recordType === 'PositionSnapshot'
      : row.recordType === 'PositionLotStateClosure');
  const externalManifestRecordSetDigest = sha256DomainJcs(
    'axiolune-reconciliation-record-set-v1',
    allExternalManifestRows,
  );
  const derivedManifestRecordSetDigest = sha256DomainJcs(
    'axiolune-reconciliation-record-set-v1',
    allDerivedManifestRows,
  );
  policyArtifact(
    s.externalSourceContract,
    (payload) => closedObject(payload, [
      'absenceInference',
      'completenessSemantics',
      'pagination',
      'schemaVersion',
      'sourceScopeRef',
      'status',
      'subjectScopeFields',
    ])
      && payload.schemaVersion === '1.0'
      && payload.status === 'locked'
      && payload.sourceScopeRef === s.externalSourceScopeRef
      && payload.completenessSemantics === 'fullSnapshot'
      && payload.absenceInference
        === 'allowedOnlyAfterTerminalCompleteResponse'
      && closedObject(payload.pagination, [
        'requireContiguousPageIndexes',
        'requireTerminalPage',
      ])
      && payload.pagination.requireContiguousPageIndexes === true
      && payload.pagination.requireTerminalPage === true
      && canonicalJcs(payload.subjectScopeFields) === canonicalJcs([
        'accountLogicalIri',
        'comparisonFamily',
        'instrumentLogicalIri',
        'listingVersionIri',
      ]),
    'RECONCILIATION_EXTERNAL_MANIFEST',
    'external full-snapshot source contract',
  );
  const externalManifest = s.externalSnapshotManifest.payload;
  const externalManifestKeys = [
    'accountLogicalIri',
    'comparisonFamily',
    'completeResponse',
    'completedAt',
    'completenessSemantics',
    'instrumentLogicalIri',
    'listingVersionIri',
    'pageCount',
    'pages',
    'recordCount',
    'recordSetDigest',
    'records',
    'schemaVersion',
    'sourceContractDigest',
    'sourceContractRef',
    'sourceScopeRef',
    'status',
    'terminalPageIndex',
  ];
  policyArtifact(
    s.externalSnapshotManifest,
    (payload) => closedObject(payload, externalManifestKeys)
      && payload.schemaVersion === '1.0'
      && payload.status === 'completed'
      && payload.completeResponse === true
      && payload.completenessSemantics === 'fullSnapshot'
      && payload.sourceContractRef === s.externalSourceContract.ref
      && payload.sourceContractDigest === s.externalSourceContract.digest
      && payload.sourceScopeRef === s.externalSourceScopeRef
      && payload.accountLogicalIri === input.accountLogicalIri
      && payload.instrumentLogicalIri === input.instrumentLogicalIri
      && payload.listingVersionIri === input.listingVersionIri
      && payload.comparisonFamily === comparisonFamily
      && instantNanoseconds(payload.completedAt) !== null
      && Number.isSafeInteger(payload.pageCount)
      && payload.pageCount > 0
      && Array.isArray(payload.pages)
      && payload.pages.length === payload.pageCount
      && payload.terminalPageIndex === payload.pageCount - 1
      && Number.isSafeInteger(payload.recordCount)
      && payload.recordCount === allExternalManifestRows.length
      && payload.recordSetDigest === externalManifestRecordSetDigest
      && canonicalJcs(payload.records)
        === canonicalJcs(allExternalManifestRows),
    'RECONCILIATION_EXTERNAL_MANIFEST',
    'terminal external full-snapshot manifest',
  );
  requireCondition(
    Array.isArray(s.externalSnapshotPages)
      && s.externalSnapshotPages.length === externalManifest.pageCount,
    'RECONCILIATION_EXTERNAL_MANIFEST',
    'external page artifact set does not equal the manifest page count',
  );
  const concatenatedExternalRows = [];
  for (const [index, page] of s.externalSnapshotPages.entries()) {
    const manifestPage = externalManifest.pages[index];
    requireCondition(
      manifestPage
        && closedObject(manifestPage, [
          'pageDigest',
          'pageIndex',
          'pageRef',
          'terminal',
        ])
        && manifestPage.pageIndex === index
        && manifestPage.pageRef === page.ref
        && manifestPage.pageDigest === page.digest
        && manifestPage.terminal === (index === externalManifest.pageCount - 1),
      'RECONCILIATION_EXTERNAL_MANIFEST',
      'external page descriptor order, digest, or terminal marker drifted',
    );
    policyArtifact(
      page,
      (payload) => closedObject(payload, [
        'nextPageToken',
        'pageIndex',
        'recordCount',
        'recordSetDigest',
        'records',
        'schemaVersion',
        'terminal',
      ])
        && payload.schemaVersion === '1.0'
        && payload.pageIndex === index
        && payload.terminal === (index === externalManifest.pageCount - 1)
        && (payload.terminal
          ? payload.nextPageToken === null
          : typeof payload.nextPageToken === 'string'
            && payload.nextPageToken.length > 0)
        && Array.isArray(payload.records)
        && payload.recordCount === payload.records.length
        && payload.recordSetDigest === sha256DomainJcs(
          'axiolune-reconciliation-record-set-v1',
          payload.records,
        ),
      'RECONCILIATION_EXTERNAL_MANIFEST',
      `external snapshot page ${index}`,
    );
    concatenatedExternalRows.push(...page.payload.records);
  }
  requireCondition(
    canonicalJcs(concatenatedExternalRows)
      === canonicalJcs(allExternalManifestRows),
    'RECONCILIATION_EXTERNAL_MANIFEST',
    'external terminal page chain omits, duplicates, or substitutes a source record',
  );

  const derivedManifest = s.derivedOutputManifest.payload;
  policyArtifact(
    s.derivedOutputManifest,
    (payload) => closedObject(payload, [
      'accountLogicalIri',
      'comparisonFamily',
      'completedAt',
      'generatingContextRef',
      'instrumentLogicalIri',
      'listingVersionIri',
      'recordCount',
      'recordSetDigest',
      'records',
      'schemaVersion',
      'sourceScopeRef',
      'status',
    ])
      && payload.schemaVersion === '1.0'
      && payload.status === 'completed'
      && iri(payload.generatingContextRef)
      && payload.sourceScopeRef === s.derivedSourceScopeRef
      && payload.accountLogicalIri === input.accountLogicalIri
      && payload.instrumentLogicalIri === input.instrumentLogicalIri
      && payload.listingVersionIri === input.listingVersionIri
      && payload.comparisonFamily === comparisonFamily
      && instantNanoseconds(payload.completedAt) !== null
      && payload.recordCount === allDerivedManifestRows.length
      && payload.recordSetDigest === derivedManifestRecordSetDigest
      && canonicalJcs(payload.records)
        === canonicalJcs(allDerivedManifestRows)
      && allDerivedManifestRows.every(
        (row) => row.generatingContextRef === payload.generatingContextRef,
      ),
    'RECONCILIATION_DERIVED_MANIFEST',
    'completed derived output manifest',
  );

  exactSet(
    externalVersionIris,
    s.externalCandidateCount,
    s.externalCandidateVersionSetDigest,
    'RECONCILIATION_CLOSURE',
  );
  exactSet(
    derivedVersionIris,
    s.derivedCandidateCount,
    s.derivedCandidateVersionSetDigest,
    'RECONCILIATION_CLOSURE',
  );
  requireCondition(
    externalCandidates.length <= 1
      && derivedCandidates.length <= 1
      && externalCandidates.length + derivedCandidates.length > 0,
    'RECONCILIATION_CLOSURE',
    'each source side must have zero or one eligible candidate and the closed universe cannot be empty',
  );
  requireCondition(
    input.candidateGraphRef === s.candidateGraph.ref
      && input.candidateGraphDigest === s.candidateGraph.digest
      && input.candidateGraphRecordCount === s.candidateGraphRecordCount
      && input.externalSnapshotManifestRef
        === s.externalSnapshotManifest.ref
      && input.externalSnapshotManifestDigest
        === s.externalSnapshotManifest.digest
      && input.derivedOutputManifestRef === s.derivedOutputManifest.ref
      && input.derivedOutputManifestDigest
        === s.derivedOutputManifest.digest
      && input.queryDefinitionRef === s.queryDefinition.ref
      && input.queryDefinitionDigest === s.queryDefinition.digest
      && input.queryToolLockRef === s.queryToolLock.ref
      && input.queryToolLockDigest === s.queryToolLock.digest
      && input.externalCandidateCount === s.externalCandidateCount
      && input.externalCandidateVersionSetDigest
        === s.externalCandidateVersionSetDigest
      && canonicalJcs(input.externalCandidates)
        === canonicalJcs(externalDescriptors)
      && input.derivedCandidateCount === s.derivedCandidateCount
      && input.derivedCandidateVersionSetDigest
        === s.derivedCandidateVersionSetDigest
      && canonicalJcs(input.derivedCandidates)
        === canonicalJcs(derivedDescriptors),
    'RECONCILIATION_INPUT',
    'input context does not inventory the complete recomputed candidate universe',
  );

  const closedExternal = externalCandidates[0] || null;
  const closedDerived = derivedCandidates[0] || null;
  requireCondition(
    closedExternal !== null && closedDerived !== null,
    'RECONCILIATION_ABSENCE_UNPROVEN',
    'missing-side reconciliation is fail-closed until both source universes are proven by completed upstream MaterializationRun bundles and detached ledger evidence',
  );
  const selectedExternalVersionIri = external?.versionIri || null;
  const selectedDerivedVersionIri = derived?.versionIri || null;
  const selectedExternalType = s.externalHoldingSnapshot
    ? 'HoldingSnapshot'
    : s.externalPositionSnapshot
      ? 'PositionSnapshot'
      : comparisonFamily === 'basis' && s.externalBasisDetails
        ? 'ExternalCostBasisObservation'
        : null;
  requireCondition(
    selectedExternalVersionIri === (closedExternal?.versionIri || null)
      && selectedDerivedVersionIri === (closedDerived?.versionIri || null)
      && selectedExternalType === (closedExternal?.recordType || null),
    'RECONCILIATION_CLOSURE',
    'finding roles do not exactly mirror the closed external and derived candidate sets',
  );

  const comparisonAccountIri = input.accountLogicalIri;
  const comparisonInstrumentIri = input.instrumentLogicalIri;
  const comparisonListingVersionIri = input.listingVersionIri;
  const closedCandidates = [closedExternal, closedDerived].filter(Boolean);
  requireCondition(
    closedCandidates.every((row) => (
      candidateAccountIri(row) === comparisonAccountIri
      && candidateInstrumentIri(row) === comparisonInstrumentIri
      && candidateListingVersionIri(row) === comparisonListingVersionIri
    )),
    'RECONCILIATION_JOIN',
    'closed candidates do not share the exact account, instrument, and optional listing scope',
  );
  const listingSides = closedCandidates.filter(
    (row) => row.listingVersionIri,
  );
  requireCondition(
    listingSides.every((row) => {
      const listedInstrumentVersionIri =
        candidateListingInstrumentVersionIri(row);
      return exactVersion(row.listingVersionIri)
        && exactVersion(listedInstrumentVersionIri)
        && listedInstrumentVersionIri.slice(
          0,
          listedInstrumentVersionIri.lastIndexOf('/version/'),
        ) === comparisonInstrumentIri;
    }),
    'RECONCILIATION_JOIN',
    'a closed candidate listing does not version the compared instrument',
  );

  let comparisonUnitOrCurrency;
  let valuesEqual = false;
  let externalValueMicros = null;
  let derivedValueMicros = null;
  if (comparisonFamily === 'quantity') {
    const externalUnit = closedExternal?.quantityUnitIri || null;
    const derivedUnit = closedDerived?.quantityUnitIri || null;
    comparisonUnitOrCurrency = externalUnit || derivedUnit;
    externalValueMicros = closedExternal?.quantityMicros ?? null;
    derivedValueMicros = closedDerived?.quantityMicros ?? null;
    requireCondition(
      iri(comparisonUnitOrCurrency)
        && (!closedExternal || Number.isSafeInteger(externalValueMicros))
        && (!closedDerived || Number.isSafeInteger(derivedValueMicros))
        && (!closedExternal || !closedDerived || externalUnit === derivedUnit),
      'RECONCILIATION_JOIN',
      'quantity values or exact units are incompatible',
    );
    valuesEqual = Boolean(
      closedExternal && closedDerived
      && externalValueMicros === derivedValueMicros,
    );
  } else {
    const externalCurrency = closedExternal?.currency || null;
    const derivedCurrency = closedDerived?.basisCurrency || null;
    comparisonUnitOrCurrency = externalCurrency || derivedCurrency;
    externalValueMicros = closedExternal?.amountMicros ?? null;
    derivedValueMicros = closedDerived?.remainingCostBasisMicros ?? null;
    requireCondition(
      typeof comparisonUnitOrCurrency === 'string'
        && /^[A-Z]{3}$/u.test(comparisonUnitOrCurrency)
        && (!closedExternal || Number.isSafeInteger(externalValueMicros))
        && (!closedDerived || Number.isSafeInteger(derivedValueMicros))
        && (!closedExternal || !closedDerived
          || externalCurrency === derivedCurrency),
      'RECONCILIATION_JOIN',
      'cost-basis values or currencies are incompatible',
    );
    requireCondition(
      closedExternal.costBasisDefinitionVersionIri
        === closedDerived.costBasisDefinition.versionIri,
      'RECONCILIATION_BASIS_DEFINITION',
      'external and execution-derived cost basis use different exact calculation-definition versions',
    );
    valuesEqual = Boolean(
      closedExternal && closedDerived
      && externalValueMicros === derivedValueMicros,
    );
  }

  const externalVersionIri = closedExternal?.versionIri || null;
  const derivedVersionIri = closedDerived?.versionIri || null;
  const externalRecordType = closedExternal?.recordType === 'HoldingSnapshot'
    ? 'HoldingSnapshot'
    : closedExternal?.recordType === 'PositionSnapshot'
      ? 'PositionSnapshot'
      : closedExternal?.recordType === 'ExternalCostBasisObservation'
        ? 'ExternalCostBasisObservation'
        : null;
  const expectedSubjectDigest = sha256DomainJcs(
    'axiolune-portfolio-reconciliation-subject-v4',
    {
      candidateGraphDigest: s.candidateGraph.digest,
      comparisonFamily,
      derivedCandidateVersionSetDigest:
        s.derivedCandidateVersionSetDigest,
      derivedOutputManifestDigest: s.derivedOutputManifest.digest,
      derivedSourceScopeRef: s.derivedSourceScopeRef,
      derivedVersionIri,
      externalCandidateVersionSetDigest:
        s.externalCandidateVersionSetDigest,
      externalSnapshotManifestDigest: s.externalSnapshotManifest.digest,
      externalRecordType,
      externalSourceScopeRef: s.externalSourceScopeRef,
      externalVersionIri,
      pitRequestDigest: s.pitRequest.digest,
      queryDefinitionDigest: s.queryDefinition.digest,
      queryToolLockDigest: s.queryToolLock.digest,
    },
  );
  requireCondition(
    digest(s.subjectDigest) && s.subjectDigest === expectedSubjectDigest,
    'RECONCILIATION_SUBJECT_DIGEST',
    'subject digest does not bind the exact nullable compared versions and family',
  );

  requireCondition(
    closedCandidates.every(pitEligibleForRequest),
    'RECONCILIATION_PIT',
    'a closed candidate or listing is not PIT-eligible for the exact request',
  );

  evidence(s.reconciliationContext, 'RECONCILIATION_CONTEXT');
  const context = s.reconciliationContext.payload;
  const contextKeys = [
    'accountLogicalIri',
    'candidateGraphDigest',
    'candidateGraphRef',
    'comparedDerivedVersionIri',
    'comparedExternalRecordType',
    'comparedExternalVersionIri',
    'comparisonFamily',
    'comparisonMode',
    'comparisonUnitOrCurrency',
    'completedAt',
    'derivedCandidateCount',
    'derivedCandidateVersionSetDigest',
    'derivedOutputManifestDigest',
    'derivedOutputManifestRef',
    'derivedSourceScopeRef',
    'derivedValueMicros',
    'externalCandidateCount',
    'externalCandidateVersionSetDigest',
    'externalSnapshotManifestDigest',
    'externalSnapshotManifestRef',
    'externalSourceScopeRef',
    'externalValueMicros',
    'generatingContextRef',
    'inputContextDigest',
    'inputContextRef',
    'instrumentLogicalIri',
    'listingVersionIri',
    'pitRequestDigest',
    'pitRequestRef',
    'queryDefinitionDigest',
    'queryDefinitionRef',
    'queryToolLockDigest',
    'queryToolLockRef',
    'schemaVersion',
    'status',
  ];
  requireCondition(
    closedObject(context, contextKeys)
      && s.reconciliationContext.digest === sha256Jcs(context)
      && context.accountLogicalIri === comparisonAccountIri
      && context.candidateGraphRef === s.candidateGraph.ref
      && context.candidateGraphDigest === s.candidateGraph.digest
      && context.comparedDerivedVersionIri === derivedVersionIri
      && context.comparedExternalRecordType === externalRecordType
      && context.comparedExternalVersionIri === externalVersionIri
      && context.comparisonFamily === comparisonFamily
      && context.comparisonMode === 'exact'
      && context.comparisonUnitOrCurrency === comparisonUnitOrCurrency
      && context.derivedCandidateCount === s.derivedCandidateCount
      && context.derivedCandidateVersionSetDigest
        === s.derivedCandidateVersionSetDigest
      && context.derivedOutputManifestRef
        === s.derivedOutputManifest.ref
      && context.derivedOutputManifestDigest
        === s.derivedOutputManifest.digest
      && context.derivedSourceScopeRef === s.derivedSourceScopeRef
      && context.derivedValueMicros === derivedValueMicros
      && context.externalCandidateCount === s.externalCandidateCount
      && context.externalCandidateVersionSetDigest
        === s.externalCandidateVersionSetDigest
      && context.externalSnapshotManifestRef
        === s.externalSnapshotManifest.ref
      && context.externalSnapshotManifestDigest
        === s.externalSnapshotManifest.digest
      && context.externalSourceScopeRef === s.externalSourceScopeRef
      && context.externalValueMicros === externalValueMicros
      && context.generatingContextRef === s.generatingContextRef
      && context.inputContextRef === s.inputContext.ref
      && context.inputContextDigest === s.inputContext.digest
      && context.instrumentLogicalIri === comparisonInstrumentIri
      && context.listingVersionIri === comparisonListingVersionIri
      && context.pitRequestRef === s.pitRequest.ref
      && context.pitRequestDigest === s.pitRequest.digest
      && context.queryDefinitionRef === s.queryDefinition.ref
      && context.queryDefinitionDigest === s.queryDefinition.digest
      && context.queryToolLockRef === s.queryToolLock.ref
      && context.queryToolLockDigest === s.queryToolLock.digest
      && context.schemaVersion === '1.0'
      && context.status === 'completed'
      && instantNanoseconds(context.completedAt) !== null,
    'RECONCILIATION_CONTEXT',
    'reconciliation context bytes do not bind the exact scope, values, request, and candidate sets',
  );
  const latestInputAvailability = closedCandidates
    .map((row) => instantNanoseconds(row.temporal.availableFrom))
    .reduce((left, right) => left > right ? left : right);
  requireCondition(
    latestInputAvailability < instantNanoseconds(input.completedAt)
      && instantNanoseconds(externalManifest.completedAt)
        < instantNanoseconds(input.completedAt)
      && instantNanoseconds(derivedManifest.completedAt)
        < instantNanoseconds(input.completedAt)
      && instantNanoseconds(request.completedAt)
        < instantNanoseconds(input.completedAt)
      && instantNanoseconds(input.completedAt)
        < instantNanoseconds(context.completedAt)
      && instantNanoseconds(context.completedAt)
        < instantNanoseconds(s.temporal.availableFrom),
    'RECONCILIATION_CONTEXT',
    'input and reconciliation contexts did not complete in strict causal order',
  );

  const probe = s.closureProbe;
  const probeKeys = [
    'accountLogicalIri',
    'candidateGraphDigest',
    'candidateGraphRecordCount',
    'candidateGraphRef',
    'comparedDerivedVersionIri',
    'comparedExternalRecordType',
    'comparedExternalVersionIri',
    'comparisonFamily',
    'completedAt',
    'derivedCandidateCount',
    'derivedCandidateVersionSetDigest',
    'derivedCandidateVersionIris',
    'derivedOutputManifestDigest',
    'derivedOutputManifestRef',
    'derivedSourceScopeRef',
    'externalCandidateCount',
    'externalCandidateVersionSetDigest',
    'externalCandidateVersionIris',
    'externalSnapshotManifestDigest',
    'externalSnapshotManifestRef',
    'externalSourceScopeRef',
    'findingVersionIri',
    'inputContextDigest',
    'inputContextRef',
    'instrumentLogicalIri',
    'listingVersionIri',
    'pitRequestDigest',
    'pitRequestRef',
    'queryDefinitionDigest',
    'queryDefinitionRef',
    'queryToolLockDigest',
    'queryToolLockRef',
    'reconciliationContextDigest',
    'reconciliationContextRef',
    'result',
    'schemaVersion',
    'status',
  ];
  policyArtifact(
    probe,
    (payload) => closedObject(payload, probeKeys)
      && payload.schemaVersion === '1.0'
      && payload.status === 'completed'
      && payload.result === 'complete'
      && instantNanoseconds(payload.completedAt) !== null
      && payload.accountLogicalIri === comparisonAccountIri
      && payload.candidateGraphRef === s.candidateGraph.ref
      && payload.candidateGraphDigest === s.candidateGraph.digest
      && payload.candidateGraphRecordCount === s.candidateGraphRecordCount
      && payload.comparedDerivedVersionIri === derivedVersionIri
      && payload.comparedExternalRecordType === externalRecordType
      && payload.comparedExternalVersionIri === externalVersionIri
      && payload.comparisonFamily === comparisonFamily
      && payload.derivedCandidateCount === s.derivedCandidateCount
      && payload.derivedCandidateVersionSetDigest
        === s.derivedCandidateVersionSetDigest
      && canonicalJcs(payload.derivedCandidateVersionIris)
        === canonicalJcs(derivedVersionIris)
      && payload.derivedOutputManifestRef
        === s.derivedOutputManifest.ref
      && payload.derivedOutputManifestDigest
        === s.derivedOutputManifest.digest
      && payload.derivedSourceScopeRef === s.derivedSourceScopeRef
      && payload.externalCandidateCount === s.externalCandidateCount
      && payload.externalCandidateVersionSetDigest
        === s.externalCandidateVersionSetDigest
      && canonicalJcs(payload.externalCandidateVersionIris)
        === canonicalJcs(externalVersionIris)
      && payload.externalSnapshotManifestRef
        === s.externalSnapshotManifest.ref
      && payload.externalSnapshotManifestDigest
        === s.externalSnapshotManifest.digest
      && payload.externalSourceScopeRef === s.externalSourceScopeRef
      && payload.findingVersionIri === s.versionIri
      && payload.inputContextRef === s.inputContext.ref
      && payload.inputContextDigest === s.inputContext.digest
      && payload.instrumentLogicalIri === comparisonInstrumentIri
      && payload.listingVersionIri === comparisonListingVersionIri
      && payload.pitRequestRef === s.pitRequest.ref
      && payload.pitRequestDigest === s.pitRequest.digest
      && payload.queryDefinitionRef === s.queryDefinition.ref
      && payload.queryDefinitionDigest === s.queryDefinition.digest
      && payload.queryToolLockRef === s.queryToolLock.ref
      && payload.queryToolLockDigest === s.queryToolLock.digest
      && payload.reconciliationContextRef === s.reconciliationContext.ref
      && payload.reconciliationContextDigest
        === s.reconciliationContext.digest,
    'RECONCILIATION_PROBE',
    'reconciliation closure probe',
  );
  requireCondition(
    instantNanoseconds(context.completedAt)
      < instantNanoseconds(probe.payload.completedAt)
      && instantNanoseconds(probe.payload.completedAt)
        < instantNanoseconds(s.temporal.availableFrom),
    'RECONCILIATION_PROBE',
    'closure probe did not complete after comparison and before finding publication',
  );

  const recomputed = !closedExternal
    ? 'missingExternal'
    : !closedDerived
      ? 'missingDerived'
      : valuesEqual
        ? 'matched'
        : comparisonFamily === 'quantity'
          ? 'quantityMismatch'
          : 'basisMismatch';
  requireCondition(
    s.kind === recomputed,
    'RECONCILIATION_KIND',
    'stored reconciliation kind differs from exact branch recomputation',
  );
  reconciliationEvidenceIngress(s, runtimeEvidence);
}

const VALIDATORS = Object.freeze({
  OrderIntentContract: validateOrderIntent,
  ExternalOrderContract: validateExternalOrder,
  OrderEventStreamContract: validateEventStream,
  ExternalOrderStatusVocabularyContract: validateStatusVocabulary,
  OrderTransitionProfileContract: validateTransitionProfile,
  LiquidityRoleMappingContract: validateLiquidityMapping,
  OrderLifecycleEventContract: validateLifecycleEvent,
  OrderIntentLineageContract: validateOrderIntentLineage,
  ExecutionContract: validateExecution,
  ExecutionLiquidityDeterminationCompletenessContract: validateExecutionLiquidityCompleteness,
  FeeContract: validateFee,
  ExternalOrderStatusMappingContract: validateStatusMapping,
  LiquidityRoleDeterminationContract: validateLiquidityDetermination,
  OrderEventIntegrityFindingContract: validateIntegrityFinding,
  PortfolioContract: validatePortfolio,
  PortfolioObservationStreamContract: validatePortfolioObservationStream,
  PortfolioAccountMembershipContract: validateMembership,
  PortfolioManagementMandateContract: validateMandate,
  PortfolioAccountMembershipClosureContract: validateMembershipClosure,
  HoldingSnapshotContract: validateHolding,
  PositionSnapshotContract: validatePosition,
  PositionLotContract: validatePositionLot,
  PositionLotOpeningAllocationCompletenessContract: validateOpeningAllocation,
  ValuationCalculationDefinitionContract: validateValuationDefinition,
  CostBasisCalculationDefinitionContract: validateCostBasisDefinition,
  PortfolioValuationContract: validatePortfolioValuation,
  PositionValuationContract: validatePositionValuation,
  FXConversionContract: validateFxConversion,
  PositionLotAllocationContract: validateLotAllocation,
  PositionLotFeeAllocationContract: validateFeeAllocation,
  ExecutionLotAllocationClosureContract: validateExecutionClosure,
  PositionLotStateClosureContract: validateLotState,
  UnrealizedPnLObservationContract: validatePnl,
  ExternalCostBasisObservationContract: validateExternalBasis,
  PortfolioPositionReconciliationFindingContract: validateReconciliation,
});

const CONSTRAINT_BINDINGS = Object.freeze(Object.fromEntries([
  ...Object.keys(VALIDATORS).slice(0, 14).map((name) => [`${ORDERS}${name}`, name]),
  ...Object.keys(VALIDATORS).slice(14).map((name) => [`${PORTFOLIO}${name}`, name]),
]));

function validateConstraint(constraintIri, validatorId, scenario, runtimeEvidence = undefined) {
  const bound = CONSTRAINT_BINDINGS[constraintIri];
  if (!bound || bound !== validatorId || typeof VALIDATORS[bound] !== 'function') {
    const error = new Error('constraint/validator binding is not trusted');
    error.code = 'CUSTOM_UNBOUND';
    throw error;
  }
  VALIDATORS[bound](scenario, runtimeEvidence);
}

function constraintDispatchDescriptor(constraintIri) {
  const evaluatorId = CONSTRAINT_BINDINGS[constraintIri];
  if (!evaluatorId) {
    const error = new Error('constraint is not bound by this runtime');
    error.code = 'CUSTOM_UNBOUND';
    throw error;
  }
  return {
    dispatchDigest: sha256Jcs({ constraintIri, evaluatorId }),
    evaluatorId,
  };
}

module.exports = {
  CONSTRAINT_BINDINGS,
  CustomConstraintViolation,
  VALIDATORS,
  artifactRefSortKey,
  buildVerifierOwnedPitIngress,
  canonicalJcs,
  controlRecordIri,
  constraintDispatchDescriptor,
  instantNanoseconds,
  iriSetDigest,
  mappingClosureDigest,
  rdfGraphDigest,
  sha256DomainJcs,
  sha256Jcs,
  sourceSchemaClosureDigest,
  sourceSnapshotRootDigest,
  taggedJcsDigest,
  validateConstraint,
};
