'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after, before, test } = require('node:test');
const yaml = require('js-yaml');

const {
  INPUT_FIXTURE_REL,
  PROFILE_REFERENCE_FIELDS,
  S5ControlChainError,
  createS5ControlRecordChain,
  resolvedInputDigest,
  taggedJcsDigest,
  verifyS5ControlRecordChain,
} = require('../lib/s5-control-record-chain.cjs');
const {
  inspectCommit,
  repositoryObjectFormat,
} = require('../lib/m2-git-replay.cjs');
const { computeNamedGraphDigest } = require('../lib/rdfc-1.0.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
} = require('../lib/strict-source-locator.cjs');
const {
  FACT_VERSION,
  MARKET_GRAPH_IRI,
  PORTFOLIO_GRAPH_IRI,
  REVISION,
  SOURCE,
  SUPPORT_GRAPH_IRI,
  S5CanonicalMaterializationError,
  VERSION_OF,
  evaluatePitSelection,
  materializeHistoricalDataset,
  validateCanonicalFactVersions,
} = require('../lib/s5-canonical-materialization.cjs');
const {
  validateMaterializedCustom,
} = require('../lib/s5-materialized-custom-validation.cjs');

const ROOT = path.join(__dirname, '..', '..', '..');
const PRIOR_SUPPORT_REL = 'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/prior-support';
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
const inputRef = { kind: 'path', root: 'sourceTree', path: INPUT_FIXTURE_REL };
let baselineDirectory;
let baselineSummary;
let stableDirectory;
let stableRepository;
let stableSelector;
let stableSummary;

function roots(directory) {
  return { sourceTree: ROOT, buildEvidence: directory };
}

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cloneBaseline() {
  const directory = temporaryDirectory('axiolune-s5-chain-clone-');
  fs.cpSync(baselineDirectory, directory, { recursive: true });
  return directory;
}

function cloneStable() {
  const directory = temporaryDirectory('axiolune-s5-stable-clone-');
  fs.cpSync(stableDirectory, directory, { recursive: true });
  return directory;
}

function cloneSourceClosure() {
  const directory = temporaryDirectory('axiolune-s5-source-closure-');
  const manifest = readJson(path.join(baselineDirectory, 'source-tree-manifest.json'));
  for (const entry of manifest.files) {
    const source = path.join(ROOT, ...entry.path.split('/'));
    const target = path.join(directory, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return directory;
}

function git(repository, args) {
  const result = spawnSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJcs(file, value) {
  fs.writeFileSync(file, canonicalJcs(value));
}

function updateStableSelector(directory, mutate) {
  const selectorFile = path.join(directory, 'source-tree-selector.json');
  const selector = readJson(selectorFile);
  mutate(selector);
  writeJcs(selectorFile, selector);
  const buildInputsFile = path.join(directory, 'build-inputs.json');
  const buildInputs = readJson(buildInputsFile);
  buildInputs.sourceTreeSelectorDigest = taggedJcsDigest(
    'axiolune-source-tree-selector-v1\0',
    selector,
  );
  writeJcs(buildInputsFile, buildInputs);
}

function readRecord(directory, slotId) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'records', `${slotId}.json`), 'utf8'));
}

function writeRecord(directory, slotId, record, options = {}) {
  const bytes = canonicalJcs(record) + (options.trailingLf === true ? '\n' : '');
  fs.writeFileSync(path.join(directory, 'records', `${slotId}.json`), bytes);
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => (
    error instanceof S5ControlChainError && error.code === code
  ));
}

function expectCanonicalCode(callback, code) {
  assert.throws(callback, (error) => (
    error instanceof S5CanonicalMaterializationError && error.code === code
  ));
}

function baselineMaterialization() {
  const snapshot = readJson(path.join(
    ROOT,
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source-snapshot-original.json',
  ));
  return materializeHistoricalDataset(
    snapshot.rows,
    'urn:axiolune:run:slice-a:identity:v1',
    'urn:axiolune:run:slice-a:market-data:v1',
    'urn:axiolune:run:slice-a:portfolio-valuation:v1',
    'urn:axiolune:run:slice-a:batch:v1',
    { valuationPolicyArtifacts: baselinePolicyArtifacts() },
  );
}

function baselinePolicyArtifacts() {
  const source = path.join(
    ROOT,
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source',
  );
  return {
    precisionBytes: fs.readFileSync(path.join(source, 'valuation-precision-policy.json')),
    roundingBytes: fs.readFileSync(path.join(source, 'valuation-rounding-policy.json')),
  };
}

function baselineRows() {
  return readJson(path.join(
    ROOT,
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source-snapshot-original.json',
  )).rows;
}

function materializeRows(rows, valuationPolicyArtifacts = baselinePolicyArtifacts()) {
  return materializeHistoricalDataset(
    rows,
    'urn:axiolune:run:slice-a:identity:v1',
    'urn:axiolune:run:slice-a:market-data:v1',
    'urn:axiolune:run:slice-a:portfolio-valuation:v1',
    'urn:axiolune:run:slice-a:batch:v1',
    { valuationPolicyArtifacts },
  );
}

function baselineSupportNquads() {
  return fs.readFileSync(path.join(
    ROOT,
    PRIOR_SUPPORT_REL,
    'dataset.nq',
  ), 'utf8');
}

function sourceArtifactFile(sourceTree, ref) {
  assert.deepEqual(
    { kind: ref?.kind, root: ref?.root },
    { kind: 'path', root: 'sourceTree' },
  );
  return path.join(sourceTree, ...ref.path.split('/'));
}

function fileDigest(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function bytesDigest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function iriSetDigest(values) {
  const sorted = [...new Set(values)].sort((left, right) => Buffer.compare(
    Buffer.from(left, 'utf8'),
    Buffer.from(right, 'utf8'),
  ));
  assert.equal(sorted.length, values.length);
  assert.ok(sorted.length > 0);
  const hash = crypto.createHash('sha256');
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(sorted.length));
  hash.update(Buffer.from('axiolune-iri-set-v1\0', 'utf8'));
  hash.update(count);
  for (const iri of sorted) {
    const bytes = Buffer.from(iri, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function priorSupportManifestFile(sourceTree) {
  return path.join(sourceTree, ...PRIOR_SUPPORT_REL.split('/'), 'chain-manifest.json');
}

function rebuildPriorSupportLedger(sourceTree, manifest) {
  const ledgerFile = sourceArtifactFile(sourceTree, manifest.ledger.artifactRef);
  const ledger = readJson(ledgerFile);
  ledger.entries = [
    ...manifest.identityContracts,
    ...manifest.mappings,
    ...manifest.plans,
    ...manifest.runs,
    ...manifest.reports,
    manifest.batch,
    manifest.batchRun,
    {
      artifactDigest: manifest.dataset.artifactDigest,
      artifactRef: manifest.dataset.artifactRef,
      datasetRef: manifest.dataset.datasetRef,
    },
  ].sort((left, right) => Buffer.compare(
    Buffer.from(canonicalJcs(left.artifactRef), 'utf8'),
    Buffer.from(canonicalJcs(right.artifactRef), 'utf8'),
  ));
  writeJcs(ledgerFile, ledger);
  manifest.ledger.artifactDigest = fileDigest(ledgerFile);
}

function rewritePriorSupportDatasetAndCascade(sourceTree, mutate) {
  const manifestFile = priorSupportManifestFile(sourceTree);
  const manifest = readJson(manifestFile);
  const datasetFile = sourceArtifactFile(sourceTree, manifest.dataset.artifactRef);
  const original = fs.readFileSync(datasetFile, 'utf8');
  const changed = mutate(original);
  assert.equal(typeof changed, 'string');
  assert.notEqual(changed, original);
  fs.writeFileSync(datasetFile, changed);
  manifest.dataset.artifactDigest = fileDigest(datasetFile);
  manifest.dataset.graphDigest = computeNamedGraphDigest(
    changed,
    manifest.dataset.graphIri,
  ).digest;

  const runByIri = new Map();
  for (const binding of manifest.runs) {
    const file = sourceArtifactFile(sourceTree, binding.artifactRef);
    const run = readJson(file);
    run.outputDatasetArtifactDigest = manifest.dataset.artifactDigest;
    run.outputGraphDigest = manifest.dataset.graphDigest;
    writeJcs(file, run);
    binding.artifactDigest = fileDigest(file);
    runByIri.set(binding.runRef, binding);
  }
  for (const binding of manifest.reports) {
    const file = sourceArtifactFile(sourceTree, binding.artifactRef);
    const report = readJson(file);
    report.runArtifactDigest = runByIri.get(binding.runRef).artifactDigest;
    report.subjectArtifactDigest = manifest.dataset.artifactDigest;
    report.subjectGraphDigest = manifest.dataset.graphDigest;
    writeJcs(file, report);
    binding.artifactDigest = fileDigest(file);
  }
  const batchRunFile = sourceArtifactFile(sourceTree, manifest.batchRun.artifactRef);
  const batchRun = readJson(batchRunFile);
  batchRun.memberRuns = manifest.runs;
  batchRun.outputDatasetArtifactDigest = manifest.dataset.artifactDigest;
  batchRun.outputGraphDigest = manifest.dataset.graphDigest;
  writeJcs(batchRunFile, batchRun);
  manifest.batchRun.artifactDigest = fileDigest(batchRunFile);
  rebuildPriorSupportLedger(sourceTree, manifest);
  writeJcs(manifestFile, manifest);
}

function rewritePriorSupportBatchAndCascade(sourceTree, mutate) {
  const manifestFile = priorSupportManifestFile(sourceTree);
  const manifest = readJson(manifestFile);
  const batchFile = sourceArtifactFile(sourceTree, manifest.batch.artifactRef);
  const batch = readJson(batchFile);
  mutate(batch);
  writeJcs(batchFile, batch);
  manifest.batch.artifactDigest = fileDigest(batchFile);
  manifest.dependencyEdges = batch.dependencyEdges;
  const batchRunFile = sourceArtifactFile(sourceTree, manifest.batchRun.artifactRef);
  const batchRun = readJson(batchRunFile);
  batchRun.batchSourceDigest = manifest.batch.artifactDigest;
  writeJcs(batchRunFile, batchRun);
  manifest.batchRun.artifactDigest = fileDigest(batchRunFile);
  rebuildPriorSupportLedger(sourceTree, manifest);
  writeJcs(manifestFile, manifest);
}

function expectSourceClosureFailure(prefix, mutate, code) {
  const sourceTree = cloneSourceClosure();
  const buildEvidence = temporaryDirectory(prefix);
  try {
    mutate(sourceTree);
    expectCode(
      () => createS5ControlRecordChain(inputRef, { sourceTree, buildEvidence }),
      code,
    );
  } finally {
    fs.rmSync(sourceTree, { recursive: true, force: true });
    fs.rmSync(buildEvidence, { recursive: true, force: true });
  }
}

function runCustomWorker(options = {}) {
  const materialized = options.materialized || baselineMaterialization();
  const evidenceClosure = readJson(path.join(
    ROOT,
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/support-evidence-closure.json',
  ));
  const lockedEvidenceArtifacts = evidenceClosure.entries.map((entry) => ({
    artifactDigest: entry.artifactDigest,
    evidenceIri: entry.evidenceIri,
    evidenceKind: entry.evidenceKind,
    file: sourceArtifactFile(ROOT, entry.artifactRef),
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.evidenceIri),
    Buffer.from(right.evidenceIri),
  ));
  if (typeof options.mutateLockedEvidenceArtifacts === 'function') {
    options.mutateLockedEvidenceArtifacts(lockedEvidenceArtifacts);
  }
  const request = {
    allowedGeneratingContextIris: [...CUSTOM_GENERATING_CONTEXTS].sort(),
    asOfAvailable: '2024-07-10T00:00:00Z',
    asOfKnowledge: '2024-07-10T00:00:00Z',
    asOfValid: '2024-07-10T00:00:00Z',
    dataNQuads: options.dataNquads || materialized.nquads,
    lockedEvidenceArtifacts,
    moduleSourcePaths: options.moduleSourcePaths || CUSTOM_MODULE_RELS.map((relative) => (
      path.join(ROOT, ...relative.split('/'))
    )),
    referenceTime: '2024-07-10T00:00:02Z',
    schemaVersion: '1.0',
    supportNQuads: options.supportNquads || baselineSupportNquads(),
    targetGraphIri: options.targetGraphIri || MARKET_GRAPH_IRI,
  };
  return spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts/domain/lib/s5-materialized-custom-worker.cjs')],
    {
      cwd: ROOT,
      encoding: 'utf8',
      input: canonicalJcs(request),
      shell: false,
      windowsHide: true,
    },
  );
}

function baselineLockedEvidence() {
  const closure = readJson(path.join(
    ROOT,
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/support-evidence-closure.json',
  ));
  return new Map(closure.entries.map((entry) => {
    const file = sourceArtifactFile(ROOT, entry.artifactRef);
    const bytes = fs.readFileSync(file);
    assert.equal(
      bytesDigest(bytes),
      entry.artifactDigest,
      `${entry.evidenceIri} bytes differ from SupportEvidenceClosure`,
    );
    const value = [
      'executableRuntime',
      'executableTransform',
      'valuationFormulaImplementation',
    ]
      .includes(entry.evidenceKind)
      ? null
      : JSON.parse(bytes.toString('utf8'));
    return [entry.evidenceIri, { ...entry, bytes, value }];
  }));
}

function buildPortfolioObservationRevisionClosure(streamVersionIri, suffix) {
  const artifacts = new Map();
  const originalClosure = readJson(path.join(
    ROOT,
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/portfolio-observation-closure.json',
  ));
  const revisionRef = (artifactRef) => ({
    ...artifactRef,
    path: artifactRef.path.replace(/\.json$/u, `-${suffix}.json`),
  });
  const put = (artifactRef, value) => {
    const bytes = Buffer.from(canonicalJcs(value), 'utf8');
    artifacts.set(canonicalJcs(artifactRef), bytes);
    return { artifactDigest: bytesDigest(bytes), artifactRef };
  };
  const readRef = (artifactRef) => readJson(sourceArtifactFile(ROOT, artifactRef));

  const snapshotRequest = readRef(originalClosure.request.artifactRef);
  snapshotRequest.requestIri = `${snapshotRequest.requestIri}:${suffix}`;
  snapshotRequest.streamVersionIri = streamVersionIri;
  const snapshotBinding = put(revisionRef(originalClosure.request.artifactRef), snapshotRequest);
  const closure = structuredClone(originalClosure);
  closure.request = snapshotBinding;

  for (const [index, page] of originalClosure.pages.entries()) {
    const request = readRef(page.requestRef);
    request.pageRequestIri = `${request.pageRequestIri}:${suffix}`;
    request.snapshotRequestDigest = snapshotBinding.artifactDigest;
    request.snapshotRequestIri = snapshotRequest.requestIri;
    request.streamVersionIri = streamVersionIri;
    const requestBinding = put(revisionRef(page.requestRef), request);

    const response = readRef(page.responseRef);
    response.pageRequestDigest = requestBinding.artifactDigest;
    response.pageRequestIri = request.pageRequestIri;
    response.snapshotRequestDigest = snapshotBinding.artifactDigest;
    response.snapshotRequestIri = snapshotRequest.requestIri;
    response.streamVersionIri = streamVersionIri;
    const responseBinding = put(revisionRef(page.responseRef), response);

    const locatorManifest = readRef(page.rowLocatorManifestRef);
    locatorManifest.responseDigest = responseBinding.artifactDigest;
    locatorManifest.responseRef = responseBinding.artifactRef;
    for (const [rowIndex, row] of locatorManifest.rows.entries()) {
      const sourceLocator = {
        ...row.sourceLocator,
        path: responseBinding.artifactRef.path,
      };
      delete sourceLocator.selectionDigest;
      sourceLocator.selectionDigest = computeSelectionDigest(
        sourceLocator,
        Buffer.from(canonicalJcs(response.records[rowIndex]), 'utf8'),
      );
      row.sourceLocator = sourceLocator;
    }
    const locatorBinding = put(revisionRef(page.rowLocatorManifestRef), locatorManifest);
    closure.pages[index] = {
      ...closure.pages[index],
      requestDigest: requestBinding.artifactDigest,
      requestRef: requestBinding.artifactRef,
      responseDigest: responseBinding.artifactDigest,
      responseRef: responseBinding.artifactRef,
      rowLocatorManifestDigest: locatorBinding.artifactDigest,
      rowLocatorManifestRef: locatorBinding.artifactRef,
    };
  }
  const closureRef = revisionRef({
    kind: 'path',
    path: 'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/portfolio-observation-closure.json',
    root: 'sourceTree',
  });
  const closureBinding = put(closureRef, closure);
  return {
    artifacts,
    closure,
    closureBinding,
  };
}

function portfolioCustomDocument(constraintNames) {
  const document = yaml.load(fs.readFileSync(
    path.join(ROOT, 'ontology/domain/finance/portfolio-positions/module.yaml'),
    'utf8',
  ));
  const selected = new Set(constraintNames);
  document.domain.constraints = Object.fromEntries(Object.entries(
    document.domain.constraints,
  ).filter(([name]) => selected.has(name)));
  document.domain.constraintBindings = document.domain.constraintBindings.filter(
    (binding) => Object.values(document.domain.constraints)
      .some((constraint) => constraint.iri === binding.constraintRef),
  );
  return document;
}

function validatePortfolioCustom(options = {}) {
  const lockedEvidence = options.lockedEvidence || baselineLockedEvidence();
  const lockedArtifactsByRef = new Map();
  for (const evidence of lockedEvidence.values()) {
    const key = canonicalJcs(evidence.artifactRef);
    const existing = lockedArtifactsByRef.get(key);
    if (existing) assert.ok(existing.equals(evidence.bytes));
    lockedArtifactsByRef.set(key, evidence.bytes);
  }
  for (const [key, bytes] of options.additionalLockedArtifacts || []) {
    const existing = lockedArtifactsByRef.get(key);
    if (existing) assert.ok(existing.equals(bytes));
    lockedArtifactsByRef.set(key, bytes);
  }
  return validateMaterializedCustom({
    allowedGeneratingContextIris: [...CUSTOM_GENERATING_CONTEXTS].sort(),
    asOfAvailable: '2024-07-10T00:00:00Z',
    asOfKnowledge: '2024-07-10T00:00:00Z',
    asOfValid: '2024-07-10T00:00:00Z',
    dataNQuads: options.dataNquads || baselineMaterialization().nquads,
    lockedEvidence,
    moduleDocuments: [portfolioCustomDocument(options.constraintNames)],
    readLockedArtifact: (artifactRef) => {
      const bytes = lockedArtifactsByRef.get(canonicalJcs(artifactRef));
      assert.ok(bytes, `ArtifactRef is absent from SupportEvidenceClosure: ${canonicalJcs(artifactRef)}`);
      return Buffer.from(bytes);
    },
    referenceTime: '2024-07-10T00:00:02Z',
    supportNQuads: options.supportNquads || baselineSupportNquads(),
    targetGraphIri: PORTFOLIO_GRAPH_IRI,
  });
}

function expectedRuns() {
  return new Map([
    ['urn:axiolune:graph:slice-a:identity:v1', 'urn:axiolune:run:slice-a:identity:v1'],
    [MARKET_GRAPH_IRI, 'urn:axiolune:run:slice-a:market-data:v1'],
    [PORTFOLIO_GRAPH_IRI, 'urn:axiolune:run:slice-a:portfolio-valuation:v1'],
  ]);
}

function allFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => (
    allFiles(path.join(target, entry.name))
  ));
}

before(() => {
  baselineDirectory = temporaryDirectory('axiolune-s5-chain-baseline-');
  baselineSummary = createS5ControlRecordChain(inputRef, roots(baselineDirectory));

  stableRepository = temporaryDirectory('axiolune-s5-stable-repository-');
  const closureManifest = readJson(path.join(baselineDirectory, 'source-tree-manifest.json'));
  for (const entry of closureManifest.files) {
    const source = path.join(ROOT, ...entry.path.split('/'));
    const target = path.join(stableRepository, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  fs.writeFileSync(
    path.join(stableRepository, 'release-candidate-marker.txt'),
    'stable source tree candidate\n',
  );
  git(stableRepository, ['init', '--object-format=sha1']);
  git(stableRepository, ['config', 'user.name', 'S5 Stable Source Test']);
  git(stableRepository, ['config', 'user.email', 's5-stable@example.invalid']);
  git(stableRepository, ['config', 'core.autocrlf', 'false']);
  git(stableRepository, ['add', '--all']);
  git(stableRepository, ['commit', '-m', 'stable source candidate']);
  const gitObjectFormat = repositoryObjectFormat(stableRepository);
  const commit = inspectCommit(
    stableRepository,
    git(stableRepository, ['rev-parse', 'HEAD']),
    gitObjectFormat,
  );
  stableSelector = {
    commitId: commit.commitId,
    gitObjectFormat,
    schemaVersion: '1.0',
    selectorKind: 'gitCommit',
    treeId: commit.treeId,
  };
  stableDirectory = temporaryDirectory('axiolune-s5-stable-evidence-');
  stableSummary = createS5ControlRecordChain(
    inputRef,
    { sourceTree: stableRepository, buildEvidence: stableDirectory },
    { sourceTreeSelector: stableSelector },
  );
});

after(() => {
  if (baselineDirectory) fs.rmSync(baselineDirectory, { recursive: true, force: true });
  if (stableDirectory) fs.rmSync(stableDirectory, { recursive: true, force: true });
  if (stableRepository) fs.rmSync(stableRepository, { recursive: true, force: true });
});

test('generated S5 profile/schema/tool-lock artifacts are byte deterministic', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/domain/generate-s5-control-record-profile.cjs', '--check'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^PASS \d+ S5 control-record profile artifacts are deterministic/u);
});

test('generated record schemas lock the M3 ArtifactRef/URI boundary', () => {
  for (const [recordType, expected] of Object.entries(PROFILE_REFERENCE_FIELDS)) {
    const schema = readJson(path.join(
      ROOT,
      'scripts/domain/control-record-profile/s5-v1',
      `${recordType}.record.schema.json`,
    ));
    assert.deepEqual(schema.referenceFields, expected, recordType);
  }
});

test('S5 source schema closes the portfolio observation-stream logical identity input', () => {
  const fixtureRoot = path.join(
    ROOT,
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain',
  );
  const schema = readJson(path.join(fixtureRoot, 'source/source-schema.json'));
  const field = schema.fields.find((entry) => (
    entry.name === 'portfolio_observation_stream_logical_iri'
  ));
  assert.deepEqual(field, {
    name: 'portfolio_observation_stream_logical_iri',
    required: true,
    type: 'uri',
  });
  for (const relative of [
    'source-snapshot-original.json',
    'source-snapshot-future.json',
    'source/prior-valuation-input-set.json',
    'source/future-prior-valuation-input-set.json',
  ]) {
    const value = readJson(path.join(fixtureRoot, relative));
    const candidate = 'rows' in value
      ? value.rows[0].portfolio_observation_stream_logical_iri
      : value.fields.portfolio_observation_stream_logical_iri;
    assert.equal(
      candidate,
      'https://axiolune.ai/data/finance/portfolio-positions/portfolio-observation-stream/custodian-acme-positions',
    );
  }
});

test('S5 executable closure contains no temporary type/predicate namespace or superseded FactVersion IRI', () => {
  const prohibited = [
    ['urn:axiolune:', 'type:'].join(''),
    ['urn:axiolune:', 'predicate:'].join(''),
    ['https://axiolune.ai/ontology/meta/', 'patterns/FactVersion'].join(''),
  ];
  const targets = [
    path.join(ROOT, 'scripts/domain/lib/ontology-ir-normalizer.cjs'),
    path.join(ROOT, 'scripts/domain/lib/s5-control-record-chain.cjs'),
    path.join(ROOT, 'scripts/domain/lib/s5-canonical-materialization.cjs'),
    path.join(ROOT, 'scripts/domain/generate-s5-control-record-profile.cjs'),
    path.join(ROOT, 'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain'),
  ];
  for (const file of targets.flatMap(allFiles)) {
    const bytes = fs.readFileSync(file, 'utf8');
    for (const iri of prohibited) assert.equal(bytes.includes(iri), false, `${file}: ${iri}`);
  }
});

test('active PIT/reference-time scope contains no placeholder and legacy staging locks are recomputable', () => {
  const pendingDigestPrefix = ['sha256:', 'pending'].join('');
  const activeFiles = [
    'mappings/finance/synthetic/slice-a-source-contract.yaml',
    'mappings/finance/synthetic/slice-a-materialization-run.yaml',
    'tests/m2/pit-fixture-routing.yaml',
    'scripts/domain/run-domain-shacl.cjs',
    'scripts/domain/run-all-cq-probes.cjs',
    'scripts/domain/validate-pit.cjs',
  ].map((relative) => path.join(ROOT, ...relative.split('/')));
  for (const file of activeFiles) {
    assert.equal(fs.readFileSync(file, 'utf8').includes(pendingDigestPrefix), false, file);
  }

  const sourceContract = yaml.load(fs.readFileSync(activeFiles[0], 'utf8'));
  const snapshotDigest = `sha256:${crypto.createHash('sha256').update(canonicalJcs({
    contractId: sourceContract.datasetId,
    rows: sourceContract.rows,
  })).digest('hex')}`;
  assert.equal(sourceContract.snapshotDigest, snapshotDigest);

  const legacyRun = yaml.load(fs.readFileSync(activeFiles[1], 'utf8'));
  const runnerBytes = fs.readFileSync(path.join(ROOT, 'scripts/domain/run-slice-a.cjs'));
  const runnerDigest = `sha256:${crypto.createHash('sha256').update(runnerBytes).digest('hex')}`;
  assert.equal(legacyRun.compilerRef, 'scripts/domain/run-slice-a.cjs');
  assert.equal(legacyRun.validatorRef, 'scripts/domain/run-slice-a.cjs');
  assert.equal(legacyRun.compilerDigest, runnerDigest);
  assert.equal(legacyRun.validatorDigest, runnerDigest);

  const routing = yaml.load(fs.readFileSync(activeFiles[2], 'utf8'));
  assert.equal(
    routing.referenceTimeBinding,
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/control-chain-input.json',
  );
});

test('canonical materializer emits the six-fact instrument-to-position-valuation chain', () => {
  const materialized = baselineMaterialization();
  assert.equal(Object.hasOwn(materialized, 'supportNquads'), false);
  const rows = validateCanonicalFactVersions(materialized.nquads, expectedRuns());
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map((row) => row.subject)).size, 6);
  assert.equal(materialized.identities.stream.versionIri.includes('/version/sha256-'), true);
  assert.equal(materialized.identities.observation.versionIri.includes('/version/sha256-'), true);
  assert.equal(materialized.identities.holding.versionIri.includes('/version/sha256-'), true);
  assert.equal(materialized.identities.valuationHeader.versionIri.includes('/version/sha256-'), true);
  assert.equal(materialized.identities.positionValuation.versionIri.includes('/version/sha256-'), true);
  assert.notEqual(
    materialized.identities.stream.versionIri,
    materialized.identities.observation.versionIri,
  );
  assert.match(
    materialized.nquads,
    new RegExp(`<${materialized.identities.observation.versionIri.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}> <https://axiolune.ai/ontology/finance/market-data/PriceObservation/role/observationStream> <${materialized.identities.stream.versionIri.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}>`, 'u'),
  );
  assert.match(
    materialized.nquads,
    new RegExp(`<${materialized.identities.positionValuation.versionIri.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}> <https://axiolune.ai/ontology/finance/portfolio-positions/PositionValuation/role/valuedHoldingSnapshot> <${materialized.identities.holding.versionIri.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}>`, 'u'),
  );
  assert.match(
    materialized.nquads,
    /<https:\/\/axiolune\.ai\/ontology\/meta\/core\/properties\/hasAmount> "425\.00"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#decimal>/u,
  );
  assert.match(
    materialized.nquads,
    /<https:\/\/axiolune\.ai\/ontology\/meta\/core\/properties\/hasScale> "2"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#integer>/u,
  );
  assert.match(
    materialized.nquads,
    /<https:\/\/axiolune\.ai\/ontology\/meta\/core\/properties\/hasPrecision> "0"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#integer>/u,
  );
  assert.match(
    materialized.nquads,
    /<https:\/\/axiolune\.ai\/ontology\/meta\/core\/properties\/hasRounding> "half-even" /u,
  );
  assert.equal(
    materialized.nquads.includes(
      'https://axiolune.ai/ontology/finance/portfolio-positions/PositionValuation/role/valuationFxConversion',
    ),
    false,
  );
});

test('canonical materializer requires the exact policy artifact bytes', () => {
  expectCanonicalCode(
    () => materializeHistoricalDataset(
      baselineRows(),
      'urn:axiolune:run:slice-a:identity:v1',
      'urn:axiolune:run:slice-a:market-data:v1',
      'urn:axiolune:run:slice-a:portfolio-valuation:v1',
      'urn:axiolune:run:slice-a:batch:v1',
    ),
    'S5_CANONICAL_VALUATION_POLICY',
  );
  const tampered = baselinePolicyArtifacts();
  tampered.roundingBytes = Buffer.from(
    tampered.roundingBytes.toString('utf8').replace('half-even', 'half-up'),
    'utf8',
  );
  expectCanonicalCode(
    () => materializeRows(baselineRows(), tampered),
    'S5_CANONICAL_VALUATION_POLICY',
  );
});

test('canonical materializer rejects unsupported rounding stage even with recomputed row digest', () => {
  const rows = structuredClone(baselineRows());
  const policy = JSON.parse(baselinePolicyArtifacts().roundingBytes.toString('utf8'));
  policy.stage = 'intermediateProduct';
  const roundingBytes = Buffer.from(canonicalJcs(policy), 'utf8');
  rows[0].valuation_rounding_policy_digest = bytesDigest(roundingBytes);
  expectCanonicalCode(
    () => materializeRows(rows, {
      precisionBytes: baselinePolicyArtifacts().precisionBytes,
      roundingBytes,
    }),
    'S5_CANONICAL_VALUATION_POLICY',
  );
});

test('canonical materializer applies the locked final half-even output scale', () => {
  const rows = structuredClone(baselineRows());
  rows[0].holding_quantity = '1';
  rows[0].holding_quantity_precision = 0;
  rows[0].price = '42.545';
  rows[0].price_scale = 3;
  const materialized = materializeRows(rows);
  assert.match(
    materialized.nquads,
    /<https:\/\/axiolune\.ai\/ontology\/meta\/core\/properties\/hasAmount> "42\.54"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#decimal>/u,
  );
});

test('materialized and support facts retain their domain-specific provenance sources', () => {
  const materialized = baselineMaterialization();
  const row = baselineRows()[0];
  const sourceTriple = (subject, source, graph) => (
    `<${subject}> <${SOURCE}> "${source}"^^<http://www.w3.org/2001/XMLSchema#anyURI> <${graph}> .`
  );
  assert.ok(materialized.nquads.includes(sourceTriple(
    materialized.identities.holding.versionIri,
    row.holding_source_artifact_ref,
    PORTFOLIO_GRAPH_IRI,
  )));
  assert.ok(materialized.nquads.includes(sourceTriple(
    materialized.identities.valuationHeader.versionIri,
    row.valuation_formula_ref,
    PORTFOLIO_GRAPH_IRI,
  )));
  assert.ok(materialized.nquads.includes(sourceTriple(
    materialized.identities.positionValuation.versionIri,
    row.valuation_formula_ref,
    PORTFOLIO_GRAPH_IRI,
  )));
  assert.ok(baselineSupportNquads().includes(sourceTriple(
    'https://axiolune.ai/data/finance/portfolio-positions/membership/acme-account/version/locked',
    row.holding_source_artifact_ref,
    SUPPORT_GRAPH_IRI,
  )));
  assert.ok(baselineSupportNquads().includes(sourceTriple(
    row.membership_closure_version_iri,
    row.membership_closure_probe_ref,
    SUPPORT_GRAPH_IRI,
  )));
  assert.ok(baselineSupportNquads().includes(sourceTriple(
    row.valuation_definition_version_iri,
    row.valuation_formula_ref,
    SUPPORT_GRAPH_IRI,
  )));
});

test('HoldingSnapshot mapping provenance is the exact page artifact field and coherent fallback to row.source fails closed', () => {
  const holdingMappingRel =
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/holding-snapshot-mapping.json';
  const holdingMapping = readJson(path.join(ROOT, ...holdingMappingRel.split('/')));
  assert.deepEqual(holdingMapping.provenance, {
    sourceSystem: {
      bindingType: 'directField',
      source: { dataset: 'row', field: 'holding_source_artifact_ref' },
    },
  });

  expectSourceClosureFailure('axiolune-s5-holding-provenance-', (sourceTree) => {
    const inputFile = path.join(sourceTree, ...INPUT_FIXTURE_REL.split('/'));
    const input = readJson(inputFile);
    const descriptor = input.mappings.flatMap((entry) => entry.mappingArtifacts).find(
      (entry) => entry.mappingRef.endsWith('/mapping/holding-snapshot'),
    );
    assert.ok(descriptor);
    descriptor.provenanceSourceField = 'source';
    writeJcs(inputFile, input);

    const mappingFile = path.join(sourceTree, ...holdingMappingRel.split('/'));
    const mapping = readJson(mappingFile);
    mapping.provenance.sourceSystem.source.field = 'source';
    writeJcs(mappingFile, mapping);

    const compilationFile = sourceArtifactFile(sourceTree, input.identityCompilationRef);
    const compilation = readJson(compilationFile);
    const compiledMapping = compilation.mappings.find((entry) => (
      entry.iri === mapping.iri
    ));
    assert.ok(compiledMapping);
    compiledMapping.provenance.sourceSystem.source.field = 'source';
    writeJcs(compilationFile, compilation);

    const manifestFile = sourceArtifactFile(sourceTree, input.identityManifestRef);
    const { compileIdentityContracts } = require('../lib/identity-contract-compiler.cjs');
    writeJcs(manifestFile, compileIdentityContracts(compilation).manifest);
  }, 'S5_CHAIN_MAPPING');
});

test('canonical materializer rejects an unstable instrument logical anchor', () => {
  const rows = structuredClone(baselineRows());
  rows[0].instrument_logical_iri =
    'https://axiolune.ai/data/finance/instruments/security/not-the-version-anchor';
  expectCanonicalCode(
    () => materializeHistoricalDataset(
      rows,
      'urn:axiolune:run:slice-a:identity:v1',
      'urn:axiolune:run:slice-a:market-data:v1',
      'urn:axiolune:run:slice-a:portfolio-valuation:v1',
      'urn:axiolune:run:slice-a:batch:v1',
      { valuationPolicyArtifacts: baselinePolicyArtifacts() },
    ),
    'S5_CANONICAL_INSTRUMENT_IDENTITY',
  );
});

test('canonical materializer rejects a holding unit that differs from the quotation denominator', () => {
  const rows = structuredClone(baselineRows());
  rows[0].holding_quantity_unit = 'urn:unit:contract';
  expectCanonicalCode(
    () => materializeHistoricalDataset(
      rows,
      'urn:axiolune:run:slice-a:identity:v1',
      'urn:axiolune:run:slice-a:market-data:v1',
      'urn:axiolune:run:slice-a:portfolio-valuation:v1',
      'urn:axiolune:run:slice-a:batch:v1',
      { valuationPolicyArtifacts: baselinePolicyArtifacts() },
    ),
    'S5_CANONICAL_QUOTATION_UNIT',
  );
});

test('canonical materializer rejects divergent quotation, price, and reporting currencies', () => {
  const rows = structuredClone(baselineRows());
  rows[0].quotation_currency_iri =
    'https://axiolune.ai/data/finance/foundation/currency/EUR';
  expectCanonicalCode(
    () => materializeHistoricalDataset(
      rows,
      'urn:axiolune:run:slice-a:identity:v1',
      'urn:axiolune:run:slice-a:market-data:v1',
      'urn:axiolune:run:slice-a:portfolio-valuation:v1',
      'urn:axiolune:run:slice-a:batch:v1',
      { valuationPolicyArtifacts: baselinePolicyArtifacts() },
    ),
    'S5_CANONICAL_QUOTATION_CURRENCY',
  );
});

test('canonical validation rejects a fact moved to the wrong target graph', () => {
  const materialized = baselineMaterialization();
  const subject = materialized.identities.positionValuation.versionIri;
  const tampered = materialized.nquads.split('\n').map((line) => (
    line.startsWith(`<${subject}> `)
      ? line.replace(`<${PORTFOLIO_GRAPH_IRI}> .`, `<${MARKET_GRAPH_IRI}> .`)
      : line
  )).join('\n');
  assert.notEqual(tampered, materialized.nquads);
  expectCanonicalCode(
    () => validateCanonicalFactVersions(tampered, expectedRuns()),
    'S5_CANONICAL_TARGET_GRAPH',
  );
});

test('superseded FactVersion IRI is rejected by canonical output validation', () => {
  const materialized = baselineMaterialization();
  const oldFactVersion = ['https://axiolune.ai/ontology/meta/', 'patterns/FactVersion'].join('');
  const tampered = materialized.nquads.replace(FACT_VERSION, oldFactVersion);
  assert.notEqual(tampered, materialized.nquads);
  expectCanonicalCode(
    () => validateCanonicalFactVersions(tampered, expectedRuns()),
    'S5_CANONICAL_PROHIBITED_IRI',
  );
});

test('second versionOf anchor is rejected instead of being silently selected', () => {
  const materialized = baselineMaterialization();
  const subject = materialized.identities.observation.versionIri;
  const tampered = `${materialized.nquads}<${subject}> <${VERSION_OF}> <urn:axiolune:tamper:second-anchor> <${MARKET_GRAPH_IRI}> .\n`;
  expectCanonicalCode(
    () => validateCanonicalFactVersions(tampered, expectedRuns()),
    'S5_CANONICAL_VERSION_OF',
  );
});

test('missing revision is rejected as an incomplete four-axis version key', () => {
  const materialized = baselineMaterialization();
  const subject = materialized.identities.observation.versionIri;
  const tampered = materialized.nquads.split('\n').filter((line) => !(
    line.includes(`<${subject}>`) && line.includes(`<${REVISION}>`)
  )).join('\n');
  assert.notEqual(tampered, materialized.nquads);
  expectCanonicalCode(
    () => validateCanonicalFactVersions(tampered, expectedRuns()),
    'S5_CANONICAL_REQUIRED_FIELD',
  );
});

test('current generated market-data SHACL rejects a required-field deletion in actual materialized N-Quads', () => {
  const materialized = baselineMaterialization();
  const subject = materialized.identities.observation.versionIri;
  const priceKind = 'https://axiolune.ai/ontology/finance/market-data/priceKind';
  const tampered = materialized.nquads.split('\n').filter((line) => !(
    line.includes(`<${subject}>`) && line.includes(`<${priceKind}>`)
  )).join('\n');
  assert.notEqual(tampered, materialized.nquads);
  const result = spawnSync(
    process.execPath,
    ['scripts/domain/lib/s5-materialized-shacl-worker.cjs'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      input: canonicalJcs({
        schemaVersion: '1.0',
        dataNQuads: tampered,
        supportNQuads: baselineSupportNquads(),
        targetGraphIri: MARKET_GRAPH_IRI,
        moduleSourcePath: path.join(ROOT, 'ontology/domain/finance/market-data/module.yaml'),
        moduleSidecarPath: path.join(ROOT, 'ontology/domain/finance/market-data/module.shacl.ttl'),
      }),
      shell: false,
      timeout: 5 * 60 * 1000,
      windowsHide: true,
    },
  );
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /current-domain SHACL rejected the materialized graph/u);
});

test('current generated instruments SHACL rejects an incomplete upstream listing support fact', () => {
  const materialized = baselineMaterialization();
  const row = baselineRows()[0];
  const listingBusinessFrom =
    'https://axiolune.ai/ontology/finance/instruments/listingBusinessFrom';
  const tamperedSupport = baselineSupportNquads().split('\n').filter((line) => !(
    line.includes(`<${row.listing_version_iri}>`)
      && line.includes(`<${listingBusinessFrom}>`)
  )).join('\n');
  assert.notEqual(tamperedSupport, baselineSupportNquads());
  const result = spawnSync(
    process.execPath,
    ['scripts/domain/lib/s5-materialized-shacl-worker.cjs'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      input: canonicalJcs({
        schemaVersion: '1.0',
        dataNQuads: materialized.nquads,
        supportNQuads: tamperedSupport,
        targetGraphIri: MARKET_GRAPH_IRI,
        moduleSourcePath: path.join(ROOT, 'ontology/domain/finance/instruments/module.yaml'),
        moduleSidecarPath: path.join(ROOT, 'ontology/domain/finance/instruments/module.shacl.ttl'),
      }),
      shell: false,
      timeout: 5 * 60 * 1000,
      windowsHide: true,
    },
  );
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /current-domain SHACL rejected the materialized graph/u);
});

test('current generated market-structure SHACL rejects an incomplete listing-facility support fact', () => {
  const materialized = baselineMaterialization();
  const row = baselineRows()[0];
  const validFrom = 'https://axiolune.ai/ontology/meta/patterns/attributes/validFrom';
  const tamperedSupport = baselineSupportNquads().split('\n').filter((line) => !(
    line.includes(`<${row.listing_facility_version_iri}>`)
      && line.includes(`<${validFrom}>`)
  )).join('\n');
  assert.notEqual(tamperedSupport, baselineSupportNquads());
  const result = spawnSync(
    process.execPath,
    ['scripts/domain/lib/s5-materialized-shacl-worker.cjs'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      input: canonicalJcs({
        schemaVersion: '1.0',
        dataNQuads: materialized.nquads,
        supportNQuads: tamperedSupport,
        targetGraphIri: MARKET_GRAPH_IRI,
        moduleSourcePath: path.join(ROOT, 'ontology/domain/finance/market-structure/module.yaml'),
        moduleSidecarPath: path.join(ROOT, 'ontology/domain/finance/market-structure/module.shacl.ttl'),
      }),
      shell: false,
      timeout: 5 * 60 * 1000,
      windowsHide: true,
    },
  );
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /current-domain SHACL rejected the materialized graph/u);
});

test('current generated portfolio SHACL rejects a required market-value deletion', () => {
  const materialized = baselineMaterialization();
  const subject = materialized.identities.positionValuation.versionIri;
  const marketValue = 'https://axiolune.ai/ontology/finance/portfolio-positions/marketValue';
  const tampered = materialized.nquads.split('\n').filter((line) => !(
    line.includes(`<${subject}>`) && line.includes(`<${marketValue}>`)
  )).join('\n');
  assert.notEqual(tampered, materialized.nquads);
  const result = spawnSync(
    process.execPath,
    ['scripts/domain/lib/s5-materialized-shacl-worker.cjs'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      input: canonicalJcs({
        schemaVersion: '1.0',
        dataNQuads: tampered,
        supportNQuads: baselineSupportNquads(),
        targetGraphIri: PORTFOLIO_GRAPH_IRI,
        moduleSourcePath: path.join(ROOT, 'ontology/domain/finance/portfolio-positions/module.yaml'),
        moduleSidecarPath: path.join(ROOT, 'ontology/domain/finance/portfolio-positions/module.shacl.ttl'),
      }),
      shell: false,
      timeout: 5 * 60 * 1000,
      windowsHide: true,
    },
  );
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /current-domain SHACL rejected the materialized graph/u);
});

test('locked Custom worker discovers, executes, and passes all 17 applicable constraints', () => {
  const result = runCustomWorker();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout);
  assert.deepEqual(evidence.counts, {
    discovered: 17,
    executed: 17,
    failed: 0,
    passed: 17,
  });
  assert.deepEqual(
    evidence.checks.map((entry) => entry.evaluatorName).sort(),
    [
      'DirectUnitPriceQuotationRule',
      'HoldingSnapshotContract',
      'InstrumentListingIdentityContract',
      'InstrumentListingIntervalContract',
      'InstrumentListingOfferingContract',
      'MarketDataStreamIdentityContract',
      'ObservationContextQuotationContract',
      'ObservationIdentityAndRevisionContract',
      'PortfolioAccountMembershipClosureContract',
      'PortfolioAccountMembershipContract',
      'PortfolioObservationStreamContract',
      'PortfolioValuationContract',
      'PositionValuationContract',
      'PriceKindCompatibilityContract',
      'ThreeAxisObjectPITContract',
      'ThreeAxisPITContract',
      'ValuationCalculationDefinitionContract',
    ].sort(),
  );
  assert.ok(evidence.checks.every((entry) => (
    entry.outcome === 'passed'
      && /^[0-9a-f]{64}$/u.test(
        entry.constraintInstanceId,
      )
  )));
});

test('HoldingSnapshot Custom contract accepts its declared optional listing', () => {
  const materialized = baselineMaterialization();
  const predicate =
    'https://axiolune.ai/ontology/finance/portfolio-positions/HoldingSnapshot/role/holdingListing';
  const line = materialized.nquads.split('\n').find((candidate) => (
    candidate.startsWith(`<${materialized.identities.holding.versionIri}> `)
      && candidate.includes(`<${predicate}>`)
  ));
  assert.ok(line);
  const withoutOptionalListing = materialized.nquads.replace(`${line}\n`, '');
  const evidence = validatePortfolioCustom({
    constraintNames: ['HoldingSnapshotContract'],
    dataNquads: withoutOptionalListing,
  });
  assert.deepEqual(evidence.counts, {
    discovered: 1,
    executed: 1,
    failed: 0,
    passed: 1,
  });
});

test('HoldingSnapshot Custom contract rejects a missing observation-stream identity edge', () => {
  const materialized = baselineMaterialization();
  const predicate =
    'https://axiolune.ai/ontology/finance/portfolio-positions/HoldingSnapshot/role/holdingObservationStream';
  const line = materialized.nquads.split('\n').find((candidate) => (
    candidate.startsWith(`<${materialized.identities.holding.versionIri}> `)
      && candidate.includes(`<${predicate}>`)
  ));
  assert.ok(line);
  const tampered = materialized.nquads.replace(`${line}\n`, '');
  const result = runCustomWorker({ dataNquads: tampered, materialized });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /S5_CUSTOM_CARDINALITY/u);
});

test('HoldingSnapshot Custom contract rejects a byte-valid substitute source record', () => {
  const materialized = baselineMaterialization();
  const refPredicate =
    'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactRef';
  const digestPredicate =
    'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactDigest';
  const refLine = materialized.nquads.split('\n').find((candidate) => (
    candidate.startsWith(`<${materialized.identities.holding.versionIri}> `)
      && candidate.includes(`<${refPredicate}>`)
  ));
  const digestLine = materialized.nquads.split('\n').find((candidate) => (
    candidate.startsWith(`<${materialized.identities.holding.versionIri}> `)
      && candidate.includes(`<${digestPredicate}>`)
  ));
  assert.ok(refLine);
  assert.ok(digestLine);
  const closure = readJson(path.join(
    ROOT,
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/support-evidence-closure.json',
  ));
  const marketSource = closure.entries.find(
    (entry) => entry.evidenceIri === 'urn:axiolune:evidence:slice-a:market-source:v1',
  );
  assert.ok(marketSource);
  let tampered = materialized.nquads.replace(
    `${refLine}\n`,
    `${refLine.replace(
      'urn:axiolune:evidence:slice-a:holding-source:v1',
      'urn:axiolune:evidence:slice-a:market-source:v1',
    )}\n`,
  );
  tampered = tampered.replace(
    `${digestLine}\n`,
    `${digestLine.replace(/sha256:[0-9a-f]{64}/u, marketSource.artifactDigest)}\n`,
  );
  const result = runCustomWorker({ dataNquads: tampered, materialized });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /S5_CUSTOM_EVIDENCE/u);
});

test('HoldingSnapshot Custom contract rejects direct Portfolio and stored side edges', () => {
  const materialized = baselineMaterialization();
  const row = baselineRows()[0];
  for (const statement of [
    `<${materialized.identities.holding.versionIri}> <urn:axiolune:test:directPortfolio> `
      + `<${row.portfolio_logical_iri}> <${PORTFOLIO_GRAPH_IRI}> .\n`,
    `<${materialized.identities.holding.versionIri}> `
      + '<https://axiolune.ai/ontology/finance/orders-execution/orderSide> '
      + '<https://axiolune.ai/ontology/finance/orders-execution/OrderSide/value/Buy> '
      + `<${PORTFOLIO_GRAPH_IRI}> .\n`,
  ]) {
    assert.throws(
      () => validatePortfolioCustom({
        constraintNames: ['HoldingSnapshotContract'],
        dataNquads: `${materialized.nquads}${statement}`,
      }),
      /S5_CUSTOM_HOLDING/u,
    );
  }
});

test('PortfolioObservationStream Custom contract allows multiple versions of one logical key', () => {
  const row = baselineRows()[0];
  const original = baselineSupportNquads();
  const version = row.portfolio_observation_stream_version_iri;
  const clone = `${version}-revision-1`;
  const revision = buildPortfolioObservationRevisionClosure(clone, 'revision-1');
  const lockedEvidence = baselineLockedEvidence();
  const originalClosureEvidence = lockedEvidence.get(
    'urn:axiolune:evidence:slice-a:portfolio-observation-source:v1',
  );
  assert.ok(originalClosureEvidence);
  const revisionEvidenceIri =
    'urn:axiolune:evidence:slice-a:portfolio-observation-source:revision-1';
  const revisionClosureBytes = revision.artifacts.get(
    canonicalJcs(revision.closureBinding.artifactRef),
  );
  lockedEvidence.set(revisionEvidenceIri, {
    artifactDigest: revision.closureBinding.artifactDigest,
    artifactRef: revision.closureBinding.artifactRef,
    bytes: revisionClosureBytes,
    evidenceIri: revisionEvidenceIri,
    evidenceKind: 'portfolioObservationClosure',
    value: revision.closure,
  });
  const clonedStatements = original.split('\n').filter((line) => (
    line.startsWith(`<${version}> `)
  )).map((line) => {
    let withSubject = line.replace(`<${version}>`, `<${clone}>`);
    withSubject = withSubject.replaceAll(
      originalClosureEvidence.evidenceIri,
      revisionEvidenceIri,
    ).replaceAll(
      originalClosureEvidence.artifactDigest,
      revision.closureBinding.artifactDigest,
    );
    return withSubject.includes(
      '<https://axiolune.ai/ontology/meta/patterns/attributes/revision>',
    )
      ? withSubject.replace('"0"^^', '"1"^^')
      : withSubject;
  }).join('\n');
  assert.notEqual(clonedStatements, '');
  const evidence = validatePortfolioCustom({
    additionalLockedArtifacts: revision.artifacts,
    constraintNames: ['PortfolioObservationStreamContract'],
    lockedEvidence,
    supportNquads: `${original}${clonedStatements}\n`,
  });
  assert.deepEqual(evidence.counts, {
    discovered: 1,
    executed: 1,
    failed: 0,
    passed: 1,
  });
});

test('PortfolioObservationStream Custom contract rejects one logical identity shared by different keys', () => {
  const row = baselineRows()[0];
  const original = baselineSupportNquads();
  const version = row.portfolio_observation_stream_version_iri;
  const clone = `${version}-other-key`;
  const clonedStatements = original.split('\n').filter((line) => (
    line.startsWith(`<${version}> `)
  )).map((line) => (
    line.replace(`<${version}>`, `<${clone}>`).includes(
      '<https://axiolune.ai/ontology/finance/portfolio-positions/portfolioObservationStreamId>',
    )
      ? line.replace(`<${version}>`, `<${clone}>`).replace(
        '"custodian-acme-positions"',
        '"custodian-acme-positions-other"',
      )
      : line.replace(`<${version}>`, `<${clone}>`)
  )).join('\n');
  assert.notEqual(clonedStatements, '');
  assert.throws(
    () => validatePortfolioCustom({
      constraintNames: ['PortfolioObservationStreamContract'],
      supportNquads: `${original}${clonedStatements}\n`,
    }),
    /S5_CUSTOM_PORTFOLIO_OBSERVATION_STREAM/u,
  );
});

test('locked Custom worker rejects tampered policy artifact bytes before evaluation', () => {
  const directory = temporaryDirectory('axiolune-s5-policy-bytes-');
  try {
    const file = path.join(directory, 'rounding-policy.json');
    const policy = JSON.parse(
      baselinePolicyArtifacts().roundingBytes.toString('utf8'),
    );
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

test('Custom validation rejects a market-value amount/scale disagreement', () => {
  const materialized = baselineMaterialization();
  const marketValue = `${materialized.identities.positionValuation.versionIri}/value/market-value`;
  const line = materialized.nquads.split('\n').find((candidate) => (
    candidate.startsWith(`<${marketValue}> `)
      && candidate.includes(`<https://axiolune.ai/ontology/meta/core/properties/hasScale>`)
  ));
  assert.ok(line);
  const tampered = materialized.nquads.replace(
    `${line}\n`,
    `${line.replace('"2"^^', '"3"^^')}\n`,
  );
  const result = runCustomWorker({ dataNquads: tampered, materialized });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /S5_CUSTOM_MONEY_SCALE/u);
});

test('Custom validation rejects a non-prior completed valuation input context', () => {
  const materialized = baselineMaterialization();
  const closure = readJson(path.join(
    ROOT,
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/support-evidence-closure.json',
  ));
  const prior = closure.entries.find((entry) => (
    entry.evidenceIri === 'urn:axiolune:evidence:slice-a:prior-input-context:v1'
  ));
  const future = closure.entries.find((entry) => (
    entry.evidenceIri === 'urn:axiolune:evidence:slice-a:future-prior-input-context:v1'
  ));
  let tampered = materialized.nquads.replace(prior.evidenceIri, future.evidenceIri);
  tampered = tampered.replace(prior.artifactDigest, future.artifactDigest);
  assert.notEqual(tampered, materialized.nquads);
  const result = runCustomWorker({ dataNquads: tampered, materialized });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /S5_CUSTOM_INPUT_CONTEXT/u);
});

test('Custom validation rejects a closure whose portfolio differs from the valuation header', () => {
  const materialized = baselineMaterialization();
  const row = baselineRows()[0];
  const predicate =
    'https://axiolune.ai/ontology/finance/portfolio-positions/PortfolioAccountMembershipClosure/role/closurePortfolio';
  const original = baselineSupportNquads();
  const line = original.split('\n').find((candidate) => (
    candidate.startsWith(`<${row.membership_closure_version_iri}> `)
      && candidate.includes(`<${predicate}>`)
  ));
  assert.ok(line);
  const tampered = original.replace(
    `${line}\n`,
    `${line.replace(`<${row.portfolio_logical_iri}>`, `<${row.account_logical_iri}>`)}\n`,
  );
  const result = runCustomWorker({ materialized, supportNquads: tampered });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /S5_CUSTOM_PORTFOLIO_VALUATION/u);
});

test('Custom validation rejects a holding-account substitution at the exact stream-row closure', () => {
  const materialized = baselineMaterialization();
  const row = baselineRows()[0];
  const predicate =
    'https://axiolune.ai/ontology/finance/portfolio-positions/HoldingSnapshot/role/holdingAccount';
  const line = materialized.nquads.split('\n').find((candidate) => (
    candidate.startsWith(`<${materialized.identities.holding.versionIri}> `)
      && candidate.includes(`<${predicate}>`)
  ));
  assert.ok(line);
  const tampered = materialized.nquads.replace(
    `${line}\n`,
    `${line.replace(`<${row.account_logical_iri}>`, '<urn:axiolune:account:not-in-closure>')}\n`,
  );
  const typedButUnlistedAccount = [
    '<urn:axiolune:account:not-in-closure> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://axiolune.ai/ontology/meta/data-binding/FactIdentity>',
    '<urn:axiolune:account:not-in-closure> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://axiolune.ai/ontology/finance/foundation/FinancialAccount/LogicalIdentity>',
  ].map((statement) => `${statement} <${SUPPORT_GRAPH_IRI}> .\n`).join('');
  const result = runCustomWorker({
    dataNquads: tampered,
    materialized,
    supportNquads: `${baselineSupportNquads()}${typedButUnlistedAccount}`,
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /S5_CUSTOM_HOLDING_SOURCE_CLOSURE/u);
});

test('Custom validation rejects quotation member substitution after set-digest recomputation', () => {
  const materialized = baselineMaterialization();
  const row = baselineRows()[0];
  const original = baselineSupportNquads();
  const clone = `${row.quotation_contract_version_iri}-substitute`;
  const clonedStatements = original.split('\n').filter((line) => (
    line.startsWith(`<${row.quotation_contract_version_iri}> `)
  )).map((line) => (
    line.replace(`<${row.quotation_contract_version_iri}>`, `<${clone}>`)
  )).join('\n');
  assert.notEqual(clonedStatements, '');
  const definitionPredicate =
    'https://axiolune.ai/ontology/finance/portfolio-positions/valuationDefinitionQuotationContract';
  const definitionLine = original.split('\n').find((line) => (
    line.startsWith(`<${row.valuation_definition_version_iri}> `)
      && line.includes(`<${definitionPredicate}>`)
  ));
  assert.ok(definitionLine);
  let tampered = original.replace(
    `${definitionLine}\n`,
    `${definitionLine.replace(`<${row.quotation_contract_version_iri}>`, `<${clone}>`)}\n`,
  );
  tampered = tampered.replace(
    iriSetDigest([row.quotation_contract_version_iri]),
    iriSetDigest([clone]),
  );
  tampered = `${tampered}${clonedStatements}\n`;
  const result = runCustomWorker({ materialized, supportNquads: tampered });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /S5_CUSTOM_POSITION_VALUATION/u);
});

test('Custom validation rejects duplicate valuation-definition logical keys', () => {
  const materialized = baselineMaterialization();
  const row = baselineRows()[0];
  const original = baselineSupportNquads();
  const clone = `${row.valuation_definition_version_iri}-duplicate`;
  const clonedStatements = original.split('\n').filter((line) => (
    line.startsWith(`<${row.valuation_definition_version_iri}> `)
  )).map((line) => (
    line.replace(`<${row.valuation_definition_version_iri}>`, `<${clone}>`)
  )).join('\n');
  assert.notEqual(clonedStatements, '');
  const result = runCustomWorker({
    materialized,
    supportNquads: `${original}${clonedStatements}\n`,
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /S5_CUSTOM_VALUATION_DEFINITION/u);
});

test('Custom validation rejects duplicate PositionValuation reverse logical keys', () => {
  const materialized = baselineMaterialization();
  const subject = materialized.identities.positionValuation.versionIri;
  const clone = `${subject}-duplicate`;
  const clonedStatements = materialized.nquads.split('\n').filter((line) => (
    line.startsWith(`<${subject}> `)
  )).map((line) => line.replace(`<${subject}>`, `<${clone}>`)).join('\n');
  assert.notEqual(clonedStatements, '');
  const result = runCustomWorker({
    dataNquads: `${materialized.nquads}${clonedStatements}\n`,
    materialized,
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /S5_CUSTOM_POSITION_VALUATION/u);
});

test('Custom validation rejects a semantically invalid locked support quotation', () => {
  const original = baselineSupportNquads();
  const tampered = original.replace(
    'contractMultiplier> "1"^^<http://www.w3.org/2001/XMLSchema#decimal>',
    'contractMultiplier> "2"^^<http://www.w3.org/2001/XMLSchema#decimal>',
  );
  assert.notEqual(tampered, original);
  const result = runCustomWorker({ supportNquads: tampered });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /S5_CUSTOM_QUOTATION/u);
});

test('support graph cannot turn a missing main-graph requirement from fail to pass', () => {
  const materialized = baselineMaterialization();
  const predicate = 'https://axiolune.ai/ontology/finance/market-data/priceKind';
  const line = materialized.nquads.split('\n').find((candidate) => (
    candidate.includes(`<${materialized.identities.observation.versionIri}>`)
      && candidate.includes(`<${predicate}>`)
  ));
  assert.ok(line);
  const dataNquads = materialized.nquads.replace(`${line}\n`, '');
  const injected = line.replace(`<${MARKET_GRAPH_IRI}> .`, `<${SUPPORT_GRAPH_IRI}> .`);
  assert.notEqual(injected, line);
  const result = runCustomWorker({
    dataNquads,
    materialized,
    supportNquads: `${baselineSupportNquads()}${injected}\n`,
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /S5_CUSTOM_SUPPORT_AUGMENTATION/u);
});

test('main graph cannot turn a missing prior-support requirement from fail to pass', () => {
  const materialized = baselineMaterialization();
  const row = baselineRows()[0];
  const predicate = 'https://axiolune.ai/ontology/finance/instruments/contractMultiplier';
  const support = baselineSupportNquads();
  const line = support.split('\n').find((candidate) => (
    candidate.startsWith(`<${row.quotation_contract_version_iri}> `)
      && candidate.includes(`<${predicate}>`)
  ));
  assert.ok(line);
  const supportNquads = support.replace(`${line}\n`, '');
  const injected = line.replace(`<${SUPPORT_GRAPH_IRI}> .`, `<${MARKET_GRAPH_IRI}> .`);
  assert.notEqual(injected, line);
  const result = runCustomWorker({
    dataNquads: `${materialized.nquads}${injected}\n`,
    materialized,
    supportNquads,
  });
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /S5_CUSTOM_SUPPORT_AUGMENTATION/u);
});

test('applicable Custom constraint without a locked evaluator fails closed', () => {
  const directory = temporaryDirectory('axiolune-s5-custom-engine-missing-');
  try {
    const source = path.join(ROOT, 'ontology/domain/finance/market-data/module.yaml');
    const document = yaml.load(fs.readFileSync(source, 'utf8'));
    const constraintIri =
      'https://axiolune.ai/ontology/finance/market-data/S5UnsupportedApplicableCustom';
    document.domain.constraints.S5UnsupportedApplicableCustom = {
      constraintType: 'Logical',
      definition: 'Synthetic negative proving that evaluator discovery fails closed.',
      expression: { expression: 'true', language: 'Custom' },
      iri: constraintIri,
      label: 'unsupported applicable Custom negative',
      message: 'synthetic unsupported Custom constraint',
      scope: 'Object',
      severity: 'Error',
      targetElement: 'https://axiolune.ai/ontology/finance/market-data/PriceObservation',
    };
    document.domain.constraintBindings.push({
      constraintRef: constraintIri,
      enforcementLevel: 'Mandatory',
      targetElement: 'https://axiolune.ai/ontology/finance/market-data/PriceObservation',
    });
    const changedModule = path.join(directory, 'market-data-module.yaml');
    fs.writeFileSync(changedModule, yaml.dump(document, { lineWidth: 120 }));
    const moduleSourcePaths = CUSTOM_MODULE_RELS.map((relative) => (
      relative === 'ontology/domain/finance/market-data/module.yaml'
        ? changedModule
        : path.join(ROOT, ...relative.split('/'))
    ));
    const result = runCustomWorker({ moduleSourcePaths });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /S5_CUSTOM_ENGINE_MISSING/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('builds and independently verifies all six standalone kinds plus detached ledger', () => {
  assert.equal(baselineSummary.recordCount, 14);
  assert.deepEqual(baselineSummary.recordTypeCounts, {
    evidenceLedger: 1,
    failureReport: 1,
    materializationBatchRun: 1,
    materializationRun: 4,
    pitRequest: 1,
    replayReport: 1,
    validationReport: 5,
  });
  assert.equal(baselineSummary.failedAuditRecords, 1);
  assert.equal(baselineSummary.canonicalization, 'RDFC-1.0');
  assert.equal(baselineSummary.buildEvidenceBindingVerified, false);
  assert.equal(baselineSummary.releaseEvidence, false);
  const marketEvidence = readJson(path.join(
    baselineDirectory,
    'gate-evidence/current-domain-shacl-market-data.json',
  ));
  assert.deepEqual(marketEvidence.validatedModuleIris, [
    'https://axiolune.ai/ontology/finance/instruments',
    'https://axiolune.ai/ontology/finance/market-data',
    'https://axiolune.ai/ontology/finance/market-structure',
  ]);
  assert.equal(marketEvidence.validations.length, 3);
  assert.ok(marketEvidence.validations.every((entry) => (
    entry.outcome === 'passed'
      && entry.execution.conforms === true
      && entry.execution.resultCount === 0
  )));
  const customEvidence = readJson(path.join(
    baselineDirectory,
    'gate-evidence/applicable-custom-market-data.json',
  ));
  assert.deepEqual(customEvidence.counts, {
    discovered: 17,
    executed: 17,
    failed: 0,
    passed: 17,
  });
  const combinedEvidence = readJson(path.join(
    baselineDirectory,
    'gate-evidence/materialized-validation-market-data.json',
  ));
  assert.deepEqual(combinedEvidence.checks.map((entry) => entry.kind), [
    'applicableCustom',
    'currentDomainSHACL',
  ]);
  assert.equal(
    combinedEvidence.supportDatasetDigest,
    `sha256:${crypto.createHash('sha256').update(baselineSupportNquads()).digest('hex')}`,
  );
  assert.deepEqual(verifyS5ControlRecordChain(roots(baselineDirectory)), baselineSummary);
});

test('Market Data S5 records machine-close every M2-PLAN 10.3 field for the exact two canonical mappings', () => {
  const controlInput = readJson(path.join(ROOT, ...INPUT_FIXTURE_REL.split('/')));
  const sourceSnapshot = readJson(path.join(
    ROOT,
    ...controlInput.originalSnapshotRef.path.split('/'),
  ));
  const marketDescriptor = controlInput.mappings.find(
    (entry) => entry.planRef
      === 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/plan/market-data',
  );
  assert.ok(marketDescriptor);
  const marketRun = readRecord(baselineDirectory, 'market-data-run');
  const pitRequest = readRecord(baselineDirectory, 'pit-request');
  const batchRun = readRecord(baselineDirectory, 'batch-run');
  const sourceDataset = marketRun.inputDatasets.find(
    (entry) => entry.dataset === sourceSnapshot.dataset,
  );
  assert.ok(sourceDataset);
  assert.deepEqual(sourceDataset.snapshotRef, controlInput.originalSnapshotRef);

  const coveredMappings = marketDescriptor.mappingArtifacts.map((descriptor) => {
    const mapping = readJson(path.join(ROOT, ...descriptor.mappingArtifactRef.path.split('/')));
    const closureRow = marketRun.mappingClosure.find(
      (entry) => entry.mappingRef === descriptor.mappingRef,
    );
    assert.ok(closureRow, descriptor.mappingRef);
    assert.equal(
      closureRow.mappingSourceDigest,
      taggedJcsDigest('axiolune-semantic-mapping-v1\0', mapping),
      descriptor.mappingRef,
    );
    return {
      artifactRef: descriptor.mappingArtifactRef,
      mappingRef: descriptor.mappingRef,
      mappingSourceDigest: closureRow.mappingSourceDigest,
      targetType: mapping.targetType,
    };
  }).sort((left, right) => Buffer.compare(
    Buffer.from(left.mappingRef),
    Buffer.from(right.mappingRef),
  ));
  assert.deepEqual(
    coveredMappings.map((entry) => entry.artifactRef.path),
    [
      'mappings/finance/v0.3.0/market-data/market-data-stream.semantic-mapping.json',
      'mappings/finance/v0.3.0/market-data/price-observation.semantic-mapping.json',
    ],
  );
  assert.deepEqual(
    coveredMappings.map((entry) => entry.targetType),
    [
      'https://axiolune.ai/ontology/finance/market-data/MarketDataStream',
      'https://axiolune.ai/ontology/finance/market-data/PriceObservation',
    ],
  );

  const acceptanceProjection = {
    asOfAvailable: pitRequest.asOfAvailable,
    asOfKnowledge: pitRequest.asOfKnowledge,
    asOfValid: pitRequest.asOfValid,
    compilerDigest: marketRun.compilerDigest,
    immutableSnapshotId: sourceSnapshot.snapshotId,
    inputSnapshotDigest: sourceDataset.artifactDigest,
    mappingDigest: marketRun.mappingClosureDigest,
    ontologyRelease: controlInput.profileRef,
    outputGraphDigest: marketRun.result.outputGraphDigest,
    referenceTime: marketRun.referenceTime,
    sourceDatasetId: sourceDataset.dataset,
    sourceSchemaDigest: sourceDataset.schemaDigest,
    validationReportDigest: marketRun.result.validationReportDigest,
    validatorDigest: marketRun.validatorDigest,
  };
  assert.deepEqual(Object.keys(acceptanceProjection).sort(), [
    'asOfAvailable', 'asOfKnowledge', 'asOfValid', 'compilerDigest',
    'immutableSnapshotId', 'inputSnapshotDigest', 'mappingDigest',
    'ontologyRelease', 'outputGraphDigest', 'referenceTime', 'sourceDatasetId',
    'sourceSchemaDigest', 'validationReportDigest', 'validatorDigest',
  ].sort());
  assert.equal(acceptanceProjection.ontologyRelease, 'https://axiolune.ai/conformance/m2/0.3.0');
  assert.equal(acceptanceProjection.immutableSnapshotId, 'slice-a-snapshot-2024-07-10');
  assert.equal(acceptanceProjection.sourceDatasetId, 'urn:axiolune:source-dataset:slice-a:v1');
  assert.equal(
    acceptanceProjection.inputSnapshotDigest,
    fileDigest(path.join(ROOT, ...controlInput.originalSnapshotRef.path.split('/'))),
  );
  assert.equal(
    acceptanceProjection.sourceSchemaDigest,
    fileDigest(path.join(ROOT, ...controlInput.sourceSchemaRef.path.split('/'))),
  );
  assert.deepEqual(
    [acceptanceProjection.asOfValid, acceptanceProjection.asOfKnowledge,
      acceptanceProjection.asOfAvailable],
    [controlInput.execution.asOfValid, controlInput.execution.asOfKnowledge,
      controlInput.execution.asOfAvailable],
  );
  assert.equal(acceptanceProjection.referenceTime, controlInput.execution.referenceTime);
  assert.equal(
    acceptanceProjection.outputGraphDigest,
    computeNamedGraphDigest(
      fs.readFileSync(path.join(baselineDirectory, 'rdf', 'dataset-original.nq'), 'utf8'),
      MARKET_GRAPH_IRI,
    ).digest,
  );
  assert.equal(marketRun.result.outputFactVersionCount, 2);
  assert.equal(marketRun.result.outputGraph, MARKET_GRAPH_IRI);
  assert.equal(marketRun.result.outcome, 'completed');
  assert.deepEqual(marketRun.mappingClosure.map((entry) => entry.mappingRef),
    coveredMappings.map((entry) => entry.mappingRef));
  assert.equal(
    acceptanceProjection.validationReportDigest,
    fileDigest(path.join(baselineDirectory, 'records', 'market-data-report.json')),
  );
  assert.equal(
    marketRun.result.validationReportRef,
    readRecord(baselineDirectory, 'market-data-report').iri,
  );
  const batchMember = batchRun.result.members.find(
    (member) => member.runRef === marketRun.iri,
  );
  assert.ok(batchMember);
  assert.equal(batchMember.outputGraphDigest, acceptanceProjection.outputGraphDigest);
  assert.equal(pitRequest.materializationContext.recordRef, batchRun.iri);
});

test('two detached builds have byte-identical records, build ID, and ledger digest', () => {
  const directory = temporaryDirectory('axiolune-s5-chain-determinism-');
  try {
    const summary = createS5ControlRecordChain(inputRef, roots(directory));
    assert.deepEqual(summary, baselineSummary);
    for (const name of fs.readdirSync(path.join(baselineDirectory, 'records'))) {
      assert.ok(fs.readFileSync(path.join(baselineDirectory, 'records', name))
        .equals(fs.readFileSync(path.join(directory, 'records', name))), name);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('future source append is PIT-ineligible and leaves the historical RDFC dataset identical', () => {
  assert.equal(baselineSummary.futureAppendHistoricalDigest, baselineSummary.outputDatasetDigest);
  assert.equal(baselineSummary.replayDigest, baselineSummary.outputDatasetDigest);
  const replay = readRecord(baselineDirectory, 'replay-report');
  const futureComparisons = replay.result.comparisons.filter((entry) => entry.name.startsWith('futureAppend'));
  assert.equal(futureComparisons.length, 2);
  assert.ok(futureComparisons.every((entry) => (
    entry.equal === true && entry.originalDigest === entry.replayDigest
  )));
});

test('PIT inventory is the exact six materialized FactVersions and is independently reproducible', () => {
  const request = readRecord(baselineDirectory, 'pit-request');
  const report = readRecord(baselineDirectory, 'pit-report');
  const nquads = fs.readFileSync(path.join(baselineDirectory, 'rdf', 'dataset-original.nq'), 'utf8');
  const recomputed = evaluatePitSelection(nquads, {
    asOfAvailable: request.asOfAvailable,
    asOfKnowledge: request.asOfKnowledge,
    asOfValid: request.asOfValid,
  });
  assert.equal(report.selectedFactVersionCount, 6);
  assert.deepEqual(report.selectedFactVersionIris, recomputed.selectedFactVersionIris);
  assert.equal(report.selectedFactVersionSetDigest, recomputed.selectedFactVersionSetDigest);
});

test('source-tree manifest closes root, plans, authority leaves, and runtime dependencies', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(baselineDirectory, 'source-tree-manifest.json'), 'utf8'),
  );
  const paths = new Set(manifest.files.map((entry) => entry.path));
  for (const required of [
    INPUT_FIXTURE_REL,
    'scripts/domain/lib/json-pointer-source-extractor.cjs',
    'scripts/domain/lib/ontology-ir-normalizer.cjs',
    'scripts/domain/lib/s5-canonical-materialization.cjs',
    'scripts/domain/lib/s5-control-record-chain.cjs',
    'scripts/domain/lib/s5-materialized-custom-validation.cjs',
    'scripts/domain/lib/s5-materialized-custom-worker.cjs',
    'scripts/domain/lib/s5-materialized-shacl-worker.cjs',
    'scripts/domain/lib/s5-prior-support-chain.cjs',
    'scripts/domain/lib/strict-source-locator.cjs',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/identity-plan.json',
    'mappings/finance/v0.3.0/slice-a-s5/identity-manifest.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/isin-value-mapping.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/market-data-plan.json',
    'mappings/finance/v0.3.0/market-data/market-data-stream.semantic-mapping.json',
    'mappings/finance/v0.3.0/market-data/price-observation.semantic-mapping.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/portfolio-valuation-plan.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/holding-snapshot-mapping.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/portfolio-valuation-mapping.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/position-valuation-mapping.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/support-evidence-closure.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/prior-valuation-pit-request.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/prior-valuation-input-context.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/prior-valuation-input-set.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/future-prior-valuation-pit-request.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/future-prior-valuation-input-context.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/future-prior-valuation-input-set.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/ontology-closure-manifest.json',
    'ontology/domain/finance/foundation/module.yaml',
    'ontology/domain/finance/foundation/module.shacl.ttl',
    'ontology/domain/finance/market-data/module.yaml',
    'ontology/domain/finance/market-data/module.shacl.ttl',
    'ontology/domain/finance/orders-execution/module.yaml',
    'ontology/domain/finance/portfolio-positions/module.yaml',
    'ontology/domain/finance/portfolio-positions/module.shacl.ttl',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/synthetic-reference.json',
    'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/synthetic-reference-lock.json',
    `${PRIOR_SUPPORT_REL}/batch-definition.json`,
    `${PRIOR_SUPPORT_REL}/batch-run.json`,
    `${PRIOR_SUPPORT_REL}/chain-manifest.json`,
    `${PRIOR_SUPPORT_REL}/dataset.nq`,
    `${PRIOR_SUPPORT_REL}/evidence-ledger.json`,
    ...[
      'direct-unit-quotation',
      'financial-instrument',
      'instrument-listing',
      'portfolio-membership',
      'portfolio-membership-closure',
      'portfolio-observation-stream',
      'trading-facility',
      'valuation-definition',
    ].flatMap((id) => [
      `${PRIOR_SUPPORT_REL}/${id}-identity-contract.json`,
      `${PRIOR_SUPPORT_REL}/${id}-mapping.json`,
    ]),
    ...['instruments', 'market-structure', 'portfolio'].flatMap((id) => [
      `${PRIOR_SUPPORT_REL}/${id}-materialization-run.json`,
      `${PRIOR_SUPPORT_REL}/${id}-plan.json`,
      `${PRIOR_SUPPORT_REL}/${id}-validation-report.json`,
    ]),
  ]) {
    assert.equal(paths.has(required), true, required);
  }
  assert.equal(paths.size, baselineSummary.sourceTreeFileCount);
});

test('transformation closures equal the mappings actual transformationRef inventories', () => {
  const expected = {
    'holding-snapshot': [
      'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/transformation/quantity-value',
    ],
    'isin-value': [],
    'market-data-stream': [],
    'portfolio-valuation': [],
    'position-valuation': [
      'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/transformation/direct-unit-price-times-quantity',
    ],
    'price-observation': [
      'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/transformation/money-value',
    ],
  };
  for (const [id, refs] of Object.entries(expected)) {
    const closure = readJson(path.join(
      ROOT,
      `tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/${id}-transformation-closure.json`,
    ));
    assert.deepEqual(
      closure.transformations.map((entry) => entry.transformationRef),
      refs,
      id,
    );
  }
});

test('mapping transformation closure cannot omit an actually referenced transformation', () => {
  expectSourceClosureFailure(
    'axiolune-s5-transform-missing-',
    (sourceTree) => {
      const file = path.join(
        sourceTree,
        'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/position-valuation-transformation-closure.json',
      );
      const closure = readJson(file);
      closure.transformations = [];
      writeJcs(file, closure);
    },
    'S5_CHAIN_TRANSFORMATION',
  );
});

test('direct-only mapping transformation closure cannot invent an implementation', () => {
  expectSourceClosureFailure(
    'axiolune-s5-transform-extra-',
    (sourceTree) => {
      const directFile = path.join(
        sourceTree,
        'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/isin-value-transformation-closure.json',
      );
      const directClosure = readJson(directFile);
      const template = readJson(path.join(
        sourceTree,
        'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/price-observation-transformation-closure.json',
      )).transformations[0];
      directClosure.transformations = [{
        ...template,
        transformationRef:
          'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/transformation/invented',
      }];
      writeJcs(directFile, directClosure);
    },
    'S5_CHAIN_TRANSFORMATION',
  );
});

test('mapping transformation implementation cannot substitute the downstream chain verifier', () => {
  expectSourceClosureFailure(
    'axiolune-s5-transform-implementation-substitution-',
    (sourceTree) => {
      const file = path.join(
        sourceTree,
        'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/position-valuation-transformation-closure.json',
      );
      const closure = readJson(file);
      const transformation = closure.transformations[0];
      transformation.implementationRef = {
        kind: 'path',
        path: 'scripts/domain/lib/s5-control-record-chain.cjs',
        root: 'sourceTree',
      };
      transformation.implementationDigest = fileDigest(sourceArtifactFile(
        sourceTree,
        transformation.implementationRef,
      ));
      writeJcs(file, closure);
    },
    'S5_CHAIN_TRANSFORMATION',
  );
});

test('mapping transformation output cannot substitute the chain-summary contract', () => {
  expectSourceClosureFailure(
    'axiolune-s5-transform-output-substitution-',
    (sourceTree) => {
      const file = path.join(
        sourceTree,
        'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/position-valuation-transformation-closure.json',
      );
      const closure = readJson(file);
      const transformation = closure.transformations[0];
      transformation.outputContractRef = {
        kind: 'path',
        path: 'scripts/domain/control-record-profile/s5-v1/capability-output-contract.json',
        root: 'sourceTree',
      };
      transformation.outputContractDigest = fileDigest(sourceArtifactFile(
        sourceTree,
        transformation.outputContractRef,
      ));
      writeJcs(file, closure);
    },
    'S5_CHAIN_TRANSFORMATION',
  );
});

test('RDFC output-contract substitution cannot cross the authenticated evidence closure', () => {
  expectSourceClosureFailure(
    'axiolune-s5-rdfc-contract-substitution-',
    (sourceTree) => {
      const contractFile = path.join(
        sourceTree,
        'scripts/domain/control-record-profile/s5-v1/rdfc-capability-output-contract.json',
      );
      const contract = readJson(contractFile);
      contract.algorithm = 'URDNA2015';
      writeJcs(contractFile, contract);
      const lockFile = path.join(
        sourceTree,
        'scripts/domain/control-record-profile/s5-v1/toolchain.lock.json',
      );
      const lock = readJson(lockFile);
      const capability = lock.tools.find((entry) => (
        entry.toolId === 'rdf-canonize'
      )).capabilities[0];
      capability.outputContractDigest = fileDigest(contractFile);
      writeJcs(lockFile, lock);
    },
    'S5_CHAIN_SUPPORT_EVIDENCE',
  );
});

test('current materialization batch cannot omit its cross-plan dependency edge', () => {
  expectSourceClosureFailure(
    'axiolune-s5-current-batch-edge-',
    (sourceTree) => {
      const file = path.join(
        sourceTree,
        'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/batch-definition.json',
      );
      const batch = readJson(file);
      batch.dependencyEdges = [];
      writeJcs(file, batch);
    },
    'S5_CHAIN_BATCH_DEPENDENCY',
  );
});

test('prior support chain rejects a missing dataset artifact', () => {
  expectSourceClosureFailure(
    'axiolune-s5-prior-support-missing-',
    (sourceTree) => {
      const manifest = readJson(priorSupportManifestFile(sourceTree));
      fs.rmSync(sourceArtifactFile(sourceTree, manifest.dataset.artifactRef));
    },
    'S5_CHAIN_PRIOR_SUPPORT',
  );
});

test('prior support chain rejects tampered dataset bytes', () => {
  expectSourceClosureFailure(
    'axiolune-s5-prior-support-tampered-',
    (sourceTree) => {
      const manifest = readJson(priorSupportManifestFile(sourceTree));
      const file = sourceArtifactFile(sourceTree, manifest.dataset.artifactRef);
      fs.appendFileSync(file, '# tampered\n');
    },
    'S5_CHAIN_PRIOR_SUPPORT',
  );
});

test('prior support chain rejects a substituted dataset artifact', () => {
  expectSourceClosureFailure(
    'axiolune-s5-prior-support-substituted-',
    (sourceTree) => {
      const manifestFile = priorSupportManifestFile(sourceTree);
      const manifest = readJson(manifestFile);
      manifest.dataset.artifactRef = {
        kind: 'path',
        path: 'ontology/domain/finance/foundation/module.shacl.ttl',
        root: 'sourceTree',
      };
      manifest.dataset.artifactDigest = fileDigest(sourceArtifactFile(
        sourceTree,
        manifest.dataset.artifactRef,
      ));
      writeJcs(manifestFile, manifest);
    },
    'S5_CHAIN_PRIOR_SUPPORT',
  );
});

test('prior support manifest cannot omit a canonical SemanticMappingDefinition', () => {
  expectSourceClosureFailure(
    'axiolune-s5-prior-support-mapping-',
    (sourceTree) => {
      const file = priorSupportManifestFile(sourceTree);
      const manifest = readJson(file);
      manifest.mappings.pop();
      writeJcs(file, manifest);
    },
    'S5_CHAIN_PRIOR_SUPPORT',
  );
});

test('prior support DAG cannot omit a required dependency after all outer locks are recomputed', () => {
  expectSourceClosureFailure(
    'axiolune-s5-prior-support-edge-',
    (sourceTree) => rewritePriorSupportBatchAndCascade(sourceTree, (batch) => {
      batch.dependencyEdges.pop();
    }),
    'S5_CHAIN_PRIOR_SUPPORT',
  );
});

test('prior support chain rejects a missing validation report artifact', () => {
  expectSourceClosureFailure(
    'axiolune-s5-prior-support-report-',
    (sourceTree) => {
      const manifest = readJson(priorSupportManifestFile(sourceTree));
      fs.rmSync(sourceArtifactFile(sourceTree, manifest.reports[0].artifactRef));
    },
    'S5_CHAIN_PRIOR_SUPPORT',
  );
});

test('forged priorRun is rejected after dataset, run, report, batch, and ledger locks are recomputed', () => {
  expectSourceClosureFailure(
    'axiolune-s5-prior-support-forged-run-',
    (sourceTree) => rewritePriorSupportDatasetAndCascade(sourceTree, (nquads) => {
      const subject = baselineRows()[0].instrument_version_iri;
      const line = nquads.split('\n').find((candidate) => (
        candidate.startsWith(`<${subject}> `)
          && candidate.includes('generatingContextRef')
      ));
      assert.ok(line);
      const changed = line.replace(
        'urn:axiolune:run:slice-a:instrument-input-context:v1',
        'urn:axiolune:run:slice-a:portfolio-input-context:v1',
      );
      assert.notEqual(changed, line);
      return nquads.replace(line, changed);
    }),
    'S5_CHAIN_PRIOR_SUPPORT',
  );
});

test('invalid support semantics are re-executed after every chain lock is recomputed', () => {
  expectSourceClosureFailure(
    'axiolune-s5-prior-support-custom-',
    (sourceTree) => rewritePriorSupportDatasetAndCascade(sourceTree, (nquads) => (
      nquads.replace(
        'contractMultiplier> "1"^^<http://www.w3.org/2001/XMLSchema#decimal>',
        'contractMultiplier> "2"^^<http://www.w3.org/2001/XMLSchema#decimal>',
      )
    )),
    'S5_CHAIN_APPLICABLE_CUSTOM',
  );
});

test('actual ontology closure rejects source, normalized-IR, and import-join digest tampering', () => {
  const cases = [
    ['sourceDigest', (closure) => { closure.modules[0].sourceDigest = `sha256:${'0'.repeat(64)}`; }],
    ['normalizedIrDigest', (closure) => { closure.modules[0].normalizedIrDigest = `sha256:${'1'.repeat(64)}`; }],
    ['importedSourceDigest', (closure) => { closure.imports[0].importedSourceDigest = `sha256:${'2'.repeat(64)}`; }],
  ];
  for (const [label, mutate] of cases) {
    const sourceTree = cloneSourceClosure();
    const buildEvidence = temporaryDirectory(`axiolune-s5-ontology-${label}-`);
    try {
      const file = path.join(
        sourceTree,
        'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/ontology-closure-manifest.json',
      );
      const closure = readJson(file);
      mutate(closure);
      writeJcs(file, closure);
      expectCode(
        () => createS5ControlRecordChain(inputRef, { sourceTree, buildEvidence }),
        'S5_CHAIN_ONTOLOGY_CLOSURE',
      );
    } finally {
      fs.rmSync(sourceTree, { recursive: true, force: true });
      fs.rmSync(buildEvidence, { recursive: true, force: true });
    }
  }
});

test('a source-row evidence digest cannot diverge from the byte-verified evidence closure', () => {
  const sourceTree = cloneSourceClosure();
  const buildEvidence = temporaryDirectory('axiolune-s5-source-evidence-digest-');
  try {
    const originalFile = path.join(
      sourceTree,
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source-snapshot-original.json',
    );
    const futureFile = path.join(
      sourceTree,
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source-snapshot-future.json',
    );
    const original = readJson(originalFile);
    const future = readJson(futureFile);
    original.rows[0].holding_source_artifact_digest = `sha256:${'0'.repeat(64)}`;
    future.rows[0].holding_source_artifact_digest = `sha256:${'0'.repeat(64)}`;
    writeJcs(originalFile, original);
    writeJcs(futureFile, future);
    expectCode(
      () => createS5ControlRecordChain(inputRef, { sourceTree, buildEvidence }),
      'S5_CHAIN_SUPPORT_EVIDENCE',
    );
  } finally {
    fs.rmSync(sourceTree, { recursive: true, force: true });
    fs.rmSync(buildEvidence, { recursive: true, force: true });
  }
});

test('valuation runtime substitution fails closed at the prior-support snapshot digest', () => {
  expectSourceClosureFailure(
    'axiolune-s5-valuation-runtime-substitution-',
    (sourceTree) => {
      const closureFile = path.join(
        sourceTree,
        'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/support-evidence-closure.json',
      );
      const closure = readJson(closureFile);
      const runtime = closure.entries.find((entry) => (
        entry.evidenceIri === 'urn:axiolune:evidence:slice-a:valuation-runtime:v1'
      ));
      runtime.artifactRef = {
        kind: 'path',
        path: 'scripts/domain/control-record-profile/s5-v1/capability-output-contract.json',
        root: 'sourceTree',
      };
      runtime.artifactDigest = fileDigest(sourceArtifactFile(sourceTree, runtime.artifactRef));
      writeJcs(closureFile, closure);
      for (const name of ['source-snapshot-original.json', 'source-snapshot-future.json']) {
        const snapshotFile = path.join(
          sourceTree,
          'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain',
          name,
        );
        const snapshot = readJson(snapshotFile);
        snapshot.rows.forEach((row) => { row.valuation_runtime_digest = runtime.artifactDigest; });
        writeJcs(snapshotFile, snapshot);
      }
    },
    'S5_CHAIN_PRIOR_SUPPORT',
  );
});

test('invalid rounding-policy semantics fail after every source digest is recomputed', () => {
  expectSourceClosureFailure(
    'axiolune-s5-rounding-policy-semantics-',
    (sourceTree) => {
      const policyFile = path.join(
        sourceTree,
        'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/valuation-rounding-policy.json',
      );
      const policy = readJson(policyFile);
      policy.stage = 'intermediateProduct';
      writeJcs(policyFile, policy);
      const digest = fileDigest(policyFile);
      const closureFile = path.join(
        sourceTree,
        'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/support-evidence-closure.json',
      );
      const closure = readJson(closureFile);
      closure.entries.find((entry) => (
        entry.evidenceIri === 'urn:axiolune:evidence:slice-a:valuation-rounding-policy:v1'
      )).artifactDigest = digest;
      writeJcs(closureFile, closure);
      for (const name of ['source-snapshot-original.json', 'source-snapshot-future.json']) {
        const snapshotFile = path.join(
          sourceTree,
          'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain',
          name,
        );
        const snapshot = readJson(snapshotFile);
        snapshot.rows.forEach((row) => { row.valuation_rounding_policy_digest = digest; });
        writeJcs(snapshotFile, snapshot);
      }
    },
    'S5_CHAIN_SUPPORT_EVIDENCE',
  );
});

test('a selected valuation input cannot diverge from its completed byte-locked input set', () => {
  const sourceTree = cloneSourceClosure();
  const buildEvidence = temporaryDirectory('axiolune-s5-valuation-input-set-');
  try {
    const originalFile = path.join(
      sourceTree,
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source-snapshot-original.json',
    );
    const futureFile = path.join(
      sourceTree,
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source-snapshot-future.json',
    );
    const original = readJson(originalFile);
    const future = readJson(futureFile);
    original.rows[0].price = '41.50';
    future.rows[0].price = '41.50';
    writeJcs(originalFile, original);
    writeJcs(futureFile, future);
    expectCode(
      () => createS5ControlRecordChain(inputRef, { sourceTree, buildEvidence }),
      'S5_CHAIN_SUPPORT_EVIDENCE',
    );
  } finally {
    fs.rmSync(sourceTree, { recursive: true, force: true });
    fs.rmSync(buildEvidence, { recursive: true, force: true });
  }
});

test('stable-source candidate binds every blob in one exact Git commit tree', () => {
  assert.equal(stableSummary.buildEvidenceBindingVerified, true);
  assert.equal(stableSummary.semanticEvidence, true);
  assert.equal(stableSummary.sourceTreeBindingKind, 'gitCommit');
  assert.equal(stableSummary.evidenceClass, 'stable-git-source-tree-control-record-chain');
  assert.equal(stableSummary.sourceCommitId, stableSelector.commitId);
  assert.equal(stableSummary.sourceTreeId, stableSelector.treeId);
  assert.equal(stableSummary.releaseEvidence, false);
  assert.equal(
    stableSummary.releaseLifecycleStatus,
    'pending-final-p0-p1-build-evidence-binding',
  );
  assert.ok(stableSummary.sourceTreeFileCount > baselineSummary.sourceTreeFileCount);
  assert.deepEqual(
    verifyS5ControlRecordChain({
      sourceTree: stableRepository,
      buildEvidence: stableDirectory,
    }),
    stableSummary,
  );
});

test('stable-source candidate CLI independently generates and verifies the binding', () => {
  const directory = temporaryDirectory('axiolune-s5-stable-cli-');
  try {
    let result = spawnSync(
      process.execPath,
      [
        'scripts/domain/run-s5-stable-source-chain.cjs',
        '--generate', directory,
        '--repository', stableRepository,
        '--commit', stableSelector.commitId,
      ],
      { cwd: ROOT, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const generated = JSON.parse(result.stdout);
    assert.equal(generated.sourceTreeBindingKind, 'gitCommit');
    result = spawnSync(
      process.execPath,
      [
        'scripts/domain/run-s5-stable-source-chain.cjs',
        '--verify', directory,
        '--repository', stableRepository,
      ],
      { cwd: ROOT, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), generated);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stable-source digest tamper is rejected after recomputing its outer JCS lock', () => {
  const directory = cloneStable();
  try {
    const manifestFile = path.join(directory, 'source-tree-manifest.json');
    const manifest = readJson(manifestFile);
    manifest.sourceTreeDigest = `sha256:${'0'.repeat(64)}`;
    writeJcs(manifestFile, manifest);
    const buildInputsFile = path.join(directory, 'build-inputs.json');
    const buildInputs = readJson(buildInputsFile);
    buildInputs.sourceTreeManifestDigest = taggedJcsDigest(
      'axiolune-source-tree-manifest-v1\0',
      manifest,
    );
    writeJcs(buildInputsFile, buildInputs);
    expectCode(
      () => verifyS5ControlRecordChain({
        sourceTree: stableRepository,
        buildEvidence: directory,
      }),
      'S5_CHAIN_SOURCE_TREE',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stable-source commit object substitution is rejected', () => {
  const directory = cloneStable();
  try {
    updateStableSelector(directory, (selector) => {
      selector.commitId = 'f'.repeat(40);
    });
    expectCode(
      () => verifyS5ControlRecordChain({
        sourceTree: stableRepository,
        buildEvidence: directory,
      }),
      'S5_CHAIN_SOURCE_SELECTOR',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stable-source commit/tree mismatch is rejected', () => {
  const directory = cloneStable();
  try {
    updateStableSelector(directory, (selector) => {
      selector.treeId = selector.commitId;
    });
    expectCode(
      () => verifyS5ControlRecordChain({
        sourceTree: stableRepository,
        buildEvidence: directory,
      }),
      'S5_CHAIN_SOURCE_SELECTOR',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Git revision expression cannot replace the full stable-source selector', () => {
  const directory = cloneStable();
  try {
    updateStableSelector(directory, (selector) => {
      selector.commitId = 'HEAD';
    });
    expectCode(
      () => verifyS5ControlRecordChain({
        sourceTree: stableRepository,
        buildEvidence: directory,
      }),
      'S5_CHAIN_SOURCE_SELECTOR',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stable Git replay rejects a changed tracked byte outside the CQ source closure', () => {
  const marker = path.join(stableRepository, 'release-candidate-marker.txt');
  const original = fs.readFileSync(marker);
  try {
    fs.writeFileSync(marker, 'tampered working tree byte\n');
    expectCode(
      () => verifyS5ControlRecordChain({
        sourceTree: stableRepository,
        buildEvidence: stableDirectory,
      }),
      'S5_CHAIN_SOURCE_TREE',
    );
  } finally {
    fs.writeFileSync(marker, original);
  }
});

test('record BuildEvidenceBinding cannot substitute the stable source-tree digest', () => {
  const directory = cloneStable();
  try {
    const record = readRecord(directory, 'identity-run');
    record.build.sourceTreeDigest = `sha256:${'a'.repeat(64)}`;
    record.resolvedInputDigest = resolvedInputDigest(record);
    writeRecord(directory, 'identity-run', record);
    expectCode(
      () => verifyS5ControlRecordChain({
        sourceTree: stableRepository,
        buildEvidence: directory,
      }),
      'S5_CHAIN_BUILD_BINDING',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('duplicate JSON members fail before JCS/ledger acceptance', () => {
  const directory = cloneBaseline();
  try {
    const file = path.join(directory, 'records', 'identity-report.json');
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(
      file,
      text.replace('"attemptId":"attempt-1"', '"attemptId":"attempt-1","attemptId":"attempt-1"'),
    );
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_JSON');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('non-JCS record bytes fail closed before ledger acceptance', () => {
  const directory = cloneBaseline();
  try {
    writeRecord(directory, 'identity-report', readRecord(directory, 'identity-report'), { trailingLf: true });
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_JCS');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('scalar ArtifactRef cannot replace the strict discriminated subjectRef', () => {
  const directory = cloneBaseline();
  try {
    const report = readRecord(directory, 'batch-report');
    report.subjectRef = 'buildEvidence:rdf/dataset-original.nq';
    report.resolvedInputDigest = resolvedInputDigest(report);
    writeRecord(directory, 'batch-report', report);
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_ARTIFACT_REF');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('URI cannot replace InputDatasetSnapshot.snapshotRef ArtifactRef', () => {
  const directory = cloneBaseline();
  try {
    const run = readRecord(directory, 'market-data-run');
    run.inputDatasets[0].snapshotRef = 'urn:axiolune:forged:snapshot';
    run.resolvedInputDigest = resolvedInputDigest(run);
    writeRecord(directory, 'market-data-run', run);
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_ARTIFACT_REF');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ArtifactRef cannot replace any M3 control-record IRI reference', () => {
  const cases = [
    ['market-data-run', (record) => { record.result.validationReportRef = { kind: 'path', root: 'buildEvidence', path: 'records/market-data-report.json' }; }],
    ['negative-run', (record) => { record.result.failureReportRef = { kind: 'path', root: 'buildEvidence', path: 'records/negative-report.json' }; }],
    ['batch-run', (record) => { record.result.validationReportRef = { kind: 'path', root: 'buildEvidence', path: 'records/batch-report.json' }; }],
    ['pit-request', (record) => { record.materializationContext.recordRef = { kind: 'path', root: 'buildEvidence', path: 'records/batch-run.json' }; }],
    ['pit-report', (record) => { record.requestRef = { kind: 'path', root: 'buildEvidence', path: 'records/pit-request.json' }; }],
    ['pit-report', (record) => { record.contextRef = { kind: 'path', root: 'buildEvidence', path: 'records/batch-run.json' }; }],
    ['replay-report', (record) => { record.originalContextRef = { kind: 'path', root: 'buildEvidence', path: 'records/batch-run.json' }; }],
  ];
  for (const [slotId, mutate] of cases) {
    const directory = cloneBaseline();
    try {
      const record = readRecord(directory, slotId);
      mutate(record);
      record.resolvedInputDigest = resolvedInputDigest(record);
      writeRecord(directory, slotId, record);
      expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_IRI');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('a missing control-record IRI target fails closed', () => {
  const directory = cloneBaseline();
  try {
    const run = readRecord(directory, 'market-data-run');
    run.result.validationReportRef = 'urn:axiolune:control:validationReport:missing';
    run.resolvedInputDigest = resolvedInputDigest(run);
    writeRecord(directory, 'market-data-run', run);
    expectCode(
      () => verifyS5ControlRecordChain(roots(directory)),
      'S5_CHAIN_RECORD_IRI_MISSING',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('duplicate control-record IRI with different JCS bytes/digest is rejected before joins', () => {
  const directory = cloneBaseline();
  try {
    const identityReport = readRecord(directory, 'identity-report');
    identityReport.iri = readRecord(directory, 'market-data-report').iri;
    identityReport.resolvedInputDigest = resolvedInputDigest(identityReport);
    writeRecord(directory, 'identity-report', identityReport);
    expectCode(
      () => verifyS5ControlRecordChain(roots(directory)),
      'S5_CHAIN_CONTROL_COLLISION',
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('GateCheck inputDigests cannot omit the exact report input closure', () => {
  const directory = cloneBaseline();
  try {
    const report = readRecord(directory, 'identity-report');
    report.result.checks[0].inputDigests = [];
    report.resolvedInputDigest = resolvedInputDigest(report);
    writeRecord(directory, 'identity-report', report);
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_GATE_EVIDENCE');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('GateCheck evidence cannot diverge from report kindEvidence', () => {
  const directory = cloneBaseline();
  try {
    const report = readRecord(directory, 'identity-report');
    const substitute = path.join(directory, 'rdf', 'dataset-replay.nq');
    report.result.checks[0].evidenceRef = {
      kind: 'path',
      root: 'buildEvidence',
      path: 'rdf/dataset-replay.nq',
    };
    report.result.checks[0].evidenceDigest = `sha256:${require('crypto')
      .createHash('sha256').update(fs.readFileSync(substitute)).digest('hex')}`;
    report.resolvedInputDigest = resolvedInputDigest(report);
    writeRecord(directory, 'identity-report', report);
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_GATE_EVIDENCE');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('PIT knowledge/availability after referenceTime fails closed', () => {
  const directory = cloneBaseline();
  try {
    const request = readRecord(directory, 'pit-request');
    request.asOfAvailable = '2024-07-11T00:00:00Z';
    request.resolvedInputDigest = resolvedInputDigest(request);
    writeRecord(directory, 'pit-request', request);
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_FUTURE_PIVOT');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('PIT context record digest substitution is rejected', () => {
  const directory = cloneBaseline();
  try {
    const request = readRecord(directory, 'pit-request');
    request.materializationContext.recordDigest = `sha256:${'a'.repeat(64)}`;
    request.resolvedInputDigest = resolvedInputDigest(request);
    writeRecord(directory, 'pit-request', request);
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_RECORD_DIGEST');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('future challenge RDF semantic mutation is rejected by independent producer replay', () => {
  const directory = cloneBaseline();
  try {
    const file = path.join(directory, 'rdf', 'dataset-future-append-challenge.nq');
    const bytes = fs.readFileSync(file, 'utf8').replace('"42.50"', '"43.00"');
    fs.writeFileSync(file, bytes);
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_PRODUCER_REPLAY');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('portfolio valuation RDF semantic mutation is rejected by report-evidence closure', () => {
  const directory = cloneBaseline();
  try {
    const file = path.join(directory, 'rdf', 'dataset-original.nq');
    const original = fs.readFileSync(file, 'utf8');
    const bytes = original.replace(
      '"425.00"^^<http://www.w3.org/2001/XMLSchema#decimal>',
      '"426.00"^^<http://www.w3.org/2001/XMLSchema#decimal>',
    );
    assert.notEqual(bytes, original);
    fs.writeFileSync(file, bytes);
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_GATE_EVIDENCE');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stored derived-value substitution across replay datasets cannot cross report evidence', () => {
  const directory = cloneBaseline();
  try {
    for (const name of [
      'dataset-original.nq',
      'dataset-replay.nq',
      'dataset-future-append-challenge.nq',
    ]) {
      const file = path.join(directory, 'rdf', name);
      const original = fs.readFileSync(file, 'utf8');
      const changed = original.replace(
        '"425.00"^^<http://www.w3.org/2001/XMLSchema#decimal>',
        '"426.00"^^<http://www.w3.org/2001/XMLSchema#decimal>',
      );
      assert.notEqual(changed, original, name);
      fs.writeFileSync(file, changed);
    }
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_GATE_EVIDENCE');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stored prior-support bytes are rejoined to the canonical prior chain during replay', () => {
  const directory = cloneBaseline();
  try {
    const file = path.join(directory, 'rdf', 'prior-support-input.nq');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(
      file,
      `${original}<urn:axiolune:tamper:support> <urn:axiolune:tamper:predicate> "1" <${SUPPORT_GRAPH_IRI}> .\n`,
    );
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_PRIOR_SUPPORT');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('caller-authored equal ReplayComparison digests cannot replace recomputation', () => {
  const directory = cloneBaseline();
  try {
    const replay = readRecord(directory, 'replay-report');
    const comparison = replay.result.comparisons.find((entry) => entry.name === 'batchDataset');
    comparison.originalDigest = `sha256:${'b'.repeat(64)}`;
    comparison.replayDigest = comparison.originalDigest;
    replay.resolvedInputDigest = resolvedInputDigest(replay);
    writeRecord(directory, 'replay-report', replay);
    const replayBytes = fs.readFileSync(path.join(directory, 'records', 'replay-report.json'));
    const replayRecordDigest = `sha256:${require('crypto').createHash('sha256')
      .update(replayBytes).digest('hex')}`;
    const ledger = readRecord(directory, 'evidence-ledger');
    const ledgerEntry = ledger.entries.find((entry) => entry.slotId === 'replay-report');
    ledgerEntry.byteLength = replayBytes.length;
    ledgerEntry.recordDigest = replayRecordDigest;
    ledger.resolvedInputDigest = resolvedInputDigest(ledger);
    writeRecord(directory, 'evidence-ledger', ledger);
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_REPLAY_RESULT');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ValidationReport cannot substitute another exact source artifact for the locked capability', () => {
  const directory = cloneBaseline();
  try {
    const report = readRecord(directory, 'identity-report');
    const substitutedRef = {
      kind: 'path', root: 'sourceTree', path: 'scripts/domain/lib/rdfc-1.0.cjs',
    };
    const substitutedDigest = `sha256:${require('crypto').createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, 'scripts/domain/lib/rdfc-1.0.cjs'))).digest('hex')}`;
    report.capabilityRef = substitutedRef;
    report.capabilityDigest = substitutedDigest;
    report.result.checks[0].capabilityRef = substitutedRef;
    report.result.checks[0].capabilityDigest = substitutedDigest;
    report.resolvedInputDigest = resolvedInputDigest(report);
    writeRecord(directory, 'identity-report', report);
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_TOOL_LOCK');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('inactive outcome alternative cannot alias an active control-record IRI', () => {
  const directory = cloneBaseline();
  try {
    const active = readRecord(directory, 'identity-report');
    active.slotId = 'identity-failed';
    writeRecord(directory, 'identity-failed', active);
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_CONTROL_COLLISION');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('failure result and FailureReport errors must remain byte-identical', () => {
  const directory = cloneBaseline();
  try {
    const report = readRecord(directory, 'negative-report');
    report.errors[0].message = 'Tampered failure message.';
    report.resolvedInputDigest = resolvedInputDigest(report);
    writeRecord(directory, 'negative-report', report);
    const reportBytes = fs.readFileSync(path.join(directory, 'records', 'negative-report.json'));
    const reportDigest = `sha256:${require('crypto').createHash('sha256').update(reportBytes).digest('hex')}`;
    const run = readRecord(directory, 'negative-run');
    run.result.failureReportDigest = reportDigest;
    run.resolvedInputDigest = resolvedInputDigest(run);
    writeRecord(directory, 'negative-run', run);
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_FAILURE_BINDING');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ledger selection/entry set cannot omit an active finalized record', () => {
  const directory = cloneBaseline();
  try {
    const ledger = readRecord(directory, 'evidence-ledger');
    ledger.entries = ledger.entries.filter((entry) => entry.slotId !== 'replay-report');
    ledger.resolvedInputDigest = resolvedInputDigest(ledger);
    writeRecord(directory, 'evidence-ledger', ledger);
    expectCode(() => verifyS5ControlRecordChain(roots(directory)), 'S5_CHAIN_LEDGER');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
