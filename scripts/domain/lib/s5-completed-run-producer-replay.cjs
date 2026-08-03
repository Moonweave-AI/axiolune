'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const {
  canonicalJcs,
} = require('./strict-source-locator.cjs');
const {
  computeNamedGraphDigest,
} = require('./rdfc-1.0.cjs');
const {
  IDENTITY_GRAPH_IRI,
  MARKET_GRAPH_IRI,
  PORTFOLIO_GRAPH_IRI,
  countFactVersionsInGraph,
  executeCanonicalTransformation,
  materializeHistoricalDataset,
} = require('./s5-canonical-materialization.cjs');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const MATERIALIZER_BINDING_PATHS = Object.freeze([
  'package-lock.json',
  'package.json',
  'scripts/domain/control-record-profile/s5-v1/materialization-capability-input-contract.json',
  'scripts/domain/control-record-profile/s5-v1/materialization-capability-output-contract.json',
  'scripts/domain/control-record-profile/s5-v1/materialization-discovery-contract.json',
  'scripts/domain/control-record-profile/s5-v1/materialization-evidence-schema.json',
  'scripts/domain/control-record-profile/s5-v1/materialization-runtime-closure.json',
  'scripts/domain/control-record-profile/s5-v1/rdfc-capability-input-contract.json',
  'scripts/domain/control-record-profile/s5-v1/rdfc-capability-output-contract.json',
  'scripts/domain/control-record-profile/s5-v1/rdfc-discovery-contract.json',
  'scripts/domain/control-record-profile/s5-v1/rdfc-evidence-schema.json',
  'scripts/domain/control-record-profile/s5-v1/rdfc-runtime-closure.json',
  'scripts/domain/control-record-profile/s5-v1/toolchain.lock.json',
  'scripts/domain/lib/identity-contract-compiler.cjs',
  'scripts/domain/lib/rdfc-1.0-worker.cjs',
  'scripts/domain/lib/rdfc-1.0.cjs',
  'scripts/domain/lib/s5-canonical-materialization.cjs',
  'scripts/domain/lib/s5-completed-run-producer-replay.cjs',
  'scripts/domain/lib/strict-source-locator.cjs',
].sort(utf8Compare));

const SOURCE_SCHEMA_PATH =
  'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/source-schema.json';
const COMMON_SEMANTIC_PROFILE_PATHS = Object.freeze([
  'mappings/finance/v0.3.0/slice-a-s5/identity-compilation.json',
  'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/ontology-closure-manifest.json',
  SOURCE_SCHEMA_PATH,
]);

function semanticProfilePaths(paths) {
  return Object.freeze([...COMMON_SEMANTIC_PROFILE_PATHS, ...paths].sort(utf8Compare));
}

const SLICE_A_REPLAY_PROFILES = Object.freeze({
  [IDENTITY_GRAPH_IRI]: Object.freeze({
    mappingTargets: Object.freeze([
      Object.freeze({
        mappingRef: 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/mapping/isin-value',
        targetType: 'https://axiolune.ai/ontology/finance/foundation/ISINValue',
      }),
    ]),
    planRef: 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/plan/identity',
    runSlot: 'identity',
    semanticProfilePaths: semanticProfilePaths([
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/identity-plan.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/isin-value-mapping.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/isin-value-transformation-closure.json',
    ]),
  }),
  [MARKET_GRAPH_IRI]: Object.freeze({
    mappingTargets: Object.freeze([
      Object.freeze({
        mappingRef: 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/mapping/market-data-stream',
        targetType: 'https://axiolune.ai/ontology/finance/market-data/MarketDataStream',
      }),
      Object.freeze({
        mappingRef: 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/mapping/price-observation',
        targetType: 'https://axiolune.ai/ontology/finance/market-data/PriceObservation',
      }),
    ]),
    planRef: 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/plan/market-data',
    runSlot: 'market',
    semanticProfilePaths: semanticProfilePaths([
      'mappings/finance/v0.3.0/market-data/market-data-stream.semantic-mapping.json',
      'mappings/finance/v0.3.0/market-data/price-observation.semantic-mapping.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/market-data-plan.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/market-data-stream-transformation-closure.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/price-observation-transformation-closure.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/transformation-money-value.json',
    ]),
  }),
  [PORTFOLIO_GRAPH_IRI]: Object.freeze({
    mappingTargets: Object.freeze([
      Object.freeze({
        mappingRef: 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/mapping/holding-snapshot',
        targetType: 'https://axiolune.ai/ontology/finance/portfolio-positions/HoldingSnapshot',
      }),
      Object.freeze({
        mappingRef: 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/mapping/portfolio-valuation',
        targetType: 'https://axiolune.ai/ontology/finance/portfolio-positions/PortfolioValuation',
      }),
      Object.freeze({
        mappingRef: 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/mapping/position-valuation',
        targetType: 'https://axiolune.ai/ontology/finance/portfolio-positions/PositionValuation',
      }),
    ]),
    planRef: 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/plan/portfolio-valuation',
    runSlot: 'portfolio',
    semanticProfilePaths: semanticProfilePaths([
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/holding-snapshot-mapping.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/holding-snapshot-transformation-closure.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/portfolio-valuation-mapping.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/portfolio-valuation-plan.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/portfolio-valuation-transformation-closure.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/position-valuation-mapping.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/position-valuation-transformation-closure.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/transformation-direct-unit-price-times-quantity.json',
      'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/source/transformation-quantity-value.json',
    ]),
  }),
});

class S5CompletedRunProducerReplayError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'S5CompletedRunProducerReplayError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new S5CompletedRunProducerReplayError(code, message);
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('S5_PRODUCER_REPLAY_SCHEMA', `${label} must be a closed object`);
  }
  const actual = Object.keys(value).sort(utf8Compare);
  const orderedExpected = [...expected].sort(utf8Compare);
  if (canonicalJcs(actual) !== canonicalJcs(orderedExpected)) {
    fail('S5_PRODUCER_REPLAY_SCHEMA', `${label} fields are incomplete or open`);
  }
}

function absoluteIri(value, label) {
  if (typeof value !== 'string'
      || value.length === 0
      || value !== value.normalize('NFC')
      || /[\u0000-\u0020\u007f\uD800-\uDFFF]/u.test(value)) {
    fail('S5_PRODUCER_REPLAY_PROFILE', `${label} must be an absolute IRI`);
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || parsed.href !== value) throw new Error('non-canonical IRI');
  } catch {
    fail('S5_PRODUCER_REPLAY_PROFILE', `${label} must be an absolute IRI`);
  }
}

function exactUtf8Json(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    fail('S5_PRODUCER_REPLAY_BYTES', `${label} must be non-empty exact bytes`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    fail('S5_PRODUCER_REPLAY_BYTES', `${label} is not UTF-8: ${cause.message}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    fail('S5_PRODUCER_REPLAY_BYTES', `${label} is not JSON: ${cause.message}`);
  }
  if (text !== canonicalJcs(value)) {
    fail('S5_PRODUCER_REPLAY_BYTES', `${label} must equal exact RFC 8785 JCS bytes`);
  }
  return value;
}

function validateInstalledPathBinding(rows, expectedPaths, code, label) {
  if (!Array.isArray(rows)) {
    fail(code, `${label} must be an exact path/bytes inventory`);
  }
  const actualPaths = [];
  const byPath = new Map();
  for (const [index, row] of rows.entries()) {
    exactKeys(row, ['bytes', 'path'], `${label}[${index}]`);
    if (typeof row.path !== 'string' || !Buffer.isBuffer(row.bytes)) {
      fail(code, `${label}[${index}] path/bytes invalid`);
    }
    if (actualPaths.length !== 0 && utf8Compare(actualPaths.at(-1), row.path) >= 0) {
      fail(code, `${label} must be sorted and unique`);
    }
    actualPaths.push(row.path);
    byPath.set(row.path, row.bytes);
    if (!expectedPaths.includes(row.path)) {
      fail(code, `${row.path} is outside the installed ${label} closure`);
    }
    const installedPath = path.resolve(REPOSITORY_ROOT, ...row.path.split('/'));
    const expectedPrefix = `${REPOSITORY_ROOT}${path.sep}`;
    if (!installedPath.startsWith(expectedPrefix)) {
      fail(code, `${row.path} escapes the repository root`);
    }
    const installedBytes = fs.readFileSync(installedPath);
    if (!installedBytes.equals(row.bytes)) {
      fail(
        code,
        `${row.path} bundle bytes differ from the verifier-installed ${label} closure`,
      );
    }
  }
  if (canonicalJcs(actualPaths) !== canonicalJcs(expectedPaths)) {
    fail(code, `installed ${label} closure is incomplete or extra`);
  }
  return byPath;
}

function validateInstalledMaterializerBinding(rows) {
  return validateInstalledPathBinding(
    rows,
    MATERIALIZER_BINDING_PATHS,
    'S5_PRODUCER_REPLAY_BINDING',
    'materializerArtifacts',
  );
}

function validateInstalledSemanticProfileBinding(request, profile) {
  const byPath = validateInstalledPathBinding(
    request.semanticProfileArtifacts,
    profile.semanticProfilePaths,
    'S5_PRODUCER_REPLAY_SEMANTIC_PROFILE',
    'semanticProfileArtifacts',
  );
  if (!byPath.get(SOURCE_SCHEMA_PATH)?.equals(request.sourceSchemaBytes)) {
    fail(
      'S5_PRODUCER_REPLAY_SEMANTIC_PROFILE',
      'sourceSchemaBytes do not equal the exact verifier-installed Slice-A source contract',
    );
  }
  return byPath;
}

function digestBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function validateInstalledTransformationDefinitions(
  semanticArtifacts,
  materializerArtifacts,
  valuationPolicyArtifacts,
) {
  const closurePaths = [...semanticArtifacts.keys()].filter((relativePath) => (
    relativePath.endsWith('-transformation-closure.json')
  )).sort(utf8Compare);
  const declaredDefinitionPaths = [...semanticArtifacts.keys()].filter((relativePath) => (
    path.posix.basename(relativePath).startsWith('transformation-')
      && !relativePath.endsWith('-transformation-closure.json')
  )).sort(utf8Compare);
  const referencedDefinitions = new Map();
  for (const closurePath of closurePaths) {
    const closure = exactUtf8Json(
      semanticArtifacts.get(closurePath),
      `semanticProfileArtifacts(${closurePath})`,
    );
    if (closure.schemaVersion !== '1.0' || !Array.isArray(closure.transformations)) {
      fail(
        'S5_PRODUCER_REPLAY_TRANSFORMATION',
        `${closurePath} is not a closed executable transformation inventory`,
      );
    }
    for (const [index, entry] of closure.transformations.entries()) {
      const label = `${closurePath}.transformations[${index}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
          || entry.definitionRef?.kind !== 'path'
          || entry.definitionRef.root !== 'sourceTree'
          || typeof entry.definitionRef.path !== 'string'
          || typeof entry.definitionDigest !== 'string'
          || typeof entry.transformationRef !== 'string') {
        fail('S5_PRODUCER_REPLAY_TRANSFORMATION', `${label} has no exact definition binding`);
      }
      const prior = referencedDefinitions.get(entry.definitionRef.path);
      const binding = {
        definitionDigest: entry.definitionDigest,
        transformationRef: entry.transformationRef,
      };
      if (prior && canonicalJcs(prior) !== canonicalJcs(binding)) {
        fail(
          'S5_PRODUCER_REPLAY_TRANSFORMATION',
          `${entry.definitionRef.path} has conflicting definition bindings`,
        );
      }
      referencedDefinitions.set(entry.definitionRef.path, binding);
    }
  }
  const referencedPaths = [...referencedDefinitions.keys()].sort(utf8Compare);
  if (canonicalJcs(referencedPaths) !== canonicalJcs(declaredDefinitionPaths)) {
    fail(
      'S5_PRODUCER_REPLAY_TRANSFORMATION',
      'semantic profile definition artifacts do not equal the exact referenced inventory',
    );
  }
  const materializerPath = 'scripts/domain/lib/s5-canonical-materialization.cjs';
  const materializerDigest = digestBytes(materializerArtifacts.get(materializerPath));
  for (const definitionPath of referencedPaths) {
    const definitionBytes = semanticArtifacts.get(definitionPath);
    const binding = referencedDefinitions.get(definitionPath);
    if (digestBytes(definitionBytes) !== binding.definitionDigest) {
      fail(
        'S5_PRODUCER_REPLAY_TRANSFORMATION',
        `${definitionPath} bytes differ from the transformation closure digest`,
      );
    }
    const definition = exactUtf8Json(
      definitionBytes,
      `semanticProfileArtifacts(${definitionPath})`,
    );
    if (definition.iri !== binding.transformationRef
        || definition.kind !== 'ScriptTransformation'
        || definition.implementationDigest !== materializerDigest
        || definition.implementation?.entrypoint !== 'executeCanonicalTransformation'
        || definition.implementation.runtime !== 'javascript'
        || definition.implementation.scriptPath !== materializerPath
        || !Array.isArray(definition.testCases)
        || definition.testCases.length === 0) {
      fail(
        'S5_PRODUCER_REPLAY_TRANSFORMATION',
        `${definitionPath} does not bind the locked transformation executor`,
      );
    }
    for (const [index, testCase] of definition.testCases.entries()) {
      if (!testCase || typeof testCase !== 'object' || Array.isArray(testCase)
          || !Object.hasOwn(testCase, 'input')
          || !Object.hasOwn(testCase, 'expectedOutput')) {
        fail(
          'S5_PRODUCER_REPLAY_TRANSFORMATION',
          `${definitionPath}.testCases[${index}] is incomplete`,
        );
      }
      let actualOutput;
      try {
        actualOutput = executeCanonicalTransformation(
          definition.iri,
          testCase.input,
          definition.iri.endsWith('/direct-unit-price-times-quantity')
            ? { valuationPolicyArtifacts }
            : {},
        );
      } catch (cause) {
        fail(
          'S5_PRODUCER_REPLAY_TRANSFORMATION',
          `${definitionPath}.testCases[${index}] failed locked execution: ${cause.message}`,
        );
      }
      if (canonicalJcs(actualOutput) !== canonicalJcs(testCase.expectedOutput)) {
        fail(
          'S5_PRODUCER_REPLAY_TRANSFORMATION',
          `${definitionPath}.testCases[${index}] expectedOutput differs from locked execution`,
        );
      }
    }
  }
}

function validateSliceAProfile(request) {
  const profile = SLICE_A_REPLAY_PROFILES[request.graphIri];
  if (!profile || request.planRef !== profile.planRef) {
    fail('S5_PRODUCER_REPLAY_PROFILE', 'completed run is not an exact supported Slice-A plan/graph');
  }
  if (!Array.isArray(request.mappingTargets)) {
    fail('S5_PRODUCER_REPLAY_PROFILE', 'mappingTargets must be an exact sorted inventory');
  }
  const normalized = request.mappingTargets.map((entry, index) => {
    exactKeys(entry, ['mappingRef', 'targetType'], `mappingTargets[${index}]`);
    absoluteIri(entry.mappingRef, `mappingTargets[${index}].mappingRef`);
    absoluteIri(entry.targetType, `mappingTargets[${index}].targetType`);
    return entry;
  });
  if (canonicalJcs(normalized) !== canonicalJcs(profile.mappingTargets)) {
    fail('S5_PRODUCER_REPLAY_PROFILE', 'mapping target inventory differs from the exact Slice-A profile');
  }
  return profile;
}

function validateSourceSnapshot(request) {
  const schema = exactUtf8Json(request.sourceSchemaBytes, 'sourceSchemaBytes');
  const snapshot = exactUtf8Json(request.sourceSnapshotBytes, 'sourceSnapshotBytes');
  if (!schema || !snapshot
      || schema.schemaVersion !== '1.0'
      || snapshot.dataset !== schema.dataset
      || !Array.isArray(schema.fields)
      || !Array.isArray(snapshot.rows)
      || snapshot.rows.length !== 1) {
    fail('S5_PRODUCER_REPLAY_SOURCE', 'Slice-A replay requires one exact schema-bound source row');
  }
  const fields = new Map();
  for (const field of schema.fields) {
    if (!field || typeof field.name !== 'string' || fields.has(field.name)) {
      fail('S5_PRODUCER_REPLAY_SOURCE', 'source schema field inventory is invalid');
    }
    fields.set(field.name, field);
  }
  const row = snapshot.rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    fail('S5_PRODUCER_REPLAY_SOURCE', 'source row must be an object');
  }
  for (const field of Object.keys(row)) {
    if (!fields.has(field)) {
      fail('S5_PRODUCER_REPLAY_SOURCE', `source row field ${field} is absent from the schema`);
    }
  }
  for (const [name, definition] of fields) {
    if (definition.required === true && !Object.hasOwn(row, name)) {
      fail('S5_PRODUCER_REPLAY_SOURCE', `source row omits required field ${name}`);
    }
  }
  return snapshot.rows;
}

function selectedRunIris(profile, runIri) {
  const values = {
    identity: 'urn:axiolune:producer-replay:unselected:identity',
    market: 'urn:axiolune:producer-replay:unselected:market',
    portfolio: 'urn:axiolune:producer-replay:unselected:portfolio',
  };
  values[profile.runSlot] = runIri;
  return values;
}

/**
 * Replays the one currently supported producer profile. It deliberately takes
 * bytes and declarative identifiers only; there is no callback, module path,
 * entrypoint name, or caller-provided execution result.
 */
function replayLockedSliceACompletedRun(request) {
  exactKeys(request, [
    'graphIri', 'mappingTargets', 'materializerArtifacts', 'outputBytes',
    'planRef', 'runIri', 'semanticProfileArtifacts', 'sourceSchemaBytes', 'sourceSnapshotBytes',
    'valuationPolicyArtifacts',
  ], 'producerReplayRequest');
  absoluteIri(request.runIri, 'runIri');
  absoluteIri(request.graphIri, 'graphIri');
  const profile = validateSliceAProfile(request);
  const materializerArtifacts = validateInstalledMaterializerBinding(
    request.materializerArtifacts,
  );
  const semanticArtifacts = validateInstalledSemanticProfileBinding(request, profile);
  exactKeys(
    request.valuationPolicyArtifacts,
    ['precisionBytes', 'roundingBytes'],
    'valuationPolicyArtifacts',
  );
  if (!Buffer.isBuffer(request.valuationPolicyArtifacts.precisionBytes)
      || !Buffer.isBuffer(request.valuationPolicyArtifacts.roundingBytes)) {
    fail('S5_PRODUCER_REPLAY_BYTES', 'valuation policy artifacts must be exact Buffers');
  }
  validateInstalledTransformationDefinitions(
    semanticArtifacts,
    materializerArtifacts,
    request.valuationPolicyArtifacts,
  );
  const rows = validateSourceSnapshot(request);
  const runs = selectedRunIris(profile, request.runIri);
  const args = [
    rows,
    runs.identity,
    runs.market,
    runs.portfolio,
    'urn:axiolune:producer-replay:unselected:batch',
  ];
  let forward;
  let reverse;
  try {
    forward = materializeHistoricalDataset(...args, {
      valuationPolicyArtifacts: request.valuationPolicyArtifacts,
    });
    reverse = materializeHistoricalDataset(...args, {
      reverse: true,
      valuationPolicyArtifacts: request.valuationPolicyArtifacts,
    });
  } catch (cause) {
    fail('S5_PRODUCER_REPLAY_EXECUTION', cause.message);
  }
  let forwardGraph;
  let reverseGraph;
  try {
    forwardGraph = computeNamedGraphDigest(forward.nquads, request.graphIri);
    reverseGraph = computeNamedGraphDigest(reverse.nquads, request.graphIri);
  } catch (cause) {
    fail('S5_PRODUCER_REPLAY_RDFC', cause.message);
  }
  if (forwardGraph.canonicalNQuads !== reverseGraph.canonicalNQuads
      || forwardGraph.digest !== reverseGraph.digest) {
    fail('S5_PRODUCER_REPLAY_NONDETERMINISTIC', 'forward/reverse producer replay differs');
  }
  if (!Buffer.isBuffer(request.outputBytes)
      || !request.outputBytes.equals(Buffer.from(forwardGraph.canonicalNQuads, 'utf8'))) {
    fail(
      'S5_PRODUCER_REPLAY_OUTPUT_MISMATCH',
      'stored output bytes are not the exact canonical named graph produced from the authenticated source',
    );
  }
  return Object.freeze({
    factVersionCount: countFactVersionsInGraph(
      forwardGraph.canonicalNQuads,
      request.graphIri,
      request.runIri,
    ),
    graphDigest: forwardGraph.digest,
    graphIri: request.graphIri,
    planRef: request.planRef,
    replayKind: 'verifier-owned-slice-a-materializer',
  });
}

module.exports = {
  MATERIALIZER_BINDING_PATHS,
  S5CompletedRunProducerReplayError,
  SLICE_A_REPLAY_PROFILES,
  replayLockedSliceACompletedRun,
};
