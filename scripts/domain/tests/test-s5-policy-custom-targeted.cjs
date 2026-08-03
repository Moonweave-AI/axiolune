'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const {
  RDFC_CAPABILITY_CONTRACTS,
  S5ControlChainError,
  assertRdfcCapabilityContractValue,
  assertStoredProducerReplay,
} = require('../lib/s5-control-record-chain.cjs');
const {
  MARKET_GRAPH_IRI,
  SUPPORT_GRAPH_IRI,
  S5CanonicalMaterializationError,
  materializeHistoricalDataset,
} = require('../lib/s5-canonical-materialization.cjs');
const { canonicalJcs } = require('../lib/strict-source-locator.cjs');
const { canonicalizeNQuads } = require('../lib/rdfc-1.0.cjs');
const { sourceFileMap } = require('../replay-release-capability-payload.cjs');

const ROOT = path.join(__dirname, '..', '..', '..');
const SOURCE_REL = 'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source';
const SOURCE = path.join(ROOT, ...SOURCE_REL.split('/'));
const SUPPORT = path.join(SOURCE, 'prior-support', 'dataset.nq');
const CUSTOM_MODULE_RELS = Object.freeze([
  'ontology/domain/finance/foundation/module.yaml',
  'ontology/domain/finance/instruments/module.yaml',
  'ontology/domain/finance/market-data/module.yaml',
  'ontology/domain/finance/market-structure/module.yaml',
  'ontology/domain/finance/portfolio-positions/module.yaml',
]);
const CUSTOM_GENERATING_CONTEXTS = Object.freeze([
  'urn:axiolune:run:slice-a:identity:v1',
  'urn:axiolune:run:slice-a:instrument-input-context:v1',
  'urn:axiolune:run:slice-a:market-data:v1',
  'urn:axiolune:run:slice-a:market-structure-input-context:v1',
  'urn:axiolune:run:slice-a:portfolio-input-context:v1',
  'urn:axiolune:run:slice-a:portfolio-valuation:v1',
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function bytesDigest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function u64be(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function iriSetDigest(values) {
  const sorted = [...new Set(values)].sort((left, right) => Buffer.compare(
    Buffer.from(left, 'utf8'),
    Buffer.from(right, 'utf8'),
  ));
  assert.equal(sorted.length, values.length);
  assert.ok(sorted.length > 0);
  const hash = crypto.createHash('sha256');
  hash.update(Buffer.from('axiolune-iri-set-v1\0', 'utf8'));
  hash.update(u64be(sorted.length));
  for (const iri of sorted) {
    const bytes = Buffer.from(iri, 'utf8');
    hash.update(u64be(bytes.length));
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function baselineRows() {
  return readJson(path.join(
    ROOT,
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source-snapshot-original.json',
  )).rows;
}

function futureRows() {
  return readJson(path.join(
    ROOT,
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source-snapshot-future.json',
  )).rows;
}

function baselinePolicyArtifacts() {
  return {
    precisionBytes: fs.readFileSync(path.join(SOURCE, 'valuation-precision-policy.json')),
    roundingBytes: fs.readFileSync(path.join(SOURCE, 'valuation-rounding-policy.json')),
  };
}

function materializeRows(rows = baselineRows(), policy = baselinePolicyArtifacts()) {
  return materializeHistoricalDataset(
    rows,
    'urn:axiolune:run:slice-a:identity:v1',
    'urn:axiolune:run:slice-a:market-data:v1',
    'urn:axiolune:run:slice-a:portfolio-valuation:v1',
    'urn:axiolune:run:slice-a:batch:v1',
    { valuationPolicyArtifacts: policy },
  );
}

function supportNQuads() {
  return fs.readFileSync(SUPPORT, 'utf8');
}

function sourceArtifactFile(ref) {
  assert.deepEqual(
    { kind: ref?.kind, root: ref?.root },
    { kind: 'path', root: 'sourceTree' },
  );
  return path.join(ROOT, ...ref.path.split('/'));
}

function lockedEvidenceArtifacts() {
  return readJson(path.join(SOURCE, 'support-evidence-closure.json')).entries.map((entry) => ({
    artifactDigest: entry.artifactDigest,
    artifactRef: entry.artifactRef,
    evidenceIri: entry.evidenceIri,
    evidenceKind: entry.evidenceKind,
    file: sourceArtifactFile(entry.artifactRef),
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.evidenceIri),
    Buffer.from(right.evidenceIri),
  ));
}

function runCustomWorker(options = {}) {
  const materialized = options.materialized || materializeRows();
  const artifacts = lockedEvidenceArtifacts();
  if (typeof options.mutateLockedEvidenceArtifacts === 'function') {
    options.mutateLockedEvidenceArtifacts(artifacts);
  }
  return spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/domain/lib/s5-materialized-custom-worker.cjs')],
    {
      cwd: ROOT,
      encoding: 'utf8',
      input: canonicalJcs({
        allowedGeneratingContextIris: [...CUSTOM_GENERATING_CONTEXTS].sort(),
        asOfAvailable: '2024-07-10T00:00:00Z',
        asOfKnowledge: '2024-07-10T00:00:00Z',
        asOfValid: '2024-07-10T00:00:00Z',
        dataNQuads: options.dataNQuads || materialized.nquads,
        lockedEvidenceArtifacts: artifacts,
        moduleSourcePaths: CUSTOM_MODULE_RELS.map((relative) => (
          path.join(ROOT, ...relative.split('/'))
        )),
        referenceTime: '2024-07-10T00:00:02Z',
        schemaVersion: '1.0',
        supportNQuads: options.supportNQuads || supportNQuads(),
        targetGraphIri: MARKET_GRAPH_IRI,
      }),
      shell: false,
      timeout: 60 * 1000,
      windowsHide: true,
    },
  );
}

function assertCustomFailure(result, code) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, new RegExp(code, 'u'));
}

function collectTransformationRefs(value, refs = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectTransformationRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== 'object') return refs;
  if (value.bindingType === 'transformation') {
    assert.equal(typeof value.transformationRef, 'string');
    refs.add(value.transformationRef);
  }
  for (const child of Object.values(value)) collectTransformationRefs(child, refs);
  return refs;
}

test('targeted materializer emits locked Money scale and Quantity precision/rounding', () => {
  const materialized = materializeRows();
  assert.match(materialized.nquads, /hasAmount> "425\.00"\^\^/u);
  assert.match(materialized.nquads, /hasScale> "2"\^\^/u);
  assert.match(materialized.nquads, /hasPrecision> "0"\^\^/u);
  assert.match(materialized.nquads, /hasRounding> "half-even" </u);
});

test('targeted materializer fails closed when policy bytes are missing or substituted', () => {
  assert.throws(
    () => materializeHistoricalDataset(
      baselineRows(),
      'urn:axiolune:run:slice-a:identity:v1',
      'urn:axiolune:run:slice-a:market-data:v1',
      'urn:axiolune:run:slice-a:portfolio-valuation:v1',
      'urn:axiolune:run:slice-a:batch:v1',
    ),
    (error) => error instanceof S5CanonicalMaterializationError
      && error.code === 'S5_CANONICAL_VALUATION_POLICY',
  );
  const policy = baselinePolicyArtifacts();
  policy.roundingBytes = Buffer.from(
    policy.roundingBytes.toString('utf8').replace('half-even', 'half-up'),
    'utf8',
  );
  assert.throws(
    () => materializeRows(baselineRows(), policy),
    (error) => error instanceof S5CanonicalMaterializationError
      && error.code === 'S5_CANONICAL_VALUATION_POLICY',
  );
});

test('targeted materializer rejects a recomputed unsupported rounding stage', () => {
  const rows = structuredClone(baselineRows());
  const policy = JSON.parse(baselinePolicyArtifacts().roundingBytes.toString('utf8'));
  policy.stage = 'intermediateProduct';
  const roundingBytes = Buffer.from(canonicalJcs(policy), 'utf8');
  rows[0].valuation_rounding_policy_digest = bytesDigest(roundingBytes);
  assert.throws(
    () => materializeRows(rows, {
      precisionBytes: baselinePolicyArtifacts().precisionBytes,
      roundingBytes,
    }),
    (error) => error instanceof S5CanonicalMaterializationError
      && error.code === 'S5_CANONICAL_VALUATION_POLICY',
  );
});

test('targeted materializer implements final-stage half-even exactly', () => {
  const rows = structuredClone(baselineRows());
  rows[0].holding_quantity = '1';
  rows[0].holding_quantity_precision = 0;
  rows[0].price = '42.545';
  rows[0].price_scale = 3;
  assert.match(materializeRows(rows).nquads, /hasAmount> "42\.54"\^\^/u);
});

test('targeted stored derived values replay from locked source/policy bytes', () => {
  const runIris = [
    'urn:axiolune:run:slice-a:identity:v1',
    'urn:axiolune:run:slice-a:market-data:v1',
    'urn:axiolune:run:slice-a:portfolio-valuation:v1',
    'urn:axiolune:run:slice-a:batch:v1',
  ];
  const policies = baselinePolicyArtifacts();
  const selectedFutureRows = futureRows().filter((row) => (
    Date.parse(row.valid_from) <= Date.parse('2024-07-10T00:00:00Z')
      && Date.parse(row.knowledge_from) <= Date.parse('2024-07-10T00:00:00Z')
      && Date.parse(row.available_from) <= Date.parse('2024-07-10T00:00:00Z')
  ));
  assert.equal(selectedFutureRows.length, 1);
  const original = materializeHistoricalDataset(
    baselineRows(),
    ...runIris,
    { valuationPolicyArtifacts: policies },
  );
  const replay = materializeHistoricalDataset(
    baselineRows(),
    ...runIris,
    { reverse: true, valuationPolicyArtifacts: policies },
  );
  const future = materializeHistoricalDataset(
    selectedFutureRows,
    ...runIris,
    { reverse: true, valuationPolicyArtifacts: policies },
  );
  const request = {
    batchRunIri: runIris[3],
    futureBytes: Buffer.from(future.nquads, 'utf8'),
    futureRows: selectedFutureRows,
    identityRunIri: runIris[0],
    marketRunIri: runIris[1],
    originalBytes: Buffer.from(original.nquads, 'utf8'),
    originalRows: baselineRows(),
    portfolioRunIri: runIris[2],
    replayBytes: Buffer.from(replay.nquads, 'utf8'),
    valuationPolicyArtifacts: policies,
  };
  assert.equal(assertStoredProducerReplay(request), true);
  const substitute = (bytes) => Buffer.from(bytes.toString('utf8').replace(
    '"425.00"^^<http://www.w3.org/2001/XMLSchema#decimal>',
    '"426.00"^^<http://www.w3.org/2001/XMLSchema#decimal>',
  ), 'utf8');
  assert.throws(
    () => assertStoredProducerReplay({
      ...request,
      futureBytes: substitute(request.futureBytes),
      originalBytes: substitute(request.originalBytes),
      replayBytes: substitute(request.replayBytes),
    }),
    (error) => error instanceof S5ControlChainError
      && error.code === 'S5_CHAIN_PRODUCER_REPLAY',
  );
});

test('targeted Custom runtime discovers and passes all applicable constraints', () => {
  const result = runCustomWorker();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout);
  assert.deepEqual(evidence.counts, {
    discovered: 17,
    executed: 17,
    failed: 0,
    passed: 17,
  });
});

test('targeted Custom runtime verifies quotation count and section-5.8 set digest', () => {
  const row = baselineRows()[0];
  const support = supportNQuads();
  assert.match(
    support,
    /valuationQuotationContractCount> "1"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#integer>/u,
  );
  assert.ok(support.includes(iriSetDigest([row.quotation_contract_version_iri])));

  const wrongCount = support.replace(
    'valuationQuotationContractCount> "1"^^<http://www.w3.org/2001/XMLSchema#integer>',
    'valuationQuotationContractCount> "2"^^<http://www.w3.org/2001/XMLSchema#integer>',
  );
  assert.notEqual(wrongCount, support);
  assertCustomFailure(
    runCustomWorker({ supportNQuads: wrongCount }),
    'S5_CUSTOM_VALUATION_DEFINITION',
  );

  const expectedDigest = iriSetDigest([row.quotation_contract_version_iri]);
  const wrongDigest = support.replace(expectedDigest, `sha256:${'0'.repeat(64)}`);
  assert.notEqual(wrongDigest, support);
  assertCustomFailure(
    runCustomWorker({ supportNQuads: wrongDigest }),
    'S5_CUSTOM_VALUATION_DEFINITION',
  );
});

test('targeted Custom runtime rejects quotation member substitution after digest recomputation', () => {
  const materialized = materializeRows();
  const row = baselineRows()[0];
  const original = supportNQuads();
  const clone = `${row.quotation_contract_version_iri}-substitute`;
  const clonedStatements = original.split('\n').filter((line) => (
    line.startsWith(`<${row.quotation_contract_version_iri}> `)
  )).map((line) => (
    line.replace(`<${row.quotation_contract_version_iri}>`, `<${clone}>`)
  )).join('\n');
  const relation = original.split('\n').find((line) => (
    line.startsWith(`<${row.valuation_definition_version_iri}> `)
      && line.includes('/valuationDefinitionQuotationContract>')
  ));
  assert.ok(relation);
  let changed = original.replace(
    `${relation}\n`,
    `${relation.replace(`<${row.quotation_contract_version_iri}>`, `<${clone}>`)}\n`,
  );
  changed = changed.replace(
    iriSetDigest([row.quotation_contract_version_iri]),
    iriSetDigest([clone]),
  );
  changed = `${changed}${clonedStatements}\n`;
  assertCustomFailure(
    runCustomWorker({ materialized, supportNQuads: changed }),
    'S5_CUSTOM_POSITION_VALUATION',
  );
});

test('targeted Custom runtime rejects tampered locked evidence bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-s5-targeted-policy-'));
  try {
    const file = path.join(directory, 'rounding-policy.json');
    const policy = JSON.parse(baselinePolicyArtifacts().roundingBytes.toString('utf8'));
    policy.mode = 'half-up';
    fs.writeFileSync(file, canonicalJcs(policy));
    const result = runCustomWorker({
      mutateLockedEvidenceArtifacts: (entries) => {
        entries.find((entry) => entry.evidenceKind === 'roundingPolicy').file = file;
      },
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /digest differs from exact bytes/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('targeted Custom runtime rejects coherent producer-implementation substitution', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-s5-targeted-producer-'));
  try {
    const file = path.join(directory, 'toolchain.lock.json');
    const lock = readJson(path.join(
      ROOT,
      'scripts/domain/control-record-profile/s5-v1/toolchain.lock.json',
    ));
    const producer = lock.tools.find((entry) => entry.toolId === 's5-canonical-materializer');
    const verifier = lock.tools.find((entry) => entry.toolId === 's5-control-record-chain');
    producer.artifactRef = verifier.artifactRef;
    producer.artifactDigest = verifier.artifactDigest;
    producer.capabilities[0].capabilityRef = verifier.capabilities[0].capabilityRef;
    producer.capabilities[0].capabilityDigest = verifier.capabilities[0].capabilityDigest;
    producer.capabilities[0].entrypointRef = verifier.capabilities[0].entrypointRef;
    producer.capabilities[0].entrypointDigest = verifier.capabilities[0].entrypointDigest;
    const bytes = Buffer.from(canonicalJcs(lock), 'utf8');
    fs.writeFileSync(file, bytes);
    const digest = bytesDigest(bytes);
    const oldDigest = baselineRows()[0].valuation_tool_lock_digest;
    const materialized = materializeRows();
    const originalSupport = supportNQuads();
    const changedSupport = originalSupport.replaceAll(oldDigest, digest);
    assert.notEqual(changedSupport, originalSupport);
    const result = runCustomWorker({
      materialized,
      supportNQuads: changedSupport,
      mutateLockedEvidenceArtifacts: (entries) => {
        const entry = entries.find((candidate) => candidate.evidenceKind === 'toolLock');
        entry.artifactDigest = digest;
        entry.file = file;
      },
    });
    assertCustomFailure(result, 'S5_CUSTOM_PRODUCER_CAPABILITY');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('targeted Custom runtime rejects coherent producer-output-contract substitution', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-s5-targeted-output-'));
  try {
    const file = path.join(directory, 'output-contract.json');
    const substituted = readJson(path.join(
      ROOT,
      'scripts/domain/control-record-profile/s5-v1/capability-output-contract.json',
    ));
    const bytes = Buffer.from(canonicalJcs(substituted), 'utf8');
    fs.writeFileSync(file, bytes);
    const digest = bytesDigest(bytes);
    const oldDigest = baselineRows()[0].valuation_output_contract_digest;
    const materialized = materializeRows();
    const originalSupport = supportNQuads();
    const changedSupport = originalSupport.replaceAll(oldDigest, digest);
    assert.notEqual(changedSupport, originalSupport);
    const result = runCustomWorker({
      materialized,
      supportNQuads: changedSupport,
      mutateLockedEvidenceArtifacts: (entries) => {
        const entry = entries.find((candidate) => candidate.evidenceKind === 'outputContract');
        entry.artifactDigest = digest;
        entry.file = file;
      },
    });
    assertCustomFailure(result, 'S5_CUSTOM_PRODUCER_CAPABILITY');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('targeted Custom runtime rejects amount/scale disagreement', () => {
  const materialized = materializeRows();
  const marketValue = `${materialized.identities.positionValuation.versionIri}/value/market-value`;
  const line = materialized.nquads.split('\n').find((candidate) => (
    candidate.startsWith(`<${marketValue}> `) && candidate.includes('/hasScale>')
  ));
  assert.ok(line);
  const dataNQuads = materialized.nquads.replace(`${line}\n`, `${line.replace('"2"^^', '"3"^^')}\n`);
  assertCustomFailure(runCustomWorker({ dataNQuads, materialized }), 'S5_CUSTOM_MONEY_SCALE');
});

test('targeted Custom runtime rejects a non-prior completed input context', () => {
  const materialized = materializeRows();
  const closure = readJson(path.join(SOURCE, 'support-evidence-closure.json'));
  const prior = closure.entries.find((entry) => (
    entry.evidenceIri === 'urn:axiolune:evidence:slice-a:prior-input-context:v1'
  ));
  const future = closure.entries.find((entry) => (
    entry.evidenceIri === 'urn:axiolune:evidence:slice-a:future-prior-input-context:v1'
  ));
  let dataNQuads = materialized.nquads.replace(prior.evidenceIri, future.evidenceIri);
  dataNQuads = dataNQuads.replace(prior.artifactDigest, future.artifactDigest);
  assertCustomFailure(runCustomWorker({ dataNQuads, materialized }), 'S5_CUSTOM_INPUT_CONTEXT');
});

test('targeted Custom runtime rejects cross-dataset fail-to-pass augmentation in both directions', () => {
  const materialized = materializeRows();
  const mainPredicate = 'https://axiolune.ai/ontology/finance/market-data/priceKind';
  const mainLine = materialized.nquads.split('\n').find((candidate) => (
    candidate.startsWith(`<${materialized.identities.observation.versionIri}> `)
      && candidate.includes(`<${mainPredicate}>`)
  ));
  assert.ok(mainLine);
  const missingMain = materialized.nquads.replace(`${mainLine}\n`, '');
  const injectedSupport = mainLine.replace(`<${MARKET_GRAPH_IRI}> .`, `<${SUPPORT_GRAPH_IRI}> .`);
  assertCustomFailure(runCustomWorker({
    dataNQuads: missingMain,
    materialized,
    supportNQuads: `${supportNQuads()}${injectedSupport}\n`,
  }), 'S5_CUSTOM_SUPPORT_AUGMENTATION');

  const row = baselineRows()[0];
  const supportPredicate = 'https://axiolune.ai/ontology/finance/instruments/contractMultiplier';
  const support = supportNQuads();
  const supportLine = support.split('\n').find((candidate) => (
    candidate.startsWith(`<${row.quotation_contract_version_iri}> `)
      && candidate.includes(`<${supportPredicate}>`)
  ));
  assert.ok(supportLine);
  const missingSupport = support.replace(`${supportLine}\n`, '');
  const injectedMain = supportLine.replace(`<${SUPPORT_GRAPH_IRI}> .`, `<${MARKET_GRAPH_IRI}> .`);
  assertCustomFailure(runCustomWorker({
    dataNQuads: `${materialized.nquads}${injectedMain}\n`,
    materialized,
    supportNQuads: missingSupport,
  }), 'S5_CUSTOM_SUPPORT_AUGMENTATION');
});

test('targeted Custom runtime rejects duplicate reverse and definition logical keys', () => {
  const materialized = materializeRows();
  const position = materialized.identities.positionValuation.versionIri;
  const duplicatePosition = materialized.nquads.split('\n').filter((line) => (
    line.startsWith(`<${position}> `)
  )).map((line) => line.replace(`<${position}>`, `<${position}-duplicate>`)).join('\n');
  assertCustomFailure(runCustomWorker({
    dataNQuads: `${materialized.nquads}${duplicatePosition}\n`,
    materialized,
  }), 'S5_CUSTOM_POSITION_VALUATION');

  const row = baselineRows()[0];
  const support = supportNQuads();
  const duplicateDefinition = support.split('\n').filter((line) => (
    line.startsWith(`<${row.valuation_definition_version_iri}> `)
  )).map((line) => (
    line.replace(
      `<${row.valuation_definition_version_iri}>`,
      `<${row.valuation_definition_version_iri}-duplicate>`,
    )
  )).join('\n');
  assertCustomFailure(runCustomWorker({
    materialized,
    supportNQuads: `${support}${duplicateDefinition}\n`,
  }), 'S5_CUSTOM_VALUATION_DEFINITION');
});

test('targeted mapping transformation closures equal recursively discovered mappings', () => {
  const names = [
    'holding-snapshot', 'isin-value', 'market-data-stream',
    'portfolio-valuation', 'position-valuation', 'price-observation',
  ];
  for (const name of names) {
    const mapping = readJson(
      ['market-data-stream', 'price-observation'].includes(name)
        ? path.join(
          ROOT,
          'mappings',
          'finance',
          'v0.3.0',
          'market-data',
          `${name}.semantic-mapping.json`,
        )
        : path.join(SOURCE, `${name}-mapping.json`),
    );
    const closure = readJson(path.join(SOURCE, `${name}-transformation-closure.json`));
    const actual = [...collectTransformationRefs(mapping)].sort();
    const locked = closure.transformations.map((entry) => entry.transformationRef).sort();
    assert.deepEqual(locked, actual, name);
    assert.equal(closure.mappingRef, mapping.iri, name);
    for (const transformation of closure.transformations) {
      assert.equal(transformation.capabilityId, 's5-canonical-materialization');
      assert.equal(
        transformation.capabilityRef.path,
        'scripts/domain/lib/s5-canonical-materialization.cjs',
      );
      assert.deepEqual(transformation.implementationRef, transformation.capabilityRef);
      assert.equal(transformation.implementationDigest, transformation.capabilityDigest);
      assert.equal(
        transformation.outputContractRef.path,
        'scripts/domain/control-record-profile/s5-v1/materialization-capability-output-contract.json',
      );
      assert.equal(
        transformation.runtimeRef.path,
        'scripts/domain/control-record-profile/s5-v1/materialization-runtime-closure.json',
      );
    }
  }
});

test('targeted tool lock separates the canonical producer from the downstream chain verifier', () => {
  const lock = readJson(path.join(
    ROOT,
    'scripts/domain/control-record-profile/s5-v1/toolchain.lock.json',
  ));
  assert.deepEqual(lock.tools.map((entry) => entry.toolId), [
    'rdf-canonize',
    's5-canonical-materializer',
    's5-control-record-chain',
  ]);
  const producer = lock.tools[1];
  const capability = producer.capabilities[0];
  const rdfc = lock.tools[0];
  const rdfcCapability = rdfc.capabilities[0];
  const verifier = lock.tools[2];
  const verifierCapability = verifier.capabilities[0];
  assert.equal(rdfcCapability.capabilityId, 'rdfc-1.0');
  assert.equal(rdfcCapability.inputContractRef.path,
    'scripts/domain/control-record-profile/s5-v1/rdfc-capability-input-contract.json');
  assert.equal(rdfcCapability.outputContractRef.path,
    'scripts/domain/control-record-profile/s5-v1/rdfc-capability-output-contract.json');
  assert.equal(rdfcCapability.discoveryContractRef.path,
    'scripts/domain/control-record-profile/s5-v1/rdfc-discovery-contract.json');
  assert.equal(rdfcCapability.evidenceSchemaRef.path,
    'scripts/domain/control-record-profile/s5-v1/rdfc-evidence-schema.json');
  assert.equal(rdfcCapability.testVectorsRef.path, 'scripts/domain/tests/test-rdfc-1.0.cjs');
  assert.notDeepEqual(rdfcCapability.inputContractRef, verifierCapability.inputContractRef);
  assert.notDeepEqual(rdfcCapability.outputContractRef, verifierCapability.outputContractRef);
  for (const [name, expected] of Object.entries(RDFC_CAPABILITY_CONTRACTS)) {
    assert.deepEqual(readJson(path.join(
      ROOT,
      'scripts/domain/control-record-profile/s5-v1',
      name,
    )), expected, name);
  }
  const canonicalized = canonicalizeNQuads(
    '<urn:subject> <urn:predicate> "value" <urn:graph> .\n',
  );
  assert.deepEqual(
    Object.keys(canonicalized).sort(),
    RDFC_CAPABILITY_CONTRACTS['rdfc-capability-output-contract.json'].required,
  );
  assert.equal(canonicalized.algorithm, 'RDFC-1.0');
  assert.equal(canonicalized.graphIris[0], 'urn:graph');
  const substitutedContract = JSON.parse(JSON.stringify(
    RDFC_CAPABILITY_CONTRACTS['rdfc-capability-output-contract.json'],
  ));
  substitutedContract.algorithm = 'URDNA2015';
  assert.throws(
    () => assertRdfcCapabilityContractValue(
      'rdfc-capability-output-contract.json',
      substitutedContract,
    ),
    (error) => error instanceof S5ControlChainError && error.code === 'S5_CHAIN_TOOL_LOCK',
  );
  assert.equal(producer.artifactRef.path, 'scripts/domain/lib/s5-canonical-materialization.cjs');
  assert.equal(capability.capabilityId, 's5-canonical-materialization');
  assert.deepEqual(capability.capabilityRef, producer.artifactRef);
  assert.equal(capability.capabilityDigest, producer.artifactDigest);
  assert.deepEqual(capability.entrypointRef, producer.artifactRef);
  assert.equal(capability.entrypointDigest, producer.artifactDigest);
  assert.equal(
    capability.outputContractRef.path,
    'scripts/domain/control-record-profile/s5-v1/materialization-capability-output-contract.json',
  );
  assert.equal(
    producer.runtimeRef.path,
    'scripts/domain/control-record-profile/s5-v1/materialization-runtime-closure.json',
  );
  assert.notEqual(capability.capabilityDigest, verifierCapability.capabilityDigest);
});

test('targeted release source closure loads exact S5 semantic implementation bytes', () => {
  const files = sourceFileMap(ROOT);
  const chain = 'scripts/domain/lib/s5-control-record-chain.cjs';
  const materializer = 'scripts/domain/lib/s5-canonical-materialization.cjs';
  const runner = 'scripts/domain/run-s5-control-record-chain.cjs';
  assert.deepEqual(
    [chain, materializer, runner].filter((relative) => files.has(relative)),
    [chain, materializer, runner],
  );
  assert.deepEqual(files.get(chain), fs.readFileSync(path.join(ROOT, ...chain.split('/'))));
  assert.deepEqual(
    files.get(materializer),
    fs.readFileSync(path.join(ROOT, ...materializer.split('/'))),
  );
  assert.deepEqual(files.get(runner), fs.readFileSync(path.join(ROOT, ...runner.split('/'))));
  assert.equal(files.has('scripts/domain/run-slice-a.cjs'), false);
});
