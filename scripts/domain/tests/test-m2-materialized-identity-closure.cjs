#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const YAML = require('yaml');
const {
  buildIdentityIris,
  validateIdentityManifest,
} = require('../lib/identity-contract-compiler.cjs');
const {
  compileMaterializedIdentityClosure,
  discoverCompilationRefs,
  loadMaterializedTargetInventory,
  loadNormalizedModuleIr,
  readExactJcs,
  validateMaterializedTargetClosure,
} = require('../lib/m2-materialized-identity-closure.cjs');
const {
  run: runObservationSourceGenerator,
} = require('../generate-portfolio-observation-identity-source.cjs');
const {
  buildPortfolioObservationIdentitySource,
  compilePortfolioObservationIdentitySource,
} = require('../lib/portfolio-observation-identity-source.cjs');
const {
  run: runInventoryGenerator,
} = require('../generate-materialized-target-inventory.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const PORTFOLIO = 'https://axiolune.ai/ontology/finance/portfolio-positions/';
const META_BINDING_ATTRIBUTES = 'https://axiolune.ai/ontology/meta/data-binding/attributes/';
const OBSERVATION_SOURCE =
  'mappings/finance/v0.3.0/portfolio-positions/identity/portfolio-observation-identity-compilation.json';
const HOLDING_SOURCE = 'mappings/finance/v0.3.0/slice-a-s5/identity-compilation.json';

function productionSources() {
  return discoverCompilationRefs(ROOT).map((ref) => (
    readExactJcs(ROOT, ref, `test production source ${ref.path}`)
  ));
}

function sourceByPath(sources, sourcePath) {
  const source = sources.find((row) => row.ref.path === sourcePath);
  assert.ok(source, `missing source ${sourcePath}`);
  return source;
}

function contractByTarget(source, targetType) {
  const contract = source.value.contracts.find((row) => row.targetType === targetType);
  assert.ok(contract, `missing identity contract for ${targetType}`);
  return contract;
}

function mappingByTarget(source, targetType) {
  const mapping = source.value.mappings.find((row) => row.targetType === targetType);
  assert.ok(mapping, `missing identity mapping for ${targetType}`);
  return mapping;
}

function freshObservationCompilation() {
  return structuredClone(buildPortfolioObservationIdentitySource(ROOT).compilation);
}

function assertObservationCompilationError(compilation, code, pathFragment) {
  assert.throws(
    () => compilePortfolioObservationIdentitySource(compilation, ROOT),
    (error) => (
      error.name === 'IdentityContractError'
      && error.errors.some((entry) => (
        entry.code === code
        && (!pathFragment || entry.path.includes(pathFragment))
      ))
    ),
  );
}

function literal(value, datatype) {
  return `${JSON.stringify(value)}^^<${datatype}>`;
}

function versionTerms(revision = '0') {
  return {
    availableFrom: literal('2025-01-01T00:00:02Z', `${XSD}dateTimeStamp`),
    knowledgeFrom: literal('2025-01-01T00:00:01Z', `${XSD}dateTimeStamp`),
    revision: literal(revision, `${XSD}nonNegativeInteger`),
    validFrom: literal('2025-01-01T00:00:00Z', `${XSD}dateTimeStamp`),
  };
}

test('global materialized identity closure is driven by independent inventory and NormalizedModuleIR', () => {
  const refs = discoverCompilationRefs(ROOT);
  const discoveredPaths = refs.map((ref) => ref.path);
  assert.deepEqual(discoveredPaths, [
    OBSERVATION_SOURCE,
    'mappings/finance/v0.3.0/portfolio-positions/identity/position-lot-identity-compilation.json',
    HOLDING_SOURCE,
    'mappings/finance/v0.3.0/strategy-research/semantic-mapping-set.json',
  ]);
  assert.equal(discoveredPaths.some((value) => value.startsWith('tests/')), false);

  const { inventory } = loadMaterializedTargetInventory(ROOT);
  const normalized = loadNormalizedModuleIr(ROOT);
  const result = compileMaterializedIdentityClosure(ROOT);
  const inventoryTargets = inventory.targets.map((row) => row.targetType);
  assert.equal(result.stats.sourceCount, refs.length);
  assert.equal(result.stats.targetCount, 18);
  assert.equal(result.stats.mappingCount, 18);
  assert.equal(result.stats.contractCount, 18);
  assert.deepEqual(result.compilation.concreteTargetTypes, inventoryTargets);
  assert.deepEqual(result.compilation.mappings.map((row) => row.targetType).sort(), inventoryTargets);
  for (const targetType of [
    `${PORTFOLIO}PortfolioObservationStream`,
    `${PORTFOLIO}PositionSnapshot`,
    `${PORTFOLIO}ExternalCostBasisObservation`,
    `${PORTFOLIO}PortfolioPositionReconciliationFinding`,
  ]) {
    assert.ok(normalized.typeByIri.has(targetType), `${targetType} is absent from NormalizedModuleIR`);
    assert.ok(result.compilation.concreteTargetTypes.includes(targetType));
  }
  assert.ok(!result.compilation.concreteTargetTypes.includes(
    'https://axiolune.ai/ontology/finance/foundation/Party',
  ));
});

test('all observation-scoped identity roles have one mandatory LogicalReference binding', () => {
  const module = YAML.parse(fs.readFileSync(
    path.join(ROOT, 'ontology', 'domain', 'finance', 'portfolio-positions', 'module.yaml'),
    'utf8',
  ));
  const logicalReference = 'https://axiolune.ai/ontology/meta/core/constraints/LogicalReference';
  for (const targetElement of [
    `${PORTFOLIO}HoldingSnapshot/role/holdingObservationStream`,
    `${PORTFOLIO}PositionSnapshot/role/positionObservationStream`,
    `${PORTFOLIO}ExternalCostBasisObservation/role/externalBasisObservationStream`,
  ]) {
    const matches = module.domain.constraintBindings.filter((row) => (
      row.constraintRef === logicalReference
        && row.targetElement === targetElement
        && row.enforcementLevel === 'Mandatory'
    ));
    assert.equal(matches.length, 1, `${targetElement} must have one mandatory logical binding`);
  }
});

test('canonical identity source and independent inventory are byte-deterministic', () => {
  assert.deepEqual(runObservationSourceGenerator(['--check']), {
    contractCount: 4,
    mappingCount: 4,
    mode: 'check',
    targetCount: 4,
  });
  assert.deepEqual(runInventoryGenerator(['--check']), { mode: 'check', targetCount: 18 });
});

test('all four Portfolio observation mappings compile as current-M3 closed instances', () => {
  const compilation = freshObservationCompilation();
  const compiled = compilePortfolioObservationIdentitySource(compilation, ROOT);
  assert.equal(compilation.mappings.length, 4);
  assert.equal(compiled.manifest.contracts.length, 4);

  for (const mapping of compilation.mappings) {
    assert.deepEqual(Object.keys(mapping.provenance), ['sourceSystem']);
    assert.equal(mapping.provenance.sourceSystem.bindingType, 'directField');
    assert.equal(mapping.provenance.sourceSystem.source.field, 'source');
    assert.equal(mapping.temporal.knowledgeTime.closePolicy, 'explicitOnly');
    assert.equal(Object.hasOwn(mapping.temporal.validTime, 'closePolicy'), false);
    assert.equal(Object.hasOwn(mapping.temporal.availabilityTime, 'closePolicy'), false);
  }

  const source = { value: compilation };
  const stream = mappingByTarget(source, PORTFOLIO + 'PortfolioObservationStream');
  const position = mappingByTarget(source, PORTFOLIO + 'PositionSnapshot');
  const externalBasis = mappingByTarget(source, PORTFOLIO + 'ExternalCostBasisObservation');
  const finding = mappingByTarget(
    source,
    PORTFOLIO + 'PortfolioPositionReconciliationFinding',
  );
  const attributeSlot = (mapping, attribute) => mapping.slotMappings.find((slot) => (
    slot.target.slotType === 'attribute'
    && slot.target.targetAttribute === attribute
  ));
  const hasAttribute = (mapping, attribute) => attributeSlot(mapping, attribute) !== undefined;
  for (const mapping of [stream, position, externalBasis]) {
    for (const field of ['sourceArtifactRef', 'sourceArtifactDigest', 'sourceLocator']) {
      assert.deepEqual(
        attributeSlot(mapping, META_BINDING_ATTRIBUTES + field).value,
        {
          bindingType: 'directField',
          source: { dataset: 'row', field },
        },
      );
    }
  }
  for (const field of ['positionQuantity', 'positionSourceKind']) {
    assert.deepEqual(
      attributeSlot(position, PORTFOLIO + field).value,
      {
        bindingType: 'directField',
        source: { dataset: 'row', field },
      },
    );
  }
  assert.equal(
    hasAttribute(stream, META_BINDING_ATTRIBUTES + 'generatingContextRef'),
    false,
    'PortfolioObservationStream does not declare generatingContextRef in the current module',
  );
  for (const mapping of [position, externalBasis, finding]) {
    const slots = mapping.slotMappings.filter((slot) => (
      slot.target.slotType === 'attribute'
      && slot.target.targetAttribute === META_BINDING_ATTRIBUTES + 'generatingContextRef'
    ));
    assert.equal(slots.length, 1);
    assert.deepEqual(
      slots[0].value,
      { bindingType: 'runtimeContext', contextField: 'iri' },
    );
  }
});

test('Portfolio observation identity compilation rejects non-M3 provenance fields', () => {
  const compilation = freshObservationCompilation();
  const position = mappingByTarget(
    { value: compilation },
    PORTFOLIO + 'PositionSnapshot',
  );
  position.provenance.sourceArtifactRef = {
    bindingType: 'directField',
    source: { dataset: 'row', field: 'sourceArtifactRef' },
  };
  assertObservationCompilationError(
    compilation,
    'M3_UNKNOWN_FIELD',
    '.provenance.sourceArtifactRef',
  );
});

test('Portfolio observation identity compilation rejects a non-M3 close policy', () => {
  const compilation = freshObservationCompilation();
  const position = mappingByTarget(
    { value: compilation },
    PORTFOLIO + 'PositionSnapshot',
  );
  position.temporal.knowledgeTime.closePolicy = 'externalClosureAssertion';
  assertObservationCompilationError(
    compilation,
    'M3_INVALID_ENUM',
    '.temporal.knowledgeTime.closePolicy',
  );
});

test('Portfolio observation identity compilation rejects an omitted required module slot', () => {
  const compilation = freshObservationCompilation();
  const position = mappingByTarget(
    { value: compilation },
    PORTFOLIO + 'PositionSnapshot',
  );
  position.slotMappings = position.slotMappings.filter((slot) => (
    slot.target.targetAttribute !== PORTFOLIO + 'positionQuantity'
  ));
  assertObservationCompilationError(
    compilation,
    'M3_REQUIRED_SLOT_MISSING',
    '.slotMappings',
  );
});

test('Portfolio observation identity compilation requires runtimeContext.iri for provenance', () => {
  const compilation = freshObservationCompilation();
  const position = mappingByTarget(
    { value: compilation },
    PORTFOLIO + 'PositionSnapshot',
  );
  const generatingContext = position.slotMappings.find((slot) => (
    slot.target.targetAttribute === META_BINDING_ATTRIBUTES + 'generatingContextRef'
  ));
  generatingContext.value.contextField = 'assertionTime';
  assertObservationCompilationError(
    compilation,
    'M3_GENERATING_CONTEXT_BINDING',
    '.slotMappings',
  );
});

test('closure rejects an independently inventoried target omitted from mappings', () => {
  const sources = structuredClone(productionSources());
  const { inventory } = loadMaterializedTargetInventory(ROOT);
  const targetType = `${PORTFOLIO}HoldingSnapshot`;
  const source = sourceByPath(sources, HOLDING_SOURCE);
  source.value.mappings = source.value.mappings.filter((row) => row.targetType !== targetType);
  assert.throws(
    () => validateMaterializedTargetClosure(loadNormalizedModuleIr(ROOT), inventory, sources),
    (error) => error.code === 'IDENTITY_TARGET_OMITTED' && error.message.includes(targetType),
  );
});

test('closure rejects mapping targets outside the independent inventory', () => {
  const sources = productionSources();
  const { inventory } = loadMaterializedTargetInventory(ROOT);
  const mutated = structuredClone(inventory);
  const removed = mutated.targets.shift();
  assert.throws(
    () => validateMaterializedTargetClosure(loadNormalizedModuleIr(ROOT), mutated, sources),
    (error) => error.code === 'IDENTITY_TARGET_EXTRA' && error.message.includes(removed.targetType),
  );
});

test('closure rejects fixture-backed compilation authority before source lookup', () => {
  const sources = productionSources();
  const { inventory } = loadMaterializedTargetInventory(ROOT);
  const mutated = structuredClone(inventory);
  mutated.targets[0].sourceCompilationRef = {
    kind: 'path',
    path: 'tests/m2/fixtures/identity/identity-compilation-input.json',
    root: 'sourceTree',
  };
  assert.throws(
    () => validateMaterializedTargetClosure(loadNormalizedModuleIr(ROOT), mutated, sources),
    (error) => error.code === 'IDENTITY_FIXTURE_SOURCE',
  );
});

test('closure rejects a mapping-to-contract join mismatch', () => {
  const sources = structuredClone(productionSources());
  const { inventory } = loadMaterializedTargetInventory(ROOT);
  const targetType = `${PORTFOLIO}PositionSnapshot`;
  const mapping = mappingByTarget(sourceByPath(sources, OBSERVATION_SOURCE), targetType);
  mapping.identity.contractRef = 'https://axiolune.ai/identity-contract/unreviewed';
  assert.throws(
    () => validateMaterializedTargetClosure(loadNormalizedModuleIr(ROOT), inventory, sources),
    (error) => error.code === 'IDENTITY_MAPPING_CONTRACT_MISMATCH'
      && error.message.includes(targetType),
  );
});

test('Portfolio observation identities scope source IDs by typed stream and keep listing out of logical keys', () => {
  const sources = productionSources();
  const observation = sourceByPath(sources, OBSERVATION_SOURCE);
  const holding = sourceByPath(sources, HOLDING_SOURCE);
  const holdingContract = contractByTarget(holding, `${PORTFOLIO}HoldingSnapshot`);
  const holdingMapping = mappingByTarget(holding, `${PORTFOLIO}HoldingSnapshot`);
  const positionContract = contractByTarget(observation, `${PORTFOLIO}PositionSnapshot`);
  const externalContract = contractByTarget(observation, `${PORTFOLIO}ExternalCostBasisObservation`);
  const findingContract = contractByTarget(
    observation,
    `${PORTFOLIO}PortfolioPositionReconciliationFinding`,
  );

  assert.deepEqual(
    holdingContract.logicalComponents.map((row) => row.name),
    ['observationStreamLogicalIri', 'snapshotId'],
  );
  assert.deepEqual(
    positionContract.logicalComponents.map((row) => row.name),
    ['observationStreamLogicalIri', 'snapshotId'],
  );
  assert.deepEqual(
    externalContract.logicalComponents.map((row) => row.name),
    ['observationStreamLogicalIri', 'externalBasisId'],
  );
  assert.deepEqual(
    findingContract.logicalComponents.map((row) => row.name),
    ['reconciliationDefinitionRef', 'pitRequestRef', 'reconciliationSubjectDigest'],
  );
  assert.equal(Object.hasOwn(holdingMapping.identity.logicalKeyBindings, 'listingVersionIri'), false);
  assert.ok(holdingMapping.slotMappings.some((row) => row.target.targetRole === 'holdingListing'));

  const snapshotId = literal('snapshot-42', `${XSD}string`);
  const firstTerms = {
    observationStreamLogicalIri: '<urn:axiolune:portfolio-observation-stream:provider-a>',
    snapshotId,
  };
  const secondTerms = {
    observationStreamLogicalIri: '<urn:axiolune:portfolio-observation-stream:provider-b>',
    snapshotId,
  };
  const first = buildIdentityIris(holdingContract, firstTerms, versionTerms('0'));
  const second = buildIdentityIris(holdingContract, secondTerms, versionTerms('0'));
  assert.notEqual(first.logicalIri, second.logicalIri, 'same source ID from two streams collided');

  const listingRevision = buildIdentityIris(holdingContract, firstTerms, versionTerms('1'));
  assert.equal(first.logicalIri, listingRevision.logicalIri);
  assert.notEqual(first.versionIri, listingRevision.versionIri);
});

test('global registry is the exact used identity-term closure and manifest replay rejects tampering', () => {
  const result = compileMaterializedIdentityClosure(ROOT);
  const usedTermRefs = new Set();
  for (const contract of result.compilation.contracts) {
    for (const component of [...contract.logicalComponents, ...contract.versionComponents]) {
      usedTermRefs.add(component.termContractRef);
      const rule = result.compilation.normalizationRules.find(
        (candidate) => candidate.iri === component.normalizationRuleRef,
      );
      assert.ok(rule, `missing normalization rule ${component.normalizationRuleRef}`);
      usedTermRefs.add(rule.inputTermContractRef);
      usedTermRefs.add(rule.outputTermContractRef);
    }
  }
  assert.deepEqual(
    result.registry.termContracts.map((row) => row.termContractRef),
    [...usedTermRefs].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
  );

  const tampered = structuredClone(result.manifest);
  tampered.contracts[0].mappings[0].mappingDigest = `sha256:${'f'.repeat(64)}`;
  const validation = validateIdentityManifest(tampered, result.compilation);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((entry) => entry.code === 'IDENTITY_MANIFEST_MISMATCH'));
});

test('identity closure input resolution rejects a symbolic-link source path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axiolune-identity-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'real.json'), '{}');
  let linkedPath = 'linked.json';
  try {
    fs.symlinkSync(path.join(root, 'real.json'), path.join(root, 'linked.json'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      const targetDirectory = path.join(root, 'target-directory');
      fs.mkdirSync(targetDirectory);
      fs.writeFileSync(path.join(targetDirectory, 'real.json'), '{}');
      try {
        fs.symlinkSync(targetDirectory, path.join(root, 'linked-directory'), 'junction');
        linkedPath = 'linked-directory/real.json';
      } catch (junctionError) {
        if (['EPERM', 'EACCES', 'ENOSYS'].includes(junctionError.code)) {
          t.skip(`symbolic links unavailable: ${junctionError.code}`);
          return;
        }
        throw junctionError;
      }
    } else {
      throw error;
    }
  }
  assert.throws(
    () => readExactJcs(
      root,
      { kind: 'path', root: 'sourceTree', path: linkedPath },
      'linked identity source',
    ),
    /rejects symbolic-link path component/u,
  );
});
