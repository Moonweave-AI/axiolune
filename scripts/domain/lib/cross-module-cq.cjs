'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rdfCanonize = require('rdf-canonize');

const {
  CqContractError: FoundationCqContractError,
  executeCq: executeFoundationInstrumentCq,
} = require('./foundation-market-instrument-cq.cjs');
const {
  RdfcError,
  computeDatasetDigest,
  computeNamedGraphDigest,
  packageVersion: rdfCanonizePackageVersion,
} = require('./rdfc-1.0.cjs');
const {
  canonicalJcs,
} = require('./strict-source-locator.cjs');

const CQ_FUNCTION_VERSION = 'axiolune-m2-cq-cross-module/v1';

class CrossModuleCqError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CrossModuleCqError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CrossModuleCqError(code, message);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, label, code) {
  if (!isPlainObject(value)) fail(code, `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `${label} keys must equal [${expected.join(', ')}]`);
  }
}

function oneById(collection, id, label, code) {
  if (!Array.isArray(collection)) fail(code, `${label} collection is missing`);
  const rows = collection.filter((entry) => entry && entry.id === id);
  if (rows.length !== 1) fail(code, `${label} ${id} resolved ${rows.length} times`);
  return rows[0];
}

function validateBindingShape(binding, label) {
  exactKeys(
    binding,
    [
      'assignmentVersionIri',
      'schemeVersionIri',
      'valueVersionIri',
      'authorizationVersionIri',
    ],
    label,
    'CQ_S1_BINDING',
  );
  for (const [field, value] of Object.entries(binding)) {
    if (typeof value !== 'string' || value.length === 0) {
      fail('CQ_S1_BINDING', `${label}.${field} must be a non-empty exact version IRI`);
    }
  }
}

function callFoundation(cqId, graph, query) {
  try {
    return executeFoundationInstrumentCq(cqId, graph, query);
  } catch (error) {
    if (error instanceof FoundationCqContractError) {
      fail(error.code, error.message);
    }
    throw error;
  }
}

function executeS1(graph, query) {
  exactKeys(
    query,
    ['pivot', 'isinBindings', 'internalBinding'],
    'CQ-S1 query',
    'CQ_S1_QUERY',
  );
  if (!Array.isArray(query.isinBindings) || query.isinBindings.length === 0) {
    fail('CQ_S1_BINDING', 'CQ-S1 requires at least one exact ISIN assignment binding');
  }
  query.isinBindings.forEach((binding, index) => (
    validateBindingShape(binding, `CQ-S1 isinBindings[${index}]`)
  ));
  validateBindingShape(query.internalBinding, 'CQ-S1 internalBinding');

  for (const [index, binding] of query.isinBindings.entries()) {
    const scheme = oneById(
      graph.identifierSchemeVersions,
      binding.schemeVersionIri,
      'identifier scheme version',
      'CQ_S1_ISIN_SCHEME',
    );
    if (scheme.identifierSchemeKind !== 'iso6166Isin'
        || scheme.identifierUniquenessScope !== 'global') {
      fail(
        'CQ_S1_ISIN_SCHEME',
        `isinBindings[${index}] must use the global ISIN scheme`,
      );
    }
  }
  const internalScheme = oneById(
    graph.identifierSchemeVersions,
    query.internalBinding.schemeVersionIri,
    'identifier scheme version',
    'CQ_S1_INTERNAL_SCHEME',
  );
  if (internalScheme.identifierSchemeKind !== 'internalInstrument'
      || internalScheme.identifierUniquenessScope !== 'authority') {
    fail(
      'CQ_S1_INTERNAL_SCHEME',
      'internalBinding must use an authority-scoped internalInstrument scheme',
    );
  }

  if (query.isinBindings.length > 1) {
    const isinResolution = callFoundation('CQ-F1', graph, {
      pivot: query.pivot,
      bindings: query.isinBindings,
    });
    if (isinResolution.length !== 1) {
      fail('CQ_S1_RESOLUTION', 'ISIN assignment resolution must return one explicit result');
    }
    const [row] = isinResolution;
    if (row.resolution === 'IdentifierAssignmentConflict') {
      return [{
        resolution: 'IdentifierAssignmentConflict',
        conflictVersionIri: row.conflictVersionIri,
        subjectLogicalIris: row.subjectLogicalIris,
        assignmentVersionIris: row.assignmentVersionIris,
        issuerResolution: 'blockedByIdentifierConflict',
      }];
    }
    if (row.resolution !== 'sameSubject') return [];
  }

  const isinBinding = query.isinBindings[0];
  const identifierResolution = callFoundation('CQ-F1', graph, {
    pivot: query.pivot,
    bindings: [isinBinding, query.internalBinding],
  });
  if (identifierResolution.length !== 1) {
    fail('CQ_S1_RESOLUTION', 'ISIN/internal resolution must return one explicit result');
  }
  const [identifierRow] = identifierResolution;
  if (identifierRow.resolution === 'IdentifierAssignmentConflict') {
    return [{
      resolution: 'IdentifierAssignmentConflict',
      conflictVersionIri: identifierRow.conflictVersionIri,
      subjectLogicalIris: identifierRow.subjectLogicalIris,
      assignmentVersionIris: identifierRow.assignmentVersionIris,
      issuerResolution: 'blockedByIdentifierConflict',
    }];
  }
  if (identifierRow.resolution !== 'sameSubject') return [];

  const issuanceRows = callFoundation('CQ-I1', graph, {
    pivot: query.pivot,
    isinValueVersionIri: isinBinding.valueVersionIri,
  });
  if (issuanceRows.length === 0) return [];
  if (issuanceRows.length !== 1) {
    fail('CQ_S1_ISSUANCE', `ISIN issuance lookup returned ${issuanceRows.length} rows`);
  }
  const [issuance] = issuanceRows;
  if (issuance.securityLogicalIri !== identifierRow.subjectLogicalIri
      || issuance.assignmentVersionIri !== isinBinding.assignmentVersionIri
      || !identifierRow.subjectVersionIris.includes(issuance.securityVersionIri)) {
    fail(
      'CQ_S1_JOIN',
      'identifier resolution and issuance chain do not join to the exact same Security version',
    );
  }
  return [{
    resolution: 'sameInstrumentAndIssuer',
    securityLogicalIri: issuance.securityLogicalIri,
    securityVersionIri: issuance.securityVersionIri,
    isinValueVersionIri: issuance.isinValueVersionIri,
    isin: issuance.isin,
    identifierAssignmentVersionIris: identifierRow.assignmentVersionIris,
    issuanceVersionIri: issuance.issuanceVersionIri,
    issuerVersionIri: issuance.issuerVersionIri,
    issuerLogicalIri: issuance.issuerLogicalIri,
  }];
}

function u64be(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('CQ_S5_LENGTH', 'length/count must be a non-negative safe integer');
  }
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
}

function rawDigestBytes(digest, label) {
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    fail('CQ_S5_DIGEST', `${label} must be one lowercase SHA-256 Digest`);
  }
  return Buffer.from(digest.slice(7), 'hex');
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function resolveArtifact(rootDirectory, artifactRef, label) {
  if (typeof rootDirectory !== 'string' || !path.isAbsolute(rootDirectory)) {
    fail('CQ_S5_ROOT', 'rootDirectory must be an absolute repository root');
  }
  if (typeof artifactRef !== 'string'
      || artifactRef.length === 0
      || path.isAbsolute(artifactRef)
      || artifactRef.includes('\\')
      || artifactRef !== artifactRef.normalize('NFC')) {
    fail('CQ_S5_ARTIFACT_REF', `${label} must be a normalized POSIX repository-relative path`);
  }
  const segments = artifactRef.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('CQ_S5_ARTIFACT_REF', `${label} contains an unsafe path segment`);
  }
  const root = fs.realpathSync(rootDirectory);
  const candidate = path.resolve(root, ...segments);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    fail('CQ_S5_ARTIFACT_REF', `${label} does not resolve to a regular file`);
  }
  if (fs.lstatSync(candidate).isSymbolicLink()) {
    fail('CQ_S5_ARTIFACT_REF', `${label} must not resolve through a symbolic-link file`);
  }
  const real = fs.realpathSync(candidate);
  const relative = path.relative(root, real);
  if (relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
    fail('CQ_S5_ARTIFACT_REF', `${label} escapes the repository root`);
  }
  return real;
}

function artifactBytes(rootDirectory, binding, label) {
  exactKeys(binding, ['artifactRef', 'artifactDigest'], label, 'CQ_S5_ARTIFACT');
  const file = resolveArtifact(rootDirectory, binding.artifactRef, `${label}.artifactRef`);
  const bytes = fs.readFileSync(file);
  const digest = sha256(bytes);
  if (digest !== binding.artifactDigest) {
    fail(
      'CQ_S5_ARTIFACT_DIGEST',
      `${label} digest drift: expected ${digest}, found ${binding.artifactDigest}`,
    );
  }
  return { bytes, file, digest };
}

function canonicalJsonArtifact(rootDirectory, binding, label) {
  const artifact = artifactBytes(rootDirectory, binding, label);
  const text = artifact.bytes.toString('utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail('CQ_S5_JSON', `${label} is not strict JSON: ${error.message}`);
  }
  let canonical;
  try {
    canonical = `${canonicalJcs(value)}\n`;
  } catch (error) {
    fail('CQ_S5_JSON', `${label} is outside the locked JCS profile: ${error.message}`);
  }
  if (text !== canonical) {
    fail('CQ_S5_JSON', `${label} bytes are not exact RFC 8785 JCS plus one LF`);
  }
  return { ...artifact, value };
}

function sourceSnapshotRootDigest(snapshot) {
  const datasetBytes = Buffer.from(snapshot.dataset, 'utf8');
  const snapshotRefBytes = Buffer.from(snapshot.snapshotRef, 'utf8');
  return sha256(Buffer.concat([
    Buffer.from('axiolune-source-snapshot-root-v1\0', 'utf8'),
    u64be(1),
    u64be(datasetBytes.length),
    datasetBytes,
    u64be(snapshotRefBytes.length),
    snapshotRefBytes,
    rawDigestBytes(snapshot.artifactDigest, 'sourceSnapshot.artifactDigest'),
    rawDigestBytes(snapshot.schemaDigest, 'sourceSnapshot.schemaDigest'),
  ]));
}

function mappingClosureDigest(mappings) {
  const ordered = [...mappings].sort((left, right) => (
    utf8Compare(left.mappingRef, right.mappingRef)
  ));
  const parts = [
    Buffer.from('axiolune-mapping-closure-v1\0', 'utf8'),
    u64be(ordered.length),
  ];
  for (const entry of ordered) {
    const mappingRefBytes = Buffer.from(entry.mappingRef, 'utf8');
    const transformationRefBytes = Buffer.from(entry.transformationClosureRef, 'utf8');
    parts.push(
      u64be(mappingRefBytes.length),
      mappingRefBytes,
      rawDigestBytes(entry.mappingSourceDigest, `${entry.mappingRef}.mappingSourceDigest`),
      u64be(transformationRefBytes.length),
      transformationRefBytes,
      rawDigestBytes(
        entry.transformationClosureDigest,
        `${entry.mappingRef}.transformationClosureDigest`,
      ),
    );
  }
  return sha256(Buffer.concat(parts));
}

function instantNanoseconds(value, label) {
  const match = typeof value === 'string'
    ? value.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u,
    )
    : null;
  if (!match) fail('CQ_S5_INSTANT', `${label} must be a canonical UTC dateTimeStamp`);
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const milliseconds = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (!Number.isFinite(milliseconds)
      || new Date(milliseconds).toISOString().slice(0, 19)
        !== `${year}-${month}-${day}T${hour}:${minute}:${second}`) {
    fail('CQ_S5_INSTANT', `${label} is not a real UTC instant`);
  }
  return BigInt(milliseconds) * 1000000n
    + BigInt((fraction + '000000000').slice(0, 9));
}

function validateToolLock(rootDirectory, binding) {
  const { value } = canonicalJsonArtifact(rootDirectory, binding, 'fixedInputs.toolLock');
  exactKeys(value, ['schemaVersion', 'tools'], 'toolchain lock', 'CQ_S5_TOOL_LOCK');
  if (value.schemaVersion !== '1.0' || !Array.isArray(value.tools)) {
    fail('CQ_S5_TOOL_LOCK', 'toolchain lock must have schemaVersion 1.0 and a tools array');
  }
  const ids = value.tools.map((tool) => tool.toolId);
  if (ids.join(',') !== 'cross-module-cq,rdf-canonize') {
    fail('CQ_S5_TOOL_LOCK', 'toolchain lock must contain exact sorted cross-module-cq/rdf-canonize tools');
  }
  const crossModule = value.tools[0];
  exactKeys(
    crossModule,
    ['toolId', 'version', 'implementation'],
    'toolchain cross-module-cq',
    'CQ_S5_TOOL_LOCK',
  );
  if (crossModule.version !== CQ_FUNCTION_VERSION) {
    fail('CQ_S5_TOOL_LOCK', 'cross-module executor version is not locked to the running contract');
  }
  artifactBytes(rootDirectory, crossModule.implementation, 'toolchain cross-module implementation');

  const canonicalizer = value.tools[1];
  exactKeys(
    canonicalizer,
    ['toolId', 'version', 'algorithm', 'adapter', 'worker', 'dependencyLock'],
    'toolchain rdf-canonize',
    'CQ_S5_TOOL_LOCK',
  );
  if (canonicalizer.version !== rdfCanonizePackageVersion()
      || canonicalizer.version !== '5.0.0'
      || canonicalizer.algorithm !== 'RDFC-1.0') {
    fail('CQ_S5_TOOL_LOCK', 'RDFC tool version/algorithm does not equal the executing capability');
  }
  artifactBytes(rootDirectory, canonicalizer.adapter, 'toolchain RDFC adapter');
  artifactBytes(rootDirectory, canonicalizer.worker, 'toolchain RDFC worker');
  artifactBytes(rootDirectory, canonicalizer.dependencyLock, 'toolchain dependency lock');
}

function validateProvenance(
  nquads,
  provenanceGraphIri,
  memberGraphIris,
  batchRunIri,
  sourceSnapshotIri,
) {
  const dataset = rdfCanonize.NQuads.parse(nquads);
  const provenance = dataset.filter((statement) => (
    statement.graph.termType === 'NamedNode'
      && statement.graph.value === provenanceGraphIri
  ));
  if (provenance.length !== memberGraphIris.length + 2) {
    fail(
      'CQ_S5_PROVENANCE',
      `provenance graph must contain exactly ${memberGraphIris.length + 2} quads`,
    );
  }
  const generatedPredicate = 'http://www.w3.org/ns/prov#wasGeneratedBy';
  for (const memberGraphIri of memberGraphIris) {
    const matches = provenance.filter((statement) => (
      statement.subject.termType === 'NamedNode'
      && statement.subject.value === memberGraphIri
      && statement.predicate.value === generatedPredicate
      && statement.object.termType === 'NamedNode'
      && statement.object.value === batchRunIri
    ));
    if (matches.length !== 1) {
      fail(
        'CQ_S5_PROVENANCE',
        `${memberGraphIri} must have exactly one prov:wasGeneratedBy batch edge`,
      );
    }
  }
  const used = provenance.filter((statement) => (
    statement.subject.termType === 'NamedNode'
    && statement.subject.value === batchRunIri
    && statement.predicate.value === 'http://www.w3.org/ns/prov#used'
    && statement.object.termType === 'NamedNode'
    && statement.object.value === sourceSnapshotIri
  ));
  if (used.length !== 1) {
    fail('CQ_S5_PROVENANCE', 'batch provenance must use the exact fixed source snapshot');
  }
  for (const statement of provenance) {
    if (/outputDatasetDigest|recordDigest|ledgerDigest/u.test(statement.predicate.value)) {
      fail('CQ_S5_PROVENANCE', 'hashed provenance graph contains a forbidden self-derived digest');
    }
  }
}

function executeS5(contract, options = {}) {
  exactKeys(
    contract,
    ['schemaVersion', 'functionVersion', 'fixedInputs', 'expected'],
    'CQ-S5 contract',
    'CQ_S5_CONTRACT',
  );
  if (contract.schemaVersion !== '1.0'
      || contract.functionVersion !== CQ_FUNCTION_VERSION) {
    fail('CQ_S5_CONTRACT', 'CQ-S5 schema/function version drift');
  }
  const rootDirectory = options.rootDirectory;
  const fixed = contract.fixedInputs;
  exactKeys(
    fixed,
    [
      'batchDefinition',
      'sourceSnapshot',
      'mappings',
      'toolLock',
      'pivots',
      'referenceTime',
      'assertionTime',
      'batchRunIri',
      'sourceSnapshotIri',
      'originalDataset',
      'replayDataset',
    ],
    'CQ-S5 fixedInputs',
    'CQ_S5_CONTRACT',
  );
  const expected = contract.expected;
  exactKeys(
    expected,
    [
      'canonicalization',
      'targetDataset',
      'sourceSnapshotRootDigest',
      'mappingClosureDigest',
      'memberGraphs',
      'outputDatasetDigest',
    ],
    'CQ-S5 expected',
    'CQ_S5_CONTRACT',
  );
  if (expected.canonicalization !== 'RDFC-1.0') {
    fail('CQ_S5_CANONICALIZATION', 'CQ-S5 requires exact RDFC-1.0 canonicalization');
  }

  const batchDefinition = canonicalJsonArtifact(
    rootDirectory,
    fixed.batchDefinition,
    'fixedInputs.batchDefinition',
  ).value;
  exactKeys(
    batchDefinition,
    ['consistencyRequirement', 'definition', 'iri', 'label', 'plans', 'targetDataset'],
    'MaterializationBatchDefinition',
    'CQ_S5_BATCH_DEFINITION',
  );
  if (batchDefinition.consistencyRequirement !== 'Transactional'
      || batchDefinition.targetDataset !== expected.targetDataset
      || batchDefinition.targetDataset.endsWith('/')
      || !Array.isArray(batchDefinition.plans)
      || batchDefinition.plans.length < 2
      || [...batchDefinition.plans].sort(utf8Compare).join('\0')
        !== batchDefinition.plans.join('\0')) {
    fail('CQ_S5_BATCH_DEFINITION', 'batch definition is not an ordered atomic multi-plan definition');
  }

  exactKeys(
    fixed.sourceSnapshot,
    [
      'dataset',
      'snapshotRef',
      'artifactDigest',
      'schemaRef',
      'schemaDigest',
      'snapshotTime',
    ],
    'fixedInputs.sourceSnapshot',
    'CQ_S5_SOURCE_SNAPSHOT',
  );
  const snapshotArtifact = canonicalJsonArtifact(rootDirectory, {
    artifactRef: fixed.sourceSnapshot.snapshotRef,
    artifactDigest: fixed.sourceSnapshot.artifactDigest,
  }, 'source snapshot');
  const schemaArtifact = canonicalJsonArtifact(rootDirectory, {
    artifactRef: fixed.sourceSnapshot.schemaRef,
    artifactDigest: fixed.sourceSnapshot.schemaDigest,
  }, 'source schema');
  if (snapshotArtifact.value.dataset !== fixed.sourceSnapshot.dataset
      || schemaArtifact.value.dataset !== fixed.sourceSnapshot.dataset
      || snapshotArtifact.value.snapshotTime !== fixed.sourceSnapshot.snapshotTime) {
    fail('CQ_S5_SOURCE_SNAPSHOT', 'source snapshot/schema embedded identity or time drift');
  }
  const computedSnapshotRoot = sourceSnapshotRootDigest(fixed.sourceSnapshot);
  if (computedSnapshotRoot !== expected.sourceSnapshotRootDigest) {
    fail('CQ_S5_SOURCE_ROOT', 'sourceSnapshotRootDigest does not recompute');
  }

  if (!Array.isArray(fixed.mappings) || fixed.mappings.length !== batchDefinition.plans.length) {
    fail('CQ_S5_MAPPING', 'mapping closure must contain one mapping for every batch plan');
  }
  const mappingRefs = new Set();
  const mappingGraphIris = [];
  for (const [index, mapping] of fixed.mappings.entries()) {
    exactKeys(
      mapping,
      [
        'planRef',
        'mappingRef',
        'mappingArtifactRef',
        'mappingSourceDigest',
        'transformationClosureRef',
        'transformationClosureDigest',
        'targetGraph',
      ],
      `fixedInputs.mappings[${index}]`,
      'CQ_S5_MAPPING',
    );
    if (mappingRefs.has(mapping.mappingRef)) fail('CQ_S5_MAPPING', 'duplicate mappingRef');
    mappingRefs.add(mapping.mappingRef);
    if (mapping.planRef !== batchDefinition.plans[index]) {
      fail('CQ_S5_MAPPING', 'mapping plan order does not equal the batch definition');
    }
    const mappingArtifact = canonicalJsonArtifact(rootDirectory, {
      artifactRef: mapping.mappingArtifactRef,
      artifactDigest: mapping.mappingSourceDigest,
    }, `mapping ${mapping.mappingRef}`);
    artifactBytes(rootDirectory, {
      artifactRef: mapping.transformationClosureRef,
      artifactDigest: mapping.transformationClosureDigest,
    }, `transformation closure ${mapping.mappingRef}`);
    if (mappingArtifact.value.iri !== mapping.mappingRef
        || mappingArtifact.value.targetGraph !== mapping.targetGraph
        || mappingArtifact.value.transformationClosureRef !== mapping.transformationClosureRef
        || mappingArtifact.value.transformationClosureDigest !== mapping.transformationClosureDigest) {
      fail('CQ_S5_MAPPING', `${mapping.mappingRef} source bytes do not equal their closure binding`);
    }
    mappingGraphIris.push(mapping.targetGraph);
  }
  const computedMappingRoot = mappingClosureDigest(fixed.mappings);
  if (computedMappingRoot !== expected.mappingClosureDigest) {
    fail('CQ_S5_MAPPING_ROOT', 'mappingClosureDigest does not recompute');
  }
  validateToolLock(rootDirectory, fixed.toolLock);

  exactKeys(
    fixed.pivots,
    ['asOfValid', 'asOfKnowledge', 'asOfAvailable'],
    'fixedInputs.pivots',
    'CQ_S5_PIVOT',
  );
  const reference = instantNanoseconds(fixed.referenceTime, 'referenceTime');
  instantNanoseconds(fixed.assertionTime, 'assertionTime');
  instantNanoseconds(fixed.pivots.asOfValid, 'asOfValid');
  if (instantNanoseconds(fixed.pivots.asOfKnowledge, 'asOfKnowledge') > reference
      || instantNanoseconds(fixed.pivots.asOfAvailable, 'asOfAvailable') > reference) {
    fail('CQ_S5_FUTURE_PIVOT', 'knowledge/availability pivot exceeds fixed referenceTime');
  }

  const provenanceGraphIri = `${expected.targetDataset}/provenance`;
  const expectedGraphIris = [...mappingGraphIris, provenanceGraphIri].sort(utf8Compare);
  if (!Array.isArray(expected.memberGraphs)
      || expected.memberGraphs.length !== mappingGraphIris.length) {
    fail('CQ_S5_GRAPH_SET', 'expected memberGraphs must equal the mapping graph count');
  }
  const declaredGraphIris = expected.memberGraphs.map((entry) => entry.graphIri);
  if ([...declaredGraphIris].sort(utf8Compare).join('\0')
      !== [...mappingGraphIris].sort(utf8Compare).join('\0')) {
    fail('CQ_S5_GRAPH_SET', 'expected memberGraphs do not equal mapping target graphs');
  }

  const originalArtifact = artifactBytes(
    rootDirectory,
    fixed.originalDataset,
    'fixedInputs.originalDataset',
  );
  const replayArtifact = artifactBytes(
    rootDirectory,
    fixed.replayDataset,
    'fixedInputs.replayDataset',
  );
  if (originalArtifact.digest === replayArtifact.digest
      || originalArtifact.bytes.equals(replayArtifact.bytes)) {
    fail(
      'CQ_S5_REPLAY_CHALLENGE',
      'replay fixture must independently reorder statements and relabel blank nodes',
    );
  }
  const originalNQuads = originalArtifact.bytes.toString('utf8');
  const replayNQuads = replayArtifact.bytes.toString('utf8');
  let original;
  let replay;
  try {
    original = computeDatasetDigest(originalNQuads, expectedGraphIris);
    replay = computeDatasetDigest(replayNQuads, expectedGraphIris);
  } catch (error) {
    if (error instanceof RdfcError) fail(error.code, error.message);
    throw error;
  }
  if (original.digest !== expected.outputDatasetDigest) {
    fail('CQ_S5_DATASET_DIGEST', 'original outputDatasetDigest does not recompute');
  }
  if (replay.digest !== original.digest
      || replay.canonicalNQuads !== original.canonicalNQuads) {
    fail('CQ_S5_REPLAY_MISMATCH', 'fixed-input replay is not one isomorphic canonical dataset');
  }
  for (const member of expected.memberGraphs) {
    exactKeys(
      member,
      ['planRef', 'graphIri', 'outputGraphDigest'],
      `expected member ${member.graphIri}`,
      'CQ_S5_GRAPH_DIGEST',
    );
    const mapping = fixed.mappings.find((entry) => entry.targetGraph === member.graphIri);
    if (!mapping || mapping.planRef !== member.planRef) {
      fail('CQ_S5_GRAPH_DIGEST', `${member.graphIri} has the wrong plan binding`);
    }
    const originalGraph = computeNamedGraphDigest(originalNQuads, member.graphIri);
    const replayGraph = computeNamedGraphDigest(replayNQuads, member.graphIri);
    if (originalGraph.digest !== member.outputGraphDigest
        || replayGraph.digest !== member.outputGraphDigest
        || originalGraph.canonicalNQuads !== replayGraph.canonicalNQuads) {
      fail('CQ_S5_GRAPH_DIGEST', `${member.graphIri} graph replay/digest mismatch`);
    }
  }
  validateProvenance(
    originalNQuads,
    provenanceGraphIri,
    mappingGraphIris,
    fixed.batchRunIri,
    fixed.sourceSnapshotIri,
  );
  validateProvenance(
    replayNQuads,
    provenanceGraphIri,
    mappingGraphIris,
    fixed.batchRunIri,
    fixed.sourceSnapshotIri,
  );

  return [{
    resolution: 'identicalCanonicalDataset',
    canonicalization: 'RDFC-1.0',
    targetDataset: expected.targetDataset,
    batchDefinitionIri: batchDefinition.iri,
    batchRunIri: fixed.batchRunIri,
    sourceSnapshotRootDigest: computedSnapshotRoot,
    mappingClosureDigest: computedMappingRoot,
    outputDatasetDigest: original.digest,
    memberGraphDigests: expected.memberGraphs.map((entry) => ({
      graphIri: entry.graphIri,
      outputGraphDigest: entry.outputGraphDigest,
    })),
    quadCount: original.quadCount,
  }];
}

function executeCq(cqId, graph, query) {
  if (cqId === 'CQ-S1') return executeS1(graph, query);
  if (cqId === 'CQ-S5') return executeS5(query, graph);
  fail('CQ_UNSUPPORTED', `unsupported cross-module CQ ${String(cqId)}`);
}

module.exports = {
  CQ_FUNCTION_VERSION,
  CrossModuleCqError,
  executeCq,
  executeS1,
  executeS5,
  mappingClosureDigest,
  sourceSnapshotRootDigest,
};
