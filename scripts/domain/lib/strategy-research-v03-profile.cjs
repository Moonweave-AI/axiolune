'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  TAGS,
  artifactDigest,
  canonicalJcs,
  taggedJcsDigest,
} = require('./identity-contract-compiler.cjs');
const {
  UNIT_ONE,
} = require('./strategy-research-quantity-units.cjs');
const {
  computeSelectionDigest,
} = require('./strict-source-locator.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0/strategy-research';
const BASE = 'https://axiolune.ai/ontology/finance/strategy-research/';
const META_TEMPORAL = 'https://axiolune.ai/ontology/meta/patterns/TemporalFact';
const META_PROVENANCE = 'https://axiolune.ai/ontology/meta/patterns/ProvenancedFact';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const PROFILE_ROOT = path.join(ROOT, 'scripts', 'domain', 'strategy-research-v03-profile');
const MAPPING_ROOT = path.join(ROOT, 'mappings', 'finance', 'v0.3.0', 'strategy-research');
const CQ_ROOT = path.join(ROOT, 'tests', 'm2', 'cq', 'strategy-research');
const INFRA_ROOT = path.join(ROOT, 'docs', 'domain', 'infrastructure');

const PATHS = Object.freeze({
  artifactManifest: path.join(MAPPING_ROOT, 'artifact-set-manifest.json'),
  calculationParameterExtractorProfile: path.join(ROOT, 'tests', 'm2', 'fixtures', 'strategy-research', 'evidence', 'whole-file-json-v1.json'),
  calculationParameterFullRunSnapshot: path.join(ROOT, 'tests', 'm2', 'fixtures', 'strategy-research', 'evidence', 'calculation-parameters-full-run-simple-sum-v1.json'),
  calculationParameterInvalidPolicySnapshot: path.join(ROOT, 'tests', 'm2', 'fixtures', 'strategy-research', 'evidence', 'calculation-parameters-invalid-policy-v1.json'),
  calculationParameterLogSumSnapshot: path.join(ROOT, 'tests', 'm2', 'fixtures', 'strategy-research', 'evidence', 'calculation-parameters-monthly-log-sum-v1.json'),
  calculationParameterLookAheadSnapshot: path.join(ROOT, 'tests', 'm2', 'fixtures', 'strategy-research', 'evidence', 'calculation-parameters-lookahead-bfill-v1.json'),
  calculationParameterAnchorMismatchSnapshot: path.join(ROOT, 'tests', 'm2', 'fixtures', 'strategy-research', 'evidence', 'calculation-parameters-daily-month-end-v1.json'),
  calculationParameterSnapshot: path.join(ROOT, 'tests', 'm2', 'fixtures', 'strategy-research', 'evidence', 'calculation-parameters-daily-simple-compound-v1.json'),
  card: path.join(ROOT, 'docs', 'ontology', 'competency-questions', 'fin-strategy-research-cq.yaml'),
  contractImplementation: path.join(ROOT, 'scripts', 'domain', 'lib', 'strategy-research-contracts.cjs'),
  cqEvidence: path.join(INFRA_ROOT, 'strategy-research-cq-evidence.json'),
  evidenceImplementation: path.join(ROOT, 'scripts', 'domain', 'lib', 'strategy-research-release-evidence.cjs'),
  expectedBindings: path.join(CQ_ROOT, 'expected-bindings.json'),
  formulaClosure: path.join(PROFILE_ROOT, 'formula-runtime-closure.json'),
  formulaDefinitions: path.join(PROFILE_ROOT, 'formula-definitions.json'),
  formulaEvidence: path.join(INFRA_ROOT, 'strategy-research-executable-evidence.json'),
  formulaVectors: path.join(PROFILE_ROOT, 'formula-vectors.json'),
  formulaWorker: path.join(ROOT, 'scripts', 'domain', 'strategy-research-formula-worker.cjs'),
  generator: path.join(ROOT, 'scripts', 'domain', 'generate-strategy-research-v03-evidence.cjs'),
  identityCompiler: path.join(ROOT, 'scripts', 'domain', 'lib', 'identity-contract-compiler.cjs'),
  identityManifest: path.join(MAPPING_ROOT, 'identity-manifest.json'),
  identityRegistry: path.join(MAPPING_ROOT, 'identity-term-registry.json'),
  mappingEvidence: path.join(INFRA_ROOT, 'strategy-research-mapping-evidence.json'),
  mappingSet: path.join(MAPPING_ROOT, 'semantic-mapping-set.json'),
  materializedOutput: path.join(MAPPING_ROOT, 'materialized-output.json'),
  module: path.join(ROOT, 'ontology', 'domain', 'finance', 'strategy-research', 'module.yaml'),
  negativeFixture: path.join(ROOT, 'tests', 'm2', 'fixtures', 'strategy-research', 'negative.yaml'),
  normalizationContract: path.join(PROFILE_ROOT, 'normalization-contract.json'),
  normalizationImplementation: path.join(ROOT, 'scripts', 'domain', 'lib', 'strategy-research-release-evidence.cjs'),
  normalizationVectors: path.join(PROFILE_ROOT, 'normalization-vectors.json'),
  pitEvidence: path.join(INFRA_ROOT, 'strategy-research-pit-replay-evidence.json'),
  pitRequests: path.join(CQ_ROOT, 'pit-requests.json'),
  positiveFixture: path.join(ROOT, 'tests', 'm2', 'fixtures', 'strategy-research', 'positive.yaml'),
  quantityUnitRegistry: path.join(PROFILE_ROOT, 'quantity-unit-registry.json'),
  quantityUnitRegistryImplementation: path.join(ROOT, 'scripts', 'domain', 'lib', 'strategy-research-quantity-units.cjs'),
  sourceSchema: path.join(MAPPING_ROOT, 'source-schema.json'),
  sourceSnapshot: path.join(MAPPING_ROOT, 'source-snapshot.json'),
  validationCli: path.join(ROOT, 'scripts', 'domain', 'validate-strategy-research-contract.cjs'),
});

const RELEASE_TARGETS = Object.freeze([
  `${BASE}BacktestRun`,
  `${BASE}FactorDefinition`,
  `${BASE}PerformanceObservation`,
  `${BASE}Signal`,
  `${BASE}StrategyDefinition`,
].sort(compareUtf8));

const MATERIALIZED_TARGETS = Object.freeze([
  ...RELEASE_TARGETS,
  `${BASE}CalculationContext`,
  `${BASE}MetricDefinition`,
].sort(compareUtf8));

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function repositoryPath(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function artifact(relativePath) {
  return { kind: 'path', path: relativePath, root: 'sourceTree' };
}

function fileDigest(file) {
  return artifactDigest(fs.readFileSync(file));
}

function jcsBytes(value) {
  return Buffer.from(canonicalJcs(value), 'utf8');
}

function jcsDigest(value) {
  return artifactDigest(jcsBytes(value));
}

function direct(dataset, field) {
  return { bindingType: 'directField', source: { dataset, field } };
}

function reference(targetMappingRef, referenceMode, keyBindings) {
  return { bindingType: 'referenceIdentity', keyBindings, referenceMode, targetMappingRef };
}

function runtimeContext(contextField) {
  return { bindingType: 'runtimeContext', contextField };
}

function attributeSlot(targetAttribute, value) {
  return { target: { slotType: 'attribute', targetAttribute }, value };
}

function relationSlot(targetRelation, targetObjectType, value) {
  return { target: { slotType: 'relation', targetObjectType, targetRelation }, value };
}

function roleSlot(targetAssociation, targetRole, value) {
  return { target: { slotType: 'participantRole', targetAssociation, targetRole }, value };
}

function patternFieldSlot(targetPattern, targetField, value) {
  return { target: { slotType: 'patternField', targetField, targetPattern }, value };
}

function semanticAttribute(containingType, name) {
  return { attributeRef: `${BASE}${name}`, containingType, valueKind: 'attributeUse' };
}

function semanticRelation(relationRef, subjectType, objectType) {
  return { objectType, relationRef, subjectType, valueKind: 'relationUse' };
}

function semanticRole(containingAssociation, roleId) {
  return {
    containingAssociation,
    effectivePredicate: `${containingAssociation}/role/${roleId}`,
    roleId,
    valueKind: 'participantRole',
  };
}

function semanticPattern(containingType, fieldRef) {
  return {
    containingType,
    fieldRef: `https://axiolune.ai/ontology/meta/patterns/${fieldRef}`,
    patternRef: META_TEMPORAL,
    valueKind: 'patternField',
  };
}

function buildNormalizationContract() {
  return {
    algorithms: [
      { algorithmId: 'canonical_date_time_stamp', inputKind: 'string', outputKind: 'xsd:dateTimeStamp' },
      { algorithmId: 'canonical_integer', inputKind: 'safeInteger', outputKind: 'xsd:integer' },
      { algorithmId: 'canonical_iri', inputKind: 'absoluteIri', outputKind: 'iri' },
      { algorithmId: 'canonical_string', inputKind: 'string', outputKind: 'xsd:string' },
    ],
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
  };
}

function buildNormalizationVectors() {
  return {
    schemaVersion: '1.0',
    vectors: [
      { algorithmId: 'canonical_date_time_stamp', input: '2025-01-10T00:00:00Z', output: '"2025-01-10T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTimeStamp>' },
      { algorithmId: 'canonical_integer', input: 1, output: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      { algorithmId: 'canonical_iri', input: 'https://axiolune.ai/data/example', output: '<https://axiolune.ai/data/example>' },
      { algorithmId: 'canonical_string', input: 'momentum-20', output: '"momentum-20"^^<http://www.w3.org/2001/XMLSchema#string>' },
    ],
  };
}

function termDefinition(suffix, label, termContract) {
  const definition = {
    definition: `Canonical identity term contract for ${label}.`,
    iri: `${PROFILE_REF}/term-contract/${suffix}`,
    label,
    termContract,
  };
  return {
    definition,
    termContractDigest: taggedJcsDigest(TAGS.termContract, definition),
    termContractRef: definition.iri,
  };
}

function buildRegistry() {
  const terms = [
    termDefinition('backtest-logical', 'BacktestRun logical IRI', { expectedTargetType: `${BASE}BacktestRun`, referenceMode: 'logical', termKind: 'iri' }),
    termDefinition('calculation-logical', 'CalculationContext logical IRI', { expectedTargetType: `${BASE}CalculationContext`, referenceMode: 'logical', termKind: 'iri' }),
    termDefinition('date-time-stamp', 'UTC date-time stamp', { datatypeIri: `${XSD}dateTimeStamp`, termKind: 'literal' }),
    termDefinition('integer', 'Canonical integer', { datatypeIri: `${XSD}integer`, termKind: 'literal' }),
    termDefinition('metric-logical', 'MetricDefinition logical IRI', { expectedTargetType: `${BASE}MetricDefinition`, referenceMode: 'logical', termKind: 'iri' }),
    termDefinition('party-logical', 'Party logical IRI', { expectedTargetType: 'https://axiolune.ai/ontology/finance/foundation/Party', referenceMode: 'logical', termKind: 'iri' }),
    termDefinition('strategy-logical', 'StrategyDefinition logical IRI', { expectedTargetType: `${BASE}StrategyDefinition`, referenceMode: 'logical', termKind: 'iri' }),
    termDefinition('string', 'Canonical string', { datatypeIri: `${XSD}string`, termKind: 'literal' }),
  ].sort((left, right) => compareUtf8(left.termContractRef, right.termContractRef));
  const registry = {
    controlledSets: [],
    profileRef: PROFILE_REF,
    schemaVersion: '1.0',
    termContracts: terms,
  };
  return { registry, registryDigest: taggedJcsDigest(TAGS.termRegistry, registry) };
}

function algorithmForTerm(row) {
  const contract = row.definition.termContract;
  if (contract.termKind === 'iri') return 'canonical_iri';
  if (contract.datatypeIri === `${XSD}integer`) return 'canonical_integer';
  if (contract.datatypeIri === `${XSD}dateTimeStamp`) return 'canonical_date_time_stamp';
  return 'canonical_string';
}

function buildNormalizationRules(registry) {
  const specificationRef = artifact(repositoryPath(PATHS.normalizationContract));
  const testVectorsRef = artifact(repositoryPath(PATHS.normalizationVectors));
  const implementationRef = artifact(repositoryPath(PATHS.normalizationImplementation));
  const specificationDigest = fileDigest(PATHS.normalizationContract);
  const testVectorsDigest = fileDigest(PATHS.normalizationVectors);
  const implementationDigest = fileDigest(PATHS.normalizationImplementation);
  return registry.termContracts.map((term) => {
    const suffix = term.termContractRef.split('/').at(-1);
    return {
      algorithmId: algorithmForTerm(term),
      algorithmVersion: '1.0.0',
      definition: `Identity normalization for ${term.definition.label}.`,
      implementationDigest,
      implementationRef,
      inputTermContractDigest: term.termContractDigest,
      inputTermContractRef: term.termContractRef,
      iri: `${PROFILE_REF}/normalization/${suffix}`,
      label: `${term.definition.label} normalization`,
      outputTermContractDigest: term.termContractDigest,
      outputTermContractRef: term.termContractRef,
      specificationDigest,
      specificationRef,
      testVectorsDigest,
      testVectorsRef,
    };
  });
}

function componentFactory(registry, rules) {
  const termBySuffix = new Map(registry.termContracts.map((row) => [row.termContractRef.split('/').at(-1), row]));
  const ruleBySuffix = new Map(rules.map((row) => [row.iri.split('/').at(-1), row]));
  return (name, semanticValue, termSuffix) => {
    const term = termBySuffix.get(termSuffix);
    const rule = ruleBySuffix.get(termSuffix);
    return {
      name,
      normalizationRuleDigest: taggedJcsDigest(TAGS.normalizationRule, rule),
      normalizationRuleRef: rule.iri,
      semanticValue,
      termContractDigest: term.termContractDigest,
      termContractRef: term.termContractRef,
    };
  };
}

function versionComponents(component, targetType) {
  return [
    component('validFrom', semanticPattern(targetType, 'validFrom'), 'date-time-stamp'),
    component('knowledgeFrom', semanticPattern(targetType, 'knowledgeFrom'), 'date-time-stamp'),
    component('availableFrom', semanticPattern(targetType, 'availableFrom'), 'date-time-stamp'),
    component('revision', semanticPattern(targetType, 'revision'), 'integer'),
  ];
}

function buildContracts(registry, rules) {
  const component = componentFactory(registry, rules);
  function contract(suffix, targetType, identityBaseIri, logicalComponents) {
    return {
      definition: `Contract-bound logical and immutable version identity for ${suffix}.`,
      identityBaseIri,
      iri: `${PROFILE_REF}/identity-contract/${suffix}`,
      label: `${suffix} identity contract`,
      logicalComponents,
      targetType,
      versionComponents: versionComponents(component, targetType),
    };
  }
  const generatorLogical = (targetType) => [
    component('authority', semanticRelation(`${BASE}generatorAuthority`, targetType, 'https://axiolune.ai/ontology/finance/foundation/Party'), 'party-logical'),
    component('generatorId', semanticAttribute(`${BASE}SignalGenerator`, 'generatorId'), 'string'),
  ];
  return [
    contract('backtest-run', `${BASE}BacktestRun`, 'https://axiolune.ai/data/strategy-research/backtest', [
      component('authority', semanticRelation(`${BASE}runAuthority`, `${BASE}BacktestRun`, 'https://axiolune.ai/ontology/finance/foundation/Party'), 'party-logical'),
      component('runContextId', semanticAttribute(`${BASE}RunContext`, 'runContextId'), 'string'),
    ]),
    contract('calculation-context', `${BASE}CalculationContext`, 'https://axiolune.ai/data/strategy-research/calculation-context', [
      component('authority', semanticRelation(`${BASE}calculationAuthority`, `${BASE}CalculationContext`, 'https://axiolune.ai/ontology/finance/foundation/Party'), 'party-logical'),
      component('calculationContextId', semanticAttribute(`${BASE}CalculationContext`, 'calculationContextId'), 'string'),
    ]),
    contract('factor-definition', `${BASE}FactorDefinition`, 'https://axiolune.ai/data/strategy-research/factor-definition', generatorLogical(`${BASE}FactorDefinition`)),
    contract('metric-definition', `${BASE}MetricDefinition`, 'https://axiolune.ai/data/strategy-research/metric-definition', [
      component('authority', semanticRelation(`${BASE}metricAuthority`, `${BASE}MetricDefinition`, 'https://axiolune.ai/ontology/finance/foundation/Party'), 'party-logical'),
      component('metricDefinitionId', semanticAttribute(`${BASE}MetricDefinition`, 'metricDefinitionId'), 'string'),
    ]),
    contract('performance-observation', `${BASE}PerformanceObservation`, 'https://axiolune.ai/data/strategy-research/performance', [
      component('runContext', semanticRole(`${BASE}PerformanceObservation`, 'performanceRunContext'), 'backtest-logical'),
      component('metric', semanticRole(`${BASE}PerformanceObservation`, 'performanceMetric'), 'metric-logical'),
      component('calculationContext', semanticRole(`${BASE}PerformanceObservation`, 'performanceCalculationContext'), 'calculation-logical'),
      component('sourcePerformanceId', semanticAttribute(`${BASE}PerformanceObservation`, 'sourcePerformanceId'), 'string'),
    ]),
    contract('signal', `${BASE}Signal`, 'https://axiolune.ai/data/strategy-research/signal', [
      component('generator', semanticRole(`${BASE}Signal`, 'signalGenerator'), 'strategy-logical'),
      component('runContext', semanticRole(`${BASE}Signal`, 'signalRunContext'), 'backtest-logical'),
      component('sourceSignalId', semanticAttribute(`${BASE}Signal`, 'sourceSignalId'), 'string'),
    ]),
    contract('strategy-definition', `${BASE}StrategyDefinition`, 'https://axiolune.ai/data/strategy-research/strategy-definition', generatorLogical(`${BASE}StrategyDefinition`)),
  ].sort((left, right) => compareUtf8(left.targetType, right.targetType));
}

function commonIdentity(dataset) {
  return {
    versionKeyBindings: {
      availableFrom: direct(dataset, 'available_from'),
      knowledgeFrom: direct(dataset, 'knowledge_from'),
      revision: direct(dataset, 'revision'),
      validFrom: direct(dataset, 'valid_from'),
    },
  };
}

function temporal(dataset) {
  return {
    availabilityTime: { from: direct(dataset, 'available_from') },
    knowledgeTime: { closePolicy: 'closePreviousVersion', from: direct(dataset, 'knowledge_from') },
    patternRef: META_TEMPORAL,
    validTime: { from: direct(dataset, 'valid_from'), to: direct(dataset, 'valid_to') },
  };
}

function provenance(dataset) {
  return {
    acquisitionTime: direct(dataset, 'acquisition_time'),
    sourceSystem: direct(dataset, 'source_system'),
  };
}

function mappingSkeleton(contracts, suffix, dataset, targetType, logicalKeyBindings, slotMappings) {
  const contract = contracts.find((row) => row.targetType === targetType);
  return {
    identity: {
      ...commonIdentity(dataset),
      contractRef: contract.iri,
      logicalKeyBindings,
    },
    iri: `${PROFILE_REF}/mapping/${suffix}`,
    label: `${suffix} SemanticMappingDefinition`,
    mappingType: 'directTable',
    provenance: provenance(dataset),
    slotMappings: [
      ...slotMappings,
      patternFieldSlot(META_PROVENANCE, 'generatingContextRef', runtimeContext('iri')),
    ],
    source: { datasets: [{ alias: dataset, dataset: `${PROFILE_REF}/source-dataset/${dataset}` }] },
    targetType,
    temporal: temporal(dataset),
  };
}

function generatorSlots(dataset) {
  return [
    'generatorId', 'generatorName', 'implementationDigest', 'inputContractDigest',
    'outputContractDigest', 'toolLockRef', 'toolLockDigest', 'runtimeDigest',
    'sourceArtifactRef', 'sourceArtifactDigest', 'sourceLocator',
  ].map((name) => attributeSlot(attributeIri(name), direct(dataset, snake(name))));
}

function attributeIri(name) {
  return ['sourceArtifactRef', 'sourceArtifactDigest', 'sourceLocator'].includes(name)
    ? `https://axiolune.ai/ontology/meta/data-binding/attributes/${name}`
    : `${BASE}${name}`;
}

function snake(value) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function exactReference(mappingRef, prefix) {
  return reference(mappingRef, 'version', {
    authority: direct(prefix.dataset, `${prefix.field}_authority_iri`),
    availableFrom: direct(prefix.dataset, `${prefix.field}_available_from`),
    generatorId: direct(prefix.dataset, `${prefix.field}_id`),
    knowledgeFrom: direct(prefix.dataset, `${prefix.field}_knowledge_from`),
    revision: direct(prefix.dataset, `${prefix.field}_revision`),
    validFrom: direct(prefix.dataset, `${prefix.field}_valid_from`),
  });
}

function exactBacktestReference(mappingRef, dataset, prefix = 'run') {
  return reference(mappingRef, 'version', {
    authority: direct(dataset, `${prefix}_authority_iri`),
    availableFrom: direct(dataset, `${prefix}_available_from`),
    knowledgeFrom: direct(dataset, `${prefix}_knowledge_from`),
    revision: direct(dataset, `${prefix}_revision`),
    runContextId: direct(dataset, `${prefix}_id`),
    validFrom: direct(dataset, `${prefix}_valid_from`),
  });
}

function exactAuthorityIdReference(mappingRef, dataset, prefix, idName) {
  return reference(mappingRef, 'version', {
    authority: direct(dataset, `${prefix}_authority_iri`),
    availableFrom: direct(dataset, `${prefix}_available_from`),
    [idName]: direct(dataset, `${prefix}_id`),
    knowledgeFrom: direct(dataset, `${prefix}_knowledge_from`),
    revision: direct(dataset, `${prefix}_revision`),
    validFrom: direct(dataset, `${prefix}_valid_from`),
  });
}

function buildMappings(contracts) {
  const refs = Object.fromEntries([
    ['backtest', `${PROFILE_REF}/mapping/backtest-run`],
    ['calculation', `${PROFILE_REF}/mapping/calculation-context`],
    ['factor', `${PROFILE_REF}/mapping/factor-definition`],
    ['metric', `${PROFILE_REF}/mapping/metric-definition`],
    ['performance', `${PROFILE_REF}/mapping/performance-observation`],
    ['signal', `${PROFILE_REF}/mapping/signal`],
    ['strategy', `${PROFILE_REF}/mapping/strategy-definition`],
  ]);

  const factor = mappingSkeleton(
    contracts, 'factor-definition', 'factor', `${BASE}FactorDefinition`,
    { authority: direct('factor', 'authority_iri'), generatorId: direct('factor', 'generator_id') },
    [
      ...generatorSlots('factor'),
      attributeSlot(`${BASE}factorExpressionRef`, direct('factor', 'factor_expression_ref')),
      attributeSlot(`${BASE}factorExpressionDigest`, direct('factor', 'factor_expression_digest')),
    ],
  );
  const strategy = mappingSkeleton(
    contracts, 'strategy-definition', 'strategy', `${BASE}StrategyDefinition`,
    { authority: direct('strategy', 'authority_iri'), generatorId: direct('strategy', 'generator_id') },
    [
      ...generatorSlots('strategy'),
      relationSlot(`${BASE}usesFactor`, `${BASE}FactorDefinition`, exactReference(refs.factor, { dataset: 'strategy', field: 'factor' })),
    ],
  );
  const backtestFields = [
    'runContextId', 'runContextKind', 'runStartedAt', 'parameterSnapshotRef',
    'parameterSnapshotDigest', 'ontologyClosureDigest', 'mappingClosureDigest',
    'calendarSnapshotRef', 'calendarSnapshotDigest', 'compilerDigest',
    'inputContextRef', 'inputContextRecordDigest', 'pitRequestRef', 'pitRequestRecordDigest',
    'sourceArtifactRef', 'sourceArtifactDigest', 'sourceLocator', 'simulationFrom',
    'simulationTo', 'initialCapital', 'codeDefinitionDigest', 'feeAssumptionRef',
    'feeAssumptionDigest', 'slippageAssumptionRef', 'slippageAssumptionDigest',
    'fillAssumptionRef', 'fillAssumptionDigest', 'benchmarkRef', 'benchmarkDigest',
    'deterministicSeed',
  ];
  const backtest = mappingSkeleton(
    contracts, 'backtest-run', 'backtest', `${BASE}BacktestRun`,
    { authority: direct('backtest', 'authority_iri'), runContextId: direct('backtest', 'run_context_id') },
    [
      ...backtestFields.map((name) => attributeSlot(attributeIri(name), direct('backtest', snake(name)))),
      relationSlot(`${BASE}backtestStrategy`, `${BASE}StrategyDefinition`, exactReference(refs.strategy, { dataset: 'backtest', field: 'strategy' })),
    ],
  );
  const metricFields = [
    'metricDefinitionId', 'metricName', 'metricValueKind', 'formulaDigest',
    'implementationDigest', 'inputContractDigest', 'outputContractDigest',
    'toolLockRef', 'toolLockDigest', 'runtimeDigest',
  ];
  const metric = mappingSkeleton(
    contracts, 'metric-definition', 'metric', `${BASE}MetricDefinition`,
    { authority: direct('metric', 'authority_iri'), metricDefinitionId: direct('metric', 'metric_definition_id') },
    metricFields.map((name) => attributeSlot(`${BASE}${name}`, direct('metric', snake(name)))),
  );
  const calculationFields = [
    'calculationContextId', 'calculationFrequency', 'annualizationFactor', 'riskFreeRate', 'calculationWindow',
    'confidenceLevel', 'calculationImplementationDigest', 'calculationParameterSnapshotRef',
    'calculationParameterSnapshotDigest', 'calculationParameterSnapshotLocator', 'benchmarkRef', 'benchmarkDigest',
  ];
  const calculation = mappingSkeleton(
    contracts, 'calculation-context', 'calculation', `${BASE}CalculationContext`,
    { authority: direct('calculation', 'authority_iri'), calculationContextId: direct('calculation', 'calculation_context_id') },
    calculationFields.map((name) => attributeSlot(`${BASE}${name}`, direct('calculation', snake(name)))),
  );
  const signal = mappingSkeleton(
    contracts, 'signal', 'signal', `${BASE}Signal`,
    {
      generator: reference(refs.strategy, 'logical', {
        authority: direct('signal', 'generator_authority_iri'),
        generatorId: direct('signal', 'generator_id'),
      }),
      runContext: reference(refs.backtest, 'logical', {
        authority: direct('signal', 'run_authority_iri'),
        runContextId: direct('signal', 'run_id'),
      }),
      sourceSignalId: direct('signal', 'source_signal_id'),
    },
    [
      attributeSlot(`${BASE}sourceSignalId`, direct('signal', 'source_signal_id')),
      attributeSlot(`${BASE}signalDirection`, direct('signal', 'direction')),
      attributeSlot(`${BASE}signalStrength`, direct('signal', 'strength')),
      attributeSlot(`${BASE}signalHorizon`, direct('signal', 'horizon')),
      roleSlot(`${BASE}Signal`, 'signalGenerator', exactReference(refs.strategy, { dataset: 'signal', field: 'generator' })),
      roleSlot(`${BASE}Signal`, 'signalInstrument', direct('signal', 'instrument_version_iri')),
      roleSlot(`${BASE}Signal`, 'signalRunContext', exactBacktestReference(refs.backtest, 'signal', 'run')),
    ],
  );
  const performance = mappingSkeleton(
    contracts, 'performance-observation', 'performance', `${BASE}PerformanceObservation`,
    {
      calculationContext: reference(refs.calculation, 'logical', {
        authority: direct('performance', 'calculation_authority_iri'),
        calculationContextId: direct('performance', 'calculation_id'),
      }),
      metric: reference(refs.metric, 'logical', {
        authority: direct('performance', 'metric_authority_iri'),
        metricDefinitionId: direct('performance', 'metric_id'),
      }),
      runContext: reference(refs.backtest, 'logical', {
        authority: direct('performance', 'run_authority_iri'),
        runContextId: direct('performance', 'run_id'),
      }),
      sourcePerformanceId: direct('performance', 'source_performance_id'),
    },
    [
      attributeSlot(`${BASE}sourcePerformanceId`, direct('performance', 'source_performance_id')),
      attributeSlot(`${BASE}performanceQuantityValue`, direct('performance', 'quantity_value')),
      roleSlot(`${BASE}PerformanceObservation`, 'performanceMetric', exactAuthorityIdReference(refs.metric, 'performance', 'metric', 'metricDefinitionId')),
      roleSlot(`${BASE}PerformanceObservation`, 'performanceRunContext', exactBacktestReference(refs.backtest, 'performance', 'run')),
      roleSlot(`${BASE}PerformanceObservation`, 'performanceCalculationContext', exactAuthorityIdReference(refs.calculation, 'performance', 'calculation', 'calculationContextId')),
    ],
  );
  return [backtest, calculation, factor, metric, performance, signal, strategy]
    .sort((left, right) => compareUtf8(left.iri, right.iri));
}

function buildMappingSet() {
  const { registry, registryDigest } = buildRegistry();
  const normalizationRules = buildNormalizationRules(registry);
  const contracts = buildContracts(registry, normalizationRules);
  const mappings = buildMappings(contracts);
  return {
    concreteTargetTypes: [...MATERIALIZED_TARGETS],
    contracts,
    derivations: [],
    identityTermRegistry: registry,
    identityTermRegistryDigest: registryDigest,
    identityTermRegistryRef: artifact(repositoryPath(PATHS.identityRegistry)),
    mappings,
    normalizationRules,
    profileRef: PROFILE_REF,
  };
}

function commonFieldSchema() {
  return {
    acquisition_time: 'instant',
    available_from: 'instant',
    knowledge_from: 'instant',
    revision: 'integer',
    source_system: 'iri',
    valid_from: 'instant',
    valid_to: 'instant',
  };
}

function buildSourceSchema(mappingSet) {
  const datasets = {};
  for (const mapping of mappingSet.mappings) {
    const alias = mapping.source.datasets[0].alias;
    const fields = { ...commonFieldSchema() };
    function visit(binding) {
      if (!binding || typeof binding !== 'object') return;
      if (binding.bindingType === 'directField' && binding.source.dataset === alias) {
        if (!Object.hasOwn(fields, binding.source.field)) fields[binding.source.field] = 'any';
      }
      if (binding.bindingType === 'referenceIdentity') Object.values(binding.keyBindings).forEach(visit);
      if (binding.bindingType === 'transformation') Object.values(binding.inputs).forEach(visit);
    }
    Object.values(mapping.identity.logicalKeyBindings).forEach(visit);
    Object.values(mapping.identity.versionKeyBindings).forEach(visit);
    mapping.slotMappings.forEach((row) => visit(row.value));
    for (const axis of ['validTime', 'knowledgeTime', 'availabilityTime']) {
      visit(mapping.temporal[axis].from);
      if (mapping.temporal[axis].to) visit(mapping.temporal[axis].to);
    }
    Object.values(mapping.provenance).forEach(visit);
    for (const [name, kind] of Object.entries(fields)) {
      if (kind !== 'any') continue;
      if (/_digest$/u.test(name)) fields[name] = 'digest';
       else if (/source_artifact_ref|source_locator|initial_capital|strength|quantity_value|annualization_factor|risk_free_rate|calculation_window|confidence_level|calculation_parameter_snapshot_ref|calculation_parameter_snapshot_locator/u.test(name)) fields[name] = 'object';
      else if (/_iri$|_ref$/u.test(name)) fields[name] = 'iri';
      else if (/_from$|_to$|_at$|started_at$|simulation_/u.test(name)) fields[name] = 'instant';
      else if (/revision|seed/u.test(name)) fields[name] = 'integer';
      else fields[name] = 'string';
    }
    datasets[alias] = { fields, primaryKey: Object.keys(mapping.identity.logicalKeyBindings) };
  }
  return { datasets, profileRef: PROFILE_REF, schemaVersion: '1.0' };
}

function actualArtifactFields(formulaDefinitions) {
  const definitionsDigest = jcsDigest(formulaDefinitions);
  const moduleDigest = fileDigest(PATHS.module);
  const compilerDigest = fileDigest(PATHS.identityCompiler);
  const packageLockDigest = fileDigest(path.join(ROOT, 'package-lock.json'));
  const sourceArtifactRef = artifact(repositoryPath(PATHS.formulaDefinitions));
  const sourceLocator = {
    extractorProfileDigest: definitionsDigest,
    extractorProfileRef: { iri: `${PROFILE_REF}/extractor/whole-jcs-v1`, kind: 'iri' },
    kind: 'wholeFile',
    mediaType: 'application/json',
    path: repositoryPath(PATHS.formulaDefinitions),
    selectionDigest: definitionsDigest,
  };
  const calculationParameterSnapshotRef = artifact(repositoryPath(PATHS.calculationParameterSnapshot));
  const calculationParameterSnapshotDigest = fileDigest(PATHS.calculationParameterSnapshot);
  const calculationParameterSnapshotLocator = {
    extractorProfileDigest: fileDigest(PATHS.calculationParameterExtractorProfile),
    extractorProfileRef: artifact(repositoryPath(PATHS.calculationParameterExtractorProfile)),
    kind: 'wholeFile',
    mediaType: 'application/json',
    path: repositoryPath(PATHS.calculationParameterSnapshot),
  };
  calculationParameterSnapshotLocator.selectionDigest = computeSelectionDigest(
    calculationParameterSnapshotLocator,
    fs.readFileSync(PATHS.calculationParameterSnapshot),
  );
  return {
    calculationParameterSnapshotDigest,
    calculationParameterSnapshotLocator,
    calculationParameterSnapshotRef,
    compilerDigest,
    definitionsDigest,
    moduleDigest,
    packageLockDigest,
    sourceArtifactDigest: definitionsDigest,
    sourceArtifactRef,
    sourceLocator,
  };
}

function formulaRow(definitions, formulaId) {
  const row = definitions.definitions.find((value) => value.formulaId === formulaId);
  if (!row) throw new Error(`missing formula definition ${formulaId}`);
  return row;
}

function commonRow(overrides = {}) {
  return {
    acquisition_time: '2025-01-10T00:00:02Z',
    available_from: '2025-01-10T00:00:01Z',
    knowledge_from: '2025-01-10T00:00:00Z',
    revision: 0,
    source_system: `${PROFILE_REF}/source-system/synthetic-reviewed`,
    valid_from: '2024-01-01T00:00:00Z',
    valid_to: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function executableFields(actual, definition, id, name) {
  return {
    generator_id: id,
    generator_name: name,
    implementation_digest: definition.implementationDigest,
    input_contract_digest: definition.inputContractDigest,
    output_contract_digest: definition.outputContractDigest,
    runtime_digest: fileDigest(process.execPath),
    source_artifact_digest: actual.sourceArtifactDigest,
    source_artifact_ref: actual.sourceArtifactRef,
    source_locator: actual.sourceLocator,
    tool_lock_digest: actual.packageLockDigest,
    tool_lock_ref: `${PROFILE_REF}/tool-lock/package-lock`,
  };
}

function versionReference(prefix, authorityIri, id, times = {}) {
  return {
    [`${prefix}_authority_iri`]: authorityIri,
    [`${prefix}_available_from`]: times.availableFrom || '2025-01-10T00:00:01Z',
    [`${prefix}_id`]: id,
    [`${prefix}_knowledge_from`]: times.knowledgeFrom || '2025-01-10T00:00:00Z',
    [`${prefix}_revision`]: times.revision || 0,
    [`${prefix}_valid_from`]: times.validFrom || '2024-01-01T00:00:00Z',
  };
}

function buildSourceSnapshot(mappingSet, formulaDefinitions) {
  const actual = actualArtifactFields(formulaDefinitions);
  const signalFormula = formulaRow(formulaDefinitions, 'momentum-signal-v1');
  const metricFormula = formulaRow(formulaDefinitions, 'total-return-v1');
  const authority = 'https://axiolune.ai/data/party/research-governance';
  const strategyRef = versionReference('strategy', authority, 'momentum-strategy');
  const factorRef = versionReference('factor', authority, 'momentum-20');
  const runRef = versionReference('run', authority, 'backtest-2024');
  const metricRef = versionReference('metric', authority, 'total-return');
  const calculationRef = versionReference('calculation', authority, 'daily-close');
  const rows = {
    backtest: [commonRow({
      authority_iri: authority,
      benchmark_digest: actual.moduleDigest,
      benchmark_ref: `${PROFILE_REF}/benchmark/SPX-2024`,
      calendar_snapshot_digest: actual.moduleDigest,
      calendar_snapshot_ref: `${PROFILE_REF}/calendar/XNAS-2024`,
      code_definition_digest: signalFormula.implementationDigest,
      compiler_digest: actual.compilerDigest,
      deterministic_seed: 74219,
      fee_assumption_digest: actual.moduleDigest,
      fee_assumption_ref: `${PROFILE_REF}/assumption/fee-v1`,
      fill_assumption_digest: actual.moduleDigest,
      fill_assumption_ref: `${PROFILE_REF}/assumption/fill-v1`,
      initial_capital: { amount: '1000000.00', currency: 'USD', scale: 2 },
      input_context_record_digest: actual.moduleDigest,
      input_context_ref: `${PROFILE_REF}/materialization/input-context-2025-01-09`,
      mapping_closure_digest: actual.definitionsDigest,
      ontology_closure_digest: actual.moduleDigest,
      parameter_snapshot_digest: actual.definitionsDigest,
      parameter_snapshot_ref: `${PROFILE_REF}/parameters/backtest-2024`,
      pit_request_record_digest: actual.moduleDigest,
      pit_request_ref: `${PROFILE_REF}/pit/request/backtest-2024`,
      run_context_id: 'backtest-2024',
      run_context_kind: `${BASE}RunContextKind/value/backtest`,
      run_started_at: '2025-01-10T00:00:03Z',
      simulation_from: '2024-01-01T00:00:00Z',
      simulation_to: '2025-01-01T00:00:00Z',
      slippage_assumption_digest: actual.moduleDigest,
      slippage_assumption_ref: `${PROFILE_REF}/assumption/slippage-v1`,
      source_artifact_digest: actual.sourceArtifactDigest,
      source_artifact_ref: actual.sourceArtifactRef,
      source_locator: actual.sourceLocator,
      ...strategyRef,
    })],
    calculation: [commonRow({
      annualization_factor: { rounding: 'half-even', unit: 'https://axiolune.ai/units/one', value: '252' },
      authority_iri: authority,
      benchmark_digest: 'sha256:1717171717171717171717171717171717171717171717171717171717171717',
      benchmark_ref: 'https://axiolune.ai/data/instrument/benchmark/SPX/version/1',
      calculation_context_id: 'daily-close',
      calculation_frequency: `${BASE}CalculationFrequency/value/daily`,
      calculation_implementation_digest: metricFormula.implementationDigest,
      calculation_parameter_snapshot_digest: actual.calculationParameterSnapshotDigest,
      calculation_parameter_snapshot_locator: actual.calculationParameterSnapshotLocator,
      calculation_parameter_snapshot_ref: actual.calculationParameterSnapshotRef,
      calculation_window: { rounding: 'half-even', unit: 'https://axiolune.ai/units/trading-day', value: '252' },
      confidence_level: { rounding: 'half-even', unit: 'https://axiolune.ai/units/one', value: '0.95' },
      risk_free_rate: { rounding: 'half-even', unit: 'https://axiolune.ai/units/one', value: '0.02' },
    })],
    factor: [commonRow({
      authority_iri: authority,
      ...executableFields(actual, signalFormula, 'momentum-20', 'Twenty-day momentum'),
      factor_expression_digest: signalFormula.inputContractDigest,
      factor_expression_ref: signalFormula.definitionIri,
    })],
    metric: [commonRow({
      authority_iri: authority,
      formula_digest: metricFormula.formulaDigest,
      implementation_digest: metricFormula.implementationDigest,
      input_contract_digest: metricFormula.inputContractDigest,
      metric_definition_id: 'total-return',
      metric_name: 'Total return',
      metric_value_kind: `${BASE}MetricValueKind/value/quantity`,
      output_contract_digest: metricFormula.outputContractDigest,
      runtime_digest: fileDigest(process.execPath),
      tool_lock_digest: actual.packageLockDigest,
      tool_lock_ref: `${PROFILE_REF}/tool-lock/package-lock`,
    })],
    performance: [
      commonRow({
        calculation_authority_iri: authority,
        calculation_id: 'daily-close',
        metric_authority_iri: authority,
        metric_id: 'total-return',
        quantity_value: { rounding: 'half-even', unit: UNIT_ONE, value: '0.05' },
        run_authority_iri: authority,
        run_id: 'backtest-2024',
        source_performance_id: 'total-return-2024',
        ...runRef,
        ...metricRef,
        ...calculationRef,
      }),
      commonRow({
        acquisition_time: '2025-01-10T00:10:02Z',
        available_from: '2025-01-10T00:10:01Z',
        calculation_authority_iri: authority,
        calculation_id: 'daily-close',
        knowledge_from: '2025-01-10T00:10:00Z',
        metric_authority_iri: authority,
        metric_id: 'total-return',
        quantity_value: { rounding: 'half-even', unit: UNIT_ONE, value: '0.052' },
        revision: 1,
        run_authority_iri: authority,
        run_id: 'backtest-2024',
        source_performance_id: 'total-return-2024',
        ...versionReference('run', authority, 'backtest-2024'),
        ...versionReference('metric', authority, 'total-return'),
        ...versionReference('calculation', authority, 'daily-close'),
      }),
    ],
    signal: [commonRow({
      direction: `${BASE}SignalDirection/value/long`,
      generator_authority_iri: authority,
      generator_id: 'momentum-strategy',
      horizon: 'P1D',
      instrument_version_iri: 'https://axiolune.ai/data/instrument/AAPL/version/2024-01-01',
      run_authority_iri: authority,
      run_id: 'backtest-2024',
      source_signal_id: 'AAPL-2024-06-03-close',
      strength: { rounding: 'half-even', unit: UNIT_ONE, value: '0.5' },
      ...versionReference('generator', authority, 'momentum-strategy'),
      ...runRef,
    })],
    strategy: [commonRow({
      authority_iri: authority,
      ...executableFields(actual, signalFormula, 'momentum-strategy', 'Momentum strategy'),
      ...factorRef,
    })],
  };
  return {
    closures: [{
      availabilityClosedAt: '2025-01-10T00:10:01Z',
      dataset: 'performance',
      knowledgeClosedAt: '2025-01-10T00:10:00Z',
      logicalKey: ['backtest-2024', 'total-return', 'daily-close', 'total-return-2024'],
      revision: 0,
      successorRevision: 1,
    }],
    datasets: rows,
    profileRef: PROFILE_REF,
    runtimeContext: {
      assertionTime: '2025-01-10T00:20:00Z',
      iri: `${PROFILE_REF}/materialization-run/strategy-research-v03-evidence-r1`,
      referenceTime: '2024-12-31T23:59:59Z',
      runId: 'strategy-research-v03-evidence-r1',
    },
    schemaVersion: '1.0',
    sourceSchemaDigest: jcsDigest(buildSourceSchema(mappingSet)),
  };
}

function buildFormulaDefinitions() {
  const workerDigest = fileDigest(PATHS.formulaWorker);
  const implementationRef = artifact(repositoryPath(PATHS.formulaWorker));
  const definitions = [
    {
      definitionIri: `${PROFILE_REF}/formula/momentum-signal-v1`,
      expression: 'delta=currentPriceMicros-previousPriceMicros;direction=sign(delta);returnPpm=truncateTowardZero(delta*1000000/previousPriceMicros);strengthPpm=min(truncateTowardZero(abs(delta)*10000000/previousPriceMicros),1000000)',
      formulaId: 'momentum-signal-v1',
      implementationDigest: workerDigest,
      implementationRef,
      inputContract: { currentPriceMicros: 'nonNegativeIntegerLexical', previousPriceMicros: 'positiveIntegerLexical' },
      kind: 'SignalGenerator',
      outputContract: { direction: ['long', 'short', 'neutral'], returnPpm: 'integerLexical(partsPerMillion,truncateTowardZero)', strengthPpm: 'nonNegativeIntegerLexical[0,1000000](exactRatioThenTruncateTowardZero)' },
    },
    {
      definitionIri: `${PROFILE_REF}/formula/total-return-v1`,
      expression: 'returnPpm=truncateTowardZero((endingEquityMicros-beginningEquityMicros)*1000000/beginningEquityMicros)',
      formulaId: 'total-return-v1',
      implementationDigest: workerDigest,
      implementationRef,
      inputContract: { beginningEquityMicros: 'positiveIntegerLexical', endingEquityMicros: 'nonNegativeIntegerLexical' },
      kind: 'MetricDefinition',
      outputContract: { returnPpm: 'integerLexical(partsPerMillion,truncateTowardZero)' },
    },
  ].map((row) => ({
    ...row,
    formulaDigest: jcsDigest({ expression: row.expression, formulaId: row.formulaId }),
    inputContractDigest: jcsDigest(row.inputContract),
    outputContractDigest: jcsDigest(row.outputContract),
  }));
  return { definitions, schemaVersion: '1.0' };
}

function buildFormulaVectors() {
  return {
    schemaVersion: '1.0',
    vectors: [
      { caseId: 'metric-positive-total-return', category: 'positive', expectedOutcome: 'conforms', expectedValue: { returnPpm: '50000' }, request: { formulaId: 'total-return-v1', input: { beginningEquityMicros: '100000000', endingEquityMicros: '105000000' }, schemaVersion: '1.0' } },
      { caseId: 'metric-positive-total-return-beyond-binary-safe-range', category: 'positive', expectedOutcome: 'conforms', expectedValue: { returnPpm: '50000' }, request: { formulaId: 'total-return-v1', input: { beginningEquityMicros: '10000000000000000000000000000000000000000', endingEquityMicros: '10500000000000000000000000000000000000000' }, schemaVersion: '1.0' } },
      { caseId: 'metric-negative-total-return-rounds-toward-zero', category: 'positive', expectedOutcome: 'conforms', expectedValue: { returnPpm: '-333333' }, request: { formulaId: 'total-return-v1', input: { beginningEquityMicros: '3', endingEquityMicros: '2' }, schemaVersion: '1.0' } },
      { caseId: 'signal-positive-momentum', category: 'positive', expectedOutcome: 'conforms', expectedValue: { direction: 'long', returnPpm: '50000', strengthPpm: '500000' }, request: { formulaId: 'momentum-signal-v1', input: { currentPriceMicros: '105000000', previousPriceMicros: '100000000' }, schemaVersion: '1.0' } },
      { caseId: 'signal-negative-momentum-rounds-toward-zero', category: 'positive', expectedOutcome: 'conforms', expectedValue: { direction: 'short', returnPpm: '-333333', strengthPpm: '1000000' }, request: { formulaId: 'momentum-signal-v1', input: { currentPriceMicros: '2', previousPriceMicros: '3' }, schemaVersion: '1.0' } },
      { caseId: 'signal-sub-ppm-return-retains-direction-and-exact-strength', category: 'positive', expectedOutcome: 'conforms', expectedValue: { direction: 'long', returnPpm: '0', strengthPpm: '5' }, request: { formulaId: 'momentum-signal-v1', input: { currentPriceMicros: '2000001', previousPriceMicros: '2000000' }, schemaVersion: '1.0' } },
      { caseId: 'metric-zero-denominator', category: 'negative', expectedCode: 'FORMULA_DIVISION_BY_ZERO', expectedOutcome: 'violation', request: { formulaId: 'total-return-v1', input: { beginningEquityMicros: '0', endingEquityMicros: '1' }, schemaVersion: '1.0' } },
      { caseId: 'signal-zero-denominator', category: 'negative', expectedCode: 'FORMULA_DIVISION_BY_ZERO', expectedOutcome: 'violation', request: { formulaId: 'momentum-signal-v1', input: { currentPriceMicros: '1', previousPriceMicros: '0' }, schemaVersion: '1.0' } },
      { caseId: 'metric-reject-json-number-input', category: 'negative', expectedCode: 'FORMULA_WORKER_FAILURE', expectedOutcome: 'engineFailure', request: { formulaId: 'total-return-v1', input: { beginningEquityMicros: 100000000, endingEquityMicros: '105000000' }, schemaVersion: '1.0' } },
      { caseId: 'runtime-closure-tamper', category: 'tamper', expectedCode: 'FORMULA_CLOSURE_TAMPER', expectedOutcome: 'engineFailure' },
      { caseId: 'runtime-timeout', category: 'timeout', expectedCode: 'FORMULA_TIMEOUT', expectedOutcome: 'engineFailure' },
    ],
  };
}

function buildFormulaClosure(definitions, vectors) {
  const artifacts = [
    ['definitions', PATHS.formulaDefinitions],
    ['vectors', PATHS.formulaVectors],
    ['worker', PATHS.formulaWorker],
  ].map(([role, file]) => ({ digest: fileDigest(file), ref: artifact(repositoryPath(file)), role }))
    .sort((left, right) => compareUtf8(left.ref.path, right.ref.path));
  return {
    artifacts,
    closureDigest: artifactDigest(Buffer.concat([
      Buffer.from('axiolune-strategy-research-formula-closure-v1\0', 'utf8'),
      Buffer.from(canonicalJcs(artifacts), 'utf8'),
    ])),
    definitionsDigest: jcsDigest(definitions),
    schemaVersion: '1.0',
    vectorsDigest: jcsDigest(vectors),
  };
}

function buildPitRequests() {
  return {
    requests: [
      { asOfAvailable: '2025-01-10T00:05:00Z', asOfKnowledge: '2025-01-10T00:05:00Z', asOfValid: '2024-06-30T00:00:00Z', caseId: 'early-revision-zero', expectedRevisions: [0] },
      { asOfAvailable: '2025-01-10T00:15:00Z', asOfKnowledge: '2025-01-10T00:15:00Z', asOfValid: '2024-06-30T00:00:00Z', caseId: 'late-revision-one', expectedRevisions: [1] },
      { asOfAvailable: '2025-01-09T23:59:59Z', asOfKnowledge: '2025-01-10T00:05:00Z', asOfValid: '2024-06-30T00:00:00Z', caseId: 'before-availability-empty', expectedRevisions: [] },
    ],
    schemaVersion: '1.0',
    targetType: `${BASE}PerformanceObservation`,
  };
}

module.exports = {
  BASE,
  CQ_ROOT,
  INFRA_ROOT,
  MAPPING_ROOT,
  MATERIALIZED_TARGETS,
  PATHS,
  PROFILE_REF,
  PROFILE_ROOT,
  RELEASE_TARGETS,
  ROOT,
  artifact,
  buildFormulaClosure,
  buildFormulaDefinitions,
  buildFormulaVectors,
  buildMappingSet,
  buildNormalizationContract,
  buildNormalizationVectors,
  buildPitRequests,
  buildSourceSchema,
  buildSourceSnapshot,
  compareUtf8,
  fileDigest,
  jcsBytes,
  jcsDigest,
  repositoryPath,
};
