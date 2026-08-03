'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('node:os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const rdfCanonize = require('rdf-canonize');
const yaml = require('js-yaml');

const {
  canonicalJcs,
  computeSelectionDigest,
  validateArtifactRef,
  validateSourceLocator,
} = require('./strict-source-locator.cjs');
const {
  parseJsonRejectingDuplicateMembers,
} = require('./json-pointer-source-extractor.cjs');
const {
  computeDatasetDigest,
  computeNamedGraphDigest,
  sha256,
} = require('./rdfc-1.0.cjs');
const {
  buildSourceTreeManifest: buildGitSourceTreeManifest,
  inspectCommit,
  repositoryObjectFormat,
} = require('./m2-git-replay.cjs');
const { validateDocument } = require('./typed-projection-common.cjs');
const {
  assertOntologyImportRowsSortedUnique,
  normalizeOntologyIr,
  selectedImportSymbolIris,
  sortUniqueOntologyImportRows,
} = require('./ontology-ir-normalizer.cjs');
const {
  TAGS: IDENTITY_TAGS,
  compileIdentityContracts,
  validateCompilationInput,
  validateIdentityManifest,
} = require('./identity-contract-compiler.cjs');
const {
  CONTRACTS: S5_IDENTITY_CONTRACTS,
  FACT_VERSION,
  GENERATING_CONTEXT,
  IDENTITY_GRAPH_IRI,
  MARKET_GRAPH_IRI,
  PORTFOLIO_GRAPH_IRI,
  TRANSFORMATION_REFS,
  countFactVersionsInGraph,
  evaluatePitSelection,
  executeCanonicalTransformation,
  materializeHistoricalDataset: materializeCanonicalHistoricalDataset,
  validateCanonicalFactVersions,
} = require('./s5-canonical-materialization.cjs');
const {
  validatePriorSupportChain,
} = require('./s5-prior-support-chain.cjs');
const {
  MATERIALIZER_BINDING_PATHS,
  SLICE_A_REPLAY_PROFILES,
  replayLockedSliceACompletedRun,
} = require('./s5-completed-run-producer-replay.cjs');

const CONTROL_CHAIN_VERSION = 'axiolune-s5-control-record-chain/v1';
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const CRITERION_5 = `${PROFILE_REF}/criteria/5`;
const PROFILE_ROOT_REL = 'scripts/domain/control-record-profile/s5-v1';
const PROFILE_MANIFEST_REL = `${PROFILE_ROOT_REL}/control-record-schema-manifest.json`;
const TOOL_LOCK_REL = `${PROFILE_ROOT_REL}/toolchain.lock.json`;
const INPUT_FIXTURE_REL = 'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain/control-chain-input.json';
const PRIOR_SUPPORT_DATASET_IRI = 'urn:axiolune:dataset:slice-a:prior-support:v1';
// These brands deliberately stay module-private. A plain object with the same
// enumerable fields is not evidence that the completed-run verifier executed.
const VERIFIED_COMPLETED_RUN_SUMMARIES = new WeakSet();
const VERIFIED_COMPLETED_RUN_METADATA = new WeakMap();
const VERIFIED_MATERIALIZATION_CONTEXTS = new WeakSet();
const VERIFIED_MATERIALIZATION_CONTEXT_METADATA = new WeakMap();
const VERIFIED_S5_CHAIN_SUMMARIES = new WeakSet();
const VERIFIED_S5_CHAIN_CONTEXTS = new WeakMap();
const MAX_COMPLETED_BUNDLE_ARTIFACTS = 4096;
const MAX_COMPLETED_BUNDLE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_COMPLETED_BUNDLE_TOTAL_BYTES = 512 * 1024 * 1024;
const RDFC_CAPABILITY_CONTRACTS = Object.freeze({
  'rdfc-capability-input-contract.json': Object.freeze({
    additionalArgumentsProhibited: true,
    algorithm: 'RDFC-1.0',
    arguments: Object.freeze([
      Object.freeze({
        encoding: 'UTF-8',
        mediaType: 'application/n-quads',
        name: 'input',
        nonEmpty: true,
        type: 'string',
      }),
    ]),
    entrypoint: 'canonicalizeNQuads',
    limits: Object.freeze({
      maxInputBytes: 1048576,
      maxQuads: 10000,
    }),
    namedGraphsOnly: true,
    schemaVersion: '1.0',
  }),
  'rdfc-capability-output-contract.json': Object.freeze({
    additionalProperties: false,
    algorithm: 'RDFC-1.0',
    entrypoint: 'canonicalizeNQuads',
    properties: Object.freeze({
      canonicalNQuads: Object.freeze({
        encoding: 'UTF-8',
        mediaType: 'application/n-quads',
        nonEmpty: true,
        type: 'string',
      }),
      graphIris: Object.freeze({
        items: 'normalized absolute named-graph IRI',
        orderedBy: 'UTF-8 byte order',
        type: 'array',
        uniqueItems: true,
      }),
      quadCount: Object.freeze({
        maximum: 10000,
        minimum: 1,
        type: 'integer',
      }),
    }),
    required: Object.freeze(['algorithm', 'canonicalNQuads', 'graphIris', 'quadCount']),
    schemaVersion: '1.0',
  }),
  'rdfc-discovery-contract.json': Object.freeze({
    algorithm: 'RDFC-1.0',
    capabilityId: 'rdfc-1.0',
    operations: Object.freeze([
      Object.freeze({
        entrypoint: 'canonicalizeNQuads',
        resultRequired: Object.freeze([
          'algorithm', 'canonicalNQuads', 'graphIris', 'quadCount',
        ]),
      }),
      Object.freeze({
        digestDomainTag: 'axiolune-rdf-dataset-v1\\0',
        entrypoint: 'computeDatasetDigest',
        resultRequired: Object.freeze([
          'algorithm', 'canonicalNQuads', 'digest', 'graphIris', 'quadCount',
        ]),
      }),
      Object.freeze({
        digestDomainTag: 'axiolune-rdf-graph-v1\\0',
        entrypoint: 'computeNamedGraphDigest',
        resultRequired: Object.freeze([
          'algorithm', 'canonicalNQuads', 'digest', 'graphIris', 'quadCount',
        ]),
      }),
    ]),
    schemaVersion: '1.0',
  }),
  'rdfc-evidence-schema.json': Object.freeze({
    algorithm: 'RDFC-1.0',
    canonicalizationInput: 'exact UTF-8 N-Quads bytes',
    canonicalizationOutput: 'exact UTF-8 canonical N-Quads bytes',
    packageName: 'rdf-canonize',
    packageVersion: '5.0.0',
    requiresDeterministicReplay: true,
    requiresExactGraphScope: true,
    schemaVersion: '1.0',
  }),
});
const PINNED_NODE_MODULES_ROOT = path.resolve(
  path.dirname(require.resolve('js-yaml')),
  '..',
  '..',
);
const INSTALLED_S5_SHACL_WORKER = path.resolve(
  __dirname,
  's5-materialized-shacl-worker.cjs',
);
const INSTALLED_S5_PYSHACL_WORKER = path.resolve(
  __dirname,
  '..',
  'shacl-instance-profile',
  'v0.3.0',
  's5-materialized-graph-worker.py',
);
const INSTALLED_S5_CUSTOM_WORKER = path.resolve(
  __dirname,
  's5-materialized-custom-worker.cjs',
);
const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const CUSTOM_REPLAY_RUNTIME_PATHS = Object.freeze([
  'package-lock.json',
  'package.json',
  'scripts/domain/lib/json-pointer-source-extractor.cjs',
  'scripts/domain/lib/m2-constraint-instance-audit.cjs',
  'scripts/domain/lib/m2-constraint-instance-gate-join.cjs',
  'scripts/domain/lib/s5-materialized-custom-validation.cjs',
  'scripts/domain/lib/s5-materialized-custom-worker.cjs',
  'scripts/domain/lib/strict-source-locator.cjs',
].sort(utf8Compare));
const MATERIALIZATION_RUN_SPECS = Object.freeze([
  Object.freeze({
    gateId: 'mapping-materialization.identity',
    graphIri: IDENTITY_GRAPH_IRI,
    mappingIndex: 0,
    moduleIri: 'https://axiolune.ai/ontology/finance/foundation',
    validationModuleIris: Object.freeze([
      'https://axiolune.ai/ontology/finance/foundation',
    ]),
    replayName: 'identityGraph',
    reportSlot: 'identity-report',
    slug: 'identity',
    slotId: 'identity-run',
  }),
  Object.freeze({
    gateId: 'mapping-materialization.market-data',
    graphIri: MARKET_GRAPH_IRI,
    mappingIndex: 1,
    moduleIri: 'https://axiolune.ai/ontology/finance/market-data',
    validationModuleIris: Object.freeze([
      'https://axiolune.ai/ontology/finance/instruments',
      'https://axiolune.ai/ontology/finance/market-data',
      'https://axiolune.ai/ontology/finance/market-structure',
    ]),
    replayName: 'marketDataGraph',
    reportSlot: 'market-data-report',
    slug: 'market-data',
    slotId: 'market-data-run',
  }),
  Object.freeze({
    gateId: 'mapping-materialization.portfolio-valuation',
    graphIri: PORTFOLIO_GRAPH_IRI,
    mappingIndex: 2,
    moduleIri: 'https://axiolune.ai/ontology/finance/portfolio-positions',
    validationModuleIris: Object.freeze([
      'https://axiolune.ai/ontology/finance/portfolio-positions',
    ]),
    replayName: 'portfolioValuationGraph',
    reportSlot: 'portfolio-valuation-report',
    slug: 'portfolio-valuation',
    slotId: 'portfolio-valuation-run',
  }),
]);
const SOURCE_SCHEMA_FIELDS = Object.freeze([
  Object.freeze(['account_logical_iri', 'uri']),
  Object.freeze(['available_from', 'dateTimeStamp']),
  Object.freeze(['conversion_context_digest', 'sha256Digest']),
  Object.freeze(['conversion_context_ref', 'uri']),
  Object.freeze(['currency', 'string']),
  Object.freeze(['holding_quantity', 'decimalString']),
  Object.freeze(['holding_quantity_precision', 'nonNegativeInteger']),
  Object.freeze(['holding_quantity_rounding', 'string']),
  Object.freeze(['holding_quantity_unit', 'string']),
  Object.freeze(['holding_snapshot_id', 'string']),
  Object.freeze(['holding_source_artifact_digest', 'sha256Digest']),
  Object.freeze(['holding_source_artifact_ref', 'uri']),
  Object.freeze(['holding_source_locator_iri', 'uri']),
  Object.freeze(['instrument_id', 'string']),
  Object.freeze(['instrument_logical_iri', 'uri']),
  Object.freeze(['instrument_version_iri', 'uri']),
  Object.freeze(['internal_id', 'string']),
  Object.freeze(['isin', 'string']),
  Object.freeze(['knowledge_from', 'dateTimeStamp']),
  Object.freeze(['listing_business_from', 'date']),
  Object.freeze(['listing_facility_version_iri', 'uri']),
  Object.freeze(['listing_identifier_scheme_logical_iri', 'uri']),
  Object.freeze(['listing_identifier_value_logical_iri', 'uri']),
  Object.freeze(['listing_version_iri', 'uri']),
  Object.freeze(['market_source_artifact_digest', 'sha256Digest']),
  Object.freeze(['market_source_locator_iri', 'uri']),
  Object.freeze(['membership_approval_digest', 'sha256Digest']),
  Object.freeze(['membership_approval_ref', 'uri']),
  Object.freeze(['membership_closure_probe_digest', 'sha256Digest']),
  Object.freeze(['membership_closure_probe_ref', 'uri']),
  Object.freeze(['membership_closure_version_iri', 'uri']),
  Object.freeze(['ordering_transform_digest', 'sha256Digest']),
  Object.freeze(['ordering_transform_ref', 'uri']),
  Object.freeze(['portfolio_logical_iri', 'uri']),
  Object.freeze(['portfolio_observation_completeness_contract_digest', 'sha256Digest']),
  Object.freeze(['portfolio_observation_completeness_contract_ref', 'uri']),
  Object.freeze(['portfolio_observation_pagination_contract_digest', 'sha256Digest']),
  Object.freeze(['portfolio_observation_pagination_contract_ref', 'uri']),
  Object.freeze(['portfolio_observation_source_artifact_digest', 'sha256Digest']),
  Object.freeze(['portfolio_observation_source_artifact_ref', 'uri']),
  Object.freeze(['portfolio_observation_source_contract_digest', 'sha256Digest']),
  Object.freeze(['portfolio_observation_source_contract_ref', 'uri']),
  Object.freeze(['portfolio_observation_source_locator_iri', 'uri']),
  Object.freeze(['portfolio_observation_stream_id', 'string']),
  Object.freeze(['portfolio_observation_stream_logical_iri', 'uri']),
  Object.freeze(['portfolio_observation_stream_version_iri', 'uri']),
  Object.freeze(['position_source_kind_iri', 'uri']),
  Object.freeze(['price', 'decimalString']),
  Object.freeze(['price_scale', 'nonNegativeInteger']),
  Object.freeze(['provider_iri', 'uri']),
  Object.freeze(['provider_observation_id', 'string']),
  Object.freeze(['provider_stream_id', 'string']),
  Object.freeze(['quotation_contract_version_iri', 'uri']),
  Object.freeze(['quotation_currency_iri', 'uri']),
  Object.freeze(['quotation_denominator_unit', 'string']),
  Object.freeze(['reporting_currency_iri', 'uri']),
  Object.freeze(['revision', 'nonNegativeInteger']),
  Object.freeze(['source', 'uri']),
  Object.freeze(['source_contract_digest', 'sha256Digest']),
  Object.freeze(['source_contract_ref', 'uri']),
  Object.freeze(['source_order_key', 'nonNegativeInteger']),
  Object.freeze(['valid_from', 'dateTimeStamp']),
  Object.freeze(['valuation_definition_version_iri', 'uri']),
  Object.freeze(['valuation_formula_digest', 'sha256Digest']),
  Object.freeze(['valuation_formula_ref', 'uri']),
  Object.freeze(['valuation_input_context_digest', 'sha256Digest']),
  Object.freeze(['valuation_input_context_ref', 'uri']),
  Object.freeze(['valuation_input_contract_digest', 'sha256Digest']),
  Object.freeze(['valuation_output_contract_digest', 'sha256Digest']),
  Object.freeze(['valuation_pit_request_digest', 'sha256Digest']),
  Object.freeze(['valuation_pit_request_ref', 'uri']),
  Object.freeze(['valuation_precision_policy_digest', 'sha256Digest']),
  Object.freeze(['valuation_precision_policy_ref', 'uri']),
  Object.freeze(['valuation_rounding_policy_digest', 'sha256Digest']),
  Object.freeze(['valuation_rounding_policy_ref', 'uri']),
  Object.freeze(['valuation_run_id', 'string']),
  Object.freeze(['valuation_runtime_digest', 'sha256Digest']),
  Object.freeze(['valuation_tool_lock_digest', 'sha256Digest']),
  Object.freeze(['valuation_tool_lock_ref', 'uri']),
]);
const VALUATION_INPUT_FIELD_NAMES = Object.freeze([
  'account_logical_iri',
  'available_from',
  'holding_quantity',
  'holding_quantity_precision',
  'holding_quantity_rounding',
  'holding_quantity_unit',
  'holding_snapshot_id',
  'instrument_logical_iri',
  'instrument_version_iri',
  'knowledge_from',
  'listing_version_iri',
  'membership_closure_version_iri',
  'portfolio_logical_iri',
  'portfolio_observation_stream_id',
  'portfolio_observation_stream_logical_iri',
  'portfolio_observation_stream_version_iri',
  'price',
  'price_scale',
  'provider_observation_id',
  'quotation_contract_version_iri',
  'quotation_currency_iri',
  'quotation_denominator_unit',
  'reporting_currency_iri',
  'revision',
  'source_order_key',
  'valid_from',
  'valuation_definition_version_iri',
]);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ASCII_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

const RECORD_TYPE_ID_FIELD = Object.freeze({
  evidenceLedger: 'ledgerId',
  failureReport: 'reportId',
  materializationBatchRun: 'runId',
  materializationRun: 'runId',
  pitRequest: 'requestId',
  replayReport: 'reportId',
  validationReport: 'reportId',
});

const RECORD_FIELDS = Object.freeze({
  materializationRun: [
    'assertionTime', 'attemptId', 'build', 'compilerDigest', 'executorDigest',
    'inputDatasets', 'iri', 'mappingClosure', 'mappingClosureDigest',
    'ontologyClosureDigest', 'ontologyClosureRef', 'outputRdfCanonicalization',
    'planRef', 'planSourceDigest', 'plannedInputDigest', 'recordType',
    'referenceLockDigest', 'referenceLockRef', 'referenceTime',
    'resolvedInputDigest', 'result', 'runId', 'schemaVersion', 'slotId',
    'sourceSchemaClosureDigest', 'sourceSnapshotRootDigest', 'validatorDigest',
  ],
  materializationBatchRun: [
    'assertionTime', 'attemptId', 'batchRef', 'batchSourceDigest', 'build',
    'compilerDigest', 'executorDigest', 'iri', 'ontologyClosureDigest',
    'ontologyClosureRef', 'outputRdfCanonicalization', 'plannedInputDigest',
    'recordType', 'referenceLockDigest', 'referenceLockRef', 'referenceTime',
    'resolvedInputDigest', 'result', 'runId', 'schemaVersion', 'slotId',
    'sourceSnapshotRootDigest', 'targetDataset', 'validatorDigest',
  ],
  pitRequest: [
    'asOfAvailable', 'asOfKnowledge', 'asOfValid', 'attemptId', 'build', 'iri',
    'materializationContext', 'plannedInputDigest', 'recordType', 'requestId',
    'resolvedInputDigest', 'schemaVersion', 'slotId', 'targetRdfCanonicalization',
    'validatorDigest', 'validatorRef',
  ],
  validationReport: [
    'attemptId', 'build', 'capabilityDigest', 'capabilityId', 'capabilityRef',
    'criterionRefs', 'counts', 'discoveryContractDigest',
    'discoveryContractRef', 'entrypointDigest', 'entrypointRef', 'gateId', 'inputs',
    'iri', 'kindEvidence', 'plannedInputDigest', 'profileRef', 'recordType',
    'reportId', 'reportKind', 'resolvedInputDigest', 'result', 'schemaVersion',
    'slotId', 'subjectInventoryDigest', 'subjectInventoryRef', 'subjectRef',
    'toolId',
  ],
  failureReport: [
    'attemptId', 'build', 'errors', 'failureStage', 'inputs', 'iri',
    'plannedInputDigest', 'recordType', 'reportId', 'resolvedInputDigest',
    'schemaVersion', 'slotId', 'subjectRef',
  ],
  replayReport: [
    'attemptId', 'build', 'iri', 'originalContextRecordDigest',
    'originalContextRef', 'originalTargetDigest', 'originalTargetRef',
    'plannedInputDigest', 'recordType', 'replayMappingClosureDigest',
    'replayOntologyClosureDigest', 'replayReferenceLockDigest',
    'replaySourceSnapshotRootDigest', 'replayToolLockDigest', 'reportId',
    'resolvedInputDigest', 'result', 'schemaVersion', 'slotId',
  ],
  evidenceLedger: [
    'attemptId', 'build', 'entries', 'iri', 'ledgerId', 'plannedInputDigest',
    'recordType', 'resolvedInputDigest', 'schemaVersion', 'slotId',
    'slotSelections',
  ],
});

const VALIDATION_PIT_EXTRA_FIELDS = Object.freeze([
  'asOfAvailable', 'asOfKnowledge', 'asOfValid', 'contextRecordDigest',
  'contextRef', 'recomputedTargetDigest', 'requestRecordDigest', 'requestRef',
  'selectedFactVersionCount', 'selectedFactVersionIris',
  'selectedFactVersionSetDigest',
]);

const PROFILE_REFERENCE_FIELDS = Object.freeze({
  evidenceLedger: Object.freeze({}),
  failureReport: Object.freeze({}),
  materializationBatchRun: Object.freeze({
    'result.completed.validationReportRef': 'uri',
    'result.failed.failureReportRef': 'uri',
  }),
  materializationRun: Object.freeze({
    'inputDatasets[].snapshotRef': 'ArtifactRef',
    'result.completed.validationReportRef': 'uri',
    'result.failed.failureReportRef': 'uri',
  }),
  pitRequest: Object.freeze({
    'materializationContext.recordRef': 'uri',
  }),
  replayReport: Object.freeze({
    originalContextRef: 'uri',
  }),
  validationReport: Object.freeze({
    'pit.contextRef': 'uri',
    'pit.requestRef': 'uri',
  }),
});

const RESOLVED_PROJECTION_FIELDS = Object.freeze({
  materializationRun: [
    'iri', 'inputDatasets', 'mappingClosure', 'mappingClosureDigest', 'planRef',
    'recordType', 'result', 'runId', 'slotId', 'sourceSnapshotRootDigest',
  ],
  materializationBatchRun: [
    'batchRef', 'iri', 'recordType', 'result', 'runId', 'slotId', 'targetDataset',
  ],
  pitRequest: [
    'asOfAvailable', 'asOfKnowledge', 'asOfValid', 'iri',
    'materializationContext', 'recordType', 'requestId', 'slotId',
  ],
  validationReport: [
    'counts', 'gateId', 'iri', 'kindEvidence', 'recordType', 'reportId', 'result',
    'slotId', 'subjectInventoryDigest', 'subjectRef',
  ],
  failureReport: [
    'errors', 'failureStage', 'iri', 'recordType', 'reportId', 'slotId',
    'subjectRef',
  ],
  replayReport: [
    'iri', 'originalContextRecordDigest', 'originalTargetDigest', 'recordType',
    'replayMappingClosureDigest', 'replayOntologyClosureDigest',
    'replayReferenceLockDigest', 'replaySourceSnapshotRootDigest',
    'replayToolLockDigest', 'reportId', 'result', 'slotId',
  ],
  evidenceLedger: [
    'entries', 'iri', 'ledgerId', 'recordType', 'slotId', 'slotSelections',
  ],
});

const PLANNED_INPUT_FIELDS = Object.freeze({
  common: ['dependencySelectors', 'recordType', 'schemaVersion', 'staticInputs'],
  evidenceLedger: [
    'alternatives', 'recordType', 'schemaManifestBinding', 'schemaVersion',
  ],
});

const PROFILE_DEFINITIONS = Object.freeze(
  Object.fromEntries(Object.keys(RECORD_FIELDS).sort().map((recordType) => [
    recordType,
    {
      plannedInputRequired: recordType === 'evidenceLedger'
        ? PLANNED_INPUT_FIELDS.evidenceLedger
        : PLANNED_INPUT_FIELDS.common,
      resolvedInputRequired: RESOLVED_PROJECTION_FIELDS[recordType],
      recordRequired: RECORD_FIELDS[recordType],
      conditionalRecordFields: recordType === 'validationReport'
        ? { pit: VALIDATION_PIT_EXTRA_FIELDS }
        : {},
      referenceFields: PROFILE_REFERENCE_FIELDS[recordType],
    },
  ])),
);

class S5ControlChainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'S5ControlChainError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new S5ControlChainError(code, message);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, label, code = 'S5_CHAIN_SCHEMA') {
  if (!isPlainObject(value)) fail(code, `${label} must be a closed object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) {
    fail(code, `${label} keys must equal [${wanted.join(', ')}]`);
  }
}

function sortedUniqueStrings(values, label, options = {}) {
  if (!Array.isArray(values) || (options.nonEmpty !== false && values.length === 0)) {
    fail('S5_CHAIN_SORT', `${label} must be a ${options.nonEmpty === false ? '' : 'non-empty '}array`);
  }
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string' || value !== value.normalize('NFC')) {
      fail('S5_CHAIN_SORT', `${label}[${index}] must be a normalized string`);
    }
  }
  const sorted = [...values].sort(utf8Compare);
  if (sorted.some((value, index) => value !== values[index])
      || new Set(values).size !== values.length) {
    fail('S5_CHAIN_SORT', `${label} must be UTF-8-byte-sorted and unique`);
  }
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function tupleCompare(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const compared = utf8Compare(left[index] ?? '', right[index] ?? '');
    if (compared !== 0) return compared;
  }
  return 0;
}

function artifactDigest(bytes) {
  return sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
}

function taggedJcsDigest(tag, value) {
  if (typeof tag !== 'string' || !tag.endsWith('\0') || tag.slice(0, -1).includes('\0')) {
    fail('S5_CHAIN_DOMAIN_TAG', 'JCS digest tag must contain exactly one terminal NUL');
  }
  return artifactDigest(Buffer.concat([
    Buffer.from(tag, 'utf8'),
    Buffer.from(canonicalJcs(value), 'utf8'),
  ]));
}

function rawDigestBytes(value, label) {
  if (!DIGEST_RE.test(value || '')) fail('S5_CHAIN_DIGEST', `${label} must be a lowercase Digest`);
  return Buffer.from(value.slice(7), 'hex');
}

function u64be(value, label = 'length') {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('S5_CHAIN_LENGTH', `${label} must be a non-negative safe integer`);
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function absoluteIri(value, label) {
  if (typeof value !== 'string'
      || value.length === 0
      || value !== value.normalize('NFC')
      || /[\u0000-\u0020\u007f]/u.test(value)) {
    fail('S5_CHAIN_IRI', `${label} must be an absolute normalized IRI`);
  }
  try {
    const parsed = new URL(value);
    if (!parsed.protocol || parsed.href !== value) {
      fail('S5_CHAIN_IRI', `${label} must be absolute and canonical`);
    }
  } catch (error) {
    if (error instanceof S5ControlChainError) throw error;
    fail('S5_CHAIN_IRI', `${label} must be an absolute normalized IRI`);
  }
  return value;
}

function recordId(value, label) {
  if (typeof value !== 'string' || !RECORD_ID_RE.test(value)) {
    fail('S5_CHAIN_RECORD_ID', `${label} must be an ASCII RecordId`);
  }
  return value;
}

function asciiId(value, label) {
  if (typeof value !== 'string' || !ASCII_ID_RE.test(value)) {
    fail('S5_CHAIN_ASCII_ID', `${label} must be a non-empty ASCII identifier`);
  }
  return value;
}

function instantEpoch(value, label) {
  const match = typeof value === 'string' ? value.match(INSTANT_RE) : null;
  if (!match) fail('S5_CHAIN_INSTANT', `${label} must be RFC 3339 UTC at whole-second precision`);
  const [, year, month, day, hour, minute, second] = match;
  const milliseconds = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  );
  if (!Number.isFinite(milliseconds)
      || new Date(milliseconds).toISOString() !== `${value.slice(0, -1)}.000Z`) {
    fail('S5_CHAIN_INSTANT', `${label} must be a real UTC instant`);
  }
  return milliseconds;
}

function dateEpoch(value, label) {
  const match = typeof value === 'string' ? value.match(DATE_RE) : null;
  if (!match) fail('S5_CHAIN_DATE', `${label} must be an ISO 8601 calendar date`);
  const [, year, month, day] = match;
  const milliseconds = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (!Number.isFinite(milliseconds)
      || new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    fail('S5_CHAIN_DATE', `${label} must be a real ISO 8601 calendar date`);
  }
  return milliseconds;
}

function refSortKey(ref) {
  const result = validateArtifactRef(ref);
  if (!result.ok) fail('S5_CHAIN_ARTIFACT_REF', result.errors.join('; '));
  if (ref.kind === 'iri') return `iri\0${ref.iri}`;
  return `path\0${ref.root}\0${ref.path}`;
}

function refsEqual(left, right) {
  return canonicalJcs(left) === canonicalJcs(right);
}

function mediaTypeForPath(relativePath) {
  if (relativePath.endsWith('.json')) return 'application/json';
  if (relativePath.endsWith('.nq')) return 'application/n-quads';
  if (relativePath.endsWith('.ttl')) return 'text/turtle';
  if (relativePath.endsWith('.yaml') || relativePath.endsWith('.yml')) {
    return 'application/yaml';
  }
  return 'application/octet-stream';
}

function createResolver(roots) {
  exactKeys(roots, ['buildEvidence', 'sourceTree'], 'artifact roots', 'S5_CHAIN_ROOT');
  const normalized = {};
  for (const [name, value] of Object.entries(roots)) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      fail('S5_CHAIN_ROOT', `${name} root must be an absolute path`);
    }
    if (!fs.existsSync(value) || !fs.statSync(value).isDirectory()) {
      fail('S5_CHAIN_ROOT', `${name} root must be an existing directory`);
    }
    normalized[name] = fs.realpathSync(value);
  }

  function resolve(ref, label, allowedRoots = ['sourceTree', 'buildEvidence']) {
    const validation = validateArtifactRef(ref, label);
    if (!validation.ok) fail('S5_CHAIN_ARTIFACT_REF', validation.errors.join('; '));
    if (ref.kind !== 'path') {
      fail('S5_CHAIN_ARTIFACT_REF', `${label} absolute IRI requires a locked payload catalog`);
    }
    if (!allowedRoots.includes(ref.root) || !(ref.root in normalized)) {
      fail('S5_CHAIN_ARTIFACT_ROOT', `${label} uses forbidden/unavailable root ${ref.root}`);
    }
    const root = normalized[ref.root];
    const candidate = path.resolve(root, ...ref.path.split('/'));
    const relative = path.relative(root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail('S5_CHAIN_ARTIFACT_REF', `${label} escapes ${ref.root}`);
    }
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      fail('S5_CHAIN_ARTIFACT_MISSING', `${label} does not resolve to a regular file`);
    }
    if (fs.lstatSync(candidate).isSymbolicLink()) {
      fail('S5_CHAIN_ARTIFACT_REF', `${label} must not be a symbolic link`);
    }
    const real = fs.realpathSync(candidate);
    const realRelative = path.relative(root, real);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`)) {
      fail('S5_CHAIN_ARTIFACT_REF', `${label} resolves outside ${ref.root}`);
    }
    return real;
  }

  function read(ref, label, allowedRoots) {
    const file = resolve(ref, label, allowedRoots);
    const bytes = fs.readFileSync(file);
    return {
      bytes,
      digest: artifactDigest(bytes),
      file,
      mediaType: mediaTypeForPath(ref.path),
    };
  }

  function readJson(ref, label, options = {}) {
    const artifact = read(ref, label, options.allowedRoots);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes);
    } catch (error) {
      fail('S5_CHAIN_JSON', `${label} is not valid UTF-8: ${error.message}`);
    }
    if (text.charCodeAt(0) === 0xfeff) {
      fail('S5_CHAIN_JSON', `${label} must not contain a UTF-8 BOM`);
    }
    let value;
    try {
      value = parseJsonRejectingDuplicateMembers(text);
    } catch (error) {
      fail('S5_CHAIN_JSON', `${label} is not JSON: ${error.message}`);
    }
    if (options.exactJcs === true
        && text !== canonicalJcs(value)) {
      fail('S5_CHAIN_JCS', `${label} bytes must equal exact RFC 8785 JCS`);
    }
    return { ...artifact, value };
  }

  return { read, readJson, resolve, roots: normalized };
}

function pathRef(root, relativePath) {
  return { kind: 'path', root, path: relativePath };
}

function ensureEmptyBuildRoot(directory) {
  const entries = fs.readdirSync(directory);
  if (entries.length !== 0) {
    fail('S5_CHAIN_BUILD_ROOT', 'buildEvidence root must be verified empty before generation');
  }
}

function writeBuildBytes(resolver, relativePath, bytes) {
  const ref = pathRef('buildEvidence', relativePath);
  const validation = validateArtifactRef(ref);
  if (!validation.ok) fail('S5_CHAIN_ARTIFACT_REF', validation.errors.join('; '));
  const target = path.resolve(resolver.roots.buildEvidence, ...relativePath.split('/'));
  const relative = path.relative(resolver.roots.buildEvidence, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('S5_CHAIN_ARTIFACT_REF', `${relativePath} escapes buildEvidence`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fail('S5_CHAIN_BUILD_COLLISION', `${relativePath} already exists`);
  fs.writeFileSync(target, bytes);
  return { ref, digest: artifactDigest(bytes), byteLength: bytes.length };
}

function writeBuildJcs(resolver, relativePath, value) {
  return writeBuildBytes(resolver, relativePath, Buffer.from(canonicalJcs(value), 'utf8'));
}

function validateArtifactBinding(binding, label, resolver, allowedRoots) {
  exactKeys(binding, ['artifactDigest', 'artifactRef', 'mediaType', 'name'], label);
  asciiId(binding.name, `${label}.name`);
  if (typeof binding.mediaType !== 'string' || !MEDIA_TYPE_RE.test(binding.mediaType)) {
    fail('S5_CHAIN_MEDIA_TYPE', `${label}.mediaType must be a canonical media type`);
  }
  rawDigestBytes(binding.artifactDigest, `${label}.artifactDigest`);
  const artifact = resolver.read(binding.artifactRef, `${label}.artifactRef`, allowedRoots);
  if (artifact.digest !== binding.artifactDigest) {
    fail('S5_CHAIN_ARTIFACT_DIGEST', `${label} digest does not match resolved bytes`);
  }
  return artifact;
}

function validateArtifactBindings(bindings, label, resolver, options = {}) {
  if (!Array.isArray(bindings) || (options.nonEmpty !== false && bindings.length === 0)) {
    fail('S5_CHAIN_ARTIFACT_BINDING', `${label} must be a non-empty ArtifactBinding list`);
  }
  const names = [];
  const pairs = new Set();
  for (const [index, binding] of bindings.entries()) {
    validateArtifactBinding(binding, `${label}[${index}]`, resolver, options.allowedRoots);
    names.push(binding.name);
    const pair = `${refSortKey(binding.artifactRef)}\0${binding.artifactDigest}`;
    if (pairs.has(pair)) fail('S5_CHAIN_ARTIFACT_BINDING', `${label} repeats one ref/digest pair`);
    pairs.add(pair);
  }
  sortedUniqueStrings(names, `${label}.names`, { nonEmpty: options.nonEmpty });
}

function binding(name, artifactRef, artifactDigestValue, mediaType = 'application/json') {
  return { name, artifactRef, mediaType, artifactDigest: artifactDigestValue };
}

function sourceSnapshotRootDigest(inputDatasets) {
  if (!Array.isArray(inputDatasets) || inputDatasets.length === 0) {
    fail('S5_CHAIN_SNAPSHOT_ROOT', 'inputDatasets must be non-empty');
  }
  const ordered = [...inputDatasets].sort((left, right) => utf8Compare(left.dataset, right.dataset));
  const parts = [Buffer.from('axiolune-source-snapshot-root-v1\0', 'utf8'), u64be(ordered.length)];
  const seen = new Set();
  for (const [index, snapshot] of ordered.entries()) {
    exactKeys(
      snapshot,
      [
        'artifactDigest', 'dataset',
        ...('rowCount' in snapshot ? ['rowCount'] : []),
        'schemaDigest', 'snapshotRef', 'snapshotTime',
      ],
      `inputDatasets[${index}]`,
    );
    absoluteIri(snapshot.dataset, `inputDatasets[${index}].dataset`);
    const snapshotRefKey = refSortKey(snapshot.snapshotRef);
    instantEpoch(snapshot.snapshotTime, `inputDatasets[${index}].snapshotTime`);
    rawDigestBytes(snapshot.artifactDigest, `inputDatasets[${index}].artifactDigest`);
    rawDigestBytes(snapshot.schemaDigest, `inputDatasets[${index}].schemaDigest`);
    if ('rowCount' in snapshot
        && (!Number.isSafeInteger(snapshot.rowCount) || snapshot.rowCount < 0)) {
      fail(
        'S5_CHAIN_SNAPSHOT_ROOT',
        `inputDatasets[${index}].rowCount must be a non-negative safe integer`,
      );
    }
    if (seen.has(snapshot.dataset)) fail('S5_CHAIN_SNAPSHOT_ROOT', 'duplicate dataset IRI');
    seen.add(snapshot.dataset);
    const datasetBytes = Buffer.from(snapshot.dataset, 'utf8');
    const refBytes = Buffer.from(snapshotRefKey, 'utf8');
    parts.push(
      u64be(datasetBytes.length), datasetBytes,
      u64be(refBytes.length), refBytes,
      rawDigestBytes(snapshot.artifactDigest, 'artifactDigest'),
      rawDigestBytes(snapshot.schemaDigest, 'schemaDigest'),
    );
  }
  return artifactDigest(Buffer.concat(parts));
}

function sourceSchemaClosureDigest(inputDatasets) {
  const ordered = [...inputDatasets].sort((left, right) => utf8Compare(left.dataset, right.dataset));
  const parts = [Buffer.from('axiolune-source-schema-closure-v1\0', 'utf8'), u64be(ordered.length)];
  for (const snapshot of ordered) {
    const dataset = Buffer.from(snapshot.dataset, 'utf8');
    parts.push(u64be(dataset.length), dataset, rawDigestBytes(snapshot.schemaDigest, 'schemaDigest'));
  }
  return artifactDigest(Buffer.concat(parts));
}

function artifactRefDigestBytes(ref) {
  return Buffer.from(refSortKey(ref), 'utf8');
}

function mappingClosureDigest(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('S5_CHAIN_MAPPING_ROOT', 'mapping closure must be non-empty');
  }
  const ordered = [...entries].sort((left, right) => utf8Compare(left.mappingRef, right.mappingRef));
  const parts = [Buffer.from('axiolune-mapping-closure-v1\0', 'utf8'), u64be(ordered.length)];
  const seen = new Set();
  for (const [index, entry] of ordered.entries()) {
    exactKeys(
      entry,
      ['mappingRef', 'mappingSourceDigest', 'transformationClosureDigest', 'transformationClosureRef'],
      `mappingClosure[${index}]`,
    );
    absoluteIri(entry.mappingRef, `mappingClosure[${index}].mappingRef`);
    if (seen.has(entry.mappingRef)) fail('S5_CHAIN_MAPPING_ROOT', 'duplicate mappingRef');
    seen.add(entry.mappingRef);
    const mappingBytes = Buffer.from(entry.mappingRef, 'utf8');
    const closureBytes = artifactRefDigestBytes(entry.transformationClosureRef);
    parts.push(
      u64be(mappingBytes.length), mappingBytes,
      rawDigestBytes(entry.mappingSourceDigest, 'mappingSourceDigest'),
      u64be(closureBytes.length), closureBytes,
      rawDigestBytes(entry.transformationClosureDigest, 'transformationClosureDigest'),
    );
  }
  return artifactDigest(Buffer.concat(parts));
}

function sourceTreeDigest(files) {
  if (!Array.isArray(files) || files.length === 0) {
    fail('S5_CHAIN_SOURCE_TREE', 'source-tree file inventory must be non-empty');
  }
  const ordered = [...files].sort((left, right) => utf8Compare(left.path, right.path));
  const parts = [Buffer.from('axiolune-source-tree-v1\0', 'utf8'), u64be(ordered.length)];
  const normalizedPaths = new Set();
  const foldedPaths = new Set();
  for (const [index, file] of ordered.entries()) {
    exactKeys(file, ['artifactDigest', 'byteLength', 'bytes', 'mode', 'path'], `sourceFiles[${index}]`);
    if (!['100644', '100755'].includes(file.mode)) fail('S5_CHAIN_SOURCE_TREE', 'unsupported file mode');
    if (file.path !== file.path.normalize('NFC') || file.path.includes('\\') || path.isAbsolute(file.path)) {
      fail('S5_CHAIN_SOURCE_TREE', 'source path must be NFC POSIX relative');
    }
    if (file.path.split('/').some((segment) => ['', '.', '..'].includes(segment))) {
      fail('S5_CHAIN_SOURCE_TREE', 'source path contains an unsafe segment');
    }
    const folded = file.path.toLocaleLowerCase('en-US');
    if (normalizedPaths.has(file.path) || foldedPaths.has(folded)) {
      fail('S5_CHAIN_SOURCE_TREE', 'duplicate or case-fold-colliding source path');
    }
    normalizedPaths.add(file.path);
    foldedPaths.add(folded);
    if (!Buffer.isBuffer(file.bytes)
        || file.byteLength !== file.bytes.length
        || file.artifactDigest !== artifactDigest(file.bytes)) {
      fail('S5_CHAIN_SOURCE_TREE', `${file.path} bytes/digest mismatch`);
    }
    const mode = Buffer.from(file.mode, 'ascii');
    const filePath = Buffer.from(file.path, 'utf8');
    parts.push(
      u64be(mode.length), mode,
      u64be(filePath.length), filePath,
      u64be(file.bytes.length), file.bytes,
    );
  }
  return artifactDigest(Buffer.concat(parts));
}

function controlRecordIri(buildId, slotId, recordType, id, attemptId, plannedDigest) {
  rawDigestBytes(buildId, 'buildId');
  recordId(slotId, 'slotId');
  recordId(id, 'recordId');
  recordId(attemptId, 'attemptId');
  if (!(recordType in RECORD_TYPE_ID_FIELD)) fail('S5_CHAIN_RECORD_TYPE', `unknown ${recordType}`);
  const parts = [Buffer.from('axiolune-control-record-iri-v1\0', 'utf8'), rawDigestBytes(buildId, 'buildId')];
  for (const value of [slotId, recordType, id, attemptId]) {
    const bytes = Buffer.from(value, 'utf8');
    parts.push(u64be(bytes.length), bytes);
  }
  parts.push(rawDigestBytes(plannedDigest, 'plannedInputDigest'));
  const hash = crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex');
  return `urn:axiolune:control:${recordType}:sha256-${hash}`;
}

function projectResolvedInput(record) {
  const fields = RESOLVED_PROJECTION_FIELDS[record.recordType];
  if (!fields) fail('S5_CHAIN_RECORD_TYPE', `unsupported recordType ${String(record.recordType)}`);
  const projection = {};
  for (const field of fields) {
    if (!(field in record)) fail('S5_CHAIN_RESOLVED_INPUT', `${record.recordType}.${field} is missing`);
    projection[field] = record[field];
  }
  if (record.recordType === 'validationReport' && record.reportKind === 'pit') {
    for (const field of VALIDATION_PIT_EXTRA_FIELDS) {
      if (!(field in record)) fail('S5_CHAIN_RESOLVED_INPUT', `PIT report.${field} is missing`);
      projection[field] = record[field];
    }
  }
  return projection;
}

function plannedInputDigest(recordType, value) {
  return taggedJcsDigest(`axiolune-control-planned-input-${recordType}-v1\0`, value);
}

function resolvedInputDigest(record) {
  return taggedJcsDigest(
    `axiolune-control-resolved-input-${record.recordType}-v1\0`,
    projectResolvedInput(record),
  );
}

function recordDigest(record) {
  return artifactDigest(Buffer.from(canonicalJcs(record), 'utf8'));
}

function canonicalRecordBytes(record) {
  return Buffer.from(canonicalJcs(record), 'utf8');
}

function validateExecutionError(value, label) {
  const optional = ['causeDigest', 'constraintRef', 'sourcePath'].filter((field) => field in value);
  exactKeys(value, ['code', 'message', 'stage', ...optional], label);
  asciiId(value.code, `${label}.code`);
  asciiId(value.stage, `${label}.stage`);
  if (typeof value.message !== 'string' || value.message.length === 0 || value.message !== value.message.normalize('NFC')) {
    fail('S5_CHAIN_EXECUTION_ERROR', `${label}.message must be non-empty NFC text`);
  }
  if ('sourcePath' in value) {
    const result = validateArtifactRef(pathRef('sourceTree', value.sourcePath));
    if (!result.ok) fail('S5_CHAIN_EXECUTION_ERROR', `${label}.sourcePath is unsafe`);
  }
  if ('constraintRef' in value) absoluteIri(value.constraintRef, `${label}.constraintRef`);
  if ('causeDigest' in value) rawDigestBytes(value.causeDigest, `${label}.causeDigest`);
}

function executionErrorSortKey(value) {
  return [
    value.stage, value.code,
    'sourcePath' in value ? '1' : '0', value.sourcePath || '',
    'constraintRef' in value ? '1' : '0', value.constraintRef || '',
    'causeDigest' in value ? '1' : '0', value.causeDigest || '',
    value.message,
  ];
}

function validateSortedErrors(errors, label) {
  if (!Array.isArray(errors) || errors.length === 0) {
    fail('S5_CHAIN_EXECUTION_ERROR', `${label} must be non-empty`);
  }
  errors.forEach((entry, index) => validateExecutionError(entry, `${label}[${index}]`));
  const sorted = [...errors].sort((left, right) => tupleCompare(
    executionErrorSortKey(left), executionErrorSortKey(right),
  ));
  if (sorted.some((entry, index) => canonicalJcs(entry) !== canonicalJcs(errors[index]))) {
    fail('S5_CHAIN_EXECUTION_ERROR', `${label} must be deterministically sorted`);
  }
  if (new Set(errors.map(canonicalJcs)).size !== errors.length) {
    fail('S5_CHAIN_EXECUTION_ERROR', `${label} contains duplicate errors`);
  }
}

function validateBuildEvidence(build, label, context) {
  exactKeys(
    build,
    [
      'buildId', 'buildInputsDigest', 'buildInputsRef',
      'controlRecordPlanDigest', 'controlRecordPlanRef',
      'controlRecordSchemaManifestDigest', 'controlRecordSchemaManifestRef',
      'sourceTreeDigest', 'toolLockDigest', 'toolLockRef',
    ],
    label,
  );
  for (const field of [
    'buildId', 'buildInputsDigest', 'controlRecordPlanDigest',
    'controlRecordSchemaManifestDigest', 'sourceTreeDigest', 'toolLockDigest',
  ]) rawDigestBytes(build[field], `${label}.${field}`);
  const sourceOnly = ['sourceTree'];
  const sourceOrBuild = ['sourceTree', 'buildEvidence'];
  context.resolver.resolve(build.toolLockRef, `${label}.toolLockRef`, sourceOnly);
  context.resolver.resolve(
    build.controlRecordSchemaManifestRef,
    `${label}.controlRecordSchemaManifestRef`,
    sourceOnly,
  );
  context.resolver.resolve(build.buildInputsRef, `${label}.buildInputsRef`, ['buildEvidence']);
  context.resolver.resolve(build.controlRecordPlanRef, `${label}.controlRecordPlanRef`, sourceOrBuild);
  if (build.toolLockDigest !== context.toolLockDigest
      || build.controlRecordSchemaManifestDigest !== context.schemaManifestDigest
      || build.controlRecordPlanDigest !== context.planDigest
      || build.buildInputsDigest !== context.buildInputsDigest
      || build.sourceTreeDigest !== context.sourceTreeDigest
      || build.buildId !== context.buildId) {
    fail('S5_CHAIN_BUILD_BINDING', `${label} does not equal the recomputed build closure`);
  }
}

function validateCommonRecord(record, alternative, context, label) {
  if (!isPlainObject(record)) fail('S5_CHAIN_RECORD', `${label} must be an object`);
  const expectedFields = [...RECORD_FIELDS[record.recordType] || []];
  if (record.recordType === 'validationReport' && record.reportKind === 'pit') {
    expectedFields.push(...VALIDATION_PIT_EXTRA_FIELDS);
  }
  exactKeys(record, expectedFields, label, 'S5_CHAIN_RECORD_SCHEMA');
  if (record.schemaVersion !== '1.0') fail('S5_CHAIN_RECORD_SCHEMA', `${label}.schemaVersion drift`);
  if (record.recordType !== alternative.recordType) fail('S5_CHAIN_PLAN_SELECTION', `${label}.recordType drift`);
  const idField = RECORD_TYPE_ID_FIELD[record.recordType];
  recordId(record.slotId, `${label}.slotId`);
  recordId(record[idField], `${label}.${idField}`);
  recordId(record.attemptId, `${label}.attemptId`);
  if (record.slotId !== alternative.slotId
      || record[idField] !== alternative.recordId
      || record.attemptId !== alternative.attemptId) {
    fail('S5_CHAIN_PLAN_SELECTION', `${label} identity does not equal the active plan alternative`);
  }
  if (record.plannedInputDigest !== alternative.plannedInputDigest) {
    fail('S5_CHAIN_PLANNED_INPUT', `${label}.plannedInputDigest drift`);
  }
  const expectedIri = controlRecordIri(
    context.buildId, record.slotId, record.recordType,
    record[idField], record.attemptId, record.plannedInputDigest,
  );
  if (record.iri !== expectedIri) fail('S5_CHAIN_CONTROL_IRI', `${label}.iri does not recompute`);
  if (record.resolvedInputDigest !== resolvedInputDigest(record)) {
    fail('S5_CHAIN_RESOLVED_INPUT', `${label}.resolvedInputDigest does not recompute`);
  }
  validateBuildEvidence(record.build, `${label}.build`, context);
}

function validateControlRecordRef(ref, digest, label, context, expectedRecordType) {
  absoluteIri(ref, `${label}.ref`);
  rawDigestBytes(digest, `${label}.digest`);
  const artifact = context.recordArtifactsByIri.get(ref);
  if (!artifact) {
    fail('S5_CHAIN_RECORD_IRI_MISSING', `${label} IRI is absent from the preloaded control-record set`);
  }
  if (artifact.digest !== digest) fail('S5_CHAIN_RECORD_DIGEST', `${label} digest mismatch`);
  const { record } = artifact;
  if (record.recordType !== expectedRecordType) {
    fail('S5_CHAIN_RECORD_TYPE', `${label} is not ${expectedRecordType}`);
  }
  return record;
}

function indexControlRecordsByIri(recordArtifacts) {
  const byIri = new Map();
  for (const [slotId, artifact] of recordArtifacts.entries()) {
    const iri = absoluteIri(artifact.record?.iri, `records/${slotId}.iri`);
    const existing = byIri.get(iri);
    if (existing) {
      if (existing.digest !== artifact.digest || !existing.bytes.equals(artifact.bytes)) {
        fail(
          'S5_CHAIN_CONTROL_COLLISION',
          `control-record IRI ${iri} identifies different JCS bytes/digests`,
        );
      }
      fail('S5_CHAIN_RECORD_IRI_DUPLICATE', `control-record IRI ${iri} is duplicated`);
    }
    byIri.set(iri, artifact);
  }
  return byIri;
}

function validateMaterializationRun(record, context, label) {
  absoluteIri(record.planRef, `${label}.planRef`);
  rawDigestBytes(record.planSourceDigest, `${label}.planSourceDigest`);
  rawDigestBytes(record.sourceSchemaClosureDigest, `${label}.sourceSchemaClosureDigest`);
  rawDigestBytes(record.sourceSnapshotRootDigest, `${label}.sourceSnapshotRootDigest`);
  rawDigestBytes(record.mappingClosureDigest, `${label}.mappingClosureDigest`);
  rawDigestBytes(record.ontologyClosureDigest, `${label}.ontologyClosureDigest`);
  rawDigestBytes(record.referenceLockDigest, `${label}.referenceLockDigest`);
  for (const field of ['compilerDigest', 'validatorDigest', 'executorDigest']) {
    rawDigestBytes(record[field], `${label}.${field}`);
  }
  if (record.outputRdfCanonicalization !== 'RDFC-1.0') {
    fail('S5_CHAIN_RDFC', `${label} must use RDFC-1.0`);
  }
  instantEpoch(record.assertionTime, `${label}.assertionTime`);
  instantEpoch(record.referenceTime, `${label}.referenceTime`);
  const computedSnapshotRoot = sourceSnapshotRootDigest(record.inputDatasets);
  if (computedSnapshotRoot !== record.sourceSnapshotRootDigest
      || sourceSchemaClosureDigest(record.inputDatasets) !== record.sourceSchemaClosureDigest) {
    fail('S5_CHAIN_SNAPSHOT_ROOT', `${label} source snapshot/schema root drift`);
  }
  if (mappingClosureDigest(record.mappingClosure) !== record.mappingClosureDigest) {
    fail('S5_CHAIN_MAPPING_ROOT', `${label} mapping closure root drift`);
  }
  for (const [index, snapshot] of record.inputDatasets.entries()) {
    const artifact = context.resolver.read(
      snapshot.snapshotRef,
      `${label}.inputDatasets[${index}].snapshotRef`,
      ['sourceTree', 'buildEvidence'],
    );
    if (artifact.digest !== snapshot.artifactDigest) {
      fail('S5_CHAIN_SNAPSHOT_DIGEST', `${label}.inputDatasets[${index}] snapshot bytes/digest mismatch`);
    }
  }
  if (record.result.outcome === 'completed') {
    exactKeys(
      record.result,
      [
        'outcome', 'outputFactVersionCount', 'outputGraph', 'outputGraphDigest',
        'validationReportDigest', 'validationReportRef',
      ],
      `${label}.result`,
    );
    absoluteIri(record.result.outputGraph, `${label}.result.outputGraph`);
    rawDigestBytes(record.result.outputGraphDigest, `${label}.result.outputGraphDigest`);
    if (!Number.isSafeInteger(record.result.outputFactVersionCount)
        || record.result.outputFactVersionCount < 0) {
      fail('S5_CHAIN_FACT_COUNT', `${label}.outputFactVersionCount must be non-negative`);
    }
    validateControlRecordRef(
      record.result.validationReportRef,
      record.result.validationReportDigest,
      `${label}.validationReport`,
      context,
      'validationReport',
    );
  } else if (record.result.outcome === 'failed') {
    exactKeys(
      record.result,
      ['errors', 'failureReportDigest', 'failureReportRef', 'failureStage', 'outcome'],
      `${label}.result`,
    );
    asciiId(record.result.failureStage, `${label}.result.failureStage`);
    validateSortedErrors(record.result.errors, `${label}.result.errors`);
    const report = validateControlRecordRef(
      record.result.failureReportRef,
      record.result.failureReportDigest,
      `${label}.failureReport`,
      context,
      'failureReport',
    );
    if (canonicalJcs(report.errors) !== canonicalJcs(record.result.errors)
        || report.failureStage !== record.result.failureStage) {
      fail('S5_CHAIN_FAILURE_BINDING', `${label} failure result/report mismatch`);
    }
  } else {
    fail('S5_CHAIN_OUTCOME', `${label}.result has forbidden outcome`);
  }
}

function validateBatchRun(record, context, label) {
  absoluteIri(record.batchRef, `${label}.batchRef`);
  absoluteIri(record.targetDataset, `${label}.targetDataset`);
  if (record.targetDataset.endsWith('/')) fail('S5_CHAIN_BATCH', 'targetDataset must not end in /');
  for (const field of [
    'batchSourceDigest', 'sourceSnapshotRootDigest', 'ontologyClosureDigest',
    'referenceLockDigest', 'compilerDigest', 'validatorDigest', 'executorDigest',
  ]) rawDigestBytes(record[field], `${label}.${field}`);
  if (record.outputRdfCanonicalization !== 'RDFC-1.0') fail('S5_CHAIN_RDFC', `${label} must use RDFC-1.0`);
  instantEpoch(record.assertionTime, `${label}.assertionTime`);
  instantEpoch(record.referenceTime, `${label}.referenceTime`);
  if (record.result.outcome === 'completed') {
    exactKeys(
      record.result,
      ['members', 'outcome', 'outputDatasetDigest', 'validationReportDigest', 'validationReportRef'],
      `${label}.result`,
    );
    if (!Array.isArray(record.result.members) || record.result.members.length < 2) {
      fail('S5_CHAIN_BATCH', `${label}.members must contain at least two completed runs`);
    }
    const planRefs = [];
    for (const [index, member] of record.result.members.entries()) {
      exactKeys(
        member,
        ['outputGraph', 'outputGraphDigest', 'planRef', 'runRecordDigest', 'runRef'],
        `${label}.members[${index}]`,
      );
      absoluteIri(member.planRef, `${label}.members[${index}].planRef`);
      absoluteIri(member.runRef, `${label}.members[${index}].runRef`);
      absoluteIri(member.outputGraph, `${label}.members[${index}].outputGraph`);
      rawDigestBytes(member.runRecordDigest, `${label}.members[${index}].runRecordDigest`);
      rawDigestBytes(member.outputGraphDigest, `${label}.members[${index}].outputGraphDigest`);
      planRefs.push(member.planRef);
    }
    sortedUniqueStrings(planRefs, `${label}.members.planRefs`);
    rawDigestBytes(record.result.outputDatasetDigest, `${label}.result.outputDatasetDigest`);
    validateControlRecordRef(
      record.result.validationReportRef,
      record.result.validationReportDigest,
      `${label}.validationReport`,
      context,
      'validationReport',
    );
  } else if (record.result.outcome === 'failed') {
    exactKeys(
      record.result,
      ['attemptedMembers', 'errors', 'failureReportDigest', 'failureReportRef', 'failureStage', 'outcome'],
      `${label}.result`,
    );
    validateSortedErrors(record.result.errors, `${label}.result.errors`);
    validateControlRecordRef(
      record.result.failureReportRef,
      record.result.failureReportDigest,
      `${label}.failureReport`,
      context,
      'failureReport',
    );
  } else {
    fail('S5_CHAIN_OUTCOME', `${label}.result has forbidden outcome`);
  }
}

function validatePitRequest(record, context, label) {
  for (const field of ['asOfValid', 'asOfKnowledge', 'asOfAvailable']) {
    instantEpoch(record[field], `${label}.${field}`);
  }
  if (record.targetRdfCanonicalization !== 'RDFC-1.0') fail('S5_CHAIN_RDFC', `${label} must use RDFC-1.0`);
  const referenceTime = context.referenceTime;
  if (instantEpoch(record.asOfKnowledge, `${label}.asOfKnowledge`) > referenceTime
      || instantEpoch(record.asOfAvailable, `${label}.asOfAvailable`) > referenceTime) {
    fail('S5_CHAIN_FUTURE_PIVOT', `${label} knowledge/availability pivot exceeds referenceTime`);
  }
  context.resolver.resolve(record.validatorRef, `${label}.validatorRef`, ['sourceTree']);
  rawDigestBytes(record.validatorDigest, `${label}.validatorDigest`);
  exactKeys(
    record.materializationContext,
    ['contextKind', 'recordDigest', 'recordRef', 'targetDataset', 'targetDatasetDigest'],
    `${label}.materializationContext`,
  );
  if (record.materializationContext.contextKind !== 'materializationBatchRun') {
    fail('S5_CHAIN_PIT_CONTEXT', `${label} must bind one batch dataset context`);
  }
  const batch = validateControlRecordRef(
    record.materializationContext.recordRef,
    record.materializationContext.recordDigest,
    `${label}.context`,
    context,
    'materializationBatchRun',
  );
  if (batch.result.outcome !== 'completed'
      || batch.targetDataset !== record.materializationContext.targetDataset
      || batch.result.outputDatasetDigest !== record.materializationContext.targetDatasetDigest) {
    fail('S5_CHAIN_PIT_CONTEXT', `${label} context does not equal the completed batch output`);
  }
}

function validateGateCheck(check, inventoryRow, report, label, context) {
  exactKeys(
    check,
    [
      'capabilityDigest', 'capabilityId', 'capabilityRef', 'checkId',
      'entrypointDigest', 'entrypointRef', 'evidenceDigest', 'evidenceRef',
      'inputDigests', 'outputDigests', 'status', 'subjectDigest', 'subjectId',
      'subjectRef', 'toolId',
    ],
    label,
  );
  asciiId(check.checkId, `${label}.checkId`);
  if (check.status !== 'passed') fail('S5_CHAIN_GATE_RESULT', `${label}.status must be passed`);
  if (check.subjectId !== inventoryRow.subjectId
      || check.subjectDigest !== inventoryRow.subjectDigest
      || !refsEqual(check.subjectRef, inventoryRow.subjectRef)) {
    fail('S5_CHAIN_GATE_INVENTORY', `${label} does not equal its inventory row`);
  }
  for (const field of ['toolId', 'capabilityId', 'capabilityDigest', 'entrypointDigest']) {
    if (check[field] !== report[field]) fail('S5_CHAIN_TOOL_LOCK', `${label}.${field} does not equal report`);
  }
  if (!refsEqual(check.capabilityRef, report.capabilityRef)
      || !refsEqual(check.entrypointRef, report.entrypointRef)) {
    fail('S5_CHAIN_TOOL_LOCK', `${label} capability/entrypoint refs drift`);
  }
  sortedUniqueStrings(check.inputDigests, `${label}.inputDigests`, { nonEmpty: false });
  sortedUniqueStrings(check.outputDigests, `${label}.outputDigests`);
  const expectedInputDigests = [...new Set(
    report.inputs.map((entry) => entry.artifactDigest),
  )].sort(utf8Compare);
  if (canonicalJcs(check.inputDigests) !== canonicalJcs(expectedInputDigests)) {
    fail('S5_CHAIN_GATE_EVIDENCE', `${label}.inputDigests do not equal report inputs`);
  }
  if (!refsEqual(check.evidenceRef, report.kindEvidence.artifactRef)
      || check.evidenceDigest !== report.kindEvidence.artifactDigest) {
    fail('S5_CHAIN_GATE_EVIDENCE', `${label} evidence does not equal report kindEvidence`);
  }
  const evidence = context.resolver.read(check.evidenceRef, `${label}.evidenceRef`);
  if (evidence.digest !== check.evidenceDigest || evidence.bytes.length === 0) {
    fail('S5_CHAIN_GATE_EVIDENCE', `${label} evidence bytes/digest mismatch`);
  }
}

function validateValidationReport(record, context, label) {
  if (record.profileRef !== PROFILE_REF) fail('S5_CHAIN_GATE_PROFILE', `${label}.profileRef drift`);
  asciiId(record.gateId, `${label}.gateId`);
  if (!['mapping', 'batch', 'pit'].includes(record.reportKind)) {
    fail('S5_CHAIN_GATE_KIND', `${label}.reportKind is outside the S5 runtime profile`);
  }
  sortedUniqueStrings(record.criterionRefs, `${label}.criterionRefs`);
  if (record.criterionRefs.length !== 1 || record.criterionRefs[0] !== CRITERION_5) {
    fail('S5_CHAIN_GATE_PROFILE', `${label} must bind only M2 criterion 5`);
  }
  validateArtifactBindings(record.inputs, `${label}.inputs`, context.resolver);
  context.resolver.resolve(record.subjectRef, `${label}.subjectRef`);
  validateBuildEvidence(record.build, `${label}.build`, context);
  for (const field of ['capabilityDigest', 'entrypointDigest', 'discoveryContractDigest']) {
    rawDigestBytes(record[field], `${label}.${field}`);
  }
  for (const field of ['capabilityId', 'toolId']) asciiId(record[field], `${label}.${field}`);
  context.resolver.resolve(record.capabilityRef, `${label}.capabilityRef`, ['sourceTree']);
  context.resolver.resolve(record.entrypointRef, `${label}.entrypointRef`, ['sourceTree']);
  context.resolver.resolve(record.discoveryContractRef, `${label}.discoveryContractRef`, ['sourceTree']);
  const lockedTool = context.reportTool;
  if (!lockedTool
      || record.toolId !== lockedTool.toolId
      || record.capabilityId !== lockedTool.capabilityId
      || record.capabilityDigest !== lockedTool.capabilityDigest
      || record.entrypointDigest !== lockedTool.entrypointDigest
      || record.discoveryContractDigest !== lockedTool.discoveryContractDigest
      || !refsEqual(record.capabilityRef, lockedTool.capabilityRef)
      || !refsEqual(record.entrypointRef, lockedTool.entrypointRef)
      || !refsEqual(record.discoveryContractRef, lockedTool.discoveryContractRef)) {
    fail('S5_CHAIN_TOOL_LOCK', `${label} does not join the exact locked capability tuple`);
  }
  const inventoryArtifact = context.resolver.readJson(
    record.subjectInventoryRef,
    `${label}.subjectInventoryRef`,
    { allowedRoots: ['buildEvidence'], exactJcs: true },
  );
  const inventory = inventoryArtifact.value;
  exactKeys(
    inventory,
    ['discoveryContractDigest', 'discoveryContractRef', 'gateId', 'schemaVersion', 'subjects'],
    `${label}.subjectInventory`,
  );
  if (inventory.schemaVersion !== '1.0'
      || inventory.gateId !== record.gateId
      || inventory.discoveryContractDigest !== record.discoveryContractDigest
      || !refsEqual(inventory.discoveryContractRef, record.discoveryContractRef)) {
    fail('S5_CHAIN_GATE_INVENTORY', `${label} inventory header drift`);
  }
  if (record.subjectInventoryDigest
      !== taggedJcsDigest('axiolune-gate-subject-inventory-v1\0', inventory)) {
    fail('S5_CHAIN_GATE_INVENTORY', `${label}.subjectInventoryDigest does not recompute`);
  }
  if (!Array.isArray(inventory.subjects) || inventory.subjects.length === 0) {
    fail('S5_CHAIN_GATE_INVENTORY', `${label} inventory must be non-empty`);
  }
  if (inventory.subjects.length !== 1
      || !refsEqual(inventory.subjects[0].subjectRef, record.subjectRef)) {
    fail('S5_CHAIN_GATE_INVENTORY', `${label}.subjectRef does not equal its discovered subject`);
  }
  const subjectIds = [];
  for (const [index, subject] of inventory.subjects.entries()) {
    exactKeys(
      subject,
      ['classifier', 'subjectDigest', 'subjectId', 'subjectRef'],
      `${label}.subjectInventory.subjects[${index}]`,
    );
    asciiId(subject.classifier, `${label}.subjectInventory.subjects[${index}].classifier`);
    rawDigestBytes(subject.subjectDigest, `${label}.subjectInventory.subjects[${index}].subjectDigest`);
    rawDigestBytes(subject.subjectId, `${label}.subjectInventory.subjects[${index}].subjectId`);
    context.resolver.resolve(subject.subjectRef, `${label}.subjectInventory.subjects[${index}].subjectRef`);
    subjectIds.push(subject.subjectId);
  }
  sortedUniqueStrings(subjectIds, `${label}.subjectInventory.subjectIds`);
  exactKeys(record.kindEvidence, ['artifactDigest', 'artifactRef', 'schemaDigest', 'schemaRef'], `${label}.kindEvidence`);
  const kindSchema = context.resolver.read(record.kindEvidence.schemaRef, `${label}.kindEvidence.schemaRef`, ['sourceTree']);
  const kindArtifact = context.resolver.read(record.kindEvidence.artifactRef, `${label}.kindEvidence.artifactRef`);
  if (kindSchema.digest !== record.kindEvidence.schemaDigest
      || kindArtifact.digest !== record.kindEvidence.artifactDigest
      || kindArtifact.bytes.length === 0) {
    fail('S5_CHAIN_GATE_EVIDENCE', `${label} kind evidence bytes/digests drift`);
  }
  if (record.kindEvidence.schemaDigest !== lockedTool.evidenceSchemaDigest
      || !refsEqual(record.kindEvidence.schemaRef, lockedTool.evidenceSchemaRef)) {
    fail('S5_CHAIN_TOOL_LOCK', `${label} evidence schema does not join the locked capability`);
  }
  exactKeys(
    record.counts,
    ['discovered', 'executed', 'failed', 'passed', 'pending', 'skipped', 'warnings'],
    `${label}.counts`,
  );
  for (const [field, value] of Object.entries(record.counts)) {
    if (!Number.isSafeInteger(value) || value < 0) fail('S5_CHAIN_GATE_COUNTS', `${label}.counts.${field}`);
  }
  if (record.counts.discovered !== inventory.subjects.length
      || record.counts.executed !== inventory.subjects.length
      || record.counts.passed !== inventory.subjects.length
      || ['failed', 'pending', 'skipped', 'warnings'].some((field) => record.counts[field] !== 0)) {
    fail('S5_CHAIN_GATE_COUNTS', `${label} passed counts do not equal discovered subjects`);
  }
  exactKeys(record.result, ['checks', 'errors', 'outcome', 'violations'], `${label}.result`);
  if (record.result.outcome !== 'passed'
      || !Array.isArray(record.result.errors) || record.result.errors.length !== 0
      || !Array.isArray(record.result.violations) || record.result.violations.length !== 0
      || !Array.isArray(record.result.checks)
      || record.result.checks.length !== inventory.subjects.length) {
    fail('S5_CHAIN_GATE_RESULT', `${label} is not a complete passed result`);
  }
  const checks = [...record.result.checks].sort((left, right) => tupleCompare(
    [left.checkId, left.subjectId], [right.checkId, right.subjectId],
  ));
  if (checks.some((entry, index) => canonicalJcs(entry) !== canonicalJcs(record.result.checks[index]))) {
    fail('S5_CHAIN_GATE_RESULT', `${label}.checks are not canonically sorted`);
  }
  for (const [index, check] of record.result.checks.entries()) {
    const subject = inventory.subjects.find((entry) => entry.subjectId === check.subjectId);
    if (!subject) fail('S5_CHAIN_GATE_INVENTORY', `${label}.checks[${index}] subject is undiscovered`);
    validateGateCheck(check, subject, record, `${label}.checks[${index}]`, context);
  }
  if (record.reportKind === 'pit') {
    for (const field of ['asOfValid', 'asOfKnowledge', 'asOfAvailable']) {
      instantEpoch(record[field], `${label}.${field}`);
    }
    for (const field of ['requestRecordDigest', 'contextRecordDigest', 'recomputedTargetDigest']) {
      rawDigestBytes(record[field], `${label}.${field}`);
    }
    rawDigestBytes(record.selectedFactVersionSetDigest, `${label}.selectedFactVersionSetDigest`);
    if (!Number.isSafeInteger(record.selectedFactVersionCount)
        || record.selectedFactVersionCount < 1
        || !Array.isArray(record.selectedFactVersionIris)
        || record.selectedFactVersionIris.length !== record.selectedFactVersionCount) {
      fail('S5_CHAIN_PIT_SELECTION', `${label} selected FactVersion inventory is invalid`);
    }
    sortedUniqueStrings(record.selectedFactVersionIris, `${label}.selectedFactVersionIris`);
    validateControlRecordRef(record.requestRef, record.requestRecordDigest, `${label}.request`, context, 'pitRequest');
    validateControlRecordRef(
      record.contextRef,
      record.contextRecordDigest,
      `${label}.context`,
      context,
      'materializationBatchRun',
    );
  }
}

function validateFailureReport(record, context, label) {
  asciiId(record.failureStage, `${label}.failureStage`);
  validateArtifactBindings(record.inputs, `${label}.inputs`, context.resolver);
  validateSortedErrors(record.errors, `${label}.errors`);
  context.resolver.resolve(record.subjectRef, `${label}.subjectRef`);
}

function validateReplayReport(record, context, label) {
  for (const field of [
    'originalContextRecordDigest', 'originalTargetDigest',
    'replaySourceSnapshotRootDigest', 'replayMappingClosureDigest',
    'replayOntologyClosureDigest', 'replayReferenceLockDigest', 'replayToolLockDigest',
  ]) rawDigestBytes(record[field], `${label}.${field}`);
  const batch = validateControlRecordRef(
    record.originalContextRef,
    record.originalContextRecordDigest,
    `${label}.originalContext`,
    context,
    'materializationBatchRun',
  );
  if (batch.result.outcome !== 'completed'
      || batch.result.outputDatasetDigest !== record.originalTargetDigest) {
    fail('S5_CHAIN_REPLAY_CONTEXT', `${label} does not bind the completed original batch`);
  }
  context.resolver.resolve(record.originalTargetRef, `${label}.originalTargetRef`, ['buildEvidence']);
  exactKeys(record.result, ['comparisons', 'errors', 'outcome'], `${label}.result`);
  if (record.result.outcome !== 'identical'
      || !Array.isArray(record.result.errors) || record.result.errors.length !== 0
      || !Array.isArray(record.result.comparisons) || record.result.comparisons.length === 0) {
    fail('S5_CHAIN_REPLAY_RESULT', `${label} must be an identical replay result`);
  }
  const names = [];
  for (const [index, comparison] of record.result.comparisons.entries()) {
    exactKeys(
      comparison,
      ['artifactRef', 'equal', 'name', 'originalDigest', 'replayDigest'],
      `${label}.comparisons[${index}]`,
    );
    asciiId(comparison.name, `${label}.comparisons[${index}].name`);
    rawDigestBytes(comparison.originalDigest, `${label}.comparisons[${index}].originalDigest`);
    rawDigestBytes(comparison.replayDigest, `${label}.comparisons[${index}].replayDigest`);
    context.resolver.resolve(comparison.artifactRef, `${label}.comparisons[${index}].artifactRef`, ['buildEvidence']);
    if (comparison.equal !== true || comparison.originalDigest !== comparison.replayDigest) {
      fail('S5_CHAIN_REPLAY_MISMATCH', `${label}.${comparison.name} is not identical`);
    }
    names.push(comparison.name);
  }
  sortedUniqueStrings(names, `${label}.comparisonNames`);
}

function validateLedger(record, context, label) {
  if (!Array.isArray(record.slotSelections) || record.slotSelections.length === 0
      || !Array.isArray(record.entries) || record.entries.length === 0) {
    fail('S5_CHAIN_LEDGER', `${label} selections/entries must be non-empty`);
  }
  const selections = new Map();
  const selectionIds = [];
  for (const [index, selection] of record.slotSelections.entries()) {
    exactKeys(
      selection,
      ['attemptId', 'recordId', 'recordIri', 'recordType', 'slotId'],
      `${label}.slotSelections[${index}]`,
    );
    recordId(selection.slotId, `${label}.slotSelections[${index}].slotId`);
    recordId(selection.recordId, `${label}.slotSelections[${index}].recordId`);
    recordId(selection.attemptId, `${label}.slotSelections[${index}].attemptId`);
    absoluteIri(selection.recordIri, `${label}.slotSelections[${index}].recordIri`);
    if (selection.recordType === 'evidenceLedger') fail('S5_CHAIN_LEDGER', 'ledger cannot select itself');
    if (selections.has(selection.slotId)) fail('S5_CHAIN_LEDGER', 'duplicate slot selection');
    selections.set(selection.slotId, selection);
    selectionIds.push(selection.slotId);
  }
  sortedUniqueStrings(selectionIds, `${label}.slotSelections.slotIds`);
  const entryIds = [];
  const iriToDigest = new Map();
  const digestToIri = new Map();
  for (const [index, entry] of record.entries.entries()) {
    exactKeys(
      entry,
      [
        'byteLength', 'canonicalization', 'mediaType', 'recordDigest',
        'recordIri', 'recordType', 'slotId',
      ],
      `${label}.entries[${index}]`,
    );
    if (entry.mediaType !== 'application/json' || entry.canonicalization !== 'RFC8785-JCS') {
      fail('S5_CHAIN_LEDGER', `${label}.entries[${index}] media/canonicalization drift`);
    }
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0) {
      fail('S5_CHAIN_LEDGER', `${label}.entries[${index}].byteLength invalid`);
    }
    rawDigestBytes(entry.recordDigest, `${label}.entries[${index}].recordDigest`);
    const selection = selections.get(entry.slotId);
    if (!selection
        || selection.recordIri !== entry.recordIri
        || selection.recordType !== entry.recordType) {
      fail('S5_CHAIN_LEDGER', `${label}.entries[${index}] does not equal slot selection`);
    }
    const recordArtifact = context.recordArtifacts.get(entry.slotId);
    if (!recordArtifact
        || recordArtifact.digest !== entry.recordDigest
        || recordArtifact.bytes.length !== entry.byteLength) {
      fail('S5_CHAIN_LEDGER', `${label}.entries[${index}] bytes/digest mismatch`);
    }
    const oldDigest = iriToDigest.get(entry.recordIri);
    const oldIri = digestToIri.get(entry.recordDigest);
    if ((oldDigest && oldDigest !== entry.recordDigest)
        || (oldIri && oldIri !== entry.recordIri)) {
      fail('S5_CHAIN_CONTROL_COLLISION', 'control IRI and record digest are not one-to-one');
    }
    iriToDigest.set(entry.recordIri, entry.recordDigest);
    digestToIri.set(entry.recordDigest, entry.recordIri);
    entryIds.push(entry.slotId);
  }
  sortedUniqueStrings(entryIds, `${label}.entries.slotIds`);
  if (selectionIds.length !== entryIds.length
      || selectionIds.some((slotId, index) => slotId !== entryIds[index])) {
    fail('S5_CHAIN_LEDGER', `${label} selection and entry slot sets differ`);
  }
}

function validateRecordByType(record, alternative, context) {
  const label = `record(${alternative.slotId})`;
  validateCommonRecord(record, alternative, context, label);
  if (record.recordType === 'materializationRun') validateMaterializationRun(record, context, label);
  else if (record.recordType === 'materializationBatchRun') validateBatchRun(record, context, label);
  else if (record.recordType === 'pitRequest') validatePitRequest(record, context, label);
  else if (record.recordType === 'validationReport') validateValidationReport(record, context, label);
  else if (record.recordType === 'failureReport') validateFailureReport(record, context, label);
  else if (record.recordType === 'replayReport') validateReplayReport(record, context, label);
  else if (record.recordType === 'evidenceLedger') validateLedger(record, context, label);
  else fail('S5_CHAIN_RECORD_TYPE', `${label} unsupported type`);
}

function validatePlannedInput(value, recordType, label) {
  const expected = recordType === 'evidenceLedger'
    ? PLANNED_INPUT_FIELDS.evidenceLedger
    : PLANNED_INPUT_FIELDS.common;
  exactKeys(value, expected, label, 'S5_CHAIN_PLANNED_INPUT');
  if (value.schemaVersion !== '1.0' || value.recordType !== recordType) {
    fail('S5_CHAIN_PLANNED_INPUT', `${label} schema/type drift`);
  }
  const forbiddenKeys = new Set([
    'buildId', 'iri', 'recordDigest', 'ledgerDigest', 'resolvedInputDigest',
    'outputGraphDigest', 'outputDatasetDigest', 'validationReportDigest',
    'failureReportDigest', 'requestRecordDigest',
  ]);
  function walk(candidate, at) {
    if (Array.isArray(candidate)) return candidate.forEach((entry, index) => walk(entry, `${at}[${index}]`));
    if (!isPlainObject(candidate)) return;
    for (const [key, entry] of Object.entries(candidate)) {
      if (forbiddenKeys.has(key)) fail('S5_CHAIN_PLANNED_RUNTIME_VALUE', `${at}.${key} is not known pre-build`);
      walk(entry, `${at}.${key}`);
    }
  }
  walk(value, label);
  if (recordType === 'evidenceLedger') {
    if (!Array.isArray(value.alternatives) || value.alternatives.length === 0) {
      fail('S5_CHAIN_PLANNED_INPUT', `${label}.alternatives must be non-empty`);
    }
    const keys = [];
    for (const [index, entry] of value.alternatives.entries()) {
      exactKeys(entry, ['attemptId', 'recordId', 'recordType', 'slotId'], `${label}.alternatives[${index}]`);
      keys.push([entry.slotId, entry.recordType, entry.recordId, entry.attemptId]);
    }
    const sorted = [...keys].sort(tupleCompare);
    if (sorted.some((entry, index) => tupleCompare(entry, keys[index]) !== 0)) {
      fail('S5_CHAIN_PLANNED_INPUT', `${label}.alternatives are not slot/type/id/attempt sorted`);
    }
  } else {
    if (!isPlainObject(value.staticInputs) || !Array.isArray(value.dependencySelectors)) {
      fail('S5_CHAIN_PLANNED_INPUT', `${label} staticInputs/selectors invalid`);
    }
    const selectorKeys = [];
    for (const [index, selector] of value.dependencySelectors.entries()) {
      exactKeys(selector, ['fieldPointer', 'sourceSlotId', 'sourceStage'], `${label}.dependencySelectors[${index}]`);
      recordId(selector.sourceSlotId, `${label}.dependencySelectors[${index}].sourceSlotId`);
      if (!['identity', 'executionOutput', 'finalRecord'].includes(selector.sourceStage)) {
        fail('S5_CHAIN_PLANNED_INPUT', `${label}.dependencySelectors[${index}].sourceStage invalid`);
      }
      if (typeof selector.fieldPointer !== 'string'
          || !selector.fieldPointer.startsWith('/')
          || /~(?![01])/u.test(selector.fieldPointer)) {
        fail('S5_CHAIN_PLANNED_INPUT', `${label}.dependencySelectors[${index}].fieldPointer invalid`);
      }
      selectorKeys.push([selector.sourceSlotId, selector.sourceStage, selector.fieldPointer]);
    }
    const sorted = [...selectorKeys].sort(tupleCompare);
    if (sorted.some((entry, index) => tupleCompare(entry, selectorKeys[index]) !== 0)
        || new Set(selectorKeys.map((entry) => entry.join('\0'))).size !== selectorKeys.length) {
      fail('S5_CHAIN_PLANNED_INPUT', `${label}.dependencySelectors must be sorted unique`);
    }
  }
}

function alternativeTuple(alternative) {
  return [alternative.recordType, alternative.recordId, alternative.attemptId];
}

function validatePlan(plan, resolver, schemaManifestDigest) {
  exactKeys(
    plan,
    [
      'controlRecordSchemaManifestDigest', 'controlRecordSchemaManifestRef',
      'schemaVersion', 'slots',
    ],
    'controlRecordPlan',
    'S5_CHAIN_PLAN',
  );
  if (plan.schemaVersion !== '1.0'
      || plan.controlRecordSchemaManifestDigest !== schemaManifestDigest
      || !refsEqual(plan.controlRecordSchemaManifestRef, pathRef('sourceTree', PROFILE_MANIFEST_REL))) {
    fail('S5_CHAIN_PLAN', 'control-record plan schema-manifest binding drift');
  }
  if (!Array.isArray(plan.slots) || plan.slots.length === 0) fail('S5_CHAIN_PLAN', 'plan slots missing');
  const slotIds = [];
  const alternativesBySlot = new Map();
  let ledgerCount = 0;
  for (const [slotIndex, slot] of plan.slots.entries()) {
    exactKeys(slot, ['alternatives', 'cardinality', 'slotId'], `plan.slots[${slotIndex}]`, 'S5_CHAIN_PLAN');
    recordId(slot.slotId, `plan.slots[${slotIndex}].slotId`);
    if (!['required', 'outcomeChoice'].includes(slot.cardinality)) fail('S5_CHAIN_PLAN', 'invalid cardinality');
    if (!Array.isArray(slot.alternatives) || slot.alternatives.length === 0) fail('S5_CHAIN_PLAN', 'empty alternatives');
    const tuples = [];
    const alternatives = [];
    let parentSlotId;
    const outcomes = new Set();
    for (const [altIndex, alternative] of slot.alternatives.entries()) {
      exactKeys(
        alternative,
        [
          'activation', 'attemptId', 'finalizationDependencies', 'plannedInputDigest',
          'plannedInputRef', 'recordId', 'recordType',
        ],
        `plan.slots[${slotIndex}].alternatives[${altIndex}]`,
        'S5_CHAIN_PLAN',
      );
      if (!(alternative.recordType in RECORD_TYPE_ID_FIELD)) fail('S5_CHAIN_PLAN', 'unknown alternative recordType');
      recordId(alternative.recordId, 'alternative.recordId');
      recordId(alternative.attemptId, 'alternative.attemptId');
      rawDigestBytes(alternative.plannedInputDigest, 'alternative.plannedInputDigest');
      const planned = resolver.readJson(
        alternative.plannedInputRef,
        'alternative.plannedInputRef',
        { allowedRoots: ['buildEvidence'], exactJcs: true },
      ).value;
      validatePlannedInput(planned, alternative.recordType, `plannedInput(${slot.slotId}/${alternative.recordType})`);
      if (plannedInputDigest(alternative.recordType, planned) !== alternative.plannedInputDigest) {
        fail('S5_CHAIN_PLANNED_INPUT', `${slot.slotId}/${alternative.recordType} digest drift`);
      }
      if (!Array.isArray(alternative.finalizationDependencies)) fail('S5_CHAIN_PLAN', 'dependencies must be array');
      const dependencyKeys = [];
      for (const [edgeIndex, edge] of alternative.finalizationDependencies.entries()) {
        exactKeys(
          edge,
          ['sourceSlotId', 'sourceStage', 'targetStage'],
          `alternative.finalizationDependencies[${edgeIndex}]`,
          'S5_CHAIN_PLAN',
        );
        recordId(edge.sourceSlotId, 'dependency.sourceSlotId');
        if (!['identity', 'executionOutput', 'finalRecord'].includes(edge.sourceStage)
            || !['executionOutput', 'finalRecord'].includes(edge.targetStage)) {
          fail('S5_CHAIN_PLAN', 'invalid dependency stage');
        }
        dependencyKeys.push([edge.targetStage, edge.sourceSlotId, edge.sourceStage]);
      }
      const sortedDependencies = [...dependencyKeys].sort(tupleCompare);
      if (sortedDependencies.some((entry, index) => tupleCompare(entry, dependencyKeys[index]) !== 0)
          || new Set(dependencyKeys.map((entry) => entry.join('\0'))).size !== dependencyKeys.length) {
        fail('S5_CHAIN_PLAN', 'dependencies must be sorted unique');
      }
      if (alternative.activation.kind === 'always') {
        exactKeys(alternative.activation, ['kind'], 'alternative.activation', 'S5_CHAIN_PLAN');
      } else if (alternative.activation.kind === 'outcomeEquals') {
        exactKeys(
          alternative.activation,
          ['kind', 'parentOutcome', 'parentSlotId'],
          'alternative.activation',
          'S5_CHAIN_PLAN',
        );
        recordId(alternative.activation.parentSlotId, 'activation.parentSlotId');
        if (!['completed', 'failed'].includes(alternative.activation.parentOutcome)) {
          fail('S5_CHAIN_PLAN', 'S5 outcomeChoice supports only completed/failed parents');
        }
        parentSlotId ??= alternative.activation.parentSlotId;
        if (parentSlotId !== alternative.activation.parentSlotId
            || outcomes.has(alternative.activation.parentOutcome)) {
          fail('S5_CHAIN_PLAN', 'outcomeChoice alternatives must use one parent and unique outcomes');
        }
        outcomes.add(alternative.activation.parentOutcome);
      } else {
        fail('S5_CHAIN_PLAN', 'unknown activation kind');
      }
      if (alternative.recordType !== 'evidenceLedger') {
        for (const selector of planned.dependencySelectors) {
          const explicit = alternative.finalizationDependencies.some((edge) => (
            edge.sourceSlotId === selector.sourceSlotId
            && edge.sourceStage === selector.sourceStage
          ));
          const activation = alternative.activation.kind === 'outcomeEquals'
            && alternative.activation.parentSlotId === selector.sourceSlotId
            && selector.sourceStage === 'executionOutput';
          if (!explicit && !activation) {
            fail(
              'S5_CHAIN_PLAN',
              `${slot.slotId} selector ${selector.sourceSlotId}/${selector.sourceStage} has no stage edge`,
            );
          }
        }
        for (const edge of alternative.finalizationDependencies) {
          if (!planned.dependencySelectors.some((selector) => (
            selector.sourceSlotId === edge.sourceSlotId
            && selector.sourceStage === edge.sourceStage
          ))) {
            fail(
              'S5_CHAIN_PLAN',
              `${slot.slotId} dependency ${edge.sourceSlotId}/${edge.sourceStage} has no selector`,
            );
          }
        }
      }
      if (alternative.recordType === 'evidenceLedger') ledgerCount += 1;
      tuples.push(alternativeTuple(alternative));
      alternatives.push({ ...alternative, slotId: slot.slotId });
    }
    const sortedTuples = [...tuples].sort(tupleCompare);
    if (sortedTuples.some((entry, index) => tupleCompare(entry, tuples[index]) !== 0)) {
      fail('S5_CHAIN_PLAN', `alternatives for ${slot.slotId} are not sorted`);
    }
    if (slot.cardinality === 'required') {
      if (slot.alternatives.length !== 1 || slot.alternatives[0].activation.kind !== 'always') {
        fail('S5_CHAIN_PLAN', `required slot ${slot.slotId} must have one always alternative`);
      }
    } else if (slot.alternatives.length !== 2
      || outcomes.size !== 2
      || !outcomes.has('completed') || !outcomes.has('failed')) {
      fail('S5_CHAIN_PLAN', `outcomeChoice slot ${slot.slotId} must close completed/failed`);
    }
    slotIds.push(slot.slotId);
    alternativesBySlot.set(slot.slotId, alternatives);
  }
  sortedUniqueStrings(slotIds, 'plan.slotIds');
  if (ledgerCount !== 1) fail('S5_CHAIN_PLAN', 'plan must contain exactly one evidenceLedger alternative');
  return alternativesBySlot;
}

function activeAlternatives(planAlternatives, outcomes) {
  const selected = new Map();
  for (const [slotId, alternatives] of planAlternatives.entries()) {
    const active = alternatives.filter((alternative) => {
      if (alternative.activation.kind === 'always') return true;
      return outcomes.get(alternative.activation.parentSlotId) === alternative.activation.parentOutcome;
    });
    if (active.length !== 1) fail('S5_CHAIN_PLAN_SELECTION', `${slotId} has ${active.length} active alternatives`);
    selected.set(slotId, active[0]);
  }
  return selected;
}

function finalRecordValidationOrder(active) {
  const outgoing = new Map([...active.keys()].map((slotId) => [slotId, new Set()]));
  const indegree = new Map([...active.keys()].map((slotId) => [slotId, 0]));
  for (const [targetSlotId, alternative] of active.entries()) {
    for (const dependency of alternative.finalizationDependencies) {
      if (dependency.sourceStage !== 'finalRecord') continue;
      if (!active.has(dependency.sourceSlotId)) {
        fail('S5_CHAIN_PLAN_DAG', `${targetSlotId} depends on inactive ${dependency.sourceSlotId}`);
      }
      if (!outgoing.get(dependency.sourceSlotId).has(targetSlotId)) {
        outgoing.get(dependency.sourceSlotId).add(targetSlotId);
        indegree.set(targetSlotId, indegree.get(targetSlotId) + 1);
      }
    }
  }
  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([slotId]) => slotId)
    .sort(utf8Compare);
  const ordered = [];
  while (ready.length > 0) {
    const slotId = ready.shift();
    ordered.push(slotId);
    for (const target of [...outgoing.get(slotId)].sort(utf8Compare)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        ready.push(target);
        ready.sort(utf8Compare);
      }
    }
  }
  if (ordered.length !== active.size) fail('S5_CHAIN_PLAN_DAG', 'final-record dependency graph has a cycle');
  return ordered;
}

function validateStageDag(active) {
  const nodes = new Set();
  const edges = new Map();
  const addEdge = (from, to) => {
    if (!edges.has(from)) edges.set(from, []);
    edges.get(from).push(to);
  };
  for (const [slotId, alternative] of active.entries()) {
    const identity = `${slotId}:identity`;
    const execution = `${slotId}:executionOutput`;
    const final = `${slotId}:finalRecord`;
    [identity, execution, final].forEach((node) => nodes.add(node));
    addEdge(identity, execution);
    addEdge(execution, final);
    if (alternative.activation.kind === 'outcomeEquals') {
      addEdge(`${alternative.activation.parentSlotId}:executionOutput`, identity);
    }
    for (const dependency of alternative.finalizationDependencies) {
      addEdge(
        `${dependency.sourceSlotId}:${dependency.sourceStage}`,
        `${slotId}:${dependency.targetStage}`,
      );
    }
  }
  for (const [from, targets] of edges.entries()) {
    if (!nodes.has(from) || targets.some((target) => !nodes.has(target))) {
      fail('S5_CHAIN_PLAN_DAG', 'active stage graph references an inactive/missing stage');
    }
  }
  const state = new Map();
  function visit(node) {
    if (state.get(node) === 'visiting') fail('S5_CHAIN_PLAN_DAG', 'active stage graph contains a cycle');
    if (state.get(node) === 'done') return;
    state.set(node, 'visiting');
    for (const target of edges.get(node) || []) visit(target);
    state.set(node, 'done');
  }
  for (const node of nodes) visit(node);
}

function validateSchemaManifest(value, resolver) {
  exactKeys(value, ['recordTypes', 'schemaVersion'], 'controlRecordSchemaManifest');
  if (value.schemaVersion !== '1.0' || !Array.isArray(value.recordTypes)) {
    fail('S5_CHAIN_SCHEMA_MANIFEST', 'schema manifest version/rows invalid');
  }
  const expectedTypes = Object.keys(PROFILE_DEFINITIONS).sort(utf8Compare);
  const types = [];
  for (const [index, row] of value.recordTypes.entries()) {
    exactKeys(
      row,
      [
        'plannedInputSchemaDigest', 'plannedInputSchemaRef', 'recordSchemaDigest',
        'recordSchemaRef', 'recordType', 'resolvedInputProjectionDigest',
        'resolvedInputProjectionRef',
      ],
      `schemaManifest.recordTypes[${index}]`,
    );
    if (!(row.recordType in PROFILE_DEFINITIONS)) fail('S5_CHAIN_SCHEMA_MANIFEST', 'unexpected record type');
    for (const [field, digestField, kind, required, conditional] of [
      [
        'plannedInputSchemaRef', 'plannedInputSchemaDigest', 'plannedInputSchema',
        PROFILE_DEFINITIONS[row.recordType].plannedInputRequired, {},
      ],
      [
        'resolvedInputProjectionRef', 'resolvedInputProjectionDigest', 'resolvedInputProjection',
        PROFILE_DEFINITIONS[row.recordType].resolvedInputRequired, {},
      ],
      [
        'recordSchemaRef', 'recordSchemaDigest', 'recordSchema',
        PROFILE_DEFINITIONS[row.recordType].recordRequired,
        PROFILE_DEFINITIONS[row.recordType].conditionalRecordFields,
      ],
    ]) {
      const artifact = resolver.readJson(row[field], `schemaManifest.${row.recordType}.${field}`, {
        allowedRoots: ['sourceTree'], exactJcs: true,
      });
      if (artifact.digest !== row[digestField]) fail('S5_CHAIN_SCHEMA_MANIFEST', `${row.recordType}.${field} digest drift`);
      exactKeys(
        artifact.value,
        [
          'additionalProperties', 'conditional', 'kind', 'recordType',
          'referenceFields', 'required', 'schemaVersion',
        ],
        `schemaManifest.${row.recordType}.${field}.schema`,
        'S5_CHAIN_SCHEMA_MANIFEST',
      );
      if (artifact.value.recordType !== row.recordType
          || artifact.value.schemaVersion !== '1.0'
          || artifact.value.additionalProperties !== false
          || artifact.value.kind !== kind
          || canonicalJcs(artifact.value.required) !== canonicalJcs([...required].sort())
          || canonicalJcs(artifact.value.conditional) !== canonicalJcs(conditional)
          || canonicalJcs(artifact.value.referenceFields) !== canonicalJcs(
            kind === 'recordSchema'
              ? PROFILE_DEFINITIONS[row.recordType].referenceFields
              : {},
          )) {
        fail('S5_CHAIN_SCHEMA_MANIFEST', `${row.recordType}.${field} identity drift`);
      }
    }
    types.push(row.recordType);
  }
  if (types.length !== expectedTypes.length || types.some((entry, index) => entry !== expectedTypes[index])) {
    fail('S5_CHAIN_SCHEMA_MANIFEST', 'schema manifest must contain exactly seven sorted record kinds');
  }
}

const EXPECTED_TOOL_CAPABILITY_BINDINGS = Object.freeze({
  'rdf-canonize': Object.freeze({
    artifactPath: 'scripts/domain/lib/rdfc-1.0.cjs',
    capabilityId: 'rdfc-1.0',
    discoveryContractPath: `${PROFILE_ROOT_REL}/rdfc-discovery-contract.json`,
    evidenceSchemaPath: `${PROFILE_ROOT_REL}/rdfc-evidence-schema.json`,
    inputContractPath: `${PROFILE_ROOT_REL}/rdfc-capability-input-contract.json`,
    outputContractPath: `${PROFILE_ROOT_REL}/rdfc-capability-output-contract.json`,
    runtimePath: `${PROFILE_ROOT_REL}/rdfc-runtime-closure.json`,
    testVectorsPath: 'scripts/domain/tests/test-rdfc-1.0.cjs',
  }),
  's5-canonical-materializer': Object.freeze({
    artifactPath: 'scripts/domain/lib/s5-canonical-materialization.cjs',
    capabilityId: 's5-canonical-materialization',
    discoveryContractPath: `${PROFILE_ROOT_REL}/materialization-discovery-contract.json`,
    evidenceSchemaPath: `${PROFILE_ROOT_REL}/materialization-evidence-schema.json`,
    inputContractPath: `${PROFILE_ROOT_REL}/materialization-capability-input-contract.json`,
    outputContractPath: `${PROFILE_ROOT_REL}/materialization-capability-output-contract.json`,
    runtimePath: `${PROFILE_ROOT_REL}/materialization-runtime-closure.json`,
    testVectorsPath: 'scripts/domain/tests/test-s5-control-record-chain.cjs',
  }),
  's5-control-record-chain': Object.freeze({
    artifactPath: 'scripts/domain/lib/s5-control-record-chain.cjs',
    capabilityId: 's5-control-chain',
    discoveryContractPath: `${PROFILE_ROOT_REL}/gate-discovery-contract.json`,
    evidenceSchemaPath: `${PROFILE_ROOT_REL}/gate-evidence-schema.json`,
    inputContractPath: `${PROFILE_ROOT_REL}/capability-input-contract.json`,
    outputContractPath: `${PROFILE_ROOT_REL}/capability-output-contract.json`,
    runtimePath: `${PROFILE_ROOT_REL}/s5-runtime-closure.json`,
    testVectorsPath: 'scripts/domain/tests/test-s5-control-record-chain.cjs',
  }),
});

const EXPECTED_RUNTIME_CLOSURES = Object.freeze({
  'rdf-canonize': {
    runtimeId: 'rdf-canonize-runtime-v1',
    paths: {
      'package-lock.json': 'dependency-lock',
      'package.json': 'dependency-contract',
      'scripts/domain/lib/rdfc-1.0-worker.cjs': 'canonicalization-worker',
    },
  },
  's5-canonical-materializer': {
    runtimeId: 's5-canonical-materialization-runtime-v1',
    paths: {
      'package-lock.json': 'dependency-lock',
      'package.json': 'dependency-contract',
      'scripts/domain/lib/identity-contract-compiler.cjs':
        'identity-contract-and-version-key-runtime',
      'scripts/domain/lib/s5-canonical-materialization.cjs': 'canonical-m2-materializer',
      'scripts/domain/lib/strict-source-locator.cjs': 'artifact-reference-and-jcs-runtime',
    },
  },
  's5-control-record-chain': {
    runtimeId: 's5-control-chain-runtime-v1',
    paths: {
      'package-lock.json': 'dependency-lock',
      'package.json': 'dependency-contract',
      'docs/domain/infrastructure/requirements-shacl.txt': 'pyshacl-version-pin',
      'ontology/domain/finance/foundation/module.shacl.ttl': 'identity-current-domain-shacl-sidecar',
      'ontology/domain/finance/instruments/module.shacl.ttl':
        'instrument-support-current-domain-shacl-sidecar',
      'ontology/domain/finance/market-data/module.shacl.ttl': 'market-data-current-domain-shacl-sidecar',
      'ontology/domain/finance/market-structure/module.shacl.ttl':
        'market-structure-support-current-domain-shacl-sidecar',
      'ontology/domain/finance/portfolio-positions/module.shacl.ttl':
        'portfolio-current-domain-shacl-sidecar',
      'scripts/domain/generate-m2-shacl.cjs': 'current-domain-shacl-projector',
      'scripts/domain/lib/direct-sparql-select.cjs': 'direct-sparql-profile',
      'scripts/domain/lib/identity-contract-compiler.cjs': 'identity-contract-and-version-key-runtime',
      'scripts/domain/lib/instant-lexical.cjs': 'utc-instant-lexical-runtime',
      'scripts/domain/lib/json-pointer-source-extractor.cjs': 'strict-json-parser',
      'scripts/domain/lib/m2-git-replay.cjs': 'git-object-replay-runtime',
      'scripts/domain/lib/m2-constraint-instance-audit.cjs':
        'constraint-instance-id-and-discovery-runtime',
      'scripts/domain/lib/m2-constraint-instance-gate-join.cjs':
        'constraint-instance-gate-join-runtime',
      'scripts/domain/lib/ontology-ir-normalizer.cjs':
        'set-semantic-ontology-ir-normalizer',
      'scripts/domain/lib/s5-pyshacl-runtime-probe.cjs': 'pinned-python-runtime-probe',
      'scripts/domain/lib/pattern-injected-fields.cjs': 'pattern-field-projection',
      'scripts/domain/lib/portfolio-observation-stream-closure.cjs':
        'portfolio-observation-page-completeness-and-row-locator-verifier',
      'scripts/domain/lib/orders-portfolio-canonical-record-adapter.cjs':
        'orders-portfolio-canonical-record-adapter',
      'scripts/domain/lib/orders-portfolio-custom-validators.cjs':
        'orders-portfolio-custom-validator',
      'scripts/domain/lib/orders-portfolio-exact-arithmetic.cjs':
        'orders-portfolio-exact-arithmetic',
      'scripts/domain/lib/orders-portfolio-reconciliation-evidence.cjs':
        'portfolio-reconciliation-verifier-owned-projection',
      'scripts/domain/lib/orders-portfolio-reference-registry.cjs':
        'orders-portfolio-reference-registry-runtime',
      'scripts/domain/lib/rdfc-1.0-worker.cjs': 'rdf-canonicalization-worker',
      'scripts/domain/lib/rdfc-1.0.cjs': 'rdf-canonicalization-runtime',
      'scripts/domain/lib/s5-canonical-materialization.cjs': 'canonical-m2-materializer',
      'scripts/domain/lib/s5-completed-run-producer-replay.cjs':
        'completed-run-verifier-owned-producer-replay',
      'scripts/domain/lib/s5-materialized-custom-validation.cjs':
        'materialized-applicable-custom-validator',
      'scripts/domain/lib/s5-materialized-custom-worker.cjs':
        'materialized-applicable-custom-driver',
      'scripts/domain/lib/s5-materialized-shacl-worker.cjs': 'materialized-current-domain-shacl-driver',
      'scripts/domain/lib/s5-prior-support-chain.cjs': 'prior-support-control-chain-verifier',
      'scripts/domain/lib/strict-source-locator.cjs': 'artifact-reference-and-jcs-runtime',
      'scripts/domain/lib/typed-projection-common.cjs': 'current-m2-typed-validator',
      'scripts/domain/shacl-instance-profile/v0.3.0/s5-materialized-graph-worker.py': 'pinned-pyshacl-worker',
      'scripts/domain/orders-portfolio-custom-profile/v0.3.0/input-contract.json':
        'orders-portfolio-canonical-input-contract',
      'scripts/domain/orders-portfolio-custom-profile/v0.3.0/portfolio-reconciliation-producer-inputs.json':
        'portfolio-reconciliation-upstream-producer-input-inventory',
      'scripts/domain/orders-portfolio-custom-profile/v0.3.0/reference-registry.json':
        'orders-portfolio-reference-registry-artifact',
    },
  },
});

function validateRuntimeClosure(tool, resolver) {
  const expected = EXPECTED_RUNTIME_CLOSURES[tool.toolId];
  if (!expected) fail('S5_CHAIN_TOOL_LOCK', `${tool.toolId} has no runtime-closure contract`);
  const artifact = resolver.readJson(
    tool.runtimeRef,
    `tool.${tool.toolId}.runtimeRef`,
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  const closure = artifact.value;
  exactKeys(
    closure,
    ['entries', 'runtimeId', 'schemaVersion'],
    `tool.${tool.toolId}.runtimeClosure`,
    'S5_CHAIN_TOOL_LOCK',
  );
  if (closure.schemaVersion !== '1.0'
      || closure.runtimeId !== expected.runtimeId
      || !Array.isArray(closure.entries)) {
    fail('S5_CHAIN_TOOL_LOCK', `${tool.toolId} runtime-closure identity drift`);
  }
  const actualPaths = [];
  let previousKey = null;
  for (const [index, entry] of closure.entries.entries()) {
    exactKeys(
      entry,
      ['artifactDigest', 'artifactRef', 'role'],
      `tool.${tool.toolId}.runtimeClosure.entries[${index}]`,
      'S5_CHAIN_TOOL_LOCK',
    );
    if (typeof entry.role !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(entry.role)) {
      fail('S5_CHAIN_TOOL_LOCK', `${tool.toolId} runtime dependency role is invalid`);
    }
    const key = refSortKey(entry.artifactRef);
    if (previousKey !== null && utf8Compare(previousKey, key) >= 0) {
      fail('S5_CHAIN_TOOL_LOCK', `${tool.toolId} runtime dependencies are unsorted/duplicate`);
    }
    previousKey = key;
    if (entry.artifactRef.kind !== 'path' || entry.artifactRef.root !== 'sourceTree') {
      fail('S5_CHAIN_TOOL_LOCK', `${tool.toolId} runtime dependency must use sourceTree path`);
    }
    const dependency = resolver.read(
      entry.artifactRef,
      `tool.${tool.toolId}.runtimeClosure.entries[${index}].artifactRef`,
      ['sourceTree'],
    );
    void dependency;
    if (expected.paths[entry.artifactRef.path] !== entry.role) {
      fail('S5_CHAIN_TOOL_LOCK', `${tool.toolId} runtime dependency path/role is unexpected`);
    }
    actualPaths.push(entry.artifactRef.path);
  }
  const expectedPaths = Object.keys(expected.paths).sort(utf8Compare);
  if (actualPaths.length !== expectedPaths.length
      || [...actualPaths].sort(utf8Compare)
        .some((entry, index) => entry !== expectedPaths[index])) {
    fail('S5_CHAIN_TOOL_LOCK', `${tool.toolId} runtime dependency closure is incomplete/extra`);
  }
  return closure;
}

function assertRdfcCapabilityContractValue(contractName, value) {
  const expected = RDFC_CAPABILITY_CONTRACTS[contractName];
  if (!expected || canonicalJcs(value) !== canonicalJcs(expected)) {
    fail(
      'S5_CHAIN_TOOL_LOCK',
      `rdfc-1.0 ${contractName} does not describe the executable RDFC capability`,
    );
  }
}

function validateExpectedToolCapabilityBinding(tool, resolver) {
  const expected = EXPECTED_TOOL_CAPABILITY_BINDINGS[tool.toolId];
  if (!expected) fail('S5_CHAIN_TOOL_LOCK', `${tool.toolId} has no executable binding profile`);
  const capability = tool.capabilities.find((entry) => entry.capabilityId === expected.capabilityId);
  if (!capability) {
    fail('S5_CHAIN_TOOL_LOCK', `${tool.toolId} lacks its exact executable capability`);
  }
  const expectedRefs = [
    [tool.artifactRef, expected.artifactPath, 'artifactRef'],
    [tool.runtimeRef, expected.runtimePath, 'runtimeRef'],
    [capability.capabilityRef, expected.artifactPath, 'capabilityRef'],
    [capability.entrypointRef, expected.artifactPath, 'entrypointRef'],
    [capability.discoveryContractRef, expected.discoveryContractPath, 'discoveryContractRef'],
    [capability.evidenceSchemaRef, expected.evidenceSchemaPath, 'evidenceSchemaRef'],
    [capability.inputContractRef, expected.inputContractPath, 'inputContractRef'],
    [capability.outputContractRef, expected.outputContractPath, 'outputContractRef'],
    [capability.testVectorsRef, expected.testVectorsPath, 'testVectorsRef'],
  ];
  for (const [actualRef, expectedPath, field] of expectedRefs) {
    if (!refsEqual(actualRef, pathRef('sourceTree', expectedPath))) {
      fail('S5_CHAIN_TOOL_LOCK', `${tool.toolId}.${field} is not the exact capability-specific artifact`);
    }
  }
  if (tool.artifactDigest !== capability.capabilityDigest
      || tool.artifactDigest !== capability.entrypointDigest) {
    fail(
      'S5_CHAIN_TOOL_LOCK',
      `${tool.toolId} tool/artifact/capability/entrypoint tuple does not close`,
    );
  }
  if (tool.toolId !== 'rdf-canonize') return;
  const rdfcContractBindings = [
    ['inputContractRef', 'inputContractDigest', 'rdfc-capability-input-contract.json'],
    ['outputContractRef', 'outputContractDigest', 'rdfc-capability-output-contract.json'],
    ['discoveryContractRef', 'discoveryContractDigest', 'rdfc-discovery-contract.json'],
    ['evidenceSchemaRef', 'evidenceSchemaDigest', 'rdfc-evidence-schema.json'],
  ];
  for (const [refField, digestField, contractName] of rdfcContractBindings) {
    const artifact = resolver.readJson(
      capability[refField],
      `capability.rdfc-1.0.${refField}`,
      { allowedRoots: ['sourceTree'], exactJcs: true },
    );
    assertRdfcCapabilityContractValue(contractName, artifact.value);
  }
}

function validateToolLock(value, resolver) {
  exactKeys(value, ['schemaVersion', 'tools'], 'toolchainLock');
  if (value.schemaVersion !== '1.0' || !Array.isArray(value.tools) || value.tools.length !== 3) {
    fail('S5_CHAIN_TOOL_LOCK', 'tool lock must contain the three exact S5 runtime tools');
  }
  const expectedCapabilityIds = new Map([
    ['rdf-canonize', ['rdfc-1.0']],
    ['s5-canonical-materializer', ['s5-canonical-materialization']],
    ['s5-control-record-chain', ['s5-control-chain']],
  ]);
  const ids = [];
  const runtimeClosures = new Map();
  for (const [index, tool] of value.tools.entries()) {
    exactKeys(
      tool,
      [
        'artifactDigest', 'artifactRef', 'capabilities', 'runtimeDigest',
        'runtimeRef', 'toolId', 'version',
      ],
      `toolchainLock.tools[${index}]`,
    );
    asciiId(tool.toolId, `toolchainLock.tools[${index}].toolId`);
    if (typeof tool.version !== 'string' || tool.version.length === 0) fail('S5_CHAIN_TOOL_LOCK', 'empty tool version');
    const toolArtifact = resolver.read(
      tool.artifactRef,
      `tool.${tool.toolId}.artifactRef`,
      ['sourceTree'],
    );
    void toolArtifact;
    runtimeClosures.set(tool.toolId, validateRuntimeClosure(tool, resolver));
    if (!Array.isArray(tool.capabilities) || tool.capabilities.length === 0) fail('S5_CHAIN_TOOL_LOCK', 'empty capabilities');
    const capabilityIds = [];
    for (const [capIndex, capability] of tool.capabilities.entries()) {
      exactKeys(
        capability,
        [
          'capabilityDigest', 'capabilityId', 'capabilityRef',
          'discoveryContractDigest', 'discoveryContractRef',
          'entrypointDigest', 'entrypointRef', 'evidenceSchemaDigest',
          'evidenceSchemaRef', 'inputContractDigest', 'inputContractRef',
          'outputContractDigest', 'outputContractRef', 'testVectorsDigest',
          'testVectorsRef',
        ],
        `tool.${tool.toolId}.capabilities[${capIndex}]`,
      );
      asciiId(capability.capabilityId, 'capability.capabilityId');
      for (const [field, digestField] of [
        ['capabilityRef', 'capabilityDigest'],
        ['entrypointRef', 'entrypointDigest'],
        ['inputContractRef', 'inputContractDigest'],
        ['outputContractRef', 'outputContractDigest'],
        ['discoveryContractRef', 'discoveryContractDigest'],
        ['evidenceSchemaRef', 'evidenceSchemaDigest'],
        ['testVectorsRef', 'testVectorsDigest'],
      ]) {
        resolver.read(capability[field], `capability.${capability.capabilityId}.${field}`, ['sourceTree']);
      }
      capabilityIds.push(capability.capabilityId);
    }
    sortedUniqueStrings(capabilityIds, `tool.${tool.toolId}.capabilityIds`);
    if (canonicalJcs(capabilityIds) !== canonicalJcs(expectedCapabilityIds.get(tool.toolId))) {
      fail('S5_CHAIN_TOOL_LOCK', `${tool.toolId} capability inventory is incomplete or extra`);
    }
    ids.push(tool.toolId);
  }
  sortedUniqueStrings(ids, 'toolchainLock.toolIds');
  const s5 = value.tools.find((tool) => tool.toolId === 's5-control-record-chain');
  const materializer = value.tools.find((tool) => tool.toolId === 's5-canonical-materializer');
  const rdfc = value.tools.find((tool) => tool.toolId === 'rdf-canonize');
  if (!s5 || s5.version !== CONTROL_CHAIN_VERSION
      || !materializer || materializer.version !== 'axiolune-s5-canonical-materialization/v1'
      || !rdfc || rdfc.version !== '5.0.0') {
    fail('S5_CHAIN_TOOL_LOCK', 'executing capability/version is not exactly locked');
  }
  value.tools.forEach((tool) => validateExpectedToolCapabilityBinding(tool, resolver));
  return { materializer, rdfc, runtimeClosures, s5 };
}

function collectPathRefs(value, output = new Map()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectPathRefs(entry, output));
    return output;
  }
  if (!isPlainObject(value)) return output;
  if (value.kind === 'path' && value.root === 'sourceTree' && typeof value.path === 'string') {
    output.set(value.path, value);
    return output;
  }
  for (const entry of Object.values(value)) collectPathRefs(entry, output);
  return output;
}

function makeSourceTreeManifest(resolver, sourceValues) {
  const refs = new Map();
  sourceValues.forEach((value) => collectPathRefs(value, refs));
  const files = [...refs.keys()].sort(utf8Compare).map((relativePath) => {
    const artifact = resolver.read(pathRef('sourceTree', relativePath), `sourceTree.${relativePath}`, ['sourceTree']);
    return {
      mode: '100644',
      path: relativePath,
      byteLength: artifact.bytes.length,
      artifactDigest: artifact.digest,
      bytes: artifact.bytes,
    };
  });
  const digest = sourceTreeDigest(files);
  const manifest = {
    files: files.map(({ bytes, ...entry }) => entry),
    schemaVersion: '1.0',
    sourceTreeDigest: digest,
  };
  return { digest, files, manifest };
}

function validateGitSourceTreeSelector(value, repositoryRoot) {
  exactKeys(
    value,
    ['commitId', 'gitObjectFormat', 'schemaVersion', 'selectorKind', 'treeId'],
    'sourceTreeSelector',
    'S5_CHAIN_SOURCE_SELECTOR',
  );
  if (value.schemaVersion !== '1.0' || value.selectorKind !== 'gitCommit') {
    fail(
      'S5_CHAIN_SOURCE_SELECTOR',
      'sourceTreeSelector must use schemaVersion 1.0 and selectorKind gitCommit',
    );
  }
  if (!['sha1', 'sha256'].includes(value.gitObjectFormat)) {
    fail('S5_CHAIN_SOURCE_SELECTOR', 'unsupported Git object format');
  }
  const idLength = value.gitObjectFormat === 'sha1' ? 40 : 64;
  const fullId = new RegExp(`^[0-9a-f]{${idLength}}$`, 'u');
  for (const field of ['commitId', 'treeId']) {
    if (typeof value[field] !== 'string'
        || !fullId.test(value[field])
        || /^0+$/u.test(value[field])) {
      fail(
        'S5_CHAIN_SOURCE_SELECTOR',
        `${field} must be a full non-zero lowercase ${value.gitObjectFormat} object ID`,
      );
    }
  }
  try {
    const actualFormat = repositoryObjectFormat(repositoryRoot);
    if (actualFormat !== value.gitObjectFormat) {
      fail(
        'S5_CHAIN_SOURCE_SELECTOR',
        `repository object format ${actualFormat} differs from selector ${value.gitObjectFormat}`,
      );
    }
    const commit = inspectCommit(repositoryRoot, value.commitId, value.gitObjectFormat);
    if (commit.treeId !== value.treeId) {
      fail(
        'S5_CHAIN_SOURCE_SELECTOR',
        `commit ${value.commitId} resolves to tree ${commit.treeId}, not ${value.treeId}`,
      );
    }
    return commit;
  } catch (error) {
    if (error instanceof S5ControlChainError) throw error;
    fail(
      'S5_CHAIN_SOURCE_SELECTOR',
      `Git selector cannot be independently reconstructed: ${error.message}`,
    );
  }
}

function makeGitBoundSourceTreeManifest(resolver, selector) {
  validateGitSourceTreeSelector(selector, resolver.roots.sourceTree);
  let replay;
  try {
    replay = buildGitSourceTreeManifest(
      resolver.roots.sourceTree,
      selector.treeId,
      selector.gitObjectFormat,
    );
  } catch (error) {
    fail(
      'S5_CHAIN_SOURCE_TREE',
      `Git source tree cannot be independently reconstructed: ${error.message}`,
    );
  }
  return {
    digest: replay.sourceTreeDigest,
    files: replay.files.map((entry) => ({
      artifactDigest: entry.artifactDigest,
      byteLength: entry.byteLength,
      bytes: entry.content,
      mode: entry.mode,
      path: entry.path,
    })),
    manifest: replay.manifest,
  };
}

function assertSourceTreeInventory(sourceTreeManifest, sourceValues, bindingKind = 'sourceClosure') {
  const expectedPaths = [...collectPathRefs(sourceValues).keys()].sort(utf8Compare);
  const actualPaths = sourceTreeManifest.files.map((entry) => entry.path);
  const actualSet = new Set(actualPaths);
  const invalid = bindingKind === 'gitCommit'
    ? expectedPaths.some((entry) => !actualSet.has(entry))
    : actualPaths.length !== expectedPaths.length
      || actualPaths.some((entry, index) => entry !== expectedPaths[index]);
  if (invalid) {
    fail(
      'S5_CHAIN_SOURCE_TREE',
      bindingKind === 'gitCommit'
        ? 'Git source-tree manifest omits a recursive input/tool/schema dependency'
        : 'source-tree manifest inventory is not the exact recursive input/tool/schema closure',
    );
  }
}

function rowKey(row) {
  return canonicalJcs(row);
}

function validateSourceDataset(value, label) {
  exactKeys(value, ['dataset', 'rows', 'snapshotId', 'snapshotTime'], label);
  absoluteIri(value.dataset, `${label}.dataset`);
  recordId(value.snapshotId, `${label}.snapshotId`);
  instantEpoch(value.snapshotTime, `${label}.snapshotTime`);
  if (!Array.isArray(value.rows) || value.rows.length === 0) fail('S5_CHAIN_SOURCE_DATA', `${label}.rows empty`);
  const keys = new Set();
  for (const [index, row] of value.rows.entries()) {
    exactKeys(
      row,
      SOURCE_SCHEMA_FIELDS.map(([name]) => name),
      `${label}.rows[${index}]`,
    );
    for (const [field, type] of SOURCE_SCHEMA_FIELDS) {
      const fieldLabel = `${label}.rows[${index}].${field}`;
      if (type === 'dateTimeStamp') {
        instantEpoch(row[field], fieldLabel);
      } else if (type === 'date') {
        dateEpoch(row[field], fieldLabel);
      } else if (type === 'uri') {
        absoluteIri(row[field], fieldLabel);
      } else if (type === 'sha256Digest') {
        rawDigestBytes(row[field], fieldLabel);
      } else if (type === 'decimalString') {
        if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(row[field])) {
          fail('S5_CHAIN_SOURCE_DATA', `${fieldLabel} must be an exact decimal string`);
        }
      } else if (type === 'nonNegativeInteger') {
        if (!Number.isSafeInteger(row[field]) || row[field] < 0) {
          fail('S5_CHAIN_SOURCE_DATA', `${fieldLabel} must be a non-negative integer`);
        }
      } else if (type === 'string') {
        if (typeof row[field] !== 'string'
            || row[field].length === 0
            || row[field] !== row[field].normalize('NFC')) {
          fail('S5_CHAIN_SOURCE_DATA', `${fieldLabel} must be a non-empty NFC string`);
        }
      } else {
        fail('S5_CHAIN_SOURCE_DATA', `${fieldLabel} uses an unsupported schema type`);
      }
    }
    if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(row.holding_quantity)) {
      fail('S5_CHAIN_SOURCE_DATA', `${label}.rows[${index}].holding_quantity must be non-negative`);
    }
    if (!['floor', 'ceiling', 'half-up', 'half-even'].includes(
      row.holding_quantity_rounding,
    )) {
      fail(
        'S5_CHAIN_SOURCE_DATA',
        `${label}.rows[${index}].holding_quantity_rounding is unsupported`,
      );
    }
    const holdingScale = row.holding_quantity.includes('.')
      ? row.holding_quantity.split('.')[1].length
      : 0;
    if (row.holding_quantity_precision !== holdingScale) {
      fail(
        'S5_CHAIN_SOURCE_DATA',
        `${label}.rows[${index}].holding_quantity_precision does not equal the explicit decimal-place precision`,
      );
    }
    const priceScale = row.price.includes('.') ? row.price.split('.')[1].length : 0;
    if (row.price_scale !== priceScale) {
      fail(
        'S5_CHAIN_SOURCE_DATA',
        `${label}.rows[${index}].price_scale does not equal the source Money lexical scale`,
      );
    }
    absoluteIri(row.holding_quantity_unit, `${label}.rows[${index}].holding_quantity_unit`);
    if (row.position_source_kind_iri
        !== 'https://axiolune.ai/ontology/finance/portfolio-positions/PositionSourceKind/value/externalReported') {
      fail('S5_CHAIN_SOURCE_DATA', `${label}.rows[${index}] must use the locked externalReported holding branch`);
    }
    const key = rowKey(row);
    if (keys.has(key)) fail('S5_CHAIN_SOURCE_DATA', `${label} repeats one row`);
    keys.add(key);
  }
}

function validateSourceSchema(value) {
  exactKeys(
    value,
    ['additionalProperties', 'dataset', 'fields', 'primaryKey', 'schemaVersion'],
    'sourceSchema',
    'S5_CHAIN_SOURCE_SCHEMA',
  );
  if (value.schemaVersion !== '1.0' || value.additionalProperties !== false) {
    fail('S5_CHAIN_SOURCE_SCHEMA', 'source schema identity/additionalProperties drift');
  }
  absoluteIri(value.dataset, 'sourceSchema.dataset');
  const expectedFields = SOURCE_SCHEMA_FIELDS;
  if (!Array.isArray(value.fields) || value.fields.length !== expectedFields.length) {
    fail('S5_CHAIN_SOURCE_SCHEMA', 'source schema field inventory drift');
  }
  for (const [index, field] of value.fields.entries()) {
    exactKeys(
      field,
      ['name', 'required', 'type'],
      `sourceSchema.fields[${index}]`,
      'S5_CHAIN_SOURCE_SCHEMA',
    );
    if (field.name !== expectedFields[index][0]
        || field.type !== expectedFields[index][1]
        || field.required !== true) {
      fail('S5_CHAIN_SOURCE_SCHEMA', `sourceSchema.fields[${index}] drift`);
    }
  }
  if (canonicalJcs(value.primaryKey)
      !== canonicalJcs([
        'instrument_id', 'valid_from', 'knowledge_from', 'available_from', 'revision',
      ])) {
    fail('S5_CHAIN_SOURCE_SCHEMA', 'source schema primaryKey drift');
  }
}

function ontologyModuleTargets(document) {
  const targets = new Set();
  for (const container of [
    document.domain?.objectTypes,
    document.domain?.associationTypes,
  ]) {
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
    for (const definition of Object.values(container)) {
      if (definition && typeof definition.iri === 'string') targets.add(definition.iri);
    }
  }
  return targets;
}

function addUniqueOntologyElement(index, iri, value, kind, moduleIri) {
  if (typeof iri !== 'string') return;
  const existing = index.get(iri);
  if (existing) {
    fail(
      'S5_CHAIN_ONTOLOGY_CLOSURE',
      `${kind} ${iri} is defined by both ${existing.moduleIri} and ${moduleIri}`,
    );
  }
  index.set(iri, { definition: value, kind, moduleIri });
}

function buildOntologySemanticIndex(modules) {
  const types = new Map();
  const attributes = new Map();
  const relations = new Map();
  const patterns = new Map();
  for (const [moduleIri, module] of modules) {
    const domain = module.document.domain || {};
    const metaRoot = Object.entries(module.document).find(([key, candidate]) => (
      key !== 'module' && isPlainObject(candidate)
    ))?.[1];
    for (const [containerName, kind] of [
      ['objectTypes', 'objectType'],
      ['associationTypes', 'associationType'],
    ]) {
      const container = domain[containerName];
      if (!isPlainObject(container)) continue;
      Object.values(container).forEach((definition) => {
        if (isPlainObject(definition)) {
          addUniqueOntologyElement(types, definition.iri, definition, kind, moduleIri);
        }
      });
    }
    if (isPlainObject(domain.attributeTypes)) {
      Object.values(domain.attributeTypes).forEach((definition) => {
        if (isPlainObject(definition)) {
          addUniqueOntologyElement(
            attributes,
            definition.iri,
            definition,
            'attributeType',
            moduleIri,
          );
        }
      });
    }
    if (isPlainObject(domain.relationTypes)) {
      Object.values(domain.relationTypes).forEach((definition) => {
        if (isPlainObject(definition)) {
          addUniqueOntologyElement(
            relations,
            definition.iri,
            definition,
            'relationType',
            moduleIri,
          );
        }
      });
    }
    if (Array.isArray(domain.patterns)) {
      domain.patterns.forEach((definition) => {
        if (isPlainObject(definition)) {
          addUniqueOntologyElement(patterns, definition.iri, definition, 'pattern', moduleIri);
        }
      });
    }
    if (isPlainObject(metaRoot)) {
      Object.values(metaRoot).forEach((definition) => {
        if (isPlainObject(definition)
            && typeof definition.iri === 'string'
            && typeof definition.valueType === 'string'
            && !attributes.has(definition.iri)) {
          addUniqueOntologyElement(
            attributes,
            definition.iri,
            definition,
            'attributeType',
            moduleIri,
          );
        }
      });
      if (Array.isArray(metaRoot.patterns)) {
        metaRoot.patterns.forEach((definition) => {
          if (isPlainObject(definition)) {
            addUniqueOntologyElement(patterns, definition.iri, definition, 'pattern', moduleIri);
          }
        });
      }
    }
  }
  return { attributes, patterns, relations, types };
}

function validateActualOntologyClosure(value, resolver) {
  exactKeys(
    value,
    ['imports', 'modules', 'schemaVersion'],
    'ontologyClosure',
    'S5_CHAIN_ONTOLOGY_CLOSURE',
  );
  if (value.schemaVersion !== '1.0'
      || !Array.isArray(value.imports)
      || !Array.isArray(value.modules)
      || value.modules.length === 0) {
    fail('S5_CHAIN_ONTOLOGY_CLOSURE', 'actual ontology closure inventory is empty or invalid');
  }
  try {
    assertOntologyImportRowsSortedUnique(value.imports);
  } catch (cause) {
    fail('S5_CHAIN_ONTOLOGY_CLOSURE', cause.message);
  }
  for (const [index, row] of value.imports.entries()) {
    exactKeys(
      row,
      [
        'importMode', 'importedModuleIri', 'importedSourceDigest',
        'importedVersion', 'importerModuleIri', 'selectedSymbols',
      ],
      `ontologyClosure.imports[${index}]`,
      'S5_CHAIN_ONTOLOGY_CLOSURE',
    );
  }
  const modules = new Map();
  const targetOwners = new Map();
  let previousModuleIri = null;
  for (const [index, row] of value.modules.entries()) {
    const label = `ontologyClosure.modules[${index}]`;
    exactKeys(
      row,
      ['layer', 'moduleIri', 'normalizedIrDigest', 'sourceDigest', 'sourceRef', 'version'],
      label,
      'S5_CHAIN_ONTOLOGY_CLOSURE',
    );
    if (!['m2', 'm3'].includes(row.layer)) {
      fail('S5_CHAIN_ONTOLOGY_CLOSURE', `${label}.layer must be m2 or m3`);
    }
    absoluteIri(row.moduleIri, `${label}.moduleIri`);
    if (previousModuleIri !== null && utf8Compare(previousModuleIri, row.moduleIri) >= 0) {
      fail('S5_CHAIN_ONTOLOGY_CLOSURE', 'modules must be strictly moduleIri-byte sorted and unique');
    }
    previousModuleIri = row.moduleIri;
    const source = resolver.read(row.sourceRef, `${label}.sourceRef`, ['sourceTree']);
    let document;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes);
      document = yaml.load(text, { json: false });
    } catch (cause) {
      fail('S5_CHAIN_ONTOLOGY_CLOSURE', `${label} is not strict UTF-8 YAML: ${cause.message}`);
    }
    if (!isPlainObject(document) || !isPlainObject(document.module)
        || document.module.moduleIri !== row.moduleIri
        || document.module.version !== row.version) {
      fail('S5_CHAIN_ONTOLOGY_CLOSURE', `${label} identity/version differs from its parsed YAML`);
    }
    if (row.layer === 'm2') {
      try {
        validateDocument(document);
      } catch (cause) {
        fail('S5_CHAIN_ONTOLOGY_CLOSURE', `${label} fails the current typed M2 model: ${cause.message}`);
      }
      for (const target of ontologyModuleTargets(document)) {
        if (targetOwners.has(target)) {
          fail('S5_CHAIN_ONTOLOGY_CLOSURE', `target ${target} has multiple owning modules`);
        }
        targetOwners.set(target, row.moduleIri);
      }
    }
    const expectedIrDigest = taggedJcsDigest(
      row.layer === 'm2' ? 'axiolune-normalized-m2-ir-v1\0' : 'axiolune-normalized-m3-ir-v1\0',
      normalizeOntologyIr(document),
    );
    void expectedIrDigest;
    modules.set(row.moduleIri, { document, row, source });
  }
  const requiredModules = [
    'https://axiolune.ai/ontology/meta/core',
    'https://axiolune.ai/ontology/meta/patterns',
    'https://axiolune.ai/ontology/meta/behavior',
    'https://axiolune.ai/ontology/meta/data-binding',
    'https://axiolune.ai/ontology/finance/foundation',
    'https://axiolune.ai/ontology/finance/market-structure',
    'https://axiolune.ai/ontology/finance/instruments',
    'https://axiolune.ai/ontology/finance/market-rules',
    'https://axiolune.ai/ontology/finance/market-data',
    'https://axiolune.ai/ontology/finance/orders-execution',
    'https://axiolune.ai/ontology/finance/portfolio-positions',
  ];
  for (const moduleIri of requiredModules) {
    if (!modules.has(moduleIri)) {
      fail('S5_CHAIN_ONTOLOGY_CLOSURE', `required actual module is absent: ${moduleIri}`);
    }
  }
  const expectedImports = [];
  for (const [importerModuleIri, module] of modules) {
    for (const imported of module.document.module.imports || []) {
      const importedModuleIri = imported.moduleIri.replace(/#sha256:[0-9a-f]{64}$/u, '');
      const target = modules.get(importedModuleIri);
      if (!target) {
        fail('S5_CHAIN_ONTOLOGY_CLOSURE', `${importerModuleIri} import is absent: ${importedModuleIri}`);
      }
      if (imported.version !== target.row.version) {
        fail('S5_CHAIN_ONTOLOGY_CLOSURE', `${importerModuleIri} import version does not join its source`);
      }
      let selectedSymbols;
      try {
        selectedSymbols = selectedImportSymbolIris(imported);
      } catch (cause) {
        fail(
          'S5_CHAIN_ONTOLOGY_CLOSURE',
          `${importerModuleIri} import has invalid SymbolImportSpec closure: ${cause.message}`,
        );
      }
      expectedImports.push({
        importerModuleIri,
        importedModuleIri,
        importedSourceDigest: target.row.sourceDigest,
        importedVersion: imported.version,
        importMode: imported.importMode,
        selectedSymbols,
      });
    }
  }
  let sortedExpectedImports;
  try {
    sortedExpectedImports = sortUniqueOntologyImportRows(expectedImports);
  } catch (cause) {
    fail('S5_CHAIN_ONTOLOGY_CLOSURE', `derived import closure is invalid: ${cause.message}`);
  }
  if (canonicalJcs(value.imports) !== canonicalJcs(sortedExpectedImports)) {
    fail('S5_CHAIN_ONTOLOGY_CLOSURE', 'import rows are not the exact independently derived YAML closure');
  }
  return {
    closure: value,
    modules,
    semanticIndex: buildOntologySemanticIndex(modules),
    targetOwners,
  };
}

function singleFileReferenceBundleDigest(relativePath, bytes) {
  const pathBytes = Buffer.from(relativePath, 'utf8');
  return artifactDigest(Buffer.concat([
    Buffer.from('axiolune-reference-bundle-v1\0', 'utf8'),
    u64be(1),
    u64be(pathBytes.length),
    pathBytes,
    u64be(bytes.length),
    bytes,
  ]));
}

function validateSyntheticReferenceClosure(value, resolver) {
  exactKeys(
    value,
    [
      'entries', 'lockSourceDigest', 'lockSourceRef', 'referenceBundleDigest',
      'referenceBundleRef', 'schemaVersion',
    ],
    'referenceClosure',
    'S5_CHAIN_REFERENCE_CLOSURE',
  );
  if (value.schemaVersion !== '1.0'
      || !Array.isArray(value.entries)
      || value.entries.length !== 1) {
    fail('S5_CHAIN_REFERENCE_CLOSURE', 'synthetic reference closure inventory drift');
  }
  const lock = resolver.readJson(
    value.lockSourceRef,
    'referenceClosure.lockSourceRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  if (lock.digest !== value.lockSourceDigest) {
    fail('S5_CHAIN_REFERENCE_CLOSURE', 'synthetic reference lock digest drift');
  }
  exactKeys(
    lock.value,
    ['references', 'schemaVersion'],
    'syntheticReferenceLock',
    'S5_CHAIN_REFERENCE_CLOSURE',
  );
  if (lock.value.schemaVersion !== '1.0'
      || !Array.isArray(lock.value.references)
      || lock.value.references.length !== 1) {
    fail('S5_CHAIN_REFERENCE_CLOSURE', 'synthetic reference lock inventory drift');
  }
  const entry = value.entries[0];
  exactKeys(
    entry,
    [
      'artifactDigest', 'artifactRef', 'availability', 'license', 'locators',
      'maturity', 'referenceId', 'releaseOrCommit', 'sourceUrl', 'usageScope',
    ],
    'referenceClosure.entries[0]',
    'S5_CHAIN_REFERENCE_CLOSURE',
  );
  const locked = lock.value.references[0];
  exactKeys(
    locked,
    ['artifactDigest', 'artifactRef', 'id', 'locator'],
    'syntheticReferenceLock.references[0]',
    'S5_CHAIN_REFERENCE_CLOSURE',
  );
  if (entry.referenceId !== 'axiolune-s5-synthetic-reference'
      || entry.referenceId !== locked.id
      || entry.availability !== 'localLocked'
      || entry.maturity !== 'syntheticTestOnly'
      || entry.releaseOrCommit !== 'fixture-v1'
      || entry.license !== 'CC0-1.0 synthetic fixture'
      || entry.usageScope !== 'CQ-S5 executable replay fixture only') {
    fail('S5_CHAIN_REFERENCE_CLOSURE', 'synthetic reference metadata drift');
  }
  absoluteIri(entry.sourceUrl, 'referenceClosure.entries[0].sourceUrl');
  if (!refsEqual(entry.artifactRef, locked.artifactRef)
      || entry.artifactDigest !== locked.artifactDigest
      || !Array.isArray(entry.locators)
      || entry.locators.length !== 1
      || canonicalJcs(entry.locators[0]) !== canonicalJcs(locked.locator)) {
    fail('S5_CHAIN_REFERENCE_CLOSURE', 'reference closure/lock join drift');
  }
  const artifact = resolver.readJson(
    entry.artifactRef,
    'referenceClosure.entries[0].artifactRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  if (artifact.digest !== entry.artifactDigest) {
    fail('S5_CHAIN_REFERENCE_CLOSURE', 'synthetic reference artifact digest drift');
  }
  const locator = entry.locators[0];
  const locatorValidation = validateSourceLocator(locator, {
    at: 'referenceClosure.entries[0].locators[0]',
    selectedBytes: artifact.bytes,
  });
  if (!locatorValidation.ok) {
    fail('S5_CHAIN_REFERENCE_CLOSURE', locatorValidation.errors.join('; '));
  }
  if (locator.kind !== 'wholeFile' || locator.path !== entry.artifactRef.path) {
    fail('S5_CHAIN_REFERENCE_CLOSURE', 'synthetic locator does not select its artifact');
  }
  const extractor = resolver.read(
    locator.extractorProfileRef,
    'referenceClosure.entries[0].locator.extractorProfileRef',
    ['sourceTree'],
  );
  if (extractor.digest !== locator.extractorProfileDigest
      || computeSelectionDigest(locator, artifact.bytes) !== locator.selectionDigest) {
    fail('S5_CHAIN_REFERENCE_CLOSURE', 'synthetic locator extractor/selection drift');
  }
  if (!refsEqual(value.referenceBundleRef, entry.artifactRef)
      || value.referenceBundleDigest !== singleFileReferenceBundleDigest(
        path.posix.basename(entry.artifactRef.path),
        artifact.bytes,
      )) {
    fail('S5_CHAIN_REFERENCE_CLOSURE', 'synthetic reference bundle digest drift');
  }
  return { artifact, closure: value, lock: lock.value };
}

function validateSupportEvidenceClosure(value, resolver) {
  exactKeys(
    value,
    ['entries', 'schemaVersion'],
    'supportEvidenceClosure',
    'S5_CHAIN_SUPPORT_EVIDENCE',
  );
  if (value.schemaVersion !== '1.0' || !Array.isArray(value.entries)) {
    fail('S5_CHAIN_SUPPORT_EVIDENCE', 'support evidence closure is not a v1 entry inventory');
  }
  const expectedRows = [
    ['urn:axiolune:evidence:slice-a:conversion-context:v1', 'conversionContext'],
    ['urn:axiolune:evidence:slice-a:future-prior-input-context:v1', 'completedInputContext'],
    ['urn:axiolune:evidence:slice-a:future-prior-input-set:v1', 'valuationInputSet'],
    ['urn:axiolune:evidence:slice-a:future-prior-pit-request:v1', 'pitRequest'],
    [
      'urn:axiolune:evidence:slice-a:holding-source:v1',
      'portfolioObservationPageResponse',
    ],
    ['urn:axiolune:evidence:slice-a:market-source:v1', 'sourceRecord'],
    ['urn:axiolune:evidence:slice-a:membership-approval:v1', 'approval'],
    ['urn:axiolune:evidence:slice-a:membership-closure-probe:v1', 'closedWorldProbe'],
    ['urn:axiolune:evidence:slice-a:ordering-transform:v1', 'executableTransform'],
    [
      'urn:axiolune:evidence:slice-a:portfolio-observation-completeness-contract:v1',
      'completenessContract',
    ],
    [
      'urn:axiolune:evidence:slice-a:portfolio-observation-extractor-implementation:v1',
      'executableRuntime',
    ],
    [
      'urn:axiolune:evidence:slice-a:portfolio-observation-extractor-profile:v1',
      'sourceExtractorProfile',
    ],
    [
      'urn:axiolune:evidence:slice-a:portfolio-observation-locator-digest-runtime:v1',
      'executableRuntime',
    ],
    [
      'urn:axiolune:evidence:slice-a:portfolio-observation-page-request:1',
      'portfolioObservationPageRequest',
    ],
    [
      'urn:axiolune:evidence:slice-a:portfolio-observation-page-request:2',
      'portfolioObservationPageRequest',
    ],
    [
      'urn:axiolune:evidence:slice-a:portfolio-observation-page-response:2',
      'portfolioObservationPageResponse',
    ],
    [
      'urn:axiolune:evidence:slice-a:portfolio-observation-pagination-contract:v1',
      'paginationContract',
    ],
    [
      'urn:axiolune:evidence:slice-a:portfolio-observation-row-locators:1',
      'portfolioObservationRowLocatorManifest',
    ],
    [
      'urn:axiolune:evidence:slice-a:portfolio-observation-row-locators:2',
      'portfolioObservationRowLocatorManifest',
    ],
    [
      'urn:axiolune:evidence:slice-a:portfolio-observation-snapshot-request:v1',
      'portfolioObservationSnapshotRequest',
    ],
    [
      'urn:axiolune:evidence:slice-a:portfolio-observation-source-contract:v1',
      'portfolioObservationSourceContract',
    ],
    [
      'urn:axiolune:evidence:slice-a:portfolio-observation-source:v1',
      'portfolioObservationClosure',
    ],
    ['urn:axiolune:evidence:slice-a:prior-input-context:v1', 'completedInputContext'],
    ['urn:axiolune:evidence:slice-a:prior-input-set:v1', 'valuationInputSet'],
    ['urn:axiolune:evidence:slice-a:prior-pit-request:v1', 'pitRequest'],
    ['urn:axiolune:evidence:slice-a:source-contract:v1', 'sourceContract'],
    ['urn:axiolune:evidence:slice-a:valuation-formula:v1', 'valuationFormulaImplementation'],
    ['urn:axiolune:evidence:slice-a:valuation-input-contract:v1', 'inputContract'],
    ['urn:axiolune:evidence:slice-a:valuation-output-contract:v1', 'outputContract'],
    ['urn:axiolune:evidence:slice-a:valuation-precision-policy:v1', 'precisionPolicy'],
    ['urn:axiolune:evidence:slice-a:valuation-rounding-policy:v1', 'roundingPolicy'],
    ['urn:axiolune:evidence:slice-a:valuation-runtime:v1', 'runtimeClosure'],
    ['urn:axiolune:evidence:slice-a:valuation-tool-lock:v1', 'toolLock'],
  ];
  if (value.entries.length !== expectedRows.length) {
    fail('S5_CHAIN_SUPPORT_EVIDENCE', 'support evidence closure inventory is incomplete or extra');
  }
  const entries = new Map();
  for (const [index, entry] of value.entries.entries()) {
    const label = `supportEvidenceClosure.entries[${index}]`;
    exactKeys(
      entry,
      ['artifactDigest', 'artifactRef', 'evidenceIri', 'evidenceKind'],
      label,
      'S5_CHAIN_SUPPORT_EVIDENCE',
    );
    if (entry.evidenceIri !== expectedRows[index][0]
        || entry.evidenceKind !== expectedRows[index][1]) {
      fail(
        'S5_CHAIN_SUPPORT_EVIDENCE',
        `${label} evidenceIri/evidenceKind is not the exact byte-sorted contract`,
      );
    }
    absoluteIri(entry.evidenceIri, `${label}.evidenceIri`);
    if (typeof entry.evidenceKind !== 'string'
        || entry.evidenceKind.length === 0
        || entry.evidenceKind !== entry.evidenceKind.normalize('NFC')) {
      fail('S5_CHAIN_SUPPORT_EVIDENCE', `${label}.evidenceKind must be a non-empty NFC string`);
    }
    const artifact = resolver.read(
      entry.artifactRef,
      `${label}.artifactRef`,
      ['sourceTree'],
    );
    if (artifact.digest !== entry.artifactDigest) {
      fail('S5_CHAIN_SUPPORT_EVIDENCE', `${label}.artifactDigest does not match actual bytes`);
    }
    entries.set(entry.evidenceIri, { artifact, entry });
  }
  return {
    closure: value,
    entries,
    valuationPolicyArtifacts: {
      precisionBytes: Buffer.from(entries.get(
        'urn:axiolune:evidence:slice-a:valuation-precision-policy:v1',
      ).artifact.bytes),
      roundingBytes: Buffer.from(entries.get(
        'urn:axiolune:evidence:slice-a:valuation-rounding-policy:v1',
      ).artifact.bytes),
    },
  };
}

function validateSourceEvidenceBindings(rows, supportEvidence, label) {
  const refDigestPairs = [
    ['conversion_context_ref', 'conversion_context_digest'],
    ['holding_source_artifact_ref', 'holding_source_artifact_digest'],
    ['membership_approval_ref', 'membership_approval_digest'],
    ['membership_closure_probe_ref', 'membership_closure_probe_digest'],
    ['ordering_transform_ref', 'ordering_transform_digest'],
    [
      'portfolio_observation_completeness_contract_ref',
      'portfolio_observation_completeness_contract_digest',
    ],
    [
      'portfolio_observation_pagination_contract_ref',
      'portfolio_observation_pagination_contract_digest',
    ],
    [
      'portfolio_observation_source_artifact_ref',
      'portfolio_observation_source_artifact_digest',
    ],
    [
      'portfolio_observation_source_contract_ref',
      'portfolio_observation_source_contract_digest',
    ],
    ['source', 'market_source_artifact_digest'],
    ['source_contract_ref', 'source_contract_digest'],
    ['valuation_formula_ref', 'valuation_formula_digest'],
    ['valuation_input_context_ref', 'valuation_input_context_digest'],
    ['valuation_pit_request_ref', 'valuation_pit_request_digest'],
    ['valuation_precision_policy_ref', 'valuation_precision_policy_digest'],
    ['valuation_rounding_policy_ref', 'valuation_rounding_policy_digest'],
    ['valuation_tool_lock_ref', 'valuation_tool_lock_digest'],
  ];
  const digestOnly = [
    ['valuation_input_contract_digest', 'urn:axiolune:evidence:slice-a:valuation-input-contract:v1'],
    ['valuation_output_contract_digest', 'urn:axiolune:evidence:slice-a:valuation-output-contract:v1'],
    ['valuation_runtime_digest', 'urn:axiolune:evidence:slice-a:valuation-runtime:v1'],
  ];
  const readEvidenceJson = (evidenceIri, evidenceLabel) => {
    const evidence = supportEvidence.entries.get(evidenceIri);
    let text;
    let value;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(evidence.artifact.bytes);
      value = parseJsonRejectingDuplicateMembers(text);
    } catch (cause) {
      fail(
        'S5_CHAIN_SUPPORT_EVIDENCE',
        `${evidenceLabel} is not strict UTF-8 JSON: ${cause.message}`,
      );
    }
    if (text !== canonicalJcs(value)) {
      fail('S5_CHAIN_SUPPORT_EVIDENCE', `${evidenceLabel} is not exact RFC8785 JCS`);
    }
    return value;
  };
  const conversion = readEvidenceJson(
    'urn:axiolune:evidence:slice-a:conversion-context:v1',
    'conversion context',
  );
  exactKeys(
    conversion,
    ['branch', 'conversions', 'priceCurrency', 'reportingCurrency', 'schemaVersion'],
    'conversionContextEvidence',
    'S5_CHAIN_SUPPORT_EVIDENCE',
  );
  if (conversion.schemaVersion !== '1.0'
      || conversion.branch !== 'sameCurrency'
      || conversion.priceCurrency !== 'USD'
      || conversion.reportingCurrency !== 'USD'
      || !Array.isArray(conversion.conversions)
      || conversion.conversions.length !== 0) {
    fail('S5_CHAIN_SUPPORT_EVIDENCE', 'conversion context does not prove the exact no-FX branch');
  }
  const approval = readEvidenceJson(
    'urn:axiolune:evidence:slice-a:membership-approval:v1',
    'membership approval',
  );
  exactKeys(
    approval,
    ['approvalId', 'authority', 'outcome', 'schemaVersion'],
    'membershipApprovalEvidence',
    'S5_CHAIN_SUPPORT_EVIDENCE',
  );
  if (approval.schemaVersion !== '1.0'
      || approval.outcome !== 'approved-for-synthetic-cq'
      || approval.authority
        !== 'https://axiolune.ai/data/finance/foundation/party/portfolio-authority') {
    fail('S5_CHAIN_SUPPORT_EVIDENCE', 'membership approval authority/outcome drift');
  }
  const membershipProbe = readEvidenceJson(
    'urn:axiolune:evidence:slice-a:membership-closure-probe:v1',
    'membership closure probe',
  );
  exactKeys(
    membershipProbe,
    ['complete', 'membershipVersionIris', 'probeId', 'schemaVersion'],
    'membershipClosureProbeEvidence',
    'S5_CHAIN_SUPPORT_EVIDENCE',
  );
  if (membershipProbe.schemaVersion !== '1.0'
      || membershipProbe.complete !== true
      || canonicalJcs(membershipProbe.membershipVersionIris) !== canonicalJcs([
        'https://axiolune.ai/data/finance/portfolio-positions/membership/acme-account/version/locked',
      ])) {
    fail('S5_CHAIN_SUPPORT_EVIDENCE', 'membership closure probe does not prove the exact set');
  }
  const portfolioObservationCompleteness = readEvidenceJson(
    'urn:axiolune:evidence:slice-a:portfolio-observation-completeness-contract:v1',
    'portfolio observation completeness contract',
  );
  if (canonicalJcs(portfolioObservationCompleteness) !== canonicalJcs({
    contractId: 'slice-a-portfolio-observation-completeness-v1',
    duplicatePolicy: 'reject',
    failurePolicy: 'reject-degraded-partial-or-error',
    omissionSemantics: 'completeSnapshot',
    recordScope: 'all-provider-visible-holdings-for-account',
    schemaVersion: '1.0',
  })) {
    fail(
      'S5_CHAIN_SUPPORT_EVIDENCE',
      'portfolio observation completeness contract semantics drift',
    );
  }
  const portfolioObservationPagination = readEvidenceJson(
    'urn:axiolune:evidence:slice-a:portfolio-observation-pagination-contract:v1',
    'portfolio observation pagination contract',
  );
  if (canonicalJcs(portfolioObservationPagination) !== canonicalJcs({
    contractId: 'slice-a-portfolio-observation-pagination-v1',
    cursorMode: 'opaqueImmutable',
    ordering: ['account_logical_iri', 'instrument_logical_iri', 'holding_snapshot_id'],
    replayTermination: 'empty-next-cursor',
    schemaVersion: '1.0',
    snapshotConsistency: 'immutable-provider-snapshot-token',
  })) {
    fail(
      'S5_CHAIN_SUPPORT_EVIDENCE',
      'portfolio observation pagination contract semantics drift',
    );
  }
  const precision = readEvidenceJson(
    'urn:axiolune:evidence:slice-a:valuation-precision-policy:v1',
    'valuation precision policy',
  );
  const rounding = readEvidenceJson(
    'urn:axiolune:evidence:slice-a:valuation-rounding-policy:v1',
    'valuation rounding policy',
  );
  if (canonicalJcs(precision) !== canonicalJcs({
    decimalArithmetic: 'exact',
    intermediateScale: 'unbounded',
    policyId: 'slice-a-exact-decimal-v1',
    schemaVersion: '1.0',
  }) || canonicalJcs(rounding) !== canonicalJcs({
    mode: 'half-even',
    outputScale: 2,
    policyId: 'slice-a-half-even-v1',
    schemaVersion: '1.0',
    stage: 'finalMonetaryAmount',
  })) {
    fail('S5_CHAIN_SUPPORT_EVIDENCE', 'valuation precision/rounding policy drift');
  }
  for (const [index, row] of rows.entries()) {
    for (const [refField, digestField] of refDigestPairs) {
      const evidence = supportEvidence.entries.get(row[refField]);
      if (!evidence || evidence.entry.artifactDigest !== row[digestField]) {
        fail(
          'S5_CHAIN_SUPPORT_EVIDENCE',
          `${label}.rows[${index}] ${refField}/${digestField} does not join exact evidence bytes`,
        );
      }
    }
    for (const [digestField, evidenceIri] of digestOnly) {
      if (row[digestField]
          !== supportEvidence.entries.get(evidenceIri)?.entry.artifactDigest) {
        fail(
          'S5_CHAIN_SUPPORT_EVIDENCE',
          `${label}.rows[${index}].${digestField} does not join exact evidence bytes`,
        );
      }
    }
    const priorContext = readEvidenceJson(
      row.valuation_input_context_ref,
      `${label}.rows[${index}] prior input context`,
    );
    exactKeys(
      priorContext,
      [
        'completedAt', 'contextId', 'inputSetDigest', 'inputSetRef', 'outcome', 'schemaVersion',
      ],
      `${label}.rows[${index}].priorInputContextEvidence`,
      'S5_CHAIN_SUPPORT_EVIDENCE',
    );
    if (priorContext.schemaVersion !== '1.0' || priorContext.outcome !== 'completed') {
      fail('S5_CHAIN_SUPPORT_EVIDENCE', `${label}.rows[${index}] prior input context is not completed`);
    }
    const inputSetEvidence = supportEvidence.entries.get(priorContext.inputSetRef);
    if (!inputSetEvidence
        || inputSetEvidence.entry.evidenceKind !== 'valuationInputSet'
        || inputSetEvidence.entry.artifactDigest !== priorContext.inputSetDigest) {
      fail(
        'S5_CHAIN_SUPPORT_EVIDENCE',
        `${label}.rows[${index}] prior input context does not bind an exact valuation input set`,
      );
    }
    const inputSet = readEvidenceJson(
      priorContext.inputSetRef,
      `${label}.rows[${index}] valuation input set`,
    );
    exactKeys(
      inputSet,
      ['fields', 'schemaVersion', 'selectionComplete', 'setId'],
      `${label}.rows[${index}].valuationInputSetEvidence`,
      'S5_CHAIN_SUPPORT_EVIDENCE',
    );
    exactKeys(
      inputSet.fields,
      VALUATION_INPUT_FIELD_NAMES,
      `${label}.rows[${index}].valuationInputSetEvidence.fields`,
      'S5_CHAIN_SUPPORT_EVIDENCE',
    );
    const selectedInputProjection = Object.fromEntries(
      VALUATION_INPUT_FIELD_NAMES.map((field) => [field, row[field]]),
    );
    if (inputSet.schemaVersion !== '1.0'
        || inputSet.selectionComplete !== true
        || typeof inputSet.setId !== 'string'
        || inputSet.setId.length === 0
        || inputSet.setId !== inputSet.setId.normalize('NFC')
        || canonicalJcs(inputSet.fields) !== canonicalJcs(selectedInputProjection)) {
      fail(
        'S5_CHAIN_SUPPORT_EVIDENCE',
        `${label}.rows[${index}] valuation input set does not equal the exact selected price/holding/quotation projection`,
      );
    }
    const priorPit = readEvidenceJson(
      row.valuation_pit_request_ref,
      `${label}.rows[${index}] prior PIT request`,
    );
    exactKeys(
      priorPit,
      [
        'asOfAvailable', 'asOfKnowledge', 'asOfValid', 'inputContextDigest',
        'inputContextRef', 'requestId', 'schemaVersion',
      ],
      `${label}.rows[${index}].priorPitRequestEvidence`,
      'S5_CHAIN_SUPPORT_EVIDENCE',
    );
    if (priorPit.schemaVersion !== '1.0') {
      fail('S5_CHAIN_SUPPORT_EVIDENCE', `${label}.rows[${index}] prior PIT request schema drift`);
    }
    if (priorPit.asOfAvailable !== row.available_from
        || priorPit.asOfKnowledge !== row.knowledge_from
        || priorPit.asOfValid !== row.valid_from
        || priorPit.inputContextRef !== row.valuation_input_context_ref
        || priorPit.inputContextDigest !== row.valuation_input_context_digest
        || instantEpoch(priorContext.completedAt, 'priorInputContext.completedAt')
          >= instantEpoch(row.knowledge_from, `${label}.rows[${index}].knowledge_from`)) {
      fail(
        'S5_CHAIN_SUPPORT_EVIDENCE',
        `${label}.rows[${index}] does not bind a matching PIT request and strictly prior context`,
      );
    }
  }
}

function validateValuationExecutableEvidence(
  supportEvidence,
  sourceSchemaRef,
  sourceSchemaDigest,
  toolLockRef,
  toolLockArtifact,
  toolLockState,
) {
  const evidence = (iri) => {
    const value = supportEvidence.entries.get(iri);
    if (!value) fail('S5_CHAIN_SUPPORT_EVIDENCE', `required executable evidence is absent: ${iri}`);
    return value.entry;
  };
  const assertTuple = (entry, expectedRef, expectedDigest, label) => {
    if (!refsEqual(entry.artifactRef, expectedRef)
        || entry.artifactDigest !== expectedDigest) {
      fail(
        'S5_CHAIN_SUPPORT_EVIDENCE',
        `${label} does not join the executing source/runtime/tool closure`,
      );
    }
  };
  const materializerCapability = toolLockState.materializer.capabilities.find(
    (entry) => entry.capabilityId === 's5-canonical-materialization',
  );
  if (!materializerCapability) {
    fail('S5_CHAIN_TOOL_LOCK', 's5-canonical-materialization capability missing');
  }
  const runtimeClosure = toolLockState.runtimeClosures.get('s5-canonical-materializer');
  const materializer = runtimeClosure?.entries?.find((entry) => (
    entry.artifactRef?.kind === 'path'
      && entry.artifactRef.root === 'sourceTree'
      && entry.artifactRef.path === 'scripts/domain/lib/s5-canonical-materialization.cjs'
  ));
  if (!materializer) {
    fail('S5_CHAIN_TOOL_LOCK', 'canonical valuation materializer is absent from the runtime closure');
  }
  assertTuple(
    evidence('urn:axiolune:evidence:slice-a:ordering-transform:v1'),
    materializer.artifactRef,
    materializer.artifactDigest,
    'ordering transform evidence',
  );
  assertTuple(
    evidence('urn:axiolune:evidence:slice-a:valuation-formula:v1'),
    materializerCapability.capabilityRef,
    materializerCapability.capabilityDigest,
    'valuation formula evidence',
  );
  assertTuple(
    evidence('urn:axiolune:evidence:slice-a:valuation-input-contract:v1'),
    sourceSchemaRef,
    sourceSchemaDigest,
    'valuation input contract evidence',
  );
  assertTuple(
    evidence('urn:axiolune:evidence:slice-a:valuation-output-contract:v1'),
    materializerCapability.outputContractRef,
    materializerCapability.outputContractDigest,
    'valuation output contract evidence',
  );
  assertTuple(
    evidence('urn:axiolune:evidence:slice-a:valuation-runtime:v1'),
    toolLockState.materializer.runtimeRef,
    toolLockState.materializer.runtimeDigest,
    'valuation runtime evidence',
  );
  assertTuple(
    evidence('urn:axiolune:evidence:slice-a:valuation-tool-lock:v1'),
    toolLockRef,
    toolLockArtifact.digest,
    'valuation tool-lock evidence',
  );
}

function collectTransformationRefs(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectTransformationRefs(entry, output));
    return output;
  }
  if (!isPlainObject(value)) return output;
  if (value.bindingType === 'transformation') {
    absoluteIri(value.transformationRef, 'mapping transformationRef');
    output.push(value.transformationRef);
  }
  Object.values(value).forEach((entry) => collectTransformationRefs(entry, output));
  return output;
}

function validateTransformationClosure(value, expectedTransformationRefs, resolver, label) {
  exactKeys(
    value,
    ['mappingRef', 'schemaVersion', 'transformations'],
    label,
    'S5_CHAIN_TRANSFORMATION',
  );
  absoluteIri(value.mappingRef, `${label}.mappingRef`);
  if (value.schemaVersion !== '1.0'
      || !Array.isArray(value.transformations)) {
    fail('S5_CHAIN_TRANSFORMATION', `${label} transformation inventory drift`);
  }
  const expected = [...new Set(expectedTransformationRefs)].sort(utf8Compare);
  const actual = value.transformations.map((entry) => entry?.transformationRef);
  if (canonicalJcs(actual) !== canonicalJcs(expected)) {
    fail(
      'S5_CHAIN_TRANSFORMATION',
      `${label} must equal the mapping's exact byte-sorted transformationRef inventory`,
    );
  }
  for (const [index, transformation] of value.transformations.entries()) {
    exactKeys(
      transformation,
      [
        'capabilityDigest', 'capabilityId', 'capabilityRef',
        'definitionDigest', 'definitionRef', 'dependencies',
        'implementationDigest', 'implementationRef',
        'inputContractDigest', 'inputContractRef', 'outputContractDigest',
        'outputContractRef', 'runtimeDigest', 'runtimeRef', 'transformationRef',
      ],
      `${label}.transformations[${index}]`,
      'S5_CHAIN_TRANSFORMATION',
    );
    absoluteIri(
      transformation.transformationRef,
      `${label}.transformations[${index}].transformationRef`,
    );
    if (!Array.isArray(transformation.dependencies)
        || transformation.dependencies.length !== 0) {
      fail(
        'S5_CHAIN_TRANSFORMATION',
        `${label}.transformations[${index}].dependencies must be explicitly empty`,
      );
    }
    for (const [field, digestField] of [
      ['capabilityRef', 'capabilityDigest'],
      ['definitionRef', 'definitionDigest'],
      ['implementationRef', 'implementationDigest'],
      ['inputContractRef', 'inputContractDigest'],
      ['outputContractRef', 'outputContractDigest'],
      ['runtimeRef', 'runtimeDigest'],
    ]) {
      const artifact = resolver.read(
        transformation[field],
        `${label}.transformations[${index}].${field}`,
        ['sourceTree'],
      );
      if (artifact.digest !== transformation[digestField]) {
        fail(
          'S5_CHAIN_TRANSFORMATION',
          `${label}.transformations[${index}].${field} digest drift`,
        );
      }
    }
    const definition = resolver.readJson(
      transformation.definitionRef,
      `${label}.transformations[${index}].definitionRef`,
      { allowedRoots: ['sourceTree'], exactJcs: true },
    );
    if (definition.digest !== transformation.definitionDigest
        || !isPlainObject(definition.value)
        || definition.value.iri !== transformation.transformationRef) {
      fail(
        'S5_CHAIN_TRANSFORMATION',
        `${label}.transformations[${index}].definitionRef does not bind the exact transformation definition identity`,
      );
    }
  }
  return value.transformations;
}

function validateMappingArtifact(value, descriptor, sourceSchema, resolver, label) {
  exactKeys(
    value,
    [
      'identity', 'iri', 'label', 'mappingType', 'provenance', 'slotMappings',
      'source', 'targetType', 'temporal',
    ],
    label,
    'S5_CHAIN_MAPPING',
  );
  for (const field of ['iri', 'targetType']) {
    absoluteIri(value[field], `${label}.${field}`);
  }
  if (value.iri !== descriptor.mappingRef || value.mappingType !== 'directTable'
      || typeof value.label !== 'string' || value.label.length === 0) {
    fail('S5_CHAIN_MAPPING', `${label} descriptor identity/mappingType drift`);
  }
  exactKeys(value.identity, ['contractRef', 'logicalKeyBindings', 'versionKeyBindings'], `${label}.identity`, 'S5_CHAIN_MAPPING');
  if (value.identity.contractRef !== descriptor.identityContractRef) {
    fail('S5_CHAIN_MAPPING', `${label} does not bind its digest-locked target identity contract`);
  }
  exactKeys(value.source, ['datasets'], `${label}.source`, 'S5_CHAIN_MAPPING');
  if (!Array.isArray(value.source.datasets) || value.source.datasets.length !== 1
      || canonicalJcs(value.source.datasets[0]) !== canonicalJcs({
        alias: 'row', dataset: sourceSchema.dataset,
      })) {
    fail('S5_CHAIN_MAPPING', `${label} source binding drift`);
  }
  const expectedVersionFields = {
    availableFrom: 'available_from',
    knowledgeFrom: 'knowledge_from',
    revision: 'revision',
    validFrom: 'valid_from',
  };
  if (canonicalJcs(Object.keys(value.identity.versionKeyBindings).sort(utf8Compare))
      !== canonicalJcs(Object.keys(expectedVersionFields).sort(utf8Compare))) {
    fail('S5_CHAIN_MAPPING', `${label} version key must be exactly validFrom/knowledgeFrom/availableFrom/revision`);
  }
  for (const [component, field] of Object.entries(expectedVersionFields)) {
    if (canonicalJcs(value.identity.versionKeyBindings[component]) !== canonicalJcs({
      bindingType: 'directField', source: { dataset: 'row', field },
    })) {
      fail('S5_CHAIN_MAPPING', `${label} ${component} version binding drift`);
    }
  }
  exactKeys(
    value.temporal,
    ['availabilityTime', 'knowledgeTime', 'patternRef', 'validTime'],
    `${label}.temporal`,
    'S5_CHAIN_MAPPING',
  );
  const direct = (field) => ({ bindingType: 'directField', source: { dataset: 'row', field } });
  if (canonicalJcs(value.temporal) !== canonicalJcs({
    patternRef: 'https://axiolune.ai/ontology/meta/patterns/TemporalFact',
    validTime: { closePolicy: 'explicitOnly', from: direct('valid_from') },
    knowledgeTime: { closePolicy: 'explicitOnly', from: direct('knowledge_from') },
    availabilityTime: { closePolicy: 'explicitOnly', from: direct('available_from') },
  })) {
    fail('S5_CHAIN_MAPPING', `${label} temporal mapping drift`);
  }
  const expectedProvenanceSourceField = value.targetType
    === 'https://axiolune.ai/ontology/finance/portfolio-positions/HoldingSnapshot'
    ? 'holding_source_artifact_ref'
    : 'source';
  if (descriptor.provenanceSourceField !== expectedProvenanceSourceField
      || canonicalJcs(value.provenance) !== canonicalJcs({
        sourceSystem: direct(expectedProvenanceSourceField),
      })) {
    fail('S5_CHAIN_MAPPING', `${label} provenance source binding drift`);
  }
  if (!Array.isArray(value.slotMappings) || value.slotMappings.length === 0) {
    fail('S5_CHAIN_MAPPING', `${label} has no actual M2 slot mappings`);
  }
  const closure = resolver.readJson(
    descriptor.transformationClosureRef,
    `${label}.transformationClosureRef`,
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  const transformationRefs = collectTransformationRefs(value).sort(utf8Compare);
  const transformations = validateTransformationClosure(
    closure.value,
    transformationRefs,
    resolver,
    `${label}.transformationClosure`,
  );
  if (closure.value.mappingRef !== value.iri) {
    fail('S5_CHAIN_MAPPING', `${label} transformation closure identity drift`);
  }
  return {
    closure: closure.value,
    closureArtifact: closure,
    mapping: value,
    transformations,
  };
}

function validateMaterializationPlan(value, descriptor, mappings, sourceSchema, label) {
  exactKeys(
    value,
    [
      'definition', 'iri', 'label', 'materializationMode', 'owner',
      'semanticMappings', 'sourceDatasets', 'targetGraphUri',
      'targetOntologyModule',
    ],
    label,
    'S5_CHAIN_PLAN_SOURCE',
  );
  if (value.iri !== descriptor.planRef
      || canonicalJcs(value.semanticMappings)
        !== canonicalJcs(mappings.map((mapping) => mapping.iri))
      || canonicalJcs(value.sourceDatasets) !== canonicalJcs([sourceSchema.dataset])
      || value.targetGraphUri !== descriptor.targetGraph
      || value.materializationMode !== 'Full'
      || value.owner !== 'repository-owner') {
    fail('S5_CHAIN_PLAN_SOURCE', `${label} identity/mapping/requirements drift`);
  }
  for (const field of ['iri', 'targetGraphUri', 'targetOntologyModule']) {
    absoluteIri(value[field], `${label}.${field}`);
  }
  for (const field of ['definition', 'label']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      fail('S5_CHAIN_PLAN_SOURCE', `${label}.${field} must be non-empty`);
    }
  }
}

function validateBatchDefinition(value, mappingData, targetDataset) {
  exactKeys(
    value,
    [
      'consistencyRequirement', 'definition', 'dependencyEdges', 'iri', 'label', 'plans',
      'targetDataset',
    ],
    'batchDefinition',
    'S5_CHAIN_BATCH_SOURCE',
  );
  if (value.consistencyRequirement !== 'Transactional'
      || value.targetDataset !== targetDataset
      || !Array.isArray(value.plans)
      || value.plans.length !== mappingData.length) {
    fail('S5_CHAIN_BATCH_SOURCE', 'batch definition identity/inventory drift');
  }
  absoluteIri(value.iri, 'batchDefinition.iri');
  absoluteIri(value.targetDataset, 'batchDefinition.targetDataset');
  sortedUniqueStrings(value.plans, 'batchDefinition.plans');
  const expectedPlans = mappingData.map((entry) => entry.plan.iri).sort(utf8Compare);
  if (value.plans.some((entry, index) => entry !== expectedPlans[index])) {
    fail('S5_CHAIN_BATCH_SOURCE', 'batch definition plan inventory drift');
  }

  const planByMapping = new Map();
  for (const group of mappingData) {
    for (const mapping of group.mappings) {
      planByMapping.set(mapping.mapping.iri, group.plan.iri);
    }
  }
  const expectedEdgeKeys = new Set();
  function discoverReferences(node, consumerPlan) {
    if (Array.isArray(node)) {
      node.forEach((child) => discoverReferences(child, consumerPlan));
      return;
    }
    if (!isPlainObject(node)) return;
    if (node.bindingType === 'referenceIdentity') {
      const producerPlan = planByMapping.get(node.targetMappingRef);
      if (!producerPlan) {
        fail(
          'S5_CHAIN_BATCH_DEPENDENCY',
          `referenceIdentity target is outside the batch mapping closure: ${node.targetMappingRef}`,
        );
      }
      if (producerPlan !== consumerPlan) {
        expectedEdgeKeys.add(`${producerPlan}\0${consumerPlan}`);
      }
    }
    Object.values(node).forEach((child) => discoverReferences(child, consumerPlan));
  }
  for (const group of mappingData) {
    group.mappings.forEach((entry) => discoverReferences(entry.mapping, group.plan.iri));
  }
  if (!Array.isArray(value.dependencyEdges)) {
    fail('S5_CHAIN_BATCH_DEPENDENCY', 'batch dependencyEdges must be an explicit array');
  }
  const declaredEdgeKeys = [];
  for (const [index, edge] of value.dependencyEdges.entries()) {
    exactKeys(
      edge,
      ['afterPlan', 'beforePlan'],
      `batchDefinition.dependencyEdges[${index}]`,
      'S5_CHAIN_BATCH_DEPENDENCY',
    );
    absoluteIri(edge.beforePlan, `batchDefinition.dependencyEdges[${index}].beforePlan`);
    absoluteIri(edge.afterPlan, `batchDefinition.dependencyEdges[${index}].afterPlan`);
    if (edge.beforePlan === edge.afterPlan
        || !value.plans.includes(edge.beforePlan)
        || !value.plans.includes(edge.afterPlan)) {
      fail('S5_CHAIN_BATCH_DEPENDENCY', 'dependency edge endpoints must be distinct batch plans');
    }
    declaredEdgeKeys.push(`${edge.beforePlan}\0${edge.afterPlan}`);
  }
  const sortedDeclared = [...declaredEdgeKeys].sort(utf8Compare);
  const sortedExpected = [...expectedEdgeKeys].sort(utf8Compare);
  if (new Set(declaredEdgeKeys).size !== declaredEdgeKeys.length
      || declaredEdgeKeys.some((edge, index) => edge !== sortedDeclared[index])
      || canonicalJcs(sortedDeclared) !== canonicalJcs(sortedExpected)) {
    fail(
      'S5_CHAIN_BATCH_DEPENDENCY',
      'dependencyEdges must be sorted, unique, and exactly justified by cross-plan referenceIdentity bindings',
    );
  }

  const adjacency = new Map(value.plans.map((plan) => [plan, []]));
  value.dependencyEdges.forEach((edge) => adjacency.get(edge.beforePlan).push(edge.afterPlan));
  const visiting = new Set();
  const visited = new Set();
  function visit(plan) {
    if (visiting.has(plan)) fail('S5_CHAIN_BATCH_DEPENDENCY', 'batch dependency graph is cyclic');
    if (visited.has(plan)) return;
    visiting.add(plan);
    adjacency.get(plan).forEach(visit);
    visiting.delete(plan);
    visited.add(plan);
  }
  value.plans.forEach(visit);
}

function selectHistoricalRows(snapshot, pivots) {
  const valid = instantEpoch(pivots.asOfValid, 'pivots.asOfValid');
  const knowledge = instantEpoch(pivots.asOfKnowledge, 'pivots.asOfKnowledge');
  const available = instantEpoch(pivots.asOfAvailable, 'pivots.asOfAvailable');
  return snapshot.rows.filter((row) => (
    instantEpoch(row.valid_from, 'row.valid_from') <= valid
    && instantEpoch(row.knowledge_from, 'row.knowledge_from') <= knowledge
    && instantEpoch(row.available_from, 'row.available_from') <= available
  )).sort((left, right) => utf8Compare(rowKey(left), rowKey(right)));
}

function historicalSelectionDigest(rows) {
  return taggedJcsDigest('axiolune-pit-historical-selection-v1\0', { rows });
}

function moduleSidecarRef(moduleSourceRef) {
  if (!isPlainObject(moduleSourceRef)
      || moduleSourceRef.kind !== 'path'
      || !moduleSourceRef.path.endsWith('/module.yaml')) {
    fail('S5_CHAIN_SHACL_SOURCE', 'M2 ontology sourceRef must end with /module.yaml');
  }
  return pathRef(moduleSourceRef.root, moduleSourceRef.path.replace(/module\.yaml$/u, 'module.shacl.ttl'));
}

function runMaterializedCurrentDomainShacl(
  resolver,
  ontology,
  moduleIri,
  materialized,
  supportNquads,
  targetGraphIri,
  validationModuleIris = [moduleIri],
) {
  if (!Array.isArray(validationModuleIris)
      || validationModuleIris.length === 0
      || !validationModuleIris.includes(moduleIri)) {
    fail(
      'S5_CHAIN_SHACL_SOURCE',
      `${moduleIri} validation module closure must be non-empty and contain the primary module`,
    );
  }
  const orderedModuleIris = [...new Set(validationModuleIris)].sort(utf8Compare);
  if (orderedModuleIris.length !== validationModuleIris.length) {
    fail('S5_CHAIN_SHACL_SOURCE', `${moduleIri} validation module closure contains a duplicate`);
  }
  const materializedDatasetDigest = artifactDigest(Buffer.from(materialized.nquads, 'utf8'));
  const validationSupportDigest = artifactDigest(Buffer.from(supportNquads, 'utf8'));
  const validations = [];
  for (const validationModuleIri of orderedModuleIris) {
    const module = ontology.modules.get(validationModuleIri);
    if (!module || module.row.layer !== 'm2') {
      fail('S5_CHAIN_SHACL_SOURCE', `current M2 module is absent: ${validationModuleIri}`);
    }
    const sidecarRef = moduleSidecarRef(module.row.sourceRef);
    const hydration = hydrateVerifierInstalledRuntimeAndSources(
      resolver,
      [module.row.sourceRef, sidecarRef],
      'S5_CHAIN_RUNTIME',
      `${validationModuleIri} SHACL`,
    );
    try {
      const workerRef = pathRef(
        'sourceTree',
        'scripts/domain/lib/s5-materialized-shacl-worker.cjs',
      );
      const request = {
        dataNQuads: materialized.nquads,
        moduleSidecarPath: hydration.pathFor(
          sidecarRef,
          `${validationModuleIri} hydrated SHACL sidecar`,
        ),
        moduleSourcePath: hydration.pathFor(
          module.row.sourceRef,
          `${validationModuleIri} hydrated module source`,
        ),
        schemaVersion: '1.0',
        supportNQuads: supportNquads,
        targetGraphIri,
      };
      const execution = spawnSync(process.execPath, [
        hydration.pathFor(workerRef, `${validationModuleIri} installed SHACL worker`),
      ], {
        cwd: hydration.root,
        encoding: 'utf8',
        env: completedReplayWorkerEnvironment(),
        input: canonicalJcs(request),
        shell: false,
        timeout: 10 * 60 * 1000,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (execution.error || execution.status !== 0) {
        fail(
          'S5_CHAIN_CURRENT_DOMAIN_SHACL',
          `${validationModuleIri}: ${
            execution.error?.message || execution.stderr.trim() || `worker exited ${execution.status}`
          }`,
        );
      }
      let moduleEvidence;
      try {
        moduleEvidence = parseJsonRejectingDuplicateMembers(execution.stdout);
      } catch (cause) {
        fail(
          'S5_CHAIN_CURRENT_DOMAIN_SHACL',
          `${validationModuleIri} worker emitted invalid JSON: ${cause.message}`,
        );
      }
      if (execution.stdout !== canonicalJcs(moduleEvidence)
          || moduleEvidence.outcome !== 'passed'
          || moduleEvidence.module.moduleIri !== validationModuleIri
          || moduleEvidence.data.targetGraphIri !== targetGraphIri) {
        fail(
          'S5_CHAIN_CURRENT_DOMAIN_SHACL',
          `${validationModuleIri} worker evidence does not match the materialized validation outcome`,
        );
      }
      validations.push(moduleEvidence);
    } finally {
      removeCompletedReportReplaySourceTree(hydration);
    }
  }
  return {
    evidence: {
      artifactKind: 's5MaterializedCurrentDomainShaclEvidenceSet',
      data: {
        materializedDatasetDigest,
        targetGraphIri,
        validationSupportDigest,
      },
      outcome: 'passed',
      primaryModuleIri: moduleIri,
      schemaVersion: '1.0',
      validatedModuleIris: orderedModuleIris,
      validations,
    },
    workerRef: pathRef('sourceTree', 'scripts/domain/lib/s5-materialized-shacl-worker.cjs'),
  };
}

function runMaterializedApplicableCustom(
  resolver,
  ontology,
  materialized,
  supportNquads,
  supportEvidence,
  targetGraphIri,
  executionContext,
  allowedGeneratingContextIris,
) {
  const moduleIris = [...new Set(MATERIALIZATION_RUN_SPECS.flatMap(
    (spec) => spec.validationModuleIris,
  ))].sort(utf8Compare);
  const moduleSourceRefs = moduleIris.map((moduleIri) => {
    const module = ontology.modules.get(moduleIri);
    if (!module || module.row.layer !== 'm2') {
      fail('S5_CHAIN_CUSTOM_SOURCE', `current M2 module is absent: ${moduleIri}`);
    }
    return module.row.sourceRef;
  });
  const lockedEvidenceArtifacts = supportEvidence.closure.entries.map((entry) => ({
    artifactDigest: entry.artifactDigest,
    artifactRef: entry.artifactRef,
    evidenceIri: entry.evidenceIri,
    evidenceKind: entry.evidenceKind,
  })).sort((left, right) => utf8Compare(left.evidenceIri, right.evidenceIri));
  const hydration = hydrateVerifierInstalledRuntimeAndSources(
    resolver,
    [
      ...moduleSourceRefs,
      ...lockedEvidenceArtifacts.map((entry) => entry.artifactRef),
    ],
    'S5_CHAIN_RUNTIME',
    'applicable Custom',
  );
  try {
    const workerRef = pathRef(
      'sourceTree',
      'scripts/domain/lib/s5-materialized-custom-worker.cjs',
    );
    const request = {
      allowedGeneratingContextIris: [...allowedGeneratingContextIris].sort(utf8Compare),
      asOfAvailable: executionContext.asOfAvailable,
      asOfKnowledge: executionContext.asOfKnowledge,
      asOfValid: executionContext.asOfValid,
      dataNQuads: materialized.nquads,
      lockedEvidenceArtifacts: lockedEvidenceArtifacts.map((entry) => ({
        artifactDigest: entry.artifactDigest,
        artifactRef: entry.artifactRef,
        evidenceIri: entry.evidenceIri,
        evidenceKind: entry.evidenceKind,
        file: hydration.pathFor(
          entry.artifactRef,
          `${entry.evidenceIri} hydrated Custom evidence`,
        ),
      })),
      moduleSourcePaths: moduleSourceRefs.map((ref, index) => hydration.pathFor(
        ref,
        `${moduleIris[index]} hydrated Custom module`,
      )),
      referenceTime: executionContext.referenceTime,
      schemaVersion: '1.0',
      supportNQuads: supportNquads,
      targetGraphIri,
    };
    const execution = spawnSync(process.execPath, [
      hydration.pathFor(workerRef, 'installed applicable-Custom worker'),
    ], {
      cwd: hydration.root,
      encoding: 'utf8',
      env: completedReplayWorkerEnvironment(),
      input: canonicalJcs(request),
      shell: false,
      timeout: 10 * 60 * 1000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (execution.error || execution.status !== 0) {
      fail(
        'S5_CHAIN_APPLICABLE_CUSTOM',
        execution.stderr.trim() || execution.error?.message || `worker exited ${execution.status}`,
      );
    }
    let evidence;
    try {
      evidence = parseJsonRejectingDuplicateMembers(execution.stdout);
    } catch (cause) {
      fail('S5_CHAIN_APPLICABLE_CUSTOM', `worker emitted invalid JSON: ${cause.message}`);
    }
    const expectedModuleRows = moduleIris.map((moduleIri) => {
      const module = ontology.modules.get(moduleIri);
      return { moduleIri, sourceDigest: module.row.sourceDigest };
    });
    const expectedEvidenceRows = lockedEvidenceArtifacts.map((entry) => ({
      artifactDigest: entry.artifactDigest,
      evidenceIri: entry.evidenceIri,
      evidenceKind: entry.evidenceKind,
    }));
    if (execution.stdout !== canonicalJcs(evidence)
        || evidence.outcome !== 'passed'
        || evidence.counts.discovered <= 0
        || evidence.counts.discovered !== evidence.counts.executed
        || evidence.counts.executed !== evidence.counts.passed
        || evidence.counts.failed !== 0
        || evidence.data.targetGraphIri !== targetGraphIri
        || canonicalJcs(evidence.context.allowedGeneratingContextIris)
          !== canonicalJcs(request.allowedGeneratingContextIris)) {
      fail(
        'S5_CHAIN_APPLICABLE_CUSTOM',
        'Custom evidence does not match the materialized custom validation outcome',
      );
    }
    return { evidence };
  } finally {
    removeCompletedReportReplaySourceTree(hydration);
  }
}

function reportToolBinding(toolLock) {
  const tool = toolLock.tools.find((entry) => entry.toolId === 's5-control-record-chain');
  const capability = tool.capabilities.find((entry) => entry.capabilityId === 's5-control-chain');
  if (!capability) fail('S5_CHAIN_TOOL_LOCK', 's5-control-chain capability missing');
  return {
    toolId: tool.toolId,
    capabilityId: capability.capabilityId,
    capabilityRef: capability.capabilityRef,
    capabilityDigest: capability.capabilityDigest,
    entrypointRef: capability.entrypointRef,
    entrypointDigest: capability.entrypointDigest,
    discoveryContractRef: capability.discoveryContractRef,
    discoveryContractDigest: capability.discoveryContractDigest,
    evidenceSchemaRef: capability.evidenceSchemaRef,
    evidenceSchemaDigest: capability.evidenceSchemaDigest,
  };
}

function validateMappingToolBindings(
  mappingData,
  toolLockState,
  sourceSchemaRef,
  sourceSchemaDigest,
) {
  const capability = toolLockState.materializer.capabilities.find(
    (entry) => entry.capabilityId === 's5-canonical-materialization',
  );
  if (!capability) {
    fail('S5_CHAIN_TOOL_LOCK', 's5-canonical-materialization capability missing');
  }
  mappingData.flatMap((group) => group.mappings).forEach((mapping, index) => {
    mapping.transformations.forEach((transformation, transformationIndex) => {
      if (transformation.capabilityId !== capability.capabilityId
          || !refsEqual(transformation.capabilityRef, capability.capabilityRef)
          || transformation.capabilityDigest !== capability.capabilityDigest
          || !refsEqual(transformation.implementationRef, capability.entrypointRef)
          || transformation.implementationDigest !== capability.entrypointDigest
          || !refsEqual(transformation.runtimeRef, toolLockState.materializer.runtimeRef)
          || transformation.runtimeDigest !== toolLockState.materializer.runtimeDigest
          || !refsEqual(transformation.inputContractRef, sourceSchemaRef)
          || transformation.inputContractDigest !== sourceSchemaDigest
          || !refsEqual(transformation.outputContractRef, capability.outputContractRef)
          || transformation.outputContractDigest !== capability.outputContractDigest) {
        fail(
          'S5_CHAIN_TRANSFORMATION',
          `mapping[${index}].transformations[${transformationIndex}] does not join the locked runtime/contracts`,
        );
      }
    });
  });
}

function makePlannedInput(recordType, slotId, recordIdValue, attemptId, selectors = []) {
  if (recordType === 'evidenceLedger') fail('S5_CHAIN_INTERNAL', 'ledger planned input is constructed separately');
  return {
    dependencySelectors: [...selectors].sort((left, right) => tupleCompare(
      [left.sourceSlotId, left.sourceStage, left.fieldPointer],
      [right.sourceSlotId, right.sourceStage, right.fieldPointer],
    )),
    recordType,
    schemaVersion: '1.0',
    staticInputs: {
      attemptId,
      recordId: recordIdValue,
      slotId,
    },
  };
}

function altDescriptor(recordType, recordIdValue, attemptId, activation, dependencies, planned) {
  return {
    activation,
    attemptId,
    finalizationDependencies: [...dependencies].sort((left, right) => tupleCompare(
      [left.targetStage, left.sourceSlotId, left.sourceStage],
      [right.targetStage, right.sourceSlotId, right.sourceStage],
    )),
    planned,
    recordId: recordIdValue,
    recordType,
  };
}

function buildPlanTemplate(schemaManifestRef, schemaManifestDigest) {
  const attemptId = 'attempt-1';
  const slots = [
    {
      slotId: 'batch-report', cardinality: 'outcomeChoice', alternatives: [
        altDescriptor('failureReport', 'batch-failed', attemptId, { kind: 'outcomeEquals', parentOutcome: 'failed', parentSlotId: 'batch-run' }, [], makePlannedInput('failureReport', 'batch-report', 'batch-failed', attemptId, [{ sourceSlotId: 'batch-run', sourceStage: 'executionOutput', fieldPointer: '/result/outcome' }])),
        altDescriptor('validationReport', 'batch-passed', attemptId, { kind: 'outcomeEquals', parentOutcome: 'completed', parentSlotId: 'batch-run' }, [
          { sourceSlotId: 'identity-run', sourceStage: 'finalRecord', targetStage: 'executionOutput' },
          { sourceSlotId: 'market-data-run', sourceStage: 'finalRecord', targetStage: 'executionOutput' },
          { sourceSlotId: 'portfolio-valuation-run', sourceStage: 'finalRecord', targetStage: 'executionOutput' },
        ], makePlannedInput('validationReport', 'batch-report', 'batch-passed', attemptId, [
          { sourceSlotId: 'batch-run', sourceStage: 'executionOutput', fieldPointer: '/result/outputDatasetDigest' },
          { sourceSlotId: 'identity-run', sourceStage: 'finalRecord', fieldPointer: '/iri' },
          { sourceSlotId: 'market-data-run', sourceStage: 'finalRecord', fieldPointer: '/iri' },
          { sourceSlotId: 'portfolio-valuation-run', sourceStage: 'finalRecord', fieldPointer: '/iri' },
        ])),
      ],
    },
    {
      slotId: 'batch-run', cardinality: 'required', alternatives: [
        altDescriptor('materializationBatchRun', 'slice-a-batch', attemptId, { kind: 'always' }, [
          { sourceSlotId: 'batch-report', sourceStage: 'finalRecord', targetStage: 'finalRecord' },
          { sourceSlotId: 'identity-run', sourceStage: 'finalRecord', targetStage: 'executionOutput' },
          { sourceSlotId: 'market-data-run', sourceStage: 'finalRecord', targetStage: 'executionOutput' },
          { sourceSlotId: 'portfolio-valuation-run', sourceStage: 'finalRecord', targetStage: 'executionOutput' },
        ], makePlannedInput('materializationBatchRun', 'batch-run', 'slice-a-batch', attemptId, [
          { sourceSlotId: 'batch-report', sourceStage: 'finalRecord', fieldPointer: '/iri' },
          { sourceSlotId: 'identity-run', sourceStage: 'finalRecord', fieldPointer: '/iri' },
          { sourceSlotId: 'market-data-run', sourceStage: 'finalRecord', fieldPointer: '/iri' },
          { sourceSlotId: 'portfolio-valuation-run', sourceStage: 'finalRecord', fieldPointer: '/iri' },
        ])),
      ],
    },
    {
      slotId: 'evidence-ledger', cardinality: 'required', alternatives: [],
    },
    {
      slotId: 'identity-report', cardinality: 'outcomeChoice', alternatives: [
        altDescriptor('failureReport', 'identity-failed', attemptId, { kind: 'outcomeEquals', parentOutcome: 'failed', parentSlotId: 'identity-run' }, [], makePlannedInput('failureReport', 'identity-report', 'identity-failed', attemptId, [{ sourceSlotId: 'identity-run', sourceStage: 'executionOutput', fieldPointer: '/result/outcome' }])),
        altDescriptor('validationReport', 'identity-passed', attemptId, { kind: 'outcomeEquals', parentOutcome: 'completed', parentSlotId: 'identity-run' }, [], makePlannedInput('validationReport', 'identity-report', 'identity-passed', attemptId, [{ sourceSlotId: 'identity-run', sourceStage: 'executionOutput', fieldPointer: '/result/outputGraphDigest' }])),
      ],
    },
    {
      slotId: 'identity-run', cardinality: 'required', alternatives: [
        altDescriptor('materializationRun', 'identity-run', attemptId, { kind: 'always' }, [
          { sourceSlotId: 'identity-report', sourceStage: 'finalRecord', targetStage: 'finalRecord' },
        ], makePlannedInput('materializationRun', 'identity-run', 'identity-run', attemptId, [{ sourceSlotId: 'identity-report', sourceStage: 'finalRecord', fieldPointer: '/iri' }])),
      ],
    },
    {
      slotId: 'market-data-report', cardinality: 'outcomeChoice', alternatives: [
        altDescriptor('failureReport', 'market-data-failed', attemptId, { kind: 'outcomeEquals', parentOutcome: 'failed', parentSlotId: 'market-data-run' }, [], makePlannedInput('failureReport', 'market-data-report', 'market-data-failed', attemptId, [{ sourceSlotId: 'market-data-run', sourceStage: 'executionOutput', fieldPointer: '/result/outcome' }])),
        altDescriptor('validationReport', 'market-data-passed', attemptId, { kind: 'outcomeEquals', parentOutcome: 'completed', parentSlotId: 'market-data-run' }, [], makePlannedInput('validationReport', 'market-data-report', 'market-data-passed', attemptId, [{ sourceSlotId: 'market-data-run', sourceStage: 'executionOutput', fieldPointer: '/result/outputGraphDigest' }])),
      ],
    },
    {
      slotId: 'market-data-run', cardinality: 'required', alternatives: [
        altDescriptor('materializationRun', 'market-data-run', attemptId, { kind: 'always' }, [
          { sourceSlotId: 'market-data-report', sourceStage: 'finalRecord', targetStage: 'finalRecord' },
        ], makePlannedInput('materializationRun', 'market-data-run', 'market-data-run', attemptId, [{ sourceSlotId: 'market-data-report', sourceStage: 'finalRecord', fieldPointer: '/iri' }])),
      ],
    },
    {
      slotId: 'portfolio-valuation-report', cardinality: 'outcomeChoice', alternatives: [
        altDescriptor('failureReport', 'portfolio-valuation-failed', attemptId, { kind: 'outcomeEquals', parentOutcome: 'failed', parentSlotId: 'portfolio-valuation-run' }, [], makePlannedInput('failureReport', 'portfolio-valuation-report', 'portfolio-valuation-failed', attemptId, [{ sourceSlotId: 'portfolio-valuation-run', sourceStage: 'executionOutput', fieldPointer: '/result/outcome' }])),
        altDescriptor('validationReport', 'portfolio-valuation-passed', attemptId, { kind: 'outcomeEquals', parentOutcome: 'completed', parentSlotId: 'portfolio-valuation-run' }, [], makePlannedInput('validationReport', 'portfolio-valuation-report', 'portfolio-valuation-passed', attemptId, [{ sourceSlotId: 'portfolio-valuation-run', sourceStage: 'executionOutput', fieldPointer: '/result/outputGraphDigest' }])),
      ],
    },
    {
      slotId: 'portfolio-valuation-run', cardinality: 'required', alternatives: [
        altDescriptor('materializationRun', 'portfolio-valuation-run', attemptId, { kind: 'always' }, [
          { sourceSlotId: 'portfolio-valuation-report', sourceStage: 'finalRecord', targetStage: 'finalRecord' },
        ], makePlannedInput('materializationRun', 'portfolio-valuation-run', 'portfolio-valuation-run', attemptId, [{ sourceSlotId: 'portfolio-valuation-report', sourceStage: 'finalRecord', fieldPointer: '/iri' }])),
      ],
    },
    {
      slotId: 'negative-report', cardinality: 'outcomeChoice', alternatives: [
        altDescriptor('failureReport', 'negative-failed', attemptId, { kind: 'outcomeEquals', parentOutcome: 'failed', parentSlotId: 'negative-run' }, [], makePlannedInput('failureReport', 'negative-report', 'negative-failed', attemptId, [{ sourceSlotId: 'negative-run', sourceStage: 'executionOutput', fieldPointer: '/result/errors' }])),
        altDescriptor('validationReport', 'negative-passed', attemptId, { kind: 'outcomeEquals', parentOutcome: 'completed', parentSlotId: 'negative-run' }, [], makePlannedInput('validationReport', 'negative-report', 'negative-passed', attemptId, [{ sourceSlotId: 'negative-run', sourceStage: 'executionOutput', fieldPointer: '/result/outputGraphDigest' }])),
      ],
    },
    {
      slotId: 'negative-run', cardinality: 'required', alternatives: [
        altDescriptor('materializationRun', 'negative-run', attemptId, { kind: 'always' }, [
          { sourceSlotId: 'negative-report', sourceStage: 'finalRecord', targetStage: 'finalRecord' },
        ], makePlannedInput('materializationRun', 'negative-run', 'negative-run', attemptId, [{ sourceSlotId: 'negative-report', sourceStage: 'finalRecord', fieldPointer: '/iri' }])),
      ],
    },
    {
      slotId: 'pit-report', cardinality: 'required', alternatives: [
        altDescriptor('validationReport', 'pit-passed', attemptId, { kind: 'always' }, [
          { sourceSlotId: 'batch-run', sourceStage: 'finalRecord', targetStage: 'executionOutput' },
          { sourceSlotId: 'pit-request', sourceStage: 'finalRecord', targetStage: 'executionOutput' },
        ], makePlannedInput('validationReport', 'pit-report', 'pit-passed', attemptId, [
          { sourceSlotId: 'batch-run', sourceStage: 'finalRecord', fieldPointer: '/result/outputDatasetDigest' },
          { sourceSlotId: 'pit-request', sourceStage: 'finalRecord', fieldPointer: '/iri' },
        ])),
      ],
    },
    {
      slotId: 'pit-request', cardinality: 'required', alternatives: [
        altDescriptor('pitRequest', 'slice-a-pit', attemptId, { kind: 'always' }, [
          { sourceSlotId: 'batch-run', sourceStage: 'finalRecord', targetStage: 'executionOutput' },
        ], makePlannedInput('pitRequest', 'pit-request', 'slice-a-pit', attemptId, [{ sourceSlotId: 'batch-run', sourceStage: 'finalRecord', fieldPointer: '/iri' }])),
      ],
    },
    {
      slotId: 'replay-report', cardinality: 'required', alternatives: [
        altDescriptor('replayReport', 'slice-a-replay', attemptId, { kind: 'always' }, [
          { sourceSlotId: 'batch-run', sourceStage: 'finalRecord', targetStage: 'executionOutput' },
          { sourceSlotId: 'pit-request', sourceStage: 'finalRecord', targetStage: 'executionOutput' },
        ], makePlannedInput('replayReport', 'replay-report', 'slice-a-replay', attemptId, [
          { sourceSlotId: 'batch-run', sourceStage: 'finalRecord', fieldPointer: '/result/outputDatasetDigest' },
          { sourceSlotId: 'pit-request', sourceStage: 'finalRecord', fieldPointer: '/materializationContext/targetDatasetDigest' },
        ])),
      ],
    },
  ];
  const nonLedgerAlternatives = slots.flatMap((slot) => (
    slot.slotId === 'evidence-ledger' ? [] : slot.alternatives.map((alternative) => ({
      slotId: slot.slotId,
      recordType: alternative.recordType,
      recordId: alternative.recordId,
      attemptId: alternative.attemptId,
    }))
  )).sort((left, right) => tupleCompare(
    [left.slotId, left.recordType, left.recordId, left.attemptId],
    [right.slotId, right.recordType, right.recordId, right.attemptId],
  ));
  const ledgerPlanned = {
    alternatives: nonLedgerAlternatives,
    recordType: 'evidenceLedger',
    schemaManifestBinding: {
      artifactDigest: schemaManifestDigest,
      artifactRef: schemaManifestRef,
    },
    schemaVersion: '1.0',
  };
  slots.find((slot) => slot.slotId === 'evidence-ledger').alternatives = [
    altDescriptor('evidenceLedger', 'slice-a-ledger', attemptId, { kind: 'always' }, nonLedgerAlternatives.map((entry) => ({
      sourceSlotId: entry.slotId,
      sourceStage: 'finalRecord',
      targetStage: 'finalRecord',
    })).filter((edge, index, all) => all.findIndex((candidate) => candidate.sourceSlotId === edge.sourceSlotId) === index), ledgerPlanned),
  ];
  return {
    controlRecordSchemaManifestDigest: schemaManifestDigest,
    controlRecordSchemaManifestRef: schemaManifestRef,
    schemaVersion: '1.0',
    slots: slots.sort((left, right) => utf8Compare(left.slotId, right.slotId)),
  };
}

function materializePlanFiles(planTemplate, resolver) {
  const plan = structuredClone(planTemplate);
  for (const slot of plan.slots) {
    for (const alternative of slot.alternatives) {
      const planned = alternative.planned;
      delete alternative.planned;
      const suffix = `${slot.slotId}--${alternative.recordType}--${alternative.recordId}.json`;
      const artifact = writeBuildJcs(resolver, `planned-inputs/${suffix}`, planned);
      alternative.plannedInputRef = artifact.ref;
      alternative.plannedInputDigest = plannedInputDigest(alternative.recordType, planned);
    }
  }
  return plan;
}

function makeRecordBase(alternative, build, iri) {
  return {
    iri,
    slotId: alternative.slotId,
    attemptId: alternative.attemptId,
    plannedInputDigest: alternative.plannedInputDigest,
    recordType: alternative.recordType,
    [RECORD_TYPE_ID_FIELD[alternative.recordType]]: alternative.recordId,
    schemaVersion: '1.0',
    build,
  };
}

function finalizeRecord(draft) {
  const record = { ...draft };
  record.resolvedInputDigest = resolvedInputDigest(record);
  return record;
}

function recordRef(slotId) {
  return pathRef('buildEvidence', `records/${slotId}.json`);
}

function makeSubjectInventory(gateId, subjectRef, subjectDigestValue, classifier, tool, resolver) {
  const subjectKey = { classifier, subjectDigest: subjectDigestValue, subjectRef };
  const inventory = {
    discoveryContractDigest: tool.discoveryContractDigest,
    discoveryContractRef: tool.discoveryContractRef,
    gateId,
    schemaVersion: '1.0',
    subjects: [{
      classifier,
      subjectDigest: subjectDigestValue,
      subjectId: taggedJcsDigest('axiolune-gate-subject-v1\0', subjectKey),
      subjectRef,
    }],
  };
  const artifact = writeBuildJcs(resolver, `gate-evidence/${gateId}-subject-inventory.json`, inventory);
  return {
    artifact,
    digest: taggedJcsDigest('axiolune-gate-subject-inventory-v1\0', inventory),
    inventory,
  };
}

function makeValidationReport(options) {
  const {
    alternative, build, iri, gateId, reportKind, subjectRef, subjectDigest: subjectDigestValue,
    classifier, inputs, evidenceRef, evidenceDigest, outputDigests, tool, resolver, extra = {},
  } = options;
  const inventory = makeSubjectInventory(
    gateId, subjectRef, subjectDigestValue, classifier, tool, resolver,
  );
  const check = {
    capabilityDigest: tool.capabilityDigest,
    capabilityId: tool.capabilityId,
    capabilityRef: tool.capabilityRef,
    checkId: 'execute',
    entrypointDigest: tool.entrypointDigest,
    entrypointRef: tool.entrypointRef,
    evidenceDigest,
    evidenceRef,
    inputDigests: [...new Set(inputs.map((entry) => entry.artifactDigest))].sort(utf8Compare),
    outputDigests: [...new Set(outputDigests)].sort(utf8Compare),
    status: 'passed',
    subjectDigest: subjectDigestValue,
    subjectId: inventory.inventory.subjects[0].subjectId,
    subjectRef,
    toolId: tool.toolId,
  };
  const draft = {
    ...makeRecordBase(alternative, build, iri),
    capabilityDigest: tool.capabilityDigest,
    capabilityId: tool.capabilityId,
    capabilityRef: tool.capabilityRef,
    criterionRefs: [CRITERION_5],
    counts: {
      discovered: 1, executed: 1, failed: 0, passed: 1,
      pending: 0, skipped: 0, warnings: 0,
    },
    discoveryContractDigest: tool.discoveryContractDigest,
    discoveryContractRef: tool.discoveryContractRef,
    entrypointDigest: tool.entrypointDigest,
    entrypointRef: tool.entrypointRef,
    gateId,
    inputs,
    kindEvidence: {
      artifactDigest: evidenceDigest,
      artifactRef: evidenceRef,
      schemaDigest: tool.evidenceSchemaDigest,
      schemaRef: tool.evidenceSchemaRef,
    },
    profileRef: PROFILE_REF,
    reportKind,
    result: { checks: [check], errors: [], outcome: 'passed', violations: [] },
    subjectInventoryDigest: inventory.digest,
    subjectInventoryRef: inventory.artifact.ref,
    subjectRef,
    toolId: tool.toolId,
    ...extra,
  };
  return finalizeRecord(draft);
}

function writeRecord(resolver, record) {
  const artifact = writeBuildBytes(resolver, `records/${record.slotId}.json`, canonicalRecordBytes(record));
  return { ...artifact, record };
}

function parseInput(input, resolver) {
  exactKeys(
    input,
    [
      'batchDefinitionRef', 'execution', 'fixtureId', 'futureSnapshotRef',
      'identityCompilationRef', 'identityManifestRef', 'mappings',
      'ontologyClosureRef', 'originalSnapshotRef', 'profileRef',
      'priorSupportChainRef', 'referenceClosureRef', 'schemaVersion', 'sourceSchemaRef',
      'supportEvidenceClosureRef',
    ],
    'controlChainInput',
    'S5_CHAIN_INPUT',
  );
  if (input.schemaVersion !== '1.0'
      || input.profileRef !== PROFILE_REF
      || input.fixtureId !== 'slice-a-s5-control-chain-v1') {
    fail('S5_CHAIN_INPUT', 'input schema/profile/fixture identity drift');
  }
  if (!Array.isArray(input.mappings)
      || input.mappings.length !== MATERIALIZATION_RUN_SPECS.length) {
    fail(
      'S5_CHAIN_INPUT',
      `exactly ${MATERIALIZATION_RUN_SPECS.length} atomic mapping plans are required`,
    );
  }
  const sourceSchemaArtifact = resolver.readJson(
    input.sourceSchemaRef,
    'sourceSchemaRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  const sourceSchema = sourceSchemaArtifact.value;
  validateSourceSchema(sourceSchema);
  const originalSnapshotArtifact = resolver.readJson(
    input.originalSnapshotRef,
    'originalSnapshotRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  const futureSnapshotArtifact = resolver.readJson(
    input.futureSnapshotRef,
    'futureSnapshotRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  validateSourceDataset(originalSnapshotArtifact.value, 'originalSnapshot');
  validateSourceDataset(futureSnapshotArtifact.value, 'futureSnapshot');
  if (originalSnapshotArtifact.value.dataset !== futureSnapshotArtifact.value.dataset
      || sourceSchema.dataset !== originalSnapshotArtifact.value.dataset) {
    fail('S5_CHAIN_SOURCE_DATA', 'source schema/snapshot dataset identities drift');
  }
  if (instantEpoch(futureSnapshotArtifact.value.snapshotTime, 'futureSnapshot.snapshotTime')
        <= instantEpoch(originalSnapshotArtifact.value.snapshotTime, 'originalSnapshot.snapshotTime')) {
    fail('S5_CHAIN_FUTURE_APPEND', 'future snapshotTime must be after the original snapshotTime');
  }
  const futureRowsByKey = new Map(
    futureSnapshotArtifact.value.rows.map((row) => [rowKey(row), row]),
  );
  if (originalSnapshotArtifact.value.rows.some(
    (row) => !futureRowsByKey.has(rowKey(row)),
  )) {
    fail('S5_CHAIN_FUTURE_APPEND', 'future snapshot must preserve every original row byte-semantically');
  }

  const ontologyClosureArtifact = resolver.readJson(
    input.ontologyClosureRef,
    'ontologyClosureRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  const ontology = validateActualOntologyClosure(
    ontologyClosureArtifact.value,
    resolver,
  );
  const referenceClosureArtifact = resolver.readJson(
    input.referenceClosureRef,
    'referenceClosureRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  const reference = validateSyntheticReferenceClosure(
    referenceClosureArtifact.value,
    resolver,
  );
  const supportEvidenceClosureArtifact = resolver.readJson(
    input.supportEvidenceClosureRef,
    'supportEvidenceClosureRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  const supportEvidence = validateSupportEvidenceClosure(
    supportEvidenceClosureArtifact.value,
    resolver,
  );
  validateSourceEvidenceBindings(
    originalSnapshotArtifact.value.rows,
    supportEvidence,
    'originalSnapshot',
  );
  validateSourceEvidenceBindings(
    futureSnapshotArtifact.value.rows,
    supportEvidence,
    'futureSnapshot',
  );

  const identityCompilationArtifact = resolver.readJson(
    input.identityCompilationRef,
    'identityCompilationRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  const identityManifestArtifact = resolver.readJson(
    input.identityManifestRef,
    'identityManifestRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  let identityCompilationResult;
  try {
    identityCompilationResult = compileIdentityContracts(identityCompilationArtifact.value);
  } catch (cause) {
    fail('S5_CHAIN_IDENTITY_CONTRACT', cause.message);
  }
  const manifestValidation = validateIdentityManifest(
    identityManifestArtifact.value,
    identityCompilationArtifact.value,
  );
  if (!manifestValidation.ok
      || canonicalJcs(identityManifestArtifact.value)
        !== canonicalJcs(identityCompilationResult.manifest)) {
    fail(
      'S5_CHAIN_IDENTITY_CONTRACT',
      manifestValidation.errors.map((entry) => `${entry.code}:${entry.path}`).join('; ')
        || 'identity manifest is not the exact compiler projection',
    );
  }
  const compiledMappings = new Map(
    identityCompilationArtifact.value.mappings.map((mapping) => [mapping.iri, mapping]),
  );
  const compiledContracts = new Map(
    identityCompilationArtifact.value.contracts.map((contract) => [contract.iri, contract]),
  );

  const mappingIds = [];
  const mappingData = input.mappings.map((descriptor, index) => {
    exactKeys(
      descriptor,
      [
        'mappingArtifacts', 'planArtifactRef', 'planRef', 'targetGraph',
      ],
      `controlChainInput.mappings[${index}]`,
      'S5_CHAIN_INPUT',
    );
    for (const field of ['planRef', 'targetGraph']) {
      absoluteIri(descriptor[field], `controlChainInput.mappings[${index}].${field}`);
    }
    if (!Array.isArray(descriptor.mappingArtifacts)
        || descriptor.mappingArtifacts.length === 0) {
      fail('S5_CHAIN_INPUT', `controlChainInput.mappings[${index}] has no mapping artifacts`);
    }
    sortedUniqueStrings(
      descriptor.mappingArtifacts.map((entry) => entry?.mappingRef),
      `controlChainInput.mappings[${index}].mappingRefs`,
    );
    const validatedMappings = descriptor.mappingArtifacts.map((mappingDescriptor, mappingIndex) => {
      exactKeys(
        mappingDescriptor,
        [
          'identityContractRef', 'mappingArtifactRef', 'mappingRef',
          'provenanceSourceField', 'transformationClosureRef',
        ],
        `controlChainInput.mappings[${index}].mappingArtifacts[${mappingIndex}]`,
        'S5_CHAIN_INPUT',
      );
      absoluteIri(mappingDescriptor.mappingRef, `mapping[${index}][${mappingIndex}].mappingRef`);
      if (typeof mappingDescriptor.provenanceSourceField !== 'string'
          || !sourceSchema.fields.some((field) => (
            field.name === mappingDescriptor.provenanceSourceField && field.required === true
          ))) {
        fail(
          'S5_CHAIN_INPUT',
          `mapping[${index}][${mappingIndex}].provenanceSourceField is not a required source field`,
        );
      }
      absoluteIri(mappingDescriptor.identityContractRef, `mapping[${index}][${mappingIndex}].identityContractRef`);
      const mappingArtifact = resolver.readJson(
        mappingDescriptor.mappingArtifactRef,
        `mapping[${index}][${mappingIndex}].mappingArtifactRef`,
        { allowedRoots: ['sourceTree'], exactJcs: true },
      );
      const compiledMapping = compiledMappings.get(mappingDescriptor.mappingRef);
      const contract = compiledContracts.get(mappingDescriptor.identityContractRef);
      if (!compiledMapping || !contract
          || canonicalJcs(compiledMapping) !== canonicalJcs(mappingArtifact.value)
          || compiledMapping.identity.contractRef !== contract.iri
          || compiledMapping.targetType !== contract.targetType) {
        fail('S5_CHAIN_IDENTITY_CONTRACT', `mapping[${index}][${mappingIndex}] differs from the compiled mapping/contract closure`);
      }
      const validated = validateMappingArtifact(
        mappingArtifact.value,
        mappingDescriptor,
        sourceSchema,
        resolver,
        `mapping[${index}][${mappingIndex}]`,
      );
      const targetModule = ontology.targetOwners.get(validated.mapping.targetType);
      if (!targetModule) {
        fail('S5_CHAIN_ONTOLOGY_CLOSURE', `mapping[${index}][${mappingIndex}] targetType is not an actual M2 target`);
      }
      mappingIds.push(mappingDescriptor.mappingRef);
      return { ...validated, contract, descriptor: mappingDescriptor, mappingArtifact, targetModule };
    });
    const targetModules = new Set(validatedMappings.map((entry) => entry.targetModule));
    if (targetModules.size !== 1) {
      fail('S5_CHAIN_PLAN_SOURCE', `materializationPlan[${index}] crosses target modules`);
    }
    const planArtifact = resolver.readJson(
      descriptor.planArtifactRef,
      `controlChainInput.mappings[${index}].planArtifactRef`,
      { allowedRoots: ['sourceTree'], exactJcs: true },
    );
    validateMaterializationPlan(
      planArtifact.value,
      descriptor,
      validatedMappings.map((entry) => entry.mapping),
      sourceSchema,
      `materializationPlan[${index}]`,
    );
    if (planArtifact.value.targetOntologyModule !== [...targetModules][0]) {
      fail('S5_CHAIN_ONTOLOGY_CLOSURE', `materializationPlan[${index}] targetModule drift`);
    }
    return {
      descriptor,
      mappings: validatedMappings,
      plan: planArtifact.value,
      planArtifact,
    };
  });
  if (new Set(mappingIds).size !== mappingIds.length) {
    fail('S5_CHAIN_INPUT', 'controlChainInput mappingRefs must be globally unique across ordered plans');
  }
  const declaredMappingIris = [...mappingIds].sort(utf8Compare);
  const compiledMappingIris = [...compiledMappings.keys()].sort(utf8Compare);
  const declaredTargetTypes = [...new Set(mappingData.flatMap((entry) => (
    entry.mappings.map((mapping) => mapping.mapping.targetType)
  )))].sort(utf8Compare);
  const compiledTargetTypes = [...identityCompilationArtifact.value.concreteTargetTypes]
    .sort(utf8Compare);
  const compiledContractTargetTypes = identityCompilationArtifact.value.contracts
    .map((contract) => contract.targetType)
    .sort(utf8Compare);
  if (canonicalJcs(declaredMappingIris) !== canonicalJcs(compiledMappingIris)
      || canonicalJcs(declaredTargetTypes) !== canonicalJcs(compiledTargetTypes)
      || canonicalJcs(compiledContractTargetTypes) !== canonicalJcs(compiledTargetTypes)) {
    fail(
      'S5_CHAIN_IDENTITY_CONTRACT',
      'identity compilation must equal the controlChainInput batch mapping and concrete-target closure exactly',
    );
  }

  const batchArtifact = resolver.readJson(
    input.batchDefinitionRef,
    'batchDefinitionRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  exactKeys(
    input.execution,
    [
      'asOfAvailable', 'asOfKnowledge', 'asOfValid', 'assertionTime',
      'referenceTime', 'targetDataset',
    ],
    'controlChainInput.execution',
    'S5_CHAIN_INPUT',
  );
  for (const field of ['asOfAvailable', 'asOfKnowledge', 'asOfValid', 'assertionTime', 'referenceTime']) {
    instantEpoch(input.execution[field], `execution.${field}`);
  }
  if (instantEpoch(input.execution.asOfKnowledge, 'execution.asOfKnowledge')
        > instantEpoch(input.execution.referenceTime, 'execution.referenceTime')
      || instantEpoch(input.execution.asOfAvailable, 'execution.asOfAvailable')
        > instantEpoch(input.execution.referenceTime, 'execution.referenceTime')) {
    fail('S5_CHAIN_FUTURE_PIVOT', 'PIT knowledge/availability pivot exceeds referenceTime');
  }
  absoluteIri(input.execution.targetDataset, 'execution.targetDataset');
  if (input.execution.targetDataset !== 'urn:axiolune:dataset:slice-a:control-chain:v1') {
    fail('S5_CHAIN_INPUT', 'targetDataset drifted from the executable materializer contract');
  }
  validateBatchDefinition(
    batchArtifact.value,
    mappingData,
    input.execution.targetDataset,
  );
  let priorSupport;
  try {
    priorSupport = validatePriorSupportChain(input.priorSupportChainRef, resolver, {
      assertionTime: input.execution.assertionTime,
      referenceTime: input.execution.referenceTime,
      sourceSchemaDigest: sourceSchemaArtifact.digest,
      sourceSchemaRef: input.sourceSchemaRef,
      sourceSnapshotDigest: originalSnapshotArtifact.digest,
      sourceSnapshotRef: input.originalSnapshotRef,
    });
  } catch (cause) {
    fail('S5_CHAIN_PRIOR_SUPPORT', cause.message);
  }
  const originalRows = selectHistoricalRows(originalSnapshotArtifact.value, input.execution);
  const futureRows = selectHistoricalRows(futureSnapshotArtifact.value, input.execution);
  if (canonicalJcs(originalRows) !== canonicalJcs(futureRows)
      || futureSnapshotArtifact.value.rows.length <= originalSnapshotArtifact.value.rows.length) {
    fail('S5_CHAIN_FUTURE_APPEND', 'future snapshot must append only PIT-ineligible rows');
  }
  return {
    batchArtifact,
    futureRows,
    futureSnapshotArtifact,
    identityCompilationArtifact,
    identityManifestArtifact,
    mappingData,
    ontology,
    ontologyClosureArtifact,
    originalRows,
    originalSnapshotArtifact,
    priorSupport,
    reference,
    referenceClosureArtifact,
    sourceSchema,
    sourceSchemaArtifact,
    supportEvidence,
    supportEvidenceClosureArtifact,
  };
}

function expectedControlChainInputBindings(inputRef, input, parsed) {
  return [
    binding('batchDefinition', input.batchDefinitionRef, parsed.batchArtifact.digest),
    binding('controlChainInput', inputRef, parsed.inputArtifactDigest),
    binding('futureSnapshot', input.futureSnapshotRef, parsed.futureSnapshotArtifact.digest),
    binding('identityCompilation', input.identityCompilationRef, parsed.identityCompilationArtifact.digest),
    binding('identityManifest', input.identityManifestRef, parsed.identityManifestArtifact.digest),
    binding('ontologyClosure', input.ontologyClosureRef, parsed.ontologyClosureArtifact.digest),
    binding('originalSnapshot', input.originalSnapshotRef, parsed.originalSnapshotArtifact.digest),
    binding('priorSupportChain', input.priorSupportChainRef, parsed.priorSupport.artifact.digest),
    binding(
      'priorSupportDataset',
      parsed.priorSupport.manifest.dataset.artifactRef,
      parsed.priorSupport.datasetArtifact.digest,
      'application/n-quads',
    ),
    binding(
      'priorSupportLedger',
      parsed.priorSupport.manifest.ledger.artifactRef,
      parsed.priorSupport.ledgerArtifact.digest,
    ),
    binding(
      'priorSupportBatch',
      parsed.priorSupport.manifest.batch.artifactRef,
      parsed.priorSupport.manifest.batch.artifactDigest,
    ),
    binding(
      'priorSupportBatchRun',
      parsed.priorSupport.manifest.batchRun.artifactRef,
      parsed.priorSupport.manifest.batchRun.artifactDigest,
    ),
    ...parsed.priorSupport.manifest.identityContracts.map((entry, index) => binding(
      `priorSupportIdentityContract${index}`,
      entry.artifactRef,
      entry.artifactDigest,
    )),
    ...parsed.priorSupport.manifest.mappings.map((entry, index) => binding(
      `priorSupportMapping${index}`,
      entry.artifactRef,
      entry.artifactDigest,
    )),
    ...parsed.priorSupport.manifest.plans.map((entry, index) => binding(
      `priorSupportPlan${index}`,
      entry.artifactRef,
      entry.artifactDigest,
    )),
    ...parsed.priorSupport.manifest.runs.map((entry, index) => binding(
      `priorSupportRun${index}`,
      entry.artifactRef,
      entry.artifactDigest,
    )),
    ...parsed.priorSupport.manifest.reports.map((entry, index) => binding(
      `priorSupportReport${index}`,
      entry.artifactRef,
      entry.artifactDigest,
    )),
    binding('referenceClosure', input.referenceClosureRef, parsed.referenceClosureArtifact.digest),
    binding('sourceSchema', input.sourceSchemaRef, parsed.sourceSchemaArtifact.digest),
    binding(
      'supportEvidenceClosure',
      input.supportEvidenceClosureRef,
      parsed.supportEvidenceClosureArtifact.digest,
    ),
    ...parsed.mappingData.flatMap((group, index) => [
      binding(`plan${index}`, group.descriptor.planArtifactRef, group.planArtifact.digest),
      ...group.mappings.flatMap((mapping, mappingIndex) => [
        binding(
          `mapping${index}.${mappingIndex}`,
          mapping.descriptor.mappingArtifactRef,
          mapping.mappingArtifact.digest,
        ),
        binding(
          `transformationClosure${index}.${mappingIndex}`,
          mapping.descriptor.transformationClosureRef,
          mapping.closureArtifact.digest,
        ),
      ]),
    ]),
  ].sort((left, right) => utf8Compare(left.name, right.name));
}

function createS5ControlRecordChain(inputRef, roots, options = {}) {
  if (!isPlainObject(options)) {
    fail('S5_CHAIN_SOURCE_SELECTOR', 'generation options must be a closed object');
  }
  const optionKeys = options.sourceTreeSelector === undefined
    ? []
    : ['sourceTreeSelector'];
  exactKeys(options, optionKeys, 'generation options', 'S5_CHAIN_SOURCE_SELECTOR');
  const resolver = createResolver(roots);
  ensureEmptyBuildRoot(resolver.roots.buildEvidence);
  const inputArtifact = resolver.readJson(
    inputRef,
    'inputRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  const input = inputArtifact.value;
  const parsed = parseInput(input, resolver);
  parsed.inputArtifactDigest = inputArtifact.digest;

  const schemaManifestRef = pathRef('sourceTree', PROFILE_MANIFEST_REL);
  const schemaManifestArtifact = resolver.readJson(schemaManifestRef, 'schemaManifest', {
    allowedRoots: ['sourceTree'], exactJcs: true,
  });
  validateSchemaManifest(schemaManifestArtifact.value, resolver);
  const schemaManifestDigest = taggedJcsDigest(
    'axiolune-control-record-schema-manifest-v1\0',
    schemaManifestArtifact.value,
  );

  const toolLockRef = pathRef('sourceTree', TOOL_LOCK_REL);
  const toolLockArtifact = resolver.readJson(toolLockRef, 'toolLock', {
    allowedRoots: ['sourceTree'], exactJcs: true,
  });
  const toolLockState = validateToolLock(toolLockArtifact.value, resolver);
  const toolLockDigest = taggedJcsDigest('axiolune-tool-lock-v1\0', toolLockArtifact.value);
  validateValuationExecutableEvidence(
    parsed.supportEvidence,
    input.sourceSchemaRef,
    parsed.sourceSchemaArtifact.digest,
    toolLockRef,
    toolLockArtifact,
    toolLockState,
  );

  const planTemplate = buildPlanTemplate(schemaManifestRef, schemaManifestDigest);
  const plan = materializePlanFiles(planTemplate, resolver);
  const planArtifact = writeBuildJcs(resolver, 'control-record-plan.json', plan);
  const planDigest = taggedJcsDigest('axiolune-control-record-plan-v1\0', plan);
  const planAlternatives = validatePlan(plan, resolver, schemaManifestDigest);

  const sourceValues = [
    inputRef,
    schemaManifestRef,
    toolLockRef,
    input,
    schemaManifestArtifact.value,
    toolLockArtifact.value,
    ...toolLockState.runtimeClosures.values(),
    parsed.sourceSchema,
    parsed.originalSnapshotArtifact.value,
    parsed.futureSnapshotArtifact.value,
    parsed.batchArtifact.value,
    parsed.identityCompilationArtifact.value,
    parsed.identityManifestArtifact.value,
    parsed.ontologyClosureArtifact.value,
    parsed.referenceClosureArtifact.value,
    parsed.reference.lock,
    parsed.reference.artifact.value,
    parsed.supportEvidence.closure,
    parsed.priorSupport.manifest,
    ...parsed.mappingData.flatMap((entry) => [
      entry.plan,
      ...entry.mappings.flatMap((mapping) => [mapping.mapping, mapping.closure]),
    ]),
  ];
  let sourceTreeSelectorArtifact = null;
  let sourceTree;
  if (options.sourceTreeSelector === undefined) {
    sourceTree = makeSourceTreeManifest(resolver, sourceValues);
  } else {
    validateGitSourceTreeSelector(options.sourceTreeSelector, resolver.roots.sourceTree);
    sourceTree = makeGitBoundSourceTreeManifest(resolver, options.sourceTreeSelector);
    assertSourceTreeInventory(sourceTree.manifest, sourceValues, 'gitCommit');
    sourceTreeSelectorArtifact = writeBuildJcs(
      resolver,
      'source-tree-selector.json',
      options.sourceTreeSelector,
    );
  }
  const sourceTreeManifestArtifact = writeBuildJcs(
    resolver,
    'source-tree-manifest.json',
    sourceTree.manifest,
  );

  const sourceInputs = expectedControlChainInputBindings(inputRef, input, parsed);

  const buildInputs = {
    controlRecordPlanDigest: planDigest,
    controlRecordPlanRef: planArtifact.ref,
    controlRecordSchemaManifestDigest: schemaManifestDigest,
    controlRecordSchemaManifestRef: schemaManifestRef,
    inputs: sourceInputs,
    profileRef: PROFILE_REF,
    referenceTime: input.execution.referenceTime,
    schemaVersion: '1.0',
    sourceTreeDigest: sourceTree.digest,
    sourceTreeManifestDigest: taggedJcsDigest(
      'axiolune-source-tree-manifest-v1\0', sourceTree.manifest,
    ),
    sourceTreeManifestRef: sourceTreeManifestArtifact.ref,
    toolLockDigest,
    toolLockRef,
  };
  if (sourceTreeSelectorArtifact !== null) {
    buildInputs.sourceTreeSelectorDigest = taggedJcsDigest(
      'axiolune-source-tree-selector-v1\0',
      options.sourceTreeSelector,
    );
    buildInputs.sourceTreeSelectorRef = sourceTreeSelectorArtifact.ref;
  }
  const buildInputsArtifact = writeBuildJcs(resolver, 'build-inputs.json', buildInputs);
  const buildInputsDigest = taggedJcsDigest('axiolune-build-inputs-v1\0', buildInputs);
  const buildId = artifactDigest(Buffer.concat([
    Buffer.from('axiolune-build-v1\0', 'utf8'),
    rawDigestBytes(sourceTree.digest, 'sourceTreeDigest'),
    rawDigestBytes(toolLockDigest, 'toolLockDigest'),
    rawDigestBytes(buildInputsDigest, 'buildInputsDigest'),
  ]));
  const build = {
    buildId,
    buildInputsDigest,
    buildInputsRef: buildInputsArtifact.ref,
    controlRecordPlanDigest: planDigest,
    controlRecordPlanRef: planArtifact.ref,
    controlRecordSchemaManifestDigest: schemaManifestDigest,
    controlRecordSchemaManifestRef: schemaManifestRef,
    sourceTreeDigest: sourceTree.digest,
    toolLockDigest,
    toolLockRef,
  };

  const outcomes = new Map([
    ['batch-run', 'completed'],
    ['identity-run', 'completed'],
    ['market-data-run', 'completed'],
    ['portfolio-valuation-run', 'completed'],
    ['negative-run', 'failed'],
  ]);
  const active = activeAlternatives(planAlternatives, outcomes);
  validateStageDag(active);
  const iriBySlot = new Map();
  for (const [slotId, alternative] of active.entries()) {
    iriBySlot.set(slotId, controlRecordIri(
      buildId, slotId, alternative.recordType, alternative.recordId,
      alternative.attemptId, alternative.plannedInputDigest,
    ));
  }

  const originalMaterialized = materializeCanonicalHistoricalDataset(
    parsed.originalRows,
    iriBySlot.get('identity-run'),
    iriBySlot.get('market-data-run'),
    iriBySlot.get('portfolio-valuation-run'),
    iriBySlot.get('batch-run'),
    { valuationPolicyArtifacts: parsed.supportEvidence.valuationPolicyArtifacts },
  );
  const replayMaterialized = materializeCanonicalHistoricalDataset(
    parsed.originalRows,
    iriBySlot.get('identity-run'),
    iriBySlot.get('market-data-run'),
    iriBySlot.get('portfolio-valuation-run'),
    iriBySlot.get('batch-run'),
    {
      reverse: true,
      valuationPolicyArtifacts: parsed.supportEvidence.valuationPolicyArtifacts,
    },
  );
  const futureMaterialized = materializeCanonicalHistoricalDataset(
    parsed.futureRows,
    iriBySlot.get('identity-run'),
    iriBySlot.get('market-data-run'),
    iriBySlot.get('portfolio-valuation-run'),
    iriBySlot.get('batch-run'),
    {
      reverse: true,
      valuationPolicyArtifacts: parsed.supportEvidence.valuationPolicyArtifacts,
    },
  );
  const originalDatasetArtifact = writeBuildBytes(
    resolver, 'rdf/dataset-original.nq', Buffer.from(originalMaterialized.nquads, 'utf8'),
  );
  const replayDatasetArtifact = writeBuildBytes(
    resolver, 'rdf/dataset-replay.nq', Buffer.from(replayMaterialized.nquads, 'utf8'),
  );
  const futureDatasetArtifact = writeBuildBytes(
    resolver, 'rdf/dataset-future-append-challenge.nq', Buffer.from(futureMaterialized.nquads, 'utf8'),
  );
  const priorSupportInputArtifact = writeBuildBytes(
    resolver,
    'rdf/prior-support-input.nq',
    parsed.priorSupport.datasetArtifact.bytes,
  );
  if (priorSupportInputArtifact.digest !== parsed.priorSupport.datasetArtifact.digest) {
    fail('S5_CHAIN_PRIOR_SUPPORT', 'build copy of prior support bytes changed');
  }
  const originalDatasetDigest = computeDatasetDigest(
    originalMaterialized.nquads, originalMaterialized.graphIris,
  );
  const replayDatasetDigest = computeDatasetDigest(
    replayMaterialized.nquads, replayMaterialized.graphIris,
  );
  const futureDatasetDigest = computeDatasetDigest(
    futureMaterialized.nquads, futureMaterialized.graphIris,
  );
  if (originalDatasetArtifact.digest === replayDatasetArtifact.digest
      || originalDatasetDigest.digest !== replayDatasetDigest.digest
      || originalDatasetDigest.canonicalNQuads !== replayDatasetDigest.canonicalNQuads
      || originalDatasetDigest.digest !== futureDatasetDigest.digest
      || originalDatasetDigest.canonicalNQuads !== futureDatasetDigest.canonicalNQuads) {
    fail('S5_CHAIN_REPLAY_MISMATCH', 'RDFC replay/future-append challenge changed the historical dataset');
  }

  const memberGraph = new Map();
  for (const graphIri of originalMaterialized.memberGraphIris) {
    const original = computeNamedGraphDigest(originalMaterialized.nquads, graphIri);
    const replay = computeNamedGraphDigest(replayMaterialized.nquads, graphIri);
    const future = computeNamedGraphDigest(futureMaterialized.nquads, graphIri);
    if (original.digest !== replay.digest || original.digest !== future.digest) {
      fail('S5_CHAIN_REPLAY_MISMATCH', `${graphIri} changed under replay/future append`);
    }
    memberGraph.set(graphIri, original);
  }
  const memberGraphArtifacts = new Map();
  for (const spec of MATERIALIZATION_RUN_SPECS) {
    const graph = memberGraph.get(spec.graphIri);
    if (!graph || typeof graph.canonicalNQuads !== 'string'
        || graph.canonicalNQuads.length === 0) {
      fail(
        'S5_CHAIN_GRAPH_DIGEST',
        `${spec.graphIri} has no canonical single-graph producer output`,
      );
    }
    const artifact = writeBuildBytes(
      resolver,
      `rdf/graph-${spec.slug}.nq`,
      Buffer.from(graph.canonicalNQuads, 'utf8'),
    );
    const stored = computeNamedGraphDigest(graph.canonicalNQuads, spec.graphIri);
    if (stored.digest !== graph.digest
        || stored.canonicalNQuads !== graph.canonicalNQuads) {
      fail(
        'S5_CHAIN_GRAPH_DIGEST',
        `${spec.graphIri} canonical single-graph artifact changed during storage`,
      );
    }
    memberGraphArtifacts.set(spec.graphIri, artifact);
  }

  const schemaDigest = parsed.sourceSchemaArtifact.digest;
  const inputDatasets = [
    {
      artifactDigest: parsed.originalSnapshotArtifact.digest,
      dataset: parsed.originalSnapshotArtifact.value.dataset,
      schemaDigest,
      snapshotRef: input.originalSnapshotRef,
      snapshotTime: parsed.originalSnapshotArtifact.value.snapshotTime,
    },
    {
      artifactDigest: parsed.priorSupport.datasetArtifact.digest,
      dataset: parsed.priorSupport.manifest.dataset.datasetRef,
      schemaDigest: parsed.priorSupport.batchArtifact.digest,
      snapshotRef: parsed.priorSupport.manifest.dataset.artifactRef,
      snapshotTime: parsed.priorSupport.manifest.dataset.snapshotTime,
    },
  ].sort((left, right) => utf8Compare(left.dataset, right.dataset));
  const snapshotRoot = sourceSnapshotRootDigest(inputDatasets);
  const schemaRoot = sourceSchemaClosureDigest(inputDatasets);
  validateMappingToolBindings(
    parsed.mappingData,
    toolLockState,
    input.sourceSchemaRef,
    parsed.sourceSchemaArtifact.digest,
  );
  const mappingSources = parsed.mappingData.map((mapping) => {
    return {
      plan: mapping.plan,
      planRef: mapping.plan.iri,
      targetGraph: mapping.descriptor.targetGraph,
      closureRows: mapping.mappings.map((entry) => ({
        mappingRef: entry.mapping.iri,
        mappingSourceDigest: taggedJcsDigest(
          'axiolune-semantic-mapping-v1\0',
          entry.mapping,
        ),
        transformationClosureRef: entry.descriptor.transformationClosureRef,
        transformationClosureDigest: taggedJcsDigest(
          'axiolune-transformation-closure-v1\0',
          entry.closure,
        ),
      })).sort((left, right) => utf8Compare(left.mappingRef, right.mappingRef)),
    };
  });
  const mappingRoot = mappingClosureDigest(mappingSources.flatMap((entry) => entry.closureRows));
  const batchDefinition = parsed.batchArtifact.value;
  const batchSourceDigest = taggedJcsDigest('axiolune-materialization-batch-v1\0', batchDefinition);
  const ontologyClosure = parsed.ontologyClosureArtifact.value;
  const referenceClosure = parsed.referenceClosureArtifact.value;
  const ontologyClosureDigest = taggedJcsDigest('axiolune-ontology-closure-v1\0', ontologyClosure);
  const referenceLockDigest = taggedJcsDigest('axiolune-reference-closure-v1\0', referenceClosure);
  const tool = reportToolBinding(toolLockArtifact.value);
  const executorDigest = tool.capabilityDigest;
  const compilerDigest = tool.capabilityDigest;
  const validatorDigest = tool.entrypointDigest;

  const recordArtifacts = new Map();
  const sourceInputBindings = sourceInputs.filter((entry) => (
    ['controlChainInput', 'originalSnapshot', 'sourceSchema'].includes(entry.name)
    || entry.name.startsWith('priorSupport')
  ));

  const shaclByGraph = new Map(MATERIALIZATION_RUN_SPECS.map((spec) => [
    spec.graphIri,
    runMaterializedCurrentDomainShacl(
      resolver,
      parsed.ontology,
      spec.moduleIri,
      originalMaterialized,
      parsed.priorSupport.nquads,
      spec.graphIri,
      spec.validationModuleIris,
    ),
  ]));
  const allowedGeneratingContextIris = [
    iriBySlot.get('identity-run'),
    iriBySlot.get('market-data-run'),
    iriBySlot.get('portfolio-valuation-run'),
    ...parsed.priorSupport.allowedRunIris,
  ].sort(utf8Compare);
  const customByGraph = new Map(MATERIALIZATION_RUN_SPECS.map((spec) => [
    spec.graphIri,
    runMaterializedApplicableCustom(
      resolver,
      parsed.ontology,
      originalMaterialized,
      parsed.priorSupport.nquads,
      parsed.supportEvidence,
      spec.graphIri,
      input.execution,
      allowedGeneratingContextIris,
    ),
  ]));
  const validationByGraph = new Map();
  for (const spec of MATERIALIZATION_RUN_SPECS) {
    const shacl = shaclByGraph.get(spec.graphIri);
    const custom = customByGraph.get(spec.graphIri);
    shacl.artifact = writeBuildJcs(
      resolver,
      `gate-evidence/current-domain-shacl-${spec.slug}.json`,
      shacl.evidence,
    );
    custom.artifact = writeBuildJcs(
      resolver,
      `gate-evidence/applicable-custom-${spec.slug}.json`,
      custom.evidence,
    );
    const combinedEvidence = {
      artifactKind: 's5MaterializedSHACLAndApplicableCustomEvidence',
      checks: [
        { artifactDigest: custom.artifact.digest, artifactRef: custom.artifact.ref, kind: 'applicableCustom' },
        { artifactDigest: shacl.artifact.digest, artifactRef: shacl.artifact.ref, kind: 'currentDomainSHACL' },
      ],
      outcome: 'passed',
      schemaVersion: '1.0',
      supportDatasetDigest: parsed.priorSupport.datasetArtifact.digest,
      targetGraphIri: spec.graphIri,
    };
    validationByGraph.set(spec.graphIri, {
      artifact: writeBuildJcs(
        resolver,
        `gate-evidence/materialized-validation-${spec.slug}.json`,
        combinedEvidence,
      ),
      evidence: combinedEvidence,
    });
  }

  for (const spec of MATERIALIZATION_RUN_SPECS) {
    const {
      gateId, graphIri, mappingIndex, reportSlot, slotId,
    } = spec;
    const reportAlt = active.get(reportSlot);
    const graphDigest = memberGraph.get(graphIri).digest;
    const graphArtifact = memberGraphArtifacts.get(graphIri);
    const validationEvidence = validationByGraph.get(graphIri).artifact;
    const report = makeValidationReport({
      alternative: reportAlt,
      build,
      iri: iriBySlot.get(reportSlot),
      gateId,
      reportKind: 'mapping',
      subjectRef: graphArtifact.ref,
      subjectDigest: graphDigest,
      classifier: 'namedGraph',
      inputs: sourceInputBindings,
      evidenceRef: validationEvidence.ref,
      evidenceDigest: validationEvidence.digest,
      outputDigests: [graphDigest],
      tool,
      resolver,
    });
    const reportArtifact = writeRecord(resolver, report);
    recordArtifacts.set(reportSlot, reportArtifact);
    const mapping = mappingSources[mappingIndex];
    const run = finalizeRecord({
      ...makeRecordBase(active.get(slotId), build, iriBySlot.get(slotId)),
      assertionTime: input.execution.assertionTime,
      compilerDigest,
      executorDigest,
      inputDatasets,
      mappingClosure: mapping.closureRows,
      mappingClosureDigest: mappingClosureDigest(mapping.closureRows),
      ontologyClosureDigest,
      ontologyClosureRef: input.ontologyClosureRef,
      outputRdfCanonicalization: 'RDFC-1.0',
      planRef: mapping.planRef,
      planSourceDigest: taggedJcsDigest(
        'axiolune-materialization-plan-v1\0',
        mapping.plan,
      ),
      referenceLockDigest,
      referenceLockRef: input.referenceClosureRef,
      referenceTime: input.execution.referenceTime,
      result: {
        outcome: 'completed',
        outputFactVersionCount: countFactVersionsInGraph(
          originalMaterialized.nquads,
          graphIri,
          iriBySlot.get(slotId),
        ),
        outputGraph: graphIri,
        outputGraphDigest: graphDigest,
        validationReportDigest: reportArtifact.digest,
        validationReportRef: report.iri,
      },
      sourceSchemaClosureDigest: schemaRoot,
      sourceSnapshotRootDigest: snapshotRoot,
      validatorDigest,
    });
    const runArtifact = writeRecord(resolver, run);
    recordArtifacts.set(slotId, runArtifact);
  }

  const negativeErrors = [{
    code: 'FUTURE_KNOWLEDGE_REJECTED',
    message: 'The negative probe deliberately binds a knowledge pivot after referenceTime.',
    sourcePath: input.futureSnapshotRef.path,
    stage: 'pitValidation',
  }];
  const negativeReportAlt = active.get('negative-report');
  const negativeReport = finalizeRecord({
    ...makeRecordBase(negativeReportAlt, build, iriBySlot.get('negative-report')),
    errors: negativeErrors,
    failureStage: 'pitValidation',
    inputs: [sourceInputs.find((entry) => entry.name === 'futureSnapshot')],
    subjectRef: input.futureSnapshotRef,
  });
  const negativeReportArtifact = writeRecord(resolver, negativeReport);
  recordArtifacts.set('negative-report', negativeReportArtifact);
  const negativeMapping = mappingSources[1];
  const negativeRun = finalizeRecord({
    ...makeRecordBase(active.get('negative-run'), build, iriBySlot.get('negative-run')),
    assertionTime: input.execution.assertionTime,
    compilerDigest,
    executorDigest,
    inputDatasets,
    mappingClosure: negativeMapping.closureRows,
    mappingClosureDigest: mappingClosureDigest(negativeMapping.closureRows),
    ontologyClosureDigest,
    ontologyClosureRef: input.ontologyClosureRef,
    outputRdfCanonicalization: 'RDFC-1.0',
    planRef: 'urn:axiolune:materialization-plan:negative-probe:v1',
    planSourceDigest: taggedJcsDigest('axiolune-materialization-plan-v1\0', {
      iri: 'urn:axiolune:materialization-plan:negative-probe:v1',
      negativeProbe: 'futureKnowledge',
    }),
    referenceLockDigest,
    referenceLockRef: input.referenceClosureRef,
    referenceTime: input.execution.referenceTime,
    result: {
      errors: negativeErrors,
      failureReportDigest: negativeReportArtifact.digest,
      failureReportRef: negativeReport.iri,
      failureStage: 'pitValidation',
      outcome: 'failed',
    },
    sourceSchemaClosureDigest: schemaRoot,
    sourceSnapshotRootDigest: snapshotRoot,
    validatorDigest,
  });
  recordArtifacts.set('negative-run', writeRecord(resolver, negativeRun));

  const batchReportAlt = active.get('batch-report');
  const batchReport = makeValidationReport({
    alternative: batchReportAlt,
    build,
    iri: iriBySlot.get('batch-report'),
    gateId: 'batch-execution',
    reportKind: 'batch',
    subjectRef: originalDatasetArtifact.ref,
    subjectDigest: originalDatasetDigest.digest,
    classifier: 'batchDataset',
    inputs: sourceInputBindings,
    evidenceRef: originalDatasetArtifact.ref,
    evidenceDigest: originalDatasetArtifact.digest,
    outputDigests: [originalDatasetDigest.digest],
    tool,
    resolver,
  });
  const batchReportArtifact = writeRecord(resolver, batchReport);
  recordArtifacts.set('batch-report', batchReportArtifact);
  const batchMembers = mappingSources.map((mapping) => {
    const spec = MATERIALIZATION_RUN_SPECS.find(
      (candidate) => candidate.graphIri === mapping.targetGraph,
    );
    if (!spec) fail('S5_CHAIN_BATCH_SOURCE', `no run specification for ${mapping.targetGraph}`);
    const runArtifact = recordArtifacts.get(spec.slotId);
    return {
      outputGraph: runArtifact.record.result.outputGraph,
      outputGraphDigest: runArtifact.record.result.outputGraphDigest,
      planRef: runArtifact.record.planRef,
      runRecordDigest: runArtifact.digest,
      runRef: runArtifact.record.iri,
    };
  }).sort((left, right) => utf8Compare(left.planRef, right.planRef));
  const batch = finalizeRecord({
    ...makeRecordBase(active.get('batch-run'), build, iriBySlot.get('batch-run')),
    assertionTime: input.execution.assertionTime,
    batchRef: batchDefinition.iri,
    batchSourceDigest,
    compilerDigest,
    executorDigest,
    ontologyClosureDigest,
    ontologyClosureRef: input.ontologyClosureRef,
    outputRdfCanonicalization: 'RDFC-1.0',
    referenceLockDigest,
    referenceLockRef: input.referenceClosureRef,
    referenceTime: input.execution.referenceTime,
    result: {
      members: batchMembers,
      outcome: 'completed',
      outputDatasetDigest: originalDatasetDigest.digest,
      validationReportDigest: batchReportArtifact.digest,
      validationReportRef: batchReport.iri,
    },
    sourceSnapshotRootDigest: snapshotRoot,
    targetDataset: originalMaterialized.targetDataset,
    validatorDigest,
  });
  const batchArtifact = writeRecord(resolver, batch);
  recordArtifacts.set('batch-run', batchArtifact);

  const pit = finalizeRecord({
    ...makeRecordBase(active.get('pit-request'), build, iriBySlot.get('pit-request')),
    asOfAvailable: input.execution.asOfAvailable,
    asOfKnowledge: input.execution.asOfKnowledge,
    asOfValid: input.execution.asOfValid,
    materializationContext: {
      contextKind: 'materializationBatchRun',
      recordDigest: batchArtifact.digest,
      recordRef: batch.iri,
      targetDataset: batch.targetDataset,
      targetDatasetDigest: batch.result.outputDatasetDigest,
    },
    targetRdfCanonicalization: 'RDFC-1.0',
    validatorDigest,
    validatorRef: tool.entrypointRef,
  });
  const pitArtifact = writeRecord(resolver, pit);
  recordArtifacts.set('pit-request', pitArtifact);

  const pitSelection = evaluatePitSelection(originalMaterialized.nquads, {
    asOfAvailable: pit.asOfAvailable,
    asOfKnowledge: pit.asOfKnowledge,
    asOfValid: pit.asOfValid,
  });
  const pitEvidenceValue = {
    asOfAvailable: pit.asOfAvailable,
    asOfKnowledge: pit.asOfKnowledge,
    asOfValid: pit.asOfValid,
    contextRecordDigest: batchArtifact.digest,
    outcome: 'passed',
    recomputedTargetDigest: originalDatasetDigest.digest,
    requestRecordDigest: pitArtifact.digest,
    schemaVersion: '1.0',
    ...pitSelection,
  };
  const pitEvidence = writeBuildJcs(resolver, 'gate-evidence/pit-execution.json', pitEvidenceValue);
  const pitReport = makeValidationReport({
    alternative: active.get('pit-report'),
    build,
    iri: iriBySlot.get('pit-report'),
    gateId: 'pit-execution',
    reportKind: 'pit',
    subjectRef: pitArtifact.ref,
    subjectDigest: pitArtifact.digest,
    classifier: 'pitRequest',
    inputs: sourceInputBindings,
    evidenceRef: pitEvidence.ref,
    evidenceDigest: pitEvidence.digest,
    outputDigests: [originalDatasetDigest.digest, pitArtifact.digest],
    tool,
    resolver,
    extra: {
      asOfAvailable: pit.asOfAvailable,
      asOfKnowledge: pit.asOfKnowledge,
      asOfValid: pit.asOfValid,
      contextRecordDigest: batchArtifact.digest,
      contextRef: batch.iri,
      recomputedTargetDigest: originalDatasetDigest.digest,
      requestRecordDigest: pitArtifact.digest,
      requestRef: pit.iri,
      ...pitSelection,
    },
  });
  recordArtifacts.set('pit-report', writeRecord(resolver, pitReport));

  const selectionOriginal = historicalSelectionDigest(parsed.originalRows);
  const selectionFuture = historicalSelectionDigest(parsed.futureRows);
  const replay = finalizeRecord({
    ...makeRecordBase(active.get('replay-report'), build, iriBySlot.get('replay-report')),
    originalContextRecordDigest: batchArtifact.digest,
    originalContextRef: batch.iri,
    originalTargetDigest: originalDatasetDigest.digest,
    originalTargetRef: originalDatasetArtifact.ref,
    replayMappingClosureDigest: mappingRoot,
    replayOntologyClosureDigest: ontologyClosureDigest,
    replayReferenceLockDigest: referenceLockDigest,
    replaySourceSnapshotRootDigest: snapshotRoot,
    replayToolLockDigest: toolLockDigest,
    result: {
      comparisons: [
        {
          artifactRef: replayDatasetArtifact.ref,
          equal: originalDatasetDigest.digest === replayDatasetDigest.digest,
          name: 'batchDataset',
          originalDigest: originalDatasetDigest.digest,
          replayDigest: replayDatasetDigest.digest,
        },
        {
          artifactRef: futureDatasetArtifact.ref,
          equal: originalDatasetDigest.digest === futureDatasetDigest.digest,
          name: 'futureAppendHistoricalDataset',
          originalDigest: originalDatasetDigest.digest,
          replayDigest: futureDatasetDigest.digest,
        },
        {
          artifactRef: futureDatasetArtifact.ref,
          equal: selectionOriginal === selectionFuture,
          name: 'futureAppendHistoricalSelection',
          originalDigest: selectionOriginal,
          replayDigest: selectionFuture,
        },
        ...MATERIALIZATION_RUN_SPECS.map((spec) => {
          const originalDigest = memberGraph.get(spec.graphIri).digest;
          const replayDigest = computeNamedGraphDigest(
            replayMaterialized.nquads,
            spec.graphIri,
          ).digest;
          return {
            artifactRef: replayDatasetArtifact.ref,
            equal: originalDigest === replayDigest,
            name: spec.replayName,
            originalDigest,
            replayDigest,
          };
        }),
      ].sort((left, right) => utf8Compare(left.name, right.name)),
      errors: [],
      outcome: 'identical',
    },
  });
  recordArtifacts.set('replay-report', writeRecord(resolver, replay));

  const activeWithoutLedger = [...active.entries()]
    .filter(([slotId]) => slotId !== 'evidence-ledger')
    .sort(([left], [right]) => utf8Compare(left, right));
  const slotSelections = activeWithoutLedger.map(([slotId, alternative]) => ({
    attemptId: alternative.attemptId,
    recordId: alternative.recordId,
    recordIri: recordArtifacts.get(slotId).record.iri,
    recordType: alternative.recordType,
    slotId,
  }));
  const entries = activeWithoutLedger.map(([slotId, alternative]) => {
    const artifact = recordArtifacts.get(slotId);
    return {
      byteLength: artifact.byteLength,
      canonicalization: 'RFC8785-JCS',
      mediaType: 'application/json',
      recordDigest: artifact.digest,
      recordIri: artifact.record.iri,
      recordType: alternative.recordType,
      slotId,
    };
  });
  const ledger = finalizeRecord({
    ...makeRecordBase(active.get('evidence-ledger'), build, iriBySlot.get('evidence-ledger')),
    entries,
    slotSelections,
  });
  const ledgerArtifact = writeRecord(resolver, ledger);
  recordArtifacts.set('evidence-ledger', ledgerArtifact);

  const summary = verifyS5ControlRecordChain(roots);
  const expectedLedgerDigest = taggedJcsDigest('axiolune-evidence-ledger-v1\0', ledger);
  if (summary.evidenceLedgerDigest !== expectedLedgerDigest) {
    fail(
      'S5_CHAIN_LEDGER',
      'created evidence ledger digest differs from the independently verified chain summary',
    );
  }
  return summary;
}

function assertStoredProducerReplay(options) {
  if (!isPlainObject(options)) {
    fail('S5_CHAIN_PRODUCER_REPLAY', 'producer replay request must be a closed object');
  }
  exactKeys(options, [
    'batchRunIri', 'futureBytes', 'futureRows', 'identityRunIri', 'marketRunIri',
    'originalBytes', 'originalRows', 'portfolioRunIri', 'replayBytes',
    'valuationPolicyArtifacts',
  ], 'producer replay request', 'S5_CHAIN_PRODUCER_REPLAY');
  for (const [name, bytes] of [
    ['originalBytes', options.originalBytes],
    ['replayBytes', options.replayBytes],
    ['futureBytes', options.futureBytes],
  ]) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      fail('S5_CHAIN_PRODUCER_REPLAY', `${name} must contain stored N-Quads bytes`);
    }
  }
  const producerArgs = [
    options.identityRunIri,
    options.marketRunIri,
    options.portfolioRunIri,
    options.batchRunIri,
  ];
  const replayOptions = {
    valuationPolicyArtifacts: options.valuationPolicyArtifacts,
  };
  const independentlyProducedOriginal = materializeCanonicalHistoricalDataset(
    options.originalRows,
    ...producerArgs,
    replayOptions,
  );
  const independentlyProducedReplay = materializeCanonicalHistoricalDataset(
    options.originalRows,
    ...producerArgs,
    { ...replayOptions, reverse: true },
  );
  const independentlyProducedFuture = materializeCanonicalHistoricalDataset(
    options.futureRows,
    ...producerArgs,
    { ...replayOptions, reverse: true },
  );
  if (!options.originalBytes.equals(Buffer.from(independentlyProducedOriginal.nquads, 'utf8'))
      || !options.replayBytes.equals(Buffer.from(independentlyProducedReplay.nquads, 'utf8'))
      || !options.futureBytes.equals(Buffer.from(independentlyProducedFuture.nquads, 'utf8'))) {
    fail(
      'S5_CHAIN_PRODUCER_REPLAY',
      'stored original/replay/future RDF is not the exact output of locked input bytes and producer',
    );
  }
  return true;
}

function verifyBuildInputs(value, resolver, planDigest, schemaManifestDigest, toolLockDigest) {
  const hasSelectorRef = Object.prototype.hasOwnProperty.call(value, 'sourceTreeSelectorRef');
  const hasSelectorDigest = Object.prototype.hasOwnProperty.call(value, 'sourceTreeSelectorDigest');
  if (hasSelectorRef !== hasSelectorDigest) {
    fail(
      'S5_CHAIN_SOURCE_SELECTOR',
      'sourceTreeSelectorRef and sourceTreeSelectorDigest must be present together',
    );
  }
  exactKeys(
    value,
    [
      'controlRecordPlanDigest', 'controlRecordPlanRef',
      'controlRecordSchemaManifestDigest', 'controlRecordSchemaManifestRef',
      'inputs', 'profileRef', 'referenceTime', 'schemaVersion', 'sourceTreeDigest',
      'sourceTreeManifestDigest', 'sourceTreeManifestRef', 'toolLockDigest', 'toolLockRef',
      ...(hasSelectorRef ? ['sourceTreeSelectorDigest', 'sourceTreeSelectorRef'] : []),
    ],
    'buildInputs',
    'S5_CHAIN_BUILD_INPUTS',
  );
  if (value.schemaVersion !== '1.0' || value.profileRef !== PROFILE_REF) {
    fail('S5_CHAIN_BUILD_INPUTS', 'build-input profile/version drift');
  }
  instantEpoch(value.referenceTime, 'buildInputs.referenceTime');
  if (value.controlRecordPlanDigest !== planDigest
      || value.controlRecordSchemaManifestDigest !== schemaManifestDigest
      || value.toolLockDigest !== toolLockDigest) {
    fail('S5_CHAIN_BUILD_INPUTS', 'build-input plan/schema/tool binding drift');
  }
  validateArtifactBindings(value.inputs, 'buildInputs.inputs', resolver, { allowedRoots: ['sourceTree'] });
  const sourceManifestArtifact = resolver.readJson(value.sourceTreeManifestRef, 'buildInputs.sourceTreeManifestRef', {
    allowedRoots: ['buildEvidence'], exactJcs: true,
  });
  if (taggedJcsDigest('axiolune-source-tree-manifest-v1\0', sourceManifestArtifact.value)
      !== value.sourceTreeManifestDigest
      || sourceManifestArtifact.value.sourceTreeDigest !== value.sourceTreeDigest) {
    fail('S5_CHAIN_SOURCE_TREE', 'source-tree manifest binding drift');
  }
  const hasGitObjectFormat = Object.prototype.hasOwnProperty.call(
    sourceManifestArtifact.value,
    'gitObjectFormat',
  );
  if (hasSelectorRef !== hasGitObjectFormat) {
    fail(
      'S5_CHAIN_SOURCE_SELECTOR',
      'Git source-tree manifest and selector binding must be present together',
    );
  }
  exactKeys(
    sourceManifestArtifact.value,
    [
      'files',
      ...(hasGitObjectFormat ? ['gitObjectFormat'] : []),
      'schemaVersion',
      'sourceTreeDigest',
    ],
    'sourceTreeManifest',
    'S5_CHAIN_SOURCE_TREE',
  );
  if (sourceManifestArtifact.value.schemaVersion !== '1.0'
      || !Array.isArray(sourceManifestArtifact.value.files)
      || sourceManifestArtifact.value.files.length === 0) {
    fail('S5_CHAIN_SOURCE_TREE', 'source-tree manifest inventory is empty/invalid');
  }
  let selector = null;
  if (hasSelectorRef) {
    if (!refsEqual(
      value.sourceTreeSelectorRef,
      pathRef('buildEvidence', 'source-tree-selector.json'),
    )) {
      fail(
        'S5_CHAIN_SOURCE_SELECTOR',
        'sourceTreeSelectorRef must identify the deterministic detached selector artifact',
      );
    }
    const selectorArtifact = resolver.readJson(
      value.sourceTreeSelectorRef,
      'buildInputs.sourceTreeSelectorRef',
      { allowedRoots: ['buildEvidence'], exactJcs: true },
    );
    if (taggedJcsDigest('axiolune-source-tree-selector-v1\0', selectorArtifact.value)
        !== value.sourceTreeSelectorDigest) {
      fail('S5_CHAIN_SOURCE_SELECTOR', 'source-tree selector digest drift');
    }
    selector = selectorArtifact.value;
    validateGitSourceTreeSelector(selector, resolver.roots.sourceTree);
    if (sourceManifestArtifact.value.gitObjectFormat !== selector.gitObjectFormat) {
      fail('S5_CHAIN_SOURCE_SELECTOR', 'manifest and selector Git object formats differ');
    }
    let replay;
    try {
      replay = buildGitSourceTreeManifest(
        resolver.roots.sourceTree,
        selector.treeId,
        selector.gitObjectFormat,
      );
    } catch (error) {
      fail(
        'S5_CHAIN_SOURCE_TREE',
        `Git source tree cannot be independently replayed: ${error.message}`,
      );
    }
    if (canonicalJcs(replay.manifest) !== canonicalJcs(sourceManifestArtifact.value)) {
      fail(
        'S5_CHAIN_SOURCE_TREE',
        'source-tree manifest does not equal the independently replayed Git tree',
      );
    }
  }
  const hydrated = sourceManifestArtifact.value.files.map((entry, index) => {
    exactKeys(
      entry,
      ['artifactDigest', 'byteLength', 'mode', 'path'],
      `sourceTreeManifest.files[${index}]`,
      'S5_CHAIN_SOURCE_TREE',
    );
    const artifact = resolver.read(pathRef('sourceTree', entry.path), `sourceTreeManifest.files[${index}]`, ['sourceTree']);
    if (artifact.digest !== entry.artifactDigest || artifact.bytes.length !== entry.byteLength) {
      fail('S5_CHAIN_SOURCE_TREE', `${entry.path} no longer equals the frozen source-tree entry`);
    }
    return { ...entry, bytes: artifact.bytes };
  });
  if (sourceTreeDigest(hydrated) !== value.sourceTreeDigest) {
    fail('S5_CHAIN_SOURCE_TREE', 'sourceTreeDigest does not recompute from exact source bytes');
  }
  return {
    bindingKind: selector === null ? 'sourceClosure' : 'gitCommit',
    manifest: sourceManifestArtifact.value,
    selector,
  };
}

function decodeBundleUtf8(bytes, label) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    fail('S5_BUNDLE_UTF8', `${label} is not valid UTF-8: ${cause.message}`);
  }
  if (text.charCodeAt(0) === 0xfeff) {
    fail('S5_BUNDLE_UTF8', `${label} must not contain a UTF-8 BOM`);
  }
  return text;
}

function parseBundleJsonBytes(bytes, label, exactJcs = false) {
  const text = decodeBundleUtf8(bytes, label);
  let value;
  try {
    value = parseJsonRejectingDuplicateMembers(text);
  } catch (cause) {
    fail('S5_BUNDLE_JSON', `${label} is not duplicate-free JSON: ${cause.message}`);
  }
  if (exactJcs && text !== canonicalJcs(value)) {
    fail('S5_BUNDLE_JCS', `${label} bytes must equal exact RFC 8785 JCS`);
  }
  return { text, value };
}

function createCompletedRunBundleResolver(bundle) {
  exactKeys(bundle, ['artifacts', 'schemaVersion'], 'completedRunBundle', 'S5_BUNDLE_SCHEMA');
  if (bundle.schemaVersion !== '1.0'
      || !Array.isArray(bundle.artifacts)
      || bundle.artifacts.length === 0) {
    fail('S5_BUNDLE_SCHEMA', 'completedRunBundle must contain a non-empty artifact inventory');
  }
  if (bundle.artifacts.length > MAX_COMPLETED_BUNDLE_ARTIFACTS) {
    fail(
      'S5_BUNDLE_LIMIT',
      `completedRunBundle exceeds ${MAX_COMPLETED_BUNDLE_ARTIFACTS} artifacts`,
    );
  }
  const byRef = new Map();
  const artifacts = [];
  const usedRefs = new Set();
  let totalBytes = 0;
  for (const [index, row] of bundle.artifacts.entries()) {
    const label = `completedRunBundle.artifacts[${index}]`;
    exactKeys(row, ['bytes', 'mediaType', 'ref'], label, 'S5_BUNDLE_SCHEMA');
    if (!Buffer.isBuffer(row.bytes)) {
      fail('S5_BUNDLE_BYTES', `${label}.bytes must be a Buffer containing the exact artifact bytes`);
    }
    if (row.bytes.length > MAX_COMPLETED_BUNDLE_ARTIFACT_BYTES) {
      fail(
        'S5_BUNDLE_LIMIT',
        `${label}.bytes exceeds ${MAX_COMPLETED_BUNDLE_ARTIFACT_BYTES} bytes`,
      );
    }
    totalBytes += row.bytes.length;
    if (totalBytes > MAX_COMPLETED_BUNDLE_TOTAL_BYTES) {
      fail(
        'S5_BUNDLE_LIMIT',
        `completedRunBundle exceeds ${MAX_COMPLETED_BUNDLE_TOTAL_BYTES} total artifact bytes`,
      );
    }
    if (typeof row.mediaType !== 'string' || !MEDIA_TYPE_RE.test(row.mediaType)) {
      fail('S5_BUNDLE_MEDIA_TYPE', `${label}.mediaType is not canonical`);
    }
    const key = refSortKey(row.ref);
    if (byRef.has(key)) {
      fail('S5_BUNDLE_DUPLICATE_ARTIFACT', `${label}.ref duplicates ${key}`);
    }
    const bytes = Buffer.from(row.bytes);
    const artifact = Object.freeze({
      bytes,
      digest: artifactDigest(bytes),
      mediaType: row.mediaType,
      ref: row.ref,
    });
    byRef.set(key, artifact);
    artifacts.push(artifact);
  }

  function get(ref) {
    return byRef.get(refSortKey(ref)) || null;
  }

  function mark(ref) {
    const key = refSortKey(ref);
    if (!byRef.has(key)) {
      fail('S5_BUNDLE_ARTIFACT_MISSING', `${key} is absent from the bundle`);
    }
    usedRefs.add(key);
  }

  function resolve(ref, label, allowedRoots = ['sourceTree', 'buildEvidence']) {
    const validation = validateArtifactRef(ref);
    if (!validation.ok) fail('S5_CHAIN_ARTIFACT_REF', `${label}: ${validation.errors.join('; ')}`);
    if (ref.kind === 'path' && !allowedRoots.includes(ref.root)) {
      fail('S5_CHAIN_ARTIFACT_ROOT', `${label} uses forbidden root ${ref.root}`);
    }
    const artifact = get(ref);
    if (!artifact) fail('S5_BUNDLE_ARTIFACT_MISSING', `${label} is absent from the bundle`);
    mark(ref);
    return refSortKey(ref);
  }

  function read(ref, label, allowedRoots = ['sourceTree', 'buildEvidence']) {
    resolve(ref, label, allowedRoots);
    const artifact = get(ref);
    return artifact;
  }

  function readJson(ref, label, options = {}) {
    const artifact = read(ref, label, options.allowedRoots || ['sourceTree', 'buildEvidence']);
    if (artifact.mediaType !== 'application/json'
        && !artifact.mediaType.endsWith('+json')) {
      fail('S5_BUNDLE_MEDIA_TYPE', `${label} must use a JSON media type`);
    }
    return {
      ...artifact,
      value: parseBundleJsonBytes(artifact.bytes, label, options.exactJcs === true).value,
    };
  }

  return {
    artifacts: Object.freeze(artifacts),
    byRef,
    get,
    mark,
    read,
    readJson,
    resolve,
    roots: Object.freeze({ buildEvidence: null, sourceTree: null }),
    usedRefs,
  };
}

function validateCompletedRunBundleExpectations(expectations) {
  exactKeys(
    expectations,
    ['evidenceLedger', 'output', 'run', 'validationReport'],
    'completedRunExpectations',
    'S5_BUNDLE_EXPECTATION',
  );
  for (const field of ['evidenceLedger', 'run', 'validationReport']) {
    exactKeys(
      expectations[field],
      ['iri', 'recordDigest'],
      `completedRunExpectations.${field}`,
      'S5_BUNDLE_EXPECTATION',
    );
    absoluteIri(expectations[field].iri, `completedRunExpectations.${field}.iri`);
    rawDigestBytes(
      expectations[field].recordDigest,
      `completedRunExpectations.${field}.recordDigest`,
    );
  }
  exactKeys(
    expectations.output,
    ['artifactRef', 'factVersionIris', 'graphDigest', 'graphIri'],
    'completedRunExpectations.output',
    'S5_BUNDLE_EXPECTATION',
  );
  refSortKey(expectations.output.artifactRef);
  absoluteIri(expectations.output.graphIri, 'completedRunExpectations.output.graphIri');
  rawDigestBytes(expectations.output.graphDigest, 'completedRunExpectations.output.graphDigest');
  sortedUniqueStrings(
    expectations.output.factVersionIris,
    'completedRunExpectations.output.factVersionIris',
    { nonEmpty: false },
  );
  expectations.output.factVersionIris.forEach((iri, index) => (
    absoluteIri(iri, `completedRunExpectations.output.factVersionIris[${index}]`)
  ));
}

function inspectBundleJsonArtifact(artifact) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes);
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function exactJcsArtifactForRecordExpectation(resolver, expectation, recordType, label) {
  const matches = [];
  for (const artifact of resolver.artifacts) {
    const inspected = inspectBundleJsonArtifact(artifact);
    if (inspected?.iri !== expectation.iri || inspected?.recordType !== recordType) continue;
    const parsed = parseBundleJsonBytes(
      artifact.bytes,
      `${label}@${refSortKey(artifact.ref)}`,
      true,
    );
    matches.push({ ...artifact, record: parsed.value });
  }
  if (matches.length !== 1) {
    fail(
      matches.length === 0 ? 'S5_BUNDLE_RECORD_MISSING' : 'S5_BUNDLE_RECORD_AMBIGUOUS',
      `${label} must resolve to exactly one exact-JCS ${recordType} artifact`,
    );
  }
  if (matches[0].digest !== expectation.recordDigest) {
    fail('S5_BUNDLE_RECORD_DIGEST', `${label} exact-JCS bytes do not equal the expected digest`);
  }
  if (matches[0].mediaType !== 'application/json'
      && !matches[0].mediaType.endsWith('+json')) {
    fail('S5_BUNDLE_MEDIA_TYPE', `${label} must use a JSON media type`);
  }
  resolver.mark(matches[0].ref);
  return matches[0];
}

function exactJcsArtifactForLedgerEntry(resolver, entry, label) {
  const matches = [];
  for (const artifact of resolver.artifacts) {
    const inspected = inspectBundleJsonArtifact(artifact);
    if (inspected?.iri !== entry.recordIri
        || inspected?.recordType !== entry.recordType
        || inspected?.slotId !== entry.slotId) continue;
    const parsed = parseBundleJsonBytes(
      artifact.bytes,
      `${label}@${refSortKey(artifact.ref)}`,
      true,
    );
    matches.push({ ...artifact, record: parsed.value });
  }
  if (matches.length !== 1) {
    fail(
      matches.length === 0 ? 'S5_BUNDLE_RECORD_MISSING' : 'S5_BUNDLE_RECORD_AMBIGUOUS',
      `${label} must resolve to exactly one exact-JCS control record`,
    );
  }
  if (matches[0].digest !== entry.recordDigest) {
    fail('S5_BUNDLE_RECORD_DIGEST', `${label} exact-JCS bytes do not equal the ledger digest`);
  }
  if (matches[0].mediaType !== 'application/json'
      && !matches[0].mediaType.endsWith('+json')) {
    fail('S5_BUNDLE_MEDIA_TYPE', `${label} must use a JSON media type`);
  }
  resolver.mark(matches[0].ref);
  return matches[0];
}

function findTaggedJcsArtifactByIri(resolver, iri, tag, expectedDigest, label) {
  const iriMatches = [];
  for (const artifact of resolver.artifacts) {
    const inspected = inspectBundleJsonArtifact(artifact);
    if (inspected?.iri !== iri) continue;
    const parsed = parseBundleJsonBytes(
      artifact.bytes,
      `${label}@${refSortKey(artifact.ref)}`,
      true,
    );
    iriMatches.push({ ...artifact, value: parsed.value });
  }
  if (iriMatches.length !== 1) {
    fail(
      iriMatches.length === 0 ? 'S5_BUNDLE_CLOSURE_MISSING' : 'S5_BUNDLE_CLOSURE_AMBIGUOUS',
      `${label} must resolve by IRI and tagged digest to exactly one exact-JCS artifact`,
    );
  }
  if (taggedJcsDigest(tag, iriMatches[0].value) !== expectedDigest) {
    fail('S5_BUNDLE_CLOSURE_DIGEST', `${label} exact-JCS bytes do not equal the expected tagged digest`);
  }
  if (iriMatches[0].mediaType !== 'application/json'
      && !iriMatches[0].mediaType.endsWith('+json')) {
    fail('S5_BUNDLE_MEDIA_TYPE', `${label} must use a JSON media type`);
  }
  resolver.mark(iriMatches[0].ref);
  return iriMatches[0];
}

function findExactJcsSourceArtifactByIri(resolver, iri, label) {
  const matches = [];
  for (const artifact of resolver.artifacts) {
    const inspected = inspectBundleJsonArtifact(artifact);
    if (inspected?.iri !== iri) continue;
    const parsed = parseBundleJsonBytes(
      artifact.bytes,
      `${label}@${refSortKey(artifact.ref)}`,
      true,
    );
    matches.push({ ...artifact, value: parsed.value });
  }
  if (matches.length !== 1) {
    fail(
      matches.length === 0 ? 'S5_BUNDLE_CLOSURE_MISSING' : 'S5_BUNDLE_CLOSURE_AMBIGUOUS',
      `${label} must resolve by IRI to exactly one exact-JCS source artifact`,
    );
  }
  if (matches[0].ref.kind !== 'path' || matches[0].ref.root !== 'sourceTree') {
    fail(
      'S5_BUNDLE_UNAUTHENTICATED_SOURCE',
      `${label} must be authenticated by the exact source-tree manifest`,
    );
  }
  if (matches[0].mediaType !== 'application/json'
      && !matches[0].mediaType.endsWith('+json')) {
    fail('S5_BUNDLE_MEDIA_TYPE', `${label} must use a JSON media type`);
  }
  resolver.mark(matches[0].ref);
  return matches[0];
}

function bundlePathDigest(resolver, ref, label) {
  const direct = resolver.get(ref);
  if (direct) {
    resolver.mark(ref);
    return direct.digest;
  }
  if (ref.kind !== 'path') {
    fail('S5_BUNDLE_ARTIFACT_MISSING', `${label} does not resolve to bundled bytes`);
  }
  const prefix = `${ref.path}/`;
  const members = resolver.artifacts.filter((artifact) => (
    artifact.ref.kind === 'path'
    && artifact.ref.root === ref.root
    && artifact.ref.path.startsWith(prefix)
  )).map((artifact) => ({
    artifact,
    relativePath: artifact.ref.path.slice(prefix.length),
  })).sort((left, right) => utf8Compare(left.relativePath, right.relativePath));
  if (members.length === 0) {
    fail('S5_BUNDLE_ARTIFACT_MISSING', `${label} directory has no bundled members`);
  }
  members.forEach((member) => resolver.mark(member.artifact.ref));
  const parts = [Buffer.from('axiolune-reference-bundle-v1\0', 'utf8'), u64be(members.length)];
  for (const member of members) {
    const pathBytes = Buffer.from(member.relativePath, 'utf8');
    parts.push(
      u64be(pathBytes.length), pathBytes,
      u64be(member.artifact.bytes.length), member.artifact.bytes,
    );
  }
  return artifactDigest(Buffer.concat(parts));
}

function validateBundledReferenceClosure(value, resolver) {
  if (value.entries?.length === 1
      && value.entries[0]?.referenceId === 'axiolune-s5-synthetic-reference') {
    return validateSyntheticReferenceClosure(value, resolver);
  }
  exactKeys(
    value,
    [
      'entries', 'lockSourceDigest', 'lockSourceRef', 'referenceBundleDigest',
      'referenceBundleRef', 'schemaVersion',
    ],
    'referenceClosure',
    'S5_CHAIN_REFERENCE_CLOSURE',
  );
  if (value.schemaVersion !== '1.0'
      || !Array.isArray(value.entries)
      || value.entries.length === 0) {
    fail('S5_CHAIN_REFERENCE_CLOSURE', 'reference closure inventory is empty or invalid');
  }
  const lock = resolver.read(value.lockSourceRef, 'referenceClosure.lockSourceRef', ['sourceTree']);
  if (lock.digest !== value.lockSourceDigest) {
    fail('S5_CHAIN_REFERENCE_CLOSURE', 'reference lock raw bytes/digest drift');
  }
  if (bundlePathDigest(resolver, value.referenceBundleRef, 'referenceClosure.referenceBundleRef')
      !== value.referenceBundleDigest) {
    fail('S5_CHAIN_REFERENCE_CLOSURE', 'reference bundle raw-byte root digest drift');
  }
  const ids = [];
  for (const [index, entry] of value.entries.entries()) {
    const label = `referenceClosure.entries[${index}]`;
    if (!isPlainObject(entry)
        || typeof entry.referenceId !== 'string'
        || !Array.isArray(entry.locators)) {
      fail('S5_CHAIN_REFERENCE_CLOSURE', `${label} is malformed`);
    }
    ids.push(entry.referenceId);
    absoluteIri(entry.sourceUrl, `${label}.sourceUrl`);
    const local = ['localLocked', 'remoteSnapshotLocked'].includes(entry.availability);
    if (local) {
      if (!('artifactRef' in entry) || !('artifactDigest' in entry)) {
        fail('S5_CHAIN_REFERENCE_CLOSURE', `${label} local entry lacks artifact bytes/digest`);
      }
      rawDigestBytes(entry.artifactDigest, `${label}.artifactDigest`);
      if (bundlePathDigest(resolver, entry.artifactRef, `${label}.artifactRef`)
          !== entry.artifactDigest) {
        fail('S5_CHAIN_REFERENCE_CLOSURE', `${label} artifact bundle digest drift`);
      }
    } else if ('artifactRef' in entry || 'artifactDigest' in entry) {
      fail('S5_CHAIN_REFERENCE_CLOSURE', `${label} unavailable entry must not invent artifact bytes`);
    }
    for (const [locatorIndex, locator] of entry.locators.entries()) {
      const locatorLabel = `${label}.locators[${locatorIndex}]`;
      const syntax = validateSourceLocator(locator, { at: locatorLabel });
      if (!syntax.ok) fail('S5_CHAIN_REFERENCE_CLOSURE', syntax.errors.join('; '));
      const extractor = resolver.read(
        locator.extractorProfileRef,
        `${locatorLabel}.extractorProfileRef`,
        ['sourceTree'],
      );
      if (extractor.digest !== locator.extractorProfileDigest) {
        fail('S5_CHAIN_REFERENCE_CLOSURE', `${locatorLabel} extractor digest drift`);
      }
    }
  }
  sortedUniqueStrings(ids, 'referenceClosure.referenceIds');
  return { closure: value };
}

function validateBundleSourceTreeInventory(resolver, manifest) {
  const manifestPaths = manifest.files.map((entry) => entry.path);
  const bundledPaths = resolver.artifacts.filter((artifact) => (
    artifact.ref.kind === 'path' && artifact.ref.root === 'sourceTree'
  )).map((artifact) => artifact.ref.path).sort(utf8Compare);
  if (canonicalJcs(manifestPaths) !== canonicalJcs(bundledPaths)) {
    fail(
      'S5_BUNDLE_SOURCE_TREE',
      'bundle sourceTree artifacts do not equal the byte-locked source-tree manifest inventory',
    );
  }
  resolver.artifacts.filter((artifact) => (
    artifact.ref.kind === 'path' && artifact.ref.root === 'sourceTree'
  )).forEach((artifact) => resolver.mark(artifact.ref));
}

function validateCompletedMaterializationPlan(
  value,
  run,
  ontologyState,
  primaryDatasetIris,
  label,
) {
  const optionalFields = [
    'conflictResolution',
  ].filter((field) => field in value);
  exactKeys(
    value,
    [
      ...optionalFields,
      'definition', 'iri', 'label', 'materializationMode', 'owner',
      'semanticMappings', 'sourceDatasets', 'targetGraphUri',
      'targetOntologyModule',
    ],
    label,
    'S5_CHAIN_PLAN_SOURCE',
  );
  for (const field of ['iri', 'targetGraphUri', 'targetOntologyModule']) {
    absoluteIri(value[field], `${label}.${field}`);
  }
  for (const field of ['definition', 'label']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      fail('S5_CHAIN_PLAN_SOURCE', `${label}.${field} must be non-empty`);
    }
  }
  if (value.iri !== run.planRef
      || value.targetGraphUri !== run.result.outputGraph
      || value.materializationMode !== 'Full'
      || value.owner !== 'repository-owner') {
    fail('S5_CHAIN_PLAN_SOURCE', `${label} identity/mode/owner/output binding drift`);
  }
  const targetModule = ontologyState.modules.get(value.targetOntologyModule);
  if (!targetModule || targetModule.row.layer !== 'm2') {
    fail(
      'S5_CHAIN_PLAN_SOURCE',
      `${label}.targetOntologyModule is not an actual locked M2 ontology module`,
    );
  }
  sortedUniqueStrings(value.sourceDatasets, `${label}.sourceDatasets`);
  value.sourceDatasets.forEach((iri, index) => (
    absoluteIri(iri, `${label}.sourceDatasets[${index}]`)
  ));
  sortedUniqueStrings(value.semanticMappings, `${label}.semanticMappings`);
  value.semanticMappings.forEach((iri, index) => (
    absoluteIri(iri, `${label}.semanticMappings[${index}]`)
  ));

  sortedUniqueStrings(primaryDatasetIris, `${label}.primaryDatasetIris`);
  const mappingIris = run.mappingClosure.map((entry) => entry.mappingRef).sort(utf8Compare);
  if (canonicalJcs(value.sourceDatasets) !== canonicalJcs(primaryDatasetIris)
      || canonicalJcs(value.semanticMappings) !== canonicalJcs(mappingIris)) {
    fail(
      'S5_CHAIN_PLAN_SOURCE',
      `${label} does not equal the authenticated primary-dataset/mapping closure`,
    );
  }
  if ('conflictResolution' in value) {
    validateCompletedConflictResolution(
      value.conflictResolution,
      `${label}.conflictResolution`,
    );
  }
}

function validateCompletedConflictResolution(value, label) {
  if (!isPlainObject(value)) {
    fail('S5_CHAIN_MAPPING_CONFLICT', `${label} must be a closed strategy object`);
  }
  const optionalFields = [
    'authoritySourcePriority', 'timestampField',
  ].filter((field) => field in value);
  exactKeys(
    value,
    [...optionalFields, 'strategy'],
    label,
    'S5_CHAIN_MAPPING_CONFLICT',
  );
  if (![
    'AuthoritySource', 'TimestampPriority', 'ManualReview', 'Merge', 'RejectConflict',
  ].includes(value.strategy)) {
    fail('S5_CHAIN_MAPPING_CONFLICT', `${label}.strategy is outside M3`);
  }
  if (value.strategy === 'AuthoritySource') {
    if (!Array.isArray(value.authoritySourcePriority)
        || value.authoritySourcePriority.length === 0
        || 'timestampField' in value) {
      fail(
        'S5_CHAIN_MAPPING_CONFLICT',
        `${label} AuthoritySource requires only a non-empty authoritySourcePriority`,
      );
    }
    const seen = new Set();
    value.authoritySourcePriority.forEach((iri, index) => {
      absoluteIri(iri, `${label}.authoritySourcePriority[${index}]`);
      if (seen.has(iri)) {
        fail('S5_CHAIN_MAPPING_CONFLICT', `${label}.authoritySourcePriority repeats ${iri}`);
      }
      seen.add(iri);
    });
    return;
  }
  if (value.strategy === 'TimestampPriority') {
    if ('authoritySourcePriority' in value) {
      fail(
        'S5_CHAIN_MAPPING_CONFLICT',
        `${label} TimestampPriority cannot carry authoritySourcePriority`,
      );
    }
    completedMappingString(value.timestampField, `${label}.timestampField`);
    return;
  }
  if (optionalFields.length !== 0) {
    fail(
      'S5_CHAIN_MAPPING_CONFLICT',
      `${label}.${value.strategy} cannot carry fields for another strategy`,
    );
  }
}

function validateCompletedSourceSchema(value, label) {
  if (!isPlainObject(value)
      || typeof value.schemaVersion !== 'string'
      || value.schemaVersion.length === 0) {
    fail('S5_CHAIN_SOURCE_SCHEMA', `${label} must be a versioned source-schema object`);
  }
  absoluteIri(value.dataset, `${label}.dataset`);
  if (!Array.isArray(value.fields)) {
    fail('S5_CHAIN_SOURCE_SCHEMA', `${label}.fields must be a FieldDefinition list`);
  }
  const fields = new Map();
  for (const [index, field] of value.fields.entries()) {
    const fieldLabel = `${label}.fields[${index}]`;
    if (!isPlainObject(field)) {
      fail('S5_CHAIN_SOURCE_SCHEMA', `${fieldLabel} must be a FieldDefinition object`);
    }
    const name = completedMappingString(field.name, `${fieldLabel}.name`);
    if (fields.has(name)) {
      fail('S5_CHAIN_SOURCE_SCHEMA', `${label}.fields repeats ${name}`);
    }
    const physicalType = 'dataType' in field ? field.dataType : field.type;
    if (typeof physicalType !== 'string'
        || physicalType.length === 0
        || physicalType !== physicalType.normalize('NFC')) {
      fail(
        'S5_CHAIN_SOURCE_SCHEMA',
        `${fieldLabel} must declare a non-empty dataType or S5 profile type`,
      );
    }
    if ('dataType' in field && 'type' in field && field.dataType !== field.type) {
      fail('S5_CHAIN_SOURCE_SCHEMA', `${fieldLabel} has ambiguous physical types`);
    }
    if ('required' in field && typeof field.required !== 'boolean') {
      fail('S5_CHAIN_SOURCE_SCHEMA', `${fieldLabel}.required must be boolean`);
    }
    if ('nullable' in field && typeof field.nullable !== 'boolean') {
      fail('S5_CHAIN_SOURCE_SCHEMA', `${fieldLabel}.nullable must be boolean`);
    }
    if ('primaryKey' in field && typeof field.primaryKey !== 'boolean') {
      fail('S5_CHAIN_SOURCE_SCHEMA', `${fieldLabel}.primaryKey must be boolean`);
    }
    fields.set(name, {
      definition: field,
      physicalType,
      required: field.required === true
        || field.nullable === false
        || field.primaryKey === true,
    });
  }
  if ('primaryKey' in value) {
    if (!Array.isArray(value.primaryKey)) {
      fail('S5_CHAIN_SOURCE_SCHEMA', `${label}.primaryKey must be a field-name list`);
    }
    const seen = new Set();
    value.primaryKey.forEach((name, index) => {
      completedMappingString(name, `${label}.primaryKey[${index}]`);
      if (!fields.has(name) || seen.has(name)) {
        fail(
          'S5_CHAIN_SOURCE_SCHEMA',
          `${label}.primaryKey must contain unique declared field names`,
        );
      }
      seen.add(name);
      fields.get(name).required = true;
    });
  }
  return { fields, value };
}

function validateCompletedSourceSnapshot(snapshot, snapshotArtifact, schemaState, label) {
  const parsed = parseBundleJsonBytes(snapshotArtifact.bytes, label, true).value;
  if (!isPlainObject(parsed)
      || parsed.dataset !== snapshot.dataset
      || !Array.isArray(parsed.rows)) {
    fail(
      'S5_CHAIN_SOURCE_SNAPSHOT',
      `${label} must be an exact-JCS dataset snapshot with matching dataset and rows`,
    );
  }
  if (parsed.snapshotTime !== snapshot.snapshotTime) {
    fail(
      'S5_CHAIN_SOURCE_SNAPSHOT',
      `${label}.snapshotTime does not equal InputDatasetSnapshot.snapshotTime`,
    );
  }
  if ('snapshotId' in parsed) completedMappingString(parsed.snapshotId, `${label}.snapshotId`);
  if ('rowCount' in snapshot && snapshot.rowCount !== parsed.rows.length) {
    fail('S5_CHAIN_SOURCE_SNAPSHOT', `${label}.rows does not equal declared rowCount`);
  }
  for (const [rowIndex, row] of parsed.rows.entries()) {
    const rowLabel = `${label}.rows[${rowIndex}]`;
    if (!isPlainObject(row)) {
      fail('S5_CHAIN_SOURCE_SNAPSHOT', `${rowLabel} must be a source row object`);
    }
    for (const field of Object.keys(row)) {
      if (!schemaState.fields.has(field)) {
        fail('S5_CHAIN_SOURCE_SNAPSHOT', `${rowLabel}.${field} is absent from its schema`);
      }
    }
    for (const [field, state] of schemaState.fields) {
      if (state.required && !Object.prototype.hasOwnProperty.call(row, field)) {
        fail('S5_CHAIN_SOURCE_SNAPSHOT', `${rowLabel} omits required field ${field}`);
      }
    }
  }
  return parsed;
}

function validateCompletedSourceSchemaBindings(run, buildInputs, resolver) {
  const declaredInputs = buildInputs.inputs.map((bindingValue, index) => {
    const artifact = resolver.read(
      bindingValue.artifactRef,
      `buildInputs.inputs[${index}].artifactRef`,
      ['sourceTree', 'buildEvidence'],
    );
    return { artifact, binding: bindingValue, index };
  });
  const byDataset = new Map();
  const auxiliaryDatasets = [];
  for (const [snapshotIndex, snapshot] of run.inputDatasets.entries()) {
    if (snapshot.dataset === PRIOR_SUPPORT_DATASET_IRI) {
      auxiliaryDatasets.push({ index: snapshotIndex, snapshot });
      continue;
    }
    const candidates = declaredInputs.filter(({ artifact, binding: bindingValue }) => (
      artifact.digest === snapshot.schemaDigest
      && bindingValue.artifactDigest === snapshot.schemaDigest
      && bindingValue.mediaType === artifact.mediaType
      && (bindingValue.mediaType === 'application/json'
        || bindingValue.mediaType.endsWith('+json'))
      && (artifact.mediaType === 'application/json' || artifact.mediaType.endsWith('+json'))
    ));
    const matches = [];
    for (const candidate of candidates) {
      const value = parseBundleJsonBytes(
        candidate.artifact.bytes,
        `completedRun.inputDatasets[${snapshotIndex}].schema@buildInputs.inputs[${candidate.index}]`,
        true,
      ).value;
      if (isPlainObject(value)
          && value.dataset === snapshot.dataset
          && typeof value.schemaVersion === 'string'
          && value.schemaVersion.length !== 0) {
        matches.push({ ...candidate, value });
      }
    }
    if (matches.length !== 1) {
      fail(
        matches.length === 0
          ? 'S5_BUNDLE_SCHEMA_ARTIFACT_MISSING'
          : 'S5_BUNDLE_SCHEMA_ARTIFACT_AMBIGUOUS',
        `completedRun.inputDatasets[${snapshotIndex}] must bind exactly one declared exact-JCS schema with the same dataset identity`,
      );
    }
    const schemaState = validateCompletedSourceSchema(
      matches[0].value,
      `completedRun.inputDatasets[${snapshotIndex}].schema`,
    );
    const snapshotArtifact = resolver.read(
      snapshot.snapshotRef,
      `completedRun.inputDatasets[${snapshotIndex}].snapshotRef`,
      ['sourceTree', 'buildEvidence'],
    );
    validateCompletedSourceSnapshot(
      snapshot,
      snapshotArtifact,
      schemaState,
      `completedRun.inputDatasets[${snapshotIndex}].snapshot`,
    );
    byDataset.set(snapshot.dataset, {
      ...schemaState,
      artifact: matches[0].artifact,
      artifactRef: matches[0].binding.artifactRef,
      digest: matches[0].artifact.digest,
      snapshotArtifact,
      snapshotRef: snapshot.snapshotRef,
    });
  }
  let priorSupport = null;
  if (auxiliaryDatasets.length > 0) {
    if (auxiliaryDatasets.length !== 1 || byDataset.size !== 1) {
      fail(
        'S5_BUNDLE_PRIOR_SUPPORT',
        'Slice-A completed run must bind exactly one primary source dataset and one prior-support dataset',
      );
    }
    const priorBindingRows = declaredInputs.filter(({ binding: bindingValue }) => (
      bindingValue.name === 'priorSupportChain'
    ));
    if (priorBindingRows.length !== 1) {
      fail(
        'S5_BUNDLE_PRIOR_SUPPORT',
        'completed run build inputs must bind exactly one priorSupportChain manifest',
      );
    }
    const [{ snapshot, index: snapshotIndex }] = auxiliaryDatasets;
    const [sourceSchema] = [...byDataset.values()];
    try {
      priorSupport = validatePriorSupportChain(
        priorBindingRows[0].binding.artifactRef,
        resolver,
        {
          assertionTime: run.assertionTime,
          referenceTime: run.referenceTime,
          sourceSchemaDigest: sourceSchema.digest,
          sourceSchemaRef: sourceSchema.artifactRef,
          sourceSnapshotDigest: sourceSchema.snapshotArtifact.digest,
          sourceSnapshotRef: sourceSchema.snapshotRef,
        },
      );
    } catch (cause) {
      fail('S5_BUNDLE_PRIOR_SUPPORT', cause.message);
    }
    if (snapshot.artifactDigest !== priorSupport.datasetArtifact.digest
        || snapshot.dataset !== priorSupport.manifest.dataset.datasetRef
        || snapshot.schemaDigest !== priorSupport.batchArtifact.digest
        || snapshot.snapshotTime !== priorSupport.manifest.dataset.snapshotTime
        || !refsEqual(snapshot.snapshotRef, priorSupport.manifest.dataset.artifactRef)) {
      fail(
        'S5_BUNDLE_PRIOR_SUPPORT',
        `completedRun.inputDatasets[${snapshotIndex}] does not equal the authenticated prior-support chain output`,
      );
    }
  }
  return {
    auxiliaryDatasetIris: new Set(auxiliaryDatasets.map(({ snapshot }) => snapshot.dataset)),
    byDataset,
    priorSupport,
  };
}

function completedMappingString(value, label) {
  if (typeof value !== 'string'
      || value.length === 0
      || value !== value.normalize('NFC')) {
    fail('S5_CHAIN_MAPPING', `${label} must be a non-empty Unicode-NFC string`);
  }
  return value;
}

function validateCompletedFieldReference(value, aliases, schemaByDataset, label) {
  exactKeys(value, ['dataset', 'field'], label, 'S5_CHAIN_MAPPING');
  completedMappingString(value.dataset, `${label}.dataset`);
  completedMappingString(value.field, `${label}.field`);
  if (!aliases.has(value.dataset)) {
    fail('S5_CHAIN_MAPPING', `${label}.dataset is not a declared source alias`);
  }
  const datasetIri = aliases.get(value.dataset);
  const schema = schemaByDataset.get(datasetIri);
  if (!schema || !schema.fields.has(value.field)) {
    fail(
      'S5_CHAIN_SOURCE_SCHEMA',
      `${label}.field is absent from the exact schema for ${datasetIri}`,
    );
  }
}

function validateCompletedValueBinding(
  value,
  aliases,
  schemaByDataset,
  label,
  transformationRefs,
  transformationInputNames,
  referencedMappingRefs,
) {
  if (!isPlainObject(value)) fail('S5_CHAIN_MAPPING', `${label} must be a closed ValueBinding`);
  if (value.bindingType === 'directField') {
    exactKeys(value, ['bindingType', 'source'], label, 'S5_CHAIN_MAPPING');
    validateCompletedFieldReference(value.source, aliases, schemaByDataset, `${label}.source`);
    return;
  }
  if (value.bindingType === 'transformation') {
    exactKeys(
      value,
      ['bindingType', 'inputs', 'transformationRef'],
      label,
      'S5_CHAIN_MAPPING',
    );
    absoluteIri(value.transformationRef, `${label}.transformationRef`);
    if (!isPlainObject(value.inputs)) {
      fail('S5_CHAIN_MAPPING', `${label}.inputs must be a closed named binding map`);
    }
    for (const [name, input] of Object.entries(value.inputs)) {
      completedMappingString(name, `${label}.inputs key`);
      validateCompletedValueBinding(
        input,
        aliases,
        schemaByDataset,
        `${label}.inputs.${name}`,
        transformationRefs,
        transformationInputNames,
        referencedMappingRefs,
      );
    }
    const inputNames = Object.keys(value.inputs).sort(utf8Compare);
    const priorInputNames = transformationInputNames.get(value.transformationRef);
    if (priorInputNames
        && canonicalJcs(priorInputNames) !== canonicalJcs(inputNames)) {
      fail(
        'S5_CHAIN_TRANSFORMATION',
        `${label}.inputs disagree with another use of ${value.transformationRef}`,
      );
    }
    transformationInputNames.set(value.transformationRef, inputNames);
    transformationRefs.add(value.transformationRef);
    return;
  }
  if (value.bindingType === 'literal') {
    exactKeys(value, ['bindingType', 'value'], label, 'S5_CHAIN_MAPPING');
    return;
  }
  if (value.bindingType === 'runtimeContext') {
    exactKeys(value, ['bindingType', 'contextField'], label, 'S5_CHAIN_MAPPING');
    if (!['iri', 'assertionTime', 'referenceTime', 'runId'].includes(value.contextField)) {
      fail('S5_CHAIN_MAPPING', `${label}.contextField is outside MaterializationRun context`);
    }
    return;
  }
  if (value.bindingType === 'referenceIdentity') {
    exactKeys(
      value,
      ['bindingType', 'keyBindings', 'referenceMode', 'targetMappingRef'],
      label,
      'S5_CHAIN_MAPPING',
    );
    absoluteIri(value.targetMappingRef, `${label}.targetMappingRef`);
    if (!['logical', 'version'].includes(value.referenceMode)
        || !isPlainObject(value.keyBindings)
        || Object.keys(value.keyBindings).length === 0) {
      fail('S5_CHAIN_MAPPING', `${label} reference identity contract is incomplete`);
    }
    for (const [name, bindingValue] of Object.entries(value.keyBindings)) {
      completedMappingString(name, `${label}.keyBindings key`);
      validateCompletedValueBinding(
        bindingValue,
        aliases,
        schemaByDataset,
        `${label}.keyBindings.${name}`,
        transformationRefs,
        transformationInputNames,
        referencedMappingRefs,
      );
    }
    referencedMappingRefs.add(value.targetMappingRef);
    return;
  }
  fail('S5_CHAIN_MAPPING', `${label}.bindingType is not an M3 ValueBinding variant`);
}

function validateCompletedRowSet(value, aliases, schemaByDataset, label) {
  if (!isPlainObject(value)) {
    fail('S5_CHAIN_MAPPING', `${label} must be a closed RowSetSpec`);
  }
  exactKeys(
    value,
    [
      ...('filters' in value ? ['filters'] : []),
      ...('grouping' in value ? ['grouping'] : []),
      ...('joins' in value ? ['joins'] : []),
    ],
    label,
    'S5_CHAIN_MAPPING',
  );
  if ('filters' in value) {
    if (!Array.isArray(value.filters)) {
      fail('S5_CHAIN_MAPPING', `${label}.filters must be a list`);
    }
    for (const [index, filter] of value.filters.entries()) {
      exactKeys(
        filter,
        ['dataset', 'field', 'operator', ...('value' in filter ? ['value'] : [])],
        `${label}.filters[${index}]`,
        'S5_CHAIN_MAPPING',
      );
      validateCompletedFieldReference(
        { dataset: filter.dataset, field: filter.field },
        aliases,
        schemaByDataset,
        `${label}.filters[${index}]`,
      );
      if (!['=', '!=', '>', '<', '>=', '<=', 'IN', 'NOT IN', 'LIKE', 'IS NULL', 'IS NOT NULL']
        .includes(filter.operator)) {
        fail('S5_CHAIN_MAPPING', `${label}.filters[${index}].operator is invalid`);
      }
      const nullary = ['IS NULL', 'IS NOT NULL'].includes(filter.operator);
      if (nullary && 'value' in filter && filter.value !== null) {
        fail(
          'S5_CHAIN_MAPPING',
          `${label}.filters[${index}].value must be absent or null for ${filter.operator}`,
        );
      }
      if (!nullary && !Object.prototype.hasOwnProperty.call(filter, 'value')) {
        fail(
          'S5_CHAIN_MAPPING',
          `${label}.filters[${index}].value is required for ${filter.operator}`,
        );
      }
      if (['IN', 'NOT IN'].includes(filter.operator)
          && (!Array.isArray(filter.value) || filter.value.length === 0)) {
        fail(
          'S5_CHAIN_MAPPING',
          `${label}.filters[${index}].value must be a non-empty list for ${filter.operator}`,
        );
      }
    }
  }
  if ('joins' in value) {
    if (!Array.isArray(value.joins)) {
      fail('S5_CHAIN_MAPPING', `${label}.joins must be a list`);
    }
    for (const [index, join] of value.joins.entries()) {
      const joinLabel = `${label}.joins[${index}]`;
      exactKeys(
        join,
        ['conditions', 'joinType', 'leftDataset', 'rightDataset'],
        joinLabel,
        'S5_CHAIN_MAPPING',
      );
      if (!aliases.has(join.leftDataset)
          || !aliases.has(join.rightDataset)
          || !['inner', 'left', 'right', 'full'].includes(join.joinType)
          || !Array.isArray(join.conditions)
          || join.conditions.length === 0) {
        fail('S5_CHAIN_MAPPING', `${joinLabel} join contract is incomplete`);
      }
      for (const [conditionIndex, condition] of join.conditions.entries()) {
        const conditionLabel = `${joinLabel}.conditions[${conditionIndex}]`;
        exactKeys(
          condition,
          ['leftField', 'operator', 'rightField'],
          conditionLabel,
          'S5_CHAIN_MAPPING',
        );
        completedMappingString(condition.leftField, `${conditionLabel}.leftField`);
        completedMappingString(condition.operator, `${conditionLabel}.operator`);
        completedMappingString(condition.rightField, `${conditionLabel}.rightField`);
        validateCompletedFieldReference(
          { dataset: join.leftDataset, field: condition.leftField },
          aliases,
          schemaByDataset,
          `${conditionLabel}.leftField`,
        );
        validateCompletedFieldReference(
          { dataset: join.rightDataset, field: condition.rightField },
          aliases,
          schemaByDataset,
          `${conditionLabel}.rightField`,
        );
      }
    }
  }
  if ('grouping' in value) {
    exactKeys(value.grouping, ['aggregations', 'groupBy'], `${label}.grouping`, 'S5_CHAIN_MAPPING');
    if (!Array.isArray(value.grouping.groupBy)
        || value.grouping.groupBy.length === 0
        || !Array.isArray(value.grouping.aggregations)
        || value.grouping.aggregations.length === 0) {
      fail('S5_CHAIN_MAPPING', `${label}.grouping must bind groupBy and aggregations`);
    }
    value.grouping.groupBy.forEach((field, index) => (
      validateCompletedFieldReference(
        field,
        aliases,
        schemaByDataset,
        `${label}.grouping.groupBy[${index}]`,
      )
    ));
    for (const [index, aggregation] of value.grouping.aggregations.entries()) {
      const aggregationLabel = `${label}.grouping.aggregations[${index}]`;
      exactKeys(
        aggregation,
        ['function', ...('sourceField' in aggregation ? ['sourceField'] : []), 'targetField'],
        aggregationLabel,
        'S5_CHAIN_MAPPING',
      );
      if (!['count', 'sum', 'avg', 'min', 'max', 'first', 'last'].includes(aggregation.function)) {
        fail('S5_CHAIN_MAPPING', `${aggregationLabel}.function is invalid`);
      }
      completedMappingString(aggregation.targetField, `${aggregationLabel}.targetField`);
      if ('sourceField' in aggregation) {
        validateCompletedFieldReference(
          aggregation.sourceField,
          aliases,
          schemaByDataset,
          `${aggregationLabel}.sourceField`,
        );
      }
    }
  }
}

function completedOntologyTypeIsA(actualIri, expectedIri, ontologyState, visiting = new Set()) {
  if (actualIri === expectedIri) return true;
  if (visiting.has(actualIri)) return false;
  visiting.add(actualIri);
  const type = ontologyState.semanticIndex.types.get(actualIri);
  const parents = Array.isArray(type?.definition?.superTypes)
    ? type.definition.superTypes
    : [];
  return parents.some((parent) => (
    completedOntologyTypeIsA(parent, expectedIri, ontologyState, visiting)
  ));
}

function completedOntologyPatternsForType(typeIri, ontologyState, output = new Set(), seen = new Set()) {
  if (seen.has(typeIri)) return output;
  seen.add(typeIri);
  const type = ontologyState.semanticIndex.types.get(typeIri);
  if (!type) return output;
  for (const binding of type.definition.patternBindings || []) {
    if (isPlainObject(binding) && typeof binding.pattern === 'string') output.add(binding.pattern);
  }
  for (const parent of type.definition.superTypes || []) {
    completedOntologyPatternsForType(parent, ontologyState, output, seen);
  }
  const pending = [...output];
  for (const patternIri of pending) {
    const pattern = ontologyState.semanticIndex.patterns.get(patternIri);
    for (const dependency of pattern?.definition?.dependencies || []) {
      if (!output.has(dependency)) {
        output.add(dependency);
        pending.push(dependency);
      }
    }
  }
  return output;
}

function completedOntologyAttributesForType(typeIri, ontologyState, output = new Set(), seen = new Set()) {
  if (seen.has(typeIri)) return output;
  seen.add(typeIri);
  const type = ontologyState.semanticIndex.types.get(typeIri);
  if (!type) return output;
  for (const use of type.definition.attributeUses || []) {
    if (isPlainObject(use) && typeof use.attribute === 'string') output.add(use.attribute);
  }
  for (const parent of type.definition.superTypes || []) {
    completedOntologyAttributesForType(parent, ontologyState, output, seen);
  }
  for (const patternIri of completedOntologyPatternsForType(typeIri, ontologyState)) {
    const pattern = ontologyState.semanticIndex.patterns.get(patternIri);
    for (const injected of pattern?.definition?.injectedAttributes || []) {
      if (isPlainObject(injected) && typeof injected.attribute === 'string') {
        output.add(injected.attribute);
      }
    }
  }
  return output;
}

function completedPatternFieldNames(pattern) {
  const names = new Set();
  for (const injected of pattern?.definition?.injectedAttributes || []) {
    if (!isPlainObject(injected) || typeof injected.attribute !== 'string') continue;
    names.add(injected.attribute);
    const attributeIri = injected.attribute;
    const slash = Math.max(attributeIri.lastIndexOf('/'), attributeIri.lastIndexOf('#'));
    if (slash >= 0 && slash < attributeIri.length - 1) names.add(attributeIri.slice(slash + 1));
  }
  return names;
}

function validateCompletedTargetSlot(value, mappingTargetType, ontologyState, label) {
  if (!isPlainObject(value)) fail('S5_CHAIN_MAPPING', `${label} must be a closed TargetSlot`);
  if (value.slotType === 'attribute') {
    exactKeys(value, ['slotType', 'targetAttribute'], label, 'S5_CHAIN_MAPPING');
    absoluteIri(value.targetAttribute, `${label}.targetAttribute`);
    if (!ontologyState.semanticIndex.attributes.has(value.targetAttribute)) {
      fail('S5_CHAIN_ONTOLOGY_TARGET', `${label}.targetAttribute does not resolve`);
    }
    if (!completedOntologyAttributesForType(mappingTargetType, ontologyState)
      .has(value.targetAttribute)) {
      fail(
        'S5_CHAIN_ONTOLOGY_TARGET',
        `${label}.targetAttribute is not applicable to ${mappingTargetType}`,
      );
    }
    return;
  }
  if (value.slotType === 'participantRole') {
    exactKeys(
      value,
      ['slotType', 'targetAssociation', 'targetRole'],
      label,
      'S5_CHAIN_MAPPING',
    );
    absoluteIri(value.targetAssociation, `${label}.targetAssociation`);
    completedMappingString(value.targetRole, `${label}.targetRole`);
    const association = ontologyState.semanticIndex.types.get(value.targetAssociation);
    if (!association
        || association.kind !== 'associationType'
        || value.targetAssociation !== mappingTargetType
        || !(association.definition.participantRoles || [])
          .some((role) => role?.id === value.targetRole)) {
      fail(
        'S5_CHAIN_ONTOLOGY_TARGET',
        `${label} does not resolve a participant role on the mapping target association`,
      );
    }
    return;
  }
  if (value.slotType === 'relation') {
    exactKeys(
      value,
      ['slotType', 'targetRelation', ...('targetObjectType' in value ? ['targetObjectType'] : [])],
      label,
      'S5_CHAIN_MAPPING',
    );
    absoluteIri(value.targetRelation, `${label}.targetRelation`);
    const relation = ontologyState.semanticIndex.relations.get(value.targetRelation);
    if (!relation
        || typeof relation.definition.domain !== 'string'
        || !completedOntologyTypeIsA(
          mappingTargetType,
          relation.definition.domain,
          ontologyState,
        )) {
      fail(
        'S5_CHAIN_ONTOLOGY_TARGET',
        `${label}.targetRelation does not resolve with a compatible domain`,
      );
    }
    if ('targetObjectType' in value) {
      absoluteIri(value.targetObjectType, `${label}.targetObjectType`);
      if (!ontologyState.semanticIndex.types.has(value.targetObjectType)
          || typeof relation.definition.range !== 'string'
          || !completedOntologyTypeIsA(
            value.targetObjectType,
            relation.definition.range,
            ontologyState,
          )) {
        fail(
          'S5_CHAIN_ONTOLOGY_TARGET',
          `${label}.targetObjectType is incompatible with the relation range`,
        );
      }
    }
    return;
  }
  if (value.slotType === 'patternField') {
    exactKeys(
      value,
      ['slotType', 'targetField', 'targetPattern'],
      label,
      'S5_CHAIN_MAPPING',
    );
    completedMappingString(value.targetField, `${label}.targetField`);
    absoluteIri(value.targetPattern, `${label}.targetPattern`);
    const pattern = ontologyState.semanticIndex.patterns.get(value.targetPattern);
    if (!pattern
        || !completedOntologyPatternsForType(mappingTargetType, ontologyState)
          .has(value.targetPattern)
        || !completedPatternFieldNames(pattern).has(value.targetField)) {
      fail(
        'S5_CHAIN_ONTOLOGY_TARGET',
        `${label} does not resolve an injected field on a bound pattern`,
      );
    }
    return;
  }
  fail('S5_CHAIN_MAPPING', `${label}.slotType is not an M3 TargetSlot variant`);
}

function validateCompletedTimeAxis(
  value,
  aliases,
  schemaByDataset,
  label,
  transformationRefs,
  transformationInputNames,
  referencedMappingRefs,
) {
  exactKeys(
    value,
    ['from', ...('to' in value ? ['to'] : []), ...('closePolicy' in value ? ['closePolicy'] : [])],
    label,
    'S5_CHAIN_MAPPING',
  );
  validateCompletedValueBinding(
    value.from,
    aliases,
    schemaByDataset,
    `${label}.from`,
    transformationRefs,
    transformationInputNames,
    referencedMappingRefs,
  );
  if ('to' in value && value.to !== null) {
    validateCompletedValueBinding(
      value.to,
      aliases,
      schemaByDataset,
      `${label}.to`,
      transformationRefs,
      transformationInputNames,
      referencedMappingRefs,
    );
  }
  if ('closePolicy' in value
      && !['closePreviousVersion', 'explicitOnly'].includes(value.closePolicy)) {
    fail('S5_CHAIN_MAPPING', `${label}.closePolicy is invalid`);
  }
}

function validateCompletedTransformationType(value, label, depth = 0) {
  if (depth > 64 || !isPlainObject(value)) {
    fail('S5_CHAIN_TRANSFORMATION', `${label} must be a bounded closed TypeReference`);
  }
  if (value.typeKind === 'primitive') {
    exactKeys(value, ['primitiveType', 'typeKind'], label, 'S5_CHAIN_TRANSFORMATION');
    if (!['string', 'integer', 'decimal', 'boolean', 'instant', 'duration', 'uri']
      .includes(value.primitiveType)) {
      fail('S5_CHAIN_TRANSFORMATION', `${label}.primitiveType is outside M3`);
    }
    return;
  }
  if (value.typeKind === 'structured') {
    exactKeys(value, ['typeKind', 'typeRef'], label, 'S5_CHAIN_TRANSFORMATION');
    absoluteIri(value.typeRef, `${label}.typeRef`);
    return;
  }
  if (value.typeKind === 'list') {
    exactKeys(value, ['elementType', 'typeKind'], label, 'S5_CHAIN_TRANSFORMATION');
    validateCompletedTransformationType(value.elementType, `${label}.elementType`, depth + 1);
    return;
  }
  fail('S5_CHAIN_TRANSFORMATION', `${label}.typeKind is not an M3 TypeReference variant`);
}

const COMPLETED_TRANSFORMATION_SEMVER_RE =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

function validateCompletedTransformationTestValue(value, type, label, depth = 0) {
  if (depth > 64) {
    fail('S5_CHAIN_TRANSFORMATION', `${label} exceeds the bounded TypeReference depth`);
  }
  if (type.typeKind === 'list') {
    if (!Array.isArray(value)) {
      fail('S5_CHAIN_TRANSFORMATION', `${label} does not satisfy its list TypeReference`);
    }
    value.forEach((entry, index) => validateCompletedTransformationTestValue(
      entry,
      type.elementType,
      `${label}[${index}]`,
      depth + 1,
    ));
    return;
  }
  if (type.typeKind === 'structured') {
    if (!isPlainObject(value)) {
      fail('S5_CHAIN_TRANSFORMATION', `${label} does not satisfy its structured TypeReference`);
    }
    return;
  }
  const primitiveChecks = {
    boolean: typeof value === 'boolean',
    decimal: typeof value === 'number' && Number.isFinite(value),
    duration: typeof value === 'string'
      && /^-?P(?=.+)(?:[0-9]+Y)?(?:[0-9]+M)?(?:[0-9]+D)?(?:T(?=.+)(?:[0-9]+H)?(?:[0-9]+M)?(?:[0-9]+(?:\.[0-9]+)?S)?)?$/u.test(value),
    instant: typeof value === 'string' && INSTANT_RE.test(value),
    integer: Number.isSafeInteger(value),
    string: typeof value === 'string',
    uri: typeof value === 'string' && (() => {
      try {
        return new URL(value).protocol.length > 1;
      } catch {
        return false;
      }
    })(),
  };
  if (type.typeKind !== 'primitive' || primitiveChecks[type.primitiveType] !== true) {
    fail(
      'S5_CHAIN_TRANSFORMATION',
      `${label} does not satisfy primitive TypeReference ${type.primitiveType || '<unknown>'}`,
    );
  }
  if (type.primitiveType === 'instant') {
    try {
      instantEpoch(value, label);
    } catch {
      fail('S5_CHAIN_TRANSFORMATION', `${label} is not a real canonical instant`);
    }
  }
}

function validateCompletedTransformationImplementation(value, kind, label) {
  if (!isPlainObject(value)) {
    fail('S5_CHAIN_TRANSFORMATION', `${label} must be a closed implementation object`);
  }
  const fieldsByKind = {
    ExpressionTransformation: ['expression', 'language'],
    LookupTransformation: [
      'cacheSeconds', 'defaultValue', 'lookupKeyField', 'lookupTable',
      'lookupValueField', 'onMissingKey',
    ],
    MappingTransformation: ['mapping'],
    ScriptTransformation: ['entrypoint', 'runtime', 'scriptPath'],
  };
  const allowed = fieldsByKind[kind];
  const actual = Object.keys(value);
  if (actual.some((field) => !allowed.includes(field))) {
    fail('S5_CHAIN_TRANSFORMATION', `${label} contains fields for a different transformation kind`);
  }
  exactKeys(value, actual, label, 'S5_CHAIN_TRANSFORMATION');
  for (const field of [
    'defaultValue', 'entrypoint', 'expression', 'lookupKeyField',
    'lookupValueField', 'scriptPath',
  ]) {
    if (field in value) completedMappingString(value[field], `${label}.${field}`);
  }
  if ('lookupTable' in value) absoluteIri(value.lookupTable, `${label}.lookupTable`);
  if ('cacheSeconds' in value && !Number.isSafeInteger(value.cacheSeconds)) {
    fail('S5_CHAIN_TRANSFORMATION', `${label}.cacheSeconds must be a safe integer`);
  }
  if ('onMissingKey' in value && !['error', 'null', 'default'].includes(value.onMissingKey)) {
    fail('S5_CHAIN_TRANSFORMATION', `${label}.onMissingKey is outside M3`);
  }
  if ('language' in value && !['sql', 'jsonPath', 'jq', 'python'].includes(value.language)) {
    fail('S5_CHAIN_TRANSFORMATION', `${label}.language is outside M3`);
  }
  if ('runtime' in value && !['python', 'javascript', 'wasm'].includes(value.runtime)) {
    fail('S5_CHAIN_TRANSFORMATION', `${label}.runtime is outside M3`);
  }
  if ('mapping' in value) {
    if (!isPlainObject(value.mapping)) {
      fail('S5_CHAIN_TRANSFORMATION', `${label}.mapping must be a string map`);
    }
    for (const [key, mapped] of Object.entries(value.mapping)) {
      completedMappingString(key, `${label}.mapping key`);
      if (typeof mapped !== 'string') {
        fail('S5_CHAIN_TRANSFORMATION', `${label}.mapping.${key} must be a string`);
      }
    }
  }
}

function validateCompletedTransformationDefinition(
  value,
  expectedIri,
  expectedInputNames,
  closureEntry,
  executionBinding,
  valuationPolicyArtifacts,
  label,
) {
  exactKeys(
    value,
    [
      'definition', 'implementation', 'implementationDigest', 'inputs', 'iri',
      'kind', 'outputs', 'testCases', 'version',
    ],
    label,
    'S5_CHAIN_TRANSFORMATION',
  );
  if (value.iri !== expectedIri) {
    fail('S5_CHAIN_TRANSFORMATION', `${label}.iri identity drift`);
  }
  absoluteIri(value.iri, `${label}.iri`);
  completedMappingString(value.definition, `${label}.definition`);
  completedMappingString(value.version, `${label}.version`);
  if (!COMPLETED_TRANSFORMATION_SEMVER_RE.test(value.version)) {
    fail(
      'S5_CHAIN_TRANSFORMATION',
      `${label}.version must be canonical MAJOR.MINOR.PATCH without suffixes or leading zeroes`,
    );
  }
  if (![
    'LookupTransformation', 'MappingTransformation',
    'ExpressionTransformation', 'ScriptTransformation',
  ].includes(value.kind)) {
    fail('S5_CHAIN_TRANSFORMATION', `${label}.kind is outside M3`);
  }
  rawDigestBytes(value.implementationDigest, `${label}.implementationDigest`);
  if (value.implementationDigest !== closureEntry.implementationDigest) {
    fail(
      'S5_CHAIN_TRANSFORMATION',
      `${label}.implementationDigest does not join the executable transformation closure`,
    );
  }
  if (!isPlainObject(value.inputs)) {
    fail('S5_CHAIN_TRANSFORMATION', `${label}.inputs must be a named TypeReference map`);
  }
  const inputNames = Object.keys(value.inputs).sort(utf8Compare);
  if (canonicalJcs(inputNames) !== canonicalJcs(expectedInputNames)) {
    fail(
      'S5_CHAIN_TRANSFORMATION',
      `${label}.inputs do not equal the mapping binding's exact named input inventory`,
    );
  }
  for (const [name, type] of Object.entries(value.inputs)) {
    completedMappingString(name, `${label}.inputs key`);
    validateCompletedTransformationType(type, `${label}.inputs.${name}`);
  }
  validateCompletedTransformationType(value.outputs, `${label}.outputs`);
  if (!Array.isArray(value.testCases) || value.testCases.length === 0) {
    fail('S5_CHAIN_TRANSFORMATION', `${label}.testCases must be non-empty`);
  }
  for (const [index, testCase] of value.testCases.entries()) {
    const caseLabel = `${label}.testCases[${index}]`;
    exactKeys(
      testCase,
      ['expectedOutput', 'input', ...('description' in testCase ? ['description'] : [])],
      caseLabel,
      'S5_CHAIN_TRANSFORMATION',
    );
    if ('description' in testCase) {
      completedMappingString(testCase.description, `${caseLabel}.description`);
    }
    if (!isPlainObject(testCase.input)
        || canonicalJcs(Object.keys(testCase.input).sort(utf8Compare))
          !== canonicalJcs(inputNames)) {
      fail(
        'S5_CHAIN_TRANSFORMATION',
        `${caseLabel}.input must exactly cover the declared named inputs`,
      );
    }
    for (const name of inputNames) {
      validateCompletedTransformationTestValue(
        testCase.input[name],
        value.inputs[name],
        `${caseLabel}.input.${name}`,
      );
    }
    validateCompletedTransformationTestValue(
      testCase.expectedOutput,
      value.outputs,
      `${caseLabel}.expectedOutput`,
    );
  }
  validateCompletedTransformationImplementation(
    value.implementation,
    value.kind,
    `${label}.implementation`,
  );
  if (value.kind !== 'ScriptTransformation'
      || executionBinding.capability.entrypointRef.kind !== 'path'
      || value.implementation.scriptPath
        !== executionBinding.capability.entrypointRef.path
      || value.implementation.entrypoint
        !== executionBinding.discovery.transformationEntrypoint
      || value.implementation.runtime !== 'javascript') {
    fail(
      'S5_CHAIN_TRANSFORMATION',
      `${label}.implementation does not join the locked transformation entrypoint`,
    );
  }
  for (const [index, testCase] of value.testCases.entries()) {
    const caseLabel = `${label}.testCases[${index}]`;
    const executionOptions = value.iri === TRANSFORMATION_REFS.directUnitPriceTimesQuantity
      ? { valuationPolicyArtifacts }
      : {};
    let actualOutput;
    try {
      actualOutput = executeCanonicalTransformation(
        value.iri,
        testCase.input,
        executionOptions,
      );
    } catch (cause) {
      fail(
        'S5_CHAIN_TRANSFORMATION',
        `${caseLabel} failed locked execution: ${cause.message}`,
      );
    }
    validateCompletedTransformationTestValue(
      actualOutput,
      value.outputs,
      `${caseLabel}.actualOutput`,
    );
    if (canonicalJcs(actualOutput) !== canonicalJcs(testCase.expectedOutput)) {
      fail(
        'S5_CHAIN_TRANSFORMATION',
        `${caseLabel}.expectedOutput differs from locked execution`,
      );
    }
  }
}

function validateCompletedTransformationToolBindings(
  transformations,
  sourceDatasets,
  sourceSchemaState,
  toolLockState,
  resolver,
  label,
) {
  const capability = toolLockState.materializer.capabilities.find(
    (entry) => entry.capabilityId === 's5-canonical-materialization',
  );
  if (!capability) {
    fail('S5_CHAIN_TOOL_LOCK', 's5-canonical-materialization capability missing');
  }
  const discoveryArtifact = resolver.readJson(
    capability.discoveryContractRef,
    `${label}.lockedDiscoveryContract`,
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  const discovery = discoveryArtifact.value;
  if (discoveryArtifact.digest !== capability.discoveryContractDigest
      || !isPlainObject(discovery)
      || typeof discovery.entrypoint !== 'string'
      || discovery.transformationEntrypoint !== 'executeCanonicalTransformation'
      || !Array.isArray(discovery.transformationRefs)) {
    fail('S5_CHAIN_TOOL_LOCK', 'materializer discovery contract is incomplete');
  }
  if (transformations.length === 0) return { capability, discovery };
  const datasets = [...sourceDatasets].sort(utf8Compare);
  if (datasets.length !== 1) {
    fail(
      'S5_CHAIN_TRANSFORMATION',
      `${label} cannot bind a singular inputContract to a multi-dataset transformation`,
    );
  }
  const sourceSchema = sourceSchemaState.byDataset.get(datasets[0]);
  if (!sourceSchema) {
    fail('S5_CHAIN_SOURCE_SCHEMA', `${label} source-schema contract is absent`);
  }
  const declaredTransformationRefs = [...discovery.transformationRefs].sort(utf8Compare);
  for (const [index, transformation] of transformations.entries()) {
    if (!declaredTransformationRefs.includes(transformation.transformationRef)
        || transformation.capabilityId !== capability.capabilityId
        || !refsEqual(transformation.capabilityRef, capability.capabilityRef)
        || transformation.capabilityDigest !== capability.capabilityDigest
        || !refsEqual(transformation.implementationRef, capability.entrypointRef)
        || transformation.implementationDigest !== capability.entrypointDigest
        || !refsEqual(transformation.runtimeRef, toolLockState.materializer.runtimeRef)
        || transformation.runtimeDigest !== toolLockState.materializer.runtimeDigest
        || !refsEqual(transformation.inputContractRef, sourceSchema.artifactRef)
        || transformation.inputContractDigest !== sourceSchema.digest
        || !refsEqual(transformation.outputContractRef, capability.outputContractRef)
        || transformation.outputContractDigest !== capability.outputContractDigest) {
      fail(
        'S5_CHAIN_TRANSFORMATION',
        `${label}.transformations[${index}] does not join the locked materializer/runtime/contracts/discovery inventory`,
      );
    }
  }
  return { capability, discovery };
}

function validateCompletedSemanticMapping(
  value,
  expectedIri,
  runDatasetIris,
  schemaByDataset,
  ontologyState,
  targetOntologyModule,
  label,
) {
  const optionalTopLevel = [
    'effectiveDate', 'expirationDate', 'priority', 'validationRules',
  ].filter((field) => field in value);
  exactKeys(
    value,
    [
      'identity', 'iri', 'label', 'mappingType', 'provenance', 'slotMappings',
      'source', 'targetType', 'temporal', ...optionalTopLevel,
    ],
    label,
    'S5_CHAIN_MAPPING',
  );
  if (value.iri !== expectedIri) fail('S5_CHAIN_MAPPING', `${label}.iri identity drift`);
  absoluteIri(value.iri, `${label}.iri`);
  absoluteIri(value.targetType, `${label}.targetType`);
  const targetType = ontologyState.semanticIndex.types.get(value.targetType);
  if (!targetType
      || !['objectType', 'associationType'].includes(targetType.kind)
      || targetType.moduleIri !== targetOntologyModule) {
    fail(
      'S5_CHAIN_ONTOLOGY_TARGET',
      `${label}.targetType is not owned by the plan target ontology module`,
    );
  }
  completedMappingString(value.label, `${label}.label`);
  if (![
    'directTable', 'joinedTables', 'aggregation',
    'transformation', 'view', 'denormalized',
  ].includes(value.mappingType)) {
    fail('S5_CHAIN_MAPPING', `${label}.mappingType is outside M3`);
  }

  exactKeys(
    value.source,
    ['datasets', ...('rowSet' in value.source ? ['rowSet'] : [])],
    `${label}.source`,
    'S5_CHAIN_MAPPING',
  );
  if (!Array.isArray(value.source.datasets) || value.source.datasets.length === 0) {
    fail('S5_CHAIN_MAPPING', `${label}.source.datasets must be non-empty`);
  }
  const aliases = new Map();
  const sourceDatasets = new Set();
  for (const [index, source] of value.source.datasets.entries()) {
    const sourceLabel = `${label}.source.datasets[${index}]`;
    exactKeys(source, ['alias', 'dataset'], sourceLabel, 'S5_CHAIN_MAPPING');
    completedMappingString(source.alias, `${sourceLabel}.alias`);
    absoluteIri(source.dataset, `${sourceLabel}.dataset`);
    if (aliases.has(source.alias)) {
      fail('S5_CHAIN_MAPPING', `${label}.source.datasets repeats an alias`);
    }
    if (!runDatasetIris.has(source.dataset)) {
      fail('S5_CHAIN_MAPPING', `${sourceLabel}.dataset is outside completedRun.inputDatasets`);
    }
    aliases.set(source.alias, source.dataset);
    sourceDatasets.add(source.dataset);
  }
  if ('rowSet' in value.source) {
    validateCompletedRowSet(
      value.source.rowSet,
      aliases,
      schemaByDataset,
      `${label}.source.rowSet`,
    );
  }

  const transformationRefs = new Set();
  const transformationInputNames = new Map();
  const referencedMappingRefs = new Set();
  exactKeys(
    value.identity,
    ['contractRef', 'logicalKeyBindings', 'versionKeyBindings'],
    `${label}.identity`,
    'S5_CHAIN_MAPPING',
  );
  absoluteIri(value.identity.contractRef, `${label}.identity.contractRef`);
  for (const field of ['logicalKeyBindings', 'versionKeyBindings']) {
    const bindings = value.identity[field];
    if (!isPlainObject(bindings) || Object.keys(bindings).length === 0) {
      fail('S5_CHAIN_MAPPING', `${label}.identity.${field} must be non-empty`);
    }
    for (const [name, bindingValue] of Object.entries(bindings)) {
      completedMappingString(name, `${label}.identity.${field} key`);
      validateCompletedValueBinding(
        bindingValue,
        aliases,
        schemaByDataset,
        `${label}.identity.${field}.${name}`,
        transformationRefs,
        transformationInputNames,
        referencedMappingRefs,
      );
    }
  }

  if (!Array.isArray(value.slotMappings) || value.slotMappings.length === 0) {
    fail('S5_CHAIN_MAPPING', `${label}.slotMappings must be non-empty`);
  }
  for (const [index, slot] of value.slotMappings.entries()) {
    const slotLabel = `${label}.slotMappings[${index}]`;
    exactKeys(slot, ['target', 'value'], slotLabel, 'S5_CHAIN_MAPPING');
    validateCompletedTargetSlot(
      slot.target,
      value.targetType,
      ontologyState,
      `${slotLabel}.target`,
    );
    validateCompletedValueBinding(
      slot.value,
      aliases,
      schemaByDataset,
      `${slotLabel}.value`,
      transformationRefs,
      transformationInputNames,
      referencedMappingRefs,
    );
  }

  exactKeys(
    value.temporal,
    ['availabilityTime', 'knowledgeTime', 'patternRef', 'validTime'],
    `${label}.temporal`,
    'S5_CHAIN_MAPPING',
  );
  absoluteIri(value.temporal.patternRef, `${label}.temporal.patternRef`);
  if (value.temporal.patternRef
        !== 'https://axiolune.ai/ontology/meta/patterns/TemporalFact'
      || !ontologyState.semanticIndex.patterns.has(value.temporal.patternRef)
      || !completedOntologyPatternsForType(value.targetType, ontologyState)
        .has(value.temporal.patternRef)) {
    fail(
      'S5_CHAIN_ONTOLOGY_TARGET',
      `${label}.temporal.patternRef is not a temporal pattern bound to targetType`,
    );
  }
  for (const [field, axis] of [
    ['availabilityTime', value.temporal.availabilityTime],
    ['knowledgeTime', value.temporal.knowledgeTime],
    ['validTime', value.temporal.validTime],
  ]) {
    validateCompletedTimeAxis(
      axis,
      aliases,
      schemaByDataset,
      `${label}.temporal.${field}`,
      transformationRefs,
      transformationInputNames,
      referencedMappingRefs,
    );
  }

  const provenanceFields = [
    'acquisitionTime', 'confidence', 'responsibleAgent', 'sourceSystem',
  ].filter((field) => field in value.provenance);
  if (provenanceFields.length === 0) {
    fail('S5_CHAIN_MAPPING', `${label}.provenance must be non-empty`);
  }
  exactKeys(value.provenance, provenanceFields, `${label}.provenance`, 'S5_CHAIN_MAPPING');
  for (const field of provenanceFields) {
    validateCompletedValueBinding(
      value.provenance[field],
      aliases,
      schemaByDataset,
      `${label}.provenance.${field}`,
      transformationRefs,
      transformationInputNames,
      referencedMappingRefs,
    );
  }

  if ('priority' in value && !Number.isSafeInteger(value.priority)) {
    fail('S5_CHAIN_MAPPING', `${label}.priority must be a safe integer`);
  }
  for (const field of ['effectiveDate', 'expirationDate']) {
    if (field in value) instantEpoch(value[field], `${label}.${field}`);
  }
  if ('validationRules' in value) {
    if (!Array.isArray(value.validationRules)) {
      fail('S5_CHAIN_MAPPING', `${label}.validationRules must be a list`);
    }
    for (const [index, rule] of value.validationRules.entries()) {
      const ruleLabel = `${label}.validationRules[${index}]`;
      exactKeys(
        rule,
        ['expression', 'failureAction', 'id', ...('severity' in rule ? ['severity'] : []), 'type'],
        ruleLabel,
        'S5_CHAIN_MAPPING',
      );
      for (const field of ['expression', 'id']) {
        completedMappingString(rule[field], `${ruleLabel}.${field}`);
      }
      if (!['required', 'format', 'range', 'uniqueness', 'referentialIntegrity', 'custom']
        .includes(rule.type)
          || !['reject', 'quarantine', 'accept-with-warning'].includes(rule.failureAction)
          || ('severity' in rule && !['error', 'warning', 'info'].includes(rule.severity))) {
        fail('S5_CHAIN_MAPPING', `${ruleLabel} enum value drift`);
      }
    }
  }

  return {
    referencedMappingRefs,
    sourceDatasets,
    transformationInputNames,
    transformationRefs,
  };
}

function validateCompletedMappingActivation(mapping, run, label) {
  const assertionTime = instantEpoch(run.assertionTime, 'completedRun.assertionTime');
  const effectiveDate = 'effectiveDate' in mapping
    ? instantEpoch(mapping.effectiveDate, `${label}.effectiveDate`)
    : Number.NEGATIVE_INFINITY;
  const expirationDate = 'expirationDate' in mapping
    ? instantEpoch(mapping.expirationDate, `${label}.expirationDate`)
    : Number.POSITIVE_INFINITY;
  if (effectiveDate >= expirationDate) {
    fail(
      'S5_CHAIN_MAPPING_ACTIVATION',
      `${label} effectiveDate must be strictly before expirationDate`,
    );
  }
  if (effectiveDate > assertionTime || expirationDate <= assertionTime) {
    fail(
      'S5_CHAIN_MAPPING_ACTIVATION',
      `${label} is not active at completedRun.assertionTime`,
    );
  }
}

function completedMappingFilters(mapping) {
  return Array.isArray(mapping.source?.rowSet?.filters)
    ? mapping.source.rowSet.filters
    : [];
}

function completedFilterDatasetField(mapping, filter) {
  const dataset = mapping.source.datasets.find((entry) => entry.alias === filter.dataset)?.dataset;
  return dataset === undefined ? null : `${dataset}\0${filter.field}`;
}

function completedFilterValueSet(filter) {
  if (filter.operator === '=') return [filter.value];
  if (filter.operator === 'IN' && Array.isArray(filter.value)) return filter.value;
  return null;
}

function completedMappingsProvablyDisjoint(left, right) {
  const leftFilters = completedMappingFilters(left);
  const rightFilters = completedMappingFilters(right);
  for (const leftFilter of leftFilters) {
    const leftKey = completedFilterDatasetField(left, leftFilter);
    const leftValues = completedFilterValueSet(leftFilter);
    if (leftKey === null || leftValues === null) continue;
    const leftSet = new Set(leftValues.map((value) => canonicalJcs(value)));
    for (const rightFilter of rightFilters) {
      const rightValues = completedFilterValueSet(rightFilter);
      if (leftKey !== completedFilterDatasetField(right, rightFilter)
          || rightValues === null) continue;
      if (rightValues.every((value) => !leftSet.has(canonicalJcs(value)))) return true;
    }
  }
  return false;
}

function validateCompletedMappingConflicts(mappings) {
  for (const mapping of mappings) {
    const targets = new Set();
    for (const [index, slot] of mapping.slotMappings.entries()) {
      const targetKey = canonicalJcs(slot.target);
      if (targets.has(targetKey)) {
        fail(
          'S5_CHAIN_MAPPING_CONFLICT',
          `mapping(${mapping.iri}).slotMappings[${index}] repeats a target slot; completed execution has no provable per-slot resolution`,
        );
      }
      targets.add(targetKey);
    }
  }
  for (let leftIndex = 0; leftIndex < mappings.length; leftIndex += 1) {
    const left = mappings[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < mappings.length; rightIndex += 1) {
      const right = mappings[rightIndex];
      if (left.targetType !== right.targetType) continue;
      const leftPriority = 'priority' in left ? left.priority : 0;
      const rightPriority = 'priority' in right ? right.priority : 0;
      if (leftPriority !== rightPriority || completedMappingsProvablyDisjoint(left, right)) {
        continue;
      }
      fail(
        'S5_CHAIN_MAPPING_CONFLICT',
        `mappings ${left.iri} and ${right.iri} target ${left.targetType} with equal priority and no statically provable disjoint filter`,
      );
    }
  }
}

const IDENTITY_COMPILATION_FIELDS = Object.freeze([
  'concreteTargetTypes', 'contracts', 'derivations', 'identityTermRegistry',
  'identityTermRegistryDigest', 'identityTermRegistryRef', 'mappings',
  'normalizationRules', 'profileRef',
]);

function validateIdentityExternalArtifact(ref, digest, resolver, label) {
  const artifact = resolver.read(ref, label, ['sourceTree']);
  if (artifact.digest !== digest) {
    fail('S5_CHAIN_IDENTITY_CLOSURE', `${label} raw bytes/digest drift`);
  }
  return artifact;
}

function validateIdentityCompilationExternalClosure(compilation, resolver) {
  const registryArtifact = resolver.readJson(
    compilation.identityTermRegistryRef,
    'identityCompilation.identityTermRegistryRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  if (canonicalJcs(registryArtifact.value) !== canonicalJcs(compilation.identityTermRegistry)
      || taggedJcsDigest(IDENTITY_TAGS.termRegistry, registryArtifact.value)
        !== compilation.identityTermRegistryDigest) {
    fail(
      'S5_CHAIN_IDENTITY_CLOSURE',
      'identity term registry bytes/embedded value/tagged digest do not close',
    );
  }
  for (const [index, rule] of compilation.normalizationRules.entries()) {
    for (const [refField, digestField] of [
      ['implementationRef', 'implementationDigest'],
      ['specificationRef', 'specificationDigest'],
      ['testVectorsRef', 'testVectorsDigest'],
    ]) {
      validateIdentityExternalArtifact(
        rule[refField],
        rule[digestField],
        resolver,
        `identityCompilation.normalizationRules[${index}].${refField}`,
      );
    }
  }
  for (const [index, derivation] of compilation.derivations.entries()) {
    for (const [refField, digestField] of [
      ['expressionRef', 'expressionDigest'],
      ['implementationRef', 'implementationDigest'],
      ['testVectorsRef', 'testVectorsDigest'],
    ]) {
      validateIdentityExternalArtifact(
        derivation[refField],
        derivation[digestField],
        resolver,
        `identityCompilation.derivations[${index}].${refField}`,
      );
    }
  }
  for (const [index, row] of compilation.identityTermRegistry.controlledSets.entries()) {
    const definition = row.definition;
    const evidence = validateIdentityExternalArtifact(
      { iri: definition.sourceEvidenceRef, kind: 'iri' },
      definition.sourceEvidenceDigest,
      resolver,
      `identityCompilation.identityTermRegistry.controlledSets[${index}].sourceEvidenceRef`,
    );
    const locatorValidation = validateSourceLocator(definition.sourceLocator, {
      at: `identityCompilation.identityTermRegistry.controlledSets[${index}].sourceLocator`,
      selectedBytes: evidence.bytes,
    });
    if (!locatorValidation.ok) {
      fail('S5_CHAIN_IDENTITY_CLOSURE', locatorValidation.errors.join('; '));
    }
    validateIdentityExternalArtifact(
      definition.sourceLocator.extractorProfileRef,
      definition.sourceLocator.extractorProfileDigest,
      resolver,
      `identityCompilation.identityTermRegistry.controlledSets[${index}].extractorProfileRef`,
    );
  }
}

function validateIdentitySemanticValue(value, ontologyState, label) {
  if (value.valueKind === 'derivation') return;
  if (value.valueKind === 'attributeUse') {
    const containing = ontologyState.semanticIndex.types.get(value.containingType);
    if (!containing
        || !ontologyState.semanticIndex.attributes.has(value.attributeRef)
        || !completedOntologyAttributesForType(value.containingType, ontologyState)
          .has(value.attributeRef)) {
      fail('S5_CHAIN_IDENTITY_CLOSURE', `${label} does not resolve an ontology attribute use`);
    }
    return;
  }
  if (value.valueKind === 'participantRole') {
    const association = ontologyState.semanticIndex.types.get(value.containingAssociation);
    const role = association?.definition?.participantRoles?.find(
      (candidate) => candidate?.id === value.roleId,
    );
    if (!association
        || association.kind !== 'associationType'
        || !role
        || typeof value.effectivePredicate !== 'string') {
      fail('S5_CHAIN_IDENTITY_CLOSURE', `${label} does not resolve a participant role`);
    }
    return;
  }
  if (value.valueKind === 'relationUse') {
    const relation = ontologyState.semanticIndex.relations.get(value.relationRef);
    if (!relation
        || !ontologyState.semanticIndex.types.has(value.subjectType)
        || !ontologyState.semanticIndex.types.has(value.objectType)
        || !completedOntologyTypeIsA(
          value.subjectType,
          relation.definition.domain,
          ontologyState,
        )
        || !completedOntologyTypeIsA(
          value.objectType,
          relation.definition.range,
          ontologyState,
        )) {
      fail('S5_CHAIN_IDENTITY_CLOSURE', `${label} does not resolve a relation use`);
    }
    return;
  }
  if (value.valueKind === 'patternField') {
    const pattern = ontologyState.semanticIndex.patterns.get(value.patternRef);
    if (!ontologyState.semanticIndex.types.has(value.containingType)
        || !pattern
        || !completedOntologyPatternsForType(value.containingType, ontologyState)
          .has(value.patternRef)
        || !completedPatternFieldNames(pattern).has(value.fieldRef)) {
      fail('S5_CHAIN_IDENTITY_CLOSURE', `${label} does not resolve a bound pattern field`);
    }
  }
}

function discoverCompletedIdentityCompilation(
  resolver,
  mappings,
  ontologyState,
  completedControlInputClosure = null,
) {
  const orderedMappings = [...mappings].sort((left, right) => utf8Compare(left.iri, right.iri));
  const concreteTargetTypes = [...new Set(orderedMappings.map((mapping) => mapping.targetType))]
    .sort(utf8Compare);
  if (completedControlInputClosure !== null) {
    const compilation = completedControlInputClosure.parsed.identityCompilationArtifact.value;
    const compilationMappings = [...compilation.mappings]
      .sort((left, right) => utf8Compare(left.iri, right.iri));
    const compilationByIri = new Map(compilationMappings.map((mapping) => [mapping.iri, mapping]));
    if (orderedMappings.some((mapping) => (
      !compilationByIri.has(mapping.iri)
      || canonicalJcs(compilationByIri.get(mapping.iri)) !== canonicalJcs(mapping)
    ))) {
      fail(
        'S5_CHAIN_IDENTITY_CLOSURE',
        'completed run mapping bytes are not an exact subset of the authenticated batch identity compilation',
      );
    }
    const visibleMappingRefsByMapping = Object.fromEntries(compilationMappings.map((mapping) => [
      mapping.iri,
      compilationMappings.map((candidate) => candidate.iri),
    ]));
    const validation = validateCompilationInput(compilation, { visibleMappingRefsByMapping });
    if (!validation.ok) {
      fail(
        'S5_CHAIN_IDENTITY_CLOSURE',
        validation.errors.map((entry) => `${entry.code} ${entry.path}: ${entry.message}`).join('; '),
      );
    }
    validateIdentityCompilationExternalClosure(compilation, resolver);
    validateCompletedIdentitySemanticClosure(compilation, ontologyState);
    return {
      compilation,
      indexes: validation.indexes,
    };
  }
  const candidates = [];
  for (const artifact of resolver.artifacts) {
    if (artifact.ref.kind !== 'path'
        || artifact.ref.root !== 'sourceTree'
        || (artifact.mediaType !== 'application/json' && !artifact.mediaType.endsWith('+json'))) {
      continue;
    }
    const inspected = inspectBundleJsonArtifact(artifact);
    if (!isPlainObject(inspected)
        || canonicalJcs(Object.keys(inspected).sort(utf8Compare))
          !== canonicalJcs([...IDENTITY_COMPILATION_FIELDS].sort(utf8Compare))) {
      continue;
    }
    const parsed = parseBundleJsonBytes(
      artifact.bytes,
      `identityCompilation@${refSortKey(artifact.ref)}`,
      true,
    ).value;
    const candidateMappings = Array.isArray(parsed.mappings)
      ? [...parsed.mappings].sort((left, right) => utf8Compare(left?.iri || '', right?.iri || ''))
      : [];
    const candidateTargets = Array.isArray(parsed.concreteTargetTypes)
      ? [...parsed.concreteTargetTypes].sort(utf8Compare)
      : [];
    if (parsed.profileRef === PROFILE_REF
        && canonicalJcs(candidateMappings) === canonicalJcs(orderedMappings)
        && canonicalJcs(candidateTargets) === canonicalJcs(concreteTargetTypes)) {
      candidates.push({ artifact, value: parsed });
    }
  }
  if (candidates.length !== 1) {
    fail(
      'S5_CHAIN_IDENTITY_CLOSURE',
      `actual mapping closure must resolve exactly one canonical identity compilation; found ${candidates.length}`,
    );
  }
  const selected = candidates[0];
  const visibleMappingRefsByMapping = Object.fromEntries(orderedMappings.map((mapping) => [
    mapping.iri,
    orderedMappings.map((candidate) => candidate.iri),
  ]));
  const validation = validateCompilationInput(selected.value, { visibleMappingRefsByMapping });
  if (!validation.ok) {
    fail(
      'S5_CHAIN_IDENTITY_CLOSURE',
      validation.errors.map((entry) => `${entry.code} ${entry.path}: ${entry.message}`).join('; '),
    );
  }
  validateIdentityCompilationExternalClosure(selected.value, resolver);
  validateCompletedIdentitySemanticClosure(selected.value, ontologyState);
  resolver.mark(selected.artifact.ref);
  return {
    compilation: selected.value,
    indexes: validation.indexes,
  };
}

function validateCompletedIdentitySemanticClosure(compilation, ontologyState) {
  for (const [index, contract] of compilation.contracts.entries()) {
    if (!ontologyState.semanticIndex.types.has(contract.targetType)) {
      fail(
        'S5_CHAIN_IDENTITY_CLOSURE',
        `identityCompilation.contracts[${index}].targetType does not resolve`,
      );
    }
    for (const [listName, components] of [
      ['logicalComponents', contract.logicalComponents],
      ['versionComponents', contract.versionComponents],
    ]) {
      components.forEach((component, componentIndex) => validateIdentitySemanticValue(
        component.semanticValue,
        ontologyState,
        `identityCompilation.contracts[${index}].${listName}[${componentIndex}].semanticValue`,
      ));
    }
  }
  for (const [index, derivation] of compilation.derivations.entries()) {
    derivation.inputSemanticValues.forEach((semanticValue, semanticValueIndex) => (
      validateIdentitySemanticValue(
        semanticValue,
        ontologyState,
        `identityCompilation.derivations[${index}].inputSemanticValues[${semanticValueIndex}]`,
      )
    ));
  }
}

function completedReferenceIdentityNames(contract, mode) {
  const logical = contract.logicalComponents.map((component) => component.name);
  return mode === 'logical'
    ? logical
    : [...logical, ...contract.versionComponents.map((component) => component.name)];
}

function validateCompletedReferenceIdentityGraph(mappings, identityState) {
  const mappingByRef = new Map(mappings.map((mapping) => [mapping.iri, mapping]));
  const edges = new Map(mappings.map((mapping) => [mapping.iri, new Set()]));
  function inspect(node, ownerMappingRef, label) {
    if (Array.isArray(node)) {
      node.forEach((child, index) => inspect(child, ownerMappingRef, `${label}[${index}]`));
      return;
    }
    if (!isPlainObject(node)) return;
    if (node.bindingType === 'referenceIdentity') {
      const target = mappingByRef.get(node.targetMappingRef);
      const contract = target && identityState.indexes.contracts.byTarget.get(target.targetType);
      if (!target || !contract) {
        fail('S5_CHAIN_IDENTITY_CLOSURE', `${label}.targetMappingRef does not resolve`);
      }
      const expectedNames = completedReferenceIdentityNames(contract, node.referenceMode);
      const actualNames = isPlainObject(node.keyBindings)
        ? Object.keys(node.keyBindings).sort(utf8Compare)
        : [];
      if (canonicalJcs(actualNames)
          !== canonicalJcs([...expectedNames].sort(utf8Compare))) {
        fail(
          'S5_CHAIN_IDENTITY_CLOSURE',
          `${label}.keyBindings do not exactly cover the target identity contract`,
        );
      }
      edges.get(ownerMappingRef).add(node.targetMappingRef);
    }
    Object.entries(node).forEach(([key, child]) => (
      inspect(child, ownerMappingRef, `${label}.${key}`)
    ));
  }
  mappings.forEach((mapping) => inspect(mapping, mapping.iri, `mapping(${mapping.iri})`));
  const visiting = new Set();
  const visited = new Set();
  function visit(mappingRef, stack) {
    if (visiting.has(mappingRef)) {
      fail(
        'S5_CHAIN_IDENTITY_CLOSURE',
        `referenceIdentity dependency cycle: ${[...stack, mappingRef].join(' -> ')}`,
      );
    }
    if (visited.has(mappingRef)) return;
    visiting.add(mappingRef);
    for (const target of edges.get(mappingRef) || []) visit(target, [...stack, mappingRef]);
    visiting.delete(mappingRef);
    visited.add(mappingRef);
  }
  mappings.forEach((mapping) => visit(mapping.iri, []));
}

function validateCompletedRunSemanticClosure(run, buildInputs, resolver, context) {
  const ontology = resolver.readJson(
    run.ontologyClosureRef,
    'completedRun.ontologyClosureRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  if (taggedJcsDigest('axiolune-ontology-closure-v1\0', ontology.value)
      !== run.ontologyClosureDigest) {
    fail('S5_CHAIN_ONTOLOGY_CLOSURE', 'completed run ontology closure digest drift');
  }
  const ontologyState = validateActualOntologyClosure(ontology.value, resolver);

  const references = resolver.readJson(
    run.referenceLockRef,
    'completedRun.referenceLockRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  if (taggedJcsDigest('axiolune-reference-closure-v1\0', references.value)
      !== run.referenceLockDigest) {
    fail('S5_CHAIN_REFERENCE_CLOSURE', 'completed run reference closure digest drift');
  }
  validateBundledReferenceClosure(references.value, resolver);

  const sourceSchemaState = validateCompletedSourceSchemaBindings(run, buildInputs, resolver);
  const materializationPlan = findTaggedJcsArtifactByIri(
    resolver,
    run.planRef,
    'axiolune-materialization-plan-v1\0',
    run.planSourceDigest,
    'materialization plan',
  );
  validateCompletedMaterializationPlan(
    materializationPlan.value,
    run,
    ontologyState,
    [...sourceSchemaState.byDataset.keys()].sort(utf8Compare),
    'materialization plan',
  );

  const runDatasetIris = new Set(run.inputDatasets.map((entry) => entry.dataset));
  const mappingIris = new Set(run.mappingClosure.map((entry) => entry.mappingRef));
  const actualMappings = [];
  const mappingTargets = [];
  const usedDatasetIris = new Set();
  const referencedMappingIris = new Set();
  for (const [index, entry] of run.mappingClosure.entries()) {
    const mappingLabel = `mappingClosure[${index}] mapping`;
    const mapping = findTaggedJcsArtifactByIri(
      resolver,
      entry.mappingRef,
      'axiolune-semantic-mapping-v1\0',
      entry.mappingSourceDigest,
      mappingLabel,
    );
    const mappingState = validateCompletedSemanticMapping(
      mapping.value,
      entry.mappingRef,
      runDatasetIris,
      sourceSchemaState.byDataset,
      ontologyState,
      materializationPlan.value.targetOntologyModule,
      mappingLabel,
    );
    validateCompletedMappingActivation(mapping.value, run, mappingLabel);
    actualMappings.push(mapping.value);
    mappingTargets.push({
      mappingRef: mapping.value.iri,
      mappingSourceDigest: taggedJcsDigest(
        'axiolune-semantic-mapping-v1\0',
        mapping.value,
      ),
      targetType: mapping.value.targetType,
    });
    mappingState.sourceDatasets.forEach((iri) => usedDatasetIris.add(iri));
    mappingState.referencedMappingRefs.forEach((iri) => referencedMappingIris.add(iri));
    const transformation = resolver.readJson(
      entry.transformationClosureRef,
      `mappingClosure[${index}].transformationClosureRef`,
      { allowedRoots: ['sourceTree'], exactJcs: true },
    );
    if (taggedJcsDigest('axiolune-transformation-closure-v1\0', transformation.value)
        !== entry.transformationClosureDigest
        || transformation.value.mappingRef !== entry.mappingRef) {
      fail('S5_CHAIN_MAPPING', `mappingClosure[${index}] transformation closure drift`);
    }
    const closureTransformations = validateTransformationClosure(
      transformation.value,
      [...mappingState.transformationRefs].sort(utf8Compare),
      resolver,
      `mappingClosure[${index}].transformationClosure`,
    );
    const transformationExecutionBinding = validateCompletedTransformationToolBindings(
      closureTransformations,
      mappingState.sourceDatasets,
      sourceSchemaState,
      context.toolLockState,
      resolver,
      `mappingClosure[${index}].transformationClosure`,
    );
    for (const transformationRef of mappingState.transformationRefs) {
      const closureEntry = closureTransformations.find((candidate) => (
        candidate.transformationRef === transformationRef
      ));
      if (!closureEntry) {
          fail('S5_CHAIN_TRANSFORMATION', `${transformationRef} is absent from its executable closure`);
      }
      const definitionArtifact = resolver.readJson(
        closureEntry.definitionRef,
        `mappingClosure[${index}] transformation definition`,
        { allowedRoots: ['sourceTree'], exactJcs: true },
      );
      if (definitionArtifact.digest !== closureEntry.definitionDigest) {
        fail(
          'S5_CHAIN_TRANSFORMATION',
          `${transformationRef} definition bytes differ from the executable closure digest`,
        );
      }
      validateCompletedTransformationDefinition(
        definitionArtifact.value,
        transformationRef,
        mappingState.transformationInputNames.get(transformationRef),
        closureEntry,
        transformationExecutionBinding,
        context.completedControlInputClosure?.parsed.supportEvidence
          .valuationPolicyArtifacts || null,
        `mappingClosure[${index}] transformation definition`,
      );
    }
  }
  const expectedMappingDatasetIris = [...runDatasetIris].filter(
    (datasetIri) => !sourceSchemaState.auxiliaryDatasetIris.has(datasetIri),
  ).sort(utf8Compare);
  if (canonicalJcs([...usedDatasetIris].sort(utf8Compare))
      !== canonicalJcs(expectedMappingDatasetIris)) {
    fail(
      'S5_CHAIN_MAPPING',
      'semantic mapping source dataset union does not equal the completed run primary source datasets',
    );
  }
  validateCompletedMappingConflicts(actualMappings);
  const identityState = discoverCompletedIdentityCompilation(
    resolver,
    actualMappings,
    ontologyState,
    context.completedControlInputClosure || null,
  );
  const allowedIdentityMappingIris = new Set(
    identityState.compilation.mappings.map((mapping) => mapping.iri),
  );
  for (const iri of referencedMappingIris) {
    if (!allowedIdentityMappingIris.has(iri)) {
      fail(
        'S5_CHAIN_MAPPING',
        `semantic mapping references mapping outside the authenticated batch closure: ${iri}`,
      );
    }
  }
  validateCompletedReferenceIdentityGraph(identityState.compilation.mappings, identityState);
  if (run.compilerDigest !== context.reportTool.capabilityDigest
      || run.executorDigest !== context.reportTool.capabilityDigest
      || run.validatorDigest !== context.reportTool.entrypointDigest) {
    fail('S5_CHAIN_TOOL_LOCK', 'completed run compiler/validator/executor do not join the locked tool tuple');
  }
  return {
    mappingTargets,
    ontologyState,
    sourceSchemaState,
    targetModuleIri: materializationPlan.value.targetOntologyModule,
  };
}

function completedRunFactVersionInventory(nquads, graphIri, runIri) {
  let dataset;
  try {
    dataset = rdfCanonize.NQuads.parse(nquads);
  } catch (cause) {
    fail('S5_BUNDLE_RDFC', `output RDF is not valid N-Quads: ${cause.message}`);
  }
  const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const xsdAnyUri = 'http://www.w3.org/2001/XMLSchema#anyURI';
  const factVersionIris = [...new Set(dataset.filter((quad) => (
    quad.graph.termType === 'NamedNode'
    && quad.graph.value === graphIri
    && quad.predicate.value === rdfType
    && quad.object.termType === 'NamedNode'
    && quad.object.value === FACT_VERSION
    && quad.subject.termType === 'NamedNode'
  )).map((quad) => quad.subject.value))].sort(utf8Compare);
  for (const iri of factVersionIris) {
    const contexts = dataset.filter((quad) => (
      quad.graph.termType === 'NamedNode'
      && quad.graph.value === graphIri
      && quad.subject.termType === 'NamedNode'
      && quad.subject.value === iri
      && quad.predicate.value === GENERATING_CONTEXT
    )).map((quad) => quad.object);
    if (contexts.length !== 1
        || contexts[0].termType !== 'Literal'
        || contexts[0].datatype.value !== xsdAnyUri
        || contexts[0].value !== runIri) {
      fail(
        'S5_CANONICAL_GENERATING_CONTEXT',
        `${iri} does not bind exactly one completed MaterializationRun`,
      );
    }
  }
  return factVersionIris;
}

function validateCompletedOutputTargetTypes(
  nquads,
  graphIri,
  factVersionIris,
  mappingTargets,
) {
  let dataset;
  try {
    dataset = rdfCanonize.NQuads.parse(nquads);
  } catch (cause) {
    fail('S5_BUNDLE_RDFC', `output RDF is not valid N-Quads: ${cause.message}`);
  }
  const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const allowedTargetTypes = new Set(mappingTargets.map((entry) => entry.targetType));
  for (const factVersionIri of factVersionIris) {
    const actualTargetTypes = dataset.filter((quad) => (
      quad.graph.termType === 'NamedNode'
      && quad.graph.value === graphIri
      && quad.subject.termType === 'NamedNode'
      && quad.subject.value === factVersionIri
      && quad.predicate.value === rdfType
      && quad.object.termType === 'NamedNode'
      && quad.object.value !== FACT_VERSION
    )).map((quad) => quad.object.value);
    if (actualTargetTypes.length !== 1
        || !allowedTargetTypes.has(actualTargetTypes[0])) {
      fail(
        'S5_BUNDLE_OUTPUT_TARGET_TYPE',
        `${factVersionIri} must carry exactly one target type from the authenticated mapping closure`,
      );
    }
  }
}

function validateCompletedOutputGraphInventory(nquads, graphIri) {
  let dataset;
  try {
    dataset = rdfCanonize.NQuads.parse(nquads);
  } catch (cause) {
    fail('S5_BUNDLE_RDFC', `output RDF is not valid N-Quads: ${cause.message}`);
  }
  const graphs = [...new Set(dataset.map((quad) => {
    if (quad.graph.termType === 'DefaultGraph') return '@default';
    if (quad.graph.termType === 'NamedNode') return quad.graph.value;
    return `@${quad.graph.termType}:${quad.graph.value}`;
  }))].sort(utf8Compare);
  if (canonicalJcs(graphs) !== canonicalJcs([graphIri])) {
    fail(
      'S5_BUNDLE_OUTPUT_GRAPH_INVENTORY',
      'completed output must contain exactly the expected target named graph and no default/extra graph',
    );
  }
}

function assertCompletedRunBundleFullyReferenced(resolver) {
  const unreferenced = resolver.artifacts.map((artifact) => refSortKey(artifact.ref))
    .filter((key) => !resolver.usedRefs.has(key))
    .sort(utf8Compare);
  if (unreferenced.length !== 0) {
    fail(
      'S5_BUNDLE_UNREFERENCED_ARTIFACT',
      `completed bundle contains artifacts outside its authenticated closure: ${unreferenced.join(', ')}`,
    );
  }
}

function frozenCompletedBundleCopy(value) {
  const copy = JSON.parse(canonicalJcs(value));
  function freeze(entry) {
    if (Array.isArray(entry)) {
      entry.forEach(freeze);
    } else if (isPlainObject(entry)) {
      Object.values(entry).forEach(freeze);
    }
    return Object.freeze(entry);
  }
  return freeze(copy);
}

function validateCompletedControlInputClosure(options) {
  const {
    buildInputs, context, resolver, run, toolLockArtifact,
  } = options;
  const controlBindings = buildInputs.inputs.filter((entry) => (
    entry.name === 'controlChainInput'
  ));
  if (controlBindings.length === 0) return null;
  if (controlBindings.length !== 1
      || !refsEqual(
        controlBindings[0].artifactRef,
        pathRef('sourceTree', INPUT_FIXTURE_REL),
      )) {
    fail(
      'S5_BUNDLE_CONTROL_INPUT',
      'Slice-A replay requires exactly the canonical controlChainInput source binding',
    );
  }
  const controlInputArtifact = resolver.readJson(
    controlBindings[0].artifactRef,
    'completed run controlChainInput',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  if (controlInputArtifact.digest !== controlBindings[0].artifactDigest) {
    fail(
      'S5_BUNDLE_CONTROL_INPUT',
      'controlChainInput bytes differ from the authenticated build-input binding',
    );
  }
  let parsed;
  try {
    parsed = parseInput(controlInputArtifact.value, resolver);
  } catch (cause) {
    if (cause instanceof S5ControlChainError) throw cause;
    fail('S5_BUNDLE_CONTROL_INPUT', cause.message);
  }
  parsed.inputArtifactDigest = controlInputArtifact.digest;
  const expectedInputs = expectedControlChainInputBindings(
    controlBindings[0].artifactRef,
    controlInputArtifact.value,
    parsed,
  );
  if (canonicalJcs(expectedInputs) !== canonicalJcs(buildInputs.inputs)) {
    fail(
      'S5_BUNDLE_CONTROL_INPUT',
      'build inputs do not equal the complete source closure derived from controlChainInput',
    );
  }
  validateValuationExecutableEvidence(
    parsed.supportEvidence,
    controlInputArtifact.value.sourceSchemaRef,
    parsed.sourceSchemaArtifact.digest,
    run.build.toolLockRef,
    toolLockArtifact,
    context.toolLockState,
  );
  if (run.assertionTime !== controlInputArtifact.value.execution.assertionTime
      || run.referenceTime !== controlInputArtifact.value.execution.referenceTime) {
    fail(
      'S5_BUNDLE_CONTROL_INPUT',
      'completed run assertion/reference time differs from the authenticated execution request',
    );
  }
  return Object.freeze({
    binding: frozenCompletedBundleCopy(controlBindings[0]),
    controlInputArtifact,
    parsed,
  });
}

function validateCompletedSliceAReplayContext(options) {
  const {
    buildInputs, completedControlInputClosure, context, outputNQuads, resolver, run,
    runArtifact, semanticClosure, toolLockArtifact,
  } = options;
  const controlClosure = completedControlInputClosure
    || validateCompletedControlInputClosure({
      buildInputs,
      context,
      resolver,
      run,
      toolLockArtifact,
    });
  if (controlClosure === null) return null;
  const { controlInputArtifact, parsed } = controlClosure;
  if (run.assertionTime !== controlInputArtifact.value.execution.assertionTime
      || run.referenceTime !== controlInputArtifact.value.execution.referenceTime) {
    fail(
      'S5_BUNDLE_CONTROL_INPUT',
      'completed run assertion/reference time differs from the authenticated execution request',
    );
  }
  const mappingGroups = parsed.mappingData.filter((entry) => (
    entry.plan.iri === run.planRef
    && entry.descriptor.targetGraph === run.result.outputGraph
  ));
  if (mappingGroups.length !== 1) {
    fail(
      'S5_BUNDLE_CONTROL_INPUT',
      'completed run plan/target graph is not one exact controlChainInput mapping group',
    );
  }
  const spec = completedReportReplaySpec(
    run.result.outputGraph,
    semanticClosure.targetModuleIri,
  );
  if (spec.slotId !== run.slotId) {
    fail(
      'S5_BUNDLE_CONTROL_INPUT',
      'completed run slot does not equal the exact Slice-A graph profile',
    );
  }
  const batchArtifacts = [...context.recordArtifacts.values()].filter((artifact) => (
    artifact.record.recordType === 'materializationBatchRun'
    && artifact.record.result?.outcome === 'completed'
  ));
  if (batchArtifacts.length !== 1) {
    fail(
      'S5_BUNDLE_BATCH_CONTEXT',
      'Slice-A report replay requires exactly one completed batch record',
    );
  }
  const [batchArtifact] = batchArtifacts;
  const batch = batchArtifact.record;
  if (batch.assertionTime !== run.assertionTime
      || batch.referenceTime !== run.referenceTime
      || batch.targetDataset !== controlInputArtifact.value.execution.targetDataset
      || canonicalJcs(batch.build) !== canonicalJcs(run.build)) {
    fail(
      'S5_BUNDLE_BATCH_CONTEXT',
      'completed run and batch do not share one exact build/time/target closure',
    );
  }
  const member = batch.result.members.filter((entry) => (
    entry.runRef === run.iri
  ));
  if (member.length !== 1
      || member[0].runRecordDigest !== runArtifact.digest
      || member[0].planRef !== run.planRef
      || member[0].outputGraph !== run.result.outputGraph
      || member[0].outputGraphDigest !== run.result.outputGraphDigest) {
    fail(
      'S5_BUNDLE_BATCH_CONTEXT',
      'completed run is not an exact member of the authenticated batch result',
    );
  }
  const fullDatasetRef = pathRef('buildEvidence', 'rdf/dataset-original.nq');
  const fullDatasetArtifact = resolver.read(
    fullDatasetRef,
    'Slice-A full materialized validation dataset',
    ['buildEvidence'],
  );
  if (fullDatasetArtifact.mediaType !== 'application/n-quads') {
    fail(
      'S5_BUNDLE_MEDIA_TYPE',
      'Slice-A full materialized validation dataset must use application/n-quads',
    );
  }
  const fullDatasetNQuads = decodeBundleUtf8(
    fullDatasetArtifact.bytes,
    'Slice-A full materialized validation dataset',
  );
  const expectedGraphIris = [
    ...batch.result.members.map((entry) => entry.outputGraph),
    `${batch.targetDataset}/provenance`,
  ].sort(utf8Compare);
  let parsedQuads;
  try {
    parsedQuads = rdfCanonize.NQuads.parse(fullDatasetNQuads);
  } catch (cause) {
    fail('S5_BUNDLE_RDFC', `Slice-A full dataset is invalid N-Quads: ${cause.message}`);
  }
  const actualGraphIris = [...new Set(parsedQuads.map((quad) => (
    quad.graph.termType === 'NamedNode' ? quad.graph.value : '@default'
  )))].sort(utf8Compare);
  if (canonicalJcs(actualGraphIris) !== canonicalJcs(expectedGraphIris)) {
    fail(
      'S5_BUNDLE_BATCH_CONTEXT',
      'Slice-A full validation dataset graph inventory differs from the batch result',
    );
  }
  const fullDataset = computeDatasetDigest(fullDatasetNQuads, expectedGraphIris);
  if (fullDataset.digest !== batch.result.outputDatasetDigest) {
    fail(
      'S5_BUNDLE_BATCH_CONTEXT',
      'Slice-A full validation dataset digest differs from the completed batch',
    );
  }
  for (const batchMember of batch.result.members) {
    const graph = computeNamedGraphDigest(fullDatasetNQuads, batchMember.outputGraph);
    if (graph.digest !== batchMember.outputGraphDigest) {
      fail(
        'S5_BUNDLE_BATCH_CONTEXT',
        `${batchMember.outputGraph} differs from its completed batch member digest`,
      );
    }
  }
  const targetGraph = computeNamedGraphDigest(fullDatasetNQuads, run.result.outputGraph);
  if (targetGraph.canonicalNQuads !== outputNQuads
      || targetGraph.digest !== run.result.outputGraphDigest) {
    fail(
      'S5_BUNDLE_BATCH_CONTEXT',
      'atomic completed output does not equal its graph in the full validation dataset',
    );
  }
  const batchReports = [...context.recordArtifacts.values()].filter((artifact) => (
    artifact.record.recordType === 'validationReport'
    && artifact.record.reportKind === 'batch'
  ));
  if (batchReports.length !== 1
      || batch.result.validationReportDigest !== batchReports[0].digest
      || batch.result.validationReportRef !== batchReports[0].record.iri
      || !refsEqual(batchReports[0].record.subjectRef, fullDatasetRef)
      || batchReports[0].record.result?.outcome !== 'passed'
      || batchReports[0].record.result.checks.length !== 1
      || batchReports[0].record.result.checks[0].subjectDigest !== fullDataset.digest
      || canonicalJcs(batchReports[0].record.result.checks[0].outputDigests)
        !== canonicalJcs([fullDataset.digest])) {
    fail(
      'S5_BUNDLE_BATCH_CONTEXT',
      'completed batch report does not bind the exact full validation dataset',
    );
  }
  const priorSupport = semanticClosure.sourceSchemaState.priorSupport;
  if (!priorSupport
      || priorSupport.datasetArtifact.digest !== parsed.priorSupport.datasetArtifact.digest
      || !priorSupport.datasetArtifact.bytes.equals(parsed.priorSupport.datasetArtifact.bytes)) {
    fail(
      'S5_BUNDLE_PRIOR_SUPPORT',
      'semantic input closure and controlChainInput do not select the same prior-support dataset',
    );
  }
  return Object.freeze({
    allowedGeneratingContextIris: Object.freeze([
      ...batch.result.members.map((entry) => entry.runRef),
      ...parsed.priorSupport.allowedRunIris,
    ].sort(utf8Compare)),
    batchArtifact,
    controlInput: controlInputArtifact.value,
    dataNQuads: fullDatasetNQuads,
    parsed,
    supportNQuads: parsed.priorSupport.nquads,
  });
}

function completedReportReplaySourcePath(root, ref, label) {
  if (!isPlainObject(ref)
      || ref.kind !== 'path'
      || ref.root !== 'sourceTree'
      || typeof ref.path !== 'string'
      || ref.path.length === 0
      || ref.path !== path.posix.normalize(ref.path)
      || ref.path.startsWith('../')
      || ref.path.includes('\\')) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_SOURCE',
      `${label} is not a canonical sourceTree path`,
    );
  }
  const target = path.resolve(root, ...ref.path.split('/'));
  const relative = path.relative(root, target);
  if (relative.length === 0
      || relative === '..'
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_SOURCE',
      `${label} escapes the verifier-owned hydration root`,
    );
  }
  return target;
}

function s5ControlRuntimePaths() {
  return Object.keys(EXPECTED_RUNTIME_CLOSURES['s5-control-record-chain'].paths)
    .sort(utf8Compare);
}

function hydrateVerifierInstalledRuntimeAndSources(
  resolver,
  sourceRefs,
  code,
  label,
) {
  const runtimeBytes = assertCompletedReplayInstalledRuntime(
    resolver,
    s5ControlRuntimePaths(),
    code,
    `${label} installed runtime`,
  );
  const temporaryBase = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryBase, 'axiolune-s5-runtime-'));
  if (path.dirname(root) !== temporaryBase) {
    fail(code, `${label} hydration root is outside the operating-system temporary directory`);
  }
  const written = new Map();
  const write = (relativePath, bytes, at) => {
    const ref = pathRef('sourceTree', relativePath);
    const target = completedReportReplaySourcePath(root, ref, at);
    const key = refSortKey(ref);
    const existing = written.get(key);
    if (existing) {
      if (!existing.equals(bytes)) {
        fail(code, `${at} collides with different authenticated bytes`);
      }
      return target;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
    written.set(key, Buffer.from(bytes));
    return target;
  };
  try {
    for (const [relativePath, bytes] of runtimeBytes) {
      write(relativePath, bytes, `${label} runtime ${relativePath}`);
    }
    for (const [index, ref] of sourceRefs.entries()) {
      const artifact = resolver.read(
        ref,
        `${label} authenticated source[${index}]`,
        ['sourceTree'],
      );
      write(ref.path, artifact.bytes, `${label} authenticated source[${index}]`);
    }
  } catch (cause) {
    if (path.dirname(root) === temporaryBase) {
      fs.rmSync(root, { force: true, recursive: true });
    }
    if (cause instanceof S5ControlChainError) throw cause;
    fail(code, `${label} hydration failed: ${cause.message}`);
  }
  return Object.freeze({
    pathFor(ref, at) {
      const key = refSortKey(ref);
      if (!written.has(key)) fail(code, `${at} was not hydrated from authenticated bytes`);
      return completedReportReplaySourcePath(root, ref, at);
    },
    root,
    temporaryBase,
  });
}

function hydrateCompletedReportReplaySourceTree(resolver) {
  const temporaryBase = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryBase, 'axiolune-report-replay-'));
  if (path.dirname(root) !== temporaryBase) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_SOURCE',
      'temporary hydration root is outside the operating-system temporary directory',
    );
  }
  try {
    for (const artifact of resolver.artifacts) {
      if (artifact.ref.kind !== 'path' || artifact.ref.root !== 'sourceTree') continue;
      const target = completedReportReplaySourcePath(
        root,
        artifact.ref,
        `source artifact ${refSortKey(artifact.ref)}`,
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, artifact.bytes, { flag: 'wx' });
    }
  } catch (cause) {
    if (path.dirname(root) === temporaryBase) {
      fs.rmSync(root, { force: true, recursive: true });
    }
    if (cause instanceof S5ControlChainError) throw cause;
    fail(
      'S5_BUNDLE_REPORT_REPLAY_SOURCE',
      `failed to hydrate authenticated source bytes: ${cause.message}`,
    );
  }
  return Object.freeze({ root, temporaryBase });
}

function removeCompletedReportReplaySourceTree(hydration) {
  if (!isPlainObject(hydration)
      || typeof hydration.root !== 'string'
      || typeof hydration.temporaryBase !== 'string'
      || path.dirname(hydration.root) !== hydration.temporaryBase
      || hydration.temporaryBase !== path.resolve(os.tmpdir())) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_SOURCE',
      'refusing to remove an unverified hydration directory',
    );
  }
  fs.rmSync(hydration.root, { force: true, recursive: true });
}

function completedReportReplaySpec(graphIri, targetModuleIri) {
  const spec = MATERIALIZATION_RUN_SPECS.find((candidate) => (
    candidate.graphIri === graphIri && candidate.moduleIri === targetModuleIri
  ));
  if (!spec) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_UNSUPPORTED',
      'verifier-owned report replay currently accepts only an exact Slice-A atomic named graph/module pair',
    );
  }
  return spec;
}

function runCompletedReportShaclReplay(options) {
  const {
    dataNQuads, ontologyState, resolver, spec, supportNQuads,
  } = options;
  const hydration = hydrateCompletedReportReplaySourceTree(resolver);
  try {
    const workerRef = pathRef(
      'sourceTree',
      'scripts/domain/lib/s5-materialized-shacl-worker.cjs',
    );
    const pythonWorkerRef = pathRef(
      'sourceTree',
      'scripts/domain/shacl-instance-profile/v0.3.0/s5-materialized-graph-worker.py',
    );
    const workerArtifact = resolver.read(
      workerRef,
      'completed report replay SHACL worker',
      ['sourceTree'],
    );
    const pythonWorkerArtifact = resolver.read(
      pythonWorkerRef,
      'completed report replay pySHACL worker',
      ['sourceTree'],
    );
    let installedWorkerBytes;
    let installedPythonWorkerBytes;
    try {
      installedWorkerBytes = fs.readFileSync(INSTALLED_S5_SHACL_WORKER);
      installedPythonWorkerBytes = fs.readFileSync(INSTALLED_S5_PYSHACL_WORKER);
    } catch (cause) {
      fail(
        'S5_BUNDLE_REPORT_REPLAY_RUNTIME',
        `verifier-installed SHACL runtime is unavailable: ${cause.message}`,
      );
    }
    if (!workerArtifact.bytes.equals(installedWorkerBytes)
        || !pythonWorkerArtifact.bytes.equals(installedPythonWorkerBytes)) {
      fail(
        'S5_BUNDLE_REPORT_REPLAY_RUNTIME',
        'bundle SHACL worker bytes differ from the verifier-installed executable runtime',
      );
    }
    const installedWorkerDigest = artifactDigest(installedWorkerBytes);
    const installedPythonWorkerDigest = artifactDigest(installedPythonWorkerBytes);
    const dataDigest = artifactDigest(Buffer.from(dataNQuads, 'utf8'));
    const supportDigest = artifactDigest(Buffer.from(supportNQuads, 'utf8'));
    const validations = [];
    for (const moduleIri of spec.validationModuleIris) {
      const module = ontologyState.modules.get(moduleIri);
      if (!module || module.row.layer !== 'm2') {
        fail(
          'S5_BUNDLE_REPORT_REPLAY_SOURCE',
          `Slice-A report replay module is absent from the verified ontology closure: ${moduleIri}`,
        );
      }
      const sidecarRef = moduleSidecarRef(module.row.sourceRef);
      const sidecarArtifact = resolver.read(
        sidecarRef,
        `${moduleIri} report replay SHACL sidecar`,
        ['sourceTree'],
      );
      const request = {
        dataNQuads,
        moduleSidecarPath: completedReportReplaySourcePath(
          hydration.root,
          sidecarRef,
          `${moduleIri} report replay SHACL sidecar`,
        ),
        moduleSourcePath: completedReportReplaySourcePath(
          hydration.root,
          module.row.sourceRef,
          `${moduleIri} report replay module source`,
        ),
        schemaVersion: '1.0',
        supportNQuads,
        targetGraphIri: spec.graphIri,
      };
      const workerEnvironment = {
        NODE_DISABLE_COLORS: '1',
        NODE_PATH: PINNED_NODE_MODULES_ROOT,
      };
      for (const key of ['LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
        if (typeof process.env[key] === 'string') workerEnvironment[key] = process.env[key];
      }
      const execution = spawnSync(process.execPath, [INSTALLED_S5_SHACL_WORKER], {
        cwd: hydration.root,
        encoding: 'utf8',
        env: workerEnvironment,
        input: canonicalJcs(request),
        maxBuffer: 64 * 1024 * 1024,
        shell: false,
        timeout: 10 * 60 * 1000,
        windowsHide: true,
      });
      if (execution.error || execution.status !== 0) {
        const detail = execution.error?.message
          || execution.stderr.trim()
          || `worker exited ${execution.status}`;
        fail(
          'S5_BUNDLE_REPORT_REPLAY_SHACL',
          `${moduleIri}: ${detail.slice(0, 4096)}`,
        );
      }
      let evidence;
      try {
        evidence = parseJsonRejectingDuplicateMembers(execution.stdout);
      } catch (cause) {
        fail(
          'S5_BUNDLE_REPORT_REPLAY_SHACL',
          `${moduleIri} worker emitted invalid JSON: ${cause.message}`,
        );
      }
      if (execution.stdout !== canonicalJcs(evidence)
          || evidence.schemaVersion !== '1.0'
          || evidence.artifactKind !== 's5MaterializedCurrentDomainShaclEvidence'
          || evidence.outcome !== 'passed'
          || evidence.module?.moduleIri !== moduleIri
          || evidence.module?.moduleSourceDigest !== module.row.sourceDigest
          || evidence.module?.projectedShaclDigest !== sidecarArtifact.digest
          || evidence.module?.checkedSidecarDigest !== sidecarArtifact.digest
          || evidence.module?.projectionEqualsSidecar !== true
          || evidence.data?.targetGraphIri !== spec.graphIri
          || evidence.data?.materializedDatasetDigest !== dataDigest
          || evidence.data?.validationSupportDigest !== supportDigest
          || evidence.execution?.conforms !== true
          || evidence.execution?.resultCount !== 0
          || canonicalJcs(evidence.execution?.results) !== canonicalJcs([])
          || evidence.worker?.nodeWorkerDigest !== installedWorkerDigest
          || evidence.worker?.pythonWorkerDigest !== installedPythonWorkerDigest) {
        fail(
          'S5_BUNDLE_REPORT_REPLAY_SHACL',
          `${moduleIri} worker evidence does not bind the authenticated module/sidecar/workers and exact output bytes`,
        );
      }
      validations.push(evidence);
    }
    return Object.freeze({
      artifactKind: 's5VerifierOwnedCurrentDomainShaclReplay',
      data: Object.freeze({
        materializedDatasetDigest: dataDigest,
        targetGraphIri: spec.graphIri,
        validationSupportDigest: supportDigest,
      }),
      outcome: 'passed',
      primaryModuleIri: spec.moduleIri,
      schemaVersion: '1.0',
      validatedModuleIris: Object.freeze([...spec.validationModuleIris]),
      validations: Object.freeze(validations),
    });
  } finally {
    removeCompletedReportReplaySourceTree(hydration);
  }
}

function completedReplayWorkerEnvironment() {
  const environment = {
    NODE_DISABLE_COLORS: '1',
    NODE_PATH: PINNED_NODE_MODULES_ROOT,
  };
  for (const key of ['LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string') environment[key] = process.env[key];
  }
  return environment;
}

function assertCompletedReplayInstalledRuntime(resolver, relativePaths, code, label) {
  const installedBytes = new Map();
  for (const relativePath of relativePaths) {
    const ref = pathRef('sourceTree', relativePath);
    const bundled = resolver.read(ref, `${label}.${relativePath}`, ['sourceTree']);
    let installed;
    try {
      const installedPath = path.resolve(REPOSITORY_ROOT, ...relativePath.split('/'));
      const expectedPrefix = `${REPOSITORY_ROOT}${path.sep}`;
      if (!installedPath.startsWith(expectedPrefix)) {
        fail(code, `${relativePath} escapes the verifier installation`);
      }
      installed = fs.readFileSync(installedPath);
    } catch (cause) {
      if (cause instanceof S5ControlChainError) throw cause;
      fail(code, `verifier-installed ${relativePath} is unavailable: ${cause.message}`);
    }
    if (!bundled.bytes.equals(installed)) {
      fail(
        code,
        `bundle ${relativePath} bytes differ from the verifier-installed ${label} runtime`,
      );
    }
    installedBytes.set(relativePath, Buffer.from(installed));
  }
  return installedBytes;
}

function runCompletedReportCustomReplay(options) {
  const {
    ontologyState, replayContext, resolver, spec,
  } = options;
  assertCompletedReplayInstalledRuntime(
    resolver,
    CUSTOM_REPLAY_RUNTIME_PATHS,
    'S5_BUNDLE_REPORT_REPLAY_RUNTIME',
    'Custom',
  );
  const hydration = hydrateCompletedReportReplaySourceTree(resolver);
  try {
    const moduleIris = [...new Set(MATERIALIZATION_RUN_SPECS.flatMap(
      (entry) => entry.validationModuleIris,
    ))].sort(utf8Compare);
    const moduleSourcePaths = moduleIris.map((moduleIri) => {
      const module = ontologyState.modules.get(moduleIri);
      if (!module || module.row.layer !== 'm2') {
        fail(
          'S5_BUNDLE_REPORT_REPLAY_SOURCE',
          `Custom replay module is absent from ontology closure: ${moduleIri}`,
        );
      }
      return completedReportReplaySourcePath(
        hydration.root,
        module.row.sourceRef,
        `${moduleIri} Custom replay module source`,
      );
    });
    const lockedEvidenceArtifacts = replayContext.parsed.supportEvidence.closure.entries
      .map((entry) => ({
        artifactDigest: entry.artifactDigest,
        artifactRef: entry.artifactRef,
        evidenceIri: entry.evidenceIri,
        evidenceKind: entry.evidenceKind,
        file: completedReportReplaySourcePath(
          hydration.root,
          entry.artifactRef,
          `${entry.evidenceIri} Custom replay evidence`,
        ),
      })).sort((left, right) => utf8Compare(left.evidenceIri, right.evidenceIri));
    const execution = replayContext.controlInput.execution;
    const request = {
      allowedGeneratingContextIris: [...replayContext.allowedGeneratingContextIris],
      asOfAvailable: execution.asOfAvailable,
      asOfKnowledge: execution.asOfKnowledge,
      asOfValid: execution.asOfValid,
      dataNQuads: replayContext.dataNQuads,
      lockedEvidenceArtifacts,
      moduleSourcePaths,
      referenceTime: execution.referenceTime,
      schemaVersion: '1.0',
      supportNQuads: replayContext.supportNQuads,
      targetGraphIri: spec.graphIri,
    };
    const workerExecution = spawnSync(process.execPath, [INSTALLED_S5_CUSTOM_WORKER], {
      cwd: hydration.root,
      encoding: 'utf8',
      env: completedReplayWorkerEnvironment(),
      input: canonicalJcs(request),
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      timeout: 10 * 60 * 1000,
      windowsHide: true,
    });
    if (workerExecution.error || workerExecution.status !== 0) {
      const detail = workerExecution.error?.message
        || workerExecution.stderr.trim()
        || `worker exited ${workerExecution.status}`;
      fail('S5_BUNDLE_REPORT_REPLAY_CUSTOM', detail.slice(0, 4096));
    }
    let evidence;
    try {
      evidence = parseJsonRejectingDuplicateMembers(workerExecution.stdout);
    } catch (cause) {
      fail(
        'S5_BUNDLE_REPORT_REPLAY_CUSTOM',
        `Custom worker emitted invalid JSON: ${cause.message}`,
      );
    }
    const expectedModuleRows = moduleIris.map((moduleIri) => {
      const module = ontologyState.modules.get(moduleIri);
      return { moduleIri, sourceDigest: module.row.sourceDigest };
    });
    const expectedEvidenceRows = lockedEvidenceArtifacts.map((entry) => ({
      artifactDigest: entry.artifactDigest,
      evidenceIri: entry.evidenceIri,
      evidenceKind: entry.evidenceKind,
    }));
    const expectedContext = {
      allowedGeneratingContextIris: request.allowedGeneratingContextIris,
      asOfAvailable: request.asOfAvailable,
      asOfKnowledge: request.asOfKnowledge,
      asOfValid: request.asOfValid,
      referenceTime: request.referenceTime,
    };
    if (workerExecution.stdout !== canonicalJcs(evidence)
        || evidence.artifactKind !== 's5MaterializedApplicableCustomEvidence'
        || evidence.outcome !== 'passed'
        || evidence.counts?.discovered <= 0
        || evidence.counts.discovered !== evidence.counts.executed
        || evidence.counts.executed !== evidence.counts.passed
        || evidence.counts.failed !== 0
        || canonicalJcs(evidence.modules) !== canonicalJcs(expectedModuleRows)
        || canonicalJcs(evidence.lockedEvidence) !== canonicalJcs(expectedEvidenceRows)
        || canonicalJcs(evidence.context) !== canonicalJcs(expectedContext)
        || evidence.data?.targetGraphIri !== spec.graphIri
        || evidence.data?.materializedDatasetDigest
          !== artifactDigest(Buffer.from(replayContext.dataNQuads, 'utf8'))
        || evidence.data?.supportDatasetDigest
          !== artifactDigest(Buffer.from(replayContext.supportNQuads, 'utf8'))) {
      fail(
        'S5_BUNDLE_REPORT_REPLAY_CUSTOM',
        'Custom worker evidence does not bind the authenticated data/support/module/evidence/run closure',
      );
    }
    return evidence;
  } finally {
    removeCompletedReportReplaySourceTree(hydration);
  }
}

function validateStoredCompletedReportShaclEvidence(
  resolver,
  report,
  replay,
  customReplay,
) {
  const evidenceArtifact = resolver.readJson(
    report.kindEvidence.artifactRef,
    'completed ValidationReport.kindEvidence.artifactRef',
    { exactJcs: true },
  );
  if (evidenceArtifact.digest !== report.kindEvidence.artifactDigest) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
      'completed ValidationReport kind-evidence bytes/digest drift',
    );
  }
  const evidence = evidenceArtifact.value;
  if (isPlainObject(evidence)) {
    exactKeys(
      evidence,
      [
        'artifactKind', 'checks', 'outcome', 'schemaVersion',
        'supportDatasetDigest', 'targetGraphIri',
      ],
      'completed report combined validation evidence',
      'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
    );
  }
  if (!isPlainObject(evidence)
      || evidence.artifactKind !== 's5MaterializedSHACLAndApplicableCustomEvidence'
      || evidence.outcome !== 'passed'
      || evidence.schemaVersion !== '1.0'
      || evidence.targetGraphIri !== replay.data.targetGraphIri
      || evidence.supportDatasetDigest !== replay.data.validationSupportDigest
      || !Array.isArray(evidence.checks)
      || evidence.checks.length !== 2) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
      'passed report does not carry the closed SHACL + applicable-Custom evidence envelope',
    );
  }
  const byKind = new Map();
  for (const [index, check] of evidence.checks.entries()) {
    exactKeys(
      check,
      ['artifactDigest', 'artifactRef', 'kind'],
      `completed report validation evidence.checks[${index}]`,
      'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
    );
    if (byKind.has(check.kind)) {
      fail(
        'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
        `completed report validation evidence repeats ${check.kind}`,
      );
    }
    byKind.set(check.kind, check);
  }
  if (canonicalJcs([...byKind.keys()].sort(utf8Compare))
      !== canonicalJcs(['applicableCustom', 'currentDomainSHACL'])) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
      'completed report validation evidence does not contain exactly SHACL and applicable Custom checks',
    );
  }
  const shaclCheck = byKind.get('currentDomainSHACL');
  const shaclArtifact = resolver.readJson(
    shaclCheck.artifactRef,
    'completed report current-domain SHACL evidence',
    { exactJcs: true },
  );
  if (isPlainObject(shaclArtifact.value)) {
    exactKeys(
      shaclArtifact.value,
      [
        'artifactKind', 'data', 'outcome', 'primaryModuleIri', 'schemaVersion',
        'validatedModuleIris', 'validations',
      ],
      'completed report current-domain SHACL evidence set',
      'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
    );
  }
  if (shaclArtifact.digest !== shaclCheck.artifactDigest
      || shaclArtifact.value.artifactKind
        !== 's5MaterializedCurrentDomainShaclEvidenceSet'
      || shaclArtifact.value.outcome !== 'passed'
      || shaclArtifact.value.primaryModuleIri !== replay.primaryModuleIri
      || canonicalJcs(shaclArtifact.value.validatedModuleIris)
        !== canonicalJcs(replay.validatedModuleIris)
      || canonicalJcs(shaclArtifact.value.data) !== canonicalJcs(replay.data)
      || canonicalJcs(shaclArtifact.value.validations) !== canonicalJcs(replay.validations)) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
      'stored current-domain SHACL evidence does not equal verifier-owned execution',
    );
  }

  if (customReplay === null) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_CUSTOM_REQUIRED',
      'completed report replay still requires an authenticated prior-support dataset, locked support-evidence closure, generating-context allowlist, and exact valid/knowledge/available pivots for verifier-owned applicable-Custom execution',
    );
  }
  const customCheck = byKind.get('applicableCustom');
  const customArtifact = resolver.readJson(
    customCheck.artifactRef,
    'completed report applicable-Custom evidence',
    { exactJcs: true },
  );
  if (customArtifact.digest !== customCheck.artifactDigest
      || canonicalJcs(customArtifact.value) !== canonicalJcs(customReplay)) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_CUSTOM',
      'stored applicable-Custom evidence does not equal verifier-owned execution',
    );
  }
}

function markCompletedReportDeclaredEvidenceClosure(resolver, report, label) {
  const evidenceArtifact = resolver.readJson(
    report.kindEvidence.artifactRef,
    `${label}.kindEvidence.artifactRef`,
    { allowedRoots: ['buildEvidence'], exactJcs: true },
  );
  if (evidenceArtifact.digest !== report.kindEvidence.artifactDigest) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
      'completed ValidationReport kind-evidence bytes/digest drift',
    );
  }
  const evidence = evidenceArtifact.value;
  if (evidence?.artifactKind !== 's5MaterializedSHACLAndApplicableCustomEvidence') return;
  exactKeys(
    evidence,
    [
      'artifactKind', 'checks', 'outcome', 'schemaVersion',
      'supportDatasetDigest', 'targetGraphIri',
    ],
    `${label}.kindEvidence`,
    'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
  );
  if (evidence.outcome !== 'passed'
      || evidence.schemaVersion !== '1.0'
      || !Array.isArray(evidence.checks)
      || evidence.checks.length !== 2) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
      'combined report evidence must declare exactly SHACL and applicable-Custom artifacts',
    );
  }
  absoluteIri(evidence.targetGraphIri, `${label}.kindEvidence.targetGraphIri`);
  rawDigestBytes(
    evidence.supportDatasetDigest,
    `${label}.kindEvidence.supportDatasetDigest`,
  );
  const checksByKind = new Map();
  for (const [index, check] of evidence.checks.entries()) {
    exactKeys(
      check,
      ['artifactDigest', 'artifactRef', 'kind'],
      `${label}.kindEvidence.checks[${index}]`,
      'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
    );
    if (checksByKind.has(check.kind)) {
      fail(
        'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
        `${label}.kindEvidence repeats ${check.kind}`,
      );
    }
    checksByKind.set(check.kind, check);
    const artifact = resolver.readJson(
      check.artifactRef,
      `${label}.kindEvidence.checks[${index}].artifactRef`,
      { allowedRoots: ['buildEvidence'], exactJcs: true },
    );
    if (artifact.digest !== check.artifactDigest) {
      fail(
        'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
        `completed report ${check.kind} artifact bytes/digest drift`,
      );
    }
    const expectedArtifactKind = check.kind === 'currentDomainSHACL'
      ? 's5MaterializedCurrentDomainShaclEvidenceSet'
      : check.kind === 'applicableCustom'
        ? 's5MaterializedApplicableCustomEvidence'
        : null;
    if (expectedArtifactKind === null
        || artifact.value?.artifactKind !== expectedArtifactKind
        || artifact.value?.outcome !== 'passed') {
      fail(
        'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
        `${label}.kindEvidence ${check.kind} child is not the declared passed evidence kind`,
      );
    }
  }
  if (canonicalJcs([...checksByKind.keys()].sort(utf8Compare))
      !== canonicalJcs(['applicableCustom', 'currentDomainSHACL'])) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
      `${label}.kindEvidence must contain exactly SHACL and applicable-Custom children`,
    );
  }
}

function markAllActiveMappingReportDeclaredEvidenceClosures(resolver, recordArtifacts) {
  for (const [slotId, artifact] of recordArtifacts.entries()) {
    if (artifact.record.recordType !== 'validationReport'
        || artifact.record.reportKind !== 'mapping') {
      continue;
    }
    markCompletedReportDeclaredEvidenceClosure(
      resolver,
      artifact.record,
      `active mapping ValidationReport ${slotId}`,
    );
  }
}

function replayCompletedValidationReport(options) {
  if (options.report.reportKind !== 'mapping') {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_UNSUPPORTED',
      'completed-run report replay requires a mapping ValidationReport',
    );
  }
  const spec = completedReportReplaySpec(
    options.outputGraphIri,
    options.targetModuleIri,
  );
  if (options.report.gateId !== spec.gateId) {
    fail(
      'S5_BUNDLE_REPORT_REPLAY_EVIDENCE',
      'completed mapping report gateId does not equal the exact Slice-A graph gate',
    );
  }
  const dataNQuads = options.replayContext?.dataNQuads || options.outputNQuads;
  const supportNQuads = options.replayContext?.supportNQuads || '';
  const replay = runCompletedReportShaclReplay({
    dataNQuads,
    ontologyState: options.ontologyState,
    resolver: options.resolver,
    spec,
    supportNQuads,
  });
  const customReplay = options.replayContext
    ? runCompletedReportCustomReplay({
      ontologyState: options.ontologyState,
      replayContext: options.replayContext,
      resolver: options.resolver,
      spec,
    })
    : null;
  validateStoredCompletedReportShaclEvidence(
    options.resolver,
    options.report,
    replay,
    customReplay,
  );
}

/**
 * A closed bundle, its control records, and a caller-supplied expectation set
 * can prove byte consistency, but they cannot prove that the locked producer
 * actually derived the RDF from the authenticated source snapshots and
 * semantic mappings. Until this verifier independently replays that producer,
 * it must not create a verifier-branded completed-run summary.
 *
 * Deliberately accepts no callback or bundle-provided proof object: either
 * would let the party that authored the self-reported ValidationReport define
 * the trust decision it is asking this verifier to make.
 */
function runIndependentCompletedRunProducerReplay(options) {
  const {
    outputArtifact, replayContext, resolver, run, semanticClosure,
  } = options;
  if (replayContext === null) {
    fail(
      'S5_BUNDLE_PRODUCER_REPLAY_REQUIRED',
      'completed bundle verification requires verifier-owned replay of the locked producer over the exact authenticated snapshots and mapping closure',
    );
  }
  const profile = SLICE_A_REPLAY_PROFILES[run.result.outputGraph];
  if (!profile) {
    fail(
      'S5_BUNDLE_PRODUCER_REPLAY_REQUIRED',
      'completed run output graph has no verifier-installed producer replay profile',
    );
  }
  const primarySources = [...semanticClosure.sourceSchemaState.byDataset.values()];
  if (primarySources.length !== 1) {
    fail(
      'S5_BUNDLE_PRODUCER_REPLAY_REQUIRED',
      'Slice-A producer replay requires exactly one authenticated primary source dataset',
    );
  }
  const [source] = primarySources;
  const artifactRows = (paths, label) => paths.map((relativePath) => {
    const artifact = resolver.read(
      pathRef('sourceTree', relativePath),
      `${label}.${relativePath}`,
      ['sourceTree'],
    );
    return { bytes: Buffer.from(artifact.bytes), path: relativePath };
  });
  let replay;
  try {
    replay = replayLockedSliceACompletedRun({
      graphIri: run.result.outputGraph,
      mappingTargets: semanticClosure.mappingTargets.map((entry) => ({
        mappingRef: entry.mappingRef,
        targetType: entry.targetType,
      })),
      materializerArtifacts: artifactRows(
        MATERIALIZER_BINDING_PATHS,
        'producerReplay.materializerArtifacts',
      ),
      outputBytes: Buffer.from(outputArtifact.bytes),
      planRef: run.planRef,
      runIri: run.iri,
      semanticProfileArtifacts: artifactRows(
        profile.semanticProfilePaths,
        'producerReplay.semanticProfileArtifacts',
      ),
      sourceSchemaBytes: Buffer.from(source.artifact.bytes),
      sourceSnapshotBytes: Buffer.from(source.snapshotArtifact.bytes),
      valuationPolicyArtifacts: {
        precisionBytes: Buffer.from(
          replayContext.parsed.supportEvidence.valuationPolicyArtifacts.precisionBytes,
        ),
        roundingBytes: Buffer.from(
          replayContext.parsed.supportEvidence.valuationPolicyArtifacts.roundingBytes,
        ),
      },
    });
  } catch (cause) {
    fail(cause.code || 'S5_BUNDLE_PRODUCER_REPLAY', cause.message);
  }
  if (replay.graphDigest !== run.result.outputGraphDigest
      || replay.graphIri !== run.result.outputGraph
      || replay.planRef !== run.planRef
      || replay.factVersionCount !== run.result.outputFactVersionCount) {
    fail(
      'S5_BUNDLE_PRODUCER_REPLAY',
      'verifier-owned producer replay result differs from the completed run',
    );
  }
  return replay;
}

function verifyCompletedMaterializationRunBundle(bundle, expectations) {
  validateCompletedRunBundleExpectations(expectations);
  const resolver = createCompletedRunBundleResolver(bundle);
  const runArtifact = exactJcsArtifactForRecordExpectation(
    resolver,
    expectations.run,
    'materializationRun',
    'completed MaterializationRun',
  );
  const reportArtifact = exactJcsArtifactForRecordExpectation(
    resolver,
    expectations.validationReport,
    'validationReport',
    'completed run ValidationReport',
  );
  const ledgerArtifact = exactJcsArtifactForRecordExpectation(
    resolver,
    expectations.evidenceLedger,
    'evidenceLedger',
    'detached EvidenceLedger',
  );
  const run = runArtifact.record;
  const report = reportArtifact.record;
  const ledger = ledgerArtifact.record;

  if (run.result?.outcome !== 'completed') {
    fail('S5_BUNDLE_RUN_NOT_COMPLETED', 'expected MaterializationRun outcome is not completed');
  }
  if (report.result?.outcome !== 'passed') {
    fail('S5_BUNDLE_REPORT_NOT_PASSED', 'expected ValidationReport outcome is not passed');
  }

  if (!isPlainObject(run.build)) {
    fail('S5_BUNDLE_BUILD', 'completed MaterializationRun has no build closure');
  }
  const schemaManifestArtifact = resolver.readJson(
    run.build.controlRecordSchemaManifestRef,
    'completedRun.build.controlRecordSchemaManifestRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  validateSchemaManifest(schemaManifestArtifact.value, resolver);
  const schemaManifestDigest = taggedJcsDigest(
    'axiolune-control-record-schema-manifest-v1\0',
    schemaManifestArtifact.value,
  );
  if (schemaManifestDigest !== run.build.controlRecordSchemaManifestDigest) {
    fail('S5_CHAIN_SCHEMA_MANIFEST', 'completed run schema-manifest tagged digest drift');
  }

  const toolLockArtifact = resolver.readJson(
    run.build.toolLockRef,
    'completedRun.build.toolLockRef',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  const toolLockState = validateToolLock(toolLockArtifact.value, resolver);
  const toolLockDigest = taggedJcsDigest('axiolune-tool-lock-v1\0', toolLockArtifact.value);
  if (toolLockDigest !== run.build.toolLockDigest) {
    fail('S5_CHAIN_TOOL_LOCK', 'completed run tool-lock tagged digest drift');
  }

  const controlPlanArtifact = resolver.readJson(
    run.build.controlRecordPlanRef,
    'completedRun.build.controlRecordPlanRef',
    { allowedRoots: ['sourceTree', 'buildEvidence'], exactJcs: true },
  );
  const controlPlanDigest = taggedJcsDigest(
    'axiolune-control-record-plan-v1\0',
    controlPlanArtifact.value,
  );
  if (controlPlanDigest !== run.build.controlRecordPlanDigest) {
    fail('S5_CHAIN_PLAN', 'completed run control-record plan tagged digest drift');
  }
  const planAlternatives = validatePlan(
    controlPlanArtifact.value,
    resolver,
    schemaManifestDigest,
  );

  const buildInputsArtifact = resolver.readJson(
    run.build.buildInputsRef,
    'completedRun.build.buildInputsRef',
    { allowedRoots: ['buildEvidence'], exactJcs: true },
  );
  if ('sourceTreeSelectorRef' in buildInputsArtifact.value
      || 'sourceTreeSelectorDigest' in buildInputsArtifact.value) {
    fail(
      'S5_BUNDLE_PURE_SOURCE_TREE',
      'pure bundle verification requires the exact source-closure bytes, not a local Git selector',
    );
  }
  const sourceTreeState = verifyBuildInputs(
    buildInputsArtifact.value,
    resolver,
    controlPlanDigest,
    schemaManifestDigest,
    toolLockDigest,
  );
  validateBundleSourceTreeInventory(resolver, sourceTreeState.manifest);
  const buildInputsDigest = taggedJcsDigest(
    'axiolune-build-inputs-v1\0',
    buildInputsArtifact.value,
  );
  const buildId = artifactDigest(Buffer.concat([
    Buffer.from('axiolune-build-v1\0', 'utf8'),
    rawDigestBytes(buildInputsArtifact.value.sourceTreeDigest, 'sourceTreeDigest'),
    rawDigestBytes(toolLockDigest, 'toolLockDigest'),
    rawDigestBytes(buildInputsDigest, 'buildInputsDigest'),
  ]));
  if (buildInputsDigest !== run.build.buildInputsDigest || buildId !== run.build.buildId) {
    fail('S5_CHAIN_BUILD_BINDING', 'completed run build-input digest/buildId drift');
  }

  if (!Array.isArray(ledger.entries) || !Array.isArray(ledger.slotSelections)) {
    fail('S5_CHAIN_LEDGER', 'detached ledger has no entry/selection inventory');
  }
  const recordArtifacts = new Map();
  for (const [index, entry] of ledger.entries.entries()) {
    const artifact = exactJcsArtifactForLedgerEntry(
      resolver,
      entry,
      `detached EvidenceLedger.entries[${index}]`,
    );
    if (recordArtifacts.has(entry.slotId)) {
      fail('S5_CHAIN_LEDGER', `detached ledger repeats slot ${entry.slotId}`);
    }
    recordArtifacts.set(entry.slotId, artifact);
  }
  if (recordArtifacts.has(ledger.slotId)) {
    fail('S5_CHAIN_LEDGER', 'detached ledger cannot include itself as an entry');
  }
  recordArtifacts.set(ledger.slotId, ledgerArtifact);

  const context = {
    buildId,
    buildInputsDigest,
    planDigest: controlPlanDigest,
    recordArtifacts,
    recordArtifactsByIri: new Map(),
    referenceTime: instantEpoch(buildInputsArtifact.value.referenceTime, 'buildInputs.referenceTime'),
    reportTool: reportToolBinding(toolLockArtifact.value),
    resolver,
    schemaManifestDigest,
    sourceTreeDigest: buildInputsArtifact.value.sourceTreeDigest,
    toolLockDigest,
    toolLockState,
  };
  context.recordArtifactsByIri = indexControlRecordsByIri(recordArtifacts);

  const outcomes = new Map();
  for (const [slotId, artifact] of recordArtifacts.entries()) {
    if (['materializationRun', 'materializationBatchRun'].includes(artifact.record.recordType)) {
      outcomes.set(slotId, artifact.record.result?.outcome);
    }
  }
  const active = activeAlternatives(planAlternatives, outcomes);
  validateStageDag(active);
  const expectedSlots = [...active.keys()].sort(utf8Compare);
  const actualSlots = [...recordArtifacts.keys()].sort(utf8Compare);
  if (canonicalJcs(expectedSlots) !== canonicalJcs(actualSlots)) {
    fail('S5_BUNDLE_RECORD_SET', 'ledger-backed control records do not equal all active plan slots');
  }
  for (const slotId of finalRecordValidationOrder(active)) {
    validateRecordByType(recordArtifacts.get(slotId).record, active.get(slotId), context);
  }

  if (run.result.outcome !== 'completed') {
    fail('S5_BUNDLE_RUN_NOT_COMPLETED', 'expected MaterializationRun outcome is not completed');
  }
  if (report.result?.outcome !== 'passed') {
    fail('S5_BUNDLE_REPORT_NOT_PASSED', 'expected ValidationReport outcome is not passed');
  }
  if (run.result.validationReportRef !== report.iri
      || run.result.validationReportDigest !== reportArtifact.digest) {
    fail('S5_BUNDLE_REPORT_BINDING', 'completed run does not bind the expected report bytes');
  }
  if (!recordArtifacts.has(run.slotId)
      || recordArtifacts.get(run.slotId).digest !== runArtifact.digest
      || !recordArtifacts.has(report.slotId)
      || recordArtifacts.get(report.slotId).digest !== reportArtifact.digest) {
    fail('S5_CHAIN_LEDGER', 'detached ledger does not contain the expected run and report bytes');
  }

  context.completedControlInputClosure = validateCompletedControlInputClosure({
    buildInputs: buildInputsArtifact.value,
    context,
    resolver,
    run,
    toolLockArtifact,
  });
  const semanticClosure = validateCompletedRunSemanticClosure(
    run,
    buildInputsArtifact.value,
    resolver,
    context,
  );

  const outputArtifact = resolver.read(
    expectations.output.artifactRef,
    'completedRunExpectations.output.artifactRef',
    ['sourceTree', 'buildEvidence'],
  );
  if (outputArtifact.mediaType !== 'application/n-quads') {
    fail('S5_BUNDLE_MEDIA_TYPE', 'completed output must use application/n-quads');
  }
  const outputText = decodeBundleUtf8(outputArtifact.bytes, 'completed output RDF');
  validateCompletedOutputGraphInventory(outputText, expectations.output.graphIri);
  let canonicalDataset;
  let outputGraph;
  try {
    canonicalDataset = computeDatasetDigest(outputText);
    outputGraph = computeNamedGraphDigest(outputText, expectations.output.graphIri);
  } catch (cause) {
    fail('S5_BUNDLE_RDFC', `completed output failed RDFC-1.0 verification: ${cause.message}`);
  }
  if (outputText !== canonicalDataset.canonicalNQuads) {
    fail('S5_BUNDLE_RDFC', 'completed output bytes are not the exact RDFC-1.0 canonical N-Quads');
  }
  if (run.result.outputGraph !== expectations.output.graphIri
      || run.result.outputGraphDigest !== expectations.output.graphDigest
      || outputGraph.digest !== expectations.output.graphDigest) {
    fail('S5_BUNDLE_OUTPUT_BINDING', 'completed run/output expectation/raw graph digest do not join');
  }
  const factVersionIris = completedRunFactVersionInventory(
    outputText,
    expectations.output.graphIri,
    run.iri,
  );
  validateCompletedOutputTargetTypes(
    outputText,
    expectations.output.graphIri,
    factVersionIris,
    semanticClosure.mappingTargets,
  );
  const factVersionCount = countFactVersionsInGraph(
    outputText,
    expectations.output.graphIri,
    run.iri,
  );
  if (factVersionCount !== run.result.outputFactVersionCount
      || canonicalJcs(factVersionIris) !== canonicalJcs(expectations.output.factVersionIris)) {
    fail('S5_BUNDLE_FACT_INVENTORY', 'completed run FactVersion count/inventory does not recompute');
  }

  const outputBindingChecks = report.result.checks.filter((check) => (
    refsEqual(check.subjectRef, expectations.output.artifactRef)
    && check.subjectDigest === outputGraph.digest
    && canonicalJcs(check.outputDigests) === canonicalJcs([outputGraph.digest])
  ));
  if (!refsEqual(report.subjectRef, expectations.output.artifactRef)
      || outputBindingChecks.length !== 1) {
    fail('S5_BUNDLE_REPORT_BINDING', 'passed report does not bind the exact output graph bytes/digest');
  }

  const replayContext = validateCompletedSliceAReplayContext({
    buildInputs: buildInputsArtifact.value,
    completedControlInputClosure: context.completedControlInputClosure,
    context,
    outputNQuads: canonicalDataset.canonicalNQuads,
    resolver,
    run,
    runArtifact,
    semanticClosure,
    toolLockArtifact,
  });
  markAllActiveMappingReportDeclaredEvidenceClosures(resolver, recordArtifacts);
  assertCompletedRunBundleFullyReferenced(resolver);

  replayCompletedValidationReport({
    ontologyState: semanticClosure.ontologyState,
    outputGraphIri: expectations.output.graphIri,
    outputNQuads: canonicalDataset.canonicalNQuads,
    replayContext,
    report,
    resolver,
    targetModuleIri: semanticClosure.targetModuleIri,
  });

  runIndependentCompletedRunProducerReplay({
    outputArtifact,
    replayContext,
    resolver,
    run,
    semanticClosure,
  });
  assertCompletedRunBundleFullyReferenced(resolver);

  const summary = Object.freeze({
    assertionTime: run.assertionTime,
    evidenceLedgerIri: ledger.iri,
    evidenceLedgerRecordDigest: ledgerArtifact.digest,
    factVersionCount,
    factVersionIris: Object.freeze([...factVersionIris]),
    inputDatasets: frozenCompletedBundleCopy(run.inputDatasets),
    mappingTargets: frozenCompletedBundleCopy(semanticClosure.mappingTargets),
    outputArtifactDigest: outputArtifact.digest,
    outputArtifactRef: frozenCompletedBundleCopy(report.subjectRef),
    outputCanonicalNQuads: canonicalDataset.canonicalNQuads,
    outputGraph: run.result.outputGraph,
    outputGraphDigest: run.result.outputGraphDigest,
    planRef: run.planRef,
    referenceTime: run.referenceTime,
    runIri: run.iri,
    runRecordDigest: runArtifact.digest,
    sourceSnapshotRootDigest: run.sourceSnapshotRootDigest,
    validationReportIri: report.iri,
    validationReportRecordDigest: reportArtifact.digest,
  });
  VERIFIED_COMPLETED_RUN_SUMMARIES.add(summary);
  VERIFIED_COMPLETED_RUN_METADATA.set(summary, Object.freeze({
    build: frozenCompletedBundleCopy(run.build),
    resolver,
    runSlotId: run.slotId,
  }));
  return summary;
}

/**
 * Projects a successfully verified completed-run summary into the exact
 * materialization-context evidence consumed by PIT validation. WeakSet
 * membership prevents a caller from manufacturing an equivalent-looking
 * object and treating it as verifier output.
 */
function verifiedMaterializationRunContext(summary) {
  if (!summary || !VERIFIED_COMPLETED_RUN_SUMMARIES.has(summary)) {
    fail(
      'S5_BUNDLE_UNVERIFIED_SUMMARY',
      'PIT context projection requires the in-process result of completed bundle verification',
    );
  }
  const metadata = VERIFIED_COMPLETED_RUN_METADATA.get(summary);
  const context = Object.freeze({
    contextKind: 'materializationRun',
    evidenceLedgerRecordDigest: summary.evidenceLedgerRecordDigest,
    evidenceLedgerRef: summary.evidenceLedgerIri,
    ledgerVerified: true,
    outcome: 'completed',
    recordDigest: summary.runRecordDigest,
    recordRef: summary.runIri,
    referenceTime: summary.referenceTime,
    targetGraph: summary.outputGraph,
    targetGraphDigest: summary.outputGraphDigest,
    verificationKind: 'verifiedCompletedMaterializationContext',
  });
  VERIFIED_MATERIALIZATION_CONTEXTS.add(context);
  VERIFIED_MATERIALIZATION_CONTEXT_METADATA.set(context, metadata);
  return context;
}

function isVerifiedMaterializationContext(value) {
  return Boolean(value) && VERIFIED_MATERIALIZATION_CONTEXTS.has(value);
}

function verifiedMaterializationContextBuild(value) {
  if (!isVerifiedMaterializationContext(value)) {
    fail(
      'S5_BUNDLE_UNVERIFIED_CONTEXT',
      'build projection requires a verifier-branded materialization context',
    );
  }
  return VERIFIED_MATERIALIZATION_CONTEXT_METADATA.get(value).build;
}

function verifiedMaterializationContextSourceArtifact(value, ref) {
  if (!isVerifiedMaterializationContext(value)) {
    fail(
      'S5_BUNDLE_UNVERIFIED_CONTEXT',
      'source artifact resolution requires a verifier-branded materialization context',
    );
  }
  const artifact = VERIFIED_MATERIALIZATION_CONTEXT_METADATA.get(value).resolver.read(
    ref,
    'verifiedMaterializationContext.sourceArtifact',
    ['sourceTree'],
  );
  return Object.freeze({
    digest: artifact.digest,
    mediaType: artifact.mediaType,
    ref: frozenCompletedBundleCopy(ref),
  });
}

function verifiedMaterializationContextSourceArtifactBytes(value, ref) {
  if (!isVerifiedMaterializationContext(value)) {
    fail(
      'S5_BUNDLE_UNVERIFIED_CONTEXT',
      'source artifact byte resolution requires a verifier-branded materialization context',
    );
  }
  const artifact = VERIFIED_MATERIALIZATION_CONTEXT_METADATA.get(value).resolver.read(
    ref,
    'verifiedMaterializationContext.sourceArtifactBytes',
    ['sourceTree'],
  );
  return Object.freeze({
    bytes: Buffer.from(artifact.bytes),
    digest: artifact.digest,
    mediaType: artifact.mediaType,
    ref: frozenCompletedBundleCopy(ref),
  });
}

function verifiedS5ControlRecordChainMaterializationContexts(summary) {
  if (!summary || !VERIFIED_S5_CHAIN_SUMMARIES.has(summary)) {
    fail(
      'S5_CHAIN_UNVERIFIED_SUMMARY',
      'materialization-context projection requires the in-process result of S5 chain verification',
    );
  }
  return VERIFIED_S5_CHAIN_CONTEXTS.get(summary);
}

function verifiedMaterializationContextRunSlotId(value) {
  if (!isVerifiedMaterializationContext(value)) {
    fail(
      'S5_BUNDLE_UNVERIFIED_CONTEXT',
      'run-slot projection requires a verifier-branded materialization context',
    );
  }
  return VERIFIED_MATERIALIZATION_CONTEXT_METADATA.get(value).runSlotId;
}

function verifyS5ControlRecordChain(roots) {
  const resolver = createResolver(roots);
  const schemaManifestRef = pathRef('sourceTree', PROFILE_MANIFEST_REL);
  const schemaManifestArtifact = resolver.readJson(schemaManifestRef, 'schemaManifest', {
    allowedRoots: ['sourceTree'], exactJcs: true,
  });
  validateSchemaManifest(schemaManifestArtifact.value, resolver);
  const schemaManifestDigest = taggedJcsDigest(
    'axiolune-control-record-schema-manifest-v1\0', schemaManifestArtifact.value,
  );
  const toolLockRef = pathRef('sourceTree', TOOL_LOCK_REL);
  const toolLockArtifact = resolver.readJson(toolLockRef, 'toolLock', {
    allowedRoots: ['sourceTree'], exactJcs: true,
  });
  const toolLockState = validateToolLock(toolLockArtifact.value, resolver);
  const toolLockDigest = taggedJcsDigest('axiolune-tool-lock-v1\0', toolLockArtifact.value);
  const planRef = pathRef('buildEvidence', 'control-record-plan.json');
  const planArtifact = resolver.readJson(planRef, 'controlRecordPlan', {
    allowedRoots: ['buildEvidence'], exactJcs: true,
  });
  const planDigest = taggedJcsDigest('axiolune-control-record-plan-v1\0', planArtifact.value);
  const planAlternatives = validatePlan(planArtifact.value, resolver, schemaManifestDigest);
  const buildInputsRef = pathRef('buildEvidence', 'build-inputs.json');
  const buildInputsArtifact = resolver.readJson(buildInputsRef, 'buildInputs', {
    allowedRoots: ['buildEvidence'], exactJcs: true,
  });
  const sourceTreeState = verifyBuildInputs(
    buildInputsArtifact.value, resolver, planDigest, schemaManifestDigest, toolLockDigest,
  );
  const sourceTreeManifest = sourceTreeState.manifest;
  const inputBinding = buildInputsArtifact.value.inputs.find(
    (entry) => entry.name === 'controlChainInput',
  );
  if (!inputBinding) fail('S5_CHAIN_BUILD_INPUTS', 'controlChainInput binding missing');
  const inputArtifact = resolver.readJson(
    inputBinding.artifactRef,
    'controlChainInput',
    { allowedRoots: ['sourceTree'], exactJcs: true },
  );
  if (inputArtifact.digest !== inputBinding.artifactDigest) {
    fail('S5_CHAIN_BUILD_INPUTS', 'controlChainInput bytes drift');
  }
  const parsedInput = parseInput(inputArtifact.value, resolver);
  parsedInput.inputArtifactDigest = inputArtifact.digest;
  validateValuationExecutableEvidence(
    parsedInput.supportEvidence,
    inputArtifact.value.sourceSchemaRef,
    parsedInput.sourceSchemaArtifact.digest,
    toolLockRef,
    toolLockArtifact,
    toolLockState,
  );
  const expectedInputs = expectedControlChainInputBindings(
    inputBinding.artifactRef,
    inputArtifact.value,
    parsedInput,
  );
  if (canonicalJcs(buildInputsArtifact.value.inputs) !== canonicalJcs(expectedInputs)) {
    fail(
      'S5_CHAIN_BUILD_INPUTS',
      'build input binding inventory is not the exact control-chain source closure',
    );
  }
  validateMappingToolBindings(
    parsedInput.mappingData,
    toolLockState,
    inputArtifact.value.sourceSchemaRef,
    parsedInput.sourceSchemaArtifact.digest,
  );
  assertSourceTreeInventory(sourceTreeManifest, [
    inputBinding.artifactRef,
    schemaManifestRef,
    toolLockRef,
    inputArtifact.value,
    schemaManifestArtifact.value,
    toolLockArtifact.value,
    ...toolLockState.runtimeClosures.values(),
    parsedInput.sourceSchema,
    parsedInput.originalSnapshotArtifact.value,
    parsedInput.futureSnapshotArtifact.value,
    parsedInput.batchArtifact.value,
    parsedInput.identityCompilationArtifact.value,
    parsedInput.identityManifestArtifact.value,
    parsedInput.ontologyClosureArtifact.value,
    parsedInput.referenceClosureArtifact.value,
    parsedInput.reference.lock,
    parsedInput.reference.artifact.value,
    parsedInput.supportEvidence.closure,
    parsedInput.priorSupport.manifest,
    ...parsedInput.mappingData.flatMap((entry) => [
      entry.plan,
      ...entry.mappings.flatMap((mapping) => [mapping.mapping, mapping.closure]),
    ]),
  ], sourceTreeState.bindingKind);
  const buildInputsDigest = taggedJcsDigest('axiolune-build-inputs-v1\0', buildInputsArtifact.value);
  const buildId = artifactDigest(Buffer.concat([
    Buffer.from('axiolune-build-v1\0', 'utf8'),
    rawDigestBytes(buildInputsArtifact.value.sourceTreeDigest, 'sourceTreeDigest'),
    rawDigestBytes(toolLockDigest, 'toolLockDigest'),
    rawDigestBytes(buildInputsDigest, 'buildInputsDigest'),
  ]));
  const context = {
    buildId,
    buildInputsDigest,
    planDigest,
    schemaManifestDigest,
    sourceTreeDigest: buildInputsArtifact.value.sourceTreeDigest,
    toolLockDigest,
    referenceTime: instantEpoch(buildInputsArtifact.value.referenceTime, 'referenceTime'),
    reportTool: reportToolBinding(toolLockArtifact.value),
    resolver,
    recordArtifacts: new Map(),
    recordArtifactsByIri: new Map(),
  };

  const recordDirectory = path.join(resolver.roots.buildEvidence, 'records');
  if (!fs.existsSync(recordDirectory) || !fs.statSync(recordDirectory).isDirectory()) {
    fail('S5_CHAIN_RECORD_MISSING', 'records directory missing');
  }
  const fileNames = fs.readdirSync(recordDirectory).sort(utf8Compare);
  const ledgerFile = 'evidence-ledger.json';
  if (!fileNames.includes(ledgerFile)) fail('S5_CHAIN_RECORD_MISSING', 'evidence ledger missing');

  const provisional = new Map();
  for (const fileName of fileNames) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u.test(fileName)) {
      fail('S5_CHAIN_RECORD_EXTRA', `unexpected record filename ${fileName}`);
    }
    const slotId = fileName.slice(0, -5);
    const artifact = resolver.readJson(
      pathRef('buildEvidence', `records/${fileName}`),
      `records/${fileName}`,
      { allowedRoots: ['buildEvidence'], exactJcs: true },
    );
    const record = artifact.value;
    if (record.slotId !== slotId) fail('S5_CHAIN_RECORD_SCHEMA', `${fileName} slotId/filename mismatch`);
    provisional.set(slotId, { ...artifact, record, ref: pathRef('buildEvidence', `records/${fileName}`) });
  }
  context.recordArtifacts = provisional;
  context.recordArtifactsByIri = indexControlRecordsByIri(provisional);

  const outcomes = new Map();
  for (const [slotId, artifact] of provisional.entries()) {
    if (['materializationRun', 'materializationBatchRun'].includes(artifact.record.recordType)) {
      outcomes.set(slotId, artifact.record.result?.outcome);
    }
  }
  const active = activeAlternatives(planAlternatives, outcomes);
  validateStageDag(active);
  const expectedSlots = [...active.keys()].sort(utf8Compare);
  const actualSlots = [...provisional.keys()].sort(utf8Compare);
  if (expectedSlots.length !== actualSlots.length
      || expectedSlots.some((slotId, index) => slotId !== actualSlots[index])) {
    fail('S5_CHAIN_RECORD_EXTRA', 'materialized record set does not equal active plan slots');
  }

  const orderedForValidation = finalRecordValidationOrder(active);
  for (const slotId of orderedForValidation) {
    validateRecordByType(provisional.get(slotId).record, active.get(slotId), context);
  }

  const runByIri = new Map([...provisional.values()]
    .filter((artifact) => artifact.record.recordType === 'materializationRun')
    .map((artifact) => [artifact.record.iri, artifact]));
  const batchArtifact = [...provisional.values()].find((artifact) => artifact.record.recordType === 'materializationBatchRun');
  if (!batchArtifact || batchArtifact.record.result.outcome !== 'completed') {
    fail('S5_CHAIN_BATCH', 'one completed batch record is required');
  }
  for (const member of batchArtifact.record.result.members) {
    const runArtifact = runByIri.get(member.runRef);
    if (!runArtifact
        || runArtifact.digest !== member.runRecordDigest
        || runArtifact.record.result.outcome !== 'completed'
        || runArtifact.record.planRef !== member.planRef
        || runArtifact.record.result.outputGraph !== member.outputGraph
        || runArtifact.record.result.outputGraphDigest !== member.outputGraphDigest
        || runArtifact.record.sourceSnapshotRootDigest !== batchArtifact.record.sourceSnapshotRootDigest
        || runArtifact.record.ontologyClosureDigest !== batchArtifact.record.ontologyClosureDigest
        || runArtifact.record.referenceLockDigest !== batchArtifact.record.referenceLockDigest
        || canonicalJcs(runArtifact.record.build) !== canonicalJcs(batchArtifact.record.build)
        || runArtifact.record.assertionTime !== batchArtifact.record.assertionTime
        || runArtifact.record.referenceTime !== batchArtifact.record.referenceTime) {
      fail('S5_CHAIN_BATCH_MEMBER', `batch member ${member.planRef} closure drift`);
    }
  }
  const completedRuns = [...runByIri.values()].filter((artifact) => artifact.record.result.outcome === 'completed');
  if (completedRuns.length !== batchArtifact.record.result.members.length) {
    fail('S5_CHAIN_BATCH_MEMBER', 'batch does not close exactly over completed member runs');
  }

  const originalRdfRef = pathRef('buildEvidence', 'rdf/dataset-original.nq');
  const originalRdf = resolver.read(originalRdfRef, 'originalRdf', ['buildEvidence']);
  const replayRdf = resolver.read(pathRef('buildEvidence', 'rdf/dataset-replay.nq'), 'replayRdf', ['buildEvidence']);
  const futureRdf = resolver.read(pathRef('buildEvidence', 'rdf/dataset-future-append-challenge.nq'), 'futureRdf', ['buildEvidence']);
  const validationSupport = resolver.read(
    pathRef('buildEvidence', 'rdf/prior-support-input.nq'),
    'priorSupportInput',
    ['buildEvidence'],
  );
  if (validationSupport.digest !== parsedInput.priorSupport.datasetArtifact.digest
      || !validationSupport.bytes.equals(parsedInput.priorSupport.datasetArtifact.bytes)) {
    fail('S5_CHAIN_PRIOR_SUPPORT', 'stored prior support input differs from its source-chain bytes');
  }
  const runForGraph = (graphIri) => completedRuns.find((artifact) => (
    artifact.record.result.outputGraph === graphIri
  ));
  const identityRun = runForGraph(IDENTITY_GRAPH_IRI);
  const marketRun = runForGraph(MARKET_GRAPH_IRI);
  const portfolioRun = runForGraph(PORTFOLIO_GRAPH_IRI);
  if (!identityRun || !marketRun || !portfolioRun) {
    fail('S5_CHAIN_PRODUCER_REPLAY', 'stored run set cannot drive the canonical producer replay');
  }
  assertStoredProducerReplay({
    batchRunIri: batchArtifact.record.iri,
    futureBytes: futureRdf.bytes,
    futureRows: parsedInput.futureRows,
    identityRunIri: identityRun.record.iri,
    marketRunIri: marketRun.record.iri,
    originalBytes: originalRdf.bytes,
    originalRows: parsedInput.originalRows,
    portfolioRunIri: portfolioRun.record.iri,
    replayBytes: replayRdf.bytes,
    valuationPolicyArtifacts: parsedInput.supportEvidence.valuationPolicyArtifacts,
  });
  const graphIris = [
    ...batchArtifact.record.result.members.map((member) => member.outputGraph),
    `${batchArtifact.record.targetDataset}/provenance`,
  ].sort(utf8Compare);
  const originalDataset = computeDatasetDigest(originalRdf.bytes.toString('utf8'), graphIris);
  const replayDataset = computeDatasetDigest(replayRdf.bytes.toString('utf8'), graphIris);
  const futureDataset = computeDatasetDigest(futureRdf.bytes.toString('utf8'), graphIris);
  if (originalDataset.digest !== batchArtifact.record.result.outputDatasetDigest
      || originalDataset.digest !== replayDataset.digest
      || originalDataset.canonicalNQuads !== replayDataset.canonicalNQuads
      || originalDataset.digest !== futureDataset.digest
      || originalDataset.canonicalNQuads !== futureDataset.canonicalNQuads) {
    fail('S5_CHAIN_REPLAY_MISMATCH', 'stored original/replay/future challenge RDF digests drift');
  }
  for (const member of batchArtifact.record.result.members) {
    const graph = computeNamedGraphDigest(originalRdf.bytes.toString('utf8'), member.outputGraph);
    if (graph.digest !== member.outputGraphDigest) fail('S5_CHAIN_GRAPH_DIGEST', `${member.outputGraph} digest drift`);
    const runArtifact = runByIri.get(member.runRef);
    const reportArtifact = [...provisional.values()].find((candidate) => (
      candidate.digest === runArtifact.record.result.validationReportDigest
    ));
    const spec = MATERIALIZATION_RUN_SPECS.find(
      (candidate) => candidate.graphIri === member.outputGraph,
    );
    if (!spec) {
      fail('S5_CHAIN_GATE_EVIDENCE', `${member.outputGraph} has no current-domain SHACL specification`);
    }
    const graphOutputRef = pathRef(
      'buildEvidence',
      `rdf/graph-${spec.slug}.nq`,
    );
    const graphOutputArtifact = resolver.read(
      graphOutputRef,
      `${member.outputGraph} canonical single-graph output`,
      ['buildEvidence'],
    );
    const graphOutputText = graphOutputArtifact.bytes.toString('utf8');
    const graphOutput = computeNamedGraphDigest(graphOutputText, member.outputGraph);
    if (graphOutputArtifact.mediaType !== 'application/n-quads'
        || graphOutputText !== graph.canonicalNQuads
        || graphOutput.canonicalNQuads !== graphOutputText
        || graphOutput.digest !== graph.digest) {
      fail(
        'S5_CHAIN_GRAPH_DIGEST',
        `${member.outputGraph} canonical single-graph artifact differs from the batch dataset`,
      );
    }
    const shaclEvidenceRef = pathRef(
      'buildEvidence',
      `gate-evidence/current-domain-shacl-${spec.slug}.json`,
    );
    const shaclEvidenceArtifact = resolver.readJson(shaclEvidenceRef, 'stored current-domain SHACL evidence', {
      allowedRoots: ['buildEvidence'], exactJcs: true,
    });
    const replayedShacl = runMaterializedCurrentDomainShacl(
      resolver,
      parsedInput.ontology,
      spec.moduleIri,
      { nquads: originalRdf.bytes.toString('utf8') },
      validationSupport.bytes.toString('utf8'),
      member.outputGraph,
      spec.validationModuleIris,
    );
    const customEvidenceRef = pathRef(
      'buildEvidence',
      `gate-evidence/applicable-custom-${spec.slug}.json`,
    );
    const customEvidenceArtifact = resolver.readJson(
      customEvidenceRef,
      'stored applicable Custom evidence',
      { allowedRoots: ['buildEvidence'], exactJcs: true },
    );
    const replayedCustom = runMaterializedApplicableCustom(
      resolver,
      parsedInput.ontology,
      { nquads: originalRdf.bytes.toString('utf8') },
      validationSupport.bytes.toString('utf8'),
      parsedInput.supportEvidence,
      member.outputGraph,
      inputArtifact.value.execution,
      [
        ...batchArtifact.record.result.members.map((entry) => entry.runRef),
        ...parsedInput.priorSupport.allowedRunIris,
      ].sort(utf8Compare),
    );
    const evidenceRef = pathRef(
      'buildEvidence',
      `gate-evidence/materialized-validation-${spec.slug}.json`,
    );
    const evidenceArtifact = resolver.readJson(
      evidenceRef,
      'stored combined materialized validation evidence',
      { allowedRoots: ['buildEvidence'], exactJcs: true },
    );
    const expectedCombinedEvidence = {
      artifactKind: 's5MaterializedSHACLAndApplicableCustomEvidence',
      checks: [
        {
          artifactDigest: customEvidenceArtifact.digest,
          artifactRef: customEvidenceRef,
          kind: 'applicableCustom',
        },
        {
          artifactDigest: shaclEvidenceArtifact.digest,
          artifactRef: shaclEvidenceRef,
          kind: 'currentDomainSHACL',
        },
      ],
      outcome: 'passed',
      schemaVersion: '1.0',
      supportDatasetDigest: validationSupport.digest,
      targetGraphIri: member.outputGraph,
    };
    if (!reportArtifact
        || reportArtifact.record.recordType !== 'validationReport'
        || reportArtifact.record.reportKind !== 'mapping'
        || !refsEqual(reportArtifact.record.subjectRef, graphOutputRef)
        || !refsEqual(reportArtifact.record.kindEvidence.artifactRef, evidenceRef)
        || reportArtifact.record.kindEvidence.artifactDigest !== evidenceArtifact.digest
        || canonicalJcs(shaclEvidenceArtifact.value) !== canonicalJcs(replayedShacl.evidence)
        || canonicalJcs(customEvidenceArtifact.value) !== canonicalJcs(replayedCustom.evidence)
        || canonicalJcs(evidenceArtifact.value) !== canonicalJcs(expectedCombinedEvidence)
        || reportArtifact.record.result.checks.length !== 1
        || reportArtifact.record.result.checks[0].subjectDigest !== graph.digest
        || canonicalJcs(reportArtifact.record.result.checks[0].outputDigests)
          !== canonicalJcs([graph.digest])) {
      fail('S5_CHAIN_GATE_EVIDENCE', `${member.outputGraph} run report does not bind its exact graph digest`);
    }
  }

  const replayArtifact = [...provisional.values()].find((artifact) => artifact.record.recordType === 'replayReport');
  const pitArtifact = [...provisional.values()].find((artifact) => artifact.record.recordType === 'pitRequest');
  if (!replayArtifact || !pitArtifact
      || replayArtifact.record.originalContextRecordDigest !== batchArtifact.digest
      || replayArtifact.record.originalTargetDigest !== originalDataset.digest
      || pitArtifact.record.materializationContext.recordDigest !== batchArtifact.digest
      || pitArtifact.record.materializationContext.targetDatasetDigest !== originalDataset.digest) {
    fail('S5_CHAIN_CONTEXT_CLOSURE', 'PIT/replay context does not close over the batch bytes');
  }
  const batchReportArtifact = [...provisional.values()].find((candidate) => (
    candidate.digest === batchArtifact.record.result.validationReportDigest
  ));
  if (!batchReportArtifact
      || batchReportArtifact.record.recordType !== 'validationReport'
      || batchReportArtifact.record.reportKind !== 'batch'
      || !refsEqual(batchReportArtifact.record.subjectRef, originalRdfRef)
      || !refsEqual(batchReportArtifact.record.kindEvidence.artifactRef, originalRdfRef)
      || batchReportArtifact.record.kindEvidence.artifactDigest !== originalRdf.digest
      || batchReportArtifact.record.result.checks.length !== 1
      || batchReportArtifact.record.result.checks[0].subjectDigest !== originalDataset.digest
      || canonicalJcs(batchReportArtifact.record.result.checks[0].outputDigests)
        !== canonicalJcs([originalDataset.digest])) {
    fail('S5_CHAIN_GATE_EVIDENCE', 'batch report does not bind the exact canonical dataset digest');
  }
  const pitReportArtifact = provisional.get('pit-report');
  const recomputedPitSelection = evaluatePitSelection(originalRdf.bytes.toString('utf8'), {
    asOfAvailable: pitArtifact.record.asOfAvailable,
    asOfKnowledge: pitArtifact.record.asOfKnowledge,
    asOfValid: pitArtifact.record.asOfValid,
  });
  if (!pitReportArtifact
      || pitReportArtifact.record.recordType !== 'validationReport'
      || pitReportArtifact.record.reportKind !== 'pit'
      || pitReportArtifact.record.requestRecordDigest !== pitArtifact.digest
      || pitReportArtifact.record.requestRef !== pitArtifact.record.iri
      || pitReportArtifact.record.contextRecordDigest !== batchArtifact.digest
      || pitReportArtifact.record.contextRef !== batchArtifact.record.iri
      || pitReportArtifact.record.recomputedTargetDigest !== originalDataset.digest
      || pitReportArtifact.record.asOfValid !== pitArtifact.record.asOfValid
      || pitReportArtifact.record.asOfKnowledge !== pitArtifact.record.asOfKnowledge
      || pitReportArtifact.record.asOfAvailable !== pitArtifact.record.asOfAvailable
      || canonicalJcs({
        selectedFactVersionCount: pitReportArtifact.record.selectedFactVersionCount,
        selectedFactVersionIris: pitReportArtifact.record.selectedFactVersionIris,
        selectedFactVersionSetDigest: pitReportArtifact.record.selectedFactVersionSetDigest,
      }) !== canonicalJcs(recomputedPitSelection)
      || !refsEqual(pitReportArtifact.record.subjectRef, pitArtifact.ref)
      || pitReportArtifact.record.result.checks[0].subjectDigest !== pitArtifact.digest
      || canonicalJcs(pitReportArtifact.record.result.checks[0].outputDigests)
        !== canonicalJcs([originalDataset.digest, pitArtifact.digest].sort(utf8Compare))) {
    fail('S5_CHAIN_PIT_REPORT', 'PIT ValidationReport does not bind request/context/target/pivots exactly');
  }
  const pitEvidenceArtifact = resolver.readJson(
    pitReportArtifact.record.kindEvidence.artifactRef,
    'pitReport.kindEvidence.artifactRef',
    { allowedRoots: ['buildEvidence'], exactJcs: true },
  );
  const expectedPitEvidence = {
    asOfAvailable: pitArtifact.record.asOfAvailable,
    asOfKnowledge: pitArtifact.record.asOfKnowledge,
    asOfValid: pitArtifact.record.asOfValid,
    contextRecordDigest: batchArtifact.digest,
    outcome: 'passed',
    recomputedTargetDigest: originalDataset.digest,
    requestRecordDigest: pitArtifact.digest,
    schemaVersion: '1.0',
    ...recomputedPitSelection,
  };
  if (pitEvidenceArtifact.digest !== pitReportArtifact.record.kindEvidence.artifactDigest
      || canonicalJcs(pitEvidenceArtifact.value) !== canonicalJcs(expectedPitEvidence)) {
    fail('S5_CHAIN_PIT_REPORT', 'PIT executable evidence does not independently recompute');
  }

  const originalSelection = historicalSelectionDigest(parsedInput.originalRows);
  const futureSelection = historicalSelectionDigest(parsedInput.futureRows);
  const memberGraphs = new Map(batchArtifact.record.result.members.map((member) => [
    member.outputGraph,
    {
      original: computeNamedGraphDigest(originalRdf.bytes.toString('utf8'), member.outputGraph).digest,
      replay: computeNamedGraphDigest(replayRdf.bytes.toString('utf8'), member.outputGraph).digest,
    },
  ]));
  const expectedComparisons = new Map([
    ['batchDataset', {
      ref: pathRef('buildEvidence', 'rdf/dataset-replay.nq'),
      original: originalDataset.digest,
      replay: replayDataset.digest,
    }],
    ['futureAppendHistoricalDataset', {
      ref: pathRef('buildEvidence', 'rdf/dataset-future-append-challenge.nq'),
      original: originalDataset.digest,
      replay: futureDataset.digest,
    }],
    ['futureAppendHistoricalSelection', {
      ref: pathRef('buildEvidence', 'rdf/dataset-future-append-challenge.nq'),
      original: originalSelection,
      replay: futureSelection,
    }],
    ...MATERIALIZATION_RUN_SPECS.map((spec) => [
      spec.replayName,
      {
        ref: pathRef('buildEvidence', 'rdf/dataset-replay.nq'),
        original: memberGraphs.get(spec.graphIri)?.original,
        replay: memberGraphs.get(spec.graphIri)?.replay,
      },
    ]),
  ]);
  const actualComparisons = new Map(replayArtifact.record.result.comparisons.map((entry) => [entry.name, entry]));
  if (actualComparisons.size !== expectedComparisons.size) {
    fail('S5_CHAIN_REPLAY_RESULT', 'ReplayReport comparison inventory is incomplete/extra');
  }
  for (const [name, expected] of expectedComparisons.entries()) {
    const actual = actualComparisons.get(name);
    if (!actual
        || !expected.original || !expected.replay
        || !refsEqual(actual.artifactRef, expected.ref)
        || actual.originalDigest !== expected.original
        || actual.replayDigest !== expected.replay
        || actual.equal !== (expected.original === expected.replay)) {
      fail('S5_CHAIN_REPLAY_RESULT', `ReplayReport comparison ${name} does not recompute`);
    }
  }
  const combinedMappings = completedRuns.flatMap((artifact) => artifact.record.mappingClosure);
  const combinedMappingKeys = new Set(combinedMappings.map((entry) => entry.mappingRef));
  if (combinedMappingKeys.size !== combinedMappings.length
      || replayArtifact.record.replayMappingClosureDigest !== mappingClosureDigest(combinedMappings)
      || replayArtifact.record.replayOntologyClosureDigest !== batchArtifact.record.ontologyClosureDigest
      || replayArtifact.record.replayReferenceLockDigest !== batchArtifact.record.referenceLockDigest
      || replayArtifact.record.replaySourceSnapshotRootDigest !== batchArtifact.record.sourceSnapshotRootDigest
      || replayArtifact.record.replayToolLockDigest !== toolLockDigest
      || !refsEqual(replayArtifact.record.originalTargetRef, pathRef('buildEvidence', 'rdf/dataset-original.nq'))) {
    fail('S5_CHAIN_REPLAY_CONTEXT', 'ReplayReport closure/input bindings do not recompute');
  }
  const ledgerArtifact = provisional.get('evidence-ledger');
  const ledger = ledgerArtifact.record;
  const summary = {
    buildEvidenceBindingVerified: sourceTreeState.bindingKind === 'gitCommit',
    buildId,
    canonicalization: 'RDFC-1.0',
    evidenceClass: sourceTreeState.bindingKind === 'gitCommit'
      ? 'stable-git-source-tree-control-record-chain'
      : 'cq-source-closure-control-record-chain',
    evidenceLedgerDigest: taggedJcsDigest('axiolune-evidence-ledger-v1\0', ledger),
    failedAuditRecords: [...provisional.values()].filter((artifact) => (
      artifact.record.recordType === 'materializationRun'
      && artifact.record.result.outcome === 'failed'
    )).length,
    futureAppendHistoricalDigest: futureDataset.digest,
    outputDatasetDigest: originalDataset.digest,
    passedControlRecords: provisional.size - 2,
    recordCount: provisional.size,
    recordTypeCounts: Object.fromEntries(Object.keys(RECORD_TYPE_ID_FIELD).sort(utf8Compare).map((type) => [
      type,
      [...provisional.values()].filter((artifact) => artifact.record.recordType === type).length,
    ])),
    releaseEvidence: false,
    releaseLifecycleStatus: 'pending-final-p0-p1-build-evidence-binding',
    replayDigest: replayDataset.digest,
    schemaVersion: '1.0',
    semanticEvidence: true,
    sourceTreeBindingKind: sourceTreeState.bindingKind,
    sourceTreeFileCount: sourceTreeManifest.files.length,
  };
  if (sourceTreeState.selector !== null) {
    summary.sourceCommitId = sourceTreeState.selector.commitId;
    summary.sourceTreeId = sourceTreeState.selector.treeId;
  }
  const materializationContexts = Object.freeze(completedRuns
    .sort((left, right) => utf8Compare(left.record.iri, right.record.iri))
    .map((runArtifact) => {
      const materializationContext = Object.freeze({
        contextKind: 'materializationRun',
        evidenceLedgerRecordDigest: ledgerArtifact.digest,
        evidenceLedgerRef: ledger.iri,
        ledgerVerified: true,
        outcome: 'completed',
        recordDigest: runArtifact.digest,
        recordRef: runArtifact.record.iri,
        referenceTime: runArtifact.record.referenceTime,
        targetGraph: runArtifact.record.result.outputGraph,
        targetGraphDigest: runArtifact.record.result.outputGraphDigest,
        verificationKind: 'verifiedCompletedMaterializationContext',
      });
      VERIFIED_MATERIALIZATION_CONTEXTS.add(materializationContext);
      VERIFIED_MATERIALIZATION_CONTEXT_METADATA.set(
        materializationContext,
        Object.freeze({
          build: frozenCompletedBundleCopy(runArtifact.record.build),
          resolver,
          runSlotId: runArtifact.record.slotId,
        }),
      );
      return materializationContext;
    }));
  const frozenSummary = Object.freeze(summary);
  VERIFIED_S5_CHAIN_SUMMARIES.add(frozenSummary);
  VERIFIED_S5_CHAIN_CONTEXTS.set(frozenSummary, materializationContexts);
  return frozenSummary;
}

module.exports = {
  CONTROL_CHAIN_VERSION,
  INPUT_FIXTURE_REL,
  PROFILE_DEFINITIONS,
  PROFILE_MANIFEST_REL,
  PROFILE_REF,
  PROFILE_REFERENCE_FIELDS,
  PROFILE_ROOT_REL,
  RDFC_CAPABILITY_CONTRACTS,
  RECORD_FIELDS,
  RECORD_TYPE_ID_FIELD,
  RESOLVED_PROJECTION_FIELDS,
  S5ControlChainError,
  TOOL_LOCK_REL,
  VALIDATION_PIT_EXTRA_FIELDS,
  absoluteIri,
  artifactDigest,
  assertRdfcCapabilityContractValue,
  assertStoredProducerReplay,
  canonicalRecordBytes,
  controlRecordIri,
  createS5ControlRecordChain,
  historicalSelectionDigest,
  indexControlRecordsByIri,
  instantEpoch,
  materializeHistoricalDataset: materializeCanonicalHistoricalDataset,
  plannedInputDigest,
  projectResolvedInput,
  recordDigest,
  resolvedInputDigest,
  sourceSchemaClosureDigest,
  sourceSnapshotRootDigest,
  sourceTreeDigest,
  taggedJcsDigest,
  validateControlRecordRef,
  validatePlannedInput,
  isVerifiedMaterializationContext,
  verifyCompletedMaterializationRunBundle,
  verifyS5ControlRecordChain,
  verifiedMaterializationContextBuild,
  verifiedMaterializationContextRunSlotId,
  verifiedMaterializationContextSourceArtifact,
  verifiedMaterializationContextSourceArtifactBytes,
  verifiedMaterializationRunContext,
  verifiedS5ControlRecordChainMaterializationContexts,
};
