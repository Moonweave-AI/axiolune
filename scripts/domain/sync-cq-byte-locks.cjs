#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual, TextDecoder } = require('node:util');
const YAML = require('yaml');

const {
  parseJsonRejectingDuplicateMembers,
} = require('./lib/json-pointer-source-extractor.cjs');
const {
  canonicalJcs,
} = require('./lib/strict-source-locator.cjs');
const {
  createOutputs: createS5ProfileOutputs,
} = require('./generate-s5-control-record-profile.cjs');
const {
  NEGATIVE_FILE: MARKET_DATA_NEGATIVE_FILE,
  loadMarketDataCqMatrix,
} = require('./lib/market-data-cq-matrix.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const ROOT_REAL = fs.realpathSync(ROOT);
const PACKAGE_LOCK_REF = 'package-lock.json';
const LEGACY_S5_TOOL_LOCK_REF =
  'tests/m2/fixtures/slice-a/cq-v03/s5/toolchain.lock.json';
const CROSS_MODULE_S5_CONTRACT_REF =
  'tests/m2/fixtures/slice-a/cq-v03/cross-module-s5-contract.yaml';
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

class CqByteLockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CqByteLockError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CqByteLockError(code, message);
}

function normalizeRepositoryRef(ref, label = 'repository ref') {
  if (typeof ref !== 'string' || ref.length === 0) {
    fail('CQ_LOCK_REF', `${label} must be a non-empty string`);
  }
  if (ref.includes('\\') || path.posix.isAbsolute(ref)) {
    fail('CQ_LOCK_REF', `${label} must be a repository-relative POSIX path`);
  }
  const normalized = path.posix.normalize(ref);
  if (normalized !== ref || normalized === '..' || normalized.startsWith('../')) {
    fail('CQ_LOCK_REF', `${label} is not a canonical repository-relative path: ${ref}`);
  }
  return ref;
}

function repositoryAbsolute(ref) {
  normalizeRepositoryRef(ref);
  const absolute = path.join(ROOT, ...ref.split('/'));
  const relative = path.relative(ROOT, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('CQ_LOCK_REF', `repository ref escapes the source tree: ${ref}`);
  }
  return absolute;
}

function diskBytes(ref) {
  const absolute = repositoryAbsolute(ref);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    fail('CQ_LOCK_FILE', `locked repository file is missing or not a file: ${ref}`);
  }
  const real = fs.realpathSync(absolute);
  const relative = path.relative(ROOT_REAL, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('CQ_LOCK_REF', `locked repository file resolves outside the source tree: ${ref}`);
  }
  return fs.readFileSync(real);
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  fail('CQ_LOCK_BYTES', `${label} must be bytes or a UTF-8 string`);
}

function createReader(staged, sourceOverrides = new Map()) {
  for (const [ref, bytes] of sourceOverrides) {
    normalizeRepositoryRef(ref, 'source override ref');
    sourceOverrides.set(ref, asBuffer(bytes, `source override ${ref}`));
  }
  return (ref) => {
    normalizeRepositoryRef(ref);
    if (staged.has(ref)) return staged.get(ref);
    if (sourceOverrides.has(ref)) return sourceOverrides.get(ref);
    return diskBytes(ref);
  };
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CQ_LOCK_SCHEMA', `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!isDeepStrictEqual(actual, wanted)) {
    fail(
      'CQ_LOCK_SCHEMA',
      `${label} keys must be exactly ${wanted.join(',')}; found ${actual.join(',')}`,
    );
  }
}

function assertExactArray(actual, expected, label) {
  if (!Array.isArray(actual) || !isDeepStrictEqual(actual, expected)) {
    fail(
      'CQ_LOCK_INVENTORY',
      `${label} must be exactly ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}`,
    );
  }
}

function strictJson(bytes, label) {
  let text;
  try {
    text = UTF8_FATAL.decode(bytes);
  } catch (error) {
    fail('CQ_LOCK_JSON', `${label} is not UTF-8: ${error.message}`);
  }
  try {
    return parseJsonRejectingDuplicateMembers(text);
  } catch (error) {
    fail('CQ_LOCK_JSON', `${label} is not strict JSON: ${error.message}`);
  }
}

function buildLegacyS5ToolLock(read) {
  const toolLock = strictJson(read(LEGACY_S5_TOOL_LOCK_REF), LEGACY_S5_TOOL_LOCK_REF);
  assertExactKeys(toolLock, ['schemaVersion', 'tools'], 'legacy S5 tool lock');
  if (toolLock.schemaVersion !== '1.0' || !Array.isArray(toolLock.tools)) {
    fail('CQ_LOCK_SCHEMA', 'legacy S5 tool lock schemaVersion/tools are invalid');
  }
  assertExactArray(
    toolLock.tools.map((tool) => tool?.toolId),
    ['cross-module-cq', 'rdf-canonize'],
    'legacy S5 tool inventory',
  );

  const crossModule = toolLock.tools[0];
  assertExactKeys(
    crossModule,
    ['implementation', 'toolId', 'version'],
    'legacy S5 cross-module tool',
  );
  assertExactKeys(
    crossModule.implementation,
    ['artifactDigest', 'artifactRef'],
    'legacy S5 cross-module implementation',
  );
  if (
    crossModule.version !== 'axiolune-m2-cq-cross-module/v1'
    || crossModule.implementation.artifactRef !== 'scripts/domain/lib/cross-module-cq.cjs'
  ) {
    fail('CQ_LOCK_INVENTORY', 'legacy S5 cross-module implementation identity drift');
  }

  const rdfCanonize = toolLock.tools[1];
  assertExactKeys(
    rdfCanonize,
    ['adapter', 'algorithm', 'dependencyLock', 'toolId', 'version', 'worker'],
    'legacy S5 rdf-canonize tool',
  );
  for (const [field, expectedRef] of [
    ['adapter', 'scripts/domain/lib/rdfc-1.0.cjs'],
    ['dependencyLock', PACKAGE_LOCK_REF],
    ['worker', 'scripts/domain/lib/rdfc-1.0-worker.cjs'],
  ]) {
    assertExactKeys(
      rdfCanonize[field],
      ['artifactDigest', 'artifactRef'],
      `legacy S5 rdf-canonize ${field}`,
    );
    if (rdfCanonize[field].artifactRef !== expectedRef) {
      fail(
        'CQ_LOCK_INVENTORY',
        `legacy S5 rdf-canonize ${field} must reference ${expectedRef}`,
      );
    }
  }
  if (rdfCanonize.algorithm !== 'RDFC-1.0' || rdfCanonize.version !== '5.0.0') {
    fail('CQ_LOCK_INVENTORY', 'legacy S5 rdf-canonize algorithm/version drift');
  }

  crossModule.implementation.artifactDigest = sha256(
    read(crossModule.implementation.artifactRef),
  );
  for (const field of ['adapter', 'dependencyLock', 'worker']) {
    rdfCanonize[field].artifactDigest = sha256(read(rdfCanonize[field].artifactRef));
  }
  return Buffer.from(`${canonicalJcs(toolLock)}\n`, 'utf8');
}

function yamlDocument(bytes, ref) {
  const text = bytes.toString('utf8');
  const document = YAML.parseDocument(text, {
    keepSourceTokens: true,
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    fail('CQ_LOCK_YAML', `${ref}: ${document.errors.map((error) => error.message).join('; ')}`);
  }
  return { document, text };
}

function scalarAt(document, pathSegments, label) {
  const node = document.getIn(pathSegments, true);
  if (!YAML.isScalar(node) || typeof node.value !== 'string' || !Array.isArray(node.range)) {
    fail('CQ_LOCK_SCHEMA', `${label} must be a source-backed YAML string scalar`);
  }
  return node;
}

function sequenceAt(document, pathSegments, label) {
  const node = document.getIn(pathSegments, true);
  if (!YAML.isSeq(node)) fail('CQ_LOCK_SCHEMA', `${label} must be a YAML sequence`);
  return node;
}

function queueScalarReplacement(replacements, node, value, label) {
  const [start, end] = node.range;
  const previous = replacements.get(start);
  if (previous && (previous.end !== end || previous.value !== value)) {
    fail('CQ_LOCK_OVERLAP', `${label} conflicts with another scalar replacement`);
  }
  replacements.set(start, { end, value });
}

function replaceScalars(text, replacements) {
  let output = text;
  const ordered = [...replacements.entries()].sort(([left], [right]) => right - left);
  let nextStart = text.length;
  for (const [start, replacement] of ordered) {
    if (replacement.end > nextStart) fail('CQ_LOCK_OVERLAP', 'YAML scalar replacements overlap');
    output = output.slice(0, start) + replacement.value + output.slice(replacement.end);
    nextStart = start;
  }
  return Buffer.from(output, 'utf8');
}

function updateYamlFile(sourceRef, read, configure) {
  const { document, text } = yamlDocument(read(sourceRef), sourceRef);
  const replacements = new Map();

  function expectScalar(pathSegments, expected, label) {
    const node = scalarAt(document, pathSegments, label);
    if (node.value !== expected) {
      fail('CQ_LOCK_INVENTORY', `${label} must be ${expected}; found ${String(node.value)}`);
    }
    return node;
  }

  function setScalar(pathSegments, value, label) {
    const node = scalarAt(document, pathSegments, label);
    queueScalarReplacement(replacements, node, value, label);
  }

  function updateFilePair(basePath, refField, digestField, expectedRef, label) {
    expectScalar([...basePath, refField], expectedRef, `${label} ref`);
    setScalar([...basePath, digestField], sha256(read(expectedRef)), `${label} digest`);
  }

  function updateRefDigestList(basePath, expectedRefs, label) {
    const sequence = sequenceAt(document, basePath, label);
    const actualRefs = sequence.items.map((unused, index) => (
      scalarAt(document, [...basePath, index, 'ref'], `${label}[${index}].ref`).value
    ));
    assertExactArray(actualRefs, expectedRefs, label);
    for (const [index, ref] of actualRefs.entries()) {
      const item = document.getIn([...basePath, index], true);
      if (!YAML.isMap(item)) fail('CQ_LOCK_SCHEMA', `${label}[${index}] must be a map`);
      const keys = item.items.map((pair) => pair.key?.value).sort();
      assertExactArray(keys, ['digest', 'ref'], `${label}[${index}] keys`);
      setScalar([...basePath, index, 'digest'], sha256(read(ref)), `${label}[${index}].digest`);
    }
  }

  configure({
    document,
    expectScalar,
    setScalar,
    updateFilePair,
    updateRefDigestList,
  });
  return replaceScalars(text, replacements);
}

const CARD_SPECS = [
  {
    ref: 'docs/ontology/competency-questions/fin-foundation-cq.yaml',
    template: 'executionContract',
    functionVersion: 'axiolune-m2-cq-foundation-market-instrument/v1',
    fixed: [
      ['implementation', 'implementationDigest', 'scripts/domain/lib/foundation-market-instrument-cq.cjs'],
      ['graphFixture', 'graphFixtureDigest', 'tests/m2/fixtures/slice-a/cq-v03/foundation-market-instrument-graph.yaml'],
      ['positiveFixture', 'positiveFixtureDigest', 'tests/m2/fixtures/slice-a/cq-v03/foundation-market-instrument-positive.yaml'],
      ['negativeFixture', 'negativeFixtureDigest', 'tests/m2/fixtures/slice-a/cq-v03/foundation-market-instrument-negative.yaml'],
    ],
    dependencies: [
      'scripts/domain/lib/identity-contract-compiler.cjs',
      'scripts/domain/lib/strict-source-locator.cjs',
    ],
    artifacts: [
      'scripts/domain/reference-extractors/whole-file-v1.json',
      'tests/m2/fixtures/slice-a/positive-market-instrument-contract.yaml',
      'tests/m2/fixtures/slice-a/source.txt',
    ],
  },
  {
    ref: 'docs/ontology/competency-questions/fin-market-structure-cq.yaml',
    template: 'executionContract',
    functionVersion: 'axiolune-m2-cq-foundation-market-instrument/v1',
    fixed: [
      ['implementation', 'implementationDigest', 'scripts/domain/lib/foundation-market-instrument-cq.cjs'],
      ['graphFixture', 'graphFixtureDigest', 'tests/m2/fixtures/slice-a/cq-v03/foundation-market-instrument-graph.yaml'],
      ['positiveFixture', 'positiveFixtureDigest', 'tests/m2/fixtures/slice-a/cq-v03/foundation-market-instrument-positive.yaml'],
      ['negativeFixture', 'negativeFixtureDigest', 'tests/m2/fixtures/slice-a/cq-v03/foundation-market-instrument-negative.yaml'],
    ],
    dependencies: [
      'scripts/domain/lib/identity-contract-compiler.cjs',
      'scripts/domain/lib/strict-source-locator.cjs',
    ],
    artifacts: [
      'scripts/domain/reference-extractors/whole-file-v1.json',
      'tests/m2/fixtures/slice-a/positive-market-instrument-contract.yaml',
      'tests/m2/fixtures/slice-a/source.txt',
    ],
  },
  {
    ref: 'docs/ontology/competency-questions/fin-instruments-cq.yaml',
    template: 'executionContract',
    functionVersion: 'axiolune-m2-cq-foundation-market-instrument/v1',
    fixed: [
      ['implementation', 'implementationDigest', 'scripts/domain/lib/foundation-market-instrument-cq.cjs'],
      ['graphFixture', 'graphFixtureDigest', 'tests/m2/fixtures/slice-a/cq-v03/foundation-market-instrument-graph.yaml'],
      ['positiveFixture', 'positiveFixtureDigest', 'tests/m2/fixtures/slice-a/cq-v03/foundation-market-instrument-positive.yaml'],
      ['negativeFixture', 'negativeFixtureDigest', 'tests/m2/fixtures/slice-a/cq-v03/foundation-market-instrument-negative.yaml'],
    ],
    dependencies: [
      'scripts/domain/lib/identity-contract-compiler.cjs',
      'scripts/domain/lib/strict-source-locator.cjs',
    ],
    artifacts: [
      'scripts/domain/reference-extractors/whole-file-v1.json',
      'tests/m2/fixtures/slice-a/positive-market-instrument-contract.yaml',
      'tests/m2/fixtures/slice-a/source.txt',
    ],
  },
  {
    ref: 'docs/ontology/competency-questions/fin-market-data-cq.yaml',
    template: 'executionTemplate',
    functionVersion: 'market-data-cq/v0.3.0',
    fixed: [
      ['implementation', 'implementationDigest', 'scripts/domain/lib/market-data-cq.cjs'],
      ['matrixImplementation', 'matrixImplementationDigest', 'scripts/domain/lib/market-data-cq-matrix.cjs'],
      ['graphFixture', 'graphFixtureDigest', 'tests/m2/fixtures/market-data-v03/positive-complete.yaml'],
      ['positiveFixture', 'positiveFixtureDigest', 'tests/m2/fixtures/market-data-v03/cq/positive.yaml'],
      ['negativeFixture', 'negativeFixtureDigest', 'tests/m2/fixtures/market-data-v03/cq/negative.yaml'],
    ],
    dependencies: [
      'scripts/domain/lib/decimal-lexical.cjs',
      'scripts/domain/lib/json-pointer-source-extractor.cjs',
      'scripts/domain/lib/market-data-release-evidence.cjs',
      'scripts/domain/lib/market-data-v03-contracts.cjs',
      'scripts/domain/lib/strict-fixture-loader.cjs',
      'scripts/domain/lib/strict-source-locator.cjs',
      'scripts/domain/lib/whole-file-source-extractor.cjs',
    ],
    artifacts: [],
    marketDataFixtureLocks: true,
  },
  {
    ref: 'docs/ontology/competency-questions/fin-orders-execution-cq.yaml',
    template: 'joinedExecution',
    functionVersion: 'axiolune-m2-cq-orders-portfolio/v1',
    fixed: [
      ['implementation', 'implementationDigest', 'scripts/domain/lib/orders-portfolio-cq.cjs'],
      ['graphFixture', 'graphFixtureDigest', 'tests/m2/fixtures/orders-portfolio-cq/graph.yaml'],
      ['positiveFixture', 'positiveFixtureDigest', 'tests/m2/fixtures/orders-portfolio-cq/positive.yaml'],
      ['negativeFixture', 'negativeFixtureDigest', 'tests/m2/fixtures/orders-portfolio-cq/negative.yaml'],
    ],
    dependencies: [
      'scripts/domain/lib/orders-portfolio-exact-arithmetic.cjs',
      'scripts/domain/lib/strict-fixture-loader.cjs',
      'scripts/domain/lib/strict-source-locator.cjs',
    ],
    artifacts: ['tests/m2/fixtures/orders-portfolio-cq/source-records.yaml'],
  },
  {
    ref: 'docs/ontology/competency-questions/fin-portfolio-positions-cq.yaml',
    template: 'joinedExecution',
    functionVersion: 'axiolune-m2-cq-orders-portfolio/v1',
    fixed: [
      ['implementation', 'implementationDigest', 'scripts/domain/lib/orders-portfolio-cq.cjs'],
      ['graphFixture', 'graphFixtureDigest', 'tests/m2/fixtures/orders-portfolio-cq/graph.yaml'],
      ['positiveFixture', 'positiveFixtureDigest', 'tests/m2/fixtures/orders-portfolio-cq/positive.yaml'],
      ['negativeFixture', 'negativeFixtureDigest', 'tests/m2/fixtures/orders-portfolio-cq/negative.yaml'],
    ],
    dependencies: [
      'scripts/domain/lib/orders-portfolio-exact-arithmetic.cjs',
      'scripts/domain/lib/strict-fixture-loader.cjs',
      'scripts/domain/lib/strict-source-locator.cjs',
    ],
    artifacts: ['tests/m2/fixtures/orders-portfolio-cq/source-records.yaml'],
  },
  {
    ref: 'docs/ontology/competency-questions/fin-cross-module-cq.yaml',
    template: 'executionContract',
    functionVersion: 'axiolune-m2-cq-cross-module/v1',
    fixed: [
      ['implementation', 'implementationDigest', 'scripts/domain/lib/cross-module-cq.cjs'],
      ['graphFixture', 'graphFixtureDigest', 'tests/m2/fixtures/slice-a/cq-v03/foundation-market-instrument-graph.yaml'],
      ['positiveFixture', 'positiveFixtureDigest', 'tests/m2/fixtures/slice-a/cq-v03/cross-module-positive.yaml'],
      ['negativeFixture', 'negativeFixtureDigest', 'tests/m2/fixtures/slice-a/cq-v03/cross-module-negative.yaml'],
      ['replayContractFixture', 'replayContractFixtureDigest', CROSS_MODULE_S5_CONTRACT_REF],
      ['replayNegativeFixture', 'replayNegativeFixtureDigest', 'tests/m2/fixtures/slice-a/cq-v03/cross-module-s5-negative.yaml'],
      ['toolchainLock', 'toolchainLockDigest', LEGACY_S5_TOOL_LOCK_REF],
      ['s5ControlChainInput', 's5ControlChainInputDigest', 'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/control-chain-input.json'],
      ['s5ControlRecordSchemaManifest', 's5ControlRecordSchemaManifestDigest', 'scripts/domain/control-record-profile/s5-v1/control-record-schema-manifest.json'],
      ['s5ControlRecordToolchainLock', 's5ControlRecordToolchainLockDigest', 'scripts/domain/control-record-profile/s5-v1/toolchain.lock.json'],
    ],
    dependencies: [
      'scripts/domain/lib/foundation-market-instrument-cq.cjs',
      'scripts/domain/lib/json-pointer-source-extractor.cjs',
      'scripts/domain/lib/rdfc-1.0.cjs',
      'scripts/domain/lib/rdfc-1.0-worker.cjs',
      'scripts/domain/lib/s5-control-record-chain.cjs',
      'scripts/domain/lib/strict-fixture-loader.cjs',
      'scripts/domain/lib/strict-source-locator.cjs',
    ],
    artifacts: [],
    stableSourceCandidateEntrypoint: 'scripts/domain/run-s5-stable-source-chain.cjs',
  },
];

function marketDataFixtureRefsByCq() {
  const matrix = loadMarketDataCqMatrix();
  const result = new Map();
  for (const entry of matrix.cases.values()) {
    if (entry.polarity !== 'negative' || entry.kind !== 'fixture') continue;
    const absolute = path.resolve(path.dirname(MARKET_DATA_NEGATIVE_FILE), entry.fixture);
    const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
    normalizeRepositoryRef(relative, `${entry.caseId} fixture ref`);
    if (!result.has(entry.cqId)) result.set(entry.cqId, new Set());
    result.get(entry.cqId).add(relative);
  }
  return new Map([...result].map(([cqId, refs]) => [cqId, [...refs]]));
}

function buildCard(specification, read) {
  const fixtureRefsByCq = specification.marketDataFixtureLocks
    ? marketDataFixtureRefsByCq()
    : null;
  return updateYamlFile(specification.ref, read, ({
    document,
    expectScalar,
    setScalar,
    updateFilePair,
    updateRefDigestList,
  }) => {
    const base = [specification.template];
    expectScalar([...base, 'functionVersion'], specification.functionVersion,
      `${specification.ref} functionVersion`);
    for (const [refField, digestField, expectedRef] of specification.fixed) {
      updateFilePair(base, refField, digestField, expectedRef,
        `${specification.ref} ${refField}`);
    }
    updateRefDigestList(
      [...base, 'dependencyLocks'],
      specification.dependencies,
      `${specification.ref} dependencyLocks`,
    );
    if (specification.artifacts.length > 0) {
      updateRefDigestList(
        [...base, 'artifactLocks'],
        specification.artifacts,
        `${specification.ref} artifactLocks`,
      );
    } else if (document.hasIn([...base, 'artifactLocks'])) {
      fail('CQ_LOCK_INVENTORY', `${specification.ref} has an unexpected artifactLocks list`);
    }
    expectScalar([...base, 'runtime', 'engine'], 'node', `${specification.ref} runtime engine`);
    expectScalar(
      [...base, 'runtime', 'dependencyLock'],
      PACKAGE_LOCK_REF,
      `${specification.ref} runtime dependencyLock`,
    );
    setScalar([...base, 'runtime', 'version'], process.version, `${specification.ref} runtime version`);
    setScalar(
      [...base, 'runtime', 'dependencyLockDigest'],
      sha256(read(PACKAGE_LOCK_REF)),
      `${specification.ref} runtime dependencyLockDigest`,
    );

    if (specification.stableSourceCandidateEntrypoint) {
      const cqs = sequenceAt(document, ['cqs'], `${specification.ref} cqs`);
      const matches = cqs.items
        .map((unused, index) => ({
          id: scalarAt(document, ['cqs', index, 'id'], `cqs[${index}].id`).value,
          index,
        }))
        .filter((entry) => entry.id === 'CQ-S5');
      if (matches.length !== 1) {
        fail('CQ_LOCK_INVENTORY', `${specification.ref} must contain exactly one CQ-S5 row`);
      }
      updateFilePair(
        ['cqs', matches[0].index, 'stableSourceTreeCandidate'],
        'entrypoint',
        'entrypointDigest',
        specification.stableSourceCandidateEntrypoint,
        `${specification.ref} CQ-S5 stable source candidate`,
      );
    }

    if (!fixtureRefsByCq) return;
    const cqs = sequenceAt(document, ['cqs'], `${specification.ref} cqs`);
    const seen = new Set();
    for (const [index] of cqs.items.entries()) {
      const cqId = scalarAt(document, ['cqs', index, 'id'], `cqs[${index}].id`).value;
      if (seen.has(cqId)) fail('CQ_LOCK_INVENTORY', `${specification.ref} duplicates ${cqId}`);
      seen.add(cqId);
      const expected = fixtureRefsByCq.get(cqId) || [];
      updateRefDigestList(
        ['cqs', index, 'execution', 'fixtureLocks'],
        expected,
        `${specification.ref} ${cqId} fixtureLocks`,
      );
    }
    assertExactArray(
      [...seen].sort(),
      [...fixtureRefsByCq.keys()].sort(),
      `${specification.ref} executable CQ inventory`,
    );
  });
}

function buildCrossModuleS5Contract(read) {
  return updateYamlFile(CROSS_MODULE_S5_CONTRACT_REF, read, ({ updateFilePair }) => {
    const root = ['fixedInputs'];
    for (const [base, refField, digestField, expectedRef] of [
      [['batchDefinition'], 'artifactRef', 'artifactDigest', 'tests/m2/fixtures/slice-a/cq-v03/s5/batch-definition.json'],
      [['sourceSnapshot'], 'snapshotRef', 'artifactDigest', 'tests/m2/fixtures/slice-a/cq-v03/s5/source-snapshot.json'],
      [['sourceSnapshot'], 'schemaRef', 'schemaDigest', 'tests/m2/fixtures/slice-a/cq-v03/s5/source-schema.json'],
      [['mappings', 0], 'mappingArtifactRef', 'mappingSourceDigest', 'tests/m2/fixtures/slice-a/cq-v03/s5/identity-mapping.json'],
      [['mappings', 0], 'transformationClosureRef', 'transformationClosureDigest', 'tests/m2/fixtures/slice-a/cq-v03/s5/identity-transformation-closure.json'],
      [['mappings', 1], 'mappingArtifactRef', 'mappingSourceDigest', 'tests/m2/fixtures/slice-a/cq-v03/s5/market-data-mapping.json'],
      [['mappings', 1], 'transformationClosureRef', 'transformationClosureDigest', 'tests/m2/fixtures/slice-a/cq-v03/s5/market-data-transformation-closure.json'],
      [['toolLock'], 'artifactRef', 'artifactDigest', LEGACY_S5_TOOL_LOCK_REF],
      [['originalDataset'], 'artifactRef', 'artifactDigest', 'tests/m2/fixtures/slice-a/cq-v03/s5/dataset-original.nq'],
      [['replayDataset'], 'artifactRef', 'artifactDigest', 'tests/m2/fixtures/slice-a/cq-v03/s5/dataset-replay.nq'],
    ]) {
      updateFilePair([...root, ...base], refField, digestField, expectedRef,
        `${CROSS_MODULE_S5_CONTRACT_REF} ${base.join('.')}`);
    }
  });
}

function createOutputs(options = {}) {
  const staged = new Map();
  const sourceOverrides = options.sourceOverrides || new Map();
  const read = createReader(staged, new Map(sourceOverrides));

  for (const [ref, bytes] of createS5ProfileOutputs()) {
    staged.set(ref, asBuffer(bytes, `S5 generated output ${ref}`));
  }

  staged.set(LEGACY_S5_TOOL_LOCK_REF, buildLegacyS5ToolLock(read));
  staged.set(CROSS_MODULE_S5_CONTRACT_REF, buildCrossModuleS5Contract(read));
  for (const specification of CARD_SPECS) {
    staged.set(specification.ref, buildCard(specification, read));
  }
  return staged;
}

function checkOutputs(outputs) {
  const drift = [];
  for (const [ref, expected] of outputs) {
    const absolute = repositoryAbsolute(ref);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      drift.push(`${ref}: missing`);
      continue;
    }
    const actual = fs.readFileSync(absolute);
    if (!actual.equals(expected)) {
      drift.push(`${ref}: byte drift (expected ${sha256(expected)}, actual ${sha256(actual)})`);
    }
  }
  return drift;
}

function writeOutputs(outputs) {
  for (const [ref, bytes] of outputs) {
    const absolute = repositoryAbsolute(ref);
    if (fs.existsSync(absolute)) {
      if (fs.lstatSync(absolute).isSymbolicLink()) {
        fail('CQ_LOCK_WRITE_TARGET', `refuses to replace a symbolic-link output: ${ref}`);
      }
      diskBytes(ref);
    } else {
      let existingParent = path.dirname(absolute);
      while (!fs.existsSync(existingParent)) existingParent = path.dirname(existingParent);
      const realParent = fs.realpathSync(existingParent);
      const relative = path.relative(ROOT_REAL, realParent);
      if (
        relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
      ) {
        fail('CQ_LOCK_WRITE_TARGET', `output parent resolves outside the source tree: ${ref}`);
      }
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
  }
}

function main() {
  const mode = process.argv[2] || '--check';
  if (!['--check', '--write'].includes(mode) || process.argv.length > 3) {
    fail('CQ_LOCK_USAGE', 'usage: node scripts/domain/sync-cq-byte-locks.cjs [--check|--write]');
  }
  const outputs = createOutputs();
  if (mode === '--write') {
    writeOutputs(outputs);
    const verifiedOutputs = createOutputs();
    const drift = checkOutputs(verifiedOutputs);
    if (drift.length > 0) {
      fail(
        'CQ_LOCK_POST_WRITE',
        `post-write closure verification failed:\n${drift.join('\n')}`,
      );
    }
    process.stdout.write(
      `WROTE ${outputs.size} deterministic non-PTO CQ/S5 byte-lock artifacts; post-write check PASS\n`,
    );
    return;
  }
  const drift = checkOutputs(outputs);
  if (drift.length > 0) {
    process.stderr.write(`${drift.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`PASS ${outputs.size} deterministic non-PTO CQ/S5 byte-lock artifacts\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  CARD_SPECS,
  CROSS_MODULE_S5_CONTRACT_REF,
  CqByteLockError,
  LEGACY_S5_TOOL_LOCK_REF,
  checkOutputs,
  createOutputs,
};
