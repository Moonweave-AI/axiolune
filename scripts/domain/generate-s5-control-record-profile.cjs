#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const {
  CONTROL_CHAIN_VERSION,
  PROFILE_DEFINITIONS,
  PROFILE_MANIFEST_REL,
  PROFILE_ROOT_REL,
  RDFC_CAPABILITY_CONTRACTS,
  artifactDigest,
  taggedJcsDigest,
} = require('./lib/s5-control-record-chain.cjs');
const {
  TAGS: IDENTITY_TAGS,
  compileIdentityContracts,
} = require('./lib/identity-contract-compiler.cjs');
const {
  SUPPORT_GRAPH_IRI,
  materializePriorSupportDataset,
} = require('./lib/s5-canonical-materialization.cjs');
const {
  canonicalJcs,
  computeSelectionDigest,
} = require('./lib/strict-source-locator.cjs');
const {
  computeNamedGraphDigest,
} = require('./lib/rdfc-1.0.cjs');
const {
  recordSetDigest,
} = require('./lib/portfolio-observation-stream-closure.cjs');
const {
  normalizeOntologyIr,
  selectedImportSymbolIris,
  sortUniqueOntologyImportRows,
} = require('./lib/ontology-ir-normalizer.cjs');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE_ROOT_REL = 'tests/m2/fixtures/slice-a/cq-v03/s5/control-chain';
const FIXTURE_SOURCE_REL = `${FIXTURE_ROOT_REL}/source`;
const SLICE_IDENTITY_ROOT_REL = 'mappings/finance/v0.3.0/slice-a-s5';
const TEST_VECTOR_REL = 'scripts/domain/tests/test-s5-control-record-chain.cjs';
const RDFC_TEST_VECTOR_REL = 'scripts/domain/tests/test-rdfc-1.0.cjs';

function ref(relativePath) {
  return { kind: 'path', root: 'sourceTree', path: relativePath };
}

function jcsBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function digestOf(outputs, relativePath) {
  if (outputs.has(relativePath)) return artifactDigest(outputs.get(relativePath));
  const absolute = path.join(ROOT, ...relativePath.split('/'));
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`required profile dependency is missing: ${relativePath}`);
  }
  return artifactDigest(fs.readFileSync(absolute));
}

function put(outputs, relativePath, value) {
  outputs.set(relativePath, jcsBytes(value));
}

function putBytes(outputs, relativePath, bytes) {
  outputs.set(relativePath, Buffer.from(bytes));
}

function u64be(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
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

function runtimeClosure(outputs, runtimeId, entries) {
  return {
    entries: entries
      .map(({ relativePath, role }) => ({
        artifactDigest: digestOf(outputs, relativePath),
        artifactRef: ref(relativePath),
        role,
      }))
      .sort((left, right) => Buffer.compare(
        Buffer.from(canonicalJcs(left.artifactRef), 'utf8'),
        Buffer.from(canonicalJcs(right.artifactRef), 'utf8'),
      )),
    runtimeId,
    schemaVersion: '1.0',
  };
}

function schemaArtifact(recordType, kind, required, conditional = {}, referenceFields = {}) {
  return {
    additionalProperties: false,
    conditional,
    kind,
    recordType,
    referenceFields,
    required: [...required].sort(),
    schemaVersion: '1.0',
  };
}

function createOutputs() {
  const outputs = new Map();

  for (const [recordType, definition] of Object.entries(PROFILE_DEFINITIONS)) {
    put(
      outputs,
      `${PROFILE_ROOT_REL}/${recordType}.planned-input.schema.json`,
      schemaArtifact(recordType, 'plannedInputSchema', definition.plannedInputRequired),
    );
    put(
      outputs,
      `${PROFILE_ROOT_REL}/${recordType}.resolved-input.projection.json`,
      schemaArtifact(recordType, 'resolvedInputProjection', definition.resolvedInputRequired),
    );
    put(
      outputs,
      `${PROFILE_ROOT_REL}/${recordType}.record.schema.json`,
      schemaArtifact(
        recordType,
        'recordSchema',
        definition.recordRequired,
        definition.conditionalRecordFields,
        definition.referenceFields,
      ),
    );
  }

  const manifest = {
    recordTypes: Object.keys(PROFILE_DEFINITIONS).sort().map((recordType) => {
      const planned = `${PROFILE_ROOT_REL}/${recordType}.planned-input.schema.json`;
      const resolved = `${PROFILE_ROOT_REL}/${recordType}.resolved-input.projection.json`;
      const record = `${PROFILE_ROOT_REL}/${recordType}.record.schema.json`;
      return {
        plannedInputSchemaDigest: digestOf(outputs, planned),
        plannedInputSchemaRef: ref(planned),
        recordSchemaDigest: digestOf(outputs, record),
        recordSchemaRef: ref(record),
        recordType,
        resolvedInputProjectionDigest: digestOf(outputs, resolved),
        resolvedInputProjectionRef: ref(resolved),
      };
    }),
    schemaVersion: '1.0',
  };
  put(outputs, PROFILE_MANIFEST_REL, manifest);

  const capabilityContracts = {
    'capability-input-contract.json': {
      additionalArgumentsProhibited: true,
      arguments: [
        { name: 'inputRef', type: 'ArtifactRef' },
        { name: 'roots', type: 'ResolverRoots' },
        { default: {}, name: 'options', type: 'GenerationOptions' },
      ],
      entrypoint: 'createS5ControlRecordChain',
      generationOptions: {
        additionalProperties: false,
        optional: ['sourceTreeSelector'],
      },
      schemaVersion: '1.0',
    },
    'capability-output-contract.json': {
      additionalProperties: false,
      entrypoint: 'verifyS5ControlRecordChain',
      sourceTreeBindingConditional: {
        gitCommit: {
          required: ['sourceCommitId', 'sourceTreeId'],
        },
        sourceClosure: {
          prohibited: ['sourceCommitId', 'sourceTreeId'],
        },
      },
      required: [
        'buildEvidenceBindingVerified', 'buildId', 'canonicalization',
        'evidenceClass', 'evidenceLedgerDigest', 'failedAuditRecords',
        'futureAppendHistoricalDigest', 'outputDatasetDigest', 'recordCount',
        'passedControlRecords', 'recordTypeCounts', 'releaseEvidence',
        'releaseLifecycleStatus', 'replayDigest', 'schemaVersion',
        'semanticEvidence', 'sourceTreeBindingKind', 'sourceTreeFileCount',
      ],
      schemaVersion: '1.0',
    },
    'gate-discovery-contract.json': {
      additionalProperties: false,
      algorithm: 'one semantic named graph, batch dataset, or PIT request per report',
      subjectIdDigestTag: 'axiolune-gate-subject-v1\\0',
      subjectKinds: ['batchDataset', 'namedGraph', 'pitRequest'],
      schemaVersion: '1.0',
    },
    'gate-evidence-schema.json': {
      additionalProperties: false,
      evidenceKinds: ['application/n-quads', 'application/json'],
      requiresNonEmptyBytes: true,
      schemaVersion: '1.0',
    },
    'materialization-capability-input-contract.json': {
      additionalArgumentsProhibited: true,
      arguments: [
        { name: 'rows', type: 'array' },
        { name: 'identityRunIri', type: 'absoluteIri' },
        { name: 'marketRunIri', type: 'absoluteIri' },
        { name: 'portfolioRunIri', type: 'absoluteIri' },
        { name: 'batchRunIri', type: 'absoluteIri' },
        { default: {}, name: 'options', type: 'MaterializationOptions' },
      ],
      entrypoint: 'materializeHistoricalDataset',
      options: {
        additionalProperties: false,
        optional: ['reverse'],
        required: ['valuationPolicyArtifacts'],
      },
      rowContract: 'the exact digest-locked source schema carried by each mapping closure',
      schemaVersion: '1.0',
      valuationPolicyArtifacts: {
        additionalProperties: false,
        required: ['precisionBytes', 'roundingBytes'],
      },
    },
    'materialization-capability-output-contract.json': {
      additionalProperties: false,
      canonicalRdfMediaType: 'application/n-quads',
      entrypoint: 'materializeHistoricalDataset',
      identityKeys: [
        'holding', 'identifier', 'observation', 'positionValuation',
        'security', 'stream', 'valuationHeader',
      ],
      memberGraphIris: [
        'urn:axiolune:graph:slice-a:identity:v1',
        'urn:axiolune:graph:slice-a:market-data:v1',
        'urn:axiolune:graph:slice-a:portfolio-valuation:v1',
      ],
      priorSupportOutputProhibited: true,
      required: ['graphIris', 'identities', 'memberGraphIris', 'nquads', 'targetDataset'],
      schemaVersion: '1.0',
      targetDataset: 'urn:axiolune:dataset:slice-a:control-chain:v1',
      valueObjectRequirements: {
        Money: ['hasAmount', 'hasCurrency', 'hasScale'],
        Quantity: ['hasNumericValue', 'hasPrecision', 'hasRounding', 'hasUnit'],
      },
    },
    'materialization-discovery-contract.json': {
      additionalProperties: false,
      entrypoint: 'materializeHistoricalDataset',
      schemaVersion: '1.0',
      transformationEntrypoint: 'executeCanonicalTransformation',
      transformationRefs: [
        'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/transformation/direct-unit-price-times-quantity',
        'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/transformation/money-value',
        'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/transformation/quantity-value',
      ],
    },
    'materialization-evidence-schema.json': {
      additionalProperties: false,
      outputMediaType: 'application/n-quads',
      requiresExactSourceRows: true,
      requiresIdentityClosure: true,
      requiresPolicyArtifactBytes: ['precisionBytes', 'roundingBytes'],
      requiresProducerReplay: true,
      schemaVersion: '1.0',
    },
    ...RDFC_CAPABILITY_CONTRACTS,
  };
  for (const [name, value] of Object.entries(capabilityContracts)) {
    put(outputs, `${PROFILE_ROOT_REL}/${name}`, value);
  }

  const libRel = 'scripts/domain/lib/s5-control-record-chain.cjs';
  const rdfcRel = 'scripts/domain/lib/rdfc-1.0.cjs';
  const workerRel = 'scripts/domain/lib/rdfc-1.0-worker.cjs';
  const strictLocatorRel = 'scripts/domain/lib/strict-source-locator.cjs';
  const strictJsonRel = 'scripts/domain/lib/json-pointer-source-extractor.cjs';
  const gitReplayRel = 'scripts/domain/lib/m2-git-replay.cjs';
  const canonicalMaterializerRel = 'scripts/domain/lib/s5-canonical-materialization.cjs';
  const completedProducerReplayRel =
    'scripts/domain/lib/s5-completed-run-producer-replay.cjs';
  const identityCompilerRel = 'scripts/domain/lib/identity-contract-compiler.cjs';
  const constraintAuditRel = 'scripts/domain/lib/m2-constraint-instance-audit.cjs';
  const constraintGateJoinRel = 'scripts/domain/lib/m2-constraint-instance-gate-join.cjs';
  const priorSupportVerifierRel = 'scripts/domain/lib/s5-prior-support-chain.cjs';
  const customValidationRel = 'scripts/domain/lib/s5-materialized-custom-validation.cjs';
  const customWorkerRel = 'scripts/domain/lib/s5-materialized-custom-worker.cjs';
  const portfolioObservationClosureRel =
    'scripts/domain/lib/portfolio-observation-stream-closure.cjs';
  const portfolioReconciliationEvidenceRel =
    'scripts/domain/lib/orders-portfolio-reconciliation-evidence.cjs';
  const ordersPortfolioAdapterRel =
    'scripts/domain/lib/orders-portfolio-canonical-record-adapter.cjs';
  const ordersPortfolioValidatorsRel =
    'scripts/domain/lib/orders-portfolio-custom-validators.cjs';
  const ordersPortfolioArithmeticRel =
    'scripts/domain/lib/orders-portfolio-exact-arithmetic.cjs';
  const ordersPortfolioReferenceRegistryRel =
    'scripts/domain/lib/orders-portfolio-reference-registry.cjs';
  const ordersPortfolioInputContractRel =
    'scripts/domain/orders-portfolio-custom-profile/v0.3.0/input-contract.json';
  const ordersPortfolioReferenceRegistryArtifactRel =
    'scripts/domain/orders-portfolio-custom-profile/v0.3.0/reference-registry.json';
  const portfolioReconciliationProducerInputsRel =
    'scripts/domain/orders-portfolio-custom-profile/v0.3.0/portfolio-reconciliation-producer-inputs.json';
  const shaclWorkerRel = 'scripts/domain/lib/s5-materialized-shacl-worker.cjs';
  const shaclPythonWorkerRel = 'scripts/domain/shacl-instance-profile/v0.3.0/s5-materialized-graph-worker.py';
  const shaclRuntimeProbeRel = 'scripts/domain/lib/s5-pyshacl-runtime-probe.cjs';
  const shaclGeneratorRel = 'scripts/domain/generate-m2-shacl.cjs';
  const typedProjectionRel = 'scripts/domain/lib/typed-projection-common.cjs';
  const ontologyIrNormalizerRel = 'scripts/domain/lib/ontology-ir-normalizer.cjs';
  const directSparqlRel = 'scripts/domain/lib/direct-sparql-select.cjs';
  const instantLexicalRel = 'scripts/domain/lib/instant-lexical.cjs';
  const patternFieldsRel = 'scripts/domain/lib/pattern-injected-fields.cjs';
  const shaclRequirementsRel = 'docs/domain/infrastructure/requirements-shacl.txt';
  const packageRel = 'package.json';
  const packageLockRel = 'package-lock.json';
  const rdfcRuntimeRel = `${PROFILE_ROOT_REL}/rdfc-runtime-closure.json`;
  const s5RuntimeRel = `${PROFILE_ROOT_REL}/s5-runtime-closure.json`;
  const materializerRuntimeRel = `${PROFILE_ROOT_REL}/materialization-runtime-closure.json`;
  put(outputs, rdfcRuntimeRel, runtimeClosure(outputs, 'rdf-canonize-runtime-v1', [
    { relativePath: workerRel, role: 'canonicalization-worker' },
    { relativePath: packageRel, role: 'dependency-contract' },
    { relativePath: packageLockRel, role: 'dependency-lock' },
  ]));
  put(outputs, s5RuntimeRel, runtimeClosure(outputs, 's5-control-chain-runtime-v1', [
    { relativePath: canonicalMaterializerRel, role: 'canonical-m2-materializer' },
    {
      relativePath: completedProducerReplayRel,
      role: 'completed-run-verifier-owned-producer-replay',
    },
    { relativePath: identityCompilerRel, role: 'identity-contract-and-version-key-runtime' },
    { relativePath: instantLexicalRel, role: 'utc-instant-lexical-runtime' },
    { relativePath: priorSupportVerifierRel, role: 'prior-support-control-chain-verifier' },
    { relativePath: constraintAuditRel, role: 'constraint-instance-id-and-discovery-runtime' },
    { relativePath: constraintGateJoinRel, role: 'constraint-instance-gate-join-runtime' },
    { relativePath: customValidationRel, role: 'materialized-applicable-custom-validator' },
    { relativePath: customWorkerRel, role: 'materialized-applicable-custom-driver' },
    {
      relativePath: portfolioObservationClosureRel,
      role: 'portfolio-observation-page-completeness-and-row-locator-verifier',
    },
    {
      relativePath: portfolioReconciliationEvidenceRel,
      role: 'portfolio-reconciliation-verifier-owned-projection',
    },
    {
      relativePath: ordersPortfolioAdapterRel,
      role: 'orders-portfolio-canonical-record-adapter',
    },
    {
      relativePath: ordersPortfolioValidatorsRel,
      role: 'orders-portfolio-custom-validator',
    },
    {
      relativePath: ordersPortfolioArithmeticRel,
      role: 'orders-portfolio-exact-arithmetic',
    },
    {
      relativePath: ordersPortfolioReferenceRegistryRel,
      role: 'orders-portfolio-reference-registry-runtime',
    },
    {
      relativePath: ordersPortfolioInputContractRel,
      role: 'orders-portfolio-canonical-input-contract',
    },
    {
      relativePath: ordersPortfolioReferenceRegistryArtifactRel,
      role: 'orders-portfolio-reference-registry-artifact',
    },
    {
      relativePath: portfolioReconciliationProducerInputsRel,
      role: 'portfolio-reconciliation-upstream-producer-input-inventory',
    },
    { relativePath: shaclWorkerRel, role: 'materialized-current-domain-shacl-driver' },
    { relativePath: shaclPythonWorkerRel, role: 'pinned-pyshacl-worker' },
    { relativePath: shaclRuntimeProbeRel, role: 'pinned-python-runtime-probe' },
    { relativePath: shaclGeneratorRel, role: 'current-domain-shacl-projector' },
    { relativePath: typedProjectionRel, role: 'current-m2-typed-validator' },
    { relativePath: ontologyIrNormalizerRel, role: 'set-semantic-ontology-ir-normalizer' },
    { relativePath: directSparqlRel, role: 'direct-sparql-profile' },
    { relativePath: patternFieldsRel, role: 'pattern-field-projection' },
    { relativePath: shaclRequirementsRel, role: 'pyshacl-version-pin' },
    { relativePath: 'ontology/domain/finance/foundation/module.shacl.ttl', role: 'identity-current-domain-shacl-sidecar' },
    { relativePath: 'ontology/domain/finance/instruments/module.shacl.ttl', role: 'instrument-support-current-domain-shacl-sidecar' },
    { relativePath: 'ontology/domain/finance/market-data/module.shacl.ttl', role: 'market-data-current-domain-shacl-sidecar' },
    { relativePath: 'ontology/domain/finance/market-structure/module.shacl.ttl', role: 'market-structure-support-current-domain-shacl-sidecar' },
    { relativePath: 'ontology/domain/finance/portfolio-positions/module.shacl.ttl', role: 'portfolio-current-domain-shacl-sidecar' },
    { relativePath: gitReplayRel, role: 'git-object-replay-runtime' },
    { relativePath: strictJsonRel, role: 'strict-json-parser' },
    { relativePath: strictLocatorRel, role: 'artifact-reference-and-jcs-runtime' },
    { relativePath: rdfcRel, role: 'rdf-canonicalization-runtime' },
    { relativePath: workerRel, role: 'rdf-canonicalization-worker' },
    { relativePath: packageRel, role: 'dependency-contract' },
    { relativePath: packageLockRel, role: 'dependency-lock' },
  ]));
  put(outputs, materializerRuntimeRel, runtimeClosure(
    outputs,
    's5-canonical-materialization-runtime-v1',
    [
      { relativePath: canonicalMaterializerRel, role: 'canonical-m2-materializer' },
      { relativePath: identityCompilerRel, role: 'identity-contract-and-version-key-runtime' },
      { relativePath: strictLocatorRel, role: 'artifact-reference-and-jcs-runtime' },
      { relativePath: packageRel, role: 'dependency-contract' },
      { relativePath: packageLockRel, role: 'dependency-lock' },
    ],
  ));
  const inputContractRel = `${PROFILE_ROOT_REL}/capability-input-contract.json`;
  const outputContractRel = `${PROFILE_ROOT_REL}/capability-output-contract.json`;
  const discoveryRel = `${PROFILE_ROOT_REL}/gate-discovery-contract.json`;
  const evidenceRel = `${PROFILE_ROOT_REL}/gate-evidence-schema.json`;
  const materializerInputContractRel =
    `${PROFILE_ROOT_REL}/materialization-capability-input-contract.json`;
  const materializerOutputContractRel =
    `${PROFILE_ROOT_REL}/materialization-capability-output-contract.json`;
  const materializerDiscoveryRel = `${PROFILE_ROOT_REL}/materialization-discovery-contract.json`;
  const materializerEvidenceRel = `${PROFILE_ROOT_REL}/materialization-evidence-schema.json`;
  const rdfcInputContractRel = `${PROFILE_ROOT_REL}/rdfc-capability-input-contract.json`;
  const rdfcOutputContractRel = `${PROFILE_ROOT_REL}/rdfc-capability-output-contract.json`;
  const rdfcDiscoveryRel = `${PROFILE_ROOT_REL}/rdfc-discovery-contract.json`;
  const rdfcEvidenceRel = `${PROFILE_ROOT_REL}/rdfc-evidence-schema.json`;
  const controlChainCapabilityRefs = {
    discoveryContractDigest: digestOf(outputs, discoveryRel),
    discoveryContractRef: ref(discoveryRel),
    evidenceSchemaDigest: digestOf(outputs, evidenceRel),
    evidenceSchemaRef: ref(evidenceRel),
    inputContractDigest: digestOf(outputs, inputContractRel),
    inputContractRef: ref(inputContractRel),
    outputContractDigest: digestOf(outputs, outputContractRel),
    outputContractRef: ref(outputContractRel),
    testVectorsDigest: digestOf(outputs, TEST_VECTOR_REL),
    testVectorsRef: ref(TEST_VECTOR_REL),
  };
  const materializerCapability = {
    capabilityDigest: digestOf(outputs, canonicalMaterializerRel),
    capabilityId: 's5-canonical-materialization',
    capabilityRef: ref(canonicalMaterializerRel),
    discoveryContractDigest: digestOf(outputs, materializerDiscoveryRel),
    discoveryContractRef: ref(materializerDiscoveryRel),
    entrypointDigest: digestOf(outputs, canonicalMaterializerRel),
    entrypointRef: ref(canonicalMaterializerRel),
    evidenceSchemaDigest: digestOf(outputs, materializerEvidenceRel),
    evidenceSchemaRef: ref(materializerEvidenceRel),
    inputContractDigest: digestOf(outputs, materializerInputContractRel),
    inputContractRef: ref(materializerInputContractRel),
    outputContractDigest: digestOf(outputs, materializerOutputContractRel),
    outputContractRef: ref(materializerOutputContractRel),
    testVectorsDigest: digestOf(outputs, TEST_VECTOR_REL),
    testVectorsRef: ref(TEST_VECTOR_REL),
  };
  const rdfcCapability = {
    capabilityDigest: digestOf(outputs, rdfcRel),
    capabilityId: 'rdfc-1.0',
    capabilityRef: ref(rdfcRel),
    discoveryContractDigest: digestOf(outputs, rdfcDiscoveryRel),
    discoveryContractRef: ref(rdfcDiscoveryRel),
    entrypointDigest: digestOf(outputs, rdfcRel),
    entrypointRef: ref(rdfcRel),
    evidenceSchemaDigest: digestOf(outputs, rdfcEvidenceRel),
    evidenceSchemaRef: ref(rdfcEvidenceRel),
    inputContractDigest: digestOf(outputs, rdfcInputContractRel),
    inputContractRef: ref(rdfcInputContractRel),
    outputContractDigest: digestOf(outputs, rdfcOutputContractRel),
    outputContractRef: ref(rdfcOutputContractRel),
    testVectorsDigest: digestOf(outputs, RDFC_TEST_VECTOR_REL),
    testVectorsRef: ref(RDFC_TEST_VECTOR_REL),
  };
  const toolLock = {
    schemaVersion: '1.0',
    tools: [
      {
        artifactDigest: digestOf(outputs, rdfcRel),
        artifactRef: ref(rdfcRel),
        capabilities: [rdfcCapability],
        runtimeDigest: digestOf(outputs, rdfcRuntimeRel),
        runtimeRef: ref(rdfcRuntimeRel),
        toolId: 'rdf-canonize',
        version: '5.0.0',
      },
      {
        artifactDigest: digestOf(outputs, canonicalMaterializerRel),
        artifactRef: ref(canonicalMaterializerRel),
        capabilities: [materializerCapability],
        runtimeDigest: digestOf(outputs, materializerRuntimeRel),
        runtimeRef: ref(materializerRuntimeRel),
        toolId: 's5-canonical-materializer',
        version: 'axiolune-s5-canonical-materialization/v1',
      },
      {
        artifactDigest: digestOf(outputs, libRel),
        artifactRef: ref(libRel),
        capabilities: [{
          capabilityDigest: digestOf(outputs, libRel),
          capabilityId: 's5-control-chain',
          capabilityRef: ref(libRel),
          entrypointDigest: digestOf(outputs, libRel),
          entrypointRef: ref(libRel),
          ...controlChainCapabilityRefs,
        }],
        runtimeDigest: digestOf(outputs, s5RuntimeRel),
        runtimeRef: ref(s5RuntimeRel),
        toolId: 's5-control-record-chain',
        version: CONTROL_CHAIN_VERSION,
      },
    ],
  };
  put(outputs, `${PROFILE_ROOT_REL}/toolchain.lock.json`, toolLock);

  const referenceArtifactRel = `${FIXTURE_SOURCE_REL}/synthetic-reference.json`;
  const referenceArtifact = {
    claims: [
      'locked synthetic instrument, listing, quotation, and market-data source contract and source record',
      'locked synthetic membership approval and closed-membership probe',
      'locked synthetic direct-unit valuation formula, contracts, policies, runtime, and tool contract',
      'locked synthetic prior PIT and input-context evidence for the portfolio input set',
    ],
    purpose: 'Synthetic CQ-S5 replay test input; not external authority or release evidence.',
    schemaVersion: '1.0',
  };
  put(outputs, referenceArtifactRel, referenceArtifact);
  const referenceArtifactDigest = digestOf(outputs, referenceArtifactRel);
  const referenceArtifactIri = 'urn:axiolune:fixture:s5-synthetic-reference';

  const sourceSchemaRel = `${FIXTURE_SOURCE_REL}/source-schema.json`;
  const sourceSchema = {
    additionalProperties: false,
    dataset: 'urn:axiolune:source-dataset:slice-a:v1',
    fields: [
      { name: 'account_logical_iri', required: true, type: 'uri' },
      { name: 'available_from', required: true, type: 'dateTimeStamp' },
      { name: 'conversion_context_digest', required: true, type: 'sha256Digest' },
      { name: 'conversion_context_ref', required: true, type: 'uri' },
      { name: 'currency', required: true, type: 'string' },
      { name: 'holding_quantity', required: true, type: 'decimalString' },
      { name: 'holding_quantity_precision', required: true, type: 'nonNegativeInteger' },
      { name: 'holding_quantity_rounding', required: true, type: 'string' },
      { name: 'holding_quantity_unit', required: true, type: 'string' },
      { name: 'holding_snapshot_id', required: true, type: 'string' },
      { name: 'holding_source_artifact_digest', required: true, type: 'sha256Digest' },
      { name: 'holding_source_artifact_ref', required: true, type: 'uri' },
      { name: 'holding_source_locator_iri', required: true, type: 'uri' },
      { name: 'instrument_id', required: true, type: 'string' },
      { name: 'instrument_logical_iri', required: true, type: 'uri' },
      { name: 'instrument_version_iri', required: true, type: 'uri' },
      { name: 'internal_id', required: true, type: 'string' },
      { name: 'isin', required: true, type: 'string' },
      { name: 'knowledge_from', required: true, type: 'dateTimeStamp' },
      { name: 'listing_business_from', required: true, type: 'date' },
      { name: 'listing_facility_version_iri', required: true, type: 'uri' },
      { name: 'listing_identifier_scheme_logical_iri', required: true, type: 'uri' },
      { name: 'listing_identifier_value_logical_iri', required: true, type: 'uri' },
      { name: 'listing_version_iri', required: true, type: 'uri' },
      { name: 'market_source_artifact_digest', required: true, type: 'sha256Digest' },
      { name: 'market_source_locator_iri', required: true, type: 'uri' },
      { name: 'membership_approval_digest', required: true, type: 'sha256Digest' },
      { name: 'membership_approval_ref', required: true, type: 'uri' },
      { name: 'membership_closure_probe_digest', required: true, type: 'sha256Digest' },
      { name: 'membership_closure_probe_ref', required: true, type: 'uri' },
      { name: 'membership_closure_version_iri', required: true, type: 'uri' },
      { name: 'ordering_transform_digest', required: true, type: 'sha256Digest' },
      { name: 'ordering_transform_ref', required: true, type: 'uri' },
      { name: 'portfolio_logical_iri', required: true, type: 'uri' },
      {
        name: 'portfolio_observation_completeness_contract_digest',
        required: true,
        type: 'sha256Digest',
      },
      {
        name: 'portfolio_observation_completeness_contract_ref',
        required: true,
        type: 'uri',
      },
      {
        name: 'portfolio_observation_pagination_contract_digest',
        required: true,
        type: 'sha256Digest',
      },
      {
        name: 'portfolio_observation_pagination_contract_ref',
        required: true,
        type: 'uri',
      },
      {
        name: 'portfolio_observation_source_artifact_digest',
        required: true,
        type: 'sha256Digest',
      },
      {
        name: 'portfolio_observation_source_artifact_ref',
        required: true,
        type: 'uri',
      },
      {
        name: 'portfolio_observation_source_contract_digest',
        required: true,
        type: 'sha256Digest',
      },
      {
        name: 'portfolio_observation_source_contract_ref',
        required: true,
        type: 'uri',
      },
      {
        name: 'portfolio_observation_source_locator_iri',
        required: true,
        type: 'uri',
      },
      { name: 'portfolio_observation_stream_id', required: true, type: 'string' },
      { name: 'portfolio_observation_stream_logical_iri', required: true, type: 'uri' },
      { name: 'portfolio_observation_stream_version_iri', required: true, type: 'uri' },
      { name: 'position_source_kind_iri', required: true, type: 'uri' },
      { name: 'price', required: true, type: 'decimalString' },
      { name: 'price_scale', required: true, type: 'nonNegativeInteger' },
      { name: 'provider_iri', required: true, type: 'uri' },
      { name: 'provider_observation_id', required: true, type: 'string' },
      { name: 'provider_stream_id', required: true, type: 'string' },
      { name: 'quotation_contract_version_iri', required: true, type: 'uri' },
      { name: 'quotation_currency_iri', required: true, type: 'uri' },
      { name: 'quotation_denominator_unit', required: true, type: 'string' },
      { name: 'reporting_currency_iri', required: true, type: 'uri' },
      { name: 'revision', required: true, type: 'nonNegativeInteger' },
      { name: 'source', required: true, type: 'uri' },
      { name: 'source_contract_digest', required: true, type: 'sha256Digest' },
      { name: 'source_contract_ref', required: true, type: 'uri' },
      { name: 'source_order_key', required: true, type: 'nonNegativeInteger' },
      { name: 'valid_from', required: true, type: 'dateTimeStamp' },
      { name: 'valuation_definition_version_iri', required: true, type: 'uri' },
      { name: 'valuation_formula_digest', required: true, type: 'sha256Digest' },
      { name: 'valuation_formula_ref', required: true, type: 'uri' },
      { name: 'valuation_input_context_digest', required: true, type: 'sha256Digest' },
      { name: 'valuation_input_context_ref', required: true, type: 'uri' },
      { name: 'valuation_input_contract_digest', required: true, type: 'sha256Digest' },
      { name: 'valuation_output_contract_digest', required: true, type: 'sha256Digest' },
      { name: 'valuation_pit_request_digest', required: true, type: 'sha256Digest' },
      { name: 'valuation_pit_request_ref', required: true, type: 'uri' },
      { name: 'valuation_precision_policy_digest', required: true, type: 'sha256Digest' },
      { name: 'valuation_precision_policy_ref', required: true, type: 'uri' },
      { name: 'valuation_rounding_policy_digest', required: true, type: 'sha256Digest' },
      { name: 'valuation_rounding_policy_ref', required: true, type: 'uri' },
      { name: 'valuation_run_id', required: true, type: 'string' },
      { name: 'valuation_runtime_digest', required: true, type: 'sha256Digest' },
      { name: 'valuation_tool_lock_digest', required: true, type: 'sha256Digest' },
      { name: 'valuation_tool_lock_ref', required: true, type: 'uri' },
    ],
    primaryKey: [
      'instrument_id', 'valid_from', 'knowledge_from', 'available_from', 'revision',
    ],
    schemaVersion: '1.0',
  };
  put(outputs, sourceSchemaRel, sourceSchema);

  const evidenceIris = Object.freeze({
    conversionContext: 'urn:axiolune:evidence:slice-a:conversion-context:v1',
    futurePriorInputContext: 'urn:axiolune:evidence:slice-a:future-prior-input-context:v1',
    futurePriorInputSet: 'urn:axiolune:evidence:slice-a:future-prior-input-set:v1',
    futurePriorPitRequest: 'urn:axiolune:evidence:slice-a:future-prior-pit-request:v1',
    holdingSource: 'urn:axiolune:evidence:slice-a:holding-source:v1',
    marketSource: 'urn:axiolune:evidence:slice-a:market-source:v1',
    membershipApproval: 'urn:axiolune:evidence:slice-a:membership-approval:v1',
    membershipClosureProbe: 'urn:axiolune:evidence:slice-a:membership-closure-probe:v1',
    orderingTransform: 'urn:axiolune:evidence:slice-a:ordering-transform:v1',
    portfolioObservationCompletenessContract:
      'urn:axiolune:evidence:slice-a:portfolio-observation-completeness-contract:v1',
    portfolioObservationPaginationContract:
      'urn:axiolune:evidence:slice-a:portfolio-observation-pagination-contract:v1',
    portfolioObservationPage1Request:
      'urn:axiolune:evidence:slice-a:portfolio-observation-page-request:1',
    portfolioObservationPage1RowLocators:
      'urn:axiolune:evidence:slice-a:portfolio-observation-row-locators:1',
    portfolioObservationPage2Request:
      'urn:axiolune:evidence:slice-a:portfolio-observation-page-request:2',
    portfolioObservationPage2Response:
      'urn:axiolune:evidence:slice-a:portfolio-observation-page-response:2',
    portfolioObservationPage2RowLocators:
      'urn:axiolune:evidence:slice-a:portfolio-observation-row-locators:2',
    portfolioObservationSnapshotRequest:
      'urn:axiolune:evidence:slice-a:portfolio-observation-snapshot-request:v1',
    portfolioObservationSource: 'urn:axiolune:evidence:slice-a:portfolio-observation-source:v1',
    portfolioObservationSourceContract:
      'urn:axiolune:evidence:slice-a:portfolio-observation-source-contract:v1',
    portfolioObservationExtractorProfile:
      'urn:axiolune:evidence:slice-a:portfolio-observation-extractor-profile:v1',
    portfolioObservationExtractorImplementation:
      'urn:axiolune:evidence:slice-a:portfolio-observation-extractor-implementation:v1',
    portfolioObservationLocatorDigestRuntime:
      'urn:axiolune:evidence:slice-a:portfolio-observation-locator-digest-runtime:v1',
    priorInputContext: 'urn:axiolune:evidence:slice-a:prior-input-context:v1',
    priorInputSet: 'urn:axiolune:evidence:slice-a:prior-input-set:v1',
    priorPitRequest: 'urn:axiolune:evidence:slice-a:prior-pit-request:v1',
    sourceContract: 'urn:axiolune:evidence:slice-a:source-contract:v1',
    valuationFormula: 'urn:axiolune:evidence:slice-a:valuation-formula:v1',
    valuationInputContract: 'urn:axiolune:evidence:slice-a:valuation-input-contract:v1',
    valuationOutputContract: 'urn:axiolune:evidence:slice-a:valuation-output-contract:v1',
    valuationPrecisionPolicy: 'urn:axiolune:evidence:slice-a:valuation-precision-policy:v1',
    valuationRoundingPolicy: 'urn:axiolune:evidence:slice-a:valuation-rounding-policy:v1',
    valuationRuntime: 'urn:axiolune:evidence:slice-a:valuation-runtime:v1',
    valuationToolLock: 'urn:axiolune:evidence:slice-a:valuation-tool-lock:v1',
  });
  const originalValuationInputFields = Object.freeze({
    account_logical_iri: 'https://axiolune.ai/data/finance/foundation/financial-account/acme',
    available_from: '2024-07-10T00:00:00Z',
    holding_quantity: '10',
    holding_quantity_precision: 0,
    holding_quantity_rounding: 'half-even',
    holding_quantity_unit: 'urn:unit:share',
    holding_snapshot_id: 'ACME-HOLDING-2024-07-10',
    instrument_logical_iri: 'https://axiolune.ai/data/finance/instruments/security/acme',
    instrument_version_iri: 'https://axiolune.ai/data/finance/instruments/security/acme/version/locked',
    knowledge_from: '2024-07-10T00:00:00Z',
    listing_version_iri: 'https://axiolune.ai/data/finance/instruments/listing/acme-xnys/version/locked',
    membership_closure_version_iri:
      'https://axiolune.ai/data/finance/portfolio-positions/membership-closure/acme/version/locked',
    portfolio_logical_iri: 'https://axiolune.ai/data/finance/portfolio-positions/portfolio/acme',
    portfolio_observation_stream_id: 'custodian-acme-positions',
    portfolio_observation_stream_logical_iri:
      'https://axiolune.ai/data/finance/portfolio-positions/portfolio-observation-stream/custodian-acme-positions',
    portfolio_observation_stream_version_iri:
      'https://axiolune.ai/data/finance/portfolio-positions/portfolio-observation-stream/custodian-acme-positions/version/locked',
    price: '42.50',
    price_scale: 2,
    provider_observation_id: 'ACME-LAST-2024-07-10T00:00:00Z',
    quotation_contract_version_iri:
      'https://axiolune.ai/data/finance/instruments/quotation/acme-usd-per-share/version/locked',
    quotation_currency_iri: 'https://axiolune.ai/data/finance/foundation/currency/USD',
    quotation_denominator_unit: 'urn:unit:share',
    reporting_currency_iri: 'https://axiolune.ai/data/finance/foundation/currency/USD',
    revision: 0,
    source_order_key: 1,
    valid_from: '2024-07-10T00:00:00Z',
    valuation_definition_version_iri:
      'https://axiolune.ai/data/finance/portfolio-positions/valuation-definition/direct-unit/version/locked',
  });
  const futureValuationInputFields = Object.freeze({
    ...originalValuationInputFields,
    available_from: '2024-07-11T00:00:00Z',
    knowledge_from: '2024-07-11T00:00:00Z',
    price: '43.00',
    provider_observation_id: 'ACME-LAST-2024-07-11T00:00:00Z',
    source_order_key: 2,
  });
  const supportEvidenceArtifacts = {
    conversionContext: `${FIXTURE_SOURCE_REL}/conversion-context.json`,
    membershipApproval: `${FIXTURE_SOURCE_REL}/membership-approval.json`,
    membershipClosureProbe: `${FIXTURE_SOURCE_REL}/membership-closure-probe.json`,
    portfolioObservationCompletenessContract:
      `${FIXTURE_SOURCE_REL}/portfolio-observation-completeness-contract.json`,
    portfolioObservationPaginationContract:
      `${FIXTURE_SOURCE_REL}/portfolio-observation-pagination-contract.json`,
    portfolioObservationSourceContract:
      `${FIXTURE_SOURCE_REL}/portfolio-observation-source-contract.json`,
    portfolioObservationSnapshotRequest:
      `${FIXTURE_SOURCE_REL}/portfolio-observation-snapshot-request.json`,
    portfolioObservationPage1Request:
      `${FIXTURE_SOURCE_REL}/portfolio-observation-page-1-request.json`,
    portfolioObservationPage1Response:
      `${FIXTURE_SOURCE_REL}/portfolio-observation-page-1-response.json`,
    portfolioObservationPage1RowLocators:
      `${FIXTURE_SOURCE_REL}/portfolio-observation-page-1-row-locators.json`,
    portfolioObservationPage2Request:
      `${FIXTURE_SOURCE_REL}/portfolio-observation-page-2-request.json`,
    portfolioObservationPage2Response:
      `${FIXTURE_SOURCE_REL}/portfolio-observation-page-2-response.json`,
    portfolioObservationPage2RowLocators:
      `${FIXTURE_SOURCE_REL}/portfolio-observation-page-2-row-locators.json`,
    portfolioObservationExtractorProfile:
      `${FIXTURE_SOURCE_REL}/portfolio-observation-extractor-profile.json`,
    portfolioObservationClosure:
      `${FIXTURE_SOURCE_REL}/portfolio-observation-closure.json`,
    futurePriorInputContext: `${FIXTURE_SOURCE_REL}/future-prior-valuation-input-context.json`,
    futurePriorInputSet: `${FIXTURE_SOURCE_REL}/future-prior-valuation-input-set.json`,
    futurePriorPitRequest: `${FIXTURE_SOURCE_REL}/future-prior-valuation-pit-request.json`,
    priorInputContext: `${FIXTURE_SOURCE_REL}/prior-valuation-input-context.json`,
    priorInputSet: `${FIXTURE_SOURCE_REL}/prior-valuation-input-set.json`,
    priorPitRequest: `${FIXTURE_SOURCE_REL}/prior-valuation-pit-request.json`,
    precisionPolicy: `${FIXTURE_SOURCE_REL}/valuation-precision-policy.json`,
    roundingPolicy: `${FIXTURE_SOURCE_REL}/valuation-rounding-policy.json`,
  };
  put(outputs, supportEvidenceArtifacts.conversionContext, {
    branch: 'sameCurrency',
    conversions: [],
    priceCurrency: 'USD',
    reportingCurrency: 'USD',
    schemaVersion: '1.0',
  });
  put(outputs, supportEvidenceArtifacts.membershipApproval, {
    approvalId: 'slice-a-membership-approval-v1',
    authority: 'https://axiolune.ai/data/finance/foundation/party/portfolio-authority',
    outcome: 'approved-for-synthetic-cq',
    schemaVersion: '1.0',
  });
  put(outputs, supportEvidenceArtifacts.membershipClosureProbe, {
    complete: true,
    membershipVersionIris: [
      'https://axiolune.ai/data/finance/portfolio-positions/membership/acme-account/version/locked',
    ],
    probeId: 'slice-a-membership-closure-probe-v1',
    schemaVersion: '1.0',
  });
  put(outputs, supportEvidenceArtifacts.portfolioObservationCompletenessContract, {
    contractId: 'slice-a-portfolio-observation-completeness-v1',
    duplicatePolicy: 'reject',
    failurePolicy: 'reject-degraded-partial-or-error',
    omissionSemantics: 'completeSnapshot',
    recordScope: 'all-provider-visible-holdings-for-account',
    schemaVersion: '1.0',
  });
  put(outputs, supportEvidenceArtifacts.portfolioObservationPaginationContract, {
    contractId: 'slice-a-portfolio-observation-pagination-v1',
    cursorMode: 'opaqueImmutable',
    ordering: ['account_logical_iri', 'instrument_logical_iri', 'holding_snapshot_id'],
    replayTermination: 'empty-next-cursor',
    schemaVersion: '1.0',
    snapshotConsistency: 'immutable-provider-snapshot-token',
  });
  const portfolioObservationExtractorProfileSourceRel =
    'scripts/domain/reference-extractors/json-pointer-jcs-v1.json';
  put(
    outputs,
    supportEvidenceArtifacts.portfolioObservationExtractorProfile,
    JSON.parse(fs.readFileSync(
      path.join(ROOT, ...portfolioObservationExtractorProfileSourceRel.split('/')),
      'utf8',
    )),
  );
  const portfolioObservationStreamLogicalIri =
    'https://axiolune.ai/data/finance/portfolio-positions/portfolio-observation-stream/custodian-acme-positions';
  const portfolioObservationStreamVersionIri =
    `${portfolioObservationStreamLogicalIri}/version/locked`;
  const portfolioObservationSourceContractVersionIri =
    'https://axiolune.ai/data/finance/portfolio-positions/source-contract/custodian-acme-positions/version/locked';
  const portfolioObservationProviderIri = 'https://provider.example/party/acme-feed';
  const portfolioObservationAccountIri =
    'https://axiolune.ai/data/finance/foundation/financial-account/acme';
  const portfolioObservationAsOf = '2024-07-10T00:00:00Z';
  const portfolioObservationSnapshotRequestIri =
    'urn:axiolune:portfolio-observation-request:slice-a:2024-07-10';
  const portfolioObservationSnapshotToken =
    'slice-a-provider-snapshot-token-2024-07-10';
  const portfolioObservationPositionSourceKindIri =
    'https://axiolune.ai/ontology/finance/portfolio-positions/PositionSourceKind/value/externalReported';
  put(outputs, supportEvidenceArtifacts.portfolioObservationSourceContract, {
    accountScope: 'request-bound',
    completeness: 'complete-snapshot',
    duplicatePolicy: 'reject',
    failurePolicy: 'reject-degraded-partial-or-error',
    kind: 'PortfolioObservationSourceContract',
    ordering: ['accountLogicalIri', 'instrumentLogicalIri', 'snapshotId'],
    paginationMode: 'opaque-immutable-cursor',
    providerIri: portfolioObservationProviderIri,
    responseMediaType: 'application/json',
    schemaVersion: '1.0',
    streamLogicalIri: portfolioObservationStreamLogicalIri,
    versionIri: portfolioObservationSourceContractVersionIri,
  });
  put(outputs, supportEvidenceArtifacts.portfolioObservationSnapshotRequest, {
    accountLogicalIri: portfolioObservationAccountIri,
    asOf: portfolioObservationAsOf,
    initialCursor: null,
    kind: 'PortfolioObservationSnapshotRequest',
    providerIri: portfolioObservationProviderIri,
    requestIri: portfolioObservationSnapshotRequestIri,
    schemaVersion: '1.0',
    sourceContractDigest: digestOf(
      outputs,
      supportEvidenceArtifacts.portfolioObservationSourceContract,
    ),
    sourceContractRef: ref(supportEvidenceArtifacts.portfolioObservationSourceContract),
    sourceContractVersionIri: portfolioObservationSourceContractVersionIri,
    streamLogicalIri: portfolioObservationStreamLogicalIri,
    streamVersionIri: portfolioObservationStreamVersionIri,
  });
  const portfolioObservationSnapshotRequestDigest = digestOf(
    outputs,
    supportEvidenceArtifacts.portfolioObservationSnapshotRequest,
  );
  const portfolioObservationPage1RequestIri =
    'urn:axiolune:portfolio-observation-page-request:slice-a:1';
  put(outputs, supportEvidenceArtifacts.portfolioObservationPage1Request, {
    accountLogicalIri: portfolioObservationAccountIri,
    asOf: portfolioObservationAsOf,
    cursor: null,
    kind: 'PortfolioObservationPageRequest',
    pageRequestIri: portfolioObservationPage1RequestIri,
    providerIri: portfolioObservationProviderIri,
    providerSnapshotToken: null,
    schemaVersion: '1.0',
    snapshotRequestDigest: portfolioObservationSnapshotRequestDigest,
    snapshotRequestIri: portfolioObservationSnapshotRequestIri,
    sourceContractVersionIri: portfolioObservationSourceContractVersionIri,
    streamLogicalIri: portfolioObservationStreamLogicalIri,
    streamVersionIri: portfolioObservationStreamVersionIri,
  });
  const portfolioObservationPage1RequestDigest = digestOf(
    outputs,
    supportEvidenceArtifacts.portfolioObservationPage1Request,
  );
  const portfolioObservationRecordKey = {
    accountLogicalIri: originalValuationInputFields.account_logical_iri,
    instrumentLogicalIri: originalValuationInputFields.instrument_logical_iri,
    snapshotId: originalValuationInputFields.holding_snapshot_id,
  };
  const portfolioObservationPage1Response = {
    accountLogicalIri: portfolioObservationAccountIri,
    asOf: portfolioObservationAsOf,
    cursor: null,
    kind: 'PortfolioObservationPageResponse',
    nextCursor: 'slice-a-terminal-cursor',
    pageRequestDigest: portfolioObservationPage1RequestDigest,
    pageRequestIri: portfolioObservationPage1RequestIri,
    providerIri: portfolioObservationProviderIri,
    providerSnapshotToken: portfolioObservationSnapshotToken,
    records: [{
      payload: {
        availableFrom: originalValuationInputFields.available_from,
        holdingQuantity: originalValuationInputFields.holding_quantity,
        holdingQuantityPrecision: originalValuationInputFields.holding_quantity_precision,
        holdingQuantityRounding: originalValuationInputFields.holding_quantity_rounding,
        holdingQuantityUnit: originalValuationInputFields.holding_quantity_unit,
        knowledgeFrom: originalValuationInputFields.knowledge_from,
        positionSourceKindIri: portfolioObservationPositionSourceKindIri,
        revision: originalValuationInputFields.revision,
        validFrom: originalValuationInputFields.valid_from,
      },
      recordKey: portfolioObservationRecordKey,
    }],
    retrievalStatus: 'success',
    schemaVersion: '1.0',
    snapshotRequestDigest: portfolioObservationSnapshotRequestDigest,
    snapshotRequestIri: portfolioObservationSnapshotRequestIri,
    sourceContractVersionIri: portfolioObservationSourceContractVersionIri,
    streamLogicalIri: portfolioObservationStreamLogicalIri,
    streamVersionIri: portfolioObservationStreamVersionIri,
    terminal: false,
  };
  put(
    outputs,
    supportEvidenceArtifacts.portfolioObservationPage1Response,
    portfolioObservationPage1Response,
  );
  const portfolioObservationPage1ResponseDigest = digestOf(
    outputs,
    supportEvidenceArtifacts.portfolioObservationPage1Response,
  );
  const jsonPointerProfileRel =
    supportEvidenceArtifacts.portfolioObservationExtractorProfile;
  const portfolioObservationLocatorIri =
    'urn:axiolune:source-locator:slice-a:holding-record';
  const portfolioObservationRowLocatorWithoutDigest = {
    extractorProfileDigest: digestOf(outputs, jsonPointerProfileRel),
    extractorProfileRef: ref(jsonPointerProfileRel),
    kind: 'jsonPointer',
    mediaType: 'application/json',
    path: supportEvidenceArtifacts.portfolioObservationPage1Response,
    pointer: '/records/0',
  };
  const portfolioObservationRowLocator = {
    ...portfolioObservationRowLocatorWithoutDigest,
    selectionDigest: computeSelectionDigest(
      portfolioObservationRowLocatorWithoutDigest,
      jcsBytes(portfolioObservationPage1Response.records[0]),
    ),
  };
  put(outputs, supportEvidenceArtifacts.portfolioObservationPage1RowLocators, {
    kind: 'PortfolioObservationRowLocatorManifest',
    responseDigest: portfolioObservationPage1ResponseDigest,
    responseRef: ref(supportEvidenceArtifacts.portfolioObservationPage1Response),
    rows: [{
      locatorIri: portfolioObservationLocatorIri,
      recordKey: portfolioObservationRecordKey,
      sourceLocator: portfolioObservationRowLocator,
    }],
    schemaVersion: '1.0',
  });
  const portfolioObservationPage2RequestIri =
    'urn:axiolune:portfolio-observation-page-request:slice-a:2';
  put(outputs, supportEvidenceArtifacts.portfolioObservationPage2Request, {
    accountLogicalIri: portfolioObservationAccountIri,
    asOf: portfolioObservationAsOf,
    cursor: 'slice-a-terminal-cursor',
    kind: 'PortfolioObservationPageRequest',
    pageRequestIri: portfolioObservationPage2RequestIri,
    providerIri: portfolioObservationProviderIri,
    providerSnapshotToken: portfolioObservationSnapshotToken,
    schemaVersion: '1.0',
    snapshotRequestDigest: portfolioObservationSnapshotRequestDigest,
    snapshotRequestIri: portfolioObservationSnapshotRequestIri,
    sourceContractVersionIri: portfolioObservationSourceContractVersionIri,
    streamLogicalIri: portfolioObservationStreamLogicalIri,
    streamVersionIri: portfolioObservationStreamVersionIri,
  });
  const portfolioObservationPage2RequestDigest = digestOf(
    outputs,
    supportEvidenceArtifacts.portfolioObservationPage2Request,
  );
  const portfolioObservationPage2Response = {
    accountLogicalIri: portfolioObservationAccountIri,
    asOf: portfolioObservationAsOf,
    cursor: 'slice-a-terminal-cursor',
    kind: 'PortfolioObservationPageResponse',
    nextCursor: null,
    pageRequestDigest: portfolioObservationPage2RequestDigest,
    pageRequestIri: portfolioObservationPage2RequestIri,
    providerIri: portfolioObservationProviderIri,
    providerSnapshotToken: portfolioObservationSnapshotToken,
    records: [],
    retrievalStatus: 'success',
    schemaVersion: '1.0',
    snapshotRequestDigest: portfolioObservationSnapshotRequestDigest,
    snapshotRequestIri: portfolioObservationSnapshotRequestIri,
    sourceContractVersionIri: portfolioObservationSourceContractVersionIri,
    streamLogicalIri: portfolioObservationStreamLogicalIri,
    streamVersionIri: portfolioObservationStreamVersionIri,
    terminal: true,
  };
  put(
    outputs,
    supportEvidenceArtifacts.portfolioObservationPage2Response,
    portfolioObservationPage2Response,
  );
  const portfolioObservationPage2ResponseDigest = digestOf(
    outputs,
    supportEvidenceArtifacts.portfolioObservationPage2Response,
  );
  put(outputs, supportEvidenceArtifacts.portfolioObservationPage2RowLocators, {
    kind: 'PortfolioObservationRowLocatorManifest',
    responseDigest: portfolioObservationPage2ResponseDigest,
    responseRef: ref(supportEvidenceArtifacts.portfolioObservationPage2Response),
    rows: [],
    schemaVersion: '1.0',
  });
  put(outputs, supportEvidenceArtifacts.portfolioObservationClosure, {
    aggregate: {
      duplicateCount: 0,
      pageCount: 2,
      recordSetDigest: recordSetDigest([portfolioObservationRecordKey]),
      terminalObserved: true,
      totalRecordCount: 1,
    },
    kind: 'PortfolioObservationStreamClosure',
    pages: [
      {
        cursor: null,
        nextCursor: 'slice-a-terminal-cursor',
        orderedRecordKeys: [portfolioObservationRecordKey],
        pageIndex: 0,
        recordCount: 1,
        recordSetDigest: recordSetDigest([portfolioObservationRecordKey]),
        requestDigest: portfolioObservationPage1RequestDigest,
        requestRef: ref(supportEvidenceArtifacts.portfolioObservationPage1Request),
        responseDigest: portfolioObservationPage1ResponseDigest,
        responseRef: ref(supportEvidenceArtifacts.portfolioObservationPage1Response),
        rowLocatorManifestDigest: digestOf(
          outputs,
          supportEvidenceArtifacts.portfolioObservationPage1RowLocators,
        ),
        rowLocatorManifestRef: ref(
          supportEvidenceArtifacts.portfolioObservationPage1RowLocators,
        ),
        terminal: false,
      },
      {
        cursor: 'slice-a-terminal-cursor',
        nextCursor: null,
        orderedRecordKeys: [],
        pageIndex: 1,
        recordCount: 0,
        recordSetDigest: recordSetDigest([]),
        requestDigest: portfolioObservationPage2RequestDigest,
        requestRef: ref(supportEvidenceArtifacts.portfolioObservationPage2Request),
        responseDigest: portfolioObservationPage2ResponseDigest,
        responseRef: ref(supportEvidenceArtifacts.portfolioObservationPage2Response),
        rowLocatorManifestDigest: digestOf(
          outputs,
          supportEvidenceArtifacts.portfolioObservationPage2RowLocators,
        ),
        rowLocatorManifestRef: ref(
          supportEvidenceArtifacts.portfolioObservationPage2RowLocators,
        ),
        terminal: true,
      },
    ],
    request: {
      artifactDigest: portfolioObservationSnapshotRequestDigest,
      artifactRef: ref(supportEvidenceArtifacts.portfolioObservationSnapshotRequest),
    },
    schemaVersion: '1.0',
  });
  put(outputs, supportEvidenceArtifacts.futurePriorInputSet, {
    fields: futureValuationInputFields,
    selectionComplete: true,
    setId: 'slice-a-future-prior-valuation-input-set-v1',
    schemaVersion: '1.0',
  });
  put(outputs, supportEvidenceArtifacts.futurePriorInputContext, {
    completedAt: '2024-07-10T23:59:59Z',
    contextId: 'slice-a-future-prior-valuation-input-v1',
    inputSetDigest: digestOf(outputs, supportEvidenceArtifacts.futurePriorInputSet),
    inputSetRef: evidenceIris.futurePriorInputSet,
    outcome: 'completed',
    schemaVersion: '1.0',
  });
  put(outputs, supportEvidenceArtifacts.futurePriorPitRequest, {
    asOfAvailable: '2024-07-11T00:00:00Z',
    asOfKnowledge: '2024-07-11T00:00:00Z',
    asOfValid: '2024-07-10T00:00:00Z',
    inputContextDigest: digestOf(outputs, supportEvidenceArtifacts.futurePriorInputContext),
    inputContextRef: evidenceIris.futurePriorInputContext,
    requestId: 'slice-a-future-prior-valuation-pit-v1',
    schemaVersion: '1.0',
  });
  put(outputs, supportEvidenceArtifacts.priorInputSet, {
    fields: originalValuationInputFields,
    selectionComplete: true,
    setId: 'slice-a-prior-valuation-input-set-v1',
    schemaVersion: '1.0',
  });
  put(outputs, supportEvidenceArtifacts.priorInputContext, {
    completedAt: '2024-07-09T23:59:59Z',
    contextId: 'slice-a-prior-valuation-input-v1',
    inputSetDigest: digestOf(outputs, supportEvidenceArtifacts.priorInputSet),
    inputSetRef: evidenceIris.priorInputSet,
    outcome: 'completed',
    schemaVersion: '1.0',
  });
  put(outputs, supportEvidenceArtifacts.priorPitRequest, {
    asOfAvailable: '2024-07-10T00:00:00Z',
    asOfKnowledge: '2024-07-10T00:00:00Z',
    asOfValid: '2024-07-10T00:00:00Z',
    inputContextDigest: digestOf(outputs, supportEvidenceArtifacts.priorInputContext),
    inputContextRef: evidenceIris.priorInputContext,
    requestId: 'slice-a-prior-valuation-pit-v1',
    schemaVersion: '1.0',
  });
  put(outputs, supportEvidenceArtifacts.precisionPolicy, {
    decimalArithmetic: 'exact',
    intermediateScale: 'unbounded',
    policyId: 'slice-a-exact-decimal-v1',
    schemaVersion: '1.0',
  });
  put(outputs, supportEvidenceArtifacts.roundingPolicy, {
    mode: 'half-even',
    outputScale: 2,
    policyId: 'slice-a-half-even-v1',
    schemaVersion: '1.0',
    stage: 'finalMonetaryAmount',
  });
  const supportEvidenceClosureRel = `${FIXTURE_SOURCE_REL}/support-evidence-closure.json`;
  const supportEvidenceRows = [
    [evidenceIris.conversionContext, supportEvidenceArtifacts.conversionContext, 'conversionContext'],
    [evidenceIris.futurePriorInputContext, supportEvidenceArtifacts.futurePriorInputContext, 'completedInputContext'],
    [evidenceIris.futurePriorInputSet, supportEvidenceArtifacts.futurePriorInputSet, 'valuationInputSet'],
    [evidenceIris.futurePriorPitRequest, supportEvidenceArtifacts.futurePriorPitRequest, 'pitRequest'],
    [
      evidenceIris.holdingSource,
      supportEvidenceArtifacts.portfolioObservationPage1Response,
      'portfolioObservationPageResponse',
    ],
    [evidenceIris.marketSource, referenceArtifactRel, 'sourceRecord'],
    [evidenceIris.membershipApproval, supportEvidenceArtifacts.membershipApproval, 'approval'],
    [evidenceIris.membershipClosureProbe, supportEvidenceArtifacts.membershipClosureProbe, 'closedWorldProbe'],
    [evidenceIris.orderingTransform, canonicalMaterializerRel, 'executableTransform'],
    [
      evidenceIris.portfolioObservationCompletenessContract,
      supportEvidenceArtifacts.portfolioObservationCompletenessContract,
      'completenessContract',
    ],
    [
      evidenceIris.portfolioObservationPaginationContract,
      supportEvidenceArtifacts.portfolioObservationPaginationContract,
      'paginationContract',
    ],
    [
      evidenceIris.portfolioObservationPage1Request,
      supportEvidenceArtifacts.portfolioObservationPage1Request,
      'portfolioObservationPageRequest',
    ],
    [
      evidenceIris.portfolioObservationPage1RowLocators,
      supportEvidenceArtifacts.portfolioObservationPage1RowLocators,
      'portfolioObservationRowLocatorManifest',
    ],
    [
      evidenceIris.portfolioObservationPage2Request,
      supportEvidenceArtifacts.portfolioObservationPage2Request,
      'portfolioObservationPageRequest',
    ],
    [
      evidenceIris.portfolioObservationPage2Response,
      supportEvidenceArtifacts.portfolioObservationPage2Response,
      'portfolioObservationPageResponse',
    ],
    [
      evidenceIris.portfolioObservationPage2RowLocators,
      supportEvidenceArtifacts.portfolioObservationPage2RowLocators,
      'portfolioObservationRowLocatorManifest',
    ],
    [
      evidenceIris.portfolioObservationSnapshotRequest,
      supportEvidenceArtifacts.portfolioObservationSnapshotRequest,
      'portfolioObservationSnapshotRequest',
    ],
    [
      evidenceIris.portfolioObservationSource,
      supportEvidenceArtifacts.portfolioObservationClosure,
      'portfolioObservationClosure',
    ],
    [
      evidenceIris.portfolioObservationSourceContract,
      supportEvidenceArtifacts.portfolioObservationSourceContract,
      'portfolioObservationSourceContract',
    ],
    [
      evidenceIris.portfolioObservationExtractorProfile,
      jsonPointerProfileRel,
      'sourceExtractorProfile',
    ],
    [
      evidenceIris.portfolioObservationExtractorImplementation,
      strictJsonRel,
      'executableRuntime',
    ],
    [
      evidenceIris.portfolioObservationLocatorDigestRuntime,
      strictLocatorRel,
      'executableRuntime',
    ],
    [evidenceIris.priorInputContext, supportEvidenceArtifacts.priorInputContext, 'completedInputContext'],
    [evidenceIris.priorInputSet, supportEvidenceArtifacts.priorInputSet, 'valuationInputSet'],
    [evidenceIris.priorPitRequest, supportEvidenceArtifacts.priorPitRequest, 'pitRequest'],
    [evidenceIris.sourceContract, sourceSchemaRel, 'sourceContract'],
    [evidenceIris.valuationFormula, canonicalMaterializerRel, 'valuationFormulaImplementation'],
    [evidenceIris.valuationInputContract, sourceSchemaRel, 'inputContract'],
    [evidenceIris.valuationOutputContract, materializerOutputContractRel, 'outputContract'],
    [evidenceIris.valuationPrecisionPolicy, supportEvidenceArtifacts.precisionPolicy, 'precisionPolicy'],
    [evidenceIris.valuationRoundingPolicy, supportEvidenceArtifacts.roundingPolicy, 'roundingPolicy'],
    [evidenceIris.valuationRuntime, materializerRuntimeRel, 'runtimeClosure'],
    [evidenceIris.valuationToolLock, `${PROFILE_ROOT_REL}/toolchain.lock.json`, 'toolLock'],
  ].map(([evidenceIri, relativePath, evidenceKind]) => ({
    artifactDigest: digestOf(outputs, relativePath),
    artifactRef: ref(relativePath),
    evidenceIri,
    evidenceKind,
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.evidenceIri, 'utf8'),
    Buffer.from(right.evidenceIri, 'utf8'),
  ));
  put(outputs, supportEvidenceClosureRel, {
    entries: supportEvidenceRows,
    schemaVersion: '1.0',
  });
  const supportEvidenceByIri = new Map(
    supportEvidenceRows.map((entry) => [entry.evidenceIri, entry]),
  );

  const identityNs = 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/';
  const XSD = 'http://www.w3.org/2001/XMLSchema#';
  const F = 'https://axiolune.ai/ontology/finance/foundation/';
  const I = 'https://axiolune.ai/ontology/finance/instruments/';
  const MD = 'https://axiolune.ai/ontology/finance/market-data/';
  const P = 'https://axiolune.ai/ontology/finance/portfolio-positions/';
  const TEMPORAL = 'https://axiolune.ai/ontology/meta/patterns/TemporalFact';
  const PATTERN_ATTRIBUTE = 'https://axiolune.ai/ontology/meta/patterns/attributes/';
  const rfcRel = 'docs/domain/planning/RFC-001-m2-conformance-profile-and-domain-contract.md';
  const termDefinition = (suffix, label, definition, termContract) => {
    const value = { iri: `${identityNs}term-contract/${suffix}`, label, definition, termContract };
    return {
      definition: value,
      termContractDigest: taggedJcsDigest(IDENTITY_TAGS.termContract, value),
      termContractRef: value.iri,
    };
  };
  const termRows = [
    termDefinition('date-time-stamp', 'UTC date-time stamp', 'Canonical xsd:dateTimeStamp identity term.', { termKind: 'literal', datatypeIri: `${XSD}dateTimeStamp` }),
    termDefinition('financial-account-logical', 'FinancialAccount logical identity', 'Canonical logical FinancialAccount IRI.', { termKind: 'iri', referenceMode: 'logical', expectedTargetType: `${F}FinancialAccount` }),
    termDefinition('financial-instrument-logical', 'FinancialInstrument logical identity', 'Canonical logical FinancialInstrument IRI.', { termKind: 'iri', referenceMode: 'logical', expectedTargetType: `${I}FinancialInstrument` }),
    termDefinition('holding-snapshot-version', 'HoldingSnapshot exact version', 'Canonical exact HoldingSnapshot version IRI.', { termKind: 'iri', referenceMode: 'version', expectedTargetType: `${P}HoldingSnapshot` }),
    termDefinition('identifier-scheme-logical', 'IdentifierScheme logical identity', 'Canonical logical IdentifierScheme IRI.', { termKind: 'iri', referenceMode: 'logical', expectedTargetType: `${F}IdentifierScheme` }),
    termDefinition('isin', 'Canonical ISIN', 'Canonical fin-foundation:ISIN identity term.', { termKind: 'literal', datatypeIri: `${F}ISIN` }),
    termDefinition('market-data-stream-logical', 'MarketDataStream logical identity', 'Canonical logical MarketDataStream IRI.', { termKind: 'iri', referenceMode: 'logical', expectedTargetType: `${MD}MarketDataStream` }),
    termDefinition('non-negative-integer', 'Non-negative revision', 'Canonical xsd:nonNegativeInteger identity term.', { termKind: 'literal', datatypeIri: `${XSD}nonNegativeInteger` }),
    termDefinition('party-logical', 'Party logical identity', 'Canonical logical Party IRI.', { termKind: 'iri', referenceMode: 'logical', expectedTargetType: `${F}Party` }),
    termDefinition('portfolio-logical', 'Portfolio logical identity', 'Canonical logical Portfolio IRI.', { termKind: 'iri', referenceMode: 'logical', expectedTargetType: `${P}Portfolio` }),
    termDefinition('portfolio-observation-stream-logical', 'PortfolioObservationStream logical identity', 'Canonical logical portfolio observation stream IRI that scopes source identifiers.', { termKind: 'iri', referenceMode: 'logical', expectedTargetType: `${P}PortfolioObservationStream` }),
    termDefinition('portfolio-valuation-version', 'PortfolioValuation exact version', 'Canonical exact PortfolioValuation version IRI.', { termKind: 'iri', referenceMode: 'version', expectedTargetType: `${P}PortfolioValuation` }),
    termDefinition('string', 'NFC string', 'Canonical non-empty xsd:string identity term.', { termKind: 'literal', datatypeIri: `${XSD}string` }),
    termDefinition('uri', 'Absolute URI literal', 'Canonical xsd:anyURI identity term.', { termKind: 'literal', datatypeIri: `${XSD}anyURI` }),
  ].sort((left, right) => Buffer.compare(Buffer.from(left.termContractRef), Buffer.from(right.termContractRef)));
  const registryRel = `${SLICE_IDENTITY_ROOT_REL}/identity-term-registry.json`;
  const registry = {
    controlledSets: [],
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    schemaVersion: '1.0',
    termContracts: termRows,
  };
  put(outputs, registryRel, registry);
  const identityNormalizationVectorsRel = `${SLICE_IDENTITY_ROOT_REL}/identity-normalization-vectors.json`;
  put(outputs, identityNormalizationVectorsRel, {
    cases: [
      { input: 'portfolio-snapshot-0001', normalized: 'portfolio-snapshot-0001', term: 'string' },
      { input: 'urn:axiolune:portfolio-observation-stream:custodian-a', normalized: 'urn:axiolune:portfolio-observation-stream:custodian-a', term: 'portfolio-observation-stream-logical' },
    ],
    schemaVersion: '1.0',
  });
  const registryDigest = taggedJcsDigest(IDENTITY_TAGS.termRegistry, registry);
  const termBySuffix = new Map(termRows.map((row) => [row.termContractRef.split('/').at(-1), row]));
  const normalizationRules = [...termBySuffix.entries()].map(([suffix, term]) => ({
    algorithmId: suffix.replaceAll('-', '_'),
    algorithmVersion: '1.0.0',
    definition: `Deterministic ${suffix} normalization for the S5 materialization slice.`,
    implementationDigest: digestOf(outputs, canonicalMaterializerRel),
    implementationRef: ref(canonicalMaterializerRel),
    inputTermContractDigest: term.termContractDigest,
    inputTermContractRef: term.termContractRef,
    iri: `${identityNs}normalization/${suffix}`,
    label: `${suffix} normalization`,
    outputTermContractDigest: term.termContractDigest,
    outputTermContractRef: term.termContractRef,
    specificationDigest: digestOf(outputs, rfcRel),
    specificationRef: ref(rfcRel),
    testVectorsDigest: digestOf(outputs, identityNormalizationVectorsRel),
    testVectorsRef: ref(identityNormalizationVectorsRel),
  }));
  const ruleBySuffix = new Map(normalizationRules.map((row) => [row.iri.split('/').at(-1), row]));
  const component = (name, semanticValue, suffix) => {
    const term = termBySuffix.get(suffix);
    const rule = ruleBySuffix.get(suffix);
    return {
      name,
      normalizationRuleDigest: taggedJcsDigest(IDENTITY_TAGS.normalizationRule, rule),
      normalizationRuleRef: rule.iri,
      semanticValue,
      termContractDigest: term.termContractDigest,
      termContractRef: term.termContractRef,
    };
  };
  const versionComponents = (targetType) => [
    component('validFrom', { valueKind: 'patternField', containingType: targetType, patternRef: TEMPORAL, fieldRef: `${PATTERN_ATTRIBUTE}validFrom` }, 'date-time-stamp'),
    component('knowledgeFrom', { valueKind: 'patternField', containingType: targetType, patternRef: TEMPORAL, fieldRef: `${PATTERN_ATTRIBUTE}knowledgeFrom` }, 'date-time-stamp'),
    component('availableFrom', { valueKind: 'patternField', containingType: targetType, patternRef: TEMPORAL, fieldRef: `${PATTERN_ATTRIBUTE}availableFrom` }, 'date-time-stamp'),
    component('revision', { valueKind: 'patternField', containingType: targetType, patternRef: TEMPORAL, fieldRef: `${PATTERN_ATTRIBUTE}revision` }, 'non-negative-integer'),
  ];
  const targets = {
    holding: `${P}HoldingSnapshot`,
    identity: `${F}ISINValue`,
    portfolioValuation: `${P}PortfolioValuation`,
    positionValuation: `${P}PositionValuation`,
    stream: `${MD}MarketDataStream`,
    observation: `${MD}PriceObservation`,
  };
  const contracts = [
    {
      iri: `${identityNs}identity-contract/isin-value`, label: 'ISINValue identity contract',
      definition: 'Logical identity is the IdentifierScheme logical IRI and canonical ISIN lexical value; version identity is the standard four-axis key.',
      targetType: targets.identity, identityBaseIri: 'https://axiolune.ai/data/finance/foundation/isin-value',
      logicalComponents: [
        component('schemeLogicalIri', { valueKind: 'relationUse', relationRef: `${F}identifierValueScheme`, subjectType: targets.identity, objectType: `${F}IdentifierScheme` }, 'identifier-scheme-logical'),
        component('canonicalLexicalValue', { valueKind: 'attributeUse', containingType: targets.identity, attributeRef: `${F}isinLexicalValue` }, 'isin'),
      ],
      versionComponents: versionComponents(targets.identity),
    },
    {
      iri: `${identityNs}identity-contract/market-data-stream`, label: 'MarketDataStream identity contract',
      definition: 'Logical identity is provider, source contract, and provider stream identifier; version identity is the standard four-axis key.',
      targetType: targets.stream, identityBaseIri: 'https://axiolune.ai/data/finance/market-data/stream',
      logicalComponents: [
        component('providerLogicalIri', { valueKind: 'relationUse', relationRef: `${MD}streamProvider`, subjectType: targets.stream, objectType: `${F}Party` }, 'party-logical'),
        component('sourceContractRef', { valueKind: 'attributeUse', containingType: targets.stream, attributeRef: `${MD}sourceContractRef` }, 'uri'),
        component('providerStreamId', { valueKind: 'attributeUse', containingType: targets.stream, attributeRef: `${MD}providerStreamId` }, 'string'),
      ],
      versionComponents: versionComponents(targets.stream),
    },
    {
      iri: `${identityNs}identity-contract/price-observation`, label: 'PriceObservation identity contract',
      definition: 'Logical identity is the stream logical IRI and provider observation identifier; version identity is the standard four-axis key.',
      targetType: targets.observation, identityBaseIri: 'https://axiolune.ai/data/finance/market-data/price-observation',
      logicalComponents: [
        component('observationStreamLogicalIri', { valueKind: 'participantRole', containingAssociation: targets.observation, roleId: 'observationStream', effectivePredicate: `${targets.observation}/role/observationStream` }, 'market-data-stream-logical'),
        component('providerObservationId', { valueKind: 'attributeUse', containingType: targets.observation, attributeRef: `${MD}providerObservationId` }, 'string'),
      ],
      versionComponents: versionComponents(targets.observation),
    },
    {
      iri: `${identityNs}identity-contract/holding-snapshot`, label: 'HoldingSnapshot identity contract',
      definition: 'Logical identity is the typed portfolio-observation stream logical IRI and its source-scoped snapshot identifier; account, instrument, and optional listing are immutable version content.',
      targetType: targets.holding, identityBaseIri: 'https://axiolune.ai/data/finance/portfolio-positions/holding-snapshot',
      logicalComponents: [
        component('observationStreamLogicalIri', { valueKind: 'participantRole', containingAssociation: targets.holding, roleId: 'holdingObservationStream', effectivePredicate: `${targets.holding}/role/holdingObservationStream` }, 'portfolio-observation-stream-logical'),
        component('snapshotId', { valueKind: 'attributeUse', containingType: targets.holding, attributeRef: `${P}snapshotId` }, 'string'),
      ],
      versionComponents: versionComponents(targets.holding),
    },
    {
      iri: `${identityNs}identity-contract/portfolio-valuation`, label: 'PortfolioValuation identity contract',
      definition: 'Logical identity is the valued Portfolio logical IRI and the valuation run identifier; version identity is the standard four-axis key.',
      targetType: targets.portfolioValuation, identityBaseIri: 'https://axiolune.ai/data/finance/portfolio-positions/portfolio-valuation',
      logicalComponents: [
        component('portfolioLogicalIri', { valueKind: 'participantRole', containingAssociation: targets.portfolioValuation, roleId: 'valuedPortfolio', effectivePredicate: `${targets.portfolioValuation}/role/valuedPortfolio` }, 'portfolio-logical'),
        component('valuationRunId', { valueKind: 'attributeUse', containingType: targets.portfolioValuation, attributeRef: `${P}valuationRunId` }, 'string'),
      ],
      versionComponents: versionComponents(targets.portfolioValuation),
    },
    {
      iri: `${identityNs}identity-contract/position-valuation`, label: 'PositionValuation identity contract',
      definition: 'Logical identity is the exact PortfolioValuation header version and the exact selected input snapshot version; this slice selects the HoldingSnapshot branch.',
      targetType: targets.positionValuation, identityBaseIri: 'https://axiolune.ai/data/finance/portfolio-positions/position-valuation',
      logicalComponents: [
        component('valuationHeaderVersionIri', { valueKind: 'participantRole', containingAssociation: targets.positionValuation, roleId: 'valuationHeader', effectivePredicate: `${targets.positionValuation}/role/valuationHeader` }, 'portfolio-valuation-version'),
        component('inputSnapshotVersionIri', { valueKind: 'participantRole', containingAssociation: targets.positionValuation, roleId: 'valuedHoldingSnapshot', effectivePredicate: `${targets.positionValuation}/role/valuedHoldingSnapshot` }, 'holding-snapshot-version'),
      ],
      versionComponents: versionComponents(targets.positionValuation),
    },
  ];
  const contractByTarget = new Map(contracts.map((entry) => [entry.targetType, entry]));
  const direct = (field) => ({ bindingType: 'directField', source: { dataset: 'row', field } });
  const versionBindings = {
    validFrom: direct('valid_from'), knowledgeFrom: direct('knowledge_from'),
    availableFrom: direct('available_from'), revision: direct('revision'),
  };
  const source = { datasets: [{ dataset: sourceSchema.dataset, alias: 'row' }] };
  const temporal = {
    patternRef: TEMPORAL,
    validTime: { from: direct('valid_from'), closePolicy: 'explicitOnly' },
    knowledgeTime: { from: direct('knowledge_from'), closePolicy: 'explicitOnly' },
    availabilityTime: { from: direct('available_from'), closePolicy: 'explicitOnly' },
  };
  const streamLogicalBindings = {
    providerLogicalIri: direct('provider_iri'),
    sourceContractRef: direct('source_contract_ref'),
    providerStreamId: direct('provider_stream_id'),
  };
  const streamVersionBinding = {
    bindingType: 'referenceIdentity',
    targetMappingRef: `${identityNs}mapping/market-data-stream`,
    referenceMode: 'version',
    keyBindings: { ...streamLogicalBindings, ...versionBindings },
  };
  const holdingLogicalBindings = {
    observationStreamLogicalIri: direct('portfolio_observation_stream_logical_iri'),
    snapshotId: direct('holding_snapshot_id'),
  };
  const holdingVersionBinding = {
    bindingType: 'referenceIdentity',
    targetMappingRef: `${identityNs}mapping/holding-snapshot`,
    referenceMode: 'version',
    keyBindings: { ...holdingLogicalBindings, ...versionBindings },
  };
  const portfolioValuationLogicalBindings = {
    portfolioLogicalIri: direct('portfolio_logical_iri'),
    valuationRunId: direct('valuation_run_id'),
  };
  const portfolioValuationVersionBinding = {
    bindingType: 'referenceIdentity',
    targetMappingRef: `${identityNs}mapping/portfolio-valuation`,
    referenceMode: 'version',
    keyBindings: { ...portfolioValuationLogicalBindings, ...versionBindings },
  };
  const computedMarketValue = {
    bindingType: 'transformation',
    transformationRef: `${identityNs}transformation/direct-unit-price-times-quantity`,
    inputs: {
      price: direct('price'),
      priceScale: direct('price_scale'),
      quantity: direct('holding_quantity'),
      quantityPrecision: direct('holding_quantity_precision'),
      quantityRounding: direct('holding_quantity_rounding'),
      precisionPolicyDigest: direct('valuation_precision_policy_digest'),
      precisionPolicyRef: direct('valuation_precision_policy_ref'),
      reportingCurrency: direct('reporting_currency_iri'),
      roundingPolicyDigest: direct('valuation_rounding_policy_digest'),
      roundingPolicyRef: direct('valuation_rounding_policy_ref'),
    },
  };
  const semanticMappings = [
    {
      iri: `${identityNs}mapping/isin-value`, label: 'Slice A ISINValue mapping', source,
      targetType: targets.identity, mappingType: 'directTable',
      identity: {
        contractRef: contractByTarget.get(targets.identity).iri,
        logicalKeyBindings: { schemeLogicalIri: { bindingType: 'literal', value: 'https://axiolune.ai/data/finance/foundation/identifier-scheme/isin' }, canonicalLexicalValue: direct('isin') },
        versionKeyBindings: versionBindings,
      },
      slotMappings: [
        { target: { slotType: 'attribute', targetAttribute: `${F}isinLexicalValue` }, value: direct('isin') },
        { target: { slotType: 'relation', targetRelation: `${F}identifierValueScheme`, targetObjectType: `${F}IdentifierScheme` }, value: { bindingType: 'literal', value: 'https://axiolune.ai/data/finance/foundation/identifier-scheme/isin' } },
      ],
      temporal,
      provenance: { sourceSystem: direct('source') },
    },
    {
      iri: `${identityNs}mapping/market-data-stream`, label: 'Slice A MarketDataStream mapping', source,
      targetType: targets.stream, mappingType: 'directTable',
      identity: { contractRef: contractByTarget.get(targets.stream).iri, logicalKeyBindings: streamLogicalBindings, versionKeyBindings: versionBindings },
      slotMappings: [
        { target: { slotType: 'attribute', targetAttribute: `${MD}providerStreamId` }, value: direct('provider_stream_id') },
        { target: { slotType: 'attribute', targetAttribute: `${MD}sourceContractRef` }, value: direct('source_contract_ref') },
        { target: { slotType: 'relation', targetRelation: `${MD}streamProvider`, targetObjectType: `${F}Party` }, value: direct('provider_iri') },
      ],
      temporal,
      provenance: { sourceSystem: direct('source') },
    },
    {
      iri: `${identityNs}mapping/price-observation`, label: 'Slice A PriceObservation mapping', source,
      targetType: targets.observation, mappingType: 'directTable',
      identity: {
        contractRef: contractByTarget.get(targets.observation).iri,
        logicalKeyBindings: {
          observationStreamLogicalIri: { bindingType: 'referenceIdentity', targetMappingRef: `${identityNs}mapping/market-data-stream`, referenceMode: 'logical', keyBindings: streamLogicalBindings },
          providerObservationId: direct('provider_observation_id'),
        },
        versionKeyBindings: versionBindings,
      },
      slotMappings: [
        { target: { slotType: 'participantRole', targetAssociation: targets.observation, targetRole: 'observationStream' }, value: streamVersionBinding },
        { target: { slotType: 'participantRole', targetAssociation: targets.observation, targetRole: 'observedInstrument' }, value: direct('instrument_version_iri') },
        { target: { slotType: 'participantRole', targetAssociation: targets.observation, targetRole: 'observedListing' }, value: direct('listing_version_iri') },
        { target: { slotType: 'participantRole', targetAssociation: targets.observation, targetRole: 'quotationContract' }, value: direct('quotation_contract_version_iri') },
        { target: { slotType: 'attribute', targetAttribute: `${MD}providerObservationId` }, value: direct('provider_observation_id') },
        { target: { slotType: 'attribute', targetAttribute: `${MD}priceValue` }, value: { bindingType: 'transformation', transformationRef: `${identityNs}transformation/money-value`, inputs: { amount: direct('price'), currency: direct('currency'), scale: direct('price_scale') } } },
        { target: { slotType: 'attribute', targetAttribute: `${MD}sourceOrderKey` }, value: direct('source_order_key') },
      ],
      temporal,
      provenance: { sourceSystem: direct('source') },
    },
    {
      iri: `${identityNs}mapping/holding-snapshot`, label: 'Slice A HoldingSnapshot mapping', source,
      targetType: targets.holding, mappingType: 'directTable',
      identity: {
        contractRef: contractByTarget.get(targets.holding).iri,
        logicalKeyBindings: holdingLogicalBindings,
        versionKeyBindings: versionBindings,
      },
      slotMappings: [
        { target: { slotType: 'participantRole', targetAssociation: targets.holding, targetRole: 'holdingObservationStream' }, value: direct('portfolio_observation_stream_version_iri') },
        { target: { slotType: 'participantRole', targetAssociation: targets.holding, targetRole: 'holdingAccount' }, value: direct('account_logical_iri') },
        { target: { slotType: 'participantRole', targetAssociation: targets.holding, targetRole: 'holdingInstrument' }, value: direct('instrument_logical_iri') },
        { target: { slotType: 'participantRole', targetAssociation: targets.holding, targetRole: 'holdingListing' }, value: direct('listing_version_iri') },
        { target: { slotType: 'attribute', targetAttribute: `${P}snapshotId` }, value: direct('holding_snapshot_id') },
        { target: { slotType: 'attribute', targetAttribute: `${P}holdingQuantity` }, value: { bindingType: 'transformation', transformationRef: `${identityNs}transformation/quantity-value`, inputs: { precision: direct('holding_quantity_precision'), rounding: direct('holding_quantity_rounding'), unit: direct('holding_quantity_unit'), value: direct('holding_quantity') } } },
        { target: { slotType: 'attribute', targetAttribute: `${P}positionSourceKind` }, value: direct('position_source_kind_iri') },
        { target: { slotType: 'attribute', targetAttribute: 'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactRef' }, value: direct('holding_source_artifact_ref') },
        { target: { slotType: 'attribute', targetAttribute: 'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactDigest' }, value: direct('holding_source_artifact_digest') },
        { target: { slotType: 'attribute', targetAttribute: 'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceLocator' }, value: direct('holding_source_locator_iri') },
      ],
      temporal,
      provenance: { sourceSystem: direct('holding_source_artifact_ref') },
    },
    {
      iri: `${identityNs}mapping/portfolio-valuation`, label: 'Slice A PortfolioValuation mapping', source,
      targetType: targets.portfolioValuation, mappingType: 'directTable',
      identity: {
        contractRef: contractByTarget.get(targets.portfolioValuation).iri,
        logicalKeyBindings: portfolioValuationLogicalBindings,
        versionKeyBindings: versionBindings,
      },
      slotMappings: [
        { target: { slotType: 'participantRole', targetAssociation: targets.portfolioValuation, targetRole: 'valuedPortfolio' }, value: direct('portfolio_logical_iri') },
        { target: { slotType: 'participantRole', targetAssociation: targets.portfolioValuation, targetRole: 'memberAccountClosure' }, value: direct('membership_closure_version_iri') },
        { target: { slotType: 'participantRole', targetAssociation: targets.portfolioValuation, targetRole: 'valuationDefinition' }, value: direct('valuation_definition_version_iri') },
        { target: { slotType: 'participantRole', targetAssociation: targets.portfolioValuation, targetRole: 'reportingCurrency' }, value: direct('reporting_currency_iri') },
        { target: { slotType: 'attribute', targetAttribute: `${P}valuationRunId` }, value: direct('valuation_run_id') },
        { target: { slotType: 'attribute', targetAttribute: `${P}conversionContextRef` }, value: direct('conversion_context_ref') },
        { target: { slotType: 'attribute', targetAttribute: `${P}conversionContextDigest` }, value: direct('conversion_context_digest') },
        { target: { slotType: 'attribute', targetAttribute: 'https://axiolune.ai/ontology/meta/data-binding/attributes/pitRequestRef' }, value: direct('valuation_pit_request_ref') },
        { target: { slotType: 'attribute', targetAttribute: 'https://axiolune.ai/ontology/meta/data-binding/attributes/pitRequestRecordDigest' }, value: direct('valuation_pit_request_digest') },
        { target: { slotType: 'attribute', targetAttribute: 'https://axiolune.ai/ontology/meta/data-binding/attributes/inputContextRef' }, value: direct('valuation_input_context_ref') },
        { target: { slotType: 'attribute', targetAttribute: 'https://axiolune.ai/ontology/meta/data-binding/attributes/inputContextRecordDigest' }, value: direct('valuation_input_context_digest') },
      ],
      temporal,
      provenance: { sourceSystem: direct('source') },
    },
    {
      iri: `${identityNs}mapping/position-valuation`, label: 'Slice A PositionValuation mapping', source,
      targetType: targets.positionValuation, mappingType: 'directTable',
      identity: {
        contractRef: contractByTarget.get(targets.positionValuation).iri,
        logicalKeyBindings: {
          valuationHeaderVersionIri: portfolioValuationVersionBinding,
          inputSnapshotVersionIri: holdingVersionBinding,
        },
        versionKeyBindings: versionBindings,
      },
      slotMappings: [
        { target: { slotType: 'participantRole', targetAssociation: targets.positionValuation, targetRole: 'valuationHeader' }, value: portfolioValuationVersionBinding },
        { target: { slotType: 'participantRole', targetAssociation: targets.positionValuation, targetRole: 'valuedHoldingSnapshot' }, value: holdingVersionBinding },
        { target: { slotType: 'participantRole', targetAssociation: targets.positionValuation, targetRole: 'valuationPrice' }, value: { bindingType: 'referenceIdentity', targetMappingRef: `${identityNs}mapping/price-observation`, referenceMode: 'version', keyBindings: { observationStreamLogicalIri: { bindingType: 'referenceIdentity', targetMappingRef: `${identityNs}mapping/market-data-stream`, referenceMode: 'logical', keyBindings: streamLogicalBindings }, providerObservationId: direct('provider_observation_id'), ...versionBindings } } },
        { target: { slotType: 'attribute', targetAttribute: `${P}marketValue` }, value: computedMarketValue },
      ],
      temporal,
      provenance: { sourceSystem: direct('source') },
    },
  ];
  const primitiveType = (primitive) => ({ primitiveType: primitive, typeKind: 'primitive' });
  const structuredType = (typeRef) => ({ typeKind: 'structured', typeRef });
  const transformationDefinitions = [
    {
      definition: 'Construct the canonical Money structured value from an exact decimal lexical amount, ISO 4217 currency code, and explicit scale.',
      implementation: {
        entrypoint: 'executeCanonicalTransformation',
        runtime: 'javascript',
        scriptPath: canonicalMaterializerRel,
      },
      implementationDigest: materializerCapability.entrypointDigest,
      inputs: {
        amount: primitiveType('string'),
        currency: primitiveType('string'),
        scale: primitiveType('integer'),
      },
      iri: `${identityNs}transformation/money-value`,
      kind: 'ScriptTransformation',
      outputs: structuredType(
        'https://axiolune.ai/ontology/meta/core/values/MonetaryAmount',
      ),
      testCases: [{
        description: 'Preserve the exact monetary lexical value, ISO currency, and scale.',
        expectedOutput: { amount: '42.50', currency: 'USD', scale: 2 },
        input: { amount: '42.50', currency: 'USD', scale: 2 },
      }],
      version: '1.0.0',
    },
    {
      definition: 'Construct the canonical Quantity structured value without coercing its exact decimal lexical value, unit, precision, or rounding mode.',
      implementation: {
        entrypoint: 'executeCanonicalTransformation',
        runtime: 'javascript',
        scriptPath: canonicalMaterializerRel,
      },
      implementationDigest: materializerCapability.entrypointDigest,
      inputs: {
        precision: primitiveType('integer'),
        rounding: primitiveType('string'),
        unit: primitiveType('uri'),
        value: primitiveType('string'),
      },
      iri: `${identityNs}transformation/quantity-value`,
      kind: 'ScriptTransformation',
      outputs: structuredType(
        'https://axiolune.ai/ontology/meta/core/values/QuantityValue',
      ),
      testCases: [{
        description: 'Preserve the exact holding quantity contract.',
        expectedOutput: {
          precision: 0,
          rounding: 'half-even',
          unit: 'urn:unit:share',
          value: '10',
        },
        input: {
          precision: 0,
          rounding: 'half-even',
          unit: 'urn:unit:share',
          value: '10',
        },
      }],
      version: '1.0.0',
    },
    {
      definition: 'Multiply a direct-unit price by quantity using the byte-locked exact-decimal precision and final half-even rounding policies.',
      implementation: {
        entrypoint: 'executeCanonicalTransformation',
        runtime: 'javascript',
        scriptPath: canonicalMaterializerRel,
      },
      implementationDigest: materializerCapability.entrypointDigest,
      inputs: {
        precisionPolicyDigest: primitiveType('string'),
        precisionPolicyRef: primitiveType('uri'),
        price: primitiveType('string'),
        priceScale: primitiveType('integer'),
        quantity: primitiveType('string'),
        quantityPrecision: primitiveType('integer'),
        quantityRounding: primitiveType('string'),
        reportingCurrency: primitiveType('uri'),
        roundingPolicyDigest: primitiveType('string'),
        roundingPolicyRef: primitiveType('uri'),
      },
      iri: `${identityNs}transformation/direct-unit-price-times-quantity`,
      kind: 'ScriptTransformation',
      outputs: structuredType(
        'https://axiolune.ai/ontology/meta/core/values/MonetaryAmount',
      ),
      testCases: [{
        description: 'Ten direct units at USD 42.50 produce USD 425.00 at scale two.',
        expectedOutput: { amount: '425.00', currency: 'USD', scale: 2 },
        input: {
          precisionPolicyDigest:
            supportEvidenceByIri.get(evidenceIris.valuationPrecisionPolicy).artifactDigest,
          precisionPolicyRef: evidenceIris.valuationPrecisionPolicy,
          price: '42.50',
          priceScale: 2,
          quantity: '10',
          quantityPrecision: 0,
          quantityRounding: 'half-even',
          reportingCurrency:
            'https://axiolune.ai/data/finance/foundation/currency/USD',
          roundingPolicyDigest:
            supportEvidenceByIri.get(evidenceIris.valuationRoundingPolicy).artifactDigest,
          roundingPolicyRef: evidenceIris.valuationRoundingPolicy,
        },
      }],
      version: '1.0.0',
    },
  ].sort((left, right) => Buffer.compare(Buffer.from(left.iri), Buffer.from(right.iri)));
  const transformationDefinitionsByIri = new Map();
  for (const definition of transformationDefinitions) {
    const id = definition.iri.split('/').at(-1);
    const relativePath = `${FIXTURE_SOURCE_REL}/transformation-${id}.json`;
    put(outputs, relativePath, definition);
    transformationDefinitionsByIri.set(definition.iri, {
      definition,
      relativePath,
    });
  }
  const identityCompilationRel = `${SLICE_IDENTITY_ROOT_REL}/identity-compilation.json`;
  const identityCompilation = {
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    identityTermRegistryRef: ref(registryRel), identityTermRegistryDigest: registryDigest,
    identityTermRegistry: registry, normalizationRules, derivations: [], contracts,
    mappings: semanticMappings, concreteTargetTypes: Object.values(targets),
  };
  const identityCompilationResult = compileIdentityContracts(identityCompilation);
  put(outputs, identityCompilationRel, identityCompilation);
  const identityManifestRel = `${SLICE_IDENTITY_ROOT_REL}/identity-manifest.json`;
  put(outputs, identityManifestRel, identityCompilationResult.manifest);

  const mappingSpecs = [
    {
      id: 'identity', planIri: `${identityNs}plan/identity`,
      targetGraph: 'urn:axiolune:graph:slice-a:identity:v1',
      targetModule: 'https://axiolune.ai/ontology/finance/foundation',
      mappings: [semanticMappings[0]],
    },
    {
      id: 'market-data', planIri: `${identityNs}plan/market-data`,
      targetGraph: 'urn:axiolune:graph:slice-a:market-data:v1',
      targetModule: 'https://axiolune.ai/ontology/finance/market-data',
      mappings: [semanticMappings[1], semanticMappings[2]],
    },
    {
      id: 'portfolio-valuation', planIri: `${identityNs}plan/portfolio-valuation`,
      targetGraph: 'urn:axiolune:graph:slice-a:portfolio-valuation:v1',
      targetModule: 'https://axiolune.ai/ontology/finance/portfolio-positions',
      mappings: [semanticMappings[3], semanticMappings[4], semanticMappings[5]],
    },
  ];
  const mappingTransformationRefs = (value, output = new Set()) => {
    if (Array.isArray(value)) {
      value.forEach((entry) => mappingTransformationRefs(entry, output));
      return output;
    }
    if (!value || typeof value !== 'object') return output;
    if (value.bindingType === 'transformation') output.add(value.transformationRef);
    Object.values(value).forEach((entry) => mappingTransformationRefs(entry, output));
    return output;
  };
  for (const planSpec of mappingSpecs) {
    for (const mapping of planSpec.mappings) {
      const id = mapping.iri.split('/').at(-1);
      const mappingRel = ['market-data-stream', 'price-observation'].includes(id)
        ? `mappings/finance/v0.3.0/market-data/${id}.semantic-mapping.json`
        : `${FIXTURE_SOURCE_REL}/${id}-mapping.json`;
      const closureRel = `${FIXTURE_SOURCE_REL}/${id}-transformation-closure.json`;
      const transformations = [...mappingTransformationRefs(mapping)]
        .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        .map((transformationRef) => {
          const definition = transformationDefinitionsByIri.get(transformationRef);
          if (!definition) {
            throw new Error(`missing canonical TransformationDefinition for ${transformationRef}`);
          }
          return {
        capabilityDigest: materializerCapability.capabilityDigest,
        capabilityId: materializerCapability.capabilityId,
        capabilityRef: materializerCapability.capabilityRef,
        definitionDigest: digestOf(outputs, definition.relativePath),
        definitionRef: ref(definition.relativePath),
        dependencies: [],
        implementationDigest: digestOf(outputs, canonicalMaterializerRel),
        implementationRef: ref(canonicalMaterializerRel),
        inputContractDigest: digestOf(outputs, sourceSchemaRel),
        inputContractRef: ref(sourceSchemaRel),
        outputContractDigest: digestOf(outputs, materializerOutputContractRel),
        outputContractRef: ref(materializerOutputContractRel),
        runtimeDigest: digestOf(outputs, materializerRuntimeRel),
        runtimeRef: ref(materializerRuntimeRel),
        transformationRef,
          };
        });
      const closure = {
        mappingRef: mapping.iri,
        schemaVersion: '1.0',
        transformations,
      };
      put(outputs, closureRel, closure);
      put(outputs, mappingRel, mapping);
      mapping._artifact = {
        identityContractRef: contractByTarget.get(mapping.targetType).iri,
        mappingArtifactRef: ref(mappingRel),
        mappingRef: mapping.iri,
        provenanceSourceField:
          mapping.targetType === targets.holding ? 'holding_source_artifact_ref' : 'source',
        transformationClosureRef: ref(closureRel),
      };
    }
    put(outputs, `${FIXTURE_SOURCE_REL}/${planSpec.id}-plan.json`, {
      definition: `Executable ${planSpec.id} materialization plan over the locked Slice A source snapshot.`,
      iri: planSpec.planIri,
      label: `Slice A ${planSpec.id} current-domain materialization plan`,
      materializationMode: 'Full',
      owner: 'repository-owner',
      semanticMappings: planSpec.mappings.map((entry) => entry.iri),
      sourceDatasets: [sourceSchema.dataset],
      targetGraphUri: planSpec.targetGraph,
      targetOntologyModule: planSpec.targetModule,
    });
  }

  const batchRel = `${FIXTURE_SOURCE_REL}/batch-definition.json`;
  put(outputs, batchRel, {
    consistencyRequirement: 'Transactional',
    definition: 'Atomic Slice A identifier, market-data, holding, and portfolio-valuation control-record batch.',
    dependencyEdges: [{
      afterPlan: `${identityNs}plan/portfolio-valuation`,
      beforePlan: `${identityNs}plan/market-data`,
    }],
    iri: 'urn:axiolune:batch-definition:slice-a:control-chain:v1',
    label: 'Slice A current-domain control-record batch v1',
    plans: mappingSpecs.map((entry) => entry.planIri),
    targetDataset: 'urn:axiolune:dataset:slice-a:control-chain:v1',
  });

  const ontologyModulePaths = [
    ['m3', 'ontology/meta/core-meta-model.yaml'],
    ['m3', 'ontology/meta/cross-domain-patterns.yaml'],
    ['m3', 'ontology/meta/behavior-meta-model.yaml'],
    ['m3', 'ontology/meta/data-binding-meta-model.yaml'],
    ['m2', 'ontology/domain/finance/foundation/module.yaml'],
    ['m2', 'ontology/domain/finance/market-structure/module.yaml'],
    ['m2', 'ontology/domain/finance/instruments/module.yaml'],
    ['m2', 'ontology/domain/finance/market-rules/module.yaml'],
    ['m2', 'ontology/domain/finance/market-data/module.yaml'],
    ['m2', 'ontology/domain/finance/orders-execution/module.yaml'],
    ['m2', 'ontology/domain/finance/portfolio-positions/module.yaml'],
  ];
  const parsedOntologyModules = ontologyModulePaths.map(([layer, relativePath]) => {
    const bytes = fs.readFileSync(path.join(ROOT, ...relativePath.split('/')));
    const document = yaml.load(bytes.toString('utf8'), { json: false });
    return {
      layer,
      relativePath,
      document,
      row: {
        layer,
        moduleIri: document.module.moduleIri,
        normalizedIrDigest: taggedJcsDigest(
          layer === 'm2' ? 'axiolune-normalized-m2-ir-v1\0' : 'axiolune-normalized-m3-ir-v1\0',
          normalizeOntologyIr(document),
        ),
        sourceDigest: artifactDigest(bytes),
        sourceRef: ref(relativePath),
        version: document.module.version,
      },
    };
  });
  const ontologyByIri = new Map(parsedOntologyModules.map((entry) => [entry.row.moduleIri, entry]));
  const ontologyImports = [];
  for (const entry of parsedOntologyModules) {
    for (const imported of entry.document.module.imports || []) {
      const importedModuleIri = imported.moduleIri.replace(/#sha256:[0-9a-f]{64}$/u, '');
      const importedModule = ontologyByIri.get(importedModuleIri);
      if (!importedModule) throw new Error(`S5 ontology closure misses import ${importedModuleIri}`);
      ontologyImports.push({
        importerModuleIri: entry.row.moduleIri,
        importedModuleIri,
        importedSourceDigest: importedModule.row.sourceDigest,
        importedVersion: imported.version,
        importMode: imported.importMode,
        selectedSymbols: selectedImportSymbolIris(imported),
      });
    }
  }
  const sortedOntologyImports = sortUniqueOntologyImportRows(ontologyImports);
  const ontologyClosureRel = `${FIXTURE_SOURCE_REL}/ontology-closure-manifest.json`;
  put(outputs, ontologyClosureRel, {
    imports: sortedOntologyImports,
    modules: parsedOntologyModules.map((entry) => entry.row)
      .sort((left, right) => Buffer.compare(Buffer.from(left.moduleIri), Buffer.from(right.moduleIri))),
    schemaVersion: '1.0',
  });

  const wholeFileProfileRel = 'scripts/domain/reference-extractors/whole-file-v1.json';
  const locatorWithoutDigest = {
    extractorProfileDigest: digestOf(outputs, wholeFileProfileRel),
    extractorProfileRef: ref(wholeFileProfileRel),
    kind: 'wholeFile',
    mediaType: 'application/json',
    path: referenceArtifactRel,
  };
  const sourceLocator = {
    ...locatorWithoutDigest,
    selectionDigest: computeSelectionDigest(
      locatorWithoutDigest,
      outputs.get(referenceArtifactRel),
    ),
  };
  const referenceLockRel = `${FIXTURE_SOURCE_REL}/synthetic-reference-lock.json`;
  put(outputs, referenceLockRel, {
    references: [{
      artifactDigest: referenceArtifactDigest,
      artifactRef: ref(referenceArtifactRel),
      id: 'axiolune-s5-synthetic-reference',
      locator: sourceLocator,
    }],
    schemaVersion: '1.0',
  });
  const referenceClosureRel = `${FIXTURE_SOURCE_REL}/reference-closure-manifest.json`;
  put(outputs, referenceClosureRel, {
    entries: [{
      artifactDigest: referenceArtifactDigest,
      artifactRef: ref(referenceArtifactRel),
      availability: 'localLocked',
      license: 'CC0-1.0 synthetic fixture',
      locators: [sourceLocator],
      maturity: 'syntheticTestOnly',
      referenceId: 'axiolune-s5-synthetic-reference',
      releaseOrCommit: 'fixture-v1',
      sourceUrl: referenceArtifactIri,
      usageScope: 'CQ-S5 executable replay fixture only',
    }],
    lockSourceDigest: digestOf(outputs, referenceLockRel),
    lockSourceRef: ref(referenceLockRel),
    referenceBundleDigest: singleFileReferenceBundleDigest(
      path.basename(referenceArtifactRel),
      outputs.get(referenceArtifactRel),
    ),
    referenceBundleRef: ref(referenceArtifactRel),
    schemaVersion: '1.0',
  });

  const originalSnapshotRel = `${FIXTURE_ROOT_REL}/source-snapshot-original.json`;
  const futureSnapshotRel = `${FIXTURE_ROOT_REL}/source-snapshot-future.json`;
  const originalRow = {
    ...originalValuationInputFields,
    conversion_context_digest: supportEvidenceByIri.get(evidenceIris.conversionContext).artifactDigest,
    conversion_context_ref: evidenceIris.conversionContext,
    currency: 'USD',
    holding_source_artifact_digest: supportEvidenceByIri.get(evidenceIris.holdingSource).artifactDigest,
    holding_source_artifact_ref: evidenceIris.holdingSource,
    holding_source_locator_iri: 'urn:axiolune:source-locator:slice-a:holding-record',
    instrument_id: 'ACME',
    internal_id: 'ACME-INTERNAL-1',
    isin: 'US0000000002',
    listing_business_from: '2024-01-01',
    listing_facility_version_iri:
      'https://axiolune.ai/data/finance/market-structure/trading-facility/xnys/version/locked',
    listing_identifier_scheme_logical_iri:
      'https://axiolune.ai/data/finance/foundation/identifier-scheme/xnys-ticker',
    listing_identifier_value_logical_iri:
      'https://axiolune.ai/data/finance/foundation/local-identifier-value/xnys/ACME',
    market_source_artifact_digest: supportEvidenceByIri.get(evidenceIris.marketSource).artifactDigest,
    market_source_locator_iri: 'urn:axiolune:source-locator:slice-a:market-record',
    membership_approval_digest: supportEvidenceByIri.get(evidenceIris.membershipApproval).artifactDigest,
    membership_approval_ref: evidenceIris.membershipApproval,
    membership_closure_probe_digest: supportEvidenceByIri.get(evidenceIris.membershipClosureProbe).artifactDigest,
    membership_closure_probe_ref: evidenceIris.membershipClosureProbe,
    ordering_transform_digest: supportEvidenceByIri.get(evidenceIris.orderingTransform).artifactDigest,
    ordering_transform_ref: evidenceIris.orderingTransform,
    portfolio_observation_completeness_contract_digest: supportEvidenceByIri.get(
      evidenceIris.portfolioObservationCompletenessContract,
    ).artifactDigest,
    portfolio_observation_completeness_contract_ref:
      evidenceIris.portfolioObservationCompletenessContract,
    portfolio_observation_pagination_contract_digest: supportEvidenceByIri.get(
      evidenceIris.portfolioObservationPaginationContract,
    ).artifactDigest,
    portfolio_observation_pagination_contract_ref:
      evidenceIris.portfolioObservationPaginationContract,
    portfolio_observation_source_artifact_digest: supportEvidenceByIri.get(
      evidenceIris.portfolioObservationSource,
    ).artifactDigest,
    portfolio_observation_source_artifact_ref: evidenceIris.portfolioObservationSource,
    portfolio_observation_source_contract_digest: supportEvidenceByIri.get(
      evidenceIris.portfolioObservationSourceContract,
    ).artifactDigest,
    portfolio_observation_source_contract_ref:
      evidenceIris.portfolioObservationSourceContract,
    portfolio_observation_source_locator_iri:
      'urn:axiolune:source-locator:slice-a:portfolio-observation-record',
    position_source_kind_iri: portfolioObservationPositionSourceKindIri,
    provider_iri: 'https://provider.example/party/acme-feed',
    provider_stream_id: 'acme-last-prices',
    source: evidenceIris.marketSource,
    source_contract_digest: supportEvidenceByIri.get(evidenceIris.sourceContract).artifactDigest,
    source_contract_ref: evidenceIris.sourceContract,
    valuation_formula_digest: supportEvidenceByIri.get(evidenceIris.valuationFormula).artifactDigest,
    valuation_formula_ref: evidenceIris.valuationFormula,
    valuation_input_context_digest: supportEvidenceByIri.get(evidenceIris.priorInputContext).artifactDigest,
    valuation_input_context_ref: evidenceIris.priorInputContext,
    valuation_input_contract_digest: supportEvidenceByIri.get(evidenceIris.valuationInputContract).artifactDigest,
    valuation_output_contract_digest: supportEvidenceByIri.get(evidenceIris.valuationOutputContract).artifactDigest,
    valuation_pit_request_digest: supportEvidenceByIri.get(evidenceIris.priorPitRequest).artifactDigest,
    valuation_pit_request_ref: evidenceIris.priorPitRequest,
    valuation_precision_policy_digest: supportEvidenceByIri.get(evidenceIris.valuationPrecisionPolicy).artifactDigest,
    valuation_precision_policy_ref: evidenceIris.valuationPrecisionPolicy,
    valuation_rounding_policy_digest: supportEvidenceByIri.get(evidenceIris.valuationRoundingPolicy).artifactDigest,
    valuation_rounding_policy_ref: evidenceIris.valuationRoundingPolicy,
    valuation_run_id: 'ACME-VALUATION-2024-07-10',
    valuation_runtime_digest: supportEvidenceByIri.get(evidenceIris.valuationRuntime).artifactDigest,
    valuation_tool_lock_digest: supportEvidenceByIri.get(evidenceIris.valuationToolLock).artifactDigest,
    valuation_tool_lock_ref: evidenceIris.valuationToolLock,
  };
  put(outputs, originalSnapshotRel, {
    dataset: sourceSchema.dataset,
    rows: [originalRow],
    snapshotId: 'slice-a-snapshot-2024-07-10',
    snapshotTime: '2024-07-10T00:00:00Z',
  });
  put(outputs, futureSnapshotRel, {
    dataset: sourceSchema.dataset,
    rows: [
      originalRow,
      {
        ...originalRow,
        ...futureValuationInputFields,
        valuation_input_context_digest: supportEvidenceByIri.get(
          evidenceIris.futurePriorInputContext,
        ).artifactDigest,
        valuation_input_context_ref: evidenceIris.futurePriorInputContext,
        valuation_pit_request_digest: supportEvidenceByIri.get(
          evidenceIris.futurePriorPitRequest,
        ).artifactDigest,
        valuation_pit_request_ref: evidenceIris.futurePriorPitRequest,
      },
    ],
    snapshotId: 'slice-a-snapshot-2024-07-11',
    snapshotTime: '2024-07-11T00:00:00Z',
  });

  // The validation prerequisites are a prior, immutable M1 input dataset.
  // They are deliberately produced outside the current batch and consumed
  // only through this closed run/report/DAG chain.
  const priorSupportRootRel = `${FIXTURE_SOURCE_REL}/prior-support`;
  const priorSupportDatasetRel = `${priorSupportRootRel}/dataset.nq`;
  const priorSupportProduced = materializePriorSupportDataset([originalRow], {
    valuationPolicyArtifacts: {
      precisionBytes: outputs.get(supportEvidenceArtifacts.precisionPolicy),
      roundingBytes: outputs.get(supportEvidenceArtifacts.roundingPolicy),
    },
  });
  putBytes(outputs, priorSupportDatasetRel, Buffer.from(priorSupportProduced.nquads, 'utf8'));
  const priorSupportArtifactDigest = digestOf(outputs, priorSupportDatasetRel);
  const priorSupportGraphDigest = computeNamedGraphDigest(
    priorSupportProduced.nquads,
    SUPPORT_GRAPH_IRI,
  ).digest;
  const supportNs = `${identityNs}prior-support/`;
  const supportDirect = (field) => ({
    bindingType: 'directField',
    source: { dataset: 'row', field },
  });
  const supportTemporal = {
    availabilityTime: { closePolicy: 'explicitOnly', from: supportDirect('available_from') },
    knowledgeTime: { closePolicy: 'explicitOnly', from: supportDirect('knowledge_from') },
    patternRef: TEMPORAL,
    validTime: { closePolicy: 'explicitOnly', from: supportDirect('valid_from') },
  };
  const supportMappingSpecs = [
    {
      id: 'financial-instrument', logicalField: 'instrument_logical_iri',
      moduleIri: 'https://axiolune.ai/ontology/finance/instruments',
      slots: [], targetType: `${I}FinancialInstrument`, versionField: 'instrument_version_iri',
    },
    {
      id: 'instrument-listing', logicalField: null,
      moduleIri: 'https://axiolune.ai/ontology/finance/instruments',
      slots: [
        ['attribute', `${I}listingBusinessFrom`, 'listing_business_from'],
        [
          'relation', `${I}listingFacility`, 'listing_facility_version_iri',
          'https://axiolune.ai/ontology/finance/market-structure/TradingFacility',
        ],
        ['relation', `${I}listedInstrument`, 'instrument_version_iri', `${I}FinancialInstrument`],
        ['relation', `${I}listingQuoteCurrency`, 'quotation_currency_iri', `${F}Currency`],
      ],
      targetType: `${I}InstrumentListing`, versionField: 'listing_version_iri',
    },
    {
      id: 'direct-unit-quotation', logicalField: null,
      moduleIri: 'https://axiolune.ai/ontology/finance/instruments',
      slots: [
        ['attribute', `${I}quotationDenominatorUnit`, 'quotation_denominator_unit'],
        ['relation', `${I}quotationInstrument`, 'instrument_logical_iri', `${I}FinancialInstrument`],
        ['relation', `${I}quotationListingContext`, 'listing_version_iri', `${I}InstrumentListing`],
        ['relation', `${I}quotationQuoteCurrency`, 'quotation_currency_iri', `${F}Currency`],
      ],
      targetType: `${I}DirectUnitPriceQuotationContract`,
      versionField: 'quotation_contract_version_iri',
    },
    {
      id: 'trading-facility', logicalField: null,
      moduleIri: 'https://axiolune.ai/ontology/finance/market-structure', slots: [],
      targetType: 'https://axiolune.ai/ontology/finance/market-structure/TradingFacility',
      versionField: 'listing_facility_version_iri',
    },
    {
      id: 'portfolio-observation-stream',
      logicalField: 'portfolio_observation_stream_logical_iri',
      moduleIri: 'https://axiolune.ai/ontology/finance/portfolio-positions',
      slots: [
        [
          'relation',
          `${P}portfolioObservationStreamProvider`,
          'provider_iri',
          `${F}Party`,
        ],
        ['attribute', `${P}portfolioObservationStreamId`, 'portfolio_observation_stream_id'],
        [
          'attribute',
          `${P}portfolioObservationSourceContractRef`,
          'portfolio_observation_source_contract_ref',
        ],
        [
          'attribute',
          `${P}portfolioObservationSourceContractDigest`,
          'portfolio_observation_source_contract_digest',
        ],
        [
          'attribute',
          `${P}portfolioObservationCompletenessContractRef`,
          'portfolio_observation_completeness_contract_ref',
        ],
        [
          'attribute',
          `${P}portfolioObservationCompletenessContractDigest`,
          'portfolio_observation_completeness_contract_digest',
        ],
        [
          'attribute',
          `${P}portfolioObservationPaginationContractRef`,
          'portfolio_observation_pagination_contract_ref',
        ],
        [
          'attribute',
          `${P}portfolioObservationPaginationContractDigest`,
          'portfolio_observation_pagination_contract_digest',
        ],
        [
          'attribute',
          'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactRef',
          'portfolio_observation_source_artifact_ref',
        ],
        [
          'attribute',
          'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactDigest',
          'portfolio_observation_source_artifact_digest',
        ],
        [
          'attribute',
          'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceLocator',
          'portfolio_observation_source_locator_iri',
        ],
      ],
      sourceField: 'portfolio_observation_source_artifact_ref',
      targetType: `${P}PortfolioObservationStream`,
      versionField: 'portfolio_observation_stream_version_iri',
    },
    {
      id: 'portfolio-membership', logicalField: null,
      moduleIri: 'https://axiolune.ai/ontology/finance/portfolio-positions',
      slots: [
        ['participantRole', `${P}PortfolioAccountMembership/role/membershipPortfolio`, 'portfolio_logical_iri'],
        ['participantRole', `${P}PortfolioAccountMembership/role/memberAccount`, 'account_logical_iri'],
      ],
      targetType: `${P}PortfolioAccountMembership`,
      versionValue: 'https://axiolune.ai/data/finance/portfolio-positions/membership/acme-account/version/locked',
    },
    {
      id: 'portfolio-membership-closure', logicalField: null,
      moduleIri: 'https://axiolune.ai/ontology/finance/portfolio-positions',
      slots: [
        ['participantRole', `${P}PortfolioAccountMembershipClosure/role/closurePortfolio`, 'portfolio_logical_iri'],
      ],
      targetType: `${P}PortfolioAccountMembershipClosure`,
      versionField: 'membership_closure_version_iri',
    },
    {
      id: 'valuation-definition', logicalField: null,
      moduleIri: 'https://axiolune.ai/ontology/finance/portfolio-positions',
      slots: [
        [
          'relation', `${P}valuationDefinitionQuotationContract`,
          'quotation_contract_version_iri', `${I}DirectUnitPriceQuotationContract`,
        ],
        ['attribute', `${P}formulaDigest`, 'valuation_formula_digest'],
      ],
      targetType: `${P}ValuationCalculationDefinition`,
      versionField: 'valuation_definition_version_iri',
    },
  ];
  const supportMappings = supportMappingSpecs.map((spec) => {
    const contract = {
      definition: `Authoritative upstream exact-IRI identity contract for ${spec.targetType}.`,
      iri: `${supportNs}identity-contract/${spec.id}`,
      label: `Slice A upstream ${spec.id} identity contract`,
      logicalComponents: [{ name: 'authoritativeLogicalIri' }],
      strategy: 'authoritativeExactIri',
      targetType: spec.targetType,
      versionComponents: [{ name: 'authoritativeVersionIri' }],
    };
    const contractRel = `${priorSupportRootRel}/${spec.id}-identity-contract.json`;
    put(outputs, contractRel, contract);
    const authoritativeVersionBinding = spec.versionValue
      ? { bindingType: 'literal', value: spec.versionValue }
      : supportDirect(spec.versionField);
    const logicalBinding = spec.logicalField
      ? supportDirect(spec.logicalField)
      : {
        bindingType: 'transformation',
        inputs: { versionIri: authoritativeVersionBinding },
        transformationRef: `${supportNs}transformation/version-to-logical-iri`,
      };
    const mapping = {
      identity: {
        contractRef: contract.iri,
        logicalKeyBindings: { authoritativeLogicalIri: logicalBinding },
        versionKeyBindings: {
          authoritativeVersionIri: authoritativeVersionBinding,
        },
      },
      iri: `${supportNs}mapping/${spec.id}`,
      label: `Slice A prior support ${spec.id} canonical semantic mapping`,
      mappingType: 'directTable',
      provenance: { sourceSystem: supportDirect(spec.sourceField || 'source') },
      slotMappings: spec.slots.map(([slotType, targetRef, field, targetObjectType]) => ({
        target: slotType === 'participantRole'
          ? { slotType, targetAssociation: spec.targetType, targetRole: targetRef.split('/').at(-1) }
          : slotType === 'relation'
            ? { slotType, targetObjectType, targetRelation: targetRef }
            : { slotType, targetAttribute: targetRef },
        value: supportDirect(field),
      })),
      source: { datasets: [{ alias: 'row', dataset: sourceSchema.dataset }] },
      targetType: spec.targetType,
      temporal: supportTemporal,
    };
    const mappingRel = `${priorSupportRootRel}/${spec.id}-mapping.json`;
    put(outputs, mappingRel, mapping);
    return {
      ...spec,
      contract,
      contractBinding: {
        artifactDigest: digestOf(outputs, contractRel),
        artifactRef: ref(contractRel),
        contractRef: contract.iri,
      },
      mapping,
      mappingBinding: {
        artifactDigest: digestOf(outputs, mappingRel),
        artifactRef: ref(mappingRel),
        mappingRef: mapping.iri,
        targetType: spec.targetType,
      },
    };
  });
  const supportPlanSpecs = [
    {
      id: 'instruments',
      moduleIri: 'https://axiolune.ai/ontology/finance/instruments',
      mappingIds: ['direct-unit-quotation', 'financial-instrument', 'instrument-listing'],
      runIri: 'urn:axiolune:run:slice-a:instrument-input-context:v1',
    },
    {
      id: 'market-structure',
      moduleIri: 'https://axiolune.ai/ontology/finance/market-structure',
      mappingIds: ['trading-facility'],
      runIri: 'urn:axiolune:run:slice-a:market-structure-input-context:v1',
    },
    {
      id: 'portfolio',
      moduleIri: 'https://axiolune.ai/ontology/finance/portfolio-positions',
      mappingIds: [
        'portfolio-membership',
        'portfolio-membership-closure',
        'portfolio-observation-stream',
        'valuation-definition',
      ],
      runIri: 'urn:axiolune:run:slice-a:portfolio-input-context:v1',
    },
  ];
  const supportPlans = supportPlanSpecs.map((spec) => {
    const selected = supportMappings.filter((entry) => spec.mappingIds.includes(entry.id))
      .sort((left, right) => Buffer.compare(
        Buffer.from(left.mapping.iri),
        Buffer.from(right.mapping.iri),
      ));
    const plan = {
      definition: `Prior module-scoped production of locked ${spec.id} support facts.`,
      iri: `${supportNs}plan/${spec.id}`,
      label: `Slice A prior support ${spec.id} plan`,
      materializationMode: 'Full',
      owner: 'repository-owner',
      semanticMappings: selected.map((entry) => entry.mapping.iri).sort(),
      sourceDatasets: [sourceSchema.dataset],
      targetGraphUri: SUPPORT_GRAPH_IRI,
      targetOntologyModule: spec.moduleIri,
    };
    const planRel = `${priorSupportRootRel}/${spec.id}-plan.json`;
    put(outputs, planRel, plan);
    return {
      ...spec,
      plan,
      planBinding: {
        artifactDigest: digestOf(outputs, planRel),
        artifactRef: ref(planRel),
        planRef: plan.iri,
      },
      selected,
    };
  });
  const supportBatchRel = `${priorSupportRootRel}/batch-definition.json`;
  const supportBatch = {
    consistencyRequirement: 'Transactional',
    definition: 'Prior atomic production of all locked S5 prerequisite facts.',
    dependencyEdges: [
      {
        afterPlan: `${supportNs}plan/portfolio`,
        beforePlan: `${supportNs}plan/instruments`,
      },
      {
        afterPlan: `${supportNs}plan/instruments`,
        beforePlan: `${supportNs}plan/market-structure`,
      },
    ],
    iri: `${supportNs}batch`,
    label: 'Slice A prior support batch',
    plans: supportPlans.map((entry) => entry.plan.iri).sort(),
    targetDataset: 'urn:axiolune:dataset:slice-a:prior-support:v1',
  };
  put(outputs, supportBatchRel, supportBatch);
  const supportRunBindings = [];
  const supportReportBindings = [];
  for (const plan of supportPlans) {
    const reportRel = `${priorSupportRootRel}/${plan.id}-validation-report.json`;
    const reportIri = `${supportNs}validation-report/${plan.id}`;
    const runRel = `${priorSupportRootRel}/${plan.id}-materialization-run.json`;
    const run = {
      assertionTime: '2024-07-10T00:00:00Z',
      inputSnapshotDigest: digestOf(outputs, originalSnapshotRel),
      inputSnapshotRef: ref(originalSnapshotRel),
      iri: plan.runIri,
      mappingClosure: plan.selected.map((entry) => entry.mappingBinding),
      outcome: 'completed',
      outputDatasetArtifactDigest: priorSupportArtifactDigest,
      outputDatasetArtifactRef: ref(priorSupportDatasetRel),
      outputGraphDigest: priorSupportGraphDigest,
      outputGraphIri: SUPPORT_GRAPH_IRI,
      planSourceDigest: plan.planBinding.artifactDigest,
      planSourceRef: plan.planBinding.artifactRef,
      planRef: plan.plan.iri,
      recordType: 'materializationRun',
      referenceTime: '2024-07-10T00:00:00Z',
      schemaVersion: '1.0',
      validationReportRef: reportIri,
    };
    put(outputs, runRel, run);
    const report = {
      checks: ['currentDomainSHACL', 'applicableCustom'],
      evidenceScope: 'main-consumer-revalidates-exact-locked-bytes',
      iri: reportIri,
      outcome: 'passed',
      recordType: 'validationReport',
      runArtifactDigest: digestOf(outputs, runRel),
      runArtifactRef: ref(runRel),
      runRef: plan.runIri,
      schemaVersion: '1.0',
      subjectArtifactDigest: priorSupportArtifactDigest,
      subjectArtifactRef: ref(priorSupportDatasetRel),
      subjectGraphDigest: priorSupportGraphDigest,
      subjectGraphIri: SUPPORT_GRAPH_IRI,
    };
    put(outputs, reportRel, report);
    supportRunBindings.push({
      artifactDigest: digestOf(outputs, runRel), artifactRef: ref(runRel),
      planRef: plan.plan.iri, runRef: plan.runIri,
    });
    supportReportBindings.push({
      artifactDigest: digestOf(outputs, reportRel), artifactRef: ref(reportRel),
      reportRef: reportIri, runRef: plan.runIri,
    });
  }
  supportRunBindings.sort((left, right) => Buffer.compare(Buffer.from(left.planRef), Buffer.from(right.planRef)));
  supportReportBindings.sort((left, right) => Buffer.compare(Buffer.from(left.runRef), Buffer.from(right.runRef)));
  const supportBatchRunRel = `${priorSupportRootRel}/batch-run.json`;
  const supportBatchRun = {
    assertionTime: '2024-07-10T00:00:01Z',
    batchRef: supportBatch.iri,
    batchSourceDigest: digestOf(outputs, supportBatchRel),
    batchSourceRef: ref(supportBatchRel),
    iri: `${supportNs}batch-run`,
    memberRuns: supportRunBindings,
    outcome: 'completed',
    outputDatasetArtifactDigest: priorSupportArtifactDigest,
    outputDatasetArtifactRef: ref(priorSupportDatasetRel),
    outputGraphDigest: priorSupportGraphDigest,
    recordType: 'materializationBatchRun',
    referenceTime: '2024-07-10T00:00:01Z',
    schemaVersion: '1.0',
  };
  put(outputs, supportBatchRunRel, supportBatchRun);
  const supportLedgerRel = `${priorSupportRootRel}/evidence-ledger.json`;
  const supportLedgerEntries = [
    ...supportMappings.flatMap((entry) => [entry.contractBinding, entry.mappingBinding]),
    ...supportPlans.map((entry) => entry.planBinding),
    ...supportRunBindings,
    ...supportReportBindings,
    {
      artifactDigest: digestOf(outputs, supportBatchRel), artifactRef: ref(supportBatchRel),
      batchRef: supportBatch.iri,
    },
    {
      artifactDigest: digestOf(outputs, supportBatchRunRel), artifactRef: ref(supportBatchRunRel),
      runRef: supportBatchRun.iri,
    },
    {
      artifactDigest: priorSupportArtifactDigest, artifactRef: ref(priorSupportDatasetRel),
      datasetRef: supportBatch.targetDataset,
    },
  ].sort((left, right) => Buffer.compare(
    Buffer.from(canonicalJcs(left.artifactRef)),
    Buffer.from(canonicalJcs(right.artifactRef)),
  ));
  put(outputs, supportLedgerRel, {
    entries: supportLedgerEntries,
    iri: `${supportNs}evidence-ledger`,
    recordType: 'evidenceLedger',
    schemaVersion: '1.0',
  });
  const priorSupportChainRel = `${priorSupportRootRel}/chain-manifest.json`;
  put(outputs, priorSupportChainRel, {
    batch: {
      artifactDigest: digestOf(outputs, supportBatchRel), artifactRef: ref(supportBatchRel),
      batchRef: supportBatch.iri,
    },
    batchRun: {
      artifactDigest: digestOf(outputs, supportBatchRunRel), artifactRef: ref(supportBatchRunRel),
      runRef: supportBatchRun.iri,
    },
    chainId: 'slice-a-prior-support-v1',
    dataset: {
      artifactDigest: priorSupportArtifactDigest,
      artifactRef: ref(priorSupportDatasetRel),
      datasetRef: supportBatch.targetDataset,
      graphDigest: priorSupportGraphDigest,
      graphIri: SUPPORT_GRAPH_IRI,
      snapshotTime: '2024-07-10T00:00:01Z',
    },
    dependencyEdges: supportBatch.dependencyEdges,
    identityContracts: supportMappings.map((entry) => entry.contractBinding)
      .sort((left, right) => Buffer.compare(Buffer.from(left.contractRef), Buffer.from(right.contractRef))),
    ledger: {
      artifactDigest: digestOf(outputs, supportLedgerRel), artifactRef: ref(supportLedgerRel),
      ledgerRef: `${supportNs}evidence-ledger`,
    },
    mappings: supportMappings.map((entry) => entry.mappingBinding)
      .sort((left, right) => Buffer.compare(Buffer.from(left.mappingRef), Buffer.from(right.mappingRef))),
    plans: supportPlans.map((entry) => entry.planBinding)
      .sort((left, right) => Buffer.compare(Buffer.from(left.planRef), Buffer.from(right.planRef))),
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    reports: supportReportBindings,
    runs: supportRunBindings,
    schemaVersion: '1.0',
    sourceSchema: {
      artifactDigest: digestOf(outputs, sourceSchemaRel), artifactRef: ref(sourceSchemaRel),
      datasetRef: sourceSchema.dataset,
    },
    sourceSnapshot: {
      artifactDigest: digestOf(outputs, originalSnapshotRel), artifactRef: ref(originalSnapshotRel),
      snapshotRef: ref(originalSnapshotRel),
    },
  });
  put(outputs, `${FIXTURE_ROOT_REL}/control-chain-input.json`, {
    batchDefinitionRef: ref(batchRel),
    execution: {
      asOfAvailable: '2024-07-10T00:00:00Z',
      asOfKnowledge: '2024-07-10T00:00:00Z',
      asOfValid: '2024-07-10T00:00:00Z',
      assertionTime: '2024-07-10T00:00:02Z',
      referenceTime: '2024-07-10T00:00:02Z',
      targetDataset: 'urn:axiolune:dataset:slice-a:control-chain:v1',
    },
    fixtureId: 'slice-a-s5-control-chain-v1',
    futureSnapshotRef: ref(futureSnapshotRel),
    identityCompilationRef: ref(identityCompilationRel),
    identityManifestRef: ref(identityManifestRel),
    mappings: mappingSpecs.map((spec) => ({
      mappingArtifacts: spec.mappings.map((mapping) => mapping._artifact),
      planArtifactRef: ref(`${FIXTURE_SOURCE_REL}/${spec.id}-plan.json`),
      planRef: spec.planIri,
      targetGraph: spec.targetGraph,
    })),
    ontologyClosureRef: ref(ontologyClosureRel),
    originalSnapshotRef: ref(originalSnapshotRel),
    profileRef: 'https://axiolune.ai/conformance/m2/0.3.0',
    priorSupportChainRef: ref(priorSupportChainRel),
    referenceClosureRef: ref(referenceClosureRel),
    schemaVersion: '1.0',
    sourceSchemaRef: ref(sourceSchemaRel),
    supportEvidenceClosureRef: ref(supportEvidenceClosureRel),
  });

  return outputs;
}

function writeOutputs(outputs) {
  for (const [relativePath, bytes] of outputs.entries()) {
    const absolute = path.join(ROOT, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
  }
}

function checkOutputs(outputs) {
  const drift = [];
  for (const [relativePath, expected] of outputs.entries()) {
    const absolute = path.join(ROOT, ...relativePath.split('/'));
    if (!fs.existsSync(absolute)) drift.push(`${relativePath}: missing`);
    else if (!fs.readFileSync(absolute).equals(expected)) drift.push(`${relativePath}: byte drift`);
  }
  return drift;
}

function main() {
  const mode = process.argv[2] || '--check';
  if (!['--check', '--write'].includes(mode)) {
    throw new Error('usage: node scripts/domain/generate-s5-control-record-profile.cjs [--check|--write]');
  }
  const outputs = createOutputs();
  if (mode === '--write') {
    writeOutputs(outputs);
    process.stdout.write(`generated ${outputs.size} S5 control-record profile artifacts\n`);
    return;
  }
  const drift = checkOutputs(outputs);
  if (drift.length > 0) {
    process.stderr.write(`${drift.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`PASS ${outputs.size} S5 control-record profile artifacts are deterministic\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { createOutputs };
