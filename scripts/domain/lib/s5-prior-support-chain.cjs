'use strict';

const { Parser } = require('n3');
const { canonicalJcs } = require('./strict-source-locator.cjs');
const { computeNamedGraphDigest } = require('./rdfc-1.0.cjs');
const {
  FACT_VERSION,
  GENERATING_CONTEXT,
  KNOWLEDGE_FROM,
  AVAILABLE_FROM,
  SUPPORT_GRAPH_IRI,
} = require('./s5-canonical-materialization.cjs');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PROFILE_REF = 'https://axiolune.ai/conformance/m2/0.3.0';
const EXPECTED_TARGETS = Object.freeze([
  'https://axiolune.ai/ontology/finance/instruments/DirectUnitPriceQuotationContract',
  'https://axiolune.ai/ontology/finance/instruments/FinancialInstrument',
  'https://axiolune.ai/ontology/finance/instruments/InstrumentListing',
  'https://axiolune.ai/ontology/finance/market-structure/TradingFacility',
  'https://axiolune.ai/ontology/finance/portfolio-positions/PortfolioAccountMembership',
  'https://axiolune.ai/ontology/finance/portfolio-positions/PortfolioAccountMembershipClosure',
  'https://axiolune.ai/ontology/finance/portfolio-positions/PortfolioObservationStream',
  'https://axiolune.ai/ontology/finance/portfolio-positions/ValuationCalculationDefinition',
]);
const F = 'https://axiolune.ai/ontology/finance/foundation/';
const I = 'https://axiolune.ai/ontology/finance/instruments/';
const P = 'https://axiolune.ai/ontology/finance/portfolio-positions/';
const SUPPORT_MAPPING_NS = 'https://axiolune.ai/conformance/m2/0.3.0/slice-a-s5/prior-support/';
const EXPECTED_DEPENDENCY_EDGES = Object.freeze([
  Object.freeze({
    afterPlan: `${SUPPORT_MAPPING_NS}plan/portfolio`,
    beforePlan: `${SUPPORT_MAPPING_NS}plan/instruments`,
  }),
  Object.freeze({
    afterPlan: `${SUPPORT_MAPPING_NS}plan/instruments`,
    beforePlan: `${SUPPORT_MAPPING_NS}plan/market-structure`,
  }),
]);
const EXPECTED_MAPPING_PROFILES = Object.freeze({
  [`${I}DirectUnitPriceQuotationContract`]: Object.freeze({
    slots: Object.freeze([
      Object.freeze(['attribute', `${I}quotationDenominatorUnit`, 'quotation_denominator_unit']),
      Object.freeze(['relation', `${I}quotationInstrument`, 'instrument_logical_iri', `${I}FinancialInstrument`]),
      Object.freeze(['relation', `${I}quotationListingContext`, 'listing_version_iri', `${I}InstrumentListing`]),
      Object.freeze(['relation', `${I}quotationQuoteCurrency`, 'quotation_currency_iri', `${F}Currency`]),
    ]),
    versionField: 'quotation_contract_version_iri',
  }),
  [`${I}FinancialInstrument`]: Object.freeze({
    logicalField: 'instrument_logical_iri',
    slots: Object.freeze([]),
    versionField: 'instrument_version_iri',
  }),
  [`${I}InstrumentListing`]: Object.freeze({
    slots: Object.freeze([
      Object.freeze(['attribute', `${I}listingBusinessFrom`, 'listing_business_from']),
      Object.freeze([
        'relation', `${I}listingFacility`, 'listing_facility_version_iri',
        'https://axiolune.ai/ontology/finance/market-structure/TradingFacility',
      ]),
      Object.freeze(['relation', `${I}listedInstrument`, 'instrument_version_iri', `${I}FinancialInstrument`]),
      Object.freeze(['relation', `${I}listingQuoteCurrency`, 'quotation_currency_iri', `${F}Currency`]),
    ]),
    versionField: 'listing_version_iri',
  }),
  'https://axiolune.ai/ontology/finance/market-structure/TradingFacility': Object.freeze({
    slots: Object.freeze([]),
    versionField: 'listing_facility_version_iri',
  }),
  [`${P}PortfolioAccountMembership`]: Object.freeze({
    slots: Object.freeze([
      Object.freeze([
        'participantRole', `${P}PortfolioAccountMembership/role/membershipPortfolio`,
        'portfolio_logical_iri',
      ]),
      Object.freeze([
        'participantRole', `${P}PortfolioAccountMembership/role/memberAccount`,
        'account_logical_iri',
      ]),
    ]),
    versionValue: 'https://axiolune.ai/data/finance/portfolio-positions/membership/acme-account/version/locked',
  }),
  [`${P}PortfolioAccountMembershipClosure`]: Object.freeze({
    slots: Object.freeze([
      Object.freeze([
        'participantRole', `${P}PortfolioAccountMembershipClosure/role/closurePortfolio`,
        'portfolio_logical_iri',
      ]),
    ]),
    versionField: 'membership_closure_version_iri',
  }),
  [`${P}PortfolioObservationStream`]: Object.freeze({
    logicalField: 'portfolio_observation_stream_logical_iri',
    slots: Object.freeze([
      Object.freeze([
        'relation',
        `${P}portfolioObservationStreamProvider`,
        'provider_iri',
        `${F}Party`,
      ]),
      Object.freeze([
        'attribute',
        `${P}portfolioObservationStreamId`,
        'portfolio_observation_stream_id',
      ]),
      Object.freeze([
        'attribute',
        `${P}portfolioObservationSourceContractRef`,
        'portfolio_observation_source_contract_ref',
      ]),
      Object.freeze([
        'attribute',
        `${P}portfolioObservationSourceContractDigest`,
        'portfolio_observation_source_contract_digest',
      ]),
      Object.freeze([
        'attribute',
        `${P}portfolioObservationCompletenessContractRef`,
        'portfolio_observation_completeness_contract_ref',
      ]),
      Object.freeze([
        'attribute',
        `${P}portfolioObservationCompletenessContractDigest`,
        'portfolio_observation_completeness_contract_digest',
      ]),
      Object.freeze([
        'attribute',
        `${P}portfolioObservationPaginationContractRef`,
        'portfolio_observation_pagination_contract_ref',
      ]),
      Object.freeze([
        'attribute',
        `${P}portfolioObservationPaginationContractDigest`,
        'portfolio_observation_pagination_contract_digest',
      ]),
      Object.freeze([
        'attribute',
        'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactRef',
        'portfolio_observation_source_artifact_ref',
      ]),
      Object.freeze([
        'attribute',
        'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceArtifactDigest',
        'portfolio_observation_source_artifact_digest',
      ]),
      Object.freeze([
        'attribute',
        'https://axiolune.ai/ontology/meta/data-binding/attributes/sourceLocator',
        'portfolio_observation_source_locator_iri',
      ]),
    ]),
    sourceField: 'portfolio_observation_source_artifact_ref',
    versionField: 'portfolio_observation_stream_version_iri',
  }),
  [`${P}ValuationCalculationDefinition`]: Object.freeze({
    slots: Object.freeze([
      Object.freeze([
        'relation', `${P}valuationDefinitionQuotationContract`,
        'quotation_contract_version_iri', `${I}DirectUnitPriceQuotationContract`,
      ]),
      Object.freeze(['attribute', `${P}formulaDigest`, 'valuation_formula_digest']),
    ]),
    versionField: 'valuation_definition_version_iri',
  }),
});

class S5PriorSupportChainError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'S5PriorSupportChainError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new S5PriorSupportChainError(code, message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalJcs(Object.keys(value).sort()) !== canonicalJcs([...expected].sort())) {
    fail('S5_PRIOR_SUPPORT_SCHEMA', `${label} is not the expected closed object`);
  }
}

function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function refKey(value) {
  return canonicalJcs(value);
}

function refsEqual(left, right) {
  return refKey(left) === refKey(right);
}

function requireDigest(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value || '')) {
    fail('S5_PRIOR_SUPPORT_DIGEST', `${label} is not a lowercase SHA-256 digest`);
  }
}

function directField(field) {
  return { bindingType: 'directField', source: { dataset: 'row', field } };
}

function expectedSlotMapping(targetType, slot) {
  const [slotType, targetRef, field, targetObjectType] = slot;
  let target;
  if (slotType === 'participantRole') {
    target = {
      slotType,
      targetAssociation: targetType,
      targetRole: targetRef.split('/').at(-1),
    };
  } else if (slotType === 'relation') {
    target = { slotType, targetObjectType, targetRelation: targetRef };
  } else {
    target = { slotType, targetAttribute: targetRef };
  }
  return { target, value: directField(field) };
}

function readBinding(resolver, binding, label, keyName) {
  exactKeys(binding, ['artifactDigest', 'artifactRef', keyName], label);
  requireDigest(binding.artifactDigest, `${label}.artifactDigest`);
  const artifact = resolver.read(binding.artifactRef, `${label}.artifactRef`, ['sourceTree']);
  if (artifact.digest !== binding.artifactDigest) {
    fail('S5_PRIOR_SUPPORT_DIGEST', `${label} artifact bytes differ from the declared digest`);
  }
  return artifact;
}

function readJsonBinding(resolver, binding, label, keyName) {
  readBinding(resolver, binding, label, keyName);
  const artifact = resolver.readJson(binding.artifactRef, `${label}.artifactRef`, {
    allowedRoots: ['sourceTree'],
    exactJcs: true,
  });
  if (artifact.digest !== binding.artifactDigest) {
    fail('S5_PRIOR_SUPPORT_DIGEST', `${label} JCS artifact digest differs`);
  }
  return artifact;
}

function sortedUniqueBindings(values, keyName, label) {
  if (!Array.isArray(values) || values.length === 0) {
    fail('S5_PRIOR_SUPPORT_INVENTORY', `${label} must be non-empty`);
  }
  const keys = values.map((entry) => entry?.[keyName]);
  if (keys.some((value) => typeof value !== 'string')
      || new Set(keys).size !== keys.length
      || keys.some((value, index) => value !== [...keys].sort(utf8Compare)[index])) {
    fail('S5_PRIOR_SUPPORT_INVENTORY', `${label} must be sorted and unique by ${keyName}`);
  }
}

function validateMapping(mapping, binding, contract, sourceDataset, label) {
  exactKeys(mapping, [
    'identity', 'iri', 'label', 'mappingType', 'provenance', 'slotMappings',
    'source', 'targetType', 'temporal',
  ], label);
  if (mapping.iri !== binding.mappingRef || mapping.targetType !== binding.targetType
      || mapping.mappingType !== 'directTable' || typeof mapping.label !== 'string'
      || mapping.label.length === 0) {
    fail('S5_PRIOR_SUPPORT_MAPPING', `${label} identity or type drift`);
  }
  if (Object.hasOwn(mapping, 'sourceDataset') || Object.hasOwn(mapping, 'fieldMappings')) {
    fail('S5_PRIOR_SUPPORT_MAPPING', `${label} uses a prohibited second mapping dialect`);
  }
  if (canonicalJcs(mapping.source) !== canonicalJcs({
    datasets: [{ alias: 'row', dataset: sourceDataset }],
  })) {
    fail('S5_PRIOR_SUPPORT_MAPPING', `${label} source binding differs from the locked schema`);
  }
  exactKeys(mapping.identity, [
    'contractRef', 'logicalKeyBindings', 'versionKeyBindings',
  ], `${label}.identity`);
  if (mapping.identity.contractRef !== contract.iri
      || Object.keys(mapping.identity.logicalKeyBindings).join('') !== 'authoritativeLogicalIri'
      || Object.keys(mapping.identity.versionKeyBindings).join('') !== 'authoritativeVersionIri') {
    fail('S5_PRIOR_SUPPORT_MAPPING', `${label} does not completely bind its exact identity contract`);
  }
  const profile = EXPECTED_MAPPING_PROFILES[mapping.targetType];
  if (!profile) fail('S5_PRIOR_SUPPORT_MAPPING', `${label} has no locked semantic profile`);
  const authoritativeVersionIri = profile.versionValue
    ? { bindingType: 'literal', value: profile.versionValue }
    : directField(profile.versionField);
  const authoritativeLogicalIri = profile.logicalField
    ? directField(profile.logicalField)
    : {
      bindingType: 'transformation',
      inputs: { versionIri: authoritativeVersionIri },
      transformationRef: `${SUPPORT_MAPPING_NS}transformation/version-to-logical-iri`,
    };
  if (canonicalJcs(mapping.identity.logicalKeyBindings) !== canonicalJcs({
    authoritativeLogicalIri,
  }) || canonicalJcs(mapping.identity.versionKeyBindings) !== canonicalJcs({
    authoritativeVersionIri,
  })) {
    fail('S5_PRIOR_SUPPORT_MAPPING', `${label} exact-IRI identity bindings drift`);
  }
  const expectedSlots = profile.slots.map((slot) => expectedSlotMapping(mapping.targetType, slot));
  if (canonicalJcs(mapping.slotMappings) !== canonicalJcs(expectedSlots)) {
    fail('S5_PRIOR_SUPPORT_MAPPING', `${label} canonical target-slot semantics drift`);
  }
  if (canonicalJcs(mapping.provenance) !== canonicalJcs({
    sourceSystem: directField(profile.sourceField || 'source'),
  })) {
    fail('S5_PRIOR_SUPPORT_MAPPING', `${label} provenance binding drift`);
  }
  exactKeys(mapping.temporal, [
    'availabilityTime', 'knowledgeTime', 'patternRef', 'validTime',
  ], `${label}.temporal`);
  if (canonicalJcs(mapping.temporal) !== canonicalJcs({
    availabilityTime: { closePolicy: 'explicitOnly', from: directField('available_from') },
    knowledgeTime: { closePolicy: 'explicitOnly', from: directField('knowledge_from') },
    patternRef: 'https://axiolune.ai/ontology/meta/patterns/TemporalFact',
    validTime: { closePolicy: 'explicitOnly', from: directField('valid_from') },
  })) {
    fail('S5_PRIOR_SUPPORT_MAPPING', `${label} does not bind the three-axis temporal pattern`);
  }
}

function validateIdentityContract(contract, binding, label) {
  exactKeys(contract, [
    'definition', 'iri', 'label', 'logicalComponents', 'strategy', 'targetType',
    'versionComponents',
  ], label);
  if (contract.iri !== binding.contractRef
      || contract.strategy !== 'authoritativeExactIri'
      || canonicalJcs(contract.logicalComponents) !== canonicalJcs([{ name: 'authoritativeLogicalIri' }])
      || canonicalJcs(contract.versionComponents) !== canonicalJcs([{ name: 'authoritativeVersionIri' }])) {
    fail('S5_PRIOR_SUPPORT_IDENTITY', `${label} identity strategy/components drift`);
  }
}

function validatePlan(plan, binding, mappings, sourceDataset, label) {
  exactKeys(plan, [
    'definition', 'iri', 'label', 'materializationMode', 'owner', 'semanticMappings',
    'sourceDatasets', 'targetGraphUri', 'targetOntologyModule',
  ], label);
  if (plan.iri !== binding.planRef || plan.materializationMode !== 'Full'
      || plan.owner !== 'repository-owner' || plan.targetGraphUri !== SUPPORT_GRAPH_IRI
      || canonicalJcs(plan.sourceDatasets) !== canonicalJcs([sourceDataset])) {
    fail('S5_PRIOR_SUPPORT_PLAN', `${label} source/target/control fields drift`);
  }
  const expected = mappings.filter((mapping) => mapping.moduleIri === plan.targetOntologyModule)
    .map((mapping) => mapping.binding.mappingRef).sort(utf8Compare);
  if (canonicalJcs(plan.semanticMappings) !== canonicalJcs(expected)) {
    fail('S5_PRIOR_SUPPORT_PLAN', `${label} mapping closure is incomplete or cross-module`);
  }
}

function validateBatch(batch, binding, plans, manifestEdges) {
  exactKeys(batch, [
    'consistencyRequirement', 'definition', 'dependencyEdges', 'iri', 'label', 'plans',
    'targetDataset',
  ], 'priorSupport.batch');
  if (batch.iri !== binding.batchRef || batch.consistencyRequirement !== 'Transactional'
      || canonicalJcs(batch.plans) !== canonicalJcs(plans.map((entry) => entry.binding.planRef).sort(utf8Compare))
      || canonicalJcs(batch.dependencyEdges) !== canonicalJcs(manifestEdges)
      || canonicalJcs(batch.dependencyEdges) !== canonicalJcs(EXPECTED_DEPENDENCY_EDGES)) {
    fail('S5_PRIOR_SUPPORT_BATCH', 'prior support batch identity/inventory/edge closure drift');
  }
  const planSet = new Set(batch.plans);
  const keys = [];
  const adjacency = new Map(batch.plans.map((plan) => [plan, []]));
  for (const [index, edge] of batch.dependencyEdges.entries()) {
    exactKeys(edge, ['afterPlan', 'beforePlan'], `priorSupport.dependencyEdges[${index}]`);
    if (edge.beforePlan === edge.afterPlan || !planSet.has(edge.beforePlan)
        || !planSet.has(edge.afterPlan)) {
      fail('S5_PRIOR_SUPPORT_DAG', 'dependency edge endpoint is not a distinct batch plan');
    }
    keys.push(`${edge.beforePlan}\0${edge.afterPlan}`);
    adjacency.get(edge.beforePlan).push(edge.afterPlan);
  }
  if (new Set(keys).size !== keys.length
      || keys.some((key, index) => key !== [...keys].sort(utf8Compare)[index])) {
    fail('S5_PRIOR_SUPPORT_DAG', 'dependencyEdges must be sorted and unique');
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(node) {
    if (visiting.has(node)) fail('S5_PRIOR_SUPPORT_DAG', 'dependency graph is cyclic');
    if (visited.has(node)) return;
    visiting.add(node);
    adjacency.get(node).forEach(visit);
    visiting.delete(node);
    visited.add(node);
  }
  batch.plans.forEach(visit);
}

function validatePriorSupportChain(manifestRef, resolver, current) {
  const manifestArtifact = resolver.readJson(manifestRef, 'priorSupportChainRef', {
    allowedRoots: ['sourceTree'], exactJcs: true,
  });
  const manifest = manifestArtifact.value;
  exactKeys(manifest, [
    'batch', 'batchRun', 'chainId', 'dataset', 'dependencyEdges', 'identityContracts',
    'ledger', 'mappings', 'plans', 'profileRef', 'reports', 'runs', 'schemaVersion',
    'sourceSchema', 'sourceSnapshot',
  ], 'priorSupportChain');
  if (manifest.schemaVersion !== '1.0' || manifest.profileRef !== PROFILE_REF
      || manifest.chainId !== 'slice-a-prior-support-v1') {
    fail('S5_PRIOR_SUPPORT_IDENTITY', 'prior support manifest identity/profile drift');
  }
  exactKeys(manifest.dataset, [
    'artifactDigest', 'artifactRef', 'datasetRef', 'graphDigest', 'graphIri', 'snapshotTime',
  ], 'priorSupportChain.dataset');
  requireDigest(manifest.dataset.artifactDigest, 'priorSupportChain.dataset.artifactDigest');
  requireDigest(manifest.dataset.graphDigest, 'priorSupportChain.dataset.graphDigest');
  if (manifest.dataset.graphIri !== SUPPORT_GRAPH_IRI
      || Date.parse(manifest.dataset.snapshotTime) >= Date.parse(current.assertionTime)) {
    fail('S5_PRIOR_SUPPORT_TIME', 'support snapshot must be the exact graph and strictly prior');
  }
  const datasetArtifact = resolver.read(
    manifest.dataset.artifactRef,
    'priorSupportChain.dataset.artifactRef',
    ['sourceTree'],
  );
  if (datasetArtifact.digest !== manifest.dataset.artifactDigest) {
    fail('S5_PRIOR_SUPPORT_DIGEST', 'support dataset bytes differ from the manifest');
  }
  const nquads = datasetArtifact.bytes.toString('utf8');
  let quads;
  try {
    quads = new Parser({ format: 'N-Quads' }).parse(nquads);
  } catch (cause) {
    fail('S5_PRIOR_SUPPORT_RDF', cause.message);
  }
  if (quads.length === 0 || quads.some((statement) => (
    statement.graph.termType !== 'NamedNode' || statement.graph.value !== SUPPORT_GRAPH_IRI
  ))) {
    fail('S5_PRIOR_SUPPORT_RDF', 'support dataset must be non-empty and graph-closed');
  }
  const graphDigest = computeNamedGraphDigest(nquads, SUPPORT_GRAPH_IRI).digest;
  if (graphDigest !== manifest.dataset.graphDigest) {
    fail('S5_PRIOR_SUPPORT_DIGEST', 'support named-graph RDFC digest differs');
  }

  for (const [field, expectedRef, expectedDigest] of [
    ['sourceSchema', current.sourceSchemaRef, current.sourceSchemaDigest],
    ['sourceSnapshot', current.sourceSnapshotRef, current.sourceSnapshotDigest],
  ]) {
    const keyName = field === 'sourceSchema' ? 'datasetRef' : 'snapshotRef';
    const binding = manifest[field];
    readBinding(resolver, binding, `priorSupportChain.${field}`, keyName);
    if (!refsEqual(binding.artifactRef, expectedRef) || binding.artifactDigest !== expectedDigest) {
      fail('S5_PRIOR_SUPPORT_SOURCE', `${field} is not the current batch's locked source input`);
    }
    if (field === 'sourceSnapshot') {
      const snapshotArtifact = resolver.read(
        binding.snapshotRef,
        'priorSupportChain.sourceSnapshot.snapshotRef',
        ['sourceTree'],
      );
      if (!refsEqual(binding.snapshotRef, binding.artifactRef)
          || snapshotArtifact.digest !== binding.artifactDigest) {
        fail('S5_PRIOR_SUPPORT_SOURCE', 'sourceSnapshot snapshotRef is not the exact locked ArtifactRef');
      }
    }
  }

  sortedUniqueBindings(manifest.identityContracts, 'contractRef', 'priorSupportChain.identityContracts');
  sortedUniqueBindings(manifest.mappings, 'mappingRef', 'priorSupportChain.mappings');
  sortedUniqueBindings(manifest.plans, 'planRef', 'priorSupportChain.plans');
  sortedUniqueBindings(manifest.runs, 'planRef', 'priorSupportChain.runs');
  sortedUniqueBindings(manifest.reports, 'runRef', 'priorSupportChain.reports');
  if (manifest.identityContracts.length !== EXPECTED_TARGETS.length
      || manifest.mappings.length !== EXPECTED_TARGETS.length || manifest.plans.length !== 3
      || manifest.runs.length !== 3 || manifest.reports.length !== 3) {
    fail('S5_PRIOR_SUPPORT_INVENTORY', 'mapping/plan/run/report inventory is incomplete');
  }
  const contracts = new Map();
  for (const [index, binding] of manifest.identityContracts.entries()) {
    const artifact = readJsonBinding(
      resolver, binding, `priorSupportChain.identityContracts[${index}]`, 'contractRef',
    );
    validateIdentityContract(artifact.value, binding, `identityContract[${index}]`);
    contracts.set(binding.contractRef, artifact.value);
  }
  const mappings = [];
  for (const [index, binding] of manifest.mappings.entries()) {
    exactKeys(binding, [
      'artifactDigest', 'artifactRef', 'mappingRef', 'targetType',
    ], `priorSupportChain.mappings[${index}]`);
    const artifact = resolver.readJson(binding.artifactRef, `priorSupportChain.mappings[${index}]`, {
      allowedRoots: ['sourceTree'], exactJcs: true,
    });
    if (artifact.digest !== binding.artifactDigest) {
      fail('S5_PRIOR_SUPPORT_DIGEST', `mapping[${index}] bytes differ`);
    }
    const contract = [...contracts.values()].find((entry) => entry.targetType === binding.targetType);
    if (!contract) fail('S5_PRIOR_SUPPORT_IDENTITY', `mapping[${index}] has no identity contract`);
    validateMapping(artifact.value, binding, contract, manifest.sourceSchema.datasetRef, `mapping[${index}]`);
    mappings.push({
      artifact, binding, moduleIri: contract.targetType.split('/').slice(0, -1).join('/'),
      mapping: artifact.value,
    });
  }
  const actualTargets = mappings.map((entry) => entry.binding.targetType).sort(utf8Compare);
  if (canonicalJcs(actualTargets) !== canonicalJcs([...EXPECTED_TARGETS].sort(utf8Compare))) {
    fail('S5_PRIOR_SUPPORT_MAPPING', 'support mapping target closure differs from actual support FactVersions');
  }
  const plans = manifest.plans.map((binding, index) => {
    const artifact = readJsonBinding(resolver, binding, `priorSupportChain.plans[${index}]`, 'planRef');
    validatePlan(artifact.value, binding, mappings, manifest.sourceSchema.datasetRef, `plan[${index}]`);
    return { artifact, binding, plan: artifact.value };
  });
  const batchArtifact = readJsonBinding(resolver, manifest.batch, 'priorSupportChain.batch', 'batchRef');
  validateBatch(batchArtifact.value, manifest.batch, plans, manifest.dependencyEdges);

  const runByIri = new Map();
  const runByPlan = new Map();
  for (const [index, binding] of manifest.runs.entries()) {
    exactKeys(binding, ['artifactDigest', 'artifactRef', 'planRef', 'runRef'], `runBinding[${index}]`);
    const artifact = resolver.readJson(binding.artifactRef, `runBinding[${index}]`, {
      allowedRoots: ['sourceTree'], exactJcs: true,
    });
    if (artifact.digest !== binding.artifactDigest) fail('S5_PRIOR_SUPPORT_DIGEST', `run[${index}] bytes differ`);
    const run = artifact.value;
    exactKeys(run, [
      'assertionTime', 'inputSnapshotDigest', 'inputSnapshotRef', 'iri', 'mappingClosure',
      'outcome', 'outputDatasetArtifactDigest', 'outputDatasetArtifactRef', 'outputGraphDigest',
      'outputGraphIri', 'planRef', 'planSourceDigest', 'planSourceRef', 'recordType',
      'referenceTime', 'schemaVersion', 'validationReportRef',
    ], `run[${index}]`);
    const plan = plans.find((entry) => entry.binding.planRef === binding.planRef);
    if (!plan || run.iri !== binding.runRef || run.planRef !== binding.planRef
        || run.planSourceDigest !== plan.binding.artifactDigest
        || !refsEqual(run.planSourceRef, plan.binding.artifactRef)
        || run.inputSnapshotDigest !== manifest.sourceSnapshot.artifactDigest
        || !refsEqual(run.inputSnapshotRef, manifest.sourceSnapshot.artifactRef)
        || run.outputDatasetArtifactDigest !== manifest.dataset.artifactDigest
        || !refsEqual(run.outputDatasetArtifactRef, manifest.dataset.artifactRef)
        || run.outputGraphDigest !== manifest.dataset.graphDigest
        || run.outputGraphIri !== SUPPORT_GRAPH_IRI || run.outcome !== 'completed'
        || run.recordType !== 'materializationRun' || run.schemaVersion !== '1.0'
        || Date.parse(run.assertionTime) >= Date.parse(current.assertionTime)
        || Date.parse(run.referenceTime) >= Date.parse(current.referenceTime)) {
      fail('S5_PRIOR_SUPPORT_RUN', `run[${index}] does not bind the prior plan/source/output/time closure`);
    }
    const expectedMappings = plan.plan.semanticMappings.map((mappingRef) => {
      const mapping = mappings.find((entry) => entry.binding.mappingRef === mappingRef);
      return mapping.binding;
    });
    if (canonicalJcs(run.mappingClosure) !== canonicalJcs(expectedMappings)) {
      fail('S5_PRIOR_SUPPORT_RUN', `run[${index}] mapping closure is incomplete`);
    }
    runByIri.set(run.iri, { artifact, binding, run });
    runByPlan.set(run.planRef, run);
  }
  const factTypesBySubject = new Map();
  const factVersionSubjects = new Set();
  const contextBySubject = new Map();
  const temporalBySubject = new Map();
  for (const statement of quads) {
    if (statement.predicate.value === RDF_TYPE) {
      if (statement.object.value === FACT_VERSION) {
        factVersionSubjects.add(statement.subject.value);
      } else {
        if (!factTypesBySubject.has(statement.subject.value)) factTypesBySubject.set(statement.subject.value, []);
        factTypesBySubject.get(statement.subject.value).push(statement.object.value);
      }
    }
    if (statement.predicate.value === GENERATING_CONTEXT) {
      if (contextBySubject.has(statement.subject.value)) {
        fail('S5_PRIOR_SUPPORT_RUN', `${statement.subject.value} has multiple generating contexts`);
      }
      contextBySubject.set(statement.subject.value, statement.object.value);
    }
    if ([KNOWLEDGE_FROM, AVAILABLE_FROM].includes(statement.predicate.value)) {
      if (!temporalBySubject.has(statement.subject.value)) {
        temporalBySubject.set(statement.subject.value, new Map());
      }
      const values = temporalBySubject.get(statement.subject.value);
      if (values.has(statement.predicate.value)) {
        fail('S5_PRIOR_SUPPORT_TIME', `${statement.subject.value} duplicates a temporal start`);
      }
      values.set(statement.predicate.value, statement.object.value);
    }
  }
  if (factVersionSubjects.size !== EXPECTED_TARGETS.length
      || contextBySubject.size !== factVersionSubjects.size
      || [...contextBySubject.keys()].some((subject) => !factVersionSubjects.has(subject))) {
    fail('S5_PRIOR_SUPPORT_RUN', 'support FactVersion/generating-context subject closure is not exact');
  }
  const targetSubjects = new Map(EXPECTED_TARGETS.map((target) => [target, []]));
  for (const subject of factVersionSubjects) {
    const targets = (factTypesBySubject.get(subject) || [])
      .filter((type) => EXPECTED_TARGETS.includes(type));
    if (targets.length !== 1) {
      fail('S5_PRIOR_SUPPORT_MAPPING', `${subject} must have exactly one mapped support target type`);
    }
    const [target] = targets;
    targetSubjects.get(target).push(subject);
    const mapping = mappings.find((entry) => entry.binding.targetType === target);
    const plan = plans.find((entry) => entry.plan.semanticMappings.includes(mapping.binding.mappingRef));
    const run = runByPlan.get(plan.binding.planRef);
    if (contextBySubject.get(subject) !== run.iri) {
      fail('S5_PRIOR_SUPPORT_RUN', `${subject} cites a forged or wrong priorRun`);
    }
    const starts = temporalBySubject.get(subject);
    if (!starts || [...starts.values()].some((instant) => (
      Date.parse(instant) > Date.parse(run.referenceTime)
    ))) {
      fail('S5_PRIOR_SUPPORT_TIME', `${subject} temporal start exceeds its prior run referenceTime`);
    }
  }
  for (const [target, subjects] of targetSubjects) {
    if (subjects.length !== 1) {
      fail('S5_PRIOR_SUPPORT_MAPPING', `${target} must have exactly one produced support FactVersion`);
    }
  }

  for (const [index, binding] of manifest.reports.entries()) {
    exactKeys(binding, ['artifactDigest', 'artifactRef', 'reportRef', 'runRef'], `reportBinding[${index}]`);
    const artifact = resolver.readJson(binding.artifactRef, `reportBinding[${index}]`, {
      allowedRoots: ['sourceTree'], exactJcs: true,
    });
    if (artifact.digest !== binding.artifactDigest) fail('S5_PRIOR_SUPPORT_DIGEST', `report[${index}] bytes differ`);
    const report = artifact.value;
    exactKeys(report, [
      'checks', 'evidenceScope', 'iri', 'outcome', 'recordType', 'runArtifactDigest',
      'runArtifactRef', 'runRef', 'schemaVersion', 'subjectArtifactDigest',
      'subjectArtifactRef', 'subjectGraphDigest', 'subjectGraphIri',
    ], `report[${index}]`);
    const run = runByIri.get(binding.runRef);
    if (!run || report.iri !== binding.reportRef || report.runRef !== binding.runRef
        || report.runArtifactDigest !== run.artifact.digest
        || !refsEqual(report.runArtifactRef, run.binding.artifactRef)
        || run.run.validationReportRef !== report.iri
        || canonicalJcs(report.checks) !== canonicalJcs(['currentDomainSHACL', 'applicableCustom'])
        || report.outcome !== 'passed' || report.recordType !== 'validationReport'
        || report.subjectArtifactDigest !== manifest.dataset.artifactDigest
        || !refsEqual(report.subjectArtifactRef, manifest.dataset.artifactRef)
        || report.subjectGraphDigest !== manifest.dataset.graphDigest
        || report.subjectGraphIri !== SUPPORT_GRAPH_IRI) {
      fail('S5_PRIOR_SUPPORT_REPORT', `report[${index}] is detached, missing, or not passed`);
    }
  }

  const batchRunArtifact = readJsonBinding(
    resolver, manifest.batchRun, 'priorSupportChain.batchRun', 'runRef',
  );
  const batchRun = batchRunArtifact.value;
  exactKeys(batchRun, [
    'assertionTime', 'batchRef', 'batchSourceDigest', 'batchSourceRef', 'iri',
    'memberRuns', 'outcome', 'outputDatasetArtifactDigest', 'outputDatasetArtifactRef',
    'outputGraphDigest', 'recordType', 'referenceTime', 'schemaVersion',
  ], 'priorSupport.batchRun');
  if (batchRun.iri !== manifest.batchRun.runRef || batchRun.batchRef !== manifest.batch.batchRef
      || batchRun.batchSourceDigest !== manifest.batch.artifactDigest
      || !refsEqual(batchRun.batchSourceRef, manifest.batch.artifactRef)
      || canonicalJcs(batchRun.memberRuns) !== canonicalJcs(manifest.runs)
      || batchRun.outcome !== 'completed'
      || batchRun.outputDatasetArtifactDigest !== manifest.dataset.artifactDigest
      || !refsEqual(batchRun.outputDatasetArtifactRef, manifest.dataset.artifactRef)
      || batchRun.outputGraphDigest !== manifest.dataset.graphDigest) {
    fail('S5_PRIOR_SUPPORT_BATCH_RUN', 'batch run is detached from members/batch/output');
  }
  if (batchRun.assertionTime !== manifest.dataset.snapshotTime
      || Date.parse(batchRun.assertionTime) >= Date.parse(current.assertionTime)
      || Date.parse(batchRun.referenceTime) >= Date.parse(current.referenceTime)
      || [...runByIri.values()].some((entry) => (
        Date.parse(entry.run.assertionTime) > Date.parse(batchRun.assertionTime)
        || Date.parse(entry.run.referenceTime) > Date.parse(batchRun.referenceTime)
      ))) {
    fail('S5_PRIOR_SUPPORT_TIME', 'batch output time does not follow members or precede consumer');
  }

  const ledgerArtifact = readJsonBinding(resolver, manifest.ledger, 'priorSupportChain.ledger', 'ledgerRef');
  const ledger = ledgerArtifact.value;
  exactKeys(ledger, ['entries', 'iri', 'recordType', 'schemaVersion'], 'priorSupport.ledger');
  const expectedLedger = [
    ...manifest.identityContracts, ...manifest.mappings, ...manifest.plans,
    ...manifest.runs, ...manifest.reports, manifest.batch, manifest.batchRun,
    {
      artifactDigest: manifest.dataset.artifactDigest,
      artifactRef: manifest.dataset.artifactRef,
      datasetRef: manifest.dataset.datasetRef,
    },
  ].sort((left, right) => utf8Compare(refKey(left.artifactRef), refKey(right.artifactRef)));
  if (ledger.iri !== manifest.ledger.ledgerRef || ledger.recordType !== 'evidenceLedger'
      || ledger.schemaVersion !== '1.0' || canonicalJcs(ledger.entries) !== canonicalJcs(expectedLedger)) {
    fail('S5_PRIOR_SUPPORT_LEDGER', 'evidence ledger omits, adds, or substitutes a chain artifact');
  }
  return {
    allowedRunIris: [...runByIri.keys()].sort(utf8Compare),
    artifact: manifestArtifact,
    batchArtifact,
    batchRunArtifact,
    datasetArtifact,
    graphDigest,
    ledgerArtifact,
    manifest,
    nquads,
  };
}

module.exports = {
  EXPECTED_TARGETS,
  S5PriorSupportChainError,
  validatePriorSupportChain,
};
